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
  mediaSource,
  mount,
  type EditorControls,
  type EditorLayer,
  type EditorLayerProps,
  type Fit,
  type MdlBoneDelta,
  type MdlClipInit,
  type PropertyValue,
  type SceneInstance,
  CLIP_MODES,
  addMdlClip,
  applyBoneDelta,
  removeMdlClip,
  setMdlClipEvents,
  setMdlClipMeta,
} from "../renderer/src/api/editor";
import { getLang, onChangeLang, setLang, t, type Lang } from "../bench/i18n";
import { DOC_KINDS, renderDocs, type DocKind } from "../bench/docs";
import { applyPlatformClasses } from "../shared/workbench/platform";
import { initTabs } from "../shared/workbench/tabs";
import { libraryKindOf, mountLibraryPanel } from "./ui/library-panel";
import { mountWallpaperConfig } from "./ui/wallpaper-config";
import { mountRenderSettings } from "./ui/render-settings";
import { createElementAudioSource, type ElementAudioSource } from "./audio-live";
import { mountPerfPanel } from "./ui/perf-panel";
import { bindThemeButton } from "../shared/workbench/theme";
import { applyEditorStatic, et, hasText } from "./i18n";
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
import {
  addEffect,
  addEffectRef,
  clearPassCombo,
  combosOfMaterialJson,
  effectById,
  effectCatalog,
  effectDirNameOf,
  effectFileOf,
  effectFiles,
  effectNote,
  effectViews,
  encodeValue,
  externalValues,
  constantKeyOf,
  inlinePassViews,
  inspectEffectPasses,
  inspectEffectParams,
  mergedCombos,
  moveEffect,
  passCombos,
  referencedEffects,
  removeEffect,
  setEffectParam,
  setInlineParam,
  setEffectVisible,
  setPassCombo,
  type EffectDef,
  type EffectParam,
  type EffectPassSeed,
  type EffectValue,
  type EffectView,
  type InlinePassParams,
  type PassCombos,
} from "./effects";
import { bootEditor, type EditorApp } from "./app";
import { blobImporter } from "./plugins/external";
import { bundledSource, createPluginManager, dirSource, storeSource } from "./plugins/manager";
import { mountPluginPanel, permissionSummary } from "./ui/plugin-panel";
import { textOf } from "./core";
import { layerKindInfo } from "./layer-kinds";
import {
  BUILTIN_INSPECTOR_TABS,
  DEFAULT_INSPECTOR_TAB,
  INFO_INSPECTOR_TAB,
  groupsFor,
  inspectorGroups,
  inspectorTabs,
  puppetGenerators,
  puppetTools,
  tabOf,
  type InspectorGroup,
  type InspectorTab,
  type PuppetGenerator,
  type PuppetTool,
} from "./inspector";
import { createSettings } from "./services/settings";
import { exporterAccepts, exporters, runExportPipeline, type Exporter } from "./export-pipeline";
import { schemaForm } from "./ui/schema-form";
import type { DocService } from "./services/types";
import { addableTargets, removeScript, scriptSlots, scriptTemplate, setScript } from "./scripts";
import {
  GltfError,
  addModelLayer,
  bakePuppetAtlas,
  defaultTarget,
  editorMdlPathOf,
  fitMeshScale,
  fitPuppetScale,
  gltfImportFiles,
  gltfToModel,
  isOrthoDoc,
  type Gltf,
  type GltfTarget,
} from "./gltf";
import { isModelMain, loadModelFile, modelExts, modelImporters, modelSideExts, type LoadedModel } from "./model-import";
import { irToGltf, type ModelIR } from "./model-ir";
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
  particleTemplates,
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
import { allowRecover, isContextLost, RECOVER_MAX } from "./recover";
import {
  VIDEO_SLUG_PREFIX,
  isCanceled,
  isEditorVideoModel,
  isVideoFile,
  normalizeVideo,
  probeVideo,
  recordVideo,
  videoLayerFiles,
  videoMaterialPathOf,
  type VideoInput,
} from "./video";
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
import { scriptsAllowedByDefault, scriptsOverrideFrom, type ContentKind } from "./trust";
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
  rebuildTree,
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
  addAnimLayer,
  animLayersHot,
  attachmentOf,
  attachToModel,
  detachFromModel,
  type AttachOffsetOf,
  type AttachResult,
  getAnimLayers,
  editorMaterialOf,
  editorMdlOf,
  meshMaterialPath,
  meshRetexture,
  modelInfoRows,
  modelTextureSlots,
  parseJsonBytes,
  puppetRetexture,
  type RetextureResult,
  moveAnimLayer,
  removeAnimLayer,
  scanPuppets,
  setAnimLayerField,
  soloAnimLayers,
  type AnimLayerView,
  BONE_RADII,
  boneDepths,
  clipFrameAt,
  defaultClipId,
  dropAnimLayersOfClip,
  formatEventsText,
  isZeroDelta,
  mdlCopyFiles,
  nextClipName,
  parseEventsText,
  type BoneEdit,
} from "./model";
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
  isTitleCmd,
  isVideoCmd,
  type TitleSnap,
  type VideoClip,
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
  collectVideoProject,
  filesFromDirectory,
  pickDirectory,
  probeWritable,
  removeProjectFile,
  writeToDirectory,
  type DirHandle,
  type SaveFile,
} from "./save";
import {
  createVirtualProject,
  deleteVirtualProject,
  lastVirtualProjectId,
  listVirtualProjects,
  openVirtualProject,
  renameVirtualDir,
  setLastVirtualProjectId,
  virtualIdOf,
  type VdirRecord,
} from "./vdir";
import { mountVideoStage, videoProjectJson } from "./video-project";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

const docTitleEl = $<HTMLElement>("#ed-doc-title");
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
const stDocEl = $<HTMLElement>("#st-doc");
const stFormEl = $<HTMLElement>("#st-form");
const stLayersEl = $<HTMLElement>("#st-layers");
const stResEl = $<HTMLElement>("#st-res");
const stSaveEl = $<HTMLElement>("#st-save");
const stFpsEl = $<HTMLElement>("#st-fps");
// 恢复横幅（#ed-draft）：内置浏览器里刷新 / 重开后找回上次的虚拟工程
const draftBannerEl = $<HTMLElement>("#ed-draft");
const draftTextEl = $<HTMLElement>("#ed-draft-text");
const draftRestoreEl = $<HTMLButtonElement>("#draft-restore");
const draftDiscardEl = $<HTMLButtonElement>("#draft-discard");
// 内置工程列表
const vdirDlgEl = $<HTMLDialogElement>("#vdir-dlg");
const vdirListEl = $<HTMLElement>("#vdir-list");
const vdirNewEl = $<HTMLButtonElement>("#vdir-new");
const vdirLocalEl = $<HTMLButtonElement>("#vdir-local");
const vdirPkgEl = $<HTMLButtonElement>("#vdir-pkg");
const vdirCancelEl = $<HTMLButtonElement>("#vdir-cancel");

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
/** 视频壁纸工程的预览元素（场景文档时为 null） */
let videoEl: HTMLVideoElement | null = null;
/** 视频壁纸工程的入点 / 出点（页面状态，「应用裁剪」后清空） */
let trimIn: number | null = null;
let trimOut: number | null = null;
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
let origin: { kind: ContentKind } | null = null;

function destroyInstance() {
  if (!instance) return;
  try {
    instance.destroy({ releasePkgCache: true });
  } catch {
    /* 销毁失败不阻断换源 */
  }
  instance = null;
  editor = null;
  videoEl = null;
  drag = null;
  stageEl.textContent = "";
  syncTimeline();
}

/** keepTime：结构编辑后的重挂接着原时间点看，而不是从 0 秒重新开场 */
const recoverStamps: number[] = [];

/** 上下文丢失：按当前文档重挂（保持时刻与暂停）；短时间内反复丢就停手，留给用户手动「重新加载」 */
function onContextLost(gen: number) {
  if (gen !== openGen) return;
  if (!allowRecover(recoverStamps, Date.now())) {
    log(et("log.ctxLostGiveUp", { n: RECOVER_MAX }), "error");
    return;
  }
  log(et("log.ctxLostRecover"), "warn");
  void mountCurrent(true);
}

let mounting = false;
/** 动画层「单独预览」：只改了引擎、文档未动；重挂 / 换选中 / 任一提交都会结束 */
let animSolo: { id: number | string; index: number } | null = null;
/** 「挂到模型」分组里为某层选中的目标模型 / 附着点（视口标记据此高亮），换选中即失效 */
let attachPick: { layer: number | string; model: number | string; name: string } | null = null;
/**
 * 骨骼面板（W18）的当前选择与未提交的增量（r 用角度，提交时换弧度）。引擎里只有 setBonePose 预览，
 * 换层 / 重挂即失效（重挂后新模型没有预览）
 */
type BoneVec = [number, number, number];
let bonePick: {
  layer: number | string;
  clip: number;
  bone: number;
  frame: number | null;
  radius: number;
  t: BoneVec;
  r: BoneVec;
  s: BoneVec;
} | null = null;
/** 只有用户点了播放才走时钟；打开文档、重挂都停在当前帧 */
let userPlaying = false;

async function mountCurrent(keepTime = false) {
  if (!current) return;
  mounting = true;
  animSolo = null;
  const gen = ++openGen;
  if (bonePick) bonePick = { ...bonePick, t: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] };
  const resumeAt = keepTime ? editor?.time ?? 0 : 0;
  destroyInstance();
  syncPlayButton();
  try {
    if (doc?.video) {
      const vs = await mountVideoStage(stageEl, doc.video.bytes, fitEl.value as Fit);
      if (gen !== openGen) {
        vs.instance.destroy();
        return;
      }
      instance = vs.instance;
      editor = vs.editor;
      videoEl = vs.video;
      editor.setTimeScale(Number(tlSpeedEl.value));
      if (userPlaying) instance.resume();
      await editor.seek(Math.min(resumeAt, vs.video.duration || 0));
      resetTimelineRange();
      renderTree();
      renderInspector();
      log(et("log.videoReady", { w: vs.video.videoWidth, h: vs.video.videoHeight, dur: (vs.video.duration || 0).toFixed(2) }));
      return;
    }
    const source =
      docDriven && current.assets && doc?.scene
        ? sourceFromDoc(current.source, current.assets, JSON.stringify(doc.scene), doc.project)
        : current.source;
    const inst = await mount(stageEl, {
      source,
      fit: fitEl.value as Fit,
      renderDpr: Number(dprEl.value),
      ...renderSettings.mountOptions(),
      properties: libItem ? (wallpaperConfig.overrides() as Record<string, PropertyValue>) : undefined,
      scripts: scriptsAllowed,
      onDiagnostic: (msg, level) => log(msg, level),
      onError: (err) => {
        if (isContextLost(err)) onContextLost(gen);
      },
    });
    if (gen !== openGen) {
      inst.destroy({ releasePkgCache: true });
      return;
    }
    instance = inst;
    editor = editorOf(inst);
    if (!userPlaying) inst.pause();
    if (editor) {
      editor.setTimeScale(Number(tlSpeedEl.value));
      await replayLiveEdits();
      // 首帧时文字层的贴图还没上传（第二帧才画出来）；停着不动时要在同一时刻补画一帧
      if (resumeAt > 0 || !userPlaying) await editor.seek(resumeAt > 0 ? resumeAt : editor.time).catch(() => {});
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
  } finally {
    if (gen === openGen) {
      syncPlayButton();
      syncTimeline();
      renderStatus();
      mounting = false;
      if (saveTimer) scheduleAutosave();
    }
  }
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
    ...pluginReferenced(d),
  ]);
/** 插件登记的引用扫描（插件写进覆盖层的文件靠它进保存清单） */
const refScanners = new Set<(d: EditorDoc) => Iterable<string>>();
function addReferenceScanner(fn: (d: EditorDoc) => Iterable<string>) {
  refScanners.add(fn);
  return () => void refScanners.delete(fn);
}
function pluginReferenced(d: EditorDoc | null): string[] {
  if (!d) return [];
  const out: string[] = [];
  for (const fn of refScanners) {
    try {
      out.push(...fn(d));
    } catch (e) {
      console.warn("[wwgl] reference scanner failed", e);
    }
  }
  return out;
}

/** dev 宿主是否在（只用来决定外来脚本默认是否执行，不再用来打开壁纸库条目） */
let hostUp = false;
const hostProbe = (async () => {
  try {
    hostUp = !!(await fetchLibrary());
  } catch {
    hostUp = false;
  }
})();

type OpenOptions = {
  origin?: { kind: ContentKind } | null;
  /** 新建工程没有原始来源可挂，一开始就从文档挂载 */
  docDriven?: boolean;
  /** 文档就位、首次挂载之前执行（新建时放背景图、恢复草稿时套用快照） */
  after?: () => void;
  /** 壁纸库条目：不绑项目文件夹（首次保存时另存为项目），右栏「壁纸配置」跟随它 */
  library?: LibraryItem;
  /** 打开后直接播放（库条目即点即看）；缺省停在首帧便于编辑 */
  play?: boolean;
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
  await hostProbe;
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
  userPlaying = !!opts.play;
  if (opts.library) releaseProject();
  libItem = opts.library ?? null;
  syncLibraryItem();
  scriptsAllowed = scriptsAllowedByDefault(origin?.kind ?? "local", hostUp, SCRIPTS_OVERRIDE);
  scriptsBannerEl.hidden = true;
  resetHistory();
  opts.after?.();
  void detectPuppets();
  if (doc.type === "scene" && !doc.scene) log(et("log.noScene"), "warn");
  emptyEl.hidden = true;
  syncDocTitle();
  reloadEl.disabled = false;
  renderTree();
  renderInspector();
  renderStatus();
  await mountCurrent();
}

