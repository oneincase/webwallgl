/**
 * 测试台「系统实况」浏览器侧：
 *   - 音频：麦克风 → AnalyserNode → WE 16/32/64 band 快照（无 ScreenCaptureKit）
 *   - 媒体 / 窗口：订阅宿主 /api/system/stream SSE（Music/Spotify + 前台窗口）
 *
 * 接进 scene-mount 后替换 createSimulated*；失败时调用方应回退模拟源。
 */
import { media as mediaMod } from "./vendor";

export type LiveAudioSnapshot = {
  left64: Float32Array;
  right64: Float32Array;
  left32: Float32Array;
  right32: Float32Array;
  left16: Float32Array;
  right16: Float32Array;
  level: number;
  silent: boolean;
};

const BANDS = 64;
const MEDIA_PLAYBACK = { STOPPED: 0, PLAYING: 1, PAUSED: 2 } as const;

function zeroBands(): LiveAudioSnapshot {
  return {
    left64: new Float32Array(BANDS),
    right64: new Float32Array(BANDS),
    left32: new Float32Array(32),
    right32: new Float32Array(32),
    left16: new Float32Array(16),
    right16: new Float32Array(16),
    level: 0,
    silent: true,
  };
}

function downsample(dst: Float32Array, src64: Float32Array) {
  const g = src64.length / dst.length;
  for (let i = 0; i < dst.length; i++) {
    let s = 0;
    const i0 = Math.floor(i * g);
    const i1 = Math.max(i0 + 1, Math.floor((i + 1) * g));
    for (let j = i0; j < i1; j++) s += src64[j];
    dst[i] = s / (i1 - i0);
  }
}

/** 字节频谱 → 对数分箱 64 band（近似 WE / WallpaperEM we_shim） */
function fillFromByteFreq(out: LiveAudioSnapshot, bytes: Uint8Array, sampleRate: number) {
  const n = bytes.length;
  const nyquist = sampleRate * 0.5;
  const fMin = 20;
  const fMax = Math.min(20_000, nyquist);
  let levelSum = 0;
  for (let b = 0; b < BANDS; b++) {
    const t0 = b / BANDS;
    const t1 = (b + 1) / BANDS;
    const loHz = fMin * Math.pow(fMax / fMin, t0);
    const hiHz = fMin * Math.pow(fMax / fMin, t1);
    const i0 = Math.max(0, Math.floor((loHz / nyquist) * n));
    const i1 = Math.min(n, Math.max(i0 + 1, Math.ceil((hiHz / nyquist) * n)));
    let s = 0;
    for (let i = i0; i < i1; i++) s += bytes[i] / 255;
    const v = Math.min(1, (s / (i1 - i0)) * 1.35);
    out.left64[b] = v;
    out.right64[b] = v;
    if (b < 48) levelSum += v;
  }
  downsample(out.left32, out.left64);
  downsample(out.right32, out.right64);
  downsample(out.left16, out.left64);
  downsample(out.right16, out.right64);
  out.level = Math.min(1, levelSum / (48 * 1.2));
  out.silent = out.level < 0.02;
}

function hashHue(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 360;
}

function hslToRgb(h: number, sat: number, light: number): [number, number, number] {
  const s = sat / 100;
  const l = light / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return [r + m, g + m, b + m];
}

function applyPalette(snap: any, seed: string) {
  const hue = hashHue(seed || "empty");
  const [pr, pg, pb] = hslToRgb(hue, 72, 48);
  const [sr, sg, sb] = hslToRgb((hue + 40) % 360, 55, 28);
  const [tr, tg, tb] = hslToRgb((hue + 20) % 360, 70, 72);
  snap.primaryColor = mediaMod.mediaVec3(pr, pg, pb);
  snap.secondaryColor = mediaMod.mediaVec3(sr, sg, sb);
  snap.tertiaryColor = mediaMod.mediaVec3(tr, tg, tb);
  snap.textColor = mediaMod.mediaVec3(0.98, 0.98, 1);
  snap.highContrastColor = mediaMod.mediaVec3(1, 1, 1);
  snap.hasThumbnail = !!seed;
}

