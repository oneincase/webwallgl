// .mdl 编辑（EDITOR-PLAN W16 / W18）：一律经 W17 的无损文档读写，只动目标字段，
// 其余字节（顶点 / 索引 / 骨骼 / 未动的轨道）不变，各段偏移由 writeMdlDoc 重算。
import { encodeMDL, meshVertexLayout, readMdlDoc, writeMdlDoc } from "../../vendor/we-scene/pkg/mdl-write.js";
import { parseMDL } from "../../vendor/we-scene/render/mdl-parse.js";
import type { MdlBoneDelta, MdlClip, MdlClipInit, MdlPart, MdlSpec } from "../api/types";

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
// MDLS 每骨记录：name / head0（仿真类型，旧代码误命名为 id）/ parent / 局部矩阵 / 尾部 meta JSON。
// meta 是骨骼约束与混规则（blend rule）在 .mdl 里的疑似落点（官方用户文档零 schema，见
// docs/PUPPET-WARP-FULL-PLAN.md §7），先做到「读得出、原样写得回」，语义留给 P3。
type Bone = { name: Str; head0?: number; parent: number; matrix: Float32Array; meta?: Str };
type Section = { type: string; raw?: Uint8Array; anims?: Anim[]; bones?: Bone[]; tail?: Uint8Array };
/** readMdlDoc 的子网格：顶点 / 索引保持**原始字节**，只有长度与字段偏移是语义 */
type MeshDoc = {
  materials: Str[];
  flagA: number;
  flagAExtra: number | null;
  aabb: Float32Array | null;
  meshFlag: number | null;
  vertexData: Uint8Array;
  indexData: Uint8Array;
  extra: Uint8Array;
};
type MdlDoc = {
  version?: number;
  /** 头部 u32@9：高位 0x01800000 = 打包族；源码工程族没有该标记（stride 由位掩码决定） */
  mdlFlag?: number;
  raw?: Uint8Array;
  meshes?: MeshDoc[];
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
const bonesOf = (d: MdlDoc): Bone[] | null => {
  const s = d.sections?.find((x) => x.type === "MDLS");
  return s && !s.raw && s.bones ? s.bones : null;
};

/** 从零编码 MDLV0023（W19）；spec 不合法时抛错（消息说明哪一项） */
export function encodeMdl(spec: MdlSpec): Uint8Array {
  return encodeMDL(spec) as Uint8Array;
}

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

// ---------- MDLS 骨骼元数据（P0：blend rule / 骨骼约束的落点先打通读写） ----------
// 官方用户文档只讲 UI 与语义，没有 schema；语料实测 meta 形如
// [{"a":null,"lamax":null,...,"tm":100.0,"tp":"20.48 -197.43 0"}]，与「Limit angle / Tip mass /
// Tip position」命名族吻合。P0 只保证**无损读出 + 原样写回**，语义解析留给 P3。

/** 骨骼数（MDLS 段结构可解析时）；不可编辑 / 无 MDLS 时 null */
export function mdlBoneCount(bytes: Uint8Array): number | null {
  const b = (() => {
    const d = docOf(bytes);
    return d && bonesOf(d);
  })();
  return b ? b.length : null;
}

/** 某根骨的 MDLS 元数据（head0 = 仿真类型；meta = 尾部 JSON，可为 null） */
export function mdlBoneMeta(bytes: Uint8Array, boneIndex: number): { head0: number | null; parent: number; meta: string | null } | null {
  const d = docOf(bytes);
  const b = d && bonesOf(d)?.[boneIndex];
  if (!b) return null;
  return { head0: b.head0 ?? null, parent: b.parent, meta: b.meta === undefined ? null : text(b.meta) };
}

const jsonOk = (s: string) => {
  if (s === "") return true;
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
};

/** 写某根骨的 MDLS 元数据：patch.head0（仿真类型整数）/ patch.meta（JSON 串，"" = 清空）。
 *  越界、head0 非整数、meta 不是合法 JSON（或含 \0）时 null；其余字节逐字节不变。 */
export function setMdlBoneMeta(bytes: Uint8Array, boneIndex: number, patch: { head0?: number; meta?: string }): Uint8Array | null {
  const d = docOf(bytes);
  const b = d && bonesOf(d)?.[boneIndex];
  if (!d || !b) return null;
  if (patch.head0 !== undefined && !Number.isInteger(patch.head0)) return null;
  if (patch.meta !== undefined && (patch.meta.includes("\0") || !jsonOk(patch.meta))) return null;
  let touched = false;
  if (patch.head0 !== undefined && patch.head0 !== (b.head0 ?? 1)) {
    b.head0 = patch.head0;
    touched = true;
  }
  if (patch.meta !== undefined) {
    const cur = b.meta === undefined ? null : text(b.meta);
    if (cur !== patch.meta) {
      b.meta = patch.meta === "" ? undefined : patch.meta;
      touched = true;
    }
  }
  return touched ? (writeMdlDoc(d) as Uint8Array) : bytes.slice();
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
 * 清空**全部**片段（P2 骨架应用用）：轨道里的骨号是按写入时的骨表打的，骨表一换整批失效，
 * 而 `removeMdlClip` 有「第一个片段不许删」的约束（那是对 UI 的保护，不能借它绕），所以单开一个。
 * 没有片段时返回 null（调用方 `?? bytes` 保持原样）
 */
export function clearMdlClips(bytes: Uint8Array): Uint8Array | null {
  const d = docOf(bytes);
  const anims = d && animsOf(d);
  if (!d || !anims || !anims.length) return null;
  anims.splice(0, anims.length);
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

// ---------- P1 网格几何：部件表 / 顶点 / 拓扑（mdl-parse 的 parts / partsMeta 对应写侧） ----------
// v>=21 的子网格尾部（readMeshes 的 extra）按这个顺序排列：
//   u8 unkA（=1 时再跟 [u8 标志]（标志非 0 时 3B + u32 长度 + 数据））
//   u8 hasParts（=1 时 u32 字节数 + N×(u32 id, i32 绘制序偏移, u32 start, u32 size)）
//   ver>21 时：u32 蒙版数 + N 条蒙版条目
// P1 只重写**部件表那一段**：unkA 块与蒙版块一律按原字节搬运（蒙版语义留给 P5）。

const dvOf = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

/** 拆 extra：head = 部件表之前的原始字节（含 unkA 块），tail = 蒙版块及其后 */
function splitExtra(
  extra: Uint8Array,
  ver: number,
): { head: Uint8Array; parts: MdlPart[] | null; tail: Uint8Array; maskCount: number } | null {
  if (ver < 21) return { head: extra, parts: null, tail: new Uint8Array(0), maskCount: 0 };
  if (extra.length < 2) return null;
  const dv = dvOf(extra);
  const at = (p: number) => dv.getUint32(p, true);
  let p = 0;
  const unkA = extra[p++];
  if (unkA === 1) {
    if (extra[p++]) {
      p += 3;
      if (p + 4 > extra.length) return null;
      p += 4 + at(p);
    }
  } else if (unkA !== 0) return null;
  if (p >= extra.length) return null;
  const head = extra.slice(0, p);
  const has = extra[p++];
  let parts: MdlPart[] | null = null;
  if (has) {
    if (p + 4 > extra.length) return null;
    const bytes = at(p);
    p += 4;
    if (bytes % 16 !== 0 || p + bytes > extra.length) return null;
    parts = [];
    for (let i = 0; i < bytes / 16; i++) {
      const b = p + i * 16;
      parts.push({ id: at(b), offset: dv.getInt32(b + 4, true), start: at(b + 8), size: at(b + 12) });
    }
    p += bytes;
  }
  const tail = extra.slice(p);
  const maskCount = ver > 21 && tail.length >= 4 ? dvOf(tail).getUint32(0, true) : 0;
  return { head, parts, tail, maskCount };
}

/** 合 extra（head 原样 + 新的部件表 + tail 原样）；ver>21 时保证 tail 至少有一个 u32 蒙版数 */
function joinExtra(head: Uint8Array, parts: MdlPart[] | null, tail: Uint8Array, ver: number): Uint8Array {
  const list = parts && parts.length ? parts : null;
  const table = list ? 4 + list.length * 16 : 0;
  const pad = ver > 21 && tail.length < 4 ? 4 - tail.length : 0;
  const out = new Uint8Array(head.length + 1 + table + tail.length + pad);
  out.set(head, 0);
  let p = head.length;
  out[p++] = list ? 1 : 0;
  if (list) {
    const dv = dvOf(out);
    dv.setUint32(p, list.length * 16, true);
    p += 4;
    for (const pt of list) {
      dv.setUint32(p, pt.id, true);
      dv.setInt32(p + 4, pt.offset, true);
      dv.setUint32(p + 8, pt.start, true);
      dv.setUint32(p + 12, pt.size, true);
      p += 16;
    }
  }
  out.set(tail, p);
  return out;
}

/** 部件表必须按索引区间首尾相接、恰好铺满索引表（与写侧 meshExtra 同口径） */
function partsOk(parts: MdlPart[], indexCount: number): boolean {
  let end = 0;
  for (const pt of parts) {
    if (!Number.isInteger(pt.id) || pt.id < 0) return false;
    if (!Number.isInteger(pt.offset) || Math.abs(pt.offset) > 0x7fffffff) return false;
    if (pt.start !== end || !Number.isInteger(pt.size) || pt.size < 0) return false;
    end += pt.size;
  }
  return end === indexCount;
}

/**
 * 候选 stride 的顺序：ver<23 的打包族恒 52 字节（`mdl-parse.js` 的 LAYOUTS 同一口径，
 * 与 meshFlag 无关）；ver>=23 由 meshFlag 位掩码决定（80 蒙皮 / 84 多一个 EXTRA4 / 48 真 3D）；
 * 源码工程族的 stride 由**头部** mdlFlag 位掩码决定。最后补一串已知布局兜底。
 */
function strideCandidates(d: MdlDoc, m: MeshDoc): number[] {
  const ver = d.version ?? 23;
  const out: number[] = [];
  const push = (s: number) => {
    if (Number.isInteger(s) && s >= 12 && !out.includes(s)) out.push(s);
  };
  if (ver < 23) push(52);
  push(meshVertexLayout(m.meshFlag ?? 0).stride);
  if (((d.mdlFlag ?? 0) & 0x01800000) === 0) push(meshVertexLayout(d.mdlFlag ?? 0).stride);
  push(ver >= 23 ? 80 : 80);
  push(84);
  push(48);
  for (const s of [52, 44, 32, 20, 56, 64]) push(s);
  return out;
}

/** 引擎解析器（mdl-parse.js）对每个子网格的权威读数 */
type ParsedCounts = { vertexCount: number; indexCount: number; indexWide: boolean };

const parsedCache = new WeakMap<Uint8Array, Array<ParsedCounts | null> | null>();

/**
 * 让引擎自己的解析器定 stride / 顶点数。自己按 meshFlag 猜是不够的：MDLV0013/0019/0021
 * 这类老版本顶点区长度**同时**能被 52 和 80 整除（实测 `嘴_puppet.mdl` 107120 = 2060×52
 * = 1339×80），只有解析器那三条自洽校验（顶点区长度 / 每顶点权重和为 1 / UV 落在 [0,1]）
 * 能分辨。猜错的后果不是报错而是**静默写坏**：改 z 会按错误 stride 落到别人字段上。
 * 解析失败（真机偶发）时才退回启发式。
 */
function parsedCountsOf(bytes: Uint8Array): Array<ParsedCounts | null> | null {
  const cached = parsedCache.get(bytes);
  if (cached !== undefined) return cached;
  let out: Array<ParsedCounts | null> | null = null;
  try {
    const p = parseMDL(bytes) as { meshes?: Array<{ vertexCount?: number; indexCount?: number; indexType?: string }> };
    out = (p?.meshes ?? []).map((m) => ({
      vertexCount: m.vertexCount ?? 0,
      indexCount: m.indexCount ?? 0,
      indexWide: m.indexType === "u32",
    }));
  } catch {
    out = null;
  }
  parsedCache.set(bytes, out);
  return out;
}

/** 某一 stride 下自洽才认：顶点区整除、索引宽度按顶点数、索引全在范围内、索引数是 3 的倍数 */
function countsAt(m: MeshDoc, stride: number): { stride: number; vertexCount: number; indexWide: boolean; indexCount: number } | null {
  if (!stride || m.vertexData.length % stride !== 0) return null;
  const vertexCount = m.vertexData.length / stride;
  if (!vertexCount) return null;
  const indexWide = vertexCount > 65535;
  const step = indexWide ? 4 : 2;
  if (m.indexData.length % step !== 0) return null;
  const indexCount = m.indexData.length / step;
  if (!indexCount || indexCount % 3 !== 0) return null;
  const dv = dvOf(m.indexData);
  for (let i = 0; i < indexCount; i++) {
    const v = indexWide ? dv.getUint32(i * 4, true) : dv.getUint16(i * 2, true);
    if (v >= vertexCount) return null;
  }
  return { stride, vertexCount, indexWide, indexCount };
}

/** 子网格的顶点 / 索引规模与字段 stride：优先用解析器读数，失败才按版本启发式 */
function meshCounts(
  d: MdlDoc,
  m: MeshDoc,
  parsed?: ParsedCounts | null,
): { stride: number; vertexCount: number; indexWide: boolean; indexCount: number } {
  if (parsed && parsed.vertexCount > 0 && m.vertexData.length % parsed.vertexCount === 0) {
    return {
      stride: m.vertexData.length / parsed.vertexCount,
      vertexCount: parsed.vertexCount,
      indexWide: parsed.indexWide,
      indexCount: parsed.indexCount,
    };
  }
  for (const s of strideCandidates(d, m)) {
    const c = countsAt(m, s);
    if (c) return c;
  }
  return { stride: 0, vertexCount: 0, indexWide: false, indexCount: 0 };
}

const meshOf = (bytes: Uint8Array, meshIndex: number): { d: MdlDoc; m: MeshDoc; c: ReturnType<typeof meshCounts> } | null => {
  if (!Number.isInteger(meshIndex) || meshIndex < 0) return null;
  const d = docOf(bytes);
  const m = d?.meshes?.[meshIndex];
  if (!d || !m || !m.vertexData) return null;
  return { d, m, c: meshCounts(d, m, parsedCountsOf(bytes)?.[meshIndex]) };
};

/** 子网格数；不可编辑时 null */
export function mdlMeshCount(bytes: Uint8Array): number | null {
  const d = docOf(bytes);
  return d ? (d.meshes?.length ?? 0) : null;
}

/** 子网格摘要：顶点 / 索引规模、字段 stride、蒙版数、部件表（含 P5 要接管的蒙版计数） */
export function mdlMeshInfo(
  bytes: Uint8Array,
  meshIndex: number,
): { vertexCount: number; stride: number; indexCount: number; indexWide: boolean; maskCount: number; parts: MdlPart[] | null } | null {
  const hit = meshOf(bytes, meshIndex);
  if (!hit) return null;
  const c = hit.c;
  const ex = splitExtra(hit.m.extra ?? new Uint8Array(0), hit.d.version ?? 23);
  return {
    vertexCount: c.vertexCount,
    stride: c.stride,
    indexCount: c.indexCount,
    indexWide: c.indexWide,
    maskCount: ex ? ex.maskCount : 0,
    parts: ex ? ex.parts : null,
  };
}

/** 顶点位置（每顶点 xyz，模型空间）；不可编辑 / 越界时 null */
export function mdlMeshPositions(bytes: Uint8Array, meshIndex: number): Float32Array | null {
  const hit = meshOf(bytes, meshIndex);
  if (!hit) return null;
  const { stride, vertexCount } = hit.c;
  if (!stride) return null;
  const dv = dvOf(hit.m.vertexData);
  const out = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) {
    for (let k = 0; k < 3; k++) out[i * 3 + k] = dv.getFloat32(i * stride + k * 4, true);
  }
  return out;
}

/** 索引表（u32 展开，宽度按顶点数判定）；不可编辑 / 越界时 null */
export function mdlMeshIndices(bytes: Uint8Array, meshIndex: number): Uint32Array | null {
  const hit = meshOf(bytes, meshIndex);
  if (!hit) return null;
  const { indexWide, indexCount } = hit.c;
  if (!Number.isInteger(indexCount)) return null;
  const dv = dvOf(hit.m.indexData);
  const out = new Uint32Array(indexCount);
  for (let i = 0; i < indexCount; i++) out[i] = indexWide ? dv.getUint32(i * 4, true) : dv.getUint16(i * 2, true);
  return out;
}

/**
 * 写部件表（limb 表）。parts = null / [] 表示去掉部件表（hasParts 置 0）。
 * 校验：id 非负整数、区间首尾相接铺满索引表；v<21 无此块 ⇒ null。
 * 网格带蒙版（maskCount>0）时默认拒绝（蒙版条目按 limb 索引，P5 才接管语义），
 * 显式 opts.allowMasked = true 才按原字节保留蒙版继续写。
 */
export function setMdlParts(
  bytes: Uint8Array,
  meshIndex: number,
  parts: MdlPart[] | null,
  opts?: { allowMasked?: boolean },
): Uint8Array | null {
  const hit = meshOf(bytes, meshIndex);
  if (!hit) return null;
  const ver = hit.d.version ?? 23;
  // v<21 的子网格没有 extra 块，写进去会凭空多出 1 字节把索引区顶歪
  if (ver < 21) return null;
  const ex = splitExtra(hit.m.extra ?? new Uint8Array(0), ver);
  if (!ex) return null;
  if (ex.maskCount > 0 && !opts?.allowMasked) return null;
  if (parts && parts.length) {
    if (!partsOk(parts, hit.c.indexCount)) return null;
  }
  hit.m.extra = joinExtra(ex.head, parts && parts.length ? parts : null, ex.tail, ver);
  return writeMdlDoc(hit.d) as Uint8Array;
}

/** 写顶点位置（每顶点 xyz）；长度必须等于顶点数 ×3，数值必须有限。ver>=17 时同步重算 AABB */
export function setMdlPositions(bytes: Uint8Array, meshIndex: number, positions: ArrayLike<number>): Uint8Array | null {
  const hit = meshOf(bytes, meshIndex);
  if (!hit) return null;
  const { stride, vertexCount } = hit.c;
  if (!stride || positions.length !== vertexCount * 3) return null;
  for (let i = 0; i < positions.length; i++) if (!Number.isFinite(positions[i])) return null;
  const dv = dvOf(hit.m.vertexData);
  for (let i = 0; i < vertexCount; i++) {
    for (let k = 0; k < 3; k++) dv.setFloat32(i * stride + k * 4, positions[i * 3 + k], true);
  }
  if (hit.m.aabb) hit.m.aabb = aabbOf(positions, vertexCount);
  return writeMdlDoc(hit.d) as Uint8Array;
}

/** 只写 z（透视挤出的深度）：每顶点一个值，其余分量与索引 / 部件不动 */
export function setMdlVertexZ(bytes: Uint8Array, meshIndex: number, z: ArrayLike<number>): Uint8Array | null {
  const hit = meshOf(bytes, meshIndex);
  if (!hit) return null;
  const { stride, vertexCount } = hit.c;
  if (!stride || z.length !== vertexCount) return null;
  for (let i = 0; i < z.length; i++) if (!Number.isFinite(z[i])) return null;
  const dv = dvOf(hit.m.vertexData);
  for (let i = 0; i < vertexCount; i++) dv.setFloat32(i * stride + 8, z[i], true);
  if (hit.m.aabb) hit.m.aabb = aabbFromVertexData(hit.m.vertexData, stride, vertexCount);
  return writeMdlDoc(hit.d) as Uint8Array;
}

/**
 * 写拓扑（索引表 = 三角形列表），parts 缺省时：老部件表仍能铺满新索引表就保留，否则
 * （老的有部件表但不匹配）拒绝，避免写出「部件表与实际索引区间不符」的模型。
 * parts = null 显式表示去掉部件表。
 */
export function setMdlTopology(
  bytes: Uint8Array,
  meshIndex: number,
  indices: ArrayLike<number>,
  parts?: MdlPart[] | null,
): Uint8Array | null {
  const hit = meshOf(bytes, meshIndex);
  if (!hit) return null;
  const c = hit.c;
  if (!c.stride) return null;
  const packed = packIndicesIn(indices, c.vertexCount);
  if (!packed) return null;
  const ver = hit.d.version ?? 23;
  // v<21 没有 extra 块：既没有部件表可沿用，也不许凭空写一个（会把索引区顶歪）
  if (ver < 21) {
    if (parts && parts.length) return null;
    hit.m.indexData = packed;
    return writeMdlDoc(hit.d) as Uint8Array;
  }
  const ex = splitExtra(hit.m.extra ?? new Uint8Array(0), ver);
  if (!ex) return null;
  if (ex.maskCount > 0) return null;
  let next = parts;
  if (next === undefined) {
    if (ex.parts && !partsOk(ex.parts, indices.length)) return null;
    next = ex.parts;
  }
  if (next && next.length && !partsOk(next, indices.length)) return null;
  hit.m.indexData = packed;
  hit.m.extra = joinExtra(ex.head, next && next.length ? next : null, ex.tail, ver);
  return writeMdlDoc(hit.d) as Uint8Array;
}

function packIndicesIn(indices: ArrayLike<number>, vertexCount: number): Uint8Array | null {
  if (indices.length % 3 !== 0 || indices.length === 0) return null;
  const wide = vertexCount > 65535;
  const out = new Uint8Array(indices.length * (wide ? 4 : 2));
  const dv = dvOf(out);
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i];
    if (!Number.isInteger(v) || v < 0 || v >= vertexCount) return null;
    if (wide) dv.setUint32(i * 4, v, true);
    else dv.setUint16(i * 2, v, true);
  }
  return out;
}

