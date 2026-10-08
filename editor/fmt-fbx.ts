// Autodesk FBX（7.x，二进制与 ASCII）→ ModelIR。
// 节点树 → Objects（Model / Geometry / Material / Texture / Video / Deformer / AnimationStack…）+ Connections（OO / OP）。
// 读：GlobalSettings 轴向与单位、Model 层级（Lcl TRS + Pre/PostRotation + 枢轴 + RotationOrder + 几何偏移）、
// Mesh 几何（多边形扇形三角化，法线 / UV / 材质分层的各种映射）、Skin/Cluster 蒙皮（IBM = TransformLink⁻¹·Transform）、
// 动画（AnimationStack → Layer → CurveNode → Curve，按 30 fps 重采样后组合成局部矩阵再分解为 TRS）、材质漫反射色 / 贴图（含内嵌 Video）。
// 二进制数组的 zlib 压缩用 DecompressionStream 解，所以入口是 async。FBX 6 及更早不支持。

import { decompose, GltfError } from "./gltf";
import { computeNormals, decodeText, findImage, IDENT, m4inv, m4mul, m4rot, m4scale, m4translate, transformNormals, transformPositions, type IRAnim, type IRChannel, type IRMaterial, type IRNode, type IRPrim, type IRSkin, type IRWarning, type ModelIR } from "./model-ir";

type Val = number | string | Uint8Array | ArrayLike<number> | Pending;
type Pending = { z: Uint8Array; t: string; n: number };
export type FbxNode = { name: string; props: Val[]; kids: FbxNode[] };

const TICKS = 46186158000;
const BIN_MAGIC = "Kaydara FBX Binary  ";
const dec = new TextDecoder();

// ---------- 二进制 ----------

function parseBinary(b: Uint8Array): { root: FbxNode; version: number; pending: Array<{ node: FbxNode; i: number; p: Pending }> } {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const version = dv.getUint32(23, true);
  const wide = version >= 7500;
  const pending: Array<{ node: FbxNode; i: number; p: Pending }> = [];
  const u = (o: number) => (wide ? Number(dv.getBigUint64(o, true)) : dv.getUint32(o, true));
  const head = wide ? 25 : 13;
  const readNode = (o: number): { node: FbxNode | null; next: number } => {
    if (o + head > b.length) throw new GltfError("format", "FBX truncated");
    const end = u(o);
    const nProps = u(o + (wide ? 8 : 4));
    const nameLen = b[o + (wide ? 24 : 12)];
    if (end === 0) return { node: null, next: o + head };
    if (end > b.length || end < o) throw new GltfError("format", "FBX node offset");
    const name = dec.decode(b.subarray(o + head, o + head + nameLen));
    let p = o + head + nameLen;
    const node: FbxNode = { name, props: [], kids: [] };
    for (let i = 0; i < nProps; i++) {
      const t = String.fromCharCode(b[p++]);
      switch (t) {
        case "Y":
          node.props.push(dv.getInt16(p, true)), (p += 2);
          break;
        case "C":
          node.props.push(b[p]), (p += 1);
          break;
        case "I":
          node.props.push(dv.getInt32(p, true)), (p += 4);
          break;
        case "F":
          node.props.push(dv.getFloat32(p, true)), (p += 4);
          break;
        case "D":
          node.props.push(dv.getFloat64(p, true)), (p += 8);
          break;
        case "L":
          node.props.push(Number(dv.getBigInt64(p, true))), (p += 8);
          break;
        case "S":
        case "R": {
          const n = dv.getUint32(p, true);
          const raw = b.subarray(p + 4, p + 4 + n);
          node.props.push(t === "S" ? dec.decode(raw) : raw);
          p += 4 + n;
          break;
        }
        case "f":
        case "d":
        case "l":
        case "i":
        case "b": {
          const n = dv.getUint32(p, true);
          const enc = dv.getUint32(p + 4, true);
          const clen = dv.getUint32(p + 8, true);
          const raw = b.subarray(p + 12, p + 12 + clen);
          p += 12 + clen;
          if (enc === 1) {
            const pd: Pending = { z: raw, t, n };
            pending.push({ node, i: node.props.length, p: pd });
            node.props.push(pd);
          } else node.props.push(typedArray(t, raw, n));
          break;
        }
        default:
          throw new GltfError("format", `FBX property ${t}`);
      }
    }
    while (p < end) {
      const r = readNode(p);
      p = r.next;
      if (!r.node) break;
      node.kids.push(r.node);
    }
    return { node, next: end };
  };
  const root: FbxNode = { name: "", props: [], kids: [] };
  let o = 27;
  while (o + head <= b.length) {
    const r = readNode(o);
    if (!r.node) break;
    root.kids.push(r.node);
    o = r.next;
  }
  return { root, version, pending };
}

