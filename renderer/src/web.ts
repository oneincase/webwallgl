// 网页壁纸：sandbox iframe + 加载前注入 WE shim + 音频/属性泵 + sceneCtl 对齐
import {
  clear,
  markFrame,
  reportDiag,
  type Runtime,
} from "./shell";
import type { WallpaperConfig } from "./types";
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

function vecToCss(v: { x?: number; y?: number; z?: number } | null | undefined): string {
  if (!v) return "rgb(128,128,128)";
  const r = Math.round(Math.max(0, Math.min(1, Number(v.x) || 0)) * 255);
  const g = Math.round(Math.max(0, Math.min(1, Number(v.y) || 0)) * 255);
  const b = Math.round(Math.max(0, Math.min(1, Number(v.z) || 0)) * 255);
  return `rgb(${r},${g},${b})`;
}

/** 给网页 MediaThumbnailListener 一张 data URL 封面（语料读 event.thumbnail） */
function thumbDataUrlFromSnap(snap: {
  primaryColor?: { x?: number; y?: number; z?: number };
  secondaryColor?: { x?: number; y?: number; z?: number };
}): string {
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
  update(tSec: number): unknown;
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
) {
  if (!driver) return;
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
      driver.tick?.(now);
      const snap = driver.snapshot();
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
  let raf = 0;
  let lastMedia: Record<string, unknown> | null = null;
  let lastTick = 0;
  const tick = (now: number) => {
    raf = requestAnimationFrame(tick);
    if (rt.paused || !rt.iframe) return;
    if (now - lastTick < 200) return; // 媒体进度按整秒 diff，200ms 足够
    lastTick = now;
    try {
      driver.update(now / 1000);
      lastMedia = pushMediaDiff(rt, lastMedia, driver.snapshot);
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
  const audioDriver: WebAudioDriver | null =
    cfgExt._webAudio === null ? null : (cfgExt._webAudio ?? defaultAudioDriver());
  const mediaDriver: WebMediaDriver | null =
    cfgExt._webMedia === null ? null : (cfgExt._webMedia ?? defaultMediaDriver());

  const finishBare = (why: string) => {
    reportDiag(rt, cfg, `网页壁纸 shim 注入失败（${why}），退回裸 iframe`);
    attachIframe(rt, cfg, container, entry, { injected: false });
    startAudioPump(rt, null);
    startMediaPump(rt, null);
  };

  const frameClock = { last: 0 };
  const startPumps = () => {
    startAudioPump(rt, audioDriver, frameClock);
    startMediaPump(rt, mediaDriver);
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
