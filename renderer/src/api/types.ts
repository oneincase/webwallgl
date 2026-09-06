// we-scene 公共 API 类型定义（唯一真源，`dist/we-scene.d.ts` 由此生成）
//
// 设计基线见 docs/LIBRARY-PLAN.md §3。三条约束反复体现在下面的取舍里：
//   1. 一个 mount() + 一个 SceneInstance，没有模块级全局状态；
//   2. 运行边界是**调用方传入的 canvas**，库不碰 document.body、不假设全屏；
//   3. 库不联网、不自带降级页 —— 资源经 Source 注入，失败经 onError 交回调用方。

/** 场景在 canvas 上的适配方式 */
export type Fit = "cover" | "contain" | "stretch";

/**
 * WE 用户属性的取值。project.json 的 general.properties 里只出现这几种标量：
 * bool → boolean，slider → number，combo/textinput/file/directory → string，
 * color → "r g b"（0..1 浮点三元组，仍是 string）。
 */
export type PropertyValue = boolean | number | string;

/** 场景资源来源。库对外只发两个请求，所以接口只有两个方法（见 LIBRARY-PLAN §4） */
export type Source = {
  /**
   * 场景容器（scene.pkg）字节。实现方只管给字节，解析由库负责。
   * 抛错即视为该场景不可用，会走 onError。
   * 网页壁纸（project.type=web）不会调用本方法。
   */
  scenePkg(signal?: AbortSignal): Promise<ArrayBuffer | Uint8Array>;
  /**
   * 属性表（project.json）。可选，且返回 null 合法 —— 真实壁纸库里大量场景
   * 没有 project.json，此时场景字段一律用 scene.json 内的快照值。
   */
  project?(signal?: AbortSignal): Promise<unknown | null>;
  /**
   * 网页壁纸入口 URL（index.html 等）。`project.type` 为 web 时由 mount 调用；
   * 省略则回退到 `{httpSource 基址}/{project.file || "index.html"}`。
   */
  webEntry?(signal?: AbortSignal): Promise<{ url: string } | null>;
  /**
   * 缓存键。相同键的 scene.pkg 命中库内缓存，避免重复解析上百 MB 的包
   * （暂停恢复、改属性都不该重新走一遍解析）。省略则不参与缓存。
   */
  readonly key?: string;
};

/**
 * 指针状态提供者。默认实现监听传入 canvas 自身的 pointer 事件；
 * 传 null 则禁用指针交互（壁纸脚本读到的指针恒为静止居中）。
 */
export type PointerSource = {
  /** 归一化坐标 0..1，相对 canvas 左上角；y 向下 */
  readonly x: number;
  readonly y: number;
  readonly leftDown: boolean;
  readonly rightDown: boolean;
  /** 指针是否在 canvas 内 */
  readonly inside: boolean;
};

/**
 * 音频频谱提供者（音频响应壁纸用）。返回当前快照，不推进状态 ——
 * 推进由库的渲染循环按场景时间驱动，保证同一时刻取到同一份数据。
 * 默认是内置的确定性模拟源（无需麦克风权限，离线可复现）。
 */
export type AudioSource = {
  /** 左右声道各 64 段频谱，值域 0..1 */
  snapshot(): { left: Float32Array | number[]; right: Float32Array | number[] };
};

/**
 * 系统媒体信息提供者（"正在播放"类壁纸用）。默认是内置模拟源。
 * 接真实数据时替换本接口即可，字段名与 WE 的 media* 回调一致。
 */
export type MediaSource = {
  snapshot(): {
    playing: boolean;
    title?: string;
    artist?: string;
    album?: string;
    /** 0..1 播放进度 */
    position?: number;
    durationSeconds?: number;
  };
};

/** 渲染开关。调试用，默认全开；对应旧 types.ts 的 SKIP_* 常量取反 */
export type FeatureFlags = {
  /** puppet 骨骼网格（人物模型） */
  models: boolean;
  /** 文字对象（时钟/日期等挂件） */
  text: boolean;
  /** 粒子（雪/雨/火花/雾/光轴） */
  particles: boolean;
  /** 图层效果链 */
  effects: boolean;
  /** WE 内置组件对象（本机库 0 个，真出现时按开关处理） */
  components: boolean;
};

