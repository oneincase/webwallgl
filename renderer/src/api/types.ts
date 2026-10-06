// we-scene 公共 API 类型定义（唯一真源，`dist/we-scene.d.ts` 由此生成）
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

/**
 * 松散目录（源码工程）形态的场景资源读取器。
 *
 * 为什么需要：WE 编辑器工程（官方内置 `defaultprojects`、`myprojects/`）在盘上是
 * **散装目录** —— `project.json` / `scene.json` / `materials/` / `models/` /
 * `shaders/` …，没有 scene.pkg。形态判定只看一个字段：`project.json` 的 `file`
 * 以 `.json` 结尾 = 松散、以 `.pkg` 结尾 = 包（见 `api/source.ts::sceneFormOf`）。
 *
 * 松散形态没有目录清单（宿主只有 `GET {mediaBase}/{itemId}/<path>` 一条路由），
 * 所以资源按相对路径**按名取**、缺文件返回 null —— 与 pkg 形态 `getEntry` 的
 * 「命中 / 未命中」语义一一对应，装配期代码不必知道形态差异。
 */
export type SceneDirAssets = {
  /** 场景入口 json 的相对路径（来自 project.json 的 `file`，如 scene.json / audiophile.json） */
  readonly entry: string;
  /**
   * 按相对路径取一个资源；不存在返回 null。实现方按名缓存（同一路径不重复走网络）；
   * 切场景的 abort 如实抛出 —— 不能把 abort 当成「文件不存在」写进缓存。
   */
  read(name: string, signal?: AbortSignal): Promise<Uint8Array | null>;
  /** 已缓存字节数（缓存配额与诊断口径用）。可选 */
  bytes?(): number;
};

