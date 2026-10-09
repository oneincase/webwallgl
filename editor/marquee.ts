// 框选（marquee）：视口里拖出的矩形与图层包围盒求交。
// 纯函数，不碰 DOM / 引擎；坐标一律是画布 CSS 像素（与 getLayerOutline、指针坐标同一空间）。

import { boxOf, type Box } from "./snap";

/** 已量出包围盒、可供框选的层 */
export type MarqueeLayer = {
  id: number | string;
  /** 视口上可量到包围盒的层（被隐藏、零尺寸、透视场景里非模型层的层通常为 null） */
  box: Box | null;
  /** 隐藏层不参与框选 */
  visible: boolean;
};

/** 点是否落在盒子里（含边界） */
export function boxHasPoint(b: Box, x: number, y: number): boolean {
  return x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1;
}

/** 两盒是否相交；边贴边也算相交（矩形拖出一点点就能碰到层） */
export function boxIntersects(a: Box, b: Box): boolean {
  return a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;
}

/** 从轮廓点（四角或模型凸包）求包围盒；空输入返回 null */
export function boxFromCorners(corners: ReadonlyArray<readonly number[]> | null | undefined): Box | null {
  if (!corners || !corners.length) return null;
  return boxOf(corners);
}

/** 框选命中的层 id，按传入顺序（场景顺序）；隐藏层与没有包围盒的层跳过 */
export function marqueeHits(layers: ReadonlyArray<MarqueeLayer>, rect: Box): Array<number | string> {
  const out: Array<number | string> = [];
  for (const l of layers) {
    if (!l.visible || !l.box) continue;
    if (boxIntersects(rect, l.box)) out.push(l.id);
  }
  return out;
}

/** 拖完后的新选区：追加模式下与旧选区求并（点中已选层即剔除），否则直接替换 */
export function marqueeSelect(
  current: ReadonlyArray<number | string>,
  hits: ReadonlyArray<number | string>,
  add: boolean,
): Array<number | string> {
  const key = (id: number | string) => String(id);
  if (!add) return hits.map((id) => id);
  const out: Array<number | string> = current.map((id) => id);
  const seen = new Set(out.map(key));
  for (const id of hits) {
    const k = key(id);
    const at = out.findIndex((x) => key(x) === k);
    if (at >= 0) out.splice(at, 1); // 已选中：再框一次取消
    else if (!seen.has(k)) out.push(id);
  }
  return out;
}

/** 起拖点到落拖点的矩形（任意方向都规范化成 x0<=x1 / y0<=y1） */
export function rectOf(
  ax: number,
  ay: number,
  bx: number,
  by: number,
): Box {
  return { x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) };
}
