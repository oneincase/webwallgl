// [we-scene patch] WE 媒体集成（Media Integration）的模拟数据源
// WE 引擎把「系统当前正在播放的音乐」推给壁纸脚本，靠五个回调（不是轮询）：
//   mediaPropertiesChanged(e)  e.title / e.artist / e.albumArtist / e.album
//   mediaThumbnailChanged(e)   e.hasThumbnail / e.primaryColor / e.secondaryColor
//                              e.tertiaryColor / e.textColor / e.highContrastColor
//   mediaPlaybackChanged(e)    e.state（对应 MediaPlaybackEvent 枚举）
//   mediaTimelineChanged(e)    e.position / e.duration
//   mediaStatusChanged(e)      有无媒体源（全库零使用，留占位）
// 全库 21 张壁纸 / 308 处回调声明依赖它，此前一次都没被调用过 —— 音乐类壁纸
// 的歌名、歌手、封面、唱针动作、进度条因此全部停在作者存盘时的占位快照
// （2938612768 就一直显示 "Wallpaper Music" / "Name of artist"）。
// 本模块严格照抄 render/audio.js 已验证的范式：
//   - **纯时间函数**：update(t) 同 t 同结果，不累积状态，暂停/回卷都安全，
//     node 离线校验与浏览器逐帧驱动走同一条路径；
//   - vendor 侧只做数据，宿主侧组装并派发（见 main.ts）；
//   - 接真实系统媒体源时只需替换 update，快照结构不变。
// 两个必须遵守的类型约定（踩过同款坑）：
//   1. **颜色字段必须是 Vec3 实例**，不能是数组或 {x,y,z} 字面量。语料脚本会写
//      `newColor.subtract(oldColor).multiply(t).add(oldColor)` 做封面主色渐变，
//      给普通对象会 TypeError 熔断（text.js 的 makeCursorEventVec 就是为同样的
//      原因存在的：worldPosition 给字面量导致 3 个骨骼拖拽壁纸全部失效）。
//   2. **state 用 MediaPlaybackEvent 的整数**（STOPPED=0 / PLAYING=1 / PAUSED=2）。
//      全库 236 处读 `event.state` 并与枚举比较。
// 歌词（lyrics）是**本仓库的自定义扩展**，WE 官方媒体 API 没有这一类，全库
// 21 张壁纸也没有一处用到。放在这里是为了给宿主/自制壁纸提供统一数据源，
// 通过 mediaLyricsChanged 派发，不与 WE 的四类语义混淆。


export const MEDIA_PLAYBACK = { STOPPED: 0, PLAYING: 1, PAUSED: 2 }

/** 与 text.js 的 Vec3 保持同一套链式 API（脚本会做 subtract/multiply/add） */
class MediaVec3 {
  constructor(x, y, z) {
    this.x = Number(x) || 0
    this.y = Number(y) || 0
    this.z = Number(z) || 0
  }
  add(o) { return new MediaVec3(this.x + o.x, this.y + o.y, this.z + o.z) }
  subtract(o) { return new MediaVec3(this.x - o.x, this.y - o.y, this.z - o.z) }
  multiply(k) {
    if (k !== null && typeof k === 'object') return new MediaVec3(this.x * k.x, this.y * k.y, this.z * k.z)
    const n = Number(k) || 0
    return new MediaVec3(this.x * n, this.y * n, this.z * n)
  }
  divide(k) {
    const n = Number(k) || 1
    return new MediaVec3(this.x / n, this.y / n, this.z / n)
  }
  length() { return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z) }
  copy() { return new MediaVec3(this.x, this.y, this.z) }
  toArray() { return [this.x, this.y, this.z] }
}

export function mediaVec3(x, y, z) { return new MediaVec3(x, y, z) }

// [we-scene patch] 无系统媒体时的中性驱动（hasMedia 恒 false）。
// 不再伪造品牌曲目/封面/歌词：媒体回调以「无媒体」派发，$mediaThumbnail
// 保留名不被占用 —— shader 与脚本因此显示作者烘焙进壁纸的占位设计。
const NEUTRAL_MEDIA = {
  hasMedia: false,
  state: MEDIA_PLAYBACK.STOPPED,
  title: '', artist: '', album: '', albumArtist: '',
  position: 0, duration: 0,
  hasThumbnail: false,
  thumbnail: '',
  primaryColor: new MediaVec3(0, 0, 0),
  secondaryColor: new MediaVec3(0, 0, 0),
  tertiaryColor: new MediaVec3(0, 0, 0),
  textColor: new MediaVec3(1, 1, 1),
  highContrastColor: new MediaVec3(1, 1, 1),
  trackIndex: -1,
  lyrics: [],
  lyricLine: '',
  lyricIndex: -1,
}

