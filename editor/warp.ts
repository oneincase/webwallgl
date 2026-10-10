// 操控变形（Puppet Warp，伪 Live2D）：把一张图片变成「钉子驱动的骨骼网格」。
//
// 做法：图片切成一格一格的三角网格（几何单位 = 像素，原点在图片中心，Y 向上，UV 左上原点）；
// 每个钉子 = 一根只做平移的骨（骨 0 是根，钉子 i = 骨 i + 1），顶点权重用「反距离加权」（IDW）
// 算出来、每顶点只留最近 4 根（引擎蒙皮上限）。拖动钉子 = 给对应骨一个平移增量，线性混合蒙皮
// 在「纯平移 + 共同父骨不动」时恰好退化成 IDW 插值 ⇒ 拖动即时可见、不必重编码；
// 要落盘时才把增量写进 .mdl 的片段轨道（记录关键帧），或把当前形变烘焙进绑定姿势。
//
// 布局（钉子 / 网格密度 / 衰减）存进 model json 的 warp 键，重开工程能接着调；
// 引擎只认 puppet / material / autosize，多出来的键会被忽略。
//
// 本模块不碰 DOM、引擎与资源表，只做纯计算与文件内容，方便离线单测、真机复用同一份实现。

import { encodeMdl, type MdlPart, type MdlSpec } from "../renderer/src/api/editor";
import { PUPPET_KEY, geometryMeta, type GeometrySpec } from "./geometry";

/** 钉子：归一化坐标，u 从左到右 0..1，v 从**上**到下 0..1（和图片、UV 的读法一致） */
export type WarpPin = readonly [number, number];

/** 一套操控变形骨架的参数（存进 model json 的 warp 键） */
export type WarpLayout = {
  pins: WarpPin[];
  /** 横向格数 */
  cols: number;
  /** 纵向格数 */
  rows: number;
  /** IDW 衰减指数：越大越「局部」，越小越「整片跟着走」 */
  power: number;
};

/** 图片像素尺寸 */
export type WarpSize = { width: number; height: number };

/** 钉子的实时位移（模型空间像素），按下标索引；缺键 = 没动 */
export type PinDeltas = ReadonlyMap<number, readonly [number, number]>;

/**
 * 逐帧的钉子位移（模型空间像素）：poses[f] = 该帧哪些钉子偏了多少，缺帧 / null = 绑定姿势。
 * 重建 .mdl 时原样搬进轨道，这样「加钉子 / 删钉子 / 改衰减 / 改密度 / 烘焙」都不会丢掉
 * 已经记录好的关键帧（页面侧读不出 .mdl 的轨道，只能靠编辑器把当前动画按帧采样回来）。
 */
export type WarpPoses = ReadonlyArray<PinDeltas | null>;

export type WarpMesh = {
  cols: number;
  rows: number;
  positions: Float32Array;
  uvs: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
};

/** 每顶点 4 个骨号 / 权重（boneIdx 是**骨**序号 = 钉子序号 + 1） */
export type WarpSkin = { joints: Uint32Array; weights: Float32Array };

export type WarpRig = {
  layout: WarpLayout;
  size: WarpSize;
  /** 网格材质路径（MdlSpec 里要写） */
  material: string;
  mesh: WarpMesh;
  skin: WarpSkin;
  /** 部件表（Character Sheet 的 limb 顺序）；null = 不写 parts 块 */
  parts: MdlPart[] | null;
  spec: MdlSpec;
};

export type WarpFile = { name: string; data: Uint8Array };

/** model json 里存布局的键 */
export const WARP_KEY = "warp";
export const WARP_VERSION = 1;
/** 钉子数上限（骨 = 钉子 + 1；引擎每骨一份蒙皮矩阵，25 根毫无压力） */
export const MAX_PINS = 24;
/** 网格格数上下限 */
export const MESH_MIN = 2;
export const MESH_MAX = 48;
/** 长边默认格数：32 ⇒ 16:9 大概 33×19 = 627 个顶点 */
export const MESH_BASE = 32;
/** 引擎每顶点最多几根骨 */
export const MAX_INFLUENCES = 4;
export const POWER_MIN = 1;
export const POWER_MAX = 8;
export const DEFAULT_POWER = 4;
/** 默认 3×3 钉子 */
export const DEFAULT_PINS = 3;
/** 钉子坐标的合理范围（烘焙后钉子可能被拖到图片外，但别接受离谱值） */
export const PIN_RANGE = 8;

