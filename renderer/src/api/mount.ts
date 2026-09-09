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
  fitObjectFit,
  frameStats,
  resetCoverAlign,
  resetFrameMeter,
  type Runtime,
} from "../shell";
import { mountWallpaper } from "../dispatch";
import { dropPkgCache } from "../scene-mount";
import type { WallpaperConfig } from "../types";
import { weShimCall } from "../web";
import { sniffMediaType } from "./source";
import { mediaColor } from "./media-source";
import type {
  AudioSource,
  Fit,
  MediaControl,
  MediaSource,
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

/**
 * 场景路径需要真 canvas；若调用方给了空容器则在其内自建一块。
 *
 * `reuse=false`（重挂场景）时**一定换新画布**：`clear()` 里的
 * `renderer.dispose()` 调 `WEBGL_lose_context.loseContext()`，丢失后同一
 * canvas 再 `getContext("webgl2")` 拿回的是同一个 lost 对象，只有新画布
 * 才能拿到可用上下文。
 *
 * 关键是**不能靠 `isContextLost()` 判断**：`loseContext()` 的生效是异步的
 * （浏览器在后续任务里才真正丢弃上下文），`clear()` 之后同步查仍返回 false，
 * 于是复用了一块马上就要死掉的画布 —— 实测症状是场景重挂报
 * `createShader` 返回 null 派生的 `shaderSource must be an instance of
 * WebGLShader`。所以只看「这块画布建过 GL 上下文吗」这个确定性事实：
 * 建过就必须换，不去猜它此刻死没死。
 *
 * 整页渲染器不踩这个坑：它 `clear()` 时 `rt.wrap.innerHTML = ""` 把画布删了，
 * 重挂自然新建。库形态没有 wrap，画布被留下复用 —— 于是「卸载后重挂」
 * （setRenderDpr / restore）必然拿到死上下文，且这两个方法都不 arm 首帧守卫，
 * 连报错都没有，宿主只看到一片黑。
 */
function ensureSceneCanvas(el: HTMLElement, reuse = true): HTMLCanvasElement {
  if (el instanceof HTMLCanvasElement) return el;
  const existing = el.querySelector(":scope > canvas[data-webwallgl]");
  if (existing instanceof HTMLCanvasElement) {
    // 没建过 GL 上下文的画布是干净的，任何时候都能复用（首次装配走这条）
    if (reuse || existing.getAttribute("data-webwallgl-gl") !== "1") return existing;
    // 建过上下文 + 正在重挂：无法复活，摘掉换新的（留着会挡住新画布）
    existing.remove();
  }
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
    let entryType: string | undefined;
    try {
      const entry = await o.source.mediaEntry?.();
      url = entry?.url;
      entryType = entry?.type;
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
    // mediaEntry 显式给的 type 可纠正 project.json（作者把 gif 标成 image 之类）
    const finalType = MEDIA_TYPES.has(String(entryType).toLowerCase())
      ? String(entryType).toLowerCase()
      : mediaType;
    // 视频走 DOM 直显：不建画布（白占一个 WebGL 上下文名额，且 instance.canvas
    // 会指向一块永远空白的画布，误导调用方）。canvas 字段保留调用方给的容器
    // 元素本身 —— mountVideoDom 要靠它定位挂载点。
    const canvas = finalType === "video" ? el : ensureSceneCanvas(el);
    return { ...base, type: finalType as WallpaperConfig["type"], src: url, canvas, source: o.source };
  }
  // [1.3.0] project.type 缺失或不认识时，按资源 URL 的扩展名嗅探。
  //
  // 两道闸门，缺一不可：
  //  · 只在 Source 提供了 mediaEntry 时才试——有 mediaEntry 就说明调用方本来
  //    就想放一段媒体；对普通 httpSource（壁纸包目录）不嗅探，免得把没有
  //    project.json 的场景壁纸误判成媒体。
  //  · **project.type 已经明确声明过就绝不覆盖**（哪怕它声明的是 scene）。
  //    作者说了算：某些场景壁纸的 project.file 确实指向 .mp4（那是场景里的
  //    视频纹理素材，不是"这张壁纸是个视频"），嗅探覆盖它会整张壁纸走错路径。
  const declaredType =
    typeof (project as { type?: unknown } | null)?.type === "string"
      ? String((project as { type: string }).type).trim()
      : "";
  if (!declaredType && typeof o.source.mediaEntry === "function") {
    let url: string | undefined;
    let entryType: string | undefined;
    try {
      const entry = await o.source.mediaEntry();
      url = entry?.url;
      entryType = entry?.type;
    } catch {
      url = undefined;
    }
    const sniffed =
      (MEDIA_TYPES.has(String(entryType).toLowerCase()) ? String(entryType).toLowerCase() : null) ??
      (url ? sniffMediaType(url) : null);
    if (url && sniffed) {
      // 同上：嗅探出视频时也不建画布，canvas 保留容器元素供 mountVideoDom 定位
      const canvas = sniffed === "video" ? el : ensureSceneCanvas(el);
      return { ...base, type: sniffed as WallpaperConfig["type"], src: url, canvas, source: o.source };
    }
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
    // 媒体源同理：只在选项里显式出现时才动 rt.mediaSource，否则 load() 换场景
    // 会把 setMedia() 装好的宿主源冲掉
    if ("media" in o) {
      rt.mediaSource = o.media ?? null;
      // 显式传 null = 禁用（不是"回落模拟源"）；见 Runtime.mediaDisabled
      rt.mediaDisabled = o.media === null;
    }
  };

  /**
   * 把公共 AudioSource 接到运行时的拉模式桥。
   * `null` 是**显式禁用**（频谱恒为 0），与"从没设置过"不同——后者才回落模拟源。
   */
  const applyAudio = (src: AudioSource | null) => {
    rt.audioDisabled = src === null;
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

  /**
   * 用当前配置原地重挂（setRenderDpr / restore 共用）。
   *
   * 必须换画布，不能沿用 `rt.cfg.canvas`：`clear()` 里 `renderer.dispose()` 调
   * `WEBGL_lose_context.loseContext()`，那块画布的 GL 上下文就废了 ——
   * 同一 canvas 再 `getContext("webgl2")` 拿回的还是那个 lost 对象。
   * 而 `loseContext()` 是**异步生效**的，`clear()` 之后同步查 `isContextLost()`
   * 仍是 false，所以只能按「建过上下文就换」这个确定性事实决策
   * （`ensureSceneCanvas(el, false)`），不去猜它此刻死没死。
   *
   * 先 clear 再换画布：clear 要读 `rt.canvas` 等旧引用做回收，换早了就漏。
   * 装配函数开头自己也会 clear 一次，幂等，多调只是空转。
   *
   * 只对**用 WebGL 的**路径需要。网页壁纸挂 iframe、视频壁纸挂 `<video>`
   * DOM 直显，两者都不碰 GL 上下文，重挂时不该动画布（对视频尤其重要：
   * 去换画布会把 `data-webwallgl-gl` 的干净画布白删一次，还可能把调用方
   * 传的 canvas 误判成"上下文已死"而直接报错）。
   * 调用方**直接传 canvas** 时换不掉（库不能替它换 DOM），如实报错。
   */
  const remountCurrent = () => {
    const usesGL = rt.cfg.type !== "web" && rt.cfg.type !== "video";
    if (usesGL) {
      clear(rt);
      if (el instanceof HTMLCanvasElement) {
        emitError(
          new Error(
            "重挂失败：调用方直接传入了 canvas，其 WebGL 上下文已在卸载时归还且" +
              "无法复活（loseContext 后同一 canvas 拿不回可用上下文），而库不能替" +
              "调用方替换 DOM。请改传一个空容器让库自建画布，或重新调用 mount()。",
          ),
        );
        return;
      }
      const fresh = ensureSceneCanvas(el, false);
      if (fresh !== rt.cfg.canvas) {
        rt.cfg = { ...rt.cfg, canvas: fresh };
        boundEl = fresh;
      }
    }
    mountWallpaper(rt, rt.cfg);
  };

  const instance: SceneInstance = {
    get canvas() {
      return boundEl as HTMLCanvasElement;
    },

    pause() {
      rt.paused = true;
      rt.sceneCtl?.pause();
      // 视频壁纸走 DOM 直显，没有 sceneCtl —— 不显式处理这四个方法对它就是空操作
      for (const p of rt.videoPairs ?? []) p.pause();
      if (!rt.videoPairs?.length) rt.video?.pause();
    },
    resume() {
      rt.paused = false;
      resetFrameMeter(rt);
      rt.sceneCtl?.resume();
      // pair.resume() 同时重启预热调度的 rAF：只 play() 主元素会让恢复后的
      // 第一圈退回原生 loop（循环卡顿重现）
      if (rt.videoPairs?.length) {
        for (const p of rt.videoPairs) p.resume();
      } else if (rt.video) {
        void rt.video.play().catch(() => {});
      }
    },
    get paused() {
      return !!rt.paused;
    },

    setFit(fit: Fit) {
      rt.cfg.fit = fit;
      resetCoverAlign(rt);
      // 网页壁纸的 fit 由 iframe 的视口尺寸/偏移表达，不是相机参数：
      // 只改 cfg 画面不会有任何变化，必须触发一次重排（整页渲染器一直是这么做的，
      // 库入口漏了这一步，症状是 wp.setFit("contain") 对网页壁纸完全无反应）。
      rt.webRelayout?.();
      // DOM 直显的视频壁纸同理：fit 表达在 object-fit 上，不改样式画面不动。
      // 双元素时两个都要改，否则交接后 fit 变回旧值。
      const f = fitObjectFit(fit);
      const applyFit = (el: HTMLElement) => {
        el.style.objectFit = f.objectFit;
        el.style.background = f.background;
        el.style.objectPosition = "50% 50%";
      };
      for (const p of rt.videoPairs ?? []) {
        for (const el of [p.active, p.standby]) if (el.isConnected) applyFit(el);
      }
      if (!rt.videoPairs?.length && rt.video?.isConnected) applyFit(rt.video);
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
      // 双元素循环对自己管音量与静音（备用侧恒静音防双声）
      if (rt.videoPairs?.length) {
        for (const p of rt.videoPairs) p.setVolume(v);
      } else if (rt.video) {
        rt.video.volume = v;
        rt.video.muted = v <= 0;
      }
    },
    setRenderDpr(dpr: number) {
      rt.cfg.renderDpr = dpr;
      remountCurrent();
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
      // 语义与 MountOptions.audio:null 不同：这里的 null 按文档是
      // 「回落内置模拟源」，不是静音（禁用只在挂载选项里表达）
      rt.audioDisabled = false;
    },

    // 系统媒体源。与 setAudio 同纪律：只存引用、换场景不清空，
    // scene 与 web 两条装配路径读同一个 rt.mediaSource。
    // 注意语义与 MountOptions.media:null 不同：这里的 null 按文档是
    // 「回落内置模拟源」，不是禁用（禁用只在挂载选项里表达）。
    setMedia(src: MediaSource | null) {
      currentOptions = { ...currentOptions, media: src };
      rt.mediaSource = src ?? null;
      rt.mediaDisabled = false;
    },

    // 媒体控制面。装配后由 mountScene 写入 rt.mediaCtl；未装配（或媒体/网页
    // 壁纸尚无控制面）时给一个惰性替身，读快照得空、控制方法静默无效 ——
    // 让调用方能无条件 `wp.media.playPause()` 而不必先判空。
    get media(): MediaControl {
      const ctl = rt.mediaCtl as unknown as MediaControl | undefined;
      if (ctl) return ctl;
      const empty = {
        hasMedia: false, state: 0, title: "", artist: "", album: "", albumArtist: "",
        position: 0, duration: 0, hasThumbnail: false,
        primaryColor: mediaColor(0, 0, 0), secondaryColor: mediaColor(0, 0, 0),
        tertiaryColor: mediaColor(0, 0, 0), textColor: mediaColor(1, 1, 1),
        highContrastColor: mediaColor(1, 1, 1),
        trackIndex: 0, lyrics: [] as Array<[number, string]>, lyricLine: "", lyricIndex: -1,
      } as MediaControl["snapshot"];
      const noop = () => empty;
      return {
        get snapshot() {
          return empty;
        },
        skipNext: noop, skipPrevious: noop, play: noop, pause: noop, playPause: noop,
      };
    },

    // 外部指针注入。pointerCtl 由 mountScene / mountWeb 各自装配时设置，
    // 媒体壁纸不设 —— 那时这里静默无效，与整页渲染器的 __wp.pushPointer 一致。
    pushPointer(u: number, v: number, buttons?: number, mods?: number) {
      rt.pointerCtl?.push({ u, v, buttons, mods });
    },
    pointerLeave() {
      rt.pointerCtl?.leave();
    },
    // 滚轮注入。wheel 是可选方法，只有 mountWeb 实现 —— 场景壁纸没有滚轮语义
    // （WE 沙箱无滚轮 API，194 张场景壁纸零消费），此处与媒体壁纸一样静默无效。
    pushWheel(dx: number, dy: number, mode?: number, mods?: number) {
      rt.pointerCtl?.wheel?.({ dx, dy, mode, mods });
    },

    async load(source: Source) {
      // 换源前释放旧源（mediaSource(File) 的 objectURL）。同一个源重复 load
      // 不释放：那会把还在用的 blob URL revoke 掉，视频立刻变黑。
      const prev = currentOptions.source;
      if (prev && prev !== source) {
        try {
          prev.dispose?.();
        } catch {
          /* 忽略 */
        }
      }
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
      remountCurrent();
    },
    /**
     * 销毁实例并释放全部运行时资源（GL 上下文/视频/音频/监听/来源 blob）。
     *
     * `releasePkgCache: true` 时连带淘汰本实例 source.key 的 scene.pkg 解析缓存。
     * 缓存默认跨实例保留（同壁纸重挂不重新下载），宿主切换壁纸后销毁旧实例时
     * 旧包还会压在缓存里（上限 2 份/512MB），桌面壁纸宿主逐张换、不存在"回头
     * 再挂旧壁纸"的模式，销毁即放弃才有可预期的内存曲线。
     * 多实例共享同一 key 时，另一实例只是下次重挂多一次下载，不影响正确性。
     */
    destroy(opts?: { releasePkgCache?: boolean }) {
      destroyRuntime(rt);
      if (opts?.releasePkgCache) {
        dropPkgCache(rt.cfg.source?.key ?? currentOptions.source?.key);
      }
      // 释放来源占用的资源：mediaSource(File) 的 objectURL 不 revoke
      // 就是每换一次壁纸泄漏一个几十 MB 的 blob
      try {
        currentOptions.source?.dispose?.();
      } catch {
        /* 释放失败不阻断销毁 */
      }
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
    // autoplay:false 不能在装配前就置 paused —— scene/media 的 kickLoop 会直接
    // 掉头返回，渲染循环一帧都不跑，唯一触发 onFirstFrame 的地方永远到不了，
    // 于是 mount() 的 Promise 既不 resolve 也不 reject，**永久挂起**
    // （web 路径不受影响：它在 iframe load 时无条件触发首帧）。
    // 正解是照常装配、出完首帧再暂停：调用方拿到的是"已就绪但静止在第一帧"，
    // 这也正是 autoplay:false 的语义。
    rt.paused = false;
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
    if (o.autoplay === false) instance.pause();
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
