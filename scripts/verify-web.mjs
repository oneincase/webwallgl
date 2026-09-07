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

/**
 * 从 web.ts 里抽出一个**独立**的导出函数并编译执行。
 *
 * 不整体 bundle web.ts：它会拉进 vendor 引擎与 `?raw` 导入（esbuild 解析不了）。
 * 抽源码片段的好处是断言跑的是**真实现**而不是 verifier 里复算的一份副本 ——
 * 复算副本的坑刚踩过：实现改坏（换算漏减偏移）而 verifier 照绿。
 */
async function importIsolatedFn(srcText, fnName) {
  const at = srcText.indexOf(`export function ${fnName}`);
  if (at < 0) return null;
  // 找函数结尾用「行首的 }」而不是括号配对：参数与返回值的类型字面量
  // （`{ left: number; … }`、`{ x: number } | null`）里也有花括号，配对会切错位置。
  // 本仓库顶层函数一律零缩进，行首 } 就是函数结尾。
  const endAt = srcText.indexOf("\n}", at);
  if (endAt < 0) return null;
  const esbuild = await import("esbuild");
  const out = await esbuild.transform(srcText.slice(at, endAt + 2), {
    loader: "ts",
    format: "esm",
    target: "es2022",
  });
  const tmp = path.join(ROOT, "scripts", `.tmp-web-fn-${fnName}-${process.pid}.mjs`);
  fs.writeFileSync(tmp, out.code);
  try {
    const mod = await import(pathToFileURL(tmp).href + `?t=${Date.now()}`);
    return mod[fnName] ?? null;
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 忽略 */
    }
  }
}

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
    /export const WEB_SIM_AUDIO_GAIN = /.test(webTs) && /export const WEB_SIM_AUDIO_GAMMA = /.test(webTs),
    "网页模拟音频必须有增益与对比扩展指数两个常量",
  );
  check(
    /preL64/.test(webTs) && /preR64/.test(webTs),
    "网页驱动必须读未钳位频谱 preL64/preR64（钳位后波峰因数已被压平，1520828134 猫爪阈值永不成立）",
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
    // 用真实模拟音频语料复算两类作者判定（不再用手写常量——手写常量在增益改动后仍会绿）。
    const { createSimulatedAudio } = await import(
      new URL("../renderer/vendor/we-scene/render/audio.js", import.meta.url)
    );

    const sim = createSimulatedAudio();
    const N = 1920; // 64s @30Hz，覆盖完整 32s 段结构（含静音段）两轮
    const dt = 1 / 30;
    const frames = [];
    let preOk = true;
    for (let k = 0; k < N; k++) {
      const s = sim.update(k * dt);
      if (!(s.preL64 instanceof Float32Array) || !(s.preR64 instanceof Float32Array)) preOk = false;
      frames.push({
        preL: Float32Array.from(s.preL64 ?? []),
        preR: Float32Array.from(s.preR64 ?? []),
        silent: s.silent,
      });
    }
    check(preOk, "模拟音频快照必须含未钳位 preL64/preR64（网页 gamma 扩展的输入）");

    // web.ts 是 TS，verifier 里无法直接 import；按源码取两个常量自行复算同一公式
    const gain = Number(/WEB_SIM_AUDIO_GAIN = ([\d.]+)/.exec(webTs)?.[1]);
    const gamma = Number(/WEB_SIM_AUDIO_GAMMA = ([\d.]+)/.exec(webTs)?.[1]);
    check(
      Number.isFinite(gain) && Number.isFinite(gamma) && gamma > 1,
      `增益/gamma 必须可解析且 gamma>1（对比扩展），实得 gain=${gain} gamma=${gamma}`,
    );
    const shape = (v) => (v > 0 ? Math.min(1, Math.pow(v, gamma) * gain) : 0);

    // (a) 1520828134 Bongo Cat：任一 band 0..62（双声道）> 0.5 才换成敲击贴图
    let tapFrames = 0;
    let onsets = 0;
    let prevOn = false;
    let silentTaps = 0;
    let silentFrames = 0;
    for (const f of frames) {
      let peak = 0;
      for (let i = 0; i < 63; i++) {
        const a = shape(f.preL[i]);
        const b = shape(f.preR[i]);
        if (a > peak) peak = a;
        if (b > peak) peak = b;
      }
      const on = peak > 0.5;
      if (on) tapFrames++;
      if (on && !prevOn) onsets++;
      prevOn = on;
      if (f.silent) {
        silentFrames++;
        if (on) silentTaps++;
      }
    }
    const tapsPerSec = onsets / (N * dt);
    check(
      tapsPerSec >= 0.8,
      `1520828134 猫爪每秒敲击应 ≥0.8 次（曲目 112BPM≈1.87 拍/秒），实得 ${tapsPerSec.toFixed(2)}`,
    );
    check(
      silentFrames > 0 && silentTaps === 0,
      `静音段不得敲击（实得 ${silentTaps}/${silentFrames} 帧）`,
    );

    // (b) 1748506393 流体：bass=mean(band0..8 双声道)，splats=floor(bass*sens*10)，默认 sens=5
    const SENS = 5;
    let splatSum = 0;
    const per = [];
    for (const f of frames) {
      let s = 0;
      for (let i = 0; i <= 8; i++) s += shape(f.preL[i]) + shape(f.preR[i]);
      const sp = Math.floor((s / 16) * SENS * 10);
      per.push(sp);
      splatSum += sp;
    }
    const splatsPerSec = (splatSum / N) * 30;
    // 旧的「钳位 × 0.2」实测约 179 颗/秒且不白屏，以此为上界基准（留 15% 余量）
    check(
      splatsPerSec <= 206,
      `1748506393 流体 splat 速率应 ≤206 颗/秒（旧上线值约 179，超过会重回积分白屏），实得 ${splatsPerSec.toFixed(0)}`,
    );
    // 峰值不能长时间贴满：1s 窗口累计有界
    let worst1s = 0;
    let cur = 0;
    for (let i = 0; i < per.length; i++) {
      cur += per[i];
      if (i >= 30) cur -= per[i - 30];
      if (i >= 29 && cur > worst1s) worst1s = cur;
    }
    check(
      worst1s <= 700,
      `流体最坏 1s 窗口 splat 累计应 ≤700（满幅 60Hz 约 3200 会白屏），实得 ${worst1s}`,
    );
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

  // ---------- 暂停期间挂起的 rAF 必须在恢复时补跑（1278092907 暂停后无法恢复）----------
  //
  // 作者的主循环普遍是 rAF 自递归。1278092907 Monstercat 的 `draw()` 在**函数体开头**就
  // `requestAnimationFrame(draw)` 再画：暂停期间那次请求被节流层登记成 hold，若恢复时
  // 没人补跑，整条链就没有下一帧 —— 画面永久定格、无任何报错（实测正常 59 帧/500ms →
  // 暂停 0 → 恢复后仍 0）。
  {
    const rafCalls = [];
    const { win } = runShim({
      requestAnimationFrame: (cb) => {
        rafCalls.push(cb);
        return 100 + rafCalls.length;
      },
      cancelAnimationFrame() {},
    });
    let ticks = 0;
    // 模拟作者的自递归主循环
    const draw = () => {
      win.requestAnimationFrame(draw);
      ticks++;
    };
    const pump = () => {
      const list = rafCalls.splice(0);
      for (const cb of list) cb(performance.now());
    };
    draw(); // 首次登记（未暂停：应进真 rAF）
    check(rafCalls.length === 1, "未暂停时 rAF 应透传到底层");
    pump();
    check(ticks === 2, `泵一次应推进一帧，实得 ticks=${ticks}`);
    // 把已排入底层的那次请求跑掉，让队列干净 —— 暂停前已排队的帧照常跑完是**正确**行为
    // （浏览器同样如此），不清空会把它误当成「暂停后仍在出帧」。
    pump();
    check(rafCalls.length === 1, "自递归应持续登记下一帧");

    win.__weSetPaused(true);
    // 暂停后作者那次 rAF 请求（在上一帧回调里发出的）已在 rafCalls 里；把它跑掉，
    // 它会再次请求下一帧，而这一次应被节流层挂起、不再透传。
    pump();
    const beforePauseTicks = ticks;
    check(rafCalls.length === 0, "暂停期间的 rAF 请求不得透传到底层（应挂起）");
    pump(); // 队列已空，不该再出帧
    check(
      ticks === beforePauseTicks,
      `暂停期间不得继续出帧，实得 ticks 从 ${beforePauseTicks} 变为 ${ticks}`,
    );

    win.__weSetPaused(false);
    check(
      rafCalls.length === 1,
      `恢复时必须补跑挂起的 rAF（否则自递归主循环永久断链，1278092907），实得 ${rafCalls.length} 个`,
    );
    pump();
    check(ticks > beforePauseTicks, `恢复后主循环必须重新出帧，实得 ticks=${ticks}`);
    // 链路要能持续，不是只跑一帧
    pump();
    pump();
    check(ticks >= beforePauseTicks + 3, `恢复后主循环应持续自递归，实得 ticks=${ticks}`);
  }

  // ---------- 暂停必须冻结 CSS 动画（1444432396 Glitch Clock 无法暂停）----------
  //
  // CSS `animation` 由浏览器**合成器**驱动，与 JS 主线程无关 —— 冻结 rAF 与定时器
  // 完全管不到它。1444432396 的整个视觉是 10 处 `animation: … infinite`（只有时钟文字
  // 走 setInterval），暂停后画面照旧动，用户看到就是「无法暂停」。
  // 纪律与媒体冻结一致：只还原我们代为暂停的，作者自己 paused 的不许唤醒。
  {
    const mk = (playState) => ({
      playState,
      pauseCalls: 0,
      playCalls: 0,
      pause() {
        this.pauseCalls++;
        this.playState = "paused";
      },
      play() {
        this.playCalls++;
        this.playState = "running";
      },
    });
    const anims = [mk("running"), mk("paused"), mk("running")];
    const { win } = runShim({
      document: {
        readyState: "complete",
        addEventListener() {},
        documentElement: { setAttribute() {}, getAttribute() { return null; } },
        querySelectorAll() {
          return [];
        },
        getAnimations() {
          return anims;
        },
      },
    });
    win.__weSetPaused(true);
    check(
      anims[0].pauseCalls === 1 && anims[2].pauseCalls === 1,
      "暂停必须冻结正在播放的 CSS 动画（合成器驱动，rAF 冻结管不到，1444432396）",
    );
    check(anims[1].pauseCalls === 0, "作者自己已暂停的动画不得重复操作");
    win.__weSetPaused(false);
    check(
      anims[0].playCalls === 1 && anims[2].playCalls === 1,
      "恢复时应还原我们代为暂停的 CSS 动画",
    );
    check(anims[1].playCalls === 0, "作者自己暂停的 CSS 动画不得被唤醒（hover 才播的装饰）");
  }

  // ---------- 无 getAnimations 的旧引擎不得抛错 ----------
  {
    const { win } = runShim();
    let threw = false;
    try {
      win.__weSetPaused(true);
      win.__weSetPaused(false);
    } catch {
      threw = true;
    }
    check(!threw, "环境无 document.getAnimations 时暂停/恢复不得抛错");
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

// ---------- 3c. 外部指针注入（桌面 underlay 通道的网页侧：合成 DOM 事件）----------
//
// 桌面壁纸窗口在 underlay 层收不到任何鼠标事件，宿主轮询系统鼠标后经
// __wp.pushPointer 推入。场景侧写一个状态对象即可（verify-pointer 第 3.5 节），
// 网页侧必须把推送**还原成合成 DOM 事件**——作者代码就是监听 DOM 的。
//
// 这一族缺陷全都是静默的：事件不发 / target 打错 / 边界链缺失，画面只是「不响应鼠标」，
// 控制台一片安静。所以每条不变量都要有断言。
{
  // 最小 DOM：只实现派发链需要的部分（parentNode / dispatchEvent / 捕获-冒泡）。
  // 不用 jsdom —— 全仓 verifier 都是零依赖离线跑。
  class FakeNode {
    constructor(name, parent) {
      this.nodeName = name;
      this.parentNode = parent || null;
      this.children = [];
      if (parent) parent.children.push(this);
      this.log = [];
    }
    addEventListener(type, fn) {
      (this.handlers ??= {})[type] ??= [];
      this.handlers[type].push(fn);
    }
    dispatchEvent(ev) {
      // 冒泡：目标 → 祖先链。不冒泡的事件只在 target 上跑（leave/enter）。
      ev.target = this;
      let n = this;
      while (n) {
        ev.currentTarget = n;
        for (const fn of n.handlers?.[ev.type] ?? []) fn(ev);
        if (!ev.bubbles) break;
        n = n.parentNode;
      }
      return true;
    }
  }

  class FakeMouseEvent {
    constructor(type, init) {
      this.type = type;
      Object.assign(this, init || {});
      this.bubbles = init?.bubbles !== false;
      // **复现 Chromium 的真实行为**：MouseEvent 构造器把 button:-1 规范化成 0
      // （实测 `new MouseEvent("x",{button:-1}).button === 0`，而 -2 原样通过）。
      // 之前 stub 直接照抄 init，于是「移动事件 button 必须为 -1」在 verifier 里
      // 绿着、真实浏览器里 mouse 路径却是 0 —— stub 比实现宽松就会漏掉真缺陷。
      if (this.button === -1) this.button = 0;
    }
  }
  // PointerEvent 构造器保留 -1（与 Chromium 一致）
  class FakePointerEvent extends FakeMouseEvent {
    constructor(type, init) {
      super(type, init);
      if (init && init.button === -1) this.button = -1;
    }
  }

  /** 造一份「文档树 + shim」：documentElement > body > canvas / button */
  function makePointerEnv(opts) {
    const docEl = new FakeNode("HTML", null);
    const body = new FakeNode("BODY", docEl);
    const canvas = new FakeNode("CANVAS", body);
    const button = new FakeNode("BUTTON", body);
    // 命中表：调用方给 (x,y) → 元素；默认 body
    const hit = opts?.hit ?? (() => body);
    const doc = {
      readyState: "complete",
      addEventListener() {},
      documentElement: docEl,
      body,
      querySelectorAll() {
        return [];
      },
      elementFromPoint(x, y) {
        return hit(x, y);
      },
    };
    docEl.parentNode = doc; // 作者挂 document 的 leave 也要收到
    const { win } = runShim({
      document: doc,
      MouseEvent: FakeMouseEvent,
      PointerEvent: FakePointerEvent,
      screenX: opts?.screenX ?? 0,
      screenY: opts?.screenY ?? 0,
    });
    return { win, doc, docEl, body, canvas, button };
  }

  /** 把某节点上的一串事件类型录进数组（顺序即断言依据） */
  function record(node, types, sink, label) {
    for (const t of types) {
      node.addEventListener(t, (ev) => {
        sink.push({ node: label, type: t, x: ev.clientX, y: ev.clientY, ev });
      });
    }
  }

  check(/__wePushPointer/.test(shimSrc) && /__wePointerLeave/.test(shimSrc),
    "web-shim 必须暴露 __wePushPointer / __wePointerLeave（网页壁纸的注入入口）");
  check(/__wePushPointer/.test(webTs) && /__wePointerLeave/.test(webTs),
    "web.ts 必须把 rt.pointerCtl 桥到 shim 的 __wePushPointer / __wePointerLeave");
  check(/rt\.pointerCtl/.test(webTs),
    "web.ts 必须设置 rt.pointerCtl（__wp.pushPointer 的落点，见 main.ts）");

  // (1) 作者挂 document/window 的路径（语料 15 张）：靠冒泡收到 mousemove
  {
    const env = makePointerEnv();
    const seen = [];
    record(env.docEl, ["mousemove", "pointermove"], seen, "html");
    env.win.__wePushPointer(120, 80, 0);
    const mm = seen.filter((e) => e.type === "mousemove");
    check(mm.length === 1, `挂 document 的 mousemove 应靠冒泡收到 1 次，实得 ${mm.length}`);
    check(
      mm[0] && mm[0].x === 120 && mm[0].y === 80,
      `合成事件 clientX/Y 必须是父页换算后的像素，实得 ${mm[0] && `${mm[0].x},${mm[0].y}`}`,
    );
    check(
      seen.some((e) => e.type === "pointermove"),
      "createjs 一族只挂 pointermove（语料 7 张），必须一并合成",
    );
  }

  // (2) 命中元素派发（1748506393 流体读 event.offsetX，挂在 canvas 上）：
  //     target 必须是命中元素本身，不能一律打 document —— offsetX/offsetY 由浏览器
  //     按 target 的 padding box 现算，target 错了偏移就错，且没有任何报错。
  {
    const env = makePointerEnv({ hit: (x) => (x > 100 ? null : null) });
    // 让命中表返回 canvas
    const envc = makePointerEnv();
    const seen = [];
    record(envc.canvas, ["mousemove"], seen, "canvas");
    envc.doc.elementFromPoint = () => envc.canvas;
    envc.win.__wePushPointer(50, 60, 0);
    check(
      seen.length === 1 && seen[0].ev.target === envc.canvas,
      "合成事件的 target 必须是 elementFromPoint 命中的元素（offsetX 由它现算）",
    );
    void env;
  }

  // (3) 边界链：命中元素变化时补 out/leave + over/enter，且 leave/enter 不冒泡。
  //     1748506393 靠 canvas 的 mouseenter 把 pointers[0].down 置 true（不进这个分支
  //     鼠标怎么动都不出染料）；1081733658 animatedGrid 靠 body 的 mouseover/mouseleave
  //     起停整个网格动画。
  {
    const env = makePointerEnv();
    let target = env.body;
    env.doc.elementFromPoint = () => target;
    const seen = [];
    record(env.canvas, ["mouseover", "mouseenter", "mouseout", "mouseleave"], seen, "canvas");
    record(env.body, ["mouseover", "mouseenter", "mouseout", "mouseleave"], seen, "body");
    env.win.__wePushPointer(10, 10, 0); // 进 body
    check(
      seen.some((e) => e.node === "body" && e.type === "mouseenter"),
      "首次进入应给命中元素发 mouseenter（1748506393 的 down 标志靠它）",
    );
    seen.length = 0;
    target = env.canvas;
    env.win.__wePushPointer(11, 11, 0); // body → canvas（canvas 是 body 的子）
    check(
      seen.some((e) => e.node === "canvas" && e.type === "mouseenter"),
      "移入子元素应发 canvas 的 mouseenter",
    );
    check(
      !seen.some((e) => e.node === "body" && e.type === "mouseleave"),
      "移入子元素时不得给父元素发 mouseleave（body 仍在指针下，animatedGrid 会误停）",
    );
    check(
      seen.some((e) => e.node === "canvas" && e.type === "mouseover"),
      "移入子元素应发 mouseover（会冒泡，17 张在用）",
    );
    seen.length = 0;
    target = env.body;
    env.win.__wePushPointer(12, 12, 0); // canvas → body
    check(
      seen.some((e) => e.node === "canvas" && e.type === "mouseleave") &&
        seen.some((e) => e.node === "canvas" && e.type === "mouseout"),
      "移出子元素应给它发 mouseout + mouseleave",
    );
    // enter/leave 的 bubbles 必须为 false，否则挂 document 的作者会被子元素的
    // 每次进出反复触发（animatedGrid 的整网格起停会疯狂抖）
    const le = seen.find((e) => e.type === "mouseleave");
    check(le && le.ev.bubbles === false, "mouseleave/mouseenter 不得冒泡（W3C 语义）");
  }

  // (4) 按键掩码跳变 → down/up/click 边缘（29 张听 click，是最大消费方）。
  //     轮询推送里没有「点击」这个事件，只有掩码跳变；边缘丢了整类交互就消失。
  {
    const env = makePointerEnv();
    env.doc.elementFromPoint = () => env.button;
    const seen = [];
    record(env.button, ["mousedown", "mouseup", "click", "dblclick", "pointerdown", "pointerup"], seen, "btn");
    env.win.__wePushPointer(5, 5, 0);
    env.win.__wePushPointer(5, 5, 1); // 按下
    check(
      seen.filter((e) => e.type === "mousedown").length === 1 &&
        seen.filter((e) => e.type === "pointerdown").length === 1,
      "掩码 bit0 置位应发 mousedown + pointerdown 各一次",
    );
    check(!seen.some((e) => e.type === "click"), "只按下未松开时不得发 click");
    // 同状态重复推送不得重复发（宿主 ~90Hz 推的是状态而非事件）
    env.win.__wePushPointer(5, 5, 1);
    env.win.__wePushPointer(5, 5, 1);
    check(
      seen.filter((e) => e.type === "mousedown").length === 1,
      "重复推送同一按下态不得重复发 mousedown（推送是状态而非事件）",
    );
    env.win.__wePushPointer(5, 5, 0); // 松开
    check(
      seen.filter((e) => e.type === "mouseup").length === 1 &&
        seen.filter((e) => e.type === "click").length === 1,
      "掩码 bit0 清零应发 mouseup + click 各一次",
    );
    // 高位（右/中键）不得触发左键语义：桌面右键属于 Finder，不该被壁纸劫持
    env.win.__wePushPointer(5, 5, 2);
    env.win.__wePushPointer(5, 5, 4);
    check(
      seen.filter((e) => e.type === "mousedown").length === 1,
      "掩码高位（右/中键）不得合成左键 mousedown",
    );
  }

  // (5) 拖拽（down 与 up 落在不同元素）不得发 click —— 浏览器也不发
  {
    const env = makePointerEnv();
    let target = env.button;
    env.doc.elementFromPoint = () => target;
    const seen = [];
    record(env.docEl, ["click"], seen, "html");
    env.win.__wePushPointer(5, 5, 1);
    target = env.canvas;
    env.win.__wePushPointer(90, 90, 1);
    env.win.__wePushPointer(90, 90, 0);
    check(seen.length === 0, "down/up 落在不同元素（拖拽）不得发 click");
  }

  // (6) dblclick：500ms 内同元素二次点击（语料 5 张听 dblclick）
  {
    const env = makePointerEnv();
    env.doc.elementFromPoint = () => env.button;
    const seen = [];
    record(env.button, ["click", "dblclick"], seen, "btn");
    for (let i = 0; i < 2; i++) {
      env.win.__wePushPointer(5, 5, 1);
      env.win.__wePushPointer(5, 5, 0);
    }
    check(
      seen.filter((e) => e.type === "click").length === 2 &&
        seen.filter((e) => e.type === "dblclick").length === 1,
      "同元素连续两次点击应发 2 次 click + 1 次 dblclick",
    );
  }

  // (7) 静止不重复派发：位置与按键都没变时什么都不发。
  //     宿主 ~90Hz 推送，若静止也发 mousemove，作者的「有没有在动」判定
  //     （1081733658 网格）会永远认为在动。
  {
    const env = makePointerEnv();
    const seen = [];
    record(env.docEl, ["mousemove"], seen, "html");
    env.win.__wePushPointer(30, 40, 0);
    env.win.__wePushPointer(30, 40, 0);
    env.win.__wePushPointer(30, 40, 0);
    check(seen.length === 1, `静止时不得重复派发 mousemove，实得 ${seen.length} 次`);
  }

  // (8) movementX/Y：首帧必须为 0（3 张读 movementX）。
  //     首帧若按 (0,0) 算差会得到一个等于绝对坐标的巨大假位移。
  {
    const env = makePointerEnv();
    const seen = [];
    record(env.docEl, ["mousemove"], seen, "html");
    env.win.__wePushPointer(300, 200, 0);
    check(
      seen[0] && seen[0].ev.movementX === 0 && seen[0].ev.movementY === 0,
      `首次推送的 movementX/Y 必须为 0，实得 ${seen[0] && `${seen[0].ev.movementX},${seen[0].ev.movementY}`}`,
    );
    env.win.__wePushPointer(310, 190, 0);
    check(
      seen[1] && seen[1].ev.movementX === 10 && seen[1].ev.movementY === -10,
      `第二次推送的 movementX/Y 应为帧间位移，实得 ${seen[1] && `${seen[1].ev.movementX},${seen[1].ev.movementY}`}`,
    );
  }

  // (8b) `button` 的哨兵值：移动/悬停类事件必须是 -1，只有 down/up/click 才是 0。
  //      2517518192（GameMaker HTML5 导出的 FNAF）在 pointermove 分支里照抄
  //      `_tq = e.button` 再 `_mq |= (1 << _tq)`，且 _mq 只在 pointerup/out 才清零 ——
  //      移动事件填 button:0 等于告诉游戏「左键一直按着」，鼠标只是移过去就永久卡在
  //      按下态，画面表现是「点一下之后就再也点不动」，没有任何报错。
  {
    const env = makePointerEnv();
    env.doc.elementFromPoint = () => env.canvas;
    const seen = [];
    record(
      env.canvas,
      ["pointermove", "mousemove", "pointerover", "mouseover", "pointerenter", "mouseenter",
       "pointerout", "mouseout", "pointerleave", "mouseleave",
       "pointerdown", "mousedown", "pointerup", "mouseup", "click"],
      seen,
      "canvas",
    );
    env.win.__wePushPointer(10, 10, 0); // 进入 + 移动
    env.win.__wePushPointer(20, 20, 1); // 按下
    env.win.__wePushPointer(20, 20, 0); // 松开 → click
    env.win.__wePointerLeave(); // out/leave
    const HOVER = new Set([
      "pointermove", "mousemove", "pointerover", "mouseover", "pointerenter",
      "mouseenter", "pointerout", "mouseout", "pointerleave", "mouseleave",
    ]);
    const PRESS = new Set(["pointerdown", "mousedown", "pointerup", "mouseup", "click"]);
    const badHover = seen.filter((e) => HOVER.has(e.type) && e.ev.button !== -1);
    const badPress = seen.filter((e) => PRESS.has(e.type) && e.ev.button !== 0);
    check(
      seen.some((e) => HOVER.has(e.type)) && badHover.length === 0,
      `移动/悬停类事件的 button 必须为 -1（W3C 哨兵值），违反：${badHover
        .map((e) => `${e.type}=${e.ev.button}`)
        .join(",")}`,
    );
    check(
      seen.some((e) => PRESS.has(e.type)) && badPress.length === 0,
      `down/up/click 的 button 必须为 0（左键），违反：${badPress
        .map((e) => `${e.type}=${e.ev.button}`)
        .join(",")}`,
    );
  }

  // (9) 非有限坐标必须丢弃：NaN 进 clientX 会让 elementFromPoint 返回 null、
  //     作者的位移积分一次性污染成 NaN，且没有任何报错（与场景通道同一约定）。
  {
    const env = makePointerEnv();
    const seen = [];
    record(env.docEl, ["mousemove"], seen, "html");
    env.win.__wePushPointer(NaN, 10, 0);
    env.win.__wePushPointer(10, undefined, 0);
    check(seen.length === 0, "非有限坐标必须丢弃（NaN 会静默污染作者状态）");
    env.win.__wePushPointer(10, 10, 0);
    check(seen.length === 1, "丢弃非法值后合法推送仍应正常派发");
  }

  // (10) 暂停期间丢弃：官方暂停语义是「冻结渲染进程」，此时派发事件会让作者的
  //      动画状态在冻结中继续推进，恢复时画面跳一下。
  {
    const env = makePointerEnv();
    const seen = [];
    record(env.docEl, ["mousemove"], seen, "html");
    env.win.__weSetPaused(true);
    env.win.__wePushPointer(10, 10, 0);
    env.win.__wePushPointer(20, 20, 1);
    check(seen.length === 0, "暂停期间不得派发合成事件（官方暂停 = 冻结进程）");
    env.win.__weSetPaused(false);
    env.win.__wePushPointer(30, 30, 0);
    check(seen.length === 1, "恢复后应继续派发");
  }

  // (11) pointerLeave 必须真的发 out/leave 链并补 up。
  //      场景侧只清一个状态位就够，网页作者的 hover 态是自己记的 —— 不发 leave
  //      就永久卡在「鼠标还在上面」（1081733658 网格一直跑、1748506393 的
  //      pointers[0].down 一直 true 持续喷染料）。
  {
    const env = makePointerEnv();
    env.doc.elementFromPoint = () => env.canvas;
    const seen = [];
    record(env.canvas, ["mouseleave", "mouseout", "mouseup"], seen, "canvas");
    env.win.__wePushPointer(10, 10, 1); // 进来并按下
    env.win.__wePointerLeave();
    check(
      seen.some((e) => e.type === "mouseup"),
      "pointerLeave 时若仍按着键必须补 mouseup（否则拖拽逻辑永不结束）",
    );
    check(
      seen.some((e) => e.type === "mouseleave") && seen.some((e) => e.type === "mouseout"),
      "pointerLeave 必须发 mouseout + mouseleave（作者 hover 态否则永久卡住）",
    );
    // 再次进入时应重新发 enter（leave 已经把命中态清了）
    const seen2 = [];
    record(env.canvas, ["mouseenter"], seen2, "canvas");
    env.win.__wePushPointer(11, 11, 0);
    check(seen2.length === 1, "leave 之后再次进入应重新发 mouseenter");
  }

  // (12) 作者处理器抛错不得打断后续事件：一个坏 listener 若让整条链断掉，
  //      leave 发不出去就会留下永久 hover / 按下态。
  {
    const env = makePointerEnv();
    env.doc.elementFromPoint = () => env.canvas;
    let after = 0;
    env.canvas.addEventListener("mousemove", () => {
      throw new Error("author bug");
    });
    env.docEl.addEventListener("mousemove", () => {
      after++;
    });
    let threw = false;
    try {
      env.win.__wePushPointer(10, 10, 0);
    } catch {
      threw = true;
    }
    check(!threw, "作者处理器抛错不得冒出 __wePushPointer（会打断宿主推送循环）");
    void after; // 冒泡在同一个 dispatchEvent 内，抛错后不强求继续
  }

  // (13) 坐标换算（父页侧）：cover 露底自适配下 iframe 比容器大且带负偏移，
  //      归一化坐标是相对**窗口**的，必须减掉 iframe 相对容器的偏移。
  //      按 webPointerToClient 的定义在此独立复算。
  {
    check(
      /export function webPointerToClient/.test(webTs),
      "web.ts 必须导出 webPointerToClient（坐标换算要能独立数值校验）",
    );
    // 跑**真实现**而不是复算副本：这一条最初写成 verifier 自己复算一遍公式，
    // 结果把 web.ts 的偏移减法删掉后 verifier 照绿 —— 那样的断言等于没有。
    const toClient = await importIsolatedFn(webTs, "webPointerToClient");
    check(typeof toClient === "function", "webPointerToClient 必须能被独立抽出执行（无外部依赖）");
    // 常规：iframe 与容器同盒
    const stage = { left: 0, top: 0, width: 1920, height: 1080 };
    const same = toClient(0.25, 0.75, stage, { left: 0, top: 0, width: 1920, height: 1080 }, { width: 1920, height: 1080 });
    check(
      same && Math.abs(same.x - 480) < 1e-6 && Math.abs(same.y - 810) < 1e-6,
      `同盒时 u/v 应直接乘容器尺寸，实得 ${same && `${same.x},${same.y}`}`,
    );
    // 1731760875 的 16:10 档：1920×1200 容器里放 2133.33×1200 视口，left = -106.67
    const stage1610 = { left: 0, top: 0, width: 1920, height: 1200 };
    const frame1610 = { left: -106.666, top: 0, width: 2133.333, height: 1200 };
    const cover = toClient(0.5, 0.5, stage1610, frame1610, { width: 2133.333, height: 1200 });
    check(
      cover && Math.abs(cover.x - 1066.666) < 0.01 && Math.abs(cover.y - 600) < 0.01,
      `cover 换视口后窗口中心应落在 iframe 内容中心，实得 ${cover && `${cover.x.toFixed(1)},${cover.y.toFixed(1)}`}`,
    );
    // 若忘了减 iframe 偏移，窗口中心会算成 960（差 106.67px）—— 锁住这个差值
    const wrong = 0.5 * stage1610.width;
    check(
      Math.abs(cover.x - wrong) > 100,
      "换算必须减掉 iframe 相对容器的偏移（不减则 cover 下整体偏 ~107px）",
    );
    // 测试台固定分辨率模式：祖先 CSS transform 缩放，rect 含缩放、iframe 内部视口不含
    const scaled = toClient(
      0.5,
      0.5,
      { left: 0, top: 0, width: 960, height: 540 },
      { left: 0, top: 0, width: 960, height: 540 },
      { width: 1920, height: 1080 },
    );
    check(
      scaled && Math.abs(scaled.x - 960) < 1e-6 && Math.abs(scaled.y - 540) < 1e-6,
      `CSS 缩放下应还原到 iframe 内部视口像素，实得 ${scaled && `${scaled.x},${scaled.y}`}`,
    );
    check(
      toClient(NaN, 0.5, stage, { left: 0, top: 0, width: 1, height: 1 }, { width: 1, height: 1 }) === null &&
        toClient(0.5, 0.5, { left: 0, top: 0, width: 0, height: 0 }, { left: 0, top: 0, width: 1, height: 1 }, { width: 1, height: 1 }) === null,
      "非法输入必须回退 null（不抛异常）",
    );
  }
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

// ---------- 8. 网页壁纸「露底」cover 自适配（1731760875 16:10 底部黑条）----------
{
  check(
    /export function webCoverViewport/.test(webTs) && /export function measureWebLetterbox/.test(webTs),
    "web.ts 必须导出 webCoverViewport / measureWebLetterbox（可独立数值校验）",
  );
  check(
    /normalizeFit\(rt\.cfg\.fit\) === "cover"/.test(webTs),
    "露底自适配只在 cover 生效（contain 本该留边、stretch 本该拉伸）",
  );
  check(
    /querySelectorAll\("video,img"\)/.test(webTs),
    "露底判定不得包含 canvas（canvas 无内在比例，作者自管 backing store）",
  );
  check(
    /videoWidth.*naturalWidth/s.test(webTs) && /if \(!\(natW > 0\) \|\| !\(natH > 0\)\) continue;/.test(webTs),
    "内容比例必须取媒体原始尺寸，且元数据未到时跳过（否则算出荒谬视口）",
  );
  check(
    /rt\.webRelayout\?\.\(\)/.test(fs.readFileSync(path.join(ROOT, "renderer/src/main.ts"), "utf8")),
    "setFit 必须触发网页壁纸复算（fit 实时切换不重挂）",
  );

  // 数值同构：把 web.ts 的公式在此复算，锁 cover 语义（不是照抄实现，是按定义验）
  const ASPECT_EPS = 0.005;
  const cover = (stageW, stageH, a) => {
    if (!(stageW > 0) || !(stageH > 0) || !(a > 0)) return null;
    const sa = stageW / stageH;
    if (Math.abs(sa - a) <= ASPECT_EPS) return null;
    if (sa < a) {
      const width = stageH * a;
      return { width, height: stageH, left: (stageW - width) / 2, top: 0 };
    }
    const height = stageW / a;
    return { width: stageW, height, left: 0, top: (stageH - height) / 2 };
  };
  const A = 16 / 9;
  // 16:9 舞台（含 4K / DPR 取整误差）：不该动
  check(cover(1920, 1080, A) === null, "16:9 舞台不该换视口");
  check(cover(3840, 2160, A) === null, "4K(16:9) 不该换视口");
  check(cover(1920, 1081, A) === null, "DPR 取整的 1920×1081 仍算 16:9，不该换视口");
  // 16:10：1731760875 的报障档，必须铺满高度、裁宽、居中
  const r1610 = cover(1920, 1200, A);
  check(
    r1610 && Math.abs(r1610.height - 1200) < 0.5 && Math.abs(r1610.width - 2133.33) < 0.5,
    `16:10 应铺满高度并裁宽到 2133×1200，实得 ${r1610 && `${r1610.width.toFixed(1)}×${r1610.height.toFixed(1)}`}`,
  );
  check(
    r1610 && Math.abs(r1610.left + 106.67) < 0.5 && r1610.top === 0,
    "16:10 裁切必须左右居中（left 为负的一半溢出）",
  );
  // 覆盖的定义：视口必须同时 >= 舞台两个方向（不能留缝）
  for (const [w, h] of [
    [1920, 1200],
    [1680, 1050],
    [2560, 1600],
    [2560, 1080],
    [3440, 1440],
    [1080, 1920],
    [1440, 2560],
  ]) {
    const r = cover(w, h, A);
    check(
      r !== null && r.width >= w - 0.5 && r.height >= h - 0.5,
      `${w}×${h} 覆盖后视口必须不小于舞台（实得 ${r ? `${r.width.toFixed(0)}×${r.height.toFixed(0)}` : "null"}）`,
    );
    // 且比例必须还是内容比例（不许拉伸）
    check(
      r !== null && Math.abs(r.width / r.height - A) < 1e-6,
      `${w}×${h} 覆盖后必须保持内容比例（不得拉伸）`,
    );
  }
  // 非法输入不得抛
  check(cover(0, 100, A) === null && cover(100, 0, A) === null && cover(100, 100, 0) === null,
    "非法尺寸/比例必须回退 null（不抛异常）");
}

// ---------- 3f. 宿主注入的频谱 / 媒体源必须能到达网页壁纸 ----------
//
// 下游实测症状：「麦克风都接上了，网页壁纸的音谱还在放默认合成流」。
// 根因是 web 装配路径压根不读 rt.audioBridge —— 1.3.0 给媒体接了这一环，
// 音频这行漏了（web.ts 里 audioBridge 出现 0 次）。
//
// 第二个坑同样致命：泵在**装配时**捕获 driver，而 setAudio()/setMedia() 通常
// 在 mount() 之后才调用（宿主的麦克风 / SSE 通道那时才就绪），定死 driver
// 等于后装的源永远不生效。所以选源必须逐帧做。
{
  const webTs = fs.readFileSync(path.join(ROOT, "renderer/src/web.ts"), "utf8");

  // --- 接线面 ---
  check(/rt\.audioBridge/.test(webTs),
    "web.ts 必须读 rt.audioBridge（否则宿主注入的频谱到不了网页壁纸，音谱永远是默认模拟流）");
  check(/function bridgeAudioDriver/.test(webTs),
    "web.ts 应有 bridgeAudioDriver 把注入源包成 web 侧 driver");

  // --- 逐帧选源：两个泵都不能在装配期定死 driver ---
  const bodyOf = (name) => {
    const at = webTs.indexOf(`function ${name}`);
    if (at < 0) return "";
    const end = webTs.indexOf("\n}", at);
    return end > at ? webTs.slice(at, end + 2) : "";
  };
  const audioPump = bodyOf("startAudioPump");
  const mediaPump = bodyOf("startMediaPump");
  check(audioPump.length > 0 && mediaPump.length > 0, "找不到 startAudioPump / startMediaPump 函数体");
  check(/rt\.audioBridge \? bridged : driver/.test(audioPump) || /const pick[\s\S]{0,120}rt\.audioBridge/.test(audioPump),
    "startAudioPump 必须逐帧选源（装配期定死 driver 会让 mount() 之后的 setAudio 永不生效）");
  check(/rt\.mediaSource[\s\S]{0,60}\?\?\s*driver/.test(mediaPump) || /const pick[\s\S]{0,120}rt\.mediaSource/.test(mediaPump),
    "startMediaPump 必须逐帧选源（同理，setMedia 常在 mount() 之后才调用）");
  // 选了 cur 就要全程用 cur：曾经改了 update 却把 snapshot 落在旧 driver 上
  check(!/pushMediaDiff\(rt, lastMedia, driver\.snapshot\)/.test(mediaPump),
    "startMediaPump 取快照必须用逐帧选出的 driver，不能混用装配期的那个");

  // --- 行为面：抽真函数执行 ---
  const at = webTs.indexOf("function bridgeAudioDriver");
  const end = webTs.indexOf("\n}", at) + 2;
  const bridgeSrc = at >= 0 && end > at ? webTs.slice(at, end) : "";
  // 注入源已是 0..1 真实频谱，**不得再套 shapeWebAudioBand 的 gamma 扩展**
  // ——那是给内置模拟源的未钳位频段用的（把平缓合成波形拉出对比度），
  // 对真实频谱再乘一遍会把音条整体顶到满格。源码面先挡一道，避免下面
  // 隔离执行时因引用不到该函数而抛成难读的 ReferenceError。
  check(bridgeSrc.length > 0, "找不到 bridgeAudioDriver 函数体");
  check(!/shapeWebAudioBand/.test(bridgeSrc),
    "bridgeAudioDriver 不得对注入频谱套 shapeWebAudioBand（宿主给的已是 0..1 真实频谱，再套 gamma 会顶满格）");
  if (bridgeSrc && !/shapeWebAudioBand/.test(bridgeSrc)) {
    const esbuild = await import("esbuild");
    const out = await esbuild.transform(
      "type Runtime=any; type WebAudioDriver=any;\n" + bridgeSrc + "\nexport {bridgeAudioDriver};",
      { loader: "ts", format: "esm", target: "es2022" },
    );
    const tmp = path.join(ROOT, "scripts", `.tmp-web-bridge-${process.pid}.mjs`);
    fs.writeFileSync(tmp, out.code);
    try {
      const mod = await import(pathToFileURL(tmp).href + `?t=${Date.now()}`);
      const rt = { audioBridge: null };
      const d = mod.bridgeAudioDriver(rt);
      const L = new Float32Array(64), R = new Float32Array(64);
      for (let i = 0; i < 8; i++) { L[i] = 0.9; R[i] = 0.7; }
      rt.audioBridge = () => ({ left: L, right: R });
      const s1 = d.snapshot();
      // **不得再套 shapeWebAudioBand 的 gamma 扩展**：那是给内置模拟源的未钳位
      // 频段用的，宿主给的已是 0..1 真实频谱，再乘一遍会把音条整体顶到满格
      check(Math.abs(s1.left[0] - 0.9) < 1e-6 && Math.abs(s1.right[0] - 0.7) < 1e-6,
        `注入频谱必须原样透传（不套 gamma 扩展），实得 left[0]=${s1.left[0]} right[0]=${s1.right[0]}`);
      check(s1.left[40] === 0, "未提供能量的高频段应为 0");
      // 返回 null 时给全零而不是回落模拟源：宿主明确装了源就说明它要自己供数，
      // 冒出一段合成波形只会让人误以为「注入生效了」
      rt.audioBridge = () => null;
      const s2 = d.snapshot();
      check([...s2.left].every((v) => v === 0) && [...s2.right].every((v) => v === 0),
        "bridge 返回 null 时应给全零，不得回落合成波形");
      rt.audioBridge = () => ({ left: new Float32Array(64).fill(3), right: new Float32Array(64).fill(-1) });
      const s3 = d.snapshot();
      check(s3.left[0] === 1 && s3.right[0] === 0, `越界值必须钳到 0..1，实得 ${s3.left[0]}/${s3.right[0]}`);
      rt.audioBridge = () => ({ left: new Float32Array(8).fill(1), right: new Float32Array(8).fill(1) });
      const s4 = d.snapshot();
      check(s4.left[0] === 1 && s4.left[10] === 0, "段数不足 64 时应补零，不得残留上一帧数据");
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }
    }
  }
}

if (errors.length) {
  console.error(`verify-web: ${errors.length} 项失败`);
  for (const e of errors) console.error("  ✗", e);
  process.exit(1);
}
console.log("verify-web: ok");
