// 几何（官方 Puppet Warp 的 Geometry 步骤）：网格生成 / 细分 / 切片 / Padding / Lock geometry /
// Edit Topology（对角线翻转 + 顶点偏移）。P1 的另一半（Character Sheet 抠图与 limb 分割）在
// editor/limbs.ts。
//
// 官方文档（docs/we-docs/puppet-pages/pw-introduction.md）只说明「Create 建立网格、Subdivision
// 增加细分、Padding 把网格轮廓向外扩，后面的图片效果被限制在这块区域内」，**没有 triangulation
// 的算法规定**（全 13 页零 triangulation 字样），所以本模块的拓扑（规则网格 + 显式翻转 + 顶点偏移）
// 是自定规则，并且把自定部分**显式存进工程 json**（`puppetWarp.geometry`），避免重开工程时靠猜。
//
// 与 .mdl 的分工：网格本体（顶点 / 索引 / 部件表）进 .mdl；`puppetWarp.geometry` 只放创作态
// （细分 / 切片 / padding / 锁定 / 翻转 / 偏移 / 部件顺序），见 docs/PUPPET-WARP-FULL-PLAN.md §3。
//
// 坐标约定与 editor/warp.ts 完全一致：模型空间像素、原点在图片中心、Y 向上；UV 左上原点、
// v 向下；顶点序 j 从**下**到上（j = 0 是底边），所以 `GeometryMesh` 可以直接喂给 warp.ts 的
// buildSkin / buildRig。
//
// 本模块不碰 DOM、引擎与资源表，只做纯计算与 json 片段，方便离线单测与真机复用同一份实现。

import type { MdlPart } from "../renderer/src/api/editor";

/** 模型 json 里 Puppet Warp 创作态的容器键（v2 契约；v1 的顶层 `warp` 键仍可读，见 warp.ts） */
export const PUPPET_KEY = "puppetWarp";
export const GEOMETRY_VERSION = 1;
/** 基础网格格数（未细分前）与细分倍数 */
export const COLS_MIN = 1;
export const COLS_MAX = 64;
export const SUBDIV_MIN = 1;
export const SUBDIV_MAX = 8;
/** Padding：网格轮廓向外扩的像素数（官方 Geometry 的 Padding） */
export const PADDING_MIN = 0;
export const PADDING_MAX = 128;
/** 内部切分线（Slice）条数上限，每边分开计 */
export const MAX_SLICES = 32;
/** 顶点偏移的归一化幅度上限（±半张图） */
export const OFFSET_MAX = 0.5;

export type WarpSize = { width: number; height: number };

/** Edit Topology 的自定规则：flips = 被翻对角线的格子下标；offsets = 每顶点 2 分量归一化偏移 */
export type GeometryTopology = {
  flips: number[];
  offsets: number[];
};

export type GeometrySpec = {
  /** 基础格数（细分前的列 / 行数） */
  cols: number;
  rows: number;
  /** 每格再切 subdivision × subdivision 份 */
  subdivision: number;
  /** 归一化内部切分线（0<..<1，升序、去重），把基础格再切开 */
  sliceX: number[];
  sliceY: number[];
  /** 网格轮廓向外扩的像素数（不改 .mdl 之外的任何字段；cropoffset 方向未定，不碰） */
  padding: number;
  /** Lock geometry：锁定后不再自动重建网格（UI 只读） */
  locked: boolean;
  topology: GeometryTopology;
  /** 部件 / limb 的绘制序：长度 = 部件数，值 = 该部件的绘制位次（空 = 不写部件表） */
  partOrder: number[];
};

/** 网格的轴坐标（归一化 0..1，含切片与细分），长度 = 有效格数 + 1 */
export type GeometryAxes = { xs: number[]; ys: number[] };

/** 与 warp.ts 的 WarpMesh 结构兼容（cols/rows/positions/uvs/normals/indices） */
export type GeometryMesh = {
  cols: number;
  rows: number;
  xs: number[];
  ys: number[];
  positions: Float32Array;
  uvs: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
};

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isInt = (v: unknown): v is number => isNum(v) && Number.isInteger(v);
/** 归一化坐标按 1e-5 取整：切片线去重与 json 往返都要稳定 */
const q5 = (v: number) => Math.round(v * 1e5) / 1e5;

export function defaultGeometry(size: WarpSize, cols = 2, rows = 2): GeometrySpec {
  return {
    cols: clamp(Math.round(cols), COLS_MIN, COLS_MAX),
    rows: clamp(Math.round(rows), COLS_MIN, COLS_MAX),
    subdivision: 1,
    sliceX: [],
    sliceY: [],
    padding: 0,
    locked: false,
    topology: { flips: [], offsets: [] },
    partOrder: [],
  };
}

