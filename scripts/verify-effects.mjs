// 效果链解析的**诊断契约**验证（issue #10 / #11）
//
// 背景：效果链的失败形态全是「静默」——效果文件不在包内、pass 直写 shader（漏了
// material 那一层）、material 不在包内 / 里面没有 shader、shader 缺 .vert —— 作者
// 看到的都只是「图层退回内置材质的纯色块」，分不清是字段层数错还是 shader/贴图名错。
//
// 判据分两类，缺一不可：
//   · **该报的必须报**：上面每种写法各产生一条指名到文件/字段的诊断（且同一处只报一次）；
//   · **不该报的一个都不许报**：官方两段式形态、copy/swap 命令 pass、以及**全库真语料**
//     （10420 条效果 / 12264 个 pass）跑一遍，诊断数必须是 0。
//     —— 只测前者会得到一个「见谁都报警」的实现；这正是本脚本后半段存在的理由。
//
// 另：verify 跑的是 resolveEffectChain 与 getEntry 的**真实现**（vendor 原生 ESM，
// Node 与浏览器同一条加载路径）。假 pkg 只满足 getEntry 用到的字段契约
// （entries/dataStart/fileSize/buf），不重写任何解析逻辑。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ROOT, LIB, createChecker } from "./lib/verify-kit.mjs";

const { check, fail, errors } = createChecker({ echo: true });

const { parsePkg, getEntry } = await import(path.join(ROOT, "renderer/vendor/we-scene/pkg/container.js"));
const { resolveEffectChain } = await import(path.join(ROOT, "renderer/vendor/we-scene/scene/effects-parse.js"));

const dec = new TextDecoder("utf-8");
const enc = new TextEncoder();
/** 与 shell.ts 的 readText 同语义（去 BOM 的 utf8 解码） */
const readText = (bytes) => dec.decode(bytes).replace(/^\uFEFF/, "");

/**
 * 造一个只满足 getEntry 契约的假 pkg。
 * files: [[名字, 文本], ...]
 */
function fakePkg(files) {
  let off = 0;
  const entries = [];
  const chunks = [];
  for (const [name, text] of files) {
    const bytes = enc.encode(text);
    entries.push({ name, offset: off, size: bytes.length });
    chunks.push(bytes);
    off += bytes.length;
  }
  const buf = new Uint8Array(off);
  let p = 0;
  for (const c of chunks) {
    buf.set(c, p);
    p += c.length;
  }
  return { entries, dataStart: 0, fileSize: off, buf };
}

/** 跑一条效果，收集诊断 */
function run(pkg, file, { name = "", visible = true } = {}) {
  const effect = { file, name, visible };
  const diags = [];
  resolveEffectChain(pkg, effect, readText, () => {}, (m) => diags.push(m));
  return { effect, diags };
}

// ───────────────────────────────────────────────────────────────────────────
// A. 官方两段式形态：必须**零诊断**且解析出 shader（改坏了会红：漏报比误报更难发现）
// ───────────────────────────────────────────────────────────────────────────
{
  const pkg = fakePkg([
    ["effects/x/effect.json", JSON.stringify({
      fbos: [{ name: "_rt_A", fit: 512, format: "rgba8888" }],
      passes: [{ material: "materials/effects/x.json", target: "_rt_A", bind: [] }],
    })],
    ["materials/effects/x.json", JSON.stringify({ passes: [{ shader: "effects/x", blending: "normal", cullmode: "nocull" }] })],
  ]);
  const { effect, diags } = run(pkg, "effects/x/effect.json");
  check(diags.length === 0, `官方两段式形态不得产生诊断，got ${JSON.stringify(diags)}`);
  check(effect.materialPasses.length === 1 && effect.materialPasses[0].shader === "effects/x",
    `官方形态应解析出 shader="effects/x"，got ${JSON.stringify(effect.materialPasses.map((p) => p.shader))}`);
  check(effect.fbos.length === 1, `fbos 应保留，got ${effect.fbos.length}`);
  if (diags.length === 0 && effect.materialPasses[0].shader === "effects/x") {
    console.log("  ✓ 官方两段式：零诊断 + shader 正确解析 + fbos 保留");
  }
}

