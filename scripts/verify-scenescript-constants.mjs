#!/usr/bin/env node
/**
 * SceneScript / 用户属性常量面判据（W5）。
 *
 * 目标：把「本仓的 SceneScript 常量面」与「官方随包声明」之间的差异**钉成判据**，
 * 使任何一处悄悄偏移都会让本脚本变红；差异本身（尚未实现的官方面）以
 * 「已知缺口」的形式显式钉住当前值 —— 缺口被补齐时本脚本也会变红，
 * 提示维护者同步更新本文件与 docs/re/we-native-scenescript-constants.md。
 *
 * 证据来源（**全部写死在本文件里**，运行时不读盘、不读素材库、不联网）：
 *   1) 官方 SceneScript 类型声明（随包）
 *      <安装根>/ui/dist/monaco/autocomplete/lib.sceneScript.d.ts
 *      —— 首行自述 "OFFICIAL SCENESCRIPT TYPE DECLARATION - VERSION 2.8"。
 *      事件成员行号：init:55 update:67 destroy:72 resizeScreen:81
 *      applyUserProperties:95 applyGeneralSettings:109 cursorEnter:114
 *      cursorLeave:119 cursorMove:124 cursorDown:129 cursorUp:134
 *      cursorClick:139 mediaStatusChanged:144 mediaPlaybackChanged:149
 *      mediaPropertiesChanged:154 mediaThumbnailChanged:159 mediaTimelineChanged:164；
 *      IEngine.isPortrait():2392 / isLandscape():2397（都是**方法**）。
 *   2) 官方编辑器 bundle（随包）<安装根>/ui/dist/scripts/scripts.js
 *      —— 「插入事件」按钮序列（18 个）与属性类型下拉枚举、新建属性默认值 switch。
 *   3) 随包脚本类库 <安装根>/assets/scripts/jsclasses/baseclasses.js
 *      —— addCombo 的官方语义：`vars[options.name] = options.options[0].value`。
 *      仓内 `local-assets/scripts/jsclasses/baseclasses.js` 与其逐字节相同。
 *   4) 补证轮（task-28）：随包 bin/scenescript64.dll 的标识符表（sha256
 *      58039ef912fcd51cd833540476e3798268158a06f63003fe94bff1b1cbeaad08）
 *      —— 事件名表 0x19a1704-0x19a1858（19 项，含内部钩子 cursorHitTest）、
 *      引擎成员表 0x19a13f8-0x19a1594（23 项，含内部谓词 isObjectValid）。
 *      本文件**只把结论写死**（不读该 dll、不读素材库）；复现命令见文档 §0.4。
 *
 * 判据分三层（沿用 verify-occlusion 的四层纪律，这里只用前三层）：
 *   §一/§二  文本判据：只证源码里「有这个形态」，不证行为正确；
 *   §三      数值判据：**真跑沙箱**（evalTextScript 进程内合成夹具）；
 *   §四      已知缺口钉住：现状即官方缺失项，改好了必须同步改本判据；
 *   §五      原生内部名钉住：公开声明面没有的名字不得进入本仓公开面。
 *
 * 用法：node scripts/verify-scenescript-constants.mjs
 * 退出码非 0 表示常量面发生未预期的偏移。
 *
 * 约束：不触碰 WE_LIBRARY / 素材库；夹具全部进程内合成。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ROOT, imp, createChecker } from "./lib/verify-kit.mjs";

const { check, errors } = createChecker();

const TEXT_JS = "renderer/vendor/we-scene/render/text.js";
const USER_PROPS_JS = "renderer/vendor/we-scene/scene/user-props.js";

const wtext = await imp(TEXT_JS);
const textSrc = readFileSync(join(ROOT, TEXT_JS), "utf8");
const propsSrc = readFileSync(join(ROOT, USER_PROPS_JS), "utf8");

// ---------------------------------------------------------------- 官方常量表

/** 官方「插入事件」按钮序列（编辑器 bundle，18 个，顺序照抄）。 */
const OFFICIAL_EVENTS = [
  "init", "update", "resizeScreen", "applyUserProperties", "applyGeneralSettings",
  "destroy", "animationEvent", "cursorEnter", "cursorLeave", "cursorMove",
  "cursorClick", "cursorDown", "cursorUp", "mediaStatusChanged", "mediaPlaybackChanged",
  "mediaPropertiesChanged", "mediaThumbnailChanged", "mediaTimelineChanged",
];

/** 官方媒体回调（IComponent 成员，共 5 个）。 */
const OFFICIAL_MEDIA_EVENTS = [
  "mediaStatusChanged", "mediaPlaybackChanged", "mediaPropertiesChanged",
  "mediaThumbnailChanged", "mediaTimelineChanged",
];

/** IComponent 里本仓刻意不派发的两个（本仓只有帧/指针/媒体/尺寸四类派发通道）。 */
const KNOWN_MISSING_EVENTS = ["destroy", "applyGeneralSettings"];

/** 官方属性类型枚举：scene 工程 8 类 / 非 scene 工程 8 类（编辑器 bundle）。 */
const OFFICIAL_SCENE_TYPES = [
  "color", "slider", "bool", "combo", "textinput", "scenetexture", "usershortcut", "group",
];
const OFFICIAL_NONSCENE_TYPES = [
  "color", "slider", "bool", "combo", "textinput", "directory", "file", "group",
];
const OFFICIAL_ALL_TYPES = [...new Set([...OFFICIAL_SCENE_TYPES, ...OFFICIAL_NONSCENE_TYPES])].sort();

