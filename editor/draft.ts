// 草稿（EDITOR-PLAN §3A.4「IndexedDB 草稿」）：未保存的编辑定时快照到 IndexedDB，
// 刷新 / 崩溃后打开编辑器时提示恢复。单槽位 —— 只保留最近一份。
// 来源须能再次取到原始资源才可恢复：新建工程（资源全在快照里）与壁纸库条目（按 itemId
// 重新打开）。本地文件 / 目录的 File 句柄刷新后失效，不做草稿。

import { rebuildTree, type EditorDoc } from "./doc";
import type { AddedFile } from "./assets";

export type DraftOrigin = { kind: "new" } | { kind: "library"; itemId: string };

export type Draft = {
  v: 1;
  savedAt: number;
  title: string;
  origin: DraftOrigin;
  /** 入口 json 名（新建工程恒为 scene.json） */
  entry: string;
  project: Record<string, unknown> | null;
  scene: Record<string, unknown>;
  /** 资源表叠加层里的文件（新增图片等） */
  files: AddedFile[];
};

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export function makeDraft(
  doc: EditorDoc,
  origin: DraftOrigin,
  entry: string,
  files: AddedFile[],
  now = Date.now(),
): Draft | null {
  if (!doc.scene) return null;
  return {
    v: 1,
    savedAt: now,
    title: doc.title,
    origin: clone(origin),
    entry,
    project: doc.project ? clone(doc.project) : null,
    scene: clone(doc.scene),
    files: files.map((f) => ({ name: f.name, group: Array.isArray(f.group) ? [...f.group] : f.group, data: f.data.slice() })),
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** 库里读出来的东西不可信（旧版本 / 手改）：形状不对一律当没有 */
export function parseDraft(raw: unknown): Draft | null {
  if (!isObj(raw) || raw.v !== 1) return null;
  if (typeof raw.savedAt !== "number" || typeof raw.title !== "string" || typeof raw.entry !== "string") return null;
  if (!isObj(raw.scene) || !(raw.project === null || isObj(raw.project))) return null;
  const o = raw.origin;
  if (!isObj(o)) return null;
  if (o.kind !== "new" && !(o.kind === "library" && typeof o.itemId === "string" && o.itemId)) return null;
  if (!Array.isArray(raw.files)) return null;
  for (const f of raw.files) {
    if (!isObj(f) || typeof f.name !== "string" || !(f.data instanceof Uint8Array)) return null;
    const g = f.group;
    if (g !== undefined && typeof g !== "string" && !(Array.isArray(g) && g.every((x) => typeof x === "string"))) return null;
  }
  return raw as unknown as Draft;
}

/** 把草稿的文档部分写回（标题 / 工程 / 场景），重建图层树 */
export function applyDraft(doc: EditorDoc, draft: Draft): void {
  doc.title = draft.title;
  doc.project = draft.project ? clone(draft.project) : null;
  doc.scene = clone(draft.scene);
  rebuildTree(doc);
}

export type DraftStore = {
  load(): Promise<Draft | null>;
  save(d: Draft): Promise<void>;
  clear(): Promise<void>;
};

const STORE = "drafts";
const KEY = "current";

export function idbDraftStore(dbName = "webwallgl-editor"): DraftStore {
  let dbp: Promise<IDBDatabase> | null = null;
  const db = () =>
    (dbp ??= new Promise<IDBDatabase>((ok, err) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => ok(req.result);
      req.onerror = () => err(req.error);
    }));
  const run = async <T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest<T>) => {
    const d = await db();
    return new Promise<T>((ok, err) => {
      const tx = d.transaction(STORE, mode);
      const req = op(tx.objectStore(STORE));
      tx.oncomplete = () => ok(req.result);
      tx.onerror = () => err(tx.error);
      tx.onabort = () => err(tx.error);
    });
  };
  return {
    load: async () => parseDraft(await run("readonly", (s) => s.get(KEY))),
    save: async (d) => void (await run("readwrite", (s) => s.put(d, KEY))),
    clear: async () => void (await run("readwrite", (s) => s.delete(KEY))),
  };
}
