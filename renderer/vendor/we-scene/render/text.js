// [we-scene patch] WE 文字对象（时钟 / 日期 / 歌曲标题等挂件）渲染
//
// WE 的「组件」在 scene.json 里几乎都以文字对象实现：本机 84 个场景 0 个 component
// 对象、563 个文字对象（335 个带脚本）。动态文本 = 文字层 + text.script（ES module）：
//
//   'use strict';
//   export var scriptProperties = createScriptProperties()
//       .addCheckbox({ name: 'use24hFormat', value: true })
//       .addText({ name: 'delimiter', value: ':' })
//       .finish();
//   export function update(value) {
//       return hours + scriptProperties.delimiter + minutes;
//   }
//
// 全库 335 个脚本用到的宿主符号（逆向统计）：
//   scriptProperties.<name>     脚本属性（scene.json text.scriptproperties 的值，
//                               缺省回落到 createScriptProperties 声明的默认值）
//   update(value) → string      每帧求值；value = 当前文本；返回 undefined 则保留原文本
//   engine.registerAsset()      资源引用登记（50 处，全部无返回值依赖，垫成 no-op）
//   engine.frametime / runtime  帧时长 / 运行秒数（宿主每帧回填）
//   engine.canvasSize           画布尺寸
//   engine.userProperties       project.json general.properties 的当前值
//   engine.registerAudioBuffers(n)  音频频谱 {left,right,average}[n]（31 个壁纸的
//                               节拍文本；宿主每帧重填，无音频时全 0）
//   thisLayer.text/pointsize/   读写本层属性（mediaPropertiesChanged 歌曲标题脚本会
//   font/angles/origin/scale      改 pointsize/text，排版每帧须重读）
//   thisScene.getLayer(name)    跨层读其它文字层的当前文本（World Time 读时差层）
//   init()                      挂载时调用一次
//   applyUserProperties(props)  用户属性变更（挂载时以全量属性调用一次）
//   mediaPropertiesChanged(evt) 媒体播放事件 —— 宿主无媒体源，不调用（歌曲标题
//                               类脚本退化为静态快照文本，属已知上限）
//
// 排版语义（563 个文字层实测）：文字画在 layer.size 尺寸的盒子内；
//   padding 内缩（装不下则当 0）；spacing 为字距/行距附加量；
//   horizontalalign/verticalalign 相对**图层 origin** 贴齐（left = 文字左缘在
//   origin.x，不是 CSS 式贴盒左缘；开发者确认过），层 quad 以 origin 为中心故
//   实现上对准盒子中线；
//   limitwidth + maxwidth 限宽换行，limitrows + maxrows 限行截断，limituseellipsis 加省略号；
//   opaquebackground + backgroundcolor(+brightness) 盒底色；castshadow 投影。
//   本机数据里 anchor 取值 none 237 / 缺省 301 / center 20，none 与缺省按 center 处理。

const ADD_METHOD_RE = /^add[A-Z]/

// 沙箱内的 console：no-op。真实语料中存在反调试脚本覆写宿主 console.log，
// 沙箱必须拿到自己的静音副本，而不是共享宿主的可变全局。
function makeSandboxConsole() {
  return { log: () => {}, warn: () => {}, error: () => {}, info: () => {}, debug: () => {} }
}

/**
 * 混淆脚本会 `engine[_0x()](...)` 调未实现的 IEngine 方法。属性缺失或值为 null
 * （旧 stub 把 setInterval 写成 null）时调用会 TypeError「is not a function」，
 * 2887099508 的 ldfk.visible 就是这样熔断。未知名字给可调用空函数，与 getLayer
 * 找不到仍回哑代理同一策略：脚本跑完，只是那次调用没效果。
 */
function wrapEngine(engine) {
  return new Proxy(engine, {
    get(t, name, recv) {
      const v = Reflect.get(t, name, recv)
      if (v == null && typeof name === 'string' && name !== 'then') {
        const stub = () => undefined
        t[name] = stub
        return stub
      }
      return v
    },
  })
}

/** 宿主定时器缺省：返回可调用的取消函数（WE 的 setTimeout 不是数字 handle）。 */
function defaultEngineTimer(fn, ms) {
  void fn
  void ms
  const cancel = () => {}
  return cancel
}

/**
 * 把外部系统 provider 接到 engine 上。媒体控制 / 窗口标题 / 屏保 / 快捷方式
 * 都是可替换接口，未注入时给可调用空实现，避免 `is not a function`。
 */
function applyEngineHost(engine, opts) {
  engine.isScreensaver = !!opts.isScreensaver
  if (typeof opts.isRunningInEditor === 'boolean') engine.isRunningInEditor = opts.isRunningInEditor
  if (!engine.setInterval) engine.setInterval = opts.setInterval || defaultEngineTimer
  if (!engine.setTimeout) engine.setTimeout = opts.setTimeout || defaultEngineTimer
  if (!engine.clearTimeout) engine.clearTimeout = opts.clearTimeout || (() => {})
  if (!engine.clearInterval) engine.clearInterval = opts.clearInterval || (() => {})
  if (typeof opts.openUserShortcut === 'function') engine.openUserShortcut = opts.openUserShortcut

  const mediaCtl = opts.mediaControl || null
  engine.media = {
    skipNext: () => { if (mediaCtl && mediaCtl.skipNext) return mediaCtl.skipNext() },
    skipPrevious: () => { if (mediaCtl && mediaCtl.skipPrevious) return mediaCtl.skipPrevious() },
    play: () => { if (mediaCtl && mediaCtl.play) return mediaCtl.play() },
    pause: () => { if (mediaCtl && mediaCtl.pause) return mediaCtl.pause() },
    playPause: () => { if (mediaCtl && mediaCtl.playPause) return mediaCtl.playPause() },
    get snapshot() { return mediaCtl && mediaCtl.snapshot ? mediaCtl.snapshot : null },
  }

  const win = opts.windowTitle
  Object.defineProperty(engine, 'windowTitle', {
    configurable: true,
    enumerable: true,
    get() { return win && win.title ? String(win.title) : '' },
  })
  Object.defineProperty(engine, 'windowApp', {
    configurable: true,
    enumerable: true,
    get() { return win && win.app ? String(win.app) : '' },
  })
}

// WE 脚本 Vec3 类（官方 3D 时钟阴影脚本等使用）。构造器接受 (x,y,z) / (对象, z) /
// (数字)，对象按 x||width、y||height 取值（engine.canvasSize 会被直接传入做除法）。
class Vec3 {
  constructor(x, y, z) {
    if (x !== null && typeof x === 'object') {
      this.x = x.x !== undefined ? x.x : x.width || 0
      this.y = y !== undefined ? y : x.y !== undefined ? x.y : x.height || 0
      this.z = z !== undefined ? z : x.z || 0
    } else if (y === undefined && z === undefined) {
      // 单标量广播：`new Vec3(0.2)` → (0.2, 0.2, 0.2)。
      // 3790527023 按钮缩放模板写 `currentScale = new Vec3(ORIGINAL_SCALE)`，
      // 不广播会变成 (0.2, 0, 0)，按钮扁成一条线。
      const n = Number(x) || 0
      this.x = n
      this.y = n
      this.z = n
    } else {
      this.x = Number(x) || 0
      this.y = Number(y) || 0
      this.z = Number(z) || 0
    }
  }
  add(v) { const o = new Vec3(v); return new Vec3(this.x + o.x, this.y + o.y, this.z + o.z) }
  subtract(v) { const o = new Vec3(v); return new Vec3(this.x - o.x, this.y - o.y, this.z - o.z) }
  multiply(v) {
    if (v && typeof v === 'object') return new Vec3(this.x * v.x, this.y * v.y, this.z * v.z)
    return new Vec3(this.x * v, this.y * v, this.z * v)
  }
  divide(v) {
    const safe = (a, b) => (b === 0 ? 0 : a / b)
    if (v && typeof v === 'object') return new Vec3(safe(this.x, v.x), safe(this.y, v.y), safe(this.z, v.z))
    return new Vec3(safe(this.x, v), safe(this.y, v), safe(this.z, v))
  }
  copy() { return new Vec3(this.x, this.y, this.z) }
  // 3790527023 按钮：`currentScale = currentScale.mix(targetScale, frametime)`。
  // t 不夹取：模板传的是 `frametime * SPEED`，经常 > 1。
  mix(v, t) {
    const o = new Vec3(v)
    const k = Number(t)
    const a = Number.isFinite(k) ? k : 0
    return new Vec3(
      this.x + (o.x - this.x) * a,
      this.y + (o.y - this.y) * a,
      this.z + (o.z - this.z) * a,
    )
  }
  length() { return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z) }
  normalize() {
    const l = this.length()
    return l === 0 ? new Vec3(0, 0, 0) : new Vec3(this.x / l, this.y / l, this.z / l)
  }
  dot(v) { const o = new Vec3(v); return this.x * o.x + this.y * o.y + this.z * o.z }
  toString() { return this.x + ' ' + this.y + ' ' + this.z }
}

// WE 另有 Vec2。构造 (x, y) 时 Vec3 的 z 落成 0，算术与 Vec3 同构。
// 全库 17 处 / 13 张：3791967416 聚光灯 `new Vec2(cursor/screenRes)`，
// 音频条模板 `bar.parallaxDepth = new Vec2(0,0)`。不注入是 ReferenceError 熔断。
const Vec2 = Vec3

/**
 * 把 `{x,y,z}` 字面量升到 Vec3 原型，保持**同一对象身份**。
 * WE 的 init/update 两种写法都要活：`initScale = value; initScale.multiply(k)`
 * （3791163858 悬停缩放）和 `value.y = audio; return value`（原地改写）。
 * 每次 new Vec3 拷一份会让「不 return、只改入参」的脚本写回空气。
 */
function asScriptVec3(value) {
  if (value instanceof Vec3) return value
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  if (!('x' in value) && !('y' in value) && !('z' in value)) return value
  if (Object.getPrototypeOf(value) === Vec3.prototype) return value
  try { Object.setPrototypeOf(value, Vec3.prototype) } catch { /* 冻结对象忽略 */ }
  return value
}

/**
 * WE 脚本 input 全局（指针状态）。
 *
 * [we-scene patch] 成员集按全库 18 个用到 input 的脚本**实测供需**校准过一轮，
 * 改动前是「供了没人用的、缺了有人用的」：
 *
 *   - `cursorWorldPosition`（25 处引用 / 12 壁纸）：**图层 origin 空间像素**。
 *     X 与渲染世界同号；Y 是 WE origin 的 Y-up（`projH - wy`），因为
 *     3292361861 直接 `value.y = input.cursorWorldPosition.y` 赋给 origin。
 *     喂渲染世界的 Y-down 会让鼠标跟随上下反着走。
 *     3786330502 拿它与图层 origin 算像素距离；2983846453 主动
 *     `.divide(engine.canvasSize)` 才得归一化 —— 反证是像素。
 *   - `cursorScreenPosition`（6 处 / 2 壁纸）：**屏幕像素**，原点在角。
 *     3791967416 除 engine.screenResolution 才得 [0,1]；3509243656 手动减半屏
 *     才得 [-1,1]。注意这与 cursorWorldPosition 是**两个不同空间**。
 *   - `cursorLeftDown`（2 处 / 1 壁纸）：布尔。改动前**完全缺失**，
 *     3791967416 的 `hovered && input.cursorLeftDown` 点击缩放永远不触发。
 *   - `cursorPosition` / `cursorPositionLast`：全库 **0 处**使用。改动前提供了
 *     它们却没提供 cursorLeftDown，属供需错配。仍保留（WE API 里存在，
 *     且成本为零），按归一化 [0,1] 语义填。
 *
 * 传入 pointerView 时**原地复用同一批 Vec3 实例**：Vec3 可变，宿主每帧写 x/y/z
 * 即可，无需重新绑定沙箱（与 audioViews 同一套路）。不传则退化为全 0，
 * 离线校验与无指针宿主下行为不变。
 */
