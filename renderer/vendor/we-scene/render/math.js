// 最小 4x4 矩阵库（列主序，与 WebGL 一致）
export function mat4Identity() {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
}

export function mat4Multiply(a, b) {
  const out = new Float32Array(16)
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]
      out[c * 4 + r] = s
    }
  }
  return out
}

// 正交投影（世界 y 向下：top=0, bottom=height）
export function mat4Ortho(left, right, top, bottom, near, far) {
  const out = mat4Identity()
  out[0] = 2 / (right - left)
  out[5] = 2 / (bottom - top)
  out[10] = -2 / (far - near)
  out[12] = -(right + left) / (right - left)
  out[13] = -(bottom + top) / (bottom - top)
  out[14] = -(far + near) / (far - near)
  return out
}

export function mat4Translate(m, x, y, z) {
  return mat4Multiply(m, new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]))
}

// [we-scene patch] 4×4 转置（列主序）。
// 用途：WE 的 shader 是 HLSL 行向量语义（`mul(向量, 矩阵)`），hlsl2glsl 统一改写成
// `transpose(M) * 向量`。所以宿主要喂给这类 uniform 的必须是**转置后**的矩阵，
// 让 shader 里那个 transpose 抵消掉。直接喂逆矩阵会让平移项搬错位置
// （xray 实测齐次 w 从 1 变成 -613，开窗被钉死在画面中心）。
export function mat4Transpose(m) {
  const o = new Float32Array(16)
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) o[c * 4 + r] = m[r * 4 + c]
  return o
}

// [we-scene patch] 通用 4×4 求逆（列主序，与本文件其余矩阵一致）。
// 用途：g_EffectTextureProjectionMatrixInverse —— 全库 16 个指针 shader 声明它，
// 用来把归一化指针反投影回图层局部 UV（`mul(vec4(pointer*2-1,0,1), 该矩阵).xyw`
// 再做透视除法）。改动前该 uniform 从未绑定、恒为零矩阵，反投影结果塌成
// vec3(0) 再除零 —— cursorripple / iris_follow_cursor / juguangdeng 全部失效。
// 奇异矩阵返回单位矩阵（而非 NaN 矩阵）：宁可退化成「无反投影」，
// 也不要把 NaN 灌进顶点着色器让整层消失。
export function mat4Invert(m) {
  const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3]
  const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7]
  const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11]
  const a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15]
  const b00 = a00 * a11 - a01 * a10
  const b01 = a00 * a12 - a02 * a10
  const b02 = a00 * a13 - a03 * a10
  const b03 = a01 * a12 - a02 * a11
  const b04 = a01 * a13 - a03 * a11
  const b05 = a02 * a13 - a03 * a12
  const b06 = a20 * a31 - a21 * a30
  const b07 = a20 * a32 - a22 * a30
  const b08 = a20 * a33 - a23 * a30
  const b09 = a21 * a32 - a22 * a31
  const b10 = a21 * a33 - a23 * a31
  const b11 = a22 * a33 - a23 * a32
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06
  if (!det || !Number.isFinite(det)) return mat4Identity()
  const d = 1 / det
  return new Float32Array([
    (a11 * b11 - a12 * b10 + a13 * b09) * d,
    (a02 * b10 - a01 * b11 - a03 * b09) * d,
    (a31 * b05 - a32 * b04 + a33 * b03) * d,
    (a22 * b04 - a21 * b05 - a23 * b03) * d,
    (a12 * b08 - a10 * b11 - a13 * b07) * d,
    (a00 * b11 - a02 * b08 + a03 * b07) * d,
    (a32 * b02 - a30 * b05 - a33 * b01) * d,
    (a20 * b05 - a22 * b02 + a23 * b01) * d,
    (a10 * b10 - a11 * b08 + a13 * b06) * d,
    (a01 * b08 - a00 * b10 - a03 * b06) * d,
    (a30 * b04 - a31 * b02 + a33 * b00) * d,
    (a21 * b02 - a20 * b04 - a23 * b00) * d,
    (a11 * b07 - a10 * b09 - a12 * b06) * d,
    (a00 * b09 - a01 * b07 + a02 * b06) * d,
    (a31 * b01 - a30 * b03 - a32 * b00) * d,
    (a20 * b03 - a21 * b01 + a22 * b00) * d,
  ])
}

export function mat4Scale(m, sx, sy, sz) {
  return mat4Multiply(m, new Float32Array([sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, 0, 0, 0, 1]))
}

export function mat4RotateZ(m, rad) {
  const c = Math.cos(rad)
  const s = Math.sin(rad)
  return mat4Multiply(m, new Float32Array([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]))
}

