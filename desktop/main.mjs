/**
 * WebWallGL 桌面壳（Electron 主进程）。启动：`pnpm desktop`。
 * 1430 端口已有 dev server 就复用，否则在本进程里起一个 Vite（与 `pnpm dev` 同配置）。
 * 页面：缺省 /editor/；`--page=/` 或环境变量 WWGL_PAGE 可换。
 */
import { app, BrowserWindow, ipcMain, Menu, session, shell } from "electron";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 1430;
const ORIGIN = `http://localhost:${PORT}`;
const pageArg = process.argv.find((a) => a.startsWith("--page="))?.slice(7);
const PAGE = pageArg || process.env.WWGL_PAGE || "/editor/";

// 固定应用名与数据目录：编辑器草稿、设置存在 localStorage / IndexedDB，换目录就全丢
app.setName("WebWallGL");
app.setPath("userData", join(app.getPath("appData"), "WebWallGL Desktop"));

let vite = null;

async function reachable(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

async function ensureDevServer() {
  if (await reachable(`${ORIGIN}/editor/`)) return;
  const { createServer } = await import("vite");
  vite = await createServer({
    root: ROOT,
    configFile: join(ROOT, "vite.config.ts"),
    server: { port: PORT, strictPort: true, open: false },
  });
  await vite.listen();
}

const isLocal = (url) => {
  try {
    const u = new URL(url);
    return (u.hostname === "localhost" || u.hostname === "127.0.0.1") && u.port === String(PORT);
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
      preload: join(ROOT, "desktop/preload.cjs"),
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
  void win.loadURL(ORIGIN + PAGE);
  return win;
}

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
    await ensureDevServer();
  } catch (e) {
    console.error(`[desktop] 启动 Vite 失败：${e?.message ?? e}`);
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
});
