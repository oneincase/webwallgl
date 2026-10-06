// .mdl 编辑（EDITOR-PLAN W16 / W18）：一律经 W17 的无损文档读写，只动目标字段，
// 其余字节（顶点 / 索引 / 骨骼 / 未动的轨道）不变，各段偏移由 writeMdlDoc 重算。
import { readMdlDoc, writeMdlDoc } from "../../vendor/we-scene/pkg/mdl-write.js";
import type { MdlBoneDelta, MdlClip, MdlClipInit } from "../api/types";

type Str = string | { raw: Uint8Array };
type Track = { boneId: number; data: Float32Array };
type Event = { time: number; json: string };
type Anim = {
  id: number;
  unk0?: number;
  name: Str;
  mode: Str;
  fps: number;
  frameCount: number;
  unk1?: number;
  tracks: Track[];
  prefix?: Uint8Array;
  events?: Event[];
};
type Section = { type: string; raw?: Uint8Array; anims?: Anim[] };
type MdlDoc = {
  version?: number;
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
    events: (a.events ?? []).flatMap((e) => {
      const v = parseEvent(e.json);
      return v ? [{ frame: v.frame, name: v.name }] : [];
    }),
  }));
}

function parseEvent(json: string): { frame: number; name: string } | null {
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" && Number.isFinite(Number(v.frame)) && typeof v.name === "string" ? { frame: Number(v.frame), name: v.name } : null;
  } catch {
    return null;
  }
}

// ---------- 片段增删 / 元数据 / 帧事件（W18b） ----------
// 只在已有可编辑 MDLA 段的模型上做：无 MDLA 的模型走 MDLS 尾部静态装配姿势，凭空加段会改掉它的姿势语义。
// 引擎的绑定参考（bindTRS）取首个片段第 0 帧，所以首个片段不许删、新片段一律追加在末尾。

export const CLIP_MODES = ["loop", "mirror", "single"] as const;
/** 片段头合法范围：与读侧（mdl-parse / readMdlDoc 的动画头校验）同口径，超出读回时会被当成坏头 */
const clipMetaOk = (m: { name?: string; mode?: string; fps?: number; frameCount?: number }) =>
  (m.name === undefined || (m.name.length > 0 && m.name.length <= 64 && !m.name.includes("\0"))) &&
  (m.mode === undefined || (CLIP_MODES as readonly string[]).includes(m.mode)) &&
  (m.fps === undefined || (Number.isFinite(m.fps) && m.fps > 0 && m.fps <= 240)) &&
  (m.frameCount === undefined || (Number.isInteger(m.frameCount) && m.frameCount >= 1 && m.frameCount <= 100000));

/** 轨道按归一化时间线性重采样到 m 帧（欧拉角走最短方向，同 sampleTrackTRS） */
export function resampleTrack(data: Float32Array, m: number): Float32Array {
  const n = Math.floor(data.length / 9);
  const out = new Float32Array(m * 9);
  if (!n) return out;
  for (let j = 0; j < m; j++) {
    const x = m === 1 || n === 1 ? 0 : (j * (n - 1)) / (m - 1);
    const f0 = Math.floor(x);
    const f1 = Math.min(f0 + 1, n - 1);
    const t = x - f0;
    for (let c = 0; c < 9; c++) {
      const a = data[f0 * 9 + c];
      let d = data[f1 * 9 + c] - a;
      if (c >= 3 && c <= 5) {
        if (d > Math.PI) d -= 2 * Math.PI;
        else if (d < -Math.PI) d += 2 * Math.PI;
      }
      out[j * 9 + c] = t ? a + d * t : a;
    }
  }
  return out;
}

const PREFIX_BY_VERSION: Record<number, number> = { 13: 0, 14: 0, 16: 5, 17: 6, 19: 30, 21: 31, 23: 31 };
/** 新片段的前缀：沿用同文件全零前缀的长度（版本习惯），都没有就按版本表 */
function prefixFor(d: MdlDoc, anims: Anim[]): Uint8Array {
  const z = anims.find((a) => a.prefix && a.prefix.length <= 64 && a.prefix.every((b) => b === 0));
  const n = z ? z.prefix!.length : (PREFIX_BY_VERSION[d.version ?? 23] ?? ((d.version ?? 23) >= 21 ? 31 : 5));
  return new Uint8Array(n);
}

const eventJson = (frame: number, name: string) => JSON.stringify({ frame, name });

/**
 * 追加片段：source = 参照片段 id（缺省首个）。pose = "copy" 复制参照片段的轨道（帧数不同则重采样）；
 * "rest" 每骨每帧都填参照片段第 0 帧（首个片段第 0 帧 = 引擎绑定参考，即静止姿势）。
 * 轨数 / boneId 跟参照片段。新 id = 现有最大 id + 1。没有可编辑 MDLA / 参照不存在 / 头不合法时 null
 */