function aabbOf(pos: ArrayLike<number>, vertexCount: number): Float32Array {
  const a = Float32Array.of(Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity);
  for (let i = 0; i < vertexCount; i++) {
    for (let k = 0; k < 3; k++) {
      const v = pos[i * 3 + k];
      if (v < a[k]) a[k] = v;
      if (v > a[k + 3]) a[k + 3] = v;
    }
  }
  return a;
}

// ─── P2：骨架与权重（写侧） ────────────────────────────────────────────────
//
// 与 P1 的网格 API 同一套惯例：`meshOf` 取文档 → 就地改 → `writeMdlDoc` 回写（段长变化由
// writeMdlDoc 负责重排与回填段结束偏移）。骨表在 MDLS：每骨 `name cstr | i32 head0 |
// i32 parent | u32 64 | 16×f32 局部矩阵 | meta cstr`，后面跟定长尾表。

/** MDLS 一条骨记录（P2 读侧视图）：命名 / head0 / 父级 / 16 分量局部矩阵 / meta JSON 文本 */
export type MdlBoneInfo = { name: string; head0: number; parent: number; matrix: Float32Array; meta: string };

/** 要写进 MDLS 的骨：matrix 省缺 = 单位矩阵（根骨）/ 调用方给的局部平移矩阵 */
export type MdlBoneSpec = {
  name?: string;
  parent: number;
  matrix?: ArrayLike<number>;
  head0?: number;
  meta?: string;
};

