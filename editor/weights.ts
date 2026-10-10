// P2 权重（PUPPET-WARP-FULL-PLAN §5 P2）：4 槽蒙皮、逐骨着色预览、笔刷、平滑、孤岛混合。
//
// 数据结构就是 .mdl 的蒙皮槽本身（每顶点 4 个骨号 + 4 个权重，见 `pkg/mdl-write.js` 的
// `packVertices` / `meshVertexLayout`）——`editor/main.ts` 把会话里的这份 `WeightSkin`
// 直接交给 `setMdlBoneIdx` / `setMdlWeights` 落盘，中间没有别的表示。
//
// 不变量（每个顶点每个状态都必须成立，写盘前用 `skinValid` 卡一道）：
//   1. 权重有限、非负；2. Σ > 0（全零顶点在引擎里会消失）；3. 骨号是整数且落在 [0, 骨数)；
//   4. 槽位不做去重（同骨重复 = 该骨权重相加，引擎 `computeSkinMatrices` 也是相加），
//      但 `smoothSkin` / `remapSkin` 会主动合并重复槽，避免越长越碎。
//
// 坐标口径同 `editor/skeleton.ts`：模型空间、y 向上、单位 = 贴图像素。

import type { MdlPart } from "../renderer/src/api/editor";

export const WEIGHTS_VERSION = 1;
export const MAX_SLOTS = 4;
/** 权重和为 0 的顶点在引擎里会塌成零尺寸 —— 下限用来兜「删骨 / 移除权重」的边界情况 */
export const MIN_TOTAL = 1e-4;
/** 画权重时的默认笔刷半径 / 强度（模型空间像素） */
export const BRUSH_RADIUS = 24;
export const BRUSH_STRENGTH = 0.5;
export const BRUSH_RADIUS_MIN = 2;
export const BRUSH_RADIUS_MAX = 256;
export const SMOOTH_ITER_MAX = 32;
export const WEIGHT_EPS = 1e-6;
/** 部件的绘制序步长（语料同形：0 / 100 / 200…） */
export const DRAW_ORDER_STEP = 100;

/** 每顶点 4 槽的蒙皮（就是 .mdl 的顶点蒙皮数据） */
export type WeightSkin = { joints: Uint32Array; weights: Float32Array; vertexCount: number };
export type WeightIslands = { island: Int32Array; count: number };

const asObj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export const vertexIndexOf = (skin: WeightSkin): number => skin.vertexCount;

export function weightsMeta(locked = false): Record<string, unknown> {
  return { v: WEIGHTS_VERSION, locked: locked === true };
}

/** 读工程 json 的 `puppetWarp.weights`（只有 UI 状态；顶点权重本体在 .mdl 里） */
export function parseWeightsMeta(raw: unknown): { v: number; locked: boolean } | null {
  const o = asObj(raw);
  if (!o) return null;
  return { v: isNum(o.v) ? o.v : WEIGHTS_VERSION, locked: o.locked === true };
}

export function weightsOf(modelJson: unknown): { v: number; locked: boolean } | null {
  return parseWeightsMeta(asObj(asObj(modelJson)?.puppetWarp)?.weights);
}

export function withWeights<T>(modelJson: T, state: { locked?: boolean } | null): T {
  const o = asObj(modelJson);
  if (!o) return modelJson;
  const puppet = { ...(asObj(o.puppetWarp) ?? {}) };
  if (state) puppet.weights = weightsMeta(state.locked === true);
  else delete puppet.weights;
  const next: Record<string, unknown> = { ...o };
  if (Object.keys(puppet).length) next.puppetWarp = puppet;
  else delete next.puppetWarp;
  return next as unknown as T;
}

/** 全给一根骨（新网格 / 无骨头时的起点） */
export function uniformSkin(vertexCount: number, bone = 0): WeightSkin {
  const joints = new Uint32Array(vertexCount * MAX_SLOTS);
  const weights = new Float32Array(vertexCount * MAX_SLOTS);
  for (let v = 0; v < vertexCount; v++) {
    joints[v * MAX_SLOTS] = bone;
    weights[v * MAX_SLOTS] = 1;
  }
  return { joints, weights, vertexCount };
}

