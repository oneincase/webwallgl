// glTF 导入（EDITOR-PLAN §3B W19）：自写最小解析器（零依赖）+ 转成 W17 编码器的输入。
// 只认 glTF 2.0 的 .glb / .gltf（内嵌 data URI 或同目录外部文件），TRIANGLES，
// POSITION / NORMAL / TANGENT / TEXCOORD_0 / JOINTS_n / WEIGHTS_n、稀疏访问器、节点层级、skin、
// 动画（LINEAR / STEP / CUBICSPLINE）、baseColorTexture（png / jpg）。
//
// 骨骼口径：被 skin 引用的关节、挂网格的节点、以及它们的全部祖先 → MDLS 骨列表（先序，父在前）。
// 绑定世界矩阵：关节取 inverseBindMatrices 的逆，其余取节点静止世界矩阵；MDLS 局部矩阵 =
// 父绑定世界⁻¹ · 自身绑定世界，引擎沿父链累乘回来就是同一份绑定世界。于是：
//   蒙皮网格的顶点原样写入（glTF 蒙皮顶点本就在绑定空间），引擎蒙皮 = World(anim) · IBM · v，与 glTF 同式；
//   非蒙皮网格的顶点按所在节点的绑定世界矩阵烘焙，权重 1 挂到该节点的骨上。
// 动画：每个 glTF animation → 一个片段，按 fps 稠密采样，每骨一轨；四元数转引擎的 ZYX 欧拉角
// （composeTRS：R = Rz·Ry·Rx），相邻帧取最近解保证连续。
// puppet 与网格同为 Y 向上、UV 原点在左上，坐标只需整体乘 scale（平移分量随之缩放，旋转 / 缩放分量不变）。

import { encodeMdl, type MdlSpec } from "../renderer/src/api/editor";
import { modelPathOf } from "./create";
import { rebuildTree, type EditorDoc, type SceneObject } from "./doc";
import { addAnimLayer } from "./model";

type J = Record<string, any>;

export class GltfError extends Error {
  constructor(
    readonly code: "format" | "version" | "extension" | "buffer" | "accessor" | "noMesh" | "encode",
    readonly detail = "",
  ) {
    super(`${code}${detail ? `: ${detail}` : ""}`);
  }
}

export type Gltf = { json: J; buffers: Uint8Array[]; resolve: (uri: string) => Uint8Array | null };
export type GltfWarning = { code: string; detail?: string };

/** 能忽略的必需扩展（只影响观感、不改几何读法）；其余必需扩展（Draco / meshopt / KTX2…）一律拒绝 */
const TOLERATED_REQUIRED = new Set(["KHR_mesh_quantization", "KHR_materials_unlit", "KHR_texture_transform", "KHR_materials_emissive_strength"]);
const dec = new TextDecoder();
const enc = new TextEncoder();

function base64Bytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function uriBytes(uri: string, resolve: Gltf["resolve"]): Uint8Array | null {
  const m = /^data:[^,]*?(;base64)?,(.*)$/s.exec(uri);
  if (m) return m[1] ? base64Bytes(m[2]) : enc.encode(decodeURIComponent(m[2]));
  let name = uri;
  try {
    name = decodeURIComponent(uri);
  } catch {
    /* 非法转义按原串找 */
  }
  return resolve(name) ?? resolve(name.split("/").pop()!);
}

/**
 * 解析 .glb / .gltf 字节。resolve：外部文件（.bin / 贴图）按 URI 取字节，找不到给 null。
 * 不是 glTF 2.0、带不支持的必需扩展、缓冲缺失时抛 GltfError。
 */
