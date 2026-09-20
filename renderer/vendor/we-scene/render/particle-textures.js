// [we-scene patch] WE 内置粒子贴图的素材供给：**全程序化生成 + 宿主覆盖接口**。
// 为什么需要这个文件：粒子材质引用的贴图（particle/halo、particle/drop、
// particle/fog/fog1 …）**不在 scene.pkg 里** —— 它们是 Wallpaper Engine 安装目录
// 自带的公共资源，作者的 pkg 只存自己上传的工坊贴图。全库实测 33 张被引用的粒子贴图
// 里 24 张属于内置资源，缺一张整个粒子系统就没东西可画。
// 供给策略（2026-09-02 起，取代旧的「CC0 素材表 + 程序化兜底」两级结构）：
//   0. **宿主覆盖**（本文件底部三个函数）：按名字注册工厂 / 兜底接管全部名字。
//      宿主手头有 WE 安装目录的原版贴图时从这里注入，观感可完全对齐官方；
//   1. **显式登记表**（BUILDERS）：已知「默认形态不对」的名字的定向覆盖
//      （halo_6 被 xray 当开窗形状、法线按反照率高度图生成等），以及全部
//      原 CC0 素材键 + 本机库实测缺表的内置名（火/雪/月牙/符文/闪电变体等）；
//   2. **关键词兜底**（fallbackFor）：工坊自定义名按语义映射到生成器。
// 画质规约（2026-09-02 二版 + 2026-09-02 三版）：
//   - **生成尺寸 = 原生尺寸 × 2**（原生尺寸从 git 历史的素材表取回，64/128/256 三档），
//     上限 512。粒子在画面里被放大数倍，低分辨率 + GPU 双线性就是「糊」的第一来源；
//   - **衰减剖面一律多重高斯**（C∞，无导数不连续）——多项式幂衰减 (1-d)^n 在低分辨率
//     下会出色带（同一灰度连成可见的环），高斯不会；
//   - 雾/烟/火 = **梯度噪声 fBm + 廉价 domain warp**（warp 只用 2 个倍频程）；雾/烟
//     在 256 生成再双线性升到 512（絮状无硬边，升采样几乎无损，避开 512²×3×5 的首帧卡顿）；
//   - **零 canvas**：气泡/花瓣/叶片也是纯算术，Node 离线校验与浏览器逐像素一致；
//   - 历史备注：旧结构里高频名取自 Kenney Particle Pack（CC0）的内嵌像素，为满足
//     「零内嵌第三方素材」的合规边界已整体移除（docs/COMPLIANCE.md）。
// 实现约定：
//   - 所有生成函数返回 { width, height, rgba: Uint8Array }，直接喂 texImage2D；
//   - 素材一律「预乘前」的直通 RGBA，alpha 携带形状，rgb 为白（颜色由顶点色调制）；
//   - **本文件零 import**：生成器纯算术，Node 离线校验与浏览器渲染同一条路径、
//     逐像素一致（verify-particles 的贴图区块靠这个）；
//   - 生成器必须确定性（固定种子，禁 Math.random）：同名字同像素，A/B 对比才可信。

const cache = new Map()

// 覆盖注册表是本文件**唯一的模块级可变状态**（引擎其余模块同样接近零可变状态，
// 见 docs/ARCHITECTURE.md 不变量 4），这是刻意设计：内置贴图是「引擎级默认值」，
// 覆盖属进程级配置而非每实例状态——多渲染器实例共享同一份覆盖，实例差异请直接
// 用 ParticleSystem.setTexture 注入。

const overrides = new Map() // name → factory
let overrideProvider = null // (name) => tex | null，兜底接管全部名字

/** 按名字覆盖内置贴图。factory() 返回 {width,height,rgba}；同时清该名缓存。 */
export function setParticleTextureFactory(name, factory) {
  const key = String(name)
  overrides.set(key, factory)
  cache.delete(key)
}

/** 兜底接管：BUILDERS 与关键词兜底之前先问 provider，返回 null 则继续走内置链。 */
export function setParticleTextureProvider(provider) {
  overrideProvider = typeof provider === 'function' ? provider : null
}

/** 复位全部覆盖（含缓存）。verifier 的往返断言与宿主卸载时使用。 */
export function resetParticleTextureFactories() {
  overrides.clear()
  overrideProvider = null
  cache.clear()
}

/** 登记表全部键名（目检页 / 校验枚举用；不含关键词兜底的未知名）。 */
export function listBuiltinParticleTextureNames() {
  return Object.keys(BUILDERS)
}

// 直通白 RGB，alpha 为 0..1。所有生成器的像素写出都走这里。
function writeWhite(rgba, o, a) {
  rgba[o] = 255
  rgba[o + 1] = 255
  rgba[o + 2] = 255
  rgba[o + 3] = Math.round(Math.min(1, Math.max(0, a)) * 255)
}

// 边缘羽化到 0（精灵 quad 不得露出硬直边）+ 可选能量归一（additive 叠加易过曝）。
function conditionTexture(tex, targetAvg) {
  const { width: W, height: H, rgba } = tex
  const feather = Math.max(2, Math.round(Math.min(W, H) * 0.04))
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dEdge = Math.min(x, y, W - 1 - x, H - 1 - y)
      if (dEdge >= feather) continue
      const k = dEdge / feather
      const o = (y * W + x) * 4 + 3
      rgba[o] = Math.round(rgba[o] * k)
    }
  }
  if (targetAvg > 0) {
    let sum = 0
    const N = W * H
    for (let i = 0; i < N; i++) sum += rgba[i * 4 + 3]
    const avg = sum / N / 255
    if (avg > targetAvg && avg > 0) {
      const k = targetAvg / avg
      for (let i = 0; i < N; i++) rgba[i * 4 + 3] = Math.round(rgba[i * 4 + 3] * k)
    }
  }
  return tex
}

// 固定种子 PRNG（与 noise.js / audio.js 的 mulberry32 同款；三份重复是既有的
// 零依赖约定的代价）。只用于确定性散点，禁 Math.random。
function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}


const smooth01 = (t) => t * t * (3 - 2 * t)
const smooth5 = (t) => t * t * t * (t * (t * 6 - 15) + 10) // 五次插值（C²）
const lerp = (a, b, t) => a + (b - a) * t
// 高斯：s 为形状宽度，统一写 exp(-(d/s)²) 便于调参直觉
const gauss = (d, s) => Math.exp(-(d * d) / (s * s))

function edgeFade(x, y, size, feather) {
  const dEdge = Math.min(x, y, size - 1 - x, size - 1 - y)
  return dEdge >= feather ? 1 : dEdge / feather
}

/**
 * 多重高斯光晕（halo 家族 / 通用圆点的主力剖面）。
 * 叶结构：亮芯（窄高斯）+ 可选中圈 + 宽晕，都是 C∞ —— 没有幂衰减的色带。
 * lobes：[{ r, w }, ...] 宽度与权重。
 */
function glowN(size, lobes) {
  const rgba = new Uint8Array(size * size * 4)
  const half = size / 2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot((x + 0.5 - half) / half, (y + 0.5 - half) / half)
      let a = 0
      for (let i = 0; i < lobes.length; i++) a += lobes[i].w * gauss(d, lobes[i].r)
      writeWhite(rgba, (y * size + x) * 4, a)
    }
  }
  return { width: size, height: size, rgba }
}

function glow2(size, core, halo) {
  return glowN(size, [core, halo])
}

/**
 * 按**实测径向剖面**重建一张纯白径向贴图（alpha = 剖面值，RGB 恒 255）。
 * `samples` = r = 0, 0.1, … 处的 alpha（0~1）；样本之间线性插值，r>1 取 0。
 * 这是本仓复刻内置贴图的标准做法：**先量原版 `.tex`，再按数还原**（见 SKILL）。
 */
function radialProfile(size, samples) {
  const rgba = new Uint8Array(size * size * 4)
  const half = size / 2
  const n = samples.length - 1
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - half, y + 0.5 - half) / half
      let a = 0
      if (d < 1) {
        const t = d * n
        const i = Math.min(n - 1, Math.floor(t))
        a = samples[i] + (samples[i + 1] - samples[i]) * (t - i)
      }
      writeWhite(rgba, (y * size + x) * 4, a)
    }
  }
  return { width: size, height: size, rgba }
}

/**
 * xray 的**开窗形状**（原版素材 `particle/halo_6`）。
 *
 * 原版实测（128²、format 0、RGB 恒 255、形状全在 alpha；径向 r = d/(size/2)）：
 *   a(r) = 255 255 255 255 255 255 248 193 83 18 1  @ r = 0.0…1.0（步长 0.1）
 * 即**一片实心盘**（r ≤ 0.6 满亮）+ 一圈平滑软边（0.6→1.0 收到 0），
 * 拟合为 `255 · (1 - smoothstep(0.6, 1.0, r))^1.6`（0.7→193✓ 0.8→82✓ 0.9→12≈18）。
 *
 * 旧实现是 `glow2`（高斯核 + 光晕）：a = 255/181/68/28/16/9/5/2/1… —— 中心一个小亮点。
 * xray 的 frag 是 `blend *= sample.r * sample.a`，于是程序化素材下**整个开窗变成中心小亮斑**，
 * 而原版素材是一整片均匀透亮的圆窗 —— 14 个 xray 壁纸（1368497013 / 1586038665 / …）
 * 在两种素材下完全两个样子。
 */
function haloWindow(size) {
  const rgba = new Uint8Array(size * size * 4)
  const half = size / 2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - half, y + 0.5 - half) / half
      const t = Math.min(1, Math.max(0, (d - 0.6) / 0.4))
      const sm = t * t * (3 - 2 * t)
      writeWhite(rgba, (y * size + x) * 4, Math.pow(1 - sm, 1.6))
    }
  }
  return { width: size, height: size, rgba }
}

/**
 * 解析尖星（@sparkle / @star / flare / 星类兜底）。
 * 尖峰 = 角向高斯（cos(points·θ) 的幂把 θ 空间切成 points 个瓣）× 径向高斯，
 * 全程 C∞，彻底取代旧多边形顶点法的锯齿。coreR 为中心亮斑宽度，len 为瓣长。
 */
function spikyStar(size, points, len, sharp, coreR) {
  const rgba = new Uint8Array(size * size * 4)
  const half = size / 2
  const feather = Math.max(2, Math.round(size * 0.03))
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = (x + 0.5 - half) / half
      const py = (y + 0.5 - half) / half
      const d = Math.hypot(px, py)
      const th = Math.atan2(py, px)
      const m = Math.pow(0.5 + 0.5 * Math.cos(points * th), sharp)
      let a = gauss(d, coreR) + m * gauss(d, len)
      a *= edgeFade(x, y, size, feather)
      writeWhite(rgba, (y * size + x) * 4, a)
    }
  }
  return { width: size, height: size, rgba }
}

// 光束/光轴/雨丝：纵向长条。横向高斯³收窄，纵向高斯包络（比正弦更平滑、
// 两端自然归零）；peak 控制整体亮度（光轴叠加层数多要压低，雨丝可亮一档）。
function beam(w, h, coreWidth, fadeBoth, peak) {
  const pk = peak === undefined ? 0.55 : peak
  const rgba = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    const ty = y / (h - 1)
    const vy = fadeBoth
      ? gauss(ty - 0.5, 0.27)
      : smooth01(Math.min(1, ty / 0.06)) * Math.pow(1 - ty, 1.35)
    for (let x = 0; x < w; x++) {
      const tx = (x / (w - 1)) * 2 - 1
      const g = gauss(tx, coreWidth)
      writeWhite(rgba, (y * w + x) * 4, g * g * g * vy * pk)
    }
  }
  return { width: w, height: h, rgba }
}

