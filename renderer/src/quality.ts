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
