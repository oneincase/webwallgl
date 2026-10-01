#!/usr/bin/env node
/**
 * verify-link —— 着色器链接**唯一实现**契约（B3）。
 *
 * 2026-10 把三份 link 收敛到 `gl-util.js` 的 `linkProgram`：
 *   · renderer.js 那套（缺省绑 0=a_Position / 1=a_TexCoord）；
 *   · mdl.js 那套（绑 0..4：a_pos/a_uv/a_bone/a_weight/a_normal，**且链接失败时骨数逐级减半重试**）；
 *   · particle-shaders.js 那套（**不绑** —— 粒子 shader 自带 `layout(location=…)`）。
 * 收敛前 mdl/particles 两侧在**失败路径上都漏 shader**（编译出的两个 shader 没有任何引用可删），
 * 这条纪律由 gl-util 统一执行（与 M3 的 GL 所有权一致）。
 *
 * 离线能判的是**接线**；「属性绑定表真的生效」是 GL 行为，由
 * `scripts/_probe-review-b3-puppet.mjs` 在真 GL 上断言（确定性用例：声明
 * layout(location=3) 的属性必须拿到 3；不绑时位置跟随 shader 自身声明）。
 *
 * 本判据盯三件事：
 *   1. 全仓只有一处 `gl.linkProgram(`（不许再长出第二份）；
 *   2. 三个调用点各自传的属性表/缺省符合上面的约定；
 *   3. mdl 的**重试语义**原样保留（逐级减半 + 下界 + 抛错文案）—— 它是骨预算判据的载体。
 */
import fs from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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
const read = (f) => fs.readFileSync(join(R, f), "utf8");
const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

console.log("\n[1] 全仓只有一处 link 实现");
{
  const files = fs.readdirSync(R).filter((f) => f.endsWith(".js"));
  const hasLink = files.filter((f) => /gl\.linkProgram\(/.test(stripComments(read(f))));
  check(hasLink.length === 1 && hasLink[0] === "gl-util.js", `gl.linkProgram( 只允许出现在 gl-util.js（实得 ${hasLink.join(",") || "无"}）`);
  const util = stripComments(read("gl-util.js"));
  check(/function linkProgram\(gl, vsSrc, fsSrc, opts\)/.test(util), "linkProgram 必须带 opts（属性绑定表入口）");
  check(/\(opts && opts\.attribs\) \|\| \[/.test(util), "缺省属性表必须存在（渲染器那套 0/1），否则粒子以外所有调用点会静默不绑");
  check(/for \(const \[index, name\] of attribs\) gl\.bindAttribLocation\(p, index, name\)/.test(util), "属性表必须逐项绑定");
  check(/gl\.deleteProgram\(p\)[\s\S]{0,200}?gl\.deleteShader\(vs\)[\s\S]{0,200}?gl\.deleteShader\(fs\)/.test(util), "失败路径必须删 program + 两个 shader 再抛（收敛前 mdl/particles 两侧都漏）");
}

console.log("\n[2] 三个调用点的属性约定");
{
  const mdl = stripComments(read("mdl.js"));
  check(/import \{ linkProgram \} from '\.\/gl-util\.js'/.test(mdl), "mdl.js 必须用共享链接器");
  check(/\[0, 'a_pos'\]/.test(mdl) && /\[4, 'a_normal'\]/.test(mdl), "mdl 必须绑 0..4（a_pos/a_uv/a_bone/a_weight/a_normal）");
  check(/linkProgram\(gl, mdlVertSrc\(maxBones\), MDL_FRAG, \{ attribs: ATTRIBS \}\)/.test(mdl), "mdl 必须把属性表传给共享链接器");
  const ps = stripComments(read("particle-shaders.js"));
  check(/import \{ linkProgram \} from '\.\/gl-util\.js'/.test(ps), "particle-shaders.js 必须用共享链接器");
  check(/linkProgram\(gl, vs, fs, \{ attribs: \[\] \}\)/.test(ps), "粒子必须传空属性表（它的 shader 自带 layout 声明，绑会覆盖）");
  const rnd = stripComments(read("renderer.js"));
  check(/linkProgram\(gl, [A-Z_]+, [A-Z_]+\)/.test(rnd), "renderer.js 必须走缺省属性表（不传 opts = 绑 0/1）");
}

console.log("\n[3] mdl 的重试语义（骨预算判据的载体，不得丢）");
{
  const mdl = stripComments(read("mdl.js"));
  check(/for \(;;\) \{/.test(mdl), "必须有重试循环");
  check(/maxBones = Math\.max\(MAX_BONES_FLOOR, maxBones >> 1\)/.test(mdl), "重试必须逐级**减半**且有下界（MAX_BONES_FLOOR）");
  check(/if \(maxBones <= MAX_BONES_FLOOR\) \{[\s\S]{0,200}?throw new Error\('MDL 着色器链接失败（骨数已降到 '/.test(mdl), "降到下界仍失败必须抛（带骨数文案，工单可读）");
  check(/linkProgram\(gl, mdlVertSrc\(maxBones\), MDL_FRAG/.test(mdl), "重试必须用当轮 maxBones 重新生成顶点源（否则重试等于重试同一份源码）");
}

console.log(failed === 0 ? "\nverify-link: 全部通过 ✓" : `\nverify-link: ${failed} 项失败 ✗`);
process.exit(failed === 0 ? 0 : 1);
