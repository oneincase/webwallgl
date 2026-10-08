// 非 glTF 格式（OBJ / STL / PLY / 3DS / DAE / FBX）的公共落点：各解析器产出 ModelIR，
// irToGltf 把它装成内存里的 glTF 2.0（一块缓冲），再走 gltf.ts 同一条 gltfToModel 管线。
// 约定与 glTF 一致：Y 向上、右手系、列主序矩阵、UV 原点左上（v 向下）、四元数 [x y z w]、颜色线性。

import { encodePng, type Gltf } from "./gltf";

export type Mat4 = ArrayLike<number>;
export type IRPrim = {
  material?: number;
  positions: ArrayLike<number>;
  normals?: ArrayLike<number> | null;
  uvs?: ArrayLike<number> | null;
  /** 缺省按 0..n−1 三个一组 */
  indices?: ArrayLike<number> | null;
  /** 每顶点 4 个（skin.joints 的下标）与对应权重 */
  joints?: ArrayLike<number> | null;
  weights?: ArrayLike<number> | null;
};
export type IRNode = {
  name?: string;
  parent: number;
  /** 局部矩阵；不给时按 t / r / s */
  matrix?: Mat4;
  t?: ArrayLike<number>;
  r?: ArrayLike<number>;
  s?: ArrayLike<number>;
  mesh?: IRPrim[];
  skin?: number;
};
export type IRSkin = { joints: number[]; ibm: Mat4[] };
export type IRImage = { name: string; bytes: Uint8Array | null };
export type IRMaterial = { name?: string; color?: ArrayLike<number>; image?: IRImage | null; doubleSided?: boolean; blend?: boolean };
export type IRChannel = { node: number; path: "translation" | "rotation" | "scale"; times: ArrayLike<number>; values: ArrayLike<number>; interp?: "LINEAR" | "STEP" };
export type IRAnim = { name: string; channels: IRChannel[] };
export type IRWarning = { code: string; detail?: string };
export type ModelIR = { nodes: IRNode[]; materials?: IRMaterial[]; skins?: IRSkin[]; anims?: IRAnim[]; warnings?: IRWarning[] };

// ---------- 矩阵 ----------

export const IDENT: readonly number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
/** Z 向上 → Y 向上：(x, y, z) → (x, z, −y) */
export const Z_UP_TO_Y_UP: readonly number[] = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1];

export function m4mul(a: Mat4, b: Mat4): number[] {
  const o = new Array<number>(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  }
  return o;
}

