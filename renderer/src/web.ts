// 网页壁纸：sandbox iframe + 加载前注入 WE shim + 音频/属性泵 + sceneCtl 对齐
import {
  clear,
  markFrame,
  normalizeFit,
  reportDiag,
  type Runtime,
} from "./shell";
import type { WallpaperConfig } from "./types";
import { startLiveSystem, type LiveSystemHandle } from "./live-system";
import { audioMod, media as mediaMod } from "./vendor";
import { entryDirUrl, hasBlockingCsp, rewriteHtml } from "./web-rewrite";
import shimSource from "./web-shim.js?raw";

export function weShimCall(rt: Runtime, call: (win: any) => void) {
  try {
    const win = (rt.iframe as HTMLIFrameElement | null)?.contentWindow as any;
    if (win) call(win);
  } catch {
    /* 非同源 iframe 不可访问则忽略 */
  }
}

/** 向网页壁纸 iframe 注入 GPU 降级（shim 已接管则跳过） */
export function injectGpuThrottle(rt: Runtime, f: HTMLIFrameElement, _doc: Document) {
  const win = f.contentWindow;
  if (!win) return;
  if ((win.requestAnimationFrame as any)?.__weThrottled) return;
  const fps = rt.cfg.sceneFps || 30;
  if (fps >= 60) return;
  const interval = 1000 / fps;
  try {
    const origRaf = win.requestAnimationFrame.bind(win);
    const rafMap = new Map<number, number>();
    let counter = 0;
    (win as any).requestAnimationFrame = (cb: FrameRequestCallback) => {
      const id = ++counter;
      const to = win.setTimeout(() => {
        rafMap.delete(id);
        origRaf((now: number) => {
          try {
            cb(now);
          } catch {
            /* 忽略 */
          }
        });
      }, interval);
      rafMap.set(id, to as unknown as number);
      return id;
    };
    (win as any).cancelAnimationFrame = (id: number) => {
      const to = rafMap.get(id);
      if (to !== undefined) {
        win.clearTimeout(to);
        rafMap.delete(id);
      }
    };
  } catch {
    /* 忽略 */
  }
}

/** 左64+右64 → WE 网页 API 的 128 元数组。
 *  公共 API 版：每次新分配（调用方可能持有结果）。
 *  音频泵（30Hz）走 packWebAudioArrayInto 复用模块级缓冲，避免每帧 GC 碎屑。 */
export function packWebAudioArray(
  left: ArrayLike<number>,
  right: ArrayLike<number>,
): Float32Array {
  const out = new Float32Array(128);
  packWebAudioArrayInto(out, left, right);
  return out;
}

const pumpBuffer = new Float32Array(128);

function packWebAudioArrayInto(
  out: Float32Array,
  left: ArrayLike<number>,
  right: ArrayLike<number>,
): Float32Array {
  const nL = Math.min(64, left.length);
  const nR = Math.min(64, right.length);
  for (let i = 0; i < nL; i++) out[i] = Number(left[i]) || 0;
  for (let i = 0; i < nR; i++) out[64 + i] = Number(right[i]) || 0;
  return out;
}

/**
 * 网页模拟音频相对场景音条的增益。
 *
 * 场景 `createSimulatedAudio` 的 GAIN=3.2 是给 shader 音条（均值要到 0.5–0.8）
 * 标定的。网页 `wallpaperRegisterAudioListener` 拿到的是作者自己再乘的 0..1 FFT：
 * 1748506393 默认 `SOUND_SENSITIVITY=5` 做 `floor(bass*5*10)` splat 计数，
 * 满幅 × ~60Hz 会把 HDR 染料+bloom 打成白屏。
 *
 * 但**只降增益是错的**：`left64` 已经过 `min(1, v*3.2)`，底鼓段基底就被抬到 ~0.6、
 * 峰值贴 1，波峰因数被压平；事后乘 0.2 得到的是 0.03–0.2 的一团平泥，
 * 谁也过不了阈值。1520828134 猫爪判定 `audioArray[i] > 0.5` 因此永不成立
 * （实测 0/960 帧敲击），猫看起来「不会动」。
 *
 * 正解是对**未钳位**的 `preL64/preR64` 做 gamma 对比扩展再乘增益：
 * 真实音乐 FFT 是尖的（底鼓瞬时接近 1、间隙 ~0.05），gamma>1 把基底压深、
 * 峰值留住，同时满足「峰值过阈值」（猫）与「低频均值要小」（流体积分型）两类作者。
 */
export const WEB_SIM_AUDIO_GAIN = 1.8;

/**
 * 网页模拟音频的对比扩展指数（作用在未钳位频谱上，见 WEB_SIM_AUDIO_GAIN）。
 *
 * 1.8 时 band2 的基底/峰值对比由 5.4× 拉到 ~21×：流体低频均值 splat 速率
 * 与旧的「钳位×0.2」持平（约 178 vs 179 颗/秒），而猫每秒约 1.6 次敲击
 * （曲目 112 BPM ≈ 1.87 拍/秒），静音段 0 次。
 */
export const WEB_SIM_AUDIO_GAMMA = 1.8;

/** WE 网页音频回调大约 30Hz；更快会让积分型可视化（splat/粒子）过热 */
export const WEB_AUDIO_PUMP_HZ = 30;

type WebAudioDriver = {
  snapshot(): { left: ArrayLike<number>; right: ArrayLike<number> };
  /** 模拟源需要按时间推进；外部 AudioSource 可空 */
  tick?(nowMs: number): void;
};

/**
 * 未钳位频段 → 网页 listener 的 0..1 FFT：gamma 对比扩展 + 增益。
 * 单独导出供 verify-web 用真实语料复算猫/流体两类判定。
 */
export function shapeWebAudioBand(pre: number): number {
  const v = Number(pre) || 0;
  if (v <= 0) return 0;
  return Math.min(1, Math.pow(v, WEB_SIM_AUDIO_GAMMA) * WEB_SIM_AUDIO_GAIN);
}

