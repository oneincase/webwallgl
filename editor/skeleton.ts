// P2 骨架（PUPPET-WARP-FULL-PLAN §5 P2）：点击打点建骨、多根骨、命名、父链。
//
// 坐标口径与 P0 的钉子（`editor/warp.ts` 的 `pinLocal`）**完全一致**：模型空间、y 向上、
// 原点 = 贴图中心、单位 = 贴图像素（1 单位 = 1 px）。`buildGeometry` 的顶点位置也在同一空间，
// 所以骨骼点可以直接和顶点位置比距离（权重涂抹 / 自动分配都靠这个）。
//
// 绑定姿势沿用 P0 已验证的约定：**局部矩阵只有平移、旋转为 0**（`translate(x-xp, y-yp, 0)`，
// 根骨 = `translate(x, y, 0)`）。引擎 `mdl-skin.js` 的 `bindTRS` 会从矩阵反解 TRS，
// 纯平移矩阵不会踩到欧拉角符号的坑。
//
// 硬约束：MDLS 的骨记录顺序就是引擎的骨号，而 `computeSkinMatrices` 只认 `parent < i`
// （父索引必须更小，否则那根骨被当根算）。所以本模块维护「父级永远在前面」的不变式：
// 任何可能破坏它的改动（删骨 / 改父级）都走 `topoSort` 重排，并把**新旧下标映射**交给
// 调用方去搬权重（`setMdlBoneIdx` 的骨号、`weights.ts` 的 skin）。

const q5 = (v: number) => Math.round(v * 1e5) / 1e5;

export const SKELETON_VERSION = 1;
export const MAX_BONES = 128;
export const BONE_NAME_MAX = 48;
/** 骨点名中半径（模型空间像素）：真机画布会缩放，命中判定交给调用方传换算后的容差 */
export const BONE_HIT_TOL = 12;
export const DEFAULT_BONE_NAME = "bone";

/** 一根骨：模型空间点 + 父级下标（-1 = 根）；骨号 = 数组下标 */
export type SkelBone = { name: string; parent: number; x: number; y: number };
export type SkeletonSpec = { bones: SkelBone[] };
/** 删骨 / 改父级 / 重排后的下标搬运表：`map[旧] = 新`（被删的骨映射到它的父级） */
export type SkelRemap = { skeleton: SkeletonSpec; map: number[] };
/** 写进 MDLS 的一条骨（`renderer/src/editor/mdl-edit.ts` 的 `setMdlSkeleton` 吃这个形状） */
export type SkelBoneSpec = { name: string; parent: number; matrix: Float32Array };

const asObj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isInt = (v: unknown): v is number => isNum(v) && Number.isInteger(v);
const clampName = (s: string): string => (s.length > BONE_NAME_MAX ? s.slice(0, BONE_NAME_MAX) : s);

export function defaultSkeleton(): SkeletonSpec {
  return { bones: [] };
}

export function cloneSkeleton(sk: SkeletonSpec): SkeletonSpec {
  return { bones: sk.bones.map((b) => ({ ...b })) };
}

export const boneCountOf = (sk: SkeletonSpec): number => sk.bones.length;

/** 不变式检查：每根骨的父级要么 -1，要么下标更小（引擎的硬要求） */
export function parentsOk(sk: SkeletonSpec): boolean {
  return sk.bones.every((b, i) => b.parent === -1 || (Number.isInteger(b.parent) && b.parent >= 0 && b.parent < i));
}

/**
 * 稳定拓扑排序：反复按原顺序挑「父级已落地」的骨 ⇒ 父级近的、下标小的先出。
 * 返回 `map[旧] = 新`；成环的剩余骨按 -1（根）收尾（坏数据不丢骨、只断链）。
 */
export function topoSort(bones: ReadonlyArray<SkelBone>): SkelRemap {
  const n = bones.length;
  const map = new Array<number>(n).fill(-1);
  const order: number[] = [];
  let remaining = bones.map((_, i) => i);
  while (remaining.length) {
    const next: number[] = [];
    let moved = false;
    for (const i of remaining) {
      const p = bones[i].parent;
      const ok = p === -1 || map[p] >= 0;
      if (ok) {
        map[i] = order.length;
        order.push(i);
        moved = true;
      } else next.push(i);
    }
    remaining = next;
    if (!moved) break;
  }
  for (const i of remaining) {
    // 成环 / 坏父级：降级成根骨（下标顺序保持稳定）
    map[i] = order.length;
    order.push(i);
  }
  const sorted: SkelBone[] = [];
  for (let newIdx = 0; newIdx < order.length; newIdx++) {
    const old = order[newIdx];
    const p = bones[old].parent;
    const parent = p === -1 || map[p] === undefined ? -1 : map[p];
    // 重排后父级必须仍然更小；万一拓扑排序给了更靠后的（坏数据），降级成根
    sorted.push({ ...bones[old], parent: parent < newIdx ? parent : -1 });
  }
  return { skeleton: { bones: sorted }, map };
}

