#!/usr/bin/env node
/**
 * verify-lifecycle —— 实例生命周期与代际（M4）的源码守卫。
 *
 * 依据：docs/ENGINE-REVIEW-2026-10.md §3.3。修的四类洞都是**异步装配路径**上的，
 * 离线跑不出行为（要 DOM + 真装配 + 时序竞态），所以这里守的是**接线**：
 * 把每条规则变成正则断言，删掉任何一条都会红。行为面由
 * `scripts/_probe-review-lifecycle.mjs`（无头、真装配）覆盖，两者互补。
 *
 * 为什么守卫必须先剥注释：第一版 GL 登记守卫没剥，被我自己的解释性注释判红过一次
 * （注释里写了要禁的那个写法）。见 docs/ENGINE-REVIEW-2026-10.md §10 的「判据自身的坑」。
 */
import fs from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = join(fileURLToPath(import.meta.url), "..");
const ROOT = join(here, "..");

let failed = 0;
function check(ok, msg) {
  if (ok) console.log(`  ✓ ${msg}`);
  else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

// 剥注释用**字符串感知**的实现（朴素正则会吞掉字符串里含 /* 的真代码，实测踩过）。
import { stripComments } from "./lib/source-scan.mjs";
const read = (rel) => stripComments(fs.readFileSync(join(ROOT, rel), "utf8"));

console.log("\n[1] 代际令牌：Runtime.gen 由 clear() 自增");
{
  const shell = read("renderer/src/shell.ts");
  check(/gen\?: number;/.test(shell), "Runtime 类型必须声明 gen");
  check(/gen: 0,/.test(shell), "createRuntime 必须初始化 gen: 0");
  check(
    /export function clear\(rt: Runtime\) \{\s*rt\.gen = \(rt\.gen \?\? 0\) \+ 1/.test(shell),
    "clear() 必须**在最前面**自增 rt.gen（后半段会拆画布/iframe，任何在飞的装配体都不该再落地）",
  );
}

console.log("\n[2] mountWeb：两个 await 之后都要核对代际（双 load 孤儿 iframe 的根因）");
{
  const web = read("renderer/src/web.ts");
  check(/const g = rt\.gen;/.test(web), "mountWeb 的异步体必须捕获本代代际");
  const afterProject = /const defaults = await fetchProjectWire\(entry\);\s*\n\s*if \(g !== rt\.gen\) return;/.test(web);
  check(afterProject, "拉完 project wire 之后必须核对代际（否则两代都会 attachIframe）");
  const beforeAttach = /if \(g !== rt\.gen\) \{\s*URL\.revokeObjectURL\(blobUrl\);\s*return;\s*\}/.test(web);
  check(beforeAttach, "blobUrl 创建后、attachIframe 前必须再核对一次，并在放弃时 revoke（否则连内存都留）");
}

console.log("\n[3] SceneInstance：终态 + 代际 + 挂起收尾");
{
  const m = read("renderer/src/api/mount.ts");
  check(/let destroyed = false;/.test(m), "必须有 destroyed 终态标志");
  check(/const isCurrent = \(g: number\) => g === gen && !destroyed;/.test(m), "isCurrent 必须同时看代际与终态");
  check(
    /destroy\(opts\?: \{ releasePkgCache\?: boolean \}\) \{[\s\S]{0,400}?destroyed = true;\s*gen\+\+;/.test(m),
    "destroy() 必须**先**置终态并作废代际，**再**拆运行时（顺序反了会留复活窗口）",
  );
  // 终态语义是**明确拒绝**（不是静默 no-op）：destroy 已清掉 onDiagnostic，库形态下
  // 「no-op + 上报」仍是静默的，所以契约是拒绝 —— 守卫跟着契约走，改回 return 就红。
  const loadGuard =
    /if \(destroyed\) \{[\s\S]{0,400}?throw new Error\("实例已销毁[\s\S]{0,200}?const g = beginGen\(\)[\s\S]{0,300}?await resolveMountConfig[\s\S]{0,300}?if \(destroyed\) \{[\s\S]{0,200}?releaseOwnCanvas\(cfg[\s\S]{0,200}?throw new Error\("实例已销毁[\s\S]{0,200}?if \(!isCurrent\(g\)\) return;/.test(m);
  check(loadGuard, "load() 必须：终态拒绝 → 开新代 → await 后「destroyed 拒绝 + 回收自建画布 / 被取代静默退出」");
  const applyGuard =
    /const applyOptions = async \(o: MountOptions\) => \{[\s\S]{0,300}?throw new Error\("实例已销毁[\s\S]{0,300}?const g = beginGen\(\)[\s\S]{0,300}?if \(!isCurrent\(g\)\) return;/.test(m);
  check(applyGuard, "applyOptions() 同款：终态拒绝 + 开新代 + await 后核对");
  check(/const armFailure = \(g: number\)/.test(m) && /if \(isCurrent\(g\)\) reject\(e\);/.test(m), "armFailure 必须带代际（事件总线是实例级的，旧代失败会误伤新代）");
  check(/const armWatchdog = \(g: number\)/.test(m) && /if \(!isCurrent\(g\)\) return;/.test(m), "armWatchdog 必须带代际（被取代的那代不该再报超时）");
  // 只看代码：正则里**不能**带注释文本（stripComments 会把注释剥掉，带注释的模式永远不匹配
  // —— 这条守卫的第一版就这么错了一次）
  check(
    /const pending = settlePending;\s*settlePending = null;\s*pending\?\.\(\);/.test(m),
    "destroy() 必须收尾挂起的 mount()/load()（否则又变回「既不 resolve 也不 reject」的黑洞）",
  );
  check(/Object\.defineProperty\(err, "instance"/.test(m), "mount() 失败时必须把实例附在 err.instance（看门狗刻意不替调用方销毁，那就得让它拿得到句柄）");
}

console.log("\n[4] 旧代在飞的帧不得触发新代首帧（disposed 与 paused 必须分开）");
{
  for (const [file, tag] of [
    ["renderer/src/scene-mount.ts", "scene-mount"],
    ["renderer/src/media.ts", "media"],
  ]) {
    const src = read(file);
    const idx = src.indexOf("if (disposed) return;");
    const fire = src.indexOf("if (rt.onFirstFrame) {");
    check(idx >= 0 && fire >= 0 && idx < fire, `${tag}：触发 rt.onFirstFrame 之前必须有 disposed 早退`);
    check(
      /if \(disposed \|\| rt\.paused \|\| occlPaused\(rt\)\) return;/.test(src),
      `${tag}：disposed/paused 的合并早退仍在（paused 只是本代停着，首帧仍要落地）`,
    );
  }
}

console.log("\n[5] 画布所有权：建过 GL 的画布一律不复用");
{
  const m = read("renderer/src/api/mount.ts");
  check(/function ensureSceneCanvas\(el: HTMLElement\): HTMLCanvasElement/.test(m), "ensureSceneCanvas 不再有 reuse 捷径参数");
  check(
    /if \(existing\.getAttribute\("data-webwallgl-gl"\) !== "1"\) return existing;\s*existing\.remove\(\);/.test(m),
    "建过 GL 上下文（data-webwallgl-gl=1）的画布必须换新 —— loseContext 异步生效，复用即黑屏",
  );
}

console.log("\n[6] 多实例隔离：探针归属 / 补丁幂等 / 调试钩子门控（§3.4）");
{
  const shell = read("renderer/src/shell.ts");
  // 清理表必须含 2026-10 补的 6 个漏项（实测它们都在往 window 写）
  for (const k of ["__shared", "__effectScripts", "__memStats", "__animEventsFired", "__animEventLog", "__localAssets"]) {
    check(shell.includes(`"${k}"`), `探针清理表必须包含 ${k}`);
  }
  check(/const probeOwner = new Map<string, Runtime>\(\)/.test(shell), "必须有探针归属表（多实例时卸载 A 不该删 B 的调试面）");
  check(
    /if \(probeOwner\.get\(k\) !== rt\) continue;/.test(shell),
    "clearSceneDebugGlobals 必须按归属删（无条件全局 delete 会删掉还活着的实例的探针）",
  );
  check(/export function ownSceneDebugGlobals\(rt: Runtime\)/.test(shell), "必须导出归属登记入口");
  const sm = read("renderer/src/scene-mount.ts");
  check(/ownSceneDebugGlobals\(rt\);/.test(sm), "scene-mount 装配末尾必须登记探针归属");

  // console.warn 补丁：栈顶判定 + 已卸载层透传
  check(/if \(console\.warn === myWarn\) console\.warn = prevWarn;/.test(sm), "console.warn 补丁只在栈顶仍是自己时还原（否则会摘掉别的实例的补丁）");
  check(/if \(disposed\) return prevWarn\(\.\.\.args\);/.test(sm), "已卸载的那层补丁必须透传（不能把别人的日志上报到旧 rt）");

  // 调试钩子门控：三个语义钩子都要过 hooksOn()
  check(
    /const hooksOn = \(\) => \(rt\.debugHooks \?\? rt\.fullscreen\) === true;/.test(sm),
    "必须有 hooksOn（页面形态默认开、库实例默认关）",
  );
  check(/const noMaterialProps = hooksOn\(\) && /.test(sm), "__noMaterialProps 必须过门控");
  check(/if \(hooksOn\(\) && \(globalThis as any\)\.__noBuiltinMatTint\) return;/.test(sm), "__noBuiltinMatTint 必须过门控");
  check(/const patch = hooksOn\(\) \? /.test(sm), "__shaderPatch 必须过门控");
  const m = read("renderer/src/api/mount.ts");
  check(/rt\.debugHooks = o\.debugHooks === true;/.test(m), "库侧必须把 MountOptions.debugHooks 接到 rt（默认关）");
  const ty = read("renderer/src/api/types.ts");
  check(/debugHooks\?: boolean;/.test(ty), "MountOptions 必须暴露 debugHooks");
  check(/fullscreen: opts\?\.fullscreen === true,/.test(shell), "createRuntime 必须把 fullscreen 记在 rt 上（门控的判据）");
}

console.log("\n[7] GL 资源所有权（M3 作用域）：puppet 侧也要能枚举释放");
{
  const mdl = read("renderer/vendor/we-scene/render/mdl.js");
  check(/const liveMeshes = new Set\(\)/.test(mdl), "mdl 的网格缓存是 WeakMap（枚举不出来），必须另存可枚举的 liveMeshes 供释放");
  check(/liveMeshes\.add\(m\)/.test(mdl), "ensureMesh 必须把新建网格登记进 liveMeshes");
  check(
    /dispose\(\) \{[\s\S]{0,600}?gl\.deleteVertexArray\(m\.vao\)[\s\S]{0,300}?gl\.deleteProgram\(prog\)/.test(mdl),
    "mdl 必须提供 dispose（删 VAO/VBO + program）",
  );
  const sm = read("renderer/src/scene-mount.ts");
  check(/thisMdl\.dispose\?\.\(\)/.test(sm), "装配层必须在 sceneCleanup 里调 mdlRenderer.dispose()");
}

console.log(failed === 0 ? "\nverify-lifecycle: 全部通过 ✓" : `\nverify-lifecycle: ${failed} 项失败 ✗`);
process.exit(failed === 0 ? 0 : 1);
