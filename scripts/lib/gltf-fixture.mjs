// W19 测试夹具：程序化生成 glTF（不入库第三方模型）+ 与导入器无关的独立参考求值。
// 参考求值直接用生成时的原始数组（不经访问器解析），按 glTF 2.0 规范算节点全局矩阵与蒙皮顶点。
import zlib from "node:zlib";

const enc = new TextEncoder();

// ---------- 小工具：列主序 4×4 ----------
export function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}
export function trs(t = [0, 0, 0], q = [0, 0, 0, 1], s = [1, 1, 1]) {
  const [x, y, z, w] = q;
  return [
    (1 - 2 * (y * y + z * z)) * s[0], 2 * (x * y + w * z) * s[0], 2 * (x * z - w * y) * s[0], 0,
    2 * (x * y - w * z) * s[1], (1 - 2 * (x * x + z * z)) * s[1], 2 * (y * z + w * x) * s[1], 0,
    2 * (x * z + w * y) * s[2], 2 * (y * z - w * x) * s[2], (1 - 2 * (x * x + y * y)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}
export function inv(m) {
  const a = [...m];
  const o = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (let c = 0; c < 4; c++) {
    let p = c;
    for (let r = c + 1; r < 4; r++) if (Math.abs(a[c * 4 + r]) > Math.abs(a[c * 4 + p])) p = r;
    for (let k = 0; k < 4; k++) {
      [a[k * 4 + c], a[k * 4 + p]] = [a[k * 4 + p], a[k * 4 + c]];
      [o[k * 4 + c], o[k * 4 + p]] = [o[k * 4 + p], o[k * 4 + c]];
    }
    const d = a[c * 4 + c];
    for (let k = 0; k < 4; k++) (a[k * 4 + c] /= d), (o[k * 4 + c] /= d);
    for (let r = 0; r < 4; r++) {
      if (r === c) continue;
      const f = a[c * 4 + r];
      for (let k = 0; k < 4; k++) (a[k * 4 + r] -= f * a[k * 4 + c]), (o[k * 4 + r] -= f * o[k * 4 + c]);
    }
  }
  return o;
}
export const axisQuat = (ax, ang) => {
  const s = Math.sin(ang / 2);
  const l = Math.hypot(...ax);
  return [(ax[0] / l) * s, (ax[1] / l) * s, (ax[2] / l) * s, Math.cos(ang / 2)];
};
const nq = (q) => {
  const l = Math.hypot(...q);
  return q.map((v) => v / l);
};
function slerp(a, b, t) {
  let d = a.reduce((s, v, i) => s + v * b[i], 0);
  let bb = b;
  if (d < 0) (d = -d), (bb = b.map((v) => -v));
  if (d > 0.9995) return nq(a.map((v, i) => v + (bb[i] - v) * t));
  const th = Math.acos(d);
  return nq(a.map((v, i) => (v * Math.sin((1 - t) * th) + bb[i] * Math.sin(t * th)) / Math.sin(th)));
}

// ---------- 参考求值 ----------
/** 规范求值：channel = {node, path, times, values(扁平), interp, size} */
function sampleRef(ch, t) {
  const { times, values, size, interp } = ch;
  const n = times.length;
  const cubic = interp === "CUBICSPLINE";
  const v = (k) => values.slice(cubic ? (3 * k + 1) * size : k * size, (cubic ? (3 * k + 1) * size : k * size) + size);
  if (t <= times[0]) return v(0);
  if (t >= times[n - 1]) return v(n - 1);
  let k = 0;
  while (t >= times[k + 1]) k++;
  const dt = times[k + 1] - times[k];
  const u = (t - times[k]) / dt;
  if (interp === "STEP") return v(k);
  if (cubic) {
    const b = values.slice((3 * k + 2) * size, (3 * k + 3) * size);
    const a = values.slice(3 * (k + 1) * size, (3 * (k + 1) + 1) * size);
    const p0 = v(k);
    const p1 = v(k + 1);
    const r = p0.map((_, i) => (2 * u ** 3 - 3 * u ** 2 + 1) * p0[i] + (u ** 3 - 2 * u ** 2 + u) * dt * b[i] + (-2 * u ** 3 + 3 * u ** 2) * p1[i] + (u ** 3 - u ** 2) * dt * a[i]);
    return ch.path === "rotation" ? nq(r) : r;
  }
  return ch.path === "rotation" ? slerp(v(k), v(k + 1), u) : v(k).map((x, i) => x + (v(k + 1)[i] - x) * u);
}

/** 节点全局矩阵（anim = null 取静止姿势） */
export function refGlobals(src, anim, t) {
  const local = src.nodes.map((n, i) => {
    const p = { t: n.t ?? [0, 0, 0], r: n.r ?? [0, 0, 0, 1], s: n.s ?? [1, 1, 1] };
    const chs = (anim?.channels ?? []).filter((ch) => ch.node === i);
    if (n.matrix && !chs.length) return n.matrix;
    for (const ch of chs) p[{ translation: "t", rotation: "r", scale: "s" }[ch.path]] = sampleRef(ch, t);
    return trs(p.t, p.r, p.s);
  });
  const g = [];
  const at = (i) => g[i] ?? (g[i] = src.nodes[i].parent >= 0 ? mul(at(src.nodes[i].parent), local[i]) : local[i]);
  src.nodes.forEach((_, i) => at(i));
  return g;
}

/** 参考顶点：蒙皮网格 Σ w·G_j·IBM_j·v（忽略网格节点自身变换），非蒙皮网格 G_node·v；乘 scale */
export function refVertices(src, anim, t, scale = 1) {
  const g = refGlobals(src, anim, t);
  const out = [];
  for (const m of src.meshes) {
    const n = m.positions.length / 3;
    for (let v = 0; v < n; v++) {
      const p = [m.positions[v * 3], m.positions[v * 3 + 1], m.positions[v * 3 + 2]];
      let x = 0, y = 0, z = 0;
      const infl = m.skin
        ? m.joints.slice(v * 4, v * 4 + 4).map((j, k) => [mul(g[src.skins[m.skin - 1].joints[j]], src.skins[m.skin - 1].ibm[j]), m.weights[v * 4 + k]])
        : [[g[m.node], 1]];
      const tw = infl.reduce((s, [, w]) => s + w, 0);
      for (const [M, w] of infl) {
        x += (w / tw) * (M[0] * p[0] + M[4] * p[1] + M[8] * p[2] + M[12]);
        y += (w / tw) * (M[1] * p[0] + M[5] * p[1] + M[9] * p[2] + M[13]);
        z += (w / tw) * (M[2] * p[0] + M[6] * p[1] + M[10] * p[2] + M[14]);
      }
      out.push(x * scale, y * scale, z * scale);
    }
  }
  return out;
}

// ---------- 打包 ----------
export function makePng(w, h, pixel) {
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) Buffer.from(pixel(x, y)).copy(raw, y * (1 + w * 4) + 1 + x * 4);
  const crcT = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b) => {
    let c = 0xffffffff;
    for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, body) => {
    const o = Buffer.alloc(12 + body.length);
    o.writeUInt32BE(body.length, 0);
    o.write(type, 4, "latin1");
    body.copy(o, 8);
    o.writeUInt32BE(crc(o.subarray(4, 8 + body.length)), 8 + body.length);
    return o;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}

class Bin {
  constructor() {
    this.parts = [];
    this.len = 0;
    this.views = [];
    this.accessors = [];
  }
  view(bytes) {
    const pad = (4 - (this.len % 4)) % 4;
    if (pad) this.parts.push(new Uint8Array(pad)), (this.len += pad);
    this.views.push({ buffer: 0, byteOffset: this.len, byteLength: bytes.length });
    this.parts.push(bytes);
    this.len += bytes.length;
    return this.views.length - 1;
  }
  acc(arr, type, extra = {}) {
    const ct = arr instanceof Float32Array ? 5126 : arr instanceof Uint16Array ? 5123 : arr instanceof Uint8Array ? 5121 : arr instanceof Uint32Array ? 5125 : arr instanceof Int16Array ? 5122 : 5120;
    const size = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[type];
    const bufferView = this.view(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength));
    const a = { bufferView, componentType: ct, count: arr.length / size, type, ...extra };
    if (type === "SCALAR" && ct === 5126) (a.min = [Math.min(...arr)]), (a.max = [Math.max(...arr)]);
    this.accessors.push(a);
    return this.accessors.length - 1;
  }
  bytes() {
    const out = new Uint8Array(this.len + ((4 - (this.len % 4)) % 4));
    let o = 0;
    for (const p of this.parts) out.set(p, o), (o += p.length);
    return out;
  }
}

