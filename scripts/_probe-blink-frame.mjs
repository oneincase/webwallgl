// 临时探针：用编辑器 API 挂载系统壁纸，暂停并 seek 到指定时间点，导出整幅 canvas 截图。
// 用法：node scripts/_probe-blink-frame.mjs <id> <t秒,逗号分隔> <outDir> [w] [h]
import fs from "node:fs";
import path from "node:path";
import { launchHeadless, instrument } from "./headless-gpu.mjs";

const [id, timesArg, outDir, w = "1280", h = "720"] = process.argv.slice(2);
const times = timesArg.split(",").map(Number);
const ORIGIN = process.env.PROBE_ORIGIN || "http://localhost:1430";
const src = `${ORIGIN}/media/dev/${id}`;

fs.mkdirSync(outDir, { recursive: true });
const session = await launchHeadless({ task: `blink-${id}`, width: Number(w), height: Number(h) });
instrument(session, { width: Number(w), height: Number(h) });
await session.pageCdp.send("Page.navigate", {
  url: `${ORIGIN}/renderer/index.html?type=scene&src=${id}&fit=cover&renderDpr=0&sceneFps=30&aa=off&pq=high&pp=high&filter=none&muted=true&loop=true&mediaBase=${encodeURIComponent(`${ORIGIN}/media/dev`)}&liveSystem=1`,
});
for (let i = 0; i < 20; i++) {
  const st = await session.evaluate(
    `JSON.stringify({rs:document.readyState,wp:!!window.__wp,scene:!!window.__scene,url:location.href.slice(0,120)})`,
  );
  if (i % 5 === 0 || JSON.parse(st).wp) console.log("state", st);
  if (JSON.parse(st).wp) break;
  await new Promise((r) => setTimeout(r, 1000));
}
const meta = await session.evaluate(
  `(async () => {
     window.__wp.pause();
     const api = await import('/renderer/src/api/editor.ts');
     const host = document.createElement('div');
     host.id = 'blink-probe-host';
     host.style.cssText = 'position:fixed;left:0;top:0;width:${Number(w)}px;height:${Number(h)}px;z-index:9999;background:#000';
     document.body.appendChild(host);
     const inst = await api.mount(host, { source: api.httpSource('${src}'), fit: 'cover', renderDpr: 1, volume: 0, autoplay: false });
     const ed = api.editorOf(inst);
     window.__probe = { api, inst, ed };
     const layers = ed.getLayers();
     return { layers: layers.map((l) => [l.id, l.name, l.kind]), dur: ed.getDuration ? ed.getDuration() : null };
   })()`,
  { awaitPromise: true, timeoutMs: 180000 },
);
console.log("layers", JSON.stringify(meta.layers));
console.log("dur", meta.dur);
for (const t of times) {
  const url = await session.evaluate(
    `(async () => {
       const { ed, inst } = window.__probe;
       await ed.seek(${t});
       await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
       const cv = document.querySelector('#blink-probe-host canvas');
       return cv.toDataURL('image/png');
     })()`,
    { awaitPromise: true, timeoutMs: 120000 },
  );
  const out = path.join(outDir, `t${String(t).replace(".", "_")}.png`);
  fs.writeFileSync(out, Buffer.from(url.split(",")[1], "base64"));
  console.log("wrote", out);
}
await session.close?.();
process.exit(0);
