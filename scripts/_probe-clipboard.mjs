// 临时探针：复现 AL 段「⌘C + ⌘V 后落点没有粘贴偏移（220,200 → 220,200）」。
// 用 ?item=beach 直接打开库条目拿到三行树，选第一行，真键盘 ⌘C / ⌘V，打印树行数、
// 选中行、检视器数值输入框（带 data-prop）前后值。
// 用法：node scripts/_probe-clipboard.mjs
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
const session = await launchHeadless({ url: "about:blank", task: "probe-clipboard", width: 1440, height: 900 });
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
const KEYS = { c: [67, "KeyC"], v: [86, "KeyV"], x: [88, "KeyX"] };
const key = async (k, modifiers = 0) => {
  const [vk, code] = KEYS[k];
  await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: k, code, windowsVirtualKeyCode: vk, modifiers });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers });
  await new Promise((r) => setTimeout(r, 400));
};
const treeIds = () => ev(`[...document.querySelectorAll('#ed-tree .ed-node')].map((n) => n.dataset.id)`);
const selected = () => ev(`[...document.querySelectorAll('#ed-tree .ed-node.selected')].map((n) => n.dataset.id)`);
const nums = () =>
  ev(`JSON.stringify([...document.querySelectorAll('#ed-inspector fieldset.ed-form input[type=number]')].slice(0, 6).map((i) => [i.closest('.ed-prop')?.dataset.prop ?? i.closest('label')?.textContent?.trim() ?? '?', i.value]))`);
const snap = async (tag) => {
  log(tag, "ids=", JSON.stringify(await treeIds()), "sel=", JSON.stringify(await selected()), "nums=", await nums());
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
// 记录页面收到的 keydown，确认 CDP 键盘真的到页面
await ev(`(() => { window.__probeKeys = []; window.addEventListener('keydown', (e) => { window.__probeKeys.push({ key: e.key, meta: e.metaKey, target: e.target?.tagName + '#' + (e.target?.id || '-'), type: e.target?.type || '' }); }, true); })()`);
// 左栏切到「图层」页
const tc = await ev(`(() => { const t = document.querySelector('#ed-layers .wb-tab[data-tab="layers"]'); const r = t.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
await click(tc[0], tc[1]);
await new Promise((r) => setTimeout(r, 300));
// 选第一行（真实鼠标）
const rc = await ev(`(() => { const n = document.querySelector('#ed-tree .ed-node'); const r = n.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
await click(rc[0], rc[1]);
await snap("before copy");
await key("c", 4);
await snap("after C");
await key("v", 4);
await snap("after V");
// 检视器到底显示谁：打印数值框的可识别属性 + 检视器标题
log(
  "input descriptors:",
  await ev(`JSON.stringify([...document.querySelectorAll('#ed-inspector input[type=number]')].slice(0, 8).map((i) => ({ value: i.value, name: i.name, id: i.id, cls: i.className, prop: i.dataset.prop || null, wrap: i.parentElement?.className || null, wrapProp: i.closest('[data-prop]')?.dataset.prop || null })))`),
);
log(
  "inspector fieldsets:",
  await ev(`JSON.stringify([...document.querySelectorAll('#ed-inspector fieldset.ed-form')].map((f) => f.querySelector('legend')?.textContent?.trim() || f.dataset.form || '?'))`),
);
// 点回第 2 行再点新行 4：强制检视器重新渲染，区分「偏移没写进去」和「DOM 陈旧」
const rowOf = (id) => ev(`(() => { const n = document.querySelector('#ed-tree .ed-node[data-id="${id}"]'); if (!n) return null; const r = n.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
const r2 = await rowOf("2");
if (r2) { await click(r2[0], r2[1]); await snap("after click row 2"); }
const r4 = await rowOf("4");
if (r4) { await click(r4[0], r4[1]); await snap("after re-click row 4"); }
else log("row 4 not found (ids)", JSON.stringify(await treeIds()));
log("keys seen:", await ev(`JSON.stringify(window.__probeKeys)`));
log("activeElement:", await ev(`document.activeElement ? document.activeElement.tagName + '#' + (document.activeElement.id || '-') + '.' + (document.activeElement.type || '') : null`));
await session.close();
await server.close();