export function m4inv(m: Mat4): number[] | null {
  const a = Array.from(m);
  const inv = [...IDENT];
  for (let c = 0; c < 4; c++) {
    let piv = c;
    for (let r = c + 1; r < 4; r++) if (Math.abs(a[c * 4 + r]) > Math.abs(a[c * 4 + piv])) piv = r;
    if (Math.abs(a[c * 4 + piv]) < 1e-14) return null;
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
  return inv;
}

export const m4translate = (x: number, y: number, z: number): number[] => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
export const m4scale = (x: number, y: number, z: number): number[] => [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1];

/** 绕单轴旋转（弧度） */
export function m4rot(axis: 0 | 1 | 2, a: number): number[] {
  const c = Math.cos(a);
  const s = Math.sin(a);
  if (axis === 0) return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
  if (axis === 1) return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
  return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

/** 绕任意轴（不必单位长）旋转（弧度） */
export function m4axisAngle(x: number, y: number, z: number, a: number): number[] {
  const l = Math.hypot(x, y, z) || 1;
  x /= l;
  y /= l;
  z /= l;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const t = 1 - c;
  return [t * x * x + c, t * x * y + s * z, t * x * z - s * y, 0, t * x * y - s * z, t * y * y + c, t * y * z + s * x, 0, t * x * z + s * y, t * y * z - s * x, t * z * z + c, 0, 0, 0, 0, 1];
}

/** 3×3 部分的线性变换（法线用逆转置） */
export function transformPositions(m: Mat4, src: ArrayLike<number>): Float32Array {
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    const x = src[i], y = src[i + 1], z = src[i + 2];
    out[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    out[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    out[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  return out;
}

export function transformNormals(m: Mat4, src: ArrayLike<number>): Float32Array {
  const inv = m4inv(m) ?? [...IDENT];
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    const x = src[i], y = src[i + 1], z = src[i + 2];
    const nx = inv[0] * x + inv[1] * y + inv[2] * z;
    const ny = inv[4] * x + inv[5] * y + inv[6] * z;
    const nz = inv[8] * x + inv[9] * y + inv[10] * z;
    const l = Math.hypot(nx, ny, nz) || 1;
    out[i] = nx / l;
    out[i + 1] = ny / l;
    out[i + 2] = nz / l;
  }
  return out;
}

/** 平面法线（无法线的格式按三角形算，平均到顶点） */
export function computeNormals(positions: ArrayLike<number>, indices: ArrayLike<number>): Float32Array {
  const n = new Float32Array(positions.length);
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const p of [a, b, c]) {
      n[p] += nx;
      n[p + 1] += ny;
      n[p + 2] += nz;
    }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= l;
    n[i + 1] /= l;
    n[i + 2] /= l;
  }
  return n;
}

/** 多边形（顶点下标列表）扇形三角化 */
export function fan(poly: ArrayLike<number>, out: number[]): void {
  for (let k = 1; k + 1 < poly.length; k++) out.push(poly[0], poly[k], poly[k + 1]);
}

// ---------- 贴图：png / jpg 原样，TGA / BMP 解码后转 png ----------

const isPng = (b: Uint8Array) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
const isJpg = (b: Uint8Array) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8;

function decodeTga(b: Uint8Array): { w: number; h: number; px: Uint8Array } | null {
  if (b.length < 18) return null;
  const idLen = b[0];
  const cmap = b[1];
  const type = b[2];
  const w = b[12] | (b[13] << 8);
  const h = b[14] | (b[15] << 8);
  const bpp = b[16];
  const desc = b[17];
  if (cmap || !w || !h || ![2, 3, 10, 11].includes(type) || ![8, 24, 32].includes(bpp)) return null;
  const gray = type === 3 || type === 11;
  const bytes = bpp / 8;
  const px = new Uint8Array(w * h * 4);
  let p = 18 + idLen;
  const put = (i: number, at: number) => {
    if (gray) px.set([b[at], b[at], b[at], 255], i * 4);
    else px.set([b[at + 2], b[at + 1], b[at], bytes === 4 ? b[at + 3] : 255], i * 4);
  };
  let i = 0;
  if (type === 2 || type === 3) {
    if (p + w * h * bytes > b.length) return null;
    for (; i < w * h; i++, p += bytes) put(i, p);
  } else {
    while (i < w * h && p < b.length) {
      const hd = b[p++];
      const n = (hd & 0x7f) + 1;
      if (hd & 0x80) {
        for (let k = 0; k < n && i < w * h; k++) put(i++, p);
        p += bytes;
      } else {
        for (let k = 0; k < n && i < w * h; k++, p += bytes) put(i++, p);
      }
    }
  }
  if (!(desc & 0x20)) flipRows(px, w, h);
  return { w, h, px };
}

function decodeBmp(b: Uint8Array): { w: number; h: number; px: Uint8Array } | null {
  if (b.length < 54 || b[0] !== 0x42 || b[1] !== 0x4d) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const off = dv.getUint32(10, true);
  const w = dv.getInt32(18, true);
  const hRaw = dv.getInt32(22, true);
  const bpp = dv.getUint16(28, true);
  const comp = dv.getUint32(30, true);
  const h = Math.abs(hRaw);
  if (w <= 0 || !h || ![24, 32].includes(bpp) || (comp !== 0 && comp !== 3)) return null;
  const stride = Math.ceil((w * bpp) / 32) * 4;
  if (off + stride * h > b.length) return null;
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const row = off + (hRaw > 0 ? h - 1 - y : y) * stride;
    for (let x = 0; x < w; x++) {
      const at = row + x * (bpp / 8);
      px.set([b[at + 2], b[at + 1], b[at], bpp === 32 && comp === 0 ? 255 : bpp === 32 ? b[at + 3] : 255], (y * w + x) * 4);
    }
  }
  return { w, h, px };
}

function flipRows(px: Uint8Array, w: number, h: number) {
  const row = w * 4;
  const tmp = new Uint8Array(row);
  for (let y = 0; y < h >> 1; y++) {
    const a = y * row, b = (h - 1 - y) * row;
    tmp.set(px.subarray(a, a + row));
    px.copyWithin(a, b, b + row);
    px.set(tmp, b);
  }
}

/** 贴图字节归一成 png / jpg；认不出的原样返回（下游按缺贴图告警） */
export function normalizeImage(bytes: Uint8Array): Uint8Array {
  if (isPng(bytes) || isJpg(bytes)) return bytes;
  const img = decodeBmp(bytes) ?? decodeTga(bytes);
  return img ? encodePng(img.w, img.h, img.px) : bytes;
}

/** 按文件名找贴图：原名、去目录、大小写不敏感、换扩展名（.tga ↔ .png 等） */
export function findImage(name: string, resolve: (n: string) => Uint8Array | null): IRImage {
  const clean = name.replace(/\\/g, "/").trim();
  const base = clean.split("/").pop() ?? clean;
  const stem = base.replace(/\.[^.]*$/, "");
  const tries = [clean, base, base.toLowerCase(), ...["png", "jpg", "jpeg", "tga", "bmp", "PNG", "JPG", "TGA"].map((e) => `${stem}.${e}`)];
  for (const t of tries) {
    const b = resolve(t);
    if (b) return { name: base, bytes: b };
  }
  return { name: base, bytes: null };
}

// ---------- ModelIR → glTF ----------

class BufW {
  parts: Uint8Array[] = [];
  len = 0;
  views: Array<Record<string, number>> = [];
  add(bytes: Uint8Array, target?: number): number {
    const pad = (4 - (this.len % 4)) % 4;
    if (pad) this.parts.push(new Uint8Array(pad)), (this.len += pad);
    const v: Record<string, number> = { buffer: 0, byteOffset: this.len, byteLength: bytes.length };
    if (target) v.target = target;
    this.parts.push(bytes);
    this.len += bytes.length;
    this.views.push(v);
    return this.views.length - 1;
  }
  concat(): Uint8Array {
    const out = new Uint8Array(this.len);
    let o = 0;
    for (const p of this.parts) out.set(p, o), (o += p.length);
    return out;
  }
}

const u8 = (a: ArrayBufferView) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);

