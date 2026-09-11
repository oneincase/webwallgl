// WebCodecs 视频壁纸：mediabunny demux → VideoDecoder → canvas 逐帧调度。
//
// 为什么存在（与 <video> A/B 无缝循环并存的分工）：
// 元素级 API 在 WKWebView 里有整类不确定性 —— 冷管线 play() 到出帧可达 ~1s、
// ended 事件可能丢失、系统节能会静默 pause 元素（均已在 video-loop.ts 打满
// 补丁兜底）。WebCodecs 路径把解码与呈现完全收归自己调度：
//   - 循环点 = 队列消费回绕，帧级精确，没有任何事件/状态机可丢失
//   - 帧率上限真正生效（<video> 的解码率由内容决定，HTML 无限帧 API）
//   - 暂停/恢复是纯粹的时钟操作
// 代价是音轨被整体忽略（音画同步需要另建 AudioContext 泵），所以本路径只在
// 「静音 + 循环 + WebCodecs 可用」时启用；有声/不循环/不支持时回退 A/B
// <video> 路径（见 media.ts mountVideoDom）。

import {
  ALL_FORMATS,
  Input,
  UrlSource,
  VideoSampleSink,
  type VideoSample,
} from "mediabunny";

export function supportsWebCodecsVideo(): boolean {
  return typeof VideoDecoder === "function" && typeof VideoFrame === "function";
}

export type WebCodecsVideoOpts = {
  src: string;
  container: HTMLElement;
  /** 显示 canvas 的定位样式（与 <video> 路径同一套 inset:0 铺满） */
  cssText: string;
  /** 每帧读取，宿主热更立即生效 */
  fit: () => "cover" | "contain" | "stretch";
  /** 帧率上限（rt.cfg.sceneFps），每帧读取 */
  fps: () => number;
  /** 宿主全局暂停态（时钟停摆 + 解码泵限流） */
  paused: () => boolean;
  /** 渲染分辨率上限（有效 dpr 封顶），越低越省 VRAM */
  renderDpr?: number;
  onFirstFrame?: () => void;
  /** 每呈现一个新帧回调（宿主 markFrame 打点，帧率表/判活都靠它） */
  onFrame?: () => void;
  /** 不可恢复错误（初始化解不了 / 解码泵异常）：调用方回退 A/B <video> */
  onFatal: (why: string) => void;
  onDiag?: (msg: string) => void;
};

export type WebCodecsVideoPlayer = {
  readonly canvas: HTMLCanvasElement;
  pause(): void;
  resume(): void;
  destroy(): void;
};

/** 解码前瞻队列初始深度（帧）：覆盖循环点 seek 回绕的解码空窗 */
const QUEUE_MIN = 6;
/** 前瞻深度上限：循环点 underrun 时自适应 +2 直到该值（VRAM 与解码器池压力封顶） */
const QUEUE_MAX = 16;