export function cloneSkin(skin: WeightSkin): WeightSkin {
  return { joints: Uint32Array.from(skin.joints), weights: Float32Array.from(skin.weights), vertexCount: skin.vertexCount };
}

/** 每顶点归最近的一根骨（权重 1）——「自动分配」；`bones` 是模型空间骨点 */
export function nearestBoneSkin(positions: ArrayLike<number>, bones: ReadonlyArray<[number, number]>): WeightSkin {
  const vertexCount = Math.floor(positions.length / 3);
  const skin = uniformSkin(vertexCount, 0);
  if (!bones.length) return skin;
  for (let v = 0; v < vertexCount; v++) {
    const x = positions[v * 3];
    const y = positions[v * 3 + 1];
    let best = 0;
    let bestD = Infinity;
    for (let b = 0; b < bones.length; b++) {
      const d = Math.hypot(bones[b][0] - x, bones[b][1] - y);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    skin.joints[v * MAX_SLOTS] = best;
    skin.weights[v * MAX_SLOTS] = 1;
    for (let k = 1; k < MAX_SLOTS; k++) {
      skin.joints[v * MAX_SLOTS + k] = best;
      skin.weights[v * MAX_SLOTS + k] = 0;
    }
  }
  return skin;
}

/** 网格邻接（无向边，CSR）：`indices` 是三角形列表（每 3 个下标一个面） */
export function adjacencyOf(indices: ArrayLike<number>, vertexCount: number): { start: Uint32Array; list: Uint32Array } {
  const sets: Array<Set<number>> = Array.from({ length: vertexCount }, () => new Set<number>());
  const add = (a: number, b: number) => {
    if (a === b || a < 0 || b < 0 || a >= vertexCount || b >= vertexCount) return;
    sets[a].add(b);
    sets[b].add(a);
  };
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = indices[i];
    const b = indices[i + 1];
    const c = indices[i + 2];
    add(a, b);
    add(b, c);
    add(c, a);
  }
  const start = new Uint32Array(vertexCount + 1);
  let total = 0;
  for (let v = 0; v < vertexCount; v++) {
    start[v] = total;
    total += sets[v].size;
  }
  start[vertexCount] = total;
  const list = new Uint32Array(total);
  let w = 0;
  for (let v = 0; v < vertexCount; v++) for (const n of sets[v]) list[w++] = n;
  return { start, list };
}

/** 取某顶点的 4 槽（骨号 + 权重），按权重降序 */
export function skinSlotsOf(skin: WeightSkin, vertex: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let k = 0; k < MAX_SLOTS; k++) out.push([skin.joints[vertex * MAX_SLOTS + k], skin.weights[vertex * MAX_SLOTS + k]]);
  out.sort((a, b) => b[1] - a[1]);
  return out;
}

/** 主骨（权重最大的槽） */
export function dominantBoneOf(skin: WeightSkin, vertex: number): number {
  let best = 0;
  let bestW = -1;
  for (let k = 0; k < MAX_SLOTS; k++) {
    const w = skin.weights[vertex * MAX_SLOTS + k];
    if (w > bestW) {
      bestW = w;
      best = skin.joints[vertex * MAX_SLOTS + k];
    }
  }
  return best;
}

/** 不变量检查（`boneCount` 给了就一起卡骨号范围）；返回第一个出问题的顶点下标，全好返回 -1 */
export function skinBadVertex(skin: WeightSkin, boneCount?: number | null): number {
  const { joints, weights, vertexCount } = skin;
  if (joints.length !== vertexCount * MAX_SLOTS || weights.length !== vertexCount * MAX_SLOTS) return 0;
  for (let v = 0; v < vertexCount; v++) {
    let sum = 0;
    for (let k = 0; k < MAX_SLOTS; k++) {
      const w = weights[v * MAX_SLOTS + k];
      const j = joints[v * MAX_SLOTS + k];
      if (!Number.isFinite(w) || w < 0) return v;
      if (!Number.isInteger(j) || j < 0) return v;
      if (boneCount !== undefined && boneCount !== null && j >= boneCount) return v;
      sum += w;
    }
    if (!(sum > 0) || !Number.isFinite(sum)) return v;
  }
  return -1;
}

