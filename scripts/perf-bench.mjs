#!/usr/bin/env node
/**
 * perf-bench —— 壁纸**加载耗时**与**运行开销**的实测台（真 GPU 无头 Chrome）。
 *
 * 为什么不能用测试台（vite dev）量：
 *   开发服务器把渲染器拆成几百个 ESM 模块逐个请求，加载耗时里大半是 dev 的
 *   transform/HTTP 往返，与用户实际看到的（打包产物）不是一回事。本脚本自带
 *   静态服务，直接吃 `vite build` 的产物，媒体端点对齐 host/wallpaper-host.ts
 *   的 `/media/{token}/{itemId}/…`，所以量到的就是宿主里的那条路径。
 *
 * 量什么：
 *   · ttffMs      导航 → 首个真正提交的帧（`__wpStats.frame().fps > 0`）。
 *                 场景壁纸的渲染循环在装配全部结束之后才启动，所以它≈整页加载。
 *   · settleMs    首帧 → 出帧节奏稳定（连续 N 次读数 fps 不再爬升）。
 *   · cpu%        稳态窗口的进程树 CPU 占单核百分比，按 type 拆
 *                 （renderer / gpu / browser），GPU 那项才是重场壁纸的元凶。
 *   · fps         稳态窗口内 `__wpStats.frame()` 的均值（受帧率上限约束）。
 *   · 诊断/异常    /diag 上报与页面 console 错误，加载失败会显式记下来。
 *
 * 逐阶段归因（`--trace`）与 JS 热点（`--profile`）另开一档，因为它们本身有
 * 开销（包装 GL/fetch 会改变被测对象的时序），只在与基线同一条件下横向比较才
 * 有意义，不能和基线数字混着看。
 *
 * 用法：
 *   node scripts/perf-bench.mjs --sample 40                     # 分层抽样跑一遍
 *   node scripts/perf-bench.mjs --items 2517518192,1039919954
 *   node scripts/perf-bench.mjs --items 3679122549 --trace --profile
 *   node scripts/perf-bench.mjs --sample 12 --type scene --repeat 2
 *
 *   --dist <dir>     生产构建产物目录（默认 /tmp/webench-dist，缺失时提示先构建）
 *   --lib <dir>      壁纸库（默认同 verify-kit 的 LIB）
 *   --steady <ms>    稳态采样窗口（默认 4000）
 *   --settle <ms>    首帧后等待进入稳态的时间（默认 1500）
 *   --budget <ms>    单张总时限，超时算 fail（默认 60000）
 *   --out <file>     JSON 输出路径（默认 /tmp/perf-bench/<ts>.json）
 *   --no-cache       保留 HTTP 缓存（默认禁用，量冷加载）
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launchHeadless, instrument } from "./headless-gpu.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 壁纸库目录：WE_LIBRARY 覆盖，否则与 scripts/lib/verify-kit.mjs 同源 */
function defaultLib() {
  if (process.env.WE_LIBRARY) return process.env.WE_LIBRARY;
  return path.join(
    os.homedir(),
    "Library/Application Support/io.github.oneincase.wallpaperem/wallpapers",
  );
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".txt": "text/plain; charset=utf-8",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".pkg": "application/octet-stream",
  ".tex": "application/octet-stream",
};

/**
 * 静态产物 + 壁纸库媒体端点 + /diag 收集。
 *
 * 缓存策略刻意保守：静态产物带 no-store（保证每次都是新加载的 JS），媒体文件
 * 默认也不给缓存（`--no-cache` 打开浏览器侧缓存），因为「第一次挂上这张壁纸要
 * 等多久」才是用户抱怨的那个数。
 */
