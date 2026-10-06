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
import {
  duplicateLayer,
  moveLayer,
  rebuildTree,
  removeLayer,
  sceneResolution,
  unwrap,
  writeObjProps,
  type EditorDoc,
  type LayerNode,
} from "./doc";
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
} from "./open";

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
        ? sourceFromDoc(current.source, current.assets, JSON.stringify(doc.scene))
        : current.source;
    const inst = await mount(stageEl, {
      source,
      fit: fitEl.value as Fit,
      renderDpr: Number(dprEl.value),
      volume: 0,
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

async function openWith(name: string, load: () => Promise<Opened>) {
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
  if (gen !== openGen) return;
  current?.source.dispose?.();
  current = opened;
  doc = opened.doc;
  selectedId = null;
  collapsed.clear();
  locked.clear();
  docDriven = false;
  resetHistory();
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
  if (!hits.length) {
    lastPick = null;
    log(et("log.pickNone"));
    selectLayer(null);
    return;
  }
  // Alt+点击：同一叠层内逐层向下切换
  const key = hits.map((h) => h.id).join(",");
  const idx = e.altKey && lastPick?.key === key ? (lastPick.idx + 1) % hits.length : 0;
  lastPick = { key, idx };
  const hit: EditorLayer = hits[idx];
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

type Patch = Partial<EditorLayerProps>;
type PropsCmd = { id: number | string; name: string; before: Patch; after: Patch };
/** 结构编辑以整份对象数组快照记账（文档级，撤销即换回快照再重挂） */
type StructCmd = {
  kind: "struct";
  label: string;
  before: string;
  after: string;
  selBefore: number | string | null;
  selAfter: number | string | null;
};
type EditCmd = PropsCmd | StructCmd;
const isStruct = (c: EditCmd): c is StructCmd => "kind" in c && c.kind === "struct";

const undoStack: EditCmd[] = [];
const redoStack: EditCmd[] = [];
/** 本文档累计的热改（按层合并）：重挂后原样重放，保证「重挂 ≡ 热改」 */
const liveEdits = new Map<string, Patch>();
let dirty = false;

function resetHistory() {
  undoStack.length = 0;
  redoStack.length = 0;
  liveEdits.clear();
  dirty = false;
  syncHistoryButtons();
}

function syncHistoryButtons() {
  undoEl.disabled = !undoStack.length;
  redoEl.disabled = !redoStack.length;
}

function syncDocTitle() {
  docTitleEl.textContent = doc ? `${dirty ? "● " : ""}${doc.title}` : "";
  docTitleEl.title = dirty ? et("st.dirty") : "";
}

function nodeName(id: number | string): string {
  const n = doc ? findNode(doc.roots, id) : null;
  return n?.name || `#${id}`;
}

/** 只取 patch 里出现的键（撤销记录的 before 与 after 键集一致） */
function pick(props: EditorLayerProps, keys: Array<keyof EditorLayerProps>): Patch {
  const out: Patch = {};
  for (const k of keys) (out as Record<string, unknown>)[k] = structuredClone(props[k]);
  return out;
}

/** 写引擎 + 写文档 + 记账，不进撤销栈（拖拽/滑条的中间态也走这里） */
function applyPatch(id: number | string, patch: Patch): Promise<void> {
  const node = doc ? findNode(doc.roots, id) : null;
  if (node) {
    writeObjProps(node.obj, patch);
    if (patch.visible !== undefined) node.visible = patch.visible;
  }
  const key = String(id);
  liveEdits.set(key, { ...(liveEdits.get(key) ?? {}), ...structuredClone(patch) });
  markDirty();
  return editor ? editor.setLayerProps(Number(id), patch).catch((e) => log(String(e?.message ?? e), "warn")) : Promise.resolve();
}

function pushHistory(cmd: EditCmd) {
  undoStack.push(cmd);
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
  syncHistoryButtons();
}

function markDirty() {
  if (dirty) return;
  dirty = true;
  syncDocTitle();
}

function commit(cmd: PropsCmd) {
  const same = JSON.stringify(cmd.before) === JSON.stringify(cmd.after);
  if (same) return;
  pushHistory(cmd);
  log(et("log.edited", { name: cmd.name, fields: Object.keys(cmd.after).join(", ") }));
}

/** 文档对象数组整体换成某个快照，然后整场景重挂（结构编辑 / 其撤销重做共用） */
function restoreObjects(json: string, sel: number | string | null) {
  if (!doc?.scene) return;
  doc.scene.objects = JSON.parse(json);
  rebuildTree(doc);
  // 文档已含全部改动，旧的按层热改账作废（被删的层也不该再重放）
  liveEdits.clear();
  docDriven = true;
  selectedId = sel !== null && findNode(doc.roots, sel) ? sel : null;
  renderTree();
  renderInspector();
  renderStatus();
  void mountCurrent(true);
}

/** 一次结构编辑：快照 → 改文档 → 入栈 → 重挂。mutate 返回新的选中 id（undefined = 没改成） */
function structEdit(label: string, mutate: (d: EditorDoc) => number | string | null | undefined) {
  if (!doc?.scene || !current?.assets) {
    log(et("log.structUnavailable"), "warn");
    return;
  }
  const before = JSON.stringify(doc.scene.objects ?? []);
  const selBefore = selectedId;
  const sel = mutate(doc);
  if (sel === undefined) return;
  const after = JSON.stringify(doc.scene.objects ?? []);
  if (after === before) return;
  pushHistory({ kind: "struct", label, before, after, selBefore, selAfter: sel });
  markDirty();
  log(label);
  restoreObjects(after, sel);
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
  const before = pick(cur, keys);
  void applyPatch(id, patch);
  commit({ id, name: nodeName(id), before, after: structuredClone(patch) });
}

function undoRedo(dir: "undo" | "redo") {
  const from = dir === "undo" ? undoStack : redoStack;
  const to = dir === "undo" ? redoStack : undoStack;
  const cmd = from.pop();
  if (!cmd) return;
  to.push(cmd);
  syncHistoryButtons();
  if (isStruct(cmd)) {
    log(et(dir === "undo" ? "log.undo" : "log.redo", { name: cmd.label }));
    restoreObjects(dir === "undo" ? cmd.before : cmd.after, dir === "undo" ? cmd.selBefore : cmd.selAfter);
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

type Pt = [number, number];
/** 手柄边长 / 命中半径（CSS 像素） */
const HANDLE = 8;
const ROTATE_OFFSET = 22;
/**
 * 当前选中层的手柄几何（画布 CSS 坐标），drawOverlay 每帧刷新，pointerdown 据此判命中。
 * corners 顺序同 layerQuadWorld：层局部的左上、右上、右下、左下（未旋转时即屏幕方位），
 * 旋转柄挂在局部上边（c0→c1）中点外侧，跟着层一起转。
 */
let gizmo: { anchor: Pt; corners: Pt[]; rotate: Pt | null } | null = null;

function gizmoOf(anchor: readonly number[], corners: ReadonlyArray<readonly number[]> | null) {
  const a: Pt = [anchor[0], anchor[1]];
  if (!corners) return { anchor: a, corners: [] as Pt[], rotate: null };
  const cs = corners.map((c) => [c[0], c[1]] as Pt);
  const cx = cs.reduce((s, c) => s + c[0], 0) / 4;
  const cy = cs.reduce((s, c) => s + c[1], 0) / 4;
  const mx = (cs[0][0] + cs[1][0]) / 2;
  const my = (cs[0][1] + cs[1][1]) / 2;
  const len = Math.hypot(mx - cx, my - cy) || 1;
  const rotate: Pt = [mx + ((mx - cx) / len) * ROTATE_OFFSET, my + ((my - cy) / len) * ROTATE_OFFSET];
  return { anchor: a, corners: cs, rotate };
}

type HandleHit = { kind: "scale"; corner: number } | { kind: "rotate" } | null;

function handleAt(x: number, y: number): HandleHit {
  if (!gizmo) return null;
  const near = (p: Pt) => Math.hypot(p[0] - x, p[1] - y) <= HANDLE;
  if (gizmo.rotate && near(gizmo.rotate)) return { kind: "rotate" };
  const i = gizmo.corners.findIndex(near);
  return i >= 0 ? { kind: "scale", corner: i } : null;
}

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
const unit = (x: number, y: number): Pt => {
  const l = Math.hypot(x, y) || 1;
  return [x / l, y / l];
};
const dot = (a: Pt, b: Pt) => a[0] * b[0] + a[1] * b[1];

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
  const handle = handleAt(p.x, p.y);
  if (!handle && !overSelected(p.x, p.y)) return;
  const props = editor.getLayerProps(Number(selectedId));
  if (!props) return;
  const g = gizmo;
  const c = g?.corners ?? [];
  drag = {
    mode: handle?.kind ?? "move",
    id: selectedId,
    pointerId: e.pointerId,
    x0: p.x,
    y0: p.y,
    props0: structuredClone(props),
    anchor: g?.anchor ?? [p.x, p.y],
    ax: c.length ? unit(c[1][0] - c[0][0], c[1][1] - c[0][1]) : [1, 0],
    ay: c.length ? unit(c[3][0] - c[0][0], c[3][1] - c[0][1]) : [0, 1],
    moved: false,
  };
  stageEl.setPointerCapture(e.pointerId);
});

stageEl.addEventListener("pointermove", (e) => {
  const p = canvasPoint(e);
  if (!p) return;
  if (!drag || e.pointerId !== drag.pointerId || !editor) {
    if (e.buttons) return;
    const h = !isLocked(selectedId) ? handleAt(p.x, p.y) : null;
    const cursor = h ? h.kind : !isLocked(selectedId) && overSelected(p.x, p.y) ? "move" : "";
    if ((stageEl.dataset.cursor ?? "") !== cursor) stageEl.dataset.cursor = cursor;
    return;
  }
  const dx = p.x - drag.x0;
  const dy = p.y - drag.y0;
  if (!drag.moved && Math.hypot(dx, dy) < 3) return;
  drag.moved = true;
  const p0 = drag.props0;
  if (drag.mode === "move") {
    const d = editor.screenDeltaToLocal(Number(drag.id), dx, dy);
    if (!d) return;
    void applyPatch(drag.id, { origin: [p0.origin[0] + d[0], p0.origin[1] + d[1], p0.origin[2]] });
    return;
  }
  const a = drag.anchor;
  const v0: Pt = [drag.x0 - a[0], drag.y0 - a[1]];
  const v1: Pt = [p.x - a[0], p.y - a[1]];
  if (drag.mode === "rotate") {
    // 屏幕 y 向下、WE 角度 y 向上：屏幕顺时针 = 角度减小
    let z = p0.angles[2] - (Math.atan2(v1[1], v1[0]) - Math.atan2(v0[1], v0[0]));
    if (e.shiftKey) z = Math.round(z / (15 * RAD)) * 15 * RAD;
    void applyPatch(drag.id, { angles: [p0.angles[0], p0.angles[1], z] });
    return;
  }
  // 角点缩放：沿层自身两轴分别求「现距 / 原距」；锚点恰在该轴上（如左上对齐拖左上角）时该轴不动
  const ratio = (axis: Pt) => {
    const d0 = dot(v0, axis);
    return Math.abs(d0) < 4 ? 1 : dot(v1, axis) / d0;
  };
  let sx = ratio(drag.ax);
  let sy = ratio(drag.ay);
  if (e.shiftKey) sx = sy = Math.hypot(v1[0], v1[1]) / (Math.hypot(v0[0], v0[1]) || 1);
  const MIN = 0.01;
  void applyPatch(drag.id, {
    scale: [Math.max(MIN, p0.scale[0] * sx), Math.max(MIN, p0.scale[1] * sy), p0.scale[2]],
  });
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
    commit({ id: d.id, name: nodeName(d.id), before: pick(d.props0, [key]), after: pick(after, [key]) });
    renderInspector();
  }
}
stageEl.addEventListener("pointerup", endDrag);
stageEl.addEventListener("pointercancel", endDrag);

// ---------- 状态栏 ----------

function renderStatus() {
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
  void openWith(it.title, () => openLibraryItem(it, MEDIA_BASE, WEB_BASE));
}

filterEl.oninput = renderLibrary;

async function loadLibrary() {
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
    const want = new URL(location.href).searchParams.get("item");
    const hit = want ? libItems.find((i) => i.itemId === want) : undefined;
    if (hit) openLibrary(hit);
  } catch (e) {
    libState = "static";
    renderLibrary();
    log(et("log.libFailed", { msg: (e as Error).message }), "error");
  }
}

// ---------- 本地打开 / 拖放 ----------

function openLocal(files: ReturnType<typeof filesFromInput>) {
  if (!files.length) return;
  activeItemId = null;
  renderLibrary();
  const url = new URL(location.href);
  url.searchParams.delete("item");
  history.replaceState(null, "", url);
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
    if (files.length) openLocal(files);
    else log(et("log.dropEmpty"), "warn");
  });
});

