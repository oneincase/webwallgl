// WE 系统内置贴图（materials/util/*）的程序化复刻供给入口。
// 背景：工坊壁纸的效果链 / 材质 / sampler 默认值会引用 WE 安装目录的公共 util
// 贴图（`materials/util/<名>.tex`），它们不在壁纸 pkg 里。linux-wallpaperengine
// 通过 `--assets-dir` 指向本机 WE 安装来解析；本渲染器没有 WE 安装目录可回退，
// 必须自带一套。此前只硬编码了 5 个名字且多为 1×1 / 程序化近似，与官方差距大：
//   - util/flatnormal（法线参考）完全缺失 → 法线类效果（waterripple/refract 等
//     sampler 默认槽）落到白纹理，法线被解释成 (1,1,1)，画面严重变形；
//   - util/noflow 的 B 通道写成了 127，官方实测是 **0**（B = flow 强度，
//     127 会让 flow 类 shader 认为存在一半强度的流动）；
//   - util/noise 用的是 8px 平滑值噪声，官方是**逐像素白噪声**（4 通道独立均匀
//     分布），颗粒感完全不同；
//   - util/perlin_256 / util/uniform_256 / util/fur 缺失 → 引用它们的槽落白板。
// 合规（docs/COMPLIANCE.md 红线「解包产物不入库」）：本模块**零内嵌官方字节**，
// 只复刻接口契约与像素统计。下列实测锚点均为统计量（尺寸 / 通道布局 / 均值方差 /
// 零值占比 / 平铺性 / mip 行为），不含任何内容本身：
//   noise      256×256 RGBA 白噪声，四通道独立均匀分布（mean≈127.5, sd≈73.8），
//              单 mip（官方 nomip:true）
//   perlin_256 256×256 RGBA 四个独立可平铺平滑场，通道 (mean,sd) 实测
//              (94.8,21.5) (108.4,26.2) (145.2,23.6) (112.0,32.0)，
//              自相关在 k≈64 处过零（特征波长≈64px，即 4×4 基网格 + 高频倍频），
//              7 级 mip
//   uniform_256 256×256 RGBA 稀疏白噪声：恰 ~50% 通道值为 0，其余均匀 [0,255]
//              （实测 zero=49.8%，非零均值 128.7），7 级 mip
//   fur        128×128 R8（解码为灰度 RGBA）：~41% 为 0，其余均匀偏亮
//              （非零均值≈155），单 mip（nomip）
//   clouds_256 256×256 灰度 FBM：mean=126, sd=52.7，钟形直方图薄尾
//              （8-bin：1.2/10/21/20.5/20.2/14.1/9.2/3.8%），可平铺，7 级 mip
//   flatnormal 16×16（官方 DXT5N）解码形态恒为 RGBA(255,127,0,127)——DXT5N 把
//              法线 x 存 alpha、y 存绿，shader 按 (a,g) 重建得 (0,0,+1) 平面法线，
//              即「法线参考」；alpha/green 被直接采样的效果也拿到与官方逐位一致的值
//   noflow     32×32 恒 RGBA(127,127,0,255)：(127,127) = 零向量、B=0 = 无流动
//   white/black 32×32 纯色（官方各带 4/5 级 mip，纯色下 generateMipmap 等价）
// 所有名字一律 REPEAT 环绕（官方 tex-json `clampuvs:false` / 缺省同值）：效果链
// 的 uv 随 g_Time 无界增长，CLAMP 会把采样拉成边缘一行（959417181 教训）。
// nomip 名单（flatnormal/fur/noflow/noise）走 LINEAR 无 mip 链，与官方一致；
// 带 mip 名字走 mip0 + generateMipmap（纯噪声/平滑场的 box 下采样与官方导出
// mip 在期望上一致）。
// 生成器全部确定性（固定种子）——本仓库以像素 diff 对账渲染回归，随机种子
// 不可漂移。

// 名单即注册顺序（scene-mount 按此遍历注册进 textures 表）
export const SYSTEM_UTIL_TEXTURES = [
  'util/white',
  'util/black',
  'util/noflow',
  'util/flatnormal',
  'util/noise',
  'util/perlin_256',
  'util/uniform_256',
  'util/fur',
  'util/clouds_256',
]

// nomip：官方 nomip:true / 单 mip。注册端据此选择 makeTexture（LINEAR 无 mip）
// 或 makeTextureMip（mip0 + generateMipmap）。
const NOMIP = new Set(['util/flatnormal', 'util/fur', 'util/noflow', 'util/noise'])