/** 认出 puppet 层（要读 model json，异步）；扫完标进图层树。换了文档就作废 */
async function detectPuppets() {
  const d = doc;
  const assets = current?.assets;
  if (!d?.scene || !assets) return;
  const found = await scanPuppets(d, (name) => assets.read(name));
  if (d !== doc || !found.size) return;
  d.puppets = found;
  rebuildTree(d);
  renderTree();
  renderInspector();
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
  userPlaying = instance.paused;
  if (userPlaying) instance.resume();
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
  if (doc?.video) {
    for (const [t, which] of [
      [trimIn, "in"],
      [trimOut, "out"],
    ] as const) {
      if (t === null) continue;
      const m = document.createElement("i");
      m.className = "tl-key tl-trim";
      m.dataset.trim = which;
      m.title = `${et(which === "in" ? "vp.in" : "vp.out")} ${fmtTime(t)}`;
      m.style.left = `${(Math.min(t, tlMax) / tlMax) * 100}%`;
      tlKeysEl.appendChild(m);
    }
    return;
  }
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
  const d = videoEl?.duration;
  setTimelineMax(videoEl && d && Number.isFinite(d) ? Math.round(d * 100) / 100 : TL_WINDOW);
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
  userPlaying = false;
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

// ---------- 录制为视频：逐帧 seek → 出图 → 编码（不丢帧，比实时慢） ----------

const recMenuEl = $<HTMLElement>("#rec-menu");
const recDurEl = $<HTMLInputElement>("#rec-duration");
const recFpsEl = $<HTMLSelectElement>("#rec-fps");
const recResEl = $<HTMLSelectElement>("#rec-res");
const recBarEl = $<HTMLProgressElement>("#rec-bar");
const recStartEl = $<HTMLButtonElement>("#rec-start");
let recording: AbortController | null = null;

/** 默认时长：最长那条动画的一个周期（没有动画时 10 秒），封顶 60 秒 */
function defaultRecordDuration(): number {
  let longest = 0;
  const walk = (nodes: LayerNode[]) => {
    for (const n of nodes) {
      const s = canAnimate(n) ? animSummary(n.obj) : null;
      if (s) longest = Math.max(longest, s.length);
      walk(n.children);
    }
  };
  if (doc) walk(doc.roots);
  return longest > 0 ? Math.min(60, Math.round(longest * 100) / 100) : 10;
}

function recordSize(): { w: number; h: number } {
  const res = (doc?.scene && sceneResolution(doc.scene)) || { w: 1920, h: 1080 };
  const long = Number(recResEl.value);
  if (!long) return res;
  const k = long / Math.max(res.w, res.h);
  return { w: Math.round(res.w * k), h: Math.round(res.h * k) };
}

function closeRecMenu() {
  if (recording) return;
  recMenuEl.hidden = true;
}

function openRecMenu() {
  if (!doc?.scene || !editor) return;
  recDurEl.value = String(defaultRecordDuration());
  recBarEl.hidden = true;
  recStartEl.disabled = false;
  const r = packEl.getBoundingClientRect();
  recMenuEl.style.left = `${r.left}px`;
  recMenuEl.style.top = `${r.bottom + 2}px`;
  recMenuEl.hidden = false;
}
document.addEventListener("click", (e) => {
  if (!recMenuEl.hidden && !recMenuEl.contains(e.target as Node)) closeRecMenu();
});
$<HTMLButtonElement>("#rec-cancel").onclick = () => {
  if (recording) recording.abort();
  else closeRecMenu();
};
recStartEl.onclick = () => void recordScene();

async function recordScene() {
  if (!doc?.scene || !editor || recording) return;
  const ed = editor;
  const title = doc.title;
  const duration = Math.min(600, Math.max(0.5, Number(recDurEl.value) || 10));
  const fps = Number(recFpsEl.value) || 30;
  const { w, h } = recordSize();
  pauseForStepping();
  const t0 = ed.time;
  const ctl = new AbortController();
  recording = ctl;
  recStartEl.disabled = true;
  recBarEl.hidden = false;
  recBarEl.value = 0;
  let lastPct = -1;
  try {
    const out = await recordVideo({
      width: w,
      height: h,
      fps,
      duration,
      signal: ctl.signal,
      frameAt: (t) => ed.captureFrame({ time: t, width: w, height: h, keepSize: true }),
      onProgress: (p) => {
        recBarEl.value = p;
        const pct = Math.floor(p * 10) * 10;
        if (pct === lastPct || pct >= 100) return;
        lastPct = pct;
        log(et("log.recording", { pct }));
      },
    });
    if (out.ext === "webm") log(et("log.recordWebm"), "warn");
    const url = URL.createObjectURL(out.blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title.replace(/[\\/:*?"<>|]+/g, "_")}.${out.ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    log(et("log.recorded", { frames: out.frames, mb: mb(out.blob.size), ext: out.ext }));
  } catch (e) {
    if (isCanceled(e) || ctl.signal.aborted) log(et("log.recordCanceled"), "warn");
    else log(et("log.recordFailed", { msg: (e as Error).message }), "error");
  } finally {
    recording = null;
    recMenuEl.hidden = true;
    if (editor === ed) await seekLogged(ed.seek(t0));
  }
}

// ---------- 项目文件夹：松散文件自动保存；导出才打 scene.pkg 或 zip ----------

const packEl = $<HTMLButtonElement>("#tb-pack");
const exportMenuEl = $<HTMLElement>("#export-menu");
const renderOptsEl = $<HTMLButtonElement>("#tb-render-opts");
const renderMenuEl = $<HTMLElement>("#render-menu");
let projectDir: DirHandle | null = null;
/** 当前文档来自壁纸库时的条目（不绑项目文件夹）；另存为项目后清空 */
let libItem: LibraryItem | null = null;
let saving = false;
let saveAgain = false;
let saveTimer = 0;
const AUTOSAVE_MS = 400;
/** 已写出内容的签名，没变的文件跳过 */
const writtenSig = new Map<string, string>();
/** 本次会话写出过的路径；不再引用时从项目文件夹删掉 */
const ownedPaths = new Set<string>();

function fileSig(data: Uint8Array): string {
  let h = 2166136261;
  for (let i = 0; i < data.length; i++) h = Math.imul(h ^ data[i], 16777619);
  return `${data.length}:${h >>> 0}`;
}

function adoptProject(dir: DirHandle) {
  projectDir = dir;
  // 内置浏览器工程记一笔：刷新 / 重开后靠它找回（真目录会置空，免得恢复横幅指向陈旧的虚拟工程）
  setLastVirtualProjectId(virtualIdOf(dir));
  writtenSig.clear();
  ownedPaths.clear();
  saveAgain = false;
  clearTimeout(saveTimer);
  saveTimer = 0;
}

/** 库条目不落盘：解绑上一个文档的项目文件夹，免得自动保存把它写进别的工程 */
function releaseProject() {
  projectDir = null;
  writtenSig.clear();
  ownedPaths.clear();
  saveAgain = false;
  clearTimeout(saveTimer);
  saveTimer = 0;
}

/** ⌘S：已有项目文件夹就写回；库条目等没绑文件夹的文档先选文件夹另存为项目 */
async function saveDocument() {
  if (projectDir) return flushAutosave();
  if (!doc) return;
  if (!canSave()) {
    log(et("log.cannotSaveKind", { kind: doc.type }), "warn");
    return;
  }
  const dir = await requireProjectDir();
  if (!dir || !doc) return;
  adoptProject(dir);
  libItem = null;
  syncLibraryItem();
  log(et("log.savedAsProject", { name: dir.name }));
  await flushAutosave();
}

/** 有东西可写：场景文档 + 资源表，或视频壁纸工程 */
const canSave = () => !!doc?.video || (!!doc?.scene && !!current?.assets);

/**
 * 把当前工程整份写进用户选的本机文件夹，之后的自动保存改到那里。
 * 工程卡上的「存到本机文件夹…」：浏览器存储里的工程这样就能拿到松散文件。
 */
async function saveProjectToLocalDir() {
  if (!doc || !projectDir) return;
  if (!canSave()) {
    log(et("log.cannotSaveKind", { kind: doc.type }), "warn");
    return;
  }
  const dir = await requireLocalDir();
  if (!dir) return;
  adoptProject(dir);
  libItem = null;
  syncLibraryItem();
  log(et("log.savedToDir", { name: dir.name }));
  await flushAutosave();
}

async function collectCurrent(preview: Blob | null): Promise<SaveFile[] | null> {
  if (doc?.video) return collectVideoProject(doc, preview);
  if (doc?.scene && current?.assets) return collectProject(doc, current.assets, preview);
  return null;
}

function syncExportButton() {
  packEl.disabled = !canSave();
  for (const e of exporters.list()) {
    const b = exportMenuEl.querySelector<HTMLButtonElement>(`#export-${e.id}`);
    if (b) b.disabled = !exporterAccepts(e, doc) || (e.enabled ? !e.enabled() : false);
  }
}

/** 导出菜单按 exporters 注册表重建：按钮 id = export-<id>，页面里已有的静态按钮原样复用 */
function renderExportMenu() {
  const keep = new Set<HTMLElement>();
  for (const e of exporters.list()) {
    let b = exportMenuEl.querySelector<HTMLButtonElement>(`#export-${e.id}`);
    if (!b) {
      b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "menuitem");
      b.id = `export-${e.id}`;
      if (typeof e.title === "string" && hasText(e.title)) b.dataset.et = e.title;
    }
    b.textContent = typeof e.title === "string" && hasText(e.title) ? et(e.title) : textOf(e.title, getLang(), e.id);
    exportMenuEl.appendChild(b);
    keep.add(b);
  }
  for (const b of exportMenuEl.querySelectorAll<HTMLButtonElement>("button")) if (!keep.has(b)) b.remove();
  syncExportButton();
}

exportMenuEl.addEventListener("click", (ev) => {
  const b = (ev.target as HTMLElement).closest<HTMLButtonElement>("button[id^='export-']");
  const e = b && exporters.get(b.id.slice("export-".length));
  if (!e || b.disabled) return;
  ev.stopPropagation();
  closeExportMenu();
  void runExport(e.id);
});

function renderSaveStatus() {
  if (!projectDir || !doc) {
    const hint = doc && libItem && canSave();
    stSaveEl.textContent = hint ? et(dirty ? "st.libDirty" : "st.library") : "";
    stSaveEl.title = hint ? et("st.saveAsTitle") : "";
    stSaveEl.classList.remove("is-clickable");
    return;
  }
  stSaveEl.textContent = saving ? et("st.saving") : dirty ? et("st.unsaved") : et("st.saved");
  // 浏览器存储里的工程：状态栏这一格点一下就能整份落到本机文件夹（和工程卡上那颗按钮同一条路）
  const toLocal = !!virtualIdOf(projectDir) && canPickDirectory();
  stSaveEl.title = virtualIdOf(projectDir)
    ? toLocal
      ? et("st.saveLocalTip", { name: projectDir.name })
      : et("vdir.saveHint", { name: projectDir.name })
    : projectDir.name;
  stSaveEl.classList.toggle("is-clickable", toLocal);
}

stSaveEl.addEventListener("click", () => {
  if (projectDir && virtualIdOf(projectDir) && canPickDirectory()) void saveProjectToLocalDir();
});

function closeExportMenu() {
  exportMenuEl.hidden = true;
}

packEl.onclick = (e) => {
  e.stopPropagation();
  if (!exportMenuEl.hidden) {
    closeExportMenu();
    return;
  }
  closeNewMenu();
  const r = packEl.getBoundingClientRect();
  exportMenuEl.style.left = `${r.left}px`;
  exportMenuEl.style.top = `${r.bottom + 2}px`;
  exportMenuEl.hidden = false;
};
document.addEventListener("click", (e) => {
  if (!exportMenuEl.hidden && !exportMenuEl.contains(e.target as Node)) closeExportMenu();
});

// 「渲染选项」菜单（在视口工具条渲染 DPR 之后）：内容就是原来右侧「渲染」标签的两组全局偏好
function closeRenderMenu() {
  renderMenuEl.hidden = true;
}

renderOptsEl.onclick = (e) => {
  e.stopPropagation();
  if (!renderMenuEl.hidden) {
    closeRenderMenu();
    return;
  }
  closeExportMenu();
  const r = renderOptsEl.getBoundingClientRect();
  renderMenuEl.style.left = `${r.left}px`;
  renderMenuEl.style.top = `${r.bottom + 2}px`;
  renderMenuEl.hidden = false;
  // 工具条在视口下方，往下放不下就翻到按钮上方；左侧越界也夹回窗口内
  const box = renderMenuEl.getBoundingClientRect();
  if (r.bottom + 2 + box.height > window.innerHeight - 6) {
    renderMenuEl.style.top = `${Math.max(6, r.top - box.height - 2)}px`;
  }
  if (r.left + box.width > window.innerWidth - 6) {
    renderMenuEl.style.left = `${Math.max(6, window.innerWidth - box.width - 6)}px`;
  }
};
document.addEventListener("click", (e) => {
  if (!renderMenuEl.hidden && !renderMenuEl.contains(e.target as Node)) closeRenderMenu();
});
async function capturePreview(): Promise<Blob | null> {
  if (!editor || !doc) return null;
  const res = sceneResolution(doc.scene);
  const w = 640;
  const h = doc.video ? undefined : res ? Math.max(1, Math.round((w * res.h) / res.w)) : 360;
  try {
    return await editor.capture({ width: w, height: h, type: "image/jpeg", quality: 0.85 });
  } catch (e) {
    log(et("log.previewFailed", { msg: (e as Error).message }), "warn");
    return null;
  }
}

function scheduleAutosave() {
  if (!projectDir || !canSave()) return;
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    if (mounting) {
      scheduleAutosave();
      return;
    }
    void flushAutosave();
  }, AUTOSAVE_MS);
}

/**
 * 内置工程改名后把浏览器存储里的记录名与句柄名一起对齐（真目录不动）。
 * 只在保存成功后调用：名字来源是 doc.title，autosave 已经把它写进 project.json。
 */
async function syncVirtualDirName(dir: DirHandle) {
  if (!virtualIdOf(dir) || !doc || dir.name === doc.title) return;
  try {
    await renameVirtualDir(dir, doc.title);
  } catch (e) {
    log(et("log.vdirFailed", { msg: (e as Error).message }), "warn");
  }
}

/** 把当前文档写成项目文件夹里的松散文件。⌘S 与编辑防抖都走这里。 */
async function flushAutosave() {
  clearTimeout(saveTimer);
  saveTimer = 0;
  if (!projectDir || !canSave()) return;
  if (saving) {
    saveAgain = true;
    return;
  }
  const dir = projectDir;
  const snap = doc;
  saving = true;
  renderSaveStatus();
  const t0 = performance.now();
  try {
    const preview = await capturePreview();
    if (dir !== projectDir || doc !== snap) return;
    const files = await collectCurrent(preview);
    if (!files) return;
    const changed = files.filter((f) => fileSig(f.data) !== writtenSig.get(f.path));
    if (changed.length) await writeToDirectory(dir, changed);
    for (const f of changed) writtenSig.set(f.path, fileSig(f.data));
    const keep = new Set(files.map((f) => f.path));
    for (const p of [...ownedPaths]) {
      if (keep.has(p)) continue;
      await removeProjectFile(dir, p);
      ownedPaths.delete(p);
      writtenSig.delete(p);
    }
    for (const f of files) ownedPaths.add(f.path);
    if (doc === snap) {
      dirty = false;
      syncDocTitle();
      log(et("log.autosaved", { name: dir.name }));
      log(et("log.saveTook", { s: ((performance.now() - t0) / 1000).toFixed(1) }));
      await syncVirtualDirName(dir);
    }
  } catch (e) {
    log(et("log.saveFailed", { msg: (e as Error).message }), "error");
  } finally {
    saving = false;
    renderSaveStatus();
    if (saveAgain) {
      saveAgain = false;
      scheduleAutosave();
    }
  }
}

/**
 * 导出 = 跑一遍导出管线（editor/export-pipeline.ts）：收集 → 钩子 → 校验 → 打包 → WE 兼容回读 → 落地。
 * 回读出 error 时先问一句再决定是否照样导出；诊断逐条进控制台。
 */
async function runExport(id: string) {
  closeExportMenu();
  const exporter = exporters.get(id);
  if (!doc || !exporter || !exporterAccepts(exporter, doc)) return;
  if (!exporter.action && !canSave()) return;
  const target = doc;
  packEl.disabled = true;
  try {
    const preview = exporter.action ? null : await capturePreview();
    const run = (force: boolean) =>
      runExportPipeline(id, target, () => collectCurrent(preview), {
        force,
        meta: { plugins: usedPlugins() },
        onPluginError: (who, e) => reportPluginError(who, e, "export"),
      });
    let r = await run(false);
    for (const d of r.diags) log(`[${d.source}] ${d.message}${d.path ? `（${d.path}）` : ""}`, d.level);
    if (r.blocked) {
      const n = r.diags.filter((d) => d.level === "error").length;
      if (!confirm(et("export.blocked", { n }))) {
        log(et("log.exportBlocked", { n }), "warn");
        return;
      }
      r = await run(true);
    }
    const packed = r.meta.packed as { entries: number; converted: number; bytes: number } | undefined;
    if (packed) log(et("log.packedPkg", { n: packed.entries, tex: packed.converted, mb: (packed.bytes / 1e6).toFixed(1) }));
    if (typeof r.meta.size === "number") log(et("log.savedZip", { n: r.files.length, mb: (r.meta.size / 1e6).toFixed(1) }));
    else if (r.message) log(r.message);
  } catch (e) {
    log(et("log.saveFailed", { msg: (e as Error).message }), "error");
  } finally {
    syncExportButton();
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
  docTitleEl.title = doc ? [dirty ? et("st.dirty") : "", et("proj.renameHint")].filter(Boolean).join(" · ") : "";
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
  scheduleAutosave();
  if (dirty) return;
  dirty = true;
  syncDocTitle();
  renderSaveStatus();
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
  markDirty();
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
 * hotAlways：对象变了也走 hot（调用方保证 hot 能把引擎带到与文档一致，如动画层整表替换）。
 */
function structEdit(
  label: string,
  mutate: (d: EditorDoc) => number | string | null | undefined,
  hot?: () => void,
  hotAlways = false,
) {
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
  if (hot && editor && (hotAlways || cmd.after === cmd.before)) {
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

/** 改图层名：可撤销；走结构编辑重挂，场景脚本里按名字取图层（getLayer）随之生效。返回是否改成 */
function renameLayer(id: number | string, raw: string): boolean {
  const n = doc ? findNode(doc.roots, id) : null;
  if (!n) return false;
  const name = raw.trim();
  if (name === n.name) return false;
  if (!name) {
    log(et("log.renameEmpty"), "warn");
    return false;
  }
  if (isLocked(id)) {
    log(et("log.renameLocked", { name: nodeName(id) }), "warn");
    return false;
  }
  return objEditOk(et("log.renamed", { from: nodeName(id), to: name }), id, (o) => {
    o.name = name;
    return true;
  });
}

const canRename = (id: number | string) => !!editor && !!current?.assets && doc?.type === "scene" && !isLocked(id);

/** 图层树里就地改名；行不在树上（父级折叠等）时改去聚焦检视器的名称框 */
function beginRename(id: number | string) {
  if (!canRename(id)) return;
  const row = treeEl.querySelector<HTMLElement>(`.ed-node[data-id="${CSS.escape(String(id))}"]`);
  const label = row?.querySelector<HTMLElement>(".ed-node-name");
  if (!row || !label) {
    const inp = inspectorEl.querySelector<HTMLInputElement>("input[data-field='name']");
    inp?.focus();
    inp?.select();
    return;
  }
  const n = doc ? findNode(doc.roots, id) : null;
  const input = document.createElement("input");
  input.type = "text";
  input.className = "ed-node-rename";
  input.value = n?.name ?? "";
  input.setAttribute("aria-label", et("f.name"));
  let settled = false;
  const finish = (save: boolean) => {
    if (settled) return;
    settled = true;
    if (!(save && renameLayer(id, input.value))) renderTree();
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") finish(true);
    else if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
  for (const ev of ["click", "dblclick", "pointerdown"]) input.addEventListener(ev, (e) => e.stopPropagation());
  label.replaceWith(input);
  input.focus();
  input.select();
}

// ---------- 工程名：标题栏就地改名 + 检视器工程卡入口 ----------

/** 工程名快照：doc.title（显示名）与 project.json 里的 title（落盘 / 库条目的真正来源） */
function titleSnap(): TitleSnap {
  const p = doc?.project as { title?: unknown } | undefined;
  return { title: doc?.title ?? "", projectTitle: typeof p?.title === "string" ? p.title : null };
}

/** 写回工程名：project.json 的 title 一改，保存与壁纸库条目名才会跟着变 */
function applyTitleSnap(s: TitleSnap) {
  if (!doc) return;
  doc.title = s.title;
  const p = doc.project as Record<string, unknown> | undefined;
  if (p) {
    if (s.projectTitle === null) delete p.title;
    else p.title = s.projectTitle;
  }
  syncDocTitle();
  renderSaveStatus();
  renderInspector();
  markDirty();
}

/** 改工程名：可撤销（结构命令的快照只装 objects，所以工程名单独一种命令） */
function renameProject(raw: string): boolean {
  if (!doc) return false;
  const name = raw.trim();
  if (!name) {
    log(et("log.renameProjectEmpty"), "warn");
    return false;
  }
  if (name === doc.title) return false;
  const from = doc.title;
  const before = titleSnap();
  applyTitleSnap({ title: name, projectTitle: name });
  const after = titleSnap();
  edits.push({ kind: "title", label: et("log.renamedProject", { from, to: name }), before, after });
  syncHistoryButtons();
  log(et("log.renamedProject", { from, to: name }));
  // 壁纸库条目的名字由宿主扫盘 project.json 得出，没有改名端点：改名后要另存为项目才落盘
  if (libItem && !projectDir) log(et("log.renameProjectLib"), "warn");
  return true;
}

/** 标题栏就地改名：双击标题（或检视器工程卡按钮）触发 */
function beginRenameProject() {
  if (!doc) return;
  const input = document.createElement("input");
  input.type = "text";
  input.className = "ed-doc-rename";
  input.value = doc.title;
  input.setAttribute("aria-label", et("proj.rename"));
  let settled = false;
  const finish = (save: boolean) => {
    if (settled) return;
    settled = true;
    const v = input.value;
    input.remove();
    syncDocTitle();
    if (save) renameProject(v);
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") finish(true);
    else if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
  for (const ev of ["click", "dblclick", "pointerdown"]) input.addEventListener(ev, (e) => e.stopPropagation());
  docTitleEl.textContent = "";
  docTitleEl.appendChild(input);
  input.focus();
  input.select();
}

docTitleEl.addEventListener("dblclick", () => beginRenameProject());

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
  if (isVideoCmd(cmd)) {
    log(et(dir === "undo" ? "log.undo" : "log.redo", { name: cmd.label }));
    setProjectVideo(dir === "undo" ? cmd.before : cmd.after);
    return;
  }
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
  if (isTitleCmd(cmd)) {
    log(et(dir === "undo" ? "log.undo" : "log.redo", { name: cmd.label }));
    applyTitleSnap(dir === "undo" ? cmd.before : cmd.after);
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
  // 命令服务优先（插件可登记 / 覆盖快捷键）；内核起来之前走下面的内置链
  if (app?.commands.handleKey(e)) {
    e.preventDefault();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    undoRedo(e.shiftKey ? "redo" : "undo");
  } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "y") {
    e.preventDefault();
    undoRedo("redo");
  } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    void flushAutosave();
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
  const strokePoly = (pts: Array<[number, number]>, dash: number[], width: number) => {
    overlayCtx.setLineDash(dash);
    overlayCtx.beginPath();
    pts.forEach(([x, y], i) => (i ? overlayCtx.lineTo(x, y) : overlayCtx.moveTo(x, y)));
    overlayCtx.closePath();
    overlayCtx.strokeStyle = "rgba(0,0,0,0.6)";
    overlayCtx.lineWidth = width + 1.5;
    overlayCtx.stroke();
    overlayCtx.strokeStyle = accent;
    overlayCtx.lineWidth = width;
    overlayCtx.stroke();
    overlayCtx.setLineDash([]);
    overlayCtx.lineWidth = 1.5;
  };
  // 模型层：网格凸包是主轮廓（拾取区就是网格），图层矩形退成细虚线只给手柄定位
  if (outline.hull) strokePoly(outline.hull, lockedSel ? [4, 3] : [], 1.5);
  if (outline.corners) strokePoly(outline.corners, outline.hull ? [3, 3] : lockedSel ? [4, 3] : [], outline.hull ? 1 : 1.5);
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
  drawAttachMarkers();
  drawBoneMarkers();
}

/** 骨骼面板展开时（W18）：关节点 + 父子连线，选中的骨高亮 */
function drawBoneMarkers() {
  if (!editor || !bonePick || selectedId === null || !same(bonePick.layer, selectedId)) return;
  const pts = editor.getBonePoints(Number(bonePick.layer));
  if (!pts?.length) return;
  overlayCtx.lineWidth = 1;
  overlayCtx.strokeStyle = "rgba(120,200,255,0.7)";
  overlayCtx.beginPath();
  pts.forEach((p, i) => {
    const q = p.parent >= 0 && p.parent !== i ? pts[p.parent]?.screen : null;
    if (!p.screen || !q) return;
    overlayCtx.moveTo(q[0], q[1]);
    overlayCtx.lineTo(p.screen[0], p.screen[1]);
  });
  overlayCtx.stroke();
  pts.forEach((p, i) => {
    if (!p.screen) return;
    const on = i === bonePick!.bone;
    overlayCtx.fillStyle = on ? SNAP_COLOR : "rgba(120,200,255,0.9)";
    overlayCtx.beginPath();
    overlayCtx.arc(p.screen[0], p.screen[1], on ? 4.5 : 2.5, 0, Math.PI * 2);
    overlayCtx.fill();
    if (on) {
      overlayCtx.font = "11px system-ui, sans-serif";
      overlayCtx.fillStyle = "rgba(0,0,0,0.6)";
      overlayCtx.fillText(p.name || `#${i}`, p.screen[0] + 8, p.screen[1] - 5);
      overlayCtx.fillStyle = SNAP_COLOR;
      overlayCtx.fillText(p.name || `#${i}`, p.screen[0] + 7, p.screen[1] - 6);
    }
  });
}

/** 附着点十字标记：选中模型层时画它自己的；选中普通层时画「挂到模型」里选的那个模型的（选中的附着点高亮） */
function drawAttachMarkers() {
  if (!editor || !doc || selectedId === null) return;
  const node = findNode(doc.roots, selectedId);
  const pick = attachPick && attachPick.layer === selectedId ? attachPick : null;
  const modelId = node?.modelForm && !pick ? node.id : pick?.model;
  if (modelId === undefined || modelId === null) return;
  const pts = editor.getAttachmentPoints(Number(modelId));
  if (!pts?.length) return;
  overlayCtx.font = "11px system-ui, sans-serif";
  overlayCtx.lineWidth = 1.5;
  for (const p of pts) {
    if (!p.screen) continue;
    const [x, y] = p.screen;
    const on = pick?.name === p.name;
    overlayCtx.strokeStyle = "rgba(0,0,0,0.6)";
    overlayCtx.lineWidth = 3;
    overlayCtx.beginPath();
    overlayCtx.moveTo(x - 5, y - 5);
    overlayCtx.lineTo(x + 5, y + 5);
    overlayCtx.moveTo(x + 5, y - 5);
    overlayCtx.lineTo(x - 5, y + 5);
    overlayCtx.stroke();
    overlayCtx.strokeStyle = on ? SNAP_COLOR : "#ffd166";
    overlayCtx.lineWidth = on ? 2 : 1.5;
    overlayCtx.stroke();
    if (on || node?.modelForm) {
      overlayCtx.fillStyle = "rgba(0,0,0,0.6)";
      overlayCtx.fillText(p.name, x + 8, y - 5);
      overlayCtx.fillStyle = on ? SNAP_COLOR : "#ffd166";
      overlayCtx.fillText(p.name, x + 7, y - 6);
    }
  }
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
    const o = editor.getLayerOutline(Number(id));
    const c = o?.hull ?? o?.corners;
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
  syncExportButton();
  renderSaveStatus();
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

// ---------- 壁纸库 / 壁纸配置 / 渲染 / 性能 / 使用说明：播放与编辑同一个页面 ----------

const MEDIA_BASE = `${location.origin}/media/dev`;
const WEB_BASE = `${location.origin}/web/dev`;
/** 播放侧部件的文案：编辑器词典优先，其余沿用 bench 词典 */
const pt = (key: string, params?: Record<string, string | number>) => (hasText(key) ? et(key, params) : t(key, params));

function syncPanelTools(panel: HTMLElement, id: string) {
  for (const el of panel.querySelectorAll<HTMLElement>(":scope > .wb-panel-head > [data-tools]")) el.hidden = el.dataset.tools !== id;
}

const panelTabs = {
  left: initTabs($("#ed-layers"), { storageKey: "we-editor-tab-left", onChange: (id) => syncPanelTools($("#ed-layers"), id) }),
  center: initTabs($("#ed-center"), {
    storageKey: "we-editor-tab-center",
    onChange: (id) => {
      if (id === "viewport") requestAnimationFrame(layoutStage);
    },
  }),
  bottom: initTabs($("#ed-console"), {
    storageKey: "we-editor-tab-bottom",
    onChange: (id) => {
      syncPanelTools($("#ed-console"), id);
      if (id === "perf") requestAnimationFrame(() => perfPanel.render());
    },
  }),
  right: initTabs($("#ed-right"), { storageKey: "we-editor-tab-right" }),
};

const renderSettings = mountRenderSettings({
  fps: $("#fps"),
  volume: $("#volume"),
  volumeVal: $("#volume-val"),
  aa: $("#aa"),
  pq: $("#pq"),
  pp: $("#pp"),
  sysAudio: $("#audio-sys"),
  audioStatus: $("#audio-state"),
  audioMeter: $("#audio-meter"),
  instance: () => instance,
});

const perfPanel = mountPerfPanel({
  summary: $("#perf-summary"),
  canvas: $("#perf-canvas"),
  t: pt,
  stats: () => instance?.stats ?? null,
  fpsCap: () => renderSettings.fpsCap(),
  visible: () => panelTabs.bottom.current() === "perf",
});

const wallpaperConfig = mountWallpaperConfig({
  body: $("#props-body"),
  state: $("#props-state"),
  filter: $("#props-filter"),
  showAll: $("#props-all"),
  reset: $("#props-reset"),
  mediaBase: MEDIA_BASE,
  t: pt,
  log,
  apply: (values) => {
    // 只有场景能就地热更；网页 / 视频壁纸保存后整体重挂（宿主按覆盖表重新合成 project.json）
    if (!instance || !editor || doc?.type !== "scene") return false;
    instance.setProperties(values as Record<string, PropertyValue>);
    return true;
  },
  reload: () => void mountCurrent(true),
});

/** 新窗口全屏播放（渲染器页），参数口径同桌面宿主 */
function playerUrl(it: LibraryItem): string {
  const kind = libraryKindOf(it);
  const p = new URLSearchParams();
  p.set("type", kind ?? it.type.toLowerCase());
  if (kind === "scene") p.set("src", it.itemId);
  else if (kind === "web") p.set("src", `${WEB_BASE}/${it.itemId}/${it.file ?? "index.html"}`);
  else if (it.file) p.set("src", `${MEDIA_BASE}/${it.itemId}/${it.file}`);
  const r = renderSettings.mountOptions();
  p.set("sceneFps", String(r.fps));
  p.set("aa", r.quality?.antiAliasing ?? "off");
  p.set("pq", r.quality?.particles ?? "high");
  p.set("pp", r.quality?.postProcessing ?? "high");
  p.set("muted", String(!(r.volume! > 0)));
  p.set("loop", "true");
  p.set("mediaBase", MEDIA_BASE);
  return `${import.meta.env.BASE_URL}renderer/index.html?${p}`;
}

async function openLibrary(it: LibraryItem) {
  if (doc && dirty && !projectDir && !confirm(et("lib.discardConfirm", { title: doc.title }))) return;
  if (!libraryKindOf(it)) {
    log(et("log.libUnsupported", { title: it.title, type: it.type }), "warn");
    return;
  }
  await openWith(it.title, () => openLibraryItem(it, MEDIA_BASE, WEB_BASE), { origin: { kind: "library" }, library: it, play: true });
}

const libraryPanel = mountLibraryPanel({
  list: $("#lib-list"),
  filter: $("#lib-filter"),
  typeFilter: $("#type-filter"),
  path: $("#libpath"),
  count: $("#lib-count"),
  refresh: $("#lib-refresh"),
  pickDir: $("#lib-pick"),
  mediaBase: MEDIA_BASE,
  t: pt,
  log,
  open: (it) => void openLibrary(it),
  play: (it) => void window.open(playerUrl(it), "_blank", "noopener"),
});

/** 当前文档与壁纸库的关联变了：高亮库条目、切换「壁纸配置」、重置帧率曲线 */
function syncLibraryItem() {
  libraryPanel.setActive(libItem?.itemId ?? null);
  wallpaperConfig.setItem(libItem?.itemId ?? null);
  perfPanel.reset();
  renderSaveStatus();
}

// 使用说明：中栏标签；帮助按钮 / 赞赏按钮 / 插件弹窗 / #docs=editor|plugins|library 直达
const DOC_KIND_KEY = "we-editor-docs-kind";
const asDocKind = (v: string | null | undefined): DocKind | null => (DOC_KINDS.includes(v as DocKind) ? (v as DocKind) : null);
let docKind: DocKind = asDocKind(localStorage.getItem(DOC_KIND_KEY)) ?? "editor";
const docsViewEl = $<HTMLElement>("#docs-view");
const docsSwitchBtns = [...document.querySelectorAll<HTMLButtonElement>("#docs-switch [data-doc]")];

function renderDocsView() {
  renderDocs($("#docs-body"), docKind, getLang());
  for (const b of docsSwitchBtns) {
    const on = b.dataset.doc === docKind;
    b.classList.toggle("active", on);
    b.setAttribute("aria-checked", String(on));
  }
}

function showDocs(kind: DocKind = docKind) {
  if (kind !== docKind) {
    docKind = kind;
    try {
      localStorage.setItem(DOC_KIND_KEY, kind);
    } catch {
      /* 只是不记住 */
    }
    renderDocsView();
    docsViewEl.scrollTop = 0;
  }
  panelTabs.center.select("docs");
}

for (const b of docsSwitchBtns) b.onclick = () => showDocs(asDocKind(b.dataset.doc) ?? docKind);
$<HTMLButtonElement>("#ed-help").onclick = () => showDocs("editor");
$<HTMLButtonElement>("#sponsor-btn").onclick = () => {
  showDocs();
  $("#sponsor-card").scrollIntoView({ block: "start", behavior: "smooth" });
};

function docsFromHash() {
  const m = /^#docs(?:=(\w+))?$/.exec(location.hash);
  if (m) showDocs(asDocKind(m[1]) ?? docKind);
}
window.addEventListener("hashchange", docsFromHash);

onChangeLang(() => {
  renderDocsView();
  libraryPanel.render();
  wallpaperConfig.refresh();
  perfPanel.render();
});

// ---------- 打开项目文件夹 / 导入 .pkg ----------

const pickDirDlg = $<HTMLDialogElement>("#pick-dir-dlg");

/**
 * 文件夹选择器要求「正在处理用户手势」：从文件框 change、拖放、异步链里调用会被拒（SecurityError）。
 * 被拒时弹确认框，在用户这一次点击里重新调用。
 */
async function pickDirectoryWithGesture(): Promise<DirHandle | null> {
  try {
    return await pickDirectory();
  } catch (e) {
    if ((e as Error).name !== "SecurityError") throw e;
  }
  return new Promise<DirHandle | null>((resolve, reject) => {
    let picking = false;
    $<HTMLButtonElement>("#pick-dir-ok").onclick = () => {
      picking = true;
      const p = pickDirectory();
      pickDirDlg.close();
      p.then(resolve, reject);
    };
    $<HTMLButtonElement>("#pick-dir-cancel").onclick = () => pickDirDlg.close();
    pickDirDlg.onclose = () => {
      if (!picking) resolve(null);
    };
    pickDirDlg.showModal();
  });
}

/** 新建工程还是打开已有工程：只有内置浏览器分这两种（文件夹选择器不分） */
type DirPurpose = "new" | "open";

/**
 * 真实文件夹：**只有用户明确选择才走这条路**（「打开项目」对话框里的「打开本地文件夹…」、
 * 工程卡里的「存到本机文件夹…」）。探测可写后返回，之后写盘链路与虚拟目录完全一样。
 */
async function requireLocalDir(): Promise<DirHandle | null> {
  let dir: DirHandle | null;
  try {
    dir = await pickDirectoryWithGesture();
  } catch (e) {
    log(et("log.pickFailed", { msg: `${(e as Error).name}: ${(e as Error).message}` }), "error");
    return null;
  }
  if (!dir) {
    log(et("log.pickCancelled"), "warn");
    return null;
  }
  try {
    await probeWritable(dir);
  } catch (e) {
    log(et("log.dirNotWritable", { name: dir.name, msg: `${(e as Error).name}: ${(e as Error).message}` }), "error");
    return null;
  }
  log(et("log.projectDir", { name: dir.name }));
  return dir;
}

/**
 * 拿一个项目目录：**默认走浏览器存储里的工程**（新建也一样，不弹文件夹选择器），
 * 之后的改动自动保存进 IndexedDB。真实目录只由 requireLocalDir 那条显式选择提供。
 */
async function requireProjectDir(purpose: DirPurpose = "new"): Promise<DirHandle | null> {
  return virtualProjectDir(purpose);
}

/**
 * 浏览器存储里的项目目录。#vdir-dlg 列出这台机器上存过的工程；
 * 「新建空白工程」= 直接开一个新的虚拟工程。写盘链路一行不用改 —— 虚拟目录实现的就是 DirHandle。
 * 「打开本地文件夹…」是对话框里唯一的真实目录口子，那条路返回的句柄没有 vdirId，直接放行。
 */
async function virtualProjectDir(purpose: DirPurpose): Promise<DirHandle | null> {
  let dir: DirHandle | null = null;
  try {
    dir = purpose === "open" ? await pickVirtualProject() : await createVirtualProject(et("new.untitled"));
  } catch (e) {
    log(et("log.vdirFailed", { msg: (e as Error).message }), "error");
    return null;
  }
  if (!dir) return null;
  const vid = virtualIdOf(dir);
  if (!vid) {
    // 用户在本机文件夹里打开 / 新建（requireLocalDir 已经探测过可写）
    log(et("log.projectDir", { name: dir.name }));
    return dir;
  }
  try {
    await probeWritable(dir);
  } catch (e) {
    log(et("log.dirNotWritable", { name: dir.name, msg: `${(e as Error).name}: ${(e as Error).message}` }), "error");
    return null;
  }
  setLastVirtualProjectId(vid);
  log(purpose === "open" ? et("log.vdirOpen", { name: dir.name }) : et("log.vdirNew", { name: dir.name }));
  return dir;
}

/** 工程列表对话框：点一行打开，右侧删除；新建 = 新建空白工程；只有明确点「打开本地文件夹…」才用真实目录 */
function pickVirtualProject(): Promise<DirHandle | null> {
  return new Promise<DirHandle | null>((resolve) => {
    let settled = false;
    const done = (dir: DirHandle | null) => {
      if (settled) return;
      settled = true;
      vdirNewEl.onclick = null;
      vdirLocalEl.onclick = null;
      vdirCancelEl.onclick = null;
      vdirDlgEl.onclose = null;
      resolve(dir);
    };
    const render = async () => {
      vdirListEl.textContent = "";
      let rows: VdirRecord[] = [];
      try {
        rows = await listVirtualProjects();
      } catch (e) {
        log(et("log.vdirFailed", { msg: (e as Error).message }), "error");
      }
      if (!rows.length) {
        vdirListEl.appendChild(note(et("vdir.empty")));
        return;
      }
      for (const rec of rows) {
        const row = document.createElement("div");
        row.className = "ed-vdir-row";
        const open = document.createElement("button");
        open.type = "button";
        open.className = "ed-vdir-open";
        const name = document.createElement("span");
        name.className = "ed-vdir-name";
        name.textContent = rec.name;
        const time = document.createElement("span");
        time.className = "ed-vdir-time";
        time.textContent = new Date(rec.updatedAt).toLocaleString();
        open.append(name, time);
        open.addEventListener("click", () => {
          void (async () => {
            const dir = await openVirtualProject(rec.id).catch((e) => {
              log(et("log.vdirFailed", { msg: (e as Error).message }), "error");
              return null;
            });
            if (!dir) {
              log(et("log.vdirMissing", { name: rec.name }), "warn");
              return;
            }
            vdirDlgEl.close();
            done(dir);
          })();
        });
        const del = document.createElement("button");
        del.type = "button";
        del.className = "ed-btn";
        del.textContent = et("vdir.del");
        del.addEventListener("click", () => {
          void (async () => {
            if (projectDir && virtualIdOf(projectDir) === rec.id) {
              log(et("vdir.delBusy", { name: rec.name }), "warn");
              return;
            }
            if (!confirm(et("vdir.delConfirm", { name: rec.name }))) return;
            try {
              await deleteVirtualProject(rec.id);
            } catch (e) {
              log(et("log.vdirFailed", { msg: (e as Error).message }), "error");
              return;
            }
            log(et("log.vdirDeleted", { name: rec.name }));
            await render();
          })();
        });
        row.append(open, del);
        vdirListEl.appendChild(row);
      }
    };
    vdirNewEl.onclick = () => {
      void (async () => {
        const dir = await createVirtualProject(et("new.untitled")).catch((e) => {
          log(et("log.vdirFailed", { msg: (e as Error).message }), "error");
          return null;
        });
        if (!dir) return;
        vdirDlgEl.close();
        done(dir);
      })();
    };
    vdirLocalEl.hidden = !canPickDirectory();
    vdirLocalEl.onclick = () => {
      void (async () => {
        const dir = await requireLocalDir();
        // 取消选择就留在对话框里，用户可以接着挑浏览器存储里的工程
        if (!dir) return;
        vdirDlgEl.close();
        done(dir);
      })();
    };
    // 「打开 .pkg」也收进这个对话框：它自带新建流程（自己找项目目录），这里只负责把文件选择器叫起来
    vdirPkgEl.onclick = () => {
      vdirDlgEl.close();
      inPkgEl.click();
    };
    vdirCancelEl.onclick = () => vdirDlgEl.close();
    vdirDlgEl.onclose = () => done(null);
    void render();
    vdirDlgEl.showModal();
  });
}

/**
 * 刷新 / 重开后找回浏览器存储里的工程（不是 ?item=<库条目>）。
 * 复用现成的草稿横幅 DOM（#ed-draft），不自动打开 —— 由用户点一下。
 */
async function checkVirtualResume() {
  if (new URL(location.href).searchParams.get("item")) return;
  const id = lastVirtualProjectId();
  if (!id) return;
  let recs: VdirRecord[] = [];
  try {
    recs = await listVirtualProjects();
  } catch (e) {
    log(et("log.vdirFailed", { msg: (e as Error).message }), "warn");
    return;
  }
  const rec = recs.find((r) => r.id === id);
  if (!rec) {
    setLastVirtualProjectId(null);
    return;
  }
  draftTextEl.textContent = et("vdir.found", { name: rec.name, time: new Date(rec.updatedAt).toLocaleString() });
  draftRestoreEl.onclick = () => {
    draftBannerEl.hidden = true;
    void resumeVirtualProject(rec);
  };
  draftDiscardEl.onclick = () => {
    draftBannerEl.hidden = true;
  };
  draftBannerEl.hidden = false;
}

/** 打开一个内置工程接着编辑（空工程按新建流程初始化），之后的改动自动保存回浏览器存储 */
async function resumeVirtualProject(rec: VdirRecord) {
  const dir = await openVirtualProject(rec.id).catch((e) => {
    log(et("log.vdirFailed", { msg: (e as Error).message }), "error");
    return null;
  });
  if (!dir) {
    log(et("log.vdirMissing", { name: rec.name }), "warn");
    return;
  }
  setLastVirtualProjectId(rec.id);
  try {
    const files = await filesFromDirectory(dir);
    if (!files.some((f) => !/(^|\/)(\.[^/]*|Thumbs\.db|desktop\.ini)$/i.test(f.path))) {
      await createNew([], dir);
      log(et("log.vdirResumed", { name: dir.name }));
      return;
    }
    adoptProject(dir);
    await openWith(dir.name, () => openLocalFiles(files), { origin: { kind: "local" } });
    log(et("log.vdirResumed", { name: dir.name }));
  } catch (e) {
    log(et("log.openFailed", { msg: (e as Error).message }), "error");
  }
}

// 「打开 .pkg」已收进「打开」对话框（见 pickVirtualProject），这里不再有独立的工具条按钮
$<HTMLButtonElement>("#tb-open-dir").onclick = () =>
  void (async () => {
    const dir = await requireProjectDir("open");
    if (!dir) return;
    try {
      const files = await filesFromDirectory(dir);
      // .DS_Store / Thumbs.db 这类系统文件不算内容
      if (!files.some((f) => !/(^|\/)(\.[^/]*|Thumbs\.db|desktop\.ini)$/i.test(f.path))) {
        log(et("log.emptyDirNew", { name: dir.name }));
        await createNew([], dir);
        return;
      }
      adoptProject(dir);
      await openWith(dir.name, () => openLocalFiles(files), { origin: { kind: "local" } });
    } catch (e) {
      log(et("log.openFailed", { msg: (e as Error).message }), "error");
    }
  })();

inPkgEl.onchange = () => {
  const files = filesFromInput(inPkgEl.files);
  inPkgEl.value = "";
  if (!files.length) return;
  void (async () => {
    const dir = await requireProjectDir();
    if (!dir) return;
    const name = files[0].path.split("/")[0] || files[0].file.name;
    adoptProject(dir);
    await openWith(name, () => openLocalFiles(files), { origin: { kind: "local" } });
    await flushAutosave();
  })();
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
  const dt = e.dataTransfer;
  const needsFolder = !doc?.scene;
  const dirPick = needsFolder ? requireProjectDir() : Promise.resolve(null);
  void collectDropped(dt).then(async (files) => {
    const dir = await dirPick;
    if (!files.length) {
      log(et("log.dropEmpty"), "warn");
      return;
    }
    if (files.some((f) => isModelFile(f.file)) && doc?.scene) {
      void importModelFiles(files.map((f) => f.file));
      return;
    }
    if (files.every((f) => isImageFile(f.file))) {
      void dropImages(files.map((f) => f.file), dir);
      return;
    }
    if (files.every((f) => isAudioFile(f.file))) {
      void addSoundFiles(files.map((f) => f.file));
      return;
    }
    if (files.every((f) => isVideoFile(f.file))) {
      void dropVideos(files.map((f) => f.file), dir);
      return;
    }
    if (!dir) {
      log(et("log.needDir"), "warn");
      return;
    }
    const name = files[0].path.split("/")[0] || files[0].file.name;
    adoptProject(dir);
    await openWith(name, () => openLocalFiles(files), { origin: { kind: "local" } });
    await flushAutosave();
  });
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") void flushAutosave();
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
  closeExportMenu();
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

$<HTMLButtonElement>("#new-blank").onclick = () =>
  void (async () => {
    closeNewMenu();
    const dir = await requireProjectDir();
    if (!dir) return;
    await createNew([], dir);
  })();
$<HTMLButtonElement>("#new-image").onclick = () => {
  imagePickFor = "template";
  inImageEl.click();
};
inImageEl.onchange = () => {
  const files = Array.from(inImageEl.files ?? []);
  inImageEl.value = "";
  if (!files.length) return;
  if (imagePickFor !== "template") {
    void addImageFiles(files);
    return;
  }
  void (async () => {
    const dir = await requireProjectDir();
    if (!dir) return;
    await createNew(files, dir);
  })();
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
async function createNew(
  images: File[],
  dir: DirHandle,
  videos: File[] = [],
  title0?: string,
  res0?: { w: number; h: number },
) {
  closeNewMenu();
  const imgs = images.length ? await readImages(images) : [];
  if (images.length && !imgs.length) return;
  const vids = videos.length ? await readVideos(videos) : [];
  if (videos.length && !vids.length) return;
  const res = res0 ?? selectedResolution();
  const title = title0 || et("new.untitled");
  adoptProject(dir);
  await openWith(title, async () => newOpened(title, newProject(title), blankScene(res.w, res.h, hexToRgb(newColorEl.value))), {
    origin: { kind: "new" },
    docDriven: true,
    after: () => {
      log(et("log.newDoc", { w: res.w, h: res.h }));
      if ((!imgs.length && !vids.length) || !doc) return;
      const lastVideo = vids.length ? placeVideos(doc, vids, true) : undefined;
      const lastImage = imgs.length ? placeImages(doc, imgs, !vids.length) : undefined;
      selectedId = lastImage ?? lastVideo ?? null;
      extraSel.clear();
      markDirty();
    },
  });
  scheduleAutosave();
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

/** 拖进来的全是图片：有打开的场景就加层，否则以它们新建（文件夹已在 drop 里选好） */
function dropImages(files: File[], dir: DirHandle | null) {
  if (doc?.scene && overlay && doc.type === "scene") return addImageFiles(files);
  if (!dir) {
    log(et("log.needDir"), "warn");
    return;
  }
  return createNew(files, dir);
}

// ---------- 导入模型（W19：glTF / FBX / OBJ / DAE / STL / PLY / 3DS） ----------

const inModelEl = $<HTMLInputElement>("#in-model");
/** 模型主文件 = 某个已登记导入器认的扩展名（插件导入器加了新格式，这里自动认） */
const isModelFile = (f: { name: string }) => isModelMain(f.name);
/** 文件框 accept 跟着导入器注册表走 */
function syncModelAccept() {
  inModelEl.accept = [...modelExts(), ...modelSideExts()].map((x) => `.${x}`).join(",");
}
/** 「导入模型」菜单选的形态；null = 按场景相机自动 */
let modelFormPick: GltfTarget | null = null;
inModelEl.onchange = () => {
  const files = Array.from(inModelEl.files ?? []);
  inModelEl.value = "";
  if (files.length) void importModelFiles(files, modelFormPick);
};

/**
 * 每个模型主文件（.glb / .gltf / .fbx / .obj / .dae / .stl / .ply / .3ds）转成一个模型层：
 * 形态缺省按场景定（正交 puppet = 图片层 + model json，透视 = 网格，model 指 .mdl），菜单可强制；
 * 同批的其余文件（.bin / .mtl / 贴图）供主文件按文件名引用（不分大小写、去目录）。产物写进资源表，加层 + 首个片段的动画层是一步结构编辑
 */
async function importModelFiles(files: File[], forceForm: GltfTarget | null = null, gen: PuppetGenerator | null = null) {
  if (!doc?.scene || !overlay || doc.type !== "scene") {
    log(et("log.structUnavailable"), "warn");
    return;
  }
  const target = doc;
  // 木偶生成器：每个所选文件各生成一个模型（产物是 ModelIR / glTF，后半段与导入完全相同）
  const mains = gen ? files : files.filter(isModelFile);
  if (!mains.length) {
    log(et("gl.fail.noModel"), "warn");
    return;
  }
  const side = new Map<string, Uint8Array>();
  for (const f of files) if (!gen && !isModelFile(f)) side.set(f.name.toLowerCase(), new Uint8Array(await f.arrayBuffer()));
  const generate = async (g: PuppetGenerator, name: string, bytes: Uint8Array): Promise<LoadedModel> => {
    const out: ModelIR | Gltf = await g.generate({ name, bytes });
    return "json" in out && "resolve" in out ? { gltf: out, warnings: [] } : { gltf: irToGltf(out as ModelIR), warnings: (out as ModelIR).warnings ?? [] };
  };
  const resolve = (uri: string) => {
    let u = uri;
    try {
      u = decodeURIComponent(uri);
    } catch {
      /* 保留原样 */
    }
    const base = u.replace(/\\/g, "/").split("/").pop()!.toLowerCase();
    return side.get(u.toLowerCase()) ?? side.get(base) ?? null;
  };
  for (const f of mains) {
    const name = f.name.replace(/\.[^.]+$/, "");
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const loaded = gen ? await generate(gen, f.name, bytes) : await loadModelFile(f.name, bytes, resolve);
      const g = loaded.gltf;
      const assets = overlay;
      if (doc !== target || !assets) return;
      const form = forceForm ?? defaultTarget(target);
      for (const w of loaded.warnings) log(et(`gl.warn.${w.code}`, { name, detail: w.detail ?? "" }), "warn");
      const listed = new Set(assets.list());
      const refs = referencedModels(target);
      const slug = imageSlug(name, (s) => [modelPathOf(s), editorMdlPathOf(s)].some((p) => assets.has(p) || listed.has(p) || refs.has(p)));
      // [2026-10-08 修复] 2D 正交场景里**两种形态都按像素量几何**：场景投影是 ortho 的像素空间，
      // fitMeshScale 给的是相机世界单位（≈几像素），mesh 形态会小到看不见（addModelLayer 里
      // 对应地也走 2D 摆放口径）。
      const pixelUnits = form === "puppet" || isOrthoDoc(target);
      const m = gltfToModel(g, { target: form, slug, fps: 30, scale: pixelUnits ? fitPuppetScale(target) : fitMeshScale(target) });
      await bakePuppetAtlas(m);
      const r = gltfImportFiles(m, slug);
      for (const x of r.files) assets.put(x.name, x.data, r.path);
      if (form === "puppet") target.puppets = new Map([...(target.puppets ?? []), [r.path, r.mdlPath]]);
      structEdit(et("log.modelImported", { name, form: et(`gl.form.${form}`), bones: m.bones, vertices: m.vertices, clips: m.clips.map((c) => c.name).join(", ") }), (d) =>
        addModelLayer(d, m, r.path, layerNameOf(f.name)),
      );
      for (const w of m.warnings) log(et(`gl.warn.${w.code}`, { name, detail: w.detail ?? "" }), "warn");
    } catch (e) {
      const ge = e instanceof GltfError ? e : null;
      log(et(`gl.fail.${ge?.code ?? "format"}`, { name: f.name, detail: ge ? ge.detail : (e as Error).message }), "error");
    }
  }
}

// ---------- 视频成层 ----------

const inVideoEl = $<HTMLInputElement>("#in-video");
/** 视频选择框的用途：加层 / 新建场景的背景 / 新建视频壁纸工程 / 替换视频工程的视频 */
let videoPickFor: "layer" | "template" | "wallpaper" | "replace" = "layer";
/** 视频层元数据缓存（按 slug）：检视器显示时长 / 尺寸，重开工程时懒探测补齐 */
const videoMeta = new Map<string, { width: number; height: number; duration: number; size: number }>();
let videoBusy: AbortController | null = null;

const mb = (n: number) => (n / 1048576).toFixed(1);
const videoSlugOf = (model: unknown) =>
  isEditorVideoModel(model) ? String(model).replace(/^models\/editor\/|\.json$/g, "") : null;
const isVideoNode = (n: LayerNode) => n.kind === "image" && isEditorVideoModel(n.obj.image);

/** 逐个归一成 mp4 / H.264（已是则原字节），转码时把进度打到控制台 */
async function readVideos(
  files: File[],
  keepAudio = false,
  trim?: { start: number; end: number },
): Promise<VideoInput[]> {
  const out: VideoInput[] = [];
  videoBusy?.abort();
  const ctl = new AbortController();
  videoBusy = ctl;
  try {
    for (const f of files) {
      if (ctl.signal.aborted) break;
      let lastPct = -1;
      try {
        const v = await normalizeVideo(f, f.name, {
          keepAudio,
          trim,
          signal: ctl.signal,
          onProgress: (p) => {
            const pct = Math.floor(p * 10) * 10;
            if (pct === lastPct || pct >= 100) return;
            lastPct = pct;
            log(et("log.videoConverting", { name: f.name, pct }));
          },
        });
        if (v.converted) log(et("log.videoConverted", { name: f.name, mb: mb(v.bytes.length) }));
        out.push(v);
      } catch (e) {
        if (isCanceled(e)) log(et("log.videoCanceled", { name: f.name }), "warn");
        else log(et("log.videoFailed", { name: f.name, msg: (e as Error).message }), "warn");
      }
    }
  } finally {
    if (videoBusy === ctl) videoBusy = null;
  }
  return out;
}

/** 视频写进资源表并追加图层（与图片层同一形态，只是贴图源是 mp4）；返回最后一个新层 id */
function placeVideos(d: EditorDoc, vids: VideoInput[], firstCover: boolean): number | undefined {
  if (!overlay) return undefined;
  let last: number | undefined;
  vids.forEach((v, i) => {
    const refs = referencedModels(d);
    const taken = (s: string) => overlay!.has(modelPathOf(VIDEO_SLUG_PREFIX + s)) || refs.has(modelPathOf(VIDEO_SLUG_PREFIX + s));
    const slug = VIDEO_SLUG_PREFIX + imageSlug(v.name, taken);
    for (const f of videoLayerFiles(slug, v)) overlay!.put(f.name, f.data, modelPathOf(slug));
    videoMeta.set(slug, { width: v.width, height: v.height, duration: v.duration, size: v.bytes.length });
    last = addImageLayer(d, slug, v, firstCover && i === 0 ? "cover" : "fit") ?? last;
  });
  return last;
}

async function addVideoFiles(files: File[]) {
  if (!doc?.scene || !overlay || doc.type !== "scene") {
    log(et("log.structUnavailable"), "warn");
    return;
  }
  const target = doc;
  const vids = await readVideos(files);
  if (!vids.length || doc !== target) return;
  structEdit(et("log.videosAdded", { names: vids.map((v) => v.name).join(", ") }), (d) => placeVideos(d, vids, false));
}

/** 拖进来的全是视频：有场景就加层；没有时第一个视频当背景新建场景 */
function dropVideos(files: File[], dir: DirHandle | null) {
  if (doc?.scene && overlay && doc.type === "scene") return addVideoFiles(files);
  if (!dir) {
    log(et("log.needDir"), "warn");
    return;
  }
  return createNew([], dir, files);
}

$<HTMLButtonElement>("#new-video").onclick = () => {
  videoPickFor = "template";
  inVideoEl.multiple = false;
  inVideoEl.click();
};
$<HTMLButtonElement>("#new-video-wp").onclick = () => {
  videoPickFor = "wallpaper";
  inVideoEl.multiple = false;
  inVideoEl.click();
};
inVideoEl.onchange = () => {
  const files = Array.from(inVideoEl.files ?? []);
  inVideoEl.value = "";
  inVideoEl.multiple = true;
  if (!files.length) return;
  const purpose = videoPickFor;
  videoPickFor = "layer";
  if (purpose === "layer") {
    void addVideoFiles(files);
    return;
  }
  if (purpose === "replace") {
    void replaceProjectVideo(files[0]);
    return;
  }
  closeNewMenu();
  void (async () => {
    const dir = await requireProjectDir();
    if (!dir) return;
    if (purpose === "wallpaper") await createVideoProject(files[0], dir);
    else await createNew([], dir, files.slice(0, 1));
  })();
};

// ---------- 视频壁纸工程（project.type = video） ----------

const videoPathOf = (fileName: string) => `${imageSlug(fileName, () => false).replace(/^image$/, "video")}.mp4`;

function videoOpened(title: string, path: string, bytes: Uint8Array): Opened {
  const d = makeDoc(title, videoProjectJson(title, path), null, null);
  d.video = { path, bytes };
  return { doc: d, source: mediaSource(new File([bytes as BlobPart], path, { type: "video/mp4" })) };
}

/** 新建视频壁纸工程：视频归一成 mp4 / H.264（保留音轨）后作为工程本体 */
async function createVideoProject(file: File, dir: DirHandle) {
  const [v] = await readVideos([file], true);
  if (!v) return;
  const title = layerNameOf(file.name);
  const path = videoPathOf(file.name);
  adoptProject(dir);
  await openWith(title, async () => videoOpened(title, path, v.bytes), { origin: { kind: "new" } });
  log(et("log.videoProject", { name: title, w: v.width, h: v.height, dur: v.duration.toFixed(2) }));
  markDirty();
}

/** 换视频本体（裁剪 / 替换 / 撤销重做共用）：清掉入出点、整段重挂预览 */
function setProjectVideo(clip: VideoClip) {
  if (!doc?.video) return;
  doc.video = { path: clip.path, bytes: clip.bytes };
  if (doc.project) doc.project.file = clip.path;
  trimIn = trimOut = null;
  markDirty();
  void mountCurrent();
}

function videoEdit(label: string, after: VideoClip) {
  if (!doc?.video) return;
  edits.push({ kind: "video", label, before: { ...doc.video }, after });
  syncHistoryButtons();
  log(label);
  setProjectVideo(after);
}

async function applyTrim() {
  if (!doc?.video || !videoEl) return;
  const target = doc;
  const dur = videoEl.duration || 0;
  const start = trimIn ?? 0;
  const end = trimOut ?? dur;
  if (!(end - start > 0.05)) {
    log(et("log.trimInvalid"), "warn");
    return;
  }
  const src = new File([doc.video.bytes as BlobPart], doc.video.path, { type: "video/mp4" });
  const [v] = await readVideos([src], true, { start, end });
  if (!v || doc !== target || !doc.video) return;
  const path = doc.video.path.replace(/\.[^./]+$/, "") + ".mp4";
  videoEdit(et("log.trimmed", { start: start.toFixed(2), end: end.toFixed(2), dur: v.duration.toFixed(2) }), { path, bytes: v.bytes });
}

async function replaceProjectVideo(file: File) {
  if (!doc?.video) return;
  const target = doc;
  const [v] = await readVideos([file], true);
  if (!v || doc !== target) return;
  videoEdit(et("log.videoReplaced", { name: file.name }), { path: videoPathOf(file.name), bytes: v.bytes });
}

/** 视频壁纸 → 场景：另选文件夹新建场景，视频作为铺满的底层，分辨率取视频本身（长边不超过 4K） */
async function videoToScene() {
  if (!doc?.video || !videoEl) return;
  const title = doc.title;
  const file = new File([doc.video.bytes as BlobPart], doc.video.path, { type: "video/mp4" });
  const k = Math.min(1, 3840 / Math.max(videoEl.videoWidth || 1920, videoEl.videoHeight || 1080));
  const res = { w: Math.round((videoEl.videoWidth || 1920) * k), h: Math.round((videoEl.videoHeight || 1080) * k) };
  const dir = await requireProjectDir();
  if (!dir) return;
  await createNew([], dir, [file], title, res);
  log(et("log.toScene", { name: title }));
}

function videoProjectGroup(): HTMLElement {
  const v = videoEl;
  const g = kvGroup(et("vp.title"), [
    ["f.videoFile", doc?.video?.path ?? "—"],
    ["f.resolution", v ? `${v.videoWidth} × ${v.videoHeight}` : "…"],
    ["f.duration", v ? `${(v.duration || 0).toFixed(2)}s` : "…"],
    ["f.bytes", doc?.video ? `${mb(doc.video.bytes.length)} MB` : "—"],
    ["vp.in", trimIn === null ? "—" : `${trimIn.toFixed(2)}s`],
    ["vp.out", trimOut === null ? "—" : `${trimOut.toFixed(2)}s`],
  ]);
  g.classList.add("ed-video-project");
  const bar = document.createElement("div");
  bar.className = "ed-fx-param ed-vp-actions";
  const btn = (key: string, act: string, onclick: () => void, disabled = false) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ed-btn";
    b.dataset.vp = act;
    b.textContent = et(key);
    b.disabled = disabled || !editor;
    b.onclick = onclick;
    bar.appendChild(b);
  };
  btn("vp.setIn", "in", () => {
    trimIn = editor?.time ?? 0;
    renderKeyMarks();
    renderInspector();
  });
  btn("vp.setOut", "out", () => {
    trimOut = editor?.time ?? 0;
    renderKeyMarks();
    renderInspector();
  });
  btn("vp.clearTrim", "clear", () => {
    trimIn = trimOut = null;
    renderKeyMarks();
    renderInspector();
  }, trimIn === null && trimOut === null);
  btn("vp.applyTrim", "apply", () => void applyTrim(), trimIn === null && trimOut === null);
  btn("vp.replace", "replace", () => {
    videoPickFor = "replace";
    inVideoEl.multiple = false;
    inVideoEl.click();
  });
  btn("vp.toScene", "to-scene", () => void videoToScene());
  g.append(bar, note(et("vp.trimHint")));
  return g;
}

/** 检视器里的视频信息；重开的工程没有缓存时探测一次再重画 */
function videoInfoGroup(node: LayerNode): HTMLElement {
  const slug = videoSlugOf(node.obj.image)!;
  const meta = videoMeta.get(slug);
  if (!meta && overlay) {
    void (async () => {
      const bytes = await overlay!.read(videoMaterialPathOf(slug));
      if (!bytes) return;
      const p = await probeVideo(new Blob([bytes as BlobPart], { type: "video/mp4" })).catch(() => null);
      if (!p) return;
      videoMeta.set(slug, { width: p.width, height: p.height, duration: p.duration, size: bytes.length });
      if (selectedId === node.id) renderInspector();
    })();
  }
  const g = kvGroup(et("insp.video"), [
    ["f.videoFile", videoMaterialPathOf(slug)],
    ["f.resolution", meta ? `${meta.width} × ${meta.height}` : "…"],
    ["f.duration", meta ? `${meta.duration.toFixed(2)}s` : "…"],
    ["f.bytes", meta ? `${mb(meta.size)} MB` : "…"],
  ]);
  g.classList.add("ed-video");
  g.appendChild(note(et("insp.videoSync")));
  return g;
}


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
const lyAddModelEl = $<HTMLButtonElement>("#ly-add-model");
const modelMenuEl = $<HTMLElement>("#model-menu");
function presetMenu(btn: HTMLButtonElement, menu: HTMLElement, pick: (preset: string) => void) {
  btn.onclick = (e) => {
    e.stopPropagation();
    for (const m of [textMenuEl, particleMenuEl, modelMenuEl]) if (m !== menu) m.hidden = true;
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
  // 委托：菜单项会随注册表重建（粒子模板 / 木偶生成器）
  menu.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-preset]");
    if (!b || !menu.contains(b)) return;
    menu.hidden = true;
    pick(b.dataset.preset!);
  });
}
presetMenu(lyAddTextEl, textMenuEl, (p) => addText(p as TextPreset));
presetMenu(lyAddParticleEl, particleMenuEl, (p) => addParticle(p as ParticlePreset));

/** 菜单项与注册表对齐：已有的静态按钮（带 data-et 词条）原样复用，新增的按 title 出文案 */
function syncMenuItems(menu: HTMLElement, attr: "preset" | "generator", items: ReadonlyArray<{ id: string; label: string; et?: string }>) {
  const sel = `button[data-${attr}]`;
  const existing = new Map([...menu.querySelectorAll<HTMLButtonElement>(sel)].map((b) => [b.dataset[attr]!, b]));
  for (const it of items) {
    let b = existing.get(it.id);
    existing.delete(it.id);
    if (!b) {
      b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "menuitem");
      b.dataset[attr] = it.id;
      if (it.et) b.dataset.et = it.et;
    }
    b.textContent = it.label;
    menu.appendChild(b);
  }
  for (const b of existing.values()) b.remove();
}

function renderParticleMenu() {
  syncMenuItems(
    particleMenuEl,
    "preset",
    particleTemplates.list().map((t) => {
      const key = `pt.${t.id}`;
      return { id: t.id, label: t.title !== undefined ? textOf(t.title, getLang(), t.id) : hasText(key) ? et(key) : t.id, et: t.title === undefined && hasText(key) ? key : undefined };
    }),
  );
}

/** 木偶生成器挂在「导入模型」菜单末尾（按钮 data-generator，与形态预设分开） */
function renderGeneratorMenu() {
  syncMenuItems(
    modelMenuEl,
    "generator",
    puppetGenerators.list().map((g) => ({ id: g.id, label: textOf(g.title, getLang(), g.id) })),
  );
}
const inGenEl = document.createElement("input");
inGenEl.type = "file";
inGenEl.hidden = true;
document.body.appendChild(inGenEl);
let genPick: string | null = null;
modelMenuEl.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-generator]");
  const g = b && puppetGenerators.get(b.dataset.generator!);
  if (!g) return;
  modelMenuEl.hidden = true;
  genPick = g.id;
  inGenEl.accept = g.accept;
  inGenEl.multiple = true;
  inGenEl.click();
});
inGenEl.onchange = () => {
  const files = Array.from(inGenEl.files ?? []);
  inGenEl.value = "";
  const g = genPick ? puppetGenerators.get(genPick) : undefined;
  if (files.length && g) void importModelFiles(files, "puppet", g);
};
const lyAddVideoEl = $<HTMLButtonElement>("#ly-add-video");
lyAddVideoEl.onclick = () => {
  videoPickFor = "layer";
  inVideoEl.click();
};
presetMenu(lyAddModelEl, modelMenuEl, (p) => {
  modelFormPick = p === "puppet" || p === "mesh" ? p : null;
  inModelEl.click();
});
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
  if (e.button !== 0 || (e.target as HTMLElement).closest("button, input, .ed-twisty")) return;
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
  lyAddVideoEl.disabled = lyAddEl.disabled;
  lyAddModelEl.disabled = lyAddEl.disabled;
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
    treeEl.appendChild(note(doc.video ? et("vp.layers") : et("layers.notScene", { type: doc.type })));
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
  kind.dataset.kind = n.modelForm ? "model" : n.kind;
  if (isVideoNode(n)) kind.dataset.kind = "video";
  kind.textContent = et(isVideoNode(n) ? "kind.video" : n.modelForm ? "kind.model" : `kind.${n.kind}`);
  if (n.modelForm) kind.title = et(`model.form.${n.modelForm}`);
  const name = document.createElement("span");
  name.className = "ed-node-name";
  name.textContent = n.name || `#${n.id}`;
  if (canRename(n.id)) {
    name.title = et("layer.renameHint");
    name.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      beginRename(n.id);
    });
  }
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

