// 遮挡感知降载（V5）：宿主推遮挡矩形 → 精确可见比例（决策层，分档用）
// + 边对齐精确矩形分解（消费层，ROI 图层裁剪用）+ 分档状态机（带滞回）。
//
// 全部纯函数、零 DOM 依赖 —— 与 quality.ts 同纪律：离线可测（verify-occlusion
// 直接跑本文件），渲染循环只消费结果。坐标系约定：**画布 CSS 像素空间**，
// 左上原点、y 向下（宿主负责把显示器物理像素换算到窗口 CSS 像素，库不感知
// 窗口位置与 DPR —— 逐实例契约见 docs/OCCLUSION-ROI-FEASIBILITY.md）。
//
// 分层设计（为什么有两套几何）：
//   · 决策层（暂停/降帧）只需要一个比例 —— 用消费层分解的**精确**可见比例。
//     最初照 Lively v2.2.0 用均匀网格「碰到即覆盖」计数（95% 阈值），但网格
//     量化误差 = ±2 tile 边（1920×1080 下 ~12pp），远超 5pp 滞回带；内部大窗
//     边距 < 1 tile 时甚至触碰全部 tile，85% 真实可见算出 0 直跳暂停
//     （3463520581 拖动事故）。网格保留为 `gridCoverage` 对照读数（overlay
//     展示 Lively 语义），**不参与分档**；
//   · 消费层（E 方案 ROI 图层裁剪）需要**矩形列表** —— 精确分解 + 保守合并，
//     量化/滞回只是防抖手段。
//
// 语义红线（docs 里风险登记册的结论）：
//   · 合并只做「保守扩大」（over-draw）：漏画在 preserveDrawingBuffer 画布上
//     会留陈旧/黑像素且 ROI 抖动时肉眼可见，多画只损失收益不损失正确性。
//   · 帧率档位下限 20fps：粒子 dt 封顶 50ms / 脚本 animDt 封顶 0.05s 而关键帧
//     动画走未封顶场景 t，低于 20fps 两套时钟肉眼可辨地失步（「两套时钟」
//     事故族，见 scene-mount 粒子时钟注释）。

import type { OcclusionBandConfig, OcclusionBands, OcclusionPayload, OcclusionRect } from "./api/types";

// ---- 基础几何 ----

/** 轴对齐矩形（画布 CSS 像素，y 向下） */
export type Rect = { x: number; y: number; w: number; h: number };

export type Screen = { w: number; h: number };

/** 两矩形是否相交（严格重叠；边界接触不算 —— 分解侧接触格归入可见区，多画保守） */
function rectsIntersect(
  ax: number, ay: number, aw: number, ah: number,
  bx: number, by: number, bw: number, bh: number,
): boolean {
  return ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah;
}

/**
 * 归一化宿主推来的遮挡矩形：钳到画布范围、丢弃空/非法项。
 * 输入允许 [x,y,w,h] 四元组或 {x,y,w,h}；输出统一为四元组（轻、可直接比较）。
 */
export function normalizeOccluders(
  screen: Screen,
  raw: OcclusionPayload["occluders"] | null | undefined,
): OcclusionRect[] {
  const out: OcclusionRect[] = [];
  if (!raw || !Number.isFinite(screen.w) || !Number.isFinite(screen.h) || screen.w <= 0 || screen.h <= 0) {
    return out;
  }
  for (const r of raw) {
    const quad = Array.isArray(r) ? r : r && typeof r === "object" ? [r.x, r.y, r.w, r.h] : null;
    if (!quad) continue;
    let x = Number(quad[0]), y = Number(quad[1]), w = Number(quad[2]), h = Number(quad[3]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) continue;
    if (w <= 0 || h <= 0) continue;
    // 负偏移/越界：钳到画布（宿主坐标算错也别把可见区算没）
    const x0 = Math.max(0, Math.min(screen.w, x));
    const y0 = Math.max(0, Math.min(screen.h, y));
    const x1 = Math.max(0, Math.min(screen.w, x + w));
    const y1 = Math.max(0, Math.min(screen.h, y + h));
    if (x1 - x0 <= 0 || y1 - y0 <= 0) continue;
    out.push([x0, y0, x1 - x0, y1 - y0]);
  }
  return out;
}

