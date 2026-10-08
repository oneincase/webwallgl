/**
 * 打包应用的服务器入口（scripts/build-app.mjs 打成 app/server.mjs）。
 * 布局约定：本文件旁边是 site/（vite build 产物）与 web-shim.js；
 * 属性覆盖值写 ~/.webwallgl/props（与插件目录 ~/.webwallgl/plugins 同根）。
 */
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer, type ServeOptions } from "./serve";

export { DEFAULT_PORT } from "./serve";

const here = dirname(fileURLToPath(import.meta.url));

export function startApp(opts: Omit<ServeOptions, "siteDir" | "webShimPath" | "propsDir"> = {}) {
  return startServer({
    siteDir: join(here, "site"),
    webShimPath: join(here, "web-shim.js"),
    propsDir: join(homedir(), ".webwallgl", "props"),
    ...opts,
  });
}