/** .mdl 里那段形变片段的 id / 名字 / 帧率 / 帧数 */
export const WARP_CLIP_ID = 1;
export const WARP_CLIP_NAME = "warp";
export const WARP_FPS = 30;
export const WARP_FRAMES = 30;

/** 钉子下标 → 骨序号 */
export const boneOfPin = (index: number) => index + 1;
/** 骨序号 → 钉子下标（根骨是 -1） */
export const pinOfBone = (bone: number) => bone - 1;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const round5 = (v: number) => Math.round(v * 1e5) / 1e5;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isInt = (v: unknown): v is number => isNum(v) && Number.isInteger(v);

const translate = (x: number, y: number, z: number) =>
  new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);

const jsonBytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v, null, 2));

/** 钉子（归一化）→ 模型空间像素：原点在图片中心，Y 向上 */
export function pinLocal(pin: WarpPin, size: WarpSize): [number, number] {
  return [(pin[0] - 0.5) * size.width, (0.5 - pin[1]) * size.height];
}

/** 模型空间像素 → 钉子（归一化） */
export function pinNorm(x: number, y: number, size: WarpSize): [number, number] {
  return [x / size.width + 0.5, 0.5 - y / size.height];
}

export function clampPin(pin: WarpPin): WarpPin {
  return [clamp(pin[0], 0, 1), clamp(pin[1], 0, 1)];
}

/** 按长宽比定网格格数：长边 MESH_BASE 格 */
export function gridFor(size: WarpSize): { cols: number; rows: number } {
  const w = Math.max(1, size.width);
  const h = Math.max(1, size.height);
  const m = Math.max(w, h);
  return {
    cols: clamp(Math.round((MESH_BASE * w) / m), MESH_MIN, MESH_MAX),
    rows: clamp(Math.round((MESH_BASE * h) / m), MESH_MIN, MESH_MAX),
  };
}

/** 默认布局：n×n 均布钉子 + 按长宽比的网格 */
export function defaultLayout(size: WarpSize, n: number = DEFAULT_PINS): WarpLayout {
  const k = clamp(Math.round(n), 2, 6);
  const pins: WarpPin[] = [];
  for (let r = 0; r < k; r++) for (let c = 0; c < k; c++) pins.push([c / (k - 1), r / (k - 1)]);
  const { cols, rows } = gridFor(size);
  return { pins, cols, rows, power: DEFAULT_POWER };
}

/**
 * 校验 model json 里的 warp 值：坏数据一律返回 null（旧工程 / 手改坏了都不该让它崩）。
 * 注意钉子允许落在图片外（烘焙、拖出边界都合法），只挡明显坏掉的数。
 */
export function parseMeta(raw: unknown): WarpLayout | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const list = o.pins;
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_PINS) return null;
  const pins: WarpPin[] = [];
  for (const p of list) {
    if (!Array.isArray(p) || p.length < 2) return null;
    const [u, v] = p as unknown[];
    if (!isNum(u) || !isNum(v)) return null;
    if (Math.abs(u) > PIN_RANGE || Math.abs(v) > PIN_RANGE) return null;
    pins.push([u, v]);
  }
  const { cols, rows, power } = o;
  if (!isInt(cols) || cols < MESH_MIN || cols > MESH_MAX) return null;
  if (!isInt(rows) || rows < MESH_MIN || rows > MESH_MAX) return null;
  if (!isNum(power) || power < POWER_MIN || power > POWER_MAX) return null;
  return { pins, cols, rows, power };
}

