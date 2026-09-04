/**
 * 测试台前端：列出本地壁纸库 → 用 query 参数拉起 renderer/index.html → 用 __wp 控制。
 *
 * 关键约定必须与主项目 `src-tauri/src/wallpaper/mod.rs` 一致：
 *  - scene：`src` 只是 itemId，渲染器自己用 `mediaBase/src` 拼 scene.pkg 地址；
 *  - video/gif/image：`src` 是可直接喂给渲染器的完整媒体 URL；
 *  - web：`src` 指向 /web/{token}/{itemId}/ 下的入口页（站点根，绝对路径引用可解析）。
 */

import { evalCondition, type ConditionValues } from "./we-condition";
import { applyStatic, getLang, onChangeLang, setLang, t, type Lang } from "./i18n";
import { renderDocs } from "./docs";
import pkg from "../package.json";

const TOKEN = "dev"; // 与 host/wallpaper-host.ts 的 DEV_TOKEN 一致
const MEDIA_BASE = `${location.origin}/media/${TOKEN}`;
const WEB_BASE = `${location.origin}/web/${TOKEN}`;

type LibraryItem = {
  itemId: string;
  title: string;
  type: string;
  file?: string;
  preview?: string;
  hasScene: boolean;
  properties: Record<string, unknown> | null;
};

/** 与 host/we-props.ts 的 WebPropDef 对齐（同主项目 library_item_props 的返回） */
type WebPropDef = {
  name: string;
  ptype: string;
  text: string;
  order: number;
  value: unknown;
  default: unknown;
  overridden: boolean;
  condition?: string;
  options?: { label: string; value: unknown; condition?: string }[];
  min?: number;
  max?: number;
  step?: number;
  precision?: number;
  /** file 属性的期望文件类别（image/video/audio），决定选择器过滤器 */
  fileType?: string;
  media?: { src: string; href?: string }[];
};

type RendererWindow = Window & {
  __wp?: {
    setWallpaper(cfg: unknown): void;
    pause(): void;
    resume(): void;
    setFit(fit: string): void;
    setVolume(volume: number): void;
    release(): void;
    restore(): void;
    setRenderDpr(dpr: number): void;
    setFilter(filter: string): void;
    setSceneFps(fps: number): void;
    updateWebProps(props: Record<string, { value: unknown }>): void;
    loadSceneFile(file: File, project?: File): void;
  };
  /** 渲染器运行时观测面（见 renderer/src/main.ts 的 __wpStats） */
  __wpStats?: {
    frame(): { fps: number; running: boolean };
  };
};

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

const listEl = $<HTMLUListElement>("#list");
const filterEl = $<HTMLInputElement>("#filter");
const typeFilterEl = $<HTMLElement>("#type-filter");
const libPathEl = $<HTMLParagraphElement>("#libpath");
const libCountEl = $<HTMLSpanElement>("#lib-count");
const currentEl = $<HTMLElement>("#current");
const frameEl = $<HTMLIFrameElement>("#frame");
const emptyEl = $<HTMLDivElement>("#empty");
const logBodyEl = $<HTMLPreElement>("#logbody");
const workspaceEl = $<HTMLElement>("#workspace");
const mainEl = $<HTMLElement>("#main");
const logsEl = $<HTMLElement>("#logs");
const toggleLogsEl = $<HTMLButtonElement>("#toggle-logs");
const pickLibEl = $<HTMLButtonElement>("#pick-lib");
const openPkgEl = $<HTMLButtonElement>("#open-pkg");
const pkgFileEl = $<HTMLInputElement>("#pkg-file");
const fitEl = $<HTMLSelectElement>("#fit");
const dprEl = $<HTMLSelectElement>("#dpr");
const fpsEl = $<HTMLSelectElement>("#fps");
const volumeEl = $<HTMLInputElement>("#volume");
const liveSystemEl = $<HTMLInputElement>("#live-system");
const resolutionEl = $<HTMLSelectElement>("#resolution");
const stageFrameEl = $<HTMLElement>("#stage-frame");
const stageScaleEl = $<HTMLElement>("#stage-scale");
const stageEl = $<HTMLElement>("#stage");
const stageBadgeEl = $<HTMLElement>("#stage-badge");
const statusLibEl = $<HTMLElement>("#status-lib");
const statusCountEl = $<HTMLElement>("#status-count");
const statusItemEl = $<HTMLElement>("#status-item");
const statusResEl = $<HTMLElement>("#status-res");
const statusDprEl = $<HTMLElement>("#status-dpr");
const statusFpsEl = $<HTMLElement>("#status-fps");
const statusLiveFpsEl = $<HTMLElement>("#status-live-fps");
const togglePropsEl = $<HTMLButtonElement>("#toggle-props");
const fxEl = $<HTMLSelectElement>("#fx");
const propsEl = $<HTMLElement>("#props");
const propsBodyEl = $<HTMLDivElement>("#props-body");
const propsStateEl = $<HTMLSpanElement>("#props-state");
const propsFilterEl = $<HTMLInputElement>("#props-filter");
const propsAllEl = $<HTMLInputElement>("#props-all");
const langEl = $<HTMLSelectElement>("#lang");
const actDocsEl = $<HTMLButtonElement>("#act-docs");
const tabCurrentEl = $<HTMLElement>("#current");
const docsViewEl = $<HTMLElement>("#docs-view");
const editorChromeEl = $<HTMLElement>("#editor-chrome");
const appVersionEl = $<HTMLElement>("#app-version");
const sponsorBtnEl = $<HTMLButtonElement>("#sponsor-btn");
const docsBodyEl = $<HTMLElement>("#docs-body");
const stageSlotEl = $<HTMLElement>("#stage-slot");

let items: LibraryItem[] = [];
let selected: LibraryItem | null = null;

