// 编辑器文档模型（EDITOR-PLAN §3A.3）：scene.json 是唯一真相，引擎运行态由它派生。
// P2 起热改（W2-lite）同时写回这里，保存链路（P3）只序列化文档。

import type { EditorLayerProps } from "../renderer/src/api/editor";

export type SceneObject = Record<string, unknown>;

export type LayerKind =
  | "image"
  | "model"
  | "particle"
  | "text"
  | "sound"
  | "light"
  | "camera"
  | "group"
  | "other";

export type LayerNode = {
  /** scene.json 里的 id；缺失时用数组下标兜底（与 scene/parse.js 同口径） */
  id: number | string;
  name: string;
  kind: LayerKind;
  visible: boolean;
  /** 指向 scene.json 原对象（只读使用） */
  obj: SceneObject;
  children: LayerNode[];
};

export type EditorDoc = {
  /** 显示名（库标题 / 文件名 / 目录名） */
  title: string;
  project: Record<string, unknown> | null;
  /** project.type 小写；缺省按 scene */
  type: string;
  scene: Record<string, unknown> | null;
  form: "pkg" | "loose" | null;
  roots: LayerNode[];
  objectCount: number;
};

/** `{user, value}` 包装（受用户属性驱动的字段）取作者快照值 */
export function unwrap(v: unknown): unknown {
  if (v && typeof v === "object" && !Array.isArray(v) && "value" in (v as object)) {
    return (v as { value: unknown }).value;
  }
  return v;
}

function parseVisible(v: unknown): boolean {
  const raw = unwrap(v);
  if (raw === undefined || raw === null) return true;
  if (typeof raw === "string") return raw !== "0" && raw.toLowerCase() !== "false";
  return !!raw;
}

export function kindOf(o: SceneObject): LayerKind {
  if (typeof o.particle === "string") return "particle";
  if (o.text !== undefined && o.text !== null) return "text";
  if (typeof o.model === "string") return "model";
  if (typeof o.image === "string") return "image";
  if (Array.isArray(o.sound) && o.sound.length) return "sound";
  if (typeof o.light === "string" && o.light) return "light";
  if (typeof o.camera === "string") return "camera";
  return "other";
}

export function buildLayerTree(scene: Record<string, unknown> | null): { roots: LayerNode[]; count: number } {
  const objects = Array.isArray(scene?.objects) ? (scene!.objects as unknown[]) : [];
  const nodes: LayerNode[] = [];
  const byId = new Map<number | string, LayerNode>();
  objects.forEach((raw, i) => {
    if (!raw || typeof raw !== "object") return;
    const o = raw as SceneObject;
    const id = (o.id as number | string | undefined) ?? i;
    const node: LayerNode = {
      id,
      name: typeof o.name === "string" ? o.name : "",
      kind: kindOf(o),
      visible: parseVisible(o.visible),
      obj: o,
      children: [],
    };
    nodes.push(node);
    byId.set(id, node);
  });
  const roots: LayerNode[] = [];
  for (const n of nodes) {
    const parentId = n.obj.parent as number | string | undefined | null;
    const parent = parentId !== undefined && parentId !== null ? byId.get(parentId) : undefined;
    if (parent && parent !== n) parent.children.push(n);
    else roots.push(n);
  }
  for (const n of nodes) if (n.kind === "other" && n.children.length) n.kind = "group";
  return { roots, count: nodes.length };
}

export function makeDoc(
  title: string,
  project: Record<string, unknown> | null,
  scene: Record<string, unknown> | null,
  form: EditorDoc["form"],
): EditorDoc {
  const type = typeof project?.type === "string" ? project.type.toLowerCase() : "scene";
  const { roots, count } = buildLayerTree(scene);
  return { title, project, type, scene, form, roots, objectCount: count };
}

const num = (v: number) => {
  const r = Math.round(v * 1e5) / 1e5;
  return (Object.is(r, -0) ? 0 : r).toFixed(5).replace(/\.?0+$/, "") || "0";
};
const vecStr = (v: readonly number[]) => v.map(num).join(" ");

/**
 * 把热改写回 scene.json 对象。字段若是 `{user, value}` / `{script, value}` 包装，
 * 只改 `.value`（作者快照），绑定本身保留。
 */
export function writeObjProps(obj: SceneObject, patch: Partial<EditorLayerProps>): void {
  const put = (key: string, value: unknown) => {
    const cur = obj[key];
    if (cur && typeof cur === "object" && !Array.isArray(cur) && "value" in (cur as object)) {
      (cur as { value: unknown }).value = value;
    } else {
      obj[key] = value;
    }
  };
  if (patch.origin) put("origin", vecStr(patch.origin));
  if (patch.scale) put("scale", vecStr(patch.scale));
  if (patch.angles) put("angles", vecStr(patch.angles));
  if (patch.visible !== undefined) put("visible", patch.visible);
  if (patch.alpha !== undefined) put("alpha", Math.round(patch.alpha * 1e5) / 1e5);
  if (patch.color) put("color", vecStr(patch.color));
}

// ---------- 结构编辑（增删 / 复制 / 重排）：只改文档，引擎侧整场景重挂 ----------

const sameId = (a: unknown, b: unknown) => a !== undefined && a !== null && String(a) === String(b);

