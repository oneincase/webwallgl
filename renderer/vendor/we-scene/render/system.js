// [we-scene patch] 外部系统交互的标准接口 + 模拟实现
// 壁纸脚本会读「系统正在播什么歌」「当前窗口标题」这类宿主数据，也会发出
// 「下一首 / 暂停」这种控制。真实 OS 媒体会话、浏览器标签、快捷方式都不在
// 本仓库里接：这里只定**可替换的 provider 形状**和一份确定性模拟数据。
// 接 WallpaperEM / macOS 媒体远程 / Chrome 标签时，换 provider 即可，
// 快照字段与方法名保持不变（与 render/media.js、render/audio.js 同一套路）。
// 全库 178 张 scene 脚本的明文引用：
//   - 媒体元数据：21 张 / media* 回调（已由 media.js 覆盖）
//   - 切歌：脚本侧没有 engine.skipNext 明文；媒体播放器（3790527023）用
//     thisLayer.getChildren() 播自己的声音层。切「系统正在播放」是宿主控制面。
//   - 窗口/浏览器标题：明文 0 处。仍做成接口，供文字层或后续脚本读取
//     `engine.windowTitle`，以及宿主调试 `window.__system.windowTitle`。

import { createSimulatedMedia } from './media.js'

const EMPTY_WINDOW = { app: '', title: '', url: '', index: -1 }

/**
 * 无真实前台窗口/标签时的中性驱动（恒为空）。
 * 不再轮换虚构标签；宿主注入窗口信息前，windowTitle 保持空串。
 */
export function createSimulatedWindowTitle() {
  return {
    snapshot: EMPTY_WINDOW,
    tabs: [],
    hold: 0,
    update(_t) { return EMPTY_WINDOW },
  }
}

/**
 * 用户快捷方式（engine.openUserShortcut(propName)）。
 * 全库 23 处 / 4 张：点按钮打开 project.json 里声明的 URL/应用。
 * 本仓没有桌面侧通道，默认记一笔 last 供调试；宿主注入 onOpen 后才真打开。
 */
export function createShortcutHandler(onOpen) {
  const last = { name: '', at: 0 }
  function openUserShortcut(name) {
    last.name = String(name || '')
    last.at = Date.now()
    if (typeof onOpen === 'function') onOpen(last.name)
    return last.name
  }
  return { openUserShortcut, last }
}

/**
 * 组装一套默认模拟系统源。宿主可拆开替换其中任意一项。
 */
export function createSimulatedSystem(seed) {
  const media = createSimulatedMedia(seed)
  const windowTitle = createSimulatedWindowTitle()
  const shortcuts = createShortcutHandler(null)
  return { media, windowTitle, shortcuts }
}
