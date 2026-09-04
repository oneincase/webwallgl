// 像素格式编解码 + 解码入口 + 二进制小原语（从 texture.js 拆出）
//
// [we-scene patch] 容器解析（texture.js 的 parseTex）与像素解码是两类依赖：
// 本文件是纯数据→纯数据的编解码库（含 LZ4 解压），Node 直载。
// TEXTURE_FORMATS / FIF 是格式元数据表、u32/i32/f32 是两侧共用的小原语，
// 放在这里保持依赖单向：texture.js → tex-codecs.js，无环。
export const TEXTURE_FORMATS = {
  0: 'ARGB8888',
  1: 'RGB888',
  2: 'RGB565',
  4: 'DXT5',
  6: 'DXT3',
  7: 'DXT1',
  8: 'RG88',
  9: 'R8',
  10: 'RG1616f',
  11: 'R16f',
  12: 'BC7',
  13: 'RGBa1010102',
  14: 'RGBA16161616f',
  15: 'RGB161616f',
}

export const FIF = { UNKNOWN: -1, JPEG: 2, PNG: 13, GIF: 25, WEBP: 35, MP4: 35 }


// ---------- 解码（mip0 / mip 链 / 像素格式 → RGBA） ----------
export function decodeMip0(tex) {
  const image = tex.images[0]
  if (!image || image.length === 0) throw new Error('无图像数据')
  const m = image[0]
  if (tex.isVideo) return { width: m.width, height: m.height, video: m.data }
  if (tex.freeImageFormat === FIF.PNG) return { width: m.width, height: m.height, png: m.data }
  if (tex.freeImageFormat !== FIF.UNKNOWN) {
    return { width: m.width, height: m.height, image: m.data, fif: tex.freeImageFormat }
  }
  const rgba = decodePixels(tex.format, m.data, m.width, m.height)
  // mip0 尺寸可能是对齐填充值，裁剪到 TEXI 头部声明的实际尺寸（与 RePKG 行为一致）。
  // 有 TEXS 帧表时**不能裁**：帧坐标写在 mip0 像素空间（含 POT 填充），
  // 粒子 UV 分母必须等于实际上传的贴图。matrix spritesheet 72 是
  // mip0 512×512、声明 450×400、71 帧 50×50 —— 裁成 450 后若仍按 512 归一化，
  // 会采到邻帧碎字，掉落代码糊成一条白带（2974757317）。
  // 1444077782 更极端：声明 316×214 是单帧，mip0 才是 2048×1024 图集。
  if (!tex.frames?.list?.length && (m.width !== tex.width || m.height !== tex.height)) {
    return { width: tex.width, height: tex.height, rgba: cropRgba(rgba, m.width, m.height, tex.width, tex.height) }
  }
  return { width: m.width, height: m.height, rgba }
}

// 解码全部 mip 级别 → [{ width, height, rgba }]（PNG/JPEG 等 freeImage 格式只有一级）
export function decodeMips(tex) {
  const image = tex.images[0]
  if (!image || image.length === 0) throw new Error('无图像数据')
  const out = []
  for (const m of image) {
    if (tex.freeImageFormat !== FIF.UNKNOWN) {
      out.push({ width: m.width, height: m.height, image: m.data, fif: tex.freeImageFormat })
      continue
    }
    const rgba = decodePixels(tex.format, m.data, m.width, m.height)
    out.push({ width: m.width, height: m.height, rgba })
  }
  // 第 0 级可能带对齐填充，裁剪到声明尺寸。有 TEXS 时保持 mip0（理由见 decodeMip0）。
  if (
    !tex.frames?.list?.length &&
    out.length > 0 &&
    (out[0].width !== tex.width || out[0].height !== tex.height) &&
    out[0].rgba
  ) {
    out[0] = { width: tex.width, height: tex.height, rgba: cropRgba(out[0].rgba, out[0].width, out[0].height, tex.width, tex.height) }
  }
  return out
}

function cropRgba(rgba, sw, sh, w, h) {
  const out = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    out.set(rgba.subarray(y * sw * 4, y * sw * 4 + w * 4), y * w * 4)
  }
  return out
}

export function decodePixels(format, data, w, h) {
  switch (format) {
    case 0: return fromARGB8888(data, w, h)
    case 1: return fromRGB888(data, w, h)
    case 2: return fromRGB565(data, w, h)
    case 4: return decodeDXT5(data, w, h)
    case 6: return decodeDXT3(data, w, h)
    case 7: return decodeDXT1(data, w, h)
    case 8: return fromRG88(data, w, h)
    case 9: return fromR8(data, w, h)
    case 12: throw new Error('BC7 解码暂未实现（format=12）')
    default: throw new Error('未支持的纹理格式: ' + (TEXTURE_FORMATS[format] || format))
  }
}

