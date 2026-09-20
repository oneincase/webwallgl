// GL 公共小工具（从 renderer.js 拆出）：程序链接、shader 编译、纹理上传。
// [we-scene patch] 此前 renderer.js / mdl.js / particles.js 各有一份 compile/link
// 隐性重复（见 docs/ARCHITECTURE.md「重复代码」）；本模块是收敛的第一步——
// renderer.js 侧改用这里，mdl/particles 侧待后续轮次切换。
function linkProgram(gl, vsSrc, fsSrc) {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc)
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc)
  const p = gl.createProgram()
  gl.attachShader(p, vs)
  gl.attachShader(p, fs)
  gl.bindAttribLocation(p, 0, 'a_Position')
  gl.bindAttribLocation(p, 1, 'a_TexCoord')
  gl.linkProgram(p)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('着色器链接失败: ' + gl.getProgramInfoLog(p))
  }
  return p
}

function compile(gl, type, src) {
  const s = gl.createShader(type)
  gl.shaderSource(s, src)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error('着色器编译失败: ' + gl.getShaderInfoLog(s))
  }
  return s
}

function parseVec3Local(s) {
  // general.clearcolor 等可仍是 {user, value} 包装（resolveUserProps 就地改 .value、不拆壳）。
  // String(object) → "[object Object]" → 全 0 → 橘色 schemecolor 底变黑（3792579196）。
  if (s !== null && typeof s === 'object' && 'value' in s) s = s.value
  const p = String(s ?? '').trim().split(/\s+/).map(Number)
  return [p[0] || 0, p[1] || 0, p[2] || 0]
}

export function makeTexture(gl, rgba, width, height, bitmap = null, opts = null) {
  const tex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, tex)
  // [we-scene patch] 环绕模式：默认 CLAMP（精灵/单帧贴图 uv 恒在 0..1）。
  // 云效果（util/clouds_256）的 uv 随 g_Time 无界增长，必须 REPEAT —— CLAMP 下
  // 漂一会儿整片天空会被拉成边缘那一行（959417181）。
  const wrap = opts && opts.wrap === 'repeat' ? gl.REPEAT : gl.CLAMP_TO_EDGE
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap)
  if (bitmap) {
    // [we-scene patch] PNG/JPEG 解码出的大图（puppet 图集等）走这里。这类纹理在
    // 画布上通常被大幅缩小（3264246690 人物贴图 3658×2000 → 屏上 ~840px ≈ 4.4×
    // 缩小），LINEAR 无 mip 采样会让细线艺术（泪痕线/睫毛描边/发丝轮廓）以
    // 满幅对比度显示并带反锯齿刻线；与 makeTextureMip 对齐：trilinear + 完整
    // mip 链，缩小采样时细线按 WE 一样被淡化。
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap)
    gl.generateMipmap(gl.TEXTURE_2D)
  } else {
    // 小体积内部纹理（whiteTex 等）：保持 LINEAR，无 mip 也完整。
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba)
  }
  return tex
}

export function makeTextureMip(gl, levels, rg88 = false, opts = null) {
  const tex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, tex)
  // [we-scene patch] 环绕模式与 makeTexture 对齐：系统内置 util 贴图（噪声/云场）
  // 被效果链用无界 uv 采样，必须 REPEAT（system-textures.js 注册端统一传 repeat）
  const wrap = opts && opts.wrap === 'repeat' ? gl.REPEAT : gl.CLAMP_TO_EDGE
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  // 只上传基础级，其余 mip 用 generateMipmap 生成完整链：
  // WE 的 TEXI 容器可能只存部分 mip 级（如 5000×3000 仅 5 级），
  // 不完整的 mip 链在 WebGL 下纹理不完整 → 采样恒黑。
  const lv = levels[0]
  if (lv.bitmap) {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, lv.bitmap)
  } else if (rg88 && lv.rgba) {
    // RGBA 解码（rgb=G, a=R）→ GL_RG 上传（原始 R,G；shader .r=原始R .g=原始G，与参考实现一致）
    const n = lv.width * lv.height
    const rg = new Uint8Array(n * 2)
    for (let p = 0; p < n; p++) {
      rg[p * 2] = lv.rgba[p * 4 + 3]
      rg[p * 2 + 1] = lv.rgba[p * 4]
    }
    // [we-scene patch] RG8 每像素 2 字节，宽度为奇数时行长不是 4 的倍数；
    // 默认 UNPACK_ALIGNMENT=4 会让 GL 按 4 字节对齐算行距而读越界 →
    // INVALID_OPERATION、纹理留空（该遮罩采样恒黑，效果失真）。改为按字节对齐上传。
    const prevAlign = gl.getParameter(gl.UNPACK_ALIGNMENT)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG8, lv.width, lv.height, 0, gl.RG, gl.UNSIGNED_BYTE, rg)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, prevAlign)
  } else {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, lv.width, lv.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, lv.rgba)
  }
  gl.generateMipmap(gl.TEXTURE_2D)
  return tex
}

