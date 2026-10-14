// 探针：单张壁纸的**图层装配**概览（`window.__scene.layers` 按绘制序）+ 诊断出口 + 控制台 /diag 抓取。
//
// 用途：现象是「整屏白 / 整屏纯色 / 某个挂件不见了」时，先看**谁盖住了谁**，别在截图里猜。
// 典型：3815761795「画桥」的 0 号「背景」(id18) 与 51 号「桥-不透明」(id307) 都是 3840×2160
// `SOLID`、`tex=null`，把下面 0–50 层全盖住 ⇒ 整屏发白（见 docs/CASEBOOK.md 与 we-scene-debug）。
//
// 前置：dev server 在 1430（`pnpm dev`），本机 Chrome 可用；会启动真 GPU 无头页。
// 用法：node scripts/_probe-381-layers.mjs [壁纸ID] [--json /tmp/layers.json]
//   默认壁纸 ID = 3815761795。`--json` 额外把整份 dump（含 effects/size/origin/scale）写成文件。
import fs from "node:fs";
import { launchHeadless, instrument } from "./headless-gpu.mjs";

const argv = process.argv.slice(2);
const flag = (k) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : null;
};
const ID = argv.find((a) => /^\d+$/.test(a)) || "3815761795";
const OUT = flag("json");
const BASE =
  "http://localhost:1430/renderer/index.html?type=scene&fit=cover&renderDpr=0&sceneFps=30&aa=off&pq=high&pp=high&filter=none&muted=true&loop=true&mediaBase=http%3A%2F%2Flocalhost%3A1430%2Fmedia%2Fdev&liveSystem=1&src=";

const session = await launchHeadless({ width: 1280, height: 720 });
instrument(session);
const page = await session.newPage("about:blank");
await page.cdp.send("Network.enable").catch(() => {});
page.cdp.ws.addEventListener("message", (ev) => {
  let m;
  try {
    m = JSON.parse(ev.data);
  } catch {
    return;
  }
  if (m.method === "Network.requestWillBeSent" && m.params.request.url.includes("/diag?")) {
    const q = new URL(m.params.request.url).searchParams;
    const msg = q.get("msg") || "";
    if (/脚本|效果|shader|pass|纹理|贴图|编译|跳过|失败|error|Error/i.test(msg)) {
      console.log("[diag]", msg.slice(0, 400));
    }
  }
});
await page.cdp.send("Page.navigate", { url: BASE + ID });
await new Promise((r) => setTimeout(r, 5000));

const expr = `(()=>{
  const S = window.__scene;
  if (!S) return JSON.stringify({err:'no __scene'});
  const out = { n: S.layers.length, layers: [] };
  S.layers.forEach((l, i) => {
    out.layers.push({
      i,
      id: l.id,
      name: (l.name||'').slice(0,32),
      type: l.type,
      visible: l.visible,
      alpha: l.alpha,
      color: l.color,
      tex: l.textureName ? String(l.textureName).slice(0,48) : null,
      solid: !!l.solid,
      puppet: !!l.puppet,
      bones: l.puppet ? (l.puppet.mdl?.bones?.length || 0) : 0,
      eff: (l.effects||[]).map(e=>({f:(e.file||'').slice(-40), vis:e.visible, passes:(e.passes||[]).length})),
      size: l.size, origin: l.origin, scale: l.scale,
      destroyed: l.destroyed,
      w: l.width, h: l.height,
    });
  });
  return JSON.stringify(out);
})()`;
const r = await page.cdp.send("Runtime.evaluate", {
  expression: expr,
  returnByValue: true,
});
const data = JSON.parse(r.result.value);
console.log("src=" + ID + "  layers:", data.n);
for (const l of data.layers) {
  console.log(
    [
      String(l.i).padStart(2),
      String(l.id ?? "-").padStart(4),
      (l.name || "").padEnd(20).slice(0, 20),
      String(l.type).padEnd(14),
      l.visible ? "vis" : "HID",
      "a=" + l.alpha,
      l.color ? "c=" + JSON.stringify(l.color) : "",
      l.solid ? "SOLID" : "",
      l.puppet ? "PUPPET(" + l.bones + ")" : "",
      l.tex ? "tex=" + l.tex : "",
      l.size ? "size=" + JSON.stringify(l.size) : "",
      l.destroyed ? "DESTROYED" : "",
      l.eff.length ? "EFF=" + JSON.stringify(l.eff) : "",
    ]
      .filter(Boolean)
      .join(" "),
  );
}

// 诊断出口（页面里的自省全局量；有就打印，没有就显示 undefined）
for (const e of ["__particleStats", "__effectScripts", "__objScripts", "__shaderFails", "__textures", "__memStats", "__wpStats"]) {
  const rr = await page.cdp.send("Runtime.evaluate", {
    expression: `(()=>{try{const v = window.${e}; return JSON.stringify(typeof v==='function'? v() : v) }catch(err){return 'ERR '+err.message}})()`,
    returnByValue: true,
  });
  const v = rr.result?.value;
  console.log("\n=== " + e + " ===\n" + String(v).slice(0, 2500));
}

if (OUT) {
  fs.writeFileSync(OUT, JSON.stringify(data, null, 1));
  console.log("\nwritten " + OUT);
}

await session.close?.();
process.exit(0);