export const skinValid = (skin: WeightSkin, boneCount?: number | null): boolean => skinBadVertex(skin, boneCount) < 0;

/** 顶点 4 槽归一化（Σ 归 1）；Σ ≤ 0 时给槽 0 满权重 */
export function normalizeVertex(skin: WeightSkin, vertex: number): void {
  let sum = 0;
  for (let k = 0; k < MAX_SLOTS; k++) sum += Math.max(0, skin.weights[vertex * MAX_SLOTS + k]);
  if (!(sum > MIN_TOTAL)) {
    for (let k = 0; k < MAX_SLOTS; k++) skin.weights[vertex * MAX_SLOTS + k] = k === 0 ? 1 : 0;
    return;
  }
  for (let k = 0; k < MAX_SLOTS; k++) skin.weights[vertex * MAX_SLOTS + k] = Math.max(0, skin.weights[vertex * MAX_SLOTS + k]) / sum;
}

/**
 * 把某顶点对 `bone` 的权重设成 `value`（0..1），其余槽按原比例分剩下的。
 * `bone` 不在 4 槽里时挤掉权重最小的那一槽（这就是「4 影响上限只做 4 槽重分配」）。
 */
export function assignWeight(skin: WeightSkin, vertex: number, bone: number, value: number): void {
  if (!Number.isInteger(bone) || bone < 0) return;
  const base = vertex * MAX_SLOTS;
  const v = Math.min(1, Math.max(0, value));
  let slot = -1;
  for (let k = 0; k < MAX_SLOTS; k++) if (skin.joints[base + k] === bone) slot = k;
  if (slot < 0) {
    if (v <= 0) return;
    let min = 0;
    for (let k = 1; k < MAX_SLOTS; k++) if (skin.weights[base + k] < skin.weights[base + min]) min = k;
    slot = min;
    skin.joints[base + slot] = bone;
    skin.weights[base + slot] = 0;
  }
  let rest = 0;
  for (let k = 0; k < MAX_SLOTS; k++) if (k !== slot) rest += skin.weights[base + k];
  const scale = rest > WEIGHT_EPS ? (1 - v) / rest : 0;
  for (let k = 0; k < MAX_SLOTS; k++) if (k !== slot) skin.weights[base + k] *= scale;
  skin.weights[base + slot] = v;
  if (v <= 0) {
    // 移除权重：把这一槽也清空（骨号留着不影响，权重 0 的槽引擎会忽略）
    skin.weights[base + slot] = 0;
  }
  normalizeVertex(skin, vertex);
}

/** 按笔刷增量涂（`op="add"` 加、`"remove"` 减），返回改动的顶点数 */
export function paintVertices(
  skin: WeightSkin,
  positions: ArrayLike<number>,
  center: [number, number],
  radius: number,
  bone: number,
  strength = BRUSH_STRENGTH,
  op: "add" | "remove" = "add",
): number {
  const r = Math.max(1e-3, radius);
  let touched = 0;
  for (let v = 0; v < skin.vertexCount; v++) {
    const dx = positions[v * 3] - center[0];
    const dy = positions[v * 3 + 1] - center[1];
    const d = Math.hypot(dx, dy);
    if (d > r) continue;
    // 软边：中心满强度，边缘线性衰减到 0
    const fall = 1 - d / r;
    const base = v * MAX_SLOTS;
    let cur = 0;
    for (let k = 0; k < MAX_SLOTS; k++) if (skin.joints[base + k] === bone) cur = skin.weights[base + k];
    const delta = strength * fall * (op === "add" ? 1 : -1);
    assignWeight(skin, v, bone, cur + delta);
    touched++;
  }
  return touched;
}