function defaultAudioDriver(): WebAudioDriver {
  const sim = audioMod.createSimulatedAudio();
  const left = new Float32Array(64);
  const right = new Float32Array(64);
  return {
    tick(nowMs: number) {
      sim.update(nowMs / 1000);
    },
    snapshot() {
      const s = sim.snapshot as unknown as {
        left64: ArrayLike<number>;
        right64: ArrayLike<number>;
        preL64?: ArrayLike<number>;
        preR64?: ArrayLike<number>;
      };
      // 优先未钳位频谱；老快照（无 pre 系列）退回钳位值乘固定小增益，行为同旧版
      const preL = s.preL64;
      const preR = s.preR64;
      for (let i = 0; i < 64; i++) {
        if (preL && preR) {
          left[i] = shapeWebAudioBand(preL[i]);
          right[i] = shapeWebAudioBand(preR[i]);
        } else {
          left[i] = (Number(s.left64[i]) || 0) * 0.2;
          right[i] = (Number(s.right64[i]) || 0) * 0.2;
        }
      }
      return { left, right };
    },
  };
}

/**
 * 宿主注入的频谱源（rt.audioBridge）包成 web 侧的 driver。
 *
 * **不套 shapeWebAudioBand 的 gamma 扩展**：那道处理是给内置模拟源的未钳位
 * 频段用的（把平缓的合成波形拉出对比度），而宿主给的已经是 0..1 归一化的真实
 * 频谱，再乘一遍 gamma+增益会把音条整体顶到满格。
 *
 * bridge 返回 null（未采集/无权限/本帧无数据）时返回全零而不是回落模拟源：
 * 宿主明确装了源就说明它要自己供数，此时冒出一段合成波形只会让人以为"注入
 * 生效了"。真要回落模拟源，调用方 setAudio(null) 撤源即可。
 */
function bridgeAudioDriver(rt: Runtime): WebAudioDriver {
  const left = new Float32Array(64);
  const right = new Float32Array(64);
  return {
    snapshot() {
      const src = rt.audioBridge?.();
      const sl = src?.left;
      const sr = src?.right;
      const n = sl && sr ? Math.min(64, sl.length, sr.length) : 0;
      for (let i = 0; i < n; i++) {
        left[i] = Math.max(0, Math.min(1, Number(sl![i]) || 0));
        right[i] = Math.max(0, Math.min(1, Number(sr![i]) || 0));
      }
      for (let i = n; i < 64; i++) {
        left[i] = 0;
        right[i] = 0;
      }
      return { left, right };
    },
  };
}

/**
 * 「系统实况」麦克风包成 web 侧 driver。
 *
 * cfg.liveSystem 此前**只有 scene 装配路径消费**（web.ts 里 liveSystem 零引用），
 * 所以测试台勾上「系统实况」后，场景壁纸的音条跟着麦克风动、网页壁纸却始终是
 * 内置合成流。它与 rt.audioBridge 是两条独立通道：前者是库自己采麦克风，
 * 后者是宿主把已采好的频谱推进来，两者都要能喂到网页壁纸。
 *
 * live 的 snapshot 是钳位后的 left64/right64（0..1），与宿主注入同属"真实频谱"，
 * 因此同样**不套 shapeWebAudioBand 的 gamma 扩展**（那是给合成源拉对比度的）。
 */
function liveAudioDriver(handle: LiveSystemHandle): WebAudioDriver {
  const left = new Float32Array(64);
  const right = new Float32Array(64);
  return {
    tick() {
      handle.audio.pump();
    },
    snapshot() {
      const s = handle.audio.snapshot;
      for (let i = 0; i < 64; i++) {
        left[i] = Math.max(0, Math.min(1, Number(s.left64[i]) || 0));
        right[i] = Math.max(0, Math.min(1, Number(s.right64[i]) || 0));
      }
      return { left, right };
    },
  };
}

function resolveContainer(rt: Runtime, cfg: WallpaperConfig): HTMLElement | null {
  // 全屏适配层：画在 wrap 里
  if (rt.wrap) return rt.wrap;
  // 库形态：优先空容器；canvas 不能有子节点，退到其父元素
  const el = cfg.canvas as HTMLElement | undefined;
  if (!el) return null;
  if (el instanceof HTMLCanvasElement) {
    const parent = el.parentElement;
    if (parent) {
      reportDiag(rt, cfg, "网页壁纸挂在 canvas 父容器上（canvas 不能有子节点；更适合空 div）");
      return parent;
    }
    return null;
  }
  return el;
}

function buildSeedScript(
  props: Record<string, { value: unknown }> | undefined,
  fps: number | undefined,
  volume: number | undefined,
): string {
  const parts: string[] = [];
  if (fps != null && Number.isFinite(fps)) parts.push(`window.__weSetFps(${Number(fps)});`);
  if (volume != null && Number.isFinite(volume)) {
    parts.push(`window.__weSetVolume(${Math.max(0, Math.min(1, Number(volume)))});`);
  }
  if (props && Object.keys(props).length) {
    // JSON 对脚本安全：无 U+2028/函数；再逃一次 </script>
    parts.push(`window.__weSeedProps(${JSON.stringify(props)});`);
  }
  return parts.join("\n");
}

/**
 * 挂上「露底才换视口」的自适配：iframe 默认 100%×100%，只有量到黑条才改成覆盖式视口。
 *
 * 复算时机：视口尺寸变化（resize/切分辨率）、fit 切换、媒体元数据到达（视频要先知道
 * 原始比例）。作者脚本可能晚于 load 才插入 video，所以 load 后再补几拍。
 */
