/**
 * text-script-props —— 文字对象 `text.scriptproperties` 的**纯数据层**（无 DOM、无渲染依赖）。
 *
 * 为什么单独一层：截图/几何/字段面板都已按「先拿到引擎读点，再给面板用」的写法分层
 * （objprops.ts / struct.ts / effects.ts），脚本属性面板（task-7 接进 main.ts 的文字检视器）
 * 需要同一份口径，但它要跑离线判据，所以数据与 UI 必须分开。
 *
 * 引擎读点（全部逐行读过 vendor 源码，引用的是**行号+读的什么**）：
 *   - `renderer/vendor/we-scene/scene/parse.js:493`
 *       `textScriptProps: o.text && typeof o.text === 'object' ? (o.text.scriptproperties || null) : null`
 *     → 属性表的键是 scene.json 里 `text.scriptproperties`，**全小写、区分大小写、无回退**。
 *   - `renderer/vendor/we-scene/scene/parse.js:490`
 *       `text: typeof o.text === 'string' ? o.text : (o.text && typeof o.text === 'object' ? o.text.value : null)`
 *     → 文字值有两种作者写法：裸字符串，或 `{ value }` 对象。把裸字符串升级成对象时
 *       必须把原字符串搬进 `.value`，否则文字内容被抹掉。
 *   - `renderer/vendor/we-scene/render/text.js:808-811` `propValue(v)`
 *       `if (v !== null && typeof v === 'object' && 'value' in v) return v.value; return v`
 *     → 引擎读值会容错 `{user,value}` / `{script,value}` 包装；带 `value` 才解包。
 *   - `renderer/vendor/we-scene/render/text.js:906-925` `defineLiveScriptProp(spValues,key,v,userProps)`
 *       `v` 带字符串 `user` 时注册**活 getter**（读 `userProps[user]`，兜底 `propValue(v)`，
 *       setter 存会话覆盖）；否则 `spValues[key] = propValue(v)`。
 *     → 面板改值只能改 `.value`（快照），改 `user` 就等于把用户的绑定拆了。
 *   - `renderer/vendor/we-scene/render/text.js:992-1001` builder Proxy 的 `get` 陷阱
 *       `ADD_METHOD_RE = /^add[A-Z]/`（text.js:38）；`if (!(def.name in spValues))` 才补声明默认
 *     → 命中是**严格大小写**的 `in`。所以面板必须大小写不敏感地命中原键；另起一个小写
 *       规范键会让脚本读不到，且声明默认值还会把作者已写的值盖掉。
 *       同处也说明：同名 `add*` 只认**第一次**声明的默认值（后面几次只做类型转换）。
 *   - `renderer/vendor/we-scene/render/text.js:814-833` `declaredDefault(methodName,def)`
 *       除 `addCombo` 外缺省值都取 `options.value`；`addCombo` 在没写 `value` 时取
 *       `options[0].value`（与官方 `local-assets/scripts/jsclasses/baseclasses.js:1443-1447` 一致）。
 *   - `local-assets/scripts/jsclasses/baseclasses.js:1423-1454` 官方 `createScriptProperties()`：
 *     只有 `addSlider` / `addCheckbox` / `addText` / `addCombo` / `addColor` 五个方法，
 *     每个都写 `vars[options.name] = options.value`（addCombo 写 `options.options[0].value`），
 *     `finish()` 返回 `vars`。所以「声明类型」只能从这五个方法名判定，别的一律 unknown。
 *
 * 铁律（与 editor/objprops.ts:1-28 同口径，四条全部由上面读点支撑）：
 *   ① 大小写不敏感命中原键，绝不新建小写重复键；
 *   ② 包装只改 `.value`，其它键（user/script/…）一个都不动；
 *   ③ 值没变返回 false（不产生空撤销步）；
 *   ④ 不删作者数据：删除只在键真的存在时返回 true。
 */

import type { SceneObject } from "./doc";

/** 面板控件类型。`combo` = 脚本用 `addCombo` 声明（选项见 `options`）；`unknown` = 脚本没声明或声明方法不在官方五个之内，面板该给自由文本/只读。 */
export type TextScriptPropKind = "number" | "bool" | "string" | "color" | "combo" | "unknown";

