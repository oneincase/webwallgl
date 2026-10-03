// 场景壁纸：mountScene 装配全链路（parse → assets → rAF）。
import { clear, effectiveDpr, effectiveUserVolume, FrameGate, markFrame, normalizeFit, occlPaused, occlusionCfgOf, ownSceneDebugGlobals, readText, reapplyVolume, reportDiag, resourceScaleFor, resourceScaleForNormal, syncCanvasSize, tickOcclusion, type Runtime } from "./shell";
import { classifyDiag } from "./diag-level";
import { occlusionFpsCap, roiWorldRects, type WorldRect } from "./occlusion";
import { estimateGpuBytes as estimateGpuBytesPure, footprintTarget, isSmallTexture, layerFootprintPx, looksOpaque as looksOpaquePure, pickMipLevel as pickMipLevelPure, resourcesOff, scaleFrames, targetLong, texResScale } from "./resource-scale";
import { httpSource, workshopIdFromSourceKey } from "./api/source";
import type { Source } from "./api/types";
import { createLoopingVideo } from "./video-loop";
import { SKIP_3D_MODELS, SKIP_COMPONENTS, SKIP_PARTICLES, SKIP_SCENE_EFFECTS, SKIP_TEXT, TEXT_EM_SCALE } from "./types";
import type { WallpaperConfig } from "./types";
import {
  applyAutoQuality,
  createAdaptiveQuality,
  createAdaptiveVideoScale,
  nextVideoScale,
  normalizeVideoTexScale,
  normalizeQuality,
  particleQualityScale,
  postFboCapFactor,
  softwareDprCap,
  type ResolvedQuality,
} from "./quality";
import { isSoftwareRenderer } from "./gpu-probe";
import {
  bakeCacheKey,
  bitmapToPngBlob,
  createBakeQueue,
  defaultBakeCache,
  shouldBakeEmbedded,
  type BakeCache,
  type BakeStats,
} from "./bake-cache";
import { startLiveSystem, rasterizeArtwork, sampleArtworkPalette, type LiveSystemHandle } from "./live-system";
import { createBgmAnalyser, mergeBgmBands } from "./bgm-analyser";
import { createSpectrumCalibrator } from "./audio-calibrate";
import { installLocalAssets, ensureLocalAsset, fetchLocalAssetFile } from "./local-assets";
import { WE_SHADER_HEADERS } from "../vendor/we-scene/headers";
import { WE_BUILTIN_SHADERS } from "../vendor/we-scene/shaders-builtin";
import { fitWindow, coverContentBounds, layerParallaxOffset, applyCameraZoom, cameraZoomOf } from "../vendor/we-scene/render/math.js";
import { pkg, tex, scn, eff, rnd, particles, ptex, sysTex, gtex, patTex, mdl, wtext, wtimers, media, mediaButtons, system, anim, camPath as camPathLib, pointerLib, hitTest, cursorDispatch, audioMod } from "./vendor";
import {
  flattenUserProperties,
  mergeUserPropertyValues,
  resolveUserProps,
  boundUserName,
} from "../vendor/we-scene/scene/user-props.js";
import { sanitizeFontForBrowser } from "../vendor/we-scene/render/font-sanitize.js";
import { decodeTexImageBitmap, resampleRgba } from "./tex-decode";

/**
 * [we-scene patch 2026-09-28] 平行光强度 → 漫反射系数的标定常数。
 *
 * WE 的 3D 网格着色（LightV1）里，平行光的贡献 ≈ color × intensity × N·L × K。
 * K 由作者素材回归：3281559867 的 `Scene Light` intensity = 2.1，受光面实测
 * ≈ 反照率 × 1.2，背光面 = 反照率 × ambientcolor(0.6078)；解 0.6078 + 2.1 × N·L × K = 1.2
 * 且该面法线朝上（N·L = 光向的 y 分量 ≈ 0.725）⇒ K ≈ 0.39。取 1/π ≈ 0.318 会偏暗约
 * 10%（1.09 vs 1.20），这里按实测取 0.4 —— 与 ambient 一样，属于「用作者出帧标定的
 * 经验口径」，不是引擎常数。改这张的观感前请先重量一遍墙/地两块。
 */
const SCENE_LIGHT_K = 0.4;

// WE 的 systemfont_* 内置字体 → 本机系统字体栈（WE 桌面端映射 Windows 系统字体，
// macOS/Linux 上按近似度回退；都带 sans-serif 兜底，不命中也只是字形差异）。
export const SYSTEM_FONT_FAMILIES: Record<string, string> = {
  systemfont_segoe: "'Segoe UI', 'Helvetica Neue', Arial, sans-serif",
  systemfont_arial: "Arial, 'Helvetica Neue', sans-serif",
  systemfont_verdana: "Verdana, Geneva, sans-serif",
  systemfont_tahoma: "Tahoma, Geneva, sans-serif",
  systemfont_timesnewroman: "'Times New Roman', Times, serif",
  systemfont_georgia: "Georgia, 'Times New Roman', serif",
  systemfont_couriernew: "'Courier New', Courier, monospace",
  systemfont_trebuchetms: "'Trebuchet MS', 'Helvetica Neue', sans-serif",
  systemfont_impact: "Impact, 'Arial Black', sans-serif",
  systemfont_comicsansms: "'Comic Sans MS', 'Comic Sans', cursive",
  systemfont_sylfaen: "Palatino, 'Times New Roman', serif",
  systemfont_calibri: "Calibri, Carlito, 'Helvetica Neue', sans-serif",
  systemfont_cambria: "Cambria, Georgia, serif",
  systemfont_consolas: "Consolas, 'Courier New', monospace",
  systemfont_microsoftyahei: "'Microsoft YaHei', 'PingFang SC', 'Hiragino Sans GB', sans-serif",
  systemfont_simsun: "SimSun, 'Songti SC', serif",
  systemfont_simhei: "SimHei, 'Heiti SC', sans-serif",
};

// 字体族缓存：FontFace 以 family 名注册进 document.fonts，跨重挂复用避免同名重复注册。
// refs = 正在使用的挂载数：clear 时逐键减一，归零才从 document.fonts 释放——
// 带内嵌字体的壁纸各存几十 KB~几 MB，只增不清会在多壁纸轮播场景无界累积。
export const fontFaceCache = new Map<string, { family: string; refs: number }>();

/**
 * [we-scene patch] WE 语义：visible 属性脚本返回 **number 时折叠成 bool**
 *（≠ 0 = 可见）。真实现住在引擎 render/text.js（foldVisibleReturn），
 * 离线 verifier 才能直接测它而不是复算一份。淡出计时器脚本把同一份
 * `update(value) → mix(value, 0, …)` 同时挂在效果 visible 与 alpha 常量上
 *（3233141951 中音条0上/下），淡出完成时返回精确 0 —— 作者意图是「淡完后隐藏」。
 */
const foldVisibleRet = wtext.foldVisibleReturn as (ret: unknown) => boolean | undefined;

/**
 * [we-scene patch] 对象散字段脚本（P2-1）的真实读写槽：
 * scene.json 字段名与渲染层字段名不总是一致——直接写 layer.maxwidth 没有任何
 * 消费者（文字排版读 textMaxwidth，与关键帧动画 volume/maxwidth/zoom 同族）。
 * volume 还要同步到 HTMLAudio（声音层）；pointsize/maxwidth 是文字布局输入，
 * 下帧 drawText 自动重读；intensity/exponent 是**灯光对象**的参数（场景里
 * `light:"point"` 的对象，见 renderer 的 collectSceneLights），逐帧写回后由
 * 光照着色路径消费。
 */
function scalarFieldSlot(layer: any, field: string): { get: () => number; set: (n: number) => void } {
  if (field === "maxwidth") {
    return {
      get: () => Number(layer.textMaxwidth) || 0,
      set: (n) => { layer.textMaxwidth = n; layer.lastKey = null; },
    };
  }
  if (field === "pointsize") {
    return { get: () => Number(layer.textPointsize) || 0, set: (n) => { layer.textPointsize = n; layer.lastKey = null; } };
  }
  if (field === "volume") {
    return {
      get: () => {
        if (layer.soundprops) return Number(layer.soundprops.volume) ?? 1;
        return Number(layer.volume) || 1;
      },
      set: (n) => {
        const v = Math.max(0, Math.min(1, n));
        if (layer.soundprops) layer.soundprops.volume = v;
        layer.volume = v;
        if (layer.soundCtl?.setVolume) layer.soundCtl.setVolume(v);
      },
    };
  }
  // alpha/brightness/intensity/exponent 等直接读写层字段
  return {
    get: () => Number(layer[field]) || 0,
    set: (n) => { layer[field] = n; },
  };
}

// [we-scene patch] BGM 频谱并入增益。getByteFrequencyData 是 dB 映射线标
// （(dB+100)/70），压缩母带播放时绝大多数频段 ≥0.5（≈-65dB 以上，噪声底都
// 在这之上）——旧增益 ×2 后 `min(1)` 把几乎全部频段钳到 1，音量一开音频响应
// 就是一条满幅直线（静音回落模拟源才正常，用户实测）。增益必须 ≤1 保住动态：
// 低频段偶尔贴 1 属正常可视化行为，中高频随音乐起伏。
const BGM_SPECTRUM_GAIN = 1.0;

/**
 * [we-scene patch] 构造本场景全部脚本共享的 localStorage（P1-2）。
 *
 * WE 语义：同壁纸所有脚本（五个 eval 点）一份、跨会话保留；LOCATION_GLOBAL
 * 跨壁纸共享。库在浏览器里默认把数据落到 window.localStorage，按 source.key
 * 加前缀隔离（不同壁纸互不串），无 window（Node verifier / SSR）时返回 null，
 * makeSandboxStorage 自己退化为进程内 Map。
 *
 * key 可能含 URL 保留字符（"https://x/123"），用 encodeURIComponent 转义后再
 * 拼前缀，避免一个壁纸的 key 成为另一个壁纸前缀的前缀（a/1 与 a/10）。
 */
function createSceneStorage(cfg: WallpaperConfig, sourceKey: string | undefined) {
  if (cfg.storageProvider) {
    return wtext.makeSandboxStorage(cfg.storageProvider.screen, cfg.storageProvider.global);
  }
  let dom: Storage | null = null;
  try {
    dom = typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch {
    // 某些浏览器在隐私模式/文件协议下访问 localStorage 直接抛错
    dom = null;
  }
  if (!dom) return wtext.makeSandboxStorage();
  const ns = "wst:" + (sourceKey ? encodeURIComponent(sourceKey) : "nokey") + ":";
  const gns = "wst:global:";
  const makeDom = (prefix: string) => ({
    get: (k: string) => {
      const v = dom!.getItem(prefix + k);
      return v === null ? null : v;
    },
    set: (k: string, v: string) => dom!.setItem(prefix + k, v),
    remove: (k: string) => dom!.removeItem(prefix + k),
    clear: () => {
      const dead: string[] = [];
      for (let i = 0; i < dom!.length; i++) {
        const k = dom!.key(i);
        if (k && k.startsWith(prefix)) dead.push(k);
      }
      for (const k of dead) dom!.removeItem(k);
    },
    keys: () => {
      const out: string[] = [];
      for (let i = 0; i < dom!.length; i++) {
        const k = dom!.key(i);
        if (k && k.startsWith(prefix)) out.push(k.slice(prefix.length));
      }
      return out;
    },
  });
  return wtext.makeSandboxStorage(makeDom(ns), makeDom(gns));
}

/** djb2：family 名里嵌 key 哈希，防不同壁纸同文件名字体共族误删 */
function fontKeyHash(key: string): string {
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** 逐键减引用；归零才从 document.fonts 删除该族的全部 FontFace 并清缓存键 */
function releaseFontFaces(keys: string[]) {
  for (const key of keys) {
    const entry = fontFaceCache.get(key);
    if (!entry) continue;
    entry.refs--;
    if (entry.refs > 0) continue;
    fontFaceCache.delete(key);
    try {
      const dead: FontFace[] = [];
      document.fonts.forEach((f) => {
        if (f.family === entry.family) dead.push(f);
      });
      for (const f of dead) document.fonts.delete(f);
    } catch {
      /* document.fonts 不可用（老 WebView）就交给 GC */
    }
  }
}

/** 按缓存键缓存已解析的 scene.pkg。暂停恢复 / 改属性不再走网络与解析；
 *  上限「≤2 份且总字节 ≤512MB」：解析后的包（条目字节+模型/动画）单份可达数百 MB，
 *  只按份数上限会让两张巨包常驻 GB 级堆；超限从最旧淘汰（当前键除外）。
 *  键来自 Source.key（HTTP 源即 baseUrl，与旧的 mediaBase/itemId 等价）。 */
const pkgCache = new Map<string, { parsed: any; at: number }>();
const PKG_CACHE_MAX_BYTES = 512 * 1024 * 1024;
let pkgCacheBytes = 0;

function pkgCacheEvict(currentKey: string) {
  while (pkgCache.size > 0 && (pkgCache.size > 2 || pkgCacheBytes > PKG_CACHE_MAX_BYTES)) {
    let oldestKey: string | null = null;
    let oldestAt = Infinity;
    for (const [k, v] of pkgCache) {
      if (k === currentKey) continue;
      if (v.at < oldestAt) {
        oldestAt = v.at;
        oldestKey = k;
      }
    }
    // 只剩当前键还超限：放着（正在用的那一份不能被自己挤掉）
    if (!oldestKey) break;
    const victim = pkgCache.get(oldestKey)!;
    pkgCacheBytes -= victim.parsed.fileSize || 0;
    pkgCache.delete(oldestKey);
  }
}

/**
 * 显式淘汰指定 source.key 的 pkg 缓存（配合实例 destroy 的 releasePkgCache）。
 *
 * 缓存的存在意义是同壁纸的重挂不重新下载（暂停恢复/setRenderDpr/显示器
 * 重载），但宿主**销毁**实例时语义是"这张壁纸我不再要了"——再留一份几百 MB
 * 的解析包就违背直觉，Activity Monitor 里表现为"换了壁纸内存就是不降"。
 * 宿主逐张显式释放，而不是收紧全局上限：多实例页面（同一 key 两个实例）
 * 共享缓存仍然成立，只有明确声明放弃的那个 key 会被清。
 */
export function dropPkgCache(key: string | undefined) {
  if (!key) return;
  const hit = pkgCache.get(key);
  if (!hit) return;
  pkgCacheBytes -= hit.parsed.fileSize || 0;
  pkgCache.delete(key);
}

async function loadParsedPkg(
  rt: Runtime,
  cfg: WallpaperConfig,
  source: Source,
  signal: AbortSignal,
): Promise<any> {
  const cacheKey = source.key;
  if (cacheKey) {
    const hit = pkgCache.get(cacheKey);
    if (hit) {
      hit.at = Date.now();
      reportDiag(rt, cfg, `pkg cache hit: ${hit.parsed.fileSize} bytes`, "info");
      return hit.parsed;
    }
  }
  let pkgBytes: ArrayBuffer | Uint8Array;
  try {
    pkgBytes = await source.scenePkg(signal);
  } catch (e) {
    if (signal.aborted) throw e;
    throw e instanceof Error ? e : new Error(String(e));
  }
  reportDiag(rt, cfg, `pkg body: ${pkgBytes.byteLength} bytes`, "info");
  const bytes = pkgBytes instanceof Uint8Array ? pkgBytes : new Uint8Array(pkgBytes);
  const parsed = pkg.parsePkg(bytes);
  if (!cacheKey) return parsed;
  pkgCache.set(cacheKey, { parsed, at: Date.now() });
  pkgCacheBytes += parsed.fileSize || 0;
  pkgCacheEvict(cacheKey);
  return parsed;
}

export function mountScene(rt: Runtime, cfg: WallpaperConfig) {
  clear(rt);
  // GPU 探测必须在**算 DPR 之前**：软件渲染要把画布压到 SOFTWARE_DPR_CAP，
  // 而画布尺寸在下面几行就定死了（探测本身整页只做一次并缓存，见 gpu-probe）。
  rt.softwareRenderer = isSoftwareRenderer();
  // 库形态：调用方给了 canvas 就画在它上面（可非全屏、可多实例）；
  // 旧形态：自建 canvas 铺满内部 wrap 容器。backing store 按显示尺寸折算：
  // 嵌入式 canvas 用 CSS 尺寸（全屏 canvas 的 clientWidth == innerWidth，等价）。
  const c =
    (cfg.canvas instanceof HTMLCanvasElement ? cfg.canvas : null) ??
    document.createElement("canvas");
  const dpr = effectiveDpr(rt, cfg);
  const vw = c.clientWidth || window.innerWidth || 1;
  const vh = c.clientHeight || window.innerHeight || 1;
  c.width = Math.max(1, Math.round(vw * dpr));
  c.height = Math.max(1, Math.round(vh * dpr));
  if (!(cfg.canvas instanceof HTMLCanvasElement)) {
    c.style.cssText = "position:absolute;inset:0;width:100%;height:100%;";
    rt.wrap?.appendChild(c);
  }
  rt.canvas = c;
  let disposed = false;
  /**
   * 调试钩子开关（§3.4）：页面形态（fullscreen）默认开 —— 那是既有的手工排障工作流；
   * **库实例默认关** —— 库嵌进宿主页时，宿主上的同名全局不该能静默改渲染
   * （`__shaderPatch` 能改写 shader 源，`__noMaterialProps`/`__noBuiltinMatTint` 改材质）。
   * 库调用方要复现 A/B 就传 MountOptions.debugHooks。
   */
  const hooksOn = () => (rt.debugHooks ?? rt.fullscreen) === true;
  // [we-scene patch] 挂载期 console.warn → diag 桥：效果 pass 编译失败等渲染端
  // 告警只走 console.warn（CDP 看不见、vite 日志也收不到），排错全靠盲猜。
  // 桥接 [we-scene] 前缀到 reportDiag，卸载时还原。
  // [we-scene patch] 补丁必须**可嵌套、可乱序卸载**（§3.4）：多实例时后挂的实例在前一个的
  // 补丁之上再包一层。原先卸载一律 `console.warn = origWarn`：
  //   · 先挂的先卸载 → 把后挂实例的补丁一起摘掉（它从此失去 [we-scene] 桥）；
  //   · 旧实例的补丁还会把新实例的日志上报到旧 rt。
  // 现在：还原只在自己仍是**栈顶**时做；已卸载的那层直接透传（disposed 早退）。
  const prevWarn = console.warn;
  const myWarn = (...args: unknown[]) => {
    if (disposed) return prevWarn(...args);
    const s = args
      .map((a) => (typeof a === "string" ? a : String((a as Error)?.message ?? a)))
      .join(" ");
    if (s.includes("[we-scene]")) {
      try {
        reportDiag(rt, cfg, s.slice(0, 300), classifyDiag(s));
      } catch {
        /* 忽略 */
      }
    }
    prevWarn(...args);
  };
  const pkgAbort = new AbortController();
  // 粒子系统注册的 mousemove 监听（控制点跟随鼠标）；卸载时必须摘掉，
  // 否则重挂场景会在 window 上累积监听器，旧回调还持有已释放的 GL 资源。
  let particleCleanup: (() => void) | undefined;
  rt.sceneCleanup = () => {
    disposed = true;
    // 只在**栈顶仍是自己**时还原；已被别人包在外面（或自己早已被绕过）就别动，
    // 否则会把还活着的实例的补丁摘掉。
    if (console.warn === myWarn) console.warn = prevWarn;
    pkgAbort.abort();
    rt.sceneTextUpdate = undefined;
    if (particleCleanup) {
      particleCleanup();
      particleCleanup = undefined;
    }
    // 兜底：若 clear(rt) 因 disposed 早退未走到 renderer.dispose，这里也释放 WebGL 上下文
    if (rt.renderer) {
      rt.renderer.dispose?.();
      rt.renderer = undefined;
    }
  };
  let pendingWire: Record<string, { value: unknown }> | null = null;
  let applyLiveImpl: ((wire: Record<string, { value: unknown }>) => void) | undefined;
  let pauseImpl: (() => void) | undefined;
  let resumeImpl: (() => void) | undefined;
  /** 遮挡暂停（V5）：与用户 pause 共用媒体停启，但不碰 rt.paused。装配期未就绪时静默。 */
  let setOccludedImpl: ((on: boolean) => void) | undefined;
  // 性能设置（抗锯齿/粒子/后处理）热更入口。cfg.quality 是真源：impl 未就绪
  // （渲染器还没建出来）时只写 cfg，装配到建渲染器那步会按 cfg.quality 应用。
  let setQualityImpl: ((q: ResolvedQuality) => void) | undefined;
  /** 视频纹理上传倍率热更入口（画质页「视频纹理清晰度」）。同 setQuality 纪律：
   *  impl 未就绪时只写 cfg，建渲染器那步按 cfg 应用。 */
  let applyVideoScaleImpl: ((v: number) => void) | undefined;
  /** 宿主**请求**的档位（cfg.quality，显式优先判据用）与**实际生效**档位分开存：
   *  自动降档只动后者，getQuality() 读后者 —— 宿主才能看出「我给的 high 为什么没生效」。 */
  const requestedQuality = () => normalizeQuality(rt.cfg.quality);
  rt.sceneCtl = {
    pause() {
      pauseImpl?.();
    },
    resume() {
      resumeImpl?.();
    },
    applyUserProperties(props) {
      if (applyLiveImpl) applyLiveImpl(props);
      else pendingWire = { ...(pendingWire || {}), ...props };
    },
    setQuality(q) {
      rt.cfg.quality = { ...normalizeQuality(rt.cfg.quality), ...(q ?? {}) };
      setQualityImpl?.(normalizeQuality(rt.cfg.quality));
    },
    /** 视频纹理上传倍率（0=自动交给守门，>0 固定）。显式值优先于自动下坡。 */
    setVideoTexScale(scale) {
      rt.cfg.videoTexScale = normalizeVideoTexScale(scale);
      applyVideoScaleImpl?.(rt.cfg.videoTexScale);
    },
    /** 遮挡暂停（V5）：媒体停启走 setOccludedImpl（装配后才有）。 */
    setOccluded(on: boolean) {
      setOccludedImpl?.(on);
    },
  };

  void (async () => {
    try {
      // 资源来源：库形态走 cfg.source；旧形态由 mediaBase/src 合成 HTTP 源
      //（httpSource 内部保留「先试根目录、逐个 try/catch」的 WKWebView 踩坑逻辑）
      const source = cfg.source ?? httpSource(`${cfg.mediaBase}/${cfg.src}`);
      // 贴图烘焙（B3）：内嵌 PNG/JPEG 的预缩放缓存。`bake === false` / `?bake=0` 关闭。
      // 命中只做一次 createImageBitmap（产物是处理完 EXIF 回滚后的最终位图，像素等价）；
      // 未命中走现状路径，并把结果排进后台队列 —— 队列在**首帧之后**才开跑，
      // 所以第一次加载不为编码付代价（那笔钱服务的是下一次加载）。
      const bakeEnabled = cfg.bake !== false;
      const bakeCache: BakeCache | null = bakeEnabled ? defaultBakeCache() : null;
      // 烘焙统计（正式字段）：单一来源，同时喂 __memStats().bake（结构化台账）与
      // reportDiag 的文本行 —— 两处各记各的迟早会漂。
      const bakeStats: BakeStats = {
        enabled: bakeEnabled,
        backend: bakeCache?.backend ?? "off",
        hits: 0,
        misses: 0,
        baked: 0,
        failed: 0,
        bytes: 0,
        ms: 0,
      };
      const bakeQueue = createBakeQueue({
        stats: bakeStats,
        onDrained: () =>
          reportDiag(
            rt,
            cfg,
            `bake: 后台补烘完成 ${bakeStats.baked} 张（失败 ${bakeStats.failed}，产物 ${(bakeStats.bytes / 1e6).toFixed(1)}MB，耗时 ${bakeStats.ms.toFixed(0)}ms）`,
            bakeStats.failed > 0 ? "warn" : "info",
          ),
      });
      if (!cfg.source && (!cfg.mediaBase || !cfg.src)) {
        throw new Error("场景壁纸缺少 mediaBase/src");
      }
      reportDiag(rt, cfg, "mountScene start", "info");
      const parsedPkg = await loadParsedPkg(
rt,
cfg, source, pkgAbort.signal);
      if (disposed) return;

      // project.json（可选；属性表缺失是常态，source.project 返回 null 合法）
      let project: unknown = null;
      try {
        project = (await source.project?.(pkgAbort.signal)) ?? null;
      } catch {
        /* 忽略（含切壁纸 abort） */
      }

      // WebGL2 可用性预检（we-scene 需要 webgl2；用与 createRenderer 相同的属性创建，
      // getContext 幂等，createRenderer 会拿到同一上下文）
      const gl2 = c.getContext("webgl2", {
        premultipliedAlpha: false,
        antialias: false,
        alpha: false,
        preserveDrawingBuffer: true,
      });
      if (!gl2) throw new Error("WEBGL2_UNAVAILABLE");
      // 标记已创建上下文，供 ensureSceneCanvas 复用前检测丢失状态
      c.setAttribute("data-webwallgl-gl", "1");

      // 场景描述条目：常规工程是 scene.json；WE 的 GIF 场景模板工程编译产物
      // 叫 gifscene.json（project.json 的 file 指向 gifscene.json，见 843532366），
      // 少数放进 scenes/ 子目录。**源码工程（官方内置 defaultprojects）的场景文件名
      // 由 project.json.file 指定、名字随意**（audiophile.json / techno.json …），
      // 所以候选表由 scn.sceneEntryCandidates 给出：file 优先，其余四条兜底。
      // getEntry 是精确匹配，逐个候选回退。
      let sceneEntry = null;
      for (const name of scn.sceneEntryCandidates(project) as string[]) {
        const e = pkg.getEntry(parsedPkg, name);
        if (e) {
          sceneEntry = e;
          break;
        }
      }
      if (!sceneEntry) throw new Error("pkg 中没有 scene.json（不是场景壁纸？）");
      const scene = scn.parseScene(JSON.parse(readText(sceneEntry)), project);
      /**
       * 本场景加载过的**材质文档**（materials/*.json），用于解析其中的用户属性绑定。
       *
       * 为什么必须单独收集：`{"user":"名"}` 绑定不只在 scene.json —— 音频条/可视化器的
       * 颜色与透明度常绑在材质文件的 `passes[k].constantshadervalues.X` 上（全库按槽位
       * 统计：`Alpha` 6 张、`color` 11 张）。而 `resolveUserProps` 只在 scene.json 的
       * `objects` 与 `general` 上被调用（parse.js 装配期、applyLiveProps 热更期），材质是
       * **独立文档**、不在 `layer.srcObject` 树里 —— 于是这些绑定从装配到热更**一路都没被
       * 解析过**，表现为「UI 里有滑条（如 Visualizer Transparency），拖动永远无效」。
       *
       * 就地改 `.value` 就够，不需要别的失效机制：材质 pass 的 `constantshadervalues`
       * 以**引用**进到绘制侧（effects-parse 的 `constants: mp.constantshadervalues`、
       * attachLayerMaterialEffect 同理），而渲染器每次绘制都
       * `constMerged = {...mp.constants, ...ov.constantshadervalues}` 现读（见 renderer.js）。
       *
       * 已知仍会滞后的一处（全库无壁纸用到，故不写无法验证的代码）：LIGHTING 层的
       * `layer.lightMetallic/lightRoughness` 是装配期从材质常量抄出来的副本（见下方装配处）。
       * 若将来有壁纸把 metallic/roughness 绑到用户属性，需要在热更里一并刷新那两个字段。
       */
      const materialDocs: any[] = [];
      // A/B 钩子：__noMaterialProps=true 回到改动前行为（材质文档完全不解析）
      const noMaterialProps = hooksOn() && (globalThis as any).__noMaterialProps === true;
      /**
       * [we-scene patch 2026-10-03] `usershadervalues`：把**用户属性**绑到材质 uniform。
       *
       * 语义（方向容易读反，证据见下）：**键 = project.json `general.properties` 的属性名，
       * 值 = shader 里 `// {"material":"名"}` 声明的物性名**。fantasticcar `materials/car/body.json`
       * 写 `{"carbodycolor":"paintcolor","carstripescolor":"paintcolorstripes","schemecolor":"ambientcolor"}`，
       * 而 `car.frag` 声明的物性正是 paintcolor/paintcolorstripes/ambientcolor，
       * `carbodycolor`/`schemecolor` 只在 project.json 的属性表里 —— 两个方向各自成立、
       * 反向不成立。内置 16 工程 51 条绑定全库普查：键 51/51 都是属性名，
       * 值 49/51 命中同名 shader 的物性名（剩 2 条指向官方 genericparticle 的 tint，
       * 由官方头/内置实现消费），且**没有一条与 constantshadervalues 撞名**。
       *
       * 为什么必须做：整个内置官方 3D 组的颜色都靠它 —— 不做的话 shader 用的是注释里
       * 声明的 default（dome 的 `0.315,0.135,0.1125` 深棕、car 的纯白车漆），
       * 与 project.json 里作者调的「背景 #92A8CE / 车漆 #FF0000」毫无关系；
       * 实测 fantasticcar 整场近黑（mean=6）而官方是蓝天空+红车漆。
       *
       * 实现方式：注入 `{user: <属性名>}` 包装而不是当场取值 —— resolveUserProps 会
       * 就地解成现值（下游 setConstant 读 `.value`），而包装本身留在文档里，
       * 于是 applyLiveProps 的「材质文档重解」那一步能继续跟随属性热更
       * （写死数值就会在用户拖滑条后失效）。
       *
       * 已有的同名常量不覆盖：编辑器同时写了 `constantshadervalues` 时应以显式值为准
       * （本机语料 0 例，属防御）。比较大小写不敏感 —— bindConstants 的物性名匹配就是
       * 大小写不敏感的（见 renderer 的 indexMatMetaLower）。
       */
      const applyUserShaderValues = (doc: any): void => {
        const passes = Array.isArray(doc?.passes) ? doc.passes : [];
        for (const pass of passes) {
          const usv = pass && typeof pass === "object" ? pass.usershadervalues : null;
          if (!usv || typeof usv !== "object") continue;
          const csv = (pass.constantshadervalues = pass.constantshadervalues || {});
          const taken = new Set(Object.keys(csv).map((k) => k.toLowerCase()));
          for (const [propName, matName] of Object.entries(usv)) {
            if (typeof matName !== "string" || !matName) continue;
            if (taken.has(matName.toLowerCase())) continue;
            csv[matName] = { user: propName };
            taken.add(matName.toLowerCase());
          }
        }
      };
      const registerMaterialDoc = (doc: any) => {
        if (noMaterialProps || !doc || typeof doc !== "object") return doc;
        materialDocs.push(doc);
        applyUserShaderValues(doc);
        resolveUserProps(doc, (scene as any).properties || {}, 0);
        return doc;
      };
      /** 读一份材质文档（登记 + 解析其中的 {user} 绑定）。
       *  [we-scene patch] 用**容忍尾逗号**的解析：WE 自己的数据里普遍带尾逗号
       *  （fantasticcar/materials/car/glass.json 就是），严格 JSON.parse 会让
       *  整个模型图层被丢弃（「model 'Car' 失败」）。与效果链同一实现。 */
      const readMaterialDoc = (entry: Uint8Array) => registerMaterialDoc(eff.parseJsonTolerant(readText(entry)));
      /**
       * `generic4` 材质的 color/alpha/brightness 常量折入图层（渲染侧每帧活读，见 renderer
       * 的 color4 注释）。官方 generic4.frag 里这三个常量是**无条件**应用的，而该 shader
       * 没有 genericimage 那套 `#ifdef VERSION … g_Color4` 分支 —— 这类图层的颜色在 WE 里
       * 就靠材质常量承载。本仓库用自己的替身着色器、此前只读 layer.color/brightness/alpha，
       * 于是这些常量被整片忽略（全库 263 处 color + 27 处 brightness：EmMumbiesEye 的红眼
       * `1 0 0`、EfIceCubeWarp 的浅蓝 `0.427 0.745 1`、sun 的 brightness=10、行星的 2）。
       *
       * 只认 generic4：genericimage2/3 的 Brightness/Alpha 属于 `#ifndef VERSION` 旧分支，
       * 与 g_Color4（本仓库实现的那条）**互斥**，照折会双重相乘；genericimage4 恒用 g_Color4。
       *
       * 挂**节点**而非折成数值：热更时 resolveUserProps 就地改 .value，渲染侧每帧现读，
       * 属性热更自动生效，不需要「记原值再重折」那套簿记。
       *
       * 两条材质链都要挂：`o.image → models/*.json → material`，以及
       * `o.model → *.mdl → materialPath`（后者才是 .mdl 网格层，3281559867 有 158 层走这条）。
       */
      const matTintNum = (node: unknown, idx: number, dflt: number): number => {
        const raw = node && typeof node === "object" && "value" in (node as object) ? (node as any).value : node;
        if (raw === undefined || raw === null) return dflt;
        if (typeof raw === "number") return Number.isFinite(raw) ? raw : dflt;
        const parts = String(raw).trim().split(/[\s,]+/);
        const v = Number(parts[idx] !== undefined ? parts[idx] : parts[0]);
        return Number.isFinite(v) ? v : dflt;
      };
      /**
       * 把 `generic4` 材质常量 color/alpha/brightness **烘进图层自身字段**（保留基准值
       * 供热更重折，见 applyLiveProps 的 matTint 重折）。
       *
       * 为什么烘字段而不是在渲染侧折：MDL 网格层走 `drawPuppetDirect → puppetDrawFn`，
       * 颜色在那里算，**不读 renderLayer 的 color4**；copy / lit / puppet 各有一套。
       * 逐条绘制路径去折必然漏（实测先在 color4 折：`gl.uniform4f` 下发的颜色元组两臂
       * 完全一致，材质色一个都没出现）。图层字段是所有路径的公共输入，一处即可。
       */
      const attachBuiltinMatTint = (layer: any, material: any) => {
        if (hooksOn() && (globalThis as any).__noBuiltinMatTint) return;
        if (!layer || layer.matTint) return;
        const pass0 = material && material.passes && material.passes[0];
        if (!pass0) return;
        const cv = pass0.constantshadervalues;
        if (!cv || typeof cv !== "object") return;
        const sh = String(pass0.shader || "");
        // 哪条分支由材质的 `combos.version` 选（官方 genericimage* 里是
        // `#ifndef VERSION` 旧分支 / `#else` g_Color4 新分支；WE 自带内置材质模板写的是
        // `"combos": {"version": 2}`，即**只有写了 version:2 才走 g_Color4**）。
        // 全库内置 albedo 材质 pass：无 version 的 2623 个、version=2 的 1334 个 ——
        // 也就是多数壁纸在 WE 里走的是「材质 Brightness/Alpha 生效」那条。
        let ver: number | null = null;
        for (const k of Object.keys((pass0 as any).combos || {})) {
          if (k.toLowerCase() === "version") ver = Number((pass0 as any).combos[k]);
        }
        // 可折的槽位按 shader 分：
        //  · generic4：color/alpha/brightness **无条件**生效（该 shader 根本没有 g_Color4 分支）
        //  · genericimage / genericimage2 / genericimage3 的 **v1**（无 version 或 <2）：
        //    只有 alpha/brightness（旧分支就是这么乘的），且这类 shader 没有 color 载体；
        //    version>=2 走 g_Color4（层色×亮度），材质这两个常量不生效 → 不能折（会双重相乘）
        const v1 = ver === null || ver < 2;
        let allow: string[] = [];
        if (sh === "generic4") allow = ["color", "alpha", "brightness"];
        else if (v1 && /^generic(image)?[123]?$/i.test(sh)) allow = ["alpha", "brightness"];
        if (!allow.length) return;
        const nodes: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(cv)) {
          const kl = k.toLowerCase();
          if (allow.includes(kl)) nodes[kl] = v;
        }
        if (!Object.keys(nodes).length) return;
        // 基准值只记一次（重折时从这里出发，避免反复相乘）
        layer.tintBase = {
          color: [(layer.color?.[0] ?? 1), (layer.color?.[1] ?? 1), (layer.color?.[2] ?? 1)],
          alpha: layer.alpha === undefined ? 1 : layer.alpha,
          brightness: layer.brightness === undefined ? 1 : layer.brightness,
        };
        layer.matTint = nodes;
        applyBuiltinMatTint(layer);
      };
      /** 按当前材质常量值重算图层字段（装配期一次 + 每次热更） */
      const applyBuiltinMatTint = (layer: any) => {
        const mt = layer && layer.matTint;
        const base = layer && layer.tintBase;
        if (!mt || !base) return;
        const tr = matTintNum(mt.color, 0, 1);
        const tg = matTintNum(mt.color, 1, 1);
        const tb = matTintNum(mt.color, 2, 1);
        const tBright = matTintNum(mt.brightness, 0, 1);
        const tAlpha = matTintNum(mt.alpha, 0, 1);
        layer.color = [base.color[0] * tr, base.color[1] * tg, base.color[2] * tb];
        layer.brightness = base.brightness * tBright;
        layer.alpha = base.alpha * tAlpha;
      };
      // 宿主覆盖清屏色。场景作者按「铺满 PC 全屏」设 clearcolor，不少填的是浅灰；
      // 手机竖屏用 contain 适配 16:9 场景时，上下留白会露出这块浅灰，像是渲染坏了。
      // 宿主传 "0 0 0" 即可把留白压成中性黑。
      if (cfg.clearColor) {
        const g = ((scene as any).general ??= {});
        g.clearcolor = cfg.clearColor;
        g.clearenabled = true;
      }
      {
        const zRaw = (scene as any).general?.zoom
        const zVal = zRaw && typeof zRaw === "object" ? Number(zRaw.value) : Number(zRaw)
        ;(scene as any).cameraTransforms = {
          zoom: Number.isFinite(zVal) && zVal > 0 ? zVal : 1,
        }
      }
      // 脚本 / 效果常量 / 文字共用这一份 live 对象。热更时就地改字段再
      // applyUserProperties(changed)，沙箱 engine.userProperties 是同一引用。
      const liveUserProps: Record<string, unknown> = flattenUserProperties(
        (scene as any).properties || {},
      ) as Record<string, unknown>;
      rt.liveUserProps = liveUserProps;
      // [we-scene patch 3243449890] 宿主**在装配期就下发**的属性值要先落进属性表。
      // 装配末尾的 applyLiveProps(pendingWire) 只做图层/脚本/常量那一轮传播，而
      // 「用户图片槽」的贴图预载（loadTexInner 的属性分支）在这之前就跑完了 ——
      // 那时 liveUserProps 还是作者默认值（scenetexture / file 一律 ""），于是**带默认
      // 覆盖启动**（用户上次选的图已存盘）也按空值加载，画面停在作者原槽贴图，
      // 直到用户再动一次属性才可能生效。这里先做一次纯值合并（就地改
      // scene.properties[].value 与 liveUserProps），预载与装配期的 resolveUserProps
      // 就都读到用户值；末尾那轮照旧跑（幂等，脚本的 applyUserProperties 仍只派发一次）。
      if (pendingWire) {
        mergeUserPropertyValues((scene as any).properties || {}, liveUserProps, pendingWire);
      }
      // 脚本写 thisLayer.visible 时改 visibleSelf，再整树重算有效 visible。
      // 见 parse.recomputeLayerVisibility / 3122339805 Eyes·Numbers。
      // 必须在文字/对象脚本装配之前建好，两边 opts 都注入同一引用。
      const recomputeVisibility = () => scn.recomputeLayerVisibility(scene.layers);
      /**
       * 帧内脚本批量写 `visible` 的**合并通道**：写一次只打脏标记，帧内脚本/动画阶段
       * 结束后统一重算一次。
       *
       * 为什么需要：`recomputeLayerVisibility` 是 O(层数) 的重算（重建 id 索引 + 逐层
       * 上溯父链），而脚本里的 `thisLayer.visible = x` / `thisObject.visible = x` 会
       * **逐次**触发它。847 层的 3662790108（672 个对象脚本）实测：稳态 V8 采样里
       * `recomputeLayerVisibility` 自时间 16-18%、proxy 的 `set visible` 5.3%、
       * `makeObjectLayerProxy` 3.1%、GC 3.5% —— 近三成 CPU 花在这条链上。
       *
       * 语义边界（刻意保守）：只有**帧内脚本阶段**（`visibilityDeferred` 为真）才合并，
       * 阶段外（挂载期装配、cursor 回调、显式 `thisScene.recomputeVisibility()`、
       * `markLayerDestroyed`）一律立即重算 —— 那些地方写完就可能被读。
       * 帧内与既有的 `visibilityDirty`（动画写 visibleSelf 走的就是这个）**同一条刷写点**，
       * 所以「脚本改可见性」与「动画改可见性」在本帧内的可见时刻完全一致。
       */
      let visibilityDeferred = false;
      let visibilityPending = false;
      const markVisibilityDirty = () => {
        if (visibilityDeferred) visibilityPending = true;
        else recomputeVisibility();
      };
      // 库化桥接：场景装配完成，报告基本信息（首帧前，onReady 之前）
      if (rt.onSceneInfo) {
        const ortho = (scene as any).general?.orthogonalprojection || {};
        const gw = Number(ortho.width) > 0 ? Number(ortho.width) : c.width;
        const gh = Number(ortho.height) > 0 ? Number(ortho.height) : c.height;
        const layers = (scene.layers as any[]) || [];
        const info = {
          width: gw,
          height: gh,
          layerCount: layers.length,
          hasModels: layers.some((l) => !!l.model),
          hasParticles: layers.some((l) => !!l.particle),
          hasText: layers.some((l) => !!l.text),
        };
        const hook = rt.onSceneInfo;
        rt.onSceneInfo = undefined;
        hook(info);
      }
      const propSandboxes: any[] = [];
      // [we-scene patch] SceneScript localStorage（P1-2）：WE 语义是**按壁纸
      // 共享 + 跨会话持久**。五个 eval 点必须拿到同一份 storage 实例（脚本 A
      // 写、脚本 B 读）。后端优先级：
      //   1) cfg.storageProvider（测试台文件后端 / 自定义宿主）；
      //   2) window.localStorage + 按 source.key 命名空间（库形态默认，跨重挂保留）；
      //   3) 都没有时 makeSandboxStorage 内部退化为进程内 Map。
      // LOCATION_GLOBAL 走不带壁纸命名空间的全局后端（跨壁纸共享）。
      const sceneStorage = createSceneStorage(cfg, source.key);
      // component 对象（真·内置组件，本机库 0 个）暂不渲染；文字对象走完整渲染路径
      if (SKIP_COMPONENTS) {
        scene.layers = scene.layers.filter((l: any) => {
          if (SKIP_COMPONENTS && l.isComponent) return false;
          return true;
        });
      }
      // 暂不应用图层效果（见 SKIP_SCENE_EFFECTS 注释）：清空 effects，避免灰色遮罩/随机多边形
      if (SKIP_SCENE_EFFECTS) {
        for (const l of scene.layers as any[]) {
          l.effects = [];
        }
      }

      const shaderResolver = async (rel: string): Promise<string | null> => {
        const inner = rel.startsWith("shaders/") ? rel : "shaders/" + rel;
        const file = rel.startsWith("shaders/") ? rel.slice("shaders/".length) : rel;
        const e = pkg.getEntry(parsedPkg, inner);
        // [we-scene patch 2026-10-03] **引擎内置 shader 的本仓实现**（F42）：WE 自带
        // （`assets/shaders/**`）而不进 pkg 的那一族，如 `flag`（官方内置工程
        // eagleflag 的图层材质）。放在 local-assets 之前：这条是仓内实现、任何环境
        // 都拿得到（官方素材只在开发机上有），行为才可复现；要拿官方源做逐像素
        // 对照时开 `__noBuiltinShaders`（见下）退到 local-assets 那一档。
        const builtinOff = hooksOn() && (globalThis as any).__noBuiltinShaders === true;
        let src: string | null = e
          ? readText(e)
          : ((WE_SHADER_HEADERS[file] ?? (builtinOff ? undefined : WE_BUILTIN_SHADERS[file])) ?? null);
        // [we-scene patch 2026-10-03] **官方安装素材回退**（F14）：本仓 `WE_SHADER_HEADERS`
        // 是按需**重建的子集**，官方 `common_pbr.h` 一族并不完整。作者的自定义模型/效果
        // shader include 官方头时（fantasticcar `car.frag` 用 `g_SpecularPower`、
        // demon_core `core`/`backgroundsphere` 同理），包内没有、重建集也没有 → GL 编译期
        // 报 `undeclared` → 整个模型退回通用程序（观感是素模）。
        // 这条回退与贴图共用同一条 local-assets 通道（`/api/local-assets/<id>/shaders/...`）：
        // 只在前两条来源都缺时按需取官方源；取不到就保持原行为（null），不引入新失败面。
        if (src == null) {
          try {
            const bytes = await fetchLocalAssetFile(`shaders/${file}`);
            if (bytes && bytes.length) src = new TextDecoder().decode(bytes).replace(/^\uFEFF/, "");
          } catch {
            /* 忽略：拿不到官方素材时行为与本改动前一致 */
          }
        }
        // [we-scene patch] 调试钩子：在控制台改写任意 shader 源，用于定位画面异常。
        //   __shaderPatch = { 'effects/blur_combine': (src) => src.replace(...) }
        // 键可带或不带扩展名。把某个 pass 的输出染成纯色即可判定「这块像素是谁画的」——
        // 定位 2134765860 的纯白矩形时，正是靠它排除了 blur_combine / blend / 音频条
        // 三条线，最后才落到容器合成上。
        const patch = hooksOn() ? (window as unknown as Record<string, any>).__shaderPatch : undefined;
        if (src && patch) {
          const key = file.replace(/\.(frag|vert|h)$/, "");
          const fn = patch[key] || patch[file];
          if (typeof fn === "function") {
            try { const r = fn(src, file); if (typeof r === "string") src = r; } catch {}
          }
        }
        return Promise.resolve(src);
      };
      const renderer = rnd.createRenderer(c, {
        shaderResolver,
        diag: (msg: string) => reportDiag(rt, cfg, `renderer: ${msg}`, classifyDiag(msg)),
        // 效果链 FBO 降采样：0=全质量，0.5≈效果分辨率减半→内存约 1/4。
        // 用全质量：降采样会让「层 alpha 再乘一张羽化 mask」的效果（opacity）在
        // 低分辨率下把过渡带插得更淡，再经后续 waterwaves 的 UV 位移搬移、
        // 最后放大回屏幕，就在网格交界处（如 3113287126 头发与手臂交汇）看到发虚透明。
        // 代价：该场景效果链 FBO 由 3.5MB 升到约 100MB。
        fboCapFactor: 0,
        // 视差公式：默认 legacy（全库）；3233141951 等白名单走 mirage（见 math.js）。
        // cfg.src：测试台 URL ?src=ID；Source API 路径由 mount.ts 从 source.key 回填。
        // 再兜底直接抽 key —— 宿主自建 Source 漏填 src 时也不至于退回 legacy。
        workshopId: cfg.src ?? workshopIdFromSourceKey(cfg.source?.key),
        parallaxFormula: (cfg as { parallaxFormula?: string }).parallaxFormula,
      });
      // 立即登记渲染器：即使后续异步加载中途被 clear(rt)，也能正确释放该 WebGL 上下文
      rt.renderer = renderer;
      if (disposed) return;
      // [we-scene patch] 粒子的 MSAA 接线：绘制目标与 REFRACT 场景捕获都走
      // renderer 的当前状态（aaMode=off 时分别退回默认帧缓冲 / copyTexImage2D，
      // 行为与注入前逐字一致）。模块级注入与 ptex.setParticleTextureProvider 同先例；
      // 卸载时在 particleCleanup 复位，防止悬垂引用上一个渲染器。
      particles.setParticleFrameTargetProvider(() => renderer.getFrameTarget?.() ?? null);
      particles.setParticleSceneCapture((w: number, h: number) => renderer.captureSceneTexture?.(w, h) ?? null);
      {
        const prevCleanup = particleCleanup;
        particleCleanup = () => {
          prevCleanup?.();
          particles.setParticleFrameTargetProvider(null);
          particles.setParticleSceneCapture(null);
        };
      }

      // ---- 音频 / 媒体 / 窗口源 ----
      // 默认确定性模拟（离线可复现）；cfg.liveSystem 时换系统输出频谱 + 宿主 Now Playing。
      const supportsAudioProcessing =
        (project as { general?: { supportsaudioprocessing?: boolean } } | null)?.general
          ?.supportsaudioprocessing !== false;
      const simAudio = audioMod.createSimulatedAudio();
      const simMedia = media.createSimulatedMedia();
      const simWindow = system.createSimulatedWindowTitle();
      // live 在 textures / mediaDriver 就绪后再 start（见下方），这里只占位
      let live: LiveSystemHandle | null = null;
      const liveHold: {
        mediaDriver: { snapshot: any } | null;
        lastSnap: { get: () => any; setHasThumbnail: (v: boolean) => void };
      } = {
        mediaDriver: null,
        lastSnap: {
          get: () => null,
          setHasThumbnail: () => {},
        },
      };
      const audioDriverRef: { current: { snapshot: any; pump: () => void } | null } = {
        current: null,
      };
      // 先按模拟源装配；live 启动后改指向。
      // [1.3.3] 宿主注入源（rt.mediaSource）**每次读取时重新选**，不能在装配时
      // 定死：setMedia() 常在 mount() 之后才调用（宿主的 Now Playing 通道那时
      // 才就绪），定死就意味着后装的源永远不生效——web 侧的泵已经是逐帧 pick，
      // scene 这边漏了，症状是「setMedia 在场景壁纸上没反应」。
      // liveSystem 的系统音频/系统媒体优先级更高（用户显式勾了「系统实况」），
      // 由 liveMediaOverride 承载；两者都没有才回落模拟源。
      // [1.3.17] 壁纸自带音频（脚本显式 play() 的声音层）排在注入源之后、模拟源
      // 之前：音乐壁纸放着自己的歌，MEDIA 面板却只能显示品牌占位曲（3151551777）。
      // WE 官方语义是「自带音频不产生媒体事件」，这里是本仓库的刻意扩展。
      const wallpaperAudio = media.createWallpaperAudioMedia(media.MEDIA_PLAYBACK, media.mediaVec3);
      let liveMediaOverride: any = null;
      // [we-scene patch 2388299037] 封面/元数据优先级：外部真实媒体 > 壁纸自带音频 >
      // 模拟测试源。外部源**没在播**（hasMedia=false，例如系统实况开着但播放器停着）
      // 时不占用驱动位 —— 否则面板会显示一场空，而按优先级应回落到测试源/内置封面。
      const hasLiveMedia = (drv: any) => !!(drv && drv.snapshot && drv.snapshot.hasMedia);
      const currentMediaDriver = (): any =>
        hasLiveMedia(liveMediaOverride) ? liveMediaOverride
        : hasLiveMedia(rt.mediaSource) ? (rt.mediaSource as any)
        : (wallpaperAudio.hasCurrent() ? wallpaperAudio : null) ?? simMedia;
      let windowDriver: any = simWindow;
      // rt.audioDisabled = 调用方 MountOptions.audio:null 显式静音（频谱恒为 0），
      // 与"没设置"区分开：后者要回落模拟源
      const audioSim = { enabled: supportsAudioProcessing && !rt.audioDisabled };
      // 静音（壁纸不支持音频 / __audioMute）必须显式喂全零：GL uniform 数组在
      // 不设置时会**保留上一帧的值**，返回 null 不会让波形落回零位。
      const zero = (n: number) => new Float32Array(n);
      const SILENT_AUDIO = {
        left16: zero(16), right16: zero(16),
        left32: zero(32), right32: zero(32),
        left64: zero(64), right64: zero(64),
        level: 0, silent: true,
      };
      // 宿主注入的频谱源（rt.audioBridge）。宿主只给 64 段左右声道，
      // 32/16 段降采样、level、silent、preL64/preR64 由这里派生，保证快照
      // 与模拟源同构——消费方（shader uniform、粒子、文字脚本）不需要区分来源。
      // 宿主通道当前增益（诊断 __audioStats().host.gain 读它）
      const calibGainRef = { current: 1 };
      const hostAudio = (() => {
        const snapshot = {
          left64: zero(64), right64: zero(64),
          left32: zero(32), right32: zero(32),
          left16: zero(16), right16: zero(16),
          // 未钳位频谱：网页驱动会对它做 gamma 对比扩展。宿主给的已是 0..1
          // 归一化值，没有 pre-GAIN 概念，直接与 left64/right64 共用同一份数据
          preL64: zero(64), preR64: zero(64),
          level: 0,
          silent: true,
        };
        const down = (dst: Float32Array, src: Float32Array) => {
          const g = src.length / dst.length;
          for (let i = 0; i < dst.length; i++) {
            let s = 0;
            const i0 = Math.floor(i * g);
            const i1 = Math.max(i0 + 1, Math.floor((i + 1) * g));
            for (let j = i0; j < i1; j++) s += src[j];
            dst[i] = s / (i1 - i0);
          }
        };
        // [we-scene patch] 真实音频的量级标定：宿主频谱的典型量级（约 0.1~0.3）远低于
        // 作者阈值所依赖的量级（强段均值 0.5~0.8，见 audio-calibrate.ts 头注），
        // 原样透传导致「真实音谱反馈明显弱于内置歌曲」。自适应增益把滚动峰值抬到
        // 目标量级；silent/level 仍按**标定后**的实际画面电平判定，静音段保持静音。
        const calib = createSpectrumCalibrator();
        // 标定器需要帧间隔：pump 每帧调用一次，用墙钟差分（首帧/异常值由
        // 标定器内部钳到 [1/240, 0.25]）。
        let lastPumpMs = 0;
        return {
          active: false,
          snapshot,
          /** 每帧从宿主拉一次。宿主返回 null（未采集/无权限）时置 active=false 回落模拟源 */
          pump() {
            const src = rt.audioBridge?.();
            if (!src || !src.left || !src.right) {
              this.active = false;
              calib.reset();
              return;
            }
            const n = Math.min(64, src.left.length, src.right.length);
            const nowMs = typeof performance !== "undefined" ? performance.now() : Date.now();
            const dtSec = lastPumpMs > 0 ? (nowMs - lastPumpMs) / 1000 : 1 / 60;
            lastPumpMs = nowMs;
            const gain = calib.gainFor(src.left, src.right, n, dtSec);
            calibGainRef.current = gain;
            let sum = 0;
            for (let i = 0; i < n; i++) {
              const l = Math.min(1, (src.left[i] || 0) * gain);
              const r = Math.min(1, (src.right[i] || 0) * gain);
              snapshot.left64[i] = l;
              snapshot.right64[i] = r;
              snapshot.preL64[i] = l;
              snapshot.preR64[i] = r;
              // level 只统计前 48 段：最高的十几段是采样率上限附近的噪声，
              // 计入会让整体响度被底噪抬起来，视觉上"永远在动"
              if (i < 48) sum += l;
            }
            // 宿主给的段数不足 64 时补零，避免残留上一帧数据
            for (let i = n; i < 64; i++) {
              snapshot.left64[i] = 0;
              snapshot.right64[i] = 0;
              snapshot.preL64[i] = 0;
              snapshot.preR64[i] = 0;
            }
            down(snapshot.left32, snapshot.left64);
            down(snapshot.right32, snapshot.right64);
            down(snapshot.left16, snapshot.left64);
            down(snapshot.right16, snapshot.right64);
            snapshot.level = Math.min(1, sum / 48);
            snapshot.silent = snapshot.level < 0.02;
            this.active = true;
          },
        };
      })();
      // 当前生效的音频快照。优先级：宿主注入 > 系统实况（media-bridge）> 内置模拟。
      // 粒子 / 文字脚本 / shader uniform 都从这里取，保证同一帧看到同一份数据。
      const activeAudioSnapshot = () =>
        hostAudio.active
          ? hostAudio.snapshot
          : audioDriverRef.current
            ? audioDriverRef.current.snapshot
            : simAudio.snapshot;
      // 本帧最终频谱（当前源 + BGM 合并），setAudioProvider 与 fillAudioBuffers
      // 都读这一份；无 BGM 时等于 activeAudioSnapshot()。
      let frameAudioSnapshot: any = null;
      renderer.setAudioProvider(() => {
        if (!audioSim.enabled) return SILENT_AUDIO;
        return frameAudioSnapshot || activeAudioSnapshot();
      });
      // 文字脚本 engine.registerAudioBuffers(n) 的共享视图（text.js 惰性创建，每帧重填）
      const audioViews = new Map<number, { left: Float32Array; right: Float32Array; average: Float32Array }>();
      // [we-scene patch] 帧事件的图层级广播表：layer → 该层全部带 animationEvent
      // 的沙箱（官方语义：该层任一动画出事件，这层所有带钩子的脚本都被叫到，
      // 每个拿到的 value 是各自属性现值）。常量动画的事件经共享队列传入。
      const animEventSinks = new Map<any, any[]>();
      const constAnimEventQueue: Array<{ layer: any; events: Array<{ frame: number; name: string }> }> = [];
      const registerAnimEventSink = (layer: any, sink: any) => {
        if (!layer || !sink || !sink.sandbox) return;
        let list = animEventSinks.get(layer);
        if (!list) {
          list = [];
          animEventSinks.set(layer, list);
        }
        list.push(sink);
      };
      // 调试出口：音频状态 / 强制静音（音频响应 A/B 对比验证用）
      (window as unknown as Record<string, unknown>).__audioStats = () => ({
        enabled: audioSim.enabled,
        live: !!audioDriverRef.current,
        // [we-scene patch] 宿主注入通道的可观测性：active=本帧拉到数据、
        // level/bass=**标定后**（真正喂给着色器/脚本的）量级，用于排查
        // 「真实音谱反馈偏弱」（见 audio-calibrate.ts）。
        host: hostAudio.active
          ? {
              active: true,
              level: Math.round(hostAudio.snapshot.level * 1000) / 1000,
              silent: hostAudio.snapshot.silent,
              bass: Math.round(hostAudio.snapshot.left64[2] * 1000) / 1000,
              gain: Math.round(calibGainRef.current * 100) / 100,
            }
          : { active: false },
        level: audioSim.enabled
          ? Math.round((audioDriverRef.current ? audioDriverRef.current.snapshot : simAudio.snapshot).level * 1000) / 1000
          : 0,
        silent: audioSim.enabled
          ? (audioDriverRef.current ? audioDriverRef.current.snapshot : simAudio.snapshot).silent
          : true,
        bass: audioSim.enabled
          ? Math.round((audioDriverRef.current ? audioDriverRef.current.snapshot : simAudio.snapshot).left64[2] * 1000) / 1000
          : 0,
      });
      (window as unknown as Record<string, unknown>).__audioMute = (on: boolean) => {
        audioSim.enabled = !on;
        return audioSim.enabled;
      };
      reportDiag(
        rt,
        cfg,
        `audio: ${audioDriverRef.current ? "live system" : "simulated"} stream, supportsaudioprocessing=${supportsAudioProcessing}`,
        "info",
      );

      // ---- 媒体集成（模拟或实况）----
      // 回调是**事件**不是轮询：只在快照变化时派发。语料里 mediaThumbnailChanged
      // 常写 `anim.stop(); anim.play();`，每帧广播会让动画永远卡在第 0 帧。
      const shortcuts = system.createShortcutHandler((name: string) => {
        reportDiag(rt, cfg, `openUserShortcut: ${name}`, "info");
      });
      // rt.mediaDisabled = 调用方 MountOptions.media:null 显式禁用系统媒体
      const mediaSim = { enabled: !rt.mediaDisabled, override: null as Record<string, unknown> | null };
      // 挂了媒体回调的沙箱（广播表；媒体不做 hit-test，不必按图层索引）
      const mediaHooks: any[] = [];
      // [we-scene patch] 挂了 resizeScreen 的沙箱（画布尺寸变化时统一派发，
      // 含首帧）。文字/对象/效果开关/general 沙箱在装配期就能扫到；效果常量沙箱
      // 是惰性创建的，经 setConstantScriptRuntime 的 onSandbox 回调补登记。
      const resizeHooks = new Set<any>();
      // 0 保证首帧一定派发一次（懒创建的常量沙箱在登记时会立即补一次，见下）
      let lastResizeW = 0;
      let lastResizeH = 0;
      let lastResizeDispatch: { w: number; h: number } | null = null;
      // engine.timeOfDay 当前值（秒级缓存，随真实时钟走，见帧循环）
      let timeOfDayValue = (() => {
        const d = new Date();
        return (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) / 86400;
      })();
      let lastTodSec = -1;
      const registerResizeHook = (sb: any) => {
        if (!sb || !sb.hasResizeHook || typeof sb.callResize !== "function") return;
        if (resizeHooks.has(sb)) return;
        resizeHooks.add(sb);
        // 懒创建的常量沙箱可能晚于首帧才登记：立即补发当前尺寸，与
        // init 内手写 resizeScreen(engine.screenResolution) 的意图一致，
        // 否则它要等到用户真的拖一次窗口才第一次收到正确尺寸。
        if (lastResizeDispatch) {
          try {
            sb.callResize(lastResizeDispatch.w, lastResizeDispatch.h);
          } catch {
            /* callResize 内部有三振熔断 */
          }
        }
      };
      const dispatchResize = (w: number, h: number) => {
        for (const sb of resizeHooks) {
          if (!sb || sb.disabled) continue;
          try {
            sb.callResize(w, h);
          } catch {
            /* callResize 内部已有三振熔断，这里只防一个坏脚本打断其余派发 */
          }
        }
      };
      let lastMediaSnap: any = null;
      /**
       * 已上传到 `$mediaThumbnail` 的封面来源串，用于按变化触发重传。
       * 记「来源」而不是「是否传过」：同一首歌的封面常晚于元信息到达，
       * 换歌后也要能再传一次。解码期间它同时充当取消令牌 —— 异步回来时
       * 若已被后一首歌改写，就丢弃这次解码结果。
       */
      let mediaThumbnailLastSrc: string | undefined;
      liveHold.lastSnap = {
        get: () => lastMediaSnap,
        setHasThumbnail: (v: boolean) => {
          if (lastMediaSnap) lastMediaSnap.hasThumbnail = v;
        },
      };
      // [we-scene patch] 登记必须**带补发**。媒体回调是事件而非轮询，沙箱只能从
      // 回调里知道当前播放态；而效果常量沙箱是惰性创建的（首帧渲染到该 pass 才建），
      // 等它登记进广播表时，首帧那批事件早已派发完、lastMediaSnap 也已追平，
      // 它永远收不到 mediaPlaybackChanged —— 脚本里的 `var ofg = 0`（STOPPED）
      // 就成了永久状态。2938612768 的「歌名/专辑」正是这样：默认占位层与实时层
      // 各挂一份镜像淡入淡出脚本，占位层按「停止态」淡入到 1、实时层淡出到 0，
      // 于是画面永远停在 "Wallpaper Music" / "Name of artist"。
      // 用 diff(null, snapshot) 生成全量事件补给新沙箱，与首帧语义一致。
      const mediaSnapshot = () => currentMediaDriver().snapshot;
      const registerMediaHook = (sb: any) => {
        if (!sb || !sb.hasMediaHook || mediaHooks.includes(sb)) return;
        mediaHooks.push(sb);
        // 建场阶段（首帧 update 之前）快照还是空的，补发只会送一轮「无媒体」；
        // 那批沙箱由首帧的 diff 正常覆盖，这里跳过。只有真正迟到的才需要补。
        if (!mediaSnapshot().hasMedia) return;
        for (const { name, event } of media.diffMediaEvents(null, mediaSnapshot())) {
          try {
            sb.callMedia(name, event);
          } catch {
            /* 沙箱内部已有三振熔断，这里只防止一个坏脚本打断其余登记 */
          }
        }
      };
      (window as unknown as Record<string, unknown>).__mediaStats = () => ({
        enabled: mediaSim.enabled,
        live: !!live,
        hooks: mediaHooks.length,
        title: mediaSnapshot().title,
        artist: mediaSnapshot().artist,
        album: mediaSnapshot().album,
        state: mediaSnapshot().state,
        position: Math.round(mediaSnapshot().position),
        duration: mediaSnapshot().duration,
        hasThumbnail: mediaSnapshot().hasThumbnail,
        lyric: mediaSnapshot().lyricLine,
        primaryColor: mediaSnapshot().primaryColor
          ? [mediaSnapshot().primaryColor.x, mediaSnapshot().primaryColor.y, mediaSnapshot().primaryColor.z]
          : null,
      });
      // 手动覆写快照字段并立即广播（验证「换歌 → 文字/封面/唱针」链路用）
      (window as unknown as Record<string, unknown>).__mediaSet = (patch: Record<string, unknown>) => {
        // 壁纸音频驱动（1.3.17）的快照是 getter 视图，直接 assign 会 TypeError
        try {
          Object.assign(mediaSnapshot(), patch || {});
        } catch {
          reportDiag(rt, cfg, "__mediaSet: 当前媒体快照为只读视图（壁纸音频驱动），覆写跳过", "info");
        }
        const evts = media.diffMediaEvents(lastMediaSnap, mediaSnapshot());
        for (const { name, event } of evts) for (const sb of mediaHooks) sb.callMedia(name, event);
        lastMediaSnap = media.cloneMediaSnapshot(mediaSnapshot());
        return (window as unknown as Record<string, () => unknown>).__mediaStats();
      };
      const dispatchMediaNow = () => {
        const evts = media.diffMediaEvents(lastMediaSnap, mediaSnapshot());
        for (const { name, event } of evts) {
          for (const sb of mediaHooks) {
            try {
              sb.callMedia(name, event);
            } catch {
              /* 单个坏脚本不能打断切歌广播 */
            }
          }
        }
        lastMediaSnap = media.cloneMediaSnapshot(mediaSnapshot());
      };
      // 控制方法在注入源上是**可选**的（宿主可能只提供元数据、不支持反向控制）。
      // 缺失时静默跳过再照常派发一次：壁纸按钮点了没反应好过整个脚本 TypeError 熔断。
      // [we-scene patch 3794460976] 控制源与显示源**分离**（媒体桥接正式接入 / 控制反转）：
      // 显示源按 hasMedia 排优先级（没在播不占驱动位，2388299037），但控制优先交给注入源
      // 本身 —— 没在播时点「播放」要能唤醒真实播放器（测试台 media-bridge / 宿主命令通道），
      // 而不是掉到模拟源去切模拟曲目。选择逻辑在 vendor/media-buttons.js（可离线判据）。
      //
      // 宿主控制面有两条注入路径，都要认：① `setMedia` 源自带控制方法（库 API 的
      // MountOptions.media / 实例 setMedia）；② `__wp.setMediaControl` **单独**注入
      //（iframe 宿主的数据面与控制面生命周期不同：setMedia(null) 之后控制仍在位）。
      const injectedControlSource = (): any => {
        if (mediaButtons.hasMediaControl(rt.mediaSource)) return rt.mediaSource;
        return mediaButtons.hasMediaControl(rt.mediaHostCtl) ? rt.mediaHostCtl : null;
      };
      const controlMediaDriver = (): any =>
        mediaButtons.pickControlDriver(liveMediaOverride, injectedControlSource(), currentMediaDriver());
      const callDriver = (name: "skipNext" | "skipPrevious" | "play" | "pause" | "playPause") => {
        const drv = controlMediaDriver();
        const fn = drv?.[name];
        if (typeof fn === "function") {
          try {
            fn.call(drv);
          } catch (e) {
            reportDiag(rt, cfg, `media ${name} 失败: ${(e as Error)?.message}`, "warn");
          }
        }
        dispatchMediaNow();
        return mediaSnapshot();
      };
      const mediaControl = {
        get snapshot() {
          return mediaSnapshot();
        },
        skipNext: () => callDriver("skipNext"),
        skipPrevious: () => callDriver("skipPrevious"),
        play: () => callDriver("play"),
        pause: () => callDriver("pause"),
        playPause: () => callDriver("playPause"),
      };
      // 公共 API 的 instance.media 转发到这里
      rt.mediaCtl = mediaControl as unknown as Runtime["mediaCtl"];
      (window as unknown as Record<string, unknown>).__mediaControl = mediaControl;
      (window as unknown as Record<string, unknown>).__system = {
        media: mediaControl,
        windowTitle: windowDriver.snapshot,
        shortcuts: shortcuts.last,
        live: null as null | (() => unknown),
      };
      (window as unknown as Record<string, unknown>).__liveSystem = () => ({
        audio: "off",
        media: "offline",
        window: "offline",
      });

      // ---- 统一指针输入 ----
      // 一处监听、四方消费（shader uniform / 相机+对象视差 / 粒子 controlpoint /
      // 脚本 input 与 cursor* 回调）。改动前指针分裂在两处监听器、两套归一化约定，
      // 且渲染器那处**永不移除**（每次重挂载泄漏一个）。详见 render/pointer.js。
      // 库化（第 3 步）：调用方给了 canvas 就把事件挂 canvas、归一化用 canvas
      // 的 CSS 尺寸 —— 嵌入式实例不截获整页指针，坐标才与画面对齐。
      const pointerSrc = pointerLib.createPointerSource(
        cfg.canvas
          ? {
              target: cfg.canvas,
              viewport: () => ({
                w: cfg.canvas!.clientWidth || window.innerWidth || 1,
                h: cfg.canvas!.clientHeight || window.innerHeight || 1,
              }),
            }
          : {},
      );
      renderer.setPointerProvider(() => pointerSrc);
      // 外部指针注入出口：桌面壁纸窗口在 underlay 层（桌面图标之下）收不到任何
      // 鼠标事件，宿主轮询系统鼠标后经 __wp.pushPointer 推到这里。与上面的 DOM
      // 监听并存（谁后写谁赢），测试台用真鼠标的路径不受影响。
      rt.pointerCtl = {
        push: (p) => pointerSrc.pushExternal(p),
        leave: () => pointerSrc.pushExternalLeave(),
      };
      {
        const prevCleanup = particleCleanup;
        particleCleanup = () => {
          prevCleanup?.();
          pointerSrc.dispose();
        };
      }
      // 脚本沙箱的 input 视图：与 audioViews 同一套路 —— 一份实例、多脚本共享、
      // 每帧就地重填，脚本闭包捕获的 Vec3 引用始终有效。
      const inputView = wtext.createInputView();
      // [we-scene patch] engine.setTimeout/setInterval 的统一真定时器
      // （SCENESCRIPT-PLAN P1-1）。全库 76 处 / 26 张调用，此前只有对象字段 eval 点
      // 注入了真定时器，效果开关(37 处)/效果常量(8 处)/general(1 处) 的延时逻辑
      // 拿 no-op stub 永远不触发。一份实例五个 eval 点共享（timerOpts）；
      // 卸载时 dispose 撤销未触发的回调，防延迟写穿死层。
      const engineTimers = wtimers.createEngineTimers(
        {
          setTimeout: (fn: () => void, ms: number) => window.setTimeout(fn, ms),
          clearTimeout: (h: number) => window.clearTimeout(h),
          setInterval: (fn: () => void, ms: number) => window.setInterval(fn, ms),
          clearInterval: (h: number) => window.clearInterval(h),
        },
        {
          // 回调抛错由引擎隔离；这里只报首条（interval 抛错会逐拍触发，不能刷屏）
          onError: (() => {
            let reported = false;
            return (e: unknown) => {
              if (reported) return;
              reported = true;
              reportDiag(rt, cfg, `engine 定时器回调抛错（此后同类静默）: ${String((e as Error)?.message || e).slice(0, 90)}`, "warn");
            };
          })(),
        },
      );
      const timerOpts = {
        setTimeout: engineTimers.setTimeout,
        clearTimeout: engineTimers.clearTimeout,
        setInterval: engineTimers.setInterval,
        clearInterval: engineTimers.clearInterval,
      };
      {
        const prevCleanup = particleCleanup;
        particleCleanup = () => {
          prevCleanup?.();
          engineTimers.dispose();
        };
      }
      // 调试出口：指针状态（归一化/世界/last/按键/事件计数）。
      // **不加「有粒子才注册」之类的守卫** —— 没有粒子的场景同样需要看指针。
      (window as unknown as Record<string, unknown>).__pointerStats = () => {
        const p = pointerSrc.state;
        const r = (v: number) => Math.round(v * 1000) / 1000;
        return {
          normalized: { u: r(p.u), v: r(p.v) },
          last: { u: r(p.lastU), v: r(p.lastV) },
          world: { x: Math.round(p.wx), y: Math.round(p.wy) },
          originY: p.originY != null ? Math.round(p.originY as number) : null,
          screen: { x: p.screenX, y: p.screenY, w: p.screenW, h: p.screenH },
          leftDown: p.leftDown,
          has: p.has,
          delta: r(pointerSrc.normalizedDelta()),
          counts: { move: p.moveCount, down: p.downCount, up: p.upCount },
        };
      };

      // [S4] 足迹安全系数：视差/相机抖动/轻微放大动画的余量（1.15 = 15%）
      const FOOTPRINT_SAFETY = 1.15;
      // [S4] **图层足迹表**：贴图只需要 ≥ 它在屏幕上占的**设备像素**。
      // 预扫描一遍「有四边形几何的图层」（image/model 的图集层，排除 puppet/网格、
      // 粒子、文本、声音），按材质贴图槽算出每个贴图名的最大足迹（设备像素，含安全系数）。
      // 之后贴图装载时用 min(档位上限, 足迹) 作为目标尺寸 —— 这是数量级收益的来源：
      // 一张 3658×2000 的图在 840 CSS px 的层里，标准档过去要 2926、现在只要 ~966。
      const texFootprint = new Map<string, number>();
      {
        const general = (scene as any).general ?? null;
        const ortho = (general?.orthogonalprojection ?? null) as { width?: number; height?: number; auto?: boolean } | null;
        const viewW = Number(ortho?.width) || 0;
        const viewH = Number(ortho?.height) || 0;
        const explicitOrtho = viewW > 0 && viewH > 0 && ortho?.auto !== true;
        const dpr = effectiveDpr(rt, cfg) || 1;
        const canvasDeviceW = (c.clientWidth || window.innerWidth || 1280) * dpr;
        const canvasDeviceH = (c.clientHeight || window.innerHeight || 720) * dpr;
        if (explicitOrtho) {
          const ctx = { canvasDeviceW, canvasDeviceH, viewW, viewH, safety: FOOTPRINT_SAFETY };
          for (const layer of scene.layers as any[]) {
            if (!layer || layer.destroyed || !layer.visible) continue;
            const img = layer.image || layer.model;
            if (!img) continue; // 粒子/文本/声音层没有四边形贴图密度语义
            let model: any = null;
            try {
              if (eff.BUILTIN_MODELS[img]) model = eff.BUILTIN_MODELS[img];
              else {
                const me = pkg.getEntry(parsedPkg, img);
                // [S4 保守] 网格/骨骼模型（puppet）的屏幕范围由骨骼动画决定，layer.size 不是上界
                if (me) model = JSON.parse(readText(me));
              }
            } catch {
              model = null;
            }
            if (!model || (model as any).meshes || (model as any).puppet) continue;
            const matPath = model.material;
            if (!matPath) continue;
            const matEntry = pkg.getEntry(parsedPkg, matPath);
            if (!matEntry) continue;
            let names: string[] = [];
            try {
              const mat = readMaterialDoc(matEntry);
              names = (mat?.passes || []).flatMap((p: any) => (Array.isArray(p?.textures) ? p.textures : []));
            } catch {
              names = [];
            }
            // 图层世界尺寸：优先 scene.json 的 size；缺省时按模型声明的 width/height
            // （image 模型的 autosize 语义，与装配期一致 —— Jake 这类层 scene.json 里没有 size）
            const szRaw = (layer.size || [0, 0]) as [number, number];
            const sz: [number, number] =
              Math.abs(Number(szRaw[0])) > 0 && Math.abs(Number(szRaw[1])) > 0
                ? [Number(szRaw[0]), Number(szRaw[1])]
                : [Number((model as any).width || 0), Number((model as any).height || 0)];
            if (!(Math.abs(sz[0]) > 0) || !(Math.abs(sz[1]) > 0)) continue;
            const sc = (layer.scale || [1, 1, 1]) as [number, number, number];
            // 尺寸/缩放动画会让足迹变大：有动画的层放宽安全系数（宁可少省，不可变糊）
            const animated = !!(layer.sizeAnimation || layer.scaleAnimation || layer.animationlayers?.length);
            const need = layerFootprintPx(
              sz,
              [Number(sc[0] ?? 1), Number(sc[1] ?? 1)],
              Number((layer.angles || [0, 0, 0])[2] || 0),
              { ...ctx, safety: FOOTPRINT_SAFETY * (animated ? 1.4 : 1) },
            );
            if (!(need > 0)) continue;
            for (const nm of names) {
              if (typeof nm !== "string" || !nm || nm.startsWith("util/") || nm.startsWith("_rt_")) continue;
              const prev = texFootprint.get(nm) || 0;
              if (need > prev) texFootprint.set(nm, need);
            }
          }
          reportDiag(
            rt,
            cfg,
            `[S4] 图层足迹表 ${texFootprint.size} 个贴图（视口 ${viewW}x${viewH} 世界 → 画布 ${Math.round(canvasDeviceW)}x${Math.round(canvasDeviceH)} 设备像素，safety=${FOOTPRINT_SAFETY}）`,
            "info",
          );
        } else {
          reportDiag(rt, cfg, "[S4] 正交投影非显式（auto/透视）：跳过图层足迹模型，回退到全局档位", "warn");
        }
      }
      const textures = new Map<string, any>();
      // [we-scene patch 2026-09-20] 资源分辨率倍率（清晰度 → 贴图缩放）与内存台账。
      // 只有「贴在设备像素上的足迹」需要那么多像素；多出来的部分纯属常驻内存。
      const resOff = resourcesOff();
      let currentTexName = "";
      // 当前贴图是否「一律不缩」（帧表图集 / 本来就小）：跳过必须**绝对** ——
      // 只把档位倍率设成 1 不够，S4 的图层足迹仍会把它压下去（1444077782 的序列帧图集
      // 就是这么被缩掉、下方贴图出白块的）。
      let currentTexNoScale = false;
      const resScaleBase = resourceScaleFor(rt, cfg);
      const resScaleNormal = resourceScaleForNormal(rt, cfg);
      const MIN_RES_EDGE = 32;
      const mem = {
        texCount: 0,
        cpuDecoded: 0, // 解出来的 RGBA 总量（仅被释放判定覆盖到的那些）
        cpuReleased: 0, // 上传后释放掉的 CPU 副本
        gpuUploaded: 0, // 上传纹理估计值（含 mip 链 ×4/3）
        compressed: 0, // 其中以压缩块直传的字节（DXT/BC/ETC）
        r8Native: 0, // 其中以 R8 单通道直传的字节
        framesScaled: [] as string[],
        scaled: [] as Array<{ name: string; how: string; from: string; to: string }>,
        textures: [] as Array<{ name: string; size: string; scale: number; level: number; native?: number; need?: number; target?: number }>,
        pkgBytes: 0,
      };
      // `?texr8=0` 关掉 R8 单通道直传（A/B 对照用）
      const texR8On = (() => {
        if (typeof location === "undefined") return true;
        const q = new URLSearchParams(location.search).get("texr8");
        return !(q === "0" || q === "off" || q === "native");
      })();
      // `?texcompress=0` 关掉压缩直传（A/B 对照用）
      const texCompressOn = (() => {
        if (typeof location === "undefined") return true;
        const q = new URLSearchParams(location.search).get("texcompress");
        return !(q === "0" || q === "off" || q === "native");
      })();
      /** 当前屏幕最长边（**设备像素**）：画布 CSS 长边 × 有效 DPR。 */
      const screenLongEdge = (): number => {
        const dpr = effectiveDpr(rt, cfg) || 1;
        const w = (c.clientWidth || window.innerWidth || 1280) * dpr;
        const h = (c.clientHeight || window.innerHeight || 720) * dpr;
        return Math.max(w, h);
      };
      // 纯函数（倍率/目标边/mip 级/帧矩形缩放/字节估计/不透明判定）集中在 resource-scale.ts
      const normalizedResScale = (name: string): number => texResScale(name, resScaleBase, resScaleNormal);
      /** 贴图的**原生内容最长边**（帧表贴图用 mip0；否则用可能小于填充画布的 tex.width/height）。 */
      const texNativeLong = (parsedTex: any): number => {
        const im0 = parsedTex?.images?.[0]?.[0];
        const hasFrames = !!parsedTex?.frames?.list?.length;
        // 无帧表时「原生尺寸」取**内容尺寸**（tex.width/height，可能小于被 POT 填充的 mip0）：
        // 1039919954 内容 1920×1080、mip0 却是 2048×2048，按 mip0 算会把目标边放大 6%。
        return hasFrames
          ? Math.max(Number(im0?.width || 0), Number(im0?.height || 0))
          : Math.max(Number(parsedTex?.width || 0), Number(parsedTex?.height || 0), 0) ||
              Math.max(Number(im0?.width || 0), Number(im0?.height || 0));
      };
      /**
       * 贴图**分类**（等价于 decodeMip0 的三个免解码分支），不碰像素。
       *
       * decodeMip0 对原始格式（DXT/BC/ETC/RGBA…）会做一次全尺寸像素解码，而调用方
       * 只在 video / 内嵌 PNG / 内嵌 JPEG 这三个分支读它的结果；原始格式那一支用的是
       * 头部尺寸 + 下游自己的 decodeMipLevel / 压缩直传。所以这里按头部返回同样形状的
       * 对象，把「要不要像素」的决定权交还给真正的消费分支 —— 少掉的是一次纯浪费的
       * 全尺寸展开（8K DXT 单张 ~390ms，见挂载路径注释）。
       *
       * 分支顺序与 decodeMip0 逐条对齐（含 freeImageFormat 非 PNG/JPEG 时的
       * `image` 分支），返回的 `data` 是 pkg 缓冲区上的视图（不复制）。
       */
      const classifyTexHeader = (parsedTex: any): any => {
        const im = parsedTex?.images?.[0]?.[0];
        // 与 decodeMip0 同口径：没有图像数据就当坏贴图抛出（调用方按张 catch）
        if (!im) throw new Error("无图像数据");
        const w = Number(im.width || 0);
        const h = Number(im.height || 0);
        if (parsedTex?.isVideo) return { width: w, height: h, video: im.data };
        const fif = parsedTex?.freeImageFormat;
        if (fif === tex.FIF.PNG) return { width: w, height: h, png: im.data };
        if (fif !== tex.FIF.UNKNOWN) return { width: w, height: h, image: im.data, fif };
        // 原始格式：像素解码交给下面的 else 分支（压缩直传命中就完全不需要像素）
        return { width: Number(parsedTex?.width || w), height: Number(parsedTex?.height || h) };
      };
      /**
       * [S4] 目标最长边 = min(档位上限, 图层足迹)。
       * `?resources=native` 时严格 no-op（返回原生，供 A/B 对照）。
       */
      const texTargetLong = (R: number, parsedTex: any): number => {
        const native = texNativeLong(parsedTex);
        if (resOff || currentTexNoScale) return native;
        const cap = targetLong(native, R);
        const need = texFootprint.get(currentTexName) || 0;
        return footprintTarget(cap, native, need);
      };
      const pickMipLevel = (parsedTex: any, target: number, R: number): number => {
        // `?resources=native` 必须是严格的 no-op（A/B 对照用）。高清档 R=1 不再是 no-op：
        // 它的 policy 上限是原生，但**图层足迹**仍可以把尺寸压下来（S4 的主要收益）。
        if (resOff || currentTexNoScale) return 0
        const image = parsedTex?.images?.[0];
        if (!image) return 0;
        const im0 = image[0];
        const hasFrames = !!parsedTex?.frames?.list?.length;
        // 每级的「内容最长边」：被 POT 填充的 .tex（1039919954：mip0 2048×2048、内容 1920×1080）
        // 必须按内容算，否则 target=1920 会把「2048 > 1920」当成需要降级 → 白白掉到 mip1。
        const contentLong = hasFrames
          ? Math.max(Number(im0?.width || 0), Number(im0?.height || 0))
          : Math.max(Number(parsedTex?.width || 0), Number(parsedTex?.height || 0), 0) ||
            Math.max(Number(im0?.width || 0), Number(im0?.height || 0));
        const sizes = image.map((m: any, i: number) =>
          hasFrames ? Math.max(Number(m.width || 0), Number(m.height || 0)) : Math.max(1, Math.round(contentLong / 2 ** i)),
        );
        // [we-scene patch 2026-09-20] 屏幕底线：mip 是 2× 一跳，若降级后的尺寸**小于屏幕
        // 最长边**，就是把清晰度让给了内存（1039919954 的 1920×1080 图在 1280 画布上降到
        // 960×540 = 放大 1.33× 才能铺满，观感变糊）。所以挑选时以「屏幕最长边（设备像素）」
        // 为底线：优先在 [屏幕边, policy 上限] 区间里取最省的一级；区间为空就取最接近
        // 屏幕边的那一级（宁可省不动，也不明显糊）。S4 的逐层足迹模型会把这条底线替换成
        // 真正的图层足迹。
        // 下限优先用**该贴图的图层足迹**（S4）；没有足迹信息（粒子/效果/util/未知几何）时
        // 退回全局「屏幕最长边」，至少不会小于屏幕。
        const fp = texFootprint.get(currentTexName) || 0;
        const needFloor = fp > 0 ? Math.round(fp) : Math.max(64, Math.round(screenLongEdge()));
        return pickMipLevelPure(sizes, target, needFloor);
      };
      /** 单级贴图的兜底：走 JS 精确重采样（形状/蒙版/带 alpha 的贴图用）。 */
      const shrinkDecoded = (m: any, target: number): any => {
        const long = Math.max(Number(m.width || 0), Number(m.height || 0));
        // 1.1 而不是 1.25：标准档 R=0.8 的目标正好是原生的 1/1.25，用 1.25 会让这一档
        // 「单级贴图完全不缩」（只有 mip 链能缩），把标准档的收益让掉一半。
        if (!target || long <= target * 1.1) return m;
        const k = target / long;
        return resampleRgba(m, Math.max(1, Math.round(m.width * k)), Math.max(1, Math.round(m.height * k)));
      };
      /**
       * 不透明单级贴图的高效降采样：交给浏览器的原生缩放器（canvas → createImageBitmap），
       * 大图比 JS 循环快一个数量级（6144×4096 实测 JS 201ms，浏览器原生几毫秒）。
       * **只对不透明图用**：canvas 内部是预乘、上传时再解预乘，低 alpha 区会有 1 LSB 级
       * 舍入（本仓库踩过「细线变深色刻线」的坑），所以带 alpha 的贴图仍走 JS 精确路径。
       */
      const scaleViaBitmap = async (m: { width: number; height: number; rgba: Uint8Array }, w: number, h: number) => {
        const cv = document.createElement("canvas");
        cv.width = m.width;
        cv.height = m.height;
        const ctx = cv.getContext("2d", { alpha: true, willReadFrequently: false });
        if (!ctx) return null;
        ctx.putImageData(new ImageData(new Uint8ClampedArray(m.rgba.buffer, m.rgba.byteOffset, m.rgba.length), m.width, m.height), 0, 0);
        const cv2 = document.createElement("canvas");
        cv2.width = w;
        cv2.height = h;
        const ctx2 = cv2.getContext("2d", { alpha: true });
        if (!ctx2) return null;
        ctx2.imageSmoothingEnabled = true;
        ctx2.imageSmoothingQuality = "high";
        ctx2.drawImage(cv, 0, 0, w, h);
        try {
          return await createImageBitmap(cv2, { premultiplyAlpha: "none" });
        } catch {
          return null;
        }
      };
      // pkg 字节进台账（解析后的整份容器常驻，是记忆体里最大的一块之一）
      mem.pkgBytes = Number((parsedPkg as { fileSize?: number })?.fileSize || 0);


      // [we-scene patch] 本机引擎内置素材（WE 安装目录的 materials/**）：贴图 + 法线。
      // 装了（`local-assets/mirage/` 或 WE_LOCAL_ASSETS）就用原版像素，没装就返回
      // null → 下面照旧走 system-textures.js / particle-textures.js 的程序化复刻。
      // 必须在注册 util 贴图**之前** await：provider 一旦装上，注册循环直接拿官方像素。
      {
        // 防呆：本地素材只是测试通路，任何意外都不许拖垮挂载（内部已各自 try/catch）
        let st: Awaited<ReturnType<typeof installLocalAssets>> = null;
        try {
          st = await installLocalAssets();
        } catch (e) {
          reportDiag(rt, cfg, `local assets 装载失败（忽略）：${(e as Error)?.message}`, "warn");
        }
        if (st) {
          reportDiag(
            rt,
            cfg,
            `local assets: ${st.loaded}/${st.requested} tex（util ${st.util} / particle ${st.particle}）` +
              ` ${(st.bytes / 1e6).toFixed(1)}MB ${st.ms}ms source=${st.source} mode=${st.mode}` +
              (st.failed ? ` failed=${st.failed}` : ""),
            "info",
          );
        }
      }
      // [we-scene patch] WE 系统内置贴图（materials/util/*，效果链/材质/sampler
      // 默认槽引用、不在壁纸 pkg 里）。此前只硬编码 5 个名字且多为 1×1 占位，
      // 与官方差距大：flatnormal（法线参考）缺失 → 法线类效果落白板、法线被
      // 解释成 (1,1,1)；noflow 的 B 通道误写 127（官方 0=无流动）；noise 是
      // 8px 平滑值噪声（官方逐像素白噪声）；perlin_256/uniform_256/fur 缺失。
      // 现由 system-textures.js 按官方实测统计程序化复刻（尺寸/通道布局/均值
      // 方差/零值占比/平铺性，逐字节不入库，见该模块头注与 docs/COMPLIANCE.md）。
      // 全部 REPEAT 环绕（官方 clampuvs:false，uv 随 g_Time 无界增长）；
      // nomip 名单（flatnormal/fur/noflow/noise）LINEAR 无 mip 链，与官方一致。
      for (const sysName of sysTex.SYSTEM_UTIL_TEXTURES) {
        const t = sysTex.buildSystemUtilTexture(sysName);
        if (!t) continue;
        const opts = { wrap: "repeat" };
        textures.set(
          sysName,
          sysTex.isNomipSystemTexture(sysName)
            ? {
                glTex: rnd.makeTexture(renderer.gl, t.rgba, t.width, t.height, null, opts),
                width: t.width,
                height: t.height,
                rg88: false,
                mips: null,
                // 官方素材 Pixel 带 .tex flags 的 clamp 标记；程序化复刻恒 REPEAT。
                clampUvs: t.clampUvs === true,
              }
            : {
                glTex: rnd.makeTextureMip(renderer.gl, [t], false, opts),
                width: t.width,
                height: t.height,
                rg88: false,
                mips: [t],
                clampUvs: t.clampUvs === true,
              },
        );
      }

      // [we-scene patch] 实例层（instance.usertextures 绑保留名）的**迟到绑定**：
      // 真实封面由系统实况在装配期之后异步上传，装配循环此刻查不到 `$mediaThumbnail`，
      // 实例层只能留在 solid 兜底（3122339805 / 3151551777 / 3155776049 封面位
      // 永远画成 solid 占位块）。把这些层收集起来，纹理一就绪就补绑；纹理像素在
      // 同一 glTex 上原地更新，晚几帧切换 solid→texture 不影响引用方。
      const pendingInstanceMedia: Array<{ layer: any; name: string }> = [];
      const bindPendingInstanceMedia = () => {
        for (let i = pendingInstanceMedia.length - 1; i >= 0; i--) {
          const { layer, name } = pendingInstanceMedia[i];
          if (!textures.has(name)) continue;
          layer.textureName = name;
          layer.solid = false;
          pendingInstanceMedia.splice(i, 1);
        }
      };

      // [we-scene patch] WE 的两个保留纹理名：当前封面 / 上一张封面。
      // 全库 35 + 29 处引用（作者直接把它们填进 image 或 textures 槽）。
      // 独立测试台没有真实专辑封面，用模拟媒体源的程序化封面填充；
      // 换真实媒体源时只需重新上传这两张纹理的像素，引用方无需改动。
      {
        const mkThumb = (track: any) => {
          const img = media.renderThumbnail(track, 512);
          return {
            glTex: rnd.makeTextureMip(renderer.gl, [img], false),
            width: img.width,
            height: img.height,
            rg88: false,
            mips: [img],
            generated: true,
          };
        };
        const tracks = simMedia.tracks || [];
        // [we-scene patch 2388299037] 封面优先级：外部真实封面 > 模拟/测试封面 >
        // 壁纸内置封面。媒体被整条禁用时不注册模拟测试封面，保留名解析不到内容 →
        // 渲染端回落到作者内置封面（parse 的 textureFallbacks）。
        if (tracks.length && mediaSim.enabled) {
          textures.set("$mediaThumbnail", mkThumb(tracks[0]));
          textures.set("$mediaPreviousThumbnail", mkThumb(tracks[tracks.length - 1]));
        }
      }

      /**
       * 把一张真实封面上传到 `$mediaThumbnail`（旧的顺位挪到 `$mediaPreviousThumbnail`）。
       *
       * 场景壁纸的封面**不走脚本回调**：作者是把这两个 WE 保留纹理名直接填进
       * 层的 image / textures 槽（全库 35 + 29 处），所以 mediaThumbnailChanged
       * 里带的 `e.thumbnail` 对场景侧没有意义 —— 必须把像素传成 GL 纹理。
       *
       * 复用既有纹理对象（bindTexture + texImage2D）而不是新建：引用方在装配期
       * 已经把 glTex 句柄抓进各自的槽里，换成新对象它们仍指向旧纹理。
       */
      const uploadThumbnailBitmap = (bmp: ImageBitmap | HTMLImageElement, w: number, h: number) => {
        const raster = rasterizeArtwork(bmp, w, h, 512);
        const palette = sampleArtworkPalette(bmp, w, h);
        const gl = renderer.gl as WebGL2RenderingContext;

        const cur = textures.get("$mediaThumbnail");
        // 占位封面（挂载时 renderThumbnail 程序化生成，generated 标记）不是「上一张
        // 封面」：第一张真实封面上传时把它顺位给 previous，Previous album cover 效果
        // 会在交叉淡入里闪出一帧程序化圆环。占位则当前/上一张都直接上真实封面。
        const curIsPlaceholder = !!cur?.generated;
        if (cur && !curIsPlaceholder) textures.set("$mediaPreviousThumbnail", cur);

        const existing = textures.get("$mediaThumbnail");
        if (existing?.glTex) {
          gl.bindTexture(gl.TEXTURE_2D, existing.glTex);
          gl.texImage2D(
            gl.TEXTURE_2D, 0, gl.RGBA, raster.width, raster.height, 0,
            gl.RGBA, gl.UNSIGNED_BYTE, raster.rgba,
          );
          // [we-scene patch 2388299037] **必须重建 mip 链**：纹理是 makeTextureMip
          // 建的（MIN_FILTER=LINEAR_MIPMAP_LINEAR），挂载时的 mip 链来自程序化
          // 占位封面。只写 level 0 而 mipmap 不更新时，缩小的封面 quad（层 100×100
          // 放大 3.46 后 346px 采样 512 纹理）按 LOD≈0.56 在 level0/1 之间三线性
          // 插值，采到的仍是**旧占位环**——真实封面早就上传了，画面上却一直显示
          // 占位图（「歌曲封面不显示」的真身；实测在页面里手工 generateMipmap
          // 后同一张纹理立刻显形）。
          gl.generateMipmap(gl.TEXTURE_2D);
          existing.width = raster.width;
          existing.height = raster.height;
          existing.mips = [raster];
          existing.generated = false;
        } else {
          textures.set("$mediaThumbnail", {
            glTex: rnd.makeTextureMip(gl, [raster], false),
            width: raster.width,
            height: raster.height,
            rg88: false,
            mips: [raster],
            generated: false,
          });
        }
        if (curIsPlaceholder) {
          const prev = textures.get("$mediaPreviousThumbnail");
          if (prev?.glTex) {
            gl.bindTexture(gl.TEXTURE_2D, prev.glTex);
            gl.texImage2D(
              gl.TEXTURE_2D, 0, gl.RGBA, raster.width, raster.height, 0,
              gl.RGBA, gl.UNSIGNED_BYTE, raster.rgba,
            );
            // 同上：不重建 mip 会采到旧占位封面（Previous album cover 淡入时闪环）
            gl.generateMipmap(gl.TEXTURE_2D);
            prev.width = raster.width;
            prev.height = raster.height;
            prev.mips = [raster];
            prev.generated = false;
          }
        }
        // 真实封面刚进纹素表：登记在案的实例层此刻可以从 solid 切到封面纹理
        bindPendingInstanceMedia();
        return palette;
      };

      // ---- 系统实况：textures / mediaDriver 已就绪后再挂系统频谱与 Now Playing ----
      if (cfg.liveSystem) {
        // 释放槽**同步登记**：startLiveSystem 是异步的（首轮轮询 + SSE 建立，
        // 时长不可控）。若这期间换了壁纸，clear() 早已跑过，之后再挂的清理
        // 没人会调。先占位，await 回来再填句柄。
        const liveSlot: { handle: { dispose(): void } | null; dead: boolean } = {
          handle: null,
          dead: false,
        };
        (rt.wallpaperDisposers ??= []).push(() => {
          liveSlot.dead = true;
          try {
            liveSlot.handle?.dispose();
          } catch {
            /* 忽略 */
          }
          liveSlot.handle = null;
        });
        try {
          const uploadLiveArtwork = async (info: {
            url: string;
            trackKey: string;
            title: string;
            artist: string;
          }) => {
            try {
              const res = await fetch(info.url, { cache: "no-store" });
              if (!res.ok) return;
              const blob = await res.blob();
              const bmp = await createImageBitmap(blob, { premultiplyAlpha: "none" });
              const palette = uploadThumbnailBitmap(bmp, bmp.width, bmp.height);
              bmp.close?.();

              const snap = currentMediaDriver().snapshot;
              if (palette) {
                snap.primaryColor = media.mediaVec3(...palette.primary);
                snap.secondaryColor = media.mediaVec3(...palette.secondary);
                snap.tertiaryColor = media.mediaVec3(...palette.tertiary);
                snap.textColor = media.mediaVec3(0.98, 0.98, 1);
                snap.highContrastColor = media.mediaVec3(1, 1, 1);
              }
              snap.hasThumbnail = true;
              liveHold.lastSnap.setHasThumbnail(false);
              reportDiag(rt, cfg, `liveSystem: artwork ${info.title || info.trackKey}`, "info");
            } catch (e) {
              reportDiag(
                rt,
                cfg,
                `liveSystem: artwork 失败 (${e instanceof Error ? e.message : e})`,
                "warn",
              );
            }
          };

          live = await startLiveSystem({
            origin: location.origin,
            onArtwork: (info) => {
              void uploadLiveArtwork(info);
            },
          });
          // 授权期间已被拆掉：立刻释放、不接线，但**不能 return** ——
          // 这里身处 mountScene 的整段 async 装配体内，return 会把后面的
          // 渲染器启动与渲染循环一起跳过（画面永远不出）。
          if (liveSlot.dead) {
            try {
              live.dispose();
            } catch {
              /* 忽略 */
            }
            live = null;
          } else {
            liveSlot.handle = live;
            liveMediaOverride = live.media;
            windowDriver = live.windowTitle;
            liveHold.mediaDriver = live.media;
            if (live.status().audio === "live") audioDriverRef.current = live.audio;
            // 补发当前媒体快照给已登记沙箱
            if (currentMediaDriver().snapshot.hasMedia) {
              for (const { name, event } of media.diffMediaEvents(null, currentMediaDriver().snapshot)) {
                for (const sb of mediaHooks) {
                  try {
                    sb.callMedia(name, event);
                  } catch {
                    /* ignore */
                  }
                }
              }
              lastMediaSnap = media.cloneMediaSnapshot(currentMediaDriver().snapshot);
            }
            const st = live.status();
            reportDiag(
              rt,
              cfg,
              `liveSystem: audio=${st.audio} media=${st.media} window=${st.window}` +
                (st.title ? ` title="${st.title}"` : "") +
                (st.hasArtwork ? " artwork=1" : ""),
              "info",
            );
            reportDiag(
              rt,
              cfg,
              `audio: ${audioDriverRef.current ? "live system" : "simulated"} stream, supportsaudioprocessing=${supportsAudioProcessing}`,
              "info",
            );
            (window as unknown as Record<string, unknown>).__system = {
              media: mediaControl,
              windowTitle: windowDriver.snapshot,
              shortcuts: shortcuts.last,
              live: () => live!.status(),
            };
            (window as unknown as Record<string, unknown>).__liveSystem = () => live!.status();
          }
        } catch (e) {
          reportDiag(rt, cfg, `liveSystem: 启动失败，回退模拟源 (${e instanceof Error ? e.message : e})`, "warn");
          live = null;
        }
      }

      {
        // 旧的兜底释放保留（particleCleanup 链）；主释放已改由
        // rt.wallpaperDisposers 的 liveSlot 同步登记，两者都做 null 检查、幂等
        const prevCleanup = particleCleanup;
        particleCleanup = () => {
          prevCleanup?.();
          live?.dispose();
          live = null;
        };
      }

      const texInflight = new Map<string, Promise<any | null>>();
      // [we-scene patch 3243449890] 绑到**场景用户属性**的贴图槽（`usertextures`，
      // 属性类型 file/scenetexture/usershortcut）：属性名集合 + 各自当前实际用到的
      // 值。装配期预载时登记，热更时据此判断「值真的变了才重取图」——宿主整表重发
      // 属性（切语言、改别的滑条）时不能白删白建 GL 纹理。
      const propTexSlots = new Set<string>();
      const propTexLoadedValue = new Map<string, string>();
      /**
       * [we-scene patch] 壁纸目录下的**散装文件**贴图（`files/xxx.gif` 这类）。
       *
       * 预设壁纸（工坊模板，如 3427522122）把用户选的图/动图存在壁纸目录的
       * `files/` 下，通过 `project.json.preset` 的属性值引用（`customimageleft`
       * = `files/drift-gif.gif`）。这些文件不在 pkg 里，宿主按
       * `/media/<token>/<itemId>/<相对路径>` 提供（与 scene.pkg 同一 base）。
       *
       * 动图（.gif）用 `<img>` 元素承载：浏览器自己推进动画帧，渲染端逐帧
       * texImage2D 上传（与视频纹理同一条思路，见 renderer 的 video 分支）。
       * 静态图走 createImageBitmap。
       */
      const loadWallpaperFile = async (relPath: string): Promise<any | null> => {
        const rel = String(relPath || "").replace(/^\/+/, "");
        if (!rel || /\.\.\//.test(rel)) return null;
        const url = `${source.key}/${rel.split("/").map(encodeURIComponent).join("/")}`;
        const isGif = /\.gif(\?|$)/i.test(rel);
        try {
          if (isGif) {
            const img = new Image();
            img.decoding = "async";
            const ready = new Promise<void>((resolve, reject) => {
              img.onload = () => resolve();
              img.onerror = () => reject(new Error("decode fail"));
            });
            img.src = url;
            await ready;
            const w = img.naturalWidth || 1;
            const h = img.naturalHeight || 1;
            const entry = {
              glTex: rnd.makeTexture(renderer.gl, new Uint8Array([0, 0, 0, 0]), 1, 1),
              width: w,
              height: h,
              rg88: false,
              animatedImage: img,
              generated: false,
            };
            reportDiag(rt, cfg, `user file tex '${rel}': ${w}x${h} (gif, animated)`, "info");
            return entry;
          }
          const res = await fetch(url, { signal: pkgAbort?.signal });
          if (!res.ok) return null;
          const bmp = await decodeTexImageBitmap(await res.blob(), null, 0, 0, 1);
          if (!bmp) return null;
          const entry = {
            glTex: rnd.makeTexture(renderer.gl, null, 0, 0, bmp),
            width: bmp.width,
            height: bmp.height,
            rg88: false,
            generated: false,
          };
          reportDiag(rt, cfg, `user file tex '${rel}': ${bmp.width}x${bmp.height}`, "info");
          return entry;
        } catch (e) {
          reportDiag(rt, cfg, `user file tex '${rel}' 失败：${(e as Error)?.message}`, "warn");
          return null;
        }
      };
      const loadTexInner = async (name: string): Promise<any | null> => {
        currentTexName = name;
        currentTexNoScale = false;
        if (textures.has(name)) return textures.get(name);
        // [we-scene patch] 属性槽（预设壁纸的 `customimage*` 等）：槽名是一个**用户
        // 属性名**，其现值是壁纸目录下的相对路径（`files/xxx.gif`）。先按这条通路
        // 取用户选的图；取不到再走下面的 pkg / 内置 / 占位回落。
        {
          const uv = (liveUserProps as Record<string, unknown> | null)?.[name];
          if (typeof uv === "string" && uv && /\.[a-z0-9]{2,5}$/i.test(uv) && uv.includes("/")) {
            const fileEntry = await loadWallpaperFile(uv);
            if (fileEntry) {
              textures.set(name, fileEntry);
              return fileEntry;
            }
          }
        }
        const texEntry = pkg.getEntry(parsedPkg, `materials/${name}.tex`);
        if (!texEntry) {
          // [we-scene patch] **源码工程的贴图源图回退**：WE 编辑器工程（含官方内置
          // defaultprojects）里 `materials/X.png` 是贴图源、`X.tex` 是编译产物，但
          // 编译产物**可能缺席**——audiophile 的 `materials/grid/grid.png` 就没有对应
          // 的 grid.tex（模型 skin 0 的贴图），此时引用有效、只是没编译。工坊包里不存在
          // 这种形态（.tex 一定在），所以这条只在缺 .tex 时兜底，对既有语料是恒等变换。
          // 只试**工程自制命名空间**：内置命名空间（particle/util/gradient/…）的缺席是
          // 预期状态，且 getEntry 是线性扫描，不该为它们白扫三遍大包（PKGV0023 实测）。
          if (!/^(particle|util|gradient|pattern|lut|cookie)\//.test(name)) {
            for (const ext of ["png", "jpg", "jpeg"]) {
              const imgEntry = pkg.getEntry(parsedPkg, `materials/${name}.${ext}`);
              if (!imgEntry) continue;
              try {
                const bmp = await decodeTexImageBitmap(new Blob([imgEntry]), null, 0, 0, 1);
                if (bmp) {
                  const entry = {
                    glTex: rnd.makeTexture(renderer.gl, null, 0, 0, bmp),
                    width: bmp.width,
                    height: bmp.height,
                    rg88: false,
                    generated: false,
                  };
                  reportDiag(
                    rt,
                    cfg,
                    `tex '${name}': 包内无 .tex，回退源图 materials/${name}.${ext}（${bmp.width}x${bmp.height}）`,
                    "info",
                  );
                  textures.set(name, entry);
                  return entry;
                }
              } catch (e) {
                reportDiag(rt, cfg, `tex '${name}' 源图回退失败：${(e as Error)?.message}`, "warn");
              }
            }
          }
          // [we-scene patch] WE 内置资源不在 pkg 里（作者的 pkg 只存自制素材）。
          // 最典型的是 `particle/halo_6` —— 它是 xray 效果的 **sprite**，
          // 官方描述「This is the shape image that will be used to define how the
          // background and blend texture are blended together」，即**开窗形状的唯一来源**。
          // 缺它会落到 whiteTex（renderer.js 的空槽兜底），blendSample 恒为 (1,1)、
          // 混合权重处处相同 —— 表现为「效果编译成功、g_PointerPosition 也在动，
          // 但画面对鼠标零响应」（实测 6 个 xray 壁纸像素差恰好为 0）。
          // 仓库自带等效素材（render/particle-textures.js），这里按名回退。
          // 注意：这条回退过去只在 loadParticleTex 里有，效果 pass 的贴图预载走的是
          // 本函数，所以粒子能拿到内置素材、效果不能。
          // [we-scene patch] 本机装了 WE 原版素材时先按需拉这一张（粒子图集很大，
          // 不做全量预载）：落进 provider 缓存后，下面的 buildBuiltinParticleTexture
          // 就命中官方像素。没装素材时它立刻返回 false，照旧走程序化复刻。
          await ensureLocalAsset(name);
          if (ptex.isBuiltinParticleTextureName(name)) {
            const gen = ptex.buildBuiltinParticleTexture(name);
            if (gen) {
              const genEntry = {
                glTex: rnd.makeTextureMip(renderer.gl, [gen], false),
                width: gen.width,
                height: gen.height,
                rg88: false,
                mips: [gen],
                generated: true,
                // 官方 clampuvs:true 的精灵（如 particle/halo_6）：效果链槽 1+
                // 采样时必须 CLAMP，否则开窗形状无限平铺（2212279721）。
                // 官方素材 Pixel 自带 flags 标记时优先，程序化兜底按名字表判定。
                clampUvs: gen.clampUvs === true || ptex.isBuiltinClampUvsName(name),
              };
              textures.set(name, genEntry);
              return genEntry;
            }
          }
          // [we-scene patch] WE 内置纹样（pattern/voronoi[_local]）：watercaustics 的
          // 槽 2（主焦散纹样）/ 槽 5（辉光）的 sampler default，缺它两槽落 whiteTex
          // → 整层焦散变纯色（docs/ASSET-AUDIT.md §6 缺口第 1 条、唯一直接贴图缺口）。
          // 官方 .tex flags bit1 = 0（sidecar `clampuvs:false`）→ REPEAT，且图像本身
          // 是 256 周期化的（规格 §2「周期性」）——消费方 uv 随 g_Time 无界漂移，
          // CLAMP 会把整片拉成边缘一行（与 util/* 同一教训）。
          // 上面 ensureLocalAsset 命中官方像素时已进 textures；这里只兜程序化复刻。
          if (!textures.has(name) && patTex.isBuiltinPatternTextureName(name)) {
            const gen = patTex.buildBuiltinPatternTexture(name);
            if (gen) {
              const genEntry = {
                glTex: rnd.makeTextureMip(renderer.gl, [gen], false, { wrap: "repeat" }),
                width: gen.width,
                height: gen.height,
                rg88: false,
                mips: [gen],
                generated: true,
                // 官方 flags bit1 = 0 / clampuvs:false → 效果链槽位按 REPEAT 绑定
                clampUvs: false,
              };
              textures.set(name, genEntry);
              return genEntry;
            }
          }
          // [we-scene patch] 内置渐变（gradient/gradient_*）：shimmer 的 gradient map、
          // lightshafts / procedural_noise 等效果槽的 sampler default。缺它落 whiteTex
          // → shimmer 的混合权重 `mask * shimmerColor` 恒 1，「从左向右扫过的亮暗带」
          // 退化成整层恒定染色（3737267090；全库 3 个渐变名 / 13 张壁纸受影响）。
          // 上面 ensureLocalAsset 命中官方像素时已进 textures；这里只兜程序化复刻。
          if (!textures.has(name) && gtex.isBuiltinGradientTextureName(name)) {
            const gen = gtex.buildBuiltinGradientTexture(name);
            if (gen) {
              const genEntry = {
                glTex: rnd.makeTextureMip(renderer.gl, [gen], false, { wrap: "repeat" }),
                width: gen.width,
                height: gen.height,
                rg88: false,
                mips: [gen],
                generated: true,
              };
              textures.set(name, genEntry);
              return genEntry;
            }
          }
          return null;
        }
        // name 带进解析器：越界/畸形素材的报错要能直接指到是哪张 .tex
        // （否则只有计数与 img/mip 序号，见 renderer/vendor/we-scene/pkg/limits.js）
        const parsedTex = tex.parseTex(texEntry, { name: `materials/${name}.tex` });
        // [we-scene patch] 多图 .tex（GIF 导入模板 843532366 等）：WE 把动图逐帧
        // 编译成多个 image（每张 POT 画布 2048x1024，内容在左上
        // textureWidth x textureHeight）。WE 桌面端轮播这些 image 实现动画。
        // 这里裁出每帧内容区，先同步传首帧，再按固定节奏 texSubImage2D **原地**
        // 换像素 —— 消费方装配期抓的是 glTex 句柄，动画不能换对象。
        // 时长：TEXS 帧表与 image 数对不上（模板实测 64 项 vs 6 图），取 100ms/帧。
        if (!parsedTex.isVideo && parsedTex.images && parsedTex.images.length > 1) {
          const contentW = parsedTex.textureWidth || parsedTex.width;
          const contentH = parsedTex.textureHeight || parsedTex.height;
          if (contentW > 0 && contentH > 0 && contentW * contentH <= 4096 * 4096) {
            const gl = renderer.gl as WebGL2RenderingContext;
            const frameData: Uint8Array[] = [];
            try {
              for (const img of parsedTex.images) {
                const m0 = img[0];
                if (!m0 || m0.data === undefined || m0.compression !== 0) throw new Error("skip");
                const rowBytes = m0.width * 4;
                const cropped = new Uint8Array(contentW * contentH * 4);
                for (let y = 0; y < contentH; y++) {
                  cropped.set(
                    m0.data.subarray(y * rowBytes, y * rowBytes + contentW * 4),
                    y * contentW * 4,
                  );
                }
                frameData.push(cropped);
              }
            } catch {
              frameData.length = 0; // 任一帧不合预期 → 走常规单帧路径
            }
            if (frameData.length > 1) {
              const glTex = rnd.makeTexture(gl, frameData[0], contentW, contentH, null);
              let idx = 0;
              const timer = window.setInterval(() => {
                if (disposed || rt.paused) return;
                idx = (idx + 1) % frameData.length;
                gl.bindTexture(gl.TEXTURE_2D, glTex);
                gl.texSubImage2D(
                  gl.TEXTURE_2D,
                  0,
                  0,
                  0,
                  contentW,
                  contentH,
                  gl.RGBA,
                  gl.UNSIGNED_BYTE,
                  frameData[idx],
                );
              }, 100);
              (rt.wallpaperDisposers ??= []).push(() => window.clearInterval(timer));
              const entry: any = {
                glTex,
                width: contentW,
                height: contentH,
                rg88: false,
                generated: true,
              };
              entry.declaredWidth = parsedTex.textureWidth;
              entry.declaredHeight = parsedTex.textureHeight;
              textures.set(name, entry);
              reportDiag(
                rt,
                cfg,
                `tex '${name}': animated multi-image, ${frameData.length} frames @ ${contentW}x${contentH}`,
                "info",
              );
              return entry;
            }
          }
        }
        // 这里**只做分类，不解码像素**。分类所需的三个分支全部由 .tex 头部决定
        // （isVideo / freeImageFormat / 尺寸），而 decodeMip0 对「原始格式」这一支
        // 会把整张贴图展开成 RGBA —— 那种贴图的像素结果在本函数里**一次都没被读**
        // （真正要像素的路径在下面的 else 分支，走 decodeMipLevel + 压缩直传）。
        // 实测代价：3662790108（Live Solar System，569MB / 277 张）加载期 4.2s 花在
        // decodeDxtCommon 家族上，全部是这一次被丢掉的展开。
        const m = classifyTexHeader(parsedTex);
        const rg88 = parsedTex.format === 8;
        let entry: any = null;
        if (m.video !== undefined) {
          const url = URL.createObjectURL(new Blob([m.video], { type: "video/mp4" }));
          // 无缝循环对：WebKit 原生 loop 在循环点会冻结一瞬，双元素交接可消除
          const pair = createLoopingVideo(url, {
            muted: true,
            renderDpr: effectiveDpr(rt, cfg),
            maxW: c.clientWidth || window.innerWidth || 1,
            maxH: c.clientHeight || window.innerHeight || 1,
          });
          for (const v of [pair.active, pair.standby]) {
            v.style.cssText =
              "position:fixed;left:-9999px;top:-9999px;width:2px;height:2px;opacity:0;pointer-events:none";
            document.body.appendChild(v);
            // 登记以便 clear(rt)/页面卸载时暂停移除元素并 revoke blob URL
            (rt.videoTextures ??= []).push(v);
          }
          (rt.objectUrls ??= []).push(url);
          (rt.videoPairs ??= []).push(pair);
          pair.active.addEventListener("loadedmetadata", () => {
            reportDiag(rt, cfg, `video tex '${name}': ${pair.active.videoWidth}x${pair.active.videoHeight}`, "info");
          });
          pair.active.addEventListener("error", () => {
            reportDiag(rt, cfg, `video tex '${name}' ERROR: ${pair.active.error?.code}`, "warn");
          });
          // 不要在这里 play()。隐藏层（2887099508「健康壁纸」）一加载就 play，
          // 随后被备用元素/切壁纸 pause 打断，日志刷 AbortError；脚本 init 里
          // 还会马上 stop（3292361861）。可见层在图层循环结束后再起播。
          const endedCbs: Array<() => void> = [];
          const bindEnded = (el: HTMLVideoElement) => {
            for (const cb of endedCbs) el.addEventListener("ended", cb);
          };
          const videoCtl = {
            play: () => {
              if (disposed) return;
              // 只走 pair.resume：它会重启交接 tick。不要再对 active.play()
              // 调第二次——未完成的 play() 被另一次 play() 打断就是 AbortError。
              pair.resume();
            },
            pause: () => pair.pause(),
            stop: () => {
              pair.pause();
              try {
                pair.active.currentTime = 0;
              } catch {
                /* 忽略 */
              }
            },
            isPlaying: () => !pair.active.paused && !pair.active.ended,
            duration: () => (Number.isFinite(pair.active.duration) ? pair.active.duration : 0),
            getCurrentTime: () => pair.active.currentTime || 0,
            setCurrentTime: (t: number) => {
              try {
                pair.active.currentTime = t;
              } catch {
                /* 忽略 */
              }
            },
            getRate: () => pair.active.playbackRate || 1,
            setRate: (r: number) => {
              pair.active.playbackRate = r;
              pair.standby.playbackRate = r;
            },
            getLoop: () => pair.active.loop,
            setLoop: (v: boolean) => {
              pair.active.loop = v;
              pair.standby.loop = v;
            },
            addEndedCallback: (cb: () => void) => {
              endedCbs.push(cb);
              pair.active.addEventListener("ended", cb);
            },
          };
          // entry.video 用 getter 指向当前主元素：交换后渲染器每帧自动采样新元素
          const entry = {
            get video() {
              return pair.active;
            },
            glTex: rnd.makeTexture(renderer.gl, new Uint8Array([0, 0, 0, 0]), 1, 1),
            width: m.width,
            height: m.height,
            rg88: false,
            lastUploaded: -1,
            videoCtl,
          };
          let texSwapCount = 0;
          pair.onSwap = (el) => {
            entry.lastUploaded = -1;
            bindEnded(el);
            // 诊断：首次 + 每 10/100 次上报，确认纹理无缝交换持续生效
            texSwapCount++;
            if (texSwapCount === 1 || texSwapCount === 10 || texSwapCount === 100) {
              reportDiag(rt, cfg, `video tex '${name}' loop swap ok x${texSwapCount}`, "info");
            }
          };
          pair.onFallback = () => {
            reportDiag(rt, cfg, `video tex '${name}' loop fallback (native loop used)`, "warn");
          };
          textures.set(name, entry);
          return entry;
        } else if (m.png !== undefined || (m.image !== undefined && m.fif === tex.FIF.JPEG)) {
          const blob = new Blob([(m.png || m.image) as BlobPart], {
            type: m.png ? "image/png" : "image/jpeg",
          });
          // [we-scene patch] 必须显式 premultiplyAlpha:'none'：浏览器对 PNG 默认
          // 做预乘（实现相关），上传的是预乘纹理，而渲染端混合用直通 alpha ——
          // 半透明边缘的 rgb 被乘两次，所有 1~2px 细线（眼部轮廓/泪痕线/发丝）
          // 变深色刻线，脸上叠出「细框眼镜」（3264246690 实测；同类还见
          // 3148125112 / 3223543799）。
          // [we-scene patch] 且必须对齐 WE 的 FreeImage 语义「不执行 EXIF 方向」：
          // 浏览器解码默认按 EXIF 转正，orientation=8 的 1080×5760 长图会变成
          // 5760×1080，与层 size / 90° 旋转错轴，整屏撕成条带（1920911984）。
          // 详见 tex-decode.ts 头注。
          // [we-scene patch 2026-09-20] 解码期直接降到**目标尺寸**（省掉最贵的全尺寸解码峰值）：
          // 目标 = min(档位上限, 图层足迹)，见 texTargetLong（S4）。R=1 的档位也照样按足迹降。
          const pngNative = Math.max(Number(m.width || 0), Number(m.height || 0)) || 1;
          const pngSkip =
            !!parsedTex?.frames?.list?.length || isSmallTexture(Number(m.width || 0), Number(m.height || 0));
          currentTexNoScale = pngSkip;
          const pngTarget = pngSkip ? pngNative : texTargetLong(normalizedResScale(name), parsedTex) || pngNative;
          const pngScale = Math.min(1, pngTarget / pngNative);
          // [we-scene patch 2026-09-25] 烘焙命中路径：缓存里是**预缩放后的最终位图**
          // （已含 EXIF 方向回滚），所以命中时不再走 decodeTexImageBitmap 的解码/回滚，
          // 只做一次 createImageBitmap。产物按**档位上限**尺寸烘（足迹只会更小），
          // 因此命中后若与本纹理想要的尺寸不同，再做一次廉价的二次缩放 ——
          // 这样 entry.width/height 与现状路径逐位相同，纯贴图尺寸的语义不漂。
          const bakeKey = bakeCache
            ? bakeCacheKey({
                wallKey: source.key ?? `${cfg.mediaBase}/${cfg.src}`,
                texName: name,
                srcBytes: (m.png ?? (m.image as Uint8Array)) as Uint8Array,
                tier: normalizedResScale(name),
              })
            : null;
          const bakeDecision = shouldBakeEmbedded({
            enabled: !!bakeCache,
            scale: pngScale,
            nativeLong: pngNative,
            srcBytes: ((m.png ?? m.image) as Uint8Array)?.length ?? 0,
          });
          const cachedBlob = bakeKey && bakeDecision.bake ? await bakeCache!.get(bakeKey) : null;
          let bmp: ImageBitmap;
          if (cachedBlob) {
            bakeStats.hits++;
            let got = await createImageBitmap(cachedBlob, { premultiplyAlpha: "none" });
            const wantW = Math.max(1, Math.round(Number(m.width || 0) * pngScale));
            const wantH = Math.max(1, Math.round(Number(m.height || 0) * pngScale));
            if (got.width !== wantW || got.height !== wantH) {
              const small = await createImageBitmap(got, {
                resizeWidth: wantW,
                resizeHeight: wantH,
                resizeQuality: "high",
              });
              got.close?.();
              got = small;
            }
            bmp = got;
          } else {
            if (bakeKey && bakeDecision.bake) bakeStats.misses++;
            bmp = await decodeTexImageBitmap(
              blob,
              m.png ? null : (m.image as Uint8Array),
              m.width,
              m.height,
              pngScale,
            );
            // 后台烘焙：bmp 上传后不 close（见下），可安全留给队列编码
            if (bakeKey && bakeDecision.bake) {
              const key = bakeKey;
              const src = bmp;
              bakeQueue.enqueue(async () => {
                const png = await bitmapToPngBlob(src);
                if (!png) return;
                await bakeCache!.set(key, png);
                bakeStats.bytes += png.size;
                bakeStats.baked++;
              });
            }
          }
          if (pngScale < 0.999) {
            mem.scaled.push({
              name,
              how: "decode-resize",
              from: `${m.width}x${m.height}`,
              to: `${bmp.width}x${bmp.height}`,
            });
          }
          entry = {
            glTex: rnd.makeTexture(renderer.gl, null, 0, 0, bmp),
            width: bmp.width,
            height: bmp.height,
            rg88,
          };
        } else if (m.image !== undefined) {
          return null;
        } else {
          // [we-scene patch 2026-09-20] 资源倍率：贴图只需要 ≥ 它在设备像素上的足迹。
          // ① 有真 mip 链（本库 1730/3496 张）→ 取「够用的最小一级」当 level 0 上传，
          //    **零重采样**；② 该级仍明显大于目标 / 单级图 → bilinearResize 到目标。
          // 白名单（LUT 数据栅格、util 小图、法线另档、帧图集单列）见 texResScaleFor()。
          // [we-scene patch 2026-09-20] 白名单：**带帧表（TEXS）的图集**与**本来就小**的贴图
          // 一律不缩。帧矩形同时是布局输入（字体条/序列帧/按钮/时钟），缩放会让字形与列距
          // 变小、动画错位（用户报「过小而动画错误，资源值越小越明显」）；小图本来就只有
          // 几百 KB，省不下内存却最容易踩这类坑。
          const rawPix = parsedTex?.images?.[0]?.[0];
          const rawSkip =
            !!parsedTex?.frames?.list?.length ||
            isSmallTexture(Number(rawPix?.width || 0), Number(rawPix?.height || 0));
          currentTexNoScale = rawSkip;
          const R = rawSkip ? 1 : normalizedResScale(name);
          const target = texTargetLong(R, parsedTex);
          const baseLevel = pickMipLevel(parsedTex, target, R);
          // [we-scene patch 2026-09-20] **压缩纹理直传**：DXT1/3/5、BC7、ETC1/2 在 `.tex`
          // 里就是压缩块（DXT5/BC 1B/px、DXT1 0.5B/px），过去一律解成 RGBA 上传 = 4~8 倍显存。
          // 条件：扩展可用（ETC1/2 是 WebGL2 核心）、非 LUT、未被 resOff/native 关掉。
          // 块级裁剪后尺寸必须与内容一致（POT 填充按 4×4 块裁）。单级压缩贴图也能用
          // （`TEXTURE_MAX_LEVEL=0` 纹理仍然完整），但会失去 mip 缩小平滑 —— 由
          // `?texcompress=0` 可整体回退对照。
          {
            const cInfo = texCompressOn ? rnd.compressedFormatFor(renderer.gl, parsedTex?.format) : null;
            const cMips = parsedTex?.images?.[0];
            if (cInfo && cMips && cMips.length && !(Number(parsedTex?.flags) & 0x40) && !rawSkip) {
              const cLevels: Array<{ width: number; height: number; data: Uint8Array }> = [];
              let cOk = true;
              // [we-scene patch 2026-09-21] 压缩 mip 链的尺寸必须是**严格 floor÷2 金字塔**：
              // WebGL2 的 mipmap 完整性要求第 i 级尺寸恰好 = 第 i-1 级的 floor(w/2)×floor(h/2)，
              // 偏差**任意一级**（哪怕 1px）整张纹理不完整 → 采样恒黑且**无任何 GL 报错**。
              // 旧实现按 `round(content/2^k)` 再 ceil 到 4 的倍数（1080→540→270→272→136…），
              // 内容尺寸非 4 幂的贴图（1920×1080、人物图集…）全数中招 —— 3463520581 的
              // sky/人物整片黑块、云（POT 尺寸）正常，就是这条（全库 31 张压缩直传壁纸
              // 基本全踩）。离线判据：comptest 链A mean=0.0 / 链B mean=146.6（同一份块）。
              // level0 取内容尺寸块对齐；其后每级 floor÷2，数据从文件画布裁（内容在左上角，
              // 与 decodeMipLevel 的裁剪口径一致）；文件 mip 用完就截断（MAX_LEVEL 收到
              // 已传的末级，纹理仍完整）。单级贴图无链可言，天然完整。
              const cW0raw = Math.max(1, Math.floor(Number(parsedTex?.width || cMips[0].width) / 2 ** baseLevel));
              const cH0raw = Math.max(1, Math.floor(Number(parsedTex?.height || cMips[0].height) / 2 ** baseLevel));
              const cW0 = Math.min(cMips[baseLevel].width, Math.ceil(cW0raw / 4) * 4);
              const cH0 = Math.min(cMips[baseLevel].height, Math.ceil(cH0raw / 4) * 4);
              for (let i = 0; i < cMips.length - baseLevel; i++) {
                const m = cMips[baseLevel + i];
                const bw = Math.max(1, Math.floor(cW0 / 2 ** i));
                const bh = Math.max(1, Math.floor(cH0 / 2 ** i));
                if (bw > m.width || bh > m.height) break; // 文件画布盖不住该级 → 截断链（仍完整）
                // [we-scene patch 2026-09-21] **宽、高两轴都对齐画布**才能原样上传：
                // 内容尺寸恰好等于画布时不裁；否则按 4×4 块裁（cropBlocks 对 sbw===dbw
                // 的行主序布局截掉尾部多余块行）。数据长度对账，对不上回退 RGBA。
                const data =
                  bw === m.width && bh === m.height
                    ? m.data
                    : tex.cropBlocks(m.data, m.width, bw, bh, cInfo.blockBytes);
                if (data.length !== Math.ceil(bw / 4) * Math.ceil(bh / 4) * cInfo.blockBytes) {
                  cOk = false;
                  break;
                }
                cLevels.push({ width: bw, height: bh, data });
              }
              if (cOk && cLevels.length) {
                const gl = renderer.gl;
                const lv0 = cLevels[0];
                entry = {
                  glTex: rnd.makeCompressedTextureMip(gl, cLevels, cInfo.internalFormat),
                  width: lv0.width,
                  height: lv0.height,
                  rg88: false,
                  compressed: true,
                  cpuMips: null,
                  looksAlbedo: false,
                  // DXT/BC/ETC 家族在 WE 里是 `normal.xw = normal.wx`（x 在 A、蒙版在 R）
                  packedNormal: true,
                  mipLevel: baseLevel,
                };
                mem.compressed += lv0.width * lv0.height * (parsedTex.format === 7 ? 0.5 : 1);
                mem.scaled.push({ name, how: `compressed-${parsedTex.format}${baseLevel ? `+mip${baseLevel}` : ""}`, from: `${rawPix?.width}x${rawPix?.height}`, to: `${lv0.width}x${lv0.height}` });
              }
            }
          }
          // 压缩路径命中就不再解 RGBA（也不再覆盖 entry）
          const m0 = (entry
            ? null
            : tex.decodeMipLevel(parsedTex, baseLevel)) as { width: number; height: number; rgba?: Uint8Array; png?: unknown; image?: unknown; video?: unknown; level?: number } | null;
          // R8 直传（1 B/px）：格式 9、非 LUT、非跳过项、开关未关（内嵌 PNG/JPEG/视频除外）
          const r8Native =
            !entry &&
            texR8On &&
            Number(parsedTex?.format) === 9 &&
            !rawSkip &&
            !(Number(parsedTex?.flags) & 0x40) &&
            m0 != null &&
            m0.png === undefined && m0.image === undefined && m0.video === undefined;
          if (!entry && m0 && (m0.png !== undefined || m0.image !== undefined || m0.video !== undefined)) {
            // 选中的级是内嵌 PNG/JPEG/视频：退回 mip0 路径（上面 png/video 分支只处理 level0，
            // 「多级 + 内嵌」的罕见组合保守起见不缩放）
            const m00 = tex.decodeMip0(parsedTex) as { width: number; height: number; rgba: Uint8Array };
            entry = {
              glTex: rnd.makeTextureMip(renderer.gl, [m00], rg88),
              width: m00.width,
              height: m00.height,
              rg88,
              cpuMips: [m00],
            };
            mem.cpuDecoded += m00.rgba.byteLength;
          } else if (!entry && r8Native && m0) {
            // [we-scene patch 2026-09-20] **R8 直传**（1 B/px + generateMipmap）：
            // 从解码像素取 R 通道（解码器把 fileR 铺进 rgb、alpha 恒 255），
            // 由消费端着色器做 WE 语义映射（粒子 shader 的 u_albedoR8）。
            const a0 = m0 as { width: number; height: number; rgba: Uint8Array };
            const n = a0.width * a0.height;
            const r8 = new Uint8Array(n);
            for (let i = 0; i < n; i++) r8[i] = a0.rgba[i * 4];
            entry = {
              glTex: rnd.makeR8TextureMip(renderer.gl, [{ width: a0.width, height: a0.height, data: r8 }]),
              width: a0.width,
              height: a0.height,
              rg88: false,
              r8: true,
              albedoR8: true,
              cpuMips: null,
              looksAlbedo: false,
              packedNormal: false,
              mipLevel: baseLevel,
            };
            mem.r8Native += n;
            mem.scaled.push({ name, how: `r8${baseLevel ? `+mip${baseLevel}` : ""}`, from: `${rawPix?.width}x${rawPix?.height}`, to: `${a0.width}x${a0.height}` });
          } else if (!entry) {
            const m0r = m0 as { width: number; height: number; rgba: Uint8Array };
            const long0 = Math.max(m0r.width, m0r.height);
            const mips = parsedTex.images?.[0]?.length || 1;
            const tw = Math.max(1, Math.round((m0r.width * target) / long0));
            const th = Math.max(1, Math.round((m0r.height * target) / long0));
            let shrunk: { width: number; height: number; rgba: Uint8Array } = m0r;
            let bmp: ImageBitmap | null = null;
            let how = baseLevel > 0 ? `mip${baseLevel}` : "";
            if (baseLevel === 0 && mips === 1 && target > 0 && long0 > target) {
              // 单级贴图：没有 mip 可用，只能重采样。形状/蒙版格式（RG88/R8）与带 alpha 的
              // 贴图走 JS 精确重采样（保通道语义、无预乘舍入）；不透明彩图走浏览器原生缩放。
              if (rg88 || looksOpaquePure(m0r.rgba)) {
                const viaBitmap = !rg88 ? await scaleViaBitmap(m0r, tw, th) : null;
                if (viaBitmap) {
                  bmp = viaBitmap;
                  shrunk = { width: viaBitmap.width, height: viaBitmap.height, rgba: m0r.rgba };
                  how = "resample-native";
                } else if (m0r.width * m0r.height <= 16e6 || rg88) {
                  shrunk = shrinkDecoded(m0r, target);
                  how = "resample";
                } else {
                  how = "skip-big-alpha";
                }
              } else if (m0r.width * m0r.height <= 16e6) {
                shrunk = shrinkDecoded(m0r, target);
                how = "resample";
              } else {
                how = "skip-big-alpha";
              }
            }
            // CPU 副本：只有「看起来是反照率」的贴图必须留着（材质把反照率填进法线槽时
            // asParticleNormal 要就地转 bump 图）；其余上传完即释放（4K 一张就是 67MB）。
            const albedoLike = ptex.rgbaLooksLikeAlbedo(m0r.rgba);
            entry = {
              glTex: bmp
                ? rnd.makeTexture(renderer.gl, null, 0, 0, bmp)
                : rnd.makeTextureMip(renderer.gl, [shrunk], rg88),
              width: shrunk.width,
              height: shrunk.height,
              rg88: bmp ? false : rg88,
              cpuMips: albedoLike ? [shrunk] : null,
              looksAlbedo: albedoLike,
              // 打包判定必须在**原始解码像素**上做（native 缩放后的 bitmap 拿不到像素）
              packedNormal: ptex.isPackedNormalTexture(m0r),
              mipLevel: baseLevel,
            };
            mem.cpuDecoded += m0r.rgba.byteLength;
            if (!albedoLike) mem.cpuReleased += m0r.rgba.byteLength;
            if (how) {
              mem.scaled.push({ name, how, from: `${parsedTex.images[0][0].width}x${parsedTex.images[0][0].height}`, to: `${shrunk.width}x${shrunk.height}` });
            }
          }
        }
        if (!entry) return null;
        // [we-scene patch] .tex flags bit1 = TEXI「clamp uvs」标记（官方导出器写入，
        // 229 张带 .tex-json sidecar 的素材里与 clampuvs 布尔逐一吻合、零反例）：
        // 效果链槽 1+ 绑定纹理时据此选 CLAMP/REPEAT。没有它时渲染器按 WE 缺省
        // REPEAT（waterripple 法线槽需要），但 xray 的 sprite（particle/halo_6，
        // 该位=1）必须 CLAMP，否则开窗形状无限平铺（2212279721）。
        entry.clampUvs = (Number(parsedTex.flags) & 2) !== 0;
        // 序列帧表（.tex 的 TEXS 段）：粒子与序列帧图层据此切 sprite sheet。
        // 没有它就只能按 sequencemultiplier 猜 N×N 方格，对横排/竖排 sheet 会采错图块。
        // 挂**整个 frames 对象**（含 atlasWidth/Height）而不只是 list：帧矩形的
        // 归一化分母必须是图集真实像素尺寸。1444077782 的 .tex 头部声明 316x214
        // （那是单帧尺寸），mip0 实为 2048x1024 —— 用错分母整表错位。
        // 粒子端历史上只吃数组，故保留 list 别名兼容（见 particles.js）。
        // [we-scene patch] .tex 头部声明的单帧尺寸。entry.width/height 是上传
        // 图集尺寸（可能被 POT 填充放大到 2048x1024），WE autosize 模型要的是
        // 头部声明的单帧尺寸（316x214 这类）—— 见图层装配的 autosize 回退。
        entry.declaredWidth = parsedTex.textureWidth;
        entry.declaredHeight = parsedTex.textureHeight;
        if (parsedTex.frames?.list?.length) {
          const fl = parsedTex.frames.list as unknown[];
          // 分母跟实际上传尺寸走，不跟 parseTex 的 mip0 声明走：有 TEXS 时
          // decodeMip0 不再裁 POT 填充，entry.width 就是采样用的图集大小。
          (fl as unknown as Record<string, unknown>).atlasWidth = entry.width;
          (fl as unknown as Record<string, unknown>).atlasHeight = entry.height;
          // [we-scene patch 2026-09-20] 降采样后帧矩形必须**同倍率缩放**：uv 是
          // 「原像素 / 原图集宽」，缩放后必须仍是同一个归一化矩形，否则粒子采到邻帧。
          // 但**几何**（autosize 用的单帧尺寸）不能跟着缩 —— 那是图层世界尺寸的来源，
          // 缩了整层会变小。原值另存 entry.geomFrame 供 autosize 使用。
          const fr0 = fl[0] as { width?: number; height?: number } | undefined;
          entry.geomFrame = {
            width: Math.abs(Number(fr0?.width ?? entry.declaredWidth ?? 0)),
            height: Math.abs(Number(fr0?.height ?? entry.declaredHeight ?? 0)),
          };
          // 原生图集宽 = mip0 的宽（帧坐标写在 mip0 像素空间，见 decodeMip0 注释）
          const nativeW =
            Number((fl as unknown as Record<string, unknown>).nativeAtlasWidth) ||
            Number(parsedTex.images?.[0]?.[0]?.width || 0) ||
            entry.width;
          (fl as unknown as Record<string, unknown>).nativeAtlasWidth = nativeW;
          const k = nativeW > 0 ? entry.width / nativeW : 1;
          if (k < 0.999) {
            scaleFrames(fl as unknown as Array<{ x: number; y: number; width: number; height: number }>, k);
            mem.framesScaled.push(`${name} x${k.toFixed(3)}`);
          }
          entry.frames = fl;
        }
        // [we-scene patch 2026-09-20] CPU 侧像素用完就放：只有「看起来是反照率」的贴图
        // 还需要留着做「反照率被填进法线槽」的兜底转换（asParticleNormal），其余一律释放。
        // 判据在地板附近采样 48 点，成本可忽略；释放的是整张贴图的 W×H×4（4K 就是 64MB×N）。
        {
          // 原始像素路径已在上面判过并释放；这里只兜 PNG/多图/回退路径（没有 CPU 像素可放）
          if (entry.looksAlbedo === undefined && entry.glTex) {
            const cpu = entry.cpuMips && entry.cpuMips[0];
            entry.looksAlbedo = cpu?.rgba ? ptex.rgbaLooksLikeAlbedo(cpu.rgba) : false;
            if (entry.packedNormal === undefined) entry.packedNormal = cpu?.rgba ? ptex.isPackedNormalTexture(cpu) : false;
            if (!entry.looksAlbedo && entry.cpuMips) {
              mem.cpuReleased += cpu?.rgba ? cpu.rgba.byteLength : 0;
              entry.cpuMips = null;
            }
          }
        }
        entry.resourceScale = normalizedResScale(name);
        mem.texCount++;
        // 上传字节：压缩块按块大小、R8 按 1 B/px，其余 RGBA/RG88 走原口径（都含 mip 链 ×4/3）
        {
          const fmt = Number(parsedTex?.format);
          const perPx = entry.compressed
            ? fmt === 7 || fmt === 3
              ? 0.5
              : 1
            : entry.r8
              ? 1
              : entry.rg88
                ? 2
                : 4;
          mem.gpuUploaded += Math.round(entry.width * entry.height * perPx * (4 / 3));
        }
        // [S4 对账表] 每张贴图：原生内容边 / 图层足迹（设备像素）/ 实际目标 / 落到的 mip 级
        mem.textures.push({
          name,
          size: `${entry.width}x${entry.height}`,
          scale: entry.resourceScale,
          level: entry.mipLevel ?? 0,
          native: texNativeLong(parsedTex),
          need: Math.round(texFootprint.get(name) || 0),
          target: texTargetLong(entry.resourceScale, parsedTex),
        });
        textures.set(name, entry);
        // [临时诊断] 定位 843532366 黑屏：贴图装载的运行时状态
        reportDiag(
          rt,
          cfg,
          `tex '${name}': ${entry.width}x${entry.height} declared=${entry.declaredWidth}x${entry.declaredHeight} R=${entry.resourceScale} lvl=${entry.mipLevel ?? 0} frames=${Array.isArray(entry.frames) ? entry.frames.length : "none"} video=${!!entry.videoCtl}`,
          "info",
        );
        return entry;
      };
      const loadTex = (name: string): Promise<any | null> => {
        if (textures.has(name)) return Promise.resolve(textures.get(name));
        const hit = texInflight.get(name);
        if (hit) return hit;
        const p = loadTexInner(name);
        texInflight.set(name, p);
        void p.finally(() => {
          if (texInflight.get(name) === p) texInflight.delete(name);
        });
        return p;
      };
      /**
       * [we-scene patch 3243449890] 用户图片槽的**热更**取图。
       *
       * 三条语义，缺一条都表现为「属性改了画面不动或回不去」：
       *  - 新值可取图 → 换成新贴图（loadTexInner 的属性分支按现值拉文件）；
       *  - 值被清空 → 删条目，渲染端自然回落到作者原槽贴图（parse 的
       *    textureFallbacks，可能正是跨层合成图 `_rt_imageLayerComposite_*`）；
       *  - 值没变 → 直接返回（宿主整表重发属性时不白删白建 GL 纹理）。
       * 删条目要连 GL 纹理一起删，否则每换一次图就漏一张；但同一条目可能被两个
       * 名字共用（`$mediaPreviousThumbnail` 顺位共用当前封面），被别处引用时只解表。
       */
      const refreshPropTexture = async (name: string) => {
        const val = (liveUserProps as Record<string, unknown> | null)?.[name];
        const next =
          typeof val === "string" && val.includes("/") && /\.[a-z0-9]{2,5}$/i.test(val) ? val : "";
        if (propTexLoadedValue.get(name) === next) return;
        propTexLoadedValue.set(name, next);
        const prev = textures.get(name);
        if (prev) {
          let refs = 0;
          for (const e of textures.values()) if (e === prev) refs++;
          if (refs <= 1) {
            try {
              prev.videoCtl?.stop?.();
            } catch {
              /* 停不掉也不影响换图 */
            }
            if (prev.glTex) (renderer.gl as WebGL2RenderingContext).deleteTexture(prev.glTex);
          }
          textures.delete(name);
        }
        if (!next) {
          reportDiag(rt, cfg, `prop tex '${name}' → 空，回落作者原槽贴图`, "warn");
          return;
        }
        const entry = await loadTex(name);
        reportDiag(
          rt,
          cfg,
          `prop tex '${name}' → ${next}${entry ? ` ${entry.width}x${entry.height}` : "（取图失败，回落原槽贴图）"}`,
          "warn",
        );
      };

      // [we-scene patch] 预载效果 shader 里 sampler 槽声明的默认贴图。
      // 形如 `uniform sampler2D g_Texture2; // {"material":"sprite","default":"particle/halo_6"}`
      // —— scene.json 该槽为 null 时渲染器会回退到这个名字（见 renderer.js 的
      // parseSamplerDefaults），但 textures 是普通 Map、渲染期无法异步加载，故先备好。
      // 只认贴图路径形态的 default（数值型 default 由 bindConstants 走另一条路）。
      const SAMPLER_DEFAULT_RE = /uniform\s+sampler2D\s+g_Texture\d+\s*;\s*\/\/[^\n]*"default"\s*:\s*"([^"]+)"/g;
      const preloadSamplerDefaults = async (effect: any) => {
        for (const mp of effect.materialPasses || []) {
          if (!mp.shader) continue;
          for (const stage of ["frag", "vert"]) {
            // getEntry 缺条目返回 null，readText 收 Uint8Array —— 必须先判空
            const bytes = pkg.getEntry(parsedPkg, `shaders/${mp.shader}.${stage}`);
            if (!bytes) continue;
            const src = readText(bytes);
            SAMPLER_DEFAULT_RE.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = SAMPLER_DEFAULT_RE.exec(src)) !== null) {
              const name = m[1];
              if (!name || name.startsWith("util/") || name.startsWith("_rt_")) continue;
              if (textures.has(name)) continue;
              await loadTex(name);
            }
          }
        }
      };

      // [we-scene patch 2026-09-20] 资源分辨率台账（S0）：清晰度变化时贴图实际缩了多少、
      // 释放了多少 CPU 副本，都能直接读出来。`?resources=native` 可 A/B。
      (window as unknown as Record<string, unknown>).__memStats = () => ({
        resourceScale: resScaleBase,
        resourceScaleNormal: resScaleNormal,
        texCount: mem.texCount,
        cpuDecodedMB: +(mem.cpuDecoded / 1e6).toFixed(1),
        cpuReleasedMB: +(mem.cpuReleased / 1e6).toFixed(1),
        gpuUploadedMB: +(mem.gpuUploaded / 1e6).toFixed(1),
        compressedMB: +(mem.compressed / 1e6).toFixed(1),
        r8NativeMB: +(mem.r8Native / 1e6).toFixed(1),
        pkgBytes: mem.pkgBytes || 0,
        framesScaled: mem.framesScaled.slice(0, 20),
        scaledCount: mem.scaled.length,
        scaled: mem.scaled.slice(0, 40),
        textures: mem.textures.slice(0, 60),
        // 贴图烘焙（B3）的正式统计：命中/补烘/产物/后台耗时。后端说明：
        // cache-api = 跨页面与跨启动持久，memory = 仅本页，off = 烘焙已关闭
        bake: {
          enabled: bakeStats.enabled,
          backend: bakeStats.backend,
          hits: bakeStats.hits,
          misses: bakeStats.misses,
          baked: bakeStats.baked,
          failed: bakeStats.failed,
          bytesMB: +(bakeStats.bytes / 1e6).toFixed(2),
          ms: Math.round(bakeStats.ms),
        },
      });
      let loadedTex = 0;
      const texJobs: Promise<unknown>[] = [];
      for (let li = 0; li < scene.layers.length; li++) {
        const layer = scene.layers[li];
        if (!layer.image) continue;
        try {
          let model: unknown;
          if (eff.BUILTIN_MODELS[layer.image]) {
            model = eff.BUILTIN_MODELS[layer.image];
          } else {
            const modelEntry = pkg.getEntry(parsedPkg, layer.image);
            if (!modelEntry) continue;
            model = JSON.parse(readText(modelEntry));
          }
          // 编辑器实例化的纯色层：模型带 solidlayer:true，image 不是 util/solidlayer。
          // 必须在找材质之前写回，缺材质时下面会 continue，但 solid 已经够渲染器喂 whiteTex。
          scn.applySolidFromModel(layer, model);
          // [we-scene patch] 编辑器实例的用户纹理绑定（instance.usertextures）：
          // 相册封面类组件的标准做法——实例 solid 模型槽 0 默认 fill 是 util/white，
          // 真正内容通过 usertextures 绑 WE 保留纹理 $mediaThumbnail。缺绑定时
          // solid 白底直接画出白方块（3789462324 左下角）。槽 0 绑到已就绪的
          // 保留纹理时清 solid 并把 textureName 指过去：渲染端
          // `!layer.solid && textureName` 才取纹理，solid 恒赢。绑不到（媒体源
          // 没给封面）时保持 solid 兜底。type:"usershortcut"（spotify 快捷方式）
          // 等非纹理绑定不处理。本地库 12 张 / 14 层，$mediaThumbnail 占 9。
          const instUt = (layer as any).srcObject?.instance?.usertextures as
            | Array<{ name?: string; type?: string } | null>
            | undefined;
          const instUtName =
            instUt?.[0] && typeof instUt[0].name === "string" && instUt[0].name.startsWith("$")
              ? instUt[0].name
              : null;
          // 只在保留纹理真实就绪时才占位；否则维持 solid 兜底并登记**迟到绑定**：
          // 真实封面多在装配完成后才上传，不回头补绑的话封面位永远是 solid 块
          const instBoundTex = instUtName && textures.has(instUtName) ? instUtName : null;
          if (instBoundTex) {
            (layer as any).textureName = instBoundTex;
            (layer as any).solid = false;
          } else if (instUtName) {
            pendingInstanceMedia.push({ layer, name: instUtName });
          }
          // [we-scene patch] 图层 size 缺省时从模型尺寸回退：820654165 等场景的
          // 简单图片层不带 size 字段，parseScene 默认 [0, 0]，导致 layerModelMatrix
          // 算出 w=h=0 → quad 不可见。模型有 width/height 时用它补上。
          if (model && typeof model === 'object' && 'width' in (model as any) && 'height' in (model as any)) {
            const m = model as { width: number; height: number };
            if ((layer.size?.[0] || 0) === 0 && (layer.size?.[1] || 0) === 0 && m.width > 0 && m.height > 0) {
              layer.size = [m.width, m.height];
            }
          }
          const mat = scn.resolveMaterial(model);
          if (!mat) continue;
          // cropoffset 不得加进 origin（CASEBOOK 2341 / verify-groups I5c）：
          // origin 已是最终世界坐标；2477602742 的 Mountain crop.y=−358 等会把
          // 地面层整块拽开露出 clearcolor 灰带。3233141951 装饰层对齐走 mirage 视差。
          let material: unknown;
          if (eff.BUILTIN_MATERIALS[mat.materialPath]) {
            material = eff.BUILTIN_MATERIALS[mat.materialPath];
          } else {
            const matEntry = pkg.getEntry(parsedPkg, mat.materialPath);
            if (!matEntry) {
              // 实例 solid 的 material 是 util/solidlayer_instance*.json，pkg 里没有。
              // 不能 continue：否则连挂在这层上的效果链都不解析，而且即便已置 solid，
              // 后面若有人把 solid 判据改回去，背景会再变透明。
              if (layer.solid && eff.BUILTIN_MATERIALS["materials/util/solidlayer.json"]) {
                material = eff.BUILTIN_MATERIALS["materials/util/solidlayer.json"];
              } else {
                continue;
              }
            } else {
              material = readMaterialDoc(matEntry);
            }
          }
          const pass = (material as {
            passes?: Array<{
              textures?: string[];
              combos?: Record<string, unknown>;
              shader?: string;
              blending?: string;
              constantshadervalues?: Record<string, unknown>;
            }>;
          }).passes?.[0];
          const texSlots = pass?.textures || [];
          const texName = texSlots[0];
          // 基色材质 blending 字段（additive/translucent/normal）：对象无 colorBlendMode
          // 时合成层按它走（2734266359 spot overlay 黑底光斑必须加法，否则黑方块）。
          (layer as any).materialBlending = typeof pass?.blending === "string" ? pass.blending : null;
          // [we-scene patch] 序列帧图层：material 的 combos 里 spritesheet=1 表示这张
          // 贴图是 sprite sheet，图层的 size 是**单帧尺寸**，渲染时只该采样当前那一格
          // （帧表来自 .tex 的 TEXS 段，见 loadTex 里 entry.frames）。
          // 不置这个标志的话整张 sheet 会铺满 quad —— 3250755486 的猫在碎玻璃后
          // 显示成 6x7 贴图网格而非逐帧动画。全库 52 层 / 7 壁纸。
          // combo 键名**大小写两种写法都存在**：3250755486/3299228616 用 `SPRITESHEET`，
          // 3292361861/3790527023/1444077782 用小写 `spritesheet`。只认大写会漏掉
          // 后三个壁纸的 12 层（含全部开关按钮）。
          if (pass?.combos) {
            for (const k of Object.keys(pass.combos)) {
              const kl = k.toLowerCase();
              if (kl === "spritesheet" && Number(pass.combos[k]) === 1) {
                (layer as any).spriteSheet = true;
              }
              // [we-scene patch] genericimage*/genericpuppet 系列材质的 LIGHTING
              // combo（官方 shader：#if LIGHTING 时
              //   ambient = max(0.001, g_LightAmbientColor) * albedo
              //   color = CombineLighting(directLight, ambient)）。
              // 全库仅 4 个 pass 开启（2872267921/2890473419/3351179520/
              // 3509243656），且 NORMALMAP 全为 0 —— 2D 正交层法线恒 +Z、场景无
              // 灯光对象时 PBR 直射项为 0，CombineLighting 退化为
              // color = albedo * g_LightAmbientColor。这里把场景 ambientcolor 乘进
              // 基色；不开 LIGHTING 的材质（99.9%）一律不碰，零回归面。
              // generic.frag（带法线网格）另用 skylight 按 N.y 混合，本仓不跑那条
              // 完整 PBR，故不处理 skylight（无 NORMALMAP 材质时两源同色，无差别）。
              if (kl === "lighting" && Number(pass.combos[k]) === 1) {
                (layer as any).lightingEnabled = true;
              }
            }
          }
          // [we-scene patch] 材质 shader 名 → 直射光模型（渲染侧
          // `lightModelForShader` 查表）：`genericimage2` 那代走**老通道**
          // （`point` 灯 + radius²/d²），genericimage3 走 V1 通道的 radius²/d²，
          // generic4/genericimage4 走 V1 通道的 `saturate(1−d/radius)^exponent`。
          // 这里只记材质事实，公式与通道分派留在渲染侧一处，免得两边各写一份映射。
          // 灯对象按**类型串**分通道（`l*` vs `point`），两层要对上才出光：
          // 3737267090 是 lpoint + genericimage4（V1 对 V1），2890473419 是
          // point + genericimage2（老通道对老通道），互补。
          if ((layer as any).lightingEnabled && typeof pass?.shader === "string") {
            (layer as any).lightShader = pass.shader;
          }
          // [we-scene patch] PBR 材质参数（官方 common_pbr.h 的 ComputePBRLight 吃
          // f0/roughness/metallic）：材质 constantshadervalues 的 metallic/roughness，
          // 缺省 0.5/0.5（官方 uniform 声明的 default）。只给开了 LIGHTING 的层读，
          // 别的层不碰。铁律：roughness=0 时 GGX 的 NDF 恒 0 → 镜面项为 0
          // （2890473419 的材质正是 metallic 0 / roughness 0，最终只有漫反射项）。
          {
            const csv = (pass as { constantshadervalues?: Record<string, unknown> } | undefined)
              ?.constantshadervalues;
            const num = (v: unknown, d: number): number => {
              const raw = (v && typeof v === "object" && "value" in (v as object)) ? (v as any).value : v;
              const n = Number(raw);
              return Number.isFinite(n) ? n : d;
            };
            if ((layer as any).lightingEnabled && csv && (csv.metallic !== undefined || csv.roughness !== undefined)) {
              (layer as any).lightMetallic = num(csv.metallic, 0.5);
              (layer as any).lightRoughness = num(csv.roughness, 0.5);
            }
          }
          // 图层材质可能有多槽（flowimage = background + flowmask）。只载 [0]
          // 会让流水 shader 的 g_Texture1 落到白纹理，位移恒 0，星云完全不动。
          // [we-scene patch] 图层材质的 `usertextures`（预设壁纸的**用户图片槽**）：
          // 材质声明 `textures:["City Video"], usertextures:["customimageright"]`
          // —— 槽名是用户属性名，现值是壁纸目录下的相对路径（`files/xxx.gif`）。
          // 属性有值就加载用户选的图并**注册到属性名**下（渲染端按合并后的槽名
          // 查表，命中即用；查不到才回落到作者占位），槽 0 同时改写
          // layer.textureName，使视频/动图纹理的起播与探针都指向真实内容。
          const layerUts = (pass as { usertextures?: Array<string | { name?: string } | null> } | undefined)
            ?.usertextures;
          const utNameAt = (i: number): string | null => {
            const u = layerUts?.[i];
            if (typeof u === "string" && u) return u;
            if (u && typeof u === "object" && typeof u.name === "string" && u.name) return u.name;
            return null;
          };
          for (let si = 0; si < Math.max(texSlots.length, layerUts?.length || 0); si++) {
            const propName = utNameAt(si);
            if (!propName) continue;
            // [we-scene patch 3243449890] 材质槽上的属性名同样登记进用户图片槽表：
            // 热更时按新值重取图/清空回落，与效果 pass 槽走同一条链路。
            if (!propName.startsWith("$")) {
              propTexSlots.add(propName);
              propTexLoadedValue.set(
                propName,
                typeof liveUserProps[propName] === "string" && liveUserProps[propName]
                  ? String(liveUserProps[propName])
                  : "",
              );
            }
            const pv = (liveUserProps as Record<string, unknown> | null)?.[propName];
            if (typeof pv !== "string" || !pv || !pv.includes("/") || !/\.[a-z0-9]{2,5}$/i.test(pv)) continue;
            texJobs.push(
              loadTex(propName).then((entry) => {
                if (entry && si === 0) layer.textureName = propName;
              }),
            );
          }
          // [we-scene patch] 图层**自身材质**的 usertextures 保留名（全库 24 处 /
          // 19 张；3151551777 的 models/album.json：textures[0]=album2 内置封面、
          // usertextures[0]=$mediaThumbnail）：真实封面优先级高于作者内置封面。
          // 上面的用户图片槽循环只认属性文件路径，保留名会被漏掉；槽 0 已就绪就
          // 立刻切 textureName，没就绪则登记**迟到绑定**（与实例层同一张表），
          // 真实封面上传后顶替掉内置占位图。只处理非 solid 普通层，不碰实例
          // （实例的保留名在 instance.usertextures，前面已处理）。
          if (!layer.solid) {
            for (let si = 0; si < (layerUts?.length || 0); si++) {
              const reserved = utNameAt(si);
              if (!reserved || !reserved.startsWith("$")) continue;
              if (si === 0) {
                if (textures.has(reserved)) {
                  layer.textureName = reserved;
                } else {
                  pendingInstanceMedia.push({ layer, name: reserved });
                }
              }
            }
          }
          for (let si = 0; si < texSlots.length; si++) {
            const tn = texSlots[si];
            if (typeof tn !== "string" || !tn || tn.startsWith("util/") || tn.startsWith("_rt_")) continue;
            texJobs.push(
              loadTex(tn).then((entry) => {
                if (!entry) return;
                // 实例/材质保留纹理占用槽 0 时不得回写模型默认贴图（异步 then 晚于绑定）
                if (si === 0 && !instBoundTex && !pendingInstanceMedia.some((p) => p.layer === layer)) {
                  layer.textureName = tn;
                  loadedTex++;
                  if (entry.videoCtl) (layer as any).videoCtl = entry.videoCtl;
                  // [we-scene patch] WE autosize 模型（GIF 导入模板 843532366 等）：
                  // 模型/图层都不带尺寸，层尺寸 = 贴图**单帧**尺寸 —— 雪碧图取帧表
                  // 首帧，普通 .tex 取头部声明尺寸。缺它时 layer.size=[0,0] →
                  // quad 不可见 → 整屏黑（createLayer 动态建层路径已有同款回退）。
                  reportDiag(
                    rt,
                    cfg,
                    `autosize gate: model.autosize=${(model as any)?.autosize} size=${layer.size?.[0]}x${layer.size?.[1]}`,
                    "info",
                  );
                  if (
                    (model as any)?.autosize &&
                    layer.size &&
                    (layer.size[0] === 0 || layer.size[1] === 0)
                  ) {
                    // 帧表是仿射 UV 基（uDirX/vDirY 可为负：旋转/镜像打包的帧），
                    // 尺寸取绝对值；非法时回退 .tex 头部声明尺寸
                    const f0 =
                      Array.isArray(entry.frames) && entry.frames.length ? entry.frames[0] : null;
                    const fw = Math.abs(Number(f0?.width ?? 0));
                    const fh = Math.abs(Number(f0?.height ?? 0));
                    // [we-scene patch 2026-09-20] 几何取**原始**单帧尺寸（geomFrame）：
                    // 资源倍率只改上传的像素密度，不改图层世界尺寸。降采样后 entry.frames
                    // 的矩形已按倍率缩小（采样要按上传尺寸归一化），直接拿来当尺寸会让整层变小。
                    const gw = Math.abs(Number(entry.geomFrame?.width || 0));
                    const gh = Math.abs(Number(entry.geomFrame?.height || 0));
                    const w = gw > 0 ? gw : fw > 0 ? fw : Number(entry.declaredWidth || 0);
                    const h = gh > 0 ? gh : fh > 0 ? fh : Number(entry.declaredHeight || 0);
                    if (w > 0 && h > 0) {
                      layer.size = [w, h];
                      // [临时诊断]
                      reportDiag(rt, cfg, `autosize applied: layer.size=${w}x${h}`, "info");
                    } else {
                      // [临时诊断]
                      reportDiag(rt, cfg, `autosize skipped: fw=${fw} fh=${fh} declared=${entry.declaredWidth}x${entry.declaredHeight}`, "info");
                    }
                  }
                }
              }),
            );
          }
          // [we-scene patch] 图层材质 shader（非 genericimage*）挂进效果链。
          // 833227004 / 820654165 的「会动」写在 flowimage，不在 scene.effects。
          // 颜色类物性（eagleflag 的 `{schemecolor:color1, flagcolor1:color2, flagcolor2:color3}`）
          // 由 registerMaterialDoc 的 applyUserShaderValues 统一注入 —— 材质文档一读进来
          // 就处理了，与本条挂载门无关（F42 只修「挂不上」这一段）。
          // [we-scene patch 2026-10-03] **引擎内置 shader 不再被「包内有没有」挡掉**（F42）：
          // WE 自带 shader（`flag` 等）本就不进 pkg，此前 `pkg.getEntry` 为 null ⇒ 整条材质
          // 条目从不建，图层退回「贴图直出」—— eagleflag 的通道图（r/g/b = 三个颜色权重）
          // 被当反照率画出来，就是荧光绿/品红一片。现在：包内有 OR 本仓内置表里有 → 挂。
          if (pass?.shader && (pkg.getEntry(parsedPkg, `shaders/${pass.shader}.frag`) || WE_BUILTIN_SHADERS[`${pass.shader}.frag`])) {
            eff.attachLayerMaterialEffect(layer, pass);
          }
          // [we-scene patch] `generic4` 材质的 color/alpha/brightness 常量：官方该 shader 里
          // `albedo.rgb *= g_TintColor` / `*= g_Brightness` / `albedo.a *= g_TintAlpha` 是
          // **无条件**应用的，而且它没有 genericimage 那套 `#ifdef VERSION … g_Color4` 分支
          // —— 这类图层的颜色在 WE 里就靠材质常量承载。本仓库用替身着色器、此前只读
          // layer.color/brightness/alpha，于是这些常量被整片忽略（全库 263 处 color +
          // 27 处 brightness，例：EmMumbiesEye 的红眼 `1 0 0`、EfIceCubeWarp 的浅蓝
          // `0.427 0.745 1`、sun 的 brightness=10、行星的 brightness=2）。
          //
          // 只认 generic4：genericimage2/3 的 Brightness/Alpha 属于 `#ifndef VERSION`
          // 旧分支，与 g_Color4（本仓库实现的那条）**互斥**，照折会双重相乘；
          // genericimage4 恒用 g_Color4，材质里本就没有这三个常量。
          //
          // 挂**节点**而不是折成数值：热更时 resolveUserProps 就地改 .value，渲染侧每帧
          // 现读，所以属性热更自动生效，不需要「记原值再重折」那套簿记（见 renderer 的 color4）。
          attachBuiltinMatTint(layer, material);
          for (const e of layer.effects || []) {
            eff.resolveEffectChain(parsedPkg, e, readText, registerMaterialDoc, (m: string) =>
                reportDiag(rt, cfg, m, classifyDiag(m)),
              );
          }
          for (const e of layer.effects || []) {
            for (const p of e.passes || []) {
              for (const tn of p.textures || []) {
                if (
                  typeof tn === "string" &&
                  tn !== "" &&
                  !tn.startsWith("util/") &&
                  !tn.startsWith("_rt_")
                ) {
                  texJobs.push(loadTex(tn));
                }
              }
              // [we-scene patch 2388299037] 被保留名（$mediaThumbnail…）覆盖掉的原槽
              // 贴图也要预载：那是封面优先级第三级「壁纸内置封面」。合并后原名不在
              // textures 里，渲染端回落到它时查不到就只剩白纹理。
              for (const tn of p.textureFallbacks || []) {
                if (
                  typeof tn === "string" &&
                  tn !== "" &&
                  !tn.startsWith("util/") &&
                  !tn.startsWith("_rt_")
                ) {
                  texJobs.push(loadTex(tn));
                }
              }
              // [we-scene patch 3243449890] 用户图片槽登记（parse 的 userTextureNames
              // 记的是被 `usertextures` 顶掉的槽名 = 属性名）：热更时要按它重取图。
              // 保留名（`$mediaThumbnail`）不走属性表，排除。
              for (const tn of p.userTextureNames || []) {
                if (typeof tn === "string" && tn !== "" && !tn.startsWith("$")) {
                  propTexSlots.add(tn);
                  propTexLoadedValue.set(
                    tn,
                    typeof liveUserProps[tn] === "string" && liveUserProps[tn] ? String(liveUserProps[tn]) : "",
                  );
                }
              }
            }
            // [we-scene patch] 预载 shader 声明的**默认贴图**（sampler 槽的
            // `"default":"particle/halo_6"` 之类）。渲染器绑定纹理时会在槽为空时
            // 回退到它，但 textures 是普通 Map、渲染期无法异步加载，故这里先备好。
            // 典型场景：xray 的 sprite 槽在 4 个壁纸里是 null，缺它开窗形状消失。
            texJobs.push(preloadSamplerDefaults(e));
          }
        } catch (e) {
          console.warn(`图层 ${layer.name || li} 加载失败: ${(e as Error).message}`);
        }
      }

      // ---- 文字层的效果链解析 + 效果纹理预载 ----
      // 上面的循环只覆盖有 image 字段的图层；文字对象没有 image，但同样可以挂效果
      // （发光、淡入等）。挂件的发光纹理缺位时回退白纹理会糊成色块，所以一并预载。
      if (!SKIP_TEXT) {
        for (const layer of scene.layers as any[]) {
          if (!layer.isText || !(layer.effects || []).length) continue;
          try {
            for (const e of layer.effects || []) {
              eff.resolveEffectChain(parsedPkg, e, readText, registerMaterialDoc, (m: string) =>
                reportDiag(rt, cfg, m, classifyDiag(m)),
              );
            }
            for (const e of layer.effects || []) {
              for (const p of e.passes || []) {
                for (const tn of p.textures || []) {
                  if (
                    typeof tn === "string" &&
                    tn !== "" &&
                    !tn.startsWith("util/") &&
                    !tn.startsWith("_rt_")
                  ) {
                    texJobs.push(loadTex(tn));
                  }
                }
              }
            }
          } catch (e) {
            console.warn(`文字层效果 ${layer.name} 解析失败: ${(e as Error).message}`);
          }
        }
      }
      await Promise.all(texJobs);
      // 贴图装载完成后再扫一遍：部分保留纹理（壁纸自带封面等）是 texJobs 拉进来的
      bindPendingInstanceMedia();
      if (bakeEnabled) {
        reportDiag(
          rt,
          cfg,
          `bake: 内嵌图缓存命中 ${bakeStats.hits} / 待后台补烘 ${bakeStats.misses}` +
            (bakeStats.misses ? "（首帧后开始，不影响本次加载）" : ""),
          "info",
        );
      }

      // [we-scene patch] orthogonalprojection auto（GIF 导入模板等不带
      // width/height 的工程）：WE 桌面端按**内容边界**取景。贴图装载完成、
      // autosize 把图层尺寸补齐之后，量出实际内容框写回 ortho 宽高 —— 不做这步
      // scene 尺寸回落画布大小，480x300 的图层会缩在角落。只处理内容锚定在
      // 原点 (minX≈0, minY≈0) 的情形（WE 模板坐标即如此）；内容悬在别处的工程
      // 保持既有画布回退，避免投影原点错位。
      {
        const general = (scene as any).general ?? ((scene as any).general = {});
        // 不要在这里新建 orthogonalprojection：3D 透视场景（3509243656 写的是
        // `"orthogonalprojection": null`）本来就该没有这个键，补一个空对象会被
        // render/math.js 的 isPerspectiveScene 当成「作者声明了正交投影」→ 整个
        // 场景退回像素正交，星星被当成 1 像素画到画布角落 = 全黑。
        const ortho = (general.orthogonalprojection ?? null) as any;
        const explicit = Number(ortho?.width) > 0 && Number(ortho?.height) > 0;
        // [临时诊断]
        if (ortho) {
          const b0 = coverContentBounds(scene.layers as any[]);
          reportDiag(
            rt,
            cfg,
            `auto ortho probe: auto=${ortho.auto} explicit=${explicit} bounds=${Math.round(b0.minX)},${Math.round(b0.minY)}..${Math.round(b0.maxX)},${Math.round(b0.maxY)} sizes=${(scene.layers as any[]).map((l) => `${l.size?.[0]}x${l.size?.[1]}`).join("|")}`,
            "info",
          );
        }
        if (ortho && ortho.auto === true && !explicit) {
          const b = coverContentBounds(scene.layers as any[]);
          const w = b.maxX - b.minX;
          const h = b.maxY - b.minY;
          const anchored = Math.abs(b.minX) < 0.5 && Math.abs(b.minY) < 0.5;
          if (anchored && Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
            ortho.width = w;
            ortho.height = h;
            reportDiag(
              rt,
              cfg,
              `auto ortho: content ${Math.round(w)}x${Math.round(h)}（orthogonalprojection.auto）`,
              "info",
            );
          }
        }
      }

      // 可见层上的视频纹理才自动起播（WE 默认）。隐藏层（2887099508 安全模式
      // 盖屏视频）等脚本 getVideoTexture().play()；一加载就 play 会被双元素
      // 预热/切壁纸 pause 打断，日志刷 AbortError。
      // [we-scene patch 2026-09-20] 资源分辨率汇总（S0 台账）：一眼看到这次挂载缩了多少、省了多少
      reportDiag(
        rt,
        cfg,
        `resources R=${resScaleBase}${resScaleNormal !== resScaleBase ? ` (normal R=${resScaleNormal})` : ""}` +
          ` tex=${mem.texCount} gpu≈${(mem.gpuUploaded / 1e6).toFixed(1)}MB` +
          ` cpuDecoded=${(mem.cpuDecoded / 1e6).toFixed(1)}MB released=${(mem.cpuReleased / 1e6).toFixed(1)}MB` +
          ` scaled=${mem.scaled.length}` +
          (mem.scaled.length ? ` 例: ${mem.scaled.slice(0, 3).map((x) => `${x.name}(${x.how} ${x.from}→${x.to})`).join(" ")}` : "") +
          (mem.framesScaled.length ? ` 帧图集缩放: ${mem.framesScaled.slice(0, 3).join(" ")}` : ""),
        "info",
      );
      for (const [texName, texEntry] of textures) {
        if (!texEntry?.videoCtl) continue;
        const usedVisible = (scene.layers as any[]).some(
          (l) => l.textureName === texName && l.visible && !l.destroyed,
        );
        if (usedVisible && !rt.paused) texEntry.videoCtl.play();
      }

      // ---- 粒子系统（particle 图层）----
      // 加载粒子模型 json + 材质 + 贴图，构造 ParticleSystem，注入 renderer。
      // 贴图有两个来源：pkg 内嵌（工坊自制素材）与 WE 内置资源。后者（particle/halo、
      // particle/fog/fog1 …）不在 pkg 里 —— 全库 33 张被引用的粒子贴图有 24 张属于
      // 内置资源。没有 WE 安装目录可回退，故用 particle-textures.js 按名字语义
      // 程序化生成近似素材，否则整个粒子系统无贴图可用、只能整体跳过。
      const particleSystems: any[] = [];
      // [we-scene patch] 需要逐帧重读图层变换的粒子系统（脏子树内的）。
      // 挂载末尾按 transformDirty 填充；静态场景恒为空，advance 前一次都不跑。
      const particleDirty: any[] = [];
      // 按图层 id 索引粒子系统，用于逐层渲染（而非全部堆在最后）。
      // 子发射器（children）继承父图层的 layer.id，同一场景层的所有粒子系统在此分组。
      const particleSystemsByLayer = new Map<number, any[]>();
      let builtinTexCount = 0;

      // 取粒子贴图：先查 pkg，缺失则走内置素材（本机原版 / 程序化复刻）
      // [we-scene patch] 两条必须按官方语义处理，缺一条本机接入原版素材就会「更难看」：
      //   ① 纹理格式：stock 粒子图集大量是 R8/RG88（rain1 / fog1 / rain_drops_sheet /
      //      light_shafts_0），WE 按 ConvertTexture0Format 取样（形状进 alpha），
      //      我们直接 .a 会得到实心方块 / 取错通道；
      //   ② TEXS 序列帧表：rain_drops_sheet 16 帧、fog1 64 帧、rain1 4 帧，不传就退化成
      //      「整张图集当一帧」，画面上是一坨糊（3801012392 实测）。
      const loadParticleTex = async (name: string, purpose: "albedo" | "normal" = "albedo"): Promise<any | null> => {
        // 只在 pkg 真的有这张贴图时走 pkg 路径。不能无条件 `await loadTex(name)`：
        // loadTexInner 自己也会把内置粒子贴图**程序化建出来**并返回，于是下面的
        // 格式转换 / 真实帧表永远轮不到（本机接入原版素材时正是这个坑）。
        const inPkg = pkg.getEntry(parsedPkg, `materials/${name}.tex`) ? await loadTex(name) : null;
        if (inPkg) return inPkg;
        // 本机装了 WE 原版素材（local-assets/，见 local-assets.ts）时按需拉这一张：
        // 粒子图集很大（164 张解完 ~180MB），不做全量预载。没装素材时它立刻返回 false。
        await ensureLocalAsset(name);
        let gen = ptex.buildBuiltinParticleTexture(name);
        if (!gen) return null;
        gen =
          purpose === "normal"
            ? ptex.convertParticleNormalFormat(gen, gen.format)
            : ptex.convertParticleTexFormat(gen, gen.format);
        const entry = {
          glTex: rnd.makeTextureMip(renderer.gl, [gen], false),
          width: gen.width,
          height: gen.height,
          rg88: false,
          mips: [gen],
          generated: true,
          // 官方 clampuvs:true 的精灵（如 particle/halo_6）：效果链槽 1+
          // 采样时必须 CLAMP，否则开窗形状无限平铺（2212279721）。
          // 官方素材 Pixel 自带 flags 标记时优先，程序化兜底按名字表判定。
          clampUvs: gen.clampUvs === true || ptex.isBuiltinClampUvsName(name),
          // 帧表优先级：原版素材 .tex 的 TEXS（官方布局）> 程序化图集的内置猜测表
          // （rain1/rain2 的 1×4、leaves* 的 3×3；randomframe 依赖它随机取帧，
          // 缺了会画出超长丝 1823900922；叶片缺了会被切成 9 块 1725510475）。
          frames: gen.frames && gen.frames.length ? gen.frames : ptex.builtinParticleFrames(name) ?? undefined,
        };
        textures.set(name, entry);
        builtinTexCount++;
        return entry;
      };
      // 官方 Refract 槽 1 必须是法线。材质有时把反照率填进槽 1（particle/drop 等），
      // 白 RGB 不能当 DXT5nm/标准法线用，要按 alpha 转 bump。
      const asParticleNormal = (entry: any) => {
        if (!entry) return null;
        // [we-scene patch 2026-09-20] CPU 副本只在「看起来是反照率」时才保留
        // （见 loadTexInner 的释放逻辑）；这里按标记判，不依赖像素常驻。
        if (entry.looksAlbedo === false) return entry;
        const pix = (entry.cpuMips && entry.cpuMips[0]) || (entry.mips && entry.mips[0]);
        if (pix?.rgba && typeof ptex.prepareParticleNormalTexture === "function") {
          const n = ptex.prepareParticleNormalTexture(pix);
          if (n && n !== pix) {
            return {
              glTex: rnd.makeTextureMip(renderer.gl, [n], false),
              width: n.width,
              height: n.height,
              rg88: false,
              mips: [n],
              generated: true,
            };
          }
        }
        return entry;
      };

      // 递归构造粒子系统：children 是子发射器（如 ghost1 → 光晕/尾迹/本体三层）。
      // eventfollow：子级 origin 每帧对到父粒子世界位置（躲开光标时本体/光晕/尾迹一起走）。
      // static / 缺省 type：子级 origin 跟父系统 origin（嵌套的 ghost_eyes 跟着 body）。
      const buildParticleSystem = async (
        particlePath: string,
        layer: any,
        override: any,
        depth: number,
      ): Promise<any | null> => {
        if (depth > 3) return null; // children 可嵌套，设上限防病态数据造成指数展开
        const modelEntry = pkg.getEntry(parsedPkg, particlePath);
        if (!modelEntry) {
          reportDiag(rt, cfg, `particle '${particlePath}' 不在 pkg，跳过`, "warn");
          return null;
        }
        const model = JSON.parse(readText(modelEntry));
        // 图层变换（origin/scale/angles）必须传进去：WE 语义里图层 origin 是发射器的
        // 世界位置、scale 缩放整个系统。不传会让所有粒子堆在世界原点(0,0)。
        const ps = new particles.ParticleSystem(renderer.gl, model, override, layer);
        let texName: string | null = null;
        let texName1: string | null = null;
        if (model.material) {
          const matEntry = pkg.getEntry(parsedPkg, model.material);
          if (matEntry) {
            const mat = readMaterialDoc(matEntry);
            ps.setMaterial(mat);
            const slots = mat?.passes?.[0]?.textures || [];
            texName = slots[0] || null;
            texName1 = slots[1] || null;
          }
        }
        // 材质缺失或未声明贴图时，用通用光晕兜底（宁可近似也不整层消失）
        const te = await loadParticleTex(texName || "particle/halo");
        if (!te) {
          reportDiag(rt, cfg, `particle '${particlePath}' 无贴图可用，跳过`, "warn");
          return null;
        }
        ps.setTexture({ glTex: te.glTex, width: te.width, height: te.height, frames: te.frames });
        // 官方：Refract / Lighting 开启后才有法线槽。槽 1 缺失时按反照率名推断
        // （drop → drop_normal）；空白 albedo 没有法线就会画成白方块。
        const nrmName = texName1 || (ps.refract ? ptex.particleNormalNameForAlbedo(texName || "particle/halo") : null);
        if (nrmName) {
          const nrm = asParticleNormal(await loadParticleTex(nrmName, "normal"));
          if (nrm) {
            // [we-scene patch] 法线的通道布局要随贴图带给着色器：官方原生法线是
            // 「x 在 A、蒙版在 R」的打包布局，我们自己的生成器/RG88 转换结果是
            // 「x 在 R、alpha 恒 255」（见 isPackedNormalTexture 注释）。
            // 打包布局在 loadTexInner 里就判好了（那里才有像素，之后 CPU 副本会被释放）
            (nrm as { packed?: boolean }).packed = nrm.packedNormal === true;
            ps.setNormalTexture({
              glTex: nrm.glTex,
              width: nrm.width,
              height: nrm.height,
              packed: !!(nrm as { packed?: boolean }).packed,
            });
          }
        }
        ps.setVisible(!!layer.visible);
        particleSystems.push(ps);
        // 按图层 id 分组：子发射器继承父 layer.id，同一场景层共享 z 序位置
        const lid = layer.id;
        if (lid !== undefined) {
          let list = particleSystemsByLayer.get(lid);
          if (!list) { list = []; particleSystemsByLayer.set(lid, list); }
          list.push(ps);
        }

        for (const ch of model.children || []) {
          if (!ch || typeof ch.name !== "string") continue;
          // 子系统继承父图层的世界变换，叠加自身的局部 origin/scale/angles
          const cOrigin = String(ch.origin ?? "0 0 0").trim().split(/\s+/).map(Number);
          const cScale = String(ch.scale ?? "1 1 1").trim().split(/\s+/).map(Number);
          const cAngles = String(ch.angles ?? "0 0 0").trim().split(/\s+/).map(Number);
          const followMode =
            ch.type === "eventfollow"
              ? "particle"
              : !ch.type || ch.type === "static"
                ? "origin"
                : null;
          // origin 偏移必须打进初始位置。此前 followMode 时只留父 origin、靠
          // `_syncFollow` 每帧加 offset：eventfollow 在父粒子尚未生成时会
          // `if (!host) return`，子级停在父 origin。Matrix 雨 33 列的 trail
          // 全是 eventfollow，父列 maxcount=1 / rate=1，首秒没有 head，
          // 33 列尾迹叠在 4 个 spawner 原点上 —— 看起来就是「列间距没了」。
          // Offset 是粒子编辑器里的列距（父系统局部像素），要乘图层 scale：
          // 2974757317 层 scale=1.5、43 列 × 60px，不加 scale 只铺 2520/3840。
          const wOrigin = ps.localToWorld(cOrigin[0] || 0, cOrigin[1] || 0);
          const childLayer = {
            ...layer,
            origin: [
              wOrigin[0],
              wOrigin[1],
              (layer.origin?.[2] || 0) + (cOrigin[2] || 0),
            ],
            scale: [
              (layer.scale?.[0] ?? 1) * (cScale[0] || 1),
              (layer.scale?.[1] ?? 1) * (cScale[1] || 1),
              (layer.scale?.[2] ?? 1) * (cScale[2] || 1),
            ],
            angles: [
              (layer.angles?.[0] || 0) + (cAngles[0] || 0),
              (layer.angles?.[1] || 0) + (cAngles[1] || 0),
              (layer.angles?.[2] || 0) + (cAngles[2] || 0),
            ],
          };
          // 图层 instanceoverride（如 colorn 绑用户颜色）下传到没有自己 override 的子级，
          // 否则 Pac-Man / 幽灵的颜色滑块只作用在空 renderer 的隐形父系统上。
          // 事件子级（eventdeath/eventspawn）例外：它们由父粒子死亡/生成事件临时实例化，
          // 图层 override 是作者绑给父粒子系统的（3436945972 火箭的 colorn 橙色），
          // 下传给 REFRACT 冲击波会把整块白 quad 的折射画面染成同色方块 ——
          // 官方 frag 对 v_Color 与折射结果做乘法，事件子级的 v_Color 应取自己的配置。
          const eventChild = ch.type === "eventdeath" || ch.type === "eventspawn";
          const childPs = await buildParticleSystem(
            ch.name,
            childLayer,
            eventChild ? ch.instanceoverride || null : ch.instanceoverride || override,
            depth + 1,
          );
          if (childPs && followMode) {
            childPs.attachFollow(ps, followMode, [
              cOrigin[0] || 0,
              cOrigin[1] || 0,
              cOrigin[2] || 0,
            ]);
          } else if (childPs && (ch.type === "eventdeath" || ch.type === "eventspawn")) {
            // 事件子发射器：**不自播**，只由父粒子的死亡/生成事件在父粒子当时的位置
            // 触发爆发（WE 的 SpawnType::EVENT_DEATH / EVENT_SPAWN）。此前这类子级
            // 被当成独立系统装配，于是只在首帧于图层 origin 白爆一次 ——
            // 2131872317 的烟花火箭升空后不会炸（8500 颗的爆开、flare、冲击波全无）。
            // cOrigin 是本系统相对父系统的站位（children.origin，父局部坐标）。
            childPs.attachEventParent(ps, ch.type, [
              cOrigin[0] || 0,
              cOrigin[1] || 0,
              cOrigin[2] || 0,
            ]);
          }
        }
        return ps;
      };

      if (!SKIP_PARTICLES) {
        // 不能只装当前可见层：language / clocklocation 等 combo 热切后，
        // 原先隐藏的语言变体（3299228616 五套）会亮起来，但粒子系统不会再走
        // 这条装配循环——星星/萤火虫整组消失，只有整包重载才正常。
        for (const layer of scene.layers) {
          if (!layer.particle) continue;
          try {
            await buildParticleSystem(layer.particle, layer, layer.instanceoverride, 0);
          } catch (e) {
            console.warn(`粒子图层 ${layer.name} 加载失败: ${(e as Error).message}`);
            reportDiag(rt, cfg, `particle '${layer.name}' FAIL: ${(e as Error).message.slice(0, 80)}`, "warn");
          }
        }
      }
      // 场景卸载时释放粒子系统的 GL 资源（每系统一套 program/VAO/VBO）
      if (particleSystems.length > 0) {
        const prevCleanup = particleCleanup;
        particleCleanup = () => {
          prevCleanup?.();
          for (const ps of particleSystems) ps.dispose();
        };
      }
      // ---- 声音图层（sound 对象）----
      // 从 scene.pkg 提取声音文件 → Blob → audio 播放；受 cfg.muted 控制
      const soundAudios: HTMLAudioElement[] = [];
      // [we-scene patch] BGM 频谱桥（35 张「声音层 + 音频反应」壁纸）：声音元素
      // 接共享 AnalyserNode，每帧把 BGM 频域并入音频快照，让自带音乐也能驱动
      // g_AudioSpectrum* / registerAudioBuffers（见 bgm-analyser.ts）。
      const bgm = createBgmAnalyser();
      // 出声通路的主增益按当前生效音量起步：宿主已 setVolume(0) 后的内部重挂
      // （setRenderDpr/restore），新元素只带 cfg.muted 近似 —— 不初始化增益，
      // WKWebView 上 BGM 会以全音量漏出来（元素 muted 路由后不生效）。
      bgm.setVolume(effectiveUserVolume(rt, cfg));
      const bgmCleanup = () => bgm.dispose();
      for (const layer of scene.layers) {
        if (!layer.sound || !layer.sound.length) continue;
        try {
          for (const snd of layer.sound) {
            const entry = pkg.getEntry(parsedPkg, snd);
            if (!entry) continue;
            // 尝试多种 mime（WE 声音多为 wav/mp3/ogg/flac）
            const ext = (snd.split(".").pop() || "").toLowerCase();
            const mime =
              ext === "mp3" ? "audio/mpeg" : ext === "ogg" ? "audio/ogg" : ext === "flac" ? "audio/flac" : "audio/wav";
            const blob = new Blob([entry as BlobPart], { type: mime });
            const url = URL.createObjectURL(blob);
            // 登记以便 clear(rt)/页面卸载时 revoke blob URL
            (rt.objectUrls ??= []).push(url);
            const au = document.createElement("audio");
            au.src = url;
            au.loop = layer.soundprops?.playbackmode === "loop";
            au.volume = Math.max(0, Math.min(1, layer.soundprops?.volume ?? 1));
            au.muted = cfg.muted !== false;
            // 接入 BGM 频谱分析（createMediaElementSource 每元素仅一次，幂等）
            bgm.attach(au);
            // startsilent：等脚本 thisLayer.play() 再响。2887099508 的 10 层语音/备选
            // BGM 都是 true，一律 play 会在加载瞬间把问候、翻页、五首 BGM 叠在一起。
            // 全库 59 层 / 11 张壁纸。playbackmode=single 的一次性语音也走这条。
            (layer as any).soundCtl = {
              play() {
                if (au.ended) {
                  try {
                    au.currentTime = 0;
                  } catch {
                    /* 忽略 */
                  }
                }
                bgm.resume();
                void au.play().catch(() => {});
                // 脚本显式播放的曲目 = 「正在播放」的媒体（面板歌名/显隐的数据源）。
                // 装配期自动开播的环境音不走这里，不会抢媒体面板。
                wallpaperAudio.markPlayed(au);
              },
              pause() {
                au.pause();
              },
              stop() {
                au.pause();
                try {
                  au.currentTime = 0;
                } catch {
                  /* 忽略 */
                }
                wallpaperAudio.markStopped(au);
              },
              isPlaying: () => !au.paused && !au.ended,
              getVolume: () => au.volume,
              setVolume: (v: number) => {
                au.volume = Math.max(0, Math.min(1, v));
              },
            };
            // 登记进壁纸音频媒体源（跳歌/上一曲在这份有序表上循环）
            wallpaperAudio.register(au, layer.name || "");
            if (!layer.soundprops?.startsilent && !rt.paused) {
              bgm.resume();
              void au.play().catch(() => {});
            }
            // 循环播放时循环
            soundAudios.push(au);
            break; // 每个图层播放第一个声音
          }
        } catch (e) {
          console.warn(`声音图层 ${layer.name} 加载失败: ${(e as Error).message}`);
        }
      }
      // 提供 setVolume 控制（含 muted 切换）。
      // 已路由进 WebAudio 的元素由主增益统一控制实际出声：WebKit 上元素的
      // muted/volume 对路由后的输出不生效（静音会漏），Chromium 上则会与增益
      // 双重缩放 —— 路由元素固定满音量、只留 muted 给频谱门控；未路由元素
      // 按旧行为直接写属性。
      const setSceneVolume = (vol: number) => {
        const v = Math.max(0, Math.min(1, vol));
        for (const au of soundAudios) {
          if (bgm.routes(au)) {
            au.volume = 1;
            au.muted = v <= 0;
          } else {
            au.volume = v;
            au.muted = v <= 0;
          }
        }
        bgm.setVolume(v);
      };
      rt.sceneAudio = { setVolume: setSceneVolume, audios: soundAudios, dispose: bgmCleanup };
      // 每次挂载/重挂装配完声音层就重放宿主音量：新元素只带 cfg.muted 的 0/1
      // 近似（setRenderDpr/restore 等内部重挂会丢中间值），且 WKWebView 上元素
      // muted 对 WebAudio 路由不生效，必须经这里（→ bgm 增益）重落一次。
      // 放在 rt.sceneAudio 赋值之后而非首帧回调：onFirstFrame 是一次性钩子，
      // 内部重挂不会再触发。
      reapplyVolume(rt);
      if (disposed) return;
      // 粒子每帧推进 + 按图层渲染（在场景图层迭代的正确 z 序位置渲染）。
      // 不再「全部堆在最后」—— advance 在渲染器图层迭代前统一推进，render 按 layer.id 分发。
      // [we-scene patch] 粒子 dt 必须与场景时钟 t 同源（帧循环每帧写入），
      // 不能再用 performance.now() 差分：那是**第三条时钟** —— 掉帧时关键帧按 t
      // 推进 200ms、粒子被 50ms 封顶只走 50ms；暂停期间 t 扣掉 pauseAccum、墙钟
      // 照走 —— 两者都会让粒子与关键帧/骨骼动画永久漂移。3233141951 龙烟 alpha
      // 曲线挂在场景 t 上，粒子发射若走墙钟就锁不住步（与已修的「两套时钟」同族）。
      const particleClock = { dt: 1 / 60, t: 0 };
      let particleDiagFrame = 0;
      // [we-scene patch] 粒子「关」档（性能设置）：跳过推进与渲染，系统对象保留
      // （重新开档时不用重建，_applyOverride 池重建即可恢复）。零 CPU 模拟开销。
      let particleQualityOff = false;
      renderer.setParticleRenderer(
        // advanceFn：每帧推进所有粒子系统（在图层迭代前统一调用）
        () => {
          if (particleQualityOff) return;
          // dt 封顶 50ms 保留：标签页切回或掉帧时的大 dt 会让粒子瞬移一大段。
          const pdt = Math.min(0.05, Math.max(0, particleClock.dt));
          // 世界指针位置：locktopointer 的控制点用它做吸引/排斥（controlpointattract）。
          if (pointerSrc.state.has) {
            const { wx, wy, originY } = pointerSrc.state;
            const py = originY != null ? originY : wy;
            for (const ps of particleSystems) ps.setPointer(wx, py);
          }
          // [we-scene patch] 发射器变换只在构造时缓存过一次。父组带脚本/动画变换时
          // recomposeWorld 每帧都会挪动图层，不重读就会「人物滑走、火焰留在原地」。
          // 只同步脏子树里的粒子层（静态场景下集合为空，一次都不跑）。
          if (particleDirty.length) {
            for (const ps of particleDirty) ps.syncLayerTransform();
          }
          // 运行期 createLayer 的粒子层：脚本能随时改 origin（1712475860 的
          // coinget 特效由脚本 `coinFx.origin = origin` 定位到收集点），但克隆层
          // 不在 mount 期 transformDirty 里 —— 不每帧重读就会钉在构造点 (0,0)。
          // 这类系统只有个位数，直接全量同步一次即可。
          for (const ps of particleSystems) {
            if (ps.layer && ps.layer.runtimeCreated) ps.syncLayerTransform();
          }
          // [we-scene patch] 对象视差：粒子层不走 layerModelMatrix（渲染回调
          // 直传 cam/viewProj），宿主每帧按共享 layerParallaxOffset 注入偏移。
          // ctx 由 renderer 帧循环更新（getParallaxOffset）；legacy/mirage 同构。
          {
            const pctx = renderer.getParallaxOffset ? (renderer.getParallaxOffset() as any) : null;
            for (const ps of particleSystems) {
              if (!pctx || !pctx.active || !ps.layer || !ps.layer.parallaxDepth) {
                ps.setParallaxOffset(0, 0);
              } else {
                const off = layerParallaxOffset(ps.layer, pctx);
                ps.setParallaxOffset(off[0], off[1]);
              }
            }
          }
          for (const ps of particleSystems) ps.advance(pdt, audioSim.enabled ? activeAudioSnapshot() : null);
          // 首帧后上报一次实际存活粒子数
          if (particleDiagFrame < 2) {
            particleDiagFrame++;
            if (particleDiagFrame === 2) {
              const live = particleSystems.reduce((s, ps) => s + ps.liveCount(), 0);
              reportDiag(rt, cfg, `particles live: ${live} across ${particleSystems.length} systems`, "info");
            }
          }
        },
        // renderByLayerFn：按图层 id 渲染该层对应的粒子系统。
        // cam.projW/projH 必须透传：particles.render 用 projH 做世界 y 向下 → 投影空间的翻转。
        (layerId: number, cam: any, viewProj: any, w: number, h: number) => {
          if (particleQualityOff) return;
          if (layerId === undefined) return;
          const list = particleSystemsByLayer.get(layerId);
          if (!list) return;
          for (const ps of list) ps.render(viewProj, w, h, cam.projW, cam.projH);
        },
      );
      // [we-scene patch] 性能设置应用（挂载初值 + setQuality 热更共用）。
      // 全部就地生效不重挂载：AA/后处理是渲染器门控，粒子倍率是池重建（粒子重生，
      // 与 WE 改档位时的表现一致）。
      const applyQuality = (q: ResolvedQuality) => {
        rt.qualityEffective = q;
        renderer.setAntiAliasing?.(q.antiAliasing);
        renderer.setEffectsEnabled?.(q.postProcessing !== "off");
        renderer.setFboCapFactor?.(postFboCapFactor(q.postProcessing));
        particleQualityOff = q.particles === "off";
        particles.setParticleQualityScale?.(particleQualityScale(q.particles));
        // 粒子密度档：控制超大 count 倍率系统的池容量与发射率封顶（3509806978
        // count=5000 的雪）。off 不经过这里（上面已门控推进与渲染）。
        particles.setParticleDensityTier?.(q.particles === "off" ? "high" : q.particles);
        for (const ps of particleSystems) ps._applyOverride?.();
        reportDiag(rt, cfg, `quality: aa=${q.antiAliasing} particles=${q.particles} post=${q.postProcessing}`, "info");
      };
      setQualityImpl = applyQuality;
      // [we-scene patch 2026-09-25] 自动降档（挂载期）：软件渲染（无 GPU）时把后处理
      // 关掉。**只填宿主没显式指定的字段** —— 宿主在设置面板里明确选了 pp=high 就
      // 尊重它；`autoQuality:false` / `?autoq=0` 整段不生效。
      // 依据见 quality.ts：软件渲染下「pp=off + DPR 0.5」是 0fps → 46fps 的那个组合，
      // 而单独任一项都救不回来。
      const autoRes = applyAutoQuality({
        quality: normalizeQuality(cfg.quality),
        explicit: cfg.quality,
        software: rt.softwareRenderer === true,
        enabled: cfg.autoQuality !== false,
      });
      for (const line of autoRes.applied) reportDiag(rt, cfg, `autoQuality: ${line}`, "warn");
      if (rt.softwareRenderer === true) {
        reportDiag(
          rt,
          cfg,
          `软件渲染（无 GPU）：画布 DPR 封顶 ${softwareDprCap(true, cfg.renderDpr) ?? "（宿主已指定，跳过）"}`,
          "warn",
        );
      }
      applyQuality(autoRes.quality);
      reportDiag(rt,
        cfg,
        `particles: ${particleSystems.length} systems, ${builtinTexCount} builtin tex generated`,
        "info",
      );
      // 调试出口：测试台/控制台可读粒子系统状态（存活数、世界包围盒、尺寸区间、
      // 图层名、override 动画的 opacityMul 曲线、场景时钟 t），
      // 用于确认粒子真的落在可见区域内、尺寸量级合理，而不是堆在原点或大到糊屏。
      // 单定义（闭包读活状态，不需要每帧重赋）。
      (window as unknown as Record<string, unknown>).__particleStats = () => ({
        t: particleClock.t,
        systems: particleSystems.map((ps) => {
          let live = 0;
          let minX = Infinity;
          let maxX = -Infinity;
          let minY = Infinity;
          let maxY = -Infinity;
          let minS = Infinity;
          let maxS = -Infinity;
          // 序列帧诊断：最大帧间混合权重（官方 SPRITESHEETBLEND 是否真的在混）
          let frameMixMax = 0;
          for (const p of ps.pool) {
            if (!p.alive) continue;
            live++;
            if ((p.frameMix || 0) > frameMixMax) frameMixMax = p.frameMix;
            const px = ps.originX + p.x * ps.scaleX;
            const py = ps.originY + p.y * ps.scaleY;
            if (px < minX) minX = px;
            if (px > maxX) maxX = px;
            if (py < minY) minY = py;
            if (py > maxY) maxY = py;
            const s = Math.abs(p.size) * ps.sysScale;            if (s < minS) minS = s;
            if (s > maxS) maxS = s;
          }
          return {
            layer: ps.layer && ps.layer.name,
            opacityMul: Math.round(ps.opacityMul * 10000) / 10000,
            live,
            max: ps.maxCount,
            blend: ps.blend,
            renderer: ps.renderers.map((r: any) => r.kind).join("+"),
            origin: [Math.round(ps.originX), Math.round(ps.originY)],
            bbox: live ? [Math.round(minX), Math.round(minY), Math.round(maxX), Math.round(maxY)] : null,
            size: live ? [Math.round(minS), Math.round(maxS)] : null,
            frameCount: ps.frameCount,
            frameMixMax: Math.round(frameMixMax * 1000) / 1000,
            // 折射诊断：官方 g_RefractAmount（缺省 0.05、range[-1,1]）与是否真的走 REFRACT
            refract: !!ps.refract,
            refractAmount: Math.round((Number.isFinite(ps.refractAmount) ? ps.refractAmount : 0.05) * 1000) / 1000,
          };
        }),
      });
      // 调试出口：整体开关粒子可见性，用于「开/关两帧对比」量化粒子对画面的实际贡献
      // （验证是否出现方块边界、是否把画面冲白、是否堆成一团）。
      // 传索引则只显示该系统，用于逐系统定位过曝来源。
      (window as unknown as Record<string, unknown>).__particleToggle = (
        on: boolean,
        onlyIndex?: number,
      ) => {
        for (let i = 0; i < particleSystems.length; i++) {
          particleSystems[i].setVisible(onlyIndex === undefined ? on : i === onlyIndex);
        }
        return particleSystems.length;
      };

      // ---- puppet 骨骼网格图层 ----
      // model json 有 puppet 字段 → 解析 MDL（网格 + 骨架 + MDLA 动画），挂到图层上。
      // 渲染由 renderer 的图层循环调用（按 z 序、可走效果链），不再作为叠加层单独绘制。
      const mdlItems: { mdl: any; tex: any; layer: any }[] = [];
      // [we-scene patch] 骨骼动画帧事件的播放头跟踪（图层 → 动画层序号 → 上帧帧号）。
      const puppetPrevFrames = new Map<any, Map<number, number>>();
      // [we-scene patch] 骨骼平移覆写表（图层 → Map<骨索引, 局部平移>）。
      // 脚本经 thisLayer.setBoneTransform 写入（见 text.js 的 makeBoneApi），
      // puppet draw 逐帧读取喂给 computeSkinMatrices。表按图层分开：
      // thisScene.getLayer(name) 拿到的是别的图层，各有自己的骨骼。
      const boneOverridesByLayer = new Map<any, Map<number, number[]>>();
      const getBoneOverrides = (l: any) => {
        if (!l || !l.puppet) return null;
        let m = boneOverridesByLayer.get(l);
        if (!m) {
          m = new Map<number, number[]>();
          boneOverridesByLayer.set(l, m);
        }
        return m;
      };
      // 同粒子：隐藏层也要装 puppet，否则 combo 热切显示后骨骼模型仍是空的。
      for (const layer of scene.layers) {
        if (!layer.image) continue;
        if (SKIP_3D_MODELS) continue;
        try {
          if (eff.BUILTIN_MODELS[layer.image]) continue; // 内置模型无 puppet
          const modelEntry = pkg.getEntry(parsedPkg, layer.image);
          if (!modelEntry) continue;
          const model = JSON.parse(readText(modelEntry));
          if (!model.puppet) continue;
          const mdlEntry = pkg.getEntry(parsedPkg, model.puppet);
          if (!mdlEntry) continue;
          const mdlObj = mdl.parseMDL(new Uint8Array(mdlEntry as ArrayBuffer));
          // 贴图：与普通图层同一条材质链，已在上面的循环里 loadTex 过
          const texObj = layer.textureName ? textures.get(layer.textureName) : null;
          if (!texObj) {
            reportDiag(rt, cfg, `puppet '${layer.name}' 无贴图，跳过`, "warn");
            continue;
          }
          layer.puppet = mdlObj;
          mdlItems.push({ mdl: mdlObj, tex: texObj, layer });
          const an = mdlObj.animations[0];
          reportDiag(rt,
            cfg,
            `puppet '${layer.name}' v=${mdlObj.vertexCount} bones=${mdlObj.bones.length}` +
              (an ? ` anim='${an.name}' ${an.fps}fps×${an.frameCount}` : " 无动画"),
            "info",
          );
        } catch (e) {
          console.warn(`puppet 图层 ${layer.name} 加载失败: ${(e as Error).message}`);
          reportDiag(rt, cfg, `puppet '${layer.name}' 失败: ${(e as Error).message}`, "warn");
        }
      }
      const meshTexPush = (arr: (unknown | null)[], mi: number, t: unknown | null, dflt: unknown | null) => {
        while (arr.length < mi) arr.push(dflt);
        arr[mi] = t;
      };
      // [we-scene patch] scene.json 直接挂 `model: "*.mdl"` 的真 3D 网格
      // （3509243656 恒星/天空盒）。不经 image→json→puppet，材质路径在 MDL 头里。
      for (const layer of scene.layers) {
        if (!layer.model) continue;
        if (SKIP_3D_MODELS) continue;
        if (layer.puppet) continue;
        try {
          const mdlEntry = pkg.getEntry(parsedPkg, layer.model);
          if (!mdlEntry) continue;
          const mdlObj = mdl.parseMDL(new Uint8Array(mdlEntry as ArrayBuffer));
          // [we-scene patch 2026-10-03] `reflected: true` 的对象要**同时**画进
          // `_rt_Reflection`（关于 y=0 平面的镜像），供地板/桌面这类材质按屏幕 UV 采样。
          // 标在图层上，渲染侧的 renderReflectionPass 按它筛（fantasticcar 的
          // Dome 与 Car 是官方内置里唯一的两个）。
          (layer as any).reflected = (layer as any).srcObject?.reflected === true;
          let texName: string | null = null;
          if (mdlObj.materialPath) {
            const matEntry = pkg.getEntry(parsedPkg, mdlObj.materialPath);
            if (matEntry) {
              const material = readMaterialDoc(matEntry);
              const pass0 = material?.passes?.[0];
              const tex = pass0?.textures?.[0];
              if (typeof tex === "string" && tex) texName = tex;
              // [we-scene patch] 真 3D 网格材质的 LIGHTING combo（3509243656
              // 球体/天空盒用 generic4 + LIGHTING=1）：标给 puppet 绘制回调，
              // u_color 乘场景环境光（见 renderer drawPuppetDirect）。
              const L = pass0?.combos?.LIGHTING ?? pass0?.combos?.lighting;
              if (Number(L) === 1) (layer as any).lightingEnabled = true;
              attachBuiltinMatTint(layer, material);
              // [we-scene patch 2026-10-03] **材质 shader 路径**（F13）：该模型材质的
              // pass shader 不是内置 albedo 一族（官方内置的 skybox/dome/car/core/
              // ricepod*/techno*/knife_df… 全是自定义 GLSL）时，交给渲染器用材质自己的
              // 着色器画网格，而不是通用网格程序。编译失败/属性不支持时渲染侧自动回落。
              // [we-scene patch 2026-10-03] 判据由 `!isEngineMeshShader` 收紧成
              // `canUseMaterialMeshPath`（F34）：`generic`（官方模型着色器，带
              // lightmap/normalmap/点光/反射）也要走材质路径，其余内置族（generic4 等）照旧排除。
              if (typeof pass0?.shader === "string" && pass0.shader && eff.canUseMaterialMeshPath(pass0.shader)) {
                (layer as any).meshMaterial = {
                  shader: pass0.shader,
                  combos: pass0.combos || {},
                  constants: pass0.constantshadervalues || {},
                  blending: typeof pass0.blending === "string" ? pass0.blending : null,
                  // [we-scene patch 2026-10-03] 深度的两条材质开关（F40）：WE 的材质 pass 用
                  // `depthtest`/`depthwrite` 的 disabled/enabled 控制层间遮挡，未声明时按
                  // **都开启**（neongrid 显式写 enabled 是同一默认的确认）。此前材质路径
                  // 只读 blending，深度全按「每层清一次」的粗暴策略 —— 见 renderer.js 的 F40 注释。
                  depthTest: pass0.depthtest !== "disabled",
                  depthWrite: pass0.depthwrite !== "disabled",
                  // 材质声明的**全部**槽位（car 的 g_Texture1 是法线贴图）：缺槽渲染侧绑白纹理，
                  // 不预载的话采样得到 (0,0,0,1) → 光照项为 0 → 模型整片黑。
                  textures: [],
                  // [we-scene patch 2026-10-03] `"_rt_Reflection"` 槽（fantasticcar 的地板
                  // grid.frag 拿它当反照率）要的是**本帧的镜像渲染目标**，不是一个文件：
                  // 宿主把名字标成 `{rtName}` 传给渲染侧，渲染侧在画这层之前先跑一趟
                  // 反射（`reflected: true` 的模型层 + y=0 镜像），见 renderReflectionPass。
                  needsReflection: false,
                };
                for (const tn of pass0.textures || []) {
                  if (typeof tn !== "string" || !tn) {
                    (layer as any).meshMaterial.textures.push(null);
                    continue;
                  }
                  if (tn.startsWith("_rt_")) {
                    (layer as any).meshMaterial.textures.push({ rtName: tn });
                    if (tn === "_rt_Reflection") (layer as any).meshMaterial.needsReflection = true;
                    continue;
                  }
                  try {
                    await loadTex(tn);
                    (layer as any).meshMaterial.textures.push(textures.get(tn) || null);
                  } catch {
                    (layer as any).meshMaterial.textures.push(null);
                  }
                }
              }
            }
          }
          if (texName) {
            // [we-scene patch] 单张贴图解析/解码失败**不许拖垮整张壁纸**：下面那个
            // `!texObj` 分支本来就会「跳过该图层 + 报诊断」，但异常会从 loadTex 直接
            // 冒到挂载外层，变成「整张墙加载失败」（764162681 的 TEXV0004 就是这样：
            // 五张贴图全抛「不是 .tex 文件」→ scene render failed → 画面全空）。
            // 失败时不写 layer.textureName，交给下面的跳过分支。
            try {
              await loadTex(texName);
              layer.textureName = texName;
              // 材质 shader 路径（F13）的槽 0 贴图：给渲染侧一个可直接 bind 的条目
              if ((layer as any).meshMaterial) (layer as any).meshMaterial.texture = textures.get(texName) || null;
            } catch (e) {
              reportDiag(
                rt,
                cfg,
                `model '${layer.name}' 的贴图 '${texName}' 加载失败，跳过该层：${(e as Error)?.message}`,
                "warn",
              );
            }
          }
          const texObj = texName ? textures.get(texName) : null;
          // [we-scene patch 2026-10-03] 无贴图材质（fantasticcar dome/shadow 只有 shader、
          // 没有 textures）在**材质 shader 路径**下是合法的：着色器自己算颜色（渐变/自发光）。
          // 只有既没贴图又不能走材质路径时才跳过（原行为）。
          if (!texObj && !(layer as any).meshMaterial) {
            reportDiag(rt, cfg, `model '${layer.name}' 无贴图，跳过`, "warn");
            continue;
          }
          // [we-scene patch 2026-09-28] 多子网格：**每个子网格带自己的材质与贴图**
          // （stage.mdl 15 个子网格 = 地面/看台/远景…，各自 materials/models/stage/*.json）。
          // 只画第一个子网格 = 只有「立在场地顶上那块招牌」，整场没有地面（3281559867
          // 的黑色大底、3662790108 的太阳系缺件）。第 0 个沿用本层已解析的贴图（就是
          // 该网格的材质贴图），其余逐个按材质 json 解析；某个网格的贴图缺失只让那一个
          // 网格回落到层贴图，不拖垮整层。
          if (mdlObj.meshes && mdlObj.meshes.length > 1) {
            const meshTex: (unknown | null)[] = [texObj];
            // [we-scene patch 2026-10-03] **逐子网格的完整材质**（F35）：多子网格模型里
            // 每个网格有自己的材质 JSON —— 不只是 tex0 不同，**combos 也可能不同**
            // （arsenal：刀 = lightmap+normalmap，桌面 = +reflection+detailinalpha），
            // 而 combos 决定编译哪套 `#if` 分支 ⇒ 每个网格可能需要**不同的程序**。
            // 此前只按 mesh0 的材质建一个 meshMaterial：其余网格既用了错的槽贴图
            // （刀的法线/光照图贴到桌面上，桌面因此整片黑），也丢了 REFLECTION/DETAILINALPHA。
            const meshSpecs: any[] = [];
            for (let mi = 0; mi < mdlObj.meshes.length; mi++) {
              const mesh = mdlObj.meshes[mi];
              const mp: string | null = mesh.materialPath;
              if (mi === 0 || !mp) {
                meshSpecs.push((layer as any).meshMaterial || null);
                continue;
              }
              const matEntry = pkg.getEntry(parsedPkg, mp);
              if (!matEntry) {
                meshSpecs.push(null);
                continue;
              }
              const material = readMaterialDoc(matEntry);
              const pass0 = material?.passes?.[0];
              let spec: any = null;
              if (pass0 && typeof pass0.shader === "string" && eff.canUseMaterialMeshPath(pass0.shader)) {
                spec = {
                  shader: pass0.shader,
                  combos: pass0.combos || {},
                  constants: pass0.constantshadervalues || {},
                  blending: typeof pass0.blending === "string" ? pass0.blending : null,
                  depthTest: pass0.depthtest !== "disabled",
                  depthWrite: pass0.depthwrite !== "disabled",
                  textures: [],
                  needsReflection: false,
                };
                for (const tn of pass0.textures || []) {
                  if (typeof tn !== "string" || !tn) {
                    spec.textures.push(null);
                    continue;
                  }
                  if (tn.startsWith("_rt_")) {
                    spec.textures.push({ rtName: tn });
                    if (tn === "_rt_Reflection") spec.needsReflection = true;
                    continue;
                  }
                  try {
                    await loadTex(tn);
                    spec.textures.push(textures.get(tn) || null);
                  } catch {
                    spec.textures.push(null);
                  }
                }
              }
              // [we-scene patch 2026-10-03] **槽 0 的每网格基色必须对每个子网格都填**（F43）。
              //
              // 渲染侧材质路径里槽 0 的来源是 `layer.meshTextures[i] || mm.texture`
              // （见 renderer.js「每网格贴图优先…其次整层贴图」），而 meshTex 此前只给
              // **没有 spec** 的网格填过：有 spec 的网格一律落到 `mm.texture` ＝ **mesh 0
              // 的基色**。多子网格模型于是整机都在采样第一个子网格的贴图 —— fantasticcar
              // 六个子网格全在采样车漆那张**通道图**（r/g/b 打包的权重图，直出就是青/品红），
              // 用户看到的就是「前唇/侧裙/后视镜/轮辋蓝青、进气格栅深蓝」（官方预览这些件
              // 是银灰/深灰）。有 spec 时贴图已在上面按 `spec.textures` 载好，这里只是把它
              // 同步进那张「每网格槽 0」表。
              const tn0 = pass0?.textures?.[0];
              if (typeof tn0 === "string" && tn0) {
                const gapDefault = spec ? null : texObj;
                try {
                  await loadTex(tn0);
                  meshTexPush(meshTex, mi, textures.get(tn0) ?? null, gapDefault);
                } catch {
                  meshTexPush(meshTex, mi, null, gapDefault);
                }
              }
              const lightCombo = pass0?.combos?.LIGHTING ?? pass0?.combos?.lighting;
              if (Number(lightCombo) === 1) (layer as any).lightingEnabled = true;
              meshSpecs.push(spec);
            }
            (layer as any).meshTextures = meshTex;
            (layer as any).meshMaterials = meshSpecs;
          }
          layer.puppet = mdlObj;
          mdlItems.push({ mdl: mdlObj, tex: texObj, layer });
          reportDiag(rt,
            cfg,
            `model '${layer.name}' v=${mdlObj.vertexCount} static ${mdlObj.materialPath || ""}` +
              (mdlObj.meshes && mdlObj.meshes.length > 1 ? ` meshes=${mdlObj.meshes.length}` : ""),
            "info",
          );
        } catch (e) {
          console.warn(`model 图层 ${layer.name} 加载失败: ${(e as Error).message}`);
          reportDiag(rt, cfg, `model '${layer.name}' 失败: ${(e as Error).message}`, "warn");
        }
      }
      let mdlRenderer: any = null;
      if (mdlItems.length > 0) {
        try {
          mdlRenderer = mdl.createMDLRenderer(renderer.gl);
          // 卸载时释放 puppet 侧的 GL 资源（program + 每套网格的 VAO/VBO）。
          // mdl.js 的网格缓存是 WeakMap（枚举不出来），没有显式 dispose 就只能等
          // 上下文回收 —— 与「自己回收 + 扩展兜底」的原则不一致（§3.1）。
          const prevMdlCleanup = rt.sceneCleanup;
          const thisMdl = mdlRenderer;
          rt.sceneCleanup = () => {
            try {
              thisMdl.dispose?.();
            } catch (e) {
              /* 上下文可能已丢失 */
            }
            prevMdlCleanup?.();
          };
          for (const item of mdlItems) mdlRenderer.upload(item.mdl);
          // 注入绘制回调：renderer 在图层循环里按 z 序调用
          const byLayer = new Map<any, { mdl: any; tex: any; layer: any }>();
          for (const item of mdlItems) byLayer.set(item.layer, item);
          // [we-scene patch 2026-10-03] 几何提供者：材质 shader 路径要从 mdl 层取
          // 交错 VBO/索引（resolveMeshes/resolveMesh），见 renderer 的 drawMeshMaterial
          renderer.setMeshProvider(mdlRenderer);
          // 模型材质路径开关：调试钩子模式下允许用 window.__noMeshMaterial 一键回退
          // （材质路径对个别壁纸仍有回归，见 renderer.js drawMeshMaterial 的头注）
          renderer.setMeshMaterialEnabled(
            !(hooksOn() && (window as unknown as Record<string, unknown>).__noMeshMaterial === true),
          );
          // [we-scene patch 2026-10-03] 装配期预编译模型材质程序（F17）：include 是异步取来的，
          // 首帧抢跑会让「编译失败」的 null 永久哨兵钉死这条 shader（core/backgroundsphere
          // 时好时坏就是这么来的）。这里 await 一次，失败也只是回落通用网格程序。
          for (const item of mdlItems) {
            // [we-scene patch 2026-10-03] 逐子网格材质（F35）也要预编译：多子网格模型里
            // 每个网格的 combos 决定一个独立程序（arsenal 的刀/桌面/枪各自一套分支），
            // 只预热 mesh0 的会让其余网格「首帧才开编译」，第一帧整层退回通用程序。
            const specs: any[] = [(item.layer as any).meshMaterial];
            const perMesh: any[] = (item.layer as any).meshMaterials || [];
            for (const sp of perMesh) if (sp && sp.shader && !specs.includes(sp)) specs.push(sp);
            for (const spec of specs) {
              if (!spec || !spec.shader) continue;
              const provided: Record<number, unknown> = {};
              (spec.textures || []).forEach((t: any, i: number) => {
                if (t) provided[i] = t;
              });
              await renderer.prepareMeshMaterial(spec.shader, spec.combos, provided);
            }
          }
          renderer.setPuppetRenderer((layer: any, mvp: any, o: any) => {
            const item = byLayer.get(layer);
            if (!item) return;
            // 着色器光照是否接管了这一层（见 sceneLight 的构造与 color 的注释）
            const shaderLit = !!(o.sceneLight && layersHaveNormals(layer));
            mdlRenderer.draw(
              mvp,
              item.mdl,
              {
                time: o.time,
                animLayers: layer.animationLayers,
                // [we-scene patch 2026-09-28] 「被收拢的零件盖住 → 同步压扁」补偿规则：
                // 按壁纸白名单生效（见 render/mdl.js 的 COLLAPSED_PART_CULL_WORKSHOPS）
                syncCoveredParts: (mdl as any).shouldSyncCoveredParts?.(cfg.src) ?? false,
                // [we-scene patch] 脚本层的骨骼平移覆写（thisLayer.setBoneTransform）。
                // 骨骼拖拽壁纸的 puppet 动画数为 0，蒙皮完全由脚本驱动，
                // 所以这个表是它们唯一的形变来源。
                boneOverrides: boneOverridesByLayer.get(layer),
                // [we-scene patch] 效果链输出（贴图空间的合成结果）。
                // 无效果链时为 null，网格照常采样原始贴图。
                overrideTex: o.overrideTex || null,
                // [we-scene patch 2026-09-28] 逐子网格贴图（见挂载里 model 分支）。
                // 缺席时 mdl 渲染器逐网格回落到整层贴图，单网格模型行为不变。
                meshTextures: (layer as any).meshTextures || null,
                // [we-scene patch 2026-09-28] 场景光照 + 法线矩阵（只在网格带法线时生效）。
                sceneLight: sceneLight && layersHaveNormals(layer) ? sceneLight : null,
                normalMat: (() => {
                  const m = o.model;
                  if (!m || m.length !== 16) return null;
                  // 旋转部分（3x3）；图层多为等比缩放，直接取左上 3x3 再归一化列长即可
                  return [
                    m[0], m[1], m[2],
                    m[4], m[5], m[6],
                    m[8], m[9], m[10],
                  ];
                })(),
                // [we-scene patch] 顶点 z 是否参与投影：透视场景的真 3D 网格要保留
                // （renderer 按 cam.perspective 给），2D puppet 压平到 z=0。
                keepZ: !!o.keepZ,
                color: [
                  // [we-scene patch] 真 3D 网格 LIGHTING 材质乘场景环境光
                  //（o.ambient，未开光照时是 [1,1,1]）。**着色器光照接管时不再乘**
                  //：环境光已经作为 u_lightBase 进了片元，乘两遍会把背光面压到 0.36×。
                  layer.color[0] * layer.brightness * (shaderLit ? 1 : (o.ambient?.[0] ?? 1)),
                  layer.color[1] * layer.brightness * (shaderLit ? 1 : (o.ambient?.[1] ?? 1)),
                  layer.color[2] * layer.brightness * (shaderLit ? 1 : (o.ambient?.[2] ?? 1)),
                  layer.alpha,
                ],
              },
              item.tex,
            );
          });
        } catch (e) {
          console.warn(`puppet 渲染器初始化失败: ${(e as Error).message}`);
          reportDiag(rt, cfg, `puppet renderer 失败: ${(e as Error).message}`, "warn");
          mdlRenderer = null;
          for (const item of mdlItems) item.layer.puppet = null;
        }
      }
      if (disposed) return;
      reportDiag(rt, cfg, `puppet: ${mdlItems.length} meshes`, "info");

      // ---- puppet 附着点挂件 ----
      // parse 只合并了父 origin + 子 local；MDAT 附着点要等 puppet 装上才能加。
      // 静态：world = 已合并 origin + 绑定姿势附着点，位移传给整棵子孙
      // （空组「头发」自己 size=0，可见的是子层「主发」）。
      // 找不到名字则保持普通父子合并。
      // 逐帧：origin = base + (当前附着点 − 绑定附着点)，挂件随骨摆。
      const attachFollows = mdl.applyAttachmentBindOrigins(scene.layers);
      if (attachFollows.length) {
        reportDiag(rt, cfg, `attachments: ${attachFollows.length} hanging layers`, "info");
      }

      // [we-scene patch] 逐帧需要重算父子变换的图层集合（见 scene/parse.js
      // recomposeWorld / collectTransformDirty）。种子 = 变换字段绑了脚本或
      // 关键帧动画的层 + 挂件层，然后连同整棵子树收进来（父动子必须跟）。
      // 这是**风险闸门**：全库 187 张场景里 126 张不含任何脚本化变换，
      // 集合为空 → 一帧都不重算 → 从机制上不可能回归。
      const transformDirty: Set<unknown> = scn.collectTransformDirty(
        scene.layers,
        attachFollows.map((f: any) => f.layer),
      );
      if (transformDirty.size) {
        reportDiag(rt, cfg, `transform graph: ${transformDirty.size} live layers`, "info");
        // 脏子树里的粒子层：发射器变换要跟着图层每帧重读（见 syncLayerTransform）。
        for (const [lid, list] of particleSystemsByLayer) {
          if (!transformDirty.has(lid)) continue;
          for (const ps of list) particleDirty.push(ps);
        }
      }

      // [we-scene patch 2026-09-28] 运行时相机实体逐帧重选。
      //
      // 为什么要逐帧：相机实体的 origin/angles 绑脚本（3281559867 的 10 台全都绑了
      // 追目标的转向脚本），可见性也可能是脚本驱动的切换（Alternating 那对
      // `Cam Kirby/Dedede Alter` 每 30s 互换、`camerastyle` 改用户属性后
      // recomputeLayerVisibility 才更新）。parse 期那份快照只够画第一帧。
      //
      // 选择规则 = 参考引擎 ParseCameraObj 的 attach 语义：**最后一个可见的相机
      // 实体**（后 attach 覆盖先 attach）；一台都不可见时退回"作者没选机位"的
      // 场景语义 —— 顶层 scene.camera 快照（runtimeCamera=null，buildCamera 自会回落）。
      // [we-scene patch 2026-09-29] **相机路径**（`path: "scripts/camera_paths_*.json"`）。
      // 文件里是若干 clip（eye/center/up/fov/zoom 的关键帧曲线 + fps/length/mode），
      // 相机按 clip 依次飞行；`queuemode` 决定下一段顺序还是随机。
      // 本仓此前完全不解析 `path`：Dynamic 档（camerastyle=9）的机位一动不动，
      // 而作者那条「Dynamic Cam」正是靠 9 段路径做环绕运镜的。
      // 语义对齐参考引擎 SceneCameraPath::TickQueue（见 render/camera-path.js 头注）。
      for (const layer of scene.layers as any[]) {
        const src = layer && layer.srcObject;
        if (!src || typeof src.path !== "string" || !src.path) continue;
        try {
          const entry = pkg.getEntry(parsedPkg, src.path);
          if (!entry) {
            reportDiag(rt, cfg, `camera path '${src.path}' 不在包内（图层 ${layer.name}）`, "warn");
            continue;
          }
          const doc = JSON.parse(readText(entry));
          const path = camPathLib.createCameraPath(doc, typeof src.queuemode === "string" ? src.queuemode : "sequential");
          if (!path.clips.length) {
            reportDiag(rt, cfg, `camera path '${src.path}' 没有 clip（图层 ${layer.name}）`, "warn");
            continue;
          }
          layer.cameraPath = path;
          reportDiag(rt, cfg, `camera path '${layer.name}': ${path.clips.length} 段（queuemode=${src.queuemode || "sequential"}）`, "info");
        } catch (e) {
          reportDiag(rt, cfg, `camera path '${src.path}' 解析失败: ${String((e as Error).message || e).slice(0, 80)}`, "warn");
        }
      }

      /**
       * [we-scene patch 2026-10-03] **场景级相机路径**（`scene.json` 的
       * `camera.paths: ["scripts/camera_00.json", …]`）。
       *
       * 与上面那段（相机**对象**的 `path`）是同名的两种格式，见
       * `render/camera-path.js` 的 createSceneCameraPath 头注。这里只负责装配：
       * 逐文件取包内 JSON，合成一个 ticker 挂在场景上。
       *
       * 为什么必须做：官方内置 6 个 3D 工程（arsenal/demon_core/dna_fragment/
       * fantasticcar/neon_sunset/ricepod）**都没有相机实体**、只录了路径 ——
       * 全库 366 个场景里带 scene.camera.paths 的正好是这 6 个（工坊作者不用这条）。
       * 不解析就回落顶层 `scene.camera` 的编辑器视口快照：实测 fantasticcar 静照
       * 机位在车尾、路径第 0 段在车头右前方，与官方出图整个取景不同。
       */
      let sceneCamPath: any = null;
      {
        const declPaths = (scene as any)?.camera?.paths;
        if (Array.isArray(declPaths) && declPaths.length) {
          const clips: any[] = [];
          let missing = 0;
          for (const rel of declPaths) {
            if (typeof rel !== "string" || !rel) continue;
            try {
              const entry = pkg.getEntry(parsedPkg, rel);
              if (!entry) {
                missing++;
                continue;
              }
              const doc = eff.parseJsonTolerant(readText(entry));
              for (const c of (Array.isArray(doc) ? doc : doc?.paths) || []) clips.push(c);
            } catch (e) {
              reportDiag(rt, cfg, `场景相机路径 '${rel}' 解析失败: ${String((e as Error).message || e).slice(0, 80)}`, "warn");
            }
          }
          const built = camPathLib.createSceneCameraPath(clips);
          if (built.clips.length) {
            sceneCamPath = built;
            // 相机实体优先（作者显式摆的机位比编辑器录的路径更具体）；没有实体才用路径。
            if (!(scene as any).runtimeCamera) {
              const first = built.tick(0);
              if (first) {
                (scene as any).runtimeCamera = {
                  eye: first.eye.slice(),
                  center: first.center.slice(),
                  up: first.up.slice(),
                  fov: first.fov ?? 0,
                  angles: [0, 0, 0],
                };
              }
            }
            reportDiag(
              rt,
              cfg,
              `场景相机路径: ${built.clips.length} 段 / ${Math.round(built.duration)}s（${declPaths.length} 个文件${missing ? `，${missing} 个不在包内` : ""}）`,
              missing ? "warn" : "info",
            );
          } else if (missing === declPaths.length) {
            reportDiag(rt, cfg, `场景相机路径: ${declPaths.length} 个文件都不在包内，回退静态相机`, "warn");
          }
        }
      }

      // [we-scene patch 2026-09-28] 场景平行光 → 3D 网格光照。
      //
      // 为什么必须做：WE 的真 3D 网格（generic4 材质）是**上光**的 —— 作者素材实测
      // （3281559867，preview.gif 逐区域量）：背光面 = 反照率 × ambientcolor（墙面贴图
      // 均值 233 → 渲染 135，比值 0.58 ≈ ambientcolor 0.6078），受光面 ≈ 反照率 × 1.2
      // （棋盘地坪/草地贴图 177/163 → 渲染 207/200）。不做的话舞台的墙面/建筑就是
      // 「白块」—— 用户报的正是这个。
      //
      // 取景语义：`light:"ldirectional"` 的对象 angles 是**弧度**，光向 = 该节点 -z 轴
      // 旋转后的方向（与相机同一套旋转约定，见 math.js rotateFwd）；`visible` 为假或
      // `general.lightconfig.directional` 关掉时不打光。点光/聚光（UFO Light、帽灯）不进这一版
      // —— 它们有半径/衰减/锥角，且只影响局部发光物，平均贡献按官方 LightingV1 很小。
      const lightLayer = scene.layers.find(
        (l: any) => l.visible && l.srcObject && l.srcObject.light === "ldirectional",
      );
      let sceneLight: { dir: [number, number, number]; base: [number, number, number]; add: [number, number, number] } | null = null;
      {
        const lightCfg = (scene as any).general?.lightconfig;
        const dirOn = !lightCfg || lightCfg.directional === undefined || Number(lightCfg.directional) !== 0;
        if (lightLayer && dirOn) {
          const ang = lightLayer.angles || [0, 0, 0];
          // rotateFwd 的弧度版：从 -z 出发按 pitch(ang[0]) → yaw(ang[1]) 旋转。
          const yaw = Number(ang[1]) || 0;
          const pitch = Number(ang[0]) || 0;
          let x = -Math.sin(yaw);
          let z = -Math.cos(yaw);
          let y = 0;
          const y2 = y * Math.cos(pitch) - z * Math.sin(pitch);
          z = y * Math.sin(pitch) + z * Math.cos(pitch);
          y = y2;
          const len = Math.hypot(x, y, z) || 1;
          const rgb = String((lightLayer.srcObject && lightLayer.srcObject.color) || "1 1 1")
            .split(/\s+/)
            .map((v: string) => Number(v) || 0);
          const intensity = Number((lightLayer.srcObject && lightLayer.srcObject.intensity) ?? 1) || 0;
          const amb = String((scene as any).general?.ambientcolor ?? "1 1 1")
            .split(/\s+/)
            .map((v: string) => Number(v) || 0);
          sceneLight = {
            dir: [x / len, y / len, z / len],
            base: [amb[0] ?? 1, amb[1] ?? 1, amb[2] ?? 1],
            add: [
              (rgb[0] ?? 1) * intensity * SCENE_LIGHT_K,
              (rgb[1] ?? 1) * intensity * SCENE_LIGHT_K,
              (rgb[2] ?? 1) * intensity * SCENE_LIGHT_K,
            ],
          };
        }
      }
      const layersHaveNormals = (l: any) =>
        !!(l && l.puppet && l.puppet.meshes && l.puppet.meshes.some((m: any) => m && m.normals));

      const cameraLayers: any[] = scene.layers.filter((l: any) => l.isCamera)
      const refreshRuntimeCamera = (tSec: number) => {
        const rcAny: any = (scene as any).runtimeCamera
        if (!rcAny) return
        // [we-scene patch 2026-09-28] **脚本驱动的相机位姿优先**：Free Cam 这类模式
        // 经 `thisScene.setCameraTransforms({eye, center})` 直接摆相机（见 text.js 的
        // stamp）。只在最近 250ms 内写过才接管 —— 切回其它机位后脚本不再写，
        // 残留值不许永久钉住相机。
        const ct: any = (scene as any).cameraTransforms
        if (
          ct &&
          typeof ct.stamp === "number" &&
          typeof performance !== "undefined" &&
          performance.now() - ct.stamp < 250 &&
          Array.isArray(ct.eye) &&
          Array.isArray(ct.center) &&
          ct.eye.every((v: unknown) => Number.isFinite(Number(v))) &&
          ct.center.every((v: unknown) => Number.isFinite(Number(v)))
        ) {
          rcAny.eye[0] = Number(ct.eye[0]); rcAny.eye[1] = Number(ct.eye[1]); rcAny.eye[2] = Number(ct.eye[2])
          rcAny.center = [Number(ct.center[0]), Number(ct.center[1]), Number(ct.center[2])]
          return
        }
        if (rcAny.center) rcAny.center = null
        // [we-scene patch 2026-10-03] **场景级相机路径**（无相机实体时的运行时相机）：
        // 每帧按场景时间求值，写 eye/center/up（up 也要写 —— 路径录了滚转，
        // 只给 eye/center 会丢掉侧倾，见 buildCamera 的 upV 分支）。
        if (sceneCamPath && !cameraLayers.length) {
          const pose = sceneCamPath.tick(tSec)
          if (pose) {
            rcAny.eye[0] = pose.eye[0]; rcAny.eye[1] = pose.eye[1]; rcAny.eye[2] = pose.eye[2]
            rcAny.center = [pose.center[0], pose.center[1], pose.center[2]]
            if (Array.isArray(pose.up)) rcAny.up = [pose.up[0], pose.up[1], pose.up[2]]
            if (Number.isFinite(pose.fov) && pose.fov > 0) rcAny.fov = pose.fov
            return
          }
        }
        if (!cameraLayers.length) return
        let active: any = null
        for (const c of cameraLayers) if (c.visible) active = c
        if (!active) return
        const rc: any = rcAny
        // [we-scene patch 2026-09-29] **相机路径**：有 path 的机位由 clip 队列驱动，
        // 基准位姿取该相机实体脚本算出的当前位姿（OWE 的 queue_base 语义）。
        const camPath: any = (active as any).cameraPath
        if (camPath) {
          const basePose = {
            eye: [rc.eye[0], rc.eye[1], rc.eye[2]],
            center: Array.isArray(rc.center) && rc.center.length >= 3
              ? [rc.center[0], rc.center[1], rc.center[2]]
              : undefined,
            up: [0, 1, 0],
            fov: Number(rc.fov) || 50,
            zoom: Number(rc.zoom) || 1,
          };
          if (!basePose.center) {
            const a = rc.angles || [0, 0, 0];
            const yaw = Number(a[1]) || 0;
            const pitch = Number(a[0]) || 0;
            basePose.center = [rc.eye[0] + pitch * 0, rc.eye[1] + pitch, rc.eye[2] - 1];
          }
          const pose = camPath.tick(tSec, basePose);
          if (pose) {
            rc.eye[0] = pose.eye[0]; rc.eye[1] = pose.eye[1]; rc.eye[2] = pose.eye[2];
            rc.center = [pose.center[0], pose.center[1], pose.center[2]];
            if (Number.isFinite(pose.fov) && pose.fov > 0) rc.fov = pose.fov;
            const ct2: any = (scene as any).cameraTransforms;
            if (ct2 && Number.isFinite(pose.zoom) && pose.zoom > 0) ct2.zoom = pose.zoom;
            return;
          }
        }
        rc.eye[0] = active.origin[0]
        rc.eye[1] = active.origin[1]
        rc.eye[2] = active.origin[2]
        // 相机朝向：angles 是世界角（子层由 recomposeWorld 合成）。
        rc.angles[0] = active.angles[0]
        rc.angles[1] = active.angles[1]
        rc.angles[2] = active.angles[2]
        // fov<=0 表示这台没写 fov（参考引擎同口径：`if (cam.fov > 0) SetFov`），保留上一个。
        const f = Number(active.cameraFov)
        if (Number.isFinite(f) && f > 0) rc.fov = f
      }

      // ---- 文字对象 / 组件挂件（时钟、日期、星期等动态文本）----
      // 文字渲到离屏 2D canvas → GL 纹理 → 挂回图层本身（textureName），以**普通图层身份**
      // 进入渲染管线：z 序与图片层一致、可走效果链/混合/视差。旧 2D overlay 方案永远
      // 叠在所有图层之上，z 序错误，已废弃。
      // 纯逻辑（脚本沙箱求值 / 盒内排版 / 绘制）在 vendor we-scene render/text.js，
      // 可被 scripts/verify-text.mjs 在 node 里对全库脚本离线校验。
        const textWidgets: any[] = [];
        // 文字脚本的 init/applyUserProperties 延后队列（框架脚本装在 shared 上的
        // helper 要等对象脚本顶层跑完才存在——时钟1 的 registerListener）。
        const deferredTextInits: Array<{ sandbox: any; layer: any }> = [];
        const textLayerText = new Map<string, string>(); // 层名 → 当前文本（thisScene.getLayer 跨层读）
        const textShared: Record<string, unknown> = {}; // 同场景文字脚本共享状态（WE shared 全局）
        // [we-scene patch 2026-09-28] `shared.camera`（WE 文档化相机控制面）。
        // current* 走 getter 取**活**相机，见 text.js makeSharedCamera 的注释。
        textShared.camera = wtext.makeSharedCamera(() => {
          const rc: any = (scene as any).runtimeCamera;
          const ct: any = (scene as any).cameraTransforms;
          if (ct && Array.isArray(ct.eye) && Array.isArray(ct.center)) {
            return { eye: ct.eye, center: ct.center, distance: 0 };
          }
          if (!rc || !Array.isArray(rc.eye)) return null;
          const a = rc.angles || [0, 0, 0];
          const yaw = Number(a[1]) || 0;
          const pitch = Number(a[0]) || 0;
          const fwd = [
            -Math.sin(yaw) * Math.cos(pitch),
            pitch,
            -Math.cos(yaw) * Math.cos(pitch),
          ];
          return { eye: rc.eye, center: [rc.eye[0] + fwd[0], rc.eye[1] + fwd[1], rc.eye[2] + fwd[2]], distance: 0 };
        });
      let textCanvas: HTMLCanvasElement | null = null;
      let textCtx: CanvasRenderingContext2D | null = null;
      if (!SKIP_TEXT && scene.layers.some((l: any) => l.isText)) {
        const ortho = (scene as any).general?.orthogonalprojection;
        const projW = ortho?.width || c.width;
        const projH = ortho?.height || c.height;
        // 文字纹理质量系数 = 画布像素 / 可见世界像素：让文字的像素密度与最终显示一致。
        // 封顶 [0.5, 3] 并限单边 2048，防「超大盒子 × 高 DPR」把显存吃爆。
        const win0 = fitWindow(normalizeFit(rt.cfg.fit), projW, projH, c.width, c.height);
        const quality = Math.min(3, Math.max(0.5, c.width / Math.max(1, win0.viewW)));
        // 用户属性：与对象脚本 / 效果常量共用 liveUserProps（见 parseScene 之后）
        // 字体：pkg 内嵌 ttf/otf → FontFace（refs 计数，clear 归零释放）；systemfont_* → 系统字体栈
        const fontFamilies = new Map<string, string>(); // fontPath → CSS family
        const usedFontKeys: string[] = []; // 本次挂载引入的缓存键（cleanup 时 refs--）
        const fontPaths = new Set<string>();
        for (const l of scene.layers as any[]) if (l.isText && l.textFont) fontPaths.add(l.textFont);
        // 脚本可能在 applyUserProperties 里把 font 切到包内其它字体（3396722575 有 18 个）。
        // 只预载层快照路径的话，切档时 FontFace 不存在，字形回落成系统黑体。
        for (const e of (parsedPkg as { entries?: Array<{ name: string }> }).entries || []) {
          if (typeof e.name === "string" && /^fonts\/.+\.(ttf|otf|woff2?)$/i.test(e.name)) fontPaths.add(e.name);
        }
        for (const fp of fontPaths) {
          const key = `${cfg.src}|${fp}`;
          const cached = fontFaceCache.get(key);
          if (cached) {
            cached.refs++;
            usedFontKeys.push(key);
            fontFamilies.set(fp, cached.family);
            continue;
          }
          const sys = SYSTEM_FONT_FAMILIES[fp.toLowerCase()];
          if (sys) {
            fontFamilies.set(fp, sys);
            continue;
          }
          try {
            const fe = pkg.getEntry(parsedPkg, fp);
            // pkg 没内嵌时找本机 WE 原版素材树（local-assets/fonts/**，见
            // local-assets.ts 的消费面说明）：引用官方字体（NotoSans 等）的文字层
            // 不再回落系统黑体；没装素材 fetchLocalAssetFile 返回 null → 照旧兜底。
            const raw = fe
              ? fe instanceof Uint8Array
                ? fe
                : new Uint8Array(fe as ArrayBuffer)
              : await fetchLocalAssetFile(fp);
            if (!raw) continue;
            // Chrome OTS 拒载 cmap rangeShift 写错的 Tourner 等；先修再喂 FontFace。
            const bytes = sanitizeFontForBrowser(raw);
            // family 带 key 哈希：不同壁纸同文件名字体不共族，释放时按 family 删不误伤
            const fam = "wefont_" + fontKeyHash(key) + "_" + fp.split("/").pop()!.replace(/[^a-zA-Z0-9]/g, "_");
            const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
            const ff = new FontFace(fam, `url(${url})`);
            await ff.load();
            if (disposed) {
              // 挂载中途被切走：不注册进 document.fonts，URL 也归当前实例后续 clear 处理
              URL.revokeObjectURL(url);
              break;
            }
            document.fonts.add(ff);
            (rt.objectUrls ??= []).push(url);
            fontFamilies.set(fp, fam);
            fontFaceCache.set(key, { family: fam, refs: 1 });
            usedFontKeys.push(key);
          } catch (e) {
            console.warn(`字体加载失败 ${fp}: ${(e as Error).message}`);
          }
        }
        if (usedFontKeys.length) {
          // 链上字体释放：clear(rt) 时逐键 refs--，归零才从 document.fonts 删
          const prevCleanup = rt.sceneCleanup;
          rt.sceneCleanup = () => {
            releaseFontFaces(usedFontKeys);
            prevCleanup?.();
          };
        }
        // 共享离屏画布：同一时刻只画/传一个挂件，尺寸按需调整
        textCanvas = document.createElement("canvas");
        textCtx = textCanvas.getContext("2d");
        const MAX_TEX = 2048;
        for (const layer of scene.layers as any[]) {
          if (!layer.isText) continue;
          try {
            const item: any = {
              layer,
              sandbox: null,
              texName: "__wstext_" + layer.id,
              entry: null,
              lastKey: null as string | null,
              quality,
            };
            if (layer.textScript) {
              item.sandbox = wtext.evalTextScript(layer.textScript, layer.textScriptProps, {
                // [we-scene patch] layer：text/pointsize/font 写穿到真图层
                //（与对象字段脚本同源，见 text.js evalTextScript 写穿段）
                layer,
                text: layer.text ?? "",
                font: layer.textFont || "",
                pointsize: layer.textPointsize,
                color: layer.textColor,
                angles: layer.angles,
                origin: layer.origin,
                scale: layer.scale,
                visible: layer.visible,
                canvasSize: { width: projW, height: projH },
                timeOfDay: timeOfDayValue,
                userProperties: liveUserProps,
                shared: textShared,
                storage: sceneStorage,
                audioViews,
                inputView,
                // [we-scene patch] 文字脚本此前没有真定时器（no-op stub），
                // 与对象/效果开关/常量/general 统一走 engineTimers（P1-1）。
                ...timerOpts,
                mediaControl,
                windowTitle: windowDriver.snapshot,
                openUserShortcut: shortcuts.openUserShortcut,
                getLayerText: (name: string) => textLayerText.get(name),
                onError: (e: unknown) => {
                  reportDiag(rt, cfg, `text script '${layer.name}' 失败: ${String((e as Error).message || e).slice(0, 120)}`, "warn");
                },
              });
              if (item.sandbox) {
                propSandboxes.push(item.sandbox);
                // [we-scene patch] 文字脚本的 init/applyUserProperties **延后到对象脚本
                // 装配完之后**：框架脚本（3163060610 基础脚本.visible，对象脚本）在顶层
                // 往 shared 上装 eventDispatcher/CAniClass，文字脚本的 init 里
                // `shared.eventDispatcher.registerListener(...)`（时钟1）——
                // 先跑文字 init 时框架还没装，连环 TypeError。
                deferredTextInits.push({ sandbox: item.sandbox, layer });
                // [we-scene patch] 歌名/歌手文字层就靠媒体回调拿数据：
                // `export function mediaPropertiesChanged(e){ mediaData = e.title }`
                // 是全库 44 处文字脚本的标准形态。不登记就永远显示作者的占位文本。
                if (item.sandbox.hasMediaHook) registerMediaHook(item.sandbox);
                registerResizeHook(item.sandbox);
                // [we-scene patch] 文字脚本的 animationEvent 同样进图层级广播表。
                if (item.sandbox.hasAnimEventHook) registerAnimEventSink(layer, { sandbox: item.sandbox, kind: "text" });
              }
            }
            // 静态文本预置进跨层表（脚本层每帧更新自己的条目）
            textLayerText.set(layer.name || "", String(layer.text ?? ""));
            // anchor ≠ center 时一次性平移 origin，让盒子按锚点贴住原点（世界 y 轴朝上）。
            // 用的是原盒子尺寸 —— 下面立刻把 layer.size 扩成带溢出边距的画布尺寸。
            // [we-scene patch] 偏移必须同时折进 localOrigin：world 逐帧由
            // recomposeWorld 从 local 重新合成，只改 world 的话下一帧就被冲掉，
            // 带脚本/动画变换的文字层锚点会当场失效。
            if (layer.textAnchor !== "center" && layer.size[0] > 0 && layer.size[1] > 0) {
              const hw = (layer.size[0] * (layer.scale[0] || 1)) / 2;
              const hh = (layer.size[1] * (layer.scale[1] || 1)) / 2;
              const a = layer.textAnchor;
              let adx = 0;
              let ady = 0;
              if (a.includes("left")) adx += hw;
              if (a.includes("right")) adx -= hw;
              if (a.includes("top")) ady -= hh;
              if (a.includes("bottom")) ady += hh;
              // [we-scene patch] none = 无锚点 ⇒ 盒的左下角落在 origin 上（盒向右上方长）。
              // 3694771168 周几层的官方截图：方框 [origin, origin+size]，与逐像素量到的
              // [3295,3379]×[293,377] 吻合（见 parse.js textAnchor 注释）。none 不含任何
              // 方向词，上面四条都不会命中，这里单独补。
              if (a === "none") {
                adx += hw;
                ady += hh;
              }
              layer.origin[0] += adx;
              layer.origin[1] += ady;
              if (layer.localOrigin) {
                layer.localOrigin[0] += adx;
                layer.localOrigin[1] += ady;
              }
            }
            // 盒子（size）只是定位框，WE 不裁剪溢出文字（halign right 时整行向左长出）。
            // 画布/图层 quad 按盒子四周扩 M，内部盒子位置不变：文字溢出画进边距里。
            // 边距按字号估，不能按层的长边。4708×420 的圆环文字被扩成 6756×2468 后，
            // geometric_transform 的 UV 圆变形作用在近乎方形的透明画布上，丝带塌成直线。
            const em0 = TEXT_EM_SCALE * Math.max(1, layer.textPointsize);
            // tint 蒙版按原盒绘制：扩边一超过几像素，UV 就对不上字形（世界时钟粉条/缺色）。
            const isTintMask = wtext.textLayerHasTintMask(layer);
            const marginCap = isTintMask ? 8 : 256;
            const anchorSafe =
              !layer.textAnchor || layer.textAnchor === "center" || layer.textAnchor === "none";
            const hasVisibleEffects = ((layer.effects as Array<{ visible?: boolean }>) || []).some(
              (e) => e && e.visible !== false,
            );
            // [we-scene patch] 带可见效果的文字层不吃**基础**边距：效果链 FBO 与最终合成 quad
            // 都按 layer.size 走（renderer.js 的 contentW/H = |size×scale|），而基础边距按字号估
            //（32 号字 = 2×128+8 = 256、两侧共 +512），会把整层几何撑到盒子的 4.6 倍 ——
            // 3694771168 的周几盒 141×141，hollow_out 方块被画成 392px 的黑块（官方 84.6px）。
            // 本文件自己的护栏写着「效果 UV 按盒归一」（见下方），但基础边距是无条件加的，
            // 护栏形同虚设。这类层改为只按**实际墨水**扩边：装得下 ⇒ layer.size 就是原盒，
            // 效果几何与官方一致；真溢出时照扩（WE 不裁字，不能为了对齐几何把字切了）。
            const baseMargin = hasVisibleEffects && !isTintMask
              ? 0
              : Math.min(marginCap, wtext.textCanvasMargin(em0, 0));
            let margin = baseMargin;
            item.boxW = layer.size[0] > 0 ? layer.size[0] : em0 * 4;
            item.boxH = layer.size[1] > 0 ? layer.size[1] : em0 * 1.6;
            // [we-scene patch] 静态文字层按墨水扩边（挂载期算一次，与逐帧的媒体文字层
            // 同一机制）：盒只是定位框，WE 不裁剪溢出文字，而我们的画布 = 盒 + 基础
            // 边距，超出的墨水被纹理边缘切掉。预设壁纸最容易撞上——用户值常比作者导出
            // 时的快照长：3427522122 的城市名 "SÃO PAULO" 96px 下宽 432，盒只有 150，
            // 文字从盒中线（x=275）起排到 707、画布止于 550，屏幕上只剩 "SÃO P"+ 半个
            // A（看着像 SÃO PF）。扩边对称（盒中心 = 画布中心 = 层 origin），墨水位置
            // 不变；装得下时 textCanvasMarginGrow 退回基础边距，作者原布局一字不动。
            // 只做**静态**层（内容不变 ⇒ 画布不抖），护栏与媒体层同源再加一条：
            //   - 无脚本沙箱：脚本会改 thisLayer.size/text，且点击命中区由脚本驱动，
            //     扩出的大片透明边距会变成无声的点击陷阱；
            //   - 无可见效果：效果 UV 按盒归一，扩边让圆环/蒙版错位（3396722575 丝带）；
            //     —— 这条只对**基础**边距生效（见上面 baseMargin）：带效果的层仍按墨水扩，
            //     否则溢出的字会被画布切掉；墨水装得下时 margin=0，效果几何 = 原盒。
            //   - 无 tint 蒙版：同上（3122339805 世界时钟粉条）；
            //   - 锚点 none/center：方向锚点的 origin 在挂载期按原盒平移过，扩边会把盒挪走。
            {
              if (textCtx && !item.sandbox && anchorSafe && !isTintMask) {
                const pts = Math.max(1, layer.textPointsize);
                const em = TEXT_EM_SCALE * pts;
                const fontPath = layer.textFont || "";
                const fam = fontPath ? fontFamilies.get(fontPath) || "sans-serif" : "sans-serif";
                textCtx.setTransform(1, 0, 0, 1, 0, 0);
                textCtx.font = `${em}px "${fam}", sans-serif`;
                const met = textCtx.measureText("");
                const fontH = (met.fontBoundingBoxAscent || 0) + (met.fontBoundingBoxDescent || 0);
                const spacing = layer.textSpacing || [0, 0];
                const layout = wtext.layoutText(
                  String(layer.text ?? ""),
                  {
                    boxW: item.boxW,
                    boxH: item.boxH,
                    pointsize: em,
                    lineHeight: (fontH > 0 ? fontH : em * 1.25) + spacing[1],
                    spacing,
                    padding: layer.textPadding || 0,
                    maxwidth: layer.textMaxwidth || 0,
                    limitwidth: !!layer.textLimitwidth,
                    maxrows: layer.textMaxrows || 0,
                    limitrows: !!layer.textLimitrows,
                    limituseellipsis: !!layer.textLimituseellipsis,
                    halign: layer.textHAlign,
                    valign: layer.textVAlign,
                    // 对齐参考点 = 盒内与 origin 重合的那一点。anchor:none 时盒的
                    // 左下角贴 origin（上面已按锚点平移过），参考点跟着换到 (0, boxH)。
                    ...(layer.textAnchor === "none" ? { refX: 0, refY: item.boxH } : {}),
                  },
                  (s: string) => textCtx!.measureText(s).width,
                );
                margin = Math.max(margin, wtext.textCanvasMarginGrow(layout, item.boxW, item.boxH, margin));
              }
            }
            item.margin = margin;
            layer.size = [item.boxW + margin * 2, item.boxH + margin * 2];
            item.entry = {
              glTex: rnd.makeTexture(renderer.gl, new Uint8Array([0, 0, 0, 0]), 1, 1),
              width: 1,
              height: 1,
              rg88: false,
            };
            textures.set(item.texName, item.entry);
            layer.textureName = item.texName;
            layer.solid = false;
            textWidgets.push(item);
          } catch (e) {
            console.warn(`文字对象 ${layer.name} 初始化失败: ${(e as Error).message}`);
          }
        }
        // 场景卸载时释放文字纹理
        if (textWidgets.length > 0) {
          const prevCleanup = particleCleanup;
          particleCleanup = () => {
            prevCleanup?.();
            for (const it of textWidgets) renderer.gl.deleteTexture(it.entry.glTex);
          };
        }
        // 每帧：沙箱求值 → 内容变化才重排版/重绘/上传纹理（求值不再节流，见调用处注释）。
        // 求值对全部文字层执行（含隐藏层：World Time 类脚本跨层读它们），绘制只画可见层。
        const updateTexts = (t: number) => {
          if (!textCtx || !textCanvas) return;
          const ctx = textCtx;
          for (const it of textWidgets) {
            const layer = it.layer;
            let content = String(layer.text ?? "");
            if (it.sandbox && it.sandbox.hasUpdate) {
              it.sandbox.engine.runtime = t;
              it.sandbox.engine.timeOfDay = timeOfDayValue;
              const r = it.sandbox.callUpdate(content);
              if (r !== null && r !== undefined) content = String(r);
              else if (it.sandbox.thisLayer.text) content = String(it.sandbox.thisLayer.text);
            } else if (it.sandbox && typeof it.sandbox.thisLayer?.text === "string") {
              // 纯 applyUserProperties 脚本（3396722575 旋转文字）没有 update，
              // 但会改 thisLayer.font / thisLayer.text，每帧仍要采读写回。
              content = String(it.sandbox.thisLayer.text);
            }
            textLayerText.set(layer.name || "", content);
            if (!layer.visible) continue;
            // 脚本可改写 thisLayer.pointsize/text/font；内容、字号、字体都不变才跳过重绘。
            // [we-scene patch] maxwidth 关键帧动画改写的是 textMaxwidth（此前写
            // layer.maxwidth 死槽且 key 不含它，写了也不重排，2902406982 宽度脉动）；
            // limitwidth/maxrows/limitrows 一并入 key 防同类潜伏。
            const pts = Math.max(1, it.sandbox ? it.sandbox.thisLayer.pointsize : layer.textPointsize);
            const fontPath = (it.sandbox && it.sandbox.thisLayer.font) || layer.textFont || "";
            const key = `${content}\u0000${pts}\u0000${fontPath}\u0000${layer.alpha}\u0000${layer.textCastshadow}\u0000${layer.textMaxwidth || 0}\u0000${layer.limitwidth ? 1 : 0}\u0000${layer.maxrows || 0}\u0000${layer.limitrows ? 1 : 0}`;
            if (it.lastKey === key) continue;
            it.lastKey = key;
            try {
              // 字号语义：WE 的 pointsize 经 TEXT_EM_SCALE 放大后才是场景像素（实测三路
              // 证据：预览图字高、盒子高/pointsize 全库众数、字号滑条 3~5 的量纲）
              const em = TEXT_EM_SCALE * pts;
              const bw = it.boxW;
              const bh = it.boxH;
              const sx = Math.abs(layer.scale[0] || 1);
              const sy = Math.abs(layer.scale[1] || 1);
              const fam = fontPath ? (fontFamilies.get(fontPath) || "sans-serif") : "sans-serif";
              // 先排版（measure 只依赖 ctx.font，与 transform 无关），再按墨水量界定画布。
              ctx.setTransform(1, 0, 0, 1, 0, 0);
              ctx.font = `${em}px "${fam}", sans-serif`;
              const met = ctx.measureText("");
              const fontH = (met.fontBoundingBoxAscent || 0) + (met.fontBoundingBoxDescent || 0);
              const spacing = layer.textSpacing || [0, 0];
              const layout = wtext.layoutText(content, {
                boxW: bw,
                boxH: bh,
                pointsize: em,
                lineHeight: (fontH > 0 ? fontH : em * 1.25) + spacing[1],
                spacing,
                padding: layer.textPadding || 0,
                maxwidth: layer.textMaxwidth || 0,
                limitwidth: !!layer.textLimitwidth,
                maxrows: layer.textMaxrows || 0,
                limitrows: !!layer.textLimitrows,
                limituseellipsis: !!layer.textLimituseellipsis,
                halign: layer.textHAlign,
                valign: layer.textVAlign,
                // 同挂载期：anchor:none 的参考点 = 盒左下角（见 mount 处注释）。
                ...(layer.textAnchor === "none" ? { refX: 0, refY: bh } : {}),
              }, (s: string) => ctx.measureText(s).width);
              // [we-scene patch] 媒体组件的歌名/歌手层盒子是 WE 占位尺寸（2×2，
              // WE 运行时按内容重排），墨水远超盒子，旧实现把字截在画布边缘
              // （3785267658 整层空白）。这类层按溢出墨水**对称**扩边：盒中心恒等于
              // 画布中心 = 层 origin，墨水位置不随扩边移动。
              // 判据必须同时满足，缺一不可（2026-09-11 收窄，曾因只看盒子小误伤）：
              //  ① 占位小盒（boxW/H ≤ 4）——正常大盒自有几何，扩边会改 quad 把
              //     好字挪出可见区（2938612768 标题被黑卡裁）；
              //  ② 沙箱挂了媒体回调（hasMediaHook）——三体 3509243656 的
              //     time/State/Tx 等 2×2 是脚本驱动的普通文本，内容动态，扩边会让
              //     layer.size 每帧跟着内容跳变、字忽大忽小甚至消失；
              //  ③ 墨水在**当前画布**（盒 + 既有 margin）里确实装不下——短词
              //     （Paused/Playing）不溢出就不扩，保持作者原布局。
              let M: number = it.margin;
              // [we-scene patch 3151551777] 媒体大盒的右对齐长标题：WE 不裁剪溢出
              // 文字（halign right 整行向左长出），但我们的画布只扩到「盒 + 基础
              // 边距」，溢出超出边距的部分被纹理边缘截掉（"Color Your Night" 只剩
              // "Your Night"）。挂媒体回调、且墨水在当前画布里装不下的层，按墨水
              // 对称扩边（盒中心 = 画布中心 = origin 不动，墨水位置不变）：
              //   - 只增不减：换短歌名后保持大画布，size 不随内容来回跳；
              //   - 跳过 tint 蒙版层（蒙版按原盒 UV 对齐，扩边会错位）；
              //   - 锚点须为 none/center（方向锚点的 origin 在挂载期按原盒平移过，
              //     扩边会把盒子挪走——2938612768 的教训）。
              const anchorSafe = !layer.textAnchor || layer.textAnchor === "center" || layer.textAnchor === "none";
              // [we-scene patch] 内容变长的文字层同样要按墨水扩边。此前只有挂媒体回调
              // 的层能扩，「脚本产出的值比作者快照长」一律被画布右缘切掉：
              //   3155776049 的日期 → 2003年2月16日（实测溢出 83px）、
              //   3662790108 的信息行 → 银河系公转速度: 828000 km/h（溢出 465px）、
              //   3509243656 的 2×2 占位横条 → 溢出 1801px。
              // 这些层没有媒体回调，闸门一挡就永远是挂载时那点边距。只增不减：
              // 时钟/进度这类每帧变长的内容把画布撑到用过的最大值后不再回缩，字不抖。
              if (!wtext.textLayerHasTintMask(layer) && anchorSafe) {
                const grow = wtext.textCanvasMarginGrow(layout, bw, bh, M);
                if (!!it.sandbox?.hasMediaHook && wtext.shouldGrowMediaPlaceholder(bw, bh, true)) {
                  // 2×2 占位层：跟随内容双向扩/缩（旧行为；短词 Paused/Playing
                  // 时 grow 退回基础边距，size 与挂载一致）
                  layer.size[0] = bw + grow * 2;
                  layer.size[1] = bh + grow * 2;
                } else if (grow > M) {
                  layer.size[0] = bw + grow * 2;
                  layer.size[1] = bh + grow * 2;
                }
                if (grow !== M) {
                  // 内部盒在新画布里的位置 = 新边距（盒中心 = 画布中心）
                  it.margin = grow;
                  M = grow;
                }
              }
              // [we-scene patch] 裁字诊断：扩边后仍装不下的墨水说明这层被纹理边缘切了
              // （tint 蒙版层刻意不扩边——蒙版 UV 按盒对齐，扩边会错位；方向锚点层
              // 的 origin 在挂载期按原盒平移过）。以前只会静默少几个字，看着像字形
              // 或编码错了（"SÃO PAULO"→"SÃO PF" 排查了半天），这里留一条痕迹：
              // 每层每次挂载报一次 + 进 __textClip 供抽查。
              if (!it.clipReported) {
                const ink = wtext.inkOverflow(layout, bw, bh);
                const over = Math.max(ink[0], ink[1], ink[2], ink[3]) - M;
                if (over > 2) {
                  it.clipReported = true;
                  const rec = {
                    name: String(layer.name ?? ""),
                    over: Math.round(over),
                    text: String(content).slice(0, 24),
                  };
                  const list = ((rt as { textClip?: typeof rec[] }).textClip ??= []);
                  list.push(rec);
                  reportDiag(rt, cfg, `文字被画布裁切：${rec.name || "(无名)"} 溢出 ${rec.over}px：「${rec.text}」`, "warn");
                }
              }
              // 非扩边层**不碰** layer.size（挂载时已按 box+margin 设好；脚本/动画
              // 可能也在改它，每帧无条件覆写会与那些写入互相打架）。
              let cw = Math.max(1, Math.round(layer.size[0] * sx * it.quality));
              let ch = Math.max(1, Math.round(layer.size[1] * sy * it.quality));
              const shrink = Math.min(1, MAX_TEX / Math.max(cw, ch));
              cw = Math.max(1, Math.round(cw * shrink));
              ch = Math.max(1, Math.round(ch * shrink));
              if (textCanvas.width !== cw || textCanvas.height !== ch) {
                textCanvas.width = cw;
                textCanvas.height = ch;
              } else {
                ctx.clearRect(0, 0, cw, ch);
              }
              // [we-scene patch] 改 canvas.width/height 会**重置整个 2D 上下文状态**
              // （font/transform/textBaseline 全回默认 10px sans-serif）。上面 measure
              // 阶段设的 ctx.font 在尺寸变化那帧就此丢失，若再把 ctx.font 透传给
              // drawTextLayer，320px 的大字会按 10px 画、缩放后只剩几个像素
              // （2468489223 白色时钟整层不可见，纹理仅 43 不透明像素）。
              // 尺寸变化后必须用显式保存的 fontCss 重新设置，不能读 ctx.font。
              const fontCss = `${em}px "${fam}", sans-serif`;
              // 「场景单位 → 画布像素」折进 transform，再平移到内部盒子左上角
              const k = Math.min(cw / layer.size[0], ch / layer.size[1]);
              ctx.setTransform(k, 0, 0, k, 0, 0);
              ctx.translate(M, M);
              wtext.drawTextLayer(ctx, layout, {
                font: fontCss,
                color: layer.textColor,
                alpha: layer.alpha,
                brightness: layer.brightness,
                spacing,
                pointsize: em,
                opaquebackground: !!layer.textOpaquebackground,
                backgroundcolor: layer.textBackgroundcolor,
                backgroundbrightness: layer.textBackgroundbrightness,
                castshadow: !!layer.textCastshadow,
              });
              const entry = it.entry;
              renderer.gl.bindTexture(renderer.gl.TEXTURE_2D, entry.glTex);
              renderer.gl.texImage2D(renderer.gl.TEXTURE_2D, 0, renderer.gl.RGBA, renderer.gl.RGBA, renderer.gl.UNSIGNED_BYTE, textCanvas);
              entry.width = cw;
              entry.height = ch;
            } catch (e) {
              console.warn(`文字对象 ${layer.name} 绘制失败: ${(e as Error).message}`);
              it.lastKey = null; // 下一帧重试
            }
          }
        };
        rt.sceneTextUpdate = updateTexts;
        // 调试出口：文字挂件（排查「脚本返回了新文本但画面没变」）
        (window as unknown as Record<string, unknown>).__textWidgets = textWidgets;
        reportDiag(rt,
          cfg,
          `text widgets: ${textWidgets.length} (scripts ${textWidgets.filter((i) => i.sandbox).length}, ` +
            `fonts ${fontFamilies.size}, quality ${quality.toFixed(2)})`,
          "info",
        );
      }
      if (disposed) return;
      // ---- WE 对象脚本（scale/origin/color/alpha/brightness/angles 绑定的脚本）----
      // 经典用法：音频条的 scale 脚本读 registerAudioBuffers 按频段改写 scale.y
      // （3078285611 底部 11 根音条即此）。逐帧求值，出错熔断回退字段静态快照。
      // [we-scene patch 2026-09-28] 每帧把**活相机**灌进 cameraTransforms.eye/center，供脚本
      // `getCameraTransforms()` 读到真实位姿（Free Cam 的 initPos/restore 依赖它）。
      // 脚本随后写回的值会打 stamp（见 text.js setCameraTransforms），refreshRuntimeCamera
      // 只在 stamp 新鲜时让脚本位姿接管 → 顺序天然正确。
      const seedCameraTransforms = () => {
        const ct: any = (scene as any).cameraTransforms;
        const rc: any = (scene as any).runtimeCamera;
        if (!ct || !rc || !Array.isArray(rc.eye)) return;
        ct.eye = [rc.eye[0], rc.eye[1], rc.eye[2]];
        if (Array.isArray(rc.center) && rc.center.length >= 3) {
          ct.center = [rc.center[0], rc.center[1], rc.center[2]];
        } else {
          const a = rc.angles || [0, 0, 0];
          const yaw = Number(a[1]) || 0;
          const pitch = Number(a[0]) || 0;
          ct.center = [
            rc.eye[0] - Math.sin(yaw) * Math.cos(pitch),
            rc.eye[1] + pitch,
            rc.eye[2] - Math.cos(yaw) * Math.cos(pitch),
          ];
        }
      };
      const objectScriptRuns: Array<{ layer: any; field: string; slot: string; kind: "vec3" | "scalar" | "bool"; sandbox: any; last?: unknown }> = [];
      // [we-scene patch] 跨层脚本（thisScene.getLayer(x).origin/scale = …）写了某个
      // **子层** local 变换槽后，目标层要进本帧 recompose 集合（顶层 local===world
      // 已即时同步，只有子层需从父链合成）。沙箱经 sceneApi.markTransformDirty 登记，
      // 每帧 recompose 前并入 transformDirty 后清空。
      const scriptedTransformDirty = new Set<unknown>();
      // 关键帧动画：逐帧推进并把结果写回图层字段
      const animRuns: Array<{ layer: any; field: string; slot: string; ctrl: any }> = [];
      // 粒子 instanceoverride 的关键帧动画（与对象字段动画同一时钟/同一推进队列）：
      // 写回目标是该层所有粒子系统的倍率，不是图层字段。
      const overrideAnimRuns: Array<{ layer: any; key: string; ctrl: any }> = [];
      // [we-scene patch] instanceoverride 的 {script}：每帧 callUpdate →
      // setOverrideValue（rate/count/size/alpha 轻量写口、colorn 颜色）。
      // 与 overrideAnimRuns 同一处逐帧写，粒子 advance/render 当帧读到。
      const overrideScriptRuns: Array<{ layer: any; key: string; sandbox: any }> = [];
      // [we-scene patch] animationlayers[].visible 脚本（puppet clip 层开关，
      // 24 段/8 张）：init 停错位层、帧事件 play；visible 返回值折叠后控制该层。
      const animLayerScriptRuns: Array<{ layer: any; index: number; sandbox: any }> = [];
      // [we-scene patch 2026-09-28] animationlayers[].blend/rate 的脚本形态
      //（blend 是 clip 权重：0→1 淡入；rate 是播放倍速）。见 parse.js 的字段注释。
      const animLayerFieldRuns: Array<{ layer: any; index: number; field: "blend" | "rate"; sandbox: any }> = [];
      // blend 的**关键帧动画**形态（Attack/Bump 这类「按事件起停的短曲线」）
      const animLayerBlendAnims: Array<{ layer: any; index: number; field: "blend"; ctrl: any }> = [];
      const generalAnimRuns: Array<{ field: string; ctrl: any; write: (v: unknown) => void }> = [];
      const sceneNamedAnims: Record<string, any> = {};
      // 效果开关脚本（effects[i].visible.script）：逐帧决定该效果是否参与渲染
      const effectVisibleRuns: Array<{ effect: any; sandbox: any; last?: unknown }> = [];
      const generalScriptRuns: Array<{ field: string; sandbox: any; write: (v: unknown) => void }> = [];
      // [we-scene patch] 挂了 cursor* 回调的沙箱（图层 → 沙箱列表）。
      // 这是 WE 场景互动的主入口：全库 267 处挂钩、跨 19 个壁纸，
      // 远多于 input.cursor*（18 个脚本）。同一图层可能有多个字段脚本各带回调。
      const cursorHooks = new Map<any, any[]>();
      const addCursorHook = (layer: any, sandbox: any) => {
        if (!sandbox || typeof sandbox.callCursor !== "function") return;
        if (!sandbox.hasCursorHook) return;
        const list = cursorHooks.get(layer);
        if (list) list.push(sandbox);
        else cursorHooks.set(layer, [sandbox]);
      };
      // 文字层的 cursor* 回调（3786330502 的悬停交互挂在文字层上）
      for (const it of textWidgets) {
        if (it.sandbox) addCursorHook(it.layer, it.sandbox);
      }
      {
        const ortho = (scene as any).general?.orthogonalprojection;
        const objProjW = ortho?.width || c.width;
        const objProjH = ortho?.height || c.height;
        const objUserProps = liveUserProps;
        const writeGeneralField = (field: string, v: unknown) => {
          const g = (scene as any).general || {};
          if (field === "zoom" && typeof v === "number" && Number.isFinite(v) && v > 0) {
            (scene as any).cameraTransforms.zoom = v;
            if (g.zoom && typeof g.zoom === "object") g.zoom.value = v;
            else g.zoom = v;
            return;
          }
          if (g[field] && typeof g[field] === "object" && "value" in g[field]) g[field].value = v;
          else g[field] = v;
        };
        let nextLayerId =
          1 + Math.max(0, ...(scene.layers as any[]).map((l: any) => Number(l.id) || 0));
        const sceneApi = {
          recomputeVisibility,
          // 帧内合并通道（见 markVisibilityDirty 的注释）：沙箱的 `visible` setter
          // 优先用它，只有阶段外才落到上面的立即重算
          markVisibilityDirty,
          markTransformDirty: (layer: any) => {
            if (layer && layer.id !== undefined && layer.id !== null) {
              scriptedTransformDirty.add(layer.id);
            }
          },
          getSceneLayer: (name: string) =>
            (scene.layers as any[]).find((l) => l.name === name && !l.destroyed) || null,
          getSceneLayerById: (id: unknown) =>
            (scene.layers as any[]).find((l) => l.id === id && !l.destroyed) || null,
          enumerateSceneLayers: () => (scene.layers as any[]).filter((l) => !l.destroyed),
          getSceneAnimation: (name: string) => {
            if (name == null || name === "") return null;
            if (sceneNamedAnims[name]) return sceneNamedAnims[name];
            for (const l of scene.layers as any[]) {
              if (l.animations && l.animations[name]) return l.animations[name];
            }
            return null;
          },
          cameraTransforms: (scene as any).cameraTransforms,
          // [we-scene patch 2026-09-28] 效果材质常量动画的**渲染侧**控制器
          //（脚本 `getEffect(i).getMaterial(j).getAnimation("fade")` 要拿到正在
          // 推进的那一份，自己 new 一个只是另一个播放头）。见 text.js makeMaterialBag。
          getConstantAnimation: (def: unknown) =>
            typeof (renderer as any).getConstantAnimation === "function"
              ? (renderer as any).getConstantAnimation(def)
              : null,
          getInitialLayerConfig: (arg: any) => {
            const name = arg && typeof arg === "object" ? arg.name : String(arg || "");
            return (scene.layers as any[]).find((l) => l.name === name) || null;
          },
          createSceneLayer: (layerCfg: any) => {
            // 字符串 = 已解析的模型路径（makeThisScene 已按 __workshopId 展开）。
            // 克隆同 image 的已装配层（含 textureName / layerMaterial 效果），
            // 否则会得到无贴图空层 —— 3789604238 Simple Visualizer 的 63 根克隆条。
            let src: any = layerCfg && typeof layerCfg === "object" ? layerCfg : null;
            let assetToMount: { path: string; kind: "model" | "particle" } | null = null;
            if (typeof layerCfg === "string") {
              const imagePath = layerCfg;
              src =
                (scene.layers as any[]).find(
                  (l) => l && !l.destroyed && l.image === imagePath && l.textureName,
                ) ||
                (scene.layers as any[]).find(
                  (l) => l && !l.destroyed && l.image === imagePath,
                ) ||
                null;
              if (!src) {
                // 没有模板层可克隆 → 从包内资产实例化（engine.registerAsset +
                // createLayer 的常规路径；1712475860 Dino Run 的金币/收集特效）。
                if (/^models\//.test(imagePath) && pkg.getEntry(parsedPkg, imagePath)) {
                  assetToMount = { path: imagePath, kind: "model" };
                  src = {
                    image: imagePath,
                    origin: [0, 0, 0],
                    scale: [1, 1, 1],
                    angles: [0, 0, 0],
                    size: [0, 0],
                    color: [1, 1, 1],
                    visible: true,
                    alpha: 1,
                    brightness: 1,
                  };
                } else if (/^particles\//.test(imagePath) && pkg.getEntry(parsedPkg, imagePath)) {
                  assetToMount = { path: imagePath, kind: "particle" };
                  src = {
                    particle: imagePath,
                    origin: [0, 0, 0],
                    scale: [1, 1, 1],
                    angles: [0, 0, 0],
                    size: [0, 0],
                    color: [1, 1, 1],
                    visible: true,
                    alpha: 1,
                    brightness: 1,
                  };
                } else {
                  reportDiag(
                    rt,
                    cfg,
                    `createLayer('${imagePath}') 找不到已加载的同模型层`,
                    "warn",
                  );
                  return null;
                }
              }
            }
            if (!src) src = {};
            const clone: any = {
              ...src,
              id: nextLayerId++,
              origin: Array.isArray(src.origin) ? src.origin.slice() : [0, 0, 0],
              scale: Array.isArray(src.scale) ? src.scale.slice() : [1, 1, 1],
              angles: Array.isArray(src.angles) ? src.angles.slice() : [0, 0, 0],
              size: Array.isArray(src.size) ? src.size.slice() : [0, 0],
              color: Array.isArray(src.color) ? src.color.slice() : [1, 1, 1],
              childIds: null,
              hasChildren: false,
              destroyed: false,
              animations: {},
              animationList: [],
              // 克隆条不要再跑模板层的 objectScripts（否则 64 根各自再造 64 根）
              objectScripts: null,
            };
            delete clone.textureAnimation;
            delete clone.videoTextureApi;
            delete clone.soundCtl;
            delete clone.videoCtl;
            // 浅拷贝 effects：每层自己的 visible，材质 pass 可共享
            if (Array.isArray(src.effects)) {
              clone.effects = src.effects.map((e: any) => ({
                ...e,
                passes: Array.isArray(e.passes) ? e.passes.map((p: any) => ({ ...p })) : e.passes,
              }));
            }
            scene.layers.push(clone);
            // 运行期创建的层（金币/收集特效等）：不在 mount 期的 transformDirty 里，
            // 但脚本能随时改 origin。给粒子系统留标记，推进时按帧重读发射器变换，
            // 否则特效钉在构造点的 (0,0)（1712475860 的收集特效跑到左下角）。
            clone.runtimeCreated = true;
            // 资产实例化的异步收尾：模型层解析 material → 载贴图 → autosize；
            // 粒子层起运行时粒子系统（登记到 clone.id，z 序由 renderByLayer 分发）。
            if (assetToMount && assetToMount.kind === "model") {
              const imagePath = assetToMount.path;
              try {
                const model = JSON.parse(readText(pkg.getEntry(parsedPkg, imagePath)!));
                const mat = scn.resolveMaterial(model);
                const matEntry = mat && pkg.getEntry(parsedPkg, mat.materialPath);
                const material = matEntry ? readMaterialDoc(matEntry) : null;
                const pass = material?.passes?.[0];
                if (material) attachBuiltinMatTint(clone, material);
                if (pass?.combos) {
                  for (const k of Object.keys(pass.combos)) {
                    if (k.toLowerCase() === "spritesheet" && Number(pass.combos[k]) === 1) {
                      clone.spriteSheet = true;
                      break;
                    }
                }
                }
                const tn = pass?.textures?.[0];
                if (typeof tn === "string" && tn && !tn.startsWith("util/") && !tn.startsWith("_rt_")) {
                  void loadTex(tn).then((entry) => {
                    if (!entry) return;
                    clone.textureName = tn;
                    // autosize：序列帧按帧尺寸（WE autosize 语义），否则按贴图尺寸
                    if (clone.size[0] === 0 || clone.size[1] === 0) {
                      // [we-scene patch 2026-09-20] 几何取**原始**尺寸（geomFrame/declared），
                      // 不能用被资源倍率缩过的 entry.frames / entry.width，否则动态建层变小
                      const gf = entry.geomFrame;
                      const fl = entry.frames && Array.isArray(entry.frames) ? entry.frames[0] : null;
                      clone.size = [
                        (gf && gf.width) || (fl && fl.width) || entry.declaredWidth || entry.width,
                        (gf && gf.height) || (fl && fl.height) || entry.declaredHeight || entry.height,
                      ];
                    }
                  });
                }
              } catch (e) {
                reportDiag(rt, cfg, `createLayer('${imagePath}') 资产实例化失败: ${String((e as Error).message || e).slice(0, 120)}`, "warn");
              }
            } else if (assetToMount && assetToMount.kind === "particle") {
              const ppath = assetToMount.path;
              void buildParticleSystem(ppath, clone, null, 0).then((ps) => {
                if (!ps) reportDiag(rt, cfg, `createLayer('${ppath}') 粒子系统装配失败`, "warn");
              });
            }
            return clone;
          },
          mediaControl,
          windowTitle: windowDriver.snapshot,
          openUserShortcut: shortcuts.openUserShortcut,
          isScreensaver: false,
        };
        // [we-scene patch] 注入效果常量脚本运行时（constantshadervalues 里的 {script}）。
        // 全库 194 个效果常量带 script、其中 63 个是颜色：WE 官方「颜色循环」模板
        // 靠 update() 每帧返回 WEColor.hsv2rgb(...) 改写颜色。不注入这套运行时，
        // 渲染器只能读初始快照 —— 音频可视化等效果的颜色会是**整块固定值**。
        // 复用对象脚本的同一份 userProperties 与 audioViews，语义保持一致。
        (renderer as any).setConstantScriptRuntime?.(wtext.evalObjectScript, {
          userProperties: objUserProps,
          audioViews,
          shared: textShared,
          storage: sceneStorage,
          inputView,
          // [we-scene patch] 效果常量的延时逻辑（全库 8 处）。renderer 侧
          // setConstantScriptRuntime 只提取白名单字段，timers 单独透传。
          timers: engineTimers,
          // 常量动画的帧事件共享队列（render 内推进产生，帧循环 render 后派发）。
          animEventQueue: constAnimEventQueue,
          ...sceneApi,
          onSandbox: (sb: any, info: any) => {
            if (sb && sb.hasMediaHook) registerMediaHook(sb);
            registerResizeHook(sb);
            // 常量脚本的 animationEvent 也进图层级广播表（3163060610 的事件
            // 几乎全在常量上）。
            if (sb && sb.hasAnimEventHook) registerAnimEventSink(info && info.layer, { sandbox: sb, kind: "const" });
          },
        });
        // [we-scene patch] 变换字段（origin/scale/angles）的脚本与关键帧动画一律在
        // **父级相对（local）** 空间收发 —— 那是 WE 场景图的真实语义，也是作者写
        // 目标值时用的空间（3786330502 气泡 `scriptProperties.A` = local y，
        // 气泡1 的 −433 当世界 Y 讲不通）。world 三件套由 recomposeWorld 逐帧合成。
        // 非变换字段（alpha / visible / brightness…）不存在父子空间问题，原样走 world。
        const LOCAL_SLOT: Record<string, string> = {
          origin: "localOrigin",
          scale: "localScale",
          angles: "localAngles",
        };
        const fieldSlot = (layer: any, field: string): string => {
          const slot = LOCAL_SLOT[field];
          // localOrigin 缺失只可能是 isPostProcess 之外的旧路径合成层（createLayer
          // 克隆等），退回 world 槽，行为与改动前一致。
          return slot && layer && Array.isArray(layer[slot]) ? slot : field;
        };
        // [we-scene patch] 关键帧动画控制器：解析阶段建好挂到图层上，
        // 供脚本 thisObject.getAnimation() 取用、渲染循环逐帧推进。
        // 全库 126 处 / 25 张壁纸；没有它 `anim.play()` 是个 no-op（见 render/animation.js）。
        for (const layer of scene.layers as any[]) {
          const defs = layer.objectAnimations as Record<string, { animation: any; value: unknown }> | null;
          if (!defs) continue;
          layer.animations = layer.animations || {};
          layer.animationList = layer.animationList || [];
          for (const [field, def] of Object.entries(defs)) {
            try {
              const ctrl = anim.createAnimation(def.animation);
              ctrl.field = field;
              ctrl.baseValue = def.value;
              // relative 的基准必须是装配时的快照。每帧若把已经写回的
              // layer.origin / layer.angles 再喂给 applyTo，等于把动画曲线积分：
              // 3233141951「头发0202」angles 峰值只有 0.14rad，积 80 帧就转一整圈，
              // origin 峰值 −23px 也会一步步漂出画面，看起来像跟着飞剑飞走。
              // [we-scene patch] 变换字段的基准取 **local** 快照：曲线在 local 上
              // 叠加，再由 recomposeWorld 合成 world。基准若取 world，父偏移会被
              // 算两遍（全库 4 个非根变换动画全是 relative:true，取错即双计）。
              const slot = fieldSlot(layer, field);
              // [we-scene patch] volume/maxwidth/zoom 的基准要从真实消费槽取：
              // layer.volume/maxwidth/zoom 是零读者死槽（相对曲线叠加错基准会积分漂移）。
              const live = field === "volume"
                ? (layer as any).soundprops?.volume
                : field === "maxwidth"
                  ? (layer as any).textMaxwidth
                  : field === "zoom"
                    ? (scene as any).cameraTransforms?.zoom
                    : (layer as any)[slot];
              ctrl.baseNumeric = Array.isArray(live) ? live.slice() : live;
              ctrl.slot = slot;
              layer.animationList.push(ctrl);
              if (ctrl.name) layer.animations[ctrl.name] = ctrl;
              animRuns.push({ layer, field, slot, ctrl });
            } catch (e) {
              reportDiag(rt, cfg, `animation '${layer.name}.${field}' 建控制器失败: ${String((e as Error).message).slice(0, 80)}`, "warn");
            }
          }
          // [we-scene patch] 时间轴联动组接线：同层字段间按 key 链接
          //（children 不自播、播放头从属于 leader、play/rate 委托——全库 53 处
          // 语料全在同层字段间）。悬空 parent（目标无动画/自指）与多级记诊断。
          // animationsByField 同时供 thisObject.getAnimation() 按属性取（官方语义：
          // 无参 = 当前属性自己的动画）。
          if (layer.animationList.length) {
            const siblings = new Map<string, any>();
            for (const ctrl of layer.animationList) siblings.set(ctrl.field, ctrl);
            anim.linkAnimations(siblings, (msg: string) => reportDiag(rt, cfg, `${layer.name}: ${msg}`, classifyDiag(msg)));
            layer.animationsByField = Object.fromEntries(siblings);
          }
        }
        // [we-scene patch] 粒子 instanceoverride 关键帧动画：3233141951 龙烟 alpha
        //（single/900f：帧 0-599 = 1 → 608-830 = 0.01 → 873 回 1）此前被
        // _applyOverride 当静态倍率读（opacityMul 恒 0.79），曲线整体丢失。
        // 全库 4 处（3223543799×2 / 3238423642）。baseNumeric 取快照 value，
        // 绝对曲线直取；relative 时按基准叠加（与对象字段动画同一约定）。
        for (const layer of scene.layers as any[]) {
          const defs = layer.particleOverrideAnimations as Record<string, { animation: any; value: unknown }> | null;
          if (!defs) continue;
          for (const [key, def] of Object.entries(defs)) {
            try {
              const ctrl = anim.createAnimation(def.animation);
              ctrl.baseNumeric = typeof def.value === "number" ? def.value : Number(def.value) || 0;
              overrideAnimRuns.push({ layer, key, ctrl });
            } catch (e) {
              reportDiag(rt, cfg, `override animation '${layer.name}.${key}' 建控制器失败: ${String((e as Error).message).slice(0, 80)}`, "warn");
            }
          }
        }
        // [we-scene patch] animationlayers[].visible 脚本循环体见下方；声明提到
      // 装配块顶部，使 renderLoop 闭包可见（与 overrideScriptRuns 同作用域）。
      for (const layer of scene.layers as any[]) {
        const als = Array.isArray(layer.animationLayers) ? layer.animationLayers : [];
        als.forEach((al: any, index: number) => {
          const vs = al.visibleScript as { script: string; scriptproperties: unknown; value: unknown } | null;
          if (!vs) return;
          try {
            const sandbox = wtext.evalObjectScript(vs.script, vs.scriptproperties, {
              canvasSize: { width: objProjW, height: objProjH },
              timeOfDay: timeOfDayValue,
              userProperties: objUserProps,
              audioViews,
              inputView,
              layer,
              ...timerOpts,
              ...sceneApi,
              shared: textShared,
              storage: sceneStorage,
              onError: (e: unknown) =>
                reportDiag(rt, cfg, `animationlayer visible script '${layer.name}[${index}]' 失败: ${String((e as Error).message || e).slice(0, 80)}`, "warn"),
            });
            if (!sandbox) return;
            propSandboxes.push(sandbox);
            // init(value) 收到该层当前 visible（bool），返回值折叠后写回；
            // init 内对 getAnimationLayer(name).stop() 的调用此刻已生效。
            const ir = sandbox.init(al.visible !== false);
            const f = foldVisibleRet(ir);
            if (f !== undefined) al.visible = f;
            sandbox.applyUserProperties(objUserProps);
            if (sandbox.hasMediaHook) registerMediaHook(sandbox);
            registerResizeHook(sandbox);
            animLayerScriptRuns.push({ layer, index, sandbox });
            // 帧事件转发给该脚本（它据此 play 错位层）
            if (sandbox.hasAnimEventHook) {
              registerAnimEventSink(layer, { sandbox, kind: "animLayer", animLayerIndex: index });
            }
          } catch (e) {
            reportDiag(rt, cfg, `animationlayer script '${layer.name}[${index}]' 求值失败: ${String((e as Error).message).slice(0, 80)}`, "warn");
          }
        });
      }
      // [we-scene patch 2026-09-28] animationlayers[].blend / .rate 的脚本与动画。
      // 与 visible 脚本同一套沙箱装配（init 收当前值、animationEvent 进 sinks），
      // 差别只是逐帧写回 blend/rate 而不是 visible。
      for (const layer of scene.layers as any[]) {
        const als = Array.isArray(layer.animationLayers) ? layer.animationLayers : [];
        als.forEach((al: any, index: number) => {
          for (const field of ["blend", "rate"] as const) {
            const def = field === "blend" ? al.blendScript : al.rateScript;
            if (!def) continue;
            try {
              const sandbox = wtext.evalObjectScript(def.script, def.scriptproperties, {
                canvasSize: { width: objProjW, height: objProjH },
                timeOfDay: timeOfDayValue,
                userProperties: objUserProps,
                audioViews,
                inputView,
                layer,
                ...timerOpts,
                ...sceneApi,
                shared: textShared,
                storage: sceneStorage,
                onError: (e: unknown) =>
                  reportDiag(rt, cfg, `animationlayer ${field} script '${layer.name}[${index}]' 失败: ${String((e as Error).message || e).slice(0, 80)}`, "warn"),
              });
              if (!sandbox) continue;
              propSandboxes.push(sandbox);
              const cur = Number(al[field]);
              const ir = sandbox.init(Number.isFinite(cur) ? cur : field === "blend" ? 1 : 1);
              const f0 = typeof ir === "number" ? ir : Number((ir as any)?.value);
              if (Number.isFinite(f0)) al[field] = f0;
              sandbox.applyUserProperties(objUserProps);
              if (sandbox.hasMediaHook) registerMediaHook(sandbox);
              registerResizeHook(sandbox);
              animLayerFieldRuns.push({ layer, index, field, sandbox });
              // 关键：clip 的帧事件要能进这个脚本的 animationEvent
              //（Trip 的 end → `shared.kirbystate = 0`）
              if (sandbox.hasAnimEventHook) {
                registerAnimEventSink(layer, { sandbox, kind: "animLayerField", animLayerIndex: index, field });
              }
            } catch (e) {
              reportDiag(rt, cfg, `animationlayer ${field} script '${layer.name}[${index}]' 求值失败: ${String((e as Error).message).slice(0, 80)}`, "warn");
            }
          }
          // blend 的关键帧动画形态（Attack/Bump/Trip：一段 single 曲线，权重 0→1→0）
          const ba = al.blendAnimation;
          if (ba && ba.animation) {
            try {
              const ctrl = anim.createAnimation(ba.animation);
              ctrl.baseNumeric = Number.isFinite(Number(ba.value)) ? Number(ba.value) : 0;
              animLayerBlendAnims.push({ layer, index, field: "blend", ctrl });
              // [we-scene patch 2026-09-28] **把 blend 曲线挂到该动画层上**：
              // 作者写 `getAnimationLayer("Bump").getAnimation("go").play()` 的意思是
              // 「从现在开始播这一段」，而这一段 = clip + blend 曲线。曲线是
              // `startpaused`（等 play），不联动的话它永远停在首帧 —— 后果不只是
              // 权重不动：**帧事件 `recover` 永不触发**，`shared.kirbystate` 卡在 1
              //（撞人）或 2（绊倒），角色带着击退速度一直滑出场地、分数停住。
              const origPlay = al.play ? al.play.bind(al) : null;
              al.play = function () {
                if (origPlay) origPlay();
                try {
                  if (typeof ctrl.setFrame === "function") ctrl.setFrame(0);
                  if (typeof ctrl.play === "function") ctrl.play();
                  else ctrl.playing = true;
                } catch { /* 控制器形态差异不致命 */ }
              };
              // init 里可能已经 play 过一次（装配顺序：可见性脚本先跑），补一次起播
              if (al.playing !== false && typeof ctrl.play === "function") {
                try { ctrl.play() } catch { /* 忽略 */ }
              }
            } catch (e) {
              reportDiag(rt, cfg, `animationlayer blend animation '${layer.name}[${index}]' 建控制器失败: ${String((e as Error).message).slice(0, 80)}`, "warn");
            }
          }
        });
      }
      // [we-scene patch] instanceoverride 脚本（音频响应粒子参数，104 段/29 张）。
        // 每帧求值后写该层全部粒子系统：rate/count/size/alpha 走轻量 setter，
        // colorn 由 setOverrideValue 识别归一化三色；init(value) 的 value 是字段
        // 当前快照值（WE 语义）。
        for (const layer of scene.layers as any[]) {
          const defs = layer.particleOverrideScripts as
            | Record<string, { script: string; scriptproperties: unknown; value: unknown }>
            | null;
          if (!defs) continue;
          for (const [key, def] of Object.entries(defs)) {
            try {
              const sandbox = wtext.evalObjectScript(def.script, def.scriptproperties, {
                canvasSize: { width: objProjW, height: objProjH },
                timeOfDay: timeOfDayValue,
                userProperties: objUserProps,
                audioViews,
                inputView,
                layer,
                ...timerOpts,
                ...sceneApi,
                shared: textShared,
                storage: sceneStorage,
                onError: (e: unknown) =>
                  reportDiag(rt, cfg, `override script '${layer.name}.${key}' 失败: ${String((e as Error).message || e).slice(0, 80)}`, "warn"),
              });
              if (!sandbox) continue;
              propSandboxes.push(sandbox);
              // init(value) 收到该 override 键的快照值（倍率/数量/颜色）。
              sandbox.init(def.value);
              sandbox.applyUserProperties(objUserProps);
              if (sandbox.hasMediaHook) registerMediaHook(sandbox);
              registerResizeHook(sandbox);
              if (sandbox.hasUpdate) overrideScriptRuns.push({ layer, key, sandbox });
            } catch (e) {
              reportDiag(rt, cfg, `override script '${layer.name}.${key}' 求值失败: ${String((e as Error).message).slice(0, 80)}`, "warn");
            }
          }
        }
        // 脚本 init 返回值改写 visible 的，挂载期一次性收集，层循环结束后统一重算。
        let mountVisibilityDirty = false;
        for (const layer of scene.layers as any[]) {
          // [we-scene patch] 效果开关上的脚本（`effects[i].visible.script`）。
          // 全库 46 处、媒体回调的第二大挂载点，此前在 parse 阶段就被 parseBool
          // 吃掉了原文，一处都加载不到。典型形态是
          // `mediaThumbnailChanged(e){ thisObject.visible = e.hasThumbnail }`
          // 或按播放状态开关某个效果。
          for (const [ei, effect] of ((layer.effects || []) as any[]).entries()) {
            const vs = effect.visibleScript as { script: string; scriptproperties: any } | null;
            if (!vs) continue;
            try {
              const sandbox = wtext.evalObjectScript(vs.script, vs.scriptproperties, {
                canvasSize: { width: objProjW, height: objProjH },
                timeOfDay: timeOfDayValue,
                userProperties: objUserProps,
                audioViews,
                inputView,
                // [we-scene patch] 效果开关是定时器的最大挂点（全库 37 处：
                // 延迟显隐、播放状态轮换），此前全部拿 no-op stub。
                ...timerOpts,
                layer,
                targetEffect: effect,
                ...sceneApi,
                shared: textShared,
                storage: sceneStorage,
                onError: (e: unknown) =>
                  reportDiag(rt, cfg, `effect visible script '${layer.name}#${ei}' 失败: ${String((e as Error).message || e).slice(0, 80)}`, "warn"),
              });
              if (!sandbox) continue;
              propSandboxes.push(sandbox);
              // WE 语义：init(value) 收到字段的**当前值**（visible 字段 = 布尔），
              // 返回值成为新初值 —— 淡出脚本静音加载时 `return 0` 应把效果藏掉，
              // 此前返回值被丢弃、效果恒显。number 按 WE 折叠（≠0 = 可见）。
              const ivRet = sandbox.init(effect.visible);
              const ivFold = foldVisibleRet(ivRet);
              if (ivFold !== undefined) effect.visible = ivFold;
              sandbox.applyUserProperties(objUserProps);
              if (sandbox.hasMediaHook) registerMediaHook(sandbox);
              registerResizeHook(sandbox);
              // last = 逐帧反馈的未折叠上一值（淡出脚本的 mix 链依赖它，
              // 只喂 bool 会丢掉小数进度，见帧循环 effectVisibleRuns）。
              let animRun: any = null;
              if (sandbox.hasUpdate) {
                animRun = { effect, sandbox, last: ivRet };
                effectVisibleRuns.push(animRun);
              }
              // [we-scene patch] animationEvent 进图层级广播表（官方事件消费口；
              // 转发脚本常无 update，必须独立于 hasUpdate 登记——3163060610 的
              // 调度框架就是这种形态）。
              if (sandbox.hasAnimEventHook) registerAnimEventSink(layer, { sandbox, kind: "effectVisible", effect, run: animRun });
            } catch (e) {
              console.warn(`效果开关脚本 ${layer.name}#${ei} 求值失败: ${(e as Error).message}`);
            }
          }
          const scripts = layer.objectScripts as Record<string, { script: string; scriptproperties: any }> | null;
          if (!scripts) continue;
          for (const [field, def] of Object.entries(scripts)) {
            try {
              const sandbox = wtext.evalObjectScript(def.script, def.scriptproperties, {
                canvasSize: { width: objProjW, height: objProjH },
                screenResolution: { x: c.clientWidth || window.innerWidth || 1, y: c.clientHeight || window.innerHeight || 1 },
                // 初值同 timeOfDayValue；帧循环每秒回填，昼夜脚本不再冻结。
                timeOfDay: timeOfDayValue,
                userProperties: objUserProps,
                audioViews,
                inputView,
                // thisLayer / thisScene.getLayer：拖拽类回调靠它们写回图层
                layer,
                // 官方语义：无参 getAnimation() = 当前属性自己的动画（联动组
                // 接线后，对 child 字段的调用自然拿到 child→委托 leader）。
                getAnimationForProperty: () =>
                  ((layer as any).animationsByField && (layer as any).animationsByField[field]) || null,
                ...sceneApi,
                // 骨骼 API 的覆写表（按图层）
                getBoneOverrides,
                shared: textShared,
                storage: sceneStorage,
                // [we-scene patch] WE 的 engine.setTimeout 返回**取消函数**句柄：
                // 语料写 `lastHideEvent = engine.setTimeout(...)` 之后
                // `lastHideEvent()` 直接调用它来取消（3790189808 的延时隐藏封面）。
                // 五个 eval 点统一走 engineTimers（SCENESCRIPT-PLAN P1-1），
                // 句柄语义与卸载 dispose 见 render/engine-timers.js。
                ...timerOpts,
                onError: (e: unknown) => {
                  // [we-scene patch 2026-09-28] 带上出错行：脚本被拼进 new Function
                  // 后行号与源文件一一对应（transform 只剥 import/export 与撞名声明），
                  // 没有它只能靠现象反推（本轮 Free Cam 就是靠这一条定位到具体调用的）。
                  const stack = (e as Error)?.stack ? String((e as Error).stack).split("\n") : [];
                  const where = stack.find((l) => /<anonymous>:\d+/.test(l)) || "";
                  const loc = (where.match(/<anonymous>:(\d+)/) || [])[1];
                  reportDiag(
                    rt,
                    cfg,
                    `object script '${layer.name}.${field}' 失败: ${String((e as Error).message || e).slice(0, 90)}${loc ? ` @line ${loc}` : ""}`,
                    "warn",
                  );
                },
                // [we-scene patch 2026-09-28] `layer.emitParticles(n)`：按图层 id 找它的
                // 粒子系统并一次性爆发 n 颗（见 particles.js emitBurst）。缺失时这条
                // API 会静默返回 0，而比赛主控脚本每次吃食物都要调它 —— 旧版直接
                // TypeError，三振熔断后两个角色永不动（3281559867 的动画全灭）。
                emitParticles: (target: { id?: number }, count: number) => {
                  const lid = target && target.id;
                  if (lid === undefined) return 0;
                  const list = particleSystemsByLayer.get(lid);
                  if (!list) return 0;
                  let made = 0;
                  for (const ps of list) made += ps.emitBurst(count) | 0;
                  return made;
                },
              });
              if (sandbox) {
                propSandboxes.push(sandbox);
                // WE 语义：init(value) 收到字段的**当前值**。向量字段（scale/origin/
                // angles）在 WE 里是带 .x/.y/.z 的对象，本仓图层用数组存储——
                // 这里包成同形对象；标量/布尔字段原样传。
                // 此前 init() 无参调用，所有 `init(value){ initialValue = value.x }`
                // 形态的脚本（3264246690 的月亮/时间/三条胶带音频缩放，全库音频
                // 可视化模板的标准写法）都会在 init 里 TypeError 熔断。
                // [we-scene patch] 变换字段读 **local** 槽：作者的 init/update 都在
                // 父级相对空间里算（见 fieldSlot 上方注释）。喂 world 会让脚本第一帧
                // 就把图层拽到「local 目标当 world 用」的错位置上。
                const initSlot = fieldSlot(layer, field);
                const fieldVal = (layer as any)[initSlot];
                // SceneScript 的 angles 是角度，图层数组是弧度。init(value) 必须同形，
                // 否则 `initialValue = value.z` 拿到的是弧度，滑条（°）脚本会整圈乱转。
                const initArg = field === "angles" && Array.isArray(fieldVal)
                  ? wtext.radToScriptAngles(fieldVal)
                  : Array.isArray(fieldVal)
                    ? { x: fieldVal[0] ?? 0, y: fieldVal[1] ?? 0, z: fieldVal[2] ?? 0 }
                    : fieldVal;
                // [we-scene patch] init 返回值 = 属性新初值（WE 官方语义），
                // 此前全链路丢弃。按字段类型写回：visible 折叠成 bool 走 visibleSelf
                //（要重算子孙可见性），标量写字段，向量写 local 槽（与 update 收发
                // 同空间；angles 转回弧度）。只收合法形状，脏值不动槽位。
                const ir = sandbox.init(initArg);
                if (ir !== undefined && ir !== null) {
                  if (field === "visible") {
                    const fb = foldVisibleRet(ir);
                    if (fb !== undefined && (layer as any).visibleSelf !== fb) {
                      (layer as any).visibleSelf = fb;
                      mountVisibilityDirty = true;
                    }
                  } else if (typeof ir === "number" && Number.isFinite(ir)) {
                    if (["alpha", "brightness", "maxwidth", "pointsize", "volume", "intensity", "exponent"].includes(field)) {
                      // 散字段经真实槽位写回（maxwidth/pointsize/volume 名字与消费槽不同）
                      scalarFieldSlot(layer, field).set(ir);
                    }
                  } else if (typeof ir === "object" && (ir as any).x !== undefined) {
                    const o = ir as any;
                    if (Number.isFinite(Number(o.x)) && Number.isFinite(Number(o.y))) {
                      (layer as any)[initSlot] = field === "angles"
                        ? wtext.scriptAnglesToRad(o)
                        : [Number(o.x) || 0, Number(o.y) || 0, Number(o.z) || 0];
                    }
                  }
                }
                // [we-scene patch] 对象脚本也要收一次全量用户属性。
                // WE 挂载时 init() 之后必调 applyUserProperties(全量)，脚本靠它
                // 拿状态初值；文字脚本这边一直调了，对象脚本这边漏了。
                // 全库 82 处 / 24 个壁纸导出该回调，等于这些脚本的初始状态永远是
                // JS 的 undefined —— 3148125112 的丝袜开关就卡在这：cursorClick 写的是
                // `if(click==1) click=2; else if(click==2) click=3; else if(click==3) click=1`，
                // click 是 undefined 时三个分支全不匹配，点多少次都不动。
                sandbox.applyUserProperties(objUserProps);
                addCursorHook(layer, sandbox);
                // [we-scene patch] 媒体回调登记。**必须在 hasUpdate 判断之外**——
                // 纯媒体回调脚本没有 update（`mediaThumbnailChanged(e){thisObject.visible=e.hasThumbnail}`
                // 是最常见形态），放进 if 里会一个都收不到。同 addCursorHook 的位置。
                if (sandbox.hasMediaHook) registerMediaHook(sandbox);
                registerResizeHook(sandbox);
                // 只有真的导出了 update 的脚本才进逐帧字段求值队列。
                // 纯 cursor 交互脚本（拖拽类）没有 update，进队列只会每帧白跑一次。
                if (sandbox.hasUpdate) {
                  objectScriptRuns.push({
                    layer,
                    field,
                    // 变换字段逐帧也在 local 槽上收发（与 init 同一空间）。
                    slot: initSlot,
                    kind: field === "visible"
                      ? "bool"
                      : ["alpha", "brightness", "maxwidth", "pointsize", "volume", "intensity", "exponent"].includes(field)
                        ? "scalar"
                        : "vec3",
                    sandbox,
                    // visible 字段的逐帧反馈种子（init 未折叠返回值，同
                    // effectVisibleRuns；淡出计时器脚本挂在图层 visible 上时靠它）。
                    last: field === "visible" ? ir : undefined,
                  });
                }
                // [we-scene patch] animationEvent 进图层级广播表（独立于 hasUpdate：
                // 无 update 的转发脚本同样是官方事件消费方）。
                if (sandbox.hasAnimEventHook) {
                  registerAnimEventSink(layer, {
                    sandbox,
                    kind: field === "visible" ? "bool" : field === "alpha" || field === "brightness" ? "scalar" : "vec3",
                    field,
                    slot: initSlot,
                  });
                }
              }
            } catch (e) {
              console.warn(`对象脚本 ${layer.name}.${field} 求值失败: ${(e as Error).message}`);
            }
          }
        }
        // [we-scene patch] 文字脚本的 init/applyUserProperties 在这里统一补跑：
        // 此时对象/效果/general 脚本的**顶层代码都已执行**，框架装在 shared 上的
        // helper（eventDispatcher/CAniClass/CAniTaskListClass，3163060610 基础脚本）
        // 已经就位，文字脚本 init 里的 registerListener 才拿得到（时钟1 此前连环
        // TypeError「reading registerListener」）。
        for (const d of deferredTextInits) {
          // WE 语义：init(value) 收到字段当前值（文字字段 = 当前文本），
          // 返回字符串成为初始文本。
          const tir = d.sandbox.init(d.layer.text ?? "");
          if (typeof tir === "string") d.layer.text = tir;
          d.sandbox.applyUserProperties(liveUserProps);
        }
        // 挂载期 init 返回值改写过的 visibleSelf 统一重算一次（效果链/粒子分发
        // 都在重算之后装配，避免先拿旧可见性建资源）。
        if (mountVisibilityDirty) recomputeVisibility();
        // general.*.script（全库 3 处）：3151551777 zoom、2134765860 bloomstrength、
        // 3790527023 cameraparallax 场景切换。不是图层字段，漏加载等于这三张
        // 壁纸的火车震动 / 音频 bloom / 多场景轮换全部不跑。
        const generalScripts = (scene as any).generalScripts as Record<
          string,
          { script: string; scriptproperties: any; value: unknown }
        > | null;
        if (generalScripts) {
          for (const [field, def] of Object.entries(generalScripts)) {
            try {
              const sandbox = wtext.evalObjectScript(def.script, def.scriptproperties, {
                canvasSize: { width: objProjW, height: objProjH },
                timeOfDay: timeOfDayValue,
                userProperties: objUserProps,
                audioViews,
                inputView,
                ...timerOpts,
                ...sceneApi,
                shared: textShared,
                storage: sceneStorage,
                onError: (e: unknown) =>
                  reportDiag(rt, cfg, `general script '${field}' 失败: ${String((e as Error).message || e).slice(0, 80)}`, "warn"),
              });
              if (!sandbox) continue;
              propSandboxes.push(sandbox);
              sandbox.init(def.value);
              sandbox.applyUserProperties(objUserProps);
              if (sandbox.hasMediaHook) registerMediaHook(sandbox);
              registerResizeHook(sandbox);
              const write = (v: unknown) => writeGeneralField(field, v);
              if (sandbox.hasUpdate) generalScriptRuns.push({ field, sandbox, write });
            } catch (e) {
              console.warn(`general 脚本 ${field} 求值失败: ${(e as Error).message}`);
            }
          }
          if (generalScriptRuns.length) {
            reportDiag(rt, cfg, `general scripts: ${generalScriptRuns.map((r) => r.field).join(",")}`, "info");
          }
        }
        // general.*.animation（全库 2 处）：2887099508 zoom 开场从 3 拉到 1，
        // 3793152178 bloomstrength 循环。图层 objectAnimations 进不了 general，
        // 不在这里建控制器的话 zoom 永远停在快照 3。
        const generalAnims = (scene as any).generalAnimations as Record<
          string,
          { animation: any; value: unknown }
        > | null;
        if (generalAnims) {
          for (const [field, def] of Object.entries(generalAnims)) {
            try {
              const ctrl = anim.createAnimation(def.animation);
              ctrl.field = field;
              ctrl.baseValue = def.value;
              ctrl.baseNumeric = def.value;
              if (ctrl.name) sceneNamedAnims[ctrl.name] = ctrl;
              generalAnimRuns.push({ field, ctrl, write: (v) => writeGeneralField(field, v) });
            } catch (e) {
              reportDiag(rt, cfg, `general animation '${field}' 建控制器失败: ${String((e as Error).message).slice(0, 80)}`, "warn");
            }
          }
          if (generalAnimRuns.length) {
            reportDiag(rt, cfg, `general animations: ${generalAnimRuns.map((r) => r.field).join(",")}`, "info");
          }
        }
      }
      if (objectScriptRuns.length) {
        reportDiag(rt, cfg, `object scripts: ${objectScriptRuns.length}`, "info");
        // 调试出口：读/改对象脚本的实时字段值（音条 scale 等）
        (window as unknown as Record<string, unknown>).__objScripts = objectScriptRuns;
        // [we-scene patch 2026-09-28] 调试出口：场景脚本共享状态（WE 的 `shared` 全局）。
        // 排查「脚本在跑但状态机不动」类问题必需 —— 全库 100+ 张壁纸用 shared 传状态
        //（3281559867 的 kirbystate/dededestate/foodx… 就是整场比赛的寄存器），
        // 没有它只能靠画面反推。只读出口，与 __scene/__objScripts 同约定。
        (window as unknown as Record<string, unknown>).__shared = textShared;
        // 调试出口：效果开关脚本队列（run.last = 未折叠的淡出进度，A/B 验证用）
        (window as unknown as Record<string, unknown>).__effectScripts = effectVisibleRuns;
      }
      // 调试出口：媒体广播表（排查「回调登记了没 / 派发到了没」）
      (window as unknown as Record<string, unknown>).__mediaHooks = mediaHooks;
      // 调试出口：活层引用（白块/消失层归属定位——evaluate 直接改 visibleSelf 验证）
      (window as unknown as Record<string, unknown>).__sceneLayers = scene.layers;
      // [we-scene patch] 调试出口：本帧解析出的跨层合成目标（`_rt_imageLayerComposite_*`）
      (window as unknown as Record<string, unknown>).__compositeStats = () =>
        (renderer as any).compositeStats?.() ?? null;
      // A/B：关掉跨层合成回到改动前行为，用来判定回归归属
      (window as unknown as Record<string, unknown>).__compositeEnable = (on: boolean) =>
        (renderer as any).setCompositeEnabled?.(on);
      // [we-scene patch] 调试出口：完整场景对象。改 `__scene.layers[i].visible`
      // 或 `.size` 可即时验证「这块画面归哪一层」——定位纯白矩形时靠改 size
      // 看白块同步缩小，才确认归属是那个空容器（音频条），而非我先后怀疑的
      // Album Cover / blur_combine / blend。
      (window as unknown as Record<string, unknown>).__scene = scene;
      // [we-scene patch] 调试出口：已加载的纹理表（排查「效果引用的贴图没进来 →
      // 落到 whiteTex → 遮罩恒为 1」这类问题）
      (window as unknown as Record<string, unknown>).__textures = textures;
      // 探针归属登记：上面这一串（含 media/web 侧写的）刚由本实例写入，
      // 卸载时**只有仍是自己名下**才删 —— 否则会把还活着的另一实例的调试面删掉（§3.4）。
      ownSceneDebugGlobals(rt);

      // ---- WE 指针回调派发（cursorEnter/Leave/Move/Down/Up/Click）----
      // 全库 267 处挂钩 / 19 壁纸，是 WE 场景互动的主入口。
      // 命中判定用 OBB（render/hittest.js），几何与 layerModelMatrix 逐字一致。
      const cursorLayers = Array.from(cursorHooks.keys());
      if (cursorLayers.length) {
        reportDiag(rt, cfg, `cursor hooks: ${cursorLayers.length} layers`, "info");
      }
      // 命中集（z 序自上而下）。**同一帧可以有多个图层同时命中**：WE 的 cursor
      // 回调按图层各自判定、不做上层遮挡（open-wallpaper-engine TickAll 逐 script
      // HitTestNode、Mirage ResolveCursorNode + ancestors_visible 都是这个语义）。
      // 3801397319 的右上角是两个同位同尺寸的交互区（切换人物形态 + 作者水印），
      // 只派发给最上层那一个会让「切换人物」永远收不到点击。
      // 派发规则本身是纯函数 cursor-dispatch.js 的 planCursorDispatch——
      // verify-pointer 直接跑那份真实现，不在测试里再抄一遍派发顺序。
      let cursorState: any = { hovered: [], pressed: [], lastLeftDown: false };
      // event 只需 worldPosition：全库 51 处引用它，无一处读 button/screenPosition/delta。
      // 但它**必须是 Vec3 而非对象字面量** —— 脚本会存下来再做向量运算
      // （2998757800 的 cursorDown 存 dragStart，update 里 dragStart.add(...)），
      // 传字面量会 TypeError 熔断，整个拖拽静默失效。
      const makeCursorEvent = () => ({
        worldPosition: wtext.makeCursorEventVec(
          pointerSrc.state.wx,
          pointerSrc.state.originY != null ? pointerSrc.state.originY : pointerSrc.state.wy,
          0,
        ),
      });
      const fire = (layer: any, name: string, ev: any) => {
        const list = cursorHooks.get(layer);
        if (!list) return;
        for (const sb of list) sb.callCursor(name, ev);
      };
      const dispatchCursor = () => {
        if (cursorLayers.length === 0) return;
        const p = pointerSrc.state;
        if (!p.has) return;
        const par = renderer.getParallaxOffset ? renderer.getParallaxOffset() : null;
        const projH = (scene as any).general?.orthogonalprojection?.height || c.height;
        const hits = hitTest.hitTestLayersAll(scene.layers, p.wx, p.wy, projH, {
          parallaxCtx: par,
          alignTable: rnd.ALIGN,
          // perspective 图层走射线-平面求交（无透视层时为 null，命中逻辑不变）
          perspEye: renderer.getPerspectiveEye ? renderer.getPerspectiveEye() : null,
          // 只在挂了回调的图层里找命中 —— 多命中语义下没有「挡住」，但无关图层
          // 不该白跑几何。
          filter: (l: any) => cursorHooks.has(l),
        });
        const plan = cursorDispatch.planCursorDispatch(cursorState, hits, p.leftDown);
        cursorState = plan.next;
        const ev = makeCursorEvent();
        // 派发顺序与 planCursorDispatch 的返回顺序一致：leave → enter → move → down → up → click
        for (const l of plan.leave) fire(l, "cursorLeave", ev);
        for (const l of plan.enter) fire(l, "cursorEnter", ev);
        for (const l of plan.move) fire(l, "cursorMove", ev);
        for (const l of plan.down) fire(l, "cursorDown", ev);
        for (const l of plan.up) fire(l, "cursorUp", ev);
        for (const l of plan.click) {
          fire(l, "cursorClick", ev);
          // [we-scene patch 3794460976] 音乐控制接入：媒体组件按钮（Media Info.
          // Collection 的 PlayerPlayBold2/PlayerPauseBold2/Previous song/Next song）
          // 点击推断成播放控制 —— 组件脚本走 openUserShortcut，但本壁纸属性被建成
          // bool（无快捷方式绑定可执行）、暂停图标的调用还被作者注释，WE 语义下
          // 这些按钮本来就是死的。**控制反转**：这里只产出动作名，执行走注入的
          // mediaControl —— 后端由宿主选（测试台 liveSystem → media-bridge、
          // 宿主 setMedia 源、离线回落模拟源）。推断与闸门在 vendor/media-buttons.js。
          const mediaAct = mediaButtons.mediaButtonActionForLayer(l);
          if (mediaAct) {
            reportDiag(rt, cfg, `media button: ${l.name} → ${mediaAct}`, "info");
            try {
              (mediaControl as unknown as Record<string, () => void>)[mediaAct]();
            } catch (e) {
              reportDiag(rt, cfg, `media button ${mediaAct} 失败: ${(e as Error)?.message}`, "warn");
            }
          }
        }
      };

      const start = performance.now();
      let pauseAccum = 0;
      let pauseStarted = 0;
      const playingVideos: Array<{ play: () => void }> = [];
      const playingAudios: HTMLAudioElement[] = [];
      // 帧率上限门：相位累加调度（见 shell.ts FrameGate）。旧的
      // `now - lastRender >= interval` 死重闸门会因浮点量化/vsync 抖动误丢整帧，
      // 60Hz 屏设 60 也周期性掉到 30/58fps；高刷屏 cap60 长期均值甚至只有 ~48fps。
      const frameGate = new FrameGate(rt.cfg.sceneFps || 60);
      let gateFps = rt.cfg.sceneFps || 60;
      /**
       * 帧率守门（运行期自动降档，状态机在 quality.ts）。
       * 只在「挂载期自动降档之后后处理还有坡可下」时接管：宿主显式定了 pp、
       * 或 `autoQuality:false` 时都不介入。降档走 applyQuality（热更，不重挂载）。
       */
      const adaptive = autoRes.allowAdaptive
        ? createAdaptiveQuality({
            onDowngrade: (next, reason) => {
              // 基准取**当前生效**档位：自动降档只写 qualityEffective，不写 cfg.quality
              // （那是宿主请求值），所以这里必须读 effective —— 读 cfg 会让阶梯卡在
              // 「high→medium」反复横跳（实测踩过：连报两次 → medium）。
              applyQuality({ ...(rt.qualityEffective ?? requestedQuality()), postProcessing: next });
              reportDiag(rt, cfg, `autoQuality: postProcessing → ${next}（${reason}）`, "warn");
            },
          })
        : null;
      // 帧率守门第二段：视频纹理上传倍率。后处理降到底仍然不够时，缺口多半在
      // 「逐帧 texImage2D(DOM 源)」这条路径上（WKWebView 要同步跨进程取像素，
      // 代价随像素数线性），而它**不受后处理/粒子档影响**——实测 post 一路降到 off
      // 帧率纹丝不动。所以这里单独下坡，且只在渲染器确实在逐帧传视频纹理时介入
      // （没视频的场景降它只会变糊不变快）。
      // 显式倍率（画质页「视频纹理清晰度」）优先：给了就不再参与自动下坡。
      const requestedVideoScale = () => normalizeVideoTexScale(rt.cfg.videoTexScale);
      let videoTexScale = 1;
      const applyVideoScale = (v: number) => {
        const next = v > 0 ? v : 1; // 0/非法 = 不额外压，之后交给阶梯
        if (next === videoTexScale) return;
        videoTexScale = next;
        renderer.setVideoTexScale?.(next);
      };
      applyVideoScale(requestedVideoScale());
      applyVideoScaleImpl = applyVideoScale;
      const adaptiveVideo = autoRes.allowAdaptive
        ? createAdaptiveVideoScale({
            onStepDown: (next, reason) => {
              applyVideoScale(next);
              reportDiag(rt, cfg, `autoQuality: 视频纹理上传倍率 → ${next}（${reason}）`, "warn");
            },
          })
        : null;
      let adaptiveAccum = 0;
      let lastAdaptiveT = 0;
      // 关键帧动画的上一帧时刻（真实时钟，秒）。**不能用固定的目标帧间隔累加**：
      // 实际出帧周期总略大于 interval，每帧只加 interval 就是系统性欠计 ——
      // 骨骼动画走真实时钟 t，两条时间轴会持续发散（3233141951：理想满帧下
      // 30s 就差 164 帧≈5.5s，头发相对头顶最大错位 40px、发饰 79px，看起来就是
      // 「头发和头不同步、漏模」）。
      let lastAnimT = 0;
      // [we-scene patch 3448845950] 单帧 dt 上限（秒）。见 animDt 处注释：
      // 作者的 `mix(cur, target, speed * frametime)` 在 dt 过大时会越过目标来回荡。
      // 0.05 = 20fps，与粒子时钟的 50ms 封顶同口径。
      const MAX_SCRIPT_FRAME_DT = 0.05;
      // 循环体。**不要直接把它交给 requestAnimationFrame** —— 外面必须套
      // renderLoop 守卫壳（见其定义处注释：回调里抛错会让 rAF 链断死）。
      const renderLoopImpl = (now: number) => {
        if (disposed || rt.paused) return;
        // 遮挡维护（V5）：fail-open（推送失联恢复全量）+ 画布 resize 重算。
        // 放在一切渲染工作之前 —— 失联恢复必须当帧生效。
        tickOcclusion(rt, now);
        if (disposed || rt.paused || rt.occlusion?.band === "pause") return;
        // 帧率上限：相位累加调度，比目标更快的 rAF 不渲染只继续排队，降低 GPU 占用。
        // 热改 fps（工具条滑条）只改 rt.cfg.sceneFps，这里同步进调度器、保留节拍相位。
        // 遮挡降帧（V5）：档位 fps 与宿主上限取 min —— 宿主显式 setFps 永远是上限，
        // 遮挡只往下压不往上抬（评估报告 §4-B）。
        const occlBand = rt.occlusion?.band;
        const baseFps = rt.cfg.sceneFps || 60;
        const fps = occlusionFpsCap(occlBand, occlusionCfgOf(rt), baseFps);
        if (fps !== gateFps) {
          gateFps = fps;
          frameGate.setFps(fps);
        }
        if (frameGate.shouldRender(now)) {
          markFrame(rt, now);
          // 帧率守门挂起（V5，评估报告 R1）：遮挡降帧/暂停期间实测 fps 天然低于
          // 宿主上限，照常喂守门会误降后处理档位；且暂停时长会把 adaptiveAccum
          // 毒成一次巨大 dtS 直接清空冷却。挂起期间清零累计，解除后从当前帧
          // 重新起算（lastAdaptiveT=0 → 下一 tick 只记账不累计）。
          const occlActive = occlBand !== undefined && occlBand !== "run";
          if (occlActive) {
            adaptiveAccum = 0;
            lastAdaptiveT = 0;
          }
          // 帧率守门：按**真实经过时间**每秒喂一次读数（不是每帧喂 —— 否则高刷屏上
          // 判断频率随时间被放大）。读数取 frameMeter 的实测 fps（被上限跳过的帧不计入，
          // 反映的是真实出帧能力）；上限取配置值，宿主 setFps 改上限时这里自动跟上。
          if (adaptive && !occlActive) {
            if (lastAdaptiveT > 0) adaptiveAccum += rt.frameMeter.last - lastAdaptiveT;
            lastAdaptiveT = rt.frameMeter.last;
            if (adaptiveAccum >= 1000) {
              const dtS = adaptiveAccum / 1000;
              adaptiveAccum = 0;
              const postNow = (rt.qualityEffective ?? requestedQuality()).postProcessing;
              const capNow = rt.cfg.sceneFps || 60;
              const upNow = renderer.videoUploadStats?.();
              const videoDone = nextVideoScale(videoTexScale) === null;
              // 视频上传本身就是主要成本时**先压它**：实测这种场景（2570×1446 逐帧上传
              // 占帧时间 ~70%）把后处理从 medium 一路降到 off，帧率纹丝不动 —— 先走后处理
              // 阶梯既慢（~18s）又纯丢画质。「主要成本」的判据用实测值：单次上传耗时
              // 超过帧预算的 25%（30fps 下 8.3ms）。
              const budgetMs = capNow > 0 ? (1000 / capNow) * 0.25 : 8;
              const videoHeavy = !!(upNow && upNow.uploadsPerSec > 0 && upNow.costMs >= budgetMs);
              const videoPinned = requestedVideoScale() > 0; // 显式指定 → 阶梯不碰
              if (adaptiveVideo && !videoPinned && videoHeavy && !videoDone) {
                adaptiveVideo.tick(rt.frameMeter.fps, capNow, dtS, videoTexScale);
              } else {
                adaptive.tick(
                  rt.frameMeter.fps,
                  capNow,
                  dtS,
                  // 阶梯位置同样取生效值（见 onDowngrade 的注释）
                  postNow,
                );
                // 第二段：后处理已经没坡可下，且这个场景确实在逐帧传视频纹理 ——
                // 此时唯一的减压手段是压上传倍率（见 createAdaptiveVideoScale）。
                if (adaptiveVideo && !videoPinned && postNow === "off" && !videoDone && upNow && upNow.uploadsPerSec > 0) {
                  adaptiveVideo.tick(rt.frameMeter.fps, capNow, dtS, videoTexScale);
                }
              }
            }
          }
          syncCanvasSize(rt, c, rt.cfg);
          // [we-scene patch] resizeScreen 派发（官方生命周期事件）：画布 CSS 尺寸
          // 变化（含首帧：resize 模板在 init 里手动调
          // resizeScreen(engine.screenResolution)，首帧不补发它拿到的是沙箱
          // 默认值 1920×1080）时，对全部挂了 resizeScreen 的沙箱广播一次。
          // 用 CSS 像素（与每帧回填的 engine.screenResolution 同口径），不用
          // backing store：脚本拿它和 1920/1080 比，DPR 不应进入比较。
          const cssW = c.clientWidth || window.innerWidth || 1;
          const cssH = c.clientHeight || window.innerHeight || 1;
          if (cssW !== lastResizeW || cssH !== lastResizeH) {
            lastResizeW = cssW;
            lastResizeH = cssH;
            lastResizeDispatch = { w: cssW, h: cssH };
            dispatchResize(cssW, cssH);
          }
          // [we-scene patch] t 不允许为负：首帧 rAF 时间戳可能早于挂载时刻的
          // performance.now()（vsync 对齐），负的场景时间会让下游按相位取模的
          // 消费者越界（模拟音频 patterns[i16<0] = undefined → NaN 毒化共享视图，
          // 3233141951 反光层永久隐形）。负场景时间对一切下游都无意义。
          const t = Math.max(0, (now - start - pauseAccum) / 1000);
          // 指针 last 在本帧 render 完成后再推进（见下方 then）。事件驱动下
          // rAF 之间的 mousemove 已经更新了 current；若在消费前 last=current，
          // cursorripple 的 v_PointDelta.x 恒为 0，涟漪完全不触发。
          // 脚本 input 视图就地重填（世界坐标是上一帧 render 里 syncWorld 算的，
          // 首帧为初值；与 audioViews 慢一帧的既有行为一致）
          inputView.update(pointerSrc.state);
          // [we-scene patch] 媒体源推进 + **变化时才派发**回调。
          // 放在对象脚本求值之前：媒体回调常改写 visible/文本/动画播放头，
          // 这些改动应当在本帧的字段求值与渲染里立即生效。
          if (mediaSim.enabled) {
            if (live?.media) live.media.pump();
            // [1.3.0] 推进的必须是**当前生效的那个 driver**，不能写死 simMedia：
            // 宿主注入源后 mediaDriver 已改指向，还推 simMedia 等于让注入源
            // 永远收不到 update(t)（有内部时钟的实现就此冻住）。
            else {
              const drv = currentMediaDriver();
              if (typeof drv?.update === "function") drv.update(t);
            }
            const snap = mediaSnapshot();
            const evts = media.diffMediaEvents(lastMediaSnap, snap);
            if (evts.length) {
              for (const { name, event } of evts) {
                for (const sb of mediaHooks) {
                  if (sb.disabled) continue;
                  sb.callMedia(name, event);
                }
              }
              lastMediaSnap = media.cloneMediaSnapshot(snap);
            }
            // 场景壁纸的封面不走脚本回调，而是 $mediaThumbnail / $mediaPreviousThumbnail
            // 两个 GL 纹理（作者把保留纹理名直接填进 image/textures 槽）。
            // 每当 MediaSnapshot.thumbnail 变化，异步解码 + 上传纹理。
            // 与 liveSystem 的 artwork 上传复用同一段像素上传逻辑。
            if (
              mediaThumbnailLastSrc !== snap.thumbnail &&
              typeof snap.thumbnail === "string" &&
              snap.thumbnail
            ) {
              const nextSrc = snap.thumbnail;
              mediaThumbnailLastSrc = nextSrc;
              void (async () => {
                try {
                  const blob = await fetch(nextSrc, { cache: "no-store" }).then((r) =>
                    r.ok ? r.blob() : null,
                  );
                  if (!blob) return;
                  const bmp = await createImageBitmap(blob, { premultiplyAlpha: "none" });
                  // 加载期间可能又切歌了：来源变了就丢弃这次结果
                  if (mediaThumbnailLastSrc !== nextSrc) {
                    bmp.close?.();
                    return;
                  }
                  // 尺寸要在 close() 之前取：规范规定 close 后 width/height 归 0，
                  // 放在后面读诊断日志会恒为「0×0」。
                  const bw = bmp.width, bh = bmp.height;
                  const palette = uploadThumbnailBitmap(bmp, bw, bh);
                  bmp.close?.();
                  if (palette) {
                    const s = mediaSnapshot();
                    s.primaryColor = media.mediaVec3(...palette.primary);
                    s.secondaryColor = media.mediaVec3(...palette.secondary);
                    s.tertiaryColor = media.mediaVec3(...palette.tertiary);
                    s.textColor = media.mediaVec3(0.98, 0.98, 1);
                    s.highContrastColor = media.mediaVec3(1, 1, 1);
                  }
                  reportDiag(rt, cfg, `media: $mediaThumbnail 已更新（${bw}×${bh}）`, "info");
                } catch (e) {
                  reportDiag(
                    rt,
                    cfg,
                    `media: 封面上传失败（${e instanceof Error ? e.message : e}）`,
                    "warn",
                  );
                }
              })();
            }
          }
          if (live?.windowTitle) live.windowTitle.pump();
          else simWindow.update(t);
          // [we-scene patch] 关键帧动画推进并写回字段。必须在对象脚本**之前**：
          // 同一字段上两者可以并存（全库 44 处），语义是脚本控制播放头、
          // 动画产出值，脚本的 update 返回值优先级更高。
          // dt 取**真实经过时间**（与骨骼动画的 t 同一时钟），不是目标帧间隔：
          // 见 lastAnimT 的声明处。首帧 dt=0（lastAnimT 初值 0，t 也≈0）；
          // 暂停期间 t 已扣掉 pauseAccum，恢复后不会补跑一大段。
          // 两条时间线必须拆开（2026-09-20，3233141951 头发/头漏模回归）：
          //   · clockDt = 未封顶真实 dt → 关键帧 advance（头发0202 / 发饰 / 火1…）
          //     骨骼蒙皮吃的是绝对时间 t，关键帧若也封顶就会在每次卡顿后
          //     **永久落后**（lastAnimT 已跳到 t，丢掉的那截再也补不回来）。
          //   · animDt = 封顶后的 dt → 只喂 engine.frametime（脚本）。
          //     作者的「指数趋近」`mix(cur, target, speed * frametime)`
          //     （3448845950 面板 A/B，speed=5）要求 speed*frametime < 1：
          //     卡顿把 frametime 顶到 0.37s 时系数 1.85 → 越过目标来回荡。
          // 口径 20fps（0.05s）：全库 speed 滑条上限 10 时系数 0.5，仍在收敛区；
          // 正常帧（≥20fps）两条 dt 相等，观感零差异。
          const rawDt = Math.max(0, t - lastAnimT);
          lastAnimT = t;
          const clockDt = rawDt;
          const animDt = Math.min(rawDt, MAX_SCRIPT_FRAME_DT);
          // 粒子推进与关键帧/骨骼同一条时间线（见 setParticleRenderer 上方注释）。
          // 粒子内部还有一层 50ms 封顶（物理稳定）；这里喂未封顶，避免与
          // 场景 t 再叠一层系统性欠计。
          particleClock.dt = clockDt;
          particleClock.t = t;
          let visibilityDirty = false;
          // 本帧的脚本/动画阶段内，脚本写 visible 只打脏标记（见 markVisibilityDirty）。
          // 刷写点与 visibilityDirty 同在下面 `if (visibilityDirty) recomputeVisibility()`。
          visibilityDeferred = true;
          // [we-scene patch] 帧事件派发（图层级广播，官方 AnimationEvent 语义）：
          // 该层任一动画出事件，这层所有带 animationEvent 的沙箱都被叫到；
          // 每个拿到的 value 是各自属性的当前值，返回值按 update 同构规则立即写回
          //（undefined/非法形状 = 保持不变）。
          const dispatchAnimEvents = (layer: any, evs: Array<{ frame: number; name: string }>) => {
            const sinks = animEventSinks.get(layer);
            if (!sinks || !sinks.length) return;
            // 诊断计数：事件管线是否在跑（3163060610 调度器活性探针）
            (window as unknown as Record<string, unknown>).__animEventsFired =
              (((window as unknown as Record<string, unknown>).__animEventsFired as number) || 0) + evs.length;
            // 诊断环形日志：最近 400 条派发事件（排查事件风暴/重复派发）
            {
              const w = window as unknown as Record<string, unknown>;
              const log = (w.__animEventLog as Array<{ l: string; f: number; n: string }>) || (w.__animEventLog = []);
              for (const ev of evs) {
                log.push({ l: String(layer && (layer.name || layer.id)), f: ev.frame, n: ev.name });
                if (log.length > 400) log.shift();
              }
            }
            for (const ev of evs) {
              for (const sink of sinks) {
                const sb = sink.sandbox;
                if (!sb || sb.disabled) continue;
                if (sink.kind === "text") {
                  const ret = sb.callAnimationEvent(ev, String(layer.text ?? ""));
                  if (typeof ret === "string") layer.text = ret;
                } else if (sink.kind === "effectVisible") {
                  const cur = sink.run && sink.run.last !== undefined && sink.run.last !== null ? sink.run.last : !!sink.effect.visible;
                  const ret = sb.callAnimationEvent(ev, cur);
                  if (sink.run && (typeof ret === "boolean" || (typeof ret === "number" && Number.isFinite(ret)))) sink.run.last = ret;
                  const folded = foldVisibleRet(ret);
                  if (folded !== undefined) sink.effect.visible = folded;
                } else if (sink.kind === "animLayerField") {
                  // animationlayers[].blend / .rate 脚本的 animationEvent：
                  // 当前值从该层的对应字段读，返回数字写回（Trip 的 end → kirbystate 复位
                  // 就是在这里面做的）
                  const al = layer.animationLayers?.[sink.animLayerIndex];
                  if (!al) continue;
                  const cur = Number(al[sink.field]);
                  const ret = sb.callAnimationEvent(ev, Number.isFinite(cur) ? cur : 1);
                  const n = typeof ret === "number" ? ret : Number(ret && ret.value);
                  if (Number.isFinite(n)) al[sink.field] = sink.field === "blend" ? Math.max(0, Math.min(1, n)) : n;
                } else if (sink.kind === "const") {
                  const ret = sb.callAnimationEvent(ev, (sb as any).__lastConstValue);
                  if (typeof ret === "number" && Number.isFinite(ret)) (sb as any).__lastConstValue = ret;
                  else if (ret && typeof ret === "object" && Number.isFinite(Number((ret as any).x)) && Number.isFinite(Number((ret as any).y))) (sb as any).__lastConstValue = ret;
                } else if (sink.kind === "bool") {
                  const ret = sb.callAnimationEvent(ev, !!layer.visible);
                  const folded = foldVisibleRet(ret);
                  if (folded !== undefined && layer.visibleSelf !== folded) {
                    layer.visibleSelf = folded;
                    visibilityDirty = true;
                  }
                } else if (sink.kind === "scalar") {
                  const ret = sb.callAnimationEvent(ev, Number(layer[sink.field]) || 0);
                  const n = Number(ret);
                  if (Number.isFinite(n)) layer[sink.field] = n;
                } else {
                  const lcur = layer[sink.slot];
                  const v = sink.field === "angles"
                    ? wtext.radToScriptAngles(lcur)
                    : { x: (lcur && lcur[0]) || 0, y: (lcur && lcur[1]) || 0, z: (lcur && lcur[2]) || 0 };
                  const ret = sb.callAnimationEvent(ev, v);
                  const o = ret && typeof ret === "object" && "x" in (ret as object) ? (ret as any) : v;
                  layer[sink.slot] = sink.field === "angles"
                    ? wtext.scriptAnglesToRad(o)
                    : [Number(o.x) || 0, Number(o.y) || 0, Number(o.z) || 0];
                }
              }
            }
          };
          for (const run of animRuns) {
            run.ctrl.advance(clockDt);
            const field = run.field;
            const slot = run.slot || field;
            const out = run.ctrl.applyTo(run.ctrl.baseNumeric);
            if (Array.isArray(out)) {
              // 逐分量写回，形状契约见 anim.writeAnimSlot（判据跑真实现）
              anim.writeAnimSlot(run.layer, slot, out);
            } else if (Number.isFinite(out)) {
              // [we-scene patch] visible 动画必须写 visibleSelf 并重算子孙——
              // 直接写 layer.visible（有效可见性）会被任何一次 recomputeVisibility
              // 冲掉，也不沿父链传播（与对象脚本 visible 路径同构）。
              // 语料目前 0 处，属潜伏加固。
              if (field === "visible") {
                if (run.layer.visibleSelf !== !!out) {
                  run.layer.visibleSelf = !!out;
                  visibilityDirty = true;
                }
              } else if (field === "volume") {
                // [we-scene patch] 音量动画：此前写 layer.volume 死槽——音频元素
                // 只读 soundprops.volume。写回与属性热更同一范式（双写 + 实时
                // setVolume，无节流要求）。2477602742 火车包络、3521337568 BGM 淡入。
                run.layer.soundprops.volume = out;
                run.layer.soundCtl?.setVolume?.(out);
              } else if (field === "maxwidth") {
                // [we-scene patch] 文字限宽动画：写排版真正读的 textMaxwidth
                //（此前写 layer.maxwidth 死槽；重排触发已入 lastKey）。
                run.layer.textMaxwidth = out;
              } else if (field === "zoom") {
                // [we-scene patch] 对象级 zoom 动画：layer.zoom 零读者，语义
                // 消费方是 cameraTransforms.zoom（math.js 每帧读；3521337568
                // 相机路径对象的开场 zoom 3→1）。与 general zoom 同一消费通道。
                if (out > 0) (scene as any).cameraTransforms.zoom = out;
              } else {
                // [we-scene patch issue #9] 通用槽写回必须**保住槽的形状**：
                // 标量写进向量槽要广播（WE 的标量→向量约定），绝不能把
                // origin/scale/angles 的 local 数组槽换成 number —— 那会让下一帧
                // recomposeWorld 的 `.slice()` 抛 TypeError，异常逃出 rAF 回调、
                // 渲染循环无声死亡，首帧永不完成且 mount() 无成功也无失败。
                // 规则实现与判据都在 anim.writeAnimSlot（verify-transform 跑真实现）。
                anim.writeAnimSlot(run.layer, slot, out);
              }
            }
          }
          // [we-scene patch] 粒子 override 动画与对象字段动画同一时钟推进，
          // 写回该层全部粒子系统的倍率（轻量 setter，不动 pool）。
          // 必须在 render 之前：ps.advance/render 当帧就要读到新 opacityMul。
          for (const run of overrideAnimRuns) {
            run.ctrl.advance(clockDt);
            const out = run.ctrl.applyTo(run.ctrl.baseNumeric);
            if (typeof out !== "number" || !Number.isFinite(out)) continue;
            const list = particleSystemsByLayer.get(run.layer.id);
            if (!list) continue;
            for (const ps of list) ps.setOverrideValue(run.key, out);
          }
          // [we-scene patch] instanceoverride 脚本逐帧求值（音频响应粒子）。
          // 返回标量写倍率；返回向量（colorn "r g b"）需透传，setOverrideValue
          // 的颜色分支接受数组——对象沙箱返回 Vec3-like（{x,y,z}）时转数组。
          // [we-scene patch] animationlayers[].visible 脚本逐帧求值（puppet
          // 蒙皮前，computeSkinMatrices 当帧就要读到）。返回值折叠成 bool。
          for (const run of animLayerScriptRuns) {
            if (run.sandbox.disabled) continue;
            run.sandbox.engine.frametime = animDt;
            run.sandbox.engine.runtime = t;
            run.sandbox.engine.timeOfDay = timeOfDayValue;
            const al = run.layer.animationLayers?.[run.index];
            if (!al) continue;
            const out = run.sandbox.callUpdate(al.visible !== false);
            const f = foldVisibleRet(out);
            if (f !== undefined) al.visible = f;
          }
          // [we-scene patch 2026-09-28] blend / rate 脚本逐帧求值（蒙皮前）
          for (const run of animLayerFieldRuns) {
            if (run.sandbox.disabled) continue;
            run.sandbox.engine.frametime = animDt;
            run.sandbox.engine.runtime = t;
            run.sandbox.engine.timeOfDay = timeOfDayValue;
            const al = run.layer.animationLayers?.[run.index];
            if (!al) continue;
            const cur = Number(al[run.field]);
            const out = run.sandbox.callUpdate(Number.isFinite(cur) ? cur : 1);
            const n = typeof out === "number" ? out : Number((out as any)?.value);
            if (!Number.isFinite(n)) continue;
            al[run.field] = run.field === "blend" ? Math.max(0, Math.min(1, n)) : n;
          }
          // blend 关键帧动画：推进 + 事件（事件要派给该层脚本）
          for (const run of animLayerBlendAnims) {
            const al = run.layer.animationLayers?.[run.index];
            if (!al) continue;
            run.ctrl.advance(clockDt);
            const out = run.ctrl.applyTo(run.ctrl.baseNumeric);
            const n = Array.isArray(out) ? Number(out[0]) : Number(out);
            if (Number.isFinite(n)) al.blend = Math.max(0, Math.min(1, n));
            const evs = run.ctrl.takeEvents();
            if (evs.length) dispatchAnimEvents(run.layer, evs);
          }
          for (const run of overrideScriptRuns) {
            if (run.sandbox.disabled) continue;
            run.sandbox.engine.frametime = animDt;
            run.sandbox.engine.runtime = t;
            run.sandbox.engine.screenResolution = { x: c.clientWidth || window.innerWidth || 1, y: c.clientHeight || window.innerHeight || 1 };
            run.sandbox.engine.timeOfDay = timeOfDayValue;
            const out = run.sandbox.callUpdate(undefined);
            const list = particleSystemsByLayer.get(run.layer.id);
            if (!list) continue;
            let val: unknown = out;
            // colorn 脚本可能返回 {x,y,z} / "r g b" / 数字倍率
            if (out && typeof out === "object") {
              const o = out as any;
              if (o.x !== undefined || o.y !== undefined) val = [Number(o.x) || 0, Number(o.y) || 0, Number(o.z) || 0];
            }
            for (const ps of list) {
              if (run.key === "colorn" && Array.isArray(val)) ps.setColorOverride(val);
              else ps.setOverrideValue(run.key, val as number);
            }
          }
          // [we-scene patch] 帧事件 drain（图层级广播）：对象字段动画与粒子
          // override 动画在本帧推进时越过的事件，当帧派发。
          for (const run of animRuns) {
            const evs = run.ctrl.takeEvents();
            if (evs.length) dispatchAnimEvents(run.layer, evs);
          }
          for (const run of overrideAnimRuns) {
            const evs = run.ctrl.takeEvents();
            if (evs.length) dispatchAnimEvents(run.layer, evs);
          }
          // general 动画没有图层语义（语料 0 处 events），drain 丢弃防积压。
          for (const run of generalAnimRuns) run.ctrl.takeEvents();
          for (const run of generalAnimRuns) {
            run.ctrl.advance(clockDt);
            const out = run.ctrl.applyTo(run.ctrl.baseNumeric);
            if (typeof out === "number" && Number.isFinite(out)) run.write(out);
            else if (Array.isArray(out) && Number.isFinite(out[0])) run.write(out[0]);
          }
          // 效果开关脚本逐帧求值（只有明确返回布尔时才写回，同 visible 字段脚本）
          // [we-scene patch] engine.timeOfDay 逐秒回填（一天中的时刻 [0,1)）。
          // 此前只在沙箱构造时算一次（3151551777 火车震动、2134765860 夜灯…
          // 全库 27 处 / 4 张），壁纸挂几小时也不入夜。每秒算一次即可：最小
          // 粒度到秒，且昼夜混合脚本都按小时门判断（smoothStep(6.5, 7.5, …)）。
          // 常量沙箱在 renderer 的 scriptedConstants 里逐帧回填（同一公式）。
          // 必须放在下面所有字段求值循环之前：effect 开关 / general / 对象脚本
          // 都会读它。
          const todSec = Math.floor(now / 1000);
          if (todSec !== lastTodSec) {
            lastTodSec = todSec;
            const d = new Date();
            timeOfDayValue = (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) / 86400;
          }
          for (const run of effectVisibleRuns) {
            if (run.sandbox.disabled) continue;
            // frametime 与 runtime 必须同一时基：runtime 是真实时钟 t，frametime
            // 若用目标帧间隔就系统性欠计，作者的 `x += v * frametime` 积分会比骨骼
            // 动画越走越慢（全库 57 张脚本用 frametime，3233141951 本张 9 处）。
            run.sandbox.engine.frametime = animDt;
            run.sandbox.engine.runtime = t;
            run.sandbox.engine.timeOfDay = timeOfDayValue;
            const ret = run.sandbox.callUpdate(
              // [we-scene patch] 入参 = 上一帧**未折叠**的返回值（run.last，首轮
              // 为 init 返回值），不再每帧重建 !!visible —— 淡出脚本的 mix 链靠
              // 小数进度逐帧逼近 0，只喂 bool 会把进度永久卡在 1（3233141951
              // 中音条淡出永不完成）。返回值 number 按 WE 折叠（≠0 = 可见）；
              // undefined/NaN 保持不变（不下毒反馈环）。
              run.last !== undefined && run.last !== null ? run.last : !!run.effect.visible,
            );
            if (typeof ret === "boolean" || (typeof ret === "number" && Number.isFinite(ret))) run.last = ret;
            const folded = foldVisibleRet(ret);
            if (folded !== undefined) run.effect.visible = folded;
          }
          for (const run of generalScriptRuns) {
            if (run.sandbox.disabled) continue;
            run.sandbox.engine.frametime = animDt;
            run.sandbox.engine.runtime = t;
            run.sandbox.engine.timeOfDay = timeOfDayValue;
            const g = (scene as any).general || {};
            const cur = g[run.field] && typeof g[run.field] === "object" && "value" in g[run.field]
              ? g[run.field].value
              : g[run.field];
            const ret = run.sandbox.callUpdate(cur);
            if (ret !== undefined) run.write(ret);
          }
          // 对象脚本逐帧求值（音频条 scale 随频谱伸缩等）；dt 封顶同粒子
          const screenRes = { x: c.clientWidth || window.innerWidth || 1, y: c.clientHeight || window.innerHeight || 1 };
          // [we-scene patch] 时钟回填**不能只覆盖 objectScriptRuns**。那个队列按
          // `hasUpdate` 筛过，把「引擎层」脚本（无 export，只往 shared 上装 helper）
          // 挡在外面；而 helper 是在那个沙箱里定义的闭包，读的就是它自己的 engine。
          // 只回填有 update 的沙箱 → 引擎层 runtime 恒为 0 → 依赖 `engine.runtime -
          // stateChangeTime >= delay` 的动画闸门永不开启（3786330502 点绿色箭头
          // shared.ck 翻了却一动不动）。改为按沙箱回填，字段求值仍走下面的队列。
          for (const sb of propSandboxes) {
            if (!sb || sb.disabled) continue;
            sb.engine.frametime = animDt;
            sb.engine.runtime = t;
            sb.engine.screenResolution = screenRes;
            sb.engine.timeOfDay = timeOfDayValue;
          }
          seedCameraTransforms();
          for (const run of objectScriptRuns) {
            if (run.sandbox.disabled) continue;
            run.sandbox.engine.frametime = animDt;
            run.sandbox.engine.runtime = t;
            run.sandbox.engine.screenResolution = screenRes;
            run.sandbox.engine.timeOfDay = timeOfDayValue;
            const cur = run.layer[run.field];
            if (run.kind === "bool") {
              // visible：全库 180 个此类脚本的 value 快照都是 boolean。
              // 纯 cursor 交互脚本（71 个，无 update）的 callUpdate 返回 undefined，
              // 此时必须保留图层原可见性，否则整层会被 undefined 判成隐藏而消失。
              // [we-scene patch] number 按 WE 折叠（≠0 = 可见），未折叠值逐帧反馈
              //（与 effectVisibleRuns 同构：淡出计时器脚本挂在图层 visible 上时
              // 的 mix 链依赖小数进度）。
              const cur2 = run.last !== undefined && run.last !== null ? run.last : !!cur;
              const ret = run.sandbox.callUpdate(cur2);
              if (typeof ret === "boolean" || (typeof ret === "number" && Number.isFinite(ret))) run.last = ret;
              const folded = foldVisibleRet(ret);
              if (folded !== undefined) {
                if (run.field === "visible") {
                  if (run.layer.visibleSelf !== folded) {
                    run.layer.visibleSelf = folded;
                    visibilityDirty = true;
                  }
                } else {
                  run.layer[run.field] = folded;
                }
              }
            } else if (run.kind === "scalar") {
              // 散字段写回真实消费槽（P2-1）：maxwidth/pointsize 是文字布局
              // 字段（layer.textMaxwidth/textPointsize，直接写 layer.maxwidth 是
              // 零读者），volume 是声音层音量（soundprops + HTMLAudio）。
              const curSlot = scalarFieldSlot(run.layer, run.field);
              const ret = run.sandbox.callUpdate(Number(curSlot.get()) || 0);
              const n = Number(ret);
              if (Number.isFinite(n)) curSlot.set(n);
            } else {
              // 变换字段在 local 槽上收发（见 fieldSlot）；world 由 recomposeWorld 合成。
              const slot = run.slot || run.field;
              const lcur = run.layer[slot];
              const v = run.field === "angles"
                ? wtext.radToScriptAngles(lcur)
                : { x: lcur[0] || 0, y: lcur[1] || 0, z: lcur[2] || 0 };
              const ret = run.sandbox.callUpdate(v);
              const o = ret && typeof ret === "object" && "x" in (ret as object) ? ret : v;
              run.layer[slot] = run.field === "angles"
                ? wtext.scriptAnglesToRad(o)
                : [o.x || 0, o.y || 0, o.z || 0];
              // [we-scene patch] 文字层的绘制色读的是 `textColor` 这份**拷贝**
              //（drawTextLayer 的 opts.color 就是它），只写 layer.color 等于没写：
              // 3694771168 的时钟文字把 color 绑在共享颜色上，方块的 Hole Color
              // 修对之后字仍旧是 scene.json 快照的 0 0 0（纯黑）。user 属性热更那条
              // 路径早有这两行（applyUserProperties 里 `textColor = color`），
              // 逐帧脚本这条漏了 —— 这里补齐，两条路径同源。
              if (run.field === "color" && (run.layer as { isText?: boolean }).isText) {
                (run.layer as { textColor: number[] }).textColor = run.layer.color;
              }
            }
          }
          visibilityDeferred = false;
          // 脚本经 proxy 写 visibleSelf 的合并结果并入同一次重算（两者语义完全等价：
          // 都只改 visibleSelf、都在本帧绘制前生效）。阶段外的写仍然是立即重算，
          // 所以这里只需要把 pending 并进来。
          if (visibilityPending) {
            visibilityPending = false;
            visibilityDirty = true;
          }
          if (visibilityDirty) recomputeVisibility();
          // [we-scene patch] 父子变换重算：把 local 三件套合成回 world。
          // 必须在动画/脚本写完 local **之后**、followAttachments 与绘制**之前**。
          // 跨层脚本经 markTransformDirty 登记的子层并入脏集合（见 scriptedTransformDirty）。
          if (scriptedTransformDirty.size) {
            for (const id of scriptedTransformDirty) transformDirty.add(id);
            scriptedTransformDirty.clear();
          }
          // 只重算 transformDirty（变换绑了脚本/动画的层及其整棵子树，外加挂件子树），
          // 其余图层保持 parse 时的 world 一个字节都不碰。
          if (transformDirty.size) scn.recomposeWorld(scene.layers, transformDirty);
          // 相机实体：脚本写完 local、world 合成完之后、绘制之前刷新（见上面的长注释）。
          refreshRuntimeCamera(t);
          // 音频流推进并重填文字脚本的频谱视图。优先级：宿主注入 > 系统实况 >
          // 内置模拟（确定性：同 t 同频谱）。hostAudio.pump 内部会在宿主无数据时
          // 自行置 active=false，于是这一帧自动回落到后两者。
          if (audioSim.enabled) {
            hostAudio.pump();
            if (!hostAudio.active) {
            if (audioDriverRef.current) audioDriverRef.current.pump();
            else simAudio.update(t);
          }
          // [we-scene patch] BGM 并入音频快照（必须在 fillAudioBuffers 前）：
          // 自带声音层在播放时，它的频谱与当前源（模拟/注入/系统实况）逐频段取 max，
          // 使「BGM + 音频反应」壁纸的音条能响应自身音乐。取一份临时快照合并，
          // 不改驱动源/模拟器内部数组。
          const bgmBands = bgm.readBands();
          const baseSnap = activeAudioSnapshot();
          if (bgmBands) {
            // 在副本上合并，绝不就地改模拟器/注入源的内部数组（那会逐帧累积污染）。
            const merged: any = {
              left64: baseSnap.left64.slice(),
              right64: baseSnap.right64.slice(),
              left32: baseSnap.left32.slice(),
              right32: baseSnap.right32.slice(),
              left16: baseSnap.left16.slice(),
              right16: baseSnap.right16.slice(),
              level: baseSnap.level,
              silent: false,
            };
            mergeBgmBands(merged, bgmBands, BGM_SPECTRUM_GAIN);
            frameAudioSnapshot = merged;
            audioMod.fillAudioBuffers(audioViews, merged);
          } else {
            frameAudioSnapshot = baseSnap;
            audioMod.fillAudioBuffers(audioViews, baseSnap);
          }
          }
          // [we-scene patch] 挂件跟随父 puppet 附着点。必须在对象脚本之后、绘制之前：
          // 从绑定姿势的 base origin 重写，加上当前姿势与绑定姿势的差。
          if (attachFollows.length) {
            mdl.followAttachments(attachFollows, t, getBoneOverrides);
          }
          // [we-scene patch] 骨骼（puppet）动画帧事件：播放头 = t × rate × fps，
          // 与时间轴事件同一套半开区间跨帧检测（animation.js crossedEvents），
          // 同一套图层级广播（2477602742 flashStart → bell.play；
          // 3396722575/3351179520/3405117965 的「错帧/插针」事件）。
          // 首个推进帧的 prev 取「第 0 帧之前半个帧」（anim.INITIAL_PREV_FRAME，
          // 与 OWE SceneAnimationPlayback::m_previous_frame 初值 −0.5 同约定）：
          // 装载当帧就要越过 frame 0 的事件。取 prev=cur 会让 2477602742 的
          // flashStart（它的 pole 动画 360s 循环把它钉在 frame 0）永远不发生 ——
          // 右灯 alpha 动画 startpaused 停在 frame 0（=1）常亮，只剩左灯自播闪烁，
          // 「两个红灯交替闪」退化成「一灯闪 + 一灯常亮」，且铃铛也永不响。
          for (const item of mdlItems) {
            const mdlObj = item.mdl;
            const layer = item.layer;
            const anims = mdlObj.animations;
            if (!anims || !anims.length || !layer.animationLayers || !layer.visible) continue;
            if (!anims.some((a: any) => a.events && a.events.length)) continue;
            let prevMap = puppetPrevFrames.get(layer);
            if (!prevMap) {
              prevMap = new Map<number, number>();
              puppetPrevFrames.set(layer, prevMap);
            }
            for (let li = 0; li < layer.animationLayers.length; li++) {
              const al = layer.animationLayers[li];
              if (!al || al.visible === false || al.visible === 0) continue;
              const a = anims.find((x: any) => x.id === al.animation);
              if (!a || !a.events || !a.events.length) continue;
              const curFrame = t * (typeof al.rate === "number" ? al.rate : 1) * a.fps;
              const prev = prevMap.has(li) ? (prevMap.get(li) as number) : anim.INITIAL_PREV_FRAME;
              const crossed = anim.crossedEvents(
                a.events,
                prev,
                curFrame,
                a.frameCount,
                a.mode === "loop" ? "loop" : a.mode === "mirror" ? "mirror" : "single",
              );
              if (crossed.length) dispatchAnimEvents(layer, crossed);
              prevMap.set(li, curFrame);
            }
          }
          const peek = rt.coverAlign;
          // ROI 图层裁剪（V5 方案 E）：遮挡可见矩形 → 世界矩形。映射用 fitWindow
          // 同源数学（含 peek 对齐；backing 与 CSS 等比，窗口结果一致），**相机本身
          // 不动** —— ROI 只是 isLayerOffscreen 之外的第二个裁剪查询窗口。
          // 逆映射本体在 occlusion.roiWorldRects（纯函数，可离线行为断言）：
          // 可见区覆盖整画布时它返回 undefined，渲染器据此走原路径零行为差。
          let roiWorld: WorldRect[] | undefined;
          const occSnap = rt.occlusion;
          if (occSnap && occSnap.rects.length) {
            const cssW = c.clientWidth || 1;
            const cssH = c.clientHeight || 1;
            const ortho = (scene as any).general?.orthogonalprojection || {};
            const projW = ortho.width || c.width;
            const projH = ortho.height || c.height;
            const roiFit = normalizeFit(rt.cfg.fit);
            const win = fitWindow(roiFit, projW, projH, cssW, cssH, peek.x, peek.y);
            // zoom 收缩与 buildCamera 同源（V5 修补）：曾用裸 fitWindow 逆映射，
            // zoom<1（脚本 zoom-out）时可见窗算小 → 可见区边缘图层被静默误裁
            //（独立评审实测 0.9 → 每侧 107px，超 64px 裁剪余量）；zoom>1 只是
            // 保守多画。透视场景 cam.perspective 时 layerCullBoundsOf 返回 null，
            // ROI 本就不生效。
            applyCameraZoom(win, cameraZoomOf(scene));
            roiWorld = roiWorldRects(occSnap.rects, win, cssW, cssH);
          }
          void renderer
            .render(scene, textures, c.width, c.height, t, normalizeFit(rt.cfg.fit), peek.x, peek.y, roiWorld)
            .then(() => {
              // [we-scene patch] 本代已拆（clear/destroy）就立刻退出：**不得**再触发
              // rt.onFirstFrame —— 那个槽位是新代装的，旧代在飞的这一帧会把新代的
              // mount() 提前 resolve（docs/ENGINE-REVIEW-2026-10.md §3.3）。
              // 注意与下面的 `rt.paused` 早退区分：paused 是「本代还活着但停着」，
              // 首帧仍要落地（autoplay:false 的语义就是「就绪但静止」）。
              if (disposed) return;
              // 库化桥接：首帧**画完之后**才 resolve mount() 的 Promise（一次性）。
              // 必须在 render().then 里，不能放在调用之前：那样 Promise 会早一帧
              // 落地，调用方拿到实例时画布还是空的 —— autoplay:false 紧接着
              // pause()，渲染循环就此停住，画面永远停在一片 clearcolor。
              // 放这里也要在 disposed/paused 的早退**之前**，否则同样漏掉。
              if (rt.onFirstFrame) {
                const first = rt.onFirstFrame;
                rt.onFirstFrame = undefined;
                try {
                  first();
                } catch { /* 订阅者抛错不打断渲染 */ }
              }
              // 遮挡暂停跨到渲染回调里也要拦住重排（setOccluded(true) 取消的是
              // 挂起的 rAF，正在飞的这帧完成后不能再排下一帧）
              if (disposed || rt.paused || occlPaused(rt)) return;
              // [we-scene patch] 上下文丢失：实测画面会**静默冻结**（rAF 照跑、fps 照计、
              // console 与 /diag 全空），与 MSAA blit 静默失败症状无法区分。引擎已经做了
              // preventDefault + 一次性诊断（renderer.contextLost，见其注释），这里把它
              // 接到调用方：库走 onError，全屏页走降级页 —— 而不是让宿主对着白板干等。
              if (rt.renderer?.contextLost?.()) {
                const err = new Error("WebGL 上下文丢失：画面已冻结且不再更新，需要重挂载");
                reportDiag(rt, cfg, `上下文丢失：渲染已停止更新（引擎不重建 GL 资源）`, "error");
                disposed = true;
                if (rt.onError) rt.onError(err);
                else rt.fallbackPage?.();
                return;
              }
              // [we-scene patch] 常量动画的帧事件在 render 内（bindConstants）推进
              // 产生，render 后立刻做图层级广播（当帧派发；脚本对事件启动的动画
              // 从下一帧开始生效，与官方「播完检测」的用法兼容）。
              if (constAnimEventQueue.length) {
                for (const item of constAnimEventQueue) dispatchAnimEvents(item.layer, item.events);
                constAnimEventQueue.length = 0;
              }
              // 指针回调派发放在 render 之后：世界坐标由渲染器在帧内
              // syncWorld(cam, …) 算好（含视差补偿），此时命中判定才与画面一致。
              try {
                dispatchCursor();
              } catch (e) { /* 单个回调出错已在沙箱里熔断，这里兜底不打断渲染 */ }
              // 消费完毕再推进 last：下一帧才能看到「上一帧位置 vs 新位置」。
              pointerSrc.beginFrame();
              // [we-scene patch 2026-09-26] 文字脚本**每帧求值**（原来 100ms 节流）。
              // 节流是 1.0.0-beta1 起就有的、没有依据的保守优化，但它把「文字脚本的
              // 调用节奏」暴露给了脚本：作者常写 `fps = 1000/(now-lastCall)` 这种
              // 自算帧率的小挂件（3510729512 的 newproperty46「当前帧率显示」就是），
              // 于是挂件恒读 ~9~10（= 1000/100ms），与真实帧率无关、把用户带偏。
              // WE 官方每帧调 update()，本仓跟着对齐。
              // 代价可控：重排版/重绘/上传纹理本来就有「内容不变就跳过」的门控
              // （见 updateTexts），每帧多做的是沙箱里的纯 JS 求值。
              try {
                if (rt.sceneTextUpdate) rt.sceneTextUpdate(t);
              } catch (e) { /* 文字更新失败忽略 */ }
              rt.raf = requestAnimationFrame(renderLoop);
            })
            .catch((e: Error) => {
              // [we-scene patch] 这条 catch 原先只 console.warn + diag + disposed：循环
              // **无声死亡**（没有下一帧、宿主拿不到任何 error，只看到画面停在最后一帧）。
              // 与装配期/守卫壳同一条出口：有 onError 交回调用方，否则挂降级页。
              console.warn("scene render error:", e);
              const err = e instanceof Error ? e : new Error(String(e));
              if (disposed) return;
              reportDiag(rt, cfg, `render: ${String(err.message || err).slice(0, 200)}`, "error");
              disposed = true;
              if (rt.onError) rt.onError(err);
              else rt.fallbackPage?.();
            });
        } else {
          if (!rt.paused && !occlPaused(rt)) rt.raf = requestAnimationFrame(renderLoop);
        }
      };
      /**
       * [we-scene patch issue #9] rAF 自递归的守卫壳。
       *
       * 渲染循环的唯一续帧动作是函数体末尾的 `requestAnimationFrame(renderLoop)`。
       * 循环体里任一同步异常都会让那行永远执行不到 —— 循环**无声死亡**：既没有
       * 下一帧，也没有任何诊断，调用方只看到 mount() 的 Promise 再也不落地
       * （宿主无法区分「还在加载」和「已经死了」，只能自己加看门狗猜）。
       *
       * 实测触发形态：畸形关键帧动画把 `localAngles` 写成标量，recomposeWorld
       * 的 `l.localAngles.slice()` 抛 TypeError（见 animRuns 写回处的注释）。
       *
       * 这里把它兜成「一条诊断 + onError」：宿主立刻拿到失败原因，不再是黑洞。
       */
      const renderLoop = (now: number) => {
        try {
          renderLoopImpl(now);
        } catch (e) {
          const err = e instanceof Error ? e : new Error(String(e));
          if (disposed) return;
          reportDiag(rt, cfg, `failed: renderLoop 异常，渲染循环终止 — ${String(err.message || err).slice(0, 200)}`, "error");
          disposed = true;
          rt.raf = undefined;
          // 与装配期失败同一条出口：公共 API 设了 onError 就交回调用方
          // （mount() 的 Promise 立刻 reject），旧壁纸页维持降级页行为。
          if (rt.onError) rt.onError(err);
          else rt.fallbackPage?.();
        }
      };
      const kickLoop = () => {
        if (disposed || rt.paused || occlPaused(rt)) return;
        if (rt.raf !== undefined) return;
        // 烘焙队列从这里（装配完成、马上要出第一帧）才开始消化：编码 PNG 的开销
        // 只服务下一次加载，不许在本次加载期抢主线程（见 bake-cache 的 createBakeQueue）。
        bakeQueue.arm();
        rt.raf = requestAnimationFrame(renderLoop);
      };
      const applyLiveProps = (wire: Record<string, { value: unknown }>) => {
        if (disposed) return;
        const properties = (scene as any).properties || {};
        const changed = mergeUserPropertyValues(properties, liveUserProps, wire) as Record<string, unknown>;
        if (!Object.keys(changed).length) return;
        // [we-scene patch 3243449890] 用户图片槽（`usertextures` 绑的属性）热更后要
        // 重新取图。属性值一律是壁纸目录下的相对路径，装配期的预载只服务「挂载
        // 那一刻的值」，热更链路此前完全不碰贴图 —— 用户选完自定义图，画面照旧是
        // 作者原槽贴图（3243449890 的「三角组件背景」选图后四块三角一动不动）。
        for (const name of propTexSlots) {
          if (name in changed) void refreshPropTexture(name);
        }
        // general 字段同样可能绑用户属性：clearcolor 绑 schemecolor（3792579196）、
        // HDR 开关绑 bloom（2902406982 / 3299228616 / 3764725758 等一整族）。
        // 此前只逐层 resolve，general 绑定的 .value 永远停在挂载快照 —— 开关
        // 切了、画面不变。resolveUserProps 就地改 .value，渲染端每帧解包读取。
        resolveUserProps((scene as any).general || {}, properties, 0);
        // 材质文档里的绑定也要重解：它们不在 srcObject 树里（见 materialDocs 的注释）。
        // 少这一步，「音频条颜色 / 可视化器透明度」这类**只绑在材质上**的属性热更后画面不动。
        for (const doc of materialDocs) resolveUserProps(doc, properties, 0);
        // generic4 材质常量已烘进图层字段（见 attachBuiltinMatTint）：材质文档重解后
        // 必须按新值重折一遍，否则「音频条颜色/亮度」这类只绑在材质上的属性热更仍不动。
        for (const layer of scene.layers as any[]) {
          if (layer.matTint) applyBuiltinMatTint(layer);
        }
        for (const layer of scene.layers as any[]) {
          const src = layer.srcObject;
          if (!src) continue;
          resolveUserProps(src, properties, 0);
          const uVis = boundUserName(src.visible);
          if (uVis && uVis in changed) {
            // 先按 user 绑定写 visibleSelf。hideeyeswindow 等语义反转的脚本会在
            // 下面 applyUserProperties 里经 proxy 改写 visibleSelf 并重算子层
            // （3122339805）。不能「有 visible 脚本就跳过」：3299228616 的
            // Clock Layer 把拖拽脚本挂在 visible 上，同时 user 绑 clocklocation*，
            // 跳过后 combo 热更（含语言切换时整表下发）永远写不回显隐。
            layer.visibleSelf = scn.parseBool(src.visible, true);
          }
          const uCol = boundUserName(src.color);
          if (uCol && uCol in changed) {
            layer.color = scn.parseColor(src.color);
            if (layer.isText) layer.textColor = layer.color;
          }
          const uA = boundUserName(src.alpha);
          if (uA && uA in changed) layer.alpha = scn.parseNum(src.alpha, 1);
          const uB = boundUserName(src.brightness);
          if (uB && uB in changed) layer.brightness = scn.parseNum(src.brightness, 1);
          // [we-scene patch] 灯光对象的 `radius` 可能就是用户的「亮度」滑条
          // （2890473419 的「光源1亮度」绑在 radius 上）：resolveUserProps 只改了
          // src 上的值，layer.lightRadius 是装配期读出来的副本，不回写就出现
          // 「滑条能拖、画面不变」。
          const uRad = boundUserName(src.radius);
          if (uRad && uRad in changed) (layer as any).lightRadius = scn.parseNum(src.radius, 1000);
          const uVol = boundUserName(src.volume);
          if (uVol && uVol in changed) {
            const vol = scn.parseNum(src.volume, 1);
            if (layer.soundprops) layer.soundprops.volume = vol;
            layer.soundCtl?.setVolume?.(vol);
          }
          for (let i = 0; i < (src.animationlayers || []).length; i++) {
            const a = src.animationlayers[i];
            const al = layer.animationLayers?.[i];
            if (!a || !al) continue;
            const uv = boundUserName(a.visible);
            if (uv && uv in changed) al.visible = scn.parseBool(a.visible, true);
            const ur = boundUserName(a.rate);
            if (ur && ur in changed) al.rate = scn.parseNum(a.rate, 1);
            const ub = boundUserName(a.blend);
            if (ub && ub in changed) al.blend = scn.parseNum(a.blend, 1);
          }
          for (let ei = 0; ei < (src.effects || []).length; ei++) {
            const se = src.effects[ei];
            const le = layer.effects?.[ei];
            if (!se || !le) continue;
            const ue = boundUserName(se.visible);
            if (ue && ue in changed && !le.visibleScript) {
              le.visible = scn.parseBool(se.visible, true);
            }
          }
          // 粒子 instanceoverride（colorn/count/alpha/rate…）与 PS 共享同一引用，
          // resolveUserProps 已就地改 .value；必须再 reapplyOverride，否则滑条热更
          // 只改包装、画面仍用挂载时的 _ov（Pac-Man 颜色、雪量等）。
          const iov = src.instanceoverride;
          if (iov && typeof iov === "object" && layer.particle) {
            let ovHit = false;
            for (const k of Object.keys(iov)) {
              if (k === "id") continue;
              const un = boundUserName(iov[k]);
              if (un && un in changed) {
                ovHit = true;
                break;
              }
            }
            if (ovHit) {
              const list = particleSystemsByLayer.get(layer.id);
              if (list) for (const ps of list) ps.reapplyOverride?.();
            }
          }
        }
        // 先让脚本写 visibleSelf（经 proxy），再整树重算有效 visible。
        for (const sb of propSandboxes) {
          if (!sb || sb.disabled) continue;
          try {
            sb.applyUserProperties(changed);
          } catch {
            /* 单沙箱失败不拖垮热更 */
          }
        }
        recomputeVisibility();
        // 粒子 advance/render 看 ps.visible；图层显隐热更后要对齐，否则
        // starreactive 关掉层仍在模拟，或语言切走后隐藏变体还在空转。
        for (const layer of scene.layers as any[]) {
          if (!layer.particle) continue;
          const list = particleSystemsByLayer.get(layer.id);
          if (!list) continue;
          for (const ps of list) ps.setVisible(!!layer.visible);
        }
        (renderer as any).applyConstUserProperties?.(changed);
        for (const it of textWidgets) it.lastKey = null;
        reportDiag(rt, cfg, `props hot: ${Object.keys(changed).join(",")}`, "info");
      };
      pauseImpl = () => {
        // 重入幂等：遮挡暂停 → 用户 pause() 的交织下会跑第二次，重捕获时
        // 媒体已停 → playingVideos 清空成空表 → 之后谁都恢复不出来（评审 P0）。
        // 首次调用已取消 rAF、已停媒体，kickLoop 又有 rt.paused/occlPaused 守卫，
        // 早退不漏事。
        if (pauseStarted) return;
        if (rt.raf !== undefined) {
          cancelAnimationFrame(rt.raf);
          rt.raf = undefined;
        }
        pauseStarted = performance.now();
        playingVideos.length = 0;
        for (const entry of textures.values()) {
          if (entry?.videoCtl?.isPlaying?.()) {
            playingVideos.push(entry.videoCtl);
            entry.videoCtl.pause();
          }
        }
        playingAudios.length = 0;
        for (const au of soundAudios) {
          if (!au.paused && !au.ended) {
            playingAudios.push(au);
            au.pause();
          }
        }
      };
      resumeImpl = () => {
        if (pauseStarted) {
          pauseAccum += performance.now() - pauseStarted;
          pauseStarted = 0;
        }
        // 粒子时钟已改场景 t 同源（particleClock），恢复帧 animDt 天然连续，
        // 不再需要旧墙钟基准的重置。
        for (const ctl of playingVideos) {
          try {
            ctl.play();
          } catch {
            /* 忽略 */
          }
        }
        playingVideos.length = 0;
        for (const au of playingAudios) void au.play().catch(() => {});
        playingAudios.length = 0;
        // 恢复后首帧立即出，不被暂停期间冻结的节拍相位挡住
        frameGate.reset();
        kickLoop();
      };
      /**
       * 遮挡暂停（V5）：与用户 pause() 的三种交织（评估报告 §4-A 的语义边界）：
       *
       *   ① 纯遮挡：on=true 若已在暂停（pauseStarted≠0，用户先暂停过）就只记账
       *      不重复捕获媒体（重复跑 pauseImpl 会把 playingVideos 清空重捕成空表，
       *      用户 resume 时就什么都恢复不出来了）；on=false 复用 resumeImpl。
       *   ② 用户暂停期间解除遮挡：**不恢复媒体、不 kickLoop**（rt.paused 还立着），
       *      只把 pauseStarted 的账结掉 —— 否则遮挡解除会顺带把用户的暂停掀了。
       *   ③ 用户在遮挡暂停期间手动 resume：resumeImpl 照常跑，kickLoop 有
       *      rt.paused 守卫；渲染侧由 renderLoop 的遮挡档守卫兜住（不开画）。
       */
      setOccludedImpl = (on: boolean) => {
        if (on) {
          if (!pauseStarted) pauseImpl?.();
          return;
        }
        if (!rt.paused) {
          resumeImpl?.();
          return;
        }
        // 用户暂停仍生效：只结暂停账（场景时间连续性），媒体与循环保持暂停
        if (pauseStarted) {
          pauseAccum += performance.now() - pauseStarted;
          pauseStarted = 0;
        }
      };
      applyLiveImpl = applyLiveProps;
      if (pendingWire) {
        applyLiveProps(pendingWire);
        pendingWire = null;
      }
      kickLoop();
      {
        const ortho = (scene as any).general?.orthogonalprojection;
        const projW = ortho?.width || c.width;
        const projH = ortho?.height || c.height;
        const fit = normalizeFit(rt.cfg.fit);
        const win = fitWindow(fit, projW, projH, c.width, c.height);
        reportDiag(rt,
          cfg,
          `fit ${fit}: view ${Math.round(win.viewW)}x${Math.round(win.viewH)} scene ${projW}x${projH} canvas ${c.width}x${c.height}`,
          "info",
        );
        // cover 窥视的逐轴门控基准：**可见内容的世界包围盒**（旋转矩形取 AABB 并集）。
        // 画布溢出 ≠ 内容溢出——1920911984 这类「竖版画布 + 旋转 90° 横条」壁纸，
        // 画布纵向溢出 5000+ 而内容纵向只有 610（≈视窗 607），按画布算会把视窗
        // 滑出条外（整屏空白）。纯函数 coverContentBounds 见 math.js（离线判据直接跑）。
        {
          const b = coverContentBounds(scene.layers as any[]);
          if (Number.isFinite(b.minX) && Number.isFinite(b.minY)) {
            rt.coverPeek = {
              contentW: b.maxX - b.minX,
              contentH: b.maxY - b.minY,
              projW,
              projH,
            };
            reportDiag(rt, cfg, `cover peek gate: content ${Math.round(b.maxX - b.minX)}x${Math.round(b.maxY - b.minY)}`, "info");
          } else {
            // 没有任何出像素的层（或全是空 composelayer 画布）→ 记 0×0 基准而不是
            // 不设基准：`peekAxes` 对「无基准」是两轴放行（媒体/网页壁纸的既有行为），
            // 场景侧不设就等于「算不出内容在哪反而随便滑」。0×0 恒判无溢出 → 钉住居中。
            rt.coverPeek = { contentW: 0, contentH: 0, projW, projH };
            reportDiag(rt, cfg, `cover peek gate: content 0x0 (无出像素的层)`, "info");
          }
        }
      }
      reportDiag(rt, cfg, `renderer started: ${scene.layers.length} layers`, "info");
    } catch (e) {
      if (disposed) return;
      if (e && (e as Error).name === "AbortError") return;
      // 场景加载/渲染失败：diag 上报 + 降级画布演示
      console.warn("scene render failed:", e);
      const err = e instanceof Error ? e : new Error(String(e));
      reportDiag(rt, cfg, `failed: ${String(err.message || err).slice(0, 200)}`, "error");
      // 库化桥接：公共 API 设了 onError 就交回调用方兜底；
      // 旧路径（壁纸页）维持「失败挂降级页」的既有行为
      if (rt.onError) rt.onError(err);
      else rt.fallbackPage?.();
    }
  })();
}
