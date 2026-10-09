// 视频壁纸工程（project.type = video）的预览：编辑器自己放一个 <video>，包成与场景同形的
// 实例 / 编辑控制面，时间轴、播放键、逐帧、导出 PNG 全部复用场景那套接线。
// 不经引擎：引擎在静音时走 WebCodecs 逐帧路径，没有可定位的元素；官方视频壁纸本身就是
// 全屏放视频（fit 由客户端决定），这里所见即所得。
import type { EditorCaptureOptions, EditorControls, Fit, SceneInstance } from "../renderer/src/api/editor";

export type VideoStage = { instance: SceneInstance; editor: EditorControls; video: HTMLVideoElement };

const OBJECT_FIT: Record<string, string> = { cover: "cover", contain: "contain", stretch: "fill" };

function seekTo(v: HTMLVideoElement, t: number, timeoutMs = 3000): Promise<void> {
  const d = v.duration;
  const target = Number.isFinite(d) && d > 0 ? Math.min(Math.max(0, t), Math.max(0, d - 1e-3)) : Math.max(0, t);
  if (Math.abs(v.currentTime - target) < 1e-4 && v.readyState >= 2) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      v.removeEventListener("seeked", done);
      resolve();
    };
    const timer = window.setTimeout(done, timeoutMs);
    v.addEventListener("seeked", done);
    v.currentTime = target;
  });
}

export async function mountVideoStage(stage: HTMLElement, bytes: Uint8Array, fit: Fit): Promise<VideoStage> {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "video/mp4" }));
  const v = document.createElement("video");
  v.muted = true;
  v.playsInline = true;
  v.loop = true;
  v.preload = "auto";
  v.dataset.webwallglVideo = "";
  v.style.cssText = "position:absolute;inset:0;width:100%;height:100%;background:#000;display:block";
  v.style.objectFit = OBJECT_FIT[fit] ?? "cover";
  v.src = url;
  stage.appendChild(v);
  await new Promise<void>((resolve, reject) => {
    if (v.readyState >= 2) return resolve();
    v.addEventListener("loadeddata", () => resolve(), { once: true });
    v.addEventListener("error", () => reject(new Error(`video error ${v.error?.code ?? "?"}`)), { once: true });
  });
  let paused = true;
  let scale = 1;
  let destroyed = false;
  const sync = () => {
    if (destroyed) return;
    if (paused || scale === 0) v.pause();
    else {
      v.playbackRate = scale;
      void v.play().catch(() => {});
    }
  };
  const frame = (opts: EditorCaptureOptions = {}): HTMLCanvasElement => {
    let w = opts.width ?? 0;
    let h = opts.height ?? 0;
    const vw = v.videoWidth || 1;
    const vh = v.videoHeight || 1;
    if (w && !h) h = (w * vh) / vw;
    else if (h && !w) w = (h * vw) / vh;
    else if (!w && !h) {
      w = vw;
      h = vh;
    }
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    c.getContext("2d")!.drawImage(v, 0, 0, c.width, c.height);
    return c;
  };
  const capture = (opts: EditorCaptureOptions = {}): Promise<Blob> => {
    const c = frame(opts);
    return new Promise((resolve, reject) =>
      c.toBlob((b) => (b ? resolve(b) : reject(new Error("capture failed"))), opts.type ?? "image/png", opts.quality),
    );
  };
  const editor: EditorControls = {
    get time() {
      return v.currentTime;
    },
    get timeScale() {
      return scale;
    },
    seek: (t) => seekTo(v, t),
    setTimeScale(s) {
      scale = Number.isFinite(s) && s > 0 ? s : 0;
      sync();
    },
    step: (frames = 1, fps = 60) => seekTo(v, v.currentTime + Math.max(1, Math.floor(frames)) / (fps > 0 ? fps : 60)),
    async capture(opts) {
      if (opts?.time !== undefined) await seekTo(v, opts.time);
      return capture(opts);
    },
    async captureFrame(opts) {
      if (opts?.time !== undefined) await seekTo(v, opts.time);
      return frame(opts);
    },
    hitTestAt: () => [],
    getLayers: () => [],
    getLayerProps: () => null,
    getModelInfo: () => null,
    setLayerProps: async () => {},
    setAnimationLayers: async () => {},
    getAttachmentPoints: () => null,
    setBonePose: async () => {},
    getBonePoints: () => null,
    getLayerOutline: () => null,
    screenDeltaToLocal: () => null,
    getScriptIssues: () => [],
    getSkippedScripts: () => 0,
    declareUserProperties: async () => {},
    // M12：视频项目没有场景图层 / GL 通道，这些入口一律给「无」语义（不是抛错）——
    // 编辑器页对视频工程复用同一套控制面，抛错会在面板刷新路径上炸成红条。
    setOverlayMode: async () => "off" as const,
    getOverlayMode: () => "off" as const,
    setOverlayTarget: async () => {},
    getOverlayStats: () => ({ mode: "off" as const, target: null, segments: 0, draws: 0, glOk: false, reason: "video-project" }),
    canHotAddLayer: () => ({ ok: false, reason: "视频工程没有场景图层" }),
    addLayer: async () => {
      throw new Error("视频工程没有场景图层");
    },
    removeLayer: async () => {},
    reorderLayer: async () => {},
    setLayerScript: async () => {},
  };
  const base = {
    get canvas() {
      return v as unknown as HTMLCanvasElement;
    },
    pause() {
      paused = true;
      sync();
    },
    resume() {
      paused = false;
      sync();
    },
    get paused() {
      return paused;
    },
    setFit(f: Fit) {
      v.style.objectFit = OBJECT_FIT[f] ?? "cover";
    },
    get info() {
      return { width: v.videoWidth, height: v.videoHeight, layerCount: 0 };
    },
    get stats() {
      return undefined;
    },
    destroy() {
      destroyed = true;
      v.pause();
      v.removeAttribute("src");
      v.load();
      v.remove();
      URL.revokeObjectURL(url);
    },
  };
  // 场景实例的其余能力（属性 / 音频 / 遮挡…）对视频预览没有意义，一律空操作
  const instance = new Proxy(base, {
    get(target, key, recv) {
      if (key in target) return Reflect.get(target, key, recv);
      return () => undefined;
    },
  }) as unknown as SceneInstance;
  return { instance, editor, video: v };
}

/** 视频壁纸的 project.json：type = video、file 指视频 */
export function videoProjectJson(title: string, file: string, preview?: string): Record<string, unknown> {
  const p: Record<string, unknown> = { type: "video", title, file };
  if (preview) p.preview = preview;
  return p;
}