/**
 * 原版 `particle/bubbles/bubble3` —— **照本机原版素材实测重建**。
 *
 * 原版：1024×1024 图集、**TEXS 64 帧**（每帧 128×128，8×8）、format 0、
 * **alpha 恒 255（形状在 RGB）**。帧 0 实测：非黑(>24) 仅 **2.9%**、亮(>100) 0.4%、
 * 均值 2.4/255、峰值 253、**连通域 45 个**（最大 85px，宽度中位 **2px**）——
 * 即「黑底 + 一大片**细小的青色气泡/亮点**」，配合材质的 `blending: additive`
 * （黑色=不贡献）在画面上就是一层细密的小气泡。
 *
 * 旧实现是 `bubbleSheet(256, 3)`：2×2 四帧、**白色实心肥皂泡**，还带 alpha 形状 ——
 * 与「64 帧黑底小气泡群」完全两回事（1837470104「Ocean bubbles」两种素材下不一样）。
 */
function bubbleClusterSheet(size, frames, perFrame, seed) {
  const cell = Math.round(size / Math.sqrt(frames))
  const cols = Math.round(size / cell)
  const rgba = new Uint8Array(size * size * 4)
  // alpha 恒 255（原版如此：形状在 RGB，配合 additive —— 黑色不贡献、亮点才可见）
  for (let i = 0; i < size * size; i++) rgba[i * 4 + 3] = 255
  const rng = mulberry32(seed >>> 0)
  // 每个小气泡一个生命周期：跨帧淡入-涨大-淡出，形成"咕嘟"循环
  const specks = []
  for (let i = 0; i < perFrame; i++) {
    const ang = rng() * Math.PI * 2
    const rad = Math.pow(rng(), 1.15) * 0.38 * cell
    specks.push({
      x: cell / 2 + Math.cos(ang) * rad,
      y: cell / 2 + Math.sin(ang) * rad,
      r: 0.5 + rng() * 1.35,
      phase: rng(),
      drift: (rng() - 0.5) * 0.06,
      tint: [0.55 + rng() * 0.45, 0.75 + rng() * 0.25, 0.85 + rng() * 0.15],
      // 亮度重尾：多数暗、少数很亮（原版峰值 253 而均值只有 2.4）
      bright: rng() < 0.18 ? 0.75 + rng() * 0.6 : 0.22 + rng() * 0.35,
    })
  }
  for (let f = 0; f < frames; f++) {
    const ox = (f % cols) * cell
    const oy = ((f / cols) | 0) * cell
    const t = f / frames
    for (const sp of specks) {
      // 生命周期：每个气泡在自己的相位附近出现一次
      const life = (t - sp.phase + 1) % 1
      const grow = Math.min(1, life * 6)
      const fade = life > 0.75 ? Math.max(0, 1 - (life - 0.75) / 0.25) : 1
      const a = grow * fade * sp.bright
      if (a <= 0.02) continue
      const r = sp.r * (0.6 + 0.8 * Math.min(1, life * 3))
      const cx = sp.x + sp.drift * cell * life * 3
      const cy = sp.y - life * cell * 0.12
      // 画一圈细环（气泡轮廓）+ 极淡的内芯
      for (let y = Math.floor(cy - r - 1); y <= Math.ceil(cy + r + 1); y++) {
        for (let x = Math.floor(cx - r - 1); x <= Math.ceil(cx + r + 1); x++) {
          if (x < 0 || y < 0 || x >= cell || y >= cell) continue
          const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy)
          const ring = Math.exp(-Math.pow((d - r) / 0.7, 2))
          const core = Math.exp(-Math.pow(d / (r * 0.9), 2)) * 0.22
          const v = Math.min(1, (ring + core) * a)
          if (v <= 0.01) continue
          const o = ((oy + y) * size + ox + x) * 4
          // additive 混合：RGB 即亮度，alpha 恒 255（与原版一致）
          const add = (c) => Math.min(255, rgba[o + c] + Math.round(v * sp.tint[c] * 255 * 0.42))
          rgba[o] = add(0)
          rgba[o + 1] = add(1)
          rgba[o + 2] = add(2)
          rgba[o + 3] = 255
        }
      }
    }
  }
  return { width: size, height: size, rgba }
}

/**
 * 原版 `particle/light/light_shafts_*` —— **照本机原版素材逐个实测重建**。
 *
 * 7 张贴图都是 RG88、**R == G == 强度（实测 R==G 100%）**、没有 TEXS 帧。
 * additive 下 shader 的有效贡献 = `rgb × alpha = (R/255)·(G/255)·255 = R·G/255`（**平方衰减**），
 * 所以程序化替身必须把**强度和 alpha 都写成强度**；只写「白 RGB + alpha 形状」会把光条
 * 画得又细又亮。实测剖面（横截面 = 对 y 取均值后按峰值归一；纵截面 = 对 x 取最大后归一）：

| 文件 | 尺寸 | 峰值 | 横截面（左→右） | 纵截面（上→下） |
| --- | --- | --- | --- | --- |
| _0 | 256×512 | 220 | 0 .01 .09 .53 1 .95 .22 0 0 | 0 1 .90 .67 .43 .25 .14 .07 0 |
| _1 | 256×512 | 183 | 0 .01 .21 .44 .51 1 .20 .02 0 | 0 .22 .96 .97 1 .97 .60 .26 0 |
| _2 | 256×256 | 255 | 0 0 .05 .50 1 .17 .03 0 0 | 0 .24 .84 1 1 .97 .91 .22 0 |
| _3 | 128×512 | 242 | 0 .01 .07 .16 1 .08 .04 0 0 | .30 1 .95 .93 .88 .68 .36 .14 0 |
| _4 | 256×256 | 177 | 0 .12 .20 .32 .69 1 .32 .09 0 | .03 .93 1 .94 .82 .49 .25 .11 0 |
| _5 | 256×256 | 202 | 0 0 .09 .71 1 .89 .22 0 0 | 0 0 .28 .96 .08 .97 1 .42 0 |
| _6 | 128×512 | 194 | 0 0 .37 .72 .46 1 .79 .11 0 | 0 .76 1 .57 .25 .13 .06 0 0 |

旧实现 `beam(128,512, 0.2…)`：横截面 `gauss(tx,0.2)³` 极窄、纵截面**中段最亮**（原版是
顶部最亮、向下单调衰减）、白 RGB × alpha 峰值 0.55（原版有效峰值只有 R·G/255），
尺寸也一律 128×512（_0/_1 其实是 256×512、_2/_4/_5 是 256×256，宽高比跟着错）。
用户报 2282120494「光照条太亮和粗了」就是这个。
 */
