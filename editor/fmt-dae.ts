// COLLADA .dae → ModelIR。读：asset（up_axis / unit）、visual_scene 节点树（matrix / translate / rotate / scale，
// instance_node 展开）、instance_geometry / instance_controller（skin：bind_shape_matrix、joints、INV_BIND_MATRIX、
// vertex_weights）、几何（triangles / polylist / polygons / trifans / tristrips）、profile_COMMON 材质（漫反射色 / 贴图 / 透明度）、
// 动画（channel → 节点变换元素的 sid，含 .X / .ANGLE / (r)(c) 分量），按关键帧并集重组成节点 TRS。
// 矩阵在 COLLADA 里是行主序，这里统一转列主序。

import { decompose, GltfError } from "./gltf";
import { computeNormals, decodeText, fan, findImage, IDENT, m4axisAngle, m4mul, m4scale, m4translate, transformNormals, transformPositions, type IRAnim, type IRChannel, type IRMaterial, type IRNode, type IRPrim, type IRSkin, type IRWarning, type Mat4, type ModelIR } from "./model-ir";
import { child, children, numbers, parseXml, walk, type XEl } from "./xml";

type Src = { f: number[] | null; names: string[] | null; stride: number };
type RawPrim = { symbol: string; positions: number[]; normals: number[] | null; uvs: number[] | null; indices: number[]; posIdx: number[] };
type Xform = { tag: string; sid: string; v: number[] };
type Track = { member: string; times: number[]; values: number[]; stride: number; interp: string[] | null; inT: number[] | null; outT: number[] | null };

const rowMajor = (v: ArrayLike<number>): number[] => {
  const o = new Array<number>(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) o[c * 4 + r] = v[r * 4 + c] ?? (r === c ? 1 : 0);
  return o;
};

function xformMatrix(x: Xform): number[] {
  const v = x.v;
  switch (x.tag) {
    case "matrix":
      return rowMajor(v);
    case "translate":
      return m4translate(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0);
    case "rotate":
      return m4axisAngle(v[0] ?? 0, v[1] ?? 0, v[2] ?? 1, ((v[3] ?? 0) * Math.PI) / 180);
    case "scale":
      return m4scale(v[0] ?? 1, v[1] ?? 1, v[2] ?? 1);
    case "lookat": {
      // eye / interest / up：节点看向 interest（相机节点常用；网格节点极少）
      const [ex, ey, ez, ix, iy, iz, ux, uy, uz] = v;
      let fx = ex - ix, fy = ey - iy, fz = ez - iz;
      const fl = Math.hypot(fx, fy, fz) || 1;
      (fx /= fl), (fy /= fl), (fz /= fl);
      let rx = uy * fz - uz * fy, ry = uz * fx - ux * fz, rz = ux * fy - uy * fx;
      const rl = Math.hypot(rx, ry, rz) || 1;
      (rx /= rl), (ry /= rl), (rz /= rl);
      return [rx, ry, rz, 0, fy * rz - fz * ry, fz * rx - fx * rz, fx * ry - fy * rx, 0, fx, fy, fz, 0, ex, ey, ez, 1];
    }
    default:
      return [...IDENT];
  }
}

const composeXforms = (xs: Xform[]): number[] => xs.reduce<number[]>((m, x) => m4mul(m, xformMatrix(x)), [...IDENT]);

/** 分量名 → 变换元素数值下标 */
function memberIndex(tag: string, member: string): number {
  if (!member) return -1;
  const sub = member.match(/^\((\d+)\)(?:\((\d+)\))?$/);
  if (sub) return sub[2] !== undefined ? +sub[1] * 4 + +sub[2] : +sub[1];
  const m = member.toUpperCase();
  if (m === "ANGLE") return 3;
  const xyz = ["X", "Y", "Z", "W"].indexOf(m);
  if (xyz >= 0) return tag === "rotate" && xyz === 3 ? 3 : xyz;
  return -1;
}