const BONE_IDENTITY = Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);

/** 读骨骼表（顺序 = MDLS 记录顺序 = 引擎的骨号）；无 MDLS 或整份退成 raw 时 null */
export function mdlBones(bytes: Uint8Array): MdlBoneInfo[] | null {
  const d = docOf(bytes);
  const bones = d && bonesOf(d);
  if (!bones) return null;
  return bones.map((b) => ({
    name: text(b.name),
    head0: b.head0 ?? 1,
    parent: b.parent,
    matrix: Float32Array.from(b.matrix),
    meta: b.meta === undefined ? "" : text(b.meta),
  }));
}

/** 只改骨名：数量必须一致，父级 / 矩阵 / head0 / meta / 尾表**原样保留**（改名不动任何装配数据） */
export function setMdlBoneNames(bytes: Uint8Array, names: ReadonlyArray<string>): Uint8Array | null {
  const d = docOf(bytes);
  const bones = d && bonesOf(d);
  if (!d || !bones || names.length !== bones.length || names.length === 0) return null;
  if (names.some((n) => typeof n !== "string" || n.length > 255)) return null;
  bones.forEach((b, i) => {
    b.name = names[i];
  });
  return writeMdlDoc(d) as Uint8Array;
}

const boneMatrixOk = (m: ArrayLike<number>) =>
  m.length === 16 && Array.prototype.every.call(m, (v: number) => Number.isFinite(v));

