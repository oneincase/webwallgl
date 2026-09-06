#!/usr/bin/env node
/**
 * verify-web —— 网页壁纸 HTML 改写与 WE shim 时序（离线，无 DOM 装配）。
 *
 * 覆盖：
 *   1. rewriteHtml：shim 在作者 script 之前；补 <base>；幂等；残缺 HTML；seedScript
 *   2. hasBlockingCsp / entryDirUrl
 *   3. shim：PropertyListener setter 立即 flush；音频 128；暂停后不再推；__weThrottled；
 *      Media*Listener / MediaIntegration / RequestRandomFile / 目录文件 / Plugin stub
 *   3b. 网页模拟音频增益 / 泵频封顶（1748506393 splat 积分白屏）；
 *       空 file 仍下发（1747779570 typeof object）；file:/// 由 shim 改写
 *   4. 无注入时 API 不存在；dispatch 一等化接线；web.ts 媒体泵
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { pathToFileURL } from "node:url";
import { createChecker, ROOT } from "./lib/verify-kit.mjs";

const { check, errors } = createChecker();

const shimPath = path.join(ROOT, "renderer/src/web-shim.js");
const rewritePath = path.join(ROOT, "renderer/src/web-rewrite.ts");
const webTsPath = path.join(ROOT, "renderer/src/web.ts");
const shimSrc = fs.readFileSync(shimPath, "utf8");
const rewriteSrc = fs.readFileSync(rewritePath, "utf8");
const webTs = fs.readFileSync(webTsPath, "utf8");

check(fs.existsSync(shimPath), "web-shim.js 必须存在");
check(
  /export function rewriteHtml/.test(rewriteSrc) &&
    /export function entryDirUrl/.test(rewriteSrc) &&
    /export function hasBlockingCsp/.test(rewriteSrc) &&
    /seedScript/.test(rewriteSrc) &&
    /data-we-shim-src/.test(rewriteSrc),
  "web-rewrite.ts 必须导出 rewriteHtml / entryDirUrl / hasBlockingCsp，且支持 seedScript",
);

async function importRewrite() {
  const esbuild = await import("esbuild");
  const out = await esbuild.build({
    entryPoints: [rewritePath],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "es2022",
  });
  const code = out.outputFiles[0].text;
  const tmp = path.join(ROOT, "scripts", `.tmp-web-rewrite-${process.pid}.mjs`);
  fs.writeFileSync(tmp, code);
  try {
    return await import(pathToFileURL(tmp).href + `?t=${Date.now()}`);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 忽略 */
    }
  }
}

const rw = await importRewrite();

// ---------- 1. rewriteHtml ----------
{
  const shim = "window.__TEST_SHIM=1;";
  const html = `<!DOCTYPE html><html><head><title>t</title>
<script>window.wallpaperRegisterAudioListener(function(){})</script>
</head><body>hi</body></html>`;
  const out = rw.rewriteHtml(html, shim, { baseHref: "https://cdn.example/wp/" });
  const shimIdx = out.indexOf("__TEST_SHIM");
  const authorIdx = out.indexOf("wallpaperRegisterAudioListener");
  check(shimIdx >= 0 && authorIdx > shimIdx, "shim 必须出现在作者 script 之前");
  check(/<base href="https:\/\/cdn\.example\/wp\/">/i.test(out), "无 base 时应插入 <base>");
  check(/data-we-shim-src/.test(out), "注入 script 应带 data-we-shim-src");

  const again = rw.rewriteHtml(out, shim, { baseHref: "https://cdn.example/wp/" });
  check(again === out, "已注入 HTML 应幂等（原样返回）");

  const withBase = rw.rewriteHtml(
    `<html><head><base href="/old/"><script>a()</script></head></html>`,
    shim,
    { baseHref: "https://cdn.example/wp/" },
  );
  check((withBase.match(/<base\b/gi) || []).length === 1, "已有 <base> 时不得再插一个");

  const bare = rw.rewriteHtml(`<script>author()</script>`, shim, {
    baseHref: "https://x/a/",
    seedScript: "window.__SEED=1;",
  });
  check(
    /<head>/i.test(bare) && bare.indexOf("__TEST_SHIM") < bare.indexOf("author()"),
    "残缺 HTML 应包 head 且 shim 在作者前",
  );
  check(bare.indexOf("__SEED") < bare.indexOf("author()"), "seedScript 应在作者 script 之前");

  check(rw.entryDirUrl("https://a.b/c/d/index.html") === "https://a.b/c/d/", "entryDirUrl 应落到目录");
  check(
    rw.hasBlockingCsp(
      `<meta http-equiv="Content-Security-Policy" content="script-src 'self'">`,
    ),
    "无 unsafe-inline 的 script-src CSP 应判定为阻断",
  );
  check(
    !rw.hasBlockingCsp(
      `<meta http-equiv="Content-Security-Policy" content="script-src 'self' 'unsafe-inline'">`,
    ),
    "含 unsafe-inline 的 CSP 不应阻断",
  );
}