function typedArray(t: string, raw: Uint8Array, n: number): ArrayLike<number> {
  const size = t === "d" || t === "l" ? 8 : t === "b" ? 1 : 4;
  const copy = raw.slice(0, n * size);
  if (copy.length < n * size) throw new GltfError("format", "FBX array");
  switch (t) {
    case "f":
      return new Float32Array(copy.buffer);
    case "d":
      return new Float64Array(copy.buffer);
    case "i":
      return new Int32Array(copy.buffer);
    case "l":
      return Array.from(new BigInt64Array(copy.buffer), Number);
    default:
      return copy;
  }
}

async function inflate(z: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate");
  const stream = new Blob([z as BlobPart]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ---------- ASCII ----------

function parseAscii(text: string): { root: FbxNode; version: number } {
  const root: FbxNode = { name: "", props: [], kids: [] };
  const stack: FbxNode[] = [root];
  const n = text.length;
  let i = 0;
  let cur: FbxNode | null = null;
  let expectValue = false;
  const ws = (c: string) => c === " " || c === "\t" || c === "\r";
  while (i < n) {
    const c = text[i];
    if (ws(c)) {
      i++;
      continue;
    }
    if (c === ";") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (c === "\n") {
      if (!expectValue) cur = null;
      i++;
      continue;
    }
    if (c === "{") {
      if (cur) stack.push(cur);
      cur = null;
      expectValue = false;
      i++;
      continue;
    }
    if (c === "}") {
      const done = stack.length > 1 ? stack.pop()! : null;
      // `*N { a: … }` 的数组节点：把 a 的值收成一个数组属性
      if (done && typeof done.props[0] === "string" && /^\*\d+$/.test(done.props[0] as string)) {
        const a = done.kids.find((k) => k.name === "a");
        done.props = [Float64Array.from((a?.props ?? []) as number[])];
        done.kids = done.kids.filter((k) => k !== a);
      }
      cur = null;
      expectValue = false;
      i++;
      continue;
    }
    if (c === ",") {
      expectValue = true;
      i++;
      continue;
    }
    if (c === '"') {
      const e = text.indexOf('"', i + 1);
      const s = text.slice(i + 1, e < 0 ? n : e).replace(/&quot;/g, '"');
      cur?.props.push(s);
      expectValue = false;
      i = e < 0 ? n : e + 1;
      continue;
    }
    // 名字 / 数 / 裸字面量 / *N
    let j = i;
    while (j < n && !ws(text[j]) && !",{}\n;\"".includes(text[j])) j++;
    const tok = text.slice(i, j);
    i = j;
    if (tok.endsWith(":") && !expectValue) {
      const node: FbxNode = { name: tok.slice(0, -1), props: [], kids: [] };
      stack[stack.length - 1].kids.push(node);
      cur = node;
      continue;
    }
    if (!cur) continue;
    const num = Number(tok);
    cur.props.push(tok !== "" && Number.isFinite(num) && !/^\*/.test(tok) ? num : tok);
    expectValue = false;
  }
  const ver = root.kids.find((k) => k.name === "FBXHeaderExtension")?.kids.find((k) => k.name === "FBXVersion")?.props[0];
  const m = /FBX (\d+)\.(\d+)\.(\d+)/.exec(text.slice(0, 200));
  const version = typeof ver === "number" ? ver : m ? +m[1] * 1000 + +m[2] * 100 + +m[3] : 0;
  return { root, version };
}

// ---------- 通用访问 ----------

const kid = (n: FbxNode | undefined, name: string) => n?.kids.find((k) => k.name === name);
const kidsOf = (n: FbxNode | undefined, name: string) => n?.kids.filter((k) => k.name === name) ?? [];
const arr = (n: FbxNode | undefined): ArrayLike<number> => {
  const v = n?.props[0];
  if (v && typeof v === "object" && "length" in v) return v as ArrayLike<number>;
  return (n?.props.filter((x) => typeof x === "number") ?? []) as number[];
};
const str = (n: FbxNode | undefined, i = 0) => {
  const v = n?.props[i];
  return typeof v === "string" ? v : "";
};
/** "Name\0\1Class"（二进制）或 "Class::Name"（ASCII）→ Name */
const objName = (s: string) => {
  const z = s.indexOf("\u0000\u0001");
  if (z >= 0) return s.slice(0, z);
  const c = s.indexOf("::");
  return c >= 0 ? s.slice(c + 2) : s;
};

type P70 = Map<string, Val[]>;
function props70(n: FbxNode | undefined): P70 {
  const m: P70 = new Map();
  for (const p of kidsOf(kid(n, "Properties70"), "P")) m.set(str(p), p.props.slice(4));
  return m;
}
const vec = (m: P70, k: string, d: number[]): number[] => {
  const v = m.get(k);
  return v && v.length >= 3 ? [Number(v[0]), Number(v[1]), Number(v[2])] : d;
};
const num = (m: P70, k: string, d: number): number => {
  const v = m.get(k);
  return v && v.length ? Number(v[0]) : d;
};

const D2R = Math.PI / 180;
/** FBX 欧拉（度），RotationOrder：0 XYZ（先 X）… 5 ZYX */
function euler(r: number[], order = 0): number[] {
  const [x, y, z] = [m4rot(0, r[0] * D2R), m4rot(1, r[1] * D2R), m4rot(2, r[2] * D2R)];
  const seq = [[x, y, z], [x, z, y], [y, z, x], [y, x, z], [z, x, y], [z, y, x]][order] ?? [x, y, z];
  return m4mul(seq[2], m4mul(seq[1], seq[0]));
}

type Xf = { t: number[]; r: number[]; s: number[]; order: number; pre: number[]; post: number[]; roff: number[]; rp: number[]; soff: number[]; sp: number[] };
function localMatrix(x: Xf): number[] {
  const R = euler(x.r, x.order);
  const pre = euler(x.pre);
  const postInv = m4inv(euler(x.post)) ?? [...IDENT];
  const rp = m4translate(x.rp[0], x.rp[1], x.rp[2]);
  const rpInv = m4translate(-x.rp[0], -x.rp[1], -x.rp[2]);
  const sp = m4translate(x.sp[0], x.sp[1], x.sp[2]);
  const spInv = m4translate(-x.sp[0], -x.sp[1], -x.sp[2]);
  const chain = [m4translate(x.t[0], x.t[1], x.t[2]), m4translate(x.roff[0], x.roff[1], x.roff[2]), rp, pre, R, postInv, rpInv, m4translate(x.soff[0], x.soff[1], x.soff[2]), sp, m4scale(x.s[0], x.s[1], x.s[2]), spInv];
  return chain.reduce((a, m) => m4mul(a, m));
}

// ---------- 主体 ----------

/** 文件 → 节点树（二进制解压数组 / ASCII 收数组） */
export async function readFbxTree(bytes: Uint8Array): Promise<{ root: FbxNode; version: number }> {
  if (bytes.length > 27 && dec.decode(bytes.subarray(0, 20)) === BIN_MAGIC) {
    const r = parseBinary(bytes);
    const out = await Promise.all(r.pending.map((x) => inflate(x.p.z)));
    r.pending.forEach((x, k) => (x.node.props[x.i] = typedArray(x.p.t, out[k], x.p.n)));
    return { root: r.root, version: r.version };
  }
  const text = decodeText(bytes);
  if (!/^\s*;\s*FBX|FBXHeaderExtension\s*:/.test(text.slice(0, 4096))) throw new GltfError("format", "FBX");
  return parseAscii(text);
}

export async function parseFbx(bytes: Uint8Array, resolve: (n: string) => Uint8Array | null = () => null): Promise<ModelIR> {
  const { root, version } = await readFbxTree(bytes);
  if (version && version < 7000) throw new GltfError("version", `FBX ${(version / 1000).toFixed(1)}`);
  const warnings: IRWarning[] = [];
  const warned = new Set<string>();
  const warn = (code: string, detail?: string) => {
    const k = `${code}|${detail ?? ""}`;
    if (!warned.has(k)) warned.add(k), warnings.push({ code, detail });
  };

  // 对象与连接
  type Obj = { id: number; name: string; cls: string; sub: string; node: FbxNode };
  const objs = new Map<number, Obj>();
  for (const o of kid(root, "Objects")?.kids ?? []) {
    const id = o.props[0];
    if (typeof id !== "number") continue;
    objs.set(id, { id, name: objName(str(o, 1)), cls: o.name, sub: str(o, 2), node: o });
  }
  type Conn = { kind: string; child: number; parent: number; prop: string };
  const conns: Conn[] = [];
  for (const c of kidsOf(kid(root, "Connections"), "C")) {
    const [kind, a, b, prop] = c.props;
    if (typeof a === "number" && typeof b === "number") conns.push({ kind: String(kind), child: a, parent: b, prop: typeof prop === "string" ? prop : "" });
  }
  const parentsOf = (id: number, cls?: string) => conns.filter((c) => c.child === id && (!cls || objs.get(c.parent)?.cls === cls));
  const childrenOf = (id: number, cls?: string) => conns.filter((c) => c.parent === id && (!cls || objs.get(c.child)?.cls === cls));

  // 轴向 / 单位
  const gs = props70(kid(root, "GlobalSettings"));
  const axis = (k: string, sk: string, d: number, ds: number) => {
    const a = num(gs, k, d), s = num(gs, sk, ds) < 0 ? -1 : 1;
    const v = [0, 0, 0];
    v[a] = s;
    return v;
  };
  const up = axis("UpAxis", "UpAxisSign", 1, 1);
  const front = axis("FrontAxis", "FrontAxisSign", 2, 1);
  const coord = axis("CoordAxis", "CoordAxisSign", 0, 1);
  const unit = num(gs, "UnitScaleFactor", 1) / 100;
  // 行 = 目标的 X（coord）/ Y（up）/ Z（front），列主序存放
  let rootM: number[] = [coord[0], up[0], front[0], 0, coord[1], up[1], front[1], 0, coord[2], up[2], front[2], 0, 0, 0, 0, 1];
  if (Math.abs(unit - 1) > 1e-9 && unit > 0) rootM = m4mul(m4scale(unit, unit, unit), rootM);
  const needRoot = rootM.some((v, i) => Math.abs(v - IDENT[i]) > 1e-9);

  // 模型节点
  const nodes: IRNode[] = [];
  if (needRoot) nodes.push({ name: "Scene", parent: -1, matrix: rootM });
  const rootIdx = needRoot ? 0 : -1;
  const models = [...objs.values()].filter((o) => o.cls === "Model");
  const modelIdx = new Map<number, number>();
  const xfOf = new Map<number, Xf>();
  const geomXf = new Map<number, number[]>();
  for (const m of models) {
    const p = props70(m.node);
    xfOf.set(m.id, {
      t: vec(p, "Lcl Translation", [0, 0, 0]),
      r: vec(p, "Lcl Rotation", [0, 0, 0]),
      s: vec(p, "Lcl Scaling", [1, 1, 1]),
      order: num(p, "RotationOrder", 0),
      pre: vec(p, "PreRotation", [0, 0, 0]),
      post: vec(p, "PostRotation", [0, 0, 0]),
      roff: vec(p, "RotationOffset", [0, 0, 0]),
      rp: vec(p, "RotationPivot", [0, 0, 0]),
      soff: vec(p, "ScalingOffset", [0, 0, 0]),
      sp: vec(p, "ScalingPivot", [0, 0, 0]),
    });
    const gt = vec(p, "GeometricTranslation", [0, 0, 0]), gr = vec(p, "GeometricRotation", [0, 0, 0]), gsc = vec(p, "GeometricScaling", [1, 1, 1]);
    const g = m4mul(m4translate(gt[0], gt[1], gt[2]), m4mul(euler(gr), m4scale(gsc[0], gsc[1], gsc[2])));
    if (g.some((v, i) => Math.abs(v - IDENT[i]) > 1e-9)) geomXf.set(m.id, g);
  }
  // 父在前：按连接深度排序
  const modelParent = (id: number) => parentsOf(id, "Model").find((c) => c.kind === "OO")?.parent;
  const depth = (id: number) => {
    let d = 0;
    for (let p = modelParent(id), guard = 0; p !== undefined && guard < 256; p = modelParent(p), guard++) d++;
    return d;
  };
  for (const m of [...models].sort((a, b) => depth(a.id) - depth(b.id))) {
    const par = modelParent(m.id);
    modelIdx.set(m.id, nodes.length);
    nodes.push({ name: m.name || `Model${nodes.length}`, parent: par !== undefined && modelIdx.has(par) ? modelIdx.get(par)! : rootIdx, matrix: localMatrix(xfOf.get(m.id)!) });
  }
  const worldFile = (id: number): number[] => {
    const chain: number[] = [];
    for (let p: number | undefined = id, g = 0; p !== undefined && g < 256; p = modelParent(p), g++) chain.unshift(p);
    return chain.reduce<number[]>((a, x) => m4mul(a, localMatrix(xfOf.get(x)!)), [...IDENT]);
  };

  // 材质
  const materials: IRMaterial[] = [];
  const matIdx = new Map<number, number>();
  const videoBytes = (texId: number): Uint8Array | null => {
    for (const c of childrenOf(texId, "Video")) {
      const cp = kid(objs.get(c.child)!.node, "Content")?.props ?? [];
      const raw = cp.find((x) => x instanceof Uint8Array);
      if (raw instanceof Uint8Array && raw.length > 8) return raw;
      // ASCII：base64，可能拆成多段字符串
      const content = cp.filter((x) => typeof x === "string").join("");
      if (content.length > 8) {
        try {
          return Uint8Array.from(atob(content), (ch) => ch.charCodeAt(0));
        } catch {
          /* 不是 base64 */
        }
      }
    }
    return null;
  };
  const materialOf = (id: number): number => {
    const hit = matIdx.get(id);
    if (hit !== undefined) return hit;
    const o = objs.get(id)!;
    const p = props70(o.node);
    const c = vec(p, "DiffuseColor", vec(p, "Diffuse", [0.8, 0.8, 0.8]));
    const f = num(p, "DiffuseFactor", 1);
    const m: IRMaterial = { name: o.name, color: [c[0] * f, c[1] * f, c[2] * f, 1] };
    const opacity = p.has("Opacity") ? num(p, "Opacity", 1) : 1 - num(p, "TransparencyFactor", 0) * (p.has("TransparentColor") ? vec(p, "TransparentColor", [1, 1, 1])[0] : 1);
    if (opacity > 0.01 && opacity < 0.999) ((m.color as number[])[3] = opacity), (m.blend = true);
    const texConn = childrenOf(id, "Texture").find((x) => /diffuse|base ?color/i.test(x.prop)) ?? childrenOf(id, "Texture")[0];
    if (texConn) {
      const tex = objs.get(texConn.child)!;
      const rel = str(kid(tex.node, "RelativeFilename")) || str(kid(tex.node, "FileName"));
      const embedded = videoBytes(tex.id);
      m.image = embedded ? { name: (rel.split(/[\\/]/).pop() || `${tex.name}.png`), bytes: embedded } : findImage(rel, resolve);
      if (!m.image.bytes) warn("missingFile", rel);
      m.color = [1, 1, 1, (m.color as number[])[3]];
    }
    materials.push(m);
    matIdx.set(id, materials.length - 1);
    return materials.length - 1;
  };
  let defaultMat = -1;
  const fallbackMat = () => {
    if (defaultMat < 0) materials.push({ name: "default", color: [0.8, 0.8, 0.8, 1] }), (defaultMat = materials.length - 1);
    return defaultMat;
  };

  // 几何
  type Layer = { data: ArrayLike<number>; index: ArrayLike<number> | null; map: string; ref: string; size: number };
  const layer = (g: FbxNode, name: string, dataKey: string, idxKey: string, size: number): Layer | null => {
    const l = kid(g, name);
    if (!l) return null;
    const data = arr(kid(l, dataKey));
    if (!data.length) return null;
    return { data, index: kid(l, idxKey) ? arr(kid(l, idxKey)) : null, map: str(kid(l, "MappingInformationType")), ref: str(kid(l, "ReferenceInformationType")), size };
  };
  const pick = (l: Layer, pvi: number, vi: number, poly: number): number => {
    const k = l.map === "ByPolygonVertex" ? pvi : l.map === "ByPolygon" ? poly : l.map === "AllSame" ? 0 : vi;
    return l.ref === "IndexToDirect" || l.ref === "Index" ? (l.index?.[k] ?? k) : k;
  };
  const skins: IRSkin[] = [];
  let meshCount = 0;
  const bindPose = new Map<number, number[]>();
  for (const pose of [...objs.values()].filter((o) => o.cls === "Pose" && /bind/i.test(o.sub || str(kid(o.node, "Type"))))) {
    for (const pn of kidsOf(pose.node, "PoseNode")) {
      const id = kid(pn, "Node")?.props[0];
      const m = arr(kid(pn, "Matrix"));
      if (typeof id === "number" && m.length === 16 && !bindPose.has(id)) bindPose.set(id, Array.from(m));
    }
  }
  for (const g of [...objs.values()].filter((o) => o.cls === "Geometry")) {
    if (g.sub === "Shape") continue;
    if (g.sub !== "Mesh") {
      warn("unsupportedGeometry", `${g.name} (${g.sub})`);
      continue;
    }
    const owner = parentsOf(g.id, "Model")[0];
    if (!owner) continue;
    const ownerIdx = modelIdx.get(owner.parent)!;
    const vtx = arr(kid(g.node, "Vertices"));
    const pvIdx = arr(kid(g.node, "PolygonVertexIndex"));
    if (!vtx.length || !pvIdx.length) continue;
    const nl = layer(g.node, "LayerElementNormal", "Normals", "NormalsIndex", 3) ?? layer(g.node, "LayerElementNormal", "Normals", "NormalIndex", 3);
    const ul = layer(g.node, "LayerElementUV", "UV", "UVIndex", 2);
    const ml = layer(g.node, "LayerElementMaterial", "Materials", "", 1);
    const modelMats = childrenOf(owner.parent, "Material").map((c) => c.child);
    if (childrenOf(g.id, "Deformer").some((c) => objs.get(c.child)?.sub === "BlendShape")) warn("morph", g.name);
    // 多边形 → 按材质分组的三角形，去重键 = 控制点 / 法线下标 / UV 下标
    type Grp = { pos: number[]; nrm: number[]; uv: number[]; idx: number[]; cp: number[]; map: Map<string, number> };
    const groups = new Map<number, Grp>();
    let poly = 0;
    let ring: Array<{ vi: number; pvi: number }> = [];
    for (let k = 0; k < pvIdx.length; k++) {
      let vi = pvIdx[k];
      const last = vi < 0;
      if (last) vi = ~vi;
      ring.push({ vi, pvi: k });
      if (!last) continue;
      const mLocal = ml ? (ml.map === "AllSame" ? ml.data[0] : ml.data[poly] ?? 0) : 0;
      const matId = modelMats[mLocal] ?? modelMats[0];
      const mi = matId !== undefined ? materialOf(matId) : fallbackMat();
      let grp = groups.get(mi);
      if (!grp) groups.set(mi, (grp = { pos: [], nrm: [], uv: [], idx: [], cp: [], map: new Map() }));
      const out: number[] = [];
      for (const { vi: v, pvi } of ring) {
        if (v * 3 + 2 >= vtx.length) continue;
        const ni = nl ? pick(nl, pvi, v, poly) : -1;
        const ti = ul ? pick(ul, pvi, v, poly) : -1;
        const n3 = nl ? [nl.data[ni * 3] ?? 0, nl.data[ni * 3 + 1] ?? 0, nl.data[ni * 3 + 2] ?? 1] : null;
        const t2 = ul ? [ul.data[ti * 2] ?? 0, 1 - (ul.data[ti * 2 + 1] ?? 0)] : null;
        // 按值去重：逐角直存（ByPolygonVertex + Direct）的文件下标各不相同
        const key = `${v}/${n3?.join(",")}/${t2?.join(",")}`;
        let o = grp.map.get(key);
        if (o === undefined) {
          o = grp.cp.length;
          grp.map.set(key, o);
          grp.cp.push(v);
          grp.pos.push(vtx[v * 3], vtx[v * 3 + 1], vtx[v * 3 + 2]);
          if (n3) grp.nrm.push(...n3);
          if (t2) grp.uv.push(...t2);
        }
        out.push(o);
      }
      for (let q = 1; q + 1 < out.length; q++) grp.idx.push(out[0], out[q], out[q + 1]);
      ring = [];
      poly++;
    }
    const gx = geomXf.get(owner.parent);
    // 蒙皮
    const skinDef = childrenOf(g.id, "Deformer").map((c) => objs.get(c.child)!).find((o) => o.sub === "Skin");
    const clusters = skinDef ? childrenOf(skinDef.id, "Deformer").map((c) => objs.get(c.child)!).filter((o) => o.sub === "Cluster") : [];
    let skinIdx: number | undefined;
    const infl = new Map<number, Array<[number, number]>>();
    const joints: number[] = [];
    const ibm: number[][] = [];
    for (const cl of clusters) {
      const bone = parentsOf(cl.id, "Model")[0] ?? childrenOf(cl.id, "Model")[0];
      const boneId = bone ? (bone.parent === cl.id ? bone.child : bone.parent) : undefined;
      if (boneId === undefined || !modelIdx.has(boneId)) continue;
      const idx = arr(kid(cl.node, "Indexes"));
      const w = arr(kid(cl.node, "Weights"));
      // 簇的 Transform 字段各家写法不一（Blender 写 TransformLink⁻¹·网格世界），网格绑定矩阵取 BindPose / 当前世界
      const TL = arr(kid(cl.node, "TransformLink"));
      const tl = TL.length === 16 ? Array.from(TL) : bindPose.get(boneId) ?? worldFile(boneId);
      const t = bindPose.get(owner.parent) ?? worldFile(owner.parent);
      const j = joints.length;
      joints.push(modelIdx.get(boneId)!);
      ibm.push(m4mul(m4inv(tl) ?? [...IDENT], t));
      for (let q = 0; q < idx.length; q++) {
        if (!(w[q] > 0)) continue;
        const list = infl.get(idx[q]) ?? [];
        list.push([j, w[q]]);
        infl.set(idx[q], list);
      }
    }
    if (joints.length) {
      // 没被任何簇覆盖的控制点跟网格节点走（关节 = 网格节点本身，IBM = 单位）
      let selfJoint = -1;
      for (const grp of groups.values()) for (const v of grp.cp) if (!infl.get(v)?.length && selfJoint < 0) {
        selfJoint = joints.length;
        joints.push(ownerIdx);
        ibm.push([...IDENT]);
      }
      if ([...infl.values()].some((l) => l.length > 4)) warn("influences", g.name);
      skins.push({ joints, ibm });
      skinIdx = skins.length - 1;
      const prims: IRPrim[] = [];
      for (const [mi, grp] of groups) {
        if (grp.idx.length < 3) continue;
        const n = grp.cp.length;
        const jj = new Uint16Array(n * 4);
        const ww = new Float32Array(n * 4);
        for (let i = 0; i < n; i++) {
          const list = [...(infl.get(grp.cp[i]) ?? [])].sort((a, b) => b[1] - a[1]).slice(0, 4);
          const sum = list.reduce((s, x) => s + x[1], 0);
          if (!sum) {
            jj[i * 4] = selfJoint;
            ww[i * 4] = 1;
            continue;
          }
          list.forEach(([j, w], q) => ((jj[i * 4 + q] = j), (ww[i * 4 + q] = w / sum)));
        }
        const pos = gx ? transformPositions(gx, grp.pos) : grp.pos;
        prims.push({ material: mi, positions: pos, normals: grp.nrm.length ? (gx ? transformNormals(gx, grp.nrm) : grp.nrm) : computeNormals(pos, grp.idx), uvs: grp.uv.length ? grp.uv : null, indices: grp.idx, joints: jj, weights: ww });
      }
      attachMesh(ownerIdx, prims, skinIdx);
    } else {
      if (skinDef) warn("skinJoints", g.name);
      const prims: IRPrim[] = [];
      for (const [mi, grp] of groups) {
        if (grp.idx.length < 3) continue;
        const pos = gx ? transformPositions(gx, grp.pos) : grp.pos;
        prims.push({ material: mi, positions: pos, normals: grp.nrm.length ? (gx ? transformNormals(gx, grp.nrm) : grp.nrm) : computeNormals(pos, grp.idx), uvs: grp.uv.length ? grp.uv : null, indices: grp.idx });
      }
      attachMesh(ownerIdx, prims);
    }
  }
  function attachMesh(at: number, prims: IRPrim[], skin?: number) {
    if (!prims.length) return;
    let n = at;
    if (nodes[at].mesh?.length) {
      nodes.push({ name: `${nodes[at].name}_${nodes.length}`, parent: at, matrix: [...IDENT] });
      n = nodes.length - 1;
    }
    nodes[n].mesh = prims;
    if (skin !== undefined) nodes[n].skin = skin;
    meshCount++;
  }
  if (!meshCount) throw new GltfError("noMesh");

  // 动画
  const anims: IRAnim[] = [];
  const FPS = 30;
  for (const stack of [...objs.values()].filter((o) => o.cls === "AnimationStack")) {
    const sp = props70(stack.node);
    const start = num(sp, "LocalStart", num(sp, "ReferenceStart", 0)) / TICKS;
    const layers = childrenOf(stack.id, "AnimationLayer").map((c) => c.child);
    if (layers.length > 1) warn("animLayers", stack.name);
    const lay = layers[0];
    if (lay === undefined) continue;
    type Curve = { times: number[]; values: number[] };
    // 模型 → 属性（Lcl Translation / Rotation / Scaling）→ 分量曲线 + 默认值
    const per = new Map<number, Map<string, { def: number[]; curves: Array<Curve | null> }>>();
    let tMax = 0;
    for (const cn of childrenOf(lay, "AnimationCurveNode")) {
      const cnode = objs.get(cn.child)!;
      const target = parentsOf(cnode.id, "Model").find((c) => c.kind === "OP");
      if (!target || !/^Lcl (Translation|Rotation|Scaling)$/.test(target.prop)) continue;
      const p = props70(cnode.node);
      const def = [num(p, "d|X", NaN), num(p, "d|Y", NaN), num(p, "d|Z", NaN)];
      const curves: Array<Curve | null> = [null, null, null];
      for (const cc of childrenOf(cnode.id, "AnimationCurve")) {
        const k = ["d|X", "d|Y", "d|Z"].indexOf(cc.prop);
        if (k < 0) continue;
        const cv = objs.get(cc.child)!.node;
        const times = Array.from(arr(kid(cv, "KeyTime")), (t) => t / TICKS - start);
        const values = Array.from(arr(kid(cv, "KeyValueFloat")));
        if (!times.length || times.length !== values.length) continue;
        curves[k] = { times, values };
        tMax = Math.max(tMax, times[times.length - 1]);
      }
      let slot = per.get(target.parent);
      if (!slot) per.set(target.parent, (slot = new Map()));
      slot.set(target.prop, { def, curves });
    }
    if (!per.size) continue;
    const frames = Math.max(1, Math.round(tMax * FPS));
    const times = Array.from({ length: frames + 1 }, (_, f) => f / FPS);
    const sample = (c: Curve, t: number) => {
      const { times: ts, values: vs } = c;
      if (t <= ts[0]) return vs[0];
      if (t >= ts[ts.length - 1]) return vs[vs.length - 1];
      let k = 0;
      while (k + 1 < ts.length && ts[k + 1] < t) k++;
      const a = (t - ts[k]) / (ts[k + 1] - ts[k] || 1);
      return vs[k] * (1 - a) + vs[k + 1] * a;
    };
    const channels: IRChannel[] = [];
    for (const [mid, slot] of per) {
      const ni = modelIdx.get(mid);
      const base = xfOf.get(mid);
      if (ni === undefined || !base) continue;
      const T: number[] = [], R: number[] = [], S: number[] = [];
      let prevQ: number[] | null = null;
      const comp = (prop: string, rest: number[], t: number) => {
        const a = slot.get(prop);
        if (!a) return rest;
        return rest.map((r, k) => (a.curves[k] ? sample(a.curves[k]!, t) : Number.isFinite(a.def[k]) ? a.def[k] : r));
      };
      for (const t of times) {
        const x: Xf = { ...base, t: comp("Lcl Translation", base.t, t), r: comp("Lcl Rotation", base.r, t), s: comp("Lcl Scaling", base.s, t) };
        const d = decompose(localMatrix(x));
        const q = [...d.r];
        if (prevQ && prevQ[0] * q[0] + prevQ[1] * q[1] + prevQ[2] * q[2] + prevQ[3] * q[3] < 0) for (let i = 0; i < 4; i++) q[i] = -q[i];
        prevQ = q;
        T.push(...d.t);
        R.push(...q);
        S.push(...d.s);
      }
      channels.push({ node: ni, path: "translation", times, values: T }, { node: ni, path: "rotation", times, values: R }, { node: ni, path: "scale", times, values: S });
    }
    if (channels.length) anims.push({ name: stack.name || `Take ${anims.length + 1}`, channels });
  }
  return { nodes, materials, skins, anims, warnings };
}