function sampleTrack(tr: Track, t: number): number[] {
  const { times, values, stride } = tr;
  const n = times.length;
  const at = (k: number) => values.slice(k * stride, k * stride + stride);
  if (t <= times[0]) return at(0);
  if (t >= times[n - 1]) return at(n - 1);
  let k = 0;
  while (k + 1 < n && times[k + 1] < t) k++;
  const t0 = times[k], t1 = times[k + 1];
  const mode = tr.interp?.[k] ?? "LINEAR";
  if (mode === "STEP" || t1 <= t0) return at(k);
  const a = (t - t0) / (t1 - t0);
  const o = new Array<number>(stride);
  // BEZIER：切线是 (时间, 值) 二维控制点，每分量一对；先按时间解出曲线参数再取值
  const bez = mode === "BEZIER" && tr.outT && tr.inT && tr.outT.length >= (k + 1) * stride * 2 && tr.inT.length >= (k + 2) * stride * 2;
  for (let i = 0; i < stride; i++) {
    const v0 = values[k * stride + i], v1 = values[(k + 1) * stride + i];
    if (!bez) {
      o[i] = v0 * (1 - a) + v1 * a;
      continue;
    }
    const c1t = tr.outT![(k * stride + i) * 2], c1v = tr.outT![(k * stride + i) * 2 + 1];
    const c2t = tr.inT![((k + 1) * stride + i) * 2], c2v = tr.inT![((k + 1) * stride + i) * 2 + 1];
    const cub = (p0: number, p1: number, p2: number, p3: number, s: number) => {
      const u = 1 - s;
      return u * u * u * p0 + 3 * u * u * s * p1 + 3 * u * s * s * p2 + s * s * s * p3;
    };
    let lo = 0, hi = 1, s = a;
    for (let it = 0; it < 40; it++) {
      s = (lo + hi) / 2;
      if (cub(t0, c1t, c2t, t1, s) < t) lo = s;
      else hi = s;
    }
    o[i] = cub(v0, c1v, c2v, v1, s);
  }
  return o;
}

