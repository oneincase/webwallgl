// 极简参数描述 DSL：插件配置校验 + 检视器表单自动生成 + 效果 uniform 生成共用一份描述。
// 纯数据、零 DOM（表单渲染在 editor/ui/schema-form.ts）。

export type FieldType = "float" | "int" | "bool" | "color" | "vec2" | "vec3" | "vec4" | "enum" | "string" | "texture";

export type Field = {
  key: string;
  type: FieldType;
  default?: unknown;
  min?: number;
  max?: number;
  step?: number;
  /** enum 的可选值 */
  options?: ReadonlyArray<string | { value: string; label?: string }>;
  /** 界面文案（缺省用 key）；可给多语言表 { zh, en } */
  label?: string | Record<string, string>;
  description?: string | Record<string, string>;
  /** 效果参数：落在第几个 pass 的 constantshadervalues */
  pass?: number;
  hidden?: boolean;
};

export type Schema = readonly Field[];

const VEC_LEN: Partial<Record<FieldType, number>> = { vec2: 2, vec3: 3, vec4: 4, color: 3 };

export const vecLength = (t: FieldType) => VEC_LEN[t] ?? 0;

export function fieldDefault(f: Field): unknown {
  if (f.default !== undefined) return f.default;
  switch (f.type) {
    case "float":
    case "int":
      return f.min ?? 0;
    case "bool":
      return false;
    case "color":
      return [1, 1, 1];
    case "vec2":
      return [0, 0];
    case "vec3":
      return [0, 0, 0];
    case "vec4":
      return [0, 0, 0, 0];
    case "enum": {
      const o = f.options?.[0];
      return typeof o === "string" ? o : (o?.value ?? "");
    }
    default:
      return "";
  }
}

const clamp = (f: Field, n: number) => Math.max(f.min ?? -Infinity, Math.min(f.max ?? Infinity, n));

/** 把任意输入规整成字段合法值；无法规整时回落缺省 */
export function coerce(f: Field, v: unknown): unknown {
  const d = fieldDefault(f);
  switch (f.type) {
    case "float": {
      const n = typeof v === "number" ? v : Number(v);
      return Number.isFinite(n) ? clamp(f, n) : d;
    }
    case "int": {
      const n = typeof v === "number" ? v : Number(v);
      return Number.isFinite(n) ? Math.round(clamp(f, n)) : d;
    }
    case "bool":
      return v === true || v === 1 || v === "1" || v === "true" ? true : v === false || v === 0 || v === "0" || v === "false" ? false : d;
    case "color":
    case "vec2":
    case "vec3":
    case "vec4": {
      const n = vecLength(f.type);
      const parts = Array.isArray(v) ? v.map(Number) : typeof v === "string" ? v.trim().split(/\s+/).map(Number) : [];
      if (parts.length < n || parts.slice(0, n).some((x) => !Number.isFinite(x))) return d;
      const out = parts.slice(0, n);
      return f.type === "color" ? out.map((x) => Math.max(0, Math.min(1, x))) : out;
    }
    case "enum": {
      const vals = (f.options ?? []).map((o) => (typeof o === "string" ? o : o.value));
      return typeof v === "string" && vals.includes(v) ? v : d;
    }
    default:
      return typeof v === "string" ? v : d;
  }
}

export function defaults(schema: Schema): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of schema) out[f.key] = fieldDefault(f);
  return out;
}

/** 配置校验：未知键丢弃、缺的补缺省、非法值回落缺省。可直接当插件的 Config 用 */
export function resolveConfig(schema: Schema, raw: unknown): Record<string, unknown> {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const f of schema) out[f.key] = f.key in src ? coerce(f, src[f.key]) : fieldDefault(f);
  return out;
}

export const configOf = (schema: Schema) => (raw: unknown) => resolveConfig(schema, raw);

/** 语言码只比主语言：zh-CN / zh-Hans / zh_CN 都算 zh */
export const baseLang = (lang: string) => lang.split(/[-_]/)[0].toLowerCase();

/** 本地化取文案：{ zh, en } 表按语言取（插件清单常写 zh-CN，按主语言匹配），缺了回落 en / zh / 第一项 */
export function textOf(v: string | Record<string, string> | undefined, lang: string, fallback: string): string {
  if (!v) return fallback;
  if (typeof v === "string") return v;
  const pick = (l: string) => {
    if (v[l] !== undefined) return v[l];
    const k = Object.keys(v).find((x) => baseLang(x) === baseLang(l));
    return k === undefined ? undefined : v[k];
  };
  return pick(lang) ?? pick("en") ?? pick("zh") ?? Object.values(v)[0] ?? fallback;
}

const FIELD_TYPES: readonly FieldType[] = ["float", "int", "bool", "color", "vec2", "vec3", "vec4", "enum", "string", "texture"];

/** 外部数据插件里的 schema 是 JSON：逐项检查，坏的抛错（清单校验用） */
export function parseSchema(raw: unknown, where = "schema"): Field[] {
  if (!Array.isArray(raw)) throw new Error(`${where} 必须是数组`);
  return raw.map((x, i) => {
    if (!x || typeof x !== "object") throw new Error(`${where}[${i}] 不是对象`);
    const f = x as Field;
    if (typeof f.key !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(f.key)) throw new Error(`${where}[${i}].key 非法`);
    if (!FIELD_TYPES.includes(f.type)) throw new Error(`${where}[${i}].type 非法：${String(f.type)}`);
    return { ...f };
  });
}
