// 粒子系统纯工具（从 particles.js 拆出）：值/分布解析、音频门控、3D value-noise
// [we-scene patch] 这些与 GL / 实例状态完全无关，单独成模块便于离线复用
// （scripts/particle-raster.mjs 的 CPU 参考光栅器读同一套语义）。
const TAU = Math.PI * 2

function rand(a, b) {
  if (a === undefined || a === null) return Math.random()
  if (b === undefined || b === null) return a
  return a + Math.random() * (b - a)
}

// WE 的 exponent：把均匀随机偏向区间下端（exponent>1 时小值更常见）。
// sizerandom 常带 exponent:3 —— 少数大颗粒 + 大量小颗粒，是火花/尘埃的典型分布。
function randExp(a, b, exponent) {
  if (a === undefined || a === null) return Math.random()
  if (b === undefined || b === null) return a
  const t = exponent && exponent !== 1 ? Math.pow(Math.random(), exponent) : Math.random()
  return a + t * (b - a)
}

function parseVec(s, dflt) {
  if (Array.isArray(s)) return [s[0] || 0, s[1] || 0, s[2] || 0]
  if (s === undefined || s === null) return dflt ? dflt.slice() : [0, 0, 0]
  if (typeof s === 'object') return parseVec(s.value, dflt)
  if (typeof s === 'number') return [s, s, s]
  const p = String(s).trim().split(/\s+/).map(Number)
  return [p[0] || 0, p[1] || 0, p[2] || 0]
}

/**
 * 官方的 **VecRandom 字段**（min/max/exponent）解析语义 —— 与通用 `parseVec` 不同：
 * `sr::GetJsonValue(j, "max", std::array<float,3>&)`（Kernel/Json.cpp）：
 *   · JSON 标量 → **只填第一个分量，其余归零**（`item = first ? ConvertNumber(input) : Value{}`）；
 *   · JSON 数组 → 必须恰好 3 个，长度不符抛 WrongArraySize（= 读失败，保留调用方默认值）；
 *   · 字符串 → `ConvertArray` 同样要求恰好 3 段，否则抛；
 *   · null/缺键 → 读失败，保留调用方默认值。
 * parseVec 对标量做的是广播 `[s,s,s]`，用在 rotationrandom 上会把作者的
 * `rotationrandom: min -0.4, max -0.3`（本意是**绕 x 侧倾**）变成三轴一起转 ——
 * 1199910952 的光轴就是被这个画错的。返回 null = 读失败，调用方落自己的默认值。
 */
function parseRandomVec(s) {
  if (s === undefined || s === null) return null
  if (Array.isArray(s)) {
    if (s.length !== 3) return null
    const v = s.map(Number)
    return v.every(Number.isFinite) ? v : null
  }
  if (typeof s === 'object') return parseRandomVec(s.value)
  if (typeof s === 'number') return Number.isFinite(s) ? [s, 0, 0] : null
  const parts = String(s).trim().split(/\s+/)
  if (parts.length !== 3) return null
  const v = parts.map(Number)
  return v.every(Number.isFinite) ? v : null
}

// emitter 的 distancemin/max 既可能是标量（sphererandom 的半径）
// 也可能是向量（boxrandom 的半边长），统一成向量处理。
function parseDist(s) {
  if (s === undefined || s === null) return null
  if (typeof s === 'number') return [s, s, s]
  return parseVec(s)
}

function num(v, dflt) {
  if (v === undefined || v === null) return dflt
  if (typeof v === 'object') return num(v.value, dflt)
  const n = Number(v)
  return Number.isFinite(n) ? n : dflt
}

// WE 粒子音频处理的响应曲线：smoothstep(audioprocessingbounds) 门控（同 pulse.vert
// 的 CreateAudioResponse，对整体响度而非频段）。bounds 缺省 [0,1] 即线性响度。
function audioGate(bounds, level) {
  const lo = bounds[0]
  const hi = bounds[1] > lo ? bounds[1] : lo + 1e-6
  const k = Math.min(1, Math.max(0, (level - lo) / (hi - lo)))
  return k * k * (3 - 2 * k)
}


