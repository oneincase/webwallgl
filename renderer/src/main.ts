// 壁纸渲染器页（T0.5–T3）
// 由壁纸引擎窗口加载；原生侧通过 window.__wp 控制。
// 类型：canvas（默认演示动画）/ video / gif / web / scene / image
// scene 经 we-scene（MIT vendored）在浏览器 WebGL 实时渲染（2D；3D/粒子等降级）

// [we-scene patch] 模块结构（本仓库拆分，见 docs/ARCHITECTURE.md）：
//   types.ts        类型 + URL 协议字段 + 测试开关
//   vendor.ts       we-scene 引擎 import 与 asAny 转型统一出口
//   shell.ts        Runtime 工厂 / clear / 诊断上报 / 帧率计
//   dispatch.ts     mount() 分发（壁纸页/公共库两条入口共用）
//   video-loop.ts   A/B 无缝循环视频
//   web.ts          网页壁纸 sandbox iframe
//   media.ts        视频/图片/GIF → 单图层场景
//   scene-mount.ts  场景装配全链路（mountScene）
//   api/            公共库接口（mount/createScene/Source，见 docs/LIBRARY-PLAN.md）
//   main.ts         本文件：壁纸页入口 —— 创建全屏 Runtime、query 解析、window.__wp
import {
  markFrame,
  clear,
  fitObjectFit,
  frameStats,
  reportDiag,
  resetCoverAlign,
  resetFrameMeter,
  createRuntime,
  type Runtime,
} from "./shell";
import { mountWallpaper } from "./dispatch";
import { fileSource } from "./api/source";
import { weShimCall } from "./web";
import type { WallpaperConfig, WallpaperFit } from "./types";

// ---- 滤镜（beta）----
// 白名单 id → CSS filter。宿主/测试台只传 id 不传表达式：既避免把任意字符串塞进
// style.filter（url() 可外链资源），也让 query 参数与 __wp.setFilter 共用一套契约。
// 应用在 wrap 容器上，scene/video/image/web 各类型统一生效且换壁纸不清除。
export const WALLPAPER_FILTERS: Record<string, string> = {
  none: "",
  blur: "blur(14px)",
  grayscale: "grayscale(1)",
  sepia: "sepia(0.75)",
  vivid: "saturate(1.6)",
  warm: "sepia(0.35) saturate(1.35) brightness(1.05)",
  cool: "sepia(0.25) hue-rotate(175deg) saturate(1.3) brightness(1.03)",
  invert: "invert(1)",
  brighten: "brightness(1.3)",
  darken: "brightness(0.72)",
  contrast: "contrast(1.35)",
};

function applyWallpaperFilter(rt: Runtime) {
  const css = WALLPAPER_FILTERS[rt.cfg.filter ?? "none"] ?? "";
  if (rt.wrap) rt.wrap.style.filter = css;
}


// ---- 壁纸页适配层职责（库化第 5 步：非核心能力移出核心装配）----
// 以下二者不是「WE 场景/网页渲染」能力，只属于这个全屏壁纸页：
//   1. canvas 演示动画（渐变球 + 时钟）：无 query 时的占位壁纸；
//   2. /default-wallpaper 降级页：场景装配失败且调用方没给 onError 时兜底。
// web 网页壁纸已升为一等能力（dispatch → mountWeb）。
// 经 rt.onUnhandledType / rt.fallbackPage 两个钩子挂回装配层（dispatch）。

/** 1. canvas 演示动画 */
function mountCanvasDemo(rt: Runtime) {
  clear(rt);
  const c = document.createElement("canvas");
  const dpr = Math.min(window.devicePixelRatio || 1, rt.cfg.renderDpr ?? 1);
  c.width = Math.max(1, Math.round(innerWidth * dpr));
  c.height = Math.max(1, Math.round(innerHeight * dpr));
  c.style.cssText = "position:absolute;inset:0;width:100%;height:100%;";
  rt.wrap?.appendChild(c);
  const ctx = c.getContext("2d");
  if (!ctx) return;
  rt.canvas = c;
  rt.ctx = ctx;
  startCanvasDemoLoop(rt);
}