// ---- 决策层：均匀网格覆盖率（Lively Grid Pause Algorithm 同款）----

/**
 * 屏幕均分为 tiles×tiles 网格，与任一遮挡矩形相交的 tile 记为被覆盖，
 * 覆盖率 = 被覆盖 tile 数 / 总数。tile「碰到即算」是保守方向：高估遮挡
 * → 暂停略偏早（安全），且 tile 边界天然量化，拖动时读数不抖。
 * tiles 取 16（对应 Lively 的默认粒度量级；可配）。
 */
export function computeGridCoverage(screen: Screen, occluders: OcclusionRect[], tiles = 16): number {
  const n = Math.max(2, Math.min(64, Math.floor(tiles) || 16));
  const tw = screen.w / n;
  const th = screen.h / n;
  if (!(tw > 0) || !(th > 0)) return 0;
  let covered = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x = i * tw, y = j * th;
      for (const o of occluders) {
        if (rectsIntersect(x, y, tw, th, o[0], o[1], o[2], o[3])) {
          covered++;
          break;
        }
      }
    }
  }
  return covered / (n * n);
}

// ---- 消费层：边对齐精确分解 ----

/**
 * 屏幕减去遮挡矩形并集的精确可见矩形分解。
 *
 * 做法（网格合并，评估报告 §3）：把全部遮挡矩形的 x/y 边缘坐标当网格线，
 * 建 (≤2N+1)² 个格子 —— 格子边界与遮挡边界对齐，所以每格**要么全被盖、
 * 要么全可见**（无量化误差）；再行内 run 合并 + 行间同列合并，输出矩形
 * 数典型 3~15 个（N≤10）。复杂度 O(N² log N)（区间合并实现），N 极小。
 */
export function decomposeVisibleRects(screen: Screen, occluders: OcclusionRect[]): Rect[] {
  if (screen.w <= 0 || screen.h <= 0) return [];
  if (!occluders.length) return [{ x: 0, y: 0, w: screen.w, h: screen.h }];
  const uniqSorted = (vals: number[], limit: number) => {
    const eps = 1e-6;
    const s = [...vals].sort((a, b) => a - b);
    const out: number[] = [];
    for (const v of s) {
      if (v <= eps || v >= limit - eps) continue; // 0 与 limit 由首尾补
      if (!out.length || v - out[out.length - 1] > eps) out.push(v);
    }
    return out;
  };
  const xs = [0, ...uniqSorted(occluders.flatMap((o) => [o[0], o[0] + o[2]]), screen.w), screen.w];
  const ys = [0, ...uniqSorted(occluders.flatMap((o) => [o[1], o[1] + o[3]]), screen.h), screen.h];
  const cols = xs.length - 1;
  const rows = ys.length - 1;
  // 行内 run 合并：每行先扫出可见列段，再向上找同列段合并（同 x 起点+同宽）
  const out: Rect[] = [];
  for (let j = 0; j < rows; j++) {
    const y = ys[j];
    const h = ys[j + 1] - y;
    let runStart = -1;
    for (let i = 0; i <= cols; i++) {
      const visible = i < cols && !occluders.some((o) =>
        rectsIntersect(xs[i], y, xs[i + 1] - xs[i], h, o[0], o[1], o[2], o[3]));
      if (visible && runStart < 0) runStart = i;
      if ((!visible || i === cols) && runStart >= 0) {
        const x = xs[runStart];
        const w = xs[i] - x;
        // 向上合并：与上一输出矩形同 x/w 且底边相接 → 扩高（减少碎片）
        const prev = out[out.length - 1];
        if (prev && prev.y + prev.h === y && prev.x === x && prev.w === w) {
          prev.h += h;
        } else {
          out.push({ x, y, w, h });
        }
        runStart = -1;
      }
    }
  }
  return out;
}

/** 精确可见比例（消费层矩形算的；分档也用它 —— hostRatio 优先，见 computeOcclusionFrame） */
export function exactVisibleRatio(screen: Screen, rects: Rect[]): number {
  const total = screen.w * screen.h;
  if (total <= 0) return 0;
  let area = 0;
  for (const r of rects) area += Math.max(0, r.w) * Math.max(0, r.h);
  return Math.max(0, Math.min(1, area / total));
}

