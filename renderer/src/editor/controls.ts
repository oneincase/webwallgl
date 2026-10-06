// 编辑器控制面出口（docs/EDITOR-PLAN.md E0）。实现本体在 scene-mount 的渲染循环
// 闭包里（时钟/帧/相机都只在那里可得），这里只做「公共实例 → 当前装配代」的转发：
// setRenderDpr / restore / load 会重建装配代，返回的控制面每次调用都取最新那一代。
import type { EditorControls, SceneInstance } from "../api/types";
import { runtimeOf } from "../runtime-link";

export function editorOf(instance: SceneInstance): EditorControls | null {
  const rt = runtimeOf(instance);
  if (!rt?.sceneCtl?.editor) return null;
  const cur = (): EditorControls => {
    const ed = rt.sceneCtl?.editor;
    if (!ed) throw new Error("editor controls unavailable: scene not mounted");
    return ed;
  };
  return {
    get time() {
      return rt.sceneCtl?.editor?.time ?? 0;
    },
    get timeScale() {
      return rt.sceneCtl?.editor?.timeScale ?? 1;
    },
    seek: (t) => cur().seek(t),
    setTimeScale: (s) => cur().setTimeScale(s),
    step: (frames, fps) => cur().step(frames, fps),
    capture: (opts) => cur().capture(opts),
    captureFrame: (opts) => cur().captureFrame(opts),
    hitTestAt: (x, y, opts) => rt.sceneCtl?.editor?.hitTestAt(x, y, opts) ?? [],
    getLayers: () => rt.sceneCtl?.editor?.getLayers() ?? [],
    getLayerProps: (id) => rt.sceneCtl?.editor?.getLayerProps(id) ?? null,
    getModelInfo: (id) => rt.sceneCtl?.editor?.getModelInfo(id) ?? null,
    setLayerProps: (id, patch) => cur().setLayerProps(id, patch),
    setAnimationLayers: (id, layers) => cur().setAnimationLayers(id, layers),
    getAttachmentPoints: (id) => rt.sceneCtl?.editor?.getAttachmentPoints(id) ?? null,
    getLayerOutline: (id) => rt.sceneCtl?.editor?.getLayerOutline(id) ?? null,
    screenDeltaToLocal: (id, dx, dy) => rt.sceneCtl?.editor?.screenDeltaToLocal(id, dx, dy) ?? null,
    getScriptIssues: () => rt.sceneCtl?.editor?.getScriptIssues() ?? [],
    getSkippedScripts: () => rt.sceneCtl?.editor?.getSkippedScripts() ?? 0,
    declareUserProperties: (decls) => cur().declareUserProperties(decls),
  };
}