function installLetterboxFix(rt: Runtime, f: HTMLIFrameElement, container: HTMLElement) {
  const BASE = "position:absolute;border:none;background:transparent;";
  const applyFull = () => {
    f.style.cssText = BASE + "inset:0;width:100%;height:100%;";
  };
  applyFull();

  let lastKey = "";
  const relayout = () => {
    if (!f.isConnected) return;
    let doc: Document | null = null;
    try {
      doc = f.contentDocument;
    } catch {
      return; // 跨源：交给作者页面自己，不动
    }
    if (!doc) return;

    const stageW = container.clientWidth || window.innerWidth || 0;
    const stageH = container.clientHeight || window.innerHeight || 0;
    // 非 cover（contain/stretch）保持旧行为：contain 本就该留边，stretch 该拉伸
    const cover = normalizeFit(rt.cfg.fit) === "cover";
    // 量之前必须先回到满视口，否则量到的是上一次裁剪后的盒子（自反馈会锁死）
    applyFull();
    const box = cover && stageW > 0 && stageH > 0 ? measureWebLetterbox(doc) : null;
    const vp = box ? webCoverViewport(stageW, stageH, box.contentAspect) : null;
    const key = vp ? `${Math.round(vp.width)}x${Math.round(vp.height)}` : "full";
    if (!vp) {
      lastKey = "full";
      return; // 已满视口
    }
    f.style.cssText =
      BASE +
      `left:${vp.left}px;top:${vp.top}px;width:${vp.width}px;height:${vp.height}px;`;
    if (key !== lastKey) {
      lastKey = key;
      reportDiag(
        rt,
        rt.cfg,
        `网页壁纸露底自适配：视口按内容比例改为 ${Math.round(vp.width)}×${Math.round(vp.height)}（cover 居中裁切）`,
      );
    }
  };

  const onResize = () => relayout();
  window.addEventListener("resize", onResize);
  let ro: ResizeObserver | undefined;
  if (typeof ResizeObserver !== "undefined") {
    ro = new ResizeObserver(() => relayout());
    ro.observe(container);
  }
  // 视频/图片的原始比例要等元数据；作者也可能晚插入元素，load 后补几拍
  const timers: number[] = [];
  const onLoad = () => {
    relayout();
    for (const d of [120, 400, 1200]) timers.push(window.setTimeout(relayout, d));
    try {
      const doc = f.contentDocument;
      if (doc) {
        for (const el of doc.querySelectorAll("video,img")) {
          el.addEventListener("loadedmetadata", relayout, { once: true });
          el.addEventListener("load", relayout, { once: true });
        }
      }
    } catch {
      /* 跨源忽略 */
    }
  };
  f.addEventListener("load", onLoad);
  rt.webRelayout = relayout;

  const prev = rt.sceneCleanup;
  rt.sceneCleanup = () => {
    window.removeEventListener("resize", onResize);
    ro?.disconnect();
    for (const t of timers) clearTimeout(t);
    f.removeEventListener("load", onLoad);
    if (rt.webRelayout === relayout) rt.webRelayout = undefined;
    try {
      prev?.();
    } catch {
      /* 忽略 */
    }
  };
}

/**
 * 窗口归一化 u/v → iframe 内 client 像素。
 *
 * 单独导出成纯函数是为了能被 verify-web 按定义数值校验（与 webCoverViewport 同样路子）：
 * 这条换算错了不会报错，只是鼠标位置整体偏，肉眼很难量。
 *
 * @param stage 容器（舞台）在视口里的盒子——归一化坐标的分母就是它
 * @param frame iframe 在视口里的盒子；cover 露底自适配下它可能比 stage 大且带负偏移
 * @param client iframe 的内部视口尺寸（clientWidth/Height，未受祖先 CSS 缩放影响）
 */
export function webPointerToClient(
  u: number,
  v: number,
  stage: { left: number; top: number; width: number; height: number },
  frame: { left: number; top: number; width: number; height: number },
  client: { width: number; height: number },
): { x: number; y: number } | null {
  if (!Number.isFinite(u) || !Number.isFinite(v)) return null;
  if (!(stage.width > 0) || !(stage.height > 0)) return null;
  // 祖先 CSS transform 缩放：getBoundingClientRect 含缩放，iframe 内部视口不含。
  // 测试台的固定分辨率模式（#stage-scale）就是这个情形。
  const sx = frame.width > 0 && client.width > 0 ? frame.width / client.width : 1;
  const sy = frame.height > 0 && client.height > 0 ? frame.height / client.height : 1;
  return {
    x: (u * stage.width - (frame.left - stage.left)) / (sx || 1),
    y: (v * stage.height - (frame.top - stage.top)) / (sy || 1),
  };
}

/**
 * 外部指针注入的父页侧桥接：窗口归一化 u/v → iframe 内 client 像素 → shim 合成事件。
 *
 * 为什么换算要在父页做：iframe 未必与容器同尺寸同原点 —— cover 露底自适配会把它
 * 换成「内容比例的覆盖式视口」并居中偏移（见 installLetterboxFix，1731760875 的
 * 16:10 情形是 1920×1200 容器里放 2133×1200 视口、left 为负）。归一化坐标是相对
 * **窗口**的（宿主按 CGDisplayBounds 算，见 docs/INTEGRATION.md），必须先落到容器
 * 像素，再减掉 iframe 相对容器的偏移，才是作者代码看到的 clientX/clientY。
 * 让 shim 自己除一遍会得到「相对被裁切视口」的坐标，画面上肉眼可见地偏。
 */
