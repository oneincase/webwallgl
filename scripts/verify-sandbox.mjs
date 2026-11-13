#!/usr/bin/env node
/**
 * verify-sandbox —— 素材脚本沙箱逃逸向量（M1.4）+ M7(B) 通道收紧判据 + shim 注入抗短路。
 * 三节：一、逃逸向量真行为（子进程 + 硬超时）；二、控制通道/默认档的源码文本判据；
 * 三、shim 注入的真行为判据（合成 HTML 样本 + 逐字节 golden）。
 *
 * ⚠ **本门禁记录已知限制，不是安全保证。**
 *
 * 背景（docs/ENGINE-REVIEW-2026-10.md §2.1）：`renderer/vendor/we-scene/render/text.js`
 * 用 `new Function(...SANDBOX_PARAM_NAMES, 体)` 执行壁纸脚本，宿主全局只靠**形参遮蔽**
 * （window/document/fetch/... 全部传 undefined 或消毒对象，见 text.js 的形参表与
 * `sandboxGlobal`）。Function/eval 无法遮蔽（保留字语义，text.js 自己的注释也写明
 * 「属已知边界：WE 本身也是全信任执行脚本」），于是脚本用 constructor / 间接 eval
 * 就能摸到**真实 globalThis**，之后再拿 `window.__wp`（含宿主能力）、宿主
 * localStorage、父页 DOM 都不是难事。
 *
 * 本门禁把四条向量的**当前真实行为**钉住（2026-10 实测，见下表），任一向量行为
 * 改变——**无论是修好了还是更糟**——断言即红，提示维护者按新行为更新 EXPECT 与
 * docs/COMPLIANCE.md §四：
 *
 *   | 向量     | 脚本形态                                      | 当前行为 | 期望 |
 *   | -------- | --------------------------------------------- | -------- | ---- |
 *   | direct   | 裸 `window` / `fetch` / `globalThis`          | 被遮蔽   | 遮蔽 |
 *   | fnCtor   | `(function(){}).constructor('return this')()` | **逃逸** | 逃逸 |
 *   | arrCtor  | `[].constructor.constructor('return this')()` | **逃逸** | 逃逸 |
 *   | indirEval| `(0,eval)('this')`                            | **逃逸** | 逃逸 |
 *
 * 三条逃逸向量互相独立，堵一条没有意义（ENGINE-REVIEW §2.1）；真正的隔离是方案 A
 * （Worker / 独立 origin，库形态独立里程碑），**未做**。所以本门禁对「逃逸」判绿：
 * 它守的是「形参遮蔽这一层还在、且 we-frame 这条旁路没有被重新接回宿主判活」，
 * 而不是「脚本跑不出去」。
 *
 * 为什么在子进程里跑（PLAN §5 M1 硬规则）：行为面判据必须子进程 + 硬超时。某个
 * 向量将来把 verifier 一起带走（大分配 / 死循环）时，失败要能定位到「哪条向量」，
 * 而不是让门禁无声退出。向量脚本是本文件自造的有限步代码：不读素材库
 * （WE_LIBRARY 不参与）、不联网、不装配 DOM。
 *
 * 用法：
 *   node scripts/verify-sandbox.mjs                # 门禁（父进程断言，红/绿）
 *   node scripts/verify-sandbox.mjs --run-vectors   # 内部：子进程跑向量，打印一行 JSON
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker, ROOT, imp } from "./lib/verify-kit.mjs";

/** 单次向量运行的硬超时（M1：行为面判据必须能被超时掐断） */
const VECTOR_TIMEOUT_MS = 20000;

/**
 * 四条向量。`flag` 是脚本企图写到**真实全局**上的标记名 —— 父进程据此判定逃逸：
 * 标记出现在真实 globalThis 上＝逃逸成功；只有消毒对象被写＝被遮蔽。
 * `shared` 参数（evalTextScript 的 opts.shared → 脚本的 shared 形参）是唯一合法的
 * 读数通道，用它把「沙箱内部看到的类型」带出来。
 */