/** 布局 → 写进 model json 的 warp 值 */
export function metaOf(layout: WarpLayout): Record<string, unknown> {
  return {
    v: WARP_VERSION,
    pins: layout.pins.map((p) => [round5(p[0]), round5(p[1])]),
    cols: layout.cols,
    rows: layout.rows,
    power: round5(layout.power),
  };
}

export function movePin(layout: WarpLayout, index: number, pin: WarpPin): WarpLayout {
  if (index < 0 || index >= layout.pins.length) return layout;
  const next = layout.pins.slice();
  next[index] = [pin[0], pin[1]];
  return { ...layout, pins: next };
}

export function addPin(layout: WarpLayout, pin: WarpPin): WarpLayout | null {
  if (layout.pins.length >= MAX_PINS) return null;
  return { ...layout, pins: [...layout.pins, [pin[0], pin[1]]] };
}

export function removePin(layout: WarpLayout, index: number): WarpLayout | null {
  if (layout.pins.length <= 1 || index < 0 || index >= layout.pins.length) return null;
  return { ...layout, pins: layout.pins.filter((_, i) => i !== index) };
}

export function withGrid(layout: WarpLayout, cols: number, rows: number): WarpLayout {
  return {
    ...layout,
    cols: clamp(Math.round(cols), MESH_MIN, MESH_MAX),
    rows: clamp(Math.round(rows), MESH_MIN, MESH_MAX),
  };
}

export function withPower(layout: WarpLayout, power: number): WarpLayout {
  return { ...layout, power: clamp(power, POWER_MIN, POWER_MAX) };
}

/**
 * 几何工程写盘时用的 v1 布局：`warp.cols/rows` 是**钉子网格**，schema 上限 MESH_MAX（48）；
 * 几何的真实密度（cols×subdivision，最大 64×8）只写在 `puppetWarp.geometry` 里。
 * 把细分后的格数塞进 warp 会让 parseMeta 拒收**整个布局**（钉子全丢、重开后操控变形分组消失），
 * 所以这里按老 schema 夹住；网格本身由调用方传进 .mdl，不受影响。
 */
export function withLegacyGrid(layout: WarpLayout, geometry: GeometrySpec | null): WarpLayout {
  if (!geometry) return layout;
  return withGrid(layout, geometry.cols, geometry.rows);
}

/**
 * 把「在 from 布局上采样到的关键帧姿势」搬到 to 布局：按钉子的归一化坐标配对
 * （加钉只是往后追加、删钉会让后面的钉子序号左移，姿势必须跟着钉子的**位置**走而不是序号）。
 * 新加的钉没有姿势（留空 = 绑定姿势），被删掉的钉的姿势丢弃。
 */
export function remapPoses(poses: WarpPoses, from: WarpLayout, to: WarpLayout): WarpPoses {
  if (from.pins === to.pins) return poses;
  const moved = from.pins.map((p) => to.pins.findIndex((q) => q[0] === p[0] && q[1] === p[1]));
  return poses.map((frame) => {
    if (!frame || !frame.size) return frame ?? null;
    const out = new Map<number, readonly [number, number]>();
    for (const [pin, d] of frame) {
      const next = moved[pin];
      if (next !== undefined && next >= 0) out.set(next, d);
    }
    return out.size ? out : null;
  });
}

/** 规则三角网格的几何（不含钉子/衰减 —— 它们只影响权重）：x 左→右、y 下→上（j = 0 是底边），UV 的 v 向下 */
function meshGeometry(cols: number, rows: number, size: WarpSize): WarpMesh {
  const count = (cols + 1) * (rows + 1);
  const positions = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  const normals = new Float32Array(count * 3);
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= cols; i++) {
      const k = j * (cols + 1) + i;
      positions[k * 3] = (i / cols - 0.5) * size.width;
      positions[k * 3 + 1] = (j / rows - 0.5) * size.height;
      positions[k * 3 + 2] = 0;
      normals[k * 3 + 2] = 1;
      uvs[k * 2] = i / cols;
      uvs[k * 2 + 1] = 1 - j / rows;
    }
  }
  const indices = new Uint32Array(cols * rows * 6);
  let w = 0;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const a = j * (cols + 1) + i;
      const b = a + 1;
      const c = a + cols + 1;
      const d = c + 1;
      // 绕序与「图片 → 摆动木偶」生成器一致（Y 向上时正面朝 +Z）
      indices[w++] = a;
      indices[w++] = b;
      indices[w++] = d;
      indices[w++] = a;
      indices[w++] = d;
      indices[w++] = c;
    }
  }
  return { cols, rows, positions, uvs, normals, indices };
}

