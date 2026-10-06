// 粒子层（EDITOR-PLAN P4）：新建（雪 / 雨 / 火花 / 光点模板）与检视器调参。
// 模板是本仓自己写的粒子定义，产物是松散工程的标准形态：
//   particles/editor/<slug>.json            粒子系统（emitter / initializer / operator / renderer）
//   materials/editor/particles/<slug>.json  { passes: [{ shader: "genericparticle", textures: ["particle/halo"] }] }
// 贴图只引用 WE 内置名（particle/halo），引擎按名字程序化生成，WE 安装目录里同名素材也在，
// 不拷任何素材文件。发射区按场景宽高写死在粒子文件里（每层一份，slug 判重）。
//
// 调参只改对象的 instanceoverride（倍率 + colorn），不碰粒子文件 —— 对外来壁纸的粒子层同样适用。
// 字段可能被 `{ user, value }` / `{ script, value }` 包装，写入时只改 value。

import { nextObjectId, rebuildTree, unwrap, type EditorDoc, type SceneObject } from "./doc";

export type ParticlePreset = "snow" | "rain" | "embers" | "bokeh";
export const PARTICLE_PRESETS: readonly ParticlePreset[] = ["snow", "rain", "embers", "bokeh"];

const f3 = (v: number) => (Math.round(v * 1000) / 1000).toFixed(3);
const vec3 = (a: number, b: number, c: number) => `${f3(a)} ${f3(b)} ${f3(c)}`;

type Op = Record<string, unknown> & { name: string };
type Template = {
  blending: "additive" | "translucent";
  maxcount: number;
  starttime: number;
  emitter: (W: number, H: number) => Op;
  initializer: Op[] | ((W: number, H: number) => Op[]);
  operator: Op[];
  renderer: Op;
};

// 粒子空间 y 朝上，原点 = 图层 origin（场景中心）
const TEMPLATES: Record<ParticlePreset, Template> = {
  snow: {
    blending: "translucent",
    maxcount: 500,
    starttime: 20,
    emitter: (W, H) => ({ name: "boxrandom", origin: vec3(0, H / 2 + 40, 0), distancemax: vec3(W / 2 + 80, 8, 0), rate: 20 }),
    initializer: [
      { name: "lifetimerandom", min: 12, max: 22 },
      { name: "sizerandom", min: 12, max: 40 },
      { name: "velocityrandom", min: "-30 -110 0", max: "15 -60 0" },
      { name: "colorrandom", min: "225 235 255", max: "255 255 255" },
      { name: "alpharandom", min: 0.6, max: 1 },
    ],
    operator: [
      { name: "movement", gravity: "0 0 0", drag: 0 },
      { name: "oscillateposition", mask: "1 0 0", frequencymin: 0.3, frequencymax: 0.9, scalemin: 8, scalemax: 24 },
      { name: "alphafade", fadeintime: 0.05, fadeouttime: 0.9 },
    ],
    renderer: { name: "sprite" },
  },
  rain: {
    blending: "translucent",
    maxcount: 400,
    starttime: 2,
    emitter: (W, H) => ({ name: "boxrandom", origin: vec3(120, H / 2 + 60, 0), distancemax: vec3(W / 2 + 120, 8, 0), rate: 250 }),
    // 寿命 = 落到底边的时间（快的 1900 / 慢的 1500 px/s），出了画面就不再占池
    initializer: (_W, H) => [
      { name: "lifetimerandom", min: Math.round(((H + 60) / 1900) * 1000) / 1000, max: Math.round(((H + 60) / 1500) * 1000) / 1000 },
      { name: "sizerandom", min: 4, max: 7 },
      { name: "velocityrandom", min: "-260 -1900 0", max: "-180 -1500 0" },
      { name: "colorrandom", min: "180 200 230", max: "220 230 255" },
      { name: "alpharandom", min: 0.45, max: 0.8 },
    ],
    operator: [
      { name: "movement", gravity: "0 0 0", drag: 0 },
      { name: "alphafade", fadeintime: 0.05, fadeouttime: 0.9 },
    ],
    // 拖尾长度 = 宽 × |v| × length，封顶 maxlength 倍宽
    renderer: { name: "spritetrail", length: 0.012, maxlength: 30 },
  },
  embers: {
    blending: "additive",
    maxcount: 240,
    starttime: 8,
    emitter: (W, H) => ({ name: "boxrandom", origin: vec3(0, -H / 2 - 20, 0), distancemax: vec3(W / 2, 10, 0), rate: 20 }),
    initializer: [
      { name: "lifetimerandom", min: 5, max: 9 },
      { name: "sizerandom", min: 14, max: 36 },
      { name: "velocityrandom", min: "-40 90 0", max: "40 220 0" },
      { name: "colorrandom", min: "255 110 20", max: "255 210 90" },
      { name: "alpharandom", min: 0.7, max: 1 },
    ],
    operator: [
      { name: "movement", gravity: "0 15 0", drag: 0.1 },
      { name: "turbulence", scale: 0.004, speedmin: 30, speedmax: 90, timescale: 0.5, mask: "1 0.3 0" },
      { name: "oscillatealpha", frequencymin: 3, frequencymax: 8, scalemin: 0.4, scalemax: 1 },
      { name: "alphafade", fadeintime: 0.05, fadeouttime: 0.6 },
    ],
    renderer: { name: "sprite" },
  },
  bokeh: {
    blending: "additive",
    maxcount: 60,
    starttime: 20,
    emitter: (W, H) => ({ name: "boxrandom", origin: "0.000 0.000 0.000", distancemax: vec3(W / 2, H / 2, 0), rate: 4 }),
    initializer: [
      { name: "lifetimerandom", min: 8, max: 14 },
      { name: "sizerandom", min: 120, max: 360 },
      { name: "velocityrandom", min: "-12 -8 0", max: "12 12 0" },
      { name: "colorrandom", min: "180 200 150", max: "255 235 255" },
      { name: "alpharandom", min: 0.25, max: 0.6 },
    ],
    operator: [
      { name: "movement", gravity: "0 0 0", drag: 0.2 },
      { name: "oscillatesize", frequencymin: 0.3, frequencymax: 0.8, scalemin: 0.85, scalemax: 1.15 },
      { name: "alphafade", fadeintime: 0.3, fadeouttime: 0.6 },
    ],
    renderer: { name: "sprite" },
  },
};

