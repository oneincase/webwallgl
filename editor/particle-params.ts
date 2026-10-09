// 粒子文件（particles/**.json）的分组参数模型（EDITOR-COMPLETION-PLAN §2 A3 / §3 M2）。
//
// 已建粒子层只能调 6 个倍率（editor/particles.ts 的 instanceoverride），打开既有壁纸的粒子文件
// 一个字段都改不动。这里把 WE 粒子系统的 emitter / initializer / operator / renderer /
// controlpoint 五族字段与顶层 maxcount / starttime / … 做成可读写，覆盖库内命中集。
//
// 三条硬规矩（与 editor/effects.ts 的内联参数同一范式）：
//   1. 只改值：就地改已解析的那份对象，绝不按白名单重建 —— 未知组件、未知键、没见过的字段
//      全部逐字节保留；键不存在时**不新增**（面板也只列文件里真有的字段）。
//   2. 按作者原名写回：键名**大小写不敏感**命中，命中后写回作者原本的拼写，不改名。
//   3. 值若是 `{ user|script|animation, value }` 包装，只改 `.value`，绑定原样保留。
//   4. 没改动（新值与原值数值相同）返回 false，调用方据此不重写文件、不入撤销栈。
//
// 字段表的口径 = **本仓引擎（render/particles.js）真正读的字段**。作者写进 JSON、而引擎
// 不读的字段（`cone`、`maxtoemitperperiod`、`colorrandom` 的 `exponent`、`collideplane` 的
// `distance`、`sign` 之外的 `axis`/`uvsmoothing` 等）不进字段表 —— 它们落到 extraKeys，
// 面板按「未识别键」只读列出并逐字节保留，不会给出一个动了也没用的滑条。
//
// 「引擎未生效」的诊断标注两处，都只标注不修：
//   * `turbulentvelocityrandom` 初始化器：render/particles.js 的初始化器 switch 里**没有
//     `case` 标签** —— 给 `this.init.turbulentVelocity` 赋值的那段代码落在上一个 case 的
//     `break` 之后，是不可达的死代码，所以它从来没生效过；而 renderer/vendor/we-scene/README.md
//     把它列为已支持。计划 §5 要求 M2 只做面板标注（修引擎会改变既有壁纸观感，另立一项）。
//   * `maintaindistancetocontrolpoint` 算子：引擎里没有对应分支（库内 1 处），按未知组件标注。
//
// 计划 §5 还说 `positionoffsetrandom` 初始化器（库内 1 处）低于 5% 门槛，只做被动透传、
// 不做专属面板 —— 故它不在这张表里，落到 `noPanel`（引擎认识但本版没有控件）。
//
// 语料风格：vecN 多为空格分隔字符串（"1 0 0"），少数是数组或单个数字；写回时按**原件形态**
// 回写，且数值没变时原样返回旧值，保证「没动过的地方逐字节不变」。

import type { EffectParam, EffectParamType, EffectValue } from "./effects";
import { isKnownComponent, type ParticleComponentKind } from "./particles";

export type ParticleGroup = ParticleComponentKind | "controlpoint";
export const PARTICLE_GROUP_NAMES: readonly ParticleGroup[] = ["emitter", "initializer", "operator", "renderer", "controlpoint"];

export type ParticleFieldType = "float" | "int" | "bool" | "vec2" | "vec3" | "enum" | "string";

export type ParticleField = {
  /** 作者 JSON 里的字段名（匹配时大小写不敏感） */
  key: string;
  type: ParticleFieldType;
  /** i18n 键（面板标签），缺省时调用方回落到字段名 */
  label?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: readonly string[];
  /**
   * 引擎侧硬范围：写超范围时**钳位**（只有 maxcount 1..20000 / starttime 0..30 这类
   * 引擎自己会钳的字段才标）。其余字段的 min/max 只喂滑条，不拦作者写的大值。
   */
  clamp?: boolean;
  default?: number | boolean | readonly number[];
};