export function isNomipSystemTexture(name) {
  return NOMIP.has(name)
}

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


/** 周期值噪声单倍频：格点按 grid 取模，size % grid === 0 时无缝平铺。salt 区分通道/用途 */
function periodicValueNoise(size, grid, seed, salt) {
  const rng = mulberry32((seed ^ Math.imul(salt | 0, 0x9e3779b1)) >>> 0)
  const g = new Float32Array(grid * grid)
  for (let i = 0; i < g.length; i++) g[i] = rng()
  const out = new Float32Array(size * size)
  const cell = size / grid
  for (let y = 0; y < size; y++) {
    const fy = y / cell
    const iy = Math.floor(fy)
    const ty = fy - iy
    // 五次淡入淡出（C2 连续）：比 smoothstep 更接近 perlin 的二阶导连续性，
    // 倍频叠加后不出现格点棱线
    const sy = ty * ty * ty * (ty * (ty * 6 - 15) + 10)
    const y0 = (iy % grid) * grid
    const y1 = ((iy + 1) % grid) * grid
    for (let x = 0; x < size; x++) {
      const fx = x / cell
      const ix = Math.floor(fx)
      const tx = fx - ix
      const sx = tx * tx * tx * (tx * (tx * 6 - 15) + 10)
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

/** 多倍频叠加（可平铺）。amps = [[grid, amp], ...]；salt 区分通道 */
function fbm(size, amps, salt) {
  const acc = new Float32Array(size * size)
  let wsum = 0
  for (const [grid, amp] of amps) {
    const n = periodicValueNoise(size, grid, (grid * 0x9e3779b1) ^ 0x85ebca6b, salt)
    for (let i = 0; i < acc.length; i++) acc[i] += n[i] * amp
    wsum += amp
  }
  for (let i = 0; i < acc.length; i++) acc[i] /= wsum
  return acc
}

/** 线性 remap 到目标 (mean,sd)（像素值域 [0,255]），越界裁剪 */
function remapTo(field, mean, sd) {
  let s = 0
  let s2 = 0
  for (let i = 0; i < field.length; i++) {
    s += field[i]
    s2 += field[i] * field[i]
  }
  const n = field.length
  const m = s / n
  const d = Math.sqrt(Math.max(1e-9, s2 / n - m * m))
  const k = sd / d
  const out = new Uint8ClampedArray(n)
  for (let i = 0; i < n; i++) out[i] = mean + (field[i] - m) * k
  return out
}

function toRgba(channels, size) {
  // channels: [Uint8Array ×4]（灰度/掩码类传同一数组四份引用即可）
  const rgba = new Uint8Array(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    rgba[i * 4] = channels[0][i]
    rgba[i * 4 + 1] = channels[1][i]
    rgba[i * 4 + 2] = channels[2][i]
    rgba[i * 4 + 3] = channels[3][i]
  }
  return rgba
}

function solid(size, r, g, b, a) {
  const rgba = new Uint8Array(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    rgba[i * 4] = r
    rgba[i * 4 + 1] = g
    rgba[i * 4 + 2] = b
    rgba[i * 4 + 3] = a
  }
  return rgba
}


const cache = new Map()

function buildNoise() {
  const size = 256
  const rng = mulberry32(0x6e6f6973) // "nois"
  const rgba = new Uint8Array(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    rgba[i * 4] = rng() * 256
    rgba[i * 4 + 1] = rng() * 256
    rgba[i * 4 + 2] = rng() * 256
    rgba[i * 4 + 3] = rng() * 256
  }
  return { width: size, height: size, rgba }
}

function buildPerlin() {
  const size = 256
  // 特征波长≈64px：基网格 4（cell=64）为主 + 减半倍频。实测自相关 C(64)≈-0.15、
  // C(32)≈0.55 与基网格 4 + 倍频 8/16 的叠加谱一致。
  const amps = [
    [4, 0.55],
    [8, 0.27],
    [16, 0.13],
    [32, 0.05],
  ]
  // 各通道独立场（salt 区分）+ 官方实测 (mean,sd)。通道间均值有序
  // （ch0<ch1<ch2）是效果可依赖的特征（如 perlin 三通道当三个相位/阈值用）。
  const targets = [
    [94.8, 21.5, 1],
    [108.4, 26.2, 2],
    [145.2, 23.6, 3],
    [112.0, 32.0, 4],
  ]
  const channels = targets.map(([mean, sd, salt]) => remapTo(fbm(size, amps, salt), mean, sd))
  return toRgba(channels, size)
}

function buildUniform() {
  const size = 256
  const rng = mulberry32(0x756e6966) // "unif"
  const rgba = new Uint8Array(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    for (let c = 0; c < 4; c++) {
      // 实测：恰 ~50% 为 0，其余均匀铺满 [1,255]（均值 128.7）
      rgba[i * 4 + c] = rng() < 0.5 ? 0 : 1 + Math.floor(rng() * 254)
    }
  }
  return { width: size, height: size, rgba }
}

function buildFur() {
  const size = 128
  const rng = mulberry32(0x66757221) // "fur!"
  const rgba = new Uint8Array(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    // 实测：41.3% 为 0，其余均匀偏亮（均值≈155）
    const v = rng() < 0.413 ? 0 : Math.floor(21 + Math.pow(rng(), 0.62) * 234)
    rgba[i * 4] = v
    rgba[i * 4 + 1] = v
    rgba[i * 4 + 2] = v
    rgba[i * 4 + 3] = 255
  }
  return { width: size, height: size, rgba }
}

function buildClouds() {
  const size = 256
  const amps = [
    [4, 0.42],
    [8, 0.24],
    [16, 0.16],
    [32, 0.11],
    [64, 0.07],
  ]
  // 官方实测 mean=126 sd=52.7：线性 remap 后钳位的钟形直方图与官方 8-bin
  // 分布（薄尾、峰在 0.34~0.50）一致。salt=5：与 perlin 通道场区分开
  const gray = remapTo(fbm(size, amps, 5), 126, 52.7)
  const rgba = toRgba([gray, gray, gray, gray], size)
  return { width: size, height: size, rgba }
}

/**
 * 宿主素材覆盖：fn(name) → { width, height, rgba } | null。
 *
 * 本机装了 WE / Mirage 的原版素材时（`local-assets/mirage/materials/util/*.tex`，
 * 见 host/wallpaper-host.ts 的 /api/local-assets 与 docs/COMPLIANCE.md），由宿主
 * 解码后从这里注入，`buildSystemUtilTexture` 优先返回它 —— 观感与官方逐像素一致。
 * 返回 null 则继续走本模块的程序化复刻，所以**不装素材时行为一个字节不变**。
 * 与 particle-textures.js 的 setParticleTextureProvider 同一先例。
 */
let overrideProvider = null
export function setSystemTextureProvider(provider) {
  overrideProvider = typeof provider === 'function' ? provider : null
}

/**
 * 系统内置 util 贴图生成。任何情况下不为 null（名单内名字必有产出），
 * 名单外返回 null（调用方继续走 pkg / 其它来源）。
 * 返回 { width, height, rgba }；mip 行为由 isNomipSystemTexture 描述。
 */
export function buildSystemUtilTexture(name) {
  if (overrideProvider) {
    try {
      const t = overrideProvider(name)
      if (t && t.rgba) return t
    } catch {
      /* 覆盖失败不阻断：继续走下面的程序化复刻 */
    }
  }
  if (cache.has(name)) return cache.get(name)
  let t = null
  switch (name) {
    case 'util/white':
      t = { width: 32, height: 32, rgba: solid(32, 255, 255, 255, 255) }
      break
    case 'util/black':
      t = { width: 32, height: 32, rgba: solid(32, 0, 0, 0, 255) }
      break
    case 'util/noflow':
      // (127,127)=零向量、B=0=无流动。B 曾被误写成 127（=半强度流动）。
      t = { width: 32, height: 32, rgba: solid(32, 127, 127, 0, 255) }
      break
    case 'util/flatnormal':
      // 法线参考（官方 DXT5N 解码形态）：x 在 alpha=127、y 在 green=127、
      // b=0、r=255（DXT5N 的 color block 固定输出）。shader 按 (a,g) 重建
      // → (0,0,+1)。
      t = { width: 16, height: 16, rgba: solid(16, 255, 127, 0, 127) }
      break
    case 'util/noise':
      t = buildNoise()
      break
    case 'util/perlin_256':
      t = { width: 256, height: 256, rgba: buildPerlin() }
      break
    case 'util/uniform_256':
      t = buildUniform()
      break
    case 'util/fur':
      t = buildFur()
      break
    case 'util/clouds_256':
      t = buildClouds()
      break
  }
  if (t) cache.set(name, t)
  return t
}