/**
 * `addCombo` 的一个选项。**source 顺序照抄**（engine text.js:826-830 用 `options[0].value` 当省略 value 时的默认值，
 * 顺序有语义）；`label` 是给人看的（baseclasses.js:1441/1454 `label:options.label`），脚本省略时**不造空串**。
 */
export interface TextScriptPropOption {
  label?: string;
  value: unknown;
}

/** 脚本 `createScriptProperties()` 声明链里的一条声明 */
export interface TextScriptPropDecl {
  /** 声明里的 `name`（严格按脚本写的原样） */
  name: string;
  /** 引擎 `add*` 方法名，原样保留（`^add[A-Z]`，text.js:38） */
  method: string;
  /** 由方法名映射的控件类型 */
  kind: TextScriptPropKind;
  /** 声明里带默认值（`value:`；addCombo 例外见 text.js:825-833） */
  hasDefault: boolean;
  /** 静态能取到的字面量默认值；取不到（表达式）时为 undefined，但 hasDefault 仍可为 true */
  defaultValue: unknown;
  /** 仅 `addCombo` 声明带：脚本写的 `options`（能静态解析出来的项，source 顺序）；一项都解析不出则省略 */
  options?: TextScriptPropOption[];
}

/** 面板一行：作者文件里**真实存在**的一条属性 */
export interface TextScriptPropRow {
  /** 作者文件里的**原始**键名（保留大小写） */
  key: string;
  /** 控件类型：脚本声明优先，否则按值推断 */
  kind: TextScriptPropKind;
  /** 引擎可见值（text.js:808 propValue → 包装取 `.value`） */
  value: unknown;
  /** `{user,value}` / `{script,value}` 包装：只能改 `.value` */
  wrapped: boolean;
  /** 脚本 `createScriptProperties()` 声明了这个键 */
  declared: boolean;
  /** 声明里带默认值（面板据此标「脚本有默认值」） */
  hasDefault: boolean;
  /**
   * **只在 declared 的行上**带：该键声明里的 `options`（source 顺序）。
   * 未声明键不带 —— 面板对未知键没有可信选项表，只能按值类型给控件。
   * 当前值不在 options 里时数据层**不做任何收敛**：`value` 原样保留，由面板自行显示（off-list 值往返不变）。
   */
  options?: TextScriptPropOption[];
}

/** scene.json 中文字属性表的键。engine: parse.js:493（小写字面量，无大小写回退） */
export const TEXT_SCRIPT_PROPS_KEY = "scriptproperties";

/**
 * 官方五个 add* 方法 → 控件类型。
 * engine: baseclasses.js:1423-1454 只有 addSlider/addCheckbox/addText/addCombo/addColor。
 * addCombo 是枚举 → `combo`（选项来自脚本 `options`，见 TextScriptPropOption）。
 */
const DECL_KINDS: Record<string, TextScriptPropKind> = {
  addSlider: "number",
  addCheckbox: "bool",
  addText: "string",
  addCombo: "combo",
  addColor: "color",
};

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/**
 * 引擎读值口径。engine: text.js:808-811 `propValue`（逐字同构）。
 * 注意引擎不排除数组，但数组没有 `value` 键，结果一致。
 */
export function textScriptPropValue(raw: unknown): unknown {
  if (raw !== null && typeof raw === "object" && "value" in (raw as Record<string, unknown>)) {
    return (raw as { value: unknown }).value;
  }
  return raw;
}

/**
 * 是否「只能改 `.value`」的包装。比 `propValue` 宽一档：`{user}`（缺快照）/`{script}` 也算，
 * 因为面板写值时同样不能碰 user/script。口径与 editor/doc.ts:72 `isFieldWrapper` 一致。
 */
export function isTextScriptPropWrapper(v: unknown): v is Record<string, unknown> {
  if (!isPlainObject(v)) return false;
  return "value" in v || "user" in v || typeof v.script === "string";
}

/**
 * 属性表（引擎口径）。engine: parse.js:493 只认 `text.scriptproperties`。
 * 表不存在、`text` 不是对象、或表不是对象 → null。
 */
