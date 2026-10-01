/**
 * 一次性实测探针 · 生命周期/代际（M4 的行为面验收，非门禁）。
 *
 * 覆盖 docs/ENGINE-REVIEW-2026-10.md §3.3 的四类洞，全部走**公共库 API**
 * （页面里直接 import /renderer/src/api/index.ts，dev server 现场转译 TS）：
 *   A. destroy() 后在同一容器再 mount：必须换新画布（旧那块建过 GL，上下文已死）
 *   B. 网页壁纸连续两次 load：容器里只许有一个 iframe（孤儿 iframe 是这条的老症状）
 *   C. 装配途中 destroy：不得复活（等 2.5s 后容器里不该冒出新画布）
 *   D. destroy() 之后再 load：no-op（不复活）且**有诊断**（不静默）
 *
 * 判据一律用「容器里有没有画布/iframe」—— 比 rAF 计数干净，也不受页面自身动画干扰。
 *
 * 用法：node scripts/_probe-review-lifecycle.mjs [sceneItemId] [webItemId]
 * 依赖：本机 dev server 在跑（默认 1430）且挂了本地壁纸库。
 */
import { launchHeadless, instrument } from "./headless-gpu.mjs";

const SCENE_ID = process.argv[2] || "1039919954";
const WEB_ID = process.argv[3] || "1520828134";
const ORIGIN = "http://localhost:1430";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const INIT = `(() => {
  const P = (window.__lp = { diag: [] });
  const desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
  Object.defineProperty(HTMLImageElement.prototype, "src", {
    configurable: true, enumerable: desc.enumerable,
    get() { return desc.get.call(this); },
    set(v) {
      const s = String(v);
      if (s.indexOf("/diag") >= 0) { try { P.diag.push(decodeURIComponent(s.slice(s.indexOf("msg=") + 4).split("&")[0])); } catch (e) {} }
      return desc.set.call(this, v);
    },
  });
})();`;

