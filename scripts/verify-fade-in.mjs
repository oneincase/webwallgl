#!/usr/bin/env node
/**
 * verify-fade-in —— 渲染过程渐显（3.1 特性）判据。
 *
 * 语义（用户拍板）：默认关；开启后加载期起**预览循环**直接 renderer.render
 * 「边加载边画已就绪图层」，画布 opacity 按「已完成贴图 job / 总 job」线性推进，
 * 终点 = 资源全部就绪（首帧时刻）；失败/降级出口必须还原可见。
 *
 * 三层判据（沿用仓内纪律）：
 *   §A 纯函数行为：esbuild 真编译 fade-in.ts 跑 fadeOpacityOf / countJobSettle
 *      （含 reject 计数与语义透传）——不是文本匹配。
 *   §B 接线断言：scene-mount 渐显块（闸门/预览/停摆/首帧清理/catch 还原/函数级
 *      声明）、resolveMountConfig 白名单透传（#20 的同类坑）、main.ts query、
 *      两个类型面字段。
 *   §C 变异红测：内存里改坏源码（默认开、去透传、去 catch 还原、去停摆、
 *      去首帧清理），对应断言必须转红。
 *   §D --headless：真浏览器行为臂（vite + Chrome）——?fadein=1 下加载期必须观测到
 *      0 < opacity < 1 的中间态、就绪后内联样式交回自然态、fps>0；不带参数的
 *      对照臂全程 opacity 内联为空串（默认关 = 零行为变化）。不在稳定集默认路径。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, imp, createChecker } from "./lib/verify-kit.mjs";

const { check, errors } = createChecker();
const argv = process.argv.slice(2);

// ---------------------------------------------------------------- §A 纯函数行为
console.log("verify-fade-in: [A] 纯函数行为（esbuild 真编译）");
{
  const esbuild = await import("esbuild");
  const src = fs.readFileSync(path.join(ROOT, "renderer/src/fade-in.ts"), "utf8");
  const out = await esbuild.transform(src, { loader: "ts", format: "esm", target: "es2022" });
  const tmp = path.join(os.tmpdir(), `verify-fade-in-${process.pid}.mjs`);
  fs.writeFileSync(tmp, out.code);
  let mod = null;
  try {
    mod = await import(pathToFileURL(tmp).href + `?t=${Date.now()}`);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }
  }
  check(mod && typeof mod.fadeOpacityOf === "function", "[A] fade-in.ts 必须导出 fadeOpacityOf");
  if (mod) {
    const { fadeOpacityOf, countJobSettle } = mod;
    check(fadeOpacityOf(0, 0) === 1, "[A] total=0（无贴图壁纸没有空档期）必须立即完全可见");
    check(fadeOpacityOf(0, 10) === 0, "[A] 0/10 = 0");
    check(fadeOpacityOf(3, 10) === 0.3, "[A] 3/10 线性 = 0.3");
    check(fadeOpacityOf(10, 10) === 1, "[A] 10/10 = 1（终点=全部就绪）");
    check(fadeOpacityOf(11, 10) === 1, "[A] 越界夹到 1");
    check(fadeOpacityOf(-1, 10) === 0, "[A] 负数夹到 0");
    check(fadeOpacityOf(NaN, 10) === 1 && fadeOpacityOf(1, NaN) === 1, "[A] 非有限输入按 1 处理（坏计数不许把壁纸永久藏起来）");
    check(fadeOpacityOf(1, 0) === 1 && fadeOpacityOf(1, -5) === 1, "[A] total<=0 一律 1");

    // countJobSettle：完成与失败都要计数（漏计 opacity 永远到不了 1），rejection 语义原样透传。
    const jobs = [
      Promise.resolve("a"),
      Promise.reject(new Error("boom")),
      new Promise((r) => setTimeout(() => r("c"), 10)),
    ];
    let done = 0;
    const wrapped = countJobSettle(jobs, () => { done++; });
    check(Array.isArray(wrapped) && wrapped.length === 3, "[A] countJobSettle 返回同长数组");
    let allRejected = false;
    try { await Promise.all(wrapped); } catch { allRejected = true; }
    check(allRejected, "[A] 任一 job 失败 Promise.all 必须照旧 reject（不得吞错改语义）");
    await new Promise((r) => setTimeout(r, 30));
    check(done === 3, `[A] 三个 job（含失败的那个）都必须计数，实得 ${done}`);
    // 关闭渐显时不经过这条路径：原数组恒等（零行为变化）由 §B 源码断言钉。
  }
}

// ---------------------------------------------------------------- §B 接线断言
console.log("verify-fade-in: [B] 接线断言（scene-mount / api 白名单 / query / 类型面）");
const smSrc = fs.readFileSync(path.join(ROOT, "renderer/src/scene-mount.ts"), "utf8");
const mountApiSrc = fs.readFileSync(path.join(ROOT, "renderer/src/api/mount.ts"), "utf8");
const mainSrc = fs.readFileSync(path.join(ROOT, "renderer/src/main.ts"), "utf8");
const typesSrc = fs.readFileSync(path.join(ROOT, "renderer/src/types.ts"), "utf8");
const apiTypesSrc = fs.readFileSync(path.join(ROOT, "renderer/src/api/types.ts"), "utf8");

/** scene-mount 接线断言。sink 默认进全局 errors；变异红测传局部 sink。 */
function assertWiring(src, label, sink = check) {
  // 1) 默认关：闸门必须是 === true（不是 !== false —— 后者会把 undefined 当开）
  sink(/const fadeOn = cfg\.fadeIn === true;/.test(src), `${label}：渐显闸门必须是 cfg.fadeIn === true（默认关；!== false 会变成默认开）`);
  // 2) 关闭时零行为变化：不包 job（恒等透传）
  sink(/const fadeStaged = fadeTestDelayMs > 0[\s\S]{0,300}: texJobs;/.test(src) && /fadeOn \? countJobSettle\(fadeStaged, \(\) => \{ fadeDone\+\+; \}\) : texJobs/.test(src), `${label}：关闭渐显时 await 的必须是**原 texJobs**（不包计数、不包延时、不改 settle 语义）`);
  // 3) await 的必须是包装后的集合
  sink(/await Promise\.all\(texJobsSettled\);/.test(src), `${label}：await 必须落在带完成计数的集合上`);
  // 4) 预览循环走 renderer.render（真渲染器，不是自造预览管线）；且不动 onFirstFrame
  const cut = src.indexOf("await Promise.all(texJobsSettled)");
  const fadeBlock = src.slice(src.indexOf("const fadeOn = cfg.fadeIn === true"), cut);
  sink(/renderer\.render\(/.test(fadeBlock), `${label}：预览帧必须直接调 renderer.render（provider 判空跳过 = 边加载边画的机制来源）`);
  sink(/c\.style\.opacity = String\(fadeOpacityOf\(fadeDone, fadeTotal\)\)/.test(fadeBlock), `${label}：opacity 必须由 fadeOpacityOf(完成,总数) 驱动`);
  sink(!/rt\.onFirstFrame = /.test(fadeBlock), `${label}：预览循环不得动 onFirstFrame（首帧语义只属于真循环）`);
  // 5) 停摆先于后续装配（handover 原子性）：fadeStop 在 await 之后、bindPendingInstanceMedia 之前
  const after = src.slice(cut);
  const stopIdx = after.indexOf("fadeStop?.()");
  const bindIdx = after.indexOf("bindPendingInstanceMedia()");
  sink(stopIdx >= 0 && bindIdx > stopIdx, `${label}：预览循环必须在 Promise.all 返回后、后续装配前停摆`);
  // 6) 终点 = 首帧：真循环首帧清内联样式交回自然态（包 onFirstFrame，不改 renderLoopImpl 语义）
  sink(/const fadeFirst = rt\.onFirstFrame;[\s\S]{0,240}c\.style\.opacity = "";[\s\S]{0,120}fadeFirst\?\.\(\);/.test(src), `${label}：真循环首帧必须清内联样式并链回原 onFirstFrame（mount() 契约不变）`);
  // 7) 失败出口还原：catch 里 fadeRestore 必须在 disposed/AbortError 早退**之前**
  sink(src.indexOf("fadeRestore?.();\n      if (disposed) return;") >= 0, `${label}：外层 catch 必须在最前还原可见性（放在 disposed 早退之后就漏了）`);
  // 8) fadeRestore 声明在函数级（try 内声明 catch 够不着）
  sink(/let disposed = false;[\s\S]{0,240}let fadeRestore: \(\(\) => void\) \| null = null;/.test(src), `${label}：fadeRestore 必须声明在函数级（catch 可见）`);
}

/** api/query 接线断言（#20 的同类坑：白名单漏字段 = 特性永远开不了）。 */
function assertWiringApi(mountSrc, mainSrc2, sink = check, label = "[B] api 接线") {
  sink(/fadeIn: o\.fadeIn,/.test(mountSrc), `${label}：resolveMountConfig 白名单必须透传 fadeIn（#20 同类坑）`);
  sink(/fadeIn: params\.get\("fadein"\) === "1" \|\| params\.get\("fadein"\) === "true"/.test(mainSrc2), `${label}：main.ts 必须解析 ?fadein=1/true（默认关）`);
}

assertWiring(smSrc, "[B] scene-mount");
assertWiringApi(mountApiSrc, mainSrc);
check(/fadeIn\?: boolean;/.test(typesSrc), "[B] WallpaperConfig 必须有 fadeIn");
check(/fadeIn\?: boolean;/.test(apiTypesSrc), "[B] MountOptions 必须有 fadeIn");

/** 测试台（编辑器「渲染→画质」区）开关接线：DOM 控件 → 面板持久化 → mountOptions → 重挂。 */
function assertWiringEditor(html, rs, edMain, i18nSrc, sink = check, label = "[B] 测试台开关") {
  sink(/id="fadein"/.test(html), `${label}：index.html 必须有渐显勾选控件`);
  // 真机探针抓到的形态：data-i18n 键**没注册**时 i18n 会把文本覆盖成键名本身
  // （界面直接显示 "toolbar.fade"），不是保留字面兜底 —— 两套词典都必须有键。
  const fadeKeys = (i18nSrc.match(/"toolbar\.fade":/g) || []).length;
  const tipKeys = (i18nSrc.match(/"toolbar\.fadeTip":/g) || []).length;
  sink(fadeKeys >= 2, `${label}：toolbar.fade 必须在中英两套词典都注册（实得 ${fadeKeys}；未注册=界面显示键名）`);
  sink(tipKeys >= 2, `${label}：toolbar.fadeTip 必须中英两套都注册（实得 ${tipKeys}）`);
  sink(/fadeIn: o\.fadeIn\.checked,/.test(rs), `${label}：mountOptions 必须带 fadeIn（漏了开关就是摆设）`);
  sink(/o\.fadeIn\.onchange[\s\S]{0,160}saveRender\(\);[\s\S]{0,80}onFadeChange\?\.\(\);/.test(rs),
    `${label}：勾选变化必须 存档+触发重挂（渐显无热更通道，不重挂用户看不到反馈）`);
  sink(/fadeIn: \$\("#fadein"\)/.test(edMain), `${label}：main.ts 必须把控件接进 mountRenderSettings`);
  sink(/onFadeChange: \(\) => \{[\s\S]{0,120}mountCurrent\(true\)/.test(edMain),
    `${label}：重挂必须走 mountCurrent(true)（keepTime：不跳回第一帧）`);
}
const edHtmlSrc = fs.readFileSync(path.join(ROOT, "editor/index.html"), "utf8");
const edRsSrc = fs.readFileSync(path.join(ROOT, "editor/ui/render-settings.ts"), "utf8");
const edMainSrc = fs.readFileSync(path.join(ROOT, "editor/main.ts"), "utf8");
const edI18nSrc = fs.readFileSync(path.join(ROOT, "bench/i18n.ts"), "utf8");
assertWiringEditor(edHtmlSrc, edRsSrc, edMainSrc, edI18nSrc);

// ---------------------------------------------------------------- §C 变异红测
console.log("verify-fade-in: [C] 变异红测（改坏必红，局部 sink 不污染全局）");
{
  const muts = [
    {
      name: "默认开（!== false）",
      target: "sm",
      apply: (x) => x.replace("const fadeOn = cfg.fadeIn === true;", "const fadeOn = cfg.fadeIn !== false;"),
      recheck: (x, l, sink) => assertWiring(x, l, sink),
    },
    {
      name: "白名单漏 fadeIn（#20 复发）",
      target: "mount",
      apply: (x) => x.replace("fadeIn: o.fadeIn,", ""),
      recheck: (x, l, sink) => assertWiringApi(x, mainSrc, sink, l),
    },
    {
      name: "catch 不还原（失败留透明）",
      target: "sm",
      apply: (x) => x.replace("fadeRestore?.();\n      if (disposed) return;", "if (disposed) return;"),
      recheck: (x, l, sink) => assertWiring(x, l, sink),
    },
    {
      name: "handover 不停摆（双循环）",
      target: "sm",
      apply: (x) => x.replace("fadeStop?.();\n        c.style.opacity = \"1\";", "c.style.opacity = \"1\";"),
      recheck: (x, l, sink) => assertWiring(x, l, sink),
    },
    {
      name: "首帧不清内联样式",
      target: "sm",
      apply: (x) => x.replace(
        "c.style.opacity = \"\";\n          c.style.transition = \"\";\n          fadeFirst?.();",
        "fadeFirst?.();",
      ),
      recheck: (x, l, sink) => assertWiring(x, l, sink),
    },
    {
      name: "测试台开关不进 mountOptions",
      target: "rs",
      apply: (x) => x.replace("fadeIn: o.fadeIn.checked,", ""),
      recheck: (x, l, sink) => assertWiringEditor(edHtmlSrc, x, edMainSrc, edI18nSrc, sink, l),
    },
    {
      name: "测试台勾选不重挂（开关成哑的）",
      target: "rs",
      apply: (x) => x.replace("o.onFadeChange?.();", ""),
      recheck: (x, l, sink) => assertWiringEditor(edHtmlSrc, x, edMainSrc, edI18nSrc, sink, l),
    },
    {
      name: "i18n 键没注册（界面显示键名，真机探针抓过的形态）",
      target: "i18n",
      apply: (x) => x.replace('"toolbar.fade": "渐显",\n', "").replace('"toolbar.fade": "Fade in",\n', ""),
      recheck: (x, l, sink) => assertWiringEditor(edHtmlSrc, edRsSrc, edMainSrc, x, sink, l),
    },
  ];
  for (const m of muts) {
    const base = m.target === "mount" ? mountApiSrc : m.target === "rs" ? edRsSrc : m.target === "i18n" ? edI18nSrc : smSrc;
    const mutated = m.apply(base);
    if (mutated === base) {
      check(false, `[C] 变异「${m.name}」没有命中源码（判据失去牙齿）`);
      continue;
    }
    const reds = [];
    m.recheck(mutated, `[C:${m.name}]`, (cond, msg) => { if (!cond) reds.push(msg); });
    check(reds.length > 0, `[C] 变异「${m.name}」必须让对应断言转红`);
  }
}

// ---------------------------------------------------------------- §D 真机行为臂
if (argv.includes("--headless")) {
  console.log("verify-fade-in: [D] 真浏览器行为臂（vite + Chrome）");
  const net = await import("node:net");
  const { createServer } = await import("vite");
  const port = await new Promise((res) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
  });
  const server = await createServer({
    root: ROOT,
    configFile: path.join(ROOT, "vite.config.ts"),
    server: { port, host: "127.0.0.1", strictPort: true, open: false },
    logLevel: "error",
  });
  await server.listen();
  const origin = `http://127.0.0.1:${port}`;
  const { instrument, launchHeadless } = await imp("scripts/headless-gpu.mjs");
  const session = await launchHeadless({ width: 1280, height: 720, task: "fade-in" });
  // newPage/screenshot 由 instrument() 挂到 session 上（launchHeadless 本体不带）
  instrument(session, { width: 1280, height: 720 });
  // 挑一张贴图多、加载窗口长的场景壁纸（渐显中间态要能被 60ms 轮询抓到）。
  // **按候选表扫本机库取第一张真实存在且 pkg ≥80MB 的**：库会被重同步（3819697503
  // 就消失过，§D 曾因写死 ID 拿到 404 假失败），前置条件必须自检而不是信仰。
  const LIB_DIR = process.env.WE_LIBRARY || path.join(os.homedir(), "Library/Application Support/io.github.oneincase.wallpaperem/wallpapers");
  const candidates = ["3815033574", "3816877839", "3611439897", "3819697503", "2902406982"];
  let itemId = null;
  for (const c of candidates) {
    const pkgPath = path.join(LIB_DIR, c, "scene.pkg");
    try { if (fs.statSync(pkgPath).size >= 80 * 1024 * 1024) { itemId = c; break; } } catch { /* 库里没有这张，试下一候选 */ }
  }
  check(itemId !== null, `[D] 本机库必须有候选大壁纸可用作加载窗口（试了 ${candidates.join("/")}）—— 库变了请更新候选表，不是判据该红`);
  if (itemId !== null) {
  const base = `${origin}/renderer/index.html?type=scene&src=${itemId}&fit=cover&renderDpr=1&sceneFps=30&muted=true&loop=true&mediaBase=${encodeURIComponent(`${origin}/media/dev`)}`;

  const sampleOpacity = async (url) => {
    const page = await session.newPage("about:blank");
    // 行为臂不赌语料/bake 缓存的解码时长：用 scene-mount 的测试钩子把 job settle
    // 按序号错峰（60ms × i），窗口拉成秒级 —— 测的是机制（进度驱动 + 闸门），
    // 不是这台 M5 解得快不快。对照臂同样装钩子：证明**不开 fadein 时钩子也不动样式**。
    await page.cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `window.__wwglFadeTestJobDelayMs = 60;`,
    });
    await page.cdp.send("Page.navigate", { url });
    const seen = [];
    let ready = false;
    const t0 = Date.now();
    // 上限 150s：候选是 80MB+ 的大包，冷 bake 缓存首帧可能超一分钟；
    // 45s 曾让 §D 在慢盘上假失败（超时是判据太急，不是特性坏了）。
    while (Date.now() - t0 < 150000) {
      const r = await page.cdp.send("Runtime.evaluate", {
        returnByValue: true,
        expression: `(() => {
          const cv = document.querySelector('canvas');
          const st = cv ? cv.style.opacity : null;
          // ready 必须认「场景真挂上了」：装配失败会挂 canvas 演示页，它的 rAF 也
          // 让 fps>0（本轮实测骗穿过判据）。__scene 只有 mountScene 成功才有。
          const ready = !!(window.__scene && window.__wpStats && window.__wpStats.frame && window.__wpStats.frame().fps > 0);
          return JSON.stringify({ st, ready });
        })()`,
      });
      const v = JSON.parse(r.result.value);
      seen.push(v.st);
      if (v.ready) { ready = true; break; }
      await new Promise((r2) => setTimeout(r2, 60));
    }
    await page.close?.().catch(() => {});
    return { seen, ready };
  };

  // 臂 1：?fadein=1 —— 加载期必须观测到 (0,1) 开区间的中间态；就绪后交回自然态
  // bake=0：把贴图解码留在真窗口里（热 bake 缓存会把 texJobs 窗口压到 <1 帧——
  // 实测 3815033574 热缓存下 2.8s 空档全在 fetch+parse，渐显窗口内没有可观测中间态。
  // 判据测的是窗口本身，不是缓存冷热的运气；覆盖边界见 scene-mount 渐显块注释）。
  const on = await sampleOpacity(`${base}&fadein=1&bake=0`);
  const mid = on.seen.filter((x) => x !== null && parseFloat(x) > 0 && parseFloat(x) < 1);
  check(on.ready, "[D] fadein=1：必须出首帧（fps>0）");
  check(mid.length >= 1, `[D] fadein=1：加载期必须观测到 0<opacity<1 的中间态，实得样本 ${JSON.stringify(on.seen.slice(0, 12))}`);
  const last = on.seen[on.seen.length - 1];
  check(last === "" || last === "1" || last === null, `[D] fadein=1：就绪后内联 opacity 必须交回自然态（""/1），实得 ${JSON.stringify(last)}`);

  // 臂 2：默认关对照 —— 全程不得写内联 opacity（零行为变化）
  const off = await sampleOpacity(base);
  const dirty = off.seen.filter((x) => x !== "" && x !== null);
  check(off.ready, "[D] 对照臂：必须出首帧");
  check(dirty.length === 0, `[D] 默认关必须零行为变化：内联 opacity 全程为空，实得 ${JSON.stringify(dirty.slice(0, 6))}`);
  }

  await session.close();
  await server.close();
}

// ---------------------------------------------------------------- 收尾
if (errors.length) {
  console.error(`verify-fade-in: ${errors.length} 项失败`);
  for (const e of errors) console.error("  ✗", e);
  process.exit(1);
}
console.log("verify-fade-in: ok");