/** 模型层只读信息（W12）：全部经引擎 getModelInfo 取，模型没装上时只给一句说明 */
function modelGroup(node: LayerNode): HTMLElement {
  const id = Number(node.id);
  const info = editor && Number.isFinite(id) ? editor.getModelInfo(id) : null;
  if (!info) {
    const g = kvGroup(et("insp.model"), [["model.form", et(`model.form.${node.modelForm}`)]]);
    g.appendChild(note(et("model.notLoaded")));
    return g;
  }
  const g = kvGroup(
    et("insp.model"),
    modelInfoRows(info).map(([k, v]) => [k, k === "model.form" ? et(`model.form.${v}`) : v]),
  );
  g.classList.add("ed-model-group");
  return g;
}

/** 把引擎里该层的动画层表推回文档原样（结束单独预览 / 拖动预览后复位） */
function pushAnimLayers(id: number | string, list: unknown) {
  const n = Number(id);
  if (!editor || !Number.isFinite(n)) return;
  editor
    .setAnimationLayers(n, Array.isArray(list) ? (list as Array<Record<string, unknown>>) : [])
    .catch((e) => log(et("log.animLayerFailed", { msg: (e as Error).message }), "warn"));
}

function endAnimSolo() {
  if (!animSolo) return;
  const n = doc && findNode(doc.roots, animSolo.id);
  animSolo = null;
  if (n) pushAnimLayers(n.id, n.obj.animationlayers);
}

