// Source 实现：把「场景资源从哪来」与渲染解耦（见 docs/LIBRARY-PLAN.md §4）
// 包形态只发两个请求（scene.pkg / project.json）—— shader 从 pkg 内部取，
// 视频/音频/字体都是 pkg 内嵌字节转 Blob URL。松散目录形态（源码工程）多一条
// 「按相对路径逐文件取」：宿主本来就有 `GET {mediaBase}/{itemId}/<path>` 这条路由，
// 不需要新增端点，所以仍然不做通用虚拟文件系统。

import type { SceneDirAssets, Source } from "./types";

/** scene.pkg 在真实壁纸库里的三种布局。顺序即尝试顺序，理由见 httpSource */
const PKG_PATHS = ["scene.pkg", "scenes/scene.pkg", "gifscene.pkg"] as const;

/** 场景形态：包（scene.pkg）或松散目录（源码工程，散装文件按名取） */
export type SceneForm = "pkg" | "loose";

/**
 * project.json 声明的场景文件（`file`）—— 去空白、去前导斜杠后的相对路径。
 * 拿不到（无 project.json / 字段不是字符串 / 空串）返回 `""`。
 *
 * `file` 是**多用途**字段：场景入口 json（scene.json / gifscene.json /
 * audiophile.json…）、网页入口（index.html）、媒体文件（scene.mp4）。所以形态
 * 判定必须看后缀，不能假设它一定是场景入口（与 mount.ts 的分支注释同一理由）。
 */
export function declaredSceneFile(project: unknown): string {
  if (!project || typeof project !== "object") return "";
  const raw = (project as { file?: unknown }).file;
  if (typeof raw !== "string") return "";
  return raw.trim().replace(/^\/+/, "");
}

/**
 * 场景形态判定 —— **唯一真源**（判定表见 docs/LIBRARY-PLAN.md §4）：
 *
 * - `file` 以 `.pkg` 结尾 → 包形态；
 * - `file` 以 `.json` 结尾 → 松散形态（源码工程，散装文件按名取）；
 * - 其余（缺失 / index.html / scene.mp4 …）→ 包形态（行为与引入本判定前逐字一致）。
 *
 * `preview.*` 是封面不是场景入口（与 scene/parse.js 的候选表同一豁免），命中时
 * 按包形态处理，免得把一张封面 json 当成工程入口。
 *
 * **`loose` 只是「先按松散试」**：入口 json 取不到时 `sceneDir` 返回 null，装配
 * 回退 pkg —— 实测全库 416 个 project.json 里 0 个声明 `.pkg`、351 个声明
 * `file: "scene.json"`（其中 350 个盘上只有 scene.pkg）。没有这条回退，那些条目
 * 会整场挂掉。
 */
export function sceneFormOf(project: unknown): SceneForm {
  const file = declaredSceneFile(project);
  if (!file || /^preview\./i.test(file)) return "pkg";
  return /\.json$/i.test(file) ? "loose" : "pkg";
}

/** `file` 声明的自定义包名（`*.pkg`），没有则 `""` —— 支持非 scene.pkg 命名的包 */
export function declaredPkgPath(project: unknown): string {
  const file = declaredSceneFile(project);
  return /\.pkg$/i.test(file) ? file : "";
}

/**
 * 相对路径规范化（松散读取器用）：去反斜杠与前导斜杠，拒绝空路径、含 NUL、
 * 以及任何 `..`/`.` 段。目录穿越在宿主侧也会被拦（`safeJoin`），这里先拦是为了
 * 不把注定失败的请求发出去。
 */
function normalizeRelPath(name: unknown): string {
  const rel = String(name ?? "").replace(/\\/g, "/").replace(/^\/+/, "").trim();
  if (!rel || rel.includes("\0")) return "";
  for (const seg of rel.split("/")) {
    if (seg === ".." || seg === ".") return "";
  }
  return rel;
}

/**
 * 扩展名 → 媒体类型。gif 单列：它走逐帧 ImageDecoder 解码，与静态图不是一条路径。
 * 只收真正会被当壁纸用的容器格式；`.mkv`/`.avi` 浏览器普遍不解，不列进来免得
 * 嗅出一个必定黑屏的类型（那还不如老实落到 scene 报「缺 scene.pkg」）。
 */