// ---------- 语言切换（标题栏右侧） ----------
// 解析顺序在 i18n.ts 里：localStorage → 浏览器语言（zh* 中文，其余 English）
appVersionEl.textContent = `v${pkg.version}`;
langEl.value = getLang();
langEl.onchange = () => setLang(langEl.value as Lang);
onChangeLang(() => {
  renderDocs(docsBodyEl, getLang());
  syncStatusChrome();
  layoutStage();
  renderList();
});

// ---------- 主题（活动栏底部单按钮：自动 → 深色 → 浅色 循环） ----------

type ThemeMode = "auto" | "dark" | "light";
const THEME_KEY = "webwallgl-theme";
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
const themeToggleEl = $<HTMLButtonElement>("#theme-toggle");
let themeMode: ThemeMode = "auto";

function resolvedTheme(mode: ThemeMode): "dark" | "light" {
  return mode === "auto" ? (darkQuery.matches ? "dark" : "light") : mode;
}

function applyTheme(mode: ThemeMode) {
  themeMode = mode;
  document.documentElement.dataset.theme = resolvedTheme(mode);
  // 图标显示**当前模式**（auto=对比、dark=月亮、light=太阳），标题随词典更新
  themeToggleEl.dataset.mode = mode;
  themeToggleEl.title = t(`theme.${mode}`);
  for (const ic of themeToggleEl.querySelectorAll<SVGSVGElement>(".ic")) {
    const show = ic.classList.contains(`ic-${mode}`);
    if (show) ic.removeAttribute("hidden");
    else ic.setAttribute("hidden", "");
  }
}

themeToggleEl.onclick = () => {
  const next: ThemeMode = themeMode === "auto" ? "dark" : themeMode === "dark" ? "light" : "auto";
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* 隐私模式 */
  }
  applyTheme(next);
};

(() => {
  let mode: ThemeMode = "auto";
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "auto" || saved === "dark" || saved === "light") mode = saved;
  } catch {
    /* 隐私模式：auto */
  }
  applyTheme(mode);
  // auto 模式下跟随系统切换
  darkQuery.addEventListener("change", () => {
    if (themeMode === "auto") applyTheme("auto");
  });
})();

// ---------- 活动栏视图（资源管理器 = 舞台页 / 使用说明 = 文档页） ----------
//
// 两个按钮是互斥视图的开关：资源管理器显示侧栏 + 舞台 + 日志，
// 使用说明整页换文档（侧栏与日志一并隐藏）。编辑器标签与视图联动。

const actExplorerEl = $<HTMLButtonElement>("#act-explorer");
const sidebarEl = $<HTMLElement>("#sidebar");

let activeView: "explorer" | "docs" = "explorer";

function setView(view: "explorer" | "docs") {
  activeView = view;
  const docs = view === "docs";
  sidebarEl.hidden = docs;
  logsEl.hidden = docs; // 渲染器日志只在壁纸（舞台）页显示
  editorChromeEl.hidden = docs; // 分辨率/暂停等工具条只对舞台有意义
  docsViewEl.hidden = !docs;
  stageSlotEl.hidden = docs;
  if (docs) setPropsOpen(false);
  actDocsEl.classList.toggle("active", docs);
  actExplorerEl.classList.toggle("active", !docs);
  if (docs) {
    actDocsEl.setAttribute("aria-current", "page");
    actExplorerEl.removeAttribute("aria-current");
  } else {
    actExplorerEl.setAttribute("aria-current", "page");
    actDocsEl.removeAttribute("aria-current");
  }
  tabCurrentEl.classList.toggle("active", !docs);
  tabCurrentEl.setAttribute("aria-selected", docs ? "false" : "true");
}

actDocsEl.onclick = () => setView("docs");
sponsorBtnEl.onclick = () => {
  setView("docs");
  document.querySelector("#sponsor-card")?.scrollIntoView({ behavior: "smooth", block: "center" });
};
actExplorerEl.onclick = () => setView("explorer");
tabCurrentEl.onclick = () => setView("explorer");
// 赞赏码：某张图加载失败时隐藏整个项（如海外码补充前不露破图）
for (const img of document.querySelectorAll<HTMLImageElement>(".sponsor-qr-item img")) {
  img.addEventListener("error", () => img.closest(".sponsor-qr-item")?.setAttribute("hidden", ""));
}
  // 首次进入默认落在「使用说明」
  setView("docs");
renderDocs(docsBodyEl, getLang());

// ---------- 类型筛选（scene / web / video 三选一） ----------

type WallpaperKind = "scene" | "web" | "video";

const TYPE_KEY = "we-bench-type-filter";

let typeFilter: WallpaperKind = "scene";

/**
 * 条目归到哪一类。库里 project.json 的 type 大小写混用（scene/Scene、web/Web），
 * 所以一律小写比较；另有个别条目 type 缺失（写成 unknown）。
 * scene 以 hasScene 为准而不是看 type —— 真正决定能否走场景渲染的是有没有
 * scene.pkg/scene.json（buildQuery 也是这么判的）。比如 843532366 声明 scene
 * 但只有 gifscene.json，归到 scene 会挂不起来。
 */
function kindOf(it: LibraryItem): WallpaperKind | null {
  if (it.hasScene) return "scene";
  const t = it.type.toLowerCase();
  if (t === "web") return "web";
  if (t === "video" || t === "gif") return "video";
  return null;
}

function setTypeFilter(kind: WallpaperKind) {
  typeFilter = kind;
  for (const btn of typeFilterEl.querySelectorAll<HTMLButtonElement>(".seg-btn")) {
    const on = btn.dataset.type === kind;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-checked", on ? "true" : "false");
  }
  try {
    localStorage.setItem(TYPE_KEY, kind);
  } catch {
    /* 隐私模式 */
  }
  renderList();
}

typeFilterEl.onclick = (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".seg-btn");
  const kind = btn?.dataset.type as WallpaperKind | undefined;
  if (kind && kind !== typeFilter) setTypeFilter(kind);
};


// ---------- 日志区 ----------

