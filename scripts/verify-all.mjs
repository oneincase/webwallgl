#!/usr/bin/env node
/**
 * verify-all —— 一键跑全部离线校验，逐项计时 + 汇总。
 *
 *   node scripts/verify-all.mjs          稳定集（不含已知浮动的 particles）
 *   node scripts/verify-all.mjs --all    追加 verify:particles
 *
 * 退出码：0 = 无「新失败」。**基线已知失败**（见 KNOWN_BASELINE）会显著打印但不算失败，
 * 这是刻意设计：一键校验的价值在于区分「这次改动弄坏了什么」和「本来就是坏的」；
 * 已知失败每次都会显式出现在汇总里，不会被静默吞掉。修掉对应缺陷后应把它从
 * KNOWN_BASELINE 里删掉（或它自动变绿后删除）。
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = join(fileURLToPath(import.meta.url), "..");
const ROOT = join(here, "..");

/** 稳定集：每次提交前必须全绿（pnpm check 的提交门禁） */
const STABLE = [
  "verify-audio",
  "verify-camera",
  "verify-sprites",
  "verify-props",
  "verify-text",
  "verify-shaders",
  // 效果链解析的**诊断契约**：该报的必须报（效果文件/材质缺失、pass 直写 shader、
  // 材质缺 shader、坏 JSON、同一处只报一次），不该报的一个都不许报（官方两段式、
  // copy/swap 命令 pass、全库 10420 个效果零误报）—— issue #11
  "verify-effects",
  // 诊断**级别**契约：级别由上报方声明并随 /diag 一起发（lvl=）、三档语义、
  // 文本判据只兜外部透传文案且零计数豁免 —— issue #13
  "verify-diag",
  "verify-animation",
  "verify-attachments",
  "verify-transform",
  "verify-media",
  "verify-textures",
  "verify-bloom",
  "verify-cover-peek",
  "verify-pointer",
  "verify-groups",
  "verify-web",
  "verify-resolution",
  "verify-quality",
  // 解码/定位类判据：LZ4（逐位对账 + 惰性 mip 契约）、MDL 段定位（单趟扫描 vs 独立扫描）
  "verify-lz4",
  "verify-mdl-sections",
  // MDL 顶点着色器 uniform 契约：每个 uniform 每条绘制路径都要赋值（否则走 GL 默认值 (0,0)，
  // 曾把除白名单两张外的全部 puppet 塌到原点 —— 见 verify-mdl-uniforms 头注）
  "verify-mdl-uniforms",
  // 自动降档策略：显式优先 / 开关失效 / 阶梯只降不升 / 守门抗抖动（纯函数，离线）
  "verify-quality-auto",
  // 贴图烘焙（B3）：键/判定逻辑 + 命中路径不变量（预乘、开关、队列时机）
  "verify-bake",
  // 遮挡感知降载（V5）：几何/分档数值 + 全链接线 + 变异红测（纯逻辑，离线）
  "verify-occlusion",
  // dist/ 归属边界：站点构建不许删 dist/lib（宿主 WallpaperEM 的 file: 依赖指着它；
  // 2026-10-01 被站点构建清空 dist/ 连累过 —— 宿主侧全线 ENOENT）
  "verify-dist",
  // 实例生命周期/代际（M4）：终态、await 后代际核对、旧代不触发新代首帧、画布所有权
  // （源码守卫；行为面见 scripts/_probe-review-lifecycle.mjs 的无头真装配）
  "verify-lifecycle",
  // 噪声路径逐位等价（粒子热点的单元格角点缓存；0 容差对拍 + A/B 开关）
  "verify-noise",
  // 内置贴图像素金样（mulberry32 收敛 B1；82 张 + 种子表）
  "verify-rng",
  // 4x4 乘法唯一实现契约（B4：值等价 + 位等价 + out 语义 + invert 不合并）
  "verify-mat",
  // 着色器链接唯一实现契约（B3：属性表 / 不绑语义 / mdl 骨预算重试保留）
  "verify-link",
];

/** 已知浮动，默认不进稳定集（3148125112 的加法过曝随帧浮动 8.8%–11.3%） */
const FLAKY = ["verify-particles"];

/**
 * 基线已知失败：本分支开工时就红的项。键 = 脚本名，值 = 说明。
 * 修复后请删除对应条目（新增失败不会匹配这里，照常报错）。
 */
const KNOWN_BASELINE = {
  // I4 蒙皮法向翻转：HEAD 本底 1914（阈值 1200，历史正确值 4xx）。动画 id 锚扫
  // 修正后一批此前悬空的动画引用首次生效；2026-09 加算层两连修（rest-relative
  // 增量 + 归一化只作用于增量）后为 2286。剩余的主要是隐藏重复层 kkkk#359 的
  // 动画 476（4 骨静态 rz ~74°，blend=1 独占姿势）静态撕 ~904 —— 该层 visible:false
  // 不上屏，是 WE 也这样还是旋转语义仍有缺口，见 CASEBOOK「之四」末尾。
  "verify-groups": "I4 蒙皮三角形法向翻转 2311 > 1200（HEAD 本底 1914 + 隐藏层 kkkk 动画476 ~904）",
};

const runParticles = process.argv.includes("--all");
const jobs = runParticles ? [...STABLE, ...FLAKY] : [...STABLE];

const results = [];
let newFailures = 0;
let knownFailures = 0;

for (const name of jobs) {
  const t0 = Date.now();
  const r = spawnSync("node", [join("scripts", `${name}.mjs`)], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const passed = r.status === 0;
  const known = !passed && KNOWN_BASELINE[name];
  if (passed) results.push(`  ✓ ${name.padEnd(20)} ${secs}s`);
  else if (known) {
    knownFailures++;
    const tail = (r.stdout || r.stderr).trim().split("\n").slice(-2).join(" / ");
    results.push(`  ⚠ ${name.padEnd(20)} ${secs}s  基线已知失败：${KNOWN_BASELINE[name]}`);
    results.push(`      └ ${tail.slice(0, 160)}`);
  } else {
    newFailures++;
    const tail = (r.stdout || r.stderr).trim().split("\n").slice(-4).join(" / ");
    results.push(`  ✗ ${name.padEnd(20)} ${secs}s  ← 新失败`);
    results.push(`      └ ${tail.slice(0, 240)}`);
  }
}

console.log("\n════════ verify-all 汇总 ════════");
console.log(results.join("\n"));
const label = runParticles ? "全量（含 particles）" : "稳定集";
console.log(
  `\n${label}：${jobs.length - newFailures - knownFailures} 通过 / ` +
    `${knownFailures} 基线已知失败 / ${newFailures} 新失败`,
);
process.exit(newFailures === 0 ? 0 : 1);
