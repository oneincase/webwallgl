/**
 * 编辑器页（EDITOR-PLAN §3A）。P0：工作台壳 + 打开 + 预览 + 只读图层树 / 检视器 + 控制台；
 * P1：时间轴（seek / 逐帧 / 倍速）、画面点选 ↔ 图层树、导出 PNG；
 * P2：属性热改 + 变换手柄 + 撤销重做，结构编辑（删除 / 复制 / 重排）走「文档改 → 整场景重挂」。
 *
 * 与测试台的区别：不走 iframe + 渲染页遥控接口，而是同页直接 `mount()` ——
 * 编辑需要同步拿活引用、逐帧控制时钟。引擎能力只经 `webwallgl/editor`
 * （及底座 `webwallgl/core`）公开出口取用；页面缺什么，就在写测线补公开 API，
 * 不读调试探针（verify-arch 有断言）。
 */

import {
  checkSceneScript,
  editorOf,
  mount,
  type EditorControls,
  type EditorLayer,
  type EditorLayerProps,
  type Fit,
  type SceneInstance,
} from "../renderer/src/api/editor";
import { getLang, onChangeLang, setLang, t, type Lang } from "../bench/i18n";
import { applyEditorStatic, et } from "./i18n";
import { overlayAssets, type OverlayAssets } from "./assets";
import {
  RESOLUTIONS,
  addImageLayer,
  blankScene,
  hexToRgb,
  imageLayerFiles,
  imageSlug,
  isImageFile,
  modelPathOf,
  newProject,
  readImageFile,
  referencedModels,
  type ImageInput,
} from "./create";
import { applyDraft, idbDraftStore, makeDraft, type Draft, type DraftOrigin } from "./draft";
import {
  EFFECTS,
  addEffect,
  effectById,
  effectFileOf,
  effectFiles,
  effectViews,
  moveEffect,
  referencedEffects,
  removeEffect,
  setEffectParam,
  setEffectVisible,
  type EffectValue,
  type EffectView,
} from "./effects";
import { addableTargets, removeScript, scriptSlots, scriptTemplate, setScript } from "./scripts";
import {
  PROP_TYPES,
  bindProp,
  bindableFor,
  bindingOf,
  coerceValue,
  declareProp,
  formatComboOptions,
  isValidPropName,
  listProps,
  parseComboOptions,
  propOf,
  removeProp,
  setComboOptions,
  setPropText,
  setPropValue,
  setSliderRange,
  unbindProp,
  type PropType,
  type PropView,
} from "./userprops";
import { scriptsAllowedByDefault, scriptsOverrideFrom } from "./trust";
import {
  duplicateLayer,
  findNode,
  findPath,
  makeDoc,
  moveLayer,
  removeLayer,
  sceneResolution,
  unwrap,
  writeObjProps,
  type EditorDoc,
  type LayerNode,
} from "./doc";
import {
  DRAG_THRESHOLD,
  HANDLE,
  cyclePick,
  gizmoOf,
  handleAt,
  layerAxes,
  rotateZ,
  scaleXY,
  type Gizmo,
  type Pt,
} from "./gizmo";
import {
  EditHistory,
  isNoopEdit,
  isStruct,
  mergeLiveEdit,
  pickProps,
  restoreObjects as restoreDocObjects,
  structCommand,
  type Patch,
  type PropsCmd,
} from "./history";
import {
  collectDropped,
  fetchLibrary,
  filesFromInput,
  libraryKind,
  openLibraryItem,
  openLocalFiles,
  sourceFromDoc,
  type LibraryItem,
  type Opened,
  type SceneAssets,
} from "./open";
import {
  canPickDirectory,
  collectProject,
  downloadZip,
  newLibraryItemId,
  pickDirectory,
  saveToLibrary,
  slugName,
  totalBytes,
  writeToDirectory,
} from "./save";

const TOKEN = "dev"; // 与 host/wallpaper-host.ts 的 DEV_TOKEN 一致
const MEDIA_BASE = `${location.origin}/media/${TOKEN}`;
const WEB_BASE = `${location.origin}/web/${TOKEN}`;

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

const docTitleEl = $<HTMLElement>("#ed-doc-title");
const libListEl = $<HTMLUListElement>("#ed-lib-list");
const libCountEl = $<HTMLElement>("#ed-lib-count");
const filterEl = $<HTMLInputElement>("#ed-filter");
const treeEl = $<HTMLElement>("#ed-tree");
const layerCountEl = $<HTMLElement>("#ed-layer-count");
const inspectorEl = $<HTMLElement>("#ed-inspector");
const viewportEl = $<HTMLElement>("#ed-viewport");
const stageEl = $<HTMLElement>("#ed-stage");
const emptyEl = $<HTMLElement>("#ed-empty");
const dropEl = $<HTMLElement>("#ed-drop");
const conBodyEl = $<HTMLPreElement>("#ed-con-body");
const conCountEl = $<HTMLElement>("#ed-con-count");
const aspectEl = $<HTMLSelectElement>("#tb-aspect");
const fitEl = $<HTMLSelectElement>("#tb-fit");
const dprEl = $<HTMLSelectElement>("#tb-dpr");
const playEl = $<HTMLButtonElement>("#tb-play");
const reloadEl = $<HTMLButtonElement>("#tb-reload");
const exportEl = $<HTMLButtonElement>("#tb-export");
const tlStartEl = $<HTMLButtonElement>("#tl-start");
const tlPrevEl = $<HTMLButtonElement>("#tl-prev");
const tlNextEl = $<HTMLButtonElement>("#tl-next");
const tlTimeEl = $<HTMLElement>("#tl-time");
const tlRangeEl = $<HTMLInputElement>("#tl-range");
const tlMaxEl = $<HTMLElement>("#tl-max");
const tlSpeedEl = $<HTMLSelectElement>("#tl-speed");
const undoEl = $<HTMLButtonElement>("#tb-undo");
const redoEl = $<HTMLButtonElement>("#tb-redo");
const inPkgEl = $<HTMLInputElement>("#in-pkg");
const inDirEl = $<HTMLInputElement>("#in-dir");
const stDocEl = $<HTMLElement>("#st-doc");
const stFormEl = $<HTMLElement>("#st-form");
const stLayersEl = $<HTMLElement>("#st-layers");
const stResEl = $<HTMLElement>("#st-res");
const stFpsEl = $<HTMLElement>("#st-fps");

// ---------- 控制台 ----------

const CON_MAX = 500;
let conLines = 0;

function log(msg: string, level: "info" | "warn" | "error" = "info") {
  const line = document.createElement("div");
  if (level !== "info") line.className = level;
  const ts = new Date().toTimeString().slice(0, 8);
  line.textContent = `[${ts}] ${msg}`;
  conBodyEl.appendChild(line);
  if (++conLines > CON_MAX) {
    conBodyEl.firstElementChild?.remove();
    conLines--;
  }
  conCountEl.textContent = String(conLines);
  conBodyEl.scrollTop = conBodyEl.scrollHeight;
}

$<HTMLButtonElement>("#ed-con-clear").onclick = () => {
  conBodyEl.textContent = "";
  conLines = 0;
  conCountEl.textContent = "";
};

// ---------- 主题 / 语言（与测试台共用 localStorage 键） ----------

type ThemeMode = "auto" | "dark" | "light";
const THEME_KEY = "webwallgl-theme";
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
const themeToggleEl = $<HTMLButtonElement>("#theme-toggle");
let themeMode: ThemeMode = "auto";

