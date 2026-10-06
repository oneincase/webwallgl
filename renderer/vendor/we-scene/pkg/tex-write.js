// [we-scene patch] .tex 编码器（EDITOR-PLAN W6-full：编辑结果导出 WE 原生 scene.pkg）。
// 只写真实语料里大量存在、且本仓 parseTex 与官方 WE 都吃的两种形态（7863 张 .tex 实测）：
//   · encodeTexImage：TEXB0004 内嵌 PNG/JPEG（format=0、flags=2、1 级 mip、不补 POT）——
//     新版 WE 导出器对「源图就是 PNG/JPG」的默认形态，字节不重编码、零画质损失；
//   · encodeTexRgba：TEXB0003 + freeImageFormat=-1 + ARGB8888（字节序实为 RGBA）+ 可选
//     LZ4 块压缩 + box 下采样 mip 链。
// 纯 Uint8Array，浏览器与 Node 通用。
import { FIF } from './tex-codecs.js'

const enc = new TextEncoder()

/** WE 贴图 flags 位：2 = clampUVs（导出器对单张图层贴图的默认值） */
export const TEX_FLAG_CLAMP = 2

class Writer {
  constructor(size) {
    this.buf = new Uint8Array(size)
    this.dv = new DataView(this.buf.buffer)
    this.p = 0
  }
  grow(n) {
    if (this.p + n <= this.buf.length) return
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.p + n))
    next.set(this.buf)
    this.buf = next
    this.dv = new DataView(next.buffer)
  }
  magic(s) {
    const b = enc.encode(s + '\0')
    this.bytes(b)
  }
  u32(v) {
    this.grow(4)
    this.dv.setUint32(this.p, v >>> 0, true)
    this.p += 4
  }
  i32(v) {
    this.grow(4)
    this.dv.setInt32(this.p, v | 0, true)
    this.p += 4
  }
  bytes(b) {
    this.grow(b.length)
    this.buf.set(b, this.p)
    this.p += b.length
  }
  done() {
    return this.buf.slice(0, this.p)
  }
}

function header(w, format, flags, texW, texH, imgW, imgH) {
  w.magic('TEXV0005')
  w.magic('TEXI0001')
  w.u32(format)
  w.u32(flags)
  w.u32(texW)
  w.u32(texH)
  w.u32(imgW)
  w.u32(imgH)
  w.u32(0)
}

/** 认图片字节的容器格式：PNG → 13、JPEG → 2，其余 -1（调用方应拒绝或转 RGBA） */
export function sniffImageFif(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return FIF.PNG
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return FIF.JPEG
  return FIF.UNKNOWN
}

/** 从 PNG IHDR / JPEG SOFn 读宽高（不解码像素）；认不出返回 null */
export function imageSize(bytes) {
  const fif = sniffImageFif(bytes)
  const be16 = (p) => (bytes[p] << 8) | bytes[p + 1]
  if (fif === FIF.PNG) {
    if (bytes.length < 24) return null
    const w = ((bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19]) >>> 0
    const h = ((bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23]) >>> 0
    return w > 0 && h > 0 ? { width: w, height: h } : null
  }
  if (fif === FIF.JPEG) {
    let p = 2
    while (p + 9 < bytes.length) {
      if (bytes[p] !== 0xff) return null
      const m = bytes[p + 1]
      if (m === 0xff) {
        p++
        continue
      }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
        p += 2
        continue
      }
      const isSof = m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc
      if (isSof) {
        const h = be16(p + 5)
        const w = be16(p + 7)
        return w > 0 && h > 0 ? { width: w, height: h } : null
      }
      p += 2 + be16(p + 2)
    }
  }
  return null
}

/**
 * PNG/JPEG 原字节包成 .tex（TEXB0004，不补 POT）。
 * @param {{ bytes: Uint8Array, width: number, height: number, flags?: number }} o
 */
export function encodeTexImage(o) {
  const fif = sniffImageFif(o.bytes)
  if (fif === FIF.UNKNOWN) throw new Error('encodeTexImage: 只接受 PNG / JPEG 字节')
  const { width, height } = o
  if (!(width > 0 && height > 0)) throw new Error('encodeTexImage: 尺寸无效')
  const w = new Writer(o.bytes.length + 128)
  header(w, 0, o.flags ?? TEX_FLAG_CLAMP, width, height, width, height)
  w.magic('TEXB0004')
  w.u32(1)
  w.i32(fif)
  w.u32(0) // hasMipExtension
  w.u32(1) // mipCount
  w.u32(width)
  w.u32(height)
  w.u32(0) // compression
  w.i32(o.bytes.length)
  w.i32(o.bytes.length)
  w.bytes(o.bytes)
  return w.done()
}