function installWebPointerBridge(rt: Runtime, f: HTMLIFrameElement, container: HTMLElement) {
  rt.pointerCtl = {
    push(p) {
      if (!f.isConnected) return;
      const cRect = container.getBoundingClientRect();
      const fRect = f.getBoundingClientRect();
      const pt = webPointerToClient(
        Number(p?.u),
        Number(p?.v),
        {
          left: cRect.left,
          top: cRect.top,
          width: cRect.width || container.clientWidth || window.innerWidth || 0,
          height: cRect.height || container.clientHeight || window.innerHeight || 0,
        },
        { left: fRect.left, top: fRect.top, width: fRect.width, height: fRect.height },
        { width: f.clientWidth, height: f.clientHeight },
      );
      // 非有限值丢弃（与场景通道同一约定）：NaN 会让 elementFromPoint 返回 null，
      // 作者的位移积分一次性污染成 NaN 且没有任何报错。
      if (!pt) return;
      weShimCall(rt, (w: any) => w.__wePushPointer?.(pt.x, pt.y, Number(p.buttons) || 0));
    },
    leave() {
      weShimCall(rt, (w: any) => w.__wePointerLeave?.());
    },
  };
  // 无需自挂 cleanup：clear() 统一清 rt.pointerCtl（与场景通道同一处）。
}

function attachIframe(
  rt: Runtime,
  cfg: WallpaperConfig,
  container: HTMLElement,
  src: string,
  opts: { blobUrl?: string; injected: boolean; frameClock?: { last: number } },
) {
  const f = document.createElement("iframe");
  f.setAttribute("sandbox", "allow-scripts allow-same-origin");
  f.style.cssText =
    "position:absolute;inset:0;width:100%;height:100%;border:none;background:transparent;";
  // 库形态画在非全屏容器时，容器需定位上下文
  if (!rt.wrap && getComputedStyle(container).position === "static") {
    container.style.position = "relative";
  }
  f.src = src;
  container.appendChild(f);
  rt.iframe = f;
  if (opts.blobUrl) {
    (rt.objectUrls ??= []).push(opts.blobUrl);
  }
  installLetterboxFix(rt, f, container);
  // 外部指针注入：装了 shim 才有合成事件的接收端；裸 iframe 回退路径下推送静默无效。
  if (opts.injected) installWebPointerBridge(rt, f, container);

  const onFrameMsg = (ev: MessageEvent) => {
    if (ev.source !== f.contentWindow) return;
    const data = ev.data;
    if (!data || data.op !== "we-frame") return;
    if (rt.paused) return;
    const t = typeof data.t === "number" ? data.t : performance.now();
    if (opts.frameClock) opts.frameClock.last = t;
    markFrame(rt, t);
  };
  window.addEventListener("message", onFrameMsg);
  const prevCleanup = rt.sceneCleanup;
  rt.sceneCleanup = () => {
    window.removeEventListener("message", onFrameMsg);
    try {
      prevCleanup?.();
    } catch {
      /* 忽略 */
    }
  };

  f.addEventListener("load", () => {
    try {
      const doc = f.contentDocument;
      if (doc) (window as any).__blockContextMenu?.(doc);
      if (!opts.injected) injectGpuThrottle(rt, f, doc!);
    } catch {
      /* 跨源忽略 */
    }
    // load 后再 flush 一次（listener 在作者脚本里赋值；WE 挂载必调全量 applyUserProperties）
    weShimCall(rt, (w) => {
      const wire: Record<string, { value: unknown }> = {};
      for (const [k, v] of Object.entries(rt.liveUserProps ?? {})) wire[k] = { value: v };
      w.__weApplyProps?.(wire);
      w.__weSetFps?.(rt.cfg.sceneFps ?? 60);
      w.__weSetVolume?.(rt.cfg.muted === false ? 1 : 0);
      if (rt.paused) w.__weSetPaused?.(true);
    });
    // 首帧钩子：网页没有 GL 提交，load 即视为就绪
    try {
      rt.onFirstFrame?.();
      rt.onFirstFrame = undefined;
    } catch {
      /* 忽略 */
    }
    const w = container.clientWidth || window.innerWidth || 1;
    const h = container.clientHeight || window.innerHeight || 1;
    try {
      rt.onSceneInfo?.({
        width: w,
        height: h,
        layerCount: 0,
        hasModels: false,
        hasParticles: false,
        hasText: false,
      });
    } catch {
      /* 忽略 */
    }
  });
}

/**
 * 作者没做全屏适配的网页壁纸：按「覆盖式设计视口」铺满，避免露出 body 底色。
 *
 * WE 的网页壁纸就是一张按显示器尺寸铺开的网页，绝大多数作者会写 `object-fit:cover` /
 * `height:100%` / `100vw`（本机 12 张含 video 的墙有 11 张这么写）。但也有作者只写
 * `#video { width:100% }`（1731760875 Minecraft 红石钟，全库仅此 1 张）：高度 auto →
 * 16:9 视频在 16:10 视口里只有 1920×1080，下面 120px 露出 `body` 黑底 = 用户看到的黑条。
 *
 * **不能直接给 video 补 `object-fit:cover`**：该墙的时钟数字是四个绝对定位 `<img>`，
 * 用 `padding-left:79.9%` 这类**视口百分比**对准视频里的红石显示器。只放大 video 内容、
 * 不动时钟坐标系，两者就会脱钩（16:10 下实测错位 64px，数字会飘出显示器）。
 *
 * 正解是把**整个页面视口**换成内容比例、让溢出的一边居中裁掉：视频与时钟同处一个坐标系，
 * 相对位置分毫不动（错位 0px），也没有黑条。等价于场景侧 cover 的既有语义
 * （见 CASEBOOK「32:9 场景多分辨率不适配」）。
 *
 * **只对「确实露底」的页面做**：那 48 张自己做了适配的墙必须原样 100%×100%——
 * 给它们换视口再裁会把贴边的 UI（时钟/按钮）裁出屏幕，是实打实的回归。
 * 判据不看 CSS 文本，而是**量真实盒子**（见 measureWebLetterbox）。
 */

/** 视口比例与内容比例差多少以内算「已经贴上」，不必再换视口（DPR 取整误差留余量） */
const WEB_ASPECT_EPS = 0.005;

/** 露底判定阈值：占视口 1% 以上的空隙才算黑条（躲开亚像素/取整缝） */
const WEB_LETTERBOX_MIN_RATIO = 0.01;