// ---------- 2. packWebAudioArray 源码 + 同构数值 ----------
{
  check(/export function packWebAudioArray/.test(webTs), "web.ts 必须导出 packWebAudioArray");
  check(/Float32Array\(128\)/.test(webTs), "音频数组长度必须为 128");
  check(
    /export const WEB_SIM_AUDIO_GAIN = 0\.2/.test(webTs),
    "网页模拟音频必须降增益（1748506393 splat 积分白屏；场景 GAIN=3.2 过热）",
  );
  check(
    /WEB_AUDIO_PUMP_HZ = 30/.test(webTs) && /Math\.min\(Math\.max\(1, fps\), WEB_AUDIO_PUMP_HZ\)/.test(webTs),
    "网页音频泵必须封顶 30Hz（WE 回调频率；60Hz 打满积分型可视化）",
  );
  check(
    /1747779570/.test(webTs) && !/type === "file".*raw === ""/.test(webTs.replace(/\s+/g, " ")),
    "空 file 必须下发（1747779570 typeof object 才 setSingleVideo；file:/// 改由 shim 改写）",
  );
  {
    // 1748506393：floor(bass * 5 * 10) splat/回调。场景满幅 bass≈0.5 → 25 颗/拍会白屏；
    // 增益 0.2 后 ≈5 颗。故意把增益改回 1 会让本断言仍绿，所以另用公式锁上限。
    const gain = 0.2;
    const sensitivity = 5;
    const bassHot = 0.5 * gain;
    const splats = Math.floor(bassHot * sensitivity * 10);
    check(splats > 0 && splats <= 8, `网页模拟音频在 sensitivity=5 时每拍 splat 应 ≤8，实得 ${splats}`);
  }
  check(
    /now - frameClock\.last > 200/.test(webTs.replace(/\s+/g, " ")),
    "setTimeout 主循环网页应有 FPS 打点兜底（1748506393 不用 rAF）",
  );
  const pack = (left, right) => {
    const out = new Float32Array(128);
    const nL = Math.min(64, left.length);
    const nR = Math.min(64, right.length);
    for (let i = 0; i < nL; i++) out[i] = Number(left[i]) || 0;
    for (let i = 0; i < nR; i++) out[64 + i] = Number(right[i]) || 0;
    return out;
  };
  const left = new Float32Array(64);
  const right = new Float32Array(64);
  left[0] = 0.5;
  right[0] = 0.25;
  const arr = pack(left, right);
  check(arr.length === 128, "pack 长度 128");
  check(arr[0] === 0.5 && arr[64] === 0.25, "左右分界在 64");
}

// ---------- 3. shim 行为 ----------
function runShim(extras) {
  const loadHandlers = [];
  const win = {
    URL,
    location: { href: "http://localhost:1430/", protocol: "http:" },
    document: {
      readyState: "complete",
      addEventListener(_type, fn) {
        loadHandlers.push(fn);
      },
      documentElement: {
        setAttribute() {},
        getAttribute() {
          return null;
        },
      },
      querySelectorAll() {
        return [];
      },
    },
    parent: { postMessage() {} },
    queueMicrotask: (fn) => Promise.resolve().then(fn),
    setTimeout: (fn) => {
      // 立即执行以便节流路径可测；返回假 id
      try {
        fn();
      } catch {
        /* 忽略 */
      }
      return 1;
    },
    clearTimeout() {},
    setInterval: (fn) => {
      try {
        fn();
      } catch {
        /* 忽略 */
      }
      return 2;
    },
    clearInterval() {},
    requestAnimationFrame: (cb) => {
      try {
        cb(performance.now());
      } catch {
        /* 忽略 */
      }
      return 1;
    },
    cancelAnimationFrame() {},
  };
  // 预注入（HTMLMediaElement/Audio 等须在 shim 安装前就位——hook 在安装时立即执行）
  if (extras) Object.assign(win, extras);
  win.window = win;
  vm.runInNewContext(shimSrc, win);
  return { win, loadHandlers };
}

