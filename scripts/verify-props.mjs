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
import { join } from "node:path";

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
// `#if LIGHTING` 时 ambient = g_LightAmbientColor*albedo，无直射灯（本仓不跑
// PBR）时结果 = albedo × g_LightAmbientColor。
// **g_LightAmbientColor = min(1, ambientcolor×π)**（2026-09-18 实测标定，
// 3737267090「整体太黑」：raw 0.3 直乘压暗 70%；详见 CASEBOOK「环境光 π 标定」）。
// 直射光那一半见第 12 节（2026-09-24 起场景灯光对象已接线）。
// 语料锁：LIGHTING=1 的 genericimage* pass（2026-09-18 本机库 8 pass / 4 张：
// 2894296965×4 / 3737267090×2 / 3047405322×1 / 3509243656×1），数量变了要人看一眼；
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
  // 台账更新（2026-09-24）：本机库长大后 LIGHTING 语料已是 55 pass / 13 张
  // （2026-09-18 记的 8 pass / 4 张是当时的库）。这条锁的是**素材面貌**，
  // 与代码路径无关 —— 数量再变仍要人看一眼（确认不是 combo 解析把别的材质算进来）。
  if (litPasses !== 55) fail(`LIGHTING=1 的 genericimage pass 应是 55（2026-09-24 台账），实得 ${litPasses}`);
  const expectWalls = [
    "2890473419", "2894296965", "2952574984", "3047405322", "3281559867", "3285446145",
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
// **两条通道 × 两代衰减**（2026-09-24 定性；官方 shader 明文 + Waple 对
// wallpaper64.exe 的逆向 `docs/re/scene-lighting.md` 互证，详见 renderer.js
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
  //     （官方 LightObject 注册默认，Waple §1.3）。
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
    if (!lw) note("3737267090 语料缺失，跳过 V1 通道直射光数值判据");
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