function applyTheme(mode: ThemeMode) {
  themeMode = mode;
  document.documentElement.dataset.theme = mode === "auto" ? (darkQuery.matches ? "dark" : "light") : mode;
  themeToggleEl.title = t(`theme.${mode}`);
  for (const ic of themeToggleEl.querySelectorAll<SVGSVGElement>(".ic")) {
    if (ic.classList.contains(`ic-${mode}`)) ic.removeAttribute("hidden");
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

try {
  const saved = localStorage.getItem(THEME_KEY);
  applyTheme(saved === "dark" || saved === "light" ? saved : "auto");
} catch {
  applyTheme("auto");
}
darkQuery.addEventListener("change", () => {
  if (themeMode === "auto") applyTheme("auto");
});

const langEl = $<HTMLSelectElement>("#lang");
langEl.value = getLang();
langEl.onchange = () => setLang(langEl.value as Lang);
onChangeLang(() => {
  applyTheme(themeMode);
  renderLibrary();
  renderTree();
  renderInspector();
  renderStatus();
  syncPlayButton();
});

// ---------- 视口：按宽高比摆舞台 ----------

function layoutStage() {
  const style = getComputedStyle(viewportEl);
  const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  const availW = Math.max(0, viewportEl.clientWidth - padX);
  const availH = Math.max(0, viewportEl.clientHeight - padY);
  let w = availW;
  let h = availH;
  if (aspectEl.value !== "fill") {
    const [aw, ah] = aspectEl.value.split(":").map(Number);
    const r = aw / ah;
    if (availW / availH > r) w = availH * r;
    else h = availW / r;
  }
  stageEl.style.width = `${Math.floor(w)}px`;
  stageEl.style.height = `${Math.floor(h)}px`;
}

new ResizeObserver(layoutStage).observe(viewportEl);
aspectEl.onchange = () => {
  layoutStage();
  renderStatus();
};

// ---------- 当前文档与实例 ----------

let doc: EditorDoc | null = null;
let current: Opened | null = null;
let instance: SceneInstance | null = null;
let editor: EditorControls | null = null;
let openGen = 0;
let selectedId: number | string | null = null;
const collapsed = new Set<number | string>();
/** 页面级锁定（不进文档）：锁定层不参与点选、不能拖、检视器只读 */
const locked = new Set<string>();
const isLocked = (id: number | string | null) => id !== null && locked.has(String(id));
/**
 * 发生过结构编辑（增删 / 复制 / 重排）后，引擎改从文档挂载（sourceFromDoc）——
 * 原始来源里没有这些改动。纯属性热改不切：热改已写回文档，原始来源 + 重放即等价，
 * 还能吃库内 pkg 缓存。
 */
let docDriven = false;
const SCRIPTS_OVERRIDE = scriptsOverrideFrom(location.search);
/** 本文档的壁纸脚本是否执行（见 trust.ts）；放行后对本文档的每次重挂都生效 */
let scriptsAllowed = true;
/** 当前文档的资源表（原始来源 + 页面新增素材）；非场景 / 取不到场景资源时为 null */
let overlay: OverlayAssets | null = null;
/** 草稿来源；null = 本地文件 / 目录（刷新后 File 句柄失效，不做草稿） */
let origin: DraftOrigin | null = null;

function destroyInstance() {
  if (!instance) return;
  try {
    instance.destroy({ releasePkgCache: true });
  } catch {
    /* 销毁失败不阻断换源 */
  }
  instance = null;
  editor = null;
  drag = null;
  stageEl.textContent = "";
  syncTimeline();
}

/** keepTime：结构编辑后的重挂接着原时间点看，而不是从 0 秒重新开场 */
async function mountCurrent(keepTime = false) {
  if (!current) return;
  const gen = ++openGen;
  const resumeAt = keepTime ? editor?.time ?? 0 : 0;
  destroyInstance();
  syncPlayButton();
  try {
    const source =
      docDriven && current.assets && doc?.scene
        ? sourceFromDoc(current.source, current.assets, JSON.stringify(doc.scene), doc.project)
        : current.source;
    const inst = await mount(stageEl, {
      source,
      fit: fitEl.value as Fit,
      renderDpr: Number(dprEl.value),
      volume: 0,
      scripts: scriptsAllowed,
      onDiagnostic: (msg, level) => log(msg, level),
    });
    if (gen !== openGen) {
      inst.destroy({ releasePkgCache: true });
      return;
    }
    instance = inst;
    editor = editorOf(inst);
    if (editor) {
      editor.setTimeScale(Number(tlSpeedEl.value));
      await replayLiveEdits();
      if (resumeAt > 0) await editor.seek(resumeAt).catch(() => {});
    } else {
      log(et("log.noEditor"), "warn");
    }
    resetTimelineRange();
    renderTree();
    renderInspector();
    syncScriptsBanner();
    const info = inst.info;
    if (info && doc?.type === "scene") log(et("log.ready", { w: info.width, h: info.height, n: info.layerCount }));
    else log(et("log.readyPlain"));
  } catch (e) {
    if (gen !== openGen) return;
    const err = e as Error & { instance?: SceneInstance };
    instance = err.instance ?? null;
    log(et("log.mountFailed", { msg: err.message }), "error");
  }
  syncPlayButton();
  syncTimeline();
  renderStatus();
}

// ---------- 外来脚本（W10 过渡：在线版默认不执行，逐文档放行） ----------

const scriptsBannerEl = $<HTMLElement>("#ed-scripts-off");
const scriptsBannerTextEl = $<HTMLElement>("#ed-scripts-off-text");

function syncScriptsBanner() {
  const skipped = !scriptsAllowed ? editor?.getSkippedScripts() ?? 0 : 0;
  scriptsBannerEl.hidden = skipped === 0;
  if (skipped) scriptsBannerTextEl.textContent = et("scripts.blocked", { n: skipped });
}

$<HTMLButtonElement>("#scripts-allow").onclick = () => {
  scriptsAllowed = true;
  scriptsBannerEl.hidden = true;
  log(et("log.scriptsAllowed"), "warn");
  void mountCurrent(true);
};

/** 资源表的分组引用：图片层的模型 + 图层挂的效果文件 */
const referencedGroups = (d: EditorDoc | null) => new Set([...referencedModels(d), ...referencedEffects(d)]);

type OpenOptions = {
  origin?: DraftOrigin | null;
  /** 新建工程没有原始来源可挂，一开始就从文档挂载 */
  docDriven?: boolean;
  /** 文档就位、首次挂载之前执行（新建时放背景图、恢复草稿时套用快照） */
  after?: () => void;
};

async function openWith(name: string, load: () => Promise<Opened>, opts: OpenOptions = {}) {
  log(et("log.opening", { name }));
  const gen = ++openGen;
  let opened: Opened;
  try {
    opened = await load();
  } catch (e) {
    if (gen !== openGen) return;
    const msg = (e as Error).message;
    log(msg === "no-wallpaper" ? et("log.dropEmpty") : et("log.openFailed", { msg }), "error");
    return;
  }
  // 本地文件的脚本策略取决于宿主在不在（首次读库结束才知道）
  if (!opts.origin) await libReady;
  if (gen !== openGen) return;
  current?.source.dispose?.();
  overlay =
    opened.assets && opened.doc.scene ? overlayAssets(opened.assets.entry, opened.assets, () => referencedGroups(doc)) : null;
  if (overlay) opened = { ...opened, assets: overlay };
  current = opened;
  doc = opened.doc;
  selectedId = null;
  collapsed.clear();
  locked.clear();
  scriptDrafts.clear();
  docDriven = !!opts.docDriven;
  origin = opts.origin ?? null;
  scriptsAllowed = scriptsAllowedByDefault(origin?.kind ?? "local", libState === "ready", SCRIPTS_OVERRIDE);
  scriptsBannerEl.hidden = true;
  lastSave = null;
  resetHistory();
  opts.after?.();
  if (doc.type === "scene" && !doc.scene) log(et("log.noScene"), "warn");
  emptyEl.hidden = true;
  syncDocTitle();
  reloadEl.disabled = false;
  renderTree();
  renderInspector();
  renderStatus();
  await mountCurrent();
}

fitEl.onchange = () => instance?.setFit(fitEl.value as Fit);
// 改 DPR 走页面级整场景重挂（而非 setRenderDpr 的实例内重挂）：mountCurrent 会把
// 倍速与累计热改一并重放到新的一代引擎上
dprEl.onchange = () => void mountCurrent();
reloadEl.onclick = () => void mountCurrent();

function syncPlayButton() {
  playEl.disabled = !instance;
  const paused = !!instance?.paused;
  playEl.title = et(paused ? "tb.play" : "tb.pause");
  playEl.querySelector(".ic-play")?.toggleAttribute("hidden", !paused);
  playEl.querySelector(".ic-pause")?.toggleAttribute("hidden", paused);
}

playEl.onclick = () => {
  if (!instance) return;
  if (instance.paused) instance.resume();
  else instance.pause();
  syncPlayButton();
};

// ---------- 时间轴（W1 可控时钟） ----------

const TL_WINDOW = 30;
let tlMax = TL_WINDOW;
let scrubbing = false;
const FRAME = 1 / 60;

function fmtTime(s: number): string {
  return `${s.toFixed(2)}s`;
}

function setTimelineMax(max: number) {
  tlMax = max;
  tlRangeEl.max = String(max);
  tlMaxEl.textContent = `${max}s`;
}

function resetTimelineRange() {
  setTimelineMax(TL_WINDOW);
}

function syncTimeline() {
  const on = !!editor;
  for (const el of [tlStartEl, tlPrevEl, tlNextEl, tlRangeEl, tlSpeedEl, exportEl]) el.disabled = !on;
  if (!on) {
    tlRangeEl.value = "0";
    tlTimeEl.textContent = fmtTime(0);
  }
}

function tickTimeline() {
  requestAnimationFrame(tickTimeline);
  drawOverlay();
  if (!editor || scrubbing) return;
  const t = editor.time;
  // 场景壁纸没有时长概念（循环播放），滑条窗口按 30s 一档向后扩
  if (t > tlMax) setTimelineMax(Math.ceil(t / TL_WINDOW) * TL_WINDOW);
  tlRangeEl.value = String(t);
  tlTimeEl.textContent = fmtTime(t);
}

function pauseForStepping() {
  if (instance && !instance.paused) {
    instance.pause();
    syncPlayButton();
  }
}

const seekLogged = (p: Promise<void>) => p.catch((e) => log(String((e as Error)?.message ?? e), "warn"));

tlRangeEl.addEventListener("pointerdown", () => (scrubbing = true));
tlRangeEl.addEventListener("pointerup", () => (scrubbing = false));
tlRangeEl.addEventListener("change", () => (scrubbing = false));
tlRangeEl.addEventListener("input", () => {
  if (!editor) return;
  const t = Number(tlRangeEl.value);
  tlTimeEl.textContent = fmtTime(t);
  void seekLogged(editor.seek(t));
});
tlStartEl.onclick = () => {
  if (editor) void seekLogged(editor.seek(0));
};
tlPrevEl.onclick = () => {
  if (!editor) return;
  pauseForStepping();
  void seekLogged(editor.seek(Math.max(0, editor.time - FRAME)));
};
tlNextEl.onclick = () => {
  if (!editor) return;
  pauseForStepping();
  void seekLogged(editor.step(1, 60));
};
tlSpeedEl.onchange = () => editor?.setTimeScale(Number(tlSpeedEl.value));

// ---------- 导出 PNG（W3） ----------

exportEl.onclick = async () => {
  if (!editor || !doc) return;
  exportEl.disabled = true;
  try {
    const res = sceneResolution(doc.scene);
    const blob = await editor.capture(res ? { width: res.w, height: res.h } : {});
    const bmp = await createImageBitmap(blob);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${doc.title.replace(/[\\/:*?"<>|]+/g, "_")}-${editor.time.toFixed(2)}s.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    log(et("log.exported", { w: bmp.width, h: bmp.height, kb: Math.round(blob.size / 1024) }));
    bmp.close();
  } catch (e) {
    log(et("log.exportFailed", { msg: (e as Error).message }), "error");
  } finally {
    exportEl.disabled = !editor;
  }
};

// ---------- 保存（W6-lite：松散工程 → 壁纸库 / 文件夹 / zip） ----------

type SaveTarget = "lib" | "dir" | "zip";
const saveEl = $<HTMLButtonElement>("#tb-save");
const saveMenuEl = $<HTMLElement>("#save-menu");
const saveLibEl = $<HTMLButtonElement>("#save-lib");
const saveDirEl = $<HTMLButtonElement>("#save-dir");
let saving = false;
/** 本文档上次保存的目标：⌘S 直接重复；库条目 id 复用，再存即覆盖同一条 */
let lastSave: { target: SaveTarget; itemId?: string; dir?: Awaited<ReturnType<typeof pickDirectory>> } | null = null;

function syncSaveButton() {
  saveEl.disabled = saving || !doc?.scene || !current?.assets;
}

function closeSaveMenu() {
  saveMenuEl.hidden = true;
}

saveEl.onclick = (e) => {
  e.stopPropagation();
  if (!saveMenuEl.hidden) {
    closeSaveMenu();
    return;
  }
  closeNewMenu();
  saveLibEl.hidden = libState !== "ready";
  saveDirEl.hidden = !canPickDirectory();
  const r = saveEl.getBoundingClientRect();
  saveMenuEl.style.left = `${r.left}px`;
  saveMenuEl.style.top = `${r.bottom + 2}px`;
  saveMenuEl.hidden = false;
};
document.addEventListener("click", (e) => {
  if (!saveMenuEl.hidden && !saveMenuEl.contains(e.target as Node)) closeSaveMenu();
});
saveLibEl.onclick = () => void runSave("lib");
saveDirEl.onclick = () => void runSave("dir");
$<HTMLButtonElement>("#save-zip").onclick = () => void runSave("zip");

async function capturePreview(): Promise<Blob | null> {
  if (!editor || !doc) return null;
  const res = sceneResolution(doc.scene);
  const w = 640;
  const h = res ? Math.max(1, Math.round((w * res.h) / res.w)) : 360;
  try {
    return await editor.capture({ width: w, height: h, type: "image/jpeg", quality: 0.85 });
  } catch (e) {
    log(et("log.previewFailed", { msg: (e as Error).message }), "warn");
    return null;
  }
}

async function runSave(target: SaveTarget) {
  closeSaveMenu();
  if (saving || !doc?.scene || !current?.assets) return;
  const sameDoc = lastSave?.target === target;
  let dir = sameDoc ? lastSave?.dir ?? null : null;
  // 选目录必须紧跟用户手势（showDirectoryPicker 的要求），先选再干重活
  if (target === "dir" && !dir) {
    dir = await pickDirectory();
    if (!dir) return;
  }
  saving = true;
  syncSaveButton();
  const t0 = performance.now();
  try {
    log(et("log.saving"));
    const preview = await capturePreview();
    const files = await collectProject(doc, current.assets, preview);
    const mb = (totalBytes(files) / 1e6).toFixed(1);
    let progressStep = 0;
    const progress = (done: number, total: number) => {
      const step = Math.floor((done / total) * 4);
      if (step > progressStep && done < total) {
        progressStep = step;
        log(et("log.saveProgress", { done, total }));
      }
    };
    if (target === "zip") {
      const size = downloadZip(files, slugName(doc.title));
      log(et("log.savedZip", { n: files.length, mb: (size / 1e6).toFixed(1) }));
      lastSave = { target };
    } else if (target === "dir") {
      await writeToDirectory(dir!, files, progress);
      log(et("log.savedDir", { name: dir!.name, n: files.length, mb }));
      lastSave = { target, dir };
    } else {
      const itemId = (sameDoc && lastSave?.itemId) || newLibraryItemId(doc.title);
      await saveToLibrary(itemId, files, progress);
      log(et("log.savedLib", { id: itemId, n: files.length, mb }));
      lastSave = { target, itemId };
      void loadLibrary(false);
    }
    dirty = false;
    discardDraft();
    syncDocTitle();
    log(et("log.saveTook", { s: ((performance.now() - t0) / 1000).toFixed(1) }));
  } catch (e) {
    log(et("log.saveFailed", { msg: (e as Error).message }), "error");
  } finally {
    saving = false;
    syncSaveButton();
  }
}

// ---------- 画面点选（W4 拾取） ----------

let lastPick: { key: string; idx: number } | null = null;

stageEl.addEventListener("click", (e) => {
  if (!editor || !doc) return;
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  const canvas = stageEl.querySelector("canvas:not(#ed-overlay)");
  if (!canvas) return;
  // 拾取走正交投影几何；没有 orthogonalprojection 的透视相机场景算不准，直说
  if (!sceneResolution(doc.scene)) {
    log(et("log.pickPerspective"), "warn");
    return;
  }
  const r = canvas.getBoundingClientRect();
  const hits = editor.hitTestAt(e.clientX - r.left, e.clientY - r.top).filter((h) => !isLocked(h.id));
  lastPick = cyclePick(
    hits.map((h) => h.id),
    lastPick,
    e.altKey,
  );
  if (!lastPick) {
    log(et("log.pickNone"));
    selectLayer(null);
    return;
  }
  const hit: EditorLayer = hits[lastPick.idx];
  log(et("log.picked", { name: hit.name || `#${hit.id}`, n: hits.length }));
  selectLayer(hit.id);
});

function selectLayer(id: number | string | null) {
  if (id === null || !doc) {
    selectedId = null;
  } else {
    const path = findPath(doc.roots, id);
    const node = path?.[path.length - 1];
    selectedId = node ? node.id : null;
    for (const p of path?.slice(0, -1) ?? []) collapsed.delete(p.id);
  }
  renderTree();
  renderInspector();
  treeEl.querySelector(".ed-node.selected")?.scrollIntoView({ block: "nearest" });
}

// ---------- 编辑：热改 + 写回文档 + 撤销重做（W2-lite） ----------

const edits = new EditHistory();
/** 本文档累计的热改（按层合并）：重挂后原样重放，保证「重挂 ≡ 热改」 */
const liveEdits = new Map<string, Patch>();
let dirty = false;

function resetHistory() {
  edits.clear();
  liveEdits.clear();
  dirty = false;
  syncHistoryButtons();
}

function syncHistoryButtons() {
  undoEl.disabled = !edits.canUndo;
  redoEl.disabled = !edits.canRedo;
}

function syncDocTitle() {
  docTitleEl.textContent = doc ? `${dirty ? "● " : ""}${doc.title}` : "";
  docTitleEl.title = dirty ? et("st.dirty") : "";
}

function nodeName(id: number | string): string {
  const n = doc ? findNode(doc.roots, id) : null;
  return n?.name || `#${id}`;
}

/** 写引擎 + 写文档 + 记账，不进撤销栈（拖拽/滑条的中间态也走这里） */
function applyPatch(id: number | string, patch: Patch): Promise<void> {
  const node = doc ? findNode(doc.roots, id) : null;
  if (node) {
    writeObjProps(node.obj, patch);
    if (patch.visible !== undefined) node.visible = patch.visible;
  }
  mergeLiveEdit(liveEdits, id, patch);
  markDirty();
  return editor ? editor.setLayerProps(Number(id), patch).catch((e) => log(String(e?.message ?? e), "warn")) : Promise.resolve();
}

function markDirty() {
  scheduleDraft();
  if (dirty) return;
  dirty = true;
  syncDocTitle();
}

function commit(cmd: PropsCmd) {
  if (isNoopEdit(cmd)) return;
  edits.push(cmd);
  syncHistoryButtons();
  log(et("log.edited", { name: cmd.name, fields: Object.keys(cmd.after).join(", ") }));
}

/** 文档对象数组整体换成某个快照，然后整场景重挂（结构编辑 / 其撤销重做共用） */
function restoreObjects(json: string, sel: number | string | null, props?: string) {
  if (!doc?.scene) return;
  restoreDocObjects(doc, json, props);
  // 文档已含全部改动，旧的按层热改账作废（被删的层也不该再重放）
  liveEdits.clear();
  docDriven = true;
  scheduleDraft();
  selectedId = sel !== null && findNode(doc.roots, sel) ? sel : null;
  renderTree();
  renderInspector();
  renderStatus();
  void mountCurrent(true);
}

/**
 * 一次结构编辑：快照 → 改文档 → 入栈 → 重挂。mutate 返回新的选中 id（undefined = 没改成）。
 * hot：只动了属性表、对象数组没变时改走热更（引擎已与文档一致，不必重挂）；撤销重做仍重挂。
 */
function structEdit(label: string, mutate: (d: EditorDoc) => number | string | null | undefined, hot?: () => void) {
  if (!doc?.scene || !current?.assets) {
    log(et("log.structUnavailable"), "warn");
    return;
  }
  const cmd = structCommand(doc, label, selectedId, mutate);
  if (!cmd) return;
  edits.push(cmd);
  syncHistoryButtons();
  markDirty();
  log(label);
  if (hot && editor && cmd.after === cmd.before) {
    docDriven = true;
    hot();
    renderInspector();
    renderStatus();
    return;
  }
  restoreObjects(cmd.after, cmd.selAfter, cmd.propsAfter);
}

function selectedNode(): LayerNode | null {
  return doc && selectedId !== null ? findNode(doc.roots, selectedId) : null;
}

function deleteSelected() {
  const n = selectedNode();
  if (!n) return;
  const parent = n.obj.parent;
  structEdit(et("log.deleted", { name: nodeName(n.id) }), (d) =>
    removeLayer(d, n.id) ? ((parent as number | string | undefined) ?? null) : undefined,
  );
}

function duplicateSelected() {
  const n = selectedNode();
  if (!n) return;
  structEdit(et("log.duplicated", { name: nodeName(n.id) }), (d) => duplicateLayer(d, n.id, et("layer.copySuffix")) ?? undefined);
}

function moveSelected(dir: -1 | 1) {
  const n = selectedNode();
  if (!n) return;
  structEdit(et(dir < 0 ? "log.movedUp" : "log.movedDown", { name: nodeName(n.id) }), (d) =>
    moveLayer(d, n.id, dir) ? n.id : undefined,
  );
}

/** 一次完整的编辑（检视器 change / 眼睛开关）：读 before → 改 → 入栈 */
function edit(id: number | string, patch: Patch) {
  const cur = editor?.getLayerProps(Number(id));
  if (!cur) return;
  const keys = Object.keys(patch) as Array<keyof EditorLayerProps>;
  const before = pickProps(cur, keys);
  void applyPatch(id, patch);
  commit({ id, name: nodeName(id), before, after: structuredClone(patch) });
}

function undoRedo(dir: "undo" | "redo") {
  const cmd = edits.take(dir);
  if (!cmd) return;
  syncHistoryButtons();
  if (isStruct(cmd)) {
    log(et(dir === "undo" ? "log.undo" : "log.redo", { name: cmd.label }));
    restoreObjects(
      dir === "undo" ? cmd.before : cmd.after,
      dir === "undo" ? cmd.selBefore : cmd.selAfter,
      dir === "undo" ? cmd.propsBefore : cmd.propsAfter,
    );
    return;
  }
  void applyPatch(cmd.id, dir === "undo" ? cmd.before : cmd.after);
  renderTree();
  renderInspector();
  log(et(dir === "undo" ? "log.undo" : "log.redo", { name: cmd.name }));
}

undoEl.onclick = () => undoRedo("undo");
redoEl.onclick = () => undoRedo("redo");

window.addEventListener("keydown", (e) => {
  const tag = (e.target as HTMLElement | null)?.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    undoRedo(e.shiftKey ? "redo" : "undo");
  } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "y") {
    e.preventDefault();
    undoRedo("redo");
  } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    if (saveEl.disabled) return;
    if (lastSave) void runSave(lastSave.target);
    else saveEl.click();
  } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") {
    e.preventDefault();
    duplicateSelected();
  } else if ((e.key === "Delete" || e.key === "Backspace") && selectedId !== null) {
    e.preventDefault();
    deleteSelected();
  }
});

/** 重挂（重新加载 / 改 DPR）后把累计热改重放到新的一代引擎上 */
async function replayLiveEdits() {
  if (!editor) return;
  for (const [id, patch] of liveEdits) {
    await editor.setLayerProps(Number(id), patch).catch(() => {});
  }
}

// ---------- 选中框叠加层（W5 过渡方案：视口上叠 2D canvas） ----------

const overlayEl = document.createElement("canvas");
overlayEl.id = "ed-overlay";
const overlayCtx = overlayEl.getContext("2d")!;

/** 当前选中层的手柄几何（画布 CSS 坐标），drawOverlay 每帧刷新，pointerdown 据此判命中 */
let gizmo: Gizmo | null = null;

function drawOverlay() {
  if (overlayEl.parentElement !== stageEl) stageEl.appendChild(overlayEl);
  gizmo = null;
  const dpr = window.devicePixelRatio || 1;
  const w = stageEl.clientWidth;
  const h = stageEl.clientHeight;
  if (overlayEl.width !== Math.round(w * dpr) || overlayEl.height !== Math.round(h * dpr)) {
    overlayEl.width = Math.round(w * dpr);
    overlayEl.height = Math.round(h * dpr);
  }
  overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
  overlayCtx.clearRect(0, 0, overlayEl.width, overlayEl.height);
  if (!editor || selectedId === null) return;
  const outline = editor.getLayerOutline(Number(selectedId));
  const canvas = stageEl.querySelector<HTMLCanvasElement>("canvas:not(#ed-overlay)");
  if (!outline || !canvas) return;
  const sr = stageEl.getBoundingClientRect();
  const cr = canvas.getBoundingClientRect();
  overlayCtx.setTransform(dpr, 0, 0, dpr, (cr.left - sr.left) * dpr, (cr.top - sr.top) * dpr);
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#0078d4";
  const lockedSel = isLocked(selectedId);
  gizmo = lockedSel ? null : gizmoOf(outline.anchor, outline.corners);
  overlayCtx.lineWidth = 1.5;
  if (outline.corners) {
    overlayCtx.setLineDash(lockedSel ? [4, 3] : []);
    overlayCtx.beginPath();
    outline.corners.forEach(([x, y], i) => (i ? overlayCtx.lineTo(x, y) : overlayCtx.moveTo(x, y)));
    overlayCtx.closePath();
    overlayCtx.strokeStyle = "rgba(0,0,0,0.6)";
    overlayCtx.lineWidth = 3;
    overlayCtx.stroke();
    overlayCtx.strokeStyle = accent;
    overlayCtx.lineWidth = 1.5;
    overlayCtx.stroke();
    overlayCtx.setLineDash([]);
  }
  if (gizmo?.rotate) {
    const [c0, c1] = gizmo.corners;
    const [rx, ry] = gizmo.rotate;
    overlayCtx.strokeStyle = accent;
    overlayCtx.beginPath();
    overlayCtx.moveTo((c0[0] + c1[0]) / 2, (c0[1] + c1[1]) / 2);
    overlayCtx.lineTo(rx, ry);
    overlayCtx.stroke();
    overlayCtx.beginPath();
    overlayCtx.arc(rx, ry, HANDLE / 2 + 1, 0, Math.PI * 2);
    overlayCtx.fillStyle = "#fff";
    overlayCtx.fill();
    overlayCtx.stroke();
  }
  if (gizmo?.corners.length) {
    overlayCtx.fillStyle = "#fff";
    overlayCtx.strokeStyle = accent;
    for (const [x, y] of gizmo.corners) {
      overlayCtx.fillRect(x - HANDLE / 2, y - HANDLE / 2, HANDLE, HANDLE);
      overlayCtx.strokeRect(x - HANDLE / 2, y - HANDLE / 2, HANDLE, HANDLE);
    }
  }
  const [ax, ay] = outline.anchor;
  overlayCtx.strokeStyle = accent;
  overlayCtx.beginPath();
  overlayCtx.moveTo(ax - 6, ay);
  overlayCtx.lineTo(ax + 6, ay);
  overlayCtx.moveTo(ax, ay - 6);
  overlayCtx.lineTo(ax, ay + 6);
  overlayCtx.stroke();
}

// ---------- 视口拖拽移动选中层 ----------

type DragMode = "move" | "scale" | "rotate";
let drag: {
  mode: DragMode;
  id: number | string;
  pointerId: number;
  x0: number;
  y0: number;
  props0: EditorLayerProps;
  /** 缩放 / 旋转的屏幕基准：锚点、层局部 x / y 轴的屏幕单位向量 */
  anchor: Pt;
  ax: Pt;
  ay: Pt;
  moved: boolean;
} | null = null;
let suppressClick = false;

const DRAG_FIELD: Record<DragMode, keyof EditorLayerProps> = { move: "origin", scale: "scale", rotate: "angles" };

function canvasPoint(e: PointerEvent | MouseEvent): { x: number; y: number } | null {
  const canvas = stageEl.querySelector<HTMLCanvasElement>("canvas:not(#ed-overlay)");
  if (!canvas) return null;
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function overSelected(x: number, y: number): boolean {
  if (!editor || selectedId === null) return false;
  return editor.hitTestAt(x, y, { includeHidden: true }).some((h) => String(h.id) === String(selectedId));
}

stageEl.addEventListener("pointerdown", (e) => {
  if (!editor || selectedId === null || isLocked(selectedId) || e.button !== 0 || e.altKey) return;
  const p = canvasPoint(e);
  if (!p) return;
  const handle = handleAt(gizmo, p.x, p.y);
  if (!handle && !overSelected(p.x, p.y)) return;
  const props = editor.getLayerProps(Number(selectedId));
  if (!props) return;
  drag = {
    mode: handle?.kind ?? "move",
    id: selectedId,
    pointerId: e.pointerId,
    x0: p.x,
    y0: p.y,
    props0: structuredClone(props),
    anchor: gizmo?.anchor ?? [p.x, p.y],
    ...layerAxes(gizmo?.corners ?? []),
    moved: false,
  };
  stageEl.setPointerCapture(e.pointerId);
});

stageEl.addEventListener("pointermove", (e) => {
  const p = canvasPoint(e);
  if (!p) return;
  if (!drag || e.pointerId !== drag.pointerId || !editor) {
    if (e.buttons) return;
    const h = !isLocked(selectedId) ? handleAt(gizmo, p.x, p.y) : null;
    const cursor = h ? h.kind : !isLocked(selectedId) && overSelected(p.x, p.y) ? "move" : "";
    if ((stageEl.dataset.cursor ?? "") !== cursor) stageEl.dataset.cursor = cursor;
    return;
  }
  const dx = p.x - drag.x0;
  const dy = p.y - drag.y0;
  if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
  drag.moved = true;
  const p0 = drag.props0;
  if (drag.mode === "move") {
    const d = editor.screenDeltaToLocal(Number(drag.id), dx, dy);
    if (!d) return;
    void applyPatch(drag.id, { origin: [p0.origin[0] + d[0], p0.origin[1] + d[1], p0.origin[2]] });
    return;
  }
  const from: Pt = [drag.x0, drag.y0];
  const to: Pt = [p.x, p.y];
  if (drag.mode === "rotate") {
    const z = rotateZ(p0.angles[2], drag.anchor, from, to, e.shiftKey ? 15 : 0);
    void applyPatch(drag.id, { angles: [p0.angles[0], p0.angles[1], z] });
    return;
  }
  void applyPatch(drag.id, { scale: scaleXY(p0.scale, drag.anchor, from, to, drag, e.shiftKey) });
});

function endDrag(e: PointerEvent) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const d = drag;
  drag = null;
  if (!d.moved || !editor) return;
  suppressClick = true;
  const after = editor.getLayerProps(Number(d.id));
  if (after) {
    const key = DRAG_FIELD[d.mode];
    commit({ id: d.id, name: nodeName(d.id), before: pickProps(d.props0, [key]), after: pickProps(after, [key]) });
    renderInspector();
  }
}
stageEl.addEventListener("pointerup", endDrag);
stageEl.addEventListener("pointercancel", endDrag);

// ---------- 状态栏 ----------

function renderStatus() {
  syncSaveButton();
  stDocEl.textContent = doc ? doc.title : et("st.none");
  stDocEl.title = stDocEl.textContent;
  stFormEl.textContent = doc ? (doc.form ? et(`form.${doc.form}`) : doc.type) : "";
  const n = instance?.info?.layerCount ?? doc?.objectCount;
  stLayersEl.textContent = doc && n !== undefined ? et("st.layers", { n }) : "";
  const res = sceneResolution(doc?.scene ?? null);
  stResEl.textContent = [res ? `${res.w}×${res.h}` : "", aspectEl.value === "fill" ? et("aspect.fill") : aspectEl.value]
    .filter(Boolean)
    .join(" · ");
}

setInterval(() => {
  const s = instance?.stats;
  if (!s || !s.running) {
    stFpsEl.textContent = "— FPS";
    stFpsEl.classList.add("idle");
    return;
  }
  stFpsEl.textContent = et("st.fps", { n: Math.round(s.fps) });
  stFpsEl.classList.remove("idle");
  refreshScriptIssues();
  syncScriptsBanner();
}, 500);

// ---------- 壁纸库 ----------

let libItems: LibraryItem[] = [];
let libState: "loading" | "ready" | "static" = "loading";
let activeItemId: string | null = null;

function renderLibrary() {
  libListEl.textContent = "";
  if (libState !== "ready") {
    const note = document.createElement("p");
    note.className = "ed-note";
    note.textContent = et(libState === "loading" ? "lib.loading" : "static.notice");
    libListEl.appendChild(note);
    libCountEl.textContent = "";
    return;
  }
  const kw = filterEl.value.trim().toLowerCase();
  let shown = 0;
  for (const it of libItems) {
    if (kw && !`${it.title} ${it.itemId}`.toLowerCase().includes(kw)) continue;
    shown++;
    const li = document.createElement("li");
    if (it.itemId === activeItemId) li.classList.add("active");
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
    sub.textContent = `${libraryKind(it)} · ${it.itemId}`;
    meta.append(title, sub);
    li.appendChild(meta);
    li.onclick = () => openLibrary(it);
    libListEl.appendChild(li);
  }
  if (!shown) {
    const note = document.createElement("p");
    note.className = "ed-note";
    note.textContent = et("lib.empty");
    libListEl.appendChild(note);
  }
  libCountEl.textContent = String(shown);
}

function openLibrary(it: LibraryItem) {
  activeItemId = it.itemId;
  renderLibrary();
  const url = new URL(location.href);
  url.searchParams.set("item", it.itemId);
  history.replaceState(null, "", url);
  void openWith(it.title, () => openLibraryItem(it, MEDIA_BASE, WEB_BASE), {
    origin: { kind: "library", itemId: it.itemId },
  });
}

filterEl.oninput = renderLibrary;

let libLoaded: () => void = () => {};
/** 首次读库结束（成功或失败）。恢复库来源的草稿要等它 */
const libReady = new Promise<void>((ok) => (libLoaded = ok));

/** autoOpen=false：保存后刷新列表用，不要按地址栏 ?item 再打开一遍（会丢掉当前编辑） */
async function loadLibrary(autoOpen = true) {
  try {
    const lib = await fetchLibrary();
    if (!lib) {
      libState = "static";
      renderLibrary();
      return;
    }
    libItems = lib.items;
    libState = "ready";
    renderLibrary();
    if (!autoOpen) return;
    const want = new URL(location.href).searchParams.get("item");
    const hit = want ? libItems.find((i) => i.itemId === want) : undefined;
    if (hit) openLibrary(hit);
  } catch (e) {
    libState = "static";
    renderLibrary();
    log(et("log.libFailed", { msg: (e as Error).message }), "error");
  } finally {
    libLoaded();
  }
}

// ---------- 本地打开 / 拖放 ----------

function leaveLibraryItem() {
  activeItemId = null;
  renderLibrary();
  const url = new URL(location.href);
  url.searchParams.delete("item");
  history.replaceState(null, "", url);
}

function openLocal(files: ReturnType<typeof filesFromInput>) {
  if (!files.length) return;
  leaveLibraryItem();
  const name = files[0].path.split("/")[0] || files[0].file.name;
  void openWith(name, () => openLocalFiles(files));
}

$<HTMLButtonElement>("#tb-open-pkg").onclick = () => inPkgEl.click();
$<HTMLButtonElement>("#tb-open-dir").onclick = () => inDirEl.click();
inPkgEl.onchange = () => {
  openLocal(filesFromInput(inPkgEl.files));
  inPkgEl.value = "";
};
inDirEl.onchange = () => {
  openLocal(filesFromInput(inDirEl.files));
  inDirEl.value = "";
};

let dragDepth = 0;
const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
window.addEventListener("dragenter", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  dropEl.hidden = false;
});
window.addEventListener("dragleave", (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) dropEl.hidden = true;
});
window.addEventListener("dragover", (e) => {
  if (hasFiles(e)) e.preventDefault();
});
window.addEventListener("drop", (e) => {
  if (!hasFiles(e) || !e.dataTransfer) return;
  e.preventDefault();
  dragDepth = 0;
  dropEl.hidden = true;
  void collectDropped(e.dataTransfer).then((files) => {
    if (!files.length) log(et("log.dropEmpty"), "warn");
    else if (files.every((f) => isImageFile(f.file))) void dropImages(files.map((f) => f.file));
    else openLocal(files);
  });
});