const SHAFT_PROFILES = {
  0: { w: 256, h: 512, p: 0.9, k: 0.996, grid: [
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0.008, 0.122, 0.376, 0.247, 0.031, 0, 0],
    [0, 0, 0.063, 0.314, 0.804, 0.698, 0.188, 0, 0],
    [0, 0.004, 0.129, 0.408, 0.741, 0.737, 0.22, 0, 0],
    [0, 0.008, 0.082, 0.278, 0.647, 0.639, 0.18, 0, 0],
    [0, 0.012, 0.075, 0.278, 0.541, 0.541, 0.125, 0, 0],
    [0, 0, 0.027, 0.275, 0.451, 0.451, 0.098, 0, 0],
    [0, 0, 0.027, 0.239, 0.361, 0.357, 0.067, 0, 0],
    [0, 0, 0.031, 0.176, 0.278, 0.275, 0.031, 0, 0],
    [0, 0, 0, 0.137, 0.212, 0.188, 0.027, 0, 0],
    [0, 0, 0, 0.106, 0.153, 0.145, 0, 0, 0],
    [0, 0, 0, 0.078, 0.106, 0.118, 0.027, 0, 0],
    [0, 0, 0, 0.067, 0.078, 0.086, 0, 0, 0],
    [0, 0, 0, 0.055, 0.059, 0.071, 0.031, 0, 0],
    [0, 0, 0, 0.027, 0.031, 0.055, 0, 0, 0],
    [0, 0, 0, 0.027, 0.027, 0.027, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
  ] },
  1: { w: 256, h: 512, p: 0.75, k: 1.137, grid: [
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0.012, 0.027, 0, 0.02, 0.02, 0, 0],
    [0, 0, 0, 0.09, 0, 0.192, 0.035, 0, 0],
    [0, 0, 0, 0.024, 0.098, 0.075, 0.047, 0, 0],
    [0, 0, 0, 0.157, 0.208, 0.42, 0.031, 0, 0],
    [0, 0, 0, 0.059, 0.106, 0.157, 0, 0, 0],
    [0, 0, 0, 0, 0.031, 0, 0, 0, 0],
    [0, 0, 0, 0, 0.016, 0.031, 0, 0, 0],
    [0, 0, 0, 0, 0.012, 0.039, 0, 0, 0],
    [0, 0, 0, 0, 0.012, 0.031, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0.075, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
  ] },
  2: { w: 256, h: 256, p: 3.15, k: 2.941, grid: [
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0.071, 0, 0, 0, 0, 0, 0],
    [0, 0, 0.11, 0, 0, 0, 0, 0, 0],
    [0, 0, 0.192, 0.02, 0, 0.067, 0.008, 0, 0],
    [0, 0, 0, 0.098, 0.11, 0, 0, 0, 0],
    [0, 0, 0, 0.286, 0.427, 0.161, 0.012, 0, 0],
    [0, 0, 0, 0.902, 1, 0.137, 0, 0, 0],
    [0, 0, 0, 0.678, 0.965, 0, 0, 0, 0],
    [0, 0, 0, 0, 0.973, 0, 0, 0, 0],
    [0, 0, 0, 0.212, 0.969, 0, 0, 0, 0],
    [0, 0, 0, 0.071, 0.894, 0.02, 0, 0, 0],
    [0, 0, 0, 0.396, 0.757, 0.408, 0, 0, 0],
    [0, 0, 0, 0.012, 0.514, 0, 0.071, 0, 0],
    [0, 0, 0.09, 0.102, 0.275, 0, 0.02, 0, 0],
    [0, 0, 0, 0, 0.106, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
  ] },
  3: { w: 128, h: 512, p: 3.0, k: 5.021, grid: [
    [0, 0, 0, 0, 0.141, 0, 0, 0, 0],
    [0, 0, 0.035, 0.424, 0.455, 0.337, 0, 0, 0],
    [0, 0, 0.098, 0.231, 0.125, 0, 0.039, 0, 0],
    [0, 0, 0.031, 0.247, 0.592, 0.09, 0.196, 0, 0],
    [0, 0, 0.071, 0, 0.678, 0, 0.012, 0, 0],
    [0, 0, 0.122, 0, 0.69, 0, 0, 0.004, 0],
    [0, 0.004, 0, 0, 0.659, 0.039, 0, 0, 0],
    [0, 0, 0, 0.047, 0.58, 0.008, 0, 0, 0],
    [0, 0, 0, 0, 0.467, 0, 0, 0, 0],
    [0, 0, 0, 0.016, 0.408, 0, 0, 0, 0],
    [0, 0, 0, 0.031, 0.392, 0, 0, 0, 0],
    [0, 0, 0, 0.027, 0.349, 0, 0, 0, 0],
    [0, 0, 0, 0.024, 0.255, 0, 0, 0, 0],
    [0, 0, 0, 0.02, 0.184, 0, 0, 0, 0],
    [0, 0, 0, 0, 0.125, 0, 0, 0, 0],
    [0, 0, 0, 0, 0.078, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
  ] },
  4: { w: 256, h: 256, p: 0.8, k: 0.875, grid: [
    [0, 0, 0, 0, 0.024, 0, 0, 0, 0],
    [0, 0, 0.004, 0.114, 0.145, 0.09, 0.039, 0, 0],
    [0, 0.004, 0.286, 0, 0.008, 0, 0, 0.063, 0],
    [0, 0.149, 0, 0, 0.188, 0.169, 0.086, 0.086, 0],
    [0, 0.247, 0.216, 0, 0.514, 0.467, 0.22, 0, 0],
    [0, 0, 0.122, 0.122, 0.604, 0.467, 0.086, 0.106, 0],
    [0, 0, 0, 0.118, 0.494, 0.525, 0.306, 0.043, 0],
    [0, 0.012, 0, 0.263, 0.329, 0.416, 0.157, 0, 0],
    [0, 0, 0, 0.153, 0.192, 0.573, 0.102, 0.024, 0],
    [0, 0, 0, 0.204, 0.122, 0.278, 0.082, 0.012, 0],
    [0, 0, 0.086, 0.169, 0.078, 0.259, 0.059, 0, 0],
    [0, 0, 0.039, 0.075, 0.051, 0.208, 0.02, 0, 0],
    [0, 0, 0.016, 0.02, 0.027, 0.145, 0.035, 0, 0],
    [0, 0, 0.02, 0, 0.012, 0.106, 0.016, 0, 0],
    [0, 0, 0, 0, 0, 0.075, 0, 0, 0],
    [0, 0.012, 0, 0, 0, 0.031, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
  ] },
  5: { w: 256, h: 256, p: 1.15, k: 1.569, grid: [
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0.008, 0, 0, 0, 0, 0],
    [0, 0, 0, 0.094, 0.051, 0, 0.067, 0, 0],
    [0, 0, 0, 0, 0.137, 0.039, 0, 0, 0],
    [0, 0, 0, 0.145, 0.031, 0.243, 0, 0, 0],
    [0, 0, 0, 0.067, 0, 0.016, 0, 0, 0],
    [0, 0, 0, 0, 0, 0.008, 0, 0, 0],
    [0, 0, 0, 0.094, 0.016, 0.125, 0.039, 0, 0],
    [0, 0, 0, 0.565, 0.231, 0.369, 0, 0, 0],
    [0, 0, 0, 0.004, 0.557, 0.114, 0, 0, 0],
    [0, 0, 0, 0.004, 0.184, 0, 0.106, 0, 0],
    [0, 0, 0, 0.165, 0.035, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
  ] },
  6: { w: 128, h: 512, p: 0.8, k: 0.838, grid: [
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0.063, 0.09, 0.071, 0.137, 0.118, 0.008, 0],
    [0, 0, 0.129, 0.263, 0.176, 0.455, 0.365, 0.055, 0],
    [0, 0, 0.173, 0.376, 0.239, 0.655, 0.522, 0.067, 0],
    [0, 0, 0.157, 0.345, 0.22, 0.592, 0.471, 0.067, 0],
    [0, 0, 0.145, 0.306, 0.196, 0.486, 0.392, 0.051, 0],
    [0, 0, 0.133, 0.267, 0.165, 0.357, 0.282, 0.051, 0],
    [0, 0, 0.11, 0.208, 0.129, 0.231, 0.18, 0.02, 0],
    [0, 0, 0.086, 0.161, 0.098, 0.137, 0.106, 0.008, 0],
    [0, 0, 0.071, 0.118, 0.078, 0.078, 0.067, 0, 0],
    [0, 0, 0.055, 0.082, 0.055, 0.031, 0.012, 0, 0],
    [0, 0, 0.031, 0.063, 0.039, 0.012, 0, 0, 0],
    [0, 0, 0.02, 0.039, 0.02, 0.008, 0, 0, 0],
    [0, 0, 0.008, 0.012, 0.012, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
  ] },
}
function shaftSheet(index) {
  const spec = SHAFT_PROFILES[index] || SHAFT_PROFILES[0]
  const { w, h, p: pow_, k, grid } = spec
  const NX = grid[0].length
  const NY = grid.length
  const rgba = new Uint8Array(w * h * 4)
  const at = (gx, gy) => grid[Math.min(NY - 1, Math.max(0, gy))][Math.min(NX - 1, Math.max(0, gx))]
  const sample = (t, n) => {
    const x = Math.min(n - 1 - 1e-6, Math.max(0, t * (n - 1)))
    const j = Math.floor(x)
    return [j, x - j]
  }
  for (let y = 0; y < h; y++) {
    const [jy, fy] = sample(y / (h - 1), NY)
    for (let x = 0; x < w; x++) {
      const [jx, fx] = sample(x / (w - 1), NX)
      const v0 = at(jx, jy) * (1 - fx) + at(jx + 1, jy) * fx
      const v1 = at(jx, jy + 1) * (1 - fx) + at(jx + 1, jy + 1) * fx
      const raw = v0 * (1 - fy) + v1 * fy
      // 9×17 网格实测 + 每张的对比度指数 p 与增益 k：k 反解自「原版平均有效亮度」，
      // p 反解自「原版最亮行 ≥15% 峰值的宽度」——两者一起才能既不过亮、也不过细。
      const v = Math.min(1, k * Math.pow(raw, pow_))
      const b = Math.round(255 * v)
      const o = (y * w + x) * 4
      // RG88 语义：R = G = 强度（原版 R==G 100%），alpha 也写强度
      // （shader 的 additive 贡献 = rgb × alpha = v²）
      rgba[o] = b
      rgba[o + 1] = b
      rgba[o + 2] = b
      rgba[o + 3] = b
    }
  }
  return { width: w, height: h, rgba }
}

// 雨丝图集（particle/nature/rain1、rain2）—— **照本机原版素材实测重建**。
//
// 原版 rain1.tex：1024×1024 / TEXS 4 帧（每帧 512×512，2×2 排布），R8（形状在 R）。
// 对解码后的第 0 帧做连通域实测（阈值 >12/255）：
//   · 89 段/帧，段长 p10 14 / p50 49 / p90 219 / max 304 px（**短丝为主，不是贯穿整帧**）；
//   · 段宽 p50 2 / p90 5 px（细，抗锯齿后 2~5px）；
//   · 峰值亮度 p50 24 / max 95（满量程 255，整体很暗）；
//   · 整帧平均倾角 **-1.1°**（几乎垂直，略向左下）。
//
// 旧实现是「一帧一根 10° 斜丝」（当年照 preview 目测拍的：丝长 = quad 高、单粒一根）。
// 后果：`raindownpour` 预设 sizerandom 800~1600 → quad 400~800px，一颗雨滴就画出一根
// 400~800px 的**倾斜长丝**，而原版一颗雨滴画的是「十几根短细近垂直的丝」——
// 1444077782 用户实测：「倾斜的雨粒子少而大」。preview 的 10° 观感来自整片短丝的叠加，
// 不是单根丝的倾角。
const RAIN_FRAMES = 4
const RAIN_FRAME = 512 // 单帧边长（官方 512）
const RAIN_ATLAS = RAIN_FRAME * 2 // 2×2 图集
function rainSheet(opts) {
  const cfg = opts || {}
  const segments = cfg.segments || 89
  const peakMax = cfg.peakMax || 0.37
  const peakPow = cfg.peakPow || 1.6
  const lean = cfg.lean === undefined ? -0.019 : cfg.lean // tan(-1.1°)
  const rgba = new Uint8Array(RAIN_ATLAS * RAIN_ATLAS * 4)
  for (let f = 0; f < RAIN_FRAMES; f++) {
    const rng = mulberry32((0x9e3779b9 ^ (f * 0x85ebca6b)) >>> 0)
    const ox = (f % 2) * RAIN_FRAME
    const oy = ((f / 2) | 0) * RAIN_FRAME
    // 原版图集的**每一帧四边 2px 内都是 0**（实测），所以丝必须留在帧内留边，
    // 否则 2×2 图集的外圈会带 alpha（quad 边界露硬边）。
    const MARGIN = 3
    const write = (x, y, a) => {
      if (x < MARGIN || y < MARGIN || x >= RAIN_FRAME - MARGIN || y >= RAIN_FRAME - MARGIN) return
      const o = ((oy + y) * RAIN_ATLAS + ox + x) * 4
      const v = Math.round(Math.min(1, Math.max(0, a)) * 255)
      if (v * 255 > rgba[o + 3] * 255) writeWhite(rgba, o, v / 255) // 叠丝取最大值，不做加法
    }
    for (let i = 0; i < segments; i++) {
      const x0 = rng() * RAIN_FRAME
      const y0 = rng() * RAIN_FRAME
      // 段长：中位 ~49、p90 ~219、max ~304 → 重尾分布
      const len = 16 + 430 * Math.pow(rng(), 2.2)
      const peak = 0.04 + (peakMax - 0.04) * Math.pow(rng(), peakPow)
      const sigma = 0.5 + rng() * 0.35
      for (let t = 0; t < len; t++) {
        const y = Math.round(y0 + t)
        const cx = x0 + lean * t
        const fade = Math.min(1, Math.min(t, len - 1 - t) / 5)
        if (fade <= 0) continue
        for (let x = Math.floor(cx - 3); x <= Math.ceil(cx + 3); x++) {
          const d = x + 0.5 - cx
          const a = Math.exp(-(d * d) / (sigma * sigma)) * peak * fade
          if (a > 0.004) write(x, y, a)
        }
      }
    }
  }
  return { width: RAIN_ATLAS, height: RAIN_ATLAS, rgba }
}

/** 内置贴图的帧表（top-down **像素矩形** {x,y,width,height}，与 TEXS list 元素同构；
 *  ParticleSystem.setTexture 会用贴图尺寸归一化成 uv。无帧表的名字返回 null。
 *  ⚠ 曾经返回归一化 {ou,ov,su,sv}：setTexture 按像素矩形再除一次尺寸 → 全帧 NaN，
 *  GL 端雨丝采样全废（CPU 光栅直接吃归一化格式所以离线全绿，两条路径格式不一致
 *  让这条坏了很久没人发现）。 */
export function builtinParticleFrames(name) {
  if (name === 'particle/nature/rain1' || name === 'particle/nature/rain2') {
    // 与官方 rain1.tex 同构：1024×1024、TEXS 4 帧、每帧 512×512、2×2
    const list = []
    for (let i = 0; i < RAIN_FRAMES; i++) {
      list.push({
        x: (i % 2) * RAIN_FRAME,
        y: ((i / 2) | 0) * RAIN_FRAME,
        width: RAIN_FRAME,
        height: RAIN_FRAME,
      })
    }
    return list
  }
  // bubble3：原版是 **TEXS 64 帧**（8×8/128²）——程序化图集必须把帧表一起给出来，
  // 否则渲染端只能按引用方的 sequencemultiplier(2) 猜成 2×2，把 16 帧当一帧采样。
  if (name === 'particle/bubbles/bubble3') {
    const list = []
    for (let i = 0; i < 64; i++) {
      list.push({ x: (i % 8) * 128, y: ((i / 8) | 0) * 128, width: 128, height: 128 })
    }
    return list
  }
  // 叶片 3×3 图集（leaf() 与引用方 sequencemultiplier:3 对应）
  if (/^particle\/nature\/leaves\d*$/.test(name)) {
    const list = []
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++)
        list.push({ x: c * LEAF_CELL, y: r * LEAF_CELL, width: LEAF_CELL, height: LEAF_CELL })
    return list
  }
  return null
}

// 环形波（particle/misc/wave）：高斯环 + 外侧衰减
function ring(size, radius, thickness) {
  const rgba = new Uint8Array(size * size * 4)
  const half = size / 2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot((x - half) / half, (y - half) / half)
      writeWhite(rgba, (y * size + x) * 4, gauss(d - radius, thickness * 0.6) * Math.max(0, 1 - d))
    }
  }
  return { width: size, height: size, rgba }
}

// 气泡：薄亮环 + 弱内芯 + 高光（纯算术；variant 1/2/3 环厚与高光布局不同）
function bubble(size, variant) {
  const specs = {
    1: { r: 0.78, t: 0.048, inner: 0.06, hi: [[-0.28, -0.32, 0.22, 0.9], [0.32, 0.36, 0.12, 0.28]] },
    2: { r: 0.7, t: 0.07, inner: 0.14, hi: [[-0.2, -0.28, 0.3, 0.72], [0.38, 0.2, 0.14, 0.4]] },
    3: { r: 0.84, t: 0.036, inner: 0.04, hi: [[-0.34, -0.18, 0.16, 0.95], [0.2, 0.42, 0.1, 0.22], [0.04, -0.08, 0.07, 0.18]] },
  }
  const spec = specs[variant] || specs[1]
  const rgba = new Uint8Array(size * size * 4)
  const half = size / 2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = (x + 0.5 - half) / half
      const py = (y + 0.5 - half) / half
      const d = Math.hypot(px, py)
      let a = gauss(d - spec.r, spec.t * 0.85) * Math.max(0, 1.05 - d)
      if (d < spec.r) a += spec.inner * gauss(d, 0.5)
      for (let i = 0; i < spec.hi.length; i++) {
        const h = spec.hi[i]
        a += h[3] * gauss(Math.hypot(px - h[0], py - h[1]), h[2])
      }
      writeWhite(rgba, (y * size + x) * 4, a)
    }
  }
  return conditionTexture({ width: size, height: size, rgba }, 0.05)
}

