// [we-scene patch] 粒子：CPU 模拟 + 实例化 quad（非 gl.POINTS：PointSize 上限、
// 需旋转、尺寸须随场景缩放）。局部空间模拟 → 图层变换到世界像素（y 向下）。
import { TAU, rand, randExp, parseVec, parseRandomVec, parseDist, num, audioGate, hash3, vnoise3, fbm3, noiseVec3 } from './particle-util.js'
import { buildParticleProgram } from './particle-shaders.js'
import { audioResponse } from './audio.js'

// [we-scene patch] 粒子质量倍率（性能设置面板「粒子」档）：同时缩 maxcount 上限
// 与发射率，语义与 instanceoverride 的 count 倍率一致（见 _applyOverride 注释）。
// 装配层（scene-mount）在档位切换时调 setter 并触发各系统 _applyOverride 重建池。
// 「关」档不经过这里：装配层直接跳过推进与渲染（零 CPU 模拟）。
let particleQualityScale = 1
export function setParticleQualityScale(s) {
  const n = Number(s)
  particleQualityScale = Number.isFinite(n) && n >= 0 ? n : 1
}
export function getParticleQualityScale() {
  return particleQualityScale
}

// [we-scene patch 3509806978] CPU 模拟的粒子密度上限（按质量档分级）。
// 背景：instanceoverride.count 是 WE 的「粒子数量倍率」。参考实现（linux-wallpaper
// engine 的 CParticle：rate = emitter.rate × override.rate，与 count 无关；
// Mirage：emit_speed = emitSpeed × 音频响应）里 **count 只放大池容量，从不乘进
// 发射率**——因为 count=5000 这类值若乘进 rate 会瞬间灌满整池（25/s × 5000 =
// 125000/s）。
// 本仓为支持 count<1 的「调稀」语义（Rain_secondary count=0.13 需要降密度），让
// rate 乘了 countMul——这在 count<1 时正确，但 count>1 的线性放大是密度/性能错误：
// 全库 83 个 count override 真实最大值只有 5（雨/火花），唯一离群是 3509806978
// 细节雪的 count=5000，把 360 池灌到 20000、每帧 CPU 算 fbm 湍流，稳态 2fps。
// 故对 count>1 的**发射率放大**按质量档封顶（count<1 的线性缩放原样保留）；
// 池容量另设硬上限（MAX_POOL_BY_QUALITY），只作用于「作者显式写了 count override」
// 的系统——无 override 的系统保留 20000 上限（Candles_1 maxcount=25000/rate=15000
// 是作者有意的高密度，不替它做决定）。
const MAX_POOL_BY_QUALITY = { low: 3000, medium: 6000, high: 12000 }
// rate 的 count 放大封顶（>1 时）。5 = 全库真实最大倍率（雨），雪异常值压到同档
const COUNT_RATE_MUL_CAP = { low: 3, medium: 5, high: 8 }
let particleDensityTier = 'high'
export function setParticleDensityTier(tier) {
  particleDensityTier = MAX_POOL_BY_QUALITY[tier] ? tier : 'high'
}
export function getParticleDensityTier() {
  return particleDensityTier
}

// 「维持池满」型发射器（rate 与 instantaneous 都缺省）的补充上限。这类发射器
// 的总量由 maxcount 决定，而 maxcount 常是作者的预算上限而非期望值（见 _step）。
const PARTICLE_FILL_CAP = 2048
// 同时挂在一个系统上的事件绑定发射器上限（eventspawn 的 rate/fill 型）。
// 官方每个父粒子一个子系统实例，这里共用一个池，故设个上限防病态数据爆炸。
const EVENT_BOUND_CAP = 256
// 未消费的爆发点上限（事件子级不可见时不推进，队列会一直攒）
const EVENT_BURST_QUEUE_CAP = 64

// [we-scene patch] 绘制目标/场景捕获注入（MSAA 支持）。粒子 render() 历史上
// 不绑帧缓冲，靠「上一个合成调用残留的绑定」画到画布 —— MSAA 开启后最终目标
// 变成多重采样 FBO，必须显式绑定；REFRACT 的 copyTexImage2D 也不能读多重采样
// 缓冲，改由 renderer 的 captureBackdrop（内部带 MSAA blit 分支）代抓。
// 两个 provider 都由装配层注入；未注入时（离线 verifier 等）保持原行为。
let particleFrameTargetProvider = null
export function setParticleFrameTargetProvider(fn) {
  particleFrameTargetProvider = typeof fn === 'function' ? fn : null
}
let particleSceneCaptureFn = null
export function setParticleSceneCapture(fn) {
  particleSceneCaptureFn = typeof fn === 'function' ? fn : null
}
function bindParticleFrameTarget(gl) {
  const t = particleFrameTargetProvider ? particleFrameTargetProvider() : null
  gl.bindFramebuffer(gl.FRAMEBUFFER, t || null)
}

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
 * Sprite Trail 的沿向倍率 —— 官方 `ComputeParticleTrailTangents`：
 *     up = v̂ × clamp(|v| × g_RenderVar0.x[Length], g_RenderVar0.z, g_RenderVar0.y[MaxLength])
 * 而 `g_RenderVar0.z` 是 **segment UV 时间偏移（恒 0）**，不是 minlength：
 * Mirage 的 `ParticleRender` 结构里只有 length / maxlength / subdivision / segments，
 * **没有 minlength 字段**（作者写进 JSON 的 `minlength` 官方直接忽略）。
 * 旧实现把它当下限夹紧 → 3801012392 两条雨丝速度低时会比官方长。
 * 故这里只夹 [0, maxLength]；Max Length 缺省 0 = 不设上限（保持既有约定）。
 */
