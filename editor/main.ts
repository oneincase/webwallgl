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
  SYSTEM_FONT_FAMILIES,
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
import { applyPlatformClasses } from "../shared/workbench/platform";
import { bindThemeButton } from "../shared/workbench/theme";
import { applyEditorStatic, et } from "./i18n";
import { resetEditorLayout } from "./layout";
import { overlayAssets, type OverlayAssets } from "./assets";
import {
  RESOLUTIONS,
  addImageLayer,
  blankScene,
  hexToRgb,
  imageLayerFiles,
  imageSlug,
  isImageFile,
  layerNameOf,
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
  FONT_FILE_RE,
  H_ALIGNS,
  SYSTEM_FONTS,
  V_ALIGNS,
  addTextLayer,
  fontLabel,
  fontPathOf,
  getTextFields,
  isBoundText,
  isFontFile,
  isScriptedText,
  isSystemFont,
  referencedFonts,
  refitTextBox,
  setTextField,
  setTextValue,
  textValue,
  type TextField,
  type TextFields,
  type TextPreset,
} from "./text";
import {
  PARTICLE_PARAMS,
  PARTICLE_RANGES,
  addParticleLayer,
  getParticleParams,
  particleLayerFiles,
  particlePathOf,
  particleSlug,
  referencedParticles,
  setParticleColor,
  setParticleParam,
  type ParticleParam,
  type ParticlePreset,
} from "./particles";
import {
  PLAYBACK_MODES,
  addSoundLayer,
  getSoundFields,
  isAudioFile,
  referencedSounds,
  replaceSoundFile,
  setSoundField,
  soundLabel,
  soundPathOf,
  type SoundField,
  type SoundFields,
} from "./sound";
import {
  ANIM_FIELDS,
  ANIM_MODES,
  animSummary,
  baseValue,
  copyKeysAt,
  disableAnim,
  enableAnim,
  frameAt,
  getAnim,
  isAnimated,
  keyTimes,
  moveKeyTime,
  pasteKeysAt,
  removeKey,
  setAnimOption,
  setKey,
  setSmooth,
  splitAnimated,
  type AnimField,
  type AnimMode,
  type KeyClip,
} from "./keyframes";
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
import {
  ALIGN_MODES,
  alignDeltas,
  boxOf,
  sceneFrame,
  snapMove,
  snapTargets,
  unionBox,
  type AlignMode,
  type Box,
  type SnapTargets,
} from "./snap";
import { scriptsAllowedByDefault, scriptsOverrideFrom } from "./trust";
import {
  duplicateLayer,
  findNode,
  findPath,
  groupLayer,
  groupLayers,
  isLockedObj,
  makeDoc,
  moveLayer,
  placeLayer,
  removeLayer,
  sceneResolution,
  setLocked,
  topLevelIds,
  unwrap,
  writeObjProps,
  type EditorDoc,
  type LayerNode,
  type PlaceResult,
  type PlaceWhere,
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
  batchCommand,
  isBatch,
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
  packProject,
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
const tlKeysEl = $<HTMLElement>("#tl-keys");
const tlTrackEl = $<HTMLElement>("#tl-track");
const tlLanesEl = $<HTMLElement>("#tl-lanes");
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

// ---------- 外壳：平台、主题、语言、面板布局（与测试台共用 shared/workbench） ----------

applyPlatformClasses();
const themeBtn = bindThemeButton($("#theme-toggle"), (mode) => t(`theme.${mode}`));

$<HTMLButtonElement>("#layout-reset").onclick = () => {
  resetEditorLayout();
  log(t("log.layoutReset"));
};

const langEl = $<HTMLSelectElement>("#lang");
langEl.value = getLang();
langEl.onchange = () => setLang(langEl.value as Lang);
onChangeLang(() => {
  themeBtn.refresh();
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
  let w = Math.floor(availW);
  let h = Math.floor(availH);
  if (aspectEl.value !== "fill") {
    // 按宽高比的整数倍取尺寸：宽高各自取整会让比例漂离精确值，
    // 画面 ↔ 世界坐标的 x / y 换算就不再一致（手柄拖拽会轻微走样）
    const [aw, ah] = aspectEl.value.split(":").map(Number);
    const k = Math.max(0, Math.floor(Math.min(availW / aw, availH / ah)));
    w = k * aw;
    h = k * ah;
  }
  stageEl.style.width = `${w}px`;
  stageEl.style.height = `${h}px`;
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
/** 多选：selectedId 是主选（检视器 / 手柄跟它走），extraSel 是追加选中的其余层 */
const extraSel = new Set<string>();

function selectionNodes(): LayerNode[] {
  if (!doc || selectedId === null) return [];
  const out: LayerNode[] = [];
  for (const id of [String(selectedId), ...extraSel]) {
    const n = findPath(doc.roots, id)?.at(-1);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

const isSelected = (id: number | string) => (selectedId !== null && String(selectedId) === String(id)) || extraSel.has(String(id));

/** ⇧ / ⌘ 点：加入或移出选中集合；移出主选时由下一个顶上 */
function toggleSelect(id: number | string) {
  const key = String(id);
  if (selectedId !== null && String(selectedId) === key) {
    const next = [...extraSel][0];
    extraSel.delete(next);
    selectedId = next === undefined ? null : (findPath(doc?.roots ?? [], next)?.at(-1)?.id ?? null);
  } else if (extraSel.has(key)) {
    extraSel.delete(key);
  } else if (selectedId === null) {
    selectedId = findPath(doc?.roots ?? [], key)?.at(-1)?.id ?? null;
  } else {
    extraSel.add(key);
  }
  renderTree();
  renderInspector();
}

const isLocked = (id: number | string | null) => {
  if (id === null || !doc) return false;
  const n = findPath(doc.roots, id)?.at(-1);
  return !!n && isLockedObj(n.obj);
};
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
  const stayPaused = keepTime && !!instance?.paused;
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
      if (stayPaused) inst.pause();
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

/** 资源表的分组引用：图片层的模型 + 图层挂的效果文件 + 工程字体 + 粒子文件 + 音频 */
const referencedGroups = (d: EditorDoc | null) =>
  new Set([
    ...referencedModels(d),
    ...referencedEffects(d),
    ...referencedFonts(d),
    ...referencedParticles(d),
    ...referencedSounds(d),
  ]);

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
  stopPreview();
  overlay =
    opened.assets && opened.doc.scene ? overlayAssets(opened.assets.entry, opened.assets, () => referencedGroups(doc)) : null;
  if (overlay) opened = { ...opened, assets: overlay };
  current = opened;
  doc = opened.doc;
  selectedId = null;
  extraSel.clear();
  collapsed.clear();
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
  renderKeyMarks();
}

/** 时间轴上画选中层的关键帧（首个周期内的时刻）；可编辑时拖动标记改关键帧时刻 */
function renderKeyMarks() {
  tlKeysEl.textContent = "";
  renderLanes();
  const n = selectedNode();
  if (!n) return;
  const editable = !!editor && !!doc?.scene && !!current?.assets && !isLocked(n.id);
  for (const t of keyTimes(n.obj)) {
    if (t > tlMax) continue;
    const m = document.createElement("i");
    m.className = "tl-key";
    m.dataset.t = String(t);
    m.title = `${fmtTime(t)}${editable ? ` · ${et("anim.dragMark")}` : ""}`;
    m.style.left = `${(t / tlMax) * 100}%`;
    if (editable) {
      m.classList.add("is-draggable");
      m.addEventListener("pointerdown", (e) => startKeyDrag(e, m, n, t));
    }
    tlKeysEl.appendChild(m);
  }
}

/** 时间轴下方按层动画条：每个有动画的图层一行（首周期实条 + 循环 / 往返的后续周期虚条 + 关键帧），点行选中该层 */
function renderLanes() {
  tlLanesEl.textContent = "";
  const rows: Array<{ node: LayerNode; sum: NonNullable<ReturnType<typeof animSummary>> }> = [];
  const walk = (nodes: LayerNode[]) => {
    for (const n of nodes) {
      const sum = canAnimate(n) ? animSummary(n.obj) : null;
      if (sum) rows.push({ node: n, sum });
      walk(n.children);
    }
  };
  if (doc) walk(doc.roots);
  tlLanesEl.hidden = rows.length === 0;
  if (!rows.length) return;
  const host = tlLanesEl.getBoundingClientRect();
  const track = tlTrackEl.getBoundingClientRect();
  const left = Math.max(0, track.left - host.left);
  const width = track.width > 0 ? track.width : host.width - left;
  for (const { node, sum } of rows) {
    const row = document.createElement("div");
    row.className = "tl-lane";
    row.dataset.id = String(node.id);
    if (isSelected(node.id)) row.classList.add("selected");
    const name = document.createElement("span");
    name.className = "tl-lane-name";
    name.textContent = nodeName(node.id);
    name.style.width = `${left}px`;
    const bars = document.createElement("div");
    bars.className = "tl-lane-bars";
    bars.style.left = `${left + 7}px`;
    bars.style.width = `${Math.max(0, width - 14)}px`;
    const pct = (t: number) => `${(Math.min(t, tlMax) / tlMax) * 100}%`;
    const bar = document.createElement("i");
    bar.className = "tl-lane-bar";
    bar.style.width = pct(sum.length);
    bars.appendChild(bar);
    if (sum.mode !== "single" && sum.length < tlMax) {
      const rep = document.createElement("i");
      rep.className = "tl-lane-bar is-repeat";
      rep.style.left = pct(sum.length);
      rep.style.width = `${((tlMax - sum.length) / tlMax) * 100}%`;
      bars.appendChild(rep);
    }
    for (const t of sum.keys) {
      if (t > tlMax) continue;
      const k = document.createElement("i");
      k.className = "tl-lane-key";
      k.dataset.t = String(t);
      k.style.left = pct(t);
      bars.appendChild(k);
    }
    row.title = `${nodeName(node.id)} · ${fmtTime(sum.length)} · ${et(`anim.mode.${sum.mode}`)}`;
    row.append(name, bars);
    row.addEventListener("click", () => selectLayer(node.id));
    tlLanesEl.appendChild(row);
  }
}

new ResizeObserver(() => renderLanes()).observe(tlTrackEl);

function startKeyDrag(e: PointerEvent, m: HTMLElement, n: LayerNode, from: number) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  m.setPointerCapture(e.pointerId);
  m.classList.add("is-dragging");
  scrubbing = true;
  const box = tlKeysEl.getBoundingClientRect();
  const snap = (t: number) => Math.round(t * 30) / 30;
  let to = from;
  const move = (ev: PointerEvent) => {
    to = snap(Math.max(0, Math.min(tlMax, ((ev.clientX - box.left) / box.width) * tlMax)));
    m.style.left = `${(to / tlMax) * 100}%`;
    tlTimeEl.textContent = fmtTime(to);
  };
  const end = () => {
    m.removeEventListener("pointermove", move);
    m.removeEventListener("pointerup", end);
    m.removeEventListener("pointercancel", end);
    m.classList.remove("is-dragging");
    scrubbing = false;
    if (Math.abs(to - from) < 1e-3) return renderKeyMarks();
    const ok = objEditOk(
      et("log.keyMoved", { layer: nodeName(n.id), from: fmtTime(from), to: fmtTime(to) }),
      n.id,
      (o) => moveKeyTime(o, from, to),
    );
    if (!ok) {
      log(et("log.keyMoveBad", { to: fmtTime(to) }), "warn");
      renderKeyMarks();
    }
  };
  m.addEventListener("pointermove", move);
  m.addEventListener("pointerup", end);
  m.addEventListener("pointercancel", end);
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

/** 停在某时刻后，动画层的检视器（数值框 / 当前帧 / 关键帧高亮）要跟着刷新 */
function afterSeek(p: Promise<void>) {
  void seekLogged(p).then(() => {
    const n = selectedNode();
    if (n && ANIM_FIELDS.some((f) => isAnimated(n.obj, f))) renderInspector();
  });
}

tlRangeEl.addEventListener("pointerdown", () => (scrubbing = true));
tlRangeEl.addEventListener("pointerup", () => (scrubbing = false));
tlRangeEl.addEventListener("change", () => {
  scrubbing = false;
  if (editor) afterSeek(editor.seek(Number(tlRangeEl.value)));
});
tlRangeEl.addEventListener("input", () => {
  if (!editor) return;
  const t = Number(tlRangeEl.value);
  tlTimeEl.textContent = fmtTime(t);
  void seekLogged(editor.seek(t));
});
tlStartEl.onclick = () => {
  if (editor) afterSeek(editor.seek(0));
};
tlPrevEl.onclick = () => {
  if (!editor) return;
  pauseForStepping();
  afterSeek(editor.seek(Math.max(0, editor.time - FRAME)));
};
tlNextEl.onclick = () => {
  if (!editor) return;
  pauseForStepping();
  afterSeek(editor.step(1, 60));
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

// ---------- 保存（W6-lite 松散工程 / W6-full WE 原生 scene.pkg → 壁纸库 / 文件夹 / zip） ----------

type SaveTarget = "lib" | "dir" | "zip";
const saveEl = $<HTMLButtonElement>("#tb-save");
const saveMenuEl = $<HTMLElement>("#save-menu");
const saveLibEl = $<HTMLButtonElement>("#save-lib");
const saveDirEl = $<HTMLButtonElement>("#save-dir");
const savePkgEl = $<HTMLInputElement>("#save-pkg");
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
    let files = await collectProject(doc, current.assets, preview);
    if (savePkgEl.checked) {
      const { files: pkgFiles, packed } = packProject(files);
      files = pkgFiles;
      log(et("log.packedPkg", { n: packed.entries.length, tex: packed.converted.length, mb: (packed.pkg.length / 1e6).toFixed(1) }));
    }
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
  if (e.shiftKey && hits.length) {
    toggleSelect(hits[0].id);
    return;
  }
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
  extraSel.clear();
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
/**
 * 落在已开动画字段上的改动（检视器输入 / 视口拖拽的中间态）。引擎每帧按曲线重写这些字段，
 * 改动只能在提交时变成「当前帧的关键帧」，不能直接写静态值。
 */
const pendingKeys = new Map<string, Partial<Record<AnimField, number[]>>>();
/** 本文档累计的热改（按层合并）：重挂后原样重放，保证「重挂 ≡ 热改」 */
const liveEdits = new Map<string, Patch>();
let dirty = false;

function resetHistory() {
  edits.clear();
  liveEdits.clear();
  pendingKeys.clear();
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
  let plain = patch;
  if (node) {
    const split = splitAnimated(node.obj, patch);
    plain = split.plain;
    if (Object.keys(split.keyed).length) pendingKeys.set(String(id), { ...pendingKeys.get(String(id)), ...split.keyed });
    writeObjProps(node.obj, plain);
    if (patch.visible !== undefined) node.visible = patch.visible;
  }
  mergeLiveEdit(liveEdits, id, plain);
  markDirty();
  return editor ? editor.setLayerProps(Number(id), patch).catch((e) => log(String(e?.message ?? e), "warn")) : Promise.resolve();
}

function markDirty() {
  scheduleDraft();
  if (dirty) return;
  dirty = true;
  syncDocTitle();
}

/** 几层一起改：带关键帧的层各自落关键帧，其余合成一步撤销 */
function commitMany(label: string, cmds: PropsCmd[]) {
  if (cmds.length <= 1) {
    if (cmds[0]) commit(cmds[0]);
    return;
  }
  const plain = cmds.filter((c) => !pendingKeys.has(String(c.id)));
  for (const c of cmds) if (!plain.includes(c)) commit(c);
  const cmd = batchCommand(label, plain);
  if (!cmd) return;
  edits.push(cmd);
  syncHistoryButtons();
  log(label);
}

function commit(cmd: PropsCmd) {
  const keyed = pendingKeys.get(String(cmd.id));
  pendingKeys.delete(String(cmd.id));
  const node = doc ? findNode(doc.roots, cmd.id) : null;
  if (keyed && node) {
    keyEdit(node, keyed);
    const plainKeys = Object.keys(splitAnimated(node.obj, cmd.after).plain) as Array<keyof EditorLayerProps>;
    cmd = { ...cmd, before: pickProps(cmd.before as EditorLayerProps, plainKeys), after: pickProps(cmd.after as EditorLayerProps, plainKeys) };
    if (!plainKeys.length) return;
  }
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
  extraSel.clear();
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
  if (extraSel.size && doc) {
    const ids = topLevelIds(doc, selectionNodes().map((x) => x.id));
    structEdit(et("log.multiDeleted", { n: ids.length }), (d) => (ids.every((id) => removeLayer(d, id)) ? null : undefined));
    return;
  }
  const parent = n.obj.parent;
  structEdit(et("log.deleted", { name: nodeName(n.id) }), (d) =>
    removeLayer(d, n.id) ? ((parent as number | string | undefined) ?? null) : undefined,
  );
}

function duplicateSelected() {
  const n = selectedNode();
  if (!n) return;
  if (extraSel.size && doc) {
    const ids = topLevelIds(doc, selectionNodes().map((x) => x.id));
    structEdit(et("log.multiDuplicated", { n: ids.length }), (d) => {
      const made = ids.map((id) => duplicateLayer(d, id, et("layer.copySuffix")));
      return made.every((m) => m !== null) ? made[0]! : undefined;
    });
    return;
  }
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
  if (isBatch(cmd)) {
    for (const c of cmd.cmds) void applyPatch(c.id, dir === "undo" ? c.before : c.after);
    renderTree();
    renderInspector();
    log(et(dir === "undo" ? "log.undo" : "log.redo", { name: cmd.label }));
    return;
  }
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
  pendingKeys.delete(String(cmd.id));
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
  if (extraSel.size) drawExtraOutlines();
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
  if (snapGuides) {
    overlayCtx.strokeStyle = SNAP_COLOR;
    overlayCtx.lineWidth = 1;
    overlayCtx.beginPath();
    for (const x of snapGuides.gx) {
      overlayCtx.moveTo(x, -1e4);
      overlayCtx.lineTo(x, 1e4);
    }
    for (const y of snapGuides.gy) {
      overlayCtx.moveTo(-1e4, y);
      overlayCtx.lineTo(1e4, y);
    }
    overlayCtx.stroke();
    overlayCtx.lineWidth = 1.5;
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

function drawExtraOutlines() {
  const canvas = stageEl.querySelector<HTMLCanvasElement>("canvas:not(#ed-overlay)");
  if (!editor || !canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const sr = stageEl.getBoundingClientRect();
  const cr = canvas.getBoundingClientRect();
  overlayCtx.setTransform(dpr, 0, 0, dpr, (cr.left - sr.left) * dpr, (cr.top - sr.top) * dpr);
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#0078d4";
  for (const id of extraSel) {
    const c = editor.getLayerOutline(Number(id))?.corners;
    if (!c) continue;
    overlayCtx.beginPath();
    c.forEach(([x, y], i) => (i ? overlayCtx.lineTo(x, y) : overlayCtx.moveTo(x, y)));
    overlayCtx.closePath();
    overlayCtx.setLineDash([6, 3]);
    overlayCtx.strokeStyle = accent;
    overlayCtx.lineWidth = 1.5;
    overlayCtx.stroke();
    overlayCtx.setLineDash([]);
  }
  overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
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
  /** 移动吸附：起拖时选中层的包围盒与候选线（画面边缘 / 中线、其他可见层的边缘 / 中心） */
  box: Box | null;
  snap: SnapTargets | null;
  /** 多选移动时跟着走的其余层（已去掉被祖先覆盖的、锁定的） */
  others: Array<{ id: number | string; props0: EditorLayerProps }>;
} | null = null;
let suppressClick = false;
let snapGuides: { gx: number[]; gy: number[] } | null = null;
const SNAP_COLOR = "#ff3d9a";

function snapSetup(
  ids: ReadonlyArray<number | string>,
  corners: ReadonlyArray<readonly number[]> | null,
): { box: Box | null; snap: SnapTargets | null } {
  const own = ids.map((id) => editor?.getLayerOutline(Number(id))?.corners).map((c) => (c ? boxOf(c) : null));
  const box = corners && own.every(Boolean) ? unionBox(own as Box[]) : null;
  const canvas = stageEl.querySelector<HTMLCanvasElement>("canvas:not(#ed-overlay)");
  const res = sceneResolution(doc?.scene ?? null);
  if (!editor || !box || !canvas || !res) return { box: null, snap: null };
  const layers = editor.getLayers();
  const byId = new Map(layers.map((l) => [l.id, l]));
  const insideSelf = (l: (typeof layers)[number]) => {
    for (let cur: (typeof layers)[number] | undefined = l, n = 0; cur && n < 64; cur = byId.get(cur.parentId ?? NaN), n++) {
      if (ids.some((id) => String(cur!.id) === String(id))) return true;
    }
    return false;
  };
  const others: Box[] = [];
  for (const l of layers) {
    if (!l.visible || insideSelf(l)) continue;
    const c = editor.getLayerOutline(l.id)?.corners;
    const b = c ? boxOf(c) : null;
    if (b) others.push(b);
  }
  const r = canvas.getBoundingClientRect();
  return { box, snap: snapTargets(sceneFrame(fitEl.value, r.width, r.height, res.w, res.h), others) };
}

const DRAG_FIELD: Record<DragMode, keyof EditorLayerProps> = { move: "origin", scale: "scale", rotate: "angles" };

function canvasPoint(e: PointerEvent | MouseEvent): { x: number; y: number } | null {
  const canvas = stageEl.querySelector<HTMLCanvasElement>("canvas:not(#ed-overlay)");
  if (!canvas) return null;
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function overSelected(x: number, y: number): boolean {
  if (!editor || selectedId === null) return false;
  return editor.hitTestAt(x, y, { includeHidden: true }).some((h) => isSelected(h.id));
}

stageEl.addEventListener("pointerdown", (e) => {
  if (!editor || selectedId === null || isLocked(selectedId) || e.button !== 0 || e.altKey) return;
  const p = canvasPoint(e);
  if (!p) return;
  const handle = handleAt(gizmo, p.x, p.y);
  if (!handle && !overSelected(p.x, p.y)) return;
  const props = editor.getLayerProps(Number(selectedId));
  if (!props) return;
  const dragOthers: Array<{ id: number | string; props0: EditorLayerProps }> = [];
  if (!handle && doc && extraSel.size) {
    for (const id of topLevelIds(doc, selectionNodes().map((n) => n.id))) {
      if (String(id) === String(selectedId) || isLocked(id)) continue;
      const p0 = editor.getLayerProps(Number(id));
      if (p0) dragOthers.push({ id, props0: structuredClone(p0) });
    }
  }
  const dragIds = [selectedId, ...dragOthers.map((o) => o.id)];
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
    ...(handle ? { box: null, snap: null } : snapSetup(dragIds, gizmo?.corners ?? null)),
    others: handle ? [] : dragOthers,
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
    let mx = dx;
    let my = dy;
    snapGuides = null;
    if (drag.box && drag.snap && !(e.metaKey || e.ctrlKey)) {
      const r = snapMove(drag.box, dx, dy, drag.snap);
      mx = r.dx;
      my = r.dy;
      if (r.gx.length || r.gy.length) snapGuides = { gx: r.gx, gy: r.gy };
    }
    const d = editor.screenDeltaToLocal(Number(drag.id), mx, my);
    if (!d) return;
    void applyPatch(drag.id, { origin: [p0.origin[0] + d[0], p0.origin[1] + d[1], p0.origin[2]] });
    for (const o of drag.others) {
      const od = editor.screenDeltaToLocal(Number(o.id), mx, my);
      if (od) void applyPatch(o.id, { origin: [o.props0.origin[0] + od[0], o.props0.origin[1] + od[1], o.props0.origin[2]] });
    }
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
  snapGuides = null;
  if (!d.moved || !editor) return;
  suppressClick = true;
  const key = DRAG_FIELD[d.mode];
  const cmds: PropsCmd[] = [];
  for (const o of [{ id: d.id, props0: d.props0 }, ...d.others]) {
    const after = editor.getLayerProps(Number(o.id));
    if (after) cmds.push({ id: o.id, name: nodeName(o.id), before: pickProps(o.props0, [key]), after: pickProps(after, [key]) });
  }
  commitMany(et("log.multiMoved", { n: cmds.length }), cmds);
  renderInspector();
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
    else if (files.every((f) => isAudioFile(f.file))) void addSoundFiles(files.map((f) => f.file));
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
      extraSel.clear();
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
const lyAddTextEl = $<HTMLButtonElement>("#ly-add-text");
const textMenuEl = $<HTMLElement>("#text-menu");
const lyAddParticleEl = $<HTMLButtonElement>("#ly-add-particle");
const particleMenuEl = $<HTMLElement>("#particle-menu");
function presetMenu(btn: HTMLButtonElement, menu: HTMLElement, pick: (preset: string) => void) {
  btn.onclick = (e) => {
    e.stopPropagation();
    for (const m of [textMenuEl, particleMenuEl]) if (m !== menu) m.hidden = true;
    if (!menu.hidden) {
      menu.hidden = true;
      return;
    }
    const r = btn.getBoundingClientRect();
    menu.style.left = `${r.left}px`;
    menu.style.top = `${r.bottom + 2}px`;
    menu.hidden = false;
  };
  document.addEventListener("click", (e) => {
    if (!menu.hidden && !menu.contains(e.target as Node)) menu.hidden = true;
  });
  for (const b of menu.querySelectorAll<HTMLButtonElement>("button[data-preset]")) {
    b.onclick = () => {
      menu.hidden = true;
      pick(b.dataset.preset!);
    };
  }
}
presetMenu(lyAddTextEl, textMenuEl, (p) => addText(p as TextPreset));
presetMenu(lyAddParticleEl, particleMenuEl, (p) => addParticle(p as ParticlePreset));
const lyAddSoundEl = $<HTMLButtonElement>("#ly-add-sound");
lyAddSoundEl.onclick = () => {
  soundPickFor = null;
  inSoundEl.click();
};
lyUpEl.onclick = () => moveSelected(-1);
lyDownEl.onclick = () => moveSelected(1);
lyDupEl.onclick = () => duplicateSelected();
lyDelEl.onclick = () => deleteSelected();
const lyGroupEl = $<HTMLButtonElement>("#ly-group");
lyGroupEl.onclick = () => groupSelected();

// ---------- 图层树拖拽：落在行上 1/3 = 之前、下 1/3 = 之后、中间 = 放进去 ----------

let treeDragged = false;
const DROP_CLASSES = ["drop-before", "drop-after", "drop-inside"];

function startTreeDrag(e: PointerEvent, n: LayerNode, row: HTMLElement) {
  if (e.button !== 0 || (e.target as HTMLElement).closest("button, .ed-twisty")) return;
  const x0 = e.clientX;
  const y0 = e.clientY;
  let active = false;
  let drop: { id: string; where: PlaceWhere } | null = null;
  const clear = () => treeEl.querySelectorAll(".ed-node").forEach((el) => el.classList.remove(...DROP_CLASSES));
  const move = (ev: PointerEvent) => {
    if (!active) {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < DRAG_THRESHOLD) return;
      active = true;
      row.classList.add("is-dragging");
    }
    clear();
    drop = null;
    const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>("#ed-tree .ed-node");
    if (!el || el === row || !el.dataset.id) return;
    const r = el.getBoundingClientRect();
    const f = (ev.clientY - r.top) / r.height;
    const where: PlaceWhere = f < 0.3 ? "before" : f > 0.7 ? "after" : "inside";
    drop = { id: el.dataset.id, where };
    el.classList.add(`drop-${where}`);
  };
  const end = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
    row.classList.remove("is-dragging");
    clear();
    if (!active) return;
    treeDragged = true;
    setTimeout(() => (treeDragged = false));
    if (drop) dropLayer(n, drop.id, drop.where);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
}

const PLACE_BAD: Record<Exclude<PlaceResult, "ok" | "noop">, string> = {
  cycle: "log.placeCycle",
  animated: "log.placeAnimated",
  degenerate: "log.placeDegenerate",
  missing: "log.placeMissing",
};

function dropLayer(n: LayerNode, targetId: string, where: PlaceWhere) {
  const target = doc ? findPath(doc.roots, targetId)?.at(-1) : null;
  if (!target) return;
  let res = "noop" as PlaceResult;
  const label = et(where === "inside" ? "log.placedInside" : "log.placed", { name: nodeName(n.id), target: nodeName(target.id) });
  if (where === "inside") collapsed.delete(target.id);
  structEdit(label, (d) => ((res = placeLayer(d, n.id, target.id, where)) === "ok" ? n.id : undefined));
  if (res !== "ok" && res !== "noop") log(et(PLACE_BAD[res], { name: nodeName(n.id) }), "warn");
}

function groupSelected() {
  const n = selectedNode();
  if (!n) return;
  if (extraSel.size && doc) {
    const ids = selectionNodes().map((x) => x.id);
    let bad: { reason: PlaceResult; at?: number | string } | null = null;
    structEdit(et("log.multiGrouped", { n: topLevelIds(doc, ids).length }), (d) => {
      const r = groupLayers(d, ids, et("layer.groupName"));
      if (r.ok) return r.id;
      bad = r;
      return undefined;
    });
    const b = bad as { reason: PlaceResult; at?: number | string } | null;
    if (b && b.reason !== "ok" && b.reason !== "noop") log(et(PLACE_BAD[b.reason], { name: nodeName(b.at ?? n.id) }), "warn");
    return;
  }
  structEdit(et("log.grouped", { name: nodeName(n.id) }), (d) => groupLayer(d, n.id, et("layer.groupName")) ?? undefined);
}

function syncLayerTools() {
  const off = !selectedNode() || !current?.assets || doc?.type !== "scene";
  for (const b of [lyUpEl, lyDownEl, lyGroupEl, lyDupEl, lyDelEl]) b.disabled = off;
  lyAddEl.disabled = !overlay || doc?.type !== "scene";
  lyAddTextEl.disabled = lyAddEl.disabled;
  lyAddParticleEl.disabled = lyAddEl.disabled;
  lyAddSoundEl.disabled = lyAddEl.disabled;
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
  else if (extraSel.has(String(n.id))) row.classList.add("selected", "extra-selected");
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
      setLocked(n.obj, !isLocked(n.id));
      markDirty();
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
  row.dataset.id = String(n.id);
  if (editor && current?.assets && !isLocked(n.id)) row.addEventListener("pointerdown", (e) => startTreeDrag(e, n, row));
  row.onclick = (e) => {
    if (treeDragged) return;
    if (e.shiftKey || e.metaKey || e.ctrlKey) return toggleSelect(n.id);
    selectedId = n.id;
    extraSel.clear();
    renderTree();
    renderInspector();
  };
  return row;
}

// ---------- 多选：对齐 / 等距分布 ----------

const ALIGN_ICON: Record<AlignMode, string> = {
  left: "M2.5 2v12 M4.5 4.5h8v2.5h-8z M4.5 9h5v2.5h-5z",
  hcenter: "M8 2v12 M4 4.5h8v2.5H4z M5.5 9h5v2.5h-5z",
  right: "M13.5 2v12 M3.5 4.5h8v2.5h-8z M6.5 9h5v2.5h-5z",
  top: "M2 2.5h12 M4.5 4.5v8h2.5v-8z M9 4.5v5h2.5v-5z",
  vmiddle: "M2 8h12 M4.5 4v8h2.5V4z M9 5.5v5h2.5v-5z",
  bottom: "M2 13.5h12 M4.5 3.5v8h2.5v-8z M9 6.5v5h2.5v-5z",
  hdist: "M2 2v12 M14 2v12 M6.5 5h3v6h-3z",
  vdist: "M2 2h12 M2 14h12 M5 6.5h6v3H5z",
};

function multiGroup(): HTMLElement {
  const group = document.createElement("div");
  group.className = "ed-insp-group ed-multi";
  const h = document.createElement("div");
  h.className = "ed-insp-title";
  const nodes = selectionNodes();
  h.textContent = et("multi.title", { n: nodes.length });
  group.appendChild(h);
  const bar = document.createElement("div");
  bar.className = "ed-align-bar";
  const movable = doc ? topLevelIds(doc, nodes.map((n) => n.id)).filter((id) => !isLocked(id)) : [];
  for (const mode of ALIGN_MODES) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ed-icon";
    b.dataset.align = mode;
    b.title = et(`align.${mode}`);
    b.innerHTML = `<svg class="i i-sm" viewBox="0 0 16 16"><path d="${ALIGN_ICON[mode]}" /></svg>`;
    b.disabled = !editor || movable.length < (mode.endsWith("dist") ? 3 : 2);
    b.onclick = () => alignSelection(mode);
    bar.appendChild(b);
  }
  group.appendChild(bar);
  group.appendChild(note(et("multi.hint")));
  return group;
}

function alignSelection(mode: AlignMode) {
  if (!editor || !doc) return;
  const items: Array<{ id: number | string; box: Box; props0: EditorLayerProps }> = [];
  for (const id of topLevelIds(doc, selectionNodes().map((n) => n.id))) {
    if (isLocked(id)) continue;
    const c = editor.getLayerOutline(Number(id))?.corners;
    const box = c ? boxOf(c) : null;
    const props0 = editor.getLayerProps(Number(id));
    if (box && props0) items.push({ id, box, props0: structuredClone(props0) });
  }
  const deltas = alignDeltas(items.map((i) => i.box), mode);
  const cmds: PropsCmd[] = [];
  items.forEach((it, i) => {
    const [dx, dy] = deltas[i];
    if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return;
    const d = editor!.screenDeltaToLocal(Number(it.id), dx, dy);
    if (!d) return;
    const origin: [number, number, number] = [it.props0.origin[0] + d[0], it.props0.origin[1] + d[1], it.props0.origin[2]];
    void applyPatch(it.id, { origin });
    cmds.push({ id: it.id, name: nodeName(it.id), before: { origin: it.props0.origin }, after: { origin } });
  });
  commitMany(et("log.aligned", { mode: et(`align.${mode}`), n: items.length }), cmds);
  renderInspector();
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

/** 同 objEdit，返回是否改成（校验不过时调用方要把控件复原） */
function objEditOk(label: string, id: number | string, mutate: (o: LayerNode["obj"]) => boolean): boolean {
  let ok = false;
  objEdit(label, id, (o) => (ok = mutate(o)));
  return ok;
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

// ---------- 文字层：新建（普通 / 时钟 / 日期）、内容 / 字体 / 字号 / 对齐 / 背景，全走结构编辑 ----------

/** 页面量字用的 FontFace（与引擎各自注册，族名互不相干）；键 = 路径 + 字节指纹 */
const pageFonts = new Map<string, Promise<string | null>>();
/** 工程字体路径 → 已就绪的族名（量字同步读） */
const pageFontFamily = new Map<string, string>();
const measureCtx = document.createElement("canvas").getContext("2d")!;

function bytesKey(b: Uint8Array): string {
  let h = 0x811c9dc5;
  const step = Math.max(1, b.length >> 10);
  for (let i = 0; i < b.length; i += step) h = Math.imul(h ^ b[i], 0x01000193);
  return `${b.length}:${(h >>> 0).toString(36)}`;
}

/** 工程字体装进页面（量盒用）；读不到 / 坏字体时量字回落 sans-serif */
async function ensurePageFont(path: string): Promise<void> {
  if (!path || isSystemFont(path) || !overlay) return;
  const bytes = await overlay.read(path).catch(() => null);
  if (!bytes) return;
  const key = `${path}|${bytesKey(bytes)}`;
  let p = pageFonts.get(key);
  if (!p) {
    p = (async () => {
      const fam = `wwgl-ed-font-${pageFonts.size}`;
      try {
        const ff = new FontFace(fam, bytes.slice().buffer);
        await ff.load();
        document.fonts.add(ff);
        return fam;
      } catch (e) {
        log(et("log.fontFailed", { name: path, msg: (e as Error).message }), "warn");
        return null;
      }
    })();
    pageFonts.set(key, p);
  }
  const fam = await p;
  if (fam) pageFontFamily.set(path, fam);
  else pageFontFamily.delete(path);
}

function measureText(text: string, font: string, px: number): number {
  const sys = SYSTEM_FONT_FAMILIES[font.toLowerCase()];
  const fam = sys ?? (pageFontFamily.has(font) ? `"${pageFontFamily.get(font)}"` : "");
  measureCtx.font = `${px}px ${fam ? `${fam}, ` : ""}sans-serif`;
  return measureCtx.measureText(text).width;
}

function addText(preset: TextPreset) {
  if (!doc?.scene || !overlay || doc.type !== "scene") {
    log(et("log.structUnavailable"), "warn");
    return;
  }
  const name = et(`text.${preset}`);
  structEdit(et("log.textAdded", { name }), (d) => addTextLayer(d, preset, name, et("text.defaultValue"), measureText) ?? undefined);
}

/** 文字字段的一次可撤销编辑：先装好要量的字体，改完按内容回填盒子 */
async function textEdit(node: LayerNode, field: string, fonts: string[], mutate: (o: LayerNode["obj"]) => boolean) {
  const target = doc;
  await Promise.all(fonts.map(ensurePageFont));
  if (doc !== target) return;
  objEdit(et("log.textEdited", { layer: nodeName(node.id), field: et(field) }), node.id, (o) => {
    if (!mutate(o)) return false;
    refitTextBox(o, measureText);
    return true;
  });
}

/** 字体下拉里列出的工程字体：文档引用的 + 来源 / 叠加层里的 fonts/*.ttf|otf */
function projectFonts(cur: string): string[] {
  const out = new Set(referencedFonts(doc));
  for (const n of overlay?.list() ?? []) if (FONT_FILE_RE.test(n)) out.add(n);
  for (const f of overlay?.added() ?? []) if (FONT_FILE_RE.test(f.name)) out.add(f.name);
  if (cur && !isSystemFont(cur)) out.add(cur);
  return [...out].sort();
}

const inFontEl = $<HTMLInputElement>("#in-font");
let fontPickFor: number | string | null = null;
inFontEl.onchange = async () => {
  const file = inFontEl.files?.[0];
  inFontEl.value = "";
  const id = fontPickFor;
  fontPickFor = null;
  const node = doc && id !== null ? findNode(doc.roots, id) : null;
  if (!file || !node || !overlay || !isFontFile(file)) return;
  const listed = new Set(overlay.list());
  const path = fontPathOf(file.name, (p) => overlay!.has(p) || listed.has(p));
  if (!path) return;
  overlay.put(path, new Uint8Array(await file.arrayBuffer()), path);
  log(et("log.fontImported", { path }));
  await textEdit(node, "tx.font", [path], (o) => setTextField(o, "font", path));
};

function textGroup(node: LayerNode): HTMLElement {
  const group = document.createElement("div");
  group.className = "ed-insp-group ed-text";
  const h = document.createElement("div");
  h.className = "ed-insp-title";
  h.textContent = et("insp.text");
  group.appendChild(h);
  const editable = !!doc?.scene && !!overlay && !isLocked(node.id);
  const o = node.obj;
  const f = getTextFields(o);
  const scripted = isScriptedText(o);
  const form = document.createElement("div");
  form.className = "ed-fx-params";
  const row = (key: string, el: HTMLElement) => {
    const l = document.createElement("label");
    l.textContent = et(key);
    el.dataset.text = key.slice(3);
    if ("disabled" in el) (el as HTMLInputElement).disabled = !editable;
    form.append(l, el);
  };
  const setField = <K extends TextField>(field: K, key: string, v: TextFields[K], fonts: string[] = [f.font]) =>
    void textEdit(node, key, fonts, (ob) => setTextField(ob, field, v));

  const content = document.createElement("textarea");
  content.className = "ed-text-content";
  content.value = textValue(o);
  content.rows = Math.min(8, Math.max(2, content.value.split("\n").length));
  content.readOnly = scripted;
  content.addEventListener("change", () => void textEdit(node, "tx.content", [f.font], (ob) => setTextValue(ob, content.value)));
  row("tx.content", content);

  const font = document.createElement("select");
  const optGroup = (label: string, fonts: readonly string[]) => {
    const g = document.createElement("optgroup");
    g.label = label;
    for (const v of fonts) {
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = fontLabel(v);
      opt.title = v;
      g.appendChild(opt);
    }
    font.appendChild(g);
  };
  optGroup(et("tx.fontsSystem"), SYSTEM_FONTS.includes(f.font) || !isSystemFont(f.font) ? SYSTEM_FONTS : [...SYSTEM_FONTS, f.font]);
  const proj = projectFonts(f.font);
  if (proj.length) optGroup(et("tx.fontsProject"), proj);
  const imp = document.createElement("option");
  imp.value = "";
  imp.textContent = et("tx.importFont");
  font.appendChild(imp);
  font.value = f.font;
  font.addEventListener("change", () => {
    if (!font.value) {
      font.value = f.font;
      fontPickFor = node.id;
      inFontEl.click();
      return;
    }
    setField("font", "tx.font", font.value, [font.value]);
  });
  row("tx.font", font);

  const size = document.createElement("input");
  size.type = "number";
  size.min = "1";
  size.max = "1000";
  size.step = "1";
  size.value = fmtNum(f.pointsize);
  size.addEventListener("change", () => setField("pointsize", "tx.size", Number(size.value)));
  row("tx.size", size);

  const alignSel = (values: readonly string[], cur: string, field: "horizontalalign" | "verticalalign", key: string) => {
    const sel = document.createElement("select");
    for (const v of values) {
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = et(`tx.align.${v}`);
      sel.appendChild(opt);
    }
    sel.value = cur;
    sel.addEventListener("change", () => setField(field, key, sel.value));
    row(key, sel);
  };
  alignSel(H_ALIGNS, f.horizontalalign, "horizontalalign", "tx.halign");
  alignSel(V_ALIGNS, f.verticalalign, "verticalalign", "tx.valign");

  const pad = document.createElement("input");
  pad.type = "number";
  pad.min = "0";
  pad.step = "1";
  pad.value = fmtNum(f.padding);
  pad.addEventListener("change", () => setField("padding", "tx.padding", Number(pad.value)));
  row("tx.padding", pad);

  const bgBox = document.createElement("div");
  bgBox.className = "ed-fx-param";
  const bgOn = document.createElement("input");
  bgOn.type = "checkbox";
  bgOn.checked = f.opaquebackground;
  bgOn.disabled = !editable;
  bgOn.dataset.text = "bgOn";
  bgOn.addEventListener("change", () => setField("opaquebackground", "tx.bg", bgOn.checked));
  const bgColor = document.createElement("input");
  bgColor.type = "color";
  bgColor.value = toHex(f.backgroundcolor);
  bgColor.disabled = !editable;
  bgColor.dataset.text = "bgColor";
  bgColor.addEventListener("change", () => setField("backgroundcolor", "tx.bg", fromHex(bgColor.value)));
  bgBox.append(bgOn, bgColor);
  row("tx.bg", bgBox);

  group.appendChild(form);
  if (scripted) group.appendChild(note(et("tx.scripted")));
  else if (isBoundText(o)) {
    const u = (o.text as { user?: unknown }).user;
    const name = u && typeof u === "object" ? (u as { name?: unknown }).name : u;
    group.appendChild(note(et("tx.bound", { name: String(name ?? "") })));
  }
  return group;
}

// ---------- 粒子层（P4）：模板新建 + instanceoverride 调参 ----------

function addParticle(preset: ParticlePreset) {
  if (!doc?.scene || !overlay || doc.type !== "scene") {
    log(et("log.structUnavailable"), "warn");
    return;
  }
  const name = et(`pt.${preset}`);
  structEdit(et("log.particleAdded", { name }), (d) => {
    const refs = referencedParticles(d);
    const listed = new Set(overlay!.list());
    const slug = particleSlug(preset, (p) => overlay!.has(p) || refs.has(p) || listed.has(p));
    for (const f of particleLayerFiles(d, preset, slug)) overlay!.put(f.name, f.data, particlePathOf(slug));
    return addParticleLayer(d, preset, name, slug) ?? undefined;
  });
}

function particleGroup(node: LayerNode): HTMLElement {
  const group = document.createElement("div");
  group.className = "ed-insp-group ed-particle";
  const h = document.createElement("div");
  h.className = "ed-insp-title";
  h.textContent = et("insp.particle");
  group.appendChild(h);
  const editable = !!doc?.scene && !!overlay && !isLocked(node.id);
  const p = getParticleParams(node.obj);
  const form = document.createElement("div");
  form.className = "ed-fx-params";
  const edit = (key: string, mutate: (o: LayerNode["obj"]) => boolean) =>
    objEdit(et("log.particleEdited", { layer: nodeName(node.id), field: et(key) }), node.id, mutate);

  for (const k of PARTICLE_PARAMS) {
    const r = PARTICLE_RANGES[k];
    const l = document.createElement("label");
    l.textContent = et(`pt.${k}`);
    const box = document.createElement("div");
    box.className = "ed-fx-param";
    const inp = document.createElement("input");
    inp.type = "range";
    inp.min = String(r.min);
    inp.max = String(r.max);
    inp.step = String(r.step);
    inp.value = String(p[k]);
    inp.disabled = !editable;
    inp.dataset.particle = k;
    const val = document.createElement("span");
    val.className = "ed-val";
    val.textContent = fmtNum(p[k]);
    inp.addEventListener("input", () => (val.textContent = fmtNum(Number(inp.value))));
    inp.addEventListener("change", () => edit(`pt.${k}`, (o) => setParticleParam(o, k as ParticleParam, Number(inp.value))));
    box.append(inp, val);
    form.append(l, box);
  }

  const l = document.createElement("label");
  l.textContent = et("pt.color");
  const box = document.createElement("div");
  box.className = "ed-fx-param";
  const on = document.createElement("input");
  on.type = "checkbox";
  on.checked = !!p.color;
  on.disabled = !editable;
  on.dataset.particle = "colorOn";
  on.title = et("pt.colorOn");
  const color = document.createElement("input");
  color.type = "color";
  color.value = toHex(p.color ?? [1, 1, 1]);
  color.disabled = !editable || !p.color;
  color.dataset.particle = "color";
  on.addEventListener("change", () => edit("pt.color", (o) => setParticleColor(o, on.checked ? fromHex(color.value) : null)));
  color.addEventListener("change", () => edit("pt.color", (o) => setParticleColor(o, fromHex(color.value))));
  box.append(on, color);
  form.append(l, box);

  group.appendChild(form);
  group.appendChild(note(et("pt.hint")));
  return group;
}

// ---------- 声音层：导入音频成层 + 检视器（模式 / 音量 / 开始静音 / 试听） ----------

const inSoundEl = $<HTMLInputElement>("#in-sound");
/** 音频选择框的用途：null = 新建声音层，否则 = 给这一层换音频 */
let soundPickFor: number | string | null = null;
inSoundEl.onchange = () => {
  const files = Array.from(inSoundEl.files ?? []);
  inSoundEl.value = "";
  const id = soundPickFor;
  soundPickFor = null;
  if (!files.length) return;
  if (id === null) void addSoundFiles(files);
  else void replaceSound(id, files[0]);
};

/** 音频原字节写进叠加层（分组 = 自身路径），返回工程内路径 */
async function importSound(file: File): Promise<string | null> {
  if (!overlay || !isAudioFile(file)) return null;
  const listed = new Set(overlay.list());
  const refs = referencedSounds(doc);
  const path = soundPathOf(file.name, (p) => overlay!.has(p) || listed.has(p) || refs.has(p));
  if (!path) return null;
  overlay.put(path, new Uint8Array(await file.arrayBuffer()), path);
  return path;
}

async function addSoundFiles(files: File[]) {
  if (!doc?.scene || !overlay || doc.type !== "scene") {
    log(et("log.structUnavailable"), "warn");
    return;
  }
  const target = doc;
  const audio = files.filter(isAudioFile);
  const items: Array<{ name: string; path: string }> = [];
  for (const f of audio) {
    const path = await importSound(f);
    if (path) items.push({ name: layerNameOf(f.name), path });
  }
  if (!items.length || doc !== target) return;
  structEdit(et("log.soundAdded", { names: items.map((i) => i.name).join(", ") }), (d) => {
    let last: number | undefined;
    for (const it of items) last = addSoundLayer(d, it.name, it.path) ?? last;
    return last;
  });
}

async function replaceSound(id: number | string, file: File) {
  const target = doc;
  const path = await importSound(file);
  if (!path || doc !== target) return;
  objEdit(et("log.soundEdited", { layer: nodeName(id), field: et("snd.file") }), id, (o) => replaceSoundFile(o, path));
}

/** 试听：页面自己的 audio 元素（引擎在编辑器里恒静音挂载） */
let preview: { path: string; au: HTMLAudioElement; url: string } | null = null;
function stopPreview() {
  if (!preview) return;
  preview.au.pause();
  URL.revokeObjectURL(preview.url);
  preview = null;
}

async function togglePreview(path: string, volume: number, loop: boolean, btn: HTMLButtonElement) {
  const was = preview?.path;
  stopPreview();
  btn.dataset.playing = "0";
  btn.textContent = et("snd.preview");
  if (was === path || !current?.assets) return;
  const bytes = await current.assets.read(path);
  if (!bytes) {
    log(et("log.soundMissing", { path }), "warn");
    return;
  }
  const ext = path.split(".").pop()!.toLowerCase();
  const mime = ext === "mp3" ? "audio/mpeg" : ext === "ogg" ? "audio/ogg" : ext === "flac" ? "audio/flac" : "audio/wav";
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  const au = new Audio(url);
  au.volume = Math.max(0, Math.min(1, volume));
  au.loop = loop;
  const p = { path, au, url };
  preview = p;
  au.onended = () => {
    if (preview !== p) return;
    stopPreview();
    btn.dataset.playing = "0";
    btn.textContent = et("snd.preview");
  };
  try {
    await au.play();
    if (preview !== p) return;
    btn.dataset.playing = "1";
    btn.textContent = et("snd.stop");
  } catch (e) {
    if (preview === p) stopPreview();
    log(et("log.soundFailed", { path, msg: (e as Error).message }), "warn");
  }
}

function soundGroup(node: LayerNode): HTMLElement {
  const group = document.createElement("div");
  group.className = "ed-insp-group ed-sound";
  const h = document.createElement("div");
  h.className = "ed-insp-title";
  h.textContent = et("insp.sound");
  group.appendChild(h);
  const editable = !!doc?.scene && !!overlay && !isLocked(node.id);
  const f = getSoundFields(node.obj);
  const path = f.files[0] ?? "";
  const form = document.createElement("div");
  form.className = "ed-fx-params";
  const row = (key: string, el: HTMLElement) => {
    const l = document.createElement("label");
    l.textContent = et(key);
    form.append(l, el);
  };
  const setField = <K extends SoundField>(field: K, key: string, v: SoundFields[K]) =>
    objEdit(et("log.soundEdited", { layer: nodeName(node.id), field: et(key) }), node.id, (o) => setSoundField(o, field, v));

  const fileBox = document.createElement("div");
  fileBox.className = "ed-fx-param";
  const name = document.createElement("span");
  name.className = "ed-snd-file";
  name.textContent = path ? soundLabel(path) : "—";
  name.title = path;
  const play = document.createElement("button");
  play.type = "button";
  play.className = "ed-btn";
  play.dataset.sound = "preview";
  const playing = !!path && preview?.path === path;
  play.dataset.playing = playing ? "1" : "0";
  play.textContent = et(playing ? "snd.stop" : "snd.preview");
  play.disabled = !path;
  play.onclick = () => void togglePreview(path, f.volume, f.playbackmode === "loop", play);
  const swap = document.createElement("button");
  swap.type = "button";
  swap.className = "ed-btn";
  swap.dataset.sound = "replace";
  swap.textContent = et("snd.replace");
  swap.disabled = !editable;
  swap.onclick = () => {
    soundPickFor = node.id;
    inSoundEl.click();
  };
  fileBox.append(name, play, swap);
  row("snd.file", fileBox);

  const mode = document.createElement("select");
  mode.dataset.sound = "playbackmode";
  for (const m of PLAYBACK_MODES) {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = et(`snd.mode.${m}`);
    mode.appendChild(opt);
  }
  mode.value = f.playbackmode;
  mode.disabled = !editable;
  mode.addEventListener("change", () => setField("playbackmode", "snd.mode", mode.value as SoundFields["playbackmode"]));
  row("snd.mode", mode);

  const volBox = document.createElement("div");
  volBox.className = "ed-fx-param";
  const vol = document.createElement("input");
  vol.type = "range";
  vol.min = "0";
  vol.max = "1";
  vol.step = "0.01";
  vol.value = String(f.volume);
  vol.disabled = !editable;
  vol.dataset.sound = "volume";
  const volVal = document.createElement("span");
  volVal.className = "ed-val";
  volVal.textContent = fmtNum(f.volume);
  vol.addEventListener("input", () => {
    volVal.textContent = fmtNum(Number(vol.value));
    if (preview?.path === path) preview.au.volume = Number(vol.value);
  });
  vol.addEventListener("change", () => setField("volume", "snd.volume", Number(vol.value)));
  volBox.append(vol, volVal);
  row("snd.volume", volBox);

  const silent = document.createElement("input");
  silent.type = "checkbox";
  silent.checked = f.startsilent;
  silent.disabled = !editable;
  silent.dataset.sound = "startsilent";
  silent.addEventListener("change", () => setField("startsilent", "snd.startsilent", silent.checked));
  const silentBox = document.createElement("div");
  silentBox.className = "ed-fx-param";
  silentBox.appendChild(silent);
  row("snd.startsilent", silentBox);

  group.appendChild(form);
  const notes = [et("snd.hint")];
  if (f.playbackmode === "random") notes.push(et("snd.randomNote"));
  if (f.files.length > 1) notes.push(et("snd.multi", { n: f.files.length }));
  for (const n of notes) group.appendChild(note(n));
  return group;
}

// ---------- 关键帧动画：字段开 / 关动画、当前帧打关键帧、改动自动落关键帧、时长 / 模式 / 插值 ----------

const canAnimate = (n: LayerNode) => n.kind === "image" || n.kind === "text" || n.kind === "particle" || n.kind === "model";
const ANIM_LABEL: Record<AnimField, string> = { origin: "f.origin", scale: "f.scale", angles: "f.angles", alpha: "f.alpha", color: "f.color" };

/** 画面上的当前值（动画字段 = 曲线在当前时刻的值）；没有引擎时退回静态值 */
function liveValue(node: LayerNode, f: AnimField): number[] {
  const p = editor?.getLayerProps(Number(node.id));
  if (!p) return baseValue(node.obj, f);
  return f === "alpha" ? [p.alpha] : [...p[f]];
}

const nowTime = () => editor?.time ?? 0;

let keyClip: KeyClip | null = null;

/** 把改动写成各字段当前帧的关键帧（一次可撤销的结构编辑） */
function keyEdit(node: LayerNode, keyed: Partial<Record<AnimField, number[]>>) {
  const t = nowTime();
  const fields = Object.keys(keyed) as AnimField[];
  const v0 = getAnim(node.obj, fields[0]);
  const frame = v0 ? frameAt(v0, t) : 0;
  objEdit(
    et("log.keySet", { layer: nodeName(node.id), fields: fields.map((f) => et(ANIM_LABEL[f])).join(" / "), frame }),
    node.id,
    (o) => {
      let changed = false;
      for (const f of fields) {
        const v = getAnim(o, f);
        if (v && setKey(o, f, frameAt(v, t), keyed[f]!)) changed = true;
      }
      return changed;
    },
  );
}

/** 跳到关键帧：暂停后 seek，再刷新检视器（数值框要显示该时刻的值） */
async function seekToKey(t: number) {
  if (!editor) return;
  pauseForStepping();
  await seekLogged(editor.seek(t));
  renderInspector();
}

function animGroup(node: LayerNode): HTMLElement {
  const group = document.createElement("div");
  group.className = "ed-insp-group ed-anim";
  const h = document.createElement("div");
  h.className = "ed-insp-title";
  h.textContent = et("insp.anim");
  group.appendChild(h);
  const editable = !!doc?.scene && !!current?.assets && !isLocked(node.id) && !!editor;
  const t = nowTime();
  const layer = nodeName(node.id);
  const form = document.createElement("div");
  form.className = "ed-fx-params";
  for (const f of ANIM_FIELDS) {
    const view = getAnim(node.obj, f);
    const l = document.createElement("label");
    l.textContent = et(ANIM_LABEL[f]);
    const head = document.createElement("div");
    head.className = "ed-fx-param ed-anim-head";
    head.dataset.field = f;
    const on = document.createElement("input");
    on.type = "checkbox";
    on.checked = !!view;
    on.disabled = !editable;
    on.dataset.animOn = f;
    on.title = et("anim.on");
    on.addEventListener("change", () =>
      objEdit(et(on.checked ? "log.animOn" : "log.animOff", { layer, field: et(ANIM_LABEL[f]) }), node.id, (o) =>
        on.checked ? enableAnim(o, f, liveValue(node, f)) : disableAnim(o, f, liveValue(node, f)),
      ),
    );
    head.appendChild(on);
    form.append(l, head);
    if (!view) continue;
    const cur = frameAt(view, t);
    const key = document.createElement("button");
    key.type = "button";
    key.className = "ed-btn";
    key.dataset.animKey = f;
    key.textContent = et("anim.key");
    key.title = et("anim.keyTitle", { frame: cur });
    key.disabled = !editable;
    key.onclick = () => keyEdit(node, { [f]: liveValue(node, f) });
    const at = document.createElement("span");
    at.className = "ed-val";
    at.textContent = et("anim.at", { frame: cur, len: view.length });
    head.append(key, at);

    const keysBox = document.createElement("div");
    keysBox.className = "ed-anim-keys";
    keysBox.dataset.field = f;
    for (const k of view.keys) {
      const chip = document.createElement("span");
      chip.className = "ed-anim-key";
      if (k.frame === cur) chip.classList.add("is-current");
      const go = document.createElement("button");
      go.type = "button";
      go.dataset.frame = String(k.frame);
      go.textContent = `${(k.frame / view.fps).toFixed(2)}s`;
      go.title = `#${k.frame} · ${k.value.map((v) => (Number.isFinite(v) ? fmtNum(f === "angles" ? v / RAD : v) : "—")).join(" ")}`;
      go.onclick = () => void seekToKey(k.frame / view.fps);
      const del = document.createElement("button");
      del.type = "button";
      del.className = "ed-anim-del";
      del.dataset.keyDel = String(k.frame);
      del.textContent = "×";
      del.title = et("anim.del");
      del.disabled = !editable || view.keys.length < 2;
      del.onclick = () =>
        objEdit(et("log.keyDel", { layer, field: et(ANIM_LABEL[f]), frame: k.frame }), node.id, (o) => removeKey(o, f, k.frame));
      chip.append(go, del);
      keysBox.appendChild(chip);
    }
    const kl = document.createElement("label");
    kl.textContent = et("anim.keys");
    form.append(kl, keysBox);

    const optBox = document.createElement("div");
    optBox.className = "ed-fx-param ed-anim-opts";
    const mode = document.createElement("select");
    mode.dataset.animMode = f;
    for (const m of ANIM_MODES) {
      const opt = document.createElement("option");
      opt.value = m;
      opt.textContent = et(`anim.mode.${m}`);
      mode.appendChild(opt);
    }
    mode.value = view.mode;
    mode.disabled = !editable;
    mode.addEventListener("change", () =>
      objEdit(et("log.animEdited", { layer, field: et(ANIM_LABEL[f]) }), node.id, (o) => setAnimOption(o, f, "mode", mode.value as AnimMode)),
    );
    const len = document.createElement("input");
    len.type = "number";
    len.min = "0.1";
    len.step = "0.1";
    len.value = fmtNum(view.length / view.fps);
    len.title = et("anim.length");
    len.disabled = !editable;
    len.dataset.animLength = f;
    len.addEventListener("change", () => {
      const frames = Math.round(Number(len.value) * view.fps);
      if (frames === view.length) return;
      if (!objEditOk(et("log.animEdited", { layer, field: et(ANIM_LABEL[f]) }), node.id, (o) => setAnimOption(o, f, "length", frames))) {
        len.value = fmtNum(view.length / view.fps);
        log(et("log.animLengthBad", { min: fmtNum((view.keys.at(-1)?.frame ?? 0) / view.fps) }), "warn");
      }
    });
    const sec = document.createElement("span");
    sec.className = "ed-val";
    sec.textContent = "s";
    const smoothLabel = document.createElement("label");
    smoothLabel.className = "ed-anim-smooth";
    const smooth = document.createElement("input");
    smooth.type = "checkbox";
    smooth.checked = view.smooth;
    smooth.disabled = !editable;
    smooth.dataset.animSmooth = f;
    smooth.addEventListener("change", () =>
      objEdit(et("log.animEdited", { layer, field: et(ANIM_LABEL[f]) }), node.id, (o) => setSmooth(o, f, smooth.checked)),
    );
    smoothLabel.append(smooth, document.createTextNode(et("anim.smooth")));
    optBox.append(mode, len, sec, smoothLabel);
    const ol = document.createElement("label");
    ol.textContent = et("anim.play");
    form.append(ol, optBox);
    if (view.relative) {
      form.append(document.createElement("span"), note(et("anim.relative")));
    }
  }
  group.appendChild(form);
  group.appendChild(keyClipBar(node, editable, t));
  group.appendChild(note(et("anim.hint")));
  return group;
}

/** 关键帧复制 / 粘贴：复制当前时刻该层的关键帧，粘到任意可动画图层的当前时刻 */
function keyClipBar(node: LayerNode, editable: boolean, t: number): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "ed-anim-clip";
  const here = copyKeysAt(node.obj, t);
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "ed-btn";
  copy.dataset.animCopy = "";
  copy.textContent = et("anim.copy");
  copy.title = here ? et("anim.copyTitle", { time: fmtTime(t) }) : et("anim.copyNone");
  copy.disabled = !here;
  copy.onclick = () => {
    keyClip = copyKeysAt(node.obj, nowTime());
    if (!keyClip) return;
    log(et("log.keyCopied", { layer: nodeName(node.id), fields: (Object.keys(keyClip) as AnimField[]).map((f) => et(ANIM_LABEL[f])).join(" / ") }));
    renderInspector();
  };
  const paste = document.createElement("button");
  paste.type = "button";
  paste.className = "ed-btn";
  paste.dataset.animPaste = "";
  paste.textContent = et("anim.paste");
  paste.title = keyClip ? et("anim.pasteTitle", { time: fmtTime(t) }) : et("anim.pasteNone");
  paste.disabled = !editable || !keyClip;
  paste.onclick = () => {
    const clip = keyClip;
    if (!clip) return;
    const at = nowTime();
    if (!objEditOk(et("log.keyPasted", { layer: nodeName(node.id), time: fmtTime(at) }), node.id, (o) => pasteKeysAt(o, clip, at))) {
      log(et("log.keyPasteBad", { time: fmtTime(at) }), "warn");
    }
  };
  bar.append(copy, paste);
  return bar;
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
  renderKeyMarks();
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
  if (extraSel.size) inspectorEl.appendChild(multiGroup());
  inspectorEl.appendChild(editGroup(node));
  if (canAnimate(node)) inspectorEl.appendChild(animGroup(node));
  if (node.kind === "text") inspectorEl.appendChild(textGroup(node));
  if (node.kind === "particle") inspectorEl.appendChild(particleGroup(node));
  if (node.kind === "sound") inspectorEl.appendChild(soundGroup(node));
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
