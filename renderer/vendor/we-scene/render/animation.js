// WE 场景关键帧动画（scene.json 的 `animation` 字段）
//
// [we-scene patch] 这套东西此前**完全没实现**：`parse.js` 只读字段的 `.value`
// （那份存场景时的静态快照），`animation` 兄弟键被静默丢弃；脚本侧
// `thisObject.getAnimation()` 返回的是 text.js 的 `makeNeutralAnimation()` ——
// 一个纯 no-op 链式对象，`play()` / `stop()` 什么也不做。
// 全库 **126 处动画 / 25 张壁纸 / 743 个关键帧**。
//
// 数据结构（实测，不是猜的）：
//
//   "alpha": {
//     "value": 1,                       ← 静态快照，relative 时作为基准
//     "animation": {
//       "c0": [ {关键帧}, ... ],        ← 每个通道一条独立时间轴
//       "c1": [...], "c2": [...],       ← 1/2/3 通道 = 标量 / vec2 / vec3
//       "relative": true,               ← 可选：结果叠加到基准值上
//       "options": { "fps": 30, "length": 60, "mode": "single", "startpaused": true, "name": "淡入" }
//     }
//   }
//
// 关键帧恒为 6 个字段（743/743，无例外）：
//   { frame, value, front:{enabled,x,y}, back:{enabled,x,y}, lockangle, locklength }
//
// 实测数据决定的取舍：
//
// - **贝塞尔插值不能省。** 743 个关键帧里 303 个（40.8%）带真实切线手柄，
//   126 处动画里 41 处（32.5%）含非线性帧。x 有 84 种取值、y 有 155 种非零值
//   （典型是 1/3 帧间距的手柄）。只做线性会让 3195212886 / 3233141951 的
//   入场缓动、3790527023 的音乐可视化衰减明显不对。
// - **每通道独立时间轴。** 通道键 100% 从 c0 连续编号（可安全假设），但有 4 处
//   各通道的关键帧**数量不同**，所以不能按下标配对，必须各自二分查找。
// - **`relative: true`（34 处，仅 origin/angles/scale）要叠加不能替换。**
//   忽略它会让 3 通道变换整个跳到错误的绝对坐标。基准必须是装配时的冻结快照：
//   每帧把已写回的 layer.origin 再当 base 等于把曲线积分（3233141951 头发会转飞）。
// - **`fps` 是浮点**（1.2 / 0.725 / 2.9 都真实存在），周期长度以 `options.length`
//   为准而非最后一个关键帧的 frame（45 处 maxFrame < length，尾部是留白）。
// - **`lockangle` / `locklength`（恒 true）、`front.magic` / `back.magic`、
//   `previewvalue` 都是编辑器 UI 状态**，求值时一律忽略。
// - 关键帧数据已保证**单调递增、无重复、frame 全整数**（实测 0 处乱序 0 处重复），
//   所以不排序、不去重，直接二分。
//
// `wraploop:true`（官方 Wrap loop frames）：loop 时从末关键帧平滑接到首关键帧，
// 缝只占时间轴尾部 length − last.frame，开头到首关键帧仍钳在首值。
// 全库 10 处，3233141951「火1」的 alpha/origin/scale 都开了；
// 不做的话末帧（847，origin +64px）会钳到 length 再瞬间跳回 0。
//
// `options.parent` / `children`（时间轴联动组，全库 53 处 / 21 组 / 7 壁纸）：
// 按**同作用域字段 key** 引用（对象字段=同层、常量=同 constantshadervalues 映射），
// 与 options.name 无关（撞名实测存在）。leader 独占 startpaused/name/events
//（21 vs 0）——**children 不自播**，播放头从属于 leader（组内 fps/length/mode
// 实测全同，frame 恒等映射；relative/绝对/通道/wraploop 各自独立，3233141951
// 火1 同组内 relative 3 通道 + 绝对 1 通道）。child 的 play/pause/stop/setFrame/
// setRate/rate 赋值全部委托 leader（语料实证作者直接写 `ani.rate = ±x`）。
// 悬空 parent（目标无动画，2 处）容忍退化为独立；无多级/无环（53/53）。
//
// `options.events`（帧事件，24 处全在 3163060610；骨骼动画事件表另 4 张）：
// 官方语义 = 播放头**越过**某帧时触发同层脚本的 `animationEvent(event, value)`
//（event = {name, frame}）。触发按语料魔数反推为半开区间：前进 `prev < f <= cur`、
// 后退 `cur <= f < prev`；setFrame 不触发（脚本 seek 不算"passes"）；换向不补发；
// single 钳到 length 时末帧事件触发（24/24 的 S 事件都钉在 frame==length）；
// 装载时 frame-0 事件**不补发**（假设，语料两种解读都自洽）。

