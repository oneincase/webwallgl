// WebGL 上下文丢失自愈（EDITOR-PLAN R7 过渡方案）：引擎不重建 GL 资源，编辑器页按当前文档整场景重挂
// （文档可幂等重建，热改由 replayLiveEdits 重放，不丢编辑状态）。驱动反复丢上下文时不能无限重挂。

export const RECOVER_MAX = 3;
export const RECOVER_WINDOW_MS = 60_000;

/** 是否还允许自动重挂：最近 windowMs 内已重挂次数 < max。允许时把 now 记进 stamps（原地修剪过期项） */
export function allowRecover(stamps: number[], now: number, max = RECOVER_MAX, windowMs = RECOVER_WINDOW_MS): boolean {
  if (!Number.isFinite(now)) return false;
  for (let i = stamps.length - 1; i >= 0; i--) if (!(now - stamps[i] < windowMs)) stamps.splice(i, 1);
  if (stamps.length >= max) return false;
  stamps.push(now);
  return true;
}

export const isContextLost = (err: unknown): boolean => err instanceof Error && err.name === "ContextLostError";
