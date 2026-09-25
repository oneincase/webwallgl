/**
 * 资源分辨率倍率（清晰度 → 贴图解码/上传尺寸）——纯函数集中在这里，便于离线判据覆盖。
 *
 * 依据：只要贴图分辨率 ≥ 图层在**设备像素**上的足迹，画面与全分辨率素材逐像素一致
 * （两者都是「1 texel ↔ 1 device px」），所以这不是画质取舍，是去掉过采样。
 *
 * 档位（用户 2026-09-20 定）：高清（renderDpr ≥ 1.5）→ 1；标准（≈1）→ 0.8；省电（≤0.8）→ 0.6；
 * 自动（0 = 跟随设备）→ clamp(devicePixelRatio / 2, 0.6, 1)。
 * 覆盖开关：`?resources=native` 关闭；`?resources=<0..1>` 强制；`?resourcesNormal=<0..1>` 只改法线。
 */
import type { Runtime } from "./shell";
import type { WallpaperConfig } from "./types";

export const RESOURCE_REF_DPR = 2;
/** 缩放后的最短边下限（再小就没有意义，且省不下多少） */
export const MIN_RES_EDGE = 32;

/** URL 覆盖：native/off/0 → 1；纯数字 → 该值；其它 → null（用档位映射）。 */
export function resourceOverride(key: string, search?: string): number | null {
  const q = search ?? (typeof location !== "undefined" ? location.search : "");
  const raw = new URLSearchParams(q).get(key);
  if (raw === null || raw === "") return null;
  if (raw === "native" || raw === "off" || raw === "0") return 1;
  if (raw === "auto") return null;
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? Math.min(1, v) : null;
}

export function resourceScaleFor(rt: Runtime, cfg?: WallpaperConfig): number {
  const forced = resourceOverride("resources");
  if (forced !== null) return forced;
  const raw = cfg?.renderDpr ?? rt.cfg?.renderDpr;
  const n = Number(raw);
  if (raw === undefined || raw === null || raw === 0 || Number.isNaN(n)) {
    // 软件渲染（无 GPU）：画布被压到 SOFTWARE_DPR_CAP，贴图跟着走省电档 ——
    // 上传与解码都省在 CPU 上（软件渲染的瓶颈全在 CPU），且画布本身就小，
    // 高分辨率贴图没有对应的像素可显示。
    if (rt.softwareRenderer === true) return 0.6;
    const device = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    return Math.max(0.6, Math.min(1, device / RESOURCE_REF_DPR));
  }
  if (n >= 1.5) return 1; // 高清
  if (n >= 0.9) return 0.8; // 标准
  return 0.6; // 省电
}

/** 法线/蒙版类：默认不缩（折射与光照对模糊敏感），`?resourcesNormal=` 可单独试。 */
export function resourceScaleForNormal(rt: Runtime, cfg?: WallpaperConfig): number {
  const forced = resourceOverride("resourcesNormal");
  if (forced !== null) return forced;
  return 1;
}

/**
 * 单张贴图适用的倍率（白名单）：
 * · `util/*`（系统内置小图 ≤512²）与 `_rt_*`（渲染目标）不缩；
 * · 名字含 normal 的走法线档；
 * · 其余走基础档。
 */
/**
 * 「本来就小」的贴图直接跳过：长边 < 1024 或像素数 < 1M。
 *
 * 依据（用户 2026-09-20 报「很多壁纸出现过小而动画错误，资源值越小越明显」）：
 * 这些贴图在内存里本来就只有几百 KB，缩它们省不下什么，却最容易踩到
 * 「像素尺寸同时是布局输入」的坑（字体条 3550×50 只有 17 万像素、遮罩 512×256 等）。
 */
export const SMALL_TEX_UPLOAD_BYTES = 1_000_000;

