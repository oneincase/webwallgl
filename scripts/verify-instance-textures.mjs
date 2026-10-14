#!/usr/bin/env node
/**
 * verify-instance-textures —— 编辑器「实例化」图层的**贴图槽**契约（`instance.textures`）。
 *
 * 为什么需要它（2026-10-14 的真实回归，用户报「3815761795『明日方舟・夕｜画桥』大面积发白」）：
 *   WE 编辑器「实例化」出来的图层（`image: models/solid_instance_model_*.json`）把贴图槽写在
 *   对象自己的 `instance.textures[]` 里，材质指向 `materials/util/solidlayer_instance_*.json`
 *   —— 该文件**不随包发布**（运行时合成，不存在是正常现象）。装配端找不到材质就回退内置
 *   `materials/util/solidlayer.json`，而那份内置表的 `passes[0].textures` 是**空数组** ⇒ 槽位
 *   取不到任何东西 ⇒ 只剩 `whiteTex × layer.color`。3815761795 的两层恰好是 3840×2160、color
 *   `[1,1,1]`，于是整屏白、把下面 0–50 层（人物/伞/云/雨/桥）全盖住。修复前 `parse.js` 与
 *   `scene-mount.ts` 两端都没读过 `instance.textures`。
 *
 * 判据形态（四段，各自独立）：
 *   [A] **真跑源码切片**：把 `renderer/src/scene-mount.ts` 里「材质槽 ← instance.textures 按索引
 *       覆盖」这段原样取出来，只剥 TS 注解，用 `new Function` 求值，喂合成夹具 —— 被测的就是
 *       产品源码本身，这里不抄第二份合并逻辑。
 *   [B] **变异红测**：同一片段派生三个变体（删 `util/` 守卫 / 删覆盖赋值 / 删 `.slice()` 拷贝），
 *       断言它们在对应夹具上**必须转红** —— 证明 [A] 的断言有牙，而不是恒真的形状检查。
 *   [C] 接线锁（源码）：槽 0 取到真贴图时撤 `layer.solid` 的那一步必须仍在**同一守卫**内
 *       （`si === 0 && !instUtName && !reservedBound`，保留名优先级不许被挤掉），并锁住渲染端
 *       「solid 恒赢」的判据（`!layer.solid && layer.textureName` → 否则退回 `whiteTex`）：这正是
 *       「只写 textureName 不撤 solid 等于没写」的依据。
 *   [D] 真语料契约（读本机素材库，没装库就跳过并仍算通过）：全库带 `instance.textures` 的层里，
 *       非 `util/` 名字**逐张**都要能在包内找到 `materials/<name>.tex`（否则覆盖了也加载不出来）；
 *       纯 `util/` 名字的层必须一个都不被覆盖（那是「纯色填充」的语义）。装了 3815761795 就顺带
 *       钉住它的语料锚点（id18 → ["背景"]、id307 → ["前景"]，两张 tex 都在包内、材质都不在包内）。
 *
 * 改坏的形态与转红项：删 `util/` 守卫 → [A]/[B] 红；删 `if (instTexSlotsOverride.size) texSlots =
 * merged;` → [A]/[B] 红；把 `matTexSlots.slice()` 写成 `matTexSlots` → [A]/[B] 红（就地改写材质槽）；
 * 删掉撤 solid 那一步、或把它挪到 `reservedBound` 守卫之外 → [C] 红；把 `instance.textures` 的读取
 * 换回只认 `instance.usertextures` → [A]/[D] 红。
 *
 * 取证边界：本脚本只读本仓源码（[A]–[C]）+ 本机素材库（[D]，可缺）。不依赖 GPU / 浏览器。
 */
import fs from "node:fs";
import path from "node:path";
import { join } from "node:path";
import { ROOT, LIB, imp, createChecker } from "./lib/verify-kit.mjs";

const ck = createChecker({ echo: true });
const { errors } = ck;
/** 断言计数器：跑完必须打印总数，否则「全部通过」可能只是判据空转 */
let asserted = 0;
const check = (cond, msg) => {
  asserted++;
  ck.check(cond, msg);
};

const MOUNT = "renderer/src/scene-mount.ts";
const RENDERER = "renderer/vendor/we-scene/render/renderer.js";
const src = fs.readFileSync(join(ROOT, MOUNT), "utf8");