/** 长边 MESH_BASE=32 格的等比基础网格（与 warp.ts 的 gridFor 同口径，但这里是「基础格数」） */
export function defaultColsRows(size: WarpSize, base = 8): { cols: number; rows: number } {
  const w = Math.max(1, size.width);
  const h = Math.max(1, size.height);
  const m = Math.max(w, h);
  return {
    cols: clamp(Math.round((base * w) / m), COLS_MIN, COLS_MAX),
    rows: clamp(Math.round((base * h) / m), COLS_MIN, COLS_MAX),
  };
}

/** 归一化切分线：过滤非法值、排序、去重、夹到 (0,1) 开区间 */
export function cleanSlices(list: readonly number[]): number[] {
  const out: number[] = [];
  for (const v of list) {
    if (!isNum(v)) continue;
    const t = q5(v);
    if (t <= 0 || t >= 1 || out.includes(t)) continue;
    out.push(t);
  }
  out.sort((a, b) => a - b);
  return out.slice(0, MAX_SLICES);
}

/** 单轴边界：基础均分 → 插入切片 → 每段再切 subdivision 份 */
function axisCuts(count: number, slices: readonly number[], sub: number): number[] {
  const base: number[] = [];
  for (let i = 0; i <= count; i++) base.push(i / count);
  for (const s of cleanSlices(slices)) base.push(s);
  base.sort((a, b) => a - b);
  const cuts: number[] = [];
  for (let i = 0; i < base.length - 1; i++) {
    const a = base[i];
    const b = base[i + 1];
    if (b - a < 1e-9) continue;
    for (let k = 0; k < sub; k++) cuts.push(q5(a + ((b - a) * k) / sub));
  }
  cuts.push(1);
  const uniq: number[] = [];
  for (const c of cuts) {
    if (uniq.length && Math.abs(uniq[uniq.length - 1] - c) < 1e-9) continue;
    uniq.push(c);
  }
  return uniq;
}

/** 网格的轴坐标：xs / ys 都是升序的归一化边界（含 0 与 1） */
export function axesOf(g: GeometrySpec): GeometryAxes {
  const sub = clamp(Math.round(g.subdivision), SUBDIV_MIN, SUBDIV_MAX);
  return {
    xs: axisCuts(clamp(Math.round(g.cols), COLS_MIN, COLS_MAX), g.sliceX, sub),
    ys: axisCuts(clamp(Math.round(g.rows), COLS_MIN, COLS_MAX), g.sliceY, sub),
  };
}

/** 有效格数（细分与切片都算进去） */
export function gridOf(g: GeometrySpec): { cols: number; rows: number } {
  const a = axesOf(g);
  return { cols: a.xs.length - 1, rows: a.ys.length - 1 };
}

export function vertexCountOf(g: GeometrySpec): number {
  const a = axesOf(g);
  return a.xs.length * a.ys.length;
}

export function padOf(g: GeometrySpec): number {
  return clamp(Math.round(g.padding), PADDING_MIN, PADDING_MAX);
}

/**
 * 生成网格。
 *
 * Padding 的用法（官方：网格轮廓向外扩，效果被限制在这块区域内）：模型的**尺寸与贴图都不变**，
 * 只有网格轮廓在四边各往外扩 `padding` 像素，UV 相应地被拉到 [0,1] 之外（贴图靠 clamp 重复边缘），
 * 于是「网格比图片大一圈」，图片本身的像素位置一个也不动。
 *
 * **不写 cropoffset**：`docs/CASEBOOK.md:2636-2665` 记录了对 252 个模型的实测——cropoffset 的
 * 符号方向未定、我们的运行时也从不消费它，而把 cropoffset 加进 origin 会撕开画面（2477602742）。
 * padding 只写进 `puppetWarp.geometry.padding`，cropoffset 原样保留、绝不改写。
 */
