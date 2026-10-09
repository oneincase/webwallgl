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
 *   GET /api/library                       扫描壁纸库，列出可测试条目（类型/入口/封面判据见
 *                                          we-library-scan.mjs，与原生 library.rs、perf-bench 共用一份）
 *   POST /api/library-dir                  运行时改壁纸库目录（body `{dir}` 或 `{pick:true}` 调系统选文件夹）
 *   GET /api/fx-library                    **只读**枚举库内效果目录（`effects/<目录名>/effect.json`，
 *                                          带 effect.json 元数据、pass/material 清单、combos 与依赖文件文本）。
 *                                          库内文件留在库里不复制、不写回；工程只写引用（计划 §6 决策 5 = (a)）
 *   POST /api/reveal                       用系统文件管理器打开指定壁纸目录（body `{itemId}`）
 *   POST /api/delete                       删除壁纸目录，优先移入系统废纸篓（body `{itemId}`）
 *   POST /api/editor/save-begin?item=      编辑器另存：新建（或清空编辑器自建的）库内松散工程目录
 *   POST /api/editor/save-file?item=&path= 编辑器另存：写入一个文件（body 为原始字节）
 *   GET /api/editor/web-manifest?item=     网页壁纸工程（type:"web"）入口与资源清单
 *   GET /api/editor/web-resolve?item=&path=[&raw=1] 工程内相对路径 → 可取的 /web/... URL（raw=1 要元字节）
 *   GET /api/diag-stream                   把 /diag 上报实时广播给测试台页面（SSE）
 *   GET /api/plugins                       编辑器外部插件目录清单（host/plugin-dirs.ts）
 *   GET /api/plugins/file?dir=&path=       读插件目录里的一个文件
 *   GET /api/props?item=                   壁纸自定义属性定义（含本地化文案与当前值）
 *   POST /api/props?item=                  保存属性覆盖值（body 为 name→wire 值）
 *   POST /api/props-file?item=&name=       上传 file/scenetexture 所选文件，拷入壁纸 we-props/
 *   POST /api/props-dir                    系统选文件夹（directory 属性，存绝对路径）
 *   GET /api/system/artwork                当前曲目封面（image/jpeg 等）
 *   GET /api/system/media                  系统正在播放（Node 缓存；?fresh=1 强制刷新）
 *   GET /api/system/window                 前台窗口标题
 *   GET /api/system/stream                 媒体+窗口+频谱 SSE（媒体 ~2Hz，频谱随 media-bridge 帧率）
 *   POST /api/system/media-control         切歌/播放/暂停 → 当前播放器
 *   GET /audio-stream/{token}              对齐 WallpaperEM；测试台无 SCK 时 503
 *
 * 媒体元数据与系统音频由 host/system-live.ts 经 media-bridge 子进程在 Node 侧采集
 * （Now Playing + 系统输出频谱，浏览器不再采麦克风），不依赖浏览器 MediaSession。
 */