/** 动画层的一次可撤销编辑：表里没有包装时整表热替换，否则重挂（包装的脚本 / 曲线 / 绑定按下标挂在装配期） */
function animLayerEdit(label: string, node: LayerNode, mutate: (o: LayerNode["obj"]) => boolean) {
  animSolo = null;
  const id = Number(node.id);
  const hot = !!editor && Number.isFinite(id) && !!editor.getModelInfo(id) && animLayersHot(node.obj);
  structEdit(
    label,
    (d) => {
      const n = findNode(d.roots, node.id);
      return n && mutate(n.obj) ? n.id : undefined;
    },
    hot ? () => pushAnimLayers(node.id, findNode(doc!.roots, node.id)?.obj.animationlayers) : undefined,
    hot,
  );
}

/** 动画层（W13）：片段 / 速率 / 混合 / 可见 / 叠加 / 名称、排序、增删、单独预览 */
function animLayersGroup(node: LayerNode): HTMLElement {
  const group = document.createElement("div");
  group.className = "ed-insp-group ed-fx ed-animlayers";
  const h = document.createElement("div");
  h.className = "ed-insp-title";
  h.textContent = et("insp.animLayers");
  group.appendChild(h);
  const id = Number(node.id);
  const info = editor && Number.isFinite(id) ? editor.getModelInfo(id) : null;
  const clips = info?.animations ?? [];
  const views = getAnimLayers(node.obj);
  const editable = !!overlay && !!editor && !isLocked(node.id);
  const hot = animLayersHot(node.obj);
  if (!clips.length) {
    group.appendChild(note(et(info ? "al.noClips" : "model.notLoaded")));
    if (!views.length) return group;
  }
  if (!views.length) group.appendChild(note(et("al.none")));
  if (views.length && !hot) group.appendChild(note(et("al.remount")));
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
  const clipLabel = (c: (typeof clips)[number]) => `${c.name || `#${c.id}`} · ${fmtNum(c.duration)}s`;
  for (const v of views) {
    const label = v.name || `#${v.index + 1}`;
    const edit = (field: string, mutate: (o: LayerNode["obj"]) => boolean) =>
      animLayerEdit(et("log.animLayerEdited", { layer: nodeName(node.id), name: label, field: et(field) }), node, mutate);
    const item = document.createElement("div");
    item.className = "ed-fx-item";
    item.dataset.alIndex = String(v.index);
    if (!v.visible) item.classList.add("hidden-layer");
    const head = document.createElement("div");
    head.className = "ed-fx-head";
    const name = document.createElement("input");
    name.type = "text";
    name.className = "ed-fx-name ed-al-name";
    name.value = v.name;
    name.disabled = !editable;
    name.addEventListener("change", () => edit("al.name", (o) => setAnimLayerField(o, v.index, "name", name.value)));
    const solo = animSolo?.id === node.id && animSolo.index === v.index;
    const soloBtn = iconBtn("ed-al-solo", solo ? "◎" : "◌", et("al.solo"), () => {
      if (solo) return void (endAnimSolo(), renderInspector());
      animSolo = { id: node.id, index: v.index };
      pushAnimLayers(node.id, soloAnimLayers(node.obj, v.index));
      renderInspector();
    }, !hot || !info);
    if (solo) soloBtn.classList.add("on");
    head.append(
      name,
      soloBtn,
      iconBtn("ed-al-up", "↑", et("fx.up"), () => animLayerEdit(et("log.animLayerMoved", { name: label }), node, (o) => moveAnimLayer(o, v.index, -1)), v.index === 0),
      iconBtn("ed-al-down", "↓", et("fx.down"), () => animLayerEdit(et("log.animLayerMoved", { name: label }), node, (o) => moveAnimLayer(o, v.index, 1)), v.index === views.length - 1),
      iconBtn("ed-al-del", "✕", et("fx.del"), () => animLayerEdit(et("log.animLayerRemoved", { name: label }), node, (o) => removeAnimLayer(o, v.index))),
    );
    item.appendChild(head);
    const form = document.createElement("div");
    form.className = "ed-fx-params";
    const row = (key: string, el: HTMLElement) => {
      const l = document.createElement("label");
      l.textContent = et(key);
      const box = document.createElement("div");
      box.className = "ed-fx-param";
      box.appendChild(el);
      form.append(l, box);
      return box;
    };
    const wrapNote = (f: keyof AnimLayerView["wrapped"], el: HTMLInputElement) => {
      const w = v.wrapped[f];
      if (!w) return;
      el.disabled = true;
      el.title = et(`al.wrap.${w}`);
    };
    const clipSel = document.createElement("select");
    clipSel.className = "ed-al-clip";
    clipSel.disabled = !editable || !clips.length;
    for (const c of clips) {
      const o = document.createElement("option");
      o.value = String(c.id);
      o.textContent = clipLabel(c);
      clipSel.appendChild(o);
    }
    if (!clips.some((c) => c.id === v.animation)) {
      const o = document.createElement("option");
      o.value = String(v.animation);
      o.textContent = et("al.missingClip", { id: v.animation });
      clipSel.appendChild(o);
    }
    clipSel.value = String(v.animation);
    clipSel.addEventListener("change", () => edit("al.clip", (o) => setAnimLayerField(o, v.index, "animation", Number(clipSel.value))));
    row("al.clip", clipSel);
    /** 拖动中只推引擎预览（文档不动），松手才入栈；有包装时不预览（热替换会丢绑定） */
    const preview = (field: "blend" | "rate", value: number) => {
      if (!hot || !info || animSolo) return;
      const list = structuredClone(node.obj.animationlayers) as Array<Record<string, unknown>>;
      if (list[v.index]) list[v.index][field] = value;
      pushAnimLayers(node.id, list);
    };
    const rate = document.createElement("input");
    rate.type = "number";
    rate.className = "ed-al-rate";
    rate.min = "0";
    rate.step = "0.1";
    rate.value = fmtNum(v.rate);
    rate.disabled = !editable;
    wrapNote("rate", rate);
    rate.addEventListener("change", () => {
      if (!objEditOkAnim(node, "al.rate", label, (o) => setAnimLayerField(o, v.index, "rate", Number(rate.value)))) rate.value = fmtNum(v.rate);
    });
    row("al.rate", rate);
    const blend = document.createElement("input");
    blend.type = "range";
    blend.className = "ed-al-blend";
    blend.min = "0";
    blend.max = "1";
    blend.step = "0.01";
    blend.value = String(v.blend);
    blend.disabled = !editable;
    wrapNote("blend", blend);
    const out = document.createElement("span");
    out.className = "ed-val";
    out.textContent = fmtNum(v.blend);
    blend.addEventListener("input", () => {
      out.textContent = fmtNum(Number(blend.value));
      preview("blend", Number(blend.value));
    });
    blend.addEventListener("change", () => edit("al.blend", (o) => setAnimLayerField(o, v.index, "blend", Number(blend.value))));
    row("al.blend", blend).appendChild(out);
    for (const f of ["visible", "additive"] as const) {
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = `ed-al-${f}`;
      cb.checked = v[f];
      cb.disabled = !editable;
      if (f === "visible") wrapNote("visible", cb);
      cb.addEventListener("change", () => edit(`al.${f}`, (o) => setAnimLayerField(o, v.index, f, cb.checked)));
      row(`al.${f}`, cb);
    }
    item.appendChild(form);
    group.appendChild(item);
  }
  if (clips.length) {
    const add = document.createElement("button");
    add.type = "button";
    add.className = "ed-btn ed-al-add";
    add.textContent = et("al.add");
    add.disabled = !editable;
    add.onclick = () => {
      const used = new Set(views.map((v) => v.animation));
      const clip = clips.find((c) => !used.has(c.id)) ?? clips[0];
      const name = et("al.defaultName", { n: views.length + 1 });
      animLayerEdit(et("log.animLayerAdded", { name, layer: nodeName(node.id) }), node, (o) => doc !== null && addAnimLayer(doc, o, clip.id, name) !== null);
    };
    group.appendChild(add);
  }
  return group;
}

