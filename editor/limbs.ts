// Character Sheet Creation（官方 Puppet Warp 的素材步骤）：把一张「角色表」大图按 limb（部件）
// 抠出来，并生成 .mdl 的部件表。
//
// 官方能力（docs/we-docs/puppet-pages/pw-introduction.md、charactersheet.md、character-sheet.md）：
// Add Limb / Mark Foreground / Mark Background / Quality / Auto Recalculate / Recalculate / Smoothing /
// View(Foreground|Background) / Mask(M) / Paint Brush Mode / Polygon Mode / Show depth order。
// 文档只说这些按钮的用途，没有给分割算法 ⇒ 本模块的算法是自定的，并把**参数**显式存进工程
// json（`puppetWarp.limbs`），保证重开工程可复现；算法细节随版本号（LIMBS_VERSION）演进。
//
// 纯计算、无 DOM：输入 `SheetImage`（RGBA 像素）+ 参数，输出掩码 / 抠出的图层 / 部件表。
// 真机侧只负责把 canvas 像素喂进来、把结果画回去（editor/main.ts）。

import type { MdlPart } from "../renderer/src/api/editor";

/** 模型 json 里 Character Sheet 创作态的版本号 */
export const LIMBS_VERSION = 1;
export const QUALITY_MIN = 1;
export const QUALITY_MAX = 100;
export const SMOOTHING_MAX = 8;
export const MAX_LIMBS = 64;
/** 视图：View → Foreground / Background */
export const SHEET_VIEWS = ["foreground", "background"] as const;
export type SheetView = (typeof SHEET_VIEWS)[number];
/** 绘制模式：Paint Brush Mode / Polygon Mode */
export const PAINT_MODES = ["brush", "polygon"] as const;
export type PaintMode = (typeof PAINT_MODES)[number];

export type SheetImage = { width: number; height: number; data: Uint8ClampedArray };

export type Point = { x: number; y: number };

/** 一个 limb：名字 + 逐像素掩码（1 = 属于该部件）+ 紧致包围盒 */
export type LimbMask = {
  id: number;
  name: string;
  mask: Uint8Array;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
};

export type SheetSpec = {
  /** Quality：连通域最小面积（按图面积比例的百分比 0..2%）与去噪强度 */
  quality: number;
  /** Smoothing：形态学平滑半径（像素） */
  smoothing: number;
  /** 背景色相似阈值（每通道最大差，0..255） */
  threshold: number;
  /** 背景色（null = 从边框主色自动取） */
  colorKey: [number, number, number] | null;
  /** 抠图边缘羽化半径（像素） */
  feather: number;
  /** Auto Recalculate 是否把结果当作用户手工掩码保留（true 时 recalculate 不覆盖） */
  manual: boolean;
};

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isInt = (v: unknown): v is number => isNum(v) && Number.isInteger(v);

export function defaultSheetSpec(image?: SheetImage): SheetSpec {
  return {
    quality: 40,
    smoothing: 1,
    threshold: 32,
    colorKey: image ? dominantBorderColor(image) : null,
    feather: 1,
    manual: false,
  };
}

// ---------- 颜色 / 背景 ----------

/** 边框主色：把边框像素按 4bit/通道量化计数，取最多的桶的平均色（确定性，首见优先） */
export function dominantBorderColor(image: SheetImage): [number, number, number] {
  const { width: w, height: h, data } = image;
  const bins = new Map<number, { n: number; r: number; g: number; b: number }>();
  let best = -1;
  let bestKey = 0;
  const add = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const p = (y * w + x) * 4;
    const r = data[p];
    const g = data[p + 1];
    const b = data[p + 2];
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    let e = bins.get(key);
    if (!e) {
      e = { n: 0, r: 0, g: 0, b: 0 };
      bins.set(key, e);
    }
    e.n++;
    e.r += r;
    e.g += g;
    e.b += b;
    if (e.n > best) {
      best = e.n;
      bestKey = key;
    }
  };
  for (let x = 0; x < w; x++) {
    add(x, 0);
    add(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    add(0, y);
    add(w - 1, y);
  }
  const e = bins.get(bestKey);
  if (!e || !e.n) return [0, 0, 0];
  return [Math.round(e.r / e.n), Math.round(e.g / e.n), Math.round(e.b / e.n)];
}

export function colorKeyOf(image: SheetImage, spec: SheetSpec): [number, number, number] {
  return spec.colorKey ?? dominantBorderColor(image);
}