function makeInput(pointerView) {
  if (pointerView && pointerView.cursorWorldPosition) return pointerView
  return {
    cursorWorldPosition: new Vec3(0, 0, 0),
    cursorScreenPosition: new Vec3(0, 0, 0),
    cursorPosition: new Vec3(0, 0, 0),
    cursorPositionLast: new Vec3(0, 0, 0),
    cursorLeftDown: false,
  }
}

/**
 * [we-scene patch] 创建可原地更新的 input 视图（宿主每帧调 update 重填）。
 * 与 audioViews 一样：一份实例、多脚本共享、就地重填，脚本闭包捕获的引用始终有效。
 */
/**
 * [we-scene patch] 构造 cursor* 回调的 event.worldPosition。
 *
 * **必须是 Vec3 而不是普通对象字面量。** 脚本会把它存下来再做向量运算：
 * 2998757800 的 cursorDown 写 `dragStart = event.worldPosition`，
 * update 里接着 `dragStart.add(...)` —— 传对象字面量会 TypeError
 * 「dragStart.add is not a function」，三振熔断后整个拖拽失效
 * （实测就是这个错让该壁纸一直不产生骨骼覆写）。
 *
 * 全库 51 处引用 event.worldPosition，无一处读 button/screenPosition/delta，
 * 所以事件对象只需这一个字段。
 */
export function makeCursorEventVec(x, y, z) {
  return new Vec3(x || 0, y || 0, z || 0)
}

export function createInputView() {
  const view = {
    cursorWorldPosition: new Vec3(0, 0, 0),
    cursorScreenPosition: new Vec3(0, 0, 0),
    cursorPosition: new Vec3(0, 0, 0),
    cursorPositionLast: new Vec3(0, 0, 0),
    cursorLeftDown: false,
  }
  /** @param {{wx:number,wy:number,originY?:number|null,screenX:number,screenY:number,u:number,v:number,lastU:number,lastV:number,leftDown:boolean}} p */
  view.update = function (p) {
    if (!p) return view
    view.cursorWorldPosition.x = p.wx
    // origin Y-up：有 originY 就用（syncWorld 用 projH - wy 算的），否则退回 wy
    view.cursorWorldPosition.y = p.originY != null ? p.originY : p.wy
    view.cursorWorldPosition.z = 0
    view.cursorScreenPosition.x = p.screenX
    view.cursorScreenPosition.y = p.screenY
    view.cursorScreenPosition.z = 0
    view.cursorPosition.x = p.u
    view.cursorPosition.y = p.v
    view.cursorPosition.z = 0
    view.cursorPositionLast.x = p.lastU
    view.cursorPositionLast.y = p.lastV
    view.cursorPositionLast.z = 0
    view.cursorLeftDown = !!p.leftDown
    return view
  }
  return view
}

// WE 内置脚本库 WEMath（`import * as WEMath from 'WEMath'`，import 行被剥掉后由
// 沙箱以同名全局提供）。全库 335 个脚本实际只用到 mix，其余按 WE 语义补常见项。
const WEMATH = {
  mix: (a, b, t) => a + (b - a) * t,
  lerp: (a, b, t) => a + (b - a) * t,
  clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)),
  saturate: (v) => Math.min(1, Math.max(0, v)),
  smoothstep: (a, b, x) => {
    const t = Math.min(1, Math.max(0, (x - a) / ((b - a) || 1)))
    return t * t * (3 - 2 * t)
  },
  // [we-scene patch] WE 的实际拼写是 **smoothStep**（大写 S），全库调用 10 次。
  // 只提供小写别名等于没提供：`WEMath.smoothStep(...)` 是 undefined，
  // 一调用就 TypeError 熔断，整个脚本（连同它驱动的颜色/位移）静默失效。
  smoothStep: (a, b, x) => {
    const t = Math.min(1, Math.max(0, (x - a) / ((b - a) || 1)))
    return t * t * (3 - 2 * t)
  },
  random: (lo, hi) => (lo === undefined ? Math.random() : lo + Math.random() * ((hi === undefined ? 1 : hi) - lo)),
  randomInt: (lo, hi) => Math.floor((lo || 0) + Math.random() * ((hi === undefined ? 1 : hi) + 1 - (lo || 0))),
  degrees: (rad) => (rad * 180) / Math.PI,
  radians: (deg) => (deg * Math.PI) / 180,
}

// [we-scene patch] WE 内置脚本库 WEColor。沙箱此前只提供 WEMath，
// `import * as WEColor from 'WEColor'` 的 import 行被剥掉后 WEColor 成了未定义
// 标识符，脚本一调 WEColor.hsv2rgb 就 ReferenceError 熔断 —— 而这正是 WE 官方
// 「颜色循环」模板脚本的唯一动作（`value = WEColor.hsv2rgb({x: engine.runtime *
// speed, ...})`）。失败后颜色永远停在初值，表现为**整块固定色、不随时间变化**。
// h 取小数部分：engine.runtime 单调增长，不取模会让色相饱和在末端而不是循环。
const WECOLOR = {
  hsv2rgb: (c) => {
    const o = c && typeof c === 'object' ? c : { x: 0, y: 0, z: 0 }
    const h = (((Number(o.x) || 0) % 1) + 1) % 1
    const s = Math.min(1, Math.max(0, Number(o.y) || 0))
    const v = Math.min(1, Math.max(0, Number(o.z) || 0))
    const i = Math.floor(h * 6)
    const f = h * 6 - i
    const p = v * (1 - s)
    const q = v * (1 - f * s)
    const t = v * (1 - (1 - f) * s)
    const tbl = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]]
    const rgb = tbl[i % 6]
    return { x: rgb[0], y: rgb[1], z: rgb[2] }
  },
  rgb2hsv: (c) => {
    const o = c && typeof c === 'object' ? c : { x: 0, y: 0, z: 0 }
    const r = Number(o.x) || 0
    const g = Number(o.y) || 0
    const b = Number(o.z) || 0
    const mx = Math.max(r, g, b)
    const mn = Math.min(r, g, b)
    const d = mx - mn
    let h = 0
    if (d > 0) {
      if (mx === r) h = ((g - b) / d) / 6
      else if (mx === g) h = (2 + (b - r) / d) / 6
      else h = (4 + (r - g) / d) / 6
      if (h < 0) h += 1
    }
    return { x: h, y: mx === 0 ? 0 : d / mx, z: mx }
  },
}

// [we-scene patch] WE 内置脚本库 WEVector（全库 3 个脚本 import 它）。
// 缺失同样是 ReferenceError 熔断，只补语料会用到的分量运算。
const WEVECTOR = {
  add: (a, b) => ({ x: (a.x || 0) + (b.x || 0), y: (a.y || 0) + (b.y || 0), z: (a.z || 0) + (b.z || 0) }),
  subtract: (a, b) => ({ x: (a.x || 0) - (b.x || 0), y: (a.y || 0) - (b.y || 0), z: (a.z || 0) - (b.z || 0) }),
  scale: (a, s) => ({ x: (a.x || 0) * s, y: (a.y || 0) * s, z: (a.z || 0) * s }),
  length: (a) => Math.hypot(a.x || 0, a.y || 0, a.z || 0),
  dot: (a, b) => (a.x || 0) * (b.x || 0) + (a.y || 0) * (b.y || 0) + (a.z || 0) * (b.z || 0),
  normalize: (a) => {
    const l = Math.hypot(a.x || 0, a.y || 0, a.z || 0) || 1
    return { x: (a.x || 0) / l, y: (a.y || 0) / l, z: (a.z || 0) / l }
  },
  mix: (a, b, t) => ({
    x: (a.x || 0) + ((b.x || 0) - (a.x || 0)) * t,
    y: (a.y || 0) + ((b.y || 0) - (a.y || 0)) * t,
    z: (a.z || 0) + ((b.z || 0) - (a.z || 0)) * t,
  }),
}

// [we-scene patch] WE 的媒体播放状态枚举。取值由语料反推确定：
// 2938612768 的 `碟盘.angles` 脚本写 `state==0 → 不转 / state==1 → 旋转`，
// 与 WE 文档的 STOPPED/PLAYING/PAUSED 顺序一致。
// 全库 111 处脚本直接裸用这个名字（`MediaPlaybackEvent.PLAYBACK_PLAYING`）。
const MEDIA_PLAYBACK_EVENT = Object.freeze({
  PLAYBACK_STOPPED: 0,
  PLAYBACK_PLAYING: 1,
  PLAYBACK_PAUSED: 2,
})

// [we-scene patch] 媒体回调名。两个沙箱都要收集并暴露给宿主派发。
// 前四个是 WE 原生；mediaLyricsChanged 是本仓库的自定义扩展（见 render/media.js）。
const MEDIA_CALLBACKS = [
  'mediaPropertiesChanged', 'mediaThumbnailChanged', 'mediaPlaybackChanged',
  'mediaTimelineChanged', 'mediaStatusChanged', 'mediaLyricsChanged',
]

// [we-scene patch] 沙箱形参名。脚本顶层若用 var/let/const 声明同名标识符，
// 拼进 new Function 体后就是「形参已声明」的 SyntaxError，**整个脚本报废**。
// 全库实测撞名 389 份脚本（scriptProperties 386 / window 2 / self 1），
// 占 883 份脚本的 44%、涉及 68 个壁纸 —— 而 `export let scriptProperties =
// createScriptProperties()...` 正是 WE 官方模板的标准写法。
const SANDBOX_PARAM_NAMES = [
  'scriptProperties', 'engine', 'WEMath', 'WEColor', 'WEVector', 'createScriptProperties', 'shared',
  'console', 'process', 'globalThis', 'self', 'window', 'document', 'require', 'module', 'exports',
  'fetch', 'XMLHttpRequest', 'Worker', 'importScripts', 'location', 'navigator',
  'alert', 'confirm', 'prompt', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'Function',
  'Vec3', 'Vec2', 'input', 'thisLayer', 'thisScene', 'thisObject', 'localStorage',
  // [we-scene patch] 媒体播放状态枚举。全库 111 处脚本裸用
  // `MediaPlaybackEvent.PLAYBACK_PLAYING` 之类做状态比较，不注入会 ReferenceError
  // 熔断（三振后整个 update 停摆）。既然进了形参表，就必须同时列在这里，
  // 否则脚本顶层若声明同名变量会 SyntaxError 报废整个脚本。
  'MediaPlaybackEvent',
]
const SANDBOX_PARAM_DECL_RE = new RegExp(
  `(^[ \\t]*|;|\\})[ \\t]*(?:var|let|const)[ \\t]+(?=(?:${SANDBOX_PARAM_NAMES.join('|')})\\b)`,
  'gm',
)

const WE_IMPORT_MODULES = { WEMath: true, WEColor: true, WEVector: true }

/**
 * [we-scene patch] ES module → new Function 体：剥 import/export，并把「与沙箱形参
 * 撞名的顶层声明」降级为**赋值**（去掉 var/let/const）。降级而非改名的理由：
 * 脚本后续读的就是 `scriptProperties.xxx`，赋值到形参上语义完全正确 ——
 * 形参已由宿主传入 scene 侧的属性值，脚本的 createScriptProperties() 链只是补缺省，
 * 与既有「scene 值优先、add* 补缺省」的策略一致。
 *
 * `import * as WEMath from 'WEMath'` 剥掉后靠同名形参提供。混淆器会压成
 * `import*as _0xab from'WEMath'`（无空格、别名≠模块名）—— 旧正则要求 `import\s+`
 * 和 `from\s+'`，剥不掉就 SyntaxError「Cannot use import statement outside a module」。
 * 2887099508 菜单/安全模式/支持 Tim 等 20+ 段全是这个形态。别名必须绑到对应库，
 * 只删 import 的话 `_0xab.mix` 会 ReferenceError。
 *
 * combo 选项在 project.json 里是整数字符串（"1"/"21"），脚本可见值被收成
 * number（3396722575 `switch { case 21 }`）。作者按 JSON 字面量写 `=== '1'`
 * 时，挂载 applyUserProperties 全量传入会让 `1 === '1'` 失败。
 * 3791967416 因此关掉跟鼠标的「蓝/黑」，打开钉在 0.5 0.5 的「蓝固定」——
 * 光斑看起来永远停在脸中央。全库目前仅这一处 `=== '数字'`。
 * `rewriteComboStringEq` 把对整数字符串字面量的 ===/!== 降成 ==/!=：
 * `1 == '1'` 成立，`switch(case 21)` 不受影响。
 */
