// 编辑记账（W2-lite）：属性热改与结构编辑共用一条撤销栈。
// 属性命令只记涉及的字段；结构命令以整份对象数组快照记账，撤销即换回快照再重挂。

import type { EditorLayerProps } from "../renderer/src/api/editor";
import { rebuildTree, type EditorDoc } from "./doc";

export type Patch = Partial<EditorLayerProps>;
export type LayerId = number | string;

export type PropsCmd = { id: LayerId; name: string; before: Patch; after: Patch };
export type StructCmd = {
  kind: "struct";
  label: string;
  before: string;
  after: string;
  selBefore: LayerId | null;
  selAfter: LayerId | null;
  /** project.json `general.properties` 前后快照（只在属性声明 / 值变了时才有） */
  propsBefore?: string;
  propsAfter?: string;
};
/** 多选拖动 / 对齐：几层的属性改动作为一步撤销 */
export type BatchCmd = { kind: "batch"; label: string; cmds: PropsCmd[] };
/** 视频壁纸工程换视频本体（裁剪 / 替换）：前后两份字节整体记账 */
export type VideoClip = { path: string; bytes: Uint8Array };
export type VideoCmd = { kind: "video"; label: string; before: VideoClip; after: VideoClip };
/** 文档级改名（工程名）：doc.title 与 project.json 的 title 一起记账 —— 结构命令的快照只覆盖 objects，装不下它 */
export type TitleSnap = { title: string; projectTitle: string | null };
export type TitleCmd = { kind: "title"; label: string; before: TitleSnap; after: TitleSnap };
/** 不在文档里的资源文件（粒子 JSON）整体换字节：与视频本体同款理由 —— 结构命令的快照只覆盖 objects */
export type FileSnap = { path: string; bytes: Uint8Array };
export type FileCmd = { kind: "file"; label: string; before: FileSnap; after: FileSnap };
export type EditCmd = PropsCmd | StructCmd | BatchCmd | VideoCmd | TitleCmd | FileCmd;

export const isStruct = (c: EditCmd): c is StructCmd => "kind" in c && c.kind === "struct";
export const isBatch = (c: EditCmd): c is BatchCmd => "kind" in c && c.kind === "batch";
export const isVideoCmd = (c: EditCmd): c is VideoCmd => "kind" in c && c.kind === "video";
export const isTitleCmd = (c: EditCmd): c is TitleCmd => "kind" in c && c.kind === "title";
export const isFileCmd = (c: EditCmd): c is FileCmd => "kind" in c && c.kind === "file";

const sameBytes = (a: Uint8Array, b: Uint8Array) => {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

/** 粒子文件的一次编辑；换的不是同一个文件或字节没变时返回 null（调用方不入栈） */
export function fileCommand(label: string, before: FileSnap, after: FileSnap): FileCmd | null {
  if (before.path === after.path && sameBytes(before.bytes, after.bytes)) return null;
  return { kind: "file", label, before, after };
}

/** 去掉前后一致的条目；剩一条时退回普通属性命令，一条不剩返回 null */
export function batchCommand(label: string, cmds: readonly PropsCmd[]): EditCmd | null {
  const live = cmds.filter((c) => !isNoopEdit(c));
  if (!live.length) return null;
  return live.length === 1 ? live[0] : { kind: "batch", label, cmds: live };
}

export const HISTORY_LIMIT = 200;

/** 只取 keys 里的字段（撤销记录的 before 与 after 键集一致） */
export function pickProps(props: EditorLayerProps, keys: ReadonlyArray<keyof EditorLayerProps>): Patch {
  const out: Patch = {};
  for (const k of keys) (out as Record<string, unknown>)[k] = structuredClone(props[k]);
  return out;
}

/** 前后一致的属性命令不入栈（点一下没拖、改回原值） */
export const isNoopEdit = (cmd: PropsCmd) => JSON.stringify(cmd.before) === JSON.stringify(cmd.after);

export class EditHistory {
  readonly undoStack: EditCmd[] = [];
  readonly redoStack: EditCmd[] = [];

  constructor(readonly limit = HISTORY_LIMIT) {}

  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }

  /** 新编辑入栈：超出上限丢最早的，重做栈作废 */
  push(cmd: EditCmd) {
    this.undoStack.push(cmd);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  /** 取出要撤销 / 重做的命令并挪到另一侧栈；调用方按命令方向落地 */
  take(dir: "undo" | "redo"): EditCmd | undefined {
    const from = dir === "undo" ? this.undoStack : this.redoStack;
    const to = dir === "undo" ? this.redoStack : this.undoStack;
    const cmd = from.pop();
    if (cmd) to.push(cmd);
    return cmd;
  }

  clear() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }
}

/** 本文档累计的热改（按层合并，后写覆盖先写）：重挂后原样重放，保证「重挂 ≡ 热改」 */
export function mergeLiveEdit(live: Map<string, Patch>, id: LayerId, patch: Patch) {
  const key = String(id);
  live.set(key, { ...(live.get(key) ?? {}), ...structuredClone(patch) });
}

/** 用户属性表的快照（没有时为 "null"） */
export function propsSnapshot(doc: EditorDoc): string {
  const general = doc.project?.general as Record<string, unknown> | undefined;
  return JSON.stringify(general?.properties ?? null);
}

function restoreProps(doc: EditorDoc, json: string) {
  const props = JSON.parse(json) as Record<string, unknown> | null;
  if (!doc.project) {
    if (!props) return;
    doc.project = {};
  }
  const general = (doc.project.general ??= {}) as Record<string, unknown>;
  if (props) general.properties = props;
  else delete general.properties;
}

/** 文档对象数组（及可选的属性表）整体换成快照（结构编辑落地 / 撤销 / 重做共用） */
export function restoreObjects(doc: EditorDoc, json: string, props?: string) {
  if (!doc.scene) return;
  doc.scene.objects = JSON.parse(json);
  if (props !== undefined) restoreProps(doc, props);
  rebuildTree(doc);
}

/**
 * 一次结构编辑：快照 → mutate 改文档 → 产出命令。mutate 返回新的选中 id，
 * undefined = 没改成；对象数组前后一致也不算编辑。返回 null 时文档未变。
 */
export function structCommand(
  doc: EditorDoc,
  label: string,
  selBefore: LayerId | null,
  mutate: (d: EditorDoc) => LayerId | null | undefined,
): StructCmd | null {
  if (!doc.scene) return null;
  const before = JSON.stringify(doc.scene.objects ?? []);
  const propsBefore = propsSnapshot(doc);
  const sel = mutate(doc);
  if (sel === undefined) return null;
  const after = JSON.stringify(doc.scene.objects ?? []);
  const propsAfter = propsSnapshot(doc);
  if (after === before && propsAfter === propsBefore) return null;
  const cmd: StructCmd = { kind: "struct", label, before, after, selBefore, selAfter: sel };
  if (propsAfter !== propsBefore) Object.assign(cmd, { propsBefore, propsAfter });
  return cmd;
}
