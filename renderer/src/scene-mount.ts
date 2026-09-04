// 场景壁纸装配（从 main.ts 拆出）：mountScene 一千两百行的拉取→解析→资源装配→
// 渲染循环→指针/脚本/音频/文字/粒子/媒体全链路都在这一个函数闭包里。
//
// [we-scene patch] 本次只做**文件级**搬移（行为零改动）；函数内部再按阶段拆分
// 属于下一轮（需先给装配各阶段补离线判据，见 docs/ARCHITECTURE.md 路线图）。
import { clear, effectiveDpr, markFrame, normalizeFit, readText, reportDiag, syncCanvasSize, type Runtime } from "./shell";
import { httpSource } from "./api/source";
import type { Source } from "./api/types";
import { createLoopingVideo } from "./video-loop";
import { SKIP_3D_MODELS, SKIP_COMPONENTS, SKIP_PARTICLES, SKIP_SCENE_EFFECTS, SKIP_TEXT, TEXT_EM_SCALE } from "./types";
import type { WallpaperConfig } from "./types";
import { WE_SHADER_HEADERS } from "../vendor/we-scene/headers";
import { fitWindow } from "../vendor/we-scene/render/math.js";
import { pkg, tex, scn, eff, rnd, noise, particles, ptex, mdl, wtext, wtimers, media, system, anim, pointerLib, hitTest, audioMod } from "./vendor";
import {
  flattenUserProperties,
  mergeUserPropertyValues,
  resolveUserProps,
  boundUserName,
} from "../vendor/we-scene/scene/user-props.js";
import { sanitizeFontForBrowser } from "../vendor/we-scene/render/font-sanitize.js";

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

// 字体族缓存：FontFace 以 family 名注册进 document.fonts，跨重挂复用避免同名重复注册
export const fontFaceCache = new Map<string, string>(); // "itemId|fontPath" → CSS family

/** 按缓存键缓存已解析的 scene.pkg。暂停恢复 / 改属性不再走网络与解析；
 *  真换壁纸最多留 2 份，避免多张百 MB 包常驻。
 *  键来自 Source.key（HTTP 源即 baseUrl，与旧的 mediaBase/itemId 等价）。 */
const pkgCache = new Map<string, { parsed: any; at: number }>();

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
      reportDiag(rt, cfg, `pkg cache hit: ${hit.parsed.fileSize} bytes`);
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
  reportDiag(rt, cfg, `pkg body: ${pkgBytes.byteLength} bytes`);
  const bytes = pkgBytes instanceof Uint8Array ? pkgBytes : new Uint8Array(pkgBytes);
  const parsed = pkg.parsePkg(bytes);
  if (!cacheKey) return parsed;
  pkgCache.set(cacheKey, { parsed, at: Date.now() });
  if (pkgCache.size > 2) {
    let oldestKey: string | null = null;
    let oldestAt = Infinity;
    for (const [k, v] of pkgCache) {
      if (k === cacheKey) continue;
      if (v.at < oldestAt) {
        oldestAt = v.at;
        oldestKey = k;
      }
    }
    if (oldestKey) pkgCache.delete(oldestKey);
  }
  return parsed;
}

