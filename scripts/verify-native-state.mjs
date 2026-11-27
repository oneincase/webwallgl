#!/usr/bin/env node
/**
 * verify-native-state —— **渲染状态常量**的对账判据（对账表见
 * `docs/re/we-native-renderstate-constants.md`，即 W2 的产出文档）。
 *
 * 它守四类东西，全部是「常量的字面值/代数式」，不是「行为看起来差不多」：
 *
 *   1. **混合枚举 0–32**：引擎里的 GLSL 混合实现与官方 `common_blending.h` 的逐值对账结论
 *      是「代数等价、例外表 {5,10,30,31,32} 一致、本仓额外排除 0」。这份等价关系靠
 *      「每个 mode 的表达式 + 末尾那一条二次 opacity 加权的例外表」两处共同成立 ——
 *      改动其中任一处（把 mode 5 也套上 mix、把例外表里的 0 拿掉、把 13 的参数对调回来）
 *      都是**画面错但肉眼难查**的回归，这里逐条钉住。
 *   2. **`setBlend` 的 GL 因子**：normal/translucent/additive 三条分支的 blendFunc 参数与
 *      「其余一律 disable(BLEND)」的分支结构。语料 17 处 `alphatocoverage` 正落在 else 分支，
 *      这是文档里判定「仓内双口径不一致」的现场，钉住它能防止无声改动。
 *   3. **RGB 混合的固定管线映射**（`COLOR_BLEND_GL` / `BLEND_PREP`）与三个导出的纯函数
 *      （`colorBlendPlan` / `layerCompositeBlendMode` / `needsShaderBlend`）—— 这几个是
 *      **真跑**的：直接 import 引擎模块调用，覆盖合法值、非 0、缺省、非法字符串四类输入。
 *   4. **FBO 描述符**：`effectFboSize` 的 `scale` 语义（**除数**：scale=4 → 1/4 分辨率）
 *      与 `fit`（长边上限），以及 FBO 颜色附件格式表 `FBO_FORMATS` 的键集合与未知格式回落。
 *
 * 证据边界：本文件**不读**素材库、不读第一方素材的安装目录、不碰外部卷、不联网；断言只依赖本仓源码与
 * 官方 shader 里已经落实进实现的常量（对账过程与原生地址见产出文档）。
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

let failed = 0;
function check(ok, msg) {
  if (ok) console.log(`  ✓ ${msg}`);
  else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}
const trim = (s) => s.replace(/\s+/g, " ").trim();

const {
  COLOR_BLEND_GL,
  BLEND_PREP,
  WE_BLENDING_GLSL,
} = await import(
  new URL("../renderer/vendor/we-scene/render/renderer-glsl.js", import.meta.url).href
);
const rendererMod = await import(
  new URL("../renderer/vendor/we-scene/render/renderer.js", import.meta.url).href
);
const {
  colorBlendPlan,
  layerCompositeBlendMode,
  needsShaderBlend,
  applyColorBlendCPU,
  effectFboSize,
} = rendererMod;

console.log("[1] 混合枚举 0–32：逐值表达式与 opacity 例外表");
{
  const src = WE_BLENDING_GLSL;
  // 取 int 重载的函数体（float 重载只是转调，不参与对账）
  const head = src.indexOf("vec3 ApplyBlending(int mode");
  const tail = src.indexOf("vec3 ApplyBlending(float mode");
  check(head >= 0 && tail > head, "存在 int 重载 ApplyBlending(int mode, vec3 A, vec3 B, float opacity) 与 float 重载");
  const body = src.slice(head, tail);
  // 每条语句去掉行尾注释再折叠空白：注释属于文档面，不该参与代数比较
  const flat = trim(
    body
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, ""))
      .join(" ")
  );

  const modes = new Set([...body.matchAll(/mode == (\d+)/g)].map((m) => Number(m[1])));
  const missing = [];
  for (let i = 1; i <= 32; i++) if (!modes.has(i)) missing.push(i);
  check(missing.length === 0, `mode 1..32 全部有分支（缺 ${missing.join(",") || "无"}）`);
  check(!modes.has(0), "mode 0 不写分支（走 else 的 mix(A,B,opacity)）");

  const algebra = [
    ["1 Darken", "if (mode == 1) { r = min(B, A); }"],
    ["2 Multiply", "else if (mode == 2) { r = A * B; }"],
    ["4/20 Substract", "else if (mode == 4 || mode == 20) { r = max(A + B - 1.0, vec3(0.0)); }"],
    ["5 官方裸 min", "else if (mode == 5) { r = min(A, B); }"],
    ["6 Lighten", "else if (mode == 6) { r = max(B, A); }"],
    ["7 Screen", "else if (mode == 7) { r = 1.0 - (1.0 - A) * (1.0 - B); }"],
    ["9 Add", "else if (mode == 9) { r = min(A + B, vec3(1.0)); }"],
    ["10 官方裸 max", "else if (mode == 10) { r = max(A, B); }"],
    ["11 Overlay", "else if (mode == 11) { r = weBlendOverlay(A, B); }"],
    ["13 HardLight（参数对调）", "else if (mode == 13) { r = weBlendOverlay(B, A); }"],
    ["18 Difference", "else if (mode == 18) { r = abs(A - B); }"],
    ["19 Exclusion", "else if (mode == 19) { r = A + B - 2.0 * A * B; }"],
    ["22 Glow = Reflect(B,A)", "else if (mode == 22) { r = weBlendReflect(B, A); }"],
    ["23 Phoenix", "else if (mode == 23) { r = min(A, B) - max(A, B) + 1.0; }"],
    ["24 Average", "else if (mode == 24) { r = (A + B) / 2.0; }"],
    ["25 Negation", "else if (mode == 25) { r = 1.0 - abs(1.0 - A - B); }"],
    ["31 自带 opacity", "else if (mode == 31) { r = A + B * opacity; }"],
    ["32 自带 mix", "else if (mode == 32) { r = mix(A, A + A * B, opacity); }"],
    ["default Normal", "else { r = mix(A, B, opacity); }"],
  ];
  for (const [name, needle] of algebra) check(flat.includes(trim(needle)), `mode ${name} 的表达式未变`);

  // 例外表：官方 {5,10,30,31,32}；本仓多排 0（mode 0 分支已自带 mix，再套一层 = opacity²）
  check(
    flat.includes(
      "if (mode != 0 && mode != 5 && mode != 10 && mode != 30 && mode != 31 && mode != 32) { r = mix(A, r, opacity); }"
    ),
    "二次 opacity 加权的例外表 = {0,5,10,30,31,32}（0 是必需的多排项）"
  );

  // 注释标签：官方 mode 5 是裸 min、10 是裸 max、32 是自带 mix 的表达式，三者在
  // `common_blending.h` 里**都没有函数名**；早期把 5 标成 LinearBurn（那是 4/20 的式子）、
  // 32 标成 LinearDodge 变体（LinearDodge 是 min(A+B,1)）、10 标成 Lighter（非官方名）。
  const lineOf = (mode) =>
    body.split("\n").find((l) => new RegExp(`mode == ${mode}\\)`).test(l)) || "";
  const l5 = lineOf(5);
  const l10 = lineOf(10);
  const l32 = lineOf(32);
  check(/裸 min/.test(l5) && /无名/.test(l5), "mode 5 注明「裸 min(A,B)」且官方无名");
  check(!/\/\/\s*LinearBurn/.test(l5), "mode 5 不再被当作 LinearBurn（LinearBurn 是 4/20 的式子）");
  check(/裸 max/.test(l10) && /无名/.test(l10), "mode 10 注明「裸 max(A,B)」且官方无名");
  check(/无名/.test(l32) && !/变体/.test(l32), "mode 32 注明官方无名，不再写成 LinearDodge 变体");
  check(!/LighterColor/.test(body), "注释不再声称 32 = LighterColor");
}

console.log("[2] setBlend：三条分支的 GL 因子（语料 alphatocoverage 落 else 分支）");
{
  const src = read("renderer/vendor/we-scene/render/renderer.js");
  const i = src.indexOf("function setBlend(mode)");
  check(i > 0, "render/renderer.js 里存在 function setBlend(mode)");
  const body = trim(src.slice(i, src.indexOf("\n  }", i)));
  check(
    body.includes("if (mode === 'translucent') { gl.enable(gl.BLEND) gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA) }"),
    "translucent = blendFuncSeparate(SRC_ALPHA, ONE_MINUS_SRC_ALPHA, ONE, ONE_MINUS_SRC_ALPHA)"
  );
  check(
    body.includes("else if (mode === 'additive') { gl.enable(gl.BLEND) gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.ONE, gl.ONE) }"),
    "additive = blendFuncSeparate(SRC_ALPHA, ONE, ONE, ONE)"
  );
  check(
    body.includes("else { gl.disable(gl.BLEND) }"),
    "其余（normal/未知/alphatocoverage）= disable(BLEND)"
  );
  // 效果 pass 路径对 alphatocoverage 的当口（文档 §2.2 的现场之一）
  check(
    src.includes("const blendMode = mp.blending || 'normal'") && src.includes("setBlend(blendMode)"),
    "效果 pass 路径以 mp.blending 直接喂 setBlend（alphatocoverage 因此当 normal）"
  );
  // [2026-11-27] 清屏条件已抽成纯函数 effectPassNeedsClear（原先是内联的单行判断）。
  // 语义不变，另加一档：LOAD 语义的 pass 首次写 ping-pong 的 pong 时也必须清 ——
  // 否则它叠的是上一帧残留，单 pass + additive 会逐帧累积到纯白（见 verify-fx-chain-clear）。
  check(
    src.includes("const needClear = effectPassNeedsClear(") &&
      src.includes("gl.clear(gl.COLOR_BUFFER_BIT)") &&
      !src.includes("if (!mp.target && blendMode !== 'translucent' && blendMode !== 'additive') {"),
    "覆盖写 pass 的「先清透明」由 effectPassNeedsClear 判定（内联旧写法已移除）"
  );
  check(
    src.includes("outFBO === fboB,") && src.includes("!pongWritten,"),
    "effectPassNeedsClear 必须收到「目标是 pong」与「本帧首次」两档实参"
  );
}

console.log("[3] 固定管线混合映射与三个导出纯函数（真跑）");
{
  const want = { 2: "multiply", 6: "additive", 7: "screen", 9: "additive", 31: "additive" };
  check(
    Object.keys(COLOR_BLEND_GL).length === 5 && Object.entries(want).every(([k, v]) => COLOR_BLEND_GL[k] === v),
    "COLOR_BLEND_GL 恰为 {2:multiply, 6:additive, 7:screen, 9:additive, 31:additive}"
  );
  check(BLEND_PREP.screen === 1 && BLEND_PREP.multiply === 2, "BLEND_PREP = {screen:1, multiply:2}");

  check(colorBlendPlan(2).mode === "multiply" && colorBlendPlan(2).prep === 2, "colorBlendPlan(2) = multiply + prep 2");
  check(colorBlendPlan(7).mode === "screen" && colorBlendPlan(7).prep === 1, "colorBlendPlan(7) = screen + prep 1");
  check(colorBlendPlan(9).mode === "additive" && colorBlendPlan(9).prep === 0, "colorBlendPlan(9) = additive + prep 0");
  for (const m of [0, 3, 16, 26, 999, "x", null, undefined]) {
    const p = colorBlendPlan(m);
    check(p.mode === "translucent" && p.prep === 0, `colorBlendPlan(${String(m)}) 回落 translucent（不可固定管线表达）`);
  }
  check(colorBlendPlan("7").mode === "screen", "colorBlendPlan 接受字符串编号（scene.json 里常见）");

  check(needsShaderBlend(3) === true && needsShaderBlend(16) === true && needsShaderBlend(0) === false, "needsShaderBlend：3/16 需回读背景，0 不需要");
  check([2, 6, 7, 9, 31].every((m) => needsShaderBlend(m) === false), "needsShaderBlend：固定管线可表达的 5 个编号都不回读");
  check(needsShaderBlend(undefined) === false && needsShaderBlend("x") === false, "needsShaderBlend：非法输入回落 false");

  check(layerCompositeBlendMode(0, "additive") === 9, "layerCompositeBlendMode(0, additive) = 9（基色材质 additive 的发光层）");
  check(layerCompositeBlendMode(3, "additive") === 3, "layerCompositeBlendMode：对象自带非 0 模式优先于材质 blending");
  check(layerCompositeBlendMode(0, "translucent") === 0 && layerCompositeBlendMode(0, null) === 0, "layerCompositeBlendMode：无 additive 材质时保持 0");

  // applyColorBlendCPU 是 GPU 路径的 CPU 参考：逐模式代数恒等式
  const close = (a, b) => Math.abs(a - b) < 1e-9;
  const A = 0.25, B = 0.6, O = 0.5;
  const cpu = (m) => applyColorBlendCPU(m, A, B, O);
  check(close(cpu(2), A * (1 - O + B * O)), "CPU 参考 mode 2 = DST_COLOR 混合（prep 2）");
  check(close(cpu(7), B * O + A * (1 - B * O)), "CPU 参考 mode 7 = screen（prep 1）");
  check(close(cpu(6), A + B * O), "CPU 参考 mode 6 = additive");
  check(close(cpu(9), A + B * O), "CPU 参考 mode 9 = Add");
  check(close(cpu(31), A + B * O), "CPU 参考 mode 31 = A + B*opacity");
  check(close(cpu(0), A * (1 - O) + B * O), "CPU 参考 mode 0 = translucent");
  // 非线性模式走 shader 侧参考（needsShaderBlend=true），与官方 ColorBurn 一致
  check(close(cpu(3), A * (1 - O) + Math.max(1 - (1 - A) / B, 0) * O), "CPU 参考 mode 3 = mix(A, ColorBurn(A,B), opacity)");
}

console.log("[4] FBO 描述符：scale 是除数、fit 是长边上限");
{
  check(
    JSON.stringify(effectFboSize(undefined, 1920, 1080)) === JSON.stringify([1920, 1080]),
    "缺省（无 fbos[] 条目）= 全分辨率"
  );
  check(JSON.stringify(effectFboSize({ scale: 2 }, 1920, 1080)) === JSON.stringify([960, 540]), "scale=2 → 1/2 分辨率");
  check(JSON.stringify(effectFboSize({ scale: 4 }, 1920, 1080)) === JSON.stringify([480, 270]), "scale=4 → 1/4 分辨率（_rt_QuarterBuffer）");
  check(JSON.stringify(effectFboSize({ scale: "0.5" }, 100, 100)) === JSON.stringify([200, 200]), "scale 是除数：0.5 → 2 倍分辨率");
  check(JSON.stringify(effectFboSize({ scale: 0 }, 1920, 1080)) === JSON.stringify([1920, 1080]), "scale=0 视为缺省（Number(0)||1）");
  check(
    JSON.stringify(effectFboSize({ scale: 4, fit: 512 }, 3840, 2160)) === JSON.stringify([512, 288]),
    "fit=512：_rt_EightBuffer 的 512 长边（3840×2160 → 512×288）"
  );
  check(
    JSON.stringify(effectFboSize({ fit: 512 }, 100, 100)) === JSON.stringify([100, 100]),
    "fit 只做上限：原本不超长边就不缩放"
  );
  check(effectFboSize({ scale: 100 }, 10, 10)[0] === 1, "极小尺寸钳到 1（不产生 0 尺寸附件）");
}

console.log("[5] FBO 颜色附件格式表：键集合与未知格式回落");
{
  const src = read("renderer/vendor/we-scene/render/renderer.js");
  const i = src.indexOf("const FBO_FORMATS = {");
  check(i > 0, "render/renderer.js 里存在 FBO_FORMATS 颜色附件格式表");
  const body = trim(src.slice(i, src.indexOf("\n  }", i)));
  for (const k of ["rgba8888", "rgba_backbuffer", "rgba161616f", "r16f", "rg1616f"]) {
    check(body.includes(`${k}: {`), `FBO_FORMATS 支持 ${k}`);
  }
  check(
    body.includes("rgba8888: { ifmt: gl.RGBA8, fmt: gl.RGBA, type: gl.UNSIGNED_BYTE }") &&
      body.includes("r16f: { ifmt: gl.R16F, fmt: gl.RED, type: gl.HALF_FLOAT }") &&
      body.includes("rg1616f: { ifmt: gl.RG16F, fmt: gl.RG, type: gl.HALF_FLOAT }") &&
      body.includes("rgba161616f: { ifmt: gl.RGBA16F, fmt: gl.RGBA, type: gl.HALF_FLOAT }"),
    "四个内部格式的内/外格式与类型未被改动"
  );
  check(
    src.includes("const fkey = formatName && FBO_FORMATS[formatName] ? formatName : 'rgba8888'"),
    "未知 format 回落 rgba8888（而不是抛错，也不是开默认尺寸）"
  );
}

console.log("[6] 自证离线：不读素材库、不引入非 node: 依赖");
{
  const self = read("scripts/verify-native-state.mjs");
  const banned = [
    ["WE_" + "LIBRARY", "素材库环境变量"],
    ["read" + "ItemFile", "素材库读取工具"],
    ["read" + "ProjectJson", "素材库读取工具"],
    ["steam" + "apps", "Steam 安装目录"],
    ["Application" + " Support", "用户数据目录"],
    ["/Vol" + "umes/", "外部卷"],
    ["rea-" + "agents", "原生分析工具调用"],
  ];
  for (const [needle, what] of banned) check(!self.includes(needle), `本判据不出现 ${what}`);
  const specifiers = [...self.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
  const urlish = [...self.matchAll(/import\(\s*\n?\s*new URL\("([^"]+)"/g)].map((m) => m[1]);
  const all = [...specifiers, ...urlish];
  check(all.length >= 3, `静态/动态 import 共 ${all.length} 处，全部参与白名单检查`);
  check(
    all.every((s) => s.startsWith("node:") || s.startsWith(".") || s.startsWith("../")),
    "import 只允许 node: 与仓内相对路径"
  );
}

console.log("");
if (failed) {
  console.error(`verify-native-state: ${failed} 条失败 ✗`);
  process.exit(1);
}
console.log("verify-native-state: 全部通过 ✓");