/** 页面给 attachToModel / detachFromModel 的偏移来源：引擎此刻的附着点状态 */
const attachOffsetOf: AttachOffsetOf = (mid, name) =>
  editor?.getAttachmentPoints(Number(mid))?.find((p) => p.name === name)?.offset ?? null;

/** 子网格贴图（W16）：每个子网格一行「贴图名 + 替换」；换图走写时复制 + 结构编辑（重挂） */
function modelTexGroup(node: LayerNode): HTMLElement | null {
  const id = Number(node.id);
  const info = editor && Number.isFinite(id) ? editor.getModelInfo(id) : null;
  if (!info) return null;
  const group = document.createElement("div");
  group.className = "ed-insp-group ed-model-tex";
  const h = document.createElement("div");
  h.className = "ed-insp-title";
  h.textContent = et("insp.modelTex");
  group.appendChild(h);
  group.appendChild(note(et("mt.note")));
  const editable = !!overlay && !isLocked(node.id);
  const form = document.createElement("div");
  form.className = "ed-fx-params";
  for (const s of modelTextureSlots(info)) {
    const l = document.createElement("label");
    l.textContent = `#${s.index}`;
    if (s.materialPath) l.title = s.materialPath;
    const box = document.createElement("div");
    box.className = "ed-fx-param ed-mt-row";
    box.dataset.mesh = String(s.index);
    const name = document.createElement("span");
    name.className = "ed-mt-name";
    name.textContent = s.texture ?? et("mt.noTexture");
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ed-btn ed-mt-replace";
    b.textContent = et("mt.replace");
    b.disabled = !editable;
    b.onclick = () => {
      modelTexPick = { layer: node.id, mesh: s.index };
      inModelTexEl.click();
    };
    box.append(name, b);
    form.append(l, box);
  }
  group.appendChild(form);
  return group;
}

const inModelTexEl = $<HTMLInputElement>("#in-model-tex");
let modelTexPick: { layer: number | string; mesh: number } | null = null;
inModelTexEl.onchange = async () => {
  const file = inModelTexEl.files?.[0];
  inModelTexEl.value = "";
  const pick = modelTexPick;
  modelTexPick = null;
  if (!file || !pick || !isImageFile(file)) return;
  const [img] = await readImages([file]);
  if (img) await replaceModelTexture(pick.layer, pick.mesh, img);
};

async function replaceModelTexture(layerId: number | string, mesh: number, img: ImageInput) {
  const d = doc;
  const node = d && findNode(d.roots, layerId);
  const assets = overlay;
  if (!d || !node || !assets || !node.modelForm) return;
  const o = node.obj;
  const listed = new Set(assets.list());
  const slug = imageSlug(img.name, (s) =>
    [modelPathOf(s), editorMdlOf(s), editorMaterialOf(s)].some((p) => assets.has(p) || listed.has(p)),
  );
  const fail = (key: string, path: string) => void log(et(key, { path }), "warn");
  let r: RetextureResult | null;
  let from: string;
  let puppet: string | null = null;
  if (node.modelForm === "puppet") {
    from = String(o.image);
    const modelJson = parseJsonBytes(await assets.read(from));
    if (!modelJson) return fail("mt.fail.read", from);
    const matPath = String(modelJson.material ?? "");
    const material = parseJsonBytes(matPath ? await assets.read(matPath) : null);
    if (!material) return fail("mt.fail.read", matPath || from);
    r = puppetRetexture(modelJson, material, slug, img);
    if (!r) return fail("mt.fail.material", matPath);
    puppet = String(modelJson.puppet);
  } else {
    from = String(o.model);
    const bytes = await assets.read(from);
    if (!bytes) return fail("mt.fail.read", from);
    const matPath = meshMaterialPath(bytes, mesh);
    if (!matPath) return fail("mt.fail.mdl", from);
    const material = parseJsonBytes(await assets.read(matPath));
    if (!material) return fail("mt.fail.read", matPath);
    r = meshRetexture(bytes, mesh, material, slug, img);
    if (!r) return fail("mt.fail.material", matPath);
  }
  if (d !== doc) return;
  const res = r;
  for (const f of res.files) assets.put(f.name, f.data, res.path);
  assets.share(from, res.path);
  if (puppet) d.puppets = new Map([...(d.puppets ?? []), [res.path, puppet]]);
  structEdit(et("log.modelTexReplaced", { layer: nodeName(layerId), index: mesh, name: img.name }), (dd) => {
    const n = findNode(dd.roots, layerId);
    if (!n) return undefined;
    if (puppet) n.obj.image = res.path;
    else n.obj.model = res.path;
    return n.id;
  });
}

function dropBonePick() {
  if (!bonePick) return;
  void editor?.setBonePose(Number(bonePick.layer), bonePick.bone, null).catch(() => {});
  bonePick = null;
}

const DEG = Math.PI / 180;
const boneDeltaOf = (p: NonNullable<typeof bonePick>): MdlBoneDelta => ({
  t: [...p.t],
  r: p.r.map((v) => v * DEG) as BoneVec,
  s: [...p.s],
});

/**
 * 骨骼（W18a）：片段 + 骨 + 帧 → 增量（平移 / 角度 / 缩放）。输入即推引擎预览，「应用」写时复制 .mdl
 * 改该片段该骨的轨道（按衰减半径淡出）并重挂；「复位」撤掉预览
 */