export function parseGltf(bytes: Uint8Array, resolve: Gltf["resolve"] = () => null): Gltf {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let json: J;
  let bin: Uint8Array | null = null;
  if (bytes.length >= 12 && dv.getUint32(0, true) === 0x46546c67) {
    if (dv.getUint32(4, true) !== 2) throw new GltfError("version", String(dv.getUint32(4, true)));
    const total = Math.min(dv.getUint32(8, true), bytes.length);
    let p = 12;
    let text: string | null = null;
    while (p + 8 <= total) {
      const len = dv.getUint32(p, true);
      const type = dv.getUint32(p + 4, true);
      const body = bytes.subarray(p + 8, p + 8 + len);
      if (body.length !== len) throw new GltfError("format", "chunk");
      if (type === 0x4e4f534a && text === null) text = dec.decode(body);
      else if (type === 0x004e4942 && !bin) bin = body;
      p += 8 + len + ((4 - (len % 4)) % 4);
    }
    if (text === null) throw new GltfError("format", "json chunk");
    try {
      json = JSON.parse(text);
    } catch {
      throw new GltfError("format", "json");
    }
  } else {
    try {
      json = JSON.parse(dec.decode(bytes).replace(/^\uFEFF/, ""));
    } catch {
      throw new GltfError("format");
    }
  }
  if (!json || typeof json !== "object" || !json.asset) throw new GltfError("format", "asset");
  if (!/^2(\.|$)/.test(String(json.asset.version ?? ""))) throw new GltfError("version", String(json.asset.version));
  const bad = ((json.extensionsRequired ?? []) as string[]).filter((e) => !TOLERATED_REQUIRED.has(e));
  if (bad.length) throw new GltfError("extension", bad.join(", "));
  const buffers = ((json.buffers ?? []) as J[]).map((b, i) => {
    const data = b.uri === undefined ? (i === 0 ? bin : null) : uriBytes(String(b.uri), resolve);
    if (!data) throw new GltfError("buffer", b.uri ?? `#${i}`);
    if (data.length < (b.byteLength ?? 0)) throw new GltfError("buffer", `${b.uri ?? `#${i}`} < ${b.byteLength}`);
    return data;
  });
  return { json, buffers, resolve };
}

// ---------- 访问器 ----------

const TYPE_SIZE: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const COMP_BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

function readComp(dv: DataView, off: number, ct: number, norm: boolean): number {
  switch (ct) {
    case 5120: {
      const v = dv.getInt8(off);
      return norm ? Math.max(v / 127, -1) : v;
    }
    case 5121: {
      const v = dv.getUint8(off);
      return norm ? v / 255 : v;
    }
    case 5122: {
      const v = dv.getInt16(off, true);
      return norm ? Math.max(v / 32767, -1) : v;
    }
    case 5123: {
      const v = dv.getUint16(off, true);
      return norm ? v / 65535 : v;
    }
    case 5125:
      return dv.getUint32(off, true);
    case 5126:
      return dv.getFloat32(off, true);
  }
  throw new GltfError("accessor", `componentType ${ct}`);
}

function viewOf(g: Gltf, viewIdx: number): { dv: DataView; stride: number; length: number } {
  const v = g.json.bufferViews?.[viewIdx];
  const buf = v && g.buffers[v.buffer];
  if (!v || !buf) throw new GltfError("accessor", `bufferView ${viewIdx}`);
  const off = v.byteOffset ?? 0;
  if (off + v.byteLength > buf.length) throw new GltfError("accessor", `bufferView ${viewIdx} 越界`);
  return { dv: new DataView(buf.buffer, buf.byteOffset + off, v.byteLength), stride: v.byteStride ?? 0, length: v.byteLength };
}

/** 访问器读成 f64 扁平数组（normalized 已归一，稀疏已覆盖）；size = 每元素分量数 */
export function readAccessor(g: Gltf, idx: number): { data: Float64Array; count: number; size: number } {
  const a = g.json.accessors?.[idx];
  if (!a) throw new GltfError("accessor", `#${idx}`);
  const size = TYPE_SIZE[a.type];
  const cb = COMP_BYTES[a.componentType];
  const count = a.count;
  if (!size || !cb || !(Number.isInteger(count) && count >= 0)) throw new GltfError("accessor", `#${idx}`);
  const norm = !!a.normalized;
  const data = new Float64Array(count * size);
  if (a.bufferView !== undefined) {
    const { dv, stride, length } = viewOf(g, a.bufferView);
    const step = stride || size * cb;
    const base = a.byteOffset ?? 0;
    if (count > 0 && base + (count - 1) * step + size * cb > length) throw new GltfError("accessor", `#${idx} 越界`);
    for (let i = 0; i < count; i++) {
      for (let k = 0; k < size; k++) data[i * size + k] = readComp(dv, base + i * step + k * cb, a.componentType, norm);
    }
  }
  const sp = a.sparse;
  if (sp && sp.count > 0) {
    const iv = viewOf(g, sp.indices.bufferView);
    const vv = viewOf(g, sp.values.bufferView);
    const icb = COMP_BYTES[sp.indices.componentType];
    for (let j = 0; j < sp.count; j++) {
      const at = readComp(iv.dv, (sp.indices.byteOffset ?? 0) + j * icb, sp.indices.componentType, false);
      if (!(at >= 0 && at < count)) throw new GltfError("accessor", `#${idx} sparse`);
      for (let k = 0; k < size; k++) data[at * size + k] = readComp(vv.dv, (sp.values.byteOffset ?? 0) + (j * size + k) * cb, a.componentType, norm);
    }
  }
  return { data, count, size };
}

// ---------- 矩阵 / 四元数（列主序，f64） ----------

type M4 = Float64Array;
type Quat = [number, number, number, number];
type V3 = [number, number, number];

const ident = (): M4 => Float64Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);

export function mul(a: ArrayLike<number>, b: ArrayLike<number>): M4 {
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  }
  return o;
}

export function invert(m: ArrayLike<number>): M4 | null {
  const a = Array.from(m);
  const inv = Array.from(ident());
  for (let c = 0; c < 4; c++) {
    let piv = c;
    for (let r = c + 1; r < 4; r++) if (Math.abs(a[c * 4 + r]) > Math.abs(a[c * 4 + piv])) piv = r;
    if (Math.abs(a[c * 4 + piv]) < 1e-12) return null;
    if (piv !== c) {
      for (let k = 0; k < 4; k++) {
        [a[k * 4 + c], a[k * 4 + piv]] = [a[k * 4 + piv], a[k * 4 + c]];
        [inv[k * 4 + c], inv[k * 4 + piv]] = [inv[k * 4 + piv], inv[k * 4 + c]];
      }
    }
    const d = a[c * 4 + c];
    for (let k = 0; k < 4; k++) {
      a[k * 4 + c] /= d;
      inv[k * 4 + c] /= d;
    }
    for (let r = 0; r < 4; r++) {
      if (r === c) continue;
      const f = a[c * 4 + r];
      if (!f) continue;
      for (let k = 0; k < 4; k++) {
        a[k * 4 + r] -= f * a[k * 4 + c];
        inv[k * 4 + r] -= f * inv[k * 4 + c];
      }
    }
  }
  return Float64Array.from(inv);
}

export function composeTRSQ(t: V3, q: Quat, s: V3): M4 {
  const [x, y, z, w] = q;
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  return Float64Array.of(
    (1 - 2 * (yy + zz)) * s[0], 2 * (xy + wz) * s[0], 2 * (xz - wy) * s[0], 0,
    2 * (xy - wz) * s[1], (1 - 2 * (xx + zz)) * s[1], 2 * (yz + wx) * s[1], 0,
    2 * (xz + wy) * s[2], 2 * (yz - wx) * s[2], (1 - 2 * (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1,
  );
}

/** 无剪切的仿射矩阵拆回 T / R(四元数) / S；行列式为负时把翻转记在 x 缩放上 */
function decompose(m: ArrayLike<number>): { t: V3; r: Quat; s: V3 } {
  let sx = Math.hypot(m[0], m[1], m[2]);
  const sy = Math.hypot(m[4], m[5], m[6]);
  const sz = Math.hypot(m[8], m[9], m[10]);
  const det = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
  if (det < 0) sx = -sx;
  const r = [m[0] / (sx || 1), m[1] / (sx || 1), m[2] / (sx || 1), m[4] / (sy || 1), m[5] / (sy || 1), m[6] / (sy || 1), m[8] / (sz || 1), m[9] / (sz || 1), m[10] / (sz || 1)];
  const [m00, m10, m20, m01, m11, m21, m02, m12, m22] = r;
  const tr = m00 + m11 + m22;
  let q: Quat;
  if (tr > 0) {
    const S = Math.sqrt(tr + 1) * 2;
    q = [(m21 - m12) / S, (m02 - m20) / S, (m10 - m01) / S, 0.25 * S];
  } else if (m00 > m11 && m00 > m22) {
    const S = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [0.25 * S, (m01 + m10) / S, (m02 + m20) / S, (m21 - m12) / S];
  } else if (m11 > m22) {
    const S = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(m01 + m10) / S, 0.25 * S, (m12 + m21) / S, (m02 - m20) / S];
  } else {
    const S = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(m02 + m20) / S, (m12 + m21) / S, 0.25 * S, (m10 - m01) / S];
  }
  return { t: [m[12], m[13], m[14]], r: normQ(q), s: [sx || 1, sy || 1, sz || 1] };
}

