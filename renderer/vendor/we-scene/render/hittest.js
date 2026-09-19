import { layerParallaxOffset } from './math.js'

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
 * ---- perspective 图层（2026-09-15 补）----
 *
 * layer.perspective 的层由 buildLayerPerspectiveVP 的透视相机绘制，模型矩阵多叠
 * 了 X/Y 旋转（M = T·Rz·Ry·Rx，与 layerModelMatrix 同序）。这类层的命中不能再用
 * 「世界点逆变换」（点在 z=0、层已旋出 z=0 平面），改做**射线-平面求交**：
 * 指针在 z=0 上的世界点 (wx,wy,0) 与透视眼点 eye 连成射线，与图层旋转后的平面
 * 求交，交点再经 Rᵀ 逆旋回局部。z=0 平面上两个相机逐像素重合，所以非透视层
 * 不受影响仍走原路径。
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
export function worldToLayerLocal(layer, wx, wy, projH, parOffX, parOffY, alignTable, perspEye, parallaxCtx) {
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
  // [we-scene patch] 与 layerModelMatrix 共用 layerParallaxOffset（legacy / mirage
  // 双路径）。ctx 缺席时回退旧 parOffX×(d/2)（离线校验兼容路径）。
  if (layer.parallaxDepth && parallaxCtx) {
    const off = layerParallaxOffset(layer, parallaxCtx)
    cx += off[0]
    cy += off[1]
  } else if (layer.parallaxDepth && (parOffX !== 0 || parOffY !== 0)) {
    const d = layer.parallaxDepth
    cx += d[0] * 0.5 * parOffX
    cy += d[1] * 0.5 * parOffY
  }

  // perspective 图层：射线-平面求交（见文件头「perspective 图层」节）。
  if (layer.perspective && perspEye) {
    return perspLayerLocal(layer, wx, wy, cx, cy, w, h, alignTable, perspEye)
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

// 列主序 3×3，与 math.js 的 mat4Rotate* 同排布、同符号。
function rotZ3(a) { const c = Math.cos(a), s = Math.sin(a); return [c, s, 0, -s, c, 0, 0, 0, 1] }
function rotY3(a) { const c = Math.cos(a), s = Math.sin(a); return [c, 0, -s, 0, 1, 0, s, 0, c] }
function rotX3(a) { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, c, s, 0, -s, c] }
function mul3(a, b) {
  const o = new Array(9)
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) {
    o[c * 3 + r] = a[r] * b[c * 3] + a[3 + r] * b[c * 3 + 1] + a[6 + r] * b[c * 3 + 2]
  }
  return o
}

/**
 * perspective 图层的命中：透视眼点 eye 与指针 z=0 世界点连成射线，
 * 与图层旋转平面（锚点 C、法线 R·(0,0,1)）求交，交点逆旋回局部。
 * 旋转 R = Rz(-z)·Ry(-y)·Rx(x)，与 layerModelMatrix 的透视分支**逐字同序同号**
 * （Y 取负见 renderer.js 透视分支注释）；锚点 C 的视差偏移已在调用点并入 cx/cy。
 */
function perspLayerLocal(layer, wx, wy, cx, cy, w, h, alignTable, eye) {
  const cz = (layer.origin || [0, 0, 0])[2] || 0
  const angles = layer.angles || [0, 0, 0]
  let r = rotZ3(-(angles[2] || 0))
  r = mul3(r, rotY3(-(angles[1] || 0)))
  r = mul3(r, rotX3(angles[0] || 0))
  // 平面法线 = R 的第三列
  const nx = r[6], ny = r[7], nz = r[8]
  const dx = wx - eye[0], dy = wy - eye[1], dz = -eye[2]
  const denom = nx * dx + ny * dy + nz * dz
  if (Math.abs(denom) < 1e-9) return null
  const ex = cx - eye[0], ey = cy - eye[1], ez = cz - eye[2]
  const t = (nx * ex + ny * ey + nz * ez) / denom
  const px = eye[0] + dx * t - cx
  const py = eye[1] + dy * t - cy
  const pz = eye[2] + dz * t - cz
  // v = Rᵀ·p（R 正交，逆=转置；列主序下即各列与 p 的点积）
  let lx = r[0] * px + r[1] * py + r[2] * pz
  let ly = r[3] * px + r[4] * py + r[5] * pz
  const a = (alignTable && alignTable[layer.alignment]) || [0.5, 0.5]
  if (a[0] !== 0.5 || a[1] !== 0.5) {
    lx -= (0.5 - a[0]) * w
    ly -= (0.5 - a[1]) * h
  }
  return { lx: lx / w, ly: ly / h, w, h }
}

