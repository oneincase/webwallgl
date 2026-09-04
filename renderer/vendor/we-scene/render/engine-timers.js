// [we-scene patch] engine.setTimeout / setInterval 的统一真定时器（SCENESCRIPT-PLAN P1-1）。
//
// WE 语义（官方 IEngine）：
//   - setTimeout(callback, delay?) / setInterval(callback, delay?) 返回**取消句柄**，
//     不是数字 id。语料两种用法都有——`lastHideEvent = engine.setTimeout(...)`
//     之后直接 `lastHideEvent()` 调用取消（3790189808 延时隐藏封面），混淆脚本又把
//     句柄当数字做算术。所以句柄 = 可调用函数 + valueOf 回数字，两种写法都不炸。
//   - 官方明确「runtime 会回卷，计时用 setTimeout」，定时器是壁纸的一等能力。
//     no-op stub 会让延时显隐/回弹/轮换**静默失效**：全库 2503 段脚本里 76 处 / 26 张
//     调用，此前只有 scene-mount 的对象字段 eval 点注入过真定时器，效果开关(37 处) /
//     效果常量(8 处) / general(1 处) 共 46 处 / 17 张拿 no-op，对应延时逻辑从不触发。
//
// 设计约束（ARCHITECTURE §三）：引擎模块 Node 可载、零 DOM。本模块**不直接调用**
// 宿主 DOM 定时器，只包装宿主注入的实现；未注入时退化为可取消的 no-op
// （与沙箱旧默认 defaultEngineTimer 一致，离线校验路径确定性不变）。
// 沙箱侧 evalTextScript / evalObjectScript 继续吃 opts.setTimeout 等四个字段，
// 本模块只负责造出**全挂点共享的那一份**（scene-mount 五个 eval 点统一 ...timerOpts）。
//
// 用法（宿主；host* 为宿主注入的浏览器定时器实现，本模块不直接引用 DOM 全局）：
//   const timers = createEngineTimers({
//     setTimeout: hostSetTimeout,
//     clearTimeout: hostClearTimeout,
//     setInterval: hostSetInterval,
//     clearInterval: hostClearInterval,
//   }, { onError: (e, kind) => diag(...) });
//   // 场景卸载时 timers.dispose()：撤销未触发的回调，防延迟写穿死层。

export function createEngineTimers(host = {}, opts = {}) {
  const setT = typeof host.setTimeout === 'function' ? host.setTimeout : null
  const clearT = typeof host.clearTimeout === 'function' ? host.clearTimeout : null
  const setI = typeof host.setInterval === 'function' ? host.setInterval : null
  const clearI = typeof host.clearInterval === 'function' ? host.clearInterval : null
  const onError = typeof opts.onError === 'function' ? opts.onError : null
  const pending = new Set()

  // 浏览器同款归一：缺省/负数/NaN 延迟都立即触发（宿主 DOM 定时器把它们当 0）
  const normDelay = (ms) => {
    const n = Number(ms)
    return Number.isFinite(n) && n > 0 ? n : 0
  }

  // 脚本回调抛错不许打断宿主帧循环或定时器队列：宿主 DOM 定时器对回调天然
  // 隔离，帧驱动/fake 实现也必须同语义——吞掉、上报（onError）、interval 继续走。
  const guarded = (fn) => () => {
    try {
      fn()
    } catch (e) {
      if (onError) onError(e, 'timer')
    }
  }

  // state.handle 在挂宿主时才回填（可能同步触发，也可能为 null），取消闭包必须
  // 经 state 读取，不能按值捕获。
  const makeCancel = (state, clearFn) => {
    const cancel = () => {
      if (state.fired) return
      state.fired = true
      pending.delete(cancel)
      if (clearFn && state.handle != null) clearFn(state.handle)
    }
    // 语料可读 .handle（旧 scene-mount 内联包装的同款形状）
    cancel.handle = null
    cancel.valueOf = () => (typeof state.handle === 'number' ? state.handle : 0)
    return cancel
  }

  function setTimeout(fn, ms) {
    if (typeof fn !== 'function') {
      // 语料没这种调用；给已消费的句柄即可，不进 pending（不算活跃定时器）
      const dead = makeCancel({ fired: true, handle: null }, null)
      return dead
    }
    const state = { fired: false, handle: null }
    const cancel = makeCancel(state, clearT)
    pending.add(cancel)
    state.handle = setT
      ? setT(
          guarded(() => {
            state.fired = true
            pending.delete(cancel)
            fn()
          }),
          normDelay(ms),
        )
      : null
    cancel.handle = state.handle
    return cancel
  }

  function setInterval(fn, ms) {
    if (typeof fn !== 'function') return makeCancel({ fired: true, handle: null }, null)
    // fired 只表示「被取消」：interval 每次触发不清它
    const state = { fired: false, handle: null }
    const cancel = makeCancel(state, clearI)
    pending.add(cancel)
    state.handle = setI ? setI(guarded(fn), normDelay(ms)) : null
    cancel.handle = state.handle
    return cancel
  }

  // 语料 engine.clearTimeout(句柄)：句柄就是我们的取消函数，调用即撤销；
  // 传进来的若是裸数字/宿主 handle，透传给宿主 clear 兜底。
  function clearTimeout(h) {
    if (typeof h === 'function') {
      h()
      return
    }
    if (clearT && h != null) clearT(h)
  }

  function clearInterval(h) {
    if (typeof h === 'function') {
      h()
      return
    }
    if (clearI && h != null) clearI(h)
  }

  /** 场景卸载：撤销全部未触发回调。已触发/已取消的不受影响。 */
  function dispose() {
    for (const cancel of [...pending]) cancel()
    pending.clear()
  }

  return {
    setTimeout,
    setInterval,
    clearTimeout,
    clearInterval,
    dispose,
    /** 测试与诊断用：尚未触发且未取消的定时器数 */
    pendingCount: () => pending.size,
  }
}
