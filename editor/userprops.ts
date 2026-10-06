// 用户属性声明与绑定（EDITOR-PLAN W9 / §3A P4）。
// 声明住在 project.json 的 `general.properties`（WE 同形）；绑定是把图层字段包成
// `{ user, value }`（value = 快照），combo 切显隐用 `{ user: { name, condition }, value }`。
// 字段上已有脚本时与 `{ script, value }` 共存在同一个包装里。

import type { EditorDoc, SceneObject } from "./doc";

export type PropType = "slider" | "color" | "bool" | "combo" | "textinput";
export const PROP_TYPES: readonly PropType[] = ["slider", "color", "bool", "combo", "textinput"];

export type ComboOption = { label: string; value: string };

export type PropDecl = {
  type: PropType;
  text?: string;
  value: number | string | boolean;
  min?: number;
  max?: number;
  step?: number;
  options?: ComboOption[];
  order?: number;
};

export type PropView = PropDecl & { name: string };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

function table(doc: EditorDoc | null, create: boolean): Record<string, Obj> | null {
  if (!doc) return null;
  if (!doc.project) {
    if (!create) return null;
    doc.project = {};
  }
  let general = doc.project.general;
  if (!isObj(general)) {
    if (!create) return null;
    general = doc.project.general = {};
  }
  let props = (general as Obj).properties;
  if (!isObj(props)) {
    if (!create) return null;
    props = (general as Obj).properties = {};
  }
  return props as Record<string, Obj>;
}

/** 声明列表（按 order，再按名字） */
export function listProps(doc: EditorDoc | null): PropView[] {
  const t = table(doc, false);
  if (!t) return [];
  return Object.entries(t)
    .filter(([, p]) => isObj(p) && typeof p.type === "string")
    .map(([name, p]) => ({ name, ...(p as unknown as PropDecl) }))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));
}

export const propOf = (doc: EditorDoc | null, name: string): PropView | null => listProps(doc).find((p) => p.name === name) ?? null;

/** 属性名：WE 的属性键是标识符（脚本里 engine.userProperties.<名字>） */
export function isValidPropName(doc: EditorDoc | null, name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) && !propOf(doc, name);
}

export function defaultDecl(type: PropType, text: string): PropDecl {
  switch (type) {
    case "slider":
      return { type, text, value: 0.5, min: 0, max: 1, step: 0.01 };
    case "color":
      return { type, text, value: "1 1 1" };
    case "bool":
      return { type, text, value: true };
    case "combo":
      return { type, text, value: "0", options: [{ label: "A", value: "0" }, { label: "B", value: "1" }] };
    case "textinput":
      return { type, text, value: "" };
  }
}

export function declareProp(doc: EditorDoc, name: string, type: PropType, text = name): PropDecl | null {
  if (!isValidPropName(doc, name) || !PROP_TYPES.includes(type)) return null;
  const t = table(doc, true)!;
  const order = Math.max(0, ...listProps(doc).map((p) => p.order ?? 0)) + 1;
  const decl = { ...defaultDecl(type, text || name), order };
  t[name] = decl as unknown as Obj;
  return decl;
}

/** 按声明类型规整值（slider 夹到范围、color 写 "r g b"、combo 必须是某个选项） */
export function coerceValue(p: PropDecl, v: unknown): number | string | boolean | null {
  switch (p.type) {
    case "slider": {
      const n = Number(v);
      if (!Number.isFinite(n)) return null;
      const lo = p.min ?? -Infinity;
      const hi = p.max ?? Infinity;
      return Math.round(Math.min(hi, Math.max(lo, n)) * 1e5) / 1e5;
    }
    case "color": {
      const parts = Array.isArray(v) ? v.map(Number) : String(v ?? "").trim().split(/\s+/).map(Number);
      if (parts.length < 3 || !parts.slice(0, 3).every(Number.isFinite)) return null;
      return parts
        .slice(0, 3)
        .map((x) => String(Math.round(Math.min(1, Math.max(0, x)) * 1e5) / 1e5))
        .join(" ");
    }
    case "bool":
      return v === true || v === "true" || v === 1 || v === "1";
    case "combo": {
      const s = String(v);
      return (p.options ?? []).some((o) => String(o.value) === s) ? s : null;
    }
    case "textinput":
      return typeof v === "string" ? v : null;
  }
}

export function setPropValue(doc: EditorDoc, name: string, v: unknown): boolean {
  const t = table(doc, false);
  const p = t?.[name] as unknown as PropDecl | undefined;
  if (!p || !isObj(p)) return false;
  const c = coerceValue(p, v);
  if (c === null || c === p.value) return false;
  p.value = c;
  return true;
}

export function setPropText(doc: EditorDoc, name: string, text: string): boolean {
  const p = table(doc, false)?.[name];
  if (!p || p.text === text) return false;
  p.text = text;
  return true;
}

