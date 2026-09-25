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

export type WallpaperFit = "cover" | "contain" | "stretch" | "fill" | "fit";

export type WallpaperConfig = {
  type: "canvas" | "video" | "gif" | "web" | "scene" | "image";
  src?: string;
  fit?: WallpaperFit;
  /** 渲染分辨率 DPR：0（默认）=自动跟随设备 DPR（Retina 原生清晰）；正数=目标
   *  DPR，可高于设备上报值（宿主 WKWebView 误报 1 时仍能超采样）；调低省显存。 */
  renderDpr?: number;
  /** 场景壁纸帧率上限（30/60/120），越低 GPU 占用越低；默认 60 */
  sceneFps?: number;
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
   * - 省略 / `"legacy"`：`allow-scripts allow-same-origin` —— WallpaperEM
   *   壁纸窗口的既有行为（iframe 与渲染页同源，且那个 origin 就是壁纸窗口自己
   *   的，第三方脚本拿到它无害）。
   * - `"strict"`：仅 `allow-scripts`（去掉 allow-same-origin）—— 宿主把工坊
   *   网页壁纸嵌进**共享自身 origin** 的页面时必须用它（例如浏览器插件把壁纸
   *   挂进主界面）：否则作者脚本能以宿主身份调用宿主 API、读写宿主存储。代价是
   *   iframe 内 origin 变 opaque —— 作者脚本的 fetch/XHR 需要宿主返回 CORS 头
   *   （img/script/css 等子资源加载不受影响），父页控制改走 shim 的 postMessage
   *   通道（见 web.ts 的 weShimSend 与 web-shim.js 末尾）。
   */
  webSandbox?: "legacy" | "strict";
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
};

/** 同步 KV 后端（SceneScript localStorage 持久化用）。 */
export type StorageProviderLike = {
  get: (key: string) => string | null;
  set: (key: string, value: string) => void;
  remove: (key: string) => void;
  clear: () => void;
  keys: () => string[];
};