export function packGlb(json, bin) {
  const j = enc.encode(JSON.stringify(json));
  const jp = new Uint8Array(j.length + ((4 - (j.length % 4)) % 4)).fill(0x20);
  jp.set(j);
  const total = 12 + 8 + jp.length + (bin ? 8 + bin.length : 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jp.length, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(jp, 20);
  if (bin) {
    dv.setUint32(20 + jp.length, bin.length, true);
    dv.setUint32(24 + jp.length, 0x004e4942, true);
    out.set(bin, 28 + jp.length);
  }
  return out;
}

/** 把 src 描述写成 glTF json + bin；channels / skins / meshes 结构见 skinnedFixture */
function emit(src, { png } = {}) {
  const b = new Bin();
  const json = { asset: { version: "2.0", generator: "webwallgl-fixture" }, scene: 0, scenes: [{ nodes: src.roots }], nodes: [], meshes: [], buffers: [] };
  src.nodes.forEach((n) => {
    const o = { name: n.name };
    if (n.matrix) o.matrix = n.matrix;
    else {
      if (n.t) o.translation = n.t;
      if (n.r) o.rotation = n.r;
      if (n.s) o.scale = n.s;
    }
    const kids = src.nodes.map((c, i) => (c.parent === src.nodes.indexOf(n) ? i : -1)).filter((i) => i >= 0);
    if (kids.length) o.children = kids;
    json.nodes.push(o);
  });
  if (png) {
    json.images = [{ bufferView: b.view(png), mimeType: "image/png" }];
    json.textures = [{ source: 0 }];
    json.materials = [{ name: "skin", pbrMetallicRoughness: { baseColorTexture: { index: 0 } }, doubleSided: true }, { name: "red", pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] } }];
  }
  if (src.skins) {
    json.skins = src.skins.map((s) => ({ joints: s.joints, inverseBindMatrices: b.acc(Float32Array.from(s.ibm.flat()), "MAT4") }));
  }
  src.meshes.forEach((m, mi) => {
    const attributes = { POSITION: b.acc(Float32Array.from(m.positions), "VEC3") };
    if (m.uvs) attributes.TEXCOORD_0 = b.acc(Float32Array.from(m.uvs), "VEC2");
    if (m.skin) {
      attributes.JOINTS_0 = b.acc(Uint8Array.from(m.joints), "VEC4");
      attributes.WEIGHTS_0 = b.acc(Uint16Array.from(m.weights, (w) => Math.round(w * 65535)), "VEC4", { normalized: true });
    }
    const prim = { attributes, indices: b.acc(Uint16Array.from(m.indices), "SCALAR"), mode: 4 };
    if (m.material !== undefined) prim.material = m.material;
    json.meshes.push({ name: `mesh${mi}`, primitives: [prim] });
    json.nodes[m.node].mesh = mi;
    if (m.skin) json.nodes[m.node].skin = m.skin - 1;
  });
  json.animations = src.anims.map((a) => {
    const samplers = [];
    const channels = a.channels.map((ch) => {
      samplers.push({ input: b.acc(Float32Array.from(ch.times), "SCALAR"), output: b.acc(Float32Array.from(ch.values), { 3: "VEC3", 4: "VEC4" }[ch.size]), interpolation: ch.interp });
      return { sampler: samplers.length - 1, target: { node: ch.node, path: ch.path } };
    });
    return { name: a.name, samplers, channels };
  });
  const bin = b.bytes();
  json.buffers = [{ byteLength: bin.length }];
  json.bufferViews = b.views;
  json.accessors = b.accessors;
  return { json, bin };
}

