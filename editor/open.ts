// 打开来源（EDITOR-PLAN §3A.4）：本机壁纸库条目 / 本地 scene.pkg / 本地壁纸目录。
// 产出「文档 + 引擎 Source」：文档给图层树与检视器，Source 交给 mount 渲染预览。
// 全部在浏览器内完成，本地文件不出本机。

import { bytesSource, httpSource, mediaSource, type Source } from "../renderer/src/api/editor";
import { getEntry, parsePkg } from "../renderer/src/api/core";
import { makeDoc, type EditorDoc } from "./doc";

export type LibraryItem = {
  itemId: string;
  title: string;
  type: string;
  file?: string;
  preview?: string;
  hasScene: boolean;
  hasLooseScene?: boolean;
};

/** 场景资源按名读取（包或散装目录同口径）。结构编辑后由它 + 文档拼出挂载用的 Source */
export type SceneAssets = {
  /** 场景入口 json 的名字（scene.json / gifscene.json / project.file 声明的 json） */
  entry: string;
  read(name: string, signal?: AbortSignal): Promise<Uint8Array | null>;
  /**
   * 保存时要写出的资源名（不含入口 json）。包 = 全部条目；本地目录 = 全部文件；
   * 库里的松散工程没有目录清单，只能给出「引擎实际读到过的」—— 渲染所需已齐，
   * 脚本运行时按名动态读的文件可能漏。
   */
  list(): string[];
};

/** 包一层读取器，记下命中过的名字（库内松散工程无目录清单，靠它凑保存清单） */
function trackReads(entry: string, read: SceneAssets["read"]): SceneAssets {
  const seen = new Set<string>();
  return {
    entry,
    async read(name, signal) {
      const bytes = await read(name, signal);
      if (bytes) seen.add(name);
      return bytes;
    },
    list: () => [...seen].filter((n) => n !== entry),
  };
}

export type Opened = { doc: EditorDoc; source: Source; assets?: SceneAssets };

export type LocalFile = { path: string; file: File };

/** 与 scene/parse.js 的入口候选同序；project.file 声明的 json 优先 */
const SCENE_JSON_CANDIDATES = ["scene.json", "gifscene.json", "scenes/scene.json", "scenes/gifscene.json"];
const PKG_CANDIDATES = ["scene.pkg", "scenes/scene.pkg", "gifscene.pkg"];
const MEDIA_TYPES = new Set(["video", "gif", "image"]);

const decoder = new TextDecoder();

function parseJsonBytes(bytes: Uint8Array | ArrayBuffer | null): Record<string, unknown> | null {
  if (!bytes) return null;
  const text = decoder.decode(bytes).replace(/^\uFEFF/, "");
  const v = JSON.parse(text) as unknown;
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

function declaredFile(project: Record<string, unknown> | null): string {
  const raw = project?.file;
  return typeof raw === "string" ? raw.trim().replace(/^\/+/, "") : "";
}

function projectType(project: Record<string, unknown> | null): string {
  return typeof project?.type === "string" ? project.type.toLowerCase() : "";
}

function pkgAssets(bytes: ArrayBuffer, project: Record<string, unknown> | null): SceneAssets | null {
  const pkg = parsePkg(new Uint8Array(bytes));
  const declared = declaredFile(project);
  const names = /\.json$/i.test(declared) ? [declared, ...SCENE_JSON_CANDIDATES] : SCENE_JSON_CANDIDATES;
  const entry = names.find((name) => getEntry(pkg, name));
  if (!entry) return null;
  const all = (pkg.entries as Array<{ name: string }>).map((e) => e.name).filter((n) => n !== entry);
  return { entry, read: async (name) => getEntry(pkg, name) as Uint8Array | null, list: () => all };
}

async function sceneJsonOf(assets: SceneAssets | null) {
  return assets ? parseJsonBytes(await assets.read(assets.entry)) : null;
}

/**
 * 以文档为入口的挂载来源（EDITOR-PLAN §3A.3「文档改 → 整场景重挂」）：入口 json 换成
 * 序列化后的文档，其余资源原样从包 / 目录读。一律走松散形态 —— 两种形态的装配
 * 只在「按名取资源」这一处分叉（`readAsset`），语义一一对应。不给 key：每版文档都
 * 不同，进库内缓存只会挤掉别的条目。
 */
export function sourceFromDoc(base: Source, assets: SceneAssets, sceneJson: string, project?: Record<string, unknown> | null): Source {
  const entryBytes = new TextEncoder().encode(sceneJson);
  // project.json 也以文档为准（用户属性声明随文档走）；快照一份，挂载期间文档再改不串
  const projectSnap = project ? structuredClone(project) : null;
  return {
    async scenePkg() {
      throw new Error("文档来源只有松散形态");
    },
    async sceneDir() {
      return {
        entry: assets.entry,
        read: (name, signal) => (name === assets.entry ? Promise.resolve(entryBytes) : assets.read(name, signal)),
      };
    },
    project: projectSnap ? async () => structuredClone(projectSnap) : base.project ? (signal) => base.project!(signal) : undefined,
  };
}

// ---------- 本机壁纸库（dev 宿主） ----------

export async function fetchLibrary(): Promise<{ dir: string; items: LibraryItem[] } | null> {
  try {
    const res = await fetch("/api/library", { headers: { accept: "application/json" } });
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("application/json")) return null;
    const data = (await res.json()) as { dir: string; items: LibraryItem[]; error?: string };
    if (data.error) throw new Error(data.error);
    return { dir: data.dir, items: data.items ?? [] };
  } catch (e) {
    if (e instanceof Error && e.message && !/fetch/i.test(e.message)) throw e;
    return null;
  }
}

