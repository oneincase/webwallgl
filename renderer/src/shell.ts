// 页面外壳与共享运行时（库化改造：docs/LIBRARY-PLAN.md 第 2 步）
//
// 曾经的模块级单例 `state` 已改为 **Runtime 实例**：createRuntime() 每调用一次
// 产出一个独立运行时（cfg/画布/渲染器/帧率计/cover 对齐……互不可见），
// 这是「一页多实例」的硬前提。跨模块函数一律以 rt 为首参。
// 壁纸页（main.ts）创建全屏运行时；公共 API（api/mount.ts）每个实例创建自己的。
//
// 依赖方向：shell ← web / media / scene-mount / dispatch / api / main（单向，无环）。
import type { WallpaperConfig, WallpaperFit } from "./types";
import type { VideoLoopPair } from "./video-loop";

// 有效渲染 DPR = min(设备 DPR, renderDpr 上限)，用于压缩画布/纹理内存（Retina 上默认降到 1/4）。
export function effectiveDpr(rt: Runtime, cfg?: WallpaperConfig): number {
  const cap = cfg?.renderDpr ?? rt.cfg?.renderDpr ?? 1;
  return Math.min(window.devicePixelRatio || 1, cap);
}

// 规范化显示模式：兼容旧会话里的 fill（=拉伸）与 fit（=适应）。
// 旧 fill 是"忽略宽高比铺满"（会被拉伸变形），默认迁移到 cover 修复，不再默认拉伸。
export function normalizeFit(fit?: WallpaperFit): "cover" | "contain" | "stretch" {
  if (fit === "fit") return "contain"; // 旧"适应"
  if (fit === "fill") return "cover"; // 旧默认"填充"曾是拉伸 → 修复为等比裁切
  return fit === "contain" || fit === "stretch" ? fit : "cover";
}

// 视频/GIF/图片的 object-fit 映射：cover 等比铺满裁切、contain 等比留边、stretch 拉伸。
export function fitObjectFit(fit?: WallpaperFit): { objectFit: string; background: string } {
  const f = normalizeFit(fit);
  if (f === "contain") return { objectFit: "contain", background: "rgba(10,12,16,0.85)" };
  if (f === "stretch") return { objectFit: "fill", background: "transparent" };
  return { objectFit: "cover", background: "transparent" };
}