function boneGroup(node: LayerNode): HTMLElement | null {
  const id = Number(node.id);
  const info = editor && Number.isFinite(id) ? editor.getModelInfo(id) : null;
  if (!info || !info.bones.length) return null;
  const group = document.createElement("div");
  group.className = "ed-insp-group ed-bones";
  const h = document.createElement("div");
  h.className = "ed-insp-title";
  h.textContent = et("insp.bones");
  group.appendChild(h);
  const clips = info.animations.filter((c) => c.frames > 0);
  if (!clips.length) {
    group.appendChild(note(et("bn.noClips")));
    return group;
  }
  if (bonePick && !same(bonePick.layer, node.id)) {
    void editor!.setBonePose(Number(bonePick.layer), bonePick.bone, null).catch(() => {});
    bonePick = null;
  }
  const layers = getAnimLayers(node.obj);
  if (!bonePick || !clips.some((c) => c.id === bonePick!.clip) || bonePick.bone >= info.bones.length) {
    bonePick = {
      layer: node.id,
      clip: defaultClipId(clips, layers) ?? clips[0].id,
      bone: bonePick && bonePick.bone < info.bones.length ? bonePick.bone : 0,
      frame: null,
      radius: 0,
      t: [0, 0, 0],
      r: [0, 0, 0],
      s: [1, 1, 1],
    };
  }
  const pick = bonePick;
  const clip = clips.find((c) => c.id === pick.clip)!;
  const rate = layers.find((l) => l.animation === clip.id)?.rate ?? 1;
  const frame = Math.min(clip.frames - 1, pick.frame ?? clipFrameAt(clip, editor!.time * rate));
  const editable = !!overlay && !isLocked(node.id);
  group.appendChild(note(et("bn.note")));
  const form = document.createElement("div");
  form.className = "ed-fx-params";
  const row = (key: string, el: HTMLElement) => {
    const l = document.createElement("label");
    l.textContent = et(key);
    const box = document.createElement("div");
    box.className = "ed-fx-param";
    box.appendChild(el);
    form.append(l, box);
    return box;
  };
  const select = (cls: string, opts: Array<[string, string]>, value: string, onChange: (v: string) => void) => {
    const s = document.createElement("select");
    s.className = cls;
    for (const [v, text] of opts) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = text;
      s.appendChild(o);
    }
    s.value = value;
    s.addEventListener("change", () => onChange(s.value));
    return s;
  };
  const dirty = () => !isZeroDelta(boneDeltaOf(pick));
  const clearPreview = () => editor!.setBonePose(id, pick.bone, null).catch(() => {});
  const preview = () =>
    void editor!
      .setBonePose(id, pick.bone, dirty() ? boneDeltaOf(pick) : null)
      .then(() => drawOverlay())
      .catch(() => {});
  const reselect = (patch: Partial<typeof pick>) => {
    void clearPreview();
    bonePick = { ...pick, ...patch, t: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] };
    renderInspector();
    drawOverlay();
  };
  row(
    "bn.clip",
    select("ed-bn-clip", clips.map((c) => [String(c.id), `${c.name || `#${c.id}`} · ${c.mode} · ${c.frames}f`]), String(clip.id), (v) =>
      reselect({ clip: Number(v), frame: null }),
    ),
  );
  const depth = boneDepths(info.bones);
  row(
    "bn.bone",
    select(
      "ed-bn-bone",
      info.bones.map((b, i) => [String(i), `${"\u00a0\u00a0".repeat(Math.min(depth[i], 12))}${b.name || `#${i}`}`]),
      String(pick.bone),
      (v) => reselect({ bone: Number(v) }),
    ),
  );
  const fr = document.createElement("input");
  fr.type = "number";
  fr.className = "ed-bn-frame";
  fr.min = "0";
  fr.max = String(clip.frames - 1);
  fr.step = "1";
  fr.value = String(frame);
  fr.addEventListener("change", () => {
    const v = Math.round(Number(fr.value));
    pick.frame = Number.isFinite(v) ? Math.min(Math.max(v, 0), clip.frames - 1) : null;
    fr.value = String(pick.frame ?? frame);
  });
  const now = document.createElement("button");
  now.type = "button";
  now.className = "ed-icon ed-bn-now";
  now.textContent = "⟲";
  now.title = et("bn.frameNow");
  now.onclick = () => {
    pick.frame = null;
    renderInspector();
  };
  row("bn.frame", fr).appendChild(now);
  const vec = (key: string, cls: string, v: BoneVec, step: string) => {
    const box = row(key, document.createElement("span"));
    box.replaceChildren();
    box.classList.add("ed-bn-vec");
    v.forEach((x, k) => {
      const inp = document.createElement("input");
      inp.type = "number";
      inp.className = `${cls} ${cls}-${"xyz"[k]}`;
      inp.step = step;
      inp.value = fmtNum(x);
      inp.disabled = !editable;
      inp.addEventListener("input", () => {
        const n = Number(inp.value);
        if (!Number.isFinite(n)) return;
        v[k] = n;
        preview();
      });
      box.appendChild(inp);
    });
  };
  vec("bn.t", "ed-bn-t", pick.t, "1");
  vec("bn.r", "ed-bn-r", pick.r, "1");
  vec("bn.s", "ed-bn-s", pick.s, "0.05");
  row(
    "bn.radius",
    select(
      "ed-bn-radius",
      BONE_RADII.map((r) => [String(r), r < 0 ? et("bn.radius.all") : r === 0 ? et("bn.radius.one") : et("bn.radius.n", { n: r })]),
      String(pick.radius),
      (v) => (pick.radius = Number(v)),
    ),
  );
  group.appendChild(form);
  const actions = document.createElement("div");
  actions.className = "ed-insp-actions";
  const apply = document.createElement("button");
  apply.type = "button";
  apply.className = "ed-btn ed-bn-apply";
  apply.textContent = et("bn.apply");
  apply.disabled = !editable;
  apply.onclick = () => {
    if (!dirty()) return;
    const edit: BoneEdit = { animId: clip.id, bone: pick.bone, frame: pick.frame ?? frame, delta: boneDeltaOf(pick), radius: pick.radius };
    void applyBoneEdit(node.id, edit, info.bones[pick.bone]?.name || `#${pick.bone}`, clip.name || `#${clip.id}`);
  };
  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "ed-btn ed-bn-reset";
  reset.textContent = et("bn.reset");
  reset.onclick = () => reselect({});
  actions.append(apply, reset);
  group.appendChild(actions);
  return group;
}

/**
 * 改模型 .mdl 的一次可撤销编辑（W18）：读对象当前的 .mdl → edit → 写时复制（puppet 连 model json 一起）→
 * 结构编辑改指向（重挂）。mutate 在同一步里顺带改对象（删片段时删掉指向它的动画层）。fail = 文案前缀（bn / cl）
 */
async function commitMdlEdit(
  layerId: number | string,
  label: string,
  slugTag: string,
  fail: "bn" | "cl",
  edit: (bytes: Uint8Array) => Uint8Array | null,
  mutate?: (o: LayerNode["obj"]) => void,
): Promise<boolean> {
  const d = doc;
  const node = d && findNode(d.roots, layerId);
  const assets = overlay;
  if (!d || !node || !assets || !node.modelForm) return false;
  const o = node.obj;
  const warn = (key: string, path: string) => (log(et(`${fail}.${key}`, { path }), "warn"), false);
  let modelJson: Record<string, unknown> | null = null;
  let from: string;
  let mdlPath: string;
  if (node.modelForm === "puppet") {
    from = String(o.image);
    modelJson = parseJsonBytes(await assets.read(from));
    if (!modelJson || typeof modelJson.puppet !== "string") return warn("fail.read", from);
    mdlPath = modelJson.puppet;
  } else {
    from = mdlPath = String(o.model);
  }
  const bytes = await assets.read(mdlPath);
  if (!bytes) return warn("fail.read", mdlPath);
  const out = edit(bytes);
  const listed = new Set(assets.list());
  const slug = imageSlug(`${String(o.name || "model").replace(/\./g, "-")}-${slugTag}`, (s) => [modelPathOf(s), editorMdlOf(s)].some((p) => assets.has(p) || listed.has(p)));
  const r = out && mdlCopyFiles(modelJson, out, slug);
  if (!r) return warn("fail.mdl", mdlPath);
  if (d !== doc) return false;
  for (const f of r.files) assets.put(f.name, f.data, r.path);
  assets.share(from, r.path);
  const puppetMdl = modelJson ? editorMdlOf(slug) : null;
  if (puppetMdl) d.puppets = new Map([...(d.puppets ?? []), [r.path, puppetMdl]]);
  structEdit(label, (dd) => {
    const n = findNode(dd.roots, layerId);
    if (!n) return undefined;
    if (puppetMdl) n.obj.image = r.path;
    else n.obj.model = r.path;
    mutate?.(n.obj);
    return n.id;
  });
  return true;
}

function applyBoneEdit(layerId: number | string, e: BoneEdit, boneName: string, clipName: string) {
  if (bonePick && same(bonePick.layer, layerId)) bonePick = { ...bonePick, frame: e.frame, t: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] };
  return commitMdlEdit(layerId, et("log.boneEdited", { layer: nodeName(layerId), bone: boneName, clip: clipName, frame: e.frame }), "pose", "bn", (bytes) =>
    applyBoneDelta(bytes, e.animId, e.bone, e.frame, e.delta, e.radius),
  );
}

/**
 * 动画片段（W18b）：每个片段一项（名字 / 模式 / fps / 帧数 / 帧事件，复制 / 删除），底部「新建片段」（静止姿势）。
 * 每次修改都是写时复制 .mdl + 结构编辑；删片段同一步删掉指向它的动画层
 */
function clipsGroup(node: LayerNode): HTMLElement | null {
  const id = Number(node.id);
  const info = editor && Number.isFinite(id) ? editor.getModelInfo(id) : null;
  if (!info || !info.animations.length) return null;
  const group = document.createElement("div");
  group.className = "ed-insp-group ed-fx ed-clips";
  const h = document.createElement("div");
  h.className = "ed-insp-title";
  h.textContent = et("insp.clips");
  group.appendChild(h);
  group.appendChild(note(et("cl.note")));
  const editable = !!overlay && !isLocked(node.id);
  const clips = info.animations;
  const layerName = nodeName(node.id);
  const metaEdit = (c: (typeof clips)[number], field: string, meta: Partial<MdlClipInit>) =>
    void commitMdlEdit(node.id, et("log.clipEdited", { layer: layerName, clip: c.name || `#${c.id}`, field: et(field) }), "clip", "cl", (b) =>
      setMdlClipMeta(b, c.id, meta),
    );
  clips.forEach((c, ci) => {
    const label = c.name || `#${c.id}`;
    const item = document.createElement("div");
    item.className = "ed-fx-item";
    item.dataset.clipId = String(c.id);
    const head = document.createElement("div");
    head.className = "ed-fx-head";
    const name = document.createElement("input");
    name.type = "text";
    name.className = "ed-fx-name ed-cl-name";
    name.value = c.name;
    name.maxLength = 64;
    name.disabled = !editable;
    name.addEventListener("change", () => {
      const v = name.value.trim();
      if (!v || v === c.name) return void (name.value = c.name);
      metaEdit(c, "cl.name", { name: v });
    });
    const icon = (cls: string, text: string, title: string, onClick: () => void, disabled = false) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `ed-icon ${cls}`;
      b.textContent = text;
      b.title = title;
      b.disabled = !editable || disabled;
      b.onclick = onClick;
      return b;
    };
    head.append(
      name,
      icon("ed-cl-dup", "⧉", et("cl.dup"), () => {
        const init = { name: nextClipName(clips, `${c.name || "clip"} copy`.slice(0, 64)), mode: c.mode, fps: c.fps, frameCount: c.frameCount };
        void commitMdlEdit(node.id, et("log.clipAdded", { layer: layerName, clip: init.name }), "clip", "cl", (b) => addMdlClip(b, init, "copy", c.id)?.bytes ?? null);
      }),
      icon("ed-cl-del", "✕", ci === 0 ? et("cl.delFirst") : et("fx.del"), () => {
        void commitMdlEdit(node.id, et("log.clipRemoved", { layer: layerName, clip: label }), "clip", "cl", (b) => removeMdlClip(b, c.id), (o) => {
          dropAnimLayersOfClip(o, c.id);
        });
      }, ci === 0),
    );
    item.appendChild(head);
    const form = document.createElement("div");
    form.className = "ed-fx-params";
    const row = (key: string, el: HTMLElement) => {
      const l = document.createElement("label");
      l.textContent = et(key);
      const box = document.createElement("div");
      box.className = "ed-fx-param";
      box.appendChild(el);
      form.append(l, box);
    };
    const mode = document.createElement("select");
    mode.className = "ed-cl-mode";
    for (const m of CLIP_MODES) {
      const o = document.createElement("option");
      o.value = m;
      o.textContent = et(`cl.mode.${m}`);
      mode.appendChild(o);
    }
    if (!(CLIP_MODES as readonly string[]).includes(c.mode)) {
      const o = document.createElement("option");
      o.value = c.mode;
      o.textContent = c.mode;
      mode.appendChild(o);
    }
    mode.value = c.mode;
    mode.disabled = !editable;
    mode.addEventListener("change", () => metaEdit(c, "cl.mode", { mode: mode.value }));
    row("cl.mode", mode);
    const num = (cls: string, value: number, step: string, min: string, onChange: (v: number) => void) => {
      const inp = document.createElement("input");
      inp.type = "number";
      inp.className = cls;
      inp.step = step;
      inp.min = min;
      inp.value = fmtNum(value);
      inp.disabled = !editable;
      inp.addEventListener("change", () => {
        const v = Number(inp.value);
        if (!Number.isFinite(v) || v === value) return void (inp.value = fmtNum(value));
        onChange(v);
      });
      return inp;
    };
    row("cl.fps", num("ed-cl-fps", c.fps, "1", "1", (v) => metaEdit(c, "cl.fps", { fps: v })));
    row("cl.frames", num("ed-cl-frames", c.frameCount, "1", "1", (v) => metaEdit(c, "cl.frames", { frameCount: Math.round(v) })));
    const ev = document.createElement("textarea");
    ev.className = "ed-cl-events";
    ev.rows = Math.min(6, Math.max(2, c.events.length + 1));
    ev.placeholder = et("cl.eventsHint");
    ev.value = formatEventsText(c.events);
    ev.disabled = !editable;
    ev.addEventListener("change", () => {
      const list = parseEventsText(ev.value);
      if (!list) {
        log(et("cl.fail.events"), "warn");
        ev.value = formatEventsText(c.events);
        return;
      }
      if (formatEventsText(list) === formatEventsText(c.events)) return;
      void commitMdlEdit(node.id, et("log.clipEdited", { layer: layerName, clip: label, field: et("cl.events") }), "clip", "cl", (b) => setMdlClipEvents(b, c.id, list));
    });
    row("cl.events", ev);
    item.appendChild(form);
    group.appendChild(item);
  });
  const add = document.createElement("button");
  add.type = "button";
  add.className = "ed-btn ed-cl-add";
  add.textContent = et("cl.add");
  add.disabled = !editable;
  add.onclick = () => {
    const c0 = clips[0];
    const init = { name: nextClipName(clips, et("cl.defaultName")), mode: "loop", fps: c0.fps, frameCount: c0.frameCount };
    void commitMdlEdit(node.id, et("log.clipAdded", { layer: layerName, clip: init.name }), "clip", "cl", (b) => addMdlClip(b, init, "rest", c0.id)?.bytes ?? null);
  };
  group.appendChild(add);
  return group;
}

const flatNodes = (roots: LayerNode[]): LayerNode[] => roots.flatMap((n) => [n, ...flatNodes(n.children)]);

/** 「挂到模型」（W14）：选模型层 + 附着点 → 绑定；已挂时可解绑。都是结构编辑（重挂），当前时刻画面不变 */
function attachGroup(node: LayerNode): HTMLElement | null {
  if (!doc || !editor) return null;
  const subtree = new Set(flatNodes([node]).map((n) => String(n.id)));
  const models = flatNodes(doc.roots)
    .filter((n) => n.modelForm && !subtree.has(String(n.id)))
    .map((n) => ({ node: n, points: editor!.getAttachmentPoints(Number(n.id)) ?? [] }))
    .filter((m) => m.points.length);
  const cur = attachmentOf(node.obj);
  if (!models.length && !cur) return null;
  const group = document.createElement("div");
  group.className = "ed-insp-group ed-attach";
  const h = document.createElement("div");
  h.className = "ed-insp-title";
  h.textContent = et("insp.attach");
  group.appendChild(h);
  const editable = !!overlay && !isLocked(node.id);
  const parentId = node.obj.parent;
  if (cur) group.appendChild(note(et("att.current", { model: nodeName(parentId as number | string), name: cur })));
  if (!attachPick || attachPick.layer !== node.id || !models.some((m) => same(m.node.id, attachPick!.model))) {
    const m0 = models.find((m) => same(m.node.id, parentId)) ?? models[0];
    attachPick = m0 ? { layer: node.id, model: m0.node.id, name: cur && same(m0.node.id, parentId) ? cur : m0.points[0].name } : null;
  }
  const pick = attachPick;
  const form = document.createElement("div");
  form.className = "ed-fx-params";
  const row = (key: string, el: HTMLElement) => {
    const l = document.createElement("label");
    l.textContent = et(key);
    form.append(l, el);
  };
  if (pick) {
    const modelSel = document.createElement("select");
    modelSel.className = "ed-att-model";
    modelSel.disabled = !editable;
    for (const m of models) {
      const o = document.createElement("option");
      o.value = String(m.node.id);
      o.textContent = `${m.node.name || `#${m.node.id}`} (${m.points.length})`;
      modelSel.appendChild(o);
    }
    modelSel.value = String(pick.model);
    modelSel.addEventListener("change", () => {
      const m = models.find((x) => String(x.node.id) === modelSel.value);
      if (m) attachPick = { layer: node.id, model: m.node.id, name: m.points[0].name };
      renderInspector();
    });
    row("att.model", modelSel);
    const ptSel = document.createElement("select");
    ptSel.className = "ed-att-point";
    ptSel.disabled = !editable;
    for (const p of models.find((m) => same(m.node.id, pick.model))?.points ?? []) {
      const o = document.createElement("option");
      o.value = p.name;
      o.textContent = p.name;
      ptSel.appendChild(o);
    }
    ptSel.value = pick.name;
    ptSel.addEventListener("change", () => {
      attachPick = { ...pick, name: ptSel.value };
    });
    row("att.point", ptSel);
  }
  group.appendChild(form);
  const btns = document.createElement("div");
  btns.className = "ed-att-btns";
  const mk = (cls: string, key: string, onClick: () => void, disabled: boolean) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `ed-btn ${cls}`;
    b.textContent = et(key);
    b.disabled = !editable || disabled;
    b.onclick = onClick;
    btns.appendChild(b);
  };
  const report = (r: AttachResult) => {
    if (r !== "ok" && r !== "noop") log(et(`att.fail.${r}`), "warn");
    return r === "ok";
  };
  mk("ed-att-bind", "att.bind", () => {
    const p = attachPick;
    if (!p) return;
    structEdit(et("log.attached", { layer: nodeName(node.id), model: nodeName(p.model), name: p.name }), (d) =>
      report(attachToModel(d, node.id, p.model, p.name, attachOffsetOf)) ? node.id : undefined,
    );
  }, !pick);
  mk("ed-att-unbind", "att.unbind", () => {
    structEdit(et("log.detached", { layer: nodeName(node.id) }), (d) => (report(detachFromModel(d, node.id, attachOffsetOf)) ? node.id : undefined));
  }, !cur);
  group.appendChild(btns);
  return group;
}

const same = (a: unknown, b: unknown) => a !== undefined && a !== null && String(a) === String(b);

/** 速率这类会校验失败的字段：返回是否改成，失败时调用方把控件复原 */
function objEditOkAnim(node: LayerNode, field: string, name: string, mutate: (o: LayerNode["obj"]) => boolean): boolean {
  let ok = false;
  animLayerEdit(et("log.animLayerEdited", { layer: nodeName(node.id), name, field: et(field) }), node, (o) => (ok = mutate(o)));
  return ok;
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
  label("f.name");
  const nameInp = document.createElement("input");
  nameInp.type = "text";
  nameInp.className = "span3";
  nameInp.dataset.field = "name";
  nameInp.value = node.name;
  nameInp.placeholder = `#${id}`;
  nameInp.disabled = !canRename(id);
  nameInp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") nameInp.blur();
    else if (e.key === "Escape") {
      nameInp.value = node.name;
      nameInp.blur();
    }
  });
  nameInp.addEventListener("change", () => {
    if (!renameLayer(id, nameInp.value)) nameInp.value = node.name;
  });
  form.appendChild(nameInp);
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

const canHaveEffects = (n: LayerNode) => layerKindInfo(n.kind)?.canHaveEffects === true;

/** 效果名：内置走词典 fx.<id>，插件效果用自带 title */
const fxTitle = (d: EffectDef) => (d.title !== undefined ? textOf(d.title, getLang(), d.id) : hasText(`fx.${d.id}`) ? et(`fx.${d.id}`) : d.id);
const fxLabel = (v: Pick<EffectView, "def" | "name">) => (v.def ? fxTitle(v.def) : v.name);
const fxParamLabel = (p: EffectParam) => (p.label !== undefined ? textOf(p.label, getLang(), p.key) : hasText(`fxp.${p.key}`) ? et(`fxp.${p.key}`) : p.key);

// ---------- 效果库浏览器（M6 A11）：宿主**只读**枚举本机壁纸库的效果目录 ----------
//
// 合规边界（计划 §6 决策 5 = (a)）：库内效果文件**留在库里**，工程只写
// `objects[i].effects[]` 里的一条引用（`file: "effects/<目录名>/effect.json"`）；
// 参数值与 `combos` 内联进 scene.json。**不复制** effect.json / 材质 / 贴图进工程，
// 也不写回库。已知代价：引用库内效果的工程换机打开会缺效果（界面里明说）。
// 打包进 `scene.pkg` 的效果宿主不解包，只在统计里报数。

/** 宿主 `GET /api/fx-library` 的返回形状（见 host/wallpaper-host.ts 的 scanEffectLibrary） */
type FxLibraryEffect = {
  id: string;
  dir: string;
  file: string;
  itemId: string;
  items: string[];
  meta: {
    name?: string | null;
    group?: string | null;
    description?: string | null;
    preview?: string | null;
    editable?: unknown;
    fbos?: unknown[];
  };
  passes: Array<{
    index: number;
    material: string | null;
    target: string | null;
    bind: unknown[];
    shader: string | null;
    combos: PassCombos | null;
    textures: unknown[];
    uniforms: string[];
  }>;
  files: Record<string, string>;
  missing: string[];
  notes: string[];
};
type FxLibraryReport = {
  dir: string;
  readOnly: boolean;
  copy: boolean;
  note: string;
  effects: FxLibraryEffect[];
  errors: string[];
  stats: { items: number; effectDirs: number; packagedSkipped: number; files: number };
};

