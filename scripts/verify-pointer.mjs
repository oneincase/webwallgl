#!/usr/bin/env node
/**
 * 指针互动的离线校验（纯 node，可进 CI）。
 *
 * 为什么需要它：指针互动的失败模式**在画面上看不出来** ——
 * shader 编过了但 uniform 恒零、回调注册了但命中判定偏了、脚本拿到 NaN 坐标，
 * 全都表现为「壁纸照常显示、就是没反应」，没有任何报错。
 * 所以判据必须是数值与结构断言，而不是「渲染没报错」。
 *
 * 八组校验：
 *   1. OBB hit-test：正变换（逐字复刻 layerModelMatrix + compositeLayer 的
 *      mat4Scale）→ 逆变换往返误差；旋转/缩放/alignment/视差组合；z 序取最上层；
 *      父链隐藏层不参与命中。
 *   2. 屏幕→世界换算：cover / contain / stretch 三种 fit 下的往返一致性。
 *   3. 指针源状态机：last 按帧推进（不是按事件）、leftDown 只跟左键、
 *      离开窗口清 leftDown、首帧 last 与 current 对齐。
 *   4. 全库 cursor* 回调过沙箱：解析失败必须为 0（对齐 verify-text 的既有标准），
 *      并统计 6 个回调各自的挂钩数。
 *   5. 指针 shader 转译产物：mul() 结果带括号、无 mat4×vec3、无 include 缺失，
 *      且 g_EffectTextureProjectionMatrixInverse / g_Frametime / g_PointerState
 *      这些「改动前从未绑定」的 uniform 确实出现在声明里（防回归）。
 *   8. 粒子 controlpoint flags bit0 锁鼠标 + eventfollow 子级跟随父粒子
 *      （1425503532 Pac-Man：无脚本、无 locktopointer 字段）。
 */
import fs from 'node:fs'
import path from 'node:path'

import { LIB, ROOT, createChecker, imp } from './lib/verify-kit.mjs'

// headers.ts 由 Node 24 的类型擦除直接载入（verify-kit 的 imp）。
// 不能再拷到 os.tmpdir() 转译：headers.ts 新增了相对 import（./render/renderer-glsl.js），
// 拷到临时目录后该相对路径解析到 tmpdir 下而报 ERR_MODULE_NOT_FOUND。

const { parsePkg, getEntry } = await import(path.join(ROOT, 'renderer/vendor/we-scene/pkg/container.js'))
const mathMod = await import(path.join(ROOT, 'renderer/vendor/we-scene/render/math.js'))
const { worldToLayerLocal, hitTestLayers } = await import(path.join(ROOT, 'renderer/vendor/we-scene/render/hittest.js'))
const { createPointerSource } = await import(path.join(ROOT, 'renderer/vendor/we-scene/render/pointer.js'))
const { evalObjectScript, evalTextScript, createInputView, makeCursorEventVec } = await import(path.join(ROOT, 'renderer/vendor/we-scene/render/text.js'))
const { hlsl2glsl } = await import(path.join(ROOT, 'renderer/vendor/we-scene/render/hlsl2glsl.js'))
const { parseMDL, computeSkinMatrices } = await import(path.join(ROOT, 'renderer/vendor/we-scene/render/mdl.js'))
const { parseScene, recomposeWorld, collectTransformDirty } = await import(path.join(ROOT, 'renderer/vendor/we-scene/scene/parse.js'))
const { ParticleSystem } = await import(path.join(ROOT, 'renderer/vendor/we-scene/render/particles.js'))
const { WE_SHADER_HEADERS } = await imp('renderer/vendor/we-scene/headers.ts')

const { mat4Identity, mat4Translate, mat4RotateZ, mat4Scale, mat4TransformPoint, mat4Invert, fitWindow, parallaxDepthFactor } = mathMod

// ALIGN 与渲染器保持单一真源
const { ALIGN, effectFboSize } = await import(path.join(ROOT, 'renderer/vendor/we-scene/render/renderer.js'))
  .catch(() => ({ ALIGN: null, effectFboSize: null }))
const ALIGN_TABLE = ALIGN || {
  center: [0.5, 0.5], left: [0, 0.5], right: [1, 0.5], top: [0.5, 0], bottom: [0.5, 1],
  topleft: [0, 0], topright: [1, 0], bottomleft: [0, 1], bottomright: [1, 1],
}

const { fail, errors } = createChecker({ echo: true })
const ok = (msg) => console.log('  ✓ ' + msg)

