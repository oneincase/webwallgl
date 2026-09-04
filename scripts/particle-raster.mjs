// 粒子渲染的 CPU 参考光栅器（验证用，不参与运行时渲染）。
//
// 为什么需要它：浏览器里页面一转后台，rAF 被节流、画布停更，逐场景的像素测量就不可靠
// （实测整屏亮度读成 0）。而粒子的正确性恰恰集中在两处纯数值逻辑上：
//   1. 实例数据 → quad 顶点的展开（size / 非等比拉伸 / 旋转 / y 翻转 / 序列帧 uv）；
//   2. additive / translucent 两种混合的叠加结果（是否冲白、是否出现方块边）。
// 这两处都可以在 CPU 上按 shader 的公式逐字复算，得到与 GPU 一致的结论。
//
// 与 render/particles.js 的 _buildProgram 顶点/片元着色器严格对应，改 shader 时需同步改这里。
import { rgbaIsBlankWhite, spriteTrailLengthFactor, spriteTrailRotation } from '../renderer/vendor/we-scene/render/particles.js'

// 采样贴图（双线性，clamp 到边缘；与 GL_LINEAR + CLAMP_TO_EDGE 一致）
function sampleTex(tex, u, v) {
  const { width: w, height: h, rgba } = tex
  const x = u * w - 0.5
  const y = v * h - 0.5
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = x - x0
  const fy = y - y0
  const cx = (i) => (i < 0 ? 0 : i >= w ? w - 1 : i)
  const cy = (i) => (i < 0 ? 0 : i >= h ? h - 1 : i)
  const o00 = (cy(y0) * w + cx(x0)) * 4
  const o10 = (cy(y0) * w + cx(x0 + 1)) * 4
  const o01 = (cy(y0 + 1) * w + cx(x0)) * 4
  const o11 = (cy(y0 + 1) * w + cx(x0 + 1)) * 4
  const out = [0, 0, 0, 0]
  for (let c = 0; c < 4; c++) {
    const a = rgba[o00 + c] * (1 - fx) + rgba[o10 + c] * fx
    const b = rgba[o01 + c] * (1 - fx) + rgba[o11 + c] * fx
    out[c] = a * (1 - fy) + b * fy
  }
  return out
}

// 目标缓冲：Float32 RGB（0..1），便于观察 additive 叠加是否超过 1（过曝）
export function createTarget(width, height, fill) {
  const rgb = new Float32Array(width * height * 3)
  if (fill) {
    for (let i = 0; i < width * height; i++) {
      rgb[i * 3] = fill[0]
      rgb[i * 3 + 1] = fill[1]
      rgb[i * 3 + 2] = fill[2]
    }
  }
  return { width, height, rgb }
}

