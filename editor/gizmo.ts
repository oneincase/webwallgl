// 变换手柄几何与拖拽数学（W5 过渡方案）。纯函数：输入输出都是画布 CSS 坐标，
// 页面负责取轮廓、画叠加层和把结果写进引擎。

export type Pt = [number, number];

/** 手柄边长 / 命中半径（CSS 像素） */
export const HANDLE = 8;
export const ROTATE_OFFSET = 22;
export const MIN_SCALE = 0.01;
/** 拖拽起算阈值：小于它的位移当作点击 */
export const DRAG_THRESHOLD = 3;

/**
 * corners 顺序同 layerQuadWorld：层局部的左上、右上、右下、左下（未旋转时即屏幕方位），
 * 旋转柄挂在局部上边（c0→c1）中点外侧，跟着层一起转。
 */
export type Gizmo = { anchor: Pt; corners: Pt[]; rotate: Pt | null };

export function gizmoOf(anchor: readonly number[], corners: ReadonlyArray<readonly number[]> | null): Gizmo {
  const a: Pt = [anchor[0], anchor[1]];
  if (!corners || corners.length !== 4) return { anchor: a, corners: [], rotate: null };
  const cs = corners.map((c) => [c[0], c[1]] as Pt);
  const cx = cs.reduce((s, c) => s + c[0], 0) / 4;
  const cy = cs.reduce((s, c) => s + c[1], 0) / 4;
  const mx = (cs[0][0] + cs[1][0]) / 2;
  const my = (cs[0][1] + cs[1][1]) / 2;
  const len = Math.hypot(mx - cx, my - cy) || 1;
  const rotate: Pt = [mx + ((mx - cx) / len) * ROTATE_OFFSET, my + ((my - cy) / len) * ROTATE_OFFSET];
  return { anchor: a, corners: cs, rotate };
}

export type HandleHit = { kind: "scale"; corner: number } | { kind: "rotate" } | null;

/** 旋转柄优先于角点（两者靠得很近时转比缩更难误触发） */
export function handleAt(g: Gizmo | null, x: number, y: number): HandleHit {
  if (!g) return null;
  const near = (p: Pt) => Math.hypot(p[0] - x, p[1] - y) <= HANDLE;
  if (g.rotate && near(g.rotate)) return { kind: "rotate" };
  const i = g.corners.findIndex(near);
  return i >= 0 ? { kind: "scale", corner: i } : null;
}

const unit = (x: number, y: number): Pt => {
  const l = Math.hypot(x, y) || 1;
  return [x / l, y / l];
};
const dot = (a: Pt, b: Pt) => a[0] * b[0] + a[1] * b[1];

/** 层局部 x / y 轴在屏幕上的单位向量（没有轮廓时退回屏幕轴） */
export function layerAxes(corners: readonly Pt[]): { ax: Pt; ay: Pt } {
  if (corners.length !== 4) return { ax: [1, 0], ay: [0, 1] };
  const [c0, c1, , c3] = corners;
  return { ax: unit(c1[0] - c0[0], c1[1] - c0[1]), ay: unit(c3[0] - c0[0], c3[1] - c0[1]) };
}

/**
 * 旋转柄拖拽后的 z 角（弧度）。屏幕 y 向下、WE 角度 y 向上：屏幕顺时针 = 角度减小。
 * snapDeg > 0 时吸附到该步长。
 */
export function rotateZ(z0: number, anchor: Pt, from: Pt, to: Pt, snapDeg = 0): number {
  const a0 = Math.atan2(from[1] - anchor[1], from[0] - anchor[0]);
  const a1 = Math.atan2(to[1] - anchor[1], to[0] - anchor[0]);
  let z = z0 - (a1 - a0);
  if (snapDeg > 0) {
    const step = (snapDeg * Math.PI) / 180;
    z = Math.round(z / step) * step;
  }
  return z;
}

/**
 * 角点缩放：沿层自身两轴分别求「现距 / 原距」；锚点恰在该轴上（如左上对齐拖左上角）
 * 时该轴不动。uniform = 按到锚点的距离等比缩放。
 */
export function scaleXY(
  scale0: readonly number[],
  anchor: Pt,
  from: Pt,
  to: Pt,
  axes: { ax: Pt; ay: Pt },
  uniform = false,
): [number, number, number] {
  const v0: Pt = [from[0] - anchor[0], from[1] - anchor[1]];
  const v1: Pt = [to[0] - anchor[0], to[1] - anchor[1]];
  const ratio = (axis: Pt) => {
    const d0 = dot(v0, axis);
    return Math.abs(d0) < 4 ? 1 : dot(v1, axis) / d0;
  };
  let sx = ratio(axes.ax);
  let sy = ratio(axes.ay);
  if (uniform) sx = sy = Math.hypot(v1[0], v1[1]) / (Math.hypot(v0[0], v0[1]) || 1);
  return [Math.max(MIN_SCALE, scale0[0] * sx), Math.max(MIN_SCALE, scale0[1] * sy), scale0[2]];
}

/**
 * 画面点选的叠层轮换：同一叠层（命中 id 序列相同）上 Alt+点击逐层向下，
 * 换了位置或不按 Alt 回到最上层。
 */
export function cyclePick(
  ids: ReadonlyArray<number | string>,
  last: { key: string; idx: number } | null,
  alt: boolean,
): { key: string; idx: number } | null {
  if (!ids.length) return null;
  const key = ids.join(",");
  const idx = alt && last?.key === key ? (last.idx + 1) % ids.length : 0;
  return { key, idx };
}