function startServer({ dist, lib, token = "dev", allowCache = false }) {
  const diag = [];
  const mediaCacheHeaders = allowCache ? {} : { "Cache-Control": "no-store" };

  const serveFile = (res, file, { cache = mediaCacheHeaders } = {}) => {
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      res.statusCode = 404;
      res.end("not found");
      return false;
    }
    if (st.isDirectory()) {
      res.statusCode = 403;
      res.end("dir");
      return false;
    }
    res.setHeader("Content-Type", MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream");
    res.setHeader("Content-Length", st.size);
    for (const [k, v] of Object.entries(cache)) res.setHeader(k, v);
    // Range：视频纹理 seek 需要 206（与 host 的 serveRange 同语义，简版）
    const range = res.req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(String(range));
      if (m) {
        const start = m[1] ? Number(m[1]) : 0;
        const end = m[2] ? Number(m[2]) : st.size - 1;
        if (start <= end && start < st.size) {
          res.statusCode = 206;
          res.setHeader("Content-Range", `bytes ${start}-${end}/${st.size}`);
          res.setHeader("Content-Length", end - start + 1);
          fs.createReadStream(file, { start, end }).pipe(res);
          return true;
        }
      }
    }
    fs.createReadStream(file).pipe(res);
    return true;
  };

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    const p = decodeURIComponent(u.pathname);

    if (p === "/diag") {
      const msg = u.searchParams.get("msg") ?? "";
      if (msg) diag.push(msg);
      res.setHeader("Content-Type", "image/gif");
      res.setHeader("Cache-Control", "no-store");
      res.end(Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"));
      return;
    }

    // /media/<token>/<itemId>/<path…> 与 /web/<token>/<itemId>/<path…> 同一张表
    const m = /^\/(?:media|web)\/[^/]+\/([^/]+)\/(.+)$/.exec(p);
    if (m) {
      const itemDir = path.join(lib, m[1]);
      const rel = m[2].replace(/\/+$/, "") || "index.html";
      let file = path.join(itemDir, rel);
      // 目录请求 → 站点入口；与 host 的 WEB 端点一致（工坊网页壁纸的站点根）
      if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
      if (!file.startsWith(itemDir)) {
        res.statusCode = 403;
        res.end("escape");
        return;
      }
      serveFile(res, file);
      return;
    }

    const rel = p === "/" ? "/index.html" : p;
    if (!serveFile(res, path.join(dist, rel), { cache: { "Cache-Control": "no-store" } })) return;
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port, diag, token });
    });
  });
}

