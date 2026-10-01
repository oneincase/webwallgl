/**
 * 一次性实测探针 · GL 层（2026-10-01 引擎审查用，非门禁）。
 *
 * 目的：把 docs/ENGINE-REVIEW-2026-10.md 里「上下文丢失 = 画面冻结但一切正常」
 * 从注释推断变成实测。做法：
 *   1. 注入计数器（rAF 帧数 / webglcontextlost 监听 / console 与 /diag 捕获）
 *   2. 挂一张真实场景壁纸（走本机 dev server 已挂载的本地库 /media/dev/<id>/）
 *   3. 对照组：丢失前连拍两张截图 —— 动画在跑则两张不同
 *   4. 强制 WEBGL_lose_context.loseContext()，再连拍两张 —— 冻结则两张完全相同
 *   5. 再 restoreContext()，看引擎是否重建（预期：不会）
 *
 * 用法：node scripts/_probe-review-gl.mjs [itemId] [origin]
 * 依赖：本机 dev server 在跑（默认 http://localhost:1430），且它挂了本地壁纸库。
 */
import { createHash } from "node:crypto";
import { launchHeadless, instrument } from "./headless-gpu.mjs";

const ITEM = process.argv[2] || "1039919954";
const ORIGIN = process.argv[3] || "http://localhost:1430";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const INIT = `(() => {
  const P = (window.__glProbe = { ctx: null, ctxType: null, lost: 0, restored: 0, raf: 0, warns: [], errors: [], diag: [],
    contexts: [], losses: [] });
  const orig = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    const ctx = orig.call(this, type, ...rest);
    if (ctx && typeof type === "string" && type.indexOf("webgl") === 0) {
      if (!P.ctx) { P.ctx = ctx; P.ctxType = type; }
      const idx = P.contexts.length;
      P.contexts.push({
        i: idx, type: type, w: this.width, h: this.height,
        weAttr: this.getAttribute && this.getAttribute("data-webwallgl"),
        parent: this.parentElement ? this.parentElement.tagName + (this.parentElement.id ? "#" + this.parentElement.id : "") : null,
      });
      try {
        this.addEventListener("webglcontextlost", () => {
          P.lost++;
          // 记下是哪一块画布、多大 —— 区分「主画布被驱逐」与「缩略图小画布」
          P.losses.push({ i: idx, w: this.width, h: this.height });
        });
        this.addEventListener("webglcontextrestored", () => { P.restored++; });
      } catch (e) {}
    }
    return ctx;
  };
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => raf((t) => { P.raf++; return cb(t); });
  const ow = console.warn.bind(console), oe = console.error.bind(console);
  console.warn = (...a) => { P.warns.push(a.map(String).join(" ").slice(0, 200)); if (P.warns.length > 80) P.warns.shift(); ow(...a); };
  console.error = (...a) => { P.errors.push(a.map(String).join(" ").slice(0, 200)); if (P.errors.length > 80) P.errors.shift(); oe(...a); };
  const of = window.fetch;
  window.fetch = function (input) {
    const u = typeof input === "string" ? input : (input && input.url) || "";
    if (u.indexOf("/diag") >= 0) P.diag.push(String(u).slice(0, 300));
    return of.apply(this, arguments);
  };
  // reportDiag 走 new Image().src（不是 fetch）—— 不 hook 这里就看不到任何诊断。
  // 注意：模板字面量里**不许**出现反斜杠转义的正则、也不许出现反引号 ——
  // 前者会被折成裸斜杠把正则拆成语法错误，后者会直接终止模板；
  // 两种都让 INIT 在页面里编译失败且**静默**（探针对象不出现，表现为 waitFor 超时）。
  // 文件末尾的 new Function(INIT) 自检就是为这个准备的。
  const srcDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
  Object.defineProperty(HTMLImageElement.prototype, "src", {
    configurable: true,
    enumerable: srcDesc.enumerable,
    get() { return srcDesc.get.call(this); },
    set(v) {
      const s = String(v);
      if (s.indexOf("/diag") >= 0) P.diag.push(s.slice(0, 300));
      return srcDesc.set.call(this, v);
    },
  });
})();`;

// INIT 只在页面里编译，语法错误是**静默**的（探针对象压根不出现，表现为 waitFor 超时）。
// 在 Node 侧先编译一次，把这类错误挡在运行之前。注意要用**求值后的** INIT（不是文件原文）——
// 模板字面量的转义折叠只在求值后发生，拿原文检查会漏（`\/` → `/` 那个坑就是这么漏掉的）。
new Function(INIT);

const state = () =>
  `(() => { const P = window.__glProbe || {}; let st = null; try { st = window.__wp && __wp.getState ? __wp.getState() : null; } catch (e) { st = "getState 抛错: " + e.message; }
    return JSON.stringify({ raf: P.raf, lost: P.lost, restored: P.restored, ctxType: P.ctxType,
      contexts: (P.contexts || []).length, contextList: (P.contexts || []).slice(0, 6),
      losses: P.losses || [],
      warns: (P.warns || []).slice(-6), errors: (P.errors || []).slice(-4), diag: (P.diag || []).slice(-4), st }); })()`;