const DRIVER = `(async () => {
  const OUT = (window.__lpOut = {});
  const { createScene, httpSource } = await import("/renderer/src/api/index.ts");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const mkDiv = () => {
    const d = document.createElement("div");
    d.style.cssText = "position:absolute;left:0;top:0;width:640px;height:360px;";
    document.body.appendChild(d);
    return d;
  };
  const ORIGIN = ${JSON.stringify(ORIGIN)};
  const SCENE = httpSource(ORIGIN + "/media/dev/${SCENE_ID}");
  const WEB = httpSource(ORIGIN + "/media/dev/${WEB_ID}");
  const WEB2 = httpSource(ORIGIN + "/media/dev/${process.argv[4] || "1589757429"}");
  const DIAGS = [];
  const OPTS = { muted: true, mountTimeoutMs: 20000, onDiagnostic: (m, l) => DIAGS.push(l + ": " + m) };

  // E. 【页面路径】__wp.setWallpaper 连续两次：它直接 mountWallpaper，**不经过实例**，
  //    所以 mount.ts 的代际核对护不到这里 —— web.ts 那道核对的真正用武之地。
  //    慢的一代先发、快的一代后发；没有代际核对时，慢的那代会**最后**挂上，把快的顶掉。
  {
    const of = window.fetch;
    let slowed = false;
    window.fetch = function (input) {
      const u = String(typeof input === "string" ? input : (input && input.url) || "");
      if (!slowed && u.indexOf("/media/dev/${WEB_ID}/project.json") >= 0) {
        slowed = true;
        const args = arguments;
        return new Promise((r) => setTimeout(r, 900)).then(() => of.apply(window, args));
      }
      return of.apply(window, arguments);
    };
    const base = { type: "web", mediaBase: ORIGIN + "/media/dev", fit: "cover", muted: true, loop: true };
    window.__wp.setWallpaper({ ...base, src: ORIGIN + "/media/dev/${WEB_ID}/index.html" });
    await sleep(60);
    window.__wp.setWallpaper({ ...base, src: ORIGIN + "/media/dev/${process.argv[4] || "1589757429"}/index.html" });
    await sleep(5000);
    const frames = [...document.querySelectorAll("iframe")];
    OUT.E = {
      iframes: frames.length,
      winners: frames.map((f) => (String(f.src).indexOf("${WEB_ID}") >= 0 ? "slow(${WEB_ID})" : "fast(other)")),
    };
    window.fetch = of;
  }

  // A. destroy 后同容器再 mount：必须换新画布
  {
    const d = mkDiv();
    const s1 = createScene(d, OPTS);
    let firstOk = false, err1 = null;
    try { await s1.load(SCENE); firstOk = true; } catch (e) { err1 = String(e && e.message).slice(0, 90); }
    const c1 = d.querySelector("canvas");
    s1.destroy();
    await sleep(400);
    const s2 = createScene(d, OPTS);
    let secondOk = false, err2 = null;
    try { await s2.load(SCENE); secondOk = true; } catch (e) { err2 = String(e && e.message).slice(0, 90); }
    const c2 = d.querySelector("canvas");
    OUT.A = {
      firstFrame: firstOk, firstErr: err1,
      secondFrame: secondOk, secondErr: err2,
      canvases: d.querySelectorAll("canvas").length,
      isNewCanvas: !!c1 && !!c2 && c1 !== c2,
      newHasGlMark: c2 ? c2.getAttribute("data-webwallgl-gl") : null,
    };
    s2.destroy();
  }

  // B. 网页壁纸连续两次 load：只许一个 iframe
  //
  // 这是个**时序竞态**：两次 load 同源同速时，后一次的 mountWeb 先 clear(rt)，
  // 会把前者挂上的 iframe 一起清掉，看不出问题。孤儿只在「#1 的 attach 晚于 #2 的 clear」
  // 时出现 —— 所以这里**人为把第一张的 project.json 拖慢 800ms**，把竞态摆到台面上。
  // （没有代际核对时：两个 iframe 都在容器里、rt.iframe 只指向后者，前者永久联网跑脚本。）
  {
    const d = mkDiv();
    const of = window.fetch;
    let slowed = false;
    window.fetch = function (input) {
      const u = String(typeof input === "string" ? input : (input && input.url) || "");
      if (!slowed && u.indexOf("/media/dev/${WEB_ID}/project.json") >= 0) {
        slowed = true;
        const args = arguments;
        return new Promise((r) => setTimeout(r, 800)).then(() => of.apply(window, args));
      }
      return of.apply(window, arguments);
    };
    const s = createScene(d, OPTS);
    // 慢的一代先发（它的 project.json 被拖 800ms），快的一代后发。
    // 没有代际核对的旧行为：**慢的那一代最后落地、把快的那一代覆盖掉** —— 用户最后
    // 一次 load 的请求内容被更早的一次顶掉（不是「孤儿 iframe 泄漏」，评审那条判断需修正）。
    const p1 = s.load(WEB).then(() => "ok").catch((e) => "err:" + String(e && e.message).slice(0, 60));
    await sleep(60); // 让第一次 load 进到 await 里
    const p2 = s.load(WEB2).then(() => "ok").catch((e) => "err:" + String(e && e.message).slice(0, 60));
    await sleep(4500);
    const ifr = d.querySelector("iframe");
    OUT.B = {
      iframes: d.querySelectorAll("iframe").length,
      // 最终留下的是哪一张：快的那代（WEB2）才对 —— 最后一次请求应当赢
      winner: ifr ? (String(ifr.src).indexOf("${process.argv[3] || "1520828134"}") >= 0 ? "slow(WEB)" : "fast(WEB2)") : null,
      first: await p1,
      second: await p2,
    };
    window.fetch = of;
    s.destroy();
  }

  // C. 装配途中 destroy：不得复活
  {
    const d = mkDiv();
    const s = createScene(d, OPTS);
    const p = s.load(SCENE).then(() => "resolved").catch((e) => "rejected:" + String(e && e.message).slice(0, 60));
    s.destroy(); // 立刻销毁：此刻 load 还在 resolveMountConfig 的 await 里
    await sleep(2500);
    const c = d.querySelector("canvas");
    OUT.C = {
      loadOutcome: await p,
      canvases: d.querySelectorAll("canvas").length,
      canvasHasGlMark: c ? c.getAttribute("data-webwallgl-gl") : null,
    };
  }

  // D. destroy 之后再 load：no-op + 有诊断
  {
    const d = mkDiv();
    const s = createScene(d, OPTS);
    s.destroy();
    const before = DIAGS.length;
    const out = await s.load(SCENE).then(() => "resolved").catch((e) => "rejected:" + String(e && e.message).slice(0, 60));
    await sleep(1200);
    OUT.D = {
      loadOutcome: out,
      canvases: d.querySelectorAll("canvas").length,
      diagAdded: DIAGS.slice(before).filter((m) => m.indexOf("已销毁") >= 0).length, // 渠道已随 destroy 关闭，此处仅作信息
      diagSample: DIAGS.slice(before).slice(0, 3),
    };
  }

  return JSON.stringify(OUT);
})()`;

async function main() {
  // 页面用测试台（type=canvas 走降级演示页，不加载 pkg）：同源才能 import 库模块
  const url = `${ORIGIN}/renderer/index.html?type=canvas`;
  const session = await launchHeadless({ url: "about:blank", task: "probe-lifecycle", width: 1280, height: 720 });
  const report = { scene: SCENE_ID, web: WEB_ID };
  try {
    instrument(session);
    await session.pageCdp.send("Page.addScriptToEvaluateOnNewDocument", { source: INIT });
    await session.pageCdp.send("Page.navigate", { url });
    await session.waitFor("typeof window.__lp === 'object'", { timeoutMs: 30000 });
    await sleep(800);
    report.result = JSON.parse(await session.evaluate(DRIVER, { awaitPromise: true, timeoutMs: 120000 }));
    report.diagSample = await session.evaluate(`JSON.stringify((window.__lp.diag || []).filter((m) => m.indexOf("已销毁") >= 0 || m.indexOf("上下文丢失") >= 0).slice(0, 3))`);
  } finally {
    try {
      await session.close();
    } catch {
      /* 忽略 */
    }
  }
  console.log(JSON.stringify(report, null, 2));
}

await main();
