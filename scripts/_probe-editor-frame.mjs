// 临时探针：打开真编辑器页面 /editor/?item=<id>，用真时间轴（#tl-range，单位秒）seek 后
// 截 #ed-stage 里的预览 canvas。用来验证「用户在编辑器里看到的现象」。
// 用法：node scripts/_probe-editor-frame.mjs <id> <t秒,逗号分隔> <outDir> [w] [h]
import fs from "node:fs";
import path from "node:path";
import { launchHeadless, instrument } from "./headless-gpu.mjs";

const [id, timesArg, outDir, w = "1280", h = "720"] = process.argv.slice(2);
const times = timesArg.split(",").map(Number);
const ORIGIN = process.env.PROBE_ORIGIN || "http://localhost:1430";

fs.mkdirSync(outDir, { recursive: true });
const session = await launchHeadless({ task: `editor-${id}`, width: Number(w), height: Number(h) });
instrument(session, { width: Number(w), height: Number(h) });
await session.pageCdp.send("Page.navigate", { url: `${ORIGIN}/editor/?item=${id}` });

let ready = false;
for (let i = 0; i < 60; i++) {
  const st = await session.evaluate(
    `JSON.stringify({
       rs: document.readyState,
       range: !!document.querySelector('#tl-range'),
       max: Number(document.querySelector('#tl-range')?.max || 0),
       canvases: [...document.querySelectorAll('#ed-stage canvas')].map((c) => [c.width, c.height]),
     })`,
  );
  if (i % 5 === 0) console.log("state", st);
  const j = JSON.parse(st);
  if (j.range && j.max > 0 && j.canvases.some(([cw]) => cw > 0)) {
    ready = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 1000));
}
if (!ready) {
  console.log("编辑器没就绪（时间轴 max 仍为 0 或没有 canvas）");
  await session.close?.();
  process.exit(2);
}
console.log("editor ready");
const wasPlaying = await session.evaluate(
  `(() => {
     const b = document.querySelector('#tb-play');
     const p = b.querySelector('.ic-pause');
     const playing = !!(p && !p.hasAttribute('hidden'));
     if (playing) b.click();
     return JSON.stringify({ playing, title: b.title });
   })()`,
);
console.log("pauseClicked", wasPlaying);
await new Promise((r) => setTimeout(r, 800));

for (const t of times) {
  const info = await session.evaluate(
    `(async () => {
       const el = document.querySelector('#tl-range');
       el.value = String(${t});
       el.dispatchEvent(new Event('input', { bubbles: true }));
       await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
       const mid = Number(el.value);
       const cv = document.querySelector('#ed-stage canvas');
       const r = cv.getBoundingClientRect();
       return JSON.stringify({
         at: Number(el.value),
         mid,
         rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
         data: cv.toDataURL('image/png'),
       });
     })()`,
    { awaitPromise: true, timeoutMs: 120000 },
  );
  const { at, mid, rect, data } = JSON.parse(info);
  const out = path.join(outDir, `t${String(t).replace(".", "_")}.png`);
  fs.writeFileSync(out, Buffer.from(data.split(",")[1], "base64"));
  const shot = await session.pageCdp.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(outDir, `page${String(t).replace(".", "_")}.png`), Buffer.from(shot.data, "base64"));
  console.log("wrote", out, "timeline=", at, "mid=", mid, "canvasRect=", JSON.stringify(rect));
}
await session.close?.();
process.exit(0);
