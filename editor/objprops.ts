// 对象属性直通层（M4 A5）：scene.json 对象上的**对象级字段**读写。
// 本文件是纯逻辑层（表单 DOM 在 main.ts 的 objPropsGroup 里），判据 scripts/verify-editor.mjs 的
// OBJ-PASSTHRU 段直接单测这里的函数。
//
// 三条铁律（与 editor/effects.ts 的 setInlineParam / constantKeyOf 同一条口径）：
//   1. **键名大小写不敏感命中原名写回**：文档里写 `CaseShadow` 就往 `CaseShadow` 写，
//      绝不新增一个 `castshadow` 变成两份（WE 的字段匹配本身大小写不敏感）。
//   2. **只碰自己管的那一个键**：同一对象上的未知键、别的字段、`effects` / `children`
//      这类结构键原样保留；字段本来没有时，写回用规范小写键（这是编辑器唯一允许新增的键集）。
//   3. **`{user|script|animation, value}` 包装只改 `.value`**：作者的脚本 / 关键帧曲线不动。
//
// 十六个字段按「引擎本版本是否真的读它」分两档，UI 上如实标注（见 OBJ_FIELDS 的 engine 字段）：
//   · read     —— renderer/vendor/we-scene 里有对象级读取（parse.js / hittest.js / renderer.js）；
//   · unread   —— 引擎本版本对它零命中，编辑器只做**原样保存**（不猜类型、不改形态），
//                 免得以后被当成「编辑器把它吃了」反复排查。
//
// 类型只对 read 档下断言；unread 档一律 `raw`（JSON 文本框，原样进原样出）。

import type { SceneObject } from "./doc";

export type ObjFieldType = "bool" | "number" | "int" | "vec2" | "enum" | "json" | "raw";

export type ObjFieldSpec = {
  /** scene.json 上的规范键名（小写） */
  key: string;
  type: ObjFieldType;
  /** read = 引擎本版本真的读该对象级字段；unread = 只透传保存 */
  engine: "read" | "unread";
  /** 引擎只在某些种类上读它（文案要说清；不影响读写能力） */
  only?: "text" | "group";
  /** enum 的可选值（与引擎里的枚举表同口径） */
  options?: readonly string[];
  min?: number;
  max?: number;
  step?: number;
};

/** ALIGN（renderer/vendor/we-scene/render/renderer-glsl.js）：图片 / 文字的盒子锚点枚举 */
export const ALIGN_VALUES = [
  "center",
  "centre",
  "left",
  "right",
  "top",
  "bottom",
  "topleft",
  "topright",
  "bottomleft",
  "bottomright",
] as const;

/** 文字层 anchor 多一个 "none"（parse.js：`o.anchor === 'none' ? 'none' : … : 'center'`） */
export const ANCHOR_VALUES = ["none", ...ALIGN_VALUES] as const;

export const OBJ_FIELDS: readonly ObjFieldSpec[] = [
  // ---- 引擎本版本真的读 ----
  { key: "castshadow", type: "bool", engine: "read", only: "text" },
  { key: "disablepropagation", type: "bool", engine: "read", only: "group" },
  { key: "parallaxDepth", type: "vec2", engine: "read", only: "group" },
  { key: "solid", type: "bool", engine: "read" },
  { key: "anchor", type: "enum", engine: "read", only: "text", options: ANCHOR_VALUES },
  { key: "colorBlendMode", type: "int", engine: "read", min: 0, max: 31, step: 1 },
  { key: "alignment", type: "enum", engine: "read", options: ALIGN_VALUES },
  { key: "perspective", type: "bool", engine: "read" },
  { key: "instanceoverride", type: "json", engine: "read" },
  { key: "copybackground", type: "bool", engine: "read" },
  { key: "backgroundbrightness", type: "number", engine: "read", only: "text", min: 0, step: 0.05 },
  { key: "spacing", type: "vec2", engine: "read", only: "text" },
  // ---- 引擎本版本零命中：原样透传（不猜类型） ----
  { key: "depthtest", type: "raw", engine: "unread" },
  { key: "clampuvs", type: "raw", engine: "unread" },
  { key: "blockalign", type: "raw", engine: "unread" },
  { key: "ledsource", type: "raw", engine: "unread" },
];

export const OBJ_FIELD_KEYS: readonly string[] = OBJ_FIELDS.map((f) => f.key);

