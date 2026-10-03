// 相机路径（`scripts/camera_paths_*.json`）的运行时钟。
//
// WE 的相机对象可以带一条 `path`：文件里是若干**clip**（每段是一条 eye/center/up/fov/zoom
// 的关键帧曲线 + fps/length/mode），相机按 clip 依次飞行；`queuemode` 决定下一段怎么挑
// （`sequential` 顺序、`random` 随机）。参考实现是 open-wallpaper-engine 的
// `SceneCameraPath::TickQueue`（本文件逐条对齐它的语义，2026-09-29）：
//
//   1. 首次 tick（或时钟回退）→ 选一段 clip 并以 frame 0 应用；
//   2. 之后按 dt 累加 `elapsed`，超出一段的时长就应用该段**末帧**、扣掉余量、换下一段
//      （random 模式换段时随机抽，sequential 模式 index+1 环绕）；
//   3. 曲线求值的**基准**是「这段 clip 开始时相机的位姿」（OWE 的 queue_base）：
//      绝对曲线整段替换、relative 曲线在基准上叠加 —— 与动画控制器 applyTo(base) 同源；
//   4. 透视场景用 `fov` 曲线，正交场景用 `zoom` 曲线（OWE 的另一分支；本模块把两者都
//      求出来，交给宿主决定谁生效）。
//
// 纯函数 + 无 DOM：宿主每帧喂 (runtime, 当前位姿)，离线 verifier 也能直接驱动。
import { createAnimation } from './animation.js'

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
const vec3 = (v, fallback) => {
  if (Array.isArray(v) && v.length >= 3) return [num(v[0]), num(v[1]), num(v[2])]
  if (v && typeof v === 'object') return [num(v.x), num(v.y), num(v.z)]
  return fallback ? fallback.slice() : [0, 0, 0]
}

/**
 * 从 path 文档（`scripts/camera_paths_*.json` 的 `paths[]`）建一个可 tick 的路径时钟。
 *
 * @param {object} doc     解析后的路径文档（{paths:[...]} 或已经是数组）
 * @param {string} queuemode 'random' | 'sequential'（场景对象上的 queuemode 字段）
 */