const EXT_TYPES: Record<string, "video" | "gif" | "image"> = {
  mp4: "video", webm: "video", mov: "video", m4v: "video", ogv: "video",
  gif: "gif",
  png: "image", jpg: "image", jpeg: "image", webp: "image",
  avif: "image", bmp: "image",
};

/** MIME 主类型 → 媒体类型（HEAD 回退用；image/gif 单独判） */
function typeFromMime(mime: string): "video" | "gif" | "image" | null {
  const m = mime.toLowerCase().split(";")[0].trim();
  if (m === "image/gif") return "gif";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("image/")) return "image";
  return null;
}

/**
 * 从 URL 猜媒体类型。取 pathname 末段的扩展名 —— **必须先剥掉 query/hash**，
 * 签名 URL（`a.mp4?token=…&Expires=…`）与锚点在真实 CDN 上极常见，
 * 直接对整串取 `.` 后缀会拿到 `mp4?token=…` 这种永远匹配不上的东西。
 *
 * 认不出返回 null（交给调用方决定是否再 HEAD 一次或落回 scene）。
 */
/**
 * 从 Source.key（通常是壁纸目录 URL / 本地路径）抽出工坊 ID。
 *
 * WallpaperEM 等宿主走 `mount({ source })` 时不会再填 cfg.src；视差白名单
 * （MIRAGE_PARALLAX_WALLPAPERS）却靠 workshopId=cfg.src 选路。若这里抽不出 ID，
 * 3233141951 等白名单墙会默默退回 legacy 视差，本库测试台（URL ?src=ID）正常、
 * 下游开发模式却「修好了却不一致」。
 *
 * 只认末段纯数字（Steam 工坊 ID）；fileSource / bytesSource 无数字 key 时返回
 * undefined，视差保持默认 legacy。
 */