export function mat4RotateX(m, rad) {
  const c = Math.cos(rad)
  const s = Math.sin(rad)
  return mat4Multiply(m, new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]))
}

export function mat4RotateY(m, rad) {
  const c = Math.cos(rad)
  const s = Math.sin(rad)
  return mat4Multiply(m, new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]))
}

// 透视投影（Y-up，OpenGL clip z ∈ [-1,1]）。fovy 是竖向视角，单位度。
export function mat4Perspective(fovyDeg, aspect, near, far) {
  const f = 1 / Math.tan(((fovyDeg * Math.PI) / 180) / 2)
  const out = new Float32Array(16)
  out[0] = f / (aspect || 1)
  out[5] = f
  out[10] = (far + near) / (near - far)
  out[11] = -1
  out[14] = (2 * far * near) / (near - far)
  return out
}

function numField(v, dflt) {
  const r = v && typeof v === 'object' ? v.value : v
  return typeof r === 'number' && Number.isFinite(r) ? r : dflt
}

// 有 fov、没有 orthogonalprojection = 真 3D 透视场景。
// 全库目前只有 3509243656。2D 场景即使写了 fov（编辑器残留）也带正交投影，必须走正交。
export function isPerspectiveScene(scene) {
  const g = scene && scene.general
  if (!g || g.orthogonalprojection) return false
  return numField(g.fov, 0) > 0
}

// 透视天空盒必须包住相机。作者常把盒放在原点（3509243656 scale 8×12×8、
// 网格约 ±1 → 世界半边长 8），相机却在 z≈10（盒外）。从外面只能看到 +Z
// 外壁一块球面，星空铺不满、边缘还拉丝。经典做法：平移锁到 eye，只留层旋转。
// 2D / 非天空盒仍用 layer.origin。天空盒不参与点击，hittest 不必跟这条。
export function layerWorldOrigin(layer, cam) {
  if (cam && cam.perspective && layer && layer.isSkybox && cam.eye) return cam.eye
  return layer.origin
}

export function mat4LookAt(eye, center, up) {
  const z = normalize([eye[0] - center[0], eye[1] - center[1], eye[2] - center[2]])
  const x = normalize(cross(up, z))
  const y = cross(z, x)
  const out = new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, 0, 0, 0, 1])
  out[12] = -(x[0] * eye[0] + x[1] * eye[1] + x[2] * eye[2])
  out[13] = -(y[0] * eye[0] + y[1] * eye[1] + y[2] * eye[2])
  out[14] = -(z[0] * eye[0] + z[1] * eye[1] + z[2] * eye[2])
  return out
}

export function mat4TransformPoint(m, x, y, z) {
  const w = m[3] * x + m[7] * y + m[11] * z + m[15]
  return [
    (m[0] * x + m[4] * y + m[8] * z + m[12]) / w,
    (m[1] * x + m[5] * y + m[9] * z + m[13]) / w,
    (m[2] * x + m[6] * y + m[10] * z + m[14]) / w,
  ]
}

// 超宽场景常见的设计比例（3264246690 标题 16:9 / 16:10 / 21:9 / 32:9）。
// 窗口已经是其中某一个时，按设计高度满幅对齐，不要用略偏的像素比再裁一刀顶底。
export const DESIGN_ASPECTS = [
  [16, 9],
  [16, 10],
  [21, 9],
  [32, 9],
]

/**
 * 窗口宽高比若贴上设计比例或场景正交比，返回该比例下的可见窗口；否则 null。
 * 相对误差 2%：能吃掉 DPR 取整（1920×1081），分得清 16:9 和 16:10（差约 10%）。
 */
export function matchDesignAspect(width, height, projW, projH, relTol) {
  const a = width / height
  if (!Number.isFinite(a) || a <= 0 || !(projW > 0) || !(projH > 0)) return null
  const tol = relTol > 0 ? relTol : 0.02
  const design = projW / projH
  if (Math.abs(a - design) <= tol * design) {
    return { viewW: projW, viewH: projH }
  }
  for (const [rw, rh] of DESIGN_ASPECTS) {
    const r = rw / rh
    if (Math.abs(a - r) > tol * r) continue
    const viewH = projH
    const viewW = projH * r
    if (viewW > projW + 1e-6) {
      return { viewW: projW, viewH: projW / r }
    }
    return { viewW, viewH }
  }
  return null
}