/** 官方 JS 模块（d.ts 的 declare module，正好 3 个，与本仓 WE_IMPORT_MODULES 同集）。 */
const OFFICIAL_MODULES = ["WEMath", "WEVector", "WEColor"];

/** 官方 MediaPlaybackEvent 取值（随包 baseclasses.js:1364-1368）。 */
const OFFICIAL_MEDIA_PLAYBACK = { PLAYBACK_STOPPED: 0, PLAYBACK_PLAYING: 1, PLAYBACK_PAUSED: 2 };

/** 官方 createScriptProperties 声明的字段（addXxx 的 _config）。 */
const OFFICIAL_DECL_FIELDS = [
  "order", "label", "min", "max", "mode", "options", "value", "integer",
];

/** 本仓声明的属性类型（scene/user-props.js 的 DECLARABLE_TYPES）。 */
const EXPECT_DECLARABLE = ["slider", "color", "bool", "combo", "textinput"];

/** 本仓 DECL_FIELDS。 */
const EXPECT_DECL_FIELDS = [
  "text", "min", "max", "step", "precision", "fraction", "options", "order", "condition",
];

/** DECL_FIELDS 里不属于官方 addXxx `_config` 的字段（编辑器侧 / 本仓消费）。 */
const REPO_DECL_EXTRA = ["text", "step", "precision", "fraction", "condition"];

/** 本仓媒体回调（6 个 = 官方 5 + 本仓扩展 1；顺序即源码里的顺序）。 */
const EXPECT_MEDIA_CALLBACKS = [
  "mediaPropertiesChanged", "mediaThumbnailChanged", "mediaPlaybackChanged",
  "mediaTimelineChanged", "mediaStatusChanged", "mediaLyricsChanged",
];

/** 本仓 SCRIPT_ENTRY_NAMES（17 名，顺序即源码顺序：帧 + 指针 + 媒体 + 动画 + 尺寸）。 */
const EXPECT_ENTRY_NAMES = [
  "update", "init", "applyUserProperties",
  "cursorClick", "cursorEnter", "cursorLeave", "cursorDown", "cursorUp", "cursorMove",
  ...EXPECT_MEDIA_CALLBACKS,
  "animationEvent", "resizeScreen",
];

/** 沙箱形参表必须包含的官方全局/模块名（值来自 d.ts 的 declare let / declare module）。 */
const REQUIRED_SANDBOX_PARAMS = [
  "scriptProperties", "engine", "createScriptProperties", "shared",
  "WEMath", "WEColor", "WEVector", "Vec2", "Vec3", "Vec4",
  "input", "thisLayer", "thisScene", "localStorage", "console", "MediaPlaybackEvent",
];

// ---------------------------------------------------------------- 小工具

/** 从源码里抠出 `const NAME = [ ... ]` 的所有字符串字面量。 */
function listIn(src, re, label) {
  const m = re.exec(src);
  if (!m) {
    check(false, `源码形态缺失：${label}（正则 ${re}）`);
    return null;
  }
  return [...m[1].matchAll(/'([^']*)'|"([^"]*)"/g)].map((x) => x[1] ?? x[2]);
}

const sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const sortedEq = (a, b) => sameList([...a].sort(), [...b].sort());
const fmt = (a) => JSON.stringify(a);

/** 跑一次文本脚本，返回沙箱句柄（失败返回 null）。 */
function runText(script, scriptprops = {}, opts = {}) {
  return wtext.evalTextScript(script, scriptprops, opts);
}

/** 取沙箱的成员值（句柄没有该成员时返回哨兵）。 */
const MISSING = Symbol("missing");
const propOf = (sb, name) => (sb && sb.scriptProperties && name in sb.scriptProperties
  ? sb.scriptProperties[name] : MISSING);

// ================================================================ §一 官方面

console.log("verify-scenescript-constants: 官方随包声明面（18 事件 / 10 类型 / 3 模块）");
check(OFFICIAL_EVENTS.length === 18, `官方事件表应为 18 条，实为 ${OFFICIAL_EVENTS.length}`);
check(OFFICIAL_MEDIA_EVENTS.every((n) => OFFICIAL_EVENTS.includes(n)),
  `官方媒体回调必须都在官方事件表里：${fmt(OFFICIAL_MEDIA_EVENTS)}`);
check(OFFICIAL_ALL_TYPES.length === 10, `官方类型并集应为 10 类，实为 ${OFFICIAL_ALL_TYPES.length}`);

// ================================================================ §二 常量面

console.log("verify-scenescript-constants: 本仓常量 ↔ 官方（文本判据，只证形态）");