/** 三次贝塞尔的一维分量 */
function bez1(p0, p1, p2, p3, t) {
  const u = 1 - t
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3
}

/**
 * 已知 x 求参数 t（贝塞尔的 x 不等于 t —— 手柄长度不是 1/3 时差得很远）。
 * Newton 迭代为主、二分兜底：x(t) 在手柄合法时单调，但工坊数据里存在
 * 手柄超长导致的非单调段，Newton 会跑飞，所以必须留二分。
 */
function solveT(x0, x1, x2, x3, x) {
  if (x <= x0) return 0
  if (x >= x3) return 1
  let t = x3 - x0 > 1e-9 ? (x - x0) / (x3 - x0) : 0.5
  for (let i = 0; i < 8; i++) {
    const cur = bez1(x0, x1, x2, x3, t) - x
    if (Math.abs(cur) < 1e-6) return t
    // 导数
    const u = 1 - t
    const d = 3 * u * u * (x1 - x0) + 6 * u * t * (x2 - x1) + 3 * t * t * (x3 - x2)
    if (Math.abs(d) < 1e-9) break
    const nt = t - cur / d
    if (nt < 0 || nt > 1 || !Number.isFinite(nt)) break
    t = nt
  }
  let lo = 0
  let hi = 1
  for (let i = 0; i < 40; i++) {
    t = (lo + hi) / 2
    if (bez1(x0, x1, x2, x3, t) < x) lo = t
    else hi = t
  }
  return t
}

/** 在一条通道（关键帧数组）上按帧号求值。
 * wrap = { length } 时（loop + wraploop）：越过末关键帧后、在 length 前，
 * 平滑接到首关键帧的值。官方 Wrap loop frames 补的是时间轴**尾部**接到第一帧，
 * 开头到首关键帧之间仍钳在首值（3233141951 火1 首帧在 191，0–191 保持 0）。 */
export function sampleChannel(keys, frame, wrap) {
  if (!keys || keys.length === 0) return 0
  if (keys.length === 1) return Number(keys[0].value) || 0

  if (wrap && wrap.length > 0) {
    const first = keys[0]
    const last = keys[keys.length - 1]
    const wrapSpan = wrap.length - last.frame
    if (wrapSpan > 1e-9 && frame > last.frame && frame <= wrap.length) {
      return sampleChannel([
        { frame: 0, value: last.value, front: last.front, back: last.back },
        { frame: wrapSpan, value: first.value, front: first.front, back: first.back },
      ], frame - last.frame)
    }
  }

  if (frame <= keys[0].frame) return Number(keys[0].value) || 0
  const last = keys[keys.length - 1]
  if (frame >= last.frame) return Number(last.value) || 0
  // 二分找所在段（数据保证 frame 单调递增）
  let lo = 0
  let hi = keys.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (keys[mid].frame <= frame) lo = mid
    else hi = mid
  }
  const k0 = keys[lo]
  const k1 = keys[hi]
  const f0 = k0.frame
  const f1 = k1.frame
  const v0 = Number(k0.value) || 0
  const v1 = Number(k1.value) || 0
  const span = f1 - f0
  if (span <= 0) return v1
  // 手柄语义（**由全库 630 个段的数值反推，不是照搬某份文档**）：
  // `front` 属于左端点、`back` 属于右端点，控制点为
  //     P1 = ( f0 + front.x * span/3 ,  v0 + front.y )
  //     P2 = ( f1 - |back.x| * span/3 ,  v1 + back.y )
  // 即 **x 是「段长的比例」（再按三次贝塞尔惯例除以 3），y 是「值的绝对增量」**。
  //
  // 三条实测判据：
  //
  // 1. **x 的符号是结构性的**：front.x 全库 463 个全为正、back.x 454 个全为负，
  //    无一例外。这说明两个 x 各自「背离自己的端点」指向段内，是方向而非斜率分母。
  // 2. **x 的取值域紧贴 1**：front.x ∈ [0.511, 1.117]（中位数 1），|back.x| 同形。
  //    若 x 是「帧数」，在 span 从 5 到 600 不等的库里不可能全部落进这么窄的区间；
  //    它只能是**归一化到段长的比例**（1 = 标准的 1/3 手柄）。
  // 3. **y 是绝对增量**：按本式重算全库 630 段，曲线极值相对自身量级的越界为
  //    **0 处**；而早先「切线斜率 = y/x」的读法有 117 段越界，最坏处把
  //    3233141951 的 opacity 从 [0, 0.78] 拉到 20.5（放大 25 倍），alpha 段
  //    甚至跑出负值 −9.88 —— 那会让「淡入」变成整层爆闪后消失。
  //
  // `enabled:false`（约 11% 的侧）表示该侧不做缓动，控制点落在弦上（该侧线性）。
  // 注意 x=1,y=0 **不是**线性而是**水平切线**（标准缓入缓出）：lockangle/locklength
  // 恒 true，编辑器新建关键帧默认就是这种平滑切线，占全库 456/535 段。
  const fr = k0.front
  const bk = k1.back
  const third = span / 3
  const frOn = !!(fr && fr.enabled)
  const bkOn = !!(bk && bk.enabled)
  // 控制点横坐标：比例 × span/3，夹在段内避免个别 |x|>1 的数据把 x(t) 弄成非单调
  const fx = frOn ? Math.abs(Number(fr.x) || 0) : 1
  const bx = bkOn ? Math.abs(Number(bk.x) || 0) : 1
  const x1 = f0 + Math.min(fx, 1.5) * third
  const x2 = f1 - Math.min(bx, 1.5) * third
  // 控制点纵坐标：y 是相对各自端点的**绝对增量**
  const y1 = frOn ? v0 + (Number(fr.y) || 0) : v0 + (v1 - v0) / 3
  const y2 = bkOn ? v1 + (Number(bk.y) || 0) : v1 - (v1 - v0) / 3
  const t = solveT(f0, x1, x2, f1, frame)
  return bez1(v0, y1, y2, v1, t)
}