/** 一条竖条网格：rows 行 × 2 列，y 从 0 到 h；joints / weights 按 y 在相邻骨之间线性过渡 */
function strip(rows, h, w, boneYs) {
  const positions = [], uvs = [], joints = [], weights = [], indices = [];
  for (let r = 0; r < rows; r++) {
    const y = (h * r) / (rows - 1);
    let j0 = 0;
    while (j0 < boneYs.length - 2 && y >= boneYs[j0 + 1]) j0++;
    const f = Math.min(1, Math.max(0, (y - boneYs[j0]) / (boneYs[j0 + 1] - boneYs[j0])));
    for (const x of [-w / 2, w / 2]) {
      positions.push(x, y, x * 0.1);
      uvs.push(x > 0 ? 1 : 0, 1 - y / h);
      joints.push(j0, j0 + 1, 0, 0);
      weights.push(1 - f, f, 0, 0);
    }
    if (r) {
      const a = (r - 1) * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  return { positions, uvs, joints, weights, indices };
}

/**
 * ★ 夹具 A：3 骨蒙皮 + 2 片段。
 * 节点静止姿势 ≠ 绑定姿势（IBM 取另一套姿势的逆，检验「绑定 = IBM⁻¹」而不是节点 TRS），
 * 网格节点自带平移（glTF 规定蒙皮网格忽略它）；
 * 片段 wave：b1 绕 Z 的 LINEAR 旋转 + root 的 STEP 平移（1 s）；
 * 片段 twist：root 绕 Y 的 CUBICSPLINE 旋转经过 90°（ZYX 欧拉角的万向节奇点）+ b2 绕 X 旋转与缩放（2 s）。
 */
export function skinnedFixture() {
  const nodes = [
    { name: "root", parent: -1, t: [0, -1, 0], r: axisQuat([0, 0, 1], 0.2) },
    { name: "b1", parent: 0, t: [0, 1, 0], r: axisQuat([0, 0, 1], -0.3) },
    { name: "b2", parent: 1, t: [0, 1, 0] },
    { name: "body", parent: -1, t: [5, 5, 5] },
  ];
  const bindPose = [trs([0, -1, 0]), trs([0, 1, 0]), trs([0, 1, 0])];
  const bindWorld = [bindPose[0], mul(bindPose[0], bindPose[1]), mul(mul(bindPose[0], bindPose[1]), bindPose[2])];
  const s = strip(9, 3, 0.5, [0, 1, 2, 3].map((y) => y));
  // 网格在模型空间 y ∈ [0, 3]，骨在绑定姿势下的世界 y = −1 / 0 / 1 → 模型空间相对 root 平移 −1
  const positions = s.positions.map((v, i) => (i % 3 === 1 ? v - 1 : v));
  const ys = [-1, 0, 1, 2];
  const joints = [];
  const weights = [];
  for (let v = 0; v < positions.length / 3; v++) {
    const y = positions[v * 3 + 1];
    const j0 = y < ys[1] ? 0 : y < ys[2] ? 1 : 2;
    const j1 = Math.min(2, j0 + 1);
    const f = j0 === j1 ? 0 : Math.min(1, Math.max(0, (y - ys[j0]) / (ys[j0 + 1] - ys[j0])));
    joints.push(j0, j1, 0, 0);
    weights.push(1 - f, f, 0, 0);
  }
  const q = (deg) => axisQuat([0, 1, 0], (deg * Math.PI) / 180);
  const zero4 = [0, 0, 0, 0];
  const src = {
    roots: [0, 3],
    nodes,
    skins: [{ joints: [0, 1, 2], ibm: bindWorld.map(inv) }],
    meshes: [{ node: 3, skin: 1, positions, uvs: s.uvs, joints, weights, indices: s.indices, material: 0 }],
    anims: [
      {
        name: "wave",
        channels: [
          { node: 1, path: "rotation", interp: "LINEAR", size: 4, times: [0, 0.5, 1], values: [...axisQuat([0, 0, 1], -0.3), ...axisQuat([0, 0, 1], 0.6), ...axisQuat([0, 0, 1], -0.3)] },
          { node: 0, path: "translation", interp: "STEP", size: 3, times: [0, 0.5], values: [0, -1, 0, 0.3, -1, 0] },
        ],
      },
      {
        name: "twist",
        channels: [
          { node: 0, path: "rotation", interp: "CUBICSPLINE", size: 4, times: [0, 1, 2], values: [...zero4, ...q(0), ...zero4, ...zero4, ...q(90), ...zero4, ...zero4, ...q(180), ...zero4] },
          { node: 2, path: "rotation", interp: "LINEAR", size: 4, times: [0, 2], values: [...axisQuat([1, 0, 0], 0), ...axisQuat([1, 0.2, 0], 1.2)] },
          { node: 2, path: "scale", interp: "LINEAR", size: 3, times: [0, 2], values: [1, 1, 1, 1.5, 0.5, 1] },
        ],
      },
    ],
  };
  const png = makePng(8, 8, (x, y) => (y < 4 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
  const { json, bin } = emit(src, { png });
  return { src, json, bin, png, glb: packGlb(json, bin) };
}

/** 夹具 B：无蒙皮的刚体层级（父节点动、子节点挂网格、子节点用 matrix 表示静止姿势），无贴图 */
export function rigidFixture() {
  const nodes = [
    { name: "arm", parent: -1, t: [0, 0, 0] },
    { name: "hand", parent: 0, matrix: trs([1, 0.5, 0], axisQuat([0, 0, 1], 0.4), [1, 2, 1]) },
  ];
  const quad = { positions: [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], indices: [0, 1, 2, 0, 2, 3] };
  const src = {
    roots: [0],
    nodes,
    meshes: [
      { node: 0, ...quad },
      { node: 1, ...quad },
    ],
    anims: [
      {
        name: "swing",
        channels: [
          { node: 0, path: "rotation", interp: "LINEAR", size: 4, times: [0, 1], values: [...axisQuat([0, 0, 1], 0), ...axisQuat([0, 0, 1], 1.5)] },
          { node: 0, path: "translation", interp: "LINEAR", size: 3, times: [0, 1], values: [0, 0, 0, 0.5, 0.25, 0] },
        ],
      },
    ],
  };
  const { json, bin } = emit(src);
  return { src, json, bin, glb: packGlb(json, bin) };
}
