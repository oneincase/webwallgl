/**
 * 一次性实测探针 · B3（linkProgram 收敛）的可视化探针，非门禁。
 *
 * 为什么用 `autoplay: false`：puppet 场景是动画驱动的，两次运行的普通截图**不可比**；
 * 而仓库文档明确 autoplay:false 的语义是「已就绪但静止在第一帧」——首帧是确定性的，
 * 于是「改前 / 改后」的像素哈希可以直接比对。B3 是纯重构（渲染必须一模一样），
 * 所以这里的期望值是**哈希完全相同**，不是「看起来差不多」。
 *
 * 用法：
 *   node scripts/_probe-review-b3-puppet.mjs 3463520581        # 打印首帧签名
 *   node scripts/_probe-review-b3-puppet.mjs 3463520581 --save # 存一份基准到 /tmp/b3-baseline.json
 *   node scripts/_probe-review-b3-puppet.mjs 3463520581 --diff # 与基准比对
 *
 * 依赖：本机 dev server 在跑（默认 1430）且挂了本地壁纸库。
 */
import fs from "node:fs";
import { createHash } from "node:crypto";
import { launchHeadless, instrument } from "./headless-gpu.mjs";

const ITEM = process.argv[2] || "3463520581";
const MODE = process.argv[3] || "--print";
const ORIGIN = "http://localhost:1430";
const BASE = "/tmp/b3-baseline.json";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 真 GL 上的**属性绑定契约**（B3 的核心，确定性）：
 *   · 传 attribs 表时绑定必须生效（getAttribLocation 返回表里的 index）；
 *   · 传 [] 时**不绑** —— shader 自带的 layout(location=N) 必须原样保留（粒子侧靠它）。
 * 这是 B3 唯一改动的行为面，能在真 GL 上一次性问清楚，不依赖像素比对。
 *
 * GLSL 源码用 JSON.stringify 从 Node 传进页面 —— 不要写在页面表达式的模板字面量里
 * （嵌套模板 + 反斜杠转义已经在本轮踩过一次，见引擎审查文档的「判据工具自身的坑」）。
 */
const SHADERS = {
  vsGeneric: [
    "#version 300 es",
    "in vec3 a_foo;",
    "in vec2 a_bar;",
    "out vec2 v_uv;",
    "void main(){ v_uv = a_bar; gl_Position = vec4(a_foo.xy, 0.0, 1.0); }",
  ].join("\n"),
  vsLayout: [
    "#version 300 es",
    "layout(location = 5) in vec3 a_foo;",
    "in vec2 a_bar;",
    "out vec2 v_uv;",
    "void main(){ v_uv = a_bar; gl_Position = vec4(a_foo.xy, 0.0, 1.0); }",
  ].join("\n"),
  fs: [
    "#version 300 es",
    "precision mediump float;",
    "in vec2 v_uv;",
    "out vec4 o;",
    "void main(){ o = vec4(v_uv, 0.0, 1.0); }",
  ].join("\n"),
  badVs: "#version 300 es\nvoid main(){ gl_Position = vec4(0.0); }",
};

const CONTRACT = `(async () => {
  const S = ${JSON.stringify(SHADERS)};
  const m = await import("/renderer/vendor/we-scene/render/gl-util.js");
  const c = document.createElement("canvas");
  c.width = 64; c.height = 64;
  const gl = c.getContext("webgl2");
  const out = {};
  try {
    const p1 = m.linkProgram(gl, S.vsGeneric, S.fs, { attribs: [[3, "a_foo"], [4, "a_bar"]] });
    out.bound = [gl.getAttribLocation(p1, "a_foo"), gl.getAttribLocation(p1, "a_bar")];
  } catch (e) { out.boundErr = String(e.message).slice(0, 120); }
  try {
    const p2 = m.linkProgram(gl, S.vsLayout, S.fs, { attribs: [] });
    out.layoutKept = gl.getAttribLocation(p2, "a_foo"); // 必须是 5（未被覆盖）
    out.otherUnbound = gl.getAttribLocation(p2, "a_bar");
  } catch (e) { out.layoutErr = String(e.message).slice(0, 120); }
  try {
    m.linkProgram(gl, S.badVs, S.badVs, { attribs: [] });
    out.badSourceThrew = false;
  } catch (e) { out.badSourceThrew = true; }
  out.expect = { bound: [3, 4], layoutKept: 5, badSourceThrew: true };
  return JSON.stringify(out);
})()`;

