// M12 / W5 引擎侧 overlay pass 的**纯几何**出口（EDITOR-COMPLETION-PLAN §2 B2）。
//
// 现状：选中框 / 变换手柄是页面 `#ed-overlay` 这层 2D canvas 画的，引擎里
// 连 gl.LINES 都没用过。这里把「轮廓 → 线段」的换算从渲染后端里拆出来：
//   - 2D canvas 回退路径（页面）与 GL pass（引擎）吃同一份线段数组，
//     两条路径的几何逐位一致，切换后端不会让选中框跳一下；
//   - 纯函数无 DOM / 无 GL，可以离线判据（含与 layerQuadWorld 的互证）。
//
// 坐标口径：**画布 CSS 像素**，原点左上、y 向下 —— 与
// `EditorLayerOutline`（getLayerOutline 的出口）和页面 2D canvas 完全同空间。
// GL 侧只做一次 CSS→clip 的仿射，见 overlay-gl.ts。

/** overlay 后端：页面默认 "2d"（行为对用户不变），引擎 GL 是可选路径 */
export type OverlayMode = "off" | "2d" | "gl";

const OVERLAY_MODES: readonly OverlayMode[] = ["off", "2d", "gl"];

export function normalizeOverlayMode(v: unknown, dflt: OverlayMode = "2d"): OverlayMode {
  return typeof v === "string" && (OVERLAY_MODES as readonly string[]).includes(v) ? (v as OverlayMode) : dflt;
}

/** getLayerOutline 出口的子集（透视场景给 hull，正交给 corners） */
export type OverlayOutlineLike = {
  anchor?: [number, number];
  corners?: Array<[number, number]> | null;
  hull?: Array<[number, number]>;
};

type Pt = [number, number];

const isPt = (p: unknown): p is Pt =>
  Array.isArray(p) && p.length >= 2 && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1]));

/** 把闭合折线展开成 GL_LINES 用的线段对：[x0,y0,x1,y1, ...] */
function closeLoop(pts: readonly Pt[]): Float32Array {
  const n = pts.length;
  if (n < 2) return new Float32Array(0);
  const out = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    out[i * 4] = a[0];
    out[i * 4 + 1] = a[1];
    out[i * 4 + 2] = b[0];
    out[i * 4 + 3] = b[1];
  }
  return out;
}

/** 轮廓 → 线段对。hull 优先于 corners（透视场景 modelScreenMesh 给的是 hull，
 *  此时 corners 为 null —— 与 getLayerOutline 的出口口径一致）。 */
export function outlineSegments(outline: OverlayOutlineLike | null | undefined): Float32Array {
  if (!outline) return new Float32Array(0);
  const hull = Array.isArray(outline.hull) ? outline.hull.filter(isPt) : [];
  if (hull.length >= 2) return closeLoop(hull);
  const corners = Array.isArray(outline.corners) ? outline.corners.filter(isPt) : [];
  if (corners.length >= 2) return closeLoop(corners);
  return new Float32Array(0);
}

/** 变换手柄：绕锚点的 4 个角柄 + 1 个中心十字。size 是 CSS 像素半边长。
 *  手柄画在**锚点**上（页面 2D 路径同款）：锚点是屏幕空间的点，与轮廓无关 ——
 *  子层被父级裁掉时 outline 可能是空的，手柄仍要能拖。 */
export function gizmoSegments(anchor: Pt | null | undefined, size: number, cross = true): Float32Array {
  if (!isPt(anchor) || !(size > 0)) return new Float32Array(0);
  const [ax, ay] = anchor;
  const parts: number[] = [];
  const box = (dx: number, dy: number) => {
    const x0 = ax + dx - size;
    const y0 = ay + dy - size;
    const x1 = ax + dx + size;
    const y1 = ay + dy + size;
    parts.push(x0, y0, x1, y0, x1, y0, x1, y1, x1, y1, x0, y1, x0, y1, x0, y0);
  };
  // 四角柄相对锚点向外偏 2*size，避免与轮廓线重叠成一团
  const off = size * 2;
  box(-off, -off);
  box(off, -off);
  box(-off, off);
  box(off, off);
  if (cross) {
    parts.push(ax - size * 3, ay, ax + size * 3, ay);
    parts.push(ax, ay - size * 3, ax, ay + size * 3);
  }
  return new Float32Array(parts);
}

/** 线段对的包围盒（CSS 像素）。判据用它做「差异只出现在这个矩形里」的断言。 */
export function segmentsBounds(seg: Float32Array): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (!seg || seg.length < 4) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i + 1 < seg.length; i += 2) {
    const x = seg[i];
    const y = seg[i + 1];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

/** 轮廓 + 锚点手柄合成一条线段数组（GL pass 一次 drawArrays 就画完） */
export function overlaySegments(
  outline: OverlayOutlineLike | null | undefined,
  opts: { gizmo?: boolean; gizmoSize?: number } = {},
): Float32Array {
  const a = outlineSegments(outline);
  if (!opts.gizmo) return a;
  const g = gizmoSegments(outline?.anchor, opts.gizmoSize ?? 6);
  if (g.length === 0) return a;
  if (a.length === 0) return g;
  const out = new Float32Array(a.length + g.length);
  out.set(a, 0);
  out.set(g, a.length);
  return out;
}

/** 线段数（判据与诊断文案用） */
export const segmentCount = (seg: Float32Array) => (seg ? seg.length >> 2 : 0);