function objectsOf(doc: EditorDoc): SceneObject[] | null {
  const objs = doc.scene?.objects;
  return Array.isArray(objs) ? (objs as SceneObject[]) : null;
}

/** 文档对象数组变了之后重建图层树（节点 obj 引用随之换新） */
export function rebuildTree(doc: EditorDoc): void {
  const { roots, count } = buildLayerTree(doc.scene);
  doc.roots = roots;
  doc.objectCount = count;
}

/** 对象数组下标集合：id 及其全部后代。缺 id 的对象（下标兜底）不参与结构编辑 */
function subtreeIndices(objs: SceneObject[], id: number | string): number[] {
  const ids = new Set<string>([String(id)]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const o of objs) {
      if (o.id === undefined || ids.has(String(o.id))) continue;
      if (o.parent !== undefined && o.parent !== null && ids.has(String(o.parent))) {
        ids.add(String(o.id));
        grew = true;
      }
    }
  }
  const out: number[] = [];
  objs.forEach((o, i) => {
    if (o.id !== undefined && ids.has(String(o.id))) out.push(i);
  });
  return out;
}

export function removeLayer(doc: EditorDoc, id: number | string): boolean {
  const objs = objectsOf(doc);
  if (!objs) return false;
  const idx = subtreeIndices(objs, id);
  if (!idx.length) return false;
  for (const i of idx.reverse()) objs.splice(i, 1);
  rebuildTree(doc);
  return true;
}

/** 新对象可用的 id：现有最大数值 id + 1（字符串 / 缺失 id 不参与） */
export function nextObjectId(objs: readonly SceneObject[]): number {
  return objs.reduce((m, o) => Math.max(m, Number.isFinite(Number(o.id)) ? Number(o.id) : 0), 0) + 1;
}

/** 连同子树原位复制（插在原子树之后），返回副本根的 id */
export function duplicateLayer(doc: EditorDoc, id: number | string, suffix: string): number | null {
  const objs = objectsOf(doc);
  if (!objs) return null;
  const idx = subtreeIndices(objs, id);
  if (!idx.length) return null;
  let next = nextObjectId(objs);
  const remap = new Map<string, number>();
  for (const i of idx) remap.set(String(objs[i].id), next++);
  const clones = idx.map((i) => {
    const c = structuredClone(objs[i]);
    c.id = remap.get(String(objs[i].id))!;
    if (c.parent !== undefined && c.parent !== null && remap.has(String(c.parent))) c.parent = remap.get(String(c.parent))!;
    if (sameId(objs[i].id, id) && typeof c.name === "string") c.name = `${c.name}${suffix}`;
    return c;
  });
  objs.splice(idx[idx.length - 1] + 1, 0, ...clones);
  rebuildTree(doc);
  return remap.get(String(id)) ?? null;
}

/**
 * 在同级兄弟间前移（-1）/ 后移（+1）一位。整棵子树作为一块搬动，落在相邻兄弟
 * 子树块之前 / 之后 —— 对象数组顺序即绘制顺序，块内相对次序保持不变。
 */
export function moveLayer(doc: EditorDoc, id: number | string, dir: -1 | 1): boolean {
  const objs = objectsOf(doc);
  if (!objs) return false;
  const self = objs.find((o) => sameId(o.id, id));
  if (!self) return false;
  // 父级指向不存在的对象时 buildLayerTree 把它当根，这里同口径
  const parentKey = (o: SceneObject) => {
    const p = o.parent === undefined || o.parent === null ? "" : String(o.parent);
    return p && objs.some((x) => sameId(x.id, p)) ? p : "";
  };
  const key = parentKey(self);
  const siblings = objs.filter((o) => o.id !== undefined && parentKey(o) === key);
  const at = siblings.indexOf(self);
  const other = siblings[at + dir];
  if (!other) return false;
  const block = subtreeIndices(objs, id);
  const blockObjs = block.map((i) => objs[i]);
  for (const i of [...block].reverse()) objs.splice(i, 1);
  const otherIdx = subtreeIndices(objs, other.id as number | string);
  const insertAt = dir < 0 ? otherIdx[0] : otherIdx[otherIdx.length - 1] + 1;
  objs.splice(insertAt, 0, ...blockObjs);
  rebuildTree(doc);
  return true;
}

/** 根到目标节点的路径（含目标）。引擎活层 id 是数值，文档 id 可能是字符串，按字符串比 */
export function findPath(nodes: LayerNode[], id: number | string): LayerNode[] | null {
  for (const n of nodes) {
    if (String(n.id) === String(id)) return [n];
    const sub = findPath(n.children, id);
    if (sub) return [n, ...sub];
  }
  return null;
}

export function findNode(nodes: LayerNode[], id: number | string): LayerNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    const hit = findNode(n.children, id);
    if (hit) return hit;
  }
  return null;
}

/** scene.json 场景逻辑分辨率（general.orthogonalprojection） */
export function sceneResolution(scene: Record<string, unknown> | null): { w: number; h: number } | null {
  const general = scene?.general as Record<string, unknown> | undefined;
  const ortho = general?.orthogonalprojection as Record<string, unknown> | undefined;
  const w = Number(ortho?.width);
  const h = Number(ortho?.height);
  return w > 0 && h > 0 ? { w, h } : null;
}
