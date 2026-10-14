#!/usr/bin/env node
/**
 * verify-text-script —— 文字对象脚本属性（`text.scriptproperties`）的**编辑侧数据层**判据。
 *
 * 为什么需要它：task-7 要在文字层检视器里给「脚本属性」面板接线（类型感知控件、增删键、
 * 标注「脚本有默认值 / 未写值」、一条动作 = 一步撤销）。面板本身是 UI（走 --headless 判据），
 * 但面板读写的**口径**必须与引擎逐字对齐，否则会出现「面板显示改了、引擎读的还是旧值」或
 * 「编辑一次把作者的 {user,value} 绑定拆掉」这类静默损坏。`editor/text-script-props.ts` 就是
 * 这份口径的**唯一实现**，本脚本是它的离线牙。
 *
 * 引擎读点（本脚本 [B] 段逐条锁住这些行的形状，源码被改就会红）：
 *   - `renderer/vendor/we-scene/scene/parse.js:493`
 *       `textScriptProps: o.text && typeof o.text === 'object' ? (o.text.scriptproperties || null) : null`
 *     ⇒ 属性表键 = `text.scriptproperties`，**全小写、严格大小写、无回退**。
 *   - `renderer/vendor/we-scene/scene/parse.js:490`：`text` 可以是裸字符串或 `{value}` 对象，
 *     升级成对象时必须把原字符串搬进 `.value`（否则文字内容被抹掉）。
 *   - `renderer/vendor/we-scene/render/text.js:808-811` `propValue(v)`：带 `value` 键的对象取
 *     `.value`，其余原样 —— 这是「面板显示值」的口径。
 *   - `renderer/vendor/we-scene/render/text.js:906-925` `defineLiveScriptProp`：带字符串 `user`
 *     的值注册**活 getter**（读用户属性、兜底 `.value`）⇒ 面板只能改 `.value`，动 `user` 就是拆绑定。
 *   - `renderer/vendor/we-scene/render/text.js:992-1001`：`ADD_METHOD_RE = /^add[A-Z]/`（text.js:38）、
 *     `if (!(def.name in spValues))` 才补默认 ⇒ 命中是**严格大小写**的 `in`，面板必须大小写不敏感地
 *     命中原键；同名重复声明只认第一次。
 *   - `renderer/vendor/we-scene/render/text.js:825-833` `declaredDefault`：除 `addCombo` 外缺省值取
 *     `options.value`；`addCombo` 省略 `value` 时取 `options[0].value`。
 *   - `local-assets/scripts/jsclasses/baseclasses.js:1423-1454`：官方只有 addSlider / addCheckbox /
 *     addText / addCombo / addColor 五个方法（`vars[options.name] = options.value`）⇒ 控件类型只能
 *     由这五个方法名判定。
 *
 * 四段判据：
 *   [A] 真模块行为：直接 import `editor/text-script-props.ts`（Node v24 原生剥类型），断言铁律
 *       ①大小写命中 ②包装只改 .value ③值没变返回 false ④不删作者数据，以及面板行/声明解析口径。
 *   [B] 引擎读点锁：上面每条引用在 vendor/官方脚本里的**形状**仍在（行级正则），且本模块的键常量
 *       与 parse.js 的访问表达式一致。
 *   [C] 模块形状锁：纯数据（无 DOM、除 `import type` 外无依赖）、四个铁律注释与引擎行号引用在位、
 *       冻结接口的 6 个字段名逐个在位。
 *   [D] 真语料复核（读本机素材库，没装库就跳过并仍算通过）：全库 `scene.pkg` 里每个带
 *       `text.scriptproperties` 的文字对象 —— 行数/键序与作者数据一一对应、显示值与独立复算的
 *       `propValue` 口径一致、未声明行的 kind 与值的 typeof 一致、无大小写变体容器。
 *   [E] 变异红测（6 个）：把模块源码按真实锚点改坏（大小写不折叠 / 包装裸写 / 没改也返回 true /
 *       删不存在的键也返回 true / 丢掉 addColor 映射 / 升级字符串时抹掉文字值），断言探针**必须转红**，
 *       且红的正是对应那条断言 —— 证明 [A] 有牙而不是恒真。
 *
 * 取证边界：只读本仓源码 + 本机素材库（可缺）。不依赖 GPU / 浏览器 / 网络。
 */
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, LIB, imp, createChecker } from "./lib/verify-kit.mjs";

const ck = createChecker();
let asserted = 0;
const check = (cond, msg) => {
  asserted++;
  ck.check(cond, msg);
};

const M = await imp("editor/text-script-props.ts");
const MODULE_REL = "editor/text-script-props.ts";
const MODULE_SRC = fs.readFileSync(join(ROOT, MODULE_REL), "utf8");
const read = (rel) => fs.readFileSync(join(ROOT, rel), "utf8");
const json = (v) => JSON.stringify(v);
const deep = (a, b) => json(a) === json(b);

// ─────────────── [A] 真模块行为 ───────────────
console.log("[A] editor/text-script-props.ts 行为（铁律 ①②③④ + 面板行 + 声明解析）");