export function mountScene(rt: Runtime, cfg: WallpaperConfig) {
  clear(rt);
  // 库形态：调用方给了 canvas 就画在它上面（可非全屏、可多实例）；
  // 旧形态：自建 canvas 铺满内部 wrap 容器。backing store 按显示尺寸折算：
  // 嵌入式 canvas 用 CSS 尺寸（全屏 canvas 的 clientWidth == innerWidth，等价）。
  const c = cfg.canvas ?? document.createElement("canvas");
  const dpr = effectiveDpr(rt, cfg);
  const vw = c.clientWidth || window.innerWidth || 1;
  const vh = c.clientHeight || window.innerHeight || 1;
  c.width = Math.max(1, Math.round(vw * dpr));
  c.height = Math.max(1, Math.round(vh * dpr));
  if (!cfg.canvas) {
    c.style.cssText = "position:absolute;inset:0;width:100%;height:100%;";
    rt.wrap?.appendChild(c);
  }
  rt.canvas = c;
  let disposed = false;
  const pkgAbort = new AbortController();
  // 粒子系统注册的 mousemove 监听（控制点跟随鼠标）；卸载时必须摘掉，
  // 否则重挂场景会在 window 上累积监听器，旧回调还持有已释放的 GL 资源。
  let particleCleanup: (() => void) | undefined;
  rt.sceneCleanup = () => {
    disposed = true;
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
  };

  void (async () => {
    try {
      // 资源来源：库形态走 cfg.source；旧形态由 mediaBase/src 合成 HTTP 源
      //（httpSource 内部保留「先试根目录、逐个 try/catch」的 WKWebView 踩坑逻辑）
      const source = cfg.source ?? httpSource(`${cfg.mediaBase}/${cfg.src}`);
      if (!cfg.source && (!cfg.mediaBase || !cfg.src)) {
        throw new Error("场景壁纸缺少 mediaBase/src");
      }
      reportDiag(rt, cfg, "mountScene start");
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

      const sceneEntry = pkg.getEntry(parsedPkg, "scene.json");
      if (!sceneEntry) throw new Error("pkg 中没有 scene.json（不是场景壁纸？）");
      const scene = scn.parseScene(JSON.parse(readText(sceneEntry)), project);
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
      // 脚本写 thisLayer.visible 时改 visibleSelf，再整树重算有效 visible。
      // 见 parse.recomputeLayerVisibility / 3122339805 Eyes·Numbers。
      // 必须在文字/对象脚本装配之前建好，两边 opts 都注入同一引用。
      const recomputeVisibility = () => scn.recomputeLayerVisibility(scene.layers);
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

      const shaderResolver = (rel: string): Promise<string | null> => {
        const inner = rel.startsWith("shaders/") ? rel : "shaders/" + rel;
        const file = rel.startsWith("shaders/") ? rel.slice("shaders/".length) : rel;
        const e = pkg.getEntry(parsedPkg, inner);
        let src = e ? readText(e) : (WE_SHADER_HEADERS[file] ?? null);
        // [we-scene patch] 调试钩子：在控制台改写任意 shader 源，用于定位画面异常。
        //   __shaderPatch = { 'effects/blur_combine': (src) => src.replace(...) }
        // 键可带或不带扩展名。把某个 pass 的输出染成纯色即可判定「这块像素是谁画的」——
        // 定位 2134765860 的纯白矩形时，正是靠它排除了 blur_combine / blend / 音频条
        // 三条线，最后才落到容器合成上。
        const patch = (window as unknown as Record<string, any>).__shaderPatch;
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
        diag: (msg: string) => reportDiag(rt, cfg, `renderer: ${msg}`),
        // 效果链 FBO 降采样：0=全质量，0.5≈效果分辨率减半→内存约 1/4。
        // 用全质量：降采样会让「层 alpha 再乘一张羽化 mask」的效果（opacity）在
        // 低分辨率下把过渡带插得更淡，再经后续 waterwaves 的 UV 位移搬移、
        // 最后放大回屏幕，就在网格交界处（如 3113287126 头发与手臂交汇）看到发虚透明。
        // 代价：该场景效果链 FBO 由 3.5MB 升到约 100MB。
        fboCapFactor: 0,
      });
      // 立即登记渲染器：即使后续异步加载中途被 clear(rt)，也能正确释放该 WebGL 上下文
      rt.renderer = renderer;
      if (disposed) return;

      // ---- 模拟音频源（WE 音频可视化，见 vendor we-scene render/audio.js）----
      // project.json 的 general.supportsaudioprocessing 是作者声明的「壁纸响应音频」
      // 开关：false 时喂静音（WE 语义，实测 false 的壁纸也无任何音频引用）。
      // 独立测试台没有系统音频，用确定性模拟频谱代替；换真实源只需替换 update。
      const supportsAudioProcessing =
        (project as { general?: { supportsaudioprocessing?: boolean } } | null)?.general
          ?.supportsaudioprocessing !== false;
      const simAudio = audioMod.createSimulatedAudio();
      const audioSim = { enabled: supportsAudioProcessing };
      // 静音（壁纸不支持音频 / __audioMute）必须显式喂全零：GL uniform 数组在
      // 不设置时会**保留上一帧的值**，返回 null 不会让波形落回零位。
      const zero = (n: number) => new Float32Array(n);
      const SILENT_AUDIO = {
        left16: zero(16), right16: zero(16),
        left32: zero(32), right32: zero(32),
        left64: zero(64), right64: zero(64),
        level: 0, silent: true,
      };
      renderer.setAudioProvider(() => (audioSim.enabled ? simAudio.snapshot : SILENT_AUDIO));
      // 文字脚本 engine.registerAudioBuffers(n) 的共享视图（text.js 惰性创建，每帧重填）
      const audioViews = new Map<number, { left: Float32Array; right: Float32Array; average: Float32Array }>();
      // 调试出口：音频状态 / 强制静音（音频响应 A/B 对比验证用）
      (window as unknown as Record<string, unknown>).__audioStats = () => ({
        enabled: audioSim.enabled,
        level: audioSim.enabled ? Math.round(simAudio.snapshot.level * 1000) / 1000 : 0,
        silent: audioSim.enabled ? simAudio.snapshot.silent : true,
        bass: audioSim.enabled ? Math.round(simAudio.snapshot.left64[2] * 1000) / 1000 : 0,
      });
      (window as unknown as Record<string, unknown>).__audioMute = (on: boolean) => {
        audioSim.enabled = !on;
        return audioSim.enabled;
      };
      reportDiag(rt, cfg, `audio: simulated stream, supportsaudioprocessing=${supportsAudioProcessing}`);

      // ---- 模拟媒体源（WE 媒体集成，见 vendor we-scene render/media.js）----
      // WE 把「系统正在播放的音乐」通过 media*Changed 回调推给脚本。独立测试台
      // 没有系统媒体会话，这里用确定性模拟播放列表代替；接真实源只需替换 update。
      //
      // 回调是**事件**不是轮询：只在快照变化时派发。语料里 mediaThumbnailChanged
      // 常写 `anim.stop(); anim.play();`，每帧广播会让动画永远卡在第 0 帧。
      const simMedia = media.createSimulatedMedia();
      const simWindow = system.createSimulatedWindowTitle();
      const shortcuts = system.createShortcutHandler((name: string) => {
        reportDiag(rt, cfg, `openUserShortcut: ${name}`);
      });
      const mediaSim = { enabled: true, override: null as Record<string, unknown> | null };
      // 挂了媒体回调的沙箱（广播表；媒体不做 hit-test，不必按图层索引）
      const mediaHooks: any[] = [];
      let lastMediaSnap: any = null;
      // [we-scene patch] 登记必须**带补发**。媒体回调是事件而非轮询，沙箱只能从
      // 回调里知道当前播放态；而效果常量沙箱是惰性创建的（首帧渲染到该 pass 才建），
      // 等它登记进广播表时，首帧那批事件早已派发完、lastMediaSnap 也已追平，
      // 它永远收不到 mediaPlaybackChanged —— 脚本里的 `var ofg = 0`（STOPPED）
      // 就成了永久状态。2938612768 的「歌名/专辑」正是这样：默认占位层与实时层
      // 各挂一份镜像淡入淡出脚本，占位层按「停止态」淡入到 1、实时层淡出到 0，
      // 于是画面永远停在 "Wallpaper Music" / "Name of artist"。
      // 用 diff(null, snapshot) 生成全量事件补给新沙箱，与首帧语义一致。
      const registerMediaHook = (sb: any) => {
        if (!sb || !sb.hasMediaHook || mediaHooks.includes(sb)) return;
        mediaHooks.push(sb);
        // 建场阶段（首帧 update 之前）快照还是空的，补发只会送一轮「无媒体」；
        // 那批沙箱由首帧的 diff 正常覆盖，这里跳过。只有真正迟到的才需要补。
        if (!simMedia.snapshot.hasMedia) return;
        for (const { name, event } of media.diffMediaEvents(null, simMedia.snapshot)) {
          try {
            sb.callMedia(name, event);
          } catch {
            /* 沙箱内部已有三振熔断，这里只防止一个坏脚本打断其余登记 */
          }
        }
      };
      (window as unknown as Record<string, unknown>).__mediaStats = () => ({
        enabled: mediaSim.enabled,
        hooks: mediaHooks.length,
        title: simMedia.snapshot.title,
        artist: simMedia.snapshot.artist,
        album: simMedia.snapshot.album,
        state: simMedia.snapshot.state,
        position: Math.round(simMedia.snapshot.position),
        duration: simMedia.snapshot.duration,
        hasThumbnail: simMedia.snapshot.hasThumbnail,
        lyric: simMedia.snapshot.lyricLine,
        primaryColor: simMedia.snapshot.primaryColor
          ? [simMedia.snapshot.primaryColor.x, simMedia.snapshot.primaryColor.y, simMedia.snapshot.primaryColor.z]
          : null,
      });
      // 手动覆写快照字段并立即广播（验证「换歌 → 文字/封面/唱针」链路用）
      (window as unknown as Record<string, unknown>).__mediaSet = (patch: Record<string, unknown>) => {
        Object.assign(simMedia.snapshot, patch || {});
        const evts = media.diffMediaEvents(lastMediaSnap, simMedia.snapshot);
        for (const { name, event } of evts) for (const sb of mediaHooks) sb.callMedia(name, event);
        lastMediaSnap = media.cloneMediaSnapshot(simMedia.snapshot);
        return (window as unknown as Record<string, () => unknown>).__mediaStats();
      };
      const dispatchMediaNow = () => {
        const evts = media.diffMediaEvents(lastMediaSnap, simMedia.snapshot);
        for (const { name, event } of evts) {
          for (const sb of mediaHooks) {
            try {
              sb.callMedia(name, event);
            } catch {
              /* 单个坏脚本不能打断切歌广播 */
            }
          }
        }
        lastMediaSnap = media.cloneMediaSnapshot(simMedia.snapshot);
      };
      const mediaControl = {
        snapshot: simMedia.snapshot,
        skipNext: () => {
          simMedia.skipNext();
          dispatchMediaNow();
          return simMedia.snapshot;
        },
        skipPrevious: () => {
          simMedia.skipPrevious();
          dispatchMediaNow();
          return simMedia.snapshot;
        },
        play: () => {
          simMedia.play();
          dispatchMediaNow();
          return simMedia.snapshot;
        },
        pause: () => {
          simMedia.pause();
          dispatchMediaNow();
          return simMedia.snapshot;
        },
        playPause: () => {
          simMedia.playPause();
          dispatchMediaNow();
          return simMedia.snapshot;
        },
      };
      (window as unknown as Record<string, unknown>).__mediaControl = mediaControl;
      (window as unknown as Record<string, unknown>).__system = {
        media: mediaControl,
        windowTitle: simWindow.snapshot,
        shortcuts: shortcuts.last,
      };

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
              reportDiag(rt, cfg, `engine 定时器回调抛错（此后同类静默）: ${String((e as Error)?.message || e).slice(0, 90)}`);
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

      const textures = new Map<string, any>();
      textures.set("util/white", {
        glTex: rnd.makeTexture(renderer.gl, new Uint8Array([255, 255, 255, 255]), 1, 1),
        width: 1,
        height: 1,
        rg88: false,
      });
      textures.set("util/noflow", {
        glTex: rnd.makeTexture(renderer.gl, new Uint8Array([127, 127, 127, 255]), 1, 1),
        width: 1,
        height: 1,
        rg88: false,
      });
      textures.set("util/noise", {
        glTex: rnd.makeTexture(renderer.gl, noise.generateNoiseTexture(), 256, 256),
        width: 256,
        height: 256,
        rg88: false,
        mips: null,
      });

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
        if (tracks.length) {
          textures.set("$mediaThumbnail", mkThumb(tracks[0]));
          textures.set("$mediaPreviousThumbnail", mkThumb(tracks[tracks.length - 1]));
        }
      }

      const texInflight = new Map<string, Promise<any | null>>();
      const loadTexInner = async (name: string): Promise<any | null> => {
        if (textures.has(name)) return textures.get(name);
        const texEntry = pkg.getEntry(parsedPkg, `materials/${name}.tex`);
        if (!texEntry) {
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
              };
              textures.set(name, genEntry);
              return genEntry;
            }
          }
          return null;
        }
        const parsedTex = tex.parseTex(texEntry);
        const m = tex.decodeMip0(parsedTex);
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
            reportDiag(rt, cfg, `video tex '${name}': ${pair.active.videoWidth}x${pair.active.videoHeight}`);
          });
          pair.active.addEventListener("error", () => {
            reportDiag(rt, cfg, `video tex '${name}' ERROR: ${pair.active.error?.code}`);
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
              reportDiag(rt, cfg, `video tex '${name}' loop swap ok x${texSwapCount}`);
            }
          };
          pair.onFallback = () => {
            reportDiag(rt, cfg, `video tex '${name}' loop fallback (native loop used)`);
          };
          textures.set(name, entry);
          return entry;
        } else if (m.png !== undefined || (m.image !== undefined && m.fif === tex.FIF.JPEG)) {
          const blob = new Blob([(m.png || m.image) as BlobPart], {
            type: m.png ? "image/png" : "image/jpeg",
          });
          const bmp = await createImageBitmap(blob);
          entry = {
            glTex: rnd.makeTexture(renderer.gl, null, 0, 0, bmp),
            width: bmp.width,
            height: bmp.height,
            rg88,
          };
        } else if (m.image !== undefined) {
          return null;
        } else {
          const m0 = tex.decodeMip0(parsedTex) as { width: number; height: number; rgba: Uint8Array };
          entry = {
            glTex: rnd.makeTextureMip(renderer.gl, [m0], rg88),
            width: m0.width,
            height: m0.height,
            rg88,
            mips: [m0],
          };
        }
        if (!entry) return null;
        // 序列帧表（.tex 的 TEXS 段）：粒子与序列帧图层据此切 sprite sheet。
        // 没有它就只能按 sequencemultiplier 猜 N×N 方格，对横排/竖排 sheet 会采错图块。
        //
        // 挂**整个 frames 对象**（含 atlasWidth/Height）而不只是 list：帧矩形的
        // 归一化分母必须是图集真实像素尺寸。1444077782 的 .tex 头部声明 316x214
        // （那是单帧尺寸），mip0 实为 2048x1024 —— 用错分母整表错位。
        // 粒子端历史上只吃数组，故保留 list 别名兼容（见 particles.js）。
        if (parsedTex.frames?.list?.length) {
          const fl = parsedTex.frames.list as unknown[];
          // 分母跟实际上传尺寸走，不跟 parseTex 的 mip0 声明走：有 TEXS 时
          // decodeMip0 不再裁 POT 填充，entry.width 就是采样用的图集大小。
          (fl as unknown as Record<string, unknown>).atlasWidth = entry.width;
          (fl as unknown as Record<string, unknown>).atlasHeight = entry.height;
          entry.frames = fl;
        }
        textures.set(name, entry);
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
              material = JSON.parse(readText(matEntry));
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
          // [we-scene patch] 序列帧图层：material 的 combos 里 spritesheet=1 表示这张
          // 贴图是 sprite sheet，图层的 size 是**单帧尺寸**，渲染时只该采样当前那一格
          // （帧表来自 .tex 的 TEXS 段，见 loadTex 里 entry.frames）。
          // 不置这个标志的话整张 sheet 会铺满 quad —— 3250755486 的猫在碎玻璃后
          // 显示成 6x7 贴图网格而非逐帧动画。全库 52 层 / 7 壁纸。
          //
          // combo 键名**大小写两种写法都存在**：3250755486/3299228616 用 `SPRITESHEET`，
          // 3292361861/3790527023/1444077782 用小写 `spritesheet`。只认大写会漏掉
          // 后三个壁纸的 12 层（含全部开关按钮）。
          if (pass?.combos) {
            for (const k of Object.keys(pass.combos)) {
              if (k.toLowerCase() === "spritesheet" && Number(pass.combos[k]) === 1) {
                (layer as any).spriteSheet = true;
                break;
              }
            }
          }
          // 图层材质可能有多槽（flowimage = background + flowmask）。只载 [0]
          // 会让流水 shader 的 g_Texture1 落到白纹理，位移恒 0，星云完全不动。
          for (let si = 0; si < texSlots.length; si++) {
            const tn = texSlots[si];
            if (typeof tn !== "string" || !tn || tn.startsWith("util/") || tn.startsWith("_rt_")) continue;
            texJobs.push(
              loadTex(tn).then((entry) => {
                if (!entry) return;
                if (si === 0) {
                  layer.textureName = tn;
                  loadedTex++;
                  if (entry.videoCtl) (layer as any).videoCtl = entry.videoCtl;
                }
              }),
            );
          }
          // [we-scene patch] pkg 里的图层材质 shader（非 genericimage*）挂进效果链。
          // 833227004 / 820654165 的「会动」写在 flowimage，不在 scene.effects。
          if (pass?.shader && pkg.getEntry(parsedPkg, `shaders/${pass.shader}.frag`)) {
            eff.attachLayerMaterialEffect(layer, pass);
          }
          for (const e of layer.effects || []) {
            eff.resolveEffectChain(parsedPkg, e, readText);
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
              eff.resolveEffectChain(parsedPkg, e, readText);
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

      // 可见层上的视频纹理才自动起播（WE 默认）。隐藏层（2887099508 安全模式
      // 盖屏视频）等脚本 getVideoTexture().play()；一加载就 play 会被双元素
      // 预热/切壁纸 pause 打断，日志刷 AbortError。
      for (const [texName, texEntry] of textures) {
        if (!texEntry?.videoCtl) continue;
        const usedVisible = (scene.layers as any[]).some(
          (l) => l.textureName === texName && l.visible && !l.destroyed,
        );
        if (usedVisible && !rt.paused) texEntry.videoCtl.play();
      }

      // ---- 粒子系统（particle 图层）----
      // 加载粒子模型 json + 材质 + 贴图，构造 ParticleSystem，注入 renderer。
      //
      // 贴图有两个来源：pkg 内嵌（工坊自制素材）与 WE 内置资源。后者（particle/halo、
      // particle/fog/fog1 …）不在 pkg 里 —— 全库 33 张被引用的粒子贴图有 24 张属于
      // 内置资源。没有 WE 安装目录可回退，故用 particle-textures.js 按名字语义
      // 程序化生成近似素材，否则整个粒子系统无贴图可用、只能整体跳过。
      const particleSystems: any[] = [];
      // 按图层 id 索引粒子系统，用于逐层渲染（而非全部堆在最后）。
      // 子发射器（children）继承父图层的 layer.id，同一场景层的所有粒子系统在此分组。
      const particleSystemsByLayer = new Map<number, any[]>();
      let builtinTexCount = 0;

      // 取粒子贴图：先查 pkg，缺失则程序化生成（生成结果并入 textures 缓存复用）
      const loadParticleTex = async (name: string): Promise<any | null> => {
        const inPkg = await loadTex(name);
        if (inPkg) return inPkg;
        const gen = ptex.buildBuiltinParticleTexture(name);
        if (!gen) return null;
        const entry = {
          glTex: rnd.makeTextureMip(renderer.gl, [gen], false),
          width: gen.width,
          height: gen.height,
          rg88: false,
          mips: [gen],
          generated: true,
        };
        textures.set(name, entry);
        builtinTexCount++;
        return entry;
      };
      // 官方 Refract 槽 1 必须是法线。材质有时把反照率填进槽 1（particle/drop 等），
      // 白 RGB 不能当 DXT5nm/标准法线用，要按 alpha 转 bump。
      const asParticleNormal = (entry: any) => {
        if (!entry) return null;
        const pix = entry.mips && entry.mips[0];
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
          reportDiag(rt, cfg, `particle '${particlePath}' 不在 pkg，跳过`);
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
            const mat = JSON.parse(readText(matEntry));
            ps.setMaterial(mat);
            const slots = mat?.passes?.[0]?.textures || [];
            texName = slots[0] || null;
            texName1 = slots[1] || null;
          }
        }
        // 材质缺失或未声明贴图时，用通用光晕兜底（宁可近似也不整层消失）
        const te = await loadParticleTex(texName || "particle/halo");
        if (!te) {
          reportDiag(rt, cfg, `particle '${particlePath}' 无贴图可用，跳过`);
          return null;
        }
        ps.setTexture({ glTex: te.glTex, width: te.width, height: te.height, frames: te.frames });
        // 官方：Refract / Lighting 开启后才有法线槽。槽 1 缺失时按反照率名推断
        // （drop → drop_normal）；空白 albedo 没有法线就会画成白方块。
        const nrmName = texName1 || (ps.refract ? ptex.particleNormalNameForAlbedo(texName || "particle/halo") : null);
        if (nrmName) {
          const nrm = asParticleNormal(await loadParticleTex(nrmName));
          if (nrm) ps.setNormalTexture({ glTex: nrm.glTex, width: nrm.width, height: nrm.height });
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
          const childPs = await buildParticleSystem(
            ch.name,
            childLayer,
            ch.instanceoverride || override,
            depth + 1,
          );
          if (childPs && followMode) {
            childPs.attachFollow(ps, followMode, [
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
            reportDiag(rt, cfg, `particle '${layer.name}' FAIL: ${(e as Error).message.slice(0, 80)}`);
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
                void au.play().catch(() => {});
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
              },
              isPlaying: () => !au.paused && !au.ended,
              getVolume: () => au.volume,
              setVolume: (v: number) => {
                au.volume = Math.max(0, Math.min(1, v));
              },
            };
            if (!layer.soundprops?.startsilent && !rt.paused) {
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
      // 提供 setVolume 控制（含 muted 切换）
      const setSceneVolume = (vol: number) => {
        for (const au of soundAudios) {
          au.volume = Math.max(0, Math.min(1, vol));
          au.muted = vol <= 0;
        }
      };
      rt.sceneAudio = { setVolume: setSceneVolume, audios: soundAudios };
      if (disposed) return;
      // 粒子每帧推进 + 按图层渲染（在场景图层迭代的正确 z 序位置渲染）。
      // 不再「全部堆在最后」—— advance 在渲染器图层迭代前统一推进，render 按 layer.id 分发。
      let lastPt = performance.now();
      let particleDiagFrame = 0;
      renderer.setParticleRenderer(
        // advanceFn：每帧推进所有粒子系统（在图层迭代前统一调用）
        () => {
          const now = performance.now();
          // dt 封顶 50ms：标签页切回或掉帧时的大 dt 会让粒子瞬移一大段
          const pdt = Math.min(0.05, (now - lastPt) / 1000);
          lastPt = now;
          // 世界指针位置：locktopointer 的控制点用它做吸引/排斥（controlpointattract）。
          if (pointerSrc.state.has) {
            const { wx, wy, originY } = pointerSrc.state;
            const py = originY != null ? originY : wy;
            for (const ps of particleSystems) ps.setPointer(wx, py);
          }
          for (const ps of particleSystems) ps.advance(pdt, audioSim.enabled ? simAudio.snapshot : null);
          // 首帧后上报一次实际存活粒子数
          if (particleDiagFrame < 2) {
            particleDiagFrame++;
            if (particleDiagFrame === 2) {
              const live = particleSystems.reduce((s, ps) => s + ps.liveCount(), 0);
              reportDiag(rt, cfg, `particles live: ${live} across ${particleSystems.length} systems`);
            }
          }
        },
        // renderByLayerFn：按图层 id 渲染该层对应的粒子系统。
        // cam.projW/projH 必须透传：particles.render 用 projH 做世界 y 向下 → 投影空间的翻转。
        (layerId: number, cam: any, viewProj: any, w: number, h: number) => {
          if (layerId === undefined) return;
          const list = particleSystemsByLayer.get(layerId);
          if (!list) return;
          for (const ps of list) ps.render(viewProj, w, h, cam.projW, cam.projH);
        },
      );
      reportDiag(rt,
        cfg,
        `particles: ${particleSystems.length} systems, ${builtinTexCount} builtin tex generated`,
      );
      // 调试出口：测试台/控制台可读粒子系统状态（存活数、世界包围盒、尺寸区间），
      // 用于确认粒子真的落在可见区域内、尺寸量级合理，而不是堆在原点或大到糊屏。
      (window as unknown as Record<string, unknown>).__particleStats = () =>
        particleSystems.map((ps) => {
          let live = 0;
          let minX = Infinity;
          let maxX = -Infinity;
          let minY = Infinity;
          let maxY = -Infinity;
          let minS = Infinity;
          let maxS = -Infinity;
          for (const p of ps.pool) {
            if (!p.alive) continue;
            live++;
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
            live,
            max: ps.maxCount,
            blend: ps.blend,
            renderer: ps.renderers.map((r: any) => r.kind).join("+"),
            origin: [Math.round(ps.originX), Math.round(ps.originY)],
            bbox: live ? [Math.round(minX), Math.round(minY), Math.round(maxX), Math.round(maxY)] : null,
            size: live ? [Math.round(minS), Math.round(maxS)] : null,
          };
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
            reportDiag(rt, cfg, `puppet '${layer.name}' 无贴图，跳过`);
            continue;
          }
          layer.puppet = mdlObj;
          mdlItems.push({ mdl: mdlObj, tex: texObj, layer });
          const an = mdlObj.animations[0];
          reportDiag(rt,
            cfg,
            `puppet '${layer.name}' v=${mdlObj.vertexCount} bones=${mdlObj.bones.length}` +
              (an ? ` anim='${an.name}' ${an.fps}fps×${an.frameCount}` : " 无动画"),
          );
        } catch (e) {
          console.warn(`puppet 图层 ${layer.name} 加载失败: ${(e as Error).message}`);
          reportDiag(rt, cfg, `puppet '${layer.name}' 失败: ${(e as Error).message}`);
        }
      }
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
          let texName: string | null = null;
          if (mdlObj.materialPath) {
            const matEntry = pkg.getEntry(parsedPkg, mdlObj.materialPath);
            if (matEntry) {
              const material = JSON.parse(readText(matEntry));
              const tex = material?.passes?.[0]?.textures?.[0];
              if (typeof tex === "string" && tex) texName = tex;
            }
          }
          if (texName) {
            await loadTex(texName);
            layer.textureName = texName;
          }
          const texObj = texName ? textures.get(texName) : null;
          if (!texObj) {
            reportDiag(rt, cfg, `model '${layer.name}' 无贴图，跳过`);
            continue;
          }
          layer.puppet = mdlObj;
          mdlItems.push({ mdl: mdlObj, tex: texObj, layer });
          reportDiag(rt,
            cfg,
            `model '${layer.name}' v=${mdlObj.vertexCount} static ${mdlObj.materialPath || ""}`,
          );
        } catch (e) {
          console.warn(`model 图层 ${layer.name} 加载失败: ${(e as Error).message}`);
          reportDiag(rt, cfg, `model '${layer.name}' 失败: ${(e as Error).message}`);
        }
      }
      let mdlRenderer: any = null;
      if (mdlItems.length > 0) {
        try {
          mdlRenderer = mdl.createMDLRenderer(renderer.gl);
          for (const item of mdlItems) mdlRenderer.upload(item.mdl);
          // 注入绘制回调：renderer 在图层循环里按 z 序调用
          const byLayer = new Map<any, { mdl: any; tex: any; layer: any }>();
          for (const item of mdlItems) byLayer.set(item.layer, item);
          renderer.setPuppetRenderer((layer: any, mvp: any, o: any) => {
            const item = byLayer.get(layer);
            if (!item) return;
            mdlRenderer.draw(
              mvp,
              item.mdl,
              {
                time: o.time,
                animLayers: layer.animationLayers,
                // [we-scene patch] 脚本层的骨骼平移覆写（thisLayer.setBoneTransform）。
                // 骨骼拖拽壁纸的 puppet 动画数为 0，蒙皮完全由脚本驱动，
                // 所以这个表是它们唯一的形变来源。
                boneOverrides: boneOverridesByLayer.get(layer),
                // [we-scene patch] 效果链输出（贴图空间的合成结果）。
                // 无效果链时为 null，网格照常采样原始贴图。
                overrideTex: o.overrideTex || null,
                color: [
                  layer.color[0] * layer.brightness,
                  layer.color[1] * layer.brightness,
                  layer.color[2] * layer.brightness,
                  layer.alpha,
                ],
              },
              item.tex,
            );
          });
        } catch (e) {
          console.warn(`puppet 渲染器初始化失败: ${(e as Error).message}`);
          reportDiag(rt, cfg, `puppet renderer 失败: ${(e as Error).message}`);
          mdlRenderer = null;
          for (const item of mdlItems) item.layer.puppet = null;
        }
      }
      if (disposed) return;
      reportDiag(rt, cfg, `puppet: ${mdlItems.length} meshes`);

      // ---- puppet 附着点挂件 ----
      // parse 只合并了父 origin + 子 local；MDAT 附着点要等 puppet 装上才能加。
      // 静态：world = 已合并 origin + 绑定姿势附着点，位移传给整棵子孙
      // （空组「头发」自己 size=0，可见的是子层「主发」）。
      // 找不到名字则保持普通父子合并。
      // 逐帧：origin = base + (当前附着点 − 绑定附着点)，挂件随骨摆。
      const attachFollows = mdl.applyAttachmentBindOrigins(scene.layers);
      if (attachFollows.length) {
        reportDiag(rt, cfg, `attachments: ${attachFollows.length} hanging layers`);
      }

      // ---- 文字对象 / 组件挂件（时钟、日期、星期等动态文本）----
      // 文字渲到离屏 2D canvas → GL 纹理 → 挂回图层本身（textureName），以**普通图层身份**
      // 进入渲染管线：z 序与图片层一致、可走效果链/混合/视差。旧 2D overlay 方案永远
      // 叠在所有图层之上，z 序错误，已废弃。
      // 纯逻辑（脚本沙箱求值 / 盒内排版 / 绘制）在 vendor we-scene render/text.js，
      // 可被 scripts/verify-text.mjs 在 node 里对全库脚本离线校验。
        const textWidgets: any[] = [];
        const textLayerText = new Map<string, string>(); // 层名 → 当前文本（thisScene.getLayer 跨层读）
        const textShared: Record<string, unknown> = {}; // 同场景文字脚本共享状态（WE shared 全局）
      let textCanvas: HTMLCanvasElement | null = null;
      let textCtx: CanvasRenderingContext2D | null = null;
      let textEvalDue = 0; // 求值节流（时钟类脚本 1s 粒度，100ms 足够）
      if (!SKIP_TEXT && scene.layers.some((l: any) => l.isText)) {
        const ortho = (scene as any).general?.orthogonalprojection;
        const projW = ortho?.width || c.width;
        const projH = ortho?.height || c.height;
        // 文字纹理质量系数 = 画布像素 / 可见世界像素：让文字的像素密度与最终显示一致。
        // 封顶 [0.5, 3] 并限单边 2048，防「超大盒子 × 高 DPR」把显存吃爆。
        const win0 = fitWindow(normalizeFit(rt.cfg.fit), projW, projH, c.width, c.height);
        const quality = Math.min(3, Math.max(0.5, c.width / Math.max(1, win0.viewW)));
        // 用户属性：与对象脚本 / 效果常量共用 liveUserProps（见 parseScene 之后）
        // 字体：pkg 内嵌 ttf/otf → FontFace（跨重挂缓存）；systemfont_* → 系统字体栈
        const fontFamilies = new Map<string, string>(); // fontPath → CSS family
        const fontPaths = new Set<string>();
        for (const l of scene.layers as any[]) if (l.isText && l.textFont) fontPaths.add(l.textFont);
        // 脚本可能在 applyUserProperties 里把 font 切到包内其它字体（3396722575 有 18 个）。
        // 只预载层快照路径的话，切档时 FontFace 不存在，字形回落成系统黑体。
        for (const e of (parsedPkg as { entries?: Array<{ name: string }> }).entries || []) {
          if (typeof e.name === "string" && /^fonts\/.+\.(ttf|otf|woff2?)$/i.test(e.name)) fontPaths.add(e.name);
        }
        for (const fp of fontPaths) {
          const cached = fontFaceCache.get(`${cfg.src}|${fp}`);
          if (cached) {
            fontFamilies.set(fp, cached);
            continue;
          }
          const sys = SYSTEM_FONT_FAMILIES[fp.toLowerCase()];
          if (sys) {
            fontFamilies.set(fp, sys);
            continue;
          }
          try {
            const fe = pkg.getEntry(parsedPkg, fp);
            if (!fe) continue;
            // Chrome OTS 拒载 cmap rangeShift 写错的 Tourner 等；先修再喂 FontFace。
            const bytes = sanitizeFontForBrowser(
              fe instanceof Uint8Array ? fe : new Uint8Array(fe as ArrayBuffer),
            );
            const fam = "wefont_" + fp.split("/").pop()!.replace(/[^a-zA-Z0-9]/g, "_");
            const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
            const ff = new FontFace(fam, `url(${url})`);
            await ff.load();
            document.fonts.add(ff);
            (rt.objectUrls ??= []).push(url);
            fontFamilies.set(fp, fam);
            fontFaceCache.set(`${cfg.src}|${fp}`, fam);
          } catch (e) {
            console.warn(`字体加载失败 ${fp}: ${(e as Error).message}`);
          }
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
                text: layer.text ?? "",
                font: layer.textFont || "",
                pointsize: layer.textPointsize,
                color: layer.textColor,
                angles: layer.angles,
                origin: layer.origin,
                scale: layer.scale,
                visible: layer.visible,
                canvasSize: { width: projW, height: projH },
                userProperties: liveUserProps,
                shared: textShared,
                audioViews,
                inputView,
                // [we-scene patch] 文字脚本此前没有真定时器（no-op stub），
                // 与对象/效果开关/常量/general 统一走 engineTimers（P1-1）。
                ...timerOpts,
                mediaControl,
                windowTitle: simWindow.snapshot,
                openUserShortcut: shortcuts.openUserShortcut,
                getLayerText: (name: string) => textLayerText.get(name),
                onError: (e: unknown) => {
                  reportDiag(rt, cfg, `text script '${layer.name}' 失败: ${String((e as Error).message || e).slice(0, 120)}`);
                },
              });
              if (item.sandbox) {
                propSandboxes.push(item.sandbox);
                item.sandbox.init();
                item.sandbox.applyUserProperties(liveUserProps);
                // [we-scene patch] 歌名/歌手文字层就靠媒体回调拿数据：
                // `export function mediaPropertiesChanged(e){ mediaData = e.title }`
                // 是全库 44 处文字脚本的标准形态。不登记就永远显示作者的占位文本。
                if (item.sandbox.hasMediaHook) registerMediaHook(item.sandbox);
              }
            }
            // 静态文本预置进跨层表（脚本层每帧更新自己的条目）
            textLayerText.set(layer.name || "", String(layer.text ?? ""));
            // anchor ≠ center 时一次性平移 origin，让盒子按锚点贴住原点（世界 y 轴朝上）。
            // 用的是原盒子尺寸 —— 下面立刻把 layer.size 扩成带溢出边距的画布尺寸。
            if (layer.textAnchor !== "center" && layer.size[0] > 0 && layer.size[1] > 0) {
              const hw = (layer.size[0] * (layer.scale[0] || 1)) / 2;
              const hh = (layer.size[1] * (layer.scale[1] || 1)) / 2;
              const a = layer.textAnchor;
              if (a.includes("left")) layer.origin[0] += hw;
              if (a.includes("right")) layer.origin[0] -= hw;
              if (a.includes("top")) layer.origin[1] -= hh;
              if (a.includes("bottom")) layer.origin[1] += hh;
            }
            // 盒子（size）只是定位框，WE 不裁剪溢出文字（halign right 时整行向左长出）。
            // 画布/图层 quad 按盒子四周扩 M，内部盒子位置不变：文字溢出画进边距里。
            // 边距按字号估，不能按层的长边。4708×420 的圆环文字被扩成 6756×2468 后，
            // geometric_transform 的 UV 圆变形作用在近乎方形的透明画布上，丝带塌成直线。
            const em0 = TEXT_EM_SCALE * Math.max(1, layer.textPointsize);
            // tint 蒙版按原盒绘制：扩边一超过几像素，UV 就对不上字形（世界时钟粉条/缺色）。
            const marginCap = wtext.textLayerHasTintMask(layer) ? 8 : 256;
            const margin = Math.min(marginCap, wtext.textCanvasMargin(em0, 0));
            item.boxW = layer.size[0] > 0 ? layer.size[0] : em0 * 4;
            item.boxH = layer.size[1] > 0 ? layer.size[1] : em0 * 1.6;
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
        // 每帧（100ms 节流）：沙箱求值 → 内容变化才重排版/重绘/上传纹理。
        // 求值对全部文字层执行（含隐藏层：World Time 类脚本跨层读它们），绘制只画可见层。
        const updateTexts = (t: number) => {
          if (!textCtx || !textCanvas) return;
          const ctx = textCtx;
          for (const it of textWidgets) {
            const layer = it.layer;
            let content = String(layer.text ?? "");
            if (it.sandbox && it.sandbox.hasUpdate) {
              it.sandbox.engine.runtime = t;
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
            // 脚本可改写 thisLayer.pointsize/text/font；内容、字号、字体都不变才跳过重绘
            const pts = Math.max(1, it.sandbox ? it.sandbox.thisLayer.pointsize : layer.textPointsize);
            const fontPath = (it.sandbox && it.sandbox.thisLayer.font) || layer.textFont || "";
            const key = `${content}\u0000${pts}\u0000${fontPath}\u0000${layer.alpha}\u0000${layer.textCastshadow}`;
            if (it.lastKey === key) continue;
            it.lastKey = key;
            try {
              // 字号语义：WE 的 pointsize 经 TEXT_EM_SCALE 放大后才是场景像素（实测三路
              // 证据：预览图字高、盒子高/pointsize 全库众数、字号滑条 3~5 的量纲）
              const em = TEXT_EM_SCALE * pts;
              const bw = it.boxW;
              const bh = it.boxH;
              const M = it.margin;
              const sx = Math.abs(layer.scale[0] || 1);
              const sy = Math.abs(layer.scale[1] || 1);
              let cw = Math.max(1, Math.round(layer.size[0] * sx * it.quality));
              let ch = Math.max(1, Math.round(layer.size[1] * sy * it.quality));
              const shrink = Math.min(1, MAX_TEX / Math.max(cw, ch));
              cw = Math.max(1, Math.round(cw * shrink));
              ch = Math.max(1, Math.round(ch * shrink));
              if (textCanvas.width !== cw || textCanvas.height !== ch) {
                textCanvas.width = cw;
                textCanvas.height = ch;
              } else {
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                ctx.clearRect(0, 0, cw, ch);
              }
              // 「场景单位 → 画布像素」折进 transform，再平移到内部盒子左上角
              const k = Math.min(cw / layer.size[0], ch / layer.size[1]);
              ctx.setTransform(k, 0, 0, k, 0, 0);
              ctx.translate(M, M);
              const fam = fontPath ? (fontFamilies.get(fontPath) || "sans-serif") : "sans-serif";
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
              }, (s: string) => ctx.measureText(s).width);
              wtext.drawTextLayer(ctx, layout, {
                font: ctx.font,
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
        );
      }
      if (disposed) return;
      // ---- WE 对象脚本（scale/origin/color/alpha/brightness/angles 绑定的脚本）----
      // 经典用法：音频条的 scale 脚本读 registerAudioBuffers 按频段改写 scale.y
      // （3078285611 底部 11 根音条即此）。逐帧求值，出错熔断回退字段静态快照。
      const objectScriptRuns: Array<{ layer: any; field: string; kind: "vec3" | "scalar" | "bool"; sandbox: any }> = [];
      // 关键帧动画：逐帧推进并把结果写回图层字段
      const animRuns: Array<{ layer: any; field: string; ctrl: any }> = [];
      const generalAnimRuns: Array<{ field: string; ctrl: any; write: (v: unknown) => void }> = [];
      const sceneNamedAnims: Record<string, any> = {};
      // 效果开关脚本（effects[i].visible.script）：逐帧决定该效果是否参与渲染
      const effectVisibleRuns: Array<{ effect: any; sandbox: any }> = [];
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
          getInitialLayerConfig: (arg: any) => {
            const name = arg && typeof arg === "object" ? arg.name : String(arg || "");
            return (scene.layers as any[]).find((l) => l.name === name) || null;
          },
          createSceneLayer: (layerCfg: any) => {
            // 字符串 = 已解析的模型路径（makeThisScene 已按 __workshopId 展开）。
            // 克隆同 image 的已装配层（含 textureName / layerMaterial 效果），
            // 否则会得到无贴图空层 —— 3789604238 Simple Visualizer 的 63 根克隆条。
            let src: any = layerCfg && typeof layerCfg === "object" ? layerCfg : null;
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
                reportDiag(
                  rt,
                  cfg,
                  `createLayer('${imagePath}') 找不到已加载的同模型层`,
                );
                return null;
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
            return clone;
          },
          mediaControl,
          windowTitle: simWindow.snapshot,
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
          inputView,
          // [we-scene patch] 效果常量的延时逻辑（全库 8 处）。renderer 侧
          // setConstantScriptRuntime 只提取白名单字段，timers 单独透传。
          timers: engineTimers,
          ...sceneApi,
          onSandbox: (sb: any) => {
            if (sb && sb.hasMediaHook) registerMediaHook(sb);
          },
        });
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
              const live = (layer as any)[field];
              ctrl.baseNumeric = Array.isArray(live) ? live.slice() : live;
              layer.animationList.push(ctrl);
              if (ctrl.name) layer.animations[ctrl.name] = ctrl;
              animRuns.push({ layer, field, ctrl });
            } catch (e) {
              reportDiag(rt, cfg, `animation '${layer.name}.${field}' 建控制器失败: ${String((e as Error).message).slice(0, 80)}`);
            }
          }
        }
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
                onError: (e: unknown) =>
                  reportDiag(rt, cfg, `effect visible script '${layer.name}#${ei}' 失败: ${String((e as Error).message || e).slice(0, 80)}`),
              });
              if (!sandbox) continue;
              propSandboxes.push(sandbox);
              // WE 语义：init(value) 收到字段的**当前值**（visible 字段 = 布尔）。
              sandbox.init(effect.visible);
              sandbox.applyUserProperties(objUserProps);
              if (sandbox.hasMediaHook) registerMediaHook(sandbox);
              if (sandbox.hasUpdate) effectVisibleRuns.push({ effect, sandbox });
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
                timeOfDay: (() => {
                  const d = new Date();
                  return (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) / 86400;
                })(),
                userProperties: objUserProps,
                audioViews,
                inputView,
                // thisLayer / thisScene.getLayer：拖拽类回调靠它们写回图层
                layer,
                ...sceneApi,
                // 骨骼 API 的覆写表（按图层）
                getBoneOverrides,
                shared: textShared,
                // [we-scene patch] WE 的 engine.setTimeout 返回**取消函数**句柄：
                // 语料写 `lastHideEvent = engine.setTimeout(...)` 之后
                // `lastHideEvent()` 直接调用它来取消（3790189808 的延时隐藏封面）。
                // 五个 eval 点统一走 engineTimers（SCENESCRIPT-PLAN P1-1），
                // 句柄语义与卸载 dispose 见 render/engine-timers.js。
                ...timerOpts,
                onError: (e: unknown) =>
                  reportDiag(rt, cfg, `object script '${layer.name}.${field}' 失败: ${String((e as Error).message || e).slice(0, 90)}`),
              });
              if (sandbox) {
                propSandboxes.push(sandbox);
                // WE 语义：init(value) 收到字段的**当前值**。向量字段（scale/origin/
                // angles）在 WE 里是带 .x/.y/.z 的对象，本仓图层用数组存储——
                // 这里包成同形对象；标量/布尔字段原样传。
                // 此前 init() 无参调用，所有 `init(value){ initialValue = value.x }`
                // 形态的脚本（3264246690 的月亮/时间/三条胶带音频缩放，全库音频
                // 可视化模板的标准写法）都会在 init 里 TypeError 熔断。
                const fieldVal = (layer as any)[field];
                // SceneScript 的 angles 是角度，图层数组是弧度。init(value) 必须同形，
                // 否则 `initialValue = value.z` 拿到的是弧度，滑条（°）脚本会整圈乱转。
                const initArg = field === "angles" && Array.isArray(fieldVal)
                  ? wtext.radToScriptAngles(fieldVal)
                  : Array.isArray(fieldVal)
                    ? { x: fieldVal[0] ?? 0, y: fieldVal[1] ?? 0, z: fieldVal[2] ?? 0 }
                    : fieldVal;
                sandbox.init(initArg);
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
                // 只有真的导出了 update 的脚本才进逐帧字段求值队列。
                // 纯 cursor 交互脚本（拖拽类）没有 update，进队列只会每帧白跑一次。
                if (sandbox.hasUpdate) {
                  objectScriptRuns.push({
                    layer,
                    field,
                    kind: field === "visible"
                      ? "bool"
                      : field === "alpha" || field === "brightness"
                        ? "scalar"
                        : "vec3",
                    sandbox,
                  });
                }
              }
            } catch (e) {
              console.warn(`对象脚本 ${layer.name}.${field} 求值失败: ${(e as Error).message}`);
            }
          }
        }
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
                userProperties: objUserProps,
                audioViews,
                inputView,
                ...timerOpts,
                ...sceneApi,
                shared: textShared,
                onError: (e: unknown) =>
                  reportDiag(rt, cfg, `general script '${field}' 失败: ${String((e as Error).message || e).slice(0, 80)}`),
              });
              if (!sandbox) continue;
              propSandboxes.push(sandbox);
              sandbox.init(def.value);
              sandbox.applyUserProperties(objUserProps);
              if (sandbox.hasMediaHook) registerMediaHook(sandbox);
              const write = (v: unknown) => writeGeneralField(field, v);
              if (sandbox.hasUpdate) generalScriptRuns.push({ field, sandbox, write });
            } catch (e) {
              console.warn(`general 脚本 ${field} 求值失败: ${(e as Error).message}`);
            }
          }
          if (generalScriptRuns.length) {
            reportDiag(rt, cfg, `general scripts: ${generalScriptRuns.map((r) => r.field).join(",")}`);
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
              reportDiag(rt, cfg, `general animation '${field}' 建控制器失败: ${String((e as Error).message).slice(0, 80)}`);
            }
          }
          if (generalAnimRuns.length) {
            reportDiag(rt, cfg, `general animations: ${generalAnimRuns.map((r) => r.field).join(",")}`);
          }
        }
      }
      if (objectScriptRuns.length) {
        reportDiag(rt, cfg, `object scripts: ${objectScriptRuns.length}`);
        // 调试出口：读/改对象脚本的实时字段值（音条 scale 等）
        (window as unknown as Record<string, unknown>).__objScripts = objectScriptRuns;
      }
      // 调试出口：媒体广播表（排查「回调登记了没 / 派发到了没」）
      (window as unknown as Record<string, unknown>).__mediaHooks = mediaHooks;
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

      // ---- WE 指针回调派发（cursorEnter/Leave/Move/Down/Up/Click）----
      // 全库 267 处挂钩 / 19 壁纸，是 WE 场景互动的主入口。
      // 命中判定用 OBB（render/hittest.js），几何与 layerModelMatrix 逐字一致。
      const cursorLayers = Array.from(cursorHooks.keys());
      if (cursorLayers.length) {
        reportDiag(rt, cfg, `cursor hooks: ${cursorLayers.length} layers`);
      }
      let hoveredLayer: any = null;
      let pressedLayer: any = null;
      let lastLeftDown = false;
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
        const par = renderer.getParallaxOffset ? renderer.getParallaxOffset() : { x: 0, y: 0 };
        const projH = (scene as any).general?.orthogonalprojection?.height || c.height;
        const hit = hitTest.hitTestLayers(scene.layers, p.wx, p.wy, projH, {
          parOffX: par.x,
          parOffY: par.y,
          alignTable: rnd.ALIGN,
          // 只在挂了回调的图层里找命中 —— 否则上方任何一个全屏背景层都会把
          // 指针「挡住」，下方真正的交互层永远收不到 enter。
          filter: (l: any) => cursorHooks.has(l),
        });
        const ev = makeCursorEvent();
        // enter / leave：命中层变化时成对派发
        if (hit !== hoveredLayer) {
          if (hoveredLayer) fire(hoveredLayer, "cursorLeave", ev);
          hoveredLayer = hit;
          if (hit) fire(hit, "cursorEnter", ev);
        }
        // move：命中层内每帧派发（拖拽脚本需要连续位置）
        if (hit) fire(hit, "cursorMove", ev);
        // down / up / click
        if (p.leftDown && !lastLeftDown) {
          pressedLayer = hit;
          if (hit) fire(hit, "cursorDown", ev);
        } else if (!p.leftDown && lastLeftDown) {
          if (pressedLayer) fire(pressedLayer, "cursorUp", ev);
          // click 只在「按下与松开落在同一层」时派发 ——
          // 否则从层内按下、拖到层外松手也会误触发一次点击。
          if (pressedLayer && pressedLayer === hit) fire(hit, "cursorClick", ev);
          pressedLayer = null;
        }
        lastLeftDown = p.leftDown;
      };

      const start = performance.now();
      let pauseAccum = 0;
      let pauseStarted = 0;
      const playingVideos: Array<{ play: () => void }> = [];
      const playingAudios: HTMLAudioElement[] = [];
      let lastRender = -Infinity;
      const renderLoop = (now: number) => {
        if (disposed || rt.paused) return;
        // 帧率上限：比目标帧更快的帧直接跳过（不渲染、只继续排队），降低 GPU 占用。
        const fps = rt.cfg.sceneFps || 60;
        const interval = 1000 / fps;
        if (now - lastRender >= interval) {
          lastRender = now;
          markFrame(rt, now);
          // 库化桥接：首帧真正提交渲染 → resolve mount() 的 Promise（一次性）
          if (rt.onFirstFrame) {
            const first = rt.onFirstFrame;
            rt.onFirstFrame = undefined;
            first();
          }
          syncCanvasSize(rt, c, rt.cfg);
          const t = (now - start - pauseAccum) / 1000;
          // 指针 last 在本帧 render 完成后再推进（见下方 then）。事件驱动下
          // rAF 之间的 mousemove 已经更新了 current；若在消费前 last=current，
          // cursorripple 的 v_PointDelta.x 恒为 0，涟漪完全不触发。
          // 脚本 input 视图就地重填（世界坐标是上一帧 render 里 syncWorld 算的，
          // 首帧为初值；与 audioViews 慢一帧的既有行为一致）
          inputView.update(pointerSrc.state);
          // [we-scene patch] 模拟媒体源推进 + **变化时才派发**回调。
          // 放在对象脚本求值之前：媒体回调常改写 visible/文本/动画播放头，
          // 这些改动应当在本帧的字段求值与渲染里立即生效。
          if (mediaSim.enabled) {
            simMedia.update(t);
            const evts = media.diffMediaEvents(lastMediaSnap, simMedia.snapshot);
            if (evts.length) {
              for (const { name, event } of evts) {
                for (const sb of mediaHooks) {
                  if (sb.disabled) continue;
                  sb.callMedia(name, event);
                }
              }
              lastMediaSnap = media.cloneMediaSnapshot(simMedia.snapshot);
            }
          }
          simWindow.update(t);
          // [we-scene patch] 关键帧动画推进并写回字段。必须在对象脚本**之前**：
          // 同一字段上两者可以并存（全库 44 处），语义是脚本控制播放头、
          // 动画产出值，脚本的 update 返回值优先级更高。
          for (const run of animRuns) {
            run.ctrl.advance(interval / 1000);
            const field = run.field;
            const out = run.ctrl.applyTo(run.ctrl.baseNumeric);
            if (Array.isArray(out)) {
              const cur = run.layer[field];
              if (Array.isArray(cur)) for (let i = 0; i < out.length && i < cur.length; i++) cur[i] = out[i];
            } else if (Number.isFinite(out)) {
              if (field === "visible") run.layer[field] = !!out;
              else run.layer[field] = out;
            }
          }
          for (const run of generalAnimRuns) {
            run.ctrl.advance(interval / 1000);
            const out = run.ctrl.applyTo(run.ctrl.baseNumeric);
            if (typeof out === "number" && Number.isFinite(out)) run.write(out);
            else if (Array.isArray(out) && Number.isFinite(out[0])) run.write(out[0]);
          }
          // 效果开关脚本逐帧求值（只有明确返回布尔时才写回，同 visible 字段脚本）
          for (const run of effectVisibleRuns) {
            if (run.sandbox.disabled) continue;
            run.sandbox.engine.frametime = interval / 1000;
            run.sandbox.engine.runtime = t;
            const ret = run.sandbox.callUpdate(!!run.effect.visible);
            if (typeof ret === "boolean") run.effect.visible = ret;
          }
          for (const run of generalScriptRuns) {
            if (run.sandbox.disabled) continue;
            run.sandbox.engine.frametime = interval / 1000;
            run.sandbox.engine.runtime = t;
            const g = (scene as any).general || {};
            const cur = g[run.field] && typeof g[run.field] === "object" && "value" in g[run.field]
              ? g[run.field].value
              : g[run.field];
            const ret = run.sandbox.callUpdate(cur);
            if (ret !== undefined) run.write(ret);
          }
          // 对象脚本逐帧求值（音频条 scale 随频谱伸缩等）；dt 封顶同粒子
          const screenRes = { x: c.clientWidth || window.innerWidth || 1, y: c.clientHeight || window.innerHeight || 1 };
          let visibilityDirty = false;
          for (const run of objectScriptRuns) {
            if (run.sandbox.disabled) continue;
            run.sandbox.engine.frametime = interval / 1000;
            run.sandbox.engine.runtime = t;
            run.sandbox.engine.screenResolution = screenRes;
            const cur = run.layer[run.field];
            if (run.kind === "bool") {
              // visible：全库 180 个此类脚本的 value 快照都是 boolean。
              // 只有脚本明确返回布尔时才写回 —— 纯 cursor 交互脚本（71 个，无 update）
              // 的 callUpdate 返回 undefined，此时必须保留图层原可见性，
              // 否则整层会被 undefined 判成隐藏而消失。
              const ret = run.sandbox.callUpdate(!!cur);
              if (typeof ret === "boolean") {
                if (run.field === "visible") {
                  if (run.layer.visibleSelf !== ret) {
                    run.layer.visibleSelf = ret;
                    visibilityDirty = true;
                  }
                } else {
                  run.layer[run.field] = ret;
                }
              }
            } else if (run.kind === "scalar") {
              const ret = run.sandbox.callUpdate(Number(cur) || 0);
              const n = Number(ret);
              if (Number.isFinite(n)) run.layer[run.field] = n;
            } else {
              const v = run.field === "angles"
                ? wtext.radToScriptAngles(cur)
                : { x: cur[0] || 0, y: cur[1] || 0, z: cur[2] || 0 };
              const ret = run.sandbox.callUpdate(v);
              const o = ret && typeof ret === "object" && "x" in (ret as object) ? ret : v;
              run.layer[run.field] = run.field === "angles"
                ? wtext.scriptAnglesToRad(o)
                : [o.x || 0, o.y || 0, o.z || 0];
            }
          }
          if (visibilityDirty) recomputeVisibility();
          // 模拟音频流按场景时间推进（确定性：同 t 同频谱），并重填文字脚本的频谱视图
          if (audioSim.enabled) {
            simAudio.update(t);
            audioMod.fillAudioBuffers(audioViews, simAudio.snapshot);
          }
          // [we-scene patch] 挂件跟随父 puppet 附着点。必须在对象脚本之后、绘制之前：
          // 从绑定姿势的 base origin 重写，加上当前姿势与绑定姿势的差。
          if (attachFollows.length) {
            mdl.followAttachments(attachFollows, t, getBoneOverrides);
          }
          const peek = rt.coverAlign;
          void renderer
            .render(scene, textures, c.width, c.height, t, normalizeFit(rt.cfg.fit), peek.x, peek.y)
            .then(() => {
              if (disposed || rt.paused) return;
              // 指针回调派发放在 render 之后：世界坐标由渲染器在帧内
              // syncWorld(cam, …) 算好（含视差补偿），此时命中判定才与画面一致。
              try {
                dispatchCursor();
              } catch (e) { /* 单个回调出错已在沙箱里熔断，这里兜底不打断渲染 */ }
              // 消费完毕再推进 last：下一帧才能看到「上一帧位置 vs 新位置」。
              pointerSrc.beginFrame();
              try {
                if (rt.sceneTextUpdate && now >= textEvalDue) {
                  textEvalDue = now + 100;
                  rt.sceneTextUpdate(t);
                }
              } catch (e) { /* 文字更新失败忽略 */ }
              rt.raf = requestAnimationFrame(renderLoop);
            })
            .catch((e: Error) => {
              console.warn("scene render error:", e);
              reportDiag(rt, cfg, `render: ${String(e.message || e).slice(0, 200)}`);
              disposed = true;
            });
        } else {
          if (!rt.paused) rt.raf = requestAnimationFrame(renderLoop);
        }
      };
      const kickLoop = () => {
        if (disposed || rt.paused) return;
        if (rt.raf !== undefined) return;
        rt.raf = requestAnimationFrame(renderLoop);
      };
      const applyLiveProps = (wire: Record<string, { value: unknown }>) => {
        if (disposed) return;
        const properties = (scene as any).properties || {};
        const changed = mergeUserPropertyValues(properties, liveUserProps, wire) as Record<string, unknown>;
        if (!Object.keys(changed).length) return;
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
        reportDiag(rt, cfg, `props hot: ${Object.keys(changed).join(",")}`);
      };
      pauseImpl = () => {
        if (rt.raf !== undefined) {
          cancelAnimationFrame(rt.raf);
          rt.raf = undefined;
        }
        if (!pauseStarted) pauseStarted = performance.now();
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
        lastPt = performance.now();
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
        kickLoop();
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
        );
      }
      reportDiag(rt, cfg, `renderer started: ${scene.layers.length} layers`);
    } catch (e) {
      if (disposed) return;
      if (e && (e as Error).name === "AbortError") return;
      // 场景加载/渲染失败：diag 上报 + 降级画布演示
      console.warn("scene render failed:", e);
      const err = e instanceof Error ? e : new Error(String(e));
      reportDiag(rt, cfg, `failed: ${String(err.message || err).slice(0, 200)}`);
      // 库化桥接：公共 API 设了 onError 就交回调用方兜底；
      // 旧路径（壁纸页）维持「失败挂降级页」的既有行为
      if (rt.onError) rt.onError(err);
      else rt.fallbackPage?.();
    }
  })();
}