const VECTORS = [
  {
    name: "direct",
    flag: "__sbxDirect",
    expect: "blocked",
    what: "裸 window / fetch / globalThis",
    script: [
      "function update() {}",
      "try {",
      "  globalThis.__sbxDirect = true;",
      "  window.__sbxDirect = true;",
      '  shared.types = typeof window + "|" + typeof fetch + "|" + (window === globalThis) + "|" + typeof window.document;',
      "} catch (e) { shared.err = String(e); }",
    ].join("\n"),
  },
  {
    name: "fnCtor",
    flag: "__sbxFnCtor",
    expect: "escapes",
    what: "(function(){}).constructor('return this')()",
    script: [
      "function update() {}",
      "try {",
      '  var g = (function(){}).constructor("return this")();',
      "  g.__sbxFnCtor = true;",
      "} catch (e) { shared.err = String(e); }",
    ].join("\n"),
  },
  {
    name: "arrCtor",
    flag: "__sbxArrCtor",
    expect: "escapes",
    what: "[].constructor.constructor('return this')()",
    script: [
      "function update() {}",
      "try {",
      '  var g = [].constructor.constructor("return this")();',
      "  g.__sbxArrCtor = true;",
      "} catch (e) { shared.err = String(e); }",
    ].join("\n"),
  },
  {
    name: "indirEval",
    flag: "__sbxIndirEval",
    expect: "escapes",
    what: "(0,eval)('this')",
    script: [
      "function update() {}",
      "try {",
      '  var g = (0,eval)("this");',
      "  g.__sbxIndirEval = true;",
      "} catch (e) { shared.err = String(e); }",
    ].join("\n"),
  },
];

/** 子进程：逐条跑向量，把「真实全局有没有被写」带回父进程。 */
async function runVectors() {
  const { evalTextScript } = await imp("renderer/vendor/we-scene/render/text.js");
  const out = {};
  for (const v of VECTORS) {
    const shared = {};
    delete globalThis[v.flag];
    let gotHandle = false;
    let err = null;
    try {
      // evalTextScript 返回沙箱句柄（或 null）；顶层的逃逸代码在求值时就会跑，
      // 所以「句柄为 null」不影响本判据，只作为诊断带回去。
      gotHandle = evalTextScript(v.script, {}, { shared }) !== null;
    } catch (e) {
      err = String((e && e.message) || e);
    }
    out[v.name] = {
      reached: globalThis[v.flag] === true,
      gotHandle,
      shared,
      err,
    };
  }
  console.log("VECTORS_JSON " + JSON.stringify(out));
}

if (process.argv[2] === "--run-vectors") {
  await runVectors();
  process.exit(0);
}

const { check, errors } = createChecker();

// ── 一、M1.4：四条向量的当前真实行为 ────────────────────────────────────────
const self = fileURLToPath(import.meta.url);
const r = spawnSync(process.execPath, [self, "--run-vectors"], {
  encoding: "utf8",
  timeout: VECTOR_TIMEOUT_MS,
});
const stdout = String(r.stdout || "");
const stderrTail = String(r.stderr || "")
  .trim()
  .split("\n")
  .slice(-3)
  .join(" | ")
  .slice(0, 500);

const timedOut = r.error?.code === "ETIMEDOUT" || r.signal === "SIGTERM";
check(
  r.status === 0 && !timedOut,
  `向量子进程必须干净退出（实得 status=${r.status} signal=${r.signal || "-"}${timedOut ? " 超时" : ""}${stderrTail ? ` stderr: ${stderrTail}` : ""}）`,
);

const jsonLine = stdout.split("\n").find((l) => l.startsWith("VECTORS_JSON "));
let measured = null;
if (jsonLine) {
  try {
    measured = JSON.parse(jsonLine.slice("VECTORS_JSON ".length));
  } catch (e) {
    check(false, `向量子进程输出不是合法 JSON（${(e && e.message) || e}）`);
  }
}
check(!!measured, "向量子进程必须回报 VECTORS_JSON（无输出＝没跑起来）");

