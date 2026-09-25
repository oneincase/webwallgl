// 像素格式编解码 + 解码入口 + 二进制小原语（从 texture.js 拆出）
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
/**
 * [we-scene patch 2026-09-20] 解出**指定 mip 级**（当独立纹理用）。
 *
 * 用途：清晰度变化时按资源倍率 R 取「够用的最小一级」——TEXB 里本来就存着 mip 链
 * （本机 3496 张贴图里 1730 张有多级），直接拿低级当 level 0 上传即可，
 * **零重采样、零画质损失**（低级就是引擎自己降的）。
 * 语义与 decodeMip0 一致（内嵌 PNG/JPEG/视频照原样透出，带 level 标记）；
 * 裁剪规则只在 level 0 生效：POT 对齐填充只出现在 level 0 的量级上，
 * 且帧表路径本来就不裁（见 decodeMip0 的长注释）。
 */
export function decodeMipLevel(tex, level) {
  const image = tex.images[0];
  if (!image || image.length === 0) throw new Error('无图像数据');
  const k = Math.max(0, Math.min(image.length - 1, Math.floor(level) || 0));
  const m = image[k];
  if (tex.isVideo) return { width: m.width, height: m.height, video: m.data, level: k };
  if (tex.freeImageFormat === FIF.PNG) return { width: m.width, height: m.height, png: m.data, level: k };
  if (tex.freeImageFormat !== FIF.UNKNOWN) {
    return { width: m.width, height: m.height, image: m.data, fif: tex.freeImageFormat, level: k };
  }
  const rgba = decodePixels(tex.format, m.data, m.width, m.height);
  // 裁剪到**内容尺寸**：`.tex` 的 mip0 常带 POT 对齐填充（1039919954：mip0 2048×2048、
  // 内容 1920×1080 在左上角）。每一级的 mip 画布同样是填充过的（1024×1024、512×512…），
  // 所以要按 2^k 折算内容尺寸再裁。**漏裁的症状**：四边形按整个填充画布采样，图像缩到
  // 左上角、右侧/下方露出 clearcolor，看起来「缩小变形」（用户 2026-09-20 报的就是这个）。
  if (!tex.frames?.list?.length) {
    const sw = Math.min(m.width, Math.max(1, Math.round((tex.width || m.width) / 2 ** k)));
    const sh = Math.min(m.height, Math.max(1, Math.round((tex.height || m.height) / 2 ** k)));
    if (m.width !== sw || m.height !== sh) {
      return { width: sw, height: sh, rgba: cropRgba(rgba, m.width, m.height, sw, sh), level: k };
    }
  }
  return { width: m.width, height: m.height, rgba, level: k };
}

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

/**
 * [we-scene patch 2026-09-20] 压缩纹理的**块级裁剪**（POT 填充 → 内容尺寸）。
 *
 * `.tex` 的 mip 画布常带 POT 对齐填充（1039919954：mip0 2048²、内容 1920×1080 在左上角）。
 * RGBA 路径可以逐像素裁，压缩路径只能按 **4×4 块**裁：目标宽高向上取整到块边界即可
 * （内容不是 4 的倍数时最多多带 1 块，约 0.2% 拉伸，肉眼不可见）。
 * 不裁的后果与 RGBA 路径漏裁一样：四边形按整个填充画布采样 → 图像缩到左上角。
 */
export function cropBlocks(data, srcW, dstW, dstH, blockBytes) {
  const sbw = Math.ceil(srcW / 4)
  const dbw = Math.ceil(dstW / 4)
  const rows = Math.ceil(dstH / 4)
  if (sbw === dbw) return data.subarray(0, dbw * rows * blockBytes)
  const out = new Uint8Array(dbw * rows * blockBytes)
  for (let r = 0; r < rows; r++) {
    const from = r * sbw * blockBytes
    out.set(data.subarray(from, from + dbw * blockBytes), r * dbw * blockBytes)
  }
  return out
}

/**
 * [we-scene patch 2026-09-25] **惰性 LZ4 mip**：压着压缩块，第一次读 `.data` 才解压并缓存。
 *
 * 为什么值：`.tex` 的 mip 链是「每级各自 LZ4」，而消费端只取**够用的最小一级**
 * （`pickMipLevel`，按图层在设备像素上的足迹算）或从 baseLevel 起截链。过去 parseTex
 * 把每一级都展开 —— 8K 贴图 mip0 解出 134MB RGBA 后直接被丢弃；全库 269/277 张是
 * 多级贴图，量级最大的那批（8K 行星贴图）每张白解压 3-5 级。
 *
 * 为什么用 getter 而不是改调用方：所有消费点读的都是 `mip.data`（decodeMip0 /
 * decodeMipLevel / 压缩直传的 `cMips[k].data` / 视频与内嵌图片分支），getter 让它们
 * **一行都不用改**，只有真被读到的层级才付解压成本。
 *
 * 附带的峰值内存收益：解压产物不再全量常驻（同一份语料解压总量 776MB，实际用到的
 * 只是其中一小部分）。
 *
 * 注意：`lz4Decompress` 本身**不要**再改写 —— 实测这份语料是 token 密集型的
 * （5900 万个 token、平均匹配 21.6 字节），逐字节循环 682ms 反而快过任何
 * `set`/`copyWithin` 版本（同 buffer 的 `set` 会走 clone 路径，1.4s = 慢一倍）。
 * 真正该省的是「解了不用的层级」，不是「每字节怎么解」。
 */
export function lazyLz4Mip(width, height, raw, uncompressedSize) {
  let cache
  const mip = { width, height, compression: 1, raw, uncompressedSize }
  Object.defineProperty(mip, "data", {
    enumerable: true,
    configurable: true,
    get() {
      if (cache === undefined) cache = lz4Decompress(raw, uncompressedSize)
      return cache
    },
  })
  return mip
}

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
