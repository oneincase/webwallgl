// WebWallGL 公共库出口（docs/LIBRARY-PLAN.md §2）
// npm 与 CDN 入口都指向本文件；只导出 §3 定稿的公共面。
export { mount, createScene } from "./mount";
export { httpSource, fileSource, bytesSource, mediaSource, sniffMediaType } from "./source";
export { createMediaSource, mediaColor } from "./media-source";
export type {
  Fit,
  Source,
  MountOptions,
  SceneInstance,
  SceneInfo,
  SceneEvents,
  FrameStats,
  PropertyValue,
  FeatureFlags,
  PointerSource,
  AudioSource,
  MediaSource,
  MediaSnapshot,
  MediaColor,
  MediaControl,
  MediaPlaybackState,
  DiagnosticLevel,
} from "./types";