export function rewriteComboStringEq(src) {
  if (typeof src !== 'string') return src
  return src.replace(/([!=])==(\s*)(['"])(-?\d+)\3/g, '$1=$2$3$4$3')
}

function scriptToFunctionBody(script) {
  return rewriteComboStringEq(script)
    .replace(/\bimport\s*\*\s*as\s+(\w+)\s+from\s*['"]([^'"]+)['"]\s*;?/g, (_, alias, spec) => {
      const mod = String(spec)
      if (WE_IMPORT_MODULES[mod]) {
        return alias === mod ? '' : `var ${alias} = ${mod};`
      }
      return `var ${alias} = {};`
    })
    .replace(/(^[ \t]*|;|\})[ \t]*import\s+(?:[^;'"]+\s+from\s+)?['"][^'"]*['"];?[ \t]*/gm, '$1')
    .replace(/(^[ \t]*|;|\})[ \t]*export[ \t]+(?=(?:async[ \t]+)?function\b|(?:var|let|const)\b)/gm, '$1')
    .replace(SANDBOX_PARAM_DECL_RE, '$1')
}

/** 从 text.scriptproperties 取属性值：容错 {user,value} 包装（离线校验路径未经 parseScene 解引用） */function propValue(v) {
  if (v !== null && typeof v === 'object' && 'value' in v) return v.value
  return v
}

/**
 * engine.canvasSize 统一成 WE 的向量形态（.x/.y）。
 *
 * WE 的 engine.canvasSize 是带 .x/.y 的向量；本仓宿主一律传 {width,height}
 * （scene.json 的 orthogonalprojection）。直接成员访问 `canvasSize.x` 拿到
 * undefined → 脚本算出 NaN → 宿主写回 `NaN || 0` 把字段塌成 0：
 * 3790399458 三个文字层 origin 全部塌到世界原点（左下角叠字、被底边裁掉）。
 * 本地库 167 张里 15 张含此访问形态。四键并存，.x/.y 直接访问、
 * new Vec3(canvasSize) 的 x||width、divide/multiply 的 v.x 路径全部兼容
 * ——divide/multiply 读 v.x，修复前同样是 NaN，此处一并修好。
 */
function engineCanvasSize(cs) {
  const src = cs || { width: 1920, height: 1080 }
  if (src.x !== undefined && src.y !== undefined) return src
  return { x: src.width, y: src.height, width: src.width, height: src.height }
}

/**
 * 求值 WE 文字脚本，返回沙箱；脚本解析/执行失败返回 null（调用方回退静态文本）。
 * @param script text.script 源码
 * @param scriptprops scene.json 的 text.scriptproperties（值或 {user,value} 包装）
 * @param opts { text, font, pointsize, color, angles, origin, scale,
 *               canvasSize, userProperties, getLayerText(name): string }
 */
export function evalTextScript(script, scriptprops, opts = {}) {
  if (typeof script !== 'string' || script.length === 0) return null
  // ES module → 函数体：剥 import / export 声明符。export 不总在行首（压缩过的脚本
  // 形如 `"use strict";export var ...`），故按「前导符 + export + 声明关键字」全局匹配，
  // 前导符保留。import 按完整语法剥（import 'x' / import * as X from 'x'）。
  const body = scriptToFunctionBody(script)
  if (body === script && script.indexOf('update') < 0) return null

  // scriptProperties：scene 值优先，createScriptProperties 的 add* 只补缺省。
  // 声明链在模块体执行时立刻跑完并 finish()，返回的就是这个对象 —— update() 闭包
  // 捕获的是参数绑定，此后对它的原地增补对脚本可见。
  const spValues = {}
  if (scriptprops && typeof scriptprops === 'object') {
    for (const [k, v] of Object.entries(scriptprops)) spValues[k] = propValue(v)
  }
  // builder 目标必须是函数：createScriptProperties() 是调用（apply 返回自身），
  // .addXxx(...) 走 get 陷阱。add* 只补声明默认值，scene 传入的值优先。
  const builder = new Proxy(() => builder, {
    apply() {
      return builder
    },
    get(_t, name) {
      if (name === 'finish') return () => spValues
      if (typeof name === 'string' && ADD_METHOD_RE.test(name)) {
        return (def) => {
          if (def && typeof def === 'object' && typeof def.name === 'string' && !(def.name in spValues)) {
            spValues[def.name] = propValue(def.value)
          }
          return builder
        }
      }
      return undefined
    },
  })

  const thisLayer = {
    text: opts.text !== undefined && opts.text !== null ? String(opts.text) : '',
    font: opts.font || '',
    pointsize: opts.pointsize || 24,
    color: (opts.color || [1, 1, 1]).slice(),
    angles: (opts.angles || [0, 0, 0]).slice(),
    scale: (opts.scale || [1, 1, 1]).slice(),
    visible: opts.visible !== false,
    // origin 需支持 add/subtract 链式向量运算（歌曲标题脚本等 2 处用到）
    origin: makeVec3(opts.origin || [0, 0, 0]),
  }
  const engine = {
    registerAsset: () => {},
    frametime: 1 / 60,
    runtime: 0,
    canvasSize: engineCanvasSize(opts.canvasSize),
    // [we-scene patch] engine.screenResolution（全库 10 处 / 2 壁纸）：
    // 屏幕**像素**尺寸，脚本用它把 input.cursorScreenPosition 归一化
    // （3791967416 除它得 [0,1]；3509243656 减半屏得 [-1,1]）。
    // 缺它则那两个壁纸的指针换算全部除以 undefined → NaN。
    screenResolution: opts.screenResolution || { x: 1920, y: 1080 },
    // [we-scene patch] engine.timeOfDay（全库 14 处）：一天中的时刻 [0,1)，
    // 与 shader 侧的 g_Daytime 同源。
    timeOfDay: typeof opts.timeOfDay === 'number' ? opts.timeOfDay : 0,
    userProperties: opts.userProperties || {},
    // [we-scene patch] WE 音频分辨率常量（对象脚本 audio 条用
    // engine.AUDIO_RESOLUTION_16 作 registerAudioBuffers 的实参）
    AUDIO_RESOLUTION_16: 16,
    AUDIO_RESOLUTION_32: 32,
    AUDIO_RESOLUTION_64: 64,
    // [we-scene patch] engine.setTimeout / clearTimeout（全库 38 / 2 处）：
    // 3791967416 的点击缩放动画靠它做延时回弹。宿主可注入自己的实现（把回调挂到
    // 帧循环上，避免标签页节流时定时器与渲染脱节）；未注入时用宿主环境的原生实现。
    // 注意**不能**把宿主全局 setTimeout 直接暴露给脚本作用域（沙箱把它遮成
    // undefined），只能经 engine 这个受控出口给。
    setTimeout: opts.setTimeout || defaultEngineTimer,
    clearTimeout: opts.clearTimeout || (() => {}),
    setInterval: opts.setInterval || defaultEngineTimer,
    clearInterval: opts.clearInterval || (() => {}),
    openUserShortcut: opts.openUserShortcut || (() => {}),
    isRunningInEditor: !!opts.isRunningInEditor,
    isScreensaver: !!opts.isScreensaver,
  }
  applyEngineHost(engine, opts)
  // [we-scene patch] WE 音频接口：engine.registerAudioBuffers(n) → { left, right, average }。
  // 语料 31 个壁纸的脚本用它做文本随节拍缩放/变色（"Must be 16, 32 or 64 per channel"）。
  // 返回的数组由宿主每帧就地重填（audioViews 注册表按 n 共享一份），脚本求值时读到的
  // 即最新频谱快照。宿主未提供音频时保持全 0（与 WE 无音乐播放时的表现一致）。
  const audioViews = opts.audioViews
  engine.registerAudioBuffers = (n) => {
    const k = Math.max(1, Math.min(64, Math.floor(Number(n) || 0)))
    let v = audioViews ? audioViews.get(k) : undefined
    if (!v) {
      v = {
        left: new Float32Array(k),
        right: new Float32Array(k),
        average: new Float32Array(k),
      }
      if (audioViews) audioViews.set(k, v)
    }
    return v
  }
  const thisScene = {
    getLayer(name) {
      const t = opts.getLayerText ? opts.getLayerText(String(name)) : undefined
      return { text: t !== undefined && t !== null ? String(t) : '' }
    },
    // WE 支持脚本运行时建层（官方 3D 时钟阴影脚本用它造影子层）。渲染器不支持
    // 动态建层：返回一个可写属性的哑层，脚本逻辑照常走完，影子层内容被忽略 ——
    // 主文本正确，动态影子降级为无。
    createLayer(def) {
      void def
      return {
        text: '', visible: false, color: [0, 0, 0], alpha: 1,
        pointsize: opts.pointsize || 24, font: opts.font || '',
        origin: makeVec3(opts.origin || [0, 0, 0]),
        angles: [0, 0, 0], scale: [1, 1, 1],
      }
    },
    sortLayer: () => {},
    getLayerIndex: () => 0,
  }
  // shared：WE 的跨脚本共享状态对象（同场景全部文字脚本共用一份，一脚本写、其它读）
  const shared = opts.shared || {}
  // 消毒全局对象：globalThis/self/window 都指向它。语料里的反调试脚本会
  // `(function(){return this})()` 或 `window` 找全局再覆写 console —— 拿到的是这份
  // 每次求值独立的 sterile 对象，宿主全局不可达、覆写也不外泄。
  const sandboxGlobal = { console: makeSandboxConsole() }
  // [we-scene patch] input 由宿主注入共享视图（每帧就地重填），未注入时退化为全 0
  const input = makeInput(opts.inputView)

  let fns
  try {
    // 宿主全局一律用参数遮蔽：脚本跑在 new Function 的全局作用域里，能摸到
    // window/document/console/process 等。实测语料里有反调试脚本把 console.log
    // 整个换成 no-op，污染宿主；这里除 console（给静音副本）外全部遮成 undefined。
    // Function/eval 无法遮蔽（保留字语义），属已知边界：WE 本身也是全信任执行脚本。
    const factory = new Function(
      'scriptProperties', 'engine', 'thisLayer', 'thisScene', 'WEMath', 'WEColor', 'WEVector', 'createScriptProperties', 'shared',
      'console', 'process', 'globalThis', 'self', 'window', 'document', 'require', 'module', 'exports',
      'fetch', 'XMLHttpRequest', 'Worker', 'importScripts', 'location', 'navigator',
      'alert', 'confirm', 'prompt', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
      'requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'Function',
      'Vec3', 'Vec2', 'input',
      'MediaPlaybackEvent',
      '"use strict";\n' + body +
      '\n;return {' +
      'update: typeof update === "function" ? update : null,' +
      'init: typeof init === "function" ? init : null,' +
      'applyUserProperties: typeof applyUserProperties === "function" ? applyUserProperties : null,' +
      // [we-scene patch] WE 的 6 个指针回调。全库 267 处挂钩（Click 89 / Enter 52 /
      // Leave 52 / Down 26 / Up 26 / Move 22，跨 19 个壁纸）—— 这是 WE 场景互动的
      // **主入口**，比 input.cursor*（仅 18 个脚本）大一个数量级。
      // 事件对象只需 { worldPosition: Vec3 }：全库 51 处引用 event.worldPosition，
      // 无一处读 event.button / screenPosition / delta。
      'cursorClick: typeof cursorClick === "function" ? cursorClick : null,' +
      'cursorEnter: typeof cursorEnter === "function" ? cursorEnter : null,' +
      'cursorLeave: typeof cursorLeave === "function" ? cursorLeave : null,' +
      'cursorDown: typeof cursorDown === "function" ? cursorDown : null,' +
      'cursorUp: typeof cursorUp === "function" ? cursorUp : null,' +
      'cursorMove: typeof cursorMove === "function" ? cursorMove : null,' +
      // [we-scene patch] 媒体回调。此前只收了 mediaPropertiesChanged，且收完
      // 没有出口（只在「脚本是否为空」的判据里出现过一次），等于没实现。
      // 歌名/歌手文字层就靠这一条：`export function mediaPropertiesChanged(e){ mediaData = e.title }`
      // 是全库 44 处文字脚本的标准形态。
      MEDIA_CALLBACKS.map((n) => `${n}: typeof ${n} === "function" ? ${n} : null,`).join('') +
      'dummy_: 0' +
      '};',
    )
    fns = factory(
      spValues, wrapEngine(engine), thisLayer, thisScene, WEMATH, WECOLOR, WEVECTOR, builder, shared,
      sandboxGlobal.console, undefined, sandboxGlobal, sandboxGlobal, sandboxGlobal,
      undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined,
      Vec3, Vec2, input,
      MEDIA_PLAYBACK_EVENT,
    )
  } catch (e) {
    if (opts.onError) opts.onError(e, 'parse')
    return null
  }
  const hasMediaHook = !!(fns && MEDIA_CALLBACKS.some((n) => fns[n]))
  // [we-scene patch] 纯 applyUserProperties 脚本也没有 update：2847470774 的颜色常量
  // 只导出 `applyUserProperties(changed){ thisObject.color = shared.accentColor }`，
  // 是属性驱动而非时间驱动。不把它计入判据会在闸门被整个丢弃。
  const hasApplyHook = !!(fns && typeof fns.applyUserProperties === 'function')
  if (!fns || (!fns.update && !hasMediaHook && !hasApplyHook)) return null

  const sandbox = {
    engine,
    thisLayer,
    scriptProperties: spValues,
    hasUpdate: !!fns.update,
    // [we-scene patch] 是否挂了指针回调（宿主据此建 hit-test 索引）
    hasCursorHook: !!(fns.cursorClick || fns.cursorEnter || fns.cursorLeave ||
      fns.cursorDown || fns.cursorUp || fns.cursorMove),
    // [we-scene patch] 是否挂了媒体回调（宿主据此建广播表）
    hasMediaHook,
    hasApplyHook,
    errCount: 0,
    disabled: false,
    init(value) {
      if (!fns.init) return
      try { fns.init(value) } catch (e) { sandbox.errCount++; if (opts.onError) opts.onError(e, 'init') }
    },
    applyUserProperties(props) {
      if (!fns.applyUserProperties) return
      try { fns.applyUserProperties(props || {}) } catch (e) { sandbox.errCount++; if (opts.onError) opts.onError(e, 'applyUserProperties') }
    },
    /** 直调 update 不做文本加工：层可见性脚本（visible.script）要拿原始返回值
     *  ——布尔控可见，callUpdate 会把它吞成 null（防画到画面上的文字版语义）。 */
    callUpdateRaw(value) {
      if (!fns.update || sandbox.disabled) return undefined
      try {
        return fns.update(value)
      } catch (e) {
        sandbox.errCount++
        if (opts.onError) opts.onError(e, 'update')
        if (sandbox.errCount >= 3) sandbox.disabled = true
        return undefined
      }
    },
    /** 求值当前文本：返回新文本；undefined/null 保留原值；连续出错 3 次熔断回退静态文本 */
    callUpdate(value) {
      if (!fns.update || sandbox.disabled) return null
      const before = thisLayer.text
      let ret
      try {
        ret = fns.update(before !== '' ? before : (value !== undefined ? value : ''))
      } catch (e) {
        sandbox.errCount++
        if (opts.onError) opts.onError(e, 'update')
        if (sandbox.errCount >= 3) sandbox.disabled = true
        return null
      }
      if (typeof ret === 'string') {
        thisLayer.text = ret
        return ret
      }
      // 布尔不能 String()：String(false)==="false" 会画到画面上（3122339805）。
      // 数字仍转成文本（倒计时/序号类脚本会 return number）。
      if (typeof ret === 'boolean') return null
      if (ret !== undefined && ret !== null) {
        thisLayer.text = String(ret)
        return thisLayer.text
      }
      // 脚本不返回值但改写了 thisLayer.text（歌曲标题类）：采读写回
      if (thisLayer.text !== before) return thisLayer.text
      return null
    },
    // [we-scene patch] 文字脚本也有 cursor* 回调（3786330502 的鼠标悬停/显隐
    // 交互按钮挂在文字层上）。语义同对象脚本的 callCursor。
    callCursor(name, event) {
      if (sandbox.disabled) return undefined
      const fn = fns[name]
      if (typeof fn !== 'function') return undefined
      try {
        return fn(event)
      } catch (e) {
        sandbox.errCount++
        if (opts.onError) opts.onError(e, name)
        if (sandbox.errCount >= 3) sandbox.disabled = true
        return undefined
      }
    },
    /**
     * [we-scene patch] 派发媒体回调（歌名/歌手文字层的唯一数据入口）。
     * 与 callCursor 同构；宿主只在快照变化时调用。
     */
    callMedia(name, event) {
      if (sandbox.disabled) return undefined
      const fn = fns[name]
      if (typeof fn !== 'function') return undefined
      try {
        return fn(event)
      } catch (e) {
        sandbox.errCount++
        if (opts.onError) opts.onError(e, name)
        if (sandbox.errCount >= 3) sandbox.disabled = true
        return undefined
      }
    },
  }
  return sandbox
}

/**
 * [we-scene patch] 中性动画对象：所有方法可链式调用、取值返回合理默认。
 * 用途见 makeObjectLayerProxy 的 getAnimation 注释 —— 拿 null 会让脚本 TypeError 熔断。
 */
function makeNeutralAnimation() {
  const self = {
    play: () => self,
    pause: () => self,
    stop: () => self,
    setFrame: () => self,
    setRate: () => self,
    setBlend: () => self,
    setVisible: () => self,
    // isPlaying 两种调用形态都有：属性读（`if (a.isPlaying)`）与方法调
    // （`if (a.isPlaying())`）。用函数并挂 valueOf/toString，两种写法都不炸。
    isPlaying: Object.assign(() => false, { valueOf: () => false, toString: () => 'false' }),
    get frame() { return 0 },
    get frameCount() { return 0 },
    get rate() { return 1 },
  }
  return self
}

/**
 * [we-scene patch] 序列帧动画控制器（thisLayer.getTextureAnimation()）。
 *
 * 全库 52 个 sprite sheet 图层里 **37 层靠脚本钉帧**，不实现就只能按时间自动播：
 *   - 3299228616 的 30 个 AM/PM 数字：`setFrame(hours >= 12 ? 1 : 0)`，帧
 *     duration=1.0s，自动播会让 AM/PM 每秒来回闪。
 *   - 3292361861 的 4 个开关按钮：init 里先 `stop()` 再 `setFrame(状态)`，
 *     cursorClick 时改帧 —— 自动播会让按钮图标一直乱跳。
 *   - 3790527023 的 3 个播放器按钮：`pause()` + 按 mediaState 选帧。
 *
 * 状态挂在图层对象上（layer.textureAnimation），渲染端 spriteFrameBasis 读它：
 * frame 非 null 即「钉住这一格」，playing===false 则停在第 0 帧。
 * 没有图层时给中性对象，让脚本逻辑跑完而不是崩掉。
 */
function makeTextureAnimation(layer) {
  if (!layer) return makeNeutralAnimation()
  // 同一图层多次调用 getTextureAnimation() 必须拿到同一个状态：语料里
  // init 存 `animation = thisLayer.getTextureAnimation()` 后在 cursorClick 里复用，
  // 而 3790527023 的 update 每帧重新取一次 —— 两种写法都得看到同一份 frame。
  if (layer.textureAnimation) return layer.textureAnimation.api
  const state = {
    frame: null, // null = 未被脚本钉帧（走时间自动播）
    playing: true,
    rate: 1,
  }
  const api = {
    play: () => { state.playing = true; return api },
    pause: () => { state.playing = false; return api },
    // stop 语义上是「停并回到起点」；脚本随后基本都会 setFrame，故只落 playing
    stop: () => { state.playing = false; return api },
    setFrame: (n) => {
      // 语料里传布尔（`setFrame(shared.x * 1)` 里 x 可能是布尔）、越界数都有，
      // 一律转数字，夹取交给渲染端（它才知道帧总数）
      const v = Number(n)
      state.frame = Number.isFinite(v) ? v : 0
      return api
    },
    setRate: (r) => { const v = Number(r); if (Number.isFinite(v)) state.rate = v; return api },
    setBlend: () => api,
    setVisible: (v) => { layer.visible = !!v; return api },
    isPlaying: Object.assign(() => state.playing, {
      valueOf: () => state.playing,
      toString: () => String(state.playing),
    }),
    get frame() { return state.frame === null ? 0 : state.frame },
    get frameCount() { return layer.spriteFrameCount || 0 },
    get rate() { return state.rate },
  }
  state.api = api
  layer.textureAnimation = state
  return api
}

/**
 * [we-scene patch] thisLayer.getVideoTexture()（IVideoTexture）。
 *
 * 全库明文 10 处 / 4 张壁纸（3292361861、3470764447、3790527023、3792589370），
 * 另有 2887099508 混淆脚本对「健康壁纸」层取视频。语料普遍不判空：
 * `video = thisLayer.getVideoTexture(); video.stop()` —— 返回 null 会 TypeError
 * 熔断整个对象脚本（含点击播语音、安全模式）。
 *
 * 真实解码器由宿主挂到 layer.videoCtl；没挂时仍给中性句柄，方法可调用、取值给默认。
 */
function makeVideoTextureHandle(layer) {
  if (layer && layer.videoTextureApi) return layer.videoTextureApi
  const ctl = () => (layer && layer.videoCtl) || null
  const api = {
    get duration() {
      const c = ctl()
      const n = c && typeof c.duration === 'function' ? c.duration() : 0
      return Number.isFinite(n) ? n : 0
    },
    get rate() {
      const c = ctl()
      const n = c && typeof c.getRate === 'function' ? c.getRate() : 1
      return Number.isFinite(n) && n > 0 ? n : 1
    },
    set rate(v) {
      const c = ctl()
      const n = Number(v)
      if (c && typeof c.setRate === 'function' && Number.isFinite(n)) c.setRate(n)
    },
    get loop() {
      const c = ctl()
      return c && typeof c.getLoop === 'function' ? !!c.getLoop() : true
    },
    set loop(v) {
      const c = ctl()
      if (c && typeof c.setLoop === 'function') c.setLoop(!!v)
    },
    play: () => { const c = ctl(); if (c && c.play) c.play() },
    pause: () => { const c = ctl(); if (c && c.pause) c.pause() },
    stop: () => { const c = ctl(); if (c && c.stop) c.stop() },
    isPlaying: Object.assign(() => {
      const c = ctl()
      return !!(c && typeof c.isPlaying === 'function' && c.isPlaying())
    }, {
      valueOf() {
        const c = ctl()
        return !!(c && typeof c.isPlaying === 'function' && c.isPlaying())
      },
      toString() {
        const c = ctl()
        return String(!!(c && typeof c.isPlaying === 'function' && c.isPlaying()))
      },
    }),
    getCurrentTime: () => {
      const c = ctl()
      const n = c && typeof c.getCurrentTime === 'function' ? c.getCurrentTime() : 0
      return Number.isFinite(n) ? n : 0
    },
    setCurrentTime: (t) => {
      const c = ctl()
      const n = Number(t)
      if (c && typeof c.setCurrentTime === 'function' && Number.isFinite(n)) c.setCurrentTime(n)
    },
    addEndedCallback: (cb) => {
      const c = ctl()
      if (typeof cb === 'function' && c && typeof c.addEndedCallback === 'function') c.addEndedCallback(cb)
    },
  }
  if (layer) layer.videoTextureApi = api
  return api
}

/**
 * [we-scene patch] 沙箱 localStorage：语料里 2 个脚本用它存交互状态
 * （点击计数等）。给一份**进程内 Map**而不是真 localStorage —— 壁纸脚本不该
 * 污染宿主存储，且离线校验里 localStorage 本就不存在。
 */
function makeSandboxStorage() {
  const m = new Map()
  const get = (k) => (m.has(String(k)) ? m.get(String(k)) : null)
  const set = (k, v) => { m.set(String(k), String(v)) }
  return {
    getItem: get,
    setItem: set,
    // 语料里有脚本按 `localStorage.set/get` 调用（非标准写法），一并提供别名
    get: get,
    set: set,
    removeItem: (k) => { m.delete(String(k)) },
    remove: (k) => { m.delete(String(k)) },
    clear: () => { m.clear() },
    key: (i) => Array.from(m.keys())[i] ?? null,
    get length() { return m.size },
  }
}

/**
 * [we-scene patch] 骨骼 API 桥接（thisLayer.getBoneCount / getBoneTransform /
 * setBoneTransform / applyBonePhysicsImpulse）。
 *
 * 用途：WE 的 puppet 骨骼拖拽。全库 3 个壁纸在用
 * （2998757800 / 3790261114 / 3790389413），共 2 份不同源码。
 *
 * ---- API 面按全库调用点实测，比想象中小得多 ----
 *
 * `getBoneTransform(i)` 返回的 Transform **只有 `translation` 一个成员**
 * （全库 19 次调用；`rotation`/`scale`/`position`/`quaternion` 等**零调用**）：
 *   - `translation()` 无参 → getter，返回 Vec3（14 次，之后常接
 *     `.copy()`/`.subtract()`/`.length()`/`.add()`/`.multiply()`）；
 *   - `translation(v)` 有参 → setter，**必须返回 Transform 自身**，
 *     因为语料的唯一写法是
 *     `setBoneTransform(i, getBoneTransform(i).translation(vec))`
 *     —— 返回 Vec3 会让 setBoneTransform 收到错误类型。
 *
 * `setBoneTransform` 的语义是**绝对覆盖**而非累加：脚本每帧从 dragStart 重算绝对
 * 位置再写入（`drag = dragStart.add(dir.multiply(min(MAX, dist)))`）。
 * 唯一看起来像累加的 `translation(translation().add(CLICK_BOUNCE))` 是脚本自己
 * 先读后加再绝对写。若实现成累加，拖拽时骨骼会每帧叠加、瞬间飞出画面。
 *
 * ---- 坐标空间：脚本要世界像素，MDL 存图层局部像素（Y 朝上）----
 *
 * 脚本把骨骼平移与 `event.worldPosition` / `input.cursorWorldPosition` 放在同一次
 * 减法里比距离，并用 `DRAG_MAX_DISTANCE=80` / `DRAG_MAX_RADIUS=200` 当**像素**阈值
 * —— 所以对外必须是世界像素。而 MDL 的 `bones[i].matrix` 第 4 列是**图层局部像素、
 * Y 朝上**（与网格顶点同空间，见 mdl.js 顶部「网格坐标 = 图层局部像素、Y 轴朝上」）。
 *
 * 故双向换算：
 *   world.x = origin.x + localX * scaleX
 *   world.y = origin.y - localY * scaleY      ← Y 翻转（世界 y 向下、骨骼 y 向上）
 * 逆变换同理。实测本机 3 个模型的骨骼 `parent` 全为 -1（无层级），
 * 因此不需要父链累乘；但仍按 parent 累加以防将来遇到有层级的模型。
 *
 * 已知边界：`applyBonePhysicsImpulse` 为 no-op。它只出现在松手回调里（3 次），
 * 影响释放后的回弹表现，不影响拖拽主路径；真实实现需要 MDLS 元数据里的
 * 弹簧参数与逐帧积分，属独立课题。
 *
 * @param {object} layer parse.js 的图层对象（需 puppet/origin/scale）
 * @param {Map<number, number[]>} overrides 宿主持有的覆写表（骨骼**局部**空间），
 *   与 computeSkinMatrices 的第 4 参是同一个对象引用
 */
function makeBoneApi(layer, overrides) {
  const mdl = layer && layer.puppet
  const bones = (mdl && mdl.bones) || null
  const count = bones ? bones.length : 0
  const origin = (layer && layer.origin) || [0, 0, 0]
  const scale = (layer && layer.scale) || [1, 1, 1]
  const sx = scale[0] || 1
  const sy = scale[1] || 1

  // 骨骼局部（y-up）→ 世界像素（y-down）
  const toWorld = (lx, ly) => [origin[0] + lx * sx, origin[1] - ly * sy]
  // 世界像素（y-down）→ 骨骼局部（y-up）
  const toLocal = (wx, wy) => [(wx - origin[0]) / sx, -(wy - origin[1]) / sy]

  // 该骨当前的局部平移：优先取覆写（脚本同帧内先写后读），否则取绑定矩阵
  const localT = (i) => {
    const ov = overrides.get(i)
    if (ov) return [ov[0], ov[1], ov[2]]
    const m = bones[i].matrix
    return [m[12], m[13], m[14]]
  }
  // 沿 parent 链累加到世界（本机模型 parent 恒为 -1，保留以防有层级的模型）
  const worldT = (i) => {
    let x = 0, y = 0
    let cur = i
    for (let guard = 0; cur >= 0 && cur < count && guard < 64; guard++) {
      const t = localT(cur)
      x += t[0]; y += t[1]
      cur = bones[cur].parent
    }
    return toWorld(x, y)
  }

  const makeTransform = (i) => {
    const tf = {
      /** 无参 = getter（返回世界像素 Vec3）；有参 = setter（**返回自身**） */
      translation(v) {
        if (v === undefined) {
          const w = worldT(i)
          return new Vec3(w[0], w[1], 0)
        }
        const a = normVec(v)
        // 世界 → 局部；父链有平移时减去父的世界量（本机模型 parent=-1，等价于直接换算）
        let px = 0, py = 0
        if (bones[i].parent >= 0) {
          const pw = worldT(bones[i].parent)
          const pl = toLocal(pw[0], pw[1])
          px = pl[0]; py = pl[1]
        }
        const l = toLocal(a[0], a[1])
        overrides.set(i, [l[0] - px, l[1] - py, 0])
        return tf
      },
      // 语料零调用，保留链式以防混淆脚本按名访问
      rotation() { return tf },
      scale() { return tf },
    }
    return tf
  }

  return {
    getBoneCount: () => count,
    getBoneTransform: (i) => {
      const k = Math.floor(Number(i))
      if (!bones || !(k >= 0) || k >= count) {
        // 越界时给一个安全的哑 Transform：语料的 cursorDown 会遍历
        // getBoneCount() 次，正常不越界；但混淆脚本可能传非法下标。
        const dummy = {
          translation(v) { return v === undefined ? new Vec3(0, 0, 0) : dummy },
          rotation() { return dummy },
          scale() { return dummy },
        }
        return dummy
      }
      return makeTransform(k)
    },
    setBoneTransform: (i, tf) => {
      // translation(v) 已经把覆写写进表里了，这里只做下标校验。
      // WE 的这个调用是「提交」语义，实参就是刚被 translation(v) 改过的 Transform。
      const k = Math.floor(Number(i))
      if (!bones || !(k >= 0) || k >= count) return
      void tf
    },
    // 见函数头「已知边界」
    applyBonePhysicsImpulse: () => {},
  }
}

/**
 * [we-scene patch] 对象脚本的 thisLayer / thisScene.getLayer 代理。
 *
 * 指针交互脚本靠它读写图层：3299228616 的 cursorMove 读 scale/size 再写 origin，
 * 2998757800 的 cursorDown 走 getBoneCount/getBoneTransform。改动前对象脚本沙箱
 * 里根本没有 thisLayer/thisScene，这类回调一进来就 ReferenceError（实测 66 次）。
 *
 * 传入真实图层（parse.js 的 layer 对象）时**双向**打通：读取取实时值，
 * 写 origin/scale/angles/color 直接落到图层数组上，下一帧渲染即生效
 * （与 main.ts 逐帧写回对象脚本字段的既有路径一致）。
 * 未传图层时给一份可读可写的哑层，让脚本逻辑跑完而不是崩掉。
 *
 * 骨骼相关方法返回中性值：MDL 蒙皮目前纯时间驱动，脚本写回骨骼变换是另一个
 * 独立课题（见 README「已知边界」）。这里保证脚本能跑完而不是熔断。
 */
/**
 * [we-scene patch] 图层效果句柄（thisLayer / thisScene.getLayer(x) 的 getEffect）。
 *
 * WE 的「切换外观」互动几乎都靠它：作者把两套外观做成同一图层上的两个 blend 效果，
 * 点击时开一个关一个 —— 3148125112 的丝袜（`getEffect('白丝').visible = false`）、
 * 3791967416 的蓝/黑配色、3351179520 的红色、2887099508 的三处设置开关都是这形态。
 *
 * 索引与名字两种取法都有：3122339805 写 `thisLayer.getEffect(0).visible = false`，
 * 其余按名字。名字对不上时**仍返回句柄**而不是 null —— 语料里一律写成
 * `getEffect(x).visible = y` 不做判空，返回 null 会 TypeError，
 * 沙箱连错 3 次熔断，整个交互脚本失效（这正是丝袜点不动的原因）。
 *
 * 写 visible 直接落到 layer.effects[i].visible，渲染端每帧 `filter(e => e.visible)`
 * 读它，下一帧即生效。
 */
function makeEffectHandle(eff) {
  return {
    get visible() { return eff ? !!eff.visible : false },
    set visible(v) { if (eff) eff.visible = !!v },
    get name() { return (eff && eff.name) || '' },
    // 语料里没见到别的成员，但保持链式安全
    getMaterial: () => null,
  }
}

/**
 * [we-scene patch] thisScene.destroyLayer。
 *
 * 此前是空 stub。全库 7 张壁纸调用它，典型形态是开场 Logo 盖住整屏
 * （3786330502「开场Logo」2560×1440×1.51），用户关掉「开场动画」属性时
 * applyUserProperties 里 `destroyLayer('开场Logo')`。stub 什么都不做，
 * 盖屏层 visible 快照仍是 true，壁纸永远停在开场第一帧。
 *
 * WE 语义：按名字或图层对象拆掉该层。本仓不真的 splice `scene.layers`
 * （装配期的脚本/粒子引用还指着原对象），而是 `visible=false` + `destroyed`
 * 墓碑：渲染/命中跳过，后续 getLayer 对该名返回哑代理，缓存的代理再写
 * visible 也打不到活层上——否则 3786330502 的 update 在 logo1=true 时
 * 每帧 `getLayer('开场Logo').visible = true` 会把刚拆掉的盖屏层救活。
 *
 * 形参两种：字符串名（3264246690 / 3786330502）和图层代理
 * （3791967416 `destroyLayer(thisScene.getLayer(name))`）。
 */
function resolveDestroyTarget(arg, opts) {
  if (arg == null) return null
  const lookup = (name) => {
    if (!name) return null
    if (opts && typeof opts.getSceneLayer === 'function') {
      const l = opts.getSceneLayer(String(name))
      if (l) return l
    }
    if (opts && opts.layer && opts.layer.name === name) return opts.layer
    return null
  }
  if (typeof arg === 'object') return lookup(arg.name)
  return lookup(String(arg))
}

function markLayerDestroyed(layer, opts) {
  if (!layer) return
  layer.visibleSelf = false
  layer.visible = false
  layer.destroyed = true
  if (opts && typeof opts.recomputeVisibility === 'function') opts.recomputeVisibility()
}

/**
 * WE 工坊脚本 `export let __workshopId = '…'`：把 `models/bar.json` 之类的
 * 包内相对路径解析成 `models/workshop/<id>/bar.json`。
 * 已带 `/workshop/` 的路径原样返回。
 */
export function resolveWorkshopAssetPath(assetPath, workshopId) {
  if (typeof assetPath !== 'string' || !assetPath) return assetPath
  if (/\/workshop\//.test(assetPath)) return assetPath
  const id = workshopId != null && workshopId !== '' ? String(workshopId) : ''
  if (!id) return assetPath
  const m = assetPath.match(/^(models|materials|shaders|particles|effects)\/(.+)$/)
  if (!m) return assetPath
  return `${m[1]}/workshop/${id}/${m[2]}`
}

function extractWorkshopId(script) {
  if (typeof script !== 'string') return null
  const m = script.match(/export\s+let\s+__workshopId\s*=\s*['"](\d+)['"]/)
  return m ? m[1] : null
}

/**
 * 对象脚本的 thisScene。getLayer 找不到仍回哑代理（语料不判空）。
 *
 * 2026-09 全库扫出来、此前是 stub 的：
 *   enumerateLayers  3 处 / 2 张（2847470774 收集 player 层、3790527023 切场景）
 *   getCameraTransforms / setCameraTransforms  1 张（3151551777 火车震动 zoom）
 *   getInitialLayerConfig + createLayer  3791163858 克隆音频条
 *   getAnimation(name)  3444535389 场景级命名动画（此前恒 null → .play TypeError）
 *
 * 2026-09-04：createLayer('models/bar.json') 字符串路径 + __workshopId
 * （3789604238 等 7 张 Simple Visualizer；此前 typeof 非 object → 空层）
 */
function makeThisScene(opts) {
  const layerProxy = (layer) => makeObjectLayerProxy(layer || null, opts)
  return {
    getLayer(name) {
      if (opts.getSceneLayer) {
        const l = opts.getSceneLayer(String(name))
        if (l && !l.destroyed) return layerProxy(l)
      }
      return layerProxy(null)
    },
    createLayer(cfg) {
      if (typeof opts.createSceneLayer !== 'function') return layerProxy(null)
      let arg = cfg
      if (typeof cfg === 'string') {
        const wid = typeof opts.getWorkshopId === 'function'
          ? opts.getWorkshopId()
          : opts.workshopId
        arg = resolveWorkshopAssetPath(cfg, wid)
      }
      const created = opts.createSceneLayer(arg)
      if (created) return layerProxy(created)
      return layerProxy(null)
    },
    destroyLayer(arg) { markLayerDestroyed(resolveDestroyTarget(arg, opts), opts) },
    sortLayer: () => {},
    getLayerIndex(arg) {
      const list = typeof opts.enumerateSceneLayers === 'function' ? opts.enumerateSceneLayers() : []
      const name = arg && typeof arg === 'object' ? arg.name : String(arg || '')
      const i = list.findIndex((l) => l && l.name === name)
      return i < 0 ? 0 : i
    },
    enumerateLayers() {
      const list = typeof opts.enumerateSceneLayers === 'function' ? opts.enumerateSceneLayers() : []
      const out = []
      for (const l of list) {
        if (l && !l.destroyed) out.push(layerProxy(l))
      }
      return out
    },
    getAnimation(name) {
      if (typeof opts.getSceneAnimation === 'function') {
        const a = opts.getSceneAnimation(name)
        if (a) return a
      }
      // 语料不判空：`thisScene.getAnimation("ckk").play()`
      return makeNeutralAnimation()
    },
    getCameraTransforms() {
      const c = opts.cameraTransforms || { zoom: 1 }
      return {
        zoom: typeof c.zoom === 'number' ? c.zoom : 1,
        center: c.center || null,
        eye: c.eye || null,
        parallaxAmount: typeof c.parallaxAmount === 'number' ? c.parallaxAmount : 0,
      }
    },
    setCameraTransforms(t) {
      const c = opts.cameraTransforms
      if (!c || !t || typeof t !== 'object') return
      if (typeof t.zoom === 'number' && Number.isFinite(t.zoom) && t.zoom > 0) c.zoom = t.zoom
      if (t.center !== undefined) c.center = t.center
      if (t.eye !== undefined) c.eye = t.eye
      if (typeof t.parallaxAmount === 'number') c.parallaxAmount = t.parallaxAmount
    },
    getInitialLayerConfig(arg) {
      if (typeof opts.getInitialLayerConfig === 'function') return opts.getInitialLayerConfig(arg)
      const layer = resolveDestroyTarget(arg, opts)
      return layer || null
    },
  }
}

function makeObjectLayerProxy(layer, opts) {
  const vec = (arr) => makeVec3(Array.isArray(arr) ? arr : [0, 0, 0])
  // 骨骼覆写表：宿主按图层持有一份（与 computeSkinMatrices 第 4 参同一引用）。
  // getBoneOverrides 是函数，因为 thisScene.getLayer(name) 拿到的是**别的**图层，
  // 各层的覆写表互不相同。
  const boneOverrides = opts && typeof opts.getBoneOverrides === 'function' && layer
    ? opts.getBoneOverrides(layer)
    : null
  const store = {
    origin: vec(layer ? layer.origin : [0, 0, 0]),
    scale: vec(layer ? layer.scale : [1, 1, 1]),
    // SceneScript 的 angles 是**角度**；图层数组是弧度（scene.json / layerModelMatrix）。
    // 分量赋值 `layer.angles.z = -5` 必须当场写回，不能只改本地 store。
    angles: makeScriptAngleVec(layer),
    size: vec(layer ? layer.size : [0, 0, 0]),
    color: vec(layer ? layer.color : [1, 1, 1]),
  }
  const proxy = {
    get name() { return (layer && layer.name) || '' },
    get id() { return (layer && layer.id) || 0 },
    // [we-scene patch] 效果开关脚本（`effects[i].visible.script`）里的
    // `thisObject.visible` 指的是**那个效果**，不是整个图层。宿主通过
    // opts.targetEffect 指明重定向目标；不给则照旧写图层。
    // 写错对象的后果是整层被隐藏，而作者只想关掉一个效果。
    get visible() {
      const te = opts && opts.targetEffect
      if (te) return !!te.visible
      // 脚本读的是自身开关（visibleSelf），不是折叠后的有效可见性。
      // hide* 窗口脚本写完再读，应看到刚赋的值。
      if (!layer) return false
      return layer.visibleSelf !== undefined ? !!layer.visibleSelf : !!layer.visible
    },
    set visible(v) {
      const te = opts && opts.targetEffect
      if (te) { te.visible = !!v; return }
      if (!layer) return
      // 必须写 visibleSelf：parse 把「父隐藏」折进了子孙的 .visible，
      // 只改父层 .visible 不会让子层复活（3122339805 Eyes/Numbers 粉条）。
      layer.visibleSelf = !!v
      if (typeof opts.recomputeVisibility === 'function') {
        opts.recomputeVisibility()
      } else {
        layer.visible = !!v
      }
    },
    get alpha() { return layer && typeof layer.alpha === 'number' ? layer.alpha : 1 },
    set alpha(v) { if (layer) layer.alpha = Number(v) || 0 },
    get brightness() { return layer && typeof layer.brightness === 'number' ? layer.brightness : 1 },
    set brightness(v) { if (layer) layer.brightness = Number(v) || 0 },
    get text() { return layer && layer.text !== undefined ? String(layer.text) : '' },
    set text(v) {
      if (!layer) return
      if (typeof v === 'boolean') return
      layer.text = v == null ? '' : String(v)
    },
    get pointsize() { return (layer && layer.textPointsize) || 24 },
    set pointsize(v) { if (layer) layer.textPointsize = Number(v) || 24 },
    // 文字脚本 `thisLayer.font = 'fonts/….otf'`：对象代理也要能写回，否则
    // getLayer('旋转文字1').font 的赋值进空气，21 档字体切不换。
    get font() { return (layer && layer.textFont) || '' },
    set font(v) { if (layer) layer.textFont = String(v || '') },
    // 音频条模板写 `bar.alignment = 'bottom'|'centre'|'top'`（2652493753）
    get alignment() { return (layer && layer.alignment) || 'center' },
    set alignment(v) {
      if (!layer) return
      const s = String(v || 'center').toLowerCase()
      layer.alignment = s === 'centre' ? 'center' : s
    },
    // 骨骼：有 puppet 且宿主给了覆写表就接真实 MDL，否则退回中性值
    // （见 makeBoneApi 的说明；中性 getBoneCount()=0 会让拖拽脚本的
    // cursorDown 循环一次都不跑，从而整段逻辑安全地不生效）
    ...(layer && layer.puppet && boneOverrides
      ? makeBoneApi(layer, boneOverrides)
      : {
          getBoneCount: () => 0,
          getBoneTransform: () => {
            // 注意 translation 必须支持**无参 getter**：语料里 14 次这样用，
            // 返回 undefined 会让紧接的 .copy()/.subtract() 立刻 TypeError。
            const d = {
              translation(v) { return v === undefined ? new Vec3(0, 0, 0) : d },
              rotation() { return d },
              scale() { return d },
            }
            return d
          },
          setBoneTransform: () => {},
          applyBonePhysicsImpulse: () => {},
        }),
    getParent: () => {
      // 全库 70 处 / 6 张。mi 模板用 parent.visible 决定点击是否生效
      // （3238423642 等）；getParent()===null 时 `parent.visible` TypeError 熔断。
      // parse 已把子 origin 合并进世界坐标，但 parentId 仍在：这里只返回父层
      // 代理，不改 origin 空间。
      if (!layer || layer.parentId == null) return null
      const p = opts && typeof opts.getSceneLayerById === 'function'
        ? opts.getSceneLayerById(layer.parentId)
        : null
      if (!p || p.destroyed) return null
      return makeObjectLayerProxy(p, opts)
    },
    getChildren: () => {
      // 3790527023 媒体播放器：init 里 thisLayer.getChildren() 按层名解析
      // `"Artist $ Title * mm:ss"` 作为本地播放列表。空数组 = 零首歌。
      const ids = (layer && layer.childIds) || []
      if (!ids.length) return []
      const lookup = opts && typeof opts.getSceneLayerById === 'function'
        ? opts.getSceneLayerById
        : null
      if (!lookup) return []
      const out = []
      for (const id of ids) {
        const c = lookup(id)
        if (c && !c.destroyed) out.push(makeObjectLayerProxy(c, opts))
      }
      return out
    },
    // [we-scene patch] 关键帧动画：改为返回**真实控制器**。
    //
    // 此前一律返回 makeNeutralAnimation() —— 纯 no-op，`play()` 什么也不做。
    // 于是 2938612768 的封面淡入（mediaThumbnailChanged 里 `anim.stop(); anim.play()`）
    // 表现为「封面瞬切、没有过渡」。全库 126 处动画 / 25 张壁纸。
    //
    // 控制器由宿主在解析阶段建好挂到 layer.animations（名字 → 控制器）与
    // layer.animationList（声明顺序）。取不到时仍回退中性对象：语料不判空，
    // 拿 null 会 TypeError 熔断。
    getAnimation: (key) => {
      const map = layer && layer.animations
      const list = (layer && layer.animationList) || []
      if (key === undefined || key === null || key === '') return list[0] || makeNeutralAnimation()
      if (map && map[key]) return map[key]
      if (typeof key === 'number' && list[key]) return list[key]
      if (typeof key === 'string' && /^\d+$/.test(key) && list[Number(key)]) return list[Number(key)]
      return makeNeutralAnimation()
    },
    getAnimationLayer: (key) => {
      const map = layer && layer.animations
      const list = (layer && layer.animationList) || []
      if (map && map[key]) return map[key]
      if (typeof key === 'number' && list[key]) return list[key]
      if (typeof key === 'string' && /^\d+$/.test(key) && list[Number(key)]) return list[Number(key)]
      return makeNeutralAnimation()
    },
    getAnimationLayerCount: () => ((layer && layer.animationList) || []).length,
    getTextureAnimation: () => makeTextureAnimation(layer),
    // [we-scene patch] ISoundLayer / IVideoTexture 播放控制。
    //
    // 此前 play/pause/stop 是空 stub、getVideoTexture 恒 null：
    //   - 3292361861 `init` 里 `thisLayer.getVideoTexture().stop()` —— 拿 null
    //     立刻 TypeError，整段交互（含点耳朵播语音）三振熔断；
    //   - 2887099508 点书本/耳朵/切 BGM 走 `getLayer('语言1').play()`，stub
    //     什么都不做；宿主还把 startsilent 的语音一律 au.play()，一加载就抢播。
    // 句柄挂在图层的 soundCtl / videoCtl 上，由宿主把 HTMLAudio/Video 接进来。
    // 没有媒体时仍返回可调用对象（语料不判空），写入落到空气。
    play: () => { layer && layer.soundCtl && layer.soundCtl.play && layer.soundCtl.play(); layer && layer.videoCtl && layer.videoCtl.play && layer.videoCtl.play() },
    pause: () => { layer && layer.soundCtl && layer.soundCtl.pause && layer.soundCtl.pause(); layer && layer.videoCtl && layer.videoCtl.pause && layer.videoCtl.pause() },
    stop: () => { layer && layer.soundCtl && layer.soundCtl.stop && layer.soundCtl.stop(); layer && layer.videoCtl && layer.videoCtl.stop && layer.videoCtl.stop() },
    isPlaying: Object.assign(() => {
      const s = layer && layer.soundCtl && typeof layer.soundCtl.isPlaying === 'function' && layer.soundCtl.isPlaying()
      const v = layer && layer.videoCtl && typeof layer.videoCtl.isPlaying === 'function' && layer.videoCtl.isPlaying()
      return !!(s || v)
    }, {
      valueOf() {
        const s = layer && layer.soundCtl && typeof layer.soundCtl.isPlaying === 'function' && layer.soundCtl.isPlaying()
        const v = layer && layer.videoCtl && typeof layer.videoCtl.isPlaying === 'function' && layer.videoCtl.isPlaying()
        return !!(s || v)
      },
      toString() {
        const s = layer && layer.soundCtl && typeof layer.soundCtl.isPlaying === 'function' && layer.soundCtl.isPlaying()
        const v = layer && layer.videoCtl && typeof layer.videoCtl.isPlaying === 'function' && layer.videoCtl.isPlaying()
        return String(!!(s || v))
      },
    }),
    get volume() {
      if (layer && layer.soundCtl && typeof layer.soundCtl.getVolume === 'function') return layer.soundCtl.getVolume()
      const n = layer && layer.soundprops && layer.soundprops.volume
      return typeof n === 'number' ? n : 1
    },
    set volume(v) {
      const n = Number(v)
      if (!Number.isFinite(n) || !layer) return
      const c = Math.max(0, Math.min(1, n))
      if (layer.soundprops) layer.soundprops.volume = c
      if (layer.soundCtl && typeof layer.soundCtl.setVolume === 'function') layer.soundCtl.setVolume(c)
    },
    getVideoTexture: () => makeVideoTextureHandle(layer),
    getTransformMatrix: () => {
      // 全库 12 处 / 4 张。列主序 4×4，m[12]/m[13] = 世界 origin x/y
      // （WE origin 空间，Y-up）。3238423642 用 `m[12] > canvasSize.x/2`
      // 判断左右半屏。返回 null 会在 `.m` 上 TypeError。
      const o = (layer && layer.origin) || [0, 0, 0]
      const m = new Float32Array(16)
      m[0] = 1; m[5] = 1; m[10] = 1; m[15] = 1
      m[12] = o[0] || 0
      m[13] = o[1] || 0
      m[14] = o[2] || 0
      return { m }
    },
    // 见 makeEffectHandle：名字或索引取效果，取不到也返回句柄（脚本不判空）
    getEffect: (key) => {
      const list = (layer && layer.effects) || null
      if (!list || list.length === 0) return makeEffectHandle(null)
      if (typeof key === 'number' || (typeof key === 'string' && /^\d+$/.test(key))) {
        return makeEffectHandle(list[Number(key)] || null)
      }
      const name = String(key)
      return makeEffectHandle(list.find((e) => e && e.name === name) || null)
    },
  }
  Object.defineProperty(proxy, 'angles', {
    enumerable: true,
    get() { return store.angles },
    set(v) {
      if (layer && Array.isArray(layer.angles)) {
        const r = scriptAnglesToRad(v)
        layer.angles[0] = r[0]
        layer.angles[1] = r[1]
        layer.angles[2] = r[2]
      }
    },
  })
  // 向量字段：读回实时值、写回图层数组。
  // getter 必须返回**新快照**而非共享 store：官方 thisLayer.origin 是值语义，
  // 脚本常把引用长期持有（2315163178 Simple Visualizer：init 里
  // `baseOrigin = thisLayer.origin`，bars[0] 就是 thisLayer，update 每帧
  // `bar.origin = base+30` 会经 setter 写回模板层数组——getter 若回填同一 store，
  // baseOrigin 下一帧跟着涨，64 根条每帧 +30 跑出屏幕）。全库语料 0 处
  // `thisLayer.<vec>.<member> =` 成员直写，快照语义无回归面。
  for (const key of ['origin', 'scale', 'size', 'color']) {
    Object.defineProperty(proxy, key, {
      enumerable: true,
      get() {
        const a = layer && Array.isArray(layer[key]) ? layer[key] : null
        return makeVec3(a || [0, 0, 0])
      },
      set(v) {
        const a = normVec(v)
        store[key].x = a[0]; store[key].y = a[1]; store[key].z = a[2]
        // size 是渲染几何的输入，脚本改它会让效果链 FBO 尺寸抖动，不回写
        if (layer && Array.isArray(layer[key]) && key !== 'size') {
          layer[key][0] = a[0]; layer[key][1] = a[1]; layer[key][2] = a[2]
        }
      },
    })
  }
  void opts
  return proxy
}

/**
 * [we-scene patch] 求值 WE **对象脚本**（绑在 scale/origin/color/alpha/brightness/angles
 * 等 scene.json 字段上的脚本，区别于文字对象的 text.script）。经典用法：音频条的
 * scale 脚本读 engine.registerAudioBuffers(...)[频段] 逐帧改写 scale.y（3078285611
 * 底部 11 根音条即此）。
 *
 * 语义与文字脚本同族：createScriptProperties()/engine/thisScene 缺省提供，
 * update(value) 每帧调用——value 是字段的当前值（vec3 字段传可变 {x,y,z}，
 * **入参会升到 Vec3 原型**，标量字段传数字），脚本原地改写或返回新值，
 * **不做字符串化**（文字脚本专用）。
 * 解析/执行失败返回 null（调用方回退字段静态快照）；连续出错 3 次熔断。
 */
export function evalObjectScript(script, scriptprops, opts = {}) {
  if (typeof script !== 'string' || script.length === 0) return null
  const body = scriptToFunctionBody(script)

  const spValues = {}
  if (scriptprops && typeof scriptprops === 'object') {
    for (const [k, v] of Object.entries(scriptprops)) {
      // [we-scene patch] scriptProperties 的 {user: 属性名, value: 快照} 包装必须解到
      // **当前用户属性值**（WE 的 scriptProperties 是活属性代理，永远读现值）：
      // 3078285611 的音频球位置脚本快照是 50/50，用户实际滑到了 1720/105——
      // 按快照求值会把整组均衡器甩到画面左外。
      if (v !== null && typeof v === 'object' && typeof v.user === 'string') {
        const live = opts.userProperties ? opts.userProperties[v.user] : undefined
        spValues[k] = live !== undefined ? live : propValue(v)
      } else {
        spValues[k] = propValue(v)
      }
    }
  }
  const builder = new Proxy(() => builder, {
    apply() {
      return builder
    },
    get(_t, name) {
      if (name === 'finish') return () => spValues
      if (typeof name === 'string' && ADD_METHOD_RE.test(name)) {
        return (def) => {
          if (def && typeof def === 'object' && typeof def.name === 'string' && !(def.name in spValues)) {
            spValues[def.name] = propValue(def.value)
          }
          return builder
        }
      }
      return undefined
    },
  })

  const engine = {
    registerAsset: () => {},
    frametime: 1 / 60,
    runtime: 0,
    canvasSize: engineCanvasSize(opts.canvasSize),
    screenResolution: opts.screenResolution || { x: 1920, y: 1080 },
    timeOfDay: typeof opts.timeOfDay === 'number' ? opts.timeOfDay : 0,
    userProperties: opts.userProperties || {},
    AUDIO_RESOLUTION_16: 16,
    AUDIO_RESOLUTION_32: 32,
    AUDIO_RESOLUTION_64: 64,
    setTimeout: opts.setTimeout || defaultEngineTimer,
    clearTimeout: opts.clearTimeout || (() => {}),
    setInterval: opts.setInterval || defaultEngineTimer,
    clearInterval: opts.clearInterval || (() => {}),
    openUserShortcut: opts.openUserShortcut || (() => {}),
    isRunningInEditor: !!opts.isRunningInEditor,
    isScreensaver: !!opts.isScreensaver,
  }
  applyEngineHost(engine, opts)
  const audioViews = opts.audioViews
  engine.registerAudioBuffers = (n) => {
    const k = Math.max(1, Math.min(64, Math.floor(Number(n) || 0)))
    let v = audioViews ? audioViews.get(k) : undefined
    if (!v) {
      v = {
        left: new Float32Array(k),
        right: new Float32Array(k),
        average: new Float32Array(k),
      }
      if (audioViews) audioViews.set(k, v)
    }
    return v
  }

  const shared = opts.shared || {}
  const sandboxGlobal = { console: makeSandboxConsole() }
  // [we-scene patch] input 由宿主注入共享视图（每帧就地重填），未注入时退化为全 0
  const input = makeInput(opts.inputView)

  // [we-scene patch] thisLayer / thisScene：对象脚本沙箱改动前**完全没有**这两个全局，
  // 于是拖拽/悬停类 cursor* 回调一进来就 ReferenceError 熔断（实测 66 次，
  // 是 cursor 回调最大的单一失败原因）。它们恰恰是互动的核心：
  //   - 3299228616 的 cursorMove 拖拽猫：读 thisLayer.scale/size、写 thisLayer.origin；
  //   - 2998757800 的 cursorDown 抓骨骼：thisLayer.getBoneCount/getBoneTransform；
  //   - 3292361861：thisScene.getLayer(name) 跨层联动。
  // 宿主注入真实图层对象（opts.layer）时直接给脚本；未注入则给一份哑层，
  // 让脚本逻辑跑完而不是崩掉（与 thisScene.createLayer 的既有降级策略一致）。
  const layerRef = opts.layer || null
  const workshopId = opts.workshopId != null ? opts.workshopId : extractWorkshopId(script)
  const thisLayer = makeObjectLayerProxy(layerRef, opts)
  const thisScene = makeThisScene({
    ...opts,
    workshopId,
    getWorkshopId: () => workshopId,
  })

  let fns
  try {
    const factory = new Function(
      'scriptProperties', 'engine', 'WEMath', 'WEColor', 'WEVector', 'createScriptProperties', 'shared',
      'console', 'process', 'globalThis', 'self', 'window', 'document', 'require', 'module', 'exports',
      'fetch', 'XMLHttpRequest', 'Worker', 'importScripts', 'location', 'navigator',
      'alert', 'confirm', 'prompt', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
      'requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'Function',
      'Vec3', 'Vec2', 'input', 'thisLayer', 'thisScene', 'thisObject', 'localStorage',
      'MediaPlaybackEvent',
      '"use strict";\n' + body +
      '\n;return {' +
      'update: typeof update === "function" ? update : null,' +
      'init: typeof init === "function" ? init : null,' +
      'applyUserProperties: typeof applyUserProperties === "function" ? applyUserProperties : null,' +
      // [we-scene patch] 6 个指针回调（同 evalTextScript，见那里的说明）。
      // 字段脚本里 cursor* 同样常见：3299228616 的 visible.script 用 cursorMove
      // 拖拽猫、2998757800 的 visible.script 用 cursorDown 抓骨骼 —— 都挂在
      // `visible` 字段上，靠回调做互动而不是靠 update 返回值。
      'cursorClick: typeof cursorClick === "function" ? cursorClick : null,' +
      'cursorEnter: typeof cursorEnter === "function" ? cursorEnter : null,' +
      'cursorLeave: typeof cursorLeave === "function" ? cursorLeave : null,' +
      'cursorDown: typeof cursorDown === "function" ? cursorDown : null,' +
      'cursorUp: typeof cursorUp === "function" ? cursorUp : null,' +
      'cursorMove: typeof cursorMove === "function" ? cursorMove : null,' +
      // [we-scene patch] 媒体回调此前**一个都没收集**（evalTextScript 至少收了
      // mediaPropertiesChanged，这里是零）。全库 308 处声明里 264 处挂在对象字段与
      // 效果常量上，全部落在这个函数 —— 不收集就等于媒体集成整体不存在。
      MEDIA_CALLBACKS.map((n) => `${n}: typeof ${n} === "function" ? ${n} : null,`).join('') +
      'dummy_: 0' +
      '};',
    )
    fns = factory(
      spValues, wrapEngine(engine), WEMATH, WECOLOR, WEVECTOR, builder, shared,
      sandboxGlobal.console, undefined, sandboxGlobal, sandboxGlobal, sandboxGlobal,
      undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined,
      Vec3, Vec2, input, thisLayer, thisScene, thisLayer, makeSandboxStorage(),
      MEDIA_PLAYBACK_EVENT,
    )
  } catch (e) {
    if (opts.onError) opts.onError(e, 'parse')
    return null
  }
  // [we-scene patch] 放宽「必须有 update」：纯指针交互脚本没有 update，
  // 只导出 cursorMove / cursorDown 等（3299228616 的拖拽猫、2998757800 的骨骼拖拽
  // 都是这种形态，挂在 visible 字段上）。改动前这类脚本在这里被整个丢弃，
  // 回调再多也永远不会被派发。
  const hasCursorHook = !!(fns && (fns.cursorClick || fns.cursorEnter || fns.cursorLeave ||
    fns.cursorDown || fns.cursorUp || fns.cursorMove))
  // 同理：**纯媒体回调脚本也没有 update**（`mediaThumbnailChanged(e){ thisObject.visible = e.hasThumbnail }`
  // 是全库最常见的形态之一）。不把它计入判据，这类脚本会在下一行当场被丢弃。
  const hasMediaHook = !!(fns && MEDIA_CALLBACKS.some((n) => fns[n]))
  // 同理：**纯 applyUserProperties 脚本也没有 update**（2847470774 的两个颜色常量
  // 只导出 `applyUserProperties(changed){ thisObject.color = shared.accentColor }`，
  // 属性驱动而非时间驱动）。此前被闸门整个丢弃，两个常量的脚本色全部丢失。
  const hasApplyHook = !!(fns && typeof fns.applyUserProperties === 'function')
  if (!fns || (!fns.update && !hasCursorHook && !hasMediaHook && !hasApplyHook)) return null

  const sandbox = {
    engine,
    scriptProperties: spValues,
    // [we-scene patch] 供宿主区分「字段求值脚本」与「纯指针交互脚本」：
    // 后者没有 update（3299228616 的拖拽猫、2998757800 的骨骼拖拽都只导出
    // cursorMove / cursorDown），进逐帧字段求值队列只会每帧白跑。
    hasUpdate: !!fns.update,
    hasCursorHook,
    hasApplyHook,
    errCount: 0,
    disabled: false,
    init(value) {
      if (!fns.init) return
      try { fns.init(asScriptVec3(value)) } catch (e) { sandbox.errCount++; if (opts.onError) opts.onError(e, 'init') }
    },
    applyUserProperties(props) {
      if (!fns.applyUserProperties) return
      try { fns.applyUserProperties(props || {}) } catch (e) { sandbox.errCount++; if (opts.onError) opts.onError(e, 'applyUserProperties') }
    },
    /** 求值：value 为字段当前值（可变对象/数字），返回脚本的原始返回值（可能 undefined） */
    callUpdate(value) {
      if (sandbox.disabled) return undefined
      if (!fns.update) return undefined
      let ret
      try {
        ret = fns.update(asScriptVec3(value))
      } catch (e) {
        sandbox.errCount++
        if (opts.onError) opts.onError(e, 'update')
        if (sandbox.errCount >= 3) sandbox.disabled = true
        return undefined
      }
      return ret
    },
    hasCursorHook,
    /**
     * [we-scene patch] 派发指针回调。name ∈ cursorClick / cursorEnter /
     * cursorLeave / cursorDown / cursorUp / cursorMove。
     * event 只需 { worldPosition }（全库 51 处只读这一个字段）。
     * 与 callUpdate 共用三振熔断：坏脚本不会每帧刷错误日志。
     */
    callCursor(name, event) {
      if (sandbox.disabled) return undefined
      const fn = fns[name]
      if (typeof fn !== 'function') return undefined
      try {
        return fn(event)
      } catch (e) {
        sandbox.errCount++
        if (opts.onError) opts.onError(e, name)
        if (sandbox.errCount >= 3) sandbox.disabled = true
        return undefined
      }
    },
    hasMediaHook,
    /**
     * [we-scene patch] 派发媒体回调。name ∈ MEDIA_CALLBACKS。
     * 与 callCursor 同构（三振熔断 + onError 上报）。
     *
     * 宿主**只在快照变化时**调这里，不要每帧广播 —— 语料里
     * `mediaThumbnailChanged` 常写 `anim.stop(); anim.play();`，
     * 每帧调用会让动画永远卡在第 0 帧重放。
     */
    callMedia(name, event) {
      if (sandbox.disabled) return undefined
      const fn = fns[name]
      if (typeof fn !== 'function') return undefined
      try {
        return fn(event)
      } catch (e) {
        sandbox.errCount++
        if (opts.onError) opts.onError(e, name)
        if (sandbox.errCount >= 3) sandbox.disabled = true
        return undefined
      }
    },
  }
  return sandbox
}

/** 带运算方法的 vec3（thisLayer.origin.add/subtract 链式调用用） */
function makeVec3(v) {
  const a = Array.isArray(v) ? v : [0, 0, 0]
  const base = { x: a[0] || 0, y: a[1] || 0, z: a[2] || 0 }
  const api = {
    get x() { return base.x }, set x(n) { base.x = Number(n) || 0 },
    get y() { return base.y }, set y(n) { base.y = Number(n) || 0 },
    get z() { return base.z }, set z(n) { base.z = Number(n) || 0 },
    add(o) { const b = normVec(o); base.x += b[0]; base.y += b[1]; base.z += b[2]; return api },
    subtract(o) { const b = normVec(o); base.x -= b[0]; base.y -= b[1]; base.z -= b[2]; return api },
    multiply(k) {
      if (k && typeof k === 'object') {
        const b = normVec(k)
        base.x *= b[0]; base.y *= b[1]; base.z *= b[2]
      } else {
        const n = Number(k) || 0
        base.x *= n; base.y *= n; base.z *= n
      }
      return api
    },
    // 3789604238 Simple Visualizer：`baseOrigin = thisLayer.origin` 再 `baseOrigin.copy()`。
    // 旧 api 没有 copy，update 被 try/catch 吃掉 → 64 根条 origin/scale 永不更新。
    copy() { return new Vec3(base.x, base.y, base.z) },
    length() { return Math.sqrt(base.x * base.x + base.y * base.y + base.z * base.z) },
    toArray() { return [base.x, base.y, base.z] },
  }
  return api
}
function normVec(o) {
  if (Array.isArray(o)) return [o[0] || 0, o[1] || 0, o[2] || 0]
  if (o && typeof o === 'object') return [o.x || 0, o.y || 0, o.z || 0]
  const n = Number(o) || 0
  return [n, n, n]
}

// SceneScript 的 `layer.angles` 是角度（风扇脚本写 `(runtime*speed)%1*360`，
// 旋转滑条 min/max 是 ±180/360）。scene.json 快照与 layerModelMatrix 是弧度
// （-0.20944 ≈ -12°）。读写两侧必须互转，否则 3396722575 的控制器把 start_angle=-5
// 写进 angles.z，会被当成 -5rad 把丝带甩出画面。
const ANGLE_RAD = Math.PI / 180
const ANGLE_DEG = 180 / Math.PI

export function radToScriptAngles(arr) {
  const a = Array.isArray(arr) ? arr : [0, 0, 0]
  return { x: (a[0] || 0) * ANGLE_DEG, y: (a[1] || 0) * ANGLE_DEG, z: (a[2] || 0) * ANGLE_DEG }
}
export function scriptAnglesToRad(v) {
  const a = normVec(v)
  return [a[0] * ANGLE_RAD, a[1] * ANGLE_RAD, a[2] * ANGLE_RAD]
}

function makeScriptAngleVec(layer) {
  const idx = { x: 0, y: 1, z: 2 }
  const api = {
    add(o) { const a = normVec(o); api.x += a[0]; api.y += a[1]; api.z += a[2]; return api },
    subtract(o) { const a = normVec(o); api.x -= a[0]; api.y -= a[1]; api.z -= a[2]; return api },
    multiply(k) { api.x *= k; api.y *= k; api.z *= k; return api },
    toArray() { return [api.x, api.y, api.z] },
  }
  for (const k of ['x', 'y', 'z']) {
    Object.defineProperty(api, k, {
      enumerable: true,
      get() {
        if (!layer || !Array.isArray(layer.angles)) return 0
        return (layer.angles[idx[k]] || 0) * ANGLE_DEG
      },
      set(v) {
        if (!layer || !Array.isArray(layer.angles)) return
        layer.angles[idx[k]] = (Number(v) || 0) * ANGLE_RAD
      },
    })
  }
  return api
}

/**
 * 文字层溢出边距：按字号估，禁止按层的长边扩。
 * 3396722575 的 4708×420 丝带若按 `min(1024, max(w,h)+…)` 扩，会变成 6756×2468，
 * geometric_transform 在整层 UV 上画圆，字带只占中间一条，圆环塌成直线。
 */
export function textCanvasMargin(em, _padding) {
  // padding 是盒内 inset，不是溢出。曾把 pad 加进边距：3122339805 世界时钟
  // 592×214 扩成 1104×726，tint 蒙版（按原盒 296×107 画）被拉到整张透明画布上，
  // 时间该粉不粉、邻层叠出色块。签名保留 padding 以免旧调用方拆参。
  return Math.min(256, Math.ceil(Math.max(1, Number(em) || 1) * 2 + 8))
}

/** 层上挂了带蒙版的 tint 时，画布必须接近原盒，否则蒙版 UV 对不上字形。 */
export function textLayerHasTintMask(layer) {
  for (const e of layer && layer.effects ? layer.effects : []) {
    if (e && e.visible === false) continue
    const file = String((e && (e.file || e.name)) || '')
    if (file.includes('tint')) return true
    for (const p of (e && e.passes) || []) {
      for (const t of (p && p.textures) || []) {
        if (t && String(t).toLowerCase().includes('mask')) return true
      }
    }
  }
  return false
}
// ---------- 纯排版与绘制（实现在 ./text-layout.js，此处保留公共出口） ----------
// [we-scene patch] 脚本沙箱与排版是两类依赖：沙箱吃 engine/属性/媒体视图，
// 排版只吃 measure 回调与 Canvas2D。拆开后 Node 侧可只加载排版做布局判据，
// 未来 WE 脚本兼容性扩展（见 docs/SCRIPT-COMPAT.md）只改沙箱一半。
import { layoutText, drawTextLayer, effectiveTextPadding } from './text-layout.js'
export { layoutText, drawTextLayer, effectiveTextPadding }