export function buildGeometry(g: GeometrySpec, size: WarpSize): GeometryMesh {
  const { xs, ys } = axesOf(g);
  const cols = xs.length - 1;
  const rows = ys.length - 1;
  const w = Math.max(1, size.width);
  const h = Math.max(1, size.height);
  const p = padOf(g);
  const count = xs.length * ys.length;
  const positions = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  const normals = new Float32Array(count * 3);
  const off = g.topology?.offsets ?? [];
  for (let j = 0; j < ys.length; j++) {
    for (let i = 0; i < xs.length; i++) {
      const k = j * xs.length + i;
      // 未 padding 的归一化位置 u ∈ [0,1]（0 = 图片左边），padding 只影响网格落点
      const u = xs[i];
      const v = ys[j];
      const dx = isNum(off[k * 2]) ? off[k * 2] : 0;
      const dy = isNum(off[k * 2 + 1]) ? off[k * 2 + 1] : 0;
      positions[k * 3] = -w / 2 - p + u * (w + 2 * p) + dx * w;
      positions[k * 3 + 1] = -h / 2 - p + v * (h + 2 * p) + dy * h;
      positions[k * 3 + 2] = 0;
      normals[k * 3 + 2] = 1;
      // UV 跟随「图片坐标」而不是网格坐标：padding 部分落在 [0,1] 之外
      uvs[k * 2] = u + ((2 * u - 1) * p) / w;
      uvs[k * 2 + 1] = 1 - (v + ((2 * v - 1) * p) / h);
    }
  }
  const indices = new Uint32Array(cols * rows * 6);
  const flips = new Set(g.topology?.flips ?? []);
  let w2 = 0;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const a = j * xs.length + i;
      const b = a + 1;
      const c = a + xs.length;
      const d = c + 1;
      // 默认对角线 a-d（与 warp.ts 的 meshGeometry 同绕序）：(a,b,d) + (a,d,c)；
      // 翻转走 b-c：(a,b,c) + (b,d,c)
      const flip = flips.has(j * cols + i);
      indices[w2++] = a;
      indices[w2++] = b;
      indices[w2++] = flip ? c : d;
      indices[w2++] = flip ? b : a;
      indices[w2++] = d;
      indices[w2++] = c;
    }
  }
  return { cols, rows, xs, ys, positions, uvs, normals, indices };
}

/** 部件表：按行把网格切成 `partOrder.length` 个 limb（区间首尾相接、恰好铺满索引表） */
export function partsOf(g: GeometrySpec, mesh: { cols: number; rows: number; xs?: number[]; indices: ArrayLike<number> }): MdlPart[] | null {
  const bands = g.partOrder.length;
  if (!bands) return null;
  // 规则网格（WarpMesh）没有 xs，格数就是 cols；几何网格用 xs.length - 1（两者等价，留 xs 是为了切片后的真实格子）
  const w = mesh.xs ? mesh.xs.length - 1 : mesh.cols;
  if (w < 1 || mesh.rows < 1) return null;
  const out: MdlPart[] = [];
  const rank = new Map<number, number>();
  g.partOrder.forEach((v, i) => rank.set(i, isInt(v) ? v : i));
  let start = 0;
  for (let b = 0; b < bands; b++) {
    const from = Math.floor((mesh.rows * b) / bands);
    const to = Math.floor((mesh.rows * (b + 1)) / bands);
    const size = (to - from) * w * 6;
    out.push({ id: b, offset: rank.get(b) ?? b, start, size });
    start += size;
  }
  return start === mesh.indices.length ? out : null;
}

/** 把部件顺序规范化：长度必须等于 bands，值必须是 0..bands-1 的排列 */
export function cleanPartOrder(order: readonly number[], bands: number): number[] {
  if (!bands) return [];
  const out: number[] = [];
  for (let i = 0; i < bands; i++) out.push(i);
  const used = new Set<number>();
  for (let i = 0; i < bands; i++) {
    const v = order[i];
    if (isInt(v) && v >= 0 && v < bands && !used.has(v)) {
      out[i] = v;
      used.add(v);
    } else {
      // 非法 / 重复项落到还空着的第一个位次，保证结果仍是合法排列
      out[i] = out.findIndex((_, k) => !used.has(k));
      used.add(out[i]);
    }
  }
  return out;
}

// ---------- 纯函数编辑（全部返回新对象，不就地改） ----------

export function withColsRows(g: GeometrySpec, cols: number, rows: number): GeometrySpec {
  return {
    ...g,
    cols: clamp(Math.round(cols), COLS_MIN, COLS_MAX),
    rows: clamp(Math.round(rows), COLS_MIN, COLS_MAX),
    // 格数变了拓扑的下标含义就变了：清掉翻转与偏移（与「改密度后重建骨架」同一取舍）
    topology: { flips: [], offsets: [] },
  };
}

export function withSubdivision(g: GeometrySpec, sub: number): GeometrySpec {
  return { ...g, subdivision: clamp(Math.round(sub), SUBDIV_MIN, SUBDIV_MAX), topology: { flips: [], offsets: [] } };
}

