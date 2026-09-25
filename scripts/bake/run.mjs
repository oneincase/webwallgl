// 烘焙 A/B 的本地服务 + 无头驱动：/bake（烘焙产物）、/media（原始 .tex）、/vendor（引擎模块）、/ 页面
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { launchHeadless, instrument } from "../headless-gpu.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const LIB = process.env.WE_LIBRARY || path.join(os.homedir(), "Library/Application Support/io.github.oneincase.wallpaperem/wallpapers");
const BAKE = process.env.BAKE_OUT || "/tmp/bake-out";
const items = process.argv.slice(2);
const res = process.env.RES || "0.6";

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json", ".png": "image/png", ".tex": "application/octet-stream" };
const srv = http.createServer((req, res2) => {
  const u = new URL(req.url, "http://x");
  const p = decodeURIComponent(u.pathname);
  let f;
  if (p.startsWith("/bake/list/")) f = path.join(BAKE, p.slice("/bake/list/".length).replace(/\.json$/, ""), "list.json");
  else if (p.startsWith("/bake/")) f = path.join(BAKE, p.slice("/bake/".length));
  else if (p.startsWith("/media/dev/")) {
    const m = /^\/media\/dev\/([^/]+)\/(.+)$/.exec(p);
    f = path.join(LIB, m[1], m[2]);
  } else if (p.startsWith("/vendor/")) f = path.join(ROOT, "renderer", p); // /vendor/we-scene/... → renderer/vendor/we-scene/...
  else if (p === "/") f = process.env.PAGE || join(HERE, "bake-ab.html");
  else f = path.join(ROOT, p);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    res2.statusCode = 404;
    return res2.end("404 " + p);
  }
  res2.setHeader("Content-Type", MIME[path.extname(f).toLowerCase()] || "application/octet-stream");
  res2.setHeader("Cache-Control", "no-store");
  fs.createReadStream(f).pipe(res2);
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${srv.address().port}`;

const s = await launchHeadless({ url: "about:blank", task: "bakeab", width: 1280, height: 720 });
instrument(s);
const page = await s.newPage("about:blank");
page.cdp.send("Runtime.enable");
await page.cdp.send("Page.navigate", { url: `${origin}/?items=${items.join(",")}&res=${res}${process.env.Q || ""}` });
// 等到页面把结果写到 window（大场景要跑一会儿）
const deadline = Date.now() + 300000;
let result = null;
while (Date.now() < deadline) {
  result = await page.evaluate("window.__bakeResult || window.__drawResult || null").catch(() => null);
  if (result) break;
  await new Promise((r) => setTimeout(r, 500));
}
const dbg = await page.evaluate("document.getElementById(\"out\").textContent").catch(() => "");
console.log("页面全文：\n" + dbg.slice(0, 1500));
if (process.env.DRAW) {
  const r = result;
  console.log(`quad边长/屏 ${r.fs ?? 1}  N=${r.n} 次/帧 → ${r.fpsN.toFixed(1)} fps；1 次/帧 → ${r.fps1.toFixed(1)} fps；每绘制 ≈ ${r.perDrawUs.toFixed(2)}µs`);
} else if (result) {
  console.log("perItem:", JSON.stringify(result.perItem));
  for (const r of result.perItem) {
    console.log(`${r.id}: ${r.count} 张  现状 ${r.aMs}ms  烘焙 ${r.bMs}ms  ${r.aMs > 0 ? `省 ${(100 - (r.bMs / r.aMs) * 100).toFixed(0)}%` : ""}`);
  }
  console.log(`\n合计 ${result.n} 张：现状 ${result.tA.toFixed(0)}ms → 烘焙 ${result.tB.toFixed(0)}ms（解码+上传，${(100 - (result.tB / result.tA) * 100).toFixed(0)}% 省）`);
  console.log(`取字节：.tex ${result.fetchA.toFixed(0)}ms（生产里 pkg 已在内存≈0） / PNG ${result.fetchB.toFixed(0)}ms`);
  console.log(`字节：.tex ${(result.bytesA / 1e6).toFixed(1)}MB → PNG ${(result.bytesB / 1e6).toFixed(1)}MB（×${(result.bytesB / result.bytesA).toFixed(2)}）`);
  console.log(`GPU 纹理等价：${result.mismatch ? `✗ ${result.mismatch} 张不一致` : `✓ ${result.n} 张逐位一致`}${result.skipped ? `（跳过 ${result.skipped}）` : ""}`);
} else {
  const err = await page.evaluate("window.__bakeError").catch(() => null);
  const step = await page.evaluate("window.__bakeStep").catch(() => null);
  const txt = await page.evaluate("document.getElementById('out').textContent").catch(() => "(读不到)");
  console.log("页面输出全文：\n" + txt.slice(0, 2000));
  console.log("step:", step, "| error:", err);
  console.log("未拿到结果，页面输出：\n" + String(txt).slice(0, 3000));
}
await page.close();
await s.close();
srv.close();
