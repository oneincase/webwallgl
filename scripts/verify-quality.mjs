#!/usr/bin/env node
/**
 * verify-quality —— 渲染质量设置（抗锯齿 / 粒子 / 后处理档位，对标 WE 客户端
 * 性能选项）的离线判据。
 *
 * 三层断言：
 *   1. 数值：quality.ts 的映射表与 normalize/merge 语义（esbuild bundle 后真跑）；
 *   2. 接线：renderer/particles/scene-mount/main/api/bench 各入口真的调了这些
 *      函数（文本断言，防「实现了但没人调」）；
 *   3. 变异红测：把关键接线在内存里改坏（粒子倍率丢失、Bloom 门控丢失），确认
 *      对应断言会变红 —— 防「正则只看形状不看语义」的假绿。
 */
import { build } from "esbuild";
import fs from "node:fs";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

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

async function loadQuality() {
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
    return await import(pathToFileURL(tmp).href);
  } finally {
    fs.unlinkSync(tmp);
  }
}

const q = await loadQuality();

// ---------- 1) 数值：映射表与规范化 ----------

// 默认 = 现状（AA off / 粒子 high / 后处理 high），引入前后行为一致
{
  const d = q.normalizeQuality(undefined);
  check(d.antiAliasing === "off" && d.particles === "high" && d.postProcessing === "high",
    "normalizeQuality 缺省 = 全默认（off/high/high）");
}
// 非法值逐键回退默认，合法键保留
{
  const d = q.normalizeQuality({ antiAliasing: "smaa", particles: "low", postProcessing: "potato" });
  check(d.antiAliasing === "off" && d.particles === "low" && d.postProcessing === "high",
    "非法档位回退默认、合法档位保留");
}
// setQuality 的部分更新语义：patch 只覆盖传入键（所有入口共用的 merge 形态）
{
  const merged = { ...q.normalizeQuality(undefined), ...{ particles: "low" } };
  check(merged.antiAliasing === "off" && merged.particles === "low" && merged.postProcessing === "high",
    "部分更新只动传入键，其余保持默认");
}
// 粒子倍率表：off=0（装配层特判）、low/medium 缩、high=1（恒等）
{
  check(q.particleQualityScale("off") === 0, "粒子 off 档倍率 0（装配层走跳过，不经此表）");
  check(q.particleQualityScale("low") === 0.4, "粒子 low 档倍率 0.4");
  check(q.particleQualityScale("medium") === 0.7, "粒子 medium 档倍率 0.7");
  check(q.particleQualityScale("high") === 1, "粒子 high 档倍率 1（恒等）");
}
// 后处理 → fboCapFactor：high=0（全质量）、medium=1（≤屏幕）、low=0.5；off 走
// setEffectsEnabled(false) 不走此表，返回全质量 0（此时 fboCap 无消费者）
{
  check(q.postFboCapFactor("high") === 0, "后处理 high → fboCapFactor 0（全质量）");
  check(q.postFboCapFactor("medium") === 1, "后处理 medium → fboCapFactor 1（≤屏幕）");
  check(q.postFboCapFactor("low") === 0.5, "后处理 low → fboCapFactor 0.5");
  check(q.postFboCapFactor("off") === 0, "后处理 off 档 fboCap 无消费者，返回 0");
}
// query 解析：只认显式出现的键，非法值回退默认
{
  const d = q.qualityFromQuery((k) => ({ aa: "fxaa", pq: "low" })[k] ?? null);
  check(d.antiAliasing === "fxaa" && d.particles === "low" && d.postProcessing === undefined,
    "qualityFromQuery 只带显式出现的键");
  const bad = q.qualityFromQuery((k) => (k === "aa" ? "msaa9" : null));
  check(bad.antiAliasing === "off", "query 非法档位回退默认");
}
// MSAA 档位数表
{
  check(q.MSAA_SAMPLES.msaa2 === 2 && q.MSAA_SAMPLES.msaa4 === 4, "MSAA 档位 → 2/4 采样");
}

// ---------- 2) 接线断言 ----------

const rendererSrc = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/renderer.js"), "utf8");
const glslSrc = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/renderer-glsl.js"), "utf8");
const particlesSrc = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/particles.js"), "utf8");
const mountSrc = fs.readFileSync(join(ROOT, "renderer/src/scene-mount.ts"), "utf8");
const mainSrc = fs.readFileSync(join(ROOT, "renderer/src/main.ts"), "utf8");
const apiMountSrc = fs.readFileSync(join(ROOT, "renderer/src/api/mount.ts"), "utf8");
const benchSrc = fs.readFileSync(join(ROOT, "bench/bench.ts"), "utf8");
const indexSrc = fs.readFileSync(join(ROOT, "index.html"), "utf8");