/** 背景掩码（1 = 背景）：与背景色每通道差都不超过 threshold，且该像素不透明 */
export function backgroundMaskOf(image: SheetImage, spec: SheetSpec): Uint8Array {
  const { width: w, height: h, data } = image;
  const [kr, kg, kb] = colorKeyOf(image, spec);
  const t = clamp(Math.round(spec.threshold), 0, 255);
  const out = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    if (data[p + 3] < 8) {
      out[i] = 1;
      continue;
    }
    const d = Math.max(Math.abs(data[p] - kr), Math.abs(data[p + 1] - kg), Math.abs(data[p + 2] - kb));
    if (d <= t) out[i] = 1;
  }
  return out;
}

// ---------- 掩码工具 ----------

export function emptyMask(image: SheetImage): Uint8Array {
  return new Uint8Array(image.width * image.height);
}

export function maskBBox(mask: Uint8Array, width: number, height: number): [number, number, number, number] | null {
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : [x0, y0, x1 + 1, y1 + 1];
}

export function maskCount(mask: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) n++;
  return n;
}

/** 掩码并集 / 交集（像素级判据用） */
export function unionMask(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.min(a.length, b.length));
  for (let i = 0; i < out.length; i++) out[i] = a[i] || b[i] ? 1 : 0;
  return out;
}

export function intersectMask(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.min(a.length, b.length));
  for (let i = 0; i < out.length; i++) out[i] = a[i] && b[i] ? 1 : 0;
  return out;
}

/** 每个像素最多命中一个 limb（官方每个 limb 是独立部件，不允许重叠） */
export function limbIdAt(limbs: readonly LimbMask[], width: number, x: number, y: number): number {
  for (const l of limbs) {
    if (x >= l.x0 && y >= l.y0 && x < l.x1 && y < l.y1 && l.mask[y * width + x]) return l.id;
  }
  return -1;
}

/** 把逐像素 limb id 压成一张查找表（三角形归属查询用） */
export function limbLabelMap(limbs: readonly LimbMask[], image: SheetImage): Int32Array {
  const { width: w, height: h } = image;
  const out = new Int32Array(w * h).fill(-1);
  for (const l of limbs) {
    for (let y = l.y0; y < l.y1; y++) {
      for (let x = l.x0; x < l.x1; x++) {
        const i = y * w + x;
        if (l.mask[i]) out[i] = l.id;
      }
    }
  }
  return out;
}

/** 前景 / 背景互斥：所有 limb 掩码两两不相交（官方每个 limb 是独立部件，不允许重叠） */
export function limbsDisjoint(limbs: readonly LimbMask[], width: number, height: number): boolean {
  const seen = new Uint8Array(width * height);
  for (const l of limbs) {
    for (let i = 0; i < l.mask.length && i < seen.length; i++) {
      if (!l.mask[i]) continue;
      if (seen[i]) return false;
      seen[i] = 1;
    }
  }
  return true;
}

// ---------- 形态学（Smoothing） ----------

/** 方形结构元的一维通过：grow=true 取窗口内最大值（膨胀），false 取最小值（腐蚀） */
function morphPass(src: Uint8Array, dst: Uint8Array, width: number, height: number, r: number, grow: boolean) {
  const lim = Math.max(1, Math.round(r));
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let v = grow ? 0 : 1;
      const from = Math.max(0, x - lim);
      const to = Math.min(width - 1, x + lim);
      for (let k = from; k <= to; k++) {
        const s = src[row + k];
        if (grow) {
          if (s) {
            v = 1;
            break;
          }
        } else if (!s) {
          v = 0;
          break;
        }
      }
      dst[row + x] = v;
    }
  }
}

function morphTransposed(src: Uint8Array, width: number, height: number, r: number, grow: boolean): Uint8Array {
  const tmp = new Uint8Array(width * height);
  morphPass(src, tmp, width, height, r, grow);
  // 列方向：转置后复用行实现
  const t = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) t[x * height + y] = tmp[y * width + x];
  const t2 = new Uint8Array(width * height);
  morphPass(t, t2, height, width, r, grow);
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) out[y * width + x] = t2[x * height + y];
  return out;
}

