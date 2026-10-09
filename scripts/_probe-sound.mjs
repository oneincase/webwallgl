// 临时探针：复现 AA 段「声音层：点「试听」不进播放态 / 替换音频后落盘不准」。
// 走真实鼠标 + 真实文件选择器（CDP DOM.setFileInputFiles），把检视器里声音分组的
// 命中测试、控件状态、文档原始 JSON 全部打出来。
// 用法：node scripts/_probe-sound.mjs
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const log = (...m) => console.error("[probe]", ...m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const wavBytes = (sec, freq, rate = 8000) => {
  const n = Math.round(sec * rate);
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVE", 8); b.write("fmt ", 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 8000), 44 + i * 2);
  return b;
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "probe-sound-"));
const rainWav = path.join(tmp, "rain.wav");
const birdWav = path.join(tmp, "bird.wav");
fs.writeFileSync(rainWav, wavBytes(1.5, 330));
fs.writeFileSync(birdWav, wavBytes(0.8, 880));

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
const session = await launchHeadless({ url: "about:blank", task: "probe-sound", width: 1440, height: 900 });
instrument(session, { width: 1440, height: 900 });
const cdp = session.pageCdp;
const ev = (e) => session.evaluate(e);
const mouse = (type, x, y, buttons = 0, modifiers = 0) =>
  cdp.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" && !buttons ? "none" : "left", buttons, modifiers, clickCount: 1 });