function normQ(q: number[]): Quat {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

function slerp(a: ArrayLike<number>, b: ArrayLike<number>, t: number): Quat {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const bb = [b[0], b[1], b[2], b[3]];
  if (d < 0) {
    d = -d;
    for (let k = 0; k < 4; k++) bb[k] = -bb[k];
  }
  if (d > 0.9995) return normQ([0, 1, 2, 3].map((k) => a[k] + (bb[k] - a[k]) * t));
  const th = Math.acos(Math.min(1, d));
  const s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s;
  const wb = Math.sin(t * th) / s;
  return normQ([0, 1, 2, 3].map((k) => a[k] * wa + bb[k] * wb));
}

const wrapNear = (v: number, ref: number) => v + 2 * Math.PI * Math.round((ref - v) / (2 * Math.PI));

/**
 * 四元数 → 引擎欧拉角（composeTRS 的 R = Rz·Ry·Rx，弧度）。prev 给了就在两组等价解里取离它最近的、
 * 各分量就近 2π 展开（万向节奇点处 rz 沿用 prev，只解 rx）。
 */
export function quatToEuler(q: Quat, prev?: V3): V3 {
  const [x, y, z, w] = q;
  const r00 = 1 - 2 * (y * y + z * z);
  const r10 = 2 * (x * y + w * z);
  const r20 = 2 * (x * z - w * y);
  const r21 = 2 * (y * z + w * x);
  const r22 = 1 - 2 * (x * x + y * y);
  const r01 = 2 * (x * y - w * z);
  const r11 = 1 - 2 * (x * x + z * z);
  const sy = Math.max(-1, Math.min(1, -r20));
  const ry = Math.asin(sy);
  let cands: V3[];
  if (Math.sqrt(r21 * r21 + r22 * r22) > 1e-6) {
    const rx = Math.atan2(r21, r22);
    const rz = Math.atan2(r10, r00);
    cands = [
      [rx, ry, rz],
      [rx + Math.PI, Math.PI - ry, rz + Math.PI],
    ];
  } else {
    const rz = prev ? prev[2] : 0;
    // sy = +1：r01 = sin(rx − rz)、r11 = cos(rx − rz)；sy = −1：r01 = −sin(rx + rz)、r11 = cos(rx + rz)
    const rx = sy > 0 ? Math.atan2(r01, r11) + rz : Math.atan2(-r01, r11) - rz;
    cands = [[rx, sy > 0 ? Math.PI / 2 : -Math.PI / 2, rz]];
  }
  if (!prev) return cands[0].map((v) => Math.atan2(Math.sin(v), Math.cos(v))) as V3;
  let best = cands[0];
  let bd = Infinity;
  for (const c of cands) {
    const u = c.map((v, k) => wrapNear(v, prev[k])) as V3;
    const d = u.reduce((s, v, k) => s + (v - prev[k]) ** 2, 0);
    if (d < bd) {
      bd = d;
      best = u;
    }
  }
  return best;
}

// ---------- 节点 / 动画求值 ----------

type NodeTRS = { t: V3; r: Quat; s: V3 };

function restTRS(n: J): NodeTRS {
  if (Array.isArray(n.matrix) && n.matrix.length === 16) return decompose(n.matrix);
  return {
    t: (n.translation ?? [0, 0, 0]).slice(0, 3) as V3,
    r: normQ(n.rotation ?? [0, 0, 0, 1]),
    s: (n.scale ?? [1, 1, 1]).slice(0, 3) as V3,
  };
}

function restLocal(n: J): M4 {
  if (Array.isArray(n.matrix) && n.matrix.length === 16) return Float64Array.from(n.matrix);
  const r = restTRS(n);
  return composeTRSQ(r.t, r.r, r.s);
}

type Sampler = { times: Float64Array; values: Float64Array; size: number; interp: string };

/** 在 t 秒处求采样器（越界钳到首末关键帧；四元数结果归一） */
export function sampleAt(s: Sampler, t: number, quat: boolean): number[] {
  const n = s.times.length;
  const cubic = s.interp === "CUBICSPLINE";
  const val = (k: number) => {
    const o = cubic ? (k * 3 + 1) * s.size : k * s.size;
    return Array.from(s.values.subarray(o, o + s.size));
  };
  if (n === 0) return [];
  if (t <= s.times[0] || n === 1) return val(0);
  if (t >= s.times[n - 1]) return val(n - 1);
  let k = 0;
  while (k < n - 2 && t >= s.times[k + 1]) k++;
  const t0 = s.times[k];
  const dt = s.times[k + 1] - t0;
  const u = dt > 0 ? (t - t0) / dt : 0;
  if (s.interp === "STEP") return val(k);
  if (cubic) {
    const p0 = val(k);
    const p1 = val(k + 1);
    const m0 = Array.from(s.values.subarray((k * 3 + 2) * s.size, (k * 3 + 3) * s.size));
    const m1 = Array.from(s.values.subarray((k + 1) * 3 * s.size, ((k + 1) * 3 + 1) * s.size));
    const u2 = u * u;
    const u3 = u2 * u;
    const out = p0.map((_, i) => (2 * u3 - 3 * u2 + 1) * p0[i] + (u3 - 2 * u2 + u) * dt * m0[i] + (-2 * u3 + 3 * u2) * p1[i] + (u3 - u2) * dt * m1[i]);
    return quat ? normQ(out) : out;
  }
  const a = val(k);
  const b = val(k + 1);
  if (quat) return slerp(a, b, u);
  return a.map((v, i) => v + (b[i] - v) * u);
}

// ---------- 转换 ----------

export type GltfTarget = "puppet" | "mesh";
export type GltfImportOptions = {
  target: GltfTarget;
  /** 产物文件名里的 slug（models/editor/<slug>.mdl 等） */
  slug: string;
  /** 采样帧率，缺省 30 */
  fps?: number;
  /** 坐标整体缩放；给函数时按单位缩放下的绑定姿势包围盒算 */
  scale?: number | ((bounds: Float64Array) => number);
  /** 骨数告警阈值（语料 max 125） */
  boneBudget?: number;
};

export type GltfModel = {
  target: GltfTarget;
  spec: MdlSpec;
  /** 材质 json 与贴图源图（materials/editor/…） */
  files: Array<{ name: string; data: Uint8Array }>;
  clips: Array<{ id: number; name: string; fps: number; frameCount: number }>;
  /** 绑定姿势包围盒（已乘 scale）：minX minY minZ maxX maxY maxZ */
  bounds: Float64Array;
  scale: number;
  bones: number;
  vertices: number;
  warnings: GltfWarning[];
};

type Prim = {
  node: number;
  material: number | undefined;
  positions: Float64Array;
  normals: Float64Array | null;
  tangents: Float64Array | null;
  uvs: Float64Array | null;
  boneIdx: Uint32Array;
  weights: Float32Array;
  indices: Uint32Array;
};

export const MAX_INFLUENCES = 4;

/** 每顶点影响按权重取前 4 个并归一；全零时挂到 fallback 骨 */
export function topInfluences(joints: number[], weights: number[], fallback: number): { j: number[]; w: number[] } {
  const pairs = joints.map((j, i) => [j, weights[i]] as [number, number]).filter((p) => p[1] > 0);
  pairs.sort((a, b) => b[1] - a[1]);
  const top = pairs.slice(0, MAX_INFLUENCES);
  const sum = top.reduce((s, p) => s + p[1], 0);
  if (!(sum > 0)) return { j: [fallback, fallback, fallback, fallback], w: [1, 0, 0, 0] };
  const j = top.map((p) => p[0]);
  const w = top.map((p) => p[1] / sum);
  while (j.length < MAX_INFLUENCES) {
    j.push(j[0]);
    w.push(0);
  }
  return { j, w };
}

function transformPoints(m: ArrayLike<number>, src: Float64Array, w: number): Float64Array {
  const out = new Float64Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    const [x, y, z] = [src[i], src[i + 1], src[i + 2]];
    out[i] = m[0] * x + m[4] * y + m[8] * z + m[12] * w;
    out[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13] * w;
    out[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14] * w;
  }
  return out;
}