function startCanvasDemoLoop(rt: Runtime) {
  if (rt.raf !== undefined) return;
  const c = rt.canvas;
  const ctx = rt.ctx;
  if (!c || !ctx) return;
  const t0 = performance.now();
  const draw = (t: number) => {
    markFrame(rt, t);
    const s = (t - t0) / 1000;
    const w = c.width;
    const h = c.height;
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, `hsl(${(s * 40) % 360}, 78%, 56%)`);
    g.addColorStop(1, `hsl(${(s * 40 + 120) % 360}, 78%, 44%)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    const cx = w * (0.5 + 0.34 * Math.sin(s * 0.8));
    const cy = h * (0.5 + 0.28 * Math.cos(s * 0.6));
    const r = Math.min(w, h) * 0.16;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.fill();
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.font = `bold ${Math.round(h * 0.035)}px -apple-system, sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText("WE WALLPAPER · DESKTOP TEST", w / 2, h * 0.1);
    ctx.fillText(new Date().toLocaleTimeString(), w / 2, h * 0.1 + Math.round(h * 0.045));
    rt.raf = requestAnimationFrame(draw);
  };
  rt.raf = requestAnimationFrame(draw);
}

/** 3. 降级页（场景装配失败且无 onError 时的兜底） */
function mountDefaultWallpaper(rt: Runtime) {
  clear(rt);
  const f = document.createElement("iframe");
  f.setAttribute("sandbox", "allow-scripts");
  f.style.cssText =
    "position:absolute;inset:0;width:100%;height:100%;border:none;background:transparent;";
  // BASE_URL 前缀兼容子路径部署（如 GitHub Pages 的 /webwallgl/）
  f.src = `${import.meta.env.BASE_URL}default-wallpaper/index.html`;
  rt.wrap?.appendChild(f);
  const blockIframe = () => {
    try {
      const doc = f.contentDocument;
      if (doc) (window as any).__blockContextMenu?.(doc);
    } catch {
      /* 忽略 */
    }
  };
  f.addEventListener("load", blockIframe);
  rt.iframe = f;
}

// 壁纸页 = 全屏运行时：接管 body 样式、自建 wrap、注册 cover 窥视指针监听。
// 公共 API 的实例各自持有 Runtime，与本实例互不可见。
const rt: Runtime = createRuntime({ fullscreen: true });

// 把适配层职责挂回装配层：非核心类型分发 + 失败兜底
rt.onUnhandledType = (cfg) => {
  if (cfg.type === "canvas") {
    mountCanvasDemo(rt);
  } else {
    mountDefaultWallpaper(rt); // 无壁纸/未知配置 → 降级页（web 已由 dispatch 一等处理）
  }
};
rt.fallbackPage = () => mountDefaultWallpaper(rt);

