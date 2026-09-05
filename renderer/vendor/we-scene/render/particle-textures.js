// [we-scene patch] WE 内置粒子贴图的素材供给：**全程序化生成 + 宿主覆盖接口**。
//
// 为什么需要这个文件：粒子材质引用的贴图（particle/halo、particle/drop、
// particle/fog/fog1 …）**不在 scene.pkg 里** —— 它们是 Wallpaper Engine 安装目录
// 自带的公共资源，作者的 pkg 只存自己上传的工坊贴图。全库实测 33 张被引用的粒子贴图
// 里 24 张属于内置资源，缺一张整个粒子系统就没东西可画。
//
// 供给策略（2026-09-02 起，取代旧的「CC0 素材表 + 程序化兜底」两级结构）：
//   0. **宿主覆盖**（本文件底部三个函数）：按名字注册工厂 / 兜底接管全部名字。
//      宿主手头有 WE 安装目录的原版贴图时从这里注入，观感可完全对齐官方；
//   1. **显式登记表**（BUILDERS）：已知「默认形态不对」的名字的定向覆盖
//      （halo_6 被 xray 当开窗形状、法线按反照率高度图生成等），以及全部
//      原 CC0 素材键 + 本机库实测缺表的内置名（火/雪/月牙/符文/闪电变体等）；
//   2. **关键词兜底**（fallbackFor）：工坊自定义名按语义映射到生成器。
//
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
//
// 实现约定：
//   - 所有生成函数返回 { width, height, rgba: Uint8Array }，直接喂 texImage2D；
//   - 素材一律「预乘前」的直通 RGBA，alpha 携带形状，rgb 为白（颜色由顶点色调制）；
//   - **本文件零 import**：生成器纯算术，Node 离线校验与浏览器渲染同一条路径、
//     逐像素一致（verify-particles 的贴图区块靠这个）；
//   - 生成器必须确定性（固定种子，禁 Math.random）：同名字同像素，A/B 对比才可信。

const cache = new Map()

// ---------- 宿主覆盖接口 ----------
//
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

// ---------- 画质基元 ----------

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

// 雨丝（particle/nature/rain1、rain2）：贴图自带的斜细丝 + 1×4 帧图集。
// WE 官方 rain1.tex 的丝不是竖直的——raindownpour 预设无任何旋转、不开风、
// velocity x 仅 -45（0.6°），但官方 preview（1823900922 / 1444077782）里雨丝
// 统一倾斜 ~10°（上端在右），只能来自贴图本身；且预设写了
// `animationmode: randomframe`（每粒随机固定一帧）——单帧贴图写它毫无意义，
// 说明官方贴图是多帧图集：丝长 = quad 高 ÷ 帧数（官方丝 200-500px，
// 整高会画出 400-1000px 的超长丝，1823900922 图1 的另一处失衡）。
// 旧实现用 beam() 的竖直 σ0.16 粗核心单帧 → 粗白竖长光柱。
// beam() 本身别动：beam_*/light_shafts 的竖直粗丝是它们自己的正确形态。
const RAIN_FRAMES = 4
function rainStreak(w, h, tiltDeg, corePx, peak) {
  const pk = peak === undefined ? 0.85 : peak
  const rgba = new Uint8Array(w * h * 4)
  const fh = h / RAIN_FRAMES
  const rng = mulberry32(0x51ca1)
  const tilt = Math.tan((tiltDeg * Math.PI) / 180)
  const cx = w / 2
  for (let f = 0; f < RAIN_FRAMES; f++) {
    // 帧间微差（亮度/粗细/水平相位）：randomframe 抽到不同帧的雨丝形态不一
    const peakF = pk * (0.8 + rng() * 0.35)
    const coreF = corePx * (0.85 + rng() * 0.5)
    const ph = (rng() - 0.5) * w * 0.12
    for (let y = 0; y < fh; y++) {
      const ty = y / (fh - 1)
      // 帧内第 0 行（屏幕上端）在右侧，向下渐左——与下落方向一致
      const lineX = cx + ph + ((fh - 1) * tilt) / 2 - (fh - 1) * tilt * ty
      const vy = gauss(ty - 0.5, 0.27)
      for (let x = 0; x < w; x++) {
        const d = Math.abs(x + 0.5 - lineX)
        const g = Math.exp(-(d * d) / (coreF * coreF))
        const a = g * vy * peakF
        if (a < 0.004) continue
        writeWhite(rgba, ((f * fh + y) * w + x) * 4, a)
      }
    }
  }
  return { width: w, height: h, rgba }
}

