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
 * ---- 可见性必须沿父链，但**不看自身** ----
 *
 * 命中门槛用 `layer.ancestorsVisible`（parse.js / recomputeLayerVisibility 维护），
 * **不是** 渲染用的 `layer.visible`。两者只差「自身 visible」这一项，而这正是必需的分叉：
 *
 *   - 官方 SceneScript 参考页（scene/scenescript/reference/event/cursor）写明
 *     「All mouse cursor events will only work on objects marked as Solid」——
 *     Solid 层就是作者的**点击区**，而点击区常被设成 `visible:false` 当隐形热区。
 *     3810092560（鲸鱼娘 点击互动）25 个 Solid 点击区全部 `visible:false`，挂 scale
 *     脚本按 `targetLayerNames` 挤压对应的模型层：按有效可见性排除 = 整张壁纸点不动。
 *   - 两个参考实现也都不看自身：open-wallpaper-engine `Script.cpp::TickAll` 的
 *     `HitTestNode(node, cursor)` 完全不查可见性；Mirage `ScriptRuntime.cpp` 走
 *     `ResolveCursorNode` + `ancestors_visible`（只看祖先）。
 *   - 3012694124 的「MEDIA SHOW WINDOW」「Show window clock」按钮本身就是 `value:false`
 *     的隐藏层，click 里把自己藏起来、把窗口组显示出来 —— 自身不可命中的话窗口关了
 *     就再也打不开。
 *
 * 祖先可见性仍然必须查：3299228616 有 6 套语言变体图层，只有 ENG 根层可见，但
 * **子层自己都是 visible=true** —— 只看自身会让 5 套隐藏语言的图层一起参与命中。
 * 本仓早先用「有效可见性」把这个用例和上面的隐形热区一起排除了，是过收紧。
 *
 * ---- 不要按「只对 Solid 生效」加图层类型闸门 ----
 *
 * 上面那句官方文案是**编辑器**口径，不是运行时过滤：WE 自带示例 dino_run 的
 * `mario_walk_1#28` 是 model 层（非 Solid），cursorDown 就是它的点击跳跃；
 * 本仓语料 1001 个 cursor 钩子里 613 个挂在非 Solid 层上。按类型设闸会把
 * 这些一起打死（2026-10-03 查证：WE 安装目录 projects/defaultprojects 实测）。
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
    // 命中门槛 = 祖先可见性（见文件头）：自身 visible 不参与 —— 隐形 Solid 点击区
    // 靠的就是它。`ancestorsVisible` 缺席时（手工构造的层/老调用方）退回有效可见性。
    if (!layer || layer.destroyed) continue
    const ancVis = layer.ancestorsVisible !== undefined ? layer.ancestorsVisible : layer.visible
    if (ancVis === false) continue
    if (filter && !filter(layer)) continue
    // [we-scene patch 2026-10-07] 编辑器（W15）：模型层按蒙皮网格精判。回调返回
    // true/false 即为结论（网格可以伸出图层矩形，所以排在 OBB 之前）；undefined =
    // 没有网格几何，落回 OBB。播放路径不传 meshHit，逐位不变。
    if (opts.meshHit) {
      const r = opts.meshHit(layer)
      if (r === true) { out.push(layer); continue }
      if (r === false) continue
    }
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

/**
 * [we-scene patch] worldToLayerLocal 的**正变换**：图层锚点与 OBB 四角的世界坐标
 * （像素，y 向下）。编辑器画选中框用；两边公式必须逐字互逆，否则框与命中区错开。
 *
 * 零尺寸层（组 / 粒子 / 声音）与 perspective 层只给锚点，corners 为 null
 * （后者的四角在透视相机下不落在 z=0 平面上，正交换算画不准）。
 *
 * @returns {{anchor:[number,number], corners:Array<[number,number]>|null}}
 */
