/**
 * 网页壁纸工程（`type:"web"`）的相对资源解析（host、编辑器与验证脚本共用一份）。
 *
 * 为什么单独成文件：网页壁纸工程的入口 html 与它引用的 js/css/图片都在**同一条目
 * 目录**里，靠相对路径互相引用。编辑器页拿到的是 File 对象 / blob 地址，没有目录
 * 概念，`./js/app.js` 无从解析 —— 所以宿主必须能把「工程内相对路径」翻成浏览器可
 * 直接取的 URL（`/web/{token}/{itemId}/{path...}`，同源、由 host 原样吐文件），
 * 并给出文件清单。这三件事的判据（路径规范化、URL 拼接、入口挑选、清单遍历）
 * 在 host 端点、编辑器与 `scripts/verify-web.mjs` 之间必须完全一致，故只有这一份。
 *
 * 与 `we-library-scan.mjs` 的分工：那个文件判**条目类型**，本文件只处理
 * 「已经是网页工程」之后的路径与清单，不重复类型判据。
 */

import { WEB_ENTRY_PATHS } from "./we-library-scan.mjs";

/** 文件清单上限：超过就报「清单不完整」而不是静默截断（静默截断会让另存丢文件） */
export const WEB_MANIFEST_MAX_FILES = 4000;

/** 清单遍历深度上限（网页工程资源最多几层，防符号链接环把遍历拖死） */
export const WEB_MANIFEST_MAX_DEPTH = 12;

/** 与 host/wallpaper-host.ts 的 itemId 校验同一条（`/api/editor/save-*` 用同一张正则） */
const ITEM_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * 工程内相对路径 → 规范化形态；非法（绝对、越界、空、含 NUL）返回 null。
 *
 * 比 `/api/editor/save-file` 的 `safeJoin` 更严：这里**不做**「把 `..` 夹回目录内」
 * 的宽容处理 —— 资源引用里的 `../` 只可能是作者写错或路径攻击，必须明确报错，
 * 不能让浏览器悄悄拿到别的文件。
 * @param {unknown} raw
 * @returns {string | null} 如 `js/app.js`
 */
export function normalizeWebRelPath(raw) {
  if (typeof raw !== "string") return null;
  if (raw.includes("\u0000")) return null;
  const segs = [];
  for (const seg of raw.replace(/\\/g, "/").split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") return null;
    segs.push(seg);
  }
  return segs.length ? segs.join("/") : null;
}

/**
 * 相对路径 → URL 路径片段：**逐段** encodeURIComponent。
 * 整串 encode 会把 `/` 也编掉；不 encode 则库里的空格/中文名（`Arthesian Library`、
 * `new 1`、`css/深 色/style.css`）拼出来的 URL 取不到文件。
 * @param {string} rel 已规范化的相对路径
 * @returns {string}
 */
export function encodeWebPath(rel) {
  return String(rel)
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

/**
 * 工程内相对路径 → 浏览器可取的 URL（同源，走 /web 端点）。
 * @param {string} itemId
 * @param {string} rel
 * @param {{ token?: string }} [opts]
 * @returns {string | null} 如 `/web/dev/1589757429/dvd.html`；itemId/路径非法返回 null
 */
export function webAssetUrl(itemId, rel, opts = {}) {
  const token = opts.token ?? "dev";
  const norm = normalizeWebRelPath(rel);
  if (!ITEM_ID_RE.test(String(itemId ?? "")) || !norm) return null;
  return `/web/${encodeURIComponent(token)}/${itemId}/${encodeWebPath(norm)}`;
}

/**
 * 网页工程入口 html（相对目录的路径）。
 *
 * project.json 声明的 `file` 优先 —— 但**必须真的在盘上**（1589757429 声明的是
 * `dvd.html`，而扫库侧对声明不做存在性校验）；声明缺失/不在盘上时按原生
 * `WEB_ENTRY_PATHS` 顺序退回根 `index.html`、`web/index.html`。大小写折叠匹配：
 * 库里存在 Windows 作者写的 `Index.HTML`。都没有返回 null（调用方给明确报错）。
 * @param {{ declared?: unknown, names?: Iterable<string> }} facts
 * @returns {string | null}
 */
export function pickWebEntry(facts = {}) {
  const lower = new Map([...((facts.names ?? []))].map((n) => [String(n).toLowerCase(), String(n)]));
  const decl = normalizeWebRelPath(facts.declared) ?? "";
  if (/\.html?$/i.test(decl)) {
    const hit = lower.get(decl.toLowerCase());
    if (hit) return hit;
  }
  for (const rel of WEB_ENTRY_PATHS) {
    const hit = lower.get(rel);
    if (hit) return hit;
  }
  return null;
}

/**
 * 遍历网页工程目录，列出全部资源文件（相对路径，已排序）。
 *
 * 跳过 `.` 开头的项：`.webwallgl-editor`（编辑器自建标记）与 `.DS_Store` 都是宿主/
 * 系统元数据，列进清单只会被编辑器当成资源再存一遍。排序是为了让「打开 → 保存 →
 * 重开」的清单逐项可比（readdir 顺序随文件系统变）。
 * 非目录项一律算文件（含符号链接：库里确实有工程用链接指向公共素材）；符号链接的
 * 目录会当成文件列出，`/web` 端点对目录路径会补 `index.html`，不影响取用。
 * @param {string} root 条目目录绝对路径
 * @param {{ maxFiles?: number, maxDepth?: number }} [opts]
 * @returns {Promise<{ files: string[], truncated: boolean }>}
 */
export async function listWebProjectFiles(root, opts = {}) {
  const { promises: fs } = await import("node:fs");
  const { join } = await import("node:path");
  const maxFiles = opts.maxFiles ?? WEB_MANIFEST_MAX_FILES;
  const maxDepth = opts.maxDepth ?? WEB_MANIFEST_MAX_DEPTH;
  const files = [];
  let truncated = false;
  const walk = async (rel, depth) => {
    if (truncated) return;
    if (depth > maxDepth) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = await fs.readdir(join(root, rel), { withFileTypes: true });
    } catch {
      return; // 读不到的目录（被删/无权限）按空处理，单项错误不炸整个清单
    }
    for (const ent of entries) {
      const name = ent.name;
      if (name.startsWith(".")) continue;
      const child = rel ? `${rel}/${name}` : name;
      if (ent.isDirectory()) {
        await walk(child, depth + 1);
        if (truncated) return;
        continue;
      }
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }
      files.push(child);
    }
  };
  await walk("", 0);
  files.sort();
  return { files, truncated };
}
