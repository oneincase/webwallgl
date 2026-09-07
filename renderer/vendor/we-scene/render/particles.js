// [we-scene patch] 粒子系统：CPU 模拟 + WebGL 实例化 quad 渲染。
//
// 坐标约定：粒子在**图层局部空间**模拟（发射器 origin 即局部原点），渲染时经
// 图层变换（origin / scale / angles.z）落到世界空间；世界坐标 = 像素，y 向下。
//
// 为什么用实例化 quad 而不是 gl.POINTS：
//   1. gl_PointSize 有实现相关的硬上限（多数 GL 实现 64–255），而全库实测
//      sizerandom.max 达 2200（光轴 light_shafts / beam 类），点精灵会被硬截断；
//   2. 点精灵无法旋转，但 54/149 个系统用 rotationrandom、15 个用
//      angularvelocityrandom，不支持旋转会让花瓣/叶片/碎屑看起来是僵死的圆点；
//   3. 点精灵尺寸是屏幕像素，无法随场景缩放/视差正确变化。
//
// 覆盖的 WE 组件（按全库 149 个真实粒子系统的使用频次排序，见 emitter/initializer/
// operator 的实现分支）。未覆盖者静默忽略，不影响其余部分。

// [we-scene patch] 模块结构（本仓库拆分，见 docs/ARCHITECTURE.md）：
//   particle-util.js     纯工具：值/分布解析、音频门控、3D value-noise
//   particle-shaders.js  实例精灵 shader 源 + 程序/VAO 装配（buildParticleProgram）
//   particles.js         本文件：Particle / ParticleSystem（配置编译 + 模拟 + 绘制）
import { TAU, rand, randExp, parseVec, parseDist, num, audioGate, hash3, vnoise3, fbm3, noiseVec3 } from './particle-util.js'
import { buildParticleProgram } from './particle-shaders.js'

/** genericparticle 的 REFRACT combo：槽 0 常常是空白白图，形状在法线槽。 */
export function particlePassRefract(mat) {
  const c = mat && mat.passes && mat.passes[0] && mat.passes[0].combos
  return !!(c && Number(c.REFRACT) === 1)
}

/**
 * 贴图是否是 REFRACT 用的空白白占位（每像素 rgb≈255 且 a≈255）。
 * 2464842912 Raindrops Splatter Small 的 `particles 256x1280 blank` 就是这种：
 * 按普通精灵画会铺满不透明白方块。
 */
export function rgbaIsBlankWhite(rgba) {
  if (!rgba || rgba.length < 16) return false
  const n = rgba.length / 4
  const step = Math.max(1, (n / 64) | 0)
  let seen = 0
  for (let i = 0; i < n; i += step) {
    const o = i * 4
    if (rgba[o] < 250 || rgba[o + 1] < 250 || rgba[o + 2] < 250 || rgba[o + 3] < 250) return false
    seen++
  }
  return seen > 0
}

/**
 * Sprite Trail 的沿向倍率（官方：Length × speed = 理想长度，再夹 Min/Max Length）。
 * min/max 缺省 0 表示不设下限 / 上限。三项皆为 1 时恒为 1：只转向、不变形。
 */
export function spriteTrailLengthFactor(speed, length, minLength, maxLength) {
  let f = Math.abs(Number(speed) || 0) * (Number(length) || 0)
  const mn = Number(minLength) || 0
  const mx = Number(maxLength) || 0
  if (mn > 0) f = Math.max(mn, f)
  if (mx > 0) f = Math.min(mx, f)
  return f
}

/** 贴图 +Y 对齐速度（投影空间）。零速度不转。 */
export function spriteTrailRotation(dx, dy) {
  if (!(dx || dy)) return 0
  return Math.atan2(dy, dx) - Math.PI / 2
}

/** 每个活粒子画几份实例：ropetrail 才按历史点数；spritetrail 永远 1。 */
export function particleInstanceSegs(trailCfg, trailSegments) {
  return trailCfg && trailCfg.kind === 'ropetrail' ? Math.max(1, trailSegments || 1) : 1
}

/**
 * Rope Trail 历史采样点数。官方字段是 `segments`（全库 maxlength 从不出现在
 * ropetrail 上）。缺省 8：旧实现误用 subdivision 默认 1 → max(2,1)=2，尾迹只有
 * 两帧，length=0.5 的雨丝（3792881540 Gotas）缩成几个像素点。
 */
export function ropeTrailHistoryCount(cfg) {
  if (!cfg || cfg.kind !== 'ropetrail') return 1
  const segs = Math.round(Number(cfg.segments) || 0)
  if (segs >= 2) return Math.min(32, segs)
  return 8
}

/**
 * Rope Trail 的 Length = 尾迹时长（秒）。文档：加长 Length 还要加 lifetime。
 * 0.2/0.4/0.5 是预设常见值；若当空间长度则亚像素不可见。
 */
export function ropeTrailDuration(cfg) {
  if (!cfg || cfg.kind !== 'ropetrail') return 0
  const L = Number(cfg.length)
  return Number.isFinite(L) && L > 0 ? L : 0.2
}

/**
 * rope 段端点的贴图 v。v=0 是纹理第 0 行（亮端，.tex 无翻行上传）：
 * 新生粒子 v≈0 亮、老年端 v→1 淡出。GPU 写实例与 CPU 参考光栅共用，
 * 改方向两边一起变，verify-particles 的「头亮于尾」判据才覆盖得到。
 */
export function ropeParticleV(p) {
  return p.life > 0 ? p.age / p.life : 0
}


class Particle {
  constructor() {
    this.alive = false
    // 位置 / 速度（图层局部空间，像素）
    this.x = this.y = this.z = 0
    this.vx = this.vy = this.vz = 0
    // 振荡类算子需要「未受振荡影响的基准位置」，否则振荡会与运动互相累加发散
    this.bx = this.by = this.bz = 0
    this.age = 0
    this.life = 1
    this.size = 1
    this.baseSize = 1
    this.rot = 0
    this.rotVel = 0
    this.r = this.g = this.b = 1
    this.baseR = this.baseG = this.baseB = 1
    this.alpha = 1
    this.baseAlpha = 1
    this.seed = 0
    this.frame = 0
    // 每粒子固化的随机相位：振荡类算子的 min/max 必须在**生成时**取一次，
    // 若每帧重取，随机相位会让粒子每帧跳到不同位置（表现为剧烈抖动）。
    this.oscPhase = 0
    this.oscFreq = 0
    this.oscAmp = 0
    this.oscAPhase = 0
    this.oscAFreq = 0
    this.oscSPhase = 0
    this.oscSFreq = 0
    this.turbSpeed = 0
    this.turbPhase = 0
    // ropetrail 才记历史折线；spritetrail 是单精灵转向+拉伸，不记历史
    this.trail = null
    // 距下一次把当前位置推进历史环的剩余时间累加（见 trailSampleDt）
    this.trailClock = 0
    // 发射序号：rope 渲染器按它把存活粒子连成一条绳（pool 槽位顺序 ≠ 发射顺序）
    this.seq = 0
  }
}

export class ParticleSystem {
  constructor(gl, model, override, layer) {
    this.gl = gl
    this.model = model || {}
    this.override = override || {}
    this.layer = layer || null

    // 图层变换：粒子在局部空间模拟，渲染时用它落到世界空间。
    // WE 语义：图层 origin 是发射器世界位置，scale 缩放整个系统（尺寸与速度同步缩放），
    // angles.z 旋转发射方向。忽略它们会让所有粒子堆在世界原点。
    this.syncLayerTransform()
    this.maxCount = Math.max(1, Math.min(20000, num(this.model.maxcount, 100)))
    // 发射累加器改为按发射器各存一份（见 _step），此字段仅保留以防外部引用
    this.simTime = 0
    this.paused = false
    this.texture = null
    this.normalTex = null
    this.material = null
    this.blend = 'translucent'
    this.refract = false
    this.refractAmount = 0.04
    this.opacityMul = 1
    this.lifetimeMul = 1
    this.visible = true
    this._ready = false
    this._prog = null
    this._vbuf = null
    this._quadBuf = null
    this._vao = null
    this._data = null
    this._sceneTex = null
    // 序列帧（sprite sheet）。优先用贴图 TEXS 段里的**真实帧矩形**；
    // 只有在贴图没有 TEXS 时才退回按 sequencemultiplier 猜 N×N 方格
    // （猜测对横排/竖排的 sheet 是错的，会采样到跨帧的错位图块）。
    this.sequenceMul = Math.max(1, Math.round(num(this.model.sequencemultiplier, 1)))
    this.animationMode = this.model.animationmode || null
    this.texFrames = null // 由 setTexture 填充
    this.frameCount = this.sequenceMul * this.sequenceMul
    // 精灵 quad 的贴图宽高比（setTexture 按实际贴图/单帧尺寸覆盖）
    this.texAspectX = 1
    this.texAspectY = 1
    // 控制点（controlpointattract / mapsequencearoundcontrolpoint 用）
    // 锁鼠标有两种写法：显式 locktopointer:true，以及更常见的 flags bit0
    // （全库 flags=1 共 93 处 / 57 张壁纸，其中只有 10 处同时写了 locktopointer）。
    // 漏读 flags 会让「躲开光标再回去」整条链路停在原点（1425503532 Pac-Man）。
    this.controlPoints = (this.model.controlpoint || []).filter(Boolean).map((cp) => ({
      id: num(cp.id, 0),
      lockToPointer: !!cp.locktopointer || (num(cp.flags, 0) & 1) !== 0,
      offset: parseVec(cp.offset),
      // 世界空间的当前位置（局部空间）
      x: 0,
      y: 0,
      z: 0,
    }))
    this.pointer = null // {x,y} 局部空间鼠标位置
    // eventfollow / static 子级：每帧把本系统 origin 对到父粒子或父系统
    this._followParent = null
    this._followMode = null // 'particle' | 'origin'
    this._followOffset = [0, 0, 0]
    // rope 渲染器：把存活粒子按发射序连成一条绳（1425503532 的 Pac-Man 光束）
    this.ropeRenderer = null
    this._seq = 0
    this._ropeOrder = []

    this._ov = {}
    this._applyOverride()

    // starttime：WE 用它预热模拟，让首帧就有铺满的粒子（雪/雾不会从空屏渐入）
    this.startTime = Math.max(0, Math.min(30, num(this.model.starttime, 0)))
    this._warmed = false

    // 预解析算子/初始化器：每帧遍历 JSON 并做 name 比较在 100k 粒子下开销可观
    this._compile()
  }