const DRIVER = `(async () => {
  const { createScene, httpSource } = await import("/renderer/src/api/index.ts");
  const ORIGIN = ${JSON.stringify(ORIGIN)};
  const diags = [];
  const d = document.createElement("div");
  d.style.cssText = "position:absolute;left:0;top:0;width:960px;height:540px;";
  document.body.appendChild(d);
  const s = createScene(d, {
    muted: true, mountTimeoutMs: 30000,
    onDiagnostic: (m, l) => diags.push(l + ": " + m),
  });
  // autoplay:false ⇒ 出首帧后立即暂停：首帧是确定性的，可跨运行比对
  const src = httpSource(ORIGIN + "/media/dev/${ITEM}");
  let err = null;
  try { await s.load(src, { autoplay: false }); } catch (e) { err = String(e && e.message).slice(0, 120); }
  // 再等一会确保脚本/动画没有继续推进（暂停后 renderLoop 不再提交帧）
  await new Promise((r) => setTimeout(r, 1500));
  const c = d.querySelector("canvas");
  // 粗粒度签名：8x8 网格的平均 RGB。puppet 的动画会让逐像素哈希每次都不同
  // （实测三次三个哈希 —— 跨加载的像素帧差不可比），但这张图是几何+贴图驱动的大结构，
  // 网格均值对时序抖动稳健、对「缺网格 / 绑错属性 / 贴图错位」这类 B3 风险敏感。
  let sig = null;
  try {
    const off = document.createElement("canvas");
    off.width = 8; off.height = 8;
    const octx = off.getContext("2d");
    octx.drawImage(c, 0, 0, 8, 8);
    const px = octx.getImageData(0, 0, 8, 8).data;
    sig = [];
    for (let i = 0; i < px.length; i += 4) sig.push([px[i], px[i + 1], px[i + 2]]);
  } catch (e) { sig = "降采样失败: " + e.message; }
  return JSON.stringify({
    err,
    sig,
    canvas: c ? c.width + "x" + c.height : null,
    diags: diags.filter((m) => /shader|链接|link|编译|invalid|INVALID/i.test(m)).slice(0, 6),
    diagTotal: diags.length,
    layers: (window.__sceneLayers && window.__sceneLayers.length) || null,
  });
})()`;

async function main() {
  const session = await launchHeadless({ url: "about:blank", task: "b3-puppet", width: 960, height: 540 });
  let out;
  try {
    instrument(session);
    await session.assertGpu();
    await session.pageCdp.send("Page.navigate", { url: `${ORIGIN}/renderer/index.html?type=canvas` });
    await sleep(1200);
    const contract = JSON.parse(await session.evaluate(CONTRACT, { awaitPromise: true, timeoutMs: 30000 }));
    console.log("属性绑定契约:", JSON.stringify(contract));
    const state = JSON.parse(await session.evaluate(DRIVER, { awaitPromise: true, timeoutMs: 90000 }));
    const png = await session.screenshot({ format: "png" });
    out = {
      item: ITEM,
      hash: createHash("sha256").update(png).digest("hex").slice(0, 20),
      pngBytes: Buffer.from(png, "base64").length,
      ...state,
    };
  } finally {
    try {
      await session.close();
    } catch {
      /* 忽略 */
    }
  }
  console.log(JSON.stringify(out, null, 1));
  if (MODE === "--save") {
    fs.writeFileSync(BASE, JSON.stringify(out));
    console.log("基准已存:", BASE);
  } else if (MODE === "--diff") {
    if (!fs.existsSync(BASE)) {
      console.error("没有基准（先跑 --save）");
      process.exit(2);
    }
    const base = JSON.parse(fs.readFileSync(BASE, "utf8"));
    const same = base.hash === out.hash;
    console.log(same ? "✓ 首帧像素完全一致（B3 未改变画面）" : `✗ 首帧像素不同：${base.hash} → ${out.hash}`);
    if (!same) process.exit(1);
  }
}

await main();
