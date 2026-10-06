// 保存链路（EDITOR-PLAN E2 W6-lite / §3A.4）：产物一律松散形态 ——
// project.json + 入口 scene.json（文档序列化）+ 资源原样散装 + 封面。
// pkg 来源的条目按原名写成散装文件即可被松散读端加载：两种形态的装配只在
// 「按名取资源」一处分叉，名字一一对应。

import type { EditorDoc } from "./doc";
import type { SceneAssets } from "./open";
import { buildZip } from "./zip";

export type SaveFile = { path: string; data: Uint8Array };

export const PREVIEW_NAME = "preview.jpg";

/** 写出的工程描述：入口指向文档，类型定为 scene，封面换成编辑器出的图 */
function projectJson(doc: EditorDoc, entry: string, hasPreview: boolean): Record<string, unknown> {
  const p: Record<string, unknown> = structuredClone(doc.project ?? {});
  p.title = typeof p.title === "string" && p.title.trim() ? p.title : doc.title;
  p.type = "scene";
  p.file = entry;
  // 原封面文件在包外（库条目目录里），不在保存清单内；没出图就别留一个悬空引用
  if (hasPreview) p.preview = PREVIEW_NAME;
  else delete p.preview;
  // 另存出来的是一份新工程，不再是创意工坊那一项
  delete p.workshopid;
  delete p.workshopurl;
  return p;
}

export async function collectProject(
  doc: EditorDoc,
  assets: SceneAssets,
  preview: Blob | null,
  onProgress?: (done: number, total: number) => void,
): Promise<SaveFile[]> {
  if (!doc.scene) throw new Error("没有可保存的场景文档");
  const enc = new TextEncoder();
  const skip = new Set([assets.entry.toLowerCase(), "project.json", PREVIEW_NAME]);
  const names = assets.list().filter((n) => !skip.has(n.toLowerCase()));
  const out: SaveFile[] = [];
  let done = 0;
  for (const name of names) {
    const bytes = await assets.read(name);
    if (bytes) out.push({ path: name, data: bytes });
    onProgress?.(++done, names.length);
  }
  out.push({ path: assets.entry, data: enc.encode(JSON.stringify(doc.scene, null, 2)) });
  if (preview) out.push({ path: PREVIEW_NAME, data: new Uint8Array(await preview.arrayBuffer()) });
  out.push({ path: "project.json", data: enc.encode(JSON.stringify(projectJson(doc, assets.entry, !!preview), null, 2)) });
  return out;
}

export const totalBytes = (files: SaveFile[]) => files.reduce((s, f) => s + f.data.length, 0);

/** 文件名安全化：只保留常见字符，空了用 wallpaper */
export function slugName(title: string): string {
  const s = title
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  return s || "wallpaper";
}

// ---------- 目标一：下载 zip ----------

export function downloadZip(files: SaveFile[], name: string): number {
  const blob = buildZip(files);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name}.zip`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return blob.size;
}

// ---------- 目标二：写入本机文件夹（File System Access API，Chromium） ----------

type DirHandle = {
  name: string;
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<DirHandle>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<{
    createWritable(): Promise<{ write(data: BufferSource | Blob): Promise<void>; close(): Promise<void> }>;
  }>;
};

export const canPickDirectory = () => typeof (window as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function";

export async function pickDirectory(): Promise<DirHandle | null> {
  const pick = (window as unknown as { showDirectoryPicker(o: { mode: string }): Promise<DirHandle> }).showDirectoryPicker;
  try {
    return await pick({ mode: "readwrite" });
  } catch (e) {
    if ((e as Error).name === "AbortError") return null;
    throw e;
  }
}

export async function writeToDirectory(
  root: DirHandle,
  files: SaveFile[],
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const dirs = new Map<string, DirHandle>([["", root]]);
  const dirOf = async (rel: string): Promise<DirHandle> => {
    const hit = dirs.get(rel);
    if (hit) return hit;
    const i = rel.lastIndexOf("/");
    const parent = await dirOf(i < 0 ? "" : rel.slice(0, i));
    const h = await parent.getDirectoryHandle(rel.slice(i + 1), { create: true });
    dirs.set(rel, h);
    return h;
  };
  let done = 0;
  for (const f of files) {
    const parts = f.path.split("/").filter(Boolean);
    const dir = await dirOf(parts.slice(0, -1).join("/"));
    const fh = await dir.getFileHandle(parts[parts.length - 1], { create: true });
    const w = await fh.createWritable();
    await w.write(f.data as Uint8Array<ArrayBuffer>);
    await w.close();
    onProgress?.(++done, files.length);
  }
}

// ---------- 目标三：dev 宿主写回壁纸库（POST /api/editor/save*） ----------

/** 新建库条目 id：editor-<slug>-<时间戳>，宿主只认 [A-Za-z0-9_-] */
export function newLibraryItemId(title: string): string {
  const ascii = title
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 24);
  return `editor-${ascii || "wallpaper"}-${Date.now().toString(36)}`;
}

async function hostCall(path: string, init: RequestInit): Promise<void> {
  const res = await fetch(path, init);
  if (res.ok) return;
  let msg = `${res.status}`;
  try {
    msg = ((await res.json()) as { error?: string }).error ?? msg;
  } catch {
    /* 非 JSON 回执 */
  }
  throw new Error(msg);
}

export async function saveToLibrary(
  itemId: string,
  files: SaveFile[],
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const q = `item=${encodeURIComponent(itemId)}`;
  await hostCall(`/api/editor/save-begin?${q}`, { method: "POST" });
  let done = 0;
  for (const f of files) {
    await hostCall(`/api/editor/save-file?${q}&path=${encodeURIComponent(f.path)}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: f.data as Uint8Array<ArrayBuffer>,
    });
    onProgress?.(++done, files.length);
  }
}