// ---------- 新建（模板）/ 图片成层 ----------

const newEl = $<HTMLButtonElement>("#tb-new");
const newMenuEl = $<HTMLElement>("#new-menu");
const newResEl = $<HTMLSelectElement>("#new-res");
const newColorEl = $<HTMLInputElement>("#new-color");
const inImageEl = $<HTMLInputElement>("#in-image");
/** 图片选择框的用途：给当前文档加层，或作为新建工程的背景 */
let imagePickFor: "layer" | "template" = "layer";

function closeNewMenu() {
  newMenuEl.hidden = true;
}

newEl.onclick = (e) => {
  e.stopPropagation();
  if (!newMenuEl.hidden) {
    closeNewMenu();
    return;
  }
  closeSaveMenu();
  const r = newEl.getBoundingClientRect();
  newMenuEl.style.left = `${r.left}px`;
  newMenuEl.style.top = `${r.bottom + 2}px`;
  newMenuEl.hidden = false;
};
document.addEventListener("click", (e) => {
  if (!newMenuEl.hidden && !newMenuEl.contains(e.target as Node)) closeNewMenu();
});

function selectedResolution() {
  const [w, h] = newResEl.value.split("x").map(Number);
  return RESOLUTIONS.find((r) => r.w === w && r.h === h) ?? RESOLUTIONS[0];
}

