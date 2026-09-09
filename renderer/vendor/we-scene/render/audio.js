// [we-scene patch] WE 音频可视化的模拟音频源
//
// WE 引擎把系统音频做成三组频谱喂给渲染端（见 shaders/effects/pulse.vert 与
// workshop 音频效果的实测语料）：
//
//   uniform float g_AudioSpectrum16Left[16];  / g_AudioSpectrum16Right[16];
//   uniform float g_AudioSpectrum32Left[32];  / g_AudioSpectrum32Right[32];
//   uniform float g_AudioSpectrum64Left[64];  / g_AudioSpectrum64Right[64];
//
// 取值约 0..1（pulse.vert 的 CreateAudioResponse 直接 smoothstep(bounds, 值)）。
// 文字脚本侧对应 engine.registerAudioBuffers(n) → { left, right, average } 数组。
// 独立测试台没有系统音频（/audio-stream SSE 未复刻），本模块**按时间确定性合成**
// 一段仿音乐的频谱流：底鼓/军鼓节奏、中频和弦、高频踩镲、段间静音。
// 纯时间驱动（无累积状态、无随机数漂移），node 离线校验与浏览器逐帧驱动走同一路径。
//
// project.json 的 general.supportsaudioprocessing === false 时宿主应喂静音
// （WE 语义：作者声明壁纸不响应音频；实测本机库 3 个 false 壁纸也无任何音频引用）。

// mulberry32：小而快的确定性 PRNG（只用于生成段落/音型的固定图案，不随帧漂移）
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

function smoothstep(e0, e1, x) {
  const k = Math.min(1, Math.max(0, (x - e0) / ((e1 - e0) || 1)))
  return k * k * (3 - 2 * k)
}

// 简易可重复的价值噪声：输入连续相位，输出 -1..1 的平滑游走
function vnoise(x, seedIdx) {
  const i = Math.floor(x)
  const f = x - i
  const h = (n) => {
    const s = Math.sin((n * 127.1 + seedIdx * 311.7) * 43758.5453) * 43758.5453
    return (s - Math.floor(s)) * 2 - 1
  }
  const u = f * f * (3 - 2 * f)
  return h(i) * (1 - u) + h(i + 1) * u
}

// 64 band 的音乐频谱仿真。段结构（32s 循环）：
//   0–24s   正常播放（4/4 底鼓 + 反拍军鼓/踩镲 + 中频和弦游走）
//   24–27s  breakdown（只有中频弱动，鼓停）
//   27–29s  静音（真实歌曲间隙；可视化应整条落下）
//   29–32s  build-up（能量指数回升，末拍全频段爆发后回卷）
const SECTION_LEN = 32
const BPM = 112
const BEAT = 60 / BPM
// 全局增益：WE 的频谱值是「音乐播放时的观感」——底鼓打点逼近 1、中频 0.3~0.6，
// 可视化条/示波器才有肉眼可见的起伏。合成分量偏保守，按最终值整体放大（钳位 1）。
// 实机标定：3078285611 的示波器波形幅度 ∝ 频段值，GAIN=2.2 时只有贴地微颤，
// 3.2 起波形明显拉开（示波器/音频条类效果的作者预期就是「音乐一响就大幅摆动」）。
const GAIN = 3.2

// 固定音型（pattern）：每 16 分音符的鼓点强度（0=无），由种子生成一次
function makePatterns(rand) {
  const kick = new Float32Array(16)
  const snare = new Float32Array(16)
  const hat = new Float32Array(16)
  for (let i = 0; i < 16; i++) {
    // 四分力度重、反拍轻；随机略去个别反拍避免机械感
    kick[i] = i % 4 === 0 ? 1 : i % 4 === 2 ? 0.38 + rand() * 0.15 : rand() < 0.08 ? 0.5 : 0
    snare[i] = i % 8 === 4 ? 1 : rand() < 0.06 ? 0.6 : 0
    hat[i] = i % 2 === 1 ? 0.5 + rand() * 0.4 : i % 4 === 0 ? 0.25 : rand() < 0.3 ? 0.3 : 0
  }
  return { kick, snare, hat }
}