/** 从封面图采样主色（32×32 平均 + 高饱和点） */
export function sampleArtworkPalette(img: CanvasImageSource, w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = 32;
  c.height = 32;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, w, h, 0, 0, 32, 32);
  const data = ctx.getImageData(0, 0, 32, 32).data;
  let r = 0, g = 0, b = 0, n = 0;
  let br = 0, bg = 0, bb = 0, best = -1;
  for (let i = 0; i < data.length; i += 4) {
    const pr = data[i] / 255, pg = data[i + 1] / 255, pb = data[i + 2] / 255;
    r += pr; g += pg; b += pb; n++;
    const mx = Math.max(pr, pg, pb), mn = Math.min(pr, pg, pb);
    const sat = mx - mn;
    const lum = 0.2126 * pr + 0.7152 * pg + 0.0722 * pb;
    const score = sat * 1.4 + (lum > 0.15 && lum < 0.85 ? 0.3 : 0);
    if (score > best) {
      best = score;
      br = pr; bg = pg; bb = pb;
    }
  }
  if (!n) return null;
  const primary: [number, number, number] = [br, bg, bb];
  const secondary: [number, number, number] = [r / n * 0.55, g / n * 0.55, b / n * 0.55];
  const tertiary: [number, number, number] = [
    Math.min(1, primary[0] * 0.45 + 0.55),
    Math.min(1, primary[1] * 0.45 + 0.55),
    Math.min(1, primary[2] * 0.45 + 0.55),
  ];
  return { primary, secondary, tertiary };
}

/** 封面画到 RGBA，供 $mediaThumbnail 上传 */
export function rasterizeArtwork(
  img: CanvasImageSource,
  srcW: number,
  srcH: number,
  size = 512,
): { width: number; height: number; rgba: Uint8Array } {
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d")!;
  const scale = Math.max(size / Math.max(1, srcW), size / Math.max(1, srcH));
  const dw = srcW * scale;
  const dh = srcH * scale;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(img, (size - dw) / 2, (size - dh) / 2, dw, dh);
  const id = ctx.getImageData(0, 0, size, size);
  return { width: size, height: size, rgba: new Uint8Array(id.data) };
}

function emptyMediaSnapshot(): {
  hasMedia: boolean;
  state: 0 | 1 | 2;
  title: string;
  artist: string;
  album: string;
  albumArtist: string;
  position: number;
  duration: number;
  hasThumbnail: boolean;
  primaryColor: ReturnType<typeof mediaMod.mediaVec3>;
  secondaryColor: ReturnType<typeof mediaMod.mediaVec3>;
  tertiaryColor: ReturnType<typeof mediaMod.mediaVec3>;
  textColor: ReturnType<typeof mediaMod.mediaVec3>;
  highContrastColor: ReturnType<typeof mediaMod.mediaVec3>;
  trackIndex: number;
  lyrics: unknown[];
  lyricLine: string;
  lyricIndex: number;
} {
  return {
    hasMedia: false,
    state: MEDIA_PLAYBACK.STOPPED,
    title: "",
    artist: "",
    album: "",
    albumArtist: "",
    position: 0,
    duration: 0,
    hasThumbnail: false,
    primaryColor: mediaMod.mediaVec3(0, 0, 0),
    secondaryColor: mediaMod.mediaVec3(0, 0, 0),
    tertiaryColor: mediaMod.mediaVec3(0, 0, 0),
    textColor: mediaMod.mediaVec3(1, 1, 1),
    highContrastColor: mediaMod.mediaVec3(1, 1, 1),
    trackIndex: -1,
    lyrics: [],
    lyricLine: "",
    lyricIndex: -1,
  };
}

export type LiveSystemStatus = {
  audio: "mic" | "denied" | "unavailable" | "off";
  media: "live" | "empty" | "offline";
  window: "live" | "empty" | "offline";
  title?: string;
  artist?: string;
  app?: string;
  windowTitle?: string;
  hasArtwork?: boolean;
};

export type ArtworkHook = (info: {
  url: string;
  trackKey: string;
  title: string;
  artist: string;
}) => void;