$<HTMLButtonElement>("#new-blank").onclick = () => void createNew([]);
$<HTMLButtonElement>("#new-image").onclick = () => {
  imagePickFor = "template";
  inImageEl.click();
};
inImageEl.onchange = () => {
  const files = Array.from(inImageEl.files ?? []);
  inImageEl.value = "";
  if (!files.length) return;
  if (imagePickFor === "template") void createNew(files);
  else void addImageFiles(files);
};

const EMPTY_ASSETS: SceneAssets = { entry: "scene.json", read: async () => null, list: () => [] };

/** 新建工程的「来源」：没有任何原始资源，全部在资源表叠加层里 */
function newOpened(title: string, project: Record<string, unknown>, scene: Record<string, unknown>): Opened {
  const d = makeDoc(title, project, scene, "loose");
  return {
    doc: d,
    source: {
      async scenePkg() {
        throw new Error("新建工程只有松散形态");
      },
      async sceneDir() {
        return EMPTY_ASSETS;
      },
      project: async () => d.project,
    },
    assets: EMPTY_ASSETS,
  };
}

async function readImages(files: File[]): Promise<ImageInput[]> {
  const out: ImageInput[] = [];
  for (const f of files) {
    try {
      out.push(await readImageFile(f));
    } catch (e) {
      log(et("log.imageFailed", { name: f.name, msg: (e as Error).message }), "warn");
    }
  }
  return out;
}

