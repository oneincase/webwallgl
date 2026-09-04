// [we-scene patch] WE 媒体集成（Media Integration）的模拟数据源
//
// WE 引擎把「系统当前正在播放的音乐」推给壁纸脚本，靠五个回调（不是轮询）：
//
//   mediaPropertiesChanged(e)  e.title / e.artist / e.albumArtist / e.album
//   mediaThumbnailChanged(e)   e.hasThumbnail / e.primaryColor / e.secondaryColor
//                              e.tertiaryColor / e.textColor / e.highContrastColor
//   mediaPlaybackChanged(e)    e.state（对应 MediaPlaybackEvent 枚举）
//   mediaTimelineChanged(e)    e.position / e.duration
//   mediaStatusChanged(e)      有无媒体源（全库零使用，留占位）
//
// 全库 21 张壁纸 / 308 处回调声明依赖它，此前一次都没被调用过 —— 音乐类壁纸
// 的歌名、歌手、封面、唱针动作、进度条因此全部停在作者存盘时的占位快照
// （2938612768 就一直显示 "Wallpaper Music" / "Name of artist"）。
//
// 本模块严格照抄 render/audio.js 已验证的范式：
//   - **纯时间函数**：update(t) 同 t 同结果，不累积状态，暂停/回卷都安全，
//     node 离线校验与浏览器逐帧驱动走同一条路径；
//   - vendor 侧只做数据，宿主侧组装并派发（见 main.ts）；
//   - 接真实系统媒体源时只需替换 update，快照结构不变。
//
// 两个必须遵守的类型约定（踩过同款坑）：
//   1. **颜色字段必须是 Vec3 实例**，不能是数组或 {x,y,z} 字面量。语料脚本会写
//      `newColor.subtract(oldColor).multiply(t).add(oldColor)` 做封面主色渐变，
//      给普通对象会 TypeError 熔断（text.js 的 makeCursorEventVec 就是为同样的
//      原因存在的：worldPosition 给字面量导致 3 个骨骼拖拽壁纸全部失效）。
//   2. **state 用 MediaPlaybackEvent 的整数**（STOPPED=0 / PLAYING=1 / PAUSED=2）。
//      全库 236 处读 `event.state` 并与枚举比较。
//
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

// 模拟播放列表。时长取真实歌曲量级（3~4 分钟），配色各不相同以便肉眼确认
// 「换歌 → 封面主色跟着变」这条链路确实通了。
const PLAYLIST = [
  {
    title: '夜航星', artist: '相位迁移', album: '深空回声', albumArtist: '相位迁移',
    duration: 212,
    colors: { primary: [0.24, 0.42, 0.86], secondary: [0.12, 0.18, 0.42], tertiary: [0.62, 0.74, 0.98], text: [0.95, 0.97, 1.0] },
    lyrics: [
      [0, '在无光的航道上'], [12, '我们只带走彼此的名字'], [26, '引擎低鸣像一句旧诺言'],
      [41, '把黑暗折成两半'], [58, '夜航星啊'], [72, '别在中途熄灭'],
      [95, '（间奏）'], [126, '如果坐标终将失效'], [140, '就让轨迹自己说话'],
      [158, '我们不返航'], [176, '也不遗憾'], [198, '……'],
    ],
  },
  {
    title: 'Amber Lantern', artist: 'Hollow Coast', album: 'Tidewater', albumArtist: 'Hollow Coast',
    duration: 187,
    colors: { primary: [0.93, 0.62, 0.24], secondary: [0.44, 0.24, 0.10], tertiary: [0.99, 0.82, 0.56], text: [1.0, 0.98, 0.93] },
    lyrics: [
      [0, 'Salt on the window frame'], [14, 'a lantern swinging slow'], [30, 'you said the tide forgets'],
      [46, 'but the harbour never does'], [63, 'Amber lantern, burn a little longer'],
      [88, '(instrumental)'], [118, 'Every rope remembers the knot'], [134, 'every shore remembers the leaving'],
      [152, 'burn a little longer'], [170, 'for me'],
    ],
  },
  {
    title: '苔痕', artist: '林间电台', album: '半山雨', albumArtist: '林间电台',
    duration: 241,
    colors: { primary: [0.30, 0.68, 0.44], secondary: [0.10, 0.28, 0.20], tertiary: [0.72, 0.92, 0.78], text: [0.96, 1.0, 0.97] },
    lyrics: [
      [0, '雨停在第三级台阶'], [16, '苔痕爬满了旧门牌'], [33, '你说慢一点也没关系'],
      [52, '山不会走'], [70, '而我们有的是时间'], [92, '（间奏）'],
      [130, '把伞收起来吧'], [148, '让潮气记住这一刻'], [172, '慢一点'], [200, '真的没关系'], [226, '……'],
    ],
  },
  {
    title: 'Neon Ashes', artist: 'VELVET//NULL', album: 'Afterimage', albumArtist: 'VELVET//NULL',
    duration: 168,
    colors: { primary: [0.86, 0.22, 0.58], secondary: [0.30, 0.06, 0.22], tertiary: [0.99, 0.64, 0.86], text: [1.0, 0.94, 0.98] },
    lyrics: [
      [0, 'city bleeds into the lens'], [11, 'we were only afterimage'], [24, 'neon ashes on your coat'],
      [38, 'nothing here stays lit'], [55, 'burn out with me'], [76, '(drop)'],
      [104, 'nothing here stays lit'], [122, 'burn out with me'], [146, '…'],
    ],
  },
]