/** 合理的内容宽高比区间：超出即视为量错（元数据未到时盒子会塌成细条，别拿它当设计比例） */
const WEB_ASPECT_MIN = 0.2;
const WEB_ASPECT_MAX = 6;

/**
 * 覆盖式设计视口：把 `contentAspect` 的内容铺满 `stageW×stageH`，溢出的一边居中裁掉。
 *
 * 返回给 iframe 用的 CSS 尺寸与居中偏移；null = 无需特殊处理（直接 100%×100%）。
 * 不用 transform 缩放：视口本身就取内容比例，1 CSS px 仍是 1 舞台 px，文字/视频不重采样。
 */
export function webCoverViewport(
  stageW: number,
  stageH: number,
  contentAspect: number,
): { width: number; height: number; left: number; top: number } | null {
  if (!(stageW > 0) || !(stageH > 0) || !(contentAspect > 0)) return null;
  const stageAspect = stageW / stageH;
  if (Math.abs(stageAspect - contentAspect) <= WEB_ASPECT_EPS) return null;
  if (stageAspect < contentAspect) {
    // 舞台比内容更「高」（16:10 vs 16:9）→ 对齐高度，宽度溢出居中裁掉
    const width = stageH * contentAspect;
    return { width, height: stageH, left: (stageW - width) / 2, top: 0 };
  }
  // 舞台更「宽」（21:9/32:9）→ 对齐宽度，高度溢出居中裁掉
  const height = stageW / contentAspect;
  return { width: stageW, height, left: 0, top: (stageH - height) / 2 };
}

/**
 * 量出页面是否「露底」：找铺满横向、竖向却留出空隙的全幅媒体。
 *
 * 只认**贴着视口原点、横向铺满**的 video/img（作者的全幅背景就是这形态），
 * 且必须已知原始尺寸——比例取自媒体本身，不取渲染盒子。
 * 竖向比视口矮出 1% 以上即判定露底。不匹配 CSS 文本：`width:100%` 有一万种写法，
 * 量盒子才是真判据。
 *
 * 故意不含 `<canvas>`：canvas 没有内在比例（作者按视口 resize 自己的 backing store），
 * 27 张含 canvas 的墙本来就自己管尺寸，替它们换视口只会裁掉贴边 UI。
 */
export function measureWebLetterbox(doc: Document): { contentAspect: number } | null {
  const win = doc.defaultView;
  if (!win) return null;
  const vw = win.innerWidth;
  const vh = win.innerHeight;
  if (!(vw > 0) || !(vh > 0)) return null;

  const cands = [...doc.querySelectorAll("video,img")] as Array<
    HTMLVideoElement | HTMLImageElement
  >;
  for (const el of cands) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    // 必须横向铺满且贴顶（全幅背景形态），否则是时钟/图标之类的局部元素
    if (r.width < vw * 0.98) continue;
    if (Math.abs(r.left) > vw * 0.02 || r.top > vh * 0.02) continue;
    // 竖向留出的空隙够大才算黑条
    if (vh - r.height < vh * WEB_LETTERBOX_MIN_RATIO) continue;
    // 内容比例**只认媒体原始尺寸**：视频元数据未到时渲染盒子会是 300×150 之类的占位，
    // 拿它当设计比例会算出 15360×1200 这种荒谬视口（先前实测到的一次误判）。
    const natW = (el as HTMLVideoElement).videoWidth || (el as HTMLImageElement).naturalWidth || 0;
    const natH =
      (el as HTMLVideoElement).videoHeight || (el as HTMLImageElement).naturalHeight || 0;
    if (!(natW > 0) || !(natH > 0)) continue; // 元数据还没到：这一拍不判，等 loadedmetadata 再来
    const aspect = natW / natH;
    if (!Number.isFinite(aspect) || aspect < WEB_ASPECT_MIN || aspect > WEB_ASPECT_MAX) continue;
    return { contentAspect: aspect };
  }
  return null;
}

function vecToCss(v: { x?: number; y?: number; z?: number } | null | undefined): string {  if (!v) return "rgb(128,128,128)";
  const r = Math.round(Math.max(0, Math.min(1, Number(v.x) || 0)) * 255);
  const g = Math.round(Math.max(0, Math.min(1, Number(v.y) || 0)) * 255);
  const b = Math.round(Math.max(0, Math.min(1, Number(v.z) || 0)) * 255);
  return `rgb(${r},${g},${b})`;
}

/**
 * 给网页 MediaThumbnailListener 一张封面 data URL（语料读 event.thumbnail）。
 *
 * 宿主给了真实封面（snapshot.thumbnail）就直接透传；否则拿 primary/secondary
 * 画一张渐变占位图 —— 语料里 `img.src = e.thumbnail` 那类写法不能拿到空串。
 */
function thumbDataUrlFromSnap(snap: {
  thumbnail?: unknown;
  primaryColor?: { x?: number; y?: number; z?: number };
  secondaryColor?: { x?: number; y?: number; z?: number };
}): string {
  const real = typeof snap.thumbnail === "string" ? snap.thumbnail.trim() : "";
  if (real) return real;
  try {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const ctx = c.getContext("2d");
    if (!ctx) return "";
    const p = snap.primaryColor;
    const s = snap.secondaryColor;
    const grd = ctx.createLinearGradient(0, 0, 64, 64);
    grd.addColorStop(0, vecToCss(p));
    grd.addColorStop(1, vecToCss(s));
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, 64, 64);
    return c.toDataURL("image/jpeg", 0.85);
  } catch {
    return "";
  }
}

type WebMediaDriver = {
  update?(tSec: number): unknown;
  snapshot: Record<string, unknown>;
};

function defaultMediaDriver(): WebMediaDriver {
  return mediaMod.createSimulatedMedia() as WebMediaDriver;
}

