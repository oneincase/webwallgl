// 公共 API 入口：mount() / createScene()（docs/LIBRARY-PLAN.md §3）
//
// 每个 SceneInstance 持有独立的 Runtime（shell.createRuntime）：cfg、帧率计、
// 渲染器、属性表互不可见 —— 一页多实例成立。装配经 dispatch.mountWallpaper，
// 与壁纸页 window.__wp 走同一条路。
// 按 project.type 分流三类：web / video·gif·image（媒体）/ 其余走 scene。

import {
  clear,
  createRuntime,
  destroyRuntime,
  frameStats,
  resetCoverAlign,
  resetFrameMeter,
  type Runtime,
} from "../shell";
import { mountWallpaper } from "../dispatch";
import type { WallpaperConfig } from "../types";
import { weShimCall } from "../web";
import type {
  AudioSource,
  Fit,
  MountOptions,
  PropertyValue,
  SceneEvents,
  SceneInfo,
  SceneInstance,
  Source,
} from "./types";

/** 归一化旧 fit 别名（fill/fit 是 WE 旧会话遗留，见 shell.normalizeFit） */
function normalizeFitOption(fit: string | undefined): Fit {
  if (fit === "fit") return "contain";
  if (fit === "fill") return "cover";
  return fit === "contain" || fit === "stretch" ? fit : "cover";
}

function isWebProject(project: unknown): boolean {
  const t = (project as { type?: unknown } | null)?.type;
  return typeof t === "string" && t.toLowerCase() === "web";
}

/** 媒体壁纸的三种 type（dispatch.ts 把它们统一路由到 mountMedia） */
const MEDIA_TYPES = new Set(["video", "gif", "image"]);

/** project.type ∈ {video,gif,image} → 媒体壁纸；返回小写后的 type，否则 null */
function mediaProjectType(project: unknown): string | null {
  const t = (project as { type?: unknown } | null)?.type;
  if (typeof t !== "string") return null;
  const lower = t.toLowerCase();
  return MEDIA_TYPES.has(lower) ? lower : null;
}

/** 场景路径需要真 canvas；若调用方给了空容器则在其内自建一块 */
function ensureSceneCanvas(el: HTMLElement): HTMLCanvasElement {
  if (el instanceof HTMLCanvasElement) return el;
  const existing = el.querySelector(":scope > canvas[data-webwallgl]");
  if (existing instanceof HTMLCanvasElement) return existing;
  const c = document.createElement("canvas");
  c.setAttribute("data-webwallgl", "1");
  c.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;";
  if (getComputedStyle(el).position === "static") el.style.position = "relative";
  el.appendChild(c);
  return c;
}

async function resolveMountConfig(
  el: HTMLElement,
  o: MountOptions,
): Promise<WallpaperConfig> {
  const base = {
    fit: normalizeFitOption(o.fit),
    renderDpr: o.renderDpr ?? 1,
    sceneFps: o.fps ?? 60,
    muted: (o.volume ?? 0) <= 0,
    loop: true,
    canvas: el,
    source: o.source,
  };
  let project: unknown = null;
  try {
    project = (await o.source.project?.()) ?? null;
  } catch {
    project = null;
  }
  if (isWebProject(project)) {
    let url: string | undefined;
    try {
      const entry = await o.source.webEntry?.();
      url = entry?.url;
    } catch {
      url = undefined;
    }
    if (!url && o.source.key) {
      // httpSource.key 就是 baseUrl；无 webEntry 时兜底 index.html
      const file =
        project && typeof (project as { file?: unknown }).file === "string"
          ? String((project as { file: string }).file).trim().replace(/^\/+/, "") || "index.html"
          : "index.html";
      url = `${o.source.key.replace(/\/+$/, "")}/${file}`;
    }
    if (!url) throw new Error("网页壁纸：无法解析入口 URL（需要 Source.webEntry 或 httpSource）");
    return { ...base, type: "web", src: url, source: o.source };
  }
  // 媒体壁纸（video / gif / image）：dispatch 路由到 mountMedia，需要一个 src URL。
  // 与 web 分支同构的三段式：Source.mediaEntry() → {key}/{project.file} → 抛错。
  // 兜底这一段是给「自己实现 Source 但没实现 mediaEntry」的调用方留的，
  // 只要 key 是个 HTTP 基址就还能拼出来；bytesSource/fileSource 没有 key，
  // 也确实拿不到视频地址（本地字节里没有这个信息），此时如实抛错。
  const mediaType = mediaProjectType(project);
  if (mediaType) {
    let url: string | undefined;
    try {
      const entry = await o.source.mediaEntry?.();
      url = entry?.url;
    } catch {
      url = undefined;
    }
    if (!url && o.source.key) {
      const file =
        project && typeof (project as { file?: unknown }).file === "string"
          ? String((project as { file: string }).file).trim().replace(/^\/+/, "")
          : "";
      // 媒体没有 index.html 那样的惯例文件名，缺 file 就别猜（猜必 404）
      if (file) url = `${o.source.key.replace(/\/+$/, "")}/${file}`;
    }
    if (!url) {
      throw new Error(
        `媒体壁纸（${mediaType}）：无法解析资源 URL（需要 Source.mediaEntry 或 project.file + httpSource）`,
      );
    }
    const canvas = ensureSceneCanvas(el);
    return { ...base, type: mediaType as WallpaperConfig["type"], src: url, canvas, source: o.source };
  }
  // 其余一律走场景装配
  const canvas = ensureSceneCanvas(el);
  return { ...base, type: "scene", canvas, source: o.source };
}

