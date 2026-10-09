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
    setEffectConstants: (id, effect, pass, values) => cur().setEffectConstants(id, effect, pass, values),
    setParticleModel: (path, model) => cur().setParticleModel(path, model),
    getAttachmentPoints: (id) => rt.sceneCtl?.editor?.getAttachmentPoints(id) ?? null,
    setBonePose: (id, bone, pose) => cur().setBonePose(id, bone, pose),
    getBonePoints: (id) => rt.sceneCtl?.editor?.getBonePoints(id) ?? null,
    getLayerOutline: (id) => rt.sceneCtl?.editor?.getLayerOutline(id) ?? null,
    screenDeltaToLocal: (id, dx, dy) => rt.sceneCtl?.editor?.screenDeltaToLocal(id, dx, dy) ?? null,
    getScriptIssues: () => rt.sceneCtl?.editor?.getScriptIssues() ?? [],
    getSkippedScripts: () => rt.sceneCtl?.editor?.getSkippedScripts() ?? 0,
    declareUserProperties: (decls) => cur().declareUserProperties(decls),
    // M12：以下都转发到**当前装配代**（不缓存旧代）。id 为 number|string，引擎内部
    // 按数字 id 查表，这里统一转数字（取不到有效数字就当 null = 无目标）。
    setOverlayMode: (mode) => cur().setOverlayMode(mode),
    getOverlayMode: () => rt.sceneCtl?.editor?.getOverlayMode() ?? "2d",
    setOverlayTarget: (id) => cur().setOverlayTarget(numOrNull(id)),
    getOverlayStats: () =>
      rt.sceneCtl?.editor?.getOverlayStats() ?? {
        mode: "2d",
        target: null,
        segments: 0,
        draws: 0,
        glOk: false,
        reason: "no-editor",
      },
    canHotAddLayer: (spec) => rt.sceneCtl?.editor?.canHotAddLayer(spec) ?? { ok: false, reason: "no-editor" },
    addLayer: (spec) => cur().addLayer(spec),
    removeLayer: (id) => cur().removeLayer(asEngineId(id)),
    reorderLayer: (id, toIndex) => cur().reorderLayer(asEngineId(id), toIndex),
    setLayerScript: (id, target, code) => cur().setLayerScript(asEngineId(id), target, code),
  };
}

/** number|string|null → number（非法输入回 null，交由引擎按「无目标」处理） */
function numOrNull(id: number | string | null): number | null {
  if (id === null || id === undefined) return null;
  const n = Number(id);
  return Number.isFinite(n) ? n : null;
}

/** 需要数字 id 的入口统一走这里：能转数字就转，否则原样传（引擎按 String 比对） */
function asEngineId(id: number | string): number | string {
  const n = numOrNull(id);
  return n === null ? id : n;
}
