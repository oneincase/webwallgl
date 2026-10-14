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
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
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
async function run(pkg, file, { name = "", visible = true } = {}) {
  const effect = { file, name, visible };
  const diags = [];
  // 首参仍可传 pkg 对象（readAssetName 的旧签名兼容），但解析过程是异步的
  // —— 松散目录形态要按名取文件，不能同步返回
  await resolveEffectChain(pkg, effect, readText, () => {}, (m) => diags.push(m));
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
  const { effect, diags } = await run(pkg, "effects/x/effect.json");
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
  const { diags } = await run(pkg, "effects/bad/effect.json");
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
  const { diags } = await run(pkg, "effects/c/effect.json");
  check(diags.length === 1 && diags[0].includes("未识别"), `空 pass 应报「未识别」，got ${JSON.stringify(diags)}`);
}

// ───────────────────────────────────────────────────────────────────────────
// D. 效果文件不在包内 → 报（且指出 scene.json 的 file 与 pkg 实际路径）
// ───────────────────────────────────────────────────────────────────────────
{
  const pkg = fakePkg([["scene.json", "{}"]]);
  const { diags } = await run(pkg, "effects/nope/effect.json");
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
  const { diags } = await run(pkg, "effects/e/effect.json");
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
  const { diags } = await run(pkg, "effects/f/effect.json");
  check(diags.length === 1 && diags[0].includes("shader"),
    `材质缺 shader 应报出来，got ${JSON.stringify(diags)}`);
}