// ─────────────── 切片：材质槽 ← instance.textures 的按索引覆盖 ───────────────
const SLICE_START = "const matTexSlots = pass?.textures || [];";
const SLICE_END = "if (instTexSlotsOverride.size) texSlots = merged;";

/** 取出切片（含末尾块闭合的 `}`）；形状变了返回 null，由调用方响亮失败 */
function extractSlice(text) {
  const i = text.indexOf(SLICE_START);
  if (i < 0) return null;
  const j = text.indexOf(SLICE_END, i);
  if (j < 0) return null;
  const k = text.indexOf("}", j + SLICE_END.length);
  if (k < 0) return null;
  return text.slice(i, k + 1);
}

/** TS → JS：本切片只有三处类型语法（`(layer as any)`、多行 `as | Array<…> | undefined`、`Set<number>`） */
function toJs(slice) {
  let js = slice.replace("(layer as any)", "(layer)");
  js = js.replace(/ as\s*\|[^;]*;/, ";");
  js = js.replace("new Set<number>()", "new Set()");
  return js;
}

const makeFn = (js) =>
  // eslint-disable-next-line no-new-func —— 被测对象就是产品源码本身
  new Function("pass", "layer", `${js}\n;return { texSlots, instTexSlotsOverride };`);

const SLICE = extractSlice(src);
if (!SLICE) {
  check(
    false,
    `必须能在 ${MOUNT} 里定位到 \`${SLICE_START}\` … \`${SLICE_END}\` 这段合并（形状变了就要同步改本判据）`,
  );
}
const JS = SLICE ? toJs(SLICE) : "";
if (SLICE) {
  check(
    !/\bas\b|<number>/.test(JS),
    "类型注解必须剥净（源码若引入新的 TS 语法，`new Function` 会抛错，本判据必须跟着改）",
  );
}

/** 夹具：`pass.textures` 与 `layer.srcObject.instance.textures` */
const run = (fn, matSlots, instSlots, layerOverride) => {
  const layer =
    layerOverride !== undefined ? layerOverride : { srcObject: { instance: { textures: instSlots } } };
  const pass = matSlots === undefined ? undefined : { textures: matSlots };
  return fn(pass, layer);
};