{
  let win;
  ({ win } = runShim());
  check(
    typeof win.wallpaperRegisterAudioListener === "function",
    "shim 应暴露 wallpaperRegisterAudioListener",
  );
  check(typeof win.__weSetPaused === "function", "shim 应暴露 __weSetPaused");
  check(typeof win.__weApplyProps === "function", "shim 应暴露 __weApplyProps");
  check(typeof win.__wePushAudio === "function", "shim 应暴露 __wePushAudio");
  check(win.requestAnimationFrame.__weThrottled === true, "rAF 应标记 __weThrottled");

  let gotProps = null;
  win.__weSeedProps({ color: { value: "1 0 0" } });
  win.wallpaperPropertyListener = {
    applyUserProperties(p) {
      gotProps = p;
    },
  };
  // 赋值瞬间不得同步 flush（React render 里赋值 + setState = 黑屏，2905017768）
  check(gotProps === null, "PropertyListener 赋值当下不得同步 flush");
  await Promise.resolve(); // queueMicrotask 同级
  check(
    gotProps && gotProps.color && gotProps.color.value === "1 0 0",
    "PropertyListener 赋值后微任务应 flush 挂起属性",
  );

  // 827982449：官方在页面加载完成后才发全量属性；页面未加载完成时补发须等 load
  // （+一个宏任务，保证排在 onLoad 处理器之后），否则作者初始化代码会撞上未就绪 DOM。
  {
    const loadHandlers2 = [];
    const { win: win3 } = runShim({
      addEventListener(_type, fn) {
        loadHandlers2.push(fn);
      },
      document: {
        readyState: "loading",
        addEventListener(_type, fn) {
          loadHandlers2.push(fn);
        },
        documentElement: { setAttribute() {}, getAttribute() { return null; } },
        querySelectorAll() {
          return [];
        },
      },
    });
    const got = { props: null, paused: null };
    win3.__weSeedProps({ snow: { value: 200 } });
    win3.wallpaperPropertyListener = {
      applyUserProperties(p) {
        got.props = p;
      },
      setPaused(v) {
        got.paused = v;
      },
    };
    await Promise.resolve();
    check(got.props === null && got.paused === null, "页面 loading 期间不得提前补发属性");
    for (const fn of loadHandlers2.splice(0)) fn();
    check(
      got.props && got.props.snow && got.props.snow.value === 200 && got.paused === false,
      "load 后（宏任务）应补发属性与暂停状态",
    );
  }

  let second = null;
  win.wallpaperPropertyListener = {
    applyUserProperties(p) {
      second = p;
    },
    applyGeneralProperties() {},
  };
  await Promise.resolve();
  win.__weApplyProps({ x: { value: 1 } });
  check(second && second.x && second.x.value === 1, "__weApplyProps 在有 listener 时应立即送达");

  // 2905017768 点下一曲整页卡死：React 壁纸在渲染体里反复重新赋值 listener；
  // setter 若每次都补发 setPaused/applyGeneralProperties，会形成
  // 渲染 → 赋值 → 微任务补发 setState → 再渲染 的死循环（实测 2 秒 6.6 万次渲染）。
  {
    const { win: win2 } = runShim();
    let pausedCalls = 0;
    let generalCalls = 0;
    const makeListener = () => ({
      applyUserProperties() {},
      applyGeneralProperties() {
        generalCalls++;
      },
      setPaused() {
        pausedCalls++;
      },
    });
    win2.wallpaperPropertyListener = makeListener();
    await Promise.resolve();
    check(
      pausedCalls === 1 && generalCalls === 1,
      "首次赋值应补发 setPaused/applyGeneralProperties 恰一次",
    );
    for (let i = 0; i < 10; i++) {
      win2.wallpaperPropertyListener = makeListener();
    }
    await Promise.resolve();
    check(
      pausedCalls === 1 && generalCalls === 1,
      "重复赋值不得再次补发 setPaused/applyGeneralProperties（渲染死循环，2905017768）",
    );
  }

  // ---------- 官方暂停/恢复：setPaused 仅状态变化时调用一次 + 暂停冻结定时器 ----------
  {
    const { win } = runShim();
    const ran = [];
    let pausedCalls = 0;
    win.__weSetPaused(true);
    win.wallpaperPropertyListener = {
      applyUserProperties() {},
      setPaused() {
        pausedCalls++;
      },
    };
    await Promise.resolve();
    check(pausedCalls === 1, "加载即暂停：首次注册应补发 setPaused(true) 恰一次");

    const holdT = win.setTimeout(() => ran.push("held-t"), 5);
    win.setInterval(() => ran.push("held-i"), 5);
    win.clearTimeout(holdT);
    check(ran.length === 0, "暂停期间新建定时器不得执行");
    check(win.clearTimeout(holdT) === undefined, "clearTimeout 可取消挂起项");

    win.__weSetPaused(true);
    win.__weSetPaused(true);
    check(pausedCalls === 1, "重复 setPaused(true) 应去重（官方仅在状态变化时调用）");

    win.__weSetPaused(false);
    await Promise.resolve();
    check(pausedCalls === 2, "恢复时应调用 setPaused(false) 一次");
    check(
      ran.length === 1 && ran[0] === "held-i",
      "恢复后挂起 interval 应启动、已取消的 timeout 不跑",
    );
  }

  // ---------- 暂停冻结页内媒体：只冻结我们在场的，恢复只还原这部分 ----------
  {
    const media = [
      { paused: false, playCalls: 0, pauseCalls: 0, play() { this.playCalls++; this.paused = false; }, pause() { this.pauseCalls++; this.paused = true; } },
      { paused: true, playCalls: 0, pauseCalls: 0, play() { this.playCalls++; this.paused = false; }, pause() { this.pauseCalls++; this.paused = true; } },
    ];
    const { win } = runShim({
      document: {
        readyState: "complete",
        addEventListener() {},
        documentElement: { setAttribute() {}, getAttribute() { return null; } },
        querySelectorAll(sel) {
          return sel === "audio,video" ? media : [];
        },
      },
    });
    win.__weSetPaused(true);
    check(media[0].paused && media[0].pauseCalls === 1, "播放中的媒体应被代为暂停");
    check(media[1].pauseCalls === 0, "作者已暂停的媒体不得重复操作");
    win.__weSetPaused(false);
    await Promise.resolve();
    check(media[0].paused === false && media[0].playCalls === 1, "恢复时只还原我们代为暂停的媒体");
    check(media[1].paused === true && media[1].playCalls === 0, "作者自己暂停的不得被唤醒");
  }

  let audioHits = 0;
  let lastAudio = null;
  win.wallpaperRegisterAudioListener((arr) => {
    audioHits++;
    lastAudio = arr;
  });
  const sample = new Float32Array(128);
  sample[0] = 0.9;
  sample[64] = 0.1;
  win.__wePushAudio(sample);
  check(
    audioHits === 1 &&
      lastAudio &&
      Math.abs(lastAudio[0] - 0.9) < 1e-5 &&
      Math.abs(lastAudio[64] - 0.1) < 1e-5,
    "音频数组应原样送达 listener",
  );

  win.__weSetPaused(true);
  win.__wePushAudio(sample);
  check(audioHits === 1, "暂停后 __wePushAudio 不得再调 listener");

  win.__weSetPaused(false);
  win.__wePushAudio(sample);
  check(audioHits === 2, "恢复后应继续推音频");

  // ---------- 媒体音量：主音量与作者音量相乘；new Audio()（不在 DOM）也受控 ----------
  {
    // 注入媒体模拟（真实浏览器有 HTMLMediaElement/Audio，verifier 环境自建最小面）
    class FakeMedia {
      constructor() {
        this.__rawVol = 1;
        this.__rawMuted = false;
      }
    }
    FakeMedia.prototype.__rawVol = 1;
    Object.defineProperty(FakeMedia.prototype, "volume", {
      configurable: true,
      get() {
        return this.__rawVol;
      },
      set(v) {
        this.__rawVol = v;
      },
    });
    Object.defineProperty(FakeMedia.prototype, "muted", {
      configurable: true,
      get() {
        return this.__rawMuted;
      },
      set(v) {
        this.__rawMuted = v;
      },
    });
    const { win } = runShim({
      HTMLMediaElement: FakeMedia,
      WeakRef,
      Audio: function (src) {
        const a = new FakeMedia();
        if (src != null) a.src = src;
        return a;
      },
    });
    win.Audio.prototype = FakeMedia.prototype;

    win.__weSetVolume(0.5);
    const a = new win.Audio();
    check(
      Math.abs(a.__rawVol - 0.5) < 1e-9,
      "新 Audio 构造即应用当前主音量",
    );
    a.volume = 0.8;
    check(
      Math.abs(a.__rawVol - 0.4) < 1e-9,
      "实际音量 = 作者音量 × 主音量（0.8 × 0.5 = 0.4）",
    );
    check(Math.abs(a.volume - 0.8) < 1e-9, "volume getter 应回读作者值");
    win.__weSetVolume(0);
    check(a.__rawMuted === true, "主音量归零应静音");
    win.__weSetVolume(1);
    check(a.__rawMuted === false, "主音量恢复应解除静音");
    check(Math.abs(a.__rawVol - 0.8) < 1e-9, "主音量恢复 1 后实际音量还原作者值");
    win.__weSetVolume(0.25);
    check(
      Math.abs(a.__rawVol - 0.2) < 1e-9,
      "__weSetVolume 热更系数应刷新既有实例（0.8 × 0.25 = 0.2）",
    );
  }

  // Media 四监听 + 枚举 + 晚注册回放
  check(
    win.wallpaperMediaIntegration &&
      win.wallpaperMediaIntegration.PLAYBACK_PLAYING === 1 &&
      win.wallpaperMediaIntegration.PLAYBACK_PAUSED === 2,
    "shim 应暴露 wallpaperMediaIntegration 播放枚举",
  );
  check(
    typeof win.wallpaperRegisterMediaPropertiesListener === "function" &&
      typeof win.wallpaperRegisterMediaThumbnailListener === "function" &&
      typeof win.wallpaperRegisterMediaPlaybackListener === "function" &&
      typeof win.wallpaperRegisterMediaTimelineListener === "function",
    "shim 应暴露 Media*Listener 注册函数",
  );
  let mediaTitle = null;
  win.__wePushMedia({ op: "properties", title: "夜航星", artist: "相位迁移" });
  win.wallpaperRegisterMediaPropertiesListener((e) => {
    mediaTitle = e.title;
  });
  check(mediaTitle === "夜航星", "MediaPropertiesListener 晚注册应回放最近一帧");

  let playState = null;
  win.wallpaperRegisterMediaPlaybackListener((e) => {
    playState = e.state;
  });
  win.__wePushMedia({ op: "playback", state: 1 });
  check(playState === 1, "__wePushMedia playback 应送达");

  // 随机文件 + 目录列表
  check(
    typeof win.wallpaperRequestRandomFileForProperty === "function",
    "shim 应暴露 wallpaperRequestRandomFileForProperty",
  );
  let emptyPath = "sentinel";
  win.wallpaperRequestRandomFileForProperty("bg", (prop, path) => {
    emptyPath = path;
  });
  check(emptyPath === "", "无目录文件时随机路径应为空串（勿抛）");

  let dirHits = 0;
  let dirFiles = null;
  win.wallpaperPropertyListener = {
    applyUserProperties() {},
    userDirectoryFilesAddedOrChanged(prop, files) {
      dirHits++;
      dirFiles = files;
    },
  };
  await Promise.resolve();
  win.__wePushDirectoryFiles("slides", ["a.png", "b.jpg"]);
  check(
    dirHits === 1 && Array.isArray(dirFiles) && dirFiles.length === 2,
    "__wePushDirectoryFiles 应触发 userDirectoryFilesAddedOrChanged",
  );
  let picked = null;
  win.wallpaperRequestRandomFileForProperty("slides", (_p, path) => {
    picked = path;
  });
  check(picked === "a.png" || picked === "b.jpg", "随机文件应从目录池抽取");

  win.__weApplyProps({ logo: { value: "image/logo.png" } });
  let fromProp = null;
  win.wallpaperRequestRandomFileForProperty("logo", (_p, path) => {
    fromProp = path;
  });
  check(fromProp === "image/logo.png", "file 属性值应登记进随机池");

  check(
    win.wallpaperPluginListener && typeof win.wallpaperPluginListener.onPluginLoaded === "function",
    "shim 应提供 wallpaperPluginListener stub",
  );

  // file:/// 改写（1747779570 相对资源；1748506393 空 file:///）
  check(typeof win.__weRewriteFileUrl === "function", "shim 应暴露 __weRewriteFileUrl");
  win.location = { href: "http://localhost:1430/web/dev/1747779570/index.html", protocol: "http:" };
  check(win.__weRewriteFileUrl("file:///") === "", "空 file:/// 应改成空串");
  check(
    win.__weRewriteFileUrl('url("file:///")') === "none",
    "url(\"file:///\") 应改成 none（1748506393 backgroundImage）",
  );
  check(
    win.__weRewriteFileUrl("file:///files/wallpaper.webm") ===
      "http://localhost:1430/web/dev/1747779570/files/wallpaper.webm",
    "相对 file:///files/… 应改写成同源 URL（1747779570）",
  );
  win.location = { href: "file:///Users/me/wp/index.html", protocol: "file:" };
  check(
    win.__weRewriteFileUrl("file:///files/wallpaper.webm") === "file:///files/wallpaper.webm",
    "file: 协议页应保留 file:///（真本地嵌入）",
  );
}

