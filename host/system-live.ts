/**
 * 测试台「系统实况」——经 media-bridge（Node 子进程 + JSON 行协议）读真实系统媒体与系统输出频谱。
 *
 * media-bridge（仓库同级 ../media-bridge，Rust 单二进制，跨平台）负责：
 *   - Now Playing：MediaRemote / GSMTC / MPRIS，覆盖 Music / Spotify / 浏览器 / 任意播放器
 *     （事件：track / playback / artwork，只报变化）
 *   - 系统音频：回环采集**系统输出**（不是麦克风，无需浏览器录音授权），
 *     64 段 0-255 对数频谱（事件：spectrum，按订阅间隔推送）
 *   - 反向控制：play / pause / next / previous …（能力位 + 回执）
 *
 * 二进制解析顺序：MEDIA_BRIDGE_BIN 环境变量 → 仓库同级 ../media-bridge/target/release/
 * → PATH 上的 media-bridge。都找不到时 backend="none"，HTTP 端点照常应答（空快照），
 * 前端回落模拟源。
 *
 * 前台窗口 media-bridge 不管，仍走 AppleScript 轮询（System Events）。
 *
 * 本模块维护一份内存缓存，由子进程事件更新；HTTP/SSE 只读缓存。
 * 频谱帧经 onAudioFrame 回调交给 wallpaper-host 的 SSE 下发，浏览器侧不再采集。
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type LiveMediaSnap = {
  hasMedia: boolean;
  /** 0 stopped / 1 playing / 2 paused —— 对齐 MediaPlaybackEvent */
  state: 0 | 1 | 2;
  title: string;
  artist: string;
  album: string;
  albumArtist: string;
  position: number;
  duration: number;
  app: string;
  /** 当前曲目是否有缓存封面（经 /api/system/artwork 取） */
  hasArtwork: boolean;
  /** 数据从哪来，便于诊断 */
  source: "media-bridge" | "none";
};

export type LiveWindowSnap = {
  app: string;
  title: string;
  url: string;
};

export type MediaControl = "skipNext" | "skipPrevious" | "play" | "pause" | "playPause";

/** media-bridge spectrum 事件帧：64 段 0-255 对数刻度 */
export type AudioFrame = {
  bands: number[];
  peak: number;
  rms: number;
  sampleRate: number;
  tsMs: number;
};

/** 音频采集侧状态（给前端状态条 / 诊断用） */
export type AudioStatus = "live" | "denied" | "unavailable" | "idle" | "off";

const EMPTY_MEDIA: LiveMediaSnap = {
  hasMedia: false,
  state: 0,
  title: "",
  artist: "",
  album: "",
  albumArtist: "",
  position: 0,
  duration: 0,
  app: "",
  hasArtwork: false,
  source: "none",
};

export type CachedArtwork = {
  mime: string;
  data: Buffer;
  /** title|artist|album，与前端 trackKey 对齐 */
  key: string;
};

/** 当前曲目封面（不进 SSE JSON） */
let serviceArtwork: CachedArtwork | null = null;
/** 已读过的封面文件，避免 track/artwork 事件重复读盘 */
let artworkReadPath = "";

const EMPTY_WINDOW: LiveWindowSnap = { app: "", title: "", url: "" };

const WINDOW_POLL_MS = 1_500;
const BRIDGE_CALL_TIMEOUT_MS = 4_000;
const BRIDGE_RESPAWN_DELAY_MS = 2_000;
const BRIDGE_MAX_RESPAWNS = 8;
/** 频谱订阅间隔：20Hz 对可视化足够，SSE 本地转发无压力 */
const SPECTRUM_INTERVAL_MS = 50;

// ---------- media-bridge 子进程（stdio JSON 行）----------

type LiveService = {
  media: LiveMediaSnap;
  window: LiveWindowSnap;
  backend: "media-bridge" | "none";
  started: boolean;
};

const service: LiveService = {
  media: { ...EMPTY_MEDIA },
  window: { ...EMPTY_WINDOW },
  backend: "none",
  started: false,
};

let bridgeBin: string | null = null;
let bridgeBinResolved = false;
let bridgeProc: ChildProcess | null = null;
let bridgeBuf = "";
let bridgeSeq = 0;
let bridgeRespawns = 0;
let bridgeShuttingDown = false;
const pending = new Map<
  number,
  { resolve: (msg: Record<string, unknown>) => void; timer: ReturnType<typeof setTimeout> }
>();

/** 最新频谱帧 + 采集侧状态 */
let latestAudio: AudioFrame | null = null;
let lastAudioAtMs = 0;
let audioStatus: AudioStatus = "idle";

const audioFrameListeners = new Set<(frame: AudioFrame) => void>();

