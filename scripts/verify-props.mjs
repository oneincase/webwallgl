/**
 * verify-props.mjs —— 用户属性解引用（{user, value} → 生效值）的离线校验
 *
 * scene.json 里受壁纸自定义属性控制的字段形如 `{"user":"xraysize","value":0.2}`：
 * `user` 指向 project.json `general.properties` 里的属性名，`value` 是**存场景那一刻**
 * 的快照。全库 3117 处引用里有 381 处快照 ≠ 属性表默认值，所以「读哪一侧」直接决定画面。
 *
 * 本脚本盯三件事：
 *
 *   1. **读属性表，不读快照。** 这是 WE 的运行时语义，判据是「烘焙值 oracle」：
 *      origin/scale/angles 带 script 时，字段自身的 `value` 是 WE 跑完脚本后存下的
 *      **结果**，而脚本形如 `value.x = scriptProperties.x`，于是这个结果直接暴露了
 *      WE 当时解到了哪一侧。全库 baked==prop 38 处、baked==snap 11 处，后者全部来自
 *      同一张 3509243656 且都是 baked==snap≠prop（存完场景后又调过属性，烘焙值本就
 *      是旧的，区分不了两种假说）。而 38 处 baked==prop≠snap 无法用「读快照」解释。
 *      曾经读快照的后果：2854083091 的 X-Ray 开窗快照 0.2、属性 1，而 shader 里
 *      v_PointerScale = 1/g_PointerScale —— halo 被缩成 1/5，用户报「开窗默认值太小」。
 *
 *   2. **撞车必须退回快照。** 381 处分歧里有 44 处是字段名与属性名撞车：3078285611 把
 *      `visible` 绑到一个 color 属性、3521337568 把 `x` 绑到 bool、3292361861 把
 *      `parallaxDepth`(vec2) 绑到 bool。无条件替换会得到类型错乱的值（visible 变成
 *      "0.98 0.55 0.78"）。判据是「形状」：数值↔数值放行（标量与向量按分量广播，
 *      WE 自己就这么用，如 scale 绑单个 slider），bool/文本必须严格同形。
 *
 *   3. **全库解析后几何量仍然是有限数、visible 仍然是 bool。** 这是兜底：任何一种
 *      放宽形状检查的改法，只要让撞车项漏进去，这里就会炸。
 *
 * 注意本脚本**不靠往返自洽**：它直接 import 真实的 parseScene，断言的是绝对语义
 * （「xraysize 必须解出 1」「visible 必须是 bool」），不是「两份实现互相对得上」。
 *
 * 退出码非 0 表示发现问题。
 */
import fs from "node:fs";
import { join, relative, sep } from "node:path";

import { LIB, ROOT, imp, createChecker, dec } from "./lib/verify-kit.mjs";
const { parsePkg, getEntry } = await imp("renderer/vendor/we-scene/pkg/container.js");
const { parseScene, parseBool } = await imp("renderer/vendor/we-scene/scene/parse.js");
const { resolveUserValue, resolveUserProps, flattenUserProperties, mergeUserPropertyValues, boundUserName } = await imp(
  "renderer/vendor/we-scene/scene/user-props.js",
);

const { fail, errors } = createChecker();
const notes = [];
const ok = (m) => notes.push(m);

const load = (id) => {
  const p = join(LIB, id, "scene.pkg");
  const q = join(LIB, id, "project.json");
  if (!fs.existsSync(p) || !fs.existsSync(q)) return null;
  try {
    const pkg = parsePkg(new Uint8Array(fs.readFileSync(p)));
    const raw = getEntry(pkg, "scene.json");
    if (!raw) return null;
    return { scene: JSON.parse(dec.decode(raw)), proj: JSON.parse(fs.readFileSync(q, "utf8")) };
  } catch { return null; }
};

const ids = fs.existsSync(LIB)
  ? fs.readdirSync(LIB).filter((d) => fs.existsSync(join(LIB, d, "scene.pkg")))
  : [];

// ---------- 1. 目标用例：属性表默认值必须生效 ----------
// 2854083091 X-Ray：size 绑 xraysize，快照 0.2 / 属性 1。这是用户报的那张。
{
  const d = load("2854083091");
  if (!d) {
    ok("跳过 2854083091（本机无此壁纸）");
  } else {
    const s = parseScene(d.scene, d.proj);
    let found = null;
    for (const l of s.layers) {
      for (const e of l.effects || []) {
        for (const p of e.passes || []) {
          const cv = p.constantshadervalues;
          if (cv && "size" in cv) found = cv.size;
        }
      }
    }
    const val = found && typeof found === "object" ? found.value : found;
    if (found === null) fail("2854083091 没找到 xray 的 size 常量（用例失效，需要重新挑样本）");
    else if (Math.abs(Number(val) - 1) > 1e-6) {
      fail(`2854083091 xray size 解出 ${JSON.stringify(val)}，应为属性表默认值 1`
        + "（读成快照 0.2 会把开窗缩成 1/5，因为 shader 里 v_PointerScale = 1/g_PointerScale）");
    } else ok("2854083091 xray size 取属性表默认值 1（不是快照 0.2）");
  }
}

// ---------- 1b. 预设包：project.json.preset 必须是生效的属性表 ----------
// WE 的预设壁纸（工坊模板类）把**用户配置**整套存在 `project.json.preset`，
// 而 scene.json 只有作者导出时的默认快照、`general.properties` 为空。此前只读
// general.properties，于是城市名/窗口标题/用户选的 GIF（files/*.gif）全部回落到
// 作者默认值（用户报「下载的预设壁纸预设不生效」）。
{
  const { presetToProperties } = await imp("renderer/vendor/we-scene/scene/parse.js");
  // (a) 形状推断：null 跳过、bool/数值/数值向量/文本各自归类
  {
    const props = presetToProperties({
      city1: "SÃO PAULO", boolv: true, numv: 42, vec: "0.75 0.75 0.75", one: "0", nil: null,
    });
    if (
      props.city1?.type !== "textinput" ||
      props.boolv?.type !== "bool" ||
      props.numv?.type !== "slider" ||
      props.vec?.type !== "color" ||
      props.one?.type !== "slider" ||
      props.nil !== undefined
    ) {
      fail(`presetToProperties 形状推断错误：${JSON.stringify(props)}`);
    } else if (props.city1?.value !== "SÃO PAULO") {
      fail("preset 值必须原样保留");
    } else ok("presetToProperties：null 跳过、bool/数值/向量/文本 各自推断");
  }
  // (b) 真实预设包：preset 值必须覆盖 scene 快照（文本类最直观）
  {
    const d = load("3427522122");
    if (!d) {
      ok("跳过 3427522122（本机无此壁纸）");
    } else {
      const s = parseScene(d.scene, d.proj);
      const texts = s.layers.map((l) => String(l.text ?? ""));
      // preset 的 city1/city2 = SÃO PAULO/TOKYO；作者快照是 TYO/NYC
      if (!texts.includes("SÃO PAULO") && !texts.includes("TOKYO")) {
        fail(`3427522122 应取到 preset 的城市名（SÃO PAULO/TOKYO），实得 ${JSON.stringify(texts.slice(0, 8))}`);
      } else if (texts.includes("NYC")) {
        fail("预设生效时不应再出现作者默认快照 NYC（说明 preset 没覆盖快照）");
      } else {
        ok("3427522122：preset 的城市名覆盖了作者默认快照（preset 属性表生效）");
      }
    }
  }
}

// ---------- 2. 撞车项必须退回快照 ----------
// 每条都是全库扫出来的真实撞车：字段期望的类型与属性声明的类型对不上。
//
// 注意这里**不能只断言「类型没坏」** —— parseBool/parseNum 会做强制转换
// （parseBool 对非 bool 走 `!!v.value`、parseNum 走 `Number(v.value)`），
// 所以即使撞车值漏进去，visible 照样是个 boolean、origin 照样是有限数。
// 首版守卫就是这么写的，去掉形状检查后**依然全绿**（已破坏性验证）。
// 判据必须落在「强制转换之后仍然不同」的量上。
{
  // 3292361861：6 个图层的 parallaxDepth(vec2) 绑到 bool 属性 newproperty54。
  // 快照 "1.00000 1.00000" → [1,1]（有视差）；属性 true → parseVec2 得 [0,0]（视差没了）。
  // 这是撞车项里唯一能穿过强制转换、真正改变画面的可观测量。
  const d = load("3292361861");
  if (!d) {
    ok("跳过 3292361861（本机无此壁纸）");
  } else {
    const s = parseScene(d.scene, d.proj);
    const nz = s.layers.filter((l) => l.parallaxDepth && (l.parallaxDepth[0] || l.parallaxDepth[1]));
    const ones = nz.filter((l) => l.parallaxDepth[0] === 1 && l.parallaxDepth[1] === 1);
    if (ones.length < 6) {
      fail(`3292361861 只有 ${ones.length} 层 parallaxDepth==[1,1]，应为 6 层`
        + "（parallaxDepth 是 vec2 却绑在 bool 属性 newproperty54 上：漏用属性表的 true"
        + " 会被 parseVec2 解成 [0,0]，这 6 层的视差直接消失）");
    } else ok(`3292361861 六个 vec2-绑-bool 的撞车层仍保有视差 [1,1]（共 ${nz.length} 层非零）`);
  }

  // 其余撞车样本：至少保证强制转换后的类型没被污染（兜底，非主判据）
  const cases = [
    ["3078285611", "visible", "bool", "绑到 color 属性"],
    ["3521337568", "x", "num", "绑到 bool 属性"],
    ["3233141951", "visible", "bool", "绑到 slider 属性"],
  ];
  let checked = 0;
  for (const [id, field, want, why] of cases) {
    const d2 = load(id);
    if (!d2) continue;
    let s;
    try { s = parseScene(d2.scene, d2.proj); } catch (e) {
      fail(`${id} parseScene 抛错：${e.message}`);
      continue;
    }
    checked++;
    for (const l of s.layers) {
      const v = field === "visible" ? l.visible
        : field === "x" ? (Array.isArray(l.origin) ? l.origin[0] : undefined)
          : undefined;
      if (v === undefined) continue;
      if (want === "bool" && typeof v !== "boolean") {
        fail(`${id} 图层「${l.name}」的 ${field} 解出 ${JSON.stringify(v)}（${why}）`
          + " —— 撞车项必须退回场景快照，不能替换成属性表的值");
        break;
      }
      if (want === "num" && !Number.isFinite(v)) {
        fail(`${id} 图层「${l.name}」的 ${field} 解出 ${JSON.stringify(v)}（${why}）`
          + " —— 撞车项必须退回场景快照");
        break;
      }
    }
  }
  if (checked) ok(`${checked} 张撞车样本：字段类型未被属性表污染（visible 仍是 bool、坐标仍是数）`);
}

// ---------- 2b. slider 绑 bool 按 0/非 0 当开关，color 绑 bool 仍退回快照 ----------
{
  if (parseBool(0, true) !== false) fail("parseBool(0, true) 应为 false，不能走默认值 true");
  if (parseBool(1, false) !== true) fail("parseBool(1, false) 应为 true");
  if (parseBool({ value: 0 }, true) !== false) fail("parseBool({value:0}) 应为 false");
  const off = resolveUserValue({ user: "s", value: true }, { s: { type: "slider", value: 0 } });
  if (off !== false) fail(`slider=0 绑 bool 应解成 false，实得 ${JSON.stringify(off)}`);
  const on = resolveUserValue({ user: "s", value: true }, { s: { type: "slider", value: 1 } });
  if (on !== true) fail(`slider=1 绑 bool 应解成 true，实得 ${JSON.stringify(on)}`);
  const color = resolveUserValue({ user: "c", value: true }, { c: { type: "color", value: "1 0 0" } });
  if (color !== true) fail(`color 绑 bool 必须退回快照 true，实得 ${JSON.stringify(color)}`);
  ok("slider 绑 bool 按 0/非 0 解；color 绑 bool 仍退回快照");

  const d = load("3233141951");
  if (d) {
    const s = parseScene(d.scene, d.proj);
    const crane = s.layers.find((l) => l.name === "朱鹤");
    const vis = crane && crane.animationLayers && crane.animationLayers[0] && crane.animationLayers[0].visible;
    if (typeof vis !== "boolean") fail(`3233141951 朱鹤 animationlayers.visible 解出 ${JSON.stringify(vis)}，应为 bool`);
    else if (vis !== true) fail("3233141951 默认飞龙动画 slider=1，朱鹤动画层应 visible");
    else ok("3233141951 朱鹤动画层 visible 默认 true（slider=1）");
  }
}

