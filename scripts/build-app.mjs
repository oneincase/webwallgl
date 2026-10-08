#!/usr/bin/env node
/**
 * 组装自包含的应用目录 app/（先跑 `pnpm build` 产出站点 dist/）：
 *
 *   app/package.json   name = webwallgl-app，bin = webwallgl-app
 *   app/cli.mjs        npx / 全局命令入口（desktop/cli.mjs）
 *   app/main.mjs       Electron 主进程（desktop/main.mjs，旁边有 server.mjs 即走生产形态）
 *   app/preload.cjs
 *   app/server.mjs     host/app-entry.ts 打包：静态站点 + 宿主端点，零运行时依赖
 *   app/web-shim.js    网页壁纸 shim（宿主注入 /web/ HTML 用）
 *   app/site/          dist/ 下的站点产物（不含库产物 dist/lib）
 *
 * 同一个目录两种用途：
 *   node scripts/build-app.mjs          → electron-builder 的 directories.app（electron 不能出现在依赖里）
 *   node scripts/build-app.mjs --npm    → npm 发布 webwallgl-app（electron 作可选依赖，装不上就退回浏览器模式）
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "dist");
const out = join(root, "app");
const forNpm = process.argv.includes("--npm");

if (!existsSync(join(dist, "editor", "index.html"))) {
  throw new Error("缺少站点产物 dist/editor/index.html —— 先跑 pnpm build");
}

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "site"), { recursive: true });

for (const entry of readdirSync(dist)) {
  if (entry === "lib") continue;
  cpSync(join(dist, entry), join(out, "site", entry), { recursive: true });
}

await esbuild.build({
  entryPoints: [join(root, "host", "app-entry.ts")],
  outfile: join(out, "server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  legalComments: "none",
  logLevel: "warning",
});

cpSync(join(root, "renderer", "src", "web-shim.js"), join(out, "web-shim.js"));
cpSync(join(root, "desktop", "main.mjs"), join(out, "main.mjs"));
cpSync(join(root, "desktop", "preload.cjs"), join(out, "preload.cjs"));
cpSync(join(root, "desktop", "cli.mjs"), join(out, "cli.mjs"));
cpSync(join(root, "LICENSE"), join(out, "LICENSE"));

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const appPkg = {
  name: "webwallgl-app",
  productName: "WebWallGL",
  version: pkg.version,
  description: "WebWallGL desktop app: Wallpaper Engine wallpaper player and scene editor (Electron / browser)",
  license: pkg.license,
  author: pkg.email ? { name: pkg.author, email: pkg.email } : pkg.author,
  ...(pkg.repository ? { repository: pkg.repository } : {}),
  ...(pkg.homepage ? { homepage: pkg.homepage } : {}),
  ...(pkg.bugs ? { bugs: pkg.bugs } : {}),
  type: "module",
  main: "main.mjs",
  bin: { "webwallgl-app": "cli.mjs" },
  files: ["cli.mjs", "main.mjs", "preload.cjs", "server.mjs", "web-shim.js", "site"],
  engines: { node: ">=20" },
  keywords: ["wallpaper-engine", "wallpaper", "webgl", "electron", "editor"],
  ...(forNpm ? { optionalDependencies: { electron: pkg.devDependencies.electron } } : {}),
};
writeFileSync(join(out, "package.json"), `${JSON.stringify(appPkg, null, 2)}\n`);

writeFileSync(
  join(out, "README.md"),
  `# webwallgl-app

WebWallGL 桌面应用：Wallpaper Engine 壁纸播放器 + 场景编辑器。渲染库本体见 [webwallgl](https://www.npmjs.com/package/webwallgl)。

\`\`\`bash
npx webwallgl-app            # 打开桌面窗口（Electron）；装不上 Electron 时自动改用浏览器
npx webwallgl-app --web      # 只起本地服务，用系统浏览器打开 http://127.0.0.1:1431/editor/

npm i -g webwallgl-app && webwallgl-app --library ~/wallpapers
\`\`\`

选项：\`--web\`、\`--port <n>\`、\`--host <addr>\`、\`--library <dir>\`、\`--no-open\`，详见 \`webwallgl-app --help\`。

各平台安装包（dmg / exe / AppImage / deb）见 [GitHub Releases](${(pkg.homepage ?? "").replace(/#readme$/, "")}/releases)。

---

WebWallGL desktop app: a Wallpaper Engine wallpaper player and scene editor. Run \`npx webwallgl-app\` to open the desktop window, or \`npx webwallgl-app --web\` to serve it locally and open it in your browser.
`,
);

console.log(`app/ 已组装（webwallgl-app@${pkg.version}${forNpm ? "，npm 形态" : "，electron-builder 形态"}）`);