export function textScriptPropsTable(
  obj: SceneObject | null | undefined,
): Record<string, unknown> | null {
  if (!obj) return null;
  const text = obj.text;
  if (!isPlainObject(text)) return null;
  const props = text[TEXT_SCRIPT_PROPS_KEY];
  return isPlainObject(props) ? props : null;
}

/**
 * 作者把表写成了别的拼写（`ScriptProperties` 等）时返回那个键名，否则 null。
 * 引擎严格按 parse.js:493 的小写字面读 —— 这种键引擎**读不到**。本函数只给面板提示用，
 * 本模块绝不往里写（写进去等于静默无效）。364 个本地 scene.pkg 抽样：1148/1148 都是小写。
 */
export function textScriptPropsVariantKey(
  obj: SceneObject | null | undefined,
): string | null {
  if (!obj) return null;
  const text = obj.text;
  if (!isPlainObject(text)) return null;
  for (const k of Object.keys(text)) {
    if (k !== TEXT_SCRIPT_PROPS_KEY && k.toLowerCase() === TEXT_SCRIPT_PROPS_KEY) {
      return isPlainObject(text[k]) || text[k] === null ? k : null;
    }
  }
  return null;
}

/**
 * 大小写不敏感找属性真实键名；没这个键返回 null。
 * 口径与 editor/objprops.ts:102 `fieldKeyOf` 一致：只做全等比较，不模糊匹配。
 * engine: text.js:994 的 `def.name in spValues` 是严格大小写，所以命中原键是硬要求。
 */
export function textScriptPropKeyOf(
  table: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  if (!table) return null;
  const want = key.toLowerCase();
  for (const k of Object.keys(table)) if (k.toLowerCase() === want) return k;
  return null;
}

/** 作者已写的键值（文档序），`value` 是**原始存储形态**（包装保留） */
export function listTextScriptProps(
  obj: SceneObject | null | undefined,
): Array<{ key: string; value: unknown }> {
  const table = textScriptPropsTable(obj);
  if (!table) return [];
  return Object.entries(table).map(([key, value]) => ({ key, value }));
}

/** 读一条属性的原始存储形态（包装保留）；不存在返回 undefined */
export function readTextScriptProp(
  obj: SceneObject | null | undefined,
  key: string,
): unknown {
  const table = textScriptPropsTable(obj);
  const real = textScriptPropKeyOf(table, key);
  return real === null ? undefined : (table as Record<string, unknown>)[real];
}

/**
 * 取/建属性表。**只由写路径调用**。
 * engine: ① parse.js:490 —— `text` 是裸字符串时先升级成 `{value:<原字符串>, …}`，
 * 否则文字内容被抹掉；② parse.js:493 —— 只在小写键上建表，绝不新建大小写变体。
 * `text` 既不是字符串也不是对象（含根本不存在）→ null，调用方据此拒绝写入
 * （凭空造 `text` 会把非文字对象变成文字对象：parse.js:496 `isText: o.text !== undefined`）。
 */
function ensurePropsTable(obj: SceneObject): Record<string, unknown> | null {
  const cur = obj.text;
  if (typeof cur === "string") {
    const next: Record<string, unknown> = { value: cur, [TEXT_SCRIPT_PROPS_KEY]: {} };
    obj.text = next;
    return next[TEXT_SCRIPT_PROPS_KEY] as Record<string, unknown>;
  }
  if (!isPlainObject(cur)) return null;
  const existing = cur[TEXT_SCRIPT_PROPS_KEY];
  if (isPlainObject(existing)) return existing;
  const table: Record<string, unknown> = {};
  cur[TEXT_SCRIPT_PROPS_KEY] = table;
  return table;
}

/** 深比较：数值/字符串/布尔/数组/对象都按值比（避免「没改」也记一步撤销） */
function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * 写一条属性，返回**是否真的改了**（规则③）。
 *   · 键已存在：大小写不敏感命中原键（规则①）；包装只改 `.value`（规则②），其它键不动；
 *   · 键不存在：在 `scriptproperties` 下按调用方给的键名新建（`addableTextScriptProps` 的消费路径）；
 *   · `text` 不能承载属性表（不存在 / 不是字符串也不是对象）→ 返回 false，不造字段；
 *   · 值没变 → 返回 false。
 */
