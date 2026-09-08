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
   * 媒体壁纸（video / gif / image）的资源 URL。`project.type` 为这三者之一时
   * 由 mount 调用；省略则回退到 `{httpSource 基址}/{project.file}`。
   *
   * 与 `webEntry` 分开而不是复用同一个方法：`webEntry` 的语义是「HTML 文档入口」
   * （交给 iframe 加载并注入 shim），媒体是「一个可直接喂给 <video>/<img> 的资源」，
   * 两者的消费方与失败模式都不同。`webEntry` 在 1.0.0 已公开，也不宜改语义。
   *
   * `type` 可选，用于纠正 project.json 里缺失或不准的类型；不给则以 project.type 为准。
   */
  mediaEntry?(signal?: AbortSignal): Promise<{ url: string; type?: string } | null>;
  /**
   * 缓存键。相同键的 scene.pkg 命中库内缓存，避免重复解析上百 MB 的包
   * （暂停恢复、改属性都不该重新走一遍解析）。省略则不参与缓存。
   */
  readonly key?: string;
  /**
   * 释放本来源占用的资源。实例 destroy() / 换源时调用一次。
   *
   * 目前只有 `mediaSource(File)` 需要：本地文件走 `URL.createObjectURL`，
   * 不 revoke 就是每换一次壁纸泄漏一个几十 MB 的 blob。
   */
  dispose?(): void;
};

/**
 * 指针状态提供者（**当前未接线**）。
 *
 * 默认指针来自 canvas 自身的 pointer 事件，由 mountScene 按 `cfg.canvas` 建立，
 * 与本接口无关。要从外部喂指针（桌面壁纸窗口在 underlay 层收不到鼠标）请用
 * `SceneInstance.pushPointer(u, v, buttons)` —— 那是引擎实际消费的推模式通道。
 *
 * 本接口保留是为了不破坏 1.0.0 已公开的类型；注意 `rightDown` 即便接线也不会
 * 生效：引擎的指针状态只消费按键位掩码的 bit0（左键），全库无壁纸读右键。
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
 *
 * **拉模式**：渲染循环每帧调一次 `snapshot()`。宿主每帧推 128 个浮点要走
 * 跨语言桥的字符串拼接与 JS 解析，60fps 下开销可观；让渲染器主动拉，
 * 宿主用同步原生桥直接返回即可。
 *
 * 契约：`left`/`right` 各 **64 段**、值域 **0..1**（已归一化）。段数不足 64
 * 会补零，多于 64 会截断。32/16 段降采样与 level/silent 由库自行派生，
 * 消费方（shader uniform、粒子、文字脚本）不区分数据来源。
 *
 * **scene 与 web 壁纸都生效**：网页壁纸经 iframe shim 的音频泵收到同一份数据
 * （泵逐帧选源，所以 mount() 之后再 setAudio 也能生效）。
 */
export type AudioSource = {
  /** 左右声道各 64 段频谱，值域 0..1 */
  snapshot(): { left: Float32Array | number[]; right: Float32Array | number[] };
};

/** WE 播放态：0=停止 1=播放 2=暂停（与 MediaPlaybackEvent 枚举一致） */
export type MediaPlaybackState = 0 | 1 | 2;

/**
 * 媒体配色的三元组。**必须是带链式方法的实例，不能是普通数组或对象**：
 * 真实语料里的脚本会写 `event.primaryColor.subtract(old).multiply(t).add(old)`，
 * 给数组会 TypeError 熔断整个脚本（症状是「换歌后整层不见了」）。
 * 用 `createMediaSource()` 构造快照可自动保证类型正确。
 */
export type MediaColor = {
  x: number;
  y: number;
  z: number;
  add(o: MediaColor): MediaColor;
  subtract(o: MediaColor): MediaColor;
  multiply(k: number | MediaColor): MediaColor;
};