/** 扫库：与 host/wallpaper-host.ts 的 scanLibrary 同判据（hasScene 优先 → scene） */
function scanLibrary(lib) {
  const items = [];
  for (const name of fs.readdirSync(lib)) {
    if (name.startsWith(".")) continue;
    const dir = path.join(lib, name);
    let st;
    try {
      st = fs.statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    let project = null;
    try {
      project = JSON.parse(fs.readFileSync(path.join(dir, "project.json"), "utf8"));
    } catch {
      /* 无 project.json 也允许 */
    }
    const hasScene =
      fs.existsSync(path.join(dir, "scene.pkg")) || fs.existsSync(path.join(dir, "scenes/scene.pkg"));
    const file = project?.file;
    const type = hasScene ? "scene" : String(project?.type ?? "unknown").toLowerCase();
    let size = 0;
    try {
      for (const f of fs.readdirSync(dir)) {
        try {
          size += fs.statSync(path.join(dir, f)).size;
        } catch {}
      }
    } catch {}
    items.push({
      itemId: name,
      title: project?.title ?? name,
      type,
      file,
      hasScene,
      sizeBytes: size,
      pkgBytes: (() => {
        for (const rel of ["scene.pkg", "scenes/scene.pkg", "gifscene.pkg"]) {
          try {
            return fs.statSync(path.join(dir, rel)).size;
          } catch {}
        }
        return 0;
      })(),
    });
  }
  return items;
}

/** 渲染器页 query（对齐 bench/bench.ts 的 buildQuery，逐字段含义见那里） */
function rendererUrl({ origin, item, mediaBase, webBase, dpr = 0, aa, pp, pq, fps = 60, noQuality = false, noBake = false, extra = {} }) {
  const p = new URLSearchParams();
  p.set("type", item.hasScene ? "scene" : item.type);
  if (item.hasScene || item.type === "scene") p.set("src", item.itemId);
  else if (item.type === "web") p.set("src", `${webBase}/${item.itemId}/${item.file ?? "index.html"}`);
  else if (item.file) p.set("src", `${mediaBase}/${item.itemId}/${item.file}`);
  p.set("mediaBase", mediaBase);
  p.set("fit", "cover");
  p.set("renderDpr", String(dpr));
  p.set("sceneFps", String(fps));
  // --no-quality：一个档位都别写，让渲染器的自动降档（软件预设 / 帧率守门）接管。
  // 显式写了档位就按「显式优先」跳过自动降档 —— 这正是要被测的那个契约。
  if (!noQuality) {
    p.set("aa", aa ?? "off");
    p.set("pq", pq ?? "high");
    p.set("pp", pp ?? "high");
  }
  p.set("muted", "true");
  p.set("loop", "true");
  // --no-bake：关掉贴图烘焙（内嵌图预缩放缓存），量基线用
  if (noBake) p.set("bake", "0");
  for (const [k, v] of Object.entries(extra)) p.set(k, String(v));
  return `${origin}/renderer/index.html?${p.toString()}`;
}

/**
 * 文档开始前注入的探针（不包装任何业务函数，基线不受影响）：
 * 用 rAF 轮询自己数「首个提交帧」，比 CDP 侧 150ms 轮询精确一个数量级。
 */
const PERF_HOOK = `(() => {
  const P = (window.__perf = { t0: performance.now(), raf: 0, firstFrameMs: null, cells: [], errors: [] });
  window.addEventListener("error", (e) => P.errors.push(String((e && e.message) || e).slice(0, 200)));
  window.addEventListener("unhandledrejection", (e) => P.errors.push("rejection: " + String((e && e.reason && e.reason.message) || e.reason).slice(0, 200)));
  const tick = () => {
    P.raf++;
    const f = window.__wpStats && window.__wpStats.frame();
    if (f && f.running && f.fps > 0) { P.firstFrameMs = performance.now(); P.cells.push({ ms: P.firstFrameMs, fps: f.fps }); return; }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();`;

/** 稳态窗口逐帧采样（同样只读，不改业务） */
const FPS_PROBE = `(() => {
  const out = [];
  const tick = () => {
    const f = window.__wpStats && window.__wpStats.frame();
    out.push(f ? f.fps : 0);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  window.__fpsProbe = () => out.splice(0, out.length);
})();`;

/**
 * 阶段归因探针（--trace）。包装的都是**浏览器 API**，不是本库函数 ——
 * 结论不依赖「我们以为热点在哪」，也不给被测代码加分支。
 * 代价：每次 GL 调用多一层 JS 栈，只作同条件横向比较。
 */
const TRACE_HOOK = `(() => {
  const S = (window.__trace = {
    t0: performance.now(),
    net: [], decode: [], upload: { calls: 0, bytes: 0, ms: 0 }, shader: { compiles: 0, links: 0, ms: 0 },
    draws: 0, drawsMs: 0, gl: { texImage: 0, texStorage: 0, bufferData: 0, bufferBytes: 0 }, frames: null,
  });
  const now = () => performance.now();

  // ---- 网络：fetch 的「排队+头」与「读体」分开记（大 pkg 的瓶颈常在读体）
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = String((typeof input === "string" ? input : input && input.url) || "");
    const t = now();
    const rec = { url: url.slice(0, 180), t, head: 0, body: 0, bytes: 0, error: null };
    S.net.push(rec);
    return origFetch.apply(this, arguments).then((res) => {
      rec.head = now() - t;
      rec.status = res.status;
      try {
        const cl = res.headers.get("content-length");
        if (cl) rec.declared = Number(cl);
      } catch {}
      const oab = res.arrayBuffer.bind(res);
      const oblob = res.blob.bind(res);
      const mark = (p, bytes) => { rec.body = now() - t - rec.head; if (bytes != null) rec.bytes = bytes; return p; };
      try { res.arrayBuffer = () => { const s = now(); return oab().then((b) => (rec.body = now() - s, rec.bytes = b.byteLength, b)); }; } catch {}
      try { res.blob = () => { const s = now(); return oblob().then((b) => (rec.body = now() - s, rec.bytes = b.size, b)); }; } catch {}
      return res;
    }, (e) => { rec.error = String((e && e.message) || e); rec.body = now() - t; throw e; });
  };

  // ---- 图片/GIF 解码
  const ocib = window.createImageBitmap;
  if (ocib) {
    window.createImageBitmap = function () {
      const args = arguments;
      const t = now();
      const rec = { t, ms: 0, w: 0, h: 0 };
      S.decode.push(rec);
      return ocib.apply(this, args).then((bmp) => {
        rec.ms = now() - t; rec.w = bmp.width; rec.h = bmp.height;
        return bmp;
      }, (e) => { rec.ms = now() - t; rec.error = String((e && e.message) || e); throw e; });
    };
  }
  if (window.ImageDecoder) {
    const OD = window.ImageDecoder;
    for (const m of ["decode", "decodeFrame"]) {
      const of = OD.prototype[m];
      if (typeof of !== "function") continue;
      OD.prototype[m] = function () {
        const t = now();
        const rec = { t, ms: 0, kind: "ImageDecoder." + m };
        S.decode.push(rec);
        return of.apply(this, arguments).then((r) => { rec.ms = now() - t; return r; },
          (e) => { rec.ms = now() - t; rec.error = String((e && e.message) || e); throw e; });
      };
    }
  }

  // ---- WebGL：上传 / 着色器编译 / 绘制。按 context 实例挂，避免影响其它上下文
  const bytesOf = (a) => (a && (a.byteLength || a.length) || 0);
  const wrapGL = (proto, name, fn) => {
    const orig = proto[name];
    if (typeof orig !== "function") return;
    proto[name] = function () {
      return fn(orig, this, arguments);
    };
  };
  const P2 = WebGL2RenderingContext.prototype;
  const P1 = WebGLRenderingContext.prototype;
  for (const P of [P2, P1]) {
    wrapGL(P, "texImage2D", (orig, self, args) => {
      const t = now();
      const r = orig.apply(self, args);
      const src = args[5];
      const px = args[5] instanceof ArrayBuffer || ArrayBuffer.isView(args[5]) ? bytesOf(args[5]) : 0;
      S.upload.calls++; S.gl.texImage++;
      S.upload.bytes += px;
      S.upload.ms += now() - t;
      return r;
    });
    wrapGL(P, "texSubImage2D", (orig, self, args) => {
      const t = now();
      const r = orig.apply(self, args);
      S.upload.calls++;
      S.upload.bytes += bytesOf(args[6]);
      S.upload.ms += now() - t;
      return r;
    });
    wrapGL(P, "texStorage2D", (orig, self, args) => {
      const t = now();
      const r = orig.apply(self, args);
      S.gl.texStorage++;
      S.upload.ms += now() - t;
      return r;
    });
    wrapGL(P, "compressedTexImage2D", (orig, self, args) => {
      const t = now();
      const r = orig.apply(self, args);
      S.upload.calls++; S.upload.bytes += bytesOf(args[6]);
      S.upload.ms += now() - t;
      return r;
    });
    wrapGL(P, "generateMipmap", (orig, self, args) => {
      const t = now();
      const r = orig.apply(self, args);
      S.upload.ms += now() - t;
      return r;
    });
    wrapGL(P, "compileShader", (orig, self, args) => {
      const t = now();
      const r = orig.apply(self, args);
      S.shader.compiles++; S.shader.ms += now() - t;
      return r;
    });
    wrapGL(P, "linkProgram", (orig, self, args) => {
      const t = now();
      const r = orig.apply(self, args);
      S.shader.links++; S.shader.ms += now() - t;
      return r;
    });
    wrapGL(P, "bufferData", (orig, self, args) => {
      const t = now();
      const r = orig.apply(self, args);
      S.gl.bufferData++; S.gl.bufferBytes += bytesOf(args[1]);
      return r;
    });
    for (const dn of ["drawElements", "drawArrays", "drawElementsInstanced", "drawArraysInstanced"]) {
      wrapGL(P, dn, (orig, self, args) => { S.draws++; return orig.apply(self, args); });
    }
  }
})();`;

function parseArgs(argv) {
  const a = {
    items: null,
    sample: null,
    type: null,
    repeat: 1,
    steady: 4000,
    settle: 1500,
    budget: 60000,
    trace: false,
    profile: false,
    software: false,
    dpr: 0,
    fps: 60,
    noQuality: false,
    noBake: false,
    abBake: false,
    aa: null,
    pp: null,
    pq: null,
    label: null,
    dist: "/tmp/webench-dist",
    lib: defaultLib(),
    out: null,
    cache: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const v = () => argv[++i];
    if (k === "--items") a.items = v().split(",").map((s) => s.trim()).filter(Boolean);
    else if (k === "--sample") a.sample = Number(v());
    else if (k === "--type") a.type = v();
    else if (k === "--repeat") a.repeat = Number(v());
    else if (k === "--steady") a.steady = Number(v());
    else if (k === "--settle") a.settle = Number(v());
    else if (k === "--budget") a.budget = Number(v());
    else if (k === "--trace") a.trace = true;
    else if (k === "--profile") a.profile = true;
    else if (k === "--software") a.software = true;
    else if (k === "--dpr") a.dpr = Number(v());
    else if (k === "--fps") a.fps = Number(v());
    else if (k === "--no-quality") a.noQuality = true;
    else if (k === "--no-bake") a.noBake = true;
    else if (k === "--ab-bake") a.abBake = true;
    else if (k === "--aa") a.aa = v();
    else if (k === "--pp") a.pp = v();
    else if (k === "--pq") a.pq = v();
    else if (k === "--label") a.label = v();
    else if (k === "--dist") a.dist = v();
    else if (k === "--lib") a.lib = v();
    else if (k === "--out") a.out = v();
    else if (k === "--no-cache") a.cache = true;
    else if (k === "--help" || k === "-h") a.help = true;
    else throw new Error(`未知参数：${k}`);
  }
  return a;
}

/**
 * 抽样：按类型分层 + 尺寸分位，保证每次都覆盖「小而轻 / 大而重」两端。
 * 纯随机抽样在大库上会被同类壁纸淹没，看不到类型差异。
 */
function pickSample(items, n, typeFilter) {
  const pool = typeFilter ? items.filter((i) => i.type === typeFilter) : items;
  const byType = new Map();
  for (const it of pool) {
    if (!byType.has(it.type)) byType.set(it.type, []);
    byType.get(it.type).push(it);
  }
  const out = [];
  const types = [...byType.keys()].sort();
  const perType = Math.max(1, Math.floor(n / types.length));
  for (const t of types) {
    const list = byType.get(t).sort((a, b) => a.sizeBytes - b.sizeBytes);
    const step = Math.max(1, Math.floor(list.length / perType));
    for (let i = 0; i < perType && i * step < list.length; i++) out.push(list[i * step]);
  }
  return out.slice(0, Math.max(n, types.length));
}

/**
 * 进程树 CPU 增量。
 *
 * **必须按 pid 取交集**：`SystemInfo.getProcessInfo` 给的是「当前活着的进程」的
 * 累计 CPU 秒，某个 renderer 在上一次采样之后退出时，它的秒数会从总和里消失 ——
 * 直接相减会得到负的 CPU%（实测 -20%）。只统计两次采样都在的 pid，宁可少算
 * 一个正在死掉的进程，也不让统计量变成没有意义的负数。
 */
function cpuDelta(before, after) {
  const prev = new Map((before.processes ?? []).map((p) => [p.id, p]));
  const byType = {};
  let cpu = 0;
  for (const p of after.processes ?? []) {
    const b = prev.get(p.id);
    if (!b) continue; // 窗口中途新生（可能是另一个 target 的进程）不计
    const d = p.cpuTime - b.cpuTime;
    if (!(d > 0)) continue;
    const t = p.type || "unknown";
    byType[t] = +((byType[t] || 0) + d).toFixed(3);
    cpu += d;
  }
  return { cpu: +cpu.toFixed(3), byType };
}

/**
 * V8 采样剖面的自时间聚合。
 *
 * 自时间（self time）= 该帧在栈顶时采到的样本时长之和，也就是「这个函数自己烧掉的
 * CPU」。父节点的总时间会被子节点摊掉，看自时间才能定位真正的热点函数。
 * 按「函数名 @ 文件:行」聚合，跨调用点合并同一函数。
 */
function aggregateProfile(profile, intervalMs) {
  if (!profile?.nodes) return null;
  const nodeById = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  let total = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    const dt = (profile.timeDeltas?.[i] ?? intervalMs * 1000) / 1000; // µs → ms
    total += dt;
    const n = nodeById.get(profile.samples[i]);
    if (!n) continue;
    const cf = n.callFrame || {};
    const key = `${cf.functionName || "(anonymous)"} @ ${String(cf.url || "").replace(/^.*\//, "")}:${(cf.lineNumber ?? 0) + 1}`;
    self.set(key, (self.get(key) || 0) + dt);
  }
  const top = [...self.entries()]
    .map(([fn, ms]) => ({ fn, ms: +ms.toFixed(1), pct: total > 0 ? +((ms / total) * 100).toFixed(1) : 0 }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 25);
  return { totalMs: +total.toFixed(0), top };
}

/** 一张壁纸：开新 target → 计时 → 稳态采样 → 关闭 */
async function measureOne(session, { item, url, steady, settle, budget, trace, profile, allowCache, dpr }) {
  const rec = {
    itemId: item.itemId,
    title: item.title,
    type: item.hasScene ? "scene" : item.type,
    sizeBytes: item.sizeBytes,
    pkgBytes: item.pkgBytes,
  };
  const diagFrom = session.__diag ? session.__diag.length : 0;
  const page = await session.newPage("about:blank");
  try {
    await page.cdp.send("Network.enable");
    await page.cdp.send("Network.setCacheDisabled", { cacheDisabled: !allowCache });
    // 探针顺序：先 trace（它要在页面脚本之前包好 GL/fetch），后 perf hook
    if (trace) await page.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: TRACE_HOOK });
    await page.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: PERF_HOOK });
    /** 采样剖面：200µs 一采样，装的是 V8 自带的采样器（不是插桩），对被测代码无侵入。 */
    const profOn = async () => {
      if (!profile) return;
      await page.cdp.send("Profiler.enable");
      await page.cdp.send("Profiler.setSamplingInterval", { interval: 200 });
      await page.cdp.send("Profiler.start");
    };
    const profOff = async () => {
      if (!profile) return null;
      const { profile: p } = await page.cdp.send("Profiler.stop");
      return aggregateProfile(p, 0.2);
    };

    const navAt = Date.now();
    await profOn();
    await page.cdp.send("Page.navigate", { url });

    // 首帧由页面内 rAF 自己数（一个 tick 的精度），CDP 侧只负责轮询读取
    const deadline = Date.now() + budget;
    let firstFrame = null;
    while (Date.now() < deadline) {
      firstFrame = await page.evaluate("window.__perf && window.__perf.firstFrameMs").catch(() => null);
      if (typeof firstFrame === "number" && firstFrame > 0) break;
      firstFrame = null;
      await sleep(25);
    }
    rec.wallMs = Date.now() - navAt;
    if (firstFrame == null) {
      rec.fail = "首帧超时";
      rec.diag = (session.__diag ?? []).slice(diagFrom);
      rec.errors = (await page.evaluate("window.__perf && window.__perf.errors").catch(() => [])) ?? [];
      return rec;
    }
    rec.ttffMs = Math.round(firstFrame);
    // 加载期剖面（导航 → 首帧）：回答「这几秒花在哪个函数上」
    rec.profileLoad = await profOff();

    await sleep(settle);
    await page.evaluate(FPS_PROBE).catch(() => {});
    await profOn();

    const before = await session.processInfo();
    const w0 = Date.now();
    await sleep(steady);
    const fpsSamples = (await page.evaluate("window.__fpsProbe ? window.__fpsProbe() : []").catch(() => [])) ?? [];
    rec.profileSteady = await profOff();
    const after = await session.processInfo();
    const winMs = Date.now() - w0;

    // 尾段 fps：自动降档要 5s 保护期 + 3 个低帧窗口才动手，整窗平均会把降档前后的
    // 数字搅在一起。取窗口**后半段**（≥2s）的均值，才能看出"降档之后真的稳住没有"。
    const tail = fpsSamples.length >= 8 ? fpsSamples.slice(-Math.max(4, Math.floor(fpsSamples.length / 2))) : fpsSamples;
    const { cpu: cpuSeconds, byType } = cpuDelta(before, after);
    rec.steady = {
      ms: winMs,
      cpuSeconds,
      cpuPercent: +((cpuSeconds / (winMs / 1000)) * 100).toFixed(1),
      byType,
      fpsAvg: fpsSamples.length ? +(fpsSamples.reduce((a, b) => a + b, 0) / fpsSamples.length).toFixed(1) : 0,
      fpsTail: tail.length ? +(tail.reduce((a, b) => a + b, 0) / tail.length).toFixed(1) : 0,
      fpsMin: fpsSamples.length ? Math.min(...fpsSamples) : 0,
      samples: fpsSamples.length,
    };

    if (trace) {
      rec.trace = await page
        .evaluate(`(() => {
        const S = window.__trace; if (!S) return null;
        const sum = (list, k) => list.reduce((a, b) => a + (b[k] || 0), 0);
        const net = S.net.slice().sort((a, b) => ((b.body || 0) + b.head) - ((a.body || 0) + a.head));
        const dec = S.decode.slice().sort((a, b) => b.ms - a.ms);
        return {
          netCount: S.net.length, netMs: Math.round(sum(S.net, "head") + sum(S.net, "body")),
          netTop: net.slice(0, 6).map((r) => ({ url: r.url, head: Math.round(r.head), body: Math.round(r.body || 0), bytes: r.bytes || r.declared || 0, status: r.status, error: r.error })),
          decodeCount: S.decode.length, decodeMs: Math.round(sum(S.decode, "ms")),
          decodeTop: dec.slice(0, 6).map((r) => ({ ms: Math.round(r.ms), w: r.w, h: r.h, kind: r.kind, error: r.error })),
          upload: { calls: S.upload.calls, bytes: S.upload.bytes, ms: Math.round(S.upload.ms) },
          shader: { compiles: S.shader.compiles, links: S.shader.links, ms: Math.round(S.shader.ms) },
          draws: S.draws,
        };
      })()`)
        .catch(() => null);
    }

    // 烘焙的正式统计字段（__memStats().bake）：A/B 报告要能看出命中/补烘，而不是只看耗时
    rec.bakeStats = await page
      .evaluate("(() => { const m = window.__memStats && window.__memStats(); return (m && m.bake) || null; })()")
      .catch(() => null);
    rec.diag = (session.__diag ?? []).slice(diagFrom).slice(profile ? -60 : -12);
    rec.errors = (await page.evaluate("window.__perf && window.__perf.errors").catch(() => [])) ?? [];
    return rec;
  } finally {
    await page.close().catch(() => {});
    // 等 renderer 进程真的退干净：它的 CPU 秒数会从下一次采样的总和里消失，
    // 落进稳态窗口就是负增量（见 cpuDelta 注释）。
    await sleep(400);
  }
}

