// WebWallGL 编辑器包类型入口（随 dist 发布为 dist/lib/editor.d.ts）。
//
// 编辑器包是播放包的超集（docs/EDITOR-PLAN.md §0.5）：先全量 re-export 播放包
// 公共类型，再追加编辑器专属声明。导出清单与 api/editor.ts 保持同步（verify-arch
// 机器比对）；类型本体只能来自 ./types。
import type {
  SceneInstance,
  EditorControls,
  EditorLayer,
  EditorLayerKind,
  EditorCaptureOptions,
  EditorHitTestOptions,
  EditorLayerProps,
  EditorLayerOutline,
  EditorScriptIssue,
  EditorUserPropertyDecl,
  SceneScriptCheck,
} from "./types";

export * from "./webwallgl";
export type {
  EditorScriptIssue,
  EditorUserPropertyDecl,
  SceneScriptCheck,
  EditorControls,
  EditorLayer,
  EditorLayerKind,
  EditorCaptureOptions,
  EditorHitTestOptions,
  EditorLayerProps,
  EditorLayerOutline,
};

/**
 * 取实例的编辑器控制面（时钟 / 出图 / 拾取 / 活层 / 热改）。只有场景壁纸有；
 * 网页、视频壁纸，或场景尚未装配完成时返回 null。
 */
export declare function editorOf(instance: SceneInstance): EditorControls | null;

/**
 * SceneScript 语法预检：与引擎沙箱同一 transform、同为严格模式，只编译不执行。
 * 给出出错行与可派发入口；noEntry 表示引擎会丢弃这段脚本。
 */
export declare function checkSceneScript(script: string): SceneScriptCheck;
