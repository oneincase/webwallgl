// 装配分发（从 main.ts 拆出）：按 cfg.type 选挂载路径。
// main.ts（壁纸页入口）与 api/mount.ts（公共库入口）共用这一份，
// 保证两条入口的装配行为永远一致。每个 Runtime 实例独立装配，互不可见。
//
// 核心能力 = scene + video/gif/image + web（iframe + WE shim）。
// canvas 演示动画、降级页仍是壁纸页适配层职责（rt.onUnhandledType / fallbackPage）。
import type { Runtime } from "./shell";
import { mountMedia } from "./media";
import { mountScene } from "./scene-mount";
import { mountWeb } from "./web";
import type { WallpaperConfig } from "./types";

export function mountWallpaper(rt: Runtime, cfg: WallpaperConfig) {
  // 工坊 project.json 的 type 大小写混用（Web/web、Scene/scene）；一律小写再分流
  const type = String(cfg.type ?? "").toLowerCase() as WallpaperConfig["type"];
  cfg = { ...cfg, type };
  rt.cfg = cfg;

  // video / gif / image 统一走场景引擎（mountMedia 内部在无 WebGL2 时回退 DOM）
  if ((type === "video" || type === "gif" || type === "image") && cfg.src) {
    mountMedia(rt, cfg);
  } else if (type === "scene" && (cfg.source || cfg.src)) {
    // scene：库形态只有 source（src 可空），旧形态 mediaBase+src
    mountScene(rt, cfg);
  } else if (type === "web" && cfg.src) {
    mountWeb(rt, cfg);
  } else {
    rt.onUnhandledType?.(cfg);
  }
}
