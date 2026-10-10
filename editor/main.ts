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
  type MdlPart,
  type PropertyValue,
  type SceneInstance,
  CLIP_MODES,
  addMdlClip,
  applyBoneDelta,
  clearMdlClips,
  removeMdlClip,
  setMdlClipEvents,
  setMdlClipMeta,
  mdlBoneCount,
  mdlBones,
  mdlMeshIndices,
  mdlMeshInfo,
  mdlMeshPositions,
  mdlSkin,
  setMdlBoneIdx,
  setMdlParts,
  setMdlSkeleton,
  setMdlTopology,
  setMdlWeights,
} from "../renderer/src/api/editor";
import { getLang, onChangeLang, setLang, t, type Lang } from "../bench/i18n";
import { DOC_KINDS, renderDocs, type DocKind } from "../bench/docs";
import { applyPlatformClasses } from "../shared/workbench/platform";
import { initTabs } from "../shared/workbench/tabs";
import { load, save } from "../shared/workbench/storage";
import { libraryKindOf, mountLibraryPanel } from "./ui/library-panel";
import { confirmDialog } from "./ui/confirm";
import { mountWallpaperConfig } from "./ui/wallpaper-config";
import { mountRenderSettings } from "./ui/render-settings";
import { mountSceneSettings } from "./scene-settings";
import { createElementAudioSource, type ElementAudioSource } from "./audio-live";
import { mountPerfPanel } from "./ui/perf-panel";
import { bindThemeButton } from "../shared/workbench/theme";
import { applyEditorStatic, et, hasText } from "./i18n";
import { resetEditorLayout } from "./layout";
import { clampPoint, createPointerStudio } from "./pointer-studio";
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
import { createPluginLog } from "./plugins/log";
import { bundledSource, createPluginManager, dirSource, storeSource } from "./plugins/manager";
import { mountPluginPanel, permissionSummary } from "./ui/plugin-panel";
import { textOf } from "./core";
import { canCreateLayerOfKind, createLayerOfKind, layerKindInfo } from "./layer-kinds";
// 操控变形（Puppet Warp）：钉子 → 骨 + IDW 权重、网格 / .mdl 骨架 / 烘焙纯数学都在 ./warp 里（离线可测）
import {
  MAX_PINS,
  MESH_BASE,
  MESH_MAX,
  MESH_MIN,
  POWER_MAX,
  POWER_MIN,
  WARP_CLIP_ID,
  WARP_CLIP_NAME,
  WARP_FPS,
  WARP_FRAMES,
  addPin,
  boneOfPin,
  buildMesh,
  buildRig,
  buildSkin,
  defaultLayout,
  displace,
  gridFor,
  layoutOf,
  nearestPin,
  pinLocal,
  pinOfBone,
  remapPoses,
  removePin,
  resamplePositions,
  warpFiles,
  withLegacyGrid,
  withGrid,
  withPower,
  type PinDeltas,
  type WarpLayout,
  type WarpMesh,
  type WarpPoses,
  type WarpSize,
} from "./warp";
import {
  COLS_MAX,
  COLS_MIN,
  PADDING_MAX,
  PADDING_MIN,
  SUBDIV_MAX,
  SUBDIV_MIN,
  addSlice,
  axesOf,
  buildGeometry,
  clearTopology,
  defaultGeometry,
  flipCell,
  geometryOf,
  gridOf,
  hasTopology,
  partsOf,
  puppetSub,
  setOffset,
  vertexUvOf,
  withColsRows,
  withLocked,
  withPadding,
  withPartOrder,
  withSubdivision,
  withSlices,
  type GeometrySpec,
} from "./geometry";
import {
  LIMB_PALETTE,
  MAX_LIMBS,
  QUALITY_MAX,
  QUALITY_MIN,
  SMOOTHING_MAX,
  autoLimbs,
  backgroundMaskOf,
  brushStroke,
  defaultSheetSpec,
  groupIndicesByLimb,
  limbLabelMap,
  limbsMeta,
  maskBBox,
  maskCount,
  parseLimbsMeta,
  polygonMask,
  recalculate,
  triangleLimb,
  viewPixels,
  type LimbMask,
  type LimbsMeta,
  type PaintMode,
  type SheetImage,
  type SheetSpec,
  type SheetView,
} from "./limbs";
import {
  BONE_NAME_MAX,
  addBone,
  bonePoints,
  boneSpecs,
  defaultBonesFor,
  defaultSkeleton,
  nearestBone,
  remapIndex,
  removeBone,
  renameBone,
  setBoneParent,
  skeletonOf,
  withSkeleton,
  type SkeletonSpec,
} from "./skeleton";
import {
  BRUSH_RADIUS,
  BRUSH_RADIUS_MAX,
  BRUSH_RADIUS_MIN,
  BRUSH_STRENGTH,
  adjacencyOf,
  blendIslandBoundary,
  dominantBoneOf,
  drawOrderRank,
  islandsOf,
  moveLimbFront,
  reorderPartRange,
  nearestBoneSkin,
  paintVertices,
  remapSkin,
  smoothSkin,
  uniformSkin,
  weightsOf,
  withWeights,
  type WeightSkin,
} from "./weights";
// M4 A5：对象属性直通层（十六个对象级字段的读写 + 规格表驱动表单）
import {
  OBJ_FIELDS,
  objFieldNoteKey,
  objFieldStates,
  objFieldText,
  setObjField,
  setObjFieldText,
  type ObjFieldSpec,
} from "./objprops";
// M4 A6：light / camera 的字段读写（构造器由 layer-kinds 的 create 入口调）
import {
  LIGHT_TYPES,
  getCameraFields,
  getLightFields,
  setCameraField,
  setLightField,
  type CameraField,
  type LightField,
} from "./objlayers";
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
// 命令面板（M9/C4）：只从 commands 注册表枚举，没有第二份手写命令表
import { createCommandPalette, type CommandPalette } from "./ui/command-palette";
// 图层树键盘导航语义（M9/C5）：纯函数，main.ts 只把动作落到 DOM
import { firstFocusable, treeNav, type TreeNavRow } from "./tree-nav";
import type { DocService } from "./services/types";
import { SCRIPT_LIFECYCLES, addableTargets, removeScript, scriptSlots, scriptTemplate, setScript, type ScriptLifecycle } from "./scripts";
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
  parseParticleFile,
  particleComponentViews,
  particleFormParam,
  particleFormValue,
  particleTextValue,
  particleTopExtraKeys,
  particleTopViews,
  serializeParticleFile,
  setParticleField,
  type ParticleBox,
  type ParticleFieldView,
} from "./particle-params";
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
  moveKeyTimeIn,
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
  addContainerLayer,
  hasPassthrough,
  isContainerObject,
  isFullscreenPostObject,
  setPassthrough,
  solidRenders,
} from "./container";
import {
  duplicateLayer,
  ensureSceneGeneral,
  findNode,
  findPath,
  generalSnapshot,
  groupLayer,
  groupLayers,
  isLockedObj,
  makeDoc,
  moveLayer,
  placeLayer,
  rebuildTree,
  removeLayer,
  restoreGeneral,
  sceneResolution,
  setLocked,
  topLevelIds,
  unwrap,
  writeGeneralField,
  writeObjProps,
  type EditorDoc,
  type LayerNode,
  type PlaceResult,
  type PlaceWhere,
  type SceneObject,
  ungroup,
  ungroupAll,
} from "./doc";
import {
  LAYER_CLIP_KEY,
  parseLayerClip,
  pasteLayerClip,
  serializeLayerClip,
  stringifyLayerClip,
  type LayerClip,
} from "./clipboard";
import {
  treeIsolateView,
  treePattern,
  treeSearchHits,
  treeVisible,
  type TreeEntry,
} from "./tree-query";
import { boxFromCorners, marqueeHits, marqueeSelect, rectOf, type MarqueeLayer } from "./marquee";
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
  fileCommand,
  isBatch,
  isFileCmd,
  isNoopEdit,
  isSceneCmd,
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
  collectWebProject,
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
import {
  DRAFT_THROTTLE_MS,
  applyDraft,
  autosaveTargetFor,
  draftSlotFor,
  makeDraft,
  snapshotDue,
  vdirDraftStore,
  type AutosaveTarget,
  type Draft,
  type DraftOrigin,
  type DraftSlotInfo,
} from "./draft";
import { mountVideoStage, videoProjectJson } from "./video-project";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

const docTitleEl = $<HTMLElement>("#ed-doc-title");
const treeEl = $<HTMLElement>("#ed-tree");
const layerCountEl = $<HTMLElement>("#ed-layer-count");
// 树搜索 / 折叠全部 / 隔离（C2）：放在顶部，renderTree 可能在本文件靠前处就被调用
const filterEl = $<HTMLInputElement>("#ed-filter");
const filterClearEl = $<HTMLButtonElement>("#ed-filter-clear");
const treeCollapseEl = $<HTMLButtonElement>("#tree-collapse");
const treeExpandEl = $<HTMLButtonElement>("#tree-expand");
const treeIsolateEl = $<HTMLButtonElement>("#tree-isolate");
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
const tlDockEl = $<HTMLElement>("#tl-dock");
const tlRulerEl = $<HTMLElement>("#tl-ruler");
const tlPlayheadEl = $<HTMLElement>("#tl-playhead");
const tlGripEl = $<HTMLElement>("#tl-grip");
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
// 未保存编辑的草稿横幅（#ed-draft-recover）：与上面那条「重开目录」语义分开（计划 §2 C3）
const draftRecoverEl = $<HTMLElement>("#ed-draft-recover");
const draftRecoverTextEl = $<HTMLElement>("#ed-draft-recover-text");
const draftRecoverRestoreEl = $<HTMLButtonElement>("#draft-recover-restore");
const draftRecoverDiscardEl = $<HTMLButtonElement>("#draft-recover-discard");
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
/** 多选：selectedId 是主选（检视器 / 手柄跟它走），extraSel 是追加选中的其余层 */
const extraSel = new Set<string>();
/** 图层树的无障碍焦点行（C5）：roving tabindex —— 只有这一行 tabindex=0，方向键在行间移动它 */
let treeFocusId: string | null = null;

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
/** 打开来源；null = 还没打开文档。草稿的来源另见 {@link draftOriginFor}（本地文件句柄失效也能从快照恢复） */
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
/**
 * 操控变形（Puppet Warp）会话：引擎里只有 setBonePose 预览，换选中层 / 重挂即失效
 * （没记录进 .mdl 的钉子位移随之丢弃，和骨骼面板的未提交增量一个口径）
 */
let warpSession: WarpSession | null = null;
/** 模型 json 路径 → 钉子布局（null = 不是操控变形木偶）；异步读一次即缓存 */
const warpLayoutCache = new Map<string, WarpLayout | null>();
const warpLoadingPaths = new Set<string>();
/** 路径 → 读取失败重试次数（读失败不能当结论缓存，见 warpLayoutOf） */
const warpLayoutTries = new Map<string, number>();
const WARP_LAYOUT_TRIES = 3;
/** 只有用户点了播放才走时钟；打开文档、重挂都停在当前帧 */
let userPlaying = false;

async function mountCurrent(keepTime = false) {
  if (!current) return;
  mounting = true;
  animSolo = null;
  const gen = ++openGen;
  if (bonePick) bonePick = { ...bonePick, t: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] };
  // 重挂换实例：操控变形的会话与布局缓存一律作废（钉骨属于旧实例）
  warpSession = null;
  warpLayoutCache.clear();
  warpLoadingPaths.clear();
  warpLayoutTries.clear();
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
      // 重挂换了引擎实例，指针 uniform 从 0 开始：停帧摆位 / 回放状态在这里补推一次
      pointerStudio.resync();
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
/** 时间轴刻度 / 动画条 / 播放头共用的横向坐标（renderLanes 时量一次） */
let tlBox = { left: 0, width: 0 };
let tlMax = TL_WINDOW;
let scrubbing = false;
const FRAME = 1 / 60;

/**
 * 时间轴上选中的关键帧（编辑目标）：图层 + 字段（null = 该层全部字段，即层行的「时刻」）+ 时刻（秒）。
 * 选中状态只是为了拖动 / 删除 / 微调时有明确对象，不写进文档。
 */
let tlSel: { layerId: string; field: AnimField | null; t: number } | null = null;
/** 拖动关键帧时播放头跟着手指走（对齐画面用）；null = 用引擎当前时间 */
let tlGhostT: number | null = null;

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
    bindKeyMark(m, n, null, t, tlKeysEl, editable);
    tlKeysEl.appendChild(m);
  }
}

/** 刻度尺 / 动画条 / 播放头共用的横向坐标系（与 #tl-keys 的 inset 0 7px 一致） */
function tlTrackBox(): { left: number; width: number } {
  // 基准取 #tl-dock（它总在布局里）；#tl-lanes 在没有动画层时是 hidden 的，量不到几何
  const host = tlDockEl.getBoundingClientRect();
  const track = tlTrackEl.getBoundingClientRect();
  const left = Math.max(0, track.left - host.left);
  const width = track.width > 0 ? track.width : Math.max(0, host.width - left);
  return { left, width };
}

/** 时间轴刻度尺：秒刻度按窗口自适应（≤12s 每秒、≤60s 每 5s、更宽每 15s） */
function renderRuler(box: { left: number; width: number }, on: boolean) {
  tlRulerEl.textContent = "";
  tlRulerEl.hidden = !on;
  if (!on) return;
  const ticks = document.createElement("div");
  ticks.id = "tl-ruler-ticks";
  // 与 #tl-keys / 播放头同一坐标系：#tl-keys 的 CSS inset 是 0 7px（滑条两端各留半个滑块）
  ticks.style.left = `${box.left + 7}px`;
  ticks.style.width = `${Math.max(0, box.width - 14)}px`;
  const step = tlMax <= 12 ? 1 : tlMax <= 60 ? 5 : 15;
  for (let t = 0; t <= tlMax + 1e-6; t += step) {
    const pct = `${(Math.min(t, tlMax) / tlMax) * 100}%`;
    const tick = document.createElement("i");
    tick.className = `tl-tick${t === 0 ? " major" : ""}`;
    tick.style.left = pct;
    const lab = document.createElement("span");
    lab.className = "tl-tick-label";
    lab.textContent = `${Math.round(t)}s`;
    lab.style.left = pct;
    ticks.append(tick, lab);
  }
  tlRulerEl.appendChild(ticks);
}

/** 播放头竖线：横跨刻度尺与全部动画条，位置与 #tl-keys 的滑块中心一致 */
function renderPlayhead(box: { left: number; width: number }, on: boolean) {
  tlPlayheadEl.hidden = !on;
  if (!on) return;
  tlBox = box;
  paintPlayhead();
}

/** 每帧只改一次 left，不再量布局（tickTimeline 会高频调用） */
function paintPlayhead() {
  const inner = Math.max(0, tlBox.width - 14);
  // 拖动关键帧时跟着手指走（tlGhostT），否则跟引擎时间
  const src = tlGhostT ?? (editor ? editor.time : 0);
  const t = Math.min(tlMax, Math.max(0, src));
  tlPlayheadEl.style.left = `${tlBox.left + 7 + (t / tlMax) * inner}px`;
}

/** 选中层的「按属性分行」：每个开了动画的字段一行，一眼看出是哪条曲线在动 */
function appendPropertyRows(node: LayerNode, left: number, width: number) {
  const editable = !!editor && !!doc?.scene && !!current?.assets && !isLocked(node.id);
  for (const f of ANIM_FIELDS) {
    const view = getAnim(node.obj, f);
    if (!view) continue;
    const len = Math.round((view.length / view.fps) * 1000) / 1000;
    const row = document.createElement("div");
    // 注意：子行**不叫** .tl-lane —— 判据里的 `#tl-lanes .tl-lane` 指的是「每层一行」
    row.className = "tl-subrow";
    row.dataset.field = f;
    const name = document.createElement("span");
    name.className = "tl-lane-name";
    name.textContent = et(ANIM_LABEL[f]);
    name.style.width = `${left}px`;
    const bars = document.createElement("div");
    bars.className = "tl-lane-bars";
    bars.style.left = `${left + 7}px`;
    bars.style.width = `${Math.max(0, width - 14)}px`;
    const pct = (t: number) => `${(Math.min(t, tlMax) / tlMax) * 100}%`;
    const bar = document.createElement("i");
    bar.className = "tl-lane-bar";
    bar.style.width = pct(len);
    bars.appendChild(bar);
    if (view.mode !== "single" && len < tlMax) {
      const rep = document.createElement("i");
      rep.className = "tl-lane-bar is-repeat";
      rep.style.left = pct(len);
      rep.style.width = `${((tlMax - len) / tlMax) * 100}%`;
      bars.appendChild(rep);
    }
    for (const k of view.keys) {
      const t = Math.round((k.frame / view.fps) * 1000) / 1000;
      if (t > tlMax) continue;
      const mark = document.createElement("i");
      mark.className = "tl-lane-key";
      mark.dataset.t = String(t);
      mark.title = `${fmtTime(t)} · ${et(ANIM_LABEL[f])}`;
      mark.style.left = pct(t);
      bindKeyMark(mark, node, f, t, bars, editable);
      bars.appendChild(mark);
    }
    row.title = `${et(ANIM_LABEL[f])} · ${fmtTime(len)} · ${et(`anim.mode.${view.mode}`)}`;
    row.append(name, bars);
    tlLanesEl.appendChild(row);
  }
}

/** 时间轴下方按层动画条：每个有动画的图层一行（首周期实条 + 循环 / 往返的后续周期虚条 + 关键帧），点行选中该层 */
function renderLanes() {
  tlLanesEl.textContent = "";
  tlDockEl.querySelector("#tl-empty")?.remove();
  const rows: Array<{ node: LayerNode; sum: NonNullable<ReturnType<typeof animSummary>> }> = [];
  const walk = (nodes: LayerNode[]) => {
    for (const n of nodes) {
      const sum = canAnimate(n) ? animSummary(n.obj) : null;
      if (sum) rows.push({ node: n, sum });
      walk(n.children);
    }
  };
  if (doc) walk(doc.roots);
  const on = !!doc && !!editor;
  tlDockEl.hidden = !on;
  // 没有动画层时整条轨道区收起：留下「标尺 + 一句说明」，不占一整块空白（也别把说明塞进隐藏的 #tl-lanes 里）
  tlDockEl.classList.toggle("is-empty", rows.length === 0);
  tlLanesEl.hidden = rows.length === 0;
  if (!on) {
    renderRuler({ left: 0, width: 0 }, false);
    renderPlayhead({ left: 0, width: 0 }, false);
    renderSelBar();
    return;
  }
  const box = tlTrackBox();
  renderRuler(box, true);
  renderPlayhead(box, true);
  if (!rows.length) {
    const hint = document.createElement("div");
    hint.id = "tl-empty";
    hint.textContent = et("tl.noLanes");
    tlDockEl.appendChild(hint);
    renderSelBar();
    return;
  }
  const { left, width } = box;
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
      k.title = `${fmtTime(t)} · ${et("tl.allFields")}`;
      k.style.left = pct(t);
      bindKeyMark(k, node, null, t, bars, !!editor && !!doc?.scene && !!current?.assets && !isLocked(node.id));
      bars.appendChild(k);
    }
    row.title = `${nodeName(node.id)} · ${fmtTime(sum.length)} · ${et(`anim.mode.${sum.mode}`)}`;
    row.append(name, bars);
    row.addEventListener("click", () => selectLayer(node.id));
    tlLanesEl.appendChild(row);
    if (isSelected(node.id)) appendPropertyRows(node, left, width);
  }
  renderSelBar();
}

new ResizeObserver(() => renderLanes()).observe(tlTrackEl);

// 时间轴高度：拖动拉手调整（本次会话内记住），双击回到默认
const TL_DOCK_H = 168;
const TL_DOCK_MIN = 96;
const TL_DOCK_MAX = 420;
let tlDockH = TL_DOCK_H;

function setTlDockH(h: number) {
  tlDockH = Math.round(Math.max(TL_DOCK_MIN, Math.min(TL_DOCK_MAX, h)));
  tlDockEl.style.setProperty("--tl-dock-h", `${tlDockH}px`);
  renderLanes();
}

tlGripEl.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  // 没有动画层时这条轨道是收起的（is-empty），拖高度没有意义
  if (tlDockEl.classList.contains("is-empty")) return;
  e.preventDefault();
  tlGripEl.setPointerCapture(e.pointerId);
  const from = tlDockEl.getBoundingClientRect().bottom;
  const base = tlDockH;
  const move = (ev: PointerEvent) => setTlDockH(base + (from - ev.clientY));
  const end = () => {
    tlGripEl.removeEventListener("pointermove", move);
    tlGripEl.removeEventListener("pointerup", end);
    tlGripEl.removeEventListener("pointercancel", end);
  };
  tlGripEl.addEventListener("pointermove", move);
  tlGripEl.addEventListener("pointerup", end);
  tlGripEl.addEventListener("pointercancel", end);
});

tlGripEl.addEventListener("dblclick", () => setTlDockH(TL_DOCK_H));

tlGripEl.addEventListener("keydown", (e) => {
  const step = e.shiftKey ? 40 : 12;
  if (e.key === "ArrowUp") setTlDockH(tlDockH + step);
  else if (e.key === "ArrowDown") setTlDockH(tlDockH - step);
  else return;
  e.preventDefault();
});

/**
 * 关键帧时刻吸附：播放头 → 整秒 → 帧。
 * 顺序不能按「谁近取谁」：帧网格永远在 ±½帧（1/60s）内，整秒就永远抢不到，
 * 所以特殊目标（播放头 / 整秒）只要落进容差就直接吸附，否则退回帧网格。
 */
function snapKeyTime(t: number, fps: number): { t: number; snap: "sec" | "playhead" | null } {
  const TOL = 0.12;
  const ph = editor ? editor.time : 0;
  if (Math.abs(t - ph) <= TOL) return { t: ph, snap: "playhead" };
  const sec = Math.round(t);
  if (Math.abs(t - sec) <= TOL) return { t: sec, snap: "sec" };
  return { t: Math.round(t * fps) / fps, snap: null };
}

/** 拖动吸附的颗粒度用这条动画自己的 fps（文档默认 30） */
function fpsAt(n: LayerNode, field: AnimField | null): number {
  for (const f of field ? [field] : ANIM_FIELDS) {
    const view = getAnim(n.obj, f);
    if (view) return view.fps || 30;
  }
  return 30;
}

function setTlSel(layerId: number | string, field: AnimField | null, t: number, rerender = true) {
  tlSel = { layerId: String(layerId), field, t };
  if (rerender) renderKeyMarks();
  else for (const el of tlDockEl.querySelectorAll(".tl-key.is-selected, .tl-lane-key.is-selected")) el.classList.remove("is-selected");
  renderSelBar();
}

function clearTlSel() {
  if (!tlSel) return;
  tlSel = null;
  for (const el of tlDockEl.querySelectorAll(".tl-key.is-selected, .tl-lane-key.is-selected")) el.classList.remove("is-selected");
  renderSelBar();
}

/** 选中关键帧的操作条（面板内固定一行，不遮动画条）：字段 + 时刻 / 平滑切换 / 删除 */
function ensureSelBar(): HTMLElement {
  const found = tlDockEl.querySelector<HTMLElement>("#tl-selbar");
  if (found) return found;
  const bar = document.createElement("div");
  bar.id = "tl-selbar";
  bar.hidden = true;
  const label = document.createElement("span");
  label.className = "tl-sel-label";
  const smooth = document.createElement("button");
  smooth.type = "button";
  smooth.className = "tl-sel-btn";
  smooth.dataset.act = "smooth";
  const del = document.createElement("button");
  del.type = "button";
  del.className = "tl-sel-btn is-danger";
  del.dataset.act = "delete";
  const hint = document.createElement("span");
  hint.className = "tl-sel-hint";
  hint.textContent = et("tl.keyHint");
  bar.append(label, smooth, del, hint);
  bar.addEventListener("click", (e) => {
    const act = (e.target as HTMLElement).dataset?.act;
    if (act === "smooth") toggleSelSmooth();
    else if (act === "delete") deleteSelKey();
  });
  tlDockEl.appendChild(bar);
  return bar;
}

/** 选中的关键帧还有效吗？（图层还在、字段还开着、那一帧还真的有关键帧） */
function selKeyView(): { node: LayerNode; field: AnimField | null; view: ReturnType<typeof getAnim>; smooth: boolean } | null {
  if (!tlSel || !doc) return null;
  // 图层 id 可能是数字也可能是字符串（dataset 里永远是字符串）→ 用既有的双查
  const node = treeNodeOf(tlSel.layerId);
  if (!node) return null;
  if (!tlSel.field) return { node, field: null, view: null, smooth: false };
  const view = getAnim(node.obj, tlSel.field);
  if (!view) return null;
  const frame = Math.round(tlSel.t * view.fps);
  if (!view.keys.some((x) => Number(x.frame) === frame)) return null;
  // setSmooth 是整条动画两侧手柄的开关，所以这里显示的也是整条动画的平滑态
  return { node, field: tlSel.field, view, smooth: view.smooth };
}

function renderSelBar() {
  const bar = ensureSelBar();
  const s = selKeyView();
  if (!s || !tlSel) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  const fieldTxt = s.field ? et(ANIM_LABEL[s.field]) : et("tl.allFields");
  bar.querySelector(".tl-sel-label")!.textContent = `${nodeName(s.node.id)} · ${fieldTxt} · ${fmtTime(tlSel.t)}`;
  const smooth = bar.querySelector<HTMLButtonElement>('[data-act="smooth"]')!;
  smooth.hidden = !s.field;
  smooth.textContent = et(s.smooth ? "tl.keyLinear" : "tl.keySmooth");
  smooth.title = et("tl.keySmoothTip");
  bar.querySelector<HTMLButtonElement>('[data-act="delete"]')!.textContent = et("tl.keyDelete");
}

function toggleSelSmooth() {
  const s = selKeyView();
  if (!s || !s.field || !tlSel) return;
  const next = !s.smooth;
  const label = et(next ? "log.keySmoothOn" : "log.keySmoothOff", { layer: nodeName(s.node.id), field: et(ANIM_LABEL[s.field]) });
  const ok = objEditOk(label, s.node.id, (o) => setSmooth(o, s.field as AnimField, next));
  if (!ok) log(et("log.keyMoveBad", { to: fmtTime(tlSel.t) }), "warn");
  renderKeyMarks();
  renderSelBar();
}

function deleteSelKey() {
  const s = selKeyView();
  if (!s || !tlSel) return;
  const at = tlSel.t;
  const ok = objEditOk(et("log.keyDeleted", { layer: nodeName(s.node.id), at: fmtTime(at) }), s.node.id, (o) => {
    let hit = false;
    for (const f of ANIM_FIELDS) {
      if (s.field && f !== s.field) continue;
      const view = getAnim(o, f);
      if (!view) continue;
      const frame = Math.round(at * view.fps);
      if (!view.keys.some((k) => Number(k.frame) === frame)) continue;
      if (removeKey(o, f, frame)) hit = true;
    }
    return hit;
  });
  if (ok) {
    tlSel = null;
    renderKeyMarks();
  } else {
    log(et("log.keyDelBad", { at: fmtTime(at) }), "warn");
  }
  renderSelBar();
}

/** ←/→ 微调选中关键帧（帧为单位；层行 = 该层该时刻的全部动画一起挪） */
function nudgeSelKey(frames: number) {
  const s = selKeyView();
  if (!s || !tlSel) return;
  const from = tlSel.t;
  const fps = fpsAt(s.node, s.field);
  const to = Math.max(0, Math.round((from + frames / fps) * 1000) / 1000);
  if (Math.abs(to - from) < 1e-6) return;
  const ok = objEditOk(
    et("log.keyNudged", { layer: nodeName(s.node.id), from: fmtTime(from), to: fmtTime(to) }),
    s.node.id,
    (o) => (s.field ? moveKeyTimeIn(o, s.field, from, to) : moveKeyTime(o, from, to)),
  );
  if (ok) tlSel = { ...tlSel, t: to };
  else log(et("log.keyMoveBad", { to: fmtTime(to) }), "warn");
  renderKeyMarks();
  renderSelBar();
}

/** 拖动关键帧：box 取标记所在容器（整层标记用 #tl-keys，属性行标记用它的 .tl-lane-bars） */
function startKeyDrag(
  e: PointerEvent,
  m: HTMLElement,
  n: LayerNode,
  from: number,
  field: AnimField | null = null,
  host: HTMLElement = tlKeysEl,
) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  m.setPointerCapture(e.pointerId);
  m.classList.add("is-dragging");
  scrubbing = true;
  const box = host.getBoundingClientRect();
  const fps = fpsAt(n, field);
  let to = from;
  const move = (ev: PointerEvent) => {
    const raw = Math.max(0, Math.min(tlMax, ((ev.clientX - box.left) / box.width) * tlMax));
    const s = snapKeyTime(raw, fps);
    to = s.t;
    m.style.left = `${(to / tlMax) * 100}%`;
    tlTimeEl.textContent = fmtTime(to);
    // 播放头跟着手指走：判断「要不要这一帧」得看画面
    tlGhostT = to;
    paintPlayhead();
    tlPlayheadEl.classList.toggle("is-snap", !!s.snap);
  };
  const end = () => {
    m.removeEventListener("pointermove", move);
    m.removeEventListener("pointerup", end);
    m.removeEventListener("pointercancel", end);
    m.classList.remove("is-dragging");
    scrubbing = false;
    tlGhostT = null;
    tlPlayheadEl.classList.remove("is-snap");
    paintPlayhead();
    // 落回原帧（含只点了一下没拖）：不写文档，只当作选中。
    // 这里**不能**重画标记 —— 重画会把这个节点换掉，双击就再也到不了 dblclick。
    if (Math.round(to * fps) === Math.round(from * fps)) {
      renderSelBar();
      return;
    }
    const ok = objEditOk(
      et("log.keyMoved", { layer: nodeName(n.id), from: fmtTime(from), to: fmtTime(to) }),
      n.id,
      (o) => (field ? moveKeyTimeIn(o, field, from, to) : moveKeyTime(o, from, to)),
    );
    if (!ok) {
      log(et("log.keyMoveBad", { to: fmtTime(to) }), "warn");
      renderKeyMarks();
      return;
    }
    tlSel = { layerId: String(n.id), field, t: to };
    renderKeyMarks();
    renderSelBar();
  };
  m.addEventListener("pointermove", move);
  m.addEventListener("pointerup", end);
  m.addEventListener("pointercancel", end);
}