function pushMediaDiff(
  rt: Runtime,
  prev: Record<string, unknown> | null,
  snap: Record<string, unknown>,
): Record<string, unknown> {
  const events = mediaMod.diffMediaEvents(prev, snap) as Array<{
    name: string;
    event: Record<string, unknown>;
  }>;
  for (const { name, event } of events) {
    if (name === "mediaStatusChanged") {
      weShimCall(rt, (w) => w.__wePushMedia?.({ op: "status", enabled: !!(event as { enabled?: boolean }).enabled }));
    } else if (name === "mediaPropertiesChanged") {
      weShimCall(rt, (w) =>
        w.__wePushMedia?.({
          op: "properties",
          title: event.title ?? "",
          artist: event.artist ?? "",
          album: event.album ?? "",
          albumArtist: event.albumArtist ?? "",
        }),
      );
    } else if (name === "mediaThumbnailChanged") {
      const thumb = thumbDataUrlFromSnap(snap as {
        thumbnail?: unknown;
        primaryColor?: { x?: number; y?: number; z?: number };
        secondaryColor?: { x?: number; y?: number; z?: number };
      });
      weShimCall(rt, (w) =>
        w.__wePushMedia?.({
          op: "thumbnail",
          thumbnail: thumb,
          hasThumbnail: !!(event as { hasThumbnail?: boolean }).hasThumbnail || !!thumb,
          primaryColor: vecToCss(event.primaryColor as { x?: number; y?: number; z?: number }),
          secondaryColor: vecToCss(event.secondaryColor as { x?: number; y?: number; z?: number }),
          tertiaryColor: vecToCss(event.tertiaryColor as { x?: number; y?: number; z?: number }),
          textColor: vecToCss(event.textColor as { x?: number; y?: number; z?: number }),
          highContrastColor: vecToCss(event.highContrastColor as { x?: number; y?: number; z?: number }),
        }),
      );
    } else if (name === "mediaPlaybackChanged") {
      weShimCall(rt, (w) => w.__wePushMedia?.({ op: "playback", state: Number(event.state) || 0 }));
    } else if (name === "mediaTimelineChanged") {
      weShimCall(rt, (w) =>
        w.__wePushMedia?.({
          op: "timeline",
          position: Number(event.position) || 0,
          duration: Number(event.duration) || 0,
        }),
      );
    }
  }
  return mediaMod.cloneMediaSnapshot(snap) as Record<string, unknown>;
}

function startAudioPump(
  rt: Runtime,
  driver: WebAudioDriver | null,
  frameClock?: { last: number },
  /** 系统实况麦克风的延迟持有：getUserMedia 是异步的，启动完成后回填 driver */
  liveHold: { driver: WebAudioDriver | null } = { driver: null },
) {
  if (!driver) return;
  // [1.3.1] 注入源的选择必须**逐帧**做，不能在装配时定死：setAudio() 常在
  // mount() 之后才调用（宿主的麦克风/SSE 通道那时才就绪），装配期捕获一个
  // driver 就意味着后装的源永远不生效——症状正是「麦克风接上了，网页壁纸
  // 的音谱还在放合成波形」。撤源（setAudio(null)）后同样要能落回原 driver。
  const bridged = bridgeAudioDriver(rt);
  // 优先级：宿主注入（rt.audioBridge）> 系统实况麦克风（cfg.liveSystem）> 默认模拟。
  // 宿主显式推数据时不该被麦克风盖掉；两者都没有才用合成流。
  const pick = (): WebAudioDriver =>
    rt.audioBridge ? bridged : (liveHold.driver ?? driver);
  let raf = 0;
  let lastPush = 0;
  const tick = (now: number) => {
    raf = requestAnimationFrame(tick);
    if (rt.paused || !rt.iframe) return;
    const fps = rt.cfg.sceneFps || 60;
    const pumpFps = Math.min(Math.max(1, fps), WEB_AUDIO_PUMP_HZ);
    const interval = 1000 / pumpFps;
    if (now - lastPush < interval * 0.85) return;
    lastPush = now;
    try {
      const cur = pick();
      cur.tick?.(now);
      const snap = cur.snapshot();
      const arr = packWebAudioArrayInto(pumpBuffer, snap.left, snap.right);
      weShimCall(rt, (w) => w.__wePushAudio?.(arr));
      // 作者用 setTimeout 主循环时 shim 收不到 rAF we-frame（1748506393 FPS 为 `-`）
      if (frameClock && now - frameClock.last > 200) markFrame(rt, now);
    } catch {
      /* 忽略单帧失败 */
    }
  };
  raf = requestAnimationFrame(tick);
  const prev = rt.sceneCleanup;
  rt.sceneCleanup = () => {
    cancelAnimationFrame(raf);
    try {
      prev?.();
    } catch {
      /* 忽略 */
    }
  };
}

/** 模拟 / 外部 Now Playing → shim Media*Listener（仅变化时推送） */
function startMediaPump(rt: Runtime, driver: WebMediaDriver | null) {
  if (!driver) return;
  // 与音频泵同理：setMedia() 常在 mount() 之后才调用，装配期定死 driver
  // 会让后装的 Now Playing 源永远推不进 iframe。逐帧选当前生效的那个。
  const pick = (): WebMediaDriver => (rt.mediaSource as WebMediaDriver | null) ?? driver;
  let raf = 0;
  let lastMedia: Record<string, unknown> | null = null;
  let lastTick = 0;
  const tick = (now: number) => {
    raf = requestAnimationFrame(tick);
    if (rt.paused || !rt.iframe) return;
    if (now - lastTick < 200) return; // 媒体进度按整秒 diff，200ms 足够
    lastTick = now;
    try {
      const cur = pick();
      // update 在宿主注入源上是可选的（外部事件驱动的实现不需要按帧推进）
      cur.update?.(now / 1000);
      lastMedia = pushMediaDiff(rt, lastMedia, cur.snapshot);
    } catch {
      /* 忽略单帧失败 */
    }
  };
  raf = requestAnimationFrame(tick);
  const prev = rt.sceneCleanup;
  rt.sceneCleanup = () => {
    cancelAnimationFrame(raf);
    try {
      prev?.();
    } catch {
      /* 忽略 */
    }
  };
}