export type Runtime = {
  cfg: WallpaperConfig;
  video?: HTMLVideoElement;
  /** 场景内视频纹理循环对（每纹理一个） */
  videoPairs?: VideoLoopPair[];
  img?: HTMLImageElement;
  iframe?: HTMLIFrameElement;
  /**
   * 网页壁纸的「露底自适配」复算钩子（web.ts 安装）。
   * setFit 切换时要调它：cover 才换覆盖式视口，contain/stretch 回满视口。
   */
  webRelayout?: () => void;
  canvas?: HTMLCanvasElement;
  ctx?: CanvasRenderingContext2D;
  raf?: number;
  sceneCleanup?: () => void;
  sceneAudio?: { setVolume: (vol: number) => void; audios: HTMLAudioElement[] };
  /** 当前场景渲染器（含 dispose 释放 WebGL 上下文） */
  renderer?: { dispose?: () => void };
  /** 待 revoke 的 blob URL（场景视频纹理 + 音效） */
  objectUrls?: string[];
  /** 场景内视频纹理元素（暂停并移除） */
  videoTextures?: HTMLVideoElement[];
  /** 文字挂件逐帧求值回调（渲染循环内调用；无文字对象时为空） */
  sceneTextUpdate?: (t: number) => void;
  /** 场景/媒体壁纸的暂停·恢复·属性热更句柄（闭包内 rAF，不能从外部直接重启） */
  sceneCtl?: {
    pause(): void;
    resume(): void;
    applyUserProperties(props: Record<string, { value: unknown }>): void;
  };
  /**
   * 外部指针注入句柄（桌面壁纸窗口在桌面 underlay 层收不到鼠标事件，由宿主
   * 轮询系统鼠标推入）。只有场景壁纸装配时设置；__wp.pushPointer 经它写入。
   * 协议与宿主实现指南见 docs/INTEGRATION.md。
   */
  pointerCtl?: {
    push(p: { u: number; v: number; buttons?: number }): void;
    leave(): void;
  };
  /** 当前场景的扁平化用户属性值表（mountScene 装配后写入；getProperties 用） */
  liveUserProps?: Record<string, unknown>;
  /**
   * 宿主注入的音频频谱源（`__wp.setAudioBridge` 设置）。
   *
   * 拉模式而非推模式：渲染循环每帧调一次，取当前 64 段左右声道频谱（值域 0..1）。
   * 宿主每帧推 128 个浮点要走字符串拼接与 JS 解析，安卓 WebView 上 60fps 下开销
   * 可观；让渲染器主动拉，宿主就能用同步原生桥直接返回。
   *
   * 返回 null 表示暂时无数据，此时回落到内置模拟源。
   */
  audioBridge?: (() => { left: ArrayLike<number>; right: ArrayLike<number> } | null) | null;
  /** 场景基本信息（onSceneInfo 触发时写入；具体结构见 api/types.ts 的 SceneInfo） */
  info?: unknown;

  // ---- 库化桥接钩子：公共 API 在触发装配前设置；装配层只管调用 ----
  /** 诊断回调（reportDiag 先走这里，再走旧的 /diag img 上报） */
  onDiagnostic?: (msg: string, level: "info" | "warn" | "error") => void;
  /** 装配失败回调。设了它，mountScene 的 catch 不再自动挂降级页（交回调用方兜） */
  onError?: (err: Error) => void;
  /** 首帧真正提交渲染后触发一次（mount() 的 Promise 靠它 resolve） */
  onFirstFrame?: () => void;
  /** 场景装配完成（首帧前）触发一次，带场景基本信息 */
  onSceneInfo?: (info: unknown) => void;
  /** pause() 置位；渲染循环 then 里看到它就不再排下一帧 */
  paused?: boolean;

  // ---- 实例私有运行时 ----
  /** 全屏运行时的画布容器（公共 API 实例画在调用方 canvas 上，不用它） */
  wrap?: HTMLDivElement;
  /** cover 裁切预览的对齐状态（竖屏顶/底热区滑动） */
  coverAlign: { x: number; y: number; tx: number; ty: number };
  /** 实例级帧率计（见 frameStats） */
  frameMeter: { stamps: number[]; last: number; fps: number };
  /** 实例注册的 window/document 级监听，destroy 时成对摘除 */
  disposers: Array<() => void>;
  /** cover 窥视的对齐动画 rAF 句柄 */
  peekRaf?: number;
  // ---- 非核心类型的能力钩子（库化第 5 步）----
  // scene/video/gif/image/web 是核心能力；canvas 演示动画、降级页是壁纸页
  // （适配层）的职责，经这两个钩子注入。库实例不设置：未知类型安全地不渲染。
  /** dispatch 遇到非核心类型（canvas/未知）时调用（仅壁纸页设置） */
  onUnhandledType?: (cfg: WallpaperConfig) => void;
  /** 场景装配失败且调用方没给 onError 时的兜底（壁纸页挂降级页；库实例不需要） */
  fallbackPage?: () => void;
};

/**
 * 创建一个独立渲染运行时。
 *
 * `fullscreen: true` 是壁纸页形态：接管 document/body 样式、自建全屏 wrap 容器、
 * 注册 cover 窥视的 window 级指针监听。公共库实例不传——它们画在调用方的
 * canvas 上，不碰 document，也不监听 window（第 3 步把指针源改为 canvas 级）。
 */
export function createRuntime(opts?: { fullscreen?: boolean }): Runtime {
  const rt: Runtime = {
    cfg: { type: "canvas" },
    coverAlign: { x: 0.5, y: 0.5, tx: 0.5, ty: 0.5 },
    frameMeter: { stamps: [], last: 0, fps: 0 },
    disposers: [],
  };
  if (opts?.fullscreen) setupFullscreen(rt);
  return rt;
}

/** 壁纸页的一次性页面级设置（样式接管只做一次；wrap 与指针监听归实例） */
let fullscreenStylesApplied = false;

function setupFullscreen(rt: Runtime) {
  if (!fullscreenStylesApplied) {
    fullscreenStylesApplied = true;
    // 页面底色：桌面宿主要透明（壁纸窗口叠在桌面 underlay 层，透出下面的内容），
    // 但嵌入式宿主（安卓 WebView）透明会露出 WebView 自己的浅色默认底 —— contain
    // 留白处就成了刺眼的浅灰边。宿主用 ?opaque=1 声明"我要不透明背景"。
    const bg = rt.cfg?.opaque ? "#000" : "transparent";
    document.documentElement.style.cssText = `margin:0;height:100%;background:${bg};`;
    const root = document.body;
    root.style.cssText =
      `margin:0;width:100vw;height:100vh;overflow:hidden;background:${bg};position:relative;`;
  }
  const wrap = document.createElement("div");
  wrap.style.cssText = "position:fixed;inset:0;overflow:hidden;";
  document.body.appendChild(wrap);
  rt.wrap = wrap;
  registerCoverPeek(rt);
}

