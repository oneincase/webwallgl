// WebWallGL 公共类型入口（随 dist 发布为 dist/lib/webwallgl.d.ts）。
//
// ⚠️ 维护约束：函数签名是**手写的契约面**，全部类型来自 api/types.ts
// （tsc 自动生成到 dist/lib/types，构建时由 build:lib 拷贝拼接）。
// 改 api/mount.ts / api/source.ts 的**函数签名**时必须同步本文件 ——
// 类型本体（MountOptions/SceneInstance/Source 等）改 api/types.ts 即可自动带出。

export {
  type Fit,
  type Source,
  type MountOptions,
  type SceneInstance,
  type SceneInfo,
  type SceneEvents,
  type FrameStats,
  type PropertyValue,
  type FeatureFlags,
  type PointerSource,
  type AudioSource,
  type MediaSource,
  type DiagnosticLevel,
} from "./types";

export declare function mount(
  el: HTMLElement,
  options: MountOptions,
): Promise<SceneInstance>;

export declare function createScene(
  el: HTMLElement,
  options?: Partial<Omit<MountOptions, "source">>,
): SceneInstance;

export declare function httpSource(baseUrl: string, init?: RequestInit): Source;

export declare function fileSource(file: File | Blob, project?: unknown): Source;

export declare function bytesSource(
  pkg: ArrayBuffer | Uint8Array,
  project?: unknown,
  key?: string,
): Source;