const SCRIPT_FIXTURE = [
  "export var scriptProperties = createScriptProperties()",
  "  .addSlider({ name: 'speed', label: 'Speed', value: 1.5, min: 0, max: 3 })",
  "  .addCheckbox({ name: 'use24h', label: '24h', value: true })",
  "  .addCombo({ name: 'mode', label: 'Mode', options: [ { value: 'a', label: 'A' }, { value: 'b', label: 'B' } ] })",
  "  .addText({ name: 'note', label: 'Note', value: 'hi' })",
  "  .addColor({ name: 'tint', label: 'Tint', value: '0.96 0.96 0.63' })",
  "  .addSlider({ name: 'speed', value: 9 })",
  "  .addSlider({ name: 'computed', value: 1 + 2 })",
  "  .finish();",
].join("\n");

/**
 * 组合框专项夹具：**label 缺省项** + 裸字面量项。
 * engine 依据：baseclasses.js:1441 `options:options.options` 原样交 UI；text.js:826-830 只用 `opts[0].value`
 * 当省略 value 时的默认值 ⇒ 顺序有语义；text.js:829 允许首项是裸字面量。
 */
const COMBO_FIXTURE = [
  "createScriptProperties()",
  "  .addCombo({ name: 'mode', label: 'Mode', options: [ { value: 1 }, { label: 'Two', value: 'two' }, 'three' ] })",
  "  .finish();",
].join("\n");

// A1 冻结接口 + 冻结行形状（task-7 要消费的是这个形状，改了就是破坏契约）
for (const fn of [
  "textScriptPropRows",
  "listTextScriptProps",
  "readTextScriptProp",
  "setTextScriptProp",
  "removeTextScriptProp",
  "declaredTextScriptProps",
  "addableTextScriptProps",
]) {
  check(typeof M[fn] === "function", `冻结接口 ${fn}() 必须导出为函数`);
}
const row = M.textScriptPropRows(
  { text: { scriptproperties: { Mode: { user: "u", value: 0 } } } },
  () => SCRIPT_FIXTURE,
)[0];
const FROZEN_ROW_KEYS = ["key", "kind", "value", "wrapped", "declared", "hasDefault"];
const rowKeys = Object.keys(row ?? {}).sort();
check(
  FROZEN_ROW_KEYS.every((k) => rowKeys.includes(k)) &&
    rowKeys.every((k) => FROZEN_ROW_KEYS.includes(k) || k === "options"),
  `textScriptPropRows 的行形状必须冻结为 {${FROZEN_ROW_KEYS.join(",")}} + 可选 options（实得 ${json(rowKeys)}）`,
);
// 该行的键是 Mode（大小写不同但唯一命中声明 mode）⇒ 它是 declared 的 combo 行，必须带 source 顺序的选项
check(
  json(row?.options?.map((o) => o.value)) === json(["a", "b"]) &&
    row?.options?.[0]?.label === "A" &&
    row?.options?.[1]?.label === "B",
  `declared 的 combo 行必须带脚本 options（source 顺序；实得 ${json(row?.options)}）`,
);
check(M.TEXT_SCRIPT_PROPS_KEY === "scriptproperties", "属性表键常量必须是 parse.js:493 的小写字面量 scriptproperties");

// A2 行模型：原键名/原序、包装标记、kind 判定、与声明的合并
const rowsObj = {
  text: {
    scriptproperties: {
      ModeX: { user: "u1", value: "b" },
      "USE-24H": true,
      alpha: 0.5,
      noteX: "hi",
      weird: null,
    },
  },
};
const rows = M.textScriptPropRows(rowsObj, () => SCRIPT_FIXTURE);
check(
  json(rows.map((r) => r.key)) === json(["ModeX", "USE-24H", "alpha", "noteX", "weird"]),
  `行序与键名必须保持作者原样（实得 ${json(rows.map((r) => r.key))}）`,
);
check(rows[0].wrapped === true && rows[0].value === "b" && rows[0].kind === "string", "包装行的值取 .value（propValue 口径）、标 wrapped；未声明时按值推断 kind=string");
check(rows[1].wrapped === false && rows[1].kind === "bool" && rows[2].kind === "number" && rows[3].kind === "string" && rows[4].kind === "unknown", "未声明行按值的 typeof 推断 kind（bool/number/string/null→unknown）");
check(rows.every((r) => r.declared === false && r.hasDefault === false), "脚本没声明的键 declared/hasDefault 必须为 false（不猜）");
const declaredRows = M.textScriptPropRows(
  { text: { scriptproperties: { speed: 2.5, note: { user: "n", value: "x" }, extra: 1, Mode: 1 } } },
  () => SCRIPT_FIXTURE,
);
check(
  declaredRows[0].declared === true && declaredRows[0].hasDefault === true && declaredRows[0].kind === "number",
  "已声明行必须带 declared/hasDefault=true 与声明类型（面板据此标「脚本有默认值」）",
);
check(declaredRows[1].wrapped === true && declaredRows[1].declared === true, "声明 + 包装并存时两个标记都要在");
check(declaredRows[3].declared === true && declaredRows[3].kind === "combo", "大小写不同但唯一命中声明（Mode↔mode）时必须认作已声明，且 combo 行判 combo");
check(declaredRows[2].declared === false, "脚本没声明的键 declared=false");
check(M.textScriptPropRows({ text: { value: "x" } }).length === 0, "没有属性表时行模型为空数组");
check(json(M.textScriptPropRows(null)) === "[]", "obj 为 null 时行模型为空数组（不抛）");

