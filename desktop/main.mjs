/**
 * WebWallGL 桌面壳（Electron 主进程）。
 *
 * 两种运行形态，按本文件旁边有没有 server.mjs 区分：
 * - 开发（仓库内 `pnpm desktop`）：1430 端口已有 dev server 就复用，否则在本进程里起一个 Vite（与 `pnpm dev` 同配置）。
 * - 生产（scripts/build-app.mjs 组装的 app/，即 electron-builder 安装包与 `npx webwallgl-app`）：
 *   在本进程里起 server.mjs（静态站点 + 宿主端点），端口缺省 1431，可用 `--port=` 或 WWGL_PORT 改。
 * 页面：缺省 /editor/；`--page=/` 或环境变量 WWGL_PAGE 可换。
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } from "electron";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROD = existsSync(join(HERE, "server.mjs"));
const ROOT = PROD ? HERE : join(HERE, "..");
const DEV_PORT = 1430;
const argValue = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const PAGE = argValue("page") || process.env.WWGL_PAGE || "/editor/";

// 固定应用名与数据目录：编辑器草稿、设置存在 localStorage / IndexedDB，换目录就全丢
app.setName("WebWallGL");
app.setPath("userData", join(app.getPath("appData"), "WebWallGL Desktop"));

// 生产形态同一时刻只留一个实例：第二个实例会因端口被占顺延到别的端口，origin 一变 localStorage 就对不上
if (PROD && !app.requestSingleInstanceLock()) app.exit(0);

let vite = null;
let prodServer = null;
let port = DEV_PORT;
let originUrl = `http://localhost:${DEV_PORT}`;
const origin = () => originUrl;

async function reachable(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

async function ensureDevServer() {
  if (await reachable(`${origin()}/editor/`)) return;
  const { createServer } = await import("vite");
  vite = await createServer({
    root: ROOT,
    configFile: join(ROOT, "vite.config.ts"),
    server: { port: DEV_PORT, strictPort: true, open: false },
  });
  await vite.listen();
}

async function pickFolder(defaultDir, prompt) {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const opts = { title: prompt, defaultPath: defaultDir || homedir(), properties: ["openDirectory", "createDirectory"] };
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
}

/** 桌面安装包内置的 media-bridge（electron-builder extraResources → Resources/media-bridge/） */
function bundledMediaBridge() {
  if (!app.isPackaged) return null;
  const bin = join(process.resourcesPath, "media-bridge", process.platform === "win32" ? "media-bridge.exe" : "media-bridge");
  return existsSync(bin) ? bin : null;
}

async function startProdServer() {
  const bundled = bundledMediaBridge();
  if (bundled && !process.env.MEDIA_BRIDGE_BIN) process.env.MEDIA_BRIDGE_BIN = bundled;
  const { startApp, DEFAULT_PORT } = await import(pathToFileURL(join(HERE, "server.mjs")).href);
  const want = Number(argValue("port") || process.env.WWGL_PORT) || DEFAULT_PORT;
  prodServer = await startApp({ port: want, pickFolder });
  port = prodServer.port;
  originUrl = prodServer.origin;
}

const isLocal = (url) => {
  try {
    const u = new URL(url);
    return (u.hostname === "localhost" || u.hostname === "127.0.0.1") && u.port === String(port);
  } catch {
    return false;
  }
};

function createWindow() {
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 960,
    minHeight: 600,
    title: "WebWallGL",
    backgroundColor: "#16181d",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: join(HERE, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isLocal(url)) return { action: "allow" };
    void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (isLocal(url)) return;
    e.preventDefault();
    void shell.openExternal(url);
  });
  void win.loadURL(origin() + PAGE);
  return win;
}

app.on("second-instance", () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.whenReady().then(async () => {
  // 本地页面要的权限（文件夹读写、剪贴板、音频采集等）一律放行，外站一律拒
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb, details) => cb(isLocal(details.requestingUrl)));
  session.defaultSession.setPermissionCheckHandler((_wc, _perm, origin) => isLocal(origin));
  // 编辑器外部插件目录（与 host/plugin-dirs.ts 的第一个根一致）
  ipcMain.handle("plugins:open-dir", async () => {
    const dir = join(homedir(), ".webwallgl", "plugins");
    await mkdir(dir, { recursive: true });
    const err = await shell.openPath(dir);
    return { dir, error: err || null };
  });
  if (process.platform !== "darwin") Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: "fileMenu" }, { role: "editMenu" }, { role: "viewMenu" }, { role: "windowMenu" }]));
  try {
    if (PROD) await startProdServer();
    else await ensureDevServer();
  } catch (e) {
    const msg = `启动本地服务失败：${e?.message ?? e}`;
    console.error(`[desktop] ${msg}`);
    if (PROD) dialog.showErrorBox("WebWallGL", msg);
    app.exit(1);
    return;
  }
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => {
  void vite?.close();
  void prodServer?.close();
});
