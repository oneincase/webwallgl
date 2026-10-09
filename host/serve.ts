/**
 * 生产环境 HTTP 服务器：静态托管 `vite build` 的站点产物 + 宿主端点（createHostMiddleware）。
 * 不依赖 Vite；scripts/build-app.mjs 把本文件连同 host/* 打成 app/server.mjs，
 * 供 `npx webwallgl-app`（浏览器模式）与打包后的 Electron 应用共用。
 *
 * 端口固定（缺省 1431，与 dev 的 1430 错开）：编辑器草稿、壁纸库目录等存在 localStorage，
 * 按 origin 隔离，端口一变数据就「丢」了；被占时才顺延到后面的端口。
 */
import { createReadStream, promises as fs } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { createHostMiddleware, type FolderPicker } from "./wallpaper-host";

export const DEFAULT_PORT = 1431;

export type ServeOptions = {
  /** vite build 产物目录（含 editor/ renderer/ assets/ …） */
  siteDir: string;
  port?: number;
  host?: string;
  /** 端口被占时最多顺延几个；0 = 严格使用指定端口 */
  portRetries?: number;
  pickFolder?: FolderPicker;
  logger?: { info(msg: string): void };
  /** 网页壁纸 shim 源文件（缺省按仓库布局找 renderer/src/web-shim.js） */
  webShimPath?: string;
  /** 壁纸属性覆盖值目录（缺省仓库根 .we-props/） */
  propsDir?: string;
  bridgeMissingHint?: string;
};

export type RunningServer = { server: Server; port: number; origin: string; close(): Promise<void> };

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
};

async function serveStatic(root: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  let rel: string;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    rel = url.pathname;
  }
  const target = resolve(root, normalize(rel).replace(/^([/\\])+/, ""));
  if (target !== root && !target.startsWith(root + sep)) {
    res.statusCode = 403;
    res.end("Forbidden");
    return;
  }
  let file = target;
  try {
    const st = await fs.stat(file);
    if (st.isDirectory()) {
      if (!url.pathname.endsWith("/")) {
        res.statusCode = 301;
        res.setHeader("Location", `${url.pathname}/${url.search}`);
        res.end();
        return;
      }
      file = join(file, "index.html");
    }
  } catch {
    /* 下面 stat 再判 404 */
  }
  let size: number;
  try {
    const st = await fs.stat(file);
    if (!st.isFile()) throw new Error("not a file");
    size = st.size;
  } catch {
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Not Found");
    return;
  }
  const ext = extname(file).toLowerCase();
  res.statusCode = 200;
  res.setHeader("Content-Type", MIME[ext] ?? "application/octet-stream");
  res.setHeader("Content-Length", String(size));
  // assets/ 下是带哈希的产物，可长缓存；HTML 等入口每次协商
  res.setHeader("Cache-Control", rel.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache");
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  await new Promise<void>((done) => {
    const stream = createReadStream(file);
    stream.on("error", () => {
      res.destroy();
      done();
    });
    res.on("close", () => {
      stream.destroy();
      done();
    });
    stream.pipe(res);
  });
}

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((ok, fail) => {
    const onError = (e: Error) => {
      server.off("listening", onListening);
      fail(e);
    };
    const onListening = () => {
      server.off("error", onError);
      const addr = server.address();
      ok(typeof addr === "object" && addr ? addr.port : port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

export async function startServer(opts: ServeOptions): Promise<RunningServer> {
  const siteDir = resolve(opts.siteDir);
  const host = opts.host ?? "127.0.0.1";
  const logger = opts.logger ?? { info: (msg: string) => console.log(msg) };
  if (opts.webShimPath) process.env.WWGL_WEB_SHIM = resolve(opts.webShimPath);
  if (opts.propsDir) process.env.WWGL_PROPS_DIR = resolve(opts.propsDir);
  const handler = createHostMiddleware({ logger, pickFolder: opts.pickFolder, bridgeMissingHint: opts.bridgeMissingHint });

  const server = createServer((req, res) => {
    const fallthrough = () => {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.statusCode = 405;
        res.end("Method Not Allowed");
        return;
      }
      serveStatic(siteDir, req, res).catch((e) => {
        if (!res.headersSent) res.statusCode = 500;
        res.end(String((e as Error)?.message ?? e));
      });
    };
    handler(req, res, fallthrough).catch((e) => {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end(String((e as Error)?.message ?? e));
      } else {
        res.destroy();
      }
    });
  });

  const base = opts.port ?? DEFAULT_PORT;
  const retries = opts.portRetries ?? 10;
  let port = -1;
  for (let i = 0; i <= retries; i++) {
    try {
      port = await listen(server, base + i, host);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE" || i === retries) throw e;
      logger.info(`[serve] 端口 ${base + i} 被占用，尝试 ${base + i + 1}`);
    }
  }
  // 不写 localhost：部分系统先解析到 ::1，而缺省只监听 IPv4
  const shownHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return {
    server,
    port,
    origin: `http://${shownHost}:${port}`,
    close: () => new Promise((ok) => server.close(() => ok())),
  };
}
