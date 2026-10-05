// WebWallGL 编辑器包类型入口（随 dist 发布为 dist/lib/editor.d.ts）。
//
// 现阶段 = 播放包公共类型的全量 re-export（编辑器包是播放包的超集，见
// docs/EDITOR-PLAN.md §0.5）。E0–E3 落地时在本文件追加编辑器专属声明，并与
// api/editor.ts 的导出清单保持同步（verify-arch 会比对两端）。
export * from "./webwallgl";
