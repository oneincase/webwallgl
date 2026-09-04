import { parallaxDepthFactor } from './math.js'

/**
 * [we-scene patch] 图层级 hit-test（OBB / 有向包围盒）。
 *
 * 为什么需要它：WE 场景互动的**主入口**是 6 个脚本回调
 * （cursorClick 89 处 / cursorEnter 52 / cursorLeave 52 / cursorDown 26 /
 * cursorUp 26 / cursorMove 22，全库 267 处挂钩、跨 19 个壁纸），
 * 而 cursorEnter / cursorLeave / cursorClick 都要求判断「指针是否落在这个图层上」。
 * scene.json 里**没有任何声明式命中区字段**（interactive / clickable / hitbox
 * 全库 0 处），所以命中区只能由图层自身几何推出来。
 *
 * ---- 几何必须与 renderer.js 的 layerModelMatrix 逐字一致 ----
 *
 * 这是最容易错的地方：图层的世界矩形**不是** [origin, origin+size]。
 * 按 layerModelMatrix 的实际构造顺序：
 *
 *   1. 世界平移到 (origin.x, cam.projH - origin.y)
 *      —— 注意 **y 被翻成 projH - origin.y**（渲染器世界 y 向下，而 WE 的
 *      origin.y 自下而上量）。漏掉这步会让命中区在垂直方向整体镜像。
 *   2. 对象视差偏移 +(d/2) × parOff（沿世界轴，在旋转之前）。
 *   3. 绕 z 轴旋转 -angles[2]。
 *   4. alignment 锚点偏移 (ax-0.5, 0.5-ay)，单位是**局部 quad**（[-0.5,0.5]），
 *      所以要乘上 w/h 才是世界位移。这是音频条「底部对齐向上生长」的基准。
 *
 *   局部 quad 是以原点为中心的 [-0.5,0.5]²，尺寸 w = size[0]*scale[0]、
 *   h = size[1]*scale[1]。
 *
 * 做法：把**世界点逆变换回局部空间**（而不是把 quad 正变换到世界再做多边形判定）——
 * 逆变换后只需比较 |lx| ≤ 0.5 && |ly| ≤ 0.5，既简单又天然支持旋转与非等比缩放。
 *
 * ---- 可见性必须沿父链 ----
 *
 * parse.js 已经把「沿父链求得的有效可见性」算进 layer.visible，这里直接用。
 * 不这么做的后果很具体：3299228616 有 6 套语言变体图层，只有 ENG 根层可见，
 * 但**子层自己都是 visible=true** —— 只看自身可见性会让 5 套隐藏语言的图层
 * 一起参与命中，指针永远打在最上面那个隐藏层上，可见层反而收不到回调。
 */

/**
 * 把世界点逆变换到图层局部 quad 空间。
 *
 * @param {object} layer parse.js 产出的图层对象（origin/size/scale/angles/alignment/parallaxDepth）
 * @param {number} wx 世界 x（像素）
 * @param {number} wy 世界 y（像素，向下）
 * @param {number} projH 场景投影高度（cam.projH），用于 origin.y 的翻转
 * @param {number} parOffX 当前帧对象视差世界位移 x
 * @param {number} parOffY 当前帧对象视差世界位移 y
 * @param {Record<string, number[]>} alignTable ALIGN 表（由渲染器传入，保持单一真源）
 * @returns {{lx:number, ly:number, w:number, h:number}|null}
 */