export function createCameraPath(doc, queuemode) {
  // 通道归一化：**fps/length/mode 写在 path 层，通道自己不带 options**；标量通道
  // （fov/zoom）在文件里是**扁平关键帧数组**（`[kf, kf]`，没有 c0/c1/c2 包装）。
  // 不归一化就 `createAnimation(channel)` 拿到 length=0 → 曲线永远停在 frame 0
  // （实测：Dynamic 档相机会切段但段内一动不动）。
  const normChannel = (ch, opts) => {
    if (!ch) return null
    const withOpts = (def) => ({ ...def, options: { fps: opts.fps, length: opts.length, mode: opts.mode } })
    if (Array.isArray(ch)) return withOpts({ c0: ch })
    return withOpts(ch)
  }
  const clips = (Array.isArray(doc) ? doc : (doc && doc.paths) || []).map((p) => {
    const opts = (p && p.options) || {}
    const o = {
      fps: Number(opts.fps) > 0 ? Number(opts.fps) : 30,
      length: Number(opts.length) > 0 ? Number(opts.length) : 0,
      mode: opts.mode === 'loop' || opts.mode === 'mirror' ? opts.mode : 'single',
    }
    return {
      id: p && p.id,
      name: (p && p.name) || '',
      fps: o.fps,
      length: o.length,
      mode: o.mode,
      cameramode: typeof opts.cameramode === 'string' ? opts.cameramode : '',
      eye: normChannel(p && p.eye, o),
      center: normChannel(p && p.center, o),
      up: normChannel(p && p.up, o),
      fov: normChannel(p && p.fov, o),
      zoom: normChannel(p && p.zoom, o),
      _ctrl: null, // 懒建：一段最多 5 条通道，9 段的表也没必要在挂载期全建
    }
  })
  const state = { lastRuntime: null, index: 0, elapsed: 0, base: null }

  const ctrlOf = (clip, key) => {
    const def = clip[key]
    if (!def) return null
    if (!clip._ctrl) clip._ctrl = {}
    if (!clip._ctrl[key]) {
      try {
        clip._ctrl[key] = createAnimation(def)
      } catch {
        clip._ctrl[key] = null
      }
    }
    return clip._ctrl[key]
  }

  const evalVec = (clip, key, base) => {
    const ctrl = ctrlOf(clip, key)
    if (!ctrl) return base ? base.slice() : [0, 0, 0]
    try {
      ctrl.setFrame(frameOf)
      return vec3(ctrl.applyTo(base || [0, 0, 0]), base)
    } catch {
      return base ? base.slice() : [0, 0, 0]
    }
  }

  const evalNum = (clip, key, base) => {
    const ctrl = ctrlOf(clip, key)
    if (!ctrl) return base
    try {
      ctrl.setFrame(frameOf)
      const out = ctrl.applyTo(base)
      const n = Array.isArray(out) ? Number(out[0]) : Number(out)
      return Number.isFinite(n) ? n : base
    } catch {
      return base
    }
  }

  // 当前求值帧（setFrame 用它；由 applyClip 设好）
  let frameOf = 0

  const applyClip = (clip, frame) => {
    frameOf = Math.max(0, Math.min(num(frame), clip.length))
    const base = state.base || { eye: [0, 0, 0], center: [0, 0, -1], up: [0, 1, 0], fov: 50, zoom: 1 }
    return {
      clipId: clip.id,
      clipName: clip.name,
      frame: frameOf,
      eye: evalVec(clip, 'eye', base.eye),
      center: evalVec(clip, 'center', base.center),
      up: evalVec(clip, 'up', base.up),
      fov: evalNum(clip, 'fov', base.fov),
      zoom: evalNum(clip, 'zoom', base.zoom),
      cameramode: clip.cameramode,
    }
  }

  const selectClip = (initial) => {
    if (!clips.length) return
    if (queuemode === 'random') {
      state.index = Math.floor(Math.random() * clips.length)
    } else if (initial) {
      state.index = 0
    } else {
      state.index = (state.index + 1) % clips.length
    }
    state.elapsed = 0
  }

  return {
    clips,
    get index() {
      return state.index
    },
    /** 相机对象被停用/切档时调用：下次 tick 重新选段并从 0 开始 */
    reset() {
      state.lastRuntime = null
      state.elapsed = 0
    },
    /**
     * 推进到 runtime（秒）并返回当前位姿；无 clip 或异常时返回 null（宿主保留原相机）。
     * @param {number} runtime 场景时间（秒）
     * @param {object} basePose 当前相机位姿 { eye, center, up, fov, zoom }，用作 clip 基准
     */
    tick(runtime, basePose) {
      if (!clips.length) return null
      const t = num(runtime)
      const pose = basePose || {}
      if (state.lastRuntime === null || t < state.lastRuntime) {
        state.base = {
          eye: vec3(pose.eye, [0, 0, 0]),
          center: vec3(pose.center, [0, 0, -1]),
          up: vec3(pose.up, [0, 1, 0]),
          fov: Number.isFinite(Number(pose.fov)) ? Number(pose.fov) : 50,
          zoom: Number.isFinite(Number(pose.zoom)) ? Number(pose.zoom) : 1,
        }
        selectClip(true)
        state.lastRuntime = t
        return applyClip(clips[state.index], 0)
      }
      let delta = t - state.lastRuntime
      state.lastRuntime = t
      let zeroDuration = 0
      let guard = 0
      while (delta > 0 && guard++ < clips.length * 4) {
        const clip = clips[state.index]
        const duration = clip.fps > 0 && clip.length > 0 ? clip.length / clip.fps : 0
        const remaining = Math.max(duration - state.elapsed, 0)
        if (remaining > 0 && delta < remaining) {
          state.elapsed += delta
          break
        }
        if (remaining > 0) {
          state.elapsed = duration
          delta -= remaining
          zeroDuration = 0
        } else {
          // 零时长段：全表都是零时长就放弃（否则死循环）
          if (++zeroDuration >= clips.length) break
        }
        selectClip(false)
      }
      return applyClip(clips[state.index], state.elapsed * clips[state.index].fps)
    },
  }
}

