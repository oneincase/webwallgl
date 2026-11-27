#!/usr/bin/env node
/**
 * verify-fx-chain-clear —— 效果链「首个 pass 写 ping-pong 目标前必须清屏」的判据。
 *
 * 症状（作者侧）：某张单 pass + additive 的工坊壁纸，在浏览器里跑几十秒后右侧
 * 慢慢变成**蒙版形状的纯白块**，而同一张壁纸在桌面 Wallpaper Engine 里完全正常。
 *
 * 根因：乒乓缓冲 fboB（tag 字面量 'pong'）没有清理点，而 `getFBO` 的缓存键是
 * `tag|WxH|format`（**不含 layer.id**），命中即原样复用 —— 于是 fboB 带着上一帧
 * 的内容跨帧存活。效果 pass 里 translucent/additive 走 LOAD 语义（保留目标）故不清，
 * 这对链中间的 pass 是对的，但对**链的第一个 pass** 是错的：它的叠加对象是上一帧
 * 残留。r8 贴图经 fromR8 解出 alpha≡1 ⇒ SRC_ALPHA 恒 1 ⇒ 每帧满量叠加 ⇒ 饱和成白。
 *
 * 判据三层：
 *   §A 纯函数行：effectPassNeedsClear() 的真值表（含本次修的那一档）
 *   §B 接线断言：renderer.js 里首个 pass 判定必须走它、且 pongWritten 按帧重置
 *   §C 变异红测：把修好的那一档改回去，§B 必须转红
 *
 * 用法：node scripts/verify-fx-chain-clear.mjs
 * 退出码非 0 表示发现问题。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, createChecker } from "./lib/verify-kit.mjs";

const { check, errors } = createChecker();

// ---------------------------------------------------------------- §A 纯函数行
console.log("verify-fx-chain-clear: [A] effectPassNeedsClear 真值表");
const modPath = path.join(ROOT, "renderer/vendor/we-scene/render/renderer.js");
let fx = null;
try {
  // renderer.js 是原生 ESM（带显式 .js 后缀），Node 与浏览器同一条加载路径。
  fx = await import(pathToFileURL(modPath).href);
} catch (e) {
  check(false, `[A] 无法加载 renderer.js：${String(e && e.message).split("\n")[0]}`);
}
if (fx) {
  check(
    typeof fx.effectPassNeedsClear === "function",
    "[A] renderer.js 必须导出 effectPassNeedsClear（判据的牙签）",
  );
}
if (fx && typeof fx.effectPassNeedsClear === "function") {
  const f = fx.effectPassNeedsClear;

  // 普通/normal 等「覆盖写」模式：一律清（3486806915 白楔的来源）
  check(f(false, "normal", false, false) === true, "[A] normal + 非 pong → 必须清");
  check(f(false, "normal", true, false) === true, "[A] normal + 首次 pong → 必须清");
  check(f(false, "normal", true, true) === true, "[A] normal + 非首次 pong → 仍必须清");
  check(f(false, undefined, false, false) === true, "[A] blending 缺省（normal 语义）→ 必须清");
  check(f(false, "multiply", false, false) === true, "[A] multiply 走 else 分支（关混合）→ 必须清");

  // translucent / additive 是 LOAD 语义：链中间不清
  check(f(false, "translucent", false, false) === false, "[A] translucent + 非 pong → 不清（LOAD）");
  check(f(false, "additive", false, false) === false, "[A] additive + 非 pong → 不清（LOAD）");
  // 第 4 参 = firstPongWrite（即 !pongWritten）：false 表示本帧已经写过 pong → LOAD
  check(
    f(false, "translucent", true, false) === false,
    "[A] translucent + pong 本帧已写过 → 不清（LOAD 语义成立）",
  );
  check(
    f(false, "additive", true, false) === false,
    "[A] additive + pong 本帧已写过 → 不清（LOAD 语义成立）",
  );

  // ★本次修的档：LOAD 语义的 pass 若写到本帧还没写过的 fboB，必须先清
  check(
    f(false, "additive", true, true) === true,
    "[A] additive + **首次** 写 pong → 必须清（修的就是这一档：否则叠到上一帧残留）",
  );
  check(
    f(false, "translucent", true, true) === true,
    "[A] translucent + 首次写 pong → 必须清（同一类累积）",
  );

  // 带 mp.target 的 pass（序列表写 _rt_*）目标是私有 FBO，不走乒乓，永不清
  for (const b of ["normal", "translucent", "additive", undefined]) {
    check(
      f(true, b, true, false) === false &&
        f(true, b, true, true) === false &&
        f(true, b, false, false) === false,
      `[A] hasTarget=true（blending=${String(b)}）→ 永不清（私有 _rt_ 缓冲要保留历史）`,
    );
  }

  // 幂等/无副作用：同参数反复调用结果恒定
  const seq = [
    f(false, "additive", true, true),
    f(false, "additive", true, true),
    f(false, "additive", true, true),
  ];
  check(seq.every((v) => v === true), "[A] 纯函数：同参数反复调用结果必须恒定");
}

// ---------------------------------------------------------------- §B 接线断言
console.log("verify-fx-chain-clear: [B] renderer.js 接线");
const raw = fs.readFileSync(modPath, "utf8");

check(
  /const needClear = effectPassNeedsClear\(/.test(raw),
  "[B] 效果 pass 主循环必须调 effectPassNeedsClear 决定清不清",
);
check(
  /let pongWritten = false/.test(raw),
  "[B] 必须有 pongWritten 标志（每层每帧重置，表示 fboB 本帧已写过）",
);
// 标志必须在「效果链开始处」声明（每层执行一次 renderLayer）而不是模块级 ——
// 判据用两个锚点夹住：起点 `let curInput = fboA`、终点 `const effectFBOs = new Map()`。
const chainIdx = raw.indexOf("let curInput = fboA");
const declIdx = raw.indexOf("let pongWritten = false");
const fboMapIdx = raw.indexOf("const effectFBOs = new Map()");
check(
  chainIdx >= 0 && declIdx > chainIdx && fboMapIdx > declIdx,
  `[B] pongWritten 必须声明在效果链起点之后、effectFBOs 之前（curInput=${chainIdx} pong=${declIdx} effectFBOs=${fboMapIdx}）`,
);
// 如果写成了模块级（没有 let），上面那条 indexOf 会指向 .js 里那句赋值而非声明
check(
  /^[ \t]*let pongWritten = false[ \t]*(?:\/\/.*)?$/m.test(raw),
  "[B] pongWritten 必须是 `let` 局部声明（模块级会跨层/跨帧串味）",
);
// 标记时机必须在 clear 之前/同时，且只看 !mp.target（私有 target 不算写乒乓）
check(
  /if \(!mp\.target && outFBO === fboB\) pongWritten = true/.test(raw),
  "[B] 写 fboB 后必须置 pongWritten（仅 !mp.target 时）",
);
check(
  raw.indexOf("if (!mp.target && outFBO === fboB) pongWritten = true") <
    raw.indexOf("if (needClear)"),
  "[B] 置位的语句必须在 needClear 分支**之前**（先记账再决定，否则首个 pass 看不到 false）",
);
// fboB 仍是那两个字面 tag（若有人改成带 layer.id，这个 fix 的前提就变了，应重新评估）
check(
  /getFBO\(chainW, chainH, 'pong'\)/.test(raw),
  "[B] fboB 仍按字面 'pong' 共享缓存 —— 若改为带 layer.id，请同步更新本判据与注释",
);
// 防复活：旧的「只排除两种模式」单行写法不得残留（除了纯函数里那份）
const oldInline = raw.match(/if \(!mp\.target && blendMode !== 'translucent' && blendMode !== 'additive'\) \{/g) || [];
check(
  oldInline.length === 0,
  `[B] 旧的内联清屏条件必须已被 effectPassNeedsClear 取代（残留 ${oldInline.length} 处）`,
);

// ---------------------------------------------------------------- §C 变异红测
console.log("verify-fx-chain-clear: [C] 变异红测（改回去必须转红）");
function assertWiring(src, sink, label = "[B]") {
  sink(/const needClear = effectPassNeedsClear\(/.test(src), `${label} 主循环必须调 effectPassNeedsClear`);
  sink(/let pongWritten = false/.test(src), `${label} 必须有 pongWritten`);
  sink(
    /if \(!mp\.target && outFBO === fboB\) pongWritten = true/.test(src),
    `${label} 必须置位 pongWritten`,
  );
  // 关键实参：目标是不是 pong（第三参）与是不是本帧首次（第四参）。
  // 少任何一个，修好的那一档就漏了 —— 这两个参数是判据的牙。
  sink(
    /effectPassNeedsClear\(\s*!!mp\.target,\s*blendMode,\s*outFBO === fboB,\s*!pongWritten,?\s*\)/.test(src),
    `${label} effectPassNeedsClear 必须传 (!!mp.target, blendMode, outFBO === fboB, !pongWritten)`,
  );
  const di = src.indexOf("let pongWritten = false");
  const ci = src.indexOf("let curInput = fboA");
  const fi = src.indexOf("const effectFBOs = new Map()");
  sink(
    di > ci && fi > di,
    `${label} pongWritten 声明必须夹在效果链起点与 effectFBOs 之间`,
  );
  sink(
    src.indexOf("if (!mp.target && outFBO === fboB) pongWritten = true") < src.indexOf("if (needClear)"),
    `${label} 置位必须在 needClear 之前`,
  );
}

const muts = [
  {
    name: "退回旧的「只排除 translucent/additive」单行条件",
    apply: (x) =>
      x.replace(
        /const needClear = effectPassNeedsClear\([\s\S]*?\r?\n[ \t]*if \(needClear\) \{/,
        "if (!mp.target && blendMode !== 'translucent' && blendMode !== 'additive') {",
      ),
  },
  {
    name: "不记 pongWritten（每帧都当首次，链中间全被清）",
    apply: (x) => x.replace(/[ \t]*if \(!mp\.target && outFBO === fboB\) pongWritten = true\r?\n/, ""),
  },
  {
    name: "pongWritten 提成模块级（跨层串味）",
    apply: (x) => x.replace(/^([ \t]*)let pongWritten = false/m, "$1pongWritten = false"),
  },
  {
    name: "第三参写死 false（漏掉 pong 这一档）",
    apply: (x) =>
      x.replace(
        /effectPassNeedsClear\(\s*!!mp\.target,\s*blendMode,\s*outFBO === fboB,\s*!pongWritten,?\s*\)/,
        "effectPassNeedsClear(!!mp.target, blendMode, false, !pongWritten)",
      ),
  },
  {
    name: "第四参写死 true（每帧都当首次）",
    apply: (x) =>
      x.replace(
        /effectPassNeedsClear\(\s*!!mp\.target,\s*blendMode,\s*outFBO === fboB,\s*!pongWritten,?\s*\)/,
        "effectPassNeedsClear(!!mp.target, blendMode, outFBO === fboB, true)",
      ),
  },
];
for (const m of muts) {
  const mutated = m.apply(raw);
  if (mutated === raw) {
    check(false, `[C] 变异「${m.name}」没有命中源码（判据失去牙签）`);
    continue;
  }
  const reds = [];
  assertWiring(mutated, (cond, msg) => { if (!cond) reds.push(msg); }, `[C:${m.name}]`);
  check(reds.length > 0, `[C] 变异「${m.name}」必须让对应断言转红`);
}

// ---------------------------------------------------------------- 收尾
if (errors.length) {
  console.error(`verify-fx-chain-clear: ${errors.length} 项失败`);
  for (const e of errors) console.error("  ✗", e);
  process.exit(1);
}
console.log("verify-fx-chain-clear: ok");
