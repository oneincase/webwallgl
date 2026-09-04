// 媒体类壁纸（从 main.ts 拆出）：视频 / 图片 / GIF 合成单图层场景走 we-scene 渲染，
// WebGL2 缺失时回退 DOM 路径。
import { clear, effectiveDpr, fitObjectFit, markFrame, normalizeFit, reportDiag, syncCanvasSize, type Runtime } from "./shell";
import { createLoopingVideo } from "./video-loop";
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
      bitmap: await createImageBitmap(image),
      // duration 单位是微秒；缺失/为 0 的帧按 GIF 惯例给 100ms
      durationMs: image.duration ? image.duration / 1000 : 100,
    });
    image.close();
  }
  dec.close?.();
  return { width, height, frames };
}

export function mountMedia(rt: Runtime, cfg: WallpaperConfig) {
  clear(rt);
  if (!cfg.src) {
    rt.fallbackPage?.();
    return;
  }
  const isVideo = cfg.type === "video";
  const isGif = cfg.type === "gif";

  const c = document.createElement("canvas");
  const dpr = effectiveDpr(rt, cfg);
  c.width = Math.max(1, Math.round(innerWidth * dpr));
  c.height = Math.max(1, Math.round(innerHeight * dpr));
  c.style.cssText = "position:absolute;inset:0;width:100%;height:100%;";
  const gl2 = c.getContext("webgl2", {
    premultipliedAlpha: false,
    antialias: false,
    alpha: false,
    preserveDrawingBuffer: true,
  });
  if (!gl2) {
    // 无 WebGL2：回退 DOM 路径，媒体壁纸照常显示（只是拿不到场景引擎的能力）
    reportDiag(rt, cfg, `media ${cfg.type}: WEBGL2_UNAVAILABLE，回退 DOM 渲染`);
    if (isVideo) mountVideoDom(rt, cfg);
    else mountGifDom(rt, cfg);
    return;
  }
  rt.wrap?.appendChild(c);
  rt.canvas = c;
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
    reportDiag(rt, cfg, `media ${cfg.type} 失败: ${why}`);
    rt.fallbackPage?.();
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

      if (isVideo) {
        const v = document.createElement("video");
        v.autoplay = true;
        v.loop = cfg.loop !== false; // 默认循环；loop=false 则播完即停
        v.muted = cfg.muted !== false;
        v.playsInline = true;
        // preload=metadata：只拉元数据，避免 WebKit 预下载整个视频文件进内存
        v.preload = "metadata";
        // 限制解码分辨率：按画布尺寸而非视频原始分辨率解码，4K 源在 1080p 窗口上
        // 解码缓冲约降到 1/4（清晰度由采样阶段的缩放决定）
        v.width = c.width;
        v.height = c.height;
        // 画面走 WebGL 纹理，元素自身不参与显示（但必须在文档内才会持续解码）
        v.style.cssText =
          "position:fixed;left:-9999px;top:-9999px;width:2px;height:2px;opacity:0;pointer-events:none";
        v.src = cfg.src!;
        document.body.appendChild(v);
        rt.video = v;
        (rt.videoTextures ??= []).push(v);
        await new Promise<void>((ok, err) => {
          v.addEventListener("loadedmetadata", () => ok(), { once: true });
          v.addEventListener("error", () => err(new Error(`video error ${v.error?.code ?? "?"}`)), {
            once: true,
          });
        });
        if (disposed) return;
        mediaW = v.videoWidth || c.width;
        mediaH = v.videoHeight || c.height;
        // entry.video 交给渲染器的视频纹理分支：帧时间戳变化时自动上传
        textures.set(TEX, {
          video: v,
          glTex: rnd.makeTexture(renderer.gl, new Uint8Array([0, 0, 0, 255]), 1, 1),
          width: mediaW,
          height: mediaH,
          rg88: false,
          lastUploaded: -1,
        });
        if (!rt.paused) void v.play().catch(() => {});
        reportDiag(rt, cfg, `media video ${mediaW}x${mediaH} → scene 渲染`);
      } else {
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

// ---------- 视频 / 图片：DOM 回退路径（无 WebGL2 时使用）----------

export function mountVideoDom(rt: Runtime, cfg: WallpaperConfig) {
  clear(rt);
  if (!cfg.src) {
    rt.fallbackPage?.();
    return;
  }
  const fit = fitObjectFit(cfg.fit);
  const css =
    "position:absolute;inset:0;width:100%;height:100%;" +
    `object-fit:${fit.objectFit};object-position:50% 50%;background:${fit.background};`;
  let fellBack = false;
  const onErr = () => {
    if (fellBack) return;
    fellBack = true;
    console.warn("video error, fallback to default wallpaper");
    rt.fallbackPage?.();
  };

  // 单视频 + 原生 loop（放弃无缝循环双元素方案）。
  // 内存减半（不再有备用 standby 解码器）；代价是循环点 0.1~0.5s 轻微冻结。
  const v = document.createElement("video");
  v.autoplay = true;
  v.loop = cfg.loop !== false; // 默认循环；loop=false 则播完即停
  v.muted = cfg.muted !== false;
  v.playsInline = true;
  // preload=metadata：只拉元数据，避免 WebKit 预下载整个视频文件进内存
  v.preload = "metadata";
  // 限制解码分辨率：按「窗口尺寸 × 有效 dpr」解码，而非视频原始分辨率。
  // WebKit 对超出显示尺寸的 video 会分配等比缩小的解码缓冲（4K 源在 1080p 窗口上
  // 解码缓冲约为 1/4），显著降低内存。不影响显示清晰度（object-fit 在 CSS 层面缩放）。
  const dprV = Math.min(window.devicePixelRatio || 1, rt.cfg.renderDpr || 1);
  v.width = Math.max(1, Math.round(innerWidth * dprV));
  v.height = Math.max(1, Math.round(innerHeight * dprV));
  v.style.cssText = css;
  v.src = cfg.src;
  v.addEventListener("error", onErr);
  rt.wrap?.appendChild(v);
  rt.video = v;
  v.addEventListener("canplay", () => v.play().catch(() => {}), { once: true });
  reportDiag(rt, cfg, "video mounted (single + native loop)");
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