// 气泡图集：WE 预设 bubbles1/2 的 sequencemultiplier=2 → 按 2×2 方格取帧。
// 旧生成器把整圆画满整张图，采样只拿到一角 → 画面上永远是「四分之一气泡」
// （3441873795 Cartoon/Ocean bubbles）。每格各自画完整气泡。
function bubbleSheet(size, baseVariant) {
  const cell = size >> 1
  const rgba = new Uint8Array(size * size * 4)
  const vars = baseVariant === 1 ? [1, 2, 1, 3]
    : baseVariant === 2 ? [2, 1, 2, 3]
    : [3, 1, 2, 3]
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 2; col++) {
      const src = bubble(cell, vars[row * 2 + col])
      for (let y = 0; y < cell; y++) {
        const dy = (row * cell + y) * size
        const sy = y * cell
        for (let x = 0; x < cell; x++) {
          const di = (dy + col * cell + x) * 4
          const si = (sy + x) * 4
          rgba[di] = src.rgba[si]
          rgba[di + 1] = src.rgba[si + 1]
          rgba[di + 2] = src.rgba[si + 2]
          rgba[di + 3] = src.rgba[si + 3]
        }
      }
    }
  }
  return { width: size, height: size, rgba }
}

// 花瓣（particle/nature/rosepetals）：2×2 四帧水滴形 sprite sheet
function petals(size) {
  const rgba = new Uint8Array(size * size * 4)
  const cell = size / 2
  const cfg = [
    [0.32, 0.0],
    [1.1, 0.35],
    [2.2, -0.3],
    [-0.7, 0.2],
  ]
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const col = x >= cell ? 1 : 0
      const row = y >= cell ? 1 : 0
      const i = row * 2 + col
      const cx = col * cell + cell / 2
      const cy = row * cell + cell / 2
      const rot = cfg[i][0]
      const curl = cfg[i][1]
      const px = (x + 0.5 - cx) / (cell * 0.4)
      const py = (y + 0.5 - cy) / (cell * 0.4)
      const ca = Math.cos(rot)
      const sa = Math.sin(rot)
      let ux = px * ca + py * sa
      const uy = -px * sa + py * ca
      ux += curl * uy * 0.18
      const taper = 1 - Math.max(0, uy) * 0.42
      const d = Math.hypot(ux / (0.52 * taper), uy / 0.92)
      let a = d >= 1.12 ? 0 : gauss(d, 0.48)
      a = Math.min(1, a + gauss(ux, 0.07) * gauss(uy, 0.65) * a * 0.4)
      writeWhite(rgba, (y * size + x) * 4, a)
    }
  }
  return conditionTexture({ width: size, height: size, rgba }, 0.11)
}

// 叶片 3×3 九帧图集。官方内置 leaves* 贴图就是图集：全库引用它的粒子系统
// 一律 `sequencemultiplier: 3`、animationmode 空（按生命进度逐帧换叶形）。
// 画成单张一片叶会被渲染端 N×N 切成 9 个矩形块，落叶糊成色块（1725510475）。
// 色系按官方预设家族（作者侧 preview / 图层名反推，顶点色多为白→黄系乘子）：
//   0/1/2 红枫（2999533824 纯白顶点色仍落红叶）
//   3/5   橙黄（1725510475 白顶点色落橙叶、黄乘子落黄叶）
//   6/7/8 绿（3455074362 图层直接命名 "Leaves (green)"）
const LEAF_CELL = 256
const LEAF_ATLAS = LEAF_CELL * 3
function leaf(size, kind) {
  const specs = {
    0: { rx: 0.36, ry: 0.92, wave: 0, folds: 0, rgb: [196, 66, 32] },
    1: { rx: 0.48, ry: 0.86, wave: 0.05, folds: 7, rgb: [188, 58, 30] },
    2: { rx: 0.4, ry: 0.88, wave: 0.08, folds: 5, rgb: [206, 82, 36] },
    3: { rx: 0.58, ry: 0.72, wave: 0, folds: 0, rgb: [214, 148, 40] },
    5: { rx: 0.44, ry: 0.8, wave: 0.12, folds: 9, rgb: [220, 158, 48] },
    6: { rx: 0.52, ry: 0.78, wave: 0.07, folds: 4, rgb: [122, 150, 52] },
    7: { rx: 0.5, ry: 0.9, wave: 0.16, folds: 3, rgb: [96, 138, 50] },
    8: { rx: 0.38, ry: 0.94, wave: 0.2, folds: 2, rgb: [110, 148, 56] },
  }
  const s = specs[kind] || specs[0]
  const cell = Math.floor(size / 3)
  const rgba = new Uint8Array(cell * 3 * cell * 3 * 4)
  const half = cell / 2
  const rng = mulberry32(0x1eaf + kind * 131)
  for (let f = 0; f < 9; f++) {
    const col = f % 3
    const row = (f / 3) | 0
    // 帧间差异：旋转 / 缩放 / 亮度微抖动，逐帧换叶形才成立
    const rot = (f / 9) * Math.PI * 2 + (rng() - 0.5) * 0.7
    const scaleJ = 0.9 + rng() * 0.16
    const brightJ = 0.9 + rng() * 0.2
    const hueJ = 1 + (rng() - 0.5) * 0.12
    const ca = Math.cos(rot)
    const sa = Math.sin(rot)
    const mirror = f & 1 ? -1 : 1
    for (let y = 0; y < cell; y++) {
      for (let x = 0; x < cell; x++) {
        const px = ((x + 0.5 - half) / half) * mirror
        const py = (y + 0.5 - half) / half
        const ux = (px * ca + py * sa) / scaleJ
        const uy = (-px * sa + py * ca) / scaleJ
        // 两端收尖（叶尖更窄）：椭圆 → 叶形轮廓
        const taper = 1 - Math.pow(Math.min(1, Math.abs(uy)), 1.7) * 0.52
        const th = Math.atan2(ux, uy)
        const serr = s.wave ? 1 + s.wave * Math.sin(th * s.folds) : 1
        const d = Math.hypot(ux / (s.rx * serr * taper), uy / s.ry)
        // 锐利边 + 窄 AA 带（叶是近不透明实体，不是高斯软斑）
        const a = d >= 1.08 ? 0 : Math.min(1, (1.08 - d) / 0.14)
        if (a <= 0) continue
        // 中脉提亮相邻像素，边缘与叶尖略暗，中心最饱满
        const vein = gauss(ux, 0.028) * gauss(uy, 0.72)
        const shade = (0.8 + 0.2 * Math.max(0, 1 - d)) * (1 + vein * 0.22) * brightJ
        const o = (((row * cell + y) * cell * 3 + col * cell + x) * 4)
        rgba[o] = Math.min(255, Math.round(s.rgb[0] * shade * hueJ))
        rgba[o + 1] = Math.min(255, Math.round(s.rgb[1] * shade))
        rgba[o + 2] = Math.min(255, Math.round(s.rgb[2] * shade * (2 - hueJ)))
        rgba[o + 3] = Math.round(a * 255)
      }
    }
  }
  // targetAvg=0：叶是半透明混合的实体，不做 additive 系的能量归一
  return conditionTexture({ width: cell * 3, height: cell * 3, rgba }, 0)
}

// 高度图 → 标准切线空间法线（OpenGL：R=nx G=ny B=nz，对齐 WE DecompressNormal 的 tex.xy）。
// 官方粒子 Refract 用法线扰动画面（docs.wallpaperengine.io Particle Component - General），
// 中性 (0.5,0.5,1) 等于没开折射。blank albedo 的形状全在这张图里。
function heightToNormal(src, strength) {
  const W = src.width
  const H = src.height
  const srcRgba = src.rgba
  const k = strength == null ? 2.8 : strength
  const rgba = new Uint8Array(W * H * 4)
  const hAt = (x, y) => {
    const cx = x < 0 ? 0 : x >= W ? W - 1 : x
    const cy = y < 0 ? 0 : y >= H ? H - 1 : y
    return srcRgba[(cy * W + cx) * 4 + 3] / 255
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = (hAt(x - 1, y) - hAt(x + 1, y)) * k
      const dy = (hAt(x, y - 1) - hAt(x, y + 1)) * k
      const inv = 1 / Math.hypot(dx, dy, 1)
      const o = (y * W + x) * 4
      rgba[o] = Math.round((dx * inv * 0.5 + 0.5) * 255)
      rgba[o + 1] = Math.round((dy * inv * 0.5 + 0.5) * 255)
      rgba[o + 2] = Math.round((inv * 0.5 + 0.5) * 255)
      rgba[o + 3] = 255
    }
  }
  return { width: W, height: H, rgba }
}

// 水花撞击：中心半球 + 外圈涟漪（particle/normal_splash，常配 misc/wave）
function splashHeight(size) {
  const rgba = new Uint8Array(size * size * 4)
  const half = size / 2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = (x + 0.5 - half) / half
      const py = (y + 0.5 - half) / half
      const r = Math.hypot(px, py)
      const cap = r >= 1 ? 0 : Math.sqrt(Math.max(0, 1 - r * r))
      const ring = gauss(r - 0.62, 0.11) * 0.55
      writeWhite(rgba, (y * size + x) * 4, Math.min(1, cap * 0.85 + ring))
    }
  }
  return { width: size, height: size, rgba }
}

// 旋转掐尖：径向收缩 + 角向扭转（particle/normal_pinch_rotate）
function pinchHeight(size) {
  const rgba = new Uint8Array(size * size * 4)
  const half = size / 2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = (x + 0.5 - half) / half
      const py = (y + 0.5 - half) / half
      const r = Math.hypot(px, py)
      const th = Math.atan2(py, px)
      const pinch = gauss(r, 0.38) * (0.55 + 0.45 * Math.cos(th * 3 + r * 6))
      writeWhite(rgba, (y * size + x) * 4, pinch)
    }
  }
  return { width: size, height: size, rgba }
}

// 风圈（particle/shape/circle_wind）：开口环 + 切向拖尾
function windCircle(size) {
  const rgba = new Uint8Array(size * size * 4)
  const half = size / 2
  const feather = Math.max(2, Math.round(size * 0.04))
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = (x + 0.5 - half) / half
      const py = (y + 0.5 - half) / half
      const r = Math.hypot(px, py)
      const th = Math.atan2(py, px)
      const gap = smooth01(Math.max(0, Math.cos(th) * 0.55 + 0.45))
      const a = gauss(r - 0.68, 0.07) * gap + 0.35 * gauss(r - 0.78, 0.12) * gauss(th - 0.9, 0.55)
      writeWhite(rgba, (y * size + x) * 4, Math.min(1, a) * edgeFade(x, y, size, feather))
    }
  }
  return { width: size, height: size, rgba }
}

/**
 * [we-scene patch] 官方素材的**纹理格式取样语义**（WE `common_fragment.h::ConvertTexture0Format`
 * 的 GLSL 分支）：粒子槽拿到的贴图常常不是 RGBA8，而是单/双通道掩码 ——
 *   R8 / R16F      → `vec4(1, 1, 1, r)`   形状在 **R**，rgb 补白；
 *   RG88 / RG1616F → `vec4(r, r, r, g)`   形状在 **G**，rgb 用 R。
 * 我们的解码器把 R8 展开成 (r,r,r,**255**)、RG88 展开成 (G,G,G,R)，直接喂粒子 shader
 * （用 `t.a` 当形状）就得到**实心方块**或**取错通道**的精灵。本机接入 WE 原版素材后
 * 这个差距立刻显形：`particle/nature/rain1`(R8)、`particle/fog/fog1`(R8)、
 * `particle/water/rain_drops_sheet`(RG88)、`particle/light/light_shafts_0`(RG88)
 * 全是这种格式。这里把它们**烘成 WE 取样后的 RGBA**，粒子路径按普通 RGBA 上传即可。
 * 只给粒子路径用：效果链槽位另有 rg88（GL_RG 上传 + flowChannels/maskChannel）的约定。
 */
