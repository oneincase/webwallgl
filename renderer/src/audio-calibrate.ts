/**
 * 真实音频频谱的量级标定（自适应增益）。
 *
 * ## 为什么需要
 * 作者按 WE 的频谱量级设计阈值与音条高度：强段频段均值 0.5~0.8、峰值贴 1
 * （见 renderer/audio.js 的标定注释与 bgm-analyser 的 `maxDecibels=-25` 字节
 * 频谱 —— 壁纸自带歌曲经那条路出来就是这个量级）。
 *
 * 宿主注入的真实系统音频（`setAudioBridge`，契约只说「0..1」）来自各家自己
 * 的 FFT 归一化，典型量级往往是 0.1~0.3 —— 原样喂给着色器/脚本时，作者写的
 * `> 0.5` 阈值永不触发、音条只贴地微颤（用户实测：「真实音谱反馈完全和内置
 * 歌曲不是一个级别」）。
 *
 * ## 做法
 * 跟踪**滚动峰值**（快起、慢落：约 2s 半衰），增益 = TARGET/峰值，夹在
 * [MIN_GAIN, MAX_GAIN]：
 *   - 安静素材（峰值 0.15）→ 增益 ~6，整体抬到强段贴 1，与内置同量级；
 *   - 响亮素材（峰值 0.9+）→ 增益 ~1，不额外放大、不削波；
 *   - 瞬态（鼓点）靠慢落保持增益稳定，避免逐帧泵动；
 *   - 静音/底噪（峰值 < NOISE_FLOOR）不放大，silent 语义由调用方按**原始**
 *     电平判定，静音段仍然静音。
 *
 * 纯算术、无副作用的输入依赖：同一串输入得到同一串增益（离线校验可复现）。
 */

export type CalibratorOptions = {
  /** 增益目标：滚动峰值乘以增益后接近 1（默认 0.92） */
  targetPeak?: number
  /** 增益下限（默认 1：不衰减响亮素材） */
  minGain?: number
  /** 增益上限（默认 12：避免把底噪放大成满格） */
  maxGain?: number
  /** 低于此峰值视为无声/底噪，不参与增益提升（默认 0.02） */
  noiseFloor?: number
  /** 滚动峰值半衰期（秒，默认 2） */
  halfLifeSec?: number
  /** 增益下降（素材变响）的平滑时间常数（秒，默认 0.15，快） */
  attackSec?: number
  /** 增益上升（素材变轻）的平滑时间常数（秒，默认 1.2，慢） */
  releaseSec?: number
}

export interface SpectrumCalibrator {
  /**
   * 用本帧原始频谱推进参考峰值，返回本帧应施加的增益。
   * @param left 左声道频段（0..1）
   * @param right 右声道频段（0..1）
   * @param n 参与统计的段数（默认取较短一侧的长度）
   * @param dtSec 距上一帧的秒数（默认 1/60）
   */
  gainFor(left: ArrayLike<number>, right: ArrayLike<number>, n?: number, dtSec?: number): number
  /** 当前参考峰值（诊断用） */
  referencePeak(): number
  /** 当前增益（诊断用） */
  currentGain(): number
  reset(): void
}

export function createSpectrumCalibrator(opts: CalibratorOptions = {}): SpectrumCalibrator {
  const targetPeak = opts.targetPeak ?? 0.92
  const minGain = opts.minGain ?? 1
  const maxGain = opts.maxGain ?? 12
  const noiseFloor = opts.noiseFloor ?? 0.02
  const halfLifeSec = Math.max(0.05, opts.halfLifeSec ?? 2)
  const attackSec = Math.max(0.01, opts.attackSec ?? 0.15)
  const releaseSec = Math.max(0.01, opts.releaseSec ?? 1.2)

  let refPeak = 0
  let gain = minGain

  return {
    gainFor(left, right, n, dtSec) {
      const len = Math.min(
        n ?? Math.min(left.length, right.length),
        left.length,
        right.length,
      )
      const dt = Math.max(1 / 240, Math.min(0.25, dtSec ?? 1 / 60))
      let peak = 0
      for (let i = 0; i < len; i++) {
        const l = Number(left[i]) || 0
        const r = Number(right[i]) || 0
        if (l > peak) peak = l
        if (r > peak) peak = r
      }
      // 滚动峰值：瞬态立刻抬高，之后按半衰期指数回落
      const decay = Math.pow(0.5, dt / halfLifeSec)
      refPeak = Math.max(peak, refPeak * decay)
      if (refPeak < noiseFloor) {
        // 无声/底噪：不提升增益（保持当前值，等真实内容出现再抬）
        return gain
      }
      const want = Math.max(minGain, Math.min(maxGain, targetPeak / refPeak))
      // 增益下降快（避免削波）、上升慢（避免泵动）
      const tau = want < gain ? attackSec : releaseSec
      const alpha = 1 - Math.exp(-dt / tau)
      gain += (want - gain) * alpha
      return gain
    },
    referencePeak: () => refPeak,
    currentGain: () => gain,
    reset() {
      refPeak = 0
      gain = minGain
    },
  }
}