const click = async (x, y) => {
  await mouse("mouseMoved", x, y);
  await mouse("mousePressed", x, y, 1);
  await mouse("mouseReleased", x, y, 0);
  await sleep(150);
};
const clickSel = async (sel) => {
  const tab = await ev(`(() => { const p = document.querySelector(${JSON.stringify(sel)})?.closest('.ed-insp-panel[hidden]'); if (!p) return null; const r = document.querySelector('.ed-insp-tab[data-tab="' + p.dataset.tab + '"]').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  if (tab) await click(tab[0], tab[1]);
  await ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); return true; })()`);
  await sleep(120);
  const r = await ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  if (!r) { log("clickSel MISSING", sel); return; }
  await click(r[0], r[1]);
  return r;
};
await cdp.send("Page.setInterceptFileChooserDialog", { enabled: true });
const setFiles = async (sel, files) => {
  const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: sel });
  if (!nodeId) { log("setFiles MISSING", sel); return; }
  await cdp.send("DOM.setFileInputFiles", { nodeId, files });
};
const rawDoc = () => ev(`document.querySelector('.ed-insp-raw')?.textContent ?? null`);
const treeNames = () => ev(`[...document.querySelectorAll('#ed-tree .ed-node')].map((n) => n.querySelector('.ed-node-name')?.textContent ?? n.dataset.id)`);
const waitRows = async (n, ms = 90000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const k = (await ev(`document.querySelectorAll('#ed-tree .ed-node').length`)) || 0;
    if (k === n) return true;
    await sleep(400);
  }
  return false;
};
/** 控件现场：rect / 可见性 / 祖先 pointer-events / 中心点命中栈 */
const probe = (sel) =>
  ev(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return { missing: true };
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const chain = [];
    for (let p = el.parentElement; p; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (s.overflow !== 'visible' || s.pointerEvents !== 'auto' || s.display === 'none' || p.hidden)
        chain.push([p.tagName + (p.id ? '#' + p.id : '') + (p.className ? '.' + String(p.className).split(' ')[0] : ''), s.overflow, s.pointerEvents, s.display, p.hidden]);
    }
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    return {
      rect: [r.left, r.top, r.width, r.height].map(Math.round),
      display: cs.display, visibility: cs.visibility, pointerEvents: cs.pointerEvents, disabled: el.disabled ?? null,
      playing: el.dataset?.playing ?? null,
      inHiddenPanel: !!el.closest('.ed-insp-panel[hidden]'),
      activeTab: document.querySelector('.ed-insp-tab.active')?.dataset.tab ?? null,
      hit: hit ? hit.tagName + (hit.id ? '#' + hit.id : '') + (hit.className ? '.' + String(hit.className).split(' ')[0] : '') : null,
      hitIsSelf: !!hit && (hit === el || el.contains(hit)),
      chain,
    };
  })()`);

await cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/editor/` });
for (let i = 0; i < 120; i++) {
  if (await ev(`!!document.querySelector('#tb-new')`)) break;
  await sleep(500);
}
await ev(`new Promise((ok) => { const r = indexedDB.deleteDatabase('webwallgl-editor'); r.onsuccess = r.onerror = r.onblocked = () => ok(true); })`);
await cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/editor/` });
for (let i = 0; i < 120; i++) {
  if ((await ev(`(document.querySelector('#ed-empty .ed-empty-hint')?.textContent || '').length > 8`))) break;
  await sleep(500);
}
log("editor ready");

// ---- 新建空白场景 + 加声音层 + 导入 rain.wav ----
await clickSel("#tb-new");
await ev(`(() => { document.querySelector('#new-res').value = '1920x1080'; document.querySelector('#new-color').value = '#000000'; return true; })()`);
await clickSel("#new-blank");
await sleep(2500);
log("blank ready, rows=", JSON.stringify(await treeNames()));

await clickSel("#ly-add-sound");
await sleep(600);
await setFiles("#in-sound", [rainWav]);
await waitRows(1);
await sleep(1500);
log("after import rows=", JSON.stringify(await treeNames()));
log("preview ctrl", JSON.stringify(await probe('.ed-sound [data-sound="preview"]')));
log("replace ctrl", JSON.stringify(await probe('.ed-sound [data-sound="replace"]')));

// ---- 真鼠标点「试听」，逐秒看 dataset.playing ----
const clicked = await clickSel('.ed-sound [data-sound="preview"]');
log("clicked preview at", JSON.stringify(clicked));
for (let i = 0; i < 10; i++) {
  const st = await ev(`document.querySelector('.ed-sound [data-sound="preview"]')?.dataset.playing ?? null`);
  log(`  t+${(i + 1) * 0.5}s playing=`, st);
  if (st === "1") break;
  await sleep(500);
}
log("after preview click raw=", String(await rawDoc()).slice(0, 200));
await clickSel('.ed-sound [data-sound="preview"]');
await sleep(400);
log("after 2nd click playing=", await ev(`document.querySelector('.ed-sound [data-sound="preview"]')?.dataset.playing ?? null`));

// ---- 设音量/模式/开始静音（走 change 事件，和用例一致）----
const fxAct = (js) => ev(`(() => { ${js} })()`);
await fxAct(`const el = document.querySelector('.ed-sound [data-sound="volume"]'); el.value = '0.5'; el.dispatchEvent(new Event('change', { bubbles: true }));`);
await fxAct(`const el = document.querySelector('.ed-sound [data-sound="playbackmode"]'); el.value = 'single'; el.dispatchEvent(new Event('change', { bubbles: true }));`);
await fxAct(`const el = document.querySelector('.ed-sound [data-sound="startsilent"]'); el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true }));`);
await sleep(1200);
log("doc after sets=", String(await rawDoc()).slice(0, 300));
await fxAct(`const el = document.querySelector('.ed-sound [data-sound="playbackmode"]'); el.value = 'loop'; el.dispatchEvent(new Event('change', { bubbles: true }));`);
await sleep(1200);
log("doc before replace=", String(await rawDoc()).slice(0, 300));

// ---- 真鼠标点「替换」，再喂 bird.wav ----
log("replace ctrl (before click)", JSON.stringify(await probe('.ed-sound [data-sound="replace"]')));
await clickSel('.ed-sound [data-sound="replace"]');
await sleep(500);
await setFiles("#in-sound", [birdWav]);
await sleep(2500);
log("rows after replace=", JSON.stringify(await treeNames()));
log("doc after replace=", String(await rawDoc()).slice(0, 400));

await session.close?.();
await server.close();
process.exit(0);