/**
 * [S4 补] 判「本来就小」按**上传字节**（RGBA 等价）而不是边长/像素数。
 *
 * 旧规则（长边 <1024 或 <1M 像素）会把 1024×512 这类 DXT/R8 贴图也划进「小」，
 * 而它们在 GPU 上展开是 **2MB**（DXT5 1024×512 → RGBA 2MB）——
 * 既不该跳过压缩/R8 直传，省下来的也不是小数。
 * 新规则：`w×h×bytesPerPx < 1MB` 才跳过（≈ ≤512² 的贴图），
 * 与「帧表图集一律跳过（布局原因）」互补。
 */
export function isSmallTexture(w: number, h: number, bytesPerPx = 4): boolean {
  const ew = Math.abs(Number(w) || 0);
  const eh = Math.abs(Number(h) || 0);
  if (!(ew > 0) || !(eh > 0)) return true;
  return ew * eh * (bytesPerPx > 0 ? bytesPerPx : 4) < SMALL_TEX_UPLOAD_BYTES;
}

export function texResScale(name: string, base: number, normalBase: number): number {
  // 注意不要在这里用 `base >= 1 → 1` 提前返回：`?resources=native&resourcesNormal=0.5`
  // 是法线效果对比要用的组合（正照率全尺寸、只缩法线）。
  if (name.startsWith("util/") || name.startsWith("_rt_")) return 1;
  if (/normal/i.test(name)) return normalBase;
  return base;
}

/**
 * `?resources=native|off|0` → true：**完全关闭**资源降级（连图层足迹也不看）。
 * 与「高清档（R=1）」的区别很重要：高清只是「policy 上限 = 原生」，
 * 图层足迹仍然可以把它压下去（S4 的收益大多来自这里）。
 */
export function resourcesOff(search?: string): boolean {
  const q = search ?? (typeof location !== "undefined" ? location.search : "");
  const raw = new URLSearchParams(q).get("resources");
  return raw === "native" || raw === "off" || raw === "0";
}

/** 图层足迹计算的上下文（正交投影）。 */
export type FootprintCtx = {
  /** 画布设备像素宽/高（CSS × 有效 DPR） */
  canvasDeviceW: number;
  canvasDeviceH: number;
  /** 正交视口的世界尺寸 */
  viewW: number;
  viewH: number;
  /** 安全系数（视差/相机抖动/缩放动画的余量） */
  safety?: number;
};

/**
 * [S4] 图层在**设备像素**上的足迹（取较长那一轴）。
 *
 * 正交投影下：`devicePx = 世界单位 × 画布设备像素 / 视口世界尺寸`；旋转取 AABB。
 * 透视场景不适用（调用方别传）。返回值 0 = 未知/不适用，调用方回退到全局档位。
 */
export function layerFootprintPx(
  size: [number, number],
  scale: [number, number],
  angleZ: number,
  ctx: FootprintCtx,
): number {
  const w = Math.abs(Number(size?.[0] || 0) * Number(scale?.[0] ?? 1));
  const h = Math.abs(Number(size?.[1] || 0) * Number(scale?.[1] ?? 1));
  if (!(w > 0) || !(h > 0)) return 0;
  const c = Math.abs(Math.cos(angleZ || 0));
  const sn = Math.abs(Math.sin(angleZ || 0));
  const bw = w * c + h * sn;
  const bh = w * sn + h * c;
  const pxX = (ctx.canvasDeviceW || 0) / Math.max(1, ctx.viewW || 1);
  const pxY = (ctx.canvasDeviceH || 0) / Math.max(1, ctx.viewH || 1);
  const safety = ctx.safety && ctx.safety > 0 ? ctx.safety : 1;
  return Math.max(bw * pxX, bh * pxY) * safety;
}

/**
 * [S4] 目标最长边 = min(policy 上限, 图层足迹)。
 *
 * policy 上限 = 原生 × 档位倍率（高清 1 / 标准 0.8 / 省电 0.6）——这是「最多留多少」；
 * 图层足迹 = 「屏幕上真的要用到多少」。两者取小：足迹小就省下过采样的部分（S4 的主要收益），
 * 足迹大（比如放大显示）就回到档位上限，不会比档位更糊。
 */