/** 频谱帧到达时回调（wallpaper-host 用它向 SSE 客户端扇出） */
export function onAudioFrame(cb: (frame: AudioFrame) => void): () => void {
  audioFrameListeners.add(cb);
  return () => audioFrameListeners.delete(cb);
}

export function getAudioStatus(): AudioStatus {
  if (service.backend !== "media-bridge") return "off";
  if (audioStatus === "live" && Date.now() - lastAudioAtMs > 1_500) return "unavailable";
  return audioStatus;
}

export function getLatestAudioFrame(): AudioFrame | null {
  return latestAudio;
}

function recordAudioFrame(frame: AudioFrame) {
  latestAudio = frame;
  lastAudioAtMs = Date.now();
  if (audioStatus !== "live") audioStatus = "live";
  for (const cb of audioFrameListeners) {
    try {
      cb(frame);
    } catch {
      /* 单个订阅者抛错不影响其他 */
    }
  }
}

function recordAudioSourceState(state: string) {
  if (state === "running") {
    // 真正"活"要看帧有没有来；这里只把 denied/unavailable 摘掉
    if (audioStatus === "denied" || audioStatus === "unavailable") audioStatus = "idle";
  } else if (state === "denied") {
    audioStatus = "denied";
  } else if (state === "unavailable" || state === "error") {
    audioStatus = "unavailable";
  }
}

/** 解析 media-bridge 二进制：env 覆盖 → 仓库同级构建产物 → PATH。结果（含失败）缓存。 */
async function resolveBridgeBin(): Promise<string | null> {
  if (bridgeBinResolved) return bridgeBin;
  bridgeBinResolved = true;
  const override = process.env.MEDIA_BRIDGE_BIN?.trim();
  const candidates: string[] = [];
  if (override) candidates.push(override);
  // vite dev server 的 cwd 是仓库根；同级 checkout 是本机的常规布局
  candidates.push(resolve(process.cwd(), "../media-bridge/target/release/media-bridge"));
  candidates.push(resolve(process.cwd(), "media-bridge/target/release/media-bridge"));
  for (const p of candidates) {
    try {
      await access(p);
      bridgeBin = p;
      return bridgeBin;
    } catch {
      /* 下一个候选 */
    }
  }
  if (process.platform !== "win32") {
    try {
      const { stdout } = await execFileAsync("which", ["media-bridge"], {
        timeout: 2_000,
        encoding: "utf8",
      });
      const p = stdout.trim();
      if (p) {
        bridgeBin = p;
        return bridgeBin;
      }
    } catch {
      /* PATH 上没有 */
    }
  }
  return null;
}