export const PARTICLE_TEXTURE = "particle/halo";

export const particlePathOf = (slug: string) => `particles/editor/${slug}.json`;
export const particleMaterialOf = (slug: string) => `materials/editor/particles/${slug}.json`;

/** 粒子文件 slug：模板名，判重后加 -2、-3… */
export function particleSlug(preset: ParticlePreset, taken: (path: string) => boolean): string {
  if (!taken(particlePathOf(preset))) return preset;
  for (let i = 2; ; i++) if (!taken(particlePathOf(`${preset}-${i}`))) return `${preset}-${i}`;
}

/** 模板的粒子系统定义（W × H = 场景尺寸，决定发射区） */
export function particleSystemDef(preset: ParticlePreset, slug: string, W: number, H: number): Record<string, unknown> {
  const t = TEMPLATES[preset];
  let id = 1;
  const withId = (o: Op) => ({ id: id++, ...o });
  return {
    emitter: [withId(t.emitter(W, H))],
    flags: 0,
    initializer: (typeof t.initializer === "function" ? t.initializer(W, H) : t.initializer).map(withId),
    material: particleMaterialOf(slug),
    maxcount: t.maxcount,
    operator: t.operator.map(withId),
    renderer: [withId(t.renderer)],
    starttime: t.starttime,
  };
}

export function particleMaterialDef(preset: ParticlePreset): Record<string, unknown> {
  return {
    passes: [
      {
        blending: TEMPLATES[preset].blending,
        cullmode: "nocull",
        depthtest: "disabled",
        depthwrite: "disabled",
        shader: "genericparticle",
        textures: [PARTICLE_TEXTURE],
      },
    ],
  };
}

function sceneSize(doc: EditorDoc): [number, number] {
  const ortho = (doc.scene?.general as Record<string, unknown> | undefined)?.orthogonalprojection as
    | Record<string, unknown>
    | undefined;
  return [Number(ortho?.width) || 1920, Number(ortho?.height) || 1080];
}

/** 一个粒子层需要的两个文件（粒子系统 / 材质） */
export function particleLayerFiles(doc: EditorDoc, preset: ParticlePreset, slug: string): Array<{ name: string; data: Uint8Array }> {
  const enc = new TextEncoder();
  const [W, H] = sceneSize(doc);
  return [
    { name: particlePathOf(slug), data: enc.encode(JSON.stringify(particleSystemDef(preset, slug, W, H), null, 2)) },
    { name: particleMaterialOf(slug), data: enc.encode(JSON.stringify(particleMaterialDef(preset), null, 2)) },
  ];
}

/** 新粒子层追加到对象数组末尾（绘制在最上），放在场景中心。返回新 id */
export function addParticleLayer(doc: EditorDoc, preset: ParticlePreset, name: string, slug: string): number | null {
  const scene = doc.scene;
  if (!scene || !PARTICLE_PRESETS.includes(preset)) return null;
  if (!Array.isArray(scene.objects)) scene.objects = [];
  const objs = scene.objects as SceneObject[];
  const [W, H] = sceneSize(doc);
  const id = nextObjectId(objs);
  objs.push({
    angles: "0.000 0.000 0.000",
    id,
    instanceoverride: { alpha: 1, count: 1, lifetime: 1, rate: 1, size: 1, speed: 1 },
    name,
    origin: vec3(W / 2, H / 2, 0),
    particle: particlePathOf(slug),
    scale: "1.000 1.000 1.000",
    visible: true,
  });
  rebuildTree(doc);
  return id;
}

export const isParticleObject = (o: SceneObject) => typeof o.particle === "string";

