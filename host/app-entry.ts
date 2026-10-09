/**
 * 打包应用的服务器入口（scripts/build-app.mjs 打成 app/server.mjs）。
 * 布局约定：本文件旁边是 site/（vite build 产物）与 web-shim.js；
 * 属性覆盖值写 ~/.webwallgl/props（与插件目录 ~/.webwallgl/plugins 同根）。
 *
 * media-bridge（系统正在播放 + 系统音频频谱）：桌面安装包内置的由 Electron 主进程经 MEDIA_BRIDGE_BIN 传进来；
 * 否则（npx / npm 安装）首次启动在后台下载到 ~/.webwallgl/bin，装好即启用，不阻塞页面打开。
 * WWGL_NO_MEDIA_BRIDGE=1（CLI 的 --no-media-bridge）整个关掉。
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureMediaBridge, installedMediaBridgePath, mediaBridgeAsset } from "./media-bridge-release.mjs";
import { startServer, type ServeOptions } from "./serve";
import { useBridgeBinary } from "./system-live";

export { DEFAULT_PORT } from "./serve";

const here = dirname(fileURLToPath(import.meta.url));

type BridgePlan = "ready" | "install" | "disabled" | "unsupported";

function bridgePlan(): BridgePlan {
  if (process.env.WWGL_NO_MEDIA_BRIDGE === "1") return "disabled";
  if (process.env.MEDIA_BRIDGE_BIN || existsSync(installedMediaBridgePath())) return "ready";
  return mediaBridgeAsset() ? "install" : "unsupported";
}

const MISSING_HINT: Record<BridgePlan, string> = {
  ready: "media-bridge 启动失败；系统媒体信息不可用，不影响壁纸播放",
  install: "首次使用，正在后台下载 media-bridge（系统正在播放 + 音频频谱），完成后自动启用",
  disabled: "已关闭 media-bridge（--no-media-bridge）",
  unsupported: `当前平台（${process.platform}-${process.arch}）没有 media-bridge 预编译版本；系统媒体信息不可用，不影响壁纸播放`,
};

export async function startApp(opts: Omit<ServeOptions, "siteDir" | "webShimPath" | "propsDir" | "bridgeMissingHint"> = {}) {
  const logger = opts.logger ?? { info: (msg: string) => console.log(msg) };
  const plan = bridgePlan();
  const srv = await startServer({
    siteDir: join(here, "site"),
    webShimPath: join(here, "web-shim.js"),
    propsDir: join(homedir(), ".webwallgl", "props"),
    bridgeMissingHint: MISSING_HINT[plan],
    ...opts,
  });
  if (plan === "install") {
    ensureMediaBridge()
      .then(async (bin) => {
        if (!bin) return;
        const { backend } = await useBridgeBinary(bin);
        logger.info(
          backend === "media-bridge"
            ? `[host] 系统实况：media-bridge 已安装并启用（${bin}）`
            : `[host] 系统实况：media-bridge 已下载但启动失败（${bin}）；系统媒体信息不可用，不影响壁纸播放`,
        );
      })
      .catch((e) => {
        logger.info(
          `[host] 系统实况：media-bridge 下载失败（${(e as Error)?.message ?? e}）；下次启动会重试。` +
            `网络受限时可设 WWGL_MEDIA_BRIDGE_MIRROR 指向镜像，或用 MEDIA_BRIDGE_BIN 指定本地二进制`,
        );
      });
  }
  return srv;
}