export function layerQuadWorld(layer, projH, alignTable, parallaxCtx) {
  const origin = layer.origin || [0, 0, 0]
  let cx = origin[0]
  let cy = projH - origin[1]
  if (layer.parallaxDepth && parallaxCtx) {
    const off = layerParallaxOffset(layer, parallaxCtx)
    cx += off[0]
    cy += off[1]
  }
  const size = layer.size || [0, 0]
  const scale = layer.scale || [1, 1, 1]
  const w = size[0] * scale[0]
  const h = size[1] * scale[1]
  if (!(w > 0) || !(h > 0) || layer.perspective) return { anchor: [cx, cy], corners: null }
  const ang = layer.angles ? layer.angles[2] : 0
  const c = Math.cos(-ang)
  const s = Math.sin(-ang)
  const a = (alignTable && alignTable[layer.alignment]) || [0.5, 0.5]
  const offX = (0.5 - a[0]) * w
  const offY = (0.5 - a[1]) * h
  const corners = []
  for (const [lx, ly] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]) {
    const qx = lx * w + offX
    const qy = ly * h + offY
    corners.push([cx + c * qx - s * qy, cy + s * qx + c * qy])
  }
  return { anchor: [cx, cy], corners }
}

/**
 * [we-scene patch 2026-10-07] 编辑器（W15）：把蒙皮后的网格（mdl-skin `skinnedMeshes`）
 * 用绘制同一个 MVP 投到画布 CSS 像素。保留裁剪坐标：跨近裁剪面（GL 的 z = −w）的三角形
 * 要像 GPU 那样裁掉面外部分再参与命中/凸包 —— 整个丢掉的话，铺到相机身后的地面
 * （3477054430 城镇）近处画出来的像素就点不中。远裁剪面不裁（只会让命中区略大）。
 *
 * @returns {Array<{clip:Float64Array, xy:Float64Array, ok:Uint8Array, indices:ArrayLike<number>, indexCount:number, cssW:number, cssH:number}>}
 */
export function projectMeshesToScreen(meshes, mvp, cssW, cssH) {
  const m = mvp
  return meshes.map((me) => {
    const n = me.vertexCount
    const p = me.pos
    const clip = new Float64Array(n * 4)
    const xy = new Float64Array(n * 2)
    const ok = new Uint8Array(n)
    for (let i = 0; i < n; i++) {
      const x = p[i * 3]
      const y = p[i * 3 + 1]
      const z = p[i * 3 + 2]
      const cx = m[0] * x + m[4] * y + m[8] * z + m[12]
      const cy = m[1] * x + m[5] * y + m[9] * z + m[13]
      const cz = m[2] * x + m[6] * y + m[10] * z + m[14]
      const cw = m[3] * x + m[7] * y + m[11] * z + m[15]
      clip[i * 4] = cx
      clip[i * 4 + 1] = cy
      clip[i * 4 + 2] = cz
      clip[i * 4 + 3] = cw
      if (!(cz + cw >= 0) || !(cw > 1e-9)) continue
      xy[i * 2] = ((cx / cw + 1) / 2) * cssW
      xy[i * 2 + 1] = ((1 - cy / cw) / 2) * cssH
      ok[i] = 1
    }
    return { clip, xy, ok, indices: me.indices, indexCount: me.indexCount, cssW, cssH }
  })
}

/** 跨近裁剪面的三角形：裁掉面外部分，返回屏幕多边形（凸，3–4 点）；整个在面外返回 null */
function clippedTriangle(me, i0, i1, i2) {
  const C = me.clip
  const vs = [i0, i1, i2]
  const out = []
  for (let k = 0; k < 3; k++) {
    const a = vs[k]
    const b = vs[(k + 1) % 3]
    const da = C[a * 4 + 2] + C[a * 4 + 3]
    const db = C[b * 4 + 2] + C[b * 4 + 3]
    if (da >= 0) out.push([C[a * 4], C[a * 4 + 1], C[a * 4 + 3]])
    if ((da >= 0) !== (db >= 0)) {
      const t = da / (da - db)
      out.push([
        C[a * 4] + t * (C[b * 4] - C[a * 4]),
        C[a * 4 + 1] + t * (C[b * 4 + 1] - C[a * 4 + 1]),
        C[a * 4 + 3] + t * (C[b * 4 + 3] - C[a * 4 + 3]),
      ])
    }
  }
  if (out.length < 3) return null
  const poly = []
  for (const [cx, cy, cw] of out) {
    if (!(cw > 1e-9)) return null
    poly.push([((cx / cw + 1) / 2) * me.cssW, ((1 - cy / cw) / 2) * me.cssH])
  }
  return poly
}

