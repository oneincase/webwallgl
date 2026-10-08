// STL（二进制 / ASCII）与 PLY（ascii / binary_little_endian / binary_big_endian）→ ModelIR。
// STL 按 3D 打印 / CAD 惯例视为 Z 向上，转成 Y 向上；PLY 照原坐标（MeshLab / 扫描数据惯例 Y 向上），
// 但 Blender 导出的（头里有 Blender 注释）是 Z 向上。

import { GltfError } from "./gltf";
import { computeNormals, decodeText, fan, findImage, transformNormals, transformPositions, Z_UP_TO_Y_UP, type IRMaterial, type IRWarning, type ModelIR } from "./model-ir";

const dec = new TextDecoder();

export function parseStl(bytes: Uint8Array): ModelIR {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pos: number[] = [];
  const nrm: number[] = [];
  const binCount = bytes.length >= 84 ? dv.getUint32(80, true) : -1;
  const isBin = binCount >= 0 && 84 + binCount * 50 === bytes.length;
  const head = dec.decode(bytes.subarray(0, Math.min(bytes.length, 512)));
  if (isBin || !/^\s*solid\b/.test(head)) {
    if (binCount < 0 || 84 + binCount * 50 > bytes.length) throw new GltfError("format", "STL");
    for (let i = 0; i < binCount; i++) {
      const o = 84 + i * 50;
      const n = [dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true)];
      for (let k = 0; k < 3; k++) {
        pos.push(dv.getFloat32(o + 12 + k * 12, true), dv.getFloat32(o + 16 + k * 12, true), dv.getFloat32(o + 20 + k * 12, true));
        nrm.push(...n);
      }
    }
  } else {
    const text = decodeText(bytes);
    const re = /facet\s+normal\s+(\S+)\s+(\S+)\s+(\S+)[\s\S]*?vertex\s+(\S+)\s+(\S+)\s+(\S+)\s+vertex\s+(\S+)\s+(\S+)\s+(\S+)\s+vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
    for (let m; (m = re.exec(text)); ) {
      const v = m.slice(1).map(Number);
      for (let k = 0; k < 3; k++) {
        pos.push(v[3 + k * 3], v[4 + k * 3], v[5 + k * 3]);
        nrm.push(v[0], v[1], v[2]);
      }
    }
  }
  if (!pos.length) throw new GltfError("noMesh");
  const indices = Uint32Array.from({ length: pos.length / 3 }, (_, i) => i);
  // 面法线为零（很多导出器不写）时按三角形算
  const flat = computeNormals(pos, indices);
  for (let i = 0; i < nrm.length; i += 3) {
    if (!(Math.hypot(nrm[i], nrm[i + 1], nrm[i + 2]) > 1e-6)) nrm.splice(i, 3, flat[i], flat[i + 1], flat[i + 2]);
  }
  return {
    nodes: [{ name: "STL", parent: -1, mesh: [{ material: 0, positions: transformPositions(Z_UP_TO_Y_UP, pos), normals: transformNormals(Z_UP_TO_Y_UP, nrm), indices }] }],
    materials: [{ name: "STL", color: [0.8, 0.8, 0.8, 1] }],
  };
}

// ---------- PLY ----------

const PLY_TYPES: Record<string, [number, (dv: DataView, o: number, le: boolean) => number]> = {
  char: [1, (d, o) => d.getInt8(o)],
  int8: [1, (d, o) => d.getInt8(o)],
  uchar: [1, (d, o) => d.getUint8(o)],
  uint8: [1, (d, o) => d.getUint8(o)],
  short: [2, (d, o, le) => d.getInt16(o, le)],
  int16: [2, (d, o, le) => d.getInt16(o, le)],
  ushort: [2, (d, o, le) => d.getUint16(o, le)],
  uint16: [2, (d, o, le) => d.getUint16(o, le)],
  int: [4, (d, o, le) => d.getInt32(o, le)],
  int32: [4, (d, o, le) => d.getInt32(o, le)],
  uint: [4, (d, o, le) => d.getUint32(o, le)],
  uint32: [4, (d, o, le) => d.getUint32(o, le)],
  float: [4, (d, o, le) => d.getFloat32(o, le)],
  float32: [4, (d, o, le) => d.getFloat32(o, le)],
  double: [8, (d, o, le) => d.getFloat64(o, le)],
  float64: [8, (d, o, le) => d.getFloat64(o, le)],
};

type PlyProp = { name: string; type: string; list?: string };
type PlyElem = { name: string; count: number; props: PlyProp[] };