/** null = 还没问过；"loading"/"error" 是过程态；对象是宿主给的枚举结果 */
let fxLibrary: FxLibraryReport | "loading" | "error" | null = null;
let fxLibraryError = "";
/** 库内文件相对路径 → 文本（只读缓存，供 M1 参数面板解析 uniform 注释）；**不进叠加层** */
const fxLibraryFiles = new Map<string, string>();
/** 浏览器里展开的效果目录名（会话状态，不落盘） */
const fxLibraryOpen = new Set<string>();

/** 按需拉一次枚举（结果常驻；失败给出明确报错，不静默） */
function loadFxLibrary(): void {
  if (fxLibrary !== null) return;
  fxLibrary = "loading";
  const target = doc;
  void fetch("/api/fx-library")
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((data: FxLibraryReport) => {
      fxLibrary = data;
      for (const e of data.effects ?? []) {
        for (const [name, text] of Object.entries(e.files ?? {})) if (!fxLibraryFiles.has(name)) fxLibraryFiles.set(name, text);
      }
    })
    .catch((e: unknown) => {
      fxLibrary = "error";
      fxLibraryError = e instanceof Error ? e.message : String(e);
    })
    .then(() => {
      if (doc === target) renderInspector();
    });
}

/**
 * 把库内效果加进当前图层：只写 scene.json 的引用（`addEffectRef`），参数取 shader
 * 注释声明的缺省值，`combos` 取材质声明的默认档 —— 全程不碰 `overlay`。
 */
function addLibraryEffectTo(n: LayerNode, e: FxLibraryEffect): void {
  const ps = inlinePassesOf(e.file);
  const passCount = Math.max(1, e.passes.length);
  const seeds: EffectPassSeed[] = Array.from({ length: passCount }, (_, i) => {
    const decl = ps?.[i];
    const values: Record<string, unknown> = {};
    for (const p of decl?.params ?? []) values[p.key] = encodeValue(p, p.default as EffectValue);
    const combos = mergedCombos(e.passes[i]?.combos ?? decl?.combos, null);
    return { constantshadervalues: values, combos };
  });
  const label = e.meta.name ?? e.dir;
  const ok = objEditOk(et("log.fxLibAdded", { name: label, layer: nodeName(n.id) }), n.id, (o) => addEffectRef(o, e.file, e.dir, seeds) !== null);
  if (!ok) log(et("log.fxFailed", { name: label, msg: et("fx.libBadFile") }), "error");
}

/** 提交一条 pass 的 combos（编译期分支）：文档侧就地改值进撤销栈，引擎侧复用热更通道补画一帧 */
function commitInlineCombo(
  layerId: string | number,
  view: { effect: number; pass: number; effectName: string },
  key: string,
  next: number,
): void {
  structEdit(
    et("log.fxCombo", { name: view.effectName, param: key }),
    (d) => {
      const n = findNode(d.roots, layerId);
      if (!n) return undefined;
      const ok = next === null ? clearPassCombo(n.obj, view.effect, view.pass, key) : setPassCombo(n.obj, view.effect, view.pass, key, next);
      return ok ? n.id : undefined;
    },
    undefined,
    true,
  );
}

/**
 * `fx` 分组里的「效果库（本机壁纸库）」分区：枚举 + 只读预览（参数 / 贴图槽 / combos）+ 写引用。
 * 来源标注：`data-fx-source` = `project`（当前工程已有这个效果文件）或 `library`（只在库里）。
 */
function fxLibrarySection(node: LayerNode, editable: boolean): HTMLElement {
  const box = document.createElement("div");
  box.className = "ed-fx-lib";
  box.dataset.fxLib = String(node.id);
  const title = document.createElement("div");
  title.className = "ed-insp-title ed-fx-lib-title";
  title.textContent = et("fx.libTitle");
  box.appendChild(title);
  box.appendChild(note(et("fx.libHint")));
  loadFxLibrary();
  if (fxLibrary === null || fxLibrary === "loading") {
    box.appendChild(note(et("fx.libLoading")));
    return box;
  }
  if (fxLibrary === "error") {
    box.appendChild(note(et("fx.libError", { msg: fxLibraryError })));
    return box;
  }
  const list = fxLibrary.effects ?? [];
  // 枚举失败（库目录不存在 / effect.json 坏掉）时明确报错；部分坏掉时既报错也列出好的那些
  if (fxLibrary.errors?.length) box.appendChild(note(et("fx.libError", { msg: fxLibrary.errors.join("；") })));
  if (!list.length) {
    box.appendChild(note(et("fx.libEmpty", { dir: fxLibrary.dir })));
    return box;
  }
  const inProject = referencedEffects(doc);
  const stats = document.createElement("div");
  stats.className = "ed-note ed-fx-lib-stats";
  stats.dataset.fxLibStats = String(list.length);
  stats.textContent =
    et("fx.libStats", { n: String(list.length), items: String(fxLibrary.stats?.items ?? 0) }) +
    (fxLibrary.stats?.packagedSkipped ? ` ${et("fx.libPackaged", { n: String(fxLibrary.stats.packagedSkipped) })}` : "");
  box.appendChild(stats);
  for (const e of list) {
    const det = document.createElement("details");
    det.className = "ed-fx-lib-item";
    det.dataset.fxLibDir = e.dir;
    det.dataset.fxSource = inProject.has(e.file) ? "project" : "library";
    det.open = fxLibraryOpen.has(e.dir);
    det.addEventListener("toggle", () => {
      if (det.open) fxLibraryOpen.add(e.dir);
      else fxLibraryOpen.delete(e.dir);
    });
    const sum = document.createElement("summary");
    sum.className = "ed-fx-lib-head";
    const nm = document.createElement("span");
    nm.className = "ed-fx-lib-name";
    nm.textContent = `${e.meta.name ?? e.dir}（${e.items.join(" / ")}）`;
    nm.title = e.file;
    const badge = document.createElement("span");
    badge.className = "ed-fx-lib-badge";
    badge.dataset.fxLibBadge = inProject.has(e.file) ? "project" : "library";
    badge.textContent = inProject.has(e.file) ? et("fx.libInProject") : et("fx.libLibraryOnly");
    sum.append(nm, badge);
    det.appendChild(sum);
    const body = document.createElement("div");
    body.className = "ed-fx-lib-body";
    if (e.meta.description) {
      const d = document.createElement("div");
      d.className = "ed-note ed-fx-lib-desc";
      d.textContent = String(e.meta.description).split("\n")[0];
      body.appendChild(d);
    }
    // 只读预览：pass → shader / 编译期分支 / 贴图槽；参数表由 M1 的 inspect 路径解析后列出
    loadExternalParams(e.file);
    const decl = inlinePassesOf(e.file);
    const perPass = Math.max(1, e.passes.length);
    for (let i = 0; i < perPass; i++) {
      const p = e.passes[i];
      const row = document.createElement("div");
      row.className = "ed-fx-lib-pass";
      row.dataset.fxLibPass = String(i);
      const head = document.createElement("div");
      head.className = "ed-fx-lib-pass-head";
      head.textContent = `${et("fx.inlinePass")} ${i}：${p?.shader ?? "—"}`;
      row.appendChild(head);
      const declared = { ...(p?.combos ?? decl?.[i]?.combos ?? {}) };
      if (Object.keys(declared).length) {
        const cb = document.createElement("div");
        cb.className = "ed-fx-lib-combos";
        cb.dataset.fxLibCombos = String(i);
        cb.textContent = `${et("fx.libCombos")}：${comboSummary(declared)}`;
        row.appendChild(cb);
      }
      const params = decl?.[i]?.params ?? [];
      if (params.length) {
        const pl = document.createElement("div");
        pl.className = "ed-fx-lib-params";
        pl.textContent = `${et("fx.libParams")}：${params.map((q) => `${q.key}=${JSON.stringify(q.default)}`).join("、")}`;
        row.appendChild(pl);
      } else {
        row.appendChild(note(decl ? et("fx.inlineNoParams") : et("fx.inlineLoading")));
      }
      if (p?.textures?.length) {
        const tx = document.createElement("div");
        tx.className = "ed-fx-lib-textures";
        tx.textContent = `${et("fx.inlineTextures")}：${p.textures.filter((t) => typeof t === "string" && t).join("、") || "—"}`;
        row.appendChild(tx);
      }
      body.appendChild(row);
    }
    if (e.missing?.length) {
      const m = document.createElement("div");
      m.className = "ed-note ed-fx-lib-missing";
      m.textContent = `${et("fx.libMissing")}：${e.missing.join("、")}`;
      body.appendChild(m);
    }
    for (const nt of e.notes ?? []) body.appendChild(note(nt));
    const add = document.createElement("button");
    add.type = "button";
    add.className = "ed-btn ed-fx-lib-add";
    add.dataset.fxLibAdd = e.dir;
    add.textContent = et("fx.libAdd");
    add.disabled = !editable;
    add.onclick = () => addLibraryEffectTo(node, e);
    body.appendChild(add);
    det.appendChild(body);
    box.appendChild(det);
  }
  return box;
}

/** combos 显示成 `KEY=档 （默认 档）` 一行 */
function comboSummary(declared: PassCombos): string {
  return Object.entries(declared)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join("、");
}

/** 外来效果（不在注册表里的 WE 效果）从 shader 的 uniform 注释还原出的参数表；按文件缓存，读完重画检视器 */
const externalParams = new Map<string, EffectParam[] | "loading">();
/**
 * 同一份解析结果的**按 pass 形状**（作品自带效果的折叠面板要用）。
 * 只解析一次：两个缓存由同一次 `inspectEffectPasses` 填。
 */
const externalPasses = new Map<string, InlinePassParams[] | "loading">();
/** effect.json 路径 → 参数表（loading / 空数组都是「已问过」） */
const externalParamsOfCached = (file: string): EffectParam[] | null => {
  const hit = externalParams.get(file);
  return hit === "loading" || hit === undefined ? null : hit;
};
/** 作品自带效果：effect.json 路径 → 每个 pass 的参数表（未读完时 null，读完重画检视器） */
const inlinePassesOf = (file: string): InlinePassParams[] | null => {
  const hit = externalPasses.get(file);
  return hit === "loading" || hit === undefined ? null : hit;
};
/** 按需读一次 effect.json（材质 → shader 注释），结果同时喂给两条展示路径 */
function loadExternalParams(file: string): void {
  if (externalPasses.has(file)) return;
  const assets = overlay;
  // 库内效果（M6）：文件在壁纸库里，用宿主只读枚举时一并带回的文本；
  // 叠加层里没有它、也**绝不**往叠加层写（写进去 = 把库文件复制进工程）。
  const fromLib = fxLibraryFiles.has(file);
  if (!assets && !fromLib) return;
  externalPasses.set(file, "loading");
  const dec = new TextDecoder();
  const target = doc;
  void inspectEffectPasses(file, async (name) => {
    const lib = fxLibraryFiles.get(name);
    if (lib !== undefined) return lib;
    if (!assets) return null;
    const b = await assets.read(name).catch(() => null);
    return b ? dec.decode(b) : null;
  })
    .catch(() => [] as InlinePassParams[])
    .then((ps) => {
      externalPasses.set(file, ps);
      externalParams.set(file, ps.flatMap((x) => x.params));
      if (doc === target) renderInspector();
    });
}
/** 兼容旧调用点：内置效果不在这里，外来效果读完前返回 null（面板显示「读取中」） */
function externalParamsOf(file: string): EffectParam[] | null {
  loadExternalParams(file);
  return externalParamsOfCached(file);
}

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
  let files: ReturnType<typeof effectFiles>;
  try {
    files = effectFiles(d, getLang());
  } catch (e) {
    log(et("log.fxFailed", { name: fxTitle(d), msg: (e as Error).message }), "error");
    return;
  }
  for (const f of files) overlay.put(f.name, f.data, effectFileOf(fxId));
  objEdit(et("log.fxAdded", { name: fxTitle(d), layer: nodeName(n.id) }), n.id, (o) => addEffect(o, fxId) !== null);
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
    // 来源标注：工程里已有的效果条目（区别于「只在库内」的效果浏览器条目，见 fxLibrarySection）
    item.dataset.fxSource = "project";
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
    const params = v.def ? v.def.params : externalParamsOf(v.file);
    if (!params?.length) {
      item.appendChild(note(et("fx.external")));
    } else {
      const values = v.def ? v.values : externalValues(node.obj, v.index, params);
      const commit = (key: string, next: EffectValue) => {
        const p = params.find((x) => x.key === key)!;
        objEdit(et("log.fxParam", { name: label, param: fxParamLabel(p) }), node.id, (o) => setEffectParam(o, v.index, key, next, v.def ? undefined : params));
      };
      item.appendChild(schemaForm({ params, values, label: fxParamLabel, commit, disabled: !editable }));
      if (!v.def) item.appendChild(note(et("fx.externalTunable")));
    }
    // 署名行：改写 / 移植自他人作品的效果（如 cuiliuti）显示「作者：…」+ 出处说明
    if (v.def?.author || v.def?.note) {
      const credit = document.createElement("div");
      credit.className = "ed-fx-credit";
      credit.dataset.fxCredit = v.def.id;
      if (v.def.author) {
        const by = document.createElement("p");
        by.className = "ed-note ed-fx-author";
        by.textContent = `${et("fx.author")}${textOf(v.def.author, getLang(), "")}`;
        credit.appendChild(by);
      }
      const nd = effectNote(v.def, getLang());
      if (nd) {
        const p = document.createElement("p");
        p.className = "ed-note";
        p.textContent = nd;
        credit.appendChild(p);
      }
      item.appendChild(credit);
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
  const cats = new Map<string, HTMLElement>();
  for (const d of effectCatalog.list()) {
    const o = document.createElement("option");
    o.value = d.id;
    o.textContent = fxTitle(d);
    let parent: HTMLElement = add;
    if (d.category) {
      let g = cats.get(d.category);
      if (!g) {
        g = document.createElement("optgroup");
        (g as HTMLOptGroupElement).label = hasText(`fxcat.${d.category}`) ? et(`fxcat.${d.category}`) : d.category;
        cats.set(d.category, g);
        add.appendChild(g);
      }
      parent = g;
    }
    parent.appendChild(o);
  }
  add.addEventListener("change", () => {
    if (add.value) addEffectTo(node, add.value);
  });
  group.appendChild(add);
  group.appendChild(fxLibrarySection(node, editable));
  group.appendChild(inlineFxSection(node, editable));
  return group;
}

// ---------- 作品自带效果（M1 A1/A2）：按 effect / pass 折叠的内联参数编辑 ----------

/**
 * 折叠面板的展开状态。检视器每次重画都会重建 DOM，不记下来就会「改一个值面板自己收起来」。
 * 键 = 图层 id + effect 下标 + pass 下标；不落盘（与选中态同类，属会话状态）。
 */
const inlineFxOpen = new Set<string>();
const inlineFxKey = (id: number | string, effect: number, pass: number) => `${id}:${effect}:${pass}`;

/**
 * 提交一个作品自带效果参数：文档侧就地改值（进撤销栈），引擎侧走**热更**。
 *
 * `hotAlways = true` 是关键：`structEdit` 只在 `cmd.after === cmd.before` 时才默认走热路径，
 * 而这里改的是 `objects` 数组内的值，序列化必然变 —— 不传 `hotAlways` 就会掉进
 * `restoreObjects` 的整场景重挂（数秒）。引擎侧只需要改那份 `constantshadervalues`：
 * 它是以**引用**进到绘制侧的（见 `renderer/vendor/we-scene/render/renderer.js` 的常量绑定段
 * 与 `setEffectConstantsImpl` 的注释），每帧现读，改完补画一帧即可。
 */
function commitInlineParam(
  layerId: string | number,
  view: { effect: number; pass: number; file: string; effectName: string; params: readonly EffectParam[] },
  param: EffectParam,
  next: EffectValue,
): void {
  const logLabel = et("log.fxParam", { name: view.effectName, param: fxParamLabel(param) });
  // 文档与引擎用同一份编码值（`setInlineParam` 内部也走 `encodeValue`，这里复用同一函数保证一致）
  const raw = encodeValue(param, next) as unknown;
  structEdit(
    logLabel,
    (d) => {
      const n = findNode(d.roots, layerId);
      if (!n) return undefined;
      return setInlineParam(n.obj, view.effect, view.pass, param.key, next, view.params) ? n.id : undefined;
    },
    () => {
      // 引擎侧改的通常就是文档里那份常量对象（同一引用），这里再写一次是为了补画一帧，
      // 顺带对「挂载时做过拷贝」的实现保持正确。
      void editor?.setEffectConstants(Number(layerId), view.effect, view.pass, { [param.key]: raw }).catch(() => {});
    },
    true,
  );
}

/**
 * `fx` 分组末尾的「作品自带效果」分区：列出 `obj.effects[i].passes[j]`，
 * 把 effect.json 参数表（uniform 注释）渲染成可编辑表单。
 *
 * 数据源与写回都在 `editor/effects.ts`（`inlinePassViews` / `setInlineParam`），
 * 这里只负责 DOM 与提交时机：`change` 提交（拖动中不反复写），值走 A2 的热更通道。
 */