// -- SCRIPT_ENTRY_NAMES：直接读导出，逐名逐序
const entries = wtext.SCRIPT_ENTRY_NAMES;
check(Array.isArray(entries), "SCRIPT_ENTRY_NAMES 必须是数组");
if (Array.isArray(entries)) {
  check(Object.isFrozen(entries), "SCRIPT_ENTRY_NAMES 必须冻结（防宿主误改）");
  check(sameList([...entries], EXPECT_ENTRY_NAMES),
    `SCRIPT_ENTRY_NAMES 逐名逐序应为 ${fmt(EXPECT_ENTRY_NAMES)}，实为 ${fmt([...entries])}`);
  // 官方事件覆盖：缺的必须恰好是两个已记录的缺口
  const missing = OFFICIAL_EVENTS.filter((n) => !entries.includes(n));
  check(sortedEq(missing, KNOWN_MISSING_EVENTS),
    `官方 18 事件里本仓缺失项应为 ${fmt(KNOWN_MISSING_EVENTS)}，实为 ${fmt(missing)}`
    + "（若已补齐 destroy/applyGeneralSettings，请同步更新本判据与 docs/re 文档）");
  check(OFFICIAL_MEDIA_EVENTS.every((n) => entries.includes(n)),
    "官方 5 个媒体回调必须都在 SCRIPT_ENTRY_NAMES 里");
  check(entries.includes("animationEvent") && entries.includes("resizeScreen"),
    "animationEvent / resizeScreen 必须在 SCRIPT_ENTRY_NAMES 里");
}

// -- MEDIA_CALLBACKS
const mediaCbs = listIn(textSrc, /const MEDIA_CALLBACKS = \[([\s\S]*?)\]/, "MEDIA_CALLBACKS");
if (mediaCbs) {
  check(sameList(mediaCbs, EXPECT_MEDIA_CALLBACKS),
    `MEDIA_CALLBACKS 应为 ${fmt(EXPECT_MEDIA_CALLBACKS)}（官方 5 + 本仓扩展 mediaLyricsChanged），实为 ${fmt(mediaCbs)}`);
}

// -- WE_IMPORT_MODULES == 官方 3 模块
const modKeys = listIn(textSrc, /const WE_IMPORT_MODULES = \{([^}]*)\}/, "WE_IMPORT_MODULES");
if (modKeys) {
  const keys = [.../const WE_IMPORT_MODULES = \{([^}]*)\}/.exec(textSrc)[1]
    .matchAll(/([A-Za-z_$][\w$]*)\s*:/g)].map((m) => m[1]);
  check(sortedEq(keys, OFFICIAL_MODULES),
    `WE_IMPORT_MODULES 键应为官方 3 模块 ${fmt(OFFICIAL_MODULES)}，实为 ${fmt(keys)}`);
}

// -- MediaPlaybackEvent 取值（文本读，模块未导出该常量）
const mpe = /const MEDIA_PLAYBACK_EVENT = Object\.freeze\(\{([\s\S]*?)\}\)/.exec(textSrc);
if (!mpe) {
  check(false, "源码形态缺失：MEDIA_PLAYBACK_EVENT 冻结字面量");
} else {
  const vals = Object.fromEntries([...mpe[1].matchAll(/([A-Z_]+)\s*:\s*(-?\d+)/g)]
    .map((m) => [m[1], Number(m[2])]));
  check(JSON.stringify(vals) === JSON.stringify(OFFICIAL_MEDIA_PLAYBACK),
    `MEDIA_PLAYBACK_EVENT 应与官方 ${JSON.stringify(OFFICIAL_MEDIA_PLAYBACK)} 逐值一致，实为 ${JSON.stringify(vals)}`);
}

// -- 沙箱形参表
const params = listIn(textSrc, /const SANDBOX_PARAM_NAMES = \[([\s\S]*?)\n\]/, "SANDBOX_PARAM_NAMES");
if (params) {
  check(params.length === 42, `SANDBOX_PARAM_NAMES 应为 42 名，实为 ${params.length}`);
  const missingParams = REQUIRED_SANDBOX_PARAMS.filter((n) => !params.includes(n));
  check(missingParams.length === 0,
    `SANDBOX_PARAM_NAMES 缺官方全局/模块名：${fmt(missingParams)}`);
  check(/SANDBOX_PARAM_NAMES\.join\('\|'\)/.test(textSrc),
    "SANDBOX_PARAM_DECL_RE 必须由 SANDBOX_PARAM_NAMES 拼出（形参表与降级正则同源）");
}

// -- declaredDefault 两个 builder 镜像（evalTextScript / evalObjectScript）
const ddHits = (textSrc.match(/declaredDefault\(name, def\)/g) || []).length;
check(ddHits === 2,
  `declaredDefault 必须在两个沙箱 builder 各用一次（combo 缺省值），实测 ${ddHits} 处`);
const ddFn = /function declaredDefault\(methodName, def\) \{([\s\S]*?)\n\}/.exec(textSrc);
check(!!ddFn, "源码形态缺失：function declaredDefault(methodName, def)");
if (ddFn) {
  check(/methodName === 'addCombo'/.test(ddFn[1]),
    "declaredDefault 的 combo 分支必须只对 addCombo 生效（addText/addSlider 取 options.value）");
}