export function setTextScriptProp(
  obj: SceneObject | null | undefined,
  key: string,
  raw: unknown,
): boolean {
  if (!obj || typeof key !== "string" || key === "") return false;
  // raw 是「引擎可见值」（面板控件里的那个值）；本身是包装时按 propValue 口径取 `.value`，
  // 保证 set(k, read(k)) 恒为 no-op —— 面板重复提交不会产生空撤销步。
  const next = isTextScriptPropWrapper(raw) ? textScriptPropValue(raw) : raw;
  const table = ensurePropsTable(obj);
  if (!table) return false;
  const real = textScriptPropKeyOf(table, key);
  if (real === null) {
    table[key] = next;
    return true;
  }
  const cur = table[real];
  if (isTextScriptPropWrapper(cur)) {
    if (Object.prototype.hasOwnProperty.call(cur, "value") && sameValue(cur.value, next)) return false;
    cur.value = next;
    return true;
  }
  if (sameValue(cur, next)) return false;
  table[real] = next;
  return true;
}

/**
 * 删一条属性，只有键真的存在才返回 true（规则④：不谎报、不制造撤销步）。
 * 只 `delete` 命中的原键，作者其它数据（包装、别的属性、`text` 其它字段）一律不动。
 * 空表保留：engine parse.js:493 `|| null` 下 `{}` 与 null 同效，留着不改变引擎行为。
 */
export function removeTextScriptProp(
  obj: SceneObject | null | undefined,
  key: string,
): boolean {
  const table = textScriptPropsTable(obj);
  const real = textScriptPropKeyOf(table, key);
  if (!table || real === null) return false;
  delete table[real];
  return true;
}

/** 按值推断控件类型（脚本没声明时用）。不猜颜色/枚举：字符串就是字符串。 */
function inferKind(raw: unknown): TextScriptPropKind {
  const v = textScriptPropValue(raw);
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "string") return "string";
  return "unknown";
}

// ─────────────── 脚本声明解析（createScriptProperties 链） ───────────────

/** 跳过注释与字符串字面量，返回 `i` 之后第一个非空白、非注释字符的下标 */
function skipTrivia(src: string, i: number): number {
  let p = i;
  for (;;) {
    const c = src[p];
    if (c === undefined) return p;
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      p++;
      continue;
    }
    if (c === "/" && src[p + 1] === "/") {
      const nl = src.indexOf("\n", p);
      p = nl < 0 ? src.length : nl + 1;
      continue;
    }
    if (c === "/" && src[p + 1] === "*") {
      const end = src.indexOf("*/", p + 2);
      p = end < 0 ? src.length : end + 2;
      continue;
    }
    return p;
  }
}

/**
 * 从 `{` 开始取平衡的对象字面量（跳过字符串/模板字面量/注释里的括号）。
 * 返回字面量原文与结束下标；不平衡返回 null（源码形状不认识就**不猜**）。
 */
function sliceBalanced(src: string, start: number): { body: string; end: number } | null {
  if (src[start] !== "{") return null;
  let depth = 0;
  let i = start;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < src.length) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === quote) break;
        i++;
      }
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      i = nl < 0 ? src.length : nl + 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return { body: src.slice(start, i + 1), end: i + 1 };
    }
    i++;
  }
  return null;
}

/**
 * 取对象字面量**顶层** `key:` 之后的**原始文本**（在顶层 `,` / `}` 处切），没有该属性返回 null。
 * 只做切片不判断是不是字面量：`value: 1 + 2` 这类表达式也要能被认出「写了 value」
 * （engine text.js:832 会读 `def.value`，只是静态求不出值 —— 那属于 parseLiteral 的事）。
 */
function topLevelValueText(body: string, prop: string): string | null {
  const inner = body.slice(1, -1);
  let depth = 0;
  let i = 0;
  while (i < inner.length) {
    const c = inner[i];
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < inner.length) {
        if (inner[i] === "\\") {
          i += 2;
          continue;
        }
        if (inner[i] === quote) break;
        i++;
      }
      i++;
      continue;
    }
    if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") depth--;
    else if (depth === 0 && inner.startsWith(prop, i)) {
      const before = i === 0 ? "," : inner[i - 1];
      if (/[,{\s]/.test(before)) {
        const colon = skipTrivia(inner, i + prop.length);
        if (inner[colon] === ":") {
          const v = readValueText(inner, skipTrivia(inner, colon + 1));
          if (v !== null) return v;
        }
      }
    }
    i++;
  }
  return null;
}