/**
 * cover 窥视（顶/底热区滑动）的逐轴门控。
 *
 * 适配只该发生在「内容在那个轴上真的被裁掉」时。1920911984 这类壁纸：投影画布
 * 是竖的（1080×5760），内容却是一根旋转 90° 的横条（世界包围盒 3254×610）——
 * 按画布算 cover 纵向溢出 5000+，热区滑动会把视窗滑出条外（整屏空白）；
 * 按内容包围盒算纵向根本没溢出（610 ≈ 视窗 607）。所以这里吃**内容包围盒**
 * 与 cover 视窗尺寸，返回每个轴是否允许滑动。容差 2%：吃得下 DPR 取整与
 * 旋转包围盒的 ±1px 量化，1920911984 的 610/607.5（+0.4%）判为不溢出。
 * 纯函数，verify-cover-peek 直接跑。
 */
export function coverPeekOverflow(contentW, contentH, viewW, viewH, relTol) {
  const tol = relTol > 0 ? relTol : 0.02
  const overflow = (content, view) =>
    Number.isFinite(content) && Number.isFinite(view) && view > 0 ? content > view * (1 + tol) : true
  return {
    x: overflow(contentW, viewW),
    y: overflow(contentH, viewH),
  }
}

/** cover 视窗的世界尺寸（fit=cover，与 fitWindow 主路径同一公式，给窥视门控用） */
export function coverViewSize(projW, projH, width, height) {
  if (!(projW > 0) || !(projH > 0) || !(width > 0) || !(height > 0)) return null
  const scale = Math.max(width / projW, height / projH)
  return { viewW: width / scale, viewH: height / scale }
}

/**
 * 可见图层的世界包围盒（旋转矩形取 AABB 并集），cover 窥视门控的内容基准。
 * layers 是 parse 产出的层（visible 已折叠父链；origin/scale/angles 为 world 值）。
 * 只统计「会画出来」的层：visible:false / destroyed / 零尺寸跳过。
 * 返回 {minX,minY,maxX,maxY}；没有任何可见层时各分量为 Infinity/-Infinity。
 */
export function coverContentBounds(layers) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const l of layers || []) {
    if (!l || l.visible === false || l.destroyed) continue
    const w = Math.abs((l.size?.[0] ?? 0) * (l.scale?.[0] ?? 1))
    const h = Math.abs((l.size?.[1] ?? 0) * (l.scale?.[1] ?? 1))
    if (!(w > 0) && !(h > 0)) continue
    const az = Number(l.angles?.[2] ?? 0) || 0
    const cos = Math.abs(Math.cos(az))
    const sin = Math.abs(Math.sin(az))
    const ew = w * cos + h * sin
    const eh = w * sin + h * cos
    const cx = Number(l.origin?.[0] ?? 0) || 0
    const cy = Number(l.origin?.[1] ?? 0) || 0
    minX = Math.min(minX, cx - ew / 2)
    maxX = Math.max(maxX, cx + ew / 2)
    minY = Math.min(minY, cy - eh / 2)
    maxY = Math.max(maxY, cy + eh / 2)
  }
  return { minX, minY, maxX, maxY }
}

// 场景默认相机（WE 2D 约定：世界坐标 = 像素，y 向下）
// 注意：2D 正交场景渲染时忽略 scene.json 的 eye/center/up（那是编辑器最后保存的相机状态，运行时不用），使用固定相机
// 根据显示模式计算「可见窗口」：把场景设计尺寸（projW×projH）映射到屏幕（width×height）时，
// 用统一的等比缩放，避免 16:9 内容在 16:10 屏幕上被拉伸。
//   cover():  以较大缩放铺满并裁切溢出（无黑边、不变形，桌面壁纸默认）。
//             窗口已是 16:9/16:10/21:9/32:9（或场景自身比例）时，按设计尺寸对齐，不再裁顶底。
//             默认居中；alignX/alignY∈[0,1] 把窗口滑向被裁的那一侧（竖屏顶/底预览）。
//   contain():以较小缩放完整显示并居中留边（黑边由 clearColor 填充）。
//   stretch()/其他：保持原行为，忽略宽高比铺满（会拉伸变形）。
export function fitWindow(fit, projW, projH, width, height, alignX, alignY) {
  // align 0=顶/左、0.5=居中、1=底/右。缺省 0.5 与旧行为逐字相同。
  // 仅 cover 有溢出可滑；contain/stretch 无裁切，忽略 align。
  const ax = clamp01(alignX)
  const ay = clamp01(alignY)
  if (fit === 'cover') {
    const matched = matchDesignAspect(width, height, projW, projH)
    if (matched) {
      return {
        offX: (projW - matched.viewW) * ax,
        offY: (projH - matched.viewH) * ay,
        viewW: matched.viewW,
        viewH: matched.viewH,
      }
    }
    const scale = Math.max(width / projW, height / projH)
    const viewW = width / scale
    const viewH = height / scale
    return { offX: (projW - viewW) * ax, offY: (projH - viewH) * ay, viewW, viewH }
  }
  if (fit === 'contain') {
    const screenAspect = width / height
    const contentAspect = projW / projH
    if (contentAspect > screenAspect) {
      // 内容更宽：宽对齐、加高窗口以完整显示场景（上下留边）
      const viewW = projW
      const viewH = projW / screenAspect
      return { offX: 0, offY: (projH - viewH) / 2, viewW, viewH }
    }
    // 内容更高：高对齐、加宽窗口以完整显示场景（左右留边）
    const viewH = projH
    const viewW = projH * screenAspect
    return { offY: 0, offX: (projW - viewW) / 2, viewW, viewH }
  }
  // stretch（或未识别模式）：显示整个场景，交给 viewport 拉伸
  return { offX: 0, offY: 0, viewW: projW, viewH: projH }
}