// A3 引擎读值口径（text.js:808）
check(M.textScriptPropValue({ user: "u", value: 7 }) === 7, "textScriptPropValue：具 value 键的对象取 .value");
check(M.textScriptPropValue({ a: 1 }).a === 1, "textScriptPropValue：没有 value 键的对象原样返回");
check(M.textScriptPropValue(null) === null && M.textScriptPropValue(false) === false, "textScriptPropValue：null/布尔原样返回");

// A4 写：规则①（大小写命中原键、不新建重复键）
const w = { text: { script: "s", scriptproperties: { Mode: { user: "u1", value: 0 }, bare: 1 } } };
check(M.setTextScriptProp(w, "BARE", 2) === true, "写已存在的键（大小写不同）必须返回 true");
check(json(Object.keys(w.text.scriptproperties)) === json(["Mode", "bare"]), `大小写不敏感必须命中原键、不得新建重复键（实得 ${json(Object.keys(w.text.scriptproperties))}）`);
check(w.text.scriptproperties.bare === 2, "大小写不同的写入必须落在原键上");
// 规则②（包装只改 .value）
check(M.setTextScriptProp(w, "mode", 5) === true && w.text.scriptproperties.Mode.value === 5, "包装键写入必须改 .value");
check(
  json(Object.keys(w.text.scriptproperties.Mode)) === json(["user", "value"]) && w.text.scriptproperties.Mode.user === "u1",
  `包装只改 .value：user 键必须原样保留且不新增键（实得 ${json(w.text.scriptproperties.Mode)}）`,
);
const sc = { text: { scriptproperties: { k: { script: "export function update(){return 1;}", value: 0 } } } };
check(M.setTextScriptProp(sc, "K", 3) === true && sc.text.scriptproperties.k.script.startsWith("export"), "带 script 的包装同样只改 .value、保留 script 源码");
// 规则③（值没变返回 false）
check(M.setTextScriptProp(w, "bare", 2) === false, "裸值没变必须返回 false（不产生空撤销步）");
check(M.setTextScriptProp(w, "MODE", 5) === false, "包装 .value 没变必须返回 false");
check(M.setTextScriptProp(w, "bare", 2.0) === false, "同值不同类型仍相等（2 与 2.0）必须返回 false");
check(deep(w.text.scriptproperties.Mode, { user: "u1", value: 5 }), "返回 false 的路径不得改动对象");
// 新键 + text 是裸字符串的升级路径
const n1 = { text: { script: "s", scriptproperties: {} } };
check(M.setTextScriptProp(n1, "New", 3) === true && n1.text.scriptproperties.New === 3, "写不存在的键必须新建（面板「添加键」路径）");
const n2 = { text: "hello" };
check(M.setTextScriptProp(n2, "k", 1) === true, "text 是裸字符串时允许升级成对象（能承载属性表的合法路径）");
check(n2.text.value === "hello", "升级必须把原字符串搬进 .value（parse.js:490：否则文字内容被抹掉）");
check(n2.text.scriptproperties.k === 1, "升级后属性表必须落在小写 scriptproperties 上");
// 不能凭空造 text：parse.js:496 isText = o.text !== undefined → 会把非文字对象变成文字对象
const n3 = { origin: "0 0 0" };
check(M.setTextScriptProp(n3, "k", 1) === false && n3.text === undefined, "对象没有 text 字段时必须拒绝写入（造出 text 会改变图层种类）");
check(M.setTextScriptProp({ text: 42 }, "k", 1) === false, "text 既不是字符串也不是对象时必须拒绝写入");
check(M.setTextScriptProp(null, "k", 1) === false && M.setTextScriptProp(w, "", 1) === false, "obj 为 null / 键为空必须拒绝写入");

// A5 删：规则④（只有真存在才返回 true）
const r1 = { text: { scriptproperties: { A: 1, b: { user: "u", value: 2 } } } };
check(M.removeTextScriptProp(r1, "a") === true, "删已存在的键（大小写不同）必须返回 true");
check(json(Object.keys(r1.text.scriptproperties)) === json(["b"]), "只删命中那一个键，别的属性不动");
check(M.removeTextScriptProp(r1, "A") === false && M.removeTextScriptProp(r1, "ghost") === false, "删不存在的键必须返回 false（不许谎报撤销步）");
check(M.removeTextScriptProp({ text: "s" }, "x") === false && M.removeTextScriptProp(null, "x") === false, "没有属性表时删除返回 false（且不建表）");
check(r1.text.scriptproperties.b.user === "u", "删除别的键不得碰包装对象");

