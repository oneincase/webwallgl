#!/usr/bin/env node
/**
 * `npx webwallgl-app` / 全局安装后的 `webwallgl-app` 命令（随 app/ 发布，见 scripts/build-app.mjs）。
 * 缺省开 Electron 桌面窗口；装不上 Electron（可选依赖被跳过、下载失败）或带 --web 时，
 * 起本地服务并用系统浏览器打开。
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8"));

const HELP = `WebWallGL ${pkg.version} —— Wallpaper Engine 壁纸播放器与场景编辑器

用法：webwallgl-app [选项]

  --web              不开桌面窗口，只起本地服务并用浏览器打开
  --port <n>         端口（缺省 1431；被占时顺延）
  --host <addr>      监听地址（缺省 127.0.0.1；局域网访问用 0.0.0.0，仅 --web）
  --library <dir>    壁纸库目录（等同环境变量 WE_LIBRARY）
  --no-open          --web 时不自动打开浏览器
  -v, --version      打印版本
  -h, --help         打印本帮助
`;

function parseArgs(argv) {
  const o = { web: false, open: true, port: undefined, host: undefined, library: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [k, inline] = a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
    const val = () => {
      const v = inline ?? argv[++i];
      if (v === undefined) fail(`${k} 缺少参数`);
      return v;
    };
    switch (k) {
      case "--web":
        o.web = true;
        break;
      case "--no-open":
        o.open = false;
        break;
      case "--port":
        o.port = Number(val());
        if (!Number.isInteger(o.port) || o.port <= 0 || o.port > 65535) fail(`非法端口：${o.port}`);
        break;
      case "--host":
        o.host = val();
        break;
      case "--library":
        o.library = resolve(val());
        break;
      case "-v":
      case "--version":
        console.log(pkg.version);
        process.exit(0);
      case "-h":
      case "--help":
        console.log(HELP);
        process.exit(0);
      default:
        fail(`未知选项：${a}\n\n${HELP}`);
    }
  }
  return o;
}

function fail(msg) {
  console.error(`[webwallgl] ${msg}`);
  process.exit(1);
}

/** 解析 Electron 可执行文件；包在但二进制没下（pnpm / --ignore-scripts 跳过了 postinstall）就补跑它的 install.js */
function electronBinary() {
  let dir;
  try {
    dir = dirname(createRequire(import.meta.url).resolve("electron/package.json"));
  } catch {
    return null;
  }
  const bin = () => {
    const p = join(dir, "path.txt");
    if (!existsSync(p)) return null;
    const b = join(dir, "dist", readFileSync(p, "utf8").trim());
    return existsSync(b) ? b : null;
  };
  if (bin()) return bin();
  console.log("[webwallgl] Electron 二进制缺失，正在下载…");
  const r = spawnSync(process.execPath, [join(dir, "install.js")], { stdio: "inherit", cwd: dir });
  return r.status === 0 ? bin() : null;
}

function openBrowser(url) {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  const child = spawn(cmd, args, { stdio: "ignore", detached: true });
  child.on("error", () => console.log(`[webwallgl] 请手动在浏览器打开：${url}`));
  child.unref();
}

async function runWeb(o) {
  const { startApp } = await import(pathToFileURL(join(HERE, "server.mjs")).href);
  const srv = await startApp({ port: o.port, host: o.host });
  const url = `${srv.origin}/editor/`;
  console.log(`\n  WebWallGL 已启动：${url}\n  按 Ctrl+C 退出\n`);
  if (o.open) openBrowser(url);
  const stop = () => {
    void srv.close().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

function runElectron(bin, o) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  if (o.port) env.WWGL_PORT = String(o.port);
  const child = spawn(bin, [join(HERE, "main.mjs")], { stdio: "inherit", env });
  child.on("exit", (code) => process.exit(code ?? 0));
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
}

const opts = parseArgs(process.argv.slice(2));
if (opts.library) process.env.WE_LIBRARY = opts.library;

if (opts.web) {
  await runWeb(opts);
} else {
  const bin = electronBinary();
  if (bin) runElectron(bin, opts);
  else {
    console.log("[webwallgl] 未找到 Electron，改用浏览器模式（--web）");
    await runWeb(opts);
  }
}
