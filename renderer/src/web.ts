// 网页壁纸（从 main.ts 拆出）：sandbox iframe + WE shim 兜底调用 + 子页 rAF 节流
import { clear, type Runtime } from "./shell";
import type { WallpaperConfig } from "./types";

export function mountWeb(rt: Runtime, cfg: WallpaperConfig) {
  clear(rt);
  const f = document.createElement("iframe");
  // allow-same-origin：Spine 等 WebGL 壁纸需同源加载纹理（图片污染画布 → texImage2D 报错）。
  // 安全：壁纸窗口本身无任何 Tauri IPC/能力，独立源隔离不降级。
  f.setAttribute("sandbox", "allow-scripts allow-same-origin");
  f.style.cssText =
    "position:absolute;inset:0;width:100%;height:100%;border:none;background:transparent;";
  f.src = cfg.src ?? "";
  rt.wrap?.appendChild(f);
  // 同源网页壁纸：加载后注入 GPU 降级脚本 + 屏蔽右键菜单
  const inject = () => {
    try {
      const doc = f.contentDocument;
      if (!doc) return;
      (window as any).__blockContextMenu?.(doc);
      injectGpuThrottle(rt, f, doc);
    } catch {
      /* 跨源/沙箱不可访问则忽略 */
    }
  };
  f.addEventListener("load", inject);
  rt.iframe = f;
}

/// 调用库内网页壁纸 iframe 里的 WE 兼容 shim 控制接口（同源；跨源/无 shim 静默忽略）
export function weShimCall(rt: Runtime, call: (win: any) => void) {
  try {
    const win = (rt.iframe as HTMLIFrameElement | null)?.contentWindow as any;
    if (win) call(win);
  } catch {
    /* 非同源 iframe 不可访问则忽略 */
  }
}

/// 向网页壁纸 iframe 注入 GPU 降级：requestAnimationFrame 帧率节流 → 限制
/// WebGL/canvas 动画到 sceneFps（默认 30），显著降低 GPU 占用。
/// 注意：不做 CSS transform 缩放（会破坏壁纸布局）；仅节流 rAF，安全且有效。
export function injectGpuThrottle(rt: Runtime, f: HTMLIFrameElement, _doc: Document) {
  const win = f.contentWindow;
  if (!win) return;
  // WE shim 已接管节流（注入时机更早且支持运行时调 fps），避免双层节流把帧率减半
  if ((win.requestAnimationFrame as any)?.__weThrottled) return;
  const fps = rt.cfg.sceneFps || 30;
  if (fps >= 60) return; // 60fps 已是目标上限，无需节流
  const interval = 1000 / fps;
  try {
    const origRaf = win.requestAnimationFrame.bind(win);
    const origCaf = win.cancelAnimationFrame.bind(win);
    const rafMap = new Map<number, number>();
    let counter = 0;
    // 用 setTimeout(≈fps 间隔) 替代原生 60fps rAF，callback 转发回 origRaf（保证仍同步到帧）。
    // WebKit 会按显示时机光栅化，帧率降半 → WebGL/canvas 动画 GPU 占用约减半。
    (win as any).requestAnimationFrame = (cb: FrameRequestCallback) => {
      const id = ++counter;
      const to = win.setTimeout(() => {
        rafMap.delete(id);
        origRaf((now: number) => {
          try {
            cb(now);
          } catch {
            /* 壁纸内部 rAF callback 抛错忽略 */
          }
        });
      }, interval);
      rafMap.set(id, to as unknown as number);
      return id;
    };
    (win as any).cancelAnimationFrame = (id: number) => {
      const to = rafMap.get(id);
      if (to !== undefined) {
        win.clearTimeout(to);
        rafMap.delete(id);
      }
    };
  } catch {
    /* 忽略 */
  }
}