// -- 用户属性声明面（scene/user-props.js）
const declTypes = listIn(propsSrc, /const DECLARABLE_TYPES = new Set\(\[([\s\S]*?)\]\)/, "DECLARABLE_TYPES");
if (declTypes) {
  check(sortedEq(declTypes, EXPECT_DECLARABLE),
    `DECLARABLE_TYPES 应为 ${fmt(EXPECT_DECLARABLE)}，实为 ${fmt(declTypes)}`);
  const unknown = declTypes.filter((t) => !OFFICIAL_ALL_TYPES.includes(t));
  check(unknown.length === 0,
    `DECLARABLE_TYPES 含官方枚举里没有的类型名（拼写漂移）：${fmt(unknown)}`);
  const gapTypes = OFFICIAL_ALL_TYPES.filter((t) => !declTypes.includes(t));
  check(sortedEq(gapTypes, ["directory", "file", "group", "scenetexture", "usershortcut"]),
    "已记录的官方类型缺口应恰为 directory/file/group/scenetexture/usershortcut，"
    + `实为 ${fmt(gapTypes)}（若已扩面请同步更新本判据与 docs/re 文档）`);
}
const declFields = listIn(propsSrc, /const DECL_FIELDS = \[([\s\S]*?)\]/, "DECL_FIELDS");
if (declFields) {
  check(sameList(declFields, EXPECT_DECL_FIELDS),
    `DECL_FIELDS 应为 ${fmt(EXPECT_DECL_FIELDS)}，实为 ${fmt(declFields)}`);
  const extra = declFields.filter((f) => !OFFICIAL_DECL_FIELDS.includes(f));
  check(sortedEq(extra, REPO_DECL_EXTRA),
    `DECL_FIELDS 相对官方 _config 的自扩展字段应恰为 ${fmt(REPO_DECL_EXTRA)}，实为 ${fmt(extra)}`);
}

// ================================================================ §三 行为面

console.log("verify-scenescript-constants: 行为面（真跑 evalTextScript，进程内合成夹具）");

const ENTRY = "export function update() { return 0 }\n";

// -- B1..B4 combo 缺省值 == 首选项（官方语义），显式 value 优先，空 options 不抛
const comboScript = (decl) => `export var scriptProperties = createScriptProperties()
  .addCombo(${decl})
  .finish()
${ENTRY}`;
{
  const sb = runText(comboScript(
    `{ name: 'mode', label: 'Mode', options: [{ label: 'A', value: 0 }, { label: 'B', value: 1 }] }`));
  check(sb && propOf(sb, "mode") === 0,
    `addCombo 省略 value 时缺省值应为首选项 0（官方 baseclasses.js:1443），实为 ${String(propOf(sb, "mode"))}`);

  const sb2 = runText(comboScript(
    `{ name: 'mode', value: 2, options: [{ label: 'A', value: 0 }, { label: 'B', value: 1 }] }`));
  check(sb2 && propOf(sb2, "mode") === 2,
    `addCombo 显式 value 必须优先于首选项，实为 ${String(propOf(sb2, "mode"))}`);

  const sb3 = runText(comboScript(`{ name: 'mode', options: [5, 7] }`));
  check(sb3 && propOf(sb3, "mode") === 5,
    `addCombo 的裸值选项数组也应取首项 5，实为 ${String(propOf(sb3, "mode"))}`);

  const sb4 = runText(comboScript(`{ name: 'mode', options: [] }`));
  check(sb4 && propOf(sb4, "mode") === undefined,
    `addCombo 空 options 应为 undefined 且不得抛错，实为 ${String(propOf(sb4, "mode"))}`);
}

// -- B5 addText/addSlider 不受 combo 分支污染
{
  const sb = runText(`export var scriptProperties = createScriptProperties()
  .addText({ name: 'title', label: 'Title Text' })
  .addSlider({ name: 'speed', label: 'Speed' })
  .addText({ name: 'note', label: 'Note', value: 'hi' })
  .finish()
${ENTRY}`);
  check(sb && propOf(sb, "title") === undefined,
    `addText 省略 value 应为 undefined（options 是标签不是选项），实为 ${String(propOf(sb, "title"))}`);
  check(sb && propOf(sb, "speed") === undefined,
    `addSlider 省略 value 应为 undefined，实为 ${String(propOf(sb, "speed"))}`);
  check(sb && propOf(sb, "note") === "hi",
    `addText 显式 value 应原样保留，实为 ${String(propOf(sb, "note"))}`);
}

// -- B6 scene 值优先于声明缺省
{
  const sb = runText(comboScript(`{ name: 'mode', options: [{ label: 'A', value: 0 }] }`), { mode: 1 });
  check(sb && propOf(sb, "mode") === 1,
    `scene.json 里的属性值必须优先于 combo 声明缺省，实为 ${String(propOf(sb, "mode"))}`);
}