export function libraryKind(it: LibraryItem): string {
  return it.hasScene || it.hasLooseScene ? "scene" : it.type.toLowerCase();
}

export async function openLibraryItem(it: LibraryItem, mediaBase: string, webBase: string): Promise<Opened> {
  const kind = libraryKind(it);
  if (kind === "web") {
    const hs = httpSource(`${webBase}/${it.itemId}`);
    const project = (await hs.project?.()) as Record<string, unknown> | null;
    return { doc: makeDoc(it.title, project, null, null), source: hs };
  }
  const hs = httpSource(`${mediaBase}/${it.itemId}`);
  const project = (await hs.project?.()) as Record<string, unknown> | null;
  if (kind !== "scene") return { doc: makeDoc(it.title, project, null, null), source: hs };

  const dir = await hs.sceneDir?.();
  if (dir) {
    const assets = trackReads(dir.entry, (name, signal) => dir.read(name, signal));
    // 引擎也经同一个读取器取资源，保存清单才凑得齐。去掉 key：库内场景缓存命中时会
    // 复用上一次打开留下的读取器，新的这份就记不到读取（dir 自己按名缓存，不怕重复拉）
    const source: Source = { ...hs, key: undefined, sceneDir: async () => assets };
    return { doc: makeDoc(it.title, project, await sceneJsonOf(assets), "loose"), source, assets };
  }
  // 页面先取一次包字节：既解析图层树，也原样交给引擎，避免同一个包下载两遍
  const raw = await hs.scenePkg();
  const bytes = raw instanceof Uint8Array ? raw.slice().buffer : raw;
  const assets = pkgAssets(bytes, project);
  return {
    doc: makeDoc(it.title, project, await sceneJsonOf(assets), "pkg"),
    source: { ...hs, scenePkg: async () => bytes },
    assets: assets ?? undefined,
  };
}

// ---------- 本地文件 / 目录 ----------

/** 所有路径共享同一个顶层目录时去掉它（选目录 / 拖目录都会带上目录名） */
function stripCommonRoot(files: LocalFile[]): LocalFile[] {
  const norm = files.map((f) => ({ path: f.path.replace(/\\/g, "/").replace(/^\/+/, ""), file: f.file }));
  if (norm.length < 1 || norm.some((f) => !f.path.includes("/"))) return norm;
  const first = norm[0].path.split("/")[0];
  if (!norm.every((f) => f.path.startsWith(`${first}/`))) return norm;
  return norm.map((f) => ({ path: f.path.slice(first.length + 1), file: f.file }));
}

function rootName(files: LocalFile[]): string {
  const p = files[0]?.path.replace(/\\/g, "/").replace(/^\/+/, "") ?? "";
  return p.includes("/") ? p.split("/")[0] : "";
}

