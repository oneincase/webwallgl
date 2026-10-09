// 临时探针：复现 AL 段「真实鼠标点 #tree-isolate 什么都没发生」。
// 用 ?item=beach 直接打开库条目，拿到带图层的树，再逐步定位。
// 用法：node scripts/_probe-tree-tools-hit.mjs
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const log = (...m) => console.error("[probe]", ...m);
const port = await new Promise((res) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => {
    const p = s.address().port;
    s.close(() => res(p));
  });
});
const { createServer } = await import("vite");
const server = await createServer({
  root: ROOT,
  configFile: path.join(ROOT, "vite.config.ts"),
  server: { port, host: "127.0.0.1", strictPort: true, open: false },
  logLevel: "error",
});
await server.listen();
const { launchHeadless, instrument } = await import("./headless-gpu.mjs");
const session = await launchHeadless({ url: "about:blank", task: "probe-tree-tools", width: 1440, height: 900 });
instrument(session, { width: 1440, height: 900 });
const cdp = session.pageCdp;
const ev = (e) => session.evaluate(e);
const mouse = (type, x, y, buttons = 0) =>
  cdp.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" && !buttons ? "none" : "left", buttons, clickCount: 1 });
const click = async (x, y) => {
  await mouse("mouseMoved", x, y);
  await mouse("mousePressed", x, y, 1);
  await mouse("mouseReleased", x, y, 0);
  await new Promise((r) => setTimeout(r, 120));
};
const ITEM = process.env.PROBE_ITEM || "beach";
await cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/editor/?item=${ITEM}` });
let rows = 0;
for (let i = 0; i < 120; i++) {
  rows = (await ev(`document.querySelectorAll('#ed-tree .ed-node').length`)) || 0;
  if (rows > 0) break;
  await new Promise((r) => setTimeout(r, 500));
}
log("tree rows:", rows);
const diag = async (tag) => {
  const out = await ev(`JSON.stringify((() => {
    const stack = (x, y) => (document.elementsFromPoint(x, y) || []).slice(0, 6).map((e) => e.tagName + '#' + (e.id || '-') + '.' + (typeof e.className === 'string' ? e.className : '-'));
    const b = document.querySelector('#tree-isolate');
    const r = b.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const banners = ['#ed-draft', '#ed-draft-recover', '#ed-toast', '#ed-banner'].map((s) => { const e = document.querySelector(s); return e ? [s, e.hidden, JSON.stringify([e.getBoundingClientRect().left | 0, e.getBoundingClientRect().top | 0, e.getBoundingClientRect().width | 0, e.getBoundingClientRect().height | 0])] : [s, null]; });
    const top = document.elementFromPoint(cx, cy);
    return { iso: { rect: [r.left | 0, r.top | 0, r.width | 0, r.height | 0], disabled: b.disabled, pe: getComputedStyle(b).pointerEvents, hit: top ? (top === b || b.contains(top)) : false, topTag: top ? top.tagName + '#' + (top.id || '-') : null },
      stack: stack(cx, cy), stackHead: stack(r.left + 4, r.top + r.height / 2), banners,
      sel: [...document.querySelectorAll('#ed-tree .ed-node.selected')].map((n) => n.dataset.id), ids: [...document.querySelectorAll('#ed-tree .ed-node')].map((n) => n.dataset.id), on: b.classList.contains('is-on') };
  })())`);
  log(tag, out);
  return JSON.parse(out);
};
const boxes = await ev(`JSON.stringify((() => {
  const box = (sel) => { const e = document.querySelector(sel); if (!e) return [sel, null]; const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return [sel, [r.left | 0, r.top | 0, r.width | 0, r.height | 0], { overflow: cs.overflow, overflowX: cs.overflowX, width: cs.width, minWidth: cs.minWidth, flex: cs.flex, position: cs.position, zIndex: cs.zIndex }]; };
  return [box('#ed-left'), box('#ed-layers'), box('#ed-center'), box('#ed-layers > .wb-panel-head'), box('#ed-center > .wb-panel-head'), box('#ed-left .wb-tab[data-tab="layers"]'), box('.ed-tree-tools')];
})())`);
log("boxes", boxes);
const d0 = await diag("fresh");
// 左栏切到「图层」标签页（?item= 打开时停在壁纸库页，图层工具条是 hidden）
const tc = await ev(`(() => { const t = document.querySelector('#ed-layers .wb-tab[data-tab="layers"]'); const r = t.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
await click(tc[0], tc[1]);
await new Promise((r) => setTimeout(r, 300));
log("toolsHidden now:", await ev(`document.querySelector('.ed-tree-tools').hidden`));
await diag("after layers tab");
// 选中第一行（真实鼠标）
const rc = await ev(`(() => { const n = document.querySelector('#ed-tree .ed-node'); const r = n.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
await click(rc[0], rc[1]);
const d1 = await diag("after row click");
// 真实鼠标点隔离按钮
const c = await ev(`(() => { const r = document.querySelector('#tree-isolate').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
log("clicking isolate at", c.join(","));
await click(c[0], c[1]);
const d2 = await diag("after real click");
if (!d2.on) {
  await ev(`document.querySelector('#tree-isolate').click()`);
  await new Promise((r) => setTimeout(r, 200));
  await diag("after synthetic click");
}
await session.close();
await server.close();
