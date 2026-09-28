// 媒体壁纸：合成单图层 scene 走 we-scene；无 WebGL2 时回退 DOM。
//
// 按需渲染（静态媒体壁纸不再每帧重绘）
// ------------------------------------
// 图片 / GIF 这类媒体壁纸的全部时变输入只有四项：纹理内容、画布尺寸、fit、
// cover 窥视偏移。四项都不变时，这一帧的输出与上一帧**逐像素相同**
// （实测 image 壁纸 4.8s 内 6 次采样帧差恒为 0，即渲染器侧不依赖场景时间 t），
// 于是每帧走一遍 clear + 全屏光栅化是纯浪费：1920×937 全屏图片壁纸稳态
// 12.5%~18.7% 单核里，绝大部分就是这份重绘。
//
// 三条纪律：
// 1. **不停 rAF 循环，只是不提交渲染**。窥视 lerp 收敛、GIF 换帧、画布尺寸变化、
//    宿主热改 fit 都挂在循环上；而且 frameStats 在 400ms 无帧后会把 running 判成
//    false，停循环会让宿主与测试台以为壁纸出事。收益也不在 rAF 回调上 —— 实测
//    60fps→10fps 就拿到约八成收益，成本在渲染提交。
// 2. **首帧必须提交**（renderedOnce）：渲染器要在首次 render 里建 program/FBO。
// 3. **静止位要如实上报**（rt.renderIdleAt → frameStats().idle）：静止期间没有帧提交，
//    没有这一位就分不清「静止待命」和「暂停/挂了」。
//
// capture 无需改动：本路径保留 preserveDrawingBuffer:true（实测它对 CPU 无影响，
// 见提交记录），画布在静止期间也不被 clear，所以 toDataURL 仍拿到最后一帧。
import { clear, effectiveDpr, fitObjectFit, FrameGate, markFrame, normalizeFit, occlPaused, occlusionCfgOf, reapplyVolume, reportDiag, syncCanvasSize, type Runtime } from "./shell";
import { occlusionFpsCap } from "./occlusion";
import { createLoopingVideo } from "./video-loop";
import { mountWebCodecsVideo, supportsWebCodecsVideo } from "./video-webcodecs";
import type { WallpaperConfig } from "./types";
import { rnd, noise } from "./vendor";

/** 合成单图层场景（fit 语义同 object-fit） */
export function buildMediaScene(width: number, height: number, textureName: string) {
  return {
    camera: null,
    // contain 模式的留边由 clearcolor 填充（对应 DOM 路径里的深色背景）
    general: { orthogonalprojection: { width, height }, clearenabled: true, clearcolor: "0 0 0" },
    layers: [
      {
        id: 0,
        name: "media",
        visible: true,
        image: textureName,
        textureName,
        particle: null,
        puppet: null,
        solid: false,
        isContainer: false,
        isPostProcess: false,
        isText: false,
        isSound: false,
        isComponent: false,
        sound: [],
        // 铺满整个投影：层中心在投影中心、尺寸等于投影尺寸
        origin: [width / 2, height / 2, 0],
        scale: [1, 1, 1],
        angles: [0, 0, 0],
        size: [width, height],
        alignment: "center",
        color: [1, 1, 1],
        alpha: 1,
        brightness: 1,
        colorBlendMode: 0,
        copybackground: false,
        parallaxDepth: null,
        animationLayers: [],
        effects: [],
      },
    ],
    properties: {},
  };
}

/**
 * ImageDecoder 解 GIF 帧（`<img>`/`texImage2D` 只会拿到首帧）。
 * 全帧位图常驻内存；失败则回退静态首帧。
 */
export async function decodeGifFrames(
  src: string,
): Promise<{ width: number; height: number; frames: { bitmap: ImageBitmap; durationMs: number }[] } | null> {
  const resp = await fetch(src);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const dec = new (window as any).ImageDecoder({
    data: await resp.arrayBuffer(),
    type: "image/gif",
  });
  // tracks.ready 先于 completed：轨道未就绪时 selectedTrack 为 null
  await dec.tracks.ready;
  await dec.completed;
  const track = dec.tracks.selectedTrack;
  if (!track || !track.frameCount) return null;
  // 帧数上限：防病态素材（上千帧）把内存吃光；超出部分截断（动画变短，不影响可用）
  const count = Math.min(track.frameCount, 300);
  const frames: { bitmap: ImageBitmap; durationMs: number }[] = [];
  let width = 0;
  let height = 0;
  for (let i = 0; i < count; i++) {
    const { image } = await dec.decode({ frameIndex: i });
    width = image.displayWidth;
    height = image.displayHeight;
    frames.push({
      bitmap: await createImageBitmap(image, { premultiplyAlpha: "none" }),
      // duration 单位是微秒；缺失/为 0 的帧按 GIF 惯例给 100ms
      durationMs: image.duration ? image.duration / 1000 : 100,
    });
    image.close();
  }
  dec.close?.();
  return { width, height, frames };
}

/**
 * 视频壁纸的频谱自动接管：从 <video> 自身的音轨取 64 段频谱写进 rt.audioBridge，
 * 音频响应类效果（音条 / 律动）就能跟着视频里的音乐动，宿主零配置。
 *
 * 三条必须守住的纪律：
 *
 * 1. **必须 connect(ctx.destination)**。createMediaElementSource 会把该元素的
 *    音频**从默认输出摘走**改路由到 WebAudio 图里；只接 analyser 不接回扬声器，
 *    视频就彻底没声了（而画面照常播，极难联想到是这行代码）。
 * 2. **宿主显式注入优先**。已经 setAudio() 过就不接管——那是调用方明确指定的源。
 * 3. **AudioContext 可能 suspended**（自动播放策略要求先有用户交互）。此时不硬起，
 *    静默回落模拟源，并挂一次性交互监听在用户点击后 resume。
 */
