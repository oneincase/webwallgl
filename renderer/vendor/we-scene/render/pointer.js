/**
 * [we-scene patch] 统一指针输入源。
 *
 * 为什么需要它：改动前渲染器有**两个互不知晓**的 mousemove 监听器，用**两套
 * 不同的归一化约定**，而 WE 的指针语义有四个消费方，各自要的空间还不一样：
 *
 *   - 相机视差（renderer.js）：曾自挂监听器，归一化到 [-1,1]，且**永不移除** ——
 *     每次重挂载泄漏一个监听器（场景壁纸切换/改属性都会重挂载）；
 *   - 粒子 controlpoint.locktopointer（main.ts）：曾自挂监听器，归一化到 [0,1]，
 *     且**仅当 particleSystems.length > 0 时才挂**，没有粒子的场景拿不到指针；
 *   - 效果 shader 的 g_PointerPosition / g_PointerPositionLast：归一化 [0,1]、Y 朝下；
 *   - 脚本沙箱的 input.cursorWorldPosition（世界像素）/ input.cursorScreenPosition
 *     （屏幕像素）/ input.cursorLeftDown，以及 6 个 cursor* 回调的 event.worldPosition。
 *
 * 本模块产出**单一可变状态对象**，一处监听、多方读取，同时修掉上面的泄漏与漏挂。
 *
 * ---- 坐标空间（全部由真实语料反推，不要凭名字猜）----
 *
 * u / v：归一化 [0,1]，原点在**左上角**，Y 朝下 —— 即原始鼠标事件空间
 *   （clientX / innerWidth）。这是 g_PointerPosition 的空间：全库 43 个指针
 *   shader 里，cursorripple_apply_force.vert / iris_follow_cursor.vert 等都写着
 *   `pointer.y = 1.0 - pointer.y; // Flip pointer screen space Y to match texture
 *   space Y`，明确了「传进来的是 Y 朝下的屏幕空间」。
 *
 * screenX / screenY：屏幕**像素**，原点在角。input.cursorScreenPosition 的空间。
 *   依据：3791967416 写 `input.cursorScreenPosition.x / engine.screenResolution.x`
 *   才得到 [0,1]；3509243656 手动 `(x - screenResolution.x/2) / (screenResolution.x/2)`
 *   才得到 [-1,1] —— 两处都证明原值是像素且原点不在中心。
 *
 * wx / wy：场景**渲染世界像素**，Y 朝下。hit-test 与这一套对齐
 *   （layerModelMatrix 的世界位置是 `projH - origin.y`）。
 *
 * originY：图层 **origin 空间**（WE Y-up）的指针纵坐标 = `projH - wy`。
 *   脚本 `input.cursorWorldPosition` / `event.worldPosition` 用这个，因为
 *   3292361861「鼠标指针」直接 `value.y = input.cursorWorldPosition.y` 赋给
 *   origin —— origin 是 Y-up，喂 wy 会让跟随动画上下反着走。
 *   没拿到 cam.projH 时 originY 与 wy 相同（离线测试不传 projH 保持旧行为）。
 *
 * ---- last 快照按「帧」而不是按「事件」推进 ----
 *
 * g_PointerPositionLast 与 input.cursorPositionLast 的语义是「**上一帧**的位置」。
 * 若在事件回调里更新 last，那么鼠标事件频率（常 >120Hz）高于帧率时，
 * last 与 current 会趋于同一个事件的值，`length(g_PointerPosition -
 * g_PointerPositionLast)` 恒接近 0 —— cursorripple 的 v_PointDelta.x 归零，
 * 水波完全不起波（且没有任何报错）。所以 last 只在 beginFrame() 里推进。
 *
 * beginFrame 必须在**本帧所有消费方之后**调用（shader / 脚本 input / 粒子）。
 * 指针是事件驱动的：rAF 之间的 mousemove 已经把 current 写成了新位置。
 * 若在消费前 last = current，帧间位移当场归零 —— 3299228616 的鼠标涟漪就是
 * 这样「效果在跑、力场恒为零」。正确顺序：消费（last=上帧, current=新）→
 * 再 beginFrame 把 last 推到 current，留给下一帧。
 */

