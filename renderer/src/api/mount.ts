// 公共 API 入口：mount() / createScene()（docs/LIBRARY-PLAN.md §3）
//
// 每个 SceneInstance 持有独立的 Runtime（shell.createRuntime）：cfg、帧率计、
// 渲染器、属性表互不可见 —— 一页多实例成立。装配经 dispatch.mountWallpaper，
// 与壁纸页 window.__wp 走同一条路。

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
import type {
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

/** 归一化挂载选项为渲染器内部配置（两条入口共用，保证行为一致） */
function toConfig(canvas: HTMLCanvasElement, o: MountOptions): WallpaperConfig {
  return {
    type: "scene",
    canvas,
    source: o.source,
    fit: normalizeFitOption(o.fit),
    renderDpr: o.renderDpr ?? 1,
    sceneFps: o.fps ?? 60,
    muted: (o.volume ?? 0) <= 0,
    loop: true,
  };
}

/**
 * 同步创建场景实例。加载由后续 load() 或内部 applyOptions 驱动；
 * 一般使用者请用 mount()。
 */
export function createScene(
  canvas: HTMLCanvasElement,
  options?: Partial<Omit<MountOptions, "source">>,
): SceneInstance {
  const rt: Runtime = createRuntime();
  const events: {
    ready: Array<SceneEvents["ready"]>;
    error: Array<SceneEvents["error"]>;
    diagnostic: Array<SceneEvents["diagnostic"]>;
  } = { ready: [], error: [], diagnostic: [] };

  // 当前生效的挂载选项（load() 换场景时重设钩子要用）
  let currentOptions: MountOptions = { ...(options ?? {}), source: null as unknown as Source };

  const emitError = (err: Error) => {
    for (const fn of events.error) {
      try {
        fn(err);
      } catch {
        /* 订阅者抛错不打断渲染 */
      }
    }
  };

  // 把 options 的回调面接到 Runtime 的桥接钩子上（装配层只认钩子）
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
  };

  // 在**触发装配前**布防首帧一次性钩子；返回的 Promise 在首帧提交时 resolve。
  // 必须先布防再 mountWallpaper：装配是同步启动的，事后补挂会错过首帧。
  const armFirstFrame = (): Promise<void> => {
    return new Promise<void>((resolve) => {
      const prev = rt.onFirstFrame;
      rt.onFirstFrame = () => {
        rt.onFirstFrame = undefined;
        prev?.();
        resolve();
      };
    });
  };

  // 场景在首帧前失败时 mount()/load() 不能永久悬挂 —— 与 error 竞争。
  // 不包一层 rt.onError：wireOptions 已把 emitError 接进 onError 链，
  // 这里的订阅者直接被触发。
  const armFailure = (): { promise: Promise<never>; off: () => void } => {
    let off: () => void = () => {};
    const promise = new Promise<never>((_, reject) => {
      off = instance.on("error", (e) => reject(e));
    });
    return { promise, off };
  };

  const instance: SceneInstance = {
    canvas,

    pause() {
      rt.paused = true;
      rt.sceneCtl?.pause();
    },
    resume() {
      rt.paused = false;
      // 丢掉暂停前的打点：短暂停（<窗口长度）残留的旧时间戳会把
      // 恢复后的首个读数算得偏低，看起来像刚恢复就掉帧
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
    },
    setVolume(volume: number) {
      const v = Math.max(0, Math.min(1, volume));
      rt.cfg.muted = v <= 0;
      rt.sceneAudio?.setVolume(v);
    },
    setRenderDpr(dpr: number) {
      rt.cfg.renderDpr = dpr;
      mountWallpaper(rt, rt.cfg); // 重建画布需重挂；pkg 缓存命中，不重新下载
    },

    setProperties(props: Record<string, PropertyValue>) {
      const wire: Record<string, { value: unknown }> = {};
      for (const [k, v] of Object.entries(props)) wire[k] = { value: v };
      // 装配未完成时 sceneCtl 已就位（mountScene 同步创建），改动进 pendingWire，
      // 就绪后生效 —— 与壁纸页 updateWebProps 同一条路
      rt.sceneCtl?.applyUserProperties(wire);
    },
    getProperties() {
      return { ...(rt.liveUserProps ?? {}) } as Record<string, PropertyValue>;
    },

    async load(source: Source) {
      currentOptions = { ...currentOptions, source };
      wireOptions(currentOptions);
      // 换 Source 后旧的 HTTP 约定必须失效，防止半新半旧
      const cfg: WallpaperConfig = {
        ...rt.cfg,
        type: "scene",
        source,
        src: undefined,
        mediaBase: undefined,
      };
      rt.cfg = cfg;
      rt.paused = false;
      rt.info = undefined;
      resetCoverAlign(rt);
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

  // 内部装配通道：mount() 用；不进公共类型
  const applyOptions = async (o: MountOptions) => {
    currentOptions = o;
    wireOptions(o);
    rt.cfg = toConfig(canvas, o);
    rt.paused = o.autoplay === false;
    rt.info = undefined;
    resetCoverAlign(rt);
    const firstFrame = armFirstFrame();
    const failure = armFailure();
    mountWallpaper(rt, rt.cfg);
    try {
      await Promise.race([firstFrame, failure.promise]);
    } finally {
      failure.off();
    }
    // 音量在音频节点装配完成后再应用：自动播放策略下非静音起步会被浏览器
    // 挂起，所以挂载期只置 muted 标志，就绪后才给真实音量
    if ((o.volume ?? 0) > 0) instance.setVolume(o.volume as number);
    // 初始属性覆盖：装配中提交走 pendingWire，就绪后生效
    if (o.properties && Object.keys(o.properties).length) instance.setProperties(o.properties);
  };

  (instance as unknown as { __applyOptions?: (o: MountOptions) => Promise<void> }).__applyOptions =
    applyOptions;

  return instance;
}

/**
 * 把一个 WE 场景挂到 canvas 上。Promise 在首帧渲染完成后 resolve
 * （场景在首帧前失败则 reject）。这是 95% 使用者的入口。
 */
export async function mount(
  canvas: HTMLCanvasElement,
  options: MountOptions,
): Promise<SceneInstance> {
  const instance = createScene(canvas, options);
  const withApply = instance as unknown as { __applyOptions: (o: MountOptions) => Promise<void> };
  await withApply.__applyOptions(options);
  return instance;
}