function normalMatrix(m: ArrayLike<number>): M4 {
  const inv = invert(m) ?? ident();
  const o = ident();
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[c * 4 + r] = inv[r * 4 + c];
  return o;
}

function normalize3(a: Float64Array, stride = 3): Float64Array {
  for (let i = 0; i < a.length; i += stride) {
    const l = Math.hypot(a[i], a[i + 1], a[i + 2]) || 1;
    a[i] /= l;
    a[i + 1] /= l;
    a[i + 2] /= l;
  }
  return a;
}

function imageBytes(g: Gltf, imgIdx: number): { bytes: Uint8Array; ext: "png" | "jpg" } | null {
  const im = g.json.images?.[imgIdx];
  if (!im) return null;
  let bytes: Uint8Array | null = null;
  if (im.bufferView !== undefined) {
    const v = viewOf(g, im.bufferView);
    bytes = new Uint8Array(v.dv.buffer, v.dv.byteOffset, v.length).slice();
  } else if (typeof im.uri === "string") {
    bytes = uriBytes(im.uri, g.resolve);
  }
  if (!bytes) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return { bytes, ext: "png" };
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return { bytes, ext: "jpg" };
  return null;
}

/** 材质的底色贴图（png / jpg）与底色系数 */
function materialLook(g: Gltf, mi: number | undefined, warn: (w: GltfWarning) => void) {
  const m = mi === undefined ? null : g.json.materials?.[mi];
  const pbr = m?.pbrMetallicRoughness ?? {};
  const factor = (pbr.baseColorFactor ?? [1, 1, 1, 1]) as number[];
  const ti = pbr.baseColorTexture?.index;
  let tex: ReturnType<typeof imageBytes> = null;
  const src: number | undefined = ti === undefined ? undefined : g.json.textures?.[ti]?.source;
  if (ti !== undefined) {
    tex = src === undefined ? null : imageBytes(g, src);
    if (!tex) warn({ code: "texture", detail: m?.name ?? `#${mi}` });
    if ((pbr.baseColorTexture?.texCoord ?? 0) !== 0) warn({ code: "texCoord", detail: m?.name ?? `#${mi}` });
  }
  return { tex, src: tex ? src : undefined, factor, doubleSided: !!m?.doubleSided, blend: m?.alphaMode === "BLEND" };
}

/**
 * glTF → MDL 编码输入 + 材质 / 贴图文件。没有任何三角形网格时抛 GltfError("noMesh")。
 * puppet：所有图元合成一个子网格、整层一张贴图（多张时取第一张并告警），材质 genericimage4；
 * mesh：每个图元一个子网格，按 glTF 材质各出一份 generic4 材质。
 */