/**
 * 平滑：每个顶点把邻接顶点的骨权重并进来（同骨相加）取 top-4 归一 —— Laplacian 平滑的
 * 「4 槽版」。`only` 给了就只平滑这些顶点（孤岛边界混合用）。返回改动顶点数。
 */
export function smoothSkin(
  skin: WeightSkin,
  adj: { start: Uint32Array; list: Uint32Array },
  iterations = 1,
  only?: Uint8Array | null,
): number {
  const iters = Math.max(0, Math.min(SMOOTH_ITER_MAX, Math.floor(iterations)));
  if (!iters) return 0;
  let touchedTotal = 0;
  for (let it = 0; it < iters; it++) {
    const next = { joints: Uint32Array.from(skin.joints), weights: Float32Array.from(skin.weights), vertexCount: skin.vertexCount };
    let touched = 0;
    for (let v = 0; v < skin.vertexCount; v++) {
      if (only && !only[v]) continue;
      const acc = new Map<number, number>();
      const base = v * MAX_SLOTS;
      for (let k = 0; k < MAX_SLOTS; k++) {
        const j = skin.joints[base + k];
        const w = skin.weights[base + k];
        if (w > 0) acc.set(j, (acc.get(j) ?? 0) + w * 2); // 自身权重加倍（λ = 0.5）
      }
      let count = 2;
      for (let p = adj.start[v]; p < adj.start[v + 1]; p++) {
        const n = adj.list[p];
        count++;
        for (let k = 0; k < MAX_SLOTS; k++) {
          const j = skin.joints[n * MAX_SLOTS + k];
          const w = skin.weights[n * MAX_SLOTS + k];
          if (w > 0) acc.set(j, (acc.get(j) ?? 0) + w);
        }
      }
      const top = [...acc.entries()].filter(([, w]) => w > 0).sort((a, b) => b[1] - a[1]).slice(0, MAX_SLOTS);
      if (!top.length) continue;
      const sum = top.reduce((s, [, w]) => s + w, 0);
      for (let k = 0; k < MAX_SLOTS; k++) {
        next.joints[v * MAX_SLOTS + k] = top[k] ? top[k][0] : top[top.length - 1][0];
        next.weights[v * MAX_SLOTS + k] = top[k] ? top[k][1] / sum : 0;
      }
      touched++;
    }
    skin.joints.set(next.joints);
    skin.weights.set(next.weights);
    touchedTotal = touched;
  }
  return touchedTotal;
}

/** 孤岛 = 主骨相同且拓扑相连的连通块（`groupIndicesByLimb` 之外的权重视角） */
export function islandsOf(skin: WeightSkin, adj: { start: Uint32Array; list: Uint32Array }): WeightIslands {
  const island = new Int32Array(skin.vertexCount).fill(-1);
  let count = 0;
  const stack: number[] = [];
  for (let v = 0; v < skin.vertexCount; v++) {
    if (island[v] >= 0) continue;
    const id = count++;
    const bone = dominantBoneOf(skin, v);
    island[v] = id;
    stack.push(v);
    while (stack.length) {
      const cur = stack.pop() as number;
      for (let p = adj.start[cur]; p < adj.start[cur + 1]; p++) {
        const n = adj.list[p];
        if (island[n] >= 0) continue;
        if (dominantBoneOf(skin, n) !== bone) continue;
        island[n] = id;
        stack.push(n);
      }
    }
  }
  return { island, count };
}

/** 孤岛边界顶点（自己或邻居属于别的孤岛） */
export function islandBoundary(islands: WeightIslands, adj: { start: Uint32Array; list: Uint32Array }): Uint8Array {
  const out = new Uint8Array(islands.island.length);
  for (let v = 0; v < islands.island.length; v++) {
    for (let p = adj.start[v]; p < adj.start[v + 1]; p++) {
      if (islands.island[adj.list[p]] !== islands.island[v]) {
        out[v] = 1;
        break;
      }
    }
  }
  return out;
}

