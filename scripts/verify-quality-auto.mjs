#!/usr/bin/env node
/**
 * verify-quality-auto —— 自动降档策略的离线判据（软件渲染预设 + 帧率守门）。
 *
 * 为什么需要：这套东西会在**用户背后改画质**，判据要钉住的恰恰是「什么时候**不许**改」：
 *   · 宿主显式指定的档位永远不被覆盖（显式优先）—— 写反了就是「用户选了 high，
 *     我们去把它降成 off」，属于最招人恨的那类 bug；
 *   · `autoQuality:false` 必须整段失效；
 *   · 阶梯只能往下、到 off 为止（不能把 off 抬回 low，也不能死循环）；
 *   · 帧率守门必须扛住抖动：单次低帧、加载期前 5 秒、降档后的冷却期内都不许降。
 *
 * 覆盖的实测依据（写在 quality.ts 里）：软件渲染下「后处理 off + DPR 0.5」是
 * 0fps → 46fps 的组合；粒子档除 off 外无效（所以阶梯不碰粒子）。
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, createChecker } from "./lib/verify-kit.mjs";

const { check, errors } = createChecker({ echo: true });

const q = await import(pathToFileURL(join(ROOT, "renderer/src/quality.ts")).href).catch(() => null);
if (!q) {
  // quality.ts 是 TS：Node 不能直载。用 esbuild 现编一份（与 verify-textures 同套路）。
  const { build } = await import("esbuild");
  const fs = await import("node:fs");
  const out = await build({
    entryPoints: [join(ROOT, "renderer/src/quality.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "es2022",
  });
  const tmp = join(ROOT, "scripts", `.tmp-quality-${process.pid}.mjs`);
  fs.writeFileSync(tmp, out.outputFiles[0].text);
  try {
    var mod = await import(pathToFileURL(tmp).href);
  } finally {
    fs.unlinkSync(tmp);
  }
}
const Q = mod ?? q;

const high = { antiAliasing: "off", particles: "high", postProcessing: "high" };

// ---- ① 软件渲染预设：只填没显式指定的字段
{
  const r = Q.applyAutoQuality({ quality: high, explicit: {}, software: true });
  check(r.quality.postProcessing === "off", "软件渲染 + 未指定 pp → 必须降到 off");
  check(r.quality.particles === "high", "软件渲染**不许**动粒子档（off 是视觉断崖）");
  check(r.applied.length > 0, "改动了就必须有 applied 说明（宿主可观测）");
  check(r.allowAdaptive === false, "pp 已 off → 帧率守门应停用（无坡可下）");
}
{
  const r = Q.applyAutoQuality({ quality: high, explicit: { postProcessing: "high" }, software: true });
  check(r.quality.postProcessing === "high", "宿主显式 pp=high：软件预设不许覆盖（显式优先）");
  check(r.applied.length === 0, "没改动就不该报 applied");
  check(r.allowAdaptive === true, "宿主显式 high → 守门仍可介入");
}
{
  const r = Q.applyAutoQuality({ quality: high, explicit: { postProcessing: "high" }, software: false, enabled: false });
  check(r.quality.postProcessing === "high", "autoQuality:false 必须整段失效");
  check(r.allowAdaptive === false, "关掉自动降档时守门也不许跑");
}
{
  const r = Q.applyAutoQuality({ quality: high, explicit: {}, software: false });
  check(r.quality.postProcessing === "high", "有 GPU 时挂载期不该动任何档位");
  check(r.allowAdaptive === true, "有 GPU 时保留守门（帧率不够时才降）");
}

// ---- ② 画布 DPR 封顶：只压自动档
check(Q.softwareDprCap(true, 0) === Q.SOFTWARE_DPR_CAP, "软件渲染 + 自动 DPR → 压到 SOFTWARE_DPR_CAP");
check(Q.softwareDprCap(true, undefined) === Q.SOFTWARE_DPR_CAP, "未给 renderDpr 同自动档");
check(Q.softwareDprCap(true, 2) === null, "宿主显式 renderDpr=2 → 不压（显式优先）");
check(Q.softwareDprCap(false, 0) === null, "有 GPU → 不压");
check(Q.SOFTWARE_DPR_CAP === 0.5, "SOFTWARE_DPR_CAP 的取值有实测依据（0.5 是 0fps→46fps 的那档）");

// ---- ③ 阶梯：只往下、到底就停
{
  const seen = [];
  let cur = "high";
  for (let i = 0; i < 8; i++) {
    const nx = Q.nextPostTier(cur);
    if (!nx) break;
    seen.push(nx);
    cur = nx;
  }
  check(seen.join(">") === "medium>low>off", `阶梯必须是 high→medium→low→off，实际 ${seen.join(">")}`);
  check(Q.nextPostTier("off") === null, "off 到底：不许再往下（也不许回弹）");
  check(!Q.POST_DOWNGRADE_LADDER.includes("high"), "阶梯里不该出现 high（那是起点不是目标）");
}

// ---- ④ 帧率守门：抖动不许触发
const mk = (drops) => {
  const log = [];
  const gate = Q.createAdaptiveQuality({ onDowngrade: (next, reason) => log.push({ next, reason }) });
  return { gate, log };
};
{
  // 保护期：前 5 秒再惨也不降
  const { gate, log } = mk();
  for (let i = 0; i < 5; i++) gate.tick(10, 60, 1, "high");
  check(log.length === 0, "保护期（前 5 秒）内不许降档");
}
{
  // 单次低帧 + 交叉正常：不许降
  const { gate, log } = mk();
  for (let i = 0; i < 6; i++) gate.tick(60, 60, 1, "high"); // 过保护期
  gate.tick(30, 60, 1, "high");
  gate.tick(60, 60, 1, "high");
  gate.tick(30, 60, 1, "high");
  gate.tick(60, 60, 1, "high");
  check(log.length === 0, `抖动（低帧被正常帧打断）不许降档，实际降了 ${log.length} 次`);
}
{
  // 连续 3 秒低帧：降一档，且进入冷却
  const { gate, log } = mk();
  for (let i = 0; i < 6; i++) gate.tick(60, 60, 1, "high");
  for (let i = 0; i < 3; i++) gate.tick(40, 60, 1, "high");
  check(log.length === 1 && log[0].next === "medium", `连续 3 秒低帧应降一档到 medium，实际 ${JSON.stringify(log)}`);
  for (let i = 0; i < 5; i++) gate.tick(40, 60, 1, "medium");
  check(log.length === 1, "冷却期（6 秒）内不许连降");
}
{
  // 一直救不回来：最多降到 off 就停
  const { gate, log } = mk();
  let cur = "high";
  for (let i = 0; i < 120; i++) cur = gate.tick(20, 60, 1, cur) ?? cur;
  check(cur === "off", `持续低帧最终应停在 off，实际 ${cur}`);
  check(log.length === 3, `总共只该降 3 次（medium/low/off），实际 ${log.length}`);
}
{
  // 宿主中途改档：从**实际生效档位**继续往下，而不是从状态机里的旧值
  const { gate, log } = mk();
  for (let i = 0; i < 6; i++) gate.tick(60, 60, 1, "high");
  for (let i = 0; i < 3; i++) gate.tick(40, 60, 1, "low"); // 生效档位已经是 low
  check(log.length === 1 && log[0].next === "off", `从当前生效档位 low 应降到 off，实际 ${JSON.stringify(log)}`);
}
{
  // 上限本身很低（宿主设 fps=30）时不许误判
  const { gate, log } = mk();
  for (let i = 0; i < 6; i++) gate.tick(30, 30, 1, "high");
  check(log.length === 0, "上限 30 时跑满 30 不该降档（阈值按上限比例算）");
  for (let i = 0; i < 4; i++) gate.tick(24, 30, 1, "high");
  check(log.length === 1, "上限 30 但只跑 24（<85%）时应降档");
}

console.log(errors.length === 0 ? "\nverify-quality-auto: 全部通过 ✓" : `\nverify-quality-auto: ${errors.length} 项失败 ✗`);
process.exit(errors.length === 0 ? 0 : 1);
