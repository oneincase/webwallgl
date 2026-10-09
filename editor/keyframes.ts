// 关键帧动画：图层字段的 `{ value, animation: { c0..cN, options, relative } }`（WE 原生格式，
// 引擎 render/animation.js 求值）。语料 350 张场景壁纸实测：
// - 变换三件套与 color 3 通道（angles 为弧度），alpha / brightness 1 通道；
// - options 最常见 `{ fps: 30, length, mode, wraploop: false }`，mode = loop / single / mirror；
// - 关键帧恒为 6 字段 `{ back, frame, front, lockangle, locklength, value }`，frame 为整数；
//   front {enabled:true,x:1,y:0} + back {enabled:true,x:-1,y:0} = 平滑（缓入缓出），enabled:false = 线性。
// 编辑器新建的动画一律绝对值（relative:false）；外来 relative 动画打关键帧时按「值 − 基准」写回。

import { unwrap, type SceneObject } from "./doc";
import type { EditorLayerProps } from "../renderer/src/api/editor";

export const ANIM_FIELDS = ["origin", "scale", "angles", "alpha", "color", "brightness"] as const;
export type AnimField = (typeof ANIM_FIELDS)[number];
export const CHANNELS: Record<AnimField, number> = { origin: 3, scale: 3, angles: 3, alpha: 1, color: 3, brightness: 1 };

export const ANIM_MODES = ["loop", "mirror", "single"] as const;
export type AnimMode = (typeof ANIM_MODES)[number];

export const DEFAULT_FPS = 30;
export const DEFAULT_LENGTH = 90;
export const MAX_LENGTH = 30 * 600;

type Handle = { enabled: boolean; x: number; y: number } & Record<string, unknown>;
type Key = { back: Handle; frame: number; front: Handle; lockangle: boolean; locklength: boolean; value: number };
type Anim = Record<string, unknown> & { options: Record<string, unknown>; relative?: boolean };
type Wrapped = Record<string, unknown> & { value?: unknown; animation?: Anim };

export type KeyView = { frame: number; value: number[] };
export type AnimView = {
  fps: number;
  length: number;
  mode: AnimMode;
  relative: boolean;
  /** 全部关键帧两侧都启用手柄 */
  smooth: boolean;
  /** 各通道关键帧帧号的并集（升序）；value 为该帧各通道的关键帧值，缺的通道为 NaN */
  keys: KeyView[];
  channels: number;
};