/**
 * 投影网格的凸包（Andrew 单调链，屏幕 y 向下）。只收被三角形引用的顶点（跨近裁剪面的取裁剪后的点）。
 * 百万级顶点（导入的高模）先按八方向极值围成的凸八边形剔掉严格在内的点（Akl–Toussaint，结果不变），
 * 只给幸存点建数组再排序 —— 否则每个顶点一个小数组 + 全量排序要上百毫秒，选中框每帧都调它。
 */
export function screenMeshesHull(proj) {
  const extra = []
  const used = []
  let total = 0
  for (const me of proj) {
    const u = new Uint8Array(me.ok.length)
    const idx = me.indices
    for (let k = 0; k + 2 < me.indexCount; k += 3) {
      const i0 = idx[k]
      const i1 = idx[k + 1]
      const i2 = idx[k + 2]
      const all = me.ok[i0] && me.ok[i1] && me.ok[i2]
      if (!all && (me.ok[i0] || me.ok[i1] || me.ok[i2] || crossesNear(me, i0, i1, i2))) {
        const poly = clippedTriangle(me, i0, i1, i2)
        if (poly) for (const q of poly) extra.push(q)
        continue
      }
      if (!all) continue
      u[i0] = 1
      u[i1] = 1
      u[i2] = 1
    }
    used.push(u)
    for (let i = 0; i < u.length; i++) total += u[i]
  }
  const pts = []
  if (total > 4096) {
    // 八方向极值：x、y、x+y、x−y 各取最小 / 最大的那个点；它们的凸包当筛子
    const lo = new Float64Array(4).fill(Infinity)
    const hi = new Float64Array(4).fill(-Infinity)
    const loP = new Float64Array(8)
    const hiP = new Float64Array(8)
    const visit = (x, y) => {
      for (let d = 0; d < 4; d++) {
        const v = d === 0 ? x : d === 1 ? y : d === 2 ? x + y : x - y
        if (v < lo[d]) { lo[d] = v; loP[d * 2] = x; loP[d * 2 + 1] = y }
        if (v > hi[d]) { hi[d] = v; hiP[d * 2] = x; hiP[d * 2 + 1] = y }
      }
    }
    proj.forEach((me, j) => {
      const u = used[j]
      for (let i = 0; i < u.length; i++) if (u[i]) visit(me.xy[i * 2], me.xy[i * 2 + 1])
    })
    for (const q of extra) visit(q[0], q[1])
    const oct = monotoneHull([0, 1, 2, 3].flatMap((d) => [[loP[d * 2], loP[d * 2 + 1]], [hiP[d * 2], hiP[d * 2 + 1]]]))
    const inside = oct.length >= 3 ? (x, y) => strictlyInsideConvex(oct, x, y) : () => false
    proj.forEach((me, j) => {
      const u = used[j]
      for (let i = 0; i < u.length; i++) {
        if (!u[i]) continue
        const x = me.xy[i * 2]
        const y = me.xy[i * 2 + 1]
        if (!inside(x, y)) pts.push([x, y])
      }
    })
    for (const q of extra) if (!inside(q[0], q[1])) pts.push(q)
    for (const q of oct) pts.push(q)
  } else {
    proj.forEach((me, j) => {
      const u = used[j]
      for (let i = 0; i < u.length; i++) if (u[i]) pts.push([me.xy[i * 2], me.xy[i * 2 + 1]])
    })
    for (const q of extra) pts.push(q)
  }
  return monotoneHull(pts)
}

