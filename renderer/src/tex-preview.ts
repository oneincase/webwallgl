// `.tex` 贴图缩略图 / 尺寸（W16 地基）—— 纯数据层，Node 离线可跑。
//
// 定位：编辑器面板要显示「贴图缩略图」与「原图尺寸」，这两件事必须先在渲染侧有一个
// 无 DOM 依赖的纯函数（真机 UI 接线在 editor/main.ts，见 docs/EDITOR-PLAN.md W16）。
// 本模块因此**不碰 document / window / canvas**：只有纯 CPU 解码 + 重采样。
//
// 语义依据（只转调引擎，不复制解析逻辑）：
//   renderer/vendor/we-scene/pkg/texture.js:17      parseTex(buf, opts)      .tex 容器
//   renderer/vendor/we-scene/pkg/tex-codecs.js:29   decodeMip0(tex)          第 0 级
//   renderer/vendor/we-scene/pkg/tex-codecs.js:62   decodeMipLevel(tex, k)   任意 mip 级
//   renderer/src/tex-decode.ts:156                  resampleRgba(src, w2, h2)  CPU 双线性
import { parseTex } from "../vendor/we-scene/pkg/texture.js";
import { decodeMipLevel } from "../vendor/we-scene/pkg/tex-codecs.js";
import { resampleRgba } from "./tex-decode";

/** 缩略图缺省长边（像素）。 */
const TEX_PREVIEW_MAX = 64;
/** 长边夹取上限：再大就不是缩略图，且一次分配可能上百 MB（2048² ⇒ 16 MB RGBA）。 */
const TEX_PREVIEW_CAP = 1024;

/** 把调用方给的 `max` 夹到 `[1, 1024]`；非有限数回落缺省 64。 */
function clampPreviewMax(max: unknown): number {
  const n = typeof max === "number" && Number.isFinite(max) ? Math.floor(max) : TEX_PREVIEW_MAX;
  return Math.max(1, Math.min(TEX_PREVIEW_CAP, n));
}

/**
 * 只读 TEXI 头部声明的尺寸（`tex.width` / `tex.height`，即**内容尺寸**，不是带 POT
 * 填充的 mip 画布尺寸），不解像素 —— 「原图尺寸」这一栏用。解析失败（坏字节 / 截断 /
 * 不是 .tex）返回 null，不抛。
 */
export function texImageSize(bytes: Uint8Array): { width: number; height: number } | null {
  try {
    const tex = parseTex(bytes);
    const w = Number(tex.width);
    const h = Number(tex.height);
    return w > 0 && h > 0 ? { width: w, height: h } : null;
  } catch {
    return null;
  }
}

/**
 * 解出缩略图像素：`parseTex` → 挑 mip 级 → 必要时 `resampleRgba` 降到长边 ≤ `max`。
 * 返回 `{ width, height, rgba }`（`rgba.length === width * height * 4`）；任何失败返回
 * null，**不抛**。
 *
 * 挑级口径：取「长边已经降到 ≤ max 的**最大画布**」（即满足条件的最小 `k`）。注意不是
 * 取最大级号 —— mip 链尾可能只有 1×1/2×2，一路取到最后一档拿到的是马赛克而不是缩略图。
 * 选中级已经够小时**零重采样**直接返回（引擎自己降的级，无画质损失）；所有级都还比 max
 * 大（单级大图，如 2048×2048 只有一级）时，才从第 0 级重采样到长边 = max。
 *
 * **POT 填充由引擎裁掉**：填充过的贴图（TEXI 声明内容 1200×674、mip 画布 2048×1024）
 * `decodeMipLevel` 就按声明的**内容矩形**返回像素，所以挑级与重采样都在内容尺寸上做；
 * 面板要显示「原图尺寸」时用 `texImageSize`（同一份声明尺寸，不解像素）。
 *
 * **内嵌 PNG/JPEG 的贴图（`freeImageFormat` 非 UNKNOWN）返回 null**，不让本模块去解码：
 * 此时 `decodeMipLevel` 只透出 `{ png }` / `{ image, fif }`，要拿到像素必须走浏览器
 * 的 `createImageBitmap` + `document.createElement("canvas")`（`tex-decode.ts` 的
 * `decodeTexImageBitmap`）—— 本模块的契约是「Node 离线可跑、不碰 DOM」，在 Node 侧为了
 * 这 35 张（本机 local-assets 语料 34 PNG + 1 JPEG / 311 张）引一套 PNG/JPEG 解码器属于
 * 新增依赖，不值得。调用方（编辑器面板）对这些贴图改走 `decodeTexImageBitmap` 的 Blob
 * 路径即可；`texImageSize` 对它们照常工作（TEXI 头声明尺寸与像素格式无关）。
 * 视频贴图（`isVideo`）同样返回 null：缩略图不抓视频帧。
 */
export function texPreviewPixels(
  bytes: Uint8Array,
  max: number = TEX_PREVIEW_MAX,
): { width: number; height: number; rgba: Uint8Array } | null {
  try {
    const tex = parseTex(bytes);
    if (tex.isVideo) return null;
    const mipCount = tex.images?.[0]?.length ?? 0;
    if (mipCount <= 0) return null;
    const limit = clampPreviewMax(max);
    let first: { width: number; height: number; rgba: Uint8Array } | null = null;
    let picked: { width: number; height: number; rgba: Uint8Array } | null = null;
    for (let k = 0; k < mipCount; k++) {
      const d = decodeMipLevel(tex, k);
      const rgba = "rgba" in d ? d.rgba : undefined;
      if (!rgba) return null; // 内嵌 PNG/JPEG：见上面的「走哪条路」
      const cur = { width: Number(d.width), height: Number(d.height), rgba };
      if (!first) first = cur;
      if (Math.max(d.width, d.height) <= limit) {
        picked = cur;
        break;
      }
    }
    const src = picked ?? first;
    if (!src) return null;
    const long = Math.max(src.width, src.height);
    if (long <= limit) return src;
    const scale = limit / long;
    return resampleRgba(
      src,
      Math.max(1, Math.round(src.width * scale)),
      Math.max(1, Math.round(src.height * scale)),
    );
  } catch {
    return null;
  }
}