if (measured) {
  for (const v of VECTORS) {
    const m = measured[v.name];
    if (!m) {
      check(false, `缺少向量 ${v.name} 的实测结果`);
      continue;
    }
    if (v.expect === "blocked") {
      // 控制组：形参遮蔽必须真的生效 —— 这一条红了说明遮蔽层破了（比逃逸更严重）。
      check(
        m.reached === false,
        `${v.name}（${v.what}）应被形参遮蔽，实测**写到了真实全局** —— 遮蔽层已破`,
      );
      check(
        m.shared?.types === "object|undefined|true|undefined",
        `${v.name} 沙箱内类型应形如 "object|undefined|true|undefined"（window 是消毒对象、fetch 为 undefined、非真实全局），实得 ${JSON.stringify(m.shared?.types)}`,
      );
      continue;
    }
    // 逃逸组：**当前行为就是逃逸**（已知限制）。修好之后这里会变红，那是要更新
    // EXPECT + docs/COMPLIANCE.md §四 的信号，不是「回归」——照提示改表即可。
    check(
      m.reached === true,
      `已知限制已被改变：${v.name}（${v.what}）**不再**逃逸。若确已修好，请把本文件 EXPECT 改为 "blocked"，并同步更新 docs/COMPLIANCE.md §四的已知限制段`,
    );
  }

  const escapes = VECTORS.filter((v) => v.expect === "escapes" && measured[v.name]?.reached).map(
    (v) => v.name,
  );
  if (escapes.length) {
    console.log(
      `  ⚠ 已知限制（非回归）：${escapes.join(" / ")} 共 ${escapes.length} 条向量仍可逃出形参遮蔽，` +
        `可达真实 globalThis / window.__wp / 宿主 localStorage —— 隔离（方案 A）未做，见 docs/COMPLIANCE.md §四`,
    );
  }
}

// ── 二、M7(B+C)：通道收紧与默认档（文本判据，只证形状存在，不证行为正确）────────
const webTs = fs.readFileSync(join(ROOT, "renderer/src/web.ts"), "utf8");
const shimSrc = fs.readFileSync(join(ROOT, "renderer/src/web-shim.js"), "utf8");

// C1：控制通道的发送方必须是父页（宿主），不能只看载荷自带的 __we 标记。
check(
  /if \(ev\.source !== w\.parent\) return;/.test(shimSrc),
  "shim 控制通道必须校验 ev.source === w.parent（此前只看 d.__we===1，页面内任何脚本都能发控制命令）",
);
// C2：宿主主动探针 ping → shim 回 we-pong；判活只认 pong。
check(
  /case "ping":/.test(shimSrc) && /op: "we-pong"/.test(shimSrc),
  "shim 必须实现宿主探针 ping → we-pong（存活判定的唯一依据）",
);
check(
  /postToShim\(rt, "ping", \{ t: performance\.now\(\) \}\)/.test(webTs) &&
    /data\.op === "we-pong"/.test(webTs),
  "web.ts 必须主动发探针并对 pong 打点（宿主发问、页面应答才算活）",
);
// C2：we-frame 是页面自报（可伪造）→ 只进遥测，不进宿主帧率计。
check(
  /if \(data\.op !== "we-frame"\) return;[\s\S]{0,300}markWebFrame\(rt, recv\);/.test(webTs) &&
    !/if \(data\.op !== "we-frame"\) return;[\s\S]{0,300}markFrame\(rt, recv\);/.test(webTs),
  "we-frame 分支只更新遥测（markWebFrame），不得 push 宿主 frameMeter（否则伪造 we-frame 可让自适应降档永不触发）",
);
// C3：默认 strict —— 只有显式 legacy 才回到 allow-same-origin。
check(
  /function webSandboxIsStrict/.test(webTs) &&
    /cfg\.webSandbox !== "legacy"/.test(webTs) &&
    !/cfg\.webSandbox === "strict"/.test(webTs),
  '网页壁纸默认 strict（cfg.webSandbox !== "legacy"）：三处 attachIframe 都走同一判定',
);
// issue #21：上面的判定消费的是 cfg.webSandbox，而公共 API 的配置在
// resolveMountConfig 里重建白名单 —— 漏掉 webSandbox 时 legacy 永远到不了
// web.ts（内层 iframe 只剩 allow-scripts，Origin: null，同源素材 401）。
{
  const apiMountTs = fs.readFileSync(join(ROOT, "renderer/src/api/mount.ts"), "utf8");
  check(
    /webSandbox: o\.webSandbox/.test(apiMountTs),
    "公共 API resolveMountConfig 必须原样透传 webSandbox（issue #21）",
  );
}