// 原生控制接口
declare global {
  interface Window {
    __wp?: {
      setWallpaper(cfg: WallpaperConfig): void;
      pause(): void;
      resume(): void;
      setFit(fit: string): void;
      setVolume(volume: number): void;
      release(): void;
      restore(): void;
      setRenderDpr(dpr: number): void;
      setSceneFps(fps: number): void;
      /** 切换滤镜（beta）：传白名单 id（WALLPAPER_FILTERS），未知 id 按无滤镜处理 */
      setFilter(filter: string): void;
      /** 热更新 WE 网页壁纸用户属性（wire 格式：{name: {value: ...}}） */
      updateWebProps(props: Record<string, { value: unknown }>): void;
      /**
       * 外部指针注入（宿主轮询系统鼠标后推入）。桌面壁纸窗口位于「桌面 underlay」
       * 层（桌面图标之下），Finder 的桌面窗口吃掉全部鼠标事件，页面收不到 mousemove。
       *
       * @param u 归一化 X ∈ [0,1]，相对本窗口左边
       * @param v 归一化 Y ∈ [0,1]，相对本窗口上边（**Y 朝下**，不要替 shader 翻）
       * @param buttons 按键位掩码：bit0 左键。当前只消费 bit0
       * @param mods 修饰键掩码：bit0 ctrl / bit1 shift / bit2 alt / bit3 meta。
       *   省略等于 0（老宿主不传无回归）。只有网页壁纸消费
       *
       * 宿主侧的坐标换算、采样频率、点击边缘保持等要求见 docs/INTEGRATION.md。
       * 场景壁纸与网页壁纸都生效：场景侧写进统一指针状态对象，网页侧由 shim 合成
       * DOM 事件（CSS `:hover` 是硬限制，合成事件点不亮它）。
       */
      pushPointer(u: number, v: number, buttons?: number, mods?: number): void;
      /** 外部指针离开本窗口（鼠标移到别的显示器）：清按键，位置保持最后已知点 */
      pointerLeave(): void;
      /**
       * 外部滚轮注入（宿主捕获 scrollWheel / 触摸板手势后推入）。
       *
       * **只对网页壁纸生效**，场景壁纸静默无效——WE 脚本沙箱没有滚轮 API，
       * 本机 194 张场景壁纸零消费（详见 docs/INTEGRATION.md 未覆盖表）。
       *
       * @param dx 横向滚动量，正 = 内容向右（与 DOM deltaX 同向）
       * @param dy 纵向滚动量，正 = 内容向下（与 DOM deltaY 同向，
       *   与 macOS NSEvent.scrollingDeltaY **反向**，取反由宿主负责）
       * @param mode deltaMode：0 像素 / 1 行 / 2 页。触摸板与 Magic Mouse 恒为 0
       * @param mods 修饰键掩码，bit0 ctrl。**触摸板双指捏合映射成 ctrl + 滚轮**
       *   （浏览器就是这么把 magnify 手势喂给网页的，OrbitControls / pano2vr
       *   都靠 event.ctrlKey 区分缩放与滚动）
       */
      pushWheel(dx: number, dy: number, mode?: number, mods?: number): void;
      /** 纯前端预览：本地 scene.pkg（File）直进 fileSource，无需任何后端；project.json 可选 */
      loadSceneFile(file: File, project?: File): void;
      /**
       * 注册宿主音频频谱源（拉模式）。渲染循环每帧调一次 fn，取 64 段左右声道
       * 频谱（值域 0..1）；返回 null 表示暂时无数据，该帧回落内置模拟源。
       * 传 null 注销。
       *
       * 拉而不推：宿主每帧推 128 个浮点要走字符串拼接与 JS 解析，安卓 WebView
       * 上 60fps 下开销可观。让渲染器主动拉，宿主可用同步原生桥直接返回。
       */
      setAudioBridge(
        fn: (() => { left: ArrayLike<number>; right: ArrayLike<number> } | null) | null,
      ): void;
      /**
       * 截取当前帧作缩略图，返回 dataURL；无画布时返回 null。
       * 场景画布的 WebGL2 上下文是 preserveDrawingBuffer:true，可直接读，
       * 无需 flush 技巧。
       *
       * @param maxWidth 最大宽度，超出时等比缩小。0 或省略表示原尺寸
       */
      capture(maxWidth?: number): string | null;
      /** 回读当前生效的用户属性值表（扁平 `{name: value}`）。无场景时返回 null */
      getProperties(): Record<string, unknown> | null;
    };
    /**
     * 运行时观测面（只读）。宿主 / 测试台轮询取真实帧率：
     * fps 是渲染循环最近 500ms 的实测值，running=false 表示已暂停或没在出帧。
     * 网页壁纸经 shim postMessage 打点，可读。
     */
    __wpStats?: {
      frame(): { fps: number; running: boolean };
    };
  }
}

window.__wpStats = {
  frame: () => frameStats(rt),
};

