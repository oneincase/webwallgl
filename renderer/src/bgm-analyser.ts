// [we-scene patch] 壁纸自带 BGM（声音层 HTMLAudio）→ 频谱桥。
//
// 官方 WE 的音频可视化采的是「整条音频输出」：壁纸自带的声音层一旦在播放，
// 它的频谱就和系统音频一起喂给 g_AudioSpectrum* / engine.registerAudioBuffers。
// 本仓的声音层用 HTMLAudio 直放，没经过任何分析节点 —— 35 张「BGM + 音频反应
// 内容」的壁纸里，作者若把音条设计成响应自带音乐，就只会被模拟/麦克风源驱动。
//
// 做法：一个共享 AudioContext，每个声音元素 createMediaElementSource 后分两路
// （analyser 采集 + destination 继续出声），每帧把各元素的频域数据按频段取最大
// 合成成 64 段（左右声道 Web Audio 的单 AnalyserNode 不分离，BGM 多为立体声但
// 音条不强调声道差，同值喂左右；外部注入/麦克风仍是真立体声）。
//
// 约束：
//  - createMediaElementSource 每元素**只能一次**：在声音层装配时挂，销毁不重连；
//  - blob URL 同源，无 CORS 污染，频谱可读；
//  - AudioContext 可能因自动播放策略 suspended，首次用户手势/play() 后自行 resume；
//  - 暂停/静音/未播放的元素读到 -128（全 0），不影响其它源。

export type BgmAnalyser = {
  /** 把声音元素接入分析（幂等：同一元素只接一次） */
  attach(audio: HTMLAudioElement): void;
  /**
   * 读出当前 BGM 的 64 段包络（0..1）。返回 null 表示上下文不可用/无元素。
   * 只统计**正在播放且未静音**的元素。
   */
  readBands(): Float32Array | null;
  /** 在 ctx suspended 时尝试恢复（声音 play() 时调用） */
  resume(): void;
  dispose(): void;
};

const FFT = 2048;
const BANDS = 64;

export function createBgmAnalyser(): BgmAnalyser {
  let ctx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let freq: Uint8Array<ArrayBuffer> | null = null;
  const attached = new WeakSet<HTMLAudioElement>();
  const elements: HTMLAudioElement[] = [];

  const ensureCtx = (): boolean => {
    if (ctx) return true;
    try {
      const AC: typeof AudioContext | undefined =
        globalThis.AudioContext ??
        (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return false;
      ctx = new AC();
      analyser = ctx.createAnalyser();
      analyser.fftSize = FFT;
      analyser.smoothingTimeConstant = 0.8;
      freq = new Uint8Array(analyser.frequencyBinCount);
      return true;
    } catch {
      ctx = null;
      analyser = null;
      return false;
    }
  };

  const attach = (audio: HTMLAudioElement) => {
    if (!audio || attached.has(audio)) return;
    if (!ensureCtx() || !ctx || !analyser) return;
    try {
      const node = ctx.createMediaElementSource(audio);
      node.connect(analyser);
      // 必须再接回路：createMediaElementSource 会接管元素输出，不连 destination
      // 声音就没了。
      node.connect(ctx.destination);
      attached.add(audio);
      elements.push(audio);
    } catch {
      // 元素已被别处接过 source（理论上 WeakSet 已挡）等：放弃分析，声音照常。
      attached.add(audio);
    }
  };

  const resume = () => {
    if (ctx && ctx.state === "suspended") void ctx.resume().catch(() => {});
  };

  const readBands = (): Float32Array | null => {
    if (!analyser || !freq || !ctx) return null;
    const active = elements.some((a) => !a.paused && !a.ended && !a.muted && a.volume > 0);
    if (!active) return null;
    analyser.getByteFrequencyData(freq);
    const out = new Float32Array(BANDS);
    // 频谱桶按音乐频段**对数**分配（低频桶窄、高频桶宽），与 WE 音条观感一致：
    // 线性 64 等分把鼓/贝斯压在最前几格，高频空一大片。最低从 bin 2 起步
    // （跳过接近 DC 的桶）。
    const usable = freq.length * 0.72; // 截到 ~16kHz@48k 采样率，更高段能量极微
    const lo = 2;
    for (let b = 0; b < BANDS; b++) {
      const f0 = lo + Math.floor(usable * (b / BANDS) ** 2);
      const f1 = Math.max(f0 + 1, lo + Math.floor(usable * ((b + 1) / BANDS) ** 2));
      let peak = 0;
      for (let f = f0; f < f1 && f < freq.length; f++) {
        const v = freq[f];
        if (v > peak) peak = v;
      }
      out[b] = peak / 255;
    }
    return out;
  };

  const dispose = () => {
    try {
      void ctx?.close();
    } catch {
      /* ignore */
    }
    ctx = null;
    analyser = null;
    freq = null;
    elements.length = 0;
  };

  return { attach, readBands, resume, dispose };
}

/**
 * 把 BGM 64 段并入当前音频快照（就地写 left64/right64 及派生的 32/16）。
 * 取**逐频段最大**而非相加：BGM 与外部源同时存在时，相加会双倍过亮、容易爆 1，
 * max 保留「哪路有能量就听哪路」的并集语义，与「整条输出流的包络」观感一致。
 */
export function mergeBgmBands(
  snapshot: {
    left64: Float32Array;
    right64: Float32Array;
    left32?: Float32Array;
    right32?: Float32Array;
    left16?: Float32Array;
    right16?: Float32Array;
  },
  bgm: Float32Array,
  gain: number,
): void {
  for (let i = 0; i < 64; i++) {
    const v = Math.min(1, bgm[i] * gain);
    if (v > snapshot.left64[i]) snapshot.left64[i] = v;
    if (v > snapshot.right64[i]) snapshot.right64[i] = v;
  }
  downsampleMax(snapshot.left64, snapshot.left32);
  downsampleMax(snapshot.right64, snapshot.right32);
  downsampleMax(snapshot.left64, snapshot.left16);
  downsampleMax(snapshot.right64, snapshot.right16);
}

function downsampleMax(src64: Float32Array, dst: Float32Array | undefined): void {
  if (!dst) return;
  const g = src64.length / dst.length;
  for (let i = 0; i < dst.length; i++) {
    const i0 = Math.floor(i * g);
    const i1 = Math.max(i0 + 1, Math.floor((i + 1) * g));
    let m = 0;
    for (let j = i0; j < i1; j++) if (src64[j] > m) m = src64[j];
    dst[i] = m;
  }
}
