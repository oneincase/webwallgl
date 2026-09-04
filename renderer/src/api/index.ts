// WebWallGL 公共库出口（docs/LIBRARY-PLAN.md §2）
// npm 与 CDN 入口都指向本文件；只导出 §3 定稿的公共面。
export { mount, createScene } from "./mount";
export { httpSource, fileSource, bytesSource } from "./source";
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
  DiagnosticLevel,
} from "./types";
