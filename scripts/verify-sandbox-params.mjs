#!/usr/bin/env node
/**
 * SCENESCRIPT P1-3 门禁：脚本沙箱形参表「单一真源 + 顺序即数据」。
 *
 * 背景：`render/text.js` 里曾有四份手抄的沙箱形参清单 ——
 *   ① `SANDBOX_PARAM_NAMES`（同时被 `SANDBOX_PARAM_DECL_RE` 用来生成「顶层同名
 *      var/let/const 降级为赋值」的名字串）；
 *   ② `evalTextScript` 的 `new Function(...)` 形参串；
 *   ③ `evalTextScript` 的 `factory(...)` 实参串；
 *   ④ `evalObjectScript` 的 ②③。
 * 历史上失同步产生过 44% 脚本 SyntaxError 事故；本轮实测到的真缺陷是**文字沙箱
 * 形参表缺 `thisObject`** ⇒ 任何顶层 `var thisObject` 的文字脚本被 DECL_RE 剥成
 * 对未声明标识符的赋值，严格模式下 ReferenceError，`evalTextScript` 返回 null，
 * 而 `checkSceneScript`（用 42 形参的 compileSandboxBody 编译）还说 ok。
 *
 * 本门禁四节：
 *   一、结构：声明表字面形态（外部契约）+ 两个工厂已是单一真源展开 + 实参表长度对齐
 *   二、绑定：实参**按名对位**（顺序即数据，错位不会报语法错、只会静默绑错）
 *   三、行为：thisObject 真缺陷（文字/对象两沙箱必须口径一致）
 *   四、语义等价：update / init / applyUserProperties / 指针 / 常量+存储+计时器 等
 *
 * 纯 Node、不启浏览器、不读素材库。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, imp, createChecker } from "./lib/verify-kit.mjs";

const { check, errors } = createChecker();

const TEXT_JS = "renderer/vendor/we-scene/render/text.js";
const textSrc = readFileSync(join(ROOT, TEXT_JS), "utf8");
const wtext = await imp(TEXT_JS);

// ── 解析工具（字符串/注释/正则感知，不执行源码） ──────────────────────────
/**
 * 去注释（保留字符串与正则字面量）。
 * 必须识别正则字面量：text.js 里有 `/'\x57\x45...'/` 这类「引号出现在正则里」的
 * 形态，若只管引号就会把它当字符串开始，此后整段注释都留在文本里污染切分。
 * 正则起始判定用上一有效字符（`(,=:[!&|?{};` 或行首才算正则，否则是除号）。
 */
function stripComments(src) {
  let out = "";
  let q = null;
  let prevSignificant = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      out += c;
      if (c === "\\") out += src[++i] ?? "";
      else if (c === q) q = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") { q = c; out += c; prevSignificant = c; continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; out += "\n"; continue; }
    if (c === "/" && src[i + 1] === "*") { i += 2; while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++; i++; continue; }
    if (c === "/" && /[(,=:[!&|?{};\n]|^$/.test(prevSignificant)) {
      // 正则字面量：扫到未转义的 `/`（`[...]` 字符类里的 `/` 不算结束）。
      let j = i + 1;
      let inClass = false;
      for (; j < src.length; j++) {
        const d = src[j];
        if (d === "\\") { j++; continue; }
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) break;
        else if (d === "\n") break;
      }
      out += src.slice(i, j + 1);
      i = j;
      prevSignificant = "/";
      continue;
    }
    out += c;
    if (!/\s/.test(c)) prevSignificant = c;
  }
  return out;
}

/** 取与 openIdx 处 '(' 配对的括号内部文本。 */
function parenInner(src, openIdx) {
  let depth = 0;
  let q = null;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === "\\") { i++; continue; }
      if (c === q) q = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") { q = c; continue; }
    if (c === "(") depth++;
    else if (c === ")") { depth--; if (depth === 0) return src.slice(openIdx + 1, i); }
  }
  return null;
}