function fromARGB8888(d, w, h) {
  // WE 的 "ARGB8888" 实际存储为 RGBA 字节序（与 RePKG/ImageSharp Rgba32 一致）
  return new Uint8Array(d.buffer, d.byteOffset, w * h * 4).slice()
}

function fromRGB888(d, w, h) {
  const out = new Uint8Array(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    out[i * 4] = d[i * 3]
    out[i * 4 + 1] = d[i * 3 + 1]
    out[i * 4 + 2] = d[i * 3 + 2]
    out[i * 4 + 3] = 255
  }
  return out
}

function fromRGB565(d, w, h) {
  const out = new Uint8Array(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    const c = d[i * 2] | (d[i * 2 + 1] << 8)
    const r = (c >> 11) & 0x1f
    const g = (c >> 5) & 0x3f
    const b = c & 0x1f
    out[i * 4] = (r << 3) | (r >> 2)
    out[i * 4 + 1] = (g << 2) | (g >> 4)
    out[i * 4 + 2] = (b << 3) | (b >> 2)
    out[i * 4 + 3] = 255
  }
  return out
}

function fromRG88(d, w, h) {
  // RG88 → 灰度+alpha（与 RePKG/ImageSharp 一致：灰度=第二通道 G，alpha=第一通道 R）
  const out = new Uint8Array(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    out[i * 4] = d[i * 2 + 1]
    out[i * 4 + 1] = d[i * 2 + 1]
    out[i * 4 + 2] = d[i * 2 + 1]
    out[i * 4 + 3] = d[i * 2]
  }
  return out
}

function fromR8(d, w, h) {
  const out = new Uint8Array(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    out[i * 4] = d[i]
    out[i * 4 + 1] = d[i]
    out[i * 4 + 2] = d[i]
    out[i * 4 + 3] = 255
  }
  return out
}

// ---- BC1/BC2/BC3（逐行对齐 RePKG 的 LibSquish 移植实现，保证像素级一致） ----

function decodeDXT1(d, w, h) {
  return decodeDxtCommon(d, w, h, true, 0)
}

function decodeDXT3(d, w, h) {
  return decodeDxtCommon(d, w, h, false, 3)
}

function decodeDXT5(d, w, h) {
  return decodeDxtCommon(d, w, h, false, 5)
}

function decodeDxtCommon(d, w, h, isDxt1, alphaMode) {
  const rgba = new Uint8Array(w * h * 4)
  const bytesPerBlock = isDxt1 ? 8 : 16
  const block = new Uint8Array(16)
  let src = 0
  for (let y = 0; y < h; y += 4) {
    for (let x = 0; x < w; x += 4) {
      if (src + bytesPerBlock > d.length) return rgba
      block.set(d.subarray(src, src + bytesPerBlock))
      src += bytesPerBlock
      const colors = colorCodes(block, isDxt1)
      const indices = colorIndices(block, isDxt1)
      const alphas = alphaMode === 3 ? dxt3Alphas(block) : alphaMode === 5 ? dxt5Alphas(block) : null
      for (let py = 0; py < 4; py++) {
        for (let px = 0; px < 4; px++) {
          const sx = x + px
          const sy = y + py
          if (sx >= w || sy >= h) continue
          const i = py * 4 + px
          const o = (sy * w + sx) * 4
          rgba[o] = colors[indices[i] * 4]
          rgba[o + 1] = colors[indices[i] * 4 + 1]
          rgba[o + 2] = colors[indices[i] * 4 + 2]
          rgba[o + 3] = alphas !== null ? alphas[i] : colors[indices[i] * 4 + 3]
        }
      }
    }
  }
  return rgba
}

function unpack565(block, off) {
  const value = block[off] | (block[off + 1] << 8)
  const red = (value >> 11) & 0x1f
  const green = (value >> 5) & 0x3f
  const blue = value & 0x1f
  return [
    value,
    (red << 3) | (red >> 2),
    (green << 2) | (green >> 4),
    (blue << 3) | (blue >> 2),
  ]
}