/**
 * 无媒体回落驱动。保留 createSimulatedMedia 名字（调用点/类型不变），
 * 但返回恒定的「无媒体」快照：没有真实 Now Playing 时壁纸显示自带占位。
 */
export function createSimulatedMedia(seed = 20260901) {
  return {
    snapshot: NEUTRAL_MEDIA,
    tracks: [],
    cycle: 0,
    MEDIA_PLAYBACK,
    update(_t) { return NEUTRAL_MEDIA },
    skipNext() {}, skipPrevious() {},
    play() {}, pause() {}, playPause() {},
  }
}

/**
 * 程序化生成一张封面位图（RGBA）。没有真实专辑封面时用它填
 * `$mediaThumbnail` / `$mediaPreviousThumbnail` 两个 WE 保留纹理名。
 * 用曲目主色做同心律动 + 斜向光带，风格接近唱片封套，纯函数、可离线校验。
 */
export function renderThumbnail(track, size = 512) {
  const n = Math.max(8, size | 0)
  const rgba = new Uint8Array(n * n * 4)
  const c = track && track.colors ? track.colors : { primary: [0.5, 0.5, 0.5], secondary: [0.1, 0.1, 0.1], tertiary: [0.8, 0.8, 0.8] }
  const [pr, pg, pb] = c.primary
  const [sr, sg, sb] = c.secondary
  const [tr_, tg, tb] = c.tertiary
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const u = x / (n - 1)
      const v = y / (n - 1)
      const dx = u - 0.5
      const dy = v - 0.5
      const r = Math.sqrt(dx * dx + dy * dy) * 2 // 0..~1.41
      // 同心环 + 斜向光带
      const ring = 0.5 + 0.5 * Math.sin(r * 18 - 1.2)
      const band = 0.5 + 0.5 * Math.sin((u + v) * 6.0)
      const k = Math.min(1, Math.max(0, r))
      // 主色 → 次色的径向渐变，再叠环与光带
      let cr = pr * (1 - k) + sr * k
      let cg = pg * (1 - k) + sg * k
      let cb = pb * (1 - k) + sb * k
      cr = cr * (0.72 + 0.28 * ring) + tr_ * 0.18 * band
      cg = cg * (0.72 + 0.28 * ring) + tg * 0.18 * band
      cb = cb * (0.72 + 0.28 * ring) + tb * 0.18 * band
      // 四角压暗，像唱片套的暗角
      const vig = 1 - 0.35 * Math.min(1, r * r)
      const i = (y * n + x) * 4
      rgba[i] = Math.max(0, Math.min(255, Math.round(cr * vig * 255)))
      rgba[i + 1] = Math.max(0, Math.min(255, Math.round(cg * vig * 255)))
      rgba[i + 2] = Math.max(0, Math.min(255, Math.round(cb * vig * 255)))
      rgba[i + 3] = 255
    }
  }
  return { width: n, height: n, rgba }
}

/**
 * 比较两次快照，产出需要派发的事件列表。
 * **只在变化时派发** —— WE 语义是事件而非轮询，且语料里
 * `mediaThumbnailChanged` 常写 `anim.stop(); anim.play();`，每帧广播会让动画
 * 永远卡在第 0 帧重放。
 * @returns {Array<{name:string, event:object}>}
 */
