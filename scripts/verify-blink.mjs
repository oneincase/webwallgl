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
 *
 * 改坏会红：把 PART_SQUASH_BODY 放到 800，躯干块就会被压，长边断言转红；
 * 把 PART_SQUASH_MESH 放到 0，小眼睛走全身分支被「>3」扔掉，k=0 断言转红。
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