window.__wp = {
  setWallpaper(cfg: WallpaperConfig) {
    rt.cfg = cfg;
    rt.paused = false;
    applyWallpaperFilter(rt);
    mountWallpaper(rt, cfg);
  },
  pause() {
    rt.paused = true;
    weShimCall(rt, (w: any) => w.__weSetPaused?.(true));
    if (rt.sceneCtl) {
      rt.sceneCtl.pause();
      return;
    }
    for (const p of rt.videoPairs ?? []) p.pause();
    rt.video?.pause();
    if (rt.raf !== undefined) {
      cancelAnimationFrame(rt.raf);
      rt.raf = undefined;
    }
  },
  resume() {
    rt.paused = false;
    // 丢掉暂停前的打点：短暂停（<窗口长度）残留的旧时间戳会把恢复后的
    // 首个读数算得偏低，看起来像刚恢复就掉帧。
    resetFrameMeter(rt);
    weShimCall(rt, (w: any) => w.__weSetPaused?.(false));
    if (rt.cfg.type === "canvas") {
      startCanvasDemoLoop(rt);
      return;
    }
    if (rt.sceneCtl) {
      rt.sceneCtl.resume();
      return;
    }
    // DOM 直显视频：没有 rAF 循环，只恢复元素播放。
    // 有 A/B 无缝循环对时必须走 pair.resume()：它同时重启预热调度的 rAF，
    // 只 play() 主元素会让恢复后的第一圈退回原生 loop（卡顿重现）。
    if (rt.videoPairs?.length) {
      for (const p of rt.videoPairs) p.resume();
      return;
    }
    if (rt.video) void rt.video.play().catch(() => {});
  },
  setFit(fit: string) {
    rt.cfg.fit = fit as WallpaperFit;
    resetCoverAlign(rt);
    // 网页壁纸：cover 才做露底自适配，contain/stretch 回满视口（实时切换，不重挂）
    rt.webRelayout?.();
    // DOM 直显路径（视频壁纸、无 WebGL2 的图片/GIF）才需要改 object-fit；
    // 走场景引擎时 fit 由渲染循环每帧读 rt.cfg.fit 传给 fitWindow，无需重挂。
    // 双元素循环时两个 <video> 都要改，否则交接后 fit 变回旧值。
    const f = fitObjectFit(fit as WallpaperFit);
    const applyFit = (obj: HTMLElement) => {
      obj.style.objectFit = f.objectFit;
      obj.style.background = f.background;
      obj.style.objectPosition = "50% 50%";
    };
    for (const p of rt.videoPairs ?? []) {
      for (const el of [p.active, p.standby]) if (el.isConnected) applyFit(el);
    }
    const obj = rt.video ?? rt.img;
    // 不再要求 parentElement === rt.wrap：库形态下视频挂在调用方容器里，
    // 那个判断恒 false，症状是 setFit 对库形态的视频壁纸完全无反应。
    if (obj && obj.isConnected && !rt.videoPairs?.length) applyFit(obj);
  },
  setVolume(volume: number) {
    // 双元素循环对自己管音量与静音（备用侧恒静音防双声），不能绕过它直接
    // 写 rt.video —— 那样交接后音量会跟着旧元素的状态走
    if (rt.videoPairs?.length) {
      for (const p of rt.videoPairs) p.setVolume(volume);
    } else if (rt.video) {
      rt.video.volume = Math.max(0, Math.min(1, volume));
      rt.video.muted = volume <= 0;
    }
    if (rt.sceneAudio) {
      rt.sceneAudio.setVolume(volume);
    }
    weShimCall(rt, (w: any) => w.__weSetVolume?.(Math.max(0, Math.min(1, volume))));
  },
  // 释放壁纸渲染资源（画布/WebGL/视频/iframe），归还内存；保留 rt.cfg 供 restore() 重建
  release() {
    clear(rt);
  },
  // 重新挂载上次配置（显示器睡眠后唤醒、或 release() 之后恢复）
  restore() {
    if (rt.cfg) mountWallpaper(rt, rt.cfg);
  },
  // 动态调整渲染分辨率上限：需重建画布，重挂当前配置
  setRenderDpr(dpr: number) {
    rt.cfg.renderDpr = dpr;
    mountWallpaper(rt, rt.cfg);
  },
  // 调整场景帧率：渲染循环每帧读取 rt.cfg.sceneFps，无需重挂载即可实时生效
  setSceneFps(fps: number) {
    rt.cfg.sceneFps = fps;
    weShimCall(rt, (w: any) => w.__weSetFps?.(fps));
  },
  // 切换滤镜（beta）：查白名单后应用到 wrap，CSS 合成层处理，无需重挂载
  setFilter(filter: string) {
    rt.cfg.filter = filter;
    applyWallpaperFilter(rt);
  },
  // 热更新用户属性。网页/场景都走 sceneCtl（就地改，不重挂）；
  // 无 ctl 时退回直接 weShimCall（裸 iframe 回退路径）。
  updateWebProps(props: Record<string, { value: unknown }>) {
    if (rt.sceneCtl) {
      rt.sceneCtl.applyUserProperties(props);
      return;
    }
    weShimCall(rt, (w: any) => w.__weApplyProps?.(props));
  },
  // 外部指针注入。桌面壁纸窗口在 underlay 层（桌面图标之下）收不到任何鼠标事件 ——
  // Finder 的桌面窗口全屏盖在上面吃掉了它们，且 macOS 没有「向下透传」的窗口属性。
  // 宿主轮询系统鼠标（CGEventGetLocation + CGEventSourceButtonState，零权限）后
  // 换算成本窗口归一化坐标推进来。协议与宿主实现要求见 docs/INTEGRATION.md。
  //
  // 用扁平位置参数而非对象：宿主经 window.eval 字符串注入，~90Hz 调用下参数
  // 越短 eval 解析越省。无场景壁纸（视频/网页/降级页）时静默忽略。
  pushPointer(u: number, v: number, buttons?: number, mods?: number) {
    rt.pointerCtl?.push({ u, v, buttons, mods });
  },
  pointerLeave() {
    rt.pointerCtl?.leave();
  },
  // 外部滚轮注入（含 macOS 触摸板双指滚动与捏合）。位置沿用最后一次 pushPointer ——
  // 宿主拿到滚轮事件时通常刚推过指针位置，再带一遍纯属冗余（eval 字符串更长）。
  //
  // wheel 是可选方法：只有网页壁纸装配时实现。场景壁纸不实现不是遗漏 ——
  // WE 脚本沙箱没有滚轮 API，本机 194 张场景壁纸零消费。
  pushWheel(dx: number, dy: number, mode?: number, mods?: number) {
    rt.pointerCtl?.wheel?.({ dx, dy, mode, mods });
  },
  // 纯前端预览：本地 scene.pkg 经同源 iframe 直传进来，包字节不落任何服务器。
  // 继承当前 fit/dpr/帧率/滤镜等观看偏好；无 project.json 时属性用场景快照值。
  loadSceneFile(file: File, project?: File) {
    const prev = rt.cfg ?? {};
    rt.cfg = {
      type: "scene",
      fit: prev.fit,
      renderDpr: prev.renderDpr,
      sceneFps: prev.sceneFps,
      muted: prev.muted,
      loop: prev.loop,
      filter: prev.filter,
      source: fileSource(file, project),
    };
    rt.paused = false;
    applyWallpaperFilter(rt);
    mountWallpaper(rt, rt.cfg);
  },
  // 宿主音频频谱源。只存引用，实际每帧拉取在 scene-mount 的渲染循环里。
  // 换壁纸不清空：宿主装一次就该对之后所有场景生效。
  setAudioBridge(fn) {
    rt.audioBridge = typeof fn === "function" ? fn : null;
  },
  // 截取当前帧。场景画布用 preserveDrawingBuffer:true 创建，直接 toDataURL 即可。
  // 超过 maxWidth 时经离屏 canvas 等比缩小——安卓侧缩略图只要几百像素宽，
  // 原尺寸 4K 截图的 dataURL 有几 MB，跨 JS 桥传回去很慢。
  capture(maxWidth?: number) {
    const src = rt.canvas ?? document.querySelector("canvas");
    if (!src || !src.width || !src.height) return null;
    try {
      const limit = maxWidth && maxWidth > 0 ? maxWidth : 0;
      if (!limit || src.width <= limit) return src.toDataURL("image/jpeg", 0.85);

      const scale = limit / src.width;
      const off = document.createElement("canvas");
      off.width = limit;
      off.height = Math.max(1, Math.round(src.height * scale));
      const ctx = off.getContext("2d");
      if (!ctx) return src.toDataURL("image/jpeg", 0.85);
      ctx.drawImage(src, 0, 0, off.width, off.height);
      return off.toDataURL("image/jpeg", 0.85);
    } catch {
      // 画布被跨源内容污染时 toDataURL 会抛 SecurityError
      return null;
    }
  },
  // 回读实时属性值表。与 updateWebProps 配对，让宿主的属性面板能闭环
  // （改完读回确认，以及面板初始化时拿到场景快照值而非 project.json 默认值）。
  getProperties() {
    return rt.liveUserProps ? { ...rt.liveUserProps } : null;
  },
};