/** 顶层逗号切分。 */
function splitTopLevel(s) {
  const parts = [];
  let depth = 0;
  let cur = "";
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      cur += c;
      if (c === "\\") cur += s[++i] ?? "";
      else if (c === q) q = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") { q = c; cur += c; continue; }
    if (c === "(" || c === "[" || c === "{") { depth++; cur += c; continue; }
    if (c === ")" || c === "]" || c === "}") { depth--; cur += c; continue; }
    if (c === "," && depth === 0) { parts.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

const clean = stripComments(textSrc);

/** 两个 `const factory = new Function(` 的形参区（按出现顺序：[文字, 对象]）。 */
function factoryParamTokens() {
  const out = [];
  const re = /const factory = new Function\(/g;
  let m;
  while ((m = re.exec(clean))) out.push(splitTopLevel(parenInner(clean, m.index + m[0].length - 1) ?? ""));
  return out;
}
/** 两个 `fns = factory(` 的实参区。 */
function factoryArgTokens() {
  const out = [];
  const re = /fns = factory\(/g;
  let m;
  while ((m = re.exec(clean))) out.push(splitTopLevel(parenInner(clean, m.index + m[0].length - 1) ?? ""));
  return out;
}

const paramRegions = factoryParamTokens();
const argRegions = factoryArgTokens();
check(paramRegions.length === 2, `源码里应有 2 个 \`const factory = new Function(\`（实得 ${paramRegions.length}）`);
check(argRegions.length === 2, `源码里应有 2 个 \`fns = factory(\`（实得 ${argRegions.length}）`);

const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
/** 形参 token：`...IDENT` → 展开标记；`'name'` → 手抄名；其余 → 表达式（函数体）。 */
const kindOf = (t) => {
  if (/^\.\.\.\s*[A-Za-z_$][\w$]*$/.test(t)) return { kind: "spread", name: /^\.\.\.\s*([A-Za-z_$][\w$]*)$/.exec(t)[1] };
  const lit = /^'([^']*)'$/.exec(t) ?? /^"([^"]*)"$/.exec(t);
  if (lit) return { kind: "literal", name: lit[1] };
  return { kind: "expr", raw: t };
};

// 形参区最后一个 token 是**函数体**（`'"use strict";\n...' + body + ...`），不是形参
const textParamToks = paramRegions[0].slice(0, -1).map(kindOf);
const objParamToks = paramRegions[1].slice(0, -1).map(kindOf);
const textArgToks = argRegions[0];
const objArgToks = argRegions[1];

// ── 一、结构：单一真源 + 长度对齐 ───────────────────────────────────────────
// 外部契约（verify-scenescript-constants.mjs:211）要求声明表保持「字面量数组 + \n]」形态
const declLitMatch = /const SANDBOX_PARAM_NAMES = \[([\s\S]*?)\n\]/.exec(textSrc);
check(!!declLitMatch, "源码形态缺失：SANDBOX_PARAM_NAMES 必须是 `const SANDBOX_PARAM_NAMES = [` … `\\n]` 的字面量数组");
check(/SANDBOX_PARAM_NAMES\.join\('\|'\)/.test(textSrc), "SANDBOX_PARAM_DECL_RE 必须仍由 SANDBOX_PARAM_NAMES 拼出（形参表与降级正则同源）");
const declFromSrc = declLitMatch
  ? [...declLitMatch[1].matchAll(/'([^']*)'|"([^"]*)"/g)].map((x) => x[1] ?? x[2])
  : [];
check(declFromSrc.length === 42, `声明表 SANDBOX_PARAM_NAMES 应为 42 个名字（实得 ${declFromSrc.length}）`);
check(declFromSrc.includes("thisObject"), "声明表必须含 thisObject（DECL_RE 靠它剥顶层 `var thisObject`）");

const decl = wtext.SANDBOX_PARAM_NAMES;
check(Array.isArray(decl), "text.js 必须导出 SANDBOX_PARAM_NAMES（数组）");
const sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const sortedEq = (a, b) => sameList([...a].sort(), [...b].sort());
check(sameList(decl ?? [], declFromSrc), "运行时 SANDBOX_PARAM_NAMES 必须等于源码字面量（正则解析与模块导出一致）");

// 文字沙箱的形参序列 = 声明表的一个**有序列**：thisLayer/thisScene 提到第 3/4 位，
// localStorage 挪到末位。顺序本身是数据 —— 只从声明表 filter 出子集会让
// thisLayer/thisScene 掉到 38/39 位、localStorage 掉到 41 位，而实参表按位对齐，
// 于是无任何语法错误地静默绑错（localStorage 拿到 MediaPlaybackEvent…）。
const TEXT_HEAD = ["thisLayer", "thisScene"];
const TEXT_TAIL = ["localStorage"];
const textRest = declFromSrc.filter((n) => !TEXT_HEAD.includes(n) && !TEXT_TAIL.includes(n));
const TEXT_EXPECTED = [...textRest.slice(0, 2), ...TEXT_HEAD, ...textRest.slice(2), ...TEXT_TAIL];
check(TEXT_EXPECTED.length === 42,
  `文字沙箱形参序列应为 42 名（实得 ${TEXT_EXPECTED.length}；head=${JSON.stringify(TEXT_HEAD)} tail=${JSON.stringify(TEXT_TAIL)}）`);
const textNames = wtext.TEXT_SANDBOX_PARAM_NAMES;
check(Array.isArray(textNames), "text.js 必须导出 TEXT_SANDBOX_PARAM_NAMES（数组）");
check(sameList(textNames ?? [], TEXT_EXPECTED),
  `文字沙箱形参序列必须 = 声明表把 ${JSON.stringify(TEXT_HEAD)} 提到第 3/4 位、${JSON.stringify(TEXT_TAIL)} 沉到末位（顺序即数据）`);

// 两个工厂都必须以 spread 展开真源，不得再留手抄名
check(textParamToks.length > 0 && textParamToks.every((t) => t.kind === "spread"),
  "evalTextScript 的 new Function 形参必须全部来自真源展开（`...TEXT_SANDBOX_PARAM_NAMES`），不得保留手抄名");
check(objParamToks.length > 0 && objParamToks.every((t) => t.kind === "spread"),
  "evalObjectScript 的 new Function 形参必须全部来自真源展开（`...SANDBOX_PARAM_NAMES`），不得保留手抄名");
check(textParamToks.some((t) => t.name === "TEXT_SANDBOX_PARAM_NAMES"),
  "evalTextScript 的形参展开目标必须是 TEXT_SANDBOX_PARAM_NAMES");
check(objParamToks.some((t) => t.name === "SANDBOX_PARAM_NAMES"),
  "evalObjectScript 的形参展开目标必须是 SANDBOX_PARAM_NAMES");

// 实参表长度必须与各自形参表长度一致（多出来的实参会被静默丢弃、少了的变 undefined）
const textParamLen = (textNames ?? []).length;
const objParamLen = (decl ?? []).length;
check(textArgToks.length === textParamLen,
  `文字沙箱 形参 ${textParamLen} 个 / 实参 ${textArgToks.length} 个 必须相等`);
check(objArgToks.length === objParamLen,
  `对象沙箱 形参 ${objParamLen} 个 / 实参 ${objArgToks.length} 个 必须相等`);

// 防漂（任务书 ⑤）：文字沙箱与对象沙箱形参**名集合**的差集必须恰好是下面声明的差集。
// 修 thisObject 之后两沙箱名字集合完全一致（只是顺序不同），故声明差集为空数组。
const DECLARED_SET_DIFF = [];
const objNames = wtext.SANDBOX_PARAM_NAMES;
const symDiff = (a, b) => [...new Set([...a, ...b])].filter((n) => !(a.includes(n) && b.includes(n)));
const textObjDiff = symDiff(textNames ?? [], objNames ?? []);
check(sameList(textObjDiff.sort(), [...DECLARED_SET_DIFF].sort()),
  `文字/对象沙箱形参名集合差集必须 = ${JSON.stringify(DECLARED_SET_DIFF)}（实得 ${JSON.stringify(textObjDiff)}）`);
// 顺序本身是数据：两沙箱名字集合相同但**序列不同**（thisLayer/thisScene 位置不同、
// localStorage 位置不同），若这里变成"完全同序"说明文字排列被误改成声明表原序。
check(!sameList(textNames ?? [], objNames ?? []),
  "文字/对象沙箱形参序列不应完全相同（顺序即数据：thisLayer/thisScene 在第 3/4 位、localStorage 在末位）");

// ── 二、绑定：实参按名对位 ─────────────────────────────────────────────────
// 位置绑定一旦错位不会报语法错，只会静默绑错值 —— 按「参数名 → 期望实参表达式」钉住。
const bindOf = (names, args) => Object.fromEntries(names.map((n, i) => [n, norm(args[i])]));
const textBind = bindOf(textNames ?? [], textArgToks);
const objBind = bindOf(decl ?? [], objArgToks);

const EXPECT_TEXT_BIND = {
  scriptProperties: "spValues",
  engine: "wrapEngine(engine)",
  thisLayer: "thisLayer",
  thisScene: "thisScene",
  shared: "shared",
  input: "input",
  Vec3: "Vec3", Vec2: "Vec2", Vec4: "Vec4",
  setTimeout: "engine.setTimeout",
  setInterval: "engine.setInterval",
  clearTimeout: "engine.clearTimeout",
  clearInterval: "engine.clearInterval",
  thisObject: "thisLayer",           // 与对象沙箱同口径：thisObject 绑图层代理
  MediaPlaybackEvent: "MEDIA_PLAYBACK_EVENT",
  localStorage: "opts.storage || makeSandboxStorage()",
};
const EXPECT_OBJ_BIND = {
  scriptProperties: "spValues",
  engine: "wrapEngine(engine)",
  thisLayer: "thisLayer",
  thisScene: "thisScene",
  shared: "shared",
  input: "input",
  Vec3: "Vec3", Vec2: "Vec2", Vec4: "Vec4",
  setTimeout: "engine.setTimeout",
  setInterval: "engine.setInterval",
  clearTimeout: "engine.clearTimeout",
  clearInterval: "engine.clearInterval",
  thisObject: "thisLayer",
  localStorage: "opts.storage || makeSandboxStorage()",
  MediaPlaybackEvent: "MEDIA_PLAYBACK_EVENT",
};
for (const [name, want] of Object.entries(EXPECT_TEXT_BIND)) {
  if (textBind[name] === undefined) { check(false, `文字实参表缺少 ${name} 的绑定`); continue; }
  check(textBind[name] === want, `文字实参 ${name} 应绑 \`${want}\`（实得 \`${textBind[name]}\`）`);
}
for (const [name, want] of Object.entries(EXPECT_OBJ_BIND)) {
  if (objBind[name] === undefined) { check(false, `对象实参表缺少 ${name} 的绑定`); continue; }
  check(objBind[name] === want, `对象实参 ${name} 应绑 \`${want}\`（实得 \`${objBind[name]}\`）`);
}

// ── 三、行为：thisObject 真缺陷（两沙箱口径必须一致） ───────────────────────
function evalText(src, opts = {}, props = {}) {
  const errs = [];
  const sh = wtext.evalTextScript(src, props, { ...opts, onError: (e, p) => errs.push(`${p}: ${e.message}`) });
  return { sh, errs };
}
function evalObj(src, opts = {}, props = {}) {
  const errs = [];
  const sh = wtext.evalObjectScript(src, props, { ...opts, onError: (e, p) => errs.push(`${p}: ${e.message}`) });
  return { sh, errs };
}

// D1：顶层 `var thisObject` 的文字脚本（复现探针的最小形态）
const D1 = "export var thisObject = { color: [1, 0, 0] };\nexport function update(value) { return thisObject.color.join(',') }";
check(wtext.checkSceneScript(D1).ok === true, "D1 语法上应被判 ok（checkSceneScript 用 42 形参编译）");
{
  const { sh, errs } = evalText(D1);
  check(!!sh, `D1 文字沙箱必须建得起来（顶层 var thisObject 不得把脚本炸掉）—— onError=${JSON.stringify(errs)}`);
  check(errs.length === 0, `D1 文字沙箱不应有 parse 错误（实得 ${JSON.stringify(errs)}）`);
  const tv = sh ? sh.callUpdate(0) : null;
  check(tv === "1,0,0", `D1 文字沙箱 update 应返回 "1,0,0"（实得 ${JSON.stringify(tv)}）`);
  const o = evalObj(D1);
  check(!!o.sh && o.errs.length === 0, `D1 对象沙箱应无错误（实得 ${JSON.stringify(o.errs)}）`);
  const ov = o.sh ? o.sh.callUpdate(0) : null;
  check(ov === "1,0,0", `D1 对象沙箱 update 应返回 "1,0,0"（实得 ${JSON.stringify(ov)}）`);
  // 口径一致：checkSceneScript ok === true 时 evalTextScript 不得返回 null
  check(!!sh === !!o.sh, "D1 同一脚本在文字/对象沙箱的建沙箱结果必须一致（ok=true 却 eval=null 即为缺陷）");
}

// D2：只读 thisObject（不写顶层声明）—— 必须是一个对象（不像 typeof 未声明那样是 'undefined'）
const D2 = "export function update(value) { return typeof thisObject === 'object' ? 'obj' : 'no' }";
{
  const { sh } = evalText(D2);
  const tv = sh ? sh.callUpdate(0) : null;
  check(tv === "obj", `D2 文字沙箱 thisObject 必须是对象（实得 ${JSON.stringify(tv)}）`);
  const o = evalObj(D2);
  const ov = o.sh ? o.sh.callUpdate(0) : null;
  check(ov === "obj", `D2 对象沙箱 thisObject 必须是对象（实得 ${JSON.stringify(ov)}）`);
}

// D3：thisObject 与 thisLayer 是同一个代理（对象沙箱既有口径）
const D3 = "export function update(value) { return thisObject === thisLayer ? 'same' : 'diff' }";
{
  const { sh } = evalText(D3);
  const tv = sh ? sh.callUpdate(0) : null;
  check(tv === "same", `D3 文字沙箱 thisObject 应与 thisLayer 同一（实得 ${JSON.stringify(tv)}）`);
  const o = evalObj(D3);
  const ov = o.sh ? o.sh.callUpdate(0) : null;
  check(ov === "same", `D3 对象沙箱 thisObject 应与 thisLayer 同一（实得 ${JSON.stringify(ov)}）`);
}

// ── 四、语义等价（update / init / applyUserProperties / 指针 / 常量+存储） ──
// 存储：接一个内存 provider，令 `localStorage` 可读写（离线路径不碰磁盘）
function mkStorage() {
  const mem = new Map();
  return wtext.makeSandboxStorage({
    get: (k) => (mem.has(k) ? mem.get(k) : null),
    set: (k, v) => { mem.set(k, v) },
    remove: (k) => { mem.delete(k) },
    keys: () => [...mem.keys()],
    clear: () => mem.clear(),
  });
}

// S1 update 返回字符串。**两侧入参语义不同**（既有行为，勿改）：
//   文字侧 callUpdate(value) 忽略入参、只把 thisLayer.text 喂给 update，且 update 若
//   「读形参」会被 updateIsWriteback 先把 thisLayer.text 清空；
//   对象侧 callUpdate(value) 把入参 asScriptVec3 后原样传给 update。
// 故这里用零形参 update 钉「返回字符串」这一共同契约。
const S1 = "export function update() { return 'u' }";
{
  const t = evalText(S1, { text: "x" }), o = evalObj(S1);
  const tv = t.sh ? t.sh.callUpdate("x") : null;
  const ov = o.sh ? o.sh.callUpdate("x") : null;
  check(tv === "u", `S1 文字 update 应返回 "u"（实得 ${JSON.stringify(tv)}）`);
  check(ov === "u", `S1 对象 update 应返回 "u"（实得 ${JSON.stringify(ov)}）`);
  // 文字侧：读形参的 update 会把 thisLayer.text 清空后再喂（既有 writeback 语义）
  const W = "export function update(v) { return 'w:' + v }";
  const tw = evalText(W, { text: "x" });
  const wv = tw.sh ? tw.sh.callUpdate("x") : null;
  check(wv === "w:", `S1b 文字侧读形参 update 应先清空 thisLayer.text（期望 "w:"，实得 ${JSON.stringify(wv)}）`);
}

// S2 init
const S2 = "export function init(v) { return v * 2 }\nexport function update() { return 'ok' }";
{
  const t = evalText(S2), o = evalObj(S2);
  const tv = t.sh ? t.sh.init(3) : null;
  const ov = o.sh ? o.sh.init(3) : null;
  check(tv === 6, `S2 文字 init(3) 应返回 6（实得 ${JSON.stringify(tv)}）`);
  check(ov === 6, `S2 对象 init(3) 应返回 6（实得 ${JSON.stringify(ov)}）`);
}

// S3 applyUserProperties 副作用 + shared
const S3 = "export function applyUserProperties(p) { shared.acc = p.n }\nexport function update() { return String(shared.acc) }";
{
  const shared = {};
  const t = evalText(S3, { shared }), o = evalObj(S3, { shared });
  if (t.sh) t.sh.applyUserProperties({ n: 5 });
  check(shared.acc === 5, `S3 applyUserProperties 应写 shared.acc = 5（实得 ${JSON.stringify(shared.acc)}）`);
  const tv = t.sh ? t.sh.callUpdate(0) : null;
  const ov = o.sh ? (o.sh.applyUserProperties({ n: 5 }), o.sh.callUpdate(0)) : null;
  check(tv === "5", `S3 文字 update 应返回 "5"（实得 ${JSON.stringify(tv)}）`);
  check(ov === "5", `S3 对象 update 应返回 "5"（实得 ${JSON.stringify(ov)}）`);
}

// S4 指针回调。event 契约 = `{ worldPosition: Vec3 }`（全库 51 处只读这一个字段）。
// 注意：文字沙箱的闸门族**不含** hasCursorHook（只有 media/apply/animationEvent/
// resizeScreen/update 五族），纯 cursor 脚本在文字侧会返回 null —— 这是既有行为、
// 不在本轮范围内，所以这里挂一个 update 让两沙箱都建得起来，只钉 callCursor 语义。
const S4 = "export function update() { return shared.cx || 0 }\nexport function cursorMove(e) { shared.cx = e.worldPosition.x; return shared.cx }";
{
  const tShared = {}, oShared = {};
  const t = evalText(S4, { shared: tShared }), o = evalObj(S4, { shared: oShared });
  const tv = t.sh ? t.sh.callCursor("cursorMove", { worldPosition: wtext.makeCursorEventVec(3, 0, 0) }) : null;
  const ov = o.sh ? o.sh.callCursor("cursorMove", { worldPosition: wtext.makeCursorEventVec(3, 0, 0) }) : null;
  check(tv === 3, `S4 文字 callCursor 应返回 3（实得 ${JSON.stringify(tv)}）`);
  check(ov === 3, `S4 对象 callCursor 应返回 3（实得 ${JSON.stringify(ov)}）`);
}

// S5 常量脚本：MediaPlaybackEvent + localStorage + thisObject 三者同时可用
const S5 = "export function update() { return MediaPlaybackEvent.PLAYBACK_PAUSED + '|' + typeof localStorage.getItem + '|' + (thisObject === thisLayer) }";
{
  const t = evalText(S5), o = evalObj(S5);
  const tv = t.sh ? t.sh.callUpdate(0) : null;
  const ov = o.sh ? o.sh.callUpdate(0) : null;
  check(tv === "2|function|true", `S5 文字应返回 "2|function|true"（实得 ${JSON.stringify(tv)}）`);
  check(ov === "2|function|true", `S5 对象应返回 "2|function|true"（实得 ${JSON.stringify(ov)}）`);
}

// S6 存储往返（localStorage 必须绑 opts.storage 的实例，而不是别的形参位置）。
// 两个沙箱各给一份独立 storage，否则先跑的一侧会把状态留给另一侧。
const S6 = "export function update() {\n  if (localStorage.getItem('k') === null) { localStorage.setItem('k', 'v'); return 'set' }\n  return 'got:' + localStorage.getItem('k')\n}";
{
  const tStore = mkStorage();
  const t = evalText(S6, { storage: tStore });
  const tv1 = t.sh ? t.sh.callUpdate(0) : null;
  const tv2 = t.sh ? t.sh.callUpdate(0) : null;
  check(tv1 === "set", `S6 文字首次应返回 "set"（实得 ${JSON.stringify(tv1)}）`);
  check(tv2 === "got:v", `S6 文字再次应返回 "got:v"（实得 ${JSON.stringify(tv2)}）`);
  const oStore = mkStorage();
  const o = evalObj(S6, { storage: oStore });
  const ov1 = o.sh ? o.sh.callUpdate(0) : null;
  const ov2 = o.sh ? o.sh.callUpdate(0) : null;
  check(ov1 === "set", `S6 对象首次应返回 "set"（实得 ${JSON.stringify(ov1)}）`);
  check(ov2 === "got:v", `S6 对象再次应返回 "got:v"（实得 ${JSON.stringify(ov2)}）`);
  check(tStore.getItem("k") === "v" && oStore.getItem("k") === "v", "S6 opts.storage 实例应被真正写入（证明 localStorage 绑定位置正确）");
}

// S7 裸 setTimeout 必须落在 engine.setTimeout（遮成 undefined 会熔断音量条脚本）
const S7 = "export function update() { setTimeout(function () { shared.t = 1 }, 0); return 't' }";
{
  let hits = 0;
  const t = evalText(S7, { setTimeout: () => { hits++ }, shared: {} });
  const tv = t.sh ? t.sh.callUpdate(0) : null;
  check(tv === "t", `S7 文字 update 应返回 "t"（实得 ${JSON.stringify(tv)}）`);
  check(hits === 1, `S7 裸 setTimeout 必须走 engine.setTimeout（命中 ${hits} 次，应为 1）`);
  let hits2 = 0;
  const o = evalObj(S7, { setTimeout: () => { hits2++ }, shared: {} });
  const ov = o.sh ? o.sh.callUpdate(0) : null;
  check(ov === "t", `S7 对象 update 应返回 "t"（实得 ${JSON.stringify(ov)}）`);
  check(hits2 === 1, `S7 对象裸 setTimeout 必须走 engine.setTimeout（命中 ${hits2} 次，应为 1）`);
}

// S8 内置模块与 Vec 类
const S8 = "export function update() { var a = new Vec3(1, 2, 3); var b = new Vec2(3, 4); return [WEMath.mix(0, 10, 0.5), a.x, b.y, typeof WEColor.hsv2rgb, typeof WEVector.vectorAngle2, typeof Vec4].join(',') }";
{
  const want = "5,1,4,function,function,function";
  const t = evalText(S8), o = evalObj(S8);
  const tv = t.sh ? t.sh.callUpdate(0) : null;
  const ov = o.sh ? o.sh.callUpdate(0) : null;
  check(tv === want, `S8 文字应返回 "${want}"（实得 ${JSON.stringify(tv)}）`);
  check(ov === want, `S8 对象应返回 "${want}"（实得 ${JSON.stringify(ov)}）`);
}

// S9 createScriptProperties / scriptProperties 双路径（官方模板形态）
const S9 = "export let scriptProperties = createScriptProperties().addSlider({ name: 's', value: 7 }).finish();\nexport function update() { return String(scriptProperties.s) }";
{
  const t = evalText(S9), o = evalObj(S9);
  const tv = t.sh ? t.sh.callUpdate(0) : null;
  const ov = o.sh ? o.sh.callUpdate(0) : null;
  check(tv === "7", `S9 文字 scriptProperties.s 应为 7（实得 ${JSON.stringify(tv)}）`);
  check(ov === "7", `S9 对象 scriptProperties.s 应为 7（实得 ${JSON.stringify(ov)}）`);
  // scene 传入值优先于声明默认值
  const t2 = evalText(S9, {}, { s: { value: 11 } });
  const t2v = t2.sh ? t2.sh.callUpdate(0) : null;
  check(t2v === "11", `S9 scene 值应优先（实得 ${JSON.stringify(t2v)}）`);
}

// S10 thisScene / shared 形参绑定仍在位
const S10 = "export function update() { shared.tag2 = typeof thisScene.getLayer; return shared.tag2 }";
{
  const t = evalText(S10, { shared: {} }), o = evalObj(S10, { shared: {} });
  const tv = t.sh ? t.sh.callUpdate(0) : null;
  const ov = o.sh ? o.sh.callUpdate(0) : null;
  check(tv === "function", `S10 文字 thisScene.getLayer 应为 function（实得 ${JSON.stringify(tv)}）`);
  check(ov === "function", `S10 对象 thisScene.getLayer 应为 function（实得 ${JSON.stringify(ov)}）`);
}

// ── 五、闸门族：纯 cursor / 纯 init / 纯引擎时钟文字脚本不得被丢弃 ────────────
// evalTextScript 的闸门原本只认 update/media/apply/anim/resize 五族，而
// evalObjectScript 的闸门认七族。凡是「闸门族与实现失同步」，脚本
// 就在建沙箱那一步被静默丢弃（宿主拿不到句柄，回调永远不会被派发）。
//
// 三族在文字侧**有完整消费口**，本轮已全部修齐（task-20 修 cursor/init，
// task-25 修 usesEngineClock）：
//   · cursor*：宿主 `scene-mount.ts:5657-5659` 对 textWidgets 逐个 addCursorHook，
//     派发在 `:6547`；守卫 `:5649-5650` 读的正是 sandbox.hasCursorHook。
//     3786330502 的悬停/显隐交互按钮挂在文字层上。
//   · init：宿主对文字沙箱真调 init —— `:5237`（热替换）与 `:6448`（装配期
//     deferredTextInits 末端 `const tir = d.sandbox.init(d.layer.text ?? "")`）。
//   · usesEngineClock：三重阻断必须同批修 —— ①快速短路（text.js `:1015`）
//     ②闸门族（`:1297`）③宿主时钟回填（`scene-mount.ts` updateTexts 必须按沙箱
//     回填，不得嵌在 `hasUpdate` 分支内）。只修其一 = 静默错值（runtime 恒 0，
//     helper 里 `engine.runtime - stateChangeTime >= delay` 永不成立）。
//
// 闸门族只能从**源码文本**解析：`hasInitHook` / `usesEngineClock` 都不进任何
// sandbox 句柄（grep 在 renderer/src、host、editor、scripts 全 0 命中）。
const GATE_RE = /if \(!fns \|\| \(([^]*?)\)\) return null/g;
const gateInners = [...textSrc.matchAll(GATE_RE)].map((m) => m[1]);
// 期望恰好两处：evalTextScript 一处 + evalObjectScript 一处
check(gateInners.length === 2, `应解析出 2 处沙箱闸门（实得 ${gateInners.length}）`);
const gateTerms = gateInners.map((inner) =>
  [...inner.matchAll(/!([A-Za-z_$][\w$]*)/g)].map((m) => m[1]).filter((n) => n !== "fns"),
);
const [textGateTerms, objGateTerms] = gateTerms;
// 顺序敏感：闸门条件里的族顺序也是一份手抄清单，漂了要能看见
const gateFamily = (terms) => (terms || []).filter((n) => n !== "update");
const textGateFams = gateFamily(textGateTerms);
const objGateFams = gateFamily(objGateTerms);
check(
  sameList(textGateFams, ["hasCursorHook", "hasMediaHook", "hasApplyHook", "usesEngineClock", "hasAnimEventHook", "hasResizeHook", "hasInitHook"]),
  `文字闸门族应与对象侧逐字对称（七族，usesEngineClock 位于 apply 与 anim 之间）（实得 ${JSON.stringify(textGateFams)}）`,
);
check(
  sameList(objGateFams, ["hasCursorHook", "hasMediaHook", "hasApplyHook", "usesEngineClock", "hasAnimEventHook", "hasResizeHook", "hasInitHook"]),
  `对象闸门族应为七族（实得 ${JSON.stringify(objGateFams)}）`,
);

// 已知缺口（照搬 task-16 的 DECLARED_SET_DIFF 模式，防「差集为空」被写死成谎言）。
// task-25 已把最后一族 `usesEngineClock` 补齐（短路 + 闸门 + 宿主回填三处同批），
// 所以这里现在是**空数组** —— 语义仍是「差集必须逐字等于 HOOK_GAP」：今后谁再往
// 对象闸门加一族而不加文字侧，差集立刻 ≠ [] 变红（保留机检，不是删掉断言）。
const HOOK_GAP = [];
const missingInText = objGateFams.filter((n) => !textGateFams.includes(n));
const extraInText = textGateFams.filter((n) => !objGateFams.includes(n));
check(extraInText.length === 0, `文字闸门不该有对象侧没有的族（实得 ${JSON.stringify(extraInText)}）`);
check(
  sameList(missingInText, HOOK_GAP),
  `两侧闸门族差集必须逐字等于已声明的已知缺口 ${JSON.stringify(HOOK_GAP)}（实得 ${JSON.stringify(missingInText)}）`,
);
// D7：差集为空（task-25 之后两侧闸门族必须完全对称）
check(
  missingInText.length === 0 && extraInText.length === 0,
  `D7 双侧闸门族必须对称（缺 ${JSON.stringify(missingInText)} / 多 ${JSON.stringify(extraInText)}）`,
);

// D7b：`usesEngineClock` 的**正则本身**必须两侧逐字相同（卡片硬要求）。
// 闸门族对称只钉了「两边都有这一族」；正则若被改成只认 runtime 而不认 frametime，
// 族名不变、脚本却会静默少放行一类，故把正则字面量也钉死。
const ENGINE_CLOCK_DEF_RE = /const usesEngineClock = (\/[^\n]*?\/)\.test\(body\)/g;
const engineClockDefs = [...textSrc.matchAll(ENGINE_CLOCK_DEF_RE)].map((m) => m[1]);
check(engineClockDefs.length === 2, `应解析出 2 处 usesEngineClock 正则（实得 ${engineClockDefs.length}）`);
check(
  engineClockDefs.length === 2 && engineClockDefs[0] === engineClockDefs[1],
  `文字/对象两侧 usesEngineClock 正则必须逐字相同（实得 ${JSON.stringify(engineClockDefs)}）`,
);
// 两侧定义都出现在源码里（文字侧 :1010 快速短路处、对象侧 :2841 闸门处）
check(
  textSrc.indexOf("!usesEngineClock) return null") >= 0,
  "快速短路必须含 `&& !usesEngineClock`（否则引擎层脚本在短路处就被丢）",
);
check(
  (textSrc.match(/!usesEngineClock &&/g) || []).length === 2, // 短路一处 + 闸门一处（对象侧闸门写法不同，见下）
  "`!usesEngineClock` 在条件里应出现 2 次（短路 1 + 文字闸门 1）",
);

// 闸门只钉了「有一族叫 hasCursorHook」，钉不住**这一族认哪六个回调**：
// 六项清单也是手抄的，删掉其中一项（例如 cursorUp）不会有任何语法错误，
// 而对应回调的文字脚本会重新被静默丢弃。这里把清单本身也钉死。
const CURSOR_HOOK_DEF_RE = /const hasCursorHook = !!\s*\(fns && \(([\s\S]*?)\)\)/g;
const cursorDefs = [...textSrc.matchAll(CURSOR_HOOK_DEF_RE)].map((m) =>
  [...m[1].matchAll(/fns\.([A-Za-z_$][\w$]*)/g)].map((x) => x[1]),
);
check(cursorDefs.length === 2, `应解析出 2 处 hasCursorHook 定义（实得 ${cursorDefs.length}）`);
const CURSOR_CALLBACKS = ["cursorClick", "cursorEnter", "cursorLeave", "cursorDown", "cursorUp", "cursorMove"];
for (const [i, label] of ["文字", "对象"].entries()) {
  const got = cursorDefs[i];
  check(
    got !== undefined && sameList([...got].sort(), [...CURSOR_CALLBACKS].sort()),
    `${label} hasCursorHook 必须认全六个回调 ${JSON.stringify(CURSOR_CALLBACKS)}（实得 ${JSON.stringify(got)}）`,
  );
}

// D4：纯 cursor 文字脚本（无 update）—— 闸门丢弃 = 该层指针交互整体不存在
const D4 = "export function cursorMove(e) { shared.hit = e.worldPosition.x; return shared.hit }";
{
  const sharedObj = {};
  const { sh, errs } = evalText(D4, { shared: sharedObj });
  check(!!sh, `D4 纯 cursor 文字沙箱必须建得起来（闸门漏 hasCursorHook）—— onError=${JSON.stringify(errs)}`);
  check(sh ? sh.hasCursorHook === true : false, `D4 文字 hasCursorHook 应为 true（实得 ${sh ? JSON.stringify(sh.hasCursorHook) : "null 沙箱"}）`);
  // callCursor 真的被调用到：脚本把 e.worldPosition.x 写进共享对象
  if (sh) sh.callCursor("cursorMove", { worldPosition: wtext.makeCursorEventVec(7, 0, 0) });
  check(sharedObj.hit === 7, `D4 文字 callCursor 必须真的调到脚本（shared.hit 应为 7，实得 ${JSON.stringify(sharedObj.hit)}）`);
  // 与对象沙箱口径一致（对象侧本来就放行 cursor 族）
  const o = evalObj(D4, { shared: {} });
  check(!!o.sh && o.sh.hasCursorHook === true, `D4 对象侧应放行纯 cursor（实得 ${o.sh ? JSON.stringify(o.sh.hasCursorHook) : "null 沙箱"}）`);
}

// D5：纯 init 文字脚本（无 update）—— 闸门丢弃 = init 的初始副作用全部丢失
const D5 = "export function init(value) { return 'init:' + String(value) }";
{
  const { sh, errs } = evalText(D5);
  check(!!sh, `D5 纯 init 文字沙箱必须建得起来（闸门漏 hasInitHook）—— onError=${JSON.stringify(errs)}`);
  check(sh ? typeof sh.init === "function" : false, "D5 文字沙箱应暴露 init()");
  // 照宿主形态消费（scene-mount.ts:6448-6450）：返回值是字符串就写回 layer.text
  if (sh) {
    const tir = sh.init("初值");
    if (typeof tir === "string") sh.thisLayer.text = tir;
  }
  check(sh ? sh.thisLayer.text === "init:初值" : false, `D5 文字 init 返回值应写回 thisLayer.text（实得 ${sh ? JSON.stringify(sh.thisLayer.text) : "null 沙箱"}）`);
  const o = evalObj(D5);
  check(!!o.sh, "D5 对象侧应放行纯 init");
}

// D6：纯「引擎层」文字脚本（无 export、无 update，只在顶层往 shared 上装读时钟的
// helper）。这是三重阻断的合成形态：①快速短路 text.js:1003 先丢（body===script 且不含
// update/resizeScreen）②闸门缺 usesEngineClock ③宿主时钟回填嵌在 hasUpdate 分支内。
// 只修 ①②不修 ③ = engine.runtime 恒 0 = 静默错值（面板不报错、画面不动）。
// helper 不经过 FNS 暴露（它不是沙箱认得的入口名），所以真值经**我们传进去的 shared**
// 观测 —— 这正是 3786330502「点绿色箭头 shared.ck 翻了却一动不动」的机理。
const D6B = "shared.stateChangeTime = 1;\nshared.helper = () => engine.runtime - shared.stateChangeTime";
{
  const sharedObj = {};
  const { sh, errs } = evalText(D6B, { shared: sharedObj });
  check(!!sh, `D6 纯引擎时钟文字沙箱必须建得起来（短路 + 闸门三重阻断）—— onError=${JSON.stringify(errs)}`);
  check(typeof sharedObj.helper === "function", "D6 脚本顶层应已把 helper 装到 shared 上（顶层代码确实跑过）");
  if (sh && typeof sharedObj.helper === "function") {
    // 「放行」不等于「能用」：必须读到宿主真实回填的 runtime 才叫修好。
    // 恒 0 会得 -1，只有回填生效才得 4。
    sh.engine.runtime = 5;
    check(sharedObj.helper() === 4,
      `D6 回填 runtime=5、stateChangeTime=1 ⇒ helper() 必须 === 4（实得 ${JSON.stringify(sharedObj.helper())}；` +
      ` 恒 0 的静默错值会得 -1）`);
  }
  // 对象侧本来就放行这一族
  const o = evalObj(D6B, { shared: {} });
  check(!!o.sh, "D6 对象侧应放行纯引擎时钟脚本");
}

// D6c：卡面形态（带 `export var`，走不到快速短路 —— body !== script）⇒ 单独钉**闸门**这一关。
// 与 D6 合起来：D6 覆盖「短路 + 闸门 + 回填」三处，D6c 覆盖「闸门 + 回填」两处。
const D6C = "export var stateChangeTime = 0;\nshared.read = () => engine.runtime - stateChangeTime";
{
  const sharedObj = {};
  const { sh, errs } = evalText(D6C, { shared: sharedObj });
  check(!!sh, `D6c 带 export 的引擎时钟文字沙箱必须建得起来（闸门漏 usesEngineClock）—— onError=${JSON.stringify(errs)}`);
  check(typeof sharedObj.read === "function", "D6c 顶层应已把 read 装到 shared 上");
  if (sh && typeof sharedObj.read === "function") {
    sh.engine.runtime = 5;
    check(sharedObj.read() === 5,
      `D6c stateChangeTime=0、runtime=5 ⇒ read() 应为 5（实得 ${JSON.stringify(sharedObj.read())}；` +
      ` 未回填的静默错值会得 0）`);
  }
}

// D6a：卡面**逐字**形态（`export var stateChangeTime = 0; export function helper(){…}`）。
// `export` ⇒ body !== script ⇒ 走不到快速短路，专钉闸门；`helper` 不在沙箱句柄里，
// 故末尾补一行 `shared.helper = helper` 把它变成可观测的（顶层代码在 build 时执行）。
const D6A =
  "export var stateChangeTime = 1;\n" +
  "export function helper(){ return engine.runtime - stateChangeTime }\n" +
  "shared.helper = helper";
{
  const sharedObj = {};
  const { sh, errs } = evalText(D6A, { shared: sharedObj });
  check(!!sh, `D6a 卡面形态引擎时钟文字沙箱必须建得起来 —— onError=${JSON.stringify(errs)}`);
  check(typeof sharedObj.helper === "function", "D6a 顶层应已把 helper 装到 shared 上");
  if (sh && typeof sharedObj.helper === "function") {
    sh.engine.runtime = 5;
    check(sharedObj.helper() === 4,
      `D6a stateChangeTime=1、runtime=5 ⇒ helper() 必须 === 4（实得 ${JSON.stringify(sharedObj.helper())}）`);
  }
  // 对象侧同一脚本必须同样可用（对齐基准）
  const oShared = {};
  const o = evalObj(D6A, { shared: oShared });
  check(!!o.sh, "D6a 对象侧应放行同一脚本");
  if (o.sh && typeof oShared.helper === "function") {
    o.sh.engine.runtime = 5;
    check(oShared.helper() === 4, `D6a 对象侧 helper() 也应为 4（实得 ${JSON.stringify(oShared.helper())}）`);
  }
}

// D8：scene-mount.ts 接线 —— 时钟回填必须按沙箱（textWidgets），不得嵌在 hasUpdate 内
const SCENE_MOUNT = "renderer/src/scene-mount.ts";
const mountSrc = readFileSync(join(ROOT, SCENE_MOUNT), "utf8");
{
  const start = mountSrc.indexOf("const updateTexts = (t: number) => {");
  check(start >= 0, `D8 应能在 ${SCENE_MOUNT} 里定位 updateTexts`);
  const end = start >= 0 ? mountSrc.indexOf("\n        };", start) : -1;
  check(end > start, "D8 应能定位 updateTexts 函数体结尾");
  const slice = start >= 0 && end > start ? mountSrc.slice(start, end) : "";
  // 只在**去注释后**的代码上判位置与名字：注释里引用 `propSandboxes` 或
  // `sandbox.hasUpdate` 是在解释历史，不该被当成接线本身（本文件上面就有一处
  // 引用对象侧写法的说明性注释）。stripComments 保留换行与字符串，相对顺序不变。
  const code = stripComments(slice);
  const backfillAt = code.indexOf("sandbox.engine.runtime =");
  const hasUpdateAt = code.indexOf("sandbox.hasUpdate");
  const callUpdateAt = code.indexOf("callUpdate(");
  check(backfillAt >= 0, "D8 updateTexts 里必须有时钟回填 `sandbox.engine.runtime =`");
  check(backfillAt >= 0 && hasUpdateAt >= 0 && backfillAt < hasUpdateAt,
    `D8 时钟回填必须早于 hasUpdate 判断（backfill@${backfillAt} 应 < hasUpdate@${hasUpdateAt}）——` +
    ` 嵌在 hasUpdate 分支内 ⇒ 纯引擎时钟脚本的 runtime 恒 0（静默错值）`);
  check(callUpdateAt > hasUpdateAt, "D8 callUpdate( 仍必须在 hasUpdate 判断之后（不得多调 update）");
  check(code.includes("for (const it of textWidgets)"),
    "D8 回填必须遍历 textWidgets（文字控件池），不得误用 propSandboxes");
  check(!/propSandboxes/.test(code),
    "D8 updateTexts 代码里不得出现 propSandboxes（那是对象脚本的池子）");
}

// ── 收尾 ───────────────────────────────────────────────────────────────────
console.log(
  `[params] decl=${declFromSrc.length} text=${textParamLen}(args ${textArgToks.length}) obj=${objParamLen}(args ${objArgToks.length}) ` +
  `text−obj=${JSON.stringify(symDiff(textNames ?? [], decl ?? []))}`,
);
if (errors.length) {
  console.error(`verify-sandbox-params: ${errors.length} 项失败`);
  for (const e of errors) console.error("  ✗", e);
  process.exit(1);
}
console.log("verify-sandbox-params: ok");
