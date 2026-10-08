// Wavefront OBJ + MTL → ModelIR。静态网格：按 usemtl 分图元，v/vt/vn 组合去重成顶点，多边形扇形三角化，
// 负下标相对计数；vt 的 v 翻成 glTF 的左上原点；缺法线时按面算；mtllib 的 Kd / d / map_Kd 进材质。

import { GltfError } from "./gltf";
import { computeNormals, decodeText, fan, findImage, type IRMaterial, type IRPrim, type IRWarning, type ModelIR } from "./model-ir";

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** map_Kd 等贴图语句：跳过 -opt 参数，余下拼成文件名（可含空格） */
function mapFile(rest: string): string {
  const tok = rest.trim().split(/\s+/);
  let i = 0;
  while (i < tok.length && tok[i].startsWith("-") && tok.length - i > 1) {
    i++;
    while (i < tok.length - 1 && /^(-?\d*\.?\d+(e[-+]?\d+)?|on|off)$/i.test(tok[i])) i++;
  }
  return tok.slice(i).join(" ");
}

function parseMtl(text: string, resolve: (n: string) => Uint8Array | null, warn: (w: IRWarning) => void): Map<string, IRMaterial> {
  const out = new Map<string, IRMaterial>();
  let cur: IRMaterial | null = null;
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\S+)\s*(.*)$/.exec(line);
    if (!m || m[1].startsWith("#")) continue;
    const [, key, rest] = m;
    const k = key.toLowerCase();
    if (k === "newmtl") {
      cur = { name: rest.trim(), color: [1, 1, 1, 1] };
      out.set(cur.name!, cur);
    } else if (!cur) continue;
    else if (k === "kd") {
      const c = rest.trim().split(/\s+/).map(Number);
      if (c.length >= 3 && c.every(Number.isFinite)) cur.color = [srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2]), (cur.color as number[])[3]];
    } else if (k === "d" || k === "tr") {
      const v = Number(rest.trim().split(/\s+/).pop());
      if (Number.isFinite(v)) {
        const a = k === "d" ? v : 1 - v;
        (cur.color as number[])[3] = a;
        if (a < 0.999) cur.blend = true;
      }
    } else if (k === "map_kd") {
      const f = mapFile(rest);
      if (f) {
        cur.image = findImage(f, resolve);
        if (!cur.image.bytes) warn({ code: "missingFile", detail: f });
      }
    }
  }
  return out;
}

export function parseObj(bytes: Uint8Array, resolve: (n: string) => Uint8Array | null): ModelIR {
  const text = decodeText(bytes);
  const warnings: IRWarning[] = [];
  const warn = (w: IRWarning) => warnings.push(w);
  const vs: number[] = [];
  const vts: number[] = [];
  const vns: number[] = [];
  const mtls = new Map<string, IRMaterial>();
  type Group = { mat: string; pos: number[]; uv: number[]; nrm: number[]; idx: number[]; key: Map<string, number>; hasUv: boolean; hasN: boolean };
  const groups = new Map<string, Group>();
  let cur: Group | null = null;
  const useMat = (name: string) => {
    let g = groups.get(name);
    if (!g) groups.set(name, (g = { mat: name, pos: [], uv: [], nrm: [], idx: [], key: new Map(), hasUv: true, hasN: true }));
    cur = g;
  };
  let faces = 0;
  let lines = 0;
  const poly: number[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line[0] === "#") continue;
    const sp = line.search(/\s/);
    const key = sp < 0 ? line : line.slice(0, sp);
    const rest = sp < 0 ? "" : line.slice(sp + 1);
    if (key === "v") {
      const p = rest.split(/\s+/);
      vs.push(+p[0] || 0, +p[1] || 0, +p[2] || 0);
    } else if (key === "vt") {
      const p = rest.split(/\s+/);
      vts.push(+p[0] || 0, 1 - (+p[1] || 0));
    } else if (key === "vn") {
      const p = rest.split(/\s+/);
      vns.push(+p[0] || 0, +p[1] || 0, +p[2] || 0);
    } else if (key === "f") {
      if (!cur) useMat("");
      const g = cur as unknown as Group;
      poly.length = 0;
      for (const t of rest.split(/\s+/)) {
        if (!t) continue;
        let k = g.key.get(t);
        if (k === undefined) {
          const [a, b, c] = t.split("/");
          const rel = (s: string | undefined, n: number) => {
            if (!s) return -1;
            const i = parseInt(s, 10);
            return i < 0 ? n + i : i - 1;
          };
          const vi = rel(a, vs.length / 3);
          const ti = rel(b, vts.length / 2);
          const ni = rel(c, vns.length / 3);
          if (!(vi >= 0 && vi < vs.length / 3)) throw new GltfError("accessor", `f ${t}`);
          k = g.pos.length / 3;
          g.pos.push(vs[vi * 3], vs[vi * 3 + 1], vs[vi * 3 + 2]);
          if (ti >= 0 && ti < vts.length / 2) g.uv.push(vts[ti * 2], vts[ti * 2 + 1]);
          else (g.uv.push(0, 0), (g.hasUv = false));
          if (ni >= 0 && ni < vns.length / 3) g.nrm.push(vns[ni * 3], vns[ni * 3 + 1], vns[ni * 3 + 2]);
          else (g.nrm.push(0, 0, 0), (g.hasN = false));
          g.key.set(t, k);
        }
        poly.push(k);
      }
      if (poly.length >= 3) fan(poly, g.idx), faces++;
    } else if (key === "usemtl") useMat(rest.trim());
    else if (key === "mtllib") {
      for (const f of rest.trim().split(/\s+(?=\S+\.mtl\b)/i)) {
        const b = resolve(f) ?? resolve(f.split(/[\\/]/).pop()!);
        if (!b) {
          warn({ code: "missingFile", detail: f });
          continue;
        }
        for (const [n, m] of parseMtl(decodeText(b), resolve, warn)) mtls.set(n, m);
      }
    } else if (key === "l" || key === "p") lines++;
  }
  if (lines) warn({ code: "lines", detail: String(lines) });
  if (!faces) throw new GltfError("noMesh");
  const materials: IRMaterial[] = [];
  const matIdx = new Map<string, number>();
  const prims: IRPrim[] = [];
  for (const g of groups.values()) {
    if (!g.idx.length) continue;
    let mi = matIdx.get(g.mat);
    if (mi === undefined) {
      materials.push(mtls.get(g.mat) ?? { name: g.mat || "default", color: [0.8, 0.8, 0.8, 1] });
      matIdx.set(g.mat, (mi = materials.length - 1));
    }
    prims.push({
      material: mi,
      positions: g.pos,
      uvs: g.hasUv ? g.uv : null,
      normals: g.hasN ? g.nrm : computeNormals(g.pos, g.idx),
      indices: g.idx,
    });
  }
  return { nodes: [{ name: "OBJ", parent: -1, mesh: prims }], materials, warnings };
}
