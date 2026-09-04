// 无缝循环视频：A/B 双元素「预热-保温-结尾交接」（从 main.ts 拆出）

// ---------- 无缝循环视频（A/B 双元素：预热-保温-结尾交接） ----------
// WebKit 的 <video loop> 在循环点会重置解码管线（ended → seek 0 → 重新起播），
// 造成 0.1~0.5s 的短暂冻结（缓冲再充分也躲不掉）。方案：主/备两个同源 <video>：
//   1) 预热：主元素临近结尾时，备用元素起播一两帧后**暂停保温**——解码器已热、
//      合成器已持有其当前帧（交接零延迟），且不会长时间双路解码；
//   2) 交接：主元素真正到达结尾的一瞬（≤2~5 帧内）恢复备用播放并交换主备，
//      切换点即真实循环点，内容不跳跃；
//   3) 旧主元素暂停归零静音保温，成为下一个备用（保温期静音避免双声）。
// 备用未及时就绪时退回原生 loop 兜底（只是旧式微卡顿，不会中断）。

/// 预热窗口（秒）：主元素剩多少秒时启动备用预热。
const LOOP_PREROLL_SEC = 0.5;
/// 预热起播到多少秒后暂停保温（≈1~2 帧，帧已解码）。
const LOOP_HOLD_SEC = 0.04;
/// 主元素离结尾多少秒内执行交接（≈2~5 帧）。
const LOOP_SWAP_EPS = 0.08;

export type VideoLoopPair = {
  readonly active: HTMLVideoElement;
  readonly standby: HTMLVideoElement;
  /** 每次主备交换回调（参数为新主元素），用于同步可见性/纹理引用 */
  onSwap?: (active: HTMLVideoElement) => void;
  /** 兜底触发回调：备用未就绪、发生原生循环回绕时调用 */
  onFallback?: () => void;
  setVolume(vol: number): void;
  pause(): void;
  resume(): void;
  destroy(): void;
};

export type VideoLoopOpts = {
  muted: boolean;
  /** 解码分辨率上限：直接给 renderDpr，按显示尺寸 × dpr 折算解码缓冲 */
  renderDpr?: number;
  /** 显示尺寸（canvas 的 clientWidth/Height）。缺省回退窗口尺寸 */
  maxW?: number;
  maxH?: number;
};