// 初始配置优先取自 URL query（壁纸引擎窗口创建时注入，同步无竞态）。
// 旧形态没有 source 字段 —— mediaBase/src 由 scene-mount 内部合成 httpSource。
const params = new URLSearchParams(location.search);
const rawType = (params.get("type") ?? "canvas").toLowerCase();
const initialCfg: WallpaperConfig = {
  type: (rawType as WallpaperConfig["type"]) || "canvas",
  src: params.get("src") ?? undefined,
  fit: (params.get("fit") as WallpaperConfig["fit"]) ?? "cover",
  renderDpr: Number(params.get("renderDpr")) || 1,
  sceneFps: Number(params.get("sceneFps")) || 60,
  muted: params.get("muted") !== "false",
  loop: params.get("loop") !== "false",
  filter: params.get("filter") ?? undefined,
  mediaBase: params.get("mediaBase") ?? undefined,
  liveSystem: params.get("liveSystem") === "1" || params.get("liveSystem") === "true",
  opaque: params.get("opaque") === "1" || params.get("opaque") === "true",
  clearColor: params.get("clearColor") ?? undefined,
};
rt.cfg = initialCfg;
applyWallpaperFilter(rt);
mountWallpaper(rt, initialCfg);

// 这里曾有一个一次性 /diag 探针，上报「壁纸窗口是否收到 mousemove/mousedown」。
// 结论已定且成了 __wp.pushPointer 存在的理由：underlay 层（桌面图标之下）永远
// 收不到 —— Finder 的桌面窗口吃掉了全部鼠标事件。故移除探针，不再重复求证。

// 页面卸载兜底：预览 iframe 关闭 / 壁纸窗口销毁时释放 WebGL 上下文与 blob URL。
// （clear() 内部用 sceneCleanup 置 disposed + renderer.dispose，对已进入卸载流程的 iframe 安全。）
window.addEventListener("pagehide", () => clear(rt));
window.addEventListener("beforeunload", () => clear(rt));

export {};
