// 由 scripts/build-plugin-sdk.mjs 从 src/index.ts 生成，勿手改。
// editor/sdk/index.ts
function definePlugin(p) {
  return p;
}

// examples/plugins/import-ply-pointcloud/src/index.ts
var MAX_POINTS = 2e4;
var SIZE = { char: 1, uchar: 1, int8: 1, uint8: 1, short: 2, ushort: 2, int16: 2, uint16: 2, int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8 };
function readHeader(bytes) {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(bytes.length, 4096)));
  if (!head.startsWith("ply")) return null;
  const end = head.indexOf("end_header");
  if (end < 0) return null;
  const nl = head.indexOf("\n", end);
  const h = { format: "ascii", vertices: 0, faces: 0, props: [], body: nl + 1 };
  let current = "";
  for (const line of head.slice(0, end).split(/\r?\n/)) {
    const w = line.trim().split(/\s+/);
    if (w[0] === "format") h.format = w[1];
    else if (w[0] === "element") {
      current = w[1];
      if (current === "vertex") h.vertices = Number(w[2]);
      if (current === "face") h.faces = Number(w[2]);
    } else if (w[0] === "property" && current === "vertex" && w[1] !== "list") h.props.push({ type: w[1], name: w[2] });
  }
  return h;
}
function isPointCloud(bytes) {
  const h = readHeader(bytes);
  return !!h && h.vertices > 0 && h.faces === 0 && ["x", "y", "z"].every((n) => h.props.some((p) => p.name === n));
}
function readPoints(bytes, h) {
  const n = Math.min(h.vertices, MAX_POINTS);
  const xyz = new Float64Array(n * 3);
  const hasColor = ["red", "green", "blue"].every((c) => h.props.some((p) => p.name === c));
  const rgb = hasColor ? new Float64Array(n * 3) : null;
  const ix = ["x", "y", "z"].map((k) => h.props.findIndex((p) => p.name === k));
  const ic = ["red", "green", "blue"].map((k) => h.props.findIndex((p) => p.name === k));
  const scale = (p) => /^u?(char|int8)$|^uint8$/.test(p.type) ? 1 / 255 : 1;
  const take = (row, i) => {
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
    const rd = (t) => {
      const sz = SIZE[t];
      if (!sz) throw new Error(`PLY 属性类型不支持：${t}`);
      const at = o;
      o += sz;
      switch (t) {
        case "char":
        case "int8":
          return dv.getInt8(at);
        case "uchar":
        case "uint8":
          return dv.getUint8(at);
        case "short":
        case "int16":
          return dv.getInt16(at, le);
        case "ushort":
        case "uint16":
          return dv.getUint16(at, le);
        case "int":
        case "int32":
          return dv.getInt32(at, le);
        case "uint":
        case "uint32":
          return dv.getUint32(at, le);
        case "float":
        case "float32":
          return dv.getFloat32(at, le);
        default:
          return dv.getFloat64(at, le);
      }
    };
    for (let i = 0; i < n; i++) take(h.props.map((p) => rd(p.type)), i);
  }
  return { xyz, rgb, n };
}
function pointCloudToIR(bytes) {
  const h = readHeader(bytes);
  if (!h) throw new Error("不是 PLY 文件");
  const { xyz, rgb, n } = readPoints(bytes, h);
  const warnings = [];
  if (h.vertices > MAX_POINTS) warnings.push({ code: "pointsCapped", detail: `${h.vertices} → ${MAX_POINTS}` });
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) {
    lo[k] = Math.min(lo[k], xyz[i * 3 + k]);
    hi[k] = Math.max(hi[k], xyz[i * 3 + k]);
  }
  const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1;
  const r = diag * 2e-3;
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  for (let i = 0; i < n; i++) {
    const [x, y, z] = [xyz[i * 3], xyz[i * 3 + 1], xyz[i * 3 + 2]];
    const b = i * 4;
    positions.push(x - r, y - r, z, x + r, y - r, z, x + r, y + r, z, x - r, y + r, z);
    normals.push(0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1);
    uvs.push(0, 1, 1, 1, 1, 0, 0, 0);
    indices.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  const color = [1, 1, 1, 1];
  if (rgb && n) for (let k = 0; k < 3; k++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += rgb[i * 3 + k];
    color[k] = s / n;
  }
  return {
    nodes: [{ name: "pointcloud", parent: -1, mesh: [{ material: 0, positions, normals, uvs, indices }] }],
    materials: [{ name: "points", color, doubleSided: true }],
    warnings
  };
}
var importer = {
  id: "ply-pointcloud",
  title: { "zh-CN": "PLY 点云", en: "PLY point cloud" },
  exts: ["ply"],
  sniff: isPointCloud,
  load: (bytes) => pointCloudToIR(bytes)
};
var index_default = definePlugin({
  name: "import-ply-pointcloud",
  inject: ["importers"],
  apply(ctx) {
    ctx.contribute("importers", importer);
  }
});
export {
  index_default as default
};