/** 三角网格：x 从左到右、y 从下到上，j = 0 是底边；UV 的 v 向下（v = 0 在图片顶边） */
export function buildMesh(layout: WarpLayout, size: WarpSize): WarpMesh {
  return meshGeometry(layout.cols, layout.rows, size);
}

/**
 * 规则网格位置（由 uv 反推 —— uv 不受烘焙影响，所以烘焙过的网格也能拿到自己的规则参照）
 * 与顶点位置之差 = 顶点偏移；重采样搬的就是它。
 */
function offsetsOf(mesh: WarpMesh, size: WarpSize): Float32Array {
  const count = mesh.positions.length / 3;
  const off = new Float32Array(count * 2);
  for (let v = 0; v < count; v++) {
    off[v * 2] = mesh.positions[v * 3] - (mesh.uvs[v * 2] - 0.5) * size.width;
    off[v * 2 + 1] = mesh.positions[v * 3 + 1] - (0.5 - mesh.uvs[v * 2 + 1]) * size.height;
  }
  return off;
}

/**
 * 把顶点偏移（相对规则网格）双线性重采样到新密度的网格上 —— 「重建骨架」用：
 * 已经烘焙进顶点的形变必须跟着搬到新网格，否则改一次网格密度就把形变抹平。
 * 没有形变时偏移恒 0 ⇒ 结果逐位等于新规则网格（所以无条件重采样也安全）。
 */
export function resamplePositions(src: WarpMesh, cols: number, rows: number, size: WarpSize): Float32Array {
  const next = meshGeometry(cols, rows, size);
  const off = offsetsOf(src, size);
  const sc = src.cols;
  const sr = src.rows;
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= cols; i++) {
      const k = j * (cols + 1) + i;
      const sx = (i / cols) * sc;
      const sy = (j / rows) * sr;
      const ci = Math.min(Math.floor(sx), Math.max(0, sc - 1));
      const rj = Math.min(Math.floor(sy), Math.max(0, sr - 1));
      const tx = sx - ci;
      const ty = sy - rj;
      const a = rj * (sc + 1) + ci;
      const b = a + 1;
      const c = a + sc + 1;
      const d = c + 1;
      const wa = (1 - tx) * (1 - ty);
      const wb = tx * (1 - ty);
      const wc = (1 - tx) * ty;
      const wd = tx * ty;
      next.positions[k * 3] += wa * off[a * 2] + wb * off[b * 2] + wc * off[c * 2] + wd * off[d * 2];
      next.positions[k * 3 + 1] += wa * off[a * 2 + 1] + wb * off[b * 2 + 1] + wc * off[c * 2 + 1] + wd * off[d * 2 + 1];
    }
  }
  return next.positions;
}

/**
 * 一个点的骨影响：反距离加权（IDW），w = (最近距离 / 本距离)^power，取权重最大的 4 根后归一。
 * 用「除以最近距离」而不是直接 d^-power，是为了避免 power 大时权重溢出成 Infinity；
 * 归一化会约掉这个公共因子，结果与 d^-power 完全一致。
 */