const GAP = 3 // 曲间空隙（秒）：这段 state=STOPPED，用于验证「停止态」分支

/**
 * 创建模拟媒体源。
 * @param {number} seed 保留参数，与 createSimulatedAudio 对齐（当前播放列表是固定的）
 *
 * 默认仍是**纯时间函数**（seekOffset=0、未暂停）：同 t 同结果，verify-media
 * 的周期/三态/歌词断言不用改。切歌 / 暂停是叠在时间轴上的控制面，接真实
 * 系统媒体时只需换成另一套 provider，快照字段与 skipNext/playPause 名字不变。
 */
export function createSimulatedMedia(seed = 20260901) {
  const tracks = PLAYLIST
  const cycle = tracks.reduce((s, t) => s + t.duration + GAP, 0)

  const snapshot = {
    hasMedia: false,
    state: MEDIA_PLAYBACK.STOPPED,
    title: '', artist: '', album: '', albumArtist: '',
    position: 0, duration: 0,
    hasThumbnail: false,
    // 颜色恒为 Vec3 实例（见文件头的类型约定）
    primaryColor: new MediaVec3(0, 0, 0),
    secondaryColor: new MediaVec3(0, 0, 0),
    tertiaryColor: new MediaVec3(0, 0, 0),
    textColor: new MediaVec3(1, 1, 1),
    highContrastColor: new MediaVec3(1, 1, 1),
    trackIndex: -1,
    // 自定义扩展：歌词
    lyrics: [],
    lyricLine: '',
    lyricIndex: -1,
  }

  let seekOffset = 0
  let held = false
  let holdT = 0
  let lastWall = 0

  function trackStart(i) {
    let t = 0
    const n = ((i % tracks.length) + tracks.length) % tracks.length
    for (let k = 0; k < n; k++) t += tracks[k].duration + GAP
    return t
  }

  function applyAt(time) {
    let x = cycle > 0 ? time % cycle : 0
    if (x < 0) x += cycle
    let idx = -1
    let pos = 0
    let inGap = false
    for (let i = 0; i < tracks.length; i++) {
      const d = tracks[i].duration
      if (x < d) { idx = i; pos = x; break }
      x -= d
      if (x < GAP) { idx = i; pos = d; inGap = true; break }
      x -= GAP
    }
    if (idx < 0) { idx = tracks.length - 1; pos = tracks[idx].duration; inGap = true }
    const tr = tracks[idx]

    snapshot.hasMedia = true
    snapshot.trackIndex = idx
    snapshot.title = tr.title
    snapshot.artist = tr.artist
    snapshot.album = tr.album
    snapshot.albumArtist = tr.albumArtist
    snapshot.duration = tr.duration
    snapshot.position = pos
    // 曲间空隙 = 停止；每首曲子的 70%~76% 处模拟一次短暂暂停，用来验证
    // PAUSED 分支（唱针抬起、碟盘停转这类效果只在这个状态下能看出来）
    const frac = tr.duration > 0 ? pos / tr.duration : 0
    if (held) snapshot.state = MEDIA_PLAYBACK.PAUSED
    else if (inGap) snapshot.state = MEDIA_PLAYBACK.STOPPED
    else if (frac > 0.70 && frac < 0.76) snapshot.state = MEDIA_PLAYBACK.PAUSED
    else snapshot.state = MEDIA_PLAYBACK.PLAYING

    snapshot.hasThumbnail = !inGap
    const c = tr.colors
    snapshot.primaryColor = new MediaVec3(c.primary[0], c.primary[1], c.primary[2])
    snapshot.secondaryColor = new MediaVec3(c.secondary[0], c.secondary[1], c.secondary[2])
    snapshot.tertiaryColor = new MediaVec3(c.tertiary[0], c.tertiary[1], c.tertiary[2])
    snapshot.textColor = new MediaVec3(c.text[0], c.text[1], c.text[2])
    // 高对比色：按亮度取黑或白，供描边/阴影用
    const lum = 0.2126 * c.primary[0] + 0.7152 * c.primary[1] + 0.0722 * c.primary[2]
    snapshot.highContrastColor = lum > 0.5 ? new MediaVec3(0, 0, 0) : new MediaVec3(1, 1, 1)

    snapshot.lyrics = tr.lyrics
    let li = -1
    for (let i = 0; i < tr.lyrics.length; i++) if (pos >= tr.lyrics[i][0]) li = i
    snapshot.lyricIndex = li
    snapshot.lyricLine = li >= 0 ? tr.lyrics[li][1] : ''
    return snapshot
  }

  /** 把墙钟 t 折进播放列表。暂停时钉在 holdT，不往前走。 */
  function update(t) {
    lastWall = Number(t) || 0
    const time = held ? holdT : lastWall + seekOffset
    return applyAt(time)
  }

  function skipToTrack(i) {
    held = false
    const start = trackStart(i)
    seekOffset = start - lastWall
    return applyAt(start)
  }

  function skipNext() {
    const i = snapshot.trackIndex < 0 ? 0 : snapshot.trackIndex + 1
    return skipToTrack(i)
  }

  function skipPrevious() {
    const i = snapshot.trackIndex < 0 ? tracks.length - 1 : snapshot.trackIndex - 1
    return skipToTrack(i)
  }

  function pause() {
    if (held) return snapshot
    holdT = lastWall + seekOffset
    held = true
    snapshot.state = MEDIA_PLAYBACK.PAUSED
    return snapshot
  }

  function play() {
    if (!held) return snapshot
    held = false
    seekOffset = holdT - lastWall
    return applyAt(holdT)
  }

  function playPause() {
    return held ? play() : pause()
  }

  return {
    update, snapshot, tracks, cycle, MEDIA_PLAYBACK,
    skipNext, skipPrevious, play, pause, playPause,
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
  if (first || prev.hasThumbnail !== snap.hasThumbnail || prev.trackIndex !== snap.trackIndex) {
    out.push({
      name: 'mediaThumbnailChanged',
      event: {
        hasThumbnail: snap.hasThumbnail,
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
    hasThumbnail: s.hasThumbnail, trackIndex: s.trackIndex,
    lyricIndex: s.lyricIndex, lyricLine: s.lyricLine,
  }
}