function attachVideoSpectrum(rt: Runtime, cfg: WallpaperConfig, v: HTMLVideoElement) {
  if (rt.audioBridge) return; // 宿主已注入，不接管
  const AC: typeof AudioContext | undefined =
    (window as any).AudioContext || (window as any).webkitAudioContext;
  if (!AC) return;
  let ctx: AudioContext;
  let analyser: AnalyserNode;
  try {
    ctx = new AC();
    const srcNode = ctx.createMediaElementSource(v);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 256; // → 128 个频点，取前 64 段够用
    analyser.smoothingTimeConstant = 0.75;
    srcNode.connect(analyser);
    // 关键：把音频接回扬声器，否则视频静音（见上方纪律 1）
    analyser.connect(ctx.destination);
  } catch (e) {
    // 同一个 <video> 只能 createMediaElementSource 一次；重挂载时会抛，
    // 属预期，静默回落即可
    reportDiag(rt, cfg, `media 频谱接管跳过: ${(e as Error)?.message ?? e}`);
    return;
  }
  const bins = new Uint8Array(analyser.frequencyBinCount);
  const left = new Float32Array(64);
  const right = new Float32Array(64);
  const bridge = () => {
    // suspended（未交互）时没有数据，返回 null 让引擎回落模拟源
    if (ctx.state !== "running") return null;
    analyser.getByteFrequencyData(bins);
    const n = Math.min(64, bins.length);
    for (let i = 0; i < n; i++) {
      const x = bins[i] / 255;
      left[i] = x;
      right[i] = x; // AnalyserNode 给的是混合后的单路，左右同值
    }
    for (let i = n; i < 64; i++) {
      left[i] = 0;
      right[i] = 0;
    }
    return { left, right };
  };
  rt.audioBridge = bridge;
  // 自动播放策略：用户首次交互后再 resume（一次性）
  if (ctx.state === "suspended") {
    const kick = () => {
      void ctx.resume().catch(() => {});
      window.removeEventListener("pointerdown", kick);
      window.removeEventListener("keydown", kick);
    };
    window.addEventListener("pointerdown", kick, { once: true });
    window.addEventListener("keydown", kick, { once: true });
    (rt.wallpaperDisposers ??= []).push(() => {
      window.removeEventListener("pointerdown", kick);
      window.removeEventListener("keydown", kick);
    });
  }
  (rt.wallpaperDisposers ??= []).push(() => {
    // 只在仍是"我装的那个"时才撤：宿主可能在本壁纸生命周期内调过
    // setAudio() 换成自己的源，那时不该被这里清掉
    if (rt.audioBridge === bridge) rt.audioBridge = null;
    void ctx.close().catch(() => {});
  });
}

/**
 * A/B 双元素的频谱接管：两个元素各建一条 analyser，桥只读**当前主元素**那条。
 *
 * 为什么不能像单元素那样只接一次：`createMediaElementSource(el)` 对同一个
 * 元素在同一个 AudioContext 里只能调用一次（第二次抛 InvalidStateError），
 * 而且一旦把某个元素接进 WebAudio 图，它的声音就只能从那条链路出去 ——
 * 交接后如果桥还在读旧元素，频谱会停在旧元素被暂停的那一刻（恒定值），
 * 视觉上就是"换圈后音频可视化卡住不动"。
 *
 * 返回一个 `swap(active)`：交接时调它切换取值来源。返回 undefined 表示
 * 没接管（宿主已注入频谱源，或环境无 AudioContext）。
 */
function attachPairSpectrum(
  rt: Runtime,
  cfg: WallpaperConfig,
  a: HTMLVideoElement,
  b: HTMLVideoElement,
): ((active: HTMLVideoElement) => void) | undefined {
  if (rt.audioBridge) return undefined; // 宿主已注入，不接管
  const AC: typeof AudioContext | undefined =
    (window as any).AudioContext || (window as any).webkitAudioContext;
  if (!AC) return undefined;
  let ctx: AudioContext;
  const nodes = new Map<HTMLVideoElement, AnalyserNode>();
  try {
    ctx = new AC();
    for (const el of [a, b]) {
      const srcNode = ctx.createMediaElementSource(el);
      const an = ctx.createAnalyser();
      an.fftSize = 256; // → 128 个频点，取前 64 段够用
      an.smoothingTimeConstant = 0.75;
      srcNode.connect(an);
      // 必须接回扬声器，否则视频静音（元素一旦进 WebAudio 图就不再直出）
      an.connect(ctx.destination);
      nodes.set(el, an);
    }
  } catch (e) {
    reportDiag(rt, cfg, `media 频谱接管跳过: ${(e as Error)?.message ?? e}`);
    return undefined;
  }
  let cur = nodes.get(a)!;
  const bins = new Uint8Array(cur.frequencyBinCount);
  const left = new Float32Array(64);
  const right = new Float32Array(64);
  const bridge = () => {
    if (ctx.state !== "running") return null;
    cur.getByteFrequencyData(bins);
    const n = Math.min(64, bins.length);
    for (let i = 0; i < n; i++) {
      const x = bins[i] / 255;
      left[i] = x;
      right[i] = x; // AnalyserNode 给的是混合后的单路，左右同值
    }
    for (let i = n; i < 64; i++) {
      left[i] = 0;
      right[i] = 0;
    }
    return { left, right };
  };
  rt.audioBridge = bridge;
  if (ctx.state === "suspended") {
    const kick = () => {
      void ctx.resume().catch(() => {});
      window.removeEventListener("pointerdown", kick);
      window.removeEventListener("keydown", kick);
    };
    window.addEventListener("pointerdown", kick, { once: true });
    window.addEventListener("keydown", kick, { once: true });
    (rt.wallpaperDisposers ??= []).push(() => {
      window.removeEventListener("pointerdown", kick);
      window.removeEventListener("keydown", kick);
    });
  }
  (rt.wallpaperDisposers ??= []).push(() => {
    if (rt.audioBridge === bridge) rt.audioBridge = null;
    void ctx.close().catch(() => {});
  });
  return (active: HTMLVideoElement) => {
    const next = nodes.get(active);
    if (next) cur = next;
  };
}