// -- B7..B10 engine.isPortrait / isLandscape（官方 d.ts:2392/2397，方法形态，实时推导）
const FLAG_SCRIPT = "export function update() { return 0 }\n";
{
  const portrait = runText(FLAG_SCRIPT, {}, { screenResolution: { x: 1080, y: 1920 } });
  check(portrait && typeof portrait.engine.isPortrait === "function",
    "engine.isPortrait 必须是方法（官方 d.ts:2392 是方法签名）");
  check(portrait && typeof portrait.engine.isLandscape === "function",
    "engine.isLandscape 必须是方法（官方 d.ts:2397 是方法签名）");
  check(portrait && portrait.engine.isPortrait() === true && portrait.engine.isLandscape() === false,
    `1080x1920 应为竖屏（isPortrait=true / isLandscape=false），实为 ${portrait && portrait.engine.isPortrait()} / ${portrait && portrait.engine.isLandscape()}`);

  const landscape = runText(FLAG_SCRIPT, {}, { screenResolution: { x: 1920, y: 1080 } });
  check(landscape && landscape.engine.isPortrait() === false && landscape.engine.isLandscape() === true,
    "1920x1080 应为横屏（isPortrait=false / isLandscape=true）");

  const square = runText(FLAG_SCRIPT, {}, { screenResolution: { x: 800, y: 800 } });
  check(square && square.engine.isPortrait() === false,
    "宽高相等按横屏处理（isPortrait=false），避免双方都真");

  const live = runText(FLAG_SCRIPT, {}, { screenResolution: { x: 1920, y: 1080 } });
  check(live && live.engine.isPortrait() === false,
    "横屏初值应为 false");
  if (live) {
    live.engine.screenResolution = { x: 500, y: 900 };   // 宿主 resize 就地改写（scene-mount screenRes 回填）
    check(live.engine.isPortrait() === true && live.engine.isLandscape() === false,
      "isPortrait/isLandscape 必须在每次调用时实时读 screenResolution（宿主 resize 后就地改写要立即生效）");
  }
  const noRes = runText(FLAG_SCRIPT, {}, {});
  check(noRes && noRes.engine.isPortrait() === false,
    "缺省 screenResolution 为 1920x1080（横屏），isPortrait 应为 false");
}

// -- B11 MediaPlaybackEvent 注入 + 取值
{
  const shared = {};
  const sb = runText(`shared.stopped = MediaPlaybackEvent.PLAYBACK_STOPPED
shared.playing = MediaPlaybackEvent.PLAYBACK_PLAYING
shared.paused = MediaPlaybackEvent.PLAYBACK_PAUSED
${ENTRY}`, {}, { shared });
  check(sb !== null, "裸用 MediaPlaybackEvent 的脚本必须能进沙箱（不 ReferenceError）");
  check(shared.stopped === 0 && shared.playing === 1 && shared.paused === 2,
    `沙箱里的 MediaPlaybackEvent 应为 0/1/2，实为 ${shared.stopped}/${shared.playing}/${shared.paused}`);
}

// -- B12 官方 3 模块 import 剥除后仍然可用（同名形参绑定）
{
  for (const mod of OFFICIAL_MODULES) {
    const shared = {};
    const sb = runText(`import * as ${mod} from '${mod}'
shared.type = typeof ${mod}
shared.keys = ${mod} && typeof ${mod} === 'object' ? Object.keys(${mod}).length : -1
${ENTRY}`, {}, { shared });
    check(sb !== null, `import * as ${mod} from '${mod}' 的脚本必须能进沙箱`);
    check(shared.type === "object",
      `${mod} 必须是对象（官方 declare module），实为 ${shared.type}`);
    check(shared.keys > 0, `${mod} 必须带成员（实测 ${shared.keys} 个）`);
  }
}

// ================================================================ §三·IScene 面（真跑对象沙箱）
//
// 2026-11-04 回归 2732362906「[Mitsu] Rem - Summer」黑屏（整帧纯黑、fps 照走、无 JS 报错）。
// 该作者的 visible 脚本是全库通行的「层索引表」模板：
//   for (var i = 0; i < thisScene.getLayerCount(); ++i) { … thisScene.getLayer(i).name … }
//   …
//   value = (thisLayer == thisScene.getLayer(arrayIndexesLeftLayers[currentIndexLeft]))
// 官方 IScene（docs.wallpaperengine.io → Scene/SceneScript/reference/class/IScene）：
//   getLayer(name: String|Number) —— "Get a layer by index or custom name."
//   getLayerCount(): Number      —— "Get the total layer count."
// 本仓此前三处缺口叠加 ⇒ 三层 visible 全被脚本写成 false ⇒ 纯黑：
//   ① makeThisScene 没有 getLayerCount()（init 首行 TypeError，索引数组永远为空）
//   ② getLayer 只按名查（数字实参被 String() 成 "0"，撞不到任何层名）
//   ③ thisLayer 与 getLayer 返回**两个不同代理**对象 ⇒ `==` 身份比较恒 false
// 下面的夹具逐字照抄该模板的结构（层名/分支换中性名），跑**真实** evalObjectScript。

console.log("verify-scenescript-constants: IScene 层索引面（真跑对象沙箱）");