export async function main(argv = process.argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]);
    return 0;
  }
  if (!fs.existsSync(args.dist)) {
    console.error(`构建产物不存在：${args.dist}\n  先构建：npx vite build --base=/ --outDir ${args.dist} --emptyOutDir`);
    return 2;
  }
  if (!fs.existsSync(args.lib)) {
    console.error(`壁纸库不存在：${args.lib}\n  用 WE_LIBRARY=/path/to/wallpapers 指定`);
    return 2;
  }

  const lib = scanLibrary(args.lib);
  let selected = [];
  if (args.items) {
    const by = new Map(lib.map((i) => [i.itemId, i]));
    for (const id of args.items) {
      const it = by.get(id);
      if (!it) {
        console.error(`库中无此条目：${id}`);
        continue;
      }
      selected.push(it);
    }
  } else {
    const n = args.sample ?? 12;
    selected = pickSample(lib, n, args.type);
  }
  if (!selected.length) {
    console.error("没有选中任何壁纸");
    return 2;
  }

  const typeCount = selected.reduce((m, i) => ((m[i.type] = (m[i.type] || 0) + 1), m), {});
  console.log(
    `[perf-bench] 库 ${lib.length} 张，本次 ${selected.length} 张（${Object.entries(typeCount)
      .map(([k, v]) => `${k}×${v}`)
      .join(" / ")}），trace=${args.trace} profile=${args.profile} 后端=${args.software ? "software" : "gpu"} dpr=${args.dpr || "auto"} fps=${args.fps} bake=${args.noBake ? "off" : "on"} ${args.noQuality ? "quality=auto" : `aa=${args.aa ?? "off"} pp=${args.pp ?? "high"} pq=${args.pq ?? "high"}`}`,
  );

  const { server, port, diag } = await startServer({ dist: args.dist, lib: args.lib, allowCache: args.cache });
  const origin = `http://127.0.0.1:${port}`;
  const mediaBase = `${origin}/media/dev`;
  const webBase = `${origin}/web/dev`;

  let session;
  const results = [];
  try {
    session = await launchHeadless({
      url: "about:blank",
      task: "perf-bench",
      width: 1920,
      height: 1080,
      software: args.software,
      gpuRequired: !args.software,
    });
    instrument(session);
    const gpu = await session.assertGpu();
    console.log(`[perf-bench] 渲染后端：${gpu.renderer}`);
    session.__diag = diag;

    for (const item of selected) {
      // --ab-bake：同一浏览器会话内交替跑「烘焙开（冷/热）/烘焙关」——
      // 本机常驻壁纸应用会让绝对值漂（见备忘「性能实测口径」），跨会话比对不可信，
      // 必须靠交替 + 同会话来抵消漂移。
      const schedule = args.abBake
        ? [
            // 顺序刻意让「关烘焙」先跑：会话第 1 次自带冷启动惩罚（profile 初始化、
            // JIT 未热），不能让某个配置永远垫在它后面 —— 那样会把启动惩罚算进它的头上。
            { label: "bake-off", noBake: true },
            { label: "bake-on-cold", noBake: false },
            { label: "bake-off-2", noBake: true },
            { label: "bake-on-warm", noBake: false },
          ]
        : Array.from({ length: args.repeat }, () => ({ label: args.label ?? "", noBake: args.noBake }));
      let rr = 0;
      for (const step of schedule) {
        const r = rr++;
        const url = rendererUrl({ origin, item, mediaBase, webBase, dpr: args.dpr, aa: args.aa, pp: args.pp, pq: args.pq, fps: args.fps, noQuality: args.noQuality, noBake: step.noBake });
        const t = Date.now();
        let rec;
        try {
          rec = await measureOne(session, {
            item,
            url,
            steady: args.steady,
            settle: args.settle,
            budget: args.budget,
            trace: args.trace,
            profile: args.profile,
            allowCache: args.cache,
            dpr: args.dpr,
          });
        } catch (e) {
          rec = { itemId: item.itemId, title: item.title, type: item.type, sizeBytes: item.sizeBytes, fail: String(e.message).slice(0, 200) };
        }
        if (rec.fail) {
          console.log(`✗ ${item.itemId} ${item.title.slice(0, 28)} — ${rec.fail}`);
        } else {
          console.log(
            `✓ ${item.itemId} ${String(rec.type).padEnd(5)} ${String(rec.ttffMs).padStart(6)}ms  cpu ${String(rec.steady.cpuPercent).padStart(6)}%  fps ${String(rec.steady.fpsAvg).padStart(5)}${rec.steady.fpsTail !== undefined ? `（尾 ${String(rec.steady.fpsTail).padStart(5)}）` : ""}` +
              (rec.bakeStats
                ? `  bake[命中 ${rec.bakeStats.hits} 补烘 ${rec.bakeStats.baked} 未命中 ${rec.bakeStats.misses} ${rec.bakeStats.backend}]`
                : "") +
              (rec.trace ? `  ${rec.trace.netCount}req/${rec.trace.netMs}ms 解码 ${rec.trace.decodeMs}ms(${rec.trace.decodeCount}) 上传 ${rec.trace.upload.ms}ms(${(rec.trace.upload.bytes / 1e6).toFixed(1)}MB) shader ${rec.trace.shader.ms}ms(${rec.trace.shader.compiles}c)` : ""),
          );
          const pr = rec.profileLoad ?? rec.profileSteady;
          if (args.profile && pr?.top?.length) {
            console.log(`   加载期热点：` + pr.top.slice(0, 6).map((t) => `${t.fn.split(" @ ")[0]} ${t.pct}%`).join(" · "));
            const ps = rec.profileSteady;
            if (ps?.top?.length) {
              console.log(`   稳态热点：` + ps.top.slice(0, 6).map((t) => `${t.fn.split(" @ ")[0]} ${t.pct}%`).join(" · "));
            }
          }
        }
        rec.fileBytes = item.sizeBytes;
        rec.title = item.title;
        rec.bake = args.noBake ? "off" : "on";
        rec.quality = args.noQuality
          ? { auto: true, dpr: args.dpr, fps: args.fps, label: args.label }
          : { aa: args.aa ?? "off", pp: args.pp ?? "high", pq: args.pq ?? "high", dpr: args.dpr, fps: args.fps, label: args.label };
        rec.round = r;
        rec.label = step.label;
        rec.at = new Date(t).toISOString();
        results.push(rec);
      }
    }
  } finally {
    if (session) {
      const stray = diag.length;
      await session.close().catch(() => {});
      if (stray) console.log(`[perf-bench] 本轮 /diag 上报 ${stray} 条`);
    }
    server.close();
  }

  const outFile =
    args.out ??
    path.join("/tmp/perf-bench", `${new Date().toISOString().replace(/[:.]/g, "-")}${args.trace ? "-trace" : ""}${args.profile ? "-prof" : ""}.json`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(
    outFile,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        args: { ...args, help: undefined },
        gpu: session?.renderer,
        host: { cpus: os.cpus().length, model: os.cpus()[0]?.model, memGB: Math.round(os.totalmem() / 2 ** 30) },
        diag,
        results,
      },
      null,
      1,
    ),
  );

  // ---- 汇总
  const ok = results.filter((r) => !r.fail);
  const num = (a) => a.filter((x) => Number.isFinite(x));
  const med = (a) => {
    const s = num(a).sort((x, y) => x - y);
    return s.length ? s[Math.floor(s.length / 2)] : NaN;
  };
  console.log("\n=== 汇总（按 ttff 降序）===");
  const rows = ok
    .slice()
    .sort((a, b) => b.ttffMs - a.ttffMs)
    .map((r) => ({
      id: r.itemId,
      type: r.type,
      MB: (r.pkgBytes ? r.pkgBytes : r.fileBytes) / 1e6,
      ttff: r.ttffMs,
      cpu: r.steady.cpuPercent,
      gpu: r.steady.byType?.gpu ?? 0,
      renderer: r.steady.byType?.renderer ?? 0,
      fps: r.steady.fpsAvg,
    }));
  console.table(rows);
  console.log(
    `ttff 中位数 ${Math.round(med(ok.map((r) => r.ttffMs)))}ms｜cpu% 中位数 ${med(ok.map((r) => r.steady.cpuPercent))}%｜fps 中位数 ${med(ok.map((r) => r.steady.fpsAvg))}｜失败 ${results.length - ok.length}/${results.length}`,
  );
  console.log(`JSON: ${outFile}`);
  return results.some((r) => r.fail) ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().then((c) => process.exit(c ?? 0)).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