// A6 声明解析：五个官方方法 → 控件类型；combo 取 options[0].value；同名只认第一次
const decls = M.declaredTextScriptProps(SCRIPT_FIXTURE);
check(
  json(decls.map((d) => `${d.name}:${d.method}:${d.kind}`)) ===
    json([
      "speed:addSlider:number",
      "use24h:addCheckbox:bool",
      "mode:addCombo:combo",
      "note:addText:string",
      "tint:addColor:color",
      "computed:addSlider:number",
    ]),
  `声明解析必须保序、按官方五方法判型、同名只认第一次（实得 ${json(decls.map((d) => d.name))}）`,
);
check(decls[0].hasDefault === true && decls[0].defaultValue === 1.5, "addSlider 写了 value → 默认值就是它（text.js:832）");
check(decls[2].hasDefault === true && decls[2].defaultValue === "a", "addCombo 省略 value → 默认值取 options[0].value（text.js:826-830）");
check(decls[3].defaultValue === "hi" && decls[4].defaultValue === "0.96 0.96 0.63", "addText/addColor 的默认值按字面量取");
check(decls[5].hasDefault === true && decls[5].defaultValue === undefined, "value 是表达式 → hasDefault=true 但 default 未知（不许猜值）");
const noValue = M.declaredTextScriptProps("createScriptProperties().addSlider({ name: 'x', label: 'X' }).finish();");
check(noValue.length === 1 && noValue[0].hasDefault === false && noValue[0].defaultValue === undefined, "addSlider 没写 value → 没有默认值（text.js:832 propValue(undefined)）");
const primCombo = M.declaredTextScriptProps("createScriptProperties().addCombo({ name: 'c', options: [1, 2] }).finish();");
check(primCombo[0].hasDefault === true && primCombo[0].defaultValue === 1, "addCombo 首项是裸字面量时默认值取它本身（text.js:829）");
const noOpts = M.declaredTextScriptProps("createScriptProperties().addCombo({ name: 'c' }).finish();");
check(noOpts[0].hasDefault === false, "addCombo 没有 options → 没有默认值");
// 注释/字符串里的 add* 不得被当成声明；括号不平衡不得抛
const tricky = [
  "// .addSlider({ name: 'ghost', value: 1 })",
  "var s = \"addColor({ name: 'ghost2', value: 'x' })\";",
  "/* .addText({ name: 'ghost3', value: 'x' }) */",
  "export var p = createScriptProperties().addCheckbox({ name: 'ok', value: false }).finish();",
].join("\n");
const trickyDecls = M.declaredTextScriptProps(tricky);
check(
  json(trickyDecls.map((d) => d.name)) === json(["ok"]),
  `注释/字符串里的 add* 不得产生声明（实得 ${json(trickyDecls.map((d) => d.name))}）`,
);
let unbalanced = null;
try {
  unbalanced = M.declaredTextScriptProps("createScriptProperties().addSlider({ name: 'x', value: 1");
} catch (e) {
  unbalanced = `THROW:${e && e.message}`;
}
check(Array.isArray(unbalanced) && unbalanced.length === 0, `括号不平衡必须安全跳过且返回数组（实得 ${json(unbalanced)}）`);
check(json(M.declaredTextScriptProps("createScriptProperties().addSlider({ value: 1 }).finish();")) === "[]", "name 不是字符串字面量的声明必须跳过（不猜）");
check(json(M.declaredTextScriptProps(null)) === "[]" && json(M.declaredTextScriptProps("")) === "[]", "空/非字符串源码返回空数组");

// A6b addCombo 的 options（面板下拉）：source 顺序 + label 缺省不造空串 + 裸字面量项
const comboDecl = M.declaredTextScriptProps(COMBO_FIXTURE)[0];
check(comboDecl?.kind === "combo" && comboDecl?.method === "addCombo", "addCombo 声明必须判 kind=combo");
check(
  json(comboDecl?.options?.map((o) => o.value)) === json([1, "two", "three"]),
  `options 必须与源码顺序一致（含裸字面量项；实得 ${json(comboDecl?.options?.map((o) => o.value))}）`,
);
check(
  comboDecl?.options?.[0]?.label === undefined &&
    !Object.prototype.hasOwnProperty.call(comboDecl?.options?.[0] ?? {}, "label") &&
    comboDecl?.options?.[1]?.label === "Two" &&
    comboDecl?.options?.[2]?.label === undefined,
  `label 缺省的项不得造空串（实得 ${json(comboDecl?.options)}）`,
);
check(comboDecl?.defaultValue === 1 && comboDecl?.hasDefault === true, "addCombo 省略 value 时默认值取 options[0].value（text.js:826-830）");
const noOptCombo = M.declaredTextScriptProps("createScriptProperties().addCombo({ name: 'c', value: 'x' }).finish();")[0];
check(noOptCombo?.kind === "combo" && noOptCombo?.options === undefined, "写了 value 但没写 options：kind 仍是 combo、不带 options 字段");

// A6c 行模型的 options 只给 declared 行；off-list 当前值**不做任何收敛**（往返不变）
const offObj = { text: { script: "s", scriptproperties: { mode: "zzz", other: 1 } } };
const offRows = M.textScriptPropRows(offObj, () => COMBO_FIXTURE);
check(offRows[0]?.kind === "combo" && json(offRows[0]?.options?.map((o) => o.value)) === json([1, "two", "three"]), "declared 的 combo 行必须带 options（panel 下拉用）");
check(offRows[0]?.value === "zzz", `值不在 options 里时必须原样保留（数据层不收敛；实得 ${json(offRows[0]?.value)}）`);
check(!("options" in (offRows[1] ?? {})), "未声明的行不得带 options（没有可信选项表）");
check(
  M.setTextScriptProp(offObj, "mode", "zzz2") === true && offObj.text.scriptproperties.mode === "zzz2",
  "off-list 值必须能原样写入（不得被强制收敛到 options[0]）",
);
check(json(M.listTextScriptProps(offObj).map((p) => p.value)) === json(["zzz2", 1]), "off-list 写入后属性表仍只有作者的键、值未被替换");