/** 把图片写进资源表并在文档末尾追加图层；第一张可铺满（背景），其余按 fit。返回最后一个新层 id */
function placeImages(d: EditorDoc, imgs: ImageInput[], firstCover: boolean): number | undefined {
  if (!overlay) return undefined;
  let last: number | undefined;
  imgs.forEach((img, i) => {
    const refs = referencedModels(d);
    const slug = imageSlug(img.name, (s) => overlay!.has(modelPathOf(s)) || refs.has(modelPathOf(s)));
    for (const f of imageLayerFiles(slug, img)) overlay!.put(f.name, f.data, modelPathOf(slug));
    last = addImageLayer(d, slug, img, firstCover && i === 0 ? "cover" : "fit") ?? last;
  });
  return last;
}

/** 新建：所选分辨率 + 背景色；images 非空时第一张铺满做背景、其余作为普通图层 */
async function createNew(images: File[]) {
  closeNewMenu();
  const imgs = images.length ? await readImages(images) : [];
  if (images.length && !imgs.length) return;
  const res = selectedResolution();
  const title = et("new.untitled");
  leaveLibraryItem();
  await openWith(title, async () => newOpened(title, newProject(title), blankScene(res.w, res.h, hexToRgb(newColorEl.value))), {
    origin: { kind: "new" },
    docDriven: true,
    after: () => {
      log(et("log.newDoc", { w: res.w, h: res.h }));
      if (!imgs.length || !doc) return;
      selectedId = placeImages(doc, imgs, true) ?? null;
      markDirty();
    },
  });
}

async function addImageFiles(files: File[]) {
  if (!doc?.scene || !overlay || doc.type !== "scene") {
    log(et("log.structUnavailable"), "warn");
    return;
  }
  const target = doc;
  const imgs = await readImages(files);
  if (!imgs.length || doc !== target) return;
  structEdit(et("log.imagesAdded", { names: imgs.map((i) => i.name).join(", ") }), (d) => placeImages(d, imgs, false));
}

/** 拖进来的全是图片：有打开的场景就加层，否则以它们新建 */
function dropImages(files: File[]) {
  if (doc?.scene && overlay && doc.type === "scene") return addImageFiles(files);
  return createNew(files);
}

// ---------- 草稿（IndexedDB，单槽位） ----------

const DRAFT_DELAY = 800;
const drafts = idbDraftStore();
const draftEl = $<HTMLElement>("#ed-draft");
const draftTextEl = $<HTMLElement>("#ed-draft-text");
let draftTimer = 0;
/** IDB 操作串行：保存成功后的清除不能被更早排队的写入盖回去 */
let draftQueue: Promise<void> = Promise.resolve();
let pendingDraft: Draft | null = null;

function queueDraftOp(op: () => Promise<void>) {
  draftQueue = draftQueue.then(op).catch((e) => log(et("log.draftFailed", { msg: (e as Error).message }), "warn"));
}

function scheduleDraft() {
  if (!origin || !doc?.scene) return;
  clearTimeout(draftTimer);
  draftTimer = window.setTimeout(writeDraft, DRAFT_DELAY);
}

function writeDraft() {
  clearTimeout(draftTimer);
  draftTimer = 0;
  if (!origin || !doc?.scene || !dirty) return;
  const d = makeDraft(doc, origin, current?.assets?.entry ?? "scene.json", overlay?.added() ?? []);
  if (!d) return;
  // 新草稿顶掉了启动时发现的那份，横幅失去意义
  hideDraftBanner();
  queueDraftOp(() => drafts.save(d));
}

function discardDraft() {
  clearTimeout(draftTimer);
  draftTimer = 0;
  hideDraftBanner();
  queueDraftOp(() => drafts.clear());
}

function hideDraftBanner() {
  pendingDraft = null;
  draftEl.hidden = true;
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && draftTimer) writeDraft();
});

async function checkDraft() {
  let d: Draft | null = null;
  try {
    d = await drafts.load();
  } catch (e) {
    log(et("log.draftFailed", { msg: (e as Error).message }), "warn");
  }
  if (!d) return;
  pendingDraft = d;
  draftTextEl.textContent = et("draft.found", { title: d.title, time: new Date(d.savedAt).toLocaleString() });
  draftEl.hidden = false;
}

async function restoreDraft(d: Draft) {
  hideDraftBanner();
  const apply = () => {
    if (!doc) return;
    applyDraft(doc, d);
    for (const f of d.files) overlay?.put(f.name, f.data, f.group);
    docDriven = true;
    dirty = true;
    log(et("log.draftRestored", { title: d.title }));
  };
  if (d.origin.kind === "new") {
    leaveLibraryItem();
    await openWith(d.title, async () => newOpened(d.title, d.project ?? newProject(d.title), d.scene), {
      origin: { kind: "new" },
      docDriven: true,
      after: apply,
    });
    return;
  }
  await libReady;
  const itemId = d.origin.itemId;
  const it = libItems.find((i) => i.itemId === itemId);
  if (!it) {
    log(et("log.draftMissing", { id: itemId }), "error");
    return;
  }
  activeItemId = it.itemId;
  renderLibrary();
  const url = new URL(location.href);
  url.searchParams.set("item", it.itemId);
  history.replaceState(null, "", url);
  await openWith(d.title, () => openLibraryItem(it, MEDIA_BASE, WEB_BASE), { origin: d.origin, after: apply });
}

$<HTMLButtonElement>("#draft-restore").onclick = () => {
  if (pendingDraft) void restoreDraft(pendingDraft);
};
$<HTMLButtonElement>("#draft-discard").onclick = () => discardDraft();

// ---------- 图层树（P0 只读：来自 scene.json） ----------

const LOCK_SVG =
  '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M5 7V5a3 3 0 0 1 6 0v2h1.5v7h-9V7zm1.2 0h3.6V5a1.8 1.8 0 0 0-3.6 0z"/></svg>';
const UNLOCK_SVG =
  '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M5 7V5a3 3 0 0 1 5.9-.8l-1.15.35A1.8 1.8 0 0 0 6.2 5v2h6.3v7h-9V7zm-.3 1.2v4.6h6.6V8.2z"/></svg>';

const lyUpEl = $<HTMLButtonElement>("#ly-up");
const lyDownEl = $<HTMLButtonElement>("#ly-down");
const lyDupEl = $<HTMLButtonElement>("#ly-dup");
const lyDelEl = $<HTMLButtonElement>("#ly-del");
const lyAddEl = $<HTMLButtonElement>("#ly-add");
lyAddEl.onclick = () => {
  imagePickFor = "layer";
  inImageEl.click();
};
lyUpEl.onclick = () => moveSelected(-1);
lyDownEl.onclick = () => moveSelected(1);
lyDupEl.onclick = () => duplicateSelected();
lyDelEl.onclick = () => deleteSelected();

function syncLayerTools() {
  const off = !selectedNode() || !current?.assets || doc?.type !== "scene";
  for (const b of [lyUpEl, lyDownEl, lyDupEl, lyDelEl]) b.disabled = off;
  lyAddEl.disabled = !overlay || doc?.type !== "scene";
}

