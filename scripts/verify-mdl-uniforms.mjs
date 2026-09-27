#!/usr/bin/env node
/**
 * verify-mdl-uniforms —— MDL 顶点着色器的 uniform 必须**每条绘制路径都赋值**。
 *
 * 为什么需要（2026-09-28 的真实回归）：给「零件同步压扁」加 `u_partScale/u_partPivot`
 * 时，只在**白名单分支**里设了这两个 uniform。GL 的 uniform 默认值是 `(0,0)`，
 * 而顶点着色器里 `local.xy = u_partPivot + (local.xy − u_partPivot) * u_partScale`
 * 在 (0,0) 下会把整张网格乘成 0 —— 于是**除白名单两张之外的所有 puppet 全塌到原点**：
 * 3798926489 / 3791967416 / 3737267090 / 3707219547 等整批人物消失（实测对照见
 * docs/CASEBOOK.md「五订正」）。整套 verify 当时一条都没红：25 个 verifier 里没有一个
 * 会去「真画一遍非白名单的 puppet 网格」。
 *
 * 判据（离线、正则锁实现，与 verify-camera 的实现锁同一风格）：
 *   1. 顶点着色器里出现的每个 `uniform`，在 `draw()` 体内都必须有对应的
 *      `gl.uniform*` 写入 —— 漏一个就是「默认值参与运算」的隐患；
 *   2. 写 `u_partScale/u_partPivot` 的那句必须出现在 `if (squash …)` 分支**之前**
 *      （即无条件复位），否则非白名单路径仍会拿到 (0,0)；
 *   3. 着色器里那条 `local.xy = … u_partScale` 必须还在（否则本 verifier 会空转通过）。
 * 三条都是「实现被改坏就红」的锁：删掉复位、把复位挪进分支、或漏设别的 uniform 都会失败。
 */
import fs from "node:fs";
import { join } from "node:path";
import { ROOT, createChecker } from "./lib/verify-kit.mjs";

const { check, errors } = createChecker({ echo: true });

const SRC = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/mdl.js"), "utf8");

/** 取顶点着色器源码：`const mdlVertSrc = (maxBones) => \`…\`` 到片元着色器模板串之间 */
const vertStart = SRC.indexOf("const mdlVertSrc");
const vertEnd = SRC.indexOf("const MDL_FRAG");
const vert = vertStart >= 0 && vertEnd > vertStart ? SRC.slice(vertStart, vertEnd) : "";
check(vert.length > 0, "找得到 mdlVertSrc 顶点着色器源码");

/** draw() 体内（`draw(mvp, mdl, opts, texture) {` 到 `gl.bindVertexArray(null)`） */
const drawStart = SRC.indexOf("draw(mvp, mdl, opts, texture) {");
const drawEnd = SRC.indexOf("gl.bindVertexArray(null)", drawStart);
const draw = drawStart >= 0 && drawEnd > drawStart ? SRC.slice(drawStart, drawEnd) : "";
check(draw.length > 0, "找得到 draw() 体");

// 1) 每个 uniform 都要有写入（JS 侧局部名 = 着色器名去掉 u_ 前缀，如 u_skin → uni.skin）
const uniformNames = [...vert.matchAll(/^\s*uniform\s+\w+\s+(\w+)\s*(\[[^\]]*\])?\s*;/gm)].map((m) => m[1]);
check(uniformNames.length >= 6, `顶点着色器 uniform 数量 ${uniformNames.length}（≥6：mvp/skin/boneCount/keepZ/partScale/partPivot）`);
for (const name of uniformNames) {
  const local = name.startsWith("u_") ? name.slice(2) : name;
  const written = new RegExp(`gl\\.uniform\\w+\\(uni\\.${local}\\b`).test(draw);
  check(written, `uniform ${name} 在 draw() 里有写入（漏设 → 参与运算的是 GL 默认值）`);
}

// 2) 零件缩放的两个 uniform 必须在分支之前无条件复位
const condIdx = draw.search(/const\s+squash\s*=/);
const scaleIdx = draw.search(/gl\.uniform2f\(uni\.partScale,\s*1,\s*1\)/);
const pivotIdx = draw.search(/gl\.uniform2f\(uni\.partPivot,\s*0,\s*0\)/);
check(condIdx >= 0, "draw() 里找得到 `const squash =` 那一行");
check(scaleIdx >= 0, "u_partScale 有恒等复位 `gl.uniform2f(uni.partScale, 1, 1)`");
check(pivotIdx >= 0, "u_partPivot 有恒等复位 `gl.uniform2f(uni.partPivot, 0, 0)`");
check(scaleIdx >= 0 && condIdx >= 0 && scaleIdx < condIdx, "u_partScale 复位在 `const squash =` **之前**（无条件路径）");
check(pivotIdx >= 0 && condIdx >= 0 && pivotIdx < condIdx, "u_partPivot 复位在 `const squash =` **之前**（无条件路径）");
// 白名单分支里仍要用真实值覆盖（否则压扁失效）
check(/gl\.uniform2f\(uni\.partScale,\s*1,\s*k\)/.test(draw), "白名单分支里按零件覆盖 u_partScale=(1,k)");

// 3) 着色器里的缩放公式还在，且用的是同一对 uniform
check(/local\.xy\s*=\s*u_partPivot\s*\+\s*\(local\.xy\s*-\s*u_partPivot\)\s*\*\s*u_partScale/.test(vert),
  "顶点着色器仍是 `local.xy = pivot + (local.xy − pivot) * scale`");

console.log(
  errors.length === 0
    ? "verify-mdl-uniforms: 全部通过 ✓"
    : `verify-mdl-uniforms: ${errors.length} 项失败 ✗`,
);
process.exit(errors.length === 0 ? 0 : 1);