export function withPadding(g: GeometrySpec, padding: number): GeometrySpec {
  return { ...g, padding: clamp(Math.round(padding), PADDING_MIN, PADDING_MAX) };
}

export function withLocked(g: GeometrySpec, locked: boolean): GeometrySpec {
  return { ...g, locked: !!locked };
}

export function withSlices(g: GeometrySpec, axis: "x" | "y", list: readonly number[]): GeometrySpec {
  const clean = cleanSlices(list);
  const next = { ...g, topology: { flips: [], offsets: [] } };
  if (axis === "x") next.sliceX = clean;
  else next.sliceY = clean;
  return next;
}

export function addSlice(g: GeometrySpec, axis: "x" | "y", t: number): GeometrySpec {
  const list = axis === "x" ? g.sliceX : g.sliceY;
  return withSlices(g, axis, [...list, t]);
}

export function removeSlice(g: GeometrySpec, axis: "x" | "y", index: number): GeometrySpec {
  const list = axis === "x" ? g.sliceX : g.sliceY;
  if (!isInt(index) || index < 0 || index >= list.length) return g;
  return withSlices(g, axis, list.filter((_, i) => i !== index));
}

export function withPartOrder(g: GeometrySpec, order: readonly number[]): GeometrySpec {
  return { ...g, partOrder: cleanPartOrder(order, order.length) };
}

/** 部件数：加 / 减 limb 时用（0 = 不写部件表） */
export function withPartBands(g: GeometrySpec, bands: number): GeometrySpec {
  const n = clamp(Math.round(bands), 0, 64);
  return { ...g, partOrder: cleanPartOrder(g.partOrder, n) };
}

export function flipCell(g: GeometrySpec, cell: number): GeometrySpec {
  if (!isInt(cell) || cell < 0) return g;
  const set = new Set(g.topology.flips);
  if (set.has(cell)) set.delete(cell);
  else set.add(cell);
  return { ...g, topology: { ...g.topology, flips: [...set].sort((a, b) => a - b) } };
}

export function withFlips(g: GeometrySpec, flips: readonly number[]): GeometrySpec {
  const set = new Set<number>();
  for (const f of flips) if (isInt(f) && f >= 0) set.add(f);
  return { ...g, topology: { ...g.topology, flips: [...set].sort((a, b) => a - b) } };
}

/** 顶点偏移：归一化（除以图片宽 / 高），幅度上限 ±OFFSET_MAX */
export function setOffset(g: GeometrySpec, vertex: number, dx: number, dy: number): GeometrySpec {
  if (!isInt(vertex) || vertex < 0) return g;
  const steps = vertexCountOf(g);
  if (vertex >= steps) return g;
  const offsets = new Array<number>(steps * 2).fill(0);
  const cur = g.topology.offsets;
  for (let i = 0; i < offsets.length; i++) offsets[i] = isNum(cur[i]) ? cur[i] : 0;
  offsets[vertex * 2] = clamp(dx, -OFFSET_MAX, OFFSET_MAX);
  offsets[vertex * 2 + 1] = clamp(dy, -OFFSET_MAX, OFFSET_MAX);
  return { ...g, topology: { ...g.topology, offsets } };
}

export function withOffsets(g: GeometrySpec, offsets: readonly number[]): GeometrySpec {
  const steps = vertexCountOf(g);
  const out = new Array<number>(steps * 2).fill(0);
  for (let i = 0; i < out.length; i++) if (isNum(offsets[i])) out[i] = clamp(offsets[i], -OFFSET_MAX, OFFSET_MAX);
  return { ...g, topology: { ...g.topology, offsets: out } };
}

/** Edit Topology 复位（翻转 + 偏移都清掉，回到规则网格） */
export function clearTopology(g: GeometrySpec): GeometrySpec {
  return { ...g, topology: { flips: [], offsets: [] } };
}

/** 有没有动过拓扑（UI 显示「复位拓扑」按钮用） */
export function hasTopology(g: GeometrySpec): boolean {
  return (g.topology?.flips?.length ?? 0) > 0 || (g.topology?.offsets?.some((v) => isNum(v) && v !== 0) ?? false);
}

/** 网格顶点的归一化轴坐标（含切片与细分）→ 屏幕无关的 (u,v)：u 从图片左边、v 从图片顶边 */
export function vertexUvOf(g: GeometrySpec, vertex: number): [number, number] | null {
  const { xs, ys } = axesOf(g);
  if (!isInt(vertex) || vertex < 0 || vertex >= xs.length * ys.length) return null;
  const i = vertex % xs.length;
  const j = Math.floor(vertex / xs.length);
  return [xs[i], 1 - ys[j]];
}

