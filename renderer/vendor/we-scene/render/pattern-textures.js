// [we-scene patch] WE 内置纹样贴图（materials/pattern/*）的程序化复刻。
//
// ## 为什么需要
// 官方 `materials/pattern/voronoi` 与 `materials/pattern/voronoi_local` 是两张
// 256×256 灰度 Voronoi 图，**不在壁纸 pkg 里**（WE 安装目录自带的公共素材）。
// 全库唯一消费方是效果 `watercaustics`：`shaders/effects/caustics.frag` 的
// 槽 2 默认 `pattern/voronoi_local`（主焦散纹样，.r 采 3 次做色散）、槽 5 默认
// `pattern/voronoi`（辉光样本，.r）。缺它两槽落 whiteTex（1×1 白）→ 焦散整层
// 变成纯色乘 u_brightness，画面的「水波光斑」完全消失（docs/ASSET-AUDIT.md §2
// pattern 行 + §6 缺口第 1 条，唯一的直接贴图缺口）。
//
// ## 合规（docs/COMPLIANCE.md 红线「解包产物不入库」）
// 本文件**零内嵌官方字节**：两张图都是按官方**统计锚点**重新生成的——
//   - 几何：32 个种子按固定 PRNG **重新随机**（Mitchell best-candidate，见下），
//     坐标与官方实测种子表无关（两者最小间距 ≥9px，官方表只作为实测记录留在
//     docs/replication/pattern-voronoi.spec.md §2.3）；
//   - 公式：`voronoi` = 3.0×环绕 F1（官方逐像素实测 corr 0.9994 的线性关系）；
//     `voronoi_local` 的脊线公式为 [推断]（规格 §2.2 明示「按锚点对齐而非死抠
//     公式」），常量在**官方种子几何**上对官方图标定（该口径 corr≈0.94/RMSE≈18，
//     规格里同族不带 L 调制的公式 corr 只有 0.825）；
//   - 落盘检查：生成结果与官方图**逐像素不同且像素级无关**（独立随机几何，对官方
//     图 corr≈0.04）——出厂只对齐统计锚点。若哪天 corr 显著升高，说明种子被
//     搬运了官方坐标，那是合规红线。
//
// ## 官方实测锚点（规格 §1/§2/§5，此处为复刻输出的对账基线）
//   容器    256×256、RGBA8888（纯灰度 R=G=B、alpha 全 255）、flags bit1=0 →
//           **REPEAT**（sidecar `clampuvs:false`）、双线性 + 7 级 mip（256→4）。
//   voronoi 值域 0..161、mean 61.84、sd 29.45、水平梯度 max 3 灰阶；
//           径向剖面按 F1 分桶严格线性（3.0 灰阶/px）。
//   local   黑底脊线网络：≤9 占 56.5%、>64/>128/>200 = 24.1/9.1/0.62%、
//           mean 35.52、sd 52.49、脊线 run>128 中位 4px、>200 热点 37 簇。
//   共性    **环绕（toroidal）语义**：种子按 256 周期平铺，图像天然无缝——
//           官方场本身就是周期化的（规格 §2「周期性」：环绕 F1 corr 0.9994、
//           边缘带零违例；非环绕对照只有 0.8679）。消费方 uv 随 g_Time 无界漂移
//           （caustics.frag 四路噪声坐标每秒 0.005/0.004111/0.003777/0.01），
//           REPEAT + 无缝是硬需求。
//
// ## 生成模型（两张图共用一套几何，规格 §2.3）
//   1. 32 个种子：`mulberry32(SEED)` + Mitchell best-candidate（每步撒 2 个候选、
//      取离已有种子最远者，环绕距离）。官方种子分布近似均匀随机但比泊松更均匀
//      （实测 NN min/median/max = 10.6/24.7/57.0px，泊松中位约 21px），
//      best-candidate k=2 的分布正好落在这一档（24 次抽样的 meanF1 90% 区间
//      57.6..62.5 灰阶×3，官方 61.84）。
//   2. 每像素取环绕 F1/F2/F3（第 1/2/3 近种子距离）与连续 Lc（所处胞边长度的
//      软加权期望）：
//        voronoi       = round(3.0 × F1)                     （clamp 255）
//        voronoi_local = clamp(round(255 × (脊 + 结点)), 0, 255)
//          脊   = 0.8 · (1 − e^(−Lc/40)) · (1 − clamp(d2 / (2.5 + 0.2·Lc)))^1.25
//          结点 = 0.3 · (1 − clamp(d3 / 8))
//        其中 d2 = F2 − F1（到胞边界的 2 倍距离）、d3 = F3 − F1（到三胞结点的
//        度量）。脊线的 Lc 调制来自官方图实测（2026-09-23 按「两近邻种子对 L、
//        贴边 d2<1」条件分桶）：桶均值 L∈[0,16)/[16,32)/[32,48)/[48,64)/[64,96)
//        = 51/94/134/152/182 灰阶，恰为 255×0.8×(1−e^(−L/40)) 的轨迹（53/92/
//        129/154/181）——短边脊线暗、长边脊线亮。**Lc 必须连续**：直接取「最近
//        两种子对」的几何 L 会在 Voronoi 顶点随第二近种子切换而跳变，峰值被打成
//        硬边（gradMax 132 vs 官方 43）；Lc 用全边软加权期望连续化后 gradMax 45。
//        其余定性特征：脊宽随 L 线性变宽、胞内深黑、三胞结点最亮（官方全部
//        405 个 >200 像素满足 d3 < 4.81px）。
//   3. mip：只出 mip0，由注册端 `makeTextureMip` 走 generateMipmap（官方 7 级
//      链的均值 61.8→59.8，标准降采样可达，与 local-assets.ts 的同名策略一致）。
//
// ## 实现约定（对齐 gradient-textures.js / system-textures.js / particle-textures.js）
//   - **零 import、零 Math.random**：生成器纯算术，Node 离线校验（verify-textures）
//     与浏览器渲染逐像素一致；
//   - 返回 { width, height, rgba: Uint8Array }，直接喂 makeTextureMip；
//   - 确定性：固定 PRNG 常量，换常量才会换一整套种子坐标（像素 diff 不可漂移）；
//   - 生成耗时 ~30ms（32 种子 × 65536 像素，环绕距离用分量取模而非九邻域展开）。