export function diffMediaEvents(prev, snap) {
  const out = []
  if (!snap) return out
  const first = !prev
  if (first || prev.hasMedia !== snap.hasMedia) {
    out.push({ name: 'mediaStatusChanged', event: { enabled: snap.hasMedia } })
  }
  if (first || prev.title !== snap.title || prev.artist !== snap.artist
    || prev.album !== snap.album || prev.albumArtist !== snap.albumArtist) {
    out.push({
      name: 'mediaPropertiesChanged',
      event: {
        title: snap.title, artist: snap.artist,
        album: snap.album, albumArtist: snap.albumArtist,
        albumTitle: snap.album, subTitle: '', trackType: 'music',
      },
    })
  }
  // thumbnail 也要参与判定：真实封面常晚于元信息到达（系统媒体接口先给
  // 歌名再补封面），只看 hasThumbnail/trackIndex 会漏掉「同一首歌补上封面」
  if (
    first ||
    prev.hasThumbnail !== snap.hasThumbnail ||
    prev.trackIndex !== snap.trackIndex ||
    prev.thumbnail !== snap.thumbnail
  ) {
    out.push({
      name: 'mediaThumbnailChanged',
      event: {
        hasThumbnail: snap.hasThumbnail,
        thumbnail: snap.thumbnail,
        primaryColor: snap.primaryColor,
        secondaryColor: snap.secondaryColor,
        tertiaryColor: snap.tertiaryColor,
        textColor: snap.textColor,
        highContrastColor: snap.highContrastColor,
      },
    })
  }
  if (first || prev.state !== snap.state) {
    out.push({ name: 'mediaPlaybackChanged', event: { state: snap.state } })
  }
  // 进度：整秒变化才派发（避免每帧刷；语料只用它算进度条比例）
  if (first || Math.floor(prev.position) !== Math.floor(snap.position) || prev.duration !== snap.duration) {
    out.push({ name: 'mediaTimelineChanged', event: { position: snap.position, duration: snap.duration } })
  }
  // 自定义扩展：歌词行变化
  if (first || prev.lyricIndex !== snap.lyricIndex || prev.trackIndex !== snap.trackIndex) {
    out.push({
      name: 'mediaLyricsChanged',
      event: { line: snap.lyricLine, index: snap.lyricIndex, lines: snap.lyrics },
    })
  }
  return out
}

/** 浅拷贝一份快照用于下一轮 diff（颜色只需引用，不参与相等判断） */
export function cloneMediaSnapshot(s) {
  if (!s) return null
  return {
    hasMedia: s.hasMedia, state: s.state,
    title: s.title, artist: s.artist, album: s.album, albumArtist: s.albumArtist,
    position: s.position, duration: s.duration,
    hasThumbnail: s.hasThumbnail, thumbnail: s.thumbnail, trackIndex: s.trackIndex,
    lyricIndex: s.lyricIndex, lyricLine: s.lyricLine,
  }
}

// [we-scene patch] 壁纸自带音频 → 媒体面板数据源
// WE 官方语义里媒体集成只反映**系统播放器**，壁纸自己播的音频不产生任何媒体
// 事件 —— 但语料里音乐壁纸（3151551777 等）的 MEDIA 面板显隐全部挂在
// `mediaPlaybackChanged(state!==STOPPED)` 上、歌名来自 mediaPropertiesChanged：
// 壁纸放着自己的歌、面板却永久隐藏或停在模拟源的品牌占位曲。
// 本驱动把**脚本显式播放的声音层**（thisScene.getLayer(x).play() → soundCtl.play）
// 接进媒体快照：正在播的曲目即「正在播放」的媒体。装配期自动开播的环境音
// （火车声、雨声，宿主 startsilent=false 分支）**不** markPlayed —— 那不是用户
// 在听的「曲目」，抢媒体面板没有意义。文件标签（Vorbis/ID3）实测常为空
// （3151551777 全部 17 首注释 n=0），标题回退到层名剥扩展名与曲号前缀。

/** 层名 → 曲目名：剥扩展名与 "1.16 " / "01. " / "2-01 " 这类曲号前缀 */
export function songTitleFromLayerName(name) {
  let s = String(name || '')
  s = s.replace(/\.(ogg|oga|mp3|wav|flac|m4a)$/i, '')
  // 曲号形态必须是「数字.数字」或「数字+分隔符」，否则 "7 clouds" 这种歌名
  // 开头的数字会被误剥（分隔符后无第二段数字的 "7 clouds" 不剥）
  s = s.replace(/^\s*\d{1,3}\s*[.\-_]\s*\d{0,3}\s*[.\-_\)]?\s+/, '')
  s = s.replace(/^\s*\d{1,3}\s*[.\-_\)]\s+/, '')
  return s.trim()
}

/**
 * 壁纸音频媒体源。register/markPlayed 由宿主的声音图层装配接线；
 * snapshot 字段与 createSimulatedMedia 同构（diffMediaEvents 直接可用）。
 * @param {object} MEDIA_PLAYBACK { STOPPED, PLAYING, PAUSED }
 * @param {Function} MediaVec3 颜色构造器（与 mediaVec3 同一实现）
 */
