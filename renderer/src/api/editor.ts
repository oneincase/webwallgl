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
export { mdlMeshMaterials, retargetMdlMaterial } from "../editor/mdl-edit";
export { SYSTEM_FONT_FAMILIES, TEXT_EM_SCALE } from "../types";
export type {
  ScenePkgFile,
  ScenePkgResult,
  EditorControls,
  EditorScriptIssue,
  EditorUserPropertyDecl,
  SceneScriptCheck,
  EditorLayer,
  EditorLayerKind,
  EditorCaptureOptions,
  EditorFrameOptions,
  EditorHitTestOptions,
  EditorLayerProps,
  EditorLayerOutline,
  EditorModelInfo,
  EditorAttachmentPoint,
} from "./types";