const SIZE = 256
const SEED_COUNT = 32
/** 固定 PRNG 常量。换它会换一整套种子坐标（回归对账的像素 diff 随之漂移）。 */
const SEED = 1310

// 生成参数（含义见文件头「生成模型」；常量由官方图统计拟合 + 锚点标定）
const F1_SCALE = 3.0 // voronoi = F1_SCALE × 环绕 F1（官方拟合 3.006·F1 − 0.06）
const RIDGE_PEAK = 0.8 // 脊线峰值 = 255 × RIDGE_PEAK × (1 − e^(−L/L0))
const RIDGE_L0 = 40 // 峰值随胞边长度的饱和尺度（px）
const RIDGE_W0 = 2.5 // 脊线半宽基数（px）
const RIDGE_W1 = 0.2 // 脊线半宽随 L 的斜率
const RIDGE_P = 1.25 // 脊线剖面幂（1 = 线性）
const NODE_AMP = 0.3 // 三胞结点辉光幅度（×255）
const NODE_W = 8 // 结点辉光半径：d3 = F3 − F1 到 8px 衰减到 0

// 连续胞边长度 Lc 的软权重参数（含义见 fields() 注释）。
const LC_Q = 3 // 到边平分面的高斯尺度（px）：横向只取附近的边
const LC_M = 16 // 沿边方向的高斯尺度（px）：只取点确实在两胞之间的边
const LC_G = 0.3 // 被第三种子接管时的衰减率
const LC_FALLBACK = 24 // 无任何边权重（理论不发生）时的缺省胞边长度

/** 固定种子 PRNG（与 system-textures.js / particle-textures.js / noise.js 同款）。 */
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

/** 分量取模到 [−SIZE/2, SIZE/2)：环绕（toroidal）距离的最简写法。 */
function wrap(d) {
  return d - SIZE * Math.round(d / SIZE)
}

/**
 * Mitchell best-candidate 布点：每步撒 `candidates` 个候选、取「离已有种子最远」
 * 的那个（环绕度量）。k=2 的分布贴近官方实测（见文件头第 1 条）。
 */
