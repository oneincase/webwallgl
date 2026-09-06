// Source 实现：把「场景资源从哪来」与渲染解耦（见 docs/LIBRARY-PLAN.md §4）
//
// 库对外只发两个请求（scene.pkg / project.json）—— shader 从 pkg 内部取，
// 视频/音频/字体都是 pkg 内嵌字节转 Blob URL。所以这里不做通用虚拟文件系统。

import type { Source } from "./types";

/** scene.pkg 在真实壁纸库里的三种布局。顺序即尝试顺序，理由见 httpSource */
const PKG_PATHS = ["scene.pkg", "scenes/scene.pkg", "gifscene.pkg"] as const;

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
