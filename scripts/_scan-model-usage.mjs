#!/usr/bin/env node
/**
 * 一次性盘点：编辑器模型支持（docs/EDITOR-PLAN.md §3B）的语料占比论证（护栏 3）。
 * 数 scene.json 里 puppet 层 / 真 3D 模型层 / animationlayers 各字段形态 / attachment 挂件、
 * .mdl 的版本与段分布、多子网格与附着点、脚本骨骼 API 的使用面。
 */
import fs from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { LIB, ROOT } from "./lib/verify-kit.mjs";

const container = await import(pathToFileURL(join(ROOT, "renderer/vendor/we-scene/pkg/container.js")).href);
const mdlParse = await import(pathToFileURL(join(ROOT, "renderer/vendor/we-scene/render/mdl-parse.js")).href);

const c = {
  sceneItems: 0, itemsWithPuppet: 0, itemsWith3D: 0, itemsWithAnyModel: 0,
  puppetLayers: 0, model3DLayers: 0, imageLayers: 0,
  animLayerEntries: 0, layersWithAnimLayers: 0, animLayersMulti: 0,
  alVisibleScript: 0, alBlendScript: 0, alBlendAnim: 0, alRateScript: 0, alAdditive: 0, alRateNot1: 0, alBlendNot1: 0,
  attachLayers: 0, itemsWithAttach: 0,
  mdlFiles: 0, mdlParseFail: 0, mdlWithBones: 0, mdlWithAnims: 0, mdlWithAttach: 0, mdlMultiMesh: 0, mdlStatic3D: 0,
  boneScriptItems: 0, setBoneItems: 0,
};
const ver = new Map();
const boneCounts = [];

const read = (dir, pkg, name) => {
  const loose = join(dir, name);
  if (fs.existsSync(loose)) return new Uint8Array(fs.readFileSync(loose));
  if (pkg) {
    try { return container.getEntry(pkg, name); } catch { return null; }
  }
  return null;
};

for (const id of fs.readdirSync(LIB)) {
  const dir = join(LIB, id);
  let pkg = null;
  const pkgPath = join(dir, "scene.pkg");
  if (fs.existsSync(pkgPath)) {
    try { pkg = container.parsePkg(new Uint8Array(fs.readFileSync(pkgPath))); } catch { pkg = null; }
  }
  const sceneBuf = read(dir, pkg, "scene.json");
  if (!sceneBuf) continue;
  let scene;
  try { scene = JSON.parse(new TextDecoder().decode(sceneBuf)); } catch { continue; }
  if (!Array.isArray(scene.objects)) continue;
  c.sceneItems++;
  let hasPuppet = false, has3D = false, hasAttach = false;
  const text = new TextDecoder().decode(sceneBuf);
  if (/getBone(Transform|Index|Count)/.test(text)) c.boneScriptItems++;
  if (/setBoneTransform|applyBonePhysicsImpulse/.test(text)) c.setBoneItems++;
  for (const o of scene.objects) {
    if (!o || typeof o !== "object") continue;
    if (typeof o.model === "string" && /\.mdl$/i.test(o.model)) { c.model3DLayers++; has3D = true; }
    if (typeof o.image === "string") {
      c.imageLayers++;
      const mb = read(dir, pkg, o.image);
      if (mb) {
        try {
          const m = JSON.parse(new TextDecoder().decode(mb));
          if (typeof m.puppet === "string") { c.puppetLayers++; hasPuppet = true; }
        } catch {}
      }
    }
    if (typeof o.attachment === "string" && o.attachment) { c.attachLayers++; hasAttach = true; }
    const al = Array.isArray(o.animationlayers) ? o.animationlayers : [];
    if (al.length) c.layersWithAnimLayers++;
    if (al.length > 1) c.animLayersMulti++;
    for (const a of al) {
      if (!a) continue;
      c.animLayerEntries++;
      const isObj = (v) => v && typeof v === "object";
      if (isObj(a.visible) && a.visible.script) c.alVisibleScript++;
      if (isObj(a.blend) && a.blend.script) c.alBlendScript++;
      if (isObj(a.blend) && a.blend.animation) c.alBlendAnim++;
      if (isObj(a.rate) && a.rate.script) c.alRateScript++;
      if (a.additive === true) c.alAdditive++;
      if (typeof a.rate === "number" && a.rate !== 1) c.alRateNot1++;
      if (typeof a.blend === "number" && a.blend !== 1) c.alBlendNot1++;
    }
  }
  if (hasPuppet) c.itemsWithPuppet++;
  if (has3D) c.itemsWith3D++;
  if (hasPuppet || has3D) c.itemsWithAnyModel++;
  if (hasAttach) c.itemsWithAttach++;
  if (pkg) {
    for (const e of pkg.entries) {
      if (!/\.mdl$/i.test(e.name)) continue;
      const buf = container.getEntry(pkg, e.name);
      c.mdlFiles++;
      const magic = String.fromCharCode(...buf.subarray(0, 8));
      ver.set(magic, (ver.get(magic) || 0) + 1);
      try {
        const m = mdlParse.parseMDL(buf);
        if (m.bones.length) { c.mdlWithBones++; boneCounts.push(m.bones.length); } else c.mdlStatic3D++;
        if (m.animations.length) c.mdlWithAnims++;
        if ((m.attachments || []).length) c.mdlWithAttach++;
        if (m.meshes && m.meshes.length > 1) c.mdlMultiMesh++;
      } catch { c.mdlParseFail++; }
    }
  }
}

boneCounts.sort((a, b) => a - b);
const pct = (n) => ((100 * n) / Math.max(1, c.sceneItems)).toFixed(1) + "%";
console.log(JSON.stringify(c, null, 2));
console.log("MDL 版本:", Object.fromEntries([...ver].sort((a, b) => b[1] - a[1])));
console.log("骨数 p50/p90/max:", boneCounts[boneCounts.length >> 1], boneCounts[Math.floor(boneCounts.length * 0.9)], boneCounts.at(-1));
console.log(`含 puppet 场景 ${pct(c.itemsWithPuppet)}，含真 3D ${pct(c.itemsWith3D)}，含任一模型 ${pct(c.itemsWithAnyModel)}，含挂件 ${pct(c.itemsWithAttach)}`);
console.log(`读骨骼脚本 ${pct(c.boneScriptItems)}，写骨骼脚本 ${pct(c.setBoneItems)}`);