function placeSeeds(candidates, rng) {
  const pts = [[rng() * SIZE, rng() * SIZE]]
  while (pts.length < SEED_COUNT) {
    let best = null
    let bestD = -1
    for (let c = 0; c < candidates; c++) {
      const px = rng() * SIZE
      const py = rng() * SIZE
      let d = Infinity
      for (let i = 0; i < pts.length; i++) {
        const dx = wrap(px - pts[i][0])
        const dy = wrap(py - pts[i][1])
        const dd = dx * dx + dy * dy
        if (dd < d) d = dd
      }
      if (d > bestD) {
        bestD = d
        best = [px, py]
      }
    }
    pts.push(best)
  }
  return pts
}

let seedsCache = null
/** 本模块的 32 个种子（确定性；导出供校验/对账，不参与渲染路径）。 */
export function patternSeeds() {
  if (!seedsCache) seedsCache = placeSeeds(2, mulberry32(SEED))
  return seedsCache.map((p) => [p[0], p[1]])
}

/**
 * 逐像素的环绕 Voronoi 场：F1/F2/F3（第 1/2/3 近种子距离，px）与
 * Lc（该点所处胞边长度的**连续**期望，px —— 脊线峰值/宽度的来源）。
 *
 * 为什么不直接取「最近两种子对」的几何间距 L：L 依赖种子身份，在 Voronoi 顶点附近
 * 随第二近种子切换而**不连续**，而峰值又正比于 L —— 出厂图在切换点产生大跳变
 * （实测水平 gradMax 132，官方仅 43），脊峰被打散成两倍多的小簇。F1/F2/F3 作为
 * 位置函数是连续的（两种子等距换序时 F2 不变），但 L 不是。
 * 故把 L 换成连续代理：对所有种子对，按「点到该边平分面距离 q、沿边方向距离 m、
 * 是否被第三种子接管」软加权，求该边几何长度的加权平均 Lc（权重在远离该边时严格
 * 趋零）。Lc 全程连续，峰值随之平滑；出厂图 gradMax 降到 45（≈官方 43）、
 * RMSE 14.2。
 */
function fields() {
  const seeds = patternSeeds()
  const n = SIZE * SIZE
  const F1 = new Float32Array(n)
  const F2 = new Float32Array(n)
  const F3 = new Float32Array(n)
  // 种子对（含环绕几何长度 L_jk）
  const pairs = []
  for (let j = 0; j < seeds.length; j++) for (let k = j + 1; k < seeds.length; k++) {
    const lx = wrap(seeds[j][0] - seeds[k][0])
    const ly = wrap(seeds[j][1] - seeds[k][1])
    pairs.push({ j, k, L: Math.sqrt(lx * lx + ly * ly) })
  }
  const Lc = new Float32Array(n)
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      // 到全部种子的环绕距离
      const dist = new Float32Array(seeds.length)
      for (let s = 0; s < seeds.length; s++) {
        const dx = wrap(x - seeds[s][0])
        const dy = wrap(y - seeds[s][1])
        dist[s] = Math.sqrt(dx * dx + dy * dy)
      }
      // 排序取 F1/F2/F3
      const sorted = Array.from(dist).sort((a, b) => a - b)
      let a = Infinity
      let b = Infinity
      let c = Infinity
      // F1/F2/F3 直接来自 sorted（连续）
      F1[y * SIZE + x] = sorted[0]
      F2[y * SIZE + x] = sorted[1]
      F3[y * SIZE + x] = sorted[2]
      // 连续胞边长度 Lc：对所有种子对软加权
      let num = 0
      let den = 0
      for (const { j, k, L } of pairs) {
        const dj = dist[j]
        const dk = dist[k]
        const q = Math.abs(dj - dk) / 2 // 到平分面距离
        const m = (dj + dk) / 2 // 沿边方向离种子距离
        // 其余（非 j,k）最近种子距离：被第三种子接管则衰减该边
        let dN = Infinity
        for (let s = 0; s < seeds.length; s++) if (s !== j && s !== k && dist[s] < dN) dN = dist[s]
        const w =
          Math.exp(-(q * q) / (2 * LC_Q * LC_Q)) *
          Math.exp(-(m * m) / (2 * LC_M * LC_M)) *
          Math.exp(-Math.max(0, m - dN) * LC_G)
        num += L * w
        den += w
      }
      Lc[y * SIZE + x] = den > 1e-6 ? num / den : LC_FALLBACK
    }
  }
  return { F1, F2, F3, L: Lc }
}

