/**
 * 测试台入口：组装工作台外壳（标题栏菜单、面板布局、主题 / 语言）与各面板模块，
 * 然后连上宿主后端载入壁纸库。
 *
 * 模块分工：
 *   bridge          iframe 渲染器页与 __wp 遥控
 *   session         选中 / 挂载 / 本地 .pkg / 运行控制
 *   library         左侧壁纸库
 *   viewport        中央视口（舞台缩放、视口工具条、遮挡模拟、拖放）
 *   props-panel     右侧「壁纸配置」
 *   render-settings 右侧「渲染设置」
 *   info-panel      右侧「信息」
 *   console / perf  底部控制台与帧率曲线
 *   statusbar       状态栏
 *   layout          分隔条与标签页
 */

import pkg from "../package.json";
import { applyPlatformClasses } from "../shared/workbench/platform";
import { bindThemeButton, getThemeMode, setThemeMode, type ThemeMode } from "../shared/workbench/theme";
import { createMenubar, type MenuItem } from "../shared/workbench/menu";
import { getLang, onChangeLang, setLang, t, type Lang } from "./i18n";
import { load, save } from "../shared/workbench/storage";
import { DOC_KINDS, renderDocs, type DocKind } from "./docs";
import { $, state } from "./store";
import { connectDiag, log } from "./console";
import { panels, resetLayout, tabs } from "./layout";
import { syncBackend, syncStatusChrome } from "./statusbar";
import { layoutStage } from "./viewport";
import "./render-settings";
import {
  isRunning,
  mount,
  openInNewWindow,
  pickLocalFile,
  release,
  setRunToggle,
  togglePause,
} from "./session";
import { bootLibrary, loadLibrary, pickLibrary, renderList, revealItem } from "./library";
import { refreshPropsPanel } from "./props-panel";
import { renderInfo } from "./info-panel";
import "./perf";

applyPlatformClasses();

const REPO_URL = "https://github.com/oneincase/webwallgl";

$<HTMLElement>("#app-version").textContent = `v${pkg.version}`;

// ---------- 主题 / 语言 ----------

const themeBtn = bindThemeButton($("#theme-toggle"), (mode) => t(`theme.${mode}`));
const langEl = $<HTMLSelectElement>("#lang");
langEl.value = getLang();
langEl.onchange = () => setLang(langEl.value as Lang);

// ---------- 使用说明 / 赞赏 ----------

const DOC_KIND_KEY = "we-bench-docs-kind";
const docsBodyEl = $<HTMLElement>("#docs-body");
const docsViewEl = $<HTMLElement>("#docs-view");
const docsSwitchBtns = [...document.querySelectorAll<HTMLButtonElement>("#docs-switch [data-doc]")];
const asDocKind = (v: string | null | undefined): DocKind | null =>
  DOC_KINDS.includes(v as DocKind) ? (v as DocKind) : null;
let docKind: DocKind = asDocKind(load(DOC_KIND_KEY)) ?? "library";

function renderDocKind() {
  renderDocs(docsBodyEl, docKind, getLang());
  for (const b of docsSwitchBtns) {
    const on = b.dataset.doc === docKind;
    b.classList.toggle("active", on);
    b.setAttribute("aria-checked", String(on));
  }
}

function showDocs(kind: DocKind = docKind) {
  if (kind !== docKind) {
    docKind = kind;
    save(DOC_KIND_KEY, kind);
    renderDocKind();
    docsViewEl.scrollTop = 0;
  }
  tabs.center.select("docs");
}

for (const b of docsSwitchBtns) b.onclick = () => showDocs(asDocKind(b.dataset.doc) ?? docKind);
renderDocKind();

// 外部入口（如编辑器的帮助按钮）用 #docs=editor / #docs=library 直达对应说明
function applyDocsHash() {
  const m = /^#docs(?:=(\w+))?$/.exec(location.hash);
  if (!m) return;
  showDocs(asDocKind(m[1]) ?? docKind);
  history.replaceState(null, "", location.pathname + location.search);
}
applyDocsHash();
window.addEventListener("hashchange", applyDocsHash);

function showSponsor() {
  tabs.center.select("docs");
  requestAnimationFrame(() =>
    $<HTMLElement>("#sponsor-card").scrollIntoView({ behavior: "smooth", block: "center" }),
  );
}

