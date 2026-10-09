// 保存链路（EDITOR-PLAN E2 W6-lite / §3A.4）：默认产物是松散形态 ——
// project.json + 入口 scene.json（文档序列化）+ 资源原样散装 + 封面。
// pkg 来源的条目按原名写成散装文件即可被松散读端加载：两种形态的装配只在
// 「按名取资源」一处分叉，名字一一对应。
// W6-full 的 WE 原生形态（packProject）：除 project.json / 封面外全部进 scene.pkg，
// project.json 的 file 仍指入口 json —— 与创意工坊条目同形（读端先试散装入口、取不到回退 pkg）。

import { buildScenePkg, type ScenePkgResult } from "../renderer/src/api/editor";
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
  /** 仍然挂在资源表里、但这一轮读不到字节的名字：调用方别把已写出的同名文件删掉（审计 M2） */
  unreadable?: Set<string>,
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
    else unreadable?.add(name);
    onProgress?.(++done, names.length);
  }
  out.push({ path: assets.entry, data: enc.encode(JSON.stringify(doc.scene, null, 2)) });
  if (preview) out.push({ path: PREVIEW_NAME, data: new Uint8Array(await preview.arrayBuffer()) });
  out.push({ path: "project.json", data: enc.encode(JSON.stringify(projectJson(doc, assets.entry, !!preview), null, 2)) });
  return out;
}

/**
 * 写出的网页工程描述（`type:"web"` 打开 → 保存**不改型**）。
 *
 * 与场景工程的两处关键差别：
 * - `type` 不写死：作者怎么写就怎么写（"Web" / "web"），声明缺失时才补 "web"，
 *   **绝不写 scene** —— 否则存一次就把网页壁纸变成场景工程了；
 * - `preview` 不删也不换：网页工程的封面是作者自己的 preview.gif / preview.jpg，
 *   编辑器不产出新封面（capturePreview 要场景实例，web 没有），删掉就等于丢封面。
 */
function webProjectJson(doc: EditorDoc, entry: string, hasPreview: boolean): Record<string, unknown> {
  const p: Record<string, unknown> = structuredClone(doc.project ?? {});
  p.title = typeof p.title === "string" && p.title.trim() ? p.title : doc.title;
  const declaredType = typeof p.type === "string" ? p.type.trim() : "";
  p.type = declaredType || "web";
  p.file = entry;
  if (hasPreview) p.preview = PREVIEW_NAME;
  // 另存出来的是一份新工程，不再是创意工坊那一项
  delete p.workshopid;
  delete p.workshopurl;
  return p;
}

/**
 * 网页工程：project.json + 入口 html（**原样字节**）+ 其余资源原样。
 *
 * 与场景工程的关键差别在入口那一步：scene 的入口是文档序列化出来的 json，而 web 的
 * 入口是作者写的 html —— 必须原样写回（把 html 塞进 JSON.stringify 会当场写坏工程）。
 * 另一个差别是资源读不到时的态度：场景工程跳过缺失资源，网页工程的清单就是工程本体，
 * 少写一个文件等于工程坏了，所以这里直接抛错。
 */
export async function collectWebProject(
  doc: EditorDoc,
  assets: SceneAssets,
  preview: Blob | null,
  onProgress?: (done: number, total: number) => void,
): Promise<SaveFile[]> {
  const enc = new TextEncoder();
  const skip = new Set(["project.json", PREVIEW_NAME, assets.entry.toLowerCase()]);
  const names = assets.list().filter((n) => !skip.has(n.toLowerCase()));
  const out: SaveFile[] = [];
  let done = 0;
  for (const name of names) {
    const bytes = await assets.read(name);
    if (!bytes) throw new Error(`网页壁纸工程资源读取失败：${name}`);
    out.push({ path: name, data: bytes });
    onProgress?.(++done, names.length + 1);
  }
  const entryBytes = await assets.read(assets.entry);
  if (!entryBytes) throw new Error(`网页壁纸工程入口读取失败：${assets.entry}`);
  out.push({ path: assets.entry, data: entryBytes });
  onProgress?.(++done, names.length + 1);
  if (preview) out.push({ path: PREVIEW_NAME, data: new Uint8Array(await preview.arrayBuffer()) });
  out.push({
    path: "project.json",
    data: enc.encode(JSON.stringify(webProjectJson(doc, assets.entry, !!preview), null, 2)),
  });
  return out;
}

