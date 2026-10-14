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
  // 转译产物真编译（glslang）+ 报错驱动修复契约：全库修复后零编译失败（无 glslang 时跳过）
  "verify-glsl",
  // 效果链解析的**诊断契约**：该报的必须报（效果文件/材质缺失、pass 直写 shader、
  // 材质缺 shader、坏 JSON、同一处只报一次），不该报的一个都不许报（官方两段式、
  // copy/swap 命令 pass、全库 10420 个效果零误报）—— issue #11
  "verify-effects",
  // 官方内置**源码工程**的装载判据：场景条目按 project.json.file 命中、
  // 引用完整性（材质链/模型内嵌材质/贴子/sprite/音效）、层材质合成条目零假诊断
  // —— DEFAULTPROJECTS-PLAN P0
  "verify-defprojects",
  // MDL **源码族**（官方内置/编辑器工程）判据：属性位掩码驱动的顶点布局、
  // 26 个模型冻结表、打包语料 577 个 .mdl 全部可解析 —— DEFAULTPROJECTS-PLAN P1
  "verify-mdl-source",
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
  // .mdl 编码器（W17）：语料逐字节往返、文档与 parseMDL 同源、从零编码 MDLV0023 的语义往返
  "verify-mdl-write",
  // 全库 .mdl 语料回归（PUPPET-WARP-FULL-PLAN P0）：643 个文件（scene.pkg 617 + 松散 26）
  // 结构解析率 100%（整份 / 任一段退成 raw 都算失败）、逐字节往返、骨骼 head0 与矩阵尾 meta
  // 读写同源、版本 / 段 / 部件 / 附着点 / 尾部零填充分类摘要。修 `Reader.f32s` 的 Buffer 别名
  // bug 前 44% 的真实模型在这里退成 raw、编辑静默 no-op —— 本项就是那个 bug 的回归闸门
  "verify-mdl-corpus",
  // MDL 顶点着色器 uniform 契约：每个 uniform 每条绘制路径都要赋值（否则走 GL 默认值 (0,0)，
  // 曾把除白名单两张外的全部 puppet 塌到原点 —— 见 verify-mdl-uniforms 头注）
  "verify-mdl-uniforms",
  // 眨眼补偿不再按壁纸 ID：眼组网格必须把眼球压到 k=0，全身/头发/躯干块必须一个都不压
  "verify-blink",
  // 真 3D 模型之间的层间深度契约（F49）：假 GL 驱动真渲染器，断言「两次模型绘制之间不得清
  // 深度」（清了 = 后画的模型无条件盖住先画的：3477054430 城市盖住猫）、天空盒只测不写、
  // 2D puppet 不碰深度、宿主 isSkybox 接线、帧首清深度前先开写掩码
  "verify-mdl-depth",
  // 自动降档策略：显式优先 / 开关失效 / 阶梯只降不升 / 守门抗抖动（纯函数，离线）
  "verify-quality-auto",
  // 贴图烘焙（B3）：键/判定逻辑 + 命中路径不变量（预乘、开关、队列时机）
  "verify-bake",
  // 遮挡感知降载（V5）：几何/分档数值 + 全链接线 + 变异红测（纯逻辑，离线）
  "verify-occlusion",
  // dist/ 归属边界：站点构建不许删 dist/lib（宿主 WallpaperEM 的 file: 依赖指着它；
  // 2026-10-01 被站点构建清空 dist/ 连累过 —— 宿主侧全线 ENOENT）
  // 文件名一直是 verify-dist-layout.mjs（package.json 的 verify:dist 也指它）——
  // 这里写成 "verify-dist" 会让本项**从未真正跑过**（spawn 一个不存在的脚本，
  // 每轮稳定集固定多一条 MODULE_NOT_FOUND 的「新失败」）。
  "verify-dist-layout",
  // 实例生命周期/代际（M4）：终态、await 后代际核对、旧代不触发新代首帧、画布所有权
  // （源码守卫；行为面见 scripts/_probe-review-lifecycle.mjs 的无头真装配）
  "verify-lifecycle",
  // 雾的数值契约（M1.3/M1.6，2026-10-12）：解析式 t² 曲线 + 先高度后距离、`script`/`{value}`
  // 解包与除零保护（真跑 scene-mount.ts 的 sceneFog 切片）、7 个 uniform 与 FOG 门控。
  // 此前雾只被 FLAKY 的 verify-particles 覆盖 ⇒ 实际无门禁（verify-particles 不在稳定集）
  "verify-fog",
  // 噪声路径逐位等价（粒子热点的单元格角点缓存；0 容差对拍 + A/B 开关）
  "verify-noise",
  // 内置贴图像素金样（mulberry32 收敛 B1；82 张 + 种子表）
  "verify-rng",
  // 4x4 乘法唯一实现契约（B4：值等价 + 位等价 + out 语义 + invert 不合并）
  "verify-mat",
  // 着色器链接唯一实现契约（B3：属性表 / 不绑语义 / mdl 骨预算重试保留）
  "verify-link",
  // G10：HLSL 宏体负字面量的括号化（`#define X -1.3` 展开成 `(-1.3)`，避免 `a - -1.3`
  // 被折叠成 `a--1.3` 后整段 pass 被跳过）+ 负值 combo。13 条合成夹具 + 裸替换对照尺。
  "verify-hlsl-macro",
  // M1.4 脚本沙箱：三条已知逃逸向量（fnCtor / arrCtor / indirEval）钉住当前真实行为 +
  // M7(B+C) 通道收紧的文本判据。逃逸向量用子进程跑（20s 硬超时），不读素材库。
  "verify-sandbox",
  // 本波（we-native-constants）四份「原生常量对账」判据：只读本仓源码 + 只读第一方语料，
  // 不依赖任何外部工具链（原生证据列为 null 时跳过并打印 unknown 清单，填值即自动启用断言）。
  //   状态机 / .tex 头与 format 枚举 / 光照 9 键 + 着色器 5 项 / 粒子 9 段 / 场景脚本 6 判定 / 相机 5 组
  "verify-native-state",
  "verify-tex-constants",
  "verify-light-constants",
  "verify-particle-constants",
  "verify-scenescript-constants",
  "verify-camera-constants",
  // 松散目录形态的场景壁纸（源码工程 / 官方内置 defaultprojects）：判定表与回退语义
  // 真跑（含本地 HTTP 服务器）、本地库 17 个条目的引用闭包审计、接线守卫、变异红测。
  // 真 GPU A/B 不在稳定集里（要 Chrome + 自起 dev server）：`node scripts/verify-loose.mjs --headless`
  "verify-loose",
  // 编辑器页（EDITOR-PLAN §3A）：文档模型 / 记账 / 手柄几何 / zip / 保存 / 打开 / 宿主保存端点
  // 的单测 + 「打开 → 编辑 → 存进库 → 重新打开」闭环 + 变异红测。
  // 真浏览器端到端不在稳定集里（要 Chrome + 自起 dev server）：`node scripts/verify-editor.mjs --headless`
  "verify-editor",
  // 编辑器插件内核（editor/core）：inject 等待 / 依赖消失回 pending / 服务栈回落 / 逆序撤销 /
  // 出错隔离与预算 / 权限白名单 / profile 诊断 / 注册表栈 + 变异红测
  "verify-plugin-kernel",
  // 导出管线 + WE 兼容性回读（散装 / scene.pkg 两形态零 error、坏产物逐类报错、真实库零误报）
  "verify-we-export",
  // 外部插件：清单 / 数据贡献原子登记 / 代码插件权限门控 / 来源优先与热重载 / 插件目录端点 / 示例插件 + 变异红测
  "verify-plugins",
  // 产物卫生（issue #14 第二半）：**按文本发布**的东西不许留内部注释 —— 引擎模板串里的 GLSL
  // 注释（压缩器看不见字符串内容）、`?raw` 注入第三方页面的 web-shim（14 KB JSDoc）、
  // 以及压缩版默认 ascii 把中文转义成 `\uXXXX`（看着像漏剥的注释）。三条路径都锁在构建期。
  "verify-bundle-hygiene",
  // 编辑器「实例化」图层的**贴图槽**契约（`instance.textures`，2026-10-14）：真跑 scene-mount.ts
  // 的合并切片（按索引覆盖 / `util/` 白贴图与 `_rt_` 跳过 / 缺位不补 / 不就地改写）+ 变异红测
  // + 撤 `layer.solid` 的接线锁（渲染端 solid 恒赢，只写 textureName 等于没写）+ 全库语料复核
  // （119 层/21 张的真名贴图必须都在包内，224 层纯 `util/` 一个都不许被覆盖）。
  // 3815761795 画桥整屏发白就是这条：实例层材质 `materials/util/solidlayer_instance_4.json`
  // 不随包发布（运行时合成），装配回退内置 solidlayer 的空槽 ⇒ 只剩 `whiteTex × color[1,1,1]`，
  // 3840×2160 两层把下面 0–50 层全盖住。
  "verify-instance-textures",
];

/** 已知浮动，默认不进稳定集（3148125112 的加法过曝随帧浮动 8.8%–11.3%） */
const FLAKY = ["verify-particles"];

/**
 * 基线已知失败：本分支开工时就红的项。键 = 脚本名，值 = 说明。
 * 修复后请删除对应条目（新增失败不会匹配这里，照常报错）。
 */
const KNOWN_BASELINE = {};

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
