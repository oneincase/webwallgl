#!/usr/bin/env node
/**
 * verify-script-hooks —— A8「脚本挂点登记表」的离线判据（docs/EDITOR-COMPLETION-PLAN §2 的 A8）。
 *
 * 为什么单独一项：挂点寻址此前是散装字符串 + 一条 `EFFECT_VIS` 正则。这类代码的失败形态
 * 全是**静默**的 —— 少登记一个挂点、寻址串写错一个字符，面板照样显示、用户改完照样保存，
 * 只是脚本永远不生效：引擎按 `{script, value}` 包装取字段（scene/parse.js:554 的 objectScripts、
 * :844 的 generalScripts、render/renderer.js:2007 的 scriptedConstants），路径对不上时读到的
 * 是裸值，没有任何报错。所以判据分三层，缺一不可：
 *
 *   A/B. **登记表自洽 + 菜单同源**：寻址串唯一、每族都带引擎读点标注、对象字段与
 *        scene/parse.js:554-560 的白名单**同集合**、「新建脚本」菜单按图层种类过滤后与
 *        引擎的字段语义一致（image 那份菜单串已被 verify-editor-headless.mjs:1303 逐字
 *        断言过 —— 这里按同一口径守住，避免两条泳道各写一份判定）。
 *   C/D/E. **读写对称**：每个挂点族（对象字段 / 文字内容 / 效果开关 / 效果常量 / 粒子覆盖 /
 *        场景 general）在 读(scriptSlots,getScript) → 写(setScript) → 去脚本(removeScript)
 *        一圈之后，同族的 `value` 快照、`scriptproperties`、`user` 绑定、`animation` 关键帧
 *        必须原样保留（WE 的三种包装住在同一个对象里，写坏了就是丢用户属性 / 丢关键帧）。
 *   F. **真语料覆盖**：全库 scene.json 跑一遍，用**独立扫描**（不复用被测实现的任何判定）
 *        数出的「脚本包装」条数必须与 scriptSlots 完全相等，且每条都能按寻址串读回去。
 *        少一个就红 —— 这是「挂点没登记」唯一可能被抓住的地方。
 *   G. **变异红测**：把实现改坏，确认对应判据真的会红（防假绿）；其中的
 *        「尾键从点号写回下标」正是本轮真踩过的坑（`…constantshadervalues[{name}]`
 *        在 fixture 上看起来对，一上真语料就整族读不到）。
 *
 * 用法：node scripts/verify-script-hooks.mjs
 */
import { build } from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, LIB, createChecker } from "./lib/verify-kit.mjs";

const { check, fail, errors } = createChecker({ echo: true });
const json = (v) => JSON.stringify(v);
let passed = 0;
/** createChecker 只在失败时出声；通过也打一行，便于核对每一项都真跑到了 */
function ok(cond, msg) {
  check(cond, msg);
  if (cond) {
    passed++;
    console.log("  ✓ " + msg);
  }
}
const section = (t) => console.log(`\n${t}`);

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "verify-script-hooks-"));
process.on("exit", () => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响判据 */
  }
});

/**
 * editor/<name>.ts 打成可导入模块（overrides = { 绝对路径: 改过的源码 }，变异红测用）。
 * 脚本挂点这两支只 import 纯数据模块（doc / container / layer-kinds）与类型，
 * 不碰渲染器运行时代码，所以不需要 verify-editor 的 source-alias / glsl 插件。
 */
