/* WebWallGL 测试台 Service Worker（纯静态托管用，本地 dev 不注册）。
 *
 * 策略：
 *   - HTML 导航 network-first：在线永远拿最新版，离线回落缓存（部署后老客户端
 *     最多滞后一次访问，不会被 SW 钉死在旧版）；
 *   - 带哈希的 assets / 图标等静态资源 cache-first（文件名变 = URL 变，天然免失效）；
 *   - /api/*、/diag 后端端点完全不拦（只在本地 dev 存在，缓存它们只会制造混乱）。
 *
 * 内部路径全部相对 SW 自身位置，GitHub Pages 的 /webwallgl/ 子路径与根路径部署通吃。
 */
const VERSION = "webwallgl-bench-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((c) => c.addAll(["./", "./renderer/index.html", "./manifest.webmanifest"])),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  const path = url.pathname;
  // 后端端点（dev server / 宿主）：直连，绝不拦截
  if (path.includes("/api/") || path.endsWith("/diag") || path.includes("/media/")) return;

  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(event.request, copy));
          return res;
        })
        .catch(() =>
          caches.match(event.request).then((hit) => hit || caches.match("./")),
        ),
    );
    return;
  }

  const ext = path.split(".").pop().toLowerCase();
  if (!["js", "css", "png", "svg", "webmanifest", "json", "woff2"].includes(ext)) return;
  event.respondWith(
    caches.match(event.request).then(
      (hit) =>
        hit ||
        fetch(event.request).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(event.request, copy));
          }
          return res;
        }),
    ),
  );
});