{
  const FIXTURE_NAMES = ["Base", "Alt", "Wide"];
  const makeLayers = () => FIXTURE_NAMES.map((name, i) => ({
    id: 10 + i, name, visibleSelf: i === 0, visible: i === 0, destroyed: false,
    origin: [0, 0, 0], scale: [1, 1, 1], localOrigin: [0, 0, 0], localScale: [1, 1, 1],
    localAngles: [0, 0, 0], angles: [0, 0, 0], size: [100, 100], alpha: 1, brightness: 1, effects: [],
  }));
  /** 在「第 layerIndex 层」上跑脚本，返回 { sb, shared, layers } */
  const runOnLayer = (layerIndex, script) => {
    const layers = makeLayers();
    const shared = {};
    const sb = wtext.evalObjectScript(script, null, {
      layer: layers[layerIndex],
      shared,
      userProperties: {},
      canvasSize: { width: 1920, height: 1080 },
      screenResolution: { x: 1920, y: 1080 },
      getSceneLayer: (n) => layers.find((l) => l.name === n) || null,
      enumerateSceneLayers: () => layers.filter((l) => !l.destroyed),
    });
    // 宿主语义：沙箱建好后立刻 init(字段当前值)，再进逐帧 update
    if (sb) sb.init(!!layers[layerIndex].visibleSelf);
    return { sb, shared, layers };
  };

  // 模板脚本：init 建索引表，update 用身份比较判定「我是不是第 0 层」
  const INDEX_SCRIPT = `
var names = [];
export function init(value) {
  shared.count = thisScene.getLayerCount();
  for (var i = 0; i < thisScene.getLayerCount(); ++i) names.push(thisScene.getLayer(i).name);
  shared.names = names;
  shared.byName = thisScene.getLayer("Alt") ? thisScene.getLayer("Alt").name : null;
  shared.outOfRange = thisScene.getLayer(99).name;
  shared.indexSelf = thisScene.getLayerIndex(thisLayer);
  return value;
}
export function update(value) {
  return thisLayer == thisScene.getLayer(0);
}
`;
  const a = runOnLayer(0, INDEX_SCRIPT);
  check(a.sb !== null, "IScene：对象脚本必须能进沙箱（evalObjectScript 返回非 null）");
  check(a.sb && a.sb.errCount === 0,
    `IScene：getLayerCount() / getLayer(数字下标) 不得抛错（errCount=${a.sb && a.sb.errCount}；官方明文支持数字下标）`);
  check(a.shared.count === 3, `IScene：getLayerCount() 应等于活层数 3，实为 ${a.shared.count}`);
  check(Array.isArray(a.shared.names) && a.shared.names.join(",") === FIXTURE_NAMES.join(","),
    `IScene：getLayer(i) 必须按 enumerate 顺序返回第 i 层，实为 ${fmt(a.shared.names)}`);
  check(a.shared.byName === "Alt", `IScene：getLayer(名字) 仍须按名命中，实为 ${fmt(a.shared.byName)}`);
  check(a.shared.outOfRange === "", `IScene：getLayer(越界下标) 回哑代理（name 为空串），实为 ${fmt(a.shared.outOfRange)}`);
  check(a.shared.indexSelf === 0, `IScene：getLayerIndex(thisLayer) 应为 0，实为 ${a.shared.indexSelf}`);
  check(a.sb && a.sb.callUpdate(true) === true,
    "IScene：thisLayer 必须与 getLayer(自身下标) 同一代理身份（`thisLayer == getLayer(0)` 为 true）——"
    + "作者脚本靠这个身份比较决定层是否可见；返回两个不同代理会让整屏层被隐藏（2732362906 黑屏）");
  // 反向对照：第 0 层的 thisLayer 不能等于第 1 层的代理（否则判据变成「恒真」而失去区分力）
  const b = runOnLayer(1, INDEX_SCRIPT);
  check(b.sb && b.sb.callUpdate(true) === false,
    "IScene：第 1 层的 thisLayer 与 getLayer(0) 必须**不**同身份（身份比较要有区分力）");
  // 名字版本的身份也必须一致（作者也写 `thisLayer == getLayer("名字")`）
  const c = runOnLayer(1, `
export function update(value) { return thisLayer == thisScene.getLayer("Alt"); }
`);
  check(c.sb && c.sb.callUpdate(true) === true,
    "IScene：thisLayer 与 getLayer(名字) 必须同一代理身份（同代理缓存口径）");
}

// ================================================================ §三·IScene 按名未命中（issue #19）
//
// 3819697503（CSAV 脚本）的 init 用「变量守卫」枚举子层：
//   while (true) { let child = thisScene.getLayer("EX_HRT_" + i); if (child) {…i++} else break }
// 旧实现按名未命中返回真值代理 ⇒ 永不 break，每轮 push 一个 point，renderer 内存
// 897→2607MB 后崩溃。修复不能简单 return null：本机 426 目录 / 109 张含 getLayer
// 壁纸实测，无条件 null 会让 7 张壁纸新报 TypeError（2902406982 的灯亮度拖拽直接失效）。
// 因此语义分两层：条件型脚本 null；存量「直接写不存在图层」脚本仍拿哑代理 + 运行期
// 连续未命中预算锁存。下面的判据把两层都钉住，并防止把链式访问误判成条件。
console.log("verify-scenescript-constants: IScene 按名未命中（枚举终止 / 守卫 / 兼容写入）");