// ── 三、shim 注入不可被素材短路（真行为；合成的 HTML 样本，不碰 LIB/网络/DOM）──────
//
// 旧判据是「整篇 HTML 里出现过 data-we-shim」的存在性匹配 —— 属性名是**素材可控字符串**，
// 注释 / meta content / 作者脚本正文里的一句 querySelector 都能命中，命中即不注入，而且
// **静默**：shim 是 rAF 节流、指针桥、音频泵、种子脚本的载体，少了它宿主只看到「帧率不
// 设限、指针不响应」，没有任何报错。下面三条样本改前实测均被短路（见 web-rewrite.ts 的
// SHIM_TAG_RE 注释）。
//
// 前两组是**逐字节等价**断言：golden 取自改动前的实现 —— A/B 探针对 9 个正常样本做过
// 改前/改后逐字节 diff（全等），所以这里同时钉住「修掉短路漏洞」与「不误伤正常素材」。
const { rewriteHtml } = await imp("renderer/src/web-rewrite.ts");
const WWBX_SHIM = "window.__WWSBX_SHIM=1;";
const WWBX_SEED = "window.__WWSBX_SEED=1;";
const WWBX_BH = "https://cdn.example/wp/";
const wwbx = (html, opts) => rewriteHtml(html, WWBX_SHIM, opts);

// golden：正常素材（有 <head>、作者脚本、需要补 <base>）
const goldenHead =
  `<!DOCTYPE html><html><head><base href="${WWBX_BH}">` +
  `<script data-we-shim-src="1">\n${WWBX_SHIM}\n</script>` +
  `<title>t</title>\n<script>author()</script>\n</head><body>hi</body></html>`;
check(
  wwbx(`<!DOCTYPE html><html><head><title>t</title>\n<script>author()</script>\n</head><body>hi</body></html>`, { baseHref: WWBX_BH }) ===
    goldenHead,
  "正常素材（head + 作者脚本 + 补 base）的注入结果必须与改动前逐字节相同",
);
// golden：裸片段（无 head/html）→ 整段包裹 + shim 与 seed 都在作者脚本之前
const goldenBare =
  `<!DOCTYPE html><html><head><base href="https://x/a/">` +
  `<script data-we-shim-src="1">\n${WWBX_SHIM}\n</script>` +
  `<script>\n${WWBX_SEED}\n</script></head><body><script>author()</script></body></html>`;
check(
  wwbx(`<script>author()</script>`, { baseHref: "https://x/a/", seedScript: WWBX_SEED }) === goldenBare,
  "裸片段素材的包裹结果必须与改动前逐字节相同（shim 与 seed 都在作者脚本之前）",
);
// 幂等：注入过的结果再跑一次不得变成两套 shim（verify-web 也钉这条，此处覆盖改后判据）
check(wwbx(goldenHead, { baseHref: WWBX_BH }) === goldenHead, "已注入的 HTML 再跑一次必须幂等（不得出现第二套 shim）");
// 宿主已注入 shim（data-we-shim="host"）：仍不重复注入，且 <base> 照补
const hostHtml = `<!doctype html><html><head><script data-we-shim="host">/*host shim*/</script></head><body>x</body></html>`;
const hostOut = wwbx(hostHtml, { baseHref: WWBX_BH, seedScript: WWBX_SEED });
check(
  (hostOut.match(/data-we-shim/g) || []).length === 1 &&
    !hostOut.includes(WWBX_SHIM) &&
    hostOut.includes(`<base href="${WWBX_BH}">`),
  '宿主已注入的 data-we-shim="host" 必须被识别（不重复注入、<base> 照补）—— dsh 宿主 /scene-files 互操作契约',
);
// 红线三条：伪造标记不得再短路注入
for (const [name, html] of [
  ["注释里的属性名", `<!-- data-we-shim --><html><head><script>a()</script></head></html>`],
  ["meta content 里的属性名", `<html><head><meta name="x" content="data-we-shim-src=1"><script>a()</script></head></html>`],
  ["作者脚本正文里的属性名", `<html><head><script>if(document.querySelector('[data-we-shim]'))x()</script></head></html>`],
]) {
  check(
    wwbx(html, { baseHref: WWBX_BH }).includes(WWBX_SHIM),
    `伪造标记（${name}）不得短路 shim 注入 —— 命中即静默失效，宿主侧没有任何报错`,
  );
}
// 作者把脚本放在 <head> 之前：解析器会把它提前进 head，必须先注 shim（否则它先跑并置
// window.__weShimInstalled，我们的 shim 整体 return，等于没注入）
for (const [name, html] of [
  ["doctype 之后、html 之前", `<!doctype html><script>window.__weShimInstalled=1</script><html><head><title>t</title></head><body>x</body></html>`],
  ["html 之内、head 之前", `<!doctype html><html><script>window.__weShimInstalled=1</script><head><title>t</title></head></html>`],
]) {
  const out = wwbx(html, { baseHref: WWBX_BH });
  check(
    out.indexOf(WWBX_SHIM) >= 0 && out.indexOf("__weShimInstalled") > out.indexOf(WWBX_SHIM),
    `作者脚本在 <head> 之前（${name}）时 shim 必须仍在它之前（否则作者可先置 __weShimInstalled 让注入静默失效）`,
  );
}