let fieldCache = null
function getFields() {
  if (!fieldCache) fieldCache = fields()
  return fieldCache
}

function toRgba(gray) {
  const rgba = new Uint8Array(SIZE * SIZE * 4)
  for (let i = 0; i < gray.length; i++) {
    const v = gray[i]
    const o = i * 4
    rgba[o] = v
    rgba[o + 1] = v
    rgba[o + 2] = v
    rgba[o + 3] = 255
  }
  return { width: SIZE, height: SIZE, rgba }
}

/** pattern/voronoi：线性 F1 距离场（v = round(3.0 × 环绕 F1)）。 */
function buildVoronoi() {
  const { F1 } = getFields()
  const gray = new Uint8Array(SIZE * SIZE)
  for (let i = 0; i < gray.length; i++) {
    const v = Math.round(F1_SCALE * F1[i])
    gray[i] = v > 255 ? 255 : v
  }
  return toRgba(gray)
}

/** pattern/voronoi_local：胞边界脊线网络（峰随 L 饱和 + 三胞结点辉光）。 */
function buildVoronoiLocal() {
  const { F1, F2, F3, L } = getFields()
  const gray = new Uint8Array(SIZE * SIZE)
  for (let i = 0; i < gray.length; i++) {
    const length = L[i]
    const d2 = F2[i] - F1[i]
    const d3 = F3[i] - F1[i]
    const peak = RIDGE_PEAK * (1 - Math.exp(-length / RIDGE_L0))
    const w = RIDGE_W0 + RIDGE_W1 * length
    const u = d2 / w
    const ridge = u >= 1 ? 0 : peak * Math.pow(1 - u, RIDGE_P)
    const un = d3 / NODE_W
    const node = un >= 1 ? 0 : NODE_AMP * (1 - un)
    let v = Math.round(255 * (ridge + node))
    if (v > 255) v = 255
    gray[i] = v
  }
  return toRgba(gray)
}

// 登记表即名字 → 生成器。名字与官方 materials/pattern/ 下的文件名一一对应。
const BUILDERS = {
  'pattern/voronoi': buildVoronoi,
  'pattern/voronoi_local': buildVoronoiLocal,
}

const cache = new Map()
// 本机有原版素材时的覆盖接口（local-assets.ts 注入，与 sysTex/ptex/gtex 同构）：
// 命中即直接返回官方像素，程序化产物只是没有素材时的兜底。
let overrideProvider = null

/** 兜底接管：返回 {width,height,rgba} 或 null（null 则继续走内置生成器）。 */
export function setPatternTextureProvider(provider) {
  overrideProvider = typeof provider === 'function' ? provider : null
}

/** 登记表全部键名（校验枚举用）。 */
export function listBuiltinPatternTextureNames() {
  return Object.keys(BUILDERS)
}

export function isBuiltinPatternTextureName(name) {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(BUILDERS, name)
}

/**
 * 程序化生成一张内置纹样贴图。返回 { width, height, rgba }；未登记的名字返回
 * null（调用方继续走 pkg / 其它来源）。命中覆盖 provider 时直接给官方像素。
 *
 * 环绕 **一律 REPEAT**：官方 .tex flags bit1 = 0（sidecar `clampuvs:false`），
 * 而且消费方 uv 随 g_Time 无界漂移 —— CLAMP 会把整片采样拉成边缘一行。
 * 注册端因此必须 `makeTextureMip(gl, [t], false, { wrap: 'repeat' })`。
 */
export function buildBuiltinPatternTexture(name) {
  if (!isBuiltinPatternTextureName(name)) return null
  const cached = cache.get(name)
  if (cached) return cached
  if (overrideProvider) {
    try {
      const t = overrideProvider(name)
      if (t && t.rgba) {
        cache.set(name, t)
        return t
      }
    } catch {
      /* 覆盖失败不阻断：继续走下面的程序化复刻 */
    }
  }
  const t = BUILDERS[name]()
  cache.set(name, t)
  return t
}
