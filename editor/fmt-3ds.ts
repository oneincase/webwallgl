// 3D Studio .3ds → ModelIR。块结构：u16 id + u32 长度（含 6 字节头）。只读编辑器段（0x3D3D）：
// 网格对象的顶点（已是世界坐标）/ 面 / UV / 材质分组 / 平滑组，材质的漫反射色 / 透明度 / 双面 / 贴图名。
// 关键帧段（0xB000）不读。Z 向上，转成 Y 向上；UV 的 v 翻成左上原点。

import { GltfError } from "./gltf";
import { findImage, Z_UP_TO_Y_UP, type IRMaterial, type IRNode, type IRPrim, type IRWarning, type ModelIR } from "./model-ir";

const dec = new TextDecoder();

type Chunk = { id: number; start: number; end: number };

export function parse3ds(bytes: Uint8Array, resolve: (n: string) => Uint8Array | null = () => null): ModelIR {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 6 || dv.getUint16(0, true) !== 0x4d4d) throw new GltfError("format", "3DS");
  const warnings: IRWarning[] = [];
  const kids = (from: number, to: number): Chunk[] => {
    const out: Chunk[] = [];
    let p = from;
    while (p + 6 <= to) {
      const id = dv.getUint16(p, true);
      const len = dv.getUint32(p + 2, true);
      if (len < 6 || p + len > to) break;
      out.push({ id, start: p + 6, end: p + len });
      p += len;
    }
    return out;
  };
  const cstr = (p: number, end: number) => {
    let q = p;
    while (q < end && bytes[q]) q++;
    return { s: dec.decode(bytes.subarray(p, q)), next: Math.min(q + 1, end) };
  };
  const color = (c: Chunk): number[] | null => {
    for (const k of kids(c.start, c.end)) {
      if ((k.id === 0x0010 || k.id === 0x0013) && k.end - k.start >= 12) return [dv.getFloat32(k.start, true), dv.getFloat32(k.start + 4, true), dv.getFloat32(k.start + 8, true)];
      if ((k.id === 0x0011 || k.id === 0x0012) && k.end - k.start >= 3) return [bytes[k.start] / 255, bytes[k.start + 1] / 255, bytes[k.start + 2] / 255];
    }
    return null;
  };
  const percent = (c: Chunk): number | null => {
    for (const k of kids(c.start, c.end)) {
      if (k.id === 0x0030 && k.end - k.start >= 2) return dv.getUint16(k.start, true) / 100;
      if (k.id === 0x0031 && k.end - k.start >= 4) return dv.getFloat32(k.start, true) / 100;
    }
    return null;
  };
  const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

  const materials: IRMaterial[] = [];
  const matByName = new Map<string, number>();
  type Obj = { name: string; pos: Float32Array; faces: Uint16Array; uvs: Float32Array | null; groups: Array<{ mat: string; faces: Uint16Array }>; smooth: Uint32Array | null };
  const objs: Obj[] = [];
  const main = kids(6, Math.min(bytes.length, dv.getUint32(2, true)));
  for (const edit of main.filter((c) => c.id === 0x3d3d)) {
    for (const c of kids(edit.start, edit.end)) {
      if (c.id === 0xafff) {
        const m: IRMaterial = { color: [0.8, 0.8, 0.8, 1] };
        for (const k of kids(c.start, c.end)) {
          if (k.id === 0xa000) m.name = cstr(k.start, k.end).s;
          else if (k.id === 0xa020) {
            const rgb = color(k);
            if (rgb) m.color = [toLinear(rgb[0]), toLinear(rgb[1]), toLinear(rgb[2]), (m.color as number[])[3]];
          } else if (k.id === 0xa050) {
            const t = percent(k);
            if (t !== null && t > 0.001) ((m.color as number[])[3] = 1 - t), (m.blend = true);
          } else if (k.id === 0xa081) m.doubleSided = true;
          else if (k.id === 0xa200) {
            const f = kids(k.start, k.end).find((x) => x.id === 0xa300);
            if (f) {
              const name = cstr(f.start, f.end).s;
              m.image = findImage(name, resolve);
              if (!m.image.bytes) warnings.push({ code: "missingFile", detail: name });
            }
          }
        }
        matByName.set(m.name ?? "", materials.length);
        materials.push(m);
      } else if (c.id === 0x4000) {
        const nm = cstr(c.start, c.end);
        for (const tm of kids(nm.next, c.end).filter((x) => x.id === 0x4100)) {
          const o: Obj = { name: nm.s, pos: new Float32Array(0), faces: new Uint16Array(0), uvs: null, groups: [], smooth: null };
          for (const k of kids(tm.start, tm.end)) {
            if (k.id === 0x4110) {
              const n = dv.getUint16(k.start, true);
              if (k.start + 2 + n * 12 > k.end) throw new GltfError("accessor", `3DS ${nm.s} vertices`);
              o.pos = new Float32Array(n * 3);
              for (let i = 0; i < n * 3; i++) o.pos[i] = dv.getFloat32(k.start + 2 + i * 4, true);
            } else if (k.id === 0x4120) {
              const n = dv.getUint16(k.start, true);
              if (k.start + 2 + n * 8 > k.end) throw new GltfError("accessor", `3DS ${nm.s} faces`);
              o.faces = new Uint16Array(n * 3);
              for (let i = 0; i < n; i++) for (let j = 0; j < 3; j++) o.faces[i * 3 + j] = dv.getUint16(k.start + 2 + i * 8 + j * 2, true);
              for (const s of kids(k.start + 2 + n * 8, k.end)) {
                if (s.id === 0x4130) {
                  const mn = cstr(s.start, s.end);
                  const fc = dv.getUint16(mn.next, true);
                  const list = new Uint16Array(fc);
                  for (let i = 0; i < fc && mn.next + 2 + i * 2 + 2 <= s.end; i++) list[i] = dv.getUint16(mn.next + 2 + i * 2, true);
                  o.groups.push({ mat: mn.s, faces: list });
                } else if (s.id === 0x4150 && s.start + n * 4 <= s.end) {
                  o.smooth = new Uint32Array(n);
                  for (let i = 0; i < n; i++) o.smooth[i] = dv.getUint32(s.start + i * 4, true);
                }
              }
            } else if (k.id === 0x4140) {
              const n = dv.getUint16(k.start, true);
              if (k.start + 2 + n * 8 > k.end) continue;
              o.uvs = new Float32Array(n * 2);
              for (let i = 0; i < n; i++) {
                o.uvs[i * 2] = dv.getFloat32(k.start + 2 + i * 8, true);
                o.uvs[i * 2 + 1] = 1 - dv.getFloat32(k.start + 6 + i * 8, true);
              }
            }
          }
          if (o.pos.length && o.faces.length) objs.push(o);
        }
      }
    }
  }
  if (!objs.length) throw new GltfError("noMesh");
  let defaultMat = -1;
  const nodes: IRNode[] = [{ name: "3DS", parent: -1, matrix: Z_UP_TO_Y_UP }];
  for (const o of objs) {
    const nv = o.pos.length / 3;
    const faceMat = new Int32Array(o.faces.length / 3).fill(-1);
    for (const g of o.groups) {
      const mi = matByName.get(g.mat);
      if (mi === undefined) continue;
      for (const f of g.faces) if (f < faceMat.length) faceMat[f] = mi;
    }
    if (faceMat.some((m) => m < 0)) {
      if (defaultMat < 0) materials.push({ name: "default", color: [0.8, 0.8, 0.8, 1] }), (defaultMat = materials.length - 1);
      for (let f = 0; f < faceMat.length; f++) if (faceMat[f] < 0) faceMat[f] = defaultMat;
    }
    // 面法线 → 按（顶点, 平滑组）累加；平滑组 0 的面各自独立
    const fn = new Float32Array(faceMat.length * 3);
    for (let f = 0; f < faceMat.length; f++) {
      const [a, b, c] = [o.faces[f * 3] * 3, o.faces[f * 3 + 1] * 3, o.faces[f * 3 + 2] * 3];
      if (a >= o.pos.length || b >= o.pos.length || c >= o.pos.length) continue;
      const ux = o.pos[b] - o.pos[a], uy = o.pos[b + 1] - o.pos[a + 1], uz = o.pos[b + 2] - o.pos[a + 2];
      const vx = o.pos[c] - o.pos[a], vy = o.pos[c + 1] - o.pos[a + 1], vz = o.pos[c + 2] - o.pos[a + 2];
      fn.set([uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx], f * 3);
    }
    const keyOf = (f: number, v: number) => {
      const sg = o.smooth?.[f] ?? 1;
      return sg ? `${v}:${sg}` : `${v}:f${f}`;
    };
    const acc = new Map<string, number[]>();
    for (let f = 0; f < faceMat.length; f++) {
      for (let j = 0; j < 3; j++) {
        const k = keyOf(f, o.faces[f * 3 + j]);
        const n = acc.get(k) ?? [0, 0, 0];
        n[0] += fn[f * 3];
        n[1] += fn[f * 3 + 1];
        n[2] += fn[f * 3 + 2];
        acc.set(k, n);
      }
    }
    const byMat = new Map<number, { pos: number[]; nrm: number[]; uv: number[]; idx: number[]; map: Map<string, number> }>();
    for (let f = 0; f < faceMat.length; f++) {
      let g = byMat.get(faceMat[f]);
      if (!g) byMat.set(faceMat[f], (g = { pos: [], nrm: [], uv: [], idx: [], map: new Map() }));
      for (let j = 0; j < 3; j++) {
        const v = o.faces[f * 3 + j];
        if (v >= nv) continue;
        const k = keyOf(f, v);
        let i = g.map.get(k);
        if (i === undefined) {
          i = g.pos.length / 3;
          g.map.set(k, i);
          g.pos.push(o.pos[v * 3], o.pos[v * 3 + 1], o.pos[v * 3 + 2]);
          const n = acc.get(k)!;
          const l = Math.hypot(n[0], n[1], n[2]) || 1;
          g.nrm.push(n[0] / l, n[1] / l, n[2] / l);
          if (o.uvs && v * 2 + 1 < o.uvs.length) g.uv.push(o.uvs[v * 2], o.uvs[v * 2 + 1]);
        }
        g.idx.push(i);
      }
    }
    const prims: IRPrim[] = [];
    for (const [mi, g] of byMat) {
      if (g.idx.length < 3) continue;
      prims.push({ material: mi, positions: g.pos, normals: g.nrm, uvs: g.uv.length === (g.pos.length / 3) * 2 ? g.uv : null, indices: g.idx });
    }
    // 顶点已在世界空间：根节点只做轴向转换，网格节点为单位
    nodes.push({ name: o.name, parent: 0, mesh: prims });
  }
  return { nodes, materials, warnings };
}