/** 把播放头帧号按 mode 折进 [0, length] */
export function wrapFrame(frame, length, mode) {
  const len = length > 0 ? length : 1
  if (mode === 'loop') {
    let f = frame % len
    if (f < 0) f += len
    return f
  }
  if (mode === 'mirror') {
    const period = len * 2
    let f = frame % period
    if (f < 0) f += period
    return f <= len ? f : period - f
  }
  // single：播完停在末帧
  return Math.max(0, Math.min(len, frame))
}

/** relative 的基准：数组、标量，或 scene.json 的 `"x y z"` 字符串。 */
function coerceBase(base) {
  if (Array.isArray(base)) return base
  if (typeof base === 'string') return base.trim().split(/\s+/).map(Number)
  if (Number.isFinite(base)) return [base]
  return []
}

/**
 * [we-scene patch] 帧事件跨帧检测（只在 advance 里调；setFrame 不触发）。
 * 半开区间：前进 prev < f <= cur、后退 cur <= f < prev（不含出发帧、含到达帧）。
 * loop 按原始帧逐周期展开（第 k 周期事件 f 落在 k*len + f）；mirror 每周期两次
 *（端点一次）。同刻多事件保 events 数组序（稳定排序）。语料 loop/mirror+events
 * 为 0，这两种展开按模型实现并在头注释标注。
 *
 * 独立导出：时间轴控制器（collectCrossedEvents）与骨骼动画事件（scene-mount 的
 * puppet 播放头跨帧）共用同一份数学 —— 两份实现必然发散。
 */
export function crossedEvents(events, prev, cur, length, mode) {
  if (!events || !events.length || prev === cur) return []
  const forward = cur > prev
  const len = length > 0 ? length : 1
  const hits = []
  if (mode === 'single') {
    for (const e of events) {
      if (forward ? (e.frame > prev && e.frame <= cur) : (e.frame >= cur && e.frame < prev)) hits.push({ at: e.frame, e })
    }
  } else if (mode === 'loop') {
    const kMin = Math.floor(Math.min(prev, cur) / len)
    const kMax = Math.floor(Math.max(prev, cur) / len)
    for (let k = kMin; k <= kMax; k++) {
      for (const e of events) {
        const at = k * len + e.frame
        if (forward ? (at > prev && at <= cur) : (at >= cur && at < prev)) hits.push({ at, e })
      }
    }
  } else {
    // mirror：周期 2*len，升段 at1、降段 at2（f==0/len 时两点重合只算一次）
    const period = len * 2
    const kMin = Math.floor(Math.min(prev, cur) / period)
    const kMax = Math.floor(Math.max(prev, cur) / period)
    for (let k = kMin; k <= kMax; k++) {
      for (const e of events) {
        const at1 = k * period + e.frame
        const at2 = k * period + 2 * len - e.frame
        for (const at of at1 === at2 ? [at1] : [at1, at2]) {
          if (forward ? (at > prev && at <= cur) : (at >= cur && at < prev)) hits.push({ at, e })
        }
      }
    }
  }
  hits.sort((a, b) => (forward ? a.at - b.at : b.at - a.at))
  return hits.map((h) => h.e)
}