export function influenceAt(
  x: number,
  y: number,
  pins: ReadonlyArray<readonly [number, number]>,
  power: number,
  eps: number,
): { joint: number[]; weight: number[] } {
  const n = pins.length;
  const dist: number[] = new Array(n);
  let dmin = Infinity;
  for (let i = 0; i < n; i++) {
    const d = Math.hypot(x - pins[i][0], y - pins[i][1]) + eps;
    dist[i] = d;
    if (d < dmin) dmin = d;
  }
  const weight: number[] = new Array(n);
  const order: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    weight[i] = Number.isFinite(dist[i]) && dist[i] > 0 ? Math.pow(dmin / dist[i], power) : 0;
    order[i] = i;
  }
  order.sort((a, b) => weight[b] - weight[a] || a - b);
  const joint = [0, 0, 0, 0];
  const out = [0, 0, 0, 0];
  let sum = 0;
  const take = Math.min(MAX_INFLUENCES, n);
  for (let k = 0; k < take; k++) sum += weight[order[k]];
  if (!Number.isFinite(sum) || sum <= 0) {
    // 退化（坐标是 NaN / 钉子全在无穷远）：用最近的几根等权，绝不塌陷到原点
    for (let k = 0; k < take; k++) {
      joint[k] = order[k];
      out[k] = 1 / take;
    }
    return { joint, weight: out };
  }
  for (let k = 0; k < take; k++) {
    joint[k] = order[k];
    out[k] = weight[order[k]] / sum;
  }
  return { joint, weight: out };
}

/** 每顶点算一次权重（骨号 = 钉子下标 + 1）；顶点落在钉子上时该骨权重为 1 */
export function buildSkin(mesh: WarpMesh, layout: WarpLayout, size: WarpSize): WarpSkin {
  const pins = layout.pins.map((p) => pinLocal(p, size));
  const count = mesh.positions.length / 3;
  const joints = new Uint32Array(count * MAX_INFLUENCES);
  const weights = new Float32Array(count * MAX_INFLUENCES);
  const eps = Math.max(1e-3, Math.min(size.width, size.height) * 1e-3);
  for (let v = 0; v < count; v++) {
    const hit = influenceAt(
      mesh.positions[v * 3],
      mesh.positions[v * 3 + 1],
      pins,
      layout.power,
      eps,
    );
    for (let k = 0; k < MAX_INFLUENCES; k++) {
      joints[v * MAX_INFLUENCES + k] = boneOfPin(hit.joint[k]);
      weights[v * MAX_INFLUENCES + k] = hit.weight[k];
    }
  }
  return { joints, weights };
}

/**
 * 钉子位移作用到顶点：纯平移骨 + 共同父骨不动时，线性混合蒙皮 = 加权和，
 * 所以位移就是 Σ w·Δ（没动的钉子按其权重贡献 0）。
 */
export function displace(mesh: WarpMesh, skin: WarpSkin, deltas: PinDeltas): Float32Array {
  const out = new Float32Array(mesh.positions);
  if (deltas.size === 0) return out;
  const count = mesh.positions.length / 3;
  for (let v = 0; v < count; v++) {
    let dx = 0;
    let dy = 0;
    for (let k = 0; k < MAX_INFLUENCES; k++) {
      const w = skin.weights[v * MAX_INFLUENCES + k];
      if (!w) continue;
      const d = deltas.get(pinOfBone(skin.joints[v * MAX_INFLUENCES + k]));
      if (!d) continue;
      dx += w * d[0];
      dy += w * d[1];
    }
    out[v * 3] += dx;
    out[v * 3 + 1] += dy;
  }
  return out;
}

