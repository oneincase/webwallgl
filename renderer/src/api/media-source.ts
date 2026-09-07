// 媒体源构造辅助：把「宿主知道的那几个字段」补全成引擎要的完整快照。
//
// 为什么需要它：MediaSnapshot 有 18 个字段，且五个颜色**必须是带链式方法的
// 实例**——真实语料里的脚本会写
//   color = event.primaryColor.subtract(old).multiply(t).add(old)
// 给普通数组或 {x,y,z} 字面量会 TypeError 熔断整个脚本，症状是「换歌后整层
// 不见了」，且不报错、不熔断计数，极难排查（verify-media 为此专门有一节断言）。
//
// 宿主接系统 Now Playing 时通常只拿得到 title/artist/album/position/duration
// 与一张封面，剩下的（配色、歌词、trackIndex）要么没有、要么要自己算。
// 这里统一补默认值并保证类型正确，宿主只给已知字段即可。

import type {
  MediaColor,
  MediaPlaybackState,
  MediaSnapshot,
  MediaSource,
} from "./types";

/** 与引擎侧 MediaVec3 同构的颜色三元组（链式方法齐全，且都返回新实例） */
class Color implements MediaColor {
  x: number;
  y: number;
  z: number;
  constructor(x: number, y: number, z: number) {
    this.x = Number(x) || 0;
    this.y = Number(y) || 0;
    this.z = Number(z) || 0;
  }
  add(o: MediaColor): MediaColor {
    return new Color(this.x + o.x, this.y + o.y, this.z + o.z);
  }
  subtract(o: MediaColor): MediaColor {
    return new Color(this.x - o.x, this.y - o.y, this.z - o.z);
  }
  multiply(k: number | MediaColor): MediaColor {
    // 标量与逐分量两种形态都要支持：语料里 `.multiply(t / DURATION)` 是标量，
    // 而着色类脚本会用颜色乘颜色做混色
    if (typeof k === "number") return new Color(this.x * k, this.y * k, this.z * k);
    return new Color(this.x * k.x, this.y * k.y, this.z * k.z);
  }
  toString() {
    return `${this.x} ${this.y} ${this.z}`;
  }
}

/**
 * 构造一个媒体配色。接受 (r,g,b) 三个 0..1 分量，或 [r,g,b] / {x,y,z}。
 * 已经是本类型时原样返回（避免重复包装）。
 */
export function mediaColor(
  r: number | number[] | { x: number; y: number; z: number } | MediaColor,
  g?: number,
  b?: number,
): MediaColor {
  if (r instanceof Color) return r;
  if (Array.isArray(r)) return new Color(r[0] ?? 0, r[1] ?? 0, r[2] ?? 0);
  if (typeof r === "object" && r !== null) {
    const o = r as { x?: number; y?: number; z?: number };
    return new Color(o.x ?? 0, o.y ?? 0, o.z ?? 0);
  }
  return new Color(r as number, g ?? 0, b ?? 0);
}

/** 宿主通常拿得到的那部分字段；其余由本模块补默认值 */
export type MediaSourceInit = {
  hasMedia?: boolean;
  /** 0=停止 1=播放 2=暂停；也接受布尔 playing（true→1、false→2） */
  state?: MediaPlaybackState;
  playing?: boolean;
  title?: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
  /** 秒 */
  position?: number;
  duration?: number;
  hasThumbnail?: boolean;
  primaryColor?: Parameters<typeof mediaColor>[0];
  secondaryColor?: Parameters<typeof mediaColor>[0];
  tertiaryColor?: Parameters<typeof mediaColor>[0];
  textColor?: Parameters<typeof mediaColor>[0];
  highContrastColor?: Parameters<typeof mediaColor>[0];
  trackIndex?: number;
  lyrics?: Array<[number, string]>;
};

/** 控制方法：宿主转发给真实播放器 */
export type MediaSourceControls = {
  skipNext?(): void;
  skipPrevious?(): void;
  play?(): void;
  pause?(): void;
  playPause?(): void;
};

