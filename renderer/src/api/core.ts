// WebWallGL 公共包出口（npm 子路径 webwallgl/core，产物形态见 docs/EDITOR-PLAN.md §0.5）。
//
// 定位：引擎底座 —— 容器/纹理解码与适配数学这些「自包含、Node 可载、零装配依赖」
// 的纯函数，供播放包、编辑器包与外部工具（缩略图、素材检查器、离线转码）共用。
// 边界纪律（verify-arch 有断言，不是注释）：
//   1. 本文件只准 import ../vendor/we-scene/**（引擎）与 ./types（公共类型），
//      不得触碰装配层（api/mount、scene-mount、shell）—— 底座反依赖编排即分层倒置；
//   2. 场景图只读面（scene/parse、hittest）属 EDITOR-PLAN W2a 的契约工作，落地前
//      不进公共面，避免把内部形状提前焊死成公共契约。
export {
  parsePkg,
  getEntry,
  verifyLayout,
} from "../../vendor/we-scene/pkg/container.js";
export { parseTex } from "../../vendor/we-scene/pkg/texture.js";
export {
  TEXTURE_FORMATS,
  FIF,
  decodeMip0,
  decodeMipLevel,
  decodeMips,
  decodePixels,
} from "../../vendor/we-scene/pkg/tex-codecs.js";
export { fitWindow } from "../../vendor/we-scene/render/math.js";
export type {
  Pkg,
  PkgEntry,
  PkgLayout,
  Tex,
  TexMip,
  TexFrame,
  TexFrames,
  DecodedMip,
  Fit,
  FitWindowResult,
} from "./types";
