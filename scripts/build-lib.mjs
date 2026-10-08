#!/usr/bin/env node
/**
 * 库构建：三包产物（docs/EDITOR-PLAN.md §0.5），播放包 → 公共包 → 编辑器包顺序执行。
 *
 * 为什么是脚本而不是 `vite -c` 配置文件：Vite 6 的配置文件只接受单对象（数组导出
 * 报 "config must export or return an object"），而三包共用 dist/lib 且**只允许第一包
 * 清空目录**（后两包追加，否则互删）—— 用 JS API 顺序调用最直接，也免去 shell 里
 * 串三条 vite 命令。每个配置必须 configFile:false，否则会自动加载 vite.config.ts
 * （站点构建配置）把 editor/main 全卷进来。
 *
 * 三个 bundle 各自内联全部依赖（不共享 chunk）：根出口保持与单入口时代同构
 * （桌面 App 的 file: 依赖零风险），子路径可单独 CDN 直引；代价是 npm 包多两份
 * 引擎拷贝，与「四份格式拷贝」的既有发布习惯一致。公共/编辑器包只有 ESM。
 * 压缩版由 scripts/assemble-lib.mjs 用 esbuild 二次生成。
 */
import { build } from "vite";
import { fileURLToPath } from "node:url";

const entry = (p) => fileURLToPath(new URL(`../renderer/src/api/${p}`, import.meta.url));

const base = {
  configFile: false,
  publicDir: false, // 库产物不带 public/（降级页等属宿主资产）
  build: {
    target: "es2022",
    outDir: "dist/lib",
    minify: false,
    sourcemap: true,
  },
};

// ① 播放包（根出口，向后兼容；桌面 App 的 file: 依赖走它，行为不变）
//    webwallgl.mjs（ESM，npm + bundler 主路径）+ webwallgl.global.js（UMD，全局
//    变量 WebWallGL，<script> CDN 入口）。唯一 emptyOutDir 的构建。
const player = {
  ...base,
  build: {
    ...base.build,
    emptyOutDir: true,
    lib: {
      entry: entry("index.ts"),
      name: "WebWallGL",
      formats: ["es", "umd"],
      fileName: (format) => (format === "es" ? "webwallgl.mjs" : "webwallgl.global.js"),
    },
  },
};

// ② 公共包（webwallgl/core）：引擎底座（pkg/.tex 解码、fitWindow），自包含 ESM
const core = {
  ...base,
  build: {
    ...base.build,
    emptyOutDir: false,
    lib: {
      entry: entry("core.ts"),
      formats: ["es"],
      fileName: () => "webwallgl-core.mjs",
    },
  },
};

// ③ 编辑器包（webwallgl/editor）：播放包超集，自包含 ESM
const editor = {
  ...base,
  build: {
    ...base.build,
    emptyOutDir: false,
    lib: {
      entry: entry("editor.ts"),
      formats: ["es"],
      fileName: () => "webwallgl-editor.mjs",
    },
  },
};

for (const [name, cfg] of [
  ["① 播放包（webwallgl，ES+UMD）", player],
  ["② 公共包（webwallgl/core，ESM）", core],
  ["③ 编辑器包（webwallgl/editor，ESM）", editor],
]) {
  console.log(`[build-lib] ${name} …`);
  await build(cfg);
}
console.log("[build-lib] 三包构建完成 → dist/lib/");