export function gltfToModel(g: Gltf, opts: GltfImportOptions): GltfModel {
  const J = g.json;
  const nodes = (J.nodes ?? []) as J[];
  const warnings: GltfWarning[] = [];
  const warned = new Set<string>();
  const warn = (w: GltfWarning) => {
    const k = `${w.code}|${w.detail ?? ""}`;
    if (!warned.has(k)) warned.add(k), warnings.push(w);
  };
  const fps = opts.fps && opts.fps > 0 && opts.fps <= 240 ? opts.fps : 30;
  const budget = opts.boneBudget ?? 125;

  const parent = new Int32Array(nodes.length).fill(-1);
  nodes.forEach((n, i) => {
    for (const c of (n.children ?? []) as number[]) {
      if (c >= 0 && c < nodes.length && c !== i && parent[c] < 0) parent[c] = i;
    }
  });
  const ancestorsOf = (i: number) => {
    const out: number[] = [];
    for (let p = parent[i], g2 = 0; p >= 0 && g2 < nodes.length; p = parent[p], g2++) out.push(p);
    return out;
  };

  // 场景里挂网格的节点（缺 scenes 时取所有根）
  const sceneIdx = J.scene ?? 0;
  const roots: number[] = J.scenes?.[sceneIdx]?.nodes ?? nodes.map((_, i) => i).filter((i) => parent[i] < 0);
  const meshNodes: number[] = [];
  const seen = new Set<number>();
  const walk = (i: number) => {
    if (seen.has(i) || !nodes[i]) return;
    seen.add(i);
    if (nodes[i].mesh !== undefined && J.meshes?.[nodes[i].mesh]) meshNodes.push(i);
    for (const c of (nodes[i].children ?? []) as number[]) walk(c);
  };
  roots.forEach(walk);
  if (!meshNodes.length) throw new GltfError("noMesh");

  // 骨集合 = 关节 ∪ 网格节点 ∪ 祖先
  const need = new Set<number>();
  const addWithAncestors = (i: number) => {
    need.add(i);
    for (const a of ancestorsOf(i)) need.add(a);
  };
  for (const ni of meshNodes) {
    const skin = nodes[ni].skin !== undefined ? J.skins?.[nodes[ni].skin] : null;
    if (skin) for (const j of skin.joints as number[]) addWithAncestors(j);
    else addWithAncestors(ni);
  }
  const order: number[] = [];
  const visit = (i: number) => {
    order.push(i);
    for (const c of (nodes[i].children ?? []) as number[]) if (need.has(c) && parent[c] === i) visit(c);
  };
  [...need].filter((i) => parent[i] < 0 || !need.has(parent[i])).sort((a, b) => a - b).forEach(visit);
  const boneOf = new Map(order.map((n, b) => [n, b]));
  if (order.length > budget) warn({ code: "boneBudget", detail: `${order.length} > ${budget}` });

  // 静止世界矩阵与绑定世界矩阵
  const restWorld = new Map<number, M4>();
  const worldOf = (i: number): M4 => {
    const hit = restWorld.get(i);
    if (hit) return hit;
    const l = restLocal(nodes[i]);
    const w = parent[i] >= 0 ? mul(worldOf(parent[i]), l) : l;
    restWorld.set(i, w);
    return w;
  };
  const bindWorld = new Map<number, M4>();
  for (const ni of meshNodes) {
    const si = nodes[ni].skin;
    const skin = si !== undefined ? J.skins?.[si] : null;
    if (!skin) continue;
    const ibm = skin.inverseBindMatrices !== undefined ? readAccessor(g, skin.inverseBindMatrices).data : null;
    (skin.joints as number[]).forEach((j, k) => {
      const m = ibm ? invert(ibm.subarray(k * 16, k * 16 + 16)) : ident();
      if (!m) {
        warn({ code: "ibm", detail: nodes[j]?.name ?? `#${j}` });
        return;
      }
      const had = bindWorld.get(j);
      if (had && had.some((v, x) => Math.abs(v - m[x]) > 1e-4)) warn({ code: "skinConflict", detail: nodes[j]?.name ?? `#${j}` });
      if (!had) bindWorld.set(j, m);
    });
  }
  const bindOf = (n: number) => bindWorld.get(n) ?? worldOf(n);

  // 图元
  const prims: Prim[] = [];
  for (const ni of meshNodes) {
    const node = nodes[ni];
    const mesh = J.meshes[node.mesh];
    const skin = node.skin !== undefined ? J.skins?.[node.skin] : null;
    for (const p of (mesh.primitives ?? []) as J[]) {
      if ((p.mode ?? 4) !== 4) {
        warn({ code: "mode", detail: `${mesh.name ?? `mesh#${node.mesh}`} mode ${p.mode}` });
        continue;
      }
      if (p.targets?.length) warn({ code: "morph", detail: mesh.name ?? `mesh#${node.mesh}` });
      if (p.extensions?.KHR_draco_mesh_compression) {
        warn({ code: "draco", detail: mesh.name ?? `mesh#${node.mesh}` });
        continue;
      }
      const at = p.attributes ?? {};
      if (at.POSITION === undefined) continue;
      const pos = readAccessor(g, at.POSITION);
      const n = pos.count;
      if (!n) continue;
      if (Object.keys(at).some((k) => /^TEXCOORD_[1-9]/.test(k))) warn({ code: "uvSets", detail: mesh.name ?? `mesh#${node.mesh}` });
      let positions = pos.data;
      let normals = at.NORMAL !== undefined ? readAccessor(g, at.NORMAL).data : null;
      let tangents = at.TANGENT !== undefined ? readAccessor(g, at.TANGENT).data : null;
      const uvs = at.TEXCOORD_0 !== undefined ? readAccessor(g, at.TEXCOORD_0).data : null;
      const boneIdx = new Uint32Array(n * 4);
      const weights = new Float32Array(n * 4);
      if (skin && at.JOINTS_0 !== undefined && at.WEIGHTS_0 !== undefined) {
        const jointBones = (skin.joints as number[]).map((j) => boneOf.get(j) ?? 0);
        const sets: Array<{ j: Float64Array; w: Float64Array }> = [];
        for (let s = 0; at[`JOINTS_${s}`] !== undefined && at[`WEIGHTS_${s}`] !== undefined; s++) {
          sets.push({ j: readAccessor(g, at[`JOINTS_${s}`]).data, w: readAccessor(g, at[`WEIGHTS_${s}`]).data });
        }
        let truncated = false;
        for (let v = 0; v < n; v++) {
          const js: number[] = [];
          const ws: number[] = [];
          for (const s of sets) {
            for (let k = 0; k < 4; k++) {
              js.push(jointBones[s.j[v * 4 + k]] ?? 0);
              ws.push(s.w[v * 4 + k]);
            }
          }
          if (ws.filter((w) => w > 0).length > MAX_INFLUENCES) truncated = true;
          const r = topInfluences(js, ws, jointBones[0] ?? 0);
          boneIdx.set(r.j, v * 4);
          weights.set(r.w, v * 4);
        }
        if (truncated) warn({ code: "influences", detail: mesh.name ?? `mesh#${node.mesh}` });
      } else {
        if (skin) warn({ code: "skinAttr", detail: mesh.name ?? `mesh#${node.mesh}` });
        const b = boneOf.get(ni) ?? 0;
        const m = bindOf(ni);
        positions = transformPoints(m, positions, 1);
        const nm = normalMatrix(m);
        if (normals) normals = normalize3(transformPoints(nm, normals, 0));
        if (tangents) {
          const t3 = new Float64Array((tangents.length / 4) * 3);
          for (let v = 0; v < t3.length / 3; v++) t3.set(tangents.subarray(v * 4, v * 4 + 3), v * 3);
          const tt = normalize3(transformPoints(m, t3, 0));
          const t4 = new Float64Array(tangents.length);
          for (let v = 0; v < tt.length / 3; v++) {
            t4.set(tt.subarray(v * 3, v * 3 + 3), v * 4);
            t4[v * 4 + 3] = tangents[v * 4 + 3];
          }
          tangents = t4;
        }
        for (let v = 0; v < n; v++) {
          boneIdx.fill(b, v * 4, v * 4 + 4);
          weights[v * 4] = 1;
        }
      }
      let indices: Uint32Array;
      if (p.indices !== undefined) {
        const ix = readAccessor(g, p.indices).data;
        indices = Uint32Array.from(ix);
        if (indices.some((x) => x >= n)) throw new GltfError("accessor", `indices ≥ ${n}`);
      } else {
        indices = Uint32Array.from({ length: n - (n % 3) }, (_, i) => i);
      }
      if (indices.length % 3) indices = indices.subarray(0, indices.length - (indices.length % 3));
      prims.push({ node: ni, material: p.material, positions, normals, tangents, uvs, boneIdx, weights, indices });
    }
  }
  if (!prims.length) throw new GltfError("noMesh");

  // 绑定姿势包围盒（单位缩放）→ 定 scale
  const bounds = Float64Array.of(Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity);
  for (const p of prims) {
    for (let i = 0; i < p.positions.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        bounds[k] = Math.min(bounds[k], p.positions[i + k]);
        bounds[k + 3] = Math.max(bounds[k + 3], p.positions[i + k]);
      }
    }
  }
  const sc0 = typeof opts.scale === "function" ? opts.scale(bounds) : (opts.scale ?? 1);
  const scale = Number.isFinite(sc0) && sc0 > 0 ? sc0 : 1;
  for (let k = 0; k < 6; k++) bounds[k] *= scale;

  // 骨骼：MDLS 局部矩阵 = 父绑定世界⁻¹ · 自身绑定世界（平移乘 scale）
  const bones = order.map((ni, b) => {
    const p = parent[ni];
    const pb = p >= 0 ? boneOf.get(p) : undefined;
    const local = pb !== undefined ? mul(invert(bindOf(p)) ?? ident(), bindOf(ni)) : bindOf(ni);
    const m = Float32Array.from(local);
    m[12] *= scale;
    m[13] *= scale;
    m[14] *= scale;
    const raw = String(nodes[ni].name ?? `bone_${b}`);
    return { name: [...raw].slice(0, 63).join(""), parent: pb ?? -1, matrix: m };
  });

  // 动画
  const animations: NonNullable<MdlSpec["animations"]> = [];
  const clips: GltfModel["clips"] = [];
  ((J.animations ?? []) as J[]).forEach((an, ai) => {
    const per = new Map<number, Partial<Record<"translation" | "rotation" | "scale", Sampler>>>();
    let dur = 0;
    for (const ch of (an.channels ?? []) as J[]) {
      const tn = ch.target?.node;
      const path = ch.target?.path;
      if (path === "weights") {
        warn({ code: "morph", detail: an.name ?? `anim#${ai}` });
        continue;
      }
      if (!boneOf.has(tn) || !["translation", "rotation", "scale"].includes(path)) continue;
      const sm = an.samplers?.[ch.sampler];
      if (!sm) continue;
      const input = readAccessor(g, sm.input).data;
      const out = readAccessor(g, sm.output);
      const interp = sm.interpolation ?? "LINEAR";
      if (!["LINEAR", "STEP", "CUBICSPLINE"].includes(interp)) continue;
      const s: Sampler = { times: input, values: out.data, size: out.size, interp };
      dur = Math.max(dur, input.length ? input[input.length - 1] : 0);
      const slot = per.get(tn) ?? {};
      slot[path as "translation"] = s;
      per.set(tn, slot);
    }
    if (!per.size) {
      warn({ code: "emptyAnim", detail: an.name ?? `anim#${ai}` });
      return;
    }
    const fc = Math.max(1, Math.round(dur * fps));
    const tracks = order.map((ni) => {
      const rest = restTRS(nodes[ni]);
      const ch = per.get(ni) ?? {};
      const data = new Float32Array((fc + 1) * 9);
      let prev: V3 | undefined;
      for (let f = 0; f <= fc; f++) {
        const t = (f * dur) / fc;
        const tr = ch.translation ? sampleAt(ch.translation, t, false) : rest.t;
        const q = (ch.rotation ? sampleAt(ch.rotation, t, true) : rest.r) as Quat;
        const s = ch.scale ? sampleAt(ch.scale, t, false) : rest.s;
        const e = quatToEuler(q, prev);
        prev = e;
        data.set([tr[0] * scale, tr[1] * scale, tr[2] * scale, e[0], e[1], e[2], s[0], s[1], s[2]], f * 9);
      }
      return data;
    });
    const id = animations.length + 1;
    const name = [...String(an.name || `Animation ${id}`)].slice(0, 64).join("");
    animations.push({ id, name, mode: "loop", fps, frameCount: fc, tracks });
    clips.push({ id, name, fps, frameCount: fc });
  });
  if (!animations.length) {
    // 没有动画也给一条静止片段：骨骼 / 片段编辑（W18）都要求已有动画段
    const tracks = order.map((ni) => {
      const r = restTRS(nodes[ni]);
      const e = quatToEuler(r.r);
      const one = [r.t[0] * scale, r.t[1] * scale, r.t[2] * scale, e[0], e[1], e[2], r.s[0], r.s[1], r.s[2]];
      return Float32Array.from([...one, ...one]);
    });
    animations.push({ id: 1, name: "Rest", mode: "loop", fps, frameCount: 1, tracks });
    clips.push({ id: 1, name: "Rest", fps, frameCount: 1 });
  }

  // 网格与材质
  const files: GltfModel["files"] = [];
  const meshes: MdlSpec["meshes"] = [];
  const toF32 = (a: Float64Array | null, k = 1) => (a ? Float32Array.from(a, (v) => v * k) : undefined);
  if (opts.target === "puppet") {
    const material = `materials/editor/${opts.slug}.json`;
    const looks = prims.map((p) => materialLook(g, p.material, warn));
    const look = looks.find((l) => l.tex) ?? looks[0];
    if (new Set(looks.map((l) => l.src ?? JSON.stringify(l.factor))).size > 1) warn({ code: "puppetMaterials" });
    let total = 0;
    for (const p of prims) total += p.positions.length / 3;
    const positions = new Float32Array(total * 3);
    const uvs = new Float32Array(total * 2);
    const boneIdx = new Uint32Array(total * 4);
    const weights = new Float32Array(total * 4);
    const idx: number[] = [];
    let base = 0;
    for (const p of prims) {
      const n = p.positions.length / 3;
      for (let i = 0; i < n * 3; i++) positions[base * 3 + i] = p.positions[i] * scale;
      if (p.uvs) uvs.set(p.uvs, base * 2);
      boneIdx.set(p.boneIdx, base * 4);
      weights.set(p.weights, base * 4);
      for (const x of p.indices) idx.push(x + base);
      base += n;
    }
    meshes.push({ material, positions, uvs, boneIdx, weights, indices: Uint32Array.from(idx) });
    const tex = look.tex ?? { bytes: solidPng(look.factor), ext: "png" as const };
    files.push(
      {
        name: material,
        data: jsonBytes({
          passes: [{ blending: "translucent", cullmode: "nocull", depthtest: "disabled", depthwrite: "disabled", shader: "genericimage4", textures: [`editor/${opts.slug}`] }],
        }),
      },
      { name: `materials/editor/${opts.slug}.${tex.ext}`, data: tex.bytes },
    );
  } else {
    const made = new Map<string, string>();
    for (const p of prims) {
      const key = String(p.material ?? "none");
      let material = made.get(key);
      if (!material) {
        const k = made.size;
        const look = materialLook(g, p.material, warn);
        const texSlug = `${opts.slug}_${k}`;
        material = `materials/editor/${texSlug}.json`;
        made.set(key, material);
        const tex = look.tex ?? { bytes: solidPng(look.factor), ext: "png" as const };
        files.push(
          {
            name: material,
            data: jsonBytes({
              passes: [
                {
                  blending: look.blend ? "translucent" : "normal",
                  cullmode: look.doubleSided ? "nocull" : "normal",
                  depthtest: "enabled",
                  depthwrite: look.blend ? "disabled" : "enabled",
                  shader: "generic4",
                  textures: [`editor/${texSlug}`],
                },
              ],
            }),
          },
          { name: `materials/editor/${texSlug}.${tex.ext}`, data: tex.bytes },
        );
      }
      meshes.push({
        material,
        positions: toF32(p.positions, scale)!,
        uvs: toF32(p.uvs),
        normals: toF32(p.normals),
        tangents: toF32(p.tangents),
        boneIdx: p.boneIdx,
        weights: p.weights,
        indices: p.indices,
      });
    }
  }
  return {
    target: opts.target,
    spec: { meshes, bones, animations },
    files,
    clips,
    bounds,
    scale,
    bones: bones.length,
    vertices: meshes.reduce((s, m) => s + m.positions.length / 3, 0),
    warnings,
  };
}

const jsonBytes = (v: unknown) => enc.encode(JSON.stringify(v, null, 2));

// ---------- 纯色 png（没有底色贴图时用；4×4、无压缩 deflate） ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const toSrgb8 = (v: number) => {
  const c = Math.min(1, Math.max(0, v));
  return Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
};