/** slider 范围；当前值随之夹回范围内 */
export function setSliderRange(doc: EditorDoc, name: string, min: number, max: number, step: number): boolean {
  const p = table(doc, false)?.[name] as unknown as PropDecl | undefined;
  if (!p || p.type !== "slider" || !(Number.isFinite(min) && Number.isFinite(max) && min < max) || !(step > 0)) return false;
  if (p.min === min && p.max === max && p.step === step) return false;
  Object.assign(p, { min, max, step });
  p.value = coerceValue(p, p.value) ?? min;
  return true;
}

/** combo 选项（每行 `值=标签` 或单个值）；当前值不在新选项里时取第一项 */
export function setComboOptions(doc: EditorDoc, name: string, options: ComboOption[]): boolean {
  const p = table(doc, false)?.[name] as unknown as PropDecl | undefined;
  const clean = options.filter((o) => o.value !== "").map((o) => ({ label: o.label || o.value, value: String(o.value) }));
  if (!p || p.type !== "combo" || !clean.length || new Set(clean.map((o) => o.value)).size !== clean.length) return false;
  if (JSON.stringify(p.options) === JSON.stringify(clean)) return false;
  p.options = clean;
  if (!clean.some((o) => o.value === String(p.value))) p.value = clean[0].value;
  return true;
}

export function parseComboOptions(text: string): ComboOption[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf("=");
      return i < 0 ? { value: l, label: l } : { value: l.slice(0, i).trim(), label: l.slice(i + 1).trim() };
    });
}

export const formatComboOptions = (options: ComboOption[] | undefined) =>
  (options ?? []).map((o) => (o.label && o.label !== o.value ? `${o.value}=${o.label}` : o.value)).join("\n");

/** 删除声明并解开所有绑到它的字段（字段回到快照值，脚本保留）；返回解开的绑定数 */
export function removeProp(doc: EditorDoc, name: string): number {
  const t = table(doc, false);
  if (!t || !(name in t)) return -1;
  delete t[name];
  let n = 0;
  const objs = Array.isArray(doc.scene?.objects) ? (doc.scene!.objects as SceneObject[]) : [];
  for (const o of objs) {
    for (const f of BINDABLE_FIELDS) {
      if (bindingOf(o, f.field)?.name === name && unbindProp(o, f.field)) n++;
    }
  }
  return n;
}

// ---------- 绑定 ----------

export type BindableField = { field: string; types: readonly PropType[]; kinds?: readonly string[] };

/** 可绑定字段与兼容的属性类型（与引擎 resolveUserValue 的形状放行一致） */
export const BINDABLE_FIELDS: readonly BindableField[] = [
  { field: "visible", types: ["bool", "slider", "combo"] },
  { field: "alpha", types: ["slider"] },
  { field: "brightness", types: ["slider"], kinds: ["image"] },
  { field: "scale", types: ["slider"] },
  { field: "color", types: ["color"], kinds: ["image", "text"] },
  { field: "text", types: ["textinput"], kinds: ["text"] },
];

export const bindableFor = (kind: string) => BINDABLE_FIELDS.filter((f) => !f.kinds || f.kinds.includes(kind));

export type Binding = { name: string; condition?: string };

export function bindingOf(obj: SceneObject, field: string): Binding | null {
  const v = (obj as Obj)[field];
  if (!isObj(v)) return null;
  if (typeof v.user === "string") return { name: v.user };
  if (isObj(v.user) && typeof v.user.name === "string") return { name: v.user.name, condition: String(v.user.condition ?? "") };
  return null;
}

const FIELD_DEFAULT: Record<string, unknown> = { visible: true, alpha: 1, brightness: 1, scale: "1.00000 1.00000 1.00000", color: "1.00000 1.00000 1.00000", text: "" };

/** 绑定字段到属性（combo 绑 visible 时给 condition）；类型不兼容拒绝 */
export function bindProp(doc: EditorDoc, obj: SceneObject, field: string, name: string, condition?: string): boolean {
  const p = propOf(doc, name);
  const f = BINDABLE_FIELDS.find((x) => x.field === field);
  if (!p || !f || !f.types.includes(p.type)) return false;
  if (p.type === "combo" && (field !== "visible" || condition === undefined || !(p.options ?? []).some((o) => o.value === condition))) return false;
  const user = p.type === "combo" ? { name, condition } : name;
  const cur = (obj as Obj)[field];
  if (isObj(cur) && ("value" in cur || "script" in cur || "user" in cur)) {
    if (JSON.stringify(cur.user) === JSON.stringify(user)) return false;
    cur.user = user;
    if (!("value" in cur)) cur.value = FIELD_DEFAULT[field];
  } else {
    (obj as Obj)[field] = { user, value: cur ?? FIELD_DEFAULT[field] };
  }
  return true;
}

/** 解绑：只剩快照时解包回裸值，字段上有脚本时保留包装 */
export function unbindProp(obj: SceneObject, field: string): boolean {
  const cur = (obj as Obj)[field];
  if (!isObj(cur) || !("user" in cur)) return false;
  delete cur.user;
  const rest = Object.keys(cur).filter((k) => k !== "value");
  (obj as Obj)[field] = rest.length ? cur : cur.value;
  if ((obj as Obj)[field] === undefined) delete (obj as Obj)[field];
  return true;
}