/** 严格在凸多边形（逆时针或顺时针皆可）内部，边上不算 */
function strictlyInsideConvex(poly, x, y) {
  let sign = 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    const c = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0])
    if (c === 0) return false
    const s = c > 0 ? 1 : -1
    if (sign === 0) sign = s
    else if (s !== sign) return false
  }
  return true
}

function monotoneHull(pts) {
  if (pts.length < 3) return pts.length ? pts : null
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower = []
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper = []
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop()
    upper.push(p)
  }
  lower.pop()
  upper.pop()
  return lower.concat(upper)
}

// 三个顶点都没进可见集时，仍可能有顶点在面内（只是 w 极小）——按裁剪距离判断是否跨面
function crossesNear(me, i0, i1, i2) {
  const C = me.clip
  const d0 = C[i0 * 4 + 2] + C[i0 * 4 + 3] >= 0
  const d1 = C[i1 * 4 + 2] + C[i1 * 4 + 3] >= 0
  const d2 = C[i2 * 4 + 2] + C[i2 * 4 + 3] >= 0
  return (d0 || d1 || d2) && !(d0 && d1 && d2)
}

function pointInConvex(hull, x, y) {
  let sign = 0
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i]
    const b = hull[(i + 1) % hull.length]
    const c = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0])
    if (c === 0) continue
    const s = c > 0 ? 1 : -1
    if (sign === 0) sign = s
    else if (s !== sign) return false
  }
  return true
}

function polyArea2(P) {
  let a = 0
  for (let i = 0; i < P.length; i++) {
    const p = P[i]
    const q = P[(i + 1) % P.length]
    a += p[0] * q[1] - q[0] * p[1]
  }
  return a
}

/**
 * 点 (x, y)（CSS 像素）是否落在投影网格的某个三角形内（含边）。先凸包粗判再逐三角形。
 * hull 可传 screenMeshesHull 的结果省一次计算。
 */
export function screenMeshesContain(proj, x, y, hull) {
  const h = hull === undefined ? screenMeshesHull(proj) : hull
  if (!h || h.length < 3 || !pointInConvex(h, x, y)) return false
  for (const me of proj) {
    if (me.indexCount > GRID_MIN_INDICES) {
      const g = me._grid || (me._grid = buildTriGrid(me))
      if (x >= g.x0 && y >= g.y0 && x <= g.x0 + g.cw * GRID_N && y <= g.y0 + g.ch * GRID_N) {
        const cx = Math.min(GRID_N - 1, Math.floor((x - g.x0) / g.cw))
        const cy = Math.min(GRID_N - 1, Math.floor((y - g.y0) / g.ch))
        const c = cy * GRID_N + cx
        for (let j = g.start[c]; j < g.start[c + 1]; j++) if (triangleContains(me, g.tris[j] * 3, x, y)) return true
      }
      for (let j = 0; j < g.partial.length; j++) if (triangleContains(me, g.partial[j] * 3, x, y)) return true
      continue
    }
    for (let k = 0; k + 2 < me.indexCount; k += 3) if (triangleContains(me, k, x, y)) return true
  }
  return false
}

const GRID_MIN_INDICES = 30000
const GRID_N = 64