/**
 * 重写整张骨骼表（骨数可变）。校验：parent 必须 -1 或更靠前的骨（引擎按序累乘父链，
 * 见 mdl-write 的 checkBones）、矩阵 16 分量且有限。
 *
 * 尾表（静态装配姿势，`parseStaticPose` 读）按骨数 N 定长，因此：
 * - 骨数不变（tail: "auto"）⇒ **原样保留**旧尾表 —— 真实语料里 106 个模型靠它摆装配姿势，
 *   改名 / 挪骨不许把它丢掉；
 * - 骨数变了 ⇒ 旧尾表三张表（64N 姿势 / 76N / 1+4N 排列）全部失效，**丢弃**（auto 的默认行为）；
 *   不重建是因为实测真实尾表长度普遍大于 `14+84N`（另有它表），编不出同形的数据。
 *   `tail: "keep" | "drop"` 可强制。
 */
export function setMdlSkeleton(
  bytes: Uint8Array,
  bones: ReadonlyArray<MdlBoneSpec>,
  opts?: { tail?: "auto" | "keep" | "drop" },
): Uint8Array | null {
  const d = docOf(bytes);
  const sec = d?.sections?.find((s) => s.type === "MDLS");
  if (!d || !sec || sec.raw || !sec.bones) return null;
  if (!Array.isArray(bones) || bones.length === 0 || bones.length > 4096) return null;
  const next: Bone[] = [];
  for (let i = 0; i < bones.length; i++) {
    const b = bones[i];
    if (!Number.isInteger(b.parent) || b.parent < -1 || b.parent >= i) return null;
    const matrix = b.matrix === undefined ? BONE_IDENTITY : Float32Array.from(b.matrix as ArrayLike<number>);
    if (!boneMatrixOk(matrix)) return null;
    next.push({ name: b.name ?? "", head0: b.head0 ?? 1, parent: b.parent, matrix, meta: b.meta ?? "" });
  }
  const sameCount = next.length === sec.bones.length;
  sec.bones = next;
  const mode = opts?.tail ?? "auto";
  if (mode === "drop" || (mode === "auto" && !sameCount)) sec.tail = new Uint8Array(0);
  return writeMdlDoc(d) as Uint8Array;
}