export type ParticleComponentSpec = {
  kind: ParticleGroup;
  /** WE 组件名（JSON 的 name 字段），controlpoint 无名字用 "" */
  name: string;
  fields: readonly ParticleField[];
  /** 引擎声明支持但实际没有解析分支（只标注不修） */
  engineUnsupported?: boolean;
};

/** 面板上的诊断状态：ok = 可调；unsupported = 引擎未生效；noPanel = 引擎认但本版无控件；unknown = 引擎不认识 */
export type ParticleStatus = "ok" | "unsupported" | "noPanel" | "unknown";

// ---------- 字段表 ----------

const f = (key: string, type: ParticleFieldType, o: Partial<ParticleField> = {}): ParticleField => ({ key, type, ...o });
const int = (key: string, o: Partial<ParticleField> = {}) => f(key, "int", { min: 0, max: 1000, step: 1, default: 0, ...o });
const num = (key: string, o: Partial<ParticleField> = {}) => f(key, "float", { min: 0, max: 1000, step: 0.01, default: 0, ...o });
const vec3 = (key: string, o: Partial<ParticleField> = {}) => f(key, "vec3", { step: 0.01, default: [0, 0, 0], ...o });
const vec2 = (key: string, o: Partial<ParticleField> = {}) => f(key, "vec2", { step: 0.01, default: [0, 0], ...o });
const bool = (key: string, o: Partial<ParticleField> = {}) => f(key, "bool", { default: false, ...o });
const en = (key: string, options: readonly string[], o: Partial<ParticleField> = {}) => f(key, "enum", { options, ...o });

// 常用滑条范围（只影响面板手感，不拦作者的既有值）
const R_RATE = { min: 0, max: 5000, step: 0.1 };
const R_SPEED = { min: -6000, max: 6000, step: 0.1 };
const R_DIST = { min: -6000, max: 6000, step: 0.1 };
const R_LIFE = { min: 0, max: 600, step: 0.01 };
const R_SIZE = { min: 0, max: 2000, step: 0.01 };
const R_EXP = { min: 0, max: 10, step: 0.01 };
const R_TSCALE = { min: 0, max: 5, step: 0.01 };
const R_FREQ = { min: 0, max: 60, step: 0.01 };
const R_RATIO = { min: 0, max: 1, step: 0.01 };
const R_SCALE = { min: -10, max: 10, step: 0.01 };
const R_COLOR = { min: 0, max: 255, step: 1 };
const R_FLAGS = { min: 0, max: 255, step: 1 };
const R_ORIGIN = { min: -6000, max: 6000, step: 1 };
const R_ANGLE = { min: -360, max: 360, step: 0.1 };

/** 发射器的音频驱动组（render/particles.js 的 audio* 六个字段全读） */
const AUDIO_EMITTER_FIELDS: readonly ParticleField[] = [
  int("audioprocessingmode", { min: 0, max: 4 }),
  vec2("audioprocessingbounds", R_RATIO),
  num("audioprocessingexponent", R_EXP),
  num("audioprocessingfrequencystart", { min: 0, max: 32, step: 1 }),
  num("audioprocessingfrequencyend", { min: 0, max: 32, step: 1 }),
];

/** 只读「响度门控」两个字段的组件（vortex / turbulentvelocityrandom）：引擎只取 mode + bounds */
const AUDIO_GATE_FIELDS: readonly ParticleField[] = [
  int("audioprocessingmode", { min: 0, max: 4 }),
  vec2("audioprocessingbounds", R_RATIO),
];

const EMITTER_FIELDS: readonly ParticleField[] = [
  vec3("origin", R_ORIGIN),
  vec3("directions", { min: -1, max: 1, step: 0.01 }),
  vec3("distancemin", R_DIST),
  vec3("distancemax", R_DIST),
  num("rate", R_RATE),
  num("speedmin", R_SPEED),
  num("speedmax", R_SPEED),
  num("instantaneous", { min: 0, max: 1, step: 1 }),
  int("flags", R_FLAGS),
  num("delay", R_RATE),
  num("duration", R_LIFE),
  num("minperiodicdelay", R_RATE),
  num("maxperiodicdelay", R_RATE),
  num("minperiodicduration", R_RATE),
  num("maxperiodicduration", R_RATE),
  ...AUDIO_EMITTER_FIELDS,
];

