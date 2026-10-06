// 文字层（EDITOR-PLAN W11）：新建（普通 / 时钟 / 日期模板）与检视器字段读写。
// 产物与 WE 编辑器新建的文字对象同形（anchor none、居中对齐、padding 32、
// systemfont_arial 32 号）。字段可能被 `{ user, value }` / `{ script, value }` 包装，
// 写入时只改 value，包装原样保留。
//
// size 只是定位盒：WE 的盒 ≈ 文字在 em（= pointsize × TEXT_EM_SCALE）下的外框，
// 高 = 行数 × 1.2 em。引擎给静态文字按溢出墨水扩画布，脚本文字不扩 —— 时钟 / 日期
// 的盒必须按最宽可能输出量好，否则长出来的字被纹理边缘切掉。

import { SYSTEM_FONT_FAMILIES, TEXT_EM_SCALE } from "../renderer/src/api/editor";
import { nextObjectId, rebuildTree, unwrap, type EditorDoc, type SceneObject } from "./doc";

export type TextPreset = "plain" | "clock" | "date";
export const TEXT_PRESETS: readonly TextPreset[] = ["plain", "clock", "date"];

export const DEFAULT_FONT = "systemfont_arial";
export const DEFAULT_POINTSIZE = 32;
/** 引擎缺 pointsize 时的取值（scene/parse.js） */
const ENGINE_POINTSIZE = 24;
const LINE_FACTOR = 1.2;

export const CLOCK_SCRIPT = `'use strict';

export var scriptProperties = createScriptProperties()
\t.addCheckbox({ name: 'use24h', label: '24h', value: true })
\t.addCheckbox({ name: 'showSeconds', label: 'Seconds', value: false })
\t.finish();

/**
 * @param {String} value
 */
export function update(value) {
\tlet t = new Date();
\tlet h = t.getHours();
\tlet suffix = '';
\tif (!scriptProperties.use24h) {
\t\tsuffix = h >= 12 ? ' PM' : ' AM';
\t\th = h % 12 || 12;
\t}
\tlet s = (scriptProperties.use24h ? ('0' + h).slice(-2) : String(h)) + ':' + ('0' + t.getMinutes()).slice(-2);
\tif (scriptProperties.showSeconds) s += ':' + ('0' + t.getSeconds()).slice(-2);
\treturn s + suffix;
}
`;

export const DATE_SCRIPT = `'use strict';

export var scriptProperties = createScriptProperties()
\t.addCheckbox({ name: 'showWeekday', label: 'Weekday', value: true })
\t.finish();

/**
 * @param {String} value
 */
export function update(value) {
\tlet t = new Date();
\tlet s = t.getFullYear() + '-' + ('0' + (t.getMonth() + 1)).slice(-2) + '-' + ('0' + t.getDate()).slice(-2);
\tif (scriptProperties.showWeekday) s += ' ' + ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][t.getDay()];
\treturn s;
}
`;

type Template = { script: string; props: Record<string, boolean>; value: string; samples: readonly string[] };

const TEMPLATES: Record<Exclude<TextPreset, "plain">, Template> = {
  clock: {
    script: CLOCK_SCRIPT,
    props: { use24h: true, showSeconds: false },
    value: "12:00",
    samples: ["00:00:00", "00:00:00 PM"],
  },
  date: {
    script: DATE_SCRIPT,
    props: { showWeekday: true },
    value: "2026-01-01 Thu",
    samples: ["0000-00-00 Wed", "0000-00-00 Mon"],
  },
};

/** 文字宽度量具：text 单行，font = scene.json 的 font 值，px = em 像素 */
export type MeasureText = (text: string, font: string, px: number) => number;

type Wrapped = Record<string, unknown> & { value?: unknown };
const isWrapped = (v: unknown): v is Wrapped => !!v && typeof v === "object" && !Array.isArray(v);
const f3 = (v: number) => (Math.round(v * 1000) / 1000).toFixed(3);

/** 写字段：包装（用户属性 / 脚本）只改 value。返回是否真的变了 */
function writeField(obj: SceneObject, key: string, v: unknown): boolean {
  const cur = obj[key];
  if (isWrapped(cur) && ("value" in cur || "user" in cur || "script" in cur)) {
    if (cur.value === v) return false;
    cur.value = v;
    return true;
  }
  if (cur === v) return false;
  obj[key] = v;
  return true;
}

export const isTextObject = (o: SceneObject) => o.text !== undefined && o.text !== null;

export function textValue(obj: SceneObject): string {
  const v = unwrap(obj.text);
  return typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);
}

export function isScriptedText(obj: SceneObject): boolean {
  const t = obj.text;
  return isWrapped(t) && typeof t.script === "string" && t.script.length > 0;
}

/** 文字内容是否由用户属性驱动（{ user, value }） */
export function isBoundText(obj: SceneObject): boolean {
  return isWrapped(obj.text) && "user" in obj.text;
}

