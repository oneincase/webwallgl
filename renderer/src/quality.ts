// 渲染质量：AA / 粒子 / 后处理；默认 off/high/high，可热调，不重建 canvas。

import type {
  AntiAliasingMode,
  ParticleQuality,
  PostQuality,
  QualityOptions,
  ResolvedQuality,
} from "./api/types";

export type { AntiAliasingMode, ParticleQuality, PostQuality, QualityOptions, ResolvedQuality };

export const DEFAULT_QUALITY: ResolvedQuality = {
  antiAliasing: "off",
  particles: "high",
  postProcessing: "high",
};

export const PARTICLE_QUALITY_SCALE: Record<Exclude<ParticleQuality, "off">, number> = {
  low: 0.4,
  medium: 0.7,
  high: 1,
};

/** 后处理档 → fboCapFactor（0=全质量；off 走 setEffectsEnabled(false)） */
export const POST_FBO_CAP: Record<Exclude<PostQuality, "off">, number> = {
  low: 0.5,
  medium: 1,
  high: 0,
};

const AA_MODES: readonly string[] = ["off", "fxaa", "msaa2", "msaa4"];
const PARTICLE_QUALITIES: readonly string[] = ["off", "low", "medium", "high"];
const POST_QUALITIES: readonly string[] = ["off", "low", "medium", "high"];

function pick<T extends string>(v: unknown, allowed: readonly string[], dflt: T): T {
  return typeof v === "string" && allowed.includes(v) ? (v as T) : dflt;
}

export function normalizeQuality(q?: QualityOptions | null): ResolvedQuality {
  const src = q ?? {};
  return {
    antiAliasing: pick(src.antiAliasing, AA_MODES, DEFAULT_QUALITY.antiAliasing),
    particles: pick(src.particles, PARTICLE_QUALITIES, DEFAULT_QUALITY.particles),
    postProcessing: pick(src.postProcessing, POST_QUALITIES, DEFAULT_QUALITY.postProcessing),
  };
}

/** query：aa / pq / pp；只认显式键 */
export function qualityFromQuery(get: (key: string) => string | null): QualityOptions {
  const out: QualityOptions = {};
  const aa = get("aa");
  if (aa !== null) out.antiAliasing = normalizeQuality({ antiAliasing: aa as AntiAliasingMode }).antiAliasing;
  const pq = get("pq");
  if (pq !== null) out.particles = normalizeQuality({ particles: pq as ParticleQuality }).particles;
  const pp = get("pp");
  if (pp !== null) out.postProcessing = normalizeQuality({ postProcessing: pp as PostQuality }).postProcessing;
  return out;
}

export function particleQualityScale(q: ParticleQuality): number {
  return q === "off" ? 0 : PARTICLE_QUALITY_SCALE[q];
}

export function postFboCapFactor(q: PostQuality): number {
  return q === "off" ? 0 : POST_FBO_CAP[q];
}

// ---- 自动降档（软件渲染 / 帧率守门）：策略全在这里，纯函数、离线可测 ----

/**
 * 软件渲染（无 GPU）时的画布 DPR 上限。
 *
 * 实测（Apple M5 / SwiftShader，`--use-angle=swiftshader`）：
 *   2887099508：默认 pp=high + DPR 1 → **0 fps（完全不出帧）**；
 *   `pp=off` 单独用 → 16.4 fps；`DPR 0.5` 单独用 → 0 fps（bloom 链没关，光栅化仍是全屏）；
 *   **两者同时** → 46 fps。另 1425503532：21.9 → 59.3 fps。
 * 所以软件渲染的预设必须是「后处理关 + 画布降分辨率」的组合，缺一不可。
 */
export const SOFTWARE_DPR_CAP = 0.5;

/**
 * 软件渲染预设（只填宿主没显式指定的字段）。
 *
 * **不动粒子档**：实测粒子档在真实场景里只有 `off` 有效，而那是视觉断崖
 * （1039919954：1630 live 粒子，pq high 85.8% CPU / medium 84.9% / off 14.2%
 * —— 雪、雨、火花会整片消失），不适合悄悄替用户决定。
 */
export const SOFTWARE_QUALITY_PATCH: ResolvedQuality = {
  antiAliasing: "off",
  particles: "high",
  postProcessing: "off",
};

/**
 * 后处理降档阶梯（帧率守门下坡）。
 *
 * 为什么只走后处理、不碰粒子：同一批实测里 `pp=off` 稳定省 25~40% CPU 并把
 * 43fps 拉回 60（2887099508 / 3416122407 / 3175039950），而粒子档除 `off` 外
 * 基本无效（见上），`off` 又太显眼。抗锯齿默认已是 off，无坡可下。
 */
export const POST_DOWNGRADE_LADDER: readonly PostQuality[] = ["medium", "low", "off"];