export const CONTROLPOINT_SPEC: ParticleComponentSpec = {
  kind: "controlpoint",
  name: "",
  fields: [int("flags", R_FLAGS), vec3("offset", R_ORIGIN), vec3("angles", R_ANGLE), bool("locktopointer"), int("parentcontrolpoint")],
};

/** 命中集字段表：只登记引擎真读的字段（顶层 maxcount / starttime 等见 PARTICLE_TOP_FIELDS） */
export const PARTICLE_SPECS: readonly ParticleComponentSpec[] = [
  { kind: "emitter", name: "boxrandom", fields: EMITTER_FIELDS },
  {
    kind: "emitter",
    name: "sphererandom",
    fields: [...EMITTER_FIELDS, vec3("sign", { min: -1, max: 1, step: 0.01 }), int("controlpoint")],
  },
  {
    kind: "initializer",
    name: "lifetimerandom",
    fields: [num("min", R_LIFE), num("max", R_LIFE), num("exponent", R_EXP)],
  },
  {
    kind: "initializer",
    name: "sizerandom",
    fields: [num("min", R_SIZE), num("max", R_SIZE), num("exponent", R_EXP)],
  },
  // alpharandom / colorrandom / velocityrandom 引擎不读 exponent（作者的 exponent 落 extraKeys）
  { kind: "initializer", name: "alpharandom", fields: [num("min", R_RATIO), num("max", R_RATIO)] },
  { kind: "initializer", name: "colorrandom", fields: [vec3("min", R_COLOR), vec3("max", R_COLOR)] },
  { kind: "initializer", name: "velocityrandom", fields: [vec3("min", R_SPEED), vec3("max", R_SPEED)] },
  { kind: "initializer", name: "rotationrandom", fields: [vec3("min", R_ANGLE), vec3("max", R_ANGLE), num("exponent", R_EXP)] },
  { kind: "initializer", name: "angularvelocityrandom", fields: [vec3("min", R_ANGLE), vec3("max", R_ANGLE), num("exponent", R_EXP)] },
  {
    kind: "initializer",
    name: "mapsequencearoundcontrolpoint",
    fields: [int("count", { min: 1, max: 4096 }), vec2("bounds", R_RATIO), vec3("speedmin", R_SPEED), vec3("speedmax", R_SPEED), int("controlpoint")],
  },
  {
    kind: "initializer",
    name: "mapsequencebetweencontrolpoints",
    fields: [int("count", { min: 1, max: 4096 }), num("arcamount", R_RATIO), en("limitbehavior", ["", "repeat", "mirror"]), int("flags", R_FLAGS)],
  },
  {
    // 引擎未生效的初始化器：字段照登记（只读展示 + 诊断），标 engineUnsupported
    kind: "initializer",
    name: "turbulentvelocityrandom",
    engineUnsupported: true,
    fields: [
      num("scale", R_SCALE),
      num("offset"),
      num("speedmin", R_SPEED),
      num("speedmax", R_SPEED),
      num("phasemax", R_FREQ),
      num("timescale", R_TSCALE),
      ...AUDIO_GATE_FIELDS,
    ],
  },
  { kind: "operator", name: "movement", fields: [vec3("gravity", R_SPEED), num("drag", R_RATIO)] },
  { kind: "operator", name: "angularmovement", fields: [vec3("force", R_SPEED), num("drag", R_RATIO)] },
  { kind: "operator", name: "alphafade", fields: [num("fadeintime", R_RATIO), num("fadeouttime", R_RATIO)] },
  {
    kind: "operator",
    name: "alphachange",
    fields: [num("starttime", R_RATIO), num("endtime", R_RATIO), num("startvalue", R_RATIO), num("endvalue", R_RATIO)],
  },
  {
    kind: "operator",
    name: "colorchange",
    fields: [num("starttime", R_RATIO), num("endtime", R_RATIO), vec3("startvalue", R_COLOR), vec3("endvalue", R_COLOR)],
  },
  {
    kind: "operator",
    name: "sizechange",
    fields: [num("starttime", R_RATIO), num("endtime", R_RATIO), num("startvalue", R_SIZE), num("endvalue", R_SIZE)],
  },
  {
    kind: "operator",
    name: "turbulence",
    fields: [num("scale", R_SCALE), num("speedmin", R_SPEED), num("speedmax", R_SPEED), num("timescale", R_TSCALE), num("phasemin", R_FREQ), num("phasemax", R_FREQ), vec3("mask", R_RATIO)],
  },
  {
    kind: "operator",
    name: "oscillateposition",
    fields: [num("frequencymin", R_FREQ), num("frequencymax", R_FREQ), num("scalemin", R_SCALE), num("scalemax", R_SCALE), num("phasemin", R_FREQ), num("phasemax", R_FREQ), vec3("mask", R_RATIO)],
  },
  {
    // 三个 oscillate 共用引擎同一分支；blendin* / blendout* 引擎不读 → 落 extraKeys
    kind: "operator",
    name: "oscillatealpha",
    fields: [num("frequencymin", R_FREQ), num("frequencymax", R_FREQ), num("scalemin", R_SCALE), num("scalemax", R_SCALE), num("phasemin", R_FREQ), num("phasemax", R_FREQ)],
  },
  {
    kind: "operator",
    name: "oscillatesize",
    fields: [num("frequencymin", R_FREQ), num("frequencymax", R_FREQ), num("scalemin", R_SCALE), num("scalemax", R_SCALE), num("phasemin", R_FREQ), num("phasemax", R_FREQ)],
  },
  {
    kind: "operator",
    name: "controlpointattract",
    fields: [int("controlpoint"), vec3("origin", R_ORIGIN), num("scale", R_SCALE), num("threshold", R_DIST)],
  },
  {
    kind: "operator",
    name: "vortex",
    fields: [
      int("controlpoint"),
      num("distanceinner", R_DIST),
      num("distanceouter", R_DIST),
      num("speedinner", R_SPEED),
      num("speedouter", R_SPEED),
      vec3("axis", { min: -1, max: 1, step: 0.01 }),
      vec3("offset", R_ORIGIN),
      ...AUDIO_GATE_FIELDS,
    ],
  },
  {
    kind: "operator",
    name: "vortex_v2",
    fields: [
      int("controlpoint"),
      num("distanceinner", R_DIST),
      num("distanceouter", R_DIST),
      num("speedinner", R_SPEED),
      num("speedouter", R_SPEED),
      num("ringradius", R_DIST),
      num("ringpulldistance", R_DIST),
      num("ringwidth", R_DIST),
    ],
  },
  {
    kind: "operator",
    name: "remapvalue",
    fields: [
      en("output", ["", "velocity", "speed", "opacity"]),
      vec3("outputrangemin", R_SCALE),
      vec3("outputrangemax", R_SCALE),
      en("transformfunction", ["", "sine", "simplexnoise", "fbmnoise"]),
      num("transforminputscale", R_SCALE),
    ],
  },
  { kind: "operator", name: "capvelocity", fields: [num("maxspeed", R_SPEED), num("blendinstart", R_RATIO), num("blendinend", R_RATIO)] },
  { kind: "operator", name: "collisionplane", fields: [vec3("origin", R_ORIGIN), vec3("size", R_SIZE)] },
  { kind: "operator", name: "collisionquad", fields: [vec3("origin", R_ORIGIN), vec3("size", R_SIZE)] },
  {
    kind: "operator",
    name: "reducemovementnearcontrolpoint",
    fields: [int("controlpoint"), num("distanceinner", R_DIST), num("distanceouter", R_DIST), num("reductioninner", { min: 0, max: 1000, step: 1 })],
  },
  { kind: "operator", name: "maintaindistancebetweencontrolpoints", fields: [] },
  // 渲染器：引擎只读 length / maxlength / minlength / subdivision / segments / orientation
  { kind: "renderer", name: "sprite", fields: [en("orientation", ["", "screen", "upright", "fixed"])] },
  {
    kind: "renderer",
    name: "spritetrail",
    fields: [num("length", { min: 0, max: 1, step: 0.001 }), num("maxlength", R_SIZE), num("minlength", R_SIZE), en("orientation", ["", "screen", "upright", "fixed"])],
  },
  { kind: "renderer", name: "rope", fields: [int("subdivision", { min: 1, max: 64 })] },
  { kind: "renderer", name: "ropetrail", fields: [num("length", R_SIZE), int("subdivision", { min: 1, max: 64 }), int("segments", { min: 1, max: 64 })] },
  CONTROLPOINT_SPEC,
];

