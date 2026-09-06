/**
 * 宿主模拟中间件（Vite 插件）
 *
 * 独立测试台里没有 Tauri，本文件用 Vite dev server 复刻 WallpaperEM 原生侧
 * `src-tauri/src/content_server.rs` 暴露给渲染器页的那几个 HTTP 端点，
 * 使 `renderer/src/main.ts` 可以与主项目保持逐字节一致、不做任何改造。
 *
 * 复刻的端点：
 *   GET /media/{token}/{itemId}/{path...}  壁纸包资源（scene.pkg、project.json…）
 *   GET /web/{token}/{itemId}/{path...}    网页壁纸站点根；.html 响应注入 WE shim
 *                                          （同源原始 URL，避免 blob origin null 弄坏 Spine）
 *   GET /diag?msg=...                      渲染器诊断上报 → 打到 dev server 终端
 *   GET /default-wallpaper/index.html      降级默认壁纸（由 public/ 静态提供）
 *
 * 额外提供测试台自己用的：
 *   GET /api/library                       扫描壁纸库，列出可测试条目
 *   POST /api/library-dir                  运行时改壁纸库目录（body `{dir}` 或 `{pick:true}` 调系统选文件夹）
 *   POST /api/reveal                       用系统文件管理器打开指定壁纸目录（body `{itemId}`）
 *   POST /api/delete                       删除壁纸目录，优先移入系统废纸篓（body `{itemId}`）
 *   GET /api/diag-stream                   把 /diag 上报实时广播给测试台页面（SSE）
 *   GET /api/props?item=                   壁纸自定义属性定义（含本地化文案与当前值）
 *   POST /api/props?item=                  保存属性覆盖值（body 为 name→wire 值）
 *   POST /api/props-file?item=&name=       上传 file/scenetexture 所选文件，拷入壁纸 we-props/
 *   POST /api/props-dir                    系统选文件夹（directory 属性，存绝对路径）
 *   GET /api/system/artwork                当前曲目封面（image/jpeg 等）
 *   GET /api/system/media                  系统正在播放（Node 缓存；?fresh=1 强制刷新）
 *   GET /api/system/window                 前台窗口标题
 *   GET /api/system/stream                 媒体+窗口合并 SSE（读缓存 ~2Hz）
 *   POST /api/system/media-control         切歌/播放/暂停 → 当前播放器
 *   GET /audio-stream/{token}              对齐 WallpaperEM；测试台无 SCK 时 503
 *
 * 媒体元数据由 host/system-live.ts 在 Node 进程内采集（media-control 或 AppleScript），
 * 不依赖浏览器 MediaSession。
 */
import { createReadStream, promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { extname, join, normalize, resolve, sep } from "node:path";
import { homedir } from "node:os";
import type { Connect, Plugin, ViteDevServer } from "vite";
import { describe, overrideProps, readOverrides, writeOverrides } from "./we-props";
import { injectWebShim, isHtmlPath } from "./we-web-html.mjs";
import {
  controlNowPlaying,
  getCachedArtwork,
  getCachedMedia,
  getCachedWindow,
  getLiveBackend,
  readFrontWindow,
  readNowPlaying,
  startLiveSystemService,
  type MediaControl,
} from "./system-live";

/** 与原生侧一致的媒体访问 token；独立测试台无鉴权需求，固定值方便手拼 URL */
export const DEV_TOKEN = "dev";

/** 壁纸库目录：默认取 WallpaperEM 在 macOS 上的应用数据目录，可用 WE_LIBRARY 覆盖 */
export function libraryDir(): string {
  const env = process.env.WE_LIBRARY;
  if (env) return resolve(env);
  return join(
    homedir(),
    "Library",
    "Application Support",
    "io.github.oneincase.wallpaperem",
    "wallpapers",
  );
}

const execFileAsync = promisify(execFile);

/** macOS 系统「选择文件夹」；取消或非 darwin 返回 null */
async function pickFolderNative(
  defaultDir: string,
  prompt = "选择壁纸库文件夹",
): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  const fallback = defaultDir || homedir();
  const script =
    `try\n` +
    `  POSIX path of (choose folder with prompt ${JSON.stringify(prompt)} default location POSIX file ${JSON.stringify(fallback)})\n` +
    `on error\n` +
    `  return ""\n` +
    `end try`;
  try {
    const { stdout } = await execFileAsync("osascript", ["-e", script], {
      timeout: 180_000,
      encoding: "utf8",
    });
    const p = stdout.trim().replace(/\/+$/, "");
    return p || null;
  } catch {
    return null;
  }
}