/** 时间轴上的关键帧标记：可选中、可拖、双击切平滑/线性（editable = 有文档且该层没锁） */
function bindKeyMark(mark: HTMLElement, n: LayerNode, field: AnimField | null, t: number, host: HTMLElement, editable: boolean) {
  if (field) mark.dataset.field = field;
  if (tlSel && tlSel.layerId === String(n.id) && tlSel.field === field && Math.abs(tlSel.t - t) < 1e-6) mark.classList.add("is-selected");
  if (!editable) return;
  mark.classList.add("is-draggable");
  mark.addEventListener("pointerdown", (ev) => {
    // 先记选中态但**不要整块重绘**：重绘会把正在拖的这个标记换掉，指针捕获就断了
    setTlSel(n.id, field, t, false);
    mark.classList.add("is-selected");
    startKeyDrag(ev, mark, n, t, field, host);
  });
  mark.addEventListener("click", (ev) => ev.stopPropagation());
  mark.addEventListener("dblclick", (ev) => {
    ev.stopPropagation();
    if (field) toggleSelSmooth();
  });
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
  // 指针回放跟着播放头走：取样成功（= 正在回放）才刷状态栏那行字
  if (pointerStudio.tick()) syncPointerState();
  if (!editor || scrubbing) return;
  const t = editor.time;
  // 场景壁纸没有时长概念（循环播放），滑条窗口按 30s 一档向后扩
  if (t > tlMax) setTimelineMax(Math.ceil(t / TL_WINDOW) * TL_WINDOW);
  tlRangeEl.value = String(t);
  tlTimeEl.textContent = fmtTime(t);
  if (!tlPlayheadEl.hidden) paintPlayhead();
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

// ---------- 刻度尺定位 + 关键帧编辑（S5） ----------

/** 刻度尺上按下 / 拖动 = 定位当前时刻（与滑条、播放头同一坐标系） */
function rulerTimeAt(clientX: number): number {
  const box = tlTrackBox();
  const inner = Math.max(1, box.width - 14);
  const x = clientX - tlDockEl.getBoundingClientRect().left - box.left - 7;
  return Math.max(0, Math.min(tlMax, (x / inner) * tlMax));
}

tlRulerEl.addEventListener("pointerdown", (e) => {
  if (!editor || e.button !== 0) return;
  e.preventDefault();
  tlRulerEl.setPointerCapture(e.pointerId);
  scrubbing = true;
  let last = editor.time;
  const seek = (ev: PointerEvent) => {
    last = rulerTimeAt(ev.clientX);
    tlTimeEl.textContent = fmtTime(last);
    void seekLogged(editor!.seek(last));
  };
  seek(e);
  const move = (ev: PointerEvent) => seek(ev);
  const end = () => {
    tlRulerEl.removeEventListener("pointermove", move);
    tlRulerEl.removeEventListener("pointerup", end);
    tlRulerEl.removeEventListener("pointercancel", end);
    scrubbing = false;
    void seekLogged(editor!.seek(last)).then(() => {
      const n = selectedNode();
      if (n && ANIM_FIELDS.some((f) => isAnimated(n.obj, f))) renderInspector();
    });
  };
  tlRulerEl.addEventListener("pointermove", move);
  tlRulerEl.addEventListener("pointerup", end);
  tlRulerEl.addEventListener("pointercancel", end);
});

// 选中关键帧后的键盘操作：Delete/Backspace 删除、←/→ ±1 帧（⇧ ±10）、Esc 取消选中。
// 必须注册在「Delete 删图层」那个全局监听（editor/main.ts 后段的 window keydown）之前，
// 并用捕获阶段 + stopImmediatePropagation 抢下，否则删关键帧会把整个图层一起删掉。
window.addEventListener(
  "keydown",
  (e) => {
    if (!tlSel || !editor) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (e.key === "Delete" || e.key === "Backspace") deleteSelKey();
    else if (e.key === "ArrowLeft" || e.key === "ArrowRight") nudgeSelKey((e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 10 : 1));
    else if (e.key === "Escape") {
      clearTlSel();
      renderKeyMarks();
    } else return;
    e.preventDefault();
    e.stopImmediatePropagation();
  },
  true,
);

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
/** 未保存编辑的快照（计划 §2 C3）：与虚拟工程共用同一存储域，槽按工程标识分 */
const draftStore = vdirDraftStore();
/** 上次快照时间（{@link DRAFT_THROTTLE_MS} 节流）；0 = 本次会话还没存过 */
let draftWrittenAt = 0;
/** 本次会话自己写过的槽；只有它才允许被自动清掉（上一次会话留下的快照不碰，可能只有那一份） */
let lastDraftSlot: string | null = null;
/**
 * 会话文档（没有工程目录也没有库条目）的槽后缀：每个文档一个随机标识。
 * 槽名带上它，两个未命名文档才不会共用 `session` 槽互相覆盖 / 误清快照（审计 H1）。
 * 用时间戳 + 随机而不是自增计数器：刷新后计数器从头开始，新一轮会话的第一个文档
 * 会和上一轮留在 `session:1` 的快照撞名。
 */
const sessionSlotKeys = new WeakMap<EditorDoc, string>();

function sessionSlotKey(d: EditorDoc): string {
  let k = sessionSlotKeys.get(d);
  if (!k) {
    k = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    sessionSlotKeys.set(d, k);
  }
  return k;
}

/** 启动时发现、等用户点「恢复」的快照 */
let pendingDraft: { slot: string; draft: Draft } | null = null;
/** 工程文件夹可写性：null = 还没探测，false = 不可写（自动保存退到草稿槽，见 autosaveTargetFor） */
let dirWritable: boolean | null = null;
/** 已经为哪个文档提示过「没有可保存内容」，同一次打开只提示一次 */
let warnedNoSaveFor: EditorDoc | null = null;
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
  probeDirWritable(dir);
}

/** 库条目不落盘：解绑上一个文档的项目文件夹，免得自动保存把它写进别的工程 */
function releaseProject() {
  projectDir = null;
  dirWritable = null;
  writtenSig.clear();
  ownedPaths.clear();
  saveAgain = false;
  clearTimeout(saveTimer);
  saveTimer = 0;
}

/**
 * 探一次工程文件夹能不能写（计划 §2 C6「不可写就不写并明确提示」）。
 * 刚挂上的工程先按可写算，探到不可写才退到草稿槽 —— 只提示一次，不每 400ms 撞同一堵墙。
 */
function probeDirWritable(dir: DirHandle) {
  dirWritable = null;
  void probeWritable(dir).then(
    () => {
      if (projectDir === dir) dirWritable = true;
    },
    (e: unknown) => {
      if (projectDir !== dir) return;
      dirWritable = false;
      log(et("log.dirNotWritable", { name: dir.name, msg: (e as Error).name || (e as Error).message }), "warn");
      scheduleAutosave();
    },
  );
}

/** ⌘S：已有项目文件夹就写回；库条目等没绑文件夹的文档先选文件夹另存为项目 */
async function saveDocument() {
  if (projectDir) {
    await flushAutosave();
    return;
  }
  if (!doc) return;
  if (!canSave()) {
    log(et("log.cannotSaveKind", { kind: doc.type }), "warn");
    return;
  }
  // 另存为项目后文件夹就是权威副本，原来那条草稿（库条目 / 会话）不再需要
  const prevSlot = currentDraftSlot();
  const dir = await requireProjectDir();
  if (!dir || !doc) return;
  adoptProject(dir);
  libItem = null;
  syncLibraryItem();
  log(et("log.savedAsProject", { name: dir.name }));
  // 只有真的写进文件夹才清：写盘失败（磁盘满 / 权限被撤 / IDB 配额）时这份草稿是唯一副本
  if (await flushAutosave()) clearOwnDraftSlot(prevSlot);
}

/**
 * 有东西可写：场景文档 + 资源表，或视频壁纸工程，或网页壁纸工程的资源表
 * （网页工程没有场景文档 —— 工程本体就是那堆站点文件，保存时原样搬）
 */
const canSave = () => !!doc?.video || (!!doc?.scene && !!current?.assets) || (doc?.type === "web" && !!current?.assets);

/** 当前文档的草稿槽：虚拟工程按 id、库条目按 itemId、本地文件夹按名字，都没有就是带文档标识的会话槽 */
function currentDraftSlot(): string {
  const vdirId = projectDir ? virtualIdOf(projectDir) : null;
  const localName = projectDir && !vdirId ? projectDir.name : null;
  const libraryItemId = libItem?.itemId ?? null;
  return draftSlotFor({
    vdirId,
    libraryItemId,
    localName,
    sessionKey: !vdirId && !localName && !libraryItemId && doc ? sessionSlotKey(doc) : null,
  });
}

/** 自动保存该往哪写：文件夹 / 草稿槽 / 不写（计划 §2 C6；判定本身在 editor/draft.ts） */
const autosaveTarget = (): AutosaveTarget =>
  autosaveTargetFor({
    savable: canSave(),
    hasDir: !!projectDir && dirWritable !== false,
    // 快照只装得下场景文档（视频 / 网页的原始文件不在快照里），装不下就别假装存了
    draftable: !!doc?.scene,
    slot: currentDraftSlot(),
  });

/** 草稿的来源：决定重开时按哪条路把原始资源找回来 */
function draftOriginFor(): DraftOrigin {
  const vdirId = projectDir ? virtualIdOf(projectDir) : null;
  if (vdirId) return { kind: "virtual", id: vdirId };
  if (libItem) return { kind: "library", itemId: libItem.itemId };
  if (projectDir) return { kind: "local", name: projectDir.name };
  return { kind: "new" };
}

/** 没有可保存内容时明确提示一次（不写，也不静默） */
function warnNoAutosaveTarget() {
  if (!doc || warnedNoSaveFor === doc) return;
  warnedNoSaveFor = doc;
  log(et("log.cannotSaveKind", { kind: doc.type }), "warn");
}

/**
 * 内容已经落到工程文件夹后，把本次会话写过的草稿副本清掉。
 * 只清 {@link lastDraftSlot} —— 上一次会话留下的快照不动：同名的两个文件夹会撞同一个槽，
 * 那份快照可能是它唯一的副本（要清让用户自己点横幅上的「丢弃」）。
 */
function clearOwnDraftSlot(slot: string = currentDraftSlot()) {
  if (!slot || lastDraftSlot !== slot) return;
  lastDraftSlot = null;
  void draftStore.clear(slot).catch((e: unknown) => log(et("log.draftFailed", { msg: (e as Error).message }), "warn"));
}

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
  // 落到本机文件夹后，虚拟工程 / 库条目那条草稿就作废了
  const prevSlot = currentDraftSlot();
  adoptProject(dir);
  libItem = null;
  syncLibraryItem();
  log(et("log.savedToDir", { name: dir.name }));
  // 同上：写盘失败时草稿留着
  if (await flushAutosave()) clearOwnDraftSlot(prevSlot);
}

async function collectCurrent(preview: Blob | null, unreadable?: Set<string>): Promise<SaveFile[] | null> {
  if (doc?.video) return collectVideoProject(doc, preview);
  if (doc?.type === "web" && current?.assets) return collectWebProject(doc, current.assets, preview);
  if (doc?.scene && current?.assets) return collectProject(doc, current.assets, preview, undefined, unreadable);
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
  // 只清扫**自家直接子按钮**（`:scope >`）：插件贡献的 menu.export 项在 `#ed-plugin-export` 里，
  // 后代查询会把它们一并删掉（槽位注册表仍在，贡献却没了，且切语言/新增导出器时会复现）
  for (const b of exportMenuEl.querySelectorAll<HTMLButtonElement>(":scope > button")) if (!keep.has(b)) b.remove();
  syncExportButton();
}