function colorCodes(block, isDxt1) {
  const colorOff = isDxt1 ? 0 : 8
  const a = unpack565(block, colorOff)
  const b = unpack565(block, colorOff + 2)
  const codes = new Uint8Array(16)
  codes[0] = a[1]
  codes[1] = a[2]
  codes[2] = a[3]
  codes[3] = 255
  codes[4] = b[1]
  codes[5] = b[2]
  codes[6] = b[3]
  codes[7] = 255
  if (isDxt1 && a[0] <= b[0]) {
    codes[8] = (a[1] + b[1]) >> 1
    codes[9] = (a[2] + b[2]) >> 1
    codes[10] = (a[3] + b[3]) >> 1
    codes[11] = 255
    codes[12] = 0
    codes[13] = 0
    codes[14] = 0
    codes[15] = 0
  } else {
    codes[8] = Math.floor((2 * a[1] + b[1]) / 3)
    codes[9] = Math.floor((2 * a[2] + b[2]) / 3)
    codes[10] = Math.floor((2 * a[3] + b[3]) / 3)
    codes[11] = 255
    codes[12] = Math.floor((a[1] + 2 * b[1]) / 3)
    codes[13] = Math.floor((a[2] + 2 * b[2]) / 3)
    codes[14] = Math.floor((a[3] + 2 * b[3]) / 3)
    codes[15] = 255
  }
  return codes
}

function colorIndices(block, isDxt1) {
  // DXT3/5 颜色块从偏移 8 开始，索引字节在 12-15；DXT1 在 4-7
  const base = isDxt1 ? 4 : 12
  const indices = new Uint8Array(16)
  for (let i = 0; i < 4; i++) {
    const packed = block[base + i]
    indices[i * 4] = packed & 0x3
    indices[i * 4 + 1] = (packed >> 2) & 0x3
    indices[i * 4 + 2] = (packed >> 4) & 0x3
    indices[i * 4 + 3] = (packed >> 6) & 0x3
  }
  return indices
}

function dxt3Alphas(block) {
  const alphas = new Uint8Array(16)
  for (let i = 0; i < 8; i++) {
    const quant = block[i]
    const lo = quant & 0x0f
    const hi = quant & 0xf0
    alphas[2 * i] = lo | (lo << 4)
    alphas[2 * i + 1] = hi | (hi >> 4)
  }
  return alphas
}

function dxt5Alphas(block) {
  const a0 = block[0]
  const a1 = block[1]
  const codes = new Uint8Array(8)
  codes[0] = a0
  codes[1] = a1
  if (a0 <= a1) {
    for (let i = 1; i < 5; i++) codes[1 + i] = Math.floor(((5 - i) * a0 + i * a1) / 5)
    codes[6] = 0
    codes[7] = 255
  } else {
    for (let i = 1; i < 7; i++) codes[i + 1] = Math.floor(((7 - i) * a0 + i * a1) / 7)
  }
  const indices = new Uint8Array(16)
  let p = 0
  for (let g = 0; g < 2; g++) {
    let value = 0
    for (let j = 0; j < 3; j++) value |= block[2 + g * 3 + j] << (8 * j)
    for (let j = 0; j < 8; j++) indices[p++] = (value >> (3 * j)) & 7
  }
  const alphas = new Uint8Array(16)
  for (let i = 0; i < 16; i++) alphas[i] = codes[indices[i]]
  return alphas
}

// ---- LZ4 块格式解压（对应 LZ4_decompress_safe） ----

export function lz4Decompress(src, outSize) {
  const out = new Uint8Array(outSize)
  let ip = 0
  let op = 0
  while (ip < src.length) {
    const token = src[ip++]
    let litLen = token >> 4
    if (litLen === 15) {
      let b
      do {
        b = src[ip++]
        litLen += b
      } while (b === 255)
    }
    for (let i = 0; i < litLen; i++) out[op++] = src[ip++]
    if (ip >= src.length) break
    const offset = src[ip] | (src[ip + 1] << 8)
    ip += 2
    let matchLen = 4 + (token & 15)
    if ((token & 15) === 15) {
      let b
      do {
        b = src[ip++]
        matchLen += b
      } while (b === 255)
    }
    const start = op - offset
    for (let i = 0; i < matchLen; i++) out[op++] = out[start + i]
  }
  return out
}

function u32(buf, p) {
  return (buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16) | (buf[p + 3] << 24)) >>> 0
}

function i32(buf, p) {
  return u32(buf, p) | 0
}

// [we-scene patch] TEXS 序列帧表的字段是 float32（帧矩形与时长）
const f32View = new DataView(new ArrayBuffer(4))
function f32(buf, p) {
  f32View.setUint8(0, buf[p])
  f32View.setUint8(1, buf[p + 1])
  f32View.setUint8(2, buf[p + 2])
  f32View.setUint8(3, buf[p + 3])
  return f32View.getFloat32(0, true)
}

export { u32, i32, f32 }
