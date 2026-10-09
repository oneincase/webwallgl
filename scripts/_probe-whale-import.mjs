// 临时探针：在真编辑器页面里走完整「导入模型」链路（等价于用户手动操作），把预览截下来。
// 用法：node scripts/_probe-whale-import.mjs <itemId> <outDir> [auto|puppet|mesh]
import fs from "node:fs";
import path from "node:path";
import { launchHeadless, instrument } from "./headless-gpu.mjs";

const [id, outDir, form = "auto"] = process.argv.slice(2);
const ORIGIN = process.env.PROBE_ORIGIN || "http://localhost:1430";
const MODEL_DIR = process.env.WHALE_DIR || "/Users/oneincase/Documents/blender/鲸鱼坤";
const W = Number(process.env.PROBE_W || 1280);
const H = Number(process.env.PROBE_H || 800);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const all = fs
  .readdirSync(MODEL_DIR)
  .filter((f) => /\.(obj|mtl|gltf|glb|bin|png|jpe?g|tga|bmp)$/i.test(f))
  .map((f) => path.join(MODEL_DIR, f));
const main = all.find((f) => /\.(gltf|glb)$/i.test(f)) ?? all.find((f) => /\.obj$/i.test(f));
if (!main) throw new Error(`目录里没有 .obj/.gltf/.glb：${MODEL_DIR}`);
const ordered = [main, ...all.filter((f) => f !== main)];
fs.mkdirSync(outDir, { recursive: true });
console.log("导入文件：", ordered.map((f) => path.basename(f)).join(", "));

const session = await launchHeadless({ task: `whale-import-${form}`, width: W, height: H });
instrument(session, { width: W, height: H });
try {
  // 舞台（#ed-stage）只占窗口一小块：把视口放大，截图才看得清
  if (process.env.PROBE_DEVW) {
    await session.pageCdp.send("Emulation.setDeviceMetricsOverride", {
      width: Number(process.env.PROBE_DEVW),
      height: Number(process.env.PROBE_DEVH || 1400),
      deviceScaleFactor: 1,
      mobile: false,
    });
  }
  await session.pageCdp.send("Page.navigate", { url: `${ORIGIN}/editor/?item=${id}` });
  await session.waitFor(
    `(document.querySelector('#tl-range') && Number(document.querySelector('#tl-range').max) > 0) ? 1 : 0`,
    { timeoutMs: 180000 },
  );
  await sleep(2000);
  await session.evaluate(
    `(() => { const b = document.querySelector('#tb-play'); const p = b && b.querySelector('.ic-pause'); if (p && !p.hasAttribute('hidden')) b.click(); return 1; })()`,
  );
  await sleep(500);
  console.log("编辑器就绪，形态选择 =", form);
  if (form !== "auto") {
    const clicked = await session.evaluate(
      `(() => { document.querySelector('#ly-add-model').click(); const b = document.querySelector('#model-menu button[data-preset="${form}"]'); if (b) b.click(); return b ? 1 : 0; })()`,
    );
    console.log("菜单点选", form, "=", clicked);
  }
  const dom = await session.pageCdp.send("DOM.getDocument", { depth: -1 });
  const q = await session.pageCdp.send("DOM.querySelector", { nodeId: dom.root.nodeId, selector: "#in-model" });
  const before = await session.evaluate(`document.querySelector('#ed-con-body')?.innerText || ''`);
  await session.pageCdp.send("DOM.setFileInputFiles", { nodeId: q.nodeId, files: ordered });

  // 等控制台出现导入结果（成功 / 失败）；只看导入前就有的旧行之外的新行
  let con = "";
  for (let i = 0; i < 120; i++) {
    con = await session.evaluate(`document.querySelector('#ed-con-body')?.innerText || ''`);
    if (/导入模型|gl\.fail|导入失败|导入器/.test(con.slice(before.length))) break;
    await sleep(1000);
  }
  console.log("---- 导入新增控制台 ----\n" + con.slice(before.length).trim());
  await sleep(3000);

  const info = await session.evaluate(
    `JSON.stringify((() => {
       const s = window.__scene;
       const objs = s ? (s.objects || []).map((o) => ({ id: o.id, name: o.name, visible: o.visible, model: o.model, image: typeof o.image === 'string' ? o.image : (o.image ? '[obj]' : undefined), origin: o.origin, scale: o.scale })) : null;
       return {
         hasScene: !!s,
         objects: objs ? objs.slice(-4) : null,
         objectCount: objs ? objs.length : 0,
         layerCount: s ? (s.layers || []).length : 0,
         tree: (document.querySelector('#ed-tree')?.innerText || '').split('\\n').slice(-8),
         stageRect: (() => { const r = document.querySelector('#ed-stage canvas')?.getBoundingClientRect(); return r ? [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] : null; })(),
         canvases: [...document.querySelectorAll('#ed-stage canvas')].map((c) => [c.width, c.height]),
       };
     })())`,
  );
  console.log("---- 场景 ----\n" + info);

  const j = JSON.parse(info);
  if (j.stageRect) {
    const shot = await session.pageCdp.send("Page.captureScreenshot", {
      format: "png",
      clip: { x: j.stageRect[0], y: j.stageRect[1], width: j.stageRect[2], height: j.stageRect[3], scale: 1 },
    });
    const out = path.join(outDir, `${id}-${form}-stage.png`);
    fs.writeFileSync(out, Buffer.from(shot.data, "base64"));
    console.log("写出", out);
  }
  const full = await session.pageCdp.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(outDir, `${id}-${form}-page.png`), Buffer.from(full.data, "base64"));
  const raw = await session.evaluate(
    `(() => { const c = document.querySelector('#ed-stage canvas'); try { return c.toDataURL('image/png'); } catch (e) { return 'ERR ' + e.message; } })()`,
  );
  if (typeof raw === "string" && raw.startsWith("data:")) {
    fs.writeFileSync(path.join(outDir, `${id}-${form}-canvas.png`), Buffer.from(raw.split(",")[1], "base64"));
  }
} finally {
  await session.close?.();
}
process.exit(0);
