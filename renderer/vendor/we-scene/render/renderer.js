import { mat4Identity, mat4Multiply, mat4Ortho, mat4RotateX, mat4RotateY, mat4RotateZ, mat4Translate, mat4Scale, mat4Invert, mat4Transpose, mat4TransformPoint, buildCamera, parallaxDepthFactor, layerWorldOrigin } from './math.js'
import { hlsl2glsl } from './hlsl2glsl.js'
// WebGL2 通用 pass 管线渲染器（移植 linux-wallpaperengine 架构）：
// 每层 copy pass → 效果链（WE shader 转译执行，FBO 乒乓）→ 合成到画布。
// copy/合成用自写 shader；效果 pass 用转译 WE shader（MVP=单位矩阵，mul 转置无影响）。
// 空间：层 FBO 内容正立（v-down 显示空间），与 WE 帧缓冲空间（v-up+倒置画面）数学等价（docs/WE_RENDER_CONVENTIONS.md §1）。

// [we-scene patch] 导出：hit-test（render/hittest.js）必须用**同一份** alignment 表
// 复算图层几何，否则命中区与画面错开一个锚点偏移。
// [we-scene patch] 模块结构（本仓库拆分，见 docs/ARCHITECTURE.md）：
//   renderer-glsl.js  ALIGN/混合映射/内联 GLSL/quad 顶点/GL_TYPES（纯数据）
//   gl-util.js        linkProgram/compile/makeTexture/makeTextureMip（GL 小工具）
//   renderer.js       本文件：createRenderer（GL 上下文、缓存、装配与三级绘制循环）
// ALIGN / makeTexture / makeTextureMip 仍从本文件 re-export（verify-pointer、
// main.ts 等既有 import 方不变）。
import { COLOR_BLEND_GL, BLEND_PREP, COMPOSITE_BLEND_FRAG, COPY_VERT, COPY_FRAG, COMPOSITE_FRAG, BACKDROP_FRAG, layerQuadVerts, passQuadVerts, localQuadVerts, GL_TYPES, ALIGN } from './renderer-glsl.js'
import { linkProgram, compile, parseVec3Local, makeTexture, makeTextureMip } from './gl-util.js'
import { createAnimation, linkAnimations } from './animation.js'
// applyBlending：WE 32 个混合模式的 CPU 逐字实现，供 applyColorBlendCPU 在
// shader 侧混合的模式下做参考（effects.js 零 import，不构成环）。
import { applyBlending } from './effects.js'

/**
 * [we-scene patch] puppet 骨骼动画能把网格推出层矩形多远（视锥裁剪的额外余量，[x, y] 像素）。
 *
 * 视锥裁剪判的是图层的**静态** origin，可 puppet 的网格是被骨骼动画推着走的：
 * 「停在屏外、靠动画开进画面」的层会被每帧裁掉，动画永远播不出来。
 * 2477602742 的三节火车 origin 在 x=5613/11478/17315（场景仅 2560 宽），
 * Train2/Train3 静态判定下必被裁；它们的动画把根骨拉出 18000+px，正是驶过道口的那几秒。
 * 症状是道口灯闪、栏杆落、汽笛响，唯独没有车。
 *
 * 单独导出而非内联在 isLayerOffscreen 里，是为了能被 verify-groups 直接调用做回归 ——
 * 内联时只能用正则近似检查接线，改坏了测不出来。
 */
export function puppetAnimMargin(layer) {
  const b = layer && layer.puppet && layer.puppet.animBound
  if (!b) return [0, 0]
  // 两轴量级差很大（火车 x=18046 / y=4425），必须分轴，共用一个余量会过度放宽
  return [b.x * Math.abs(layer.scale[0]), b.y * Math.abs(layer.scale[1])]
}

/**
 * [we-scene patch] 空容器效果把 Transparency 设成 Preserve（combo=0）时，
 * shader 写 `alpha = scene.a`。空画布 scene.a=0 ⇒ 音条整层消失或变成一块纯色。
 * 作者要的是「叠在已画内容上、没 bar 的地方保持原样」，等价于 passthrough。
 * 3233141951「剑音条」显式 TRANSPARENCY=0 却没打 passthrough 旗标；中音条走默认
 * REPLACE（1），不走这条。
 */
export function layerWantsPreserveBackdrop(layer) {
  for (const e of (layer && layer.effects) || []) {
    if (e.visible === false) continue
    const n = Math.max((e.passes || []).length, (e.materialPasses || []).length)
    for (let i = 0; i < n; i++) {
      const pc = (e.passes && e.passes[i] && e.passes[i].combos) || {}
      const mc = (e.materialPasses && e.materialPasses[i] && e.materialPasses[i].combos) || {}
      const t = pc.TRANSPARENCY !== undefined ? pc.TRANSPARENCY : mc.TRANSPARENCY
      if (Number(t) === 0) return true
    }
  }
  return false
}

/**
 * [we-scene patch] 组渲染目标要收进 FBO / 主循环跳过的图层 id。
 *
 * `layer.childIds` 只有**直接**孩子。3787937755 的「可调整组合层」1361 挂
 * depthparallax，直接孩子只有身子 68；眼睛 1115、手 72 是 68 的孩子。
 * 只 add 直接 childIds 的话，身子进组吃视差，眼睛在主循环按世界坐标另画，
 * 鼠标一动就从眼眶里滑出去。全库 6 个组容器带孙层 / 5 张壁纸。
 *
 * 粒子和后期层不进组（renderContainerGroup 本来就不画它们），留给主循环。
 */
export function collectGroupDescendantIds(layer, layerById, out) {
  if (!out) out = new Set()
  if (!layerById) return out
  for (const id of layer.childIds || []) {
    const child = layerById.get(id)
    if (!child || child.particle || child.isPostProcess) continue
    out.add(id)
    collectGroupDescendantIds(child, layerById, out)
  }
  return out
}

/**
 * [we-scene patch] 图层 colorBlendMode → GL 混合模式名 + shader 侧源色预处理档位。
 *
 * 返回 `{ mode, prep }`：`mode` 交给 blendFunc 选因子，`prep` 是 u_BlendPrep 的值
 * （0=直通 / 1=乘 src.a / 2=向白插值）。**两者必须配套**，单独改一边就错。
 *
 * WE 的语义是 `mix(dst, Blend(dst, src), op)`，op 含层 alpha × 效果链写出的 alpha：
 *   Screen   展开 = dst + op*(src - dst*src)
 *   Multiply 展开 = dst*(1 - op + op*src)
 * op 都乘在 **src 一侧**，而固定管线的 dst 因子只有 ONE_MINUS_SRC_COLOR / SRC_COLOR
 * 这种「原样的 src」可选 —— op 不可能在 blendFunc 里表达，只能预先合进 src.rgb：
 *   Screen  : src' = src*op          ⇒ blendFunc(ONE, ONE_MINUS_SRC_COLOR)
 *   Multiply: src' = mix(1, src, op) ⇒ blendFunc(DST_COLOR, ZERO)
 * 取 1 / 0 分别是两种混合的单位元（Screen 叠黑不变、Multiply 叠白不变），
 * 故 op=0 时精确退化为「这一层不存在」。
 *
 * 不做预处理的后果：src.a 在 blendFunc 里根本没出现，任何半透明层都按**全不透明**合成。
 * 3789462324「Clouds Back」层 alpha=0.5、opacity 效果再乘 0.26（实际 0.13），
 * 却把云按 100% 盖在人物脸上 —— 即用户报的「云被渲染在人物前面」。
 * 归属证据：把该层 colorBlendMode 由 7 改成 0（走 translucent，正确用了 SRC_ALPHA）
 * 人物立刻干净。
 *
 * 单独导出而非内联进 setColorBlend，是为了能被 verify-groups 直接调用做数值回归 ——
 * 内联时只能用正则近似检查接线，改坏了测不出来（见 G 区块同样的教训）。
 */
export function colorBlendPlan(colorBlendMode) {
  const mode = COLOR_BLEND_GL[colorBlendMode] || 'translucent'
  return { mode, prep: BLEND_PREP[mode] || 0 }
}

/**
 * [we-scene patch] 这个 colorBlendMode 是否必须走 shader 侧混合（回读背景）。
 *
 * COLOR_BLEND_GL 只收录能用固定管线 blendFunc 表达的 5 个编号（2/6/7/9/31）。
 * 其余非 0 编号此前一律回退 translucent —— 即「按不透明色盖上去」，对
 * ColorBurn / Overlay / SoftLight / HSL 系这些 dst 的非线性函数完全不成立。
 *
 * 实测后果（3287715210「发光少女」，用户报「壁纸不显示人物」）：作者在人物层
 * **之上**放了一张 7200x4800 的渐变图，colorBlendMode=3（ColorBurn）。该图是
 * JPEG——没有 alpha 通道，解码后 alpha 恒 1——所以 translucent 回退把它当成
 * 一张完全不透明的幕布，人物 100% 被盖住。作者预览图里人物清晰可见，渐变只是
 * 一层染色。
 *
 * mode 0（Normal）与缺省不在此列：它们的语义本就是 translucent 的 mix，
 * 固定管线精确表达，走回读只是白烧一次画布拷贝。
 *
 * 影响面（本地库 246 张全扫）：16 个编号 / 65 层 / 约 30 张壁纸此前静默走错。
 * 单独导出而非内联，是为了让离线判据能直接调用做数值回归。
 */
export function needsShaderBlend(colorBlendMode) {
  const m = Number(colorBlendMode)
  if (!Number.isFinite(m) || m === 0) return false
  return !COLOR_BLEND_GL[m]
}

/**
 * [we-scene patch] colorBlendPlan 的 CPU 参考实现：给定 dst/src/op 算出合成结果。
 * 与 GPU 路径**同源**（同一张 COLOR_BLEND_GL / BLEND_PREP 表 + 同样的因子），
 * 供 verify-groups 逐模式核对代数恒等式。改了 GPU 侧却没同步这里，测试会立刻炸。
 */
export function applyColorBlendCPU(colorBlendMode, dst, src, op) {
  // shader 侧混合的模式：CPU 参考就是 applyBlending 本体（effects.js 那份逐字实现），
  // 不能套固定管线那套因子推导 —— 两条路径的代数完全不同。
  if (needsShaderBlend(colorBlendMode)) {
    return applyBlending(colorBlendMode, [dst, dst, dst], [src, src, src], op)[0]
  }
  const { mode, prep } = colorBlendPlan(colorBlendMode)
  // shader 侧的 u_BlendPrep
  let s = src
  if (prep === 1) s = src * op
  else if (prep === 2) s = 1 - op + src * op
  // 固定管线的 blendFunc
  if (mode === 'screen') return s + dst * (1 - s) // (ONE, ONE_MINUS_SRC_COLOR)
  if (mode === 'multiply') return dst * s // (DST_COLOR, ZERO)
  if (mode === 'additive') return dst + src * op // (SRC_ALPHA, ONE)
  return dst * (1 - op) + src * op // translucent (SRC_ALPHA, ONE_MINUS_SRC_ALPHA)
}

/**
 * 效果自定义 FBO 的像素尺寸。
 *
 * `scale`：相对层 FBO 的除数（2 = 半分辨率），工坊 bloom/bokeh 用这个。
 * `fit`：长边上限。cursorripple 的 `_rt_EightBuffer*` 写 `fit: 512`，配套蒙版
 * 按这个分辨率绘制（3299228616 的 simulate 蒙版就是 512×288 = 3840×2160 纳入
 * 512 长边）。忽略 fit 时力场跑在整层（4K），`simTexel * 100` 的邻域在 UV 里
 * 缩了 7.5 倍，8bit 每帧再减 1/255，波还没传开就被量化掉 —— 看起来就是
 * 「鼠标涟漪没触发」。
 *
 * 单独导出给 verify-pointer 做数值回归：改坏了公式，离线就能红。
 */
export function effectFboSize(fboDef, baseW, baseH) {
  const scale = (fboDef && Number(fboDef.scale)) || 1
  let w = Math.max(1, Math.round(baseW / (scale || 1)))
  let h = Math.max(1, Math.round(baseH / (scale || 1)))
  const fit = fboDef && Number(fboDef.fit)
  if (Number.isFinite(fit) && fit > 0) {
    const long = Math.max(w, h)
    if (long > fit) {
      const s = fit / long
      w = Math.max(1, Math.round(w * s))
      h = Math.max(1, Math.round(h * s))
    }
  }
  return [w, h]
}

/**
 * xray.frag 把 sprite UV 按 `v_PointerScale` 从中心拉开：
 *   uv = (d - 0.5) * scale * … + 0.5
 *
 * 两套不能混的「大小」：
 *   - **开窗**（采 halo 贴图的窗口）：scale 越大，UV 拉得越开，采到更多黑边。
 *     size 滑条要的不是这个。
 *   - **效果范围**（halo 亮区盖住的层 UV 半径）：∝ 1/scale。size 变大要的是这个。
 *
 * 新版 vert 写 `v_PointerScale = mix(999, 1/g_PointerScale, …)`，size 变大则
 * 范围变大。size=1 时 1/g 是恒等。frag 若乘到 g 而不是 1/g，调大 size 范围会缩。
 *
 * 离线断言用这个纯函数，不要在测试里再抄一份 mix/step。
 */
export function xrayUvScale(gPointerScale) {
  const g = Number(gPointerScale)
  if (!Number.isFinite(g) || g < 0.001) return 999
  return 1 / g
}

/**
 * 未收到鼠标时 xray 开窗用的屏幕归一化坐标：一整屏在相机左上外。
 * 不要改成 (0.5,0.5)（壁纸圆心一个洞），也不要改全局指针初值（视差/iris
 * 要相对中心为零）。只在本文件 bind 时对 xray 替换。
 */
export const XRAY_IDLE_SCREEN_UV = -1

/**
 * 还没收到指针事件时，xray 开窗不能停在屏幕中心。只判定 xray（程序里有
 * `g_PointerScale`）；iris / ripple 仍用中心，避免眼球看向屏外、涟漪从角上起。
 */
export function xrayShouldParkPointer(pointerHas, hasPointerScaleUni) {
  return !!hasPointerScaleUni && !pointerHas
}

const XRAY_FRAG_UV_SCALE =
  'mix(999.0, 1.0 / max(g_PointerScale, 0.001), step(0.001, g_PointerScale))'

/**
 * 新版（`*= v_PointerScale`）和旧版 1586038665（`*= g_PointerScale`）都改成
 * 在片元里对 `g_PointerScale` 取倒数。size=1 时 1/g 是恒等；size=10 若不倒，
 * UV 拉开会把亮区缩成光标旁一个小圆点。不要在 JS setConstant 里再倒一次
 * （新版 vert 已有 1/g，会双倒：size=1 仍对、调大范围又缩回去）。
 */
