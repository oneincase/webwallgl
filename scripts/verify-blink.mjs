#!/usr/bin/env node
/**
 * verify-blink —— 眼睑盖住眼球时的同步压扁，按网格尺寸收口，不按壁纸 ID。
 *
 * 语料（本机壁纸库，缺包则跳过对应条，源码守卫始终跑）：
 *   必须压到 k=0：3655429099 08眼组、3629379075 眼睛部件、
 *     3791967416 小眼睛（旧「同帧 ≤3」会整帧扔掉）、3521337568 Lucy（全身里的眼球）、
 *     3808922316 眼睛（闭眼只有 0.2 秒，均匀 16 点全部落在窗外）
 *   必须一个零件都不压：3226487183 花火、3351179520 头发、
 *     3078285611 / 3264246690 上静止长边 >120 的零件
 *   必须保留深色睑线（睫毛带一个都不许压）：3671936032 人物
 *   全身网格里「大件也跟着收」必须成立：3671936032 人物的虹膜 444×217 / 高光 432×166（艾玛）
 *     与眼球 49×153（希罗）（该张一张 puppet 塞两个角色；眼球比眼白小、静止时与眼白不在同一块
 *     UV 岛、两者静止盒甚至不相交 —— 只能靠「当前姿势下真的压在它身上」认出来）
 *
 * 改坏会红：把 PART_SQUASH_BODY 放到 800，躯干块就会被压，长边断言转红；
 * 把 PART_SQUASH_MESH 放到 0，小眼睛走全身分支被「>3」扔掉，k=0 断言转红；
 * 删掉 collapsedPartSquash 里的「静止盒子相交」判据，3671936032 的睫毛会被压到 k=0 转红；
 * 删掉「同骨组（bone.parent 相同）」或「当前交叠 ≥ 较小者 1/5」或把 PART_SQUASH_BODY_DEEP
 * 放到 0.9，3078285611 的 232×761 / 323×389 / 156×150 或 3264246690 的大件会被压，长边断言转红。
 */
import fs from "node:fs";
import { join } from "node:path";
import { ROOT, LIB, imp, createChecker, dec } from "./lib/verify-kit.mjs";

const { check, errors } = createChecker();
const { parsePkg, getEntry } = await imp("renderer/vendor/we-scene/pkg/container.js");
const { parseMDL, computeSkinMatrices, collapsedPartSquash } = await imp("renderer/vendor/we-scene/render/mdl.js");

