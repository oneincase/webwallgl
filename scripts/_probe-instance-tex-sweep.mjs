// 探针：`instance.textures` 修复的**非像素**回归对账（两臂 A/B + 自比对）。
//
// 为什么不用像素：无头连拍（`--shots 4`）会在页面尚未就绪时抓到空帧/黑帧，`before`/`after` 两臂
// 各跑一次就出现「after 反而全白」的竞态伪证（本仓库踩过）。装配状态是确定性的：逐张导航、等
// 装配完成，dump 每个图层的 `{solid, textureName, visible}` 与上传贴图数，比对即可。
//
// 断言口径（2026-10-14，3815761795 画桥整屏发白）：修复把「实例层贴图槽」从对象自己的
// `instance.textures[]` 读回来（`scene-mount.ts`），因此——
//   3815761795 的 id18/id307：`solid` true→false、`tex` null→背景/前景，上传贴图数 40→42；
//   其余同语料壁纸：只有「本该变的那几层」变（`solid` 只减不增、`tex` 只从 null 变有），
//   且 `$mediaThumbnail` 之类的 `$` 保留名占位零变化（那是 `instance.usertextures` 的线）。
//
// 前置：dev server 在 1430；两臂要跑在**不同 commit**上（before = 修复前的 HEAD~1 或 `git stash`，
// 注意先 stash 掉未提交改动，否则两臂是同一份代码、必然「零变化」这个假绿）。
// 用法：
//   # ① 出两臂（各在对应代码版本上跑）
//   node scripts/_probe-instance-tex-sweep.mjs --arm after  --out /tmp/insttex-after.json
//   node scripts/_probe-instance-tex-sweep.mjs --arm before --out /tmp/insttex-before.json
//   # ② 自比对（默认 --ids 自动取库里带**非 util/** `instance.textures` 的壁纸）
//   node scripts/_probe-instance-tex-sweep.mjs --diff /tmp/insttex-before.json /tmp/insttex-after.json
//   # ③ 只想跑指定的几张
//   node scripts/_probe-instance-tex-sweep.mjs --arm after --ids /tmp/ab-list.txt --out /tmp/x.json
import fs from "node:fs";
import path from "node:path";
import { LIB, ROOT, dec } from "./lib/verify-kit.mjs";
import { launchHeadless, instrument } from "./headless-gpu.mjs";

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};

// ─────────────── 自比对模式 ───────────────
const di = argv.indexOf("--diff");
if (di >= 0) {
  const [a, b] = [argv[di + 1], argv[di + 2]];
  const A = JSON.parse(fs.readFileSync(a, "utf8"));
  const B = JSON.parse(fs.readFileSync(b, "utf8"));
  const ids = [...new Set([...Object.keys(A), ...Object.keys(B)])].sort();
  let changedTotal = 0;
  let reservedChanged = 0;
  const increased = [];
  for (const id of ids) {
    const la = A[id]?.layers || [];
    const lb = B[id]?.layers || [];
    const ka = A[id]?.texKeys?.length ?? -1;
    const kb = B[id]?.texKeys?.length ?? -1;
    const byA = new Map(la.map((l) => [l.id, l]));
    const lines = [];
    for (const l of lb) {
      const p = byA.get(l.id);
      if (!p) continue;
      const d = [];
      if (p.solid !== l.solid) d.push(`solid ${p.solid}→${l.solid}`);
      if (p.tex !== l.tex) d.push(`tex ${p.tex ?? "null"}→${l.tex ?? "null"}`);
      if (p.visible !== l.visible) d.push(`visible ${p.visible}→${l.visible}`);
      if (!d.length) continue;
      if (p.solid === false && l.solid === true) increased.push(`${id}#${l.id}`);
      if (l.tex && String(l.tex).startsWith("$")) reservedChanged++;
      lines.push(`    #${String(l.id).padStart(4)} ${l.name || ""}  ${d.join("  ")}`);
      changedTotal++;
    }
    if (lines.length || ka !== kb) {
      console.log(`${id}  tex ${ka}→${kb}`);
      for (const s of lines) console.log(s);
    }
  }
  console.log(`\n共 ${changedTotal} 层变化；\`solid\` 反向（false→true）${increased.length} 处${increased.length ? "：" + increased.join(", ") : ""}`);
  console.log(`\`$\` 保留名贴图变化 ${reservedChanged} 处（必须为 0，那是 instance.usertextures 的线）`);
  process.exit(reservedChanged === 0 && increased.length === 0 ? 0 : 1);
}