export function rewriteXrayFragScale(fragGlsl) {
  if (typeof fragGlsl !== 'string') return fragGlsl
  if (/unprojectedUVs\s*\*=\s*mix\(999\.0,\s*1\.0\s*\/\s*max\(\s*g_PointerScale/.test(fragGlsl)) {
    return fragGlsl
  }
  const usesVarying = /unprojectedUVs\s*\*=\s*v_PointerScale\s*\*/.test(fragGlsl)
  const usesUniform = /unprojectedUVs\s*\*=\s*g_PointerScale\s*\*/.test(fragGlsl)
  if (!usesVarying && !usesUniform) return fragGlsl
  let out = fragGlsl
  if (!/uniform\s+float\s+g_PointerScale\b/.test(out)) {
    out = out.replace(/void\s+main\s*\(/, 'uniform float g_PointerScale;\nvoid main(')
  }
  const from = usesVarying
    ? /unprojectedUVs\s*\*=\s*v_PointerScale\s*\*/
    : /unprojectedUVs\s*\*=\s*g_PointerScale\s*\*/
  return out.replace(from, 'unprojectedUVs *= ' + XRAY_FRAG_UV_SCALE + ' *')
}

/**
 * xray 的 `size` 在作者没配时该取多少。
 *
 * shader 注释写的是 `"default":0.2`，但那是**编辑器新建效果时滑条的初始位置**，
 * 不是运行时缺省：WE 编辑器一旦把效果加到层上，就会把当时的滑条值写进
 * `constantshadervalues`，所以官方运行时永远读得到一个显式值，注释里的 0.2
 * 从来没被当作 fallback 用过（本地库 17 个 xray pass 全都显式带 size）。
 *
 * 我们这边不一样：`bindConstants` 的兜底循环在缺键时会套用注释 default，
 * 于是 csv 里没有 `size` 的 pass 拿到 0.2 —— 经 `xrayUvScale` 取倒数是 5，
 * UV 被放大五倍，效果范围缩成光标旁一小块。缺省应当是**恒等**：1 时
 * `1/1 = 1`，UV 不缩放，效果范围就等于作者给的 halo 贴图本身。
 *
 * 只对 `g_PointerScale` 生效：其余 uniform 的注释 default（`multiply` 的 1、
 * 贴图槽的 `particle/halo_6`）与编辑器初值一致，动了会回归。
 */
export const XRAY_SIZE_FALLBACK = 1

/**
 * 缺键时该用哪个 default。返回 undefined 表示「不设这个 uniform」。
 * 抽成纯函数供离线判据调用，不要在测试里再抄一份分支。
 */
export function constantFallback(uniformName, declaredDefault) {
  if (uniformName === 'g_PointerScale') return XRAY_SIZE_FALLBACK
  return declaredDefault
}

export function createRenderer(canvas, opts = {}) {
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, antialias: false, alpha: false, preserveDrawingBuffer: true })
  if (!gl) throw new Error('当前浏览器不支持 WebGL2')
  const shaderResolver = opts.shaderResolver || (async () => null)
  const diag = opts.diag || (() => {})
  // [we-scene patch] 视频帧中转离屏 canvas（video→GL 直传在部分 WebView 受限，用 drawImage 中转更稳）
  const videoCanvas = typeof document !== 'undefined' ? document.createElement('canvas') : null
  if (videoCanvas) {
    videoCanvas.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:2px;height:2px;opacity:0'
  }
  let videoCanvasReported = false
  // [we-scene patch] 上次上报的视频纹理上传尺寸（"WxH"）。上限随渲染目标变化，
  // 变了就重报一次，便于确认清晰度设置是否真的生效。
  let videoTexReportedSize = ''
  // [we-scene patch] 视频纹理上传的尺寸兜底上限（见 renderLayer 的视频纹理分支）。
  // HARD_CAP：即使硬件 MAX_TEXTURE_SIZE 和渲染目标都更大，也不超过这个值 ——
  //   4K 逐帧 texImage2D 在部分驱动上会掉帧，3840 是"够用且还扛得住"的档。
  // MIN_CAP：渲染目标尺寸在首帧前可能是 0/1，别据此把纹理压成一条线。
  const VIDEO_TEX_HARD_CAP = 3840
  const VIDEO_TEX_MIN_CAP = 1024
  // FBO 分辨率限幅系数：0 = 关闭（全质量）；>0 时效果链 FBO 上限 = 屏幕占比 × 系数
  let fboCapFactor = opts.fboCapFactor === undefined ? 0 : opts.fboCapFactor
  // [we-scene patch] 粒子每帧推进（由宿主注入，见 setParticleRenderer）
  let particleAdvanceFn = null
  // [we-scene patch] 粒子按图层渲染回调：fn(layerId, cam, viewProj, w, h)
  // 在 renderScene 的图层迭代中遇到 particle 层时调用，把粒子渲染到正确的 z 序位置。
  let particleRenderByLayer = null
  // [we-scene patch] 音频频谱源：宿主每帧 update 后由 bindSystemUniforms 把快照喂给
  // 效果 shader 的 g_AudioSpectrum*Left/Right uniform 数组（WE 保留 uniform 名，实测
  // 135/45/49 个效果 shader 在用）。provider 为纯取值函数（读当前快照，不推进状态）。
  let audioSnapshot = null
  const AUDIO_SPECTRUM_UNIFORMS = [
    ['g_AudioSpectrum16Left', 'left16'], ['g_AudioSpectrum16Right', 'right16'],
    ['g_AudioSpectrum32Left', 'left32'], ['g_AudioSpectrum32Right', 'right32'],
    ['g_AudioSpectrum64Left', 'left64'], ['g_AudioSpectrum64Right', 'right64'],
  ]
  function setAudioProvider(snapshotProvider) {
    audioSnapshot = snapshotProvider || null
  }
  // [we-scene patch] 效果常量脚本的运行时依赖，由宿主注入（见 setConstantScriptRuntime）。
  // 不在本文件直接 import text.js：renderer.js 是纯渲染层，text.js 带字体/画布依赖，
  // 硬引入会让离线校验脚本（无 DOM）连渲染器都加载不起来。
  let evalObjectScriptFn = null
  let userProps = null
  let scriptAudioViews = null
  let scriptShared = null
  let scriptInputView = null
  // [we-scene patch] engine.setTimeout/setInterval（SCENESCRIPT-PLAN P1-1）：效果常量
  // 是定时器的挂点之一（全库 8 处），由宿主注入统一的一份 createEngineTimers 实例。
  let scriptTimers = null
  // [we-scene patch] 效果常量沙箱是**惰性创建**的（首次渲染到该 pass 才建），
  // 宿主没法一次性扫出来，所以留一个回调：新建带媒体钩子的沙箱时反向登记给宿主。
  // 效果常量是媒体回调的最大挂载点（全库 101/308），不接这个口子它们一处都收不到。
  let constScriptSink = null
  const constScriptCache = new Map()
  const constAnimCache = new Map()
  // 联动组接线是一次性的（悬空 parent 的诊断不能每帧重报）
  const constAnimLinkedCache = new Set()
  // [we-scene patch] 常量动画的帧事件共享队列：常量动画在 render 内（bindConstants
  // 里）推进，事件由此推入，宿主帧循环在 render 后统一做图层级广播
  //（官方 AnimationEvent：同层全部脚本的 animationEvent(event, value)）。
  let constAnimEventQueue = null
  const constScriptDiag = { total: 0, ok: 0, failed: 0 }
  function setConstantScriptRuntime(evalFn, opts) {
    evalObjectScriptFn = typeof evalFn === 'function' ? evalFn : null
    userProps = (opts && opts.userProperties) || null
    scriptAudioViews = (opts && opts.audioViews) || null
    scriptShared = (opts && opts.shared) || null
    scriptInputView = (opts && opts.inputView) || null
    scriptTimers = (opts && opts.timers) || null
    constScriptSink = (opts && typeof opts.onSandbox === 'function') ? opts.onSandbox : null
    constAnimEventQueue = (opts && Array.isArray(opts.animEventQueue)) ? opts.animEventQueue : null
    constScriptCache.clear()
    constAnimCache.clear()
    constAnimLinkedCache.clear()
  }
  // [we-scene patch] 容器效果画布的首帧诊断开关
  let containerDiagDone = false

  const copyProg = linkProgram(gl, COPY_VERT, COPY_FRAG)
  const compProg = linkProgram(gl, COPY_VERT, COMPOSITE_FRAG)
  const backdropProg = linkProgram(gl, COPY_VERT, BACKDROP_FRAG)
  // [we-scene patch] 固定管线表达不了的 colorBlendMode（ColorBurn/Overlay/HSL 系…）
  // 走这条：回读背景当纹理，在 shader 里用 ApplyBlending 算完直接写。见 shaderBlendMode。
  const compBlendProg = linkProgram(gl, COPY_VERT, COMPOSITE_BLEND_FRAG)

  const vao = gl.createVertexArray()
  gl.bindVertexArray(vao)
  const vbuf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, vbuf)
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0)
  gl.enableVertexAttribArray(1)
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 20, 12)
  gl.bindVertexArray(null)

  // FBO 缓存（tag 区分用途：乒乓 A/B 必须是两个独立实例；同一 tag+尺寸复用）
  const fboCache = new Map()
  let fboStamp = 1
  function getFBO(w, h, tag) {
    const key = (tag || '') + '|' + w + 'x' + h
    if (fboCache.has(key)) {
      const hit = fboCache.get(key)
      hit.stamp = fboStamp
      return hit
    }
    const fbo = gl.createFramebuffer()
    const tex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    // 新建附件内容未定义。效果的中间 target FBO（_rt_*）可能因其写入 pass 编译失败而
    // 始终没被写过，后续 pass 采样到未定义内容会得到整屏白/花屏，故先清零。
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    const entry = { fbo, tex, width: w, height: h, stamp: fboStamp }
    fboCache.set(key, entry)
    return entry
  }
  function pruneUnusedFbos() {
    for (const [key, entry] of fboCache) {
      if (entry.stamp === fboStamp) continue
      if (entry.fbo) gl.deleteFramebuffer(entry.fbo)
      if (entry.tex) gl.deleteTexture(entry.tex)
      fboCache.delete(key)
    }
  }

  // 效果 shader 缓存：key = shaderName + '|' + JSON.stringify(combos)
  const progCache = new Map()
  const includeCache = new Map()
  const shaderSrcCache = new Map()
  // 解析 material 元数据：uniform 声明行注释里的 {"material":"speedx","default":1} → { speedx: { uniform, default } }
  function parseMaterialMeta(src) {
    const meta = {}
    const re = /uniform\s+[A-Za-z0-9_]+\s+([A-Za-z_][A-Za-z0-9_]*)[^;]*;\s*\/\/([^\n]*)/g
    let m
    while ((m = re.exec(src)) !== null) {
      const uniformName = m[1]
      const comment = m[2]
      const mat = /"material"\s*:\s*"([^"]+)"/.exec(comment)
      if (!mat) continue
      const def = /"default"\s*:\s*("(?:[^"]*)"|-?\d+(?:\.\d+)?)/.exec(comment)
      meta[mat[1]] = { uniform: uniformName, default: def ? parseDefaultValue(def[1]) : undefined }
    }
    return meta
  }

  // [we-scene patch] sampler 槽的默认贴图：`uniform sampler2D g_Texture2; //
  // {"material":"sprite","default":"particle/halo_6"}` —— scene.json 里该槽为 null 时
  // 应回退到这个声明值，而不是白纹理。
  //
  // 为什么单独解析：parseMaterialMeta 按 **material 名**建索引（供 bindConstants 用），
  // 而纹理是按 **sampler 序号**绑定的，两者对不上，于是纹理槽的 default 一直无人消费。
  // 实测影响 4 个 xray 壁纸（textures[2]=null）：sprite 落白纹理后开窗形状完全消失、
  // 画面对鼠标零响应。这个缺口对所有带 "default":"贴图名" 的 sampler 槽通用，不止 xray。
  function parseSamplerDefaults(src) {
    const out = new Map()
    const re = /uniform\s+sampler2D\s+g_Texture(\d+)\s*;\s*\/\/([^\n]*)/g
    let m
    while ((m = re.exec(src)) !== null) {
      const slot = Number(m[1])
      const def = /"default"\s*:\s*"([^"]+)"/.exec(m[2])
      // 只取贴图路径形态的 default（util/white 之类也算，渲染器已有该内置纹理）
      if (def && def[1]) out.set(slot, def[1])
    }
    return out
  }
  // 纹理关联 combo：sampler uniform 注释声明 combo，且该槽提供了纹理 → combo = 1（ShaderUnit.cpp:545-617）
  function parseTextureCombos(src) {
    const out = []
    const re = /uniform\s+sampler2D\s+(g_Texture(\d+))[^;]*;\s*\/\/([^\n]*)/g
    let m
    while ((m = re.exec(src)) !== null) {
      const combo = /"combo"\s*:\s*"([^"]+)"/.exec(m[3])
      if (combo) out.push({ slot: Number(m[2]), name: m[1], combo: combo[1] })
    }
    return out
  }
  function parseDefaultValue(s) {
    if (s.startsWith('"')) return s.slice(1, -1)
    const n = Number(s)
    return Number.isFinite(n) ? n : undefined
  }
  async function getEffectProgram(shaderName, combos, providedTextures) {
    // shader 源与纹理 combo 按名缓存：避免每帧每 pass 重新 fetch/正则
    let src = shaderSrcCache.get(shaderName)
    if (src === undefined) {
      const fragSrc = (await shaderResolver('shaders/' + shaderName + '.frag')) || ''
      const vertSrc = (await shaderResolver('shaders/' + shaderName + '.vert')) || ''
      src = { frag: fragSrc, vert: vertSrc, texCombos: parseTextureCombos(fragSrc) }
      shaderSrcCache.set(shaderName, src)
    }
    // 纹理关联 combo 并入 combos（有显式值则不覆盖）
    const effectiveCombos = { ...combos }
    for (const tc of src.texCombos) {
      if (providedTextures && providedTextures[tc.slot] && effectiveCombos[tc.combo] === undefined) {
        effectiveCombos[tc.combo] = 1
      }
    }
    const key = shaderName + '|' + JSON.stringify(effectiveCombos)
    if (progCache.has(key)) {
      const hit = progCache.get(key)
      // null = 编译失败哨兵：避免每帧每层重试同一坏 shader（2902406982 的
      // clipping_mask 编不过时曾把 FPS 打到个位数并刷爆 console）。
      if (hit === null) throw new Error('shader=' + shaderName + ' 编译失败（已缓存）')
      return hit
    }
    // include 同步缓存：miss 时记录并补拉，重试转译
    for (let attempt = 0; attempt < 4; attempt++) {
      const missing = new Set()
      const resolver = (file) => {
        if (includeCache.has(file)) return includeCache.get(file)
        missing.add(file)
        return null
      }
      // [we-scene patch] 互传配对 stage 的源码：WE 常只在一个 stage 声明 [COMBO]
      // 而另一个 stage 直接 #if 它（godrays_gaussian / shine_gaussian 的 KERNEL
      // 只声明在 .vert）。不互传时两侧默认值不同 → varying 数组长度不一致 → 链接失败。
      const fragGlsl = rewriteXrayFragScale(hlsl2glsl(src.frag, 'frag', effectiveCombos, resolver, src.vert))
      const vertGlsl = hlsl2glsl(src.vert, 'vert', effectiveCombos, resolver, src.frag)
      if (missing.size === 0) {
        let prog
        try {
          prog = linkProgram(gl, vertGlsl, fragGlsl)
        } catch (e) {
          progCache.set(key, null)
          throw new Error('shader=' + shaderName + ' ' + (e && e.message))
        }
        const uni = new Map()
        const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS)
        for (let i = 0; i < n; i++) {
          const info = gl.getActiveUniform(prog, i)
          const base = info.name.replace(/\[0\]$/, '')
          // size > 1 = uniform 数组（如 float g_AudioSpectrum16Left[16]）；数组元素
          // 连续排布，用首元素 location + uniform1fv 一次设完
          uni.set(base, { loc: gl.getUniformLocation(prog, info.name), type: GL_TYPES[info.type] || 'unknown', size: info.size })
        }
        const matMeta = { ...parseMaterialMeta(src.vert), ...parseMaterialMeta(src.frag) }
        // [we-scene patch] 效果 vert 有两种顶点约定（全库并存）：
        //   A. `mul(vec4(a_Position,1), g_ModelViewProjectionMatrix)` —— 像素空间
        //      quad(0..w) + 转置像素正交 MVP（skew 等顶点位移 shader，3470764447）。
        //   B. `gl_Position = vec4(a_Position, 1.0)` 直通不乘 MVP（D3D pretransformed
        //      风格；motionblur_accumulation 等）—— 顶点必须是 NDC±1，像素 quad 会
        //      整块裁掉、历史缓冲断链 → 白块（1444077782 回归）。
        // 编译期扫 vert 源判定，渲染期按标志选 quad/MVP。
        const ndcDirect = /gl_Position\s*=\s*vec4\s*\(\s*a_Position/.test(src.vert) &&
          !/[aA]_Position[\s\S]{0,40}mul\s*\(/.test(src.vert)
        // sampler 槽的默认贴图名（scene.json 该槽为 null 时回退用）
        const samplerDefaults = new Map([...parseSamplerDefaults(src.vert), ...parseSamplerDefaults(src.frag)])
        const entry = { prog, uni, matMeta, samplerDefaults, fragGlsl, vertGlsl, ndcDirect }
        progCache.set(key, entry)
        return entry
      }
      await Promise.all(Array.from(missing).map(async (f) => {
        includeCache.set(f, (await shaderResolver('shaders/' + f)) || '')
      }))
    }
    throw new Error('include 解析失败: ' + shaderName)
  }

  const whiteTex = makeTexture(gl, new Uint8Array([255, 255, 255, 255]), 1, 1)
  // 无纹理的非 solid 层（纯效果层/文字对象层）：WE 语义为空层内容透明（白会导致纯白方块）
  const transparentTex = makeTexture(gl, new Uint8Array([0, 0, 0, 0]), 1, 1)

  // ---- 视差（cameraparallax + 对象 parallaxDepth）----
  // [we-scene patch] 指针不再由本文件自挂监听器，改由宿主注入的统一指针源提供
  // （render/pointer.js）。改动前这里 window.addEventListener('mousemove') 挂了
  // **永不移除**，每次重挂载（切壁纸/改属性）泄漏一个；且与 main.ts 的粒子监听器
  // 各用一套归一化约定（[-1,1] vs [0,1]），指针语义分裂在两处。
  // provider 是**函数**（宿主闭包），必须调用它取状态 —— 直接当对象读字段全是
  // undefined（与 setAudioProvider 同一个坑，见 bindSystemUniforms 注释）。
  let pointerProvider = null
  function setPointerProvider(fn) {
    pointerProvider = fn || null
  }
  function readPointer() {
    if (!pointerProvider) return null
    const p = typeof pointerProvider === 'function' ? pointerProvider() : pointerProvider
    return p && p.state ? p.state : p
  }
  // 视差平滑状态。x/y 是归一化到 [-1,1] 的指针（视差要的是「相对屏幕中心的偏移」，
  // 故由指针源的 [0,1] 现算，不再单独维护一份事件状态）。
  const parallaxState = { x: 0, y: 0, sx: 0, sy: 0 }
  let lastParallaxTime = 0
  // 层视差缩放（每帧由 renderScene 更新）
  let layerParallaxScaleX = 0
  let layerParallaxScaleY = 0
  // [we-scene patch] g_Frametime 用的帧间隔（秒）。每帧 renderScene 开头由场景时间
  // 差分得出，首帧退化为 1/60（不能给 0：cursorripple 的 timeAmt = dt/0.02 会归零）。
  let lastFrametime = 1 / 60
  let lastFrameTimeStamp = -1
  // [we-scene patch] camerafade 开场淡入时长（秒）。scene.json 无此参数，WE 用固定
  // 内置时长；1.0 是观感近似值，可由宿主覆盖。见 renderScene 末尾的幕布实现。
  const fadeDuration = typeof opts.fadeDuration === 'number' && opts.fadeDuration >= 0 ? opts.fadeDuration : 1.0
  const boolProp = (v, dflt) => {
    const raw = v !== null && typeof v === 'object' ? v.value : v
    if (raw === true || raw === 1) return true
    if (raw === false || raw === 0) return false
    return dflt
  }
  const numProp2 = (v, dflt) => {
    const raw = v !== null && typeof v === 'object' ? v.value : v
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : dflt
  }
  // camerafade 默认**关**：只有 127/128 个场景显式写了 true，缺字段的那个不该淡入。
  const fadeEnabled = (general) => opts.fade !== false && boolProp(general.camerafade, false)
  // [we-scene patch] camerashake：相机持续抖动（全库 5 个场景开启）。
  // 三个参数齐全（amplitude / roughness / speed），无需猜测：
  //   2800248288 amp=0.35 rough=0   speed=1
  //   3789602510 amp=0.5  rough=1   speed=0.81
  //   3790769971 amp=0.2  rough=0   speed=0.9
  // 用两条不同频率的正弦叠加取代真随机：抖动必须**逐帧连续**，用 Math.random()
  // 会得到每帧跳变的抽帧感；roughness 控制高频分量的权重（0=纯低频平滑摆动）。
  // 幅度按可见画面的百分比换算（amp=1 → ±2% 视宽），这个比例是观感近似、无数据出处。
  function cameraShakeOffset(general, time) {
    if (!boolProp(general.camerashake, false)) return null
    const amp = numProp2(general.camerashakeamplitude, 0)
    if (amp === 0) return null
    const rough = Math.max(0, Math.min(1, numProp2(general.camerashakeroughness, 0)))
    const speed = numProp2(general.camerashakespeed, 1)
    const t = time * speed
    const lowX = Math.sin(t * 2.1) * Math.cos(t * 0.7)
    const lowY = Math.cos(t * 1.7) * Math.sin(t * 0.9)
    const hiX = Math.sin(t * 11.3) * Math.cos(t * 7.1)
    const hiY = Math.cos(t * 9.7) * Math.sin(t * 13.1)
    return {
      x: (lowX * (1 - rough) + hiX * rough) * amp,
      y: (lowY * (1 - rough) + hiY * rough) * amp,
    }
  }
  // [we-scene patch] g_Daytime：WE 语义是「一天中的时刻」，取 [0,1)（0=午夜）。
  // 全库 14 处脚本读 engine.timeOfDay，shader 侧的 g_Daytime 同源。
  // 改动前硬编码 0（恒为午夜），依赖它做昼夜变化的场景永远停在夜里。
  function daytimeFraction() {
    const d = new Date()
    return (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) / 86400
  }

  // ---------- uniform 设置 ----------
  function setVal(uni, name, setter) {
    const u = uni.get(name)
    if (u && u.loc !== null) setter(u.loc, u.type, u.size)
  }
  function parseVecValue(v) {
    if (typeof v === 'number') return [v, v, v, v]
    // WE 默认值和工坊效果常用 `"0.0, 1.0"`（逗号）；只按空白切会把 `"0.05,"` 读成 NaN。
    const p = String(v).trim().split(/[\s,]+/).map(Number)
    return [p[0] || 0, p[1] || 0, p[2] || 0, p[3] || 0]
  }
  function setConstant(uni, name, value) {
    const u = uni.get(name)
    if (!u || u.loc === null) return
    const raw = value && value.value !== undefined ? value.value : value
    const arr = parseVecValue(raw)
    switch (u.type) {
      case 'float': gl.uniform1f(u.loc, arr[0]); break
      case 'int':
      case 'bool': gl.uniform1i(u.loc, raw === true || raw === 1 ? 1 : Math.round(arr[0])); break
      case 'vec2': gl.uniform2f(u.loc, arr[0], arr[1]); break
      case 'vec3': gl.uniform3f(u.loc, arr[0], arr[1], arr[2]); break
      case 'vec4': gl.uniform4f(u.loc, arr[0], arr[1], arr[2], arr[3]); break
      case 'mat4': gl.uniformMatrix4fv(u.loc, false, IDENT_M4); break
      case 'mat3': gl.uniformMatrix3fv(u.loc, false, IDENT_M3); break
      default: break
    }
  }
  const mat3Identity = () => new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1])

  // [we-scene patch] 「层局部像素、原点在层中心」的正交投影，供指针反投影用。
  // 见 g_ModelViewProjectionMatrixInverse 的绑定注释：只有反投影到这个空间，
  // xray 的开窗中心才落在指针处。按尺寸缓存，避免每帧每 pass 新建矩阵。
  function bindSystemUniforms(uni, layer, time, projW, projH, mvp, modelM, viewProjM, resolutions, passProj, cam) {
    setVal(uni, 'g_Time', (l) => gl.uniform1f(l, time))
    setVal(uni, 'g_Daytime', (l) => gl.uniform1f(l, daytimeFraction()))
    setVal(uni, 'g_ModelViewProjectionMatrix', (l) => gl.uniformMatrix4fv(l, false, mvp))
    setVal(uni, 'g_ModelMatrix', (l) => gl.uniformMatrix4fv(l, false, modelM))
    setVal(uni, 'g_ViewProjectionMatrix', (l) => gl.uniformMatrix4fv(l, false, viewProjM))
    // [we-scene patch] g_ModelViewProjectionMatrixInverse 曾硬编码为单位矩阵。
    // 这挡死了 xray（6 个壁纸）：它的 .vert 用**这个**矩阵（而非 Effect 版）
    // 把指针反投影成 sprite 的采样中心。两个必须同时满足的条件：
    //
    // 1. **传「转置后的逆」，不能直接传逆。** WE 的 shader 是 HLSL 行向量语义
    //    （`mul(向量, 矩阵)`），hlsl2glsl 统一改写成 `transpose(M) * 向量`，
    //    于是 shader 里算的是 transpose(我们传进去的矩阵)。直接传逆矩阵时那个
    //    transpose 会把平移项搬错位置 —— 实测 4096×2048 的层上，指针 (0.2,0.2)
    //    反投影出的齐次 w 从 1 变成 **-613**，而 frag 紧接着做
    //    `v_PointerUV.xy / v_PointerUV.z`（z 存的就是 .xyw 的 w），
    //    偏移被大 w 压成近零 → 开窗死死钉在画面中心不动。
    //
    // 2. **反投影的目标空间随 shader 版本变化，必须分两支。**
    //    xray.vert 在全库有**两个版本**，差别就在这个矩阵之后的归一化步骤：
    //
    //      新版（5/6 个壁纸，用 g_EffectTextureProjectionMatrixInverse）：
    //        v_PointerUV.xyz = mul(vec4(pointer*2-1, 0, 1), Minv).xyw;
    //        v_PointerUV.xy *= 0.5;                     ← 乘 0.5
    //
    //      旧版（仅 1994794519，用 g_ModelViewProjectionMatrixInverse）：
    //        v_PointerUV.xyz = mul(vec4(pointer*2-1, 0, 1), Minv).xyw;
    //        v_PointerUV.xy *= 1.0 / g_Texture0Resolution.xy;   ← 除以贴图像素分辨率
    //
    //    frag 两版一致，都要求 P = v_PointerUV.xy / z 落在 **[-0.5, 0.5]**：
    //      d  = saturate(texSource - P)      texSource 是当前像素 UV ∈[0,1]
    //      uv = (d - 0.5) * v_PointerScale * … + 0.5
    //    halo 中心在 uv=0.5，故需 d=0.5，即 texSource = P + 0.5。
    //
    //    于是：新版 `pointer*2-1 ∈[-1,1]` 乘 0.5 恰好得 [-0.5,0.5] → **传单位矩阵**；
    //    旧版还要再除以 texRes，故矩阵得先把量放大 texRes/2 抵消回来
    //    → **传 transpose(scale(texW/2, texH/2))**。
    //
    //    两处曾都错传 `ortho(-W/2, W/2, …)` 的逆（W/H 取相机 projW/projH），
    //    那是**像素**空间：算出的 P 达 ±512/±256，紧随其后的
    //    `saturate(texSource - P)` 把整屏一律夹成 0 或 1，于是除正中心
    //    （P 恰为 0）外**权重恒为 0** —— 症状正是用户实测的「开窗只在正中心
    //    有、鼠标移到别处完全没反应」。离线复算：指针 u=0.25/0.75 时全行权重
    //    峰值 0.000，仅 u=0.5 有 0.733；改对后三个位置峰值均 0.733，
    //    峰值位置分别落在 texU=0.24/0.49/0.74，与指针一一对应。
    if (uni.get('g_ModelViewProjectionMatrixInverse')) {
      // 旧版要抵消 `*= 1/g_Texture0Resolution.xy`：取 Texture0 的像素尺寸。
      // resolutions 是 [slot, [w, h, texW, texH]]，slot 0 就是层内容贴图。
      let t0 = null
      for (const [i, res] of resolutions) if (i === 0) t0 = res
      const mvpInv = t0 && t0[0] > 0 && t0[1] > 0
        ? mat4Transpose(mat4Scale(mat4Identity(), t0[0] / 2, t0[1] / 2, 1))
        : IDENT_M4
      setVal(uni, 'g_ModelViewProjectionMatrixInverse', (l) => gl.uniformMatrix4fv(l, false, mvpInv))
    }
    setVal(uni, 'g_Brightness', (l) => gl.uniform1f(l, layer.brightness))
    setVal(uni, 'g_UserAlpha', (l) => gl.uniform1f(l, layer.alpha))
    setVal(uni, 'g_Alpha', (l) => gl.uniform1f(l, layer.alpha))
    setVal(uni, 'g_Color', (l) => gl.uniform3f(l, layer.color[0], layer.color[1], layer.color[2]))
    setVal(uni, 'g_Color4', (l) => gl.uniform4f(l, layer.color[0], layer.color[1], layer.color[2], 1))
    setVal(uni, 'g_CompositeColor', (l) => gl.uniform3f(l, layer.color[0], layer.color[1], layer.color[2]))
    setVal(uni, 'g_TexelSize', (l) => gl.uniform2f(l, 1 / projW, 1 / projH))
    setVal(uni, 'g_TexelSizeHalf', (l) => gl.uniform2f(l, 0.5 / projW, 0.5 / projH))
    setVal(uni, 'g_TextureReductionScale', (l) => gl.uniform1f(l, 1))
    // [we-scene patch] 指针 uniform（WE 保留名）。改动前这几个全是硬编码 0 /
    // 完全未绑定，导致全库 28 个壁纸的指针效果一律「编过了但毫无反应」。
    //
    // g_PointerPosition 的空间是**归一化 [0,1]、Y 朝下**（原始屏幕空间）：
    // 依据是 cursorripple_apply_force.vert / iris_follow_cursor.vert 等都显式写
    // `pointer.y = 1.0 - pointer.y; // Flip pointer screen space Y to match
    // texture space Y` —— shader 自己负责翻 Y，我们**不要**替它翻。
    //
    // g_PointerPositionLast 取「上一帧」而非「上一个事件」，见 render/pointer.js
    // 的 beginFrame 说明（否则 length(cur-last) 恒 ≈0，水波不起波）。
    const p = readPointer()
    const parkXray = xrayShouldParkPointer(!!(p && p.has), !!uni.get('g_PointerScale'))
    // 初始加载：xray 开窗若用默认 (0.5,0.5)，会在壁纸圆心挖一个洞。停到屏幕
    // 归一化 (-1,-1) 再换算到层 UV，即一整屏在相机左上外。iris/ripple 不走这支。
    let pu = parkXray ? XRAY_IDLE_SCREEN_UV : (p ? p.u : 0.5)
    let pv = parkXray ? XRAY_IDLE_SCREEN_UV : (p ? p.v : 0.5)
    let plu = parkXray ? XRAY_IDLE_SCREEN_UV : (p ? p.lastU : 0.5)
    let plv = parkXray ? XRAY_IDLE_SCREEN_UV : (p ? p.lastV : 0.5)
    // [we-scene patch] g_PointerPosition 要换算到**当前层的 UV 空间**，不能直接喂屏幕归一化值。
    //
    // xray.frag 拿 `d = texSource - P` 求开窗中心，texSource 是当前像素的**层 UV**
    // ∈[0,1]。所以 P 也必须是层 UV。层铺满屏幕（层宽高比 == 画布宽高比）时两者恰好
    // 相等，此前一直没暴露；一旦层与画布宽高比不同，fit=cover 会把层的一部分裁到
    // 屏幕外，屏幕 v 与层 v 就差一个「裁掉的边距 + 缩放」。
    //
    // 2854083091 层 4000×2667（3:2），画布 1280×720（16:9）：层铺屏后是 1280×853，
    // 上下各裁 67px。于是开窗中心在纵向按 (853/720) 倍率发散并偏移 —— 指针在画面
    // 顶端时开窗偏上 56px、底端时偏下 56px，正中间才恰好对上。用户描述的
    //「开窗没有以鼠标为中心跟随」就是这个：横向准、纵向越往边缘越偏。
    //
    // cam.offX/offY/viewW/viewH 就是「屏幕窗口在场景坐标里的范围」（fitWindow 的产物），
    // 用它把屏幕归一化 → 场景像素 → 层 UV。层与画布同宽高比时该式退化为恒等，
    // 所以对其余壁纸零影响。
    if (cam && layer && layer.size && layer.size[0] > 0 && layer.size[1] > 0) {
      const lw = Math.abs(layer.size[0] * layer.scale[0])
      const lh = Math.abs(layer.size[1] * layer.scale[1])
      if (lw > 0 && lh > 0) {
        // 层矩形在场景坐标里的左上角（世界 y 向下，与 layerModelMatrix 同空间）
        const lx = layer.origin[0] - lw / 2
        const ly = (cam.projH - layer.origin[1]) - lh / 2
        const toLayerU = (u) => (cam.offX + u * cam.viewW - lx) / lw
        const toLayerV = (v) => (cam.offY + v * cam.viewH - ly) / lh
        pu = toLayerU(pu); pv = toLayerV(pv)
        plu = toLayerU(plu); plv = toLayerV(plv)
      }
    }
    setVal(uni, 'g_PointerPosition', (l) => gl.uniform2f(l, pu, pv))
    setVal(uni, 'g_PointerPositionLast', (l) => gl.uniform2f(l, plu, plv))
    // g_PointerState：只有 cursorripple_apply_force.frag 用，且只读 `.z`
    // （`pointerMoveAmt + g_PointerState.z * 5.0`，即点击时额外注入一次冲量）。
    // 按 WE 语义 xy 放位置、z 放按键状态。
    setVal(uni, 'g_PointerState', (l) => gl.uniform4f(l, pu, pv, p && p.leftDown ? 1 : 0, 0))
    // g_ParallaxPosition：3088030303/shadow.vert 用 `g_PointerPosition -
    // g_ParallaxPosition` 求「指针相对平滑视差位置的偏移」，故喂**平滑后**的指针。
    // parallaxState.sx/sy 是 [-1,1] 空间的平滑值，换回 [0,1] 与 g_PointerPosition 同空间。
    setVal(uni, 'g_ParallaxPosition', (l) => gl.uniform2f(l, parallaxState.sx * 0.5 + 0.5, parallaxState.sy * 0.5 + 0.5))
    // g_Frametime：cursorripple_apply_force.frag 的 `timeAmt = g_Frametime / 0.02`
    // 是冲量的时间归一因子。不绑定则恒为 0 → 注入零力，水波**完全不动**且无报错。
    setVal(uni, 'g_Frametime', (l) => gl.uniform1f(l, lastFrametime))
    // g_EffectTextureProjectionMatrixInverse：把归一化指针反投影回图层局部 UV。
    // 效果 pass 的投影就是 passProj（layerOrtho，见调用点），取其逆即可；
    // 图层 pass 没有这个概念时退回单位矩阵（等价于「层铺满且轴对齐」的近似）。
    if (uni.get('g_EffectTextureProjectionMatrixInverse')) {
      // 与 g_ModelViewProjectionMatrixInverse 同一套推导（见上方长注释）：
      // 目标空间是**归一化**纹理偏移 ∈[-0.5,0.5]，不是层像素。
      // 6 个 xray 壁纸里 5 个用的是**这个** uniform（只有 1994794519 用 MVP 版），
      // 所以这里传错等于 5/6 的 xray 全哑 —— 必须与上面保持一致。
      setVal(uni, 'g_EffectTextureProjectionMatrixInverse', (l) => gl.uniformMatrix4fv(l, false, IDENT_M4))
    }
    for (let i = 0; i < 8; i++) {
      setVal(uni, 'g_Texture' + i, (l) => gl.uniform1i(l, i))
    }
    for (const [i, res] of resolutions) {
      setVal(uni, 'g_Texture' + i + 'Resolution', (l) => gl.uniform4f(l, res[0], res[1], res[2], res[3]))
    }
    // [we-scene patch] 音频频谱（WE 保留 uniform，见 render/audio.js 顶部说明）：
    // 程序声明了哪个分辨率就喂哪组，未声明的数组 inactive、不在 uni 表里自动跳过。
    // provider 是函数（宿主闭包），必须**调用**它拿快照——直接当对象读字段永远是
    // undefined，频谱一条都喂不进去（波形/音频条表现为恒零）。
    if (audioSnapshot) {
      const snap = typeof audioSnapshot === 'function' ? audioSnapshot() : audioSnapshot
      if (snap) {
        for (const [name, key] of AUDIO_SPECTRUM_UNIFORMS) {
          const arr = snap[key]
          if (arr) setVal(uni, name, (l) => gl.uniform1fv(l, arr))
        }
      }
    }
  }

  // constantshadervalues 的键是 material 名 → 经 matMeta 映射到 uniform 名并设值；缺省用注释 default
  function bindConstants(uni, constants, matMeta) {
    for (const [matKey, value] of Object.entries(constants || {})) {
      const entry = matMeta && matMeta[matKey]
      if (!entry) continue
      setConstant(uni, entry.uniform, value)
    }
    // 未提供的常数用 shader 注释里的 default。
    // xray 的 size 例外走 constantFallback（注释 0.2 是编辑器初值不是运行时缺省）。
    for (const [matKey, entry] of Object.entries(matMeta || {})) {
      if (!constants || !(matKey in constants)) {
        const dflt = constantFallback(entry.uniform, entry.default)
        if (dflt !== undefined) setConstant(uni, entry.uniform, dflt)
      }
    }
  }

  // 未收到鼠标时 xray 开窗已停在相机外；size>1 时 saturate 会把屏外开窗的边沿
  // 染成整屏亮斑，必须把 g_PointerScale 打到 0（frag mix → 999，开窗缩成看不见
  // 的点）。必须在 bindConstants **之后**调用，否则用户的 xraysize 会把 0 盖掉。
  function parkXrayUntilPointer(uni) {
    const p = readPointer()
    if (!xrayShouldParkPointer(!!(p && p.has), !!uni.get('g_PointerScale'))) return
    setVal(uni, 'g_PointerScale', (l) => gl.uniform1f(l, 0))
  }

  // ---- 效果常量脚本（constantshadervalues 里的 {script, value}）----
  // [we-scene patch] 这类脚本此前**完全没有实现**：setConstant 只读 `.value`，
  // 即那份写死在 scene.json 里的初始快照。全库 194 个效果常量带 script，
  // 其中 63 个是颜色 —— WE 官方「颜色循环」模板正是靠
  // `update(value){ return WEColor.hsv2rgb({x: engine.runtime * speed, …}) }`
  // 逐帧改写颜色。不跑脚本 ⇒ 颜色永远是初值 ⇒ 表现为**整块固定色**，
  // 而作者要的是随时间/音频动态变化的色彩。
  //
  // 复用 text.js 的 evalObjectScript（同族语义：update(value) 返回新值，
  // vec3 字段传可变 {x,y,z}），沙箱、熔断、scriptProperties 全部沿用。
  // [we-scene patch] 常量脚本的反馈链只收与字段形状一致的值：标量键要有限数字、
  // 向量键要带有限 x/y 的对象（Vec2 允许、z 可缺）。脏值保留上一态 ——
  // 把 NaN 喂回下一帧会让输出永久 NaN。
  function constShapeOk(val, isScalar) {
    if (isScalar) return typeof val === 'number' && Number.isFinite(val)
    return !!val && typeof val === 'object' && Number.isFinite(Number(val.x)) && Number.isFinite(Number(val.y))
  }

  function scriptedConstants(constants, cacheKey, time, layer) {
    if (!constants) return constants
    let hasScript = false
    for (const v of Object.values(constants)) {
      if (v !== null && typeof v === 'object' && typeof v.script === 'string') { hasScript = true; break }
    }
    if (!hasScript) return constants
    if (!evalObjectScriptFn) return constants
    const out = { ...constants }
    for (const [key, v] of Object.entries(constants)) {
      if (v === null || typeof v !== 'object' || typeof v.script !== 'string') continue
      const sk = cacheKey + '|' + key
      let sb = constScriptCache.get(sk)
      if (sb === undefined) {
        constScriptDiag.total++
        try {
          sb = evalObjectScriptFn(v.script, v.scriptproperties || v.scriptProperties || null, {
            userProperties: userProps || {},
            audioViews: scriptAudioViews || undefined,
            // [we-scene patch] 必须传 layer：媒体回调里 `thisObject.visible = e.hasThumbnail`
            // 与 `thisObject.getAnimation().play()` 都要写回真图层。此前没传，
            // thisObject 是个哑层代理，这 101 处脚本的写入全进了空气。
            layer: layer || null,
            // [we-scene patch] 与文字/对象脚本共用同一份 shared。3396722575 的
            // geometric_transform.Strength 写 `value = shared.textz1`，由隐藏层
            // object 86 每帧写入；不注入则读到 undefined，退回快照 0.5，圆环不呼吸。
            shared: scriptShared || {},
            // 3791967416 聚光灯 delayedPointer 读 input.cursorScreenPosition。
            // 常量沙箱此前不传 inputView，光标恒为 0，灯钉在左上角。
            inputView: scriptInputView || undefined,
            // [we-scene patch] 延时逻辑（全库常量挂点 8 处）。此前拿 no-op stub，
            // 定时回调从不触发。
            setTimeout: scriptTimers ? scriptTimers.setTimeout : undefined,
            clearTimeout: scriptTimers ? scriptTimers.clearTimeout : undefined,
            setInterval: scriptTimers ? scriptTimers.setInterval : undefined,
            clearInterval: scriptTimers ? scriptTimers.clearInterval : undefined,
            // [we-scene patch] 官方语义：无参 getAnimation() = **本常量自己的**
            // 动画（constAnimCache 里那份）。此前 thisObject 是图层代理，拿到的是
            // 同层对象字段动画或中性对象 —— 3163060610 的 21 个常量 leader 全部
            // 够不到（CAniClass 包错对象，折叠/展开交互不可能工作）。
            getAnimationForProperty: () => {
              const rec = constAnimCache.get(cacheKey + '|anim|' + key)
              return rec ? rec.ctrl : null
            },
          })
        } catch { sb = null }
        if (sb) constScriptDiag.ok++
        else constScriptDiag.failed++
        constScriptCache.set(sk, sb)
        // [we-scene patch] WE 语义：init(value) 收到字段的**当前值**——向量字段是
        // 带分量属性的对象、标量字段是数值。此前无参调用，`init(value){ initialValue
        // = value.x }` 形态的音频缩放脚本（3264246690 的月亮/胶带，全库音频可视化
        // 模板的标准写法）会在 init 里 TypeError 熔断，动态缩放整体失效。
        if (sb) {
          const rawVal = v.value !== undefined ? v.value : v
          const base0 = parseVecValue(rawVal)
          const scalar = typeof rawVal === 'number'
          const initArg = scalar ? base0[0] : { x: base0[0], y: base0[1], z: base0[2] }
          // [we-scene patch] init 返回值 = 常量新初值（WE 语义），同时是逐帧
          // 反馈的起点：淡出脚本静音加载时 `return 0`，应从 0 开始而不是快照 1。
          const ir = sb.init(initArg)
          sb.__lastConstValue = constShapeOk(ir, scalar) ? ir : initArg
        }
        // [we-scene patch] WE 语义：applyUserProperties 在**加载时也要调一次**（初值
        // 应用），之后才在属性变化时再调。纯属性驱动的常量脚本（2847470774 的
        // `applyUserProperties(changed){ thisObject.color = shared.accentColor }`，
        // 没有 update）此前创建后从没收到过属性 —— 脚本色永远不生效。
        // 与 main.ts 效果可见性脚本的既有 init()+applyUserProperties() 序列一致。
        if (sb && typeof sb.applyUserProperties === 'function') {
          try { sb.applyUserProperties(userProps || {}) } catch { /* 初值应用失败不拖垮渲染 */ }
        }
        // 带媒体钩子或 animationEvent 钩子的新沙箱反向登记给宿主（惰性创建，宿主扫不到）。
        // animationEvent 登记要带上图层与常量名：官方语义是**图层级广播**，
        // 宿主要按图层找到这层全部带钩子的沙箱。
        if (sb && (sb.hasMediaHook || sb.hasAnimEventHook) && constScriptSink) {
          try { constScriptSink(sb, { layer, key }) } catch { /* 登记失败不该拖垮渲染 */ }
        }
      }
      // 没有 update 的沙箱不参与逐帧求值，但**不能在这里丢弃**——
      // 纯媒体回调脚本正是这种形态，它靠上面的 sink 登记后由宿主派发。
      if (!sb || sb.disabled || !sb.hasUpdate) continue
      // engine.runtime 必须逐帧推进：颜色循环脚本整个动画都由它驱动，
      // 停在 0 等于永远输出同一个色（与「不跑脚本」的症状完全一样）。
      //
      // [we-scene patch] engine.timeOfDay 同样必须每帧刷新，而且**漏了它会直接毁画面**：
      // 2134765860 的「夜灯」用 blend 效果把 `day lo` 叠在背景上，叠加强度 g_Multiply
      // 挂了个昼夜脚本 —— smoothStep 组合出「7 点前与 18 点后为 1，白天为 0」的门。
      // timeOfDay 恒为沙箱默认的 0（= 午夜）时该门恒为 1，于是夜灯贴图**全天满强度**
      // 叠加；配合 BLENDMODE=0（Normal，mix 语义）直接把墙面 mix 成一大块纯白。
      // 全库 14 处脚本读 engine.timeOfDay，与 shader 侧 g_Daytime 同源，统一用
      // daytimeFraction() 供给。
      if (sb.engine) {
        sb.engine.runtime = time
        sb.engine.frametime = lastFrametime
        sb.engine.timeOfDay = daytimeFraction()
        // 聚光灯脚本用 screenResolution 把 cursorScreenPosition 归一化到 [0,1]。
        const ptr = readPointer()
        if (ptr && ptr.screenW && ptr.screenH) {
          sb.engine.screenResolution = { x: ptr.screenW, y: ptr.screenH }
        }
      }
      const isScalar = typeof (v.value !== undefined ? v.value : v) === 'number'
      // [we-scene patch] WE 语义：update(value) 收到的是属性**当前值** = 脚本
      // 上一帧的返回值（首轮是 init 返回值）。此前每帧都用 scene.json 快照重建
      // 入参，`value = WEMath.mix(value, 0, engine.frametime / fadeOutDur)` 这类
      // 递推每帧都被拉回快照 —— 淡出在数学上不可能完成（3233141951 中音条
      // alpha 恒 ≈0.97）。对象入参保持同一身份（分量原地更新），init 里捕获
      // 引用的写法（3264246690 音频缩放模板）不受影响。
      if (!constShapeOk(sb.__lastConstValue, isScalar)) {
        const base = parseVecValue(v.value !== undefined ? v.value : v)
        sb.__lastConstValue = isScalar ? base[0] : { x: base[0], y: base[1], z: base[2] }
      }
      const arg = sb.__lastConstValue
      let ret
      try { ret = sb.callUpdate(arg) } catch { ret = undefined }
      // WE 语义：脚本可以「原地改写传入对象」或「返回新值」，两种都要支持。
      const src = ret !== undefined && ret !== null ? ret : arg
      // 本帧输出回流为下帧输入（形状合法才收，防 NaN 入反馈环）。
      if (constShapeOk(src, isScalar)) sb.__lastConstValue = src
      if (typeof src === 'number' && Number.isFinite(src)) out[key] = src
      else if (src && typeof src === 'object') {
        const x = Number(src.x), y = Number(src.y)
        const z = Number(src.z)
        // Vec2 返回只有 x/y；缺 z 当 0，不能整段丢掉（3791967416 delayedPointer）。
        if (Number.isFinite(x) && Number.isFinite(y)) {
          out[key] = Number.isFinite(z) ? `${x} ${y} ${z}` : `${x} ${y} 0`
        }
      }
    }
    return out
  }

  // ---- 效果常量关键帧（constantshadervalues 里的 {animation, value}）----
  // [we-scene patch] 与对象字段动画同一套 createAnimation。此前只跑 {script}，
  // 带 animation 的常量永远停在 scene.json 快照。3233141951「剑音条01」opacity
  // 快照是 0、真正淡入在第 18 帧；不采样这条轨 ⇒ 武士刀音频条永远透明。
  // 全库 55 处效果常量动画（verify-animation 按 animation 键遍历已覆盖求值核）。
  function animatedConstants(constants, cacheKey, time, layer) {
    if (!constants) return constants
    let hasAnim = false
    for (const v of Object.values(constants)) {
      if (v && typeof v === 'object' && v.animation && v.animation.options) { hasAnim = true; break }
    }
    if (!hasAnim) return constants
    const out = { ...constants }
    // [we-scene patch] 先建齐本映射内全部控制器，再按 key 接一次联动组
    //（children 不自播、播放头从属于 leader——3163060610 的折叠/展开全靠它，
    // 此前 children 加载即自播完）。
    const siblings = new Map()
    for (const [key, v] of Object.entries(constants)) {
      if (!v || typeof v !== 'object' || !v.animation || !v.animation.options) continue
      const sk = cacheKey + '|anim|' + key
      let rec = constAnimCache.get(sk)
      if (!rec) {
        const ctrl = createAnimation(v.animation)
        const raw = v.value !== undefined ? v.value : 0
        ctrl.baseNumeric = Array.isArray(raw) ? raw.slice() : raw
        rec = { ctrl, prevTime: time }
        constAnimCache.set(sk, rec)
      }
      siblings.set(key, rec.ctrl)
    }
    if (!constAnimLinkedCache.has(cacheKey)) {
      constAnimLinkedCache.add(cacheKey)
      linkAnimations(siblings, (msg) => diag(`${cacheKey}: ${msg}`))
    }
    for (const [key, v] of Object.entries(constants)) {
      if (!v || typeof v !== 'object' || !v.animation || !v.animation.options) continue
      const sk = cacheKey + '|anim|' + key
      const rec = constAnimCache.get(sk)
      // [we-scene patch] advance 语义取代场景时间钉：autoplay（rate=1）时两者
      // 等价，且层被裁/晚出现时 prevTime 追平照样补上一整段 intro；但脚本驱动
      //（play/rate/setFrame——3163060610 的 CAniClass 全这么干）时钉时间会每帧
      // 把播放头拉回场景时钟，脚本播放永远跑不起来。
      // startpaused 停帧 0（playing=false 不推进），与钉时间行为一致。
      const dt = time - rec.prevTime
      rec.prevTime = time
      if (rec.ctrl.playing) rec.ctrl.advance(Math.max(0, dt))
      // [we-scene patch] 帧事件入共享队列，宿主帧循环 render 后图层级广播
      //（事件在 render 内产生，当帧派发）。
      if (constAnimEventQueue) {
        const evs = rec.ctrl.takeEvents()
        if (evs.length) constAnimEventQueue.push({ layer, events: evs })
      } else {
        rec.ctrl.takeEvents() // 无队列也要清，防积压
      }
      out[key] = rec.ctrl.applyTo(rec.ctrl.baseNumeric)
    }
    return out
  }

  function resolveTextureName(name, inputFBO, effectFBOs, textures) {
    if (name === null || name === undefined || name === '') return null
    if (name.startsWith('_rt_')) {
      // [we-scene patch] `_rt_imageLayerComposite_<objectId>_a` 指的是**另一个对象**
      // 跑完自己效果链后的合成结果（WE 的「图层作为纹理」：作者把一层设成
      // visible:false 当纯素材，另一层引用它，常用于遮罩和封面）。带层号时必须
      // 查预渲染表，不能返回 inputFBO —— 那是**当前层自己**的效果链输入。
      //
      // 此前不看层号一律返回 inputFBO。2938612768 的背景层引用的是隐藏的
      // 「默认音频封面azb」，取到自己（空容器 = 全透明）后整屏只剩灰底，
      // 原版那张模糊铺屏的专辑封面完全不见。全库 92 处引用 / 22 个壁纸。
      //
      // 不带层号的裸 `_rt_imageLayerComposite` 仍指当前层，保持原样。
      if (name.startsWith('_rt_imageLayerComposite')) {
        if (!compositeEnabled) return inputFBO
        if (compositeFBOs.has(name)) return compositeFBOs.get(name)
        return inputFBO
      }
      if (effectFBOs.has(name)) return effectFBOs.get(name)
      return null
    }
    // [we-scene patch] 效果自定义 FBO **不一定带 `_rt_` 前缀**。
    // `_rt_` 是 WE 内置全屏缓冲的命名约定，但 effect.json 的 `fbos` 是作者自己起名的，
    // 工坊效果普遍用裸名：bloom 的 `blur_start_2`/`blur_end_2`…、bokeh_blur 的
    // `_downscaled1`/`_full1`/`_coc`、crt_screen 的 `render_target`。
    // 这些名字在 `target`/`source`/`bind` 三处都是直接查 effectFBOs 的，唯独这里
    // 因为前缀判断落到了 `textures.get(name)` —— 贴图表里当然没有，于是返回 null，
    // 调用方兜底成**白纹理**。
    //
    // 后果是多 pass 效果的链路从中间断掉：bloom 的 apply pass 槽 0 本该取模糊结果、
    // 槽 2 取原图，两个都变成纯白 ⇒ `ApplyBlending(31, white, white*tint, mask)`
    // 恒为白 ⇒ 尾灯/高光位置糊成纯白方块（3789462324 车尾灯，掩码形状就是白块轮廓）。
    // 全库 3 种效果 / 8 个壁纸：bloom(3)、bokeh_blur(2)、crt_screen(3)。
    //
    // 放在贴图表查找**之前**：FBO 名是效果私有的，同名贴图不该抢占。
    if (effectFBOs.has(name)) return effectFBOs.get(name)
    return textures.get(name) || null
  }

  // ---------- 绘制辅助 ----------
  // 静态 quad 单例 + 变更才上传：避免每帧每 pass 新建 Float32Array 与 bufferData
  const PASS_QUAD = passQuadVerts()
  const LOCAL_QUAD = localQuadVerts()
  const layerQuadCache = new Map()
  function layerQuad(w, h) {
    const key = w + 'x' + h
    let q = layerQuadCache.get(key)
    if (q === undefined) {
      q = layerQuadVerts(w, h)
      layerQuadCache.set(key, q)
    }
    return q
  }
  let currentQuadKey = null
  function uploadQuad(key, verts) {
    if (currentQuadKey === key) return
    gl.bindBuffer(gl.ARRAY_BUFFER, vbuf)
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW)
    currentQuadKey = key
  }

  // copy/composite 程序 uniform 位置缓存（每帧查找 → 一次初始化）
  const copyUni = {
    mvp: gl.getUniformLocation(copyProg, 'u_MVP'),
    tex: gl.getUniformLocation(copyProg, 'u_Tex'),
    color: gl.getUniformLocation(copyProg, 'u_Color4'),
    frameOrigin: gl.getUniformLocation(copyProg, 'u_FrameOrigin'),
    frameU: gl.getUniformLocation(copyProg, 'u_FrameU'),
    frameV: gl.getUniformLocation(copyProg, 'u_FrameV'),
    blendPrep: gl.getUniformLocation(copyProg, 'u_BlendPrep'),
  }
  const compUni = {
    mvp: gl.getUniformLocation(compProg, 'u_MVP'),
    tex: gl.getUniformLocation(compProg, 'u_Tex'),
    blendPrep: gl.getUniformLocation(compProg, 'u_BlendPrep'),
  }
  const backdropUni = {
    mvp: gl.getUniformLocation(backdropProg, 'u_MVP'),
    tex: gl.getUniformLocation(backdropProg, 'u_Tex'),
  }
  const compBlendUni = {
    mvp: gl.getUniformLocation(compBlendProg, 'u_MVP'),
    tex: gl.getUniformLocation(compBlendProg, 'u_Tex'),
    backdrop: gl.getUniformLocation(compBlendProg, 'u_Backdrop'),
    blendMode: gl.getUniformLocation(compBlendProg, 'u_BlendMode'),
    canvasSize: gl.getUniformLocation(compBlendProg, 'u_CanvasSize'),
    opacity: gl.getUniformLocation(compBlendProg, 'u_Opacity'),
  }
  const IDENT_M4 = mat4Identity()
  const IDENT_M3 = mat3Identity()
  function setBlend(mode) {
    if (mode === 'translucent') {
      gl.enable(gl.BLEND)
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    } else if (mode === 'additive') {
      gl.enable(gl.BLEND)
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.ONE, gl.ONE)
    } else {
      gl.disable(gl.BLEND)
    }
  }

  // 图层的 colorBlendMode（scene.json 的 colorBlendMode，语义同 common_blending.h 的
  // blend mode 编号）→ 合成到画布时的 GL 混合模式。
  // 只映射能用固定管线表达的几种；其余（Overlay/SoftLight 等需要读回目标色）
  // 退回 translucent，与此前行为一致。
  //
  // 这一步不做的后果：像 3299228616 的 ripple1440p 水面层，贴图是一张几乎全黑、
  // 靠 Add 混合只贡献亮部高光的图（colorBlendMode=9），若按 translucent 合成，
  // 黑色像素会被当成不透明色直接糊住背景，看起来就是"一层黑色蒙版盖住了壁纸"。
  // 混合模式与源色预处理的映射在模块级 colorBlendPlan（那里有完整推导与归属证据）。
  // 这里只负责把它翻译成 GL 调用，并把 prep 记下来供 compositeLayer 写进 u_BlendPrep。
  let blendPrep = 0
  function setColorBlend(colorBlendMode) {
    const { mode, prep } = colorBlendPlan(colorBlendMode)
    blendPrep = prep
    if (mode === 'additive') {
      gl.enable(gl.BLEND)
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.ONE, gl.ONE)
    } else if (mode === 'multiply') {
      gl.enable(gl.BLEND)
      gl.blendFuncSeparate(gl.DST_COLOR, gl.ZERO, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    } else if (mode === 'screen') {
      gl.enable(gl.BLEND)
      gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_COLOR, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    } else {
      setBlend('translucent')
    }
  }
  function drawQuad(prog, fbo, w, h, verts, mvp, blending) {
    gl.useProgram(prog)
    setBlend(blending)
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo ? fbo.fbo : null)
    gl.viewport(0, 0, w, h)
    gl.bindVertexArray(vao)
    uploadQuad('draw', verts)
    const loc = gl.getUniformLocation(prog, 'u_MVP')
    gl.uniformMatrix4fv(loc, false, mvp)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
  }

  // ---------- 视锥裁剪 ----------
  // 图层的世界空间 AABB 与可见窗口是否完全不相交。
  // 世界坐标同 layerModelMatrix：y 已翻成 cam.projH - origin.y，可见窗口是
  // [offX, offX+viewW] × [offY, offY+viewH]（见 buildCamera 的 fitWindow）。
  function isLayerOffscreen(layer, cam) {
    // 透视场景的世界单位不是像素，2D AABB 裁剪会把几乎所有层判到窗外。
    if (cam && cam.perspective) return false
    const sw = layer.size[0] * layer.scale[0]
    const sh = layer.size[1] * layer.scale[1]
    // 尺寸未知（0）的层不裁：文字/声音/纯效果层的 size 常为 0，但仍可能有内容
    if (sw === 0 || sh === 0) return false
    // 负缩放（镜像）会让宽高为负，取绝对值才是真实包围盒
    let halfW = Math.abs(sw) / 2
    let halfH = Math.abs(sh) / 2
    // 旋转后的 AABB：用旋转矩阵作用于半宽半高向量，取绝对值之和
    const ang = layer.angles[2]
    if (ang !== 0) {
      const c = Math.abs(Math.cos(ang))
      const s = Math.abs(Math.sin(ang))
      const rw = halfW * c + halfH * s
      const rh = halfW * s + halfH * c
      halfW = rw
      halfH = rh
    }
    const cx = layer.origin[0]
    const cy = cam.projH - layer.origin[1]
    // 视差与相机抖动会让层在几十像素内浮动；留一档余量避免边缘层被误裁。
    // 对象级视差最大位移 = |d|/2 × layerParallaxScale（见 parallaxDepthFactor）。
    let margin = 64
    if (layer.parallaxDepth) {
      margin += Math.abs(parallaxDepthFactor(layer.parallaxDepth[0]) * layerParallaxScaleX)
      margin += Math.abs(parallaxDepthFactor(layer.parallaxDepth[1]) * layerParallaxScaleY)
    }
    // [we-scene patch] puppet 的骨骼动画会把网格推离 origin，而这里判的是**静态** origin，
    // 于是「停在屏外、靠动画开进来」的层会被每帧裁掉，动画永远播不出来。
    // 2477602742 的三节火车 origin 在 x=5613/11478/17315（场景仅 2560 宽），
    // 动画把根骨从 +102 拉到 -17944 —— 那正是火车驶过道口的那几秒。
    // 症状是道口灯闪、栏杆落、汽笛响，唯独没有车。
    const ext = puppetAnimMargin(layer)
    const marginX = margin + ext[0]
    const marginY = margin + ext[1]
    return (
      cx + halfW + marginX < cam.offX ||
      cx - halfW - marginX > cam.offX + cam.viewW ||
      cy + halfH + marginY < cam.offY ||
      cy - halfH - marginY > cam.offY + cam.viewH
    )
  }

  // [we-scene patch] 序列帧动画：算出当前该采样 sprite sheet 的哪一格。
  //
  // WE 的做法是给图层 material 打 `combos: { spritesheet: 1 }`（大小写两种写法
  // 全库都有），贴图本身在 TEXS 段带一张帧表（每帧一组仿射 UV 基 + duration）。
  // 图层的 size 是**单帧尺寸**（如 3250755486 的猫是 220x220），而贴图是
  // 1320x1540 的整张 sheet。
  //
  // 不实现的后果：整张 sheet 被铺满 quad —— 那只猫显示成 6x7 的贴图网格。
  // 全库 52 个图层 / 7 个壁纸用它（其中 37 层由脚本钉帧，15 层自动播放）。
  //
  // 帧的选择有两条来源，脚本优先：
  //   1) `thisLayer.getTextureAnimation().setFrame(n)` —— 37 层这么用，语义是
  //      **把这一格钉住**（3299228616 的 AM/PM 按当前小时选 0/1；3292361861 的
  //      开关按钮按状态选 0..3）。这类层往往还先调 stop()/pause()。
  //      若把它们按时间自动播，AM/PM 会每秒闪一次 —— 明显错误。
  //   2) 无脚本时按时间自动播：各帧 duration 累加取模。时间基准用场景时间
  //      （自挂载起算），故限帧/暂停时播放进度与画面一致，不会因丢帧跳格。
  //      duration ≤ 0 的帧按 1/30s 兜底（避免除零卡死在第 0 帧）。
  //
  // 返回 [originU, originV, uU, uV, vU, vV]（都已归一化到图集尺寸），
  // 供 COPY_FRAG 做 `origin + u·uDir + v·vDir` 仿射采样 —— 矩形表达不了
  // Raiden Friends 末 3 帧的 90° 旋转打包。
  function spriteFrameBasis(layer, texObj, time) {
    if (!layer.spriteSheet) return null
    const frames = texObj && texObj.frames
    const list = Array.isArray(frames) ? frames : frames && frames.list
    if (!list || list.length === 0) return null
    // 归一化分母必须是**图集真实像素尺寸**。texObj.width/height 是解码后的
    // mip0 尺寸，与 TEXS 校验用的 atlasWidth/Height 同源；头部的 textureWidth
    // 在 1444077782 上是单帧尺寸（316x214），拿它当分母会整表错位。
    const texW = (frames && frames.atlasWidth) || texObj.width || 0
    const texH = (frames && frames.atlasHeight) || texObj.height || 0
    if (texW <= 0 || texH <= 0) return null
    // 让脚本能读到真实帧数（thisLayer.getTextureAnimation().frameCount）
    layer.spriteFrameCount = list.length

    let idx = 0
    const anim = layer.textureAnimation
    if (anim && anim.frame !== null && anim.frame !== undefined) {
      // 脚本钉帧：取整并夹到合法区间（语料里有 `setFrame(bool*1)`、
      // `setFrame((n+1)%3)` 这类写法，值可能是布尔或越界数）
      idx = Math.floor(Number(anim.frame)) || 0
      if (!(idx >= 0)) idx = 0
      if (idx >= list.length) idx = list.length - 1
    } else if (list.length > 1) {
      // 自动播放；被 pause()/stop() 过的层停在第 0 帧
      const paused = anim && anim.playing === false
      let total = 0
      for (const f of list) total += f.duration > 0 ? f.duration : 1 / 30
      if (!paused && total > 0) {
        let t = time % total
        if (t < 0) t += total
        for (let i = 0; i < list.length; i++) {
          const d = list[i].duration > 0 ? list[i].duration : 1 / 30
          if (t < d) { idx = i; break }
          t -= d
          idx = i
        }
      }
    }

    const f = list[idx]
    // TEXS 的 y 是**从贴图顶部**量的，而层 FBO 的 copy pass 已经把内容上下倒置
    // （见 layerQuadVerts 注释：FBO 顶 ← 纹理 v=1 ← 图像底行）。基向量作用在
    // 采样坐标上，故这里按「图像行」直接给，不再翻 y。
    // 旧帧表（粒子端产出的纯矩形，无 uDir/vDir）退化成轴对齐基。
    const uX = f.uDir ? f.uDir[0] : f.width
    const uY = f.uDir ? f.uDir[1] : 0
    const vX = f.vDir ? f.vDir[0] : 0
    const vY = f.vDir ? f.vDir[1] : f.height
    return [f.x / texW, f.y / texH, uX / texW, uY / texH, vX / texW, vY / texH]
  }

  // ---------- 合成（层 → 画布） ----------
  // 图层局部变换（不含投影）：把 [-0.5,0.5] 的 local quad 映射到世界空间
  function layerModelMatrix(layer, cam) {
    const w = layer.size[0] * layer.scale[0]
    const h = layer.size[1] * layer.scale[1]
    let m = mat4Identity()
    if (cam && cam.perspective) {
      // 3D Y-up：origin 原样用，不再做 projH - y（那是 2D 像素场景的 Y 翻转）。
      // 天空盒锁到 cam.eye，否则相机在盒外只看得到一块球面（3509243656）。
      const o = layerWorldOrigin(layer, cam)
      m = mat4Translate(m, o[0], o[1], o[2])
      const ax = layer.angles[0] || 0
      const ay = layer.angles[1] || 0
      if (ay) m = mat4RotateY(m, ay)
      if (ax) m = mat4RotateX(m, ax)
      m = mat4RotateZ(m, -layer.angles[2])
    } else {
    m = mat4Translate(m, layer.origin[0], cam.projH - layer.origin[1], layer.origin[2])
    // 对象级视差（parallaxDepth）：相机不动，各层按自身深度**正向**平移。
    // 放在旋转之前 = 沿世界轴平移（视差是相机效果，不应被图层自身旋转带偏）。
    // 深度响应线性：offset = parOff × d/2（parallaxDepthFactor）。
    // |d|=1 → 0.5×parOff（与旧饱和函数在 1 处同值）；depth=0 → 不动；
    // 大 depth 按作者写的数字比例走，不再饱和。
    if (layer.parallaxDepth && (layerParallaxScaleX !== 0 || layerParallaxScaleY !== 0)) {
      const fx = parallaxDepthFactor(layer.parallaxDepth[0])
      const fy = parallaxDepthFactor(layer.parallaxDepth[1])
      m = mat4Translate(m, fx * layerParallaxScaleX, fy * layerParallaxScaleY, 0)
    }
    // 旋转：参考实现 y-up 空间 rotate(-angle)，等效 y-down 屏幕 rotate(-angle)（正角度=屏幕逆时针）
    m = mat4RotateZ(m, -layer.angles[2])
    }
    // [we-scene patch] WE alignment：origin 锚在图层 quad 的对应边/角（bottom=底边中点、
    // topleft=左上角…）。这是音频条「底部对齐、随频谱向上伸缩」的基准
    // （全库 112 处 / 18 壁纸）。
    //
    // 锚点偏移的单位是**像素**（w/h），不是局部 quad。矩阵列主序、右乘施加，
    // 后面那句 mat4Scale(w,h) 只作用于它**右侧**的顶点，不会把这里的平移量放大。
    // 早先写成 (ax-0.5, 0.5-ay) 相当于只偏了「不到 1 个像素」，非 center 层
    // 等于仍然绕中心对齐 —— 3148125112 的「柱子/柱子布料」（bottom，应上移
    // 526px）整根柱子沉到画面外，只剩顶端露在人物左脚下方，看着像被裁掉。
    //
    // x 分量还得取反：origin 要落在锚点上，quad 就得往**反方向**长。
    // left(ax=0) 期望 x∈[0,w]，需要 +w/2，即 (0.5-ax)*w；写成 (ax-0.5)*w 会
    // 朝反方向偏一整个层宽（3148125112「指针」topright 横向差 1634px）。
    // y 分量两种写法在 y-down 下同号，取 (0.5-ay)*h 保持对称。
    const a = ALIGN[layer.alignment] || [0.5, 0.5]
    if (a[0] !== 0.5 || a[1] !== 0.5) {
      m = mat4Translate(m, (0.5 - a[0]) * w, (0.5 - a[1]) * h, 0)
    }
    return { m, w, h }
  }

  function compositeLayer(prog, inputTex, color4, layer, cam, viewProj, width, height, premultiplied = false, frameBasis = null, contentRect = null) {
    const base = layerModelMatrix(layer, cam)
    // [we-scene patch] contentRect（puppet 网格超出层矩形时）：层 FBO 覆盖的是
    // 「层矩形 ∪ 网格包围盒」，比 layer.size 大且中心可能偏移，合成 quad 必须按
    // 同一个矩形来放，否则放大的内容会被当成层矩形缩放贴回去（人物整体变大/错位）。
    // 局部 quad 是 [-0.5,0.5]，故先按尺寸比放大、再补上中心偏移（网格 y-up → 屏幕 y-down 取负）。
    let m = base.m
    if (contentRect) {
      const cx = (contentRect[0] + contentRect[2] / 2) * layer.scale[0]
      const cy = (contentRect[1] + contentRect[3] / 2) * layer.scale[1]
      m = mat4Translate(m, cx, -cy, 0)
      m = mat4Scale(m, contentRect[2] * layer.scale[0], contentRect[3] * layer.scale[1], 1)
    } else {
      m = mat4Scale(m, base.w, base.h, 1)
    }
    const mvp = mat4Multiply(viewProj, m)
    // [we-scene patch] 固定管线表达不了的 colorBlendMode 改走 shader 侧混合：
    // 回读画布当 dst，用 ApplyBlending 算完直接写（见 needsShaderBlend 的归属证据）。
    //
    // 三个前置条件缺一不可：
    //  - `!premultiplied`：容器画布（音频条 / audio_ring）有自己一套 alpha 约定，
    //    见下方 [A]/[B] 分流，套 ApplyBlending 会把那两类都打错；
    //  - `!groupTarget`：组渲染时目标是组 FBO，而回读拿到的是**画布**——
    //    用画布当 dst 等于把组外的像素混进组内，位置和内容都不对。组自身合成到
    //    画布那一趟仍会正常走到这里（那时 groupTarget 已复位）；
    //  - `needsShaderBlend`：Normal 与 5 个固定管线模式继续走原路，不白烧一次拷贝。
    const useShaderBlend =
      !premultiplied && !groupTarget && needsShaderBlend(layer.colorBlendMode)
    if (useShaderBlend) {
      const backdrop = captureBackdrop(width, height)
      gl.useProgram(compBlendProg)
      // 结果由 shader 直接算出，GL 混合必须关掉（再叠一次等于混两遍）
      gl.disable(gl.BLEND)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.viewport(0, 0, width, height)
      gl.bindVertexArray(vao)
      uploadQuad('local', LOCAL_QUAD)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, inputTex)
      gl.uniform1i(compBlendUni.tex, 0)
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, backdrop)
      gl.uniform1i(compBlendUni.backdrop, 1)
      gl.uniform1i(compBlendUni.blendMode, Number(layer.colorBlendMode) | 0)
      gl.uniform2f(compBlendUni.canvasSize, width, height)
      // 层 alpha 是 WE 混合的 opacity。inputTex 是原始贴图（solid 层是 1×1 白），
      // 不透传这里会把 alpha=0 的层按全不透明参与 ColorBurn/Overlay 等混合，
      // 3793592591 的白色 Katı 层因此把整屏冲成纯白。
      gl.uniform1f(compBlendUni.opacity, color4[3])
      gl.uniformMatrix4fv(compBlendUni.mvp, false, mvp)
      gl.drawArrays(gl.TRIANGLES, 0, 6)
      // 纹理单元 1 用完解绑：后续 pass 按单元号取样，留着会串图
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, null)
      gl.activeTexture(gl.TEXTURE0)
      return
    }
    const uni = prog === compProg ? compUni : copyUni
    gl.useProgram(prog)
    // [we-scene patch] 容器效果画布（空容器 + 音频可视化等）的合成方式。
    // 两类容器效果的输出约定**正好相反**，必须分流，一刀切必然牺牲一类：
    //
    //  [A] 形状在 alpha（Simple_Audio_Bars，TRANSPARENCY=REPLACE 为声明默认 1）：
    //        finalColor = ApplyBlending(0, mix(u_BarColor, scene.rgb, scene.a),
    //                                   u_BarColor, bar*opacity)
    //        alpha      = bar * u_BarOpacity
    //      容器基底 scene=(0,0,0,0) ⇒ 两个混合参数都是 u_BarColor，
    //      mix(A,B,op) 在 A==B 时**恒等于 u_BarColor**，与 bar 无关 —— 形状只在 alpha。
    //      这类必须按直通 alpha 做 over：否则 bar=0 处的白 rgb 会铺满整个 quad。
    //      实测症状：2134765860 "Visualizer 32"（340x250 @1313,537）整块纯白矩形，
    //      把该层 size 改成 80x60 白块同步缩小（归属确认）。
    //
    //  [B] 发光在 rgb、alpha 恒为基底（audio_ring，BLENDMODE=31 Add）：
    //        finalColor = A + B*opacity;  alpha = scene.a  ⇒ 空容器下恒为 0
    //      这类必须让 rgb 直接叠加：按 alpha 合成会因 alpha=0 整个消失
    //      （实测音箱上的蓝色光环不见了）。
    //
    // 判据取自着色器**实际写出的 alpha 是否携带信息**：由 renderLayer 在跑完
    // 效果链后置位（见 containerAlphaMeaningful）。无法判定时按 [B] 处理 ——
    // 少遮挡比整层消失更接近 WE 观感。
    if (premultiplied) {
      // 容器画布走自己的一套混合，不是 Screen/Multiply，必须清掉上一层残留的预处理
      blendPrep = 0
      gl.enable(gl.BLEND)
      if (layer.containerAlphaMeaningful) {
        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
      } else {
        gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
      }
    } else {
      setColorBlend(layer.colorBlendMode)
    }
    // Screen/Multiply 必须在 shader 里先按 src.a 处理一遍，见 BLEND_PREP 注释。
    // 这条路径是所有「效果链层」和「直接层」的最终合成出口，统一在这里设置。
    if (uni.blendPrep !== null && uni.blendPrep !== undefined) {
      gl.uniform1i(uni.blendPrep, blendPrep)
    }
    // [we-scene patch] 组渲染目标：子层的最终合成要写进组 FBO 而非画布。
    if (groupTarget) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, groupTarget.fbo.fbo)
      gl.viewport(0, 0, groupTarget.w, groupTarget.h)
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.viewport(0, 0, width, height)
    }
    gl.bindVertexArray(vao)
    uploadQuad('local', LOCAL_QUAD)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, inputTex)
    gl.uniform1i(uni.tex, 0)
    gl.uniformMatrix4fv(uni.mvp, false, mvp)
    if (uni.color !== null && uni.color !== undefined) gl.uniform4f(uni.color, color4[0], color4[1], color4[2], color4[3])
    // 序列帧：无效果链的图层直接在这一趟采样当前帧（猫层就是这条路径）。
    // copyProg 是共享的，非序列帧层必须显式复位成整图直通，否则会残留上一层的格子。
    setFrameBasis(uni, frameBasis)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
  }

  // 把帧的仿射 UV 基写进 copyProg；basis 为 null 时复位成整图直通 (0,0)+(1,0)+(0,1)。
  // compProg 没有这三个 uniform（getUniformLocation 返回 null），故先判空。
  function setFrameBasis(uni, basis) {
    if (!uni || uni.frameOrigin === null || uni.frameOrigin === undefined) return
    if (basis) {
      gl.uniform2f(uni.frameOrigin, basis[0], basis[1])
      gl.uniform2f(uni.frameU, basis[2], basis[3])
      gl.uniform2f(uni.frameV, basis[4], basis[5])
    } else {
      gl.uniform2f(uni.frameOrigin, 0, 0)
      gl.uniform2f(uni.frameU, 1, 0)
      gl.uniform2f(uni.frameV, 0, 1)
    }
  }

  // [we-scene patch] puppet 骨骼网格图层：由外部注入的 MDL 渲染器绘制（见 setPuppetRenderer）
  // 网格坐标 = 图层局部像素、y 轴朝上，故 model 矩阵在层变换后翻转 y。
  let puppetDrawFn = null
  // [we-scene patch] 当前组渲染目标（非 null 时，图层的最终合成写进这个 FBO 而非画布）。
  // 见 renderContainerGroup：带子层的容器要先把子层合成到组 FBO 再整体跑效果。
  let groupTarget = null
  // [we-scene patch] 跨层合成表：`_rt_imageLayerComposite_<objectId>_a` → 该对象跑完
  // 自己效果链后的 FBO。带模型的源每帧开头由 renderCompositeSources 填充；
  // 空 composelayer 源在主循环走到该层 z 序时由 captureEmptyComposeAtZOrder 回读画布填入。
  const compositeFBOs = new Map()
  // 空 composelayer 合成源：预渲染阶段无法回读（后面的层还没画），先记下名字，
  // 主循环按图层顺序捕获。oid → Set<完整纹理名>
  const pendingEmptyCompose = new Map()
  // [we-scene patch] A/B 开关（调试用）：关掉后 `_rt_imageLayerComposite_*` 退回
  // 改动前的行为（一律返回当前层自己的 inputFBO），用来判定某处画面异常
  // 是本次改动引入的回归、还是改动前就存在。
  let compositeEnabled = true
  function puppetModelMatrix(layer, cam) {
    const base = layerModelMatrix(layer, cam)
    // 2D：scale(sx, -sy) 网格 y-up → 场景 y-down。透视场景本身 Y-up，不再翻 Y。
    const sy = cam && cam.perspective ? layer.scale[1] : -layer.scale[1]
    const sz = cam && cam.perspective ? (layer.scale[2] || 1) : 1
    return mat4Scale(base.m, layer.scale[0], sy, sz)
  }

  // 直接绘制到画布。组渲染时改写进组 FBO（见 groupTarget）。
  // [we-scene patch] overrideTex：puppet 层跑完效果链后，网格要采样**效果链输出**
  // 而不是原始贴图（见 renderLayer 里「puppet 的效果链在贴图空间」那段注释）。
  function drawPuppetDirect(layer, cam, viewProj, width, height, time, overrideTex) {
    if (groupTarget) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, groupTarget.fbo.fbo)
      gl.viewport(0, 0, groupTarget.w, groupTarget.h)
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.viewport(0, 0, width, height)
    }
    // [we-scene patch] 链尾 FBO 每帧重建 mip：效果链 FBO 本是 LINEAR 无 mip 的，
    // 而 puppet 贴图在画布上通常被大幅缩小（3264246690 人物贴图 3658×2000 →
    // 屏上 ~840px ≈ 4.4×），无 mip 采样会让细线艺术以满幅对比度显示并带
    // 反锯齿刻线。MIN_FILTER 必须**每帧**在 generateMipmap 之前重设：结尾会把
    // 池化 FBO 还原成 LINEAR（防其他层吃到过期 mip），如果只在首帧设一次
    // trilinear，第 2 帧起就是「生成了 mip 但采样器不用」。
    if (overrideTex) {
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, overrideTex)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
      gl.generateMipmap(gl.TEXTURE_2D)
    }
    const mvp = mat4Multiply(viewProj, puppetModelMatrix(layer, cam))
    puppetDrawFn(layer, mvp, { time, overrideTex: overrideTex || null })
    // [we-scene patch] 链尾 FBO 由同尺寸的层共享（getFBO 池）：其他层（图片层
    // compositeLayer 1:1 或放大采样）不能吃到这里的 trilinear + 本帧 mip ——
    // 它们的 mip 是过期的，缩小采样会读出残影。画完立刻还原 LINEAR。
    if (overrideTex) {
      gl.bindTexture(gl.TEXTURE_2D, overrideTex)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    }
    currentQuadKey = null // MDL 渲染器换过 VAO/buffer，失效 quad 缓存
  }

  // [we-scene patch] puppet 的效果链跑在**贴图空间**，不再有「把网格渲进层 FBO」这一步。
  //
  // 旧实现：先蒙皮渲进 FBO A（几何空间），再把效果盖在形变后的画面上。
  // 这对 3148125112 的丝袜切换是错的 —— 实测 `materials/腿2.tex`（白丝）的不透明
  // 像素有 **100.0%** 落在 `materials/腿1.tex`（光腿）的不透明像素内，两张图在
  // **未形变的贴图空间**逐像素对齐；同层的 waterwaves / opacity 蒙版又都是
  // 1286×1148 = 层尺寸的一半，同样按层矩形归一化。也就是说这些资源全部作于
  // 静止姿势的贴图坐标系，必须先在贴图上合成、再由网格整体形变。
  // 旧顺序把平整的丝袜贴到已经抬腿的画面上，只能糊出一条错位白带。
  //
  // 网格 UV 与静止姿势位置严格对应（u=(x+W/2)/W、v=(H/2-y)/H，见 mdl.js 头注），
  // 所以「贴图空间」就是「层矩形空间」：效果链按普通图片层那套跑完，
  // 把输出当作新贴图交给网格采样即可（见 drawPuppetDirect 的 overrideTex）。
  //
  // 附带收益：contentRect（层矩形 ∪ 网格包围盒）随之失效并被删除。它原本是为了
  // 让 FBO 装下超出层矩形的网格，但那是几何空间的问题；贴图空间里效果链的画布
  // 天然就是层矩形，与蒙版基准一致，不需要再扩。


  // [we-scene patch] `config.passthrough`：层的效果链输入 = 它**背后已渲染的画面**，
  // 而不是一块空白画布。全库 120 处、全部是容器，其中 119 个是「空容器 + 效果」。
  //
  // 为什么必须实现：工坊音频可视化普遍写成
  //   finalColor = ApplyBlending(MODE, lerp(barColor, scene.rgb, scene.a), barColor, bar*op)
  // 空画布下 scene=(0,0,0,0)，那个 lerp 原样返回 barColor，两个混合参数相同
  // ⇒ **rgb 完全不含 bar 形状**，形状只能寄望于 alpha。TRANSPARENCY=REPLACE 的
  // 尚有 alpha 兜底（见 compositeLayer 的 [A]/[B] 判定），而 PRESERVE
  // （alpha = scene.a = 0）连 alpha 都没有 —— 整块 quad 成了恒定纯色。
  // 3789131791「Green」就是这样糊出一块 1920×1080 青色矩形。给它真实背景后
  // scene.a=1，bar=0 处输出精确等于原背景（离线复算：[0.10,0.12,0.25] 原样返回）。
  //
  // 做法：把画布当前内容按**层矩形的屏幕投影**采样进层 FBO。层的世界变换可能带
  // 旋转与负缩放（库内 86/119 有 z 旋转、93/119 有负缩放），所以不能用轴对齐
  // 矩形回读；这里逐顶点把层局部 quad 的四角变换到屏幕、算出各自的画布 UV，
  // 由 GPU 做透视正确的插值 —— 旋转/镜像自动成立。
  //
  // 画布内容先拷进一张纹理（WebGL 不能一边采样默认帧缓冲一边写它）。
  //
  // **内部格式必须是 RGB8，不能是 RGBA8。** 画布上下文是 `alpha: false`
  // （见 main.ts 的 getContext），默认帧缓冲根本没有 alpha 通道，
  // 而 copyTexImage2D 要求目标格式的每个分量在源里都存在 —— 拿 RGBA8 去拷
  // 会得到 `INVALID_OPERATION`(1282) 并**静默留下一张全零纹理**
  // （实测：RGBA8 → err=1282、像素 [0,0,0,0]；RGB8 → err=0、像素 [206,146,95,255]）。
  // 症状是 passthrough 层的背景变成纯黑方块而不是真实画面。
  let backdropTex = null
  function captureBackdrop(width, height) {
    if (backdropTex === null) {
      backdropTex = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, backdropTex)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.bindTexture(gl.TEXTURE_2D, backdropTex)
    // copyTexImage2D 一次完成「分配 + 拷贝」，画布尺寸变化自动跟随
    gl.copyTexImage2D(gl.TEXTURE_2D, 0, gl.RGB8, 0, 0, width, height, 0)
    return backdropTex
  }

  // 把画布内容按层矩形的屏幕投影画进层 FBO（passthrough 层的效果链输入）。
  function drawBackdropToFBO(layer, fbo, fboW, fboH, cam, viewProj, width, height) {
    const src = captureBackdrop(width, height)
    const base = layerModelMatrix(layer, cam)
    let m = base.m
    m = mat4Scale(m, base.w, base.h, 1)
    const mvp = mat4Multiply(viewProj, m)
    // 层局部 quad 的四角（与 LOCAL_QUAD 同约定：local +y = 屏幕下方）
    // → NDC → 画布 UV（y 已朝上，与 copyTexImage2D 得到的 GL 纹理一致）。
    const corners = [
      [-0.5, 0.5], [0.5, 0.5],   // 屏幕**下方**两角
      [-0.5, -0.5], [0.5, -0.5], // 屏幕**上方**两角
    ].map(([lx, ly]) => {
      const p = mat4TransformPoint(mvp, lx, ly, 0)
      return [p[0] * 0.5 + 0.5, p[1] * 0.5 + 0.5]
    })
    const [sbl, sbr, stl, str] = corners
    // 层 FBO 的内容是**倒置**的（见 layerQuadVerts）：合成时 LOCAL_QUAD 让
    // local +y（屏幕下方）去采 v=1，而这里 ortho 的 top=fboH ⇒ 行 y=fboH 就是 v=1。
    // 所以 **FBO 顶行必须装屏幕下方两角**，装反了整块背景会上下翻转
    // （实测 2134765860 的 amp 区域显示成错位的画面副本）。
    const verts = new Float32Array([
      0, fboH, 0, sbl[0], sbl[1],
      0, 0, 0, stl[0], stl[1],
      fboW, fboH, 0, sbr[0], sbr[1],
      fboW, fboH, 0, sbr[0], sbr[1],
      0, 0, 0, stl[0], stl[1],
      fboW, 0, 0, str[0], str[1],
    ])
    gl.useProgram(backdropProg)
    setBlend('normal')
    gl.disable(gl.BLEND)
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.fbo)
    gl.viewport(0, 0, fboW, fboH)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.bindVertexArray(vao)
    // 顶点数据逐层不同（取决于层的屏幕投影），key 传 null 强制每次重传
    gl.bindBuffer(gl.ARRAY_BUFFER, vbuf)
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW)
    currentQuadKey = null
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, src)
    gl.uniform1i(backdropUni.tex, 0)
    gl.uniformMatrix4fv(backdropUni.mvp, false, mat4Ortho(0, fboW, 0, fboH, -10000, 10000))
    gl.drawArrays(gl.TRIANGLES, 0, 6)
    gl.enable(gl.BLEND)
  }

  // [we-scene patch] 空 composelayer 作 `_rt_imageLayerComposite` 源：在**该层自己的 z 序**
  // 把画布当前内容按层矩形抠进独占 FBO。这才是 WE 的 composelayer 语义
  // （捕获身后已渲染画面），不是「跑一遍空层效果链」。
  //
  // 不能放在 renderCompositeSources 里：那趟在主循环之前，画布只有 clearcolor，
  // 预渲染只能给一张全透明图。clipping_mask 吃到透明 clip（rgb=0）会把白底三角
  // 混成不透明色块；回退 inputFBO 则 clip≈albedo≈白，BLENDMODE 5（Darken）
  // 仍是白三角。2902406982 中间那组几何组件就是这样糊成实心白块的。
  //
  // 必须在主循环里、画完排在它前面的层之后、continue 跳过空容器自身之前调用。
  // drawBackdropToFBO 会改 FBO / viewport / program，回来一定要绑回画布。
  function captureEmptyComposeAtZOrder(layer, cam, viewProj, width, height) {
    if (!compositeEnabled || groupTarget) return
    const names = pendingEmptyCompose.get(layer.id)
    if (!names || names.size === 0) return
    const sw = Math.max(1, Math.round(Math.abs(layer.size[0] * (layer.scale[0] || 1))))
    const sh = Math.max(1, Math.round(Math.abs(layer.size[1] * (layer.scale[1] || 1))))
    if (sw <= 1 && sh <= 1) return
    const fbo = getFBO(sw, sh, 'lc:' + layer.id)
    drawBackdropToFBO(layer, fbo, sw, sh, cam, viewProj, width, height)
    for (const n of names) compositeFBOs.set(n, fbo)
    pendingEmptyCompose.delete(layer.id)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, width, height)
  }


  async function renderScene(scene, textures, width, height, time, fit, alignX, alignY) {
    fboStamp++
    gl.viewport(0, 0, width, height)
    const general = scene.general || {}
    if (general.clearenabled !== false) {
      const cc = parseVec3Local(general.clearcolor || '0 0 0')
      gl.clearColor(cc[0], cc[1], cc[2], 1)
    } else {
      gl.clearColor(0, 0, 0, 1)
    }
    gl.clear(gl.COLOR_BUFFER_BIT)
    // [we-scene patch] 帧间隔（g_Frametime）。用场景时间差分而非 performance.now()，
    // 与 g_Time 同源，暂停/限帧时不会算出虚高的 dt。异常值（首帧、跳变、标签页
    // 切回的巨大间隔）钳到 [1/1000, 1/10]：cursorripple 的冲量与 dt 成正比，
    // 一个 2 秒的 dt 会拍出一道贯穿全屏的假波纹。
    if (lastFrameTimeStamp >= 0) {
      const dt = time - lastFrameTimeStamp
      lastFrametime = dt > 0 && dt < 1 ? dt : Math.min(0.1, Math.max(0.001, dt || 1 / 60))
    }
    lastFrameTimeStamp = time
    const cam = buildCamera(scene, width, height, fit, alignX, alignY)
    let viewProj = mat4Multiply(cam.projection, cam.view)

    // ---- 场景级视差（cameraparallax）+ 对象级视差基准 ----
    const parRaw = general.cameraparallax
    const parEnabled = parRaw === true || (parRaw !== null && typeof parRaw === 'object' && parRaw.value === true)
    layerParallaxScaleX = 0
    layerParallaxScaleY = 0
    const ptr = readPointer()
    // 指针归一化 [0,1] → 视差要的 [-1,1]（相对屏幕中心的偏移）。
    // 没有指针源或还没收到事件时停在中心（0,0），即无视差偏移。
    if (ptr) {
      parallaxState.x = ptr.u * 2 - 1
      parallaxState.y = ptr.v * 2 - 1
    }
    // 视差只在 cameraparallax 开启时生效。
    // 我曾自作主张给所有场景加了一个 0.02 的「默认对象视差基准」，理由是
    // 「作者显式给图层设了 parallaxDepth 就一定想要视差效果」——这个判断是错的。
    // 全库 109 个没开视差的壁纸里 41 个有非零 parallaxDepth，但那是
    // WE 的**默认模板值**（拖一个图层进场景就是 1.0/1.0），不代表作者想让它动。
    // 作者想要伪 3D 效果时，会去开「摄像头视差」开关（全库 22 个场景明确开了）。
    // 关掉开关就意味着「所有层都不动」——包括对象视差。这是 WE 的标准语义。
    if (!cam.perspective && opts.parallax !== false && parEnabled) {
      // [we-scene patch] 这三个字段可能是 `{user, value}` 用户属性包装
      // （parse.js 的 resolveUserProps 按设计**保留包装、只就地解 .value**，
      // 下游一律读 `.value`）。原先直接 `typeof x === 'number'` 判断，包装对象
      // 一律落到默认值 —— 3195212886 的 mouseinfluence 作者设的是 **-0.35**
      // （负值 = 反向、幅度小），被当成默认 1 后算出 **960px** 的相机位移，
      // 正是「鼠标一动整个画面乱飘」。
      const numProp = (v, dflt) => {
        const raw = v !== null && typeof v === 'object' ? v.value : v
        return typeof raw === 'number' && Number.isFinite(raw) ? raw : dflt
      }
      const amount = numProp(general.cameraparallaxamount, 0)
      const influence = numProp(general.cameraparallaxmouseinfluence, 1)
      const delay = numProp(general.cameraparallaxdelay, 1)
      const parDt = time - lastParallaxTime
      lastParallaxTime = time
      const parAlpha = parDt > 0 ? 1 - Math.exp(-parDt / Math.max(0.05, delay)) : 1
      parallaxState.sx += (parallaxState.x - parallaxState.sx) * parAlpha
      parallaxState.sy += (parallaxState.y - parallaxState.sy) * parAlpha
      const strength = amount * influence
      // [we-scene patch] 视差是**纯分层效果，相机不动**。
      //
      // 原实现让相机整体平移 parOff，再让每层反向补偿 -f(d)×parOff，净位移
      // 成了 (1-f(d))×parOff —— 这把深度关系**弄反了**：parallaxDepth=0 拿到的是
      // **最大**位移，depth 越大反而越不动。全库实测这正是「主窗口随鼠标乱飘移」：
      //   2974757317  全部 53 个对象 parallaxDepth=0 → 整个场景刚性平移 480px
      //   2887099508  82 个对象里 68 个为 0         → 绝大多数层满额飘
      //   2902406982  140 个对象里 96 个为 0        → 同上
      // 而作者的实际用法（3148125112：15 层留 0、其余分级到 -0.1~-0.8）说明
      // **depth=0 就是「钉住不动」**，作者只给想浮动的层设非零深度。
      //
      // 正确语义：相机固定，第 i 层平移 +f(d)×parOff，f(d)=d/2。
      // depth=0 → 完全不动；depth=1 → 0.5×parOff（与旧 d/(1+|d|) 在 1 处同值）；
      // depth=25 → 12.5×parOff。负值（远景）反向跟随。
      // 旧饱和函数 d/(1+|d|) 让 pd=25 的文字和 pd≈1.75 的鸟几乎一样远，
      // 作者写 25 就白写了（2802243144）。不要再给文字层乘固定倍数。
      const PARALLAX_MAX_PX = 60
      const rawOffX = parallaxState.sx * strength * cam.viewW
      const rawOffY = parallaxState.sy * strength * cam.viewH
      // 按 x/y 里更大的超出比例统一缩放，避免单轴截断改变位移方向。
      //
      // [we-scene patch] 封顶**无条件生效**，不再只针对编辑器默认值。
      // amount 的绝对像素当量无从考证：全库 1906 个 shader 里**没有一个**引用
      // g_ParallaxPosition，官方文档只有落地页，无法反推 amount→px 的比例。
      // 已知的只有分布：编辑器默认 amount=0.5/infl=0.5（乘积 0.25，9 个壁纸原样
      // 保留），作者真正调过的落在 0.005~0.05，另有 3 个显式调高到 0.35~0.63。
      // 按 product×viewSize 直算，默认值在 1920 宽上就是 480px，调高的那批到
      // 672~1210px。既然基准本身不可信，就统一压到「几十像素轻微浮动」的观感，
      // 并在 README 记录这是**未经证实的近似**。
      const over = Math.max(Math.abs(rawOffX), Math.abs(rawOffY)) / PARALLAX_MAX_PX
      const damp = over > 1 ? 1 / over : 1
      // 对象级视差基准：各层按 +(d/2)×parOff 平移（见 layerModelMatrix / parallaxDepthFactor）。
      // 相机自身不平移 —— viewProj 保持原样。
      //
      // XY 都取负：视差是「朝指针方向看」——近景与鼠标反向漂。正号会让层
      // 跟着指针走，观感反了。Y 额外对应 origin Y-up 翻转
      // （worldY = projH - (origin.y + fy * sy)）。不要改 f(d) 本身，
      // 也不要翻 g_ParallaxPosition（shader 要的是和指针一样的 Y-down [0,1]）。
      layerParallaxScaleX = -(rawOffX * damp)
      layerParallaxScaleY = -(rawOffY * damp)
    }

    // [we-scene patch] camerashake：相机整体抖动（全库 5 个场景开启）。
    // 与视差不同，抖动是**相机自身**位移（整个画面一起晃），所以右乘到 viewProj
    // 才是在世界空间平移 —— 写成左乘会落到投影后的 NDC 空间（全宽仅 2.0），
    // 几十像素的偏移被当成十几个屏幕宽，画面直接跑飞。
    if (!cam.perspective && opts.shake !== false) {
      const sh = cameraShakeOffset(general, time)
      if (sh) {
        // amp=1 → ±2% 视宽；这个比例是观感近似（见 cameraShakeOffset 注释）
        const px = sh.x * cam.viewW * 0.02
        const py = sh.y * cam.viewH * 0.02
        if (px !== 0 || py !== 0) {
          viewProj = mat4Multiply(viewProj, mat4Translate(mat4Identity(), px, py, 0))
        }
      }
    }

    // [we-scene patch] 把归一化指针换算成世界像素并写回指针源。
    // 必须在这里做（而非宿主侧）：cam 每帧由 buildCamera 构造，只在帧内可得。
    //
    // 补偿恒为 0：视差改成纯分层效果后**相机不再平移**，画面整体没有位移，
    // 减去 layerParallaxScale 反而会让指针与画面错开一个视差量。
    if (pointerProvider) {
      const src = typeof pointerProvider === 'function' ? pointerProvider() : pointerProvider
      if (src && typeof src.syncWorld === 'function') {
        src.syncWorld(cam, 0, 0)
      }
    }

    // [we-scene patch] 首帧一次性诊断：容器效果画布的解析/门控状态（音频可视化不可见时定位用）
    if (!containerDiagDone) {
      containerDiagDone = true
      const cs = (scene.layers || []).filter((l) => l.isContainer)
      const candidates = cs.filter((l) => (l.effects || []).some((e) => e.visible) && !l.hasChildren)
      const resolved = candidates.filter((l) => (l.effects || []).some((e) => (e.materialPasses || []).length > 0))
      diag(
        `containers total=${cs.length} canvasCandidates=${candidates.length} passesResolved=${resolved.length}` +
          ` names=${candidates.slice(0, 4).map((l) => l.name || '?').join('/')}`,
      )
    }
    // [we-scene patch] 跨层合成源：必须先于主循环跑完（渲染顺序 = 数组顺序，
    // 源层可能排在引用方后面），结果落进各自独占的 FBO 供引用方采样。
    await renderCompositeSources(scene, textures, cam, width, height, time)
    // [we-scene patch] 组渲染目标：带子层且挂了效果的容器，效果作用在**子层合成图**上。
    // 先把这些容器的子孙 id 收集起来，主循环里跳过它们（改由容器统一渲染）。
    // 必须收孙层：3787937755 眼睛/手挂在身子下面，组容器的 childIds 只有身子。
    // 全库 15 个这类容器 / 9 个壁纸；3264246690 的三条 DANGER 胶带就是
    // 「容器挂 scroll + 子层出图」，此前整组被跳过，胶带完全静止。
    const layerById = new Map()
    for (const l of scene.layers) if (l.id !== undefined) layerById.set(l.id, l)
    const groupChildIds = new Set()
    const groupContainers = []
    for (const layer of scene.layers) {
      if (!layer.visible || layer.destroyed || !layer.isContainer || !layer.hasChildren) continue
      if (!(layer.effects || []).some((e) => e.visible)) continue
      const kids = layer.childIds || []
      if (kids.length === 0) continue
      groupContainers.push(layer)
      collectGroupDescendantIds(layer, layerById, groupChildIds)
    }
    // [we-scene patch] 粒子每帧推进：在图层迭代前统一推进所有粒子系统（dt 由宿主管理）。
    // 必须在渲染之前完成，以免粒子位置在帧内不一致。
    if (particleAdvanceFn) {
      try { particleAdvanceFn() }
      catch (e) { diag('particle advance error: ' + (e && e.message)) }
    }
    // 透视场景：天空盒先画（当背景），再画恒星/UI。没有深度缓冲排序时
    // 天空盒若按 scene.json 顺序排在星星后面，会把三星盖住。
    const drawLayers = cam.perspective
      ? scene.layers.slice().sort((a, b) => Number(!!b.isSkybox) - Number(!!a.isSkybox))
      : scene.layers
    for (const layer of drawLayers) {
      // destroyed：thisScene.destroyLayer 的墓碑。visible 字段脚本的
      // `return value` 可能在拆层的同一帧把 visible 写回 true
      // （3786330502 开场淡出），墓碑必须比写回更硬。
      //
      // [we-scene patch] 但**被引用的空 composelayer 源必须先回读再跳过**。
      // 这些层就是靠 visible:false 才不出现在画面上的纯素材（renderCompositeSources
      // 的注释也写了「源层几乎都是 visible:false」），可 z 序回读的钩子
      // captureEmptyComposeAtZOrder 挂在下面 isContainer 分支里，被这一行提前
      // continue 掉，于是 `_rt_imageLayerComposite_<id>_a` 永远进不了 compositeFBOs，
      // resolveTextureName 回退成 inputFBO（引用方自己的链输入）。clipping_mask
      //   albedo.rgb = ApplyBlending(mode, albedo.rgb, clip.rgb, mask * albedo.a * u_alpha)
      // 于是拿白底胶囊自己当 clip，白混白 = 一块矩形白板盖在卡片外
      // （2938612768 音条左侧白块）。全库 23 个空 composelayer 源里有 6 个是这种
      // visible:false 形态（2938612768 / 2974757317 各 3 个），另 17 个恰好
      // visible:true 才一直是对的。destroyed 墓碑不放行：那是层已经不存在了。
      if (layer.destroyed) continue
      if (!layer.visible) {
        if (pendingEmptyCompose.has(layer.id)) {
          captureEmptyComposeAtZOrder(layer, cam, viewProj, width, height)
        }
        continue
      }
      // [we-scene patch] 全屏后期：无可见效果的分隔层仍跳过（2134765860 一堆空
      // fullscreenlayer）。有 waterripple/pulse/godrays 的必须画，回读走
      // usePassthrough → drawBackdropToFBO。再整层 continue 就是静图（973101892）。
      if (layer.isPostProcess && !(layer.effects || []).some((e) => e.visible)) continue
      // 组渲染目标的子层：由所属容器在自己的位置统一画（见下方 renderContainerGroup）
      if (groupChildIds.has(layer.id)) continue
      if (layer.isContainer) {
        // composelayer 的子层已拆成世界坐标独立渲染，容器自身无内容。
        // 但「空容器 + 图层效果」是 WE 音频可视化的标准做法（全库 186 处：
        // 示波器 / Simple_Audio_Bars / audio_ring 都挂在无子层的容器上），
        // 这种容器要按「透明画布」参与效果链，否则波形/音频条整组不可见。
        const hasVisibleEffects = (layer.effects || []).some((e) => e.visible)
        if (!hasVisibleEffects) {
          // 空 composelayer 被当成合成源时：在这一刻回读身后画面，再跳过自身绘制。
          captureEmptyComposeAtZOrder(layer, cam, viewProj, width, height)
          continue
        }
        if (layer.hasChildren) {
          // 带子层：走组渲染目标（子层 → 组 FBO → 效果链 → 合成）
          if ((layer.childIds || []).length > 0) {
            await renderContainerGroup(layer, scene, textures, cam, viewProj, width, height, time)
          }
          continue
        }
      }
      if (layer.particle) {
        // [we-scene patch] 粒子图层：按图层 z 序渲染（由 particleRenderByLayer 渲染贴合的粒子系统）。
        // 不再「全部堆在最后」，而是**在图层迭代的正确位置**渲染，确保粒子与场景层正确穿插。
        // 例如雨景的底层雨滴（layer.id=12）渲染在人物层（layer.id~30）之前，人物不被雨幕遮挡。
        if (particleRenderByLayer) {
          try { await particleRenderByLayer(layer.id, cam, viewProj, width, height) }
          catch (e) { diag('particle render error: ' + (e && e.message)) }
        }
        continue
      }
      // [we-scene patch] 视锥裁剪：完全落在可见窗口外的图层不必渲染。
      // 作者常放超出屏幕的大图供视差平移（3113287126 的背景层 quad 达 8289×1554，
      // 而屏幕只有 3840 宽），这些层的效果链 FBO 会按整层尺寸分配 —— 跳过屏外层
      // 既省显存与逐 pass 开销，也不会改变画面（屏外内容本就被裁掉）。
      if (isLayerOffscreen(layer, cam)) continue
      await renderLayer(layer, textures, cam, viewProj, width, height, time)
    }
    // [we-scene patch] camerafade：WE 的开场淡入（全库 127/128 个场景都开着）。
    // scene.json 只有 `camerafade: true` 这个开关，**没有时长参数** —— WE 用固定
    // 内置时长。这里取 1.0s（可用 opts.fadeDuration 覆盖），并在 README 注明这个
    // 数值是观感近似、无数据出处。
    //
    // 实现为「最后叠一层由不透明渐变到全透明的 clearcolor 幕布」，而不是改每层的
    // alpha：后者要穿透效果链、且会把「层自身 alpha 参与的混合」算错；幕布只影响
    // 最终像素，与 WE 的整屏淡入观感一致。
    // 时间基准用 time（main.ts 传的是 (now-start)/1000，自挂载起算），首帧即 0。
    if (fadeEnabled(general) && time < fadeDuration) {
      const k = Math.max(0, Math.min(1, time / fadeDuration))
      // smoothstep 收尾更柔和；1-k 是幕布不透明度（k=0 全遮、k=1 全透）
      const cover = 1 - k * k * (3 - 2 * k)
      if (cover > 0.002) {
        const cc = parseVec3Local(general.clearcolor || '0 0 0')
        gl.useProgram(copyProg)
        gl.enable(gl.BLEND)
        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        gl.viewport(0, 0, width, height)
        gl.bindVertexArray(vao)
        uploadQuad('pass', PASS_QUAD)
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, whiteTex)
        gl.uniform1i(copyUni.tex, 0)
        gl.uniform4f(copyUni.color, cc[0], cc[1], cc[2], cover)
        // 复位帧矩形：copyProg 是共享的，残留上一层的子矩形会让幕布只取一格
        setFrameBasis(copyUni, null)
        // 幕布走普通 alpha 混合，同样要清掉上一层的 Screen/Multiply 预处理
        if (copyUni.blendPrep !== null && copyUni.blendPrep !== undefined) {
          gl.uniform1i(copyUni.blendPrep, 0)
        }
        gl.uniformMatrix4fv(copyUni.mvp, false, IDENT_M4)
        gl.drawArrays(gl.TRIANGLES, 0, 6)
      }
    }
    gl.bindVertexArray(null)
    pruneUnusedFbos()
  }

  // [we-scene patch] 跨层合成源：把被 `_rt_imageLayerComposite_<id>_a` 引用的对象
  // 预渲染到**各自独占**的 FBO，供引用方在自己的效果链里采样。
  //
  // WE 的「图层作为纹理」：作者把一层设成 visible:false 当纯素材（封面、遮罩），
  // 另一层引用它跑完效果链后的合成结果。全库 92 处引用 / 22 个壁纸。
  //
  // 三个必须绕开的坑（README「已知未实现」记过两次失败尝试）：
  //
  // 1. **不能共用乒乓 fboA/fboB。** 那两个按尺寸缓存、被所有图层共享，源层跑完
  //    效果链后结果还留在乒乓上，引用方进来第一件事就是 clear 它 —— 之前
  //    「让素材层照常渲染再登记 FBO」就是这么整屏全白的。这里给每个源层
  //    `getFBO(w, h, 'lc:'+id)` 独占一块：fboCache 按 `tag|WxH` 缓存，
  //    tag 唯一就不会被任何人抢走。窗口改尺寸后本帧没用到的旧尺寸会回收。
  //    前缀 `lc:` 避开效果自定义 FBO 的名字空间。
  //
  // 2. **必须绕开 visible 与 offscreen 两道门。** 源层几乎都是 visible:false
  //    （主循环第一行就 continue），且常被摆在取景外（2938612768 的三张默认封面
  //    origin 是 -418,-573）。所以这里不走主循环，直接调 renderLayer。
  //
  // 3. **必须先于引用方跑完。** 渲染顺序就是 scene.layers 数组顺序，源层完全可能
  //    排在引用方后面，所以这趟预渲染放在主循环之前。
  //
  // 用「以源层矩形为视口」的局部相机（同 renderContainerGroup 的 groupCam），
  // 并把 origin 挪到视口中心 —— 源层的世界坐标就此完全不参与，屏外也无所谓。
  async function renderCompositeSources(scene, textures, cam, width, height, time) {
    compositeFBOs.clear()
    pendingEmptyCompose.clear()
    // 扫描所有 pass 的贴图槽与 bind，收集被引用的对象 id
    const wanted = new Map() // objectId(number) → Set<完整纹理名>
    // 自引用（引用方 id === 被引用 id）的层：见下方循环里的说明，不预渲染
    const selfRefIds = new Set()
    let noteOwner = null
    const noteName = (n) => {
      if (typeof n !== 'string') return
      const m = /^_rt_imageLayerComposite_(\d+)_[a-z]$/.exec(n)
      if (!m) return
      const oid = Number(m[1])
      if (noteOwner !== null && oid === noteOwner) selfRefIds.add(oid)
      let set = wanted.get(oid)
      if (!set) { set = new Set(); wanted.set(oid, set) }
      set.add(n)
    }
    for (const layer of scene.layers || []) {
      noteOwner = layer.id
      for (const eff of layer.effects || []) {
        if (!eff.visible) continue
        // scene.json 侧的贴图槽（作者在编辑器里填的）
        for (const p of eff.passes || []) {
          for (const t of p.textures || []) noteName(t)
        }
        // effect.json 侧的 bind（binds 挂在 materialPasses 上，不是 scene 的 passes）
        for (const mp of eff.materialPasses || []) {
          for (const b of mp.binds || []) noteName(b && b.name)
          for (const t of mp.textures || []) noteName(t)
        }
      }
    }
    if (wanted.size === 0) return
    for (const [oid, names] of wanted) {
      const src = (scene.layers || []).find((l) => l.id === oid)
      if (!src || src.particle || src.isPostProcess) continue
      // [we-scene patch] **自引用**（层在自己的效果链里引用自己的合成结果）不预渲染。
      // 全库 26 处，形态是 blur / godrays 这类「取当前链上画面再叠一层」的效果
      // （1444077782 的 Fullscreen、1457581889 的 Compose、1937925563 的可视化条）。
      // 这时该给的是**当前 pass 的链输入**，也就是 resolveTextureName 的
      // inputFBO 回退路径；若在这里预渲染一份「跑完整条效果链」的副本再喂回去，
      // 整条链会被施加两遍。跳过即可，回退路径已是正解。
      if (selfRefIds.has(oid)) continue
      // [we-scene patch] **无内容的空 composelayer 不能在这里预渲染。**
      // WE 语义里 composelayer 是「捕获身后已渲染画面」的画布。本函数跑在主循环
      // 之前，画布只有 clearcolor，预渲染只会产出一张全透明图。clipping_mask
      //   albedo.rgb = ApplyBlending(mode, albedo.rgb, clip.rgb, mask * albedo.a * u_alpha)
      // 喂全透明 clip（rgb=0）会把图层混成一块**不透明色块**；回退 inputFBO
      // 则 clip≈白底三角自身，BLENDMODE 5 仍是白块。
      // 2902406982 的 8 个「三角」层引用 6 个空的「三角模块」就是这个结构。
      // 正解：登记进 pendingEmptyCompose，等主循环走到该层 z 序再
      // captureEmptyComposeAtZOrder 回读。带模型的源不受影响，仍走下方预渲染。
      const srcImage = typeof src.image === 'string' ? src.image : ''
      const isEmptyCompose = src.isContainer && !src.hasChildren &&
        srcImage.indexOf('models/util/composelayer') === 0 &&
        !(src.effects || []).some((e) => e.visible)
      if (isEmptyCompose) {
        pendingEmptyCompose.set(oid, names)
        continue
      }
      const sw = Math.max(1, Math.round(Math.abs(src.size[0] * (src.scale[0] || 1))))
      const sh = Math.max(1, Math.round(Math.abs(src.size[1] * (src.scale[1] || 1))))
      if (sw <= 1 && sh <= 1) continue
      const fbo = getFBO(sw, sh, 'lc:' + oid)
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.fbo)
      gl.viewport(0, 0, sw, sh)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      const srcCam = {
        view: cam.view,
        projection: mat4Ortho(0, sw, 0, sh, -10000, 10000),
        eye: cam.eye,
        projW: sw,
        projH: sh,
        offX: 0,
        offY: 0,
        viewW: sw,
        viewH: sh,
      }
      // groupTarget 是模块级单变量：保存/恢复而不是硬置 null，否则嵌套时会破坏外层
      const savedTarget = groupTarget
      const savedOrigin = src.origin
      const savedScale = src.scale
      const savedAngles = src.angles
      const savedVisible = src.visible
      groupTarget = { fbo, w: sw, h: sh }
      // 源层摆到视口正中、去掉自身缩放与旋转（尺寸已折进 FBO 与视口）
      src.origin = [sw / 2, srcCam.projH - sh / 2, savedOrigin[2]]
      src.scale = [Math.sign(savedScale[0]) || 1, Math.sign(savedScale[1]) || 1, savedScale[2]]
      src.angles = [0, 0, 0]
      src.visible = true
      try {
        await renderLayer(src, textures, srcCam, srcCam.projection, sw, sh, time)
        for (const n of names) compositeFBOs.set(n, fbo)
      } catch (e) {
        diag(`composite 源层 ${oid} 渲染失败: ${e && e.message}`)
      } finally {
        groupTarget = savedTarget
        src.origin = savedOrigin
        src.scale = savedScale
        src.angles = savedAngles
        src.visible = savedVisible
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, width, height)
  }

  // [we-scene patch] 组渲染目标：带子层的容器，其效果作用在**子层合成图**上。
  //
  // WE 语义：composelayer 是一块画布，子层画在画布上，容器的效果对整块画布生效。
  // 此前渲染器把这类容器整个跳过（子层已合并成世界坐标各画各的），于是容器上挂的
  // 效果一处都不生效 —— 3264246690 的三条 DANGER 胶带挂的是 scroll（speedx 0.1），
  // 表现就是胶带纹理完全静止。全库 15 个这类容器 / 9 个壁纸。
  //
  // 必须收**孙层**。childIds 只有直接孩子：3787937755 的 1361 挂 depthparallax，
  // 直接孩子只有身子 68，眼睛 1115 / 手 72 是 68 的孩子。只画直接子层时脸跟着
  // 视差走、眼睛钉在世界坐标上，看起来就像「眼睛单独随视差移动」。
  //
  // 做法：用一台「以容器为视口」的临时相机把子孙画进组 FBO，再把该 FBO 当成容器的
  // 层内容纹理走既有效果链。容器 quad 的世界变换仍由 layerModelMatrix 给出，
  // 所以组 FBO 的 0..1 uv 必须正好对应容器矩形 —— groupCam 的 projW/projH 取容器
  // 尺寸、并把容器中心平移到视口中心。
  //
  // **关键**：parse 阶段已把父级的 origin/scale/angles 合并进子层（见 parse.js 的
  // 父子层级合并），子层现在拿的是世界变换。而容器合成时会再套一次自己的变换，
  // 直接画子层等于把容器的 scale/rotate 施加两遍（实测胶带粗了一倍、倾角翻倍）。
  // 故渲染子层进组 FBO 前要先**除掉容器那一份**：位置换算到容器局部、
  // scale 除以容器 scale、angle 减去容器 angle。
  async function renderContainerGroup(container, scene, textures, cam, viewProj, width, height, time) {
    const gw = Math.max(1, Math.round(Math.abs(container.size[0])))
    const gh = Math.max(1, Math.round(Math.abs(container.size[1])))
    const kids = container.childIds || []
    if (kids.length === 0) return
    const byId = new Map()
    for (const l of scene.layers) if (l.id !== undefined) byId.set(l.id, l)
    const idSet = collectGroupDescendantIds(container, byId)
    const children = scene.layers.filter((l) => idSet.has(l.id) && l.visible)
    if (children.length === 0) return

    const groupFBO = getFBO(gw, gh, 'group')
    gl.bindFramebuffer(gl.FRAMEBUFFER, groupFBO.fbo)
    gl.viewport(0, 0, gw, gh)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)

    // 组内相机：视口 = 容器矩形（左上角为原点），世界 y-down 与主相机一致。
    const groupCam = {
      view: cam.view,
      projection: mat4Ortho(0, gw, 0, gh, -10000, 10000),
      eye: cam.eye,
      projW: gw,
      projH: gh,
      offX: 0,
      offY: 0,
      viewW: gw,
      viewH: gh,
    }
    const groupViewProj = groupCam.projection

    // 容器自身的变换（要从子层里除掉）
    const csx = container.scale[0] || 1
    const csy = container.scale[1] || 1
    const cang = container.angles[2] || 0
    const cos = Math.cos(-cang)
    const sin = Math.sin(-cang)

    groupTarget = { fbo: groupFBO, w: gw, h: gh }
    try {
      for (const child of children) {
        if (child.isPostProcess || child.particle) continue
        // 分组用的 composelayer 自己没有像素，子孙会按世界坐标单独画进同一块 FBO。
        // 把它当空层再跑一遍效果，等于在组图上盖一块空白画布。
        if (child.isContainer && (child.childIds || []).length > 0) continue
        const savedOrigin = child.origin
        const savedScale = child.scale
        const savedAngles = child.angles
        // 世界 → 容器局部：平移到容器原点、反旋转、反缩放，再放到组视口中心
        const dx = savedOrigin[0] - container.origin[0]
        const dy = savedOrigin[1] - container.origin[1]
        const rx = (dx * cos - dy * sin) / csx
        const ry = (dx * sin + dy * cos) / csy
        child.origin = [gw / 2 + rx, gh / 2 + ry, savedOrigin[2]]
        child.scale = [savedScale[0] / csx, savedScale[1] / csy, savedScale[2]]
        child.angles = [savedAngles[0], savedAngles[1], savedAngles[2] - cang]
        try {
          await renderLayer(child, textures, groupCam, groupViewProj, gw, gh, time)
        } finally {
          child.origin = savedOrigin
          child.scale = savedScale
          child.angles = savedAngles
        }
      }
    } finally {
      groupTarget = null
    }

    // 组图当作容器的层内容，走既有效果链（copy pass 会把它铺满层 FBO）
    container.groupTex = groupFBO.tex
    container.groupW = gw
    container.groupH = gh
    try {
      await renderLayer(container, textures, cam, viewProj, width, height, time)
    } finally {
      container.groupTex = null
    }
  }

  async function renderLayer(layer, textures, cam, viewProj, width, height, time) {
    // [we-scene patch] puppet 图层：几何由 MDL 网格提供，而非层 quad
    const isPuppet = !!(layer.puppet && puppetDrawFn)
    const texObj = !layer.solid && layer.textureName ? textures.get(layer.textureName) : null
    // 视频纹理层：把当前视频帧上传到 WebGL（帧时间戳变化才上传）
    if (texObj && texObj.video) {
      const v = texObj.video
      if (v.readyState >= 2 && v.currentTime !== texObj.lastUploaded) {
        gl.bindTexture(gl.TEXTURE_2D, texObj.glTex)
        try {
          // [we-scene patch] 用离屏 canvas 中转视频帧（video 直传 WebGL 在 WKWebView 可能失败）
          let vw = v.videoWidth || texObj.width
          let vh = v.videoHeight || texObj.height
          // [we-scene patch] 纹理尺寸上限。三个约束取最小：
          //   1) 硬件 MAX_TEXTURE_SIZE —— 超了 texImage2D 直接失败；
          //   2) 当前渲染目标长边 —— 上传比渲染目标更大的纹理是纯浪费，多出的
          //      像素在采样阶段就被丢掉，只白付每帧上传带宽；
          //   3) VIDEO_TEX_HARD_CAP —— 兜底，防某些驱动报了巨大的 MAX_TEXTURE_SIZE
          //      却在 4K 逐帧上传时掉帧。
          //
          // **不再**用固定 2048：那个值比典型渲染目标还小（Retina 上常见 3024
          // 甚至 3840），4K 源被降到 2048 再放大，观感明显发糊 —— 实测日志
          // `video tex ready 2048x1152 (src 3840x2160)` 就是这个损失。
          const targetMax = Math.max(width || 0, height || 0)
          const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 0
          let limit = VIDEO_TEX_HARD_CAP
          if (maxTex > 0) limit = Math.min(limit, maxTex)
          if (targetMax > 0) limit = Math.min(limit, targetMax)
          // 渲染目标异常小（首帧前 width/height 可能是 0/1）时别把纹理压成一条线
          limit = Math.max(limit, VIDEO_TEX_MIN_CAP)
          let scale = 1
          if (Math.max(vw, vh) > limit) scale = limit / Math.max(vw, vh)
          const uw = Math.max(1, Math.round(vw * scale))
          const uh = Math.max(1, Math.round(vh * scale))
          let src = v
          if (videoCanvas && uw > 0 && uh > 0) {
            if (videoCanvas.width !== uw || videoCanvas.height !== uh) {
              videoCanvas.width = uw
              videoCanvas.height = uh
            }
            const vctx = videoCanvas.getContext('2d')
            if (vctx) {
              vctx.clearRect(0, 0, uw, uh)
              vctx.drawImage(v, 0, 0, uw, uh)
              src = videoCanvas
            }
          }
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src)
          // canvas 直传失败（部分 WebView）：回退为像素数据上传
          if (gl.getError() !== gl.NO_ERROR && videoCanvas) {
            try {
              const vctx2 = videoCanvas.getContext('2d')
              const id = vctx2.getImageData(0, 0, videoCanvas.width, videoCanvas.height)
              gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, videoCanvas.width, videoCanvas.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(id.data.buffer))
              while (gl.getError() !== gl.NO_ERROR) {}
            } catch (e) { /* ignore */ }
          }
          texObj.width = uw
          texObj.height = uh
          texObj.lastUploaded = v.currentTime
          // [we-scene patch] 上传尺寸变化时重报（limit 现在跟随渲染目标，改清晰度/
          // 改窗口都会变）。只报一次会让诊断停留在首帧那个值，排错时误导。
          if (videoTexReportedSize !== uw + 'x' + uh) {
            videoTexReportedSize = uw + 'x' + uh
            videoCanvasReported = true
            diag('video tex ready ' + uw + 'x' + uh + ' (src ' + vw + 'x' + vh + ', limit ' + limit + ')')
          }
        } catch (e) {
          if (!videoCanvasReported) {
            videoCanvasReported = true
            diag('video upload FAIL: ' + ((e && e.message) || e))
          }
          console.warn('[we-scene] 视频帧上传失败:', e && e.message, 'readyState=', v.readyState, 'cur=', v.currentTime)
          // 视频帧不可用（如跨域/解码中）：保留上一帧
        }
      }
    }
    // [we-scene patch] 组渲染目标的容器：层内容 = 刚渲染好的子层合成图（groupTex）。
    const srcTex = layer.groupTex
      ? layer.groupTex
      : (texObj && texObj.glTex ? texObj.glTex : (layer.solid ? whiteTex : transparentTex))
    // [we-scene patch] passthrough：层内容 = 背后已渲染的画面（见 drawBackdropToFBO）。
    // 只对「没有自己内容」的层生效 —— 有贴图或组图时那才是层内容，
    // WE 的 passthrough 只影响空画布那一档。groupTex 走组渲染目标另一条路。
    //
    // Transparency=Preserve（combo 0）没有旗标时也走这条：shader 写 alpha=scene.a，
    // 空画布下音条不可见。见 layerWantsPreserveBackdrop。
    const usePassthrough = (!!layer.passthrough || !!layer.isPostProcess || layerWantsPreserveBackdrop(layer)) && !layer.groupTex && !texObj && !isPuppet
    // puppet 层的层内容尺寸由 size 决定（网格坐标即层局部像素），而非贴图尺寸。
    // 空内容层（容器效果画布/纯效果层，无 textureName）同理：效果链 FBO 必须
    // 按图层 size 分配，否则会退化成 1×1，波形/音频条/光效被压缩成一个像素。
    //
    // [we-scene patch] 序列帧层的「层内容」是**单帧**，不是整张 sprite sheet。
    // 用整张 sheet 的尺寸分配 FBO 会把一格拉伸铺满 —— 3299228616 的 AM/PM
    // 贴图是 22×40（上 AM 下 PM），按 40 高分配再把 22×20 的一格拉满，
    // 效果链输出的字符纵向拉伸一倍。故这里取帧尺寸。
    //
    // [we-scene patch] puppet 层的「层内容」= 它的**平面贴图**（未形变），
    // 效果链在贴图空间跑完后才交给网格采样（见 drawPuppetToFBO 位置的长注释）。
    // 贴图尺寸恒等于 layer.size（库内 5/5 实测一致），与蒙版的层矩形基准天然对齐。
    let contentW
    let contentH
    if (layer.groupTex) {
      contentW = layer.groupW || layer.size[0]
      contentH = layer.groupH || layer.size[1]
    } else if (isPuppet || !texObj) {
      contentW = layer.size[0]
      contentH = layer.size[1]
    } else {
      contentW = texObj.width
      contentH = texObj.height
    }
    if (!isPuppet && texObj && layer.spriteSheet) {
      const fl = texObj.frames
      const flist = Array.isArray(fl) ? fl : fl && fl.list
      if (flist && flist.length) {
        contentW = flist[0].width || contentW
        contentH = flist[0].height || contentH
      }
    }
    const w = Math.max(1, Math.round(contentW))
    const h = Math.max(1, Math.round(contentH))
    const color4 = [layer.color[0] * layer.brightness, layer.color[1] * layer.brightness, layer.color[2] * layer.brightness, layer.alpha]
    const effects = (layer.effects || []).filter((e) => e.visible)

    // 效果降采样（性能档位）：fboCapFactor > 0 时效果链 FBO 上限 = 屏幕占比 × 系数（0=全质量）。
    // 注意 copy pass 会把**整张贴图**铺满 fboW×fboH，所以任何缩小 FBO 的做法都是降质，
    // 不能以「屏外部分反正看不见」为理由单独裁小 —— 屏外内容同样占着贴图 UV 空间。
    // 巨型层（如 3113287126 的背景层 8289×1554）在全质量档确实按整层分配，
    // 这是全质量的既定代价；要省显存请调 fboCapFactor，而不是在这里做隐式缩减。
    let fboW = w
    let fboH = h
    if (fboCapFactor > 0 && cam.projW > 0 && cam.projH > 0) {
      // 层在屏幕上的实际占用；超出可见窗口的部分不必参与分辨率预算
      const visW = Math.min(Math.abs(layer.size[0] * layer.scale[0]), cam.viewW)
      const visH = Math.min(Math.abs(layer.size[1] * layer.scale[1]), cam.viewH)
      const screenW = visW * (width / cam.projW)
      const screenH = visH * (height / cam.projH)
      if (screenW > 0 && screenH > 0) {
        const capW = Math.max(64, Math.round(screenW * fboCapFactor))
        const capH = Math.max(64, Math.round(screenH * fboCapFactor))
        if (capW < w) fboW = capW
        if (capH < h) fboH = capH
      }
    }

    // 无效果：直接合成
    if (effects.length === 0) {
      if (isPuppet) drawPuppetDirect(layer, cam, viewProj, width, height, time)
      else {
        compositeLayer(
          copyProg, srcTex, color4, layer, cam, viewProj, width, height, false,
          spriteFrameBasis(layer, texObj, time),
        )
      }
      return
    }

    // copy pass → FBO A（乒乓 A/B 必须独立实例）
    const fboA = getFBO(fboW, fboH, 'ping')
    const fboB = getFBO(fboW, fboH, 'pong')
    const layerOrtho = mat4Ortho(0, fboW, 0, fboH, -10000, 10000)
    if (isPuppet) {
      // puppet 的效果链在贴图空间：这里走和普通图片层完全相同的 copy pass，
      // 把平面贴图铺进 FBO A；网格形变留到链尾（见文件中部那段长注释）。
      gl.useProgram(copyProg)
      setBlend('normal')
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboA.fbo)
      gl.viewport(0, 0, fboW, fboH)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.bindVertexArray(vao)
      // MDL 渲染器换过 VAO/VBO 绑定，共享的 quad 缓存键已经不可信：
      // 上一个 puppet 层若用了同尺寸的 key，uploadQuad 会直接 return，
      // 于是这一趟拿着 MDL 的顶点缓冲画 —— 表现为人物碎成一片。
      currentQuadKey = null
      uploadQuad('layer' + fboW + 'x' + fboH, layerQuad(fboW, fboH))
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, srcTex)
      gl.uniform1i(copyUni.tex, 0)
      // 颜色/亮度/alpha 留到网格那一趟乘（puppetDrawFn 自己带 u_color），
      // 这里保持直通，否则会被乘两次。
      gl.uniform4f(copyUni.color, 1, 1, 1, 1)
      setFrameBasis(copyUni, null)
      if (copyUni.blendPrep !== null && copyUni.blendPrep !== undefined) {
        gl.uniform1i(copyUni.blendPrep, 0)
      }
      gl.uniformMatrix4fv(copyUni.mvp, false, layerOrtho)
      gl.drawArrays(gl.TRIANGLES, 0, 6)
    } else if (usePassthrough) {
      // [we-scene patch] passthrough 层的「层内容」= 它背后已渲染的画面
      // （见 drawBackdropToFBO 的注释）。这类层没有自己的贴图，
      // 按空画布喂给效果链会让「rgb 与形状无关」的工坊音频 shader 糊成纯色块。
      drawBackdropToFBO(layer, fboA, fboW, fboH, cam, viewProj, width, height)
    } else {
      gl.useProgram(copyProg)
      setBlend('normal')
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboA.fbo)
      gl.viewport(0, 0, fboW, fboH)
      // 先清成透明：fboA/fboB 按尺寸缓存、被所有图层共享，上一层的内容会残留。
      // waterwaves 这类效果做 UV 位移时会采样到 quad 之外，层 FBO 是 CLAMP_TO_EDGE，
      // 于是把残留像素（solid 层缺贴图时回退的 whiteTex 尤为明显）沿边缘拉出来 ——
      // 表现就是水面倾斜幅度稍大就在边上漏出白色底色。
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.bindVertexArray(vao)
      uploadQuad('layer' + fboW + 'x' + fboH, layerQuad(fboW, fboH))
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, srcTex)
      gl.uniform1i(copyUni.tex, 0)
      // [we-scene patch] 图层材质 shader（_layerMaterial，如 workshop tint）自己吃
      // g_TintColor / 纹理色；copy 若再乘 layer.color，作者把层色设成黑（3789604238
      // Dark Revamped 的 Simple Visualizer）会在进效果链前把贴图乘成全黑，音谱消失。
      // WE 里这类 shader 往往不读 g_Color，层色本就不该在 copy 预乘。
      const copyColor = effects.some((e) => e && e.layerMaterial)
        ? [1, 1, 1, color4[3]]
        : color4
      gl.uniform4f(copyUni.color, copyColor[0], copyColor[1], copyColor[2], copyColor[3])
      // 序列帧：只采样当前帧那一格（非序列帧层为整图直通）
      setFrameBasis(copyUni, spriteFrameBasis(layer, texObj, time))
      // 层 FBO 初始 copy 是纯直通：写进 FBO 的就是纹理原样，不做 Screen/Multiply
      // 预处理。那些只在最终合成到画布时才用，留在 compositeLayer 里设置。
      if (copyUni.blendPrep !== null && copyUni.blendPrep !== undefined) {
        gl.uniform1i(copyUni.blendPrep, 0)
      }
      gl.uniformMatrix4fv(copyUni.mvp, false, layerOrtho)
      gl.drawArrays(gl.TRIANGLES, 0, 6)
    }

    // 效果链
    let curInput = fboA // 当前主 FBO（asInput）
    let curDraw = fboB // 乒乓目标
    const effectFBOs = new Map()
    let inTargetSeq = false
    let seqInput = fboA
    const flatPasses = []
    const failedEffects = new Set()
    for (const eff of effects) {
      for (const f of eff.fbos || []) {
        if (!effectFBOs.has(f.name)) {
          const [ew, eh] = effectFboSize(f, fboW, fboH)
          // unique: 每层一份历史缓冲。1444077782 挂了两个 fullscreen motionblur，
          // 同名 `_rt_FullCompoBuffer1` 若走全局缓存会串历史，第二趟读到半块白。
          const tag = f.unique ? layer.id + ':' + f.name : f.name
          effectFBOs.set(f.name, getFBO(ew, eh, tag))
        }
      }
      const passes = eff.materialPasses || []
      for (let pi = 0; pi < passes.length; pi++) {
        flatPasses.push({ eff, mp: passes[pi], ov: eff.passes && eff.passes[pi] })
      }
    }
    const chainFragGlsl = []
    for (let fi = 0; fi < flatPasses.length; fi++) {
      const { eff, mp, ov } = flatPasses[fi]
      if (failedEffects.has(eff)) continue
      const combos = { ...(mp.combos || {}), ...((ov && ov.combos) || {}) }
      // 本 pass 提供的纹理（material + scene override 合并，用于纹理关联 combo）
      const mpT = mp.textures || []
      const ovT = (ov && ov.textures) || []
      const mergedTex = []
      for (let i = 0; i < Math.max(mpT.length, ovT.length); i++) {
        if (ovT[i] !== undefined && ovT[i] !== null) mergedTex[i] = ovT[i]
        else mergedTex[i] = mpT[i] !== undefined ? mpT[i] : null
      }
      // [we-scene patch] pass 编译失败（缺失公共头/不支持的组合）时跳过**整个效果**，
      // 而不是只跳过这一个 pass。多 pass 效果的后续 pass 依赖前置 pass 写入的中间
      // target FBO（如 cursorripple 的 _rt_EightBuffer2）；只跳过失败的那个会让 combine
      // 之类的 pass 拿着没写过的 FBO 继续跑，把整层刷成纯白/花屏蒙版。
      // [we-scene patch] copy 命令 pass（`{"command":"copy","target":X,"source":Y}`）：
      // 无 material、无 shader，语义是把 source FBO 整块拷到 target FBO。
      // motionblur / audio_buffer_accumulation 靠它把「本帧累积结果」存进一个
      // unique FBO 当作下一帧的历史。不实现的后果不是少个效果，而是**画面冲白**：
      // accumulation pass 采样的历史缓冲永远是初始清零值，
      // `mix(pastAlbedo, albedo, rate)` 每帧把自己的输出又当输入，正反馈到饱和。
      if (mp.copyCommand) {
        const srcEntry = mp.source ? effectFBOs.get(mp.source) : null
        const dstEntry = mp.target ? effectFBOs.get(mp.target) : null
        if (srcEntry && dstEntry) {
          // 用 copy 程序做一次全屏拷贝（不能用 blitFramebuffer：两侧尺寸可能不同）
          gl.useProgram(compProg)
          setBlend('normal')
          gl.bindFramebuffer(gl.FRAMEBUFFER, dstEntry.fbo)
          gl.viewport(0, 0, dstEntry.width, dstEntry.height)
          gl.bindVertexArray(vao)
          uploadQuad('pass', PASS_QUAD)
          gl.activeTexture(gl.TEXTURE0)
          gl.bindTexture(gl.TEXTURE_2D, srcEntry.tex)
          gl.uniform1i(compUni.tex, 0)
          // 历史缓冲拷贝是纯直通，不需要 Screen/Multiply 预处理
          if (compUni.blendPrep !== null && compUni.blendPrep !== undefined) {
            gl.uniform1i(compUni.blendPrep, 0)
          }
          gl.uniformMatrix4fv(compUni.mvp, false, IDENT_M4)
          // PASS_QUAD 是 6 顶点 TRIANGLES 列表（第二组重复对角线那两个点）。
          // 画 TRIANGLE_STRIP 4 个顶点时第 4 个刚好是重复的 TR，第二条退化，
          // 历史缓冲只写入一块对角三角。FBO 另一半留着清零/未定义，合成到
          // 画布再经层 FBO 倒置，就是 1444077782 左侧那块硬边白三角。
          // 其余效果 pass 一律 TRIANGLES 6，copy 必须同构。
          gl.drawArrays(gl.TRIANGLES, 0, 6)
          gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        }
        continue
      }
      let progEntry
      try {
        progEntry = await getEffectProgram(mp.shader, combos, mergedTex)
      } catch (e) {
        const msg = (e && e.message) || String(e)
        // 已缓存的失败每帧每层都会再进这里；只在首次编译失败时打日志，避免刷屏拖垮 FPS 观感。
        if (!/已缓存/.test(msg)) {
          console.warn('[we-scene] 跳过效果（pass 编译失败）:', mp.shader, msg)
        }
        failedEffects.add(eff)
        continue
      }
      const prog = progEntry.prog
      const uni = progEntry.uni
      if (progEntry.fragGlsl) chainFragGlsl.push(progEntry.fragGlsl)
      // 目标与输入
      let outFBO
      let passInput
      if (mp.target) {
        if (!inTargetSeq) {
          seqInput = curInput
          inTargetSeq = true
        }
        outFBO = effectFBOs.get(mp.target) || curInput
        passInput = seqInput
      } else {
        inTargetSeq = false
        outFBO = curDraw
        passInput = curInput
      }
      gl.useProgram(prog)
      setBlend(mp.blending || 'normal')
      gl.bindFramebuffer(gl.FRAMEBUFFER, outFBO.fbo)
      gl.viewport(0, 0, outFBO.width, outFBO.height)
      gl.bindVertexArray(vao)
      // [we-scene patch] 效果 pass 顶点空间按 shader 约定二选一（判定见 getEffectProgram）：
      //   mul(MVP) 系 → 像素 quad(0..w) + 转置像素正交 MVP（WE 像素顶点语义，
      //     skew 位移 87px=层宽 34% 合理；NDC 下 87 个 NDC 直接跑出裁剪体，
      //     3470764447 Audio Bar 白块）。转置上传是 HLSL 行向量 `transpose(M)*v`
      //     的约定（同 xray 逆矩阵先例），直接喂列主元会丢平移项。
      //   NDC 直通系（gl_Position=vec4(a_Position,1)）→ NDC quad + 单位阵。
      const usePixelQuad = !progEntry.ndcDirect
      if (usePixelQuad) {
        uploadQuad('passPx' + outFBO.width + 'x' + outFBO.height, layerQuad(outFBO.width, outFBO.height))
      } else {
        uploadQuad('pass', PASS_QUAD)
      }
      const passMVP = usePixelQuad
        ? mat4Transpose(mat4Ortho(0, outFBO.width, 0, outFBO.height, -10000, 10000))
        : IDENT_M4
      // 纹理绑定
      const texNames = mp.textures || []
      const maxTex = Math.max(texNames.length, 8)
      const resolutions = new Map()
      const usedUnits = new Set()
      for (let ti = 0; ti < maxTex; ti++) {
        let name = ti < texNames.length ? texNames[ti] : null
        if (ov && ov.textures && ov.textures[ti] !== undefined && ov.textures[ti] !== null) name = ov.textures[ti]
        // bind 覆盖：定义在**每个 pass** 上（effect.json 的 passes[i].bind），
        // 由 effects-parse 存进 mp.binds。此前误读效果级的 eff.binds（恒为 undefined），
        // 使 cursorripple 这类多 pass 效果的 bind 全部失效：combine pass 的槽 1
        // 本该绑 previous（真实画面），落空后取到白纹理 → 整层被刷成纯白蒙版。
        for (const b of mp.binds || []) {
          if (b.index === ti) name = b.name
        }
        // WE 语义：槽 0 为空 = 当前输入 FBO（asInput）；'previous' 同义
        let entry
        if (ti === 0 && (name === null || name === undefined || name === '')) {
          entry = passInput
        } else {
          // [we-scene patch] 槽为空时先回退 shader 声明的默认贴图，再谈白纹理。
          // xray 的 sprite 槽（g_Texture2，`"default":"particle/halo_6"`）在 4 个壁纸里
          // 是 null —— 落白纹理会让开窗形状彻底消失（blendSample 恒 (1,1)、
          // 混合权重处处相同、画面对鼠标零响应）。
          if ((name === null || name === undefined || name === '') && progEntry.samplerDefaults) {
            const dflt = progEntry.samplerDefaults.get(ti)
            if (dflt) name = dflt
          }
          entry = resolveTextureName(name, passInput, effectFBOs, textures)
        }
        if (name === 'previous') entry = passInput
        if (entry === null) entry = { glTex: whiteTex, width: 1, height: 1, tex: whiteTex }
        const t = entry.fbo ? entry : { tex: entry.glTex || whiteTex, width: entry.width || 1, height: entry.height || 1 }
        gl.activeTexture(gl.TEXTURE0 + ti)
        gl.bindTexture(gl.TEXTURE_2D, t.tex)
        usedUnits.add(ti)
        resolutions.set(ti, [t.width, t.height, t.width, t.height])
      }
      // 系统 uniform（mvp 随 quad 空间，见上方说明）
      bindSystemUniforms(uni, layer, time, cam.projW, cam.projH, passMVP, layerOrtho, IDENT_M4, resolutions, layerOrtho, cam)
      // 常量（material 名 → uniform 映射）
      // [we-scene patch] 先跑常量脚本：带 {script} 的常量逐帧求值后才是当前值。
      // cacheKey 用 shader + pass 序号，保证同一 pass 的沙箱跨帧复用（脚本有内部状态）。
      bindConstants(
        uni,
        animatedConstants(
          scriptedConstants(
            { ...(mp.constants || {}), ...((ov && ov.constantshadervalues) || {}) },
            (layer.id || layer.name || '?') + '|' + (mp.shader || '?') + '|' + fi,
            time,
            layer,
          ),
          (layer.id || layer.name || '?') + '|' + (mp.shader || '?') + '|' + fi,
          time,
          layer,
        ),
        progEntry.matMeta,
      )
      parkXrayUntilPointer(uni)
      gl.drawArrays(gl.TRIANGLES, 0, 6)
      // 更新乒乓
      if (!mp.target) {
        const tmp = curDraw
        curDraw = curInput
        curInput = outFBO
        void tmp
      }
    }
    // [we-scene patch] 容器合成前判定「效果输出的 alpha 是否携带形状信息」。
    // 判据是最后一个 pass 的 frag 里 alpha 的写法：若只写 `alpha = scene.a`
    // （audio_ring 那类，空容器下恒为 0），alpha 无信息，rgb 必须直接叠加；
    // 若写成 `bar * opacity` / `max(scene.a, …)` 之类（Simple_Audio_Bars），
    // 形状就在 alpha 里，必须按 alpha 遮蔽，否则整块 quad 被 rgb 刷满。
    // 结果缓存在图层上供 compositeLayer 取用（见那里的详细注释）。
    // [we-scene patch] 只有「空容器效果画布」才需要那套 alpha 语义判定
    // （见 compositeLayer 的 [A]/[B] 注释）。组渲染目标的容器层内容是子层的
    // 真实 RGBA 合成图，alpha 本来就携带形状，按普通 over 合成即可 —— 走
    // premultiplied 分支会在「无信息 → 加法」判定下把胶带按加法糊上去。
    if (layer.isContainer && !layer.groupTex && !usePassthrough && layer.containerAlphaMeaningful === undefined) {
      // [we-scene patch] 必须扫**整条效果链**，不能只看最后一个 pass。
      // 2974757317 的「音频1/音频2」链是 Simple_Audio_Bars → scroll → opacity，
      // 而 scroll/opacity 都是直通效果（`gl_FragColor = albedo;`，没有 float alpha），
      // 只看末尾就取不到任何 alpha 信息 → 误判成「无信息 → 加法」→ 音频条又被
      // 刷成整块白（实测两块白色矩形）。语义上只要链上**有一个** pass 把形状写进
      // alpha，最终 FBO 的 alpha 就携带形状，就该按 alpha 合成。
      let meaningful = false
      for (const src of chainFragGlsl) {
        if (typeof src !== 'string') continue
        const m = src.match(/\bfloat\s+alpha\s*=\s*([^;]+);/)
        if (m && !/^\s*scene\s*\.\s*a\s*$/.test(m[1])) { meaningful = true; break }
      }
      layer.containerAlphaMeaningful = meaningful
      diag(`container "${layer.name || '?'}" alpha ${meaningful ? '携带形状 → SRC_ALPHA' : '无信息 → 加法'}`)
    }
    // [we-scene patch] puppet 收尾：效果链输出的是**贴图空间**的成品（丝袜已经合成
    // 在腿上、蒙版已按层矩形生效），现在才让网格采样它做形变。走的仍是无效果那条
    // drawPuppetDirect 路径，只是把采样源换成链尾 FBO。
    if (isPuppet) {
      drawPuppetDirect(layer, cam, viewProj, width, height, time, curInput.tex)
      return
    }
    // 合成。容器效果画布按上面的判定选择混合方式（见 compositeLayer 注释）
    //
    // [we-scene patch] passthrough 层绕开 [A]/[B] 那套判定：它的 FBO 里是
    // 「背景 + 效果」的**不透明**结果，按普通 over 直接盖回原位即可
    // （效果没改动的像素恰好等于原背景，视觉上零遮挡）。走 premultiplied 的
    // 加法分支会把整块背景又加一遍，画面直接过曝。
    compositeLayer(compProg, curInput.tex, [1, 1, 1, 1], layer, cam, viewProj, width, height, !!layer.isContainer && !layer.groupTex && !usePassthrough, null, null)
  }

  return {
    gl,
    render: renderScene,
    getFBO,
    getEffectProgram,
    progCache,
    shaderResolver,
    whiteTex,
    // 场景切换时清空 shader 相关缓存（避免复用上一个场景的 shader 源/程序）
    resetShaderCaches: function () {
      progCache.clear()
      includeCache.clear()
      if (shaderSrcCache) shaderSrcCache.clear()
    },
    // 运行时切换效果降采样系数（性能档位：0=全质量，1=效果链 ≤ 屏幕尺寸）
    setFboCapFactor: function (v) {
      fboCapFactor = v
    },
    // [we-scene patch] 注入粒子推进+按层渲染回调：
    //   advanceFn() — 每帧推进所有粒子系统（由宿主管理 dt 和 audio）
    //   renderByLayerFn(layerId, cam, viewProj, w, h) — 按图层渲染对应粒子系统
    setParticleRenderer: function (advanceFn, renderByLayerFn) {
      particleAdvanceFn = typeof advanceFn === 'function' ? advanceFn : null
      particleRenderByLayer = typeof renderByLayerFn === 'function' ? renderByLayerFn : null
    },
    // [we-scene patch] 注入效果常量脚本运行时：
    //   setConstantScriptRuntime(evalObjectScript, { userProperties, audioViews, shared })
    // 不注入时带 {script} 的效果常量退化为初始快照（即改动前的行为）。
    setConstantScriptRuntime: setConstantScriptRuntime,
    /** 已创建的效果常量沙箱收到 applyUserProperties（惰性缓存，挂载时可能还是空的） */
    applyConstUserProperties: function (changed) {
      if (!changed) return
      for (const sb of constScriptCache.values()) {
        if (sb && typeof sb.applyUserProperties === 'function') {
          try { sb.applyUserProperties(changed) } catch { /* 单沙箱失败不拖垮热更 */ }
        }
      }
    },
    /** [we-scene patch] 效果常量脚本的加载统计（调试出口） */
    constantScriptStats: function () {
      return { ...constScriptDiag, cached: constScriptCache.size }
    },
    /** [we-scene patch] 跨层合成的 A/B 开关（调试出口） */
    setCompositeEnabled: function (on) {
      compositeEnabled = !!on
    },
    /** [we-scene patch] 跨层合成表的调试出口：本帧解析出的 `_rt_imageLayerComposite_*` */
    compositeStats: function () {
      const out = []
      const px = new Uint8Array(4)
      for (const [name, fbo] of compositeFBOs) {
        let center = null
        try {
          gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.fbo)
          gl.readPixels(fbo.w >> 1, fbo.h >> 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
          center = [px[0], px[1], px[2], px[3]]
        } catch { }
        out.push({ name, w: fbo.w, h: fbo.h, center })
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      return out
    },
    // [we-scene patch] 注入 puppet 网格绘制回调：fn(layer, mvp, { time })
    // 由宿主用 MDL 渲染器实现；puppet 图层按自身 z 序参与图层循环与效果链。
    setPuppetRenderer: function (fn) {
      puppetDrawFn = fn
    },
    // [we-scene patch] 注入音频频谱快照源：fn() → { left16, right16, …, left64, right64 }。
    // 宿主每帧先推进模拟器/采集器再进入 render；这里是纯读取（见 render/audio.js）。
    setAudioProvider: setAudioProvider,    // [we-scene patch] 注入统一指针源：fn() → createPointerSource() 的返回值
    // （见 render/pointer.js）。渲染器从中读归一化指针喂 g_Pointer* uniform 与
    // 相机/对象视差，并在帧内回调其 syncWorld(cam, parOffX, parOffY) 把世界坐标
    // 算回去供脚本/粒子/hit-test 使用。宿主负责挂载与 dispose。
    setPointerProvider: setPointerProvider,
    // [we-scene patch] 当前帧的对象视差世界位移。hit-test 需要它把「肉眼看到的
    // 位置」换回图层世界坐标（视差场景下画面相对 cam 窗口整体平移了这么多）。
    getParallaxOffset: function () {
      return { x: layerParallaxScaleX, y: layerParallaxScaleY }
    },
    // 释放 WebGL 上下文（loseContext → 浏览器回收全部纹理/FBO/program/buffer）
    dispose: function () {
      try {
        const ext = gl.getExtension('WEBGL_lose_context')
        if (ext) ext.loseContext()
      } catch (e) { /* 忽略：无法强制释放时交给 GC 兜底 */ }
    },
  }
}


export { ALIGN, makeTexture, makeTextureMip }
