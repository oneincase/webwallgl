/**
 * 测试台「系统实况」——Node 后端读真实 Now Playing / 前台窗口。
 *
 * 数据源优先级（macOS）：
 *   1. `media-control` CLI（brew install media-control）
 *      → 走 MediaRemote 适配层，覆盖 Music / Spotify / 浏览器 / 任意播放器
 *   2. AppleScript：Music.app、Spotify（无需额外依赖）
 *
 * 本模块维护一份内存缓存，由后台轮询 / stream 更新；HTTP/SSE 只读缓存，
 * 避免每个 SSE 客户端每 500ms 各打一轮 osascript。
 *
 * 音频频谱仍在浏览器侧（麦克风），见 renderer/src/live-system.ts。
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
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
  source: "media-control" | "applescript" | "none";
};

export type LiveWindowSnap = {
  app: string;
  title: string;
  url: string;
};

export type MediaControl = "skipNext" | "skipPrevious" | "play" | "pause" | "playPause";

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

const EMPTY_WINDOW: LiveWindowSnap = { app: "", title: "", url: "" };

const OSA_TIMEOUT_MS = 4_000;
const MEDIA_POLL_MS = 1_000;
const WINDOW_POLL_MS = 1_500;

function num(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function str(v: unknown): string {
  return v == null ? "" : String(v);
}

async function osascript(source: string): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  try {
    const { stdout } = await execFileAsync("osascript", ["-e", source], {
      timeout: OSA_TIMEOUT_MS,
      encoding: "utf8",
      maxBuffer: 256 * 1024,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

function parsePipe(raw: string | null): string[] {
  if (!raw || raw === "none") return [];
  return raw.split("|||");
}

// ---------- media-control（系统级 Now Playing）----------

let mediaControlPath: string | null | undefined;

/** 解析 PATH 上的 media-control；结果缓存。设 WE_MEDIA_CONTROL=0 可强制禁用。 */
async function resolveMediaControl(): Promise<string | null> {
  if (process.env.WE_MEDIA_CONTROL === "0") return null;
  if (mediaControlPath !== undefined) return mediaControlPath;
  if (process.platform !== "darwin") {
    mediaControlPath = null;
    return null;
  }
  const override = process.env.WE_MEDIA_CONTROL?.trim();
  if (override && override !== "1") {
    mediaControlPath = override;
    return mediaControlPath;
  }
  try {
    const { stdout } = await execFileAsync("which", ["media-control"], {
      timeout: 2_000,
      encoding: "utf8",
    });
    const p = stdout.trim();
    mediaControlPath = p || null;
  } catch {
    mediaControlPath = null;
  }
  return mediaControlPath;
}

/**
 * 把 media-control JSON 归一成 LiveMediaSnap。
 * stream 事件形如 `{ type:"data", diff:bool, payload:{...} }`；get 则是扁平对象。
 * `diff:true` 时 payload 是增量，必须与现有缓存合并，不能整表替换。
 */
