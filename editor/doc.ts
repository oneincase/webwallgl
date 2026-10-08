// 编辑器文档模型（EDITOR-PLAN §3A.3）：scene.json 是唯一真相，引擎运行态由它派生。
// P2 起热改（W2-lite）同时写回这里，保存链路（P3）只序列化文档。

import type { EditorLayerProps } from "../renderer/src/api/editor";
import { matchLayerKind } from "./layer-kinds";

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
  | "other"
  // 插件登记的图层类型（layer-kinds.ts）
  | (string & {});

export type LayerNode = {
  /** scene.json 里的 id；缺失时用数组下标兜底（与 scene/parse.js 同口径） */
  id: number | string;
  name: string;
  kind: LayerKind;
  /**
   * 模型形态：mesh = 对象挂 `model: "*.mdl"`（kind 为 model）；puppet = 图片对象引用的 model json 带 `puppet`
   * （kind 仍为 image —— puppet 在 WE 里就是图片对象，效果 / 颜色绑定等图片能力照旧可用）
   */
  modelForm?: "puppet" | "mesh";
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
  /** 视频壁纸工程（type = video）的视频本体；path = project.json 的 file */
  video?: { path: string; bytes: Uint8Array };
  /** 带 `puppet` 的 model json 路径 → .mdl 路径（打开后由 model.ts 的 scanPuppets 异步填入） */
  puppets?: ReadonlyMap<string, string>;
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
  const ext = matchLayerKind(o);
  if (ext) return ext;
  if (typeof o.particle === "string") return "particle";
  if (o.text !== undefined && o.text !== null) return "text";
  if (typeof o.model === "string") return "model";
  if (typeof o.image === "string") return "image";
  if (Array.isArray(o.sound) && o.sound.length) return "sound";
  if (typeof o.light === "string" && o.light) return "light";
  if (typeof o.camera === "string") return "camera";
  return "other";
}

export function modelFormOf(o: SceneObject, puppets?: ReadonlyMap<string, string>): "puppet" | "mesh" | undefined {
  if (typeof o.model === "string") return "mesh";
  if (typeof o.image === "string" && puppets?.has(o.image)) return "puppet";
  return undefined;
}