/** 读属性值的原始文本：从 `start` 到顶层 `,`/`}`（括号/字符串内的分隔符不算），空值返回 null */
function readValueText(src: string, start: number): string | null {
  if (src[start] === undefined || src[start] === "," || src[start] === "}") return null;
  let depth = 0;
  let i = start;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < src.length) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === quote) break;
        i++;
      }
      i++;
      continue;
    }
    if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "}") {
      if (depth === 0) break;
      depth--;
    } else if (c === "," && depth === 0) break;
    i++;
  }
  const out = src.slice(start, i).trim();
  return out === "" ? null : out;
}

/** JS 转义还原（字符串默认值口径） */
function unescapeJs(s: string): string {
  return s.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_, esc: string) => {
    if (esc[0] === "u") return String.fromCharCode(parseInt(esc.slice(1), 16));
    if (esc[0] === "x") return String.fromCharCode(parseInt(esc.slice(1), 16));
    const map: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0" };
    return map[esc] ?? esc;
  });
}

/**
 * JS 字面量文本 → 值。**整段锚定**：只认完整的字面量（`1 + 2`、`a.b`、`getValue()` 都不认，
 * 返回 `literal:false`）—— 认不出就不猜值，交给 hasDefault 表达「脚本确实写了默认值」。
 */
function parseLiteral(text: string | null): { literal: boolean; value: unknown } {
  if (text === null) return { literal: false, value: undefined };
  const t = text.trim();
  if (t === "") return { literal: false, value: undefined };
  const q = t[0];
  if ((q === '"' || q === "'" || q === "`") && t.length >= 2 && t[t.length - 1] === q && !/[\r\n]/.test(t.slice(1, -1))) {
    return { literal: true, value: unescapeJs(t.slice(1, -1)) };
  }
  if (t === "true") return { literal: true, value: true };
  if (t === "false") return { literal: true, value: false };
  if (t === "null") return { literal: true, value: null };
  if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(t)) return { literal: true, value: Number(t) };
  if (t.startsWith("[") && t.endsWith("]")) {
    // 数组字面量：只认纯字面量元素，认不出就当表达式（不猜）
    try {
      const jsonish = t.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":').replace(/'/g, '"');
      return { literal: true, value: JSON.parse(jsonish) };
    } catch {
      return { literal: false, value: undefined };
    }
  }
  return { literal: false, value: undefined };
}

/**
 * 取 `addCombo` 的 `options` 数组里的**全部元素原文**（顶层 `,` 处切、source 顺序）。
 * engine 读点：baseclasses.js:1441 `options:options.options` 原样交给 UI；text.js:826-830 只静态用 `opts[0]`。
 */
function elementTexts(arrText: string | null): string[] {
  if (arrText === null) return [];
  const t = arrText.trim();
  if (t[0] !== "[" || t[t.length - 1] !== "]") return [];
  const inner = t.slice(1, -1);
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  const push = (to: number) => {
    const s = inner.slice(start, to).trim();
    if (s !== "") out.push(s);
  };
  while (i < inner.length) {
    const c = inner[i];
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < inner.length) {
        if (inner[i] === "\\") {
          i += 2;
          continue;
        }
        if (inner[i] === quote) break;
        i++;
      }
      i++;
      continue;
    }
    if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === ")" || c === "]") depth--;
    else if (c === "," && depth === 0) {
      push(i);
      start = i + 1;
    }
    i++;
  }
  push(inner.length);
  return out;
}

/**
 * 解析 `addCombo` 的 `options`：对象项取 `{label?, value}`（`value` 静态求不出字面量就**丢掉该项**，不猜）；
 * 裸字面量项直接当 `value`（与 text.js:829 `firstElementText` 的裸值口径一致）。
 * 解析不出的项一律跳过 —— 选项表宁缺勿错，`kind:"combo"` 不受影响。
 */