export function buildCamera(scene, width, height, fit, alignX, alignY) {
  const general = scene.general
  const cam = scene.camera
  const eyeV = cam && cam.eye ? parseVec(cam.eye) : [0, 0, 0]
  const centerV = cam && cam.center ? parseVec(cam.center) : [0, 0, -1]
  const upV = cam && cam.up ? parseVec(cam.up) : [0, 1, 0]
  // [we-scene patch] 3509243656（三体）是全库唯一「fov 有、orthogonalprojection 无」
  // 的场景。改动前这里算了 lookAt，投影却永远是像素正交：世界单位 ≈ 1 的星星
  // 被当成 1 个像素画在画布角落，画面只剩黑底。正交场景（带 orthogonalprojection）
  // 仍忽略 eye/center —— 那是编辑器视口，运行时不用。
  if (isPerspectiveScene(scene)) {
    const aspect = height > 0 ? width / height : 16 / 9
    const fov = numField(general.fov, 50)
    const near = Math.max(numField(general.nearz, 0.01), 1e-4)
    const far = Math.max(numField(general.farz, 10000), near + 1)
    const view = mat4LookAt(eyeV, centerV, upV)
    const projection = mat4Perspective(fov, aspect, near, far)
    return {
      view,
      projection,
      eye: eyeV,
      center: centerV,
      projW: aspect,
      projH: 1,
      offX: 0,
      offY: 0,
      viewW: aspect,
      viewH: 1,
      perspective: true,
    }
  }
  const view = mat4Identity()
  const projW = general && general.orthogonalprojection ? general.orthogonalprojection.width || width : width
  const projH = general && general.orthogonalprojection ? general.orthogonalprojection.height || height : height
  // 世界 y 向下：y=0 → NDC +1（屏幕顶）。ortho(left, right, top, bottom)
  const win = fitWindow(fit, projW, projH, width, height, alignX, alignY)
  // [we-scene patch] 脚本 thisScene.setCameraTransforms({zoom}) 叠在 fit 窗口上。
  // zoom=1.01（3151551777 火车震动）= 视口缩小 1%、画面略放大。zoom=1 是无操作，
  // 不改 cover/contain 的既有窗口，也不碰 16:9 设计比例匹配。
  const zRaw = scene && scene.cameraTransforms ? scene.cameraTransforms.zoom : (general && general.zoom)
  const zVal = zRaw && typeof zRaw === 'object' ? zRaw.value : zRaw
  const zoom = Number(zVal)
  if (Number.isFinite(zoom) && zoom > 0 && Math.abs(zoom - 1) > 1e-6) {
    const cx = win.offX + win.viewW / 2
    const cy = win.offY + win.viewH / 2
    const vw = win.viewW / zoom
    const vh = win.viewH / zoom
    win.offX = cx - vw / 2
    win.offY = cy - vh / 2
    win.viewW = vw
    win.viewH = vh
  }
  const projection = mat4Ortho(win.offX, win.offX + win.viewW, win.offY + win.viewH, win.offY, -10000, 10000)
  return { view, projection, eye: eyeV, projW, projH, offX: win.offX, offY: win.offY, viewW: win.viewW, viewH: win.viewH, perspective: false }
}

function clamp01(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0.5
  return n < 0 ? 0 : n > 1 ? 1 : n
}

function parseVec(s) {
  return String(s).trim().split(/\s+/).map(Number)
}

function normalize(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

// 对象视差深度系数。线性 d/2：
//   |d|=1 时与旧饱和函数 d/(1+|d|) 同为 0.5，depth=0 仍钉住；
//   大 depth 按作者写的比例走（2802243144 文字 pd=25 vs 鸟 pd≈1.75 ≈ 14 倍），
//   不再被饱和压成几乎同一位移。不要给文字层另乘固定倍数。
export function parallaxDepthFactor(d) {
  const n = Number(d)
  return Number.isFinite(n) ? n * 0.5 : 0
}