// A7 可加键（面板的「添加」入口）
const addObj = { text: { scriptproperties: { Speed: 1 } } };
check(
  json(M.addableTextScriptProps(addObj, () => SCRIPT_FIXTURE)) === json(["use24h", "mode", "note", "tint", "computed"]),
  `addable 必须排除已写键（含大小写不同的 Speed）并保持声明序（实得 ${json(M.addableTextScriptProps(addObj, () => SCRIPT_FIXTURE))}）`,
);
check(json(M.addableTextScriptProps({ text: { scriptproperties: {} } })) === "[]", "没有脚本源码时没有可加键");
check(json(M.addableTextScriptProps(null, () => SCRIPT_FIXTURE)) === "[]", "obj 为 null 时没有可加键");

// A8 大小写变体容器：引擎只认小写，我们只写小写，且绝不碰作者的变体键
const variant = { text: { ScriptProperties: { a: 1 } } };
check(M.textScriptPropsVariantKey(variant) === "ScriptProperties", "作者写成 ScriptProperties 时必须能报出变体键名（面板提示用）");
check(M.textScriptPropsVariantKey({ text: { scriptproperties: {} } }) === null, "小写键在位时没有变体键");
check(M.textScriptPropsTable(variant) === null, "引擎口径下大小写变体不算属性表（parse.js:493 严格小写）");
check(M.setTextScriptProp(variant, "b", 2) === true, "变体容器存在时写值仍走小写键");
check(deep(variant.text.ScriptProperties, { a: 1 }) && variant.text.scriptproperties.b === 2, "写值必须另建小写键、作者的变体键一字不动");

// ─────────────── [B] 引擎读点锁 ───────────────
console.log("\n[B] 引擎读点锁（vendor/官方脚本的形状仍在）");
const parseJs = read("renderer/vendor/we-scene/scene/parse.js");
const textJs = read("renderer/vendor/we-scene/render/text.js");
const baseJs = read("local-assets/scripts/jsclasses/baseclasses.js");