export const objFieldOf = (key: string): ObjFieldSpec | undefined =>
  OBJ_FIELDS.find((f) => f.key.toLowerCase() === key.toLowerCase());

/** i18n 键：字段语义说明（zh / en 各一条，键恰好出现两次由 verify-editor 守） */
export const objFieldNoteKey = (key: string): string => `objp.n.${key.toLowerCase()}`;

/** `{user|script|animation, value}` 包装（受用户属性 / 脚本 / 曲线驱动的字段） */
export function isObjWrapper(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v) && "value" in (v as object);
}

/** 包装取快照值；裸值原样返回 */
export function objFieldRaw(v: unknown): unknown {
  return isObjWrapper(v) ? v.value : v;
}

/**
 * 大小写不敏感找对象上该字段的**真实键名**；对象上没有这个字段时返回 null。
 * 只做全等比较（不模糊匹配），所以 `parallaxDepth` 不会命中 `parallaxDepthOwn`。
 */
export function fieldKeyOf(obj: SceneObject | null | undefined, key: string): string | null {
  if (!obj) return null;
  const want = key.toLowerCase();
  for (const k of Object.keys(obj)) if (k.toLowerCase() === want) return k;
  return null;
}

/** 对象上已有的、属于本层的字段名（保留原名大小写）与「一个都没有」的清单 */
export function presentFieldKeys(obj: SceneObject | null | undefined): string[] {
  const out: string[] = [];
  for (const f of OBJ_FIELDS) {
    const k = fieldKeyOf(obj, f.key);
    if (k) out.push(k);
  }
  return out;
}

const round5 = (n: number) => Math.round(n * 1e5) / 1e5;