/** 场景装配完成后的基本信息 */
export type SceneInfo = {
  /** 场景逻辑分辨率（scene.json 的 general.orthogonalprojection） */
  width: number;
  height: number;
  /** 图层数（已按 features 过滤后） */
  layerCount: number;
  /** 是否含 3D 模型 / 粒子 / 文字（便于调用方决定要不要降画质） */
  hasModels: boolean;
  hasParticles: boolean;
  hasText: boolean;
};

/** 诊断级别。库内部所有 reportDiag 都归到这三档 */
export type DiagnosticLevel = "info" | "warn" | "error";

export type SceneEvents = {
  ready: (info: SceneInfo) => void;
  error: (err: Error) => void;
  diagnostic: (msg: string, level: DiagnosticLevel) => void;
};

export type MountOptions = {
  /** 资源来源（必填） */
  source: Source;

  /** 适配模式。默认 "cover" */
  fit?: Fit;
  /**
   * 渲染分辨率上限（有效 devicePixelRatio 封顶），越低越省显存。默认 1。
   * 实际使用 min(devicePixelRatio, renderDpr)。
   */
  renderDpr?: number;
  /** 帧率上限。默认 60。渲染循环跳过比目标更快的帧，降低 GPU 占用 */
  fps?: number;
  /**
   * 音量 0..1。默认 0（静音起步）—— 浏览器自动播放策略要求先有用户交互，
   * 非静音起步会让整个场景的音频节点被挂起。
   */
  volume?: number;
  /** 是否自动开始渲染循环。默认 true */
  autoplay?: boolean;

  /** 用户属性覆盖值（键为 project.json 里的属性名） */
  properties?: Record<string, PropertyValue>;

  /** 指针源。默认跟随 canvas 自身 pointer 事件；null = 禁用 */
  pointer?: PointerSource | null;
  /** 音频源。默认内置确定性模拟；null = 禁用（频谱恒为 0） */
  audio?: AudioSource | null;
  /** 系统媒体源。默认内置模拟；null = 禁用 */
  media?: MediaSource | null;

  /** 渲染开关（调试用） */
  features?: Partial<FeatureFlags>;

  /** 诊断回调。替代旧的 GET /diag 上报 */
  onDiagnostic?: SceneEvents["diagnostic"];
  /** 装配或渲染失败。库不自带降级页，由调用方决定怎么兜 */
  onError?: SceneEvents["error"];
  /** 首帧渲染完成 */
  onReady?: SceneEvents["ready"];
};

/** 帧率观测。running=false 表示已暂停或没在出帧（读数会归零而不是冻住） */
export type FrameStats = {
  fps: number;
  running: boolean;
};

export type SceneInstance = {
  /** 挂载目标（构造时传入；场景路径可能是内部自建的 canvas） */
  readonly canvas: HTMLCanvasElement;

  pause(): void;
  resume(): void;
  readonly paused: boolean;

  setFit(fit: Fit): void;
  setFps(fps: number): void;
  setVolume(volume: number): void;
  /** 改 DPR 需重建画布尺寸，内部自动重挂当前场景 */
  setRenderDpr(dpr: number): void;

  /**
   * 用户属性热更新。就地改属性表 / 效果常量 / 脚本沙箱，
   * **不重新拉取与解析 scene.pkg**（百 MB 包重挂是可感知的卡顿）。
   */
  setProperties(props: Record<string, PropertyValue>): void;
  /** 当前生效的属性值（扁平化后的 name → value） */
  getProperties(): Record<string, PropertyValue>;

  /** 换场景，复用同一 canvas 与 WebGL 上下文 */
  load(source: Source): Promise<void>;

  /** 释放 GL/视频/音频资源，保留配置（显示器睡眠等场景） */
  release(): void;
  /** 用保留的配置重建 */
  restore(): void;
  /** 彻底销毁：解绑事件监听、释放全部资源，之后不可再用 */
  destroy(): void;

  readonly stats: FrameStats;
  readonly info: SceneInfo | null;

  /** 事件订阅，返回取消函数 */
  on<K extends keyof SceneEvents>(ev: K, fn: SceneEvents[K]): () => void;
};