function log(msg: string, isErr = false) {
  const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  const line = document.createElement("span");
  line.className = isErr ? "err" : "";
  line.textContent = `${time}  ${msg}\n`;
  logBodyEl.appendChild(line);
  logBodyEl.scrollTop = logBodyEl.scrollHeight;
}

// 渲染器的 reportDiag 走 <img src="/diag?msg=..."> → 宿主中间件 → SSE 回推到这里。
// 仅本机后端存在时连接（静态托管下探测后跳过，避免误报「诊断流断开」）。
function connectDiag() {
  const diag = new EventSource("/api/diag-stream");
  diag.onmessage = (ev) => {
    try {
      const { msg } = JSON.parse(ev.data) as { msg: string };
      log(msg, /fail|error|ERROR/.test(msg));
    } catch {
      /* 忽略心跳等非 JSON 帧 */
    }
  };
  diag.onerror = () => log(t("err.diagStream"), true);
}

$<HTMLButtonElement>("#clear-logs").onclick = () => {
  logBodyEl.textContent = "";
};

const LOGS_COLLAPSED_KEY = "we-bench-logs-collapsed";
const LIB_DIR_KEY = "we-bench-library-dir";
const RES_KEY = "we-bench-resolution";

function setLogsCollapsed(collapsed: boolean) {
  logsEl.classList.toggle("collapsed", collapsed);
  mainEl.classList.toggle("logs-collapsed", collapsed);
  toggleLogsEl.textContent = collapsed ? "▸" : "▾";
  toggleLogsEl.title = t(collapsed ? "logs.expand" : "logs.collapse");
  toggleLogsEl.setAttribute("aria-expanded", collapsed ? "false" : "true");
  try {
    localStorage.setItem(LOGS_COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    /* 隐私模式 */
  }
}

toggleLogsEl.onclick = (e) => {
  e.stopPropagation();
  setLogsCollapsed(!logsEl.classList.contains("collapsed"));
};
try {
  if (localStorage.getItem(LOGS_COLLAPSED_KEY) === "1") setLogsCollapsed(true);
} catch {
  /* 忽略 */
}

// ---------- 壁纸库列表 ----------

function setStatusItem() {
  statusItemEl.textContent = selected ? selected.itemId : "";
}

function clearSelection() {
  selected = null;
  currentEl.textContent = "未选择壁纸";
  currentEl.title = "";
  frameEl.removeAttribute("src");
  frameEl.classList.remove("on");
  emptyEl.style.display = "";
  setPropsOpen(false);
  setStatusItem();
  resetLiveFps();
  renderList();
}

async function setLibraryDir(dir: string) {
  const res = await fetch("/api/library-dir", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dir }),
  });
  const data = (await res.json()) as { dir?: string; error?: string };
  if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
  try {
    localStorage.setItem(LIB_DIR_KEY, data.dir ?? dir);
  } catch {
    /* 隐私模式 */
  }
}

pickLibEl.onclick = async () => {
  pickLibEl.disabled = true;
  try {
    const res = await fetch("/api/library-dir", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pick: true }),
    });
    const data = (await res.json()) as {
      dir?: string;
      cancelled?: boolean;
      unsupported?: boolean;
      error?: string;
    };
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    if (data.cancelled) {
      if (!data.unsupported) return;
      const typed = window.prompt(t("prompt.libDir"), libPathEl.textContent || "");
      if (!typed) return;
      await setLibraryDir(typed.trim());
    } else if (data.dir) {
      try {
        localStorage.setItem(LIB_DIR_KEY, data.dir);
      } catch {
        /* 隐私模式 */
      }
    }
    clearSelection();
    await loadLibrary();
  } catch (e) {
    log(t("err.pickLib", { msg: (e as Error).message }), true);
  } finally {
    pickLibEl.disabled = false;
  }
};

async function loadLibrary() {
  const res = await fetch("/api/library");
  const data = (await res.json()) as { dir: string; items: LibraryItem[]; error?: string };
  libPathEl.textContent = data.dir;
  libPathEl.title = data.dir;
  statusLibEl.textContent = data.dir;
  statusLibEl.title = data.dir;
  if (data.error) {
    log(data.error, true);
    return;
  }
  items = data.items;
  const n = (k: WallpaperKind) => items.filter((i) => kindOf(i) === k).length;
  log(t("log.libLoaded", { n: items.length, s: n("scene"), w: n("web"), v: n("video") }));
  renderList();
}

/** 静态托管（GitHub Pages 等）没有本机后端：/api/* 只会返回 404 HTML。
 *  探测一次，静态模式下壁纸库面板给出明确提示、禁用选文件夹，而不是抛解析错误。 */
let staticMode = false;

function staticNoticeEl(): HTMLElement {
  const notice = document.createElement("li");
  notice.className = "static-notice";
  notice.dataset.i18n = "static.notice"; // 语言切换时随 applyStatic 更新
  notice.textContent = t("static.notice");
  return notice;
}

function enterStaticMode() {
  staticMode = true;
  const msg = t("static.libPath");
  libPathEl.textContent = msg;
  libPathEl.title = msg;
  statusLibEl.textContent = msg;
  statusLibEl.title = msg;
  pickLibEl.disabled = true;
  pickLibEl.removeAttribute("data-i18n-title"); // 防止语言切换盖掉禁用提示
  pickLibEl.title = t("static.pickTitle");
  listEl.appendChild(staticNoticeEl());
}

/** /api/library 返回 JSON = 本机 dev server 在；404/HTML = 静态托管 */
async function probeBackend(): Promise<boolean> {
  try {
    const res = await fetch("/api/library", { headers: { accept: "application/json" } });
    return res.ok && (res.headers.get("content-type") ?? "").includes("application/json");
  } catch {
    return false;
  }
}

function folderIcon(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("fill", "currentColor");
  path.setAttribute(
    "d",
    "M14.5 3H7.71l-.85-.85L6.51 2h-5l-.5.5v11l.5.5h13l.5-.5v-10L14.5 3zM14 13H2V7h5.29l.85.85.36.15H14v5zm0-6.29h-6l-.85-.85L6.79 5H2V3h4.29l.85.85L7.5 4H14v2.71z",
  );
  svg.appendChild(path);
  return svg;
}

