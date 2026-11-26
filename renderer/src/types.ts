// 壁纸类型、URL 协议字段与手动测试开关（从 main.ts 拆出）

import type { Source } from "./api/types";
import type { QualityOptions } from "./quality";

// 场景壁纸渲染开关（手动测试用）
export const SKIP_3D_MODELS = false; // puppet 骨骼网格（人物模型）
// WE 的「组件」（时钟/天气等挂件）在本机 84 个场景里 0 个以 component 对象存在 ——
// 它们全部是带 text.script 的文字对象（563 个），由文字渲染路径（render/text.js）实现。
// component 对象的解析仍在（parse.js），真出现时依旧跳过并打 diag。
export const SKIP_COMPONENTS = true;
export const SKIP_TEXT = false; // 文字对象（时钟/日期等挂件），渲成 GL 纹理图层走完整管线
export const SKIP_PARTICLES = false; // 粒子（雪 / 雨 / 火花 / 雾 / 光轴）
// we-scene 对部分工坊 effect（shake/foliagesway/iris/audio-bars 等）支持不完整，
// 逐 pass 渲染会产出灰色遮罩 / 随机颜色多边形。暂改为不应用图层效果，只渲染基础层。
export const SKIP_SCENE_EFFECTS = false;

// WE 文字对象 pointsize 的放大系数：pointsize 不是像素，实际 em = pointsize × 4 场景像素。
// 标定（全库统计，k 曾误取 6 —— 把 cap 高当 em 导致）：
//   静态多行文本的「盒子高 ≈ 行数 × 行高」是强几何关系：17 个含 \n 的静态层，
//   k = 盒高×scale/(行数×1.2×ps) 中位数 3.89、众数 4.0（9/17），其中 3122339805 的
//   9 行 "text|text|…" 列（boxH 378, ps 9, scale 1）给出 3.89，与渲染实测吻合。
//   交叉验证：2938612768 的作者滑条把时间/日期错开 85px，k=4 时两者恰好不叠（k=6 叠 1/3）。
// 注意：2780710296 在 k=4 + center 锚下分秒仍糊进小时（见 CASEBOOK 待修条），
// 全局改 k=1.5 / 顶边锚会伤其它已校准壁纸，禁止再全局动这两处。
export const TEXT_EM_SCALE = 4;

// WE 的 systemfont_* 内置字体 → 本机系统字体栈（WE 桌面端映射 Windows 系统字体，
// macOS/Linux 上按近似度回退；都带 sans-serif 兜底，不命中也只是字形差异）。
export const SYSTEM_FONT_FAMILIES: Record<string, string> = {
  systemfont_segoe: "'Segoe UI', 'Helvetica Neue', Arial, sans-serif",
  systemfont_arial: "Arial, 'Helvetica Neue', sans-serif",
  systemfont_verdana: "Verdana, Geneva, sans-serif",
  systemfont_tahoma: "Tahoma, Geneva, sans-serif",
  systemfont_timesnewroman: "'Times New Roman', Times, serif",
  systemfont_georgia: "Georgia, 'Times New Roman', serif",
  systemfont_couriernew: "'Courier New', Courier, monospace",
  systemfont_trebuchetms: "'Trebuchet MS', 'Helvetica Neue', sans-serif",
  systemfont_impact: "Impact, 'Arial Black', sans-serif",
  systemfont_comicsansms: "'Comic Sans MS', 'Comic Sans', cursive",
  systemfont_sylfaen: "Palatino, 'Times New Roman', serif",
  systemfont_calibri: "Calibri, Carlito, 'Helvetica Neue', sans-serif",
  systemfont_cambria: "Cambria, Georgia, serif",
  systemfont_consolas: "Consolas, 'Courier New', monospace",
  systemfont_microsoftyahei: "'Microsoft YaHei', 'PingFang SC', 'Hiragino Sans GB', sans-serif",
  systemfont_simsun: "SimSun, 'Songti SC', serif",
  systemfont_simhei: "SimHei, 'Heiti SC', sans-serif",
};

export type WallpaperFit = "cover" | "contain" | "stretch" | "fill" | "fit";

/**
 * 本机 WE 官方素材（安装目录 `assets/` 树）的接入档位（issue #24）。
 * 官方树里有三类壁纸 pkg 不带、工坊场景按名引用的资源：`materials/**`（util/ 粒子等
 * 公共贴图）、`fonts/**`（Segment7 等 WE 内置字体）、效果 shader/材质 JSON（不进运行时）。
 * 没有素材时全部走程序化复刻 / 系统字体兜底，行为与关闭时完全一致。
 */
export type LocalAssetsMode =
  /** 不发任何请求（npm 生产构建的缺省行为） */
  | "off"
  /** 只开字体通路：探测素材根 + 按名取 `fonts/*`；公共贴图仍走程序化复刻 */
  | "fonts"
  /** 贴图懒加载（util 急切、particle/gradient 等按需）+ 字体 */
  | "lazy"
  /** 全量急切装载 + 字体（批量对账 / 预热用，接受内存占用） */
  | "all";