/** 归一化：父链合法（不合法就拓扑重排）、坐标有限、命名非空且不超长、数量封顶 */
export function cleanSkeleton(sk: SkeletonSpec): SkeletonSpec {
  const base: SkelBone[] = [];
  for (const b of sk.bones.slice(0, MAX_BONES)) {
    if (!isNum(b.x) || !isNum(b.y)) continue;
    base.push({
      name: clampName(typeof b.name === "string" && b.name ? b.name : DEFAULT_BONE_NAME),
      parent: isInt(b.parent) ? b.parent : -1,
      x: q5(b.x),
      y: q5(b.y),
    });
  }
  const out = { bones: base };
  return parentsOk(out) ? out : topoSort(base).skeleton;
}

/** 解析工程 json 里的 `puppetWarp.skeleton`；空 / 坏数据返回 null（调用方回落默认骨架） */
export function parseSkeleton(raw: unknown): SkeletonSpec | null {
  const o = asObj(raw);
  if (!o) return null;
  const list = Array.isArray(o.bones) ? o.bones : null;
  if (!list) return null;
  const bones: SkelBone[] = [];
  for (const item of list) {
    const b = asObj(item);
    if (!b) continue;
    bones.push({
      name: typeof b.name === "string" && b.name ? clampName(b.name) : DEFAULT_BONE_NAME,
      parent: isInt(b.parent) ? b.parent : -1,
      x: isNum(b.x) ? b.x : 0,
      y: isNum(b.y) ? b.y : 0,
    });
  }
  if (!bones.length) return null;
  return cleanSkeleton({ bones });
}

/** 落盘形态（`{v, bones:[{name,parent,x,y}]}`）；矩阵不进 json —— 它由坐标推出来 */
export function skeletonMeta(sk: SkeletonSpec): Record<string, unknown> {
  return {
    v: SKELETON_VERSION,
    bones: sk.bones.map((b) => ({ name: b.name, parent: b.parent, x: q5(b.x), y: q5(b.y) })),
  };
}

export function skeletonOf(modelJson: unknown): SkeletonSpec | null {
  return parseSkeleton(asObj(asObj(modelJson)?.puppetWarp)?.skeleton);
}

/** 写回工程 json 的 `puppetWarp.skeleton`（空骨架 = 删掉这个键，回落 P0 钉子骨） */
export function withSkeleton<T>(modelJson: T, sk: SkeletonSpec | null): T {
  const o = asObj(modelJson);
  if (!o) return modelJson;
  const puppet = { ...(asObj(o.puppetWarp) ?? {}) };
  if (sk && sk.bones.length) puppet.skeleton = skeletonMeta(sk);
  else delete puppet.skeleton;
  const next: Record<string, unknown> = { ...o };
  if (Object.keys(puppet).length) next.puppetWarp = puppet;
  else delete next.puppetWarp;
  return next as unknown as T;
}

/** 起名：`base` 被占就 `base 2` / `base 3`…（重命名也用它，保证面板里不重名） */
export function uniqueBoneName(sk: SkeletonSpec, base = DEFAULT_BONE_NAME): string {
  const used = new Set(sk.bones.map((b) => b.name));
  if (!used.has(base)) return base;
  for (let i = 2; i < MAX_BONES + 2; i++) {
    const cand = clampName(`${base} ${i}`);
    if (!used.has(cand)) return cand;
  }
  return clampName(`${base} ${Date.now() % 1000}`);
}

/** 加一根骨（默认连到最后一根 = 「自动与上一根相连」；`parent` 指定时连到那根）；返回新下标 */
export function addBone(sk: SkeletonSpec, x: number, y: number, parent?: number, name?: string): { skeleton: SkeletonSpec; index: number } | null {
  if (sk.bones.length >= MAX_BONES) return null;
  if (!isNum(x) || !isNum(y)) return null;
  const index = sk.bones.length;
  const p = parent === undefined ? (index > 0 ? index - 1 : -1) : parent;
  if (!isInt(p) || p < -1 || p >= index) return null;
  const bones = sk.bones.map((b) => ({ ...b }));
  // 默认命名按骨号编号（`bone 1` / `bone 2`…），与 WE 的自动命名一致，也方便面板里对照
  const wanted = name && name.trim() ? name.trim() : `${DEFAULT_BONE_NAME} ${index + 1}`;
  bones.push({ name: cleanName(sk, wanted), parent: p, x: q5(x), y: q5(y) });
  return { skeleton: { bones }, index };
}

