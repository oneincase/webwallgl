// 无缝循环视频：A/B 双元素「预热-爬行-拨速交接」（从 main.ts 拆出）

// ---------- 无缝循环视频（A/B 双元素：预热-爬行-拨速交接） ----------
// WebKit 的 <video loop> 在循环点会重置解码管线（ended → seek 0 → 重新起播），
// 造成 0.1~0.5s 的短暂冻结。双元素方案的难点在交接瞬间：备用必须「正在播放」
// 且「位置≈首帧」——暂停保温的唤起有 1~2 帧延迟，提前实播又有内容跳跃和
// 双路 4K 解码争抢（v2/v3 各踩一个）。
//
// 解法是让备用以极慢速率**爬行**：主元素剩 ~0.12s 时，备用从 0 开始以 1/8
// 速率实际播放——媒体管线全程处于 playing 态（没有任何状态转换），但 0.12s
// 里只前进约 1 帧（藏在主元素下面，观众不可见）。主元素 ended（精确到帧）
// 一触发：备用速率拨回 1x + 交换层级，同一个事件处理器里同步完成。速率切换
// 是纯时钟操作，不涉及解码器/合成器状态转换 —— **零唤醒、零定格、跳跃≈1帧**。
//
// 兜底：备用未就绪时保持原生 loop（旧式微卡顿，不会中断或黑屏）。
//
// WKWebView 适配（v5）：play() 返回到真正出帧的延迟在 WKWebView 里可达 ~1s
//（Chrome 几乎即时；壁纸窗口走 WKWebView，表现为每圈交接处卡 ~1s）。因此：
// ① 爬行提前量按实测出帧延迟自适应放大（0.12s 起步，最大 1s）；
// ② 备用**确认出帧前不关主元素的原生 loop** —— 关早了，淡出一完成露出的
//    是还没出帧的定格首帧；不关顶多原生回绕（旧式微卡顿）；
// ③ 交接后给自愈看门狗留宽限，否则暖管期必被误判「假播放」遭到踢醒/seek/
//    重载轮番干预，把 ~0.1s 的暖管拖成 ~1s 的每圈卡顿。

