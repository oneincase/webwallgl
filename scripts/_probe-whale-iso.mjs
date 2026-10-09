// 隔离渲染探针：只留导入的模型层、关掉该壁纸的所有效果与 bloom，在固定大小宿主里
// 用编辑器 API 渲染并截图（用来和 Blender 原型对照，以及给修复做前后对比）。
// 用法：node scripts/_probe-whale-iso.mjs <itemId> <out.png> [auto|mesh|puppet]
//   ISO_STOCK=1 → 不导入任何模型，整张壁纸原样渲染（给「既有壁纸零影响」做前后像素对比，
//                 并把每个图层的 depthMesh / lightingEnabled 标记打出来）。
import fs from "node:fs";
import path from "node:path";
import { launchHeadless, instrument } from "./headless-gpu.mjs";

const [id, outPng, form = "auto"] = process.argv.slice(2);
const STOCK = process.env.ISO_STOCK === "1";
const ORIGIN = process.env.PROBE_ORIGIN || "http://localhost:1430";
const ROOT = "/Users/oneincase/Documents/workspace/webwallgl-github";
const MODEL_DIR = process.env.WHALE_DIR || "/Users/oneincase/Documents/blender/鲸鱼坤";
const W = Number(process.env.ISO_W || 900);
const H = Number(process.env.ISO_H || 900);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 模型文件放进 ROOT 下（vite root）才能被页面 fetch 到
const served = path.join(ROOT, ".tmp", "whale-iso");
let names = [];
let mainName = null;
if (!STOCK) {
  fs.rmSync(served, { recursive: true, force: true });
  fs.mkdirSync(served, { recursive: true });
  names = fs.readdirSync(MODEL_DIR).filter((f) => /\.(obj|mtl|gltf|glb|bin|png|jpe?g|tga|bmp)$/i.test(f));
  for (const n of names) fs.copyFileSync(path.join(MODEL_DIR, n), path.join(served, n));
  mainName = names.find((n) => /\.(gltf|glb)$/i.test(n)) ?? names.find((n) => /\.obj$/i.test(n));
  console.log("模型文件：", names.join(", "));
}