/** 文字的脚本是不是本模块的模板（是才能按样例量盒） */
export function presetOf(obj: SceneObject): TextPreset | null {
  if (!isTextObject(obj)) return null;
  if (!isScriptedText(obj)) return "plain";
  const s = (obj.text as Wrapped).script;
  if (s === CLOCK_SCRIPT) return "clock";
  if (s === DATE_SCRIPT) return "date";
  return null;
}

export function setTextValue(obj: SceneObject, text: string): boolean {
  if (!isTextObject(obj) || typeof text !== "string") return false;
  return writeField(obj, "text", text.replace(/\r\n?/g, "\n"));
}

export type TextField = "font" | "pointsize" | "horizontalalign" | "verticalalign" | "padding" | "opaquebackground" | "backgroundcolor";

export const H_ALIGNS = ["left", "center", "right"] as const;
export const V_ALIGNS = ["top", "center", "bottom"] as const;

export type TextFields = {
  font: string;
  pointsize: number;
  horizontalalign: string;
  verticalalign: string;
  padding: number;
  opaquebackground: boolean;
  backgroundcolor: [number, number, number];
};

function parseColor(v: unknown): [number, number, number] {
  const parts = typeof v === "string" ? v.trim().split(/\s+/).map(Number) : Array.isArray(v) ? v.map(Number) : [];
  if (parts.length < 3 || parts.slice(0, 3).some((x) => !Number.isFinite(x))) return [0, 0, 0];
  return [parts[0], parts[1], parts[2]];
}

/** 检视器读值：缺省按引擎口径补齐 */
export function getTextFields(obj: SceneObject): TextFields {
  const font = unwrap(obj.font);
  const ps = Number(unwrap(obj.pointsize));
  const ha = unwrap(obj.horizontalalign);
  const va = unwrap(obj.verticalalign);
  const pad = unwrap(obj.padding);
  const padN = typeof pad === "string" ? Number(pad.trim().split(/\s+/)[0]) : Number(pad);
  const bg = unwrap(obj.opaquebackground);
  return {
    font: typeof font === "string" && font ? font : DEFAULT_FONT,
    pointsize: Number.isFinite(ps) && ps > 0 ? ps : ENGINE_POINTSIZE,
    horizontalalign: typeof ha === "string" && (H_ALIGNS as readonly string[]).includes(ha) ? ha : "center",
    verticalalign: typeof va === "string" && (V_ALIGNS as readonly string[]).includes(va) ? va : "center",
    padding: Number.isFinite(padN) && padN >= 0 ? padN : 0,
    opaquebackground: bg === true || bg === "true" || bg === 1,
    backgroundcolor: parseColor(unwrap(obj.backgroundcolor)),
  };
}

/** 检视器写值：校验不过 / 没变返回 false */
export function setTextField<K extends TextField>(obj: SceneObject, field: K, value: TextFields[K]): boolean {
  if (!isTextObject(obj)) return false;
  switch (field) {
    case "font": {
      const f = typeof value === "string" ? value.trim() : "";
      return !!f && writeField(obj, "font", f);
    }
    case "pointsize": {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0 || n > 1000) return false;
      const next = Math.round(n * 1000) / 1000;
      const prev = getTextFields(obj).pointsize;
      if (!writeField(obj, "pointsize", next)) return false;
      // 量不了的脚本文字：盒按字号等比缩放，至少不让放大后的字被切
      scaleSize(obj, next / prev);
      return true;
    }
    case "horizontalalign":
      return (H_ALIGNS as readonly unknown[]).includes(value) && writeField(obj, field, value);
    case "verticalalign":
      return (V_ALIGNS as readonly unknown[]).includes(value) && writeField(obj, field, value);
    case "padding": {
      const n = Number(value);
      return Number.isFinite(n) && n >= 0 && n <= 4096 && writeField(obj, "padding", Math.round(n * 1000) / 1000);
    }
    case "opaquebackground":
      return typeof value === "boolean" && writeField(obj, field, value);
    case "backgroundcolor": {
      const c = value as unknown;
      if (!Array.isArray(c) || c.length < 3 || c.slice(0, 3).some((x) => !Number.isFinite(Number(x)))) return false;
      const s = c.slice(0, 3).map((x) => f3(Math.max(0, Math.min(1, Number(x))))).join(" ");
      return writeField(obj, field, s);
    }
  }
  return false;
}

function parseSize(v: unknown): [number, number] | null {
  const raw = unwrap(v);
  const p = typeof raw === "string" ? raw.trim().split(/\s+/).map(Number) : Array.isArray(raw) ? raw.map(Number) : [];
  return p.length >= 2 && p[0] > 0 && p[1] > 0 ? [p[0], p[1]] : null;
}

function scaleSize(obj: SceneObject, k: number) {
  const s = parseSize(obj.size);
  if (!s || !Number.isFinite(k) || k <= 0 || k === 1) return;
  writeField(obj, "size", `${f3(s[0] * k)} ${f3(s[1] * k)}`);
}

