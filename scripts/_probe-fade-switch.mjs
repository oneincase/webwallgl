const ROOT = "/Users/oneincase/Documents/workspace/webwallgl-github";
import net from "node:net";
import path from "node:path";
const { createServer } = await import("vite");
const port = await new Promise((res) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
});
const server = await createServer({
  root: ROOT,
  configFile: path.join(ROOT, "vite.config.ts"),
  server: { port, host: "127.0.0.1", strictPort: true, open: false },
  logLevel: "error",
});
await server.listen();
const { instrument, launchHeadless } = await import(`${ROOT}/scripts/headless-gpu.mjs`);
const session = await launchHeadless({ width: 1440, height: 900, task: "fade-switch" });
instrument(session, { width: 1440, height: 900 });
const page = await session.newPage(`http://127.0.0.1:${port}/editor/`);
await new Promise((r) => setTimeout(r, 6000));
const probe = await page.cdp.send("Runtime.evaluate", { returnByValue: true, expression: `(() => {
  const el = document.getElementById('fadein');
  const panelVisible = !!el && getComputedStyle(el).display !== 'none';
  return JSON.stringify({
    exists: !!el,
    type: el && el.type,
    checked: el && el.checked,
    label: el?.closest('label')?.querySelector('.wb-field-label')?.textContent,
    title: el?.closest('label')?.title.slice(0, 30),
    ready: document.readyState,
  });
})()` });
console.log("probe:", probe.result.value);
// 勾选 → change → 重载 → 状态应保留（localStorage 回路）；mountCurrent(null 文档) 早退不炸
const toggle = await page.cdp.send("Runtime.evaluate", { returnByValue: true, expression: `(() => {
  const el = document.getElementById('fadein');
  el.checked = true;
  el.dispatchEvent(new Event('change'));
  return String(el.checked);
})()` });
console.log("toggled:", toggle.result.value);
await new Promise((r) => setTimeout(r, 2500));
await page.cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/editor/` });
await new Promise((r) => setTimeout(r, 6000));
const after = await page.cdp.send("Runtime.evaluate", { returnByValue: true, expression: `(() => {
  const el = document.getElementById('fadein');
  return JSON.stringify({ checked: el && el.checked, label: el?.closest('label')?.querySelector('.wb-field-label')?.textContent });
})()` });
console.log("after-reload:", after.result.value);
const errs = await page.cdp.send("Runtime.evaluate", { returnByValue: true, expression: "window.__edErrors || 'n/a'" });
console.log("errors:", errs.result.value);
await session.close();
await server.close();
process.exit(0);