/** 蒙皮槽：每顶点 4 个骨号 + 4 个权重（模型空间无关，纯格式）；非蒙皮 / 不可编辑时 null */
export function mdlSkin(
  bytes: Uint8Array,
  meshIndex: number,
): { joints: Uint32Array; weights: Float32Array; boneCount: number | null } | null {
  const hit = meshOf(bytes, meshIndex);
  if (!hit || !hit.c.stride) return null;
  const slots = skinSlots(hit.m, hit.c.stride);
  if (!slots) return null;
  const { vertexCount } = hit.c;
  const dv = dvOf(hit.m.vertexData);
  const joints = new Uint32Array(vertexCount * 4);
  const weights = new Float32Array(vertexCount * 4);
  for (let i = 0; i < vertexCount; i++) {
    for (let k = 0; k < 4; k++) {
      joints[i * 4 + k] = dv.getUint32(i * hit.c.stride + slots.bone + k * 4, true);
      weights[i * 4 + k] = dv.getFloat32(i * hit.c.stride + slots.weight + k * 4, true);
    }
  }
  return { joints, weights, boneCount: mdlBoneCount(bytes) };
}

/**
 * 写 4 槽权重：长度必须 = 顶点数 ×4，全部有限且非负，每顶点 Σ>0（引擎按 Σ 归一，
 * 全零顶点会消失）。骨号不动 —— 只做「4 槽内再分配」就靠这个（P2 的笔刷 / 平滑）。
 */