/**
 * 命中测试（**全部命中**）：返回所有命中的可见图层，按 z 序**从上到下**排列。
 *
 * 为什么需要「全部命中」：WE 的 cursor 回调是**按图层各自判定命中**派发的，
 * 不存在「上层把下层挡住」这回事 —— 两个参考实现都如此：
 *   - open-wallpaper-engine `Script.cpp` 的 `TickAll()`：遍历**每个** field script，
 *     自己 `HitTestNode(node, cursor)`（世界 AABB 包含判定），命中的都收事件；
 *   - Mirage `ScriptRuntime.cpp`：遍历**每个** script 的节点，`ResolveCursorNode`
 *     + `ancestors_visible` 各自判定，`over_node` 的全部派发。
 * 3801397319 的右上角正是两个**同位同尺寸**的交互区（切换人物形态 #104 + 作者水印
 * #118，两个 quad 的 origin/size/scale 完全相同）：只派发给最上层那一个，
 * 「切换人物」的 cursorClick 永远不触发（点了只闪水印）。
 *
 * @param {Array} layers scene.layers（顺序即绘制顺序，后者在上）
 * @param {number} wx 世界 x
 * @param {number} wy 世界 y
 * @param {number} projH cam.projH
 * @param {object} [opts]
 * @param {number} [opts.parOffX] 对象视差位移 x
 * @param {number} [opts.parOffY] 对象视差位移 y
 * @param {Record<string, number[]>} [opts.alignTable] ALIGN 表
 * @param {number[]} [opts.perspEye] perspective 图层相机眼点（renderer.getPerspectiveEye()），
 *   场景无透视层时为 null/缺省
 * @param {(layer:object)=>boolean} [opts.filter] 额外过滤（例如只考虑挂了 cursor 回调的层）
 * @returns {object[]} 命中的图层（z 序自上而下），无命中为 []
 */
export function hitTestLayersAll(layers, wx, wy, projH, opts = {}) {
  if (!layers || layers.length === 0) return []
  const parOffX = opts.parOffX || 0
  const parOffY = opts.parOffY || 0
  const parallaxCtx = opts.parallaxCtx
  const alignTable = opts.alignTable
  const filter = opts.filter
  const out = []
  // 从上往下扫：layers 顺序即绘制顺序，后画的在上面
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i]
    // 可见性已由 parse.js 沿父链求得（见文件头说明），隐藏层不参与命中
    if (!layer || !layer.visible || layer.destroyed) continue
    if (filter && !filter(layer)) continue
    const loc = worldToLayerLocal(layer, wx, wy, projH, parOffX, parOffY, alignTable, opts.perspEye, parallaxCtx)
    if (!loc) continue
    if (Math.abs(loc.lx) <= 0.5 && Math.abs(loc.ly) <= 0.5) out.push(layer)
  }
  return out
}

/**
 * 命中测试（单点查询）：返回最上层（z 序最后）命中的可见图层。
 * 与 hitTestLayersAll 同一实现，取第一个。派发一律用 All（见其注释）。
 *
 * @returns {object|null} 命中的图层，或 null
 */
export function hitTestLayers(layers, wx, wy, projH, opts = {}) {
  const all = hitTestLayersAll(layers, wx, wy, projH, opts)
  return all.length ? all[0] : null
}