const r5 = (v: number) => {
  const r = Math.round(v * 1e5) / 1e5;
  return Object.is(r, -0) ? 0 : r;
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function animOf(obj: SceneObject, field: string): Anim | null {
  const v = obj[field];
  if (!isObj(v) || !isObj(v.animation) || !isObj((v.animation as Anim).options)) return null;
  return v.animation as Anim;
}

function channelsOf(a: Anim): Key[][] {
  const out: Key[][] = [];
  for (let i = 0; Array.isArray(a[`c${i}`]); i++) out.push(a[`c${i}`] as Key[]);
  return out;
}

/** 字段的静态值（动画的基准）→ 数组；alpha 为单元素 */
export function baseValue(obj: SceneObject, field: AnimField): number[] {
  const raw = unwrap(obj[field]);
  const n = CHANNELS[field];
  const dflt = field === "scale" || field === "alpha" || field === "color" || field === "brightness" ? 1 : 0;
  const arr =
    typeof raw === "string"
      ? raw.trim().split(/\s+/).map(Number)
      : typeof raw === "number"
        ? Array(n).fill(raw)
        : Array.isArray(raw)
          ? raw.map(Number)
          : [];
  return Array.from({ length: n }, (_, i) => (Number.isFinite(arr[i]) ? arr[i] : dflt));
}

export function isAnimated(obj: SceneObject, field: string): boolean {
  return !!animOf(obj, field);
}

export function animatedFields(obj: SceneObject): AnimField[] {
  return ANIM_FIELDS.filter((f) => isAnimated(obj, f));
}

export function getAnim(obj: SceneObject, field: AnimField): AnimView | null {
  const a = animOf(obj, field);
  if (!a) return null;
  const o = a.options;
  const chans = channelsOf(a);
  const frames = [...new Set(chans.flatMap((c) => c.map((k) => Number(k.frame))))].filter(Number.isFinite).sort((x, y) => x - y);
  const keys = frames.map((frame) => ({
    frame,
    value: chans.map((c) => {
      const k = c.find((kk) => Number(kk.frame) === frame);
      return k ? Number(k.value) : NaN;
    }),
  }));
  const all = chans.flat();
  return {
    fps: Number(o.fps) > 0 ? Number(o.fps) : DEFAULT_FPS,
    length: Number(o.length) > 0 ? Number(o.length) : 0,
    mode: (ANIM_MODES as readonly unknown[]).includes(o.mode) ? (o.mode as AnimMode) : "single",
    relative: a.relative === true,
    smooth: all.length > 0 && all.every((k) => k.front?.enabled === true && k.back?.enabled === true),
    keys,
    channels: chans.length,
  };
}

/** 场景时间 t（秒）落在动画的第几帧：按 mode 折回 [0, length]（与引擎 wrapFrame 同口径），取整 */
export function frameAt(view: Pick<AnimView, "fps" | "length" | "mode">, t: number): number {
  const len = view.length > 0 ? view.length : 1;
  let f = Math.max(0, t) * view.fps;
  if (view.mode === "loop") f %= len;
  else if (view.mode === "mirror") {
    f %= 2 * len;
    if (f > len) f = 2 * len - f;
  } else f = Math.min(len, f);
  return Math.min(len, Math.round(f));
}

function makeKey(frame: number, value: number, smooth: boolean): Key {
  return {
    back: { enabled: smooth, x: -1, y: 0 },
    frame,
    front: { enabled: smooth, x: 1, y: 0 },
    lockangle: true,
    locklength: true,
    value: r5(value),
  };
}

export type AnimOptions = { length?: number; mode?: AnimMode };

/**
 * 给字段开动画：当前值 cur 作为第 0 帧关键帧（绝对值），静态值保留为基准。
 * 字段上已有的 `user` / `script` 包装保留。已有动画 / 值的维度不对返回 false。
 */
export function enableAnim(obj: SceneObject, field: AnimField, cur: readonly number[], opts: AnimOptions = {}): boolean {
  if (isAnimated(obj, field) || cur.length !== CHANNELS[field] || !cur.every(Number.isFinite)) return false;
  const length = opts.length ?? DEFAULT_LENGTH;
  const mode = opts.mode ?? "loop";
  if (!validLength(length) || !(ANIM_MODES as readonly string[]).includes(mode)) return false;
  const anim: Anim = { options: { fps: DEFAULT_FPS, length, mode, wraploop: false }, relative: false };
  cur.forEach((v, i) => (anim[`c${i}`] = [makeKey(0, v, true)]));
  const raw = obj[field];
  if (isObj(raw)) (raw as Wrapped).animation = anim;
  else obj[field] = { animation: anim, value: raw === undefined ? defaultRaw(field) : raw };
  return true;
}

function defaultRaw(field: AnimField): unknown {
  return field === "alpha" || field === "brightness" ? 1 : field === "scale" || field === "color" ? "1 1 1" : "0 0 0";
}

const validLength = (n: number) => Number.isInteger(n) && n >= 1 && n <= MAX_LENGTH;

/**
 * 关掉字段动画：去掉 animation；静态值写成 keep（通常是当前画面上的值），
 * 包装里只剩 value 时解包成裸值。
 */
export function disableAnim(obj: SceneObject, field: AnimField, keep?: readonly number[]): boolean {
  const raw = obj[field];
  if (!isAnimated(obj, field) || !isObj(raw)) return false;
  const w = raw as Wrapped;
  delete w.animation;
  if (keep && keep.length === CHANNELS[field] && keep.every(Number.isFinite)) {
    w.value = field === "alpha" || field === "brightness" ? r5(keep[0]) : keep.map((v) => String(r5(v))).join(" ");
  }
  if (Object.keys(w).length === 1 && "value" in w) obj[field] = w.value;
  return true;
}

/**
 * 在 frame 处打关键帧（已有则改值）：abs 是画面上的绝对值，relative 动画按「abs − 基准」写入。
 * 新关键帧沿用该动画现有的插值风格（全平滑则平滑，否则线性）。
 */
export function setKey(obj: SceneObject, field: AnimField, frame: number, abs: readonly number[]): boolean {
  const a = animOf(obj, field);
  const view = getAnim(obj, field);
  if (!a || !view || !Number.isInteger(frame) || frame < 0 || frame > view.length) return false;
  const chans = channelsOf(a);
  if (abs.length !== chans.length || !abs.every(Number.isFinite)) return false;
  const base = view.relative ? baseValue(obj, field) : null;
  const smooth = view.keys.length === 0 || view.smooth;
  let changed = false;
  chans.forEach((c, i) => {
    const v = r5(abs[i] - (base ? base[i] ?? 0 : 0));
    const at = c.findIndex((k) => Number(k.frame) === frame);
    if (at >= 0) {
      if (c[at].value !== v) {
        c[at].value = v;
        changed = true;
      }
      return;
    }
    const ins = c.findIndex((k) => Number(k.frame) > frame);
    c.splice(ins < 0 ? c.length : ins, 0, makeKey(frame, v, smooth));
    changed = true;
  });
  return changed;
}

/** 删掉 frame 处的关键帧（各通道）。删完会一帧不剩时拒绝 —— 那该是「关闭动画」 */
export function removeKey(obj: SceneObject, field: AnimField, frame: number): boolean {
  const a = animOf(obj, field);
  if (!a) return false;
  const chans = channelsOf(a);
  if (!chans.some((c) => c.some((k) => Number(k.frame) === frame))) return false;
  if (chans.some((c) => c.every((k) => Number(k.frame) === frame))) return false;
  chans.forEach((c, i) => (a[`c${i}`] = c.filter((k) => Number(k.frame) !== frame)));
  return true;
}

/**
 * 把时刻 fromT（秒）上的关键帧整体挪到 toT：图层上每条动画在 fromT 有关键帧的都挪（各按自己的 fps 换帧、
 * 钳进 [0, length]）。任一条的目标帧已被别的关键帧占用就整体拒绝、一处不改（结构编辑不回滚，必须先验后改）。
 */
export function moveKeyTime(obj: SceneObject, fromT: number, toT: number): boolean {
  if (!Number.isFinite(fromT) || !Number.isFinite(toT)) return false;
  const plan: Array<{ a: Anim; from: number; to: number }> = [];
  for (const f of animatedFields(obj)) {
    const v = getAnim(obj, f)!;
    const from = Math.round(fromT * v.fps);
    if (!v.keys.some((k) => k.frame === from)) continue;
    const to = Math.max(0, Math.min(v.length, Math.round(toT * v.fps)));
    if (to === from) continue;
    if (v.keys.some((k) => k.frame === to)) return false;
    plan.push({ a: animOf(obj, f)!, from, to });
  }
  for (const { a, from, to } of plan) {
    for (const c of channelsOf(a)) {
      for (const k of c) if (Number(k.frame) === from) k.frame = to;
      c.sort((x, y) => Number(x.frame) - Number(y.frame));
    }
  }
  return plan.length > 0;
}

/** 时长（帧）不能短于最后一个关键帧；模式三选一 */
export function setAnimOption(obj: SceneObject, field: AnimField, opt: "length" | "mode", value: number | string): boolean {
  const a = animOf(obj, field);
  const view = getAnim(obj, field);
  if (!a || !view) return false;
  if (opt === "length") {
    const n = Number(value);
    const last = view.keys.length ? view.keys[view.keys.length - 1].frame : 0;
    if (typeof value !== "number" || !validLength(n) || n < last || n === view.length) return false;
    a.options.length = n;
    return true;
  }
  if (!(ANIM_MODES as readonly unknown[]).includes(value) || a.options.mode === value) return false;
  a.options.mode = value;
  return true;
}

/** 插值风格：平滑 = 两侧手柄启用（缓入缓出），线性 = 关闭；手柄长度 / 偏移保留 */
export function setSmooth(obj: SceneObject, field: AnimField, smooth: boolean): boolean {
  const a = animOf(obj, field);
  if (!a) return false;
  let changed = false;
  for (const c of channelsOf(a)) {
    for (const k of c) {
      for (const side of ["front", "back"] as const) {
        const h = isObj(k[side]) ? k[side] : (k[side] = { enabled: false, x: side === "front" ? 1 : -1, y: 0 });
        if (h.enabled !== smooth) {
          h.enabled = smooth;
          changed = true;
        }
      }
    }
  }
  return changed;
}

/** 检视器 / 视口改动里落在已开动画字段上的部分，转成关键帧值（alpha → [alpha]） */
export function splitAnimated(
  obj: SceneObject,
  patch: Partial<EditorLayerProps>,
): { plain: Partial<EditorLayerProps>; keyed: Partial<Record<AnimField, number[]>> } {
  const plain: Partial<EditorLayerProps> = { ...patch };
  const keyed: Partial<Record<AnimField, number[]>> = {};
  for (const f of ANIM_FIELDS) {
    const v = patch[f];
    if (v === undefined || !isAnimated(obj, f)) continue;
    keyed[f] = typeof v === "number" ? [v] : [...(v as readonly number[])];
    delete plain[f];
  }
  return { plain, keyed };
}

/** 图层全部关键帧的时刻（秒，首个周期内），供时间轴打标记 */
export function keyTimes(obj: SceneObject): number[] {
  const out = new Set<number>();
  for (const f of animatedFields(obj)) {
    const v = getAnim(obj, f)!;
    for (const k of v.keys) out.add(Math.round((k.frame / v.fps) * 1000) / 1000);
  }
  return [...out].sort((a, b) => a - b);
}

/** 时间轴按层动画条：最长那条动画的时长（秒）与播放模式 + 全部关键帧时刻 */
export function animSummary(obj: SceneObject): { length: number; mode: AnimMode; keys: number[] } | null {
  let best: AnimView | null = null;
  for (const f of animatedFields(obj)) {
    const v = getAnim(obj, f)!;
    if (!best || v.length / v.fps > best.length / best.fps) best = v;
  }
  if (!best) return null;
  return { length: Math.round((best.length / best.fps) * 1000) / 1000, mode: best.mode, keys: keyTimes(obj) };
}

/** 关键帧剪贴板：字段 → 画面上的绝对值（relative 动画已加回基准） */
export type KeyClip = Partial<Record<AnimField, number[]>>;

/** 复制时刻 t 上的关键帧（各动画按自己的 fps / 模式折回到帧）；该时刻一个关键帧都没有返回 null */
export function copyKeysAt(obj: SceneObject, t: number): KeyClip | null {
  if (!Number.isFinite(t)) return null;
  const clip: KeyClip = {};
  for (const f of animatedFields(obj)) {
    const v = getAnim(obj, f)!;
    const k = v.keys.find((kk) => kk.frame === frameAt(v, t));
    if (!k || !k.value.every(Number.isFinite)) continue;
    const base = v.relative ? baseValue(obj, f) : null;
    clip[f] = k.value.map((x, i) => r5(x + (base ? base[i] ?? 0 : 0)));
  }
  return Object.keys(clip).length ? clip : null;
}

/**
 * 把剪贴板粘到时刻 t：已开动画的字段在该帧打关键帧；没开的先以静态值开动画（时长不够就放长到能容下 t），
 * 再打关键帧。先在副本上做完、全部合法才写回（结构编辑不回滚）。
 */
export function pasteKeysAt(obj: SceneObject, clip: KeyClip, t: number): boolean {
  const fields = (Object.keys(clip) as AnimField[]).filter((f) => (ANIM_FIELDS as readonly string[]).includes(f));
  if (!fields.length || !Number.isFinite(t) || t < 0) return false;
  const tmp = {} as SceneObject;
  for (const f of fields) {
    const vals = clip[f]!;
    if (!Array.isArray(vals) || vals.length !== CHANNELS[f] || !vals.every(Number.isFinite)) return false;
    if (obj[f] !== undefined) tmp[f] = JSON.parse(JSON.stringify(obj[f]));
  }
  let changed = false;
  for (const f of fields) {
    if (!isAnimated(tmp, f)) {
      const frame = Math.round(t * DEFAULT_FPS);
      if (!enableAnim(tmp, f, baseValue(tmp, f), { length: Math.max(DEFAULT_LENGTH, frame) })) return false;
      changed = true;
    }
    const v = getAnim(tmp, f)!;
    if (setKey(tmp, f, frameAt(v, t), clip[f]!)) changed = true;
  }
  if (changed) for (const f of fields) obj[f] = tmp[f];
  return changed;
}