async function asDirectory(dir: string): Promise<string | null> {
  const resolved = resolve(dir);
  try {
    const st = await fs.stat(resolved);
    return st.isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

/** 在系统文件管理器中打开目录（macOS Finder / Windows 资源管理器 / xdg-open） */
async function revealFolder(dir: string): Promise<void> {
  if (process.platform === "darwin") {
    await execFileAsync("open", [dir]);
    return;
  }
  if (process.platform === "win32") {
    await new Promise<void>((resolveP) => {
      execFile("explorer", [dir], () => resolveP());
    });
    return;
  }
  await execFileAsync("xdg-open", [dir]);
}

/**
 * 删除壁纸目录。优先移入系统废纸篓（可反悔），废纸篓机制不可用才真删：
 * macOS 走 Finder、Windows 走回收站、Linux 走 gio trash；gio 不可用（无桌面会话）时
 * 回退直接删 —— 前端已有确认框兜底。
 */
async function deleteFolder(dir: string): Promise<void> {
  if (process.platform === "darwin") {
    const script = `tell application "Finder" to delete (POSIX file ${JSON.stringify(dir)} as alias)`;
    await execFileAsync("osascript", ["-e", script], { timeout: 30_000 });
    return;
  }
  if (process.platform === "win32") {
    const script =
      "Add-Type -AssemblyName Microsoft.VisualBasic; " +
      `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(` +
      `'${dir.replace(/'/g, "''")}', 'OnlyErrorDialogs', 'SendToRecycleBin')`;
    await execFileAsync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: 60_000 },
    );
    return;
  }
  try {
    await execFileAsync("gio", ["trash", dir], { timeout: 30_000 });
  } catch {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  // pano2vr 等播放器用 XHR responseXML 解析配置——非 XML MIME 时 responseXML 恒为
  // null（3406740580 黑屏：pano.xml 以 octet-stream 下发，贴图一张都不加载）
  ".xml": "application/xml",
  ".m4a": "audio/mp4",
  ".m4v": "video/mp4",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff2": "font/woff2",
  ".pkg": "application/octet-stream",
};

/** 目录穿越防护：把相对路径规范化后必须仍在 base 内 */
function safeJoin(base: string, rel: string): string | null {
  const target = resolve(base, normalize(rel).replace(/^([/\\]|\.\.([/\\]|$))+/, ""));
  if (target !== base && !target.startsWith(base + sep)) return null;
  return target;
}

async function statFile(p: string) {
  try {
    const st = await fs.stat(p);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

/**
 * 把磁盘文件 pipe 到响应，并**等到流结束才返回**。
 *
 * Vite 的 configureServer 中间件是 async 的：Promise resolve 时若
 * `res.writableEnded` 仍为 false，后续 html-fallback 会接着写同一条响应。
 * 小文件（3–4MB）往往在微任务跑到之前就送完；8MB+ 的 scene.pkg 还在传，
 * 连接被掐，浏览器 `arrayBuffer()` 抛 `TypeError: Failed to fetch`。
 * 日志形态是 `pkg fetch: HTTP 200` 紧接着 `failed: Failed to fetch`，
 * 像壁纸坏了，其实 body 根本没读完。
 */
function pipeFile(
  file: string,
  res: any,
  opts?: { start?: number; end?: number },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(file, opts);
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      stream.off("error", onError);
      res.off("close", onClose);
      res.off("finish", onFinish);
      if (err) {
        stream.destroy();
        if (!res.writableEnded) {
          if (!res.headersSent) {
            res.statusCode = 500;
            res.end(String(err.message || err));
          } else {
            res.destroy();
          }
        }
        reject(err);
        return;
      }
      resolve();
    };
    const onError = (err: Error) => finish(err);
    const onFinish = () => finish();
    // 客户端中途断开（切壁纸 abort）不是服务端错误，resolve 以免 Vite 再写 500
    const onClose = () => {
      stream.destroy();
      finish();
    };
    stream.on("error", onError);
    res.on("finish", onFinish);
    res.on("close", onClose);
    stream.pipe(res);
  });
}

/**
 * 带 Range 支持的静态文件响应（视频纹理 seek 需要 206）。
 * `transform` 用于在响应前改写小文本文件（project.json 合并属性覆盖值）；
 * 改写后的体积与磁盘不同，故走整体响应、不参与 Range。
 */
