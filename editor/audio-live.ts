// 编辑器侧音频源：把「系统音频」与「试听音频」变成引擎吃得下的频谱快照。
//
// 引擎的音频反应（shader 的 g_AudioSpectrum16/32/64Left|Right uniform、粒子
// audioprocessingmode、文字脚本 engine.registerAudioBuffers）只认一份每帧快照，
// 来源由 MountOptions.audio / SceneInstance.setAudio() 的 AudioSource.snapshot() 决定。
// 编辑器预览是同页真引擎挂载（不走 iframe 遥控），所以挂载带 audio、或挂载后
// setAudio()，音频反应层就会在编辑器里真的动起来。
//
// 之前编辑器一个音频源都没有：内置模拟源恒定全零，音量又默认 0（引擎恒静音，
// bgm-analyser 的 readBands() 因 muted 直接返回 null），于是预览里频谱永远是零、
// 音条永远静止 —— 这两条源就是补这个缺口。
//
// 两条源都不依赖渲染器：一条听宿主 `/api/system/stream` 的 SSE（系统输出 loopback），
// 一条给试听的 HTMLAudioElement 挂 AnalyserNode。拿不到数据时一律喂全零快照
// （引擎注释：GL uniform 数组不设置会保留上一帧的值，静默必须显式喂零）。

/** 引擎要的形状：左右各 64 段，0..1 */
export type Bands = { left: Float32Array; right: Float32Array };

/** 编辑器侧音频源（快照恒非空：没数据就是全零；live() 说明当前是否真有信号） */
export type BandsSource = {
  snapshot(): Bands;
  live(): boolean;
};

export type AudioSourceStatus = "off" | "idle" | "live" | "preview";

const BANDS = 64;
/** 系统音频断流判据（与 renderer/src/live-system.ts 的 AUDIO_STALE_MS 一致） */
const STALE_MS = 1500;

export const silentBands = (): Bands => ({ left: new Float32Array(BANDS), right: new Float32Array(BANDS) });

/** media-bridge 的 64 段 0-255 对数频谱 → 引擎要的 0..1；左右同值（与 live-system 一致） */
export function bandsFromFrame(bands: readonly number[] | null | undefined): Bands | null {
  if (!Array.isArray(bands) || bands.length === 0) return null;
  const out = silentBands();
  const n = Math.min(BANDS, bands.length);
  for (let i = 0; i < n; i++) {
    const v = Number(bands[i]);
    const x = Number.isFinite(v) ? Math.max(0, Math.min(1, v / 255)) : 0;
    out.left[i] = x;
    out.right[i] = x;
  }
  return out;
}

/**
 * FFT 幅度谱（freq[i] = 0..255）→ 64 段对数分桶，桶内取峰。
 * 分桶公式与 renderer/src/bgm-analyser.ts 同源（usable = 0.72、lo = 2、平方刻度），
 * 这样编辑器里试听看到的频谱形状与壁纸里 BGM 驱动的形状一致。
 */
export function bandsFromFreq(freq: Uint8Array, out: Bands = silentBands()): Bands {
  const span = freq.length * 0.72;
  const lo = 2;
  for (let b = 0; b < BANDS; b++) {
    const f0 = lo + Math.floor(span * (b / BANDS) ** 2);
    const f1 = lo + Math.floor(span * ((b + 1) / BANDS) ** 2);
    const end = Math.min(freq.length, Math.max(f0 + 1, f1));
    let peak = 0;
    for (let i = f0; i < end; i++) if (freq[i] > peak) peak = freq[i];
    const x = peak / 255;
    out.left[b] = x;
    out.right[b] = x;
  }
  return out;
}

/** 把快照压成 16 段给面板电平条（每 4 段取最大，避免细线看不见） */
export function meterLevels(bands: Bands, bars = 16): number[] {
  const out: number[] = [];
  const step = BANDS / bars;
  for (let b = 0; b < bars; b++) {
    let peak = 0;
    for (let i = Math.floor(b * step); i < Math.floor((b + 1) * step); i++) {
      peak = Math.max(peak, bands.left[i] ?? 0, bands.right[i] ?? 0);
    }
    out.push(peak);
  }
  return out;
}

export type SystemAudioSource = BandsSource & {
  /** 开听宿主 SSE（幂等；重复调用不叠加连接） */
  start(): void;
  stop(): void;
  status(): AudioSourceStatus;
  dispose(): void;
};

/**
 * 系统音频：宿主 media-bridge（原生 loopback + FFT，64 段 0-255 对数）经
 * /api/system/stream 的 SSE 推下来。宿主没装 / 没权限时连不上，SSE 自动重连，
 * 这段期间快照全零、status() 为 "idle" —— 不抛错、不影响挂载。
 */