export function createWallpaperAudioMedia(MEDIA_PLAYBACK, MediaVec3) {
  /** @type {Array<{au:HTMLAudioElement, title:string, key:string}>} */
  const tracks = []
  const byAu = new Map()
  let current = null
  let changeSeq = 0

  const NEUTRAL_COLORS = {
    primaryColor: new MediaVec3(0.18, 0.22, 0.3),
    secondaryColor: new MediaVec3(0.08, 0.1, 0.16),
    tertiaryColor: new MediaVec3(0.6, 0.66, 0.76),
    textColor: new MediaVec3(0.96, 0.97, 1),
    highContrastColor: new MediaVec3(1, 1, 1),
  }

  function register(au, layerName) {
    if (!au || byAu.has(au)) return
    const title = songTitleFromLayerName(layerName)
    const t = { au, title, key: `wa:${tracks.length}:${title}` }
    tracks.push(t)
    byAu.set(au, t)
    return t
  }

  /** 脚本显式 play() 时调用：这首曲子成为「正在播放」 */
  function markPlayed(au) {
    const t = byAu.get(au)
    if (!t || current === t) return
    current = t
    changeSeq++
  }

  /** 脚本显式 stop() 时调用：停止的曲子不再是「正在播放」（面板按 STOPPED 收起） */
  function markStopped(au) {
    if (current && current.au === au) {
      current = null
      changeSeq++
    }
  }

  function trackIndex() {
    return current ? tracks.indexOf(current) : -1
  }

  function playing() {
    if (!current) return false
    const au = current.au
    // ended 也算停止（playbackmode=single 的一次性曲目放完后面板该收了）
    return !au.paused && !au.ended
  }

  const snapshot = {
    get hasMedia() { return current != null },
    get state() {
      if (!current) return MEDIA_PLAYBACK.STOPPED
      const au = current.au
      if (!au.paused && !au.ended) return MEDIA_PLAYBACK.PLAYING
      // 暂停与停止：WE 只有三态。ended → STOPPED（面板收起），paused → PAUSED
      return au.ended ? MEDIA_PLAYBACK.STOPPED : MEDIA_PLAYBACK.PAUSED
    },
    get title() { return current ? current.title : '' },
    get artist() { return '' },
    get album() { return '' },
    get albumArtist() { return '' },
    get position() { return current ? Number(current.au.currentTime) || 0 : 0 },
    get duration() { const d = current ? Number(current.au.duration) : 0; return Number.isFinite(d) ? d : 0 },
    get hasThumbnail() { return false },
    get thumbnail() { return '' },
    get trackIndex() { return trackIndex() },
    get lyrics() { return [] },
    get lyricIndex() { return -1 },
    get lyricLine() { return '' },
    primaryColor: NEUTRAL_COLORS.primaryColor,
    secondaryColor: NEUTRAL_COLORS.secondaryColor,
    tertiaryColor: NEUTRAL_COLORS.tertiaryColor,
    textColor: NEUTRAL_COLORS.textColor,
    highContrastColor: NEUTRAL_COLORS.highContrastColor,
  }

  function playTrack(i) {
    const n = ((i % tracks.length) + tracks.length) % tracks.length
    const t = tracks[n]
    if (!t) return
    for (const { au } of tracks) {
      if (au !== t.au) {
        au.pause()
        try { au.currentTime = 0 } catch {  }
      }
    }
    Promise.resolve(t.au.play()).catch(() => {})
    markPlayed(t.au)
  }

  return {
    snapshot,
    register,
    markPlayed,
    markStopped,
    /** 有脚本播放过的曲目时才作为当前媒体 driver（否则回落 simMedia） */
    hasCurrent: () => current != null,
    /** 诊断/测试 */
    _changeSeq: () => changeSeq,
    skipNext() { if (tracks.length) playTrack(trackIndex() + 1) },
    skipPrevious() { if (tracks.length) playTrack(trackIndex() - 1) },
    play() {
      if (current) Promise.resolve(current.au.play()).catch(() => {})
    },
    pause() { if (current) current.au.pause() },
    playPause() {
      if (!current) return
      if (current.au.paused) this.play()
      else this.pause()
    },
  }
}