/** Smoothing：闭运算（填孔）再开运算（去毛刺），方形结构元、半径 r */
export function smoothMask(mask: Uint8Array, width: number, height: number, r: number): Uint8Array {
  const lim = Math.max(0, Math.round(r));
  if (!lim) return mask.slice();
  const closed = morphTransposed(morphTransposed(mask, width, height, lim, true), width, height, lim, false);
  return morphTransposed(morphTransposed(closed, width, height, lim, false), width, height, lim, true);
}

/** 边缘羽化：对 0/1 掩码做方形均值模糊 → 0..255 的 alpha */
export function featherAlpha(mask: Uint8Array, width: number, height: number, r: number): Uint8Array {
  const lim = Math.max(0, Math.round(r));
  const out = new Uint8Array(width * height);
  if (!lim) {
    for (let i = 0; i < out.length; i++) out[i] = mask[i] ? 255 : 0;
    return out;
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let n = 0;
      let hit = 0;
      for (let j = Math.max(0, y - lim); j <= Math.min(height - 1, y + lim); j++) {
        const row = j * width;
        for (let i = Math.max(0, x - lim); i <= Math.min(width - 1, x + lim); i++) {
          n++;
          if (mask[row + i]) hit++;
        }
      }
      out[y * width + x] = n ? Math.round((hit / n) * 255) : 0;
    }
  }
  return out;
}

// ---------- 手工标注（Mark Foreground / Background、Paint Brush Mode、Polygon Mode） ----------

export type PaintOp = "add" | "remove";

function paintAt(mask: Uint8Array, width: number, height: number, x: number, y: number, op: PaintOp) {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  mask[y * width + x] = op === "add" ? 1 : 0;
}

/** 矩形标注（Mark Foreground / Mark Background 的框选） */
export function markRect(
  mask: Uint8Array,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  op: PaintOp = "add",
): Uint8Array {
  const out = mask.slice();
  const ax = clamp(Math.round(Math.min(x0, x1)), 0, width - 1);
  const bx = clamp(Math.round(Math.max(x0, x1)), 0, width - 1);
  const ay = clamp(Math.round(Math.min(y0, y1)), 0, height - 1);
  const by = clamp(Math.round(Math.max(y0, y1)), 0, height - 1);
  for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) paintAt(out, width, height, x, y, op);
  return out;
}

/** 画笔：把折线按 1px 步长插值成胶囊链（Paint Brush Mode） */
export function brushStroke(
  mask: Uint8Array,
  width: number,
  height: number,
  points: readonly Point[],
  radius: number,
  op: PaintOp = "add",
): Uint8Array {
  const out = mask.slice();
  const r = Math.max(0, radius);
  const stamp = (cx: number, cy: number) => {
    const ax = Math.floor(cx - r);
    const bx = Math.ceil(cx + r);
    const ay = Math.floor(cy - r);
    const by = Math.ceil(cy + r);
    for (let y = ay; y <= by; y++) {
      for (let x = ax; x <= bx; x++) {
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy <= r * r + r) paintAt(out, width, height, x, y, op);
      }
    }
  };
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    if (!isNum(a.x) || !isNum(a.y)) continue;
    const b = points[i + 1];
    if (!b || !isNum(b.x) || !isNum(b.y)) {
      stamp(a.x, a.y);
      continue;
    }
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.ceil(len));
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      stamp(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
    }
  }
  return out;
}

/** 多边形：逐行 0.5 采样、偶奇规则填水平跨段（Polygon Mode） */
export function polygonMask(
  mask: Uint8Array,
  width: number,
  height: number,
  points: readonly Point[],
  op: PaintOp = "add",
): Uint8Array {
  const out = mask.slice();
  const pts = points.filter((p) => isNum(p.x) && isNum(p.y));
  if (pts.length < 3) return out;
  const xs: number[] = [];
  const y0 = clamp(Math.floor(Math.min(...pts.map((p) => p.y))), 0, height - 1);
  const y1 = clamp(Math.ceil(Math.max(...pts.map((p) => p.y))), 0, height - 1);
  for (let y = y0; y <= y1; y++) {
    const sy = y + 0.5;
    xs.length = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[j];
      const b = pts[i];
      if (a.y === b.y) continue;
      const lo = Math.min(a.y, b.y);
      const hi = Math.max(a.y, b.y);
      if (sy < lo || sy >= hi) continue;
      xs.push(a.x + ((sy - a.y) / (b.y - a.y)) * (b.x - a.x));
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const from = clamp(Math.ceil(xs[k] - 0.5), 0, width - 1);
      const to = clamp(Math.floor(xs[k + 1] - 0.5), 0, width - 1);
      for (let x = from; x <= to; x++) paintAt(out, width, height, x, y, op);
    }
  }
  return out;
}