async function sendFile(
  req: Connect.IncomingMessage,
  res: any,
  file: string,
  transform?: (raw: Buffer) => Promise<Buffer>,
) {
  const st = await statFile(file);
  if (!st) {
    res.statusCode = 404;
    res.end("Not Found");
    return;
  }
  const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
  res.setHeader("Content-Type", type);
  res.setHeader("Accept-Ranges", "bytes");
  // 渲染器页与媒体端点在测试台里同源，但保留 CORS 头以便将来分端口调试
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (transform) {
    // project.json 会合并覆盖值，体积/内容随用户改属性变化，不能按文件 mtime 缓存
    res.setHeader("Cache-Control", "no-cache");
    const out = await transform(await fs.readFile(file));
    res.statusCode = 200;
    res.setHeader("Content-Length", String(out.length));
    res.end(out);
    return;
  }

  // scene.pkg 动辄上百 MB。按 size+mtime 给 ETag，重复挂载/刷新走 304，
  // 浏览器磁盘缓存也可命中，避免每次把整包再推一遍。
  // 配置/文档类（xml/json/html）改 no-cache：体积小走 304 协商即可，长缓存会让
  // MIME/内容修正被旧响应污染一天（3406740580 的 pano.xml 黑屏复活路径）。
  const fileExt = extname(file).toLowerCase();
  const isConfig = fileExt === ".xml" || fileExt === ".json" || fileExt === ".html" || fileExt === ".htm";
  const etag = `"${st.size.toString(16)}-${Math.trunc(st.mtimeMs).toString(16)}"`;
  res.setHeader("ETag", etag);
  res.setHeader("Cache-Control", isConfig ? "no-cache" : "private, max-age=86400");
  if (req.headers["if-none-match"] === etag) {
    res.statusCode = 304;
    res.end();
    return;
  }

  const range = req.headers.range;
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range);
  if (m) {
    const start = m[1] ? Number(m[1]) : 0;
    const end = m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
    if (start > end || start >= st.size) {
      res.statusCode = 416;
      res.setHeader("Content-Range", `bytes */${st.size}`);
      res.end();
      return;
    }
    res.statusCode = 206;
    res.setHeader("Content-Range", `bytes ${start}-${end}/${st.size}`);
    res.setHeader("Content-Length", String(end - start + 1));
    await pipeFile(file, res, { start, end });
    return;
  }
  res.statusCode = 200;
  res.setHeader("Content-Length", String(st.size));
  await pipeFile(file, res);
}

/** 1x1 透明 GIF：/diag 上报用 <img> 发起，需要回一个合法图片 */
const PIXEL = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);

/**
 * 把用户属性覆盖值合并进 project.json 响应体。
 *
 * 覆盖值写回 `general.properties[name].value`，并给被覆盖的属性打上
 * `userOverridden: true` 标记。标记是必需的：scene.json 里每个受属性控制的字段都自带
 * `{user, value}` 快照，而这些快照与 project.json 默认值并非总是相等（本机 78 个场景
 * 2598 处引用里有 372 处不等）。渲染器据此只在**用户显式改过**该属性时才采用属性表的值，
 * 其余仍沿用场景内快照 —— 否则用户什么都没改，画面就先变了样。
 *
 * 主项目的内容服务器同样可以做这层合并（`we_props::effective_props` 已有覆盖值）；
 * 没有标记时渲染器退回场景快照，即现有行为，故两侧新旧组合都安全。
 */
async function mergeProjectOverrides(raw: Buffer, itemId: string): Promise<Buffer> {
  const overrides = await readOverrides(itemId);
  if (Object.keys(overrides).length === 0) return raw;
  let project: any;
  try {
    project = JSON.parse(raw.toString("utf8").replace(/^\uFEFF/, ""));
  } catch {
    return raw; // 非法 JSON：原样透传，交给渲染器自己的容错
  }
  const props = project?.general?.properties;
  if (!props || typeof props !== "object") return raw;
  for (const [name, value] of Object.entries(overrides)) {
    const def = props[name];
    if (!def || typeof def !== "object") continue; // 属性已被作者移除：陈旧覆盖值忽略
    def.value = value;
    def.userOverridden = true;
  }
  return Buffer.from(JSON.stringify(project), "utf8");
}