function parseOptionsList(optionsText: string | null): TextScriptPropOption[] {
  const out: TextScriptPropOption[] = [];
  for (const el of elementTexts(optionsText)) {
    if (el.startsWith("{")) {
      const body = sliceBalanced(el, 0);
      if (!body) continue;
      const valueText = topLevelValueText(body.body, "value");
      const v = parseLiteral(valueText);
      if (!v.literal) continue;
      const opt: TextScriptPropOption = { value: v.value };
      const labelText = topLevelValueText(body.body, "label");
      const lab = parseLiteral(labelText);
      if (lab.literal && typeof lab.value === "string") opt.label = lab.value;
      out.push(opt);
    } else {
      const v = parseLiteral(el);
      if (v.literal) out.push({ value: v.value });
    }
  }
  return out;
}

/** 取数组字面量的第一个元素原文（顶层 `,`/`]` 处切），没有元素返回 null */
function firstElementText(arrText: string): string | null {
  const head = elementTexts(arrText);
  return head.length > 0 ? head[0] : null;
}
/**
 * `addCombo` 省略 `value` 时的默认值：engine text.js:826-830 取 `options[0].value`
 * （对象首项取它的 `value`，裸字面量首项就用它本身）。
 */
function firstOptionDefault(optionsText: string): { literal: boolean; value: unknown } {
  const head = firstElementText(optionsText);
  if (head === null) return { literal: false, value: undefined };
  if (head.startsWith("{")) {
    const body = sliceBalanced(head, 0);
    if (!body) return { literal: false, value: undefined };
    return parseLiteral(topLevelValueText(body.body, "value"));
  }
  return parseLiteral(head);
}

/**
 * 把注释与字符串**内容**替换成等长空格，保留所有下标。声明扫描只在这个掩码上跑：
 * 注释/字符串里出现的 `.addColor({...})` 不是声明（此前会误报）。
 */
function maskCommentsAndStrings(src: string): string {
  const out = src.split("");
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let p = from; p < to && p < out.length; p++) if (out[p] !== "\n") out[p] = " ";
  };
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      const end = nl < 0 ? src.length : nl;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      const end = close < 0 ? src.length : close + 2;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === quote) break;
        j++;
      }
      blank(i + 1, j);
      i = j + 1;
      continue;
    }
    i++;
  }
  return out.join("");
}

/**
 * 解析脚本源码里 `createScriptProperties()` 声明链的 `add*` 声明。
 *
 * engine 依据：官方只有五个方法（baseclasses.js:1423-1454）；`add*` 的 `name` 就是
 * 脚本读 `scriptProperties.<name>` 的键（text.js:994 严格大小写 `in`）；
 * 默认值口径见 declaredDefault（text.js:825-833）。同名重复声明**只认第一次**
 * （text.js:992-996 `if (!(def.name in spValues))`），所以本函数按出现序去重保首个。
 *
 * 刻意保守：扫描在「注释/字符串掩码」上做（`// .addText({...})` 不算声明），
 * `name` 必须是字符串字面量、对象字面量必须括号平衡，否则跳过该条（不猜）。
 * 已知边界：`add*` 前面挂了别的东西（如自建对象也叫 addColor）会被误认 —— 五个名字来自
 * 官方类，误差面很小，且判据里用真实语料复核过。
 */
