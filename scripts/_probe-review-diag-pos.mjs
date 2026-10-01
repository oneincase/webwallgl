/**
 * 一次性实测探针 · 新诊断的**正例**夹具（M5 的欠账，非门禁）。
 *
 * 背景：M5 给四条静默路径补了一次性诊断，但当时只能证「14 张真实壁纸不误报」——
 * 「会响」证不了，因为语料里没有天然坏样本（docs/ENGINE-REVIEW-2026-10.md §10 M5）。
 * 这里用**合成坏素材**把正例补上：拿真实 scene.pkg 当底子，只改坏一处。
 *
 * 三个夹具：
 *   A. 删掉部分 .tex 条目          → 期望「纹理缺失，回落白色」
 *   B. 常量脚本改成 update 里抛错  → 期望「脚本 update 抛错」
 *   C. 常量脚本改成顶层就抛错      → 期望「脚本求值失败」
 *
 * 断言方式：库 API 挂载 + `onDiagnostic` 收诊断（Image 通道要 mediaBase，库形态不一定有）。
 *
 * 用法：node scripts/_probe-review-diag-pos.mjs [sceneItemId]
 * 依赖：本机 dev server 在跑（默认 1430）且挂了本地壁纸库。
 */
import fs from "node:fs";
import { join } from "node:path";
import { launchHeadless, instrument } from "./headless-gpu.mjs";

const ITEM = process.argv[2] || "2395163768";
const MAT_ITEM = process.argv[3] || "3509243656"; // 带常量脚本的真实材质（见文档）
const MAT_NAME = process.argv[4] || "materials/models/球体04/DefaultMaterial.json";
const ORIGIN = "http://localhost:1430";
const LIB = join(process.env.HOME, "Library/Application Support/io.github.oneincase.wallpaperem/wallpapers");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { parsePkg, getEntry } = await import("../renderer/vendor/we-scene/pkg/container.js");

/** 按 container.js 描述的布局重建一个 PKGV 包：magicLen + magic + count + {nameLen,name,offset,size} + data */
function buildPkg(entries) {
  const MAGIC = "PKGV0012";
  const head = Buffer.alloc(4 + MAGIC.length + 4);
  head.writeUInt32LE(MAGIC.length, 0);
  head.write(MAGIC, 4, "latin1");
  head.writeUInt32LE(entries.length, 4 + MAGIC.length);
  const table = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const t = Buffer.alloc(4 + name.length + 8);
    t.writeUInt32LE(name.length, 0);
    name.copy(t, 4);
    t.writeUInt32LE(offset, 4 + name.length);
    t.writeUInt32LE(e.data.length, 4 + name.length + 4);
    table.push(t);
    offset += e.data.length;
  }
  const body = Buffer.concat(entries.map((e) => Buffer.from(e.data)));
  return Buffer.concat([head, ...table, body]);
}

function readEntries(itemId) {
  const pkg = parsePkg(new Uint8Array(fs.readFileSync(join(LIB, itemId, "scene.pkg"))));
  return pkg.entries.map((e) => ({ name: e.name, data: Buffer.from(getEntry(pkg, e.name)) }));
}

// A. 删掉场景**自有**的 .tex（保留 util/particle 前缀的：那些有本地素材回退，
//    删了也照样解析得到，起不到「缺纹理」效果 —— 第一版夹具就是这么没命中的）。
//    选 2395163768（0.6MB，带 effects，8 张自有贴图）而不是 1039919954 —— 后者
//    实测 passesResolved=0（没有效果链），根本走不到 pass 的纹理绑定。
const base = readEntries(ITEM);
const dropped = [];
const fixA = buildPkg(
  base.filter((e) => {
    if (!e.name.endsWith(".tex")) return true;
    if (/materials\/(util|particle)\//.test(e.name)) return true; // 有本地回退，留着
    dropped.push(e.name);
    return false;
  }),
);

// 夹具 B/C（脚本 update 抛错 / 脚本求值失败）**暂未做**，原因记录在案：
//   材质不是靠 `layer.material` 挂到层上的 —— parse.js:862 是走 **model**（`modelJson.material`）
//   与 **effect**（`eff.materialPasses`）间接引用。要造一条能跑到的常量脚本，得同时给出
//   「layer.effects 引用某个 effect 文件 → 该 effect 的材质带 constantshadervalues」，
//   而语料里带常量脚本的包最小 151MB（3509243656）、543MB（3662790108），直接挂会拖垮无头页。
//   要做的话：拿一个小包（如 2149068390，1.2MB，材质带 constantshadervalues）**注入一段
//   effects/*.json + 让某个 layer 引用它**，再把脚本改坏。收益（证明另两条 diag 会响）
//   与这条链的成本不成比例，故记为待办而不是现在硬做。
const FIXTURES = [{ id: "A-missing-tex", want: "纹理缺失", pkg: fixA, item: ITEM }];

const DRIVER = (fixturesB64) =>
  `(async () => {
  const OUT = (window.__dpOut = []);
  const { createScene, bytesSource } = await import("/renderer/src/api/index.ts");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  for (const f of ${fixturesB64}) {
    const diags = [];
    const d = document.createElement("div");
    d.style.cssText = "position:absolute;left:0;top:0;width:640px;height:360px;";
    document.body.appendChild(d);
    const s = createScene(d, {
      muted: true,
      mountTimeoutMs: 25000,
      onDiagnostic: (m, l) => diags.push(l + ": " + m),
    });
    let err = null;
    try { await s.load(bytesSource(b64(f.b64), null, "probe-" + f.id)); } catch (e) { err = String(e && e.message).slice(0, 100); }
    await sleep(2500); // 让逐帧路径（update 抛错）有机会命中
    OUT.push({
      id: f.id,
      want: f.want,
      hit: diags.filter((m) => m.indexOf(f.want) >= 0).length,
      loadErr: err,
      diagSample: diags.filter((m) => m.indexOf(f.want) >= 0).slice(0, 2),
      diagTotal: diags.length,
      texDiags: diags.filter((m) => /贴图|纹理|tex/i.test(m)).slice(0, 6),
    });
    s.destroy();
    d.remove();
  }
  return JSON.stringify(OUT);
})()`;

async function main() {
  const payload = JSON.stringify(FIXTURES.map((f) => ({ id: f.id, want: f.want, b64: f.pkg.toString("base64") })));
  const session = await launchHeadless({ url: "about:blank", task: "probe-diag-pos", width: 1280, height: 720 });
  const report = { item: ITEM, mat: MAT_ITEM, matName: MAT_NAME, droppedTex: dropped };
  try {
    instrument(session);
    await session.pageCdp.send("Page.navigate", { url: `${ORIGIN}/renderer/index.html?type=canvas` });
    await sleep(1500);
    report.result = JSON.parse(await session.evaluate(DRIVER(payload), { awaitPromise: true, timeoutMs: 180000 }));
  } finally {
    try {
      await session.close();
    } catch {
      /* 忽略 */
    }
  }
  console.log(JSON.stringify(report, null, 2));
  const bad = (report.result || []).filter((r) => r.hit === 0);
  if (bad.length) console.error("正例未命中：" + bad.map((b) => b.id).join(", "));
}

await main();