/** 文档对象当前引用的粒子文件（资源表据此决定新增文件是否进保存清单） */
export function referencedParticles(doc: EditorDoc | null): Set<string> {
  const out = new Set<string>();
  const objs = doc?.scene?.objects;
  if (!Array.isArray(objs)) return out;
  for (const o of objs as SceneObject[]) if (o && isParticleObject(o)) out.add(o.particle as string);
  return out;
}

// ---------- 检视器：instanceoverride 读写 ----------

export type ParticleParam = "count" | "rate" | "speed" | "size" | "alpha" | "lifetime";
export const PARTICLE_PARAMS: readonly ParticleParam[] = ["count", "speed", "size", "rate", "lifetime", "alpha"];

/**
 * 取值范围。size / speed / lifetime 引擎按 `Number(v) || 1` 读，写 0 会变回 1，
 * 下限只能取正数；count 0 = 不发射、rate 0 = 定格、alpha 0 = 隐形，都是有意义的值。
 */
export const PARTICLE_RANGES: Record<ParticleParam, { min: number; max: number; step: number }> = {
  count: { min: 0, max: 5, step: 0.05 },
  speed: { min: 0.05, max: 5, step: 0.05 },
  size: { min: 0.05, max: 5, step: 0.05 },
  rate: { min: 0, max: 5, step: 0.05 },
  lifetime: { min: 0.05, max: 5, step: 0.05 },
  alpha: { min: 0, max: 1, step: 0.01 },
};

export type ParticleParams = Record<ParticleParam, number> & {
  /** 颜色覆盖（0..1）；null = 用粒子文件自己的颜色 */
  color: [number, number, number] | null;
};

type Wrapped = Record<string, unknown> & { value?: unknown };
const isWrapped = (v: unknown): v is Wrapped => !!v && typeof v === "object" && !Array.isArray(v);
const isBinding = (v: unknown) => isWrapped(v) && ("user" in v || "script" in v || "animation" in v);

function overrides(obj: SceneObject): Record<string, unknown> | null {
  const ov = obj.instanceoverride;
  return ov && typeof ov === "object" && !Array.isArray(ov) ? (ov as Record<string, unknown>) : null;
}

function parseRgb(v: unknown, scale: number): [number, number, number] | null {
  const p = typeof v === "string" ? v.trim().split(/\s+/).map(Number) : Array.isArray(v) ? v.map(Number) : [];
  if (p.length < 3 || p.slice(0, 3).some((x) => !Number.isFinite(x))) return null;
  return [p[0] / scale, p[1] / scale, p[2] / scale];
}

export function getParticleParams(obj: SceneObject): ParticleParams {
  const ov = overrides(obj) ?? {};
  const out = { color: null } as ParticleParams;
  for (const k of PARTICLE_PARAMS) {
    const n = Number(unwrap(ov[k]));
    out[k] = Number.isFinite(n) ? n : 1;
  }
  out.color = parseRgb(unwrap(ov.colorn), 1) ?? parseRgb(unwrap(ov.color), 255);
  return out;
}

function writeOverride(obj: SceneObject, key: string, v: unknown): boolean {
  let ov = overrides(obj);
  if (!ov) ov = obj.instanceoverride = {};
  const cur = ov[key];
  if (isWrapped(cur) && ("value" in cur || isBinding(cur))) {
    if (cur.value === v) return false;
    cur.value = v;
    return true;
  }
  if (cur === v) return false;
  ov[key] = v;
  return true;
}

/** 写一个倍率；不是粒子层 / 越界 / 没变返回 false */
export function setParticleParam(obj: SceneObject, key: ParticleParam, value: number): boolean {
  if (!isParticleObject(obj) || !PARTICLE_PARAMS.includes(key)) return false;
  const r = PARTICLE_RANGES[key];
  const n = Number(value);
  if (!Number.isFinite(n) || n < r.min || n > r.max) return false;
  return writeOverride(obj, key, Math.round(n * 1000) / 1000);
}

/**
 * 写颜色覆盖（colorn，0..1）；null = 去掉覆盖。旧式 color（0..255）与 colorn 同时在时
 * 引擎按键序后写的生效，故写 colorn 时一并去掉裸 color。绑定了用户属性 / 脚本的颜色不能去掉。
 */
export function setParticleColor(obj: SceneObject, rgb: readonly [number, number, number] | null): boolean {
  if (!isParticleObject(obj)) return false;
  const ov = overrides(obj);
  if (rgb === null) {
    if (!ov) return false;
    if (isBinding(ov.colorn) || isBinding(ov.color)) return false;
    const had = "colorn" in ov || "color" in ov;
    delete ov.colorn;
    delete ov.color;
    return had;
  }
  if (rgb.length < 3 || rgb.slice(0, 3).some((x) => !Number.isFinite(Number(x)))) return false;
  if (ov && isBinding(ov.color)) return false;
  const s = rgb
    .slice(0, 3)
    .map((x) => f3(Math.max(0, Math.min(1, Number(x)))))
    .join(" ");
  const hadColor = !!ov && "color" in ov;
  if (hadColor) delete ov!.color;
  return writeOverride(obj, "colorn", s) || hadColor;
}