// 注释形态（task-16）：「整篇文档里出现过属性名」已经堵住，但**注释里包着的完整 shim 元素**仍会让
// SHIM_TAG_RE 命中 ⇒ 不注入。注释内容浏览器**不解析、不执行**，所以作者把标记写进注释就能关掉
// rAF 节流 / 指针桥 / 音频泵 / 种子脚本，且宿主侧没有任何诊断 —— 这正是 M7 §2.3 第 4 条禁掉的
// 形态。修法是判重与选点前先把注释整段置空（blankHtmlComments，等长空格，输出字节不变）。
const wwbxCommentShim = `<!-- <script data-we-shim-src="1"></script> --><html><head><script>a()</script></head></html>`;
const wwbxCommentTwin = `<html><head><script>a()</script></head></html>`;
const wwbxCommentedOut = wwbx(wwbxCommentShim, { baseHref: WWBX_BH });
const wwbxTwinOut = wwbx(wwbxCommentTwin, { baseHref: WWBX_BH });
check(
  wwbxCommentedOut.includes(WWBX_SHIM),
  "注释里包着的 shim 元素不得短路注入（注释不解析 ≠ 已注入）",
);
check(
  wwbxCommentedOut.replace(`<!-- <script data-we-shim-src="1"></script> -->`, "") === wwbxTwinOut,
  "注释形态样本去掉注释后必须与「无注释的同内容样本」逐字节相同（插入点不受注释里的 <script> 影响）",
);
// 注释里的 <head>/<script> 不是真锚点：注进注释区间会被浏览器一起吞掉（等于没注入，且更隐蔽）
const wwbxCommentedHead = wwbx(`<!-- <head> --><html><body><script>a()</script></body></html>`, {
  baseHref: WWBX_BH,
});
check(
  wwbxCommentedHead.indexOf(WWBX_SHIM) > wwbxCommentedHead.indexOf("-->"),
  "注释里的 <head> 不是插入锚点（shim 不得落在注释区间内）",
);
// 未闭合注释（浏览器语义 = 吞到文档末尾）与 IE 条件注释同样不得短路注入
for (const [name, html] of [
  ["未闭合注释", `<!-- <script data-we-shim-src="1"></script><html><head><script>a()</script></head></html>`],
  ["IE 条件注释", `<!--[if IE]><script data-we-shim-src="1"></script><![endif]--><html><head><script>a()</script></head></html>`],
]) {
  check(
    wwbx(html, { baseHref: WWBX_BH }).includes(WWBX_SHIM),
    `注释形态（${name}）不得短路注入`,
  );
}
// 反面：注释里的假 shim + 真实宿主 shim 同时在场 ⇒ 仍须只认真 shim（不得因剥注释而多注一套）
check(
  !wwbx(`<!-- <script data-we-shim-src="1"></script> --><html><head><script data-we-shim="host">/*h*/</script></head></html>`, {
    baseHref: WWBX_BH,
  }).includes(WWBX_SHIM),
  "注释里的假 shim + 真实宿主 shim：仍须只认真 shim（不重复注入）",
);

if (errors.length) {
  console.error(`verify-sandbox: ${errors.length} 项失败`);
  for (const e of errors) console.error("  ✗", e);
  process.exit(1);
}
console.log("verify-sandbox: ok");
