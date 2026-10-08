import { definePlugin, type IRWarning, type ModelImporter, type ModelIR } from "../../../../editor/sdk";

const MAX_POINTS = 20000;

type Prop = { name: string; type: string };
type Header = { format: "ascii" | "binary_little_endian" | "binary_big_endian"; vertices: number; faces: number; props: Prop[]; body: number };

const SIZE: Record<string, number> = { char: 1, uchar: 1, int8: 1, uint8: 1, short: 2, ushort: 2, int16: 2, uint16: 2, int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8 };

function readHeader(bytes: Uint8Array): Header | null {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(bytes.length, 4096)));
  if (!head.startsWith("ply")) return null;
  const end = head.indexOf("end_header");
  if (end < 0) return null;
  const nl = head.indexOf("\n", end);
  const h: Header = { format: "ascii", vertices: 0, faces: 0, props: [], body: nl + 1 };
  let current = "";
  for (const line of head.slice(0, end).split(/\r?\n/)) {
    const w = line.trim().split(/\s+/);
    if (w[0] === "format") h.format = w[1] as Header["format"];
    else if (w[0] === "element") {
      current = w[1];
      if (current === "vertex") h.vertices = Number(w[2]);
      if (current === "face") h.faces = Number(w[2]);
    } else if (w[0] === "property" && current === "vertex" && w[1] !== "list") h.props.push({ type: w[1], name: w[2] });
  }
  return h;
}

/** 只接点云：有顶点、没有面（或面数 0），且带 x / y / z */
function isPointCloud(bytes: Uint8Array): boolean {
  const h = readHeader(bytes);
  return !!h && h.vertices > 0 && h.faces === 0 && ["x", "y", "z"].every((n) => h.props.some((p) => p.name === n));
}

function readPoints(bytes: Uint8Array, h: Header): { xyz: Float64Array; rgb: Float64Array | null; n: number } {
  const n = Math.min(h.vertices, MAX_POINTS);
  const xyz = new Float64Array(n * 3);
  const hasColor = ["red", "green", "blue"].every((c) => h.props.some((p) => p.name === c));
  const rgb = hasColor ? new Float64Array(n * 3) : null;
  const ix = ["x", "y", "z"].map((k) => h.props.findIndex((p) => p.name === k));
  const ic = ["red", "green", "blue"].map((k) => h.props.findIndex((p) => p.name === k));
  const scale = (p: Prop) => (/^u?(char|int8)$|^uint8$/.test(p.type) ? 1 / 255 : 1);
  const take = (row: number[], i: number) => {
    for (let k = 0; k < 3; k++) xyz[i * 3 + k] = row[ix[k]];
    if (rgb) for (let k = 0; k < 3; k++) rgb[i * 3 + k] = row[ic[k]] * scale(h.props[ic[k]]);
  };
  if (h.format === "ascii") {
    const lines = new TextDecoder().decode(bytes.subarray(h.body)).split(/\r?\n/);
    for (let i = 0, li = 0; i < n && li < lines.length; li++) {
      const s = lines[li].trim();
      if (s) take(s.split(/\s+/).map(Number), i++);
    }
  } else {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const le = h.format === "binary_little_endian";
    let o = h.body;
    const rd = (t: string): number => {
      const sz = SIZE[t];
      if (!sz) throw new Error(`PLY 属性类型不支持：${t}`);
      const at = o;
      o += sz;
      switch (t) {
        case "char": case "int8": return dv.getInt8(at);
        case "uchar": case "uint8": return dv.getUint8(at);
        case "short": case "int16": return dv.getInt16(at, le);
        case "ushort": case "uint16": return dv.getUint16(at, le);
        case "int": case "int32": return dv.getInt32(at, le);
        case "uint": case "uint32": return dv.getUint32(at, le);
        case "float": case "float32": return dv.getFloat32(at, le);
        default: return dv.getFloat64(at, le);
      }
    };
    for (let i = 0; i < n; i++) take(h.props.map((p) => rd(p.type)), i);
  }
  return { xyz, rgb, n };
}

/** 每个点 → 朝 +Z 的小方片（边长 = 包围盒对角线的 0.4%） */
function pointCloudToIR(bytes: Uint8Array): ModelIR {
  const h = readHeader(bytes);
  if (!h) throw new Error("不是 PLY 文件");
  const { xyz, rgb, n } = readPoints(bytes, h);
  const warnings: IRWarning[] = [];
  if (h.vertices > MAX_POINTS) warnings.push({ code: "pointsCapped", detail: `${h.vertices} → ${MAX_POINTS}` });
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) {
    lo[k] = Math.min(lo[k], xyz[i * 3 + k]);
    hi[k] = Math.max(hi[k], xyz[i * 3 + k]);
  }
  const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1;
  const r = diag * 0.002;
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i < n; i++) {
    const [x, y, z] = [xyz[i * 3], xyz[i * 3 + 1], xyz[i * 3 + 2]];
    const b = i * 4;
    positions.push(x - r, y - r, z, x + r, y - r, z, x + r, y + r, z, x - r, y + r, z);
    normals.push(0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1);
    uvs.push(0, 1, 1, 1, 1, 0, 0, 0);
    indices.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  // IR 没有逐顶点颜色：取平均色作材质色
  const color = [1, 1, 1, 1];
  if (rgb && n) for (let k = 0; k < 3; k++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += rgb[i * 3 + k];
    color[k] = s / n;
  }
  return {
    nodes: [{ name: "pointcloud", parent: -1, mesh: [{ material: 0, positions, normals, uvs, indices }] }],
    materials: [{ name: "points", color, doubleSided: true }],
    warnings,
  };
}

const importer: ModelImporter = {
  id: "ply-pointcloud",
  title: { "zh-CN": "PLY 点云", en: "PLY point cloud" },
  exts: ["ply"],
  sniff: isPointCloud,
  load: (bytes) => pointCloudToIR(bytes),
};

export default definePlugin({
  name: "import-ply-pointcloud",
  inject: ["importers"],
  apply(ctx) {
    ctx.contribute("importers", importer);
  },
});