/**
 * 创建指针源。无条件挂载（不依赖场景里有没有粒子/视差），由宿主在 dispose 时移除。
 *
 * @param {object} [opts]
 * @param {Window|Element} [opts.target] 事件挂载目标，默认 window（便于离线测试注入假对象）。
 *   传 Element（如宿主传入的 canvas）时事件只在元素上接收 —— 嵌入式实例
 *   不该截获整页指针。
 * @param {() => {w:number, h:number}} [opts.viewport] 视口尺寸提供者，用于归一化
 *   u/v 与 engine.screenResolution。默认读 window.innerWidth/innerHeight；
 *   嵌入式实例传 canvas 的 clientWidth/clientHeight，指针归一化才与画面对齐。
 * @returns {object} 指针状态 + 控制方法
 */
export function createPointerSource(opts = {}) {
  const target = opts.target || (typeof window !== 'undefined' ? window : null)
  // 视口提供者：默认 window 尺寸；嵌入式实例（canvas 宿主）传 clientWidth/Height
  const readViewportSize = opts.viewport || (typeof window !== 'undefined'
    ? () => ({ w: window.innerWidth || 1, h: window.innerHeight || 1 })
    : null)

  const state = {
    // 归一化 [0,1]，Y 朝下（g_PointerPosition 空间）
    u: 0.5,
    v: 0.5,
    // 屏幕像素（input.cursorScreenPosition 空间）
    screenX: 0,
    screenY: 0,
    // 渲染世界像素，Y 朝下（hit-test 空间）
    wx: 0,
    wy: 0,
    // origin 空间 Y（Y-up）：脚本 cursorWorldPosition / event.worldPosition
    originY: null,
    // 上一帧快照（g_PointerPositionLast / input.cursorPositionLast）
    lastU: 0.5,
    lastV: 0.5,
    lastScreenX: 0,
    lastScreenY: 0,
    lastWx: 0,
    lastWy: 0,
    lastOriginY: null,
    // 鼠标左键按下（input.cursorLeftDown，全库 2 处在用）
    leftDown: false,
    // 是否收到过真实事件。u/v 未收到时停在屏幕中心（0.5,0.5）：视差 / 粒子 /
    // iris 要的是「相对中心为零」。xray 开窗另在 bind 时停到相机外
    // （见 xrayShouldParkPointer），不要把全局指针初值改到角上 —— 角上会让
    // 涟漪/虹膜在用户还没动鼠标时就从左上角起。
    has: false,
    // 诊断计数
    moveCount: 0,
    downCount: 0,
    upCount: 0,
    lastEventTime: 0,
    // 屏幕尺寸（engine.screenResolution）；每次事件与 beginFrame 时刷新，
    // 因为渲染器没有 resize 监听，缓存下来会在改窗口后失效
    screenW: 1,
    screenH: 1,
  }

  function readViewport() {
    if (!readViewportSize) return
    const v = readViewportSize()
    state.screenW = v.w || 1
    state.screenH = v.h || 1
  }
  readViewport()

  function onMove(ev) {
    readViewport()
    // 目标是 Element（嵌入式 canvas 宿主）时，clientX/Y 是**页面**坐标，
    // 必须减掉元素偏移；window 目标的 clientX/Y 本就是视口坐标，不用减。
    let x = ev.clientX
    let y = ev.clientY
    if (target && typeof target.getBoundingClientRect === 'function') {
      const r = target.getBoundingClientRect()
      x -= r.left
      y -= r.top
    }
    const u = x / state.screenW
    const v = y / state.screenH
    // 首个事件把 last 对齐到 current：默认 last 停在屏幕中心 (0.5,0.5)，
    // 否则第一次移动会从中心拉出一道贯穿全屏的假波纹。
    if (!state.has) {
      state.lastU = u
      state.lastV = v
      state.lastScreenX = x
      state.lastScreenY = y
    }
    state.screenX = x
    state.screenY = y
    state.u = u
    state.v = v
    state.has = true
    state.moveCount++
    state.lastEventTime = Date.now()
  }
  // 只跟踪左键（button 0）。中/右键不属于 cursorLeftDown 语义。
  function onDown(ev) {
    if (ev.button !== undefined && ev.button !== 0) return
    state.leftDown = true
    state.downCount++
  }
  function onUp(ev) {
    if (ev.button !== undefined && ev.button !== 0) return
    state.leftDown = false
    state.upCount++
  }
  // 指针移出窗口后松手，mouseup 落在窗口外收不到 —— 不清掉会让 leftDown 永久卡住，
  // 点击类脚本（3791967416 的 hovered && cursorLeftDown）从此一直认为按键按着。
  function onLeaveWindow() {
    state.leftDown = false
  }

  let attached = false
  if (target && target.addEventListener) {
    attached = true
    target.addEventListener('mousemove', onMove, { passive: true })
    target.addEventListener('mousedown', onDown, { passive: true })
    target.addEventListener('mouseup', onUp, { passive: true })
    target.addEventListener('blur', onLeaveWindow, { passive: true })
    if (typeof document !== 'undefined' && document.addEventListener) {
      // mouseleave 冒到 document 才能覆盖「拖出浏览器窗口再松手」
      document.addEventListener('mouseleave', onLeaveWindow, { passive: true })
    }
  }

  return {
    state,

    /**
     * 每帧所有消费方读完 current/last **之后**调用一次：把 last 推到 current。
     * 事件驱动下 current 在 rAF 之间已被 mousemove 更新；消费前调用会把
     * 帧间位移抹成 0（见文件头注释）。
     */
    beginFrame() {
      readViewport()
      state.lastU = state.u
      state.lastV = state.v
      state.lastScreenX = state.screenX
      state.lastScreenY = state.screenY
      state.lastWx = state.wx
      state.lastWy = state.wy
      state.lastOriginY = state.originY
    },

    /**
     * 用当前相机把归一化坐标换算成世界像素。
     * cam 只在 renderer.render 内部可得（每帧由 buildCamera 构造），故由渲染器
     * 在帧内回调本方法，而不是让本模块自己算。
     *
     * wy 是渲染世界 Y 朝下（hit-test）；originY = projH - wy 是 origin Y-up
     * （脚本跟随动画）。没有 projH 时 originY 退回 wy，离线测试保持旧行为。
     *
     * @param {{offX:number,offY:number,viewW:number,viewH:number,projH?:number}} cam
     * @param {number} [parOffX] 相机视差的世界位移。视差把 translate 右乘进了
     *   viewProj（发生在 cam.offX/viewW 计算**之后**），所以屏幕上看到的内容
     *   相对 cam 窗口整体平移了 parOff。要让指针命中「肉眼看到的位置」，
     *   世界坐标必须减掉它，否则视差场景下 hit-test 与画面错开最多 60px。
     * @param {number} [parOffY]
     */
    syncWorld(cam, parOffX = 0, parOffY = 0) {
      if (!cam) return
      state.wx = cam.offX + state.u * cam.viewW - parOffX
      state.wy = cam.offY + state.v * cam.viewH - parOffY
      const projH = Number(cam.projH)
      state.originY = Number.isFinite(projH) ? projH - state.wy : state.wy
      // 首帧 last 与 current 对齐，避免第一帧出现一个巨大的假 delta
      // （lastWx 初值 0 → cursorripple 第一帧会在屏幕上拍出一道横贯的假波纹）
      if (state.lastWx === 0 && state.lastWy === 0) {
        state.lastWx = state.wx
        state.lastWy = state.wy
        state.lastOriginY = state.originY
      }
    },

    /** 归一化空间的帧间位移长度（g_PointerPositionLast 的主要用途） */
    normalizedDelta() {
      const dx = state.u - state.lastU
      const dy = state.v - state.lastV
      return Math.hypot(dx, dy)
    },

    dispose() {
      if (!attached || !target || !target.removeEventListener) return
      attached = false
      target.removeEventListener('mousemove', onMove)
      target.removeEventListener('mousedown', onDown)
      target.removeEventListener('mouseup', onUp)
      target.removeEventListener('blur', onLeaveWindow)
      if (typeof document !== 'undefined' && document.removeEventListener) {
        document.removeEventListener('mouseleave', onLeaveWindow)
      }
    },
  }
}