function fromMediaControlJson(raw: unknown, prev?: LiveMediaSnap): LiveMediaSnap {
  if (raw == null || typeof raw !== "object") {
    return { ...EMPTY_MEDIA, source: "media-control" };
  }
  const o = raw as Record<string, unknown>;

  // stream 包装
  let info: Record<string, unknown>;
  let isDiff = false;
  if (o.type === "data" && o.payload !== undefined) {
    isDiff = o.diff === true;
    if (o.payload == null) {
      return { ...EMPTY_MEDIA, source: "media-control" };
    }
    if (typeof o.payload !== "object") {
      return prev ? { ...prev } : { ...EMPTY_MEDIA, source: "media-control" };
    }
    info = o.payload as Record<string, unknown>;
    // 启动时常见：先推一条空 payload，再推完整曲目。空包且非 diff → 忽略，保留 prev/get 结果。
    if (!isDiff && Object.keys(info).length === 0) {
      return prev ?? { ...EMPTY_MEDIA, source: "media-control" };
    }
  } else if (o.payload && typeof o.payload === "object") {
    info = o.payload as Record<string, unknown>;
  } else {
    info = o;
  }

  // 先存封面再删，避免 SSE 被 base64 撑爆
  const artRaw = info.artworkData;
  const artMime = str(info.artworkMimeType) || "image/jpeg";
  delete info.artworkData;

  const base = isDiff && prev?.hasMedia ? { ...prev } : { ...EMPTY_MEDIA, source: "media-control" as const };

  const title = str(info.title ?? info.Title ?? info.name ?? (isDiff ? base.title : ""));
  const artist = str(info.artist ?? info.Artist ?? info.trackArtist ?? (isDiff ? base.artist : ""));
  const album = str(info.album ?? info.Album ?? info.albumName ?? (isDiff ? base.album : ""));
  const albumArtist = str(
    info.albumArtist ?? info.AlbumArtist ?? artist ?? (isDiff ? base.albumArtist : ""),
  );

  let duration = info.duration != null || info.Duration != null || info.durationSeconds != null
    ? num(info.duration ?? info.Duration ?? info.durationSeconds)
    : base.duration;
  let position =
    info.elapsedTime != null || info.elapsed != null || info.position != null || info.Progress != null
      ? num(info.elapsedTime ?? info.elapsed ?? info.position ?? info.Progress)
      : base.position;
  if (duration > 10_000) duration /= duration > 1_000_000 ? 1_000_000 : 1_000;
  if (position > 10_000) position /= position > 1_000_000 ? 1_000_000 : 1_000;

  const hasPlayingFlag = "playing" in info || "Playing" in info;
  const playing =
    info.playing === true ||
    info.Playing === true ||
    Number(info.playbackRate ?? info.PlaybackRate) > 0;
  const pausedExplicit =
    info.playing === false ||
    info.Playing === false ||
    (hasPlayingFlag && !playing && Number(info.playbackRate ?? info.PlaybackRate) === 0);

  const bundle = str(
    info.bundleIdentifier ??
      info.bundleId ??
      info.appBundleIdentifier ??
      info.clientBundleIdentifier ??
      (isDiff ? "" : ""),
  );
  const appName = str(
    info.appName ??
      info.application ??
      info.displayName ??
      (bundleAppName(bundle) || (isDiff ? base.app : "")),
  );

  if (!title && !artist && !album && !isDiff) {
    // 明确无曲目（例如 get 返回 null 字段）
    if (hasPlayingFlag && !playing) return { ...EMPTY_MEDIA, source: "media-control" };
    if (!hasPlayingFlag && Object.keys(info).length === 0) {
      return prev ?? { ...EMPTY_MEDIA, source: "media-control" };
    }
  }

  let state: 0 | 1 | 2 = base.state;
  if (playing) state = 1;
  else if (pausedExplicit) state = 2;
  else if (title || artist) state = state || 2;

  if (!title && !artist && !album && state === 0) {
    return { ...EMPTY_MEDIA, source: "media-control" };
  }

  const trackKey = `${title || base.title}|${artist || base.artist}|${album || base.album}`;
  if (typeof artRaw === "string" && artRaw.length > 64) {
    try {
      const data = Buffer.from(artRaw, "base64");
      if (data.length > 64) {
        serviceArtwork = { mime: artMime, data, key: trackKey };
      }
    } catch {
      /* 坏 base64 忽略 */
    }
  }

  const hasArtwork = !!(serviceArtwork && serviceArtwork.key === trackKey);

  return {
    hasMedia: true,
    state: state === 0 ? 2 : state,
    title: title || base.title,
    artist: artist || base.artist,
    album: album || base.album,
    albumArtist: albumArtist || base.albumArtist,
    position,
    duration,
    app: appName || base.app || bundle || "Now Playing",
    hasArtwork,
    source: "media-control",
  };
}

function bundleAppName(bundle: string): string {
  if (!bundle) return "";
  if (bundle.includes("spotify")) return "Spotify";
  if (bundle.includes("Music") || bundle.endsWith(".Music")) return "Music";
  if (bundle.includes("chrome")) return "Google Chrome";
  if (bundle.includes("safari") || bundle.includes("Safari")) return "Safari";
  if (bundle.includes("firefox")) return "Firefox";
  if (bundle.includes("tv")) return "TV";
  const last = bundle.split(".").pop() || bundle;
  return last.charAt(0).toUpperCase() + last.slice(1);
}

