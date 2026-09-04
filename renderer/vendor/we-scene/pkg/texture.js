// Wallpaper Engine .tex 纹理容器解析与解码
// 格式依据：linux-wallpaperengine TextureParser / RePKG（实测 TEXV0005 + TEXI0001 + TEXB0001~0004）
// [we-scene patch] 模块结构（本仓库拆分，见 docs/ARCHITECTURE.md）：
//   tex-codecs.js  格式表 + mip 解码 + 像素编解码 + LZ4 + u32/i32/f32 原语
//   texture.js     本文件：.tex 容器解析（parseTex）+ 公共出口（re-export）
import { TEXTURE_FORMATS, FIF, decodeMip0, decodeMips, decodePixels, lz4Decompress, u32, i32, f32 } from './tex-codecs.js'

export function parseTex(buf) {
  let p = 0
  const magic1 = asciiTex(buf, p, 9)
  p += 9
  if (magic1 !== 'TEXV0005\0') throw new Error('不是 .tex 文件: ' + magic1)
  const magic2 = asciiTex(buf, p, 9)
  p += 9
  if (magic2 !== 'TEXI0001\0') throw new Error('未知 TEXI 子容器: ' + magic2)

  const format = u32(buf, p)
  p += 4
  const flags = u32(buf, p)
  p += 4
  const textureWidth = u32(buf, p)
  p += 4
  const textureHeight = u32(buf, p)
  p += 4
  const width = u32(buf, p)
  p += 4
  const height = u32(buf, p)
  p += 4
  p += 4 // ignored（实测 0xFF000000，编辑器用途）

  const containerMagic = asciiTex(buf, p, 9)
  p += 9
  const imageCount = u32(buf, p)
  p += 4

  let freeImageFormat = FIF.UNKNOWN
  let containerVersion = 0
  if (containerMagic === 'TEXB0004\0') {
    freeImageFormat = u32(buf, p) | 0
    p += 4
    // [we-scene patch] 这个 u32 是 **V4 逐 mip 扩展布局的开关**，不是「是不是 mp4」。
    //
    // 原实现读成 isMp4，于是只有 `freeImageFormat === MP4` 时才按 V4 布局解析，
    // 其余一律降级 V3。但 V4 的扩展块（param1/param2 + condition JSON + param3）
    // 与图像格式毫无关系 —— 它是编辑器给单张 mip 挂「显隐条件」用的：
    // 3789790717 的 BG/GIRL/HAIRS 三张贴图各带 `{"condition":"tvoff"}`，
    // 格式却分别是 JPEG(2) 和 PNG(13)。按 V3 读会少跳过 8+22+4 = 34 字节，
    // 于是 mw/mh 读成 1/0、图像数据从 JSON 中间开始截 —— createImageBitmap 失败，
    // 图层拿不到 textureName，画面只剩 clearcolor（0.7 灰）和唯一那张 mp4 贴图。
    //
    // 全库 1902 张 .tex / 824 张 TEXB0004 实测：这个字段取 0 的 820 张、取 1 的 4 张
    // （3789790717 三张 + 3791967416 一张），无其它取值。按本字段选布局时
    // 4 张的 mipCount/mw/mh 与头部 textureWidth/Height **全部吻合**（校验失败 0 张）；
    // 按原逻辑则 4 张全部错位。
    const hasMipExtension = u32(buf, p)
    p += 4
    if (freeImageFormat === FIF.UNKNOWN && hasMipExtension === 1) freeImageFormat = FIF.MP4
    containerVersion = hasMipExtension === 1 ? 4 : 3
  } else if (containerMagic === 'TEXB0003\0') {
    freeImageFormat = u32(buf, p) | 0
    p += 4
    containerVersion = 3
  } else if (containerMagic === 'TEXB0002\0') {
    containerVersion = 2
  } else if (containerMagic === 'TEXB0001\0') {
    containerVersion = 1
  } else {
    throw new Error('未知 TEXB 容器: ' + containerMagic)
  }

  const isVideo = (flags & 32) !== 0 || freeImageFormat === FIF.MP4
  const images = []
  for (let i = 0; i < imageCount; i++) {
    const mipCount = u32(buf, p)
    p += 4
    const mips = []
    for (let m = 0; m < mipCount; m++) {
      if (containerVersion === 4) {
        p += 8 // param1/param2（编辑器参数）
        while (p < buf.length && buf[p] !== 0) p++
        p += 1 // conditionJson（null 结尾）
        p += 4 // param3
      }
      const mw = u32(buf, p)
      p += 4
      const mh = u32(buf, p)
      p += 4
      let compression = 0
      let uncompressedSize = 0
      if (containerVersion >= 2) {
        compression = u32(buf, p)
        p += 4
        uncompressedSize = i32(buf, p)
        p += 4
      }
      const compressedSize = i32(buf, p)
      p += 4
      if (isVideo) {
        // 视频纹理：byteCount 字段不可信，直接取剩余全部字节（mp4 载荷）
        mips.push({ width: mw, height: mh, compression: 0, data: buf.subarray(p) })
        p = buf.length
        continue
      }
      if (compression === 0) uncompressedSize = compressedSize
      const raw = buf.subarray(p, p + compressedSize)
      p += compressedSize
      let data = raw
      if (compression === 1) data = lz4Decompress(raw, uncompressedSize)
      mips.push({ width: mw, height: mh, compression, data })
    }
    images.push(mips)
  }

  // [we-scene patch] TEXS 序列帧表（sprite sheet）。
  // 原版解析到 TEXB 图像数据就返回，序列帧信息被丢弃 —— 于是粒子只能按
  // `sequencemultiplier` 猜一个 N×N 方格来切图。实测这个猜测是错的：
  // 雨滴贴图 `particles 256x1280 blank` 是 1280×256、5 帧**横排**，
  // 按 3×3 方格采样会取到跨帧的错位图块（雨丝呈碎片而非连续水痕）。
  //
  // 实测布局（全库 34 张带 TEXS 的贴图逐张验证过）：
  //   "TEXS000x\0" + u32 frameCount
  //   TEXS0003 额外有 u32 frameWidth + u32 frameHeight（单帧尺寸）；
  //   **TEXS0002 没有这两个字段** —— 唯一样本 1444077782/20180720153036.tex
  //   在 q+8 处解释时 736 字节除不尽 23 帧，在 q 处才恰好 32 B/帧。
  //   每帧 32 字节 = 8 个 float32，是一组**仿射 UV 基**而非 (x,y,w,h)：
  //     [imageId, duration秒, originX, originY, uDirX, uDirY, vDirX, vDirY]
  //   轴对齐帧里 uDir=(w,0)、vDir=(0,h)，于是"取 f4 当 width、f7 当 height"
  //   在 33/34 张上恰好成立；但 2623473016/Raiden Friends.tex 末 3 帧是
  //   **旋转 90° 打包**的：uDir=(0,-600)、vDir=(338,0)，按旧解释 w=h=0
  //   → 整表被 sane 校验判非法 → 81 帧全丢，那层退化成整张 8192×2048 铺满。
  //
  // 越界校验的分母必须是 **mip0 的真实像素尺寸**，不是头部的 textureWidth/Height：
  // 1444077782 头部声明 316×214（那是**单帧**尺寸），mip0 实为 2048×1024，
  // 用头部值校验会让 22/23 帧被判越界而整表丢弃。
  const mip0 = images[0] && images[0][0]
  const atlasW = mip0 ? mip0.width : textureWidth
  const atlasH = mip0 ? mip0.height : textureHeight
  let frames = null
  if (p + 13 <= buf.length) {
    const texsMagic = asciiTex(buf, p, 9)
    if (texsMagic.indexOf('TEXS') === 0) {
      let q = p + 9
      const frameCount = u32(buf, q)
      q += 4
      let frameW = 0
      let frameH = 0
      if (texsMagic === 'TEXS0003\0') {
        frameW = u32(buf, q)
        q += 4
        frameH = u32(buf, q)
        q += 4
      }
      // 每帧字节数由剩余长度反推。必须**整除**（早期版本用 floor，会把 TEXS0002
      // 的 8 字节错位吸收成 stride=31.6→31 而读出全是噪声的帧表）
      const rem = buf.length - q
      const stride = frameCount > 0 && rem > 0 && rem % frameCount === 0 ? rem / frameCount : 0
      if (frameCount > 0 && frameCount <= 4096 && stride >= 32) {
        const list = []
        for (let i = 0; i < frameCount; i++) {
          const off = q + i * stride
          if (off + 32 > buf.length) break
          const ox = f32(buf, off + 8)
          const oy = f32(buf, off + 12)
          const uX = f32(buf, off + 16)
          const uY = f32(buf, off + 20)
          const vX = f32(buf, off + 24)
          const vY = f32(buf, off + 28)
          // 轴对齐时 (width,height) 就是 (|uDir|, |vDir|)；旋转帧则交换，
          // 故一律取两个基向量的长度，并保留原始基供渲染端做仿射采样。
          list.push({
            imageId: f32(buf, off) | 0,
            duration: f32(buf, off + 4),
            x: ox,
            y: oy,
            width: Math.hypot(uX, uY) || frameW,
            height: Math.hypot(vX, vY) || frameH,
            // 仿射基（像素单位）。rotated=true 时 u 不再沿 +x，渲染端必须走
            // 「origin + s·uDir + t·vDir」而不能退化成矩形。
            uDir: [uX, uY],
            vDir: [vX, vY],
            rotated: Math.abs(uY) > 0.5 || Math.abs(vX) > 0.5,
          })
        }
        // 仅在帧的**四个角**都落在图集内时采用，否则宁可退回无序列帧
        const sane =
          list.length === frameCount &&
          list.every((f) => {
            if (!(f.width > 0 && f.height > 0)) return false
            const xs = [f.x, f.x + f.uDir[0], f.x + f.vDir[0], f.x + f.uDir[0] + f.vDir[0]]
            const ys = [f.y, f.y + f.uDir[1], f.y + f.vDir[1], f.y + f.uDir[1] + f.vDir[1]]
            return (
              Math.min(...xs) >= -1 &&
              Math.max(...xs) <= atlasW + 1 &&
              Math.min(...ys) >= -1 &&
              Math.max(...ys) <= atlasH + 1
            )
          })
        if (sane) {
          frames = {
            magic: texsMagic,
            frameWidth: frameW,
            frameHeight: frameH,
            // 帧矩形的归一化分母（渲染/粒子端都得用这个，别再用 textureWidth）
            atlasWidth: atlasW,
            atlasHeight: atlasH,
            list,
          }
        }
      }
    }
  }

  return {
    format,
    formatName: TEXTURE_FORMATS[format] || String(format),
    flags,
    textureWidth,
    textureHeight,
    width,
    height,
    freeImageFormat,
    containerMagic,
    containerVersion,
    isVideo,
    images,
    // 序列帧表；无 TEXS 段时为 null
    frames,
  }
}

// mip0 → { width, height, rgba } 或 { width, height, png } / { ..., image, fif } / { ..., video }
function asciiTex(buf, start, len) {
  let s = ''
  for (let i = start; i < start + len; i++) s += String.fromCharCode(buf[i])
  return s
}

export { TEXTURE_FORMATS, FIF, decodeMip0, decodeMips, decodePixels, lz4Decompress }
