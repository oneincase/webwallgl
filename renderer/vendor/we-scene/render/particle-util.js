// 粒子系统纯工具（从 particles.js 拆出）：值/分布解析、音频门控、3D value-noise
//
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

// ---------- 噪声（turbulence / turbulentvelocityrandom / remapvalue） ----------

function hash3(x, y, z) {
  const n = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453
  return n - Math.floor(n)
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
  const l = (a, b, t) => a + (b - a) * t
  const c00 = l(hash3(ix, iy, iz), hash3(ix + 1, iy, iz), sx)
  const c10 = l(hash3(ix, iy + 1, iz), hash3(ix + 1, iy + 1, iz), sx)
  const c01 = l(hash3(ix, iy, iz + 1), hash3(ix + 1, iy, iz + 1), sx)
  const c11 = l(hash3(ix, iy + 1, iz + 1), hash3(ix + 1, iy + 1, iz + 1), sx)
  return l(l(c00, c10, sy), l(c01, c11, sy), sz)
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

// ---------- 粒子 ----------

export { TAU, rand, randExp, parseVec, parseDist, num, audioGate, hash3, vnoise3, fbm3, noiseVec3 }