function renderTree() {
  syncLayerTools();
  treeEl.textContent = "";
  layerCountEl.textContent = "";
  if (!doc) {
    treeEl.appendChild(note(et("layers.none")));
    return;
  }
  if (doc.type !== "scene") {
    treeEl.appendChild(note(et("layers.notScene", { type: doc.type })));
    return;
  }
  layerCountEl.textContent = et("layers.count", { n: doc.objectCount });
  const frag = document.createDocumentFragment();
  const walk = (nodes: LayerNode[], depth: number) => {
    for (const n of nodes) {
      frag.appendChild(treeRow(n, depth));
      if (n.children.length && !collapsed.has(n.id)) walk(n.children, depth + 1);
    }
  };
  walk(doc.roots, 0);
  treeEl.appendChild(frag);
}

function note(text: string): HTMLElement {
  const p = document.createElement("p");
  p.className = "ed-note";
  p.textContent = text;
  return p;
}

function treeRow(n: LayerNode, depth: number): HTMLElement {
  const row = document.createElement("div");
  row.className = "ed-node";
  row.setAttribute("role", "treeitem");
  if (n.id === selectedId) row.classList.add("selected");
  if (!n.visible) row.classList.add("hidden-layer");
  row.style.paddingLeft = `${6 + depth * 14}px`;

  const twisty = document.createElement("span");
  twisty.className = "ed-twisty";
  if (n.children.length) {
    twisty.textContent = collapsed.has(n.id) ? "▸" : "▾";
    twisty.onclick = (e) => {
      e.stopPropagation();
      if (collapsed.has(n.id)) collapsed.delete(n.id);
      else collapsed.add(n.id);
      renderTree();
    };
  }
  const kind = document.createElement("span");
  kind.className = "ed-kind";
  kind.dataset.kind = n.kind;
  kind.textContent = et(`kind.${n.kind}`);
  const name = document.createElement("span");
  name.className = "ed-node-name";
  name.textContent = n.name || `#${n.id}`;
  const id = document.createElement("span");
  id.className = "ed-node-id";
  id.textContent = n.name ? `#${n.id}` : "";
  row.append(twisty, kind, name, id);
  if (isLocked(n.id)) row.classList.add("locked-layer");
  if (editor) {
    const actions = document.createElement("span");
    actions.className = "ed-node-actions";
    const lock = document.createElement("button");
    lock.type = "button";
    lock.className = "ed-lock";
    lock.title = et("lock.toggle");
    lock.innerHTML = isLocked(n.id) ? LOCK_SVG : UNLOCK_SVG;
    lock.onclick = (e) => {
      e.stopPropagation();
      if (isLocked(n.id)) locked.delete(String(n.id));
      else locked.add(String(n.id));
      renderTree();
      if (n.id === selectedId) renderInspector();
    };
    const eye = document.createElement("button");
    eye.type = "button";
    eye.className = "ed-eye";
    eye.title = et("eye.toggle");
    eye.textContent = n.visible ? "◉" : "○";
    eye.onclick = (e) => {
      e.stopPropagation();
      edit(n.id, { visible: !n.visible });
      renderTree();
      if (n.id === selectedId) renderInspector();
    };
    actions.append(lock, eye);
    row.appendChild(actions);
  }
  row.onclick = () => {
    selectedId = n.id;
    renderTree();
    renderInspector();
  };
  return row;
}

// ---------- 检视器（P0 只读） ----------

function fmt(v: unknown): string {
  const raw = unwrap(v);
  if (raw === undefined || raw === null || raw === "") return "—";
  if (typeof raw === "object") return JSON.stringify(raw);
  return String(raw);
}

function colorCss(v: unknown): string | null {
  const raw = unwrap(v);
  if (typeof raw !== "string") return null;
  const parts = raw.trim().split(/\s+/).map(Number);
  if (parts.length < 3 || parts.some((x) => !Number.isFinite(x))) return null;
  const [r, g, b] = parts.map((x) => Math.round(Math.max(0, Math.min(1, x)) * 255));
  return `rgb(${r} ${g} ${b})`;
}

function kvGroup(title: string, rows: Array<[string, unknown, ((dd: HTMLElement) => void)?]>): HTMLElement {
  const group = document.createElement("div");
  group.className = "ed-insp-group";
  const h = document.createElement("div");
  h.className = "ed-insp-title";
  h.textContent = title;
  const dl = document.createElement("dl");
  dl.className = "ed-kv";
  for (const [key, value, decorate] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = et(key);
    const dd = document.createElement("dd");
    dd.textContent = typeof value === "string" ? value : fmt(value);
    decorate?.(dd);
    dl.append(dt, dd);
  }
  group.append(h, dl);
  return group;
}

function rawGroup(obj: unknown): HTMLElement {
  const group = document.createElement("div");
  group.className = "ed-insp-group";
  const h = document.createElement("div");
  h.className = "ed-insp-title";
  h.textContent = et("insp.raw");
  const pre = document.createElement("pre");
  pre.className = "ed-insp-raw";
  pre.textContent = JSON.stringify(obj, null, 2);
  group.append(h, pre);
  return group;
}

const RAD = Math.PI / 180;
const fmtNum = (v: number) => String(Math.round(v * 1000) / 1000);
const toHex = (c: readonly number[]) =>
  `#${c.map((x) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, "0")).join("")}`;
const fromHex = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];

/**
 * 可编辑的变换 / 外观表单。数值框 input 时实时热改（不入栈），change 时以
 * 获得焦点那一刻的值为 before 入撤销栈 —— 拖滑条、连按方向键都只记一条。
 */
function editGroup(node: LayerNode): HTMLElement {
  const group = document.createElement("div");
  group.className = "ed-insp-group";
  const h = document.createElement("div");
  h.className = "ed-insp-title";
  h.textContent = et("insp.edit");
  group.appendChild(h);
  if (!editor) {
    group.appendChild(note(et("insp.noEdit")));
    return group;
  }
  const id = node.id;
  const props = editor.getLayerProps(Number(id));
  if (!props) {
    group.appendChild(note(et("insp.notLive")));
    return group;
  }
  const form = document.createElement("fieldset");
  form.className = "ed-form";
  form.disabled = isLocked(id);
  let before: EditorLayerProps | null = null;
  form.addEventListener("focusin", () => {
    before = editor?.getLayerProps(Number(id)) ?? null;
  });
  const live = (patch: Patch) => void applyPatch(id, patch);
  const done = (keys: Array<keyof EditorLayerProps>) => {
    const after = editor?.getLayerProps(Number(id));
    if (!before || !after) return;
    commit({ id, name: nodeName(id), before: pickProps(before, keys), after: pickProps(after, keys) });
    before = after;
  };
  const label = (key: string) => {
    const l = document.createElement("label");
    l.textContent = et(key);
    form.appendChild(l);
  };
  const vecRow = (key: string, field: "origin" | "scale" | "angles", scale = 1, step = "1") => {
    label(key);
    const inputs: HTMLInputElement[] = [];
    for (let i = 0; i < 3; i++) {
      const inp = document.createElement("input");
      inp.type = "number";
      inp.step = step;
      inp.value = fmtNum(props[field][i] / scale);
      inp.title = ["x", "y", "z"][i];
      inp.addEventListener("input", () => {
        const v = inputs.map((x) => Number(x.value) * scale) as [number, number, number];
        if (v.every(Number.isFinite)) live({ [field]: v });
      });
      inp.addEventListener("change", () => done([field]));
      inputs.push(inp);
      form.appendChild(inp);
    }
  };
  vecRow("f.origin", "origin");
  vecRow("f.scale", "scale", 1, "0.01");
  vecRow("f.angleDeg", "angles", RAD, "1");

  label("f.alpha");
  const alphaBox = document.createElement("div");
  alphaBox.className = "span3";
  const alpha = document.createElement("input");
  alpha.type = "range";
  alpha.min = "0";
  alpha.max = "1";
  alpha.step = "0.01";
  alpha.value = String(props.alpha);
  const alphaVal = document.createElement("span");
  alphaVal.className = "ed-val";
  alphaVal.textContent = fmtNum(props.alpha);
  alpha.addEventListener("input", () => {
    alphaVal.textContent = fmtNum(Number(alpha.value));
    live({ alpha: Number(alpha.value) });
  });
  alpha.addEventListener("change", () => done(["alpha"]));
  alphaBox.append(alpha, alphaVal);
  form.appendChild(alphaBox);

  label("f.color");
  const colorBox = document.createElement("div");
  colorBox.className = "span3";
  const color = document.createElement("input");
  color.type = "color";
  color.value = toHex(props.color);
  const colorVal = document.createElement("span");
  colorVal.className = "ed-val";
  colorVal.textContent = props.color.map(fmtNum).join(" ");
  color.addEventListener("input", () => {
    const c = fromHex(color.value);
    colorVal.textContent = c.map(fmtNum).join(" ");
    live({ color: c });
  });
  color.addEventListener("change", () => done(["color"]));
  colorBox.append(color, colorVal);
  form.appendChild(colorBox);

  label("f.visible");
  const visBox = document.createElement("div");
  visBox.className = "span3";
  const vis = document.createElement("input");
  vis.type = "checkbox";
  vis.checked = props.visible;
  vis.addEventListener("change", () => {
    edit(id, { visible: vis.checked });
    renderTree();
  });
  visBox.appendChild(vis);
  form.appendChild(visBox);

  group.appendChild(form);
  const hint = document.createElement("p");
  hint.className = "ed-hint";
  hint.textContent = et(isLocked(id) ? "insp.locked" : "insp.editHint");
  group.appendChild(hint);
  return group;
}

// ---------- 效果（W7 基础集）：增删 / 开关 / 排序 / 参数，全走结构编辑 ----------

const canHaveEffects = (n: LayerNode) => n.kind === "image" || n.kind === "text";

const fxLabel = (v: Pick<EffectView, "def" | "name">) => (v.def ? et(`fx.${v.def.id}`) : v.name);

/** 对一个图层对象做一次可撤销的结构编辑（效果 / 脚本）；mutate 返回 false = 没改成 */
function objEdit(label: string, id: number | string, mutate: (o: LayerNode["obj"]) => boolean) {
  structEdit(label, (d) => {
    const n = findNode(d.roots, id);
    return n && mutate(n.obj) ? n.id : undefined;
  });
}

function addEffectTo(n: LayerNode, fxId: string) {
  const d = effectById(fxId);
  if (!d || !overlay) return;
  for (const f of effectFiles(d)) overlay.put(f.name, f.data, effectFileOf(fxId));
  objEdit(et("log.fxAdded", { name: et(`fx.${fxId}`), layer: nodeName(n.id) }), n.id, (o) => addEffect(o, fxId) !== null);
}