/** 内置贴图的帧表（top-down，与 TEXS list 元素同构）。无帧表的名字返回 null。 */
export function builtinParticleFrames(name) {
  if (name === 'particle/nature/rain1' || name === 'particle/nature/rain2') {
    const list = []
    for (let i = 0; i < RAIN_FRAMES; i++) list.push({ ou: 0, ov: i / RAIN_FRAMES, su: 1, sv: 1 / RAIN_FRAMES })
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

// 叶片：kind 0 卵形、1 偏宽、3 更圆、7 三裂（枫感）。中脉是沿主轴的细高斯脊。
// 2/5/6/8 是本机库引用过、原先落到 kind 0 的变体。
function leaf(size, kind) {
  const specs = {
    0: { rx: 0.36, ry: 0.92, wave: 0, folds: 0 },
    1: { rx: 0.48, ry: 0.86, wave: 0.05, folds: 7 },
    2: { rx: 0.4, ry: 0.88, wave: 0.08, folds: 5 },
    3: { rx: 0.58, ry: 0.72, wave: 0, folds: 0 },
    5: { rx: 0.44, ry: 0.8, wave: 0.12, folds: 9 },
    6: { rx: 0.52, ry: 0.78, wave: 0.07, folds: 4 },
    7: { rx: 0.5, ry: 0.9, wave: 0.16, folds: 3 },
    8: { rx: 0.38, ry: 0.94, wave: 0.2, folds: 2 },
  }
  const s = specs[kind] || specs[0]
  const rgba = new Uint8Array(size * size * 4)
  const half = size / 2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = (x + 0.5 - half) / half
      const py = (y + 0.5 - half) / half
      const th = Math.atan2(px, py)
      const serr = s.wave ? 1 + s.wave * Math.sin(th * s.folds) : 1
      const d = Math.hypot(px / (s.rx * serr), py / s.ry)
      let a = d >= 1.12 ? 0 : gauss(d, 0.5)
      if (a > 0) a = Math.min(1, a + gauss(px, 0.028) * gauss(py, 0.72) * 0.28)
      writeWhite(rgba, (y * size + x) * 4, a)
    }
  }
  return conditionTexture({ width: size, height: size, rgba }, 0.11)
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

// ---------- 梯度噪声 fBm（雾 / 烟 / 火）----------

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
      const mask = Math.pow(Math.max(0, 1 - d), mExp)
      let a = Math.max(0, (n - (1 - density)) / (density || 1))
      a = smooth01(Math.min(1, a)) * mask
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

// ---------- 名称 → 程序化生成器映射 ----------

// 键为 WE 材质里的纹理名（去掉 materials/ 前缀与 .tex 后缀）。
// 生成尺寸 = 原生尺寸 × 2（原生尺寸取自 git 历史的素材表；上限 512）。
const BUILDERS = {
  // --- A. 定向覆盖 ---
  // [we-scene patch] halo_6 必须程序化，**不能用素材表那张**。
  // 它在全库只被 2 个壁纸引用，且两个都是 xray 的「开窗精灵」（g_Texture2），
  // 不是普通粒子 —— frag 用 `blend *= sample.r * sample.a` 把它当**窗口的形状**，
  // 所以中心必须最亮、往外单调衰减，否则窗口正中心反而是暗的。
  // glow2 双叶都中心对称且单调递减，满足「中心最亮」；core 0.14 保证峰值贴满 1.0。
  'particle/halo_6': () => glow2(256, { r: 0.14, w: 1 }, { r: 0.4, w: 0.17 }),

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
  'particle/light/light_shafts_0': () => beam(128, 512, 0.42, true),
  'particle/light/light_shafts_1': () => beam(128, 512, 0.3, true),
  'particle/light/light_shafts_3': () => beam(128, 512, 0.26, true),
  'particle/light/light_shafts_5': () => beam(128, 512, 0.23, true),
  'particle/light/light_shafts_6': () => beam(128, 512, 0.2, true),

  // 自然物
  'particle/nature/rosepetals': () => petals(256),
  'particle/nature/leaves': () => leaf(256, 0),
  'particle/nature/leaves1': () => leaf(256, 1),
  'particle/nature/leaves2': () => leaf(256, 2),
  'particle/nature/leaves3': () => leaf(256, 3),
  'particle/nature/leaves5': () => leaf(256, 5),
  'particle/nature/leaves6': () => leaf(256, 6),
  'particle/nature/leaves7': () => leaf(256, 7),
  'particle/nature/leaves8': () => leaf(256, 8),
  'particle/nature/snow': () => snowflake(256),

  // --- B. 原 CC0 素材键的程序化替身（生成尺寸 = 原生 ×2） ---
  // halo 家族（原生 128 → 256）：双叶高斯，由紧到松；halo_3/halo_5 加实心芯
  'particle/halo': () => glow2(256, { r: 0.12, w: 1 }, { r: 0.3, w: 0.15 }),
  'particle/halo_1': () => glow2(256, { r: 0.1, w: 1 }, { r: 0.3, w: 0.13 }),
  'particle/halo_2': () => glow2(256, { r: 0.2, w: 0.9 }, { r: 0.44, w: 0.2 }),
  'particle/halo_3': () => glowN(256, [{ r: 0.045, w: 1 }, { r: 0.13, w: 0.85 }, { r: 0.36, w: 0.15 }]),
  'particle/halo_4': () => glow2(256, { r: 0.085, w: 1 }, { r: 0.28, w: 0.12 }),
  'particle/halo_5': () => glowN(256, [{ r: 0.04, w: 1 }, { r: 0.11, w: 0.8 }, { r: 0.34, w: 0.17 }]),
  'particle/sharp_halo': () => glowN(256, [{ r: 0.035, w: 1 }, { r: 0.09, w: 0.45 }, { r: 0.22, w: 0.08 }]),
  // 色差小圆点（原生 64 → 128）：亮芯小点
  'particle/chromaticdot': () => chromaticDot(128),
  // 四芒 flare（原生 256 → 512）：解析十字星芒
  'particle/light/flare_0': () => spikyStar(256, 6, 0.58, 10, 0.08),
  'particle/light/flare_1': () => spikyStar(512, 4, 0.62, 14, 0.07),
  'particle/light/flare_2': () => flareAnamorphic(256),
  // 水滴（原生 64×256 → 128×512）：竖长泪滴
  'particle/drop': () => teardrop(128, 512),
  // 雨丝（原生 64×256 → 128×512）：细长条，两端渐隐
  'particle/nature/rain1': () => rainStreak(128, 512, 10, 1.0, 0.78),
  'particle/nature/rain2': () => rainStreak(128, 512, 10, 1.6, 0.66),
  // 雨滴 sheet（原生 128×256 → 256×512，2×4 格）：每格一颗上圆下尖小水滴
  'particle/water/rain_drops_sheet': () => dropSheet(256, 512, 2, 4),
  // 雾（原生 256 → 512）：絮状 fBm，弱遮罩铺满；三张不同尺度/种子
  'particle/fog/fog1': () => fogNoise(512, 4, 5, 1, 0.4, 0.9, 150),
  'particle/fog/fog2': () => fogNoise(512, 3, 5, 2, 0.45, 0.8, 140),
  'particle/fog/fog3': () => fogNoise(512, 6, 4, 3, 0.36, 1, 150),
  // 烟（原生 256 → 512）：同源 fBm 但遮罩更收（团絮感），smoke2light 降密度与峰值
  'particle/smoke/smoke1': () => fogNoise(512, 3, 5, 7, 0.55, 1.5, 130),
  'particle/smoke/smoke2': () => fogNoise(512, 2, 5, 11, 0.6, 1.7, 120),
  'particle/smoke/smoke2light': () => fogNoise(512, 2, 5, 13, 0.4, 1.7, 110),
  // 环形波（原生 256 → 512）
  'particle/misc/wave': () => ring(512, 0.72, 0.085),
  'particle/misc/star_0': () => spikyStar(256, 5, 0.62, 8, 0.1),
  // 气泡（原生 128 → 256）：三档环厚 / 高光
  'particle/bubbles/bubble1': () => bubbleSheet(256, 1),
  'particle/bubbles/bubble2': () => bubbleSheet(256, 2),
  'particle/bubbles/bubble3': () => bubbleSheet(256, 3),
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
    if (/leaves8/.test(n)) return () => leaf(256, 8)
    if (/leaves7/.test(n)) return () => leaf(256, 7)
    if (/leaves6/.test(n)) return () => leaf(256, 6)
    if (/leaves5/.test(n)) return () => leaf(256, 5)
    if (/leaves3/.test(n)) return () => leaf(256, 3)
    if (/leaves2/.test(n)) return () => leaf(256, 2)
    if (/leaves1/.test(n)) return () => leaf(256, 1)
    return () => leaf(256, 0)
  }
  if (/circle_wind|windcircle/.test(n)) return () => windCircle(256)
  if (/fog|cloud|mist|vapor/.test(n)) return () => fogNoise(512, 4, 5, 5, 0.4, 0.9, 150)
  if (/smoke/.test(n)) return () => fogNoise(512, 3, 5, 8, 0.55, 1.5, 130)
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
  cache.set(name, out)
  return out
}

// 该名字是否是「WE 内置」粒子贴图（用于区分工坊贴图缺失 vs 内置缺失，仅诊断用）
export function isBuiltinParticleTextureName(name) {
  return typeof name === 'string' && name.indexOf('particle/') === 0
}