function trashIcon(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", "M3 4h10M6.5 4V3h3v1M4.5 4.5V13a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1V4.5M6.8 7v4.5M9.2 7v4.5");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.2");
  path.setAttribute("stroke-linecap", "round");
  svg.appendChild(path);
  return svg;
}

function renderList() {
  const kw = filterEl.value.trim().toLowerCase();
  listEl.textContent = "";
  if (staticMode) listEl.appendChild(staticNoticeEl()); // renderList 会清空列表，静态提示在此常驻
  let shown = 0;
  for (const it of items) {
    if (kindOf(it) !== typeFilter) continue;
    if (kw && !`${it.title} ${it.itemId}`.toLowerCase().includes(kw)) continue;
    shown++;
    const li = document.createElement("li");
    li.dataset.id = it.itemId;
    if (selected?.itemId === it.itemId) li.classList.add("active");
    if (it.preview) {
      const img = document.createElement("img");
      img.loading = "lazy";
      img.src = `${MEDIA_BASE}/${it.itemId}/${it.preview}`;
      li.appendChild(img);
    }
    const meta = document.createElement("div");
    meta.className = "meta";
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = it.title;
    const sub = document.createElement("span");
    sub.className = "sub";
    const propCount = it.properties ? Object.keys(it.properties).length : 0;
    sub.textContent = `${it.type}${propCount ? ` · ${propCount} 属性` : ""} · ${it.itemId}`;
    meta.append(title, sub);
    li.appendChild(meta);
    li.onclick = () => select(it);
    li.oncontextmenu = (e) => {
      e.preventDefault();
      // 右键未选中的条目先选中：菜单动作始终针对高亮条目（资源管理器惯例）
      if (selected?.itemId !== it.itemId) select(it);
      openCtxMenu(it, e.clientX, e.clientY);
    };
    listEl.appendChild(li);
  }
  libCountEl.textContent = t("sidebar.libCount") + (shown ? ` · ${shown}` : "");
  statusCountEl.textContent = t("status.items", { n: shown });
}

async function revealItem(itemId: string) {
  try {
    const res = await fetch("/api/reveal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemId }),
    });
    const data = (await res.json()) as { error?: string };
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    log(t("ok.reveal", { id: itemId }));
  } catch (e) {
    log(t("err.reveal", { msg: (e as Error).message }), true);
  }
}

// ---------- 列表右键菜单（打开所在文件夹 / 删除壁纸） ----------

const ctxMenuEl = document.createElement("div");
ctxMenuEl.id = "ctx-menu";
ctxMenuEl.setAttribute("role", "menu");
ctxMenuEl.hidden = true;
document.body.appendChild(ctxMenuEl);

function closeCtxMenu() {
  ctxMenuEl.hidden = true;
}

function ctxMenuItem(
  label: string,
  icon: SVGSVGElement,
  cls: string,
  action: () => void,
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `ctx-item${cls ? ` ${cls}` : ""}`;
  btn.setAttribute("role", "menuitem");
  btn.append(icon, document.createTextNode(label));
  btn.onclick = () => {
    closeCtxMenu();
    action();
  };
  return btn;
}

function openCtxMenu(it: LibraryItem, x: number, y: number) {
  ctxMenuEl.textContent = "";
  ctxMenuEl.appendChild(
    ctxMenuItem(t("reveal.open"), folderIcon(), "", () => void revealItem(it.itemId)),
  );
  ctxMenuEl.appendChild(
    ctxMenuItem(t("ctx.delete"), trashIcon(), "danger", () => void deleteItem(it)),
  );
  ctxMenuEl.hidden = false;
  // 贴屏幕右/下边缘时把菜单收进视口
  const r = ctxMenuEl.getBoundingClientRect();
  ctxMenuEl.style.left = `${Math.max(0, Math.min(x, window.innerWidth - r.width - 4))}px`;
  ctxMenuEl.style.top = `${Math.max(0, Math.min(y, window.innerHeight - r.height - 4))}px`;
}

// 点别处 / 右键别处 / 滚列表 / 窗口失焦 / Esc 都收起菜单（捕获阶段先于菜单项 click 之外的逻辑）
window.addEventListener(
  "pointerdown",
  (e) => {
    if (!ctxMenuEl.hidden && !ctxMenuEl.contains(e.target as Node)) closeCtxMenu();
  },
  true,
);
window.addEventListener("blur", closeCtxMenu);
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !ctxMenuEl.hidden) closeCtxMenu();
});
listEl.addEventListener("scroll", closeCtxMenu);

async function deleteItem(it: LibraryItem) {
  if (!window.confirm(t("confirm.delete", { title: it.title, id: it.itemId }))) return;
  try {
    const res = await fetch("/api/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemId: it.itemId }),
    });
    const data = (await res.json()) as { error?: string };
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    log(t("ok.delete", { id: it.itemId }));
    if (selected?.itemId === it.itemId) clearSelection(); // 正在预览的壁纸被删：清空舞台
    await loadLibrary();
  } catch (e) {
    log(t("err.delete", { msg: (e as Error).message }), true);
  }
}

filterEl.oninput = renderList;

// ---------- 渲染器挂载 ----------

/** 把库条目翻译成渲染器 query，语义对齐原生侧 wallpaper/mod.rs */
function buildQuery(it: LibraryItem): string {
  const type = it.hasScene ? "scene" : it.type;
  const p = new URLSearchParams();
  p.set("type", type);
  if (type === "scene") {
    p.set("src", it.itemId); // 场景：src 是 itemId，渲染器自行拼 scene.pkg
  } else if (type === "web") {
    p.set("src", `${WEB_BASE}/${it.itemId}/${it.file ?? "index.html"}`);
  } else if (it.file) {
    p.set("src", `${MEDIA_BASE}/${it.itemId}/${it.file}`);
  }
  p.set("fit", fitEl.value);
  p.set("renderDpr", dprEl.value);
  p.set("sceneFps", fpsEl.value);
  p.set("filter", fxEl.value);
  p.set("muted", String(Number(volumeEl.value) <= 0));
  p.set("loop", "true");
  p.set("mediaBase", MEDIA_BASE);
  if (liveSystemEl.checked) p.set("liveSystem", "1");
  return p.toString();
}