export function declaredTextScriptProps(
  scriptSource: string | null | undefined,
): TextScriptPropDecl[] {
  if (typeof scriptSource !== "string" || scriptSource === "") return [];
  const out: TextScriptPropDecl[] = [];
  const seen = new Set<string>();
  const masked = maskCommentsAndStrings(scriptSource);
  const re = /\.?\b(add(?:Slider|Checkbox|Text|Combo|Color))\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    const method = m[1];
    const open = skipTrivia(scriptSource, m.index + m[0].length);
    const lit = sliceBalanced(scriptSource, open);
    if (!lit) continue;
    const nameText = topLevelValueText(lit.body, "name");
    if (nameText === null) continue;
    const name = parseLiteral(nameText);
    if (!name.literal || typeof name.value !== "string" || name.value === "") continue;
    const decl: TextScriptPropDecl = {
      name: name.value,
      method,
      kind: DECL_KINDS[method] ?? "unknown",
      hasDefault: false,
      defaultValue: undefined,
    };
    const valueText = topLevelValueText(lit.body, "value");
    if (valueText !== null) {
      // engine text.js:832 `propValue(def.value)`：写了 `value:` 就有默认值（能否静态求值是另一回事）
      decl.hasDefault = true;
      const v = parseLiteral(valueText);
      decl.defaultValue = v.literal ? v.value : undefined;
    } else if (method === "addCombo") {
      const optionsText = topLevelValueText(lit.body, "options");
      if (optionsText !== null) {
        const first = firstOptionDefault(optionsText);
        // engine text.js:828 `opts[0]`：只要有首个选项就有默认值（`opts[0] !== undefined/null`）
        decl.hasDefault = firstElementText(optionsText) !== null;
        decl.defaultValue = first.literal ? first.value : undefined;
      }
    }
    if (method === "addCombo") {
      // 选项表（source 顺序）供面板做下拉；解析不出就省略字段，kind 仍是 combo（面板回落到文本框）
      const opts = parseOptionsList(topLevelValueText(lit.body, "options"));
      if (opts.length > 0) decl.options = opts;
    }
    if (seen.has(decl.name)) continue;
    seen.add(decl.name);
    out.push(decl);
  }
  return out;
}

/** 按键找声明：先精确、再大小写不敏感唯一命中（engine: text.js:994 是精确，此处宽一档以免漏读作者写法） */
function declFor(decls: TextScriptPropDecl[], key: string): TextScriptPropDecl | null {
  for (const d of decls) if (d.name === key) return d;
  const want = key.toLowerCase();
  const hits = decls.filter((d) => d.name.toLowerCase() === want);
  return hits.length === 1 ? hits[0] : null;
}

/**
 * 面板行模型：**只包含作者文件里真实存在的属性**（保序）。
 * 「脚本声明了但作者没写」的键走 `addableTextScriptProps`（面板的「添加」入口），
 * 不在这里伪造行 —— 行 = 文档里真实存在的一条，撤销/删除才有一一对应的对象。
 *
 * @param readScript 由调用方（task-7 的面板）提供：给它对象，返回该对象的文字脚本源码。
 *                   本模块不碰 doc/资产层，保持纯数据、可离线判据。
 */
export function textScriptPropRows(
  obj: SceneObject | null | undefined,
  readScript?: (obj: SceneObject) => string | null | undefined,
): TextScriptPropRow[] {
  const table = textScriptPropsTable(obj);
  if (!table || !obj) return [];
  const script = readScript ? readScript(obj) : null;
  const decls = declaredTextScriptProps(script);
  return Object.entries(table).map(([key, raw]) => {
    const d = declFor(decls, key);
    const row: TextScriptPropRow = {
      key,
      kind: d ? d.kind : inferKind(raw),
      value: textScriptPropValue(raw),
      wrapped: isTextScriptPropWrapper(raw),
      declared: !!d,
      hasDefault: d ? d.hasDefault : false,
    };
    // 只在 declared 行上带 options：未声明键没有可信选项表（kind 由值类型推断）。
    // off-list 当前值不在这里收敛 —— value 原样，面板自行显示。
    if (d && d.options && d.options.length > 0) row.options = d.options;
    return row;
  });
}

/**
 * 脚本声明了、但作者还没写进 `scriptproperties` 的键（声明序）。
 * 命中判定大小写不敏感（规则①）：作者已写成 `USE24H`、脚本声明 `use24h` 时**不算可加**
 * ——再建一个小写键只会让引擎读错槽位。
 */
export function addableTextScriptProps(
  obj: SceneObject | null | undefined,
  readScript?: (obj: SceneObject) => string | null | undefined,
): string[] {
  if (!obj) return [];
  const script = readScript ? readScript(obj) : null;
  const decls = declaredTextScriptProps(script);
  const table = textScriptPropsTable(obj);
  const out: string[] = [];
  for (const d of decls) {
    if (textScriptPropKeyOf(table, d.name) === null) out.push(d.name);
  }
  return out;
}
