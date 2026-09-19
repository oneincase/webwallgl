// [we-scene patch] cursor 事件派发的纯状态机（宿主 renderer/src/scene-mount.ts 消费）。
//
// 为什么单独成模块：这是「点了没反应」最容易出错的一环，而它的正确性**在画面上
// 完全看不出来**（壁纸照常显示、脚本也不报错）。做成纯函数后 verify-pointer 能直接
// 跑**真实现**，而不是在测试里再抄一遍派发顺序 —— 抄出来的第三份实现会跟着实现一起
// 写错，往返照样自洽（CASEBOOK「外观切换链上的三个静默断点」断点 3 就是这么漏的）。
//
// ---- 语义（对齐两个参考实现）----
//   - open-wallpaper-engine `Script.cpp` 的 `TickAll()`：遍历**每个** field script，
//     各自 `HitTestNode(node, cursor)`，命中的都收事件；
//   - Mirage `ScriptRuntime.cpp`：遍历每个 script 的节点，`ResolveCursorNode` +
//     `ancestors_visible` 各自判定，`over_node` 的全部派发。
//   两者都没有「上层把下层挡住」这回事 —— 同一帧可以有**多个**图层同时命中。
//   3801397319 的右上角就是两个同位同尺寸的交互区（切换人物形态 + 作者水印），
//   只派发给最上层那一个时人物的 cursorClick 永远收不到点击。
//
// ---- 逐事件规则 ----
//   enter/leave：命中集变化时**逐层**成对派发；
//   move：每帧发给全部命中层（拖拽脚本需要连续位置）；
//   down：按下那一帧的「按下集」= 当帧命中集；
//   up：发给按下集里的**每一层**（拖到层外松手也要收尾 —— Mirage 的 captured
//       buttons 同语义），不是只发给当帧命中的层；
//   click：只发给「按下时命中、松开时仍命中」的层（否则从层内按下、拖到层外松手
//       会误触发一次点击）。
//
// 纯函数、零依赖：入参出参都是图层数组，宿主负责真正调用脚本回调。

/**
 * @param {{hovered?: any[], pressed?: any[], lastLeftDown?: boolean}} prev 上一帧的派发状态
 * @param {any[]} hits 当帧命中集（hitTestLayersAll 的结果，z 序自上而下）
 * @param {boolean} leftDown 当帧左键是否按下
 * @returns {{leave:any[],enter:any[],move:any[],down:any[],up:any[],click:any[],
 *            next:{hovered:any[],pressed:any[],lastLeftDown:boolean}}}
 *   各事件应派发的图层列表（顺序即建议的派发顺序）+ 下一帧的状态
 */
export function planCursorDispatch(prev, hits, leftDown) {
  const hovered = (prev && prev.hovered) || []
  const pressedPrev = (prev && prev.pressed) || []
  const lastLeftDown = !!(prev && prev.lastLeftDown)
  const list = Array.isArray(hits) ? hits : []
  const hitSet = new Set(list)
  const leave = []
  const enter = []
  const move = []
  const down = []
  const up = []
  const click = []
  for (const l of hovered) if (!hitSet.has(l)) leave.push(l)
  for (const l of list) if (!hovered.includes(l)) enter.push(l)
  for (const l of list) move.push(l)
  let pressed = pressedPrev
  if (leftDown && !lastLeftDown) {
    pressed = list.slice()
    for (const l of list) down.push(l)
  } else if (!leftDown && lastLeftDown) {
    for (const l of pressedPrev) up.push(l)
    for (const l of pressedPrev) if (hitSet.has(l)) click.push(l)
    pressed = []
  }
  return {
    leave,
    enter,
    move,
    down,
    up,
    click,
    next: { hovered: list, pressed, lastLeftDown: leftDown },
  }
}