// ---------- 自动分割（Auto Recalculate / Recalculate） ----------

/** 连通域标注（4 邻接，1 = 前景）；返回 labels（0 = 背景）与各域面积 */
export function connectedComponents(
  foreground: Uint8Array,
  width: number,
  height: number,
): { labels: Int32Array; sizes: number[] } {
  const labels = new Int32Array(width * height);
  const sizes: number[] = [0];
  const queue = new Int32Array(width * height);
  let next = 0;
  for (let start = 0; start < labels.length; start++) {
    if (!foreground[start] || labels[start]) continue;
    next++;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    labels[start] = next;
    let n = 0;
    while (head < tail) {
      const i = queue[head++];
      n++;
      const x = i % width;
      const y = (i - x) / width;
      if (x > 0 && foreground[i - 1] && !labels[i - 1]) {
        labels[i - 1] = next;
        queue[tail++] = i - 1;
      }
      if (x + 1 < width && foreground[i + 1] && !labels[i + 1]) {
        labels[i + 1] = next;
        queue[tail++] = i + 1;
      }
      if (y > 0 && foreground[i - width] && !labels[i - width]) {
        labels[i - width] = next;
        queue[tail++] = i - width;
      }
      if (y + 1 < height && foreground[i + width] && !labels[i + width]) {
        labels[i + width] = next;
        queue[tail++] = i + width;
      }
    }
    sizes.push(n);
  }
  return { labels, sizes };
}

/** Quality → 连通域最小面积：0（1 分）到图面积 2%（100 分） */
export function minAreaOf(image: SheetImage, quality: number): number {
  const q = clamp(Math.round(quality), QUALITY_MIN, QUALITY_MAX);
  return Math.round(((q - 1) / (QUALITY_MAX - 1)) * image.width * image.height * 0.02);
}

function limbOf(id: number, name: string, mask: Uint8Array, width: number, height: number): LimbMask {
  const bb = maskBBox(mask, width, height) ?? [0, 0, 0, 0];
  return { id, name, mask, x0: bb[0], y0: bb[1], x1: bb[2], y1: bb[3] };
}

/**
 * Auto Recalculate：前景（非背景色的不透明像素）按连通域切开，丢掉小于 Quality 阈值的碎块，
 * 再过一遍 Smoothing。`names` 用来给每个 limb 起名（缺省 "limb 1"…）。
 */
export function autoLimbs(image: SheetImage, spec: SheetSpec, names: readonly string[] = []): LimbMask[] {
  const { width: w, height: h } = image;
  const bg = backgroundMaskOf(image, spec);
  const fg = new Uint8Array(w * h);
  for (let i = 0; i < fg.length; i++) fg[i] = bg[i] ? 0 : 1;
  const { labels, sizes } = connectedComponents(fg, w, h);
  const minArea = minAreaOf(image, spec.quality);
  const keep: number[] = [];
  for (let i = 1; i < sizes.length; i++) if (sizes[i] >= minArea) keep.push(i);
  keep.sort((a, b) => sizes[b] - sizes[a] || a - b);
  const out: LimbMask[] = [];
  for (const label of keep.slice(0, MAX_LIMBS)) {
    let mask = new Uint8Array(w * h);
    for (let i = 0; i < labels.length; i++) if (labels[i] === label) mask[i] = 1;
    if (spec.smoothing > 0) mask = smoothMask(mask, w, h, spec.smoothing);
    if (!maskCount(mask)) continue;
    const id = out.length;
    out.push(limbOf(id, names[id] ?? `limb ${id + 1}`, mask, w, h));
  }
  return out;
}

