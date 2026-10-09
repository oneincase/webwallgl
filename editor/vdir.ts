// 虚拟工程目录：内置浏览器（Electron/受限 WebView）里没有 File System Access API，
// `window.showDirectoryPicker` 不存在，于是「新建项目 / 打开文件夹 / 自动保存」全都没法落盘。
// 这里用 IndexedDB 顶上：一个虚拟工程 = 一个虚拟目录，实现的接口与 save.ts 的
// DirHandle / FileHandle **完全一致**，所以 writeToDirectory / filesFromDirectory /
// removeProjectFile / probeWritable 一行不用改就能往里写和读。
//
// 存储形态：每个工程一条 meta 记录（id / name / 时间），每个文件一条记录（键 = id + "\0" + 相对路径，
// 值 = Blob）。目录不单独记录 —— 有文件落在其下就算存在，这足够覆盖工程目录的全部用法。
// 后端可换（测试用内存实现，页面用 IndexedDB），模块顶层不碰 indexedDB。

import type { DirHandle, FileHandle } from "./save";
import { slugName } from "./save";

export type VdirRecord = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
};

/** 虚拟目录的存储后端：页面接 IndexedDB，测试接内存实现 */
export type VdirBackend = {
  listMeta(): Promise<VdirRecord[]>;
  putMeta(rec: VdirRecord): Promise<void>;
  delMeta(id: string): Promise<void>;
  keys(id: string): Promise<string[]>;
  read(id: string, rel: string): Promise<Blob | null>;
  write(id: string, rel: string, blob: Blob): Promise<void>;
  remove(id: string, rel: string): Promise<void>;
  clear(id: string): Promise<void>;
};

export const VDIR_DB = "webwallgl-vdir";
const META = "projects";
const FILES = "files";
const SEP = "\u0000";

const notFound = (msg: string) => new DOMException(msg, "NotFoundError");
const badName = (msg: string) => new DOMException(msg, "TypeError");

/** IndexedDB 实现（页面用） */
export function idbVdirBackend(dbName = VDIR_DB): VdirBackend {
  let dbp: Promise<IDBDatabase> | null = null;
  const db = () =>
    (dbp ??= new Promise<IDBDatabase>((ok, err) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(META)) d.createObjectStore(META, { keyPath: "id" });
        if (!d.objectStoreNames.contains(FILES)) d.createObjectStore(FILES);
      };
      req.onsuccess = () => ok(req.result);
      req.onerror = () => err(req.error);
    }));
  const run = async <T>(store: string, mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const d = await db();
    return new Promise<T>((ok, err) => {
      const tx = d.transaction(store, mode);
      const req = op(tx.objectStore(store));
      tx.oncomplete = () => ok(req.result);
      tx.onerror = () => err(tx.error);
      tx.onabort = () => err(tx.error);
    });
  };
  const key = (id: string, rel: string) => `${id}${SEP}${rel}`;
  return {
    listMeta: async () => ((await run<VdirRecord[]>(META, "readonly", (s) => s.getAll())) ?? []).filter((r) => !!r && typeof r.id === "string"),
    putMeta: (rec) => run(META, "readwrite", (s) => s.put(rec)).then(() => undefined),
    delMeta: (id) => run(META, "readwrite", (s) => s.delete(id)).then(() => undefined),
    keys: async (id) => {
      const all = (await run<IDBValidKey[]>(FILES, "readonly", (s) => s.getAllKeys())) ?? [];
      const pre = `${id}${SEP}`;
      return all.map(String).filter((k) => k.startsWith(pre)).map((k) => k.slice(pre.length));
    },
    read: async (id, rel) => ((await run<{ blob: Blob } | undefined>(FILES, "readonly", (s) => s.get(key(id, rel))))?.blob ?? null),
    write: (id, rel, blob) => run(FILES, "readwrite", (s) => s.put({ blob }, key(id, rel))).then(() => undefined),
    remove: (id, rel) => run(FILES, "readwrite", (s) => s.delete(key(id, rel))).then(() => undefined),
    clear: async (id) => {
      const ks = await (async () => {
        const all = (await run<IDBValidKey[]>(FILES, "readonly", (s) => s.getAllKeys())) ?? [];
        const pre = `${id}${SEP}`;
        return all.map(String).filter((k) => k.startsWith(pre));
      })();
      for (const k of ks) await run(FILES, "readwrite", (s) => s.delete(k));
    },
  };
}

