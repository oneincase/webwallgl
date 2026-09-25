/**
 * GPU 探测：这台机器（这个页面）是不是**软件渲染**。
 *
 * 为什么需要：没有 GPU（虚拟机、远程桌面、驱动被拉黑、SwiftShader 兜底）时，壁纸的
 * 全部光栅化落在 CPU 上 —— 实测（M5 + `--use-angle=swiftshader`）稳态 **689~774% CPU
 * （7 个核）且 0~23fps**，其中 renderer 侧 JS 只占 0.02s/3s，全是软件光栅化。这种机器
 * 上必须默认关后处理 + 压画布分辨率（实测 0fps → 46fps，见 quality.ts 的
 * SOFTWARE_DPR_CAP）。
 *
 * 判据用 `WEBGL_debug_renderer_info` 的 UNMASKED_RENDERER_WEBGL 串：SwiftShader /
 * llvmpipe / lavapipe / softpipe / 「Microsoft Basic Render Driver」都是软件后端。
 * 拿不到调试扩展（部分 WebKit）时按「有 GPU」处理 —— 宁可不降档，也不要误伤真显卡。
 *
 * 探测要新建一个 WebGL 上下文，所以**整页只做一次**并缓存：库形态下一个页面可能
 * 挂多个实例，每个实例都建一次上下文既慢又浪费上下文配额（浏览器上限 ~16 个）。
 */
let cached: boolean | null = null;

/** 已探测结果（`null` = 还没探过）。诊断出口用。 */
export function softwareRendererCached(): boolean | null {
  return cached;
}

export function isSoftwareRenderer(): boolean {
  if (cached !== null) return cached;
  cached = false;
  try {
    const cv = document.createElement("canvas");
    const gl = (cv.getContext("webgl2") ?? cv.getContext("webgl")) as WebGL2RenderingContext | null;
    if (gl) {
      const dbg = gl.getExtension("WEBGL_debug_renderer_info");
      const name = String(
        (dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) ?? "",
      );
      cached = /swiftshader|llvmpipe|lavapipe|softpipe|software|basic render/i.test(name);
      // 立刻释放：探测用的上下文不该占着配额（页面真实上下文马上就建）
      try {
        gl.getExtension("WEBGL_lose_context")?.loseContext();
      } catch {
        /* 释放失败不影响判定 */
      }
    }
  } catch {
    cached = false;
  }
  return cached;
}

/** 测试/诊断用：清掉缓存（改了设备参数或想重探时） */
export function resetSoftwareRendererProbe(): void {
  cached = null;
}