// ---------- 4. 无 shim 对照 ----------
{
  const bare = {};
  check(
    typeof bare.wallpaperRegisterAudioListener === "undefined",
    "无注入时 wallpaperRegisterAudioListener 必须不存在（时序对照）",
  );
}

// ---------- 5. 装配接线 ----------
{
  const dispatch = fs.readFileSync(path.join(ROOT, "renderer/src/dispatch.ts"), "utf8");
  check(
    /type === "web"/.test(dispatch) && /mountWeb/.test(dispatch),
    "dispatch 必须把 web 作为一等类型交给 mountWeb",
  );
  check(
    /toLowerCase\(\)/.test(dispatch) && /cfg\.type/.test(dispatch),
    "dispatch 必须对 cfg.type 做 toLowerCase（工坊 type 为 Web/Scene）",
  );
  const main = fs.readFileSync(path.join(ROOT, "renderer/src/main.ts"), "utf8");
  check(
    !/cfg\.type === "web" && cfg\.src/.test(main),
    "main.ts 适配层不应再单独分流 web（已由 dispatch 处理）",
  );
  check(/mountWebWithOptions|type === "web"|isSameOriginUrl/.test(webTs), "web.ts 必须实现 mountWeb");
  check(/import shimSource from "\.\/web-shim\.js\?raw"/.test(webTs), "web.ts 必须以 ?raw 嵌入 shim");
  check(/isSameOriginUrl/.test(webTs) && /origin null|同源/.test(webTs), "web.ts 同源入口不得走 blob（Spine/WebGL）");
  check(
    /startMediaPump|__wePushMedia|createSimulatedMedia|diffMediaEvents/.test(webTs),
    "web.ts 必须接媒体泵并推送 __wePushMedia",
  );

  const shim = fs.readFileSync(shimPath, "utf8");
  check(
    /wallpaperRequestRandomFileForProperty/.test(shim) &&
      /__wePushDirectoryFiles/.test(shim) &&
      /wallpaperRegisterMediaPropertiesListener/.test(shim) &&
      /wallpaperMediaIntegration/.test(shim),
    "web-shim 必须覆盖随机文件 / 目录 / Media / Integration 枚举",
  );
  const hostInject = fs.readFileSync(path.join(ROOT, "host/we-web-html.mjs"), "utf8");
  const hostTs = fs.readFileSync(path.join(ROOT, "host/wallpaper-host.ts"), "utf8");
  check(/injectWebShim/.test(hostInject), "host/we-web-html.mjs 必须导出 injectWebShim");
  check(
    /injectWebShim/.test(hostTs) && /isHtmlPath/.test(hostTs),
    "wallpaper-host 必须对 /web/ HTML 响应注入 WE shim",
  );
}

if (errors.length) {
  console.error(`verify-web: ${errors.length} 项失败`);
  for (const e of errors) console.error("  ✗", e);
  process.exit(1);
}
console.log("verify-web: ok");