// ─────────────── [A] 真跑源码切片（合成夹具） ───────────────
console.log("\n[A] 材质槽 ← instance.textures 按索引覆盖（真跑 scene-mount.ts 切片）");
if (SLICE) {
  let fn = null;
  try {
    fn = makeFn(JS);
  } catch (e) {
    check(false, `切片必须能被求值（实得语法错误：${String(e && e.message).slice(0, 160)}）`);
  }

  if (fn) {
    // ① 根因夹具：内置 solidlayer 的槽位是空数组，实例名必须补进槽 0 并登记为「已覆盖」
    {
      const r = run(fn, [], ["背景"]);
      check(r.texSlots[0] === "背景", `内置 solidlayer（textures 为空数组）时槽 0 必须取到实例贴图（实得 ${JSON.stringify(r.texSlots)}）`);
      check(r.instTexSlotsOverride.has(0), "被覆盖的槽位必须登记进 instTexSlotsOverride（撤 solid 那一步的输入）");
      check(r.texSlots.length === 1, `覆盖后槽位数不得凭 instance.textures 变长（缺位不补，实得 ${r.texSlots.length}）`);
    }
    // ①' 缺 pass / 缺 textures 键：一律当空槽，不能抛
    {
      let r;
      try {
        r = run(fn, undefined, ["前景"]);
      } catch (e) {
        r = { err: String(e && e.message).slice(0, 80) };
      }
      check(!r.err && r.texSlots[0] === "前景", `没有 pass / textures 键时也必须安全取到实例贴图（实得 ${JSON.stringify(r)}）`);
    }
    // ② util/ 是引擎内置白贴图 = 「纯色填充」，不许覆盖材质原有的真贴图
    {
      const mats = ["材质图"];
      const r = run(fn, mats, ["util/white"]);
      check(r.texSlots[0] === "材质图", `util/ 名字不得覆盖材质槽（写了 util/white 就是纯色语义，实得 ${r.texSlots[0]}）`);
      check(r.instTexSlotsOverride.size === 0, "util/ 名字不得登记成「已覆盖」（否则会平白撤掉 solid 纯色语义）");
    }
    // ②' 全 util/ 的实心层：槽位保持空 ⇒ 继续走 whiteTex × color（与原行为逐字节一致）
    {
      const r = run(fn, [], ["util/white", "util/white"]);
      check(r.texSlots.length === 0 && r.instTexSlotsOverride.size === 0, "全 util/ 的实心层必须保持空槽（纯色块语义不变）");
    }
    // ③ 运行期内部名 _rt_ 同样跳过
    {
      const r = run(fn, [], ["_rt_imageLayerComposite_1_a"]);
      check(r.texSlots.length === 0 && r.instTexSlotsOverride.size === 0, "运行期内部名（_rt_ 前缀）不得当贴图槽覆盖");
    }
    // ④ 非字符串 / 空串 / null 一律跳过，按索引逐个判
    {
      const r = run(fn, ["a"], [null, 123, "", false, {}, "b"]);
      check(r.texSlots[0] === "a" && r.texSlots[5] === "b", `只有非空字符串按索引覆盖（实得 ${JSON.stringify(r.texSlots)}）`);
      check(
        r.instTexSlotsOverride.size === 1 && r.instTexSlotsOverride.has(5),
        `脏值不得登记成覆盖（实得 ${[...r.instTexSlotsOverride].join(",")}）`,
      );
    }
    // ⑤ 缺位不补：instance.textures 里的空位不会顶掉材质后面的槽
    {
      const r = run(fn, ["a", "b", "c"], ["x", null, "z"]);
      check(
        r.texSlots[0] === "x" && r.texSlots[1] === "b" && r.texSlots[2] === "z",
        `按索引覆盖、缺位保留材质原值（实得 ${JSON.stringify(r.texSlots)}）`,
      );
      check(r.instTexSlotsOverride.size === 2, "只登记真正被覆盖的索引");
    }
    // ⑥ instance.textures 比材质槽短：多余的材质槽一个都不许动
    {
      const r = run(fn, ["a", "b", "c"], ["x"]);
      check(r.texSlots.length === 3 && r.texSlots[1] === "b" && r.texSlots[2] === "c", "instance.textures 短于材质槽时必须原样保留其余槽");
    }
    // ⑦ 没有 instance / 空数组：不产覆盖，且不复制数组（传引用回去）
    {
      const mats = ["a"];
      const r = run(fn, mats, undefined);
      check(r.texSlots === mats, "没有 instance.textures 时必须原样返回材质槽（不得多一次拷贝）");
      const r2 = run(fn, mats, []);
      check(r2.texSlots === mats && r2.instTexSlotsOverride.size === 0, "空数组与缺键同义");
      const r3 = run(fn, mats, ["背景"], {});
      check(r3.texSlots === mats && r3.instTexSlotsOverride.size === 0, "layer 没有 srcObject 时必须安全跳过");
      const r4 = run(fn, mats, ["背景"], { srcObject: {} });
      check(r4.texSlots === mats && r4.instTexSlotsOverride.size === 0, "srcObject 没有 instance 时必须安全跳过");
    }
    // ⑧ 不许就地改写材质槽（`matTexSlots.slice()` 的语义）
    {
      const mats = ["a"];
      run(fn, mats, ["x"]);
      check(mats.length === 1 && mats[0] === "a", "覆盖必须发生在副本上（材质槽数组本身不得被就地改写）");
    }
  }
}

// ─────────────── [B] 变异红测 ───────────────
console.log("\n[B] 变异红测（同一片段派生变体，对应夹具必须转红）");
if (SLICE) {
  /** 在剥完注解的 JS 上做文本变异；锚点找不到就响亮失败（源码形状变了） */
  const mutate = (from, to, label) => {
    if (!JS.includes(from)) {
      check(false, `变异「${label}」找不到锚点 \`${from}\`（源码形状变了，本判据要同步改，不许静默跳过）`);
      return null;
    }
    const js = JS.replace(from, to);
    check(js !== JS, `变异「${label}」必须真的改到东西`);
    try {
      return makeFn(js);
    } catch (e) {
      check(false, `变异「${label}」求值失败：${String(e && e.message).slice(0, 120)}`);
      return null;
    }
  };

  const solidSlot = (fn) => run(fn, [], ["背景"]).texSlots[0];
  const utilSlot = (fn) => run(fn, ["材质图"], ["util/white"]).texSlots[0];

  const m1 = mutate('t.startsWith("util/") || ', "", "删掉 util/ 守卫");
  if (m1) {
    check(utilSlot(m1) === "util/white", "删掉 util/ 守卫后，util/white 会覆盖掉材质真贴图 ⇒ [A] 的断言必须有牙");
  }
  const m2 = mutate(SLICE_END, "", "删掉覆盖赋值");
  if (m2) {
    check(solidSlot(m2) === undefined, "删掉 `texSlots = merged` 后，实心层槽 0 取不到实例贴图 ⇒ 白屏回归会被本判据抓住");
  }
  const m3 = mutate("const merged = matTexSlots.slice();", "const merged = matTexSlots;", "删掉副本");
  if (m3) {
    const mats = ["a"];
    run(m3, mats, ["x"]);
    check(mats[0] === "x", "去掉 .slice() 后材质槽被就地改写 ⇒ [A] ⑧ 的断言必须有牙");
  }
}

