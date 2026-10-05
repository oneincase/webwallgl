// 一次性普查（非门禁）：逐张实机打开场景壁纸，截获 /diag 上报里的脚本失败，按消息聚类。
// 用法：node scripts/_sweep-script-errors.mjs [--all] [--out file.json] [id...]
//   默认只跑 scene.json 里带 script 的壁纸；需开发服务器 localhost:1430。
import fs from "node:fs";
import { join } from "node:path";
import { launchHeadless, instrument } from "./headless-gpu.mjs";
import { parsePkg, getEntry } from "../renderer/vendor/we-scene/pkg/container.js";
import { LIB, dec } from "./lib/verify-kit.mjs";

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const out = outIdx >= 0 ? args.splice(outIdx, 2)[1] : null;
const all = args.includes("--all");
let ids = args.filter((a) => /^\w+$/.test(a) && a !== "--all");
if (!ids.length) {
  ids = fs.readdirSync(LIB).filter((id) => {
    const p = join(LIB, id, "scene.pkg");
    if (!fs.existsSync(p)) return false;
    if (all) return true;
    try {
      return /"script"\s*:/.test(dec.decode(getEntry(parsePkg(new Uint8Array(fs.readFileSync(p))), "scene.json")));
    } catch {
      return false;
    }
  });
}

const BASE = "http://localhost:1430/renderer/index.html?type=scene&fit=cover&renderDpr=0&sceneFps=30&aa=off&pq=high&pp=high&filter=none&muted=true&loop=true&mediaBase=http%3A%2F%2Flocalhost%3A1430%2Fmedia%2Fdev&liveSystem=1&src=";
const SCRIPT_RE = /script|脚本|sandbox|沙箱|定时器|init 失败|求值失败/i;
const DWELL_MS = 10000;
const CONC = 3;

const session = await launchHeadless({ width: 1280, height: 720 });
instrument(session);
const result = {};

async function runOne(id) {
  const page = await session.newPage("about:blank");
  const hits = new Set();
  await page.cdp.send("Network.enable").catch(() => {});
  page.cdp.ws.addEventListener("message", (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.method === "Network.requestWillBeSent") {
      const u = m.params.request.url;
      if (!u.includes("/diag?")) return;
      const q = new URL(u).searchParams;
      const lvl = q.get("lvl");
      const msg = (q.get("msg") || "").replace(/^scene \S+: /, "");
      if ((lvl === "warn" || lvl === "error") && SCRIPT_RE.test(msg) && !/^camera path/.test(msg)) hits.add(msg.slice(0, 260));
    } else if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      hits.add("[uncaught] " + String(d.exception?.description || d.text).split("\n")[0].slice(0, 220));
    }
  });
  try {
    await page.cdp.send("Page.navigate", { url: BASE + id });
    await new Promise((r) => setTimeout(r, DWELL_MS));
  } finally {
    await session.browserCdp.send("Target.closeTarget", { targetId: page.targetId }).catch(() => {});
  }
  result[id] = [...hits];
}

let next = 0;
let done = 0;
await Promise.all(
  Array.from({ length: CONC }, async () => {
    while (next < ids.length) {
      const id = ids[next++];
      try { await runOne(id); } catch (e) { result[id] = [`[probe] ${e.message}`]; }
      done++;
      if (done % 10 === 0) console.error(`[sweep] ${done}/${ids.length}`);
    }
  }),
);
await session.close?.();

// 聚类键：去掉对象名/行号/数字，保留错误本体
const clusters = new Map();
for (const [id, list] of Object.entries(result)) {
  for (const msg of list) {
    const body = msg.replace(/^.*?(失败|抛错)[:：]\s*/, "").replace(/@\s*line\s*\d+/g, "").replace(/（图层[^）]*）/g, "").replace(/\d+/g, "N").trim();
    const c = clusters.get(body) || { n: 0, ids: new Set(), sample: msg };
    c.n++;
    c.ids.add(id);
    clusters.set(body, c);
  }
}
const rows = [...clusters.entries()].sort((a, b) => b[1].ids.size - a[1].ids.size);
const summary = rows.map(([k, c]) => ({ error: k, wallpapers: c.ids.size, hits: c.n, ids: [...c.ids].slice(0, 8), sample: c.sample }));
const clean = Object.values(result).filter((l) => l.length === 0).length;
console.log(`扫描 ${ids.length} 张，干净 ${clean} 张，报错簇 ${rows.length} 个`);
for (const s of summary) console.log(`${String(s.wallpapers).padStart(3)} 张 ${String(s.hits).padStart(4)} 处  ${s.error.slice(0, 140)}\n          例 ${s.ids.join(",")} | ${s.sample.slice(0, 160)}`);
if (out) fs.writeFileSync(out, JSON.stringify({ result, summary }, null, 2));
