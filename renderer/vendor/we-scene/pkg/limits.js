// 素材可控字段的解析期闸门
//
// 为什么需要：.tex 头部（imageCount / mipCount / 尺寸 / 载荷长度）与粒子配置里的
// 计数直接来自文件，未加约束时一个几十字节的畸形素材就能把解析器拖进空转 ——
// 实测 imageCount=0xFFFFFFFF 在 4.6s 内 SIGABRT（OOM），mipCount 同理
// （见 docs/ENGINE-REVIEW-2026-10.md §2.2 / §9.2）。
//
// 闸门必须挡在**进入循环之前**：tex-codecs 的 u32/i32 越界读返回 0 而不抛，
// 循环体内因此毫无刹车，靠循环里的边界判断是挡不住的。
//
// 上界全部由真实语料标定（2026-10-01：344 个 scene.pkg / 7647 张 .tex）：
//   imageCount  实测 max 8（7636/7647 张为 1）  → 64
//   mipCount    实测 max 12                      → 32
//   单轴尺寸     实测 max 8192                    → 16384
//   单 mip 像素  实测 max 8192² = 67M px          → 1<<27 = 134M px（RGBA 512MB）
//   解压目标     实测 max 256MB                   → 512MB（= maxPixels × 4）
// 每项都留 ≥2× 余量，真实素材行为零改动 —— verify-textures 的语料遍历即回归。

export const TEX_LIMITS = Object.freeze({
  maxImages: 64,
  maxMips: 32,
  maxDim: 16384,
  maxPixels: 1 << 27,
})

/**
 * 粒子序列帧网格的 N（N×N 切图）。
 * 语料实测 max 500（208/344 个包用到 sequencemultiplier）。
 * 注意：这个上界只保护算术（frameCount = N²），**不**参与帧表分配 ——
 * 帧表的分配由 particles.js 的 `u_frames[128]` 消费上限单独封顶。
 */
export const MAX_SEQUENCE_MUL = 4096

function throwBound(what, value, min, max, where) {
  throw new Error(`素材字段越界：${what}=${value}（允许 ${min}..${max}）${where ? ' @ ' + where : ''}`)
}

/** 计数（imageCount / mipCount）：整型、≥1、≤ 上限 */
export function assertCount(what, value, max, where) {
  if (!Number.isInteger(value) || value < 1 || value > max) throwBound(what, value, 1, max, where)
}

/** mip 尺寸：两轴 ≥1、单轴 ≤ maxDim、像素数 ≤ maxPixels */
export function assertDims(w, h, where) {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) {
    throwBound('mip 尺寸', w + 'x' + h, 1, TEX_LIMITS.maxDim, where)
  }
  if (w > TEX_LIMITS.maxDim || h > TEX_LIMITS.maxDim) {
    throwBound('mip 单轴', w + 'x' + h, 1, TEX_LIMITS.maxDim, where)
  }
  if (w * h > TEX_LIMITS.maxPixels) {
    throwBound('mip 像素数', w * h, 1, TEX_LIMITS.maxPixels, where)
  }
}

/**
 * 载荷范围：p..p+n 必须落在缓冲区里。
 * n 为负（i32 误读/畸形）或越界一律抛 —— 旧实现是静默 `subarray` 截断，
 * 于是 p += n 回退、循环继续迭代（负 size 的放大器）。
 */
export function assertPayload(p, n, bufLen, where) {
  if (!Number.isInteger(n) || n < 0) throwBound('载荷长度', n, 0, Math.max(0, bufLen - p), where)
  if (p + n > bufLen) throwBound('载荷越界', p + '+' + n, 0, bufLen, where)
}

/** LZ4 头声明的解压目标尺寸 */
export function assertDecodeSize(n, where) {
  const max = TEX_LIMITS.maxPixels * 4
  if (!Number.isInteger(n) || n < 0 || n > max) throwBound('解压目标尺寸', n, 0, max, where)
}