// 1425503532 Pac-Man：三层 instanceoverride.colorn 绑用户颜色。快照是存盘四舍五入
// （"1.00000 0.96863 0.14902"），属性表是完整小数；读错一侧颜色滑块就不跟默认值。
{
  const d = load("1425503532");
  if (!d) {
    ok("跳过 1425503532（本机无此壁纸）");
  } else {
    const s = parseScene(d.scene, d.proj);
    const expect = {
      pacman: d.proj.general.properties.pacmancolor.value,
      ghost1: d.proj.general.properties.ghost1color.value,
      ghost2: d.proj.general.properties.ghost2color.value,
    };
    for (const [name, want] of Object.entries(expect)) {
      const layer = s.layers.find((l) => l.name === name);
      const raw = layer && layer.instanceoverride && layer.instanceoverride.colorn;
      const got = raw && typeof raw === "object" && "value" in raw ? raw.value : raw;
      if (!layer) fail(`1425503532 没有「${name}」层`);
      else if (got !== want) {
        fail(`1425503532 ${name}.colorn 解出 ${JSON.stringify(got)}，应为属性表 ${JSON.stringify(want)}`);
      }
    }
    if (!errors.some((e) => String(e).includes("1425503532"))) {
      ok("1425503532 pacman/ghost colorn 解到属性表颜色（不是存盘快照）");
    }

    // 热更：改 pacmancolor 后必须 reapplyOverride，否则 PS._ov.color 停在挂载值
    const { ParticleSystem } = await imp("renderer/vendor/we-scene/render/particles.js");
    const pac = s.layers.find((l) => l.name === "pacman");
    if (pac?.instanceoverride && ParticleSystem) {
      const ps = new ParticleSystem(null, { maxcount: 8, emitter: [] }, pac.instanceoverride, pac);
      const before = (ps._ov.color || []).map((n) => Number(n));
      const live = flattenUserProperties(s.properties);
      mergeUserPropertyValues(s.properties, live, { pacmancolor: { value: "0 1 0" } });
      resolveUserProps(pac.srcObject, s.properties, 0);
      if (typeof ps.reapplyOverride !== "function") {
        fail("ParticleSystem 必须有 reapplyOverride（instanceoverride 热更入口）");
      } else {
        ps.reapplyOverride();
        const after = ps._ov.color || [];
        if (!(Math.abs(Number(after[1]) - 1) < 1e-6 && Math.abs(Number(after[0])) < 1e-6)) {
          fail(`热更 pacmancolor→绿 后 _ov.color 应为 [0,1,0]，实得 ${JSON.stringify(after)}（改前 ${JSON.stringify(before)}）`);
        } else {
          ok("1425503532 pacmancolor 热更经 reapplyOverride 写入 _ov.color");
        }
      }
    }
  }
}

{
  const d = load("3233141951");
  if (!d) {
    ok("跳过 3233141951 鼠标层（本机无此壁纸）");
  } else {
    const s = parseScene(d.scene, d.proj);
    const mouse = s.layers.find((l) => l.name === "鼠标");
    if (!mouse) fail("3233141951 没有「鼠标」层");
    else if (mouse.visible !== true) fail(`3233141951 鼠标层 visible 解出 ${JSON.stringify(mouse.visible)}，newproperty9 默认 true`);
    else if (!mouse.particle || !String(mouse.particle).includes("Cherry_Blossoms")) {
      fail(`3233141951 鼠标层粒子应是樱花预设，实得 ${mouse.particle}`);
    } else ok("3233141951 鼠标层 visible 默认 true（樱花轨迹开）");
  }
}

// ---------- 3. 全库兜底：解析后所有几何量/开关的类型仍然正确 ----------
{
  let parsed = 0;
  const bad = [];
  for (const id of ids) {
    const d = load(id);
    if (!d) continue;
    let s;
    try { s = parseScene(d.scene, d.proj); } catch (e) {
      bad.push(`${id} parseScene 抛错：${e.message}`);
      continue;
    }
    parsed++;
    for (const l of s.layers) {
      if (typeof l.visible !== "boolean") bad.push(`${id}「${l.name}」visible 非 bool：${JSON.stringify(l.visible)}`);
      for (const [nm, v] of [["origin", l.origin], ["scale", l.scale], ["size", l.size]]) {
        if (!Array.isArray(v) || v.some((x) => !Number.isFinite(x))) {
          bad.push(`${id}「${l.name}」${nm} 含非有限数：${JSON.stringify(v)}`);
        }
      }
      if (!Number.isFinite(l.alpha)) bad.push(`${id}「${l.name}」alpha 非数：${JSON.stringify(l.alpha)}`);
    }
  }
  if (bad.length) {
    fail(`全库解析后有 ${bad.length} 处类型异常，前 5 条：`);
    bad.slice(0, 5).forEach((b) => fail("    " + b));
  } else ok(`全库 ${parsed} 个壁纸解析后几何量/开关类型全部正确`);
}