export function parseDae(bytes: Uint8Array, resolve: (n: string) => Uint8Array | null = () => null): ModelIR {
  const doc = parseXml(decodeText(bytes));
  const col = doc.kids.find((k) => k.tag === "COLLADA");
  if (!col) throw new GltfError("format", "DAE");
  const warnings: IRWarning[] = [];
  const warned = new Set<string>();
  const warn = (code: string, detail?: string) => {
    const k = `${code}|${detail ?? ""}`;
    if (!warned.has(k)) warned.add(k), warnings.push({ code, detail });
  };
  const ids = new Map<string, XEl>();
  for (const e of walk(col)) if (e.attrs.id) ids.set(e.attrs.id, e);
  const ref = (url: string | undefined) => (url ? ids.get(decodeURIComponent(url.replace(/^#/, ""))) ?? ids.get(url.replace(/^#/, "")) ?? null : null);

  // ---------- 数据源 ----------
  const srcCache = new Map<XEl, Src>();
  const readSource = (el: XEl | null): Src | null => {
    if (!el) return null;
    const hit = srcCache.get(el);
    if (hit) return hit;
    const acc = child(child(el, "technique_common"), "accessor");
    const stride = Math.max(1, +(acc?.attrs.stride ?? 1) || 1);
    let s: Src | null = null;
    const fa = child(el, "float_array") ?? child(el, "int_array");
    if (fa) s = { f: numbers(fa.text), names: null, stride };
    else {
      const na = child(el, "Name_array") ?? child(el, "IDREF_array") ?? child(el, "SIDREF_array");
      if (na) s = { f: null, names: na.text.trim().split(/\s+/).filter(Boolean), stride };
    }
    if (s) srcCache.set(el, s);
    return s;
  };
  const inputsOf = (el: XEl | null) =>
    children(el, "input").map((i) => ({ semantic: i.attrs.semantic ?? "", offset: +(i.attrs.offset ?? 0) || 0, set: +(i.attrs.set ?? 0) || 0, src: i.attrs.source ?? "" }));

  // ---------- 材质 ----------
  const materials: IRMaterial[] = [];
  const matCache = new Map<string, number>();
  const imagePath = (img: XEl | null): string | null => {
    const init = child(img, "init_from");
    const raw = (child(init, "ref")?.text ?? init?.text ?? "").trim();
    if (!raw) return null;
    let p = raw.replace(/^file:\/\/\/?/i, "");
    try {
      p = decodeURIComponent(p);
    } catch {
      /* 保留原样 */
    }
    return p;
  };
  const materialIndex = (matId: string | undefined): number => {
    const key = matId ?? "";
    const hit = matCache.get(key);
    if (hit !== undefined) return hit;
    const mat = ref(matId);
    const m: IRMaterial = { name: mat?.attrs.name ?? mat?.attrs.id ?? "default", color: [0.8, 0.8, 0.8, 1] };
    const effect = ref(child(mat, "instance_effect")?.attrs.url);
    const prof = child(effect, "profile_COMMON");
    const params = new Map<string, XEl>();
    for (const e of walk(prof ?? effect ?? doc)) if (e.tag === "newparam" && e.attrs.sid) params.set(e.attrs.sid, e);
    const tech = child(prof, "technique");
    const shade = tech?.kids.find((k) => ["phong", "lambert", "blinn", "constant"].includes(k.tag)) ?? null;
    const diffuse = child(shade, "diffuse") ?? child(shade, "emission");
    const tex = child(diffuse, "texture");
    if (tex) {
      const sampler = params.get(tex.attrs.texture ?? "");
      let img: XEl | null = null;
      if (sampler) {
        const s2d = child(sampler, "sampler2D");
        const inst = child(s2d, "instance_image");
        if (inst) img = ref(inst.attrs.url);
        else {
          const surf = params.get(child(s2d, "source")?.text.trim() ?? "");
          const init = child(child(surf, "surface"), "init_from");
          img = ids.get(init?.text.trim() ?? "") ?? null;
        }
      } else img = ids.get(tex.attrs.texture ?? "") ?? null;
      const path = imagePath(img);
      if (path) {
        m.image = findImage(path, resolve);
        if (!m.image.bytes) warn("missingFile", path);
        m.color = [1, 1, 1, 1];
      }
    } else {
      const c = numbers(child(diffuse, "color")?.text ?? "");
      if (c.length >= 3) m.color = [c[0], c[1], c[2], 1];
    }
    const transparent = child(shade, "transparent");
    const tval = numbers(child(child(shade, "transparency"), "float")?.text ?? "");
    const tc = numbers(child(transparent, "color")?.text ?? "");
    if (transparent && tc.length >= 3) {
      const t = tval.length ? tval[0] : 1;
      const a = transparent.attrs.opaque === "RGB_ZERO" ? 1 - t * ((tc[0] + tc[1] + tc[2]) / 3) : (tc[3] ?? 1) * t;
      if (a > 0.01 && a < 0.999) ((m.color as number[])[3] = a), (m.blend = true);
    }
    if (effect) for (const e of walk(effect)) if (e.tag === "double_sided" && e.text.trim() === "1") m.doubleSided = true;
    materials.push(m);
    matCache.set(key, materials.length - 1);
    return materials.length - 1;
  };

  // ---------- 几何 ----------
  const geomCache = new Map<XEl, RawPrim[]>();
  const buildGeometry = (geom: XEl): RawPrim[] => {
    const hit = geomCache.get(geom);
    if (hit) return hit;
    const out: RawPrim[] = [];
    geomCache.set(geom, out);
    const mesh = child(geom, "mesh");
    if (!mesh) {
      warn("unsupportedGeometry", geom.attrs.name ?? geom.attrs.id);
      return out;
    }
    const vertsEl = child(mesh, "vertices");
    const vInputs = inputsOf(vertsEl);
    for (const pe of mesh.kids) {
      if (!["triangles", "polylist", "polygons", "trifans", "tristrips", "lines", "linestrips"].includes(pe.tag)) continue;
      if (pe.tag === "lines" || pe.tag === "linestrips") {
        warn("lines", geom.attrs.name ?? geom.attrs.id);
        continue;
      }
      const ins = inputsOf(pe);
      const stride = ins.reduce((m, i) => Math.max(m, i.offset + 1), 1);
      let pos: { s: Src; off: number } | null = null;
      let nrm: { s: Src; off: number } | null = null;
      let uv: { s: Src; off: number; set: number } | null = null;
      for (const i of ins) {
        if (i.semantic === "VERTEX") {
          for (const vi of vInputs) {
            const s = readSource(ref(vi.src));
            if (!s?.f) continue;
            if (vi.semantic === "POSITION") pos = { s, off: i.offset };
            else if (vi.semantic === "NORMAL" && !nrm) nrm = { s, off: i.offset };
            else if (vi.semantic === "TEXCOORD" && (!uv || vi.set < uv.set)) uv = { s, off: i.offset, set: vi.set };
          }
        } else if (i.semantic === "NORMAL") {
          const s = readSource(ref(i.src));
          if (s?.f) nrm = { s, off: i.offset };
        } else if (i.semantic === "TEXCOORD") {
          const s = readSource(ref(i.src));
          if (s?.f && (!uv || i.set < uv.set)) uv = { s, off: i.offset, set: i.set };
        }
      }
      if (!pos) continue;
      // 多边形 = 若干角，每个角是（所在 <p> 的数组, 该顶点在数组里的起点）
      type Corner = { arr: number[]; at: number };
      const corners: Corner[][] = [];
      const ps = children(pe, "p").map((p) => numbers(p.text));
      const range = (arr: number[], from: number, n: number): Corner[] => Array.from({ length: n }, (_, j) => ({ arr, at: from + j * stride }));
      if (pe.tag === "triangles") {
        const p = ps[0] ?? [];
        for (let k = 0; k + stride * 3 <= p.length; k += stride * 3) corners.push(range(p, k, 3));
      } else if (pe.tag === "polylist") {
        const vc = numbers(child(pe, "vcount")?.text ?? "");
        const p = ps[0] ?? [];
        let k = 0;
        for (const c of vc) {
          if (k + c * stride > p.length) break;
          corners.push(range(p, k, c));
          k += c * stride;
        }
      } else if (pe.tag === "tristrips") {
        for (const p of ps) {
          const n = Math.floor(p.length / stride);
          for (let j = 0; j + 2 < n; j++) corners.push((j % 2 ? [j + 1, j, j + 2] : [j, j + 1, j + 2]).map((q) => ({ arr: p, at: q * stride })));
        }
      } else {
        const holes = children(pe, "ph");
        if (holes.length) warn("holes", geom.attrs.name ?? geom.attrs.id);
        for (const p of [...ps, ...holes.map((h) => numbers(child(h, "p")?.text ?? ""))]) corners.push(range(p, 0, Math.floor(p.length / stride)));
      }
      const rp: RawPrim = { symbol: pe.attrs.material ?? "", positions: [], normals: nrm ? [] : null, uvs: uv ? [] : null, indices: [], posIdx: [] };
      const map = new Map<string, number>();
      const ps3 = pos.s.stride;
      const nPos = pos.s.f!.length / ps3;
      for (const poly of corners) {
        const ring: number[] = [];
        for (const { arr, at } of poly) {
          const pi = arr[at + pos.off];
          if (!(pi >= 0 && pi < nPos)) continue;
          const ni = nrm ? arr[at + nrm.off] : -1;
          const ti = uv ? arr[at + uv.off] : -1;
          const key = `${pi}/${ni}/${ti}`;
          let o = map.get(key);
          if (o === undefined) {
            o = rp.posIdx.length;
            map.set(key, o);
            rp.posIdx.push(pi);
            const pf = pos.s.f!;
            rp.positions.push(pf[pi * ps3], pf[pi * ps3 + 1], pf[pi * ps3 + 2]);
            if (nrm) {
              const f = nrm.s.f!, st = nrm.s.stride;
              rp.normals!.push(f[ni * st] ?? 0, f[ni * st + 1] ?? 0, f[ni * st + 2] ?? 0);
            }
            if (uv) {
              const f = uv.s.f!, st = uv.s.stride;
              rp.uvs!.push(f[ti * st] ?? 0, 1 - (f[ti * st + 1] ?? 0));
            }
          }
          ring.push(o);
        }
        fan(ring, rp.indices);
      }
      if (rp.indices.length >= 3) out.push(rp);
    }
    return out;
  };

  // ---------- 节点树 ----------
  const nodes: IRNode[] = [];
  const meta: Array<{ el: XEl; xforms: Xform[] }> = [];
  const byId = new Map<string, number[]>();
  const instances: Array<{ node: number; el: XEl }> = [];
  const asset = child(col, "asset");
  const up = (child(asset, "up_axis")?.text ?? "Y_UP").trim().toUpperCase();
  const meter = +(child(asset, "unit")?.attrs.meter ?? 1) || 1;
  let rootM: number[] | null = null;
  if (up === "Z_UP") rootM = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1];
  else if (up === "X_UP") rootM = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  if (Math.abs(meter - 1) > 1e-9) rootM = m4mul(m4scale(meter, meter, meter), rootM ?? [...IDENT]);
  if (rootM) nodes.push({ name: "Scene", parent: -1, matrix: rootM }), meta.push({ el: col, xforms: [] });
  const rootIdx = rootM ? 0 : -1;
  const visit = (el: XEl, parent: number, depth: number) => {
    if (depth > 64) return;
    const xforms: Xform[] = el.kids
      .filter((k) => ["matrix", "translate", "rotate", "scale", "lookat"].includes(k.tag))
      .map((k) => ({ tag: k.tag, sid: k.attrs.sid ?? "", v: numbers(k.text) }));
    if (el.kids.some((k) => k.tag === "skew")) warn("skew", el.attrs.name ?? el.attrs.id);
    const idx = nodes.length;
    nodes.push({ name: el.attrs.name ?? el.attrs.id ?? el.attrs.sid ?? `node${idx}`, parent, matrix: composeXforms(xforms) });
    meta.push({ el, xforms });
    if (el.attrs.id) byId.set(el.attrs.id, [...(byId.get(el.attrs.id) ?? []), idx]);
    for (const k of el.kids) {
      if (k.tag === "node") visit(k, idx, depth + 1);
      else if (k.tag === "instance_node") {
        const t = ref(k.attrs.url);
        if (t) visit(t, idx, depth + 1);
      } else if (k.tag === "instance_geometry" || k.tag === "instance_controller") instances.push({ node: idx, el: k });
    }
  };
  const vsUrl = child(child(col, "scene"), "instance_visual_scene")?.attrs.url;
  const vs = ref(vsUrl) ?? [...walk(col)].find((e) => e.tag === "visual_scene") ?? null;
  if (!vs) throw new GltfError("noMesh");
  for (const n of children(vs, "node")) visit(n, rootIdx, 0);

  const subtree = (root: number): number[] => {
    const out = [root];
    for (let i = root + 1; i < nodes.length; i++) {
      let p = nodes[i].parent;
      while (p > root) p = nodes[p].parent;
      if (p === root) out.push(i);
    }
    return out;
  };
  const findJoint = (name: string, byIdref: boolean, roots: number[]): number => {
    if (byIdref) return byId.get(name)?.[0] ?? -1;
    for (const r of roots) for (const i of subtree(r)) if (meta[i].el.attrs.sid === name) return i;
    for (let i = 0; i < nodes.length; i++) if (meta[i].el.attrs.sid === name) return i;
    const viaId = byId.get(name)?.[0];
    if (viaId !== undefined) return viaId;
    return nodes.findIndex((n, i) => meta[i].el.tag === "node" && n.name === name);
  };

  // ---------- 实例：几何 / 蒙皮 ----------
  const skins: IRSkin[] = [];
  const meshOwners: number[] = [];
  const attach = (node: number, prims: IRPrim[], skin?: number) => {
    let at = node;
    if (nodes[node].mesh?.length) {
      nodes.push({ name: `${nodes[node].name ?? "mesh"}_${nodes.length}`, parent: node, matrix: [...IDENT] });
      meta.push({ el: meta[node].el, xforms: [] });
      at = nodes.length - 1;
    }
    nodes[at].mesh = prims;
    if (skin !== undefined) nodes[at].skin = skin;
    meshOwners.push(at);
  };
  for (const inst of instances) {
    const binds = new Map<string, string>();
    for (const im of walk(inst.el)) if (im.tag === "instance_material") binds.set(im.attrs.symbol ?? "", im.attrs.target ?? "");
    const toPrim = (r: RawPrim, m?: Mat4): IRPrim => {
      const positions = m ? transformPositions(m, r.positions) : r.positions;
      const normals = r.normals ? (m ? transformNormals(m, r.normals) : r.normals) : computeNormals(positions, r.indices);
      return { material: materialIndex(binds.get(r.symbol) ?? undefined), positions, normals, uvs: r.uvs, indices: r.indices };
    };
    if (inst.el.tag === "instance_geometry") {
      const g = ref(inst.el.attrs.url);
      if (g) attach(inst.node, buildGeometry(g).map((r) => toPrim(r)));
      continue;
    }
    const ctrl = ref(inst.el.attrs.url);
    let skinEl = child(ctrl, "skin");
    if (!skinEl) {
      const morph = child(ctrl, "morph");
      if (morph) {
        warn("morph", ctrl?.attrs.name ?? ctrl?.attrs.id);
        const base = ref(morph.attrs.source);
        if (base?.tag === "geometry") attach(inst.node, buildGeometry(base).map((r) => toPrim(r)));
      }
      continue;
    }
    let geom = ref(skinEl.attrs.source);
    if (geom?.tag === "controller") {
      warn("morph", geom.attrs.name ?? geom.attrs.id);
      geom = ref(child(geom, "morph")?.attrs.source);
    }
    if (!geom || geom.tag !== "geometry") continue;
    const raws = buildGeometry(geom);
    const bsmV = numbers(child(skinEl, "bind_shape_matrix")?.text ?? "");
    const bsm = bsmV.length === 16 ? rowMajor(bsmV) : [...IDENT];
    const jIn = inputsOf(child(skinEl, "joints"));
    const jointEl = ref(jIn.find((i) => i.semantic === "JOINT")?.src);
    const jSrc = readSource(jointEl);
    const ibmSrc = readSource(ref(jIn.find((i) => i.semantic === "INV_BIND_MATRIX")?.src));
    const names = jSrc?.names ?? [];
    const byIdref = !!child(jointEl, "IDREF_array");
    const roots = children(inst.el, "skeleton")
      .map((s) => byId.get(s.text.trim().replace(/^#/, ""))?.[0] ?? -1)
      .filter((i) => i >= 0);
    const jointNodes = names.map((n) => findJoint(n, byIdref, roots));
    const vw = child(skinEl, "vertex_weights");
    const vwIn = inputsOf(vw);
    const wJ = vwIn.find((i) => i.semantic === "JOINT");
    const wW = vwIn.find((i) => i.semantic === "WEIGHT");
    const wSrc = readSource(ref(wW?.src));
    if (!names.length || jointNodes.some((j) => j < 0) || !wJ || !wW || !wSrc?.f || !ibmSrc?.f) {
      warn("skinJoints", ctrl?.attrs.name ?? ctrl?.attrs.id);
      attach(inst.node, raws.map((r) => toPrim(r, bsm)));
      continue;
    }
    const vc = numbers(child(vw, "vcount")?.text ?? "");
    const v = numbers(child(vw, "v")?.text ?? "");
    const st = vwIn.reduce((m, i) => Math.max(m, i.offset + 1), 1);
    const infl: Array<Array<[number, number]>> = [];
    let k = 0;
    for (const c of vc) {
      const list: Array<[number, number]> = [];
      for (let j = 0; j < c; j++, k += st) {
        const ji = v[k + wJ.offset];
        const w = wSrc.f[v[k + wW.offset]] ?? 0;
        if (ji >= 0 && ji < names.length && w > 0) list.push([ji, w]);
      }
      list.sort((a, b) => b[1] - a[1]);
      infl.push(list.slice(0, 4));
    }
    if (vc.some((c) => c > 4)) warn("influences", ctrl?.attrs.name ?? ctrl?.attrs.id);
    const ibm = names.map((_, i) => {
      const s = ibmSrc.f!.slice(i * 16, i * 16 + 16);
      return s.length === 16 ? rowMajor(s) : [...IDENT];
    });
    skins.push({ joints: jointNodes, ibm });
    const prims = raws.map((r) => {
      const p = toPrim(r, bsm);
      const n = r.posIdx.length;
      const joints = new Uint16Array(n * 4);
      const weights = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) {
        const list = infl[r.posIdx[i]] ?? [];
        const sum = list.reduce((s, x) => s + x[1], 0);
        if (!sum) {
          weights[i * 4] = 1;
          continue;
        }
        list.forEach(([j, w], q) => ((joints[i * 4 + q] = j), (weights[i * 4 + q] = w / sum)));
      }
      return { ...p, joints, weights };
    });
    attach(inst.node, prims, skins.length - 1);
  }
  if (!meshOwners.length) throw new GltfError("noMesh");

  // ---------- 动画 ----------
  const anims: IRAnim[] = [];
  const perNode = new Map<number, Map<string, Track[]>>();
  const libAnims = children(col, "library_animations");
  for (const lib of libAnims) {
    for (const e of walk(lib)) {
      if (e.tag !== "channel") continue;
      const sampler = ref(e.attrs.source);
      const sIn = inputsOf(sampler);
      const inS = readSource(ref(sIn.find((i) => i.semantic === "INPUT")?.src));
      const outS = readSource(ref(sIn.find((i) => i.semantic === "OUTPUT")?.src));
      const interp = readSource(ref(sIn.find((i) => i.semantic === "INTERPOLATION")?.src));
      if (!inS?.f || !outS?.f || !inS.f.length) {
        warn("animSource", e.attrs.target);
        continue;
      }
      const target = e.attrs.target ?? "";
      const slash = target.indexOf("/");
      if (slash < 0) continue;
      const nodeId = target.slice(0, slash);
      const tail = target.slice(slash + 1).split("/").pop() ?? "";
      const m = tail.match(/^([^.(]+)(?:\.(\w+)|(\(\d+\)(?:\(\d+\))?))?$/);
      if (!m) continue;
      const sid = m[1];
      const member = m[2] ?? m[3] ?? "";
      const inT = readSource(ref(sIn.find((i) => i.semantic === "IN_TANGENT")?.src));
      const outT = readSource(ref(sIn.find((i) => i.semantic === "OUT_TANGENT")?.src));
      const track: Track = { member, times: inS.f, values: outS.f, stride: outS.stride, interp: interp?.names ?? null, inT: inT?.f ?? null, outT: outT?.f ?? null };
      if (track.interp?.includes("HERMITE")) warn("hermite", target);
      for (const ni of byId.get(nodeId) ?? []) {
        let slot = perNode.get(ni);
        if (!slot) perNode.set(ni, (slot = new Map()));
        slot.set(sid, [...(slot.get(sid) ?? []), track]);
      }
    }
  }
  if (perNode.size) {
    const channels: IRChannel[] = [];
    for (const [ni, slot] of perNode) {
      const xforms = meta[ni].xforms;
      if (![...slot.keys()].some((sid) => xforms.some((x) => x.sid === sid))) continue;
      // 关键帧并集 + 30 fps 网格（贝塞尔段、多个旋转分量组合都不是线性的）
      const tset = new Set<number>();
      let t0 = Infinity, t1 = -Infinity;
      for (const tracks of slot.values()) {
        for (const t of tracks) {
          for (const x of t.times) tset.add(Math.round(x * 1e6) / 1e6);
          t0 = Math.min(t0, t.times[0]);
          t1 = Math.max(t1, t.times[t.times.length - 1]);
        }
      }
      for (let k = Math.ceil(t0 * 30); k / 30 < t1; k++) tset.add(Math.round((k / 30) * 1e6) / 1e6);
      const times = [...tset].sort((a, b) => a - b);
      const T: number[] = [], R: number[] = [], S: number[] = [];
      let prevQ: number[] | null = null;
      for (const t of times) {
        const xs = xforms.map((x) => {
          const tracks = slot.get(x.sid);
          if (!tracks) return x;
          const v = [...x.v];
          for (const tr of tracks) {
            const val = sampleTrack(tr, t);
            const mi = memberIndex(x.tag, tr.member);
            if (mi >= 0) v[mi] = val[0];
            else for (let i = 0; i < Math.min(val.length, v.length || val.length); i++) v[i] = val[i];
          }
          return { ...x, v };
        });
        const d = decompose(composeXforms(xs));
        const q = [...d.r];
        if (prevQ && prevQ[0] * q[0] + prevQ[1] * q[1] + prevQ[2] * q[2] + prevQ[3] * q[3] < 0) for (let i = 0; i < 4; i++) q[i] = -q[i];
        prevQ = q;
        T.push(...d.t);
        R.push(...q);
        S.push(...d.s);
      }
      channels.push({ node: ni, path: "translation", times, values: T }, { node: ni, path: "rotation", times, values: R }, { node: ni, path: "scale", times, values: S });
    }
    if (channels.length) {
      const named = libAnims.flatMap((l) => children(l, "animation")).map((a) => a.attrs.name ?? a.attrs.id).filter(Boolean);
      anims.push({ name: named.length === 1 ? named[0]! : "Take", channels });
    }
  }
  return { nodes, materials, skins, anims, warnings };
}