import { createReadStream, promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { extname, join, normalize, resolve, sep } from "node:path";
import { homedir } from "node:os";
import type { Connect, Plugin, PreviewServer, ViteDevServer } from "vite";
import { describe, overrideProps, readOverrides, writeOverrides } from "./we-props";
import { listPluginDirs, readPluginFile } from "./plugin-dirs";
import { injectWebShim, isHtmlPath } from "./we-web-html.mjs";
import {
  SCENE_PKG_PATHS,
  WEB_ENTRY_PATHS,
  classifyWallpaper,
  isLooseSceneProject,
  pickEntryFile,
  pickPreviewFile,
} from "./we-library-scan.mjs";
import {
  WEB_MANIFEST_MAX_FILES,
  listWebProjectFiles,
  normalizeWebRelPath,
  pickWebEntry,
  webAssetUrl,
} from "./we-web-project.mjs";
import {
  controlNowPlaying,
  getAudioStatus,
  getCachedArtwork,
  getCachedMedia,
  getCachedWindow,
  getLiveBackend,
  onAudioFrame,
  readFrontWindow,
  readNowPlaying,
  startLiveSystemService,
  type MediaControl,
} from "./system-live";

/** 编辑器保存产物的目录标记：有它才允许 /api/editor/save-* 覆盖该目录 */
const EDITOR_MARK = ".webwallgl-editor";

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

/**
 * 本机引擎内置素材目录（贴图 / 法线 / 渐变 / LUT …）。
 *
 * 这些是 Wallpaper Engine 安装目录自带的公共素材（官方 `assets/` 树），
 * **受版权保护、永不入库**：仓库只留程序化复刻（system-textures.js /
 * particle-textures.js / gradient-textures.js），谁本机想按原版观感测试，
 * 就把官方 assets 树拷到本仓库 `local-assets/`（顶层平铺 `local-assets/materials/**`，
 * .gitignore 已忽略整个 `local-assets/`），或旧布局 `local-assets/mirage/materials/**`，
 * 或用 `WE_LOCAL_ASSETS=/abs/path` 指向别处（例如 Mirage 的 assets 目录）。
 *
 * 探测要求 `<dir>/materials` 存在：渲染端只按名字消费贴图（`util/*` 急切 +
 * `particle/**` / `gradient/*` 等按需，见 renderer/src/local-assets.ts），
 * 只拷了 `effects/`、`fonts/` 等非贴图目录不算数。一个源都不满足 = 端点返回
 * `{ok:false}`，渲染器整条路径跳过、照旧走程序化复刻，行为与无素材完全一致。
 * 优先级（渲染端取探测通过的第一个）：env 显式指定 > 顶层平铺 > mirage 旧布局。
 */
export function localAssetProviders(): Array<{ id: string; dir: string }> {
  const out: Array<{ id: string; dir: string }> = [];
  const env = process.env.WE_LOCAL_ASSETS;
  if (env) out.push({ id: "env", dir: resolve(env) });
  out.push({ id: "local", dir: join(resolve("."), "local-assets") });
  out.push({ id: "mirage", dir: join(resolve("."), "local-assets", "mirage") });
  return out;
}

/** 素材名清单缓存：dir → { names, at }（扫 586 个文件不值得每次挂载都做） */
const localAssetIndexCache = new Map<string, { names: string[]; at: number }>();

/** 扫描 materials 目录下全部 `.tex` → 引擎名（相对 materials 的路径去掉扩展名） */
async function listLocalAssetNames(dir: string): Promise<string[]> {
  const hit = localAssetIndexCache.get(dir);
  if (hit && Date.now() - hit.at < 60_000) return hit.names;
  const base = join(dir, "materials");
  const names: string[] = [];
  const walk = async (d: string, prefix: string): Promise<void> => {
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = (await fs.readdir(d, { withFileTypes: true })) as never;
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await walk(join(d, e.name), rel);
      } else if (e.isFile() && e.name.endsWith(".tex")) {
        names.push(rel.slice(0, -4));
      }
    }
  };
  await walk(base, "");
  names.sort();
  localAssetIndexCache.set(dir, { names, at: Date.now() });
  return names;
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
      // 类型判定走共用模块（与 perf-bench 同一份、也与原生 library.rs 同规则）：
      // 此前这里只做 `project.type ?? (hasScene ? scene : unknown)` 且 hasScene 不认
      // gifscene.pkg，于是两个条目在测试台的**任何标签里都不出现**：843532366
      // （GIF 导入模板场景，场景包叫 gifscene.pkg）+ 4_15488492008902
      // （无 project.json 的单文件 mp4）。原生库对同一目录给出 321 场景 / 11 视频，
      // 测试台是 320 / 10。
      let dirNames: string[] = [];
      try {
        dirNames = await fs.readdir(base);
      } catch {
        /* 读不到目录名：按无内容推断 */
      }
      const probe = async (rel: string) => !!(await statFile(join(base, rel)));
      let hasScene = false;
      for (const rel of SCENE_PKG_PATHS) {
        if (await probe(rel)) {
          hasScene = true;
          break;
        }
      }
      // 松散工程（源码目录）形态：WE 编辑器工程没有 scene.pkg，入口是 project.json
      // 的 `file` 指向的 json（scene.json / audiophile.json…）。判据与渲染器同源
      // （见 we-library-scan.mjs::isLooseSceneProject 的注释）。
      const hasLooseScene = isLooseSceneProject({ declared: project?.file, names: dirNames });
      let hasWebEntry = false;
      let webEntry: string | null = null;
      for (const rel of WEB_ENTRY_PATHS) {
        if (await probe(rel)) {
          hasWebEntry = true;
          webEntry = rel;
          break;
        }
      }
      // 封面：project.json 声明的优先（旧行为），声明缺失/文件不在盘上时按原生
      // PREVIEW_EXTS 找 `preview.*` —— 单文件导入的视频（无 project.json）磁盘上
      // 有 preview.png，不兜底就只在列表里显示一行光秃秃的文字。
      const declaredPreview = typeof project?.preview === "string" ? project.preview : "";
      const preview =
        declaredPreview && (await statFile(join(base, declaredPreview)))
          ? declaredPreview
          : pickPreviewFile(dirNames);
      const type = classifyWallpaper({ declared: project?.type, hasScene, hasLooseScene, hasWebEntry, names: dirNames });
      // 入口文件（scene 不需要，src 就是 itemId）：project.json 没声明时按内容兜底，
      // 否则「无 project.json 的单文件视频」即使列出来也挂不上（src 拼不出来）。
      const file: string | undefined =
        typeof project?.file === "string" && project.file
          ? project.file
          : pickEntryFile({ type, names: dirNames, webEntry });
      return {
        itemId,
        title: project?.title ?? itemId,
        type,
        file,
        preview,
        hasScene,
        hasLooseScene,
        properties: project?.general?.properties ?? null,
      };
    }),
  );
  return { dir, items };
}