export function worldToLayerLocal(layer, wx, wy, projH, parOffX, parOffY, alignTable) {
  const size = layer.size || [0, 0]
  const scale = layer.scale || [1, 1, 1]
  const w = size[0] * scale[0]
  const h = size[1] * scale[1]
  if (!(w > 0) || !(h > 0)) return null

  const origin = layer.origin || [0, 0, 0]
  // 1) 图层锚点的世界位置（y 翻转，同 layerModelMatrix）
  let cx = origin[0]
  let cy = projH - origin[1]

  // 2) 对象视差（沿世界轴，旋转之前）
  //
  // [we-scene patch] 符号必须是 **+f**，与 layerModelMatrix 逐字一致。
  // 01ba726 把渲染侧从「相机平移 + 层反向补偿」改成「相机固定、层正向平移」，
  // 符号由 −f 变成 +f，这里漏改了 —— 于是带 parallaxDepth 的层，画面在一边、
  // 命中区在另一边，偏移量是渲染位移的两倍。
  //
  // 大层看不出来（偏几十像素仍落在层内），小按钮直接点不中：3148125112 的
  // 丝袜切换按钮 pd=(−0.6,−0.4)、屏上只有 16.7px，指针指着它却永远收不到 click。
  if (layer.parallaxDepth && (parOffX !== 0 || parOffY !== 0)) {
    const d = layer.parallaxDepth
    const fx = parallaxDepthFactor(d[0])
    const fy = parallaxDepthFactor(d[1])
    cx += fx * parOffX
    cy += fy * parOffY
  }

  // 先平移到以锚点为原点
  let px = wx - cx
  let py = wy - cy

  // 3) 逆旋转。正变换是 rotateZ(-angle)，逆变换即按 +angle 转回来
  const ang = layer.angles ? layer.angles[2] : 0
  if (ang) {
    const c = Math.cos(-ang)
    const s = Math.sin(-ang)
    // 正变换（列主序 mat4RotateZ(-ang)）作用于列向量是 [c*x - s*y, s*x + c*y]；
    // 其逆为转置（旋转矩阵正交）：[c*x + s*y, -s*x + c*y]
    const rx = px * c + py * s
    const ry = -px * s + py * c
    px = rx
    py = ry
  }

  // 4) alignment 锚点偏移。**单位是像素，不是局部 quad**。
  //    正变换顺序是 …→ rotateZ → translate((0.5-ax)*w, (0.5-ay)*h) → mat4Scale(w,h)。
  //    这里的矩阵是列主序、右乘施加，`mat4Scale` 只作用于它**右侧**的顶点，
  //    并不会放大它左侧已经累积的平移量 —— 所以平移量必须自己带上 w/h。
  //    逆变换在像素空间减掉同一个偏移，然后才归一化。
  //    两边公式必须逐字一致，否则画面在一边、命中区在另一边。
  const a = (alignTable && alignTable[layer.alignment]) || [0.5, 0.5]
  if (a[0] !== 0.5 || a[1] !== 0.5) {
    px -= (0.5 - a[0]) * w
    py -= (0.5 - a[1]) * h
  }

  // 归一化到局部 quad（[-0.5, 0.5]）
  return { lx: px / w, ly: py / h, w, h }
}

/**
 * 命中测试：返回最上层（z 序最后）命中的可见图层。
 *
 * @param {Array} layers scene.layers（顺序即绘制顺序，后者在上）
 * @param {number} wx 世界 x
 * @param {number} wy 世界 y
 * @param {number} projH cam.projH
 * @param {object} [opts]
 * @param {number} [opts.parOffX] 对象视差位移 x
 * @param {number} [opts.parOffY] 对象视差位移 y
 * @param {Record<string, number[]>} [opts.alignTable] ALIGN 表
 * @param {(layer:object)=>boolean} [opts.filter] 额外过滤（例如只考虑挂了 cursor 回调的层）
 * @returns {object|null} 命中的图层，或 null
 */
export function hitTestLayers(layers, wx, wy, projH, opts = {}) {
  if (!layers || layers.length === 0) return null
  const parOffX = opts.parOffX || 0
  const parOffY = opts.parOffY || 0
  const alignTable = opts.alignTable
  const filter = opts.filter
  // 从上往下找：layers 顺序即绘制顺序，后画的在上面
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i]
    // 可见性已由 parse.js 沿父链求得（见文件头说明），隐藏层不参与命中
    if (!layer || !layer.visible || layer.destroyed) continue
    if (filter && !filter(layer)) continue
    const loc = worldToLayerLocal(layer, wx, wy, projH, parOffX, parOffY, alignTable)
    if (!loc) continue
    if (Math.abs(loc.lx) <= 0.5 && Math.abs(loc.ly) <= 0.5) return layer
  }
  return null
}