function select(it: LibraryItem) {
  selected = it;
  setStatusItem();
  renderList();
  mount();
  setView("explorer"); // 从文档页选壁纸 → 切回舞台视图
  // 面板开着时跟随切换（关着则等下次打开再拉，省一次请求）
  if (!propsEl.hidden) void loadProps(it.itemId);
}

function mount() {
  if (!selected) return;
  const q = buildQuery(selected);
  currentEl.textContent = selected.title;
  currentEl.title = `${selected.title}（${selected.itemId}）`;
  emptyEl.style.display = "none";
  frameEl.classList.add("on");
  // 每次都换 src（含时间戳）强制重载，避免 WebGL 上下文复用掩盖泄漏问题
  frameEl.src = `${import.meta.env.BASE_URL}renderer/index.html?${q}&_t=${Date.now()}`;
  resetLiveFps();
  log(t("log.mount", { id: selected.itemId, q }));
}

/** 取渲染器页注入的 __wp 控制接口（同源 iframe） */
function wp() {
  const w = frameEl.contentWindow as RendererWindow | null;
  if (!w?.__wp) {
    log(t("err.wpNotReady"), true);
    return null;
  }
  return w.__wp;
}

/** 确保渲染器页已在 iframe 里就绪（静态模式没有壁纸库选择流程，iframe 可能还空着），
 *  需要时先补载一次渲染器页；resolve 出 __wp 控制面。 */
function ensureRenderer(): Promise<NonNullable<RendererWindow["__wp"]>> {
  return new Promise((resolve, reject) => {
    const existing = (frameEl.contentWindow as RendererWindow | null)?.__wp;
    if (existing) return resolve(existing);
    const onLoad = () => {
      frameEl.removeEventListener("load", onLoad);
      // 渲染器页是 module 脚本，load 事件后微任务里才挂 __wp；一拍 rAF 兜底
      requestAnimationFrame(() => {
        const w = frameEl.contentWindow as RendererWindow | null;
        if (w?.__wp) resolve(w.__wp);
        else reject(new Error("renderer page loaded but __wp missing"));
      });
    };
    frameEl.addEventListener("load", onLoad);
    frameEl.src = `${import.meta.env.BASE_URL}renderer/index.html?_t=${Date.now()}`;
  });
}

// 纯前端预览：打开本地 scene.pkg，字节全程不离开浏览器（静态托管下同样可用）
openPkgEl.onclick = () => pkgFileEl.click();
pkgFileEl.onchange = async () => {
  const file = pkgFileEl.files?.[0];
  pkgFileEl.value = ""; // 允许重复选择同一文件
  if (!file) return;
  try {
    const api = await ensureRenderer();
    api.loadSceneFile(file);
    selected = null;
    renderList();
    currentEl.textContent = file.name;
    currentEl.title = file.name;
    frameEl.classList.add("on");
    emptyEl.style.display = "none";
    log(t("log.filePreview", { name: file.name }));
  } catch (e) {
    log(t("err.filePreview", { msg: (e as Error).message }), true);
  }
};

// ---------- 工具条 ----------

$<HTMLButtonElement>("#pause").onclick = () => wp()?.pause();
$<HTMLButtonElement>("#resume").onclick = () => wp()?.resume();
$<HTMLButtonElement>("#release").onclick = () => wp()?.release();
$<HTMLButtonElement>("#restore").onclick = () => wp()?.restore();
$<HTMLButtonElement>("#reload").onclick = () => mount();
$<HTMLButtonElement>("#open").onclick = () => {
  if (!selected) return;
  window.open(`${import.meta.env.BASE_URL}renderer/index.html?${buildQuery(selected)}`, "_blank");
};

// fit / fps / 音量走 __wp 热更新（不重挂载），dpr 需重建画布由 __wp 内部重挂
function syncStatusChrome() {
  statusDprEl.textContent = `DPR ${dprEl.value}`;
  statusFpsEl.textContent = t("status.cap", { n: fpsEl.value });
}

// ---------- 实测帧率（状态栏右下角） ----------
//
// 数字来自渲染器自己的打点（同源 iframe 的 __wpStats.frame）：只有真正提交的帧
// 才计数，所以能看出重场景掉到 fps 上限以下。测试台这边只轮询显示，
// 不自己数 iframe 的 rAF —— 那样量到的是显示器刷新率，不是壁纸帧率。

const LIVE_FPS_POLL_MS = 500;

/** 回到「没在出帧」的待机态：切壁纸/清空选择时立即生效，不等下一次轮询 */
function resetLiveFps() {
  statusLiveFpsEl.textContent = "— FPS";
  statusLiveFpsEl.classList.add("idle");
  statusLiveFpsEl.classList.remove("low");
}

function pollLiveFps() {
  const w = frameEl.contentWindow as RendererWindow | null;
  let stats: { fps: number; running: boolean } | undefined;
  try {
    // 跨源时读 contentWindow 会抛（渲染器同源，仅兜底）
    stats = w?.__wpStats?.frame();
  } catch {
    stats = undefined;
  }
  if (!stats?.running || !(stats.fps > 0)) {
    resetLiveFps();
    return;
  }
  const fps = Math.round(stats.fps);
  statusLiveFpsEl.textContent = `${fps} FPS`;
  statusLiveFpsEl.classList.remove("idle");
  // 掉到上限的 85% 以下标黄：这类壁纸就是要盯的性能样本
  statusLiveFpsEl.classList.toggle("low", fps < Number(fpsEl.value) * 0.85);
}