/** 内存实现（离线判据用；同一份代码真跑，不抄第二份逻辑） */
export function memoryVdirBackend(): VdirBackend {
  const meta = new Map<string, VdirRecord>();
  const files = new Map<string, Blob>();
  const key = (id: string, rel: string) => `${id}${SEP}${rel}`;
  return {
    listMeta: async () => [...meta.values()].map((r) => ({ ...r })),
    putMeta: async (rec) => void meta.set(rec.id, { ...rec }),
    delMeta: async (id) => void meta.delete(id),
    keys: async (id) => [...files.keys()].filter((k) => k.startsWith(`${id}${SEP}`)).map((k) => k.slice(id.length + 1)),
    read: async (id, rel) => files.get(key(id, rel)) ?? null,
    write: async (id, rel, blob) => void files.set(key(id, rel), blob),
    remove: async (id, rel) => void files.delete(key(id, rel)),
    clear: async (id) => {
      for (const k of [...files.keys()]) if (k.startsWith(`${id}${SEP}`)) files.delete(k);
    },
  };
}

let backend: VdirBackend | null = null;
/** 页面默认后端（懒建，模块顶层不碰 indexedDB）；连 IndexedDB 都没有时退化成会话内内存后端，
 *  保证「内置浏览器里新建项目」这条主路径任何环境都不会因为存储不可用而整条断掉（只是刷新后不再找回）。 */
export function vdirBackend(): VdirBackend {
  if (!backend) backend = typeof globalThis.indexedDB === "undefined" ? memoryVdirBackend() : idbVdirBackend();
  return backend;
}
/** 换后端：测试用 */
export function setVdirBackend(be: VdirBackend | null): void {
  backend = be;
}

/** 新建虚拟工程的 id：vdir-<slug>-<时间戳>（与库条目 id 同一套 slug 规则） */
export function newVirtualId(name: string, now = Date.now()): string {
  const slug = slugName(name)
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 24);
  return `vdir-${slug || "wallpaper"}-${now.toString(36)}`;
}

const joinRel = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

/** 一个虚拟目录句柄树；files 是整工程的相对路径集合，全树共享 */
class VdirHandle implements DirHandle {
  readonly kind = "directory";
  /** 工程 id：DirHandle 标准里没有，本模块与页面内部靠它认「这是虚拟目录」（见 virtualIdOf） */
  readonly vdirId: string;
  constructor(
    private readonly be: VdirBackend,
    private readonly rec: VdirRecord,
    public name: string,
    private readonly rel: string,
    private readonly files: Set<string>,
  ) {
    this.vdirId = rec.id;
  }

  private touch() {
    this.rec.updatedAt = Date.now();
    void this.be.putMeta({ ...this.rec });
  }

  private childDirNames(): Set<string> {
    const pre = this.rel ? `${this.rel}/` : "";
    const out = new Set<string>();
    for (const f of this.files) {
      if (!f.startsWith(pre)) continue;
      const rest = f.slice(pre.length);
      const i = rest.indexOf("/");
      if (i > 0) out.add(rest.slice(0, i));
    }
    return out;
  }

  private childFileNames(): string[] {
    const pre = this.rel ? `${this.rel}/` : "";
    const out: string[] = [];
    for (const f of this.files) {
      if (!f.startsWith(pre)) continue;
      const rest = f.slice(pre.length);
      if (rest && !rest.includes("/")) out.push(rest);
    }
    return out.sort();
  }

  async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<DirHandle> {
    if (!name || name.includes("/") || name.includes("\\")) throw badName(`目录名不合法：${name}`);
    const rel = joinRel(this.rel, name);
    const exists = [...this.files].some((f) => f.startsWith(`${rel}/`));
    if (!exists && !opts?.create) throw notFound(`没有目录 ${rel}`);
    return new VdirHandle(this.be, this.rec, name, rel, this.files);
  }

  async getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileHandle> {
    if (!name || name.includes("/") || name.includes("\\")) throw badName(`文件名不合法：${name}`);
    const rel = joinRel(this.rel, name);
    if (this.files.has(rel)) return new VdirFileHandle(this.be, this.rec, name, rel, this.files);
    if (!opts?.create) throw notFound(`没有文件 ${rel}`);
    this.files.add(rel);
    await this.be.write(this.rec.id, rel, new Blob([]));
    this.touch();
    return new VdirFileHandle(this.be, this.rec, name, rel, this.files);
  }

  async *entries(): AsyncIterable<[string, DirHandle | FileHandle]> {
    for (const d of [...this.childDirNames()].sort()) yield [d, new VdirHandle(this.be, this.rec, d, joinRel(this.rel, d), this.files)];
    for (const f of this.childFileNames()) yield [f, new VdirFileHandle(this.be, this.rec, f, joinRel(this.rel, f), this.files)];
  }