/** 调一次方法，resolve 出 result；`ok:false` / 超时 / 进程不在 → reject */
function callBridge(
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = BRIDGE_CALL_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    if (!bridgeProc || !bridgeProc.stdin) {
      reject(new Error("media-bridge 未运行"));
      return;
    }
    const id = ++bridgeSeq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`media-bridge ${method} 超时`));
    }, timeoutMs);
    const settle = (msg: Record<string, unknown>) => {
      if (msg.ok === true) {
        resolve((msg.result ?? {}) as Record<string, unknown>);
      } else {
        const err = (msg.error ?? {}) as Record<string, unknown>;
        reject(new Error(String(err.message ?? err.code ?? `${method} 失败`)));
      }
    };
    pending.set(id, { resolve: settle, timer });
    try {
      bridgeProc.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    } catch (e) {
      clearTimeout(timer);
      pending.delete(id);
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

function applyNow(now: unknown) {
  if (now == null || typeof now !== "object") return;
  const o = now as Record<string, unknown>;
  const playback = (o.playback ?? {}) as Record<string, unknown>;
  const track = (o.track ?? null) as Record<string, unknown> | null;
  const stateStr = String(playback.state ?? "stopped");

  if (o.hasMedia !== true || !track || stateStr === "stopped") {
    service.media = { ...EMPTY_MEDIA };
    return;
  }

  const source = (track.source ?? {}) as Record<string, unknown>;
  const artwork = (track.artwork ?? null) as Record<string, unknown> | null;
  // control 等回执里的 now 可能省略 artwork；曲目没换就不回退封面标志
  const prev = service.media;
  const sameTrack =
    prev.hasMedia &&
    prev.title === String(track.title ?? "") &&
    prev.artist === String(track.artist ?? "") &&
    prev.album === String(track.album ?? "");
  const hasArtwork = !!(artwork && artwork.path) || (sameTrack && prev.hasArtwork);

  const snap: LiveMediaSnap = {
    hasMedia: true,
    state: stateStr === "playing" ? 1 : 2,
    title: String(track.title ?? ""),
    artist: String(track.artist ?? ""),
    album: String(track.album ?? ""),
    albumArtist: String(track.albumArtist ?? ""),
    position: Number(playback.positionMs ?? 0) / 1000,
    duration: Number(track.durationMs ?? playback.durationMs ?? 0) / 1000,
    app: String(source.appName ?? ""),
    hasArtwork,
    source: "media-bridge",
  };
  service.media = snap;
  service.backend = "media-bridge";

  // 封面落盘在 media-bridge 缓存目录，直接读文件进内存（HTTP 端点只读缓存）
  if (artwork && typeof artwork.path === "string") {
    void refreshArtwork(String(artwork.path), String(artwork.mime ?? "image/jpeg"));
  }
}

async function refreshArtwork(path: string, mime: string) {
  if (path === artworkReadPath && serviceArtwork) return;
  try {
    const data = await readFile(path);
    artworkReadPath = path;
    serviceArtwork = {
      mime,
      data,
      key: `${service.media.title}|${service.media.artist}|${service.media.album}`,
    };
  } catch {
    /* 封面文件暂时读不到（竞态/权限）就等下一个事件 */
  }
}

function handleBridgeEvent(msg: Record<string, unknown>) {
  const event = String(msg.event ?? "");
  if (event === "track" || event === "playback") {
    applyNow(msg.now);
  } else if (event === "artwork") {
    const art = (msg.artwork ?? null) as Record<string, unknown> | null;
    if (art && typeof art.path === "string") {
      void refreshArtwork(String(art.path), String(art.mime ?? "image/jpeg"));
    }
  } else if (event === "spectrum") {
    const frame = (msg.frame ?? null) as Record<string, unknown> | null;
    if (frame && Array.isArray(frame.bands) && frame.bands.length === 64) {
      recordAudioFrame({
        bands: frame.bands.map((b) => Math.max(0, Math.min(255, Number(b) || 0))),
        peak: Number(frame.peak ?? 0),
        rms: Number(frame.rms ?? 0),
        sampleRate: Number(frame.sampleRate ?? 16000),
        tsMs: Number(frame.tsMs ?? Date.now()),
      });
    }
  } else if (event === "status") {
    const status = (msg.status ?? null) as Record<string, unknown> | null;
    const sources = Array.isArray(status?.sources) ? status!.sources : [];
    for (const s of sources as Record<string, unknown>[]) {
      if (String(s.name ?? "") === "audio") recordAudioSourceState(String(s.state ?? ""));
    }
  } else if (event === "error") {
    // 数据源出错（如 macOS 音频录制未授权）：按来源标记，别反复触发采集
    if (String(msg.source ?? "") === "audio") {
      recordAudioSourceState(String(msg.code ?? "unavailable") === "denied" ? "denied" : "unavailable");
    }
  }
}

function handleBridgeLine(line: string) {
  if (!line) return;
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(line) as Record<string, unknown>;
  } catch {
    /* 坏行忽略 */
    return;
  }
  if (msg.event !== undefined) {
    handleBridgeEvent(msg);
    return;
  }
  if (msg.id === null || msg.id === undefined) return;
  const entry = pending.get(Number(msg.id));
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(Number(msg.id));
  entry.resolve(msg);
}

function stopBridge() {
  bridgeShuttingDown = true;
  if (bridgeProc) {
    try {
      bridgeProc.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    bridgeProc = null;
  }
  for (const [, entry] of pending) clearTimeout(entry.timer);
  pending.clear();
}

function spawnBridge(bin: string) {
  let child: ChildProcess;
  try {
    child = spawn(bin, ["serve"], { stdio: ["pipe", "pipe", "pipe"] });
  } catch {
    service.backend = "none";
    return;
  }
  bridgeProc = child;
  bridgeBuf = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    bridgeBuf += chunk;
    let idx: number;
    while ((idx = bridgeBuf.indexOf("\n")) >= 0) {
      const line = bridgeBuf.slice(0, idx).trim();
      bridgeBuf = bridgeBuf.slice(idx + 1);
      handleBridgeLine(line);
    }
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", () => {
    /* media-bridge 的日志走 stderr；测试台不转发 */
  });
  child.on("error", () => {
    if (bridgeProc === child) bridgeProc = null;
  });
  child.on("exit", () => {
    if (bridgeProc !== child) return;
    bridgeProc = null;
    service.backend = "none";
    audioStatus = "off";
    latestAudio = null;
    // dev server 常驻，media-bridge 意外退出（崩溃/被杀）时拉起，别让实况静默死掉
    if (!bridgeShuttingDown && service.started && bridgeRespawns < BRIDGE_MAX_RESPAWNS) {
      bridgeRespawns++;
      setTimeout(() => {
        if (service.started && !bridgeProc) void startLiveSystemService();
      }, BRIDGE_RESPAWN_DELAY_MS).unref?.();
    }
  });
}