// ───────────────────────────────────────────────────────────────────────────
// B. passes[] 直写 shader（漏了 material 那一层）：必须点名「未识别」+ 给出正确写法
// ───────────────────────────────────────────────────────────────────────────
{
  const pkg = fakePkg([
    ["effects/bad/effect.json", JSON.stringify({ passes: [{ shader: "effects/bad", blending: "normal" }] })],
  ]);
  const { diags } = run(pkg, "effects/bad/effect.json");
  check(diags.length === 1, `直写 shader 应恰好产生 1 条诊断，got ${diags.length}: ${JSON.stringify(diags)}`);
  const d = diags[0] || "";
  check(d.includes("pass 0") && d.includes("未识别"), `诊断应点名 pass 序号与「未识别」：${d}`);
  check(d.includes("material"), `诊断应指出 shader 要写在 material 里（否则作者仍不知道层数写错）：${d}`);
  check(d.includes("effects/bad"), `诊断应回显作者的 shader 名：${d}`);
  if (diags.length === 1 && d.includes("material") && d.includes("未识别")) {
    console.log("  ✓ 直写 shader：一条诊断点名「未识别」并指明 material 两段式写法");
  }
}

// ───────────────────────────────────────────────────────────────────────────
// C. 完全认不出的 pass（既无 material 也无 command）也要报
// ───────────────────────────────────────────────────────────────────────────
{
  const pkg = fakePkg([["effects/c/effect.json", JSON.stringify({ passes: [{ target: null }] })]]);
  const { diags } = run(pkg, "effects/c/effect.json");
  check(diags.length === 1 && diags[0].includes("未识别"), `空 pass 应报「未识别」，got ${JSON.stringify(diags)}`);
}

// ───────────────────────────────────────────────────────────────────────────
// D. 效果文件不在包内 → 报（且指出 scene.json 的 file 与 pkg 实际路径）
// ───────────────────────────────────────────────────────────────────────────
{
  const pkg = fakePkg([["scene.json", "{}"]]);
  const { diags } = run(pkg, "effects/nope/effect.json");
  check(diags.length === 1 && diags[0].includes("不在包内") && diags[0].includes("effects/nope/effect.json"),
    `效果文件缺失应报「不在包内」并回显路径，got ${JSON.stringify(diags)}`);
}

// ───────────────────────────────────────────────────────────────────────────
// E. material 指向的文件不在包内 → 报
// ───────────────────────────────────────────────────────────────────────────
{
  const pkg = fakePkg([
    ["effects/e/effect.json", JSON.stringify({ passes: [{ material: "materials/effects/nope.json", target: null }] })],
  ]);
  const { diags } = run(pkg, "effects/e/effect.json");
  check(diags.length === 1 && diags[0].includes("materials/effects/nope.json") && diags[0].includes("不在包内"),
    `材质缺失应报「不在包内」并回显材质路径，got ${JSON.stringify(diags)}`);
}

// ───────────────────────────────────────────────────────────────────────────
// F. 材质在、但里面没有 passes[0].shader → 报（否则同样是静默纯色块）
// ───────────────────────────────────────────────────────────────────────────
{
  const pkg = fakePkg([
    ["effects/f/effect.json", JSON.stringify({ passes: [{ material: "materials/effects/f.json", target: null }] })],
    ["materials/effects/f.json", JSON.stringify({ passes: [{ blending: "normal" }] })],
  ]);
  const { diags } = run(pkg, "effects/f/effect.json");
  check(diags.length === 1 && diags[0].includes("shader"),
    `材质缺 shader 应报出来，got ${JSON.stringify(diags)}`);
}

// ───────────────────────────────────────────────────────────────────────────
// G. 坏 JSON（效果文件 / 材质文件）也不能静默
// ───────────────────────────────────────────────────────────────────────────
{
  const pkg = fakePkg([["effects/g/effect.json", "{ this is not json"]]);
  const { diags } = run(pkg, "effects/g/effect.json");
  check(diags.length === 1 && diags[0].includes("JSON"), `坏效果 JSON 应报，got ${JSON.stringify(diags)}`);
  const pkg2 = fakePkg([
    ["effects/g2/effect.json", JSON.stringify({ passes: [{ material: "materials/effects/g2.json" }] })],
    ["materials/effects/g2.json", "{{{ broken"],
  ]);
  const r2 = run(pkg2, "effects/g2/effect.json");
  check(r2.diags.length === 1 && r2.diags[0].includes("JSON"), `坏材质 JSON 应报，got ${JSON.stringify(r2.diags)}`);
}

