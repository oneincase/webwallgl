#!/usr/bin/env node
/**
 * verify-mat —— 4x4 乘法的**唯一实现**契约（B4）。
 *
 * 2026-10 把 `mdl-math.js` 的显式四项求和合并到 `math.js` 的 mat4Multiply（mdl 侧改为委托）。
 * 合并前实测两者**并非逐位等价**：1e5 组随机矩阵里 244 组位型不同，全部是零的符号
 * （`0 + (-0)` 会归一成 `+0`，显式求和则保留 `-0`）。零的符号不影响比较、也不影响渲染像素，
 * 但合并的意义就是只留**一处**，所以这里钉三件事：
 *   1. 值等价：与判据内**独立实现**（显式四项求和）在全量随机输入上 `===` 相等。
 *      **它抓的是「精度被破坏」而不是「项序被改」** —— 实测：把累加顺序倒过来
 *      位型差异 0 组（四个 float32 乘积用 float64 累加是**精确**的，和 ≤50 位有效数字），
 *      而把每步 `Math.fround` 成 float32 累加会产生 12.7 万处位型差异。所以这条判据
 *      不是「顺序守卫」，别指望它拦重排（那本来就不可观测）；
 *   2. 位等价：`mdl-math.mat4Mul` 与 `math.mat4Multiply` 位型完全一致（含 ±0）——
 *      这是合并后的**新不变量**，也是「别再长出第二份实现」的闸门；
 *   3. `mat4Invert` **不合并**：mdl 侧必须仍是 f64 高斯消元（数值路径不同，骨骼绑定依赖它）。
 *
 * 输入分布刻意覆盖 0 / -0 / 次正规 / 大值 / 混合 —— 只喂 [0,1) 随机数是测不到零符号差异的
 * （那正是合并前那次「逐位等价」误判的成因）。
 */
import fs from "node:fs";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = join(fileURLToPath(import.meta.url), "..");
const ROOT = join(here, "..");
const R = join(ROOT, "renderer/vendor/we-scene/render/");

let failed = 0;
function check(ok, msg) {
  if (ok) console.log(`  ✓ ${msg}`);
  else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

const { mat4Multiply } = await import(pathToFileURL(join(R, "math.js")).href);
const { mat4Mul } = await import(pathToFileURL(join(R, "mdl-math.js")).href);

const bits = (f) => {
  const u = new Uint32Array(1);
  new Float32Array(u.buffer)[0] = f;
  return u[0];
};

/** 独立实现：显式四项求和（与 md4Multiply 的循环累加是不同写法，同语义） */
function reference(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] =
        a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
}

let rng = 20261001;
const rand = () => {
  rng = (rng * 1664525 + 1013904223) >>> 0;
  return rng / 4294967296;
};
/** 取值分布：0 / -0 / 次正规 / 大值 / 常规，目的是把零符号与舍入边界都喂到 */
const pick = () => {
  const r = rand();
  if (r < 0.06) return 0;
  if (r < 0.12) return -0;
  if (r < 0.2) return (rand() - 0.5) * 1e-30;
  if (r < 0.3) return (rand() - 0.5) * 1e6;
  return rand() * 4 - 2;
};

console.log("\n[1] 值等价：与独立参考实现在 1e5 组随机矩阵上 ===（抓精度破坏：如逐步 fround / 改乘积顺序）");
{
  let valueDiff = 0;
  let firstBad = null;
  let zeroSignOnly = 0;
  for (let n = 0; n < 100000; n++) {
    const a = new Float32Array(16);
    const b = new Float32Array(16);
    for (let i = 0; i < 16; i++) {
      a[i] = pick();
      b[i] = pick();
    }
    const x = mat4Multiply(a, b);
    const ref = reference(a, b);
    for (let i = 0; i < 16; i++) {
      if (x[i] === ref[i]) {
        if (bits(x[i]) !== bits(ref[i])) zeroSignOnly++; // 允许：零符号（见文件头注）
        continue;
      }
      valueDiff++;
      if (!firstBad) firstBad = { n, i, x: x[i], ref: ref[i] };
      break;
    }
  }
  check(valueDiff === 0, `1e5 组矩阵值全部相等（不等 ${valueDiff} 组，首个 ${JSON.stringify(firstBad)}）`);
  console.log(`  · 信息：其中 ${zeroSignOnly} 个元素与参考实现只差零的符号（+0 / -0，允许，渲染等价）`);
}

console.log("\n[2] 位等价：mat4Mul 与 mat4Multiply 是同一份实现（含 ±0）");
{
  let bitDiff = 0;
  let outOk = true;
  for (let n = 0; n < 20000; n++) {
    const a = new Float32Array(16);
    const b = new Float32Array(16);
    for (let i = 0; i < 16; i++) {
      a[i] = pick();
      b[i] = pick();
    }
    const out = new Float32Array(16);
    const viaOut = mat4Mul(a, b, out);
    if (viaOut !== out) outOk = false;
    const x = mat4Multiply(a, b);
    for (let i = 0; i < 16; i++) {
      if (bits(out[i]) !== bits(x[i])) {
        bitDiff++;
        break;
      }
    }
  }
  check(bitDiff === 0, `2e4 组位型完全一致（不一致 ${bitDiff} 组）`);
  check(outOk, "mat4Mul 的 out 参数语义保留（写入并返回传入的缓冲，9 处三参调用依赖它）");
}

console.log("\n[3] 接线：只允许一份乘法实现；mat4Invert 保持双份");
{
  const mathSrc = fs.readFileSync(join(R, "math.js"), "utf8");
  const mdlSrc = fs.readFileSync(join(R, "mdl-math.js"), "utf8");
  check(/export function mat4Multiply\(a, b, out\)/.test(mathSrc), "math.js 是规范实现且支持 out");
  const mdlMul = /function mat4Mul\(a, b, out\) \{\s*\n\s*return mat4Multiply\(a, b, out\)/.test(mdlSrc);
  check(mdlMul, "mdl-math 的 mat4Mul 必须委托（不得再长出第二份乘法循环）");
  check(/import \{ mat4Multiply \} from '\.\/math\.js'/.test(mdlSrc), "mdl-math 必须从 math.js 导入乘法");
  // 不合并 invert：两侧都要在，且 mdl 侧是高斯消元（按 pivot 行交换判定）
  check(/function mat4Invert\(m\) \{[\s\S]{0,600}?let piv = col/.test(mdlSrc), "mdl-math 的 mat4Invert 必须仍是 f64 高斯消元（不合并）");
  check(/export function mat4Invert\(m\) \{/.test(mathSrc), "math.js 的 mat4Invert 保留（余子式实现，与 mdl 侧数值路径不同）");
}

console.log(failed === 0 ? "\nverify-mat: 全部通过 ✓" : `\nverify-mat: ${failed} 项失败 ✗`);
process.exit(failed === 0 ? 0 : 1);