// 渲染一个粒子系统到目标缓冲。
// cam: { offX, offY, viewW, viewH, projH } —— 与 math.js 的 buildCamera 输出一致。
// 顶点变换逐字对应 particles.js 的顶点着色器。
export function rasterizeSystem(target, ps, cam) {
  const { width: W, height: H, rgb } = target
  const tex = ps.texture && ps.texture.pixels ? ps.texture.pixels : null
  if (!tex) return { drawn: 0, skipped: 'no texture pixels' }

  const sysScale = ps.sysScale
  // 与 particles.js 的顶点着色器一致：精灵形状 = 贴图宽高比 × 图层非等比 scale
  const stretchX = ps.spriteStretchX * (ps.texAspectX || 1)
  const stretchY = ps.spriteStretchY * (ps.texAspectY || 1)
  const cosL = Math.cos(ps.angleZ)
  const sinL = Math.sin(ps.angleZ)
  const bright = ps._ov.brightness || 1
  // 序列帧：优先真实 TEXS 帧矩形，否则按 sequencemultiplier 退回 N×N 方格
  let frames = ps.texFrames
  if (!frames && ps.sequenceMul > 1) {
    const n = ps.sequenceMul
    frames = []
    for (let r = 0; r < n; r++)
      for (let c = 0; c < n; c++) frames.push({ ou: c / n, ov: r / n, su: 1 / n, sv: 1 / n })
  }
  const additive = ps.blend === 'additive'
  const punchBlank = !!(ps.refract && rgbaIsBlankWhite(tex.rgba))
  const spriteTrail = ps.trailCfg && ps.trailCfg.kind === 'spritetrail' ? ps.trailCfg : null

  // 世界（投影空间）→ 屏幕像素
  const sx = W / cam.viewW
  const sy = H / cam.viewH
  let drawn = 0

  for (const p of ps.pool) {
    if (!p.alive) continue
    // 局部 → 世界（含图层 origin/scale/angles），y 翻转到投影空间
    const lx = p.x * ps.scaleX
    const ly = p.y * ps.scaleY
    const wx = ps.originX + lx * cosL - ly * sinL
    const wy = cam.projH - (ps.originY + lx * sinL + ly * cosL)

    let pStretchX = stretchX
    let pStretchY = stretchY
    let rot = p.rot
    if (spriteTrail) {
      const factor = spriteTrailLengthFactor(
        Math.hypot(p.vx, p.vy),
        spriteTrail.length,
        spriteTrail.minLength,
        spriteTrail.maxLength,
      )
      pStretchY = stretchY * factor
      const lx1 = (p.x + p.vx) * ps.scaleX
      const ly1 = (p.y + p.vy) * ps.scaleY
      const wx1 = ps.originX + lx1 * cosL - ly1 * sinL
      const wy1 = cam.projH - (ps.originY + lx1 * sinL + ly1 * cosL)
      rot = spriteTrailRotation(wx1 - wx, wy1 - wy)
    }

    const size = Math.abs(p.size) * sysScale
    if (!(size * pStretchX) || !(size * pStretchY)) continue
    const halfW = (size * pStretchX) / 2
    const halfH = (size * pStretchY) / 2
    const cr = Math.cos(rot)
    const sr = Math.sin(rot)
    // 旋转后的包围盒（保守放大，覆盖旋转后的四角）
    const ext = Math.hypot(halfW, halfH)

    // 屏幕范围
    const cxs = (wx - cam.offX) * sx
    const cys = (wy - cam.offY) * sy
    const rx = ext * sx
    const ry = ext * sy
    const x0 = Math.max(0, Math.floor(cxs - rx))
    const x1 = Math.min(W - 1, Math.ceil(cxs + rx))
    const y0 = Math.max(0, Math.floor(cys - ry))
    const y1 = Math.min(H - 1, Math.ceil(cys + ry))
    if (x1 < x0 || y1 < y0) continue
    drawn++

    const cr2 = p.r * bright
    const cg2 = p.g * bright
    const cb2 = p.b * bright
    const ca = p.alpha

    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        // 屏幕像素 → 投影空间 → 精灵局部（逆旋转、去拉伸）
        const dxw = px / sx + cam.offX - wx
        const dyw = py / sy + cam.offY - wy
        const ux = dxw * cr + dyw * sr
        const uy = -dxw * sr + dyw * cr
        // 归一化到 [-0.5, 0.5]（对应顶点着色器的 a_corner）
        const cu = ux / (size * pStretchX)
        const cv = uy / (size * pStretchY)
        if (cu < -0.5 || cu > 0.5 || cv < -0.5 || cv > 0.5) continue
        // corner → uv（与顶点着色器一致：不翻 v，投影空间 y 已翻）
        let u = cu + 0.5
        let v = cv + 0.5
        if (frames && frames.length) {
          // 帧矩形以左上为原点（TEXS 是 top-down 像素坐标）
          const fr = frames[Math.max(0, Math.min(frames.length - 1, p.frame | 0))]
          const cu2 = u * fr.su + fr.ou
          const cv2 = (1 - v) * fr.sv + fr.ov
          u = cu2
          v = 1 - cv2
        }
        const t = sampleTex(tex, u, v)
        // REFRACT + 空白白图：GPU 走折射；CPU 光栅没有帧缓冲可采，不能按不透明
        // 白 quad 画，否则 2464842912 Splatter Small 会在离线结果里铺满白方块。
        if (punchBlank) continue
        const ta = (t[3] / 255) * ca
        if (ta <= 0) continue
        const o = (py * W + px) * 3
        const srcR = (t[0] / 255) * cr2
        const srcG = (t[1] / 255) * cg2
        const srcB = (t[2] / 255) * cb2
        if (additive) {
          // gl.blendFunc(SRC_ALPHA, ONE)
          rgb[o] += srcR * ta
          rgb[o + 1] += srcG * ta
          rgb[o + 2] += srcB * ta
        } else {
          // gl.blendFunc(SRC_ALPHA, ONE_MINUS_SRC_ALPHA)
          rgb[o] = srcR * ta + rgb[o] * (1 - ta)
          rgb[o + 1] = srcG * ta + rgb[o + 1] * (1 - ta)
          rgb[o + 2] = srcB * ta + rgb[o + 2] * (1 - ta)
        }
      }
    }
  }
  return { drawn }
}

// 统计目标缓冲：过曝比例、平均亮度、被触及像素、空间分布、轴对齐硬边
export function analyzeTarget(target, baseFill) {
  const { width: W, height: H, rgb } = target
  const N = W * H
  const base = baseFill || [0, 0, 0]
  let sumL = 0
  let over1 = 0
  let touched = 0
  const GX = 8
  const GY = 8
  const grid = new Array(GX * GY).fill(0)
  // 轴对齐硬边：统计「相邻列亮度突变超过阈值」的长竖直连续段（方块边的特征）
  let hardEdgePixels = 0
  const lum = (o) => rgb[o] * 0.299 + rgb[o + 1] * 0.587 + rgb[o + 2] * 0.114
  const baseL = base[0] * 0.299 + base[1] * 0.587 + base[2] * 0.114
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 3
      const L = lum(o)
      sumL += L
      if (rgb[o] > 1.001 || rgb[o + 1] > 1.001 || rgb[o + 2] > 1.001) over1++
      if (Math.abs(L - baseL) > 0.02) {
        touched++
        grid[((y * GY / H) | 0) * GX + ((x * GX / W) | 0)]++
      }
      // 水平方向的陡变（贴图边缘不收敛时会出现整列的同位置突变）
      if (x > 0) {
        const dL = Math.abs(L - lum(o - 3))
        if (dL > 0.25) hardEdgePixels++
      }
    }
  }
  const nz = grid.filter((g) => g > 0).length
  const gmax = Math.max(...grid)
  return {
    avgLum: +(sumL / N).toFixed(4),
    overExposedPct: +((over1 / N) * 100).toFixed(2),
    touchedPct: +((touched / N) * 100).toFixed(2),
    gridCellsTouched: nz,
    worstCellSharePct: touched ? +((gmax / touched) * 100).toFixed(1) : 0,
    hardEdgePixels,
  }
}
