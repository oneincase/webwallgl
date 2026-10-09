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

/**
 * 脚本生命周期模板（B8 / M9）。
 * 入口名字面量依据引擎：`renderer/vendor/we-scene/render/text.js` 的 `SCRIPT_ENTRY_NAMES`
 * （`update` / `init` / `applyUserProperties` / 6 个 `cursor*` / `MEDIA_CALLBACKS` 6 个 /
 * `animationEvent` / `resizeScreen`）。派发口径同文件：`init(value)` 的返回值是字段新初值、
 * `applyUserProperties(props)` 挂载时以全量属性先调一次、`callCursor(name, event)` 传单个事件、
 * `callMedia(name, event)` 传 toScriptMediaEvent(event)、`animationEvent(event, value)` 两个参数、
 * `resizeScreen(size)` 单个 Vec2。
 * `destroy` **不在** `SCRIPT_ENTRY_NAMES` 里（引擎只有 `thisScene.destroyLayer` 的墓碑机制），
 * 所以它的模板额外保留字段主回调，免得整份脚本被「无可用入口」的闸门丢掉。
 */
export type ScriptLifecycle =
  | "update"
  | "init"
  | "applyUserProperties"
  | "cursor"
  | "media"
  | "resizeScreen"
  | "animationEvent"
  | "destroy";

/** 面板下拉里的模板顺序：先字段主回调，再按引擎派发顺序，destroy 排最后（引擎不派发） */
export const SCRIPT_LIFECYCLES: readonly ScriptLifecycle[] = [
  "update",
  "init",
  "applyUserProperties",
  "cursor",
  "media",
  "resizeScreen",
  "animationEvent",
  "destroy",
];

function fieldType(target: string): string {
  const vec = target === "origin" || target === "scale" || target === "angles" || target === "color";
  return target === "text" ? "String" : target === "visible" ? "Boolean" : vec ? "Vec3" : "Number";
}

/** 字段主回调：参数是字段当前值，返回值即新值（undefined = 保持不变） */
function fieldUpdate(target: string): string {
  return [
    "/**",
    ` * ${target}`,
    ` * @param {${fieldType(target)}} value 字段当前值`,
    " * @returns 字段新值；返回 undefined 表示保持不变",
    " */",
    "export function update(value) {",
    "\treturn value;",
    "}",
  ].join("\n");
}

/** 除 update 之外的生命周期钩子（每个模板都会再带上一段字段主回调） */
function lifecycleHook(kind: Exclude<ScriptLifecycle, "update">): string {
  switch (kind) {
    case "init":
      return [
        "/**",
        " * 挂载时调用一次；返回值是该字段的新初值（不返回则保持 scene.json 里的值）。",
        " */",
        "export function init(value) {",
        "\treturn value;",
        "}",
      ].join("\n");
    case "applyUserProperties":
      return [
        "/**",
        " * 用户属性变化；挂载时会先用全量属性调一次。props 形如 { 属性名: 值 }。",
        " */",
        "export function applyUserProperties(props) {",
        "\t// 例：thisLayer.text = props.标题",
        "}",
      ].join("\n");
    case "cursor":
      return [
        "// 指针事件：引擎按事件名逐个派发（hittest / cursor-dispatch），只留用得上的那几个即可。",
        "export function cursorClick(e) {}",
        "export function cursorEnter(e) {}",
        "export function cursorLeave(e) {}",
        "export function cursorDown(e) {}",
        "export function cursorUp(e) {}",
        "export function cursorMove(e) {}",
      ].join("\n");
    case "media":
      return [
        "// 媒体回调：宿主只在媒体快照变化时派发（不是每帧），e 形如 { title, artist, ... }。",
        "export function mediaPropertiesChanged(e) {}",
        "export function mediaThumbnailChanged(e) {}",
        "export function mediaPlaybackChanged(e) {}",
        "export function mediaTimelineChanged(e) {}",
        "export function mediaStatusChanged(e) {}",
        "export function mediaLyricsChanged(e) {}",
      ].join("\n");
    case "resizeScreen":
      return [
        "/**",
        " * 画布尺寸变化（含首帧）；size 是 Vec2，读 size.x / size.y。",
        " */",
        "export function resizeScreen(size) {}",
      ].join("\n");
    case "animationEvent":
      return [
        "/**",
        " * 动画帧事件：该图层任一动画出事件时广播；value 是本字段当前值，返回值可覆盖它。",
        " */",
        "export function animationEvent(event, value) {",
        "\treturn value;",
        "}",
      ].join("\n");
    case "destroy":
      return [
        "// destroy 不是引擎派发的入口（SCRIPT_ENTRY_NAMES 里没有它）。这里只留一个清理位，",
        "// 并按官方惯例保留字段主回调：没有可用入口、又不读 engine 时钟的脚本会被整份丢弃。",
        "export function destroy() {}",
      ].join("\n");
  }
}

/**
 * 新脚本模板。lifecycle 缺省 `"update"`（WE 官方的 update(value) 形态，返回值即字段新值）；
 * 其余模板 = 所选生命周期钩子 + 字段主回调。
 */
export function scriptTemplate(target: string, lifecycle: ScriptLifecycle = "update"): string {
  const head = "'use strict';\n\n";
  if (lifecycle === "update") return `${head}${fieldUpdate(target)}\n`;
  return `${head}${lifecycleHook(lifecycle)}\n\n${fieldUpdate(target)}\n`;
}