// 2a) renderer.js：AA/MSAA/后处理门控
{
  check(/setAntiAliasing:\s*function/.test(rendererSrc), "renderer 返回对象有 setAntiAliasing");
  check(/setEffectsEnabled:\s*function/.test(rendererSrc), "renderer 返回对象有 setEffectsEnabled");
  check(/getFrameTarget:\s*function/.test(rendererSrc), "renderer 返回对象有 getFrameTarget（粒子 MSAA 绑定用）");
  check(/captureSceneTexture:\s*function/.test(rendererSrc), "renderer 返回对象有 captureSceneTexture（REFRACT 粒子用）");
  check(/renderbufferStorageMultisample/.test(rendererSrc), "MSAA 走多重采样 renderbuffer");
  check(/blitFramebuffer/.test(rendererSrc), "MSAA resolve 走 blitFramebuffer");
  // WebKit 变通（2026-09-15 实测定案）：「MSAA → 默认帧缓冲」的 blit 在 WebKit
  // （WKWebView/ANGLE Metal）一律 INVALID_OPERATION 静默失败，画面冻在切换前
  // 最后一帧。合法路径 = blit 到同格式 RGBA8 纹理 FBO 再全屏合成回画布。
  // 若改回直接 blit 到 null（默认 FB），WebKit 上 MSAA 整体失效。
  {
    const fn = rendererSrc.slice(rendererSrc.indexOf("function resolveMsaa"), rendererSrc.indexOf("function resolveMsaa") + 1600);
    check(/getFBO\(width, height, 'msaaResolve'\)/.test(fn), "resolve 先 blit 到 msaaResolve 纹理 FBO（WebKit 不接受 blit 到默认 FB）");
    check(!/gl\.bindFramebuffer\(gl\.DRAW_FRAMEBUFFER, null\)\s*\n\s*gl\.blitFramebuffer/.test(fn), "resolve 不得直接 blit 到默认帧缓冲（WebKit INVALID_OPERATION 静默冻结）");
    check(/bindTexture\(gl\.TEXTURE_2D, dst\.tex\)/.test(fn) && /gl\.drawArrays\(gl\.TRIANGLES, 0, 6\)/.test(fn), "resolve 末段把 resolve 纹理全屏合成回画布");
  }
  check(/aaMode === 'fxaa'/.test(rendererSrc), "FXAA pass 只在 fxaa 档执行");
  check(/const bloom = effectsEnabled \? bloomPostParams/.test(rendererSrc), "Bloom 受后处理总开关门控");
  check(/effectsEnabled \? \(layer\.effects \|\| \[\]\)\.filter/.test(rendererSrc), "后处理关档效果列表置空（直通既有无效果路径）");
  check(/!effectsEnabled && layer\.isPostProcess/.test(rendererSrc), "后处理关档跳过整屏后期层");
  check(/ensureMsaaTarget\(width, height\)/.test(rendererSrc), "renderScene 帧首按尺寸/档位重建 MSAA 目标");
  check(/resolveMsaa\(width, height\)/.test(rendererSrc), "bloom 前 resolve MSAA → 默认帧缓冲");
  // FXAA 与 MSAA 互斥：FXAA pass 画到默认帧缓冲（在 resolve 之后），不是 bindFinal
  const fxaaBlock = rendererSrc.slice(rendererSrc.indexOf("aaMode === 'fxaa'"));
  check(/gl\.bindFramebuffer\(gl\.FRAMEBUFFER, null\)/.test(fxaaBlock.slice(0, 1200)), "FXAA pass 输出到默认帧缓冲（resolve 之后的单采样路径）");
}
// 2b) FXAA shader 本体
{
  check(/FXAA_FRAG = `#version 300 es/.test(glslSrc), "FXAA_FRAG 是 GLSL ES 3.00");
  check(/uniform vec2 u_Texel/.test(glslSrc), "FXAA 有 texel 尺寸 uniform");
  check(/FXAA_FRAG/.test(glslSrc) && /export \{[^}]*FXAA_FRAG/.test(glslSrc), "FXAA_FRAG 已导出");
  check(!/gl_FragColor|texture2D|lerp\s*\(|float4/.test(glslSrc.match(/FXAA_FRAG = `[^`]*`/s)?.[0] ?? ""), "FXAA 无 HLSL/旧 GLSL 残留");
}
// 2c) particles.js：质量倍率与帧目标
{
  check(/export function setParticleQualityScale/.test(particlesSrc), "particles 有 setParticleQualityScale");
  check(/export function setParticleFrameTargetProvider/.test(particlesSrc), "particles 有帧目标注入");
  check(/export function setParticleSceneCapture/.test(particlesSrc), "particles 有场景捕获注入（REFRACT MSAA 路径）");
  check(/bindParticleFrameTarget\(gl\)/.test(particlesSrc), "粒子 render 显式绑最终绘制目标");
}
// 2d) 装配层 / 入口
{
  check(/renderer\.setAntiAliasing\?\.\(q\.antiAliasing\)/.test(mountSrc), "scene-mount 应用抗锯齿档");
  check(/renderer\.setEffectsEnabled\?\.\(q\.postProcessing !== "off"\)/.test(mountSrc), "scene-mount 应用后处理开关");
  check(/setParticleQualityScale\?\.\(particleQualityScale\(q\.particles\)\)/.test(mountSrc), "scene-mount 应用粒子倍率");
  check(/particleQualityOff = q\.particles === "off"/.test(mountSrc), "粒子 off 档走推进/渲染跳过");
  check(/setQualityImpl = applyQuality/.test(mountSrc), "sceneCtl.setQuality 热更已接线");
  check(/applyQuality\(normalizeQuality\(cfg\.quality\)\)/.test(mountSrc), "挂载时按 cfg.quality 应用初值");
  check(/qualityFromQuery/.test(mainSrc), "main.ts 解析 aa/pq/pp query");
  check(/setQuality\(patch: QualityOptions\)/.test(mainSrc), "__wp.setQuality 存在");
  check(/getQuality\(\)/.test(mainSrc), "__wp.getQuality 存在");
  // resolveMountConfig 原样透传（规范化在消费方），它会被 verify-media 抽出来
  // 脱离 import 单独执行 —— 不能在这里调 normalizeQuality。
  check(/quality: o\.quality/.test(apiMountSrc), "公共 API resolveMountConfig 带 quality");
  check(/setQuality\(patch: QualityOptions\)/.test(apiMountSrc), "SceneInstance.setQuality 存在");
  check(/p\.set\("aa", aaEl\.value\)/.test(benchSrc) && /p\.set\("pq", pqEl\.value\)/.test(benchSrc) && /p\.set\("pp", ppEl\.value\)/.test(benchSrc),
    "测试台 buildQuery 带 aa/pq/pp");
  check(/webwallgl-quality/.test(benchSrc), "测试台质量设置 localStorage 持久化");
  check(/id="aa"/.test(indexSrc) && /id="pq"/.test(indexSrc) && /id="pp"/.test(indexSrc), "测试台工具条有三个档位下拉");
}