/**
 * 单个条目的类型（判据与 `scanLibrary` 同一份 `we-library-scan.mjs` 纯函数）。
 *
 * 网页壁纸的相对资源端点只服务 `type:"web"` 的条目，但不能为此扫全库：
 * 编辑器保存一个工程会逐个资源调一次 resolve，全库扫（420 条目 × 若干 stat）
 * 会白烧几千次 stat。这里只探这一个目录，探法与扫库逐条一致。
 */
async function classifyItemDir(base: string, project: any): Promise<string> {
  let dirNames: string[] = [];
  try {
    dirNames = await fs.readdir(base);
  } catch {
    /* 读不到目录名：按无内容推断 */
  }
  const probe = async (rel: string) => !!(await statFile(join(base, rel)));
  let hasScene = false;
  for (const rel of SCENE_PKG_PATHS) {
    if (await probe(rel)) {
      hasScene = true;
      break;
    }
  }
  const hasLooseScene = isLooseSceneProject({ declared: project?.file, names: dirNames });
  let hasWebEntry = false;
  for (const rel of WEB_ENTRY_PATHS) {
    if (await probe(rel)) {
      hasWebEntry = true;
      break;
    }
  }
  return classifyWallpaper({ declared: project?.type, hasScene, hasLooseScene, hasWebEntry, names: dirNames });
}

/** 条目目录里的 project.json（读不到或不是 JSON 返回 null） */
async function readItemProject(base: string): Promise<any> {
  try {
    return JSON.parse(await fs.readFile(join(base, "project.json"), "utf8"));
  } catch {
    return null;
  }
}

/** 单个效果文件读入上限：超出只记路径不读内容（避免一个坏文件把响应撑爆） */
const FX_LIB_MAX_FILE = 512 * 1024;
/** 一个效果最多带回多少依赖文件（防病态 dependencies 全量拉取） */
const FX_LIB_MAX_FILES = 64;

/** 宽松解析：库内 JSON 允许尾逗号（与 renderer 侧 parseJsonTolerant 同口径，只做最小兜底） */
function parseJsonLooseText(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return JSON.parse(text.replace(/,(\s*[}\]])/g, "$1"));
  }
}

/**
 * 只读枚举壁纸库里的效果目录（`<条目>/effects/<目录名>/effect.json`）。
 *
 * 合规边界（计划 §6 决策 5 = (a)）：
 * - **只读**：本函数只做 readdir / readFile，不写库、不建目录、不复制；
 * - 库内效果文件**留在库里**，编辑器只往工程 scene.json 写引用（`effects/<目录名>/effect.json`），
 *   代价是换机打开会缺效果；
 * - 打包条目（`scene.pkg` 内的效果）**不解包**，只在 stats 里计数并报告。
 */