/** 系统媒体快照。字段名与 WE 的 media* 回调载荷一致 */
export type MediaSnapshot = {
  /** 有没有正在播放的媒体会话；false 时其余字段无意义 */
  hasMedia: boolean;
  state: MediaPlaybackState;
  title: string;
  artist: string;
  album: string;
  albumArtist: string;
  /** 播放进度与总时长，单位**秒**（不是 0..1 比例） */
  position: number;
  duration: number;
  hasThumbnail: boolean;
  /**
   * 真实封面图（data URL 或同源 URL）。宿主能拿到系统封面时给这里，
   * 网页壁纸的 `mediaThumbnailChanged(e)` 会直接收到它作为 `e.thumbnail`。
   *
   * 留空时库用 primary/secondary 生成一张渐变占位图 —— 保证语料里
   * `img.src = e.thumbnail` 那类写法不会拿到空串，但显示的不是真专辑封面。
   *
   * 注意场景（WebGL）壁纸不消费图片本体，其脚本只读 `e.hasThumbnail` 与取色，
   * 所以这个字段只对网页壁纸有效。
   */
  thumbnail?: string;
  /** 封面取色。见 MediaColor 的类型约束 */
  primaryColor: MediaColor;
  secondaryColor: MediaColor;
  tertiaryColor: MediaColor;
  textColor: MediaColor;
  highContrastColor: MediaColor;
  /** 播放列表内的曲目序号（换歌检测用） */
  trackIndex: number;
  /** 歌词行：[秒, 文本][]，按时间升序 */
  lyrics: Array<[number, string]>;
  /** 当前歌词行与其下标（由 position 定位，库不重算） */
  lyricLine: string;
  lyricIndex: number;
};

/**
 * 系统媒体源（"正在播放"类壁纸用）。默认是内置模拟源。
 *
 * **scene 与 web 壁纸共用同一个实例**：宿主装一次，两类壁纸看到同一份 Now Playing。
 * 库每帧调 `update(tSec)` 推进、读 `snapshot` 取值，并自动 diff 出 WE 的
 * mediaStatusChanged / mediaPropertiesChanged / mediaPlaybackChanged /
 * mediaThumbnailChanged 四个回调派发给壁纸脚本。
 *
 * 五个控制方法是**反向控制**：壁纸里的"上一曲/下一曲/播放暂停"按钮会调到这里，
 * 由你转发给真实播放器。库只负责调用并在之后立刻重新派发一次事件。
 *
 * 自己实现全部字段很繁琐，用 `createMediaSource(partial)` 只给已知字段即可。
 */
export type MediaSource = {
  /** 每帧由渲染循环推进（tSec 为场景时间，秒）。无状态的实现可留空函数 */
  update?(tSec: number): void;
  readonly snapshot: MediaSnapshot;
  skipNext?(): void;
  skipPrevious?(): void;
  play?(): void;
  pause?(): void;
  playPause?(): void;
};

/**
 * `createMediaSource(init, controls)` 的 init：宿主通常拿得到的那部分字段，
 * 其余（配色、歌词行、trackIndex）由库补默认值。
 *
 * 类型本体放在这里而不是 api/media-source.ts，是因为只有本文件会被
 * tsconfig.lib-types.json 编成发布的 types.d.ts —— 定义在别处的话
 * 消费方 `import { createMediaSource } from "webwallgl"` 摸不到入参类型。
 */
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
  /**
   * 真实封面图（data URL 或同源 URL）。给了就直接透给网页壁纸的
   * `mediaThumbnailChanged(e).thumbnail`；不给则库生成渐变占位图。
   * 传了非空值时 hasThumbnail 自动视为 true
   */
  thumbnail?: string;
  primaryColor?: MediaColorInit;
  secondaryColor?: MediaColorInit;
  tertiaryColor?: MediaColorInit;
  textColor?: MediaColorInit;
  highContrastColor?: MediaColorInit;
  trackIndex?: number;
  /** [秒, 文本] 按时间升序；库按 position 定位当前行 */
  lyrics?: Array<[number, string]>;
};