  /**
   * 热更：`instanceoverride` 与图层共享同一引用，resolveUserProps 会就地改 `.value`。
   * 挂载时算进 `_ov` 的颜色/倍率不会自动跟上 —— 自定义滑条改完必须再跑一遍。
   */
  reapplyOverride() {
    this._applyOverride()
  }

  _applyOverride() {
    // 重新应用前清掉上次的倍率，避免旧键残留（热更去掉某个 override 字段时）
    this._ov = {}
    this.opacityMul = 1
    this.lifetimeMul = 1
    this.maxCount = Math.max(1, Math.min(20000, num(this.model.maxcount, 100)))
    const ov = this.override || {}
    for (const k of Object.keys(ov)) {
      if (k === 'id') continue
      const raw = ov[k]
      const val = raw && typeof raw === 'object' && 'value' in raw ? raw.value : raw
      if (k === 'count') {
        // count 是**粒子数量倍率**：既缩上限，也按同比例缩发射率。
        // 只缩 maxcount 是错的 —— 稳态存活数 ≈ rate × lifetime，不动 rate 的话
        // 调小 count 只会让粒子更快被回收、密度几乎不变，与编辑器里"数量"滑块的语义相反。
        // 全库 91 个带 count override 的层实测：只缩上限有 46% 的层稳态超出 maxcount
        // 被硬截断（2370927443 的 Rain_secondary 需要 4500 颗却只有 1300 的上限，
        // 于是 1300 颗全挤在 6%×20% 的小窗格里，密度是主雨的 900 倍 ——
        // 表现为「画面正中一块过密的长方形雨」）；同时缩发射率则降到 13%。
        const base = num(this.model.maxcount, 100)
        const mul = Number(val)
        const m = Number.isFinite(mul) ? mul : 1
        this.maxCount = Math.max(1, Math.min(20000, Math.round(base * m)))
        this._ov.countMul = m
      } else if (k === 'alpha') {
        this.opacityMul = Number(val)
        if (!Number.isFinite(this.opacityMul)) this.opacityMul = 1
      } else if (k === 'color' || k === 'colorn') {
        // color 是 0–255，colorn 是 0–1 归一化。此前一律 /255 会把
        // colorn（如 "1 0.968 0.149"）压成近黑，粒子全部消失在暗背景里。
        const v = parseVec(val)
        this._ov.color = k === 'colorn' ? v : [v[0] / 255, v[1] / 255, v[2] / 255]
      } else if (k === 'size') {
        this._ov.size = Number(val) || 1
      } else if (k === 'rate') {
        // rate 是**倍率**而非绝对值（实测 32 处 override 全在 0.19–4.84 区间，
        // 且与 emitter.rate 一起出现：如 rate=250 的 emitter 配 override 0.32 → 80/s）。
        // 当成绝对值会把 250/s 的发射器压成 0.32/s，粒子几乎不出现。
        this._ov.rateMul = Number(val)
        if (!Number.isFinite(this._ov.rateMul)) this._ov.rateMul = 1
      } else if (k === 'speed') {
        this._ov.speed = Number(val) || 1
      } else if (k === 'lifetime') {
        this.lifetimeMul = Number(val) || 1
      } else if (k === 'brightness') {
        this._ov.brightness = Number(val) || 1
      } else {
        this._ov[k] = val
      }
    }
    this.pool = []
    for (let i = 0; i < this.maxCount; i++) this.pool.push(new Particle())
  }