export type WallpaperConfig = {
  type: "canvas" | "video" | "gif" | "web" | "scene" | "image";
  src?: string;
  fit?: WallpaperFit;
  /** 渲染分辨率 DPR：0（默认）=自动跟随设备 DPR（Retina 原生清晰）；正数=目标
   *  DPR，可高于设备上报值（宿主 WKWebView 误报 1 时仍能超采样）；调低省显存。 */
  renderDpr?: number;
  /** 场景壁纸帧率上限（30/60/120），越低 GPU 占用越低；默认 60 */
  sceneFps?: number;
  /**
   * 视频纹理上传倍率：`0`/缺省 = 自动（帧率守门按实测帧率压，见 quality.ts），
   * 正数 = 固定倍率（1 = 不压，最清晰；0.5 = 半幅）。**显式值优先于守门**。
   *
   * 存在的理由（macOS WKWebView 实测）：逐帧 `texImage2D(视频帧)` 要把像素同步取回
   * 页面进程，代价随像素数线性 —— 全屏视频层上传 2570×1446 时主线程每帧堵 ~40ms
   * （16fps / 上限 30），压到 1285×723 回到 29fps。宿主把它暴露成用户可选项
   * （画质页「视频纹理清晰度」），让用户在清晰与流畅之间自己定。
   */
  videoTexScale?: number;
  /** 渲染质量设置（抗锯齿/粒子/后处理档位，见 quality.ts）。缺省 = 全默认
   *  （AA off、粒子 high、后处理 high），与引入前的行为一致。 */
  quality?: QualityOptions;
  /**
   * 自动降档开关，默认开（`false` / `?autoq=0` 关闭）。
   *
   * 开时两件事：① 探到**软件渲染（无 GPU）**就把后处理关掉、画布 DPR 压到 0.5
   * （实测 0fps → 46fps）；② 运行期帧率**连续 3 秒**低于上限 85% 就把后处理降一档
   * （high→medium→low→off，只降不升）。
   *
   * **只改宿主没显式指定的字段**：`quality.postProcessing` 传了值就以它为准。
   * 生效结果见 `getQuality()`（读的是实际生效值，不是请求值）。
   */
  autoQuality?: boolean;
  /**
   * 渲染过程渐显（**默认关**，`?fadein=1` 开启；仅 scene 壁纸——web/media 的可见性
   * 由 DOM 元素自身渐进，无此空档）。加载期起预览循环边加载边画已就绪图层，画布
   * opacity 按「已完成贴图 job / 总 job」线性推进，终点 = 资源全部就绪（首帧时刻）。
   * 失败/降级出口立即还原可见，绝不因淡入把壁纸或兜底页吞成空白。纯函数见
   * `fade-in.ts`，装配接线见 `scene-mount.ts` 的渐显块。
   */
  fadeIn?: boolean;
  /**
   * 贴图烘焙（B3）：内嵌 PNG/JPEG 的**预缩放缓存**，默认开（`false` / `?bake=0` 关闭）。
   *
   * 内嵌图的现状路径是「解全尺寸再缩」，实测大图最贵的就是这一步（52 张内嵌图
   * 470ms → 94ms，-80%；缓存产物还比原图小 ×0.61）。命中缓存时只做一次
   * createImageBitmap，**像素与现状逐位一致**（缓存存的是处理完 EXIF 回滚后的最终位图）。
   * 未命中走现状路径，并把结果排进后台队列（首帧之后才开跑，不拖慢本次加载）。
   * 键 = 壁纸指纹 + 贴图指纹 + 资源档位；档位变了会重烘。详见 docs/BAKE-PLAN.md。
   */
  bake?: boolean;
  muted?: boolean;
  loop?: boolean;
  /**
   * 滤镜（beta）id。渲染器侧白名单（main.ts WALLPAPER_FILTERS）查表后以 CSS filter
   * 应用到 wrap 容器，scene/video/image/web 各类型统一生效；未知 id 按无滤镜处理
   */
  filter?: string;
  /** 内容服务器媒体基址：http://127.0.0.1:<port>/media/<token>（scene/web 拉取资源） */
  mediaBase?: string;
  /**
   * 测试台「系统实况」：用宿主 media-bridge 的系统输出频谱 + Now Playing /
   * 前台窗口替换模拟源。默认 false（确定性模拟，离线可复现）。
   */
  liveSystem?: boolean;
  /**
   * 页面底色是否不透明。默认 false（透明）—— 桌面壁纸窗口叠在桌面 underlay 层，
   * 需要透出下面的内容。嵌入式宿主（安卓 WebView）设 true 可避免露出 WebView
   * 自己的浅色默认底。
   */
  opaque?: boolean;
  /**
   * 网页壁纸 iframe 的沙箱级别。
   *
   * - 省略（缺省）：仅 `allow-scripts`（等同于 `"strict"`）—— 见下面 strict 的理由。
   *   库/宿主不传时即走这一档，因为调用方分不清「独立壁纸窗口」还是「嵌进宿主主界面」，
   *   而后者下 allow-same-origin 等于把宿主身份交给任意工坊脚本。
   * - `"strict"`：仅 `allow-scripts`（去掉 allow-same-origin）—— 宿主把工坊网页壁纸
   *   嵌进**共享自身 origin** 的页面时必须用它（例如浏览器插件把壁纸挂进主界面）：
   *   否则作者脚本能以宿主身份调用宿主 API、读写宿主存储。代价是 iframe 内 origin 变
   *   opaque —— 作者脚本的 fetch/XHR 需要宿主返回 CORS 头（img/script/css 等子资源
   *   加载不受影响），父页控制改走 shim 的 postMessage 通道（见 web.ts 的 weShimSend
   *   与 web-shim.js 末尾）。
   * - `"legacy"`：`allow-scripts allow-same-origin` —— WallpaperEM 壁纸窗口的**旧行为**
   *   （iframe 与渲染页同源，且那个 origin 就是壁纸窗口自己的）。素材依赖宿主身份读
   *   localStorage / 同源 fetch 时，嵌入方须**显式**声明它才能回到这一档（逃生门）；
   *   壁纸窗口用 `?webSandbox=legacy` 打开同理。
   */
  webSandbox?: "legacy" | "strict";
  /**
   * 本机 WE 官方素材接入档位（issue #24，见 {@link LocalAssetsMode}）。
   *
   * 缺省（省略）= 按 URL 参数 `?localAssets=` 解析，都没有时 dev 为 `"lazy"`、
   * 生产构建为 `"off"`（库不联网的既有契约）。**显式传值优先于 URL 参数**。
   *
   * 典型场景：工坊文字层引用 WE 内置字体（如 `fonts/Segment7Standard.otf`），
   * 字体只存在于官方安装目录 `assets/fonts`、不在壁纸 pkg 里 —— 不开素材通路时
   * 只能静默回落 sans-serif（`"fonts"` 档专为此设：只要素材根可达就按名取字体，
   * 不连带开启贴图批量装载）。素材根由 dev server 的 `/api/local-assets` 提供
   * （`local-assets/` 目录或 `WE_LOCAL_ASSETS` 环境变量，见 local-assets.ts 头注）。
   */
  localAssets?: LocalAssetsMode;
  /**
   * 覆盖场景的清屏色（`"r g b"` 0..1 浮点三元组）。默认不覆盖，用场景自带的
   * `general.clearcolor`。
   *
   * 为什么需要：clearcolor 是场景作者按「铺满 PC 全屏」设的，很多场景填的是
   * 浅灰（如 0.7 0.7 0.7）。在 PC 上它完全被内容盖住，但手机竖屏用 contain
   * 适配 16:9 场景时，上下留白就会露出这块浅灰，看起来像渲染坏了。
   * 宿主传 `"0 0 0"` 可以把留白压成中性黑。
   */
  clearColor?: string;

  // ---- 库化改造引入的可选入口（docs/LIBRARY-PLAN.md 第 1 步）----
  // 公共 API 的 mount() 经这两个字段接管「画到哪」与「资源从哪来」。
  // 旧的 mediaBase/src 路径保持原样，两条并存直到适配层落地（第 5 步）。

  /**
   * 渲染目标。给了就画在它上面（库形态：调用方自己放节点，
   * 可非全屏、可多实例）；不给则沿用旧行为——自建 canvas 铺满内部 wrap。
   * 场景/视频需要 HTMLCanvasElement（或可在容器内自建）；网页壁纸可用任意
   * HTMLElement（空 div 最佳；若传入 canvas 则挂到其父节点）。
   */
  canvas?: HTMLElement;
  /** 场景资源来源。给了走 source；不给回落到 mediaBase/src 拼 URL。 */
  source?: Source;

  /**
   * 场景形态强制开关（**调试/验证用**，`?form=pkg|loose`）：松散目录形态
   * （源码工程）与包形态（scene.pkg）的自动判定见 `api/source.ts::sceneFormOf`。
   *
   * 本仓自有的 A/B 通道 —— 同一条目两形态都齐全时（如 arsenal），一条 URL 就能
   * 把两条装载路各跑一遍对比像素；也用于 `verify-loose` 的双臂取证。
   * 缺省 / `"auto"` = 按 project.json 的 `file` 后缀自动判定。
   */
  sceneForm?: "auto" | "pkg" | "loose";

  /**
   * SceneScript `localStorage` 的持久后端（WE 语义：按壁纸共享、跨会话保留）。
   * 契约：{get,set,remove,clear,keys}，全部同步；screen 是默认位置（每壁纸一份），
   * global 是跨壁纸共享位置（LOCATION_GLOBAL）。
   * 不给时库默认用 window.localStorage + 按 source.key 命名空间；无 DOM（Node
   * verifier）时退化为进程内 Map（重挂即丢）。
   */
  storageProvider?: {
    screen?: StorageProviderLike;
    global?: StorageProviderLike;
  };

  /** 是否执行 SceneScript（见 MountOptions.scripts）。缺省 = 执行 */
  scripts?: boolean;
};

/** 同步 KV 后端（SceneScript localStorage 持久化用）。 */
export type StorageProviderLike = {
  get: (key: string) => string | null;
  set: (key: string, value: string) => void;
  remove: (key: string) => void;
  clear: () => void;
  keys: () => string[];
};