export function convertParticleTexFormat(pixel, format) {
  if (!pixel || !pixel.rgba) return pixel
  const f = Number(format)
  if (f !== 8 && f !== 9 && f !== 10 && f !== 11) return pixel
  const n = pixel.width * pixel.height
  const out = new Uint8Array(n * 4)
  const src = pixel.rgba
  if (f === 9 || f === 11) {
    // R8 / R16F：rgb = 白，alpha = R
    for (let i = 0; i < n; i++) {
      out[i * 4] = 255
      out[i * 4 + 1] = 255
      out[i * 4 + 2] = 255
      out[i * 4 + 3] = src[i * 4]
    }
  } else {
    // RG88 / RG1616F：rgb = R，alpha = G
    for (let i = 0; i < n; i++) {
      const r = src[i * 4]
      const g = src[i * 4 + 1]
      out[i * 4] = r
      out[i * 4 + 1] = r
      out[i * 4 + 2] = r
      out[i * 4 + 3] = g
    }
  }
  return { width: pixel.width, height: pixel.height, rgba: out, format: f, frames: pixel.frames }
}

/**
 * 法线槽的 RG88 语义：WE `DecompressNormalWithMask` 对 RG88 走 `normal.xy = normal.gr * 2 - 1`
 * —— **x 在 G、y 在 R**。我们的粒子 shader 读 `.rg` 当 xy，所以这里换回 (G, R, 0)。
 */
export function convertParticleNormalFormat(pixel, format) {
  if (!pixel || !pixel.rgba) return pixel
  const f = Number(format)
  if (f !== 8 && f !== 10) return pixel
  const n = pixel.width * pixel.height
  const out = new Uint8Array(n * 4)
  const src = pixel.rgba
  for (let i = 0; i < n; i++) {
    out[i * 4] = src[i * 4 + 1] // x ← G
    out[i * 4 + 1] = src[i * 4] // y ← R
    out[i * 4 + 2] = 0
    out[i * 4 + 3] = 255
  }
  return { width: pixel.width, height: pixel.height, rgba: out, format: f, frames: pixel.frames }
}

function rgbaLooksLikeAlbedo(rgba) {
  if (!rgba || rgba.length < 16) return false
  const n = rgba.length / 4
  const step = Math.max(1, (n / 48) | 0)
  let seen = 0
  for (let i = 0; i < n; i += step) {
    const o = i * 4
    if (rgba[o] < 240 || rgba[o + 1] < 240 || rgba[o + 2] < 240) return false
    seen++
  }
  return seen > 0
}

/** 槽 1 若拿到的是反照率（白 RGB、形状在 A），转成法线。DXT5nm / 标准法线原样返回。 */
export function prepareParticleNormalTexture(tex) {
  if (!tex || !tex.rgba) return tex
  return rgbaLooksLikeAlbedo(tex.rgba) ? heightToNormal(tex, 2.8) : tex
}

const ALBEDO_NORMAL_ALIAS = {
  'particle/drop': 'particle/drop_normal',
  'particle/water/rain_drops_sheet': 'particle/water/rain_drops_sheet_normal',
  'particle/bubbles/bubble1': 'particle/bubbles/bubble1normal',
  'particle/bubbles/bubble2': 'particle/bubbles/bubble2_normal',
  'particle/sharp_halo': 'particle/sharp_halo_normal',
  'particle/misc/wave': 'particle/normal_splash',
  'particle/halo': 'particle/sharp_halo_normal',
}

/** 官方 Refract 开启后的法线槽名。材质没填槽 1 时按反照率名推断。 */
export function particleNormalNameForAlbedo(albedo) {
  if (!albedo) return null
  const n = String(albedo)
  if (/normal/i.test(n)) return n
  return ALBEDO_NORMAL_ALIAS[n] || n + '_normal'
}

function pairedAlbedoName(name) {
  const n = String(name)
  if (/(^|\/)normal_/.test(n)) return null
  if (/_normal$/i.test(n)) return n.replace(/_normal$/i, '')
  if (/normal$/i.test(n)) return n.replace(/normal$/i, '')
  return null
}

function albedoPixels(name) {
  if (BUILDERS[name]) return BUILDERS[name]()
  const n = String(name).toLowerCase()
  if (/normal/.test(n)) return glow2(64, { r: 0.18, w: 1 }, { r: 0.4, w: 0.2 })
  return fallbackFor(name)()
}


// 返回 fbm(u, v, octLimit)。晶格从 freq 起步逐倍频程翻倍（不能从 f=1 起步，
// 首倍频程会是常量，整张图没有纹理——实测教训）。
function makeFbm(freq, oct, seed) {
  const rnd = mulberry32(seed * 7919 + 17)
  let f = freq
  const lattices = []
  for (let o = 0; o < oct; o++) {
    const n = f * f
    const g = new Float32Array(n * 2)
    for (let i = 0; i < n; i++) {
      const ang = rnd() * Math.PI * 2
      g[i * 2] = Math.cos(ang)
      g[i * 2 + 1] = Math.sin(ang)
    }
    lattices.push({ f, g, ox: o * 7.31, oy: o * 3.17 })
    f *= 2
  }
  const dotAt = (lat, ix, iy, dx, dy) => {
    const lf = lat.f
    const xa = ((ix % lf) + lf) % lf
    const ya = ((iy % lf) + lf) % lf
    const i = (ya * lf + xa) * 2
    return lat.g[i] * dx + lat.g[i + 1] * dy
  }
  const perlin = (lat, u, v) => {
    const fx = (u + lat.ox) * lat.f
    const fy = (v + lat.oy) * lat.f
    const x0 = Math.floor(fx)
    const y0 = Math.floor(fy)
    const dx = fx - x0
    const dy = fy - y0
    const tx = smooth5(dx)
    const ty = smooth5(dy)
    return lerp(
      lerp(dotAt(lat, x0, y0, dx, dy), dotAt(lat, x0 + 1, y0, dx - 1, dy), tx),
      lerp(dotAt(lat, x0, y0 + 1, dx, dy - 1), dotAt(lat, x0 + 1, y0 + 1, dx - 1, dy - 1), tx),
      ty,
    )
  }
  return function fbm(u, v, octLimit) {
    const n = octLimit == null ? lattices.length : Math.min(octLimit, lattices.length)
    let amp = 1
    let sum = 0
    let norm = 0
    for (let i = 0; i < n; i++) {
      sum += (perlin(lattices[i], u, v) * 0.5 + 0.5) * amp
      norm += amp
      amp *= 0.55
    }
    return sum / norm
  }
}

function bilinearResize(tex, w2, h2) {
  const { width: w, height: h, rgba } = tex
  if (w === w2 && h === h2) return tex
  const out = new Uint8Array(w2 * h2 * 4)
  for (let y = 0; y < h2; y++) {
    const fy = ((y + 0.5) / h2) * h - 0.5
    const y0 = Math.max(0, Math.min(h - 1, Math.floor(fy)))
    const y1 = Math.max(0, Math.min(h - 1, y0 + 1))
    const ty = fy - Math.floor(fy)
    for (let x = 0; x < w2; x++) {
      const fx = ((x + 0.5) / w2) * w - 0.5
      const x0 = Math.max(0, Math.min(w - 1, Math.floor(fx)))
      const x1 = Math.max(0, Math.min(w - 1, x0 + 1))
      const tx = fx - Math.floor(fx)
      const a0 = rgba[(y0 * w + x0) * 4 + 3]
      const a1 = rgba[(y0 * w + x1) * 4 + 3]
      const a2 = rgba[(y1 * w + x0) * 4 + 3]
      const a3 = rgba[(y1 * w + x1) * 4 + 3]
      const a = (a0 * (1 - tx) + a1 * tx) * (1 - ty) + (a2 * (1 - tx) + a3 * tx) * ty
      writeWhite(out, (y * w2 + x) * 4, a / 255)
    }
  }
  return { width: w2, height: h2, rgba: out }
}

// 絮状场：梯度噪声 fBm + 2 倍频程 domain warp。size>256 时在 256 生成再升采样
//（雾没有硬边，512² 全量 3×5 倍频是首帧卡顿的主因）。
function fogNoise(size, freq, oct, seed, density, maskExp, peakTarget) {
  const mExp = maskExp === undefined ? 1 : maskExp
  const pk = peakTarget === undefined ? 200 : peakTarget
  const inner = size > 256 ? 256 : size
  const fbm = makeFbm(freq, oct, seed)
  const rgba = new Uint8Array(inner * inner * 4)
  const half = inner / 2
  const N = inner * inner
  const noise = new Float32Array(N)
  let lo = 1
  let hi = 0
  for (let i = 0; i < N; i++) {
    const x = i % inner
    const y = (i / inner) | 0
    const u = (x + 0.5) / inner
    const v = (y + 0.5) / inner
    const qx = fbm(u + 5.2, v + 1.3, 2) - 0.5
    const qy = fbm(u + 9.7, v + 8.1, 2) - 0.5
    const val = (noise[i] = fbm(u + qx * 0.45, v + qy * 0.45))
    if (val < lo) lo = val
    if (val > hi) hi = val
  }
  const span = hi - lo || 1
  for (let y = 0; y < inner; y++) {
    for (let x = 0; x < inner; x++) {
      const n = (noise[y * inner + x] - lo) / span
      const d = Math.hypot((x + 0.5 - half) / half, (y + 0.5 - half) / half)
      // [we-scene patch 2026-09-14] 紧凑径向窗：旧实现只用 `pow(1-d, mExp)`
      // （mExp 0.9~1.7，近似线性），低 alpha 的「裙边」一直铺到 quad 边缘 ——
      // 半透明混合下几十个精灵叠加，每个 quad 的**直边**肉眼可见
      // （2241938645 车尾气 / 2250845956 人呼气「能看出透明的方块」）。
      // 这两个预设的精灵极大（sizerandom 500~700 / 1000~2200，叠图层 scale 后
      // 可覆盖整屏），方块的边被同步放大，所以窗必须收到「外圈 alpha 严格为 0」：
      // 高斯窗（C∞，无环带）+ 低 alpha 截断，blob 占中心 ~70% 直径。
      const window = Math.exp(-((d / 0.45) ** 2))
      const mask = Math.pow(Math.max(0, 1 - d), mExp) * window
      let a = Math.max(0, (n - (1 - density)) / (density || 1))
      a = smooth01(Math.min(1, a)) * mask
      // 低 alpha 截断：裙边残留的 1~5/255 也会随叠加显形，直接归零
      a = a <= 0.02 ? 0 : (a - 0.02) / 0.98
      writeWhite(rgba, (y * inner + x) * 4, a)
    }
  }
  let maxA = 0
  for (let i = 0; i < N; i++) maxA = Math.max(maxA, rgba[i * 4 + 3])
  if (maxA > 0 && maxA < pk) {
    const k = pk / maxA
    for (let i = 0; i < N; i++) rgba[i * 4 + 3] = Math.round(Math.min(255, rgba[i * 4 + 3] * k))
  }
  const tex = { width: inner, height: inner, rgba }
  return inner === size ? tex : bilinearResize(tex, size, size)
}