async function loadEditorModule(name, overrides = {}) {
  const plugins = Object.keys(overrides).length
    ? [
        {
          name: "mutate",
          setup(b) {
            b.onLoad({ filter: /\.ts$/ }, (a) => (overrides[a.path] !== undefined ? { contents: overrides[a.path], loader: "ts" } : undefined));
          },
        },
      ]
    : [];
  const out = await build({
    entryPoints: [path.join(ROOT, "editor", `${name}.ts`)],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    plugins,
    logLevel: "silent",
  });
  const tmp = path.join(tmpRoot, `${name}-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(tmp, out.outputFiles[0].text);
  return import(pathToFileURL(tmp).href);
}

const SRC = path.join(ROOT, "editor/scripts.ts");
const srcText = fs.readFileSync(SRC, "utf8");
const sc = await loadEditorModule("scripts");
const DOC_SRC = path.join(ROOT, "editor/doc.ts");
const docSrcText = fs.readFileSync(DOC_SRC, "utf8");
const docMod = await loadEditorModule("doc");
const CODE = "export function update(v){ return v; }";
const CODE2 = "export function update(v){ return v * 2; }";

// ═══════════════════════════════════════════════════════════════════════════
// A. 登记表：挂点唯一真相
// ═══════════════════════════════════════════════════════════════════════════
section("A. 登记表（SCRIPT_HOOKS）是挂点唯一真相");
{
  const H = [...sc.SCRIPT_HOOKS];
  const paths = H.map((h) => h.path);
  ok(H.length >= 16, `登记表登记了 ${H.length} 个挂点族`);
  ok(new Set(paths).size === paths.length, "每个挂点的寻址串唯一");
  ok(H.every((h) => typeof h.id === "string" && h.id.length > 0), "每个挂点有稳定 id（诊断用，不写进 scene.json）");
  ok(H.every((h) => typeof h.note === "string" && h.note.length >= 8), "每个挂点都标注了引擎读点 / 口径（不许有来历不明的挂点）");
  ok(H.some((h) => h.path === "effects[0].visible".replace("0", "{i}")), "效果开关挂点登记为 effects[{i}].visible");
  ok(H.some((h) => h.path.includes("passes") && h.path.includes("constantshadervalues")), "效果常量挂点登记为 effects[{i}].passes[{p}].constantshadervalues.{name}");
  ok(H.some((h) => h.path === "instanceoverride.{name}"), "粒子实例覆盖登记为 instanceoverride.{name}");
  ok(H.some((h) => h.path === "general.{name}"), "场景 general 登记为 general.{name}");

  // 引擎白名单（scene/parse.js:554-560 的数组，判据里另抄一份：不能 import 被测实现的白名单，
  // 否则「表和引擎一致」就成了自证）。编辑器按面板习惯把 origin 排在最前，所以只判**同集合**。
  const ENGINE = ["scale", "origin", "color", "alpha", "brightness", "angles", "visible", "maxwidth", "pointsize", "volume", "intensity", "exponent"];
  ok(
    json([...sc.OBJECT_SCRIPT_FIELDS].sort()) === json([...ENGINE].sort()),
    `对象字段与引擎 objectScripts 白名单同集合（${ENGINE.length} 项）：面板序 ${sc.OBJECT_SCRIPT_FIELDS.join(",")}`,
  );
  ok(sc.OBJECT_SCRIPT_FIELDS.length === 12 && new Set(sc.OBJECT_SCRIPT_FIELDS).size === 12, "对象字段 12 项且无重复");

  const addable = H.filter((h) => h.addable);
  ok(addable.length === 12 + 1, `可新建（有确定路径）的挂点 ${addable.length} 个 = 12 个对象字段 + text`);
  ok(addable.every((h) => !h.path.includes("{")), "可新建的挂点都不带占位符（菜单里点得到才是确定路径）");
  const wild = H.filter((h) => !("literal" in h.key));
  ok(wild.length === 3 && wild.every((h) => !h.addable), `通配键挂点 3 个（效果常量 / 粒子覆盖 / general）且都不进菜单：${wild.map((h) => h.path).join(" ")}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// B. 「新建脚本」菜单按图层种类过滤
// ═══════════════════════════════════════════════════════════════════════════
section("B. 「新建脚本」菜单按图层种类过滤（addableTargets）");
{
  const img = sc.addableTargets("image").join(",");
  ok(img === "origin,scale,angles,visible,alpha,color,brightness", `image 层菜单串与面板逐字一致：${img}`);
  ok(sc.addableTargets("text")[0] === "text", "文字层第一项是 text（文字内容脚本）");
  ok(json(sc.addableTargets("sound")) === json(["volume"]), "声音层只给 volume（引擎只认它：scene-mount.ts:181-186 写 soundprops.volume）");
  ok(json(sc.addableTargets("light")) === json(["color", "intensity", "exponent"]), "灯光层给 color/intensity/exponent（parse.js:596/:600 的写回槽）");
  const t = new Set(sc.addableTargets("text"));
  ok(["maxwidth", "pointsize"].every((f) => t.has(f)), "文字层给 maxwidth/pointsize（文字布局，scene-mount.ts:172-180）");
  ok(!sc.addableTargets("image").includes("maxwidth") && !sc.addableTargets("image").includes("pointsize"), "非文字层不给 maxwidth/pointsize（列出来也写不回引擎）");
  ok(!sc.addableTargets("sound").includes("origin") && !sc.addableTargets("image").includes("volume"), "声音 / 图片层的菜单不交叉");
  ok(sc.addableTargets("plugin-unknown-kind").includes("origin"), "插件登记的未知种类走通用口径（除声音 / 灯光外都可）");
  ok(!sc.addableTargets("other").includes("color"), "other 种类只给通用 5 项，不冒给颜色 / 亮度");
  const known = new Set(sc.OBJECT_SCRIPT_FIELDS);
  const extra = sc
    .SCRIPT_HOOKS.filter((h) => h.addable && "literal" in h.key)
    .map((h) => h.path)
    .filter((p) => p !== "text" && !known.has(p));
  ok(extra.length === 0, `可新建的挂点不发明引擎白名单以外的字段（越界：${extra.join(",") || "无"}）`);
}

// ═══════════════════════════════════════════════════════════════════════════
// C. 对象字段族：读 / 写 / 去脚本都不丢同族包装
// ═══════════════════════════════════════════════════════════════════════════
section("C. 对象字段族：读写对称 + 包装保留");
{
  const o = { id: 1, origin: { script: CODE, value: "1 2 3" }, alpha: { user: "op", value: 0.5 }, visible: true, effects: [{ file: "effects/x/effect.json", visible: { script: CODE, scriptproperties: { a: 1 }, value: true } }] };
  const slots = sc.scriptSlots(o);
  ok(json(slots.map((s) => s.target)) === json(["origin", "effects[0].visible"]), `scriptSlots 只报真带脚本的挂点：${json(slots.map((s) => s.target))}`);
  ok(slots[0].value === "1 2 3" && slots[0].hasProps === false, "槽里带快照值，无 scriptproperties 时 hasProps=false");
  ok(slots[1].hasProps === true, "效果开关的 scriptproperties 认出来");
  ok(sc.getScript(o, "origin") === CODE, "getScript 读对象字段");
  ok(sc.getScript(o, "alpha") === null, "只有 user 绑定的字段不算脚本");
  ok(sc.getScript(o, "bogus") === null && sc.getScript(o, "effects[9].visible") === null, "未登记挂点 / 不存在的下标都返回 null");

  const bare = { id: 2 };
  ok(sc.setScript(bare, "scale", CODE) && bare.scale.value === "1.00000 1.00000 1.00000", "裸值字段就地包装，快照取登记表缺省");
  ok(sc.setScript(o, "visible", CODE) && json(o.visible) === json({ script: CODE, value: true }), "裸 true 包装成 {script,value:true}（键序 script 在前）");
  ok(sc.setScript(o, "alpha", CODE2) && o.alpha.user === "op" && o.alpha.value === 0.5, "改脚本保留 user 绑定与快照");
  ok(!sc.setScript(o, "origin", CODE) && !sc.setScript(o, "origin", "   ") && !sc.setScript(o, "bogus", CODE), "源码没变 / 空白 / 非法挂点都不算修改");
  ok(sc.setScript(o, "effects[0].visible", CODE2) && o.effects[0].visible.scriptproperties.a === 1, "效果开关改脚本保留 scriptproperties");
  ok(sc.removeScript(o, "origin") && o.origin === "1 2 3", "去脚本且没有别的绑定时解包回裸快照");
  ok(sc.removeScript(o, "alpha") && json(o.alpha) === json({ user: "op", value: 0.5 }), "去脚本保留 user 绑定");
  ok(sc.removeScript(o, "effects[0].visible") && o.effects[0].visible === true, "效果开关去脚本解包回裸值");
  ok(!sc.removeScript(o, "origin") && !sc.removeScript(o, "bogus"), "无脚本可去 / 非法挂点返回 false");

  const anim = { id: 3, color: { animation: { options: { fps: 30 } }, value: "1 0 0" } };
  ok(json(sc.scriptSlots(anim)) === json([]), "只有关键帧、没有 script 的字段不进脚本槽（关键帧车道的事）");
  ok(sc.setScript(anim, "color", CODE) && json(anim.color.animation) === json({ options: { fps: 30 } }) && anim.color.value === "1 0 0", "给关键帧字段加脚本：animation 与快照都在");
  ok(sc.removeScript(anim, "color") && json(anim.color) === json({ animation: { options: { fps: 30 } }, value: "1 0 0" }), "去掉脚本后关键帧与快照仍在");
}

// ═══════════════════════════════════════════════════════════════════════════
// D. 效果常量挂点：effects[i].passes[p].constantshadervalues.{name}
// ═══════════════════════════════════════════════════════════════════════════
section("D. 效果常量挂点（A8 新补：renderer.js:2007 scriptedConstants 读的就是它）");
{
  const bag = () => ({ Strength: { script: CODE, scriptproperties: { speed: 1.5 }, value: 0.3 }, Speed: 1 });
  const o = { id: 1, effects: [{ file: "effects/tint/effect.json", passes: [{ constantshadervalues: bag() }] }] };
  const P = "effects[0].passes[0].constantshadervalues";
  ok(sc.getScript(o, `${P}.Strength`) === CODE, "读效果常量脚本（材质名大小写按原样）");
  ok(sc.getScript(o, `${P}.strength`) === CODE, "键名大小写不敏感：strength 也能读到 Strength（renderer.js:731/:776 同口径）");
  ok(sc.getScript(o, `${P}.Nope`) === null, "袋里没有的材质名返回 null");
  ok(sc.setScript(o, `${P}.strength`, CODE2) && o.effects[0].passes[0].constantshadervalues.Strength.script === CODE2, "按小写写回落在已有的 Strength 键上");
  ok(o.effects[0].passes[0].constantshadervalues.Strength.value === 0.3 && o.effects[0].passes[0].constantshadervalues.Strength.scriptproperties.speed === 1.5, "改脚本只动 .script：快照值与 scriptproperties 原样");
  ok(Object.keys(o.effects[0].passes[0].constantshadervalues).length === 2, "不新开大小写重复的键（开了就是两条 uniform 分叉）");

  const plain = { effects: [{ passes: [{ constantshadervalues: { Power: 0.78, Other: 1 } }] }] };
  ok(sc.setScript(plain, `${P}.Power`, CODE) && plain.effects[0].passes[0].constantshadervalues.Power.value === 0.78, "裸值常量就地包装：原值成为快照");
  ok(plain.effects[0].passes[0].constantshadervalues.Other === 1, "包装只碰目标键");
  ok(sc.removeScript(plain, `${P}.Power`) && plain.effects[0].passes[0].constantshadervalues.Power === 0.78, "去脚本解包回裸值（引擎读回的是原值）");
  ok(!sc.setScript(plain, `${P}.Nope`, CODE) && !("Nope" in plain.effects[0].passes[0].constantshadervalues), "袋里没有的材质名不新建（造出来引擎也不会读，直接 false）");

  // 真语料里的材质名**带方括号**（`[P1] Semi-major|长半轴`，348 场景里 54 处），
  // 寻址正则的键捕获必须容得下 —— 这一条就是被 F 段的语料覆盖判据抓出来的那个 bug。
  const bracket = { effects: [{ passes: [{ constantshadervalues: { "[P1] Semi-major|长半轴": { script: CODE, value: 1 } } }] }] };
  ok(sc.getScript(bracket, `${P}.[P1] Semi-major|长半轴`) === CODE, "带方括号 / 竖线 / 中文的材质名也能按寻址串读回");
  ok(sc.setScript(bracket, `${P}.[P1] Semi-major|长半轴`, CODE2) && bracket.effects[0].passes[0].constantshadervalues["[P1] Semi-major|长半轴"].script === CODE2, "带方括号的材质名也能写回（写歪了就是整族静默失效）");

  const anim = { effects: [{ passes: [{ constantshadervalues: { fade: { animation: { options: { fps: 30 } }, value: 0 } } }] }] };
  ok(sc.setScript(anim, `${P}.fade`, CODE) && json(anim.effects[0].passes[0].constantshadervalues.fade.animation) === json({ options: { fps: 30 } }) && anim.effects[0].passes[0].constantshadervalues.fade.value === 0, "与效果常量关键帧共存（renderer.js:2164 那一批键）：animation 与快照都不丢");
  ok(sc.scriptSlots(o).map((s) => s.target).join("|") === `${P}.Strength`, `scriptSlots 按寻址串读回效果常量：${sc.scriptSlots(o).map((s) => s.target).join("|")}`);
  const many = { effects: [{ passes: [{ constantshadervalues: { A: { script: CODE, value: 1 } } }, { constantshadervalues: { B: { script: CODE, value: 2 } } }] }] };
  ok(json(sc.scriptSlots(many).map((s) => s.target)) === json(["effects[0].passes[0].constantshadervalues.A", "effects[0].passes[1].constantshadervalues.B"]), "多 pass 的下标逐 pass 展开");
  ok(sc.getScript(many, "effects[0].passes[1].constantshadervalues.B") === CODE && sc.getScript(many, "effects[0].passes[1].constantshadervalues.A") === null, "pass 下标不会串台");
}

// ═══════════════════════════════════════════════════════════════════════════
// E. 粒子实例覆盖 + 场景 general（通配键；general 只在 scene.json 自身命中）
// ═══════════════════════════════════════════════════════════════════════════
section("E. 粒子覆盖 instanceoverride.{name} 与场景 general.{name}");
{
  const p = { id: 2, particle: "x", instanceoverride: { rate: { script: CODE, value: 56 }, count: 16 } };
  ok(sc.getScript(p, "instanceoverride.rate") === CODE, "读粒子覆盖脚本（parse.js:470-479）");
  ok(sc.setScript(p, "instanceoverride.rate", CODE2) && p.instanceoverride.rate.value === 56, "改脚本保留原来帧率快照（用户设的 rate 不被脚本吞掉）");
  ok(p.instanceoverride.count === 16 && json(sc.scriptSlots(p).map((s) => s.target)) === json(["instanceoverride.rate"]), "不碰同族别的键，scriptSlots 读回一致");
  ok(!sc.setScript(p, "instanceoverride.nope", CODE) && !("nope" in p.instanceoverride), "粒子覆盖不存在的键不新建（引擎没有静态白名单，凭空造键就是没用的字段）");
  ok(sc.removeScript(p, "instanceoverride.rate") && p.instanceoverride.rate === 56, "去脚本解包回裸帧率");

  const scene = { objects: [], general: { zoom: { script: CODE, value: 3 }, bloomstrength: { animation: { options: {} }, value: 0.5 }, cameraparallax: 1 } };
  ok(sc.getScript(scene, "general.zoom") === CODE, "读场景 general 脚本（parse.js:844-852）");
  ok(sc.setScript(scene, "general.zoom", CODE2) && scene.general.zoom.value === 3, "改脚本保留快照");
  ok(sc.setScript(scene, "general.bloomstrength", CODE) && json(scene.general.bloomstrength.animation) === json({ options: {} }) && scene.general.bloomstrength.value === 0.5, "与 general 关键帧共存（parse.js:856-867）：animation 与快照都不丢");
  ok(sc.removeScript(scene, "general.bloomstrength") && json(scene.general.bloomstrength) === json({ animation: { options: {} }, value: 0.5 }), "去脚本后关键帧与快照都在");
  ok(sc.setScript(scene, "general.newkey", CODE) && scene.general.newkey.script === CODE, "general 允许按请求名建立新键（场景字段由作者自由取用）");
  ok(!sc.setScript(scene, "general.blank", "   ") && !("blank" in scene.general), "空白源码不新建键（先校验再 locate）");
  ok(sc.getScript({ id: 3 }, "general.zoom") === null && !sc.setScript({ id: 3 }, "general.zoom", CODE), "图层对象不认 general（sceneOnly：不把图层字段当场景字段写）");
  ok(json(sc.scriptSlots(scene).map((s) => s.target)) === json(["general.zoom", "general.newkey"]), `scriptSlots 读回场景 general（bloomstrength 的脚本刚被去掉）：${sc.scriptSlots(scene).map((s) => s.target).join("|")}`);
  ok(sc.scriptSlots({ id: 4, text: "hi" }).length === 0, "场景对象与图层对象都为空时 scriptSlots 是空数组（不抛）");
}

// ═══════════════════════════════════════════════════════════════════════════
// F. 真语料：独立扫描的脚本条数 === scriptSlots 条数，且每条都能读回
// ═══════════════════════════════════════════════════════════════════════════
section("F. 真语料覆盖（全库 scene.json）");
{
  const ENGINE_FIELDS = ["scale", "origin", "color", "alpha", "brightness", "angles", "visible", "maxwidth", "pointsize", "volume", "intensity", "exponent"];
  const hasScript = (v) => v && typeof v === "object" && typeof v.script === "string" && v.script !== "";
  /** 独立扫描：只读 scene.json 的 JSON 结构，不 import 被测实现的任何判定 */
  const scan = (sj) => {
    const fam = { text: 0, field: 0, effectVisible: 0, constant: 0, override: 0, general: 0 };
    if (sj.general && typeof sj.general === "object") for (const k of Object.keys(sj.general)) if (hasScript(sj.general[k])) fam.general++;
    for (const o of sj.objects || []) {
      if (hasScript(o.text)) fam.text++;
      for (const f of ENGINE_FIELDS) if (hasScript(o[f])) fam.field++;
      for (const e of o.effects || []) {
        if (hasScript(e.visible)) fam.effectVisible++;
        for (const p of e.passes || []) {
          const bag = p && p.constantshadervalues;
          if (bag && typeof bag === "object") for (const k of Object.keys(bag)) if (hasScript(bag[k])) fam.constant++;
        }
      }
      if (o.instanceoverride && typeof o.instanceoverride === "object") for (const k of Object.keys(o.instanceoverride)) if (hasScript(o.instanceoverride[k])) fam.override++;
    }
    return fam;
  };

  let pkgPath = null;
  let parsePkg = null;
  let getEntry = null;
  try {
    ({ parsePkg, getEntry } = await import(path.join(ROOT, "renderer/vendor/we-scene/pkg/container.js")));
  } catch {
    /* 下面按「无语料」处理 */
  }
  const dec = new TextDecoder();
  const total = { text: 0, field: 0, effectVisible: 0, constant: 0, override: 0, general: 0 };
  let scenes = 0;
  let sceneScripts = 0;
  let scanned = 0;
  let found = 0;
  let asym = 0;
  let sceneOnly = 0;
  const samples = [];
  if (parsePkg && fs.existsSync(LIB)) {
    for (const d of fs.readdirSync(LIB)) {
      if (!/^\d+$/.test(d)) continue;
      pkgPath = path.join(LIB, d, "scene.pkg");
      if (!fs.existsSync(pkgPath)) continue;
      let sj;
      try {
        const e = getEntry(parsePkg(new Uint8Array(fs.readFileSync(pkgPath))), "scene.json");
        if (!e) continue;
        sj = JSON.parse(dec.decode(e));
      } catch {
        continue;
      }
      scenes++;
      const fam = scan(sj);
      for (const k of Object.keys(fam)) total[k] += fam[k];
      scanned += fam.text + fam.field + fam.effectVisible + fam.constant + fam.override + fam.general;
      for (const slot of sc.scriptSlots(sj)) {
        sceneScripts++;
        if (!slot.target.startsWith("general.")) sceneOnly++;
        if (sc.getScript(sj, slot.target) !== slot.script) {
          asym++;
          if (samples.length < 8) samples.push(`${d} 场景根 ${slot.target}`);
        }
      }
      for (const o of sj.objects || []) {
        for (const slot of sc.scriptSlots(o)) {
          found++;
          if (sc.getScript(o, slot.target) !== slot.script) {
            asym++;
            if (samples.length < 8) samples.push(`${d} obj=${o.id} ${slot.target}`);
          }
        }
      }
    }
  }
  const readBack = found + sceneScripts;
  if (scenes === 0) {
    console.log("  - 跳过语料覆盖断言（本机库中无场景壁纸）");
  } else {
    console.log(`    语料脚本计数（独立扫描）text=${total.text} 对象字段=${total.field} 效果开关=${total.effectVisible} 效果常量=${total.constant} 粒子覆盖=${total.override} general=${total.general}`);
    ok(asym === 0, `每条挂点都能按寻址串读回（对不上 ${asym} 条${samples.length ? "，例：" + samples.join(" / ") : ""}）`);
    ok(sceneOnly === 0, "场景根只命中 general.*（不把场景根的同名字段当成图层字段）");
    ok(
      readBack === scanned,
      `覆盖 100%：独立扫描 ${scanned} 条脚本包装，scriptSlots 读到 ${readBack} 条（图层 ${found} + 场景 ${sceneScripts}）`,
    );
    if (readBack !== scanned) fail(`漏登记的挂点族：扫描 ${scanned} 条 / 读到 ${readBack} 条`);
    ok(total.constant > 0 && total.override > 0, `本轮新补的两族在真语料里确实有内容（效果常量 ${total.constant} 条 / 粒子覆盖 ${total.override} 条）`);
  }
  if (scenes > 0) console.log(`  ✓ 语料覆盖：${scenes} 个场景 / ${scanned} 条脚本包装全部按寻址串读回`);
}

// ═══════════════════════════════════════════════════════════════════════════
// H. 失败零副作用（locate create）与热改写回的大小写口径（§8.2 L1）
// ═══════════════════════════════════════════════════════════════════════════
section("H. 失败零副作用 + writeObjProps 大小写不敏感");
{
  // H1. 效果常量的材质名不在袋里 ⇒ setScript 返回 false，且文档**逐字节不变**。
  //     注意 passes[0] 存在但 constantshadervalues 缺失：这才是「会新建空盒子」的那条路径。
  const o = { id: 9, effects: [{ passes: [{}] }] };
  const before = json(o);
  ok(sc.setScript(o, "effects[0].passes[0].constantshadervalues.NotThere", CODE) === false, "袋里没有的材质名：setScript 返回 false");
  ok(json(o) === before, `失败时文档零副作用（不许留下空 passes / constantshadervalues）：${json(o)}`);
  const o1b = { id: 9, effects: [{ file: "effects/x/effect.json" }] };
  const before1b = json(o1b);
  ok(sc.setScript(o1b, "effects[0].passes[0].constantshadervalues.NotThere", CODE) === false && json(o1b) === before1b, "整条 passes 链都不存在时也零副作用（数组步不凭空造元素）");

  // H1b. 正向对照：同名键存在时确实写成功（证明上面那条不是「整个挂点永远是 false」）
  const o2 = { id: 9, effects: [{ passes: [{ constantshadervalues: { NotThere: 1 } }] }] };
  ok(sc.setScript(o2, "effects[0].passes[0].constantshadervalues.NotThere", CODE) === true && o2.effects[0].passes[0].constantshadervalues.NotThere.script === CODE, "同名键存在时确实写成功（正向对照）");

  // H1c. 粒子覆盖的未知键同一口径
  const o3 = { id: 9 };
  const before3 = json(o3);
  ok(sc.setScript(o3, "instanceoverride.nope", CODE) === false && json(o3) === before3, "粒子覆盖的未知键：返回 false 且零副作用");

  // H1d. 作者写在链上的非容器值不被覆盖成空盒子（覆盖了就是拿编辑器的心智模型改作者数据）
  const o4 = { id: 9, instanceoverride: "keep" };
  ok(sc.setScript(o4, "instanceoverride.rate", CODE) === false && o4.instanceoverride === "keep", "非容器值不被覆盖（instanceoverride 是字符串时不动它）");

  // H2. writeObjProps：大小写不敏感命中原名（objprops.ts 铁律 1）
  const p1 = { id: 1, Origin: "0.50000 0.50000 0.50000", alpha: 1 };
  docMod.writeObjProps(p1, { origin: [1, 2, 3] });
  ok(p1.Origin === "1 2 3", `既有键 Origin 被改（got ${json(p1.Origin)}）`);
  ok(!("origin" in p1), "不新增规范小写键（新增了同一对象上就是两份，作者的绑定被绕过）");

  const p2 = { id: 2, ORIGIN: { user: "op", value: "0.00000 0.00000 0.00000" } };
  docMod.writeObjProps(p2, { origin: [4, 5, 6] });
  ok(p2.ORIGIN.user === "op" && p2.ORIGIN.value === "4 5 6" && !("origin" in p2), "包装的 ORIGIN 只改 .value（user 保留、不另起键）");

  const p3 = { id: 3 };
  docMod.writeObjProps(p3, { origin: [7, 8, 9] });
  ok(p3.origin === "7 8 9", "既有键缺失时才用规范小写键新建");

  const p4 = { id: 4, Scale: { user: "u", value: "1 1 1" }, visible: { script: CODE, value: true }, ALPHA: 0.25 };
  docMod.writeObjProps(p4, { scale: [2, 2, 2], visible: false, alpha: 0.5, brightness: 0.8 });
  ok(
    json(p4) === json({ id: 4, Scale: { user: "u", value: "2 2 2" }, visible: { script: CODE, value: false }, ALPHA: 0.5, brightness: 0.8 }),
    `多字段往返：只改 .value、保留 script/user、大小写原名不动（got ${json(p4)}）`,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// G. 变异红测：把实现改坏，确认对应判据真的会红（防假绿）
// ═══════════════════════════════════════════════════════════════════════════
section("G. 变异红测");
{
  const mut = async (from, to, tag) => {
    const changed = srcText.replace(from, to);
    ok(changed !== srcText, `注入点存在（${tag}）`);
    if (changed === srcText) return null;
    return loadEditorModule("scripts", { [SRC]: changed });
  };
  const mutDoc = async (from, to, tag) => {
    const changed = docSrcText.replace(from, to);
    ok(changed !== docSrcText, `注入点存在（${tag}）`);
    if (changed === docSrcText) return null;
    return loadEditorModule("doc", { [DOC_SRC]: changed });
  };

  // G1. 尾键从点号写回下标 —— 本轮真踩过的坑：fixture 上「看起来对」，真语料上整族读不到
  const g1 = await mut("`${head}.${tail}`", "`${head}[${tail}]`", "寻址串尾键用点号");
  if (g1) {
    const o = { effects: [{ passes: [{ constantshadervalues: { Strength: { script: CODE, value: 0.3 } } }] }] };
    const c = g1.getScript(o, "effects[0].passes[0].constantshadervalues.Strength");
    ok(c !== CODE, `尾键写成下标时「效果常量挂点读得到脚本」判据变红（got ${json(c)}）`);
  }

  // G2. 忽略大小写口径 → 引擎那边的键名匹配是大小写不敏感的，写回会分叉
  const g2 = await mut('if (def.keyPolicy === "insensitive") {', "if (false) {", "效果常量键名大小写不敏感");
  if (g2) {
    const o = { effects: [{ passes: [{ constantshadervalues: { Strength: { script: CODE, value: 0.3 } } }] }] };
    const c = g2.getScript(o, "effects[0].passes[0].constantshadervalues.strength");
    ok(c !== CODE, `大小写敏感时「strength 读到 Strength」判据变红（got ${json(c)}）`);
  }

  // G3. 去脚本时无视 .value 包装 → 用户属性绑定被脚本一起吞掉
  const g3 = await mut("at.host[at.key] = rest.length ? cur : cur.value;", "at.host[at.key] = cur.value;", "removeScript 保留同族绑定");
  if (g3) {
    const o = { alpha: { user: "op", script: CODE, value: 0.5 } };
    g3.removeScript(o, "alpha");
    ok(json(o.alpha) !== json({ user: "op", value: 0.5 }), `丢掉包装时「去脚本保留 user 绑定」判据变红（got ${json(o.alpha)}）`);
  }

  // G4. 写脚本时覆盖整个包装 → scriptproperties / 快照 / 关键帧一起丢
  const g4 = await mut("    cur.script = code;", "    at.host[at.key] = { script: code };", "setScript 只改 .script");
  if (g4) {
    const o = { effects: [{ passes: [{ constantshadervalues: { S: { script: CODE, scriptproperties: { a: 1 }, value: 0.5 } } }] }] };
    g4.setScript(o, "effects[0].passes[0].constantshadervalues.S", CODE2);
    ok(
      json(o.effects[0].passes[0].constantshadervalues.S) !== json({ script: CODE2, scriptproperties: { a: 1 }, value: 0.5 }),
      `覆盖包装时「改脚本保留 .value 与 scriptproperties」判据变红（got ${json(o.effects[0].passes[0].constantshadervalues.S)}）`,
    );
  }

  // G5. 空源码守卫拿掉 → 空脚本会把容器键造出来（scene.json 多一个没用的空挂点）
  const g5 = await mut('if (typeof code !== "string" || !code.trim()) return false;', 'if (typeof code !== "string") return false;', "空白源码不算修改");
  if (g5) {
    const scene = { objects: [], general: {} };
    g5.setScript(scene, "general.blank", "   ");
    ok("blank" in scene.general, `不校验空白源码时「空白不新建键」判据变红（got ${json(scene.general)}）`);
  }

  // G6. 键捕获排除方括号 → 带 `[P1]` 前缀的材质名整族读不到（真语料 54 处，本轮真踩过）
  const KEYNAME = "[P1] Semi-major|长半轴";
  const g6 = await mut(String.raw`"(\\d+)" : "(.+)"`, String.raw`"(\\d+)" : "([^\[\]]+)"`, "键名捕获容得下方括号");
  if (g6) {
    const o = { effects: [{ passes: [{ constantshadervalues: { [KEYNAME]: { script: CODE, value: 1 } } }] }] };
    const c = g6.getScript(o, `effects[0].passes[0].constantshadervalues.${KEYNAME}`);
    ok(c !== CODE, `键捕获排除方括号时「带方括号的材质名读得回」判据变红（got ${json(c)}）`);
  }

  // G7. 去掉失败回滚 → setScript 返回 false 但文档里留下空盒子（返回值说没改、实际改了）
  const g7 = await mut("  for (let i = created.length - 1; i >= 0; i--) delete created[i].host[created[i].key];", "  void created;", "locate 失败回滚新建的容器");
  if (g7) {
    const o = { id: 9, effects: [{ passes: [{}] }] };
    const before = json(o);
    g7.setScript(o, "effects[0].passes[0].constantshadervalues.NotThere", CODE);
    ok(json(o) !== before, `不回滚时「失败时文档零副作用」判据变红（got ${json(o)}）`);
  }

  // G8. 去掉真实键名解析 → 大小写不一致的既有字段被另起一个小写键（§8.2 L1 回归）
  const g8 = await mutDoc("    const real = realKey(key);", "    const real = key;", "writeObjProps 大小写不敏感命中原名");
  if (g8) {
    const o = { id: 1, Origin: "0.50000 0.50000 0.50000" };
    g8.writeObjProps(o, { origin: [1, 2, 3] });
    ok(json(o) !== json({ id: 1, Origin: "1 2 3" }), `不解析真实键名时「不新增规范小写键」判据变红（got ${json(o)}）`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("");
if (errors.length > 0) {
  console.log(`✗ 共 ${errors.length} 处问题（通过 ${passed}）`);
  process.exit(1);
} else {
  console.log(`✓ 全部通过（${passed} 项）`);
}