// ---------- 3) 变异红测（在内存里改坏源码，确认对应断言变红）----------
// 防「正则只看形状」：这两处是语义级断言 —— 粒子倍率折进 countMul（只缩上限
// 不缩发射率会让稳态密度不变）、Bloom 必须被后处理总开关门控。断言写完后已
// 各验证一次：变异体能被抓住（FAILED 行出现）、原源码全绿。
{
  // 3a) 把 _applyOverride 的 count 分支改回「不乘质量倍率」
  const mutated = particlesSrc.replace(
    "const m = (Number.isFinite(mul) ? mul : 1) * particleQualityScale",
    "const m = Number.isFinite(mul) ? mul : 1",
  );
  const catches = mutated !== particlesSrc &&
    /const m = \(Number\.isFinite\(mul\) \? mul : 1\) \* particleQualityScale/.test(particlesSrc) &&
    !/const m = \(Number\.isFinite\(mul\) \? mul : 1\) \* particleQualityScale/.test(mutated);
  check(catches, "变异红测：粒子 count 分支的质量倍率丢失会被断言抓住");
  // 3b) 把 Bloom 门控改回「不受后处理总开关控制」
  const mutated2 = rendererSrc.replace(
    "const bloom = effectsEnabled ? bloomPostParams(general) : null",
    "const bloom = bloomPostParams(general)",
  );
  const catches2 = mutated2 !== rendererSrc &&
    /const bloom = effectsEnabled \? bloomPostParams/.test(rendererSrc) &&
    !/const bloom = effectsEnabled \? bloomPostParams/.test(mutated2);
  check(catches2, "变异红测：Bloom 门控丢失会被断言抓住");
}

if (failed) {
  console.error(`\nverify-quality: ${failed} 处失败`);
  process.exit(1);
}
console.log("\nverify-quality: all checks passed");