// 火舌：底部宽、顶部尖的竖直絮团，密度下高上低。seed 区分变体。
function fireWisp(size, seed) {
  const inner = size > 256 ? 256 : size
  const fbm = makeFbm(3, 5, seed == null ? 23 : seed)
  const rgba = new Uint8Array(inner * inner * 4)
  const N = inner * inner
  const noise = new Float32Array(N)
  let lo = 1
  let hi = 0
  for (let i = 0; i < N; i++) {
    const x = i % inner
    const y = (i / inner) | 0
    const u = (x + 0.5) / inner
    const v = (y + 0.5) / inner
    const qx = fbm(u + 2.1, v + 4.7, 2) - 0.5
    const qy = fbm(u + 6.3, v + 1.9, 2) - 0.5
    const val = (noise[i] = fbm(u + qx * 0.28, v + qy * 0.55))
    if (val < lo) lo = val
    if (val > hi) hi = val
  }
  const span = hi - lo || 1
  for (let y = 0; y < inner; y++) {
    for (let x = 0; x < inner; x++) {
      const ty = (y + 0.5) / inner // 0 顶 → 1 底
      const tx = ((x + 0.5) / inner) * 2 - 1
      const halfW = 0.1 + 0.52 * Math.pow(ty, 1.25)
      const n = (noise[y * inner + x] - lo) / span
      const mask = gauss(tx / (halfW || 0.01), 0.55) * gauss(ty - 0.58, 0.42)
      let a = smooth01(Math.min(1, Math.max(0, (n - 0.18) / 0.72))) * mask
      a *= ty < 0.06 ? ty / 0.06 : 1
      writeWhite(rgba, (y * inner + x) * 4, a)
    }
  }
  let maxA = 0
  for (let i = 0; i < N; i++) maxA = Math.max(maxA, rgba[i * 4 + 3])
  if (maxA > 0 && maxA < 220) {
    const k = 220 / maxA
    for (let i = 0; i < N; i++) rgba[i * 4 + 3] = Math.round(Math.min(255, rgba[i * 4 + 3] * k))
  }
  const tex = conditionTexture({ width: inner, height: inner, rgba }, 0.08)
  return inner === size ? tex : bilinearResize(tex, size, size)
}

// 雨滴 sprite sheet（particle/water/rain_drops_sheet，原生 128×256 = 2×4 格）：
// 每格一颗纵向小水滴（上圆下尖），格内留边保证 sheet 四边收敛
function dropSheet(w, h, cols, rows) {
  const rgba = new Uint8Array(w * h * 4)
  const cw = w / cols
  const ch = h / rows
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const cx = Math.floor(x / cw)
      const cy = Math.floor(y / ch)
      const lx = ((x + 0.5 - cx * cw) / cw) * 2 - 1
      const ly = ((y + 0.5 - cy * ch) / ch) * 2 - 1
      const taper = 1 - Math.max(0, ly) * 0.45
      const d = Math.hypot(lx / (0.52 * taper), ly / 0.8)
      const a = d >= 1.12 ? 0 : gauss(d, 0.48)
      writeWhite(rgba, (y * w + x) * 4, a)
    }
  }
  return { width: w, height: h, rgba }
}

// 碎屑（particle/debris/debris1，原生 64×64）：固定种子的软高斯散点
function debrisScatter(size) {
  const rgba = new Uint8Array(size * size * 4)
  const rnd = mulberry32(7)
  const specks = []
  for (let i = 0; i < 11; i++) {
    specks.push({
      x: 0.14 + rnd() * 0.72,
      y: 0.14 + rnd() * 0.72,
      rx: 0.025 + rnd() * 0.03,
      ry: 0.018 + rnd() * 0.024,
      rot: rnd() * Math.PI,
    })
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = (x + 0.5) / size
      const py = (y + 0.5) / size
      let best = 0
      for (const s of specks) {
        const dx = px - s.x
        const dy = py - s.y
        const ca = Math.cos(s.rot)
        const sa = Math.sin(s.rot)
        const ux = (dx * ca + dy * sa) / s.rx
        const uy = (-dx * sa + dy * ca) / s.ry
        const a = gauss(Math.hypot(ux, uy), 0.55)
        if (a > best) best = a
      }
      writeWhite(rgba, (y * size + x) * 4, best)
    }
  }
  return { width: size, height: size, rgba }
}

// 闪电：主干 + 分支的双层辉光。seed 决定折点与分叉，1/2/3 必须互异。
function lightningBolt(size, seed) {
  const s = seed == null ? 19 : seed
  const rnd = mulberry32(s)
  const clampX = (v) => Math.min(0.86, Math.max(0.14, v))
  const nMain = 5 + (s % 4)
  const pts = []
  let x = clampX(0.5 + (rnd() - 0.5) * 0.16)
  for (let i = 0; i <= nMain; i++) {
    const y = 0.06 + (i / nMain) * 0.86
    if (i > 0) x = clampX(x + (rnd() - 0.5) * 0.32)
    pts.push([x, y])
  }
  const segs = []
  for (let i = 0; i < pts.length - 1; i++) segs.push([pts[i], pts[i + 1], 1])
  const nBranch = 1 + (s % 2)
  for (let b = 0; b < nBranch; b++) {
    const at = 1 + ((s + b * 3) % Math.max(1, pts.length - 2))
    const origin = pts[at]
    const br = [origin]
    let bx = origin[0]
    let by = origin[1]
    const len = 2 + (s % 2)
    for (let k = 0; k < len; k++) {
      bx = clampX(bx + (rnd() - 0.5) * 0.36)
      by = Math.min(0.92, by + 0.1 + rnd() * 0.08)
      br.push([bx, by])
    }
    for (let i = 0; i < br.length - 1; i++) segs.push([br[i], br[i + 1], 0.45 + b * 0.1])
  }
  const rgba = new Uint8Array(size * size * 4)
  const feather = Math.max(2, Math.round(size * 0.04))
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = (x + 0.5) / size
      const py = (y + 0.5) / size
      let dMin = 9
      let wMax = 0
      for (const [a, b, w] of segs) {
        const abx = b[0] - a[0]
        const aby = b[1] - a[1]
        const den = abx * abx + aby * aby || 1e-8
        const t = Math.max(0, Math.min(1, ((px - a[0]) * abx + (py - a[1]) * aby) / den))
        const d = Math.hypot(px - (a[0] + abx * t), py - (a[1] + aby * t))
        if (d / w < dMin) {
          dMin = d / w
          wMax = w
        }
      }
      const a = 0.95 * gauss(dMin, 0.012) + 0.3 * gauss(dMin, 0.05) * wMax
      writeWhite(rgba, (y * size + x) * 4, Math.min(1, a) * edgeFade(x, y, size, feather))
    }
  }
  return { width: size, height: size, rgba }
}

// 彗尾（@trail / 流星，原生 64×128 竖向）：头部亮斑 + 向上的渐隐尾巴
function trailBlob(w, h) {
  const rgba = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = (x + 0.5 - w / 2) / (w / 2)
      const py = (y + 0.5 - h / 2) / (h / 2)
      const tail =
        gauss(px, 0.34) *
        Math.exp(-Math.max(0, -py - 0.05) * 4.2) *
        (py < 0.1 ? 1 : Math.max(0, 1 - py * 4))
      const hd = Math.hypot(px / 0.34, (py - 0.42) / 0.3)
      const head = hd >= 1 ? 0 : gauss(hd, 0.5)
      writeWhite(rgba, (y * w + x) * 4, Math.max(tail, head))
    }
  }
  return { width: w, height: h, rgba }
}

// 小而实的圆点（particle/chromaticdot，原生 64×64）：亮芯 + 快速衰减
function chromaticDot(size) {
  return glow2(size, { r: 0.1, w: 1 }, { r: 0.3, w: 0.16 })
}

// 水滴（particle/drop，原生 64×256 竖长）：上圆下尖的泪滴。
// 两端显式 cap，避免长条贴图顶底 alpha 收敛不够露出硬边。
function teardrop(w, h) {
  const rgba = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    const ty = (y + 0.5) / h
    const cap = smooth01(Math.min(1, Math.min(ty / 0.08, (1 - ty) / 0.08)))
    const vy = gauss(ty - 0.46, 0.24) * cap
    const r = 0.5 * (1 - smooth01(Math.min(1, Math.max(0, (ty - 0.42) / 0.5))) * 0.6)
    for (let x = 0; x < w; x++) {
      const dx = (x + 0.5 - w / 2) / (w / 2)
      writeWhite(rgba, (y * w + x) * 4, gauss(Math.abs(dx) / (r || 0.01), 0.5) * vy)
    }
  }
  return { width: w, height: h, rgba }
}

// 月牙（particle/sickle）：两盘错开的径向高斯相减
function crescent(size) {
  const rgba = new Uint8Array(size * size * 4)
  const half = size / 2
  const feather = Math.max(2, Math.round(size * 0.04))
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = (x + 0.5 - half) / half
      const py = (y + 0.5 - half) / half
      const outer = gauss(Math.hypot(px, py), 0.42)
      const inner = gauss(Math.hypot(px - 0.34, py), 0.36)
      const a = Math.max(0, outer - inner * 1.08) * edgeFade(x, y, size, feather)
      writeWhite(rgba, (y * size + x) * 4, a)
    }
  }
  return { width: size, height: size, rgba }
}

// 六折雪花（particle/nature/snow）：主轴 + 两档侧枝，不是圆光晕
function snowflake(size) {
  const rgba = new Uint8Array(size * size * 4)
  const half = size / 2
  const feather = Math.max(2, Math.round(size * 0.04))
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = (x + 0.5 - half) / half
      const py = (y + 0.5 - half) / half
      let a = gauss(Math.hypot(px, py), 0.08)
      for (let k = 0; k < 6; k++) {
        const ang = (k * Math.PI) / 3
        const ca = Math.cos(ang)
        const sa = Math.sin(ang)
        const along = px * ca + py * sa
        const perp = -px * sa + py * ca
        if (along < 0) continue
        const taper = Math.max(0, 1.02 - along / 0.72)
        a += gauss(perp, 0.028) * gauss(along, 0.5) * taper
        a += 0.55 * gauss(perp - (along - 0.28) * 0.65, 0.02) * gauss(along - 0.28, 0.12) * taper
        a += 0.55 * gauss(perp + (along - 0.28) * 0.65, 0.02) * gauss(along - 0.28, 0.12) * taper
        a += 0.4 * gauss(perp - (along - 0.48) * 0.7, 0.016) * gauss(along - 0.48, 0.08) * taper
        a += 0.4 * gauss(perp + (along - 0.48) * 0.7, 0.016) * gauss(along - 0.48, 0.08) * taper
      }
      writeWhite(rgba, (y * size + x) * 4, Math.min(1, a) * edgeFade(x, y, size, feather))
    }
  }
  return { width: size, height: size, rgba }
}

// 符文（particle/magic/glyph_*）：菱形环 + 十字 / 斜交 / 内环，variant 用名字 hash
// 符文（particle/magic/glyph_*）：中心小符号、细高斯笔划。
// 不能铺满贴图——3351163962「泡1」scale=10、additive、maxcount=25000，
// 粗笔划会把整屏冲白（原先关键词兜底成 halo 时能量集中在中心，覆盖面小得多）。
function glyph(size, variant) {
  const rgba = new Uint8Array(size * size * 4)
  const half = size / 2
  const feather = Math.max(2, Math.round(size * 0.04))
  const style = Math.abs(variant | 0) % 3
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = ((x + 0.5 - half) / half) * 1.55
      const py = ((y + 0.5 - half) / half) * 1.55
      const diamond = Math.abs(Math.abs(px) + Math.abs(py) - 0.55)
      let a = gauss(diamond, 0.016)
      if (style === 0) {
        a += gauss(px, 0.012) * gauss(py, 0.38)
        a += gauss(py, 0.012) * gauss(px, 0.38)
      } else if (style === 1) {
        a += gauss(px - py, 0.012) * gauss(px + py, 0.36)
        a += gauss(px + py, 0.012) * gauss(px - py, 0.36)
      } else {
        a += gauss(Math.hypot(px, py) - 0.26, 0.014)
        a += gauss(px, 0.012) * gauss(py, 0.22)
      }
      writeWhite(rgba, (y * size + x) * 4, Math.min(1, a) * edgeFade(x, y, size, feather))
    }
  }
  return conditionTexture({ width: size, height: size, rgba }, 0.03)
}

function hashName(n) {
  let h = 0
  const s = String(n)
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return h
}

