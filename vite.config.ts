import { defineConfig, type Plugin } from "vite";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { wallpaperHost } from "./host/wallpaper-host";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

const DIST = here("dist");

/**
 * dist/ 是**共享目录**：站点产物写根（assets/ / index.html / renderer/…），库产物在
 * `dist/lib`（宿主项目 WallpaperEM 以 `file:../webwallgl-github/dist/lib` 依赖它）。
 *
 * Vite 默认会清空整个 outDir —— 那会把 `dist/lib` 一起删掉，宿主那边每条 pnpm 命令
 * 都停在 `ENOENT: ... scandir '.../dist/lib'`，而且看不出跟本仓有关（2026-10-01 踩过）。
 * 所以这里关掉自动清空，改成只删站点自己的产物、把 `lib/` 留下；
 * 边界由 scripts/verify-dist-layout.mjs 守着（在 pnpm check 的稳定集里）。
 */
function cleanSiteOutput(): Plugin {
  return {
    name: "we-clean-site-output",
    apply: "build",
    enforce: "pre",
    buildStart() {
      if (!existsSync(DIST)) return;
      for (const entry of readdirSync(DIST)) {
        if (entry === "lib") continue; // 库产物：宿主 file: 依赖的落点，不许碰
        rmSync(join(DIST, entry), { recursive: true, force: true });
      }
    },
  };
}

// 入口：/editor/ 工作台（壁纸库播放 + 编辑同一页，docs/EDITOR-PLAN.md §3A），
// /renderer/index.html 渲染器页（与主项目 WallpaperEM 同路径同 query 协议），/ 只是跳到 /editor/ 的旧入口
export default defineConfig({
  plugins: [wallpaperHost(), cleanSiteOutput()],
  clearScreen: false,
  server: {
    port: 1430,
    strictPort: true,
    open: "/editor/",
    host: true,
  },
  build: {
    target: "es2022",
    // 由 cleanSiteOutput 精确清（见上）—— Vite 的整目录清空会连 dist/lib 一起删
    emptyOutDir: false,
    rollupOptions: {
      input: {
        index: here("index.html"),
        renderer: here("renderer/index.html"),
        editor: here("editor/index.html"),
      },
    },
  },
});