window.setInterval(pollLiveFps, LIVE_FPS_POLL_MS);

fitEl.onchange = () => wp()?.setFit(fitEl.value);
// ---------- 滤镜（beta）----------
// 选择是观看端偏好，localStorage 记住；挂载时随 query 带给渲染器（buildQuery），
// 已挂载时走 __wp.setFilter 热切（CSS filter，无需重挂）。
const FX_KEY = "webwallgl-fx";
fxEl.value = localStorage.getItem(FX_KEY) ?? "none";
fxEl.onchange = () => {
  localStorage.setItem(FX_KEY, fxEl.value);
  if (selected) wp()?.setFilter(fxEl.value);
};
fpsEl.onchange = () => {
  syncStatusChrome();
  wp()?.setSceneFps(Number(fpsEl.value));
};
dprEl.onchange = () => {
  syncStatusChrome();
  wp()?.setRenderDpr(Number(dprEl.value));
};
volumeEl.oninput = () => wp()?.setVolume(Number(volumeEl.value));
liveSystemEl.onchange = () => {
  if (selected) mount();
  log(
    liveSystemEl.checked
      ? t("log.liveOn")
      : t("log.liveOff"),
  );
};

function layoutStage() {
  const val = resolutionEl.value;
  if (val === "fit") {
    workspaceEl.classList.remove("fixed-res");
    stageScaleEl.style.width = "";
    stageScaleEl.style.height = "";
    stageEl.style.width = "";
    stageEl.style.height = "";
    stageEl.style.transform = "";
    stageBadgeEl.hidden = true;
    stageBadgeEl.textContent = "";
    statusResEl.textContent = t("status.adaptive");
    return;
  }
  const [w, h] = val.split("x").map(Number);
  if (!w || !h) return;
  const cs = getComputedStyle(stageFrameEl);
  const availW =
    stageFrameEl.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const availH =
    stageFrameEl.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const scale = Math.min(1, availW / w, availH / h);
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
  workspaceEl.classList.add("fixed-res");
  stageEl.style.width = `${w}px`;
  stageEl.style.height = `${h}px`;
  stageEl.style.transform = `scale(${s})`;
  stageScaleEl.style.width = `${w * s}px`;
  stageScaleEl.style.height = `${h * s}px`;
  const pct = Math.round(s * 100);
  stageBadgeEl.hidden = false;
  stageBadgeEl.textContent = pct < 100 ? `${w} × ${h} · ${pct}%` : `${w} × ${h}`;
  statusResEl.textContent = `${w} × ${h}`;
}

try {
  const savedRes = localStorage.getItem(RES_KEY);
  if (savedRes && [...resolutionEl.options].some((o) => o.value === savedRes)) {
    resolutionEl.value = savedRes;
  }
} catch {
  /* 忽略 */
}
resolutionEl.onchange = () => {
  try {
    localStorage.setItem(RES_KEY, resolutionEl.value);
  } catch {
    /* 隐私模式 */
  }
  layoutStage();
};
new ResizeObserver(layoutStage).observe(stageFrameEl);
syncStatusChrome();
layoutStage();



// ---------- 壁纸自定义配置面板 ----------
// 对标主项目的 WallpaperPropsModal：按类型渲染控件、按 condition 对当前草稿求值显隐、
// 改动即防抖保存并热更新。属性定义/覆盖值由宿主的 /api/props 提供（复刻 we_props.rs）。

/** WE 线格式 "r g b"（0..1 浮点）→ #rrggbb */
function rgbStrToHex(s: string): string {
  const parts = String(s).trim().split(/\s+/).map(Number);
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return "#000000";
  const h = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v * 255)))
      .toString(16)
      .padStart(2, "0");
  return `#${h(parts[0])}${h(parts[1])}${h(parts[2])}`;
}

/** #rrggbb → WE 线格式 "r g b"（6 位小数，与 project.json 精度一致） */
function hexToRgbStr(hex: string): string {
  let m = hex.replace("#", "");
  if (m.length === 3) m = m.split("").map((c) => c + c).join("");
  const n = Number.parseInt(m, 16);
  if (Number.isNaN(n)) return "0 0 0";
  const f = (v: number) => Number(v.toFixed(6));
  return `${f(((n >> 16) & 255) / 255)} ${f(((n >> 8) & 255) / 255)} ${f((n & 255) / 255)}`;
}

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const SAVE_DEBOUNCE_MS = 400;

let propDefs: WebPropDef[] = [];
/** 分组折叠状态（按属性名）；缺省展开，避免「分组无法设置」 */
const propGroupOpen: Record<string, boolean> = {};
let propDraft: Record<string, unknown> = {};
let propItemId = "";
let saveTimer: number | undefined;

function propsState(msg: string, isErr = false) {
  propsStateEl.textContent = msg;
  propsStateEl.style.color = isErr ? "#ff7b72" : "";
}

async function loadProps(itemId: string) {
  propItemId = itemId;
  propDefs = [];
  propDraft = {};
  for (const k of Object.keys(propGroupOpen)) delete propGroupOpen[k];
  propsBodyEl.textContent = "";
  propsState(t("props.reading"));
  try {
    const res = await fetch(`/api/props?item=${encodeURIComponent(itemId)}`);
    const data = (await res.json()) as { props?: WebPropDef[]; error?: string };
    if (data.error) throw new Error(data.error);
    if (propItemId !== itemId) return; // 期间切换了壁纸：丢弃这次结果
    propDefs = data.props ?? [];
    propDraft = Object.fromEntries(
      propDefs.filter((p) => p.value !== null).map((p) => [p.name, p.value]),
    );
    const overridden = propDefs.filter((p) => p.overridden).length;
    propsState(
      propDefs.length === 0
        ? t("props.none")
        : overridden
          ? t("props.countOverridden", { n: propDefs.length, m: overridden })
          : t("props.count", { n: propDefs.length }),
    );
    renderProps();
  } catch (e) {
    propsState(t("props.readFail", { msg: (e as Error).message }), true);
  }
}