check(
  /o\.text\s*&&\s*typeof o\.text === 'object'\s*\?\s*\(o\.text\.scriptproperties \|\| null\)/.test(parseJs),
  "parse.js 必须仍在读 `o.text.scriptproperties`（严格小写、|| null）——属性表键的依据",
);
check(
  /text:\s*typeof o\.text === 'string'\s*\?\s*o\.text\s*:\s*\(o\.text\s*&&\s*typeof o\.text === 'object'\s*\?\s*o\.text\.value\s*:\s*null\)/.test(parseJs),
  "parse.js 必须仍是「裸字符串 / {value} 对象」两种文字值写法——升级字符串时要搬 .value 的依据",
);
check(
  /function propValue\(v\)\s*\{\s*if \(v !== null && typeof v === 'object' && 'value' in v\) return v\.value/.test(textJs),
  "text.js:808 propValue 的形状必须不变（面板显示值口径）",
);
check(
  /function declaredDefault\(methodName, def\)\s*\{\s*if \(methodName === 'addCombo' && def\.value === undefined\)/.test(textJs),
  "text.js:825 declaredDefault 的 addCombo 例外必须不变（combo 默认值口径）",
);
check(/const ADD_METHOD_RE = \/\^add\[A-Z\]\//.test(textJs), "text.js:38 ADD_METHOD_RE 必须是 /^add[A-Z]/（声明方法判定）");
check(/if \(!\(def\.name in spValues\)\)/.test(textJs), "text.js:994 必须仍是严格大小写的 `def.name in spValues`（大小写命中原键的依据）");
check(/typeof v\.user === 'string'/.test(textJs), "text.js:906 附近仍按 `typeof v.user === 'string'` 注册活绑定（包装只改 .value 的依据）");
const baseMethods = [...baseJs.matchAll(/add(Slider|Checkbox|Text|Combo|Color):\s*function/g)].map((m) => m[1]);
check(
  json([...baseMethods].sort()) === json(["Checkbox", "Color", "Combo", "Slider", "Text"]),
  `baseclasses.js:1423-1454 必须仍只有官方五个 add* 方法（实得 ${json(baseMethods)}）`,
);
check(/vars\[options\.name\] = options\.value;/.test(baseJs), "baseclasses.js 的 add* 仍是 `vars[options.name] = options.value`（默认值口径）");
check(/vars\[options\.name\] = options\.options\[0\]\.value;/.test(baseJs), "baseclasses.js 的 addCombo 仍是 `options.options[0].value`");
// 我们的常量必须与引擎的访问表达式是同一个小写字面量
const engineKey = /o\.text\.(scriptproperties)/.exec(parseJs);
check(engineKey !== null && engineKey[1] === M.TEXT_SCRIPT_PROPS_KEY, `模块的键常量必须等于 parse.js 实际访问的键（实得 ${engineKey?.[1]} vs ${M.TEXT_SCRIPT_PROPS_KEY}）`);

// ─────────────── [C] 模块形状锁 ───────────────
console.log("\n[C] editor/text-script-props.ts 形状锁（纯数据层 + 引擎读点注释在位）");
const importLines = MODULE_SRC.split("\n").filter((l) => /^\s*import\b/.test(l));
check(importLines.length === 1 && /^import type \{[^}]*SceneObject[^}]*\} from "\.\/doc";$/.test(importLines[0].trim()), `模块只允许一个类型导入（实得 ${json(importLines)}）`);
check(!/\bdocument\s*\.|\bwindow\s*\.|querySelector|addEventListener|createElement\b/.test(MODULE_SRC), "数据层不得出现 DOM 访问");
check(!/from "\.\.?\/.*(renderer|main|i18n)/.test(MODULE_SRC), "数据层不得依赖渲染层 / main.ts / i18n");
for (const cite of ["parse.js:493", "parse.js:490", "text.js:808", "text.js:994", "baseclasses.js:1423"]) {
  check(MODULE_SRC.includes(cite), `模块必须保留引擎读点引用 ${cite}（改动口径时要能对上引擎行）`);
}
for (const rule of ["①", "②", "③", "④"]) {
  check(MODULE_SRC.includes(rule), `模块必须保留铁律 ${rule} 的说明`);
}
// 冻结的 kind 联合：task-7 按 kind 选控件，少一个分支就会掉控件
check(
  /export type TextScriptPropKind = "number" \| "bool" \| "string" \| "color" \| "combo" \| "unknown";/.test(MODULE_SRC),
  "冻结的 kind 联合必须恰好是 number|bool|string|color|combo|unknown（Lead 拍板的扩形状）",
);
check(
  /options\?: TextScriptPropOption\[\];/.test(MODULE_SRC) && /export interface TextScriptPropOption/.test(MODULE_SRC),
  "冻结扩形状必须带 TextScriptPropOption + 可选 options（declared 行/声明两处）",
);

// ─────────────── [D] 真语料复核 ───────────────
console.log("\n[D] 真语料复核（本机素材库 scene.pkg，缺库跳过）");
let corpus = { pkgs: 0, textObjs: 0, withProps: 0, entries: 0, variants: 0, declaredRows: 0 };
if (!fs.existsSync(LIB)) {
  console.log(`  · 素材库不存在（${LIB}），跳过语料段`);
} else {
  const { parsePkg, getEntry } = await imp("renderer/vendor/we-scene/pkg/container.js");
  /** 独立复算引擎口径（不复用被测模块的 helper，避免自证） */
  const engineView = (v) => (v !== null && typeof v === "object" && "value" in v ? v.value : v);
  const walk = (objs, fn) => {
    if (!Array.isArray(objs)) return;
    for (const o of objs) {
      if (o && typeof o === "object") {
        fn(o);
        walk(o.children ?? o.objects, fn);
      }
    }
  };
  for (const item of fs.readdirSync(LIB)) {
    const pkgPath = join(LIB, item, "scene.pkg");
    if (!fs.existsSync(pkgPath)) continue;
    let sj;
    try {
      sj = JSON.parse(Buffer.from(getEntry(parsePkg(fs.readFileSync(pkgPath)), "scene.json")).toString("utf8").replace(/^﻿/, ""));
    } catch {
      continue;
    }
    corpus.pkgs++;
    walk(sj.objects, (o) => {
      const t = o.text;
      if (!t || typeof t !== "object" || Array.isArray(t)) return;
      corpus.textObjs++;
      for (const k of Object.keys(t)) if (k !== "scriptproperties" && k.toLowerCase() === "scriptproperties") corpus.variants++;
      const table = t.scriptproperties;
      if (!table || typeof table !== "object" || Array.isArray(table)) return;
      corpus.withProps++;
      const entries = Object.entries(table);
      corpus.entries += entries.length;
      const script = typeof t.script === "string" ? t.script : null;
      const rowList = M.textScriptPropRows(o, () => script);
      check(rowList.length === entries.length, `${item}: 行数必须等于作者属性条数（${rowList.length} vs ${entries.length}）`);
      check(json(rowList.map((r) => r.key)) === json(entries.map(([k]) => k)), `${item}: 行必须保持作者键序与原名大小写`);
      const written = new Set(entries.map(([k]) => k.toLowerCase()));
      const addable = M.addableTextScriptProps(o, () => script);
      check(addable.every((n) => !written.has(n.toLowerCase())), `${item}: 可加键不得与已写键重复（大小写不敏感）：${json(addable)}`);
      for (let i = 0; i < entries.length; i++) {
        const [k, raw] = entries[i];
        check(deep(rowList[i].value, engineView(raw)), `${item}/${k}: 行显示值必须等于引擎 propValue 口径（${json(rowList[i].value)} vs ${json(engineView(raw))}）`);
        check(rowList[i].wrapped === (raw !== null && typeof raw === "object" && ("value" in raw || "user" in raw || typeof raw.script === "string")), `${item}/${k}: wrapped 标记必须与包装形状一致`);
        if (!rowList[i].declared) {
          const v = engineView(raw);
          const want = typeof v === "number" ? "number" : typeof v === "boolean" ? "bool" : typeof v === "string" ? "string" : "unknown";
          check(rowList[i].kind === want, `${item}/${k}: 未声明行的 kind 必须由值推断（${rowList[i].kind} 应为 ${want}）`);
        } else if (rowList[i].declared) {
          corpus.declaredRows++;
        }
        // 铁律③：在深拷贝上「写回原值」必须返回 false（对全库每个键都验一次）
        const clone = JSON.parse(JSON.stringify(table));
        const box = { text: { scriptproperties: clone } };
        check(M.setTextScriptProp(box, k, clone[k]) === false && deep(box.text.scriptproperties, table), `${item}/${k}: 写回原值必须返回 false 且不改动数据`);
      }
      // 铁律④：删一个不存在的键必须 false，且真删后条数 -1
      const box2 = { text: { scriptproperties: JSON.parse(JSON.stringify(table)) } };
      check(M.removeTextScriptProp(box2, "\u0000ghost") === false, `${item}: 删不存在的键必须返回 false`);
      if (entries.length) {
        const first = entries[0][0];
        check(M.removeTextScriptProp(box2, first) === true && Object.keys(box2.text.scriptproperties).length === entries.length - 1, `${item}: 删存在的键必须成功且只少一条`);
      }
    });
  }
  console.log(
    `  · 语料统计：${corpus.pkgs} 个 scene.pkg / ${corpus.textObjs} 个文字对象 / ${corpus.withProps} 个带 scriptproperties / ${corpus.entries} 条属性 / 大小写变体容器 ${corpus.variants} / 命中声明的行 ${corpus.declaredRows}`,
  );
  check(corpus.pkgs > 0 && corpus.withProps > 0 && corpus.entries > 0, "语料里必须真的能读到 scriptproperties（否则本段没有复核到东西）");
}

// ─────────────── [E] 变异红测 ───────────────
console.log("\n[E] 变异红测（改坏模块源码 → 对应探针必须转红）");

/** 探针：返回「不满足的断言」清单。全绿 = []。变异后必须非空，且包含 expect 片段。 */
function probeCore(mod) {
  const bad = [];
  const obj = { text: { script: "s", scriptproperties: { Mode: { user: "u1", value: 0 }, bare: 1 } } };
  if (mod.setTextScriptProp(obj, "MODE", 1) !== true) bad.push("write-cased: 大小写不同的写入必须成功");
  const t = obj.text.scriptproperties;
  if (Object.keys(t).length !== 2 || !("Mode" in t)) bad.push("write-cased: 必须命中原键 Mode，不得新建重复键（" + JSON.stringify(Object.keys(t)) + "）");
  if (t.Mode.user !== "u1") bad.push("wrapper: 包装的 user 键必须保留");
  if (json(Object.keys(t.Mode)) !== json(["user", "value"])) bad.push("wrapper: 包装只允许改 .value");
  if (t.Mode.value !== 1) bad.push("wrapper: 写入必须落在 .value 上");
  if (mod.setTextScriptProp(obj, "mode", 1) !== false) bad.push("noop: 值没变必须返回 false");
  if (mod.setTextScriptProp(obj, "bare", 1) !== false) bad.push("noop-bare: 裸值没变必须返回 false");
  if (mod.removeTextScriptProp(obj, "ghost") !== false) bad.push("remove-ghost: 删不存在的键必须返回 false");
  const strObj = { text: "hello" };
  if (mod.setTextScriptProp(strObj, "k", 1) !== true) bad.push("upgrade: 裸字符串必须能升级成对象");
  if (!strObj.text || strObj.text.value !== "hello") bad.push("upgrade: 升级时必须保留原文字值");
  const d = mod.declaredTextScriptProps("createScriptProperties().addColor({ name: 'c', value: '1 1 1' }).finish();");
  if (!(d.length === 1 && d[0].kind === "color")) bad.push("decl-kind: addColor 必须映射到 color");
  // combo 选项表：source 顺序 + label 缺省不造空串
  const cd = mod.declaredTextScriptProps(COMBO_FIXTURE)[0];
  if (!(cd && cd.kind === "combo")) bad.push("combo-kind: addCombo 必须判 combo");
  if (json(cd && cd.options && cd.options.map((o) => o.value)) !== json([1, "two", "three"]))
    bad.push("combo-options: options 必须与源码顺序一致");
  if (!(cd && cd.options && cd.options[0] && !("label" in cd.options[0]) && cd.options[1] && cd.options[1].label === "Two"))
    bad.push("combo-options: label 缺省项不得造空串");
  // off-list 当前值：行模型原样保留，且写入不被收敛
  const offObj = { text: { script: "s", scriptproperties: { mode: "zzz", other: 1 } } };
  const offRows = mod.textScriptPropRows(offObj, () => COMBO_FIXTURE);
  if (offRows[0]?.value !== "zzz") bad.push("combo-offlist: off-list 值必须原样保留");
  if ("options" in (offRows[1] ?? {})) bad.push("combo-options: 未声明行不得带 options");
  if (mod.setTextScriptProp(offObj, "mode", "zzz2") !== true || offObj.text.scriptproperties.mode !== "zzz2")
    bad.push("combo-offlist: off-list 值必须能原样写入");
  if (mod.TEXT_SCRIPT_PROPS_KEY !== "scriptproperties") bad.push("key-const: 键常量必须是小写 scriptproperties");
  return bad;
}

const tmpRoot = fs.mkdtempSync(join(os.tmpdir(), "verify-text-script-"));
let mutSeq = 0;
async function importMutated(source, label) {
  mutSeq++;
  const p = join(tmpRoot, `mut-${mutSeq}-${label.replace(/[^a-z0-9]+/gi, "-")}.ts`);
  fs.writeFileSync(p, source, "utf8");
  try {
    return await import(pathToFileURL(p).href);
  } finally {
    fs.unlinkSync(p);
  }
}

const green = probeCore(M);
check(green.length === 0, `[E] 未变异模块必须探针全绿（否则红测无意义）：${green.join(" / ")}`);

const MUTATIONS = [
  {
    label: "大小写不再折叠",
    from: "const want = key.toLowerCase();\n  for (const k of Object.keys(table))",
    to: "const want = key;\n  for (const k of Object.keys(table))",
    expect: "write-cased",
    why: "规则①失效：写 MODE 会另起一个新键，作者的 Mode 读不到",
  },
  {
    label: "包装裸写（丢 user 绑定）",
    from: "    cur.value = next;\n    return true;",
    to: "    table[real] = next;\n    return true;",
    expect: "wrapper",
    why: "规则②失效：{user,value} 被整体替换，活绑定被拆",
  },
  {
    label: "包装没改也返回 true",
    from: 'if (Object.prototype.hasOwnProperty.call(cur, "value") && sameValue(cur.value, next)) return false;',
    to: 'if (false && Object.prototype.hasOwnProperty.call(cur, "value") && sameValue(cur.value, next)) return false;',
    expect: "noop",
    why: "规则③失效（包装分支）：同一动作会多记一步撤销",
  },
  {
    label: "裸值没改也返回 true",
    from: "if (sameValue(cur, next)) return false;",
    to: "if (false && sameValue(cur, next)) return false;",
    expect: "noop-bare",
    why: "规则③失效（裸值分支）：同一动作会多记一步撤销",
  },
  {
    label: "删不存在的键也返回 true",
    from: "if (!table || real === null) return false;",
    to: "if (!table) return false;",
    expect: "remove-ghost",
    why: "规则④失效：删除键的撤销步凭空产生",
  },
  {
    label: "丢掉 addColor 类型映射",
    from: '  addColor: "color",\n',
    to: "",
    expect: "decl-kind",
    why: "颜色属性退化成 unknown，面板给不出颜色控件",
  },
  {
    label: "删掉 addCombo 的 options 解析",
    from: '      const opts = parseOptionsList(topLevelValueText(lit.body, "options"));',
    to: "      const opts = [];",
    expect: "combo-options",
    why: "选项表丢了：面板对 combo 只能给文本框，且源码里声明的选项可见性消失",
  },
  {
    label: "升级裸字符串时抹掉文字值",
    from: "const next: Record<string, unknown> = { value: cur, [TEXT_SCRIPT_PROPS_KEY]: {} };",
    to: "const next: Record<string, unknown> = { [TEXT_SCRIPT_PROPS_KEY]: {} };",
    expect: "upgrade",
    why: "parse.js:490 的文字值被丢：面板一改属性，文字内容消失",
  },
];

let mutRed = 0;
for (const mut of MUTATIONS) {
  if (!MODULE_SRC.includes(mut.from)) {
    check(false, `变异「${mut.label}」找不到锚点 \`${mut.from.slice(0, 60)}\`（源码形状变了，本判据要同步改，不许静默跳过）`);
    continue;
  }
  const mutated = MODULE_SRC.replace(mut.from, mut.to);
  check(mutated !== MODULE_SRC, `变异「${mut.label}」必须真的改到源码`);
  let bad;
  try {
    const MM = await importMutated(mutated, mut.label);
    bad = probeCore(MM);
  } catch (e) {
    check(false, `变异「${mut.label}」求值失败：${String(e && e.message).slice(0, 120)}`);
    continue;
  }
  const red = bad.length > 0;
  check(red, `变异「${mut.label}」必须让探针转红，但探针仍全绿（${mut.why}）`);
  check(
    !red || bad.some((m) => m.includes(mut.expect)),
    `变异「${mut.label}」红的必须是目标断言 ${mut.expect}（实得 ${json(bad)}）`,
  );
  if (red) mutRed++;
  console.log(`  · 变异「${mut.label}」→ ${red ? "红 ✓" : "绿 ✗"} ${json(bad)}`);
}
check(MUTATIONS.length >= 3, `变异红测必须 >= 3 个（实得 ${MUTATIONS.length}）`);
check(mutRed === MUTATIONS.length, `全部变异都必须转红（${mutRed}/${MUTATIONS.length}）`);
fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log(
  ck.errors.length === 0
    ? `\nverify-text-script: 全部通过 ✓（${asserted} 项断言，${MUTATIONS.length} 个变异全部先红后绿）`
    : `\nverify-text-script: ${ck.errors.length}/${asserted} 项失败 ✗`,
);
if (ck.errors.length) for (const e of ck.errors.slice(0, 40)) console.log("  ✗ " + e);
process.exit(ck.errors.length === 0 ? 0 : 1);