export function addMdlClip(
  bytes: Uint8Array,
  init: MdlClipInit,
  pose: "copy" | "rest" = "rest",
  source?: number,
): { bytes: Uint8Array; id: number } | null {
  const d = docOf(bytes);
  const anims = d && animsOf(d);
  if (!d || !anims?.length || !clipMetaOk(init) || anims.length >= 256) return null;
  const src = source === undefined ? anims[0] : anims.find((a) => a.id === source);
  if (!src || !src.tracks.length) return null;
  const frames = init.frameCount + 1;
  const tracks = src.tracks.map((t) => {
    if (pose === "copy") return { boneId: t.boneId, data: resampleTrack(t.data, frames) };
    const data = new Float32Array(frames * 9);
    const first = t.data.length >= 9 ? t.data.subarray(0, 9) : Float32Array.of(0, 0, 0, 0, 0, 0, 1, 1, 1);
    for (let f = 0; f < frames; f++) data.set(first, f * 9);
    return { boneId: t.boneId, data };
  });
  const id = Math.max(...anims.map((a) => a.id)) + 1;
  anims.push({ id, unk0: 0, name: init.name, mode: init.mode, fps: init.fps, frameCount: init.frameCount, unk1: 0, tracks, prefix: prefixFor(d, anims), events: [] });
  return { bytes: writeMdlDoc(d) as Uint8Array, id };
}

/** 删片段（首个片段是绑定参考，不许删）；不存在 / 是首个 / 不可编辑时 null */
export function removeMdlClip(bytes: Uint8Array, id: number): Uint8Array | null {
  const d = docOf(bytes);
  const anims = d && animsOf(d);
  const i = anims ? anims.findIndex((a) => a.id === id) : -1;
  if (!d || !anims || i <= 0) return null;
  anims.splice(i, 1);
  return writeMdlDoc(d) as Uint8Array;
}

/**
 * 改片段头：name / mode / fps / frameCount。改帧数时轨道按归一化时间重采样（保持「帧数 − frameCount」的差，
 * 通常是 loop 的首末重合帧），事件帧号钳进新范围；改 fps 时事件时刻随之重算。没变化的字段原样
 */
export function setMdlClipMeta(bytes: Uint8Array, id: number, meta: Partial<MdlClipInit>): Uint8Array | null {
  const d = docOf(bytes);
  const a = d && animsOf(d)?.find((x) => x.id === id);
  if (!d || !a || !clipMetaOk(meta)) return null;
  if (meta.name !== undefined) a.name = meta.name;
  if (meta.mode !== undefined) a.mode = meta.mode;
  const fc = meta.frameCount ?? a.frameCount;
  const resized = fc !== a.frameCount;
  if (resized) {
    for (const t of a.tracks) {
      const n = Math.floor(t.data.length / 9);
      if (n) t.data = resampleTrack(t.data, Math.max(1, fc + (n - a.frameCount)));
    }
    a.events = (a.events ?? []).map((e) => {
      const v = parseEvent(e.json);
      return v && v.frame > fc ? { time: e.time, json: eventJson(fc, v.name) } : e;
    });
    a.frameCount = fc;
  }
  if (meta.fps !== undefined) a.fps = meta.fps;
  if (meta.fps !== undefined || resized) {
    a.events = (a.events ?? []).map((e) => {
      const v = parseEvent(e.json);
      return v ? { time: v.frame / a.fps, json: e.json } : e;
    });
  }
  return writeMdlDoc(d) as Uint8Array;
}

/**
 * 整表替换片段的帧事件（按帧号排序；与原表某条 frame + name 相同的沿用原 JSON 串，保住其余字段）。
 * 帧号钳到 0..frameCount 取整、名字不能空；不存在 / 不可编辑时 null
 */
export function setMdlClipEvents(bytes: Uint8Array, id: number, events: ReadonlyArray<{ frame: number; name: string }>): Uint8Array | null {
  const d = docOf(bytes);
  const a = d && animsOf(d)?.find((x) => x.id === id);
  if (!d || !a || events.length > 4096 || events.some((e) => !Number.isFinite(e.frame) || !e.name || e.name.includes("\0"))) return null;
  const old = new Map<string, string>();
  for (const e of a.events ?? []) {
    const v = parseEvent(e.json);
    if (v) old.set(`${v.frame}\0${v.name}`, e.json);
  }
  a.events = events
    .map((e) => ({ frame: Math.min(Math.max(Math.round(e.frame), 0), a.frameCount), name: e.name }))
    .sort((x, y) => x.frame - y.frame)
    .map((e) => ({ time: e.frame / a.fps, json: old.get(`${e.frame}\0${e.name}`) ?? eventJson(e.frame, e.name) }));
  return writeMdlDoc(d) as Uint8Array;
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
