// WebWallGL 编辑器包出口（npm 子路径 webwallgl/editor，产物形态见 docs/EDITOR-PLAN.md §0.5）。
//
// 定位：编辑器使能层，播放包的**超集** —— EDITOR-PLAN 里程碑 E0–E3 的编辑器 API
// （可控时钟、场景图可变、拾取、单帧出图、保存链路、效果库）全部落在本文件与
// renderer/src/editor/ 下。编辑器应用只 import 这一个出口，播放包根出口保持最小面
// 不动（桌面 App 的 file: 依赖零改动）。导出清单与 editor.d.ts 由 verify-arch 比对。
export * from "./index";
export { editorOf } from "../editor/controls";
export { checkSceneScript } from "../editor/scripts";
export { buildScenePkg } from "../editor/pkg-export";
export { checkWeCompat } from "../editor/compat";
export {
  encodeMdl,
  mdlMeshMaterials,
  retargetMdlMaterial,
  mdlClips,
  mdlBoneCount,
  mdlBoneMeta,
  setMdlBoneMeta,
  mdlMeshCount,
  mdlMeshInfo,
  mdlMeshPositions,
  mdlMeshIndices,
  setMdlParts,
  setMdlPositions,
  setMdlVertexZ,
  setMdlTopology,
  mdlBones,
  setMdlBoneNames,
  setMdlSkeleton,
  mdlSkin,
  setMdlWeights,
  setMdlBoneIdx,
  applyBoneDelta,
  boneDeltaWeights,
  CLIP_MODES,
  resampleTrack,
  addMdlClip,
  removeMdlClip,
  clearMdlClips,
  setMdlClipMeta,
  setMdlClipEvents,
} from "../editor/mdl-edit";
// P2：骨架与权重的写侧类型（与上面那组函数同源，直接来自 mdl-edit）
export type { MdlBoneInfo, MdlBoneSpec } from "../editor/mdl-edit";
export { SYSTEM_FONT_FAMILIES, TEXT_EM_SCALE } from "../types";
// M12（B7）：相机路径（`scripts/camera_paths_*.json`）的只读体检 + clip 队列 / queuemode 读写。
// 页面侧只准 import 本出口，不许直接碰 renderer/src/editor/ 下的实现。
export {
  normalizeQueueMode,
  kindOfCameraPathDoc,
  describeCameraPath,
  sampleCameraPath,
  resolveCameraFovZoom,
  readQueueMode,
  writeQueueMode,
  moveCameraPathClip,
  removeCameraPathClip,
} from "../editor/camera-path";
export type {
  ScenePkgFile,
  ScenePkgResult,
  WeCompatIssue,
  WeCompatReport,
  EditorControls,
  EditorScriptIssue,
  EditorUserPropertyDecl,
  SceneScriptCheck,
  EditorLayer,
  EditorLayerKind,
  // M12（W2b / W5）：增量装配 + GL overlay 通道的公开类型
  EditorLayerAddSpec,
  EditorHotAddCheck,
  EditorOverlayMode,
  EditorOverlayStats,
  // M12（B7）：相机路径的公开类型
  CameraQueueMode,
  CameraPathKind,
  CameraPathClipInfo,
  CameraPathReport,
  CameraPathPose,
  CameraFovZoom,
  EditorCaptureOptions,
  EditorFrameOptions,
  EditorHitTestOptions,
  EditorLayerProps,
  EditorLayerOutline,
  EditorModelInfo,
  EditorAttachmentPoint,
  EditorBonePose,
  EditorBonePoint,
  MdlBoneDelta,
  MdlClip,
  MdlClipInit,
  MdlPart,
  MdlSpec,
} from "./types";