  // 把 model 的 JSON 描述编译成扁平参数，避免每帧字符串比较
  _compile() {
    const m = this.model
    this.emitters = (m.emitter || []).map((e) => ({
      kind: e.name === 'boxrandom' ? 'box' : 'sphere',
      origin: parseVec(e.origin),
      directions: parseVec(e.directions, [1, 1, 1]),
      distanceMin: parseDist(e.distancemin),
      distanceMax: parseDist(e.distancemax),
      sign: e.sign ? parseVec(e.sign) : null,
      rate: num(e.rate, 0),
      // rate 与 instantaneous 都缺省 = 「维持池满」的常驻场（尘埃/灰烬/星空）。
      // 全库有 21 个这样的发射器（dust_motes_0 / ember_small / Shooting_Star_01）。
      // 若按 rate=0 处理，这些系统一颗粒子都不会出现（dust motes 整层消失）。
      //
      // 但带 audioprocessingmode 的发射器例外：它的发射量由系统音频驱动，
      // 静音时 WE 的发射量趋近 0（_step 里按 audio.level 门控；无音频输入时恒 0）。
      // 若按「维持池满」处理，会把音频响应的星星填满并叠成一片过曝
      // （2419444134 的 reactive Stars 实测 15% 像素过曝）。故静音时按不发射处理。
      audioDriven: e.audioprocessingmode !== undefined,
      // audioprocessingbounds：发射量随响度平滑门控的区间（实测 "0.8 1" 等）
      audioBounds: parseVec(e.audioprocessingbounds, [0, 1]),
      fill: e.rate === undefined && e.instantaneous === undefined && e.audioprocessingmode === undefined,
      instantaneous: num(e.instantaneous, 0),
      speedMin: num(e.speedmin, 0),
      speedMax: num(e.speedmax, 0),
      // 发射器可贴到控制点。缺省 = 0，而 CP0 就是系统原点；
      // CP0 flags=1 锁鼠标时，粒子从光标处生出（鼠标轨迹），不是钉在图层 origin。
      controlPoint: e.controlpoint !== undefined && e.controlpoint !== null ? num(e.controlpoint, 0) : 0,
      _burst: false,
    }))

    const init = m.initializer || []
    this.init = {
      life: null,
      size: null,
      color: null,
      alpha: null,
      velocity: null,
      rotation: null,
      angularVelocity: null,
      turbulentVelocity: null,
      mapAround: null,
    }
    for (const z of init) {
      switch (z.name) {
        case 'lifetimerandom':
          this.init.life = { min: num(z.min, 1), max: num(z.max, 1), exp: num(z.exponent, 1) }
          break
        case 'sizerandom':
          this.init.size = { min: num(z.min, 1), max: num(z.max, 1), exp: num(z.exponent, 1) }
          break
        case 'colorrandom':
          // WE 的 colorrandom 是 0–255；min/max 不保证有序（实测大量 min>max）
          this.init.color = { min: parseVec(z.min, [255, 255, 255]), max: parseVec(z.max, [255, 255, 255]) }
          break
        case 'alpharandom':
          this.init.alpha = { min: num(z.min, 1), max: num(z.max, 1) }
          break
        case 'velocityrandom':
          this.init.velocity = { min: parseVec(z.min), max: parseVec(z.max) }
          break
        case 'rotationrandom':
          this.init.rotation = { min: parseVec(z.min), max: parseVec(z.max, [0, 0, 0]), exp: num(z.exponent, 1) }
          break
        case 'angularvelocityrandom':
          this.init.angularVelocity = { min: parseVec(z.min), max: parseVec(z.max), exp: num(z.exponent, 1) }
          break
        case 'mapsequencearoundcontrolpoint':
          // Position around control point：在控制点周围 N 个点上轮流投放。
          // 3233141951 樱花轨迹 count=5、CP0 锁鼠标，花瓣从光标旁一圈冒出。
          this.init.mapAround = {
            count: Math.max(1, num(z.count, 1)),
            bounds: parseVec(z.bounds, [0, 1]),
            speedMin: parseVec(z.speedmin),
            speedMax: parseVec(z.speedmax, [0, 0, 0]),
            cp: num(z.controlpoint, 0),
          }
          this._mapAroundSeq = 0
          break
        case 'turbulentvelocityrandom':
          // 用噪声场给初速度方向（雪/雾的自然扩散感来源）
          this.init.turbulentVelocity = {
            scale: num(z.scale, 0.1),
            offset: num(z.offset, 0),
            speedMin: num(z.speedmin, 0),
            speedMax: num(z.speedmax, 0),
            phaseMax: num(z.phasemax, 0),
            timeScale: num(z.timescale, 0),
            // 音频处理（实测 Stars_copy1 "0.8 1"）：响度过门槛才施加湍流初速
            audioMode: num(z.audioprocessingmode, 0),
            audioBounds: parseVec(z.audioprocessingbounds, [0, 1]),
          }
          break
        default:
          break
      }
    }

    const ops = m.operator || []
    this.ops = {
      movement: null,
      angularMovement: null,
      alphaFade: null,
      alphaChange: null,
      sizeChange: null,
      colorChange: null,
      turbulence: [],
      oscAlpha: null,
      oscSize: null,
      oscPos: null,
      attract: [],
      vortex: [],
      remap: [],
    }
    for (const o of ops) {
      switch (o.name) {
        case 'movement':
          this.ops.movement = { gravity: parseVec(o.gravity), drag: num(o.drag, 0) }
          break
        case 'angularmovement':
          this.ops.angularMovement = { force: parseVec(o.force), drag: num(o.drag, 0) }
          break
        case 'alphafade':
          // WE 语义：fadeintime / fadeouttime 是**生命周期比例**（0–1），不是秒。
          // 省略时用编辑器默认 0.1 / 0.9（全库已写值里最常见；104 处只写了 name）。
          // 旧缺省 0 / 1 等于关掉淡入淡出，还盖掉「无 alpha 算子」时的默认包络
          // —— 2468489223 小鱼 500 条全程不透明，看起来像粒子爆炸。
          this.ops.alphaFade = { fadeIn: num(o.fadeintime, 0.1), fadeOut: num(o.fadeouttime, 0.9) }
          break
        case 'alphachange':
          this.ops.alphaChange = {
            startTime: num(o.starttime, 0),
            endTime: num(o.endtime, 1),
            startValue: num(o.startvalue, 1),
            endValue: num(o.endvalue, 0),
          }
          break
        case 'sizechange':
          this.ops.sizeChange = {
            startTime: num(o.starttime, 0),
            endTime: num(o.endtime, 1),
            startValue: num(o.startvalue, 1),
            endValue: num(o.endvalue, 1),
          }
          break
        case 'colorchange':
          this.ops.colorChange = {
            startTime: num(o.starttime, 0),
            endTime: num(o.endtime, 1),
            startValue: o.startvalue !== undefined ? parseVec(o.startvalue) : null,
            endValue: parseVec(o.endvalue, [1, 1, 1]),
          }
          break
        case 'turbulence':
          this.ops.turbulence.push({
            scale: num(o.scale, 0.01),
            speedMin: num(o.speedmin, 0),
            speedMax: num(o.speedmax, 0),
            timeScale: num(o.timescale, 1),
            phaseMin: num(o.phasemin, 0),
            phaseMax: num(o.phasemax, 0),
            mask: o.mask !== undefined ? parseVec(o.mask, [1, 1, 1]) : [1, 1, 1],
          })
          break
        case 'oscillatealpha':
          this.ops.oscAlpha = {
            freqMin: num(o.frequencymin, num(o.frequencymax, 1)),
            freqMax: num(o.frequencymax, 1),
            scaleMin: num(o.scalemin, 0),
            scaleMax: num(o.scalemax, 1),
            phaseMax: num(o.phasemax, TAU),
          }
          break
        case 'oscillatesize':
          this.ops.oscSize = {
            freqMin: num(o.frequencymin, num(o.frequencymax, 1)),
            freqMax: num(o.frequencymax, num(o.frequencymin, 1)),
            scaleMin: num(o.scalemin, 1),
            scaleMax: num(o.scalemax, 1),
            phaseMax: num(o.phasemax, TAU),
          }
          break
        case 'oscillateposition':
          this.ops.oscPos = {
            freqMin: num(o.frequencymin, num(o.frequencymax, 0.5)),
            freqMax: num(o.frequencymax, 0.5),
            scaleMin: num(o.scalemin, 0),
            scaleMax: num(o.scalemax, 1),
            phaseMin: num(o.phasemin, 0),
            phaseMax: num(o.phasemax, TAU),
            mask: o.mask !== undefined ? parseVec(o.mask, [1, 1, 0]) : [1, 1, 0],
          }
          break
        case 'controlpointattract':
          // scale<0 = 排斥（实测 -10000 很常见，是"鼠标推开粒子"效果）
          this.ops.attract.push({
            cp: num(o.controlpoint, 0),
            origin: parseVec(o.origin),
            scale: num(o.scale, 0),
            threshold: num(o.threshold, 0),
          })
          break
        case 'vortex':
          this.ops.vortex.push({
            axis: parseVec(o.axis, [0, 0, 1]),
            offset: parseVec(o.offset),
            distanceInner: num(o.distanceinner, 0),
            distanceOuter: num(o.distanceouter, 0),
            speedInner: num(o.speedinner, 0),
            speedOuter: num(o.speedouter, 0),
            // 缺省贴在 CP0（系统原点）。CP0 锁鼠标时涡流跟着光标转，否则钉在图层中心。
            cp: o.controlpoint !== undefined && o.controlpoint !== null ? num(o.controlpoint, 0) : 0,
            // 音频处理（实测 "0.5 1"）：响度门控涡流强度（随节拍卷起/停转）
            audioMode: num(o.audioprocessingmode, 0),
            audioBounds: parseVec(o.audioprocessingbounds, [0, 1]),
          })
          break
        case 'remapvalue':
          this.ops.remap.push({
            output: o.output || 'velocity',
            rangeMin: parseVec(o.outputrangemin),
            rangeMax: parseVec(o.outputrangemax),
            fn: o.transformfunction || 'simplexnoise',
            inputScale: num(o.transforminputscale, 1),
          })
          break
        default:
          break
      }
    }

    // 渲染器：sprite（默认）/ spritetrail / rope / ropetrail
    // renderer 缺省 → sprite；显式 [] → 逻辑系统不画（父级 eventfollow 载体，全库 10 处）
    const rawR = this.model.renderer
    const omitted = rawR === undefined || rawR === null
    const rlist = Array.isArray(rawR) ? rawR : rawR ? [rawR] : []
    this.renderers = rlist.map((r) => {
      const kind = (r && r.name) || 'sprite'
      // spritetrail 省略 Length 不能当 0（理想长度恒 0 → 精灵消失）。库里 23 处没写。
      // ropetrail 的 Length 是尾迹时长（秒），省略按预设常见 0.2。
      return {
        kind,
        length: num(r && r.length, kind === 'spritetrail' ? 0.1 : kind === 'ropetrail' ? 0.2 : 0),
        maxLength: num(r && r.maxlength, 0),
        minLength: num(r && r.minlength, 0),
        subdivision: num(r && r.subdivision, 1),
        // Rope Trail 段数（官方 `segments`）；与 spritetrail 的 maxlength 无关
        segments: num(r && r.segments, 0),
        orientation: (r && r.orientation) || null,
      }
    })
    if (omitted && !this.renderers.length) {
      this.renderers = [{ kind: 'sprite', length: 0, maxLength: 0, minLength: 0, subdivision: 1, segments: 0, orientation: null }]
    }
    // Sprite Trail = 沿速度转向并按速度拉伸的**一条**精灵（length×speed，min/max 夹紧）。
    // Rope Trail 才是历史折线：Length=时长，segments=采样点数；maxlength 只属于 Sprite Trail。
    const tr = this.renderers.find((r) => r.kind === 'spritetrail' || r.kind === 'ropetrail')
    this.trailCfg = tr || null
    this.trailSegments = 1
    this.trailDuration = 0
    this.trailSampleDt = 0
    if (tr && tr.kind === 'ropetrail') {
      const segs = ropeTrailHistoryCount(tr)
      this.trailSegments = segs
      this.trailDuration = ropeTrailDuration(tr)
      this.trailSampleDt = this.trailDuration / Math.max(1, segs - 1)
      for (const p of this.pool) {
        p.trail = new Float32Array(segs * 3)
        p.trailClock = 0
      }
    }
    // rope：粒子本身不是独立精灵，而是绳上的结——渲染时按发射序连成连续 ribbon。
    // 掉进默认 sprite 分支会把光束拆成一根根竖条纹（1425503532 Pac-Man）。
    this.ropeRenderer = this.renderers.find((r) => r.kind === 'rope') || null
  }

  setModel(model) {
    this.model = model
    this._compile()
  }

