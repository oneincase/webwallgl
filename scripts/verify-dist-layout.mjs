#!/usr/bin/env node
/**
 * verify-dist-layout —— 守住 dist/ 的**归属边界**：站点构建只能动站点自己的产物，
 * 不许碰 `dist/lib`。
 *
 * 为什么值得一条独立校验：`dist/lib` 是宿主项目 WallpaperEM 的 file: 依赖
 * （`file:../webwallgl-github/dist/lib`）。站点构建（vite.config.ts，outDir 就是 dist/）
 * 一旦清空整个 dist/，宿主那边**每一条 pnpm 命令**都会停在
 * `ENOENT: ... scandir '.../webwallgl-github/dist/lib'`，而且报错里看不出跟本仓有关
 * —— 2026-10-01 实际踩到，排查了半天。这条断言就是把那次事故钉死。
 *
 * 做法：往 dist/lib 与 dist/ 各放一个探针，真跑一次站点构建，然后断言
 *   ① dist/lib 连同探针原样还在（站点构建不许碰库产物）
 *   ② 站点自己的旧产物被清干净（dist/ 根与 dist/assets/ 里的探针必须消失）
 *   ③ 站点产物确实重建（dist/index.html 在）—— ②③ 合起来排除「干脆不清 / 不构建」
 * 只跑站点构建：库构建（build:lib）只写 dist/lib，它自己的 emptyOutDir 也只清 lib 内部，
 * 天然不越界，不需要在这里重复验证。
 *
 * 探针是本脚本唯一的副作用，跑完即删；dist/lib 本来不存在的话，跑完恢复成不存在
 * （免得留一个空库目录让宿主的 pnpm 以为链接到位了）。
 *
 * 用法：node scripts/verify-dist-layout.mjs
 * 退出码：0 通过 / 1 失败
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..");
const DIST = path.join(ROOT, "dist");
const LIB = path.join(DIST, "lib");

const PROBE = "__verify-dist-layout.probe";
const LIB_PROBE = path.join(LIB, PROBE);
const ROOT_PROBE = path.join(DIST, PROBE);
const ASSETS_PROBE = path.join(DIST, "assets", PROBE);

const fails = [];
const check = (ok, msg) => {
  console.log(`  ${ok ? "✓" : "✗"} ${msg}`);
  if (!ok) fails.push(msg);
};

const hadLib = fs.existsSync(LIB);
console.log(`dist 布局校验　root=${ROOT}${hadLib ? "" : "（当前没有 dist/lib）"}`);

// 探针：库目录一处（必须活下来），站点自己两处（必须被清掉）
fs.mkdirSync(LIB, { recursive: true });
fs.mkdirSync(path.dirname(ASSETS_PROBE), { recursive: true });
for (const p of [LIB_PROBE, ROOT_PROBE, ASSETS_PROBE]) fs.writeFileSync(p, "probe\n");

let buildError = null;
try {
  const { build } = await import("vite");
  await build({ root: ROOT, logLevel: "warn" });
} catch (e) {
  buildError = e;
}

// 先把观察结果取下来，再收尾（构建抛错时探针也要清掉，不留垃圾）
const observed = {
  libProbe: fs.existsSync(LIB_PROBE),
  rootProbe: fs.existsSync(ROOT_PROBE),
  assetsProbe: fs.existsSync(ASSETS_PROBE),
  index: fs.existsSync(path.join(DIST, "index.html")),
};
fs.rmSync(LIB_PROBE, { force: true });
if (!hadLib) fs.rmSync(LIB, { recursive: true, force: true });

if (buildError) {
  console.error(`  ✗ 站点构建没跑起来：${buildError?.message ?? buildError}`);
  console.error("\n✗ dist 布局校验失败：站点构建本身先坏了，边界无从谈起");
  process.exit(1);
}

check(observed.libProbe, "dist/lib/ 里的探针还在（站点构建没碰库产物）");
check(!observed.rootProbe, "dist/ 根的探针被清掉（站点旧产物有被清）");
check(!observed.assetsProbe, "dist/assets/ 里的探针被清掉");
check(observed.index, "dist/index.html 重新生成");

if (fails.length) {
  console.error(`\n✗ 失败 ${fails.length} 项 —— dist/ 的归属边界被破坏了：站点构建不许删 dist/lib`);
  console.error("  （宿主 WallpaperEM 的 file: 依赖指着它，删掉后宿主每条 pnpm 命令都会报 ENOENT）");
  process.exit(1);
}
console.log("\n✓ dist 布局校验通过：站点产物归站点构建、dist/lib 归库构建，互不删");