export function buildLayerTree(
  scene: Record<string, unknown> | null,
  puppets?: ReadonlyMap<string, string>,
): { roots: LayerNode[]; count: number } {
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
      modelForm: modelFormOf(o, puppets),
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
  const { roots, count } = buildLayerTree(doc.scene, doc.puppets);
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

// ---------- 父子关系：拖拽改父级 / 成组（世界变换不变）、锁定 ----------

type V3 = [number, number, number];
export type Xform = { origin: V3; scale: V3; angles: V3 };

const vec3 = (v: unknown, dflt: V3): V3 => {
  const raw = unwrap(v);
  const a = typeof raw === "string" ? raw.trim().split(/\s+/).map(Number) : Array.isArray(raw) ? raw.map(Number) : [];
  return dflt.map((d, i) => (Number.isFinite(a[i]) ? a[i] : d)) as V3;
};

export function localXform(o: SceneObject): Xform {
  return { origin: vec3(o.origin, [0, 0, 0]), scale: vec3(o.scale, [1, 1, 1]), angles: vec3(o.angles, [0, 0, 0]) };
}

/** 与引擎 parse.js composeChildTransform（父 scale 传播）同式 */
export function composeXform(p: Xform, c: Xform): Xform {
  const cos = Math.cos(p.angles[2]);
  const sin = Math.sin(p.angles[2]);
  const ox = c.origin[0] * p.scale[0];
  const oy = c.origin[1] * p.scale[1];
  return {
    origin: [p.origin[0] + ox * cos - oy * sin, p.origin[1] + ox * sin + oy * cos, p.origin[2] + c.origin[2]],
    scale: [p.scale[0] * c.scale[0], p.scale[1] * c.scale[1], p.scale[2] * c.scale[2]],
    angles: [c.angles[0], c.angles[1], p.angles[2] + c.angles[2]],
  };
}

/** composeXform 的逆：已知父世界与子世界求子局部；父 scale 有 0 分量时无解 */
export function relativeXform(p: Xform, w: Xform): Xform | null {
  if (p.scale.some((s) => s === 0)) return null;
  const cos = Math.cos(-p.angles[2]);
  const sin = Math.sin(-p.angles[2]);
  const dx = w.origin[0] - p.origin[0];
  const dy = w.origin[1] - p.origin[1];
  return {
    origin: [(dx * cos - dy * sin) / p.scale[0], (dx * sin + dy * cos) / p.scale[1], w.origin[2] - p.origin[2]],
    scale: [w.scale[0] / p.scale[0], w.scale[1] / p.scale[1], w.scale[2] / p.scale[2]],
    angles: [w.angles[0], w.angles[1], w.angles[2] - p.angles[2]],
  };
}

const IDENTITY: Xform = { origin: [0, 0, 0], scale: [1, 1, 1], angles: [0, 0, 0] };

/** 父级指向不存在的对象时 buildLayerTree 把它当根，这里同口径 */
function parentOf(objs: SceneObject[], o: SceneObject): SceneObject | null {
  if (o.parent === undefined || o.parent === null) return null;
  return objs.find((x) => sameId(x.id, o.parent)) ?? null;
}

/** 静态值（作者快照）合成的世界变换；动画 / 脚本是运行期叠加，不计 */
export function worldXform(objs: SceneObject[], o: SceneObject | null): Xform {
  const chain: SceneObject[] = [];
  for (let cur = o; cur && chain.length < 64 && !chain.includes(cur); cur = parentOf(objs, cur)) chain.unshift(cur);
  return chain.reduce<Xform>((w, c) => composeXform(w, localXform(c)), IDENTITY);
}

const TRANSFORM_FIELDS = ["origin", "scale", "angles"] as const;

const hasAnimation = (v: unknown) => !!v && typeof v === "object" && !Array.isArray(v) && "animation" in (v as object);

export type PlaceWhere = "before" | "after" | "inside";

export type PlaceResult = "ok" | "noop" | "cycle" | "animated" | "degenerate" | "missing";

/**
 * 把 id 的整棵子树挪到 target 之前 / 之后（同级）或里面（成为最后一个子层）。
 * 对象数组顺序即绘制顺序，「之前」= 数组里更靠前。父级变了时改写局部变换使
 * 世界变换不变（子层跟着父走，不用动）；位置 / 缩放 / 旋转有动画时关键帧是旧父
 * 空间的值，换父会整段错位 —— 拒绝。校验全部在改动之前，失败时文档原样。
 */
export function placeLayer(doc: EditorDoc, id: number | string, targetId: number | string, where: PlaceWhere): PlaceResult {
  const objs = objectsOf(doc);
  if (!objs) return "missing";
  const self = objs.find((o) => sameId(o.id, id));
  const target = objs.find((o) => sameId(o.id, targetId));
  if (!self || !target) return "missing";
  const block = subtreeIndices(objs, id);
  if (block.some((i) => objs[i] === target)) return "cycle";
  const newParent = where === "inside" ? target : parentOf(objs, target);
  const oldParent = parentOf(objs, self);
  let local: Xform | null = null;
  if (newParent !== oldParent) {
    if (TRANSFORM_FIELDS.some((f) => hasAnimation(self[f]))) return "animated";
    local = relativeXform(worldXform(objs, newParent), worldXform(objs, self));
    if (!local) return "degenerate";
  }
  const before = objs.slice();
  const blockObjs = block.map((i) => objs[i]);
  for (const i of [...block].reverse()) objs.splice(i, 1);
  const tIdx = subtreeIndices(objs, target.id as number | string);
  const insertAt = where === "before" ? tIdx[0] : tIdx[tIdx.length - 1] + 1;
  objs.splice(insertAt, 0, ...blockObjs);
  if (!local && objs.every((o, i) => o === before[i])) return "noop";
  if (local) {
    writeObjProps(self, local);
    if (newParent) self.parent = newParent.id;
    else delete self.parent;
  }
  rebuildTree(doc);
  return "ok";
}

/** 新建空组（单位变换）插在 id 原位，把 id 的子树放进去：世界变换天然不变。返回组 id */
export function groupLayer(doc: EditorDoc, id: number | string, name: string): number | null {
  const objs = objectsOf(doc);
  if (!objs) return null;
  const self = objs.find((o) => sameId(o.id, id));
  if (!self) return null;
  const block = subtreeIndices(objs, id);
  const gid = nextObjectId(objs);
  const group: SceneObject = { id: gid, name, origin: "0 0 0", scale: "1 1 1", angles: "0 0 0", visible: true };
  if (self.parent !== undefined && self.parent !== null && parentOf(objs, self)) group.parent = self.parent;
  objs.splice(block[0], 0, group);
  self.parent = gid;
  rebuildTree(doc);
  return gid;
}

/** 选中集合里去掉「祖先也被选中」的层（整棵子树跟着祖先走），按对象数组顺序 */
export function topLevelIds(doc: EditorDoc, ids: ReadonlyArray<number | string>): Array<number | string> {
  const objs = objectsOf(doc);
  if (!objs) return [];
  const want = new Set(ids.map(String));
  const out: Array<number | string> = [];
  for (const o of objs) {
    if (o.id === undefined || !want.has(String(o.id))) continue;
    let covered = false;
    for (let p = parentOf(objs, o), n = 0; p && n < 64; p = parentOf(objs, p), n++) {
      if (want.has(String(p.id))) {
        covered = true;
        break;
      }
    }
    if (!covered) out.push(o.id as number | string);
  }
  return out;
}

/**
 * 多层成组：组建在最靠前那层的位置与父级下，其余层按原绘制顺序放进组（世界变换不变）。
 * 在副本上做完再整体换入 —— 任何一层被拒（动画 / 零缩放）文档原样。
 */
export function groupLayers(
  doc: EditorDoc,
  ids: ReadonlyArray<number | string>,
  name: string,
): { ok: true; id: number } | { ok: false; reason: PlaceResult; at?: number | string } {
  const objs = objectsOf(doc);
  const top = topLevelIds(doc, ids);
  if (!objs || !top.length) return { ok: false, reason: "missing" };
  const tmp: EditorDoc = { ...doc, scene: { ...doc.scene, objects: structuredClone(objs) } };
  const gid = groupLayer(tmp, top[0], name);
  if (gid === null) return { ok: false, reason: "missing" };
  for (const id of top.slice(1)) {
    const r = placeLayer(tmp, id, gid, "inside");
    if (r !== "ok" && r !== "noop") return { ok: false, reason: r, at: id };
  }
  doc.scene!.objects = tmp.scene!.objects;
  rebuildTree(doc);
  return { ok: true, id: gid };
}

/** WE 原生字段 locktransforms：锁定的层不能在视口里拖动 / 改变换 */
export function isLockedObj(o: SceneObject): boolean {
  const v = unwrap(o.locktransforms);
  return v === true || v === 1 || v === "true" || v === "1";
}

export function setLocked(o: SceneObject, on: boolean): void {
  o.locktransforms = on;
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
