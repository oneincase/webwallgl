#!/usr/bin/env node
/**
 * verify-resolution —— effectiveDpr 的渲染分辨率语义（2026-09 修 3.5K/Retina
 * 「高清模式也不到原生」）。
 *
 * 旧实现 min(devicePixelRatio, renderDpr)、renderDpr 默认 1：任何 HiDPI 屏默认
 * 只渲染逻辑像素（Retina 上物理面积 1/4）；宿主 WKWebView 若把 devicePixelRatio
 * 报成 1，高清模式选再高也被 min 钉死。新语义：
 *   - renderDpr 0/缺省 = 自动跟随设备 DPR；
 *   - 正数 = 目标 DPR，允许高于设备上报值（宿主误报 1 时仍可超采样到原生）；
 *   - 物理最长边封顶 4096，超出等比回收。
 *
 * shell.ts 是 TS，经 esbuild bundle 后在 Node 直行；window 用桩注入。
 */
import { build } from "esbuild";
import fs from "node:fs";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = join(fileURLToPath(import.meta.url), "..");
const ROOT = join(here, "..");

let failed = 0;
function check(ok, msg) {
  if (ok) console.log(`  ✓ ${msg}`);
  else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

async function loadEffectiveDpr() {
  const out = await build({
    entryPoints: [join(ROOT, "renderer/src/shell.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    // shell.ts 只用到 window/Document 的几个字段，platform neutral 下 import.meta 无影响
    external: [],
  });
  const tmp = join(ROOT, "scripts", `.tmp-resolution-${process.pid}.mjs`);
  fs.writeFileSync(tmp, out.outputFiles[0].text);
  try {
    return await import(pathToFileURL(tmp).href);
  } finally {
    fs.unlinkSync(tmp);
  }
}

// window 桩：bundle 顶层会碰 window.addEventListener，必须在 import 前就位。
function makeWindow(dpr, w, h) {
  return {
    devicePixelRatio: dpr,
    innerWidth: w,
    innerHeight: h,
    document: { addEventListener() {}, removeEventListener() {}, fonts: { ready: Promise.resolve(), forEach() {} } },
    addEventListener() {},
    removeEventListener() {},
    localStorage: undefined,
  };
}
globalThis.window ??= makeWindow(2, 1728, 1117);
globalThis.document ??= globalThis.window.document;
globalThis.performance ??= { now: () => 0 };
globalThis.requestAnimationFrame ??= () => 0;
globalThis.cancelAnimationFrame ??= () => {};

const mod = await loadEffectiveDpr();
const effectiveDpr = mod.effectiveDpr;
const rt = { cfg: {} };
// effectiveDpr(rt, cfg) 的第二参直接是 WallpaperConfig（renderDpr 在顶层）
const withCfg = (renderDpr) => ({ renderDpr });

function env(dpr, w, h) {
  const saved = globalThis.window;
  globalThis.window = makeWindow(dpr, w, h);
  return () => {
    globalThis.window = saved;
  };
}

// 1) 自动（0 / undefined / null / NaN）跟随设备 DPR
{
  const restore = env(2, 1728, 1117); // 3.5K Mac looks-like
  try {
    check(near(effectiveDpr(rt, { cfg: { renderDpr: 0 } }), 2), "renderDpr=0 自动跟随设备 DPR=2");
    check(near(effectiveDpr(rt, {}), 2), "缺省 renderDpr 自动跟随设备 DPR");
    check(near(effectiveDpr(rt, withCfg(undefined)), 2), "undefined 自动");
  } finally {
    restore();
  }
}

// 2) 显式正数 = 目标 DPR，允许超过设备上报值。
//    宿主 Retina 合成但 JS 误报 devicePixelRatio=1（WKWebView 常见）：CSS 逻辑点
//    1728、物理 3456，旧 min(1,2) 恒为 1 → backing 只有逻辑宽，糊；现按目标 2
//    超采样到 3456（< 4096 不被 cap）。
{
  const restore = env(1, 1728, 1117);
  try {
    check(near(effectiveDpr(rt, withCfg(2)), 2), "设备误报 1 时目标 2 仍超采样到 2（不被 min 钉死）");
    check(near(effectiveDpr(rt, withCfg(1)), 1), "目标 1 即 1");
  } finally {
    restore();
  }
}
// 2b) 非 Retina 后端（CSS 点=物理像素，innerWidth 已是物理宽）：目标 1 即原生，
//     无需也不应被拉到 2（4096 cap 自然把过大目标收回到合理值）。
{
  const restore = env(1, 3456, 2234);
  try {
    check(near(effectiveDpr(rt, withCfg(1)), 1), "非 Retina 后端 DPR1 即原生");
  } finally {
    restore();
  }
}

// 3) 物理最长边封顶 4096：超大 CSS 窗口 × 高 DPR 等比回收
{
  // 4096px 宽的逻辑窗口 × DPR 2 = 8192 backing → cap 收到 1.0
  const restore = env(2, 4096, 1000);
  try {
    const d = effectiveDpr(rt, withCfg(2));
    check(near(d, 1), `4096 CSS 宽 × DPR2 被 4096 backing 封顶收到 1（实得 ${d}）`);
  } finally {
    restore();
  }
  // 3000 宽 × DPR2 = 6000 → cap 4096/3000 = 1.3653
  const restore2 = env(2, 3000, 1500);
  try {
    const d = effectiveDpr(rt, withCfg(2));
    check(near(d, 4096 / 3000), `3000 宽 ×2 等比收至 ${(4096 / 3000).toFixed(3)}（实得 ${d.toFixed(3)}）`);
  } finally {
    restore2();
  }
}

// 4) 常规笔记本/Retina 不被封顶误伤
{
  const restore = env(2, 1728, 1117); // backing 最长边 2234，远低于 4096
  try {
    check(near(effectiveDpr(rt, withCfg(2)), 2), "Retina 1728 CSS 宽正常拿到 DPR 2");
  } finally {
    restore();
  }
}

// 5) 下限保护：异常小目标不低于 0.25
{
  const restore = env(2, 100, 100);
  try {
    check(effectiveDpr(rt, withCfg(0.01)) >= 0.25, "异常小 renderDpr 收到 0.25 下限");
  } finally {
    restore();
  }
}

// 6) 接线断言：各入口默认改为 0（自动），不再默认 1
{
  const mountSrc = fs.readFileSync(join(ROOT, "renderer/src/api/mount.ts"), "utf8");
  check(/renderDpr: o\.renderDpr \?\? 0/.test(mountSrc), "公共 API mount 默认 renderDpr=0（自动）");
  const shellSrc = fs.readFileSync(join(ROOT, "renderer/src/shell.ts"), "utf8");
  check(/MAX_BACKING_EDGE = 4096/.test(shellSrc), "shell.ts 有 4096 backing 封顶");
  check(!/Math\.min\(window\.devicePixelRatio[^)]*,\s*cap\)/.test(shellSrc), "旧的 min(设备DPR, cap) 硬钉已移除");
}

if (failed) {
  console.error(`\nverify-resolution: ${failed} 处失败`);
  process.exit(1);
}
console.log("\nverify-resolution: all checks passed");