$<HTMLButtonElement>("#sponsor-btn").onclick = showSponsor;
// 赞赏码：某张图加载失败时隐藏整个项（如海外码补充前不露破图）
for (const img of document.querySelectorAll<HTMLImageElement>(".sponsor-qr-item img")) {
  img.addEventListener("error", () => img.closest(".sponsor-qr-item")?.setAttribute("hidden", ""));
}

// ---------- 布局 ----------

function doResetLayout() {
  resetLayout();
  log(t("log.layoutReset"));
}

$<HTMLButtonElement>("#layout-reset").onclick = doResetLayout;

// ---------- 菜单 ----------

const hasItem = () => !!state.selected;
const hasMount = () => !!(state.selected || state.localFile);
const themeItem = (mode: ThemeMode): MenuItem => ({
  label: () => t(`theme.${mode}`),
  checked: () => getThemeMode() === mode,
  action: () => setThemeMode(mode),
});

const menubar = createMenubar($("#menubar"), [
  {
    label: () => t("menu.file"),
    items: [
      { label: () => t("menu.openPkg"), keys: "mod+o", action: pickLocalFile },
      {
        label: () => t("menu.pickLib"),
        keys: "mod+shift+o",
        disabled: () => state.backend === "down",
        action: pickLibrary,
      },
      { label: () => t("menu.refreshLib"), action: () => void loadLibrary() },
      "sep",
      { label: () => t("menu.newWindow"), disabled: () => !hasItem(), action: openInNewWindow },
      {
        label: () => t("menu.reveal"),
        disabled: () => !hasItem(),
        action: () => state.selected && void revealItem(state.selected.itemId),
      },
    ],
  },
  {
    label: () => t("menu.view"),
    items: [
      {
        label: () => t("menu.panelLibrary"),
        keys: "mod+b",
        checked: () => !panels.left.isCollapsed(),
        action: () => panels.left.toggle(),
      },
      {
        label: () => t("menu.panelInspector"),
        keys: "mod+i",
        checked: () => !panels.right.isCollapsed(),
        action: () => panels.right.toggle(),
      },
      {
        label: () => t("menu.panelConsole"),
        keys: "mod+j",
        checked: () => !panels.bottom.isCollapsed(),
        action: () => panels.bottom.toggle(),
      },
      "sep",
      { label: () => t("tab.viewport"), checked: () => tabs.center.current() === "viewport", action: () => tabs.center.select("viewport") },
      { label: () => t("menu.docs"), checked: () => tabs.center.current() === "docs", action: () => showDocs() },
      "sep",
      { label: () => t("menu.resetLayout"), action: doResetLayout },
      "sep",
      themeItem("auto"),
      themeItem("dark"),
      themeItem("light"),
    ],
  },
  {
    label: () => t("menu.playback"),
    items: [
      {
        label: () => t(isRunning() ? "toolbar.pause" : "toolbar.resume"),
        disabled: () => !hasMount(),
        action: togglePause,
      },
      { label: () => t("toolbar.reload"), disabled: () => !hasItem(), action: mount },
      { label: () => t("toolbar.release"), disabled: () => !hasMount(), action: release },
    ],
  },
  {
    label: () => t("menu.help"),
    items: [
      { label: () => t("docs.library"), action: () => showDocs("library") },
      { label: () => t("docs.editor"), action: () => showDocs("editor") },
      "sep",
      { label: () => t("sponsor.title"), action: showSponsor },
      "sep",
      { label: () => t("menu.repo"), action: () => window.open(REPO_URL, "_blank") },
      { label: () => t("menu.issues"), action: () => window.open(`${REPO_URL}/issues`, "_blank") },
    ],
  },
]);

// ---------- 语言切换后重刷动态文案（静态部分由 i18n.applyStatic 处理） ----------

onChangeLang(() => {
  menubar.refresh();
  themeBtn.refresh();
  renderDocKind();
  syncStatusChrome();
  syncBackend();
  layoutStage();
  renderList();
  renderInfo();
  refreshPropsPanel();
  setRunToggle(isRunning());
});

// ---------- 启动 ----------

syncStatusChrome();
layoutStage();
void (async () => {
  await bootLibrary();
  if (state.backend === "ok") connectDiag();
})();