function effectsGroup(node: LayerNode): HTMLElement {
  const group = document.createElement("div");
  group.className = "ed-insp-group ed-fx";
  const h = document.createElement("div");
  h.className = "ed-insp-title";
  h.textContent = et("insp.effects");
  group.appendChild(h);
  const editable = !!overlay && !!editor && !isLocked(node.id);
  const views = effectViews(node.obj);
  if (!views.length) group.appendChild(note(et("fx.none")));
  const iconBtn = (cls: string, text: string, title: string, onClick: () => void, disabled = false) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `ed-icon ${cls}`;
    b.textContent = text;
    b.title = title;
    b.disabled = !editable || disabled;
    b.onclick = onClick;
    return b;
  };
  for (const v of views) {
    const item = document.createElement("div");
    item.className = "ed-fx-item";
    item.dataset.fxIndex = String(v.index);
    item.dataset.fxId = v.def?.id ?? "";
    if (!v.visible) item.classList.add("hidden-layer");
    const head = document.createElement("div");
    head.className = "ed-fx-head";
    const name = document.createElement("span");
    name.className = "ed-fx-name";
    name.textContent = fxLabel(v);
    name.title = v.file;
    const label = fxLabel(v);
    head.append(
      name,
      iconBtn("ed-fx-eye", v.visible ? "◉" : "○", et("fx.eye"), () =>
        objEdit(et("log.fxToggled", { name: label }), node.id, (o) => setEffectVisible(o, v.index, !v.visible)),
      ),
      iconBtn("ed-fx-up", "↑", et("fx.up"), () => objEdit(et("log.fxMoved", { name: label }), node.id, (o) => moveEffect(o, v.index, -1)), v.index === 0),
      iconBtn("ed-fx-down", "↓", et("fx.down"), () => objEdit(et("log.fxMoved", { name: label }), node.id, (o) => moveEffect(o, v.index, 1)), v.index === views.length - 1),
      iconBtn("ed-fx-del", "✕", et("fx.del"), () => objEdit(et("log.fxRemoved", { name: label }), node.id, (o) => removeEffect(o, v.index))),
    );
    item.appendChild(head);
    if (!v.def) {
      item.appendChild(note(et("fx.external")));
    } else {
      const form = document.createElement("div");
      form.className = "ed-fx-params";
      for (const p of v.def.params) {
        const l = document.createElement("label");
        l.textContent = et(`fxp.${p.key}`);
        const val = v.values[p.key];
        const commit = (next: EffectValue) =>
          objEdit(et("log.fxParam", { name: label, param: et(`fxp.${p.key}`) }), node.id, (o) => setEffectParam(o, v.index, p.key, next));
        const box = document.createElement("div");
        box.className = "ed-fx-param";
        if (p.type === "color") {
          const inp = document.createElement("input");
          inp.type = "color";
          inp.dataset.param = p.key;
          inp.value = toHex(val as number[]);
          inp.disabled = !editable;
          inp.addEventListener("change", () => commit(fromHex(inp.value)));
          box.appendChild(inp);
        } else {
          const inp = document.createElement("input");
          inp.type = "range";
          inp.dataset.param = p.key;
          inp.min = String(p.min ?? 0);
          inp.max = String(p.max ?? 1);
          inp.step = String(p.step ?? 0.01);
          inp.value = String(val);
          inp.disabled = !editable;
          const out = document.createElement("span");
          out.className = "ed-val";
          out.textContent = fmtNum(val as number);
          inp.addEventListener("input", () => (out.textContent = fmtNum(Number(inp.value))));
          inp.addEventListener("change", () => commit(Number(inp.value)));
          box.append(inp, out);
        }
        form.append(l, box);
      }
      item.appendChild(form);
    }
    group.appendChild(item);
  }
  const add = document.createElement("select");
  add.id = "fx-add";
  add.disabled = !editable;
  const first = document.createElement("option");
  first.value = "";
  first.textContent = et("fx.add");
  add.appendChild(first);
  for (const d of EFFECTS) {
    const o = document.createElement("option");
    o.value = d.id;
    o.textContent = et(`fx.${d.id}`);
    add.appendChild(o);
  }
  add.addEventListener("change", () => {
    if (add.value) addEffectTo(node, add.value);
  });
  group.appendChild(add);
  return group;
}

// ---------- 脚本（W8）：语法预检 → 应用（结构编辑重挂）→ 运行期错误按挂点回显 ----------

/** 未应用的脚本改动（检视器重绘时不丢），键 = 图层 id | 挂点；换文档即清空 */
const scriptDrafts = new Map<string, string>();

function showScriptCheck(el: HTMLElement, src: string): boolean {
  const r = checkSceneScript(src);
  el.classList.remove("ok", "warn", "err");
  if (!r.ok) {
    el.classList.add("err");
    el.textContent = et("sc.syntaxErr", { line: r.line ?? "?", msg: r.message });
  } else if (r.noEntry) {
    el.classList.add("warn");
    el.textContent = et("sc.noEntry");
  } else {
    el.classList.add("ok");
    el.textContent = et("sc.ok", { entries: r.entries.join(", ") });
  }
  return r.ok;
}

/** 运行期错误（引擎按「图层 + 挂点」登记），定时刷新到打开着的脚本面板 */
function refreshScriptIssues() {
  const boxes = inspectorEl.querySelectorAll<HTMLElement>(".ed-script-issues");
  if (!boxes.length) return;
  const issues = editor?.getScriptIssues() ?? [];
  for (const box of boxes) {
    const id = box.dataset.layer;
    const mine = issues.filter((x) => String(x.layerId) === id && x.target === box.dataset.target);
    const text = mine
      .map((x) => et("sc.issue", { phase: x.phase, line: x.line ?? "?", msg: x.message, n: x.count }))
      .join("\n");
    if (box.textContent !== text) box.textContent = text;
    box.hidden = !mine.length;
  }
}

function scriptsGroup(node: LayerNode): HTMLElement {
  const group = document.createElement("div");
  group.className = "ed-insp-group ed-scripts";
  const h = document.createElement("div");
  h.className = "ed-insp-title";
  h.textContent = et("insp.scripts");
  group.appendChild(h);
  const editable = !!doc?.scene && !!current?.assets && !isLocked(node.id);
  const slots = scriptSlots(node.obj);
  if (!slots.length) group.appendChild(note(et("sc.none")));
  for (const s of slots) {
    const item = document.createElement("div");
    item.className = "ed-script";
    item.dataset.target = s.target;
    const head = document.createElement("div");
    head.className = "ed-fx-head";
    const name = document.createElement("span");
    name.className = "ed-fx-name";
    name.textContent = s.target;
    const del = document.createElement("button");
    del.type = "button";
    del.className = "ed-icon ed-script-del";
    del.textContent = "✕";
    del.title = et("sc.del");
    del.disabled = !editable;
    del.onclick = () => objEdit(et("log.scRemoved", { target: s.target, layer: nodeName(node.id) }), node.id, (o) => removeScript(o, s.target));
    head.append(name, del);
    const draftKey = `${node.id}|${s.target}`;
    const ta = document.createElement("textarea");
    ta.className = "ed-script-src";
    ta.spellcheck = false;
    ta.value = scriptDrafts.get(draftKey) ?? s.script;
    ta.readOnly = !editable;
    ta.rows = Math.min(16, Math.max(5, s.script.split("\n").length + 1));
    const status = document.createElement("div");
    status.className = "ed-script-status";
    const apply = document.createElement("button");
    apply.type = "button";
    apply.className = "ed-btn ed-script-apply";
    apply.textContent = et("sc.apply");
    const sync = () => {
      const ok = showScriptCheck(status, ta.value);
      apply.disabled = !editable || !ok || ta.value === s.script;
    };
    let timer = 0;
    ta.addEventListener("input", () => {
      if (ta.value === s.script) scriptDrafts.delete(draftKey);
      else scriptDrafts.set(draftKey, ta.value);
      clearTimeout(timer);
      timer = window.setTimeout(sync, 150);
    });
    const commit = () => {
      sync();
      if (apply.disabled) return;
      scriptDrafts.delete(draftKey);
      objEdit(et("log.scApplied", { target: s.target, layer: nodeName(node.id) }), node.id, (o) => setScript(o, s.target, ta.value));
    };
    apply.onclick = commit;
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Tab" && !e.shiftKey && !ta.readOnly) {
        e.preventDefault();
        ta.setRangeText("\t", ta.selectionStart, ta.selectionEnd, "end");
        ta.dispatchEvent(new Event("input"));
      } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        commit();
      }
    });
    const issues = document.createElement("pre");
    issues.className = "ed-script-issues";
    issues.dataset.layer = String(node.id);
    issues.dataset.target = s.target;
    issues.hidden = true;
    const foot = document.createElement("div");
    foot.className = "ed-script-foot";
    foot.append(status, apply);
    item.append(head, ta, foot, issues);
    group.appendChild(item);
    sync();
  }
  const taken = new Set(slots.map((s) => s.target));
  const free = addableTargets(node.kind).filter((t) => !taken.has(t));
  const add = document.createElement("select");
  add.id = "script-add";
  add.disabled = !editable || !free.length;
  const first = document.createElement("option");
  first.value = "";
  first.textContent = et("sc.add");
  add.appendChild(first);
  for (const t of free) {
    const o = document.createElement("option");
    o.value = t;
    o.textContent = t;
    add.appendChild(o);
  }
  add.addEventListener("change", () => {
    const t = add.value;
    if (t) objEdit(et("log.scAdded", { target: t, layer: nodeName(node.id) }), node.id, (o) => setScript(o, t, scriptTemplate(t)));
  });
  group.appendChild(add);
  queueMicrotask(refreshScriptIssues);
  return group;
}

// ---------- 用户属性（W9）：声明 / 改值（热更）/ 删除，图层字段绑定 ----------

/** 属性值改动的预览：只推给引擎，不进文档（拖滑条中） */
function previewProp(p: PropView, value: unknown) {
  const v = coerceValue(p, value);
  if (v === null || !editor) return;
  void editor.declareUserProperties({ [p.name]: { ...p, value: v } }).catch(() => {});
}

/** 属性表改动（声明 / 值 / 文案 / 范围 / 选项）：入栈，引擎按新声明热更 */
function propEdit(label: string, name: string, mutate: (d: EditorDoc) => boolean) {
  structEdit(
    label,
    (d) => (mutate(d) ? selectedId : undefined),
    () => {
      const p = propOf(doc, name);
      if (p) void editor?.declareUserProperties({ [name]: p }).catch(() => {});
    },
  );
}