  setMaterial(mat) {
    this.material = mat
    const pass = mat && mat.passes && mat.passes[0]
    this.blend = (pass && pass.blending) || 'translucent'
    this.refract = particlePassRefract(mat)
    // 官方 Refract Amount（ui_editor_properties_refract_amount）：雨滴常见 0.05，
    // 水花可到 2。缺省 0.04 对齐未填常量的工坊材质。上限避免一次采样跨整屏。
    const cv = pass && pass.constantshadervalues
    const rawAmt = cv && cv.ui_editor_properties_refract_amount
    const amt = Number(rawAmt)
    this.refractAmount = Number.isFinite(amt) ? Math.min(0.35, Math.max(0, amt)) : 0.04
  }

  setNormalTexture(tex) {
    this.normalTex = tex || null
  }

  // 注入贴图 {glTex, width, height, frames?}
  // frames 为 TEXS 序列帧表（像素坐标；每帧带仿射基 uDir/vDir），有则据此切图。
  // 同时认数组（list 上挂 atlasWidth）和 {list, atlasWidth, atlasHeight}：
  // 只认 `.length` 时整对象会被当成「无帧表」，退回 sequencemultiplier 的 N×N
  // 方格，72 帧字符图集会变成 2×2 大块 —— Matrix 雨看起来字都挤成一团。
  setTexture(tex) {
    this.texture = tex
    this._ready = !!tex
    const raw = tex && tex.frames
    const list = Array.isArray(raw) ? raw : raw && raw.list && raw.list.length ? raw.list : null
    // 归一化分母：优先用帧表自带的图集尺寸（texture.js 从 mip0 取），退回贴图尺寸。
    // 不能用 .tex 头部的 textureWidth —— 1444077782 那里它是**单帧**尺寸 316x214，
    // 真实图集是 2048x1024。
    // UV 分母必须等于实际上传的贴图尺寸。atlasWidth 来自 mip0，但 decodeMip0
    // 过去会把 POT 填充裁成 TEXI 声明尺寸（matrix 72：512→450），两者不一致
    // 时采样跨到邻帧，掉落代码变成一团碎字（2974757317）。
    const denW = (tex && tex.width) || (list && ((raw && raw.atlasWidth) || list.atlasWidth)) || 0
    const denH = (tex && tex.height) || (list && ((raw && raw.atlasHeight) || list.atlasHeight)) || 0
    if (list && denW > 0 && denH > 0) {
      // 帧矩形归一化为 uv（着色器按 uvScale/uvOffset 直接采样，无需知道网格结构）
      this.texFrames = list.map((f) => ({
        ou: f.x / denW,
        ov: f.y / denH,
        su: f.width / denW,
        sv: f.height / denH,
      }))
      this.frameCount = this.texFrames.length
    } else {
      this.texFrames = null
      this.frameCount = this.sequenceMul * this.sequenceMul
    }
    // 精灵 quad 的宽高比取自**贴图（单帧）本身**：WE 的粒子精灵是带纹理比例的四边形。
    // size 控制的是精灵的**长边**，短边按贴图比例压缩：
    // 全库 72 个非方形贴图的粒子层实测，按"size=长边"只有 4% 的精灵超出屏幕 1.5 倍，
    // 按"size=短边"则有 18%（光轴会算出 36545px、雨滴 6400px 这种荒谬尺寸）。
    // 这样光轴/雨丝才是细长条：高度由 size 决定、宽度被压到 1/4。
    let aw = 1
    let ah = 1
    if (this.texFrames && list) {
      aw = list[0].width || 1
      ah = list[0].height || 1
    } else if (tex && tex.width > 0 && tex.height > 0) {
      aw = tex.width
      ah = tex.height
    }
    const longSide = Math.max(aw, ah) || 1
    this.texAspectX = aw / longSide
    this.texAspectY = ah / longSide
    this._frameData = undefined // 帧表变化时重建 uniform 缓存
  }

  setVisible(v) {
    this.visible = v
  }

  /**
   * [we-scene patch] 从图层重新读取变换（构造时也走这里）。
   *
   * 发射器变换原先只在构造时缓存一次、之后**从不刷新**。父组一旦带脚本/动画
   * 变换（全库 17 个粒子层有脚本化祖先），图层被 recomposeWorld 挪走了，
   * 粒子却仍从旧位置喷出来 —— 画面上是「人物滑走了、他的火焰留在原地」。
   * 宿主在 recompose 之后对脏子树里的粒子层调用本方法。
   */
  syncLayerTransform() {
    const layer = this.layer
    const lo = layer && layer.origin ? layer.origin : [0, 0, 0]
    const ls = layer && layer.scale ? layer.scale : [1, 1, 1]
    const la = layer && layer.angles ? layer.angles : [0, 0, 0]
    this.originX = lo[0] || 0
    this.originY = lo[1] || 0
    this.originZ = lo[2] || 0
    this.scaleX = ls[0] === 0 ? 1 : ls[0]
    this.scaleY = ls[1] === 0 ? 1 : ls[1]
    this.angleZ = ((la[2] || 0) * Math.PI) / 180
    // 精灵的非等比拉伸：WE 里图层 scale 直接作用于精灵 quad，x/y 不等时精灵被拉长。
    // 全库 92 个带 scale 的粒子层有 36 个是非等比的（如 light_shafts_1 的 22.6/12.2、
    // fog1 的 10/1、Splash 的 1/0.15），它们靠拉伸把圆形贴图变成光柱/雨丝/横向雾带。
    // 若只取平均值做等比缩放，这些系统会变成巨大的圆斑糊住半个屏幕。
    // 故：位置用 scaleX/scaleY 各自缩放，精灵尺寸取较小轴为基准、较大轴作为拉伸比。
    const asx = Math.abs(this.scaleX)
    const asy = Math.abs(this.scaleY)
    this.sysScale = Math.min(asx, asy) || 1
    // 精灵 quad 的宽高拉伸倍率（相对 sysScale）
    this.spriteStretchX = asx / this.sysScale
    this.spriteStretchY = asy / this.sysScale
  }

  // 宿主每帧提供鼠标位置（世界像素）；转到局部空间供控制点使用
  setPointer(worldX, worldY) {
    const dx = worldX - this.originX
    const dy = worldY - this.originY
    const c = Math.cos(-this.angleZ)
    const s = Math.sin(-this.angleZ)
    this.pointer = {
      x: (dx * c - dy * s) / (this.scaleX || 1),
      y: (dx * s + dy * c) / (this.scaleY || 1),
    }
  }

  // 子级挂到父系统：eventfollow 跟父粒子走，static 跟父系统 origin 走。
  attachFollow(parent, mode, offset) {
    this._followParent = parent || null
    this._followMode = mode === 'particle' || mode === 'origin' ? mode : null
    const o = offset || [0, 0, 0]
    this._followOffset = [o[0] || 0, o[1] || 0, o[2] || 0]
    // 立即对一次：否则首帧（以及 eventfollow 在父粒子尚未生成时）会停在
    // 未加 offset 的父 origin，Matrix 33 列叠成一坨。
    this._syncFollow()
  }

  leaderParticle() {
    const pool = this.pool
    for (let i = 0; i < pool.length; i++) if (pool[i].alive) return pool[i]
    return null
  }

  // 粒子局部坐标 → 世界像素（y 向下，与 originX/originY 同一空间；投影翻转在 render）
  localToWorld(lx, ly) {
    const px = lx * this.scaleX
    const py = ly * this.scaleY
    const c = Math.cos(this.angleZ)
    const s = Math.sin(this.angleZ)
    return [this.originX + px * c - py * s, this.originY + px * s + py * c]
  }

  _syncFollow() {
    const parent = this._followParent
    const mode = this._followMode
    if (!parent || !mode) return
    const off = this._followOffset
    // children.origin 是父系统局部坐标，必须走 localToWorld（含图层 scale/旋转）。
    // 以前直接加到世界 origin 上：2974757317 层 scale=1.5、43 列 × 60px 只铺了
    // 2520px，掉落代码挤在画面左侧一条带里，铺不满 3840 宽。
    if (mode === 'particle') {
      const host = parent.leaderParticle()
      if (!host) return
      const w = parent.localToWorld(host.x + off[0], host.y + off[1])
      this.originX = w[0]
      this.originY = w[1]
    } else {
      const w = parent.localToWorld(off[0], off[1])
      this.originX = w[0]
      this.originY = w[1]
    }
  }

  // ---------- 生成 ----------