async function scanEffectLibrary(dir: string) {
  const errors: string[] = [];
  let itemNames: string[] = [];
  try {
    itemNames = (await fs.readdir(dir, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name)
      .sort();
  } catch {
    return {
      dir,
      readOnly: true as const,
      copy: false as const,
      note: "只读枚举：库内效果文件留在库里，工程只写引用；换机打开会缺效果。打包进 scene.pkg 的效果不解包。",
      effects: [],
      errors: [`壁纸库目录不存在：${dir}`],
      stats: { items: 0, effectDirs: 0, packagedSkipped: 0, files: 0 },
    };
  }

  /** 目录名 → 效果（同一目录名只保留第一个条目，其余记进 items） */
  const byDir = new Map<string, { id: string; dir: string; file: string; itemId: string; items: string[]; meta: any; passes: any[]; files: Record<string, string>; missing: string[]; notes: string[] }>();
  let packagedSkipped = 0;

  for (const itemId of itemNames) {
    const base = join(dir, itemId);
    let dirNames: string[] = [];
    try {
      const fxRoot = join(base, "effects");
      const entries = await fs.readdir(fxRoot, { withFileTypes: true });
      dirNames = entries.filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name).sort();
    } catch {
      dirNames = [];
    }
    if (!dirNames.length) {
      // 没有松散 effects/ 目录：可能是被 scene.pkg 打包的效果，计数上报（不解包，合规 + 代价）
      if ((await statFile(join(base, "scene.pkg"))) || (await statFile(join(base, "scenes", "scene.pkg")))) packagedSkipped++;
      continue;
    }
    for (const fxDir of dirNames) {
      const rel = `effects/${fxDir}/effect.json`;
      let text: string;
      try {
        text = await fs.readFile(join(base, rel), "utf8");
      } catch {
        continue; // 目录里没有 effect.json：不是效果目录
      }
      const known = byDir.get(fxDir);
      if (known) {
        if (!known.items.includes(itemId)) known.items.push(itemId);
        continue; // 去重：同目录名只保留第一个条目的内容（items 记录全部来源）
      }
      const rec = { id: fxDir, dir: fxDir, file: rel, itemId, items: [itemId], meta: null as any, passes: [] as any[], files: {} as Record<string, string>, missing: [] as string[], notes: [] as string[] };
      byDir.set(fxDir, rec);
      let doc: any;
      try {
        doc = parseJsonLooseText(text);
      } catch (e) {
        // 坏 json 不列进效果（列了等于让页面往工程里写一条读不出来的引用），只在 errors 里报错
        byDir.delete(fxDir);
        errors.push(`${itemId}/${rel}：effect.json 解析失败（${e instanceof Error ? e.message : String(e)}）`);
        continue;
      }
      rec.files[rel] = text;
      rec.meta = {
        name: doc?.name ?? null,
        group: doc?.group ?? null,
        version: doc?.version ?? null,
        description: doc?.description ?? null,
        preview: doc?.preview ?? null,
        editable: doc?.editable ?? null,
        replacementkey: doc?.replacementkey ?? null,
        fbos: Array.isArray(doc?.fbos) ? doc.fbos.map((f: any) => f?.name ?? f) : [],
      };
      // pass 清单：material / target / bind / combos / 贴图槽（库内材质声明）
      const rawPasses: any[] = Array.isArray(doc?.passes) ? doc.passes : [];
      rec.passes = rawPasses.map((p: any, i: number) => ({
        index: i,
        material: typeof p?.material === "string" ? p.material : null,
        target: typeof p?.target === "string" ? p.target : null,
        bind: Array.isArray(p?.bind) ? p.bind : [],
        shader: null as string | null,
        combos: null as Record<string, number | string> | null,
        textures: [] as any[],
        uniforms: [] as any[],
      }));
      // 依赖清单：effect.json 的 dependencies + 每个 pass 的 material 及其 shader
      const wanted = new Set<string>();
      if (Array.isArray(doc?.dependencies)) for (const d of doc.dependencies) if (typeof d === "string") wanted.add(d);
      for (const p of rec.passes) if (p.material) wanted.add(p.material);
      for (const rel2 of [...wanted]) {
        if (Object.keys(rec.files).length >= FX_LIB_MAX_FILES) {
          rec.notes.push(`依赖文件超过 ${FX_LIB_MAX_FILES} 个，其余未读`);
          break;
        }
        let body: string;
        try {
          body = await fs.readFile(join(base, rel2), "utf8");
        } catch {
          rec.missing.push(rel2);
          continue;
        }
        if (body.length > FX_LIB_MAX_FILE) {
          rec.notes.push(`${rel2} 超过 ${FX_LIB_MAX_FILE} 字节，未随枚举返回`);
          continue;
        }
        rec.files[rel2] = body;
      }
      // pass → 材质 → shader：把材质里声明的 combos / usershadervalues / 贴图槽提出来
      for (const p of rec.passes) {
        const matText = p.material ? rec.files[p.material] : null;
        if (!matText) {
          if (p.material && rec.missing.includes(p.material)) rec.notes.push(`材质缺失：${p.material}`);
          continue;
        }
        let mat: any;
        try {
          mat = parseJsonLooseText(matText);
        } catch {
          rec.notes.push(`材质解析失败：${p.material}`);
          continue;
        }
        const mp = Array.isArray(mat?.passes) ? mat.passes[0] : null;
        if (!mp) continue;
        p.shader = typeof mp.shader === "string" ? mp.shader : null;
        p.combos = mp.combos && typeof mp.combos === "object" ? { ...mp.combos } : null;
        if (Array.isArray(mp.textures)) p.textures = mp.textures;
        if (mp.usershadervalues && typeof mp.usershadervalues === "object") p.uniforms = Object.keys(mp.usershadervalues);
        if (!p.shader) continue;
        // frag 是必需件（缺了记 missing），.vert 可选（frag-only 效果很常见）
        for (const ext of ["frag", "vert"]) {
          const srel = `shaders/${p.shader}.${ext}`;
          if (rec.files[srel]) continue;
          try {
            const src = await fs.readFile(join(base, srel), "utf8");
            if (src.length <= FX_LIB_MAX_FILE) rec.files[srel] = src;
            else rec.notes.push(`${srel} 超过 ${FX_LIB_MAX_FILE} 字节，未随枚举返回`);
          } catch {
            if (ext === "frag") rec.missing.push(srel);
          }
        }
      }
    }
  }

  const effects = [...byDir.values()].sort((a, b) => a.dir.localeCompare(b.dir));
  return {
    dir,
    readOnly: true as const,
    copy: false as const,
    note: "只读枚举：库内效果文件留在库里，工程只写引用；换机打开会缺效果。打包进 scene.pkg 的效果不解包。",
    effects,
    errors,
    stats: { items: itemNames.length, effectDirs: effects.length, packagedSkipped, files: effects.reduce((n, e) => n + Object.keys(e.files).length, 0) },
  };
}

