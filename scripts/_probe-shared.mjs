// 临时探针：打开壁纸，按时间点读取 window 表达式（如 __shared.x），并打印 /diag 脚本报错的时间点。
// 用法：node scripts/_probe-shared.mjs <id> "<js expr>"
import { launchHeadless, instrument } from "./headless-gpu.mjs";

const [id, expr] = process.argv.slice(2);
const BASE = "http://localhost:1430/renderer/index.html?type=scene&fit=cover&renderDpr=0&sceneFps=30&aa=off&pq=high&pp=high&filter=none&muted=true&loop=true&mediaBase=http%3A%2F%2Flocalhost%3A1430%2Fmedia%2Fdev&liveSystem=1&src=";
const session = await launchHeadless({ width: 1280, height: 720 });
instrument(session);
const page = await session.newPage("about:blank");
const t0 = Date.now();
await page.cdp.send("Network.enable").catch(() => {});
page.cdp.ws.addEventListener("message", (ev) => {
  let m;
  try { m = JSON.parse(ev.data); } catch { return; }
  if (m.method === "Network.requestWillBeSent" && m.params.request.url.includes("/diag?")) {
    const q = new URL(m.params.request.url).searchParams;
    if (/script/i.test(q.get("msg") || "")) console.log(`[${Date.now() - t0}ms diag]`, q.get("msg"));
  }
});
await page.cdp.send("Page.navigate", { url: BASE + id });
for (let i = 0; i < 8; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const r = await page.cdp.send("Runtime.evaluate", { expression: `(()=>{try{return JSON.stringify(${expr})}catch(e){return 'ERR '+e.message}})()`, returnByValue: true });
  console.log(`[${Date.now() - t0}ms]`, r.result?.value);
}
await session.close?.();
process.exit(0);