export function footprintTarget(cap: number, native: number, need: number): number {
  const n = Math.max(1, Math.round(native || 0));
  const base = Math.max(1, Math.min(n, Math.round(cap || 0) || n));
  if (!(need > 0)) return base;
  return Math.max(MIN_RES_EDGE, Math.min(n, Math.min(base, Math.round(need))));
}

/** 目标最长边：原生最长边 × 倍率，带下限；R ≥ 1 时原样。 */
export function targetLong(nativeLong: number, R: number): number {
  if (!nativeLong || R >= 1) return nativeLong;
  return Math.max(MIN_RES_EDGE, Math.round(nativeLong * R));
}

/**
 * 取「不超过 target」的**最大** mip 级。
 *
 * mip 档位是 2× 一跳，取 ≤ target 的最大一级意味着最多比 policy 更省一档（像素 4×），
 * 但**零重采样**（本机 1730/3496 张贴图有多级 mip，这是最省的路径）。
 * `sizes` 是各 mip 级的最长边（降序）。没有一级 ≤ target 时用最小一级。
 */
export function pickMipLevel(sizes: number[], target: number, needFloor = 0): number {
  if (!sizes || sizes.length <= 1 || !target) return 0;
  // 候选：内容最长边不超过 policy 上限的那些级（sizes 降序，故是前缀）
  let inCap = -1;
  for (let i = 0; i < sizes.length; i++) {
    if (sizes[i] <= target) {
      inCap = i;
      break;
    }
  }
  const floor = Math.max(0, Number(needFloor) || 0);
  if (floor > 0) {
    // 1) 上限之内、且不低于屏幕底线的级里取**最省**的那个
    for (let i = Math.max(0, inCap); i < sizes.length; i++) {
      if (sizes[i] <= target && sizes[i] >= floor) return i;
    }
    // 2) 上限之内没有够大的 → 取上限之外**最接近屏幕底线**的一级（宁可省不动，也不明显糊）
    for (let i = sizes.length - 1; i >= 0; i--) {
      if (sizes[i] >= floor) return i;
    }
    // 3) 连最大一级都低于屏幕底线 → 用最大一级
    return 0;
  }
  return inCap < 0 ? sizes.length - 1 : inCap;
}

/**
 * 帧矩形按上传图集与原图集的比例缩放。uv = 原像素 / 原图集宽 == 缩放后像素 / 缩放后图集宽，
 * 所以缩放**不改变**采样到的归一化矩形 —— 但它必须做，否则小图集配上大坐标会采到邻帧。
 */
export function scaleFrames(
  frames: Array<{ x: number; y: number; width: number; height: number }>,
  k: number,
): Array<{ x: number; y: number; width: number; height: number }> {
  if (!(k < 0.999)) return frames;
  for (const f of frames) {
    f.x = Math.round(f.x * k);
    f.y = Math.round(f.y * k);
    f.width = Math.max(1, Math.round(f.width * k));
    f.height = Math.max(1, Math.round(f.height * k));
  }
  return frames;
}

/** 上传纹理字节估计（未压缩 RGBA / RG88 两字节，mip 链 ×4/3）。 */
export function estimateGpuBytes(w: number, h: number, rg88: boolean): number {
  return Math.round(w * h * (rg88 ? 2 : 4) * (4 / 3));
}

/** 采样判断贴图是否整张不透明（≥250）：不透明图可以走浏览器原生缩放（无预乘舍入风险）。 */
export function looksOpaque(rgba: Uint8Array): boolean {
  const n = rgba.length / 4;
  const step = Math.max(1, (n / 96) | 0);
  for (let i = 0; i < n; i += step) if (rgba[i * 4 + 3] < 250) return false;
  return true;
}