export function mountWebCodecsVideo(opts: WebCodecsVideoOpts): WebCodecsVideoPlayer {
  const canvas = document.createElement("canvas");
  canvas.style.cssText = opts.cssText;
  opts.container.appendChild(canvas);
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) {
    canvas.remove();
    // 同步失败也走异步回调，保持调用方时序一致
    queueMicrotask(() => opts.onFatal("2d 上下文创建失败"));
    return { canvas, pause() {}, resume() {}, destroy() {} };
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  let disposed = false;
  let raf = 0;
  // 播放时钟：mediaTime = lapStart + ((now - clockBase)/1000 % lapDur)。
  // 暂停 = 恢复时把 clockBase 向后平移暂停时长，纯时钟操作。
  let clockBase = performance.now();
  let pausedAt = 0;
  let isPaused = false;

  const sizeCanvas = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, opts.renderDpr || 1);
    const w = Math.max(1, Math.round((opts.container.clientWidth || window.innerWidth) * dpr));
    const h = Math.max(1, Math.round((opts.container.clientHeight || window.innerHeight) * dpr));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
  };
  sizeCanvas();
  window.addEventListener("resize", sizeCanvas);

  const queue: VideoSample[] = [];
  let input: Input | null = null;
  let sink: VideoSampleSink | null = null;
  // 直接持有 mediabunny 的内层迭代器（不经生成器包装）：销毁时必须能
  // 确定性地调 return() 终止解码泵，见 destroy()
  let innerIter: AsyncGenerator<VideoSample, void, unknown> | null = null;
  let lapStart = 0;
  let lapDur = 0;
  let queueTarget = QUEUE_MIN;
  let underrunFrames = 0;
  let underrunGrowReported = false;
  let lastDrawnTs = -1;
  let lastDrawAt = 0;
  let firstFrameSignalled = false;

  const drawFit = (s: VideoSample) => {
    const cw = canvas.width;
    const ch = canvas.height;
    const vw = s.displayWidth;
    const vh = s.displayHeight;
    if (cw <= 0 || ch <= 0 || vw <= 0 || vh <= 0) return;
    const fit = opts.fit();
    if (fit === "stretch") {
      s.draw(ctx, 0, 0, cw, ch);
      return;
    }
    const scale = fit === "cover" ? Math.max(cw / vw, ch / vh) : Math.min(cw / vw, ch / vh);
    const dw = Math.round(vw * scale);
    const dh = Math.round(vh * scale);
    const dx = Math.round((cw - dw) / 2);
    const dy = Math.round((ch - dh) / 2);
    if (fit === "contain") {
      // 清黑边：canvas alpha:false，fillRect 即纯黑信箱
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, cw, ch);
    }
    // cover 超出画布的部分由 2d 上下文自动裁掉
    s.draw(ctx, dx, dy, dw, dh);
  };

  const mediaTime = () => lapStart + (((performance.now() - clockBase) / 1000) % lapDur);

  /** 队列空了（解码泵没跟上，多发生在循环点 seek 回绕）：自适应加深前瞻 */
  const onUnderrun = () => {
    underrunFrames++;
    if (queueTarget < QUEUE_MAX && underrunFrames % 30 === 1) {
      queueTarget = Math.min(QUEUE_MAX, queueTarget + 2);
      if (!underrunGrowReported && queueTarget >= QUEUE_MIN + 4) {
        underrunGrowReported = true;
        opts.onDiag?.(`循环点解码空窗，前瞻加深至 ${queueTarget} 帧`);
      }
    }
  };

  const frame = () => {
    if (disposed) return;
    raf = requestAnimationFrame(frame);
    if (isPaused || opts.paused() || lapDur <= 0) return;
    const t = mediaTime();
    // 消费过期样本：保留最后一个 timestamp <= t 的作为待呈现帧。
    // 循环回绕时 t 骤小，队首若来自上一圈（timestamp 接近片尾）会被批量丢弃，
    // 新一圈的帧从队尾补上 —— 这就是无缝循环点：没有任何状态机参与。
    while (queue.length > 0) {
      const head = queue[0];
      const next = queue[1];
      // 上一圈遗留的尾帧（回绕后 timestamp 远大于 t）：必须最先丢弃 ——
      // 否则它会被判成「队首在未来」永久堵住整队，循环点即冻结。
      // 正常队首是当前/下一帧，timestamp - t 至多一帧时长，远大于半圈
      // 只会是上一圈的遗留。
      if (head.timestamp - t > lapDur / 2) {
        head.close();
        queue.shift();
        continue;
      }
      if (next && next.timestamp <= t + 1e-4) {
        head.close();
        queue.shift();
        continue;
      }
      break;
    }
    const head = queue[0];
    if (!head) {
      onUnderrun();
      return;
    }
    if (head.timestamp > t + 1e-4) return; // 队首在未来：上一帧继续停留
    if (head.timestamp === lastDrawnTs) return; // 没有新帧
    const cap = opts.fps();
    const now = performance.now();
    // 帧率上限：DOM <video> 路径给不了的能力，在这里是自然的
    if (cap > 0 && now - lastDrawAt < 1000 / cap - 0.5) return;
    lastDrawnTs = head.timestamp;
    lastDrawAt = now;
    try {
      drawFit(head);
    } catch {
      return; // 绘制瞬时失败（如 resize 途中）：下一帧重试，不判死
    }
    opts.onFrame?.();
    if (!firstFrameSignalled) {
      firstFrameSignalled = true;
      opts.onFirstFrame?.();
    }
  };

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** 解码泵：保持前瞻队列有水位。背压靠 queueTarget，暂停时限流不空转。
      一圈迭代自然结束即开新一圈（循环点 seek 回起点由 sink 处理）。 */
  const pump = async () => {
    try {
      while (!disposed) {
        while (!disposed && (queue.length >= queueTarget || isPaused || opts.paused())) {
          await sleep(20);
        }
        if (disposed) return;
        if (!innerIter) innerIter = sink!.samples(lapStart);
        const r = await innerIter.next();
        if (disposed) {
          // 销毁途中到达的样本同样要 close（VideoFrame 是 GPU 资源）
          r.value?.close();
          return;
        }
        if (r.done) {
          innerIter = null;
          continue;
        }
        queue.push(r.value);
      }
    } catch (e) {
      if (!disposed) opts.onFatal(`解码泵异常: ${(e as Error)?.message ?? e}`);
    }
  };

  void (async () => {
    try {
      input = new Input({ source: new UrlSource(opts.src), formats: ALL_FORMATS });
      const track = await input.getPrimaryVideoTrack();
      if (!track) throw new Error("无视频轨");
      if (!(await track.canDecode())) throw new Error(`编码不可解（${track.codec}）`);
      const dur = await track.computeDuration();
      lapStart = await track.getFirstTimestamp();
      // computeDuration 对绝大多数从 0 开始的文件即片长；非零起点文件取不到
      // 精确的「末帧结束 - 首帧开始」，取大者兜底，时钟模数偏差亚帧级
      lapDur = Math.max(dur - lapStart, dur > 0 ? dur : 0);
      if (!isFinite(lapDur) || lapDur <= 0) throw new Error("时长异常");
      if (disposed) {
        try {
          input.dispose();
        } catch {
          /* 忽略 */
        }
        return;
      }
      sink = new VideoSampleSink(track);
      const vw = await track.getDisplayWidth();
      const vh = await track.getDisplayHeight();
      opts.onDiag?.(`${track.codec} ${vw}x${vh} ${lapDur.toFixed(2)}s → WebCodecs 逐帧调度`);
      void pump();
      raf = requestAnimationFrame(frame);
    } catch (e) {
      if (!disposed) opts.onFatal((e as Error)?.message ?? String(e));
    }
  })();

  return {
    canvas,
    pause() {
      if (isPaused) return;
      isPaused = true;
      pausedAt = performance.now();
    },
    resume() {
      if (!isPaused) return;
      isPaused = false;
      clockBase += performance.now() - pausedAt;
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      window.removeEventListener("resize", sizeCanvas);
      for (const s of queue.splice(0)) {
        try {
          s.close();
        } catch {
          /* 忽略 */
        }
      }
      // 直接调内层迭代器的 return() 终止解码泵。不能依赖「生成器 return()
      // 透传」：若解码泵正挂在一个永不 settle 的 next() 上（壁纸窗口被遮挡
      // 时 WKWebView 节流 VideoDecoder 回调 —— 切壁纸恰恰常发生在用户打开
      // 主界面、壁纸被完全遮挡的时刻），透传的 return 会永远排在那个 next
      // 后面，解码器/样本队列/输入全部泄漏。内层迭代器的 return 会置
      // terminated 并唤醒解码泵退出（mediabunny 在 finally 里 close 解码器）。
      if (innerIter) void innerIter.return(undefined).catch(() => {});
      // 双保险：dispose 输入，仍挂起的读取/迭代以 InputDisposedError 收场
      try {
        input?.dispose();
      } catch {
        /* 忽略 */
      }
      canvas.remove();
    },
  };
}