const toNum = (v: unknown): number | null => {
  const raw = objFieldRaw(v);
  if (typeof v === "boolean") return v ? 1 : 0;
  if (raw === undefined || raw === null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

/** parse.js 的 parseVec2 同口径：字符串 "x y" / 单数字 / {value} 包装；数组按 [x, y] 兼容读 */
export function parseObjVec2(v: unknown): [number, number] {
  const raw = objFieldRaw(v);
  if (Array.isArray(raw)) {
    const a = raw.map(Number);
    return [Number.isFinite(a[0]) ? a[0] : 0, Number.isFinite(a[1]) ? a[1] : 0];
  }
  const p = String(raw ?? "")
    .trim()
    .split(/\s+/)
    .map(Number);
  if (p.length === 1) return [p[0] || 0, p[0] || 0];
  return [p[0] || 0, p[1] || 0];
}

export function objFieldTruthy(v: unknown): boolean {
  const raw = objFieldRaw(v);
  if (raw === undefined || raw === null) return false;
  if (typeof raw === "string") {
    const s = raw.trim().toLowerCase();
    return s !== "" && s !== "0" && s !== "false";
  }
  return !!raw;
}

/** 对象 → 控件值：bool / number / [x, y] / enum 字符串 / 表或裸值（json / raw） */
export function decodeObjField(spec: ObjFieldSpec, v: unknown): unknown {
  switch (spec.type) {
    case "bool":
      return objFieldTruthy(v);
    case "number":
    case "int": {
      const n = toNum(v);
      return n === null ? null : spec.type === "int" ? Math.round(n) : round5(n);
    }
    case "vec2":
      return parseObjVec2(v);
    case "enum":
      return typeof objFieldRaw(v) === "string" ? objFieldRaw(v) : "";
    default:
      return objFieldRaw(v);
  }
}

/** 控件值 → 存储值。vec2 一律写成 "x y" 字符串：parse.js 的 parseVec2 只认这个形态
 *  （数组会被 `String([1,2])` 拆成 "1,2" → Number 得 NaN → 读成 [0, 0]）。 */
export function encodeObjField(spec: ObjFieldSpec, input: unknown): unknown {
  switch (spec.type) {
    case "bool":
      return !!input;
    case "number":
    case "int": {
      const n = Number(input);
      if (!Number.isFinite(n)) return null;
      return spec.type === "int" ? Math.round(n) : round5(n);
    }
    case "vec2": {
      const [x, y] = Array.isArray(input) ? parseObjVec2(input) : parseObjVec2(input);
      return `${round5(x)} ${round5(y)}`;
    }
    case "enum":
      return String(input ?? "");
    default:
      return input;
  }
}

const sameValue = (a: unknown, b: unknown): boolean =>
  a === b || (typeof a === "object" && typeof b === "object" && JSON.stringify(a) === JSON.stringify(b));

/**
 * instanceoverride 这类**表**字段的合并写回：逐个键写进已有表的同名键（大小写不敏感），
 * 已有键若是 `{script|animation, value}` 包装就只改 `.value`（脚本 / 曲线不动）；
 * 解析结果里没提到的键**不删**（作者的键与未知键原样保留）。
 */
export function mergeObjFieldTable(obj: SceneObject, key: string, table: Record<string, unknown>): boolean {
  const real = fieldKeyOf(obj, key);
  let target: Record<string, unknown>;
  if (real === null) {
    target = {};
    obj[key] = target;
  } else if (objFieldRaw(obj[real]) && typeof objFieldRaw(obj[real]) === "object" && !Array.isArray(objFieldRaw(obj[real]))) {
    target = objFieldRaw(obj[real]) as Record<string, unknown>;
  } else {
    target = {};
    obj[real] = target;
  }
  let changed = false;
  for (const [k, v] of Object.entries(table)) {
    const at = fieldKeyOf(target, k) ?? k;
    const cur = target[at];
    if (isObjWrapper(cur)) {
      if (!sameValue(cur.value, v)) {
        cur.value = v;
        changed = true;
      }
    } else if (!sameValue(cur, v)) {
      target[at] = v;
      changed = true;
    }
  }
  return changed;
}

/**
 * 写回一个字段（控件值 → 存储值）。
 * 返回是否真的改了内容（false = 没变化 / 字段不认识 / 值非法）。
 */
export function setObjField(obj: SceneObject, key: string, input: unknown): boolean {
  const spec = objFieldOf(key);
  if (!spec || !obj || typeof obj !== "object") return false;
  if (spec.type === "json" && input && typeof input === "object" && !Array.isArray(input)) {
    return mergeObjFieldTable(obj, spec.key, input as Record<string, unknown>);
  }
  const next = encodeObjField(spec, input);
  if (next === null) return false;
  const real = fieldKeyOf(obj, spec.key);
  if (real === null) {
    obj[spec.key] = next;
    return true;
  }
  const cur = obj[real];
  if (isObjWrapper(cur)) {
    if (sameValue(cur.value, next)) return false;
    cur.value = next;
    return true;
  }
  if (sameValue(cur, next)) return false;
  obj[real] = next;
  return true;
}

/** 按规范键读当前值（控件值）；字段不在对象上 → undefined（UI 显示为空） */
export function objFieldValue(obj: SceneObject | null | undefined, key: string): unknown {
  const spec = objFieldOf(key);
  if (!obj || !spec) return undefined;
  const real = fieldKeyOf(obj, spec.key);
  if (real === null) return undefined;
  return decodeObjField(spec, obj[real]);
}

/** 检视器一行需要的全部状态 */
export type ObjFieldState = {
  spec: ObjFieldSpec;
  /** 文档里有没有这个键（保留原名大小写） */
  key: string | null;
  /** 控件值；字段不在对象上时 undefined */
  value: unknown;
  /** 值带 `{script|user|animation, value}` 包装 */
  wrapped: boolean;
};

export function objFieldState(obj: SceneObject | null | undefined, spec: ObjFieldSpec): ObjFieldState {
  const key = fieldKeyOf(obj, spec.key);
  if (!obj || key === null) return { spec, key: null, value: undefined, wrapped: false };
  return { spec, key, value: decodeObjField(spec, obj[key]), wrapped: isObjWrapper(obj[key]) };
}

/** 检视器「对象属性」分组的全部行 */
export const objFieldStates = (obj: SceneObject | null | undefined): ObjFieldState[] =>
  OBJ_FIELDS.map((f) => objFieldState(obj, f));

/** 文本框（json / raw）提交：JSON.parse 后写回；坏 JSON 返回 false 让页面报错并回滚 */
export function setObjFieldText(obj: SceneObject, key: string, text: string): boolean {
  const spec = objFieldOf(key);
  if (!spec || (spec.type !== "json" && spec.type !== "raw")) return false;
  const t = text.trim();
  if (t === "") return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(t);
  } catch {
    return false;
  }
  return setObjField(obj, spec.key, parsed);
}