function localOf(n: IRNode): number[] {
  if (n.matrix) return Array.from(n.matrix);
  const [x, y, z, w] = n.r ? Array.from(n.r) : [0, 0, 0, 1];
  const [sx, sy, sz] = n.s ? Array.from(n.s) : [1, 1, 1];
  const t = n.t ? Array.from(n.t) : [0, 0, 0];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    t[0], t[1], t[2], 1,
  ];
}

/**
 * 蒙皮网格顶点预乘绑定世界矩阵 W、IBM 右乘 W⁻¹（Σ w·J·IBM·W⁻¹·W·v 不变）。
 * gltfToModel 对蒙皮图元保留网格空间坐标、按它算绑定包围盒；FBX / DAE 的网格空间常是原始轴向（Z 向上、厘米），
 * 换到世界空间后包围盒（自动缩放 / 摆放）才对。W 取权重最大关节的「静止世界 · IBM」——静止姿势即绑定姿势时
 * 对每个关节都相同；网格节点自身的变换不可靠（有的导出器把已是世界坐标的顶点挂在带变换的节点下）。
 */
function bakeSkinnedMeshes(ir: ModelIR): ModelIR {
  if (!ir.skins?.length) return ir;
  const world: number[][] = [];
  const worldOf = (i: number, guard = 0): number[] => {
    if (world[i]) return world[i];
    const n = ir.nodes[i];
    const p = n.parent >= 0 && n.parent < ir.nodes.length && n.parent !== i && guard < 256 ? worldOf(n.parent, guard + 1) : [...IDENT];
    return (world[i] = m4mul(p, localOf(n)));
  };
  const skins = [...ir.skins];
  const nodes = ir.nodes.map((n, i) => {
    if (n.skin === undefined || !n.mesh?.length || !skins[n.skin]) return n;
    const s0 = skins[n.skin];
    const total = new Float64Array(s0.joints.length);
    for (const p of n.mesh) {
      if (!p.joints || !p.weights) continue;
      for (let k = 0; k < p.joints.length; k++) if (p.joints[k] < total.length) total[p.joints[k]] += p.weights[k];
    }
    let jk = 0;
    for (let k = 1; k < total.length; k++) if (total[k] > total[jk]) jk = k;
    const W = total.length && s0.ibm[jk] ? m4mul(worldOf(s0.joints[jk]), s0.ibm[jk]) : worldOf(i);
    const Winv = m4inv(W);
    if (!Winv || W.every((v, k) => Math.abs(v - IDENT[k]) < 1e-12)) return n;
    const s = skins[n.skin];
    skins.push({ joints: s.joints, ibm: s.ibm.map((m) => m4mul(m, Winv)) });
    const mesh = n.mesh.map((p) => ({ ...p, positions: transformPositions(W, p.positions), normals: p.normals ? transformNormals(W, p.normals) : p.normals }));
    return { ...n, mesh, skin: skins.length - 1 };
  });
  return { ...ir, nodes, skins };
}