/** 盒尺寸：最宽行 × 行数 × 1.2 em（WE 编辑器的口径） */
export function measureTextBox(lines: readonly string[], font: string, pointsize: number, measure: MeasureText): [number, number] {
  const em = TEXT_EM_SCALE * pointsize;
  let w = 0;
  for (const l of lines) w = Math.max(w, measure(l, font, em));
  return [Math.max(w, em * 0.5), Math.max(1, lines.length) * em * LINE_FACTOR];
}

/**
 * 按内容回填 size。静态文字量当前内容；模板脚本量最宽样例与快照中的大者；
 * 别处来的脚本文字不知道会输出什么，不动（返回 false）。
 */
export function refitTextBox(obj: SceneObject, measure: MeasureText): boolean {
  const preset = presetOf(obj);
  if (!preset) return false;
  const { font, pointsize } = getTextFields(obj);
  const lines = textValue(obj).split("\n");
  const [wl, h] = measureTextBox(lines, font, pointsize, measure);
  const [w] = preset === "plain" ? [0] : measureTextBox(TEMPLATES[preset].samples, font, pointsize, measure);
  return writeField(obj, "size", `${f3(Math.max(w, wl))} ${f3(h)}`);
}

/** 新文字层追加到对象数组末尾（绘制在最上），放在场景中心。返回新 id */
export function addTextLayer(doc: EditorDoc, preset: TextPreset, name: string, text: string, measure: MeasureText): number | null {
  const scene = doc.scene;
  if (!scene || !TEXT_PRESETS.includes(preset)) return null;
  if (!Array.isArray(scene.objects)) scene.objects = [];
  const objs = scene.objects as SceneObject[];
  const ortho = (scene.general as Record<string, unknown> | undefined)?.orthogonalprojection as Record<string, unknown> | undefined;
  const W = Number(ortho?.width) || 1920;
  const H = Number(ortho?.height) || 1080;
  const id = nextObjectId(objs);
  const tpl = preset === "plain" ? null : TEMPLATES[preset];
  const obj: SceneObject = {
    alpha: 1,
    anchor: "none",
    angles: "0.000 0.000 0.000",
    backgroundbrightness: 1,
    backgroundcolor: "0.000 0.000 0.000",
    color: "1.000 1.000 1.000",
    font: DEFAULT_FONT,
    horizontalalign: "center",
    id,
    limitrows: false,
    limituseellipsis: false,
    limitwidth: false,
    maxrows: 1,
    maxwidth: 500,
    name,
    opaquebackground: false,
    origin: `${f3(W / 2)} ${f3(H / 2)} 0.000`,
    padding: 32,
    pointsize: DEFAULT_POINTSIZE,
    scale: "1.000 1.000 1.000",
    size: "0.000 0.000",
    text: tpl ? { script: tpl.script, scriptproperties: { ...tpl.props }, value: tpl.value } : text,
    verticalalign: "center",
  };
  refitTextBox(obj, measure);
  objs.push(obj);
  rebuildTree(doc);
  return id;
}

export const isSystemFont = (font: string) => /^systemfont_/i.test(font);

export const SYSTEM_FONTS: readonly string[] = Object.keys(SYSTEM_FONT_FAMILIES);

/** systemfont_timesnewroman → 字体栈里的第一个族名（Times New Roman） */
export function systemFontLabel(font: string): string {
  const stack = SYSTEM_FONT_FAMILIES[font.toLowerCase()];
  if (!stack) return font;
  return stack.split(",")[0].trim().replace(/^['"]|['"]$/g, "");
}

/** 工程字体（非 systemfont_*）路径集合：资源表据此决定导入的字体文件是否进保存清单 */
export function referencedFonts(doc: EditorDoc | null): Set<string> {
  const out = new Set<string>();
  const objs = doc?.scene?.objects;
  if (!Array.isArray(objs)) return out;
  for (const o of objs as SceneObject[]) {
    if (!o || !isTextObject(o)) continue;
    const f = unwrap(o.font);
    if (typeof f === "string" && f && !isSystemFont(f)) out.add(f);
  }
  return out;
}

export const FONT_FILE_RE = /\.(ttf|otf)$/i;

export function isFontFile(f: { name: string }): boolean {
  return FONT_FILE_RE.test(f.name);
}

/** 导入字体的工程内路径 fonts/<slug>.<ttf|otf>；taken 判重后加 -2、-3… */
export function fontPathOf(fileName: string, taken: (path: string) => boolean): string | null {
  const m = FONT_FILE_RE.exec(fileName);
  if (!m) return null;
  const ext = m[1].toLowerCase();
  const base =
    (fileName.replace(/\\/g, "/").split("/").pop() ?? "")
      .replace(FONT_FILE_RE, "")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "font";
  const at = (s: string) => `fonts/${s}.${ext}`;
  if (!taken(at(base))) return at(base);
  for (let i = 2; ; i++) if (!taken(at(`${base}-${i}`))) return at(`${base}-${i}`);
}

/** 字体文件路径 → 下拉框里显示的名字 */
export function fontLabel(font: string): string {
  if (isSystemFont(font)) return systemFontLabel(font);
  return font.replace(/\\/g, "/").split("/").pop() ?? font;
}
