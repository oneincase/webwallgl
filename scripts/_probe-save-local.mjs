// 临时探针：复现复核轮 headless 的「点 #st-save（存到本机文件夹）后页面卡死」。
// 手法：真 vite + 真 GPU Chrome + e2e 假目录选择器；点之前在页面里装心跳 / fetch 记录，
// 点之后用 3s 超时的 Runtime.evaluate 探活；一旦探活超时立刻 Debugger.pause 抓主线程栈。
// 用法：node scripts/_probe-save-local.mjs
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const log = (...m) => console.error("[probe]", ...m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 假目录镜像到这里，不碰真壁纸库
const lib = fs.mkdtempSync(path.join(os.tmpdir(), "probe-save-"));
process.env.WE_LIBRARY = lib;
log("WE_LIBRARY =", lib);

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
log("origin =", origin);

const { launchHeadless, instrument } = await import("./headless-gpu.mjs");
const session = await launchHeadless({ url: "about:blank", task: "probe-save-local", width: 1440, height: 900 });
instrument(session, { width: 1440, height: 900 });
const cdp = session.pageCdp;
const ev = (e, o) => session.evaluate(e, o);
const mouse = (type, x, y, buttons = 0, modifiers = 0) =>
  cdp.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" && !buttons ? "none" : "left", buttons, modifiers, clickCount: 1 });
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

// 主线程被卡住时抓栈：CDP 事件没有公开 API，直接挂到 ws 上
const paused = [];
cdp.ws.addEventListener("message", (e) => {
  let m;
  try {
    m = JSON.parse(e.data);
  } catch {
    return;
  }
  if (m.method === "Debugger.paused") paused.push(m.params);
});

let exitCode = 0;
try {
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: fs.readFileSync(path.join(ROOT, "scripts/e2e-dir-picker.js"), "utf8") });
  await cdp.send("Page.navigate", { url: `${origin}/editor/index.html` });
  await session.waitFor(`(document.querySelector('#ed-empty .ed-empty-hint')?.textContent || '').length > 8`, { timeoutMs: 90000 });
  log("编辑器已打开");

  // 新建一个浏览器存储里的工程（saveToLocal 的前提：localStorage 里有 vdir-last）
  const rc = await readyCount();
  await clickSel("#tb-new");
  await ev(`(() => { document.querySelector('#new-res').value = '1920x1080'; document.querySelector('#new-color').value = '#101010'; return true; })()`);
  await clickSel("#new-blank");
  await session.waitFor(`[...document.querySelectorAll('#ed-con-body > div')].filter((d) => ${READY}.test(d.textContent)).length > ${rc}`, { timeoutMs: 90000 });
  log("新建空白工程完成，vdir-last =", await ev(`localStorage.getItem('webwallgl-vdir-last')`));

  // 装心跳 + fetch 记录 + 错误记录
  await ev(`(() => {
    window.__probe = { hb: 0, fetches: [], logs: [] };
    setInterval(() => { window.__probe.hb++; }, 100);
    const of = window.fetch;
    window.fetch = async (...a) => {
      const url = String(a[0]);
      const rec = { url, t0: Math.round(performance.now()), done: false };
      window.__probe.fetches.push(rec);
      try {
        const r = await of(...a);
        rec.status = r.status; rec.done = true; rec.ms = Math.round(performance.now() - rec.t0);
        return r;
      } catch (e) {
        rec.err = String(e); rec.ms = Math.round(performance.now() - rec.t0);
        throw e;
      }
    };
    const oe = console.error;
    console.error = (...m) => { window.__probe.logs.push(m.map(String).join(' ').slice(0, 300)); oe(...m); };
    window.addEventListener('error', (e) => window.__probe.logs.push('window.error: ' + e.message));
    window.addEventListener('unhandledrejection', (e) => window.__probe.logs.push('unhandledrejection: ' + String(e.reason)));
    return true;
  })()`);
  await sleep(500);
  log("心跳基线 =", await ev(`window.__probe.hb`));

  await cdp.send("Debugger.enable");
  log("点 #st-save …");
  await clickSel("#st-save");

  const t0 = Date.now();
  let blocked = false;
  while (Date.now() - t0 < 40000) {
    try {
      const st = await ev(`({ hb: window.__probe.hb, vdir: localStorage.getItem('webwallgl-vdir-last'), n: window.__probe.fetches.length, last: window.__probe.fetches.slice(-3), logs: window.__probe.logs.slice(-6) })`, { timeoutMs: 3000 });
      log(`t+${Math.round((Date.now() - t0) / 1000)}s 存活 hb=${st.hb} vdir=${st.vdir} fetch=${st.n} ${JSON.stringify(st.last)} logs=${JSON.stringify(st.logs)}`);
    } catch (e) {
      log(`t+${Math.round((Date.now() - t0) / 1000)}s 主线程无响应：${e.message}`);
      blocked = true;
      break;
    }
    await sleep(1500);
  }

  if (blocked) {
    await cdp.send("Debugger.pause", {}, 5000).catch((e) => log("Debugger.pause 失败：", e.message));
    await sleep(1500);
    const p = paused.at(-1);
    if (p) {
      log(`暂停在 ${p.callFrames.length} 帧上，顶部 8 帧：`);
      for (const f of p.callFrames.slice(0, 8)) {
        log(`   ${f.functionName || "(匿名)"} @ ${f.url.replace(origin, "")}:${f.location.lineNumber + 1}:${f.location.columnNumber + 1}`);
      }
    } else {
      log("Debugger.pause 没收到 paused 事件");
    }
  }

  const dirs = fs.existsSync(lib) ? fs.readdirSync(lib) : [];
  for (const d of dirs) log(`盘上 ${d}: ${fs.readdirSync(path.join(lib, d)).sort().join(",") || "(空)"}`);
  if (!dirs.length) log("盘上：空");
  log(blocked ? "结论：主线程卡死（复现）" : "结论：未卡死");
} catch (e) {
  log("探针自身出错：", e.stack || e.message);
  exitCode = 1;
} finally {
  await session.close().catch(() => {});
  await server.close().catch(() => {});
}
process.exit(exitCode);