export function spriteTrailLengthFactor(speed, length, minLength, maxLength) {
  let f = Math.abs(Number(speed) || 0) * (Number(length) || 0)
  const mx = Number(maxLength) || 0
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
    this.rotX = 0
    this.rotY = 0
    this.rotVelX = 0
    this.rotVelY = 0
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
    // 质量倍率与 _applyOverride 里同一处数学保持一致（构造路径无 override 时的初始池）
    this.maxCount = Math.max(1, Math.min(20000, num(this.model.maxcount, 100) * particleQualityScale))
    // 发射累加器改为按发射器各存一份（见 _step），此字段仅保留以防外部引用
    this.simTime = 0
    this.paused = false
    this.texture = null
    this.normalTex = null
    this.material = null
    this.blend = 'translucent'
    this.refract = false
    this.refractAmount = 0.05
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
    // [we-scene patch] 序列帧**帧间交叉淡入**：官方在 animationmode==SEQUENCE 且
    // 模型 flags 的 `spritenoframeblending`(bit1=2) 未置位时开启 SPRITESHEETBLEND
    // （SceneCompiler.cpp:4535），frag 里 `mix(frame, nextFrame, frac(lifetime*numFrames))`。
    // 硬切会让快速动画的精灵「跳帧」发顿；全库粒子模型绝大多数没写 flags → 默认开。
    this.frameBlend = (num(model.flags, 0) & 2) === 0
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
    // 事件子发射器（children.type = eventspawn / eventdeath）：本系统的**发射**
    // 完全由父粒子的事件驱动，不再「装配即自播」（见 attachEventParent）。
    this._eventParent = null
    this._eventType = null // 'eventspawn' | 'eventdeath'
    this._eventOffset = null // children.origin：本系统在父局部空间的站位
    this._eventChildren = [] // 反向引用：本系统自己的事件子级
    this._burstQueue = [] // 待爆发点（本系统局部空间），父事件当帧入队、次帧消费
    this._bound = [] // eventspawn 的 rate / 「维持池满」发射器：随父粒子存续
    // 存活计数（O(1) 判池满）：spawn 在池满时环形扫描一次是 O(池容量)，
    // 8500 颗的烟花爆发在池满后每次要扫 12000 槽 × 8500 次 = 100M 次运算，
    // 会在爆发帧卡住主线程。死亡点只此一处（updateParticle）、出生点只此一处。
    this._aliveCount = 0
    this._poolGen = 0 // 池重建代数：绑定项靠它识别「父粒子已随重置作废」
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

  /**
   * [we-scene patch] 逐帧写归一化颜色（instanceoverride.colorn 的 {script}，
   * 音频驱动粒子变色）。_ov.color 只在 spawn 时作为新粒子基色（见 _compile 的
   * color 初始化器），逐帧更新只影响之后出生的粒子——这正是 WE 语义（节拍变色
   * 时新粒子换新色、已存在粒子保持出生色）。与 _applyOverride 不同，不重建
   * pool（每帧重建会把全部存活粒子清空）。
   */
  setColorOverride(rgb) {
    const a = Array.isArray(rgb) ? rgb : [rgb?.x || 0, rgb?.y || 0, rgb?.z || 0]
    this._ov.color = [Number(a[0]) || 0, Number(a[1]) || 0, Number(a[2]) || 0]
  }

  /**
   * [we-scene patch] 关键帧动画的逐帧写回：与 _applyOverride（快照应用，重建
   * pool/编译参数）不同，这条只改对应倍率、不动任何重资源 —— 3233141951 龙烟
   * alpha 的 900 帧曲线（帧 608-830 掉到 0.01）每帧都要写一次，走
   * _applyOverride 会把 pool 每帧清空、粒子全灭。全库 4 处 override 动画
   * 目前都是 alpha；热更 reapplyOverride 的快照值最多维持一帧即被动画覆盖。
   */
  setOverrideValue(key, v) {
    const n = Number(v)
    if (!Number.isFinite(n)) return
    if (key === 'alpha') this.opacityMul = n
    else if (key === 'count') this._ov.countMul = n
    else if (key === 'size') this._ov.size = n
    else if (key === 'rate') this._ov.rateMul = n
    else if (key === 'speed') this._ov.speed = n
    else if (key === 'lifetime') this.lifetimeMul = n
    else if (key === 'brightness') this._ov.brightness = n
    else this._ov[key] = n
  }

  _applyOverride() {
    // 重新应用前清掉上次的倍率，避免旧键残留（热更去掉某个 override 字段时）
    this._ov = {}
    this.opacityMul = 1
    this.lifetimeMul = 1
    // 粒子质量倍率（性能档位）：折进 maxcount 与 countMul 两处，与 count override
    // 同数学 —— 上限与发射率同比例缩，稳态密度才真的降（见下方 count 分支注释）。
    this.maxCount = Math.max(1, Math.min(20000, num(this.model.maxcount, 100) * particleQualityScale))
    const ov = this.override || {}
    for (const k of Object.keys(ov)) {
      if (k === 'id') continue
      const raw = ov[k]
      const val = raw && typeof raw === 'object' && 'value' in raw ? raw.value : raw
      if (k === 'count') {
        // count 是 WE 的「粒子数量倍率」。两件事要分开：
        // 1) 池容量（maxCount）：按 base × count × 质量倍率放大，但带 CPU 硬上限。
        //    全库真实 count ∈ [0.05, 5]（83 处 override），3509806978 的 5000 是
        //    唯一离群值。有 count override 的系统按密度档封顶池容量。
        // 2) 发射率倍率（_ov.countMul）：稳态存活 ≈ rate × lifetime，不缩 rate 的话
        //    调小 count 密度不变（见下方 Rain_secondary 实测）。但参考实现
        //    （lwe / Mirage）里 count 从不乘 rate——因为 count>1 线性放大 rate 会把
        //    25/s 的雪炸成 125000/s。故：
        //      • count ≤ 1：rate 线性缩放（调稀语义，Rain_secondary=0.13 需要它）；
        //      • count > 1：rate 放大按密度档封顶（雨 count=5 落在 high 档 8 内，
        //        观感零回归；雪 count=5000 压到 8 → 稳态 ~2800 而非填满 20000）。
        const base = num(this.model.maxcount, 100)
        const mul = Number(val)
        const countMul = Number.isFinite(mul) ? mul : 1
        const poolCap = MAX_POOL_BY_QUALITY[particleDensityTier]
        this.maxCount = Math.max(
          1,
          Math.min(poolCap, Math.round(base * countMul * particleQualityScale)),
        )
        const rateCap = COUNT_RATE_MUL_CAP[particleDensityTier]
        const effective = countMul <= 1 ? countMul : Math.min(countMul, rateCap)
        this._ov.countMul = effective * particleQualityScale
        // 保留未封顶的原始倍率供诊断
        this._ov.countRaw = countMul
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
    // 池已换成全新的（全死）粒子：存活计数归零，代数 +1 让仍在别处的
    // 绑定项（eventspawn 挂到本系统粒子上的发射器）识别出父粒子已作废。
    this._aliveCount = 0
    this._poolGen = (this._poolGen || 0) + 1
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
      // 但带 audioprocessingmode 的发射器例外：它的发射量由系统音频驱动，
      // 静音时 WE 的发射量趋近 0（_step 里按 audio.level 门控；无音频输入时恒 0）。
      // 若按「维持池满」处理，会把音频响应的星星填满并叠成一片过曝
      // （2419444134 的 reactive Stars 实测 15% 像素过曝）。故静音时按不发射处理。
      audioDriven: e.audioprocessingmode !== undefined,
      // audioprocessingbounds：发射量随响度平滑门控的区间。
      // 默认 (0.8,1.0) 对齐官方 ObjectParser.cpp 的 emitter 默认（不是操作器的
      // (0,1)）：省略 bounds 的音频发射器（3669623379 光束 light_shafts_0、
      // 3299228616 Star_*）只在强拍发射，用 (0,1) 会退化成几乎常发。
      audioBounds: parseVec(e.audioprocessingbounds, [0.8, 1.0]),
      // 与 shader 的 CreateAudioResponse 同源（mode: 0 关/1 左/2 右/3 双，
      // 频段平均 → smoothstep(bounds) → pow(exponent)）。官方 emitter 默认
      // exponent=2、freqStart=0、freqEnd=1。作者显式给的 frequencystart/end
      // 必须生效——3669623379 光束指定 1..15（剔除底鼓 band0），此前一律用
      // 整体 level，频段配置被静默丢弃。
      audioMode: num(e.audioprocessingmode, 0),
      audioExponent: num(e.audioprocessingexponent, 2),
      audioFreqStart: num(e.audioprocessingfrequencystart, 0),
      audioFreqEnd: num(e.audioprocessingfrequencyend, 1),
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
          // WE 的 colorrandom 是 0–255；min/max 不保证有序（实测大量 min>max）。
          // 缺省是 (0,0,0)..(255,255,255)（官方 VecRandom 默认全 0，由调用方补满）
          this.init.color = {
            min: parseRandomVec(z.min) || [0, 0, 0],
            max: parseRandomVec(z.max) || [255, 255, 255],
          }
          break
        case 'alpharandom':
          this.init.alpha = { min: num(z.min, 1), max: num(z.max, 1) }
          break
        case 'velocityrandom':
          // 官方默认 min[0]=min[1]=-32、max[0]=max[1]=32（z 恒 0），再按 VecRandom 语义读
          this.init.velocity = {
            min: parseRandomVec(z.min) || [-32, -32, 0],
            max: parseRandomVec(z.max) || [32, 32, 0],
          }
          break
        case 'rotationrandom':
          // 官方：先 `r.max[2] = TAU` 再读 —— 标量 min/max 会把 z **归零**（只留 x），
          // 只有 max 缺键才保留「绕 z 随机一圈」。1199910952 的光轴写的正是标量
          // （min -0.4 / max -0.3）＝绕 x 侧倾 ±0.35，不是三轴一起转。
          this.init.rotation = {
            min: parseRandomVec(z.min) || [0, 0, 0],
            max: parseRandomVec(z.max) || [0, 0, TAU],
            exp: num(z.exponent, 1),
          }
          break
        case 'angularvelocityrandom':
          // 官方：先 `r.min[2] = -5; r.max[2] = 5` 再读
          this.init.angularVelocity = {
            min: parseRandomVec(z.min) || [0, 0, -5],
            max: parseRandomVec(z.max) || [0, 0, 5],
            exp: num(z.exponent, 1),
          }
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
    // 官方 Refract Amount（ui_editor_properties_refract_amount）：common_particles.h 的
    // uniform 声明是 `default 0.05, range [-1,1]` —— 缺省 0.05、允许负值（反向扰动）。
    // 旧实现缺省 0.04 且把上限钳到 0.35（会悄悄改掉作者写的 2 之类的大值）。
    const cv = pass && pass.constantshadervalues
    const rawAmt = cv && cv.ui_editor_properties_refract_amount
    const amt = Number(rawAmt)
    this.refractAmount = Number.isFinite(amt) ? Math.min(1, Math.max(-1, amt)) : 0.05
    // 官方 Overbright（ui_editor_properties_overbright）：乘在精灵 RGB 上的亮度
    // 系数，编辑器滑条缺省 1。此前整个键被静默丢弃 → 等效恒 1.0，3151551777 的
    // Bokeh 光斑材质写了 0.25，渲染出来亮 4 倍，additive 大光斑糊住整个画面。
    // 注意 Number(null)=0：键缺失时必须显式落缺省 1，不能走 Number()。
    const rawOb = cv ? cv.ui_editor_properties_overbright : undefined
    const ob = Number(rawOb)
    this.overbright = rawOb == null || !Number.isFinite(ob) ? 1 : Math.max(0, ob)
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
    // [we-scene patch] 精灵 quad 的尺寸/宽高比**按官方公式**
    // （assets/shaders/common_particles.h::ComputeParticlePosition）：
    //     quad 宽 = size × 0.5
    //     quad 高 = size × 0.5 × (帧高 / 帧宽)
    // 即 `size` 是「两倍精灵宽度」，高度只由**帧**的高宽比拉伸（SPRITESHEET 时用
    // 帧的高宽比，否则用贴图的高宽比）。旧实现把 size 当**长边**（宽 = size×w/long、
    // 高 = size×h/long）：方形贴图会大 2 倍、竖长贴图反而小 2 倍 —— 与 Mirage 出帧
    // 逐帧对照时「我们的粒子又大又糊」（halo/雾/光斑尤其明显）就是这个。
    // size 本体一个字都不改（sim 与 WE 的 sizerandom 同语义），只改 quad 映射。
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
    this.texAspectX = 0.5
    this.texAspectY = 0.5 * ((ah || 1) / (aw || 1))
    // 保留：TEXS / 贴图单帧的长边（诊断与旧判据读它；不再参与尺寸换算）
    this.frameLongPx = longSide
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
    // [we-scene patch] 图层 scale **一律**乘进精灵尺寸（官方：粒子位置与 quad 都过
    // 图层 model matrix，等比也一样）。旧实现只对非等比图层乘 min(|sx|,|sy|)、等比图层
    // 恒 1（当时为 3226487183 代码雨「50px 字 × 1.476 = 74px 与列距 74px 叠住」加的
    // 保险）—— 但那正是 WE 的行为：作者按放大后的结果排的版，我们必须跟上。
    // 非等比时仍拆成「等比部分进 sysScale、差值进 spriteStretch」，与 model matrix 等价。
    const asx = Math.abs(this.scaleX)
    const asy = Math.abs(this.scaleY)
    this.sysScale = Math.min(asx, asy) || 1
    this.spriteStretchX = asx / this.sysScale
    this.spriteStretchY = asy / this.sysScale
  }

  /**
   * [we-scene patch] Mirage 对象视差的渲染偏移（cameraparallax 场景级 × parallaxDepth）。
   * 粒子层不走 layerModelMatrix（渲染回调直传 cam/viewProj），视差偏移由宿主每帧
   * 按共享公式（math.js mirageParallaxOffset）算好后注入，render 输出时整体平移——
   * 只动绘制位置，已发射粒子的模拟坐标不变（视差是相机效果，不改粒子运动）。
   */
  setParallaxOffset(x, y) {
    this.parallaxX = Number(x) || 0
    this.parallaxY = Number(y) || 0
  }

  // 宿主每帧提供鼠标位置（世界像素）；转到局部空间供控制点使用
  setPointer(worldX, worldY) {
    const l = this.worldToLocal(worldX, worldY)
    this.pointer = { x: l[0], y: l[1] }
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

  /**
   * [we-scene patch] 挂成某个粒子系统的**事件子发射器**。
   *
   * WE 语义（ObjectParser 的 `children.type`，见 OWE ParticleRuntime / Mirage
   * SceneCompiler 的 SpawnType）：子级不是「装配即自播的独立系统」，而是由父粒子的
   * 事件临时创建的实例 —— `eventspawn` 在父粒子**生成**时、`eventdeath` 在父粒子
   * **死亡**时各建一个，位置取父粒子当时的世界坐标（SpawnChild → FollowWorldPosition）。
   * 本仓此前按独立系统处理（README 旧文），于是子级只在装配首帧于**图层 origin**
   * 爆发一次、此后再不出现：2131872317 三层烟花共 7 个 eventdeath 子级，8500 颗的
   * 爆开、闪光 flare 与冲击波 distort 全都不见了（升空的火箭死了却什么都不炸）。
   *
   * offset = `children.origin`（父系统局部坐标）：本系统与父同图层变换、外加这个站位。
   */
  attachEventParent(parent, type, offset) {
    if (!parent || (type !== 'eventdeath' && type !== 'eventspawn')) return
    const o = offset || [0, 0, 0]
    this._eventParent = parent
    this._eventType = type
    this._eventOffset = [o[0] || 0, o[1] || 0, o[2] || 0]
    if (!parent._eventChildren.includes(this)) parent._eventChildren.push(this)
    this._syncEventOrigin()
  }

  // 事件子级的坐标系跟着父图层走（父层被脚本/动画挪走时子级不能留在原地）
  _syncEventOrigin() {
    const parent = this._eventParent
    if (!parent || !this._eventOffset) return
    const w = parent.localToWorld(this._eventOffset[0], this._eventOffset[1])
    this.originX = w[0]
    this.originY = w[1]
  }

  // 粒子局部坐标 → 世界像素（y 向下，与 originX/originY 同一空间；投影翻转在 render）
  localToWorld(lx, ly) {
    const px = lx * this.scaleX
    const py = ly * this.scaleY
    const c = Math.cos(this.angleZ)
    const s = Math.sin(this.angleZ)
    return [this.originX + px * c - py * s, this.originY + px * s + py * c]
  }

  // localToWorld 的逆（与 setPointer 同一段数学）：世界像素 → 本系统局部坐标
  worldToLocal(wx, wy) {
    const dx = wx - this.originX
    const dy = wy - this.originY
    const c = Math.cos(-this.angleZ)
    const s = Math.sin(-this.angleZ)
    return [(dx * c - dy * s) / (this.scaleX || 1), (dx * s + dy * c) / (this.scaleY || 1)]
  }

  /**
   * 父粒子事件回调（kind: 'spawn' | 'death'）。
   * 位置一律「父局部 → 世界 → 本系统局部」走两端变换，而不是直接抄父坐标：
   * 子级可能带自己的 children.origin / scale / angles。
   */
  onParentEvent(kind, parent, particle, wx, wy, wz) {
    // 事件到达时先对齐坐标系：父层可能刚被脚本/关键帧挪过（本系统上一帧的同步已过期）
    this._syncEventOrigin()
    const l = this.worldToLocal(wx, wy)
    const q = this._burstQueue
    if (q.length >= EVENT_BURST_QUEUE_CAP) q.shift()
    q.push([l[0], l[1], wz])
    if (kind !== 'spawn') return
    // rate / 「维持池满」型发射器：官方每个父粒子一个实例，实例随父粒子存续 ——
    // 发射位置每帧取父粒子当前位置（雨滴溅起的水花跟着雨滴走）。
    for (const em of this.emitters) {
      // 已用 instantaneous 爆发过的发射器不再挂绑定：官方是「实例 + 各自发射器」，
      // 两者可以并存，但全库 43 个事件子级里没有这种写法（有 rate 的都是纯 rate 型）
      if (em.instantaneous > 0) continue
      if (!(em.rate > 0) && !em.fill) continue
      if (this._bound.length >= EVENT_BOUND_CAP) break
      this._bound.push({
        em,
        parent,
        particle,
        seq: particle.seq,
        poolGen: parent._poolGen,
        pos: [l[0], l[1], wz],
        accum: 0,
        parts: [], // fill 型的配额追踪（只存本实例发出的粒子）
        cap: em.fill ? Math.min(this.maxCount, PARTICLE_FILL_CAP) : 0,
      })
    }
  }

  // 通知本系统的事件子级（父粒子出生/死亡）。无子级时是一次数组长度判断。
  _notifyChildren(kind, p) {
    const kids = this._eventChildren
    if (!kids.length) return
    const w = this.localToWorld(p.x, p.y)
    for (const c of kids) {
      if (kind === 'death' ? c._eventType !== 'eventdeath' : c._eventType !== 'eventspawn') continue
      c.onParentEvent(kind, this, p, w[0], w[1], p.z)
    }
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


  /**
   * @param em 发射器
   * @param at 可选的发射基点（本系统局部坐标）：事件子级在父粒子的事件点爆发时用，
   *           叠加在 emitter.origin 之外（与 official 的实例位置 = 父粒子世界坐标一致）。
   * @returns 生成的粒子，池满时 null
   */
  spawn(em, at) {
    // 池满直接返回：环形扫描一次是 O(池容量)，爆发 8500 颗而池只有 12000 槽时，
    // 后面的每一颗都要白扫一遍全池（见 _aliveCount 注释）。
    if (this._aliveCount >= this.pool.length) return null
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
    if (!p) return null

    p.alive = true
    p.age = 0
    p.seed = Math.random()
    p.rot = 0
    p.rotVel = 0
    p.rotX = 0
    p.rotY = 0
    p.rotVelX = 0
    p.rotVelY = 0
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

    // 事件子级的爆发基点（父粒子的事件位置）叠加在发射器位置之上。
    // 放在 mapAround 之后：那一支是**覆写** p.x/y/z，不是叠加。
    if (at) {
      p.x += at[0]
      p.y += at[1]
      p.z += at[2]
    }

    // ---- 初始化器 ----
    const I = this.init
    const speedMul = this._ov.speed || 1
    const sizeMul = this._ov.size || 1

    p.life = I.life ? Math.max(0.001, randExp(I.life.min, I.life.max, I.life.exp) * this.lifetimeMul) : 1
    // 无 sizerandom 时官方默认 size=20（Domain/Scene/World.cppm 的 Particle::size），
    // 旧实现落 1 → 这些系统（441 个模型里的 3 个）精灵小 20 倍。
    p.baseSize = I.size ? randExp(I.size.min, I.size.max, I.size.exp) * sizeMul : 20 * sizeMul
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
    // [we-scene patch] rotation / angularvelocity 都是 **vec3**：官方 ComputeParticleTangents
    // 用 rotation.xyz 建旋转基（Rz·Rx·Ry），x/y 分量是「精灵朝屏幕里侧倾」——正交投影下
    // 表现为对应轴按 cos 压缩。全库 51/703 个粒子模型写了 x/y（lightshafts 的三轴
    // rotationrandom、leaves5…），旧实现只取 [2] 让这些精灵的侧倾完全没体现。
    if (I.rotation) {
      p.rotX = randExp(I.rotation.min[0], I.rotation.max[0], I.rotation.exp)
      p.rotY = randExp(I.rotation.min[1], I.rotation.max[1], I.rotation.exp)
      p.rot = randExp(I.rotation.min[2], I.rotation.max[2], I.rotation.exp)
    }
    if (I.angularVelocity) {
      p.rotVelX = randExp(I.angularVelocity.min[0], I.angularVelocity.max[0], I.angularVelocity.exp)
      p.rotVelY = randExp(I.angularVelocity.min[1], I.angularVelocity.max[1], I.angularVelocity.exp)
      p.rotVel = randExp(I.angularVelocity.min[2], I.angularVelocity.max[2], I.angularVelocity.exp)
    }
    // 官方 override：`p.angularVelocity *= modifiers.Speed()`（三轴同乘）
    p.rotVelX *= speedMul
    p.rotVelY *= speedMul
    p.rotVel *= speedMul

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
    p.frameB = p.frame
    p.frameMix = 0

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

    this._aliveCount++
    // eventspawn 子级：父粒子**生成**即触发（位置 = 父粒子出生点，见 onParentEvent）
    if (this._eventChildren.length) this._notifyChildren('spawn', p)
    return p
  }


  updateParticle(p, dt) {
    p.age += dt
    if (p.age >= p.life) {
      // eventdeath 子级：在父粒子**死亡点**爆发（位置要趁 p 还没被回收时取）
      if (this._eventChildren.length) this._notifyChildren('death', p)
      p.alive = false
      this._aliveCount--
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
      // 官方 angularmovement：`acc = DragForce(GetAngular(p), drag) + force`（DragForce = -v*drag）
      // 再 `AngularAccelerate(acc, dt)`（= angularVelocity += acc*dt）。三轴同式；
      // 旧实现只做 z，且用 exp(-drag*dt) 近似（Euler 与指数衰减在小 dt 下差别极小）。
      const f = O.angularMovement.force
      const drag = O.angularMovement.drag || 0
      p.rotVelX += (-p.rotVelX * drag + (f[0] || 0)) * dt
      p.rotVelY += (-p.rotVelY * drag + (f[1] || 0)) * dt
      p.rotVel += (-p.rotVel * drag + (f[2] || 0)) * dt
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
    p.rotX += p.rotVelX * dt
    p.rotY += p.rotVelY * dt
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

    // 序列帧推进（非 randomframe 时按生命进度走完一轮）。
    // [we-scene patch] 同时给出**下一帧与混合权重**（官方 ComputeSpriteFrame：
    // currentFrame = floor(lifetime*numFrames)、nextFrame = min(n-1, cur+1)、
    // frameBlend = frac(lifetime*numFrames)），帧间连续过渡而不是硬切。
    if (this.frameCount > 1 && this.animationMode !== 'randomframe') {
      const ff = lt * this.frameCount
      const a = Math.min(this.frameCount - 1, Math.floor(ff))
      p.frame = a
      p.frameB = Math.min(this.frameCount - 1, a + 1)
      p.frameMix = this.frameBlend ? Math.min(1, Math.max(0, ff - a)) : 0
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


  advance(dt, audio) {
    if (this.paused || !this.visible) return
    this._syncFollow()
    // starttime 预热：首帧一次性快进，让场景一打开就有稳定的粒子分布
    if (!this._warmed) {
      this._warmed = true
      if (this.startTime > 0) {
        const step = 1 / 30
        const wantSteps = Math.min(900, Math.round(this.startTime / step))
        // [we-scene patch 3509806978] 预热步数必须按池规模设预算，不能对
        // maxCount=20000 的系统也跑满 450 步。starttime=15 的「细节雪」被
        // instanceoverride.count=5000 放大到 360×5000（截断 20000）后，450 步
        // 每步都线性扫全池（fill 的存活计数 + spawn 环形查找 + update 全量），
        // 单次 advance 实测 56.6s，4 个雪系统串行把首帧推到 145s，整个测试台卡死。
        // 实测雪系统只需 ~25 步（0.8s 模拟）就到稳态满池（lifetime 8~20s +
        // rate=25×countMul），多跑的步数纯属重复扫池。预算口径 = 步数×池规模，
        // 上限取 2.4e5「粒子步」：
        //   - 常规系统（池 ≤ 800）：wantSteps 不变，预热完整（观感零回归）；
        //   - 巨型池（20000）：压到 12 步（≈0.4s 模拟），单系统预热亚秒级；
        //   - 中间规模线性插值。
        // 巨型池通常伴生巨大的 countMul（雪被 instanceoverride.count=5000 放大），
        // 其发射率同样被放大，12 步内生成量已足以铺满；少跑的只是「确认稳态」的
        // 冗余扫池。正确性不受影响——最终粒子分布由 spawn/update 决定。
        const PARTICLE_STEP_BUDGET = 240_000
        const stepsByBudget = Math.max(1, Math.floor(PARTICLE_STEP_BUDGET / Math.max(1, this.maxCount)))
        const steps = Math.min(wantSteps, stepsByBudget)
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
    // 事件子级（eventspawn / eventdeath）的发射完全由父粒子事件驱动，走不了下面的
    // 自动分支 —— 自动分支会让它在装配首帧于图层 origin 白爆一次
    //（2131872317 的三个烟花的 8500 颗爆开此前就是「开局闪一下、之后再无」）。
    if (this._eventParent) {
      this._stepEventChild(dt)
    } else for (const em of this.emitters) {
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
        const cap = Math.min(this.maxCount, PARTICLE_FILL_CAP)
        const live = this._aliveCount
        // 单帧补充量也设上限，避免首帧一次性生成造成明显卡顿
        let refill = Math.min(cap - live, 512)
        while (refill-- > 0) this.spawn(em)
        continue
      }
      // 音频驱动发射器（audioprocessingmode）：发射量随响度门控（smoothstep(bounds)）。
      // 有 rate 的按 rate×k 发射；无 rate 的按「池目标量 ∝ k」维持（WE 音频常驻场）。
      if (em.audioDriven) {
        // 优先走与 shader CreateAudioResponse 同源的频段响应（mode/频段/bounds/
        // exponent）；快照没带频段数组（离线合成 audio 只给 level）时退回整体响度门控。
        let k
        if (audio && (audio.left16 || audio.right16)) {
          k = audioResponse(
            { left: audio.left16, right: audio.right16 },
            em.audioMode, em.audioFreqStart, em.audioFreqEnd,
            em.audioBounds, em.audioExponent, 1,
          )
        } else {
          k = audioGate(em.audioBounds, level)
        }
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
          const target = Math.round(Math.min(this.maxCount, PARTICLE_FILL_CAP) * k)
          const live = this._aliveCount
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

  /**
   * 事件子级的发射：只做两件事 —— 消费父粒子事件排下的爆发点，推进挂在父粒子上
   * 的 rate / 「维持池满」发射器。两者的位置都是**父粒子的当前位置**。
   */
  _stepEventChild(dt) {
    // 本系统坐标系跟着父图层走（父层被脚本/动画挪走时子级不能留在原地）
    this._syncEventOrigin()
    const q = this._burstQueue
    if (q.length) {
      this._burstQueue = []
      for (const at of q) this._burstAt(at)
    }
    if (!this._bound.length) return
    const keep = []
    for (const b of this._bound) {
      const p = b.particle
      // 父粒子已死、槽位被复用（seq 变了），或父系统重建过池（代数变了）→ 释放
      if (!p.alive || p.seq !== b.seq || b.parent._poolGen !== b.poolGen) continue
      const w = b.parent.localToWorld(p.x, p.y)
      const l = this.worldToLocal(w[0], w[1])
      b.pos[0] = l[0]
      b.pos[1] = l[1]
      b.pos[2] = p.z
      this._emitBound(b, dt)
      keep.push(b)
    }
    this._bound = keep
  }

  // 在指定基点（本系统局部坐标）爆发：该发射器的 instantaneous 颗全放出去
  _burstAt(at) {
    for (const em of this.emitters) {
      if (!(em.instantaneous > 0)) continue
      const n = Math.min(em.instantaneous, this.maxCount)
      for (let i = 0; i < n; i++) if (!this.spawn(em, at)) break
    }
  }

  _emitBound(b, dt) {
    const em = b.em
    if (b.cap > 0) {
      // 「维持池满」型（无 rate / instantaneous）：官方每个父粒子一个实例、各自一份池，
      // 故配额按**本实例**算，父粒子一死就释放（Shooting Star 的 Flare 就是这样
      // 挂在流星头上的一团光晕）。
      let live = 0
      const keep = []
      for (const e of b.parts) {
        if (e.p.alive && e.p.seq === e.seq) {
          live++
          keep.push(e)
        }
      }
      b.parts = keep
      let want = Math.min(b.cap - live, 32)
      while (want-- > 0) {
        const p = this.spawn(em, b.pos)
        if (!p) break
        b.parts.push({ p, seq: p.seq })
      }
      return
    }
    const mul =
      (this._ov.rateMul !== undefined ? this._ov.rateMul : 1) *
      (this._ov.countMul !== undefined ? this._ov.countMul : 1)
    const rate = em.rate * mul
    if (!(rate > 0)) return
    b.accum = (b.accum || 0) + rate * dt
    let n = Math.floor(b.accum)
    if (n <= 0) return
    b.accum -= n
    if (n > this.maxCount) n = this.maxCount
    for (let i = 0; i < n; i++) if (!this.spawn(em, b.pos)) break
  }


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
    // 每实例 18 float：pos(3) size(1) rot(1) color(4) frame(1) aspect(2) vrange(2)
    //                   frameB+mix(2) rotX+rotY(2)
    const STRIDE = 18
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

    const bright = (this._ov.brightness || 1) * (this.overbright ?? 1)
    const sysScale = this.sysScale
    // [we-scene patch] 官方公式下 size=100 对 50×50 帧自然得到 50px 宽（100×0.5），
    // 旧实现需要一条「80~120 → 帧长边百分比」的补偿 hack 才等价，已在 quad 映射里
    // 一次性解决（见 setTexture 的 texAspect）。此处只保留图层缩放。
    const sizePx = (s) => Math.abs(s) * sysScale
    // 精灵形状 = 贴图宽高比 × 图层非等比 scale
    const stretchX = this.spriteStretchX * (this.texAspectX || 1)
    const stretchY = this.spriteStretchY * (this.texAspectY || 1)
    const cos = Math.cos(this.angleZ)
    const sin = Math.sin(this.angleZ)
    const ox = this.originX + (this.parallaxX || 0)
    const oy = this.originY + (this.parallaxY || 0)
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
        const width = (sizePx(a.size) + sizePx(b.size)) * 0.5
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
        // 帧间混合槽位：rope 段不做帧混合（官方 ropetrail 走 THICKFORMAT 路径）
        data[k++] = 0
        data[k++] = 0
        data[k++] = 0 // rotX
        data[k++] = 0 // rotY
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
          const base = Math.max(1e-3, sizePx(p.size) * segSize)
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
        data[k++] = sizePx(p.size) * segSize
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
        // 帧间混合：下一帧序号 + 权重（官方 SPRITESHEETBLEND）
        data[k++] = p.frameB === undefined ? p.frame : p.frameB
        data[k++] = p.frameMix || 0
        // 官方 ComputeParticleTangents 的 x/y 旋转（spritetrail 由速度定姿态，恒 0）
        data[k++] = p.rotX || 0
        data[k++] = p.rotY || 0
      }
    }

    const prog = this._prog
    // [we-scene patch] 显式绑定「最终绘制目标」（MSAA 时是多重采样 FBO，否则
    // 是默认帧缓冲）。历史上不绑、靠残留状态画到画布；MSAA 下残留目标可能是
    // 上一帧某个效果链 FBO，必须钉死。
    bindParticleFrameTarget(gl)
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
      // [we-scene patch] 官方 frag 在 `#if REFRACT` 下**无条件**采画面
      // （`color.rgb *= texSample2D(g_Texture3, refracted)`），与混合模式无关。
      // 旧实现把 additive 排除在外（当时用的是「用画面替换 albedo」的写法，会冲白）；
      // 现在按官方改成 albedo × 顶点色 × 画面 的**相乘**，且空白 albedo 的 alpha 由法线
      // 偏离给出，additive 也能安全采样 —— 直接证据：2464842912 车尾那块被冲白的
      // 加色水花（Splash，Refract Amount=1）在 Mirage 里是暗的场景色。
      // 画布是 alpha:false，copyTexImage2D 必须 RGB8，RGBA8 会 INVALID_OPERATION
      // 并留下全零纹理（见 renderer.js captureBackdrop）。
      const sampleScene = true
      if (prog.uniSampleScene) gl.uniform1i(prog.uniSampleScene, sampleScene ? 1 : 0)
      if (sampleScene) {
        const dw = gl.drawingBufferWidth || width
        const dh = gl.drawingBufferHeight || height
        // 必须在 TEXTURE2 上绑 scene 拷贝：copyTexImage2D 写的是当前 unit，
        // 若仍停在 TEXTURE1 会把法线贴图覆盖掉。
        gl.activeTexture(gl.TEXTURE2)
        if (particleSceneCaptureFn) {
          // [we-scene patch] MSAA 安全路径：由 renderer 代抓「当前已绘制内容」
          // （多重采样缓冲不能 copyTexImage2D，captureBackdrop 内部走 blit）。
          // 抓取会动帧缓冲绑定，拿回纹理后必须重新绑回绘制目标。
          const tex = particleSceneCaptureFn(dw, dh)
          gl.bindTexture(gl.TEXTURE_2D, tex || this.texture.glTex)
          bindParticleFrameTarget(gl)
        } else {
          gl.bindFramebuffer(gl.FRAMEBUFFER, null)
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
        }
        if (prog.uniScene) gl.uniform1i(prog.uniScene, 2)
        if (prog.uniResolution) gl.uniform2f(prog.uniResolution, dw, dh)
        if (prog.uniRefractScale) gl.uniform1f(prog.uniRefractScale, Number.isFinite(this.refractAmount) ? this.refractAmount : 0.05)
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
