import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// 库构建（docs/LIBRARY-PLAN.md 第 6 步）：与 vite.config.ts（bench+renderer 应用
// 构建）分开。本步只产「可读版 + sourcemap」，压缩版由 scripts/assemble-lib.mjs
// 用 esbuild 二次生成。最终产物（dist/lib/）：
//   webwallgl.mjs             ESM 可读版（npm + bundler 主路径，bundler 自行压缩）
//   webwallgl.min.mjs         ESM 压缩版（ESM CDN 直引）
//   webwallgl.global.js       UMD 可读版（全局变量 WebWallGL，调试用）
//   webwallgl.global.min.js   UMD 压缩版（<script> CDN 默认入口）
//   *.map                     以上四份各自的 sourcemap
// 类型：tsc 从 api/types.ts 生成（该文件零 import，是公共类型的唯一真源），
// 入口包装见 renderer/src/api/entry.d.ts。
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  publicDir: false, // 库产物不带 public/（降级页等属宿主资产）
  build: {
    target: "es2022",
    outDir: "dist/lib",
    emptyOutDir: true,
    minify: false,
    sourcemap: true,
    lib: {
      entry: here("renderer/src/api/index.ts"),
      name: "WebWallGL",
      formats: ["es", "umd"],
      fileName: (format) => (format === "es" ? "webwallgl.mjs" : "webwallgl.global.js"),
    },
  },
});
