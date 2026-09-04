// 测试台多语言支持（简体中文 / English）
//
// 语言解析顺序：localStorage 用户选择 → 浏览器语言（zh* → 中文，其余 → English）。
// 静态界面元素用 data-i18n（textContent）/ data-i18n-ph（placeholder）/
// data-i18n-title（title）声明；JS 动态拼的字符串走 t()。

export type Lang = "zh" | "en";

const LANG_KEY = "webwallgl-lang";

// 导出 DICT：README 生成器（scripts/gen-readme.mjs）复用同一份文案
export const DICT: Record<Lang, Record<string, string>> = {  zh: {
    "app.title": "WebWallGL 测试台",
    "act.explorer": "资源管理器",
    "act.docs": "使用说明",
    "theme.auto": "主题：跟随系统",
    "theme.dark": "主题：深色",
    "theme.light": "主题：浅色",
    "lang.title": "切换语言",
    "sponsor.title": "赞赏作者",
    "sponsor.text": "如果这个渲染核心帮到了你的项目，欢迎请作者喝杯咖啡。扫描二维码即可赞赏，金额随意。",
    "sponsor.wechat": "微信支付",
    "sponsor.alipay": "支付宝",
    "static.notice": "在线静态版：壁纸库列表需要本机后端；可用「打开本地 .pkg」纯前端预览，完整功能请本地运行 pnpm dev。",
    "static.libPath": "静态托管 · 无本机后端",
    "static.pickTitle": "静态托管下不可用 —— 请在本地运行（pnpm dev）",
    "file.open": "打开本地 .pkg",
    "file.openTitle": "纯前端预览 Wallpaper Engine 的 scene.pkg（无需后端，文件不离开浏览器）",
    "log.filePreview": "本地预览：{name}",
    "err.filePreview": "本地预览失败：{msg}",
    "sidebar.title": "资源管理器",
    "sidebar.libCount": "壁纸库",
    "sidebar.pickLib": "选择文件夹（也可继续用 WE_LIBRARY）",
    "btn.pickLib": "选择文件夹",
    "ph.filter": "过滤标题 / itemId",
    "ph.propsFilter": "过滤属性名 / 文案",
    "reveal.open": "打开所在文件夹",
    "ctx.delete": "删除壁纸",
    "confirm.delete": "确定删除壁纸「{title}」吗？整个目录将移入废纸篓（{id}）。",
    "ok.delete": "已删除：{id}",
    "err.delete": "删除失败：{msg}",
    "tab.wallpaper": "未选择壁纸",
    "toolbar.resolution": "分辨率",
    "toolbar.resolutionTip": "舞台逻辑分辨率（iframe 视口）",
    "toolbar.volume": "音量",
    "toolbar.live": "系统实况",
    "toolbar.liveTip": "歌名/进度：Node 读 media-control；音频条：麦克风（无系统声卡环回）。换壁纸或勾选后会重挂载",
    "toolbar.pause": "暂停",
    "toolbar.resume": "恢复",
    "toolbar.reload": "重挂载",
    "toolbar.release": "释放",
    "toolbar.open": "新窗口",
    "toolbar.props": "壁纸配置",
    "toolbar.filter": "滤镜",
    "toolbar.filterTip": "滤镜（beta）：以 CSS filter 应用到渲染输出",
    "filter.none": "无",
    "filter.blur": "高斯模糊",
    "filter.grayscale": "黑白",
    "filter.sepia": "怀旧",
    "filter.vivid": "鲜艳",
    "filter.warm": "暖色",
    "filter.cool": "冷色",
    "filter.invert": "反色",
    "filter.brighten": "提亮",
    "filter.darken": "压暗",
    "filter.contrast": "高对比",
    "res.fit": "自适应 16:9",
    "stage.empty": "从左侧选择一个壁纸开始渲染",
    "logs.head": "输出",
    "logs.diag": "渲染器诊断（/diag）",
    "logs.clear": "清空",
    "logs.collapse": "折叠输出",
    "logs.expand": "展开输出",
    "status.adaptive": "自适应 16:9",
    "status.cap": "上限 {n}",
    "status.capTitle": "帧率上限（工具条 fps）",
    "status.liveTitle": "壁纸实测帧率（渲染循环最近 500ms）",
    "status.items": "{n} 项",
    "props.title": "壁纸配置",
    "props.reset": "恢复默认",
    "props.collapse": "收起",
    "props.showHidden": "显示条件隐藏项",
    "props.reading": "读取中…",
    "props.none": "该壁纸未声明可自定义项",
    "props.count": "{n} 项",
    "props.countOverridden": "{n} 项（{m} 项已改）",
    "props.readFail": "读取失败：{msg}",
    "props.saving": "保存中…",
    "props.savedOverridden": "已保存（{n} 项已改）",
    "props.savedAll": "已保存（全部默认）",
    "props.saveFail": "保存失败：{msg}",
    "props.pending": "待保存…",
    "props.logSaved": "属性保存：{id} {n} 项覆盖",
    "props.empty": "project.json 未声明 general.properties，无可自定义项。",
    "props.noMatch": "无匹配属性",
    "props.allHidden": "全部属性都被 condition 隐藏（可勾选上方开关查看）",
    "props.filePh": "相对壁纸根的路径（{kind}）",
    "props.dirPh": "目录绝对路径",
    "err.wpNotReady": "__wp 尚未就绪（先选一个壁纸并等页面加载完）",
    "err.diagStream": "诊断流断开（dev server 重启？）",
    "err.pickLib": "选择文件夹失败：{msg}",
    "err.reveal": "打开文件夹失败：{msg}",
    "err.selectFirst": "先选一个壁纸再打开自定义配置",
    "ok.reveal": "已打开文件夹：{id}",
    "log.libLoaded": "壁纸库载入：{n} 项（scene {s} / web {w} / video {v}）",
    "log.mount": "挂载 {id}：?{q}",
    "prompt.libDir": "壁纸库目录",
  },
  en: {
    "app.title": "WebWallGL Bench",
    "act.explorer": "Explorer",
    "act.docs": "User guide",
    "theme.auto": "Theme: system",
    "theme.dark": "Theme: dark",
    "theme.light": "Theme: light",
    "lang.title": "Switch language",
    "sponsor.title": "Sponsor the author",
    "sponsor.text": "If this rendering core helped your project, buying the author a coffee is always appreciated. Scan the QR code to sponsor — any amount counts.",
    "sponsor.wechat": "WeChat Pay",
    "sponsor.alipay": "Alipay",
    "static.notice": "Static demo: the library listing needs a local backend. Use \"Open local .pkg\" for fully client-side preview, or run pnpm dev locally for the full bench.",
    "static.libPath": "Static hosting · no local backend",
    "static.pickTitle": "Unavailable on static hosting — run locally (pnpm dev)",
    "file.open": "Open local .pkg",
    "file.openTitle": "Preview a Wallpaper Engine scene.pkg fully client-side (no backend, the file never leaves the browser)",
    "log.filePreview": "Local preview: {name}",
    "err.filePreview": "Local preview failed: {msg}",
    "sidebar.title": "Explorer",
    "sidebar.libCount": "Library",
    "sidebar.pickLib": "Pick folder (or keep using WE_LIBRARY)",
    "btn.pickLib": "Pick folder",
    "ph.filter": "Filter title / itemId",
    "ph.propsFilter": "Filter property name / label",
    "reveal.open": "Open containing folder",
    "ctx.delete": "Delete wallpaper",
    "confirm.delete": "Delete wallpaper “{title}”? Its whole folder will be moved to the Trash ({id}).",
    "ok.delete": "Deleted: {id}",
    "err.delete": "Delete failed: {msg}",
    "tab.wallpaper": "No wallpaper",
    "toolbar.resolution": "Resolution",
    "toolbar.resolutionTip": "Stage logical resolution (iframe viewport)",
    "toolbar.volume": "Volume",
    "toolbar.live": "Live system",
    "toolbar.liveTip": "Title/progress via Node media-control; audio bars via mic (no system loopback). Remounts on toggle",
    "toolbar.pause": "Pause",
    "toolbar.resume": "Resume",
    "toolbar.reload": "Remount",
    "toolbar.release": "Release",
    "toolbar.open": "New window",
    "toolbar.props": "Wallpaper config",
    "toolbar.filter": "Filter",
    "toolbar.filterTip": "Filter (beta): CSS filter applied to the rendered output",
    "filter.none": "None",
    "filter.blur": "Blur",
    "filter.grayscale": "Grayscale",
    "filter.sepia": "Sepia",
    "filter.vivid": "Vivid",
    "filter.warm": "Warm",
    "filter.cool": "Cool",
    "filter.invert": "Invert",
    "filter.brighten": "Brighten",
    "filter.darken": "Darken",
    "filter.contrast": "Contrast",
    "res.fit": "Adaptive 16:9",
    "stage.empty": "Pick a wallpaper on the left to start rendering",
    "logs.head": "Output",
    "logs.diag": "Renderer diagnostics (/diag)",
    "logs.clear": "Clear",
    "logs.collapse": "Collapse output",
    "logs.expand": "Expand output",
    "status.adaptive": "Adaptive 16:9",
    "status.cap": "Cap {n}",
    "status.capTitle": "FPS cap (toolbar fps)",
    "status.liveTitle": "Measured wallpaper FPS (render loop, last 500ms)",
    "status.items": "{n} items",
    "props.title": "Wallpaper config",
    "props.reset": "Reset defaults",
    "props.collapse": "Collapse",
    "props.showHidden": "Show condition-hidden items",
    "props.reading": "Reading…",
    "props.none": "This wallpaper declares no custom properties",
    "props.count": "{n} items",
    "props.countOverridden": "{n} items ({m} overridden)",
    "props.readFail": "Read failed: {msg}",
    "props.saving": "Saving…",
    "props.savedOverridden": "Saved ({n} overridden)",
    "props.savedAll": "Saved (all defaults)",
    "props.saveFail": "Save failed: {msg}",
    "props.pending": "Pending save…",
    "props.logSaved": "Properties saved: {id} ({n} overrides)",
    "props.empty": "project.json declares no general.properties — nothing to customize.",
    "props.noMatch": "No matching properties",
    "props.allHidden": "All properties hidden by condition (tick the switch above to view)",
    "props.filePh": "Path relative to wallpaper root ({kind})",
    "props.dirPh": "Absolute directory path",
    "err.wpNotReady": "__wp not ready (pick a wallpaper and wait for it to load)",
    "err.diagStream": "Diagnostics stream lost (dev server restarted?)",
    "err.pickLib": "Picking folder failed: {msg}",
    "err.reveal": "Opening folder failed: {msg}",
    "err.selectFirst": "Pick a wallpaper before opening Properties",
    "ok.reveal": "Opened folder: {id}",
    "log.libLoaded": "Library loaded: {n} items (scene {s} / web {w} / video {v})",
    "log.mount": "Mount {id}: ?{q}",
    "prompt.libDir": "Wallpaper library directory",
  },
};