  spawn(em) {
    // 线性扫描找空位在 maxcount 大时是热点；用游标做环形查找
    const pool = this.pool
    const n = pool.length
    let p = null
    let cur = this._cursor || 0
    for (let i = 0; i < n; i++) {
      const q = pool[(cur + i) % n]
      if (!q.alive) {
        p = q
        this._cursor = (cur + i + 1) % n
        break
      }
    }
    if (!p) return

    p.alive = true
    p.age = 0
    p.seed = Math.random()
    p.rot = 0
    p.rotVel = 0
    p.vx = p.vy = p.vz = 0
    p.frame = 0
    p.seq = this._seq++

    // ---- 发射位置 ----
    const o = em.origin
    if (em.kind === 'box') {
      const d = em.distanceMax || [0, 0, 0]
      const dmin = em.distanceMin
      // boxrandom：在 ±distancemax 的盒内均匀取点（distancemin 存在时作为偏移基准）
      p.x = o[0] + rand(-d[0], d[0]) + (dmin ? dmin[0] : 0)
      p.y = o[1] + rand(-d[1], d[1]) + (dmin ? dmin[1] : 0)
      p.z = o[2] + rand(-d[2], d[2]) + (dmin ? dmin[2] : 0)
    } else {
      // sphererandom：球壳内随机方向 × [distancemin, distancemax] 半径，
      // 再按 directions 各轴缩放（"1 0.03 0" = 几乎水平的一条线）
      const dir = em.directions
      const rmin = em.distanceMin ? em.distanceMin[0] : 0
      const rmax = em.distanceMax ? em.distanceMax[0] : 0
      // 球面均匀采样
      const u = Math.random() * 2 - 1
      const th = Math.random() * TAU
      const sq = Math.sqrt(Math.max(0, 1 - u * u))
      let nx = sq * Math.cos(th)
      let ny = sq * Math.sin(th)
      let nz = u
      if (em.sign) {
        // sign 非 0 的轴强制取正（半球发射）
        if (em.sign[0]) nx = Math.abs(nx) * Math.sign(em.sign[0])
        if (em.sign[1]) ny = Math.abs(ny) * Math.sign(em.sign[1])
        if (em.sign[2]) nz = Math.abs(nz) * Math.sign(em.sign[2])
      }
      const r = rand(rmin, rmax)
      p.x = o[0] + nx * r * dir[0]
      p.y = o[1] + ny * r * dir[1]
      p.z = o[2] + nz * r * dir[2]
      // 发射器自身的 speedmin/max：沿发射方向的初速
      if (em.speedMax || em.speedMin) {
        const sp = rand(em.speedMin, em.speedMax)
        p.vx += nx * sp
        p.vy += ny * sp
        p.vz += nz * sp
      }
    }

    // 发射器原点 = 控制点（缺省 CP0 = 系统原点）。CP0 锁鼠标时粒子生在光标处，
    // 已存在的粒子坐标不跟着 origin 挪 —— 这才能拖出轨迹而不是一团粘在指针上。
    {
      const emitAt = this._cpPos(em.controlPoint)
      if (emitAt) {
        p.x += emitAt[0]
        p.y += emitAt[1]
        p.z += emitAt[2]
      } else {
        const spec = this.controlPoints.find((c) => c.id === em.controlPoint)
        if (spec && spec.lockToPointer) {
          p.alive = false
          return
        }
      }
    }

    // Position around control point：绕控制点按 count 等分圆轮流投放
    if (this.init.mapAround) {
      const ma = this.init.mapAround
      const around = this._cpPos(ma.cp)
      if (around) {
        const n = ma.count
        const i = this._mapAroundSeq++
        const u = n > 0 ? (i % n) / n : 0
        const t = ma.bounds[0] + (ma.bounds[1] - ma.bounds[0]) * u
        const ang = t * TAU
        const rmin = em.distanceMin ? em.distanceMin[0] : 0
        const rmax = em.distanceMax ? em.distanceMax[0] : 0
        const rad = rmax > 0 ? rmax : rmin
        p.x = around[0] + Math.cos(ang) * rad
        p.y = around[1] + Math.sin(ang) * rad
        p.z = around[2]
        const k = Math.random()
        p.vx += ma.speedMin[0] + (ma.speedMax[0] - ma.speedMin[0]) * k
        p.vy += ma.speedMin[1] + (ma.speedMax[1] - ma.speedMin[1]) * k
        p.vz += ma.speedMin[2] + (ma.speedMax[2] - ma.speedMin[2]) * k
      }
    }

    // ---- 初始化器 ----
    const I = this.init
    const speedMul = this._ov.speed || 1
    const sizeMul = this._ov.size || 1

    p.life = I.life ? Math.max(0.001, randExp(I.life.min, I.life.max, I.life.exp) * this.lifetimeMul) : 1
    p.baseSize = I.size ? randExp(I.size.min, I.size.max, I.size.exp) * sizeMul : sizeMul
    p.size = p.baseSize

    if (I.color) {
      const mn = I.color.min
      const mx = I.color.max
      // min/max 无序（实测大量 min>max），逐分量取区间
      const t = Math.random()
      p.baseR = (mn[0] + (mx[0] - mn[0]) * t) / 255
      p.baseG = (mn[1] + (mx[1] - mn[1]) * t) / 255
      p.baseB = (mn[2] + (mx[2] - mn[2]) * t) / 255
    } else {
      p.baseR = p.baseG = p.baseB = 1
    }
    // instanceoverride 的 color/colorn 覆盖初始化器（用户属性调色）
    if (this._ov.color) {
      p.baseR = this._ov.color[0]
      p.baseG = this._ov.color[1]
      p.baseB = this._ov.color[2]
    }
    p.r = p.baseR
    p.g = p.baseG
    p.b = p.baseB

    p.baseAlpha = (I.alpha ? rand(I.alpha.min, I.alpha.max) : 1) * this.opacityMul
    p.alpha = p.baseAlpha

    if (I.velocity) {
      p.vx += rand(I.velocity.min[0], I.velocity.max[0]) * speedMul
      p.vy += rand(I.velocity.min[1], I.velocity.max[1]) * speedMul
      p.vz += rand(I.velocity.min[2], I.velocity.max[2]) * speedMul
    }
    if (I.turbulentVelocity) {
      const tv = I.turbulentVelocity
      // 音频门控：响度未过 bounds 时湍流初速不施加（spawn 时读 _step 存的响度）
      const tvK = tv.audioMode ? audioGate(tv.audioBounds, this._audioLevel || 0) : 1
      const sp = rand(tv.speedMin, tv.speedMax) * speedMul * tvK
      const t = this.simTime * (tv.timeScale || 0)
      const nv = noiseVec3(p.x * tv.scale + tv.offset, p.y * tv.scale + tv.offset, t + p.seed * (tv.phaseMax || 0), 3)
      p.vx += nv[0] * sp
      p.vy += nv[1] * sp
      p.vz += nv[2] * sp
    }
    if (I.rotation) {
      // 只用 z 分量（2D 精灵绕视线轴旋转）
      p.rot = rand(I.rotation.min[2], I.rotation.max[2])
    }
    if (I.angularVelocity) {
      p.rotVel = rand(I.angularVelocity.min[2], I.angularVelocity.max[2])
    }

    // 振荡相位/频率在生成时固化一次（每帧重取会导致抖动）
    const O = this.ops
    if (O.oscPos) {
      p.oscFreq = rand(O.oscPos.freqMin, O.oscPos.freqMax)
      p.oscAmp = rand(O.oscPos.scaleMin, O.oscPos.scaleMax)
      p.oscPhase = rand(O.oscPos.phaseMin, O.oscPos.phaseMax) + p.seed * TAU
    }
    if (O.oscAlpha) {
      p.oscAFreq = rand(O.oscAlpha.freqMin, O.oscAlpha.freqMax)
      p.oscAPhase = Math.random() * (O.oscAlpha.phaseMax || TAU)
    }
    if (O.oscSize) {
      p.oscSFreq = rand(O.oscSize.freqMin, O.oscSize.freqMax)
      p.oscSPhase = Math.random() * (O.oscSize.phaseMax || TAU)
    }
    if (O.turbulence.length) {
      const t0 = O.turbulence[0]
      p.turbSpeed = rand(t0.speedMin, t0.speedMax)
      p.turbPhase = rand(t0.phaseMin, t0.phaseMax)
    }

    // 序列帧：randomframe 随机起始帧，否则按生命进度推进
    if (this.frameCount > 1) {
      p.frame = this.animationMode === 'randomframe' ? Math.floor(Math.random() * this.frameCount) : 0
    }

    p.bx = p.x
    p.by = p.y
    p.bz = p.z
    if (p.trail) {
      // 轨迹初始化为当前位置，避免新粒子拖出一条从原点来的长尾
      for (let i = 0; i < p.trail.length; i += 3) {
        p.trail[i] = p.x
        p.trail[i + 1] = p.y
        p.trail[i + 2] = p.z
      }
      p.trailClock = 0
    }
  }

  // ---------- 每粒子更新 ----------