{
  const FIXTURE_NAMES = ["Base", "EX_HRT_1", "EX_HRT_2", "EX_HRT_3", "Bar2"];
  const makeLayers = () => FIXTURE_NAMES.map((name, i) => ({
    id: 30 + i, name, visibleSelf: true, visible: true, destroyed: false,
    origin: [0, 0, 0], scale: [1, 1, 1], localOrigin: [0, 0, 0], localScale: [1, 1, 1],
    localAngles: [0, 0, 0], angles: [0, 0, 0], size: [100, 100], alpha: 1, brightness: 1, effects: [],
  }));
  const runObj = (script) => {
    const layers = makeLayers();
    const shared = {};
    const sb = wtext.evalObjectScript(script, null, {
      layer: layers[0],
      shared,
      userProperties: {},
      canvasSize: { width: 1920, height: 1080 },
      screenResolution: { x: 1920, y: 1080 },
      getSceneLayer: (n) => layers.find((l) => l.name === n) || null,
      enumerateSceneLayers: () => layers.filter((l) => !l.destroyed),
    });
    if (sb) sb.init(true);
    return { sb, shared, layers };
  };

  // 1) 真实 CSAV 形态：变量守卫的 while(true) 枚举，首个未命中必须 break。
  const csav = runObj(`
function countChildren() {
  let i = 1;
  let n = 0;
  let guard = 0;
  while (true) {
    if (++guard > 1000) break;
    let child = thisScene.getLayer("EX_HRT_" + i);
    if (child) { n++; i++; } else { break; }
  }
  return n;
}
export function init() { shared.loopCount = countChildren(); }
`);
  check(csav.sb && csav.sb.errCount === 0,
    `IScene：3819697503 的变量守卫枚举不得报错（errCount=${csav.sb && csav.sb.errCount}）`);
  check(csav.shared.loopCount === 3,
    `IScene：变量守卫 while(true) 必须在首个未命中处终止（实跑 ${fmt(csav.shared.loopCount)} 次，应为 3）`);

  // 2) 直接 while 条件（含带上限，旧实现跑满上限会变红而不是挂死判据）
  const direct = runObj(`
export function init() {
  var i = 1, n = 0;
  while (i <= 1000 && thisScene.getLayer("EX_HRT_" + i)) { n++; i++; }
  shared.loopCount = n;
}
`);
  check(direct.sb && direct.sb.errCount === 0 && direct.shared.loopCount === 3,
    `IScene：while(getLayer(...)) 必须在首个未命中处终止（实为 ${fmt(direct.shared.loopCount)}，应为 3）`);

  // 3) for 条件 + thisScene['getLayer'] 混淆写法：静态判定也要覆盖。
  const bracket = runObj(`
export function init() {
  var n = 0;
  for (var i = 1; i <= 1000 && thisScene['getLayer']("EX_HRT_" + i); i++) n++;
  shared.loopCount = n;
}
`);
  check(bracket.sb && bracket.sb.errCount === 0 && bracket.shared.loopCount === 3,
    `IScene：for(;getLayer(...);) 与 thisScene['getLayer'] 枚举必须终止（实为 ${fmt(bracket.shared.loopCount)}，应为 3）`);

  // 4) 纯条件守卫：未命中必须为假。
  const guard = runObj(`
export function init() {
  if (thisScene.getLayer("NOPE")) shared.hit = true; else shared.miss = true;
}
`);
  check(guard.shared.miss === true && guard.shared.hit !== true,
    "IScene：if(getLayer(未命中)) 必须为假（旧实现真值代理会误走命中分支）");

  // 5) 存量兼容：不判空直接写不存在的层仍是静默 no-op（CASEBOOK:1096 契约）。
  const write = runObj(`
export function update() {
  thisScene.getLayer("NOPE").visible = false;
  shared.ok = true;
}
`);
  write.sb && write.sb.callUpdate(true);
  check(write.sb && write.sb.errCount === 0 && write.shared.ok === true,
    `IScene：getLayer(未命中).visible 必须仍静默 no-op（errCount=${write.sb && write.sb.errCount}）`);

  // 6) 数字名假阳性回归：Bar1 不存在、Bar2 存在时，直接写 Bar1 仍必须 no-op
  //    （防止把「数字后缀 + 同前缀活层」的枚举启发式重新引入本仓）。
  const numericWrite = runObj(`
export function update() {
  thisScene.getLayer("Bar1").visible = false;
  shared.ok = true;
}
`);
  numericWrite.sb && numericWrite.sb.callUpdate(true);
  check(numericWrite.sb && numericWrite.sb.errCount === 0 && numericWrite.shared.ok === true,
    `IScene：数字名 Bar1 缺失而 Bar2 存活时，直接写仍必须 no-op（不得当成枚举终点）`);

  // 7) 链式访问在条件里也不能被误判为「条件型脚本」：getLayer("NOPE").visible 应走
  //    哑代理（false），不能 TypeError。严格判定只认「结果本身」作条件。
  const chained = runObj(`
export function init() {
  if (thisScene.getLayer("NOPE").visible) shared.hit = true; else shared.miss = true;
}
`);
  check(chained.sb && chained.sb.errCount === 0 && chained.shared.miss === true,
    "IScene：条件里的链式 getLayer(...).visible 不得 TypeError（链式访问仍走哑代理）");

  // 8) 注释/字符串里的“枚举示例”不得把存量脚本误判成严格模式。
  const comment = runObj(`
export function update() {
  /* while (thisScene.getLayer("NOPE")) { } */
  thisScene.getLayer("NOPE").visible = false;
  shared.ok = true;
}
`);
  comment.sb && comment.sb.callUpdate(true);
  check(comment.sb && comment.sb.errCount === 0 && comment.shared.ok === true,
    "IScene：注释里的 getLayer 枚举示例不得改变脚本形态判定");

  // 9) 静态判定漏掉的动态键枚举：连续未命中预算 64 后必须终止并锁存；
  //    第二次入口首轮即 null（否则每帧再写 64 次，内存只是增长变慢）。
  //    预算值只钉「有界 + 锁存」，不钉具体常数（改预算时本判据不应假红）。
  const budget = runObj(`
function countMissing() {
  var n = 0;
  while (n < 10000) {
    var fn = thisScene[String.fromCharCode(103, 101, 116, 76, 97, 121, 101, 114)];
    var child = fn.call(thisScene, "EX_MISS_" + (n + 1));
    if (child) { n++; } else { break; }
  }
  return n;
}
export function init() { shared.first = countMissing(); }
export function update() { shared.second = countMissing(); }
`);
  budget.sb && budget.sb.callUpdate(true);
  check(budget.sb && budget.sb.errCount === 0,
    `IScene：动态键枚举的预算兜底不得报错（errCount=${budget.sb && budget.sb.errCount}）`);
  check(typeof budget.shared.first === "number" && budget.shared.first >= 16 && budget.shared.first <= 256,
    `IScene：动态键枚举必须在有界预算内终止（实跑 ${fmt(budget.shared.first)} 次，应在 16..256）`);
  check(budget.shared.second === 0,
    `IScene：预算触发后必须锁存（第二次入口应 0 次未命中，实为 ${fmt(budget.shared.second)}）`);

  // 10) 数字下标越界仍是哑代理（issue #19 明确要求不动；名字命中语义见上）。
  const index = runObj(`
export function init() {
  shared.outOfRange = thisScene.getLayer(99).name;
  shared.byName = thisScene.getLayer("Base").name;
}
`);
  check(index.shared.outOfRange === "" && index.shared.byName === "Base",
    `IScene：数字越界仍回哑代理（name 应为空串，实为 ${fmt(index.shared.outOfRange)}；按名命中仍须返回真实层）`);

  // 11) 链式访问型脚本即使连续未命中超过预算，也不得切 null（否则 null.prop TypeError）。
  //     2983846453 的混淆 visible 脚本在离线「只给脚本、不给图层表」夹具里 init 实测 108 次
  //     未命中；预算若按 64 就把它打爆（verify-text 的真实回归）。这里用 300 次钉住
  //     「链式访问 → budgetEnabled=false」。
  const chainedMany = runObj(`
export function init() {
  for (var i = 0; i < 300; i++) thisScene.getLayer("CHAIN_MISS_" + i).origin.x = 0;
  shared.ok = true;
}
`);
  check(chainedMany.sb && chainedMany.sb.errCount === 0 && chainedMany.shared.ok === true,
    `IScene：链式访问型脚本连续 300 次未命中也不得 TypeError（errCount=${chainedMany.sb && chainedMany.sb.errCount}）`);
}

