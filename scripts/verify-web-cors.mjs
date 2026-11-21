#!/usr/bin/env node
/**
 * verify-web-cors —— 严格沙箱下网页壁纸的资源必须走 CORS 模式（issue #25）。
 *
 * 背景：`webSandbox` 缺省 `strict`（`sandbox="allow-scripts"`，文档是 opaque origin）。
 * 壁纸页把**宿主自己的**贴图 / 视频帧上传成 WebGL 纹理时，非 CORS 加载的图会被判
 * 跨源污染，`texImage2D` 抛 `SecurityError` —— spine / Live2D / WebGL 类网页壁纸
 * 整块画不出来，只剩 CSS 底色。宿主 `/scene-files` 已返回
 * `Access-Control-Allow-Origin: *`，缺的是加载时挂 `crossOrigin="anonymous"`。
 *
 * 判据形态：**真跑 shim**（vm + 假 window/DOM 面，与 verify-web 同一套路），
 * 而不是文本匹配。覆盖：
 *   1. 命中面：baseURI 同源 + 站点根之下（相对/绝对路径）→ 挂 anonymous；
 *      跨站、根外、data:/blob:/about: → 不碰；作者显式 crossOrigin → 不覆盖；
 *      video 同构；`setAttribute("src")` 与 `el.src=` 两条时序都覆盖；
 *      由我们挂的标记在换到非宿主资源时撤掉（防"能显示变裂图"）。
 *   2. origin 必须取自 `document.baseURI`：引擎把 HTML 转成 blob: URL，location.href
 *      的 origin 是宿主 scheme（null），用它判 origin 会让补丁完全失效。
 *   3. `__weSiteRoot` 声明的站点形态优先；推不出站点根 → 整段放弃（宁可不修）。
 *   4. 4 个变异红测：baseURI→location、放宽站点根、去掉作者守卫、去掉站点根闸门。
 *
 * 前提（写进 issue 回复，不在本判据内）：宿主资源响应必须带
 * `Access-Control-Allow-Origin`（含 OPTIONS）—— 给没开 CORS 的图挂 crossOrigin
 * 会直接裂图，比"能看不能上传"更糟，所以命中面必须收窄。
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createChecker, ROOT } from "./lib/verify-kit.mjs";

const { check, errors } = createChecker();
const shimPath = path.join(ROOT, "renderer/src/web-shim.js");
const shimSrc = fs.readFileSync(shimPath, "utf8");

// ---------- 假 window / DOM 面（只到 shim 需要的程度） ----------
function makeEnv(opts = {}) {
  const baseURI = opts.baseURI ?? "http://127.0.0.1:9/web/tok/item/index.html";
  const locationHref = opts.locationHref ?? "blob:dsh-app://app/00000000-0000-0000-0000-000000000000";

  function El(tagName) {
    this.tagName = tagName;
    this.crossOrigin = null;
    this.attrs = {};
  }
  El.prototype.setAttribute = function (name, value) {
    this.attrs[String(name || "").toLowerCase()] = value;
  };
  El.prototype.getAttribute = function (name) {
    return this.attrs[String(name || "").toLowerCase()] ?? null;
  };
  function Img() {
    El.call(this, "IMG");
    this._src = "";
  }
  Img.prototype = Object.create(El.prototype);
  Object.defineProperty(Img.prototype, "src", {
    configurable: true,
    enumerable: true,
    get() {
      return this._src;
    },
    set(v) {
      this._src = String(v);
    },
  });
  function Media(tag) {
    El.call(this, tag || "VIDEO");
    this._src = "";
  }
  Media.prototype = Object.create(El.prototype);
  Object.defineProperty(Media.prototype, "src", {
    configurable: true,
    enumerable: true,
    get() {
      return this._src;
    },
    set(v) {
      this._src = String(v);
    },
  });

  const win = {
    URL,
    location: { href: locationHref, protocol: "http:" },
    innerWidth: 1280,
    innerHeight: 720,
    addEventListener() {},
    MutationObserver: undefined,
    document: {
      readyState: "complete",
      baseURI,
      addEventListener() {},
      documentElement: { setAttribute() {}, getAttribute: () => null, appendChild() {} },
      querySelectorAll: () => [],
      getElementsByTagName: () => [],
      createElement: (t) => new El(String(t || "div").toUpperCase()),
    },
    parent: { postMessage() {} },
    queueMicrotask: (fn) => Promise.resolve().then(fn),
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => 2,
    clearInterval() {},
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    performance: { now: () => 0 },
    Element: El,
    HTMLImageElement: Img,
    HTMLMediaElement: Media,
  };
  if (opts.siteRoot !== undefined) win.__weSiteRoot = opts.siteRoot;
  win.window = win;
  return { win, El, Img, Media };
}

/** 真跑 shim（可在内存里变异源码）。返回可创建元素的窗口。 */
function runShim(src, opts) {
  const env = makeEnv(opts);
  const ctx = vm.createContext(env.win);
  vm.runInContext(src, ctx);
  return env;
}