// ─────────────── [C] 接线锁：撤 solid 那一步 ───────────────
console.log("\n[C] 接线锁（撤 solid 的时机与渲染端「solid 恒赢」的前提）");
{
  const GUARD = "if (si === 0 && !instUtName && !reservedBound) {";
  const REVOKE = "if (instTexSlotsOverride.has(si)) (layer as any).solid = false;";
  check(src.includes(REVOKE), `槽 0 取到真贴图时必须撤 solid（缺 \`${REVOKE}\`）`);
  check(
    src.includes("if (!entry) return;") && src.includes("const reservedBound"),
    "材质/保留名的既有守卫必须仍在（本判据锁定的是「撤 solid 不许挤掉它们」）",
  );
  const gi = src.indexOf(GUARD);
  if (gi < 0) {
    check(false, `找不到槽 0 的守卫 \`${GUARD}\`（源码形状变了，本判据要同步改）`);
  } else {
    // 该守卫块（到紧邻的 `}` 收尾）里必须同时含撤 solid 与计数：说明撤 solid 只在「真的绑上了贴图」时发生
    const block = src.slice(gi, src.indexOf("\n                }", gi) + 20);
    check(block.includes(REVOKE), "撤 solid 必须发生在 `si === 0 && !instUtName && !reservedBound` 这个守卫**之内**（保留名优先级不许被挤掉）");
    check(block.includes("loadedTex++"), "撤 solid 必须与「真贴图绑定成功」同一处（不能提前撤，否则空槽层会退成透明）");
    check(!/^\+?\s*if \(instTexSlotsOverride\.has\(si\)\)[\s\S]{0,80}?layer\.solid = true/m.test(block), "不许出现把实例层重新置回 solid 的写法");
  }

  // 渲染端依据：solid 恒赢（`!layer.solid && layer.textureName`，否则退 whiteTex）
  const ren = fs.readFileSync(join(ROOT, RENDERER), "utf8");
  check(
    /const texObj = !layer\.solid && layer\.textureName/.test(ren),
    `${RENDERER} 必须仍是「solid 恒赢」：\`!layer.solid && layer.textureName\` 才取自己的贴图`,
  );
  check(
    /layer\.solid \? whiteTex : transparentTex/.test(ren),
    `${RENDERER} 的 solid 分支必须仍退到 whiteTex（这正是「只写 textureName 不撤 solid 等于没写」的依据）`,
  );
  // usertextures 的 $ 保留名仍然优先（本次修复不碰这条线）
  check(
    src.includes("pendingInstanceMedia.push({ layer, name: reserved })") ||
      src.includes("pendingInstanceMedia.push"),
    "instance.usertextures 的 $ 保留名迟到绑定必须仍在（本次修复不许动媒体封面优先级）",
  );
}