function specOf(
  layout: WarpLayout,
  size: WarpSize,
  material: string,
  mesh: WarpMesh,
  skin: WarpSkin,
  poses?: WarpPoses,
  parts?: MdlPart[] | null,
): MdlSpec {
  const pins = layout.pins.map((p) => pinLocal(p, size));
  const bones: NonNullable<MdlSpec["bones"]> = [
    { name: "root", parent: -1, matrix: translate(0, 0, 0) },
    ...pins.map((p, i) => ({ name: `pin${i + 1}`, parent: 0, matrix: translate(p[0], p[1], 0) })),
  ];
  // 每骨一条 9 分量 × (帧数 + 1) 的轨道：「记录关键帧」再往里写增量。
  // 常量帧必须写**绑定姿势**（平移 + 欧拉角 + 缩放，见 mdl-skin.js 的 sampleTrackTRS），
  // 不能写全零：引擎对非加算动画层按 mix(base, sample, blend) 取姿势，全零的
  // scale(0,0,0) 会把整只木偶塌到骨原点。真实 WE 片段的第 0 帧也正好等于绑定姿势。
  const tracks = bones.map((b, i) => {
    const track = new Float32Array(9 * (WARP_FRAMES + 1));
    const m = b.matrix as number[];
    for (let f = 0; f <= WARP_FRAMES; f++) {
      const o = f * 9;
      // 该帧这根钉子的记录位移（模型空间平移）叠在绑定姿势上；缺帧 = 绑定姿势。
      const d = i > 0 ? poses?.[f]?.get(pinOfBone(i)) : undefined;
      track[o] = m[12] + (d ? d[0] : 0);
      track[o + 1] = m[13] + (d ? d[1] : 0);
      track[o + 2] = m[14];
      track[o + 6] = 1;
      track[o + 7] = 1;
      track[o + 8] = 1;
    }
    return track;
  });
  return {
    meshes: [
      {
        material,
        positions: mesh.positions,
        uvs: mesh.uvs,
        normals: mesh.normals,
        indices: mesh.indices,
        boneIdx: skin.joints,
        weights: skin.weights,
        ...(parts && parts.length ? { parts } : {}),
      },
    ],
    bones,
    animations: [
      {
        id: WARP_CLIP_ID,
        name: WARP_CLIP_NAME,
        mode: "loop",
        fps: WARP_FPS,
        frameCount: WARP_FRAMES,
        tracks,
      },
    ],
  };
}

/**
 * 用布局 + 图片尺寸搭一套骨架（positions 传入时用它当绑定姿势，烘焙用；poses 传入时写进轨道）。
 * `opts.mesh` 传入时用它当网格（P1 的 Geometry：细分 / 切片 / Padding / Edit Topology 出来的
 * 顶点与索引都带上），`opts.parts` 是 Character Sheet 的 limb 部件表 ⇒ 一起写进 .mdl。
 */
export function buildRig(
  layout: WarpLayout,
  size: WarpSize,
  material: string,
  positions?: Float32Array,
  poses?: WarpPoses,
  opts?: { mesh?: WarpMesh; parts?: MdlPart[] | null },
): WarpRig {
  const base = opts?.mesh ?? buildMesh(layout, size);
  const mesh: WarpMesh = positions ? { ...base, positions } : base;
  const skin = buildSkin(mesh, layout, size);
  const parts = opts?.parts ?? null;
  return {
    layout,
    size,
    material,
    mesh,
    skin,
    parts,
    spec: specOf(layout, size, material, mesh, skin, poses, parts),
  };
}

/**
 * 烘焙：把当前钉子的形变吃进绑定姿势 —— 顶点按位移挪过去、增量归零。
 * **骨架（钉子位置）不动**：钉子留在网格原位，形变记在顶点里，这样零增量渲染出来的
 * 就是刚才看到的样子（画面逐像素不变），而骨架/权重还继续可调（下一次烘焙在顶点上叠加）。
 * poses 是已记录的关键帧，照原样带走（烘焙只吃预览位移，不动轨道）。
 */
export function bakeRig(rig: WarpRig, deltas: PinDeltas, poses?: WarpPoses): WarpRig | null {
  if (deltas.size === 0) return null;
  // 网格（含 Geometry 的细分 / Padding / 拓扑）与部件表原样带走，只把位移吃进顶点
  return buildRig(rig.layout, rig.size, rig.material, displace(rig.mesh, rig.skin, deltas), poses, {
    mesh: rig.mesh,
    parts: rig.parts,
  });
}

/**
 * 新材质：克隆源材质（图片层那张材质），只把 shader 换成 puppet 的 genericimage4。
 * 贴图路径原样沿用 ⇒ 同一份贴图文件被两个模型共用（promote 时用 assets.share 把归属带过去）。
 * 源材质缺失时退回「图片层口径」的材质：depthtest / depthwrite 关掉，和原图片层合成方式一致。
 */