/** 场景资源来源。库对外只发两个请求，所以接口只有两个方法（见 LIBRARY-PLAN §4） */
export type Source = {
  /**
   * 场景容器（scene.pkg）字节。实现方只管给字节，解析由库负责。
   * 抛错即视为该场景不可用，会走 onError。
   * 网页壁纸（project.type=web）不会调用本方法。
   */
  scenePkg(signal?: AbortSignal): Promise<ArrayBuffer | Uint8Array>;
  /**
   * 松散目录形态的读取器（可选）。返回非 null = 这张场景以散装工程渲染，
   * 装配期所有「按名取资源」都走它；返回 null = 按 scene.pkg 走。
   *
   * 判定与回退都在实现方（httpSource）：`project.file` 以 `.json` 结尾才试松散，
   * 入口 json 取不到就返回 null 让调用方回退 pkg —— 真实库里大量条目的
   * project.json 声明 `file: "scene.json"` 而盘上只有 scene.pkg，没有这条回退
   * 它们会整场挂掉。
   */
  sceneDir?(signal?: AbortSignal): Promise<SceneDirAssets | null>;
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
 * 默认是内置的确定性模拟源（无需任何系统授权，离线可复现）。
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

// ---- 渲染质量设置（对标 WE 客户端的壁纸性能选项）----
// 运行时的映射表与 normalize 在 renderer/src/quality.ts；这里只放公共类型
// （本文件是生成 d.ts 的唯一真源，必须保持零 import）。

/** 抗锯齿模式。off=关闭（默认）；fxaa=帧末后处理抗锯齿（平滑所有边缘，含纹理
 *  alpha 边）；msaa2/msaa4=多重采样（只平滑几何边缘，与 WE 的 MSAA 语义一致）。
 *  单选不叠加。 */
export type AntiAliasingMode = "off" | "fxaa" | "msaa2" | "msaa4";

/** 粒子质量档。off=不渲染不推进；low/medium 按倍率同时缩 maxcount 上限与
 *  发射率；high=原始配置（默认）。 */
export type ParticleQuality = "off" | "low" | "medium" | "high";

/** 后处理质量档。off=图层效果链直通 + 跳过整屏后期层 + 关内置 Bloom；
 *  low/medium/high=效果链开启，仅效果链 FBO 分辨率预算不同。 */
export type PostQuality = "off" | "low" | "medium" | "high";

/** 质量设置（缺省键按默认值补全：AA off / 粒子 high / 后处理 high） */
export type QualityOptions = {
  antiAliasing?: AntiAliasingMode;
  particles?: ParticleQuality;
  postProcessing?: PostQuality;
};

/** 三项齐全的规范化结果（getQuality / normalizeQuality 的输出） */
export type ResolvedQuality = {
  antiAliasing: AntiAliasingMode;
  particles: ParticleQuality;
  postProcessing: PostQuality;
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

/**
 * 诊断级别 —— **由库自己声明**，随每条诊断一起给出（回调的第 2 参、`/diag` 像素
 * 请求的 `lvl=` query 参数都是同一个值），嵌入方不必再对文案做关键字匹配
 * （issue #13）。三档按**后果**分：
 *
 * - `error`：壁纸挂不上或已经死了，**需要调用方介入** —— 挂载失败、渲染循环终止、
 *   首帧超时、宿主/环境缺位到挂不上（无可用容器、缺 src、WEBGL2 不可用）。
 * - `warn`：画面受影响或有损降级，**壁纸仍在跑** —— 脚本没跑起来、资源缺失或
 *   解码失败、效果/贴图回退与跳过、文字被裁切、自动降档限速、非致命的失败。
 * - `info`：过程与统计 —— 尺寸、计数、命中、状态、正常完成（含「失败 0」这类
 *   零计数的正常完成）。
 *
 * 需要「宿主/环境级故障」这类**别的维度**的嵌入方可按自己的口径映射；库不替
 * 调用方判定宿主环境。历史文案判据（`/fail|error|失败|ERROR/`）已被淘汰：它把
 * `bake: …（失败 0，…）` 这种**正常完成**打成 error，也漏掉 `不可用`/`fallback`
 * 这类降级。
 */
export type DiagnosticLevel = "info" | "warn" | "error";

export type SceneEvents = {
  ready: (info: SceneInfo) => void;
  /**
   * 致命错误。WebGL 上下文丢失时 `err.name === "ContextLostError"`：引擎不重建 GL 资源，
   * 调用方按需 destroy 后重新 mount（mount 会换新画布）。
   */
  error: (err: Error) => void;
  diagnostic: (msg: string, level: DiagnosticLevel) => void;
};

export type MountOptions = {
  /** 资源来源（必填） */
  source: Source;

  /** 适配模式。默认 "cover" */
  fit?: Fit;
  /**
   * 渲染分辨率 DPR，决定 backing store = CSS 像素 × DPR。
   * - 0 或不传（默认）：自动跟随设备 devicePixelRatio，Retina/HiDPI 屏原生清晰；
   * - 正数：目标 DPR，**允许高于设备上报值**（某些壁纸宿主 WKWebView 把
   *   devicePixelRatio 报成 1，传 2 仍按 2 超采样到物理分辨率）；
   * 物理最长边封顶 4096 防爆显存，超出等比回收。调低（如 1）可省显存。
   */
  renderDpr?: number;
  /**
   * 视频纹理上传倍率：0/缺省 = 自动（帧率守门按实测帧率压，见 quality.ts），
   * 正数 = 固定（1 = 不压最清晰、0.5 = 半幅最省）。显式值优先于自动下坡。
   *
   * 为什么需要：macOS WKWebView 下逐帧 `texImage2D(视频帧)` 要同步跨进程取像素，
   * 代价随像素数线性（全屏视频层 2570×1446 → 16fps，1285×723 → 29fps，上限 30）。
   * 宿主把它做成用户可选项（画质页），在清晰与流畅之间自己定。
   */
  videoTexScale?: number;
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

  /**
   * 是否执行壁纸自带的 SceneScript（对象字段 / 文字 / 效果开关 / 材质常量脚本）。默认 true。
   * 传 `false` 时一律不求值，字段停在 scene.json 的快照值。沙箱并非安全边界
   * （`Function` / `eval` 无法遮蔽），打开来路不明的壁纸、且与宿主页面同源时应关掉。
   * 只影响场景壁纸；网页壁纸本身就是页面脚本，不受此项控制。
   */
  scripts?: boolean;

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

  /**
   * 渲染质量设置（抗锯齿/粒子/后处理档位，见 quality.ts）。
   * 缺省 = 全默认（AA off、粒子 high、后处理 high），与引入前的行为一致。
   * 挂载后可用 `SceneInstance.setQuality()` 热调。
   */
  quality?: QualityOptions;
  /**
   * 自动降档（默认开）：探到软件渲染（无 GPU）时自动关后处理 + 压画布分辨率；
   * 运行期帧率连续 3 秒低于上限 85% 时把后处理降一档（high→medium→low→off，只降不升）。
   * **只填宿主没显式指定的键** —— 显式的 `quality.postProcessing` 永远优先；传 `false` 整体关闭。
   * 实际生效值请读 `getQuality()`（返回的是生效值，可能已被自动降档改写）。
   */
  autoQuality?: boolean;
  /**
   * 贴图烘焙（默认开）：内嵌 PNG/JPEG 贴图的预缩放缓存。命中后省掉「解全尺寸再缩」
   * （实测 −80% 解码耗时，缓存产物比原图小），像素与不烘时逐位一致；
   * 未命中走原路径并后台补烘。传 `false`（或 `?bake=0`）关闭。目标尺寸取资源档位上限，
   * 所以窗口缩放不会导致重烘。详见 docs/BAKE-PLAN.md。
   */
  bake?: boolean;

  /**
   * 首帧看门狗（毫秒）。默认 `60000`；传 `0` 关闭（无上限等待）。
   *
   * `mount()` 的 Promise 只由首帧（`onReady`）或失败（`onError`）落地。渲染循环
   * 一旦无声死亡（例如帧回调里抛异常、rAF 链断掉），两个钩子都不会触发 ——
   * 调用方拿不到成功也拿不到失败，**无法区分「还在加载」和「已经死了」**，
   * 只能自己加一个看门狗去猜（issue #9 的原始症状）。
   *
   * 开了它，超时会 **reject** 并上报一条诊断（含已等待毫秒数 + 排查提示），
   * 宿主据此能立刻给出「这张壁纸挂不上」的结论而不是无限转圈。
   * 上限比任何真实装配都宽（本机最大的 100MB+ 场景包也在数秒内出首帧）；
   * 网络挂载慢的宿主可以调大，或按自己的看门狗口径传 0 关掉。
   */
  mountTimeoutMs?: number;

  /**
   * 调试钩子开关（默认 **关**）。
   *
   * 引擎侧有三个「改渲染行为」的手工排障开关：`__noMaterialProps`（材质文档不解析）、
   * `__noBuiltinMatTint`（跳过内置 material tint）、`__shaderPatch`（按名改写 shader 源）。
   * 壁纸页（`main.ts` 的全屏形态）默认允许它们 —— 那是既有排障工作流；但**库实例默认关**：
   * 库嵌进宿主页时，宿主页面上的同名全局不该能静默改变渲染（也不该被误当成配置读）。
   * 库调用方要复现这些 A/B 就显式传 `debugHooks: true`。
   */
  debugHooks?: boolean;

  /**
   * 遮挡分档配置（V5，可选）。宿主用 `setOcclusion()` 推遮挡矩形时按这套
   * 阈值分档（暂停 / 降帧 / 全量）；缺省全默认（见 OcclusionBands）。
   * 传 `false` 显式关闭：之后 `setOcclusion()` 静默无效（什么都不改）。
   * **不传或传配置对象都不改变默认行为** —— 没有推送就没有降载，
   * 不推遮挡的宿主与引入本功能前逐字节一致。
   */
  occlusion?: OcclusionBands | false;

  /**
   * 诊断回调（msg + 级别）。级别由库声明，与旧的 GET /diag 像素上报**同源**：
   * 两条通道带同一个 `DiagnosticLevel`，`/diag` 的 query 里另有 `lvl=` 显式给出。
   */
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
  /**
   * 遮挡暂停中（setOcclusion 推送的可见比例低于暂停阈值）：渲染循环已停、
   * 画面停在最后一帧。与用户 pause() 的区别：宿主撤掉遮挡载荷即自动恢复，
   * 不需要 resume()。stats 里显式带出，宿主看门狗才不会把「主动暂停」误判成故障。
   */
  occluded?: boolean;
  /** 遮挡降帧中（可见比例处于中/重降载档，帧率上限被压低） */
  throttled?: boolean;
};

// ---- 遮挡感知降载（V5）：宿主推遮挡矩形，库内算覆盖率分档 ----

/** 遮挡矩形：画布 CSS 像素、左上原点。四元组 [x, y, w, h] 或对象形态都收 */
export type OcclusionRectLike = [number, number, number, number] | { x: number; y: number; w: number; h: number };

/** 归一化后的遮挡矩形（库内部统一形态：四元组） */
export type OcclusionRect = [number, number, number, number];

/**
 * 一次遮挡推送。宿主枚举上层窗口矩形、换算到壁纸窗口的 CSS 像素空间后推给
 * `setOcclusion()`；推送频率与去抖由宿主决定（建议变化才推、30~50ms 合并，
 * **且需 ≤2s 心跳重推当前态** —— 库的 fail-open 以「3s 无推送」为准，纯
 * 变化才推会在静态遮挡 3s 后被误判失联恢复全量，下次变化再暂停来回抖动）。
 *
 * - `occluders`：遮挡矩形列表（空数组 = 完全可见）
 * - `ratio`：宿主侧算好的**可见比例** 0..1（可选；缺省库内用遮挡分解的精确
 *   可见比例，见 occlusion.ts 头注 —— 网格覆盖率只作对照读数）
 * - `epoch`/`gen`：宿主会话 id 与会话内单调序号。`epoch` 变化或 `gen` 回退
 *   视为宿主重启，库整体重置跟踪状态（防新会话的载荷被当乱序丢弃）
 * - **fail-open**：超过 3 秒没有新推送，库自动恢复全量渲染（宿主崩溃/通道
 *   断连不能把壁纸冻在暂停态）
 */
export type OcclusionPayload = {
  occluders: OcclusionRectLike[];
  ratio?: number;
  epoch?: number | string;
  gen?: number;
};

/**
 * 遮挡分档配置（缺省键按默认值补全）。阈值语义为**可见比例**（越小遮得越狠）：
 * `≤pause`（默认 0.05，对齐 Lively Grid 算法 95% 覆盖暂停）→ 暂停；
 * `≤heavy`（默认 0.30）→ 压到 heavyFps（默认 24）；
 * `≤light`（默认 0.70）→ 压到 lightFps（默认 40）；其余全量。
 * 档位切换带滞回（默认 5pp）与最小驻留（默认 400ms），拖动窗口不会抖档。
 * fps 档位下限 20：低于它粒子/脚本与骨骼动画会肉眼可辨地失步（双时钟约束）。
 */
export type OcclusionBands = {
  pause?: number;
  heavy?: number;
  light?: number;
  heavyFps?: number;
  lightFps?: number;
  /** 滞回量（0..0.15，比例点） */
  hysteresis?: number;
  /** 档位切换最小驻留（0..2000ms） */
  dwellMs?: number;
};

/** 三档齐全的规范化结果（normalizeOcclusionConfig 的输出，库内部用） */
export type OcclusionBandConfig = {
  pause: number;
  heavy: number;
  light: number;
  heavyFps: number;
  lightFps: number;
  hysteresis: number;
  dwellMs: number;
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
   * 渲染质量设置热更（对标 WE 客户端的性能选项：抗锯齿/粒子/后处理档位）。
   * 部分更新：只传要改的键。**就地生效，不重挂载**（与 setRenderDpr 不同）。
   * 换场景/load() 之后保持（与 setAudio 同纪律，合并进挂载选项）。
   */
  setQuality(patch: QualityOptions): void;
  /** 视频纹理上传倍率热更（0 = 自动交给帧率守门；>0 固定，1 = 不压） */
  setVideoTexScale(scale: number): void;
  /** 当前请求的倍率（0 = 自动） */
  getVideoTexScale(): number;

  /**
   * 遮挡推送（V5）：把宿主算好的遮挡矩形列表喂给库，库按 `MountOptions.occlusion`
   * 的分档配置自动暂停/降帧/恢复（见 OcclusionPayload 的字段契约与 fail-open 语义）。
   *
   * - 传 `null` 或不再推送：恢复全量渲染（与 fail-open 同语义）
   * - 降帧覆盖面：scene 与 GL/WebCodecs 媒体由渲染循环逐帧收敛；web 壁纸经
   *   shim setFps 推送（**尽力降帧** —— 只覆盖 shim 注入的 rAF 驱动主循环，
   *   setTimeout 循环 / CSS 合成器动画 / 页内媒体管不到）；DOM `<video>`
   *   直显只能 pause（视频元素无法限帧）；image/gif 走 GL 路径同样有降帧
   * - **换场景/load() 之后保持生效**（与 setAudio 同纪律），重挂（setRenderDpr/
   *   restore）后 ROI 状态不保留 —— 宿主在重挂完成事件后重推一次即可
   * - 与用户 pause() 独立记账：遮挡暂停不会清掉用户的暂停意图，
   *   `stats.occluded` / `stats.throttled` 如实反映遮挡侧状态
   */
  setOcclusion(payload: OcclusionPayload | null): void;
  /** 当前生效的质量设置（三项齐全，缺省键已按默认值补全） */
  getQuality(): ResolvedQuality;

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
   * @param mods 修饰键位掩码：bit0 ctrl / bit1 shift / bit2 alt / bit3 meta。
   *   省略等于 0。只有 web 壁纸消费（合成事件的 ctrlKey 等字段）
   *
   * 与 canvas 自身的 DOM 指针监听并存，谁后写谁赢。scene 与 web 壁纸都生效，
   * 媒体壁纸（video/gif/image）没有指针概念，调用静默无效。
   */
  pushPointer(u: number, v: number, buttons?: number, mods?: number): void;

  /**
   * 外部指针离开本窗口（鼠标移到了别的显示器）。
   *
   * **只清按键，保留最后位置** —— 清掉位置会让 xray 开窗跳到相机外、
   * 视差弹回中心，画面明显抽一下。语义与 DOM 的 mouseleave 一致。
   */
  pointerLeave(): void;

  /**
   * 外部滚轮注入：把宿主捕获的滚轮 / 触摸板手势推进壁纸。
   *
   * **只有 web 壁纸生效。** scene 壁纸静默无效不是遗漏：WE 的场景脚本沙箱
   * 不暴露任何滚轮 API，实测 194 张场景壁纸零消费（场景包里的 `scroll`
   * 全都是纹理滚动 shader 的 `g_ScrollSpeed`，与鼠标无关）。
   *
   * @param dx 横向滚动量，正 = 内容向右（与 WheelEvent.deltaX 同向同量级）
   * @param dy 纵向滚动量，正 = 内容向下（与 WheelEvent.deltaY 同向；
   *   macOS 原生 NSEvent.scrollingDeltaY 是**反向**的，宿主需取反）
   * @param mode 同 WheelEvent.deltaMode：0 像素 / 1 行 / 2 页。触摸板恒为 0
   * @param mods 修饰键位掩码，bit0 ctrl。**触摸板双指捏合应映射成 ctrl + 滚轮**
   *   —— 浏览器就是这样把 macOS 的 magnify 手势喂给网页的，
   *   OrbitControls / pano2vr 一族都靠 `event.ctrlKey` 区分缩放与滚动
   *
   * 位置沿用最后一次 `pushPointer()` 的坐标（滚轮事件本身不带位置）。
   */
  pushWheel(dx: number, dy: number, mode?: number, mods?: number): void;

  /** 换场景，复用同一 canvas 与 WebGL 上下文 */
  load(source: Source): Promise<void>;

  /** 释放 GL/视频/音频资源，保留配置（显示器睡眠等场景） */
  release(): void;
  /** 用保留的配置重建 */
  restore(): void;
  /**
   * 彻底销毁：解绑事件监听、释放全部资源，之后不可再用。
   * `releasePkgCache: true` 连带淘汰本实例 source 的 scene.pkg 解析缓存 ——
   * 缓存默认跨实例保留（同壁纸重挂不重新下载），宿主"销毁即放弃"的语义
   * （如桌面壁纸逐张切换）需要显式声明，否则旧包会压在缓存里不落内存。
   */
  destroy(opts?: { releasePkgCache?: boolean }): void;

  readonly stats: FrameStats;
  readonly info: SceneInfo | null;

  /** 事件订阅，返回取消函数 */
  on<K extends keyof SceneEvents>(ev: K, fn: SceneEvents[K]): () => void;
};

// ─── 编辑器包（webwallgl/editor）E0 能力面 ───────────────────────────────
// docs/EDITOR-PLAN.md W1–W4 + W2a：只在编辑器包出口经 editorOf(instance) 取得，
// 播放包的 SceneInstance 不加方法（播放宿主零感知）。

/** 引擎活层的种类（由解析后的层字段归类，与 scene.json 对象一一对应） */
export type EditorLayerKind =
  | "image"
  | "text"
  | "particle"
  | "sound"
  | "light"
  | "container"
  | "group"
  | "model";

/** 引擎活层的只读快照（W2a）。`id` 即 scene.json 对象 id，可与文档树对应 */
export type EditorLayer = {
  readonly id: number;
  readonly name: string;
  readonly kind: EditorLayerKind;
  /**
   * 模型层的形态（W12）：puppet = 图片对象引用的 model json 带 `puppet`（2D 骨骼网格）；
   * mesh = 对象直接挂 `model: "*.mdl"`（真 3D）。模型解析成功才有，否则该层按 image / group 归类
   */
  readonly modelForm?: "puppet" | "mesh";
  readonly parentId: number | null;
  /** 有效可见性（含祖先与脚本写入） */
  readonly visible: boolean;
  /** 绘制顺序（scene.layers 下标，大的在上） */
  readonly index: number;
};

export type EditorCaptureOptions = {
  /** 先 seek 到该场景时刻再出图（秒）；缺省 = 当前画面 */
  time?: number;
  /** 输出像素尺寸；缺省 = 画布 backing store 尺寸。只给一边按画布比例补另一边 */
  width?: number;
  height?: number;
  /** MIME，缺省 "image/png" */
  type?: string;
  /** 有损格式质量 0..1 */
  quality?: number;
};

export type EditorFrameOptions = Pick<EditorCaptureOptions, "time" | "width" | "height"> & {
  /**
   * 出图后不把画布复原到容器尺寸（逐帧录制：连续出图时省掉每帧两次改 backing store）；
   * 录完 seek 一次即复原
   */
  keepSize?: boolean;
};

/**
 * 图层可热改属性（W2-lite），单位与 scene.json 一致：origin/scale/angles 是
 * **父级相对**（local）值，angles 为弧度，color 为 0..1 RGB。
 */
export type EditorLayerProps = {
  origin: [number, number, number];
  scale: [number, number, number];
  angles: [number, number, number];
  /** 自身可见性（不含祖先） */
  visible: boolean;
  alpha: number;
  color: [number, number, number];
};

/** 图层在画布上的轮廓（CSS 像素，相对画布左上角） */
export type EditorLayerOutline = {
  anchor: [number, number];
  /** OBB 四角（左上起顺时针）；零尺寸层 / 透视层为 null */
  corners: Array<[number, number]> | null;
  /**
   * 模型层（W15）：当前姿势蒙皮网格在画布上的凸包（CSS 像素，逆时针）。
   * 透视相机场景里只有模型层有轮廓：corners 为 null、anchor 是网格原点的投影。
   */
  hull?: Array<[number, number]>;
};

/**
 * 模型层的只读信息（W12），全部取自装配期已解析的 .mdl，不做新解析。
 * 骨骼 / 动画 / 附着点下标与 .mdl 内顺序一致（`animationlayers[].animation` 对应 animations[].id）。
 */
export type EditorModelInfo = {
  form: "puppet" | "mesh";
  /** 工程内 .mdl 路径 */
  mdlPath: string;
  /** puppet 的 model json 路径（对象的 image 字段）；mesh 为 null */
  modelJsonPath: string | null;
  /** MDL 版本（如 "MDLV0023"） */
  version: string;
  vertexCount: number;
  bones: Array<{ name: string; parent: number }>;
  animations: Array<{
    id: number;
    name: string;
    /** loop / mirror / single */
    mode: string;
    fps: number;
    frameCount: number;
    /** 片段时长（秒）= frameCount / fps */
    duration: number;
    events: Array<{ frame: number; name: string }>;
  }>;
  /**
   * 附着点。bindOrigin = 绑定姿势下附着点在模型网格空间的位置（Y 向上，相对模型层 origin、未乘层缩放 / 旋转），
   * 与引擎挂件定位（applyAttachmentBindOrigins）同一套矩阵链
   */
  attachments: Array<{ name: string; bone: number; bindOrigin: [number, number, number] }>;
  /** 子网格：材质 json 路径、顶点数、槽 0 贴图（引擎实际加载的；没加载成功为 null） */
  meshes: Array<{ materialPath: string | null; vertexCount: number; texture: string | null }>;
};

/**
 * 模型层附着点此刻的状态（W14）。offset = 挂在这里的层被引擎额外加进局部 origin 的偏移
 *（模型网格空间、Y 向上、未乘模型层缩放 / 旋转；= 绑定偏移 + 当前姿势相对绑定姿势的跟随增量），
 * 页面据此做「绑定 / 解绑前后世界位置不变」的换算。screen = 附着点的画布 CSS 像素位置（透视相机场景为 null）
 */
export type EditorAttachmentPoint = {
  name: string;
  offset: [number, number];
  screen: [number, number] | null;
};

export type EditorHitTestOptions = {
  /** 连 visible=false / alpha=0 的层也算（WE 的隐形点击区）；缺省只认看得见的层 */
  includeHidden?: boolean;
};

/**
 * 编辑器控制面（E0）。时钟语义：场景时间 = 可重设基准 + 墙钟增量 × 倍速。
 * 关键帧/骨骼/音频模拟按绝对时刻求值，seek 精确；粒子、对象脚本、跟随类
 * 动画是有状态的增量模拟，seek 后从当前状态继续推进（近似，不回放历史）。
 */
export type EditorControls = {
  /** 当前场景时间（秒） */
  readonly time: number;
  readonly timeScale: number;
  /** 跳到场景时刻 t（秒）。暂停中会立即渲染一帧，Promise 在该帧画完后落地 */
  seek(t: number): Promise<void>;
  /** 倍速（0 = 冻结时间但继续出帧；负值按 0 处理） */
  setTimeScale(scale: number): void;
  /** 暂停中逐帧推进 frames 帧（每帧 1/fps 秒，缺省 60fps）；播放中等价于 seek */
  step(frames?: number, fps?: number): Promise<void>;
  /** 单帧出图（W3） */
  capture(opts?: EditorCaptureOptions): Promise<Blob>;
  /** 单帧出图到新 canvas（不编码）；给 time 时只定位不额外画一帧 */
  captureFrame(opts?: EditorFrameOptions): Promise<HTMLCanvasElement>;
  /** 画布 CSS 像素坐标（相对画布左上角）命中的图层，自上而下（W4） */
  hitTestAt(x: number, y: number, opts?: EditorHitTestOptions): EditorLayer[];
  /** 全部引擎活层，按绘制顺序（W2a） */
  getLayers(): EditorLayer[];
  /** 读图层当前可热改属性；id 不存在返回 null */
  getLayerProps(id: number): EditorLayerProps | null;
  /** 模型层的只读信息（W12）；不是模型层 / 模型没装上 / id 不存在返回 null */
  getModelInfo(id: number): EditorModelInfo | null;
  /**
   * 热改图层属性（W2-lite），当帧生效（拾取与轮廓立即同步）。暂停中会补画一帧，
   * Promise 在该帧画完后落地。变换绑了脚本的层，下一帧会被脚本覆盖；
   * 字段上有关键帧动画时，该字段的曲线写回暂停到下一次 seek（编辑器拖拽 / 输入跟手，提交后由页面落关键帧并 seek 复原）。
   */
  setLayerProps(id: number, patch: Partial<EditorLayerProps>): Promise<void>;
  /**
   * 热替换模型层的动画层表（W13）：`layers` 即 scene.json 的 `animationlayers` 原样数组，
   * 与场景解析同一份映射，当帧生效（暂停中补画一帧）。不是模型层 / id 不存在时 reject。
   * 字段上的 `{script}` / `{animation}` 包装只取快照值，不重装脚本与曲线（这类改动请整场景重挂）。
   */
  setAnimationLayers(id: number, layers: ReadonlyArray<Record<string, unknown>>): Promise<void>;
  /** 模型层附着点在当前姿势下的偏移与屏幕位置（W14）；不是模型层 / 模型没装上 / id 不存在返回 null */
  getAttachmentPoints(id: number): EditorAttachmentPoint[] | null;
  /** 图层轮廓（选中框用，W5 过渡方案）；透视相机场景 / id 不存在返回 null */
  getLayerOutline(id: number): EditorLayerOutline | null;
  /** 画布 CSS 像素位移 → 该层 origin 的 local 位移（拖拽移动用）；透视相机场景返回 null */
  screenDeltaToLocal(id: number, dx: number, dy: number): [number, number] | null;
  /** 本次装配以来的脚本错误，按「图层 + 挂点 + 阶段 + 文案」去重计数（W8） */
  getScriptIssues(): EditorScriptIssue[];
  /** 挂载时 `scripts: false` 跳过求值的脚本段数（含惰性求值的材质常量脚本，随播放可能增长） */
  getSkippedScripts(): number;
  /**
   * 运行时声明用户属性（W9）：未声明的名字按声明补进属性表，绑定链与脚本随即可见并热更；
   * 已声明的名字只更新值（等价 setProperties）。暂停中会补画一帧，Promise 在该帧画完后落地。
   */
  declareUserProperties(decls: Record<string, EditorUserPropertyDecl>): Promise<void>;
};

/** 用户属性声明（project.json `general.properties` 的条目形状） */
export type EditorUserPropertyDecl = {
  type: "slider" | "color" | "bool" | "combo" | "textinput";
  /** slider = 数字、color = "r g b"（0..1）、bool = 布尔、combo = 选项值、textinput = 文本 */
  value: PropertyValue;
  text?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: Array<{ label: string; value: string }>;
  order?: number;
};

/**
 * 一条脚本错误。target 为挂点：对象字段名（`origin` / `visible` …）、文字层 `text`、
 * 效果开关 `effects[i].visible`、场景级 `general.<字段>`（此时 layerId 为 null）。
 */
export type EditorScriptIssue = {
  layerId: number | null;
  layerName: string;
  target: string;
  /** parse（编译 / 顶层）、init、update、cursor、applyUserProperties、anim、resize、timer */
  phase: string;
  message: string;
  /** 脚本源码行号（取不到为 null） */
  line: number | null;
  count: number;
};

/** 脚本语法预检结果（只编译不执行，与引擎沙箱同一 transform） */
export type SceneScriptCheck = {
  ok: boolean;
  message: string;
  /** 语法错误所在的源码行（ok 时为 null） */
  line: number | null;
  /** 宿主能派发的入口（update / init / cursor* / 媒体回调 …） */
  entries: string[];
  /** 没有任何入口且不读 engine 时钟：引擎会丢弃这段脚本 */
  noEntry: boolean;
};

/** buildScenePkg 的输入条目：包内相对路径 + 字节 */
export type ScenePkgFile = { path: string; data: Uint8Array };

/** buildScenePkg 产物 */
export type ScenePkgResult = {
  /** PKGV0012 容器字节 */
  pkg: Uint8Array;
  /** 包内入口（排序后） */
  entries: string[];
  /** 由 materials 下 png/jpg 包成的 .tex */
  converted: string[];
  /** 未进包的源文件（已转成 .tex 或已有同名 .tex 的源图、嵌套 .pkg） */
  dropped: string[];
};

// ─── 公共包（webwallgl/core）引擎底座类型 ────────────────────────────────
// docs/EDITOR-PLAN.md §0.5：公共包只收「自包含、Node 可载、零装配依赖」的引擎
// 底座面。类型跟着实现走：Pkg/Tex 与 vendor/we-scene/pkg/{container,texture}.js
// 的返回对象逐字段对应，改实现必须同步这里（api/core.d.ts 手写契约引用它们）。

/** scene.pkg 入口表项（offset 相对 dataStart） */
export type PkgEntry = {
  readonly name: string;
  readonly offset: number;
  readonly size: number;
};

/** parsePkg 结果。buf 是入参字节的原引用（getEntry 返回其零拷贝视图） */
export type Pkg = {
  readonly magic: string;
  readonly version: string;
  readonly count: number;
  readonly entries: PkgEntry[];
  readonly dataStart: number;
  readonly fileSize: number;
  readonly buf: Uint8Array;
};

/** verifyLayout 结果：入口数据末尾应恰好贴住文件末尾（结构自检） */
export type PkgLayout = {
  readonly dataEnd: number;
  readonly fileSize: number;
  readonly ok: boolean;
};

/** .tex 内的单条 mip 记录（compression=1 时 data 是 LZ4 压缩块，惰性解压） */
export type TexMip = {
  readonly width: number;
  readonly height: number;
  readonly compression: number;
  readonly data: Uint8Array;
};

/**
 * TEXS 序列帧表的单帧。轴对齐帧的 uDir=(w,0)、vDir=(0,h)；rotated=true 时是
 * 仿射打包，取帧矩形必须走 origin + s·uDir + t·vDir，不能退化成 (x,y,w,h)。
 */
export type TexFrame = {
  readonly imageId: number;
  readonly duration: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly uDir: [number, number];
  readonly vDir: [number, number];
  readonly rotated: boolean;
};

export type TexFrames = {
  readonly magic: string;
  readonly frameWidth: number;
  readonly frameHeight: number;
  /** 帧矩形归一化分母（mip0 真实像素尺寸，不是头部 textureWidth/Height） */
  readonly atlasWidth: number;
  readonly atlasHeight: number;
  readonly list: readonly TexFrame[];
};

/** parseTex 结果（TEXV0005 主路径与旧 TEXV0004 同形；字段与实现逐字对应） */
export type Tex = {
  readonly format: number;
  readonly formatName: string;
  readonly flags: number;
  /** TEXI 头部声明的逻辑尺寸 */
  readonly textureWidth: number;
  readonly textureHeight: number;
  /** TEXB 容器侧的图像尺寸（常为 POT 对齐填充值，解码端按需裁剪） */
  readonly width: number;
  readonly height: number;
  readonly freeImageFormat: number;
  readonly containerMagic: string;
  readonly containerVersion: number;
  readonly isVideo: boolean;
  readonly images: readonly (readonly TexMip[])[];
  /** 序列帧表；无 TEXS 段时为 null */
  readonly frames: TexFrames | null;
};

/** decodeMip0 / decodeMipLevel / decodeMips 的解码产物：按载荷类型四选一 */
export type DecodedMip =
  | { width: number; height: number; rgba: Uint8Array; level?: number }
  | { width: number; height: number; png: Uint8Array; level?: number }
  | { width: number; height: number; image: Uint8Array; fif: number; level?: number }
  | { width: number; height: number; video: Uint8Array; level?: number };

/** fitWindow 结果：设计尺寸坐标系里的可见窗口 */
export type FitWindowResult = {
  readonly offX: number;
  readonly offY: number;
  readonly viewW: number;
  readonly viewH: number;
};