// ─────────────── [D] 真语料契约（没装库就跳过） ───────────────
if (!fs.existsSync(LIB)) {
  console.log(`\n[D] 跳过语料部分（本机没有壁纸库：${LIB}）`);
} else {
  console.log("\n[D] 真语料契约（按本机素材库复核修复前提）");
  const { parsePkg, getEntry } = await imp("renderer/vendor/we-scene/pkg/container.js");
  const decoder = new TextDecoder();
  const ids = fs.readdirSync(LIB).filter((d) => fs.existsSync(path.join(LIB, d, "scene.pkg")));
  let scanned = 0;
  let layersWithTex = 0;
  let utilOnlyLayers = 0;
  let nonUtilLayers = 0;
  const wpAll = new Set();
  const wpNonUtil = new Set();
  const missTex = [];
  /** util/ 是渲染端内置贴图名（`util/white` = 纯白，纯色填充语义），不属于本修复的覆盖面 */
  const KNOWN_UTIL = new Set(["util/white"]);
  const utilNames = new Map();
  const anchors = [];

  for (const id of ids) {
    let pkg;
    try {
      pkg = parsePkg(new Uint8Array(fs.readFileSync(path.join(LIB, id, "scene.pkg"))));
    } catch {
      continue;
    }
    if (!pkg.entries.find((e) => e.name === "scene.json")) continue;
    let sj;
    try {
      sj = JSON.parse(decoder.decode(getEntry(pkg, "scene.json")).replace(/^\uFEFF/, ""));
    } catch {
      continue;
    }
    scanned++;
    const names = new Set(pkg.entries.map((e) => e.name));
    for (const o of sj.objects || []) {
      const ut = o.instance?.textures;
      if (!Array.isArray(ut) || !ut.filter(Boolean).length) continue;
      layersWithTex++;
      wpAll.add(id);
      for (const t of ut) {
        if (typeof t === "string" && t.startsWith("util/")) utilNames.set(t, (utilNames.get(t) || 0) + 1);
      }
      const real = ut.filter((t) => typeof t === "string" && t && !t.startsWith("util/"));
      if (!real.length) {
        utilOnlyLayers++;
      } else {
        nonUtilLayers++;
        wpNonUtil.add(id);
        for (const t of real) {
          if (!names.has(`materials/${t}.tex`)) missTex.push({ id, oid: o.id, t });
        }
      }
      if (id === "3815761795" && (o.id === 18 || o.id === 307)) {
        anchors.push({ id, oid: o.id, name: o.name, image: o.image, textures: ut, names });
      }
    }
  }

  console.log(
    `  语料：${scanned}/${ids.length} 张可解包；带 instance.textures 的层 ${layersWithTex}（${wpAll.size} 张）` +
      `｜纯 util/ ${utilOnlyLayers}｜含真名 ${nonUtilLayers}（${wpNonUtil.size} 张）` +
      `｜util/ 名 ${[...utilNames].map(([n, c]) => `${n}×${c}`).join(", ") || "无"}`,
  );
  check(layersWithTex > 0, "语料里必须至少存在一层 instance.textures（否则本判据形同虚设）");
  check(nonUtilLayers > 0, "语料里必须至少存在一层带真贴图名的 instance.textures（本修复的适用面）");
  const unknownUtil = [...utilNames.keys()].filter((n) => !KNOWN_UTIL.has(n));
  check(
    unknownUtil.length === 0,
    `util/ 名字只认已知内置白贴图（${[...KNOWN_UTIL].join(", ")}）：实得 ${unknownUtil.join(", ")}` +
      " —— 出现新名字要先确认渲染端认它，再同步改本判据",
  );
  check(
    missTex.length === 0,
    `带真名的 instance.textures 必须逐张能在包内找到 materials/<name>.tex（实得缺 ${missTex.length} 处：` +
      `${missTex.slice(0, 5).map((m) => `${m.id}#${m.oid}=${m.t}`).join(", ")}）`,
  );

  if (!anchors.length) {
    console.log("  （跳过 3815761795 语料锚点：本机没装这张）");
  } else {
    const want = { 18: "背景", 307: "前景" };
    for (const a of anchors) {
      check(
        Array.isArray(a.textures) && a.textures[0] === want[a.oid],
        `3815761795 的 ${a.oid}（${a.name}）instance.textures[0] 必须是 ${want[a.oid]}（实得 ${JSON.stringify(a.textures)}）`,
      );
      check(
        /^models\/solid_instance_model_[0-9a-f]+\.json$/.test(String(a.image || "")),
        `3815761795 的 ${a.oid} 必须仍是实例模型（image = ${a.image}）`,
      );
      const tex = `materials/${want[a.oid]}.tex`;
      check(a.names.has(tex), `3815761795 的 ${want[a.oid]} 贴图必须在包内（缺 ${tex}）`);
      const matPath = "materials/util/solidlayer_instance_4.json";
      check(
        !a.names.has(matPath),
        `3815761795 的实例材质 ${matPath} 必须不在包内（这正是回退内置 solidlayer、槽位落空的成因）`,
      );
    }
  }
}

console.log(
  errors.length === 0
    ? `\nverify-instance-textures: 全部通过 ✓（共 ${asserted} 项断言）`
    : `\nverify-instance-textures: ${errors.length}/${asserted} 项失败 ✗`,
);
process.exit(errors.length === 0 ? 0 : 1);