/** Recalculate：按「每个 limb 当前平均色」重新归类前景像素，再平滑（手工掩码被 spec.manual 保护） */
export function recalculate(image: SheetImage, spec: SheetSpec, limbs: readonly LimbMask[]): LimbMask[] {
  if (spec.manual || !limbs.length) return limbs.map((l) => ({ ...l }));
  const { width: w, height: h, data } = image;
  const bg = backgroundMaskOf(image, spec);
  const means: Array<[number, number, number] | null> = limbs.map((l) => {
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let i = 0; i < l.mask.length; i++) {
      if (!l.mask[i]) continue;
      const p = i * 4;
      r += data[p];
      g += data[p + 1];
      b += data[p + 2];
      n++;
    }
    return n ? [r / n, g / n, b / n] : null;
  });
  const masks = limbs.map(() => new Uint8Array(w * h));
  for (let i = 0; i < bg.length; i++) {
    if (bg[i]) continue;
    const p = i * 4;
    let best = -1;
    let bestD = Infinity;
    for (let k = 0; k < means.length; k++) {
      const m = means[k];
      if (!m) continue;
      const d = (data[p] - m[0]) ** 2 + (data[p + 1] - m[1]) ** 2 + (data[p + 2] - m[2]) ** 2;
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    if (best >= 0) masks[best][i] = 1;
  }
  return limbs.map((l, k) => {
    let mask = masks[k];
    if (spec.smoothing > 0) mask = smoothMask(mask, w, h, spec.smoothing);
    return limbOf(l.id, l.name, mask, w, h);
  });
}

// ---------- 抠图输出 ----------

export type LimbBitmap = { id: number; name: string; x: number; y: number; width: number; height: number; data: Uint8ClampedArray };

/** 抠出一个 limb：紧致裁剪 + 掩码做 alpha（羽化按 spec）；未命中像素 alpha = 0 */
export function extractLimb(image: SheetImage, limb: LimbMask, spec?: SheetSpec): LimbBitmap | null {
  const bb = maskBBox(limb.mask, image.width, image.height);
  if (!bb) return null;
  const [x0, y0, x1, y1] = bb;
  const w = x1 - x0;
  const h = y1 - y0;
  const data = new Uint8ClampedArray(w * h * 4);
  const alpha = spec && spec.feather > 0 ? featherAlpha(limb.mask, image.width, image.height, spec.feather) : null;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = (y + y0) * image.width + (x + x0);
      const di = (y * w + x) * 4;
      const a = alpha ? alpha[si] : limb.mask[si] ? 255 : 0;
      if (!a) continue;
      const sp = si * 4;
      data[di] = image.data[sp];
      data[di + 1] = image.data[sp + 1];
      data[di + 2] = image.data[sp + 2];
      data[di + 3] = a;
    }
  }
  return { id: limb.id, name: limb.name, x: x0, y: y0, width: w, height: h, data };
}

/** 8 色调色板（View 预览与像素判据用） */
export const LIMB_PALETTE: ReadonlyArray<[number, number, number]> = [
  [255, 96, 96],
  [96, 220, 96],
  [96, 160, 255],
  [255, 208, 64],
  [224, 96, 255],
  [64, 232, 224],
  [255, 152, 48],
  [160, 160, 160],
];

/**
 * View → Foreground / Background 的预览像素：
 * - foreground：每个 limb 用调色板一色（互斥 ⇒ 一个像素只有一个颜色），背景透明
 * - background：背景像素白色不透明，其余透明（用于「View Background」检查抠图）
 */
export function viewPixels(
  image: SheetImage,
  limbs: readonly LimbMask[],
  background: Uint8Array,
  view: SheetView,
): Uint8ClampedArray {
  const { width: w, height: h } = image;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const p = i * 4;
    if (view === "background") {
      if (background[i]) {
        out[p] = 255;
        out[p + 1] = 255;
        out[p + 2] = 255;
        out[p + 3] = 255;
      }
      continue;
    }
    const id = limbIdAt(limbs, w, i % w, (i - (i % w)) / w);
    if (id < 0) continue;
    const c = LIMB_PALETTE[id % LIMB_PALETTE.length];
    out[p] = c[0];
    out[p + 1] = c[1];
    out[p + 2] = c[2];
    out[p + 3] = 255;
  }
  return out;
}

// ---------- 部件表（.mdl parts） ----------

/**
 * 三角形归属：用三角形重心在贴图上的像素位置查 limb 标签。
 * `uvs` 与 `indices` 来自 editor/geometry.ts 的 GeometryMesh（uv 左上原点、v 向下）。
 */