  updateParticle(p, dt) {
    p.age += dt
    if (p.age >= p.life) {
      p.alive = false
      return
    }
    const lt = p.age / p.life // 生命进度 0..1
    const O = this.ops

    // --- 力 / 速度 ---
    if (O.movement) {
      p.vx += O.movement.gravity[0] * dt
      p.vy += O.movement.gravity[1] * dt
      p.vz += O.movement.gravity[2] * dt
      if (O.movement.drag > 0) {
        // 指数衰减，dt 无关（线性 1-drag*dt 在大 dt 下会变成负数使速度反向）
        const d = Math.exp(-O.movement.drag * dt)
        p.vx *= d
        p.vy *= d
        p.vz *= d
      }
    }
    if (O.angularMovement) {
      p.rotVel += (O.angularMovement.force[2] || 0) * dt
      if (O.angularMovement.drag > 0) p.rotVel *= Math.exp(-O.angularMovement.drag * dt)
    }

    // 湍流：噪声场加速度（雪花飘、烟雾扰动）
    for (const t of O.turbulence) {
      const ts = t.timeScale || 1
      const nv = noiseVec3(
        p.bx * t.scale,
        p.by * t.scale,
        this.simTime * t.scale * ts + p.turbPhase,
        3
      )
      p.vx += nv[0] * p.turbSpeed * t.mask[0] * dt
      p.vy += nv[1] * p.turbSpeed * t.mask[1] * dt
      p.vz += nv[2] * p.turbSpeed * t.mask[2] * dt
    }

    // 控制点吸引/排斥（scale<0 = 排斥；threshold 是作用半径）
    for (const a of O.attract) {
      const cp = this._cpPos(a.cp)
      if (!cp) continue
      const dx = cp[0] + a.origin[0] - p.x
      const dy = cp[1] + a.origin[1] - p.y
      const dist = Math.hypot(dx, dy)
      if (dist < 1e-3) continue
      if (a.threshold > 0 && dist > a.threshold) continue
      // 力随距离衰减（1 - d/threshold），threshold 内平滑过渡到 0
      const falloff = a.threshold > 0 ? 1 - dist / a.threshold : 1
      const f = (a.scale * falloff * dt) / Math.max(1, dist)
      p.vx += dx * f
      p.vy += dy * f
    }

    // 涡流：绕轴的切向速度。中心相对控制点（缺省 CP0 = 系统原点）。
    for (const v of O.vortex) {
      const base = this._cpPos(v.cp) || [0, 0, 0]
      const dx = p.x - (base[0] + v.offset[0])
      const dy = p.y - (base[1] + v.offset[1])
      const dist = Math.hypot(dx, dy)
      if (dist < 1e-3) continue
      const span = v.distanceOuter - v.distanceInner
      const k = span > 0 ? Math.min(1, Math.max(0, (dist - v.distanceInner) / span)) : 0
      // 音频门控（_step 每帧存 _audioLevel）：响度低时涡流停转
      const vK = v.audioMode ? audioGate(v.audioBounds, this._audioLevel || 0) : 1
      const speed = v.speedInner + (v.speedOuter - v.speedInner) * k
      // 切向（绕 z 轴）
      p.vx += (-dy / dist) * speed * dt * vK
      p.vy += (dx / dist) * speed * dt * vK
    }

    // remapvalue：噪声重映射到速度/速率
    for (const rm of O.remap) {
      const s = rm.inputScale || 1
      const nv = noiseVec3(p.bx * 0.01 * s, p.by * 0.01 * s, this.simTime * 0.1, rm.fn === 'fbmnoise' ? 4 : 2)
      if (rm.output === 'velocity') {
        for (let i = 0; i < 3; i++) {
          const t = (nv[i] + 1) / 2
          const val = rm.rangeMin[i] + (rm.rangeMax[i] - rm.rangeMin[i]) * t
          if (i === 0) p.vx = val
          else if (i === 1) p.vy = val
          else p.vz = val
        }
      } else if (rm.output === 'speed') {
        const t = (nv[0] + 1) / 2
        const mul = rm.rangeMin[0] + (rm.rangeMax[0] - rm.rangeMin[0]) * t
        const len = Math.hypot(p.vx, p.vy) || 1
        p.vx = (p.vx / len) * mul
        p.vy = (p.vy / len) * mul
      }
    }

    // --- 积分 ---
    p.bx += p.vx * dt
    p.by += p.vy * dt
    p.bz += p.vz * dt
    p.rot += p.rotVel * dt

    // 振荡位移叠加在基准位置上（不回写基准，否则与运动互相累加发散）
    p.x = p.bx
    p.y = p.by
    p.z = p.bz
    if (O.oscPos) {
      const ph = this.simTime * p.oscFreq * TAU + p.oscPhase
      const m = O.oscPos.mask
      p.x += Math.sin(ph) * p.oscAmp * m[0]
      p.y += Math.cos(ph) * p.oscAmp * m[1]
      p.z += Math.sin(ph * 0.7) * p.oscAmp * m[2]
    }

    // --- 尺寸 ---
    let size = p.baseSize
    if (O.sizeChange) {
      const sc = O.sizeChange
      const span = sc.endTime - sc.startTime
      const k = span > 0 ? Math.min(1, Math.max(0, (lt - sc.startTime) / span)) : lt >= sc.startTime ? 1 : 0
      size *= sc.startValue + (sc.endValue - sc.startValue) * k
    }
    if (O.oscSize) {
      const ph = this.simTime * p.oscSFreq * TAU + p.oscSPhase
      const os = O.oscSize
      const mid = (os.scaleMin + os.scaleMax) / 2
      const amp = (os.scaleMax - os.scaleMin) / 2
      size *= mid + Math.sin(ph) * amp
    }
    p.size = size

    // --- 颜色 ---
    if (O.colorChange) {
      const cc = O.colorChange
      const span = cc.endTime - cc.startTime
      const k = span > 0 ? Math.min(1, Math.max(0, (lt - cc.startTime) / span)) : lt >= cc.startTime ? 1 : 0
      // startvalue 缺省时以粒子自身初始色为起点
      const s0 = cc.startValue || [p.baseR, p.baseG, p.baseB]
      p.r = s0[0] + (cc.endValue[0] - s0[0]) * k
      p.g = s0[1] + (cc.endValue[1] - s0[1]) * k
      p.b = s0[2] + (cc.endValue[2] - s0[2]) * k
    }

    // --- 透明度 ---
    let a = p.baseAlpha
    if (O.alphaFade) {
      // fadeintime / fadeouttime 是生命比例：[0,fadeIn] 淡入，[fadeOut,1] 淡出
      const fi = O.alphaFade.fadeIn
      const fo = O.alphaFade.fadeOut
      if (fi > 0 && lt < fi) a *= lt / fi
      if (fo < 1 && lt > fo) a *= Math.max(0, (1 - lt) / (1 - fo))
    } else if (!O.alphaChange) {
      // 无任何 alpha 算子时给一条温和的默认包络，避免粒子突然出现/消失
      if (lt < 0.1) a *= lt / 0.1
      else if (lt > 0.85) a *= (1 - lt) / 0.15
    }
    if (O.alphaChange) {
      const ac = O.alphaChange
      const span = ac.endTime - ac.startTime
      const k = span > 0 ? Math.min(1, Math.max(0, (lt - ac.startTime) / span)) : lt >= ac.startTime ? 1 : 0
      a *= ac.startValue + (ac.endValue - ac.startValue) * k
    }
    if (O.oscAlpha) {
      const ph = this.simTime * p.oscAFreq * TAU + p.oscAPhase
      const oa = O.oscAlpha
      const mid = (oa.scaleMin + oa.scaleMax) / 2
      const amp = (oa.scaleMax - oa.scaleMin) / 2
      a *= mid + Math.sin(ph) * amp
    }
    p.alpha = Math.max(0, a)

    // 序列帧推进（非 randomframe 时按生命进度走完一轮）
    if (this.frameCount > 1 && this.animationMode !== 'randomframe') {
      p.frame = Math.min(this.frameCount - 1, Math.floor(lt * this.frameCount))
    }

    // 轨迹采样：按 Rope Trail Length（秒）把当前位置推进历史环。
    // 旧实现每帧挪一格 → 尾迹时长 ≈ segments/fps；segments 还被算成 2，
    // length=0.5 的雨丝只剩两帧间距（3792881540）。
    if (p.trail) {
      const tr = p.trail
      const step = this.trailSampleDt
      if (step > 0) {
        p.trailClock = (p.trailClock || 0) + dt
        let shifts = 0
        const cap = this.trailSegments || 8
        while (p.trailClock >= step && shifts < cap) {
          p.trailClock -= step
          shifts++
          for (let i = tr.length - 3; i >= 3; i -= 3) {
            tr[i] = tr[i - 3]
            tr[i + 1] = tr[i - 2]
            tr[i + 2] = tr[i - 1]
          }
        }
      }
      // 头节点始终贴当前点，避免采样间隙里尖端停住
      tr[0] = p.x
      tr[1] = p.y
      tr[2] = p.z
    }
  }

  // 控制点当前位置（局部空间）
  _cpPos(id) {
    const cp = this.controlPoints.find((c) => c.id === id)
    if (!cp) return null
    if (cp.lockToPointer) {
      if (!this.pointer) return null
      return [this.pointer.x + cp.offset[0], this.pointer.y + cp.offset[1], cp.offset[2]]
    }
    return cp.offset
  }

  // ---------- 帧推进 ----------

  advance(dt, audio) {
    if (this.paused || !this.visible) return
    this._syncFollow()
    // starttime 预热：首帧一次性快进，让场景一打开就有稳定的粒子分布
    if (!this._warmed) {
      this._warmed = true
      if (this.startTime > 0) {
        const step = 1 / 30
        const steps = Math.min(900, Math.round(this.startTime / step))
        for (let i = 0; i < steps; i++) this._step(step)
      }
    }
    this._step(dt, audio)
  }

