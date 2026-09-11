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

import { MEDIA_LOGO_DATA_URL } from './media-logo.js'

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

// [we-scene patch] 模拟播放列表 = 库自己的品牌曲：曲名一律 WebWallGL、歌手一律
// oneincase、封面一律本库 logo（media-logo.js 的 data URL），专辑名区分四首
// （Scene / Web / Video / Live，正好对应库支持的壁纸类型，切歌时肉眼仍能确认
// 轮换链路是通的）。配色取 logo 的橙日 / 深蓝夜空 / 钢蓝山脉，四首一致 ——
// 与场景侧从封面位图重采样得到的调色板保持同色。
// 此前是四首虚构乐队歌（夜航星/Amber Lantern/苔痕/Neon Ashes）+ 程序化渐变封面，
// 用户明确要求换成库品牌；时长仍取真实歌曲量级（3~4 分钟）。
const LOGO_COLORS = {
  primary: [0.96, 0.65, 0.14],   // 橙日
  secondary: [0.08, 0.11, 0.18], // 深蓝夜空
  tertiary: [0.66, 0.74, 0.88],  // 钢蓝山脉
  text: [0.96, 0.97, 1.0],
}
const PLAYLIST = [
  {
    title: 'WebWallGL', artist: 'oneincase', album: 'Scene', albumArtist: 'oneincase',
    duration: 212,
    colors: LOGO_COLORS,
    thumbnail: MEDIA_LOGO_DATA_URL,
    lyrics: [
      [0, '场景一层层亮起'], [12, '骨骼与粒子各就各位'], [26, '脚本在沙箱里苏醒'],
      [41, '把每一帧交给时间'], [58, 'WebWallGL'], [72, '场景正在呼吸'],
      [95, '（间奏）'], [126, '图层排成星轨'], [140, '效果链一寸寸点亮'],
      [158, '我们不渲染黑暗'], [176, '只渲染光'], [198, '……'],
    ],
  },
  {
    title: 'WebWallGL', artist: 'oneincase', album: 'Web', albumArtist: 'oneincase',
    duration: 187,
    colors: LOGO_COLORS,
    thumbnail: MEDIA_LOGO_DATA_URL,
    lyrics: [
      [0, 'iframe 里有一座城'], [14, 'shim 为它点亮路灯'], [30, '指针翻过山脊'],
      [46, '事件按时到达'], [63, 'WebWallGL，网页正在播放'],
      [88, '(instrumental)'], [118, '每一帧都是同源'], [134, '每一次点击都有回声'],
      [152, '网页正在播放'], [170, '不停歇'],
    ],
  },
  {
    title: 'WebWallGL', artist: 'oneincase', album: 'Video', albumArtist: 'oneincase',
    duration: 241,
    colors: LOGO_COLORS,
    thumbnail: MEDIA_LOGO_DATA_URL,
    lyrics: [
      [0, '解码器推开第一帧'], [16, '循环点没有缝隙'], [33, '帧率贴着心跳走'],
      [52, '画面不旧'], [70, '时间一直新'], [92, '（间奏）'],
      [130, '把像素交给硬件'], [148, '把流畅留给眼睛'], [172, '一圈一圈'], [200, '都是第一圈'], [226, '……'],
    ],
  },
  {
    title: 'WebWallGL', artist: 'oneincase', album: 'Live', albumArtist: 'oneincase',
    duration: 168,
    colors: LOGO_COLORS,
    thumbnail: MEDIA_LOGO_DATA_URL,
    lyrics: [
      [0, '麦克风听见房间'], [11, '频谱开出六十四个窗口'], [24, '正在播放的歌'],
      [38, '有名字也有封面'], [55, 'WebWallGL 实况'], [76, '(drop)'],
      [104, '系统在说它在听'], [122, '壁纸在跟着唱'], [146, '…'],
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
    /** 当前曲封面（data URL）。网页壁纸的 mediaThumbnailChanged 直接透传；
     * 场景壁纸由宿主解码上传成 $mediaThumbnail 纹理（1.3.7 通道） */
    thumbnail: '',
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
    // 曲间空隙没有封面（与 hasThumbnail 同步）；有曲时给当前曲封面（本库 logo）
    snapshot.thumbnail = inGap ? '' : (tr.thumbnail || '')
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
