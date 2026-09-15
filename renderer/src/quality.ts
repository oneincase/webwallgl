// 渲染质量设置（对标 WE 客户端的壁纸性能选项：抗锯齿 / 粒子质量 / 后处理）。
//
// 设计要点：
// - 全部档位**默认保持现状**（AA off / 粒子 high / 后处理 high），不改任何既有
//   壁纸的默认表现；只有调用方显式传 quality 才生效。
// - 三项设置都可**实时热调**（sceneCtl.setQuality），不需要重挂载 —— MSAA 是
//   离屏 FBO、粒子倍率是池重建、后处理是渲染门控，都不涉及 canvas 上下文重建。
// - 本模块只放纯函数与映射表，不依赖 DOM/GL，离线 verifier（verify-quality）
//   直接 import 断言；接线（谁调这些函数）在 scene-mount / main / api 里。
// - 公共类型在 api/types.ts（d.ts 唯一真源、零 import），这里 type-only 转引。

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

/** 粒子质量档 → 数量/发射率倍率。off 不经过这张表（装配层直接跳过粒子）。 */
export const PARTICLE_QUALITY_SCALE: Record<Exclude<ParticleQuality, "off">, number> = {
  low: 0.4,
  medium: 0.7,
  high: 1,
};

/** 后处理档 → renderer 的 fboCapFactor（0=全质量；>0 时效果链 FBO 上限 =
 *  屏幕占比 × 系数）。off 档不走这张表（走 setEffectsEnabled(false)）。 */
export const POST_FBO_CAP: Record<Exclude<PostQuality, "off">, number> = {
  low: 0.5,
  medium: 1,
  high: 0,
};

/** MSAA 档 → 多重采样数。 */
export const MSAA_SAMPLES: Record<"msaa2" | "msaa4", number> = {
  msaa2: 2,
  msaa4: 4,
};

const AA_MODES: readonly string[] = ["off", "fxaa", "msaa2", "msaa4"];
const PARTICLE_QUALITIES: readonly string[] = ["off", "low", "medium", "high"];
const POST_QUALITIES: readonly string[] = ["off", "low", "medium", "high"];

function pick<T extends string>(v: unknown, allowed: readonly string[], dflt: T): T {
  return typeof v === "string" && allowed.includes(v) ? (v as T) : dflt;
}

/** 缺省补全 + 非法值回退默认。任何入口（query / API / localStorage）都先过它。 */
export function normalizeQuality(q?: QualityOptions | null): ResolvedQuality {
  const src = q ?? {};
  return {
    antiAliasing: pick(src.antiAliasing, AA_MODES, DEFAULT_QUALITY.antiAliasing),
    particles: pick(src.particles, PARTICLE_QUALITIES, DEFAULT_QUALITY.particles),
    postProcessing: pick(src.postProcessing, POST_QUALITIES, DEFAULT_QUALITY.postProcessing),
  };
}

/** query 参数解析（测试台 buildQuery 与渲染器页 main.ts 共用同一组键名）。
 *  aa=fxaa|msaa2|msaa4（缺省 off）、pq=low|medium|high|off、pp=low|medium|high|off。
 *  只认显式出现的键；没带的键回落默认。 */
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

/** 粒子档 → 数量倍率（off 由调用方特判，这里返回 0 便于直接乘）。 */
export function particleQualityScale(q: ParticleQuality): number {
  return q === "off" ? 0 : PARTICLE_QUALITY_SCALE[q];
}

/** 后处理档 → fboCapFactor（off 由调用方走 setEffectsEnabled(false)，fboCap
 *  此时无消费者，返回全质量 0）。 */
export function postFboCapFactor(q: PostQuality): number {
  return q === "off" ? 0 : POST_FBO_CAP[q];
}