/** 顶层字段：粒子文件根上的那几个（全部命中集里出现过的） */
export const PARTICLE_TOP_FIELDS: readonly ParticleField[] = [
  { key: "maxcount", type: "int", min: 1, max: 20000, step: 1, clamp: true, label: "ptf.maxcount", default: 100 },
  { key: "starttime", type: "float", min: 0, max: 30, step: 0.1, clamp: true, label: "ptf.starttime", default: 0 },
  { key: "sequencemultiplier", type: "int", min: 1, max: 64, step: 1, label: "ptf.sequencemultiplier", default: 1 },
  { key: "animationmode", type: "enum", options: ["sequence", "randomframe"], label: "ptf.animationmode" },
  { key: "material", type: "string", label: "ptf.material" },
  { key: "flags", type: "int", min: 0, max: 255, step: 1, label: "ptf.flags", default: 0 },
];

/** 顶层键的前缀（面板键 = `particle.<字段>`） */
export const PARTICLE_TOP_PREFIX = "particle.";

const BY_KEY = new Map<string, ParticleField>(PARTICLE_TOP_FIELDS.map((x) => [x.key, x]));
const BY_SPEC = new Map<string, ParticleComponentSpec>(PARTICLE_SPECS.map((s) => [`${s.kind}:${s.name}`, s]));