/** 控制器的跨帧检测入口：把越过的事件推入实例队列（advance 内调用）。 */
function collectCrossedEvents(anim, prev, cur) {
  const crossed = crossedEvents(anim._events, prev, cur, anim.frameCount || 1, anim.mode)
  for (const e of crossed) anim._eventQueue.push(e)
}

/**
 * [we-scene patch] 时间轴联动组接线：按同作用域字段 key 把 child 挂到 leader 上
 *（child.parent = leader）。siblings 为 Map<key, ctrl> 或 {key: ctrl}。
 * 悬空 parent（目标无动画/自指）与多级 parent 不链接，经 onDiag 记一条。
 */
export function linkAnimations(siblings, onDiag) {
  const map = siblings instanceof Map ? siblings : new Map(Object.entries(siblings || {}))
  for (const [key, ctrl] of map) {
    if (!ctrl || !ctrl.parentKey) continue
    const leader = map.get(ctrl.parentKey)
    if (!leader || leader === ctrl) {
      if (onDiag) onDiag(`动画联动 parent 悬空（退化为独立）：${key} -> ${ctrl.parentKey}`)
      continue
    }
    if (leader.parentKey) {
      if (onDiag) onDiag(`动画联动多级 parent（不支持，退化为独立）：${key} -> ${ctrl.parentKey}`)
      continue
    }
    ctrl.parent = leader
  }
  return map
}

/**
 * 创建一条动画的播放控制器。
 * @param def scene.json 的 `animation` 对象（含 c0..cN / options / relative）
 */
