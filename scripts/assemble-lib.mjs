#!/usr/bin/env node
/**
 * 库发布物组装（docs/LIBRARY-PLAN.md 第 6 步）。
 *
 * `node scripts/build-lib.mjs`（build:lib 第 2 步）产出 JS 双格式的**可读版 + sourcemap**（播放包
 * ES+UMD 两格式；公共包/编辑器包各一份自包含 ESM，见 docs/EDITOR-PLAN.md §0.5）；
 * tsc 从 api/types.ts（公共类型唯一真源，零 import）生成类型声明；
 * 本脚本再用 esbuild 压出对应的 .min 版（各带 sourcemap），拼成最终发布物 dist/lib/：
 *   webwallgl.mjs / webwallgl.min.mjs
 *   webwallgl.global.js / webwallgl.global.min.js
 *   webwallgl-core.mjs / webwallgl-core.min.mjs
 *   webwallgl-editor.mjs / webwallgl-editor.min.mjs
 *   各自 .map / webwallgl.d.ts / core.d.ts / editor.d.ts / types.d.ts / package.json
 *   README.md / README.en.md / LICENSE / imgs/（使用说明、许可、收款码随包发布）
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

// 同 gen-readme.mjs：`.pathname` 在 Windows 上是 "/D:/..."，join 后成 "\D:\..."，
// 会让后续 existsSync / esbuild 全部找不到文件。必须 fileURLToPath。
const root = fileURLToPath(new URL("..", import.meta.url));
const libDir = join(root, "dist", "lib");

for (const f of ["webwallgl.mjs", "webwallgl.global.js", "webwallgl-core.mjs", "webwallgl-editor.mjs"]) {
  if (!existsSync(join(libDir, f))) {
    throw new Error(`缺少 ${f} —— 先跑 npm run build:lib`);
  }
}

// tsc 产物：dist/lib/types/types.d.ts（rootDir 折叠后直接落在 types/ 下）
// → 扁平化为 types.d.ts。entry.d.ts 里 `from "./types"` 正好解析到同目录的
// types.d.ts，无需改写。
const emitted = join(libDir, "types", "types.d.ts");
if (!existsSync(emitted)) {
  throw new Error("缺少 tsc 类型产物 —— 先跑 tsc -p tsconfig.lib-types.json");
}
const entry = readFileSync(join(root, "renderer", "src", "api", "entry.d.ts"), "utf8");
writeFileSync(join(libDir, "webwallgl.d.ts"), entry);
// 公共包 / 编辑器包的手写契约类型（core.d.ts / editor.d.ts 的类型同样只来自
// ./types，发布目录里与 types.d.ts 同目录所以 import 可解析）
for (const f of ["core.d.ts", "editor.d.ts"]) {
  copyFileSync(join(root, "renderer", "src", "api", f), join(libDir, f));
}
copyFileSync(emitted, join(libDir, "types.d.ts"));
rmSync(join(libDir, "types"), { recursive: true, force: true });

// 可读版 → 压缩版（esbuild 保留既有模块格式，各配一份 sourcemap）。
// min map 指向可读版文件，可读版自己的 map 再指向源码，DevTools 逐级解析。
//
// UMD 压缩版**不能传 format**：给 transform 指定 format:"iife" 会把 UMD 源码
// 整个包进 esbuild 的 __commonJS 闭包，闭包内部存在局部 module/exports，
// UMD 探测走 CommonJS 分支把 API 挂到内部 shim 上，globalThis.WebWallGL
// 永远不会被赋值 —— <script> 引入后报「WebWallGL is not defined」且无任何报错。
// 不传 format 时 esbuild 只做纯压缩，UMD 包装原样保留。
const MINIFY = [
  { in: "webwallgl.mjs", out: "webwallgl.min.mjs", format: "esm" },
  { in: "webwallgl.global.js", out: "webwallgl.global.min.js", format: null },
  { in: "webwallgl-core.mjs", out: "webwallgl-core.min.mjs", format: "esm" },
  { in: "webwallgl-editor.mjs", out: "webwallgl-editor.min.mjs", format: "esm" },
];
for (const { in: inFile, out: outFile, format } of MINIFY) {
  const source = readFileSync(join(libDir, inFile), "utf8");
  const result = await esbuild.transform(source, {
    minify: true,
    sourcemap: true,
    sourcefile: inFile,
    ...(format ? { format } : {}),
    loader: "js",
    legalComments: "none",
  });
  const map = JSON.parse(result.map);
  map.file = outFile;
  writeFileSync(join(libDir, outFile), `${result.code}\n//# sourceMappingURL=${outFile}.map\n`);
  writeFileSync(join(libDir, `${outFile}.map`), `${JSON.stringify(map)}\n`);
}

// 使用说明与许可随包发布：npm 包根的 README.md 会被 registry 页面渲染
// （build:lib 链条开头已先跑 gen-readme，这里拷的是最新版）。
// README 里的收款码图片路径 public/imgs/… 重写为包内的 imgs/…，图片一并拷入。
for (const f of ["README.md", "README.en.md"]) {
  const src = readFileSync(join(root, f), "utf8");
  writeFileSync(join(libDir, f), src.replaceAll("public/imgs/", "imgs/"));
}
copyFileSync(join(root, "LICENSE"), join(libDir, "LICENSE"));
mkdirSync(join(libDir, "imgs"), { recursive: true });
for (const img of readdirSync(join(root, "public", "imgs"))) {
  copyFileSync(join(root, "public", "imgs", img), join(libDir, "imgs", img));
}

// 发布物自己的 package.json：`npm publish dist/lib` 整目录发出去即可
//（包名 WebWallGL，npm 包名 webwallgl；version 取仓库版本）。
// 打包器走 import → 可读 ESM（bundler 自行压缩）；script/CDN 默认走压缩 UMD。
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
writeFileSync(
  join(libDir, "package.json"),
  JSON.stringify(
    {
      name: "webwallgl",
      version: pkg.version,
      description: "Wallpaper Engine scene wallpaper renderer for the browser (npm / CDN)",
      license: "MIT",
      author: pkg.email ? `${pkg.author} <${pkg.email}>` : pkg.author,
      // 仓库元数据取自根 package.json，npm 包页据此回链 GitHub
      ...(pkg.repository ? { repository: pkg.repository } : {}),
      ...(pkg.homepage ? { homepage: pkg.homepage } : {}),
      ...(pkg.bugs ? { bugs: pkg.bugs } : {}),
      type: "module",
      keywords: [
        "wallpaper-engine",
        "wallpaper",
        "webgl",
        "renderer",
        "scene",
        "canvas",
        "animated-background",
        "particles",
        "browser",
      ],
      files: [
        "webwallgl.mjs",
        "webwallgl.min.mjs",
        "webwallgl.global.js",
        "webwallgl.global.min.js",
        "webwallgl-core.mjs",
        "webwallgl-core.min.mjs",
        "webwallgl-editor.mjs",
        "webwallgl-editor.min.mjs",
        "*.map",
        "webwallgl.d.ts",
        "core.d.ts",
        "editor.d.ts",
        "types.d.ts",
        "imgs",
      ],
      main: "./webwallgl.global.min.js",
      module: "./webwallgl.mjs",
      types: "./webwallgl.d.ts",
      unpkg: "./webwallgl.global.min.js",
      jsdelivr: "./webwallgl.global.min.js",
      exports: {
        // 三包产物（docs/EDITOR-PLAN.md §0.5）：根 = 播放包（不变），./core = 公共包
        // 引擎底座，./editor = 编辑器包（播放包超集）。子路径仅 ESM（bundler / Node
        // 工具面）；CDN <script> 仍走根出口 UMD。
        ".": {
          types: "./webwallgl.d.ts",
          import: "./webwallgl.mjs",
          default: "./webwallgl.global.min.js",
        },
        "./core": {
          types: "./core.d.ts",
          import: "./webwallgl-core.mjs",
          default: "./webwallgl-core.min.mjs",
        },
        "./editor": {
          types: "./editor.d.ts",
          import: "./webwallgl-editor.mjs",
          default: "./webwallgl-editor.min.mjs",
        },
      },
      sideEffects: false,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  "dist/lib 组装完成：三包（webwallgl / webwallgl-core / webwallgl-editor）×（可读 + min，各带 .map）/ 各包 .d.ts / types.d.ts / package.json / README ×2 / LICENSE / imgs",
);