// ---------------------------------------------------------------------------
// hash3 的记忆化（噪声求值是这个渲染器最大的单点 CPU 开销）
//
// 为什么值得做：turbulence 算子每粒子每帧调 `noiseVec3(..., oct=3)`，展开是
// 3 次 fbm3 × 3 个倍频 × 8 个角点 = **72 次 hash3**，每次都是一条 Math.sin。
// 1039919954（两张 25000 maxcount 的烟带，各带一个 turbulence）实测：
//   每帧 hash3 调用 160 万次（240 帧 / 4s 计数），其中真算 sin 的只有 5.7 万次；
//   稳态 V8 剖面里 vnoise3 自时间 53%，改前 renderer 占满一核（96.8%）。
//   注：hash3 的在场景内成本约 10ns（由「调用数 ÷ renderer CPU 秒」反推），
//   脱离场景的 Node 微基准会高估到 40~55ns —— 独立函数调用没被内联。
//
// 为什么能cache：vnoise3 传给 hash3 的是**整数格点**（floor 之后的值），
// 同格点的结果按定义完全相同 —— 这是纯复用，不是近似，输出逐位不变。
// （等价性用真模块对拍过：120 万组随机整数格点 + 12 万组 vnoise3/fbm3/noiseVec3
//   开关记忆化逐位一致，含强制整表冲突的用例。）
//
// 为什么不是「每粒子缓存」：粒子池按 maxcount 预分配（本库最大 100000），
// 每粒子每算子要存 9 个 vnoise3 × 8 个角点 = 72 个 double，几十 MB 量级，不可行。
// 反过来，格点空间是**全局共享**的：同一帧里成千上万个粒子反复落在同一批格点上
// （turbulence 的 scale 小到 0.0053，x/y 格点只有十几个取值），所以用一张
// 全进程共享的直接映射表就够了，命中率实测 96.2%，且零每粒子内存。
//
// 表结构：直接映射（槽 = 三元素哈希 & MASK），冲突即覆盖。不做链表/淘汰 ——
// 噪声的工作集小且访问有强局部性，覆盖式命中的代价只是重算一次 sin。
// 收益（同会话交替 A/B，1039919954，3 轮）：renderer 96.8% → 71.0%（-26.7% 相对），
// 全进程树 -25 个百分点，fps 不变。
const NM_BITS = 13
const NM_SIZE = 1 << NM_BITS
const NM_MASK = NM_SIZE - 1
const nmTag = new Float64Array(NM_SIZE * 3)
const nmVal = new Float64Array(NM_SIZE)
// 出厂即 NaN：整数值永远不会等于 NaN，于是「未命中」不需要额外的有效位数组
nmTag.fill(NaN)
// 测试钩子（都只在首次调用时解析一次，稳态零开销）：
//   __noiseMemoOff   = true → 关掉记忆化（A/B 基线用）
//   __noiseMemoCount = true → 统计命中/未命中。**默认关**：热路径上是 160 万次/帧，
//                            计数据的自增本身就会吃掉几个百分点，只在诊断时开。
let nmOff = false
let nmCount = false
let nmProbed = false
let nmHits = 0
let nmMisses = 0
// 单元格缓存的计数（同一开关 nmCount；默认关 —— 热路径上别留自增）
let ncHits = 0
let ncMisses = 0
/** 命中率是判断「这张壁纸值不值得走记忆化」的唯一依据（需先开 __noiseMemoCount） */
export function noiseMemoStats() {
  return {
    hits: nmHits,
    misses: nmMisses,
    size: NM_SIZE,
    off: nmOff,
    counting: nmCount,
    cellOff: ncOff,
    cellSize: NC_SIZE,
    // 单元格缓存命中率才是「还有没有复用空间」的判据：
    //   · 命中率高 → 省下的是查表，成本在未命中的 hash3 上（sin）；
    //   · 命中率低 → 复用本来就不存在，只剩「少算几次噪声」这种改语义的路。
    cellHits: ncHits,
    cellMisses: ncMisses,
  }
}
// 页面级诊断钩子
globalThis.__noiseMemoStats = noiseMemoStats