  async removeEntry(name: string, opts?: { recursive?: boolean }): Promise<void> {
    const rel = joinRel(this.rel, name);
    const kids = [...this.files].filter((f) => f.startsWith(`${rel}/`));
    if (kids.length) {
      if (!opts?.recursive) throw new DOMException(`目录非空：${rel}`, "InvalidModificationError");
      for (const f of kids) {
        this.files.delete(f);
        await this.be.remove(this.rec.id, f);
      }
      this.touch();
      return;
    }
    if (!this.files.has(rel)) throw notFound(`没有条目 ${rel}`);
    this.files.delete(rel);
    await this.be.remove(this.rec.id, rel);
    this.touch();
  }
}

class VdirFileHandle implements FileHandle {
  readonly kind = "file";
  constructor(
    private readonly be: VdirBackend,
    private readonly rec: VdirRecord,
    public name: string,
    private readonly rel: string,
    private readonly files: Set<string>,
  ) {}

  async getFile(): Promise<File> {
    if (!this.files.has(this.rel)) throw notFound(`没有文件 ${this.rel}`);
    const blob = (await this.be.read(this.rec.id, this.rel)) ?? new Blob([]);
    return new File([blob], this.name, { lastModified: this.rec.updatedAt });
  }

  async createWritable(): Promise<{ write(data: BufferSource | Blob): Promise<void>; close(): Promise<void> }> {
    const chunks: BlobPart[] = [];
    const be = this.be;
    const rec = this.rec;
    const rel = this.rel;
    const files = this.files;
    return {
      async write(data) {
        // 立刻拷一份：真实 API 的 write 也不会被调用方后续改动影响
        if (data instanceof Blob) chunks.push(data);
        else if (ArrayBuffer.isView(data)) chunks.push(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
        else chunks.push(new Uint8Array(data).slice());
      },
      async close() {
        files.add(rel);
        await be.write(rec.id, rel, new Blob(chunks));
        rec.updatedAt = Date.now();
        await be.putMeta({ ...rec });
      },
    };
  }
}

/** 工程列表：按最近更新排前面 */
export async function listVirtualProjects(be: VdirBackend = vdirBackend()): Promise<VdirRecord[]> {
  const all = await be.listMeta();
  return all.filter((r) => r && typeof r.id === "string" && typeof r.name === "string").sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

/** 新建一个虚拟工程目录（落一条 meta + 空文件集） */
export async function createVirtualProject(name: string, be: VdirBackend = vdirBackend(), now = Date.now()): Promise<DirHandle> {
  const id = newVirtualId(name, now);
  const rec: VdirRecord = { id, name: name.trim() || "未命名壁纸", createdAt: now, updatedAt: now };
  await be.putMeta(rec);
  return new VdirHandle(be, rec, rec.name, "", new Set(await be.keys(id)));
}

/** 打开已有虚拟工程；不在了返回 null */
export async function openVirtualProject(id: string, be: VdirBackend = vdirBackend()): Promise<DirHandle | null> {
  const rec = (await be.listMeta()).find((r) => r.id === id);
  if (!rec) return null;
  return new VdirHandle(be, rec, rec.name, "", new Set(await be.keys(id)));
}

/** 改名（工程名 = 虚拟目录名）；目录句柄树下次打开才看到新名字 */
export async function renameVirtualProject(id: string, name: string, be: VdirBackend = vdirBackend()): Promise<void> {
  const rec = (await be.listMeta()).find((r) => r.id === id);
  if (!rec) return;
  await be.putMeta({ ...rec, name: name.trim() || rec.name, updatedAt: Date.now() });
}

export async function deleteVirtualProject(id: string, be: VdirBackend = vdirBackend()): Promise<void> {
  await be.clear(id);
  await be.delMeta(id);
}

const LAST_KEY = "webwallgl-vdir-last";

/** 上次打开的虚拟工程 id（刷新 / 重开编辑器时恢复） */
export function lastVirtualProjectId(): string | null {
  try {
    return localStorage.getItem(LAST_KEY);
  } catch {
    return null;
  }
}

export function setLastVirtualProjectId(id: string | null): void {
  try {
    if (id) localStorage.setItem(LAST_KEY, id);
    else localStorage.removeItem(LAST_KEY);
  } catch {
    /* 无痕模式等：恢复不了就算了，不影响本次会话 */
  }
}

/** 句柄是不是本模块造的虚拟目录；是则给出工程 id（页面用它做「上次打开」与改名） */
export function virtualIdOf(dir: unknown): string | null {
  const id = (dir as { vdirId?: unknown } | null | undefined)?.vdirId;
  return typeof id === "string" && id ? id : null;
}

/** 改名并同步已拿到的句柄名字（工程名 = 文档标题；句柄在内存里也要跟上，日志与状态栏才不显示旧名） */
export async function renameVirtualDir(dir: DirHandle, name: string, be: VdirBackend = vdirBackend()): Promise<void> {
  const id = virtualIdOf(dir);
  if (!id) return;
  const next = name.trim();
  if (!next) return;
  await renameVirtualProject(id, next, be);
  dir.name = next;
}