/** 孤岛混合：只平滑孤岛边界（跨孤岛连续，孤岛内部不动） */
export function blendIslandBoundary(
  skin: WeightSkin,
  adj: { start: Uint32Array; list: Uint32Array },
  islands: WeightIslands,
  iterations = 1,
): number {
  return smoothSkin(skin, adj, iterations, islandBoundary(islands, adj));
}

/** 每骨总权重（面板画比例条） */
export function boneTotals(skin: WeightSkin, boneCount: number): Float32Array {
  const out = new Float32Array(boneCount);
  for (let v = 0; v < skin.vertexCount; v++) {
    for (let k = 0; k < MAX_SLOTS; k++) {
      const j = skin.joints[v * MAX_SLOTS + k];
      if (j >= 0 && j < boneCount) out[j] += skin.weights[v * MAX_SLOTS + k];
    }
  }
  return out;
}

/** 某骨的顶点遮罩（权重 ≥ threshold）—— 逐骨着色预览 / 涂权重时的高亮 */
export function boneVertexMask(skin: WeightSkin, bone: number, threshold = 0.5): Uint8Array {
  const out = new Uint8Array(skin.vertexCount);
  for (let v = 0; v < skin.vertexCount; v++) {
    for (let k = 0; k < MAX_SLOTS; k++) {
      if (skin.joints[v * MAX_SLOTS + k] === bone && skin.weights[v * MAX_SLOTS + k] >= threshold) {
        out[v] = 1;
        break;
      }
    }
  }
  return out;
}

/**
 * 骨号重排后搬蒙皮：`map[旧] = 新`。重复骨号**合并**（权重相加）、取 top-4、归一；
 * 合完为空的顶点（旧骨全被删）回落 `fallback`（默认 0）满权重。返回新 skin。
 */
export function remapSkin(skin: WeightSkin, map: readonly number[], fallback = 0): WeightSkin {
  const out: WeightSkin = { joints: new Uint32Array(skin.joints.length), weights: new Float32Array(skin.weights.length), vertexCount: skin.vertexCount };
  for (let v = 0; v < skin.vertexCount; v++) {
    const acc = new Map<number, number>();
    for (let k = 0; k < MAX_SLOTS; k++) {
      const w = skin.weights[v * MAX_SLOTS + k];
      if (w <= 0) continue;
      const old = skin.joints[v * MAX_SLOTS + k];
      const raw = Number.isInteger(old) && old >= 0 && old < map.length ? map[old] : -1;
      const j = raw === undefined || raw < 0 ? -1 : raw;
      if (j < 0) continue;
      acc.set(j, (acc.get(j) ?? 0) + w);
    }
    const top = [...acc.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_SLOTS);
    if (!top.length) {
      for (let k = 0; k < MAX_SLOTS; k++) {
        out.joints[v * MAX_SLOTS + k] = fallback;
        out.weights[v * MAX_SLOTS + k] = k === 0 ? 1 : 0;
      }
      continue;
    }
    const sum = top.reduce((s, [, w]) => s + w, 0);
    for (let k = 0; k < MAX_SLOTS; k++) {
      const e = top[k];
      out.joints[v * MAX_SLOTS + k] = e ? e[0] : top[top.length - 1][0];
      out.weights[v * MAX_SLOTS + k] = e ? e[1] / sum : 0;
    }
  }
  return out;
}

/**
 * `Move Limb to Front`（官方 clippingmasks.md:31）：把第 `index` 个部件的绘制序调到**最前**。
 *
 * 部件表必须保持 `start` 升序、首尾相接铺满索引表（`meshExtra` 与引擎解析器的部件锚扫都强校验），
 * 所以这里动的是 `draw_order_offset` 而不是数组顺序 —— 语料的绘制序按 100 递增，我们沿用这个步长，
 * 把目标部件的 offset 抬到所有部件之上（越大越靠前）。
 *
 * ⚠️ 偏差（面板里如实标注）：我们的渲染器整只网格一次 draw call，不消费 per-part 绘制序，
 * 所以这个改动写进 .mdl 后（WE 侧 / 未来分部件绘制）才看得出来，编辑器预览里前后不变。
 */
