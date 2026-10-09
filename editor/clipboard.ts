// 图层剪贴板（A10）：把选中的整棵子树序列化，粘贴时重新分配 id 并保持层级 / 父子关系。
// 纯数据层，不碰 DOM；跨文档靠内存载荷 + localStorage 兜底（刷新 / 换标签页后仍能粘贴）。

import { rebuildTree, type EditorDoc, type SceneObject } from "./doc";

/** 跨文档传递的剪贴板格式；版本号变了就整条丢弃（宁可不粘贴，也不写坏文档） */
export const LAYER_CLIP_FORMAT = "wewallgl.layer-clip";
export const LAYER_CLIP_VERSION = 1;
/** localStorage 兜底键 */
export const LAYER_CLIP_KEY = "we-editor-layer-clip";

export type LayerClipEntry = { id: string; parent: string | null; obj: SceneObject };
export type LayerClip = { format: string; version: number; objs: LayerClipEntry[] };

const key = (id: number | string) => String(id);
/** SceneObject 是 Record<string, unknown>，属性访问拿不到窄化，这里显式收窄 */
const idOf = (o: SceneObject): number | string | null => {
  const v = o.id;
  return typeof v === "number" || typeof v === "string" ? v : null;
};
const parentOf = (o: SceneObject): number | string | null => {
  const v = o.parent;
  return typeof v === "number" || typeof v === "string" ? v : null;
};

/**
 * 收集这些层的整棵子树（含被选中祖先覆盖的后代，不重复）。
 * 父级不在集合里的层，entry.parent 记 null（粘贴后落在顶层）。
 */
export function collectSubtree(objs: readonly SceneObject[], ids: ReadonlyArray<number | string>): LayerClipEntry[] {
  const wanted = new Set(ids.map(key));
  for (let grew = true; grew; ) {
    grew = false;
    for (const o of objs) {
      const oid = idOf(o);
      const op = parentOf(o);
      if (oid === null || op === null) continue;
      if (wanted.has(key(oid)) || !wanted.has(key(op))) continue;
      wanted.add(key(oid));
      grew = true;
    }
  }
  return objs
    .filter((o) => {
      const oid = idOf(o);
      return oid !== null && wanted.has(key(oid));
    })
    .map((o) => {
      const op = parentOf(o);
      const oid = idOf(o) as number | string;
      const parent = op === null ? null : key(op);
      return { id: key(oid), parent: parent !== null && wanted.has(parent) ? parent : null, obj: o };
    });
}

/** 生成剪贴板载荷；没有可复制对象时返回 null */
export function serializeLayerClip(objs: readonly SceneObject[], ids: ReadonlyArray<number | string>): LayerClip | null {
  const entries = collectSubtree(objs, ids);
  if (!entries.length) return null;
  return {
    format: LAYER_CLIP_FORMAT,
    version: LAYER_CLIP_VERSION,
    objs: entries.map((e) => ({ id: e.id, parent: e.parent, obj: structuredClone(e.obj) })),
  };
}

/** 解析剪贴板载荷；格式 / 版本 / 字段不对一律 null（localStorage 里的脏数据也走这里） */
export function parseLayerClip(raw: unknown): LayerClip | null {
  const v = typeof raw === "string" ? safeParse(raw) : raw;
  if (!v || typeof v !== "object") return null;
  const c = v as { format?: unknown; version?: unknown; objs?: unknown };
  if (c.format !== LAYER_CLIP_FORMAT || c.version !== LAYER_CLIP_VERSION || !Array.isArray(c.objs)) return null;
  const objs: LayerClipEntry[] = [];
  for (const e of c.objs) {
    if (!e || typeof e !== "object") return null;
    const { id, parent, obj } = e as { id?: unknown; parent?: unknown; obj?: unknown };
    if (typeof id !== "string" || !id) return null;
    if (parent !== null && typeof parent !== "string") return null;
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
    objs.push({ id, parent: parent as string | null, obj: obj as SceneObject });
  }
  return objs.length ? { format: LAYER_CLIP_FORMAT, version: LAYER_CLIP_VERSION, objs } : null;
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export function stringifyLayerClip(clip: LayerClip): string {
  return JSON.stringify(clip);
}

/**
 * 把载荷粘贴进文档：重新编号（从现有最大数值 id + 1 起）、按原顺序插到对象数组末尾，
 * 父级指向重编号后的对象或原有对象（父级已被删掉 → 落到顶层）。
 * 校验不通过时文档原样不动，返回空数组。
 */
export function pasteLayerClip(doc: EditorDoc, clip: LayerClip, offset: readonly [number, number] = [0, 0]): number[] {
  if (doc.type !== "scene") return [];
  const objs = doc.scene?.objects;
  if (!Array.isArray(objs)) return [];
  const list = objs as SceneObject[];
  const src = clip?.objs ?? [];
  if (!src.length) return [];
  const existing = new Set(list.map(idOf).filter((v): v is number | string => v !== null).map(key));
  const ids = new Set(src.map((e) => e.id));
  if (ids.size !== src.length) return [];
  // 校验全部在改动之前：载荷内 id 不重复、父级要么在载荷里、要么在目标文档里（缺父级宁可不粘贴）。
  // 注意「载荷 id 与目标文档同名」不是错误：id 是文档局部的，粘贴一律重新编号。
  for (const e of src) {
    if (e.parent !== null && !ids.has(e.parent) && !existing.has(e.parent)) {
      console.warn(`[clipboard] 粘贴目标缺少父级 ${e.parent}，已忽略`);
      return [];
    }
  }
  let next = list.reduce((m, o) => {
    const v = idOf(o);
    return v !== null && Number.isFinite(Number(v)) ? Math.max(m, Number(v)) : m;
  }, 0) + 1;
  const remap = new Map<string, number>();
  for (const e of src) remap.set(e.id, next++);
  const added: number[] = [];
  const clones: SceneObject[] = [];
  for (const e of src) {
    const c = structuredClone(e.obj);
    const nid = remap.get(e.id)!;
    c.id = nid;
    if (e.parent !== null) c.parent = remap.get(e.parent) ?? e.parent;
    else delete c.parent;
    if (offset[0] || offset[1]) shiftOrigin(c, offset);
    clones.push(c);
    added.push(nid);
  }
  list.push(...clones);
  rebuildTree(doc);
  return added;
}

/** 粘贴偏移：只动静态 origin（动画层关键帧在旧坐标上，静默错位不如不动） */
function shiftOrigin(o: SceneObject, offset: readonly [number, number]): void {
  const raw = o.origin;
  const v = raw && typeof raw === "object" && !Array.isArray(raw) && "value" in (raw as object) ? (raw as { value: unknown }).value : raw;
  if (!Array.isArray(v) || v.length < 2) return;
  const out = v.map((x) => Number(x) || 0);
  out[0] += offset[0];
  out[1] += offset[1];
  o.origin = out;
}