/** RGBA 半尺寸 box 下采样（奇数边取边缘像素补齐） */
function halve(rgba, w, h) {
  const nw = Math.max(1, w >> 1)
  const nh = Math.max(1, h >> 1)
  const out = new Uint8Array(nw * nh * 4)
  for (let y = 0; y < nh; y++) {
    const y0 = Math.min(h - 1, y * 2)
    const y1 = Math.min(h - 1, y * 2 + 1)
    for (let x = 0; x < nw; x++) {
      const x0 = Math.min(w - 1, x * 2)
      const x1 = Math.min(w - 1, x * 2 + 1)
      const a = (y0 * w + x0) * 4
      const b = (y0 * w + x1) * 4
      const c = (y1 * w + x0) * 4
      const d = (y1 * w + x1) * 4
      const o = (y * nw + x) * 4
      for (let k = 0; k < 4; k++) out[o + k] = (rgba[a + k] + rgba[b + k] + rgba[c + k] + rgba[d + k] + 2) >> 2
    }
  }
  return { rgba: out, w: nw, h: nh }
}

/**
 * RGBA 像素编成 ARGB8888 .tex（TEXB0003，fif=-1）。
 * @param {{ rgba: Uint8Array, width: number, height: number, mips?: boolean, lz4?: boolean, flags?: number }} o
 */
export function encodeTexRgba(o) {
  const { width, height } = o
  if (!(width > 0 && height > 0) || o.rgba.length !== width * height * 4) throw new Error('encodeTexRgba: 像素长度与尺寸不符')
  const levels = [{ rgba: o.rgba, w: width, h: height }]
  if (o.mips !== false) {
    while (levels.length < 12) {
      const last = levels[levels.length - 1]
      if (last.w === 1 && last.h === 1) break
      levels.push(halve(last.rgba, last.w, last.h))
    }
  }
  const lz4 = o.lz4 !== false
  const w = new Writer(o.rgba.length + 256)
  header(w, 0, o.flags ?? TEX_FLAG_CLAMP, width, height, width, height)
  w.magic('TEXB0003')
  w.u32(1)
  w.i32(FIF.UNKNOWN)
  w.u32(levels.length)
  for (const l of levels) {
    const packed = lz4 ? lz4CompressBlock(l.rgba) : l.rgba
    w.u32(l.w)
    w.u32(l.h)
    w.u32(lz4 ? 1 : 0)
    w.i32(l.rgba.length)
    w.i32(packed.length)
    w.bytes(packed)
  }
  return w.done()
}

/**
 * LZ4 块格式压缩（无帧头；与 tex-codecs lz4Decompress 对偶）。贪心单哈希表匹配，
 * 遵守块格式尾部约束：最后 5 字节恒为字面量、距末尾 12 字节内不起匹配。
 */
export function lz4CompressBlock(src) {
  const n = src.length
  const out = new Uint8Array(n + ((n / 255) | 0) + 16)
  const HASH_LOG = 16
  const table = new Int32Array(1 << HASH_LOG).fill(-1)
  const mfLimit = n - 12
  const matchEnd = n - 5
  const read32 = (i) => (src[i] | (src[i + 1] << 8) | (src[i + 2] << 16) | (src[i + 3] << 24)) >>> 0
  let op = 0
  let anchor = 0
  let ip = 0
  const writeLen = (r) => {
    while (r >= 255) {
      out[op++] = 255
      r -= 255
    }
    out[op++] = r
  }
  while (ip < mfLimit) {
    const v = read32(ip)
    const h = Math.imul(v, 2654435761) >>> (32 - HASH_LOG)
    const ref = table[h]
    table[h] = ip
    if (ref < 0 || ip - ref > 65535 || read32(ref) !== v) {
      ip++
      continue
    }
    let len = 4
    while (ip + len < matchEnd && src[ref + len] === src[ip + len]) len++
    const litLen = ip - anchor
    const tokenPos = op++
    let token = litLen >= 15 ? 0xf0 : litLen << 4
    if (litLen >= 15) writeLen(litLen - 15)
    out.set(src.subarray(anchor, ip), op)
    op += litLen
    const off = ip - ref
    out[op++] = off & 255
    out[op++] = off >> 8
    const ml = len - 4
    if (ml >= 15) {
      token |= 15
      writeLen(ml - 15)
    } else token |= ml
    out[tokenPos] = token
    ip += len
    anchor = ip
  }
  const litLen = n - anchor
  out[op++] = litLen >= 15 ? 0xf0 : litLen << 4
  if (litLen >= 15) writeLen(litLen - 15)
  out.set(src.subarray(anchor), op)
  op += litLen
  return out.slice(0, op)
}