export { linkProgram, compile, parseVec3Local }

/**
 * [we-scene patch 2026-09-20] **压缩纹理上传**（DXT1/DXT3/DXT5/BC7/ETC1/ETC2）。
 *
 * 背景：`.tex` 里这些格式存的就是压缩块（DXT5/BC 1 B/px、DXT1 0.5 B/px），
 * 我们过去一律解成 RGBA 再上传 —— 4~8 倍的显存浪费（全库 DXT 系 5170MB → 1160MB）。
 * 这里把**文件自带的块**逐级直接上传：
 *   · 零质量损失（GPU 解出来的就是文件里的块）；
 *   · WebGL2 **不允许**对压缩纹理 generateMipmap，正好用文件里的 mip 链；
 *   · 只上传 N 级时必须把 `TEXTURE_MAX_LEVEL` 收到 N-1，否则纹理不完整（采样恒黑）。
 * 扩展不可用 / 有 POT 填充没裁干净 / 只要一级时，调用方回退到 RGBA 路径。
 */
export function makeCompressedTextureMip(gl, levels, internalFormat, opts = null) {
  const tex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, tex)
  const wrap = opts && opts.wrap === 'repeat' ? gl.REPEAT : gl.CLAMP_TO_EDGE
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  for (let i = 0; i < levels.length; i++) {
    const lv = levels[i]
    gl.compressedTexImage2D(gl.TEXTURE_2D, i, internalFormat, lv.width, lv.height, 0, lv.data)
  }
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, Math.max(0, levels.length - 1))
  return tex
}

/** 压缩格式 → { internalFormat, blockBytes }；扩展不可用时返回 null。 */
export function compressedFormatFor(gl, format) {
  const f = Number(format)
  if (f === 7) {
    const e = gl.getExtension('WEBGL_compressed_texture_s3tc')
    return e ? { internalFormat: e.COMPRESSED_RGB_S3TC_DXT1_EXT, blockBytes: 8 } : null
  }
  if (f === 6) {
    const e = gl.getExtension('WEBGL_compressed_texture_s3tc')
    return e ? { internalFormat: e.COMPRESSED_RGBA_S3TC_DXT3_EXT, blockBytes: 16 } : null
  }
  if (f === 4) {
    const e = gl.getExtension('WEBGL_compressed_texture_s3tc')
    return e ? { internalFormat: e.COMPRESSED_RGBA_S3TC_DXT5_EXT, blockBytes: 16 } : null
  }
  if (f === 12) {
    const e = gl.getExtension('WEBGL_compressed_texture_bptc')
    return e ? { internalFormat: e.COMPRESSED_RGBA_BPTC_UNORM_EXT, blockBytes: 16 } : null
  }
  // ETC1/ETC2 在 WebGL2 里是核心格式（无需扩展）
  if (f === 5) return { internalFormat: gl.COMPRESSED_RGBA8_ETC2_EAC, blockBytes: 16 }
  if (f === 3) return { internalFormat: gl.COMPRESSED_RGB8_ETC2, blockBytes: 8 }
  return null
}

/**
 * [we-scene patch 2026-09-20] **R8 单通道上传**（格式 9）。
 *
 * WE 的 R8 语义是 `vec4(1,1,1,r)`（形状在 R、rgb 补白）。过去我们把它烘成
 * RGBA（白 rgb + alpha=形状）再上传 = **4 倍显存**（全库 R8 2883MB → 721MB）。
 * 这里按 GL_R8/GL_RED 上传（1 B/px + generateMipmap），由消费端着色器做
 * `rgb = 1, alpha = .r` 的映射（粒子 shader 的 `u_albedoR8`）。
 */
export function makeR8TextureMip(gl, levels, opts = null) {
  const tex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, tex)
  const wrap = opts && opts.wrap === 'repeat' ? gl.REPEAT : gl.CLAMP_TO_EDGE
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  const lv = levels[0]
  const prev = gl.getParameter(gl.UNPACK_ALIGNMENT)
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, lv.width, lv.height, 0, gl.RED, gl.UNSIGNED_BYTE, lv.data)
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, prev)
  gl.generateMipmap(gl.TEXTURE_2D)
  return tex
}