/**
 * [we-scene patch 2026-10-03] **场景级相机路径**（`scene.json` 的 `camera.paths[]`，
 * 即 WE 编辑器录制的相机路径）。与上面 `createCameraPath` 是**两种不同的文件格式**：
 *
 *   · 对象级（上面那个）：`{paths:[{options:{fps,length,mode}, eye:{c0:…}, center:…}]}`
 *     —— 动画通道格式，挂在相机**对象**的 `path` 上（全库 48 个对象 / 9 段真 clip）；
 *   · 场景级（本函数）：`{paths:[{duration, name, transforms:[{eye, center, up, timestamp}]}]}`
 *     —— 关键帧 + 时间戳格式，挂在 `scene.camera.paths`（全库 6 个场景，**全是官方
 *     内置 3D 工程**：arsenal/demon_core/dna_fragment/fantasticcar/neon_sunset/ricepod）。
 *
 * 为什么必须做：这 6 个工程没有相机实体，`runtimeCamera` 为 null ⇒ buildCamera 回落
 * 顶层 `scene.camera` 的**编辑器视口快照**，而作者录的运镜才是运行时该有的机位。
 * 实测 fantasticcar：静照相机在车尾方向（eye z=-4.4），路径第 0 段在车头右前方
 * （eye 2.18/1.99/4.63）—— 用静态快照渲染与官方出图（preview.jpg）整个取景不同。
 *
 * 语义（判据：全库 6 个工程的路径文件字段与取值一致，无第二套形态）：
 *   · clip 按文件顺序播、播完回到第 0 段（各段 `duration` 之和为整圈周期）；
 *   · 段内按 **timestamp 秒**线性插值 eye/center/up；第一个关键帧之前保持首帧、
 *     最后一个之后保持末帧（时间轴语义：关键帧摆在哪就何时到位）；
 *   · 纯函数式求值（只依赖 t），不吃状态也不随机 —— 同一时刻的位姿唯一，
 *     宿主每帧调用即可，回退/续播天然正确。
 *
 * @param {object[]|object} clips clip 数组（每个含 duration + transforms[]）；也接受
 *                                 单个 clip 对象或整份路径文档（`{paths:[…]}`）
 * @returns {{clips: object[], duration: number, tick: (t:number)=>object|null}}
 */
export function createSceneCameraPath(clips) {
  // 路径文件里的 eye/center/up 是**空格分隔的字符串**（"2.182 1.986 4.634"）——
  // 本模块顶部的 `vec3` 只认数组/对象（对象级路径的动画通道就是那个形态），
  // 直接用它会把每一帧都读成 [0,0,0]（相机瞬移到原点）。故这里单独解析字符串。
  const keyVec = (v) => {
    const parts = Array.isArray(v) ? v : String(v ?? '').trim().split(/[\s,]+/)
    if (parts.length < 3) return null
    const out = [Number(parts[0]), Number(parts[1]), Number(parts[2])]
    return out.every((n) => Number.isFinite(n)) ? out : null
  }
  const input = Array.isArray(clips) ? clips : clips && Array.isArray(clips.paths) ? clips.paths : [clips]
  const list = input
    .filter((c) => c && typeof c === 'object')
    .map((c) => {
      const duration = Number(c.duration) > 0 ? Number(c.duration) : 0
      const keys = (Array.isArray(c.transforms) ? c.transforms : [])
        .filter((k) => k && typeof k === 'object')
        .map((k) => ({
          t: num(k.timestamp),
          eye: keyVec(k.eye),
          center: keyVec(k.center),
          up: keyVec(k.up) || [0, 1, 0],
          fov: Number(k.fov) > 0 ? Number(k.fov) : null,
          zoom: Number(k.zoom) > 0 ? Number(k.zoom) : null,
        }))
        .filter((k) => k.eye && k.center)
        .sort((a, b) => a.t - b.t)
      return { name: c.name || '', duration, keys }
    })
    .filter((c) => c.keys.length > 0 && c.duration > 0)
  const total = list.reduce((s, c) => s + c.duration, 0)
  const lerp3 = (a, b, w) => [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w, a[2] + (b[2] - a[2]) * w]

  /** 段内按时间戳插值；落在关键帧范围外时保持最近的一端 */
  const evalClip = (clip, tInClip) => {
    const keys = clip.keys
    let i = 0
    while (i + 1 < keys.length && keys[i + 1].t <= tInClip) i++
    const a = keys[i]
    const b = keys[i + 1]
    if (!b || b.t <= a.t || tInClip <= a.t) {
      return { eye: a.eye.slice(), center: a.center.slice(), up: a.up.slice(), fov: a.fov, zoom: a.zoom }
    }
    const w = Math.min(1, Math.max(0, (tInClip - a.t) / (b.t - a.t)))
    return {
      eye: lerp3(a.eye, b.eye, w),
      center: lerp3(a.center, b.center, w),
      up: lerp3(a.up, b.up, w),
      fov: a.fov !== null && b.fov !== null ? a.fov + (b.fov - a.fov) * w : a.fov !== null ? a.fov : b.fov,
      zoom: a.zoom !== null && b.zoom !== null ? a.zoom + (b.zoom - a.zoom) * w : a.zoom !== null ? a.zoom : b.zoom,
    }
  }

  return {
    clips: list,
    duration: total,
    /** 推进到场景时间 t（秒）并返回当前位姿；没有可用 clip 时返回 null */
    tick(runtime) {
      if (!list.length || !(total > 0)) return null
      let t = num(runtime) % total
      if (t < 0) t += total
      let i = 0
      while (i < list.length - 1 && t >= list[i].duration) {
        t -= list[i].duration
        i++
      }
      return evalClip(list[i], t)
    },
  }
}