/** `mediaColor()` 与配色字段接受的形态 */
export type MediaColorInit =
  | number
  | number[]
  | { x: number; y: number; z: number }
  | MediaColor;

/** `createMediaSource(init, controls)` 的 controls：宿主转发给真实播放器 */
export type MediaSourceControls = {
  skipNext?(): void;
  skipPrevious?(): void;
  play?(): void;
  pause?(): void;
  playPause?(): void;
};

/** 壁纸侧可用的媒体控制面（SceneInstance.media） */
export type MediaControl = {
  readonly snapshot: MediaSnapshot;
  skipNext(): MediaSnapshot;
  skipPrevious(): MediaSnapshot;
  play(): MediaSnapshot;
  pause(): MediaSnapshot;
  playPause(): MediaSnapshot;
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

  /** 指针源。**当前未接线**，见 PointerSource 说明；外部喂指针请用 pushPointer() */
  pointer?: PointerSource | null;
  /**
   * 音频频谱源。默认内置确定性模拟；null = 禁用（频谱恒为 0）。
   * 挂载后可用 `SceneInstance.setAudio()` 再换（SSE 等异步数据源常在挂载后才就绪）。
   */
  audio?: AudioSource | null;
  /**
   * 系统媒体源（Now Playing）。默认内置模拟；null = 禁用。
   * scene 与 web 壁纸共用同一个实例；挂载后可用 `setMedia()` 再换。
   */
  media?: MediaSource | null;

  /** 渲染开关（调试用）。**当前未接线** */
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

  /**
   * 换音频频谱源。传 null 回落内置模拟源。
   *
   * 与挂载选项 `audio` 等价，但可在任何时刻调用 —— 宿主的频谱通道
   * （SSE / 原生桥 / WebAudio）常常在 mount() 之后才就绪。
   * **换场景不清空**：装一次对之后所有场景生效。
   *
   * scene 与 web 壁纸都生效（网页侧经 iframe shim 的音频泵拿到同一份数据）。
   */
  setAudio(src: AudioSource | null): void;

  /**
   * 换系统媒体源（Now Playing）。传 null 回落内置模拟源。
   *
   * 与 `setAudio` 同纪律：**换场景不清空**，装一次对之后所有场景生效。
   * scene 与 web 壁纸吃同一个实例。
   */
  setMedia(src: MediaSource | null): void;

  /**
   * 媒体控制面：读当前快照，以及壁纸侧同款的播放控制。
   *
   * 调用控制方法会转发给当前 media 源并**立即重新派发一次事件**，
   * 壁纸里的歌名/封面/进度会同帧更新，不必等下一轮 diff。
   */
  readonly media: MediaControl;

  /**
   * 外部指针注入：把宿主轮询到的鼠标位置推进壁纸。
   *
   * 用于窗口收不到鼠标事件的场景 —— 桌面壁纸叠在桌面 underlay 层，
   * macOS 下 Finder 的桌面窗口会吃掉事件，且没有「向下透传」的窗口属性。
   *
   * @param u 归一化横坐标 0..1（相对画布左缘）
   * @param v 归一化纵坐标 0..1（相对画布上缘，y 向下）
   * @param buttons 按键位掩码，同 MouseEvent.buttons；只有 bit0（左键）被消费
   *
   * 与 canvas 自身的 DOM 指针监听并存，谁后写谁赢。scene 与 web 壁纸都生效，
   * 媒体壁纸（video/gif/image）没有指针概念，调用静默无效。
   */
  pushPointer(u: number, v: number, buttons?: number): void;

  /**
   * 外部指针离开本窗口（鼠标移到了别的显示器）。
   *
   * **只清按键，保留最后位置** —— 清掉位置会让 xray 开窗跳到相机外、
   * 视差弹回中心，画面明显抽一下。语义与 DOM 的 mouseleave 一致。
   */
  pointerLeave(): void;

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