let lang: Lang = detect();
const listeners = new Set<(l: Lang) => void>();

function detect(): Lang {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved === "zh" || saved === "en") return saved;
  } catch {
    /* 隐私模式：走浏览器语言 */
  }
  // 读不到浏览器语言（极少数环境 navigator.language 为空）→ 默认英文
  const nav = (typeof navigator !== "undefined" && navigator.language) || "";
  return nav.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function getLang(): Lang {
  return lang;
}

export function t(key: string, params?: Record<string, string | number>): string {
  const raw = DICT[lang][key] ?? DICT.en[key] ?? key;
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? `{${k}}`));
}

export function setLang(l: Lang) {
  if (l === lang) return;
  lang = l;
  try {
    localStorage.setItem(LANG_KEY, l);
  } catch {
    /* 隐私模式 */
  }
  document.documentElement.lang = l === "zh" ? "zh-CN" : "en";
  applyStatic();
  for (const f of listeners) f(l);
}

export function onChangeLang(f: (l: Lang) => void) {
  listeners.add(f);
  return () => listeners.delete(f);
}

/** 把 data-i18n / data-i18n-ph / data-i18n-title 标记的静态元素刷成当前语言 */
export function applyStatic(root: ParentNode = document) {
  for (const el of root.querySelectorAll<HTMLElement>("[data-i18n]")) {
    el.textContent = t(el.dataset.i18n!);
  }
  for (const el of root.querySelectorAll<HTMLElement>("[data-i18n-ph]")) {
    (el as HTMLInputElement).placeholder = t(el.dataset.i18nPh!);
  }
  for (const el of root.querySelectorAll<HTMLElement>("[data-i18n-title]")) {
    el.title = t(el.dataset.i18nTitle!);
  }
}

// 模块加载即应用一次：语言 + <html lang>。
// README 生成器等 Node 侧脚本也会 import 本文件，无 DOM 时跳过。
if (typeof document !== "undefined") {
  applyStatic();
  document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
}