export function workshopIdFromSourceKey(key?: string | null): string | undefined {
  if (typeof key !== "string" || !key) return undefined;
  const seg =
    key
      .replace(/[?#].*$/, "")
      .replace(/\/+$/, "")
      .split(/[/\\]/)
      .pop() ?? "";
  return /^\d+$/.test(seg) ? seg : undefined;
}

export function sniffMediaType(url: string): "video" | "gif" | "image" | null {
  if (typeof url !== "string" || !url) return null;
  let path = url;
  // 不用 new URL()：相对路径（"a.mp4"）会抛，而相对路径正是要支持的形态
  const hash = path.indexOf("#");
  if (hash >= 0) path = path.slice(0, hash);
  const q = path.indexOf("?");
  if (q >= 0) path = path.slice(0, q);
  const seg = path.split("/").pop() || "";
  const dot = seg.lastIndexOf(".");
  if (dot < 0) return null;
  return EXT_TYPES[seg.slice(dot + 1).toLowerCase()] ?? null;
}

/**
 * 扩展名认不出时，用一次 HEAD 读 Content-Type 兜底。
 * 失败（跨域、不支持 HEAD、超时）一律返回 null 静默回退 —— 嗅探是锦上添花，
 * 不能因为它失败就让整张壁纸挂掉。
 */
export async function sniffMediaTypeByHead(
  url: string,
  init?: RequestInit,
  signal?: AbortSignal,
): Promise<"video" | "gif" | "image" | null> {
  try {
    const r = await fetch(url, { ...init, method: "HEAD", signal });
    if (!r.ok) return null;
    return typeFromMime(r.headers.get("content-type") || "");
  } catch {
    return null;
  }
}

/**
 * HTTP 来源。baseUrl 指向单个壁纸的目录（不含末尾斜杠也可）。
 *
 * **scene.pkg 必须先试根目录，且每个 fetch 单独 try/catch。** 这不是防御性
 * 编程，是踩过的坑：WKWebView / Tauri 自定义协议对不存在的路径抛
 * `TypeError: Failed to fetch` 而**不给 HTTP 404**。旧代码先打
 * `scenes/scene.pkg`，一抛就整场失败，后面的 scene.pkg 永远走不到 ——
 * 症状是日志一片 `Failed to fetch`，看起来像「很多壁纸都坏了」。
 *
 * 形态（包 / 松散目录）由 project.json 的 `file` 后缀决定（sceneFormOf）；
 * 松散形态的每个资源也是「按相对路径取一个文件」，所以同一条路由就能覆盖，
 * 宿主无需新增端点（docs/INTEGRATION.md §4）。
 */
export function httpSource(baseUrl: string, init?: RequestInit): Source {
  const base = baseUrl.replace(/\/+$/, "");

  /**
   * project.json 只取一次并复用：形态判定（sceneDir）、属性表（project）、
   * 网页 / 媒体入口（webEntry / mediaEntry）都要它 —— 此前这三处各 fetch 一遍，
   * 一次挂载最多取两遍。
   *
   * 语义逐条对齐改动前：
   *  · 拿不到（404 / 网络失败）→ null（属性表缺失是常态，不是错误）；
   *  · **不固化失败**：下一次调用会重试。把一次网络抖动记成「永远没有属性表」
   *    会让整场静默用不到用户覆盖值；
   *  · 切场景 abort → 如实抛出（由调用方决定丢弃整场还是当 null）。
   */
  let projectBox: { value: unknown | null } | null = null;
  let projectInflight: Promise<{ value: unknown | null } | null> | null = null;
  const fetchProjectOnce = (signal?: AbortSignal): Promise<unknown | null> => {
    if (projectBox) return Promise.resolve(projectBox.value);
    if (!projectInflight) {
      projectInflight = (async (): Promise<{ value: unknown | null } | null> => {
        try {
          const r = await fetch(`${base}/project.json`, { ...init, signal });
          return { value: r.ok ? await r.json() : null };
        } catch (e) {
          if (signal?.aborted) throw e;
          return null; // 网络失败：不固化，下次重试
        }
      })();
      // abort/网络失败都要清掉在飞引用，否则这个 source 余生都拿不到属性表
      projectInflight.catch(() => {
        projectInflight = null;
      });
    }
    const inflight = projectInflight;
    return inflight.then((box) => {
      if (!box) return null;
      projectBox = box;
      return box.value;
    });
  };

  /**
   * 松散目录读取器（形态判定为 loose 时才暴露出去）。
   *
   * 缓存三件套：命中（字节）、负命中（404 —— 省掉内置命名空间那批注定 404 的探测）、
   * 在飞去重（同一路径并发只发一次请求）。**abort 与网络失败一律不写任何缓存** ——
   * 否则切场景那一次的中断会被固化成「这个文件不存在」，重挂后整张贴图静默消失。
   *
   * 负命中带 TTL（5s）而不是永久：松散形态就是作者边改边看的形态，新增一张贴图后
   * 永久记住「它不存在」会让作者以为渲染器坏了（读取器还会被缓存复用，一直不失效）。
   * 正命中的字节缓存与包形态同纪律（按 source.key 缓存到库的 LRU 里），改内容需重挂。
   */
  const dirCache = new Map<string, Uint8Array>();
  const dirMiss = new Map<string, number>();
  const dirInflight = new Map<string, Promise<Uint8Array | null>>();
  const DIR_MISS_TTL_MS = 5000;
  let dirBytes = 0;
  const dirRead = async (name: string, signal?: AbortSignal): Promise<Uint8Array | null> => {
    const rel = normalizeRelPath(name);
    if (!rel) return null;
    const hit = dirCache.get(rel);
    if (hit) return hit;
    const missAt = dirMiss.get(rel);
    if (missAt !== undefined) {
      if (Date.now() - missAt < DIR_MISS_TTL_MS) return null;
      dirMiss.delete(rel);
    }
    const flying = dirInflight.get(rel);
    if (flying) return flying;
    const p = (async (): Promise<Uint8Array | null> => {
      let r: Response;
      try {
        r = await fetch(`${base}/${rel.split("/").map(encodeURIComponent).join("/")}`, { ...init, signal });
      } catch (e) {
        if (signal?.aborted) throw e;
        return null; // 网络抖动：不固化
      }
      if (!r.ok) {
        // 404 = 这个路径没有（内置命名空间的 .tex 探测、`.png/.jpg/.jpeg` 源图回退都会走到这里）
        dirMiss.set(rel, Date.now());
        return null;
      }
      try {
        const bytes = new Uint8Array(await r.arrayBuffer());
        dirCache.set(rel, bytes);
        dirBytes += bytes.byteLength;
        return bytes;
      } catch (e) {
        // HTTP 200 后读体失败 = body 被掐（同 scenePkg 的注释）：不固化
        if (signal?.aborted) throw e;
        return null;
      }
    })();
    dirInflight.set(rel, p);
    try {
      return await p;
    } finally {
      dirInflight.delete(rel);
    }
  };

  return {
    key: base,
    async scenePkg(signal) {
      let lastStatus: number | null = null;
      let lastThrow: unknown = null;
      // `file` 声明了 *.pkg 的条目先试它自己的名字（自定义包名），再走三种标准布局；
      // 与标准名重合时不重复请求。project.json 拿不到就只走标准布局（现状）。
      let candidates: readonly string[] = PKG_PATHS;
      try {
        const declared = declaredPkgPath(await fetchProjectOnce(signal));
        if (declared && !(PKG_PATHS as readonly string[]).includes(declared)) {
          candidates = [declared, ...PKG_PATHS];
        }
      } catch (e) {
        if (signal?.aborted) throw e;
      }
      for (const p of candidates) {
        let r: Response;
        try {
          r = await fetch(`${base}/${p}`, { ...init, signal });
        } catch (e) {
          // 切场景导致的 abort 要如实抛出，不能被当成「这个路径不存在」继续试
          if (signal?.aborted) throw e;
          lastThrow = e;
          continue;
        }
        if (!r.ok) {
          lastStatus = r.status;
          continue;
        }
        // HTTP 200 之后的读体失败是「body 被掐」，不是缺路径 ——
        // 直接失败，不能换下一条路径重试（重试会把根因埋进最后一条 404 里）
        try {
          return await r.arrayBuffer();
        } catch (e) {
          if (signal?.aborted) throw e;
          const why = e instanceof Error ? e.message : String(e);
          throw new Error(`读取 scene.pkg 体失败（${why}）`);
        }
      }
      if (lastStatus != null) throw new Error(`scene.pkg 加载失败（HTTP ${lastStatus}）`);
      const why = lastThrow instanceof Error ? lastThrow.message : "Failed to fetch";
      throw new Error(`scene.pkg 加载失败（${why}）`);
    },
    /**
     * 松散目录形态：`file` 以 `.json` 结尾才试；入口 json 取不到（404 / 抛错）
     * 返回 null，让装配回退 scene.pkg —— 真实库里 350+ 个条目声明
     * `file: "scene.json"` 而盘上只有 pkg，这条回退是它们照旧能挂的前提。
     */
    async sceneDir(signal) {
      let project: unknown = null;
      try {
        project = await fetchProjectOnce(signal);
      } catch (e) {
        if (signal?.aborted) throw e;
        project = null;
      }
      if (sceneFormOf(project) !== "loose") return null;
      const entry = declaredSceneFile(project);
      const first = await dirRead(entry, signal);
      if (!first) return null;
      return { entry, read: dirRead, bytes: () => dirBytes };
    },
    async project(signal) {
      try {
        return await fetchProjectOnce(signal);
      } catch {
        // 属性表缺失是常态，不是错误（含切场景 abort —— 此时整场会被丢弃）
        return null;
      }
    },
    async webEntry(signal) {
      let file = "index.html";
      try {
        const declared = declaredSceneFile(await fetchProjectOnce(signal));
        if (declared) file = declared;
      } catch {
        if (signal?.aborted) throw new Error("aborted");
      }
      return { url: `${base}/${file}` };
    },
    /**
     * 媒体壁纸（video/gif/image）的资源地址：`{base}/{project.file}`。
     *
     * 与 webEntry 的区别是**没有默认文件名可兜底**：网页壁纸缺 file 时
     * index.html 是行业惯例，媒体壁纸的文件名（scene.mp4 / xxx.gif）完全由作者定，
     * 猜一个只会 404。拿不到 file 就返回 null，让 mount 报「无法解析媒体 URL」，
     * 而不是发一个必然失败的请求、再把那个 404 当成根因写进错误里。
     */
    async mediaEntry(signal) {
      let file = "";
      try {
        file = declaredSceneFile(await fetchProjectOnce(signal));
      } catch {
        if (signal?.aborted) throw new Error("aborted");
      }
      return file ? { url: `${base}/${file}` } : null;
    },
  };
}

/**
 * 本地文件来源：`<input type="file">` 选中的、或拖拽进页面的 scene.pkg。
 * project 需要调用方自己给（File 是单个文件，拿不到同目录的 project.json）。
 */
export function fileSource(file: File | Blob, project?: unknown): Source {
  // File 有 name/lastModified 可做稳定键；裸 Blob 没有身份，退回不缓存
  const named = file as File;
  const key =
    typeof named.name === "string"
      ? `file:${named.name}:${named.size}:${named.lastModified ?? 0}`
      : undefined;
  return {
    key,
    scenePkg: () => file.arrayBuffer(),
    project: async () => project ?? null,
  };
}

/**
 * 字节来源：已经拿到 scene.pkg 内容时用（打包进 bundle、IndexedDB 缓存、
 * 自定义传输通道）。key 由调用方给，否则不参与缓存。
 */
export function bytesSource(
  pkg: ArrayBuffer | Uint8Array,
  project?: unknown,
  key?: string,
): Source {
  return {
    key,
    scenePkg: async () => pkg,
    project: async () => project ?? null,
  };
}

/**
 * 媒体来源：直接放一个视频 / GIF / 图片，不经 WE 壁纸包。
 *
 * ```
 * mediaSource("https://cdn/a.mp4")        // 远程 URL，按扩展名嗅探类型
 * mediaSource(fileInput.files[0])         // 本地 File/Blob（拖拽导入）
 * mediaSource(url, { type: "video" })     // 显式指定，跳过嗅探
 * ```
 *
 * 与另外三个工厂的根本区别：**没有 scene.pkg**。`scenePkg()` 抛明确错误而不是
 * 返回空字节假装成功 —— 真返回空字节，失败会推迟到 pkg 解析阶段，报成
 * 「魔数不对」，那和真因（这压根不是场景壁纸）差着十万八千里。
 *
 * 本地文件走 `URL.createObjectURL`，并在 `dispose()` 里 revoke：不 revoke
 * 就是每换一次壁纸泄漏一个几十 MB 的 blob（实例 destroy() / 换源时会调）。
 */
export function mediaSource(
  urlOrFile: string | File | Blob,
  options?: { type?: "video" | "gif" | "image"; key?: string },
): Source {
  const isBlob = typeof urlOrFile !== "string";
  const named = urlOrFile as File;
  // 本地文件的类型优先信 blob.type（浏览器按真实内容/系统关联给的），
  // 它比文件名扩展名可靠；扩展名只作兜底（有些系统给出空 type）
  let type =
    options?.type ??
    (isBlob ? typeFromMime((urlOrFile as Blob).type || "") : null) ??
    sniffMediaType(isBlob ? String(named.name ?? "") : (urlOrFile as string));
  // 远程 URL 且扩展名认不出时，首次取址前用一次 HEAD 兜底（结果缓存，只探一次）
  let headTried = false;

  let objectUrl: string | null = null;
  const url = () => {
    if (!isBlob) return urlOrFile as string;
    if (!objectUrl) objectUrl = URL.createObjectURL(urlOrFile as Blob);
    return objectUrl;
  };

  const key =
    options?.key ??
    (isBlob
      ? typeof named.name === "string"
        ? `media:${named.name}:${named.size}:${named.lastModified ?? 0}`
        : undefined // 无身份的裸 Blob 不参与缓存（与 fileSource 同规则）
      : `media:${urlOrFile as string}`);

  return {
    key,
    async scenePkg() {
      throw new Error("mediaSource 是纯媒体来源，没有 scene.pkg（请改用 httpSource/fileSource/bytesSource）");
    },
    // type 为 null 时也如实返回：resolveMountConfig 会再按 mediaEntry 的 URL
    // 嗅探一次（含 HEAD 兜底），仍认不出才落回 scene 并报错
    async project() {
      return type ? { type } : null;
    },
    async mediaEntry(signal) {
      // 远程 URL 扩展名认不出时，探一次 Content-Type（只探一次，失败不重试）
      if (!type && !isBlob && !headTried) {
        headTried = true;
        type = await sniffMediaTypeByHead(urlOrFile as string, undefined, signal);
      }
      return { url: url(), type: type ?? undefined };
    },
    dispose() {
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
        objectUrl = null;
      }
    },
  };
}

