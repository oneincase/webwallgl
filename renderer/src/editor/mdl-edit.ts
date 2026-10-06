// .mdl 编辑（EDITOR-PLAN W16 / W18）：一律经 W17 的无损文档读写，只动目标字段，
// 其余字节（顶点 / 索引 / 骨骼 / 未动的轨道）不变，各段偏移由 writeMdlDoc 重算。
import { readMdlDoc, writeMdlDoc } from "../../vendor/we-scene/pkg/mdl-write.js";
import type { MdlBoneDelta, MdlClip } from "../api/types";

type Str = string | { raw: Uint8Array };
type Track = { boneId: number; data: Float32Array };
type Anim = { id: number; name: Str; mode: Str; fps: number; frameCount: number; tracks: Track[] };
type Section = { type: string; raw?: Uint8Array; anims?: Anim[] };
type MdlDoc = {
  raw?: Uint8Array;
  meshes?: Array<{ materials: Str[] }>;
  sections?: Section[];
};

function docOf(bytes: Uint8Array): MdlDoc | null {
  try {
    const d = readMdlDoc(bytes) as MdlDoc;
    return d.raw || !d.meshes ? null : d;
  } catch {
    return null;
  }
}

const text = (v: Str) => (typeof v === "string" ? v : String.fromCharCode(...v.raw));
const animsOf = (d: MdlDoc): Anim[] | null => {
  const s = d.sections?.find((x) => x.type === "MDLA");
  return s && !s.raw && s.anims ? s.anims : null;
};

export function mdlMeshMaterials(bytes: Uint8Array): Array<string | null> | null {
  const d = docOf(bytes);
  return d ? d.meshes!.map((m) => (typeof m.materials[0] === "string" ? m.materials[0] : null)) : null;
}

export function retargetMdlMaterial(bytes: Uint8Array, meshIndex: number, materialPath: string): Uint8Array | null {
  const d = docOf(bytes);
  const m = d?.meshes?.[meshIndex];
  if (!m || !materialPath || !m.materials.length) return null;
  m.materials[0] = materialPath;
  return writeMdlDoc(d) as Uint8Array;
}

export function mdlClips(bytes: Uint8Array): MdlClip[] | null {
  const d = docOf(bytes);
  const anims = d && animsOf(d);
  if (!d) return null;
  return (anims ?? []).map((a) => ({
    id: a.id,
    name: text(a.name),
    mode: text(a.mode),
    fps: a.fps,
    frameCount: a.frameCount,
    frames: Math.max(0, ...a.tracks.map((t) => Math.floor(t.data.length / 9))),
    tracks: a.tracks.length,
  }));
}

/**
 * 关键帧影响权重（逐帧）：radius < 0 = 整段 1；radius = 0 = 只有该帧；否则余弦衰减，
 * 距离 > radius 为 0。loop 片段按周期 frames−1 计距离（末帧与首帧重合）。
 */
export function boneDeltaWeights(frames: number, frame: number, radius: number, loop: boolean): Float64Array {
  const w = new Float64Array(Math.max(0, frames));
  const span = Math.max(1, frames - 1);
  for (let k = 0; k < frames; k++) {
    if (radius < 0) {
      w[k] = 1;
      continue;
    }
    let d = Math.abs(k - frame);
    if (loop) {
      d %= span;
      d = Math.min(d, span - d);
    }
    if (d > radius) continue;
    w[k] = radius === 0 ? (d === 0 ? 1 : 0) : 0.5 * (1 + Math.cos((Math.PI * d) / (radius + 1)));
  }
  return w;
}

/**
 * 给片段 animId 里骨 bone 的轨道在 frame 处加一个局部 TRS 增量（平移 / 欧拉角相加，缩放相乘），
 * 按 boneDeltaWeights 向两侧衰减。loop 片段原本首末帧重合时编辑后仍保持重合。
 * 片段 / 轨道 / 帧不存在或文档不可编辑时返回 null。
 */
export function applyBoneDelta(
  bytes: Uint8Array,
  animId: number,
  bone: number,
  frame: number,
  delta: MdlBoneDelta,
  radius: number,
): Uint8Array | null {
  const d = docOf(bytes);
  const a = d && animsOf(d)?.find((x) => x.id === animId);
  const tr = a?.tracks[bone];
  if (!d || !a || !tr) return null;
  const k = tr.data;
  const frames = Math.floor(k.length / 9);
  if (!(Number.isInteger(frame) && frame >= 0 && frame < frames)) return null;
  const loop = text(a.mode) === "loop";
  const closed = loop && frames > 1 && [0, 1, 2, 3, 4, 5, 6, 7, 8].every((c) => k[c] === k[(frames - 1) * 9 + c]);
  const w = boneDeltaWeights(frames, frame, radius, loop);
  const t = delta.t ?? [0, 0, 0];
  const r = delta.r ?? [0, 0, 0];
  const s = delta.s ?? [1, 1, 1];
  for (let f = 0; f < frames; f++) {
    const wf = w[f];
    if (!wf) continue;
    const b = f * 9;
    for (let c = 0; c < 3; c++) {
      k[b + c] += wf * t[c];
      k[b + 3 + c] += wf * r[c];
      k[b + 6 + c] *= 1 + wf * (s[c] - 1);
    }
  }
  if (closed) k.copyWithin((frames - 1) * 9, 0, 9);
  return writeMdlDoc(d) as Uint8Array;
}