// ───────────────────────────────────────────────────────────────────────────
// G. 坏 JSON（效果文件 / 材质文件）也不能静默
// ───────────────────────────────────────────────────────────────────────────
{
  const pkg = fakePkg([["effects/g/effect.json", "{ this is not json"]]);
  const { diags } = await run(pkg, "effects/g/effect.json");
  check(diags.length === 1 && diags[0].includes("JSON"), `坏效果 JSON 应报，got ${JSON.stringify(diags)}`);
  const pkg2 = fakePkg([
    ["effects/g2/effect.json", JSON.stringify({ passes: [{ material: "materials/effects/g2.json" }] })],
    ["materials/effects/g2.json", "{{{ broken"],
  ]);
  const r2 = await run(pkg2, "effects/g2/effect.json");
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
  const { effect, diags } = await run(pkg, "effects/h/effect.json");
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
  const first = await run(pkg, "effects/i/effect.json");
  const second = await run(pkg, "effects/i/effect.json");
  const third = await run(pkg, "effects/i/effect.json");
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
          await resolveEffectChain(pkg, stub, readText, () => {}, (m) => diags.push(m));
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

// ───────────────────────────────────────────────────────────────────────────
// K. 效果结构编辑（M1 A1 扩展）：六种 plan 的纯函数判据 + 真引擎复核
//    真源是 editor/effects-struct.ts（esbuild 现打包真跑，与 verify-editor 同款做法，
//    不在脚本里抄第二份逻辑）。最后三条把 plan 的**产物文本**喂给真 resolveEffectChain，
//    确认引擎确实按我写的位置读 material / target / bind。
// ───────────────────────────────────────────────────────────────────────────
async function loadStructModule() {
  const res = await build({
    entryPoints: [path.join(ROOT, "editor/effects-struct.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    loader: { ".glsl": "text" },
    logLevel: "silent",
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-effects-struct-"));
  const tmp = path.join(dir, "effects-struct.mjs");
  fs.writeFileSync(tmp, res.outputFiles[0].text);
  return import(pathToFileURL(tmp).href);
}
{
  const S = await loadStructModule();
  const j = (v) => JSON.stringify(v);
  const onePass = () =>
    j({ version: 1, name: "wwgl_t", passes: [{ material: "materials/effects/wwgl_t.json" }] }, null, 2);
  const twoPass = () =>
    j(
      {
        version: 1,
        name: "wwgl_t",
        fbos: [{ name: "_rt_A", scale: 1, format: "rgba8888" }],
        passes: [
          { material: "materials/effects/wwgl_t.json", target: "_rt_A", bind: [{ name: "previous", index: 1 }] },
          { material: "materials/effects/wwgl_t.json" },
        ],
      },
      null,
      2,
    );
  const shaderMat = j({ passes: [{ shader: "effects/wwgl_t", blending: "normal" }] });
  const mats = { "materials/effects/wwgl_t.json": shaderMat, "materials/editor/lib.json": shaderMat };
  const io = {
    read: (n) => mats[n] ?? null,
    projectFiles: new Set(["effects/wwgl_t/effect.json", "materials/effects/wwgl_t.json", "materials/editor/lib.json"]),
  };
  const F = "effects/wwgl_t/effect.json";

  // K1-K3 加 pass
  {
    const r = S.planPassAdd(F, onePass(), 0);
    const d = r.ok ? S.parseEffectDoc(r.value.text) : null;
    const ps = S.passesOf(d);
    check(r.ok && r.value.doc?.kind === "insert" && r.value.doc.at === 1, "K1 加 pass：doc 侧同步 = insert@1（positional 覆盖必须同步）");
    check(ps?.length === 2 && j(ps[0]) === j(ps[1]), "K2 加 pass：新 pass 是源 pass 的深拷贝（材质路径共用，不新增文件）");
    check(r.ok && r.value.text === S.serializeEffectDoc(d) && r.value.text.includes('"name": "wwgl_t"'), "K3 落盘口径 = 2 空格 stringify（未动的键逐字节不变）");
  }
  // K4-K5 删 pass
  {
    const r1 = S.planPassRemove(F, onePass(), 0);
    check(!r1.ok && r1.reason === "fx.structLastPass", "K4 最后一个 pass 不给删（删空 = 整条链不出图）");
    const r2 = S.planPassRemove(F, twoPass(), 0);
    check(r2.ok && r2.value.doc?.kind === "remove" && r2.value.doc.at === 0 && S.passesOf(S.parseEffectDoc(r2.value.text))?.length === 1,
      "K5 删 pass：passes 少一条 + 同步 remove@0");
  }
  // K6-K7 上下移 pass
  {
    const up = S.planPassMove(F, twoPass(), 0, -1);
    check(!up.ok && up.reason === "fx.structNoChange", "K6 首个 pass 上移 = 没有变化（调用方据此不进撤销栈）");
    const mv = S.planPassMove(F, twoPass(), 0, 1);
    const ps = mv.ok ? S.passesOf(S.parseEffectDoc(mv.value.text)) : null;
    check(mv.ok && mv.value.doc?.kind === "move" && mv.value.doc.from === 0 && mv.value.doc.to === 1 && ps?.[1]?.target === "_rt_A" && ps?.[0]?.target === undefined,
      "K7 下移 pass：执行序换位 + 同步 move{0→1}");
  }
  // K8-K12 换 material
  {
    check(!S.planMaterial(F, onePass(), 0, "../library/materials/x.json", io).ok, "K8 换 material：绝对/越界路径被拒");
    const bad2 = S.planMaterial(F, onePass(), 0, "materials/nope.json", io);
    check(!bad2.ok && bad2.reason === "fx.structBadMaterial", "K9 换 material：不在工程资源表被拒（＝不改素材库）");
    const bare = { read: () => j({ passes: [{ blending: "normal" }] }), projectFiles: new Set(["materials/bare.json"]) };
    const bad3 = S.planMaterial(F, onePass(), 0, "materials/bare.json", bare);
    check(!bad3.ok && bad3.reason === "fx.structBadMaterial", "K10 换 material：材质缺 passes[0].shader 被拒（引擎会静默跳过该 pass）");
    const same = S.planMaterial(F, onePass(), 0, "materials/effects/wwgl_t.json", io);
    check(!same.ok && same.reason === "fx.structNoChange", "K11 换 material：值没变被拒");
    const good = S.planMaterial(F, onePass(), 0, "materials/editor/lib.json", io);
    const gd = good.ok ? S.parseEffectDoc(good.value.text) : null;
    check(good.ok && good.value.doc === null && S.passesOf(gd)?.[0]?.material === "materials/editor/lib.json" && gd?.name === "wwgl_t",
      "K12 换 material：只改 passes[0].material，其余键不动（doc 侧无需同步）");
  }
  // K13-K15 改 target
  {
    const bad = S.planTarget(F, onePass(), 0, "bad name");
    check(!bad.ok && bad.reason === "fx.structBadTarget", "K13 改 target：非法 FBO 名被拒");
    const set = S.planTarget(F, onePass(), 0, "_rt_New");
    const sd = set.ok ? S.parseEffectDoc(set.value.text) : null;
    check(set.ok && set.value.fbo === "_rt_New" && S.fboNamesOf(sd).includes("_rt_New") && S.passesOf(sd)?.[0]?.target === "_rt_New",
      "K14 改 target：未声明的 FBO 自动补 fbos（否则引擎查不到、静默回落 curInput）");
    const clr = S.planTarget(F, twoPass(), 0, "");
    const cd = clr.ok ? S.parseEffectDoc(clr.value.text) : null;
    check(clr.ok && !("target" in (S.passesOf(cd)?.[0] ?? {})), "K15 清空 target：把键删掉（回落到画进当前主 FBO）");
  }
  // K16-K19 改 bind
  {
    const add = S.planBind(F, onePass(), 0, -1, { name: "previous", index: 1 });
    const ad = add.ok ? S.parseEffectDoc(add.value.text) : null;
    check(add.ok && S.bindsOf(S.passesOf(ad)?.[0]).length === 1, "K16 加 bind：追加一条（name + 数字槽）");
    const dup = S.planBind(F, add.ok ? add.value.text : "", 0, -1, { name: "previous", index: 1 });
    check(!dup.ok && dup.reason === "fx.structBindDup", "K17 同槽重复 bind 被拒（引擎里后写覆盖先写，结果取决于数组顺序）");
    const bad = S.planBind(F, onePass(), 0, -1, { name: "有中文", index: 0 });
    check(!bad.ok && bad.reason === "fx.structBadBind", "K18 非法 bind 名 / 槽被拒");
    const del = S.planBind(F, add.ok ? add.value.text : "", 0, 0, null);
    const dd = del.ok ? S.parseEffectDoc(del.value.text) : null;
    check(del.ok && !("bind" in (S.passesOf(dd)?.[0] ?? {})), "K19 删 bind：删空后连键一起删（不留空数组）");
  }
  // K20-K24 doc 侧位置同步
  {
    const obj = () => ({
      id: 1,
      effects: [
        { file: F, visible: true, passes: [{ constantshadervalues: { a: 1 } }, { constantshadervalues: { b: 2 } }] },
        { file: "effects/wwgl_other/effect.json", passes: [{ constantshadervalues: { c: 3 } }] },
      ],
    });
    const o1 = obj();
    const n1 = S.applyDocSync(o1, F, { kind: "insert", at: 1 });
    check(n1 === 1 && j(o1.effects[0].passes[1]) === j({ constantshadervalues: { a: 1 } }) && o1.effects[0].passes.length === 3,
      "K20 加 pass：scene.json 覆盖在 at 处插入同形拷贝（位置对齐）");
    check(o1.effects[1].passes.length === 1, "K21 同步只碰同一个 file 的条目");
    const o2 = obj();
    S.applyDocSync(o2, F, { kind: "remove", at: 0 });
    check(j(o2.effects[0].passes) === j([{ constantshadervalues: { b: 2 } }]), "K22 删 pass：覆盖同步删同下标");
    const o3 = obj();
    S.applyDocSync(o3, F, { kind: "move", from: 0, to: 1 });
    check(j(o3.effects[0].passes) === j([{ constantshadervalues: { b: 2 } }, { constantshadervalues: { a: 1 } }]),
      "K23 移 pass：覆盖跟着换位（否则参数静默错位到别的 pass）");
    const o4 = { id: 2, effects: [{ file: F }] };
    check(S.applyDocSync(o4, F, { kind: "insert", at: 0 }) === 0 && o4.effects[0].passes === undefined,
      "K24 作者没写 passes 覆盖时不动文档（引擎对缺项取 undefined，凭空造数组会写脏字段）");
  }
  // K25-K27 准入（COMPLIANCE：库引用效果禁止结构编辑）
  {
    const files = new Set(["effects/wwgl_t/effect.json", "effects/tint/effect.json"]);
    check(S.isStructEditable(F, files) === true, "K25 工程内 wwgl_ 效果可结构编辑");
    check(S.isStructEditable("effects/tint/effect.json", files) === false, "K26 工程内非编辑器自造的效果（官方内置）不给结构编辑");
    check(S.isStructEditable(F, new Set()) === false, "K27 库引用效果（文件不在工程资源表）不给结构编辑");
  }
  // K28 失败原因键中英各一条（界面 / 日志里不许出现裸键）
  {
    const i18n = fs.readFileSync(path.join(ROOT, "editor/i18n.ts"), "utf8");
    const missing = S.FX_STRUCT_REASONS.filter((k) => (i18n.split(`"${k}":`).length - 1) !== 2);
    check(missing.length === 0, `K28 失败原因键中英各恰好一条（缺/多：${missing.join(", ") || "无"}）`);
  }
  // K29-K31 真引擎复核：plan 的产物文本喂 resolveEffectChain
  {
    const added = S.planPassAdd(F, onePass(), 0);
    const pkg1 = fakePkg([[F, added.ok ? added.value.text : ""], ["materials/effects/wwgl_t.json", shaderMat]]);
    const r1 = await run(pkg1, F);
    check(r1.diags.length === 0 && r1.effect.materialPasses.length === 2 && r1.effect.materialPasses[1].shader === r1.effect.materialPasses[0].shader,
      `K29 加 pass 的产物喂真引擎：2 个 pass 解析出同一条 shader、零诊断（got ${JSON.stringify(r1.diags)}）`);

    const pkg2 = fakePkg([[F, twoPass()], ["materials/effects/wwgl_t.json", shaderMat]]);
    const r2 = await run(pkg2, F);
    check(r2.effect.materialPasses.length === 2 && r2.effect.materialPasses[0].target === "_rt_A" && r2.effect.fbos.length === 1,
      "K30 引擎按位置读 passes[i].target（改 target 就是改这里）");
    check(r2.effect.materialPasses[0].binds.length === 1 && r2.effect.materialPasses[0].binds[0].index === 1 && r2.effect.materialPasses[0].binds[0].name === "previous",
      "K31 引擎按位置读 passes[i].bind（槽是数字、名是字符串）");

    const moved = S.planPassMove(F, twoPass(), 0, 1);
    const pkg3 = fakePkg([[F, moved.ok ? moved.value.text : ""], ["materials/effects/wwgl_t.json", shaderMat]]);
    const r3 = await run(pkg3, F);
    check(moved.ok && r3.effect.materialPasses[0].target === null && r3.effect.materialPasses[1].target === "_rt_A",
      "K32 下移的产物喂真引擎：target 跟着 pass 走到新下标（执行序 = effect.json 顺序）");
  }
  // K33-K34 换 material / 改 target 的产物喂真引擎（「出帧像素会变」的离线代理）
  {
    const before = await run(fakePkg([[F, onePass()], ["materials/effects/wwgl_t.json", shaderMat]]), F);
    const other = j({ passes: [{ shader: "effects/wwgl_o", blending: "normal" }] });
    const swapped = S.planMaterial(F, onePass(), 0, "materials/other.json", {
      read: (n) => (n === "materials/other.json" ? other : null),
      projectFiles: new Set(["materials/other.json"]),
    });
    const after = await run(fakePkg([[F, swapped.ok ? swapped.value.text : ""], ["materials/other.json", other]]), F);
    check(
      swapped.ok &&
        before.effect.materialPasses[0].shader === "effects/wwgl_t" &&
        after.effect.materialPasses[0].shader === "effects/wwgl_o" &&
        after.diags.length === 0,
      `K33 换 material 的产物喂真引擎：该 pass 解析出的 shader 换了一条（这就是出帧像素变化的离线代理；got ${after.effect.materialPasses[0].shader}）`,
    );

    const tgt = S.planTarget(F, onePass(), 0, "_rt_Ping");
    const pkg5 = fakePkg([[F, tgt.ok ? tgt.value.text : ""], ["materials/effects/wwgl_t.json", shaderMat]]);
    const r5 = await run(pkg5, F);
    check(
      tgt.ok && r5.effect.fbos.some((f) => f.name === "_rt_Ping") && r5.effect.materialPasses[0].target === "_rt_Ping",
      `K34 plan 补的 fbos 声明就是引擎查表用的那个名（否则 renderer.js:5149 静默回落 curInput；got ${JSON.stringify(r5.effect.fbos)}）`,
    );
  }
  console.log(`  - 结构编辑 plan 判据 K1–K34 已跑（失败原因键 ${S.FX_STRUCT_REASONS.length} 个逐个查中英词条）`);
}

console.log("");
if (errors.length > 0) {
  console.log(`✗ 共 ${errors.length} 处问题`);
  process.exit(1);
} else {
  console.log("✓ 全部通过");
}