export function createAnimation(def) {
  const opts = (def && def.options) || {}
  const fps = Number(opts.fps) > 0 ? Number(opts.fps) : 30
  const length = Number(opts.length) > 0 ? Number(opts.length) : 0
  const mode = opts.mode === 'loop' || opts.mode === 'mirror' ? opts.mode : 'single'
  const name = typeof opts.name === 'string' ? opts.name : ''
  const relative = !!(def && def.relative)
  // 官方 Wrap loop frames：只对 loop 有意义（mirror 本身来回，single 不环绕）
  const wraploop = opts.wraploop === true && mode === 'loop'
  // 通道：c0..cN 连续编号（实测 100% 连续，无例外）
  const channels = []
  for (let i = 0; ; i++) {
    const c = def && def['c' + i]
    if (!Array.isArray(c)) break
    channels.push(c)
  }
  // startpaused:true（39 处）初始不播，等脚本 play()；缺省自动播放
  const autoPlay = opts.startpaused !== true
  const endedCallbacks = []
  // [we-scene patch] 联动组引用（按同作用域字段 key，linkAnimations 接线）与
  // 帧事件表（保数组序；同帧多事件的预期派发顺序即数组序，语料 7 组全在 frame 0）
  const parentKey = opts.parent && typeof opts.parent.key === 'string' ? opts.parent.key : null
  const childKeys = Array.isArray(opts.children)
    ? opts.children.map((c) => (c && typeof c.key === 'string' ? c.key : null)).filter(Boolean)
    : []
  const events = Array.isArray(opts.events)
    ? opts.events
        .filter((e) => e && Number.isFinite(Number(e.frame)) && typeof e.name === 'string')
        .map((e) => ({ frame: Number(e.frame), name: e.name }))
    : []

  const anim = {
    name,
    mode,
    fps,
    relative,
    channelCount: channels.length,
    parentKey,
    childKeys,
    /** linkAnimations 填写（child → leader）；leader/未链接恒 null */
    parent: null,
    frame: 0,
    _playing: autoPlay,
    _rate: 1,
    _ended: false,
    _events: events,
    _eventQueue: [],
    get frameCount() { return length },
    // [we-scene patch] playing/rate/ended 是访问器：linked child 全部镜像/委托
    // leader —— 语料里作者直接读写 `ani.rate`（不是 setRate），纯数据字段拦不住。
    get playing() { return anim.parent ? anim.parent.playing : anim._playing },
    set playing(v) { if (anim.parent) anim.parent.playing = !!v; else anim._playing = !!v },
    get rate() { return anim.parent ? anim.parent.rate : anim._rate },
    set rate(n) {
      const v = Number(n)
      if (!Number.isFinite(v)) return
      if (anim.parent) anim.parent.rate = v
      else anim._rate = v
    },
    get ended() { return anim.parent ? anim.parent.ended : anim._ended },
    set ended(v) { if (anim.parent) anim.parent.ended = !!v; else anim._ended = !!v },
    play() {
      if (anim.parent) return anim.parent.play()
      anim._playing = true
      anim._ended = false
      return anim
    },
    pause() {
      if (anim.parent) return anim.parent.pause()
      anim._playing = false
      return anim
    },
    stop() {
      if (anim.parent) return anim.parent.stop()
      anim._playing = false
      anim.frame = 0
      anim._ended = false
      return anim
    },
    setFrame(f) {
      if (anim.parent) return anim.parent.setFrame(f)
      const n = Number(f)
      if (Number.isFinite(n)) anim.frame = n
      return anim
    },
    getFrame() { return anim.parent ? anim.parent.getFrame() : anim.frame },
    setRate(r) {
      if (anim.parent) return anim.parent.setRate(r)
      anim.rate = r
      return anim
    },
    addEndedCallback(fn) {
      if (anim.parent) return anim.parent.addEndedCallback(fn)
      if (typeof fn === 'function') endedCallbacks.push(fn)
      return anim
    },
    // [we-scene patch] 与中性面对齐：官方 IAnimation 有 isPlaying()，真控制器
    // 此前只有 .playing 属性，脚本对真控制器调 isPlaying() 会 TypeError（潜伏不对称）。
    isPlaying() { return anim.playing },
    setBlend() { return anim },
    setVisible() { return anim },
    /** 推进播放头。dt 单位秒。linked child 的播放头由 leader 拥有，自己不推进。 */
    advance(dt) {
      if (anim.parent) return
      if (!anim._playing) return
      const prev = anim.frame
      anim.frame += (Number(dt) || 0) * fps * anim._rate
      if (mode === 'single') {
        if (anim.frame >= length) {
          anim.frame = length
          anim._playing = false
          if (!anim._ended) {
            anim._ended = true
            for (const cb of endedCallbacks) { try { cb() } catch (e) { /* 回调抛错不该拖垮渲染 */ } }
          }
        } else if (anim.frame < 0) {
          // 负 rate 倒放到头
          anim.frame = 0
          anim._playing = false
        }
      }
      collectCrossedEvents(anim, prev, anim.frame)
    },
    /** 取出并清空本帧越过的事件（宿主统一做图层级广播；setFrame 不产生事件） */
    takeEvents() {
      if (!anim._eventQueue.length) return []
      const out = anim._eventQueue.slice()
      anim._eventQueue.length = 0
      return out
    },
    /**
     * 当前值。返回标量（1 通道）或数组（2/3 通道）。
     * relative 时调用方需自行叠加基准值 —— 见 applyTo。
     * linked child 用 **leader 的播放头**采自己的通道（relative/基准/wraploop
     * 各自独立 —— 3233141951 火1 同组内 relative 3ch + 绝对 1ch）。
     */
    value() {
      const f = wrapFrame(anim.parent ? anim.parent.frame : anim.frame, length, mode)
      const wrap = wraploop ? { length } : undefined
      if (channels.length === 1) return sampleChannel(channels[0], f, wrap)
      const out = []
      for (const c of channels) out.push(sampleChannel(c, f, wrap))
      return out
    },
    /**
     * 叠加到基准值：relative 为真时是「基准 + 动画值」，否则直接取动画值。
     * base 为标量、数组，或 scene.json 的 `"x y z"` 字符串。
     * 调用方必须传**冻结的初始快照**，不能传已经写回的 layer.origin。
     */
    applyTo(base) {
      const v = anim.value()
      if (!relative) return v
      const b = coerceBase(base)
      if (Array.isArray(v)) return v.map((x, i) => x + (Number(b[i]) || 0))
      return v + (Number(b[0]) || 0)
    },
  }
  return anim
}

/** 中性控制器：字段上没有 animation 时给脚本用，保证 `.play()` 不炸 */
export function createNeutralAnimation() {
  const a = {
    name: '', mode: 'single', fps: 30, relative: false, channelCount: 0,
    parentKey: null, childKeys: [], parent: null,
    frame: 0, rate: 1, playing: false, ended: false,
    get frameCount() { return 0 },
    play() { return a }, pause() { return a }, stop() { return a },
    setFrame() { return a }, getFrame() { return 0 }, setRate() { return a },
    addEndedCallback() { return a }, isPlaying() { return false },
    setBlend() { return a }, setVisible() { return a },
    advance() {}, takeEvents() { return [] }, value() { return 0 }, applyTo(base) { return base },
  }
  return a
}