/** baseColorFactor（线性）→ 4×4 RGBA png（sRGB） */
export function solidPng(factor: ArrayLike<number>, size = 4): Uint8Array {
  const rgba = [toSrgb8(factor[0] ?? 1), toSrgb8(factor[1] ?? 1), toSrgb8(factor[2] ?? 1), Math.round(255 * Math.min(1, Math.max(0, factor[3] ?? 1)))];
  const raw = new Uint8Array(size * (1 + size * 4));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) raw.set(rgba, y * (1 + size * 4) + 1 + x * 4);
  let a = 1;
  let b = 0;
  for (const v of raw) {
    a = (a + v) % 65521;
    b = (b + a) % 65521;
  }
  const z = new Uint8Array(2 + 5 + raw.length + 4);
  z.set([0x78, 0x01, 1, raw.length & 0xff, raw.length >> 8, ~raw.length & 0xff, (~raw.length >> 8) & 0xff]);
  z.set(raw, 7);
  new DataView(z.buffer).setUint32(7 + raw.length, ((b << 16) | a) >>> 0);
  const chunk = (type: string, body: Uint8Array) => {
    const out = new Uint8Array(12 + body.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, body.length);
    out.set(enc.encode(type), 4);
    out.set(body, 8);
    dv.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const hv = new DataView(ihdr.buffer);
  hv.setUint32(0, size);
  hv.setUint32(4, size);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const parts = [Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), chunk("IHDR", ihdr), chunk("IDAT", z), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) out.set(p, o), (o += p.length);
  return out;
}