/** 后处理的下一档（已到底返回 null）。 */
export function nextPostTier(cur: PostQuality): PostQuality | null {
  const i = POST_DOWNGRADE_LADDER.indexOf(cur);
  // 起点是 high（默认）→ 走阶梯第一级；起点已在阶梯中 → 往下一级
  if (i < 0) return POST_DOWNGRADE_LADDER[0] ?? null;
  return i + 1 < POST_DOWNGRADE_LADDER.length ? POST_DOWNGRADE_LADDER[i + 1] : null;
}

export type AutoQualityInput = {
  /** 归一化后的请求档位（宿主显式给的 + 默认值） */
  quality: ResolvedQuality;
  /** 宿主**显式**给出的键（只从这些键判断「用户有没有表态」） */
  explicit?: QualityOptions | null;
  /** 运行时探到的软件渲染（无 GPU） */
  software: boolean;
  /** `autoQuality: false` / `?autoq=0` 整体关闭自动降档 */
  enabled?: boolean;
};

export type AutoQualityResult = {
  quality: ResolvedQuality;
  /** 被自动改掉的键 + 原因（宿主日志 / diag 用） */
  applied: string[];
  /** 帧率守门是否允许介入（后处理已 off 时没有坡可下） */
  allowAdaptive: boolean;
};

/**
 * 挂载期的自动降档：**只改宿主没显式指定的字段**。
 *
 * 契约（刻意保守）：显式值永远优先；`enabled: false` 整段不生效；返回的 `applied`
 * 让宿主能如实知道「你给的 high 被我降成 off 了，因为这台机器在软件渲染」。
 */
export function applyAutoQuality({
  quality,
  explicit,
  software,
  enabled = true,
}: AutoQualityInput): AutoQualityResult {
  if (!enabled) return { quality, applied: [], allowAdaptive: false };
  const out: ResolvedQuality = { ...quality };
  const applied: string[] = [];
  if (software) {
    if (explicit?.postProcessing === undefined && out.postProcessing !== "off") {
      applied.push(`postProcessing ${out.postProcessing} → off（软件渲染无 GPU）`);
      out.postProcessing = "off";
    }
    if (explicit?.antiAliasing === undefined && out.antiAliasing !== "off") {
      applied.push(`antiAliasing ${out.antiAliasing} → off（软件渲染无 GPU）`);
      out.antiAliasing = "off";
    }
  }
  return { quality: out, applied, allowAdaptive: out.postProcessing !== "off" };
}

/** 软件渲染是否还要压画布 DPR：宿主显式给了 renderDpr 就尊重它。 */
export function softwareDprCap(software: boolean, renderDpr: number | undefined | null): number | null {
  if (!software) return null;
  const pinned = Number(renderDpr);
  if (Number.isFinite(pinned) && pinned > 0) return null;
  return SOFTWARE_DPR_CAP;
}

/**
 * 帧率守门（运行时，仅后处理）。阈值取自实测：连续 3 个 1s 窗口都低于上限的 85%
 * 才降一档 —— 单帧抖动、切场景瞬间的卡顿都不该触发降档。
 */
export const ADAPTIVE_FPS_RATIO = 0.85;
export const ADAPTIVE_STRIKES = 3;
/** 降档后的冷却（秒）：给新档位稳定的时间，避免连降 */
export const ADAPTIVE_COOLDOWN_S = 6;
/** 开跑后的保护期（秒）：加载期与首帧的抖动不算 */
export const ADAPTIVE_GRACE_S = 5;

/**
 * 帧率守门状态机（纯逻辑，无计时器：调用方每秒喂一次读数）。
 *
 * 当前档位**由调用方传入**而不是记在状态机里：宿主随时可能用 setQuality 改档
 * （设置面板），状态机自己记一份就会失同步 —— 传进来才能保证「下一档」永远是从
 * 实际生效的档位往下走。
 *
 * 只降不升：升档会在「刚好卡在阈值上下」的场景里来回抖，观感比恒定低档更差。
 * 需要升档的宿主可以自行决策，或用 `autoQuality: false` 关掉整个守门。
 */
export function createAdaptiveQuality(opts: { onDowngrade: (next: PostQuality, reason: string) => void }) {
  let strikes = 0;
  let cooldown = 0;
  let elapsed = 0;
  return {
    /** 每秒调用一次。fps/cap 为该窗口的实测值与配置上限，current 为当前生效档位。 */
    tick(fps: number, cap: number, dtS: number, current: PostQuality): PostQuality | null {
      elapsed += dtS;
      if (elapsed < ADAPTIVE_GRACE_S) return null;
      if (cooldown > 0) {
        cooldown -= dtS;
        return null;
      }
      if (!(cap > 0) || !(fps > 0)) {
        strikes = 0;
        return null;
      }
      if (fps >= cap * ADAPTIVE_FPS_RATIO) {
        strikes = 0;
        return null;
      }
      strikes++;
      if (strikes < ADAPTIVE_STRIKES) return null;
      const next = nextPostTier(current);
      strikes = 0;
      if (!next) return null;
      const reason = `连续 ${ADAPTIVE_STRIKES} 秒 ${fps.toFixed(0)}fps < 上限 ${cap} 的 ${ADAPTIVE_FPS_RATIO * 100}%`;
      cooldown = ADAPTIVE_COOLDOWN_S;
      opts.onDowngrade(next, reason);
      return next;
    },
  };
}