async function initBridgeSession(bin: string) {
  await callBridge("hello", {}, 6_000);
  bridgeRespawns = 0;
  service.backend = "media-bridge";
  // 订阅要显式带上 spectrum（缺省 = 除频谱外全部）
  await callBridge("subscribe", {
    events: ["track", "playback", "artwork", "lyrics", "status", "error", "spectrum"],
    intervalMs: SPECTRUM_INTERVAL_MS,
  });
  // 立刻有值：先取快照，再点一次 spectrum（首次调用触发音频 tap 创建）
  applyNow(await callBridge("now"));
  try {
    const frame = await callBridge("spectrum", {}, 6_000);
    if (Array.isArray(frame.bands)) recordAudioFrame(frame as unknown as AudioFrame);
  } catch {
    /* 音频侧不可用（未授权/无设备）不阻塞媒体实况 */
  }
}

// ---------- 前台窗口（media-bridge 不管，AppleScript 轮询）----------

async function readFrontWindowOnce(): Promise<LiveWindowSnap> {
  if (process.platform !== "darwin") return { ...EMPTY_WINDOW };
  let raw = "";
  try {
    const { stdout } = await execFileAsync(
      "osascript",
      [
        "-e",
        `tell application "System Events"
  set p to first application process whose frontmost is true
  set appName to name of p
  set winTitle to ""
  try
    set winTitle to name of front window of p
  end try
  return appName & "|||" & winTitle
end tell`,
      ],
      { timeout: 4_000, encoding: "utf8", maxBuffer: 256 * 1024 },
    );
    raw = stdout.trim();
  } catch {
    return { ...EMPTY_WINDOW };
  }
  const p = raw === "none" ? [] : raw.split("|||");
  if (p.length < 1) return { ...EMPTY_WINDOW };
  return { app: p[0] || "", title: p[1] || "", url: "" };
}

let windowTimer: ReturnType<typeof setInterval> | null = null;

async function pollWindow() {
  try {
    service.window = await readFrontWindowOnce();
  } catch {
    /* keep */
  }
}

// ---------- 对外 API（wallpaper-host 端点只读这些）----------

/**
 * 启动后台采集（幂等）。Vite 插件 configureServer 时调一次即可。
 */
export async function startLiveSystemService(): Promise<{ backend: LiveService["backend"] }> {
  if (service.started) return { backend: service.backend };
  service.started = true;
  bridgeShuttingDown = false;

  const bin = await resolveBridgeBin();
  if (!bin) {
    service.backend = "none";
    return { backend: "none" };
  }

  try {
    spawnBridge(bin);
    await initBridgeSession(bin);
  } catch {
    // 起不来（二进制坏/协议对不上）：不反复重启，实况退化为空快照
    stopBridge();
    service.backend = "none";
  }

  if (process.platform === "darwin") {
    await pollWindow();
    windowTimer ??= setInterval(() => void pollWindow(), WINDOW_POLL_MS);
    windowTimer.unref?.();
  }

  return { backend: service.backend };
}

/** 读缓存（同步）；未 start 时返回空 */
export function getCachedMedia(): LiveMediaSnap {
  return service.media;
}

export function getCachedArtwork(): CachedArtwork | null {
  if (!serviceArtwork) return null;
  const key = `${service.media.title}|${service.media.artist}|${service.media.album}`;
  if (serviceArtwork.key !== key) return null;
  return serviceArtwork;
}

export function getCachedWindow(): LiveWindowSnap {
  return service.window;
}

export function getLiveBackend(): LiveService["backend"] {
  return service.backend;
}

/** 兼容旧调用：确保服务已起，再取一次最新快照 */
export async function readNowPlaying(): Promise<LiveMediaSnap> {
  await startLiveSystemService();
  if (service.backend === "media-bridge") {
    try {
      applyNow(await callBridge("now"));
    } catch {
      /* 读缓存 */
    }
  }
  return service.media;
}

export async function readFrontWindow(): Promise<LiveWindowSnap> {
  await startLiveSystemService();
  if (!service.window.app) await pollWindow();
  return service.window;
}

const CONTROL_ACTIONS: Record<MediaControl, string> = {
  skipNext: "next",
  skipPrevious: "previous",
  play: "play",
  pause: "pause",
  playPause: "play-pause",
};

/** 控制当前系统正在播放；media-bridge 回执里带控制后的完整快照 */
export async function controlNowPlaying(action: MediaControl): Promise<LiveMediaSnap> {
  await startLiveSystemService();
  if (service.backend !== "media-bridge") return service.media;
  try {
    const result = await callBridge("control", { action: CONTROL_ACTIONS[action] });
    // applied=false（播放器不支持）也带 now，照常刷新缓存
    applyNow(result.now);
  } catch {
    /* 控制失败保留旧缓存 */
  }
  return service.media;
}

process.on("exit", () => stopBridge());
