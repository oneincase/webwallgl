#!/usr/bin/env node
/**
 * verify-cover-peek —— cover 窥视（顶/底热区滑动）的逐轴门控。
 *
 * 1920911984 类壁纸的误伤：投影画布竖版（1080×5760）、内容是旋转 90° 的横条
 * （世界包围盒 3254×610）。cover 在 16:9 窗口上按画布算纵向溢出 5000+，热区
 * 一碰就把视窗滑出条外（整屏空白）。修复 = 按可见内容包围盒逐轴判定
 * （math.js coverPeekOverflow/coverViewSize + shell.ts peekAxes 门控）。
 *
 * 本文件离线可跑：math.js 纯函数直接 Node import；scene-mount 的包围盒统计
 * 与 shell 的门控接线用源码断言锁住。
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

const math = await import(pathToFileURL(join(ROOT, 'renderer/vendor/we-scene/render/math.js')))
const { coverPeekOverflow, coverViewSize, coverContentBounds, fitWindow } = math
check(typeof coverPeekOverflow === 'function' && typeof coverViewSize === 'function', 'math.js 应导出 coverPeekOverflow / coverViewSize')
check(typeof coverContentBounds === 'function', 'math.js 应导出 coverContentBounds（内容包围盒纯函数）')

console.log('\n[0] coverContentBounds：旋转横条的真实数值（1920911984 唯一可见层）')
{
  // scene.json 原值：size 1080×5760、scale 0.565、angles z=1.571、origin (500,2880)
  const layers = [
    { visible: true, size: [1080, 5760], scale: [0.565, 0.565, 0.7], angles: [0, 0, 1.571], origin: [500, 2880, 0] },
  ]
  const b = coverContentBounds(layers)
  const w = b.maxX - b.minX
  const h = b.maxY - b.minY
  // 旋转 90°：世界 ~3254×610（横向长条），不是 610×3254。
  // 1.571 rad 不是精确 π/2（残差 ~0.7px），容差 1.0。
  check(Math.abs(w - 3254.5) < 1.0 && Math.abs(h - 610.9) < 1.0, `旋转 90° 层的包围盒应换轴为 ~3254×610，实得 ${w.toFixed(1)}×${h.toFixed(1)}`)
  // 不可见/销毁的层不参与
  const b2 = coverContentBounds([
    { visible: false, size: [100, 100], scale: [1, 1, 1], angles: [0, 0, 0], origin: [0, 0, 0] },
    { visible: true, destroyed: true, size: [100, 100], scale: [1, 1, 1], angles: [0, 0, 0], origin: [0, 0, 0] },
  ])
  check(!Number.isFinite(b2.minX), '不可见/销毁层不参与包围盒')
  // 故意改坏对照：把旋转去掉（sizeof 610×3254 竖条）——上面那条断言必须转红
  const b3 = coverContentBounds([
    { visible: true, size: [1080, 5760], scale: [0.565, 0.565, 0.7], angles: [0, 0, 0], origin: [500, 2880, 0] },
  ])
  check(Math.abs((b3.maxX - b3.minX) - 610.2) < 0.5, '对照组：同层不旋转时包围盒是 610×3254（证明换轴断言真的在测旋转）')
}

console.log('\n[1] coverPeekOverflow 真值表')
{
  const T = [
    // 1920911984：竖版画布 1080×5760 + 旋转横条。内容 3254×610，16:9 窗口视窗 1080×607.5
    { desc: '1920911984（横条内容）', pw: 1080, ph: 5760, cw: 3254.4, ch: 610.2, want: { x: true, y: false } },
    // 真竖屏壁纸：内容=画布 1080×1920，16:9 窗口 → 视窗 1080×607.5，纵向裁 1312
    { desc: '真竖屏壁纸（手机比例）', pw: 1080, ph: 1920, cw: 1080, ch: 1920, want: { x: false, y: true } },
    // 16:9 壁纸在 16:9 窗口：内容=画布=视窗，两轴都不该滑
    { desc: '16:9 壁纸在 16:9 窗口', pw: 1920, ph: 1080, cw: 1920, ch: 1080, want: { x: false, y: false } },
    // 超宽条带（32:9）在 16:9 窗口：横向裁切可滑
    { desc: '32:9 超宽内容', pw: 3840, ph: 1080, cw: 3840, ch: 432, want: { x: true, y: false } },
    // 全画布 solid 层：内容=画布 → 与画布溢出一致（竖版画布在 16:9 窗口两轴都裁）
    { desc: '全画布内容、竖版画布', pw: 1080, ph: 5760, cw: 1080, ch: 5760, want: { x: false, y: true } },
  ]
  for (const { desc, pw, ph, cw, ch, want } of T) {
    const v = coverViewSize(pw, ph, 1280, 720)
    const got = coverPeekOverflow(cw, ch, v.viewW, v.viewH)
    check(got.x === want.x && got.y === want.y, `${desc}：期望 x=${want.x} y=${want.y}，实得 x=${got.x} y=${got.y}`)
  }
  // 1920911984 真实数值走一遍 coverViewSize：1080×5760 画布在 1280×720 窗口
  const v = coverViewSize(1080, 5760, 1280, 720)
  check(!!v && Math.abs(v.viewW - 1080) < 1e-6 && Math.abs(v.viewH - 607.5) < 1e-6, `cover 视窗应为 1080×607.5，实得 ${v && v.viewW.toFixed(1)}×${v && v.viewH.toFixed(1)}`)
  // 容差：内容比视窗大 0.4%（1920911984 的 610/607.5）不判溢出
  const tol = coverPeekOverflow(610.2, 3254.4, 610.2, 607.5)
  check(tol.x === false, '内容超出 0.4%（<2% 容差）→ 不溢出')
  // 退化输入：视窗为 0 → 保守放行（与「无基准=既有行为」一致）
  check(coverPeekOverflow(100, 100, 0, 0).x === true, '视窗非法 → 保守放行')
}

console.log('\n[2] coverViewSize 与 fitWindow cover 主路径同式')
{
  // 与 fitWindow 的 cover 输出对齐（除 align 外同值）——门控看的视窗必须是渲染真实用的
  const fw = fitWindow('cover', 1080, 5760, 1280, 720, 0.5, 0.5)
  const cv = coverViewSize(1080, 5760, 1280, 720)
  check(Math.abs(fw.viewW - cv.viewW) < 1e-9 && Math.abs(fw.viewH - cv.viewH) < 1e-9, 'coverViewSize ≡ fitWindow(cover) 的视窗尺寸')
}

console.log('\n[3] 接线：scene-mount 写基准、shell 按轴门控')
{
  const mount = fs.readFileSync(join(ROOT, 'renderer/src/scene-mount.ts'), 'utf8')
  check(/rt\.coverPeek = \{/.test(mount), 'scene-mount 挂载时应写 rt.coverPeek（内容包围盒基准）')
  check(/coverContentBounds\(scene\.layers/.test(mount), 'scene-mount 应用 coverContentBounds(scene.layers) 计算基准')
  check(/import \{ fitWindow, coverContentBounds \} from "\.\.\/vendor\/we-scene\/render\/math\.js";/.test(mount), 'scene-mount 从 math.js 引入 coverContentBounds')

  const mathSrc = fs.readFileSync(join(ROOT, 'renderer/vendor/we-scene/render/math.js'), 'utf8')
  check(/l\.angles\?\.\[2\]/.test(mathSrc), '包围盒必须吃图层 z 旋转（旋转横条的 AABB 换轴）')
  check(/l\.visible === false \|\| l\.destroyed/.test(mathSrc), '只统计可见层')

  const shell = fs.readFileSync(join(ROOT, 'renderer/src/shell.ts'), 'utf8')
  check(/function peekAxes\(rt: Runtime\)/.test(shell), 'shell 应有 peekAxes 门控函数')
  check(/rt\.coverAlign\.ty = axes\.y \? axisTarget\(/.test(shell), 'onCoverPointer 按轴门控 target')
  check(/if \(!axes\.y\) rt\.coverAlign\.ty = 0\.5;/.test(shell), 'advanceCoverAlign 把无溢出轴钉回居中（防热区残留 target）')
  check(/coverPeekOverflow, coverViewSize \} from "\.\.\/vendor\/we-scene\/render\/math\.js"/.test(shell), 'shell 从 math.js 引入门控纯函数')
}

console.log(failed === 0 ? '\nverify-cover-peek: 全部通过 ✓' : `\nverify-cover-peek: ${failed} 项失败 ✗`)
process.exit(failed === 0 ? 0 : 1)