// ---------- json 契约（`puppetWarp.geometry`） ----------

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function numList(v: unknown, cap: number): number[] {
  if (!Array.isArray(v)) return [];
  const out: number[] = [];
  for (const x of v) if (isNum(x)) out.push(x);
  return out.slice(0, cap);
}

/** 解析 `puppetWarp.geometry`；坏值一律回落到默认值（不抛 —— 与 parseMeta 同一约定） */
export function parseGeometry(raw: unknown): GeometrySpec | null {
  const o = asObj(raw);
  if (!o) return null;
  const cols = isInt(o.cols) ? clamp(o.cols, COLS_MIN, COLS_MAX) : 2;
  const rows = isInt(o.rows) ? clamp(o.rows, COLS_MIN, COLS_MAX) : 2;
  const topo = asObj(o.topology);
  const flips = numList(topo?.flips, 1e6).filter((f) => isInt(f) && f >= 0);
  const offsets = numList(topo?.offsets, 1e6).map((v) => clamp(v, -OFFSET_MAX, OFFSET_MAX));
  const bands = numList(o.partOrder, 64).length;
  return {
    cols,
    rows,
    subdivision: isInt(o.subdivision) ? clamp(o.subdivision, SUBDIV_MIN, SUBDIV_MAX) : 1,
    sliceX: cleanSlices(numList(o.sliceX, MAX_SLICES)),
    sliceY: cleanSlices(numList(o.sliceY, MAX_SLICES)),
    padding: isNum(o.padding) ? clamp(Math.round(o.padding), PADDING_MIN, PADDING_MAX) : 0,
    locked: o.locked === true,
    topology: { flips: [...new Set(flips)].sort((a, b) => a - b), offsets },
    partOrder: cleanPartOrder(numList(o.partOrder, 64), bands),
  };
}

/** 序列化成 json 片段（只写非默认字段，保持工程 json 干净） */
export function geometryMeta(g: GeometrySpec): Record<string, unknown> {
  const out: Record<string, unknown> = { v: GEOMETRY_VERSION, cols: g.cols, rows: g.rows };
  if (g.subdivision !== 1) out.subdivision = g.subdivision;
  if (g.sliceX.length) out.sliceX = g.sliceX.map(q5);
  if (g.sliceY.length) out.sliceY = g.sliceY.map(q5);
  if (g.padding) out.padding = padOf(g);
  if (g.locked) out.locked = true;
  if (g.topology.flips.length) out.topology = { flips: g.topology.flips };
  if (g.partOrder.length) out.partOrder = g.partOrder;
  return out;
}

/** 从模型 json 读几何（没有 `puppetWarp.geometry` 时 null） */
export function geometryOf(modelJson: unknown): GeometrySpec | null {
  const o = asObj(modelJson);
  const puppet = asObj(o?.[PUPPET_KEY]);
  return parseGeometry(puppet?.geometry);
}

/**
 * 把几何写回模型 json（返回**新对象**；其余键一律原样保留，尤其不动 cropoffset）。
 * `geometry = null` 时清掉 geometry 键；`puppetWarp` 空了就把容器也去掉。
 */
export function withGeometry<T>(modelJson: T, geometry: GeometrySpec | null): T {
  const o = asObj(modelJson);
  if (!o) return modelJson;
  const puppet = { ...(asObj(o[PUPPET_KEY]) ?? {}) };
  if (geometry) puppet.geometry = geometryMeta(geometry);
  else delete puppet.geometry;
  const next: Record<string, unknown> = { ...o };
  if (Object.keys(puppet).length) next[PUPPET_KEY] = puppet;
  else delete next[PUPPET_KEY];
  return next as unknown as T;
}

/** 读 `puppetWarp` 容器里任意子键（warp / limbs / skeleton 等共用） */
export function puppetSub(modelJson: unknown, key: string): unknown {
  return asObj(asObj(modelJson)?.[PUPPET_KEY])?.[key];
}

/** 写 `puppetWarp.<key>`（返回新对象；value = undefined 时删键） */
export function withPuppetSub<T>(modelJson: T, key: string, value: unknown): T {
  const o = asObj(modelJson);
  if (!o) return modelJson;
  const puppet = { ...(asObj(o[PUPPET_KEY]) ?? {}) };
  if (value === undefined || value === null) delete puppet[key];
  else puppet[key] = value;
  const next: Record<string, unknown> = { ...o };
  if (Object.keys(puppet).length) next[PUPPET_KEY] = puppet;
  else delete next[PUPPET_KEY];
  return next as unknown as T;
}