/**
 * 碎片合并（保守扩大）：面积 < minAreaFrac×屏 或短边 < minEdge 的矩形不丢弃，
 * 而是并入「与它相邻且并集不过分膨胀的矩形」取并集包围盒 —— 输出只会比真实
 * 可见区**更大**，绝不会更小（漏画红线）。无合格候选时保留原样（宁可多画整块）。
 *
 * 吞洞防线（3463520581 拖动实测回归）：并集包围盒面积超过两块面积和的
 * maxOverDraw 倍就拒绝合并 —— 对角/直角相接的条带按包围盒合并会把中间的
 * 遮挡洞整个盖回来（96% 覆盖时四边细条带曾合成整幅矩形，图层剔除全失效、
 * 恰好一块时还被当全幅跳过导致统计不复位）。同侧共线的合并不受影响
 * （并集 ≈ 面积和，比值 ≈ 1）。
 */
export function mergeFragments(
  rects: Rect[],
  screen: Screen,
  opts?: { minAreaFrac?: number; minEdge?: number; maxOverDraw?: number },
): Rect[] {
  const minArea = (opts?.minAreaFrac ?? 0.005) * screen.w * screen.h;
  const minEdge = opts?.minEdge ?? 16;
  const maxOver = opts?.maxOverDraw ?? 1.25;
  const out = rects.map((r) => ({ ...r }));
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const r = out[i];
      const tiny = r.w * r.h < minArea || Math.min(r.w, r.h) < minEdge;
      if (!tiny) continue;
      // 找相邻（边接触或重叠）且并集膨胀最小的候选 —— 膨胀比值同分时取面积大的
      let best = -1;
      let bestScore = Infinity;
      let bestArea = -1;
      for (let j = 0; j < out.length; j++) {
        if (j === i) continue;
        const o = out[j];
        const touch =
          rectsIntersect(r.x - 1, r.y - 1, r.w + 2, r.h + 2, o.x, o.y, o.w, o.h) || // 边接触（±1px 容差）
          rectsIntersect(r.x, r.y, r.w, r.h, o.x, o.y, o.w, o.h); // 含重叠
        if (!touch) continue;
        const x0 = Math.min(r.x, o.x), y0 = Math.min(r.y, o.y);
        const x1 = Math.max(r.x + r.w, o.x + o.w), y1 = Math.max(r.y + r.h, o.y + o.h);
        const score = (x1 - x0) * (y1 - y0) / (r.w * r.h + o.w * o.h);
        if (score <= maxOver && (score < bestScore - 1e-9 || (Math.abs(score - bestScore) < 1e-9 && o.w * o.h > bestArea))) {
          bestScore = score;
          bestArea = o.w * o.h;
          best = j;
        }
      }
      if (best < 0) continue; // 无不吞洞的邻居：保留（不丢内容）
      const o = out[best];
      const x0 = Math.min(r.x, o.x), y0 = Math.min(r.y, o.y);
      const x1 = Math.min(screen.w, Math.max(r.x + r.w, o.x + o.w));
      const y1 = Math.min(screen.h, Math.max(r.y + r.h, o.y + o.h));
      out[best] = { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
      out.splice(i, 1);
      changed = true;
      break;
    }
  }
  return out;
}

/**
 * 量化（向外取整到 gridPx 栅格）：ROI 推送防抖的第一道 —— 拖动中的 1~2px
 * 抖动不再产生新矩形。**只向外扩**（保守方向）。
 */
export function expandQuantize(rects: Rect[], screen: Screen, gridPx = 8): Rect[] {
  const g = Math.max(1, gridPx);
  return rects.map((r) => {
    const x0 = Math.max(0, Math.floor(r.x / g) * g);
    const y0 = Math.max(0, Math.floor(r.y / g) * g);
    const x1 = Math.min(screen.w, Math.ceil((r.x + r.w) / g) * g);
    const y1 = Math.min(screen.h, Math.ceil((r.y + r.h) / g) * g);
    return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
  });
}

// ---- 消费层 → 渲染器：可见矩形逆映射成相机世界矩形 ----

