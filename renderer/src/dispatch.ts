// 按 cfg.type 分流挂载（scene / media / web）；main 与 api/mount 共用。
import type { Runtime } from "./shell";
import { mountMedia } from "./media";
import { mountScene } from "./scene-mount";
import { mountWeb } from "./web";
import type { WallpaperConfig } from "./types";

export function mountWallpaper(rt: Runtime, cfg: WallpaperConfig) {
  const type = String(cfg.type ?? "").toLowerCase() as WallpaperConfig["type"];
  cfg = { ...cfg, type };
  rt.cfg = cfg;

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