/**
 * 同步创建实例。加载由后续 load() 或内部 applyOptions 驱动；
 * 一般使用者请用 mount()。
 */
export function createScene(
  el: HTMLElement,
  options?: Partial<Omit<MountOptions, "source">>,
): SceneInstance {
  const rt: Runtime = createRuntime();
  const events: {
    ready: Array<SceneEvents["ready"]>;
    error: Array<SceneEvents["error"]>;
    diagnostic: Array<SceneEvents["diagnostic"]>;
  } = { ready: [], error: [], diagnostic: [] };

  let currentOptions: MountOptions = { ...(options ?? {}), source: null as unknown as Source };

  // 对外仍暴露 .canvas：场景是真 canvas；网页是传入的容器元素
  let boundEl: HTMLElement = el;

  const emitError = (err: Error) => {
    for (const fn of events.error) {
      try {
        fn(err);
      } catch {
        /* 订阅者抛错不打断渲染 */
      }
    }
  };

  const wireOptions = (o: MountOptions) => {
    rt.onDiagnostic = (msg, level) => {
      try {
        o.onDiagnostic?.(msg, level);
      } catch {
        /* 忽略 */
      }
      for (const fn of events.diagnostic) {
        try {
          fn(msg, level);
        } catch {
          /* 忽略 */
        }
      }
    };
    rt.onError = (err) => {
      try {
        o.onError?.(err);
      } catch {
        /* 忽略 */
      }
      emitError(err);
    };
    rt.onSceneInfo = (info) => {
      rt.info = info;
    };
    // 音频频谱源：拉模式，渲染循环每帧调一次。只在选项里显式出现时才动
    // rt.audioBridge —— 否则 load() 换场景会把 setAudio() 装好的宿主源
    // 冲回 undefined（挂载选项里本来就没有 audio 这一项）。
    if ("audio" in o) applyAudio(o.audio ?? null);
  };

  /** 把公共 AudioSource 接到运行时的拉模式桥；null = 回落内置模拟源 */
  const applyAudio = (src: AudioSource | null) => {
    if (!src) {
      rt.audioBridge = null;
      return;
    }
    rt.audioBridge = () => {
      try {
        const s = src.snapshot();
        // 返回 null 是「本帧无数据」的合法信号，引擎会回落模拟源；
        // 提供方抛错也按无数据处理，不让一次异常掀掉整个渲染循环。
        return s && s.left && s.right ? s : null;
      } catch {
        return null;
      }
    };
  };

  const armFirstFrame = (): Promise<void> => {
    return new Promise<void>((resolve) => {
      const prev = rt.onFirstFrame;
      rt.onFirstFrame = () => {
        rt.onFirstFrame = undefined;
        prev?.();
        const info = (rt.info as SceneInfo) ?? {
          width: 0,
          height: 0,
          layerCount: 0,
          hasModels: false,
          hasParticles: false,
          hasText: false,
        };
        try {
          currentOptions.onReady?.(info);
        } catch {
          /* 忽略 */
        }
        for (const fn of events.ready) {
          try {
            fn(info);
          } catch {
            /* 忽略 */
          }
        }
        resolve();
      };
    });
  };

  const armFailure = (): { promise: Promise<never>; off: () => void } => {
    let off: () => void = () => {};
    const promise = new Promise<never>((_, reject) => {
      off = instance.on("error", (e) => reject(e));
    });
    return { promise, off };
  };

  const instance: SceneInstance = {
    get canvas() {
      return boundEl as HTMLCanvasElement;
    },

    pause() {
      rt.paused = true;
      rt.sceneCtl?.pause();
    },
    resume() {
      rt.paused = false;
      resetFrameMeter(rt);
      rt.sceneCtl?.resume();
    },
    get paused() {
      return !!rt.paused;
    },

    setFit(fit: Fit) {
      rt.cfg.fit = fit;
      resetCoverAlign(rt);
    },
    setFps(fps: number) {
      rt.cfg.sceneFps = fps;
      weShimCall(rt, (w) => w.__weSetFps?.(fps));
    },
    setVolume(volume: number) {
      const v = Math.max(0, Math.min(1, volume));
      rt.cfg.muted = v <= 0;
      rt.sceneAudio?.setVolume(v);
      weShimCall(rt, (w) => w.__weSetVolume?.(v));
    },
    setRenderDpr(dpr: number) {
      rt.cfg.renderDpr = dpr;
      mountWallpaper(rt, rt.cfg);
    },

    setProperties(props: Record<string, PropertyValue>) {
      const wire: Record<string, { value: unknown }> = {};
      for (const [k, v] of Object.entries(props)) wire[k] = { value: v };
      rt.sceneCtl?.applyUserProperties(wire);
    },
    getProperties() {
      return { ...(rt.liveUserProps ?? {}) } as Record<string, PropertyValue>;
    },

    // 宿主频谱源。只存引用，实际每帧拉取在 scene-mount 的渲染循环里。
    // 与 __wp.setAudioBridge 同纪律：换场景不清空，装一次对之后所有场景生效
    // （wireOptions 也只在选项里出现 audio 时才覆盖，见那里的说明）。
    setAudio(src: AudioSource | null) {
      currentOptions = { ...currentOptions, audio: src };
      applyAudio(src);
    },

    // 外部指针注入。pointerCtl 由 mountScene / mountWeb 各自装配时设置，
    // 媒体壁纸不设 —— 那时这里静默无效，与整页渲染器的 __wp.pushPointer 一致。
    pushPointer(u: number, v: number, buttons?: number) {
      rt.pointerCtl?.push({ u, v, buttons });
    },
    pointerLeave() {
      rt.pointerCtl?.leave();
    },

    async load(source: Source) {
      currentOptions = { ...currentOptions, source };
      wireOptions(currentOptions);
      const cfg = await resolveMountConfig(boundEl, currentOptions);
      // scene 与媒体都画在 canvas 上（resolveMountConfig 里 ensureSceneCanvas 取到
      // 的那一块）；网页路径没有 canvas，boundEl 保持调用方传入的容器。
      if (cfg.type !== "web" && cfg.canvas instanceof HTMLCanvasElement) {
        boundEl = cfg.canvas;
      }
      rt.cfg = cfg;
      rt.paused = false;
      rt.info = undefined;
      resetCoverAlign(rt);
      if (currentOptions.properties) {
        rt.liveUserProps = { ...currentOptions.properties };
      }
      const firstFrame = armFirstFrame();
      const failure = armFailure();
      mountWallpaper(rt, cfg);
      try {
        await Promise.race([firstFrame, failure.promise]);
      } finally {
        failure.off();
      }
    },

    release() {
      clear(rt);
    },
    restore() {
      mountWallpaper(rt, rt.cfg);
    },
    destroy() {
      destroyRuntime(rt);
      rt.onDiagnostic = undefined;
      rt.onError = undefined;
      rt.onFirstFrame = undefined;
      rt.onSceneInfo = undefined;
      events.ready.length = 0;
      events.error.length = 0;
      events.diagnostic.length = 0;
    },

    get stats() {
      return frameStats(rt);
    },
    get info() {
      return (rt.info as SceneInfo) ?? null;
    },

    on<K extends keyof SceneEvents>(ev: K, fn: SceneEvents[K]) {
      const list = events[ev] as Array<SceneEvents[K]>;
      list.push(fn);
      return () => {
        const i = list.indexOf(fn);
        if (i >= 0) list.splice(i, 1);
      };
    },
  };

  const applyOptions = async (o: MountOptions) => {
    currentOptions = o;
    wireOptions(o);
    const cfg = await resolveMountConfig(el, o);
    // 同 load()：scene 与媒体都以 canvas 为绑定元素，网页保持容器
    if (cfg.type !== "web" && cfg.canvas instanceof HTMLCanvasElement) {
      boundEl = cfg.canvas;
    }
    rt.cfg = cfg;
    rt.paused = o.autoplay === false;
    rt.info = undefined;
    resetCoverAlign(rt);
    if (o.properties && Object.keys(o.properties).length) {
      rt.liveUserProps = { ...o.properties };
    }
    const firstFrame = armFirstFrame();
    const failure = armFailure();
    mountWallpaper(rt, rt.cfg);
    try {
      await Promise.race([firstFrame, failure.promise]);
    } finally {
      failure.off();
    }
    if ((o.volume ?? 0) > 0) instance.setVolume(o.volume as number);
    // 网页种子属性已在 HTML 改写时灌入；再推一次覆盖热更路径
    if (o.properties && Object.keys(o.properties).length) instance.setProperties(o.properties);
  };

  (instance as unknown as { __applyOptions?: (o: MountOptions) => Promise<void> }).__applyOptions =
    applyOptions;

  return instance;
}

/**
 * 把一张 WE 壁纸（scene 或 web）挂到元素上。Promise 在首帧/iframe load 后 resolve。
 * 网页壁纸推荐空 `<div>`；传入 canvas 时 iframe 挂到其父节点。
 */
export async function mount(
  el: HTMLElement,
  options: MountOptions,
): Promise<SceneInstance> {
  const instance = createScene(el, options);
  const withApply = instance as unknown as { __applyOptions: (o: MountOptions) => Promise<void> };
  await withApply.__applyOptions(options);
  return instance;
}