export type LiveSystemHandle = {
  audio: { snapshot: LiveAudioSnapshot; pump: () => void };
  media: {
    snapshot: ReturnType<typeof emptyMediaSnapshot>;
    pump: () => void;
    skipNext: () => void;
    skipPrevious: () => void;
    play: () => void;
    pause: () => void;
    playPause: () => void;
  };
  windowTitle: { snapshot: { app: string; title: string; url: string; index: number }; pump: () => void };
  status: () => LiveSystemStatus;
  dispose: () => void;
};

async function openMicAnalyser(): Promise<{
  ctx: AudioContext;
  stream: MediaStream;
  analyser: AnalyserNode;
  buf: Uint8Array;
} | null> {
  if (!navigator.mediaDevices?.getUserMedia) return null;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    });
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.8;
    src.connect(analyser);
    if (ctx.state === "suspended") await ctx.resume().catch(() => {});
    return { ctx, stream, analyser, buf: new Uint8Array(analyser.frequencyBinCount) };
  } catch {
    return null;
  }
}

/**
 * 启动实况源。媒体以 HTTP 轮询为主（SSE 为辅）；封面经 /api/system/artwork。
 */
export async function startLiveSystem(opts?: {
  origin?: string;
  onArtwork?: ArtworkHook;
}): Promise<LiveSystemHandle> {
  const origin = opts?.origin ?? (typeof location !== "undefined" ? location.origin : "");
  const onArtwork = opts?.onArtwork;
  const audioSnap = zeroBands();
  const mediaSnap = emptyMediaSnapshot();
  const winSnap = { app: "", title: "", url: "", index: 0 };

  let audioMode: LiveSystemStatus["audio"] = "off";
  let mediaMode: LiveSystemStatus["media"] = "offline";
  let windowMode: LiveSystemStatus["window"] = "offline";
  let trackKey = "";
  let hasArtwork = false;
  let lastArtworkKey = "";

  const mic = await openMicAnalyser();
  if (mic) audioMode = "mic";
  else if (!navigator.mediaDevices?.getUserMedia) audioMode = "unavailable";
  else audioMode = "denied";

  let es: EventSource | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;

  const requestArtwork = (key: string, title: string, artist: string) => {
    if (!origin || !onArtwork || !hasArtwork) return;
    if (lastArtworkKey === key) return;
    lastArtworkKey = key;
    onArtwork({
      url: `${origin}/api/system/artwork?k=${encodeURIComponent(key)}&_=${Date.now()}`,
      trackKey: key,
      title,
      artist,
    });
  };

  const applyMediaPayload = (m: Record<string, unknown> | null | undefined) => {
    if (!m || !m.hasMedia) {
      mediaSnap.hasMedia = false;
      mediaSnap.state = MEDIA_PLAYBACK.STOPPED;
      mediaSnap.title = "";
      mediaSnap.artist = "";
      mediaSnap.album = "";
      mediaSnap.albumArtist = "";
      mediaSnap.position = 0;
      mediaSnap.duration = 0;
      mediaSnap.hasThumbnail = false;
      mediaSnap.trackIndex = -1;
      mediaMode = m ? "empty" : "offline";
      trackKey = "";
      hasArtwork = false;
      lastArtworkKey = "";
      return;
    }
    mediaMode = "live";
    mediaSnap.hasMedia = true;
    mediaSnap.state = (Number(m.state) === 2 ? 2 : Number(m.state) === 1 ? 1 : 0) as 0 | 1 | 2;
    mediaSnap.title = String(m.title ?? "");
    mediaSnap.artist = String(m.artist ?? "");
    mediaSnap.album = String(m.album ?? "");
    mediaSnap.albumArtist = String(m.albumArtist ?? m.artist ?? "");
    mediaSnap.position = Number(m.position) || 0;
    mediaSnap.duration = Number(m.duration) || 0;
    hasArtwork = m.hasArtwork === true;
    const key = `${mediaSnap.title}|${mediaSnap.artist}|${mediaSnap.album}`;
    if (key !== trackKey) {
      trackKey = key;
      lastArtworkKey = "";
      mediaSnap.trackIndex = (mediaSnap.trackIndex + 1) | 0;
      applyPalette(mediaSnap, key);
      requestArtwork(key, mediaSnap.title, mediaSnap.artist);
    } else {
      requestArtwork(key, mediaSnap.title, mediaSnap.artist);
    }
  };

  const applyWindowPayload = (w: Record<string, unknown> | null | undefined) => {
    if (!w) {
      windowMode = "offline";
      return;
    }
    winSnap.app = String(w.app ?? "");
    winSnap.title = String(w.title ?? "");
    winSnap.url = String(w.url ?? "");
    windowMode = winSnap.app || winSnap.title ? "live" : "empty";
  };

  const pollOnce = async () => {
    if (!origin || disposed) return;
    try {
      const [mr, wr] = await Promise.all([
        fetch(`${origin}/api/system/media`, { cache: "no-store" }),
        fetch(`${origin}/api/system/window`, { cache: "no-store" }),
      ]);
      if (mr.ok) {
        const j = (await mr.json()) as Record<string, unknown>;
        applyMediaPayload(j);
      } else {
        mediaMode = "offline";
      }
      if (wr.ok) {
        applyWindowPayload((await wr.json()) as Record<string, unknown>);
      }
    } catch {
      mediaMode = mediaMode === "live" ? "live" : "offline";
      windowMode = windowMode === "live" ? "live" : "offline";
    }
  };

  if (origin) {
    // 轮询为主：比 SSE 更抗 Vite 中间件抖动；先 await 一轮再返回，挂载侧立刻有曲目
    await pollOnce();
    pollTimer = setInterval(() => void pollOnce(), 1000);
    try {
      es = new EventSource(`${origin}/api/system/stream`);
      es.onmessage = (ev) => {
        if (disposed) return;
        try {
          const data = JSON.parse(ev.data) as {
            media?: Record<string, unknown>;
            window?: Record<string, unknown>;
          };
          applyMediaPayload(data.media);
          applyWindowPayload(data.window);
        } catch {
          /* 单帧坏 JSON 忽略 */
        }
      };
    } catch {
      /* 仅轮询 */
    }
  }

  const postControl = (action: string) => {
    if (!origin || disposed) return;
    void fetch(`${origin}/api/system/media-control`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    })
      .then(async (r) => {
        if (!r.ok) return null;
        return r.json();
      })
      .then((j) => {
        if (j && typeof j === "object") applyMediaPayload(j as Record<string, unknown>);
        // 控制后强制再拉一轮（部分播放器状态滞后）
        void pollOnce();
      })
      .catch(() => {
        void pollOnce();
      });
  };

  return {
    audio: {
      snapshot: audioSnap,
      pump: () => {
        if (!mic || disposed) {
          audioSnap.level = 0;
          audioSnap.silent = true;
          return;
        }
        mic.analyser.getByteFrequencyData(mic.buf);
        fillFromByteFreq(audioSnap, mic.buf, mic.ctx.sampleRate || 48000);
      },
    },
    media: {
      snapshot: mediaSnap,
      pump: () => {
        /* 轮询 / SSE 已写快照 */
      },
      skipNext: () => postControl("skipNext"),
      skipPrevious: () => postControl("skipPrevious"),
      play: () => postControl("play"),
      pause: () => postControl("pause"),
      playPause: () => postControl("playPause"),
    },
    windowTitle: {
      snapshot: winSnap,
      pump: () => {
        /* poll */
      },
    },
    status: () => ({
      audio: audioMode,
      media: mediaMode,
      window: windowMode,
      title: mediaSnap.title,
      artist: mediaSnap.artist,
      app: winSnap.app,
      windowTitle: winSnap.title,
      hasArtwork,
    }),
    dispose: () => {
      disposed = true;
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      try {
        es?.close();
      } catch {
        /* ignore */
      }
      es = null;
      if (mic) {
        try {
          mic.stream.getTracks().forEach((t) => t.stop());
          void mic.ctx.close();
        } catch {
          /* ignore */
        }
      }
    },
  };
}