export function createLoopingVideo(src: string, opts: VideoLoopOpts): VideoLoopPair {
  const make = (assignSrc: boolean): HTMLVideoElement => {
    const v = document.createElement("video");
    // 备用元素延迟赋 src：两个 <video> 同时拉同一 blob 时，WebKit 会把
    // 先发出的 play() 用 pause/load 打断（AbortError）。预热窗口才给备用赋 src。
    if (assignSrc) v.src = src;
    v.muted = opts.muted;
    v.playsInline = true;
    // preload=metadata：只拉元数据，避免 WebKit 预下载整个视频文件进内存
    v.preload = "metadata";
    // 限制解码分辨率：按「显示尺寸 × 有效 dpr」解码，而非视频原始分辨率。
    // WebKit 对超出显示尺寸的 video 会分配等比缩小的解码缓冲（4K 源在 1080p 窗口上
    // 解码缓冲约为 1/4），显著降低内存。不影响显示清晰度（object-fit 在 CSS 层面缩放）。
    const dpr = Math.min(window.devicePixelRatio || 1, opts.renderDpr || 1);
    const maxW = Math.max(1, Math.round((opts.maxW || innerWidth) * dpr));
    const maxH = Math.max(1, Math.round((opts.maxH || innerHeight) * dpr));
    v.width = maxW;
    v.height = maxH;
    // 兜底：预热/交接失败时退回原生循环（只是旧式微卡顿，不会中断或黑屏）
    v.loop = true;
    return v;
  };

  let active = make(true);
  let standby = make(false);
  let standbySrcReady = false;
  let userVolume = 1;
  let userMuted = opts.muted;
  standby.muted = true; // 备用恒静音，避免交接期出双声
  const ensureStandbySrc = () => {
    if (standbySrcReady) return;
    standby.src = src;
    standbySrcReady = true;
  };
  let arming = false; // 备用已起播，等第一帧出现后暂停保温
  let held = false; // 备用已保温（暂停在起点附近、解码器热）
  let prevTime = -1; // 主元素上一帧时间，用于检测原生循环回绕
  let raf = 0;
  let destroyed = false;

  const disarm = () => {
    arming = false;
    held = false;
    if (!standby.paused) {
      standby.pause();
      try {
        standby.currentTime = 0;
      } catch {
        /* 忽略 */
      }
    }
  };

  const doSwap = () => {
    const prev = active;
    active = standby;
    standby = prev;
    arming = false;
    held = false;
    // 新主元素从保温点（≈循环点）恢复播放：解码器热、合成器已有帧 → 零延迟
    void active.play().catch(() => {});
    active.muted = userMuted;
    active.volume = userVolume;
    // 旧主元素暂停归零静音保温，成为下一个备用
    prev.pause();
    try {
      prev.currentTime = 0;
    } catch {
      /* 忽略 */
    }
    prev.muted = true;
    prevTime = -1;
    // 交换后两边都已有 src；下一圈预热不再走延迟赋值
    standbySrcReady = true;
    pair.onSwap?.(active);
  };

  const tick = () => {
    if (destroyed) return;
    raf = requestAnimationFrame(tick);
    const d = active.duration;
    if (!isFinite(d) || d <= 0) return;
    const t = active.currentTime;
    // 时间回绕 = 交接失败、发生了原生兜底循环：备用已保温则立刻交接（仍近乎无缝），
    // 否则复位等下一圈（一次性上报 onFallback 便于诊断）
    if (prevTime >= 0 && t < prevTime - 0.05) {
      const hadStandby = held;
      disarm();
      prevTime = t;
      if (!hadStandby) pair.onFallback?.();
      return;
    }
    prevTime = t;
    const remaining = d - t;
    // 远离结尾：复位预热状态（兜底循环后 / seek 后都会经过这里）
    if (remaining > LOOP_PREROLL_SEC + 0.5) {
      if (arming || held) disarm();
      return;
    }
    if (held) {
      // 备用保温待命：主元素到达结尾即交接
      if (remaining <= LOOP_SWAP_EPS || t <= LOOP_SWAP_EPS) doSwap();
      return;
    }
    if (arming) {
      if (!standby.paused) {
        // 起播出现帧即暂停保温
        if (standby.currentTime >= LOOP_HOLD_SEC * 0.5) {
          standby.pause();
          arming = false;
          held = true;
        }
      } else {
        // 起播被拒/未开始：重试（远离结尾时由上方复位）
        void standby.play().catch(() => {});
      }
      return;
    }
    // 临近结尾：备用解码器就绪才预热，否则交给原生 loop 兜底
    if (remaining <= LOOP_PREROLL_SEC) {
      ensureStandbySrc();
      if (standby.readyState >= 2) {
        try {
          standby.currentTime = 0;
        } catch {
          /* 忽略 */
        }
        void standby.play().catch(() => {});
        arming = true;
      }
    }
  };
  raf = requestAnimationFrame(tick);

  const pair: VideoLoopPair = {
    get active() {
      return active;
    },
    get standby() {
      return standby;
    },
    onSwap: undefined,
    onFallback: undefined,
    setVolume(vol: number) {
      userVolume = Math.max(0, Math.min(1, vol));
      userMuted = vol <= 0;
      active.muted = userMuted;
      active.volume = userVolume;
      // 备用保持静音（交接期防双声），但音量同步，交接后立即正确
      standby.muted = true;
      standby.volume = userVolume;
    },
    pause() {
      // 放弃未完成的预热：备用停掉归零，恢复时重新走预热流程
      disarm();
      active.pause();
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    },
    resume() {
      if (destroyed) return;
      void active.play().catch((e: unknown) => {
        // pause()/load()/切壁纸打断未完成的 play() 是浏览器预期（AbortError）
        if (e && (e as { name?: string }).name === "AbortError") return;
      });
      if (!raf) raf = requestAnimationFrame(tick);
    },
    destroy() {
      destroyed = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      for (const v of [active, standby]) {
        v.pause();
        // 关键：清掉 src 并 load()，触发 WebKit 释放解码器/解码缓冲区（仅 pause 不会归还内存）
        v.removeAttribute("src");
        try {
          v.load();
        } catch {
          /* 忽略 */
        }
        v.remove();
      }
    },
  };
  return pair;
}