/** 提交与默认值不同的属性（覆盖集）；空对象 = 清除全部覆盖 */
async function saveProps() {
  const overrides: Record<string, unknown> = {};
  // 遍历全部定义而非可见项：被条件隐藏的属性已有的覆盖值不能因隐藏而丢失
  for (const p of propDefs) {
    if (p.value === null) continue;
    if (!sameValue(propDraft[p.name], p.default)) overrides[p.name] = propDraft[p.name];
  }
  propsState(t("props.saving"));
  try {
    const res = await fetch(`/api/props?item=${encodeURIComponent(propItemId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(overrides),
    });
    const data = (await res.json()) as { error?: string };
    if (data.error) throw new Error(data.error);
    const n = Object.keys(overrides).length;
    propsState(n ? t("props.savedOverridden", { n }) : t("props.savedAll"));
    const wire: Record<string, { value: unknown }> = {};
    for (const [k, v] of Object.entries(propDraft)) wire[k] = { value: v };
    wp()?.updateWebProps(wire);
    log(t("props.logSaved", { id: propItemId, n }));
  } catch (e) {
    propsState(t("props.saveFail", { msg: (e as Error).message }), true);
  }
}

function scheduleSave() {
  propsState(t("props.pending"));
  if (saveTimer) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = undefined;
    void saveProps();
  }, SAVE_DEBOUNCE_MS);
}

function changeProp(name: string, value: unknown) {
  propDraft[name] = value;
  renderProps(); // condition 按当前草稿求值，改一项可能连带显隐其他项
  scheduleSave();
}

function mediaSrc(src: string): string {
  if (/^https?:\/\//i.test(src)) return src;
  if (!propItemId) return src;
  return `${MEDIA_BASE}/${encodeURIComponent(propItemId)}/${src.replace(/^\.\//, "")}`;
}

function renderMedia(media: { src: string; href?: string }[]): HTMLElement {
  const box = document.createElement("div");
  box.className = "prop-media";
  for (const m of media) {
    const img = document.createElement("img");
    img.src = mediaSrc(m.src);
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    img.loading = "lazy";
    if (m.href) {
      const a = document.createElement("a");
      a.href = m.href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.appendChild(img);
      box.appendChild(a);
    } else {
      box.appendChild(img);
    }
  }
  return box;
}

function renderProps() {
  const kw = propsFilterEl.value.trim().toLowerCase();
  const showHidden = propsAllEl.checked;
  // condition 求值用的值表：与主项目一致，取当前草稿（拖动开关即时联动）
  const vals: ConditionValues = propDraft as ConditionValues;
  propsBodyEl.textContent = "";
  if (propDefs.length === 0) {
    const hint = document.createElement("div");
    hint.className = "prop-hint";
    hint.textContent = t("props.empty");
    propsBodyEl.appendChild(hint);
    return;
  }

  // 按 WE 语义把 type=group 当可折叠分节：其后属性归属该组，直到下一个 group。
  type Section = { group: WebPropDef | null; items: WebPropDef[] };
  const sections: Section[] = [];
  let cur: Section = { group: null, items: [] };
  sections.push(cur);
  for (const p of propDefs) {
    if (p.ptype === "group") {
      cur = { group: p, items: [] };
      sections.push(cur);
      continue;
    }
    cur.items.push(p);
  }

  let shown = 0;
  const appendItem = (p: WebPropDef, parent: HTMLElement) => {
    const visible = evalCondition(p.condition, vals);
    if (!visible && !showHidden) return;
    if (kw && !`${p.name} ${p.text}`.toLowerCase().includes(kw)) return;
    if (p.ptype === "text" && !p.text && !(p.media && p.media.length)) return;
    shown++;
    if (p.ptype === "text") {
      const te = document.createElement("div");
      te.className = "prop-text";
      if (p.media && p.media.length) te.appendChild(renderMedia(p.media));
      if (p.text) {
        const cap = document.createElement("div");
        cap.className = "prop-text-cap";
        cap.textContent = p.text;
        te.appendChild(cap);
      }
      parent.appendChild(te);
      return;
    }
    parent.appendChild(renderPropRow(p, visible));
  };

  for (const sec of sections) {
    if (sec.group) {
      const visible = evalCondition(sec.group.condition, vals);
      if (!visible && !showHidden) continue;
      if (kw && !`${sec.group.name} ${sec.group.text}`.toLowerCase().includes(kw)
          && !sec.items.some((p) => `${p.name} ${p.text}`.toLowerCase().includes(kw))) {
        continue;
      }
      shown++;
      const details = document.createElement("details");
      details.className = "prop-group";
      details.open = propGroupOpen[sec.group.name] ?? true;
      details.ontoggle = () => {
        propGroupOpen[sec.group!.name] = details.open;
      };
      const summary = document.createElement("summary");
      summary.className = "prop-group-summary";
      summary.textContent = sec.group.text || sec.group.name;
      summary.title = sec.group.name;
      details.appendChild(summary);
      const body = document.createElement("div");
      body.className = "prop-group-body";
      for (const p of sec.items) appendItem(p, body);
      details.appendChild(body);
      // 过滤后组内无可见项：仍显示组标题（作者分隔），避免整段消失像「坏了」
      propsBodyEl.appendChild(details);
      continue;
    }
    for (const p of sec.items) appendItem(p, propsBodyEl);
  }

  if (shown === 0) {
    const hint = document.createElement("div");
    hint.className = "prop-hint";
    hint.textContent = t(kw ? "props.noMatch" : "props.allHidden");
    propsBodyEl.appendChild(hint);
  }
}

function renderPropRow(p: WebPropDef, visible: boolean): HTMLElement {
  const row = document.createElement("div");
  row.className = "prop";
  // 原始键名只放 title，主文案用 localization / 作者 text（避免面板上满屏 newproperty5）
  row.title = `${p.name} · ${p.ptype}`;
  if (!visible) row.classList.add("prop-cond"); // 条件隐藏但被强制显示：置灰提示
  const overridden = !sameValue(propDraft[p.name], p.default);
  if (overridden) row.classList.add("overridden");

  const head = document.createElement("div");
  head.className = "prop-head";
  const textWrap = document.createElement("div");
  textWrap.className = "prop-head-text";
  const nameEl = document.createElement("span");
  nameEl.className = "prop-name";
  nameEl.textContent = p.text || p.name;
  textWrap.appendChild(nameEl);

  if (p.ptype === "bool") {
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "prop-bool";
    cb.checked = !!propDraft[p.name];
    cb.onchange = () => changeProp(p.name, cb.checked);
    head.append(cb, textWrap);
  } else {
    head.appendChild(textWrap);
  }
  if (overridden) {
    const revert = document.createElement("button");
    revert.type = "button";
    revert.className = "prop-revert";
    revert.textContent = "↺";
    revert.title = "恢复默认";
    revert.onclick = () => changeProp(p.name, p.default);
    head.appendChild(revert);
  }
  row.appendChild(head);

  if (p.ptype === "bool") return row;

  const ctl = document.createElement("div");
  ctl.className = "prop-ctl";
  const cur = propDraft[p.name];
  switch (p.ptype) {
    case "color": {
      const col = document.createElement("input");
      col.type = "color";
      col.value = rgbStrToHex(String(cur ?? "0 0 0"));
      col.oninput = () => changeProp(p.name, hexToRgbStr(col.value));
      const txt = document.createElement("span");
      txt.className = "prop-key";
      txt.textContent = String(cur ?? "");
      ctl.append(col, txt);
      break;
    }
    case "slider": {
      // project.json 常不声明 min/max（WE 缺省 0..1）；precision 决定显示小数位与拖动粒度
      const min = p.min ?? 0;
      const max = p.max ?? 1;
      const prec = p.precision ?? (max - min <= 2 ? 3 : 0);
      const step = p.step ?? (prec > 0 ? 10 ** -prec : 1);
      const rng = document.createElement("input");
      rng.type = "range";
      rng.min = String(min);
      rng.max = String(max);
      rng.step = String(step);
      rng.value = String(Number(cur ?? min));
      const num = document.createElement("input");
      num.type = "text";
      num.className = "prop-num";
      num.value = Number(cur ?? min).toFixed(prec);
      rng.oninput = () => {
        num.value = Number(rng.value).toFixed(prec);
        changeProp(p.name, Number(rng.value));
      };
      num.onchange = () => {
        const n = Number(num.value);
        if (Number.isFinite(n)) changeProp(p.name, n);
      };
      ctl.append(rng, num);
      break;
    }
    case "combo": {
      const sel = document.createElement("select");
      for (const [i, o] of (p.options ?? []).entries()) {
        // 选项自身也可带 condition（少见但真实存在）
        if (!evalCondition(o.condition, propDraft as ConditionValues)) continue;
        const opt = document.createElement("option");
        opt.value = String(i); // 用下标做 value，避免把声明类型压成字符串
        opt.textContent = o.label;
        if (sameValue(o.value, cur)) opt.selected = true;
        sel.appendChild(opt);
      }
      sel.onchange = () => {
        const o = (p.options ?? [])[Number(sel.value)];
        if (o) changeProp(p.name, o.value);
      };
      ctl.appendChild(sel);
      break;
    }
    case "file":
    case "directory":
    case "scenetexture": {
      // 测试台没有原生文件选择框（主项目走 tauri dialog）：直接填相对壁纸根的路径
      const txt = document.createElement("input");
      txt.type = "text";
      txt.value = String(cur ?? "");
      txt.placeholder = p.ptype === "directory" ? t("props.dirPh") : t("props.filePh", { kind: p.fileType ?? "image" });
      txt.onchange = () => changeProp(p.name, txt.value);
      ctl.appendChild(txt);
      break;
    }
    default: {
      const txt = document.createElement("input");
      txt.type = "text";
      txt.value = String(cur ?? "");
      txt.onchange = () => changeProp(p.name, txt.value);
      ctl.appendChild(txt);
    }
  }
  row.appendChild(ctl);
  return row;
}

propsFilterEl.oninput = renderProps;
propsAllEl.onchange = renderProps;

function setPropsOpen(open: boolean) {
  propsEl.hidden = !open;
  workspaceEl.classList.toggle("props-open", open);
  togglePropsEl.classList.toggle("checked", open);
}

togglePropsEl.onclick = () => {
  if (!selected) {
    log(t("err.selectFirst"), true);
    return;
  }
  const next = propsEl.hidden;
  setPropsOpen(next);
  if (next && propItemId !== selected.itemId) void loadProps(selected.itemId);
};
$<HTMLButtonElement>("#props-close").onclick = () => {
  setPropsOpen(false);
};
$<HTMLButtonElement>("#props-reset").onclick = () => {
  for (const p of propDefs) if (p.value !== null) propDraft[p.name] = p.default;
  renderProps();
  scheduleSave();
};

void (async () => {
  try {
    const savedType = localStorage.getItem(TYPE_KEY);
    if (savedType === "scene" || savedType === "web" || savedType === "video") {
      setTypeFilter(savedType);
    }
  } catch {
    /* 隐私模式：留在默认的 scene */
  }
  if (await probeBackend()) {
    try {
      const saved = localStorage.getItem(LIB_DIR_KEY);
      if (saved) await setLibraryDir(saved);
    } catch {
      /* 首次或隐私模式：用 Vite / WE_LIBRARY 默认目录 */
    }
    await loadLibrary();
    connectDiag();
  } else {
    enterStaticMode();
  }
})();

// PWA：仅生产构建注册（dev 注册会干扰 HMR）。静态托管下可安装、离线可看使用说明。
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {
    /* 注册失败不影响页面功能 */
  });
}