/// 预热窗口（秒）：主元素剩多少秒时给备用赋 src / seek 0 做就绪准备。
const LOOP_PREROLL_SEC = 0.5;
/// 爬行窗口（秒）：主元素剩多少秒时备用开始慢速播放。
const LOOP_CRAWL_LEAD_SEC = 0.12;
/// 爬行速率：0.12s × 1/8 ≈ 前进 0.015s（≈1 帧 @60fps）——交接时的内容跳跃
/// 压到一个物理帧以内。管线保持 playing 态，这是本方案的核心。
const LOOP_CRAWL_RATE = 0.125;
/// 慢档爬行速率：提前量自适应放大后仍用 1/8，交接跳跃会到 ~4 帧；
/// 降档把跳跃压回 ~2 帧以内（WebKit playbackRate 低于 ~0.06 视同暂停）。
const LOOP_CRAWL_RATE_SLOW = 0.0625;
/// 交接淡出时长（毫秒）：旧主元素（已定格在末帧）淡出、露出下层已在运动的
/// 新主元素。~4 帧的融合窗口足以掩掉元素级交接的全部 1~3 帧不精度。
const LOOP_FADE_MS = 64;

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
  /** 自愈动作回调（踢 play / seek 重启 / 管线重载），供宿主诊断上报 */
  onRecover?: (msg: string) => void;
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
  let crawling = false; // 备用已进入慢速爬行（管线 playing 态，位置停在首帧附近）
  let fading = false; // 交接淡出进行中（上层旧主元素 opacity → 0）
  let fadeTimer: number | undefined;
  let stallT = -1; // 看门狗：上一帧的 currentTime（检测假播放/解码停摆）
  let stallFrames = 0; // 看门狗：currentTime/暂停态连续未变的 rAF 帧数
  let crawlStartedAt = 0; // 进入爬行的时刻：ended 丢失时按超时强制交接
  let crawlLead = LOOP_CRAWL_LEAD_SEC; // 爬行提前量（按实测出帧延迟自适应，≤1s）
  let standbyConfirmed = false; // 备用已确认出帧（currentTime 真的在走）
  let crawlPlayAt = 0; // 备用 play() 发起时刻（测管线启动延迟）
  let stallGraceUntil = 0; // 交接后自愈看门狗宽限期（performance.now() 毫秒）
  let recoverStage = 0; // 自愈升级阶梯：1 踢 play、2 seek 重启解码、3 重载媒体管线
  let lastRecoverAt = 0; // 自愈动作节流（performance.now() 毫秒）
  let loopOff: HTMLVideoElement | undefined; // 被关掉原生 loop 的主元素（保温后设置，复位时还原）
  let prevTime = -1; // 主元素上一帧时间，用于检测原生循环回绕
  let raf = 0;
  let destroyed = false;

  /** ended 处理：只有主元素会触发（爬行后 loop 已关）；备用触发即忽略 */
  const handleEnded = (el: HTMLVideoElement) => {
    if (destroyed || el !== active) return;
    if (!crawling || !standbyConfirmed) {
      // 备用没确认出帧就到了结尾（loop 现在只在确认后才关，正常不会发生；
      // 防御 ended 丢失兜底与事件乱序）：退回原生循环 —— 末帧瞬间回绕
      // 远好于淡出一个还没出帧的首帧定格 ~1s
      disarm();
      el.loop = true;
      void el.play().catch(() => {});
      pair.onFallback?.();
      return;
    }
    // 交接：下层备用已在动（爬行→拨回 1x，纯时钟操作零唤醒）。上层旧主元素
    // **快速淡出**而不是硬切 —— 元素级 API 的 1~3 帧不精度（ended 分发、换层
    // 合成）全部被淡变掩掉：对无缝循环内容两层几乎一致，淡出过程本身不可见；
    // 观众视线跟着下层"继续运动"的内容走，定格/跳跃不再存在。
    standby.playbackRate = 1;
    const prev = active;
    fading = true;
    prev.style.transition = `opacity ${LOOP_FADE_MS}ms linear`;
    prev.style.opacity = "0";
    let done = false;
    const finish = () => {
      if (done || destroyed) return;
      done = true;
      fading = false;
      prev.style.transition = "";
      doSwap();
      // prev 已成为下层备用（被上层盖住）：恢复不透明，供下一圈爬行使用
      prev.style.opacity = "1";
    };
    prev.addEventListener("transitionend", finish, { once: true });
    // transitionend 可能因节流不派发：超时兜底
    fadeTimer = window.setTimeout(finish, LOOP_FADE_MS + 80);
  };

  const disarm = () => {
    crawling = false;
    crawlStartedAt = 0;
    standbyConfirmed = false;
    if (fading) {
      // 淡出中途被打断（seek/暂停）：恢复上层不透明，回到稳态
      fading = false;
      if (fadeTimer) {
        clearTimeout(fadeTimer);
        fadeTimer = undefined;
      }
      active.style.transition = "";
      active.style.opacity = "1";
    }
    if (loopOff) {
      // 还原原生 loop 兜底姿态（此元素重新变回"没有备用保护"的主）
      loopOff.loop = true;
      loopOff = undefined;
    }
    if (!standby.paused) {
      standby.pause();
    }
    standby.playbackRate = 1;
    try {
      standby.currentTime = 0;
    } catch {
      /* 忽略 */
    }
  };

  const doSwap = () => {
    const prev = active;
    active = standby;
    standby = prev;
    crawling = false;
    crawlStartedAt = 0;
    standbyConfirmed = false;
    stallFrames = 0;
    stallT = -1;
    // 新主元素从 0 起播：上一轮的恢复阶梯对它无意义，归零重新计数
    recoverStage = 0;
    lastRecoverAt = 0;
    // WKWebView 把爬行拨回 1x 后帧推进有实测级延迟（管线刚暖起来）。给自愈
    // 看门狗留宽限：否则交接瞬间必被误判「假播放」，踢 play → seek → 重载
    // 轮番干预，把本来 ~0.1s 的暖管拖成 ~1s 的每圈卡顿
    stallGraceUntil = performance.now() + Math.max(800, crawlLead * 1000 + 300);
    // 新主元素在爬行阶段就已经在播放，速率也已拨回 1x；仅当意外暂停时兜底拉起
    if (active.paused) void active.play().catch(() => {});
    if (active.playbackRate !== 1) active.playbackRate = 1;
    active.muted = userMuted;
    active.volume = userVolume;
    // 旧主元素停在末帧：切走后归零静音、恢复原生 loop 兜底姿态，成为下一个备用
    prev.pause();
    prev.playbackRate = 1;
    try {
      prev.currentTime = 0;
    } catch {
      /* 忽略 */
    }
    prev.muted = true;
    prev.loop = true;
    prevTime = -1;
    // 交换后两边都已有 src；下一圈预热不再走延迟赋值
    standbySrcReady = true;
    pair.onSwap?.(active);
  };

  /**
   * 自愈恢复阶梯。冻结形态有两类，单一手段都救不全：
   * 轻踢（pause→play）对「假播放」的浅层停摆有效；解码器上下文坏死时要
   * seek 强制重建；整个媒体管线（含 VT 硬件会话）死掉时只能重载 src。
   * 逐级升级、每级间隔 ≥1s，时间重新走起来后阶梯自动归零（见 tick）。
   */
  const recover = (why: string, t: number) => {
    const now = performance.now();
    if (now - lastRecoverAt < 1000) return;
    lastRecoverAt = now;
    recoverStage++;
    stallFrames = 0;
    stallT = -1;
    if (recoverStage >= 3) {
      // 重载媒体管线（最后手段）：踢 play / seek 都唤不醒，说明解码器已
      // 不可救。重赋 src 让 WebKit 重建全部解码资源，loadedmetadata 后 seek
      // 回原位继续播 —— 会闪一次首帧，但好过永久冻结。
      recoverStage = 0;
      const pos = t;
      const el = active;
      opts.onRecover?.(`${why}：重载媒体管线 @${pos.toFixed(2)}s`);
      prevTime = -1; // 重载期间 currentTime 短暂归零，不算原生循环回绕
      el.addEventListener(
        "loadedmetadata",
        () => {
          if (destroyed || el !== active) return;
          try {
            el.currentTime = Math.max(0, Math.min(pos, (el.duration || pos) - 0.05));
          } catch {
            /* 忽略 */
          }
          void el.play().catch(() => {});
        },
        { once: true },
      );
      el.src = src;
      void el.play().catch(() => {});
      return;
    }
    if (recoverStage === 2) {
      // seek 重启：强制解码器重建当前帧的解码上下文，比 pause→play 狠一档
      opts.onRecover?.(`${why}：seek 重启解码 @${t.toFixed(2)}s`);
      try {
        active.currentTime = Math.max(0, t - 0.001);
      } catch {
        /* 忽略 */
      }
      void active.play().catch(() => {});
      return;
    }
    opts.onRecover?.(`${why}：踢 play`);
    active.pause();
    void active.play().catch(() => {});
  };

  const tick = () => {
    if (destroyed) return;
    raf = requestAnimationFrame(tick);
    const d = active.duration;
    if (!isFinite(d) || d <= 0) return;
    const t = active.currentTime;
    // 自愈看门狗，覆盖两种「永久冻结」形态：
    // ① 假播放：paused=false、readyState 正常，但解码停摆、时间不走
    //   （WebKit 对被遮挡/被回收过解码器的视频会内部节流，且**没有任何事件**
    //    可听；兜底 play() 之后也可能停在停摆态）。
    // ② 静默暂停：元素被系统节能/遮挡策略直接 pause（同样无可靠事件），
    //    旧看门狗只看 !paused 的形态，对这种永远不作为 → 壁纸永久定格。
    // 两种形态都靠「连续 ~500ms 无进展」发现，汇入恢复阶梯逐级处理。
    // 页面被遮挡时 WebKit 合法节流视频，不能误判 —— document.hidden 期间不踢。
    if (!document.hidden && !fading && performance.now() >= stallGraceUntil) {
      if (active.paused && !active.ended && active.readyState >= 1) {
        // 静默暂停。留 ~500ms 宽限，不与正常启动/交接中的 play() 抢
        stallFrames++;
        if (stallFrames > 30) recover("静默暂停", t);
      } else if (!active.paused && active.readyState >= 2) {
        if (stallT === t) {
          stallFrames++;
          if (stallFrames > 30) recover("假播放", t);
        } else {
          stallFrames = 0;
          recoverStage = 0; // 时间重新走了：恢复阶梯归位
        }
        stallT = t;
      } else {
        stallFrames = 0;
        stallT = -1;
      }
    } else {
      stallFrames = 0;
      stallT = -1;
    }
    // 时间回绕 = 交接失败、发生了原生兜底循环（loop 被还原的路径）：备用已爬行
    // 则立刻交接（仍近乎无缝），否则复位等下一圈（一次性上报 onFallback 便于诊断）
    if (prevTime >= 0 && t < prevTime - 0.05) {
      const hadStandby = crawling;
      const wasConfirmed = standbyConfirmed;
      disarm();
      prevTime = t;
      if (hadStandby && !wasConfirmed) {
        // 备用到点都没出帧（管线启动比爬行提前量还慢）：下一圈再提前
        crawlLead = Math.min(1, crawlLead * 2);
      }
      if (!hadStandby) pair.onFallback?.();
      return;
    }
    prevTime = t;
    const remaining = d - t;
    // 预热窗口随爬行提前量自适应：提前量放大到 ~1s 后，0.5s 的预热会把
    // src 赋值/首帧加载挤进爬行窗口，白丢一半暖管时间
    const preroll = Math.max(LOOP_PREROLL_SEC, crawlLead + 0.5);
    // 远离结尾：复位预热状态（兜底循环后 / seek 后都会经过这里）
    if (remaining > preroll + 0.5) {
      if (crawling) disarm();
      return;
    }
    if (crawling) {
      // 备用爬行中。play() 返回 ≠ 帧在解码：WKWebView 冷管线从 play() 到
      // 实际出帧可达 ~1s（Chrome 几乎即时）。**确认出帧前不关主元素的原生
      // loop** —— 关早了，ended 后下层是还没出帧的备用，淡出露出定格首帧，
      // 就是 WKWebView 里每圈 ~1s 的卡顿；不关顶多原生回绕（微卡顿），
      // 且回绕分支会把提前量翻倍，下一圈重试。
      if (!standbyConfirmed && standby.currentTime > 0.004) {
        standbyConfirmed = true;
        // 实测管线启动延迟 → 自适应下一圈的爬行提前量（×1.5 余量 + 0.15s）
        const latency = performance.now() - crawlPlayAt;
        crawlLead = Math.min(1, Math.max(LOOP_CRAWL_LEAD_SEC, (latency / 1000) * 1.5 + 0.15));
        if (loopOff !== active) {
          // 确认出帧才关主元素原生 loop（否则到点原地回绕，ended 不触发）
          active.loop = false;
          loopOff = active;
        }
      }
      // 兜底：ended 被节流/合并丢失时，「等 ended」就是永久等待 —— 主元素
      // 定格在末帧（paused=true，看门狗的 !paused 分支也够不着它）。主元素
      // 已自然结束（ended 属性为真）或爬行超过 ~1.5s 仍未交接（正常交接
      // 窗口 = 提前量≤1s + 淡出），手动补触发一次交接。未确认出帧不交接
      // （宁愿回绕也不露出定格首帧），交给回绕分支放大提前量。
      if (
        !fading &&
        standbyConfirmed &&
        (active.ended || (crawlStartedAt > 0 && performance.now() - crawlStartedAt > 1500))
      ) {
        handleEnded(active);
      }
      return;
    }
    // 临近结尾：备用解码器就绪才进入爬行，否则交给原生 loop 兜底
    if (remaining <= preroll) {
      ensureStandbySrc();
      if (standby.readyState >= 2) {
        if (remaining <= crawlLead) {
          // 爬行：从 0 以慢速实际播放，给管线留出实测级的暖管时间。提前量
          // 自适应（见确认分支）；主元素的原生 loop 移到确认出帧后才关
          try {
            standby.currentTime = 0;
          } catch {
            /* 忽略 */
          }
          standby.playbackRate = crawlLead > 0.3 ? LOOP_CRAWL_RATE_SLOW : LOOP_CRAWL_RATE;
          crawlPlayAt = performance.now();
          standbyConfirmed = false;
          void standby.play().catch(() => {});
          crawling = true;
          crawlStartedAt = performance.now();
        } else if (standby.paused) {
          // 就绪准备：seek 到 0 让首帧解码进合成器
          try {
            standby.currentTime = 0;
          } catch {
            /* 忽略 */
          }
        }
      }
    }
  };
  raf = requestAnimationFrame(tick);
  // 两个元素都挂 ended：只有 loop 被关掉的当前主元素会触发，备用的被 loop 吞掉
  active.addEventListener("ended", () => handleEnded(active));
  standby.addEventListener("ended", () => handleEnded(standby));

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
