// 普查第三轮（定稿口径）：可烘焙单元 = 「z 序连续段 ∩ 视差深度相同 ∩ 混合模式相同」
// 的顶层静态子树。
//   ① 单位是**子树**：子层继承父变换，整棵不变就能跟根一起烘（第一轮把 child 当动态是判据错）；
//   ② 视差：段内深度必须相同（同深度整段平移一致，可以烘成一张，运行时整体位移）；
//   ③ 混合：段内混合模式必须相同（否则合成结果无法用单一混合复现，按模式切段）；
//   ④ 驱动效果按 `effects[].file` 的官方目录名判定（时间/音频/指针驱动的效果结果逐帧在变）。
import fs from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { LIB, ROOT } from "../lib/verify-kit.mjs";

const container = await import(pathToFileURL(join(ROOT, "renderer/vendor/we-scene/pkg/container.js")).href);
const scn = await import(pathToFileURL(join(ROOT, "renderer/vendor/we-scene/scene/parse.js")).href);

/** 逐帧在变的效果（官方 effects/<目录>）。blend/tint/color 这类是静态合成，不列。 */
const DRIVEN_DIR = /^(waterripple|waterwaves|waterflow|water|pulse|shake|foliagesway|iris|audiobars|audio|scroll|spin|fluorescent|glitch|twinkle|depthparallax|fog|rain|snow|noise|turbulence|vortex|refract|fluidsimulation|watercaustics|godrays|lightshaft|chromaticaberration|bloom|hdrbloom|scanlines|crt|trail|feedback|spritesheetanimation|particles|workshop)/i;

const props = (o) => (o && typeof o === "object" ? Object.values(o) : []);
function selfDynamic(l) {
  const why = [];
  for (const v of props(l)) {
    if (v && typeof v === "object" && v.script) why.push("script");
    if (v && typeof v === "object" && (v.animation || v.animations)) why.push("anim");
  }
  if (l.textScript || l.script || l.visibleScript) why.push("script");
  if (l.particle) why.push("particle");
  if (l.puppet) why.push("puppet");
  if (l.text != null) why.push("text");
  if (l.model) why.push("model");
  for (const e of l.effects || []) {
    if (e?.visible?.script || e?.visibleScript) why.push("script");
    const file = String(e?.file || "");
    const dir = file.replace(/^effects\//, "").split("/")[0];
    if (dir && DRIVEN_DIR.test(dir)) why.push(`fx:${dir}`);
    for (const p of e?.passes || []) {
      for (const v of props(p?.constantshadervalues || {})) {
        if (v && typeof v === "object" && v.script) why.push("script");
        if (v && typeof v === "object" && (v.animation || v.animations)) why.push("anim");
      }
    }
  }
  return [...new Set(why)];
}

const rows = [];
const fxHist = {};
const ids = fs.readdirSync(LIB).filter((d) => !d.startsWith("."));
for (const id of ids) {
  const pkgPath = join(LIB, id, "scene.pkg");
  if (!fs.existsSync(pkgPath)) continue;
  let pkg;
  try {
    pkg = container.parsePkg(new Uint8Array(fs.readFileSync(pkgPath)));
  } catch {
    continue;
  }
  const entry = container.getEntry(pkg, "scene.json") ?? container.getEntry(pkg, "scenes/scene.json");
  if (!entry) continue;
  let scene;
  try {
    scene = scn.parseScene(JSON.parse(new TextDecoder().decode(entry)), null);
  } catch {
    continue;
  }
  const layers = (scene.layers || []).filter(Boolean);
  if (!layers.length) continue;

  const byId = new Map();
  for (const l of layers) if (l.id != null) byId.set(l.id, l);
  const childrenOf = new Map();
  for (const l of layers) {
    if (l.parentId == null) continue;
    if (!childrenOf.has(l.parentId)) childrenOf.set(l.parentId, []);
    childrenOf.get(l.parentId).push(l);
  }
  const self = new Map();
  for (const l of layers) {
    self.set(l, selfDynamic(l));
    for (const e of l.effects || []) {
      const dir = String(e?.file || "").replace(/^effects\//, "").split("/")[0] || "(none)";
      fxHist[dir] = (fxHist[dir] || 0) + 1;
    }
  }
  // 子树动态性（自底向上）
  const sub = new Map();
  const visit = (l) => {
    if (sub.has(l)) return sub.get(l);
    const why = new Set(self.get(l));
    for (const c of childrenOf.get(l.id) || []) for (const w of visit(c)) why.add(w);
    const arr = [...why];
    sub.set(l, arr);
    return arr;
  };
  for (const l of layers) visit(l);

  const roots = layers.filter((l) => l.parentId == null);
  const countTree = (l) => 1 + (childrenOf.get(l.id) || []).reduce((n, c) => n + countTree(c), 0);
  const key = (l) => {
    const p = Number(l.parallaxDepth?.value ?? l.parallaxDepth ?? 0) || 0;
    const b = String(l.blendmode ?? l.blend ?? "normal");
    return `${p}|${b}`;
  };
  // z 序扫描：连续且 key 相同的静态子树并成一批
  let baked = 0;
  let batches = 0;
  let curKey = null;
  for (const l of roots) {
    const ok = sub.get(l).length === 0;
    if (!ok) {
      curKey = null;
      continue;
    }
    const k = key(l);
    if (k !== curKey) {
      batches++;
      curKey = k;
    }
    baked += countTree(l);
  }
  rows.push({ id, layers: layers.length, baked, batches, pct: baked / layers.length });
}

const med = (a) => {
  const s = a.slice().sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};
const sum = (a) => a.reduce((x, y) => x + y, 0);
const TL = sum(rows.map((r) => r.layers));
const TB = sum(rows.map((r) => r.baked));
const TBatches = sum(rows.map((r) => r.batches));
console.log(`扫描 ${rows.length} 张场景 / ${TL} 个图层`);
console.log(`可烘焙（段内同视差同混合、整棵无自带动态）：${TB} 个图层 = ${((TB / TL) * 100).toFixed(1)}%`);
console.log(`中位场景：图层 ${med(rows.map((r) => r.layers))}，可烘焙 ${med(rows.map((r) => r.baked))}（${(med(rows.map((r) => r.pct)) * 100).toFixed(0)}%），合成批次数 ${med(rows.map((r) => r.batches))}`);
console.log(`全部场景合计：可烘焙 ${TB} 层 → ${TBatches} 张合成纹理（平均每张覆盖 ${(TB / Math.max(1, TBatches)).toFixed(1)} 层）`);
const heavy = rows.slice().sort((a, b) => b.layers - a.layers).slice(0, 10);
console.log(`\n图层最多的 10 张：`);
for (const r of heavy) {
  console.log(`  ${r.id.padEnd(12)} 图层 ${String(r.layers).padStart(4)}  可烘焙 ${String(r.baked).padStart(4)}（${String((r.pct * 100).toFixed(0)).padStart(3)}%）  批次 ${String(r.batches).padStart(3)}  平均每批 ${(r.baked / Math.max(1, r.batches)).toFixed(1)} 层`);
}
console.log(`\n效果出现次数（前 18，驱动型已标）：`);
for (const [k, v] of Object.entries(fxHist).sort((a, b) => b[1] - a[1]).slice(0, 18)) {
  console.log(`  ${DRIVEN_DIR.test(k) ? "驱动" : "静态"}  ${k.padEnd(22)} ${v}`);
}
fs.writeFileSync("/tmp/perf-bench/bake-census3.json", JSON.stringify({ rows, fxHist }, null, 1));
