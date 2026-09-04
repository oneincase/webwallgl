import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { wallpaperHost } from "./host/wallpaper-host";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// 双入口：/ 测试台，/renderer/index.html 渲染器页（与主项目 WallpaperEM 同路径同 query 协议）
export default defineConfig({
  plugins: [wallpaperHost()],
  clearScreen: false,
  server: {
    port: 1430,
    strictPort: true,
    open: true,
  },
  build: {
    target: "es2022",
    rollupOptions: {
      input: {
        bench: here("index.html"),
        renderer: here("renderer/index.html"),
      },
    },
  },
});