// 官方十字星光斑（particle/light/flare_1）：紧凑亮核 + 四条细锐芒。
// 官方形态按 1948961570（SouredAppleClouds）官方 preview 实测标定：
//   - 芒是**恒定像素宽度的细线**（横向窄高斯），不是角向扇形——扇形的光束
//     离芯越远越宽，官方芒全程 ~2-3px 细线；
//   - 径向是**指数缓降**（exp(-d/0.30)），芒尾拖到贴图边缘仍有 ~4% 微光
//     （官方 preview 里细线一路延伸到画面边缘），高斯包络会在半路截断；
//   - 核小且亮，外加一圈贴芯小光晕。
// 旧实现 spikyStar(4, 0.62, 14) 的芒是 ~25° 宽、len 0.62 的宽扇形：magic
// sparkle 一类预设带 rotationrandom，粒子转到 ~45° 时宽扇形糊成整屏对角
// 粗光束（全库 5 张引用 flare_1，同病）。
function flareCross(size) {
  const rgba = new Uint8Array(size * size * 4)
  const half = size / 2
  const feather = Math.max(2, Math.round(size * 0.03))
  const rayW = 1.6 / size // 芒的横向 σ（归一化半径）：512 → σ≈0.8px，FWHM≈2px
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = (x + 0.5 - half) / half
      const py = (y + 0.5 - half) / half
      const d = Math.hypot(px, py)
      // 核：紧凑亮芯 + 贴芯小光晕
      let a = gauss(d, 0.05) + 0.3 * gauss(d, 0.15)
      // 四芒：横向细高斯 × 径向指数缓降
      a += 0.9 * gauss(py, rayW) * Math.exp(-Math.abs(px) / 0.3)
      a += 0.9 * gauss(px, rayW) * Math.exp(-Math.abs(py) / 0.3)
      a *= edgeFade(x, y, size, feather)
      writeWhite(rgba, (y * size + x) * 4, a)
    }
  }
  return { width: size, height: size, rgba }
}

// 变形光斑（particle/light/flare_2）：水平宽条 + 小芯，区别于 flare_1 的四尖十字
function flareAnamorphic(size) {
  const rgba = new Uint8Array(size * size * 4)
  const half = size / 2
  const feather = Math.max(2, Math.round(size * 0.03))
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = (x + 0.5 - half) / half
      const py = (y + 0.5 - half) / half
      const d = Math.hypot(px, py)
      const a =
        gauss(d, 0.07) +
        0.85 * gauss(px, 0.62) * gauss(py, 0.045) +
        0.22 * gauss(px, 0.92) * gauss(py, 0.018)
      writeWhite(rgba, (y * size + x) * 4, Math.min(1, a) * edgeFade(x, y, size, feather))
    }
  }
  return { width: size, height: size, rgba }
}


// 键为 WE 材质里的纹理名（去掉 materials/ 前缀与 .tex 后缀）。
// 生成尺寸 = 原生尺寸 × 2（原生尺寸取自 git 历史的素材表；上限 512）。
const BUILDERS = {
  // --- A. 定向覆盖 ---
  // [we-scene patch] halo_6 = xray 的「开窗精灵」（g_Texture2），全库只被 xray 壁纸引用。
  // frag 用 `blend *= sample.r * sample.a` 把它当**窗口的形状**，所以必须按原版素材的
  // 实心盘+软边剖面（见 haloWindow 注释），不能用软光斑 —— 否则程序化素材下整个窗口
  // 塌成中心一个小亮点。
  'particle/halo_6': () => haloWindow(128),

  // 法线贴图：官方 Refract / Lighting 开了才出现（Particle Component - General）。
  // 形状从配对反照率的 alpha 做高度图；DecompressNormal 吃 tex.xy，故写成标准 RGB 法线。
  // 中性 (0.5,0.5,1) 等于没折射——Raindrops Splatter 一类会只剩空白白图。
  'particle/normal_splash': () => heightToNormal(splashHeight(256), 3.2),
  'particle/drop_normal': () => heightToNormal(teardrop(128, 512), 3.4),
  'particle/normal_ring_smooth': () => heightToNormal(ring(256, 0.55, 0.12), 3.1),
  'particle/normal_pinch_rotate': () => heightToNormal(pinchHeight(256), 2.8),
  'particle/water/rain_drops_sheet_normal': () => heightToNormal(dropSheet(256, 512, 2, 4), 3.6),
  'particle/bubbles/bubble1normal': () => heightToNormal(bubbleSheet(256, 1), 3.2),
  'particle/bubbles/bubble2_normal': () => heightToNormal(bubbleSheet(256, 2), 3.2),
  'particle/sharp_halo_normal': () => heightToNormal(glowN(256, [{ r: 0.035, w: 1 }, { r: 0.09, w: 0.45 }, { r: 0.22, w: 0.08 }]), 3.4),

  // 光束 / 光轴：纵向长条渐变。解析式梯度本就是这类贴图的真实形态
  // （WE 原素材也是纯梯度），程序化反而更干净。原生尺寸 64×256 → 生成 128×512。
  'particle/beam/beam_0': () => beam(128, 512, 0.46, true),
  'particle/beam/beam_1': () => beam(128, 512, 0.34, true),
  'particle/beam/beam_2': () => beam(128, 512, 0.22, true),
  'particle/beam/beam_2_fade': () => beam(128, 512, 0.24, false),
  // [we-scene patch] light_shafts_* 全部按原版实测剖面重建（尺寸/横截面/纵截面逐个对齐，
  // 见 SHAFT_PROFILES）。旧 beam() 是一律 128×512 的窄亮条，用户报 2282120494「太亮和粗」。
  'particle/light/light_shafts_0': () => shaftSheet(0),
  'particle/light/light_shafts_1': () => shaftSheet(1),
  'particle/light/light_shafts_2': () => shaftSheet(2),
  'particle/light/light_shafts_3': () => shaftSheet(3),
  'particle/light/light_shafts_4': () => shaftSheet(4),
  'particle/light/light_shafts_5': () => shaftSheet(5),
  'particle/light/light_shafts_6': () => shaftSheet(6),

  // 自然物
  'particle/nature/rosepetals': () => petals(256),
  'particle/nature/leaves': () => leaf(LEAF_ATLAS, 0),
  'particle/nature/leaves1': () => leaf(LEAF_ATLAS, 1),
  'particle/nature/leaves2': () => leaf(LEAF_ATLAS, 2),
  'particle/nature/leaves3': () => leaf(LEAF_ATLAS, 3),
  'particle/nature/leaves5': () => leaf(LEAF_ATLAS, 5),
  'particle/nature/leaves6': () => leaf(LEAF_ATLAS, 6),
  'particle/nature/leaves7': () => leaf(LEAF_ATLAS, 7),
  'particle/nature/leaves8': () => leaf(LEAF_ATLAS, 8),
  'particle/nature/snow': () => snowflake(256),

  // --- B. 原 CC0 素材键的程序化替身（生成尺寸 = 原生 ×2） ---
  // halo 家族（原生 128 → 256）：双叶高斯，由紧到松；halo_3/halo_5 加实心芯
  // [we-scene patch] particle/halo 是 1 个 xray 壁纸（2131872317? 见 SKILL）的 g_Texture2 默认，
  // 也是全库最常用的粒子精灵之一。原版 halo.tex（64²、RGB 恒 255）实测径向剖面
  //   a = 234 225 201 164 119 75 41 19 8 3 1 @ r=0.0…1.0
  // ≈ 234·exp(-(r/0.47)²)（很宽的软晕，σ≈0.47）。旧实现 glow2(0.12/0.3) 的 σ≈0.15 窄 3 倍，
  // 程序化素材下光斑小一圈 —— xray 窗口同样塌成小点。
  'particle/halo': () =>
    radialProfile(256, [234, 225, 201, 164, 119, 75, 41, 19, 8, 3, 1].map((v) => v / 255)),
  'particle/halo_1': () => glow2(256, { r: 0.1, w: 1 }, { r: 0.3, w: 0.13 }),
  'particle/halo_2': () => glow2(256, { r: 0.2, w: 0.9 }, { r: 0.44, w: 0.2 }),
  'particle/halo_3': () => glowN(256, [{ r: 0.045, w: 1 }, { r: 0.13, w: 0.85 }, { r: 0.36, w: 0.15 }]),
  'particle/halo_4': () => glow2(256, { r: 0.085, w: 1 }, { r: 0.28, w: 0.12 }),
  'particle/halo_5': () => glowN(256, [{ r: 0.04, w: 1 }, { r: 0.11, w: 0.8 }, { r: 0.34, w: 0.17 }]),
  'particle/sharp_halo': () => glowN(256, [{ r: 0.035, w: 1 }, { r: 0.09, w: 0.45 }, { r: 0.22, w: 0.08 }]),
  // 色差小圆点（原生 64 → 128）：亮芯小点
  'particle/chromaticdot': () => chromaticDot(128),
  // 四芒 flare（原生 256 → 512）：flare_1 是官方十字细芒（见 flareCross 注释）
  'particle/light/flare_0': () => spikyStar(256, 6, 0.58, 10, 0.08),
  'particle/light/flare_1': () => flareCross(512),
  'particle/light/flare_2': () => flareAnamorphic(256),
  // 水滴（原生 64×256 → 128×512）：竖长泪滴
  'particle/drop': () => teardrop(128, 512),
  // 雨丝（原生 64×256 → 128×512）：细长条，两端渐隐
  'particle/nature/rain1': () => rainSheet({ segments: 120, peakMax: 0.42, peakPow: 2.4 }),
  // rain2 本机原版素材缺失（WE 安装目录里没有），按同族关系取「更密更亮」的一档
  'particle/nature/rain2': () => rainSheet({ segments: 120, peakMax: 0.55, peakPow: 2.2 }),
  // 雨滴 sheet（原生 128×256 → 256×512，2×4 格）：每格一颗上圆下尖小水滴
  'particle/water/rain_drops_sheet': () => dropSheet(256, 512, 2, 4),
  // 雾（原生 256 → 512）：絮状 fBm，弱遮罩铺满；三张不同尺度/种子
  'particle/fog/fog1': () => fogNoise(512, 4, 5, 1, 0.4, 0.9, 210),
  'particle/fog/fog2': () => fogNoise(512, 3, 5, 2, 0.45, 0.8, 200),
  'particle/fog/fog3': () => fogNoise(512, 6, 4, 3, 0.36, 1, 210),
  // 烟（原生 256 → 512）：同源 fBm 但遮罩更收（团絮感），smoke2light 降密度与峰值
  'particle/smoke/smoke1': () => fogNoise(512, 3, 5, 7, 0.55, 1.5, 185),
  'particle/smoke/smoke2': () => fogNoise(512, 2, 5, 11, 0.6, 1.7, 170),
  'particle/smoke/smoke2light': () => fogNoise(512, 2, 5, 13, 0.4, 1.7, 155),
  // 环形波（原生 256 → 512）
  'particle/misc/wave': () => ring(512, 0.72, 0.085),
  'particle/misc/star_0': () => spikyStar(256, 5, 0.62, 8, 0.1),
  // 气泡（原生 128 → 256）：三档环厚 / 高光
  'particle/bubbles/bubble1': () => bubbleSheet(256, 1),
  'particle/bubbles/bubble2': () => bubbleSheet(256, 2),
  // 原版 bubble3 = 1024²/64 帧/黑底小气泡群（见 bubbleClusterSheet 注释）；
  // 旧实现 bubbleSheet(256,3) 是白色实心肥皂泡，与它完全不是一回事（1837470104）。
  'particle/bubbles/bubble3': () => bubbleClusterSheet(1024, 64, 58, 0xb3b31e),
  // 碎屑（原生 64 → 128）：固定种子高斯散点
  'particle/debris/debris1': () => debrisScatter(128),
  // 闪电（原生 128 → 256）：三种折线，种子不同
  'particle/lightning/lightning1': () => lightningBolt(256, 3),
  'particle/lightning/lightning2': () => lightningBolt(256, 11),
  'particle/lightning/lightning3': () => lightningBolt(256, 19),
  // 火 / 月牙 / 符文（本机库引用过、原先落到通用光晕）
  'particle/fire/fire1': () => fireWisp(256, 23),
  'particle/fire/fire2': () => fireWisp(256, 41),
  'particle/star': () => spikyStar(256, 4, 0.58, 12, 0.09),
  'particle/shape/circle_wind': () => windCircle(256),
  'particle/sickle': () => crescent(256),
  'particle/magic/glyph_4': () => glyph(256, 4),
  // 原素材表的三个语义别名（@sparkle/@star 原生 128 → 256；@trail 64×128 → 128×256）
  '@sparkle': () => spikyStar(256, 4, 0.6, 16, 0.08),
  '@star': () => spikyStar(256, 5, 0.62, 8, 0.1),
  '@trail': () => trailBlob(128, 256),
}