function propValueControl(p: PropView, editable: boolean): HTMLElement {
  const box = document.createElement("div");
  box.className = "ed-fx-param";
  const commit = (v: unknown) => propEdit(et("log.upValue", { name: p.name }), p.name, (d) => setPropValue(d, p.name, v));
  if (p.type === "slider") {
    const inp = document.createElement("input");
    inp.type = "range";
    inp.min = String(p.min ?? 0);
    inp.max = String(p.max ?? 1);
    inp.step = String(p.step ?? 0.01);
    inp.value = String(p.value);
    const out = document.createElement("span");
    out.className = "ed-val";
    out.textContent = fmtNum(Number(p.value));
    inp.addEventListener("input", () => {
      out.textContent = fmtNum(Number(inp.value));
      previewProp(p, inp.value);
    });
    inp.addEventListener("change", () => commit(inp.value));
    inp.disabled = !editable;
    inp.dataset.prop = p.name;
    box.append(inp, out);
  } else if (p.type === "color") {
    const inp = document.createElement("input");
    inp.type = "color";
    inp.value = toHex(String(p.value).trim().split(/\s+/).map(Number));
    inp.addEventListener("input", () => previewProp(p, fromHex(inp.value)));
    inp.addEventListener("change", () => commit(fromHex(inp.value)));
    inp.disabled = !editable;
    inp.dataset.prop = p.name;
    box.appendChild(inp);
  } else if (p.type === "bool") {
    const inp = document.createElement("input");
    inp.type = "checkbox";
    inp.checked = p.value === true;
    inp.addEventListener("change", () => commit(inp.checked));
    inp.disabled = !editable;
    inp.dataset.prop = p.name;
    box.appendChild(inp);
  } else if (p.type === "combo") {
    const sel = document.createElement("select");
    for (const o of p.options ?? []) {
      const opt = document.createElement("option");
      opt.value = o.value;
      opt.textContent = o.label;
      sel.appendChild(opt);
    }
    sel.value = String(p.value);
    sel.addEventListener("change", () => commit(sel.value));
    sel.disabled = !editable;
    sel.dataset.prop = p.name;
    box.appendChild(sel);
  } else {
    const inp = document.createElement("input");
    inp.type = "text";
    inp.value = String(p.value ?? "");
    inp.addEventListener("change", () => commit(inp.value));
    inp.disabled = !editable;
    inp.dataset.prop = p.name;
    box.appendChild(inp);
  }
  return box;
}

function userPropsGroup(): HTMLElement {
  const group = document.createElement("div");
  group.className = "ed-insp-group ed-props";
  const h = document.createElement("div");
  h.className = "ed-insp-title";
  h.textContent = et("insp.userProps");
  group.appendChild(h);
  const editable = !!doc?.scene && !!current?.assets;
  const props = listProps(doc);
  if (!props.length) group.appendChild(note(et("up.none")));
  for (const p of props) {
    const item = document.createElement("div");
    item.className = "ed-fx-item ed-prop";
    item.dataset.prop = p.name;
    const head = document.createElement("div");
    head.className = "ed-fx-head";
    const name = document.createElement("span");
    name.className = "ed-fx-name";
    name.textContent = `${p.name} · ${et(`up.type.${p.type}`)}`;
    const del = document.createElement("button");
    del.type = "button";
    del.className = "ed-icon ed-prop-del";
    del.textContent = "✕";
    del.title = et("up.del");
    del.disabled = !editable;
    del.onclick = () =>
      structEdit(et("log.upRemoved", { name: p.name }), (d) => (removeProp(d, p.name) >= 0 ? selectedId : undefined));
    head.append(name, del);
    const form = document.createElement("div");
    form.className = "ed-fx-params";
    const textLabel = document.createElement("label");
    textLabel.textContent = et("up.text");
    const text = document.createElement("input");
    text.type = "text";
    text.className = "ed-prop-text";
    text.value = p.text ?? "";
    text.disabled = !editable;
    text.addEventListener("change", () => propEdit(et("log.upMeta", { name: p.name }), p.name, (d) => setPropText(d, p.name, text.value)));
    const valueLabel = document.createElement("label");
    valueLabel.textContent = et("up.value");
    form.append(textLabel, text, valueLabel, propValueControl(p, editable));
    if (p.type === "slider") {
      const rl = document.createElement("label");
      rl.textContent = et("up.range");
      const range = document.createElement("input");
      range.type = "text";
      range.className = "ed-prop-range";
      range.value = `${p.min ?? 0} ${p.max ?? 1} ${p.step ?? 0.01}`;
      range.title = et("up.rangeHint");
      range.disabled = !editable;
      range.addEventListener("change", () => {
        const [a, b, c] = range.value.trim().split(/\s+/).map(Number);
        propEdit(et("log.upMeta", { name: p.name }), p.name, (d) => setSliderRange(d, p.name, a, b, c ?? 0.01));
      });
      form.append(rl, range);
    } else if (p.type === "combo") {
      const ol = document.createElement("label");
      ol.textContent = et("up.options");
      const opts = document.createElement("textarea");
      opts.className = "ed-prop-options";
      opts.rows = Math.max(2, (p.options ?? []).length);
      opts.value = formatComboOptions(p.options);
      opts.title = et("up.optionsHint");
      opts.disabled = !editable;
      opts.addEventListener("change", () =>
        propEdit(et("log.upMeta", { name: p.name }), p.name, (d) => setComboOptions(d, p.name, parseComboOptions(opts.value))),
      );
      form.append(ol, opts);
    }
    item.append(head, form);
    group.appendChild(item);
  }
  const add = document.createElement("div");
  add.className = "ed-prop-add";
  const nameIn = document.createElement("input");
  nameIn.type = "text";
  nameIn.id = "up-name";
  nameIn.placeholder = et("up.namePh");
  nameIn.disabled = !editable;
  const typeSel = document.createElement("select");
  typeSel.id = "up-type";
  typeSel.disabled = !editable;
  for (const t of PROP_TYPES) {
    const o = document.createElement("option");
    o.value = t;
    o.textContent = et(`up.type.${t}`);
    typeSel.appendChild(o);
  }
  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.id = "up-add";
  addBtn.className = "ed-btn";
  addBtn.textContent = et("up.add");
  const sync = () => (addBtn.disabled = !editable || !isValidPropName(doc, nameIn.value.trim()));
  nameIn.addEventListener("input", sync);
  addBtn.onclick = () => {
    const n = nameIn.value.trim();
    const t = typeSel.value as PropType;
    propEdit(et("log.upAdded", { name: n }), n, (d) => !!declareProp(d, n, t));
  };
  sync();
  add.append(nameIn, typeSel, addBtn);
  group.appendChild(add);
  return group;
}

function bindingsGroup(node: LayerNode): HTMLElement {
  const group = document.createElement("div");
  group.className = "ed-insp-group ed-bindings";
  const h = document.createElement("div");
  h.className = "ed-insp-title";
  h.textContent = et("insp.bindings");
  group.appendChild(h);
  const props = listProps(doc);
  const editable = !!doc?.scene && !!current?.assets && !isLocked(node.id);
  if (!props.length) {
    group.appendChild(note(et("bind.noProps")));
    return group;
  }
  const form = document.createElement("div");
  form.className = "ed-fx-params";
  for (const f of bindableFor(node.kind)) {
    const l = document.createElement("label");
    l.textContent = f.field;
    const sel = document.createElement("select");
    sel.dataset.bind = f.field;
    sel.disabled = !editable;
    const none = document.createElement("option");
    none.value = "";
    none.textContent = et("bind.none");
    sel.appendChild(none);
    for (const p of props.filter((x) => f.types.includes(x.type))) {
      const opts = p.type === "combo" ? (p.options ?? []).map((o) => ({ v: `${p.name}=${o.value}`, t: `${p.name} = ${o.label}` })) : [{ v: p.name, t: p.name }];
      for (const o of opts) {
        const opt = document.createElement("option");
        opt.value = o.v;
        opt.textContent = o.t;
        sel.appendChild(opt);
      }
    }
    const b = bindingOf(node.obj, f.field);
    sel.value = b ? (b.condition !== undefined ? `${b.name}=${b.condition}` : b.name) : "";
    sel.addEventListener("change", () => {
      const v = sel.value;
      const i = v.indexOf("=");
      const name = i < 0 ? v : v.slice(0, i);
      const cond = i < 0 ? undefined : v.slice(i + 1);
      objEdit(
        v ? et("log.bound", { layer: nodeName(node.id), field: f.field, name }) : et("log.unbound", { layer: nodeName(node.id), field: f.field }),
        node.id,
        (o) => (v ? !!doc && bindProp(doc, o, f.field, name, cond) : unbindProp(o, f.field)),
      );
    });
    form.append(l, sel);
  }
  group.appendChild(form);
  return group;
}

function renderInspector() {
  inspectorEl.textContent = "";
  if (!doc) {
    inspectorEl.appendChild(note(et("insp.none")));
    return;
  }
  const node = selectedId !== null ? findNode(doc.roots, selectedId) : null;
  if (!node) {
    const p = doc.project;
    const res = sceneResolution(doc.scene);
    const props = (p?.general as Record<string, unknown> | undefined)?.properties;
    inspectorEl.appendChild(
      kvGroup(et("insp.project"), [
        ["f.title", typeof p?.title === "string" ? p.title : doc.title],
        ["f.type", doc.type],
        ["f.file", p?.file],
        ["f.form", doc.form ? et(`form.${doc.form}`) : "—"],
        ["f.resolution", res ? `${res.w} × ${res.h}` : "—"],
        ["f.props", props && typeof props === "object" ? String(Object.keys(props).length) : "0"],
      ]),
    );
    if (doc.type === "scene") {
      inspectorEl.appendChild(userPropsGroup());
      inspectorEl.appendChild(note(et("insp.none")));
    }
    return;
  }
  inspectorEl.appendChild(editGroup(node));
  if (canHaveEffects(node)) inspectorEl.appendChild(effectsGroup(node));
  inspectorEl.appendChild(bindingsGroup(node));
  inspectorEl.appendChild(scriptsGroup(node));
  const o = node.obj;
  const effects = Array.isArray(o.effects)
    ? (o.effects as Array<Record<string, unknown>>)
        .map((e) => String(e?.name || e?.file || "?"))
        .join("\n")
    : "";
  const source = o.image ?? o.model ?? o.particle ?? (o.text !== undefined ? unwrap(o.text) : undefined);
  const color = colorCss(o.color);
  inspectorEl.appendChild(
    kvGroup(node.name || `#${node.id}`, [
      ["f.id", String(node.id)],
      ["f.kind", et(`kind.${node.kind}`)],
      ["f.parent", o.parent],
      ["f.visible", node.visible ? "true" : "false"],
      ["f.origin", o.origin],
      ["f.scale", o.scale],
      ["f.angles", o.angles],
      ["f.size", o.size],
      ["f.alpha", o.alpha],
      [
        "f.color",
        o.color,
        color
          ? (dd) => {
              const sw = document.createElement("span");
              sw.className = "ed-swatch";
              sw.style.background = color;
              dd.prepend(sw);
            }
          : undefined,
      ],
      ["f.source", source],
      ["f.effects", effects || "—"],
    ]),
  );
  inspectorEl.appendChild(note(et("insp.readonly")));
  inspectorEl.appendChild(rawGroup(o));
}

// ---------- 启动 ----------

applyEditorStatic();
layoutStage();
renderLibrary();
renderTree();
renderInspector();
renderStatus();
syncPlayButton();
syncTimeline();
requestAnimationFrame(tickTimeline);
void loadLibrary();
void checkDraft();