// 屏蔽默认 Tauri/WebKit 右键菜单（壁纸窗口应只响应用户自定义交互，不弹浏览器/调试菜单）
(() => {
  const block = (e: Event) => e.preventDefault();
  // 顶层文档：捕获+冒泡都拦，确保整页右键不弹菜单
  window.addEventListener("contextmenu", block, true);
  document.addEventListener("contextmenu", block, true);
  // 供 iframe（同源网页壁纸）加载后注入
  (window as unknown as Record<string, unknown>).__blockContextMenu = (doc: Document) =>
    doc.addEventListener("contextmenu", block, true);
})();

export function clear(rt: Runtime) {
  // iframe 先导航走再移除：WKWebView 对带活动文档的 iframe 回收迟缓，
  // 置空 src 促发文档立即拆毁（网页壁纸大堆内存随文档释放）
  if (rt.iframe) {
    try {
      rt.iframe.contentWindow?.location.replace("about:blank");
    } catch {
      /* 跨源/已 detach 忽略 */
    }
  }
  // 全屏 wrap：一把清空。库形态无 wrap：只摘自己挂的 iframe，不碰调用方容器其它子节点。
  if (rt.wrap) {
    rt.wrap.innerHTML = "";
  } else if (rt.iframe?.isConnected) {
    try {
      rt.iframe.remove();
    } catch {
      /* 忽略 */
    }
  }
  if (rt.raf !== undefined) cancelAnimationFrame(rt.raf);
  rt.raf = undefined;
  // 停掉场景视频纹理循环对（取消 rAF 交换驱动 + 暂停解码）
  // （视频壁纸本身已是单 video + 原生 loop，无需在此处理）
  for (const p of rt.videoPairs ?? []) p.destroy();
  rt.videoPairs = undefined;
  if (rt.sceneCleanup) rt.sceneCleanup();
  rt.sceneCleanup = undefined;
  rt.sceneCtl = undefined;
  rt.pointerCtl = undefined;
  // 释放旧场景渲染器（loseContext → 归还 WebGL 上下文与全部纹理/FBO/program/buffer）
  if (rt.renderer) {
    rt.renderer.dispose?.();
    rt.renderer = undefined;
  }
  // 暂停并移除场景内视频纹理元素（避免后台继续解码占用内存）
  for (const v of rt.videoTextures ?? []) {
    v.pause();
    v.removeAttribute("src");
    v.load();
    v.remove();
  }
  rt.videoTextures = undefined;
  // revoke 所有 blob URL（场景视频纹理 + 音效）
  for (const u of rt.objectUrls ?? []) {
    try {
      URL.revokeObjectURL(u);
    } catch {
      /* 忽略 */
    }
  }
  rt.objectUrls = undefined;
  if (rt.sceneAudio) {
    for (const au of rt.sceneAudio.audios) {
      au.pause();
      au.removeAttribute("src");
      au.load();
    }
    rt.sceneAudio = undefined;
  }
  if (rt.video) {
    // 非循环视频：同样清 src + load() 释放解码器（仅 remove 节点/pause 不足）
    rt.video.pause();
    rt.video.removeAttribute("src");
    try {
      rt.video.load();
    } catch {
      /* 忽略 */
    }
    rt.video.remove();
  }
  rt.video = undefined;
  rt.img = undefined;
  rt.iframe = undefined;
  rt.canvas = undefined;
  rt.ctx = undefined;
  rt.info = undefined;
  resetFrameMeter(rt);
}

/**
 * 彻底销毁运行时：clear 之外再摘掉 window/document 级监听、移除 wrap 容器。
 * 之后该 Runtime 不可再用。
 */
export function destroyRuntime(rt: Runtime) {
  clear(rt);
  for (const off of rt.disposers.splice(0)) {
    try {
      off();
    } catch {
      /* 忽略 */
    }
  }
  rt.wrap?.remove();
  rt.wrap = undefined;
}

