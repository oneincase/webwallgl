// M12 / W2b 增量装配的纯逻辑出口（EDITOR-COMPLETION-PLAN §2 B1）。
//
// 只做「图层数组的结构手术」：找位置 / 摘除 / 插入 / 重排 / 收子树。
// 真正的资源装配（模型贴图、粒子系统、脚本沙箱登记）在 scene-mount.ts 里
// 贴着既有装配路径做（见 addLayerImpl / removeLayerImpl），因为这些注册表
// 只存在于那次装配的闭包里。
//
// 单独抽成纯函数的原因：这一层的判据全部可以离线跑
// （scripts/verify-editor.mjs 的「M12 引擎写测」段），不依赖 WebGL / DOM；
// 页面侧与引擎侧共用同一套下标语义，合并时不会两边各写一份。
//
// 下标语义（与 scene.layers 一致，**数组顺序即绘制顺序**，末尾在最上层）：
//   - 活跃层 = 数组里第一个 id 相同且 !destroyed 的元素（墓碑层不算数）
//   - toIndex 是**插入位**：0 = 最底、arr.length = 最顶
//   - 越界一律夹取到 [0, length]，不做拒绝

/** 图层数组里的元素形状（引擎 layer 是 any，这里只约束结构手术要读的字段） */
export type OrderedLayer = { id?: unknown; destroyed?: boolean };

const sameId = (a: unknown, b: unknown) => String(a) === String(b);

/** 活跃层的下标；找不到（或只有墓碑）返回 -1 */
export function layerIndexOf(layers: readonly OrderedLayer[], id: unknown): number {
  for (let i = 0; i < layers.length; i++) {
    const l = layers[i];
    if (l && !l.destroyed && sameId(l.id, id)) return i;
  }
  return -1;
}

/** 从数组里摘除一个活跃层（不改 destroyed 标志，墓碑由调用方打）。
 *  返回被摘掉的层与它原来的下标，找不到返回 null。 */
export function detachLayer<T extends OrderedLayer>(
  layers: T[],
  id: unknown,
): { layer: T; index: number } | null {
  const at = layerIndexOf(layers, id);
  if (at < 0) return null;
  const [layer] = layers.splice(at, 1);
  return { layer, index: at };
}

/** 把 toIndex 夹到合法插入位 */
export function clampInsertIndex(layers: readonly OrderedLayer[], toIndex: number): number {
  const n = Number.isFinite(toIndex) ? Math.trunc(toIndex) : layers.length;
  if (n < 0) return 0;
  if (n > layers.length) return layers.length;
  return n;
}

/** 在 toIndex 处插入一层，返回实际落点下标 */
export function insertLayerAt<T extends OrderedLayer>(layers: T[], layer: T, toIndex: number): number {
  const at = clampInsertIndex(layers, toIndex);
  layers.splice(at, 0, layer);
  return at;
}

/** 重排：先摘后插。toIndex 是**摘掉之后**的目标插入位（同 DOM insertBefore 直觉，
 *  也是页面「上移 / 下移一层」最省事的语义）。
 *  找不到 / 目标位与现状一致（数组内容不变）时返回 null，调用方据此跳过重绘。 */
export function moveLayerTo(layers: OrderedLayer[], id: unknown, toIndex: number): number | null {
  const from = layerIndexOf(layers, id);
  if (from < 0) return null;
  const at = clampInsertIndex(layers, toIndex);
  // 插入位等价于原位时是空操作：摘掉后插回同一处，数组逐位不变
  if (at === from || at === from + 1) return null;
  const [layer] = layers.splice(from, 1);
  const at2 = clampInsertIndex(layers, toIndex > from ? toIndex - 1 : toIndex);
  layers.splice(at2, 0, layer);
  return at2;
}

/** 前移 / 后移一层（delta = +1 是往上走一层 = 数组里往后挪一位）。
 *  到顶/到底返回 null。 */
export function shiftLayer(layers: OrderedLayer[], id: unknown, delta: number): number | null {
  const from = layerIndexOf(layers, id);
  if (from < 0) return null;
  const step = delta >= 0 ? 1 : -1;
  const target = from + step;
  if (target < 0 || target > layers.length - 1) return null;
  return moveLayerTo(layers, id, target > from ? target + 1 : target);
}

/** 重排到**目标下标**（= 搬完之后这一层在数组里的位置，与 `EditorLayer.index` 同一口径）。
 *  与 `moveLayerTo` 的区别：那个收的是「插入位」（先摘后插的落点），同一个目标位置在
 *  两个口径下差 1 —— 页面的「上移一层」与 `reorderLayer(id, toIndex)` 用的都是下标口径，
 *  所以对外 API 一律走这里，避免调用方自己 +1 / -1。
 *  越界夹到 [0, length-1]；目标就是原位时返回 null（空操作，调用方不必出帧）。 */
export function moveLayerToIndex(layers: OrderedLayer[], id: unknown, toIndex: number): number | null {
  const from = layerIndexOf(layers, id);
  if (from < 0 || !Number.isFinite(toIndex)) return null;
  const target = Math.max(0, Math.min(Math.trunc(toIndex), layers.length - 1));
  if (target === from) return null;
  return moveLayerTo(layers, id, target > from ? target + 1 : target);
}

/** 父链向下收整棵子树（含自身）。childIds 来自 parse.js 的聚合表：
 *  只认数组形状，脏数据（null / 非数组）当没有子层。 */
export function collectSubtreeIds<T extends OrderedLayer & { childIds?: unknown }>(
  layers: readonly T[],
  id: unknown,
): unknown[] {
  const byId = new Map<string, T>();
  for (const l of layers) if (l && !l.destroyed) byId.set(String(l.id), l);
  const out: unknown[] = [];
  const seen = new Set<string>();
  const walk = (cur: unknown, guard: number) => {
    const key = String(cur);
    if (seen.has(key) || guard > 64) return;
    seen.add(key);
    out.push(cur);
    const l = byId.get(key);
    const kids = l && Array.isArray(l.childIds) ? (l.childIds as unknown[]) : [];
    for (const k of kids) walk(k, guard + 1);
  };
  walk(id, 0);
  return out;
}

/** 一份「结构手术」的结果摘要，供判据与日志复用（避免两边各算一次） */
export type LayerOrderChange = {
  id: unknown;
  from: number;
  to: number;
  count: number;
};

/** 一次结构手术后的可读快照（判据里直接比这个） */
export function layerIdOrder(layers: readonly OrderedLayer[]): string[] {
  return layers.filter((l) => l && !l.destroyed).map((l) => String(l.id));
}