/** 删一根骨：它的子骨改挂到它的父级（不丢子树），下标整体重排 */
export function removeBone(sk: SkeletonSpec, index: number): SkelRemap | null {
  if (!isInt(index) || index < 0 || index >= sk.bones.length) return null;
  const gone = sk.bones[index];
  const rest = sk.bones.filter((_, i) => i !== index).map((b) => ({ ...b, parent: b.parent === index ? gone.parent : b.parent }));
  // 父级下标搬移：删掉的下标之后的骨都要 -1
  const shift = (p: number) => (p === -1 || p === index ? -1 : p > index ? p - 1 : p);
  for (const b of rest) b.parent = shift(b.parent);
  const map = new Array<number>(sk.bones.length).fill(-1);
  let w = 0;
  for (let i = 0; i < sk.bones.length; i++) {
    if (i === index) {
      // 被删的骨：它名下的顶点归它的父级（根骨的父级不存在 ⇒ 归新根 0）
      map[i] = gone.parent === -1 ? 0 : shift(gone.parent);
      continue;
    }
    map[i] = w++;
  }
  const out = { bones: rest };
  const res = parentsOk(out) ? out : topoSort(rest).skeleton;
  return { skeleton: res, map };
}

export function renameBone(sk: SkeletonSpec, index: number, name: string): SkeletonSpec | null {
  if (!isInt(index) || index < 0 || index >= sk.bones.length) return null;
  const others = sk.bones.filter((_, i) => i !== index);
  const wanted = (name ?? "").trim() || `${DEFAULT_BONE_NAME} ${index + 1}`;
  const bones = sk.bones.map((b, i) => (i === index ? { ...b, name: cleanName({ bones: others }, wanted) } : { ...b }));
  return { bones };
}

/** 起名：拿 `wanted` 去重（被占就 `wanted 2` / `wanted 3`…） */
function cleanName(sk: SkeletonSpec, wanted: string): string {
  return clampName(uniqueBoneName(sk, clampName(wanted)));
}

/** 挪骨点（父级不变 ⇒ 不变式不破，无需重排） */
export function moveBone(sk: SkeletonSpec, index: number, x: number, y: number): SkeletonSpec | null {
  if (!isInt(index) || index < 0 || index >= sk.bones.length || !isNum(x) || !isNum(y)) return null;
  const bones = sk.bones.map((b, i) => (i === index ? { ...b, x: q5(x), y: q5(y) } : { ...b }));
  return { bones };
}

export const boneParentOf = (sk: SkeletonSpec, index: number): number => (sk.bones[index] ? sk.bones[index].parent : -1);

/** 祖先链（从根到自身） */
export function boneChain(sk: SkeletonSpec, index: number): number[] {
  const out: number[] = [];
  let i = index;
  while (i >= 0 && i < sk.bones.length && out.length <= MAX_BONES) {
    out.unshift(i);
    i = sk.bones[i].parent;
  }
  return out;
}

export const boneDepthOf = (sk: SkeletonSpec, index: number): number => Math.max(0, boneChain(sk, index).length - 1);

/** 后代集合（含自身），按下标升序 */
export function boneSubtree(sk: SkeletonSpec, index: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < sk.bones.length; i++) if (boneChain(sk, i).includes(index)) out.push(i);
  return out;
}

/** 改父级（拒绝成环 / 自环）：必要时应重排并给出下标搬运表；`parent = -1` 变根骨 */
export function setBoneParent(sk: SkeletonSpec, index: number, parent: number): SkelRemap | null {
  if (!isInt(index) || index < 0 || index >= sk.bones.length) return null;
  if (!isInt(parent) || parent < -1 || parent >= sk.bones.length) return null;
  if (parent === index) return null;
  if (parent !== -1 && boneChain(sk, parent).includes(index)) return null; // 父子倒挂 = 成环
  const bones = sk.bones.map((b, i) => (i === index ? { ...b, parent } : { ...b }));
  const needOrder = bones.some((b, i) => b.parent !== -1 && b.parent >= i);
  if (!needOrder) return { skeleton: { bones }, map: bones.map((_, i) => i) };
  return topoSort(bones);
}

/** 只对调两根骨的**名字**（把子树的骨号整体换位属于重排，见 `topoSort`） */
export function swapBoneNames(sk: SkeletonSpec, a: number, b: number): SkeletonSpec | null {
  if (!isInt(a) || !isInt(b) || a < 0 || b < 0 || a >= sk.bones.length || b >= sk.bones.length || a === b) return null;
  const bones = sk.bones.map((x) => ({ ...x }));
  const na = bones[a].name;
  bones[a].name = bones[b].name;
  bones[b].name = na;
  return { bones };
}

