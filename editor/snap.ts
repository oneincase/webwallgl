// 视口拖拽吸附：选中层的包围盒（左 / 中 / 右、上 / 中 / 下）贴向画面边缘与中线、
// 其他层的边缘与中心。全部在画布 CSS 像素里算，与 getLayerOutline / 指针坐标同一空间。

export type Box = { x0: number; y0: number; x1: number; y1: number };
export type SnapTargets = { xs: number[]; ys: number[] };
export type SnapResult = { dx: number; dy: number; gx: number[]; gy: number[] };

export const SNAP_PX = 6;

export function boxOf(corners: ReadonlyArray<readonly number[]>): Box | null {
  if (!corners.length) return null;
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/** 场景逻辑画面在画布里的矩形（与引擎 fit 同口径：cover 取大、contain 取小、stretch 各轴独立，居中） */
export function sceneFrame(fit: string, cw: number, ch: number, w: number, h: number): Box {
  let kx = cw / w;
  let ky = ch / h;
  if (fit === "cover") kx = ky = Math.max(kx, ky);
  else if (fit === "contain") kx = ky = Math.min(kx, ky);
  const fw = w * kx;
  const fh = h * ky;
  const x0 = (cw - fw) / 2;
  const y0 = (ch - fh) / 2;
  return { x0, y0, x1: x0 + fw, y1: y0 + fh };
}

const lines = (a: number, b: number) => [a, (a + b) / 2, b];

export function snapTargets(frame: Box, others: readonly Box[]): SnapTargets {
  const xs = [...lines(frame.x0, frame.x1)];
  const ys = [...lines(frame.y0, frame.y1)];
  for (const b of others) {
    xs.push(...lines(b.x0, b.x1));
    ys.push(...lines(b.y0, b.y1));
  }
  return { xs, ys };
}

/** 单轴：三条线里离某个目标最近的那对，距离不超过阈值就补齐；返回修正后的位移与贴上的参考线 */
function snapAxis(a: number, b: number, d: number, targets: readonly number[], thr: number): { d: number; guides: number[] } {
  const mine = lines(a, b).map((v) => v + d);
  let best = Infinity;
  let fix = 0;
  for (const t of targets) {
    for (const m of mine) {
      const gap = t - m;
      if (Math.abs(gap) < Math.abs(best)) {
        best = gap;
        fix = gap;
      }
    }
  }
  if (!(Math.abs(best) <= thr)) return { d, guides: [] };
  const snapped = mine.map((v) => v + fix);
  const guides = [...new Set(targets.filter((t) => snapped.some((m) => Math.abs(m - t) < 0.5)).map((t) => Math.round(t * 100) / 100))];
  return { d: d + fix, guides };
}

export function snapMove(box: Box, dx: number, dy: number, t: SnapTargets, thr = SNAP_PX): SnapResult {
  const x = snapAxis(box.x0, box.x1, dx, t.xs, thr);
  const y = snapAxis(box.y0, box.y1, dy, t.ys, thr);
  return { dx: x.d, dy: y.d, gx: x.guides, gy: y.guides };
}
