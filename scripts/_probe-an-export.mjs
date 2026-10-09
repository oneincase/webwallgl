// 临时探针：独立复现/验证 M10 D1 回归 ——「宿主重绘导出菜单时不许清扫 #ed-plugin-export 里的插件贡献」。
// 为什么要独立探针：整套 headless 走到 AN 段要 ~2000 项，本机常在早段 save-to-local 处崩掉，
// AN 段因此长期拿不到真机证据。这里只做这一件事：挂一个插件条目 → 切语言触发重绘 → 看它还在不在。
// 预期：HEAD a89eb4a 上条目被清扫（✗）；复核轮分支上条目存活（✓）。
// 用法：node scripts/_probe-an-export.mjs
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const log = (...m) => console.error("[probe-an]", ...m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
const origin = `http://127.0.0.1:${port}`;
log("root =", ROOT);
log("origin =", origin);

const { launchHeadless, instrument } = await import("./headless-gpu.mjs");
const session = await launchHeadless({ url: "about:blank", task: "probe-an-export", width: 1440, height: 900 });
instrument(session, { width: 1440, height: 900 });
const cdp = session.pageCdp;
const ev = (e, o) => session.evaluate(e, o);
const mouse = (type, x, y, buttons = 0) =>
  cdp.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" && !buttons ? "none" : "left", buttons, clickCount: 1 });
const click = async (x, y) => {
  await mouse("mouseMoved", x, y);
  await mouse("mousePressed", x, y, 1);
  await mouse("mouseReleased", x, y, 0);
  await sleep(150);
};
const clickSel = async (sel) => {
  await ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); return true; })()`);
  await sleep(80);
  const r = await ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  await click(r[0], r[1]);
};
const READY = "/首帧就绪|First frame ready/";
const readyCount = () => ev(`[...document.querySelectorAll('#ed-con-body > div')].filter((d) => ${READY}.test(d.textContent)).length`);
const hasItem = (id) => ev(`!!document.querySelector('#ed-plugin-export #${id}')`);

const results = [];
const check = (ok, label) => {
  results.push([!!ok, label]);
  log(`${ok ? "✓" : "✗"} ${label}`);
};

let exitCode = 0;
try {
  await cdp.send("Page.navigate", { url: `${origin}/editor/index.html` });
  await session.waitFor(`(document.querySelector('#ed-empty .ed-empty-hint')?.textContent || '').length > 8`, { timeoutMs: 90000 });
  log("编辑器已打开");

  const rc = await readyCount();
  await clickSel("#tb-new");
  await ev(`(() => { document.querySelector('#new-res').value = '1920x1080'; document.querySelector('#new-color').value = '#101010'; return true; })()`);
  await clickSel("#new-blank");
  await session.waitFor(`[...document.querySelectorAll('#ed-con-body > div')].filter((d) => ${READY}.test(d.textContent)).length > ${rc}`, { timeoutMs: 90000 });
  log("新建空白工程完成");

  // 与 headless 的 AN 段同一手法：往插件槽位塞一个条目（模拟插件贡献）
  const inject = () =>
    ev(`(() => {
      const host = document.querySelector('#ed-plugin-export');
      if (!host) return 'no-slot';
      let b = host.querySelector('#an-plugin-item');
      if (!b) { b = document.createElement('button'); b.type = 'button'; b.id = 'an-plugin-item'; host.appendChild(b); }
      host.hidden = false;
      return 'an-plugin-item';
    })()`);
  check((await inject()) === "an-plugin-item", "插件导出槽位存在（#ed-plugin-export 可挂条目）");
  const slotHtml = await ev(`(document.querySelector('#ed-plugin-export')?.outerHTML || '').slice(0, 160)`);
  log("槽位此刻 =", slotHtml);

  const setLang = async (v) => {
    await ev(`(() => { const s = document.querySelector('#lang'); s.value = ${JSON.stringify(v)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await sleep(500);
  };

  const menuIds = () => ev(`[...document.querySelectorAll('#export-menu button')].map((b) => b.id || '(无 id)')`);
  log("初始菜单项 =", JSON.stringify(await menuIds()), "| 插件槽位 hidden =", await ev(`document.querySelector('#ed-plugin-export')?.hidden`));

  await setLang("en");
  const after1 = await hasItem("an-plugin-item");
  const menu1 = await ev(`(document.querySelector('#export-menu')?.outerHTML || '(无菜单)').replace(/\\s+/g, ' ').slice(0, 300)`);
  log("切 en 后导出菜单 =", menu1);
  log("切 en 后菜单项 =", JSON.stringify(await menuIds()));
  check(after1, "★ 切语言重绘导出菜单后插件贡献仍在");

  await setLang("zh");
  check(await hasItem("an-plugin-item"), "★ 连续两次重绘都不动插件项");

  // 反向：宿主自己的导出项删掉后重绘要补回来（收窄清扫范围没把自愈弄丢）
  const del = await ev(`(() => { const b = document.querySelector('#export-zip'); if (!b) return false; b.remove(); return true; })()`);
  await setLang("en");
  const healed = await ev(`!!document.querySelector('#export-zip')`);
  check(del === true && healed, `宿主自己的导出项删掉后重绘会补回来（删到=${del}，补回=${healed}）`);

  const pass = results.filter(([ok]) => ok).length;
  log(`结论：${pass}/${results.length} 通过${pass === results.length ? "（插件贡献未被清扫）" : "（插件贡献被宿主重绘清扫 = D1 回归存在）"}`);
  exitCode = pass === results.length ? 0 : 1;
} catch (e) {
  log("探针自身出错：", e.stack || e.message);
  exitCode = 2;
} finally {
  await session.close().catch(() => {});
  await server.close().catch(() => {});
}
process.exit(exitCode);
