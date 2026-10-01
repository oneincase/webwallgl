#!/usr/bin/env node
/**
 * verify-noise —— 粒子噪声路径的**逐位等价**判据。
 *
 * 背景：重粒子场景（3262691944，19 个粒子系统）实测稳态热点 = `hash3` 67.1% + `vnoise3` 8.1%，
 * 而 `updateParticle` 只有 4% —— 瓶颈不在每粒子的分配/算子求值，在噪声本身
 * （V8 profile 见 docs/ENGINE-REVIEW-2026-10.md §11）。2026-10 给三线性插值的
 * **8 个角点**加了按单元格的直接映射缓存（角点只由整数格点决定，与小数偏移无关）：
 * 一次 vnoise3 从 8 次 hash3 查表压成 1 次单元格查表。
 *
 * 它改的是数值路径，所以判据必须是**逐位对拍**（0 容差），不是「看起来差不多」：
 *   1. `cellSlot` 的角点顺序必须与插值的取值顺序一一对应（顺序错 → 画面细微错位，肉眼看不出来）；
 *   2. 覆盖必须覆盖到**淘汰/覆盖**路径（单元格数超出表大小，否则只测到命中路径）；
 *   3. A/B 开关（`__noiseCellOff`）两侧结果必须完全一致 —— 它同时是性能对拍的对照组。
 *
 * 表是模块级的，且开关只在首次调用时解析一次 ⇒ 必须用**独立模块实例**（带 query 的 import）
 * 分别验证开/关两条路径。
 */
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = join(fileURLToPath(import.meta.url), "..");
const ROOT = join(here, "..");
const MOD = join(ROOT, "renderer/vendor/we-scene/render/particle-util.js");

let failed = 0;
function check(ok, msg) {
  if (ok) console.log(`  ✓ ${msg}`);
  else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

/** 参考实现：2026-10 之前的原公式（直接 8 次 hash3），一字未改 */
function makeRef(mod) {
  const { hash3 } = mod;
  const l = (a, b, t) => a + (b - a) * t;
  return (x, y, z) => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const iz = Math.floor(z);
    const fx = x - ix;
    const fy = y - iy;
    const fz = z - iz;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const sz = fz * fz * (3 - 2 * fz);
    const c00 = l(hash3(ix, iy, iz), hash3(ix + 1, iy, iz), sx);
    const c10 = l(hash3(ix, iy + 1, iz), hash3(ix + 1, iy + 1, iz), sx);
    const c01 = l(hash3(ix, iy, iz + 1), hash3(ix + 1, iy, iz + 1), sx);
    const c11 = l(hash3(ix, iy + 1, iz + 1), hash3(ix + 1, iy + 1, iz + 1), sx);
    return l(l(c00, c10, sy), l(c01, c11, sy), sz);
  };
}

/** 覆盖三类输入：密集抖动（同格）、大步长（跨格 + 逼出覆盖）、边界/负值/大值 */
function makeCases() {
  const cases = [];
  for (let i = 0; i < 400; i++) cases.push([i * 0.013, i * 0.0071, i * 0.0033]);
  for (let i = 0; i < 400; i++) cases.push([i * 3.7, -i * 2.1, i * 5.9]);
  for (const v of [[0, 0, 0], [-1e-9, 1e-9, -1e-9], [1e6, -1e6, 1e6], [-0.5, -0.5, -0.5], [127.999, 128.001, 0]]) cases.push(v);
  for (let i = 0; i < 200; i++) cases.push([(i - 100) * 0.25, (i - 100) * -0.5, i * 0.125]);
  return cases;
}

async function run(flagOff) {
  // 必须在**本实例首次调用 hash3 之前**设好全局：开关只在首次调用时解析一次。
  // （第一版就是这么错的 —— 忘了设，于是两轮都走缓存路径，"两侧一致"成了空比较。）
  globalThis.__noiseCellOff = flagOff;
  const mod = await import(pathToFileURL(MOD).href + (flagOff ? "?mode=off" : "?mode=on"));
  const { vnoise3, fbm3, noiseVec3, hash3, noiseMemoStats } = mod;
  const ref = makeRef(mod);
  const h = createHash("sha1");
  let mismatch = 0;
  let first = null;
  for (const [x, y, z] of makeCases()) {
    const a = vnoise3(x, y, z);
    const b = ref(x, y, z);
    h.update(String(a) + "|");
    if (a !== b) {
      mismatch++;
      if (!first) first = [x, y, z, a, b];
    }
    // hash3 自身也顺带对拍（参考实现直接用它，这里锁的是「它没被顺手改」）
    h.update(String(hash3(x, y, z)) + ";");
  }
  for (let i = 0; i < 50; i++) h.update(JSON.stringify(noiseVec3(i * 0.01, i * 0.02, i * 0.03, 2)) + "|");
  for (let i = 0; i < 50; i++) h.update(String(fbm3(i * 0.02, i * 0.03, i * 0.04, 3)) + "|");
  return { mismatch, first, sha: h.digest("hex").slice(0, 16), stats: noiseMemoStats() };
}

console.log("\n[1] vnoise3 / hash3 / fbm3 / noiseVec3 与参考实现逐位一致（0 容差）");
const on = await run(false);
const off = await run(true);
check(on.mismatch === 0, `单元格缓存开：1005 组输入逐位一致（不一致 ${on.mismatch}，首个 ${JSON.stringify(on.first)}）`);
check(off.mismatch === 0, `单元格缓存关（A/B 对照）：逐位一致（不一致 ${off.mismatch}）`);
check(on.sha === off.sha, `开关两侧结果序列完全相同（${on.sha} vs ${off.sha}）—— 开关是真·对照组，不是两条实现`);

console.log("\n[2] 接线与结构");
{
  const src = (await import("node:fs")).readFileSync(MOD, "utf8");
  check(/function cellSlot\(ix, iy, iz\)/.test(src), "必须有单元格角点缓存 cellSlot");
  check(/ncVal\[v \+ 7\] = hash3\(ix \+ 1, iy \+ 1, iz \+ 1\)/.test(src), "8 个角点必须按插值取值顺序写入（顺序错会画面细微错位）");
  check(/__noiseCellOff/.test(src), "必须保留 A/B 开关 __noiseCellOff（性能对拍的对照组）");
  check(/function lerp3\(/.test(src), "插值必须提到模块级（原实现每次调用新建闭包）");
  // 开关只解析一次：调用过之后改全局不影响本实例
  check(on.stats.cellOff === false && off.stats.cellOff === true, "开关状态可由 noiseMemoStats 观察");
}

console.log(failed === 0 ? "\nverify-noise: 全部通过 ✓" : `\nverify-noise: ${failed} 项失败 ✗`);
process.exit(failed === 0 ? 0 : 1);