export function mountMedia(rt: Runtime, cfg: WallpaperConfig) {
  clear(rt);
  // 库化桥接：失败也必须让 mount() 的 Promise 落地。api/mount.ts 等的是
  // Promise.race([onFirstFrame, onError]) —— 两个钩子都不触发就是永久挂起，
  // 调用方连超时都没法区分「还在加载」和「已经死了」。
  const failHard = (why: string) => {
    reportDiag(rt, cfg, `media ${cfg.type} 失败: ${why}`);
    rt.onError?.(new Error(`媒体壁纸（${cfg.type}）${why}`));
    rt.fallbackPage?.();
  };
  if (!cfg.src) {
    failHard("缺少资源 URL（cfg.src 为空）");
    return;
  }
  const isVideo = cfg.type === "video";
  const isGif = cfg.type === "gif";

  // 视频壁纸走 DOM 直显，不进场景引擎。
  // 场景引擎那条路会把每帧上传成 WebGL 纹理，而渲染器的视频纹理分支有尺寸
  // 上限（见 vendor renderer 的 videoTexLimit）—— 4K 源被降采样后再放大，
  // 观感明显发糊。DOM 直显交给浏览器硬件解码合成，拿到的是原生分辨率，
  // 还省掉一个 WebGL 上下文和每帧一次全画布 texImage2D。
  // 代价是纯视频壁纸不再有效果链/粒子叠加能力 —— 它本来也用不到。
  // 「场景内含视频纹理层」的壁纸走的是 scene-mount，不受这里影响。
  if (isVideo) {
    mountVideoDom(rt, cfg);
    // 视频元素同步创建完毕：立即重放宿主音量。内部重挂（setRenderDpr 等）
    // 重建的 <video>/循环对只带 cfg.muted 近似，中间音量在这里补齐。
    reapplyVolume(rt);
    return;
  }

  // 库形态：调用方给了 canvas 就画在它上面（可非全屏、可多实例）；
  // 旧形态（壁纸页）：自建 canvas 铺满内部 wrap 容器。与 mountScene 同构。
  const embedded = cfg.canvas instanceof HTMLCanvasElement;
  const c = embedded ? (cfg.canvas as HTMLCanvasElement) : document.createElement("canvas");
  const dpr = effectiveDpr(rt, cfg);
  // backing store 按显示尺寸折算：嵌入式用 CSS 尺寸（全屏 canvas 的
  // clientWidth == innerWidth，两种形态等价）。直接用 innerWidth 会让
  // 300×200 的嵌入画布拿到 1920×1080 的缓冲区。
  const vw = c.clientWidth || window.innerWidth || 1;
  const vh = c.clientHeight || window.innerHeight || 1;
  c.width = Math.max(1, Math.round(vw * dpr));
  c.height = Math.max(1, Math.round(vh * dpr));
  if (!embedded) c.style.cssText = "position:absolute;inset:0;width:100%;height:100%;";
  const gl2 = c.getContext("webgl2", {
    premultipliedAlpha: false,
    antialias: false,
    alpha: false,
    preserveDrawingBuffer: true,
  });
  if (!gl2) {
    // 无 WebGL2：壁纸页回退 DOM 路径（图片/GIF 照常显示，只是没有场景引擎能力）。
    // 库形态没有 rt.wrap，DOM 回退的元素挂不上去也就永远看不见 —— 与其假装
    // 成功，不如如实报错让调用方决定（提示 / 换壁纸 / 卸载实例）。
    // 视频不会走到这里：它在上面已分流到 mountVideoDom（DOM 直显是默认路径）。
    reportDiag(rt, cfg, `media ${cfg.type}: WEBGL2_UNAVAILABLE`);
    if (embedded) {
      rt.onError?.(new Error("WEBGL2_UNAVAILABLE"));
      return;
    }
    mountGifDom(rt, cfg);
    return;
  }
  if (!embedded) rt.wrap?.appendChild(c);
  // 标记已创建 WebGL 上下文，供 api/mount.ts 的 ensureSceneCanvas 在重挂前
  // 检测上下文是否已被 clear() 的 loseContext 弄死（死了就换新画布）
  c.setAttribute("data-webwallgl-gl", "1");
  rt.canvas = c;
  // 库化桥接：媒体没有图层概念，报最小可用信息（与 web 路径同形）
  if (rt.onSceneInfo) {
    const hook = rt.onSceneInfo;
    rt.onSceneInfo = undefined;
    try {
      hook({
        width: vw,
        height: vh,
        layerCount: 0,
        hasModels: false,
        hasParticles: false,
        hasText: false,
      });
    } catch {
      /* 订阅者抛错不打断装配 */
    }
  }
  let disposed = false;
  rt.sceneCleanup = () => {
    disposed = true;
    if (rt.renderer) {
      rt.renderer.dispose?.();
      rt.renderer = undefined;
    }
  };
  let pauseImpl: (() => void) | undefined;
  let resumeImpl: (() => void) | undefined;
  /** 遮挡暂停实现（装配后赋值；与 scene 路径同三种交织语义） */
  let setOccludedImpl: ((on: boolean) => void) | undefined;
  let videoWasPlaying = false;
  // [1.3.0] 音量控制：setVolume 打的是 rt.sceneAudio，此前只有 mountScene 设，
  // 媒体壁纸调 setVolume 完全无效（视频照旧静音或照旧响）。这里直接操作 <video>。
  // volume>0 时必须同时清 muted：<video muted> 下改 volume 一点用都没有。
  rt.sceneAudio = {
    setVolume(v: number) {
      const vid = rt.video;
      if (!vid) return;
      const vol = Math.max(0, Math.min(1, Number(v) || 0));
      vid.volume = vol;
      vid.muted = vol <= 0;
      // 从静音切到有声可能被自动播放策略拒绝（未发生用户交互时）。
      // 如实经诊断报出，不要静默吞掉——否则表现为「设了音量但没声音」。
      if (vol > 0 && vid.paused && !rt.paused) {
        void vid.play().catch((e: unknown) => {
          reportDiag(rt, cfg, `media 取消静音后自动播放被拒绝: ${(e as Error)?.message ?? e}`);
        });
      }
    },
    audios: [],
  } as unknown as Runtime["sceneAudio"];
  rt.sceneCtl = {
    pause() {
      pauseImpl?.();
    },
    resume() {
      resumeImpl?.();
    },
    /** 遮挡暂停（V5）：同 scene 路径语义 —— 不碰 rt.paused，用户暂停不被遮挡解除掀掉 */
    setOccluded(on: boolean) {
      setOccludedImpl?.(on);
    },
    applyUserProperties() {
      /* 媒体壁纸没有效果链用户属性 */
    },
  };

  const fail = (why: string) => {
    if (disposed) return;
    disposed = true;
    failHard(why);
  };

  void (async () => {
    try {
      const renderer = rnd.createRenderer(c, {
        diag: (msg: string) => reportDiag(rt, cfg, `renderer: ${msg}`),
        fboCapFactor: 0,
      });
      rt.renderer = renderer;
      if (disposed) return;

      const TEX = "__media";
      const textures = new Map<string, any>();
      /** 每帧刷新纹理（gif 用；video 由渲染器内部按 currentTime 上传）。
       *  返回「纹理是否真的换了帧」 —— 按需渲染的静止判据之一。 */
      let refreshTex: (() => boolean) | undefined;
      let mediaW = 0;
      let mediaH = 0;

      {
        // GIF 优先走 ImageDecoder 逐帧解码（见下），失败或非 GIF 才用 <img> 位图。
        let decoded = false;
        if (isGif && typeof (window as any).ImageDecoder === "function") {
          try {
            const gifFrames = await decodeGifFrames(cfg.src!);
            if (gifFrames && gifFrames.frames.length > 1) {
              mediaW = gifFrames.width;
              mediaH = gifFrames.height;
              const gl = renderer.gl;
              const entry = {
                glTex: rnd.makeTexture(gl, null, 0, 0, gifFrames.frames[0].bitmap),
                width: mediaW,
                height: mediaH,
                rg88: false,
              };
              textures.set(TEX, entry);
              // 按各帧自己的 duration 推进（GIF 每帧时长可不同），到末帧回环。
              // 返回值 = 纹理内容是否真的换了新帧：按需渲染靠它判断这一帧要不要提交
              // （见下方 renderLoop 的静止判据）。未到时长、或单帧上传失败（保留上
              // 一帧）都返回 false —— 那两种情况画面与上一帧逐像素相同。
              let idx = 0;
              let nextAt = performance.now() + gifFrames.frames[0].durationMs;
              refreshTex = () => {
                const now = performance.now();
                if (now < nextAt) return false;
                idx = (idx + 1) % gifFrames.frames.length;
                nextAt = now + gifFrames.frames[idx].durationMs;
                gl.bindTexture(gl.TEXTURE_2D, entry.glTex);
                try {
                  gl.texImage2D(
                    gl.TEXTURE_2D,
                    0,
                    gl.RGBA,
                    gl.RGBA,
                    gl.UNSIGNED_BYTE,
                    gifFrames.frames[idx].bitmap,
                  );
                } catch {
                  /* 单帧上传失败：保留上一帧 */
                  return false;
                }
                return true;
              };
              // 卸载时释放解码出的位图（每帧一张 ImageBitmap，不释放会积压显存）
              const prev = rt.sceneCleanup;
              rt.sceneCleanup = () => {
                prev?.();
                for (const f of gifFrames.frames) f.bitmap.close();
              };
              decoded = true;
              reportDiag(rt,
                cfg,
                `media gif ${mediaW}x${mediaH} ${gifFrames.frames.length} 帧 → scene 渲染`,
              );
            }
          } catch (e) {
            reportDiag(rt, cfg, `gif 解码失败，回退静态首帧: ${String((e as Error).message).slice(0, 80)}`);
          }
        }
        if (!decoded) {
          const img = new Image();
          // 同源媒体端点；crossOrigin 让将来分端口调试时也能进 WebGL（否则画布被污染）
          img.crossOrigin = "anonymous";
          img.src = cfg.src!;
          await new Promise<void>((ok, err) => {
            img.addEventListener("load", () => ok(), { once: true });
            img.addEventListener("error", () => err(new Error("image load error")), { once: true });
          });
          if (disposed) return;
          mediaW = img.naturalWidth || 1;
          mediaH = img.naturalHeight || 1;
          rt.img = img;
          textures.set(TEX, {
            glTex: rnd.makeTexture(renderer.gl, null, 0, 0, img),
            width: mediaW,
            height: mediaH,
            rg88: false,
          });
          reportDiag(rt, cfg, `media ${cfg.type} ${mediaW}x${mediaH} → scene 渲染`);
        }
      }

      if (disposed) return;
      const scene = buildMediaScene(mediaW, mediaH, TEX);
      const start = performance.now();
      let pauseAccum = 0;
      let pauseStarted = 0;
      // 帧率上限门：相位累加调度（见 shell.ts FrameGate），替代会误丢整帧的死重闸门
      const frameGate = new FrameGate(rt.cfg.sceneFps || 60);
      let gateFps = rt.cfg.sceneFps || 60;
      // 按需渲染状态（见文件头注释）：renderedOnce 保证首帧一定提交（渲染器要在
      // 首次 render 里建 program/FBO，跳过它就等于永远不初始化）；lastFit /
      // lastPeek* 记上一帧真正提交时用过的输入，逐项精确比对。
      let renderedOnce = false;
      let lastFit = normalizeFit(rt.cfg.fit);
      let lastPeekX = rt.coverAlign.x;
      let lastPeekY = rt.coverAlign.y;
      let lastCanvasW = c.width;
      let lastCanvasH = c.height;
      // A/B 钩子：__noMediaIdle=true 关掉按需渲染跑基线（对照跑法见提交说明）
      const mediaIdleOff = (globalThis as any).__noMediaIdle === true;
      const renderLoop = (now: number) => {
        if (disposed || rt.paused || occlPaused(rt)) return;
        // 静止心跳按 **rAF 节奏**刷新，不按出帧节奏：帧率门会把大部分 rAF 拦在
        // shouldRender 之外，只在放行的帧上刷新的话，心跳会随 sceneFps 上限一起变慢
        // ——sceneFps 调到 1~2 时心跳就超时，静止待命被误报成「没在跑」。
        if (rt.renderIdleAt) rt.renderIdleAt = now;
        // 帧率上限：比目标更快的 rAF 不渲染只继续排队，降低 GPU 占用。
        // 热改 fps 同步进调度器（保留节拍相位，平滑收敛）。
        // 遮挡降帧（V5）：档位 fps 与宿主上限取 min，同 scene 路径。
        const occlBand = rt.occlusion?.band;
        const baseFps = rt.cfg.sceneFps || 60;
        const fps = occlusionFpsCap(occlBand, occlusionCfgOf(rt), baseFps);
        if (fps !== gateFps) {
          gateFps = fps;
          frameGate.setFps(fps);
        }
        if (frameGate.shouldRender(now)) {
          // 画布尺寸变化会让 backing store 失效（尺寸一改内容即作废），必须先同步。
          // **保持裸调用语句**：verify-arch 有一条守卫要求媒体与场景循环每帧都出现
          // `syncCanvasSize(rt, c, rt.cfg)`（窗口改比例后 cover 才跟着裁，见那里的注释）。
          syncCanvasSize(rt, c, rt.cfg);
          // 「尺寸真的变了没有」与上一帧提交时用过的尺寸比对 —— 与 peek/fit 同一口径：
          // 四项输入都跟「上次提交时的值」精确比，而不是跟「挂载时的值」比。
          const sizeChanged = c.width !== lastCanvasW || c.height !== lastCanvasH;
          // GIF：只有到了它自己的帧时长才换帧（refreshTex 内部的时长闸门）
          const texAdvanced = refreshTex?.() === true;
          const peek = rt.coverAlign;
          // 窥视偏移与「上一帧真正提交时用过的值」做**精确比较**，不用阈值：
          // advanceCoverAlign 在误差 <1e-3 时会**吸附**到目标（shell.ts），
          // 用阈值判「还在动」会让最后一次渲染发生在吸附之前 —— 画布就永久停在
          // 偏离目标 ≤1e-4 的那一帧上（亚像素偏移，肉眼无感，但逐像素比对能看出
          // 0.18 的像素差）。精确比较下吸附那一下也算「变了」，于是补渲一帧正好落在
          // 目标值上；之后 align 不再变化，自然停帧，收敛后不会自激。
          const peekMoved = peek.x !== lastPeekX || peek.y !== lastPeekY;
          const fit = normalizeFit(rt.cfg.fit);
          const fitChanged = fit !== lastFit;
          // 这四项是静态媒体壁纸**全部的时变输入**：纹理内容、画布尺寸、fit、窥视偏移。
          // 都不变时这一帧的输出与上一帧逐像素相同（实测 image 壁纸 4.8s 内 6 次采样
          // 帧差恒为 0，即渲染器侧不依赖 t），重新提交是纯浪费。
          //
          // 注意这里**不是停循环**，只是不提交：rAF 照跑，因为窥视收敛、GIF 换帧、
          // 画布尺寸变化、宿主热改 fit 都挂在循环上；而且 frameStats 在 400ms 无帧
          // 后会把 running 判成 false，停循环会让宿主/测试台以为壁纸出事。
          // 收益本来也不在 rAF 回调上：实测 60fps→10fps 已拿到约八成，成本在渲染提交。
          if (!mediaIdleOff && renderedOnce && !sizeChanged && !texAdvanced && !peekMoved && !fitChanged) {
            rt.renderIdleAt = now; // 进入静止待命：从这里起由循环开头逐 rAF 刷新心跳
            rt.raf = requestAnimationFrame(renderLoop);
            return;
          }
          markFrame(rt, now);
          rt.renderIdleAt = 0;
          lastFit = fit;
          lastPeekX = peek.x;
          lastPeekY = peek.y;
          lastCanvasW = c.width;
          lastCanvasH = c.height;
          void renderer
            .render(
              scene,
              textures,
              c.width,
              c.height,
              (now - start - pauseAccum) / 1000,
              fit,
              peek.x,
              peek.y,
            )
            .then(() => {
              renderedOnce = true;
              // 库化桥接：首帧**画完之后**才 resolve mount()（一次性）。
              // 放在 render() 之前会早一帧落地，调用方拿到实例时画布还是空的；
              // autoplay:false 紧接着 pause()，画面就永远停在一片 clearcolor。
              // 也要排在 disposed/paused 早退之前，否则同样漏掉。
              if (rt.onFirstFrame) {
                const first = rt.onFirstFrame;
                rt.onFirstFrame = undefined;
                try {
                  first();
                } catch { /* 订阅者抛错不打断渲染循环 */ }
              }
              if (disposed || rt.paused || occlPaused(rt)) return;
              rt.raf = requestAnimationFrame(renderLoop);
            })
            .catch((e: Error) => fail(String(e.message || e).slice(0, 200)));
        } else if (!rt.paused && !occlPaused(rt)) {
          rt.raf = requestAnimationFrame(renderLoop);
        }
      };
      const kickLoop = () => {
        if (disposed || rt.paused || occlPaused(rt)) return;
        if (rt.raf !== undefined) return;
        rt.raf = requestAnimationFrame(renderLoop);
      };
      pauseImpl = () => {
        // 重入幂等（同 scene 路径）：遮挡暂停 → 用户 pause() 交织下第二次跑
        // 会把 videoWasPlaying 覆写成 false，恢复时视频永远不再起播（评审 P0）。
        if (pauseStarted) return;
        if (rt.raf !== undefined) {
          cancelAnimationFrame(rt.raf);
          rt.raf = undefined;
        }
        pauseStarted = performance.now();
        const v = rt.video;
        videoWasPlaying = !!(v && !v.paused && !v.ended);
        v?.pause();
      };
      resumeImpl = () => {
        if (pauseStarted) {
          pauseAccum += performance.now() - pauseStarted;
          pauseStarted = 0;
        }
        if (videoWasPlaying) void rt.video?.play().catch(() => {});
        videoWasPlaying = false;
        frameGate.reset();
        kickLoop();
      };
      // 遮挡暂停（V5）：与 scene 路径同构 —— 已在暂停就只记账；用户暂停期间
      // 解除遮挡只结账不恢复；正常解除走完整 resumeImpl。
      setOccludedImpl = (on: boolean) => {
        if (on) {
          if (!pauseStarted) pauseImpl?.();
          return;
        }
        if (!rt.paused) {
          resumeImpl?.();
          return;
        }
        if (pauseStarted) {
          pauseAccum += performance.now() - pauseStarted;
          pauseStarted = 0;
        }
      };
      kickLoop();
    } catch (e) {
      fail(String((e as Error).message || e).slice(0, 200));
    }
  })();
}