/** 父级下标（重排 / 删骨后用）：每个旧骨号 → 新骨号；-1 表示不存在（调用方回落 0） */
export function remapIndex(map: readonly number[], old: number): number {
  if (!Number.isInteger(old) || old < 0 || old >= map.length) return 0;
  const v = map[old];
  return v === undefined || v < 0 ? 0 : v;
}

/** 绑定姿势的局部矩阵：纯平移（根骨 = 自身点；子骨 = 相对父级的差），y 向上 */
export function boneMatrixOf(sk: SkeletonSpec, index: number): Float32Array {
  const b = sk.bones[index];
  const p = b.parent >= 0 && b.parent < sk.bones.length ? sk.bones[b.parent] : null;
  const dx = p ? b.x - p.x : b.x;
  const dy = p ? b.y - p.y : b.y;
  return Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, q5(dx), q5(dy), 0, 1);
}

/** 整张骨表（写 `setMdlSkeleton`）：顺序 = 骨号，矩阵 = 纯平移绑定姿势 */
export function boneSpecs(sk: SkeletonSpec): SkelBoneSpec[] {
  return sk.bones.map((b, i) => ({ name: b.name, parent: b.parent, matrix: boneMatrixOf(sk, i) }));
}

/** 骨点（模型空间）——叠加层画点用 */
export function bonePoints(sk: SkeletonSpec): Array<[number, number]> {
  return sk.bones.map((b) => [b.x, b.y]);
}

/** 命中最近的骨（模型空间距离 ≤ tol）；同距取下标小的（根骨优先） */
export function nearestBone(sk: SkeletonSpec, x: number, y: number, tol = BONE_HIT_TOL): number | null {
  let best = -1;
  let bestD = tol;
  for (let i = 0; i < sk.bones.length; i++) {
    const d = Math.hypot(sk.bones[i].x - x, sk.bones[i].y - y);
    if (d <= bestD) {
      if (d < bestD || best === -1) {
        best = i;
        bestD = d;
      }
    }
  }
  return best === -1 ? null : best;
}

export function boneIndexByName(sk: SkeletonSpec, name: string): number {
  return sk.bones.findIndex((b) => b.name === name);
}

/** 骨点是否落在矩形里（框选 / 批量操作） */
export function bonesInRect(sk: SkeletonSpec, x0: number, y0: number, x1: number, y1: number): number[] {
  const [lx, hx] = x0 <= x1 ? [x0, x1] : [x1, x0];
  const [ly, hy] = y0 <= y1 ? [y0, y1] : [y1, y0];
  const out: number[] = [];
  for (let i = 0; i < sk.bones.length; i++) {
    const b = sk.bones[i];
    if (b.x >= lx && b.x <= hx && b.y >= ly && b.y <= hy) out.push(i);
  }
  return out;
}

/** 骨架相等（落盘判断 / 测试用）：坐标量化到 1e-5 后逐字段比 */
export function skeletonsEqual(a: SkeletonSpec | null, b: SkeletonSpec | null): boolean {
  if (!a || !b) return a === b;
  if (a.bones.length !== b.bones.length) return false;
  return a.bones.every((x, i) => {
    const y = b.bones[i];
    return x.name === y.name && x.parent === y.parent && Math.abs(x.x - y.x) < 1e-6 && Math.abs(x.y - y.y) < 1e-6;
  });
}

/** 按图片尺寸给一套初始骨架（根在腰部）：没骨架时面板「新建骨架」用，也让真机判据有确定性输入 */
export function defaultBonesFor(size: { width: number; height: number }): SkeletonSpec {
  const { width: w, height: h } = size;
  const { skeleton } = (() => {
    const s0 = defaultSkeleton();
    const a = addBone(s0, 0, -h * 0.25, -1, "root");
    if (!a) return { skeleton: s0 };
    const b = addBone(a.skeleton, 0, h * 0.1, a.index, "spine");
    if (!b) return { skeleton: a.skeleton };
    const c = addBone(b.skeleton, -w * 0.2, h * 0.3, b.index, "arm L");
    if (!c) return { skeleton: b.skeleton };
    const d = addBone(c.skeleton, w * 0.2, h * 0.3, b.index, "arm R");
    if (!d) return { skeleton: c.skeleton };
    const e = addBone(d.skeleton, -w * 0.12, -h * 0.1, a.index, "leg L");
    if (!e) return { skeleton: d.skeleton };
    const f = addBone(e.skeleton, w * 0.12, -h * 0.1, a.index, "leg R");
    return { skeleton: f ? f.skeleton : e.skeleton };
  })();
  return skeleton;
}