// ---------- 落成工程文件 + 加层 ----------

export const editorMdlPathOf = (slug: string) => `models/editor/${slug}.mdl`;

/**
 * 导入产物文件：.mdl + 材质 / 贴图；puppet 另有 model json（autosize / material / puppet）。
 * path = 场景对象该引用的路径（puppet → image 的 model json，mesh → model 的 .mdl）
 */
export function gltfImportFiles(m: GltfModel, slug: string): { path: string; mdlPath: string; files: Array<{ name: string; data: Uint8Array }> } {
  let mdl: Uint8Array;
  try {
    mdl = encodeMdl(m.spec);
  } catch (e) {
    throw new GltfError("encode", (e as Error).message);
  }
  const mdlPath = editorMdlPathOf(slug);
  const files = [{ name: mdlPath, data: mdl }, ...m.files];
  if (m.target === "mesh") return { path: mdlPath, mdlPath, files };
  const path = modelPathOf(slug);
  files.unshift({ name: path, data: jsonBytes({ autosize: true, material: `materials/editor/${slug}.json`, puppet: mdlPath }) });
  return { path, mdlPath, files };
}

const vec3 = (x: number, y: number, z: number) => `${x.toFixed(5)} ${y.toFixed(5)} ${z.toFixed(5)}`;