export function particleSpec(kind: ParticleGroup, name: string): ParticleComponentSpec | null {
  if (kind === "controlpoint") return CONTROLPOINT_SPEC;
  return BY_SPEC.get(`${kind}:${String(name).toLowerCase()}`) ?? null;
}

// ---------- 基础工具 ----------

export type ParticleBox = Record<string, unknown>;

const isObj = (v: unknown): v is ParticleBox => !!v && typeof v === "object" && !Array.isArray(v);
const isBinding = (v: unknown) => isObj(v) && ("user" in v || "script" in v || "animation" in v);
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** 键名大小写不敏感命中，返回**作者原本的拼写**（没有就 null） */
export function realKeyOf(box: ParticleBox, key: string): string | null {
  const want = key.toLowerCase();
  for (const k of Object.keys(box)) if (k.toLowerCase() === want) return k;
  return null;
}

/** 读出当前值（`{user,value}` 包装解开，只读展示用） */
function rawOf(box: ParticleBox, field: ParticleField): unknown {
  const k = realKeyOf(box, field.key);
  if (!k) return undefined;
  const v = box[k];
  if (isObj(v)) return "value" in v ? v.value : undefined;
  return v;
}

/** "1 0 0" / [1,0,0] / 1 → 数字数组（读不出返回空数组） */
export function parseVec(v: unknown): number[] {
  if (Array.isArray(v)) return v.map(Number);
  if (typeof v === "number") return Number.isFinite(v) ? [v] : [];
  if (typeof v === "string") return v.trim().split(/\s+/).filter(Boolean).map(Number);
  return [];
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const fmt = (x: number) => String(r3(x));
const REJECT = Symbol("reject");

/** 写一个字段：只改已有键（不新增）、包装只改 .value、没变返回 false */
function writeField(box: ParticleBox, field: ParticleField, value: unknown): boolean {
  const real = realKeyOf(box, field.key);
  if (!real) return false;
  const cur = box[real];
  if (isObj(cur) && ("value" in cur || isBinding(cur))) {
    if (sameJson(cur.value, value)) return false;
    cur.value = value;
    return true;
  }
  if (sameJson(cur, value)) return false;
  box[real] = value;
  return true;
}

/**
 * 值编码：按字段类型与**原件形态**。返回 REJECT = 不合法（调用方不动文档）。
 * 数值与原值相同时原样返回旧值 —— 「没动过就提交」不产生任何字节变化。
 */
function encodeField(field: ParticleField, value: unknown, raw: unknown): unknown | typeof REJECT {
  switch (field.type) {
    case "float":
    case "int": {
      const n = Number(value);
      if (!Number.isFinite(n)) return REJECT;
      let v = field.type === "int" ? Math.round(n) : r3(n);
      if (field.clamp) {
        if (field.min !== undefined) v = Math.max(field.min, v);
        if (field.max !== undefined) v = Math.min(field.max, v);
      }
      if (typeof raw === "number" && raw === v) return raw;
      return v;
    }
    case "bool": {
      const truthy = typeof value === "boolean" ? value : Number(value) !== 0;
      return typeof raw === "number" ? (truthy ? 1 : 0) : truthy;
    }
    case "enum":
    case "string": {
      const s = String(value);
      if (field.type === "enum" && field.options && !field.options.includes(s)) return REJECT;
      return s;
    }
    case "vec2":
    case "vec3": {
      const n = field.type === "vec2" ? 2 : 3;
      const arr = parseVec(value);
      if (arr.length < n || arr.slice(0, n).some((x) => !Number.isFinite(x))) return REJECT;
      const use = arr.slice(0, n).map(r3);
      const old = parseVec(raw);
      // 数值没变 → 原样返回旧值（不规范化作者的写法）
      if (old.length >= n && Array.from({ length: n }, (_, i) => r3(old[i])).every((x, i) => x === use[i])) return raw;
      if (typeof raw === "number") return use[0];
      if (Array.isArray(raw)) return use;
      return use.map(fmt).join(" ");
    }
  }
}

// ---------- 文件视图 ----------

export type ParticleComponentRef = {
  group: ParticleGroup;
  /** 顶层数组下标 */
  index: number;
  /** 作者写的组件名（原样，controlpoint 为 ""） */
  name: string;
  /** 顶层键的作者拼写（emitter / Emitter…） */
  groupKey: string;
  spec: ParticleComponentSpec | null;
  status: ParticleStatus;
};

export type ParticleFieldView = {
  /** 面板键：`<group>[<index>].<字段>` 或 `particle.<字段>` */
  key: string;
  group: ParticleGroup | null;
  index: number;
  component: string;
  /** 组件状态（顶层字段恒为 ok） */
  status: ParticleStatus;
  field: ParticleField;
  /** 当前值（`{user,value}` 已解开） */
  raw: unknown;
};

export type ParticleComponentView = ParticleComponentRef & {
  /** 该组件里字段表没声明的键（只读列出，逐字节保留） */
  extraKeys: string[];
  /** 可编辑字段（只列文件里真有的键） */
  views: ParticleFieldView[];
};

function componentBox(file: ParticleBox, c: ParticleComponentRef): ParticleBox | null {
  const arr = file[c.groupKey];
  const item = Array.isArray(arr) ? arr[c.index] : undefined;
  return isObj(item) ? item : null;
}

function statusOf(kind: ParticleGroup, name: string, spec: ParticleComponentSpec | null): ParticleStatus {
  if (spec?.engineUnsupported) return "unsupported";
  if (spec) return "ok";
  if (kind !== "controlpoint" && isKnownComponent(kind, name)) return "noPanel";
  return "unknown";
}

function viewsOf(box: ParticleBox, c: ParticleComponentRef, spec: ParticleComponentSpec | null): ParticleFieldView[] {
  const out: ParticleFieldView[] = [];
  if (!spec || spec.engineUnsupported) return out;
  for (const field of spec.fields) {
    if (!realKeyOf(box, field.key)) continue; // 只列文件里真有的字段（不新增键）
    out.push({ key: `${c.group}[${c.index}].${field.key}`, group: c.group, index: c.index, component: c.name, status: c.status, field, raw: rawOf(box, field) });
  }
  return out;
}

/** 文件里的全部组件（含未知组件：它们也要在面板上被点名并原样保留） */
export function particleComponents(file: ParticleBox): ParticleComponentRef[] {
  const out: ParticleComponentRef[] = [];
  for (const group of PARTICLE_GROUP_NAMES) {
    const groupKey = realKeyOf(file, group);
    if (!groupKey) continue;
    const arr = file[groupKey];
    if (!Array.isArray(arr)) continue;
    arr.forEach((item, index) => {
      if (!isObj(item)) return;
      const nk = group === "controlpoint" ? null : realKeyOf(item, "name");
      const name = nk && typeof item[nk] === "string" ? (item[nk] as string) : "";
      const spec = particleSpec(group, name);
      out.push({ group, index, name, groupKey, spec, status: statusOf(group, name, spec) });
    });
  }
  return out;
}

export function particleComponentViews(file: ParticleBox): ParticleComponentView[] {
  const out: ParticleComponentView[] = [];
  for (const c of particleComponents(file)) {
    const box = componentBox(file, c);
    if (!box) continue;
    const declared = new Set((c.spec?.fields ?? []).map((x) => x.key.toLowerCase()));
    const extraKeys = Object.keys(box).filter((k) => {
      const lower = k.toLowerCase();
      return lower !== "id" && lower !== "name" && !declared.has(lower);
    });
    out.push({ ...c, extraKeys, views: viewsOf(box, c, c.spec) });
  }
  return out;
}

/** 顶层字段视图（只列文件里真有的键） */
export function particleTopViews(file: ParticleBox): ParticleFieldView[] {
  const out: ParticleFieldView[] = [];
  for (const field of PARTICLE_TOP_FIELDS) {
    if (!realKeyOf(file, field.key)) continue;
    out.push({ key: `${PARTICLE_TOP_PREFIX}${field.key}`, group: null, index: -1, component: "", status: "ok", field, raw: rawOf(file, field) });
  }
  return out;
}

/** 顶层字段表没声明的键（只读列出） */
export function particleTopExtraKeys(file: ParticleBox): string[] {
  const declared = new Set(PARTICLE_TOP_FIELDS.map((x) => x.key.toLowerCase()));
  const groups = new Set(PARTICLE_GROUP_NAMES as readonly string[]);
  return Object.keys(file).filter((k) => {
    const lower = k.toLowerCase();
    return !declared.has(lower) && !groups.has(lower);
  });
}

/** 面板要渲染的全部可编辑字段（顶层 + 各组件的已知字段） */
export function particleFieldViews(file: ParticleBox): ParticleFieldView[] {
  return [...particleTopViews(file), ...particleComponentViews(file).flatMap((c) => c.views)];
}

export type ParticleIssue = {
  kind: Exclude<ParticleStatus, "ok">;
  group: ParticleGroup;
  index: number;
  name: string;
};

/** 诊断标注：未知组件 / 引擎未生效组件 / 引擎认识但本版无控件（全部只标注不改） */
export function particleIssues(file: ParticleBox): ParticleIssue[] {
  const out: ParticleIssue[] = [];
  for (const c of particleComponents(file)) {
    if (c.status === "ok") continue;
    out.push({ kind: c.status, group: c.group, index: c.index, name: c.name });
  }
  return out;
}

// ---------- 读写 ----------

type Resolved = { box: ParticleBox; field: ParticleField };

function resolveKey(file: ParticleBox, key: string): Resolved | null {
  if (key.startsWith(PARTICLE_TOP_PREFIX)) {
    const field = BY_KEY.get(key.slice(PARTICLE_TOP_PREFIX.length));
    return field ? { box: file, field } : null;
  }
  const m = /^([A-Za-z]+)\[(\d+)\]\.(.+)$/.exec(key);
  if (!m) return null;
  const group = PARTICLE_GROUP_NAMES.find((g) => g.toLowerCase() === m[1].toLowerCase());
  if (!group) return null;
  const index = Number(m[2]);
  const c = particleComponents(file).find((x) => x.group === group && x.index === index);
  if (!c || !c.spec || c.spec.engineUnsupported) return null;
  const want = m[3].toLowerCase();
  const field = c.spec.fields.find((x) => x.key.toLowerCase() === want);
  if (!field) return null;
  const box = componentBox(file, c);
  return box ? { box, field } : null;
}

/** 面板键 → 当前值（认不出的键返回 undefined） */
export function particleFieldValue(file: ParticleBox, key: string): unknown {
  const hit = resolveKey(file, key);
  return hit ? rawOf(hit.box, hit.field) : undefined;
}

/**
 * 写一个字段。就地改已解析的那份对象（引擎热更按引用看见同一份），
 * 返回是否真的改了 —— false = 认不出的键 / 值不合法 / 没变（调用方据此不重写文件）。
 */
export function setParticleField(file: ParticleBox, key: string, value: unknown): boolean {
  const hit = resolveKey(file, key);
  if (!hit) return false;
  const enc = encodeField(hit.field, value, rawOf(hit.box, hit.field));
  if (enc === REJECT) return false;
  return writeField(hit.box, hit.field, enc);
}

// ---------- 序列化 ----------

/** 解析粒子文件（非法 JSON / 不是对象 → null） */
export function parseParticleFile(text: string): ParticleBox | null {
  try {
    const v = JSON.parse(text) as unknown;
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

/** 序列化粒子文件（2 空格缩进，与 editor/particles.ts 生成的产物同形） */
export function serializeParticleFile(file: ParticleBox): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(file, null, 2));
}

// ---------- 表单模型（喂 editor/ui/schema-form.ts） ----------

/** 面板滑条范围：非硬范围字段按现值放宽，免得作者写的 360 被滑条卡在 1 */
export function particleFormRange(v: ParticleFieldView): { min: number; max: number } {
  const field = v.field;
  if (field.clamp) return { min: field.min ?? 0, max: field.max ?? 1 };
  const cur = Number(v.raw);
  const base = Number.isFinite(cur) ? cur : 0;
  const min = Math.min(field.min ?? 0, base);
  const max = Math.max(field.max ?? (field.type === "int" ? 100 : 1), base, min + 1);
  return { min, max };
}

/** 当前值 → schema-form 的形状（vecN 补足分量）；enum / string 用 particleTextValue */
export function particleFormValue(v: ParticleFieldView): EffectValue {
  if (v.field.type === "bool") return v.raw === true || (typeof v.raw === "number" && v.raw !== 0);
  if (v.field.type === "vec2" || v.field.type === "vec3") {
    const n = v.field.type === "vec2" ? 2 : 3;
    const arr = parseVec(v.raw);
    return Array.from({ length: n }, (_, i) => (Number.isFinite(arr[i]) ? arr[i] : 0));
  }
  const x = Number(v.raw);
  return Number.isFinite(x) ? x : 0;
}

/** enum / string 字段的当前文本（面板自己搓 select / text 控件用） */
export function particleTextValue(v: ParticleFieldView): string {
  if (typeof v.raw === "string") return v.raw;
  if (v.raw === undefined || v.raw === null) return "";
  return typeof v.raw === "boolean" || typeof v.raw === "number" ? String(v.raw) : JSON.stringify(v.raw);
}

/** 字段视图 → schema-form 的参数描述（enum / string 没有控件，返回 null 由面板自己搓） */
export function particleFormParam(v: ParticleFieldView): EffectParam | null {
  const t = v.field.type;
  if (t === "enum" || t === "string") return null;
  const r = particleFormRange(v);
  return {
    key: v.key,
    type: t as EffectParamType,
    default: particleFormValue(v),
    min: r.min,
    max: r.max,
    step: v.field.step ?? (t === "int" ? 1 : 0.01),
    label: v.field.label,
  };
}