  _step(dt, audio) {
    this.simTime += dt
    // 音频快照：level = 整体响度 0..1（render/audio.js 的模拟频谱；离线/无音频时为 0）
    const level = audio && Number.isFinite(audio.level) ? Math.max(0, Math.min(1, audio.level)) : 0
    this._audioLevel = level
    for (const em of this.emitters) {
      // instantaneous：一次性爆发 N 个（烟花/冲击波）
      if (em.instantaneous > 0 && !em._burst) {
        em._burst = true
        for (let i = 0; i < Math.min(em.instantaneous, this.maxCount); i++) this.spawn(em)
      }
      // 无 rate 的常驻场：维持池满（粒子按 lifetime 自然回收，补充维持总量恒定）。
      // 这类发射器没有 rate 来自然限流，总量完全由 maxcount 决定，而 maxcount 是
      // 作者在编辑器里填的「预算上限」而非期望值 —— 同一个 dust_motes_0 预设在 7 个
      // 场景里都是 128，只有 2370927443 被改成 100000。WE 靠 GPU 预算实际压制它；
      // 照搬会画出近两万颗尘埃（占该场景粒子总量的 82%），既拖慢渲染又让画面糊成一片。
      // 故按同预设的常见量级封顶，更接近真实观感。
      if (em.fill) {
        const FILL_CAP = 2048
        const cap = Math.min(this.maxCount, FILL_CAP)
        let live = 0
        for (let i = 0; i < this.pool.length; i++) if (this.pool[i].alive) live++
        // 单帧补充量也设上限，避免首帧一次性生成造成明显卡顿
        let refill = Math.min(cap - live, 512)
        while (refill-- > 0) this.spawn(em)
        continue
      }
      // 音频驱动发射器（audioprocessingmode）：发射量随响度门控（smoothstep(bounds)）。
      // 有 rate 的按 rate×k 发射；无 rate 的按「池目标量 ∝ k」维持（WE 音频常驻场）。
      if (em.audioDriven) {
        const k = audioGate(em.audioBounds, level)
        if (em.rate > 0) {
          const rate = em.rate * k * (this._ov.rateMul !== undefined ? this._ov.rateMul : 1) * (this._ov.countMul !== undefined ? this._ov.countMul : 1)
          if (!(rate > 0)) continue
          em._accum = (em._accum || 0) + rate * dt
          let n = Math.floor(em._accum)
          if (n > 0) {
            em._accum -= n
            if (n > this.maxCount) n = this.maxCount
            for (let i = 0; i < n; i++) this.spawn(em)
          }
        } else {
          const FILL_CAP = 2048
          const target = Math.round(Math.min(this.maxCount, FILL_CAP) * k)
          let live = 0
          for (let i = 0; i < this.pool.length; i++) if (this.pool[i].alive) live++
          let refill = Math.min(target - live, 256)
          while (refill-- > 0) this.spawn(em)
        }
        continue
      }
      // 发射率同时受 rate 与 count 两个倍率影响（见 _applyOverride 里 count 的说明）
      const rate =
        em.rate *
        (this._ov.rateMul !== undefined ? this._ov.rateMul : 1) *
        (this._ov.countMul !== undefined ? this._ov.countMul : 1)
      if (!(rate > 0)) continue
      // 累加器必须**按发射器各存一份**：低速发射器（如光轴 rate=0.3/s）每帧只累加
      // 0.005 颗，需要几百帧才凑够 1 颗。若与其它发射器共用一个累加器，
      // 高速发射器会在每帧把整数部分取走，低速发射器的零头被反复清掉、永远发不出粒子
      // （2885492021 的光轴存活数只降不升，看起来就是"几根固定不动的光柱"）。
      em._accum = (em._accum || 0) + rate * dt
      let n = Math.floor(em._accum)
      if (n > 0) {
        em._accum -= n
        // 单帧生成上限：rate 可达 15000/s，掉帧时累积量会瞬间打满池子
        if (n > this.maxCount) n = this.maxCount
        for (let i = 0; i < n; i++) this.spawn(em)
      }
    }
    const pool = this.pool
    for (let i = 0; i < pool.length; i++) {
      if (pool[i].alive) this.updateParticle(pool[i], dt)
    }
  }

  // ---------- 渲染 ----------