// ───────────────────────────────────────────────────────────────────────────
// H. copy / swap 命令 pass：**不许**报「未识别」（全库 23 处真语料就是 copy）
// ───────────────────────────────────────────────────────────────────────────
{
  const pkg = fakePkg([
    ["effects/h/effect.json", JSON.stringify({
      passes: [
        { command: "copy", source: "_rt_A", target: "_rt_B" },
        { command: "swap", source: "_rt_A", target: "_rt_B" },
      ],
    })],
  ]);
  const { effect, diags } = run(pkg, "effects/h/effect.json");
  check(diags.length === 0, `copy/swap 命令 pass 不得产生诊断，got ${JSON.stringify(diags)}`);
  check(effect.materialPasses.length === 2 && effect.materialPasses[0].copyCommand === true && effect.materialPasses[1].swapCommand === true,
    `copy/swap 语义应保留（copyCommand/swapCommand），got ${JSON.stringify(effect.materialPasses.map((p) => [p.copyCommand, p.swapCommand]))}`);
  if (diags.length === 0) console.log("  ✓ copy/swap 命令 pass：零诊断 + 语义保留");
}

// ───────────────────────────────────────────────────────────────────────────
// I. 去重：装配期 + 热更期对同一效果各跑一遍 → 只报一次（不许刷屏）
// ───────────────────────────────────────────────────────────────────────────
{
  const pkg = fakePkg([["effects/i/effect.json", JSON.stringify({ passes: [{ shader: "effects/i" }] })]]);
  const first = run(pkg, "effects/i/effect.json");
  const second = run(pkg, "effects/i/effect.json");
  const third = run(pkg, "effects/i/effect.json");
  check(first.diags.length === 1, `首次应报 1 条，got ${first.diags.length}`);
  check(second.diags.length === 0 && third.diags.length === 0,
    `重复解析同一效果只应报一次，got second=${second.diags.length} third=${third.diags.length}`);
  if (first.diags.length === 1 && second.diags.length === 0) {
    console.log("  ✓ 去重：同一效果连解析 3 次只报 1 条");
  }
}

// ───────────────────────────────────────────────────────────────────────────
// J. 语料断言：全库真效果链解析**诊断数必须为 0**（防误报的唯一硬判据）
// ───────────────────────────────────────────────────────────────────────────
{
  let scenes = 0;
  let effects = 0;
  let passes = 0;
  let falsePositives = 0;
  const samples = [];
  for (const d of fs.readdirSync(LIB)) {
    if (!/^\d+$/.test(d)) continue;
    const pkgPath = path.join(LIB, d, "scene.pkg");
    if (!fs.existsSync(pkgPath)) continue;
    let pkg, sj;
    try {
      pkg = parsePkg(new Uint8Array(fs.readFileSync(pkgPath)));
      const e = getEntry(pkg, "scene.json");
      if (!e) continue;
      sj = JSON.parse(dec.decode(e));
    } catch { continue; }
    scenes++;
    for (const o of sj.objects || []) {
      for (const ef of o.effects || []) {
        effects++;
        const stub = { file: ef.file || "", name: ef.name || "", visible: true };
        const diags = [];
        try {
          resolveEffectChain(pkg, stub, readText, () => {}, (m) => diags.push(m));
        } catch (e) {
          diags.push("抛异常: " + ((e && e.message) || e));
        }
        passes += (stub.materialPasses || []).length;
        if (diags.length) {
          falsePositives += diags.length;
          if (samples.length < 8) samples.push(`${d} obj=${o.id} ${ef.file}: ${diags[0]}`);
        }
      }
    }
  }
  if (effects === 0) {
    console.log("  - 跳过语料效果链断言（本机库中无场景壁纸）");
  } else if (falsePositives > 0) {
    fail(`真实语料上出现效果链误报：${falsePositives} 条 / ${effects} 个效果（${scenes} 场景）—— 诊断过严会淹没真问题`);
    for (const s of samples) console.log("    " + s);
  } else {
    console.log(`  ✓ 语料零误报：${scenes} 场景 ${effects} 个效果 / ${passes} 个 pass 全部零诊断`);
  }
}

console.log("");
if (errors.length > 0) {
  console.log(`✗ 共 ${errors.length} 处问题`);
  process.exit(1);
} else {
  console.log("✓ 全部通过");
}