export async function openLocalFiles(input: LocalFile[]): Promise<Opened> {
  if (!input.length) throw new Error("empty");
  const fallbackTitle =
    rootName(input) || input.find((f) => /\.pkg$/i.test(f.path))?.file.name || input[0].file.name;
  const files = stripCommonRoot(input);
  const exact = new Map(files.map((f) => [f.path, f.file]));
  // WE 工程来自 Windows，作者引用的大小写与盘上不一致很常见
  const folded = new Map(files.map((f) => [f.path.toLowerCase(), f.file]));
  const lookup = (name: string): File | undefined => {
    const rel = name.replace(/\\/g, "/").replace(/^\/+/, "");
    return exact.get(rel) ?? folded.get(rel.toLowerCase());
  };

  const projectFile = lookup("project.json");
  const project = projectFile ? parseJsonBytes(await projectFile.arrayBuffer()) : null;
  const declared = declaredFile(project);
  const type = projectType(project);
  const title = typeof project?.title === "string" && project.title.trim() ? project.title.trim() : fallbackTitle;

  if (MEDIA_TYPES.has(type) && declared && lookup(declared)) {
    const file = lookup(declared)!;
    const doc = makeDoc(title, project, null, null);
    // 视频壁纸进编辑器可编辑（裁剪 / 替换 / 转场景），预览由页面自己的 <video> 承担
    if (type === "video") doc.video = { path: declared, bytes: new Uint8Array(await file.arrayBuffer()) };
    return { doc, source: mediaSource(file) };
  }
  if (type === "web") {
    throw new Error("本地网页壁纸目录暂不支持在编辑器里打开（相对资源无法从 blob 地址解析），请从壁纸库打开");
  }

  const pkgFile =
    (/\.pkg$/i.test(declared) ? lookup(declared) : undefined) ??
    PKG_CANDIDATES.map(lookup).find(Boolean) ??
    files.find((f) => /\.pkg$/i.test(f.path))?.file;
  const looseEntry = /\.json$/i.test(declared) && !/^preview\./i.test(declared) ? declared : "";
  const looseFile = looseEntry ? lookup(looseEntry) : SCENE_JSON_CANDIDATES.map(lookup).find(Boolean);

  // 有散装入口 json 时按松散工程走（与 sceneFormOf 同口径：作者源码目录优先于打包产物）
  if (looseFile) {
    const entry = looseEntry || SCENE_JSON_CANDIDATES.find((n) => lookup(n)) || "scene.json";
    const scene = parseJsonBytes(await looseFile.arrayBuffer());
    const cache = new Map<string, Uint8Array>();
    const assets: SceneAssets = {
      entry,
      async read(name: string) {
        const hit = cache.get(name);
        if (hit) return hit;
        const f = lookup(name);
        if (!f) return null;
        const bytes = new Uint8Array(await f.arrayBuffer());
        cache.set(name, bytes);
        return bytes;
      },
      list: () => files.map((f) => f.path).filter((p) => p !== entry),
    };
    const source: Source = {
      key: `local-dir:${title}:${Date.now()}`,
      async scenePkg() {
        throw new Error("松散工程没有 scene.pkg");
      },
      async sceneDir() {
        return assets;
      },
      async project() {
        return project;
      },
    };
    return { doc: makeDoc(title, project, scene, "loose"), source, assets };
  }

  if (pkgFile) {
    const bytes = await pkgFile.arrayBuffer();
    const assets = pkgAssets(bytes, project);
    const key = `file:${pkgFile.name}:${pkgFile.size}:${pkgFile.lastModified}`;
    return {
      doc: makeDoc(title, project, await sceneJsonOf(assets), "pkg"),
      source: bytesSource(bytes, project, key),
      assets: assets ?? undefined,
    };
  }

  throw new Error("no-wallpaper");
}

// ---------- 拖放收集 ----------

type FsEntry = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath: string;
  file?(ok: (f: File) => void, err: (e: unknown) => void): void;
  createReader?(): { readEntries(ok: (list: FsEntry[]) => void, err: (e: unknown) => void): void };
};

async function walkEntry(entry: FsEntry, out: LocalFile[]): Promise<void> {
  if (entry.isFile && entry.file) {
    const file = await new Promise<File>((ok, err) => entry.file!(ok, err));
    out.push({ path: entry.fullPath.replace(/^\/+/, ""), file });
    return;
  }
  if (entry.isDirectory && entry.createReader) {
    const reader = entry.createReader();
    // readEntries 每次最多返回一批（Chromium 100 条），要读到空为止
    for (;;) {
      const batch = await new Promise<FsEntry[]>((ok, err) => reader.readEntries(ok, err));
      if (!batch.length) break;
      for (const child of batch) await walkEntry(child, out);
    }
  }
}

export async function collectDropped(dt: DataTransfer): Promise<LocalFile[]> {
  const out: LocalFile[] = [];
  const entries: FsEntry[] = [];
  for (const item of Array.from(dt.items)) {
    const entry = (item as DataTransferItem & { webkitGetAsEntry?(): FsEntry | null }).webkitGetAsEntry?.();
    if (entry) entries.push(entry);
  }
  if (entries.length) {
    for (const e of entries) await walkEntry(e, out);
    return out;
  }
  for (const file of Array.from(dt.files)) out.push({ path: file.name, file });
  return out;
}

export function filesFromInput(list: FileList | null): LocalFile[] {
  return Array.from(list ?? []).map((file) => ({
    path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
    file,
  }));
}