  // viewProj：场景投影矩阵；projH 用于 y 翻转（世界 y 向下 → 投影空间）
  render(viewProj, width, height, projW, projH) {
    if (!this._ready || !this.visible) return
    if (!this.renderers.length) return
    const gl = this.gl
    if (!this._prog) this._buildProgram(gl)

    const trail = this.trailCfg && this.trailCfg.kind === 'ropetrail' ? this.trailCfg : null
    const spriteTrail = this.trailCfg && this.trailCfg.kind === 'spritetrail' ? this.trailCfg : null
    const rope = this.ropeRenderer
    const segs = particleInstanceSegs(this.trailCfg, this.trailSegments)
    // 每实例 14 float：pos(3) size(1) rot(1) color(4) frame(1) aspect(2) vrange(2)
    const STRIDE = 14
    const pool = this.pool
    // rope：先按发射序收集存活粒子（pool 槽位会循环复用，槽位序 ≠ 发射序）
    let order = null
    if (rope) {
      order = this._ropeOrder
      order.length = 0
      for (let i = 0; i < pool.length; i++) if (pool[i].alive) order.push(pool[i])
      order.sort((a, b) => a.seq - b.seq)
    }
    let live = 0
    if (order) live = order.length
    else for (let i = 0; i < pool.length; i++) if (pool[i].alive) live++
    if (live === 0 || (rope && live < 2)) return

    const instCount = rope ? live - 1 : live * segs
    const need = instCount * STRIDE
    if (!this._data || this._data.length < need) this._data = new Float32Array(Math.max(need, 1024))
    const data = this._data
    let k = 0

    const bright = this._ov.brightness || 1
    const sysScale = this.sysScale
    // 精灵形状 = 贴图宽高比 × 图层非等比 scale
    const stretchX = this.spriteStretchX * (this.texAspectX || 1)
    const stretchY = this.spriteStretchY * (this.texAspectY || 1)
    const cos = Math.cos(this.angleZ)
    const sin = Math.sin(this.angleZ)
    const ox = this.originX
    const oy = this.originY
    const sx = this.scaleX
    const sy = this.scaleY

    // 局部 → 世界（含图层 origin/scale/angles），再 y 翻转到投影空间
    const toWorld = (lx, ly) => {
      const px = lx * sx
      const py = ly * sy
      return [ox + px * cos - py * sin, projH - (oy + px * sin + py * cos)]
    }

    if (rope) {
      // rope：相邻发射序的两粒子连成一个拉伸段。贴图 u 横跨绳宽（横截面是
      // 「两侧亮边线 + 柔光」），v 沿绳按粒子寿命推进（v=1 是纹理亮端 = 新生端，
      // 随年龄淡到透明端）。逐段重复整张贴图会在粒子间距处出现周期性亮带。
      for (let i = 0; i + 1 < live; i++) {
        const a = order[i]
        const b = order[i + 1]
        const wa = toWorld(a.x, a.y)
        const wb = toWorld(b.x, b.y)
        const dx = wb[0] - wa[0]
        const dy = wb[1] - wa[1]
        const dist = Math.hypot(dx, dy)
        const width = (Math.abs(a.size) + Math.abs(b.size)) * 0.5 * sysScale
        if (!(width > 0)) continue
        data[k++] = (wa[0] + wb[0]) * 0.5
        data[k++] = (wa[1] + wb[1]) * 0.5
        data[k++] = 0
        data[k++] = width
        // 局部 +y 轴旋到「旧粒子 → 新粒子」方向：(0,1) 旋转后 = (-sin, cos)
        data[k++] = Math.atan2(-dx, dy)
        data[k++] = (a.r + b.r) * 0.5 * bright
        data[k++] = (a.g + b.g) * 0.5 * bright
        data[k++] = (a.b + b.b) * 0.5 * bright
        data[k++] = (a.alpha + b.alpha) * 0.5
        // 实例布局 = a_stretchFrame(stretchX, stretchY, frame) + a_vrange(v0, v1)：
        // stretchX=1（绳宽 = 粒子 size），stretchY 令 quad 长度正好盖住两粒子间距。
        // ⚠ 槽位顺序曾写反成 (frame, stretchX, stretchY) → stretchX=0 → quad 零宽
        // 全部退化（1425503532 光束整条消失）。
        data[k++] = 1
        data[k++] = dist / width
        data[k++] = 0
        // v=0 是贴图第 0 行（亮端，无翻行上传）：新生端 v≈0 亮，老年端 v→1 淡出
        data[k++] = ropeParticleV(a)
        data[k++] = ropeParticleV(b)
      }
    }
    for (let i = 0; i < pool.length && !rope; i++) {
      const p = pool[i]
      if (!p.alive) continue
      for (let s = 0; s < segs; s++) {
        let lx = p.x
        let ly = p.y
        let segAlpha = 1
        let segSize = 1
        let rot = p.rot
        let instStretchX = stretchX
        let instStretchY = stretchY
        let wx
        let wy
        if (trail && p.trail) {
          lx = p.trail[s * 3]
          ly = p.trail[s * 3 + 1]
          // 尾部越远越淡越细
          const t = segs > 1 ? s / (segs - 1) : 0
          segAlpha = 1 - t
          segSize = 1 - t * 0.55
          // 沿相邻历史点拉成丝：否则 length 秒的轨迹仍是一串分离的圆点
          let tdx = 0
          let tdy = 0
          if (s + 1 < segs) {
            tdx = p.trail[s * 3] - p.trail[(s + 1) * 3]
            tdy = p.trail[s * 3 + 1] - p.trail[(s + 1) * 3 + 1]
          } else if (s > 0) {
            tdx = p.trail[(s - 1) * 3] - p.trail[s * 3]
            tdy = p.trail[(s - 1) * 3 + 1] - p.trail[s * 3 + 1]
          } else {
            tdx = p.vx
            tdy = p.vy
          }
          const w0 = toWorld(lx, ly)
          const w1 = toWorld(lx - tdx, ly - tdy)
          const dx = w0[0] - w1[0]
          const dy = w0[1] - w1[1]
          const dist = Math.hypot(dx, dy)
          const base = Math.max(1e-3, Math.abs(p.size) * sysScale * segSize)
          if (dist > 1e-3) {
            rot = spriteTrailRotation(dx, dy)
            // 精灵中心放在段中点，沿向拉伸盖住相邻采样点间距
            wx = (w0[0] + w1[0]) * 0.5
            wy = (w0[1] + w1[1]) * 0.5
            instStretchY = Math.max(stretchY, dist / base)
          } else {
            wx = w0[0]
            wy = w0[1]
          }
        } else {
          const w = toWorld(lx, ly)
          wx = w[0]
          wy = w[1]
        }
        if (spriteTrail) {
          const w = toWorld(p.x, p.y)
          wx = w[0]
          wy = w[1]
          const w1 = toWorld(p.x + p.vx, p.y + p.vy)
          rot = spriteTrailRotation(w1[0] - w[0], w1[1] - w[1])
          const factor = spriteTrailLengthFactor(
            Math.hypot(p.vx, p.vy),
            spriteTrail.length,
            spriteTrail.minLength,
            spriteTrail.maxLength,
          )
          instStretchY = stretchY * factor
        }
        data[k++] = wx
        data[k++] = wy
        data[k++] = 0
        data[k++] = Math.abs(p.size) * sysScale * segSize
        data[k++] = rot
        data[k++] = p.r * bright
        data[k++] = p.g * bright
        data[k++] = p.b * bright
        data[k++] = p.alpha * segAlpha
        // 非等比拉伸（光柱/雨丝/雾带靠它成形），在精灵局部空间应用于旋转前
        data[k++] = instStretchX
        data[k++] = instStretchY
        data[k++] = p.frame
        data[k++] = 0
        data[k++] = 1
      }
    }

    const prog = this._prog
    gl.useProgram(prog.prog)
    gl.bindVertexArray(this._vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vbuf)
    gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, k), gl.DYNAMIC_DRAW)

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.texture.glTex)
    gl.uniform1i(prog.uniTex, 0)
    gl.uniformMatrix4fv(prog.uniMvp, false, viewProj)
    const useRefract = this.refract && this.normalTex && this.normalTex.glTex
    if (prog.uniRefract) gl.uniform1i(prog.uniRefract, useRefract ? 1 : 0)
    if (useRefract) {
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, this.normalTex.glTex)
      if (prog.uniNormal) gl.uniform1i(prog.uniNormal, 1)
      // 半透明折射才去采画面：additive 再叠一层场景色会把背景加倍冲白。
      // 画布是 alpha:false，copyTexImage2D 必须 RGB8，RGBA8 会 INVALID_OPERATION
      // 并留下全零纹理（见 renderer.js captureBackdrop）。
      const sampleScene = this.blend !== 'additive'
      if (prog.uniSampleScene) gl.uniform1i(prog.uniSampleScene, sampleScene ? 1 : 0)
      if (sampleScene) {
        const dw = gl.drawingBufferWidth || width
        const dh = gl.drawingBufferHeight || height
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        // 必须在 TEXTURE2 上绑 scene 拷贝：copyTexImage2D 写的是当前 unit，
        // 若仍停在 TEXTURE1 会把法线贴图覆盖掉。
        gl.activeTexture(gl.TEXTURE2)
        if (!this._sceneTex) {
          this._sceneTex = gl.createTexture()
          gl.bindTexture(gl.TEXTURE_2D, this._sceneTex)
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
        } else {
          gl.bindTexture(gl.TEXTURE_2D, this._sceneTex)
        }
        gl.copyTexImage2D(gl.TEXTURE_2D, 0, gl.RGB8, 0, 0, dw, dh, 0)
        if (prog.uniScene) gl.uniform1i(prog.uniScene, 2)
        if (prog.uniResolution) gl.uniform2f(prog.uniResolution, dw, dh)
        if (prog.uniRefractScale) gl.uniform1f(prog.uniRefractScale, this.refractAmount || 0.04)
      } else {
        gl.activeTexture(gl.TEXTURE2)
        gl.bindTexture(gl.TEXTURE_2D, this.texture.glTex)
        if (prog.uniScene) gl.uniform1i(prog.uniScene, 2)
      }
    } else if (prog.uniNormal) {
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, this.texture.glTex)
      gl.uniform1i(prog.uniNormal, 1)
      gl.activeTexture(gl.TEXTURE2)
      gl.bindTexture(gl.TEXTURE_2D, this.texture.glTex)
      if (prog.uniScene) gl.uniform1i(prog.uniScene, 2)
      if (prog.uniSampleScene) gl.uniform1i(prog.uniSampleScene, 0)
    }
    const fd = this._frameUniformData()
    if (fd) {
      gl.uniform1i(prog.uniFrameCount, fd.count)
      gl.uniform4fv(prog.uniFrames, fd.arr)
    } else {
      gl.uniform1i(prog.uniFrameCount, 0)
    }

    gl.enable(gl.BLEND)
    // WE 混合模式：additive 用于发光类（火花/萤火虫/光晕），translucent 是普通 alpha。
    // 贴图是非预乘的，故 alpha 混合用 (SRC_ALPHA, 1-SRC_ALPHA)；
    // additive 也要乘 SRC_ALPHA，否则透明区域会把整块贴图矩形加亮成方块。
    if (this.blend === 'additive') gl.blendFunc(gl.SRC_ALPHA, gl.ONE)
    else gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.depthMask(false)

    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, instCount)

    gl.depthMask(true)
    gl.disable(gl.BLEND)
    gl.bindVertexArray(null)
  }

  _buildProgram(gl) {
    // GPU 装配已抽至 particle-shaders.js；此处只把产物挂到实例上
    const built = buildParticleProgram(gl)
    this._quadBuf = built.quadBuf
    this._vbuf = built.vbuf
    this._vao = built.vao
    this._prog = built.prog
  }

  // 序列帧 uv 表（vec4[]：xy=offset zw=scale）。
  // 有 TEXS 用真实帧矩形；否则按 sequencemultiplier 退回 N×N 方格。
  _frameUniformData() {
    if (this._frameData !== undefined) return this._frameData
    let list = this.texFrames
    if (!list && this.sequenceMul > 1) {
      const n = this.sequenceMul
      list = []
      for (let r = 0; r < n; r++)
        for (let c = 0; c < n; c++) list.push({ ou: c / n, ov: r / n, su: 1 / n, sv: 1 / n })
    }
    if (!list || list.length === 0) {
      this._frameData = null
      return null
    }
    // 72 帧字符图集（matrix spritesheet 72）超过旧上限 64 会丢末尾字符；
    // 与 shader `u_frames[128]` 对齐。
    const cap = Math.min(list.length, 128)
    const arr = new Float32Array(cap * 4)
    for (let i = 0; i < cap; i++) {
      arr[i * 4] = list[i].ou
      arr[i * 4 + 1] = list[i].ov
      arr[i * 4 + 2] = list[i].su
      arr[i * 4 + 3] = list[i].sv
    }
    this._frameData = { count: cap, arr }
    return this._frameData
  }

  // 诊断用：当前存活粒子数
  liveCount() {
    let n = 0
    for (const p of this.pool) if (p.alive) n++
    return n
  }

  dispose() {
    this.paused = true
    const gl = this.gl
    if (!gl) return
    try {
      if (this._vbuf) gl.deleteBuffer(this._vbuf)
      if (this._quadBuf) gl.deleteBuffer(this._quadBuf)
      if (this._vao) gl.deleteVertexArray(this._vao)
      if (this._prog && this._prog.prog) gl.deleteProgram(this._prog.prog)
      if (this._sceneTex) gl.deleteTexture(this._sceneTex)
    } catch (e) {
      /* 上下文可能已丢失 */
    }
    this._prog = null
    this._vbuf = null
    this._quadBuf = null
    this._vao = null
    this._data = null
    this._sceneTex = null
  }
}