function triangleContains(me, k, x, y) {
  const xy = me.xy
  const ok = me.ok
  const idx = me.indices
  const i0 = idx[k]
  const i1 = idx[k + 1]
  const i2 = idx[k + 2]
  if (!ok[i0] || !ok[i1] || !ok[i2]) {
    if (!(ok[i0] || ok[i1] || ok[i2] || crossesNear(me, i0, i1, i2))) return false
    const poly = clippedTriangle(me, i0, i1, i2)
    return !!(poly && polyArea2(poly) !== 0 && pointInConvex(poly, x, y))
  }
  const ax = xy[i0 * 2]
  const ay = xy[i0 * 2 + 1]
  const bx = xy[i1 * 2]
  const by = xy[i1 * 2 + 1]
  const cx = xy[i2 * 2]
  const cy = xy[i2 * 2 + 1]
  if ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax) === 0) return false
  const d1 = (bx - ax) * (y - ay) - (by - ay) * (x - ax)
  const d2 = (cx - bx) * (y - by) - (cy - by) * (x - bx)
  const d3 = (ax - cx) * (y - cy) - (ay - cy) * (x - cx)
  const neg = d1 < 0 || d2 < 0 || d3 < 0
  const pos = d1 > 0 || d2 > 0 || d3 > 0
  return !(neg && pos)
}

/**
 * 大网格的命中加速：完全在近裁剪面内的三角形按屏幕包围盒登记进 GRID_N² 格（CSR 存储），
 * 跨面 / 部分可见的进 partial 线性表。查询只测所在格 + partial，判定与逐个扫描相同。
 */
function buildTriGrid(me) {
  const xy = me.xy
  const ok = me.ok
  const idx = me.indices
  const triCount = Math.floor(me.indexCount / 3)
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (let i = 0; i < ok.length; i++) {
    if (!ok[i]) continue
    const x = xy[i * 2]
    const y = xy[i * 2 + 1]
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (y < y0) y0 = y
    if (y > y1) y1 = y
  }
  const partial = []
  if (!(x1 >= x0 && y1 >= y0)) {
    for (let t = 0; t < triCount; t++) partial.push(t)
    return { x0: 0, y0: 0, cw: 0, ch: 0, start: new Uint32Array(GRID_N * GRID_N + 1), tris: new Uint32Array(0), partial }
  }
  const cw = Math.max((x1 - x0) / GRID_N, 1e-9)
  const ch = Math.max((y1 - y0) / GRID_N, 1e-9)
  const cell = (v, v0, s) => Math.min(GRID_N - 1, Math.max(0, Math.floor((v - v0) / s)))
  const range = new Int32Array(triCount * 4)
  const count = new Uint32Array(GRID_N * GRID_N + 1)
  for (let t = 0; t < triCount; t++) {
    const i0 = idx[t * 3]
    const i1 = idx[t * 3 + 1]
    const i2 = idx[t * 3 + 2]
    if (!ok[i0] || !ok[i1] || !ok[i2]) {
      range[t * 4] = -1
      if (ok[i0] || ok[i1] || ok[i2] || crossesNear(me, i0, i1, i2)) partial.push(t)
      continue
    }
    const ax = xy[i0 * 2], ay = xy[i0 * 2 + 1], bx = xy[i1 * 2], by = xy[i1 * 2 + 1], qx = xy[i2 * 2], qy = xy[i2 * 2 + 1]
    const cx0 = cell(Math.min(ax, bx, qx), x0, cw)
    const cx1 = cell(Math.max(ax, bx, qx), x0, cw)
    const cy0 = cell(Math.min(ay, by, qy), y0, ch)
    const cy1 = cell(Math.max(ay, by, qy), y0, ch)
    range[t * 4] = cx0
    range[t * 4 + 1] = cx1
    range[t * 4 + 2] = cy0
    range[t * 4 + 3] = cy1
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) count[cy * GRID_N + cx + 1]++
  }
  for (let c = 0; c < GRID_N * GRID_N; c++) count[c + 1] += count[c]
  const start = count
  const fill = start.slice(0, GRID_N * GRID_N)
  const tris = new Uint32Array(start[GRID_N * GRID_N])
  for (let t = 0; t < triCount; t++) {
    if (range[t * 4] < 0) continue
    for (let cy = range[t * 4 + 2]; cy <= range[t * 4 + 3]; cy++) {
      for (let cx = range[t * 4]; cx <= range[t * 4 + 1]; cx++) tris[fill[cy * GRID_N + cx]++] = t
    }
  }
  return { x0, y0, cw, ch, start, tris, partial }
}
