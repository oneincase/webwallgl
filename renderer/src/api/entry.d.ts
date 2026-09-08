// WebWallGL 公共类型入口（随 dist 发布为 dist/lib/webwallgl.d.ts）。
//
// ⚠️ 维护约束：函数签名是**手写的契约面**，全部类型来自 api/types.ts
// （tsc 自动生成到 dist/lib/types，构建时由 build:lib 拷贝拼接）。
// 改 api/index.ts 的**导出清单**或 mount/source/media-source 的**函数签名**时
// 必须同步本文件 —— 类型本体（MountOptions/SceneInstance/Source/MediaSourceInit
// 等）改 api/types.ts 即可自动带出。
//
// 只在 types.ts 里定义类型：别处（如 media-source.ts）定义的类型不进
// tsconfig.lib-types.json 的编译范围，本文件 import 它会解析失败。
//
// 漏声明一个运行时导出的后果不是"类型弱一点"，而是消费方 import 直接
// TS2305 编译不过（verify-arch 会比对 api/index.ts 与本文件的导出清单）。
//
// ⚠️ 必须 import 后再 export，不能写成 `export { type X } from "./types"`：
// 后者只做转发导出，**不把名字引入本文件作用域**，下面的函数签名会引用到
// 未定义标识符（tsc 报 TS2304 × 7）。消费方普遍开着 skipLibCheck，报错被吞掉，
// 症状是所有导出静默退化成 any —— 库看起来"能用"，实则零类型检查。
import type {
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
  MediaColorInit,
  MediaControl,
  MediaPlaybackState,
  MediaSourceInit,
  MediaSourceControls,
  DiagnosticLevel,
} from "./types";

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
  MediaColorInit,
  MediaControl,
  MediaPlaybackState,
  MediaSourceInit,
  MediaSourceControls,
  DiagnosticLevel,
};

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

export declare function mediaSource(
  urlOrFile: string | File | Blob,
  options?: { type?: "video" | "gif" | "image"; key?: string },
): Source;

export declare function sniffMediaType(
  url: string,
): "video" | "gif" | "image" | null;

export declare function createMediaSource(
  init?: MediaSourceInit,
  controls?: MediaSourceControls,
): MediaSource & { set(patch: MediaSourceInit): void };

export declare function mediaColor(
  r: MediaColorInit,
  g?: number,
  b?: number,
): MediaColor;