/** 读取请求体（属性保存用；测试台本地请求，限 4MB 足够） */
async function readBody(req: Connect.IncomingMessage): Promise<string> {
  const buf = await readRawBody(req, 4 * 1024 * 1024);
  return buf.toString("utf8");
}

/** 读取原始请求体，超限抛错。file 属性上传用较大上限（视频）。 */
async function readRawBody(req: Connect.IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    const b = c as Buffer;
    size += b.length;
    if (size > max) throw new Error("请求体过大");
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

/** 上传文件名：只要 basename，去掉路径分隔与奇怪字符 */
function safeUploadName(raw: string): string {
  let s = raw;
  try {
    s = decodeURIComponent(raw);
  } catch {
    /* 非百分号编码则原样用 */
  }
  const base = s.replace(/\\/g, "/").split("/").pop() || "file";
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  return cleaned.slice(0, 80) || "file";
}

/** we-props/ 下的目标文件名：属性名前缀防冲突，超长名截断 */
function destPropFileName(propName: string, original: string): string {
  const prefix = propName.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "prop";
  return `${prefix}_${safeUploadName(original)}`;
}

function sendJson(res: any, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(text);
}

/** 扫描壁纸库：返回 { itemId, title, type, hasScene, hasPreview } 列表 */
async function scanLibrary(dir: string) {
  let names: string[] = [];
  try {
    names = (await fs.readdir(dir, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name);
  } catch {
    return { dir, items: [], error: `壁纸库目录不存在：${dir}` };
  }
  const items = await Promise.all(
    names.sort().map(async (itemId) => {
      const base = join(dir, itemId);
      let project: any = null;
      try {
        project = JSON.parse(await fs.readFile(join(base, "project.json"), "utf8"));
      } catch {
        /* 无 project.json 也允许，靠文件探测判类型 */
      }
      const hasScene =
        !!(await statFile(join(base, "scene.pkg"))) ||
        !!(await statFile(join(base, "scenes", "scene.pkg")));
      const preview: string | undefined = project?.preview;
      const hasPreview = preview ? !!(await statFile(join(base, preview))) : false;
      // project.json 的 file 字段是入口（scene.json / *.mp4 / index.html）
      const file: string | undefined = project?.file;
      return {
        itemId,
        title: project?.title ?? itemId,
        type: project?.type ?? (hasScene ? "scene" : "unknown"),
        file,
        preview: hasPreview ? preview : undefined,
        hasScene,
        properties: project?.general?.properties ?? null,
      };
    }),
  );
  return { dir, items };
}

export function wallpaperHost(): Plugin {
  let lib = libraryDir();
  /** 已连接的测试台 SSE 客户端（用于把 /diag 上报回显到页面日志区） */
  const diagClients = new Set<any>();
  return {
    name: "we-scene-renderer:wallpaper-host",
    configureServer(server: ViteDevServer) {
      server.config.logger.info(`[host] 壁纸库目录：${lib}`);
      void startLiveSystemService().then(({ backend }) => {
        if (backend === "media-control") {
          server.config.logger.info(
            `[host] 系统媒体：media-control（系统级 Now Playing）`,
          );
        } else if (backend === "applescript") {
          server.config.logger.info(
            `[host] 系统媒体：AppleScript（Music/Spotify）；安装 brew install media-control 可覆盖浏览器等全部播放源`,
          );
        } else {
          server.config.logger.info(`[host] 系统媒体：当前平台无采集后端`);
        }
      });

      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const path = decodeURIComponent(url.pathname);

        // --- 渲染器诊断上报（对齐 content_server.rs 的 /diag）---
        if (path === "/diag") {
          const msg = url.searchParams.get("msg") ?? "";
          server.config.logger.info(`\x1b[36m[renderer diag]\x1b[0m ${msg}`);
          const line = `data: ${JSON.stringify({ t: Date.now(), msg })}\n\n`;
          for (const c of diagClients) {
            try {
              c.write(line);
            } catch {
              diagClients.delete(c);
            }
          }
          res.statusCode = 200;
          res.setHeader("Content-Type", "image/gif");
          res.setHeader("Cache-Control", "no-store");
          res.end(PIXEL);
          return;
        }

        // --- 测试台专用：诊断日志实时流 ---
        if (path === "/api/diag-stream") {
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/event-stream");
          res.setHeader("Cache-Control", "no-store");
          res.setHeader("Connection", "keep-alive");
          res.write(": connected\n\n");
          diagClients.add(res);
          req.on("close", () => diagClients.delete(res));
          return;
        }

        // --- 系统实况：专辑封面（二进制；不进 SSE）---
        if (path === "/api/system/artwork") {
          await startLiveSystemService();
          const art = getCachedArtwork();
          if (!art) {
            res.statusCode = 404;
            res.setHeader("Content-Type", "text/plain; charset=utf-8");
            res.end("no artwork");
            return;
          }
          res.statusCode = 200;
          res.setHeader("Content-Type", art.mime);
          res.setHeader("Cache-Control", "no-store");
          res.setHeader("Access-Control-Allow-Origin", "*");
          res.end(art.data);
          return;
        }

        // --- 系统实况：正在播放（读 Node 缓存；首次可强制刷新）---
        if (path === "/api/system/media") {
          const fresh = url.searchParams.get("fresh") === "1";
          const media = fresh ? await readNowPlaying() : (await startLiveSystemService(), getCachedMedia());
          sendJson(res, 200, { ...media, backend: getLiveBackend() });
          return;
        }

        // --- 系统实况：前台窗口 ---
        if (path === "/api/system/window") {
          const fresh = url.searchParams.get("fresh") === "1";
          const win = fresh ? await readFrontWindow() : (await startLiveSystemService(), getCachedWindow());
          sendJson(res, 200, win);
          return;
        }

        // --- 系统实况：媒体控制（壁纸 engine.media.*）---
        if (path === "/api/system/media-control") {
          if (req.method !== "POST") {
            sendJson(res, 405, { error: "需要 POST" });
            return;
          }
          let body: { action?: unknown } = {};
          try {
            body = JSON.parse((await readBody(req)) || "{}");
          } catch {
            sendJson(res, 400, { error: "body 需为 JSON" });
            return;
          }
          const action = String(body.action || "") as MediaControl;
          const allowed: MediaControl[] = [
            "skipNext",
            "skipPrevious",
            "play",
            "pause",
            "playPause",
          ];
          if (!allowed.includes(action)) {
            sendJson(res, 400, { error: `未知 action：${action}` });
            return;
          }
          const media = await controlNowPlaying(action);
          sendJson(res, 200, media);
          return;
        }

        // --- 系统实况：媒体 + 窗口 SSE（读缓存，~2Hz；采集在后台单例）---
        if (path === "/api/system/stream") {
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/event-stream");
          res.setHeader("Cache-Control", "no-store");
          res.setHeader("Connection", "keep-alive");
          res.setHeader("Access-Control-Allow-Origin", "*");
          res.write(": connected\n\n");
          await startLiveSystemService();
          let closed = false;
          req.on("close", () => {
            closed = true;
          });
          const push = () => {
            if (closed) return;
            try {
              const payload = {
                media: getCachedMedia(),
                window: getCachedWindow(),
                backend: getLiveBackend(),
              };
              res.write(`data: ${JSON.stringify(payload)}\n\n`);
            } catch {
              /* 单轮失败不掐连接 */
            }
          };
          push();
          const timer = setInterval(push, 500);
          req.on("close", () => clearInterval(timer));
          return;
        }

        // --- 对齐 WallpaperEM：系统音频 SSE（测试台无 ScreenCaptureKit → 503）---
        if (path.startsWith("/audio-stream/")) {
          const tok = path.slice("/audio-stream/".length).split("/")[0];
          if (tok !== DEV_TOKEN) {
            res.statusCode = 403;
            res.setHeader("Content-Type", "text/plain; charset=utf-8");
            res.end("forbidden");
            return;
          }
          res.statusCode = 503;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.setHeader("Cache-Control", "no-store");
          res.end(
            "audio capture unavailable in test bench (no ScreenCaptureKit); use liveSystem mic",
          );
          return;
        }

        // --- 测试台专用：壁纸库清单 ---
        if (path === "/api/library") {
          const data = await scanLibrary(lib);
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.setHeader("Cache-Control", "no-store");
          res.end(JSON.stringify(data));
          return;
        }

        // --- 测试台专用：运行时切换壁纸库目录（不改 Vite / WE_LIBRARY）---
        if (path === "/api/library-dir") {
          if (req.method !== "POST") {
            sendJson(res, 405, { error: "需要 POST" });
            return;
          }
          let body: { dir?: unknown; pick?: unknown } = {};
          try {
            body = JSON.parse((await readBody(req)) || "{}");
          } catch {
            sendJson(res, 400, { error: "body 需为 JSON" });
            return;
          }
          let next = typeof body.dir === "string" ? body.dir.trim() : "";
          if (body.pick) {
            if (process.platform !== "darwin") {
              sendJson(res, 200, { dir: lib, cancelled: true, unsupported: true });
              return;
            }
            const picked = await pickFolderNative(lib);
            if (!picked) {
              sendJson(res, 200, { dir: lib, cancelled: true });
              return;
            }
            next = picked;
          }
          if (!next) {
            sendJson(res, 400, { error: "缺少 dir" });
            return;
          }
          const resolved = await asDirectory(next);
          if (!resolved) {
            sendJson(res, 400, { error: `不是有效目录：${next}` });
            return;
          }
          lib = resolved;
          server.config.logger.info(`[host] 壁纸库目录改为：${lib}`);
          sendJson(res, 200, { dir: lib, ok: true });
          return;
        }

        // --- 测试台专用：在文件管理器中打开壁纸目录 ---
        if (path === "/api/reveal") {
          if (req.method !== "POST") {
            sendJson(res, 405, { error: "需要 POST" });
            return;
          }
          let body: { itemId?: unknown } = {};
          try {
            body = JSON.parse((await readBody(req)) || "{}");
          } catch {
            sendJson(res, 400, { error: "body 需为 JSON" });
            return;
          }
          const itemId = typeof body.itemId === "string" ? body.itemId.trim() : "";
          if (!itemId || /[\\/]/.test(itemId) || itemId.includes("..")) {
            sendJson(res, 400, { error: "非法 itemId" });
            return;
          }
          const target = safeJoin(lib, itemId);
          if (!target) {
            sendJson(res, 403, { error: "路径非法" });
            return;
          }
          const resolved = await asDirectory(target);
          if (!resolved) {
            sendJson(res, 404, { error: `壁纸目录不存在：${itemId}` });
            return;
          }
          try {
            await revealFolder(resolved);
            sendJson(res, 200, { ok: true, dir: resolved });
          } catch (e) {
            sendJson(res, 500, { error: (e as Error).message });
          }
          return;
        }

        // --- 测试台专用：删除壁纸（优先移入废纸篓）---
        if (path === "/api/delete") {
          if (req.method !== "POST") {
            sendJson(res, 405, { error: "需要 POST" });
            return;
          }
          let body: { itemId?: unknown } = {};
          try {
            body = JSON.parse((await readBody(req)) || "{}");
          } catch {
            sendJson(res, 400, { error: "body 需为 JSON" });
            return;
          }
          const itemId = typeof body.itemId === "string" ? body.itemId.trim() : "";
          if (!itemId || /[\\/]/.test(itemId) || itemId.includes("..")) {
            sendJson(res, 400, { error: "非法 itemId" });
            return;
          }
          const target = safeJoin(lib, itemId);
          if (!target) {
            sendJson(res, 403, { error: "路径非法" });
            return;
          }
          const resolved = await asDirectory(target);
          if (!resolved) {
            sendJson(res, 404, { error: `壁纸目录不存在：${itemId}` });
            return;
          }
          try {
            await deleteFolder(resolved);
            server.config.logger.info(`[host] 已删除壁纸：${itemId}（${resolved}）`);
            sendJson(res, 200, { ok: true });
          } catch (e) {
            sendJson(res, 500, { error: (e as Error).message });
          }
          return;
        }

        // --- 测试台专用：壁纸自定义属性（GET 读定义 / POST 存覆盖值）---
        // 对齐主项目的 library_item_props / library_set_item_props 命令。
        if (path === "/api/props") {
          const itemId = url.searchParams.get("item") ?? "";
          if (!itemId) {
            sendJson(res, 400, { error: "缺少 item 参数" });
            return;
          }
          if (req.method === "POST") {
            try {
              const parsed = JSON.parse((await readBody(req)) || "{}");
              if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                sendJson(res, 400, { error: "body 需为 name→值 的对象" });
                return;
              }
              await writeOverrides(itemId, parsed);
              sendJson(res, 200, { ok: true, count: Object.keys(parsed).length });
            } catch (e) {
              sendJson(res, 400, { error: (e as Error).message });
            }
            return;
          }
          sendJson(res, 200, { itemId, props: await describe(lib, itemId) });
          return;
        }

        // --- file/scenetexture：浏览器选中的文件拷入壁纸 we-props/，返回相对壁纸根的路径 ---
        // 对齐主项目 library_set_item_prop_file（那边走 tauri dialog + 同目录拷贝）。
        if (path === "/api/props-file") {
          if (req.method !== "POST") {
            sendJson(res, 405, { error: "需要 POST" });
            return;
          }
          const itemId = url.searchParams.get("item") ?? "";
          const propName = url.searchParams.get("name") ?? "";
          if (!itemId || !propName) {
            sendJson(res, 400, { error: "缺少 item 或 name" });
            return;
          }
          const defs = await describe(lib, itemId);
          const def = defs.find((d) => d.name === propName);
          if (!def || (def.ptype !== "file" && def.ptype !== "scenetexture")) {
            sendJson(res, 400, { error: "不是文件类型属性" });
            return;
          }
          const itemBase = safeJoin(lib, itemId);
          if (!itemBase) {
            sendJson(res, 400, { error: "非法 item" });
            return;
          }
          try {
            const rawName =
              typeof req.headers["x-filename"] === "string" ? req.headers["x-filename"] : "file";
            const destName = destPropFileName(propName, rawName);
            const destDir = join(itemBase, "we-props");
            await fs.mkdir(destDir, { recursive: true });
            const dest = safeJoin(destDir, destName);
            if (!dest) {
              sendJson(res, 400, { error: "非法文件名" });
              return;
            }
            const buf = await readRawBody(req, 64 * 1024 * 1024);
            if (buf.length === 0) {
              sendJson(res, 400, { error: "空文件" });
              return;
            }
            await fs.writeFile(dest, buf);
            sendJson(res, 200, { value: `we-props/${destName}` });
          } catch (e) {
            sendJson(res, 400, { error: (e as Error).message });
          }
          return;
        }

        // --- directory：系统选文件夹，存绝对路径（与 WE / 主项目语义一致，不拷贝）---
        if (path === "/api/props-dir") {
          if (req.method !== "POST") {
            sendJson(res, 405, { error: "需要 POST" });
            return;
          }
          if (process.platform !== "darwin") {
            sendJson(res, 200, { cancelled: true, unsupported: true });
            return;
          }
          const picked = await pickFolderNative(homedir(), "选择目录");
          if (!picked) {
            sendJson(res, 200, { cancelled: true });
            return;
          }
          sendJson(res, 200, { value: picked });
          return;
        }

        // --- 壁纸包资源：/media/{token}/{itemId}/{path...}（/web 同源同盘）---
        const seg = path.replace(/^\/+/, "").split("/");
        if (seg[0] === "media" || seg[0] === "web") {
          if (seg[1] !== DEV_TOKEN) {
            res.statusCode = 401;
            res.end("Unauthorized");
            return;
          }
          const itemId = seg[2];
          if (!itemId) {
            res.statusCode = 404;
            res.end("Not Found");
            return;
          }
          const itemBase = safeJoin(lib, itemId);
          if (!itemBase) {
            res.statusCode = 403;
            res.end("Forbidden");
            return;
          }
          const rel = seg.slice(3).join("/");
          let target = safeJoin(itemBase, rel);
          if (!target) {
            res.statusCode = 403;
            res.end("Forbidden");
            return;
          }
          // 目录 → index.html（网页壁纸站点根，对齐原生侧行为）
          try {
            if ((await fs.stat(target)).isDirectory()) target = join(target, "index.html");
          } catch {
            /* 不存在则交给 sendFile 回 404 */
          }
          // project.json 响应合并用户属性覆盖值，使渲染器读到当前生效配置
          const isProject = rel === "project.json";
          // 网页壁纸 HTML：注入 WE shim（与原生 content_server 对齐）。
          // 必须在同源 URL 上注入，不能靠渲染器 blob——Spine/WebGL 在 origin null 下贴图跨域失败。
          const htmlInject =
            (seg[0] === "web" || seg[0] === "media") && isHtmlPath(target)
              ? async (raw: Buffer) =>
                  Buffer.from(injectWebShim(raw.toString("utf8")), "utf8")
              : undefined;
          const transform = isProject
            ? (raw: Buffer) => mergeProjectOverrides(raw, itemId)
            : htmlInject;
          await sendFile(req, res, target, transform);
          return;
        }

        next();
      });
    },
  };
}