/** 与 web.resolveContainer 同构：库形态下 canvas 不能挂子节点。 */
function resolveVideoContainer(rt: Runtime, cfg: WallpaperConfig): HTMLElement | null {
  if (rt.wrap) return rt.wrap;
  const el = cfg.canvas as HTMLElement | undefined;
  if (!el) return null;
  if (el instanceof HTMLCanvasElement) return el.parentElement;
  return el;
}

/**
 * 视频默认走 DOM `<video>`（非 WebGL）：原生清晰度、省上下文、A/B 无缝循环
 * （见 video-loop.ts）。场景内视频纹理层仍走引擎路径。
 */
export function mountVideoDom(rt: Runtime, cfg: WallpaperConfig) {
  clear(rt);
  if (!cfg.src) {
    rt.fallbackPage?.();
    rt.onError?.(new Error("媒体壁纸（video）缺少资源 URL（cfg.src 为空）"));
    return;
  }
  const container = resolveVideoContainer(rt, cfg);
  if (!container) {
    // 库形态传了裸 canvas 且它没有父节点：挂不上去就别假装成功
    const why = "视频壁纸需要一个容器元素（传入的 canvas 没有父节点）";
    reportDiag(rt, cfg, `media video 失败: ${why}`);
    rt.onError?.(new Error(`媒体壁纸（video）${why}`));
    return;
  }
  const fit = fitObjectFit(cfg.fit);
  const css =
    "position:absolute;inset:0;width:100%;height:100%;" +
    `object-fit:${fit.objectFit};object-position:50% 50%;background:${fit.background};`;
  // 库形态容器可能是 static 定位，绝对定位的 video 会逃到更外层的定位祖先
  if (!rt.wrap && getComputedStyle(container).position === "static") {
    container.style.position = "relative";
  }

  let failed = false;
  const onErr = (code?: number) => {
    if (failed) return;
    failed = true;
    const why = `解码/加载失败（code ${code ?? "?"}）`;
    reportDiag(rt, cfg, `media video 失败: ${why}`);
    rt.onError?.(new Error(`媒体壁纸（video）${why}`));
    rt.fallbackPage?.();
  };

  // loop=false（播完即停）不需要双元素：直接单元素原生播放
  const wantLoop = cfg.loop !== false;
  const muted = cfg.muted !== false;

  /**
   * 首帧上报。库入口的 mount() 等的是 Promise.race([onFirstFrame, onError])，
   * 两个钩子都不触发就是**永久挂起** —— 调用方连超时都分不清"还在加载"和
   * "已经死了"。DOM 路径没有渲染循环，所以必须在这里显式触发一次。
   */
  const signalFirstFrame = () => {
    markFrame(rt, performance.now());
    const first = rt.onFirstFrame;
    if (!first) return;
    rt.onFirstFrame = undefined;
    if (rt.onSceneInfo) {
      const hook = rt.onSceneInfo;
      rt.onSceneInfo = undefined;
      try {
        hook({
          width: rt.video?.videoWidth || 0,
          height: rt.video?.videoHeight || 0,
          layerCount: 1,
          hasModels: false,
          hasParticles: false,
          hasText: false,
        });
      } catch {
        /* 订阅者抛错不打断装配 */
      }
    }
    try {
      first();
    } catch {
      /* 同上 */
    }
  };

  /**
   * 持续给帧率表打点。
   *
   * DOM 直显没有 rAF 渲染循环，而 `frameStats()` 是按 `frameMeter.last` 的
   * 新鲜度判活的（>400ms 无打点即报 fps=0 / running=false）。不打点的话
   * `instance.stats` 会一直说壁纸已停 —— 宿主据此做健康检查就会误判。
   *
   * 用 rAF 而**不用** requestVideoFrameCallback：后者理论上更合适（只在视频
   * 真正呈现新帧时回调，能直接反映视频自身帧率），但实测在 WKWebView 里
   * 这个方法**存在却从不回调** —— 视频正常播放（currentTime 在走）的同时
   * 1.5 秒内 0 次回调，判活会永远失败。
   *
   * rAF 的频率是显示器刷新率，直接每次 rAF 都打点会把 30fps 的视频报成 60。
   * 所以只在 `currentTime` 真的推进了一个视频帧间隔时才打点：帧间隔未知
   * （拿不到 fps 元数据）时按"时间有推进"打点，读数退化为刷新率，但
   * "是否还在跑"这个更重要的语义始终是准的。
   */
  const pumpFrames = (getEl: () => HTMLVideoElement | undefined) => {
    let stopped = false;
    let raf = 0;
    let lastMediaTime = -1;
    const mark = (el: HTMLVideoElement) => {
      if (rt.paused) return;
      // 暂停/缓冲卡住时如实反映为"未运行"，否则 rAF 会把卡死的视频报成满帧
      if (el.paused || el.readyState < 2) return;
      const t = el.currentTime;
      // 时间没动 = 没有新的视频帧，不打点（避免把 30fps 报成刷新率）。
      // 循环回绕时 t 变小，也算"有新帧"。rAF 与 rVFC 两条路径共享
      // lastMediaTime 去重，同帧不会双记。
      if (lastMediaTime >= 0 && t === lastMediaTime) return;
      lastMediaTime = t;
      markFrame(rt, performance.now());
    };
    // rVFC（浏览器可用）：按真实呈现帧打点，帧率读数 = 视频实际帧率，
    // 不会被 rAF 刷新率污染（120Hz 屏上 30fps 视频不再报成 120）。
    // WKWebView 里该方法存在却从不回调（实测），所以 rAF 兜底必须并存。
    let vfcEl: HTMLVideoElement | undefined;
    const vfcStep = () => {
      if (stopped || !vfcEl) return;
      mark(vfcEl);
      vfcEl.requestVideoFrameCallback(vfcStep);
    };
    const step = () => {
      if (stopped) return;
      raf = requestAnimationFrame(step);
      const el = getEl();
      if (!el) return;
      if (el !== vfcEl && typeof el.requestVideoFrameCallback === "function") {
        vfcEl = el;
        el.requestVideoFrameCallback(vfcStep);
      }
      mark(el);
    };
    raf = requestAnimationFrame(step);
    (rt.wallpaperDisposers ??= []).push(() => {
      stopped = true;
      vfcEl = undefined;
      if (raf) cancelAnimationFrame(raf);
    });
  };

  if (!wantLoop) {
    const v = document.createElement("video");
    v.autoplay = true;
    v.loop = false;
    v.muted = muted;
    v.playsInline = true;
    v.preload = "metadata";
    applyDecodeHint(v, rt, cfg);
    v.style.cssText = css;
    v.src = cfg.src;
    v.addEventListener("error", () => onErr(v.error?.code));
    container.appendChild(v);
    rt.video = v;
    (rt.videoTextures ??= []).push(v);
    v.addEventListener("canplay", () => void v.play().catch(() => {}), { once: true });
    v.addEventListener("loadeddata", signalFirstFrame, { once: true });
    if (v.readyState >= 2) signalFirstFrame();
    attachVideoSpectrum(rt, cfg, v);
    pumpFrames(() => v);
    reportDiag(rt, cfg, "media video → DOM 直显（单元素，不循环）");
    return;
  }

  /** 无缝循环：A/B 双 <video> 元素（有声、或 WebCodecs 不可用/失败时的回退路径） */
  const mountAbPair = () => {
    // 无缝循环：A/B 双元素。两个元素都留在容器里，靠 z-index 决定谁可见 ——
    // 交接时若改 display/visibility，被隐藏那一侧的解码器可能被 WebKit 回收，
    // 保温就白做了。
    // cfg.src 在 mountVideoDom 入口已判空（TS 对闭包内的属性收窄不生效，补 !）
    const pair = createLoopingVideo(cfg.src!, {
      muted,
      renderDpr: cfg.renderDpr,
      maxW: container.clientWidth || window.innerWidth,
      maxH: container.clientHeight || window.innerHeight,
      onRecover: (msg) => reportDiag(rt, cfg, `media video 自愈: ${msg}`),
    });
    for (const el of [pair.active, pair.standby]) {
      el.style.cssText = css;
      container.appendChild(el);
      (rt.videoTextures ??= []).push(el);
      el.addEventListener("error", () => onErr(el.error?.code));
    }
    const showActive = () => {
      pair.active.style.zIndex = "1";
      pair.standby.style.zIndex = "0";
      rt.video = pair.active;
    };
    showActive();
    pair.onSwap = () => {
      showActive();
      // 频谱要跟着换源：AudioContext 的 createMediaElementSource 对同一元素
      // 只能调一次，所以两个元素各自接一次、按当前主元素取值（见 attachPairSpectrum）
      swapSpectrum?.(pair.active);
    };
    pair.onFallback = () => reportDiag(rt, cfg, "media video: 无缝循环兜底（退回原生 loop）");
    (rt.videoPairs ??= []).push(pair);
    // A/B 路径 = 有声/回退形态；重新静音时允许切回 WebCodecs 静音循环
    // （mount.ts setVolume 在音量归 0 时读这个标记重挂）。WebCodecs 解码失败
    // 的回退会在 fallbackToAb 里把它再清零 —— 失败过的源不要反复尝试
    rt.webcodecsPreferred = supportsWebCodecsVideo();

    // 双元素的频谱：两个元素各建一条 analyser，读当前主元素那条
    const swapSpectrum = attachPairSpectrum(rt, cfg, pair.active, pair.standby);

    pair.active.addEventListener("loadeddata", signalFirstFrame, { once: true });
    // metadata 已就绪（缓存命中）时 loadeddata 可能早于监听注册
    if (pair.active.readyState >= 2) signalFirstFrame();
    // 打点跟着主元素走：交接后读新主元素，否则每圈换手都会静默 400ms 被判定为已停
    pumpFrames(() => pair.active);
    if (!rt.paused) pair.resume();
    reportDiag(rt, cfg, "media video → DOM 直显（A/B 无缝循环）");
  };

  // 优先 WebCodecs 逐帧调度（静音循环场景）：循环点帧级精确、没有元素级
  // API 的整类不确定性（WKWebView 冷管线 ~1s / ended 丢失 / 静默暂停），
  // 且帧率上限真正生效（<video> 的解码率由内容决定，HTML 无限帧 API）。
  // 有声（需要音轨）、不循环、WebCodecs 不可用或初始化/解码失败时回退 A/B。
  if (wantLoop && muted && supportsWebCodecsVideo()) {
    let pathActive = true;
    let player: ReturnType<typeof mountWebCodecsVideo> | null = null;
    /** 销毁 WebCodecs 实例并回退 A/B 路径（rt 已 clear 时静默作废）。
     *  allowReturn=false（解码/初始化失败）时禁止再切回 WebCodecs，
     *  否则音量每次归 0 都会重挂一次再失败，画面反复闪 */
    const fallbackToAb = (why: string, allowReturn = true) => {
      if (!pathActive) return;
      pathActive = false;
      player?.destroy();
      player = null;
      reportDiag(rt, cfg, `media video: ${why}，回退 A/B <video>`);
      mountAbPair();
      if (!allowReturn) rt.webcodecsPreferred = false;
    };
    player = mountWebCodecsVideo({
      src: cfg.src,
      container,
      cssText: css,
      fit: () => normalizeFit(rt.cfg.fit),
      // fps 按当前遮挡档收敛（V5）：本路径逐帧调度有能力降帧，此前漏接（DOM
      // <video> 直显才真只能 pause）。pause 档映射回 base —— 整页暂停归
      // player.pause() 管，cap=0 会被调度器当「不限帧」。
      fps: () => occlusionFpsCap(
        rt.occlusion?.band === "pause" ? undefined : rt.occlusion?.band,
        occlusionCfgOf(rt),
        rt.cfg.sceneFps || 60,
      ),
      paused: () => !!rt.paused,
      renderDpr: cfg.renderDpr,
      onFirstFrame: signalFirstFrame,
      onFrame: () => markFrame(rt, performance.now()),
      onDiag: (m) => reportDiag(rt, cfg, `media video(webcodecs): ${m}`),
      onFatal: (why) => fallbackToAb(`WebCodecs 路径失败（${why}）`, false),
    });
    // 暂停/恢复走 sceneCtl（与场景路径同一套钩子，mount.ts 统一调用）
    rt.sceneCtl = {
      pause: () => player?.pause(),
      resume: () => player?.resume(),
      // 遮挡暂停（V5）：player.pause 幂等；解除时用户暂停仍生效就不恢复
      setOccluded: (on: boolean) => {
        if (on) player?.pause();
        else if (!rt.paused) player?.resume();
      },
      applyUserProperties() {},
    };
    // 取消静音需要音轨（本路径整体忽略音轨）：回退 A/B 让声音回来。
    // mount.ts 的 setVolume 先更新 rt.cfg.muted 再调这里，回退挂载读到 false
    rt.sceneAudio = {
      setVolume: (v) => {
        if (v > 0) fallbackToAb("取消静音（需要音轨）");
      },
      audios: [],
    };
    (rt.wallpaperDisposers ??= []).push(() => {
      pathActive = false;
      player?.destroy();
      player = null;
    });
    rt.canvas = player.canvas;
    reportDiag(rt, cfg, "media video → WebCodecs 逐帧调度（静音循环）");
    return;
  }

  mountAbPair();
}