const session = await launchHeadless({ task: `whale-iso-${STOCK ? "stock" : form}`, width: W, height: H });
instrument(session, { width: W, height: H });
try {
  await session.pageCdp.send("Page.navigate", { url: `${ORIGIN}/renderer/index.html?type=canvas` });
  await session.waitFor(`!!window.__wp`, { timeoutMs: 120000 });
  const r = await session.evaluate(
    `(async () => {
       window.__wp.pause();
       const api = await import('/renderer/src/api/editor.ts');
       const C = await import('/renderer/vendor/we-scene/pkg/container.js');
       const G = await import('/editor/gltf.ts');
       const D = await import('/editor/doc.ts');
       const MI = await import('/editor/model-import.ts');
       const base = api.httpSource('${ORIGIN}/media/dev/${id}');
       const pkg = C.parsePkg(new Uint8Array(await base.scenePkg()));
       const sceneText = new TextDecoder().decode(C.getEntry(pkg, 'scene.json')).replace(/^\\uFEFF/, '');
       const doc = D.makeDoc('t', null, JSON.parse(sceneText), 'loose');
       const extra = new Map();
       let target = null, newId = null, modelFile = null, material = null, warnings = [];
       if (!${STOCK}) {
         const side = new Map();
         for (const n of ${JSON.stringify(names)}) side.set(n.toLowerCase(), new Uint8Array(await (await fetch('/.tmp/whale-iso/' + encodeURIComponent(n))).arrayBuffer()));
         const resolve = (uri) => { let u = uri; try { u = decodeURIComponent(uri); } catch {} const b = u.replace(/\\\\/g, '/').split('/').pop().toLowerCase(); return side.get(u.toLowerCase()) ?? side.get(b) ?? null; };
         const loaded = await MI.loadModelFile(${JSON.stringify(mainName)}, side.get(${JSON.stringify(String(mainName).toLowerCase())}), resolve);
         const gltf = loaded.gltf;
         const force = ${JSON.stringify(form)} === 'auto' ? null : ${JSON.stringify(form)};
         target = force ?? G.defaultTarget(doc);
         const pixelUnits = target === 'puppet' || G.isOrthoDoc(doc);
         const m = G.gltfToModel(gltf, { target, slug: 'whale', fps: 30, scale: pixelUnits ? G.fitPuppetScale(doc) : G.fitMeshScale(doc) });
         warnings = m.warnings;
         await G.bakePuppetAtlas(m);
         const f = G.gltfImportFiles(m, 'whale');
         newId = G.addModelLayer(doc, m, f.path, 'Whale');
         for (const x of f.files) extra.set(x.name, x.data);
         modelFile = f.path;
         material = JSON.parse(new TextDecoder().decode(extra.get('materials/editor/' + (target === 'puppet' ? 'whale' : 'whale_0') + '.json')));
       }
       const sceneBytes = new TextEncoder().encode(JSON.stringify(doc.scene));
       const read = async (n) => (n === 'scene.json' ? sceneBytes : extra.get(n) ?? C.getEntry(pkg, n) ?? null);
       const host = document.createElement('div');
       host.style.cssText = 'position:fixed;left:0;top:0;width:${W}px;height:${H}px;z-index:9';
       document.body.appendChild(host);
       const diags = [];
       const loose = { scenePkg: () => base.scenePkg(), sceneDir: async () => ({ entry: 'scene.json', read }), project: base.project ? (s) => base.project(s) : undefined };
       const inst = await api.mount(host, { source: loose, fit: 'cover', renderDpr: 1, volume: 0, autoplay: false, onDiagnostic: (x) => diags.push(String(x)) });
       const ed = api.editorOf(inst);
       inst.pause();
       const gen = window.__scene?.general;
       if (gen) { gen.bloom = false; gen.bloomstrength = 0; }
       if (newId !== null) for (const l of ed.getLayers()) await ed.setLayerProps(l.id, { visible: l.id === newId });
       for (const l of window.__scene.layers) for (const e of l.effects || []) e.visible = false;
       const flags = window.__scene.layers.map((l) => ({ name: l.name, visible: !!l.visible, depthMesh: !!l.depthMesh, lighting: !!l.lightingEnabled, defLight: !!l.defaultMeshLight, normals: !!((((l.puppet || {}).meshes) || []).some((m) => m.normals)) }));
       await ed.seek(0.5);
       const bm = await createImageBitmap(await ed.capture());
       const cv = new OffscreenCanvas(bm.width, bm.height);
       const g2 = cv.getContext('2d');
       g2.drawImage(bm, 0, 0);
       const d = g2.getImageData(0, 0, bm.width, bm.height).data;
       // 与背景（左上角）不同的像素 = 模型覆盖区
       const bg = [d[0], d[1], d[2]];
       let n = 0, sr = 0, sg = 0, sb = 0, sl = 0, sl2 = 0, minL = 255, maxL = 0;
       const hist = new Array(8).fill(0);
       for (let k = 0; k < bm.width * bm.height; k++) {
         const i = k * 4;
         if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) <= 12) continue;
         const L = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
         n++; sr += d[i]; sg += d[i + 1]; sb += d[i + 2]; sl += L; sl2 += L * L;
         minL = Math.min(minL, L); maxL = Math.max(maxL, L);
         hist[Math.min(7, Math.floor(L / 32))]++;
       }
       const blob = await cv.convertToBlob({ type: 'image/png' });
       const b64 = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.readAsDataURL(blob); });
       inst.destroy();
       return JSON.stringify({ target, newId, size: [bm.width, bm.height], bg, pixels: n, mean: n ? [sr / n, sg / n, sb / n].map((v) => +v.toFixed(1)) : null,
         meanL: n ? +(sl / n).toFixed(1) : null, sdL: n ? +Math.sqrt(Math.max(0, sl2 / n - (sl / n) ** 2)).toFixed(1) : null, minL: +minL.toFixed(1), maxL: +maxL.toFixed(1), hist,
         warnings, diags: diags.slice(0, 6), layers: flags.length, depthMeshLayers: flags.filter((f) => f.depthMesh), lightingLayers: flags.filter((f) => f.lighting && f.visible).length,
         modelFile, material, b64 });
     })()`,
    { awaitPromise: true, timeoutMs: 600000 },
  );
  const j = JSON.parse(r);
  fs.mkdirSync(path.dirname(outPng), { recursive: true });
  fs.writeFileSync(outPng, Buffer.from(j.b64, "base64"));
  const { b64, ...rest } = j;
  console.log(JSON.stringify(rest, null, 1));
  console.log("写出", outPng);
} finally {
  await session.close?.();
}
process.exit(0);