function installWebCtl(rt: Runtime) {
  rt.sceneCtl = {
    pause() {
      rt.paused = true;
      weShimCall(rt, (w) => w.__weSetPaused?.(true));
    },
    resume() {
      rt.paused = false;
      weShimCall(rt, (w) => w.__weSetPaused?.(false));
    },
    applyUserProperties(props) {
      const flat: Record<string, unknown> = { ...(rt.liveUserProps ?? {}) };
      for (const [k, v] of Object.entries(props ?? {})) {
        const val = v && typeof v === "object" && "value" in (v as object) ? (v as { value: unknown }).value : v;
        flat[k] = val;
      }
      rt.liveUserProps = flat;
      weShimCall(rt, (w) => w.__weApplyProps?.(props));
    },
  };
}

function isSameOriginUrl(url: string): boolean {
  try {
    return new URL(url, location.href).origin === location.origin;
  } catch {
    return false;
  }
}

function projectPropertiesToWire(project: unknown): Record<string, { value: unknown }> {
  const props = (project as { general?: { properties?: Record<string, unknown> } } | null)?.general
    ?.properties;
  if (!props || typeof props !== "object") return {};
  const out: Record<string, { value: unknown }> = {};
  for (const [name, def] of Object.entries(props)) {
    if (!def || typeof def !== "object" || typeof (def as { type?: unknown }).type !== "string") continue;
    // 空 file 也要下发：作者常用 `'object' == typeof p[name]` 才进 setSingleVideo
    // （1747779570 随即硬编码 files/wallpaper.webm）。`url("file:///"+value)` 变成
    // file:/// 由 shim 改写，不要在这里 continue 跳过。
    // 无 value 键的 file/directory 同样按 "" 下发：官方全量属性表总是含 value
    // （827982449 作者直接 `properties.customimage.value = ""`，缺对象即 TypeError）。
    const raw = (def as { value?: unknown }).value;
    const type = (def as { type: string }).type.toLowerCase();
    if (raw === null || raw === undefined) {
      if (type === "file" || type === "directory") {
        out[name] = { value: "" };
        continue;
      }
      if (!("value" in (def as object))) continue;
    }
    out[name] = { value: raw };
  }
  return out;
}

/** 与入口 HTML 同目录的 project.json → 默认属性表（WE 挂载时必调一次全量 applyUserProperties） */
async function fetchProjectWire(entryUrl: string): Promise<Record<string, { value: unknown }>> {
  try {
    const projUrl = new URL("project.json", new URL(entryUrl, location.href));
    const r = await fetch(projUrl.href, { credentials: "same-origin" });
    if (!r.ok) return {};
    return projectPropertiesToWire(await r.json());
  } catch {
    return {};
  }
}

function mergeLiveIntoWire(
  defaults: Record<string, { value: unknown }>,
  live: Record<string, unknown> | undefined,
): Record<string, { value: unknown }> {
  const out = { ...defaults };
  if (live) {
    for (const [k, v] of Object.entries(live)) out[k] = { value: v };
  }
  return out;
}

/**
 * 挂载网页壁纸。
 *
 * 同源入口（测试台 /web/…）：**必须**用原始 URL。blob 页 origin 为 null，
 * Spine/WebGL 贴图相对 <base> 变跨域 → texImage2D 失败（3361256119 典型）。
 * shim 由 host 在 HTML 响应里注入（见 host/we-web-html.mjs）。
 *
 * 跨源入口：fetch HTML → 改写注入 → blob（相对资源靠 <base>；WebGL 贴图可能仍受限）。
 * fetch 失败则退回裸 src。
 *
 * 挂载前拉 project.json 全量默认属性：工坊脚本常把初始化放在 applyUserProperties
 * （3361256119 的 addImage / logo_nikke），不下发则只剩 style.css 里缺失的 background.png。
 */