export function warpMaterial(src?: Record<string, unknown> | null): Record<string, unknown> {
  const passes = (src as { passes?: unknown } | null | undefined)?.passes;
  // `defaultlight: false`：这是从一张图片层转来的**平贴 2D 木偶**，必须逐像素等于源图。
  // 宿主对 models|materials/editor/ 命名空间的网格会自动回落一盏默认主光（伪 Live2D 的
  // 平贴图会被它平白照亮 1.08 倍），显式关掉才与 WE 的口径一致（WE 不开 LIGHTING 的材质
  // 就是纯 albedo）。语义与 editor/gltf.ts 导入 3D 网格时写的 `defaultlight: true` 相反。
  if (Array.isArray(passes) && passes.length && passes[0] && typeof passes[0] === "object") {
    const first = { ...(passes[0] as Record<string, unknown>), shader: "genericimage4", defaultlight: false };
    return { ...(src as Record<string, unknown>), passes: [first, ...passes.slice(1)] };
  }
  return {
    passes: [
      {
        defaultlight: false,
        blending: "translucent",
        cullmode: "nocull",
        depthtest: "disabled",
        depthwrite: "disabled",
        shader: "genericimage4",
        textures: [],
      },
    ],
  };
}

/**
 * 一个操控变形木偶的全套工程文件（模型 .mdl / 材质 json / 模型 json）。
 * 模型 json 里 width / height 沿用图片尺寸，autosize 开着 ⇒ 图层尺寸与原来那张图一致。
 */
export function warpFiles(
  rig: WarpRig,
  slug: string,
  srcMaterial?: Record<string, unknown> | null,
  opts?: { geometry?: GeometrySpec | null; limbs?: Record<string, unknown> | null },
): WarpFile[] {
  const mdlPath = `models/editor/${slug}.mdl`;
  const materialPath = `materials/editor/${slug}.json`;
  const modelPath = `models/editor/${slug}.json`;
  const warpMeta = metaOf(rig.layout);
  const puppet: Record<string, unknown> = { [WARP_KEY]: warpMeta };
  if (opts?.geometry) puppet.geometry = geometryMeta(opts.geometry);
  if (opts?.limbs) puppet.limbs = opts.limbs;
  const model = {
    autosize: true,
    width: rig.size.width,
    height: rig.size.height,
    material: materialPath,
    puppet: mdlPath,
    // v2 契约：创作态收进 `puppetWarp` 容器（geometry / limbs 与 warp 并列）
    [PUPPET_KEY]: puppet,
    // v1 兼容镜像：老工程（和只看顶层 `warp` 的旧读法）仍能读回布局
    [WARP_KEY]: warpMeta,
  };
  return [
    { name: mdlPath, data: encodeMdl(rig.spec) },
    { name: materialPath, data: jsonBytes(warpMaterial(srcMaterial)) },
    { name: modelPath, data: jsonBytes(model) },
  ];
}

/** 从模型 json 里读布局（先看 v2 的 `puppetWarp.warp`，再回落到 v1 顶层 `warp`；没有 / 坏了返回 null） */
export function layoutOf(modelJson: unknown): WarpLayout | null {
  if (!modelJson || typeof modelJson !== "object") return null;
  const o = modelJson as Record<string, unknown>;
  const puppet = o[PUPPET_KEY];
  const fromPuppet =
    puppet && typeof puppet === "object" && !Array.isArray(puppet)
      ? parseMeta((puppet as Record<string, unknown>)[WARP_KEY])
      : null;
  return fromPuppet ?? parseMeta(o[WARP_KEY]);
}

/** 屏幕坐标命中：返回离 (x, y) 最近且在 tol 内的钉子下标，没有则 -1 */
export function nearestPin(
  points: ReadonlyArray<readonly [number, number] | null>,
  x: number,
  y: number,
  tol: number,
): number {
  let hit = -1;
  let best = tol;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!p) continue;
    const d = Math.hypot(p[0] - x, p[1] - y);
    if (d <= best) {
      best = d;
      hit = i;
    }
  }
  return hit;
}
