#!/usr/bin/env node
/**
 * verify-bloom —— 内置 Bloom 后期（general.bloom）参数映射与 shader 保真。
 *
 * 「部分壁纸提供 HDR 属性、切换后无任何效果」的根因：hdr 属性绑在
 * general.bloom 上（2902406982 / 3287715210 / 3299228616 / 3764725758 一整族），
 * 而内置 Bloom 此前没有消费者。修复 = WE localeffects "Bloom"（2822917890）
 * 整屏后期转写（light_map → 双向高斯 → Add apply）+ bloomPostParams 参数映射
 * + applyLiveProps 补 general 绑定热更。
 *
 * 端到端数值判据（3299228616 测试台实测，交替开关抵动画漂移）：
 *   bloom on/off 全帧精确均值 = 58.97 / 54.71 / 58.87 / 53.83 / 58.94（+8.5%）。
 */
import fs from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const here = join(fileURLToPath(import.meta.url), '..')
const ROOT = join(here, '..')

let failed = 0
function check(ok, msg) {
  if (ok) {
    console.log(`  ✓ ${msg}`)
  } else {
    failed++
    console.error(`  ✗ ${msg}`)
  }
}

const renderer = await import(pathToFileURL(join(ROOT, 'renderer/vendor/we-scene/render/renderer.js')))
const bloomPostParams = renderer.bloomPostParams
check(typeof bloomPostParams === 'function', 'renderer.js 应导出 bloomPostParams 纯函数')

console.log('\n[1] bloomPostParams 真值表（fixtures 取自真实壁纸 scene.json general）')
{
  const F = {
    off: {},
    classic: { bloom: true, bloomstrength: 2, bloomthreshold: 0.65, bloomtint: '0.84 0.84 0.84' },
    w3299228616: {
      bloom: { user: 'hdr', value: true }, bloomhdrfeather: 0.30000001, bloomhdriterations: 8,
      bloomhdrscatter: 1.619, bloomhdrstrength: 1, bloomhdrthreshold: 1,
      bloomstrength: 2, bloomthreshold: 0.64999998, bloomtint: '0.83922 0.83922 0.83922', hdr: true,
    },
    w2902406982: {
      bloom: { user: 'hdr', value: true }, bloomhdrfeather: 0, bloomhdriterations: 5,
      bloomhdrscatter: 0.85000002, bloomhdrstrength: 0.75, bloomhdrthreshold: 1,
      bloomstrength: 1, bloomthreshold: 1, bloomtint: '1.00000 1.00000 1.00000', hdr: true,
    },
    w3287715210: {
      bloom: { user: 'hdr', value: true }, bloomhdrfeather: 0, bloomhdriterations: 2,
      bloomhdrscatter: 0, bloomhdrstrength: 0, bloomhdrthreshold: 1,
      bloomstrength: 0, bloomthreshold: 1, bloomtint: '1.00000 1.00000 1.00000', hdr: true,
    },
    toggledOff: { bloom: { user: 'hdr', value: false }, bloomhdrstrength: 1, hdr: true },
    iterClamp: { bloom: true, hdr: true, bloomhdriterations: 0 },
  }
  check(bloomPostParams(F.off) === null, '无 bloom 字段 → null（不跑后期）')
  check(bloomPostParams(F.toggledOff) === null, 'hdr 属性切到 false → null（开关热更语义）')

  const c = bloomPostParams(F.classic)
  check(!!c && c.hdr === false && c.strength === 2 && c.threshold === 0.65, '经典家族：strength/threshold 取 bloomstrength/bloomthreshold')
  check(!!c && c.iterations === 8 && c.radius === 3 && c.damp === 0.5, '经典家族未指定的迭代/散射/软边 = 材质默认 8/3/0.5')
  check(!!c && Math.abs(c.tint[0] - 0.84) < 1e-3, '经典家族 tint 解析')
  check(!!c && c.metric === 0, '经典家族 = 材质原样判定（gamma+求和）')

  const h = bloomPostParams(F.w3299228616)
  check(!!h && h.hdr === true && h.strength === 1 && h.threshold === 1, 'HDR 家族：strength/threshold 取 bloomhdrstrength/bloomhdrthreshold')
  check(!!h && h.iterations === 8 && h.radius === 1.619 && Math.abs(h.damp - 0.3) < 1e-6, 'HDR 家族：iterations/scatter→radius/feather→damp')
  check(!!h && Math.abs(h.tint[0] - 0.83922) < 1e-4, 'HDR 家族 tint 仍取 bloomtint')
  check(!!h && h.metric === 1, 'HDR 家族 = raw sRGB 亮度软窗口判定（过曝修复）')

  const h2 = bloomPostParams(F.w2902406982)
  check(!!h2 && h2.strength === 0.75 && h2.iterations === 5 && Math.abs(h2.radius - 0.85) < 1e-4 && h2.damp === 0, '2902406982 参数组')

  const z = bloomPostParams(F.w3287715210)
  check(!!z && z.strength === 0, '3287715210 strength=0 → 解析成功但调用方按 WE 原语义跳过（三段 shader 全直通）')

  const ic = bloomPostParams(F.iterClamp)
  check(!!ic && ic.iterations === 1, 'iterations 下限 clamp 到 1（blur 循环 ±iterations）')
}