// 名字里的语义关键词 → 生成器（工坊自定义名与未列出的内置名都走这里）。
// 更具体的规则必须在更泛的前面（「流星」含「星」，「snow」不能排在 snowflake 之后才补）。
function fallbackFor(name) {
  const n = String(name).toLowerCase()
  if (/normal/.test(n)) {
    const pair = pairedAlbedoName(name)
    if (pair) return () => heightToNormal(albedoPixels(pair), 2.8)
    return () => heightToNormal(splashHeight(128), 2.6)
  }
  if (/rosepetal|petal|sakura|blossom/.test(n)) return () => petals(256)
  if (/leaf|leaves|foliage/.test(n)) {
    if (/leaves8/.test(n)) return () => leaf(LEAF_ATLAS, 8)
    if (/leaves7/.test(n)) return () => leaf(LEAF_ATLAS, 7)
    if (/leaves6/.test(n)) return () => leaf(LEAF_ATLAS, 6)
    if (/leaves5/.test(n)) return () => leaf(LEAF_ATLAS, 5)
    if (/leaves3/.test(n)) return () => leaf(LEAF_ATLAS, 3)
    if (/leaves2/.test(n)) return () => leaf(LEAF_ATLAS, 2)
    if (/leaves1/.test(n)) return () => leaf(LEAF_ATLAS, 1)
    return () => leaf(LEAF_ATLAS, 0)
  }
  if (/circle_wind|windcircle/.test(n)) return () => windCircle(256)
  if (/fog|cloud|mist|vapor/.test(n)) return () => fogNoise(512, 4, 5, 5, 0.4, 0.9, 210)
  if (/smoke/.test(n)) return () => fogNoise(512, 3, 5, 8, 0.55, 1.5, 185)
  if (/beam|shaft|ray|godray/.test(n)) return () => beam(128, 512, 0.3, true)
  if (/flare/.test(n)) return () => flareAnamorphic(256)
  if (/bubble/.test(n)) return () => bubble(256, 1)
  if (/ring|wave/.test(n)) return () => ring(512, 0.72, 0.085)
  if (/fire|flame|ember|ash/.test(n)) return () => fireWisp(256, hashName(n))
  if (/sickle|crescent|moon/.test(n)) return () => crescent(256)
  if (/glyph|magic|rune/.test(n)) return () => glyph(256, hashName(n))
  if (/snowflake|雪花|snow/.test(n)) return () => snowflake(256)
  if (/流星|meteor|shooting/.test(n)) return () => trailBlob(128, 256)
  if (/star|星/.test(n)) return () => spikyStar(256, 5, 0.62, 8, 0.1)
  if (/sparkle|glint|twinkle/.test(n)) return () => spikyStar(256, 4, 0.6, 16, 0.08)
  if (/rain_drops_sheet|drops_sheet/.test(n)) return () => dropSheet(256, 512, 2, 4)
  if (/drop|rain/.test(n)) return () => teardrop(128, 512)
  if (/debris|dirt|rock/.test(n)) return () => debrisScatter(128)
  if (/lightning|bolt|arc/.test(n)) return () => lightningBolt(256, hashName(n))
  if (/note|music/.test(n)) return () => spikyStar(256, 4, 0.55, 8, 0.12)
  if (/trail|streak/.test(n)) return () => trailBlob(128, 256)
  // 兜底：通用柔和光晕。绝大多数 halo_* / 未知圆形粒子都能用它顶上。
  return () => glow2(256, { r: 0.12, w: 1 }, { r: 0.3, w: 0.15 })
}

// 生成（带缓存）内置粒子贴图的像素数据。任何情况下都不为 null。
// 求值顺序：宿主按名覆盖 → 宿主兜底 provider → 显式登记表 → 关键词兜底 → 光晕兜底。
export function buildBuiltinParticleTexture(name) {
  if (cache.has(name)) return cache.get(name)
  let out = null
  // 1) 宿主按名覆盖：最显式的意图，优先于一切内置生成器。
  const ov = overrides.get(name)
  if (ov) {
    try {
      out = ov()
    } catch {
      out = null
    }
  }
  // 2) 宿主兜底接管：返回 null/undefined 则继续内置链
  if (!out && overrideProvider) {
    try {
      out = overrideProvider(name)
    } catch {
      out = null
    }
  }
  // 3) 显式登记表：定向覆盖 + 全部原素材键的程序化替身
  if (!out && BUILDERS[name]) {
    try {
      out = BUILDERS[name]()
    } catch {
      out = null
    }
  }
  // 4) 关键词兜底
  if (!out) {
    try {
      out = fallbackFor(name)()
    } catch {
      out = null
    }
  }
  // 生成器异常时的最后防线：纯算术光晕（不依赖 canvas）
  if (!out) out = glow2(256, { r: 0.12, w: 1 }, { r: 0.3, w: 0.15 })
  // 精灵硬边封印（见下方 RIM_SEALED 注释）：软形状精灵的边缘 alpha 必须严格 0
  for (const rule of RIM_SEALED) {
    if (rule.re.test(name)) {
      sealRim(out, rule.band)
      break
    }
  }
  cache.set(name, out)
  return out
}

// 「烟/雾/火/光斑/气泡/光柱」这类**按精灵画**的软形状贴图，只要边缘 alpha 不是
// 严格 0，放成几百~几千像素的 quad 后就能看见方形的边（2241938645 车尾气、
// 2250845956 人呼气「能看出透明的方块」；同族还有 flares / star / bubble / beam）。
// 官方素材的轮廓是一条平滑衰减到 0 的软边；本仓库部分生成器沿到边缘仍有
// 12~130/255 的 alpha，conditionTexture 的 4% 线性羽化盖不住。
// 这里在**出贴图时**统一加一道更宽的 S 形窗，比逐生成器改更安全、也便于离线审计。
// 只对「精灵类」名单生效：图集（rain1/rain2、leaves*、lightning*、
// rain_drops_sheet）与法线贴图（*normal*、drop_normal 等）**必须原样** ——
// 图集的格子边是帧边界不是精灵边；法线的 alpha 是折射蒙版，改它会让 REFRACT
// 雨滴的形状/边缘变形。
const RIM_SEALED = [
  { re: /^particle\/(light|beam|fire)\//, band: 0.18 },
  // bubble3 **排除**：它是原版那种「黑底 + 小气泡群」——形状在 **RGB**、alpha 恒 255、
  // 走 additive（黑=不贡献）。封边只压 alpha，对它毫无作用，却会把图集外圈 0.18 带宽
  // （1024² 上 ~184px，整个 frame 0）的 RGB 一起留着、alpha 归零 → 首帧整帧消失。
  { re: /^particle\/bubbles\/(?!.*normal)(?!bubble3)/, band: 0.18 },
  { re: /^particle\/(misc|shape)\//, band: 0.18 },
  { re: /^particle\/(star|sickle)/, band: 0.18 },
  { re: /^particle\/drop$/, band: 0.08 },
  { re: /^@(star|sparkle|trail)$/, band: 0.18 },
]

/** 把 alpha 乘上一道宽 S 形边窗：内部 1、边界 0，C1 连续无硬台阶 */
function sealRim(tex, bandFrac) {
  if (!tex || !tex.rgba) return tex
  const W = tex.width
  const H = tex.height
  const band = Math.max(2, Math.round(Math.min(W, H) * bandFrac))
  const rgba = tex.rgba
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dEdge = Math.min(x, y, W - 1 - x, H - 1 - y)
      if (dEdge >= band) continue
      const k = smooth01(dEdge / band)
      const o = (y * W + x) * 4 + 3
      rgba[o] = Math.round(rgba[o] * k)
    }
  }
  return tex
}

// 该名字是否是「WE 内置」粒子贴图（用于区分工坊贴图缺失 vs 内置缺失，仅诊断用）
export function isBuiltinParticleTextureName(name) {
  return typeof name === 'string' && name.indexOf('particle/') === 0
}

// 效果 pass 的 textures 槽引用的 WE 公共 util 贴图**不在 scene.pkg 里**（与粒子
// 内置贴图同源，属 WE 安装目录的公共资源）。全库实测引用：
//   util/clouds_256 ×36 处 / 20 张壁纸（云效果的密度图）
//   util/black      ×8  （黑色遮罩/回退）
// 缺 clouds_256 时云效果拿到白板贴图：cloud0×cloud1 恒为 1，smoothstep 后整片蒙版
// 区被涂成均匀色（Hue 混合下还会把色相拉到红），且白板无图案可漂移 —— 天空是一层
// **静止伪影**（959417181「下雨 shader 动态效果」缺失的真身之一）。
// 生成尺寸/形态对齐官方 clouds_256：256×256、可平铺、软絮状（对比度偏中，留出
// 阈值 0.15 + 羽化下方的净空）。可平铺是硬要求：云 shader 的 uv 随 g_Time 无界增长，
// 采样必须能环绕（见 scene-mount 的 REPEAT 注册），否则漂一会儿整片天空都会被
// CLAMP 拉成边缘一行。

/** 周期值噪声：格点按 grid 取模 → size % grid === 0 时左右/上下无缝拼接 */
function periodicValueNoise(size, grid, seed) {
  const rng = mulberry32(seed)
  const g = new Float32Array(grid * grid)
  for (let i = 0; i < g.length; i++) g[i] = rng()
  const out = new Float32Array(size * size)
  const cell = size / grid
  for (let y = 0; y < size; y++) {
    const fy = y / cell
    const iy = Math.floor(fy)
    const ty = fy - iy
    const sy = ty * ty * (3 - 2 * ty)
    const y0 = (iy % grid) * grid
    const y1 = ((iy + 1) % grid) * grid
    for (let x = 0; x < size; x++) {
      const fx = x / cell
      const ix = Math.floor(fx)
      const tx = fx - ix
      const sx = tx * tx * (3 - 2 * tx)
      const x0 = ix % grid
      const x1 = (ix + 1) % grid
      const a = g[y0 + x0]
      const b = g[y0 + x1]
      const c = g[y1 + x0]
      const d = g[y1 + x1]
      const top = a + (b - a) * sx
      const bot = c + (d - c) * sx
      out[y * size + x] = top + (bot - top) * sy
    }
  }
  return out
}

/** 云密度图：多倍频周期噪声 → 阈值软拐点 → 灰阶（shader 只采 .r） */
function cloudDensityTexture(size = 256) {
  const octaves = [
    [4, 0.5, 0x9e3779b1],
    [8, 0.25, 0x85ebca6b],
    [16, 0.125, 0xc2b2ae35],
    [32, 0.0625, 0x27d4eb2f],
    [64, 0.03125, 0x165667b1],
  ]
  const acc = new Float32Array(size * size)
  let wsum = 0
  for (const [grid, amp, seed] of octaves) {
    const n = periodicValueNoise(size, grid, seed)
    for (let i = 0; i < acc.length; i++) acc[i] += n[i] * amp
    wsum += amp
  }
  const rgba = new Uint8Array(size * size * 4)
  for (let i = 0; i < acc.length; i++) {
    let v = acc[i] / wsum
    // 偏置：官方云图大部分区域落在阈值 0.15 之下（晴空），絮团才亮
    v = Math.min(1, Math.max(0, (v - 0.30) / 0.52))
    v = v * v * (3 - 2 * v)
    const c = Math.round(v * 255)
    const o = i * 4
    rgba[o] = c
    rgba[o + 1] = c
    rgba[o + 2] = c
    rgba[o + 3] = 255
  }
  return { width: size, height: size, rgba }
}

/**
 * 内置 util 贴图生成（scene-mount 注册内置纹理表时调用）。
 * 返回 null 表示不是内置 util 名（调用方继续走 pkg / 其它来源）。
 */
export function buildBuiltinUtilTexture(name) {
  if (name === 'util/clouds_256') {
    if (!cache.has(name)) cache.set(name, cloudDensityTexture(256))
    return cache.get(name)
  }
  if (name === 'util/black') {
    if (!cache.has(name)) cache.set(name, { width: 1, height: 1, rgba: new Uint8Array([0, 0, 0, 255]) })
    return cache.get(name)
  }
  return null
}