/** 相机窗口（fitWindow + applyCameraZoom 之后的**最终**可见世界矩形） */
export type CameraWindow = { offX: number; offY: number; viewW: number; viewH: number };

/** 渲染器 ROI 查询窗口（世界坐标，y 与 cam.projH 同向） */
export type WorldRect = { x0: number; y0: number; x1: number; y1: number };

/**
 * 遮挡可见矩形（画布 CSS 像素）→ 渲染器 ROI 世界矩形（相机窗口坐标）。
 *
 * 映射是渲染器正交投影的**精确逆**：相机把 [offX, offX+viewW]×[offY, offY+viewH]
 * 整块映到画布（buildCamera 的 mat4Ortho），所以画布比例 → 线性内插即可。
 * 传入的 win 必须是**最终**窗口（已过 applyCameraZoom）—— 曾用裸 fitWindow 逆映射，
 * zoom<1 时窗口算小、可见区边缘图层被静默误裁（超 64px 裁剪余量）。
 *
 * 可见区已覆盖整张画布时返回 undefined：调用方据此把 undefined 交给渲染器，
 * 走「无 ROI」原路径（零行为差，也避免整屏 ROI 矩形把剔除统计口径搅乱）。
 *
 * 搬进本模块（而非留在 scene-mount 内联）是为了可离线做**行为断言** ——
 * 这是 ROI 剔除唯一可能「多裁一层」的数学环节，靠正则检查接线抓不到错。
 */
export function roiWorldRects(
  rects: Rect[],
  win: CameraWindow,
  canvasW: number,
  canvasH: number,
): WorldRect[] | undefined {
  if (!rects.length) return undefined;
  if (!(canvasW > 0) || !(canvasH > 0)) return undefined;
  const full =
    rects.length === 1 &&
    rects[0].x <= 0 && rects[0].y <= 0 &&
    rects[0].w >= canvasW && rects[0].h >= canvasH;
  if (full) return undefined;
  return rects.map((r) => ({
    x0: win.offX + (r.x / canvasW) * win.viewW,
    x1: win.offX + ((r.x + r.w) / canvasW) * win.viewW,
    y0: win.offY + (r.y / canvasH) * win.viewH,
    y1: win.offY + ((r.y + r.h) / canvasH) * win.viewH,
  }));
}

// ---- 分档状态机（滞回 + 最小驻留）----

export type OcclusionBand = "run" | "light" | "heavy" | "pause";

/** 档位从轻到重的顺序（走深可跳级 —— 暂停宁早；走浅逐级 —— 平滑恢复） */
const BAND_ORDER: readonly OcclusionBand[] = ["run", "light", "heavy", "pause"];

export type BandState = {
  band: OcclusionBand;
  since: number;
  /** 正在等待驻留确认的候选档（candidate === band 表示无候选） */
  candidate: OcclusionBand;
  candidateSince: number;
};

/**
 * 分档配置默认值。阈值语义（visibleRatio = 可见比例，越小遮得越狠）：
 *   ≤0.05 暂停（对齐 Lively Grid 默认 95% 覆盖暂停）
 *   ≤0.30 重降载（heavyFps）
 *   ≤0.70 中降载（lightFps）
 *   >0.70 全量
 * heavyFps/lightFps 默认 24/40，均高于 20fps 双时钟下限。
 */
export const DEFAULT_OCCLUSION_CONFIG: OcclusionBandConfig = {
  pause: 0.05,
  heavy: 0.30,
  light: 0.70,
  heavyFps: 24,
  lightFps: 40,
  hysteresis: 0.05,
  dwellMs: 400,
};

/**
 * 规范化分档配置：阈值升序、fps 夹在 [20, 60]（下限 = 双时钟失步红线，
 * 上限 = 默认满帧）、滞回与驻留夹在合理区间。非法输入回落默认值。
 */