export function moveLimbFront(parts: ReadonlyArray<MdlPart>, index: number): MdlPart[] | null {
  if (!Number.isInteger(index) || index < 0 || index >= parts.length) return null;
  let maxOff = -Infinity;
  for (const p of parts) maxOff = Math.max(maxOff, p.offset);
  if (!Number.isFinite(maxOff)) maxOff = 0;
  return parts.map((p, i) => ({ id: p.id, offset: i === index ? maxOff + DRAW_ORDER_STEP : p.offset, start: p.start, size: p.size }));
}

/**
 * `Move Limb to Front` 的**盘上另一半**：把第 `index` 个部件的索引区间整段搬到索引表末尾。
 *
 * 索引表是绘制顺序（越靠后越前）：整段搬走既保住「每个三角形仍在同一个部件里」，
 * 又让「部件表顺序 = 绘制顺序」这条 WE 侧最可能消费的线索真的变。搬运后重新计算每块的
 * `start`（保持升序、首尾相接铺满），`id` / `offset` / `size` 原样带过。
 *
 * ⚠️ 偏差（面板里如实标注）：我们的渲染器整只网格一次 draw call，预览里前后仍然一样；
 * 另外下一次 P1 几何重建会把部件表重算成行带（`geo.partsDropped` 会提示），绘制序随之丢失。
 */
export function reorderPartRange(
  indices: ArrayLike<number>,
  parts: ReadonlyArray<MdlPart>,
  index: number,
): { indices: Uint32Array; parts: MdlPart[] } | null {
  if (!Number.isInteger(index) || index < 0 || index >= parts.length) return null;
  if (!partsOk(parts, indices.length)) return null;
  const moved = parts[index];
  const out = new Uint32Array(indices.length);
  const next: MdlPart[] = [];
  let at = 0;
  for (let i = 0; i < parts.length; i++) {
    if (i === index) continue;
    const p = parts[i];
    for (let k = 0; k < p.size; k++) out[at + k] = indices[p.start + k];
    next.push({ id: p.id, offset: p.offset, start: at, size: p.size });
    at += p.size;
  }
  for (let k = 0; k < moved.size; k++) out[at + k] = indices[moved.start + k];
  next.push({ id: moved.id, offset: moved.offset, start: at, size: moved.size });
  return { indices: out, parts: next };
}

/** 绘制序名次（0 = 最前）：面板上给「前 / 后」着色用（越大越前 ⇒ 名次越小越前） */
export function drawOrderRank(parts: ReadonlyArray<MdlPart>, index: number): number {
  if (!Number.isInteger(index) || index < 0 || index >= parts.length) return -1;
  const mine = parts[index].offset;
  return parts.filter((p, i) => i !== index && p.offset > mine).length;
}

/** 绘制序归一：按现有 offset 降序重排成 `0, 100, 200…`（保持相对前后关系，去掉重复 / 间隙） */
export function normalizeDrawOrder(parts: ReadonlyArray<MdlPart>): MdlPart[] {
  const order = parts
    .map((p, i): [MdlPart, number] => [p, i])
    .sort((a, b) => b[0].offset - a[0].offset)
    .map(([, i]) => i);
  const rank = new Array<number>(parts.length).fill(0);
  order.forEach((i, r) => (rank[i] = r));
  return parts.map((p, i) => ({ id: p.id, offset: rank[i] * DRAW_ORDER_STEP, start: p.start, size: p.size }));
}

/** 部件表是否首尾相接铺满索引表（写盘前的自检，同 P1 的 partsOk；与数组顺序无关） */
export function partsOk(parts: ReadonlyArray<MdlPart>, indexCount: number): boolean {
  if (!parts.length) return false;
  const sorted = [...parts].sort((a, b) => a.start - b.start);
  let at = 0;
  for (const p of sorted) {
    if (p.start !== at || p.size <= 0 || p.size % 3 !== 0) return false;
    at += p.size;
  }
  return at === indexCount;
}