// ================================================================ §四 缺口钉住

console.log("verify-scenescript-constants: 已知缺口（现状钉住；补齐后请同步改本判据）");

{
  // destroy / applyGeneralSettings 未派发：官方 IComponent 有，本仓 SCRIPT_ENTRY_NAMES 无。
  const destroyOnly = `export function destroy() { }\n`;
  const cs = wtext.checkSceneScript(destroyOnly);
  check(cs && cs.entries && !cs.entries.includes("destroy"),
    "已知缺口：checkSceneScript 目前不认 destroy（官方 IComponent:72）；若已实现请改本判据");
  check(cs && cs.noEntry === true,
    "已知缺口：只导出 destroy 的脚本当前被判为「无入口」；若已实现请改本判据");
  const sb = runText(destroyOnly, {}, {});
  check(sb === null,
    "已知缺口：只导出 destroy 的脚本当前不建沙箱（evalTextScript 返回 null）；若已实现请改本判据");

  // _config 字段面：本仓 DECL_FIELDS 有 condition（combo 选项条件），官方 addXxx 的 _config 无此键。
  check(EXPECT_DECL_FIELDS.includes("condition"),
    "本仓 DECL_FIELDS 的 condition 是自扩展（官方 _config 无此键），文档须标注");
}

// ================================================================ §五 原生内部名（补证轮钉住）

console.log("verify-scenescript-constants: 原生内部名不得进入公开面（补证轮钉住）");

{
  // 补证轮（task-28）对随包 bin/scenescript64.dll 字符串表的核对（详见
  // docs/re/we-native-scenescript-constants.md §1.3 / §4.2 与 §8.1）：
  //   - cursorHitTest：native 事件名表 0x19a1770 有它，但随包 d.ts 的 IComponent 与编辑器
  //     「插入事件」18 按钮都没有 ⇒ 原生内部命中测试钩子，**不是**公开脚本事件。
  //   - isObjectValid：native 引擎成员表 0x19a14c8 有它，但随包 d.ts 与编辑器 bundle 均 0 命中
  //     ⇒ 原生内部谓词，**不是**公开 API（d.ts 从未声明）。
  // 三处（d.ts / 编辑器 bundle / 本仓）在公开面上都没有它们，所以本仓不得把它们当可用成员
  // 派发或注入。（SCRIPT_ENTRY_NAMES 的逐名逐序判据已经排除了把 cursorHitTest 当入口名。）
  // 若将来官方声明面公开了其中某个名字，请连同本判据与文档一起更新。
  for (const name of ["cursorHitTest", "isObjectValid"]) {
    check(!textSrc.includes(name),
      `原生内部名 ${name} 不得出现在 text.js（官方声明面无此项）；若官方已公开请改本判据`);
  }
}

// ================================================================ 收尾

if (errors.length) {
  console.error(`verify-scenescript-constants: ${errors.length} 项失败`);
  for (const e of errors) console.error("  ✗", e);
  process.exit(1);
}
console.log("verify-scenescript-constants: ok");
