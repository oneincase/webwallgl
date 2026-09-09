// 媒体类壁纸（从 main.ts 拆出）：视频 / 图片 / GIF 合成单图层场景走 we-scene 渲染，
// WebGL2 缺失时回退 DOM 路径。
import { clear, effectiveDpr, fitObjectFit, markFrame, normalizeFit, reportDiag, syncCanvasSize, type Runtime } from "./shell";
import { createLoopingVideo } from "./video-loop";
import { mountWebCodecsVideo, supportsWebCodecsVideo } from "./video-webcodecs";
import type { WallpaperConfig } from "./types";
import { rnd, noise } from "./vendor";

// ---------- 视频 / 图片 / GIF：走场景引擎渲染 ----------
//
// 视频与图片类型壁纸不再各自维护一条 DOM 渲染路径（<video object-fit> / <img object-fit>），
// 而是合成一个「单图层场景」交给 we-scene 渲染。这样 fit / renderDpr / sceneFps / 效果链
// 只有一份实现，媒体类壁纸自动获得与场景壁纸一致的行为；后续要给媒体加效果
// （模糊、色调、粒子叠加）也只是往这个合成场景里加层，不必再碰 DOM 分支。
//
// 三种媒体的纹理供给方式不同，但都不需要给 vendor 打新补丁：
//   video —— 渲染器本身就有视频纹理分支（帧时间戳变化时上传当前帧）；
//   gif   —— 每帧由本文件把 <img> 重新上传（GIF 动画由浏览器内部推进，
//            texImage2D 取到的即当前帧）；
//   image —— 一次性上传位图。
//
// WebGL2 不可用时回退原来的 DOM 路径（mountVideoDom / mountGifDom），
// 保证无 WebGL 环境里媒体壁纸仍可显示。

/** 合成单图层场景：投影尺寸取媒体自身像素，fit 交给 buildCamera/fitWindow（语义同 object-fit） */
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
 * 用 ImageDecoder 把 GIF 解成一组 ImageBitmap（各帧带自己的时长）。
 *
 * 为什么不能直接把 `<img src=*.gif>` 当纹理源逐帧上传：GIF 的动画只推进**用于合成显示**
 * 的那份帧，`drawImage` / `texImage2D` 取到的始终是首帧。实测三种摆放（脱离文档、
 * 屏幕外、可见 64×64）在 1.5s 内取到的像素**完全无变化**，90 帧的 GIF 渲染成静止画。
 * ImageDecoder 是显式的逐帧解码接口，能拿到真实帧与 `duration`。
 *
 * 代价：整段动画的位图常驻内存（256×256×90 帧 ≈ 23MB）。GIF 壁纸通常是小尺寸预览级
 * 素材，可接受；解码失败或无 ImageDecoder 时回退静态首帧（画面不动但不黑屏）。
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
  //
  // 场景引擎那条路会把每帧上传成 WebGL 纹理，而渲染器的视频纹理分支有尺寸
  // 上限（见 vendor renderer 的 videoTexLimit）—— 4K 源被降采样后再放大，
  // 观感明显发糊。DOM 直显交给浏览器硬件解码合成，拿到的是原生分辨率，
  // 还省掉一个 WebGL 上下文和每帧一次全画布 texImage2D。
  //
  // 代价是纯视频壁纸不再有效果链/粒子叠加能力 —— 它本来也用不到。
  // 「场景内含视频纹理层」的壁纸走的是 scene-mount，不受这里影响。
  if (isVideo) {
    mountVideoDom(rt, cfg);
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
      /** 每帧刷新纹理（gif 用；video 由渲染器内部按 currentTime 上传） */
      let refreshTex: (() => void) | undefined;
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
              // 按各帧自己的 duration 推进（GIF 每帧时长可不同），到末帧回环
              let idx = 0;
              let nextAt = performance.now() + gifFrames.frames[0].durationMs;
              refreshTex = () => {
                const now = performance.now();
                if (now < nextAt) return;
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
                }
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
      let lastRender = -Infinity;
      const renderLoop = (now: number) => {
        if (disposed || rt.paused) return;
        // 帧率上限：比目标帧更快的帧直接跳过（不渲染、只继续排队），降低 GPU 占用
        const fps = rt.cfg.sceneFps || 60;
        if (now - lastRender >= 1000 / fps) {
          lastRender = now;
          markFrame(rt, now);
          syncCanvasSize(rt, c, rt.cfg);
          refreshTex?.();
          const peek = rt.coverAlign;
          void renderer
            .render(
              scene,
              textures,
              c.width,
              c.height,
              (now - start - pauseAccum) / 1000,
              normalizeFit(rt.cfg.fit),
              peek.x,
              peek.y,
            )
            .then(() => {
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
              if (disposed || rt.paused) return;
              rt.raf = requestAnimationFrame(renderLoop);
            })
            .catch((e: Error) => fail(String(e.message || e).slice(0, 200)));
        } else if (!rt.paused) {
          rt.raf = requestAnimationFrame(renderLoop);
        }
      };
      const kickLoop = () => {
        if (disposed || rt.paused) return;
        if (rt.raf !== undefined) return;
        rt.raf = requestAnimationFrame(renderLoop);
      };
      pauseImpl = () => {
        if (rt.raf !== undefined) {
          cancelAnimationFrame(rt.raf);
          rt.raf = undefined;
        }
        if (!pauseStarted) pauseStarted = performance.now();
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
        kickLoop();
      };
      kickLoop();
    } catch (e) {
      fail(String((e as Error).message || e).slice(0, 200));
    }
  })();
}