const mdlSrc = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/mdl.js"), "utf8");
check(!mdlSrc.includes("COLLAPSED_PART_CULL_WORKSHOPS"), "眨眼补偿不得再按壁纸 ID 白名单");
check(/const PART_SQUASH_MESH = 900/.test(mdlSrc), "眼组/全身的分界必须是网格静止长边 900");
check(/const PART_SQUASH_BODY = 110/.test(mdlSrc), "全身网格上的被盖件静止长边上限必须是 110");
check(/span\.long > PART_SQUASH_MESH && kept\.length > 3/.test(mdlSrc), "全身网格滤完高度后仍超过 3 个必须整帧放弃");
check(/if \(squash\) \{/.test(mdlSrc) && !/if \(squash \|\|/.test(mdlSrc),
  "只有这一帧真要压扁才按零件画；squash 为 null 时走整网格一次画完");
check(/Math\.min\(cp\.y1, rp\.y1\) > Math\.max\(cp\.y0, rp\.y0\)/.test(mdlSrc),
  "配对必须先要求「静止姿势下收拢件盖着被盖件」，否则被压成一条线的零件会靠中心点扫中无关零件");
check(/const PART_SQUASH_BODY_DEEP = 0\.4/.test(mdlSrc),
  "全身网格上让大件（虹膜/眼球）跟着收的唯一破例：收拢件自己被压到 0.4 以下才算真闭眼");
check(/ownBone\.parent === colBone\.parent/.test(mdlSrc),
  "跟着收的大件必须与收拢件同属一颗骨（同一只眼的零件），否则躯干块会被当成眼球");
check(/ix \* iy < 0\.2 \* Math\.min\(rArea, w \* h\)/.test(mdlSrc),
  "被盖的大件必须在**当前这一帧**真的被收拢件压住（交叠 ≥ 较小者 1/5），否则塌成一条线的无关零件会扫中大件");

function loadScene(id) {
  const dir = join(LIB, id);
  const pkgPath = join(dir, "scene.pkg");
  if (fs.existsSync(pkgPath)) {
    const pkg = parsePkg(new Uint8Array(fs.readFileSync(pkgPath)));
    return { scene: JSON.parse(dec.decode(getEntry(pkg, "scene.json"))), get: (rel) => getEntry(pkg, rel) };
  }
  const loose = join(dir, "scene.json");
  if (!fs.existsSync(loose)) return null;
  return { scene: JSON.parse(fs.readFileSync(loose, "utf8")), get: (rel) => fs.readFileSync(join(dir, rel)) };
}

function puppet(id, layerName) {
  const loaded = loadScene(id);
  if (!loaded) return null;
  for (const obj of loaded.scene.objects || []) {
    if (layerName && obj.name !== layerName) continue;
    const image = obj.image;
    if (typeof image !== "string" || !image.endsWith(".json")) continue;
    let model;
    try { model = JSON.parse(dec.decode(loaded.get(image))); } catch { continue; }
    if (!model?.puppet) continue;
    try { return parseMDL(loaded.get(model.puppet)); } catch { return null; }
  }
  return null;
}

/** 每根骨骼缩放幅度最低的一帧，再加 8 个均匀点。眨眼往往只有零点几秒，均匀采样会落空。 */
function sampleTimes(anim) {
  const fps = anim.fps > 0 ? anim.fps : 30;
  const times = new Set([0]);
  for (const tr of anim.tracks || []) {
    const kf = tr.keyframes;
    if (!kf) continue;
    const n = tr.frameCount || kf.length / 9;
    let best = 1;
    let bestF = 0;
    for (let f = 0; f < n; f++) {
      const mag = Math.min(Math.abs(kf[f * 9 + 7]), Math.abs(kf[f * 9 + 8]));
      if (mag < best) { best = mag; bestF = f; }
    }
    if (best < 0.85) times.add(bestF / fps);
  }
  const dur = Math.max(1e-3, anim.duration || 1);
  for (let si = 0; si < 8; si++) times.add((dur * si) / 8);
  return times;
}

function minK(mdl) {
  const out = new Array(mdl.parts.length).fill(1);
  let any = false;
  for (const a of mdl.animations || []) {
    const layers = [{ animation: a.id, visible: true, additive: false, blend: 1, rate: 1 }];
    for (const t of sampleTimes(a)) {
      try { computeSkinMatrices(mdl, t, layers); } catch { continue; }
      const sq = collapsedPartSquash(mdl, mdl._skin, layers);
      if (!sq) continue;
      any = true;
      for (let p = 0; p < mdl.parts.length; p++) if (sq[p * 3] < out[p]) out[p] = sq[p * 3];
    }
  }
  return { out, any };
}

function partOf(mdl, w, h) {
  return mdl.parts.findIndex((p) => Math.abs((p.x1 - p.x0) - w) < 3 && Math.abs((p.y1 - p.y0) - h) < 3);
}

let corpus = 0;
function need(id, layer) {
  const mdl = puppet(id, layer);
  if (!mdl || !mdl.parts || mdl.parts.length < 2) {
    console.log(`   skip ${id} ${layer || ""}：库里没有这份 puppet`);
    return null;
  }
  corpus++;
  return mdl;
}

{
  const mdl = need("3655429099", "08眼组");
  if (mdl) {
    const i = partOf(mdl, 82, 70);
    check(i >= 0, "3655429099 08眼组应有约 82×70 的眼球零件");
    if (i >= 0) {
      const k = minK(mdl).out[i];
      check(k === 0, `3655429099 左眼球应压到 k=0，实际 ${k}`);
    }
  }
}
{
  const mdl = need("3629379075", "若叶睦 眼睛部件");
  if (mdl) {
    const i = partOf(mdl, 91, 107);
    check(i >= 0, "3629379075 眼睛部件应有约 91×107 的眼球零件");
    if (i >= 0) {
      const k = minK(mdl).out[i];
      check(k === 0, `3629379075 眼球应压到 k=0，实际 ${k}`);
    }
  }
}
{
  const mdl = need("3791967416", "小眼睛");
  if (mdl) {
    const k = Math.min(...minK(mdl).out);
    check(k === 0, `3791967416 小眼睛应有零件压到 k=0（眼组不能被「同帧≤3」整帧扔掉），实际最低 ${k}`);
  }
}
{
  const mdl = need("3808922316", "眼睛");
  if (mdl) {
    const i = partOf(mdl, 150, 142);
    check(i >= 0, "3808922316 眼睛应有约 150×142 的刚性零件");
    if (i >= 0) {
      const k = minK(mdl).out[i];
      check(k === 0, `3808922316 眼睛的 150×142 零件应压到 k=0（短眨眼不能被 16 点采样漏掉），实际 ${k}`);
    }
  }
}
{
  const mdl = need("3521337568", "Lucy");
  if (mdl) {
    const i = partOf(mdl, 62, 49);
    check(i >= 0, "3521337568 Lucy 应有约 62×49 的头部零件");
    if (i >= 0) {
      const k = minK(mdl).out[i];
      check(k === 0, `3521337568 Lucy 的 62×49 零件应压到 k=0，实际 ${k}`);
    }
  }
}
{
  // 3671936032「人物」：一张 puppet 里塞了两个角色（艾玛=骨头 29~47、希罗=49~71），
  // 闭眼靠**睫毛带**（静止 58×40 / 64×38 / 78×46 / 63×53 / 73×77）盖住虹膜——
  // 绘制顺序按 part 索引升序，睫毛在虹膜之上。眼白（168×171 / 150×140）在眨眼时被压成
  // 一条 13px 高的细线，旧版的「中心落在盒内」判据对细线是退化的：线扫过谁谁就算被盖住，
  // 于是睫毛被压到 k=0，绘制侧 `k < 0.25` 把它们整块删掉 → 用户看到的
  //「人物眨眼只有睫毛动、眼睛不闭」。这些零件在静止姿势下与眼白毫无重叠，一个都不许被压。
  const mdl = need("3671936032", "人物");
  if (mdl) {
    const lashes = [[58, 40], [64, 38], [78, 46], [63, 53], [73, 77]];
    const { out } = minK(mdl);
    for (const [w, h] of lashes) {
      const i = partOf(mdl, w, h);
      check(i >= 0, `3671936032 应有约 ${w}×${h} 的睫毛零件`);
      if (i >= 0) check(out[i] === 1, `3671936032 的 ${w}×${h} 睫毛是闭眼时的深色睑线，不得被压（实际 k=${out[i].toFixed(2)}）`);
    }
    // 反过来：被眼皮收掉时，**盖在下面的虹膜与高光必须跟着收**（用户实测
    //「人物眼球一直都是最大状态，睫毛往下运动时也没有被遮罩」）。它们静止时与眼白不在同一块
    // UV 岛、静止盒甚至不相交（希罗的眼球 49×153 与眼白 150×140 面积比只有 0.36），所以走的是
    // 全身网格专属的四条硬条件（同骨组 + 收拢件真收完 + 尺度相近 + **当前这一帧真被压住**），
    // 而不是老的中心/宽度判据，也不是「静止面积 ≥2 倍」那种绝对尺寸判据。
    for (const [w, h] of [[444, 217], [432, 166], [49, 153]]) {
      const i = partOf(mdl, w, h);
      check(i >= 0, `3671936032 应有约 ${w}×${h} 的眼球/高光零件`);
      if (i >= 0) check(out[i] === 0, `3671936032 的 ${w}×${h} 眼球/高光必须跟着眼白收掉（实际 k=${out[i].toFixed(2)}）`);
    }
  }
}
for (const [id, layer] of [["3226487183", "中间默认主体"], ["3351179520", "头发"]]) {
  const mdl = need(id, layer);
  if (!mdl) continue;
  const { any, out } = minK(mdl);
  const worst = Math.min(...out);
  check(!any && worst === 1, `${id} ${layer} 不得压扁任何零件（实际最低 k=${worst}）`);
}
for (const [id, layer] of [["3078285611", ""], ["3264246690", "1拆分"]]) {
  const mdl = need(id, layer || null);
  if (!mdl) continue;
  const { out } = minK(mdl);
  for (let p = 0; p < mdl.parts.length; p++) {
    const part = mdl.parts[p];
    const long = Math.max(part.x1 - part.x0, part.y1 - part.y0);
    if (long > 120 && out[p] < 1) {
      check(false, `${id} 静止长边 ${long.toFixed(0)} 的零件被压到 k=${out[p].toFixed(2)}（躯干/头板不该跟着眼睑规则走）`);
    }
  }
}

console.log(corpus ? `   语料 ${corpus} 个 puppet` : "   语料跳过（本机没有壁纸库）");
console.log(errors.length === 0 ? "verify-blink: 全部通过 ✓" : `verify-blink: ${errors.length} 项失败 ✗`);
for (const e of errors) console.log("  ✗ " + e);
process.exit(errors.length === 0 ? 0 : 1);
