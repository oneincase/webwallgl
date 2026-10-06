// 脚本挂点的文档读写（EDITOR-PLAN W8 / §3A P4）。WE 的写法是把字段值包成
// `{ script, scriptproperties?, value }`：value 是快照（脚本未运行 / 失败时的值），
// 与用户属性绑定 `{ user, value }` 可以共存在同一个包装里。

import type { SceneObject } from "./doc";

/** 引擎解析的对象脚本字段白名单（同 scene/parse.js 的 objectScripts） */
export const OBJECT_SCRIPT_FIELDS = [
  "origin",
  "scale",
  "angles",
  "visible",
  "alpha",
  "color",
  "brightness",
  "maxwidth",
  "pointsize",
  "volume",
  "intensity",
  "exponent",
] as const;

/** 新建脚本时面板提供的挂点（按图层种类） */
export function addableTargets(kind: string): string[] {
  const base = ["origin", "scale", "angles", "visible", "alpha"];
  if (kind === "text") return ["text", ...base, "color", "pointsize"];
  if (kind === "image") return [...base, "color", "brightness"];
  if (kind === "sound") return ["volume"];
  if (kind === "light") return ["color", "intensity"];
  return base;
}

export type ScriptSlot = {
  target: string;
  script: string;
  /** 包装里的快照值 */
  value: unknown;
  hasProps: boolean;
};

type Wrapped = { script?: unknown; scriptproperties?: unknown; value?: unknown; [k: string]: unknown };

const isWrapped = (v: unknown): v is Wrapped => !!v && typeof v === "object" && !Array.isArray(v);
const EFFECT_VIS = /^effects\[(\d+)\]\.visible$/;

/** 挂点 → 所在容器与键（effects[i].visible 落在效果条目上） */
function locate(obj: SceneObject, target: string): { host: Record<string, unknown>; key: string } | null {
  const m = EFFECT_VIS.exec(target);
  if (m) {
    const e = Array.isArray(obj.effects) ? (obj.effects as unknown[])[Number(m[1])] : undefined;
    return isWrapped(e) ? { host: e as Record<string, unknown>, key: "visible" } : null;
  }
  if (target === "text" || (OBJECT_SCRIPT_FIELDS as readonly string[]).includes(target)) return { host: obj as Record<string, unknown>, key: target };
  return null;
}

const scriptOf = (v: unknown) => (isWrapped(v) && typeof v.script === "string" && v.script ? v.script : null);

/** 图层上已有的脚本（对象字段 → 文字 → 效果开关的顺序） */
export function scriptSlots(obj: SceneObject): ScriptSlot[] {
  const out: ScriptSlot[] = [];
  const push = (target: string, v: unknown) => {
    const s = scriptOf(v);
    if (s !== null) out.push({ target, script: s, value: (v as Wrapped).value, hasProps: isWrapped((v as Wrapped).scriptproperties) });
  };
  push("text", (obj as Record<string, unknown>).text);
  for (const f of OBJECT_SCRIPT_FIELDS) push(f, (obj as Record<string, unknown>)[f]);
  if (Array.isArray(obj.effects)) (obj.effects as unknown[]).forEach((e, i) => isWrapped(e) && push(`effects[${i}].visible`, e.visible));
  return out;
}

export function getScript(obj: SceneObject, target: string): string | null {
  const at = locate(obj, target);
  return at ? scriptOf(at.host[at.key]) : null;
}

/** 写脚本源码；字段原本是裸值 / {user,value} 时就地包装，scriptproperties 与绑定保留 */
export function setScript(obj: SceneObject, target: string, code: string): boolean {
  const at = locate(obj, target);
  if (!at || typeof code !== "string" || !code.trim()) return false;
  const cur = at.host[at.key];
  if (isWrapped(cur) && ("script" in cur || "user" in cur || "value" in cur)) {
    if (cur.script === code) return false;
    cur.script = code;
    return true;
  }
  at.host[at.key] = { script: code, value: cur ?? defaultValueOf(target) };
  return true;
}

/** 去掉脚本：只剩 value 时解包回裸值，还有用户属性绑定时保留包装 */
export function removeScript(obj: SceneObject, target: string): boolean {
  const at = locate(obj, target);
  const cur = at ? at.host[at.key] : undefined;
  if (!at || !isWrapped(cur) || scriptOf(cur) === null) return false;
  delete cur.script;
  delete cur.scriptproperties;
  const rest = Object.keys(cur).filter((k) => k !== "value");
  at.host[at.key] = rest.length ? cur : cur.value;
  if (at.host[at.key] === undefined) delete at.host[at.key];
  return true;
}

function defaultValueOf(target: string): unknown {
  switch (target) {
    case "scale":
      return "1.00000 1.00000 1.00000";
    case "origin":
    case "angles":
      return "0.00000 0.00000 0.00000";
    case "color":
      return "1.00000 1.00000 1.00000";
    case "visible":
      return true;
    case "text":
      return "";
    default:
      return 1;
  }
}

/** 新脚本模板：WE 官方的 update(value) 形态，返回值即字段新值 */
export function scriptTemplate(target: string): string {
  const vec = target === "origin" || target === "scale" || target === "angles" || target === "color";
  const type = target === "text" ? "String" : target === "visible" ? "Boolean" : vec ? "Vec3" : "Number";
  return `'use strict';\n\n/**\n * ${target}\n * @param {${type}} value\n */\nexport function update(value) {\n\treturn value;\n}\n`;
}