const utf8 = new TextDecoder();
export const readText = (bytes: Uint8Array) => utf8.decode(bytes).replace(/^\uFEFF/, "");

// ---------- 实时帧率计 ----------
//
// 测试台状态栏 / 公共 API stats 要显示「壁纸真实在跑多少帧」。这个数不能由
// sceneFps 推算：它是上限，重场景（大量粒子/后期链）实际会掉到上限以下，
// 掉帧恰恰是要看的。所以由渲染循环每画完一帧打点，按滑动窗口算。
//
// 只统计**真正提交渲染**的帧：被帧率上限跳过的 rAF 不打点，否则读数永远是
// 显示器刷新率。窗口取 500ms，够稳又能在掉帧时及时反映。

const FPS_WINDOW_MS = 500;

/** 渲染循环每提交一帧调用一次（传入该帧的 rAF 时间戳） */
export function markFrame(rt: Runtime, now: number) {
  const s = rt.frameMeter.stamps;
  s.push(now);
  rt.frameMeter.last = now;
  const cut = now - FPS_WINDOW_MS;
  while (s.length && s[0] < cut) s.shift();
  // 窗口内 n 帧只跨 n-1 个间隔，用首末时间差算才不会系统性偏高
  const span = s.length >= 2 ? s[s.length - 1] - s[0] : 0;
  rt.frameMeter.fps = span > 0 ? ((s.length - 1) * 1000) / span : 0;
}

export function resetFrameMeter(rt: Runtime) {
  rt.frameMeter.stamps.length = 0;
  rt.frameMeter.last = 0;
  rt.frameMeter.fps = 0;
}

/**
 * 当前帧率快照。停下来（暂停 / 释放 / 循环出错熔断）时读数要归零而不是
 * 冻在最后一个值上 —— 一个不再更新的 60 会让人以为壁纸还在跑。
 */
export function frameStats(rt: Runtime): { fps: number; running: boolean } {
  if (!rt.frameMeter.last || rt.paused) return { fps: 0, running: false };
  const idle = performance.now() - rt.frameMeter.last;
  if (idle > Math.max(FPS_WINDOW_MS, 400)) return { fps: 0, running: false };
  return { fps: rt.frameMeter.fps, running: true };
}

// ---------- Scene（we-scene WebGL） ----------

/** 渲染器诊断上报。先交给库化桥接的 onDiagnostic（公共 API 的回调面），
 *  再走旧的 /diag img 通道（宿主日志；经内容服务器，用 <img> 免 CORS） */
export function reportDiag(rt: Runtime, cfg: WallpaperConfig, msg: string) {
  try {
    rt.onDiagnostic?.(msg, /fail|error|失败|ERROR/.test(msg) ? "error" : "info");
  } catch {
    /* 回调抛错不打断渲染 */
  }
  try {
    // mediaBase 常是相对路径（/media/dev）——new URL 相对串无 base 会抛，诊断通道
    // 从此静默断线（渲染端告警全部丢失）。必须挂 location.href 作 base。
    const origin = cfg.mediaBase ? new URL(cfg.mediaBase, window.location.href).origin : "";
    if (origin) {
      const img = new Image();
      img.src = `${origin}/diag?msg=${encodeURIComponent(`scene ${cfg.src ?? "?"}: ${msg.slice(0, 500)}`)}`;
    }
  } catch {
    /* 忽略 */
  }
}

// ---------- cover 裁切预览（竖屏顶/底热区）----------
//
// cover 居中裁切：竖屏壁纸在 16:9 窗口上上下被切掉。鼠标靠近屏幕顶/底时把
// 可见窗口滑向对应端（align 0=顶/左，1=底/右），裁切模式下也能扫完整张图。
// 横屏壁纸在瘦窗口上同理走左右。离开热区或离开窗口回到居中。
// 不拦截点击，不影响壁纸脚本指针。无溢出时 (proj-view)*align=0，平移是空操作。
//
// 库化改造：监听与状态归实例（rt.coverAlign / rt.disposers）。只有全屏运行时
// 注册 window 级监听 —— 公共 API 实例画在页面局部，不该截获整页指针。
// 第 3 步会给公共实例接 canvas 级指针源。

const COVER_EDGE_PX = 96;
const COVER_LERP = 0.14;

export function resetCoverAlign(rt: Runtime) {
  rt.coverAlign.x = rt.coverAlign.y = rt.coverAlign.tx = rt.coverAlign.ty = 0.5;
  applyCoverAlignToDom(rt);
}