export function setMdlWeights(bytes: Uint8Array, meshIndex: number, weights: ArrayLike<number>): Uint8Array | null {
  const hit = meshOf(bytes, meshIndex);
  if (!hit || !hit.c.stride) return null;
  const slots = skinSlots(hit.m, hit.c.stride);
  if (!slots) return null;
  const { vertexCount } = hit.c;
  if (weights.length !== vertexCount * 4) return null;
  for (let i = 0; i < vertexCount; i++) {
    let sum = 0;
    for (let k = 0; k < 4; k++) {
      const w = weights[i * 4 + k];
      if (!Number.isFinite(w) || w < 0) return null;
      sum += w;
    }
    if (sum <= 0) return null;
  }
  const dv = dvOf(hit.m.vertexData);
  for (let i = 0; i < vertexCount; i++) {
    for (let k = 0; k < 4; k++) dv.setFloat32(i * hit.c.stride + slots.weight + k * 4, weights[i * 4 + k], true);
  }
  return writeMdlDoc(hit.d) as Uint8Array;
}

/** 写 4 槽骨号：长度必须 = 顶点数 ×4，整数且落在 [0, 骨数)（骨数读不到时只校验非负整数） */
export function setMdlBoneIdx(bytes: Uint8Array, meshIndex: number, joints: ArrayLike<number>): Uint8Array | null {
  const hit = meshOf(bytes, meshIndex);
  if (!hit || !hit.c.stride) return null;
  const slots = skinSlots(hit.m, hit.c.stride);
  if (!slots) return null;
  const { vertexCount } = hit.c;
  if (joints.length !== vertexCount * 4) return null;
  const boneCount = mdlBoneCount(bytes);
  for (let i = 0; i < joints.length; i++) {
    const j = joints[i];
    if (!Number.isInteger(j) || j < 0) return null;
    if (boneCount !== null && j >= boneCount) return null;
  }
  const dv = dvOf(hit.m.vertexData);
  for (let i = 0; i < joints.length; i++) dv.setUint32(Math.floor(i / 4) * hit.c.stride + slots.bone + (i % 4) * 4, joints[i], true);
  return writeMdlDoc(hit.d) as Uint8Array;
}