function hash3(x, y, z) {
  if (!nmProbed) {
    nmProbed = true
    nmOff = globalThis.__noiseMemoOff === true
    nmCount = globalThis.__noiseMemoCount === true
    ncOff = globalThis.__noiseCellOff === true
  }
  if (nmOff) {
    const n0 = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453
    return n0 - Math.floor(n0)
  }
  // 三元素混合哈希：位运算会把参数按 ToInt32 截断，对大值只丢高位 —— 只当槽号用，
  // 命中判定靠下面的整值比对，所以截断不影响正确性。
  const slot = ((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) & NM_MASK
  const t = slot * 3
  if (nmTag[t] === x && nmTag[t + 1] === y && nmTag[t + 2] === z) {
    if (nmCount) nmHits++
    return nmVal[slot]
  }
  if (nmCount) nmMisses++
  const n = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453
  const v = n - Math.floor(n)
  nmTag[t] = x
  nmTag[t + 1] = y
  nmTag[t + 2] = z
  nmVal[slot] = v
  return v
}
// 单元格角点缓存（2026-10-01）。
//
// 动因是实测：重粒子场景（3262691944，19 个粒子系统）稳态热点里 hash3 占 **67.1%**、
// vnoise3 8.1%，而 updateParticle 只有 4% —— 瓶颈不在每粒子的分配/算子求值，
// 而在噪声本身（profile 见 docs/ENGINE-REVIEW-2026-10.md §11）。
//
// 一次 vnoise3 要取三线性插值的 **8 个角点**，每个角点都是一次「哈希 + 三次整值比对 + 数组读」。
// 但角点只由**整数格点**决定，与小数偏移无关 —— 所以可以按单元格缓存这 8 个值，
// 把 8 次查表压成 1 次（命中时只是 8 个连续 double 的读取）。
//
// 与原实现**逐位等价**：存的就是 hash3 的返回值，插值顺序与权重公式一字未改
// （见 verify-particles 的对拍 + 下面的 nmCellOff A/B 开关）。
// 表大小实测过：4096 → 16384 只多 0.5fps（29.5 → 30.0，同会话交替两轮一致），说明命中率
// 受**结构**限制而非表大小 —— 噪声的 z 轴常带时间（particles.js「turbulence」用
// `t + p.seed*phaseMax`），x/y 随粒子位置散开，所以单元格天然只有部分复用。
// +1.7% 换 4 倍内存（1.4MB）不划算，保持 4096（tag+值 ≈ 360KB）。
const NC_BITS = 12
const NC_SIZE = 1 << NC_BITS
const NC_MASK = NC_SIZE - 1
const ncTag = new Float64Array(NC_SIZE * 3)
const ncVal = new Float64Array(NC_SIZE * 8)
ncTag.fill(NaN)
// A/B 开关（只关单元格缓存、保留 hash3 记忆化）：__noiseCellOff = true
let ncOff = false
/** 角点顺序与下面的插值一一对应：(0,0,0)(1,0,0)(0,1,0)(1,1,0)(0,0,1)(1,0,1)(0,1,1)(1,1,1) */
function cellSlot(ix, iy, iz) {
  const slot = ((ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791)) & NC_MASK
  const t = slot * 3
  if (ncTag[t] === ix && ncTag[t + 1] === iy && ncTag[t + 2] === iz) {
    if (nmCount) ncHits++
    return slot
  }
  if (nmCount) ncMisses++
  ncTag[t] = ix
  ncTag[t + 1] = iy
  ncTag[t + 2] = iz
  const v = slot * 8
  ncVal[v] = hash3(ix, iy, iz)
  ncVal[v + 1] = hash3(ix + 1, iy, iz)
  ncVal[v + 2] = hash3(ix, iy + 1, iz)
  ncVal[v + 3] = hash3(ix + 1, iy + 1, iz)
  ncVal[v + 4] = hash3(ix, iy, iz + 1)
  ncVal[v + 5] = hash3(ix + 1, iy, iz + 1)
  ncVal[v + 6] = hash3(ix, iy + 1, iz + 1)
  ncVal[v + 7] = hash3(ix + 1, iy + 1, iz + 1)
  return slot
}
// 提到模块级：原来每次 vnoise3 都要新建这个闭包（正是本轮本想优化的那类分配）
function lerp3(a, b, t) {
  return a + (b - a) * t
}
function vnoise3(x, y, z) {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const iz = Math.floor(z)
  const fx = x - ix
  const fy = y - iy
  const fz = z - iz
  const sx = fx * fx * (3 - 2 * fx)
  const sy = fy * fy * (3 - 2 * fy)
  const sz = fz * fz * (3 - 2 * fz)
  let c00
  let c10
  let c01
  let c11
  if (ncOff) {
    c00 = lerp3(hash3(ix, iy, iz), hash3(ix + 1, iy, iz), sx)
    c10 = lerp3(hash3(ix, iy + 1, iz), hash3(ix + 1, iy + 1, iz), sx)
    c01 = lerp3(hash3(ix, iy, iz + 1), hash3(ix + 1, iy, iz + 1), sx)
    c11 = lerp3(hash3(ix, iy + 1, iz + 1), hash3(ix + 1, iy + 1, iz + 1), sx)
  } else {
    const v = cellSlot(ix, iy, iz) * 8
    c00 = lerp3(ncVal[v], ncVal[v + 1], sx)
    c10 = lerp3(ncVal[v + 2], ncVal[v + 3], sx)
    c01 = lerp3(ncVal[v + 4], ncVal[v + 5], sx)
    c11 = lerp3(ncVal[v + 6], ncVal[v + 7], sx)
  }
  return lerp3(lerp3(c00, c10, sy), lerp3(c01, c11, sy), sz)
}
function fbm3(x, y, z, oct) {
  let v = 0
  let amp = 0.5
  let f = 1
  let norm = 0
  for (let i = 0; i < oct; i++) {
    v += amp * vnoise3(x * f, y * f, z * f)
    norm += amp
    amp *= 0.5
    f *= 2
  }
  return v / (norm || 1)
}
// 返回 -1..1 的三维噪声向量（各分量取不同偏移，互不相关）
function noiseVec3(x, y, z, oct) {
  return [
    fbm3(x, y, z, oct) * 2 - 1,
    fbm3(x + 31.7, y + 11.3, z + 57.1, oct) * 2 - 1,
    fbm3(x + 73.9, y + 92.1, z + 13.7, oct) * 2 - 1,
  ]
}


export { TAU, rand, randExp, parseVec, parseRandomVec, parseDist, num, audioGate, hash3, vnoise3, fbm3, noiseVec3 }