function nextId(objs: SceneObject[]): number {
  let max = 0;
  for (const o of objs) {
    if (typeof o?.id === "number") max = Math.max(max, o.id);
    for (const a of (Array.isArray(o?.animationlayers) ? o.animationlayers : []) as Array<{ id?: unknown }>) {
      if (typeof a?.id === "number") max = Math.max(max, a.id);
    }
  }
  return max + 1;
}

/** 正交场景（有 orthogonalprojection）缺省导入成 puppet，透视场景导入成网格 */
export function defaultTarget(doc: EditorDoc): GltfTarget {
  const ortho = (doc.scene?.general as Record<string, unknown> | undefined)?.orthogonalprojection;
  return ortho && typeof ortho === "object" ? "puppet" : "mesh";
}

/** puppet 缺省缩放：模型绑定姿势包围盒落在场景画面 60% 内 */
export function fitPuppetScale(doc: EditorDoc): (b: Float64Array) => number {
  const ortho = (doc.scene?.general as Record<string, unknown> | undefined)?.orthogonalprojection as Record<string, unknown> | undefined;
  const W = Number(ortho?.width) || 1920;
  const H = Number(ortho?.height) || 1080;
  return (b) => {
    const w = b[3] - b[0];
    const h = b[4] - b[1];
    const s = Math.min(w > 0 ? (0.6 * W) / w : Infinity, h > 0 ? (0.6 * H) / h : Infinity);
    return Number.isFinite(s) && s > 0 ? s : 1;
  };
}

const parseVec = (v: unknown): V3 | null => {
  const p = String(v ?? "").trim().split(/\s+/).map(Number);
  return p.length >= 3 && p.every(Number.isFinite) ? [p[0], p[1], p[2]] : null;
};

/** 网格缺省缩放：包围球半径 ≈ 相机到注视点距离的 1/3（没有相机时按 1） */
export function fitMeshScale(doc: EditorDoc): (b: Float64Array) => number {
  const cam = doc.scene?.camera as Record<string, unknown> | undefined;
  const eye = parseVec(cam?.eye);
  const center = parseVec(cam?.center);
  const dist = eye && center ? Math.hypot(eye[0] - center[0], eye[1] - center[1], eye[2] - center[2]) : 0;
  return (b) => {
    const r = Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]) / 2;
    return dist > 0 && r > 0 ? dist / 3 / r : 1;
  };
}

/**
 * 场景末尾加导入的模型层并挂一条动画层指向首个片段；返回新 id。
 * puppet：图片层放在画面中心（层原点 = 网格原点，按包围盒中心对齐），size = 关于原点对称的包围盒；
 * mesh：放在相机注视点。
 */
export function addModelLayer(doc: EditorDoc, m: GltfModel, path: string, name: string): number | null {
  const scene = doc.scene;
  if (!scene) return null;
  if (!Array.isArray(scene.objects)) scene.objects = [];
  const objs = scene.objects as SceneObject[];
  const id = nextId(objs);
  const b = m.bounds;
  let o: SceneObject;
  if (m.target === "puppet") {
    const ortho = (scene.general as Record<string, unknown> | undefined)?.orthogonalprojection as Record<string, unknown> | undefined;
    const W = Number(ortho?.width) || 1920;
    const H = Number(ortho?.height) || 1080;
    const cx = (b[0] + b[3]) / 2;
    const cy = (b[1] + b[4]) / 2;
    const sw = Math.ceil(2 * Math.max(Math.abs(b[0]), Math.abs(b[3])));
    const sh = Math.ceil(2 * Math.max(Math.abs(b[1]), Math.abs(b[4])));
    o = { angles: vec3(0, 0, 0), id, image: path, name, origin: vec3(W / 2 - cx, H / 2 - cy, 0), scale: vec3(1, 1, 1), size: `${sw.toFixed(5)} ${sh.toFixed(5)}` };
  } else {
    const c = parseVec((scene.camera as Record<string, unknown> | undefined)?.center) ?? [0, 0, 0];
    o = { angles: vec3(0, 0, 0), id, model: path, name, origin: vec3(c[0], c[1], c[2]), scale: vec3(1, 1, 1) };
  }
  objs.push(o);
  if (m.clips.length) addAnimLayer(doc, o, m.clips[0].id, m.clips[0].name);
  rebuildTree(doc);
  return id;
}

export const MODEL_FILE_RE = /\.(glb|gltf)$/i;
export const isModelFile = (f: { name: string }) => MODEL_FILE_RE.test(f.name);
