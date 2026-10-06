/**
 * 测试台 ↔ 渲染器页的桥：iframe 承载 renderer/index.html，同源经 `__wp` 遥控。
 *
 * 关键约定必须与主项目 `src-tauri/src/wallpaper/mod.rs` 一致：
 *  - scene：`src` 只是 itemId，渲染器自己用 `mediaBase/src` 拼 scene.pkg 地址；
 *  - video/gif/image：`src` 是可直接喂给渲染器的完整媒体 URL；
 *  - web：`src` 指向 /web/{token}/{itemId}/ 下的入口页（站点根，绝对路径引用可解析）。
 */

import { $ } from "./store";
import { t } from "./i18n";
import { log } from "./console";

export const TOKEN = "dev"; // 与 host/wallpaper-host.ts 的 DEV_TOKEN 一致
export const MEDIA_BASE = `${location.origin}/media/${TOKEN}`;
export const WEB_BASE = `${location.origin}/web/${TOKEN}`;

export type FrameStats = {
  fps: number;
  running: boolean;
  idle?: boolean;
  occluded?: boolean;
  throttled?: boolean;
};

export type OcclusionReport = {
  band: string;
  ratio: number;
  gridCoverage: number;
  rectCount: number;
  rectAreaFrac: number;
  roiCulled: number | null;
  roiGate: number | null;
};

export type WpApi = {
  setWallpaper(cfg: unknown): void;
  pause(): void;
  resume(): void;
  setFit(fit: string): void;
  setVolume(volume: number): void;
  release(): void;
  restore(): void;
  setRenderDpr(dpr: number): void;
  setFilter(filter: string): void;
  setSceneFps(fps: number): void;
  setQuality(patch: { antiAliasing?: string; particles?: string; postProcessing?: string }): void;
  getQuality(): { antiAliasing: string; particles: string; postProcessing: string };
  updateWebProps(props: Record<string, { value: unknown }>): void;
  /** 外部指针注入（宿主推送通道，见 docs/INTEGRATION.md） */
  pushPointer(u: number, v: number, buttons?: number): void;
  pointerLeave(): void;
  pushWheel(dx: number, dy: number, mode: number, mods: number): void;
  loadSceneFile(file: File, project?: File): void;
  /** 遮挡推送（V5）：矩形 = 渲染器视口 CSS 像素；null = 恢复全量 */
  setOcclusion(
    payload: { occluders: Array<[number, number, number, number]>; gen?: number; epoch?: string } | null,
  ): void;
  getOcclusion(): OcclusionReport | null;
};

type RendererWindow = Window & {
  __wp?: WpApi;
  /** 渲染器运行时观测面（见 renderer/src/main.ts 的 __wpStats） */
  __wpStats?: { frame(): FrameStats };
};

export const frameEl = $<HTMLIFrameElement>("#frame");

export function rendererUrl(query = ""): string {
  return `${import.meta.env.BASE_URL}renderer/index.html${query ? `?${query}` : ""}`;
}

/** 取渲染器页注入的 __wp 控制接口；未就绪时打一条错误日志 */
export function wp(): WpApi | null {
  const w = frameEl.contentWindow as RendererWindow | null;
  if (!w?.__wp) {
    log(t("err.wpNotReady"), "error");
    return null;
  }
  return w.__wp;
}

/** 同上但不打日志：高频调用（指针注入每次 mousemove）用它，
 *  否则渲染器未就绪时会把日志面板刷爆。 */
export function wpQuiet(): WpApi | null {
  return (frameEl.contentWindow as RendererWindow | null)?.__wp ?? null;
}

export function frameStats(): FrameStats | undefined {
  try {
    // 跨源时读 contentWindow 会抛（渲染器同源，仅兜底）
    return (frameEl.contentWindow as RendererWindow | null)?.__wpStats?.frame();
  } catch {
    return undefined;
  }
}

/** 确保渲染器页已在 iframe 里就绪（本地 .pkg 预览前 iframe 可能还空着），
 *  需要时先补载一次渲染器页；resolve 出 __wp 控制面。 */
export function ensureRenderer(): Promise<WpApi> {
  return new Promise((resolve, reject) => {
    const existing = wpQuiet();
    if (existing) return resolve(existing);
    const onLoad = () => {
      frameEl.removeEventListener("load", onLoad);
      // 渲染器页是 module 脚本，load 事件后微任务里才挂 __wp；一拍 rAF 兜底
      requestAnimationFrame(() => {
        const api = wpQuiet();
        if (api) resolve(api);
        else reject(new Error("renderer page loaded but __wp missing"));
      });
    };
    frameEl.addEventListener("load", onLoad);
    frameEl.src = rendererUrl(`_t=${Date.now()}`);
  });
}