// ---------- 视频：DOM 直显路径 ----------

/**
 * 视频壁纸挂到哪个容器。
 *
 * 与 web.ts 的 resolveContainer 同构：全屏适配层画在 wrap 里；库形态优先用
 * 调用方给的空容器，给的是 canvas 就退到它父元素（canvas 不能有子节点）。
 * 少了这一步，库形态下 `rt.wrap?.appendChild` 是 no-op —— 元素永远看不见。
 */
function resolveVideoContainer(rt: Runtime, cfg: WallpaperConfig): HTMLElement | null {
  if (rt.wrap) return rt.wrap;
  const el = cfg.canvas as HTMLElement | undefined;
  if (!el) return null;
  if (el instanceof HTMLCanvasElement) return el.parentElement;
  return el;
}

/**
 * 视频壁纸：`<video>` 直接显示，不经 WebGL 纹理。
 *
 * 这是视频类型的**默认路径**（不再只是无 WebGL2 时的回退）。相比走场景引擎：
 *
 *  · 清晰度：绕开渲染器视频纹理分支的尺寸上限，浏览器按自己的显示尺寸直接
 *    硬件解码合成 —— 4K 源不再被降采样后再放大；
 *  · 内存：省掉一整个 WebGL 上下文，以及每帧一次全画布 texImage2D 上传；
 *  · 循环：用 A/B 双元素无缝循环（见 video-loop.ts）。实测 3840×2160@60fps
 *    的 12s 素材，循环点最坏帧间隔从 84ms 降到 33ms，而进程 RSS 峰值只从
 *    128MB 升到 130MB —— 备用元素平时不赋 src、只在结尾 0.5s 窗口预热保温，
 *    所以并不是"双份解码器常驻"。
 *
 * 代价是没有场景引擎能力（效果链、粒子叠加）。纯视频壁纸本来也用不到那些；
 * 真需要给视频加效果的是「场景内的视频纹理层」，那条路径不受本函数影响。
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
    /** 销毁 WebCodecs 实例并回退 A/B 路径（rt 已 clear 时静默作废） */
    const fallbackToAb = (why: string) => {
      if (!pathActive) return;
      pathActive = false;
      player?.destroy();
      player = null;
      reportDiag(rt, cfg, `media video: ${why}，回退 A/B <video>`);
      mountAbPair();
    };
    player = mountWebCodecsVideo({
      src: cfg.src,
      container,
      cssText: css,
      fit: () => normalizeFit(rt.cfg.fit),
      fps: () => rt.cfg.sceneFps || 60,
      paused: () => !!rt.paused,
      renderDpr: cfg.renderDpr,
      onFirstFrame: signalFirstFrame,
      onFrame: () => markFrame(rt, performance.now()),
      onDiag: (m) => reportDiag(rt, cfg, `media video(webcodecs): ${m}`),
      onFatal: (why) => fallbackToAb(`WebCodecs 路径失败（${why}）`),
    });
    // 暂停/恢复走 sceneCtl（与场景路径同一套钩子，mount.ts 统一调用）
    rt.sceneCtl = {
      pause: () => player?.pause(),
      resume: () => player?.resume(),
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
  const dpr = Math.min(window.devicePixelRatio || 1, cfg.renderDpr ?? rt.cfg?.renderDpr ?? 1);
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