exportMenuEl.addEventListener("click", (ev) => {
  const target = ev.target as HTMLElement;
  // 插件贡献的菜单项：动作由插件自己的监听处理，宿主只补「点完关菜单」
  if (target.closest("#ed-plugin-export")) {
    closeExportMenu();
    return;
  }
  const b = target.closest<HTMLButtonElement>("button[id^='export-']");
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

// ---------- 场景设置（计划 A4）：scene.json 的 general 段 ----------
//
// 和上面的「渲染选项」是两回事：那是本机 UI 偏好（localStorage、不进工程），
// 这里是这份壁纸自己的参数 —— 写进 doc.scene.general、进撤销栈、跟着文档保存。
// 面板本体在 editor/scene-settings.ts，这里只管记账、重挂与菜单开合。

const sceneOptsEl = $<HTMLButtonElement>("#tb-scene-opts");
const sceneMenuEl = $<HTMLElement>("#scene-menu");

/** general 段快照（"null" = 这份文档本来没有 general 键） */
function sceneSnap(): string {
  return generalSnapshot(doc?.scene ?? null);
}

/** 把 general 段换回快照并重挂：撤销 / 重做共用（与结构编辑同一条路，改完必须整场景重挂才生效） */
function applySceneSnap(json: string) {
  if (!doc?.scene) return;
  restoreGeneral(doc.scene, json);
  docDriven = true;
  markDirty();
  renderInspector();
  void mountCurrent(true);
  sceneSettings.refresh();
}

/**
 * 改一个场景设置字段：改一次进一次撤销栈（范式同工程改名 TitleCmd —— 结构命令的快照装不下 general）。
 * 值没变（点一下没动 / 改回原值）不入栈；改完置 docDriven 再重挂，引擎拿到的才是文档里的 general。
 */
function sceneEdit(label: string, key: string, value: unknown): boolean {
  if (!doc?.scene) {
    log(et("log.sceneNoDoc"), "warn");
    return false;
  }
  const before = sceneSnap();
  writeGeneralField(ensureSceneGeneral(doc.scene), key, value);
  const after = sceneSnap();
  if (after === before) return false;
  edits.push({ kind: "scene", label, before, after });
  syncHistoryButtons();
  docDriven = true;
  markDirty();
  log(label);
  void mountCurrent(true);
  return true;
}

const sceneSettings = mountSceneSettings({
  root: $<HTMLElement>("#scene-menu-body"),
  scene: () => doc?.scene ?? null,
  edit: sceneEdit,
  bad: (msg) => log(msg, "warn"),
});
onChangeLang(() => sceneSettings.refresh());

function closeSceneMenu() {
  sceneMenuEl.hidden = true;
}

sceneOptsEl.onclick = (e) => {
  e.stopPropagation();
  if (!sceneMenuEl.hidden) {
    closeSceneMenu();
    return;
  }
  closeExportMenu();
  closeRenderMenu();
  sceneSettings.refresh();
  const r = sceneOptsEl.getBoundingClientRect();
  sceneMenuEl.style.left = `${r.left}px`;
  sceneMenuEl.style.top = `${r.bottom + 2}px`;
  sceneMenuEl.hidden = false;
  // 工具条在视口下方，往下放不下就翻到按钮上方；左侧越界也夹回窗口内（同渲染选项菜单）
  const box = sceneMenuEl.getBoundingClientRect();
  if (r.bottom + 2 + box.height > window.innerHeight - 6) {
    sceneMenuEl.style.top = `${Math.max(6, r.top - box.height - 2)}px`;
  }
  if (r.left + box.width > window.innerWidth - 6) {
    sceneMenuEl.style.left = `${Math.max(6, window.innerWidth - box.width - 6)}px`;
  }
};
document.addEventListener("click", (e) => {
  if (!sceneMenuEl.hidden && !sceneMenuEl.contains(e.target as Node)) closeSceneMenu();
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

/**
 * 编辑防抖（400ms）后的自动保存。目标是算出来的，不是「有文件夹才存」：
 * 有可写工程文件夹就写文件夹，没有就写草稿槽（计划 §2 C6 放宽），
 * 连内容都没有才不写 —— 此时明确提示一次。
 */
function scheduleAutosave() {
  const target = autosaveTarget();
  if (target === "none") {
    warnNoAutosaveTarget();
    return;
  }
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    if (mounting) {
      scheduleAutosave();
      return;
    }
    if (target === "draft") void flushDraftSnapshot();
    else void flushAutosave();
  }, AUTOSAVE_MS);
}

/**
 * 未保存编辑的快照（计划 §2 C3）：写进与虚拟工程同一存储域的草稿槽。
 * 除编辑防抖外再按 DRAFT_THROTTLE_MS 节流，拖拽长按时不做无谓的整份序列化。
 */
async function flushDraftSnapshot(force = false) {
  clearTimeout(saveTimer);
  saveTimer = 0;
  const snap = doc;
  if (!snap || !canSave()) return;
  const now = Date.now();
  if (!force && !snapshotDue(draftWrittenAt, now)) {
    // 节流窗口内还有编辑：等窗口过了再写一次（不丢最后一次改动）
    saveTimer = window.setTimeout(() => void flushDraftSnapshot(), draftWrittenAt + DRAFT_THROTTLE_MS - now);
    return;
  }
  const slot = currentDraftSlot();
  if (!slot) return;
  const d = makeDraft(snap, draftOriginFor(), overlay?.entry ?? "scene.json", overlay?.added() ?? [], now);
  if (!d) return;
  draftWrittenAt = now;
  try {
    await draftStore.save(d, slot);
    lastDraftSlot = slot;
  } catch (e) {
    log(et("log.draftFailed", { msg: (e as Error).message }), "warn");
  }
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

/** 把当前文档写成项目文件夹里的松散文件。⌘S 与编辑防抖都走这里。返回是否真的写出去了 */
async function flushAutosave(): Promise<boolean> {
  clearTimeout(saveTimer);
  saveTimer = 0;
  if (!projectDir || !canSave()) return false;
  if (saving) {
    saveAgain = true;
    return false;
  }
  const dir = projectDir;
  const snap = doc;
  saving = true;
  renderSaveStatus();
  const t0 = performance.now();
  let ok = false;
  try {
    const preview = await capturePreview();
    if (dir !== projectDir || doc !== snap) return ok;
    const unreadable = new Set<string>();
    const files = await collectCurrent(preview, unreadable);
    if (!files) return ok;
    const changed = files.filter((f) => fileSig(f.data) !== writtenSig.get(f.path));
    if (changed.length) await writeToDirectory(dir, changed);
    for (const f of changed) writtenSig.set(f.path, fileSig(f.data));
    const keep = new Set(files.map((f) => f.path));
    for (const p of [...ownedPaths]) {
      if (keep.has(p)) continue;
      // 这一轮还挂在资源表里、只是读不到字节的文件不删：源暂时取不到（缓存缺 / owner 组
      // 不再被引用）时删掉，就是用户工程文件夹里的资源无声消失（审计 M2）
      if (unreadable.has(p)) continue;
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
      // 内容已经落到文件夹里，这个文档的草稿副本就没有意义了
      clearOwnDraftSlot();
      ok = true;
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
  return ok;
}

/** 立刻落盘（页面隐藏 / 卸载前）：有可写文件夹写文件夹，否则按草稿槽来（草稿不吃节流） */
function flushPendingSave() {
  if (autosaveTarget() === "draft") void flushDraftSnapshot(true);
  else void flushAutosave();
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
      const yes = await confirmDialog({
        title: et("dlg.exportTitle"),
        body: et("export.blocked", { n }),
        ok: et("dlg.exportOk"),
      });
      if (!yes) {
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
  // 关键帧选中属于某一个图层：换层就取消，免得 Delete 误删上一层的（已拖过的）关键帧
  if (tlSel && String(tlSel.layerId) !== String(id)) clearTlSel();
  // 操控变形预览也只属于一个图层（引擎里的 setBonePose 不进文档）：换层就退出
  if (warpSession && String(warpSession.layer) !== String(id)) warpExit();
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

/** 主选 + 追加集合一次性落定（框选 / 全选用）：主选拿列表第一个，其余进 extraSel */
function selectMany(primary: number | string | null, extra: ReadonlyArray<number | string>) {
  if (tlSel && String(tlSel.layerId) !== String(primary)) clearTlSel();
  if (warpSession && String(warpSession.layer) !== String(primary)) warpExit();
  extraSel.clear();
  selectedId = null;
  if (primary !== null && doc) selectedId = findPath(doc.roots, primary)?.at(-1)?.id ?? null;
  for (const id of extra) {
    if (String(id) === String(selectedId) || extraSel.has(String(id))) continue;
    if (doc && findPath(doc.roots, id)) extraSel.add(String(id));
  }
  renderTree();
  renderInspector();
  treeEl.querySelector(".ed-node.selected")?.scrollIntoView({ block: "nearest" });
}

/** 全选（⌘A）：只选当前可见层，锁定的层不入选（与点选口径一致） */
function selectAllLayers() {
  if (!doc || doc.type !== "scene") return;
  const ids: Array<number | string> = [];
  const walk = (nodes: LayerNode[]) => {
    for (const n of nodes) {
      if (n.visible && !isLocked(n.id)) ids.push(n.id);
      if (!collapsed.has(n.id)) walk(n.children);
    }
  };
  walk(doc.roots);
  if (!ids.length) return;
  selectMany(ids[0], ids.slice(1));
  log(et("log.selectAll", { n: ids.length }));
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
  if (isFileCmd(cmd)) {
    log(et(dir === "undo" ? "log.undo" : "log.redo", { name: cmd.label }));
    const snap = dir === "undo" ? cmd.before : cmd.after;
    applyParticleBytes(snap.path, snap.bytes);
    markDirty();
    renderInspector();
    renderStatus();
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
  if (isSceneCmd(cmd)) {
    log(et(dir === "undo" ? "log.undo" : "log.redo", { name: cmd.label }));
    applySceneSnap(dir === "undo" ? cmd.before : cmd.after);
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
  // 命令面板（M9/C4）：面板是查看命令注册表的入口，不是一条文档命令（注册表保持 7 条内置），
  // 所以开关直接在这里处理；面板内的输入框在面板自己的 keydown 里开合，不会走到这里。
  if ((e.metaKey || e.ctrlKey) && (e.key.toLowerCase() === "k" || (e.shiftKey && e.key.toLowerCase() === "p"))) {
    e.preventDefault();
    ensurePalette()?.toggle();
    return;
  }
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
  } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
    e.preventDefault();
    selectAllLayers();
  } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c") {
    if (!copySelected()) return;
    e.preventDefault();
  } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "x") {
    if (!cutSelected()) return;
    e.preventDefault();
  } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "v") {
    if (!pasteClipboard()) return;
    e.preventDefault();
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
  const canvas = stageEl.querySelector<HTMLCanvasElement>("canvas:not(#ed-overlay)");
  const cr = canvas?.getBoundingClientRect() ?? null;
  if (!cr) return;
  const sr = stageEl.getBoundingClientRect();
  overlayCtx.setTransform(dpr, 0, 0, dpr, (cr.left - sr.left) * dpr, (cr.top - sr.top) * dpr);
  if (marquee) drawMarquee();
  overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
  if (!editor || selectedId === null) return;
  if (extraSel.size) drawExtraOutlines();
  const outline = editor.getLayerOutline(Number(selectedId));
  if (!outline) return;
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
  // 操控变形开着就画钉子（钉子就是钉骨 i+1）：骨骼面板的圆点会让位，免得两套标记重叠
  if (warpSession) {
    drawWarpPins();
    // P1：几何线框 / 角色表视图叠在钉子之上（指针事件优先给几何与角色表，见文件末尾的监听）
    if (geomMode) drawGeomOverlay(warpSession);
    // P2：骨架 / 权重叠加层（骨点与父子连线、顶点按主骨着色、笔刷圈）
    if (skelMode) drawSkelOverlay(warpSession);
  } else drawBoneMarkers();
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
  // P1：几何 / 角色表模式下指针事件归它们（切片 / 拓扑 / 顶点偏移 / 涂抹），别把层一起拖走
  if (geomModal()) return;
  if (!editor || selectedId === null || isLocked(selectedId) || e.button !== 0 || e.altKey) return;
  const p = canvasPoint(e);
  if (!p) return;
  // 操控变形：钉子比手柄优先（钉子常常就压在手柄 / 角点附近）
  if (warpGrab(e, p.x, p.y)) return;
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
  if (warpDragMove(e, p.x, p.y)) return;
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
// 操控变形的钉子拖动是另一条通道（不进 drag / 不进 undo）：引擎预览 + 悬停高亮
stageEl.addEventListener("pointerup", warpDrop);
stageEl.addEventListener("pointercancel", warpDrop);

// ---------- 指针工作室（B5 / M11：停帧摆位 → 轨迹录制 → 回放） ----------
// 引擎指针通道（pointer.js → pushPointer）本来就在；这里补的是「编辑器主动驱动」。
// 指针对场景是纯运行时状态（scene.json 没有指针字段，计划 §6 决策 3），所以这一整段
// 不碰 doc / undo / 导出：只经 pointerStudio.push 驱动 uniform。

const ptrMenuEl = $<HTMLElement>("#pointer-menu");
const ptrBtnEl = $<HTMLButtonElement>("#tb-pointer");
const ptrXEl = $<HTMLInputElement>("#ptr-x");
const ptrYEl = $<HTMLInputElement>("#ptr-y");
const ptrParkEl = $<HTMLButtonElement>("#ptr-park");
const ptrCenterEl = $<HTMLButtonElement>("#ptr-center");
const ptrNameEl = $<HTMLInputElement>("#ptr-name");
const ptrRecEl = $<HTMLButtonElement>("#ptr-rec");
const ptrTracksEl = $<HTMLSelectElement>("#ptr-tracks");
const ptrPlayEl = $<HTMLButtonElement>("#ptr-play");
const ptrDelEl = $<HTMLButtonElement>("#ptr-del");
const ptrStateEl = $<HTMLElement>("#ptr-state");

/** localStorage 只作兜底：隐私模式下取用会抛，拿不到就当没有 */
function pointerStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** 视口归一化坐标：与 pointer.js 同口径（原点左上、Y 朝下），按渲染画布算而不是叠加层 */
function pointerUV(e: PointerEvent): { u: number; v: number } | null {
  const canvas = stageEl.querySelector<HTMLCanvasElement>("canvas:not(#ed-overlay)");
  if (!canvas) return null;
  const r = canvas.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  const p = clampPoint((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  return p ? { u: p.x, v: p.y } : null;
}

const pointerStudio = createPointerStudio({
  push: (u, v, buttons) => instance?.pushPointer(u, v, buttons),
  leave: () => instance?.pointerLeave(),
  isPaused: () => !userPlaying,
  clock: () => (editor ? editor.time * 1000 : 0),
  now: () => performance.now(),
  log: (msg, level) => log(msg, level),
  t: (key, params) => et(key, params),
  storage: pointerStorage(),
});

/** 摆位模式：叠加层临时接管鼠标（pointer-events:auto），与既有的图层拖拽互斥 */
let ptrParking = false;

/** 叠加层要不要接管鼠标：摆位或录制中；接管期间 engine 自己的鼠标通道收不到事件，由这边主动驱动 */
const pointerCaptureOn = () => ptrParking || pointerStudio.recording();

function syncPointerCapture() {
  const on = pointerCaptureOn();
  overlayEl.style.pointerEvents = on ? "auto" : "none";
  overlayEl.style.cursor = ptrParking ? "crosshair" : "";
}

/** 轨迹下拉：列表变了才重建（每帧刷新会把用户正在看的项顶掉） */
function syncPointerTracks() {
  const tracks = pointerStudio.list();
  if (!tracks.length) {
    ptrTracksEl.disabled = true;
    if (ptrTracksEl.dataset.names !== "empty") {
      ptrTracksEl.innerHTML = "";
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = et("ptr.empty");
      ptrTracksEl.append(opt);
      ptrTracksEl.dataset.names = "empty";
    }
    return;
  }
  ptrTracksEl.disabled = false;
  const names = tracks.map((t) => t.name).join("\n");
  if (ptrTracksEl.dataset.names !== names) {
    ptrTracksEl.innerHTML = "";
    for (const t of tracks) {
      const opt = document.createElement("option");
      opt.value = t.name;
      opt.textContent = `${t.name} · ${(t.duration / 1000).toFixed(2)}s`;
      ptrTracksEl.append(opt);
    }
    ptrTracksEl.dataset.names = names;
  }
  const active = pointerStudio.activeName();
  if (active && ptrTracksEl.value !== active) ptrTracksEl.value = active;
}

const setText = (el: HTMLElement, text: string) => {
  if (el.textContent !== text) el.textContent = text;
};

function syncPointerState() {
  if (pointerStudio.recording()) {
    setText(ptrStateEl, et("ptr.recording", { n: pointerStudio.recordingPoints() }));
  } else if (pointerStudio.replaying()) {
    const at = pointerStudio.replayAt();
    setText(ptrStateEl, et("ptr.replayAt", { name: pointerStudio.replayName() ?? "", t: ((at ? at.t : 0) / 1000).toFixed(2) }));
  } else {
    const p = pointerStudio.parkedPoint();
    setText(ptrStateEl, p ? et("ptr.parkedAt", { x: p.x.toFixed(3), y: p.y.toFixed(3) }) : et("ptr.parkedNone"));
  }
  setText(ptrRecEl, et(pointerStudio.recording() ? "ptr.recStop" : "ptr.rec"));
  setText(ptrPlayEl, et(pointerStudio.replaying() ? "ptr.playStop" : "ptr.play"));
  syncPointerTracks();
}

function setPointerParking(on: boolean) {
  ptrParking = on;
  syncPointerCapture();
  ptrParkEl.textContent = et(on ? "ptr.parkEnd" : "ptr.park");
  syncPointerState();
}

/** 从数值框摆位；未暂停时 place 会拒绝并提示（停帧语义） */
function parkFromInputs(force = false) {
  const p = pointerStudio.place(ptrXEl.value, ptrYEl.value, { force });
  if (!p) return null;
  ptrXEl.value = String(p.x);
  ptrYEl.value = String(p.y);
  syncPointerState();
  log(et("log.ptrParked", { x: p.x.toFixed(3), y: p.y.toFixed(3) }));
  return p;
}

function pointerDragTo(e: PointerEvent) {
  const uv = pointerUV(e);
  if (!uv) return null;
  ptrXEl.value = uv.u.toFixed(3);
  ptrYEl.value = uv.v.toFixed(3);
  // 录制中除了驱动 uniform（接管期间引擎自己收不到鼠标），还采一个带时间戳的点
  if (pointerStudio.recording()) pointerStudio.record(uv.u, uv.v);
  const p = pointerStudio.place(uv.u, uv.v, { force: true, buttons: e.buttons });
  syncPointerState();
  return p;
}

overlayEl.addEventListener("pointerdown", (e) => {
  if (!pointerCaptureOn()) return;
  e.stopPropagation();
  e.preventDefault();
  // 录制中允许在播放态描轨迹（时间戳来自录制时钟）；摆位仍然要求停帧
  if (ptrParking && userPlaying) {
    log(et("log.ptrNeedPause"), "warn");
    return;
  }
  overlayEl.setPointerCapture(e.pointerId);
  pointerDragTo(e);
});
overlayEl.addEventListener("pointermove", (e) => {
  if (!pointerCaptureOn() || !overlayEl.hasPointerCapture(e.pointerId)) return;
  e.stopPropagation();
  pointerDragTo(e);
});
const pointerDragEnd = (e: PointerEvent) => {
  if (!pointerCaptureOn() || !overlayEl.hasPointerCapture(e.pointerId)) return;
  e.stopPropagation();
  overlayEl.releasePointerCapture(e.pointerId);
};
overlayEl.addEventListener("pointerup", pointerDragEnd);
overlayEl.addEventListener("pointercancel", pointerDragEnd);

ptrParkEl.onclick = () => setPointerParking(!ptrParking);
ptrCenterEl.onclick = () => {
  ptrXEl.value = "0.5";
  ptrYEl.value = "0.5";
  parkFromInputs();
};
ptrXEl.oninput = () => parkFromInputs();
ptrYEl.oninput = () => parkFromInputs();

/** 录制开关：开 = 叠加层接管鼠标开始采点，关 = 成一条命名轨迹（内存 + localStorage 兜底） */
function togglePointerRecord() {
  if (!instance) return;
  if (pointerStudio.recording()) {
    const track = pointerStudio.stopRecord();
    if (track) ptrNameEl.value = "";
  } else {
    if (ptrParking) setPointerParking(false);
    pointerStudio.startRecord(ptrNameEl.value);
    log(et("log.ptrRecordStart"));
  }
  syncPointerCapture();
  syncPointerState();
}
ptrRecEl.onclick = () => togglePointerRecord();

// 回放：按时间轴播放头取样驱动 uniform（停帧下拖时间轴也能看指针走到哪）
ptrPlayEl.onclick = () => {
  if (pointerStudio.replaying()) pointerStudio.stopReplay();
  else if (!pointerStudio.startReplay(ptrTracksEl.value)) log(et("ptr.empty"), "warn");
  syncPointerState();
};
ptrDelEl.onclick = () => {
  if (!pointerStudio.remove(ptrTracksEl.value)) return;
  syncPointerState();
};
ptrTracksEl.onchange = () => {
  pointerStudio.select(ptrTracksEl.value);
  syncPointerState();
};

function closePtrMenu() {
  if (pointerStudio.recording()) togglePointerRecord();
  ptrMenuEl.hidden = true;
  if (ptrParking) setPointerParking(false);
}

ptrBtnEl.onclick = (e) => {
  e.stopPropagation();
  if (!ptrMenuEl.hidden) {
    closePtrMenu();
    return;
  }
  closeExportMenu();
  closeRenderMenu();
  closeRecMenu();
  const r = ptrBtnEl.getBoundingClientRect();
  ptrMenuEl.style.left = `${r.left}px`;
  ptrMenuEl.style.top = `${r.bottom + 2}px`;
  ptrMenuEl.hidden = false;
  // 视口工具条在视口上方，往下放不下就翻到按钮上方；左侧越界也夹回窗口内
  const box = ptrMenuEl.getBoundingClientRect();
  if (r.bottom + 2 + box.height > window.innerHeight - 6) {
    ptrMenuEl.style.top = `${Math.max(6, r.top - box.height - 2)}px`;
  }
  if (r.left + box.width > window.innerWidth - 6) {
    ptrMenuEl.style.left = `${Math.max(6, window.innerWidth - box.width - 6)}px`;
  }
  syncPointerState();
};
document.addEventListener("click", (e) => {
  if (!ptrMenuEl.hidden && !ptrMenuEl.contains(e.target as Node)) closePtrMenu();
});

// ---------- 框选（C1）：拖空白处拉矩形，松手把相交的层并进选区 ----------

/** 起拖时的层包围盒快照（画布 CSS 像素）：拖拽期间手柄不变，不必每帧重量 */
let marqueeLayers: MarqueeLayer[] = [];
let marquee: {
  pointerId: number;
  /** 起拖点 / 当前点，画布 CSS 像素 */
  ax: number;
  ay: number;
  bx: number;
  by: number;
  /** ⇧ / ⌘ 起拖 = 追加选（再框已选层即剔除） */
  add: boolean;
  moved: boolean;
} | null = null;
const MARQUEE_THRESHOLD = 3;

/** 量一遍当前层的包围盒；模型层取凸包的外接矩形 */
function marqueeSnapshot(): MarqueeLayer[] {
  if (!editor) return [];
  return editor.getLayers().map((l) => {
    const o = editor!.getLayerOutline(Number(l.id));
    const c = o?.hull ?? o?.corners;
    return { id: l.id, visible: l.visible, box: boxFromCorners(c) };
  });
}

function marqueeRect(): Box | null {
  return marquee ? rectOf(marquee.ax, marquee.ay, marquee.bx, marquee.by) : null;
}

/** 叠加层里画框选矩形（drawOverlay 每帧调） */
function drawMarquee() {
  const r = marqueeRect();
  if (!marquee || !marquee.moved || !r) return;
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#0078d4";
  overlayCtx.setLineDash([4, 3]);
  overlayCtx.fillStyle = "rgba(0, 120, 212, 0.12)";
  overlayCtx.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
  overlayCtx.strokeStyle = accent;
  overlayCtx.lineWidth = 1;
  overlayCtx.strokeRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
  overlayCtx.setLineDash([]);
}

stageEl.addEventListener("pointerdown", (e) => {
  if (marquee || !editor || !doc || doc.type !== "scene" || e.button !== 0 || e.altKey) return;
  // P1：几何 / 角色表模式下不框选（点在图上是要涂抹 / 切片 / 翻格子）
  if (geomModal()) return;
  const p = canvasPoint(e);
  if (!p) return;
  // 命中手柄 / 已选中层的交给上面的拖拽；点在别的层上是点选，也不框选
  if (handleAt(gizmo, p.x, p.y) || overSelected(p.x, p.y)) return;
  if (editor.hitTestAt(p.x, p.y).some((h) => !isLocked(h.id))) return;
  marqueeLayers = marqueeSnapshot();
  marquee = { pointerId: e.pointerId, ax: p.x, ay: p.y, bx: p.x, by: p.y, add: e.shiftKey || e.metaKey || e.ctrlKey, moved: false };
  stageEl.setPointerCapture(e.pointerId);
});

stageEl.addEventListener("pointermove", (e) => {
  if (!marquee || e.pointerId !== marquee.pointerId) return;
  const p = canvasPoint(e);
  if (!p) return;
  marquee.bx = p.x;
  marquee.by = p.y;
  if (!marquee.moved && Math.hypot(marquee.bx - marquee.ax, marquee.by - marquee.ay) >= MARQUEE_THRESHOLD) marquee.moved = true;
});

stageEl.addEventListener("pointerup", (e) => {
  if (!marquee || e.pointerId !== marquee.pointerId) return;
  const m = marquee;
  marquee = null;
  if (!m.moved) return;
  suppressClick = true;
  const r = rectOf(m.ax, m.ay, m.bx, m.by);
  const hits = marqueeHits(marqueeLayers, r);
  const ids = marqueeSelect(
    selectionNodes().map((n) => n.id),
    hits,
    m.add,
  );
  if (!ids.length) {
    selectMany(null, []);
    log(et("log.marqueeNone"));
    return;
  }
  selectMany(ids[0], ids.slice(1));
  log(et("log.marqueePick", { n: ids.length, hit: hits.length }));
});

stageEl.addEventListener("pointercancel", (e) => {
  if (marquee && e.pointerId === marquee.pointerId) marquee = null;
});

// ---------- 图层剪贴板（A10）：⌘C / ⌘X / ⌘V，跨文档靠内存 + localStorage ----------

/** 粘贴偏移（画布局部单位）：错开一点，免得贴在同一处看不出来 */
const PASTE_OFFSET = 16;
/** 页内剪贴板；跨页 / 刷新后由 localStorage 兜底恢复 */
let layerClip: LayerClip | null = null;

function clipboardSource(): { objs: SceneObject[]; nodes: LayerNode[] } | null {
  if (!doc || doc.type !== "scene" || !editor) return null;
  const objs = doc.scene?.objects;
  if (!Array.isArray(objs)) return null;
  const nodes = selectionNodes();
  if (!nodes.length) return null;
  return { objs: objs as SceneObject[], nodes };
}

function writeClipboard(clip: LayerClip) {
  layerClip = clip;
  save(LAYER_CLIP_KEY, stringifyLayerClip(clip));
}

function readClipboard(): LayerClip | null {
  if (layerClip) return layerClip;
  const raw = load(LAYER_CLIP_KEY);
  layerClip = raw ? parseLayerClip(raw) : null;
  return layerClip;
}

/** 复制选中的整棵子树；返回是否吃掉了这次按键 */
function copySelected(): boolean {
  const src = clipboardSource();
  if (!src) return false;
  const clip = serializeLayerClip(
    src.objs,
    src.nodes.map((n) => n.id),
  );
  if (!clip) return false;
  writeClipboard(clip);
  const n = src.nodes.length;
  log(et("log.layerCopied", { n, name: nodeName(src.nodes[0].id) }));
  return true;
}

/** 剪切 = 复制 + 删掉（删除本身进撤销栈） */
function cutSelected(): boolean {
  if (!copySelected()) return false;
  const n = selectionNodes().length;
  deleteSelected();
  log(et("log.layerCut", { n }));
  return true;
}

/** 粘贴：重新分配 id，父级尽量指回原层级；落进撤销栈 */
function pasteClipboard(): boolean {
  const clip = readClipboard();
  if (!clip || !doc || doc.type !== "scene") return false;
  let added: number[] = [];
  // structEdit 的 mutate 返回值只用来决定粘贴后选谁；返回 [] 表示没改成功
  structEdit(et("log.layerPasted", { n: clip.objs.length }), (d) => {
    added = pasteLayerClip(d, clip, [PASTE_OFFSET, -PASTE_OFFSET]);
    // 返回值只用于「粘贴后主选谁」；多选由下面的 selectMany 补齐
    return added.length ? added[0] : undefined;
  });
  if (!added.length) return false;
  selectMany(added[0], added.slice(1));
  return true;
}

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
// initTabs 的首次 select 不触发 onChange，这里补一次，面板工具条才不会错档显示
syncPanelTools($("#ed-layers"), panelTabs.left.current());

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
  if (doc && dirty && !projectDir) {
    const yes = await confirmDialog({
      title: et("dlg.discardTitle"),
      body: et("lib.discardConfirm", { title: doc.title }),
      ok: et("dlg.discardOk"),
      danger: true,
    });
    if (!yes) return;
  }
  if (!libraryKindOf(it)) {
    log(et("log.libUnsupported", { title: it.title, type: it.type }), "warn");
    return;
  }
  await openWith(it.title, () => openLibraryItem(it, MEDIA_BASE, WEB_BASE), { origin: { kind: "library" }, library: it, play: true });
  // 打开作品后左栏落回图层树：接下来要做的是编辑，不是继续挑壁纸
  panelTabs.left.select("layers");
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

/** 仓库地址（标题栏 GitHub 图标）：与 package.json 的 repository 保持一致 */
const GH_URL = "https://github.com/oneincase/webwallgl";

for (const b of docsSwitchBtns) b.onclick = () => showDocs(asDocKind(b.dataset.doc) ?? docKind);
$<HTMLButtonElement>("#ed-help").onclick = () => showDocs("editor");
$<HTMLButtonElement>("#gh-btn").onclick = () => {
  // 标题栏右上角的 GitHub 图标：新窗口打开仓库（noopener：别把本页交给对方脚本）
  window.open(GH_URL, "_blank", "noopener");
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
            const yes = await confirmDialog({
              title: et("dlg.vdirDelTitle"),
              body: et("vdir.delConfirm", { name: rec.name }),
              ok: et("dlg.vdirDelOk"),
              danger: true,
            });
            if (!yes) return;
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

// ---------- 未保存编辑的找回（计划 §2 C3） ----------

/** 关掉未保存草稿横幅 */
function hideDraftRecover() {
  draftRecoverEl.hidden = true;
  pendingDraft = null;
}

/**
 * 把快照套回当前文档：草稿 → 重开 → 逐字段一致（判据见 scripts/verify-editor.mjs 的 DRAFT-2）。
 * 调用点都在 openWith 的 after 里（首次挂载之前），所以这里不再自己 mount。
 */
function applyDraftSnapshot(d: Draft) {
  const target = doc;
  if (!target) return;
  applyDraft(target, d);
  // 快照里的叠加层文件：第一个用 put，其余 share 到同一组（和旧的还原路径口径一致）
  const groups = new Map<string, string>();
  for (const f of d.files) {
    const g = Array.isArray(f.group) ? f.group[0] : f.group;
    if (!g) {
      overlay?.put(f.name, f.data);
      continue;
    }
    const owner = groups.get(g);
    if (!owner) {
      overlay?.put(f.name, f.data, g);
      groups.set(g, f.name);
    } else overlay?.share(owner, f.name);
  }
  docDriven = true;
  markDirty();
  log(et("log.draftRestored", { title: d.title }));
}

/**
 * 启动时查草稿：最新的那槽能用就用它；带 ?item=<库条目> 时只认这一条的草稿。
 * 与「重开上次的目录」那条横幅互不顶替（同一个内置工程也可能有未保存编辑，两条都提示，
 * 尺寸见 editor.css：同时出现时上下排开），所以这里不看另一条横幅的 DOM 状态。
 */
async function checkDraftRecovery() {
  let slots: DraftSlotInfo[] = [];
  try {
    slots = await draftStore.list();
  } catch (e) {
    log(et("log.draftFailed", { msg: (e as Error).message }), "warn");
    return;
  }
  if (!slots.length) return;
  const item = new URL(location.href).searchParams.get("item");
  for (const info of slots) {
    const d = await draftStore.load(info.slot);
    if (!d) continue;
    if (item && (d.origin.kind !== "library" || d.origin.itemId !== item)) continue;
    pendingDraft = { slot: info.slot, draft: d };
    draftRecoverTextEl.textContent = et("draft.unsavedFound", {
      title: d.title,
      time: new Date(d.savedAt).toLocaleString(),
    });
    draftRecoverEl.hidden = false;
    return;
  }
}

/** 点「恢复」：按来源把原始资源重开回来，再把快照套上去 */
async function restoreDraft(pending: { slot: string; draft: Draft }) {
  hideDraftRecover();
  const d = pending.draft;
  const from = d.origin;
  const apply = () => applyDraftSnapshot(d);
  if (from.kind === "library") {
    const id = from.itemId;
    const fetched = await fetchLibrary().catch(() => null);
    const it = libraryPanel.find(id) ?? fetched?.items.find((x) => x.itemId === id);
    if (!it) {
      log(et("log.draftMissing", { id }), "error");
      return;
    }
    await openWith(d.title, () => openLibraryItem(it, MEDIA_BASE, WEB_BASE), {
      origin: { kind: "library" },
      library: it,
      after: apply,
    });
    return;
  }
  if (from.kind === "virtual") {
    const dir = await openVirtualProject(from.id).catch(() => null);
    if (!dir) {
      log(et("log.vdirMissing", { name: d.title }), "warn");
      return;
    }
    const files = await filesFromDirectory(dir).catch(() => []);
    adoptProject(dir);
    // 目录还在就按目录重开；目录空了（存储被清过）快照就是唯一副本，按它重建，
    // adopt 回原目录后自动保存会把这份工程重新写回去。
    await openWith(
      d.title,
      async () => (files.length ? openLocalFiles(files) : newOpened(d.title, d.project ?? newProject(d.title), d.scene)),
      { origin: { kind: "local" }, docDriven: !files.length, after: apply },
    );
    log(et("log.vdirResumed", { name: dir.name }));
    return;
  }
  // 会话内 / 本地文件夹：来源文件已经不可及（句柄失效），按快照在内存里重建；
  // origin 照旧，脚本放行策略不因为「恢复草稿」被放宽
  releaseProject();
  await openWith(d.title, async () => newOpened(d.title, d.project ?? newProject(d.title), d.scene), {
    origin: { kind: from.kind === "local" ? "local" : "new" },
    docDriven: true,
    after: apply,
  });
  // 重建后这个文档没有文件夹 / 库条目了，槽会从 local: / 原来那槽挪到会话槽：
  // 先把快照落到新槽、再清旧槽（顺序反了会有一次「清完还没写」的窗口），
  // 否则旧槽留着下次启动还会再冒出来一条。
  const nowSlot = currentDraftSlot();
  if (nowSlot !== pending.slot) {
    try {
      await draftStore.save(d, nowSlot);
      draftWrittenAt = Date.now();
      lastDraftSlot = nowSlot;
      await draftStore.clear(pending.slot);
    } catch (e) {
      log(et("log.draftFailed", { msg: (e as Error).message }), "warn");
    }
  }
}

draftRecoverRestoreEl.onclick = () => {
  const p = pendingDraft;
  hideDraftRecover();
  if (p) void restoreDraft(p);
};
draftRecoverDiscardEl.onclick = () => {
  const p = pendingDraft;
  hideDraftRecover();
  if (!p) return;
  if (lastDraftSlot === p.slot) lastDraftSlot = null;
  void draftStore.clear(p.slot).catch((e: unknown) => log(et("log.draftFailed", { msg: (e as Error).message }), "warn"));
};

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
  if (document.visibilityState === "hidden") flushPendingSave();
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

/** 打开「新建」菜单（锚在工具条按钮下方）；重复调用只重新摆位，不切换（空态按钮要用） */
function openNewMenu() {
  closeExportMenu();
  const r = newEl.getBoundingClientRect();
  newMenuEl.style.left = `${r.left}px`;
  newMenuEl.style.top = `${r.bottom + 2}px`;
  newMenuEl.hidden = false;
}

newEl.onclick = (e) => {
  e.stopPropagation();
  if (!newMenuEl.hidden) {
    closeNewMenu();
    return;
  }
  openNewMenu();
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

// 空态的两个出口：打开壁纸库 / 新建项目
// [2026-11 修复] 这里必须 stopPropagation + openNewMenu：原来写的是 `() => newEl.click()`，
// 合成 click 被 newEl 自己的 stopPropagation 挡住没问题，但**用户这次真实点击**还会继续冒泡到
// 下面的 document 监听（「点到菜单外就关」），而 #empty-new 显然不在 #new-menu 里 ——
// 菜单刚打开就被关上，用户看到的就是「点新建项目没反应」。空态按钮是「打开」语义，不做开/关切换。
$<HTMLButtonElement>("#empty-library").onclick = () => panelTabs.left.select("library");
$<HTMLButtonElement>("#empty-new").onclick = (e) => {
  e.stopPropagation();
  openNewMenu();
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
// 容器层 / 全屏后期层：预置参数的结构编辑（可撤销），新层进树后由检视器改旗标
const lyAddContainerEl = $<HTMLButtonElement>("#ly-add-container");
lyAddContainerEl.onclick = () => addContainer();
const lyAddPostEl = $<HTMLButtonElement>("#ly-add-post");
lyAddPostEl.onclick = () => addContainer("post");
// M4 A6：light / camera 直接建层（无模板菜单），走 addKindLayer → LayerKindDef.create
const lyAddLightEl = $<HTMLButtonElement>("#ly-add-light");
lyAddLightEl.onclick = () => addKindLayer("light");
const lyAddCameraEl = $<HTMLButtonElement>("#ly-add-camera");
lyAddCameraEl.onclick = () => addKindLayer("camera");
lyUpEl.onclick = () => moveSelected(-1);
lyDownEl.onclick = () => moveSelected(1);
lyDupEl.onclick = () => duplicateSelected();
lyDelEl.onclick = () => deleteSelected();
const lyGroupEl = $<HTMLButtonElement>("#ly-group");
lyGroupEl.onclick = () => groupSelected();
const lyUngroupEl = $<HTMLButtonElement>("#ly-ungroup");
lyUngroupEl.onclick = () => ungroupSelected();
// 树搜索 / 折叠全部 / 隔离（C2）的事件绑定（元素引用在文件顶部）
filterEl.addEventListener("input", () => setTreeQuery(filterEl.value));
filterEl.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  filterEl.value = "";
  setTreeQuery("");
});
filterClearEl.onclick = () => {
  filterEl.value = "";
  setTreeQuery("");
  filterEl.focus();
};
treeCollapseEl.onclick = () => setAllCollapsed(true);
treeExpandEl.onclick = () => setAllCollapsed(false);
treeIsolateEl.onclick = () => toggleIsolate();

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

/** 选中的层里有没有「带子层的组」——取消成组按钮的可用条件 */
function ungroupable(): boolean {
  if (!doc || doc.type !== "scene") return false;
  return selectionNodes().some((n) => n.children.length > 0 && !isLocked(n.id));
}

function ungroupSelected() {
  const nodes = selectionNodes();
  if (!nodes.length || !doc) return;
  const ids = nodes.map((n) => n.id);
  let bad: { reason: Exclude<PlaceResult, "ok" | "noop">; at?: number | string } | null = null;
  structEdit(et("log.multiUngrouped", { n: ids.length }), (d) => {
    const r = ungroupAll(d, ids);
    if (r.ok) return r.ids[0] ?? undefined;
    if (r.reason !== "ok" && r.reason !== "noop") bad = { reason: r.reason, at: r.at };
    return undefined;
  });
  if (bad) {
    const b: { reason: Exclude<PlaceResult, "ok" | "noop">; at?: number | string } = bad;
    log(et(PLACE_BAD[b.reason], { name: nodeName(b.at ?? ids[0]) }), "warn");
  }
}

function syncLayerTools() {
  const off = !selectedNode() || !current?.assets || doc?.type !== "scene";
  for (const b of [lyUpEl, lyDownEl, lyGroupEl, lyUngroupEl, lyDupEl, lyDelEl]) b.disabled = off;
  lyUngroupEl.disabled = off || !ungroupable();
  lyAddEl.disabled = !overlay || doc?.type !== "scene";
  lyAddTextEl.disabled = lyAddEl.disabled;
  lyAddParticleEl.disabled = lyAddEl.disabled;
  lyAddSoundEl.disabled = lyAddEl.disabled;
  lyAddContainerEl.disabled = lyAddEl.disabled;
  lyAddPostEl.disabled = lyAddEl.disabled;
  lyAddVideoEl.disabled = lyAddEl.disabled;
  lyAddModelEl.disabled = lyAddEl.disabled;
  // 树工具：折叠/展开只在场景可用；隔离只在有选中层时可用
  const treeOff = !doc || doc.type !== "scene";
  treeCollapseEl.disabled = treeOff;
  treeExpandEl.disabled = treeOff;
  treeIsolateEl.disabled = treeOff || !selectionNodes().length;
  treeIsolateEl.classList.toggle("is-on", isolateIds.size > 0);
  // M4 A6：按钮可用性也由注册表的能力位决定 —— 没有 create 的种类按钮就是灰的
  lyAddLightEl.disabled = lyAddEl.disabled || !canCreateLayerOfKind("light");
  lyAddCameraEl.disabled = lyAddEl.disabled || !canCreateLayerOfKind("camera");
}

function renderTree() {
  syncLayerTools();
  treeEl.setAttribute("aria-label", et("tree.aria"));
  treeEl.textContent = "";
  layerCountEl.textContent = "";
  if (!doc) {
    treeEl.appendChild(note(et("layers.none")));
    syncTreeFocus();
    return;
  }
  if (doc.type === "web") {
    // 网页壁纸工程没有图层树：工程本体是入口 html + 那堆站点文件，这里报个文件数
    const n = current?.assets ? current.assets.list().length + 1 : 0;
    treeEl.appendChild(note(n ? et("layers.webProject", { n }) : et("layers.notScene", { type: doc.type })));
    syncTreeFocus();
    return;
  }
  if (doc.type !== "scene") {
    treeEl.appendChild(note(doc.video ? et("vp.layers") : et("layers.notScene", { type: doc.type })));
    syncTreeFocus();
    return;
  }
  layerCountEl.textContent = et("layers.count", { n: doc.objectCount });
  const entries = treeEntries();
  const view = treeView(entries);
  if (view.stats) layerCountEl.textContent = et("tree.count", { n: view.visible.size, total: doc.objectCount });
  if (!view.visible.size && view.filtering) {
    treeEl.appendChild(note(et("tree.searchNone")));
    syncTreeFocus();
    return;
  }
  const frag = document.createDocumentFragment();
  const walk = (nodes: LayerNode[], depth: number) => {
    for (const n of nodes) {
      if (!view.visible.has(String(n.id))) continue;
      // 过滤中忽略折叠（否则命中项会被折叠的祖先挡掉）；平时尊重折叠状态
      const expanded = !n.children.length || (view.filtering || !collapsed.has(n.id));
      frag.appendChild(treeRow(n, depth, view.matched.has(String(n.id)), expanded));
      if (n.children.length && expanded) walk(n.children, depth + 1);
    }
  };
  walk(doc.roots, 0);
  treeEl.appendChild(frag);
  syncTreeFocus();
}

// ---------- 图层树无障碍（C5 / M9）：roving tabindex + 方向键导航 ----------
// 行本身仍是平铺的 div[role=treeitem]（层级靠 aria-level 表达，与 paddingLeft 的视觉缩进一致），
// 容器是 #ed-tree[role=tree][aria-multiselectable]。多选依旧走 ⇧/⌘ 点击，这里只动焦点与主选。

/** 当前视图里按顺序排好的树行 */
function treeRows(): HTMLElement[] {
  return [...treeEl.querySelectorAll<HTMLElement>(".ed-node")];
}

/** dataset 里的 id 是字符串、文档里的 id 可能是数字：两种都试（findNode 是 === 比较） */
function treeNodeOf(id: string): LayerNode | null {
  if (!doc) return null;
  const direct = findNode(doc.roots, id);
  if (direct) return direct;
  const num = Number(id);
  return Number.isFinite(num) ? findNode(doc.roots, num) : null;
}

/** roving tabindex：焦点行 tabindex=0、其余 -1；焦点行不在视图里就退回第一行（空树给 null） */
function syncTreeFocus() {
  const rows = treeRows();
  treeFocusId = firstFocusable(treeNavRows(rows), treeFocusId);
  for (const row of rows) row.tabIndex = row.dataset.id === treeFocusId ? 0 : -1;
}

/** 焦点落到某一行上（行已被 renderTree 重建时重新取一次） */
function focusTreeRow(id: string) {
  const row = treeRows().find((r) => r.dataset.id === id);
  if (!row) return;
  treeFocusId = id;
  for (const r of treeRows()) r.tabIndex = r.dataset.id === id ? 0 : -1;
  row.focus({ preventScroll: false });
}

/** 行的层级（aria-level 从 1 起，与深度 +1 对应） */
function treeLevel(row: HTMLElement): number {
  return Number(row.getAttribute("aria-level") ?? "1");
}

/** DOM 行 → 纯函数的视图：与行上的 aria-* 同源（有 aria-expanded 就是有子层） */
function treeNavRows(rows: HTMLElement[] = treeRows()): TreeNavRow[] {
  return rows.map((row) => {
    const expanded = row.getAttribute("aria-expanded");
    return { id: row.dataset.id ?? "", level: treeLevel(row), hasChildren: expanded !== null, expanded: expanded === "true" };
  });
}

/** 焦点 + 主选一起移动（与点选口径一致：清掉追加选中） */
function moveTreeFocus(row: HTMLElement | undefined) {
  if (!row?.dataset.id) return;
  const node = treeNodeOf(row.dataset.id);
  if (!node) return;
  selectLayer(node.id);
  focusTreeRow(row.dataset.id);
}

/** 展开/折叠一行：折叠集合是渲染状态的唯一来源，改完重绘并保住焦点 */
function setTreeExpanded(row: HTMLElement, expanded: boolean) {
  const id = row.dataset.id;
  const node = id === undefined ? null : treeNodeOf(id);
  if (!node || id === undefined) return;
  if (expanded) collapsed.delete(node.id);
  else collapsed.add(node.id);
  renderTree();
  focusTreeRow(id);
}

// 方向键的语义全在 editor/tree-nav.ts（纯函数，离线判据直接喂 fixture），这里只把动作落到 DOM。
treeEl.addEventListener("keydown", (e) => {
  const row = (e.target as HTMLElement | null)?.closest?.(".ed-node") as HTMLElement | null;
  if (!row || !doc || doc.type !== "scene") return;
  const rows = treeRows();
  const action = treeNav(treeNavRows(rows), rows.indexOf(row), e.key);
  if (!action) return;
  const target = rows[action.index];
  if (!target) return;
  e.preventDefault();
  if (action.kind === "expand") return void setTreeExpanded(target, true);
  if (action.kind === "collapse") return void setTreeExpanded(target, false);
  moveTreeFocus(target);
});

// ---------- 图层树搜索 / 隔离（C2）：视图过滤，不动文档与选中 ----------

let treeQuery = "";
const isolateIds = new Set<string>();

/** 把当前文档摊平成 tree-query 的条目表（id / parent / name） */
function treeEntries(): TreeEntry[] {
  const out: TreeEntry[] = [];
  const walk = (nodes: LayerNode[], parent: number | string | null) => {
    for (const n of nodes) {
      out.push({ id: n.id, parent, name: n.name || `#${n.id}` });
      walk(n.children, n.id);
    }
  };
  if (doc) walk(doc.roots, null);
  return out;
}

/** 计算本次渲染的可见 / 命中集合；搜索与隔离二选一（隔离优先） */
function treeView(entries: TreeEntry[]): { visible: Set<string>; matched: Set<string>; stats: boolean; filtering: boolean } {
  if (isolateIds.size) {
    const v = treeIsolateView(entries, [...isolateIds]);
    return { visible: v.visible, matched: v.matched, stats: true, filtering: true };
  }
  if (treePattern(treeQuery)) {
    const hits = treeSearchHits(entries, treeQuery);
    const v = treeVisible(entries, hits);
    return { visible: v.visible, matched: v.matched, stats: true, filtering: true };
  }
  return { visible: new Set(entries.map((e) => String(e.id))), matched: new Set(), stats: false, filtering: false };
}

function setTreeQuery(q: string) {
  treeQuery = q;
  filterClearEl.hidden = !q;
  renderTree();
}

/** 隔离：只显示选中层及其子树；再点一次取消。选中层链上的折叠一并展开，免得看不见 */
function toggleIsolate() {
  if (isolateIds.size) {
    isolateIds.clear();
  } else {
    const nodes = selectionNodes();
    if (!nodes.length) return;
    for (const n of nodes) {
      isolateIds.add(String(n.id));
      for (const p of findPath(doc?.roots ?? [], n.id)?.slice(0, -1) ?? []) collapsed.delete(p.id);
    }
  }
  syncLayerTools();
  renderTree();
}

/** 展开 / 折叠全部（整棵树，与当前过滤无关） */
function setAllCollapsed(all: boolean) {
  if (!doc) return;
  const walk = (nodes: LayerNode[]) => {
    for (const n of nodes) {
      if (!n.children.length) continue;
      if (all) collapsed.add(n.id);
      else collapsed.delete(n.id);
      walk(n.children);
    }
  };
  walk(doc.roots);
  renderTree();
}

// ---------- 锁定 / 解锁（A9）：写进文档的 locktransforms，并进撤销栈 ----------

/**
 * 反转锁定状态。期望值在点击时就固定下来（on = !当前），mutate 里不再重新开关：
 * 撤销 / 重做会带着快照重跑一次 mutate，这里必须幂等，否则第二次就翻回去了。
 */
function setLockedEdit(node: LayerNode, on: boolean) {
  const verb = et(on ? "log.locked" : "log.unlocked", { name: nodeName(node.id) });
  objEdit(verb, node.id, (o) => {
    if (isLockedObj(o) === on) return false;
    setLocked(o, on);
    return true;
  });
  renderTree();
  if (node.id === selectedId) renderInspector();
}

function note(text: string): HTMLElement {
  const p = document.createElement("p");
  p.className = "ed-note";
  p.textContent = text;
  return p;
}

function treeRow(n: LayerNode, depth: number, match = false, expanded = !collapsed.has(n.id)): HTMLElement {
  const row = document.createElement("div");
  row.className = "ed-node";
  row.setAttribute("role", "treeitem");
  // 无障碍状态（C5）：层级用 aria-level 表达（行是平铺的兄弟节点，靠它告诉读屏器缩进关系），
  // 展开态只给有子层的行；选中态与 .selected 类同源（主选 + ⇧/⌘ 追加的 extraSel）
  row.setAttribute("aria-level", String(depth + 1));
  row.setAttribute("aria-selected", String(n.id === selectedId || extraSel.has(String(n.id))));
  if (n.children.length) row.setAttribute("aria-expanded", String(expanded));
  if (n.id === selectedId) row.classList.add("selected");
  else if (extraSel.has(String(n.id))) row.classList.add("selected", "extra-selected");
  if (match) row.classList.add("match");
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
      setLockedEdit(n, !isLocked(n.id));
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
 * 结构编辑改指向（重挂）。mutate 在同一步里顺带改对象（删片段时删掉指向它的动画层）。fail = 文案前缀（bn / cl / wp）
 */
async function commitMdlEdit(
  layerId: number | string,
  label: string,
  slugTag: string,
  fail: "bn" | "cl" | "wp",
  edit: (bytes: Uint8Array) => Uint8Array | null,
  mutate?: (o: LayerNode["obj"]) => void,
  jsonEdit?: (json: Record<string, unknown>) => void,
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
  // P2：jsonEdit 在拷副本之前改原对象（mdlCopyFiles 内部 structuredClone）⇒ P2 状态跟着新 json 落盘
  if (modelJson && jsonEdit) jsonEdit(modelJson);
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

// ---------- 操控变形（Puppet Warp，伪 Live2D） ----------
// 图片层 → 木偶：按图片像素尺寸建规则三角网格，每个钉子一根纯平移骨，顶点权重是钉子的反距离权重
// （每顶点取前 4 根，与引擎蒙皮上限同口径）。拖钉子走引擎 setBonePose 实时预览（不进文档）；
// 「记录关键帧」把增量按钉写进 .mdl 片段轨道（一次可撤销的写时复制）；「烘焙形变」把形变吃进顶点、
// 骨架不动（改网格密度时按偏移场重采样）。几何 / 权重 / 编码全在 editor/warp.ts（纯函数、离线可测）。

/** 钉子命中半径 / 标记半径（CSS px） */
const WARP_TOL = 11;
const WARP_DOT = 3.5;
const WARP_DOT_ON = 6;
/** 网格密度选项（长边格数） */
const WARP_GRIDS = [16, 24, 32, 48];
/** 采样片段姿势时小于这个（模型 px）的偏差当作噪声，不当关键帧 */
const WARP_POSE_EPS = 0.5;

type WarpSession = {
  layer: number | string;
  modelPath: string;
  layout: WarpLayout;
  size: WarpSize;
  /** 当前网格几何（烘焙过就是吃过形变的顶点） */
  mesh: WarpMesh;
  /** 未记录的钉子位移（模型像素） */
  deltas: Map<number, [number, number]>;
  drag: { pin: number; pointerId: number; x0: number; y0: number; base: [number, number]; moved: boolean } | null;
  /** P1 几何（细分 / 切片 / Padding / Lock / Edit Topology）；null = 还没生成过，网格就是默认密度网格 */
  geometry: GeometrySpec | null;
  /** P1 角色表参数与命名（逐像素掩码只活在会话里，不落盘） */
  limbs: LimbsMeta | null;
  /** P1 角色表会话（原图像素 + limb 掩码）；面板打开时才建 */
  sheet: SheetState | null;
  /** 部件表（limb 分割或几何分行产生）；跟着 .mdl 一起写 */
  parts: MdlPart[] | null;
  partsFrom: "sheet" | "geometry" | null;
  /** P2 骨架（骨名 / 父级 / 位置；null = 还是 P0 的钉子骨） */
  skeleton: SkeletonSpec | null;
  /** P2 4 槽权重（每顶点 4 槽；顶点来自 .mdl，json 只记 locked） */
  skin: WeightSkin | null;
  skelVerts: Float32Array | null;
  skelIndices: Uint32Array | null;
  skelVertexCount: number;
  /** .mdl 里当前的骨数（写权重前用它校验骨号对得上） */
  skelBoneCount: number;
  skelParts: MdlPart[] | null;
  wtLocked: boolean;
};

/** P1 角色表会话：贴图像素 + 参数 + limb 掩码（掩码不落盘，重开工程按参数重算） */
type SheetState = {
  texture: string;
  image: SheetImage;
  spec: SheetSpec;
  limbs: LimbMask[];
  background: Uint8Array;
  view: SheetView;
  paint: PaintMode;
  /** Mask 开关：画笔 / 多边形改的是当前 limb 的掩码（否则改的是背景掩码） */
  maskEdit: boolean;
  active: number;
  radius: number;
  stroke: { erase: boolean; last: [number, number] } | null;
  polygon: Array<[number, number]>;
  /** 叠加层缓存版本号：掩码 / 视图变了就自增 */
  rev: number;
};

/** 几何 / 角色表面板开关（跟着操控变形会话走；"geometry" = 网格与拓扑，"sheet" = Character Sheet） */
let geomMode: "geometry" | "sheet" | null = null;
/** 下一次点画面加哪条切片（"x" = 竖切，"y" = 横切；null = 没待命） */
let geomArm: "x" | "y" | null = null;
/** Edit Topology 待命：点画面翻转所在格的三角剖分 */
let geomTopo = false;
/** 顶点偏移拖动（Edit Topology：Alt + 拖最近顶点，松手落盘） */
let geomVertex: { vertex: number; pointerId: number; x0: number; y0: number; dx: number; dy: number } | null = null;

/** 悬停高亮的钉子（-1 = 没有） */
let warpHover = -1;

/** 会话对应的层节点；换选中层 / 层没了就当没开会话 */
function warpTarget(): { node: LayerNode; session: WarpSession } | null {
  if (!warpSession || !doc || String(warpSession.layer) !== String(selectedId)) return null;
  const node = findNode(doc.roots, warpSession.layer);
  return node ? { node, session: warpSession } : null;
}

function warpModelInfo(id: number) {
  return editor && Number.isFinite(id) ? editor.getModelInfo(id) : null;
}

/** 模型 json 的钉子布局：命中缓存同步返回；没读过就异步读一次（读完补一次检视器 / 叠加层） */
function warpLayoutOf(modelPath: string): WarpLayout | null {
  const hit = warpLayoutCache.get(modelPath);
  if (hit !== undefined) return hit;
  const assets = overlay;
  if (assets && modelPath && !warpLoadingPaths.has(modelPath)) {
    const tries = warpLayoutTries.get(modelPath) ?? 0;
    warpLoadingPaths.add(modelPath);
    // 读到了就是定论（json 里没有布局 = 普通图片层，缓存 null 不再重读）；
    // 读失败只是打开文档 / 换资产目录时的瞬时状态，**不能**当结论缓存下来——否则重开工程后
    // 操控变形分组会因为一次读失败而永久消失（挂载会清空缓存，但之后没人再重挂）。
    const settle = (lay: WarpLayout | null, retry: boolean) => {
      warpLoadingPaths.delete(modelPath);
      if (lay) {
        warpLayoutTries.delete(modelPath);
        warpLayoutCache.set(modelPath, lay);
        renderInspector();
        drawOverlay();
        return;
      }
      warpLayoutTries.set(modelPath, tries + 1);
      if (retry && tries + 1 < WARP_LAYOUT_TRIES) {
        window.setTimeout(() => {
          renderInspector();
          drawOverlay();
        }, 250);
        return;
      }
      warpLayoutCache.set(modelPath, null);
    };
    void assets
      .read(modelPath)
      .then((bytes) => {
        let lay: WarpLayout | null = null;
        if (bytes) lay = layoutOf(parseJsonBytes(bytes));
        settle(lay, !bytes);
      })
      .catch(() => settle(null, true));
  }
  return null;
}

/** 图片尺寸（模型 json 的 width / height，退回图层 size 字段）；建网格 / 重采样都要 */
function warpSizeOf(node: LayerNode, json: Record<string, unknown> | null): WarpSize | null {
  const w = Number(json?.width) || 0;
  const h = Number(json?.height) || 0;
  if (w > 0 && h > 0) return { width: w, height: h };
  const raw = typeof node.obj.size === "string" ? node.obj.size.trim().split(/\s+/) : [];
  const sw = Number(raw[0]);
  const sh = Number(raw[1]);
  return sw > 0 && sh > 0 ? { width: sw, height: sh } : null;
}

/** 源材质 json（把图片层那张材质的合成方式带到新木偶上：贴图路径原样沿用） */
async function warpSourceMaterial(modelJson: Record<string, unknown> | null): Promise<Record<string, unknown> | null> {
  const path = modelJson && typeof modelJson.material === "string" ? modelJson.material : "";
  return path && overlay ? parseJsonBytes(await overlay.read(path)) : null;
}

/** 新 slug：三件套（模型 json / .mdl / 材质 json）都不撞 */
function warpSlug(name: unknown, tag: string): string {
  const assets = overlay!;
  const listed = new Set(assets.list());
  return imageSlug(`${String(name || "image").replace(/\./g, "-")}-${tag}`, (s) =>
    [modelPathOf(s), editorMdlOf(s), editorMaterialOf(s)].some((p) => assets.has(p) || listed.has(p)),
  );
}

/** 每个钉子的绑定姿势屏幕位置：轮廓中心 + 局部坐标沿轮廓两轴投影（采样动画位移的参照） */
function warpBindScreen(session: WarpSession): Array<[number, number] | null> {
  const corners = editor?.getLayerOutline(Number(session.layer))?.corners;
  if (!corners || corners.length !== 4) return session.layout.pins.map(() => null);
  const c: [number, number] = [
    corners.reduce((s, p) => s + p[0], 0) / 4,
    corners.reduce((s, p) => s + p[1], 0) / 4,
  ];
  return session.layout.pins.map((p) => {
    const local = pinLocal(p, session.size);
    const shift = warpScreenShift(session, [local[0], local[1]]);
    return [c[0] + shift[0], c[1] + shift[1]];
  });
}

/**
 * 按帧采样片段里**已经记录**的姿势：页面读不出 .mdl 的轨道（也不许自己解析），只能把播放头
 * 逐帧走一遍，用 getBonePoints 量每根钉骨相对绑定姿势偏了多少（和拖动同一套坐标换算）。
 * 采样期间先撤掉预览位移（预览要进顶点、不进轨道），采完把播放头与预览原样放回去。
 * 返回的 poses 交给 buildRig 写进新 .mdl ⇒ 加钉子 / 删钉子 / 改衰减 / 改密度 / 烘焙都不丢关键帧。
 */
async function warpSamplePoses(session: WarpSession): Promise<WarpPoses> {
  if (!editor) return [];
  const node = doc && findNode(doc.roots, session.layer);
  const info = node ? warpModelInfo(Number(session.layer)) : null;
  const clip = info?.animations.find((c) => c.id === WARP_CLIP_ID) ?? info?.animations[0];
  if (!node || !clip || clip.frames < 2) return [];
  const rate = getAnimLayers(node.obj).find((l) => l.animation === clip.id)?.rate ?? 1;
  const id = Number(session.layer);
  const bind = warpBindScreen(session);
  const preview = new Map(session.deltas);
  const t0 = editor.time;
  const last = Math.min(WARP_FRAMES, clip.frames - 1);
  const poses: (PinDeltas | null)[] = [];
  try {
    warpClearPoses(session);
    for (let f = 0; f <= last; f++) {
      await editor.seek(f / (WARP_FPS * (rate || 1)));
      const pts = editor.getBonePoints(id);
      const frame = new Map<number, readonly [number, number]>();
      for (let i = 0; i < session.layout.pins.length; i++) {
        const s = pts?.[i + 1]?.screen;
        const b = bind[i];
        if (!s || !b) continue;
        const d = warpDeltaOf(session, s[0] - b[0], s[1] - b[1]);
        // 亚像素噪声不算关键帧：真拖过是几十像素
        if (Math.abs(d[0]) < WARP_POSE_EPS && Math.abs(d[1]) < WARP_POSE_EPS) continue;
        frame.set(i, d);
      }
      poses.push(frame.size ? frame : null);
    }
  } catch {
    // 采样失败就退化成「重建一份没有关键帧的片段」，别让写盘整个失败
  } finally {
    await editor.seek(t0).catch(() => {});
    for (const [pin, v] of preview) warpSetDelta(session, pin, [v[0], v[1]]);
  }
  return poses;
}

/** 写一份新的 .mdl 三件套并改指向（一步可撤销）；未记录的位移随之清掉（和骨骼面板「应用」同口径） */
async function warpWrite(
  session: WarpSession,
  layout: WarpLayout,
  mesh: WarpMesh,
  label: string,
  opts?: { geometry?: GeometrySpec | null; parts?: MdlPart[] | null; partsFrom?: "sheet" | "geometry" | null },
): Promise<boolean> {
  const d = doc;
  const assets = overlay;
  if (!d || !assets) return false;
  const node = findNode(d.roots, session.layer);
  const srcJson = parseJsonBytes(await assets.read(session.modelPath));
  if (!node || !srcJson) {
    log(et("wp.fail.read", { path: session.modelPath }), "warn");
    return false;
  }
  if (d !== doc) return false;
  const slug = warpSlug(node.obj.name, "warp");
  const modelPath = modelPathOf(slug);
  const poses = remapPoses(await warpSamplePoses(session), session.layout, layout);
  if (d !== doc) return false;
  // P1：几何（细分 / 切片 / Padding / 拓扑）与部件表照旧进 .mdl；创作态进 puppetWarp 容器
  const geometry = opts && "geometry" in opts ? (opts.geometry ?? null) : session.geometry;
  const parts = opts && "parts" in opts ? (opts.parts ?? null) : session.parts;
  const partsFrom = opts && "partsFrom" in opts ? (opts.partsFrom ?? null) : session.partsFrom;
  const files = warpFiles(
    buildRig(layout, session.size, editorMaterialOf(slug), undefined, poses, { mesh, parts }),
    slug,
    await warpSourceMaterial(srcJson),
    { geometry, limbs: session.limbs },
  );
  if (d !== doc) return false;
  warpClearPoses(session);
  session.deltas.clear();
  for (const f of files) assets.put(f.name, f.data, modelPath);
  assets.share(session.modelPath, modelPath);
  warpLayoutCache.set(modelPath, layout);
  structEdit(label, (dd) => {
    const n = findNode(dd.roots, session.layer);
    if (!n) return undefined;
    n.obj.image = modelPath;
    n.obj.size = `${session.size.width} ${session.size.height}`;
    dd.puppets = new Map([...(dd.puppets ?? []), [modelPath, editorMdlOf(slug)]]);
    return n.id;
  });
  if (d === doc) {
    session.modelPath = modelPath;
    session.layout = layout;
    session.mesh = mesh;
    session.geometry = geometry;
    session.parts = parts;
    session.partsFrom = partsFrom;
  }
  await warpResumeAfterWrite(session.layer, modelPath, layout, session.size, mesh);
  renderInspector();
  drawOverlay();
  return true;
}

/**
 * 结构编辑（写回 .mdl / 记录关键帧）一定会重挂：引擎换了实例，操控变形会话随之作废。
 * 写完等新实例把新模型装上去，再自动回到操控变形 —— 否则「加钉子 / 改衰减 / 记一帧」每次都把用户踢出模式。
 */
async function warpResumeAfterWrite(layer: number | string, modelPath: string, layout: WarpLayout, size: WarpSize, mesh?: WarpMesh): Promise<void> {
  const d = doc;
  for (let i = 0; i < 120; i++) {
    const node = d && findNode(d.roots, layer);
    const path = node ? String((node.obj as { image?: unknown }).image ?? "") : "";
    let mounted = false;
    try {
      mounted = !!editor?.getModelInfo(Number(layer));
    } catch {
      mounted = false;
    }
    if (d === doc && path === modelPath && mounted) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  // 中途换了工程 / 换选中别的层就别再自动进入
  if (d !== doc || selectedId === null || String(selectedId) !== String(layer)) return;
  if (warpSession) return;
  await warpEnter(layer, { modelPath, layout, size, mesh });
}

/** 布局变了：网格几何照旧（烘焙过的顶点要留着），只按新钉子重算权重；密度变了才重采样顶点 */
function warpMeshFor(session: WarpSession, layout: WarpLayout): WarpMesh {
  if (layout.cols === session.mesh.cols && layout.rows === session.mesh.rows) return session.mesh;
  const base = buildMesh(layout, session.size);
  return { ...base, positions: resamplePositions(session.mesh, layout.cols, layout.rows, session.size) };
}

/** 图片层 → 操控变形木偶：三件套落盘 + 改指向，origin / scale / 角度 / 尺寸照旧 ⇒ 画面逐像素不变 */
async function warpPromote(node: LayerNode): Promise<boolean> {
  const d = doc;
  const assets = overlay;
  const srcModel = String(node.obj.image ?? "");
  if (!d || !assets || !editor || node.kind !== "image" || node.modelForm || !srcModel) return false;
  const srcJson = parseJsonBytes(await assets.read(srcModel));
  const size = warpSizeOf(node, srcJson);
  if (!size) {
    log(et("wp.fail.size", { path: srcModel }), "warn");
    return false;
  }
  if (d !== doc) return false;
  const slug = warpSlug(node.obj.name, "warp");
  const layout = defaultLayout(size);
  const modelPath = modelPathOf(slug);
  const files = warpFiles(buildRig(layout, size, editorMaterialOf(slug)), slug, await warpSourceMaterial(srcJson));
  if (d !== doc) return false;
  for (const f of files) assets.put(f.name, f.data, modelPath);
  assets.share(srcModel, modelPath);
  warpLayoutCache.set(modelPath, layout);
  structEdit(et("log.warpPromoted", { layer: nodeName(node.id) }), (dd) => {
    const n = findNode(dd.roots, node.id);
    if (!n) return undefined;
    n.obj.image = modelPath;
    n.obj.size = `${size.width} ${size.height}`;
    dd.puppets = new Map([...(dd.puppets ?? []), [modelPath, editorMdlOf(slug)]]);
    addAnimLayer(dd, n.obj, WARP_CLIP_ID, WARP_CLIP_NAME);
    return n.id;
  });
  // 结构编辑换了实例：编辑器此刻正在重挂（editor 已经销毁），必须等新实例把新模型装上再进模式
  await warpResumeAfterWrite(node.id, modelPath, layout, size);
  return true;
}

/** 进入操控变形：读回布局与图片尺寸，建会话（引擎里只有 setBonePose 预览） */
async function warpEnter(layer: number | string, known?: { modelPath: string; layout: WarpLayout; size: WarpSize; mesh?: WarpMesh }): Promise<boolean> {
  const d = doc;
  const assets = overlay;
  if (!d || !assets || !editor) return false;
  const node = findNode(d.roots, layer);
  if (!node || node.modelForm !== "puppet") return false;
  const modelPath = known?.modelPath ?? String(node.obj.image ?? "");
  const json = parseJsonBytes(await assets.read(modelPath));
  const layout = known?.layout ?? layoutOf(json);
  const size = known?.size ?? warpSizeOf(node, json);
  warpLayoutCache.set(modelPath, layout);
  if (!layout || !size) {
    log(et(layout ? "wp.fail.size" : "wp.fail.layout", { path: modelPath }), "warn");
    return false;
  }
  if (d !== doc) return false;
  warpExit();
  // P1：几何 / 角色表参数从 puppetWarp 容器读回（老工程没有这两块，退回默认）
  const geometry = geometryOf(json);
  const limbs = parseLimbsMeta(puppetSub(json, "limbs"));
  // 顶点可能已经被烘焙过（形变吃进顶点）：密度对得上就沿用会话里的那份，否则按几何（有的话）或规则网格重建
  const fromGeometry = geometry ? buildGeometry(geometry, size) : null;
  // 复用会话里的网格要比**几何的有效密度**（cols×subdivision）——v1 的 warp.cols/rows 只有基础格数
  const wantCols = fromGeometry ? fromGeometry.cols : layout.cols;
  const wantRows = fromGeometry ? fromGeometry.rows : layout.rows;
  const mesh =
    known?.mesh && known.mesh.cols === wantCols && known.mesh.rows === wantRows
      ? known.mesh
      : (fromGeometry ?? buildMesh(layout, size));
  const parts = geometry ? partsOf(geometry, mesh) : null;
  warpSession = {
    layer: node.id,
    modelPath,
    layout,
    size,
    mesh,
    deltas: new Map(),
    drag: null,
    geometry,
    limbs,
    sheet: null,
    parts,
    // 工程 json 里有角色表分割（limbs）但 .mdl 里没有部件表时，标记分割来自角色表：
    // 下一次几何重建会把按行分部件的三角划分换掉，据此给「部件已失效」的提示
    partsFrom: parts ? "geometry" : limbs ? "sheet" : null,
    skeleton: skeletonOf(json),
    skin: null,
    skelVerts: null,
    skelIndices: null,
    skelVertexCount: 0,
    skelBoneCount: 0,
    skelParts: null,
    wtLocked: weightsOf(json)?.locked ?? false,
  };
  log(et("log.warpStarted", { layer: nodeName(node.id), pins: layout.pins.length }));
  renderInspector();
  drawOverlay();
  return true;
}

/** 退出操控变形：撤掉引擎里的预览（未记录的位移丢弃） */
function warpExit() {
  const s = warpSession;
  warpSession = null;
  warpHover = -1;
  geomMode = null;
  geomArm = null;
  geomTopo = false;
  geomVertex = null;
  skelMode = null;
  skelArm = false;
  skelParentArm = false;
  skelSel = -1;
  skelPaintBone = -1;
  skelStroke = null;
  skelDepth = false;
  skelAdjCache = null;
  if (!s) return;
  warpClearPoses(s);
  renderInspector();
  drawOverlay();
}

function warpClearPoses(session: WarpSession) {
  if (!editor) return;
  for (let i = 0; i < session.layout.pins.length; i++) void editor.setBonePose(Number(session.layer), boneOfPin(i), null).catch(() => {});
}

function warpResetPreview(session: WarpSession) {
  warpClearPoses(session);
  session.deltas.clear();
  renderInspector();
  drawOverlay();
}

function warpSetDelta(session: WarpSession, pin: number, delta: [number, number]) {
  const zero = delta[0] === 0 && delta[1] === 0;
  if (zero) session.deltas.delete(pin);
  else session.deltas.set(pin, delta);
  void editor?.setBonePose(Number(session.layer), boneOfPin(pin), zero ? null : { t: [delta[0], delta[1], 0] }).catch(() => {});
}

/** 片段帧号（与骨骼面板同口径：动画层 rate × 当前时刻 → clipFrameAt） */
function warpFrameOf(node: LayerNode, info: NonNullable<ReturnType<typeof warpModelInfo>>): number {
  const clip = info.animations.find((c) => c.id === WARP_CLIP_ID) ?? info.animations[0];
  if (!clip || !editor) return 0;
  const rate = getAnimLayers(node.obj).find((l) => l.animation === clip.id)?.rate ?? 1;
  return Math.max(0, Math.min(clip.frames - 1, clipFrameAt(clip, editor.time * rate)));
}

/** 把未记录的钉子位移写进 .mdl 轨道（只改当前帧；半径 0 = 不向两侧淡出） */
async function warpRecord(session: WarpSession): Promise<boolean> {
  const node = doc && findNode(doc.roots, session.layer);
  const info = node ? warpModelInfo(Number(node.id)) : null;
  const moved = [...session.deltas.entries()].filter(([, v]) => v[0] !== 0 || v[1] !== 0);
  if (!node || !info || !moved.length) {
    log(et("wp.noDelta"), "warn");
    return false;
  }
  const frame = warpFrameOf(node, info);
  const ok = await commitMdlEdit(
    session.layer,
    et("log.warpRecorded", { layer: nodeName(session.layer), n: moved.length, frame }),
    "warp",
    "wp",
    (bytes) => {
      let out: Uint8Array | null = bytes;
      for (const [pin, v] of moved) {
        if (!out) return null;
        out = applyBoneDelta(out, WARP_CLIP_ID, boneOfPin(pin), frame, { t: [v[0], v[1], 0] }, 0);
      }
      return out;
    },
  );
  if (!ok) return false;
  session.deltas.clear();
  const after = doc && findNode(doc.roots, session.layer);
  if (after) session.modelPath = String(after.obj.image ?? session.modelPath);
  warpLayoutCache.set(session.modelPath, session.layout);
  await warpResumeAfterWrite(session.layer, session.modelPath, session.layout, session.size);
  renderInspector();
  drawOverlay();
  return true;
}

/** 烘焙形变：把预览位移吃进顶点（骨架不动，钉子还在网格原位） */
async function warpBake(session: WarpSession): Promise<boolean> {
  const moved = new Map([...session.deltas.entries()].filter(([, v]) => v[0] !== 0 || v[1] !== 0));
  if (!moved.size) {
    log(et("wp.noDelta"), "warn");
    return false;
  }
  const positions = displace(session.mesh, buildSkin(session.mesh, session.layout, session.size), moved);
  return warpWrite(session, session.layout, { ...session.mesh, positions }, et("log.warpBaked", { layer: nodeName(session.layer) }));
}

/** 加一根钉子：挑离现有钉子最远的候选点（5×5 候选里最空的） */
function warpAddPin(session: WarpSession) {
  if (session.layout.pins.length >= MAX_PINS) {
    log(et("wp.fail.maxPins", { n: MAX_PINS }), "warn");
    return;
  }
  let best: [number, number] = [0.5, 0.5];
  let far = -1;
  for (let j = 0; j <= 4; j++) {
    for (let i = 0; i <= 4; i++) {
      const c: [number, number] = [i / 4, j / 4];
      const near = session.layout.pins.reduce((m, p) => Math.min(m, Math.hypot(p[0] - c[0], p[1] - c[1])), Infinity);
      if (near > far) {
        far = near;
        best = c;
      }
    }
  }
  const layout = addPin(session.layout, best);
  if (layout) void warpWrite(session, layout, warpMeshFor(session, layout), et("log.warpRebuilt", { layer: nodeName(session.layer) }));
}

function warpRemovePin(session: WarpSession, index: number) {
  const layout = removePin(session.layout, index);
  if (layout) void warpWrite(session, layout, warpMeshFor(session, layout), et("log.warpRebuilt", { layer: nodeName(session.layer) }));
}

function warpSetPower(session: WarpSession, power: number) {
  const layout = withPower(session.layout, power);
  void warpWrite(session, layout, warpMeshFor(session, layout), et("log.warpRebuilt", { layer: nodeName(session.layer) }));
}

/** 网格密度（长边格数）→ 按长宽比换算 cols / rows，写回新网格（顶点按偏移场重采样） */
function warpSetGrid(session: WarpSession, base: number) {
  const g = gridFor(session.size);
  const k = base / MESH_BASE;
  const cols = Math.max(MESH_MIN, Math.min(MESH_MAX, Math.round(g.cols * k)));
  const rows = Math.max(MESH_MIN, Math.min(MESH_MAX, Math.round(g.rows * k)));
  // 几何已生成：密度改的是几何的 cols / rows（细分 / Padding / 拓扑都保留），不是规则网格
  if (session.geometry) {
    void geomWriteSession(session, withColsRows(session.geometry, cols, rows), et("log.warpRebuilt", { layer: nodeName(session.layer) }));
    return;
  }
  const layout = withGrid(session.layout, cols, rows);
  void warpWrite(session, layout, warpMeshFor(session, layout), et("log.warpRebuilt", { layer: nodeName(session.layer) }));
}

function warpGridBase(layout: WarpLayout): number {
  const long = Math.max(layout.cols, layout.rows);
  return WARP_GRIDS.reduce((best, g) => (Math.abs(g - long) < Math.abs(best - long) ? g : best), WARP_GRIDS[0]);
}

/** 屏幕命中钉子：跳过骨 0（根骨不是钉子），返回钉子下标，-1 = 没命中 */
function warpHitAt(layer: number | string, x: number, y: number): number {
  if (!editor) return -1;
  const pts = editor.getBonePoints(Number(layer));
  if (!pts?.length) return -1;
  return nearestPin(pts.slice(1).map((p) => p.screen), x, y, WARP_TOL);
}

/**
 * 屏幕位移 → 模型位移。用图层轮廓（OBB）的两条屏幕单位轴投影：轮廓已经把图层自身的
 * 旋转 / 缩放 / 视口缩放算进去了，所以这里除以「每模型单位多少屏幕像素」即可，不用再自己反解变换。
 * 注意 ay 是层局部**向下**的方向（c0 左上 → c3 左下），而模型空间 Y 向上 ⇒ y 分量要取负。
 */
function warpDeltaOf(session: WarpSession, dx: number, dy: number): [number, number] {
  const corners = editor?.getLayerOutline(Number(session.layer))?.corners;
  if (!corners || corners.length !== 4) return [dx, -dy];
  const { ax, ay } = layerAxes(corners);
  const kx = Math.hypot(corners[1][0] - corners[0][0], corners[1][1] - corners[0][1]) / session.size.width || 1;
  const ky = Math.hypot(corners[3][0] - corners[0][0], corners[3][1] - corners[0][1]) / session.size.height || 1;
  return [(dx * ax[0] + dy * ax[1]) / kx, -(dx * ay[0] + dy * ay[1]) / ky];
}

/** 模型位移 → 屏幕位移（warpDeltaOf 的逆）：给位移中的钉子画「原位 → 现在」的引线 */
function warpScreenShift(session: WarpSession, model: [number, number]): [number, number] {
  const corners = editor?.getLayerOutline(Number(session.layer))?.corners;
  if (!corners || corners.length !== 4) return [model[0], -model[1]];
  const { ax, ay } = layerAxes(corners);
  const kx = Math.hypot(corners[1][0] - corners[0][0], corners[1][1] - corners[0][1]) / session.size.width || 1;
  const ky = Math.hypot(corners[3][0] - corners[0][0], corners[3][1] - corners[0][1]) / session.size.height || 1;
  return [model[0] * kx * ax[0] - model[1] * ky * ay[0], model[0] * kx * ax[1] - model[1] * ky * ay[1]];
}

/** pointerdown：命中钉子就开始拖（返回 true = 这一下归操控变形管，不进手柄 / 框选） */
function warpGrab(e: PointerEvent, x: number, y: number): boolean {
  const t = warpTarget();
  if (!t) return false;
  const pin = warpHitAt(t.session.layer, x, y);
  if (pin < 0) return false;
  t.session.drag = { pin, pointerId: e.pointerId, x0: x, y0: y, base: [...(t.session.deltas.get(pin) ?? [0, 0])], moved: false };
  warpHover = pin;
  stageEl.setPointerCapture(e.pointerId);
  drawOverlay();
  return true;
}

/** pointermove：拖动中更新预览；没在拖就只更新悬停高亮 */
function warpDragMove(e: PointerEvent, x: number, y: number): boolean {
  // P2：骨架 / 权重模式是模态，钉子不许跟着指针走（pointermove 监听里没有 geomModal 守卫）
  if (geomModal()) return false;
  const t = warpTarget();
  if (!t) return false;
  const d = t.session.drag;
  if (!d) {
    const pin = warpHitAt(t.session.layer, x, y);
    if (pin !== warpHover) {
      warpHover = pin;
      stageEl.dataset.cursor = pin >= 0 ? "move" : "";
      drawOverlay();
    }
    return false;
  }
  if (e.pointerId !== d.pointerId) return true;
  d.moved = true;
  const [mx, my] = warpDeltaOf(t.session, x - d.x0, y - d.y0);
  warpSetDelta(t.session, d.pin, [d.base[0] + mx, d.base[1] + my]);
  drawOverlay();
  return true;
}

/** pointerup / cancel：结束拖动（位移留着，等「记录关键帧」写进 .mdl） */
function warpDrop(e: PointerEvent) {
  const t = warpTarget();
  const d = t?.session.drag;
  if (!t || !d || e.pointerId !== d.pointerId) return;
  t.session.drag = null;
  // 真拖过钉子：这一次指针抬起不算「点选」——否则松手落在空处会把选中层换掉（会话跟着退出，
  // 预览的形变当场回退）。钉子拖动不进 undo，记录关键帧才入栈。
  if (d.moved) suppressClick = true;
  renderInspector();
  drawOverlay();
}

/** 操控变形标记：钉子（骨 i+1）+ 位移引线 + 拖动 / 悬停高亮 */
function drawWarpPins() {
  const t = warpTarget();
  if (!t || !editor) return;
  const pts = editor.getBonePoints(Number(t.session.layer));
  if (!pts?.length) return;
  overlayCtx.lineWidth = 1.5;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i];
    if (!p.screen) continue;
    const pin = pinOfBone(i);
    const delta = t.session.deltas.get(pin);
    const on = t.session.drag?.pin === pin || warpHover === pin;
    if (delta && (delta[0] || delta[1])) {
      const [sx, sy] = warpScreenShift(t.session, delta);
      overlayCtx.setLineDash([3, 3]);
      overlayCtx.strokeStyle = "rgba(0,0,0,0.55)";
      overlayCtx.beginPath();
      overlayCtx.moveTo(p.screen[0] - sx, p.screen[1] - sy);
      overlayCtx.lineTo(p.screen[0], p.screen[1]);
      overlayCtx.stroke();
      overlayCtx.setLineDash([]);
    }
    overlayCtx.beginPath();
    overlayCtx.arc(p.screen[0], p.screen[1], on ? WARP_DOT_ON : WARP_DOT, 0, Math.PI * 2);
    overlayCtx.fillStyle = on ? SNAP_COLOR : delta && (delta[0] || delta[1]) ? "#ffb347" : "#ffd166";
    overlayCtx.fill();
    overlayCtx.strokeStyle = "rgba(0,0,0,0.65)";
    overlayCtx.stroke();
  }
}

/** 操控变形分组：普通 inspectorGroups（普通图片层也能拿到）→ 转木偶 / 进入 / 钉子与写回 */
function warpGroup(node: LayerNode): HTMLElement | null {
  const t = warpTarget();
  const open = !!t && String(t.node.id) === String(node.id);
  const isImage = node.kind === "image" && !node.modelForm;
  if (!isImage && !open && node.modelForm !== "puppet") return null;
  if (!isImage && !open && !warpLayoutOf(String(node.obj.image ?? ""))) return null;
  const group = document.createElement("div");
  group.className = "ed-insp-group ed-warp";
  const h = document.createElement("div");
  h.className = "ed-insp-title";
  h.textContent = et("insp.warp");
  group.appendChild(h);
  const editable = !!overlay && !isLocked(node.id);
  const action = (cls: string, key: string, onClick: () => void, disabled = false) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `ed-btn ${cls}`;
    b.dataset.et = key;
    b.textContent = et(key);
    b.disabled = disabled;
    b.onclick = onClick;
    return b;
  };
  if (isImage) {
    group.appendChild(note(et("wp.intro")));
    group.appendChild(action("ed-warp-make", "wp.promote", () => void warpPromote(node), !editable));
    return group;
  }
  if (!open) {
    group.appendChild(note(et("wp.ready")));
    group.appendChild(action("ed-warp-open", "wp.open", () => void warpEnter(node.id), !editable));
    return group;
  }
  const session = t!.session;
  const info = warpModelInfo(Number(node.id));
  const frame = info ? warpFrameOf(node, info) : 0;
  const moved = [...session.deltas.values()].filter((v) => v[0] !== 0 || v[1] !== 0).length;
  group.appendChild(note(et("wp.note", { n: session.layout.pins.length, max: MAX_PINS, frame, moved })));
  const list = document.createElement("div");
  list.className = "ed-warp-pins";
  session.layout.pins.forEach((_p, i) => {
    const item = document.createElement("div");
    item.className = "ed-fx-item";
    const label = document.createElement("span");
    label.className = "ed-fx-name";
    label.textContent = et("wp.pinN", { n: i + 1 });
    const del = document.createElement("button");
    del.type = "button";
    del.className = "ed-icon ed-warp-del";
    del.dataset.pin = String(i);
    del.textContent = "\u2715";
    del.title = et("wp.delPin");
    del.disabled = !editable || session.layout.pins.length <= 1;
    del.onclick = () => warpRemovePin(session, i);
    item.append(label, del);
    list.appendChild(item);
  });
  group.appendChild(list);
  group.appendChild(action("ed-warp-add", "wp.addPin", () => warpAddPin(session), !editable || session.layout.pins.length >= MAX_PINS));
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
  const power = document.createElement("input");
  power.type = "range";
  power.className = "ed-warp-power";
  power.min = String(POWER_MIN);
  power.max = String(POWER_MAX);
  power.step = "1";
  power.value = String(session.layout.power);
  power.disabled = !editable;
  power.addEventListener("change", () => warpSetPower(session, Number(power.value)));
  row("wp.power", power);
  const grid = document.createElement("select");
  grid.className = "ed-warp-grid";
  for (const g of WARP_GRIDS) {
    const o = document.createElement("option");
    o.value = String(g);
    o.textContent = `${g}`;
    grid.appendChild(o);
  }
  grid.value = String(warpGridBase(session.layout));
  grid.disabled = !editable;
  grid.addEventListener("change", () => warpSetGrid(session, Number(grid.value)));
  row("wp.grid", grid);
  group.appendChild(form);
  const actions = document.createElement("div");
  actions.className = "ed-insp-actions";
  actions.append(
    action("ed-warp-record", "wp.record", () => void warpRecord(session), !editable || !moved),
    action("ed-warp-reset", "wp.reset", () => warpResetPreview(session), !moved),
    action("ed-warp-bake", "wp.bake", () => void warpBake(session), !editable || !moved),
    action("ed-warp-exit", "wp.close", () => warpExit()),
  );
  group.appendChild(actions);
  return group;
}

// ---------- P1：几何（Geometry）与角色表（Character Sheet） ----------
// 方案 docs/PUPPET-WARP-FULL-PLAN.md §5 P1：几何决定网格本身（格数 / 细分 / 切片 / Padding /
// Lock geometry / Edit Topology），角色表决定部件表（limb 掩码 → 三角形归属 → .mdl parts 绘制序）。
// 两份创作态写进 model json 的 `puppetWarp`（geometry / limbs），逐像素掩码不落盘（按参数可重算）；
// 写盘一律走 warpWrite（写时复制 + 结构编辑 + 自动回到操控变形）⇒ 一步可撤销、原有元素零位移。

/** 几何 / 角色表分组只在「操控变形会话开着，且选中的就是那只木偶」时出现 */
function warpPanelOpen(node: LayerNode): boolean {
  const t = warpTarget();
  return !!t && String(t.node.id) === String(node.id);
}

/** 网格超过这个顶点数就不画线框（几万顶点画上去只会糊成一片） */
const GEOM_DRAW_MAX = 4096;

/** 当前会话：几何 / 角色表只作用于操控变形会话里的那只木偶 */
function geomTarget(): { node: LayerNode; session: WarpSession } | null {
  return warpTarget();
}

/**
 * 几何 / 角色表模式是**模态**的：指针事件全归它们（切片待命 / 拓扑翻转 / Alt 顶点偏移 / 涂抹），
 * 通用监听里的手柄、框选与钉子先让路（见文件末尾注册的 P1 指针监听）。
 */
function geomModal(): boolean {
  return (!!geomMode && !!geomTarget()) || skelModal();
}

/** 贴图像素 → 画布坐标的仿射（a,b,c,d,e,f 与 ctx.transform 同序；由层轮廓四角推出，旋转 / 缩放都吃） */
function layerAffine(session: WarpSession): [number, number, number, number, number, number] | null {
  const corners = editor?.getLayerOutline(Number(session.layer))?.corners;
  if (!corners || corners.length !== 4) return null;
  const { ax, ay } = layerAxes(corners);
  const w = session.size.width;
  const h = session.size.height;
  const kx = Math.hypot(corners[1][0] - corners[0][0], corners[1][1] - corners[0][1]) / w || 1;
  const ky = Math.hypot(corners[3][0] - corners[0][0], corners[3][1] - corners[0][1]) / h || 1;
  const cx = corners.reduce((s, p) => s + p[0], 0) / 4;
  const cy = corners.reduce((s, p) => s + p[1], 0) / 4;
  const a = kx * ax[0];
  const b = kx * ax[1];
  const c = ky * ay[0];
  const d = ky * ay[1];
  return [a, b, c, d, cx - (a * w) / 2 - (c * h) / 2, cy - (b * w) / 2 - (d * h) / 2];
}

/** 画布点 → 贴图像素（左上原点）；点不在层内返回 null */
function layerPixelAt(session: WarpSession, x: number, y: number): [number, number] | null {
  const m = layerAffine(session);
  if (!m) return null;
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (!det) return null;
  const dx = x - e;
  const dy = y - f;
  const px = (d * dx - c * dy) / det;
  const py = (-b * dx + a * dy) / det;
  if (px < 0 || py < 0 || px > session.size.width || py > session.size.height) return null;
  return [px, py];
}

/** 模型像素（中心原点、Y 向上）→ 贴图像素（左上原点、Y 向下） */
function imageOfModel(session: WarpSession, mx: number, my: number): [number, number] {
  return [mx + session.size.width / 2, session.size.height / 2 - my];
}

/** 会话里当前的几何（还没生成过就用现有网格密度当默认，保证「一进面板不动画面」） */
function geomOfSession(session: WarpSession): GeometrySpec {
  return session.geometry ?? defaultGeometry(session.size, session.layout.cols, session.layout.rows);
}

/**
 * 写回几何：网格来自 buildGeometry，layout 的 cols / rows 跟着有效格数走（钉子按归一化坐标不动）。
 * 部件表按几何的 partOrder 重算；之前是 limb 分割出来的部件会失效（索引映射变了），给一条提示。
 */
async function geomWriteSession(session: WarpSession, geometry: GeometrySpec, label: string): Promise<boolean> {
  const mesh = buildGeometry(geometry, session.size);
  const parts = partsOf(geometry, mesh);
  const fromSheet = session.partsFrom === "sheet";
  // 写盘会经 warpResumeAfterWrite → warpEnter → warpExit 重建会话，而 warpExit 会清掉几何模式状态，
  // 于是「加切片 / 翻格子 / 显示网格」每写一次就掉出模式（面板要重点一次按钮）。这里记下来写完后恢复。
  const mode = geomMode;
  const arm = geomArm;
  const topo = geomTopo;
  const ok = await warpWrite(session, withLegacyGrid(session.layout, geometry), mesh, label, {
    geometry,
    parts,
    partsFrom: parts ? "geometry" : null,
  });
  if (ok && fromSheet) log(et("geo.partsDropped", { n: session.limbs?.count ?? 0 }), "warn");
  // 不能恢复 "sheet"：重挂后 session.sheet 是 null，恢复它会让几何模式没叠加层却仍然吃掉全部指针事件
  if (ok && warpSession && warpSession.modelPath === session.modelPath) {
    if (mode === "geometry" || arm || topo) {
      geomMode = "geometry";
      geomArm = arm;
      geomTopo = topo;
      geomVertex = null;
      renderInspector();
      drawOverlay();
    }
  }
  return ok;
}

/** 几何编辑的统一入口：取会话里当前的几何 → 纯函数变换 → 落盘 */
function geomEdit(fn: (g: GeometrySpec) => GeometrySpec, label: string) {
  const t = geomTarget();
  if (!t) return;
  void geomWriteSession(t.session, fn(geomOfSession(t.session)), label);
}

function geomLayerName(session: WarpSession): string {
  return doc ? nodeName(session.layer) : "";
}

/** 贴图字节 → 逐像素（角色表的分割都在像素上做） */
async function decodeSheetImage(bytes: Uint8Array, type: string): Promise<SheetImage | null> {
  try {
    const bitmap = await createImageBitmap(new Blob([bytes.slice()], { type }));
    const w = bitmap.width;
    const h = bitmap.height;
    const cv = new OffscreenCanvas(w, h);
    const cx = cv.getContext("2d");
    if (!cx) {
      bitmap.close();
      return null;
    }
    cx.drawImage(bitmap, 0, 0);
    const data = cx.getImageData(0, 0, w, h).data;
    bitmap.close();
    return { width: w, height: h, data };
  } catch {
    return null;
  }
}

/**
 * WE 材质里的贴图名 → 叠加层里的真实资产路径。材质 json 的 `passes[].textures[]` 写的是
 * **WE 命名**（`editor/foo`，相对 `materials/` 根、可省扩展名），而 `read()` 只认工程里的
 * 真路径（`materials/editor/foo.png`）——两者对不上就会「读原图失败：editor/foo」。
 * 依次试：原名 / 补图片扩展名 / 加 `materials/` 前缀 / 按文件基名在 `list()` 里找。
 */
async function resolveTexturePath(assets: OverlayAssets, name: string): Promise<string | null> {
  const exts = ["png", "jpg", "jpeg", "webp"];
  const hasExt = /\.[a-z0-9]{2,4}$/i.test(name);
  const cands: string[] = [];
  const push = (p: string) => {
    if (p && !cands.includes(p)) cands.push(p);
  };
  push(name);
  if (!hasExt) for (const e of exts) push(`${name}.${e}`);
  if (!name.startsWith("materials/")) {
    push(`materials/${name}`);
    if (!hasExt) for (const e of exts) push(`materials/${name}.${e}`);
  }
  const stem = (p: string) => p.replace(/^.*\//, "").replace(/\.[a-z0-9]{2,4}$/i, "");
  const want = stem(name);
  if (want) for (const p of assets.list()) if (stem(p) === want) push(p);
  for (const c of cands) {
    const bytes = await assets.read(c);
    if (bytes && bytes.length) return c;
  }
  return null;
}

/** 读原图（木偶那张贴图）建角色表会话；已经有会话就复用参数与手工标记 */
async function sheetLoad(session: WarpSession): Promise<boolean> {
  const assets = overlay;
  if (!assets || !editor) return false;
  const info = editor.getModelInfo(Number(session.layer));
  if (!info) return false;
  const slots = modelTextureSlots(info);
  const named = slots.find((s) => s.texture)?.texture ?? null;
  if (!named) {
    log(et("sheet.fail.tex"), "warn");
    return false;
  }
  const texture = await resolveTexturePath(assets, named);
  if (!texture) {
    log(et("sheet.fail.read", { path: named }), "warn");
    return false;
  }
  const bytes = await assets.read(texture);
  if (!bytes) {
    log(et("sheet.fail.read", { path: named }), "warn");
    return false;
  }
  const image = await decodeSheetImage(bytes, /\.jpe?g$/i.test(texture) ? "image/jpeg" : "image/png");
  if (!image) {
    log(et("sheet.fail.decode", { path: texture }), "warn");
    return false;
  }
  const prev = session.sheet;
  const spec = prev?.spec ?? defaultSheetSpec(image);
  session.sheet = {
    texture,
    image,
    spec,
    limbs: prev?.limbs ?? [],
    background: prev?.background ?? backgroundMaskOf(image, spec),
    view: prev?.view ?? "foreground",
    paint: prev?.paint ?? "brush",
    maskEdit: prev?.maskEdit ?? false,
    active: prev?.active ?? 0,
    radius: prev?.radius ?? 6,
    stroke: null,
    polygon: [],
    rev: (prev?.rev ?? 0) + 1,
  };
  log(et("log.sheetLoaded", { path: texture, w: image.width, h: image.height }));
  return true;
}

/** 自动抠图（Auto Recalculate）：背景色关键字 → 连通域 → limb */
function sheetAuto(session: WarpSession) {
  const sheet = session.sheet;
  if (!sheet) return;
  const limbs = autoLimbs(sheet.image, sheet.spec);
  sheet.limbs = limbs;
  sheet.background = backgroundMaskOf(sheet.image, sheet.spec);
  sheet.active = 0;
  sheet.rev++;
  session.limbs = limbsMeta(sheet.spec, limbs);
  log(et("log.sheetAuto", { layer: geomLayerName(session), n: limbs.length }));
  renderInspector();
  drawOverlay();
}

/** 重算（Recalculate）：按 limb 均色重新归类；手工标记过的会话受 spec.manual 保护 */
function sheetRecalc(session: WarpSession) {
  const sheet = session.sheet;
  if (!sheet || !sheet.limbs.length) return;
  sheet.limbs = recalculate(sheet.image, sheet.spec, sheet.limbs);
  sheet.background = backgroundMaskOf(sheet.image, sheet.spec);
  sheet.rev++;
  session.limbs = limbsMeta(sheet.spec, sheet.limbs);
  renderInspector();
  drawOverlay();
}

/** limb 包围盒跟着掩码走（写盘只存参数，但会话里 View / 抠图要用 bbox） */
function sheetFixBBox(sheet: SheetState, limb: LimbMask): LimbMask {
  const bb = maskBBox(limb.mask, sheet.image.width, sheet.image.height);
  return bb ? { ...limb, x0: bb[0], y0: bb[1], x1: bb[2], y1: bb[3] } : limb;
}

function sheetAddLimb(session: WarpSession) {
  const sheet = session.sheet;
  if (!sheet) return;
  if (sheet.limbs.length >= MAX_LIMBS) {
    log(et("sheet.fail.max", { n: MAX_LIMBS }), "warn");
    return;
  }
  const id = sheet.limbs.reduce((m, l) => Math.max(m, l.id + 1), 0);
  const limbs = [
    ...sheet.limbs,
    { id, name: `${et("sheet.limb")} ${sheet.limbs.length + 1}`, mask: new Uint8Array(sheet.image.width * sheet.image.height), x0: 0, y0: 0, x1: sheet.image.width, y1: sheet.image.height },
  ];
  sheet.limbs = limbs;
  sheet.active = limbs.length - 1;
  sheet.rev++;
  session.limbs = limbsMeta(sheet.spec, limbs);
  renderInspector();
  drawOverlay();
}

function sheetRemoveLimb(session: WarpSession) {
  const sheet = session.sheet;
  if (!sheet || sheet.limbs.length <= 1) return;
  sheet.limbs = sheet.limbs.filter((_, i) => i !== sheet.active);
  sheet.active = Math.max(0, Math.min(sheet.active, sheet.limbs.length - 1));
  sheet.rev++;
  session.limbs = limbsMeta(sheet.spec, sheet.limbs);
  renderInspector();
  drawOverlay();
}

/** 部件绘制序上 / 下移一格（写进 `puppetWarp.geometry.partOrder`，应用部件时就是 parts 的 offset） */
function sheetMovePart(session: WarpSession, dir: -1 | 1) {
  const sheet = session.sheet;
  if (!sheet) return;
  const n = sheet.limbs.length;
  if (n < 2) return;
  const order = sheet.limbs.map((_, i) => i);
  const at = sheet.active;
  const to = at + dir;
  if (to < 0 || to >= n) return;
  const rank = order;
  const tmp = rank[at];
  rank[at] = rank[to];
  rank[to] = tmp;
  sheet.active = to;
  const base = geomOfSession(session);
  const geometry = withPartOrder({ ...base, partOrder: order.length === base.partOrder.length ? base.partOrder : order }, rank);
  session.geometry = geometry;
  renderInspector();
  drawOverlay();
}

/** 把 limb 分割写进 .mdl 部件表（三角形按重心查 limb → 重排索引 → parts 绘制序） */
async function sheetApply(session: WarpSession): Promise<boolean> {
  const sheet = session.sheet;
  if (!sheet) return false;
  if (!sheet.limbs.length) {
    log(et("sheet.noLimbs"), "warn");
    return false;
  }
  const mesh = session.mesh;
  const labels = limbLabelMap(sheet.limbs, sheet.image);
  const tri = triangleLimb(mesh.indices, mesh.uvs, labels, sheet.image);
  const order = session.geometry?.partOrder ?? null;
  const { indices, parts } = groupIndicesByLimb(
    mesh.indices,
    tri,
    sheet.limbs,
    order && order.length === sheet.limbs.length ? order : undefined,
  );
  const ok = await warpWrite(
    session,
    session.layout,
    { ...mesh, indices },
    et("log.sheetApplied", { layer: geomLayerName(session), n: parts.length }),
    { parts, partsFrom: "sheet" },
  );
  if (ok) session.limbs = limbsMeta(sheet.spec, sheet.limbs);
  return ok;
}

/** 画笔 / 多边形落哪张掩码：Mask 开关开 = 当前 limb，关 = 背景（Mark Background） */
function sheetPaintMask(sheet: SheetState): { mask: Uint8Array; set: (m: Uint8Array) => void } {
  const limb = sheet.limbs[sheet.active];
  if (sheet.maskEdit && limb) return { mask: limb.mask, set: (m) => (limb.mask = m) };
  return { mask: sheet.background, set: (m) => (sheet.background = m) };
}

function sheetStroke(sheet: SheetState, points: Array<{ x: number; y: number }>, op: "add" | "remove") {
  if (!points.length) return;
  const target = sheetPaintMask(sheet);
  target.set(brushStroke(target.mask, sheet.image.width, sheet.image.height, points, sheet.radius, op));
  const limb = sheet.limbs[sheet.active];
  if (limb) sheet.limbs[sheet.active] = sheetFixBBox(sheet, limb);
  sheet.rev++;
}

function sheetClosePolygon(sheet: SheetState, op: "add" | "remove") {
  if (sheet.polygon.length < 3) {
    sheet.polygon = [];
    return;
  }
  const target = sheetPaintMask(sheet);
  const pts = sheet.polygon.map(([x, y]) => ({ x, y }));
  target.set(polygonMask(target.mask, sheet.image.width, sheet.image.height, pts, op));
  const limb = sheet.limbs[sheet.active];
  if (limb) sheet.limbs[sheet.active] = sheetFixBBox(sheet, limb);
  sheet.polygon = [];
  sheet.rev++;
}

/** 角色表 / 几何叠加层缓存（只在内容变了以后重画一次像素） */
let sheetViewCache: { key: string; canvas: HTMLCanvasElement } | null = null;

/** 几何 / 角色表叠加层：都在「贴图像素」空间里画（仿射把贴图坐标铺到画布上，旋转缩放自动跟着） */
function drawGeomOverlay(session: WarpSession) {
  if (!geomMode) return;
  const m = layerAffine(session);
  if (!m) return;
  const w = session.size.width;
  const h = session.size.height;
  const base = overlayCtx.getTransform();
  overlayCtx.save();
  overlayCtx.setTransform(base.multiply(new DOMMatrix([m[0], m[1], m[2], m[3], m[4], m[5]])));
  const unit = 1 / (Math.hypot(m[0], m[1]) || 1);
  if (geomMode === "geometry") {
    const mesh = session.mesh;
    const verts = mesh.positions.length / 3;
    if (verts && verts <= GEOM_DRAW_MAX) {
      const cols = mesh.cols + 1;
      const at = (v: number) => imageOfModel(session, mesh.positions[v * 3], mesh.positions[v * 3 + 1]);
      overlayCtx.beginPath();
      for (let j = 0; j <= mesh.rows; j++) {
        for (let i = 0; i < mesh.cols; i++) {
          const a = at(j * cols + i);
          const b = at(j * cols + i + 1);
          overlayCtx.moveTo(a[0], a[1]);
          overlayCtx.lineTo(b[0], b[1]);
        }
      }
      for (let i = 0; i <= mesh.cols; i++) {
        for (let j = 0; j < mesh.rows; j++) {
          const a = at(j * cols + i);
          const b = at((j + 1) * cols + i);
          overlayCtx.moveTo(a[0], a[1]);
          overlayCtx.lineTo(b[0], b[1]);
        }
      }
      overlayCtx.lineWidth = unit;
      overlayCtx.strokeStyle = "rgba(0,0,0,0.35)";
      overlayCtx.stroke();
    }
    const g = session.geometry;
    if (g && (g.sliceX.length || g.sliceY.length)) {
      // 黄色只画「手动加的切片」：基础网格（含细分）已经在上面用暗线画过，全画黄会分不清哪刀是自己切的
      overlayCtx.beginPath();
      for (const t of g.sliceX) {
        overlayCtx.moveTo(t * w, 0);
        overlayCtx.lineTo(t * w, h);
      }
      for (const t of g.sliceY) {
        overlayCtx.moveTo(0, t * h);
        overlayCtx.lineTo(w, t * h);
      }
      overlayCtx.lineWidth = unit;
      overlayCtx.strokeStyle = "rgba(255,209,102,0.9)";
      overlayCtx.stroke();
    }
    if (g && hasTopology(g)) {
      overlayCtx.fillStyle = "rgba(255,209,102,0.95)";
      overlayCtx.font = `${Math.round(11 * unit)}px sans-serif`;
      overlayCtx.fillText(et("geo.topoOn"), unit * 4, unit * 12);
    }
    return;
  }
  const sheet = session.sheet;
  if (!sheet) return;
  const key = `${sheet.view}|${sheet.limbs.length}|${sheet.active}|${sheet.maskEdit ? 1 : 0}|${sheet.rev}`;
  if (!sheetViewCache || sheetViewCache.key !== key) {
    const px = viewPixels(sheet.image, sheet.limbs, sheet.background, sheet.view);
    const cv = sheetViewCache?.canvas ?? document.createElement("canvas");
    cv.width = sheet.image.width;
    cv.height = sheet.image.height;
    const cx = cv.getContext("2d");
    if (cx) cx.putImageData(new ImageData(px, sheet.image.width, sheet.image.height), 0, 0);
    sheetViewCache = { key, canvas: cv };
  }
  if (sheetViewCache) {
    overlayCtx.globalAlpha = 0.85;
    overlayCtx.drawImage(sheetViewCache.canvas, 0, 0);
    overlayCtx.globalAlpha = 1;
  }
  if (sheet.polygon.length) {
    overlayCtx.beginPath();
    sheet.polygon.forEach(([x, y], i) => (i ? overlayCtx.lineTo(x, y) : overlayCtx.moveTo(x, y)));
    overlayCtx.lineWidth = unit;
    overlayCtx.strokeStyle = "rgba(255,209,102,0.95)";
    overlayCtx.stroke();
  }
  overlayCtx.fillStyle = "rgba(255,255,255,0.9)";
  overlayCtx.font = `${Math.round(11 * unit)}px sans-serif`;
  overlayCtx.fillText(et("sheet.hintClick"), unit * 4, unit * 12);
}

/** P1 指针：切片待命 / Edit Topology 翻转与顶点偏移 / 角色表涂抹（都优先于手柄与钉子） */
function geomPointerDown(e: PointerEvent): boolean {
  const t = geomTarget();
  if (!t || !geomMode || e.button !== 0) return false;
  const p = canvasPoint(e);
  if (!p) return false;
  const at = layerPixelAt(t.session, p.x, p.y);
  if (!at) return false;
  const session = t.session;
  const [px, py] = at;
  if (geomMode === "geometry") {
    const g = geomOfSession(session);
    if (geomArm) {
      const axis = geomArm;
      const v = axis === "x" ? px / session.size.width : py / session.size.height;
      geomArm = null;
      geomEdit((cur) => addSlice(cur, axis, v), et("log.geomSlice", { layer: geomLayerName(session), axis }));
      suppressClick = true;
      return true;
    }
    if (geomTopo) {
      const axes = axesOf(g);
      const i = axes.xs.findIndex((x, k) => k < axes.xs.length - 1 && px / session.size.width >= x && px / session.size.width < axes.xs[k + 1]);
      const j = axes.ys.findIndex((y, k) => k < axes.ys.length - 1 && py / session.size.height >= y && py / session.size.height < axes.ys[k + 1]);
      if (i >= 0 && j >= 0) {
        const cell = j * (axes.xs.length - 1) + i;
        geomEdit((cur) => flipCell(cur, cell), et("log.geomFlip", { layer: geomLayerName(session), cell }));
        suppressClick = true;
        return true;
      }
    }
    if (e.altKey) {
      // Alt：抓最近的顶点拖偏移（松手落盘）
      const mesh = session.mesh;
      let best = -1;
      let bestD = Infinity;
      for (let v = 0; v < mesh.positions.length / 3; v++) {
        const q = imageOfModel(session, mesh.positions[v * 3], mesh.positions[v * 3 + 1]);
        const d = Math.hypot(q[0] - px, q[1] - py);
        if (d < bestD) {
          bestD = d;
          best = v;
        }
      }
      if (best >= 0 && bestD <= 16) {
        geomVertex = { vertex: best, pointerId: e.pointerId, x0: p.x, y0: p.y, dx: 0, dy: 0 };
        stageEl.setPointerCapture(e.pointerId);
        suppressClick = true;
        return true;
      }
    }
    return false;
  }
  const sheet = session.sheet;
  if (!sheet) return false;
  if (sheet.paint === "polygon") {
    sheet.polygon.push([px, py]);
    if (e.detail > 1) sheetClosePolygon(sheet, e.altKey ? "remove" : "add");
    suppressClick = true;
    drawOverlay();
    return true;
  }
  sheet.stroke = { erase: e.altKey, last: [px, py] };
  sheetStroke(sheet, [{ x: px, y: py }], e.altKey ? "remove" : "add");
  stageEl.setPointerCapture(e.pointerId);
  suppressClick = true;
  drawOverlay();
  return true;
}

/** P1 指针拖动：顶点偏移累计 / 画笔续笔；返回 true = 这一下归几何与角色表管 */
function geomPointerMove(e: PointerEvent): boolean {
  const t = geomTarget();
  if (!t || !geomMode) return false;
  const session = t.session;
  if (geomVertex && e.pointerId === geomVertex.pointerId) {
    const p = canvasPoint(e);
    if (!p) return true;
    const d = warpDeltaOf(session, p.x - geomVertex.x0, p.y - geomVertex.y0);
    geomVertex.dx = d[0];
    geomVertex.dy = d[1];
    return true;
  }
  const sheet = session.sheet;
  if (!sheet?.stroke || sheet.paint !== "brush") return false;
  const p = canvasPoint(e);
  if (!p) return true;
  const at = layerPixelAt(session, p.x, p.y);
  if (!at) return true;
  sheetStroke(sheet, [{ x: sheet.stroke.last[0], y: sheet.stroke.last[1] }, { x: at[0], y: at[1] }], sheet.stroke.erase ? "remove" : "add");
  sheet.stroke.last = [at[0], at[1]];
  drawOverlay();
  return true;
}

/** P1 指针抬起：顶点偏移落盘 / 结束这一笔 */
function geomPointerUp(e: PointerEvent) {
  const t = geomTarget();
  if (!t) return;
  const session = t.session;
  if (geomVertex && e.pointerId === geomVertex.pointerId) {
    const v = geomVertex;
    geomVertex = null;
    if (Math.abs(v.dx) > 0.01 || Math.abs(v.dy) > 0.01) {
      const g = geomOfSession(session);
      const uv = vertexUvOf(g, v.vertex);
      geomEdit(
        (cur) => setOffset(cur, v.vertex, v.dx / session.size.width, v.dy / session.size.height),
        et("log.geomOffset", { layer: geomLayerName(session), vertex: v.vertex, u: uv ? uv[0].toFixed(3) : "—" }),
      );
    }
    return;
  }
  if (session.sheet?.stroke && e.pointerId === e.pointerId) {
    session.sheet.stroke = null;
    session.limbs = limbsMeta(session.sheet.spec, session.sheet.limbs);
    renderInspector();
    drawOverlay();
  }
}

/** P1 几何分组：网格生成 / 细分 / 切片 / Padding / Lock geometry / Edit Topology */
function geometryGroup(node: LayerNode): HTMLElement | null {
  const t = warpTarget();
  if (!t || String(t.node.id) !== String(node.id)) return null;
  const session = t.session;
  const g = geomOfSession(session);
  const grid = gridOf(g);
  const group = document.createElement("div");
  group.className = "ed-insp-group ed-geom";
  const h = document.createElement("div");
  h.className = "ed-insp-title";
  h.textContent = et("insp.geometry");
  group.appendChild(h);
  const editable = !!overlay && !isLocked(node.id);
  const action = (cls: string, key: string, onClick: () => void, disabled = false) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `ed-btn ${cls}`;
    b.dataset.et = key;
    b.textContent = et(key);
    b.disabled = disabled;
    b.onclick = onClick;
    return b;
  };
  const label = geomLayerName(session);
  const verts = session.mesh.positions.length / 3;
  group.appendChild(note(et("geo.note", { cols: grid.cols, rows: grid.rows, verts, pad: session.geometry?.padding ?? 0 })));
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
  const logGrid = () => et("log.geomGrid", { layer: label, cols: g.cols, rows: g.rows, sub: g.subdivision, pad: session.geometry?.padding ?? 0 });
  const range = (cls: string, key: string, value: number, min: number, max: number, step: number, onSet: (n: number) => void) => {
    const el = document.createElement("input");
    el.type = "range";
    el.className = cls;
    el.min = String(min);
    el.max = String(max);
    el.step = String(step);
    el.value = String(value);
    el.disabled = !editable;
    el.addEventListener("change", () => onSet(Number(el.value)));
    row(key, el);
    return el;
  };
  range("ed-geom-cols", "geo.cols", g.cols, COLS_MIN, COLS_MAX, 1, (n) => geomEdit((x) => withColsRows(x, n, x.rows), logGrid()));
  range("ed-geom-rows", "geo.rows", g.rows, COLS_MIN, COLS_MAX, 1, (n) => geomEdit((x) => withColsRows(x, x.cols, n), logGrid()));
  range("ed-geom-sub", "geo.sub", g.subdivision, SUBDIV_MIN, SUBDIV_MAX, 1, (n) => geomEdit((x) => withSubdivision(x, n), logGrid()));
  range("ed-geom-pad", "geo.pad", session.geometry?.padding ?? 0, PADDING_MIN, PADDING_MAX, 1, (n) => geomEdit((x) => withPadding(x, n), logGrid()));
  const lock = document.createElement("input");
  lock.type = "checkbox";
  lock.className = "ed-geom-lock";
  lock.checked = !!g.locked;
  lock.disabled = !editable;
  lock.addEventListener("change", () => geomEdit((x) => withLocked(x, lock.checked), logGrid()));
  row("geo.lock", lock);
  group.appendChild(form);
  group.appendChild(note(et("geo.slices", { x: g.sliceX.length, y: g.sliceY.length })));
  const actions = document.createElement("div");
  actions.className = "ed-insp-actions";
  const sliceX = action("ed-geom-slice-x", "geo.sliceX", () => {
    geomArm = "x";
    geomMode = "geometry";
    renderInspector();
    drawOverlay();
  }, !editable);
  const sliceY = action("ed-geom-slice-y", "geo.sliceY", () => {
    geomArm = "y";
    geomMode = "geometry";
    renderInspector();
    drawOverlay();
  }, !editable);
  // 待命态可见：切了按钮之后要在视口里点位置，没有提示会以为没反应
  if (geomArm === "x") sliceX.classList.add("is-arm");
  if (geomArm === "y") sliceY.classList.add("is-arm");
  actions.append(
    action("ed-geom-create", session.geometry ? "geo.reset" : "geo.create", () =>
      geomEdit(() => defaultGeometry(session.size, session.mesh.cols, session.mesh.rows), et("log.geomGrid", { layer: label, cols: session.mesh.cols, rows: session.mesh.rows, sub: 1, pad: 0 })),
    !editable),
    action("ed-geom-reset-topo", "geo.resetTopo", () => geomEdit((x) => clearTopology(x), et("log.geomTopoReset", { layer: label })), !editable),
    sliceX,
    sliceY,
    action("ed-geom-clear-slices", "geo.clearSlices", () => geomEdit((x) => withSlices(withSlices(x, "x", []), "y", []), et("log.geomGrid", { layer: label, cols: g.cols, rows: g.rows, sub: g.subdivision, pad: session.geometry?.padding ?? 0 })), !editable),
    action("ed-geom-topo", geomTopo ? "geo.topoOn" : "geo.topo", () => {
      geomTopo = !geomTopo;
      if (geomTopo) geomMode = "geometry";
      renderInspector();
      drawOverlay();
    }, !editable),
    action("ed-geom-view", geomMode === "geometry" ? "geo.viewOn" : "geo.view", () => {
      geomMode = geomMode === "geometry" ? null : "geometry";
      renderInspector();
      drawOverlay();
    }),
  );
  group.appendChild(actions);
  return group;
}

/** P1 角色表分组：读原图 / 自动抠图 / limb 列表（颜色 = 部件色）/ 画笔·多边形 / 应用部件 */
function sheetGroup(node: LayerNode): HTMLElement | null {
  const t = warpTarget();
  if (!t || String(t.node.id) !== String(node.id)) return null;
  const session = t.session;
  const group = document.createElement("div");
  group.className = "ed-insp-group ed-sheet";
  const h = document.createElement("div");
  h.className = "ed-insp-title";
  h.textContent = et("insp.sheet");
  group.appendChild(h);
  const editable = !!overlay && !isLocked(node.id);
  const action = (cls: string, key: string, onClick: () => void, disabled = false) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `ed-btn ${cls}`;
    b.dataset.et = key;
    b.textContent = et(key);
    b.disabled = disabled;
    b.onclick = onClick;
    return b;
  };
  if (!session.sheet) {
    group.appendChild(note(et("sheet.intro")));
    group.appendChild(action("ed-sheet-load", "sheet.load", () => {
      void sheetLoad(session).then((ok) => {
        if (!ok) return;
        geomMode = "sheet";
        sheetViewCache = null;
        renderInspector();
        drawOverlay();
      });
    }, !editable));
    return group;
  }
  const sheet = session.sheet;
  group.appendChild(note(et("sheet.note", { w: sheet.image.width, h: sheet.image.height, n: sheet.limbs.length })));
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
  const specSet = (patch: Partial<SheetSpec>) => {
    sheet.spec = { ...sheet.spec, ...patch };
    sheet.background = backgroundMaskOf(sheet.image, sheet.spec);
    sheet.rev++;
    session.limbs = limbsMeta(sheet.spec, sheet.limbs);
    renderInspector();
    drawOverlay();
  };
  const range = (cls: string, key: string, value: number, min: number, max: number, step: number, onSet: (n: number) => void) => {
    const el = document.createElement("input");
    el.type = "range";
    el.className = cls;
    el.min = String(min);
    el.max = String(max);
    el.step = String(step);
    el.value = String(value);
    el.disabled = !editable;
    el.addEventListener("change", () => onSet(Number(el.value)));
    row(key, el);
    return el;
  };
  range("ed-sheet-quality", "sheet.quality", sheet.spec.quality, QUALITY_MIN, QUALITY_MAX, 1, (n) => specSet({ quality: n }));
  range("ed-sheet-smooth", "sheet.smooth", sheet.spec.smoothing, 0, SMOOTHING_MAX, 1, (n) => specSet({ smoothing: n }));
  range("ed-sheet-threshold", "sheet.threshold", sheet.spec.threshold, 0, 255, 1, (n) => specSet({ threshold: n }));
  range("ed-sheet-feather", "sheet.feather", sheet.spec.feather, 0, 4, 1, (n) => specSet({ feather: n }));
  const view = document.createElement("select");
  view.className = "ed-sheet-viewsel";
  for (const v of ["foreground", "background"] as SheetView[]) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = et(v === "foreground" ? "sheet.viewFore" : "sheet.viewBack");
    view.appendChild(o);
  }
  view.value = sheet.view;
  view.disabled = !editable;
  view.addEventListener("change", () => {
    sheet.view = view.value as SheetView;
    sheet.rev++;
    renderInspector();
    drawOverlay();
  });
  row("sheet.view", view);
  const paint = document.createElement("select");
  paint.className = "ed-sheet-paint";
  for (const p of ["brush", "polygon"] as PaintMode[]) {
    const o = document.createElement("option");
    o.value = p;
    o.textContent = et(p === "brush" ? "sheet.paintBrush" : "sheet.paintPolygon");
    paint.appendChild(o);
  }
  paint.value = sheet.paint;
  paint.disabled = !editable;
  paint.addEventListener("change", () => {
    sheet.paint = paint.value as PaintMode;
    sheet.polygon = [];
    sheet.stroke = null;
    renderInspector();
    drawOverlay();
  });
  row("sheet.paint", paint);
  range("ed-sheet-radius", "sheet.radius", sheet.radius, 1, 40, 1, (n) => {
    sheet.radius = n;
    renderInspector();
  });
  const mask = document.createElement("input");
  mask.type = "checkbox";
  mask.className = "ed-sheet-mask";
  mask.checked = sheet.maskEdit;
  mask.disabled = !editable;
  mask.addEventListener("change", () => {
    sheet.maskEdit = mask.checked;
    sheet.rev++;
    renderInspector();
    drawOverlay();
  });
  row("sheet.mask", mask);
  group.appendChild(form);
  const list = document.createElement("div");
  list.className = "ed-sheet-limbs";
  sheet.limbs.forEach((limb, i) => {
    const item = document.createElement("div");
    item.className = `ed-fx-item ed-sheet-limb${i === sheet.active ? " is-on" : ""}`;
    item.dataset.limb = String(i);
    const sw = document.createElement("span");
    sw.className = "ed-sheet-sw";
    const c = LIMB_PALETTE[i % LIMB_PALETTE.length];
    sw.style.background = `rgb(${c[0]},${c[1]},${c[2]})`;
    const nm = document.createElement("span");
    nm.className = "ed-fx-name";
    nm.textContent = `${limb.name} · ${maskCount(limb.mask)}`;
    item.append(sw, nm);
    item.onclick = () => {
      sheet.active = i;
      sheet.rev++;
      renderInspector();
      drawOverlay();
    };
    list.appendChild(item);
  });
  group.appendChild(list);
  const actions = document.createElement("div");
  actions.className = "ed-insp-actions";
  actions.append(
    action("ed-sheet-auto", "sheet.auto", () => sheetAuto(session), !editable),
    action("ed-sheet-recalc", "sheet.recalc", () => sheetRecalc(session), !editable || !sheet.limbs.length),
    action("ed-sheet-add", "sheet.add", () => sheetAddLimb(session), !editable),
    action("ed-sheet-del", "sheet.del", () => sheetRemoveLimb(session), !editable || sheet.limbs.length <= 1),
    action("ed-sheet-up", "sheet.up", () => sheetMovePart(session, -1), !editable || sheet.active <= 0),
    action("ed-sheet-down", "sheet.down", () => sheetMovePart(session, 1), !editable || sheet.active >= sheet.limbs.length - 1),
    action("ed-sheet-apply", "sheet.apply", () => void sheetApply(session), !editable || !sheet.limbs.length),
    action("ed-sheet-load", "sheet.reload", () => {
      void sheetLoad(session).then((ok) => {
        if (!ok) return;
        geomMode = "sheet";
        sheetViewCache = null;
        renderInspector();
        drawOverlay();
      });
    }, !editable),
    action("ed-sheet-view", geomMode === "sheet" ? "sheet.viewOn" : "sheet.viewBtn", () => {
      geomMode = geomMode === "sheet" ? null : "sheet";
      sheetViewCache = null;
      renderInspector();
      drawOverlay();
    }),
  );
  group.appendChild(actions);
  return group;
}

/** P1 指针挂点：注册在这些通用监听之前 ⇒ 几何 / 角色表消费掉的事件不再落到手柄、框选与钉子 */
stageEl.addEventListener("pointerdown", (e) => {
  if (!geomPointerDown(e)) return;
  e.stopImmediatePropagation();
  e.preventDefault();
});
stageEl.addEventListener("pointermove", (e) => {
  if (!geomPointerMove(e)) return;
  e.stopImmediatePropagation();
});
const geomBusy = () => !!geomVertex || !!geomTarget()?.session.sheet?.stroke;
stageEl.addEventListener("pointerup", (e) => {
  if (!geomBusy()) return;
  geomPointerUp(e);
  e.stopImmediatePropagation();
});
stageEl.addEventListener("pointercancel", (e) => {
  if (!geomBusy()) return;
  geomPointerUp(e);
  e.stopImmediatePropagation();
});

// ---------- 骨架与权重（P2：官方 Weights 菜单） ----------
//
// WE 的 Weights 窗口 = 骨列表（Add Bone / Delete / Rename / 改父子）+ Paint Weights +
// Weight islands + 4 影响上限。这里按同一套顺序做：打点建骨 → 命名 / 父子 → 自动权重 →
// 涂抹 / 平滑 / 孤岛混合 → 应用。顶点权重本体写进 .mdl 的 4 槽蒙皮；json 只记
// `puppetWarp.skeleton`（骨名 / 父级 / 位置）与 `puppetWarp.weights`（locked），与 P0 / P1 同口径。

/** 骨 meta 的 pw 键（P4 的仿真 / IK 读它）；P2 只负责如实写下来 */
const SKEL_PHYS = { stiffness: 0.5, damping: 0.2 };
/** 顶点权重之和小于这个值当「没涂」（引擎会把这些顶点当无效蒙皮，面板要提醒） */
const SKEL_UNPAINTED = 1e-4;
/** 权重叠加层最多画多少个顶点（大网格抽样画，别把帧率拖垮） */
const SKEL_DRAW_MAX = 6000;

/** .mdl 的顶点 / 索引 / 蒙皮槽 / 部件表：P2 的权重都挂在这份顶点上 */
type SkelModel = {
  positions: Float32Array;
  indices: Uint32Array;
  vertexCount: number;
  boneCount: number;
  parts: MdlPart[] | null;
  skin: WeightSkin | null;
};

/** 骨架（"skeleton"）/ 权重（"weights"）模式：和 P1 的几何 / 角色表一样是模态 */
let skelMode: "skeleton" | "weights" | null = null;
/** 「打点建骨」待命 */
let skelArm = false;
/** 「设为父级」待命：下一下点的骨挂到当前选中骨下 */
let skelParentArm = false;
/** 选中骨 */
let skelSel = -1;
/** 涂抹目标骨（-1 = 跟选中骨） */
let skelPaintBone = -1;
let skelBrush = BRUSH_RADIUS;
let skelStrength = BRUSH_STRENGTH;
/** 转动预览的角度（度） */
let skelPoseDeg = 0;
/** 涂抹中的指针（模型空间上一点 + 是否擦除 + 起笔前的权重快照） */
let skelStroke: { pointerId: number; erase: boolean; last: [number, number]; base: Float32Array | null } | null = null;
/** 叠加层按部件绘制序着色 */
let skelDepth = false;
let skelPhysics = { ...SKEL_PHYS };
/** 邻接表缓存（平滑 / 孤岛用）：键 = 模型路径 + 顶点数 */
let skelAdjCache: { key: string; adj: { start: Uint32Array; list: Uint32Array } } | null = null;
/** 正在读 .mdl 的模型（防重入） */
const skelLoading = new Set<string>();

function skelTarget(): { node: LayerNode; session: WarpSession } | null {
  return warpTarget();
}

/** 骨架 / 权重模式同样模态：通用监听（手柄 / 框选 / 钉子）靠 geomModal 让路 */
function skelModal(): boolean {
  return !!skelMode && !!warpTarget();
}

function skelLayerName(session: WarpSession): string {
  return doc ? nodeName(session.layer) : "";
}

/** 画布点 → 模型坐标（中心原点、Y 向上，与 geometry / limbs 同一套换算） */
function skelModelAt(session: WarpSession, x: number, y: number): [number, number] | null {
  const p = layerPixelAt(session, x, y);
  return p ? [p[0] - session.size.width / 2, session.size.height / 2 - p[1]] : null;
}

/** 读 .mdl 的顶点 / 索引 / 蒙皮槽 / 部件表（P2 的权重都挂在这份顶点上） */
async function skelModelOf(session: WarpSession): Promise<SkelModel | null> {
  const assets = overlay;
  if (!assets) return null;
  const json = parseJsonBytes(await assets.read(session.modelPath));
  const mdlPath = json && typeof json.puppet === "string" ? json.puppet : "";
  if (!mdlPath) return null;
  const bytes = await assets.read(mdlPath);
  if (!bytes) return null;
  const info = mdlMeshInfo(bytes, 0);
  const positions = mdlMeshPositions(bytes, 0);
  const indices = mdlMeshIndices(bytes, 0);
  const vc = info ? info.vertexCount : 0;
  if (!info || !positions || !indices || !vc) return null;
  const slots = mdlSkin(bytes, 0);
  return {
    positions,
    indices,
    vertexCount: vc,
    boneCount: mdlBoneCount(bytes) ?? 0,
    parts: info.parts,
    skin: slots && slots.weights.length === vc * 4 ? { joints: slots.joints, weights: slots.weights, vertexCount: vc } : null,
  };
}

/**
 * 会话里的顶点 / 权重：第一次用到时读一次 .mdl。权重优先用盘上那份 —— 只有骨数与自建骨架
 * 对得上才算数（骨数变了，盘上的骨号是旧骨架的，必须按新骨重算自动权重）。
 */
async function skelEnsure(session: WarpSession): Promise<boolean> {
  if (session.skelVerts) return true;
  if (skelLoading.has(session.modelPath)) return false;
  skelLoading.add(session.modelPath);
  try {
    const m = await skelModelOf(session);
    if (!m || warpSession !== session) return false;
    session.skelVerts = m.positions;
    session.skelIndices = m.indices;
    session.skelVertexCount = m.vertexCount;
    session.skelBoneCount = m.boneCount;
    session.skelParts = m.parts;
    const points = session.skeleton ? bonePoints(session.skeleton) : [];
    const usable = points.length > 0 && m.skin !== null && m.boneCount === points.length;
    session.skin = usable && m.skin ? m.skin : points.length ? nearestBoneSkin(m.positions, points) : null;
    return true;
  } finally {
    skelLoading.delete(session.modelPath);
  }
}

/** 邻接表（平滑 / 孤岛；随模型与顶点数缓存） */
function skelAdjOf(session: WarpSession): { start: Uint32Array; list: Uint32Array } | null {
  if (!session.skelIndices) return null;
  const key = `${session.modelPath}|${session.skelVertexCount}`;
  if (!skelAdjCache || skelAdjCache.key !== key) skelAdjCache = { key, adj: adjacencyOf(session.skelIndices, session.skelVertexCount) };
  return skelAdjCache.adj;
}

/** 还没涂的顶点数 */
function skelUnpainted(skin: WeightSkin): number {
  let n = 0;
  for (let v = 0; v < skin.vertexCount; v++) {
    let sum = 0;
    for (let k = 0; k < 4; k++) sum += skin.weights[v * 4 + k];
    if (!(sum > SKEL_UNPAINTED)) n++;
  }
  return n;
}

/** 两份权重里数值不同的顶点数（涂抹的改动量） */
function skelWeightDiff(a: Float32Array, b: Float32Array): number {
  let n = 0;
  const vc = Math.floor(Math.min(a.length, b.length) / 4);
  for (let v = 0; v < vc; v++) {
    for (let k = 0; k < 4; k++) {
      if (Math.abs(a[v * 4 + k] - b[v * 4 + k]) > 1e-6) {
        n++;
        break;
      }
    }
  }
  return n;
}

/** 每顶点的部件绘制序名次（0 = 最前；-1 = 没落在任何部件里） */
function skelPartRanks(session: WarpSession): Int32Array | null {
  const parts = session.skelParts;
  const idx = session.skelIndices;
  if (!parts || !idx) return null;
  const out = new Int32Array(session.skelVertexCount).fill(-1);
  parts.forEach((p, i) => {
    const rank = drawOrderRank(parts, i);
    for (let k = p.start; k < p.start + p.size; k++) {
      const v = idx[k];
      if (v >= 0 && v < out.length) out[v] = rank;
    }
  });
  return out;
}

/** 骨号 / 绘制序 → 颜色（复用角色表的调色板；相邻骨颜色不同就够用） */
function skelBoneColor(bone: number): [number, number, number] {
  const n = LIMB_PALETTE.length;
  return LIMB_PALETTE[((bone % n) + n) % n] ?? [160, 160, 160];
}

/**
 * `withSkeleton` / `withWeights` 都是**纯函数**（返回新对象，不改入参），而 commitMdlEdit 的 jsonEdit
 * 契约是「就地改这份 json」⇒ 必须把新对象的内容折叠回原对象，否则新 json 里留不下骨架 / 权重状态
 * （P2 真机段实测踩到：写盘成功但重挂后 json 里没有 puppetWarp.skeleton，面板当没骨架）。
 */
function jsonAssign(target: Record<string, unknown>, next: Record<string, unknown>): void {
  for (const k of Object.keys(target)) if (!(k in next)) delete target[k];
  Object.assign(target, next);
}

/** 两份 4×4 局部矩阵是否同一个（骨表有没有变，决定盘上片段要不要作废） */
function sameMatrix16(a: Float32Array | undefined, b: Float32Array | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!(Math.abs(a[i] - b[i]) < 1e-4)) return false;
  return true;
}

/**
 * 写回当前骨 / 权重：走 commitMdlEdit（copy-on-write 出新副本，改指向，进撤销栈），jsonEdit
 * 顺手把 P2 状态写进新 json。写完重挂 → 恢复 P2 模式与选中骨（重挂会清掉会话里的 P2 状态）。
 */
async function skelCommit(
  session: WarpSession,
  label: string,
  slugTag: string,
  edit: (bytes: Uint8Array) => Uint8Array | null,
  jsonEdit?: (json: Record<string, unknown>) => void,
): Promise<boolean> {
  const mode = skelMode;
  const sel = skelSel;
  const paint = skelPaintBone;
  const depth = skelDepth;
  const ok = await commitMdlEdit(session.layer, label, slugTag, "wp", edit, undefined, jsonEdit);
  if (!ok) return false;
  const node = doc ? findNode(doc.roots, session.layer) : null;
  const modelPath = node ? String(node.obj.image ?? "") : "";
  if (!modelPath) return false;
  session.modelPath = modelPath;
  await warpResumeAfterWrite(session.layer, modelPath, session.layout, session.size, session.mesh);
  if (warpSession && warpSession.modelPath === modelPath) {
    const n = warpSession.skeleton ? warpSession.skeleton.bones.length : 0;
    const clampIdx = (i: number) => (n ? Math.max(0, Math.min(n - 1, i)) : -1);
    skelSel = n ? clampIdx(sel) : -1;
    skelPaintBone = n && paint >= 0 ? clampIdx(paint) : skelSel;
    skelMode = n ? mode : null;
    skelDepth = depth;
    renderInspector();
    drawOverlay();
  }
  return true;
}

/**
 * 应用骨架：写 MDLS 骨记录（含 meta.pw）+ 按新骨重算一份 4 槽权重 —— 骨表一换，顶点上原来的
 * 骨号就失效了，同一次编辑里补齐才不会有「指向不存在骨」的中间态。
 * 骨表变了还要把盘上片段整批作废：轨道按写入时的骨号打点（P0 的钉子骨烘焙就是一批常量帧），
 * 骨表一换这些帧就成了「按错骨号施加的姿势」，绑定姿势下画面会被推歪。
 * 注意**不能**用 removeMdlClip 来删：它有「首个片段不许删」（引擎绑定参考）的保护，P0 木偶
 * 恰好只有一个片段（index 0）⇒ 它会返回 null，旧片段原样留下（P2 真机量到 195px 的就是这个）。
 */
async function skelApplySkeleton(session: WarpSession): Promise<boolean> {
  const sk = session.skeleton;
  if (!sk || !sk.bones.length) {
    log(et("skel.noBones"), "warn");
    return false;
  }
  const label = skelLayerName(session);
  const bones = boneSpecs(sk).map((b) => ({ ...b, meta: JSON.stringify({ pw: { ...skelPhysics } }) }));
  const points = bonePoints(sk);
  return skelCommit(
    session,
    et("log.skel.apply", { layer: label, bones: bones.length }),
    "skel",
    (bytes) => {
      const prev = mdlBones(bytes);
      const out = setMdlSkeleton(bytes, bones);
      if (!out) return null;
      const vc = mdlMeshInfo(out, 0)?.vertexCount ?? 0;
      const pos = vc ? mdlMeshPositions(out, 0) : null;
      let next = out;
      if (pos) {
        const fresh = nearestBoneSkin(pos, points);
        const w = setMdlWeights(next, 0, fresh.weights);
        if (w) next = setMdlBoneIdx(w, 0, fresh.joints) ?? w;
      }
      if (!prev || prev.length !== bones.length || prev.some((b, i) => b.name !== bones[i].name || b.parent !== bones[i].parent || !sameMatrix16(b.matrix, bones[i].matrix))) {
        log(et("log.skel.dropped", { layer: label }), "warn");
        next = clearMdlClips(next) ?? next;
      }
      return next;
    },
    (json) => jsonAssign(json, withSkeleton(json, sk)),
  );
}

/** 应用权重：只写 4 槽权重与骨号（骨架沿用盘上那份，骨数必须对得上） */
async function skelApplyWeights(session: WarpSession): Promise<boolean> {
  const skin = session.skin;
  const bones = session.skeleton ? session.skeleton.bones.length : 0;
  if (!skin || !session.skelVertexCount) {
    log(et("wt.needSkel"), "warn");
    return false;
  }
  if (session.skelBoneCount && bones && session.skelBoneCount !== bones) {
    log(et("wt.needApply"), "warn");
    return false;
  }
  const locked = session.wtLocked;
  return skelCommit(
    session,
    et("log.wt.apply", { layer: skelLayerName(session), n: skin.vertexCount, bones }),
    "wt",
    (bytes) => {
      const w = setMdlWeights(bytes, 0, skin.weights);
      if (!w) return null;
      return setMdlBoneIdx(w, 0, skin.joints);
    },
    (json) => jsonAssign(json, withWeights(json, { locked })),
  );
}

/** 清空骨架：回落钉子骨（重写一份 P0 的钉子模型，json 里的 skeleton 随之消失） */
async function skelClearSkeleton(session: WarpSession): Promise<boolean> {
  skelMode = null;
  skelArm = false;
  skelParentArm = false;
  skelSel = -1;
  skelPaintBone = -1;
  skelStroke = null;
  session.skeleton = null;
  const ok = await warpWrite(session, session.layout, session.mesh, et("log.skel.clear", { layer: skelLayerName(session) }));
  renderInspector();
  drawOverlay();
  return ok;
}

/** Move Limb to Front：把部件的绘制序抬到最前（写 .mdl 的部件表；本机一次绘制看不懂前后） */
async function skelMoveFront(session: WarpSession, index: number): Promise<boolean> {
  const parts = session.skelParts;
  if (!parts || !parts[index]) {
    log(et("wt.noParts"), "warn");
    return false;
  }
  const next = moveLimbFront(parts, index);
  if (!next) return false;
  const label = et("log.wt.front", { layer: skelLayerName(session), id: parts[index].id, offset: next[index].offset });
  // 两半一起写：offset 抬高（WE 的 draw_order_offset）+ 索引区间整段搬到表尾（部件顺序 = 绘制顺序）
  return skelCommit(session, label, "front", (bytes) => {
    const idx = mdlMeshIndices(bytes, 0);
    const moved = idx ? reorderPartRange(idx, next, index) : null;
    if (!moved) return setMdlParts(bytes, 0, next);
    return setMdlTopology(bytes, 0, moved.indices, moved.parts);
  });
}

/** 转动预览：只动引擎里的局部姿势（_editPose），不写盘；权重面板靠它边涂边看效果 */
function skelPosePreview(session: WarpSession, bone: number, deg: number): void {
  if (!editor || bone < 0) return;
  const rad = (deg * Math.PI) / 180;
  void editor.setBonePose(Number(session.layer), bone, { r: [0, 0, rad] }).catch(() => {});
  drawOverlay();
}

/** 重置姿势：所有骨回到绑定姿势 */
function skelPoseReset(session: WarpSession): void {
  if (!editor) return;
  const n = session.skeleton ? session.skeleton.bones.length : 0;
  for (let i = 0; i < n; i++) void editor.setBonePose(Number(session.layer), i, null).catch(() => {});
  drawOverlay();
}

/** 权重模式的涂抹（一次 = 一个笔刷落点） */
function skelPaintAt(session: WarpSession, at: [number, number], erase: boolean): void {
  const skin = session.skin;
  if (!skin || !session.skelVerts) return;
  const bone = skelPaintBone >= 0 ? skelPaintBone : skelSel;
  if (bone < 0) return;
  paintVertices(skin, session.skelVerts, at, skelBrush, bone, skelStrength, erase ? "remove" : "add");
}

/** 涂抹沿指针路径补点（两次 pointermove 之间隔很远也不留缝） */
function skelPaintStroke(session: WarpSession, from: [number, number], to: [number, number], erase: boolean): void {
  const d = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const steps = Math.max(1, Math.ceil(d / Math.max(1, skelBrush * 0.4)));
  for (let i = 1; i <= steps; i++) {
    skelPaintAt(session, [from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps], erase);
  }
}

/** P2 指针：骨架模式点选 / 打点建骨 / 设父级，权重模式涂抹（都优先于手柄与钉子） */
function skelPointerDown(e: PointerEvent): boolean {
  const hit = skelPointerDownAt(e);
  // 骨架 / 权重模式里点击只服务建模：吞掉随后的 click，别让层选择被改掉（会关掉操控变形面板）
  if (hit) suppressClick = true;
  return hit;
}

function skelPointerDownAt(e: PointerEvent): boolean {
  const t = skelTarget();
  if (!t || !skelMode || e.button !== 0) return false;
  const p = canvasPoint(e);
  const session = t.session;
  const m = p ? skelModelAt(session, p.x, p.y) : null;
  if (!m) return false;
  if (skelMode === "weights") {
    if (!session.skeleton || !session.skin) return false;
    if (skelPaintBone < 0 && skelSel < 0) return false;
    skelStroke = { pointerId: e.pointerId, erase: e.altKey, last: m, base: session.skin.weights.slice() };
    stageEl.setPointerCapture(e.pointerId);
    skelPaintAt(session, m, e.altKey);
    drawOverlay();
    return true;
  }
  const sk = session.skeleton ?? defaultSkeleton();
  if (skelParentArm) {
    const hit = nearestBone(sk, m[0], m[1]);
    if (hit !== null && hit !== skelSel) {
      const parent = skelSel;
      const r = setBoneParent(sk, hit, parent);
      if (r) {
        const name = r.skeleton.bones[remapIndex(r.map, hit)]?.name ?? "";
        const parentName = parent >= 0 && sk.bones[parent] ? sk.bones[parent].name : "";
        log(et("log.skel.parent", { layer: skelLayerName(session), name, parent: parentName }));
        session.skeleton = r.skeleton;
        skelSel = remapIndex(r.map, hit);
      }
    }
    skelParentArm = false;
    renderInspector();
    drawOverlay();
    return true;
  }
  if (skelArm || !session.skeleton) {
    const r = addBone(sk, m[0], m[1], skelArm && skelSel >= 0 ? skelSel : undefined);
    if (r) {
      session.skeleton = r.skeleton;
      skelSel = r.index;
      skelPaintBone = r.index;
      const b = r.skeleton.bones[r.index];
      const parentName = b.parent >= 0 && r.skeleton.bones[b.parent] ? r.skeleton.bones[b.parent].name : "-";
      log(et("log.skel.arm", { layer: skelLayerName(session), name: b.name, parent: parentName }));
    }
    renderInspector();
    drawOverlay();
    return true;
  }
  const hit = nearestBone(sk, m[0], m[1]);
  if (hit !== null) {
    skelSel = hit;
    if (skelPaintBone < 0) skelPaintBone = hit;
  }
  renderInspector();
  drawOverlay();
  return true;
}

function skelPointerMove(e: PointerEvent): boolean {
  const t = skelTarget();
  const stroke = skelStroke;
  if (!t || !skelMode || !stroke || e.pointerId !== stroke.pointerId) return false;
  const p = canvasPoint(e);
  const m = p ? skelModelAt(t.session, p.x, p.y) : null;
  if (m) {
    skelPaintStroke(t.session, stroke.last, m, stroke.erase);
    stroke.last = m;
    drawOverlay();
  }
  return true;
}

function skelPointerUp(e: PointerEvent): boolean {
  const stroke = skelStroke;
  if (!stroke || e.pointerId !== stroke.pointerId) return false;
  const t = skelTarget();
  skelStroke = null;
  const session = t?.session;
  const skin = session?.skin;
  if (session && skin && stroke.base) {
    const n = skelWeightDiff(stroke.base, skin.weights);
    if (n > 0) {
      const bone = skelPaintBone >= 0 ? skelPaintBone : skelSel;
      const name = session.skeleton && session.skeleton.bones[bone] ? session.skeleton.bones[bone].name : String(bone);
      log(et("log.wt.paint", { layer: skelLayerName(session), name, n }));
    }
  }
  renderInspector();
  drawOverlay();
  return true;
}

/** P2 叠加层：骨点 / 父子连线 + 权重模式下的顶点着色（主骨色，或绘制序着色）+ 笔刷圈 */
function drawSkelOverlay(session: WarpSession) {
  if (!skelMode) return;
  const m = layerAffine(session);
  if (!m) return;
  const base = overlayCtx.getTransform();
  overlayCtx.save();
  overlayCtx.setTransform(base.multiply(new DOMMatrix([m[0], m[1], m[2], m[3], m[4], m[5]])));
  const unit = 1 / (Math.hypot(m[0], m[1]) || 1);
  const skin = session.skin;
  if (skelMode === "weights" && skin && session.skelVerts) {
    const vc = session.skelVertexCount;
    const step = vc > SKEL_DRAW_MAX ? Math.ceil(vc / SKEL_DRAW_MAX) : 1;
    const ranks = skelDepth ? skelPartRanks(session) : null;
    for (let v = 0; v < vc; v += step) {
      const c = ranks ? skelBoneColor(ranks[v]) : skelBoneColor(dominantBoneOf(skin, v));
      const p = imageOfModel(session, session.skelVerts[v * 3], session.skelVerts[v * 3 + 1]);
      overlayCtx.fillStyle = `rgba(${c[0]}, ${c[1]}, ${c[2]}, 0.5)`;
      overlayCtx.beginPath();
      overlayCtx.arc(p[0], p[1], 2 * unit, 0, Math.PI * 2);
      overlayCtx.fill();
    }
  }
  const sk = session.skeleton;
  if (sk) {
    overlayCtx.lineWidth = 1.5 * unit;
    for (let i = 0; i < sk.bones.length; i++) {
      const b = sk.bones[i];
      const pb = b.parent >= 0 ? sk.bones[b.parent] : null;
      const p = imageOfModel(session, b.x, b.y);
      if (pb) {
        const q = imageOfModel(session, pb.x, pb.y);
        overlayCtx.strokeStyle = i === skelSel ? "rgba(255,209,102,0.95)" : "rgba(120,200,255,0.8)";
        overlayCtx.beginPath();
        overlayCtx.moveTo(q[0], q[1]);
        overlayCtx.lineTo(p[0], p[1]);
        overlayCtx.stroke();
      }
      overlayCtx.beginPath();
      overlayCtx.arc(p[0], p[1], (i === skelSel ? 5 : 3.5) * unit, 0, Math.PI * 2);
      overlayCtx.fillStyle = i === skelSel ? "rgba(255,209,102,0.95)" : "rgba(120,200,255,0.9)";
      overlayCtx.fill();
      overlayCtx.strokeStyle = "rgba(0,0,0,0.55)";
      overlayCtx.stroke();
    }
  }
  if (skelMode === "weights" && skelStroke) {
    const p = imageOfModel(session, skelStroke.last[0], skelStroke.last[1]);
    overlayCtx.beginPath();
    overlayCtx.arc(p[0], p[1], skelBrush * unit, 0, Math.PI * 2);
    overlayCtx.lineWidth = unit;
    overlayCtx.strokeStyle = skelStroke.erase ? "rgba(255,120,120,0.95)" : "rgba(255,255,255,0.95)";
    overlayCtx.stroke();
  }
  const hint = skelParentArm ? "skel.parent" : skelArm ? "skel.hintArm" : "";
  if (hint) {
    overlayCtx.fillStyle = "rgba(255,209,102,0.95)";
    overlayCtx.font = `${Math.round(11 * unit)}px sans-serif`;
    overlayCtx.fillText(et(hint), 6 * unit, 14 * unit);
  }
  overlayCtx.restore();
}

/** P2 面板用的公共小件：按钮 / 参数行 / 滑杆（与 P1 各分组同一套写法） */
function skelPanel(titleKey: string, cls: string): { group: HTMLElement; actions: HTMLElement } {
  const group = document.createElement("div");
  group.className = `ed-insp-group ${cls}`;
  const h = document.createElement("div");
  h.className = "ed-insp-title";
  h.textContent = et(titleKey);
  const actions = document.createElement("div");
  actions.className = "ed-insp-actions";
  group.appendChild(h);
  return { group, actions };
}

/** 骨架面板（P2）：打点建骨 / 骨列表 / 命名 / 父子 / 删除 / 物理参数 / 应用 */
function skeletonGroup(node: LayerNode): HTMLElement | null {
  const t = warpTarget();
  if (!t || String(t.node.id) !== String(node.id)) return null;
  const session = t.session;
  if (!session.skelVerts && !skelLoading.has(session.modelPath)) {
    void skelEnsure(session).then((ok) => {
      if (ok) {
        renderInspector();
        drawOverlay();
      }
    });
  }
  const editable = !!overlay && !isLocked(node.id);
  const { group, actions } = skelPanel("insp.skeleton", "ed-skel");
  const action = (cls: string, key: string, onClick: () => void, disabled = false) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `ed-btn ${cls}`;
    b.dataset.et = key;
    b.textContent = et(key);
    b.disabled = disabled;
    b.onclick = onClick;
    return b;
  };
  const bones = session.skeleton ? session.skeleton.bones : [];
  group.appendChild(note(et("skel.note", { bones: bones.length, verts: session.skelVertexCount })));
  group.appendChild(note(bones.length ? et("skel.rootNote") : et("skel.noBones")));
  if (bones.length) {
    group.appendChild(note(et("skel.list")));
    const list = document.createElement("div");
    list.className = "ed-skel-list";
    bones.forEach((b, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `ed-btn ed-skel-bone${i === skelSel ? " is-sel" : ""}`;
      btn.textContent = `${i + 1}. ${b.name}`;
      btn.title = b.parent >= 0 && bones[b.parent] ? `${et("skel.parent")}: ${bones[b.parent].name}` : et("skel.rootNote");
      btn.onclick = () => {
        skelSel = i;
        if (skelPaintBone < 0) skelPaintBone = i;
        renderInspector();
        drawOverlay();
      };
      list.appendChild(btn);
    });
    group.appendChild(list);
  }
  if (skelSel >= 0 && bones[skelSel]) {
    group.appendChild(note(et("skel.boneSel", { name: bones[skelSel].name })));
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
    const range = (cls: string, key: string, value: number, min: number, max: number, step: number, onSet: (n: number) => void) => {
      const el = document.createElement("input");
      el.type = "range";
      el.className = cls;
      el.min = String(min);
      el.max = String(max);
      el.step = String(step);
      el.value = String(value);
      el.disabled = !editable;
      el.addEventListener("change", () => onSet(Number(el.value)));
      row(key, el);
      return el;
    };
    const input = document.createElement("input");
    input.type = "text";
    input.className = "ed-skel-name";
    input.maxLength = BONE_NAME_MAX;
    input.value = bones[skelSel].name;
    input.disabled = !editable;
    input.addEventListener("change", () => {
      const sk = session.skeleton;
      if (!sk) return;
      const from = sk.bones[skelSel] ? sk.bones[skelSel].name : "";
      const next = renameBone(sk, skelSel, input.value);
      if (!next) return;
      session.skeleton = next;
      log(et("log.skel.rename", { layer: skelLayerName(session), from, to: next.bones[skelSel].name }));
      renderInspector();
    });
    row("skel.rename", input);
    range("ed-skel-stiff", "skel.stiffness", skelPhysics.stiffness, 0, 1, 0.05, (n) => (skelPhysics.stiffness = n));
    range("ed-skel-damp", "skel.damping", skelPhysics.damping, 0, 1, 0.05, (n) => (skelPhysics.damping = n));
    group.appendChild(form);
  }
  group.appendChild(note(et("skel.physicsNote")));
  const armBtn = action(`ed-skel-arm${skelArm ? " is-arm" : ""}`, skelArm ? "skel.armOn" : "skel.arm", () => {
    skelMode = "skeleton";
    skelArm = !skelArm;
    skelParentArm = false;
    renderInspector();
    drawOverlay();
  }, !editable);
  const parentBtn = action(`ed-skel-parent${skelParentArm ? " is-arm" : ""}`, "skel.parent", () => {
    if (skelSel < 0) {
      log(et("skel.needBone"), "warn");
      return;
    }
    skelMode = "skeleton";
    skelParentArm = !skelParentArm;
    skelArm = false;
    renderInspector();
    drawOverlay();
  }, !editable || skelSel < 0);
  actions.append(
    action("ed-skel-new", "skel.create", () => {
      session.skeleton = defaultBonesFor(session.size);
      skelSel = 0;
      skelPaintBone = 0;
      skelMode = "skeleton";
      log(et("log.skel.create", { layer: skelLayerName(session), bones: session.skeleton.bones.length }));
      renderInspector();
      drawOverlay();
    }, !editable),
    action(`ed-skel-view${skelMode === "skeleton" ? " is-arm" : ""}`, skelMode === "skeleton" ? "skel.viewOn" : "skel.view", () => {
      skelMode = skelMode === "skeleton" ? null : "skeleton";
      skelArm = false;
      skelParentArm = false;
      renderInspector();
      drawOverlay();
    }, !editable),
    armBtn,
    parentBtn,
    action("ed-skel-del", "skel.delete", () => {
      const sk = session.skeleton;
      if (!sk || skelSel < 0) {
        log(et("skel.needBone"), "warn");
        return;
      }
      const gone = sk.bones[skelSel];
      const kids = sk.bones.filter((b) => b.parent === skelSel).length;
      const r = removeBone(sk, skelSel);
      if (!r) return;
      session.skeleton = r.skeleton;
      if (session.skin) session.skin = remapSkin(session.skin, r.map, 0);
      log(et("log.skel.delete", { layer: skelLayerName(session), name: gone.name, n: kids }));
      skelSel = r.skeleton.bones.length ? Math.min(skelSel, r.skeleton.bones.length - 1) : -1;
      skelPaintBone = skelSel;
      renderInspector();
      drawOverlay();
    }, !editable || skelSel < 0),
    action("ed-skel-apply", "skel.apply", () => void skelApplySkeleton(session), !editable || !bones.length),
    action("ed-skel-clear", "skel.clear", () => void skelClearSkeleton(session), !editable || !bones.length),
  );
  group.appendChild(actions);
  return group;
}

/** 权重面板（P2）：自动权重 / 涂抹 / 平滑 / 孤岛混合 / 绘制序 / 转动预览 / 应用 */
function weightsGroup(node: LayerNode): HTMLElement | null {
  const t = warpTarget();
  if (!t || String(t.node.id) !== String(node.id)) return null;
  const session = t.session;
  if (!session.skelVerts && !skelLoading.has(session.modelPath)) {
    void skelEnsure(session).then((ok) => {
      if (ok) {
        renderInspector();
        drawOverlay();
      }
    });
  }
  const editable = !!overlay && !isLocked(node.id);
  const { group, actions } = skelPanel("insp.weights", "ed-wt");
  const action = (cls: string, key: string, onClick: () => void, disabled = false) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `ed-btn ${cls}`;
    b.dataset.et = key;
    b.textContent = et(key);
    b.disabled = disabled;
    b.onclick = onClick;
    return b;
  };
  const sk = session.skeleton;
  const bones = sk ? sk.bones.length : 0;
  if (!bones || !sk) {
    group.appendChild(note(et("wt.needSkel")));
    actions.appendChild(
      action("ed-wt-newskel", "skel.create", () => {
        session.skeleton = defaultBonesFor(session.size);
        skelSel = 0;
        skelPaintBone = 0;
        skelMode = "skeleton";
        log(et("log.skel.create", { layer: skelLayerName(session), bones: session.skeleton.bones.length }));
        renderInspector();
        drawOverlay();
      }, !editable),
    );
    group.appendChild(actions);
    return group;
  }
  let skin = session.skin;
  if (!skin && session.skelVerts) {
    // 建了骨架但还没涂过（或刚换过骨架）：先按最近骨给一份可用的自动权重，面板立刻能涂
    skin = nearestBoneSkin(session.skelVerts, bonePoints(sk));
    session.skin = skin;
  }
  const adj = skelAdjOf(session);
  const islands = skin && adj ? islandsOf(skin, adj) : null;
  const target = skelPaintBone >= 0 && skelPaintBone < bones ? skelPaintBone : Math.max(0, Math.min(bones - 1, skelSel < 0 ? 0 : skelSel));
  group.appendChild(note(et("wt.note", { islands: islands ? islands.count : 0, unpainted: skin ? skelUnpainted(skin) : 0 })));
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
  const range = (cls: string, key: string, value: number, min: number, max: number, step: number, onSet: (n: number) => void) => {
    const el = document.createElement("input");
    el.type = "range";
    el.className = cls;
    el.min = String(min);
    el.max = String(max);
    el.step = String(step);
    el.value = String(value);
    el.disabled = !editable;
    el.addEventListener("change", () => onSet(Number(el.value)));
    row(key, el);
    return el;
  };
  const pick = document.createElement("select");
  pick.className = "ed-wt-target";
  sk.bones.forEach((b, i) => {
    const o = document.createElement("option");
    o.value = String(i);
    o.textContent = `${i + 1}. ${b.name}`;
    pick.appendChild(o);
  });
  pick.value = String(target);
  pick.disabled = !editable;
  pick.addEventListener("change", () => {
    skelPaintBone = Number(pick.value);
    skelSel = Number(pick.value);
    renderInspector();
    drawOverlay();
  });
  row("wt.target", pick);
  range("ed-wt-radius", "wt.radius", skelBrush, BRUSH_RADIUS_MIN, BRUSH_RADIUS_MAX, 1, (n) => {
    skelBrush = n;
    drawOverlay();
  });
  range("ed-wt-strength", "wt.strength", skelStrength, 0.05, 1, 0.05, (n) => (skelStrength = n));
  range("ed-wt-pose", "wt.pose", skelPoseDeg, -180, 180, 5, (n) => {
    skelPoseDeg = n;
    skelPosePreview(session, target, n);
  });
  group.appendChild(form);
  if (skelDepth) group.appendChild(note(et("wt.depthNote")));
  actions.append(
    action("ed-wt-auto", "wt.auto", () => {
      if (!session.skelVerts) return;
      session.skin = nearestBoneSkin(session.skelVerts, bonePoints(sk));
      log(et("log.wt.auto", { layer: skelLayerName(session), n: session.skin.vertexCount }));
      renderInspector();
      drawOverlay();
    }, !editable || !session.skelVerts),
    action(`ed-wt-paint${skelMode === "weights" ? " is-arm" : ""}`, skelMode === "weights" ? "wt.paintOn" : "wt.paint", () => {
      if (skelMode === "weights") {
        skelMode = null;
        skelStroke = null;
      } else {
        skelMode = "weights";
        skelPaintBone = target;
        skelSel = target;
      }
      renderInspector();
      drawOverlay();
    }, !editable || !skin),
    action("ed-wt-clear", "wt.clear", () => {
      if (!session.skin) return;
      session.skin = uniformSkin(session.skin.vertexCount, target);
      log(et("log.wt.clear", { layer: skelLayerName(session) }));
      renderInspector();
      drawOverlay();
    }, !editable || !skin),
    action("ed-wt-smooth", "wt.smooth", () => {
      if (!session.skin || !adj) return;
      const n = smoothSkin(session.skin, adj, 1);
      log(et("log.wt.smooth", { layer: skelLayerName(session), n }));
      renderInspector();
      drawOverlay();
    }, !editable || !skin || !adj),
    action("ed-wt-blend", "wt.blend", () => {
      if (!session.skin || !adj || !islands) return;
      const n = blendIslandBoundary(session.skin, adj, islands, 1);
      log(et("log.wt.blend", { layer: skelLayerName(session), n }));
      renderInspector();
      drawOverlay();
    }, !editable || !skin || !adj),
    action(`ed-wt-depth${skelDepth ? " is-arm" : ""}`, "wt.depth", () => {
      skelDepth = !skelDepth;
      renderInspector();
      drawOverlay();
    }),
    action("ed-wt-poserest", "wt.poseReset", () => {
      skelPoseDeg = 0;
      skelPoseReset(session);
      renderInspector();
    }, !editable),
    action("ed-wt-apply", "wt.apply", () => void skelApplyWeights(session), !editable || !skin),
  );
  group.appendChild(actions);
  const parts = session.skelParts;
  if (parts && parts.length) {
    const sel = document.createElement("select");
    sel.className = "ed-wt-part";
    parts.forEach((p, i) => {
      const o = document.createElement("option");
      o.value = String(i);
      o.textContent = `#${p.id} · ${drawOrderRank(parts, i)}`;
      sel.appendChild(o);
    });
    const front = action("ed-wt-front", "wt.front", () => void skelMoveFront(session, Number(sel.value)), !editable);
    const box = document.createElement("div");
    box.className = "ed-fx-param";
    box.append(sel, front);
    group.appendChild(box);
  } else {
    group.appendChild(note(et("wt.noParts")));
  }
  return group;
}

/** P2 指针挂点：注册在通用监听之后（P1 之后），骨架 / 权重是最后一个模态 */
stageEl.addEventListener("pointerdown", (e) => {
  if (!skelPointerDown(e)) return;
  e.stopImmediatePropagation();
  e.preventDefault();
});
stageEl.addEventListener("pointermove", (e) => {
  if (!skelPointerMove(e)) return;
  e.stopImmediatePropagation();
});
stageEl.addEventListener("pointerup", (e) => {
  if (!skelPointerUp(e)) return;
  e.stopImmediatePropagation();
});
stageEl.addEventListener("pointercancel", (e) => {
  if (!skelPointerUp(e)) return;
  e.stopImmediatePropagation();
});


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
  next: number | null,
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

// ---------- 粒子文件（M2）：直接读写 particles/**.json ----------
//
// 与上面效果常量的热更同款理由：引擎在挂载时自己 JSON.parse 了一份粒子模型
// （scene-mount 的 `const model = JSON.parse(readText(modelEntry))`），改文档结构到不了它，
// 所以这里把**同一份对象**交给引擎（`editor.setParticleModel`），之后就地改值即当帧生效。
// 粒子文件不在 doc 里，撤销按「文件 + 字节」记账（与视频本体同款，见 history 的 fileCommand）。

/** 粒子文件路径 → 已解析的模型（null = 读不出来 / 不是对象） */
const particleFiles = new Map<string, ParticleBox | null>();
/** 粒子文件路径 → 上次落盘的原文（撤销快照的 before 用它，保证字节口径一致） */
const particleFileText = new Map<string, string>();
/** 正在读的粒子文件（避免同一帧里反复发起读取） */
const particlePending = new Set<string>();
/** 折叠面板的展开态（键 = 分区标识） */
const particleOpen = new Set<string>();

/** 图层对象引用的粒子文件路径 */
function particlePathIn(obj: LayerNode["obj"]): string | null {
  const p = (obj as { particle?: unknown }).particle;
  return typeof p === "string" && p ? p : null;
}

/** 按需读一次粒子文件（读完重画检视器；期间换了文档就丢弃结果） */
function loadParticleFile(path: string): void {
  if (particleFiles.has(path) || particlePending.has(path)) return;
  const assets = overlay;
  if (!assets) return;
  particlePending.add(path);
  const dec = new TextDecoder();
  const target = doc;
  void assets
    .read(path)
    .catch(() => null)
    .then((b) => {
      particlePending.delete(path);
      if (!b) {
        particleFiles.set(path, null);
      } else {
        const text = dec.decode(b);
        particleFileText.set(path, text);
        particleFiles.set(path, parseParticleFile(text));
      }
      if (doc === target) renderInspector();
    });
}

/** 把一份粒子文件字节装回 overlay、刷新内存缓存，并热更引擎（提交 / 撤销 / 重做共用） */
function applyParticleBytes(path: string, bytes: Uint8Array): void {
  overlay?.put(path, bytes, path);
  const text = new TextDecoder().decode(bytes);
  particleFileText.set(path, text);
  const parsed = parseParticleFile(text);
  particleFiles.set(path, parsed);
  // 交给引擎的必须是「我们之后还会就地改的那一份」，否则下一次滑条改的是另一份对象
  if (parsed) void editor?.setParticleModel(path, parsed).catch(() => {});
}

/** 粒子字段标签：字段表带的 label 优先，其次 ptp.<字段>，最后用作者原本的字段名 */
const ptFieldLabel = (v: ParticleFieldView) =>
  v.field.label !== undefined ? et(v.field.label) : hasText(`ptp.${v.field.key}`) ? et(`ptp.${v.field.key}`) : v.field.key;

/** 改粒子文件里的一个字段：落盘 + 热更 + 一步撤销（认不出的键 / 值没变时什么都不做） */
function commitParticleField(node: LayerNode, path: string, view: ParticleFieldView, value: EffectValue | string): void {
  const file = particleFiles.get(path);
  const before = particleFileText.get(path);
  if (!file || before === undefined) return;
  if (!setParticleField(file, view.key, value)) return;
  const bytes = serializeParticleFile(file);
  const after = new TextDecoder().decode(bytes);
  if (after === before) return;
  const enc = new TextEncoder();
  const cmd = fileCommand(et("pt.fileEdited", { layer: nodeName(node.id), field: ptFieldLabel(view) }), { path, bytes: enc.encode(before) }, { path, bytes });
  if (cmd) edits.push(cmd);
  markDirty();
  applyParticleBytes(path, bytes);
  renderInspector();
  renderStatus();
}

/** 折叠面板（复用作品自带效果那套 .ed-inline-pass 样式，不新增 CSS） */
function particleDetails(title: string, key: string): { el: HTMLDetailsElement; body: HTMLElement } {
  const det = document.createElement("details");
  det.className = "ed-inline-pass";
  det.open = particleOpen.has(key);
  const sum = document.createElement("summary");
  sum.className = "ed-inline-pass-head";
  sum.textContent = title;
  det.appendChild(sum);
  const body = document.createElement("div");
  body.className = "ed-inline-pass-body";
  det.appendChild(body);
  det.addEventListener("toggle", () => {
    if (det.open) particleOpen.add(key);
    else particleOpen.delete(key);
  });
  return { el: det, body };
}

/** 只读列出未识别的键（原样保留，不给控件） */
function particleUnknownLine(label: string, keys: readonly string[]): HTMLElement {
  const el = document.createElement("div");
  el.className = "ed-inline-unknown";
  el.textContent = `${label}：${keys.join("、")}`;
  return el;
}

/** 一组粒子字段的表单：数值 / 向量 / 布尔走 schema-form，枚举与文本自己搓控件 */
function particleFieldForm(
  views: readonly ParticleFieldView[],
  editable: boolean,
  commit: (v: ParticleFieldView, value: EffectValue | string) => void,
): HTMLElement {
  const simple = views.filter((v) => v.field.type !== "enum" && v.field.type !== "string");
  const byKey = new Map(views.map((v) => [v.key, v]));
  const params: EffectParam[] = [];
  const values: Record<string, EffectValue | undefined> = {};
  for (const v of simple) {
    const p = particleFormParam(v);
    if (!p) continue;
    params.push(p);
    values[v.key] = particleFormValue(v);
  }
  const form = schemaForm({
    params,
    values,
    label: (p) => {
      const v = byKey.get(p.key);
      return v ? ptFieldLabel(v) : p.key;
    },
    disabled: !editable,
    commit: (k, next) => {
      const v = byKey.get(k);
      if (v) commit(v, next);
    },
  });
  for (const v of views) {
    if (v.field.type !== "enum" && v.field.type !== "string") continue;
    const row = document.createElement("label");
    row.className = "ed-fx-param";
    row.dataset.ptField = v.key;
    const name = document.createElement("span");
    name.textContent = ptFieldLabel(v);
    row.appendChild(name);
    if (v.field.type === "enum") {
      const sel = document.createElement("select");
      sel.className = "ed-val";
      for (const opt of v.field.options ?? []) {
        const o = document.createElement("option");
        o.value = opt;
        o.textContent = opt === "" ? "—" : opt;
        sel.appendChild(o);
      }
      sel.value = particleTextValue(v);
      sel.disabled = !editable;
      sel.addEventListener("change", () => commit(v, sel.value));
      row.appendChild(sel);
    } else {
      const inp = document.createElement("input");
      inp.type = "text";
      inp.className = "ed-val";
      inp.value = particleTextValue(v);
      inp.disabled = !editable;
      inp.addEventListener("change", () => commit(v, inp.value));
      row.appendChild(inp);
    }
    form.appendChild(row);
  }
  return form;
}

/** 粒子文件的参数分区：文件级字段 + 五族组件 + 未识别键（只读） */
function particleFileSection(node: LayerNode, editable: boolean): HTMLElement {
  const box = document.createElement("div");
  box.className = "ed-inline-fx";
  box.dataset.particleFile = String(node.id);
  const head = document.createElement("div");
  head.className = "ed-insp-title";
  head.textContent = et("pt.fileTitle");
  box.appendChild(head);

  const path = particlePathIn(node.obj);
  if (!path) {
    box.appendChild(note(et("pt.fileMissing")));
    return box;
  }
  loadParticleFile(path);
  const file = particleFiles.get(path);
  if (file === undefined) {
    box.appendChild(note(et("pt.fileLoading")));
    return box;
  }
  if (file === null) {
    box.appendChild(note(et("pt.fileMissing")));
    return box;
  }
  box.appendChild(note(et("pt.fileHint")));
  const commit = (v: ParticleFieldView, value: EffectValue | string) => commitParticleField(node, path, v, value);

  const top = particleTopViews(file);
  const comps = particleComponentViews(file);
  if (!top.length && !comps.length) {
    box.appendChild(note(et("pt.fileEmpty")));
    return box;
  }
  if (top.length) {
    const det = particleDetails(et("pt.fileTop"), `${path}#top`);
    det.body.appendChild(particleFieldForm(top, editable, commit));
    box.appendChild(det.el);
  }
  for (const c of comps) {
    const groupLabel = hasText(`ptg.${c.group}`) ? et(`ptg.${c.group}`) : c.group;
    const det = particleDetails(`${groupLabel} · ${c.name || et("ptg.controlpoint")}`, `${path}#${c.group}[${c.index}]`);
    if (c.status === "unsupported") det.body.appendChild(note(`${et("pt.statusUnsupported")} —— ${et("pt.unsupportedHint")}`));
    else if (c.status === "unknown") det.body.appendChild(note(et("pt.statusUnknown")));
    else if (c.status === "noPanel") det.body.appendChild(note(et("pt.statusNoPanel")));
    if (c.views.length) det.body.appendChild(particleFieldForm(c.views, editable && c.status === "ok", commit));
    if (c.extraKeys.length) det.body.appendChild(particleUnknownLine(et("pt.fileUnknownKeys"), c.extraKeys));
    box.appendChild(det.el);
  }
  const topExtra = particleTopExtraKeys(file);
  if (topExtra.length) box.appendChild(particleUnknownLine(et("pt.fileUnknownTop"), topExtra));
  return box;
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
 * 容器 / 全屏后期层的「容器」分组（M5 A12）：passthrough 开关、实心旗标、后期旗标。
 *
 * 三个旗标都写在对象自己身上，全部经 objEdit → 结构编辑（可撤销、整场景重挂）：
 *   · 直通   → config.passthrough（**不是**顶层字段；引擎也从 o.config.passthrough 读）
 *   · 实心   → 顶层 solid（引擎判定见 editor/container.ts 的 solidRenders）
 *   · 全屏后期 → 只读指示（image 前缀 projectlayer / fullscreenlayer 就是资源引用本身，
 *                改前缀等于换资源，不在检视器里改）
 *
 * 未知字段与未知 config 键一律不动：结构编辑记的是整份对象数组的 JSON 快照，
 * 这里只碰上面这三个键，其余键（含 config 里我们不认识的键）原样留在对象里。
 */
function containerGroup(node: LayerNode): HTMLElement {
  const group = document.createElement("div");
  group.className = "ed-insp-group ed-container";
  const h = document.createElement("div");
  h.className = "ed-insp-title";
  h.textContent = et("insp.container");
  group.appendChild(h);
  const editable = !!doc?.scene && !!overlay && !isLocked(node.id);
  const o = node.obj;
  const layer = nodeName(node.id);
  const form = document.createElement("div");
  form.className = "ed-fx-params";

  const checkbox = (field: string, key: string, checked: boolean, onChange: (on: boolean) => void) => {
    const label = document.createElement("label");
    label.textContent = et(key);
    const box = document.createElement("div");
    box.className = "ed-fx-param";
    const inp = document.createElement("input");
    inp.type = "checkbox";
    inp.checked = checked;
    inp.disabled = !editable;
    inp.dataset.container = field;
    inp.addEventListener("change", () => onChange(inp.checked));
    box.appendChild(inp);
    form.append(label, box);
    return inp;
  };

  const isCtr = isContainerObject(o);
  const isPost = isFullscreenPostObject(o);

  if (isCtr || isPost) {
    checkbox("passthrough", "ctr.passthrough", hasPassthrough(o), (on) =>
      objEdit(et(on ? "log.passthroughOn" : "log.passthroughOff", { layer }), node.id, (ob) => {
        if (on === hasPassthrough(ob)) return false;
        setPassthrough(ob, on);
        return true;
      }),
    );
  }
  if (isCtr) {
    checkbox("solid", "ctr.solid", !!o.solid, (on) =>
      objEdit(et(on ? "log.solidOn" : "log.solidOff", { layer }), node.id, (ob) => {
        if (!!ob.solid === on) return false;
        if (on) ob.solid = true;
        else delete ob.solid;
        return true;
      }),
    );
    group.appendChild(note(et(solidRenders(o) ? "ctr.solidYes" : "ctr.solidNo")));
  }
  if (isPost) {
    // 只读指示：全屏后期层就是 image 前缀，改前缀等于换掉资源引用，不在检视器里改
    const post = checkbox("post", "ctr.fullscreen", true, () => {});
    post.disabled = true;
    group.appendChild(note(et("ctr.postNote")));
  }
  group.appendChild(form);
  return group;
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
        if (editable && Object.prototype.hasOwnProperty.call(v.combos, k)) {
          // 已经有工程覆盖：给一个「复位」，删掉覆盖即回到材质声明的默认档
          const reset = document.createElement("button");
          reset.type = "button";
          reset.className = "ed-btn ed-inline-combo-reset";
          reset.dataset.comboReset = k;
          reset.textContent = et("fx.libComboReset");
          reset.onclick = () => commitInlineCombo(node.id, v, k, null);
          wrap.appendChild(reset);
        }
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

/**
 * 添加容器层 / 全屏后期层（M5 A12）：走结构编辑（可撤销、整场景重挂）。
 * 尺寸跟着画布走 —— 容器默认盖满画布（子层坐标照旧是绝对坐标），后期层由引擎按
 * general.orthogonalprojection 覆盖，这里写的 origin/scale 只是工程里的可读初值。
 */
function addContainer(kind: "container" | "post" = "container") {
  if (!doc?.scene || !overlay || doc.type !== "scene") {
    log(et("log.structUnavailable"), "warn");
    return;
  }
  const res = sceneResolution(doc.scene) ?? { w: 1920, h: 1080 };
  const name = et(`ctr.${kind}`);
  structEdit(et("log.containerAdded", { name }), (d) => {
    const r = sceneResolution(d.scene) ?? res;
    return (
      addContainerLayer(d, {
        kind,
        name,
        origin: `${Math.round(r.w / 2)} ${Math.round(r.h / 2)} 0`,
        scale: `${Math.round(r.w)} ${Math.round(r.h)} 1`,
        // 空容器 + 效果要能读到已经渲染好的背板，直通默认开（引擎 layerWantsPreserveBackdrop 之外的第二重保险）
        passthrough: true,
      }) ?? undefined
    );
  });

}

/**
 * M4 A6：light / camera 图层的新建入口。
 * 唯一路径是 layer-kinds.ts 的 `createLayerOfKind` —— 也就是 `LayerKindDef.create`
 * 这个字段的生产消费点；工具条按钮因此让「create 被消费」成为可断言的事实，
 * 而不是另写一份构造逻辑（verify-editor 的 LIGHT-CAM 段用去掉 create 的变异源码做红测）。
 */
function addKindLayer(kind: "light" | "camera") {
  if (!doc?.scene || !overlay || doc.type !== "scene") {
    log(et("log.structUnavailable"), "warn");
    return;
  }
  const name = et(kind === "camera" ? "layer.defaultCamera" : "layer.defaultLight");
  const label = et(kind === "camera" ? "log.addedCamera" : "log.addedLight", { name });
  structEdit(label, (d) => createLayerOfKind(kind, d, { name }) ?? undefined);

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
  group.appendChild(particleFileSection(node, editable));
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
const ANIM_LABEL: Record<AnimField, string> = { origin: "f.origin", scale: "f.scale", angles: "f.angles", alpha: "f.alpha", color: "f.color", brightness: "f.brightness" };

/** 画面上的当前值（动画字段 = 曲线在当前时刻的值）；没有引擎时退回静态值 */
function liveValue(node: LayerNode, f: AnimField): number[] {
  const p = editor?.getLayerProps(Number(node.id));
  if (!p) return baseValue(node.obj, f);
  // 1 通道字段（alpha / brightness）在 EditorLayerProps 上是裸数字，不能展开
  return f === "alpha" ? [p.alpha] : f === "brightness" ? [p.brightness] : [...p[f]];
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
  // 生命周期模板下拉（B8）：入口名与派发口径见 editor/scripts.ts 的 SCRIPT_LIFECYCLES
  const tpl = document.createElement("select");
  tpl.id = "script-template";
  tpl.className = "ed-script-template";
  tpl.title = et("sc.tplTip");
  tpl.disabled = !editable;
  for (const life of SCRIPT_LIFECYCLES) {
    const o = document.createElement("option");
    o.value = life;
    o.textContent = et(`sc.tpl.${life}`);
    tpl.appendChild(o);
  }
  add.addEventListener("change", () => {
    const t = add.value;
    if (t) objEdit(et("log.scAdded", { target: t, layer: nodeName(node.id) }), node.id, (o) => setScript(o, t, scriptTemplate(t, tpl.value as ScriptLifecycle)));
  });
  const addRow = document.createElement("div");
  addRow.className = "ed-script-add";
  addRow.append(tpl, add);
  group.appendChild(addRow);
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

// ---------- M4 A5/A6：对象属性直通层 与 light / camera 分组 ----------

const isLockedNode = (id: number | string) => isLocked(id);
/** objp.<key> 的说明文案：唯一真源是 objprops.ts 的规格表，i18n 键由 objFieldNoteKey 派生 */
const objFieldTip = (key: string) => et(objFieldNoteKey(key));
/** 侧栏一行的字段中文名（objp.l.<小写键>）；没配词条时退回引擎键名，绝不显示空白 */
const objFieldLabelKey = (key: string) => `objp.l.${key.toLowerCase()}`;
const objFieldLabelText = (key: string) => (hasText(objFieldLabelKey(key)) ? et(objFieldLabelKey(key)) : key);
/** 侧栏一行的字段标签：中文名 + 引擎原键（tooltip 里带上语义说明），引擎不读的加角标 */
function objFieldLabel(spec: ObjFieldSpec): HTMLElement {
  const lab = document.createElement("label");
  lab.textContent = objFieldLabelText(spec.key);
  lab.dataset.fieldKey = spec.key;
  lab.title = `${spec.key} — ${objFieldTip(spec.key)}`;
  if (spec.engine === "unread") {
    const tag = document.createElement("span");
    tag.className = "ed-tag ed-tag-dim";
    tag.textContent = et("objp.engineUnread");
    tag.title = objFieldTip(spec.key);
    lab.appendChild(tag);
  }
  return lab;
}

/**
 * 「对象属性」分组（M4 A5）：由 editor/objprops.ts 的十六项规格表驱动。
 * 所有写回都走 objEdit → setObjField，于是天然满足：命中原名大小写、不新增歧义键、
 * 只碰这一个字段、`{user|script|animation, value}` 包装只改 .value。
 */
/** 十六项引擎原始字段默认收起（本次会话内记住展开状态） */
let objPropsOpen = false;

function objPropsGroup(node: LayerNode): HTMLElement {
  const group = document.createElement("div");
  group.className = "ed-insp-group ed-objprops";
  // 折叠壳：十六项引擎原始字段默认收起（展开状态在本次会话内记住）
  const det = document.createElement("details");
  det.className = "ed-insp-fold";
  det.open = objPropsOpen;
  const sum = document.createElement("summary");
  sum.className = "ed-insp-fold-head";
  sum.textContent = et("objp.title");
  det.appendChild(sum);
  det.appendChild(note(et("objp.hint")));
  det.addEventListener("toggle", () => {
    objPropsOpen = det.open;
  });
  group.appendChild(det);
  if (!doc?.scene || doc.type !== "scene") {
    det.appendChild(note(et("insp.notLive")));
    return group;
  }
  const id = node.id;
  const form = document.createElement("fieldset");
  form.className = "ed-form ed-objprops-form";
  form.disabled = isLockedNode(id);
  const edit = (spec: ObjFieldSpec, mutate: (o: LayerNode["obj"]) => boolean) =>
    objEditOk(et("objp.edit", { field: spec.key }), id, mutate);
  const num = (v: number | null, step: string): HTMLInputElement => {
    const inp = document.createElement("input");
    inp.type = "number";
    inp.step = String(step);
    if (v === null) inp.placeholder = et("objp.unset");
    else inp.value = String(v);
    return inp;
  };
  const numberRow = (spec: ObjFieldSpec, st: ReturnType<typeof objFieldStates>[number]) => {
    const v = typeof st.value === "number" ? st.value : null;
    const inp = num(v, String(spec.step ?? (spec.type === "int" ? 1 : 0.01)));
    inp.dataset.field = spec.key;
    if (spec.min !== undefined) inp.min = String(spec.min);
    if (spec.max !== undefined) inp.max = String(spec.max);
    inp.addEventListener("change", () => {
      const t = inp.value.trim();
      if (t === "" || !edit(spec, (o) => setObjField(o, spec.key, Number(t)))) inp.value = v === null ? "" : String(v);
    });
    form.append(objFieldLabel(spec), inp);
  };
  const vec2Row = (spec: ObjFieldSpec, st: ReturnType<typeof objFieldStates>[number]) => {
    const cur = Array.isArray(st.value) ? (st.value as number[]) : null;
    const box = document.createElement("div");
    box.className = "span3";
    box.dataset.field = spec.key;
    const ins: HTMLInputElement[] = [];
    for (let i = 0; i < 2; i++) {
      const inp = num(cur ? cur[i] : null, String(spec.step ?? 1));
      inp.title = ["x", "y"][i];
      inp.addEventListener("change", () => {
        const vals = ins.map((x) => Number(x.value || 0));
        if (!vals.every(Number.isFinite) || !edit(spec, (o) => setObjField(o, spec.key, vals))) {
          for (let k = 0; k < 2; k++) ins[k].value = cur ? String(cur[k]) : "";
        }
      });
      ins.push(inp);
      box.appendChild(inp);
    }
    form.append(objFieldLabel(spec), box);
  };
  const boolRow = (spec: ObjFieldSpec, st: ReturnType<typeof objFieldStates>[number]) => {
    const inp = document.createElement("input");
    inp.type = "checkbox";
    inp.checked = st.value === true;
    inp.dataset.field = spec.key;
    inp.addEventListener("change", () => {
      if (!edit(spec, (o) => setObjField(o, spec.key, inp.checked))) inp.checked = st.value === true;
    });
    form.append(objFieldLabel(spec), inp);
  };
  const enumRow = (spec: ObjFieldSpec, st: ReturnType<typeof objFieldStates>[number]) => {
    const sel = document.createElement("select");
    sel.dataset.field = spec.key;
    const opts = ["", ...(spec.options ?? [])];
    const cur = typeof st.value === "string" ? st.value : "";
    if (cur && !opts.includes(cur)) opts.push(cur);
    for (const o of opts) {
      const op = document.createElement("option");
      op.value = o;
      op.textContent = o === "" ? et("objp.unset") : o;
      sel.appendChild(op);
    }
    sel.value = cur;
    sel.addEventListener("change", () => {
      if (sel.value === "") return;
      if (!edit(spec, (o) => setObjField(o, spec.key, sel.value))) sel.value = cur;
    });
    form.append(objFieldLabel(spec), sel);
  };
  const textRow = (spec: ObjFieldSpec, st: ReturnType<typeof objFieldStates>[number]) => {
    const ta = document.createElement("textarea");
    ta.className = "span3";
    ta.rows = spec.type === "json" ? 4 : 1;
    ta.dataset.field = spec.key;
    const cur = objFieldText(spec, st.value);
    ta.value = cur;
    if (st.value === undefined) ta.placeholder = et("objp.unset");
    ta.addEventListener("change", () => {
      if (!edit(spec, (o) => setObjFieldText(o, spec.key, ta.value))) {
        log(et("objp.rawBad", { field: spec.key }), "warn");
        ta.value = cur;
      }
    });
    form.append(objFieldLabel(spec), ta);
  };

  for (const st of objFieldStates(node.obj)) {
    if (st.wrapped) {
      const lab = objFieldLabel(st.spec);
      lab.dataset.wrapped = "1";
      lab.title = `${objFieldTip(st.spec.key)} — ${et("objp.wrapped")}`;
      form.appendChild(lab);
      switch (st.spec.type) {
        case "bool":
          boolRow(st.spec, st);
          break;
        case "enum":
          enumRow(st.spec, st);
          break;
        case "json":
        case "raw":
          textRow(st.spec, st);
          break;
        case "vec2":
          vec2Row(st.spec, st);
          break;
        default:
          numberRow(st.spec, st);
      }
      continue;
    }
    switch (st.spec.type) {
      case "bool":
        boolRow(st.spec, st);
        break;
      case "enum":
        enumRow(st.spec, st);
        break;
      case "json":
      case "raw":
        textRow(st.spec, st);
        break;
      case "vec2":
        vec2Row(st.spec, st);
        break;
      default:
        numberRow(st.spec, st);
    }
  }
  det.appendChild(form);
  return group;
}

/** light 分组（M4 A6）：类型串 / 通道 / 强度 / 半径 / 衰减指数 / 颜色 */
function lightGroup(node: LayerNode): HTMLElement {
  const group = document.createElement("div");
  group.className = "ed-insp-group ed-light";
  const h = document.createElement("div");
  h.className = "ed-insp-title";
  h.textContent = et("insp.light");
  group.appendChild(h);
  const f = getLightFields(node.obj);
  if (!f) {
    group.appendChild(note(et("light.bad")));
    return group;
  }
  // 通道是**派生**事实，不是可编辑字段：^l 前缀走 V1 通道、按 lightconfig 限槽；
  // 无前缀走 4 槽老通道，两条衰减公式不同 ⇒ 这里只读，改通道请改类型串。
  const lane = document.createElement("p");
  lane.className = "ed-note";
  lane.textContent = f.lane === "v1" ? et("light.lane.v1") : et("light.lane.legacy");
  group.appendChild(lane);
  const form = document.createElement("fieldset");
  form.className = "ed-form";
  form.disabled = isLockedNode(node.id);
  const id = node.id;
  const edit = (label: string, mutate: (o: LayerNode["obj"]) => boolean) =>
    objEditOk(et("objp.edit", { field: et(label) }), id, mutate);
  const reset = (inp: HTMLInputElement, v: number) => {
    inp.value = String(v);
  };

  const lab1 = document.createElement("label");
  lab1.textContent = et("light.type");
  lab1.title = et("light.typeTip");
  const sel = document.createElement("select");
  const types = [...LIGHT_TYPES];
  if (!types.includes(f.light as (typeof LIGHT_TYPES)[number])) types.push(f.light as (typeof LIGHT_TYPES)[number]);
  for (const t of types) {
    const op = document.createElement("option");
    op.value = t;
    op.textContent = t;
    sel.appendChild(op);
  }
  sel.value = f.light;
  sel.addEventListener("change", () => {
    if (!edit("light.type", (o) => setLightField(o, "light", sel.value))) sel.value = f.light;
  });
  form.append(lab1, sel);

  const numRow = (key: LightField & ("intensity" | "radius" | "exponent"), label: string, step: string, tip?: string) => {
    const lab = document.createElement("label");
    lab.textContent = et(label);
    if (tip) lab.title = tip;
    const inp = document.createElement("input");
    inp.type = "number";
    inp.step = step;
    inp.value = String(f[key]);
    inp.addEventListener("change", () => {
      const n = Number(inp.value);
      if (!Number.isFinite(n) || !edit(label, (o) => setLightField(o, key, n))) reset(inp, f[key]);
    });
    form.append(lab, inp);
  };
  numRow("intensity", "light.intensity", "0.05");
  numRow("radius", "light.radius", "10");
  numRow("exponent", "light.exponent", "0.1", et("light.exponentTip"));

  const labC = document.createElement("label");
  labC.textContent = et("light.color");
  const box = document.createElement("div");
  box.className = "span3";
  const ins: HTMLInputElement[] = [];
  for (let i = 0; i < 3; i++) {
    const inp = document.createElement("input");
    inp.type = "number";
    inp.step = "0.05";
    inp.min = "0";
    inp.value = String(f.color[i]);
    inp.title = ["r", "g", "b"][i];
    inp.addEventListener("change", () => {
      const v = ins.map((x) => Number(x.value || 0));
      if (!v.every(Number.isFinite) || !edit("light.color", (o) => setLightField(o, "color", v))) {
        for (let k = 0; k < 3; k++) ins[k].value = String(f.color[k]);
      }
    });
    ins.push(inp);
    box.appendChild(inp);
  }
  form.append(labC, box);
  group.appendChild(form);
  return group;
}

/** camera 分组（M4 A6）：相机对象本体（fov / zoom）。相机路径运镜属 M12，这里不做 */
function cameraGroup(node: LayerNode): HTMLElement {
  const group = document.createElement("div");
  group.className = "ed-insp-group ed-camera";
  const h = document.createElement("div");
  h.className = "ed-insp-title";
  h.textContent = et("insp.camera");
  group.appendChild(h);
  const f = getCameraFields(node.obj);
  if (!f) {
    group.appendChild(note(et("camera.bad")));
    return group;
  }
  group.appendChild(note(et("camera.hint")));
  const form = document.createElement("fieldset");
  form.className = "ed-form";
  form.disabled = isLockedNode(node.id);
  const id = node.id;
  const edit = (label: string, mutate: (o: LayerNode["obj"]) => boolean) =>
    objEditOk(et("objp.edit", { field: et(label) }), id, mutate);
  const row = (field: CameraField & ("fov" | "zoom"), label: string, step: string, tip: string) => {
    const lab = document.createElement("label");
    lab.textContent = et(label);
    lab.title = tip;
    const inp = document.createElement("input");
    inp.type = "number";
    inp.step = step;
    inp.value = String(f[field]);
    inp.addEventListener("change", () => {
      const n = Number(inp.value);
      if (!Number.isFinite(n) || !edit(label, (o) => setCameraField(o, field, n))) inp.value = String(f[field]);
    });
    form.append(lab, inp);
  };
  row("fov", "camera.fov", "1", et("camera.fovTip"));
  row("zoom", "camera.zoom", "0.05", et("camera.zoomTip"));
  group.appendChild(form);
  return group;
}

// ---------- 插件宿主（PLUGIN-ARCHITECTURE §2）：main.ts 的闭包包成服务，内置分组 / 命令 / 导出目标登记成插件 ----------

/** 内置检视器分组（顺序 = 旧版硬编码顺序；占 100 的整数倍，插件分组可插在中间） */
const BUILTIN_INSPECTOR: InspectorGroup[] = [
  { id: "multi", order: 100, when: () => extraSel.size > 0, render: () => multiGroup(), tab: "props" },
  { id: "edit", order: 200, when: () => true, render: editGroup, tab: "props" },
  // M4 A5：对象属性直通层（十六个对象级字段）
  { id: "objprops", order: 250, when: () => true, render: objPropsGroup, tab: "props" },
  { id: "anim", order: 300, when: canAnimate, render: animGroup, tab: "anim" },
  { id: "text", order: 400, when: (n) => n.kind === "text", render: textGroup, tab: "props" },
  // M4 A6：light / camera
  { id: "light", order: 450, when: (n) => n.kind === "light", render: lightGroup, tab: "props" },
  { id: "camera", order: 460, when: (n) => n.kind === "camera", render: cameraGroup, tab: "props" },
  { id: "particle", order: 500, when: (n) => n.kind === "particle", render: particleGroup, tab: "props" },
  { id: "sound", order: 600, when: (n) => n.kind === "sound", render: soundGroup, tab: "props" },
  // 操控变形（伪 Live2D）：普通图片层就能转木偶，所以是普通分组而不是木偶工具
  // （木偶工具只在 node.modelForm 存在时才出现，图片层拿不到）
  {
    id: "warp",
    order: 1150,
    when: (n) =>
      (n.kind === "image" && !n.modelForm) ||
      (n.modelForm === "puppet" && warpLayoutOf(String(n.obj.image ?? "")) !== null),
    render: warpGroup,
    tab: "model",
  },
  // P1 几何与角色表：几何（格数 / 细分 / 切片 / Padding / Lock / Edit Topology）与
  // 角色表（limb 部件表 → parts 绘制序）；都挂在操控变形会话上，所以同 tab = model
  { id: "geometry", order: 1160, when: warpPanelOpen, render: geometryGroup, tab: "model" },
  { id: "sheet", order: 1170, when: warpPanelOpen, render: sheetGroup, tab: "model" },
  // P2 骨架与权重：WE 的 Weights 窗口（骨列表 / 打点建骨 / 涂抹权重 / 4 影响上限）
  { id: "skeleton", order: 1180, when: warpPanelOpen, render: skeletonGroup, tab: "model" },
  { id: "weights", order: 1190, when: warpPanelOpen, render: weightsGroup, tab: "model" },
  // 容器 / 全屏后期：三种旗标（直通 / 实心 / 后期）。实心层虽不是容器，也在这里给旗标
  // （引擎的 solid 判定还认 solidlayer，见 container.ts 的 solidRenders）
  { id: "attach", order: 1200, when: () => true, render: attachGroup, tab: "props" },
  {
    id: "container",
    order: 1250,
    when: (n) => n.kind === "container" || n.kind === "fullscreen-post" || !!n.obj.solid,
    render: containerGroup,
    tab: "props",
  },
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

/** 插件运行日志（管理面板的「插件日志」区读它；与 console 无关，纯内存环形缓冲） */
const pluginLog = createPluginLog();

function reportPluginError(name: string, e: unknown, where = "callback", pluginId = name) {
  const msg = (e as Error)?.message ?? String(e);
  pluginLog.push(pluginId, "error", `${where}: ${msg}`);
  log(et("log.pluginError", { name, where, msg }), "error");
}

/** 日志记账用的插件 id：外部插件的代码子插件挂载时带了清单 meta，没有就退回 Scope 名 */
function manifestIdOf(s: { name: string; meta: Record<string, unknown> }): string {
  const m = s.meta.manifest as { id?: string } | undefined;
  return typeof m?.id === "string" ? m.id : s.name;
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

// ── 命令面板 + 动态快捷键总览（M9/C4）──
// 面板条目、输入过滤、快捷键总览三处都只从 commands 注册表（editor/services/commands.ts）枚举，
// 没有第二份手写命令表：标题 / 分类由 id 按约定推出（`cmd.<id>` / `cmd.cat.<id 首段>`，词条在
// editor/i18n.ts），需要自定义文案的命令在 CommandDef.title / .category 上覆盖。
let commandPalette: CommandPalette | null = null;

/** 懒建命令面板（打开前不碰这几个 DOM；宿主缺失时返回 null 而不是抛） */
function ensurePalette(): CommandPalette | null {
  if (commandPalette) return commandPalette;
  const cmds = app?.commands;
  const dialog = $<HTMLDialogElement>("#ed-palette");
  if (!cmds || !dialog) return null;
  commandPalette = createCommandPalette({
    dialog,
    input: $<HTMLInputElement>("#ed-palette-input"),
    list: $<HTMLElement>("#ed-palette-list"),
    shortcuts: $<HTMLElement>("#ed-palette-shortcuts"),
    keysButton: $<HTMLButtonElement>("#ed-palette-keys"),
    closeButton: $<HTMLButtonElement>("#ed-palette-close"),
    commands: cmds,
    t: (key, params) => et(key, params),
    has: hasText,
    text: (v, fallback) => textOf(v, getLang(), fallback),
    log: (msg) => log(msg, "warn"),
  });
  onChangeLang(() => commandPalette?.refresh());
  return commandPalette;
}

$<HTMLButtonElement>("#ed-palette-btn").onclick = () => ensurePalette()?.open();

const builtinUiPlugin = {
  name: "builtin-ui",
  inject: ["inspector", "inspector.tabs", "puppet.tools", "exporters", "commands"],
  apply(ctx: import("./core").Context) {
    for (const t of BUILTIN_INSPECTOR_TABS) ctx.contribute("inspector.tabs", t);
    for (const g of BUILTIN_INSPECTOR) ctx.contribute("inspector", g);
    for (const t of BUILTIN_PUPPET_TOOLS) ctx.contribute("puppet.tools", t);
    ctx.contribute("exporters", VIDEO_EXPORTER);
    const cmds = ctx.get("commands");
    const cmd = (c: Parameters<typeof cmds.register>[0]) => ctx.effect(() => cmds.register(c, ctx.name));
    // 内置命令：展示信息（标题 / 分类）由 id 按约定推出（`cmd.<id>` / `cmd.cat.<id 首段>`，见
    // editor/ui/command-palette.ts），词条补在 editor/i18n.ts —— 命令面板与动态快捷键总览
    // 只枚举这份注册表，没有第二份手写命令表；需要自定义文案的命令在 CommandDef 上写 title/category。
    cmd({ id: "edit.undo", keys: "Mod+Z", run: () => undoRedo("undo") });
    cmd({ id: "edit.redo", keys: ["Mod+Shift+Z", "Mod+Y"], run: () => undoRedo("redo") });
    cmd({ id: "file.save", keys: "Mod+S", run: () => void saveDocument() });
    cmd({ id: "layer.duplicate", keys: "Mod+D", run: () => duplicateSelected() });
    cmd({ id: "layer.rename", keys: "F2", when: () => selectedId !== null, run: (name) => (typeof name === "string" ? renameLayer(selectedId!, name) : beginRename(selectedId!)) });
    cmd({ id: "layer.delete", keys: ["Delete", "Backspace"], when: () => selectedId !== null, run: () => deleteSelected() });
    cmd({ id: "export.run", needsArg: true, run: (id) => void runExport(String(id)) });
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
    {
      // 内置 UI 插件（检视器分组 / 木偶工具 / 视频导出 / 快捷键命令）也走 catalog + profile：
      // 与其它内置插件同一条装配路径，profile 里可按名字 disable 或替换实现
      catalog: { "builtin-ui": builtinUiPlugin },
      profile: { plugins: [{ name: "builtin-ui" }] },
      onError: (s, e, where) => reportPluginError(s.name, e, where, manifestIdOf(s)),
    },
  );
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
  // ── 插件槽位接线（M10/D1）──
  // 除主工具条外的槽位：每个槽位一个宿主容器（editor/index.html），沿用同一条纪律——
  // 没有贡献就隐藏、切语言时重建（item.render 里可能用了 t()）。
  const pluginSlotHosts: Array<[string, string]> = [
    ["menu.export", "#ed-plugin-export"],
    ["menu.add", "#ed-plugin-add"],
    ["panel.right", "#ed-plugin-right"],
    ["inspector.project", "#ed-plugin-project"],
    ["statusbar", "#ed-plugin-status"],
    ["viewport.overlay", "#ed-plugin-overlay"],
  ];
  const unmountPluginSlots: Array<() => void> = [];
  const mountPluginSlots = () => {
    for (const [slot, sel] of pluginSlotHosts) {
      const host = $<HTMLElement>(sel);
      const sync = () => (host.hidden = !ui.items(slot).length);
      unmountPluginSlots.push(ui.mount(slot, host), ui.onChange(slot, sync));
      sync();
    }
  };
  mountPluginSlots();
  onChangeLang(() => {
    for (const off of unmountPluginSlots.splice(0)) off();
    mountPluginSlots();
  });
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
    settings: a.settings,
    logs: pluginLog,
    t: et,
    text,
    log,
    confirmInstall: async (man) => {
      const { low, high } = permissionSummary(man);
      const perms = !low.length && !high.length
        ? et("pl.installNoPerms")
        : et("pl.installPerms", { list: [...high, ...low].join(", ") });
      return confirmDialog({
        title: et("dlg.installTitle"),
        body: `${text(man.name, man.id)} v${man.version}\n${perms}`,
        note: high.length ? et("pl.installHigh", { list: high.join(", ") }) : undefined,
        ok: et("dlg.installOk"),
      });
    },
  });
  // 插件出错/装完/权限开关都往日志里记，面板开着时立刻刷新那一行
  pluginLog.onChange(() => {
    const dlg = $<HTMLDialogElement>("#plugins-dlg");
    if (dlg.open) panel.render();
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
  panelTabs.left.select("layers");
  await openLibrary(it);
})();
// 内置浏览器里刷新 / 重开后，提示上次的工程还在（有 ?item= 时按库条目走，不提示）
void checkVirtualResume();
// 再看有没有未保存编辑的快照（计划 §2 C3）：两条横幅各有各的 DOM 与文案，互不顶替
void checkDraftRecovery();