// ─────────────── 出臂模式 ───────────────
const ARM = arg("arm", "after");
const OUT = arg("out", `/tmp/insttex-${ARM}.json`);

/** 默认 ID 列表：库里带**非 util/** `instance.textures` 的壁纸（与代码版本无关，两臂一致） */
async function defaultIds() {
  const { parsePkg, getEntry } = await import(
    path.join(ROOT, "renderer/vendor/we-scene/pkg/container.js")
  );
  const ids = [];
  for (const id of fs.readdirSync(LIB)) {
    const p = path.join(LIB, id, "scene.pkg");
    if (!fs.existsSync(p)) continue;
    let pkg;
    try {
      pkg = parsePkg(new Uint8Array(fs.readFileSync(p)));
    } catch {
      continue;
    }
    if (!pkg.entries.find((e) => e.name === "scene.json")) continue;
    let sj;
    try {
      sj = JSON.parse(dec.decode(getEntry(pkg, "scene.json")).replace(/^\uFEFF/, ""));
    } catch {
      continue;
    }
    const hit = (sj.objects || []).some((o) =>
      (o.instance?.textures || []).some((t) => typeof t === "string" && t && !t.startsWith("util/")),
    );
    if (hit) ids.push(id);
  }
  return ids;
}

const idsArg = arg("ids", null);
const IDS = idsArg
  ? fs.readFileSync(idsArg, "utf8").split("\n").map((s) => s.trim()).filter(Boolean)
  : await defaultIds();

const BASE =
  "http://localhost:1430/renderer/index.html?type=scene&fit=cover&renderDpr=0&sceneFps=30&aa=off&pq=high&pp=high&filter=none&muted=true&loop=true&mediaBase=http%3A%2F%2Flocalhost%3A1430%2Fmedia%2Fdev&liveSystem=1&src=";

const DUMP = `(()=>{
  const S = window.__scene;
  if (!S) return JSON.stringify({err:'no __scene'});
  let texKeys = [];
  try { const t = window.__textures; if (t) texKeys = (t instanceof Map ? [...t.keys()] : Object.keys(t)); } catch(e) {}
  return JSON.stringify({
    n: S.layers.length,
    texKeys,
    layers: S.layers.map((l) => ({
      id: l.id, name: (l.name || '').slice(0, 40),
      solid: !!l.solid, tex: l.textureName || null, visible: !!l.visible,
      destroyed: !!l.destroyed,
    })),
  });
})()`;

console.log(`arm=${ARM}  ids=${IDS.length}  out=${OUT}`);
const session = await launchHeadless({ width: 1280, height: 720 });
instrument(session);
const page = await session.newPage("about:blank");
const result = {};
for (const id of IDS) {
  try {
    await page.cdp.send("Page.navigate", { url: BASE + id });
    // 固定等待（不是轮询）：两臂用同一节奏，才能逐层对账
    await new Promise((r) => setTimeout(r, 6000));
    const r = await page.cdp.send("Runtime.evaluate", { expression: DUMP, returnByValue: true });
    const v = r.result?.value;
    result[id] = v ? JSON.parse(v) : { err: "no value" };
    console.log(id, "layers=", result[id].n, "tex=", (result[id].texKeys || []).length);
  } catch (e) {
    result[id] = { err: String(e && e.message) };
    console.log(id, "ERR", String(e && e.message).slice(0, 120));
  }
}
fs.writeFileSync(OUT, JSON.stringify(result, null, 1));
console.log("written", OUT);
await session.close?.();
process.exit(0);
