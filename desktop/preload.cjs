const { contextBridge, ipcRenderer } = require("electron");

// 页面据此识别「跑在自家桌面壳里」（shared/workbench/platform.ts 的 isElectron）。
// 插件目录的内容走 dev 宿主 /api/plugins（与浏览器同一条路），这里只补浏览器做不到的「在访达里打开」。
contextBridge.exposeInMainWorld("webwallglDesktop", {
  platform: process.platform,
  openPluginsDir: () => ipcRenderer.invoke("plugins:open-dir"),
});