function axisTarget(t: number, edge: number): number {
  if (t <= edge) return (0.5 * t) / edge;
  if (t >= 1 - edge) return 0.5 + (0.5 * (t - (1 - edge))) / edge;
  return 0.5;
}

function applyCoverAlignToDom(rt: Runtime) {
  const pos = `${(rt.coverAlign.x * 100).toFixed(2)}% ${(rt.coverAlign.y * 100).toFixed(2)}%`;
  const obj = rt.video ?? rt.img;
  if (obj && obj.isConnected) obj.style.objectPosition = pos;
}

export function advanceCoverAlign(rt: Runtime): { x: number; y: number } {
  if (normalizeFit(rt.cfg.fit) !== "cover") {
    rt.coverAlign.x = rt.coverAlign.y = rt.coverAlign.tx = rt.coverAlign.ty = 0.5;
    applyCoverAlignToDom(rt);
    return rt.coverAlign;
  }
  rt.coverAlign.x += (rt.coverAlign.tx - rt.coverAlign.x) * COVER_LERP;
  rt.coverAlign.y += (rt.coverAlign.ty - rt.coverAlign.y) * COVER_LERP;
  if (Math.abs(rt.coverAlign.x - rt.coverAlign.tx) < 0.001) rt.coverAlign.x = rt.coverAlign.tx;
  if (Math.abs(rt.coverAlign.y - rt.coverAlign.ty) < 0.001) rt.coverAlign.y = rt.coverAlign.ty;
  applyCoverAlignToDom(rt);
  return rt.coverAlign;
}

function ensurePeekTick(rt: Runtime) {
  if (rt.peekRaf !== undefined) return;
  rt.peekRaf = requestAnimationFrame(() => {
    rt.peekRaf = undefined;
    advanceCoverAlign(rt);
    if (Math.abs(rt.coverAlign.x - rt.coverAlign.tx) > 0.001 || Math.abs(rt.coverAlign.y - rt.coverAlign.ty) > 0.001) {
      ensurePeekTick(rt);
    }
  });
}

function onCoverPointer(rt: Runtime, clientX: number, clientY: number, inside: boolean) {
  if (!inside || normalizeFit(rt.cfg.fit) !== "cover") {
    rt.coverAlign.tx = 0.5;
    rt.coverAlign.ty = 0.5;
    ensurePeekTick(rt);
    return;
  }
  const w = Math.max(1, window.innerWidth);
  const h = Math.max(1, window.innerHeight);
  const edgeX = Math.min(0.22, Math.max(0.1, COVER_EDGE_PX / w));
  const edgeY = Math.min(0.22, Math.max(0.1, COVER_EDGE_PX / h));
  rt.coverAlign.tx = axisTarget(clientX / w, edgeX);
  rt.coverAlign.ty = axisTarget(clientY / h, edgeY);
  ensurePeekTick(rt);
}

function registerCoverPeek(rt: Runtime) {
  const move = (e: PointerEvent) => onCoverPointer(rt, e.clientX, e.clientY, true);
  const leave = () => onCoverPointer(rt, 0, 0, false);
  window.addEventListener("pointermove", move, { passive: true });
  window.addEventListener("pointerleave", leave, { passive: true });
  document.addEventListener("pointerleave", leave, { passive: true });
  rt.disposers.push(() => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerleave", leave);
    document.removeEventListener("pointerleave", leave);
  });
}

/**
 * 把画布 backing store 对齐当前**显示尺寸**（canvas 的 CSS 尺寸；全屏 canvas
 * 即窗口尺寸）。尺寸变了返回 true。cover/contain 的可见窗口按 backing store 算，
 * 挂载后窗口一变（测试台切 16:9/21:9/32:9、显示器休眠唤醒）或嵌入页面后
 * 容器改尺寸，若不改这里，相机仍按旧宽高比裁切，再被 CSS 拉伸 —— 画面变形。
 */
export function syncCanvasSize(rt: Runtime, canvas: HTMLCanvasElement, cfg?: WallpaperConfig): boolean {
  const dpr = effectiveDpr(rt, cfg);
  const w = Math.max(1, Math.round((canvas.clientWidth || window.innerWidth || 1) * dpr));
  const h = Math.max(1, Math.round((canvas.clientHeight || window.innerHeight || 1) * dpr));
  if (canvas.width === w && canvas.height === h) return false;
  canvas.width = w;
  canvas.height = h;
  return true;
}