async function shotHash(session) {
  const data = await session.screenshot({ format: "png" });
  return createHash("sha1").update(data).digest("hex").slice(0, 12);
}

/** 测 rAF 每秒回调数 —— 引擎循环停掉后这个数会明显下降（页面里还有别的 rAF 消费者）。 */
async function rafRate(session, windowMs) {
  const a = await session.evaluate("window.__glProbe.raf");
  await sleep(windowMs);
  const b = await session.evaluate("window.__glProbe.raf");
  return +(((b - a) * 1000) / windowMs).toFixed(1);
}

async function main() {
  const url =
    `${ORIGIN}/renderer/index.html?type=scene&src=${ITEM}` +
    `&mediaBase=${encodeURIComponent(ORIGIN + "/media/dev")}` +
    `&fit=cover&renderDpr=1&sceneFps=60&aa=off&pq=high&pp=high&muted=true&loop=true`;

  const session = await launchHeadless({ url: "about:blank", task: "probe-gl", width: 1280, height: 720 });
  const report = { item: ITEM, url };
  try {
    instrument(session);
    await session.pageCdp.send("Page.addScriptToEvaluateOnNewDocument", { source: INIT });
    await session.pageCdp.send("Page.navigate", { url });
    report.gpu = (await session.assertGpu()).renderer;
    await session.waitFor("window.__glProbe && __glProbe.ctx && window.__wp", { timeoutMs: 45000 });
    await sleep(2500); // 让动画与脚本稳定

    // ── M3 验收：GL 资源登记表（创建 → 计数非零；dispose → 归零）──
    // 直接 import 引擎模块自建一个渲染器，绕开壁纸页（页面不暴露 renderer 实例）。
    report.m3Registry = JSON.parse(
      await session.evaluate(
        `(async () => {
          const m = await import("/renderer/vendor/we-scene/render/renderer.js");
          const c = document.createElement("canvas");
          c.width = 320; c.height = 180;
          const r = m.createRenderer(c, { diag: () => {} });
          const created = r.glStats ? r.glStats() : null;
          let err = null;
          try { r.dispose(); } catch (e) { err = String(e && e.message); }
          const after = r.glStats ? r.glStats() : null;
          return JSON.stringify({ created, after, err });
        })()`,
        { awaitPromise: true },
      ),
    );

    // 对照：丢失前连拍两张（动画在跑 → 两张应不同），并测 rAF 速率
    const t0 = await shotHash(session);
    const rateBefore = await rafRate(session, 1500);
    const t1 = await shotHash(session);
    report.control = { t0, t1, animated: t0 !== t1, rafPerSecBefore: rateBefore, state: JSON.parse(await session.evaluate(state())) };

    // 强制上下文丢失 —— 按**面积**点名主画布：页面里还有嗅探/缩略图用的小画布，
    // 抓「第一个 webgl 上下文」会打偏（第一轮就踩了），属性也别信（是建完上下文才设的）。
    report.canvases = await session.evaluate(
      `JSON.stringify([...document.querySelectorAll("canvas")].map((c) => ({
        w: c.width, h: c.height,
        attr: c.getAttribute("data-webwallgl"), attrGl: c.getAttribute("data-webwallgl-gl"),
        parent: c.parentElement ? c.parentElement.tagName + (c.parentElement.id ? "#" + c.parentElement.id : "") : null,
      })))`,
    );
    report.loseCall = await session.evaluate(
      `(() => { const main = [...document.querySelectorAll("canvas")].sort((a, b) => b.width * b.height - a.width * a.height)[0];
        if (!main) return "页面里没有 canvas";
        const gl = main.getContext("webgl2");
        if (!gl) return "最大画布拿不到 webgl2";
        const ext = gl.getExtension("WEBGL_lose_context");
        if (!ext) return "无 WEBGL_lose_context 扩展";
        window.__glProbeExt = ext; ext.loseContext();
        return "已对最大画布 " + main.width + "x" + main.height + " 调用 loseContext"; })()`,
    );
    await sleep(1500);
    const t2 = await shotHash(session);
    const rateAfter = await rafRate(session, 1500);
    const t3 = await shotHash(session);
    report.afterLoss = {
      t2,
      t3,
      frozen: t2 === t3,
      rafPerSecAfter: rateAfter,
      state: JSON.parse(await session.evaluate(state())),
    };

    // 浏览器恢复上下文 → 引擎是否重建（预期：不重建，画面仍坏）
    report.restoreCall = await session.evaluate(
      `(() => { const ext = window.__glProbeExt; if (!ext) return "无扩展句柄"; ext.restoreContext(); return "已调用 restoreContext"; })()`,
    );
    await sleep(2500);
    const t4 = await shotHash(session);
    await sleep(1500);
    const t5 = await shotHash(session);
    report.afterRestore = {
      t4,
      t5,
      stillFrozen: t4 === t5,
      changedVsLoss: t4 !== t2,
      state: JSON.parse(await session.evaluate(state())),
    };
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