const read = (img) => img.crossOrigin;

// ---------- 1. 命中面 ----------
{
  const env = runShim(shimSrc, {});
  const { Img, Media } = env;

  const hostRel = new Img();
  hostRel.src = "img/sky.png"; // 相对 baseURI，落在站点根下
  check(read(hostRel) === "anonymous", "baseURI 同源 + 站点根下的相对贴图必须挂 crossOrigin=anonymous");

  const hostAbs = new Img();
  hostAbs.src = "/web/tok/item/img/sky.png";
  check(read(hostAbs) === "anonymous", "站点根下的绝对路径贴图必须挂 crossOrigin=anonymous");

  const crossSite = new Img();
  crossSite.src = "https://other.example/steal.png";
  check(read(crossSite) === null, "跨站贴图不得挂 crossOrigin（会裂图）");

  const outsideRoot = new Img();
  outsideRoot.src = "/api/private/avatar.png"; // 同源但站点根之外
  check(read(outsideRoot) === null, "同源但站点根之外的资源不得挂 crossOrigin（宁可不修）");

  const dataImg = new Img();
  dataImg.src = "data:image/png;base64,AAAA";
  check(read(dataImg) === null, "data: 资源不得挂 crossOrigin");

  const blobImg = new Img();
  blobImg.src = "blob:http://127.0.0.1:9/abc";
  check(read(blobImg) === null, "blob: 资源不得挂 crossOrigin");

  const authorSet = new Img();
  authorSet.crossOrigin = "use-credentials"; // 作者显式设置
  authorSet.src = "img/sky.png";
  check(read(authorSet) === "use-credentials", "作者显式设置的 crossOrigin 不得被覆盖");

  const attrPath = new Img();
  attrPath.setAttribute("src", "img/attr.png");
  check(read(attrPath) === "anonymous", "setAttribute('src') 路径同样必须在加载前挂上 crossOrigin");

  const video = new Media("VIDEO");
  video.src = "video/bg.mp4";
  check(read(video) === "anonymous", "视频（HTMLMediaElement）也必须挂 crossOrigin（视频帧上传纹理同样会污染）");

  // 我们挂的标记：换到非宿主资源时撤掉，避免把原本能显示的图变成裂图
  const switchToCross = new Img();
  switchToCross.src = "img/sky.png";
  check(read(switchToCross) === "anonymous", "宿主贴图首次加载应挂上");
  switchToCross.src = "https://other.example/steal.png";
  check(read(switchToCross) === null, "同一元素换到跨站资源时必须撤掉我们挂的 crossOrigin");
}

// ---------- 2. origin 取自 baseURI（blob: 文档的关键） ----------
{
  const env = runShim(shimSrc, {
    baseURI: "http://127.0.0.1:9/web/tok/item/index.html",
    locationHref: "blob:dsh-app://app/00000000-0000-0000-0000-000000000000",
  });
  const img = new env.Img();
  img.src = "img/sky.png";
  check(
    read(img) === "anonymous",
    "location.href 是 blob:（origin=null）时，必须以 document.baseURI 判 origin 并照常挂 crossOrigin",
  );
}