export function createSimulatedAudio(seed = 20260830) {
  const rand = mulberry32(seed)
  const patterns = makePatterns(rand)
  // 中频和弦的慢游走相位（每 band 一条）
  const phases = new Float32Array(64)
  for (let i = 0; i < 64; i++) phases[i] = rand() * 64

  const BANDS = 64
  const rawL = new Float32Array(BANDS) // 包络后的 64 band
  const rawR = new Float32Array(BANDS)
  // 未钳位（pre-GAIN）频谱，供网页驱动做 gamma 对比扩展
  const preL64 = new Float32Array(BANDS)
  const preR64 = new Float32Array(BANDS)
  // 输出快照（降采样视图共享 base band 的数据）
  const left64 = new Float32Array(BANDS)
  const right64 = new Float32Array(BANDS)
  const left32 = new Float32Array(32)
  const right32 = new Float32Array(32)
  const left16 = new Float32Array(16)
  const right16 = new Float32Array(16)
  const snapshot = {
    left64, right64, left32, right32, left16, right16,
    /**
     * 未钳位（pre-GAIN、pre-clamp）的 64 band，含左右声道 pan。
     * left64/right64 是 `min(1, v*GAIN)` 之后的值：底鼓段基底就已到 ~0.6、峰值贴 1，
     * 波峰因数被压平——网页作者按「峰值过阈值」判定敲击时（1520828134 猫爪
     * `audioArray[i] > 0.5`），事后再乘任何标量都无法把基底与峰值分开。
     * 网页驱动改对本数组做 gamma 对比扩展，音条墙仍走已标定的 left64/right64。
     */
    preL64, preR64,
    /** vumeter：整体响度 0..1（粒子 audioprocessing / 文字脚本 average 用） */
    level: 0,
    /** 渲染器诊断：当前是否处于「静音段」 */
    silent: false,
  }

  function downsample(dst, src) {
    const g = src.length / dst.length
    for (let i = 0; i < dst.length; i++) {
      let s = 0
      const i0 = Math.floor(i * g)
      const i1 = Math.floor((i + 1) * g)
      for (let j = i0; j < Math.max(i0 + 1, i1); j++) s += src[j]
      dst[i] = s / Math.max(1, i1 - i0)
    }
  }

  // 更新到时间 t（秒）。纯时间函数：同 t 重复调用结果一致（暂停/回卷安全）。
  function update(t) {
    const beat = t / BEAT // 拍相位
    const step = beat * 4 // 16 分音符相位
    // [we-scene patch] i16 必须按数学取模包进 [0,15]：t 为负时（首帧 rAF 时间戳
    // 可以早于挂载时刻的 performance.now()，t=(now-start)/1000 ≈ -0.005）
    // `Math.floor(step) % 16` 得 -1 → patterns.kick[-1] = undefined → kickV=NaN →
    // 全部 64 频段 NaN 灌进共享音频视图。3233141951 反光层的缩放脚本把 NaN 积分进
    // smoothValue（作者脚本无自愈），整层永久塌成 scale=[0,0,1] 隐形。
    const i16 = ((Math.floor(step) % 16) + 16) % 16
    const frac = step - Math.floor(step)
    // 打击乐瞬时包络：attack 快、decay 指数（约 0.22s 衰减到 1/e）
    const hitEnv = Math.exp(-frac * BEAT * 14)
    const section = t % SECTION_LEN
    const silent = section >= 27 && section < 29
    const buildup = section >= 29 ? (section - 29) / 3 : 0
    const breakdown = section >= 24 && section < 27 ? 1 - (section - 24) / 3 : 0

    // 段落门控：正常 1 → breakdown 鼓收掉 → 静音 0 → build-up 指数回升
    const drumGate = silent ? 0 : buildup > 0 ? buildup * buildup : breakdown > 0 ? 0 : 1
    const midGate = silent ? 0 : breakdown > 0 ? 0.35 : 1

    const kickV = patterns.kick[i16] * hitEnv * drumGate
    const snareV = (patterns.snare[i16] * hitEnv + patterns.hat[i16] * hitEnv * 0.7) * drumGate
    const hatV = patterns.hat[i16] * hitEnv * drumGate
    // build-up 末拍的白噪声扫频（全频段）
    const riser = buildup > 0 ? Math.pow(buildup, 3) * (0.4 + 0.6 * Math.abs(vnoise(step * 2, 7))) : 0

    // 全局响度（vumeter）
    let levelSum = 0
    for (let i = 0; i < BANDS; i++) {
      const fq = i / BANDS // 0=低频 1=高频
      // 音乐频谱的粉色斜坡：能量随频段下降
      const tilt = Math.pow(1 - fq * 0.85, 1.6)
      // 各层归属：底鼓 → 0..0.18，军鼓/中频 → 0.12..0.6，踩镲 → 0.45..1
      // 和弦基底按频段加权：低频弱（让给底鼓）、中高频强 —— 低频的起伏由节拍驱动。
      // 基底均值目标 ~0.5：WE 真实音乐下频段均值 0.5-0.8，音频条/示波器的幅度才
      // 达到作者预期（实测 3078285611 音条 scale=band 值，过小则只是贴地小圆点）。
      let v = midGate * (0.5 + 0.3 * vnoise(beat * 0.5 + phases[i] * 0.05, i % 8)) // 和弦/旋律基底
      v *= 0.35 + 0.65 * fq
      if (fq < 0.2) v += kickV * (1 - fq / 0.2)
      if (fq >= 0.12 && fq < 0.62) {
        const w = 1 - Math.abs(fq - 0.34) / 0.28
        if (w > 0) v += snareV * 0.55 * w
      }
      if (fq >= 0.45) v += hatV * 0.5 * ((fq - 0.45) / 0.55)
      v += riser * 0.5
      v *= tilt
      const vPre = v // 钳位前留一份（网页 gamma 扩展用；场景路径不变）
      v = Math.min(1, v * GAIN)
      // 立体声：低频居中，高频宽（左右去相关）
      const width = 0.06 + fq * 0.2
      const pan = vnoise(beat * 0.13 + i * 0.35, 11) * width
      let l = Math.min(1, Math.max(0, v * (1 - pan)))
      let r = Math.min(1, Math.max(0, v * (1 + pan)))
      // 静音段不完全为零（底噪 -60dB 级），更接近真实频谱仪的观感
      const floorV = silent ? 0.012 : 0
      rawL[i] = Math.max(floorV, l)
      rawR[i] = Math.max(floorV, r)
      // pre 系列走同一 pan/底噪，只是不乘 GAIN、不钳 1（保留波峰因数）
      preL64[i] = Math.max(floorV, Math.max(0, vPre * (1 - pan)))
      preR64[i] = Math.max(floorV, Math.max(0, vPre * (1 + pan)))
      if (i < 48) levelSum += (rawL[i] + rawR[i]) * 0.5
    }
    left64.set(rawL)
    right64.set(rawR)
    downsample(left32, rawL)
    downsample(right32, rawR)
    downsample(left16, rawL)
    downsample(right16, rawR)
    // vumeter：以中低频为主的整体响度（WE 的 vu 表对低频更敏感）
    snapshot.level = Math.min(1, levelSum / (48 * 1.2))
    snapshot.silent = silent
    return snapshot
  }

  return { update, snapshot, /** 频段基数 */ bands: BANDS }
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