export function createSystemAudioSource(origin = ""): SystemAudioSource {
  let es: EventSource | null = null;
  let cur: Bands | null = null;
  let at = 0;
  const src: SystemAudioSource = {
    start() {
      if (es || typeof EventSource === "undefined") return;
      es = new EventSource(`${origin}/api/system/stream`);
      es.onmessage = (ev: MessageEvent<string>) => {
        try {
          const msg = JSON.parse(ev.data) as { audio?: { bands?: number[] } };
          const bands = bandsFromFrame(msg.audio?.bands);
          if (!bands) return;
          cur = bands;
          at = Date.now();
        } catch {
          /* 单帧不规范就当没收到，等下一帧 */
        }
      };
    },
    stop() {
      es?.close();
      es = null;
      cur = null;
      at = 0;
    },
    dispose() {
      src.stop();
    },
    live() {
      return !!cur && Date.now() - at < STALE_MS;
    },
    status() {
      if (!es) return "off";
      return src.live() ? "live" : "idle";
    },
    snapshot() {
      return src.live() && cur ? cur : silentBands();
    },
  };
  return src;
}

export type ElementAudioSource = BandsSource & {
  status(): AudioSourceStatus;
  dispose(): void;
};

/**
 * 试听音频：给 `new Audio(url)` 的元素挂 AnalyserNode。
 * 接进 AudioContext 之后元素不再直接播到输出，所以 analyser 要再接回 destination，
 * 否则试听会变成哑巴。AudioContext 没跑起来（没用户手势）时**不接图**：宁可只有声音、
 * 没有频谱，也不要把试听掐无声。同一个元素只能建一次 source，所以每次试听新建元素。
 */
export function createElementAudioSource(au: HTMLAudioElement): ElementAudioSource {
  let ctx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let node: MediaElementAudioSourceNode | null = null;
  let freq: Uint8Array | null = null;
  const empty = silentBands();
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (Ctor) ctx = new Ctor();
    // 挂起也照样建图：resume() 是异步的，等它「跑起来」再建会白丢一次试听（getByteFrequencyData
    // 在挂起的上下文里本来就读全零，不需要额外判断）。
    if (ctx && ctx.state === "suspended") void ctx.resume().catch(() => {});
    if (ctx) {
      analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.8;
      node = ctx.createMediaElementSource(au);
      node.connect(analyser);
      // 采集完必须接回输出：少了这一跳，试听就只剩波形没有声音。
      analyser.connect(ctx.destination);
      freq = new Uint8Array(analyser.frequencyBinCount);
    }
  } catch {
    // 建图中途失败时不能把试听掐哑：元素直放，频谱这条退回全零。
    try {
      node?.disconnect();
    } catch {
      /* 没接上 */
    }
    try {
      if (ctx && node) node.connect(ctx.destination);
    } catch {
      /* 接不回输出就认了，至少声音还在 */
    }
    analyser = null;
    freq = null;
  }
  const live = () => !!au && !au.paused && !au.ended && !au.muted && au.volume > 0;
  return {
    live,
    status() {
      if (!analyser) return "off";
      return live() ? "preview" : "idle";
    },
    snapshot() {
      if (!analyser || !freq || !live()) return empty;
      analyser.getByteFrequencyData(freq);
      return bandsFromFreq(freq, empty);
    },
    dispose() {
      try {
        node?.disconnect();
        analyser?.disconnect();
      } catch {
        /* 已经断开 */
      }
      analyser = null;
      node = null;
      freq = null;
      if (ctx) void ctx.close().catch(() => {});
      ctx = null;
    },
  };
}

export type AudioMeter = {
  /** 换源：null = 停表并把柱子清零 */
  setSource(src: BandsSource | null): void;
  /** 每帧回调（状态文案用），返回 false 表示不再需要 */
  onFrame(cb: (() => void) | null): void;
  dispose(): void;
};

/**
 * 面板电平条：16 根 `<i>`，只在有源时跑 rAF（省掉空闲时的每帧样式写入）。
 * 纯展示，不参与渲染。
 */
export function mountAudioMeter(el: HTMLElement, bars = 16): AudioMeter {
  el.textContent = "";
  const items: HTMLElement[] = [];
  for (let i = 0; i < bars; i++) {
    const bar = document.createElement("i");
    el.appendChild(bar);
    items.push(bar);
  }
  let src: BandsSource | null = null;
  let raf = 0;
  let frame: (() => void) | null = null;
  const paint = (levels: number[]) => {
    for (let i = 0; i < items.length; i++) items[i].style.setProperty("--lvl", String(Math.round((levels[i] ?? 0) * 100)));
  };
  const tick = () => {
    if (!src) return;
    paint(meterLevels(src.snapshot(), items.length));
    frame?.();
    raf = requestAnimationFrame(tick);
  };
  const stop = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };
  paint([]);
  return {
    setSource(next) {
      stop();
      src = next;
      if (!src) {
        paint([]);
        return;
      }
      raf = requestAnimationFrame(tick);
    },
    onFrame(cb) {
      frame = cb;
    },
    dispose() {
      stop();
      src = null;
      frame = null;
      el.textContent = "";
    },
  };
}