async function mediaControlGet(bin: string): Promise<LiveMediaSnap> {
  try {
    const { stdout } = await execFileAsync(bin, ["get", "--now"], {
      timeout: 5_000,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    const text = stdout.trim();
    if (!text || text === "null") return { ...EMPTY_MEDIA, source: "media-control" };
    return fromMediaControlJson(JSON.parse(text), service.media);
  } catch {
    // 旧版无 --now
    try {
      const { stdout } = await execFileAsync(bin, ["get"], {
        timeout: 5_000,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      });
      const text = stdout.trim();
      if (!text || text === "null") return { ...EMPTY_MEDIA, source: "media-control" };
      return fromMediaControlJson(JSON.parse(text), service.media);
    } catch {
      return { ...EMPTY_MEDIA, source: "media-control" };
    }
  }
}

async function mediaControlSend(bin: string, action: MediaControl): Promise<void> {
  // media-control 0.7 命令名：next-track / previous-track / toggle-play-pause
  const args =
    action === "skipNext"
      ? ["next-track"]
      : action === "skipPrevious"
        ? ["previous-track"]
        : action === "play"
          ? ["play"]
          : action === "pause"
            ? ["pause"]
            : ["toggle-play-pause"];
  try {
    await execFileAsync(bin, args, { timeout: 3_000, encoding: "utf8" });
  } catch {
    /* ignore */
  }
}

// ---------- AppleScript 回退（Music / Spotify）----------

async function readMusic(): Promise<LiveMediaSnap | null> {
  const raw = await osascript(`
tell application "System Events"
  if not (exists process "Music") then return "none"
end tell
tell application "Music"
  set st to player state as string
  if st is "stopped" then return "none"
  try
    set t to name of current track
    set a to artist of current track
    set al to album of current track
    set pos to player position
    set dur to duration of current track
  on error
    return "none"
  end try
  return st & "|||" & t & "|||" & a & "|||" & al & "|||" & pos & "|||" & dur
end tell
`);
  const p = parsePipe(raw);
  if (p.length < 6) return null;
  const state: 0 | 1 | 2 = p[0] === "playing" ? 1 : p[0] === "paused" ? 2 : 0;
  if (state === 0) return null;
  return {
    hasMedia: true,
    state,
    title: p[1] || "",
    artist: p[2] || "",
    album: p[3] || "",
    albumArtist: p[2] || "",
    position: num(p[4]),
    duration: num(p[5]),
    app: "Music",
    hasArtwork: false,
    source: "applescript",
  };
}

async function readSpotify(): Promise<LiveMediaSnap | null> {
  const raw = await osascript(`
tell application "System Events"
  if not (exists process "Spotify") then return "none"
end tell
tell application "Spotify"
  set st to player state as string
  if st is "stopped" then return "none"
  try
    set t to name of current track
    set a to artist of current track
    set al to album of current track
    set pos to player position
    set dur to duration of current track
  on error
    return "none"
  end try
  return st & "|||" & t & "|||" & a & "|||" & al & "|||" & pos & "|||" & dur
end tell
`);
  const p = parsePipe(raw);
  if (p.length < 6) return null;
  const state: 0 | 1 | 2 = p[0] === "playing" ? 1 : p[0] === "paused" ? 2 : 0;
  if (state === 0) return null;
  let duration = num(p[5]);
  let position = num(p[4]);
  if (duration > 10_000) {
    duration /= 1000;
    if (position > 10_000) position /= 1000;
  }
  return {
    hasMedia: true,
    state,
    title: p[1] || "",
    artist: p[2] || "",
    album: p[3] || "",
    albumArtist: p[2] || "",
    position,
    duration,
    app: "Spotify",
    hasArtwork: false,
    source: "applescript",
  };
}

async function readViaAppleScript(): Promise<LiveMediaSnap> {
  const [music, spotify] = await Promise.all([readMusic(), readSpotify()]);
  const playing = [music, spotify].find((m) => m && m.state === 1);
  if (playing) return playing;
  const paused = [music, spotify].find((m) => m && m.state === 2);
  if (paused) return paused;
  return { ...EMPTY_MEDIA, source: "applescript" };
}

async function controlViaAppleScript(action: MediaControl, app: string): Promise<void> {
  if (app !== "Music" && app !== "Spotify") return;
  const cmd =
    action === "skipNext"
      ? "next track"
      : action === "skipPrevious"
        ? "previous track"
        : action === "play"
          ? "play"
          : action === "pause"
            ? "pause"
            : "playpause";
  await osascript(`tell application ${JSON.stringify(app)} to ${cmd}`);
}

// ---------- 前台窗口 ----------

async function readFrontWindowOnce(): Promise<LiveWindowSnap> {
  const raw = await osascript(`
tell application "System Events"
  set p to first application process whose frontmost is true
  set appName to name of p
  set winTitle to ""
  try
    set winTitle to name of front window of p
  end try
  return appName & "|||" & winTitle
end tell
`);
  const p = parsePipe(raw);
  if (p.length < 1) return { ...EMPTY_WINDOW };
  return { app: p[0] || "", title: p[1] || "", url: "" };
}

// ---------- 后台服务（单例缓存）----------

type LiveService = {
  media: LiveMediaSnap;
  window: LiveWindowSnap;
  backend: "media-control" | "applescript" | "none";
  started: boolean;
};

const service: LiveService = {
  media: { ...EMPTY_MEDIA },
  window: { ...EMPTY_WINDOW },
  backend: "none",
  started: false,
};

let mediaTimer: ReturnType<typeof setInterval> | null = null;
let windowTimer: ReturnType<typeof setInterval> | null = null;
let streamProc: ChildProcess | null = null;
let streamBuf = "";

function applyMedia(next: LiveMediaSnap) {
  service.media = next;
  if (next.source !== "none") service.backend = next.source;
}

function applyMediaControlRaw(raw: unknown) {
  applyMedia(fromMediaControlJson(raw, service.media));
}

async function pollAppleScriptMedia() {
  try {
    applyMedia(await readViaAppleScript());
  } catch {
    /* 单轮失败保留旧缓存 */
  }
}

async function pollWindow() {
  try {
    service.window = await readFrontWindowOnce();
  } catch {
    /* keep */
  }
}

function startMediaControlStream(bin: string) {
  stopStream();
  try {
    // --no-diff：每次全量，避免增量吞掉 title；--debounce 降噪
    const child = spawn(bin, ["stream", "--no-diff", "--debounce=250"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    streamProc = child;
    streamBuf = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      streamBuf += chunk;
      let idx: number;
      while ((idx = streamBuf.indexOf("\n")) >= 0) {
        const line = streamBuf.slice(0, idx).trim();
        streamBuf = streamBuf.slice(idx + 1);
        if (!line) continue;
        if (line === "null") {
          serviceArtwork = null;
          applyMedia({ ...EMPTY_MEDIA, source: "media-control" });
          continue;
        }
        try {
          applyMediaControlRaw(JSON.parse(line));
        } catch {
          /* 坏行忽略 */
        }
      }
    });
    child.on("exit", () => {
      streamProc = null;
      if (service.started && service.backend === "media-control" && !mediaTimer) {
        mediaTimer = setInterval(() => {
          void mediaControlGet(bin).then(applyMedia);
        }, MEDIA_POLL_MS);
        mediaTimer.unref?.();
        void mediaControlGet(bin).then(applyMedia);
      }
    });
  } catch {
    mediaTimer = setInterval(() => {
      void mediaControlGet(bin).then(applyMedia);
    }, MEDIA_POLL_MS);
    mediaTimer.unref?.();
    void mediaControlGet(bin).then(applyMedia);
  }
}

function stopStream() {
  if (streamProc) {
    try {
      streamProc.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    streamProc = null;
  }
}

/**
 * 启动后台采集（幂等）。Vite 插件 configureServer 时调一次即可。
 */
export async function startLiveSystemService(): Promise<{ backend: LiveService["backend"] }> {
  if (service.started) return { backend: service.backend };
  service.started = true;

  if (process.platform !== "darwin") {
    service.backend = "none";
    return { backend: "none" };
  }

  const bin = await resolveMediaControl();
  if (bin) {
    service.backend = "media-control";
    // 先 get 一次立刻有值，再 stream 差分
    applyMedia(await mediaControlGet(bin));
    startMediaControlStream(bin);
  } else {
    service.backend = "applescript";
    await pollAppleScriptMedia();
    mediaTimer = setInterval(() => void pollAppleScriptMedia(), MEDIA_POLL_MS);
    mediaTimer.unref?.();
  }

  await pollWindow();
  windowTimer = setInterval(() => void pollWindow(), WINDOW_POLL_MS);
  windowTimer.unref?.();

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

/** 兼容旧调用：确保服务已起，再返回最新媒体（必要时等一轮采集） */
export async function readNowPlaying(): Promise<LiveMediaSnap> {
  await startLiveSystemService();
  // AppleScript 路径下缓存可能刚启动仍空，补一次
  if (service.backend === "applescript" && !service.media.hasMedia) {
    await pollAppleScriptMedia();
  }
  if (service.backend === "media-control" && !service.media.hasMedia) {
    const bin = await resolveMediaControl();
    if (bin) applyMedia(await mediaControlGet(bin));
  }
  return service.media;
}

export async function readFrontWindow(): Promise<LiveWindowSnap> {
  await startLiveSystemService();
  if (!service.window.app) await pollWindow();
  return service.window;
}

/** 控制当前系统正在播放；成功后刷新缓存 */
export async function controlNowPlaying(action: MediaControl): Promise<LiveMediaSnap> {
  await startLiveSystemService();
  const bin = await resolveMediaControl();
  if (bin && service.backend === "media-control") {
    await mediaControlSend(bin, action);
    await new Promise((r) => setTimeout(r, 150));
    applyMedia(await mediaControlGet(bin));
    return service.media;
  }
  const app = service.media.app;
  await controlViaAppleScript(action, app);
  await new Promise((r) => setTimeout(r, 150));
  await pollAppleScriptMedia();
  return service.media;
}