/** 视频壁纸工程：project.json（type = video）+ 视频本体 + 封面。WE 的视频壁纸不进 pkg */
export async function collectVideoProject(doc: EditorDoc, preview: Blob | null): Promise<SaveFile[]> {
  if (!doc.video) throw new Error("没有可保存的视频");
  const enc = new TextEncoder();
  const p: Record<string, unknown> = structuredClone(doc.project ?? {});
  p.title = typeof p.title === "string" && p.title.trim() ? p.title : doc.title;
  p.type = "video";
  p.file = doc.video.path;
  if (preview) p.preview = PREVIEW_NAME;
  else delete p.preview;
  delete p.workshopid;
  delete p.workshopurl;
  const out: SaveFile[] = [{ path: doc.video.path, data: doc.video.bytes }];
  if (preview) out.push({ path: PREVIEW_NAME, data: new Uint8Array(await preview.arrayBuffer()) });
  out.push({ path: "project.json", data: enc.encode(JSON.stringify(p, null, 2)) });
  return out;
}

export const SCENE_PKG_NAME = "scene.pkg";
const OUTSIDE_PKG = new Set(["project.json", PREVIEW_NAME]);

/** 松散清单 → WE 原生形态：project.json + 封面 + scene.pkg */
export function packProject(files: SaveFile[]): { files: SaveFile[]; packed: ScenePkgResult } {
  const packed = buildScenePkg(files.filter((f) => !OUTSIDE_PKG.has(f.path)));
  return {
    files: [...files.filter((f) => OUTSIDE_PKG.has(f.path)), { path: SCENE_PKG_NAME, data: packed.pkg }],
    packed,
  };
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

type Writable = { write(data: BufferSource | Blob): Promise<void>; close(): Promise<void> };

export type FileHandle = {
  kind?: string;
  name?: string;
  getFile(): Promise<File>;
  createWritable(): Promise<Writable>;
};

export type DirHandle = {
  name: string;
  kind?: string;
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<DirHandle>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileHandle>;
  entries(): AsyncIterable<[string, DirHandle | FileHandle]>;
  removeEntry(name: string, opts?: { recursive?: boolean }): Promise<void>;
};

export const canPickDirectory = () => typeof (window as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function";

export async function pickDirectory(): Promise<DirHandle | null> {
  const w = window as unknown as { showDirectoryPicker(o: { mode: string }): Promise<DirHandle> };
  try {
    return await w.showDirectoryPicker({ mode: "readwrite" });
  } catch (e) {
    if ((e as Error).name === "AbortError") return null;
    throw e;
  }
}

const WRITE_PROBE = ".webwallgl-write-test";

/** 真写一次再删掉：有的浏览器（如内嵌 Electron）给了目录句柄却不给写权限 */
export async function probeWritable(dir: DirHandle): Promise<void> {
  const fh = await dir.getFileHandle(WRITE_PROBE, { create: true });
  const w = await fh.createWritable();
  await w.write(new Uint8Array([0x6f, 0x6b]));
  await w.close();
  await dir.removeEntry(WRITE_PROBE);
}

/** 把目录句柄读成打开用的文件表（路径相对项目根） */
export async function filesFromDirectory(root: DirHandle): Promise<Array<{ path: string; file: File }>> {
  const out: Array<{ path: string; file: File }> = [];
  const walk = async (dir: DirHandle, prefix: string) => {
    for await (const [name, handle] of dir.entries()) {
      const rel = prefix ? `${prefix}/${name}` : name;
      if (handle.kind === "directory") await walk(handle as DirHandle, rel);
      else if ("getFile" in handle && handle.getFile) out.push({ path: rel, file: await handle.getFile() });
    }
  };
  await walk(root, "");
  return out;
}

/** 删掉项目里不再引用、且曾经由编辑器写出的文件 */
export async function removeProjectFile(root: DirHandle, rel: string): Promise<void> {
  const parts = rel.split("/").filter(Boolean);
  if (!parts.length) return;
  let dir = root;
  for (const seg of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(seg);
  await dir.removeEntry(parts[parts.length - 1]);
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