function inlineFxSection(node: LayerNode, editable: boolean): HTMLElement {
  const box = document.createElement("div");
  box.className = "ed-inline-fx";
  box.dataset.fxInline = String(node.id);
  const title = document.createElement("div");
  title.className = "ed-insp-title ed-inline-fx-title";
  title.textContent = et("fx.inlineTitle");
  box.appendChild(title);

  const files: string[] = [...new Set(effectViews(node.obj).map((v) => v.file).filter(Boolean))];
  if (!files.length) return box;
  for (const f of files) loadExternalParams(f);
  const decls = new Map<string, readonly EffectParam[]>();
  // combos 的**声明档**：材质 json 的 `passes[i].combos`（库内效果作者选的档）；
  // 面板显示「实际生效 = 声明 ← scene.json 覆盖」，并让能开关的档写进工程。
  const comboDecls = new Map<string, readonly PassCombos[]>();
  for (const f of files) {
    const ps = inlinePassesOf(f);
    if (ps) {
      decls.set(f, ps.flatMap((x) => x.params));
      comboDecls.set(f, ps.map((x) => x.combos ?? {}));
    }
  }
  const views = inlinePassViews(node.obj, decls, comboDecls);
  if (!views.length) return box;
  if (!decls.size) {
    box.appendChild(note(et("fx.inlineLoading")));
    return box;
  }
  box.appendChild(note(et("fx.inlineHint")));
  for (const v of views) {
    const key = inlineFxKey(node.id, v.effect, v.pass);
    const det = document.createElement("details");
    det.className = "ed-inline-pass";
    det.dataset.fxInlineEffect = String(v.effect);
    det.dataset.fxInlinePass = String(v.pass);
    det.open = inlineFxOpen.has(key);
    det.addEventListener("toggle", () => {
      if (det.open) inlineFxOpen.add(key);
      else inlineFxOpen.delete(key);
    });
    const sum = document.createElement("summary");
    sum.className = "ed-inline-pass-head";
    sum.textContent = `${v.effectName} · ${et("fx.inlinePass")} ${v.pass}`;
    sum.title = v.file;
    det.appendChild(sum);
    const body = document.createElement("div");
    body.className = "ed-inline-pass-body";
    if (v.params.length) {
      body.appendChild(
        schemaForm({
          params: v.params,
          values: v.values,
          label: fxParamLabel,
          disabled: !editable,
          commit: (k, next) => {
            const p = v.params.find((x) => x.key === k)!;
            commitInlineParam(node.id, v, p, next);
          },
        }),
      );
    } else {
      body.appendChild(note(et("fx.inlineNoParams")));
    }
    // 已有常量键里本库认不出的（作者手写 / 别的效果留下的）：只读列出，绝不删
    const known = new Set(v.params.map((p) => p.key.toLowerCase()));
    const unknown = v.keys.filter((k) => !known.has(k.toLowerCase()));
    if (unknown.length) {
      const ro = document.createElement("div");
      ro.className = "ed-inline-unknown";
      ro.textContent = `${et("fx.inlineUnknown")}：${unknown.join("、")}`;
      body.appendChild(ro);
    }
    if (v.textures.length) {
      const tx = document.createElement("div");
      tx.className = "ed-inline-textures";
      tx.textContent = `${et("fx.inlineTextures")}：${v.textures.filter((t) => typeof t === "string" && t).join("、") || "—"}`;
      body.appendChild(tx);
    }
    // pass 级 combos（编译期分支）：能开关的档写成 0/1 复选框，进工程并往返保留
    const comboKeys = [...new Set([...Object.keys(v.combosDeclared), ...Object.keys(v.combos)])].sort();
    if (comboKeys.length) {
      const row = document.createElement("div");
      row.className = "ed-inline-combos";
      row.dataset.fxInlineCombos = String(v.pass);
      row.title = et("fx.libComboHint");
      const lbl = document.createElement("span");
      lbl.className = "ed-inline-combos-label";
      lbl.textContent = `${et("fx.libCombos")}：`;
      row.appendChild(lbl);
      const merged = mergedCombos(v.combosDeclared, v.combos);
      for (const k of comboKeys) {
        const val = merged[k];
        const wrap = document.createElement("label");
        wrap.className = "ed-inline-combo";
        wrap.dataset.comboKey = k;
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = val !== 0 && val !== "0";
        cb.disabled = !editable;
        cb.title = et("fx.libComboHint");
        cb.onchange = () => commitInlineCombo(node.id, v, k, cb.checked ? 1 : 0);
        const txt = document.createElement("span");
        txt.textContent = `${k}=${String(val)}`;
        wrap.append(cb, txt);
        row.appendChild(wrap);
      }
      body.appendChild(row);
    }
    det.appendChild(body);
    box.appendChild(det);
  }
  return box;
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

/**
 * 试听：页面自己的 audio 元素。
 * 引擎在编辑器里按音量滑杆挂载（默认 0 = 静音），试听这条不走引擎的声音层；但会给元素
 * 挂一个 AnalyserNode 当引擎的音频源 —— 于是「试听时频谱条跟着动」，
 * 不用开系统音频也能在编辑器里看音频反应层。
 */
let preview: { path: string; au: HTMLAudioElement; url: string } | null = null;
let previewAudio: ElementAudioSource | null = null;
function stopPreview() {
  if (!preview) return;
  preview.au.pause();
  URL.revokeObjectURL(preview.url);
  preview = null;
  previewAudio?.dispose();
  previewAudio = null;
  renderSettings.setPreviewAudio(null);
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
  previewAudio?.dispose();
  previewAudio = createElementAudioSource(au);
  renderSettings.setPreviewAudio(previewAudio);
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
  // 脚本报错时，即使不在那一页也在标签上亮个点
  for (const tab of inspectorEl.querySelectorAll<HTMLElement>(".ed-insp-tab")) {
    const panel = inspectorEl.querySelector(`.ed-insp-panel[data-tab="${tab.dataset.tab}"]`);
    tab.classList.toggle("has-alert", !!panel?.querySelector(".ed-script-issues:not([hidden])"));
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
  if (animSolo && animSolo.id !== selectedId) endAnimSolo();
  inspectorEl.textContent = "";
  renderKeyMarks();
  if (!doc) {
    inspectorEl.appendChild(note(et("insp.none")));
    return;
  }
  const node = selectedId !== null ? findNode(doc.roots, selectedId) : null;
  if (!node) {
    dropBonePick();
    const p = doc.project;
    const res = sceneResolution(doc.scene);
    const props = (p?.general as Record<string, unknown> | undefined)?.properties;
    const card = kvGroup(et("insp.project"), [
      ["f.title", typeof p?.title === "string" ? p.title : doc.title],
      ["f.type", doc.type],
      ["f.file", p?.file],
      ["f.form", doc.form ? et(`form.${doc.form}`) : "—"],
      ["f.resolution", res ? `${res.w} × ${res.h}` : "—"],
      ["f.props", props && typeof props === "object" ? String(Object.keys(props).length) : "0"],
    ]);
    // 工程名可改：壁纸库条目名的来源是 project.json 的 title，所以按钮改的是它
    const renameBtn = document.createElement("button");
    renameBtn.type = "button";
    renameBtn.id = "proj-rename";
    renameBtn.className = "ed-btn";
    renameBtn.dataset.et = "proj.rename";
    renameBtn.textContent = et("proj.rename");
    renameBtn.addEventListener("click", () => beginRenameProject());
    card.appendChild(renameBtn);
    // 浏览器存储里的工程可以整份落到本机文件夹（此后自动保存跟着走）；已经绑真目录就不显示
    if (projectDir && virtualIdOf(projectDir) && canPickDirectory()) {
      const localBtn = document.createElement("button");
      localBtn.type = "button";
      localBtn.id = "proj-save-local";
      localBtn.className = "ed-btn";
      localBtn.dataset.et = "proj.saveLocal";
      localBtn.textContent = et("proj.saveLocal");
      localBtn.addEventListener("click", () => void saveProjectToLocalDir());
      card.appendChild(localBtn);
    }
    inspectorEl.appendChild(card);
    if (doc.type === "scene") {
      inspectorEl.appendChild(userPropsGroup());
      inspectorEl.appendChild(note(et("insp.none")));
    }
    if (doc.video) inspectorEl.appendChild(videoProjectGroup());
    return;
  }
  // 分组来自 inspector / puppet.tools 注册表（内置分组由 builtin-inspector 插件登记，插件分组按 order 插在中间），
  // 再按 tab 归到各标签页；非当前页只是 hidden，分组照常渲染（骨骼预览等副作用不随切页变化）
  const panels = new Map<string, HTMLElement>();
  const panelOf = (tab: string) => {
    let p = panels.get(tab);
    if (!p) {
      p = document.createElement("div");
      p.className = "ed-insp-panel";
      p.dataset.tab = tab;
      p.setAttribute("role", "tabpanel");
      panels.set(tab, p);
    }
    return p;
  };
  let bonesShown = false;
  for (const g of groupsFor(node)) {
    let el: HTMLElement | null = null;
    try {
      el = g.render(node);
    } catch (e) {
      reportPluginError(inspectorGroups.ownerOf(g.id) ?? puppetTools.ownerOf(g.id) ?? g.id, e, `inspector/${g.id}`);
    }
    if (!el) continue;
    el.dataset.group = g.id;
    panelOf(tabOf(g)).appendChild(el);
    if (g.id === "bones") bonesShown = true;
  }
  if (!bonesShown) dropBonePick();
  const info = panelOf(INFO_INSPECTOR_TAB);
  const o = node.obj;
  const effects = Array.isArray(o.effects)
    ? (o.effects as Array<Record<string, unknown>>)
        .map((e) => String(e?.name || e?.file || "?"))
        .join("\n")
    : "";
  const source = o.image ?? o.model ?? o.particle ?? (o.text !== undefined ? unwrap(o.text) : undefined);
  const color = colorCss(o.color);
  info.appendChild(
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
  info.appendChild(note(et("insp.readonly")));
  info.appendChild(rawGroup(o));
  mountInspectorTabs(panels);
}

const uiPrefs = createSettings("webwallgl-editor.ui.");
/** 用户上次选的检视器标签；当前图层没有这一页时临时落到第一页，不覆盖偏好 */
let inspTab = uiPrefs.get<string>("inspectorTab", DEFAULT_INSPECTOR_TAB);

function inspectorTabDef(id: string): InspectorTab {
  return inspectorTabs.get(id) ?? { id, order: 9000, title: id };
}

function mountInspectorTabs(panels: Map<string, HTMLElement>) {
  const tabs = [...panels.keys()].map(inspectorTabDef).sort((a, b) => a.order - b.order);
  const active = panels.has(inspTab) ? inspTab : tabs[0].id;
  const bar = document.createElement("div");
  bar.className = "ed-insp-tabs";
  bar.setAttribute("role", "tablist");
  bar.setAttribute("aria-label", et("sec.inspector"));
  const buttons: HTMLButtonElement[] = [];
  const show = (id: string, focus = false) => {
    for (const b of buttons) {
      const on = b.dataset.tab === id;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    }
    for (const [tab, p] of panels) p.hidden = tab !== id;
  };
  for (const t of tabs) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ed-insp-tab";
    b.dataset.tab = t.id;
    b.id = `insp-tab-${t.id}`;
    b.setAttribute("role", "tab");
    b.setAttribute("aria-controls", `insp-panel-${t.id}`);
    if (typeof t.title === "string" && hasText(t.title)) b.dataset.et = t.title;
    b.textContent = typeof t.title === "string" && hasText(t.title) ? et(t.title) : textOf(t.title, getLang(), t.id);
    b.addEventListener("click", () => {
      inspTab = t.id;
      uiPrefs.set("inspectorTab", t.id);
      show(t.id);
    });
    buttons.push(b);
    bar.appendChild(b);
  }
  bar.addEventListener("keydown", (e) => {
    const i = buttons.findIndex((b) => b.classList.contains("active"));
    const n = buttons.length;
    const next = e.key === "ArrowRight" ? (i + 1) % n : e.key === "ArrowLeft" ? (i - 1 + n) % n : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    inspTab = buttons[next].dataset.tab!;
    uiPrefs.set("inspectorTab", inspTab);
    show(inspTab, true);
  });
  inspectorEl.appendChild(bar);
  for (const t of tabs) {
    const p = panels.get(t.id)!;
    p.id = `insp-panel-${t.id}`;
    p.setAttribute("aria-labelledby", `insp-tab-${t.id}`);
    inspectorEl.appendChild(p);
  }
  show(active);
}

// ---------- 插件宿主（PLUGIN-ARCHITECTURE §2）：main.ts 的闭包包成服务，内置分组 / 命令 / 导出目标登记成插件 ----------

/** 内置检视器分组（顺序 = 旧版硬编码顺序；占 100 的整数倍，插件分组可插在中间） */
const BUILTIN_INSPECTOR: InspectorGroup[] = [
  { id: "multi", order: 100, when: () => extraSel.size > 0, render: () => multiGroup(), tab: "props" },
  { id: "edit", order: 200, when: () => true, render: editGroup, tab: "props" },
  { id: "anim", order: 300, when: canAnimate, render: animGroup, tab: "anim" },
  { id: "text", order: 400, when: (n) => n.kind === "text", render: textGroup, tab: "props" },
  { id: "particle", order: 500, when: (n) => n.kind === "particle", render: particleGroup, tab: "props" },
  { id: "sound", order: 600, when: (n) => n.kind === "sound", render: soundGroup, tab: "props" },
  { id: "attach", order: 1200, when: () => true, render: attachGroup, tab: "props" },
  { id: "video", order: 1300, when: isVideoNode, render: videoInfoGroup, tab: "props" },
  { id: "effects", order: 1400, when: canHaveEffects, render: effectsGroup, tab: "fx" },
  { id: "bindings", order: 1500, when: () => true, render: bindingsGroup, tab: "logic" },
  { id: "scripts", order: 1600, when: () => true, render: scriptsGroup, tab: "logic" },
];

/** 模型层专属分组（木偶工具） */
const BUILTIN_PUPPET_TOOLS: PuppetTool[] = [
  { id: "model", order: 700, when: () => true, render: modelGroup, tab: "model" },
  { id: "anim-layers", order: 800, when: () => true, render: animLayersGroup, tab: "anim" },
  { id: "clips", order: 900, when: () => true, render: clipsGroup, tab: "anim" },
  { id: "model-tex", order: 1000, when: () => true, render: modelTexGroup, tab: "model" },
  { id: "bones", order: 1100, when: () => true, render: boneGroup, tab: "model" },
];

const VIDEO_EXPORTER: Exporter = {
  id: "video",
  title: "export.video",
  order: 40,
  accepts: "scene",
  enabled: () => !!editor,
  action: () => openRecMenu(),
};

let app: EditorApp | null = null;

function reportPluginError(name: string, e: unknown, where = "callback") {
  log(et("log.pluginError", { name, where, msg: (e as Error)?.message ?? String(e) }), "error");
}

/** 工程用到的外部插件（导出时写进 project.json 的 editor.plugins） */
function usedPlugins(): Array<{ id: string; version?: string }> {
  const out = new Map<string, { id: string; version?: string }>();
  for (const s of app?.scopes() ?? []) {
    const m = s.meta.manifest as { id?: string; version?: string } | undefined;
    if (s.status === "active" && m?.id) out.set(m.id, m.version ? { id: m.id, version: m.version } : { id: m.id });
  }
  return [...out.values()];
}

const docService: DocService = {
  current: () => doc,
  selectedId: () => selectedId,
  selection: () => selectedNode(),
  find: (id) => (doc ? findNode(doc.roots, id) : null),
  select: (id) => selectLayer(id),
  isLocked: (id) => isLocked(id),
  editObject(label, id, mutate) {
    return objEditOk(label, id, mutate);
  },
  editStructure(label, mutate) {
    structEdit(label, (d) => mutate(d) ?? undefined);
  },
  refresh() {
    renderTree();
    renderInspector();
  },
  log: (msg, level) => log(msg, level),
};

const builtinUiPlugin = {
  name: "builtin-ui",
  inject: ["inspector", "inspector.tabs", "puppet.tools", "exporters", "commands"],
  apply(ctx: import("./core").Context) {
    for (const t of BUILTIN_INSPECTOR_TABS) ctx.contribute("inspector.tabs", t);
    for (const g of BUILTIN_INSPECTOR) ctx.contribute("inspector", g);
    for (const t of BUILTIN_PUPPET_TOOLS) ctx.contribute("puppet.tools", t);
    ctx.contribute("exporters", VIDEO_EXPORTER);
    const cmds = ctx.get("commands").registry;
    const cmd = (c: Parameters<typeof cmds.add>[0]) => ctx.effect(() => cmds.add(c, ctx.name));
    cmd({ id: "edit.undo", keys: "Mod+Z", run: () => undoRedo("undo") });
    cmd({ id: "edit.redo", keys: ["Mod+Shift+Z", "Mod+Y"], run: () => undoRedo("redo") });
    cmd({ id: "file.save", keys: "Mod+S", run: () => void saveDocument() });
    cmd({ id: "layer.duplicate", keys: "Mod+D", run: () => duplicateSelected() });
    cmd({ id: "layer.rename", keys: "F2", when: () => selectedId !== null, run: (name) => (typeof name === "string" ? renameLayer(selectedId!, name) : beginRename(selectedId!)) });
    cmd({ id: "layer.delete", keys: ["Delete", "Backspace"], when: () => selectedId !== null, run: () => deleteSelected() });
    cmd({ id: "export.run", run: (id) => void runExport(String(id)) });
  },
};

async function bootPlugins() {
  app = await bootEditor(
    {
      doc: docService,
      history: { stack: () => edits, undo: () => undoRedo("undo"), redo: () => undoRedo("redo") },
      assets: {
        overlay: () => overlay,
        put: (name, data, group) => {
          if (!overlay) return false;
          overlay.put(name, data, group ?? name);
          return true;
        },
        read: async (name) => (overlay ? overlay.read(name) : null),
        has: (name) => !!overlay?.has(name),
        list: () => overlay?.list() ?? [],
        unique: (p) => {
          const taken = (x: string) => !!overlay?.has(x) || (overlay?.list() ?? []).includes(x);
          if (!taken(p)) return p;
          const dot = p.lastIndexOf(".");
          const [stem, ext] = dot > p.lastIndexOf("/") ? [p.slice(0, dot), p.slice(dot)] : [p, ""];
          for (let i = 2; ; i++) if (!taken(`${stem}-${i}${ext}`)) return `${stem}-${i}${ext}`;
        },
        addReferenceScanner: (fn) => addReferenceScanner(fn),
        referenced: (d) => referencedGroups(d),
      },
      engine: { controls: () => editor, remount: () => void mountCurrent(true) },
    },
    { onError: (s, e, where) => reportPluginError(s.name, e, where) },
  );
  app.plugin(builtinUiPlugin);
  const ui = app.ui;
  const pluginToolsEl = $<HTMLElement>("#ed-plugin-tools");
  const syncPluginTools = () => (pluginToolsEl.hidden = !ui.items("toolbar").length);
  let unmountTools = ui.mount("toolbar", pluginToolsEl);
  ui.onChange("toolbar", syncPluginTools);
  onChangeLang(() => {
    unmountTools();
    unmountTools = ui.mount("toolbar", pluginToolsEl);
  });
  syncPluginTools();
  await app.root.kernel.settle();
  for (const u of app.load.unresolved) log(et("log.pluginError", { name: u.name, where: "inject", msg: u.missing.join(", ") }), "warn");
  effectCatalog.onChange(() => renderInspector());
  inspectorGroups.onChange(() => renderInspector());
  inspectorTabs.onChange(() => renderInspector());
  puppetTools.onChange(() => renderInspector());
  particleTemplates.onChange(renderParticleMenu);
  puppetGenerators.onChange(renderGeneratorMenu);
  modelImporters.onChange(syncModelAccept);
  exporters.onChange(renderExportMenu);
  onChangeLang(() => {
    renderParticleMenu();
    renderGeneratorMenu();
    renderExportMenu();
  });
  renderParticleMenu();
  renderGeneratorMenu();
  syncModelAccept();
  renderExportMenu();
  renderInspector();
  await startExternalPlugins(app);
}

const EXAMPLE_PLUGIN_FILES = import.meta.glob<string>(["../examples/plugins/*/**", "!../examples/plugins/*/src/**"], { query: "?raw", import: "default" });

/** 外部插件：内置示例 + 已安装（IndexedDB）+ 插件目录（dev 宿主在时），目录来源轮询热重载 */
async function startExternalPlugins(a: EditorApp) {
  await hostProbe;
  const sources = [bundledSource(EXAMPLE_PLUGIN_FILES, "../examples/plugins"), storeSource(a.storage), ...(hostUp ? [dirSource()] : [])];
  const m = createPluginManager({
    root: a.root,
    sources,
    settings: a.settings,
    deps: { importModule: blobImporter, settings: a.settings, storage: a.storage },
  });
  const text = (v: string | Record<string, string> | undefined, fb: string) => textOf(v, getLang(), fb);
  const panel = mountPluginPanel({
    dialog: $<HTMLDialogElement>("#plugins-dlg"),
    list: $("#plugins-list"),
    manager: m,
    t: et,
    text,
    log,
    confirmInstall: (man) => {
      const { low, high } = permissionSummary(man);
      const perms = !low.length && !high.length
        ? et("pl.installNoPerms")
        : [et("pl.installPerms", { list: [...high, ...low].join(", ") }), high.length ? et("pl.installHigh", { list: high.join(", ") }) : ""].filter(Boolean).join("\n");
      return confirm(et("pl.installConfirm", { name: text(man.name, man.id), version: man.version, perms }));
    },
  });
  const inPluginEl = $<HTMLInputElement>("#in-plugin");
  $("#tb-plugins").onclick = () => panel.open();
  $("#plugins-close").onclick = () => $<HTMLDialogElement>("#plugins-dlg").close();
  $("#plugins-docs").onclick = () => {
    $<HTMLDialogElement>("#plugins-dlg").close();
    showDocs("plugins");
  };
  $("#plugins-refresh").onclick = () => void m.refresh().then(panel.render);
  $("#plugins-install").onclick = () => inPluginEl.click();
  inPluginEl.onchange = () => {
    const files = Array.from(inPluginEl.files ?? []);
    inPluginEl.value = "";
    if (files.length) void panel.installFiles(files);
  };
  const desktop = (window as { webwallglDesktop?: { openPluginsDir?: () => Promise<unknown> } }).webwallglDesktop;
  const openDirEl = $<HTMLButtonElement>("#plugins-open-dir");
  if (desktop?.openPluginsDir) {
    openDirEl.hidden = false;
    openDirEl.onclick = () => void desktop.openPluginsDir!();
  }
  onChangeLang(() => panel.render());
  await m.refresh();
  if (hostUp) m.watch();
}

// ---------- 启动 ----------

applyEditorStatic();
layoutStage();
renderTree();
renderInspector();
renderStatus();
syncPlayButton();
syncTimeline();
requestAnimationFrame(tickTimeline);
void bootPlugins().catch((e) => log(et("log.pluginError", { name: "kernel", where: "boot", msg: (e as Error).message }), "error"));
renderDocsView();
docsFromHash();
void (async () => {
  await libraryPanel.load();
  const item = new URL(location.href).searchParams.get("item");
  if (!item) return;
  const it = libraryPanel.find(item);
  if (!it) {
    log(et("log.libItemMissing", { id: item }), "warn");
    return;
  }
  panelTabs.left.select("library");
  await openLibrary(it);
})();
// 内置浏览器里刷新 / 重开后，提示上次的工程还在（有 ?item= 时按库条目走，不提示）
void checkVirtualResume();
