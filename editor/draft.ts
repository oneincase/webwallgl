// 草稿（EDITOR-PLAN §3A.4「IndexedDB 草稿」；计划 §2 C3/C6）：**未保存的编辑**定时快照到
// 浏览器存储，刷新 / 崩溃后重开编辑器时提示并逐字段恢复。
//
// 存储域与虚拟工程（editor/vdir.ts）共用：同一套 VdirBackend，落在 `DRAFT_ID` 这个保留 id 下的
// 文件键空间里（键 = `__draft__\0<槽>`），既不写 vdir 的工程 meta，也不会撞上任何工程 id
// （工程 id 形如 `vdir-*` 或库条目 id）。按工程标识分槽，互不覆盖；槽数与总字节有上限，
// 超出按「最新优先」淘汰。
//
// 恢复要能再取到原始资源：新建工程（资源全在快照里）、壁纸库条目（按 itemId 重开）、
// 虚拟工程（按 id 重开目录）、本地文件夹（刷新后句柄失效，快照是唯一副本）。

import { rebuildTree, type EditorDoc } from "./doc";
import type { AddedFile } from "./assets";
import { slugName } from "./save";
import { vdirBackend, type VdirBackend } from "./vdir";

export type DraftOrigin =
  | { kind: "new" }
  | { kind: "library"; itemId: string }
  /** 内置浏览器虚拟工程：按 id 重开目录，快照只带未保存的编辑 */
  | { kind: "virtual"; id: string }
  /** 本地文件夹：刷新后 File 句柄失效，快照是唯一副本 */
  | { kind: "local"; name: string };

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

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** 库里读出来的东西不可信（旧版本 / 手改 / 截断）：形状不对一律当没有 */
export function parseDraft(raw: unknown): Draft | null {
  if (!isObj(raw) || raw.v !== 1) return null;
  if (typeof raw.savedAt !== "number" || typeof raw.title !== "string" || typeof raw.entry !== "string") return null;
  if (!isObj(raw.scene) || !(raw.project === null || isObj(raw.project))) return null;
  const o = raw.origin;
  if (!isObj(o)) return null;
  if (o.kind === "new") {
    // 无附加字段
  } else if (o.kind === "library") {
    if (!nonEmpty(o.itemId)) return null;
  } else if (o.kind === "virtual") {
    if (!nonEmpty(o.id)) return null;
  } else if (o.kind === "local") {
    if (!nonEmpty(o.name)) return null;
  } else return null;
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

// ---------- 序列化：落盘的快照必须是能 JSON 化的（文件字节走 base64） ----------

type DraftWire = Omit<Draft, "files"> & { files: { name: string; group?: string | string[]; data: string }[] };

const B64_CHUNK = 0x8000;

const bytesToB64 = (bytes: Uint8Array): string => {
  let bin = "";
  for (let i = 0; i < bytes.length; i += B64_CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + B64_CHUNK));
  return btoa(bin);
};

const b64ToBytes = (text: string): Uint8Array => {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

/** 快照 → 存进存储介质的文本（文件字节 base64；结构化克隆后仍是同口径） */
export function encodeDraft(d: Draft): string {
  const wire: DraftWire = {
    ...d,
    files: d.files.map((f) => (f.group === undefined ? { name: f.name, data: bytesToB64(f.data) } : { name: f.name, group: f.group, data: bytesToB64(f.data) })),
  };
  return JSON.stringify(wire);
}

/** 介质文本 → 快照。坏数据（截断 / 手改 / base64 非法 / 形状不对）一律返回 null，不抛 */
export function decodeDraft(text: string): Draft | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(raw) || !Array.isArray(raw.files)) return null;
  const files: unknown[] = [];
  for (const f of raw.files) {
    if (!isObj(f) || typeof f.data !== "string") return null;
    let data: Uint8Array;
    try {
      data = b64ToBytes(f.data);
    } catch {
      return null;
    }
    files.push({ ...f, data });
  }
  return parseDraft({ ...raw, files });
}

// ---------- 槽位：按工程标识分槽，互不覆盖 ----------

/** 草稿在 vdir 存储里的保留 id：不会等于任何工程 id（工程 id 见 newVirtualId / 库条目 id） */
export const DRAFT_ID = "__draft__";
export const DRAFT_SLOT_VIRTUAL = "vdir:";
export const DRAFT_SLOT_LIBRARY = "library:";
export const DRAFT_SLOT_LOCAL = "local:";
/** 没绑任何来源的会话内文档（新建但还没选文件夹） */
export const DRAFT_SLOT_SESSION = "session";

export const DRAFT_MAX_SLOTS = 8;
export const DRAFT_MAX_BYTES = 32 * 1024 * 1024;
/** 快照写入的最小间隔：编辑防抖（400ms）之外的额外节流，避免长按拖拽时反复序列化整份文档 */
export const DRAFT_THROTTLE_MS = 1500;