console.log('\n[2] shader 保真（renderer-glsl.js 与 localeffects/Bloom 2822917890 逐条对号）')
{
  const glslSrc = fs.readFileSync(join(ROOT, 'renderer/vendor/we-scene/render/renderer-glsl.js'), 'utf8')
  const T = [
    [/const BLOOM_LIGHTMAP_FRAG = `#version 300 es/, 'BLOOM_LIGHTMAP_FRAG 定义'],
    [/const BLOOM_BLUR_FRAG = `#version 300 es/, 'BLOOM_BLUR_FRAG 定义'],
    [/const BLOOM_APPLY_FRAG = `#version 300 es/, 'BLOOM_APPLY_FRAG 定义'],
    // 经典家族 = WE 引擎 downsample_quarter_bloom 逐行转写（2026-09-11 换真身，
    // 详见 CASEBOOK「场景 bloom 整屏冲白」）：4 抽头平均（无 gamma）→
    // saturate(max 通道 - threshold) 软拐点 → 饱和度 ×2 → ×strength 一次
    [/v_TexCoord\[3\] = a_TexCoord \+ offsets;/, 'light_map 4 抽头对角采样'],
    [/albedo \*= 0\.25;/, '4 抽头平均（无 gamma 预整）'],
    [/float scale = max\(max\(albedo\.x, albedo\.y\), albedo\.z\);/, '软拐点取 max 通道（不是 r+g+b 求和）'],
    [/albedo \*= clamp\(scale - u_Threshold, 0\.0, 1\.0\);/, 'saturate(scale - threshold) 软拐点（只留超阈能量）'],
    [/albedo = -grayscale \+ albedo \* 2\.0;/, '饱和度 ×2（引擎 sat=1 原式）'],
    [/lightMap = max\(vec3\(0\.0\), albedo \* u_Strength\);/, 'strength 在亮部提取段乘一次'],
    [/uniform int u_Metric;/, '亮度判定口径开关（经典/HDR 家族分流）'],
    // HDR 家族的 SDR 等效判定：raw sRGB 亮度 + 软窗口（2646504847 过曝修复，保持既有校准）
    [/smoothstep\(u_Threshold - 0\.2, u_Threshold \+ 0\.4, dot\(samplec, vec3\(0\.2126, 0.7152, 0.0722\)\)\)/, 'HDR 家族：raw sRGB 亮度软窗口（threshold 以 1.0=白点标定）'],
    [/lightMap = lightMap \* max\(0\.001, mix\(weight, 1\.0, v_Damp\)\) \/ 4\.0 \* u_Strength \* u_Strength;/, 'HDR 分支 strength 双乘（补偿 blur 不再乘，与旧行为逐位一致）'],
    // blur：能量守恒归一，不乘 strength（引擎 blur_h_bloom 同）；±iterations、exp(-|n|*0.1) 权重、Scatter 步长
    [/weight = exp\(-abs\(n\) \* 0\.1\);/, '高斯权重 exp(-|n|*0.1)'],
    [/u_Dir \* \(n \* v_SizeMultiplier\)/, '方向 × Scatter 缩放步长'],
    [/albedo = albedo \/ divisor;/, 'blur 只做能量守恒归一（strength 不再双程叠乘）'],
    [/if \(abs\(float\(i\)\) > iterations\) continue;/, 'iterations 动态上限'],
  ]
  for (const [re, msg] of T) check(re.test(glslSrc), msg)
  // 反向断言：旧的错误亮部判定（gamma 预整 + 三通道求和硬判定）不得回归
  // —— 它让亮场景 90%+ 像素全值通过，是 3791670523/3793592591/820654165 冲白的根因
  check(!/pow\(samplec, vec3\(u_Gamma\)\)/.test(glslSrc), '经典家族不得再 gamma 预整（引擎原版无 gamma）')
  check(!/if \(luma > u_Threshold\)/.test(glslSrc), '经典家族不得再用「求和 > threshold」硬判定')
  check(!/albedo \* u_Strength \/ divisor/.test(glslSrc), 'blur 不得再乘 strength（亮部提取段已乘一次）')
}

console.log('\n[3] 接线：renderScene 尾部挂后期 + 缓冲 1/4 分辨率 + Add 合成 + general 热更')
{
  const rd = fs.readFileSync(join(ROOT, 'renderer/vendor/we-scene/render/renderer.js'), 'utf8')
  check(/const bloom = bloomPostParams\(general\)/.test(rd), 'renderScene 读取 bloom 门控')
  check(/applyBloomPost\(bloom, width, height\)/.test(rd), '门控通过时调用 applyBloomPost')
  check(/bloom post: on strength=/.test(rd), '一次性诊断输出 bloom 参数（HDR 无效果时的定位入口）')
  check(/Math\.round\(width \/ 4\)/.test(rd), 'bloom 缓冲 1/4 分辨率（effect.json scale:4）')
  check(/'bloomA'\)/.test(rd) && /'bloomB'\)/.test(rd), 'bloomA/bloomB 独立 FBO（getFBO 按尺寸+tag 缓存）')
  check(/gl\.blendFunc\(gl\.ONE, gl\.ONE\)/.test(rd), 'apply = Add（ONE/ONE 只加 rgb，alpha +0）')
  check(/const sceneTex = captureBackdrop\(width, height\)/.test(rd), '场景纹理复用 captureBackdrop 画布回读（不动主循环）')

  const mount = fs.readFileSync(join(ROOT, 'renderer/src/scene-mount.ts'), 'utf8')
  check(
    /resolveUserProps\(\(scene as any\)\.general \|\| \{\}, properties, 0\)/.test(mount),
    'applyLiveProps 必须热更 general 绑定（此前只逐层 resolve，HDR 开关永远停在挂载快照）',
  )
}

console.log(failed === 0 ? '\nverify-bloom: 全部通过 ✓' : `\nverify-bloom: ${failed} 项失败 ✗`)
process.exit(failed === 0 ? 0 : 1)