// ---------- 3. __weSiteRoot 声明形态 + 推不出根就放弃 ----------
{
  const env = runShim(shimSrc, {
    baseURI: "http://127.0.0.1:9/custom/prefix/item/index.html",
    siteRoot: "/custom/prefix/item/",
  });
  const inside = new env.Img();
  inside.src = "assets/bg.png";
  check(read(inside) === "anonymous", "宿主用 __weSiteRoot 声明站点根后，根内资源必须挂 crossOrigin");
  const outside = new env.Img();
  outside.src = "/custom/other/x.png";
  check(read(outside) === null, "__weSiteRoot 之外的同源资源不得挂 crossOrigin");
}
{
  const env = runShim(shimSrc, {
    baseURI: "http://127.0.0.1:9/somewhere/else/index.html",
    // 无 __weSiteRoot，也不是 /web/<a>/<b>/ 形态
  });
  const img = new env.Img();
  img.src = "/somewhere/else/img/sky.png";
  check(read(img) === null, "推不出站点根时必须整段放弃（同源直挂会弄裂没开 CORS 的图）");
}

// ---------- 4. 变异红测（内存里改源码，源文件不动） ----------
function mutationTurnsRed(label, from, to, probe) {
  if (!shimSrc.includes(from)) {
    check(false, `变异红测「${label}」找不到锚点（shim 实现变了，本判据要同步改）`);
    return;
  }
  let env;
  try {
    env = runShim(shimSrc.replace(from, to), {});
  } catch (e) {
    check(false, `变异「${label}」后 shim 无法运行：${e && e.message}`);
    return;
  }
  const red = !probe(env);
  check(red, `变异红测「${label}」必须让对应判据变红（现状仍绿）`);
}

mutationTurnsRed(
  "origin 改回 location.href",
  '(w.document && w.document.baseURI) || ""',
  '(w.location && w.location.href) || ""',
  (env) => {
    const img = new env.Img();
    img.src = "img/sky.png";
    return read(img) === "anonymous";
  },
);

mutationTurnsRed(
  "放宽站点根",
  "return abs.pathname.indexOf(siteRoot) === 0;",
  "return true;",
  (env) => {
    // 探针必须是「同源但在站点根之外」：跨站由 origin 检查独立挡住，
    // 放宽根检查只会让根外同源资源被误挂
    const img = new env.Img();
    img.src = "/api/private/avatar.png";
    return read(img) === null;
  },
);

mutationTurnsRed(
  "去掉作者 crossOrigin 守卫",
  "if (el.crossOrigin) return; // 作者显式设过：不覆盖",
  "if (false) return;",
  (env) => {
    const img = new env.Img();
    img.crossOrigin = "use-credentials";
    img.src = "img/sky.png";
    return read(img) === "use-credentials";
  },
);

// 站点根闸门的变异是「正向」的：把 null 根回落成 "/" 后，本该放弃的宿主反而会
// 给同源任意路径挂 crossOrigin —— 用它证明 §3 的「推不出就放弃」确实由该闸门决定。
{
  const anchor = "var siteRoot = siteRootPath();\n    if (!siteRoot) return; // 推不出站点根：不修复，也绝不弄裂";
  if (!shimSrc.includes(anchor)) {
    check(false, "变异红测「去掉站点根闸门」找不到锚点（shim 实现变了，本判据要同步改）");
  } else {
    const env = runShim(
      shimSrc.replace(anchor, 'var siteRoot = siteRootPath();\n    if (!siteRoot) siteRoot = "/";'),
      { baseURI: "http://127.0.0.1:9/somewhere/else/index.html" },
    );
    const img = new env.Img();
    img.src = "/somewhere/else/img/sky.png";
    check(
      read(img) === "anonymous",
      "变异红测「去掉站点根闸门」：把 null 根回落成 / 后必须能挂上 crossOrigin（证明放弃行为由该闸门唯一决定）",
    );
  }
}

if (errors.length) {
  console.log(`verify-web-cors: ${errors.length} 项失败 ✗`);
  errors.forEach((e) => console.log("  ✗ " + e));
  process.exit(1);
}
console.log("verify-web-cors: 全部通过 ✓（命中面 11 项 + baseURI 1 项 + 站点根 3 项 + 变异红测 4 项）");