/** 蒙皮槽在顶点记录里的偏移：先按 meshFlag 的位掩码（0x800000 骨号 / 0x1000000 权重），
 *  flag 缺失时按 stride ≥ 72 认定是打包族蒙皮布局（实测两种蒙皮 stride 的槽偏移都是 40 / 56） */
function skinSlots(m: MeshDoc, stride: number): { bone: number; weight: number } | null {
  const flag = m.meshFlag;
  if (flag !== null && flag !== undefined) {
    const l = meshVertexLayout(flag) as { bone: number; weight: number; stride: number };
    if (l.bone >= 0 && l.weight >= 0) return { bone: l.bone, weight: l.weight };
    return null;
  }
  if (stride >= 72) return { bone: 40, weight: 56 };
  return null;
}

/** 就地读已写入的顶点字节算 AABB（z 改动后头部 AABB 要跟着走，否则引擎剔除会算错） */
function aabbFromVertexData(data: Uint8Array, stride: number, vertexCount: number): Float32Array {
  const dv = dvOf(data);
  const a = Float32Array.of(Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity);
  for (let i = 0; i < vertexCount; i++) {
    for (let k = 0; k < 3; k++) {
      const v = dv.getFloat32(i * stride + k * 4, true);
      if (v < a[k]) a[k] = v;
      if (v > a[k + 3]) a[k + 3] = v;
    }
  }
  return a;
}