const DEF_PRIMARY: [number, number, number] = [0.35, 0.38, 0.45];
const DEF_SECONDARY: [number, number, number] = [0.12, 0.13, 0.17];
const DEF_TERTIARY: [number, number, number] = [0.72, 0.76, 0.84];
const DEF_TEXT: [number, number, number] = [0.95, 0.96, 0.98];

/** 按 position 在歌词表里定位当前行（歌词按时间升序；无歌词返回空行） */
function locateLyric(
  lyrics: Array<[number, string]>,
  position: number,
): { line: string; index: number } {
  if (!Array.isArray(lyrics) || lyrics.length === 0) return { line: "", index: -1 };
  let idx = -1;
  for (let i = 0; i < lyrics.length; i++) {
    const at = Number(lyrics[i]?.[0]);
    if (Number.isFinite(at) && at <= position) idx = i;
    else break;
  }
  return { line: idx >= 0 ? String(lyrics[idx][1] ?? "") : "", index: idx };
}

/** 把 init 归一化成一份完整、类型正确的快照 */
function buildSnapshot(init: MediaSourceInit): MediaSnapshot {
  const position = Number(init.position) || 0;
  const lyrics = Array.isArray(init.lyrics) ? init.lyrics : [];
  const { line, index } = locateLyric(lyrics, position);
  const state: MediaPlaybackState =
    init.state !== undefined ? init.state : init.playing === false ? 2 : init.playing ? 1 : 0;
  return {
    hasMedia: init.hasMedia ?? (init.title != null || init.artist != null || !!init.playing),
    state,
    title: String(init.title ?? ""),
    artist: String(init.artist ?? ""),
    album: String(init.album ?? ""),
    albumArtist: String(init.albumArtist ?? init.artist ?? ""),
    position,
    duration: Number(init.duration) || 0,
    hasThumbnail: init.hasThumbnail ?? false,
    primaryColor: mediaColor(init.primaryColor ?? DEF_PRIMARY),
    secondaryColor: mediaColor(init.secondaryColor ?? DEF_SECONDARY),
    tertiaryColor: mediaColor(init.tertiaryColor ?? DEF_TERTIARY),
    textColor: mediaColor(init.textColor ?? DEF_TEXT),
    highContrastColor: mediaColor(init.highContrastColor ?? init.textColor ?? DEF_TEXT),
    trackIndex: Number(init.trackIndex) || 0,
    lyrics,
    lyricLine: line,
    lyricIndex: index,
  };
}

/**
 * 用「宿主已知的那几个字段」构造一个合法的 MediaSource。
 *
 * ```
 * const src = createMediaSource({ title: "夜航星", artist: "相位迁移", playing: true },
 *                               { skipNext: () => player.next() });
 * wp.setMedia(src);
 * // 系统 Now Playing 变化时：
 * src.set({ title: "新歌", position: 0 });
 * ```
 *
 * 返回值多一个 `set(partial)`：合并进当前状态并重建快照（颜色/歌词行会跟着重算）。
 * 库每帧读 `snapshot` 并 diff 出 WE 的四个 media* 回调，所以只要 set 过，
 * 壁纸下一帧就能收到 mediaPropertiesChanged。
 */
export function createMediaSource(
  init: MediaSourceInit = {},
  controls: MediaSourceControls = {},
): MediaSource & { set(patch: MediaSourceInit): void } {
  let cur: MediaSourceInit = { ...init };
  let snap = buildSnapshot(cur);
  return {
    get snapshot() {
      return snap;
    },
    set(patch: MediaSourceInit) {
      cur = { ...cur, ...patch };
      snap = buildSnapshot(cur);
    },
    // 宿主的快照由外部事件驱动，不需要按帧自行推进；留空实现满足接口即可
    update() {},
    skipNext: controls.skipNext,
    skipPrevious: controls.skipPrevious,
    play: controls.play,
    pause: controls.pause,
    playPause: controls.playPause,
  };
}