export function normalizeOcclusionConfig(partial?: OcclusionBands | false | null): OcclusionBandConfig {
  const d = DEFAULT_OCCLUSION_CONFIG;
  if (partial === undefined || partial === null || partial === false) return { ...d };
  const num = (v: unknown, dflt: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : dflt;
  };
  let pause = Math.max(0, Math.min(0.5, num(partial.pause, d.pause)));
  let heavy = Math.max(pause, Math.min(0.8, num(partial.heavy, d.heavy)));
  let light = Math.max(heavy, Math.min(1, num(partial.light, d.light)));
  // 阈值相等时两档都进不去（除暂停外 ratio 恒 > heavy 不成立）——强制留 2pp 间隔
  if (heavy - pause < 0.02) heavy = pause + 0.02;
  if (light - heavy < 0.02) light = heavy + 0.02;
  return {
    pause,
    heavy,
    light,
    heavyFps: Math.max(20, Math.min(60, num(partial.heavyFps, d.heavyFps))),
    lightFps: Math.max(20, Math.min(60, num(partial.lightFps, d.lightFps))),
    hysteresis: Math.max(0, Math.min(0.15, num(partial.hysteresis, d.hysteresis))),
    dwellMs: Math.max(0, Math.min(2000, num(partial.dwellMs, d.dwellMs))),
  };
}

/** 按可见比例直接映射档位（无滞回的原始映射，测试/诊断用） */
export function bandForRatio(ratio: number, cfg: OcclusionBandConfig): OcclusionBand {
  if (ratio <= cfg.pause) return "pause";
  if (ratio <= cfg.heavy) return "heavy";
  if (ratio <= cfg.light) return "light";
  return "run";
}

/**
 * 滞回推进一档状态。
 *
 * 规则：
 *   · 走深（更 throttled）：立即用进入阈值（可跳级到最深 —— 暂停宁早勿晚）；
 *     等待驻留时间确认后才生效，防止单帧毛刺直接暂停；
 *   · 走浅（更宽松）：必须越过「退出阈值 = 进入阈值 + hysteresis」，且逐级
 *     上爬（run←light←heavy←pause），每级都要过驻留 —— 遮挡比例在阈值附近
 *     往返时不会来回抖（Lively 用阈值 + 我们的滞回 + 驻留双保险）。
 * state 传 null 时初始化为按 ratio 直映的档位（首帧不折腾）。
 */
export function nextBand(
  state: BandState | null,
  ratio: number,
  now: number,
  cfg: OcclusionBandConfig,
): { state: BandState; band: OcclusionBand } {
  const cur = state ?? {
    band: bandForRatio(ratio, cfg),
    since: now,
    candidate: bandForRatio(ratio, cfg),
    candidateSince: now,
  };
  const curIdx = BAND_ORDER.indexOf(cur.band);
  // 候选档：先看能否走深（进入阈值，可跳级到最深满足者），否则看能否走浅（退出阈值，逐级）
  let candidate: OcclusionBand = cur.band;
  if (ratio <= cfg.pause && cur.band !== "pause") {
    candidate = "pause";
  } else if (ratio <= cfg.heavy && curIdx < BAND_ORDER.indexOf("heavy")) {
    candidate = "heavy";
  } else if (ratio <= cfg.light && curIdx < BAND_ORDER.indexOf("light")) {
    candidate = "light";
  } else if (curIdx > 0) {
    // 走浅检查：当前档的退出阈值 = 「本档自身的进入阈值 + 滞回」（对称滞回）。
    //   pause → >pause+hyst（默认 0.10）、heavy → >heavy+hyst（0.35）、
    //   light → >light+hyst（0.75；run 无上限阈值，light 的入阈就是它自己）。
    // 曾实现成「上一档入阈 + 滞回」（pause 0.35 / heavy 0.75）：退出要跨过整个
    // 下一档区间，稳定 ratio 0.20 冻在 pause 十秒不放、0.50 永驻 24fps——与
    // 本函数 docstring「进入阈值 + hysteresis」自相矛盾的棘轮（独立评审双票
    // 判设计缺陷）。防抖不靠跨级间隙：每个边界的 5pp 入/出滞回 + 双向 400ms
    // 驻留已足够（10Hz 方波实测零换档），要 pause 更粘应加显式旋钮。
    const entryThr = cur.band === "pause" ? cfg.pause : cur.band === "heavy" ? cfg.heavy : cfg.light;
    if (ratio > entryThr + cfg.hysteresis) candidate = BAND_ORDER[curIdx - 1];
  }
  if (candidate === cur.band) {
    return { state: { ...cur, candidate, candidateSince: now }, band: cur.band };
  }
  // 新候选从零计时；同一候选持续超过驻留时间才提交
  const since = cur.candidate === candidate ? cur.candidateSince : now;
  if (now - since >= cfg.dwellMs) {
    return { state: { band: candidate, since: now, candidate, candidateSince: now }, band: candidate };
  }
  return { state: { ...cur, candidate, candidateSince: since }, band: cur.band };
}