export function triangleLimb(
  indices: ArrayLike<number>,
  uvs: ArrayLike<number>,
  labels: Int32Array,
  image: SheetImage,
): Int32Array {
  const tris = Math.floor(indices.length / 3);
  const out = new Int32Array(tris).fill(-1);
  const { width: w, height: h } = image;
  for (let t = 0; t < tris; t++) {
    let u = 0;
    let v = 0;
    let n = 0;
    for (let k = 0; k < 3; k++) {
      const vi = indices[t * 3 + k];
      if (!isInt(vi) || vi < 0) continue;
      u += uvs[vi * 2] ?? 0;
      v += uvs[vi * 2 + 1] ?? 0;
      n++;
    }
    if (!n) continue;
    const x = clamp(Math.round((u / n) * w - 0.5), 0, w - 1);
    const y = clamp(Math.round((v / n) * h - 0.5), 0, h - 1);
    out[t] = labels[y * w + x];
  }
  return out;
}

/**
 * 按 limb 把三角形重排成连续区间，产出可直接喂给 `setMdlTopology(bytes, meshIndex, indices, parts)`
 * 的索引表 + 部件表：每个 limb 一个 part（`start/size` 首尾相接、恰好铺满索引表），
 * 不属于任何 limb 的三角形（`tri = -1`）落到最后的「_other」部件。
 * `order` 是绘制序（下标 = limb id，值 = 位次）；缺省按 limb 顺序。
 */
export function groupIndicesByLimb(
  indices: ArrayLike<number>,
  tri: Int32Array,
  limbs: readonly { id: number; name: string }[],
  order?: readonly number[],
): { indices: Uint32Array; parts: MdlPart[] } {
  const tris = tri.length;
  const groups = new Map<number, number[]>();
  for (const l of limbs) groups.set(l.id, []);
  groups.set(-1, []);
  for (let t = 0; t < tris; t++) groups.get(tri[t] ?? -1)?.push(t);
  const ids = limbs.map((l) => l.id);
  const rank = new Map<number, number>();
  ids.forEach((id, i) => rank.set(id, order && isInt(order[id]) ? order[id] : i));
  ids.sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0) || a - b);
  const out = new Uint32Array(tris * 3);
  const parts: MdlPart[] = [];
  let w = 0;
  const emit = (id: number, rank0: number) => {
    const list = groups.get(id) ?? [];
    const start = w;
    for (const t of list) {
      out[w++] = indices[t * 3];
      out[w++] = indices[t * 3 + 1];
      out[w++] = indices[t * 3 + 2];
    }
    // 空部件不写进部件表：parts 必须首尾相接且恰好铺满索引表
    if (list.length) parts.push({ id: id < 0 ? limbs.length : id, offset: rank0, start, size: w - start });
  };
  ids.forEach((id, i) => emit(id, i));
  if ((groups.get(-1) ?? []).length) emit(-1, ids.length);
  return { indices: out, parts };
}

// ---------- json 契约（`puppetWarp.limbs`） ----------

/** 存进工程 json 的是参数与命名，逐像素掩码不落盘（可从原图 + 参数重算，避免 json 爆大） */
export type LimbsMeta = { v: number; spec: SheetSpec; names: string[]; count: number };

export function limbsMeta(spec: SheetSpec, limbs: readonly LimbMask[]): LimbsMeta {
  return {
    v: LIMBS_VERSION,
    spec: { ...spec, colorKey: spec.colorKey ? [...spec.colorKey] : null },
    names: limbs.map((l) => l.name),
    count: limbs.length,
  };
}

export function parseLimbsMeta(raw: unknown): LimbsMeta | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const s = (o.spec ?? {}) as Record<string, unknown>;
  const ck = Array.isArray(s.colorKey) && s.colorKey.length === 3 ? s.colorKey : null;
  const spec: SheetSpec = {
    quality: clamp(isNum(s.quality) ? Math.round(s.quality) : 40, QUALITY_MIN, QUALITY_MAX),
    smoothing: clamp(isNum(s.smoothing) ? Math.round(s.smoothing) : 1, 0, SMOOTHING_MAX),
    threshold: clamp(isNum(s.threshold) ? Math.round(s.threshold) : 32, 0, 255),
    colorKey: ck && ck.every(isNum) ? [ck[0], ck[1], ck[2]] : null,
    feather: clamp(isNum(s.feather) ? Math.round(s.feather) : 1, 0, 8),
    manual: s.manual === true,
  };
  const names = Array.isArray(o.names) ? o.names.filter((n): n is string => typeof n === "string").slice(0, MAX_LIMBS) : [];
  const count = isInt(o.count) ? clamp(o.count, 0, MAX_LIMBS) : names.length;
  return { v: isInt(o.v) ? o.v : LIMBS_VERSION, spec, names, count };
}