export type FolderPicker = (defaultDir: string, prompt: string) => Promise<string | null>;

export type HostOptions = {
  logger?: { info(msg: string): void };
  /** 系统选文件夹；缺省 macOS 走 osascript，其他平台视为不支持（前端回退手输）。Electron 壳注入 dialog 版。 */
  pickFolder?: FolderPicker;
  /** 启动时没找到 media-bridge 的提示（缺省是面向仓库开发的构建指引；打包应用换成自动安装的进度说明） */
  bridgeMissingHint?: string;
};

type HostHandler = (req: Connect.IncomingMessage, res: any, next: () => void) => Promise<void>;

/** 宿主端点的 connect 风格处理器：Vite dev / preview 与独立生产服务器（server/serve.ts）共用 */
export function createHostMiddleware(opts: HostOptions = {}): HostHandler {
  const logger = opts.logger ?? { info: (msg: string) => console.log(msg) };
  const pickFolder: FolderPicker | null =
    opts.pickFolder ?? (process.platform === "darwin" ? pickFolderNative : null);
  let lib = libraryDir();
  /** 已连接的测试台 SSE 客户端（用于把 /diag 上报回显到页面日志区） */
  const diagClients = new Set<any>();
  // /api/system/stream 的订阅者：media/window 定时推，频谱帧随到随推
  const streamClients = new Set<any>();
  onAudioFrame((frame) => {
    if (!streamClients.size) return;
    const line = `data: ${JSON.stringify({ audio: frame })}\n\n`;
    for (const c of streamClients) {
      try {
        c.write(line);
      } catch {
        streamClients.delete(c);
      }
    }
  });
  logger.info(`[host] 壁纸库目录：${lib}`);
  void startLiveSystemService().then(({ backend }) => {
    if (backend === "media-bridge") {
      logger.info(`[host] 系统实况：media-bridge（系统级 Now Playing + 系统输出频谱）`);
    } else {
      logger.info(
        `[host] 系统实况：${opts.bridgeMissingHint ?? "未找到 media-bridge（构建 ../media-bridge 或设 MEDIA_BRIDGE_BIN）；端点返回空快照"}`,
      );
    }
  });

  return async (req, res, next) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = decodeURIComponent(url.pathname);

    // --- 渲染器诊断上报（对齐 content_server.rs 的 /diag）---
    // lvl= 是**发送端声明**的级别（issue #13）：渲染器把级别随请求一起发出来，
    // 宿主/嵌入方不必再对文案做关键字匹配。老渲染器没有这一位，退回不带级别的旧行为。
    if (path === "/diag") {
      const msg = url.searchParams.get("msg") ?? "";
      const raw = url.searchParams.get("lvl") ?? "";
      const level = raw === "error" || raw === "warn" || raw === "info" ? raw : undefined;
      const color = level === "error" ? "\x1b[31m" : level === "warn" ? "\x1b[33m" : "\x1b[36m";
      logger.info(`${color}[renderer diag${level ? ` ${level}` : ""}]\x1b[0m ${msg}`);
      const line = `data: ${JSON.stringify({ t: Date.now(), msg, ...(level ? { level } : {}) })}\n\n`;
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
      sendJson(res, 200, {
        ...media,
        backend: getLiveBackend(),
        audioState: getAudioStatus(),
      });
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

    // --- 系统实况：媒体 + 窗口 SSE（媒体/窗口 ~2Hz；频谱随 media-bridge 帧率）---
    if (path === "/api/system/stream") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.write(": connected\n\n");
      await startLiveSystemService();
      streamClients.add(res);
      const push = () => {
        try {
          const payload = {
            media: getCachedMedia(),
            window: getCachedWindow(),
            backend: getLiveBackend(),
            audioState: getAudioStatus(),
          };
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        } catch {
          /* 单轮失败不掐连接 */
        }
      };
      push();
      const timer = setInterval(push, 500);
      req.on("close", () => {
        clearInterval(timer);
        streamClients.delete(res);
      });
      return;
    }

    // --- 对齐 WallpaperEM：系统音频 SSE（测试台无 SCK；真实频谱走 /api/system/stream）---
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
        "audio capture unavailable in test bench (no ScreenCaptureKit); liveSystem uses media-bridge via /api/system/stream",
      );
      return;
    }

    // --- 编辑器外部插件目录（只读；热重载靠页面轮询版本戳）---
    if (path === "/api/plugins") {
      sendJson(res, 200, await listPluginDirs());
      return;
    }
    if (path === "/api/plugins/file") {
      const data = await readPluginFile(url.searchParams.get("dir") ?? "", url.searchParams.get("path") ?? "");
      if (!data) {
        sendJson(res, 404, { error: "插件文件不存在" });
        return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Cache-Control", "no-store");
      res.end(data);
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

    // --- 测试台专用：**只读**枚举库内效果目录（计划 §6 决策 5 = (a)）---
    // 只接受 GET：不接受写入/复制语义（POST 一律 405），也不写库、不建目录。
    if (path === "/api/fx-library") {
      if (req.method !== "GET") {
        sendJson(res, 405, { error: "只读端点，需要 GET" });
        return;
      }
      const data = await scanEffectLibrary(lib);
      sendJson(res, 200, data);
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
        if (!pickFolder) {
          sendJson(res, 200, { dir: lib, cancelled: true, unsupported: true });
          return;
        }
        const picked = await pickFolder(lib, "选择壁纸库文件夹");
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
      logger.info(`[host] 壁纸库目录改为：${lib}`);
      sendJson(res, 200, { dir: lib, ok: true });
      return;
    }

    // --- 编辑器页保存（EDITOR-PLAN §3A.4）：写成库内松散工程 ---
    // 只准新建、或覆盖带 EDITOR_MARK 的目录（编辑器自己建的）；作者原始条目一律 409，
    // 页面侧总是「另存为新条目」。begin 清空旧产物（上次保存删掉的资源不能残留），
    // file 逐个写（避免一次性上传几百 MB 的请求体）。
    if (path === "/api/editor/save-begin" || path === "/api/editor/save-file") {
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "需要 POST" });
        return;
      }
      const itemId = url.searchParams.get("item") ?? "";
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(itemId)) {
        sendJson(res, 400, { error: "非法 itemId" });
        return;
      }
      const dir = safeJoin(lib, itemId);
      if (!dir) {
        sendJson(res, 403, { error: "路径非法" });
        return;
      }
      const exists = !!(await asDirectory(dir));
      const marked = exists && !!(await statFile(join(dir, EDITOR_MARK)));
      if (exists && !marked) {
        sendJson(res, 409, { error: `目标不是编辑器创建的目录，拒绝覆盖：${itemId}` });
        return;
      }
      try {
        if (path === "/api/editor/save-begin") {
          if (exists) await fs.rm(dir, { recursive: true, force: true });
          await fs.mkdir(dir, { recursive: true });
          await fs.writeFile(join(dir, EDITOR_MARK), `${new Date().toISOString()}\n`);
          logger.info(`[host] 编辑器保存：${itemId}`);
          sendJson(res, 200, { ok: true, itemId, dir });
          return;
        }
        if (!exists) {
          sendJson(res, 409, { error: "先调 save-begin" });
          return;
        }
        const rel = url.searchParams.get("path") ?? "";
        const target = rel && rel !== EDITOR_MARK ? safeJoin(dir, rel) : null;
        if (!target || target === dir) {
          sendJson(res, 400, { error: `非法文件路径：${rel}` });
          return;
        }
        const body = await readRawBody(req, 1024 * 1024 * 1024);
        await fs.mkdir(resolve(target, ".."), { recursive: true });
        await fs.writeFile(target, body);
        sendJson(res, 200, { ok: true, bytes: body.length });
      } catch (e) {
        sendJson(res, 500, { error: (e as Error).message });
      }
      return;
    }

    // --- 网页壁纸工程相对资源解析（EDITOR-COMPLETION-PLAN §6 决策 6 / M13）---
    // 网页壁纸工程（project.type=web）的入口 html 与它引用的 js/css/图片都在同一条目
    // 目录里、靠相对路径互相引用，而编辑器页拿到的是 File/blob，没有目录概念：
    // 此前 `editor/open.ts` 只能整条拒开并提示「相对资源无法从 blob 地址解析」。
    // 这两个端点把「工程内相对路径」翻成 /web/{token}/{itemId}/{path...}（同源、由下面
    // 的 /web 处理器原样吐文件、html 仍注入 WE shim），并给出资源清单供编辑器保存时
    // 逐文件读回。任何非法/缺失路径都给**明确 JSON 报错**，绝不静默落空 —— 静默失败
    // 在保存路径上会变成「少存文件」。
    if (path === "/api/editor/web-manifest" || path === "/api/editor/web-resolve") {
      if (req.method !== "GET") {
        sendJson(res, 405, { error: "需要 GET" });
        return;
      }
      const itemId = url.searchParams.get("item") ?? "";
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(itemId)) {
        sendJson(res, 400, { error: "非法 itemId" });
        return;
      }
      const itemBase = safeJoin(lib, itemId);
      if (!itemBase || !(await asDirectory(itemBase))) {
        sendJson(res, 404, { error: `壁纸库中没有这个条目：${itemId}` });
        return;
      }
      // 只服务网页壁纸工程：类型判据与 /api/library 同一份（we-library-scan 纯函数），
      // 免得这个端点变成「任意条目任意文件」的读取口。
      const project = await readItemProject(itemBase);
      const itemType = await classifyItemDir(itemBase, project);
      if (itemType !== "web") {
        sendJson(res, 409, { error: `目标不是网页壁纸工程：${itemId}（类型 ${itemType}）` });
        return;
      }
      const manifest = await listWebProjectFiles(itemBase);
      if (manifest.truncated) {
        sendJson(res, 413, {
          error: `网页壁纸工程文件过多，清单不完整（上限 ${WEB_MANIFEST_MAX_FILES}）：${itemId}`,
        });
        return;
      }
      const entry = pickWebEntry({ declared: project?.file, names: manifest.files });
      if (!entry) {
        sendJson(res, 404, { error: `网页壁纸工程找不到入口 html：${itemId}` });
        return;
      }
      if (path === "/api/editor/web-manifest") {
        sendJson(res, 200, {
          ok: true,
          itemId,
          entry,
          files: manifest.files,
          count: manifest.files.length,
          dir: itemBase,
        });
        return;
      }
      const rawRel = url.searchParams.get("path") ?? "";
      const rel = normalizeWebRelPath(rawRel);
      if (!rel) {
        sendJson(res, 400, { error: `非法相对路径：${rawRel}` });
        return;
      }
      const target = safeJoin(itemBase, rel);
      if (!target) {
        sendJson(res, 403, { error: `相对路径越界：${rel}` });
        return;
      }
      if (!(await statFile(target))) {
        // 分不清「不存在」与「是目录」的报错等于没说：目录给 400，缺失给 404
        if (await asDirectory(target)) {
          sendJson(res, 400, { error: `相对资源是目录：${rel}` });
          return;
        }
        sendJson(res, 404, { error: `相对资源不存在：${rel}` });
        return;
      }
      // raw=1：给「要读元字节另存」的调用方（编辑器）用 —— /web 端点默认会注入 WE shim
      // 并合并属性覆盖值，那是渲染要的形态；保存必须拿到作者写的原文件
      const raw = url.searchParams.get("raw") === "1";
      sendJson(res, 200, { ok: true, itemId, path: rel, url: webAssetUrl(itemId, rel, { token: DEV_TOKEN, raw }) });
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
        logger.info(`[host] 已删除壁纸：${itemId}（${resolved}）`);
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
      if (!pickFolder) {
        sendJson(res, 200, { cancelled: true, unsupported: true });
        return;
      }
      const picked = await pickFolder(homedir(), "选择目录");
      if (!picked) {
        sendJson(res, 200, { cancelled: true });
        return;
      }
      sendJson(res, 200, { value: picked });
      return;
    }

    // --- 本机引擎内置素材（贴图 / 法线）：/api/local-assets/... ---
    // WE 的内置贴图（materials/util/*、materials/particle/**）不在壁纸 pkg 里，
    // 只有官方安装目录才有。本地想按原版观感测试时把它们拷到 `local-assets/<id>/`
    // （.gitignore 忽略、永不入库，见 docs/COMPLIANCE.md），这个端点只把它喂给渲染器；
    // 目录不存在时返回 `{ok:false}`，渲染器整条路径静默跳过、回落到程序化复刻
    // （system-textures.js / particle-textures.js）。
    if (path === "/api/local-assets" || path.startsWith("/api/local-assets/")) {
      const providers = localAssetProviders();
      if (path === "/api/local-assets") {
        const roots: Array<{ id: string; dir: string }> = [];
        for (const p of providers) {
          try {
            const st = await fs.stat(join(p.dir, "materials"));
            if (!st.isDirectory()) continue;
          } catch {
            continue;
          }
          roots.push({ id: p.id, dir: p.dir });
        }
        sendJson(res, 200, { ok: roots.length > 0, roots });
        return;
      }
      const segs = path
        .replace(/^\/api\/local-assets\//, "")
        .split("/")
        .filter(Boolean)
        .map(decodeURIComponent);
      const id = segs.shift() ?? "";
      const provider = providers.find((p) => p.id === id);
      if (!provider) {
        sendJson(res, 404, { error: `未知素材源：${id}` });
        return;
      }
      const rel = segs.join("/");
      // 引擎素材名清单：把 materials/**/*.tex 的相对路径去掉扩展名当「引擎名」
      // （`materials/util/noise.tex` → `util/noise`，与 shader/材质引用同名）。
      // 扫盘结果按目录 mtime 缓存 60s，避免每次挂载都重扫 586 个文件。
      if (rel === "materials/index.json") {
        sendJson(res, 200, { names: await listLocalAssetNames(provider.dir) });
        return;
      }
      const file = rel ? safeJoin(provider.dir, rel) : null;
      if (!file) {
        sendJson(res, 400, { error: "路径非法" });
        return;
      }
      const st = await statFile(file);
      if (!st || !st.isFile()) {
        sendJson(res, 404, { error: `素材不存在：${rel}` });
        return;
      }
      // sendFile 自带 MIME / ETag / Range，并等到流结束才返回（见其注释）
      await sendFile(req, res, file);
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
      // ?we-raw=1：元字节直出（不注 shim、不合并覆盖值）。编辑器另存必须走这条 ——
      // 走注入形态会把 shim 与用户覆盖值写回作者的文件，存一次脏一次。
      const rawWanted = url.searchParams.get("we-raw") === "1";
      const transform = rawWanted
        ? undefined
        : isProject
          ? (raw: Buffer) => mergeProjectOverrides(raw, itemId)
          : htmlInject;
      await sendFile(req, res, target, transform);
      return;
    }

    next();
  };
}

export function wallpaperHost(): Plugin {
  let handler: HostHandler | null = null;
  const use = (server: ViteDevServer | PreviewServer) => {
    handler ??= createHostMiddleware({ logger: server.config.logger });
    server.middlewares.use(handler);
  };
  return {
    name: "we-scene-renderer:wallpaper-host",
    configureServer: use,
    configurePreviewServer: use,
  };
}
