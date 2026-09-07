// Source 实现：把「场景资源从哪来」与渲染解耦（见 docs/LIBRARY-PLAN.md §4）
//
// 库对外只发两个请求（scene.pkg / project.json）—— shader 从 pkg 内部取，
// 视频/音频/字体都是 pkg 内嵌字节转 Blob URL。所以这里不做通用虚拟文件系统。

import type { Source } from "./types";

/** scene.pkg 在真实壁纸库里的三种布局。顺序即尝试顺序，理由见 httpSource */
const PKG_PATHS = ["scene.pkg", "scenes/scene.pkg", "gifscene.pkg"] as const;

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
 */
export function httpSource(baseUrl: string, init?: RequestInit): Source {
  const base = baseUrl.replace(/\/+$/, "");
  return {
    key: base,
    async scenePkg(signal) {
      let lastStatus: number | null = null;
      let lastThrow: unknown = null;
      for (const p of PKG_PATHS) {
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
    async project(signal) {
      try {
        const r = await fetch(`${base}/project.json`, { ...init, signal });
        return r.ok ? await r.json() : null;
      } catch {
        // 属性表缺失是常态，不是错误（含切场景 abort —— 此时整场会被丢弃）
        return null;
      }
    },
    async webEntry(signal) {
      let file = "index.html";
      try {
        const r = await fetch(`${base}/project.json`, { ...init, signal });
        if (r.ok) {
          const project = (await r.json()) as { file?: unknown } | null;
          if (project && typeof project.file === "string" && project.file.trim()) {
            file = project.file.trim().replace(/^\/+/, "");
          }
        }
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
        const r = await fetch(`${base}/project.json`, { ...init, signal });
        if (r.ok) {
          const project = (await r.json()) as { file?: unknown } | null;
          if (project && typeof project.file === "string" && project.file.trim()) {
            file = project.file.trim().replace(/^\/+/, "");
          }
        }
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