/**
 * 档位对帧率上限的收敛：宿主显式 setFps 的值永远优先（作为上限），遮挡档
 * 只往下压不往上抬。pause 档返回 0（调用方以「暂停」处理而不是 0fps 门）。
 * band 为 undefined（无遮挡态）时原样透传 —— 三个渲染循环（scene/media/web
 * shim）共用这一处，别再各自内联同一份 min/max（漂移过一次：20fps 下限）。
 */
export function occlusionFpsCap(band: OcclusionBand | undefined, cfg: OcclusionBandConfig, userFps: number): number {
  const cap = userFps > 0 && Number.isFinite(userFps) ? userFps : 60;
  if (band === "pause") return 0;
  // min 单向：宿主上限永远优先，遮挡只往下压不往上抬。20fps 下限只属于档位值
  //（cfg.heavyFps/lightFps 经 normalizeOcclusionConfig 已夹在 [20,60]）—— 宿主
  // 自设更低上限（如 setFps(10) 省电）时不得被抬回 20（用户实测踩中：设 10 +
  // heavy 档，帧率不降反升；双时钟失步是宿主自选低帧率的代价，不归遮挡管）。
  if (band === "heavy") return Math.min(cap, Math.max(20, cfg.heavyFps));
  if (band === "light") return Math.min(cap, Math.max(20, cfg.lightFps));
  return cap;
}

// ---- 帧合成：一次算齐决策层 + 消费层 ----

export type OcclusionFrame = {
  /** 分档用可见比例（宿主 ratio 优先，缺省用精确分解口径 —— 见 computeOcclusionFrame） */
  ratio: number;
  /** 精确可见比例（stats/校验） */
  exactRatio: number;
  /** 消费层矩形（已合并碎片 + 向外量化，保守扩大） */
  rects: Rect[];
  /** 网格覆盖率（Lively 语义对照读数，overlay 展示用；不再参与分档） */
  gridCoverage: number;
};

export function computeOcclusionFrame(
  screen: Screen,
  occluders: OcclusionRect[],
  hostRatio?: number,
  tiles = 16,
): OcclusionFrame {
  const raw = decomposeVisibleRects(screen, occluders);
  const merged = mergeFragments(raw, screen);
  const rects = expandQuantize(merged, screen);
  const gridCoverage = computeGridCoverage(screen, occluders, tiles);
  // 分档用**精确**可见比例（消费层分解本来就是精确的，误差为 0）。曾用网格
  // covered-if-touched 口径（Lively 同款），但「内部大窗」会触碰全部 tile ——
  // 3463520581 拖动实测：85% 真实可见却算出 ratio=0 直跳 pause（可见区冻住）。
  // 网格误差 ±2 个 tile 边（16 格时可达 ~12pp），远超 5pp 滞回带。网格读数
  // 保留在 gridCoverage 供 overlay 对照。宿主 ratio 依然最高优先。
  const exact = exactVisibleRatio(screen, raw);
  const ratio = typeof hostRatio === "number" && Number.isFinite(hostRatio)
    ? Math.max(0, Math.min(1, hostRatio))
    : exact;
  return { ratio, exactRatio: exact, rects, gridCoverage };
}

// ---- fail-open：推送陈旧检测 ----

/**
 * 遮挡推送的失联判定：超过 OCCLUSION_STALE_MS 没收到新载荷就当宿主死了
 * （宿主崩溃 / SSE 断连 / Tauri 桥掉线）—— 此时**必须恢复全量渲染**而不是
 * 停在暂停态（评估报告 §2.5 fail-open 契约）。调用方在渲染循环里逐帧检查。
 */
export const OCCLUSION_STALE_MS = 3000;

export function isOcclusionStale(receivedAt: number, now: number): boolean {
  return now - receivedAt > OCCLUSION_STALE_MS;
}