// ---------------------------------------------------------------- 1. OBB
console.log('\n【1. OBB hit-test】')
{
  const projH = 1080
  // 逐字复刻 renderer.js 的 layerModelMatrix + compositeLayer 的 mat4Scale
  const forward = (layer, lx, ly, parX = 0, parY = 0) => {
    const w = layer.size[0] * layer.scale[0]
    const h = layer.size[1] * layer.scale[1]
    let m = mat4Identity()
    m = mat4Translate(m, layer.origin[0], projH - layer.origin[1], layer.origin[2] || 0)
    if (layer.parallaxDepth && (parX !== 0 || parY !== 0)) {
      const fx = parallaxDepthFactor(layer.parallaxDepth[0])
      const fy = parallaxDepthFactor(layer.parallaxDepth[1])
      m = mat4Translate(m, fx * parX, fy * parY, 0)
    }
    m = mat4RotateZ(m, -layer.angles[2])
    const a = ALIGN_TABLE[layer.alignment] || [0.5, 0.5]
    // 锚点偏移单位是**像素**（乘 w/h），且 x 取 (0.5-ax)：mat4Scale 在它右侧，
    // 放大不到这句平移。写成局部 quad 单位等于没偏（柱子沉出画面）。
    if (a[0] !== 0.5 || a[1] !== 0.5) m = mat4Translate(m, (0.5 - a[0]) * w, (0.5 - a[1]) * h, 0)
    m = mat4Scale(m, w, h, 1)
    return mat4TransformPoint(m, lx, ly, 0)
  }
  const L = (o) => Object.assign({ visible: true, angles: [0, 0, 0], alignment: 'center', scale: [1, 1, 1] }, o)
  const cases = [
    ['轴对齐', L({ origin: [500, 400, 0], size: [200, 100] })],
    ['旋转 30°', L({ origin: [500, 400, 0], size: [200, 100], angles: [0, 0, Math.PI / 6] })],
    ['旋转+非等比缩放', L({ origin: [300, 700, 0], size: [400, 80], scale: [1.5, 2, 1], angles: [0, 0, -0.87] })],
    ['alignment=bottom（音频条基准）', L({ origin: [900, 200, 0], size: [60, 300], alignment: 'bottom' })],
    ['alignment=topleft+旋转', L({ origin: [100, 100, 0], size: [120, 90], angles: [0, 0, 0.4], alignment: 'topleft' })],
    ['alignment=right+缩放', L({ origin: [700, 300, 0], size: [150, 60], scale: [2, 1, 1], angles: [0, 0, -0.3], alignment: 'right' })],
    ['对象视差', L({ origin: [640, 540, 0], size: [300, 200], angles: [0, 0, 0.2], parallaxDepth: [1, 1] }), [40, -25]],
  ]
  let worst = 0
  for (const [name, layer, par] of cases) {
    const [pX, pY] = par || [0, 0]
    let bad = false
    for (const [lx, ly] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5], [0, 0], [0.3, -0.2], [0.49, 0.49]]) {
      const wp = forward(layer, lx, ly, pX, pY)
      const b = worldToLayerLocal(layer, wp[0], wp[1], projH, pX, pY, ALIGN_TABLE)
      const e = Math.max(Math.abs(b.lx - lx), Math.abs(b.ly - ly))
      worst = Math.max(worst, e)
      if (e > 1e-4) bad = true
    }
    // 内命中、外不命中
    const ctr = forward(layer, 0, 0, pX, pY)
    const out = forward(layer, 0.62, 0, pX, pY)
    const hIn = hitTestLayers([layer], ctr[0], ctr[1], projH, { parOffX: pX, parOffY: pY, alignTable: ALIGN_TABLE })
    const hOut = hitTestLayers([layer], out[0], out[1], projH, { parOffX: pX, parOffY: pY, alignTable: ALIGN_TABLE })
    if (!hIn || hOut) bad = true
    if (bad) fail(`${name}：往返或命中判定不符`)
  }
  if (worst > 1e-4) fail(`往返误差过大：${worst.toExponential(2)}`)
  else ok(`7 组几何用例往返一致（最大误差 ${worst.toExponential(2)}）`)

  // ---- 视差符号：hittest 与 renderer 必须同号 ----
  //
  // 上面的往返用例**锁不住这个**：forward() 是这份测试自己抄的一份实现，
  // 它和 hittest 一起写错符号时往返照样自洽。01ba726 把 layerModelMatrix 的对象视差
  // 从 −f 改成 +f（相机固定、层正向平移），hittest 漏改，测试也跟着漏改，
  // 于是三处一致地错着，全绿了半年 —— 带 parallaxDepth 的层画面在一边、命中区在另一边，
  // 偏移量是渲染位移的两倍。小控件直接点不中（3148125112 的丝袜按钮屏上仅 16.7px）。
  //
  // 所以判据只能是**读两份真实源码比符号**，不能再自己抄第三份。
  {
    const rdSrc = fs.readFileSync(path.join(ROOT, 'renderer/vendor/we-scene/render/renderer.js'), 'utf8')
    const htSrc = fs.readFileSync(path.join(ROOT, 'renderer/vendor/we-scene/render/hittest.js'), 'utf8')
    // renderer：mat4Translate(m, ±fx * layerParallaxScaleX, ...)
    const rd = /mat4Translate\(\s*m\s*,\s*(-?)fx\s*\*\s*layerParallaxScaleX/.exec(rdSrc)
    // hittest：cx += ±fx * parOffX
    const ht = /cx\s*\+=\s*(-?)fx\s*\*\s*parOffX/.exec(htSrc)
    if (!rd) fail('renderer.js 里找不到对象视差平移（layerModelMatrix 结构变了，本断言需同步）')
    else if (!ht) fail('hittest.js 里找不到对象视差偏移（worldToLayerLocal 结构变了，本断言需同步）')
    else if (rd[1] !== ht[1]) {
      fail(`对象视差符号不一致：renderer 用 ${rd[1] || '+'}f，hittest 用 ${ht[1] || '+'}f` +
        ' —— 带 parallaxDepth 的层命中区会偏到画面另一侧')
    } else {
      ok(`对象视差符号两处一致（均为 ${rd[1] || '+'}f × parOff）`)
    }

    // XY 基准都取负（朝指针方向看，近景与鼠标反向漂）。不要改成翻 f(d)——
    // 那会让 depth=0 再次变成动得最厉害的层。
    const xAssign = /layerParallaxScaleX\s*=\s*-\s*\(?\s*rawOffX\s*\*\s*damp/.exec(rdSrc)
    const yAssign = /layerParallaxScaleY\s*=\s*-\s*\(?\s*rawOffY\s*\*\s*damp/.exec(rdSrc)
    if (!xAssign) {
      fail('renderer.js 里 layerParallaxScaleX 必须赋值为 -(rawOffX * damp)' +
        '（否则视差左右跟鼠标同向）')
    } else if (!yAssign) {
      fail('renderer.js 里 layerParallaxScaleY 必须赋值为 -(rawOffY * damp)' +
        '（否则视差上下跟鼠标同向）')
    } else {
      ok('对象视差 XY 基准均取负（近景与鼠标反向）')
    }
  }

  // ---- alignment 绝对语义：origin 必须真的落在对应的边/角上 ----
  //
  // 同样锁不住于往返用例：forward() 是本测试自抄的一份实现，它和 renderer
  // 一起写错时往返仍然自洽。实际就这么错过 —— 锚点偏移被写成局部 quad 单位
  // （(ax-0.5, 0.5-ay)，量级 <1px），而 mat4Scale 在它右侧、放大不到这句平移，
  // 于是非 center 层等效仍绕中心对齐；x 分量的符号还反了一个层宽。
  // 3148125112「柱子/柱子布料」（bottom，应上移 526px）整根沉出画面底部，
  // 只剩顶端露在人物左脚下方，看着像被裁掉；「指针」（topright）横向差 1634px。
  //
  // 判据是绝对的：把局部 quad 的四角变换到世界，检查 origin 落在期望的边/角。
  {
    const W = 100, H = 200
    const expect = {
      center: [-0.5, -0.5], left: [0, -0.5], right: [-1, -0.5],
      top: [-0.5, 0], bottom: [-0.5, -1],
      topleft: [0, 0], topright: [-1, 0], bottomleft: [0, -1], bottomright: [-1, -1],
    }
    let bad = []
    for (const [align, [fx, fy]] of Object.entries(expect)) {
      const layer = L({ origin: [500, 400, 0], size: [W, H], alignment: align })
      const tl = forward(layer, -0.5, -0.5)
      // 期望的左上角世界坐标（y-down：projH - origin[1]）
      const wantX = 500 + fx * W
      const wantY = (projH - 400) + fy * H
      if (Math.abs(tl[0] - wantX) > 1e-3 || Math.abs(tl[1] - wantY) > 1e-3) {
        bad.push(`${align}: 左上角 (${tl[0].toFixed(1)},${tl[1].toFixed(1)}) 应为 (${wantX},${wantY})`)
      }
    }
    if (bad.length) fail(`alignment 锚点语义错误 ${bad.length}/9：` + bad[0])
    else ok('alignment 9 种取值：origin 都落在对应的边/角上（偏移量按像素计）')
  }

  // z 序 / 可见性
  const big = L({ origin: [500, 500, 0], size: [400, 400], name: 'big' })
  const small = L({ origin: [500, 500, 0], size: [200, 200], name: 'small' })
  const hidden = L({ origin: [500, 500, 0], size: [300, 300], name: 'hidden', visible: false })
  const p = forward(small, 0, 0)
  const top = hitTestLayers([big, hidden, small], p[0], p[1], projH, { alignTable: ALIGN_TABLE })
  if (!top || top.name !== 'small') fail(`z 序未取最上层（得到 ${top && top.name}）`)
  else ok('z 序取最上层命中')
  const skip = hitTestLayers([big, hidden], p[0], p[1], projH, { alignTable: ALIGN_TABLE })
  if (!skip || skip.name !== 'big') fail(`隐藏层未被跳过（得到 ${skip && skip.name}）`)
  else ok('隐藏层（父链不可见）不参与命中')
  // filter：只在挂了回调的层里找
  const only = hitTestLayers([big, small], p[0], p[1], projH, { alignTable: ALIGN_TABLE, filter: (l) => l.name === 'big' })
  if (!only || only.name !== 'big') fail('filter 未生效（应跳过未挂回调的上层）')
  else ok('filter 生效：上层未挂回调时不挡住下层')
}

// -------------------------------------------------- 2. 屏幕→世界（三种 fit）
console.log('\n【2. 屏幕→世界换算】')
{
  const projW = 3840, projH = 2160
  let bad = 0
  for (const fit of ['cover', 'contain', 'stretch']) {
    const win = fitWindow(fit, projW, projH, 1280, 800)
    for (const [u, v] of [[0, 0], [0.5, 0.5], [1, 1], [0.25, 0.75]]) {
      const wx = win.offX + u * win.viewW
      const wy = win.offY + v * win.viewH
      // 逆算回归一化
      const bu = (wx - win.offX) / win.viewW
      const bv = (wy - win.offY) / win.viewH
      if (Math.abs(bu - u) > 1e-9 || Math.abs(bv - v) > 1e-9) bad++
    }
    // 中心必须映射到可见窗口中心
    const cx = win.offX + 0.5 * win.viewW
    if (Math.abs(cx - (win.offX + win.viewW / 2)) > 1e-9) bad++
  }
  if (bad) fail(`fit 换算往返不一致（${bad} 处）`)
  else ok('cover / contain / stretch 三种 fit 换算往返一致')
  // Y 不翻转：与 mat4Ortho(top=offY) 的世界 y 向下一致
  const win = fitWindow('stretch', projW, projH, 1280, 800)
  const topWorldY = win.offY + 0 * win.viewH
  const botWorldY = win.offY + 1 * win.viewH
  if (!(topWorldY < botWorldY)) fail('世界 Y 朝向错误：屏幕顶应对应较小的世界 y')
  else ok('世界 Y 向下（屏幕顶 → 小 y），与 mat4Ortho / hit-test 同空间')

  // 竖屏 cover：默认居中裁切，alignY 能滑到顶/底，方便热区预览被裁掉的部分
  {
    const pW = 1080, pH = 1920, W = 1920, H = 1080
    const mid = fitWindow('cover', pW, pH, W, H)
    const top = fitWindow('cover', pW, pH, W, H, 0.5, 0)
    const bot = fitWindow('cover', pW, pH, W, H, 0.5, 1)
    if (Math.abs(mid.offX) > 1e-6) fail(`竖屏 cover 不应左右裁切，offX=${mid.offX}`)
    else if (!(mid.offY > 1)) fail(`竖屏 cover 应上下裁切，offY=${mid.offY}`)
    else if (Math.abs(top.offY) > 1e-6) fail(`alignY=0 应看到顶（offY=0），实得 ${top.offY}`)
    else if (Math.abs(bot.offY - (pH - bot.viewH)) > 1e-6) fail(`alignY=1 应看到底，offY=${bot.offY}`)
    else if (Math.abs(mid.offY - (pH - mid.viewH) * 0.5) > 1e-6) fail('缺省 align 不再居中')
    else ok('竖屏 cover：居中裁切，alignY 0/1 能扫到顶底')
  }
  {
    const pW = 1920, pH = 1080, W = 1080, H = 1920
    const mid = fitWindow('cover', pW, pH, W, H)
    const left = fitWindow('cover', pW, pH, W, H, 0, 0.5)
    if (!(mid.offX > 1) || Math.abs(mid.offY) > 1e-6) fail('横屏 cover 应左右裁切、不上下裁')
    else if (Math.abs(left.offX) > 1e-6) fail(`alignX=0 应看到左（offX=0），实得 ${left.offX}`)
    else ok('横屏 cover：alignX 能扫到左缘')
  }

  // 3264246690：场景正交 5120×1440（32:9）。默认 cover 裁剪逻辑不变——
  // 窗口已是 16:9/16:10/21:9/32:9 时按设计高度满幅对齐（不再裁顶底），
  // 对不上再走普通 cover。不要把 cover 改成 stretch。
  {
    const pW = 5120, pH = 1440
    const cases = [
      { name: '16:9', W: 1920, H: 1080, viewW: 2560, viewH: 1440, offX: 1280 },
      { name: '16:10', W: 1920, H: 1200, viewW: 2304, viewH: 1440, offX: 1408 },
      { name: '21:9', W: 3360, H: 1440, viewW: 3360, viewH: 1440, offX: 880 },
      { name: '32:9', W: 5120, H: 1440, viewW: 5120, viewH: 1440, offX: 0 },
    ]
    let bad = 0
    for (const c of cases) {
      const win = fitWindow('cover', pW, pH, c.W, c.H)
      if (Math.abs(win.viewW - c.viewW) > 1e-6 || Math.abs(win.viewH - c.viewH) > 1e-6) {
        fail(`3264246690 ${c.name} cover 窗口 ${win.viewW}×${win.viewH}，期望 ${c.viewW}×${c.viewH}`)
        bad++
      } else if (Math.abs(win.offX - c.offX) > 1e-6 || Math.abs(win.offY) > 1e-6) {
        fail(`3264246690 ${c.name} cover 偏移 offX=${win.offX} offY=${win.offY}，期望 ${c.offX},0`)
        bad++
      }
    }
    // 略偏的 16:9 / 32:9（DPR 取整）必须仍满设计高度，不能裁头顶
    const near16 = fitWindow('cover', pW, pH, 1920, 1081)
    const near32 = fitWindow('cover', pW, pH, 5120, 1435)
    if (Math.abs(near16.viewH - 1440) > 1e-6 || Math.abs(near16.offY) > 1e-6) {
      fail(`近 16:9 应贴设计高度 1440、offY=0，实得 viewH=${near16.viewH} offY=${near16.offY}`)
      bad++
    } else if (Math.abs(near32.viewW - 5120) > 1e-6 || Math.abs(near32.offY) > 1e-6) {
      fail(`近 32:9 应贴满设计、不裁顶，实得 viewW=${near32.viewW} offY=${near32.offY}`)
      bad++
    }

    // contain 在 16:9 窗口必须看到整张 32:9（左右留边），不能跟 cover 一样只显示中间 2560。
    // 2887099508 那种 16:9 场景在 16:9 预览里 contain≈cover 是对的；超宽场景切 contain 必须有反应。
    const contain16 = fitWindow('contain', pW, pH, 1920, 1080)
    const cover16 = fitWindow('cover', pW, pH, 1920, 1080)
    if (Math.abs(contain16.viewW - cover16.viewW) < 1) {
      fail(`32:9 场景 16:9 窗口：contain viewW=${contain16.viewW} 不应等于 cover ${cover16.viewW}（切 contain 会看起来没反应）`)
      bad++
    } else if (Math.abs(contain16.viewW - 5120) > 1e-6) {
      fail(`32:9 contain 应看到整宽 5120，实得 ${contain16.viewW}`)
      bad++
    }
    // 16:9 场景在 16:9 窗口：contain 与 cover 窗口应接近（测试台锁 16:9 时切 contain 几乎没变化）
    const sW = 6080, sH = 3420
    const c16 = fitWindow('cover', sW, sH, 1920, 1080)
    const n16 = fitWindow('contain', sW, sH, 1920, 1080)
    if (Math.abs(c16.viewW - n16.viewW) > sW * 0.02 || Math.abs(c16.viewH - n16.viewH) > sH * 0.02) {
      fail(`16:9 场景 16:9 窗口 contain/cover 应接近，cover ${c16.viewW}×${c16.viewH} contain ${n16.viewW}×${n16.viewH}`)
      bad++
    }

    if (!bad) ok('3264246690 cover 四档对齐设计高度；contain 在 16:9 窗口能看到整张 32:9')
  }
}

// ---------------------------------------------------- 3. 指针源状态机
console.log('\n【3. 指针源状态机】')
{
  // 假 target：不依赖浏览器
  const handlers = new Map()
  const target = {
    addEventListener: (n, fn) => handlers.set(n, fn),
    removeEventListener: (n) => handlers.delete(n),
  }
  globalThis.window = { innerWidth: 1000, innerHeight: 500 }
  const src = createPointerSource({ target })
  const emit = (n, ev) => { const h = handlers.get(n); if (h) h(ev) }

  emit('mousemove', { clientX: 200, clientY: 100 })
  if (Math.abs(src.state.u - 0.2) > 1e-9 || Math.abs(src.state.v - 0.2) > 1e-9) fail('归一化坐标错误')
  else ok('归一化 [0,1]、Y 朝下（原始屏幕空间）')
  if (src.state.screenX !== 200 || src.state.screenY !== 100) fail('屏幕像素坐标错误')
  else ok('屏幕像素坐标（input.cursorScreenPosition 空间）')

  // last 按帧推进：同一帧内多次事件不改 last
  src.beginFrame()
  emit('mousemove', { clientX: 400, clientY: 100 })
  emit('mousemove', { clientX: 600, clientY: 100 })
  if (Math.abs(src.state.lastU - 0.2) > 1e-9) {
    fail(`last 被事件改写（应按帧推进）：lastU=${src.state.lastU}`)
  } else ok('last 按帧推进，同帧多次事件不改写（cursorripple 的 delta 才非零）')
  const d = src.normalizedDelta()
  if (!(d > 0.3)) fail(`帧内位移未体现在 delta（${d}）`)
  else ok(`帧间位移可得（delta=${d.toFixed(3)}）`)

  // 真实 rAF 顺序：事件发生在两帧之间，消费（shader/脚本）在 beginFrame **之前**。
  // 若把 beginFrame 放到消费前，last=current，位移当场归零 —— 3299228616 涟漪不触发。
  {
    const handlers2 = new Map()
    const target2 = {
      addEventListener: (n, fn) => handlers2.set(n, fn),
      removeEventListener: (n) => handlers2.delete(n),
    }
    const src2raf = createPointerSource({ target: target2 })
    const emit2 = (n, ev) => { const h = handlers2.get(n); if (h) h(ev) }
    emit2('mousemove', { clientX: 200, clientY: 100 })
    src2raf.beginFrame() // 帧 0 消费完毕
    emit2('mousemove', { clientX: 600, clientY: 100 })
    const dRaf = src2raf.normalizedDelta()
    if (!(dRaf > 0.3)) {
      fail(`rAF 消费时 delta=${dRaf}（beginFrame 若在消费前调用会把帧间位移抹成 0）`)
    } else ok(`rAF 消费时帧间位移仍在（delta=${dRaf.toFixed(3)}，涟漪才有冲量）`)
    src2raf.beginFrame()
    if (src2raf.normalizedDelta() > 1e-9) fail('beginFrame 之后无新事件时 delta 应归零')
    else ok('beginFrame 之后 delta 归零（快照已推进，等下一帧的事件）')
    src2raf.dispose()
  }

  // 首次 mousemove 对齐 last，避免从默认中心 (0.5,0.5) 拉出假波纹
  {
    const handlers3 = new Map()
    const target3 = {
      addEventListener: (n, fn) => handlers3.set(n, fn),
      removeEventListener: (n) => handlers3.delete(n),
    }
    const src3 = createPointerSource({ target: target3 })
    const emit3 = (n, ev) => { const h = handlers3.get(n); if (h) h(ev) }
    emit3('mousemove', { clientX: 0, clientY: 0 })
    if (src3.normalizedDelta() > 1e-9) {
      fail(`首次移动 delta=${src3.normalizedDelta()}（last 未对齐，会从屏幕中心拍出假波纹）`)
    } else ok('首次移动 last 与 current 对齐（不从中心拉假波纹）')
    src3.dispose()
  }

  // 宿主循环必须在 render 完成后再 beginFrame（接线守卫，防把调用点挪回消费前）
  {
    const mountSrc = fs.readFileSync(path.join(ROOT, 'renderer/src/scene-mount.ts'), 'utf8')
    const beginIdx = mountSrc.indexOf('pointerSrc.beginFrame()')
    const renderIdx = mountSrc.search(/renderer\s*\n\s*\.render\(/)
    if (beginIdx < 0) fail('scene-mount 不再调用 pointerSrc.beginFrame()')
    else if (renderIdx < 0) fail('scene-mount 找不到 renderer.render 调用')
    else if (beginIdx < renderIdx) {
      fail('pointerSrc.beginFrame() 在 renderer.render 之前：帧间位移被抹成 0，cursorripple 不触发')
    } else ok('scene-mount 在 render 完成后再 beginFrame（消费时 delta 非零）')
  }

  // leftDown 只跟左键
  emit('mousedown', { button: 1 })
  if (src.state.leftDown) fail('中键被当成左键')
  emit('mousedown', { button: 0 })
  if (!src.state.leftDown) fail('左键按下未记录')
  else ok('leftDown 只跟左键（input.cursorLeftDown）')
  emit('mouseup', { button: 0 })
  if (src.state.leftDown) fail('左键松开未清除')
  // 离开窗口清 leftDown（拖出窗口松手收不到 mouseup）
  emit('mousedown', { button: 0 })
  emit('blur', {})
  if (src.state.leftDown) fail('离开窗口后 leftDown 未清除（会永久卡住点击态）')
  else ok('离开窗口清 leftDown（避免点击态卡死）')

  // syncWorld：首帧 last 与 current 对齐，避免第一帧的假 delta
  const src2 = createPointerSource({ target: null })
  src2.state.u = 0.5; src2.state.v = 0.5
  src2.syncWorld({ offX: 100, offY: 50, viewW: 1000, viewH: 500 })
  if (src2.state.lastWx !== src2.state.wx || src2.state.lastWy !== src2.state.wy) {
    fail('首帧世界 last 未与 current 对齐（首帧会拍出假波纹）')
  } else ok('首帧世界 last 与 current 对齐')
  // 视差补偿
  src2.syncWorld({ offX: 0, offY: 0, viewW: 1000, viewH: 500 }, 60, -30)
  if (Math.abs(src2.state.wx - (0 + 0.5 * 1000 - 60)) > 1e-9) fail('视差补偿未生效')
  else ok('世界坐标减去相机视差位移（命中与画面一致）')

  // 脚本跟随用的 originY：origin 是 Y-up，必须 = projH - wy。
  // 不传 projH 时 originY 退回 wy（上面两次 syncWorld 走这条，离线测试不被带崩）。
  src2.state.v = 0
  src2.syncWorld({ offX: 0, offY: 0, viewW: 1000, viewH: 500, projH: 500 })
  if (Math.abs(src2.state.wy - 0) > 1e-9) fail(`屏幕顶 wy 应为 0，实得 ${src2.state.wy}`)
  else if (Math.abs(src2.state.originY - 500) > 1e-9) {
    fail(`originY 未取反：屏幕顶应为 projH(=500)，实得 ${src2.state.originY}` +
      ' —— 3292361861 一类 origin 跟随脚本会上下反向')
  } else ok('脚本 originY = projH - wy（鼠标跟随与 origin Y-up 同空间）')
  src.dispose()
  if (handlers.size !== 0) fail(`dispose 未摘干净监听器（残留 ${handlers.size}）`)
  else ok('dispose 摘净全部监听器（修掉重挂载泄漏）')
  delete globalThis.window
}

// ------------------------------------- 3.5 外部指针注入（桌面 underlay 通道）
// 桌面壁纸窗口位于桌面图标之下，Finder 的桌面窗口吃掉全部鼠标事件 —— 页面里
// 一个 mousemove 都收不到。宿主轮询系统鼠标后经 __wp.pushPointer 推入。
// 这条链路一旦坏掉，表现是「壁纸完全不响应鼠标」且**无任何报错**，所以判据必须硬。
console.log('\n【3.5 外部指针注入（宿主推送通道）】')
{
  globalThis.window = { innerWidth: 1600, innerHeight: 900 }
  const src = createPointerSource({ target: null })

  // 归一化 → 四套空间自洽（u/v、screenX/Y、wx/wy、originY）
  src.pushExternal({ u: 0.25, v: 0.75, buttons: 0 })
  if (Math.abs(src.state.u - 0.25) > 1e-9 || Math.abs(src.state.v - 0.75) > 1e-9) {
    fail(`外部注入 u/v 未落地：${src.state.u},${src.state.v}`)
  } else ok('外部注入写入 u/v（g_PointerPosition 空间，Y 朝下）')
  // screenX/Y 由 u/v 乘视口反算 —— input.cursorScreenPosition 要的是像素
  if (src.state.screenX !== 400 || src.state.screenY !== 675) {
    fail(`外部注入 screenX/Y 反算错误：${src.state.screenX},${src.state.screenY}（应 400,675）`)
  } else ok('外部注入反算 screenX/Y（input.cursorScreenPosition 空间）')
  src.syncWorld({ offX: 0, offY: 0, viewW: 1600, viewH: 900, projH: 900 })
  if (Math.abs(src.state.wx - 400) > 1e-9 || Math.abs(src.state.wy - 675) > 1e-9) {
    fail(`外部注入世界坐标错误：${src.state.wx},${src.state.wy}`)
  } else if (Math.abs(src.state.originY - 225) > 1e-9) {
    fail(`外部注入 originY 错误：${src.state.originY}（应 projH-wy=225）`)
  } else ok('外部注入经 syncWorld 得到世界像素与 origin Y-up（hit-test / 脚本跟随一致）')

  // 首次注入把 last 对齐 current：与 DOM 首事件同一约定，否则从屏幕中心
  // (0.5,0.5) 拍出一道贯穿全屏的假波纹。
  {
    const s = createPointerSource({ target: null })
    s.pushExternal({ u: 0, v: 0 })
    if (s.normalizedDelta() > 1e-9) {
      fail(`首次外部注入 delta=${s.normalizedDelta()}（last 未对齐，会从中心拍假波纹）`)
    } else ok('首次外部注入 last 与 current 对齐（与 DOM 路径同一约定）')
  }

  // **最容易回归坏掉的一条**：推送频率（~90Hz）高于帧率，若 pushExternal 里
  // 推进了 last，帧间位移恒接近 0 —— cursorripple 完全不起波且无报错
  // （与 DOM 路径同一个坑，见 pointer.js 文件头）。
  {
    const s = createPointerSource({ target: null })
    s.pushExternal({ u: 0.1, v: 0.5 })
    s.beginFrame() // 帧 0 消费完毕
    // 一帧之内宿主推了三次（模拟 90Hz 推送 / 60fps 渲染）
    s.pushExternal({ u: 0.4, v: 0.5 })
    s.pushExternal({ u: 0.7, v: 0.5 })
    s.pushExternal({ u: 0.9, v: 0.5 })
    if (Math.abs(s.state.lastU - 0.1) > 1e-9) {
      fail(`外部注入改写了 last（lastU=${s.state.lastU}，应仍为 0.1）：` +
        'last 必须只在 beginFrame 推进，否则涟漪力场恒为零')
    } else ok('外部注入不改写 last（同帧多次推送后 last 仍是上帧值）')
    const d = s.normalizedDelta()
    if (!(d > 0.7)) fail(`同帧多次推送后帧间位移丢失（delta=${d}）`)
    else ok(`同帧多次推送保留完整帧间位移（delta=${d.toFixed(3)}，涟漪才有冲量）`)
  }

  // 按键位掩码：只消费 bit0；高位（右/中键）不得污染 leftDown
  src.pushExternal({ u: 0.25, v: 0.75, buttons: 1 })
  if (!src.state.leftDown) fail('buttons bit0 未映射到 leftDown')
  else ok('buttons bit0 → leftDown（input.cursorLeftDown）')
  src.pushExternal({ u: 0.25, v: 0.75, buttons: 0 })
  if (src.state.leftDown) fail('buttons 清零后 leftDown 未清')
  src.pushExternal({ u: 0.25, v: 0.75, buttons: 6 }) // bit1|bit2 = 右+中
  if (src.state.leftDown) {
    fail('右/中键位污染了 leftDown（会让点击类脚本误触发）')
  } else ok('高位按键不污染 leftDown（WE 语义只有左键）')

  // down/up 计数按跳变累加：外部注入是**状态**而非事件，同状态重复推送
  // 不该把计数刷爆（诊断面 __pointerStats 会失去意义）
  {
    const s = createPointerSource({ target: null })
    s.pushExternal({ u: 0.5, v: 0.5, buttons: 1 })
    s.pushExternal({ u: 0.5, v: 0.5, buttons: 1 })
    s.pushExternal({ u: 0.5, v: 0.5, buttons: 1 })
    if (s.state.downCount !== 1) {
      fail(`重复推送按下态使 downCount=${s.state.downCount}（应按跳变计 1）`)
    } else ok('按键计数按跳变累加（重复推送同一状态不刷爆计数）')
  }

  // pushExternalLeave 只清按键、**保留位置与 has**。清 has 会让 xray 开窗
  // 跳到相机外（renderer.js XRAY_IDLE_SCREEN_UV）、视差弹回中心，画面明显抽一下。
  src.pushExternal({ u: 0.3, v: 0.6, buttons: 1 })
  src.pushExternalLeave()
  if (src.state.leftDown) fail('pushExternalLeave 未清按键（点击态会永久卡住）')
  else if (!src.state.has) {
    fail('pushExternalLeave 清掉了 has：xray 会跳到相机外、视差弹回中心（画面抽一下）')
  } else if (Math.abs(src.state.u - 0.3) > 1e-9 || Math.abs(src.state.v - 0.6) > 1e-9) {
    fail('pushExternalLeave 改写了位置（应停在最后已知点）')
  } else ok('pushExternalLeave 只清按键，保留位置与 has（不让 xray/视差抽帧）')

  // 非有限值必须丢弃：宿主换算出 NaN 时若写进 state，NaN 会顺 uniform 传到
  // shader 让整层画面消失，且 wx/wy 污染 hit-test —— 排查成本极高。
  src.pushExternal({ u: 0.3, v: 0.6 })
  src.pushExternal({ u: NaN, v: 0.6 })
  src.pushExternal({ u: 0.3, v: undefined })
  if (!Number.isFinite(src.state.u) || !Number.isFinite(src.state.v)) {
    fail('非有限坐标写进了 state（NaN 会顺 uniform 传到 shader 让整层消失）')
  } else if (Math.abs(src.state.u - 0.3) > 1e-9 || Math.abs(src.state.v - 0.6) > 1e-9) {
    fail(`非有限坐标未被丢弃干净：${src.state.u},${src.state.v}`)
  } else ok('非有限坐标被丢弃，保留上一个有效值（NaN 不进 uniform）')

  // 外部注入与 DOM 监听并存：测试台用真鼠标、宿主用推送，两条路必须走
  // 同一写入路径（applyMove/applyButtons），否则首帧对齐/计数语义会漂移。
  {
    const handlers = new Map()
    const target = {
      addEventListener: (n, fn) => handlers.set(n, fn),
      removeEventListener: (n) => handlers.delete(n),
    }
    const s = createPointerSource({ target })
    const emit = (n, ev) => { const h = handlers.get(n); if (h) h(ev) }
    emit('mousemove', { clientX: 160, clientY: 90 })
    s.pushExternal({ u: 0.5, v: 0.5 })
    if (Math.abs(s.state.u - 0.5) > 1e-9) fail('外部注入未覆盖 DOM 事件（应谁后写谁赢）')
    else ok('外部注入与 DOM 监听并存，后写者赢')
    emit('mousemove', { clientX: 1440, clientY: 810 })
    if (Math.abs(s.state.u - 0.9) > 1e-9) fail('DOM 事件未覆盖外部注入（应谁后写谁赢）')
    else ok('DOM 事件同样可覆盖外部注入（测试台真鼠标路径不受影响）')
    s.dispose()
  }

  // 源码守卫：两条路必须共用写入路径。各写一份必然漂移（首帧 last 对齐、
  // 诊断计数、lastEventTime），而漂移不会报错，只会让某一条路行为诡异。
  {
    const text = fs.readFileSync(path.join(ROOT, 'renderer/vendor/we-scene/render/pointer.js'), 'utf8')
    const moveCalls = (text.match(/applyMove\(/g) || []).length
    const btnCalls = (text.match(/applyButtons\(/g) || []).length
    // 定义 1 次 + onMove 1 次 + pushExternal 1 次
    if (moveCalls < 3) {
      fail(`applyMove 出现 ${moveCalls} 次：DOM 与外部注入应共用同一位置写入路径`)
    } else ok('位置写入路径唯一（DOM 与外部注入共用 applyMove）')
    // 定义 1 + onDown + onUp + onLeaveWindow + pushExternal + pushExternalLeave
    if (btnCalls < 6) {
      fail(`applyButtons 出现 ${btnCalls} 次：DOM 与外部注入应共用同一按键写入路径`)
    } else ok('按键写入路径唯一（DOM 与外部注入共用 applyButtons）')
  }

  // 接线守卫：装配层必须把注入出口挂到 rt.pointerCtl，适配层才能经 __wp 转发。
  {
    const mountSrc = fs.readFileSync(path.join(ROOT, 'renderer/src/scene-mount.ts'), 'utf8')
    if (!/rt\.pointerCtl\s*=/.test(mountSrc)) {
      fail('scene-mount 未挂 rt.pointerCtl：__wp.pushPointer 会静默无效（壁纸永不响应鼠标）')
    } else if (!mountSrc.includes('pushExternal')) {
      fail('scene-mount 的 pointerCtl 未接到 pointerSrc.pushExternal')
    } else ok('scene-mount 挂出 rt.pointerCtl（接到 pointerSrc.pushExternal）')

    const mainSrc = fs.readFileSync(path.join(ROOT, 'renderer/src/main.ts'), 'utf8')
    // 只在 window.__wp 赋值块内找实现 —— 顶上的 `declare global` 类型声明里也有
    // 同名 `pushPointer(u: number, ...)`，全文匹配会让删掉实现后判据仍假绿。
    const wpStart = mainSrc.indexOf('window.__wp = {')
    const wpBlock = wpStart >= 0 ? mainSrc.slice(wpStart) : ''
    if (!/\n  pushPointer\(/.test(wpBlock) || !/\n  pointerLeave\(/.test(wpBlock)) {
      fail('main.ts 的 window.__wp 里缺 pushPointer/pointerLeave 实现（宿主推送无处可去）')
    } else if (!/rt\.pointerCtl\?\.push\(/.test(wpBlock)) {
      fail('__wp.pushPointer 未转发到 rt.pointerCtl（调用成功但指针不动）')
    } else ok('main.ts 的 __wp.pushPointer 转发到 rt.pointerCtl（宿主契约面通）')

    // 反向守卫：场景侧**不得**引入滚轮语义。
    //
    // WE 的场景脚本沙箱没有任何滚轮 API，本机 194 张场景壁纸零消费 ——
    // 场景包里的 `scroll` 全是纹理滚动图层效果（shaders/effects/scroll.frag 的
    // g_ScrollSpeed / scrolldirection，UV 平移动画），`zoom` 全是相机字段
    // `"zoom": 1.0` 或 hover 缩放的属性面板文案，`wheel` 全是 COGWHEEL.json /
    // frontwheel.json 模型资源名。滚轮只对网页壁纸有意义（web-shim 合成 DOM 事件）。
    //
    // 这条断言防的是「顺手补全」：给 pointer.js 加个 wheel 字段看着无害，实际是
    // 凭空发明 WE 没有的语义，下游会以为场景壁纸也能响应滚轮。真要加，先改这条判据。
    const ptrSrc = fs.readFileSync(
      path.join(ROOT, 'renderer/vendor/we-scene/render/pointer.js'), 'utf8')
    if (/wheel|deltaMode|deltaY/i.test(ptrSrc)) {
      fail('pointer.js 出现滚轮字段：WE 场景沙箱无滚轮语义（194 张场景壁纸零消费），'
        + '滚轮只走网页壁纸的 web-shim。若确要新增请先更新本判据与 docs/INTEGRATION.md')
    } else ok('场景指针源不含滚轮语义（与 WE 一致；滚轮只对网页壁纸生效）')
  }

  delete globalThis.window
}

// --------------------------------------- 4. 全库 cursor* 回调过沙箱
console.log('\n【4. 全库 cursor* 回调沙箱求值】')
{
  const ids = fs.existsSync(LIB) ? fs.readdirSync(LIB).filter((d) => {
    try { return fs.statSync(path.join(LIB, d)).isDirectory() } catch { return false }
  }) : []
  if (ids.length === 0) {
    console.log('  (跳过：未找到壁纸库 ' + LIB + ')')
  } else {
    const dec = (b) => new TextDecoder().decode(b).replace(/^\uFEFF/, '')
    const CURSOR_NAMES = ['cursorClick', 'cursorEnter', 'cursorLeave', 'cursorDown', 'cursorUp', 'cursorMove']
    const hookCount = Object.fromEntries(CURSOR_NAMES.map((n) => [n, 0]))
    let scripts = 0, parsed = 0, parseFail = 0, withHook = 0, runtimeErr = 0
    const errKinds = new Map()
    const wallpapersWithHooks = new Set()
    const inputView = createInputView()
    inputView.update({ wx: 640, wy: 360, screenX: 640, screenY: 360, u: 0.5, v: 0.5, lastU: 0.4, lastV: 0.5, leftDown: false })
    const collect = (node, out) => {
      if (!node || typeof node !== 'object') return
      if (Array.isArray(node)) { for (const v of node) collect(v, out); return }
      for (const [k, v] of Object.entries(node)) {
        if (k === 'script' && typeof v === 'string' && v.length > 0) out.push({ code: v, props: node.scriptproperties })
        else collect(v, out)
      }
    }
    for (const id of ids) {
      let pkgPath = path.join(LIB, id, 'scene.pkg')
      if (!fs.existsSync(pkgPath)) pkgPath = path.join(LIB, id, 'scenes', 'scene.pkg')
      if (!fs.existsSync(pkgPath)) continue
      let sj
      try {
        const p = parsePkg(fs.readFileSync(pkgPath))
        const e = getEntry(p, 'scene.json')
        if (!e) continue
        sj = JSON.parse(dec(e))
      } catch { continue }
      const found = []
      collect(sj, found)
      for (const { code, props } of found) {
        scripts++
        // 只关心含 cursor* 导出的脚本
        if (!CURSOR_NAMES.some((n) => code.includes(n))) continue
        let sb
        try {
          sb = evalObjectScript(code, props, {
            inputView,
            canvasSize: { width: 1280, height: 720 },
            // 与宿主一致地提供 thisLayer / thisScene，否则拖拽类回调一进来就
            // ReferenceError，校验会把「沙箱缺全局」误报成「脚本自身的容错」
            layer: { name: 'probe', id: 1, visible: true, alpha: 1, brightness: 1,
              origin: [640, 360, 0], scale: [1, 1, 1], angles: [0, 0, 0], size: [200, 200], color: [1, 1, 1] },
            // 宿主是按层名在 scene.layers 里查；这里给一个恒存在的探针层，
            // 否则跨层脚本走的是「层不存在」分支，测不到真实路径。
            getSceneLayer: () => ({ name: 'other', id: 2, visible: true, alpha: 1, brightness: 1,
              origin: [0, 0, 0], scale: [1, 1, 1], angles: [0, 0, 0], size: [10, 10, 0], color: [1, 1, 1] }),
            setTimeout: () => 0,
            clearTimeout: () => {},
            onError: (e) => {
              const m = String((e && e.message) || e).slice(0, 100)
              errKinds.set(m, (errKinds.get(m) || 0) + 1)
            },
          })
        } catch {
          parseFail++
          continue
        }
        if (!sb) continue
        parsed++
        if (!sb.hasCursorHook) continue
        withHook++
        wallpapersWithHooks.add(id)
        const ev = { worldPosition: makeCursorEventVec(640, 360, 0) }
        for (const n of CURSOR_NAMES) {
          const before = sb.errCount
          const r = sb.callCursor(n, ev)
          void r
          if (sb.errCount > before) runtimeErr++
          else if (typeof sb[n] !== 'undefined' || true) { /* 计数在下面按导出判断 */ }
        }
        // 统计各回调的挂钩数（用 callCursor 是否可达判断：不可达返回 undefined 且不计错）
        for (const n of CURSOR_NAMES) {
          // 重新求值一个干净沙箱代价太高，改用源码里是否出现 `export function <name>`
          const re = new RegExp('(^|[;}\\s])export\\s+(?:async\\s+)?function\\s+' + n + '\\b')
          if (re.test(code)) hookCount[n]++
        }
      }
    }
    console.log(`  扫描 ${ids.length} 个壁纸目录，script 字符串 ${scripts} 条`)
    console.log(`  含 cursor* 的脚本：沙箱求值 ${parsed}，其中确实导出回调 ${withHook}，涉及壁纸 ${wallpapersWithHooks.size}`)
    console.log(`  各回调挂钩数：` + CURSOR_NAMES.map((n) => `${n}=${hookCount[n]}`).join(' '))
    if (parseFail > 0) fail(`cursor* 脚本解析失败 ${parseFail} 个（标准是 0）`)
    else ok('cursor* 脚本解析失败 0')
    if (withHook === 0) fail('未发现任何 cursor* 回调（接线或探测有误）')
    else ok(`${withHook} 个沙箱成功导出 cursor* 回调并可派发`)
    // 运行期错误按**种类**看，而不是只看总次数 —— "xxx is not defined" 说明沙箱
    // 缺全局（我们的接线缺口），而 "cannot read properties of undefined" 多是脚本
    // 自身依赖宿主没有的媒体/骨骼能力（WE 同款容错）。前者必须为 0。
    const missingGlobals = [...errKinds.entries()].filter(([m]) => /\bis not defined\b/.test(m))
    if (missingGlobals.length) {
      for (const [m, c] of missingGlobals) fail(`沙箱缺全局（${c} 次）：${m}`)
    } else ok('无 "is not defined" 类错误（沙箱全局面齐备）')
    if (errKinds.size) {
      console.log('  运行期容错分布（WE 同款全信任执行，熔断后回退静态）：')
      for (const [m, c] of [...errKinds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
        console.log(`    ${c}x  ${m}`)
      }
    }
    if (runtimeErr > 0) void runtimeErr
  }
}

// -------------------------------------- 5. 指针 shader 转译产物
console.log('\n【5. 指针 shader 转译产物】')
{
  const ids = fs.existsSync(LIB) ? fs.readdirSync(LIB).filter((d) => {
    try { return fs.statSync(path.join(LIB, d)).isDirectory() } catch { return false }
  }) : []
  const dec = (b) => new TextDecoder().decode(b).replace(/^\uFEFF/, '')
  const resolver = (f) => WE_SHADER_HEADERS[f.replace(/^shaders\//, '')] ?? WE_SHADER_HEADERS[f] ?? null
  let files = 0, badMul = 0, missingInc = 0, wallpapers = new Set()
  const seenUniforms = new Set()
  for (const id of ids) {
    let pkgPath = path.join(LIB, id, 'scene.pkg')
    if (!fs.existsSync(pkgPath)) pkgPath = path.join(LIB, id, 'scenes', 'scene.pkg')
    if (!fs.existsSync(pkgPath)) continue
    let p
    try { p = parsePkg(fs.readFileSync(pkgPath)) } catch { continue }
    for (const ent of p.entries) {
      if (!/\.(vert|frag)$/.test(ent.name)) continue
      let src
      try { src = dec(getEntry(p, ent.name)) } catch { continue }
      if (!/g_Pointer/.test(src)) continue
      files++
      wallpapers.add(id)
      for (const m of src.matchAll(/\b(g_[A-Za-z0-9_]+)/g)) seenUniforms.add(m[1])
      const stage = ent.name.endsWith('.vert') ? 'vert' : 'frag'
      let out
      try { out = hlsl2glsl(src, stage, {}, resolver) } catch { continue }
      // mul() 结果的 swizzle 必须绑在乘积上，不能落到右操作数（mat4 × vec3 是类型错误）
      if (/transpose\([^()]*\)\s*\*\s*[A-Za-z_]\w*\.(xyw|xyz|xy|xyzw)\b/.test(out)) badMul++
      if (/include 缺失/.test(out)) missingInc++
    }
  }
  console.log(`  指针 shader ${files} 个 / ${wallpapers.size} 个壁纸`)
  if (badMul > 0) fail(`${badMul} 个产物仍是 transpose(M) * v.xyw（mat4×vec3，必然链接失败）`)
  else ok('mul() 结果 swizzle 全部绑在乘积上')
  if (missingInc > 0) fail(`${missingInc} 个产物有 include 缺失`)
  else ok('无 include 缺失（7 个公共头齐备）')
  // 防回归：这些 uniform「改动前从未绑定」，必须仍被 bindSystemUniforms 覆盖
  const rendererSrc = fs.readFileSync(path.join(ROOT, 'renderer/vendor/we-scene/render/renderer.js'), 'utf8')
  const MUST_BIND = ['g_PointerPosition', 'g_PointerPositionLast', 'g_PointerState',
    'g_ParallaxPosition', 'g_Frametime', 'g_EffectTextureProjectionMatrixInverse',
    'g_ModelViewProjectionMatrixInverse']
  const unbound = MUST_BIND.filter((n) => !rendererSrc.includes(`'${n}'`))
  if (unbound.length) fail(`未绑定的指针 uniform：${unbound.join(', ')}`)
  else ok(`6 个指针 uniform 均已在 bindSystemUniforms 绑定`)
  // g_PointerPosition 不能再是硬编码 0
  if (/'g_PointerPosition',\s*\(l\)\s*=>\s*gl\.uniform2f\(l,\s*0,\s*0\)/.test(rendererSrc)) {
    fail('g_PointerPosition 仍是硬编码 (0,0)')
  } else ok('g_PointerPosition 不再硬编码为 0')
  // [we-scene patch] xray 反投影：**按数值判定，不看写法**。
  //
  // 这个 bug 已经复发两次，两次都是「代码看着合理、画面完全没反应」：
  //   1. 硬编码单位矩阵 → 指针被压成常量；
  //   2. 传 ortho(-projW/2, projW/2, …) 的逆 → P 达 ±512 像素级，
  //      而 frag 紧接着 saturate(texSource - P) 把整屏夹成 0/1，
  //      于是**除正中心外权重恒 0**（实测 u=0.25/0.75 行峰值 0.000）。
  // 所以这里不再检查「有没有写 IDENT_M4」这种表面特征，而是复刻 vert+frag
  // 的算术，直接断言「开窗中心必须落在指针处」。
  //
  // 两个 shader 版本都要过（全库 6 个 xray 壁纸分属这两版）：
  //   新版 5/6：g_EffectTextureProjectionMatrixInverse，之后 `*= 0.5`
  //   旧版 1/6：g_ModelViewProjectionMatrixInverse，   之后 `*= 1/g_Texture0Resolution.xy`
  {
    // 复刻 hlsl2glsl 的行向量语义：shader 里算 transpose(传入矩阵) * 向量
    const applyRowVec = (mPassed, v4) => {
      const T = mathMod.mat4Transpose(mPassed)
      const o = [0, 0, 0, 0]
      for (let r = 0; r < 4; r++) { let s = 0; for (let c = 0; c < 4; c++) s += T[c * 4 + r] * v4[c]; o[r] = s }
      return o
    }
    const TEXW = 4096, TEXH = 2048
    // 渲染器实际传的两个矩阵（与 renderer.js 保持同一构造式）
    const newVer = mathMod.mat4Identity()
    const oldVer = mathMod.mat4Transpose(
      mat4Scale(mathMod.mat4Identity(), TEXW / 2, TEXH / 2, 1))
    let bad = []
    for (const [u, v] of [[0.25, 0.25], [0.5, 0.5], [0.75, 0.75], [0.9, 0.1]]) {
      const ndc = [u * 2 - 1, (1 - v) * 2 - 1, 0, 1]
      // 新版：.xyw 后 *= 0.5
      const a = applyRowVec(newVer, ndc)
      const pNew = [a[0] * 0.5 / a[3], a[1] * 0.5 / a[3]]
      // 旧版：.xyw 后 *= 1/texRes
      const b = applyRowVec(oldVer, ndc)
      const pOld = [b[0] / TEXW / b[3], b[1] / TEXH / b[3]]
      // frag 要求 texSource = P + 0.5 时命中 halo 中心；texSource 就是 (u, 1-v)
      const want = [u - 0.5, (1 - v) - 0.5]
      for (const [tag, p] of [['新版', pNew], ['旧版', pOld]]) {
        if (Math.abs(p[0] - want[0]) > 1e-5 || Math.abs(p[1] - want[1]) > 1e-5) {
          bad.push(`${tag} 指针(${u},${v}) 反投影得 (${p[0].toFixed(4)},${p[1].toFixed(4)})，应为 (${want[0].toFixed(4)},${want[1].toFixed(4)})`)
        }
        // 同时守住范围：P 必须落在 [-0.5,0.5]，否则 saturate 会把整屏夹平
        if (Math.abs(p[0]) > 0.5 + 1e-6 || Math.abs(p[1]) > 0.5 + 1e-6) {
          bad.push(`${tag} 指针(${u},${v}) 反投影出界 (${p[0].toFixed(2)},${p[1].toFixed(2)})，saturate 会把权重夹成 0`)
        }
      }
    }
    if (bad.length) bad.forEach((b) => fail('xray 反投影错误：' + b))
    else ok('xray 反投影两版都把开窗中心对准指针（P∈[-0.5,0.5]，saturate 不夹平）')
  }

  // [we-scene patch] g_PointerPosition 必须换算到**层 UV 空间**。
  //
  // 上面那组用例默认 texSource == 屏幕归一化坐标 —— 只有「层宽高比 == 画布宽高比」
  // 时才成立，所以它锁不住这个 bug。xray.frag 的 `d = texSource - P` 里 texSource 是
  // 当前像素的**层 UV**，P 也必须同空间。层与画布宽高比不同时，fit=cover 会把层的
  // 一部分裁到屏外，屏幕 v 与层 v 之间差一个「裁边 + 缩放」。
  //
  // 2854083091：层 4000×2667(3:2)、画布 1280×720(16:9)，层铺屏后 1280×853、上下各裁 67px。
  // 未换算时开窗纵向按 853/720 发散：指针在画面顶端开窗偏上 56px、底端偏下 56px，
  // 只有正中间恰好对上 —— 即用户报的「开窗没有以鼠标为中心跟随」。
  {
    const projW = 4000, projH = 2667, canW = 1280, canH = 720
    const s = Math.max(canW / projW, canH / projH)
    const dispW = projW * s, dispH = projH * s, cropY = (dispH - canH) / 2
    // cam（fit=cover）：屏幕窗口在场景坐标里的范围
    const viewW = projW, viewH = canH / s
    const offX = 0, offY = (projH - viewH) / 2
    const lw = projW, lh = projH, lx = 0, ly = 0
    let worst = 0
    for (const [sx, sy] of [[320, 180], [640, 360], [960, 540], [640, 60], [640, 660]]) {
      // 渲染器现在做的换算：屏幕归一化 → 场景像素 → 层 UV
      const pu = (offX + (sx / canW) * viewW - lx) / lw
      const pv = (offY + (sy / canH) * viewH - ly) / lh
      // vert+frag：开窗中心落在 layerU=pu、layerV=pv（见 renderer.js 的推导注释）
      const ox = pu * dispW, oy = pv * dispH - cropY
      worst = Math.max(worst, Math.abs(ox - sx), Math.abs(oy - sy))
    }
    if (worst > 0.5) {
      fail(`xray 开窗中心未跟随指针：最大偏差 ${worst.toFixed(0)}px` +
        '（g_PointerPosition 未换算到层 UV 空间；层与画布宽高比不同时才暴露）')
    } else {
      ok('xray 开窗中心跟随指针：层/画布宽高比不同时偏差 <1px')
    }
    // 实现必须真的接线，防止整段换算被删掉后上面的纯算术断言依然过。
    // 判据是「赋值真的发生」，不能只看有没有出现某个函数名/注释 ——
    // 只留声明、删掉赋值那一行时画面就已经坏了。
    if (!/pu\s*=\s*toLayerU\(pu\)/.test(rendererSrc) || !/pv\s*=\s*toLayerV\(pv\)/.test(rendererSrc)) {
      fail('renderer.js 未把 g_PointerPosition 换算到层 UV（宽高比不同的层开窗会失准）')
    }
    if (!/plu\s*=\s*toLayerU\(plu\)/.test(rendererSrc) || !/plv\s*=\s*toLayerV\(plv\)/.test(rendererSrc)) {
      fail('renderer.js 未换算 g_PointerPositionLast（与 current 不同空间，帧间 delta 会失真）')
    }
  }
  // [we-scene patch] xray size 调大必须让**效果范围**变大，不是让「开窗」变大。
  //
  // 上一则断言把两件事说反了：`uv *= scale` 是在 halo 贴图里开窗（scale 越大
  // 采得越开、角色身上亮区越紧）；角色身上的效果范围 ∝ 1/scale。size 滑条要的
  // 是后者。新版 vert 写 `scale = 1/g_PointerScale`；size=1 时 1/g 是恒等。
  // frag 若乘的是 g，调大 size 范围会缩。
  //
  // 判据：纯函数方向（size↑ → UV scale↓ → 范围↑）、rewrite 接线、
  // 旧版 *= g 同样取倒数（1586038665 调到 10 曾只剩小圆点）。
  {
    const { xrayUvScale, rewriteXrayFragScale, constantFallback, XRAY_SIZE_FALLBACK } = await import(
      path.join(ROOT, 'renderer/vendor/we-scene/render/renderer.js')
    ).catch(() => ({}))
    if (typeof xrayUvScale !== 'function') {
      fail('renderer.js 未导出 xrayUvScale（size→效果范围的倒数关系无离线入口）')
    } else {
      const s1 = xrayUvScale(1), s2 = xrayUvScale(2), s05 = xrayUvScale(0.5)
      const s10 = xrayUvScale(10)
      if (Math.abs(s1 - 1) > 1e-9) fail(`xrayUvScale(1) 应为 1（恒等），得到 ${s1}`)
      else if (!(s2 < s1) || Math.abs(s2 - 0.5) > 1e-9) {
        fail(`xrayUvScale(2) 应为 0.5（效果范围比 size=1 更大），得到 ${s2}`)
      } else if (!(s05 > s1) || Math.abs(s05 - 2) > 1e-9) {
        fail(`xrayUvScale(0.5) 应为 2（效果范围比 size=1 更小），得到 ${s05}`)
      } else if (Math.abs(s10 - 0.1) > 1e-9) {
        fail(`xrayUvScale(10) 应为 0.1（否则 size=10 只剩小圆点），得到 ${s10}`)
      } else ok('xray size 越大 UV scale 越小（效果范围变大）；size=1 是恒等')
    }
    if (typeof rewriteXrayFragScale !== 'function') {
      fail('renderer.js 未导出 rewriteXrayFragScale')
    } else {
      const sample = [
        'void main() {',
        '  unprojectedUVs -= 0.5;',
        '  unprojectedUVs *= v_PointerScale * vec2(1.0, v_PointerUV.w);',
        '  unprojectedUVs += 0.5;',
        '}',
      ].join('\n')
      const out = rewriteXrayFragScale(sample)
      if (!/uniform\s+float\s+g_PointerScale/.test(out)) {
        fail('rewriteXrayFragScale 未在 frag 声明 g_PointerScale')
      } else if (/unprojectedUVs\s*\*=\s*v_PointerScale\s*\*/.test(out)) {
        fail('rewriteXrayFragScale 仍让 frag 乘 v_PointerScale（varying 丢掉倒数时 size=1 看起来对、调大范围缩小）')
      } else if (!/1\.0\s*\/\s*max\(\s*g_PointerScale/.test(out)) {
        fail('rewriteXrayFragScale 未在 frag 对 g_PointerScale 取倒数')
      } else ok('xray.frag 在片元内对 g_PointerScale 取倒数（size↑ → 效果范围↑）')
      // 旧版 1586038665：frag 直接乘 g。上一则断言「不要改」已推翻——
      // 作者滑条叫 xray size、1–10，size=1 恒等看不出，调到 10 只剩小圆点。
      const old = 'unprojectedUVs *= g_PointerScale * vec2(1.0, v_PointerUV.w);'
      const oldOut = rewriteXrayFragScale(old)
      if (/unprojectedUVs\s*\*=\s*g_PointerScale\s*\*/.test(oldOut)) {
        fail('旧版 xray.frag 仍乘 g_PointerScale（size=10 只剩小圆点）')
      } else if (!/1\.0\s*\/\s*max\(\s*g_PointerScale/.test(oldOut)) {
        fail('旧版 xray.frag 未对 g_PointerScale 取倒数')
      } else ok('旧版 xray.frag（*= g_PointerScale）同样取倒数（size=10 范围变大）')
      if (rewriteXrayFragScale(oldOut) !== oldOut) {
        fail('rewriteXrayFragScale 对已改写的旧版不幂等（会叠倒）')
      }
      if (rewriteXrayFragScale(out) !== out) {
        fail('rewriteXrayFragScale 对已改写的新版不幂等（会叠倒）')
      }
      // 本机库有 1586038665 时，用转译后的真 shader 再锁一次（合成字符串对不上
      // hlsl2glsl 空白时仍会漏）。CI 没有壁纸库则跳过。
      const oldPkgPath = path.join(LIB, '1586038665', 'scene.pkg')
      if (fs.existsSync(oldPkgPath)) {
        try {
          const oldPkg = parsePkg(fs.readFileSync(oldPkgPath))
          const oldSrc = dec(getEntry(oldPkg, 'shaders/effects/xray.frag'))
          const oldGlsl = hlsl2glsl(oldSrc, 'frag', {}, resolver)
          if (!/unprojectedUVs\s*\*=\s*g_PointerScale\s*\*/.test(oldGlsl)) {
            fail('1586038665 转译后找不到 *= g_PointerScale（旧版探测失效）')
          } else {
            const rewritten = rewriteXrayFragScale(oldGlsl)
            if (/unprojectedUVs\s*\*=\s*g_PointerScale\s*\*/.test(rewritten)) {
              fail('1586038665 旧版 xray.frag 仍乘 g（size=10 只剩小圆点）')
            } else if (!/1\.0\s*\/\s*max\(\s*g_PointerScale/.test(rewritten)) {
              fail('1586038665 旧版 xray.frag 未取倒数')
            } else ok('1586038665 实机 shader 已改写为 1/g（调到 10 范围变大）')
          }
        } catch (e) {
          fail('1586038665 旧版 xray.frag 改写检查失败：' + ((e && e.message) || e))
        }
      }
    }
    if (!/rewriteXrayFragScale\s*\(\s*hlsl2glsl/.test(rendererSrc)) {
      fail('getEffectProgram 未调用 rewriteXrayFragScale（导出了函数但没接线，size 变大范围会缩）')
    } else ok('getEffectProgram 编译前改写 xray.frag 的 UV scale')
    // 效果覆盖半径 = 层 UV 分数 × 层 CSS 宽，与画布 bitmap（dpr）无关。
    if (typeof xrayUvScale === 'function') {
      const cssR = (g, layerCssW) => (0.5 / xrayUvScale(g)) * layerCssW
      const r1 = cssR(1, 1280), r2 = cssR(2, 1280)
      if (!(r2 > r1)) fail(`size 2 的效果范围 (${r2.toFixed(1)}) 应大于 size 1 (${r1.toFixed(1)})`)
      else ok(`xray 效果范围与 dpr 无关（size 1→2：覆盖 ${r1.toFixed(0)}px → ${r2.toFixed(0)}px）`)
    }

    // [we-scene patch] 作者没在 constantshadervalues 里写 size 时的缺省。
    //
    // shader 注释是 `"default":0.2`，那是**编辑器新建效果时滑条的初值**，
    // 不是运行时缺省：WE 编辑器把效果加到层上就会把当时的滑条值写进 csv，
    // 官方运行时永远读得到显式值（本地库 17 个 xray pass 全都带 size）。
    // 我们的 bindConstants 兜底循环却会把 0.2 当 fallback 套上去，
    // 经 xrayUvScale 取倒数是 5 —— UV 放大五倍，效果范围缩成光标旁一小块。
    // 缺省要的是恒等：1。
    if (typeof constantFallback !== 'function') {
      fail('renderer.js 未导出 constantFallback（xray size 缺省无离线入口）')
    } else {
      if (XRAY_SIZE_FALLBACK !== 1) {
        fail(`XRAY_SIZE_FALLBACK 应为 1（恒等），得到 ${XRAY_SIZE_FALLBACK}`)
      }
      const fb = constantFallback('g_PointerScale', 0.2)
      if (fb !== 1) {
        fail(`作者未配置 size 时 g_PointerScale 缺省应为 1，得到 ${fb}` +
          '（用注释里的 0.2 会让效果范围缩成 1/5）')
      } else if (typeof xrayUvScale === 'function' && Math.abs(xrayUvScale(fb) - 1) > 1e-9) {
        fail(`缺省 size 经 xrayUvScale 应得恒等 1，得到 ${xrayUvScale(fb)}`)
      } else ok('xray size 未配置时缺省为 1（UV 恒等，效果范围 = halo 本身）')
      // 只能改 g_PointerScale 这一个：其余 uniform 的注释 default 与编辑器初值
      // 一致（multiply=1、贴图槽 particle/halo_6），跟着改会伤到别的效果。
      if (constantFallback('g_Multiply', 1) !== 1) {
        fail('constantFallback 不应改动 g_Multiply 的注释 default')
      }
      if (constantFallback('g_Texture2', 'particle/halo_6') !== 'particle/halo_6') {
        fail('constantFallback 不应改动贴图槽的注释 default')
      }
      if (constantFallback('g_SomeOther', undefined) !== undefined) {
        fail('无注释 default 的 uniform 不该被 constantFallback 凭空设值')
      }
      // 接线：兜底循环必须真的经过 constantFallback，不能只导出函数不用
      if (!/const\s+dflt\s*=\s*constantFallback\(\s*entry\.uniform\s*,\s*entry\.default\s*\)/.test(rendererSrc)) {
        fail('bindConstants 的兜底循环未经过 constantFallback（导出了函数但没接线）')
      } else ok('bindConstants 缺省分支接到 constantFallback')
    }
  }
  // [we-scene patch] 初始加载：xray 开窗不能停在壁纸圆心。
  //
  // 全局指针初值仍是 (0.5,0.5)（视差/iris/涟漪要相对中心为零）。只对声明了
  // g_PointerScale 的 xray 把屏幕 UV 换成 XRAY_IDLE_SCREEN_UV（-1，一整屏在
  // 相机左上外），再走同一套 toLayerU/V。size>1 时 saturate(texSource-P) 会把
  // 屏外开窗的边沿染成整屏亮斑，所以 bindConstants 之后还要把 g_PointerScale
  // 打到 0（frag mix → 999）。
  {
    const { xrayShouldParkPointer, XRAY_IDLE_SCREEN_UV, xrayUvScale } = await import(
      path.join(ROOT, 'renderer/vendor/we-scene/render/renderer.js')
    ).catch(() => ({}))
    if (typeof xrayShouldParkPointer !== 'function') {
      fail('renderer.js 未导出 xrayShouldParkPointer（初始加载圆心开窗无离线入口）')
    } else {
      if (!xrayShouldParkPointer(false, true)) {
        fail('未收到鼠标时应把 xray 停到相机外（否则开窗在壁纸圆心）')
      } else if (xrayShouldParkPointer(true, true)) {
        fail('收到鼠标后不应再停 xray（否则开窗不跟随）')
      } else if (xrayShouldParkPointer(false, false)) {
        fail('非 xray（无 g_PointerScale）不应改指针初值（iris 会看向屏外）')
      } else ok('xray 仅在未收到鼠标时停到相机外（iris/ripple 仍用中心）')
    }
    if (XRAY_IDLE_SCREEN_UV !== -1) {
      fail(`XRAY_IDLE_SCREEN_UV 应为 -1（一整屏在相机外），得到 ${XRAY_IDLE_SCREEN_UV}`)
    } else {
      // 2854083091：层 4000×2667、画布 1280×720 cover。idle 层 UV 必须在可见相机外。
      const projW = 4000, projH = 2667, canW = 1280, canH = 720
      const s = Math.max(canW / projW, canH / projH)
      const viewW = projW, viewH = canH / s
      const offX = 0, offY = (projH - viewH) / 2
      const lw = projW, lh = projH, lx = 0, ly = 0
      const toLayerU = (u) => (offX + u * viewW - lx) / lw
      const toLayerV = (v) => (offY + v * viewH - ly) / lh
      const idleU = toLayerU(XRAY_IDLE_SCREEN_UV)
      const idleV = toLayerV(XRAY_IDLE_SCREEN_UV)
      const visU0 = toLayerU(0), visU1 = toLayerU(1)
      const visV0 = toLayerV(0), visV1 = toLayerV(1)
      const inU = idleU >= Math.min(visU0, visU1) && idleU <= Math.max(visU0, visU1)
      const inV = idleV >= Math.min(visV0, visV1) && idleV <= Math.max(visV0, visV1)
      if (inU && inV) {
        fail(`xray idle 层 UV (${idleU.toFixed(3)},${idleV.toFixed(3)}) 仍在相机可见区`)
      } else ok('xray 未收到鼠标时开窗中心在相机可见区外')
    }
    if (typeof xrayUvScale === 'function') {
      const satEdgeUv = (scale) => 0.5 + 0.5 * scale
      if (!(satEdgeUv(xrayUvScale(10)) > 0.5)) {
        fail('size=10 屏外 saturate 判据失效（无法证明 idle 必须把 scale 打到 0）')
      } else ok('size>1 屏外 saturate 仍采 halo 亮区，idle 必须把 g_PointerScale 打到 0')
    }
    const parkIdx = rendererSrc.indexOf('parkXrayUntilPointer(uni)')
    const bindIdx = rendererSrc.lastIndexOf('bindConstants(', parkIdx === -1 ? undefined : parkIdx)
    if (parkIdx < 0) {
      fail('未调用 parkXrayUntilPointer（idle xray 的用户 size 会盖掉 scale=0）')
    } else if (bindIdx < 0 || parkIdx < bindIdx) {
      fail('parkXrayUntilPointer 未在 bindConstants 之后（用户 xraysize 会盖掉 idle 的 0）')
    } else ok('idle xray 在 bindConstants 之后把 g_PointerScale 打到 0')
    if (!/parkXray\s*\?\s*XRAY_IDLE_SCREEN_UV/.test(rendererSrc)
      && !/parkXray \? XRAY_IDLE_SCREEN_UV/.test(rendererSrc)) {
      fail('bindSystemUniforms 未把 idle xray 的屏幕 UV 换成 XRAY_IDLE_SCREEN_UV')
    } else ok('bindSystemUniforms 把 idle xray 屏幕 UV 停在相机外')
    // 全局指针初值必须仍是中心，不能为了 xray 把视差/iris 拽到屏外
    const pointerSrcText = fs.readFileSync(path.join(ROOT, 'renderer/vendor/we-scene/render/pointer.js'), 'utf8')
    if (!/\bu:\s*0\.5/.test(pointerSrcText) || !/\bv:\s*0\.5/.test(pointerSrcText)) {
      fail('指针源初值不再是 (0.5,0.5)（视差会在加载时跳到屏外）')
    } else ok('全局指针初值仍是屏幕中心（视差/iris 不受 xray 停靠影响）')
  }
  // 光标反投影用到的矩阵必须真的出现在 renderer 里（防止整段被误删）
  if (!/g_EffectTextureProjectionMatrixInverse/.test(rendererSrc)
    || !/g_ModelViewProjectionMatrixInverse/.test(rendererSrc)) {
    fail('renderer 缺少 xray 所需的反投影 uniform 绑定')
  } else ok('两个反投影 uniform 均已在 renderer 绑定')
  // mat4Invert 必须存在且正确（零矩阵退化为单位矩阵，别灌 NaN）
  const inv = mat4Invert(new Float32Array(16))
  if (inv[0] !== 1 || inv[5] !== 1) fail('mat4Invert 对奇异矩阵未退化为单位矩阵')
  else ok('mat4Invert 奇异输入退化为单位矩阵（不灌 NaN 进顶点着色器）')
  // [we-scene patch] ApplyBlending mode 0 不能被二次加权。
  // xray 的最终输出是 ApplyBlending(0, 上层, 下层, blend)，mode 0 的分支本身已是
  // mix(A,B,opacity)；若再套一层 mix(A,r,opacity) 就成了 opacity²。而 xray 的两张图
  // 是同一构图的不同版本（A≈B），平方后差异被压到 readPixels 都读不出 ——
  // 表现为「效果链完全正常、中间量全对（blend/sprite/mask.a 都非零）、画面就是不动」。
  const blendHdr = WE_SHADER_HEADERS['common_blending.h'] || ''
  if (!/if\s*\(\s*mode\s*!=\s*0\s*&&/.test(blendHdr)) {
    fail('ApplyBlending 的二次加权护栏未排除 mode 0（xray 混合会被 opacity² 压平）')
  } else ok('ApplyBlending mode 0 已排除二次加权（xray 的 Normal 混合不被压平）')
  const m = mat4Translate(mat4Scale(mat4Identity(), 2, 4, 1), 30, -10, 0)
  const mi = mat4Invert(m)
  const idn = mathMod.mat4Multiply(m, mi)
  let e = 0
  for (let i = 0; i < 16; i++) e = Math.max(e, Math.abs(idn[i] - (i % 5 === 0 ? 1 : 0)))
  if (e > 1e-5) fail(`mat4Invert 精度不足（M·M⁻¹ 偏离单位 ${e.toExponential(2)}）`)
  else ok(`mat4Invert 正确（M·M⁻¹ = I，误差 ${e.toExponential(2)}）`)
}

// -------------------------------------- 6. 骨骼拖拽（端到端）
console.log('\n【6. 骨骼拖拽：真实脚本驱动真实 MDL】')
{
  const ids = fs.existsSync(LIB) ? fs.readdirSync(LIB).filter((d) => {
    try { return fs.statSync(path.join(LIB, d)).isDirectory() } catch { return false }
  }) : []
  const dec = (b) => new TextDecoder().decode(b).replace(/^\uFEFF/, '')
  // 全库用骨骼 API 的壁纸（getBoneCount/getBoneTransform/setBoneTransform）
  const BONE_RE = /getBoneCount|getBoneTransform|setBoneTransform/
  let found = 0, drove = 0, skipNoMdl = 0
  const details = []
  for (const id of ids) {
    let pkgPath = path.join(LIB, id, 'scene.pkg')
    if (!fs.existsSync(pkgPath)) pkgPath = path.join(LIB, id, 'scenes', 'scene.pkg')
    if (!fs.existsSync(pkgPath)) continue
    let pk, sj
    try {
      pk = parsePkg(fs.readFileSync(pkgPath))
      const e = getEntry(pk, 'scene.json')
      if (!e) continue
      sj = JSON.parse(dec(e))
    } catch { continue }
    // 快速筛：scene.json 里有没有骨骼 API
    if (!BONE_RE.test(JSON.stringify(sj.objects || []))) continue
    let scene
    try { scene = parseScene(sj, null) } catch { continue }
    for (const layer of scene.layers) {
      const scripts = layer.objectScripts
      if (!scripts) continue
      for (const [field, def] of Object.entries(scripts)) {
        if (!BONE_RE.test(def.script)) continue
        found++
        // 挂上真实 MDL（宿主在 main.ts 里做的事）
        if (!layer.image) { skipNoMdl++; continue }
        let mj
        try { mj = JSON.parse(dec(getEntry(pk, layer.image))) } catch { skipNoMdl++; continue }
        if (!mj || !mj.puppet) { skipNoMdl++; continue }
        const me = getEntry(pk, mj.puppet)
        if (!me) { skipNoMdl++; continue }
        let mdl
        try { mdl = parseMDL(new Uint8Array(me)) } catch (e) {
          // MDLV0013/0016 等旧版本 parseMDL 尚不支持（见 README 已知边界）
          details.push(`${id}.${field}: MDL 解析失败（${String(e.message).slice(0, 40)}）`)
          skipNoMdl++
          continue
        }
        layer.puppet = mdl
        const overrides = new Map()
        const iv = createInputView()
        const sb = evalObjectScript(def.script, def.scriptproperties, {
          canvasSize: { width: 1920, height: 1080 },
          inputView: iv,
          layer,
          getSceneLayer: () => null,
          getBoneOverrides: (l) => (l === layer ? overrides : null),
          setTimeout: () => 0,
          clearTimeout: () => {},
          onError: () => {},
        })
        if (!sb) { details.push(`${id}.${field}: 沙箱求值返回 null`); continue }
        sb.init()
        // 骨骼数必须非 0，否则脚本的 cursorDown 遍历一次都不跑
        const bc = mdl.bones.length
        if (bc === 0) { details.push(`${id}.${field}: 模型 0 骨`); continue }
        // 模拟一次拖拽：按下在骨 0 的世界位置（进入 DRAG_MAX_RADIUS），再拖到别处。
        // 骨骼局部（y-up）→ 世界（y-down）换算与 makeBoneApi 一致。
        // 注意两份脚本都有 `if (dragDist > 0)` 之类的护栏，按下点与目标点必须**真的分开**，
        // 否则 dragDist=0、脚本按「原地点击」处理，不会产生拖拽覆写。
        const org = layer.origin, scl = layer.scale || [1, 1, 1]
        const bw = [org[0] + mdl.bones[0].matrix[12] * (scl[0] || 1),
          org[1] - mdl.bones[0].matrix[13] * (scl[1] || 1)]
        iv.update({ wx: bw[0], wy: bw[1], screenX: 0, screenY: 0, u: 0.5, v: 0.5, lastU: 0.5, lastV: 0.5, leftDown: true })
        sb.callCursor('cursorDown', { worldPosition: makeCursorEventVec(bw[0], bw[1], 0) })
        // 拖到骨骼位置 +40/+25px，并逐帧 update（脚本在 update 里才写骨骼）
        const target = [bw[0] + 40, bw[1] + 25]
        iv.update({ wx: target[0], wy: target[1], screenX: 0, screenY: 0, u: 0.6, v: 0.6, lastU: 0.5, lastV: 0.5, leftDown: true })
        sb.callCursor('cursorMove', { worldPosition: makeCursorEventVec(target[0], target[1], 0) })
        if (sb.hasUpdate) { sb.callUpdate(true); sb.callUpdate(true) }
        if (overrides.size > 0) {
          drove++
          // 覆写必须真的改变蒙皮矩阵（否则 mdl.js 侧没接上）
          const skin = computeSkinMatrices(mdl, 0, layer.animationLayers, overrides)
          if (!skin) {
            fail(`${id}.${field}: 有覆写但 computeSkinMatrices 返回 null（早退护栏没放开）`)
          } else {
            let moved = 0
            for (const [bi] of overrides) {
              const o = bi * 16
              if (Math.hypot(skin[o + 12], skin[o + 13]) > 0.5) moved++
            }
            if (moved === 0) fail(`${id}.${field}: 覆写未体现到蒙皮矩阵`)
            else details.push(`${id}.${field}: ${bc} 骨，覆写 ${overrides.size} 根，蒙皮位移生效 ${moved} 根 ✓`)
          }
        } else {
          details.push(`${id}.${field}: ${bc} 骨，脚本未产生覆写（可能命中判据不同）`)
        }
      }
    }
  }
  console.log(`  用骨骼 API 的字段脚本：${found} 个（MDL 不可用而跳过 ${skipNoMdl} 个）`)
  for (const d of details.slice(0, 10)) console.log(`    ${d}`)
  if (found === 0) fail('未找到任何使用骨骼 API 的脚本（探测有误）')
  else if (drove === 0) fail('没有任何脚本成功驱动骨骼（骨骼 API 桥接未生效）')
  else ok(`${drove} 个脚本成功驱动真实骨骼并改变蒙皮矩阵`)

  // 单元用例：覆写语义必须是**绝对覆盖**而非累加
  {
    const fake = {
      bones: [{ parent: -1, matrix: new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 10,20,0,1]) }],
      animations: [], vertexCount: 0, invBindWorld: [mat4Identity()],
    }
    const ov = new Map([[0, [110, 20, 0]]])
    const s1 = computeSkinMatrices(fake, 0, undefined, ov)
    const s2 = computeSkinMatrices(fake, 0, undefined, ov)
    if (!s1 || !s2) fail('覆写下 computeSkinMatrices 返回 null')
    else if (Math.abs(s1[12] - s2[12]) > 1e-6) fail(`覆写被当成累加（两次调用结果不同：${s1[12]} vs ${s2[12]}）`)
    else ok(`覆写是绝对覆盖，重复调用结果稳定（位移 ${s1[12].toFixed(1)}px）`)
  }
}

// -------------------------------------- 7. 外观切换（getEffect + applyUserProperties）
//
// WE 的「点一下换套装/换配色」几乎全是同一形态：作者把两套外观做成同一图层上的两个
// blend 效果，脚本 cursorClick 里换状态、update 里 `getEffect('X').visible = 真假`。
// 全库 9 处调用 / 7 个壁纸。
//
// 这条链上有两个各自静默的断点，任一个断都表现为「壁纸正常显示、点了没反应」：
//   1) getEffect 返回 null —— 语料里一律写成 `getEffect(x).visible = y` 不判空，
//      拿到 null 直接 TypeError，沙箱连错 3 次熔断，整个交互脚本失效。
//   2) 宿主不调 applyUserProperties —— WE 挂载时 init() 之后必调一次全量属性，
//      脚本靠它拿状态初值。不调的话状态变量是 undefined，而切换写的是
//      `if(s==1) s=2; else if(s==2) s=3; else if(s==3) s=1`：undefined 三个分支
//      全不匹配，点多少次都不动。全库 82 处 / 24 个壁纸导出该回调。
//
// 判据是**真实脚本驱动真实场景层后效果可见性确实翻转**，不是「脚本没报错」。
{
  console.log('\n【7. 外观切换：getEffect + 用户属性初值】')
  const CASES = [
    // 壁纸, 挂脚本的层, 期望被切换的目标层（null = 按效果名全场景找）, 参与切换的效果名
    { id: '3148125112', btn: '按钮', target: '腿1', effects: ['白丝', '黑丝'] },
    { id: '3791967416', btn: '交互按钮', target: null, effects: ['蓝', '黑'] },
    // 悬停高亮：脚本在别的层上开自己那一格的阴影效果（跨层 getEffect）
    { id: '2887099508', btn: '设置3-我要涩涩', target: '中-菜单-浮动', effects: ['阴影-设置3'] },
  ]
  let ran = 0
  let toggled = 0
  for (const cs of CASES) {
    const pkgPath = path.join(LIB, cs.id, 'scene.pkg')
    const projPath = path.join(LIB, cs.id, 'project.json')
    if (!fs.existsSync(pkgPath)) continue
    let pkg, sj, pj
    try {
      pkg = parsePkg(fs.readFileSync(pkgPath))
      sj = JSON.parse(new TextDecoder().decode(getEntry(pkg, 'scene.json')))
      pj = fs.existsSync(projPath) ? JSON.parse(fs.readFileSync(projPath, 'utf8')) : null
    } catch { continue }
    const scene = parseScene(sj, pj)
    const byName = new Map(scene.layers.map((l) => [l.name, l]))
    const raw = (sj.objects || []).find((o) => o.name === cs.btn)
    const layer = byName.get(cs.btn)
    if (!raw || !layer) continue
    // 脚本挂在哪个字段上不固定（多为 visible），逐字段找带 cursorClick 的那份
    let def = null
    for (const f of ['visible', 'scale', 'origin', 'color', 'alpha', 'brightness', 'angles']) {
      const v = raw[f]
      if (v && typeof v === 'object' && typeof v.script === 'string' && /cursorClick/.test(v.script)) {
        def = { script: v.script, props: v.scriptproperties || null, field: f }
        break
      }
    }
    if (!def) continue
    const userProps = {}
    for (const [k, v] of Object.entries(scene.properties || {})) {
      if (v && typeof v === 'object' && 'value' in v) userProps[k] = v.value
    }
    const sb = evalObjectScript(def.script, def.props, {
      layer,
      userProperties: userProps,
      getSceneLayer: (n) => byName.get(String(n)) || null,
      setTimeout: () => 0,
      clearTimeout: () => {},
      onError: () => {},
    })
    if (!sb) { fail(`${cs.id}: 交互脚本沙箱求值返回 null`); continue }
    ran++
    sb.init()
    sb.applyUserProperties(userProps)
    // 目标效果所在的层：显式给了就用，否则在全场景里按效果名找
    const effOwners = new Map()
    for (const name of cs.effects) {
      const owner = cs.target
        ? byName.get(cs.target)
        : scene.layers.find((l) => (l.effects || []).some((e) => e.name === name))
      if (owner) effOwners.set(name, owner)
    }
    const snap = () => cs.effects
      .map((n) => {
        const o = effOwners.get(n)
        const e = o && (o.effects || []).find((x) => x.name === n)
        return e ? (e.visible ? '1' : '0') : '?'
      })
      .join('')
    if (snap().includes('?')) { fail(`${cs.id}: 效果名 ${cs.effects.join('/')} 在场景里找不到（用例过期）`); continue }
    const seen = new Set()
    if (sb.hasUpdate) sb.callUpdate(true)
    seen.add(snap())
    // 交互形态有两类：点击循环（连点 3~4 次遍历状态）与悬停高亮（enter/leave 成对）。
    // 两类都派发，只要状态集合大于 1 就算切换生效。
    const ev = { worldPosition: makeCursorEventVec(0, 0, 0) }
    for (let i = 0; i < 4; i++) {
      sb.callCursor('cursorClick', ev)
      if (sb.hasUpdate) sb.callUpdate(true)
      seen.add(snap())
    }
    for (const name of ['cursorEnter', 'cursorLeave']) {
      sb.callCursor(name, ev)
      if (sb.hasUpdate) sb.callUpdate(true)
      seen.add(snap())
    }
    if (seen.size > 1) {
      toggled++
      console.log(`    ${cs.id} ${cs.btn}: 点击后效果可见性出现 ${seen.size} 种状态（${[...seen].join(' → ')}）✓`)
    } else {
      fail(`${cs.id} ${cs.btn}: 点击/悬停各派发后效果可见性始终是 ${[...seen][0]} —— 外观切换没生效` +
        `（getEffect 返回 null 或用户属性初值缺失，errCount=${sb.errCount} disabled=${sb.disabled}）`)
    }
  }
  console.log(`  可跑的外观切换用例：${ran} 个`)
  if (ran === 0) fail('一个外观切换用例都没跑起来（壁纸缺失或脚本探测失效）')
  else if (toggled === ran) ok(`${toggled} 个外观切换端到端生效`)

  // 「引擎层」脚本 + 父子变换重算：无 export、只往 shared 上装 helper 的脚本
  // （3786330502 id=885 装 createAnimation/updateAnimation）必须留住沙箱，否则
  // 宿主拿不到它的 engine、逐帧回填漏掉它，而 helper 是这个沙箱里的闭包，
  // 读的就是那份冻结在 0 的时钟 —— `engine.runtime - stateChangeTime < delay` 恒成立，
  // 点击绿色箭头后 shared.ck 翻了但图层一动不动。
  //
  // [2026-09-07 补] 更隐蔽的一层：父组动了子层必须跟着动。
  // 之前的断言用 `1711, 30, 0` 当 init / callUpdate 的种子 —— 那是 **local** 坐标，
  // 而渲染器实际喂的是 parse 烘好的 **world** `[3631, 1110, 0]`，且父组 origin 的
  // 变化无人读取（按键 957 的 world 早在 parse 阶段就拍平了）。等于断言了渲染器
  // 从不产生的坐标空间 + 一个没有任何像素依赖的变量。
  // 修法：跑真实 parseScene + 真实 recompose，量子层 world 是否跟随父组，
  // 并拿兄弟层「带」的 y 做独立对照（枪滑过去时应与丝带同一高度）。
  {
    const pkgPath = path.join(LIB, '3786330502', 'scene.pkg')
    const projPath = path.join(LIB, '3786330502', 'project.json')
    if (!fs.existsSync(pkgPath) || !fs.existsSync(projPath)) {
      ok('跳过 3786330502 引擎层时钟 + 父子变换用例（本机无此壁纸）')
    } else {
      const pkg = parsePkg(new Uint8Array(fs.readFileSync(pkgPath)))
      const sj = JSON.parse(new TextDecoder().decode(getEntry(pkg, 'scene.json')))
      const project = JSON.parse(fs.readFileSync(projPath, 'utf8'))
      const scene = parseScene(sj, project)
      const shared = {}
      const sandboxes = []
      const sbOwner = new Map()
      const runs = []
      const obj = (id) => scene.layers.find((l) => l.id === id)
      const LOCAL_SLOT = { origin: 'localOrigin', scale: 'localScale', angles: 'localAngles' }
      for (const layer of scene.layers) {
        const os = layer.objectScripts
        if (!os) continue
        for (const [field, def] of Object.entries(os)) {
          const sb = evalObjectScript(def.script, def.scriptproperties, {
            shared, layer,
            canvasSize: { x: 3840, y: 2160, width: 3840, height: 2160 },
            userProperties: project.general?.properties || {},
            onError: () => {},
          })
          if (!sb) continue
          sandboxes.push(sb)
          // 记下宿主侧的归属信息：翻 shared.ck 的是按键 957 的 visible 脚本，
          // 它没有 update，从 runs 里找不到（runs 只收 hasUpdate 的）。
          sbOwner.set(sb, { layerId: layer.id, field })
          const slot = LOCAL_SLOT[field] && Array.isArray(layer[LOCAL_SLOT[field]])
            ? LOCAL_SLOT[field] : field
          const fv = layer[slot]
          const initArg = Array.isArray(fv)
            ? { x: fv[0] ?? 0, y: fv[1] ?? 0, z: fv[2] ?? 0 }
            : fv
          sb.init(initArg)
          sb.applyUserProperties(project.general?.properties || {})
          if (sb.hasUpdate) runs.push({ layer, field, slot, sb, kind: field === 'visible' ? 'bool' : 'vec3' })
        }
      }
      const dirty = collectTransformDirty(scene.layers, [])
      const sbEngine = sandboxes.find((s) => !s.hasUpdate && !s.hasCursorHook) // 引擎层：无 update
      // 翻 shared.ck 的是按键 957 的 **visible** 脚本，它没有 update
      // （只导出 cursorClick + applyUserProperties），不能从 runs 里找。
      const btnHooks = sandboxes.filter((s) => s.hasCursorHook && sbOwner.get(s)?.layerId === 957)
      const sbBtn = btnHooks.length ? btnHooks : null
      if (!sbEngine) {
        fail('3786330502 id=885 引擎层沙箱为 null —— 宿主拿不到它的 engine，' +
          'shared 上的 helper 闭包会读到冻结在 0 的 runtime，动画闸门永不开启')
      } else if (sbEngine.hasUpdate) {
        fail('引擎层不该被判为有 update（会白占一个字段求值位）')
      } else if (!sbBtn) {
        fail('3786330502 按键 cursorClick 钩子缺失（用例过期）')
      } else {
        let t = 0
        const frame = () => {
          t += 1 / 60
          for (const sb of sandboxes) { sb.engine.frametime = 1 / 60; sb.engine.runtime = t }
          for (const r of runs) {
            if (r.sb.disabled) continue
            if (r.kind === 'vec3') {
              const cur = r.layer[r.slot]
              const v = { x: cur[0] || 0, y: cur[1] || 0, z: cur[2] || 0 }
              const ret = r.sb.callUpdate(v)
              const o = ret && typeof ret === 'object' && 'x' in ret ? ret : v
              r.layer[r.slot] = [o.x || 0, o.y || 0, o.z || 0]
            }
          }
          recomposeWorld(scene.layers, dirty)
        }
        for (let i = 0; i < 60; i++) frame()
        const gunIdle = obj(2243).origin[0]
        const groupIdle = obj(1061).origin[0]
        const btnIdle = obj(957).origin[0]
        const beltY = obj(896).origin[1]
        const gunIdleY = obj(2243).origin[1]
        sbBtn.forEach((s) => s.callCursor('cursorClick', { worldPosition: makeCursorEventVec(0, 0, 0) }))
        for (let i = 0; i < 300; i++) frame()
        const gunMoved = obj(2243).origin[0]
        const groupMoved = obj(1061).origin[0]
        const btnMoved = obj(957).origin[0]
        const gunMovedY = obj(2243).origin[1]
        // 判据 1：脚本在 local 空间，静置时枪不动（world 停在 parse 烘好的 5520）。
        // 之前喂 world 值会让脚本第一帧就往 local 目标 3600 滑，静置即漂移 1920px。
        if (Math.abs(gunIdle - 5520) > 1) {
          fail(`3786330502 静置 1s 枪 world.x 应 ≈5520（parse 烘好的初始位），实得 ${gunIdle.toFixed(1)}` +
            '—— 对象脚本喂了 world 值而非 local，图层第一帧就跳位')
        // 判据 2：父组 1061 动了，子层按键 957 必须跟着动。
        // 之前父组 origin 写了但子层 world 早在 parse 阶段拍平，按键钉死在 3631。
        } else if (Math.abs(btnIdle - btnMoved) < 100) {
          fail(`3786330502 点击后按键位移 ${Math.abs(btnMoved-btnIdle).toFixed(0)}px < 100` +
            '—— 父组 1061 动了，但子层按键 world 没重算（父子变换未逐帧合成）')
        // 判据 3：枪 ck=2 目标 1875（local）= world ≈ 3795，应与兄弟层「带」
        // （local 1905.9 → world 3825.9）差不多同一高度（y 差 ≈3px）。
        // 这是独立于脚本之外的构图判据 —— 丝带缠在枪上，y 必须接近。
        } else if (Math.abs(gunMovedY - beltY) > 30) {
          fail(`3786330502 点击后枪 y=${gunMovedY.toFixed(1)} vs 带 y=${beltY.toFixed(1)}` +
            `（差 ${Math.abs(gunMovedY-beltY).toFixed(1)}px）—— 丝带本该缠在枪上，` +
            '高度差过大说明坐标空间仍不对')
        // 判据 4：位移量合理，且 shared.ck 确实翻了
        } else if (Number(shared.ck) !== 2) {
          fail(`3786330502 点击后 shared.ck 应为 2，实得 ${shared.ck}`)
        } else if (Math.abs(groupMoved - 2920) > 30) {
          // 父 887 在 (1920,1080) + 父组 1061 local target 1000 = 2920
          fail(`3786330502 点击后父组 1061 world.x 应 ≈2920，实得 ${groupMoved.toFixed(1)}`)
        } else {
          ok(`3786330502 点击绿箭头：枪 ${gunIdle.toFixed(0)}→${gunMoved.toFixed(0)}` +
            `，按键随父组 ${btnIdle.toFixed(0)}→${btnMoved.toFixed(0)}` +
            `，枪 y 与丝带差 ${Math.abs(gunMovedY-beltY).toFixed(1)}px`)
        }
      }
    }
  }

  // 单元断言：getEffect 取不到时**必须返回句柄而不是 null**。
  // 语料里 9 处调用无一判空，返回 null 就是熔断。
  {
    const dummy = { name: 'L', effects: [{ name: 'A', visible: false }, { name: 'B', visible: true }] }
    const sb = evalObjectScript(
      'export function cursorClick(e) {\n' +
      "  thisLayer.getEffect('A').visible = true\n" +
      "  thisLayer.getEffect('不存在的效果').visible = true\n" +
      '  thisLayer.getEffect(1).visible = false\n' +
      '}\n',
      null,
      { layer: dummy, onError: () => {} },
    )
    if (!sb) fail('getEffect 单元用例：沙箱求值返回 null')
    else {
      sb.callCursor('cursorClick', { worldPosition: makeCursorEventVec(0, 0, 0) })
      if (sb.errCount > 0) fail(`getEffect 取不到效果时抛错了（errCount=${sb.errCount}），语料不判空会熔断`)
      else if (dummy.effects[0].visible !== true) fail('getEffect 按名字写 visible 没落到图层')
      else if (dummy.effects[1].visible !== false) fail('getEffect 按索引写 visible 没落到图层')
      else ok('getEffect 名字/索引两种取法都写回图层，取不到时不抛错')
    }
  }
}

// ---------------------------------------------------------------- 8. 粒子 flags=1 锁鼠标 + eventfollow
// 1425503532 Pac-Man 没有脚本、没有 locktopointer 字段：躲开光标全靠
// controlpoint flags bit0 + controlpointattract（负 scale 推开、正 scale 拉回），
// 本体/光晕/尾迹是 eventfollow 子级，必须跟着那颗隐形父粒子走。
console.log('\n【8. 粒子锁鼠标 / eventfollow】')
{
  const layer = { origin: [960, 540, 0], scale: [1, 1, 1], angles: [0, 0, 0] }
  const moverModel = {
    maxcount: 1,
    renderer: [],
    controlpoint: [
      { id: 0, flags: 0, offset: '0 0 0' },
      { id: 1, flags: 1, offset: '0 0 0' },
    ],
    emitter: [{ name: 'sphererandom', rate: 1000, distancemin: 0, distancemax: 0 }],
    initializer: [{ name: 'lifetimerandom', min: 60, max: 60 }],
    operator: [
      { name: 'movement', drag: 1 },
      { name: 'controlpointattract', controlpoint: 1, scale: -500, threshold: 64, origin: '0 0 0' },
      { name: 'controlpointattract', scale: 64, threshold: 999999, origin: '0 0 0' },
    ],
  }
  const parent = new ParticleSystem(null, moverModel, {}, layer)
  const cp1 = parent.controlPoints.find((c) => c.id === 1)
  if (!cp1 || !cp1.lockToPointer) fail('controlpoint flags=1 应视为 lockToPointer（Pac-Man 没有 locktopointer 字段）')
  else ok('flags bit0 映射为 lockToPointer')
  if (parent.renderers.length !== 0) fail(`显式 renderer:[] 应保持不画，实际 ${parent.renderers.length} 个渲染器`)
  else ok('显式空 renderer 不画（隐形父粒子）')

  const omitted = new ParticleSystem(null, { maxcount: 1 }, {}, layer)
  if (!omitted.renderers.length || omitted.renderers[0].kind !== 'sprite') {
    fail('renderer 缺省仍应回落到 sprite')
  } else ok('renderer 缺省回落 sprite')

  parent.setPointer(980, 540)
  for (let i = 0; i < 45; i++) parent.advance(1 / 60)
  const fled = parent.leaderParticle()
  const fleeDist = fled ? Math.hypot(fled.x, fled.y) : 0
  if (!fled) fail('锁鼠标排斥：0.75s 后父粒子不存在')
  else if (fleeDist < 20) fail(`锁鼠标排斥：指针在右侧 20px 时粒子应被推开，实际 dist=${fleeDist.toFixed(2)}`)
  else ok(`锁鼠标排斥：0.75s 推开 ${fleeDist.toFixed(1)}px`)

  parent.setPointer(0, 0)
  for (let i = 0; i < 300; i++) parent.advance(1 / 60)
  const home = parent.leaderParticle()
  const homeDist = home ? Math.hypot(home.x, home.y) : Infinity
  if (homeDist >= fleeDist) fail(`拉回原点：5s 后 dist=${homeDist.toFixed(2)} 未小于推开时的 ${fleeDist.toFixed(2)}`)
  else if (homeDist > 10) fail(`拉回原点：5s 后仍距原点 ${homeDist.toFixed(2)}px`)
  else ok(`拉回原点：5s 回到 ${homeDist.toFixed(2)}px`)

  const child = new ParticleSystem(
    null,
    {
      maxcount: 1,
      renderer: [{ name: 'sprite' }],
      emitter: [{ name: 'sphererandom', rate: 1000, distancemin: 0, distancemax: 0 }],
      initializer: [{ name: 'lifetimerandom', min: 10, max: 10 }],
    },
    {},
    layer,
  )
  child.attachFollow(parent, 'particle', [0, 0, 0])
  parent.advance(1 / 60)
  child.advance(1 / 60)
  const host = parent.leaderParticle()
  const w = parent.localToWorld(host.x, host.y)
  const dx = Math.abs(child.originX - w[0])
  const dy = Math.abs(child.originY - w[1])
  if (dx > 1e-6 || dy > 1e-6) {
    fail(`eventfollow 子级 origin (${child.originX.toFixed(2)},${child.originY.toFixed(2)}) 应对到父粒子世界位置 (${w[0].toFixed(2)},${w[1].toFixed(2)})`)
  } else ok('eventfollow 子级 origin 跟随父粒子')

  const pkgPath = path.join(LIB, '1425503532', 'scene.pkg')
  if (!fs.existsSync(pkgPath)) {
    ok('跳过 1425503532 语料（本机无此壁纸）')
  } else {
    const buf = fs.readFileSync(pkgPath)
    const pkg = parsePkg(new Uint8Array(buf))
    const raw = getEntry(pkg, 'particles/pacman.json')
    if (!raw) fail('1425503532 缺少 particles/pacman.json')
    else {
      const model = JSON.parse(new TextDecoder().decode(raw))
      const pac = new ParticleSystem(null, model, {}, { origin: [474.225, 540, 0], scale: [1, 1, 1], angles: [0, 0, 0] })
      const pcp1 = pac.controlPoints.find((c) => c.id === 1)
      if (!pcp1 || !pcp1.lockToPointer) fail('1425503532 pacman cp1 flags=1 未锁鼠标')
      else if (pac.renderers.length !== 0) fail('1425503532 pacman 的 renderer:[] 被填成了 sprite')
      else if (pac.ops.attract.length < 2) fail(`1425503532 pacman 应有 2 个 controlpointattract，实际 ${pac.ops.attract.length}`)
      else ok('1425503532 pacman：cp1 锁鼠标、空 renderer、排斥+回拉')
    }
  }

  // 3233141951 鼠标轨迹（樱花）：CP0 flags=1 是系统原点锁指针。
  // 粒子必须生在光标局部坐标，鼠标挪开后旧粒子留在原地（轨迹），不能跟着 origin 平移。
  {
    const layer = { origin: [2048, 1148, 0], scale: [1, 1, 1], angles: [0, 0, 0] }
    const trail = new ParticleSystem(
      null,
      {
        maxcount: 64,
        controlpoint: [
          { id: 0, flags: 1, offset: '0 0 0' },
          { id: 1, flags: 0, offset: '0 0 0' },
        ],
        emitter: [{ name: 'sphererandom', rate: 1000, distancemin: 0, distancemax: 0 }],
        initializer: [{ name: 'lifetimerandom', min: 10, max: 10 }],
      },
      {},
      layer,
    )
    trail.advance(1 / 60)
    if (trail.liveCount() !== 0) fail('CP0 锁鼠标但还没有指针时不应在图层原点预发生粒子')
    trail.setPointer(2100, 1200)
    trail.advance(1 / 60)
    const first = trail.leaderParticle()
    const local = [2100 - 2048, 1200 - 1148]
    if (!first) fail('CP0 锁鼠标：有指针后应在光标处生成')
    else if (Math.hypot(first.x - local[0], first.y - local[1]) > 2) {
      fail(`樱花应生在光标局部 (${local[0]},${local[1]})，实得 (${first.x.toFixed(1)},${first.y.toFixed(1)})`)
    } else ok('CP0 锁鼠标：粒子生在光标处（不是图层原点）')

    const oldX = first.x
    const oldY = first.y
    trail.setPointer(1800, 900)
    trail.advance(1 / 60)
    if (Math.hypot(first.x - oldX, first.y - oldY) > 1) {
      fail(`鼠标挪开后旧粒子应留在原地，却从 (${oldX.toFixed(1)},${oldY.toFixed(1)}) 挪到 (${first.x.toFixed(1)},${first.y.toFixed(1)})`)
    } else ok('鼠标挪开后旧粒子留在原地（轨迹而不是粘团）')
  }

  const pkgCherry = path.join(LIB, '3233141951', 'scene.pkg')
  if (!fs.existsSync(pkgCherry)) {
    ok('跳过 3233141951 语料（本机无此壁纸）')
  } else {
    const buf = fs.readFileSync(pkgCherry)
    const pkg = parsePkg(new Uint8Array(buf))
    const raw = getEntry(pkg, 'particles/workshop/2093672045/Cherry_Blossoms_2.json')
    if (!raw) fail('3233141951 缺少 Cherry_Blossoms_2.json')
    else {
      const model = JSON.parse(new TextDecoder().decode(raw))
      const ps = new ParticleSystem(
        null,
        model,
        { count: 0.25, size: 1.22, alpha: 0.85, colorn: '0.98824 0.77647 0.92941' },
        { origin: [2048, 1148, 0], scale: [1, 1, 1], angles: [0, 0, 0] },
      )
      const cp0 = ps.controlPoints.find((c) => c.id === 0)
      if (!cp0 || !cp0.lockToPointer) fail('3233141951 樱花 CP0 flags=1 未锁鼠标')
      else if (!ps.init.mapAround) fail('3233141951 樱花应编译 mapsequencearoundcontrolpoint')
      else {
        ps.setPointer(2200, 1300)
        for (let i = 0; i < 30; i++) ps.advance(1 / 60)
        const live = ps.liveCount()
        let near = 0
        const lx = 2200 - 2048
        const ly = 1300 - 1148
        for (const p of ps.pool) {
          if (!p.alive) continue
          if (Math.hypot(p.x - lx, p.y - ly) < 80) near++
        }
        if (live < 5) fail(`3233141951 樱花 0.5s 存活 ${live}，应在光标附近形成轨迹`)
        else if (near < live * 0.5) fail(`3233141951 樱花存活 ${live} 但光标 80px 内只有 ${near}`)
        else ok(`3233141951 樱花轨迹：${live} 颗，${near} 颗在光标附近`)
      }
    }
  }

  const psrc = fs.readFileSync(path.join(ROOT, 'renderer/vendor/we-scene/render/particles.js'), 'utf8')
  if (!/num\(cp\.flags/.test(psrc) || !/& 1/.test(psrc)) {
    fail('particles.js 不再把 controlpoint.flags bit0 当成 lockToPointer')
  }
  if (!/_cpPos\(em\.controlPoint\)/.test(psrc) || !/mapsequencearoundcontrolpoint/.test(psrc)) {
    fail('particles.js 不再把发射器叠到控制点 / 未实现 mapsequencearoundcontrolpoint（樱花会堆在图层原点）')
  }
  const mount = fs.readFileSync(path.join(ROOT, 'renderer/src/scene-mount.ts'), 'utf8')
  if (!/attachFollow\(/.test(mount) || !/eventfollow/.test(mount)) {
    fail('scene-mount 未把 eventfollow 子级 attachFollow 到父系统（方法在也能独立跑，挂载仍会各动各的）')
  }
}

// ---------------------------------------------------- cursorripple 力场 FBO
console.log('\n【cursorripple 力场 FBO fit】')
{
  if (typeof effectFboSize !== 'function') {
    fail('renderer.js 未导出 effectFboSize（cursorripple 的 fit:512 会再被忽略）')
  } else {
    const [w, h] = effectFboSize({ fit: 512 }, 3840, 2160)
    if (w !== 512 || h !== 288) {
      fail(`3299228616 力场 FBO 应为 512×288（fit:512 纳入 3840×2160），实得 ${w}×${h}`)
    } else ok('3299228616 cursorripple 力场 FBO 512×288（与 simulate 蒙版同尺寸）')
    const [w2, h2] = effectFboSize({ fit: 256 }, 1920, 1080)
    if (w2 !== 256 || h2 !== 144) {
      fail(`fit:256 纳入 1920×1080 应为 256×144，实得 ${w2}×${h2}`)
    } else ok('fit:256 按长边等比缩小')
    const [w3, h3] = effectFboSize({ scale: 2 }, 1024, 512)
    if (w3 !== 512 || h3 !== 256) {
      fail(`scale:2 应为半分辨率 512×256，实得 ${w3}×${h3}`)
    } else ok('scale 仍按层 FBO 除数（bloom/bokeh 不受 fit 影响）')
    const [w4, h4] = effectFboSize({}, 800, 600)
    if (w4 !== 800 || h4 !== 600) fail(`无 scale/fit 应保持 ${800}×${600}，实得 ${w4}×${h4}`)
    else ok('未声明 scale/fit 的 FBO 保持层尺寸')
  }
  const rsrc = fs.readFileSync(path.join(ROOT, 'renderer/vendor/we-scene/render/renderer.js'), 'utf8')
  if (!/effectFboSize\(f,\s*fboW,\s*fboH\)/.test(rsrc)) {
    fail('效果链分配 FBO 时未调用 effectFboSize（fit 公式在也不接线）')
  } else ok('效果链 FBO 分配走 effectFboSize（fit 真正生效）')

  const pkgPath = path.join(LIB, '3299228616', 'scene.pkg')
  if (!fs.existsSync(pkgPath)) {
    ok('跳过 3299228616 语料（本机无此壁纸）')
  } else {
    const pkg = parsePkg(new Uint8Array(fs.readFileSync(pkgPath)))
    const ej = JSON.parse(new TextDecoder().decode(getEntry(pkg, 'effects/cursorripple/effect.json')))
    const f1 = (ej.fbos || []).find((f) => f.name === '_rt_EightBuffer1')
    if (!f1 || Number(f1.fit) !== 512) {
      fail('3299228616 cursorripple 的 _rt_EightBuffer1 应变为 fit:512')
    } else if (typeof effectFboSize === 'function') {
      const [ew, eh] = effectFboSize(f1, 3840, 2160)
      if (ew !== 512 || eh !== 288) fail(`语料 fit:512 算出 ${ew}×${eh}，应为 512×288`)
      else ok('3299228616 语料 fit:512 → 512×288')
    }
  }
}

console.log(errors.length === 0 ? '\n✓ 全部通过' : `\n✗ 共 ${errors.length} 处问题`)
process.exit(errors.length === 0 ? 0 : 1)
