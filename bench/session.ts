/**
 * 当前会话：选中哪个壁纸、怎么挂到渲染器 iframe 上，以及主工具条的运行控制
 * （暂停 / 恢复、重挂载、释放、新窗口、在编辑器中打开）。
 */

import { $, emit, on, state, type LibraryItem } from "./store";
import { t } from "./i18n";
import { MEDIA_BASE, WEB_BASE, ensureRenderer, frameEl, rendererUrl, wp } from "./bridge";
import { log } from "./console";
import { appendViewportQuery, setStageActive } from "./viewport";
import { appendRenderQuery } from "./render-settings";
import { tabs } from "./layout";

const currentEl = $<HTMLElement>("#current");
const pauseBtn = $<HTMLButtonElement>("#pause");

/** 把库条目翻译成渲染器 query，语义对齐原生侧 wallpaper/mod.rs */
export function buildQuery(it: LibraryItem): string {
  // project.json type 大小写混用（Web/Scene）；与 kindOf / dispatch 一样先小写
  const type = it.hasScene || it.hasLooseScene ? "scene" : it.type.toLowerCase();
  const p = new URLSearchParams();
  p.set("type", type);
  if (type === "scene") {
    // 场景：src 是 itemId，渲染器自行拼 scene.pkg 或按 project.json 的 file 走松散目录
    p.set("src", it.itemId);
  } else if (type === "web") {
    p.set("src", `${WEB_BASE}/${it.itemId}/${it.file ?? "index.html"}`);
  } else if (it.file) {
    p.set("src", `${MEDIA_BASE}/${it.itemId}/${it.file}`);
  }
  appendViewportQuery(p);
  appendRenderQuery(p);
  p.set("loop", "true");
  p.set("mediaBase", MEDIA_BASE);
  return p.toString();
}

function syncCurrentLabel() {
  if (state.selected) {
    currentEl.removeAttribute("data-i18n");
    currentEl.textContent = state.selected.title;
    currentEl.parentElement!.title = `${state.selected.title}（${state.selected.itemId}）`;
  } else if (state.localFile) {
    currentEl.removeAttribute("data-i18n");
    currentEl.textContent = state.localFile.name;
    currentEl.parentElement!.title = state.localFile.name;
  } else {
    currentEl.dataset.i18n = "tab.wallpaper";
    currentEl.textContent = t("tab.wallpaper");
    currentEl.parentElement!.title = "";
  }
}

// 暂停/恢复合成一个切换按钮：图标即状态（运行中显示暂停图标，已暂停显示播放图标）。
// 运行态只在本侧跟踪；重挂载/换壁纸后渲染器回到运行态，随 mount() 复位。
let running = true;

export function setRunToggle(next: boolean) {
  running = next;
  const key = running ? "toolbar.pause" : "toolbar.resume";
  pauseBtn.dataset.i18nTitle = key;
  pauseBtn.title = t(key);
  pauseBtn.classList.toggle("is-play", !running);
  pauseBtn.querySelector(".ic-pause")?.toggleAttribute("hidden", !running);
  pauseBtn.querySelector(".ic-play")?.toggleAttribute("hidden", running);
}

export function isRunning() {
  return running;
}

export function togglePause() {
  if (!state.selected && !state.localFile) return;
  const api = wp();
  if (!api) return;
  if (running) api.pause();
  else api.resume();
  setRunToggle(!running);
}

export function mount() {
  const it = state.selected;
  if (!it) return;
  const q = buildQuery(it);
  setStageActive(true);
  // 每次都换 src（含时间戳）强制重载，避免 WebGL 上下文复用掩盖泄漏问题
  frameEl.src = rendererUrl(`${q}&_t=${Date.now()}`);
  setRunToggle(true);
  emit("mounted");
  log(t("log.mount", { id: it.itemId, q }));
}

export function select(it: LibraryItem) {
  state.selected = it;
  state.localFile = null;
  syncCurrentLabel();
  mount();
  tabs.center.select("viewport");
  emit("selection");
}

export function clearSelection() {
  state.selected = null;
  state.localFile = null;
  frameEl.removeAttribute("src");
  setStageActive(false);
  syncCurrentLabel();
  emit("mounted");
  emit("selection");
}

/** 本地 .pkg 预览：字节全程不离开本机，由渲染器页直接解包 */
export async function openLocalFile(file: File) {
  try {
    const api = await ensureRenderer();
    api.loadSceneFile(file);
    state.selected = null;
    state.localFile = file;
    syncCurrentLabel();
    setStageActive(true);
    setRunToggle(true); // loadSceneFile 在渲染器侧回到运行态
    tabs.center.select("viewport");
    emit("mounted");
    emit("selection");
    log(t("log.filePreview", { name: file.name }));
  } catch (e) {
    log(t("err.filePreview", { msg: (e as Error).message }), "error");
  }
}

export function openInNewWindow() {
  if (!state.selected) return;
  window.open(rendererUrl(buildQuery(state.selected)), "_blank");
}

export function openInEditor(itemId = state.selected?.itemId) {
  if (!itemId) return;
  window.open(`${import.meta.env.BASE_URL}editor/?item=${encodeURIComponent(itemId)}`, "_blank");
}

export function release() {
  if (!state.selected && !state.localFile) return;
  wp()?.release();
}

// ---------- 主工具条 ----------

const pkgFileEl = $<HTMLInputElement>("#pkg-file");

export function pickLocalFile() {
  pkgFileEl.click();
}

$<HTMLButtonElement>("#open-pkg").onclick = pickLocalFile;
pkgFileEl.onchange = () => {
  const file = pkgFileEl.files?.[0];
  pkgFileEl.value = ""; // 允许重复选择同一文件
  if (file) void openLocalFile(file);
};
pauseBtn.onclick = togglePause;
$<HTMLButtonElement>("#reload").onclick = () => mount();
$<HTMLButtonElement>("#release").onclick = release;
$<HTMLButtonElement>("#open").onclick = openInNewWindow;
$<HTMLButtonElement>("#open-editor").onclick = () => openInEditor();

function syncTransport() {
  const hasItem = !!state.selected;
  const hasAny = hasItem || !!state.localFile;
  pauseBtn.disabled = !hasAny;
  $<HTMLButtonElement>("#reload").disabled = !hasItem;
  $<HTMLButtonElement>("#release").disabled = !hasAny;
  $<HTMLButtonElement>("#open").disabled = !hasItem;
  $<HTMLButtonElement>("#open-editor").disabled = !hasItem;
}

on("open-file", (file) => void openLocalFile(file));
on("remount", () => {
  if (state.selected) mount();
});
on("selection", syncTransport);
syncTransport();
setRunToggle(true);
syncCurrentLabel();
