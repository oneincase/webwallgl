// 全库扫描：`instance.textures` / `instance.usertextures` 的形态分布（只读素材库，不依赖 GPU / dev server）。
//
// 用途：判断一条「实例层」缺陷是单张特例还是**一类**。2026-10-14 的 3815761795「画桥」整屏发白就
// 靠它定面：343 层/67 张带 `instance.textures`，其中 224 层是纯 `util/`（内置白贴图 = 纯色填充），
// 真名贴图 119 层/21 张——且这 119 层的 `materials/<name>.tex` **逐张都在包内**，说明「把贴图名
// 从 `instance.textures` 读回来」就能生效；而它们引用的实例材质（`materials/util/solidlayer_instance_*.json`）
// 一张都不在包里（运行时合成，属正常现象）。
//
// 用法：node scripts/_scan-instance-textures.mjs
import fs from "node:fs";
import path from "node:path";
import { ROOT, LIB, dec } from "./lib/verify-kit.mjs";

const { parsePkg, getEntry } = await import(
  path.join(ROOT, "renderer/vendor/we-scene/pkg/container.js")
);

const ids = fs.readdirSync(LIB).filter((d) => fs.existsSync(path.join(LIB, d, "scene.pkg")));
let scanned = 0;
const hitTex = [];
const hitUser = [];
const missMat = [];
let layersWithInstanceTextures = 0;

for (const id of ids) {
  let pkg;
  try {
    const buf = new Uint8Array(fs.readFileSync(path.join(LIB, id, "scene.pkg")));
    pkg = parsePkg(buf);
  } catch {
    continue;
  }
  const entry = pkg.entries.find((e) => e.name === "scene.json");
  if (!entry) continue;
  let sj;
  try {
    sj = JSON.parse(dec.decode(getEntry(pkg, "scene.json")).replace(/^\uFEFF/, ""));
  } catch {
    continue;
  }
  scanned++;
  const names = new Set(pkg.entries.map((e) => e.name));
  for (const o of sj.objects || []) {
    const inst = o.instance;
    if (!inst || typeof inst !== "object") continue;
    const ut = inst.textures;
    const uut = inst.usertextures;
    if (Array.isArray(ut) && ut.filter(Boolean).length) {
      layersWithInstanceTextures++;
      hitTex.push({ id, oid: o.id, name: o.name, image: o.image, textures: ut, solid: !!o.solid });
      // 该 texture 名字在包内有没有对应 materials/<name>.tex
      for (const t of ut) {
        if (t && typeof t === "string" && !names.has(`materials/${t}.tex`)) {
          missMat.push({ id, oid: o.id, t });
        }
      }
    }
    if (Array.isArray(uut) && uut.filter(Boolean).length) {
      hitUser.push({ id, oid: o.id, name: o.name, usertextures: uut });
    }
  }
}
console.log("scanned wallpapers:", scanned, "of", ids.length);
console.log("layers with instance.textures:", layersWithInstanceTextures, "wallpapers:", new Set(hitTex.map((h) => h.id)).size);
console.log("layers with instance.usertextures:", hitUser.length, "wallpapers:", new Set(hitUser.map((h) => h.id)).size);
console.log("instance.textures names missing materials/<n>.tex:", missMat.length);
console.log("\n--- sample instance.textures ---");
for (const h of hitTex.slice(0, 25)) {
  console.log(h.id, h.oid, JSON.stringify(h.name), h.image, JSON.stringify(h.textures), h.solid ? "solid" : "");
}
console.log("\n--- sample instance.usertextures ---");
for (const h of hitUser.slice(0, 10)) {
  console.log(h.id, h.oid, JSON.stringify(h.name), JSON.stringify(h.usertextures));
}
console.log("\n--- missing tex ---");
for (const m of missMat.slice(0, 20)) console.log(m.id, m.oid, m.t);
console.log("\n--- distinct images of instance.textures layers ---");
const imgCount = new Map();
for (const h of hitTex) imgCount.set(h.image, (imgCount.get(h.image) || 0) + 1);
for (const [k, v] of [...imgCount].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(v, k);
