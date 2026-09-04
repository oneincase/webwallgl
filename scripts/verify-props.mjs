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

// ---------- 7. 渲染惰性纯容器的 scale 不传播（3791354118 / 3264246690）----------
// 无名组 id 373：无 image、无 size、solid:true，scale 绑用户属性 newproperty6
// （快照 1.43）。把 1.43 乘进子层后人物总缩放 0.7848，头顶越出设计上沿；
// WE 实机缩略图里人物总缩放就是子层自身的 0.54881（头顶距设计顶 ≈4%）。
// 对照组 3789007480 Clock（有 size 的真容器，0.2×D a y 4.08332）必须照常传播。
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
        fail(`${id} ${name} origin[${i}]=${l.origin[i]}，应为 ${origin[i]}（惰性容器 scale 被乘进子层？）`);
      }
      if (Math.abs(l.scale[i] - scale[i]) > 1e-6) {
        fail(`${id} ${name} scale[${i}]=${l.scale[i]}，应为 ${scale[i]}（惰性容器 scale 被乘进子层？）`);
      }
    }
  };
  expect("3791354118", "1拆分", [2991.91931, 590.61917, 0], [0.54881, 0.54881, 0.54881]);
  expect("3264246690", "1拆分", [2991.91931, 590.61917, 0], [0.54881, 0.54881, 0.54881]);
  expect("3789007480", "D a y", [17.292578, 113.583056, 0], [0.816664, 0.807326, 0.683486]);
  ok("惰性纯容器（无 image/size）scale 不传播：双月牙儿人物 0.54881 不被 1.43 放大；Clock 有 size 照常传播");
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

for (const n of notes) console.log("  ✓ " + n);
if (errors.length) {
  console.log("");
  for (const e of errors) console.log("  ✗ " + e);
  console.log(`\n✗ 共 ${errors.length} 处问题`);
  process.exit(1);
}
console.log(`\n✓ 用户属性解引用校验通过`);