/** ModelIR → Gltf（json + 单块缓冲）；resolve 透传给 gltf.ts（贴图未找到时按 uri 再找一次 → 告警） */
export function irToGltf(input: ModelIR, resolve: Gltf["resolve"] = () => null): Gltf {
  const ir = bakeSkinnedMeshes(input);
  const bw = new BufW();
  const accessors: Array<Record<string, unknown>> = [];
  const acc = (data: ArrayLike<number>, type: string, ct: 5126 | 5125 | 5123, target?: number) => {
    const typed = ct === 5126 ? Float32Array.from(data) : ct === 5125 ? Uint32Array.from(data) : Uint16Array.from(data);
    const size = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[type]!;
    accessors.push({ bufferView: bw.add(u8(typed), target), componentType: ct, count: typed.length / size, type });
    return accessors.length - 1;
  };
  const json: Record<string, any> = { asset: { version: "2.0", generator: "webwallgl model-ir" }, nodes: [], meshes: [], scenes: [{ nodes: [] }], scene: 0 };
  const children: number[][] = ir.nodes.map(() => []);
  ir.nodes.forEach((n, i) => {
    if (n.parent >= 0 && n.parent < ir.nodes.length && n.parent !== i) children[n.parent].push(i);
    else json.scenes[0].nodes.push(i);
  });
  // 材质
  const images: Array<Record<string, unknown>> = [];
  const textures: Array<Record<string, unknown>> = [];
  json.materials = (ir.materials ?? []).map((m) => {
    const pbr: Record<string, unknown> = { baseColorFactor: Array.from(m.color ?? [1, 1, 1, 1]).concat([1, 1, 1, 1]).slice(0, 4), metallicFactor: 0, roughnessFactor: 1 };
    if (m.image) {
      const img: Record<string, unknown> = { name: m.image.name };
      if (m.image.bytes) {
        const b = normalizeImage(m.image.bytes);
        img.bufferView = bw.add(b);
        img.mimeType = isJpg(b) ? "image/jpeg" : "image/png";
      } else img.uri = encodeURIComponent(m.image.name);
      images.push(img);
      textures.push({ source: images.length - 1 });
      pbr.baseColorTexture = { index: textures.length - 1 };
    }
    const out: Record<string, unknown> = { name: m.name ?? "", pbrMetallicRoughness: pbr };
    if (m.doubleSided) out.doubleSided = true;
    if (m.blend) out.alphaMode = "BLEND";
    return out;
  });
  if (images.length) json.images = images;
  if (textures.length) json.textures = textures;
  // 节点 / 网格
  ir.nodes.forEach((n, i) => {
    const o: Record<string, unknown> = {};
    if (n.name) o.name = n.name;
    if (children[i].length) o.children = children[i];
    if (n.matrix) o.matrix = Array.from(n.matrix);
    else {
      if (n.t) o.translation = Array.from(n.t);
      if (n.r) o.rotation = Array.from(n.r);
      if (n.s) o.scale = Array.from(n.s);
    }
    if (n.mesh?.length) {
      const prims = n.mesh
        .filter((p) => p.positions.length >= 9)
        .map((p) => {
          const at: Record<string, number> = { POSITION: acc(p.positions, "VEC3", 5126, 34962) };
          if (p.normals && p.normals.length === p.positions.length) at.NORMAL = acc(p.normals, "VEC3", 5126, 34962);
          if (p.uvs && p.uvs.length / 2 === p.positions.length / 3) at.TEXCOORD_0 = acc(p.uvs, "VEC2", 5126, 34962);
          if (p.joints && p.weights && p.joints.length / 4 === p.positions.length / 3 && p.weights.length === p.joints.length) {
            at.JOINTS_0 = acc(p.joints, "VEC4", 5123, 34962);
            at.WEIGHTS_0 = acc(p.weights, "VEC4", 5126, 34962);
          }
          const prim: Record<string, unknown> = { attributes: at, mode: 4 };
          if (p.indices) prim.indices = acc(p.indices, "SCALAR", 5125, 34963);
          if (p.material !== undefined && p.material >= 0 && p.material < json.materials.length) prim.material = p.material;
          return prim;
        });
      if (prims.length) {
        json.meshes.push({ name: n.name ?? "", primitives: prims });
        o.mesh = json.meshes.length - 1;
        if (n.skin !== undefined) o.skin = n.skin;
      }
    }
    json.nodes.push(o);
  });
  if (ir.skins?.length) {
    json.skins = ir.skins.map((s) => {
      const flat: number[] = [];
      for (const m of s.ibm) flat.push(...Array.from(m));
      return { joints: s.joints, inverseBindMatrices: acc(flat, "MAT4", 5126) };
    });
  }
  if (ir.anims?.length) {
    json.animations = ir.anims.map((a) => {
      const samplers: Array<Record<string, unknown>> = [];
      const channels: Array<Record<string, unknown>> = [];
      for (const c of a.channels) {
        if (!c.times.length) continue;
        const size = c.path === "rotation" ? 4 : 3;
        samplers.push({ input: acc(c.times, "SCALAR", 5126), output: acc(c.values, size === 4 ? "VEC4" : "VEC3", 5126), interpolation: c.interp ?? "LINEAR" });
        channels.push({ sampler: samplers.length - 1, target: { node: c.node, path: c.path } });
      }
      return { name: a.name, samplers, channels };
    });
  }
  json.accessors = accessors;
  json.bufferViews = bw.views;
  const bin = bw.concat();
  json.buffers = [{ byteLength: bin.length }];
  return { json, buffers: [bin], resolve };
}

// ---------- 文本 / 二进制读取小工具 ----------

const dec = new TextDecoder();
export const decodeText = (b: Uint8Array) => dec.decode(b).replace(/^\uFEFF/, "");