export function parsePly(bytes: Uint8Array, resolve: (n: string) => Uint8Array | null = () => null): ModelIR {
  const headEnd = (() => {
    const s = dec.decode(bytes.subarray(0, Math.min(bytes.length, 65536)));
    const m = /end_header\r?\n/.exec(s);
    if (!/^ply\r?\n/.test(s) || !m) throw new GltfError("format", "PLY");
    return { text: s.slice(0, m.index), body: new TextEncoder().encode(s.slice(0, m.index + m[0].length)).length };
  })();
  let format = "ascii";
  let texture = "";
  let zUp = false;
  const elems: PlyElem[] = [];
  for (const line of headEnd.text.split(/\r?\n/)) {
    const t = line.trim().split(/\s+/);
    if (t[0] === "format") format = t[1];
    else if (t[0] === "comment" && /^texturefile$/i.test(t[1] ?? "")) texture = t.slice(2).join(" ");
    else if (t[0] === "comment" && /\bBlender\b/i.test(line)) zUp = true;
    else if (t[0] === "element") elems.push({ name: t[1], count: parseInt(t[2], 10), props: [] });
    else if (t[0] === "property" && elems.length) {
      const e = elems[elems.length - 1];
      if (t[1] === "list") e.props.push({ name: t[4], type: t[3], list: t[2] });
      else e.props.push({ name: t[2], type: t[1] });
    }
  }
  if (![...elems.flatMap((e) => e.props)].every((p) => PLY_TYPES[p.type] && (!p.list || PLY_TYPES[p.list]))) throw new GltfError("format", "PLY property type");
  const data = new Map<string, Array<Record<string, number | number[]>>>();
  if (format === "ascii") {
    const toks = dec.decode(bytes.subarray(headEnd.body)).split(/\s+/).filter(Boolean);
    let p = 0;
    for (const e of elems) {
      const rows: Array<Record<string, number | number[]>> = [];
      for (let i = 0; i < e.count; i++) {
        const r: Record<string, number | number[]> = {};
        for (const pr of e.props) {
          if (pr.list) {
            const n = Number(toks[p++]);
            r[pr.name] = toks.slice(p, p + n).map(Number);
            p += n;
          } else r[pr.name] = Number(toks[p++]);
        }
        rows.push(r);
      }
      data.set(e.name, rows);
    }
  } else if (format === "binary_little_endian" || format === "binary_big_endian") {
    const le = format === "binary_little_endian";
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let o = headEnd.body;
    for (const e of elems) {
      const rows: Array<Record<string, number | number[]>> = [];
      for (let i = 0; i < e.count; i++) {
        const r: Record<string, number | number[]> = {};
        for (const pr of e.props) {
          if (pr.list) {
            const [ls, lr] = PLY_TYPES[pr.list];
            const [es, er] = PLY_TYPES[pr.type];
            if (o + ls > bytes.length) throw new GltfError("accessor", "PLY");
            const n = lr(dv, o, le);
            o += ls;
            if (o + n * es > bytes.length) throw new GltfError("accessor", "PLY");
            const arr = new Array<number>(n);
            for (let k = 0; k < n; k++, o += es) arr[k] = er(dv, o, le);
            r[pr.name] = arr;
          } else {
            const [s, rd] = PLY_TYPES[pr.type];
            if (o + s > bytes.length) throw new GltfError("accessor", "PLY");
            r[pr.name] = rd(dv, o, le);
            o += s;
          }
        }
        rows.push(r);
      }
      data.set(e.name, rows);
    }
  } else throw new GltfError("format", `PLY ${format}`);
  const verts = data.get("vertex") ?? [];
  const faces = data.get("face") ?? [];
  if (!verts.length || !faces.length) throw new GltfError("noMesh");
  const vp = elems.find((e) => e.name === "vertex")!.props.map((p) => p.name);
  const has = (...n: string[]) => n.every((x) => vp.includes(x));
  const uvKeys = has("s", "t") ? ["s", "t"] : has("u", "v") ? ["u", "v"] : has("texture_u", "texture_v") ? ["texture_u", "texture_v"] : null;
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  for (const v of verts) {
    pos.push(v.x as number, v.y as number, v.z as number);
    if (has("nx", "ny", "nz")) nrm.push(v.nx as number, v.ny as number, v.nz as number);
    if (uvKeys) uv.push(v[uvKeys[0]] as number, 1 - (v[uvKeys[1]] as number));
  }
  const idx: number[] = [];
  for (const f of faces) {
    const list = (f.vertex_indices ?? f.vertex_index) as number[] | undefined;
    if (!list || list.some((i) => !(i >= 0 && i < verts.length))) continue;
    fan(list, idx);
  }
  if (!idx.length) throw new GltfError("noMesh");
  const mat: IRMaterial = { name: "PLY", color: [0.8, 0.8, 0.8, 1] };
  const warnings: IRWarning[] = [];
  if (texture) {
    mat.image = findImage(texture, resolve);
    if (!mat.image.bytes) warnings.push({ code: "missingFile", detail: texture });
  }
  return {
    nodes: [{ name: "PLY", parent: -1, matrix: zUp ? Z_UP_TO_Y_UP : undefined, mesh: [{ material: 0, positions: pos, normals: nrm.length ? nrm : computeNormals(pos, idx), uvs: uv.length ? uv : null, indices: idx }] }],
    materials: [mat],
    warnings,
  };
}