// ---------- 4. 实现必须真的按属性表优先接线 ----------
// 判据是「属性表分支存在且不被 userOverridden 门住」，不是看有没有出现某个词。
{
  // resolveUserValue 已拆至 user-props.js（engineering/modularization 拆分），文本断言随函数走
  const src = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/scene/user-props.js"), "utf8");
  const fn = src.slice(src.indexOf("function resolveUserValue"));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 3);
  if (!body) fail("找不到 resolveUserValue，用例失效");
  else {
    // 旧实现的特征：唯一的 p.value 返回被 p.userOverridden 门住
    const returnsProp = /return\s+p\.value/.test(body);
    if (!returnsProp) fail("resolveUserValue 不再返回属性表的值（回退成只读快照，开窗又会变小）");
    // 形状检查必须在（否则撞车项会被污染）
    if (!/valueShape\(/.test(body) || !/propShape\(/.test(body)) {
      fail("resolveUserValue 缺少形状检查（撞车项会被属性表污染，如 visible 变成颜色字符串）");
    }
  }
}

// ---------- 5. 热更：不重 parseScene，只 merge + resolve 就要让效果常量变 ----------
// 2854083091 的 xray size 绑 xraysize。挂载后再把滑条打到 10，必须就地写回包装的
// .value；否则只能靠整包重挂，暂停恢复/改属性会再拉一遍 100MB+ scene.pkg。
{
  const d = load("2854083091");
  if (!d) {
    ok("跳过热更 2854083091（本机无此壁纸）");
  } else {
    const sceneJson = JSON.parse(JSON.stringify(d.scene));
    const proj = JSON.parse(JSON.stringify(d.proj));
    const s = parseScene(sceneJson, proj);
    let found = null;
    for (const l of s.layers) {
      for (const e of l.effects || []) {
        for (const p of e.passes || []) {
          const cv = p.constantshadervalues;
          if (cv && "size" in cv) found = cv.size;
        }
      }
    }
    const live = flattenUserProperties(s.properties);
    const liveRef = live;
    mergeUserPropertyValues(s.properties, live, { xraysize: { value: 10 } });
    if (live !== liveRef) fail("mergeUserPropertyValues 换了 live 对象（沙箱持有的引用会停在旧值）");
    if (live.xraysize !== 10) fail(`live.xraysize=${JSON.stringify(live.xraysize)}，应为 10`);
    for (const l of s.layers) {
      if (l.srcObject) resolveUserProps(l.srcObject, s.properties, 0);
    }
    const val = found && typeof found === "object" ? found.value : found;
    if (found === null) fail("热更：2854083091 没找到 xray size（用例失效）");
    else if (Math.abs(Number(val) - 10) > 1e-6) {
      fail(`热更后 xray size 仍是 ${JSON.stringify(val)}，应为 10（没就地解 {user,value}）`);
    } else ok("热更：2854083091 不重 parseScene 即可把 xray size 从 1 改到 10");
  }
}

// ---------- 6. combo 条件绑定 {user:{name,condition}}（2388299037 TV Screen）----------
// visible.user 可以是对象：{ name: "game", condition: "3" }，语义是
// 字段值 = (属性现值 == condition)。旧实现只认字符串 user，parseBool 吃快照，
// 默认 Donkey Kong 碰巧对，切 Space Invaders / Mario 没反应。
{
  const wrap = { user: { name: "game", condition: "3" }, value: true };
  const props = { game: { type: "combo", value: "3", options: [{ value: "1" }, { value: "3" }, { value: "6" }] } };
  const hit = resolveUserValue(wrap, props);
  if (hit !== true) fail(`combo 条件 3==3 应 true，实得 ${JSON.stringify(hit)}`);
  props.game.value = "1";
  const miss = resolveUserValue(wrap, props);
  if (miss !== false) fail(`combo 条件 1==3 应 false（不能吃快照 true），实得 ${JSON.stringify(miss)}`);
  props.game.value = 3;
  const coerced = resolveUserValue(wrap, props);
  if (coerced !== true) fail(`combo 数字 3 == 条件 "3" 应 true，实得 ${JSON.stringify(coerced)}`);
  if (boundUserName(wrap) !== "game") fail(`boundUserName 条件绑定应返回 game，实得 ${JSON.stringify(boundUserName(wrap))}`);
  if (boundUserName({ user: "clock", value: true }) !== "clock") fail("boundUserName 字符串绑定回归");
  ok("combo 条件绑定：等值 true、切档 false、数字/字符串同值、boundUserName 认 name");

  const src = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/scene/user-props.js"), "utf8");
  if (!/v\.user\.condition/.test(src) || !/userBindName/.test(src)) {
    fail("user-props 必须实现 user.condition 等值绑定（只改测试会绿）");
  }

  const d = load("2388299037");
  if (!d) {
    ok("跳过 2388299037（本机无此壁纸）");
  } else {
    const names = (s, vis) => s.layers.filter((l) => l.visible === vis).map((l) => l.name);
    const sDef = parseScene(JSON.parse(JSON.stringify(d.scene)), JSON.parse(JSON.stringify(d.proj)));
    if (!names(sDef, true).includes("Donkey Kong")) fail("2388299037 默认 game=3 应显示 Donkey Kong");
    if (names(sDef, true).includes("Space invaders")) fail("2388299037 默认不应显示 Space invaders");
    if (names(sDef, true).includes("Mario bros")) fail("2388299037 默认不应显示 Mario bros");

    const projInv = JSON.parse(JSON.stringify(d.proj));
    projInv.general.properties.game.value = "1";
    const sInv = parseScene(JSON.parse(JSON.stringify(d.scene)), projInv);
    if (!names(sInv, true).includes("Space invaders")) {
      fail("2388299037 game=1 应显示 Space invaders（读快照的话仍是 Donkey Kong）");
    }
    if (names(sInv, true).includes("Donkey Kong")) fail("2388299037 game=1 应隐藏 Donkey Kong");

    const live = flattenUserProperties(sDef.properties);
    mergeUserPropertyValues(sDef.properties, live, { game: { value: "6" } });
    for (const l of sDef.layers) {
      if (!l.srcObject) continue;
      resolveUserProps(l.srcObject, sDef.properties, 0);
      const uVis = boundUserName(l.srcObject.visible);
      if (uVis === "game") l.visibleSelf = parseBool(l.srcObject.visible, true);
    }
    {
      const byId = new Map();
      for (const l of sDef.layers) byId.set(l.id, l);
      for (const l of sDef.layers) {
        let vis = l.visibleSelf !== false;
        let p = l.parentId;
        for (let g = 0; vis && p != null && g < 64; g++) {
          const parent = byId.get(p);
          if (!parent) break;
          if (parent.visibleSelf === false) vis = false;
          p = parent.parentId;
        }
        l.visible = vis;
      }
    }
    if (!names(sDef, true).includes("Mario bros")) fail("热更 game=6 应显示 Mario bros");
    if (names(sDef, true).includes("Donkey Kong")) fail("热更 game=6 应隐藏 Donkey Kong");
    ok("2388299037 TV Screen：默认 DK、game=1 切 Space Invaders、热更 game=6 切 Mario");
  }
}

// ---------- 7. 父 scale 一律传播给子层（2026-09-20 用 Mirage 出帧纠正）----------
// 旧判据「渲染惰性纯容器（无 image/size）且 scale 运行时绑定时不传播」已被推翻：
//   `Mirage SceneWallpaper --resolution 1280x720` 出帧实测，3264246690 人物剪影
//   （阈值 r,g,b<50）宽 756px / 暗像素 107953；本渲染器若按旧判据（子层自身
//   0.54881、不乘父 1.43）只有 520px / 54250，传播后同为 1.43 倍。即 WE 确实把
//   无名组 373 的 1.43 乘进子层（0.54881×1.43=0.7848）。
// 同一条旧判据还让 3448845950 的媒体卡片少了 0.6（作者把整卡片的位移/尺寸挂在
// 无名组 189 上，卡片偏右 13% 且放大 1.67 倍）。对照组 3789007480 Clock 必须照旧。
{
  const expect = (id, name, origin, scale) => {
    const d = load(id);
    if (!d) {
      ok(`跳过 ${id}（本机无此壁纸）`);
      return;
    }
    const s = parseScene(JSON.parse(JSON.stringify(d.scene)), JSON.parse(JSON.stringify(d.proj)));
    const l = s.layers.find((x) => x.name === name);
    if (!l) {
      fail(`${id} 找不到图层 ${name}（用例失效）`);
      return;
    }
    for (let i = 0; i < 2; i++) {
      if (Math.abs(l.origin[i] - origin[i]) > 1e-3) {
        fail(`${id} ${name} origin[${i}]=${l.origin[i]}，应为 ${origin[i]}（父 scale 没传播？）`);
      }
      if (Math.abs(l.scale[i] - scale[i]) > 1e-6) {
        fail(`${id} ${name} scale[${i}]=${l.scale[i]}，应为 ${scale[i]}（父 scale 没传播？）`);
      }
    }
  };
  // 376 无名组 373：origin (2560,710) × scale 1.43 → 子层 (431.91931,-119.38083)×0.54881
  expect("3264246690", "1拆分", [3177.6446133, 539.2854131, 0], [0.7847983, 0.7847983, 0.7847983]);
  expect("3789007480", "D a y", [17.292578, 113.583056, 0], [0.816664, 0.807326, 0.683486]);
  // 3448845950 媒体卡片无名组 189：origin (2173,850) × scale 0.6 → 长条框 (723.09424,-218)×1
  expect("3448845950", "长条框", [2173 + 723.09424 * 0.6, 850 - 218 * 0.6, 0], [0.6, 0.6, 0.6]);
  ok("父 scale 一律传播：3264246690 人物 0.54881×1.43（Mirage 出帧标定）、3448845950 卡片组 0.6 生效、Clock 不受影响");
}

// getEntry 必须是 pkg.buf 上的视图。slice() 复制会让 125MB 包在装贴图时再占一份。
{
  const id = fs.existsSync(join(LIB, "2854083091", "scene.pkg"))
    ? "2854083091"
    : ids[0];
  if (!id) {
    ok("跳过 getEntry 零拷贝（本机无场景壁纸）");
  } else {
    const pkg = parsePkg(new Uint8Array(fs.readFileSync(join(LIB, id, "scene.pkg"))));
    const e = getEntry(pkg, "scene.json");
    if (!e) fail(`${id} 没有 scene.json`);
    else if (e.buffer !== pkg.buf.buffer) {
      fail("getEntry 返回了副本（.slice()），大 pkg 会再拷一遍整段入口");
    } else ok(`getEntry 零拷贝（${id} scene.json 与 pkg.buf 同 ArrayBuffer）`);
  }
}

// ---------- 8. 语言/combo 热切：隐藏变体也要装配粒子；visible 绑定不能因拖拽脚本跳过 ----------
// 3299228616：6 套 LonelyCAT * 根层绑 language；默认只亮 ENG。旧装配
// `if (!layer.particle || !layer.visible) continue` 会跳过另外 5 套的星星/萤火虫，
// 热切语言后图层 visible 对了但 particleSystemsByLayer 里没有对应 id → 组件消失，
// 只有整包重载（按新 language 重新 parse，隐藏层变可见再装粒子）才正常。
// 另：Clock Layer 的 visible 同时有 user 条件绑定 + 拖拽脚本；applyLiveProps 若
// 「有 visible 脚本就跳过写 visibleSelf」，整表热更时 clocklocation* 永远写不回。
{
  const mount = fs.readFileSync(join(ROOT, "renderer/src/scene-mount.ts"), "utf8");
  if (/!layer\.particle\s*\|\|\s*!layer\.visible/.test(mount) || /!layer\.particle \|\| !layer\.visible/.test(mount)) {
    fail("scene-mount 不得因 !layer.visible 跳过粒子装配（语言变体热切会丢粒子）");
  }
  if (/if\s*\(\s*!layer\.particle\s*\|\|\s*!layer\.visible/.test(mount)) {
    fail("scene-mount 粒子循环不得带 !layer.visible 短路");
  }
  // 更稳：粒子循环附近不应再出现「particle 且 visible」双条件
  const partBlock = mount.match(/if\s*\(!SKIP_PARTICLES\)\s*\{[\s\S]{0,400}?for\s*\(const layer of scene\.layers\)\s*\{[\s\S]{0,200}?continue/);
  if (partBlock && /visible/.test(partBlock[0])) {
    fail("scene-mount 粒子装配循环不得再按 visible 过滤");
  }
  if (/const scripted = !!\(layer\.objectScripts/.test(mount) && /if\s*\(!scripted\)\s*layer\.visibleSelf/.test(mount)) {
    fail("applyLiveProps 不得因存在 visible 对象脚本就跳过 user 绑定写 visibleSelf");
  }
  if (!/reapplyOverride/.test(mount)) {
    fail("applyLiveProps 必须对 instanceoverride 热更调用 reapplyOverride（粒子颜色/数量滑条）");
  }
  if (!/ps\.setVisible\(!!layer\.visible\)/.test(mount) && !/setVisible\(!!layer\.visible\)/.test(mount)) {
    fail("applyLiveProps / 装配必须按 layer.visible 同步粒子 setVisible");
  }
  ok("scene-mount：隐藏层也装粒子；热更 visible 绑定不被拖拽脚本短路；粒子 override/显隐可热更");

  const d = load("3299228616");
  if (!d) {
    ok("跳过 3299228616（本机无此壁纸）");
  } else {
    const s = parseScene(JSON.parse(JSON.stringify(d.scene)), JSON.parse(JSON.stringify(d.proj)));
    const byId = new Map(s.layers.map((l) => [l.id, l]));
    const rootOf = (l) => {
      let p = l;
      while (p.parentId != null) {
        const n = byId.get(p.parentId);
        if (!n) break;
        p = n;
      }
      return p;
    };
    const engP = s.layers.filter((l) => l.particle && rootOf(l).name === "LonelyCAT ENG");
    const cnP = s.layers.filter((l) => l.particle && rootOf(l).name === "LonelyCAT CN");
    const hidP = s.layers.filter((l) => l.particle && !l.visible);
    if (engP.length < 1) fail("3299228616 默认 ENG 应有粒子层");
    if (cnP.length !== engP.length) fail(`3299228616 CN 粒子层数应与 ENG 相同，ENG=${engP.length} CN=${cnP.length}`);
    if (hidP.length < engP.length) fail(`3299228616 默认应有隐藏语言的粒子层（≥${engP.length}），实得 ${hidP.length}`);
    // 热更 language→3：CN 根亮、ENG 灭；CN 粒子层有效 visible 必须为 true
    const live = flattenUserProperties(s.properties);
    mergeUserPropertyValues(s.properties, live, { language: { value: "3" } });
    for (const l of s.layers) {
      if (!l.srcObject) continue;
      resolveUserProps(l.srcObject, s.properties, 0);
      const uVis = boundUserName(l.srcObject.visible);
      if (uVis === "language") l.visibleSelf = parseBool(l.srcObject.visible, true);
    }
    {
      for (const l of s.layers) {
        let vis = l.visibleSelf !== false;
        let p = l.parentId;
        for (let g = 0; vis && p != null && g < 64; g++) {
          const parent = byId.get(p);
          if (!parent) break;
          if (parent.visibleSelf === false) vis = false;
          p = parent.parentId;
        }
        l.visible = vis;
      }
    }
    const cnRoot = s.layers.find((l) => l.name === "LonelyCAT CN");
    const engRoot = s.layers.find((l) => l.name === "LonelyCAT ENG");
    if (!cnRoot?.visible) fail("热更 language=3 后 LonelyCAT CN 应可见");
    if (engRoot?.visible) fail("热更 language=3 后 LonelyCAT ENG 应隐藏");
    const cnPVis = s.layers.filter((l) => l.particle && l.visible && rootOf(l).name === "LonelyCAT CN");
    if (cnPVis.length !== engP.length) {
      fail(`热更后 CN 可见粒子应有 ${engP.length} 层，实得 ${cnPVis.length}（装配仍跳过隐藏层的话重载才有）`);
    }
    ok("3299228616：默认隐藏语言粒子存在；热更 language=3 后 CN 根与粒子 visible");
  }
}

// ---------- 11. 场景环境光：材质 LIGHTING combo → 图层基色乘有效环境光 ----------
//
// 官方 genericimage2/3/4（genericparticle 另有 DOUBLESIDEDLIGHTING）在
// `#if LIGHTING` 时的结果 = **环境光 + 4 盏灯的直射光**：
//   ambient = max(vec3(0.001), g_LightAmbientColor) × albedo         ← 本节
//   light   = Σ 灯 (diffuse·albedo/π + specular) × radiance × max(dot(N,L),0)
//             （radiance 两代衰减见第 12 节）                        ← 第 12 节
//   c.rgb   = CombineLighting(light, ambient)（HDR 时对 >2 的部分加权）
// `g_LightAmbientColor = min(1, ambientcolor×π)`（2026-09-18 实测标定，
// 3737267090「整体太黑」：raw 0.3 直乘压暗 70%；详见 CASEBOOK「环境光 π 标定」）。
//
// **2026-10-12 修正**：本节早先写成「无直射灯（本仓不跑 PBR）」，那是 2026-09-24
// 接线**之前**的结论，现已不成立 —— 场景灯光对象已接线，图片层走
// renderer-glsl.js 的 COPY_LIT_FRAG（直射光那一半），本节只负责环境光那一半。
// 判据见 scripts/verify-props.mjs 第 12 节（形状/几何/通道/台账）+ 第 15 节
// （实际数值非零的正例夹具）；口径与 renderer/vendor/we-scene/headers.ts:398-418
// 的实现描述一致（那里同时提醒：`PerformLighting_V1` 只覆盖**效果 pass** 那条路，
// 那条路上直射项仍是 0，别按它判断整库直射光）。
//
// 环境光侧的证据：环境光是**乘子**（layerColorAmbient）、纯函数，故数值判据在这一节；
// 直射光是**在着色器里求值的**，故数值判据在第 12 节（形状）与第 15 节（合成夹具）。
// 语料锁：台账见下方 2026-10-06 更新（57 pass / 14 张），数量变了要人看一眼；
// 这条断言同时守住「不要给未开光照的材质全局压暗」的回归红线。
{
  const renderer = await imp("renderer/vendor/we-scene/render/renderer.js");
  const near3 = (a, b, eps = 1e-6) => a.every((x, i) => Math.abs(x - b[i]) <= eps);

  // 纯函数数值语义：min(1, max(0.001, a)×π)
  if (!near3(renderer.layerColorAmbient(false, [0.3, 0.3, 0.3]), [1, 1, 1]))
    fail("未开 LIGHTING 时乘子必须是 [1,1,1]（不能全局压暗 99.9% 材质）");
  if (!near3(renderer.layerColorAmbient(true, [0.3, 0.3, 0.3]), [0.3 * Math.PI, 0.3 * Math.PI, 0.3 * Math.PI]))
    fail("开 LIGHTING 时应逐分量返回 ambientcolor×π（3737267090：raw 0.3 直乘 = 整体太黑）");
  if (!near3(renderer.layerColorAmbient(true, [0, 0, 0]), [0.001 * Math.PI, 0.001 * Math.PI, 0.001 * Math.PI]))
    fail("纯黑 ambient 必须有 0.001 下限（官方 max(0.001, g_LightAmbientColor)）再乘 π");
  if (!near3(renderer.layerColorAmbient(true, [1, 1, 1]), [1, 1, 1]))
    fail("纯白 ambient 必须封顶 1（2894296965 官方 preview/反照率中位 ≈1.03，不是 π≈3.1）");

  // 语料面貌：恰好这 4 张有 LIGHTING=1 的 genericimage* pass（数量变了要人看一眼）
  const litWalls = new Set();
  let litPasses = 0;
  for (const id of ids) {
    let d;
    try {
      const pkg = parsePkg(new Uint8Array(fs.readFileSync(join(LIB, id, "scene.pkg"))));
      for (const e of pkg.entries) {
        if (!e.name.endsWith(".json")) continue;
        let j;
        try { j = JSON.parse(dec.decode(getEntry(pkg, e.name))); } catch { continue; }
        for (const p of j.passes || []) {
          if (p.combos && /genericimage|generic\d|^generic$/.test(String(p.shader || "")) &&
              Number(p.combos.LIGHTING) === 1) {
            litPasses++;
            litWalls.add(id);
          }
        }
      }
    } catch { /* 个别包读取失败不影响 */ }
  }
  // 台账更新（2026-10-06）：本机库新进 2645592994（打刀/短刀 genericimage2），
  // LIGHTING 语料 57 pass / 14 张（2026-09-24 为 55/13，2026-09-18 为 8/4）。这条锁的是
  // **素材面貌**，与代码路径无关 —— 数量再变仍要人看一眼（确认不是 combo 解析把别的材质算进来）。
  if (litPasses !== 57) fail(`LIGHTING=1 的 genericimage pass 应是 57（2026-10-06 台账），实得 ${litPasses}`);
  const expectWalls = [
    "2645592994", "2890473419", "2894296965", "2952574984", "3047405322", "3281559867", "3285446145",
    "3351179520", "3416122407", "3471294034", "3509243656", "3589454154", "3662790108", "3737267090",
  ];
  for (const w of expectWalls) {
    if (!litWalls.has(w)) fail(`LIGHTING 壁纸 ${w} 未扫到（材质路径/combo 解析回退？）`);
  }
  ok(`环境光：${litPasses} 个 LIGHTING pass / ${litWalls.size} 张（${[...litWalls].join(",")}）；乘子语义锁定`);

  // 接线断言：scene-mount 标 lightingEnabled，renderer color4 用它
  const msrc = fs.readFileSync(join(ROOT, "renderer/src/scene-mount.ts"), "utf8");
  if (!/lightingEnabled\s*=\s*true/.test(msrc))
    fail("scene-mount 未把材质 LIGHTING combo 标到 layer.lightingEnabled");
  const rsrc = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/renderer.js"), "utf8");
  if (!/layerColorAmbient\(layer\.lightingEnabled, sceneAmbient\)/.test(rsrc))
    fail("renderer color4 未按 lightingEnabled 乘场景 ambient");
  if (!/sceneAmbient\s*=\s*parseVec3Local\(general\.ambientcolor/.test(rsrc))
    fail("renderer 未在每帧从 general.ambientcolor 读场景环境光");
  if (!/ambient:\s*layerColorAmbient\(layer\.lightingEnabled, sceneAmbient\)/.test(rsrc))
    fail("renderer 未把环境光乘子传给真 3D 网格 puppetDrawFn（3509243656 球体/天空盒）");
  // 真 3D MDL 材质路径（parseMDL.materialPath）也要标 lightingEnabled
  if (!/pass0\?\.combos\?\.LIGHTING/.test(msrc))
    fail("scene-mount 未在静态 MDL 材质解析 LIGHTING combo");
}

// ---------- 12. 场景灯光对象 → LIGHTING 材质的直射光 ----------
//
// **两条通道 × 两代衰减**（2026-09-24 定性；官方 shader 明文与本地语料统计
// 互证，详见 renderer.js
// 顶部的灯光通道注释与 renderer-glsl.js 的 lightRadiance）：
//   - `l*` 前缀（lpoint/lspot/ltube/ldirectional）→ **V1 通道**：
//     `g_LPoint_Color.rgb = color×intensity`、`.w = radius`、`g_LPoint_Origin.w = exponent`，
//     消费方是 generic4/genericimage4 那代材质 —— 官方 PerformLighting_V1 是引擎
//     按场景灯清单**生成**的字符串，正文 = common_pbr_2.h::ComputePBRLightShadow：
//     `radiance = 色 × saturate(1−d/radius)^exponent`（无 1/d²）。
//   - 不带前缀的 `point`（官方 enum=5）→ **老通道**：`g_LightsColorRadius` +
//     `g_LightsPosition`（另发一份预乘 `g_LightsColorPremultiplied = 色×radius²`），
//     消费方 genericimage2 的 common_pbr.h 1/d² ⇒ `色×radius²/d²`。
//
// 现象（2026-09-24 用户报「3737267090 红框框选部分光源太亮」）：把这盏 `lpoint`
// 按老通道公式算，灯正下方辐照度 = 1.79×(2048/609)² ≈ **20** ⇒ 桌面整片饱和，
// bloom 再抹成大白斑（本仓实机 A/B：8.13% 像素亮度 ≥250，灯关掉 0%）。按 V1
// 公式 = 1.79×(1−609/2048)^4 ≈ **0.436**，实机灯心只比关灯亮 +16/255（见 (d)）。
{
  const renderer = await imp("renderer/vendor/we-scene/render/renderer.js");
  const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
  const near3 = (a, b, eps = 1e-6) => a.every((x, i) => Math.abs(x - b[i]) <= eps);

  // (a) V1 通道打包：色 = color×intensity（**不预乘 radius²** —— 那是老通道的
  //     g_LightsColorPremultiplied），radius/exponent 各自随槽走、缺省 1000/2
  //     （官方 LightObject 注册默认，本地语料统计一致）。
  const c1 = renderer.lightColorIntensity({ color: [1, 0.97647, 0.91765], intensity: 1.79 });
  if (!near3(c1, [1.79, 1.7479, 1.6426], 1e-4))
    fail(`V1 颜色槽应为 color×intensity（3737267090 灯 = [1.79,1.748,1.643]），实得 ${c1.map((v) => v.toFixed(4))}`);
  const c2 = renderer.lightColorIntensity({ color: [0.5, 0.25, 0], intensity: 2 });
  if (!near3(c2, [1, 0.5, 0], 1e-9)) fail(`V1 颜色槽应按 color×intensity 逐分量，实得 ${c2}`);
  if (!near3(renderer.lightColorIntensity({ color: [1, 1, 1] }), [1, 1, 1], 1e-9))
    fail("intensity 缺省应为 1（全库有灯壁纸都显式写了或绑了用户属性）");
  if (!near(renderer.lightRadiusOf({}), 1000)) fail(`radius 缺省应为 1000，实得 ${renderer.lightRadiusOf({})}`);
  if (!near(renderer.lightRadiusOf({ lightRadius: 2048 }), 2048)) fail("radius 应读装配侧的 lightRadius");
  if (!near(renderer.lightExponentOf({}), 2)) fail(`exponent 缺省应为官方默认 2，实得 ${renderer.lightExponentOf({})}`);
  if (!near(renderer.lightExponentOf({ exponent: 4 }), 4)) fail("exponent 应读层上的 exponent");

  // (a2) 模型分派表（材质 shader → 公式 + 通道）。这张表错一格就是**整族过曝或整族变黑**：
  //      genericimage2 那代在老通道（吃 `point` 灯 + radius²/d²），generic3/generic4 那代
  //      在 V1 通道（吃 `l*` 灯）但公式不同 —— v0 是 radius²/d²、v1 是 falloff^exponent。
  const modelTable = [
    ["genericimage4", "v1"], ["generic4", "v1"], ["chroma4", "v1"], ["fur4", "v1"],
    ["foliage4", "v1"], ["genericparticle", "v1"], ["genericropeparticle", "v1"],
    ["genericimage3", "v0"], ["generic3", "v0"],
    ["genericimage2", "lit2d"], ["generic", "lit2d"], ["generic2", "lit2d"],
  ];
  for (const [shader, model] of modelTable) {
    const got = renderer.lightModelForShader(shader);
    if (got !== model) fail(`材质 ${shader} 应分派到模型 ${model}，实得 ${got}`);
  }
  const laneTable = [["v1", "v1"], ["v0", "v1"], ["lit2d", "legacy"]];
  for (const [model, lane] of laneTable) {
    const got = renderer.lightLaneForModel(model);
    if (got !== lane) fail(`模型 ${model} 应吃 ${lane} 通道的灯，实得 ${got}`);
  }
  // 灯 → 通道只由类型串的前缀决定（`l*` = V1；`point`/未知 = 老通道）
  {
    const lw = load("3737267090");
    if (lw) {
      const ls = parseScene(lw.scene, lw.proj).layers.filter((l) => l.isLight);
      if (ls.length !== 1) fail(`3737267090 应有 1 盏灯，实得 ${ls.length}`);
      else {
        if (ls[0].lightLane !== "v1") fail(`3737267090 的 lpoint 应进 V1 通道，实得 ${ls[0].lightLane}`);
        if (ls[0].lightType !== "point") fail(`lpoint 的归一化类型仍是 point，实得 ${ls[0].lightType}`);
      }
    }
  }

  // (b) 世界位置：2D 场景 y 取 projH−origin.y（与 layerModelMatrix 同约定）；
  //     透视场景原样。灯与层必须同约定，否则 L 的 z 分量看着对、x/y 反向。
  const w2d = renderer.lightWorldPosition({ origin: [949.56714, 1515.98413, 500] }, { projH: 1440 });
  if (!near3(w2d, [949.56714, 1440 - 1515.98413, 500], 1e-4))
    fail(`2D 场景灯光世界位置应为 [x, projH−y, z]，实得 ${w2d}`);
  const w3d = renderer.lightWorldPosition({ origin: [1, 2, 3] }, { projH: 1440, perspective: true });
  if (!near3(w3d, [1, 2, 3], 1e-9)) fail(`透视场景灯光位置应原样，实得 ${w3d}`);

  // (c) 收集：**按通道过滤**（V1 只收 l*、老通道只收 point/未知），两条通道各自
  //     按对象顺序取前 4 盏；不可见的灯**占槽留零**（官方 continue 不压缩）；
  //     第 5 盏及以后不再进 uniform；radius/exponent 随槽一起走。
  const mkLight = (id, visible, lane = "v1") => ({
    isLight: true, lightLane: lane, id, visible, origin: [id * 100, 0, 0], color: [1, 1, 1], intensity: 1,
    lightRadius: 10 + id, exponent: id,
  });
  const col = renderer.collectSceneLights(
    [{ name: "背景" }, mkLight(1, true), mkLight(2, false), mkLight(3, true), mkLight(4, true), mkLight(5, true)],
    { projH: 100 },
    "v1",
  );
  if (col.count !== 4) fail(`最多 4 盏灯进 uniform，实得 ${col.count}`);
  if (!near3([col.colors[3], col.colors[4], col.colors[5]], [0, 0, 0], 1e-9))
    fail("隐藏的灯必须占槽留零（否则后面的灯会顶到它的槽位，槽序与官方不一致）");
  if (!near3([col.colors[6], col.colors[7], col.colors[8]], [1, 1, 1], 1e-9))
    fail("第 3 盏可见灯应落在自己的槽位（槽位不得因隐藏灯而压缩）");
  if (!near(col.positions[9], 400, 1e-6) || !near(col.colors[9], 1, 1e-9))
    fail("第 4 盏灯应落在最后一槽（id 4）");
  if (!near(col.radii[0], 11, 1e-6) || !near(col.exponents[3], 4, 1e-6))
    fail(`radius/exponent 必须随灯进槽（实得 r=${col.radii[0]} e=${col.exponents[3]}）`);
  if (!near3([col.positions[3], col.positions[4], col.positions[5]], [0, 0, 0], 1e-9))
    fail("隐藏灯的槽位位置也该留零");
  const col5 = renderer.collectSceneLights(
    [mkLight(1, true), mkLight(2, true), mkLight(3, true), mkLight(4, true), mkLight(5, true)],
    { projH: 100 },
    "v1",
  );
  if (col5.count !== 4) fail(`5 盏灯时仍只该喂 4 槽，实得 ${col5.count}`);
  if (!near(col5.positions[9], 400, 1e-6)) fail("第 5 盏灯不得顶掉第 4 槽（官方上限 4）");
  // 通道互斥：老通道的 point 灯不得出现在 V1 包里（反之亦然）—— 官方两个 packer
  // 按 [light+0x2c0] 分派，混进去就是「用错公式的那一族又被点亮了」。
  const mixLights = [mkLight(1, true, "legacy"), mkLight(2, true, "v1")];
  const v1only = renderer.collectSceneLights(mixLights, { projH: 100 }, "v1");
  const legacyOnly = renderer.collectSceneLights(mixLights, { projH: 100 }, "legacy");
  if (v1only.count !== 1 || legacyOnly.count !== 1)
    fail(`两条通道必须各自只收本通道的灯（实得 v1=${v1only.count} legacy=${legacyOnly.count}）`);
  if (!near(v1only.positions[0], 200, 1e-6) || !near(legacyOnly.positions[0], 100, 1e-6))
    fail("两条通道各自打包时不得越界取到别通道的灯");
  // 老装配/离线夹具没带 lightLane 时按 V1 收（缺省通道，见 collectSceneLights）
  if (renderer.collectSceneLights([{ isLight: true, origin: [0, 0, 0], color: [1, 1, 1] }], { projH: 10 }).count !== 1)
    fail("无 lightLane 字段的灯应落缺省 V1 通道（旧夹具兼容）");

  // (d) 语料一：2890473419 的三盏 **point**（老通道）+ genericimage2 材质
  //     —— 这族的模型是 radius²/d²，本次改动对它零行为差（灯进老通道、公式不变）。
  const LW = load("2890473419");
  if (LW) {
    const scene = parseScene(LW.scene, LW.proj);
    const lights = scene.layers.filter((l) => l.isLight);
    if (lights.length !== 3) fail(`2890473419 应有 3 盏灯（scene.json 对象 19/22/26），实得 ${lights.length}`);
    const byId = new Map(lights.map((l) => [l.id, l]));
    const l1 = byId.get(19), l2 = byId.get(22), l3 = byId.get(26);
    if (!l1 || !l2 || !l3) fail("2890473419 灯具对象 id 应为 19/22/26");
    else {
      if (lights.some((l) => l.lightType !== "point")) fail("2890473419 三盏灯都应是 point");
      if (lights.some((l) => l.lightLane !== "legacy"))
        fail("2890473419 的 point 灯应进老通道（不带 l 前缀 = 官方 enum 5 的 4 槽通道）");
      if (!near3(l1.color, [0.32941, 0.27059, 0.97255], 1e-4))
        fail(`光源1 颜色应取用户属性 _1（0.329 0.271 0.973），实得 ${l1.color}`);
      if (!near3(l2.color, [0.4549, 0.14118, 0.34902], 1e-4))
        fail(`光源2 颜色应取用户属性 _2，实得 ${l2.color}`);
      if (!near3(l3.color, [1, 1, 1], 1e-6)) fail(`光源3 颜色应取用户属性 _3（白），实得 ${l3.color}`);
      for (const [name, l] of [["光源1", l1], ["光源2", l2], ["光源3", l3]]) {
        if (l.lightRadius !== 2048) fail(`${name} 亮度（radius）应取用户属性（2048），实得 ${l.lightRadius}`);
        if (l.intensity !== 1) fail(`${name} intensity 快照应为 1，实得 ${l.intensity}`);
      }
    }
    // lightingEnabled 由 scene-mount 的材质解析阶段（读 pkg 里的
    // materials/*.json）写到层上，parseScene 本身看不到材质 —— 这里直接查包：
    // 人物层引用 models/101272156_p0.json，该模型指向 LIGHTING=1 的 genericimage2 材质。
    const pkg = parsePkg(new Uint8Array(fs.readFileSync(join(LIB, "2890473419", "scene.pkg"))));
    const matJson = JSON.parse(dec.decode(getEntry(pkg, "materials/101272156_p0.json")));
    const p0 = (matJson.passes || [])[0] || {};
    if (Number(p0.combos && p0.combos.LIGHTING) !== 1)
      fail("2890473419 的 materials/101272156_p0.json 应是 LIGHTING=1 的 genericimage2");
    if (p0.shader !== "genericimage2")
      fail(`2890473419 的 LIGHTING 材质 shader 应是 genericimage2（老通道 + d²），实得 ${p0.shader}`);
    if (renderer.lightModelForShader(p0.shader) !== "lit2d")
      fail("genericimage2 必须分派到 lit2d（老通道 + radius²/d²），否则这族整体偏暗");
    if (p0.constantshadervalues?.metallic !== 0 || p0.constantshadervalues?.roughness !== 0)
      fail(`2890473419 人物材质 metallic/roughness 应声明 0/0（实得 ${JSON.stringify(p0.constantshadervalues)}）`);
    const chUsers = ["124", "13", "82"].filter((id) => {
      const o = (LW.scene.objects || []).find((x) => String(x.id) === id);
      return o && o.image === "models/101272156_p0.json";
    });
    if (chUsers.length !== 3) fail("2890473419 的三个人物层应都引用 models/101272156_p0.json（LIGHTING 材质）");
    if (scene.layers.some((l) => l.isLight && l.lightingEnabled))
      fail("灯对象自身不是 LIGHTING 材质层，不该被标 lightingEnabled");
    // 灯不该被画出来：渲染端跳过「无图无文字无粒子」的灯层
    const rsrc0 = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/renderer.js"), "utf8");
    if (!/if \(layer\.isLight && !layer\.image && !layer\.isText && !layer\.particle && !layer\.isComponent\) return/.test(rsrc0))
      fail("renderer 未跳过纯灯层的绘制（灯不该出现在画面里）");
    ok(`灯光：2890473419 三盏 point 灯（色/亮度/开关全绑用户属性）走老通道，人物层 LIGHTING 材质参数 0/0`);
  }

  // (d2) 语料二：3737267090 的 **lpoint**（V1 通道）+ genericimage4 材质 ——
  //      用户报「红框里光源太亮」的那张。判据 = **两代公式在这盏灯上的辐照度差**：
  //      V1（正确）≈ 0.44，老通道（改动前）≈ 20。这条同时是「改回旧公式会红」
  //      的探针：把 lightModelForShader 的 genericimage4 改成 'lit2d' 立刻翻红。
  //      注：这里的两个数按同一份**真实打包值**（lightColorIntensity / lightRadiusOf
  //      / lightExponentOf）与着色器里的公式形状算 —— 权威判据是 verify-props 的
  //      shader 文本断言 + 实机 A/B（8.13% 饱和像素 → 0%，灯心 +16/255）。
  {
    const lw = load("3737267090");
    if (!lw) ok("3737267090 语料缺失，跳过 V1 通道直射光数值判据");
    else {
      const scene = parseScene(lw.scene, lw.proj);
      const ls = scene.layers.filter((l) => l.isLight);
      if (ls.length !== 1) fail(`3737267090 应有 1 盏灯，实得 ${ls.length}`);
      else {
        const light = ls[0];
        if (light.lightLane !== "v1") fail(`3737267090 的 lpoint 应进 V1 通道，实得 ${light.lightLane}`);
        if (!near(light.lightRadius, 2048, 1e-3)) fail(`灯 radius 应为 2048，实得 ${light.lightRadius}`);
        if (!near(light.exponent, 4, 1e-3)) fail(`灯 exponent 应为 4，实得 ${light.exponent}`);
        if (!near(light.intensity, 1.79, 1e-4)) fail(`灯 intensity 应为 1.79，实得 ${light.intensity}`);
        const projH = Number(scene.general?.orthogonalprojection?.height ?? 2160);
        const wp = renderer.lightWorldPosition(light, { projH });
        if (!near(wp[0], 2748.92871, 1e-3) || !near(wp[1], projH - 609.05267, 1e-3) || !near(wp[2], 609, 1e-3))
          fail(`灯世界位置应为 [2748.93, projH−609.05, 609]，实得 ${wp}`);
        // 灯正下方（层平面 z=0）的辐照度：d 含 z=609 这一份
        const dist = Math.hypot(wp[0] - wp[0], wp[1] - wp[1], wp[2]);
        const c = renderer.lightColorIntensity(light);
        const r = renderer.lightRadiusOf(light);
        const e = renderer.lightExponentOf(light);
        const peakV1 = Math.max(...c) * Math.pow(Math.max(0, 1 - dist / r), e);
        const peakOld = (Math.max(...c) * r * r) / Math.max(dist * dist, 1e-6);
        if (!(peakV1 < 1)) fail(`V1 公式下这盏灯的峰值辐照度应 <1（不过曝），实得 ${peakV1.toFixed(3)}`);
        if (!(peakOld > 10)) fail(`老通道公式在同一点应 >10（改动前过曝的证据），实得 ${peakOld.toFixed(2)}`);
        if (!(peakOld / peakV1 > 30)) fail(`两代公式在这盏灯上应差 30 倍以上（实得 ${(peakOld / peakV1).toFixed(1)}×）`);
        ok(`灯光：3737267090 的 lpoint 走 V1 通道，峰值辐照度 ${peakV1.toFixed(3)}（老通道公式为 ${peakOld.toFixed(1)}，相差 ${(peakOld / peakV1).toFixed(0)} 倍）`);
      }
    }
  }

  // (d3) 全库台账：LIGHTING=1 的材质只出现这四种 shader —— 少一种说明材质解析
  //      变了，多一种（尤其 generic/generic2）说明出现本仓**未实现**的
  //      `saturate(1−d/radius)²` 老式 shader，必须人看一眼别静默套错公式。
  {
    const knownLint = new Set(["genericimage2", "genericimage3", "genericimage4", "generic4"]);
    const seen = new Map();
    for (const id of ids) {
      const p = join(LIB, id, "scene.pkg");
      let pkg;
      try { pkg = parsePkg(new Uint8Array(fs.readFileSync(p))); } catch { continue; }
      for (const e of pkg.entries || pkg) {
        const name = e.name ?? e.path;
        if (!/^materials\/.*\.json$/.test(name)) continue;
        let txt;
        try { txt = dec.decode(getEntry(pkg, name)); } catch { continue; }
        if (!/"LIGHTING"\s*:\s*1/.test(txt)) continue;
        for (const m of txt.matchAll(/"shader"\s*:\s*"([^"]+)"/g)) {
          if (!seen.has(m[1])) seen.set(m[1], id);
        }
      }
    }
    for (const [shader, id] of seen) {
      if (!knownLint.has(shader))
        fail(`LIGHTING 材质出现未建模的 shader "${shader}"（${id}）：先确认它吃哪条通道、用哪代衰减，再补 lightModelForShader`);
    }
    if (seen.size) ok(`灯光模型台账：LIGHTING 材质的 shader = ${[...seen.keys()].sort().join("/")}`);
  }

  // (e) 效果链底图的「局部 → 世界」矩阵（2890473419 实测踩过：合成顺序写反，
  //     平移量被缩放吞掉，片元世界坐标偏半个层宽/高 → 灯距离高估 ~1.5 倍、
  //     人物只亮一点点，画面看起来"像是对了"，没有这条断言就发现不了）。
  // 判据用真实实现函数 litBaseLocalToWorld：局部四角必须落在层世界矩形的四角。
  const math = await imp("renderer/vendor/we-scene/render/math.js");
  {
    const { mat4Identity, mat4Translate, mat4Scale, mat4RotateZ, mat4Multiply, mat4TransformPoint } = math;
    const w = 691.84, h = 1380;                       // 层 82 实测：size1504×scale0.46
    let world = mat4Translate(mat4Identity(), 1720, 723.64, 0);
    world = mat4RotateZ(world, 0.3);                  // 带一个 Z 旋转，顺序错就露馅
    world = mat4Scale(world, w, h, 1);
    const l2w = renderer.litBaseLocalToWorld(world, 692, 1380);
    const p00 = mat4TransformPoint(l2w, 0, 0, 0);
    const p11 = mat4TransformPoint(l2w, 692, 1380, 0);
    const mid = mat4TransformPoint(l2w, 346, 690, 0);
    const c = Math.cos(0.3), s = Math.sin(0.3);
    // 局部 (0,0) 对应「层原点 + R·(−w/2,−h/2)」；局部中心对应层原点。
    const rot = (x, y) => [c * x - s * y, s * x + c * y];
    const r00 = rot(-w / 2, -h / 2);
    const exp00 = [1720 + r00[0], 723.64 + r00[1]];
    const expMid = [1720, 723.64];
    const near2 = (a, b, eps = 1e-3) => Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps;
    if (!near2(p00, exp00, 0.02))
      fail(`LIGHTING 底图局部→世界：局部(0,0) 应落在层世界角 ${exp00.map((v) => v.toFixed(2))}，实得 ${p00.slice(0, 2).map((v) => v.toFixed(2))}（mat4Translate/Scale 是右乘，合成顺序写反就会偏半个层宽/高）`);
    if (!near2(mid, expMid, 0.02))
      fail(`LIGHTING 底图局部→世界：局部中心应落在层原点 ${expMid}，实得 ${mid.slice(0, 2).map((v) => v.toFixed(2))}`);
    if (Math.abs((p11[0] - p00[0]) ** 2 + (p11[1] - p00[1]) ** 2 - (w * w + h * h)) > 1)
      fail("LIGHTING 底图局部→世界：对角线长度应等于层世界矩形对角线（缩放没丢）");
    // 渲染端必须走这个函数（别在调用点手搓 toUnit）
    const rsrcL = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/renderer.js"), "utf8");
    if (!/bindLitUniforms\(litBaseLocalToWorld\(layerWorldModelMatrix\(layer, cam\), fboW, fboH\), layer\)/.test(rsrcL))
      fail("效果链底图未用 litBaseLocalToWorld 造光照矩阵（手搓 toUnit 极易把合成顺序写反）");
  }

  // (f) 接线断言：着色器是官方公式的形状；渲染端把灯喂给 LIGHTING 层
  const gsrc = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/renderer-glsl.js"), "utf8");
  if (!/COPY_LIT_FRAG/.test(gsrc)) fail("renderer-glsl 缺少 LIGHTING 直射光着色器 COPY_LIT_FRAG");
  // V1 模型（`l*` 灯 + generic4/genericimage4）：官方 ComputePBRLightShadow 的
  // 逐字转写。别把它换成 1/d² —— 3737267090 的 20 倍过曝就是这个错。
  if (!/clamp\(1\.0 - distance \/ max\(radius, 0\.0001\), 0\.0, 1\.0\)/.test(gsrc))
    fail("COPY_LIT_FRAG 的 V1 分支缺少官方 falloff = saturate(1−d/radius)");
  if (!/pow\(falloff \+ fltMin, exponent\)/.test(gsrc) || !/step\(0\.0, falloff - fltMin\)/.test(gsrc))
    fail("COPY_LIT_FRAG 的 V1 分支未按官方 GLSL 分支写 pow(falloff+flt_min, exponent)（含 step 门）");
  // 老通道 / V0 模型：CPU 预乘 radius² 后 1/d²（官方 common_pbr.h）
  if (!/lightColor \* \(radius \* radius\) \/ max\(distance \* distance, 0\.0001\)/.test(gsrc))
    fail("COPY_LIT_FRAG 缺少 radius²/d² 分支（genericimage2/genericimage3 那两代用）");
  if (!/u_LightModel/.test(gsrc) || !/int model/.test(gsrc))
    fail("COPY_LIT_FRAG 未按 u_LightModel 在两代公式间选路");
  if (!/\(diffuse \* albedo \/ PI \+ specular\) \* radiance \* NL/.test(gsrc))
    fail("COPY_LIT_FRAG 未按官方口径合成（(diffuse*albedo/PI+specular)*radiance*NL）");
  if (!/clamp\(ambient \+ light, 0\.0, 1\.0\) \+ light \* overbright/.test(gsrc))
    fail("COPY_LIT_FRAG 缺少官方 CombineLighting 的 HDR 过曝分支");
  const rsrc = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/renderer.js"), "utf8");
  if (!/v1: collectSceneLights\(scene\.layers, cam, 'v1'\)/.test(rsrc) || !/legacy: collectSceneLights\(scene\.layers, cam, 'legacy'\)/.test(rsrc))
    fail("renderScene 未每帧按两条通道收集场景灯光（脚本/用户属性会逐帧改灯）");
  if (!/gl\.uniform3fv\(u\.lightColor, pack\.colors\)/.test(rsrc) || !/gl\.uniform3fv\(u\.lightPos, pack\.positions\)/.test(rsrc))
    fail("bindLitUniforms 未把灯位置/颜色喂给着色器");
  if (!/gl\.uniform1fv\(u\.lightRadius, pack\.radii\)/.test(rsrc) || !/gl\.uniform1fv\(u\.lightExponent, pack\.exponents\)/.test(rsrc))
    fail("bindLitUniforms 未把 radius/exponent 喂给着色器（V1 衰减的两个参数）");
  if (!/const pack = sceneLights\[lightLaneForModel\(model\)\]/.test(rsrc))
    fail("bindLitUniforms 未按模型取对应通道的灯（模型与通道必须同源）");
  if (!/model === 'v1' \? 0 : 1/.test(rsrc)) fail("bindLitUniforms 未把模型翻成 u_LightModel");
  if (!/const baseProg = layer\.lightingEnabled \? copyLitProg : copyProg/.test(rsrc))
    fail("效果链底图那一趟未按 lightingEnabled 切到直射光着色器（LIGHTING 层的效果链是主路径）");
  if (!/layer\.lightingEnabled \? copyLitProg : copyProg,/.test(rsrc))
    fail("无效果直出路径未按 lightingEnabled 切到直射光着色器");
  if (!/bindLitUniforms\(m, layer\)/.test(rsrc))
    fail("合成趟未用同一份模型矩阵给光照定世界位置（局部空间→世界的换算必须与合成同源）");
  if (!/lightRadius = scn\.parseNum\(src\.radius, 1000\)/.test(msrc2()))
    fail("用户属性热更未回写 lightRadius（「亮度」滑条会拖了不动）");
  // 装配侧把材质 shader 记下来，渲染侧才知道该用哪代公式
  if (!/\(layer as any\)\.lightShader = pass\.shader/.test(msrc2()))
    fail("scene-mount 未把 LIGHTING 材质的 shader 名写到层上（模型分派会整体退回缺省）");
  if (!/lightLane: typeof o\.light === 'string' && \/\^l\/\.test\(o\.light\) \? 'v1' : 'legacy'/.test(
    fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/scene/parse.js"), "utf8"),
  ))
    fail("parse 未按 `l` 前缀给灯标通道（lpoint/lspot 走 V1，point 走老通道）");
}
// ---------- 13. 老通道两份 light uniform 的**量不同**（F39）----------
//
// 引擎给同一条老通道两份 uniform，面向不同消费公式、量也不同：
//   · `g_LightsColorRadius.rgb` = **纯颜色**（generic/generic2 → `ComputeLight`）
//   · `g_LightsColorPremultiplied.rgb` = 色×强度×radius²（genericimage2 → `color×强度×radius²/d²`，
//     已被 2890473419 的官方预览标定过，不能动）
// 证据：arsenal 官方 `preview.jpg` 最亮 5% 均值 RGB=(182,158,121) 暖而不饱和、整图 ≥250 占 0.02%；
// 而按「色×强度」绑（白灯 1.87 主导）实测 (253,248,235)、≥250 占 3.2% —— 修后是 (112,115,148)、
// 0.01%，与官方均值 61.2 vs 60.8 基本重合。影响面：全库读 ColorRadius 的只有 arsenal `generic`
// 与 demon_core `core`（`Premultiplied` 本仓无人读，官方 assets 里是 genericimage2）。
{
  const rsrc2 = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/renderer.js"), "utf8");
  // 绑定**使用** plain 是关键（只断言表存在会漏：改成 c 也能通过 —— 第一版判据就被变异测试逮到）
  if (!/legacyLightColorRadius\[i \* 4 \+ k\] = plain/.test(rsrc2)) {
    fail("g_LightsColorRadius 必须绑纯颜色（plain）：色×强度是预乘那份的口径（F39）");
  }
  if (!/legacyLightPremultiplied\[i \* 3 \+ k\] = c \* cr/.test(rsrc2)) {
    fail("g_LightsColorPremultiplied 必须保持 色×强度×radius²（genericimage2 的标定口径）");
  }
  if (!/const plainColors = new Float32Array\(MAX_SCENE_LIGHTS \* 3\)/.test(rsrc2)) {
    fail("collectSceneLights 未产出纯颜色表（F39）");
  }
  if (!errors.length) ok("老通道两份 light uniform 口径正确（ColorRadius=纯色 / Premultiplied=色×强度×r²，F39）");
}

// ---------- 14. 灯光阴影/体积字段：**只解析不渲染**（D2，2026-10-12 用户拍板）----------
//
// 决策：`castshadow` / `cascadedistance0|1|2` / `density` / `volumetricsexponent` /
// `castvolumetrics` / `innercone` / `outercone` / `cookie` / `usecookie` /
// `lightsourcesize`（以及 `general.lightconfig` 的 `pointshadow` / `directionalshadow`
// / `spotcookie` 子开关）**只进解析结果**：不做阴影图集、不做体积光 RT、不新增任何
// uniform/program/draw/pass/RT。
//
// 解析侧：`scene/parse.js` 的 `readLightNum()` + 灯对象上的 `lightParams` 块，
// 以及 `general.lightconfig` → `scene.lightconfig`。**只有灯对象带 lightParams**
// （非灯对象为 null：非灯对象上的 `castshadow` 是文字层投影开关，走 `textCastshadow`）。
//
// 本节把上一条决策**钉成判据**，两道锁：
//   ① 合成 scene JSON（进程内构造，不读素材库）：字段被解析、缺省值正确、非法值不崩；
//   ② 重扫真实源码：这些字段名**没有**出现在任何渲染路径（uniform/program/draw/pass
//      /RT），也没有出现在任何非 parse.js 的源码里 —— 后人想接上就会在这里翻红。
//
// 三类既有消费的**例外**必须先说清（否则判据要么误报、要么留洞）：
//   · `castshadow`：`parse.js` 的 `textCastshadow`（文字层投影开关）已消费，
//     `editor/objprops.ts:57` 也注册为 `only:"text"`；本节断的是「灯对象上的
//     `castshadow` 没有除 lightParams 之外的消费者」。
//   · `exponent` / `parent` / `parallaxDepth` / `solid` / `visible`：**本来就有**真实
//     消费者（衰减指数 / 层级链接 / 视差 / 纯色层 / 可见性），不属于本次「只解析」的
//     新字段 —— 所以 `exponent` 复用既有 `lightExponent`（不另立键），`parent`
//     复用既有 `parentId`，绝不新造第二个键。
//   · `general.lightconfig` 整体：`renderer.js:447-448,507` 只有注释提到它、
//     `scene-mount.ts:4619` 读的是**兄弟开关** `lightconfig.directional`（方向光总
//     开关，与本次解析的三个子开关不同），本节不断言「lightconfig 全无消费者」。
{
  const { parseScene: psScene } = await imp("renderer/vendor/we-scene/scene/parse.js");
  // 合成 scene.json（不读素材库）：只放解析器需要的键
  const mkScene = (obj, lightcfg) => ({
    camera: { eye: "0 0 0", center: "0 0 -1", up: "0 1 0" },
    general: { clearcolor: "0 0 0", ...(lightcfg ? { lightconfig: lightcfg } : {}) },
    objects: [obj],
  });
  const lightBase = { id: 1, name: "L", light: "lspot", origin: "10 20 30", color: "1 1 1", radius: 2048, intensity: 1, exponent: 4 };
  // `general.lightconfig` 的子开关（槽位数，不是布尔）——放在 general 里，别塞进 project
  const sceneLightCfg = (pointshadow, directionalshadow, spotcookie) => ({ pointshadow, directionalshadow, spotcookie });

  // ① 缺省值（逐字段的类型 + 官方缺省，表见 scene/parse.js 的 lightParams 注释）
  const sDef = psScene(mkScene(lightBase), {});
  const lp = sDef.layers[0] && sDef.layers[0].lightParams;
  if (!lp) fail("灯对象应解析出 lightParams（只解析不渲染的那组阴影/体积字段）");
  else {
    const expectNum = {
      cascadeDistance: 0, cascadeDistance1: 0, cascadeDistance2: 0,
      density: 1, volumetricsExponent: 1, innerCone: 0, outerCone: 0, sourceSize: 0,
    };
    for (const [k, v] of Object.entries(expectNum)) {
      if (typeof lp[k] !== "number" || !Number.isFinite(lp[k]))
        fail(`lightParams.${k} 应是 number（实得 ${typeof lp[k]} = ${lp[k]}）`);
      else if (Math.abs(lp[k] - v) > 1e-9) fail(`lightParams.${k} 缺省应为 ${v}，实得 ${lp[k]}`);
    }
    const expectBool = { castshadow: false, castVolumetrics: false, cookieEnabled: false };
    for (const [k, v] of Object.entries(expectBool)) {
      if (typeof lp[k] !== "boolean") fail(`lightParams.${k} 应是 boolean（实得 ${typeof lp[k]} = ${lp[k]}）`);
      else if (lp[k] !== v) fail(`lightParams.${k} 缺省应为 ${v}，实得 ${lp[k]}`);
    }
    if (typeof lp.cookie !== "string" || lp.cookie !== "")
      fail(`lightParams.cookie 应是 string（缺省空串 = 无 cookie），实得 ${typeof lp.cookie} ${JSON.stringify(lp.cookie)}`);
  }

  // ② 给了值要照读（含 `{value:<快照>}` 脚本/用户属性包装）
  const sGiven = psScene(mkScene({
    ...lightBase,
    castshadow: true, cascadedistance0: 5, cascadedistance1: 7, cascadedistance2: 9,
    density: 0.25, volumetricsexponent: 3, castvolumetrics: true,
    innercone: 0.2, outercone: 0.5, cookie: "cookies/spot1", usecookie: true, lightsourcesize: 7,
  }, sceneLightCfg(0, 2, 1)), {});
  const gp = sGiven.layers[0].lightParams;
  const given = {
    castshadow: true, cascadeDistance: 5, cascadeDistance1: 7, cascadeDistance2: 9,
    density: 0.25, volumetricsExponent: 3, castVolumetrics: true,
    innerCone: 0.2, outerCone: 0.5, cookie: "cookies/spot1", cookieEnabled: true, sourceSize: 7,
  };
  for (const [k, v] of Object.entries(given)) {
    if (gp[k] !== v) fail(`lightParams.${k} 应照读作者值 ${JSON.stringify(v)}，实得 ${JSON.stringify(gp[k])}`);
  }
  for (const [k, v] of Object.entries({ pointshadow: 0, directionalshadow: 2, spotcookie: 1 })) {
    if (sGiven.lightconfig[k] !== v)
      fail(`scene.lightconfig.${k} 应照读 ${v}（槽位数，不是布尔），实得 ${JSON.stringify(sGiven.lightconfig[k])}`);
  }

  // ③ 非法值不崩、退回缺省（数字串照读、"nope" 退缺省、包装里的串退缺省、null 退缺省）
  let sBad = null;
  try {
    sBad = psScene(mkScene({
      ...lightBase,
      castshadow: "yes",               // 字符串 → parseBool 返回缺省 false（不是「非空即真」）
      cascadedistance0: "nope",        // 非数字串 → 缺省
      density: null,                   // null → 缺省
      volumetricsexponent: { value: "z" }, // 包装里的非数字 → 缺省
      castvolumetrics: 1,              // 数字 1 → 真（slider 当开关的既有语义）
      innercone: { value: 0.2 },       // 包装取快照
      outercone: { value: "x" },       // 包装里的非数字 → 缺省
      cookie: { value: "tex/spot" },   // 包装取快照
      usecookie: 0,                    // 0 → 假
      lightsourcesize: { value: 2.5 }, // 包装取快照
    }, sceneLightCfg("x", undefined, null)), {});
  } catch (e) {
    fail(`非法灯光阴影/体积字段不得让 parseScene 抛错：${e.message}`);
  }
  if (sBad) {
    const bp = sBad.layers[0].lightParams;
    if (bp.cascadeDistance !== 0) fail(`"nope" 应退缺省 0，实得 ${bp.cascadeDistance}`);
    if (bp.density !== 1) fail(`null 应退缺省 1，实得 ${bp.density}`);
    if (bp.volumetricsExponent !== 1) fail(`包装里的非数字应退缺省 1，实得 ${bp.volumetricsExponent}`);
    if (bp.outerCone !== 0) fail(`包装里的非数字应退缺省 0，实得 ${bp.outerCone}`);
    if (bp.cookie !== "tex/spot") fail(`cookie 包装应取快照 "tex/spot"，实得 ${JSON.stringify(bp.cookie)}`);
    if (bp.cookieEnabled !== false) fail(`usecookie:0 应解析为 false，实得 ${bp.cookieEnabled}`);
    if (bp.sourceSize !== 2.5) fail(`lightsourcesize 包装应取 2.5，实得 ${bp.sourceSize}`);
    if (bp.castshadow !== false) fail(`castshadow:"yes" 按既有 parseBool 语义（字符串落缺省）应为 false，实得 ${bp.castshadow}`);
    if (bp.castVolumetrics !== true) fail(`castvolumetrics:1 应按 slider 语义为 true，实得 ${bp.castVolumetrics}`);
    for (const [k, v] of Object.entries({ pointshadow: 1, directionalshadow: 1, spotcookie: 0 })) {
      if (sBad.lightconfig[k] !== v) fail(`非法 lightconfig.${k} 应退缺省 ${v}，实得 ${sBad.lightconfig[k]}`);
    }
  }
  // 非灯对象不得被塞 lightParams（文字层的 castshadow 走 textCastshadow，别混）
  const sText = psScene(mkScene({ id: 1, name: "t", text: "hi", castshadow: true, density: 3 }), {});
  if (sText.layers[0].lightParams !== null)
    fail("非灯对象不该有 lightParams（文字层的 castshadow 是另一套：textCastshadow）");
  if (sText.layers[0].textCastshadow !== true)
    fail("文字层 castshadow 仍必须走 textCastshadow（别被本次改动挤掉）");

  // ④ 「渲染侧未接线」：重扫真实源码（排除 .worktrees/.tmp，否则 17 份 worktree 副本会淹没结果）。
  //
  // 三条判断口径（**只看真实代码引用，不把注释当消费者** —— 注释正是这份决策的文档）：
  //   A. `lightParams.<键>` 一旦被别的文件读到，就是「有人把它渲染侧接上了」⇒ 翻红；
  //   B. 那 10 个**全仓零引用**的字段名出现在 parse.js 之外 ⇒ 翻红（它们连注释都没有）；
  //   C. `castshadow` 的既有（文字层）消费者只允许出现在白名单文件里；另加 `lightShadow`
  //      形态守卫，防「换个键名绕过去」。
  //   检测器本身带**正向自检**：拿一段故意写错的合成文本喂进去必须被逮到 —— 否则
  //   「零命中」既可能是真干净，也可能是检测器瞎了。
  const SCAN_DIRS = ["renderer", "editor", "shared", "scripts", "render"];
  const SKIP_DIRS = new Set(["node_modules", ".worktrees", ".tmp", "dist", ".git"]);
  const walkSrc = (p, acc = []) => {
    let ents = [];
    try { ents = fs.readdirSync(p, { withFileTypes: true }); } catch { return acc; }
    for (const e of ents) {
      const q = join(p, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walkSrc(q, acc); }
      else if (/\.(js|ts|mjs|cjs)$/.test(e.name)) acc.push(q);
    }
    return acc;
  };
  const srcFiles = SCAN_DIRS.flatMap((d) => walkSrc(join(ROOT, d)));
  const PARSE_REL = "renderer/vendor/we-scene/scene/parse.js";
  const SELF_REL = "scripts/verify-props.mjs";
  // 判据脚本自身的豁免（与 SELF_REL 同理）：它们的**职责**就是逐字段断言 parse.js 的
  // 「只解析」缺省表、并反向断言渲染侧零消费者，所以**按设计**要写出这些字段名。
  // 判据脚本不是渲染代码 ⇒ 不构成「接上渲染侧」；对**其它一切文件**的消费者判定照旧生效。
  const CONST_JUDGE_SELVES = new Set([
    "scripts/verify-light-constants.mjs",
    "scripts/verify-particle-constants.mjs",
    "scripts/verify-tex-constants.mjs",
    "scripts/verify-native-state.mjs",
    "scripts/verify-scenescript-constants.mjs",
    "scripts/verify-camera-constants.mjs",
  ]);
  // 守卫：豁免名单只允许「存在且形如 scripts/verify-*-constants.mjs」的判据脚本，
  // 防止后人往这里塞一个渲染文件把这个检测器弄瞎。
  for (const rel of CONST_JUDGE_SELVES) {
    if (!/^scripts\/verify-[a-z-]+\.mjs$/.test(rel) || !fs.existsSync(join(ROOT, rel)))
      fail(`「只解析不渲染」检测器的判据脚本豁免名单非法：${rel}`);
  }
  // 本次「只解析」的字段名。`castshadow` 的既有消费者（文字层）单独列在 KNOWN_TEXT。
  const PARSE_ONLY = ["cascadedistance", "volumetricsexponent", "castvolumetrics",
    "innercone", "outercone", "usecookie", "lightsourcesize", "pointshadow",
    "directionalshadow", "spotcookie"];
  // `castshadow` 的既有（文字层）消费者：只允许出现在这些文件里
  const KNOWN_TEXT = new Set([
    "renderer/vendor/we-scene/scene/parse.js",
    "renderer/vendor/we-scene/render/text-layout.js",
    "renderer/vendor/we-scene/render/text.js",
    "renderer/src/scene-mount.ts",
    "editor/objprops.ts",
    "editor/i18n.ts",
    "scripts/verify-text.mjs",
    "scripts/verify-editor.mjs",
  ]);
  // 为什么只扫 `.js/.ts/.mjs/.cjs` 而不扫着色器文本：上面三条检查就是「渲染侧代码有没有读它」
  // 的充分条件 —— 读不到值的字段不可能进 uniform；着色器侧另有第 12 节的形状断言兜住。
  const violationsIn = (txt, r) => {
    const out = [];
    const lines = txt.split("\n");
    const at = (re) => lines.findIndex((l) => re.test(l)) + 1;
    if (r === PARSE_REL) return out; // 解析层是唯一允许出现这些字段名的地方
    if (/lightParams\s*[.?\[\]"]/.test(txt))
      out.push(`「只解析不渲染」被判据逮到：${r}:${at(/lightParams\s*[.?\[\]"]/)} 读了 lightParams —— 该字段组不得接任何 uniform/program/draw/pass/RT`);
    for (const f of PARSE_ONLY) {
      if (!txt.toLowerCase().includes(f)) continue;
      out.push(`「只解析不渲染」判据被破坏：${f} 出现在渲染/外围源码 ${r}:${at(new RegExp(f, "i"))}（该字段不得接任何 uniform/program/draw/pass/RT）`);
    }
    if (/castshadow/i.test(txt) && !KNOWN_TEXT.has(r))
      out.push(`castshadow 的既有消费者只有文字层（textCastshadow）；本仓新出现 ${r}:${at(/castshadow/i)}，请确认不是把灯 shadow 接上了`);
    // 守卫：灯 shadow 的读取形态必须是 `lightParams.castshadow` —— 一旦有人换个读法，
    // 上面 C 的名单就管不住它了（这条是防「改成 layer.lightShadow = ...」这类绕过）。
    if (/\blightShadow\b/.test(txt))
      out.push(`检出 ${r}:${at(/\blightShadow\b/)} 的 lightShadow 读取：灯 shadow 只能走 lightParams（只解析不渲染）`);
    return out;
  };
  // 正向自检：一条假 uniform 绑定 —— 就是后人「顺手接上」会写成的样子。
  // 用 renderer.js 当宿主文件（它不在 KNOWN_TEXT 里，所以 castshadow 那条检查也参与）。
  const PROBE = "gl.uniform1f(u.lightShadow, layer.lightParams.castshadow ? 1 : 0);";
  const probeHits = violationsIn(PROBE, "renderer/vendor/we-scene/render/renderer.js").length;
  if (probeHits < 3)
    fail(`「只解析不渲染」检测器自检失败：故意注入的违规文本只命中 ${probeHits} 条（应 ≥3：lightParams 读取 + castshadow 越界 + lightShadow 形态）`);
  // 判据自身的守卫：名单在，说明这一节没被人删空
  if (!PARSE_ONLY.includes("usecookie") || !PARSE_ONLY.includes("lightsourcesize"))
    fail("「只解析不渲染」判据的字段名单不完整");
  let scanned = 0;
  for (const rel of srcFiles) {
    const r = relative(ROOT, rel).split(sep).join("/");
    if (r === SELF_REL) continue; // 本节自己的名单/文案不算消费者
    if (CONST_JUDGE_SELVES.has(r)) continue; // 本波常量判据脚本按设计要写出这些字段名
    let txt = "";
    try { txt = fs.readFileSync(rel, "utf8"); } catch { continue; }
    scanned++;
    for (const v of violationsIn(txt, r)) fail(v);
  }
  if (!errors.length)
    ok(`灯光阴影/体积字段只解析不渲染：灯对象 lightParams ${Object.keys(lp || {}).length} 键 + scene.lightconfig 3 键；扫 ${scanned} 个真实源码文件 × ${PARSE_ONLY.length} 个字段名 + castshadow/lightShadow 形态，除 ${PARSE_REL} 外零消费者（检测器正向自检命中 ${probeHits} 条）`);
}

// ---------- 15. 直射光正例夹具：LIGHTING=1 时直射项**非零**（M1.1，2026-10-12）----------
//
// 为什么需要这一节：第 12 节断的是**形状**（着色器文本里有没有那条公式）与**几何**
// （灯的世界位置、通道、台账），但没有任何一处**求值** —— 「公式写在文本里」与
// 「这盏灯真的照亮了这个像素」之间还差一次真实求值。本节把
// `renderer/vendor/we-scene/render/renderer-glsl.js` 里 COPY_LIT_FRAG 的
// `lightRadiance` / `shadePBRLight` **原文抽出来就地求值**（不写第二份公式：改了
// 着色器，这一节跟着变），再用**合成**场景/材质对象（不读素材库）判三件事：
//   ① LIGHTING=1 + 一盏在范围内的灯 ⇒ 直射项 > 0，且与官方公式**逐位**一致；
//   ② LIGHTING=0 ⇒ 该层根本**不进** lit program（renderer 侧切 copyProg），
//      直射项恒为 0（恒等，不是「小到看不见」）；
//   ③ 两代衰减的形状：V1 = 色×saturate(1−d/r)^e（超出半径**恰为 0**）；
//      老通道 = 色×r²/d²（同一个 d 上远大于 V1 —— 这就是 3737267090 的 20 倍过曝）。
{
  const gsrcLit = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/renderer-glsl.js"), "utf8");
  if (!/COPY_LIT_FRAG/.test(gsrcLit)) fail("renderer-glsl 缺少 COPY_LIT_FRAG（直射光那一半的着色器）");
  // 从真实着色器文本里抽函数（含 `const float PI = ...` 常量行），把 GLSL 子集
  // 转成 JS 后求值：只做「去掉类型关键字」这一步（`const float PI` → `const PI`、
  // 签名里的 `vec3 x` → `x`），**公式本身一个字不改**。
  const grab = (name) => {
    const m = gsrcLit.match(new RegExp(`([a-z0-9]+)\\s+${name}\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}`));
    return m ? m[0] : null;
  };
  const grabLine = (re) => {
    const m = gsrcLit.match(re);
    return m ? m[0] : null;
  };
  // 每个函数单独转：返回值类型与参数表里的类型关键字统统去掉（只在参数表内，不会碰到
  // 函数体里的 GLSL 内建调用），公式本身一个字不改。
  const GLSL_TYPE = new Set(["float", "vec2", "vec3", "vec4", "int", "bool", "mat2", "mat3", "mat4", "void"]);
  const toJs = (s) => {
    if (!/\{/.test(s)) return s.replace(/const\s+(float|int)\s+/, "const "); // 常量行
    const head = s.slice(0, s.indexOf("{"));
    const name = (head.match(/[A-Za-z_]\w*/g) || []).find((t) => !GLSL_TYPE.has(t));
    const params = (head.slice(head.indexOf("(") + 1, head.lastIndexOf(")")).match(/[A-Za-z_]\w*/g) || [])
      .filter((t) => !GLSL_TYPE.has(t)).join(", ");
    const body = s.slice(s.indexOf("{")).replace(/\b(float|vec3|vec2|int|bool)\s+([A-Za-z_]\w*)\s*=/g, "$2 =");
    return `function ${name}(${params}) ${body}`;
  };
  const parts = [
    grabLine(/const float PI = [0-9.]+;/),
    grab("fresnelSchlick"), grab("distributionGGX"), grab("schlickGGX"), grab("geoSmith"),
    grab("lightRadiance"), grab("shadePBRLight"),
  ].filter(Boolean);
  if (parts.length < 7) fail(`未能从 COPY_LIT_FRAG 抽出直射光函数原文（抽到 ${parts.length}/7 段）`);
  const evalGLSL = new Function(
    "Math",
    "clamp", "max", "min", "pow", "saturate", "vec3", "normalize", "length", "dot", "mix", "step",
    `${parts.map(toJs).join("\n")}
     return { lightRadiance, shadePBRLight };`,
  );
  const clampG = (x, a, b) => Math.min(Math.max(x, a), b);
  const maxG = (a, b) => Math.max(a, b);
  const minG = (a, b) => Math.min(a, b);
  // 逐分量 GLSL 内建（本桶只用到 vec3 + 标量两种情况，与着色器用法一致）
  const cwise = (f) => (a, b) => (Array.isArray(a) && Array.isArray(b) ? a.map((v, i) => f(v, b[i])) :
    Array.isArray(a) ? a.map((v) => f(v, b)) : (Array.isArray(b) ? b.map((v) => f(a, v)) : f(a, b)));
  // GLSL 的 vec3 在 JS 里没有运算符重载（`vec3 * float`、`vec3 + vec3` 会得到 NaN 或字符串
  // 拼接）。本节按**单轴退化**求值：所有向量取同一条视轴、每个量用它的标量幅度表示，
  // 于是 `dot(a,b)=a*b`、`length(a)=|a|`、`normalize(a)=sign(a)`、`vec3(x)=x`，而
  // `a*b` / `a+b` / `a/b` 与逐分量 vec3 运算同值（同轴 ⇒ 三分量相等）。
  // 收益：函数体一个字符都不用改（公式保持原文）；代价：本节只覆盖同轴构型 ——
  // 异轴光照的逐分量路径由第 12 节 (e) 的几何断言兜住。
  const vec3g = (a, b, c) => (b === undefined && c === undefined ? a : [a, b, c]);
  const dotG = (a, b) => (Array.isArray(a) && Array.isArray(b) ? a.reduce((s, v, i) => s + v * b[i], 0) : a * b);
  const lenG = (a) => (Array.isArray(a) ? Math.hypot(...a) : Math.abs(a));
  const normG = (a) => (Array.isArray(a) ? (lenG(a) ? a.map((v) => v / lenG(a)) : a.slice()) : (a > 0 ? 1 : (a < 0 ? -1 : 0)));
  const mixG = (a, b, t) => cwise((x, y) => x + (y - x) * t)(a, b);
  const stepG = (edge, x) => cwise((e, v) => (v < e ? 0 : 1))(edge, x);
  let F = null;
  try {
    F = evalGLSL(Math, clampG, cwise(maxG), cwise(minG), Math.pow, (x) => clampG(x, 0, 1), vec3g, normG, lenG, dotG, mixG, stepG);
  } catch (e) {
    fail(`直射光函数原文求值失败（着色器文本可能不是合法 GLSL 子集）：${e.message}`);
  }
  if (F) {
    const { lightRadiance, shadePBRLight } = F;
    // 合成灯与层（进程内构造，不读素材库）：一盏 lpoint 在层正前方 d=50，
    // 半径 100、指数 2 ⇒ V1 falloff=(1−0.5)^2=0.25；老通道 r²/d²=4
    // （同一个 d 上差 16 倍 —— 就是 3737267090 老通道过曝 20 倍的成因）。
    const chan = [1, 0.97647, 0.91765]; // 官方 3737267090 的灯色（见第 12 节 (d2)）
    const inten = 1.79, radius = 100, exponent = 2, dist = 50;
    // 官方 V1 分支写的是 `pow(falloff + flt_min, exponent)`（flt_min = 6.103515625e-5，
    // GLSL 里的 half float 最小正规数）：闭式期望必须带上它，否则会差 1e-4 量级而误判。
    const FLT_MIN = 6.103515625e-5;
    const falloff = 1 - dist / radius; // = 0.5（半径 100、灯在 d=50）
    let v1Peak = 0, oldPeak = 0;
    for (const cc of chan) {
      const c = cc * inten; // 官方打包口径：色 × intensity（不预乘 radius²）
      const gotV1 = lightRadiance(c, radius, exponent, dist, 0);
      const wantV1 = c * Math.pow(falloff + FLT_MIN, exponent);
      if (!(gotV1 > 0)) fail(`LIGHTING=1 且灯在范围内时 V1 直射辐照度必须非零，实得 ${gotV1}`);
      if (Math.abs(gotV1 - wantV1) > 1e-9)
        fail(`V1 辐照度应 = 色×intensity×pow(saturate(1−d/r)+flt_min, e) = ${wantV1}，实得 ${gotV1}`);
      const gotOld = lightRadiance(c, radius, exponent, dist, 1);
      const wantOld = (c * radius * radius) / (dist * dist);
      if (!(gotOld > 0)) fail(`老通道直射辐照度必须非零，实得 ${gotOld}`);
      if (Math.abs(gotOld - wantOld) > 1e-9)
        fail(`老通道辐照度应 = 色×intensity×r²/d² = ${wantOld}，实得 ${gotOld}`);
      // V1 的 step 门：超出半径 ⇒ **恰为 0**（不是渐近小）
      const out = lightRadiance(c, radius, exponent, radius + 1, 0);
      if (out !== 0) fail(`V1 超出半径应恰为 0（官方 step 门），实得 ${out}`);
      v1Peak = Math.max(v1Peak, gotV1);
      oldPeak = Math.max(oldPeak, gotOld);
    }
    if (!(oldPeak / v1Peak > 10))
      fail(`两代公式在同一盏灯上应差一个量级（20 倍过曝的成因），实得 ${(oldPeak / v1Peak).toFixed(1)}×`);
    // 正例夹具：一盏在范围内的灯照在 LIGHTING=1 的层上 ⇒ 直射项 > 0
    const albedo = 0.5, N = 1, V = 1, f0 = 0.04, roughness = 0.5, metallic = 0;
    const rad = lightRadiance(chan[0] * inten, radius, exponent, dist, 0);
    const shaded = shadePBRLight(N, dist, V, albedo, rad, f0, roughness, metallic);
    if (!(shaded > 0))
      fail(`直射项正例夹具：一盏灯照亮一个 LIGHTING 层时合计必须 > 0，实得 ${shaded}`);
    if (!Number.isFinite(shaded) || shaded < 0)
      fail(`直射项必须是有限非负值，实得 ${shaded}`);
    // 反例（数值）：辐照度为 0（= 0 盏灯，或 LIGHTING=0 的层根本不进这个 program）
    const shaded0 = shadePBRLight(N, dist, V, albedo, 0, f0, roughness, metallic);
    if (shaded0 !== 0)
      fail(`辐照度为 0 时直射项必须恰为 0，实得 ${shaded0}`);
    // 反例（结构）：LIGHTING=0 的层在 renderer 里根本不进 lit program
    const rsrcL = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/renderer.js"), "utf8");
    if (!/layer\.lightingEnabled \? copyLitProg : copyProg/.test(rsrcL))
      fail("renderer 未按 lightingEnabled 在 copyLitProg / copyProg 之间切（LIGHTING=0 必须不进直射光 program）");
    if (!/const baseProg = layer\.lightingEnabled \? copyLitProg : copyProg/.test(rsrcL))
      fail("效果链底图那一趟未按 lightingEnabled 切着色器（LIGHTING=0 的层不得吃直射光）");
    // 灯为 0 盏（LIGHTING=1 但场景无灯）⇒ u_LightCount=0 ⇒ 循环不执行 ⇒ 直射项恒 0
    if (!/for \(int i = 0; i < 4; i\+\+\) \{\s*if \(i >= u_LightCount\) break;/.test(gsrcLit))
      fail("COPY_LIT_FRAG 的灯循环未按 u_LightCount 门控（0 盏灯时直射项必须恒 0）");
    if (!errors.length)
      ok(`直射光正例：LIGHTING=1 且灯在范围内 ⇒ V1 辐照度 ${v1Peak.toFixed(3)}、老通道 ${oldPeak.toFixed(1)}（差 ${(oldPeak / v1Peak).toFixed(1)}×），shadePBRLight 合计 ${shaded.toFixed(4)} > 0；LIGHTING=0 / 0 盏灯不进该 program`);
  }
}

function msrc2() {
  return fs.readFileSync(join(ROOT, "renderer/src/scene-mount.ts"), "utf8");
}

for (const n of notes) console.log("  ✓ " + n);
if (errors.length) {
  console.log("");
  for (const e of errors) console.log("  ✗ " + e);
  console.log(`\n✗ 共 ${errors.length} 处问题`);
  process.exit(1);
}
console.log(`\n✓ 用户属性解引用校验通过`);