// ---- 帧率守门第二段：视频纹理上传倍率（后处理到底之后的唯一减压手段）----

/**
 * 视频纹理上传倍率阶梯。
 *
 * 为什么需要第二段：后处理降到底仍然不够时，剩下的缺口常常来自**逐帧把视频帧传成
 * GL 纹理**。**注意**：2026-09-27 起上传默认直传视频元素（省掉同步跨进程取位图，
 * 每帧 1~2ms），直传可用时这段阶梯根本不会触发；它留给直传失败走了 canvas 中转的
 * WebView（那时上传代价随像素数线性，压尺寸是唯一杠杆）。WKWebView 下 WebGL 在 GPU 进程，`texImage2D(DOM 源)` 要把像素同步取回
 * 页面进程，代价随像素数线性（3510729512 实测：上传 2570×1446 → 16fps；压到
 * 1280×720 → 29fps；完全不传 → 满帧 30。同一页面同配置在 Chromium 直接满帧）。
 * 这条路径**降后处理/粒子都救不回来** —— 实测 post 从 medium 一路降到 off，
 * 帧率纹丝不动，白丢画质。
 *
 * 台阶取 0.5 / 0.35 / 0.25：上传代价随**像素数**线性，而像素数跟着画布走 ——
 * 同样的 0.35，在 2570 宽的画布上是 899×506（够，回满帧），在 3024 宽的画布上
 * 是 1058×595（仍差，实测 18.6ms/帧只到 24fps），所以要留一档 0.25。
 * 更精的技术路线是把 `willReadFrequently` 画布或像素数据上传用起来绕开同步取像素，
 * 实测都更慢（见 docs 里的诊断），尺寸是唯一有效杠杆。
 */
export const VIDEO_SCALE_LADDER: readonly number[] = [0.5, 0.35, 0.25];

/**
 * 宿主显式指定倍率时的合法性判定：`0`/`undefined`/负数/非法 = 自动（交给阶梯），
 * 其它收敛到 (0,1]。显式值**优先于阶梯**（同「显式优先」纪律，见 applyAutoQuality）。
 */
export function normalizeVideoTexScale(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0; // 0 = 自动
  return Math.min(1, Math.max(0.05, n));
}

/** 视频倍率的下一档（已是最后一档返回 null）。 */
export function nextVideoScale(cur: number): number | null {
  const v = Number(cur);
  if (!Number.isFinite(v) || v >= 1) return VIDEO_SCALE_LADDER[0] ?? null;
  // 取「严格小于当前值」的第一档：宿主传来的可能是 0.5 这种正好等于台阶的值
  for (const step of VIDEO_SCALE_LADDER) {
    if (step < v - 1e-6) return step;
  }
  return null;
}

/** 视频倍率下坡的判据：后处理已无坡可下，所以节奏比后处理那段更紧。 */
export const VIDEO_STRIKES = 2;
export const VIDEO_COOLDOWN_S = 5;
export const VIDEO_GRACE_S = 3;

/**
 * 帧率守门第二段的独立状态机。与后处理那段分开的理由：
 *  1. 只有渲染器**确实在逐帧传视频纹理**时宿主才该喂它（没视频的场景降它毫无意义）；
 *  2. 那段到底之后节奏可以更紧（后处理一次降档涉及 shader 链重建，要留观察期）。
 * 当前倍率**由调用方传入**（同后处理那段的纪律：宿主手里才是生效值）。
 */
export function createAdaptiveVideoScale(opts: {
  onStepDown: (next: number, reason: string) => void;
}) {
  let strikes = 0;
  let cooldown = 0;
  let elapsed = 0;
  return {
    /** 每秒调用一次；current 为当前生效倍率（1 = 不额外压）。 */
    tick(fps: number, cap: number, dtS: number, current: number): number | null {
      elapsed += dtS;
      if (elapsed < VIDEO_GRACE_S) return null;
      if (cooldown > 0) {
        cooldown -= dtS;
        return null;
      }
      if (!(cap > 0) || !(fps > 0)) {
        strikes = 0;
        return null;
      }
      if (fps >= cap * ADAPTIVE_FPS_RATIO) {
        strikes = 0;
        return null;
      }
      strikes++;
      if (strikes < VIDEO_STRIKES) return null;
      strikes = 0;
      const next = nextVideoScale(current);
      if (next === null) return null;
      cooldown = VIDEO_COOLDOWN_S;
      const reason = `连续 ${VIDEO_STRIKES} 秒 ${fps.toFixed(0)}fps < 上限 ${cap} 的 ${ADAPTIVE_FPS_RATIO * 100}%（后处理已到底）`;
      opts.onStepDown(next, reason);
      return next;
    },
  };
}