export type DraftSource = {
  vdirId?: string | null;
  libraryItemId?: string | null;
  localName?: string | null;
  /**
   * 既没有工程目录也没有库条目时（新建 / 会话文档）的**文档标识**：调用方给每个文档一个，
   * 槽名会带上它。没有它的话两个未命名文档共用常量槽 `session`：后一个的自动保存会覆盖前一个
   * 的快照，其中一个还会在另存为成功时被当成「自己写过的槽」清掉（审计 H1）。
   */
  sessionKey?: string | null;
};

/** 工程标识 → 草稿槽名（稳定的字符串，刷新后仍是同一个槽） */
export function draftSlotFor(src: DraftSource): string {
  if (src.vdirId) return `${DRAFT_SLOT_VIRTUAL}${src.vdirId}`;
  if (src.libraryItemId) return `${DRAFT_SLOT_LIBRARY}${src.libraryItemId}`;
  if (src.localName) return `${DRAFT_SLOT_LOCAL}${slugName(src.localName)}`;
  const key = src.sessionKey ? slugName(src.sessionKey) : "";
  return key ? `${DRAFT_SLOT_SESSION}:${key}` : DRAFT_SLOT_SESSION;
}

/** 节流：距上次快照不足 throttleMs 就不写；非有限时间戳一律不写 */
export function snapshotDue(lastAt: number, now: number, throttleMs = DRAFT_THROTTLE_MS): boolean {
  if (!Number.isFinite(now)) return false;
  if (!Number.isFinite(lastAt)) return true;
  return now - lastAt >= throttleMs;
}

// ---------- 自动保存目标（计划 §2 C6） ----------

export type AutosaveTarget = "dir" | "draft" | "none";

/**
 * 自动保存放宽后的目标选择（纯函数，页面只做分流）：
 * 有可写工程文件夹就写文件夹；没有（壁纸库来源、文件夹不可写、还没另存为）就写草稿槽；
 * 连草稿槽都用不上（文档压根没内容可保存 / 视频网页文档的快照装不下原始文件）才不写 ——
 * 此时页面必须明确提示，不能静默。
 */
export function autosaveTargetFor(state: {
  savable: boolean;
  hasDir: boolean;
  draftable: boolean;
  slot: string | null;
}): AutosaveTarget {
  if (!state.savable) return "none";
  if (state.hasDir) return "dir";
  return state.draftable && state.slot ? "draft" : "none";
}

// ---------- 存储：共用 vdir 的 VdirBackend ----------

export type DraftSlotInfo = { slot: string; savedAt: number; bytes: number };

export type DraftStore = {
  /** 所有槽（按 savedAt 降序，越新越前） */
  list(): Promise<DraftSlotInfo[]>;
  load(slot: string): Promise<Draft | null>;
  save(d: Draft, slot: string): Promise<void>;
  clear(slot: string): Promise<void>;
};

const byNewest = (a: DraftSlotInfo, b: DraftSlotInfo): number => b.savedAt - a.savedAt || (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0);

export function vdirDraftStore(be: VdirBackend = vdirBackend(), maxSlots = DRAFT_MAX_SLOTS, maxBytes = DRAFT_MAX_BYTES): DraftStore {
  const info = async (): Promise<DraftSlotInfo[]> => {
    const out: DraftSlotInfo[] = [];
    for (const slot of await be.keys(DRAFT_ID)) {
      const blob = await be.read(DRAFT_ID, slot);
      if (!blob) continue;
      let savedAt = 0;
      try {
        savedAt = decodeDraft(await blob.text())?.savedAt ?? 0;
      } catch {
        savedAt = 0;
      }
      out.push({ slot, savedAt, bytes: blob.size });
    }
    return out.sort(byNewest);
  };
  /** 最新一条永远保留（否则刚存就被自己淘汰），其余按槽数 / 总字节上限从旧到新淘汰 */
  const evict = async (infos: DraftSlotInfo[]): Promise<void> => {
    let kept = 0;
    let bytes = 0;
    for (const i of infos) {
      if (kept > 0 && (kept >= maxSlots || bytes + i.bytes > maxBytes)) {
        await be.remove(DRAFT_ID, i.slot);
        continue;
      }
      kept += 1;
      bytes += i.bytes;
    }
  };
  return {
    list: info,
    async load(slot) {
      if (!slot) return null;
      try {
        const blob = await be.read(DRAFT_ID, slot);
        return blob ? decodeDraft(await blob.text()) : null;
      } catch {
        return null;
      }
    },
    async save(d, slot) {
      if (!slot) return;
      await be.write(DRAFT_ID, slot, new Blob([encodeDraft(d)], { type: "application/json" }));
      await evict(await info());
    },
    async clear(slot) {
      if (!slot) return;
      await be.remove(DRAFT_ID, slot);
    },
  };
}