export function mountWeb(rt: Runtime, cfg: WallpaperConfig) {
  clear(rt);
  rt.cfg = cfg;
  const container = resolveContainer(rt, cfg);
  if (!container) {
    reportDiag(rt, cfg, "网页壁纸：无可用容器");
    rt.onError?.(new Error("网页壁纸：无可用容器"));
    return;
  }
  const entry = cfg.src ?? "";
  if (!entry) {
    reportDiag(rt, cfg, "网页壁纸：缺少 src");
    rt.onError?.(new Error("网页壁纸：缺少 src"));
    return;
  }

  installWebCtl(rt);

  type WebCfgExt = WallpaperConfig & {
    _webAudio?: WebAudioDriver | null;
    _webMedia?: WebMediaDriver | null;
  };
  const cfgExt = cfg as WebCfgExt;
  // 注入源（rt.audioBridge）的优先判定在 startAudioPump 里**逐帧**做，
  // 这里只决定「没有注入时用谁」：_webAudio=null 或 rt.audioDisabled
  // （MountOptions.audio:null）表示显式禁用音频，此时连泵都不启。
  const audioDriver: WebAudioDriver | null =
    cfgExt._webAudio === null || rt.audioDisabled
      ? null
      : (cfgExt._webAudio ?? defaultAudioDriver());
  // 注入源（rt.mediaSource）的优先判定同样在 startMediaPump 里逐帧做，
  // 这里只决定「没有注入时用谁」：_webMedia=null 或 rt.mediaDisabled 表示禁用。
  const mediaDriver: WebMediaDriver | null =
    cfgExt._webMedia === null || rt.mediaDisabled
      ? null
      : (cfgExt._webMedia ?? defaultMediaDriver());

  const finishBare = (why: string) => {
    reportDiag(rt, cfg, `网页壁纸 shim 注入失败（${why}），退回裸 iframe`);
    attachIframe(rt, cfg, container, entry, { injected: false });
    startAudioPump(rt, null);
    startMediaPump(rt, null);
    // 裸 iframe 下两个泵都不启、shim 的 we-frame 打点也没有，帧率计从此没有
    // 任何输入 —— stats 会**恒为 {fps:0, running:false}**，即使画面明明在动，
    // 调用方据此判活会误判成"挂了"。这里用自己的 rAF 打点：跨源文档拿不到
    // 作者真实帧率，报的是"壁纸仍在运行"这一事实（按渲染节流上限计）。
    let beat = 0;
    const tick = (now: number) => {
      if (!rt.iframe) return; // 已拆除
      beat = requestAnimationFrame(tick);
      if (rt.paused) return;
      markFrame(rt, now);
    };
    beat = requestAnimationFrame(tick);
    (rt.wallpaperDisposers ??= []).push(() => cancelAnimationFrame(beat));
  };

  const frameClock = { last: 0 };
  // 系统实况（cfg.liveSystem）：麦克风采集是异步的（getUserMedia 要用户授权），
  // 不能阻塞泵启动 —— 泵先按默认源跑，授权通过后回填这个持有槽，
  // pick() 逐帧读它，下一帧就切到真实麦克风。
  const liveHold: { driver: WebAudioDriver | null } = { driver: null };
  const startPumps = () => {
    startAudioPump(rt, audioDriver, frameClock, liveHold);
    startMediaPump(rt, mediaDriver);
    if (cfg.liveSystem && audioDriver) {
      // 释放槽**同步登记**，不能等 await 回来再挂：getUserMedia 会阻塞在系统
      // 授权弹窗上，时长不可控。若这期间用户换了壁纸，clear() 早已跑过，
      // 之后再挂的清理没人会调 —— 麦克风流不停、浏览器录音指示一直亮。
      const liveSlot: { handle: { dispose(): void } | null; dead: boolean } = {
        handle: null,
        dead: false,
      };
      (rt.wallpaperDisposers ??= []).push(() => {
        liveSlot.dead = true;
        liveHold.driver = null;
        try {
          liveSlot.handle?.dispose();
        } catch {
          /* 忽略 */
        }
        liveSlot.handle = null;
      });
      void (async () => {
        try {
          const live = await startLiveSystem({ origin: location.origin });
          // 授权期间已被拆掉：立刻释放，不要挂上去
          if (liveSlot.dead) {
            try {
              live.dispose();
            } catch {
              /* 忽略 */
            }
            return;
          }
          liveSlot.handle = live;
          const st = live.status();
          if (st.audio === "mic") {
            liveHold.driver = liveAudioDriver(live);
            reportDiag(rt, cfg, "liveSystem: 网页壁纸音频改用麦克风");
          } else {
            reportDiag(rt, cfg, `liveSystem: 麦克风不可用（${st.audio}），网页壁纸沿用模拟源`);
          }
        } catch (e) {
          reportDiag(rt, cfg, `liveSystem: 启动失败，网页壁纸沿用模拟源 (${(e as Error)?.message ?? e})`);
        }
      })();
    }
  };

  void (async () => {
    const defaults = await fetchProjectWire(entry);
    const wire = mergeLiveIntoWire(defaults, rt.liveUserProps);
    rt.liveUserProps = Object.fromEntries(Object.entries(wire).map(([k, w]) => [k, w.value]));

    if (isSameOriginUrl(entry)) {
      attachIframe(rt, cfg, container, entry, { injected: true, frameClock });
      startPumps();
      const f = rt.iframe;
      f?.addEventListener(
        "load",
        () => {
          let hasShim = false;
          weShimCall(rt, (w) => {
            hasShim = typeof w.__weSetPaused === "function";
          });
          if (!hasShim) {
            reportDiag(
              rt,
              cfg,
              "网页壁纸：同源入口未检测到 WE shim（host 未注入？）；Spine 类壁纸请确认 /web/ HTML 改写",
            );
          }
        },
        { once: true },
      );
      return;
    }

    try {
      const res = await fetch(entry, { credentials: "same-origin" });
      if (!res.ok) {
        finishBare(`HTTP ${res.status}`);
        return;
      }
      const html = await res.text();
      if (hasBlockingCsp(html)) {
        finishBare("CSP 阻止 inline script");
        return;
      }
      const rewritten = rewriteHtml(html, shimSource, {
        baseHref: entryDirUrl(entry),
        seedScript: buildSeedScript(wire, cfg.sceneFps, cfg.muted === false ? 1 : 0),
      });
      const blob = new Blob([rewritten], { type: "text/html;charset=utf-8" });
      const blobUrl = URL.createObjectURL(blob);
      attachIframe(rt, cfg, container, blobUrl, { blobUrl, injected: true, frameClock });
      startPumps();
    } catch (e) {
      finishBare(e instanceof Error ? e.message : String(e));
    }
  })();
}

/** 库入口：带可选 Audio / Media / 属性的网页挂载 */
export function mountWebWithOptions(
  rt: Runtime,
  cfg: WallpaperConfig,
  opts?: {
    audio?: { snapshot(): { left: ArrayLike<number>; right: ArrayLike<number> } } | null;
    media?: WebMediaDriver | null;
    properties?: Record<string, unknown>;
  },
) {
  if (opts?.properties) {
    rt.liveUserProps = { ...opts.properties };
  }
  const cfg2 = cfg as WallpaperConfig & {
    _webAudio?: WebAudioDriver | null;
    _webMedia?: WebMediaDriver | null;
  };
  if (opts && "audio" in opts) {
    if (opts.audio == null) cfg2._webAudio = null;
    else {
      cfg2._webAudio = {
        snapshot: () => opts.audio!.snapshot(),
      };
    }
  }
  if (opts && "media" in opts) {
    cfg2._webMedia = opts.media ?? null;
  }
  mountWeb(rt, cfg2);
}
