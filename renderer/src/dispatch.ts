// 装配分发（从 main.ts 拆出）：按 cfg.type 选挂载路径。
// main.ts（壁纸页入口）与 api/mount.ts（公共库入口）共用这一份，
// 保证两条入口的装配行为永远一致。每个 Runtime 实例独立装配，互不可见。
//
// 核心能力 = scene + video/gif/image（真实渲染）。canvas 演示动画、web 网页
// 壁纸、降级页不是渲染能力 —— 遇到这些类型交给 rt.onUnhandledType（由壁纸页
// 适配层注册，见 docs/LIBRARY-PLAN.md 第 5 步）；库实例不注册，安全地不渲染。
import type { Runtime } from "./shell";
import { mountMedia } from "./media";
import { mountScene } from "./scene-mount";
import type { WallpaperConfig } from "./types";

export function mountWallpaper(rt: Runtime, cfg: WallpaperConfig) {
  // video / gif / image 统一走场景引擎（mountMedia 内部在无 WebGL2 时回退 DOM）
  if ((cfg.type === "video" || cfg.type === "gif" || cfg.type === "image") && cfg.src) {
    mountMedia(rt, cfg);
  } else if (cfg.type === "scene" && (cfg.source || cfg.src)) {
    // scene：库形态只有 source（src 可空），旧形态 mediaBase+src
    mountScene(rt, cfg);
  } else {
    rt.onUnhandledType?.(cfg);
  }
}