// ---------- 图层树（P0 只读：来自 scene.json） ----------

const LOCK_SVG =
  '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M5 7V5a3 3 0 0 1 6 0v2h1.5v7h-9V7zm1.2 0h3.6V5a1.8 1.8 0 0 0-3.6 0z"/></svg>';
const UNLOCK_SVG =
  '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M5 7V5a3 3 0 0 1 5.9-.8l-1.15.35A1.8 1.8 0 0 0 6.2 5v2h6.3v7h-9V7zm-.3 1.2v4.6h6.6V8.2z"/></svg>';

const lyUpEl = $<HTMLButtonElement>("#ly-up");
const lyDownEl = $<HTMLButtonElement>("#ly-down");
const lyDupEl = $<HTMLButtonElement>("#ly-dup");
const lyDelEl = $<HTMLButtonElement>("#ly-del");
lyUpEl.onclick = () => moveSelected(-1);
lyDownEl.onclick = () => moveSelected(1);
lyDupEl.onclick = () => duplicateSelected();
lyDelEl.onclick = () => deleteSelected();

function syncLayerTools() {
  const off = !selectedNode() || !current?.assets || doc?.type !== "scene";
  for (const b of [lyUpEl, lyDownEl, lyDupEl, lyDelEl]) b.disabled = off;
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

/** 根到目标节点的路径（含目标）。引擎活层 id 是数值，文档 id 可能是字符串，按字符串比 */
function findPath(nodes: LayerNode[], id: number | string): LayerNode[] | null {
  for (const n of nodes) {
    if (String(n.id) === String(id)) return [n];
    const sub = findPath(n.children, id);
    if (sub) return [n, ...sub];
  }
  return null;
}

function findNode(nodes: LayerNode[], id: number | string): LayerNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    const hit = findNode(n.children, id);
    if (hit) return hit;
  }
  return null;
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
    commit({ id, name: nodeName(id), before: pick(before, keys), after: pick(after, keys) });
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
    if (doc.type === "scene") inspectorEl.appendChild(note(et("insp.none")));
    return;
  }
  inspectorEl.appendChild(editGroup(node));
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
