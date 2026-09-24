// [we-scene patch] 音频频谱源。
// 没有真实系统音频 / 宿主注入时，频谱恒为零（音条静止、vumeter 归零），
// 壁纸显示作者烘焙的占位外观 —— 不再合成仿音乐的模拟波形。
const BANDS = 64

function zero(n) { return new Float32Array(n) }

// audioResponse 的门控曲线（WE shader 侧 smoothstep 的 CPU 镜像）
function smoothstep(e0, e1, x) {
  const k = Math.min(1, Math.max(0, (x - e0) / ((e1 - e0) || 1)))
  return k * k * (3 - 2 * k)
}

const SILENT_SNAPSHOT = {
  left64: zero(64), right64: zero(64),
  left32: zero(32), right32: zero(32),
  left16: zero(16), right16: zero(16),
  preL64: zero(64), preR64: zero(64),
  level: 0,
  silent: true,
}

/**
 * 无真实音频时的静默频谱驱动。保留 createSimulatedAudio 名字（调用点不变），
 * update 不产生任何波形；真实音频请经宿主 audioBridge / live mic 接入。
 */
export function createSimulatedAudio(seed = 20260830) {
  return {
    snapshot: SILENT_SNAPSHOT,
    bands: BANDS,
    update(_t) { return SILENT_SNAPSHOT },
  }
}


/**
 * 把 64 band 快照降采样填进文字脚本的音频视图（engine.registerAudioBuffers 返回值）。
 * views: Map<n, {left, right, average}>（text.js 沙箱按 n 惰性创建，宿主每帧重填）。
 * 16/32 视图按相邻 band 均值合并；average = (L+R)/2（WE 脚本语料只读 average/left）。
 */
export function fillAudioBuffers(views, snapshot) {
  for (const v of views.values()) {
    fillOne(v.left, snapshot.left64)
    fillOne(v.right, snapshot.right64)
    for (let i = 0; i < v.average.length; i++) {
      v.average[i] = (v.left[i] + v.right[i]) * 0.5
    }
  }
}

function fillOne(dst, src64) {
  const g = src64.length / dst.length
  for (let i = 0; i < dst.length; i++) {
    let s = 0
    const i0 = Math.floor(i * g)
    const i1 = Math.max(i0 + 1, Math.floor((i + 1) * g))
    for (let j = i0; j < i1; j++) s += src64[j]
    dst[i] = s / (i1 - i0)
  }
}

/**
 * WE shader 侧 CreateAudioResponse 的 CPU 镜像（pulse.vert 逐字翻译）：
 * 频段 [min,max] 平均 → smoothstep(bounds) → pow(exponent) × amount。
 * 供粒子 audioprocessing / 脚本 / 离线校验使用；mode: 0=关 1=左 2=右 3=双声道平均。
 */
export function audioResponse(
  bands,
  mode,
  freqMin,
  freqMax,
  bounds,
  power,
  amount,
) {
  if (!mode) return 0
  const maxBand = bands.left.length - 1
  const lo = Math.max(0, Math.min(maxBand, Math.round(freqMin)))
  const hi = Math.max(lo, Math.min(maxBand, Math.round(freqMax)))
  let sum = 0
  let n = 0
  for (let a = lo; a <= hi; a++) {
    if (mode === 1) sum += bands.left[a]
    else if (mode === 2) sum += bands.right[a]
    else sum += (bands.left[a] + bands.right[a]) * 0.5
    n++
  }
  let v = n > 0 ? sum / n : 0
  v = smoothstep(bounds[0], bounds[1], v)
  v = Math.min(1, Math.max(0, Math.pow(v, power))) * amount
  return v
}