/**
 * 解码缓冲上限：按「显示尺寸 × 有效 dpr」而非视频原始分辨率。
 *
 * WebKit 对超出显示尺寸的 video 会分配等比缩小的解码缓冲（4K 源在 1080p 窗口上
 * 约为 1/4），显著降低内存，且**不损失观感** —— 显示端最终只有那么多物理像素，
 * 解码出 4K 再缩回去不会更清晰。真正会糊的是降到显示尺寸**以下**。
 */
function applyDecodeHint(v: HTMLVideoElement, rt: Runtime, cfg: WallpaperConfig) {
  // 视频解码缓冲不超过设备 DPR：宿主 backing 若真为 1，超采样解码只费内存、
  // CSS 放大不会更清晰（与 WebGL 场景画布的超采样语义不同，那里走 effectiveDpr）。
  // renderDpr=0（默认/自动）→ 跟随设备 DPR；显式值作为上限。
  const cap = cfg.renderDpr ?? rt.cfg?.renderDpr ?? 0;
  const dpr = Math.min(
    window.devicePixelRatio || 1,
    !cap || cap <= 0 ? (window.devicePixelRatio || 1) : cap,
  );
  const w = (cfg.canvas as HTMLElement | undefined)?.clientWidth || window.innerWidth;
  const h = (cfg.canvas as HTMLElement | undefined)?.clientHeight || window.innerHeight;
  v.width = Math.max(1, Math.round(w * dpr));
  v.height = Math.max(1, Math.round(h * dpr));
}

export function mountGifDom(rt: Runtime, cfg: WallpaperConfig) {
  clear(rt);
  const img = document.createElement("img");
  const fit = fitObjectFit(cfg.fit);
  img.style.cssText =
    "position:absolute;inset:0;width:100%;height:100%;" +
    `object-fit:${fit.objectFit};object-position:50% 50%;background:${fit.background};`;
  img.src = cfg.src ?? "";
  img.addEventListener("error", () => rt.fallbackPage?.());
  rt.wrap?.appendChild(img);
  rt.img = img;
}
