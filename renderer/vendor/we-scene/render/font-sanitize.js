// 修 Chrome OTS 拒载的残缺 TTF：cmap format 4 的 binary-search 三元组写错。
//
// 症状：FontFace.load() → `OTS parsing error: cmap: unexpected range shift (5 != 6)`，
// 字体回落系统黑体，字宽/字高与作者设计的 Tourner 等完全不同，时钟分秒叠进小时
// （2780710296「最大视差」下的文字布局错乱其实是字体没装上）。
//
// 全库约 200 个内嵌 ttf 里目前 5 个踩中，全是 Tourner 变体：rangeShift 少算 1。
// 桌面 WE 不跑 OTS，照样能开；浏览器必须先改对再喂 FontFace。
//
// 改完 cmap 后必须重算该表 checksum（目录项），否则 OTS 仍会拒。

/**
 * @param {Uint8Array} src
 * @returns {Uint8Array} 原样或已修补的独立副本
 */
export function sanitizeFontForBrowser(src) {
  if (!src || src.length < 12) return src
  // TTF/OTF 以 version 起头：\0\1\0\0 / OTTO / true / typ1
  const b0 = src[0], b1 = src[1], b2 = src[2], b3 = src[3]
  const isTtf = b0 === 0 && b1 === 1 && b2 === 0 && b3 === 0
  const isOtto = b0 === 0x4f && b1 === 0x54 && b2 === 0x54 && b3 === 0x4f // OTTO
  if (!isTtf && !isOtto) return src

  const out = Uint8Array.from(src)
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength)
  const numTables = dv.getUint16(4)
  if (numTables <= 0 || 12 + numTables * 16 > out.length) return src

  let cmapEntry = -1
  let cmapOffset = 0
  let cmapLength = 0
  for (let i = 0; i < numTables; i++) {
    const e = 12 + i * 16
    const tag = String.fromCharCode(out[e], out[e + 1], out[e + 2], out[e + 3])
    if (tag === 'cmap') {
      cmapEntry = e
      cmapOffset = dv.getUint32(e + 8)
      cmapLength = dv.getUint32(e + 12)
      break
    }
  }
  if (cmapEntry < 0 || cmapOffset + cmapLength > out.length) return src

  let changed = false
  const numEnc = dv.getUint16(cmapOffset + 2)
  for (let i = 0; i < numEnc; i++) {
    const rec = cmapOffset + 4 + i * 8
    const soff = dv.getUint32(rec + 4)
    const abs = cmapOffset + soff
    if (abs + 14 > out.length) continue
    if (dv.getUint16(abs) !== 4) continue // format 4
    const segCountX2 = dv.getUint16(abs + 6)
    const segCount = segCountX2 >>> 1
    if (segCount < 1) continue
    const expSearch = 2 * Math.pow(2, Math.floor(Math.log2(segCount)))
    const expSel = Math.floor(Math.log2(segCount))
    const expShift = segCountX2 - expSearch
    const curSearch = dv.getUint16(abs + 8)
    const curSel = dv.getUint16(abs + 10)
    const curShift = dv.getUint16(abs + 12)
    if (curSearch === expSearch && curSel === expSel && curShift === expShift) continue
    dv.setUint16(abs + 8, expSearch)
    dv.setUint16(abs + 10, expSel)
    dv.setUint16(abs + 12, expShift)
    changed = true
  }
  if (!changed) return src

  // 重算 cmap 表 checksum（含尾部 0 填充到 4 字节对齐）
  let sum = 0
  const end = cmapOffset + cmapLength
  for (let p = cmapOffset; p < end; p += 4) {
    const b0 = out[p] || 0
    const b1 = p + 1 < end ? out[p + 1] : 0
    const b2 = p + 2 < end ? out[p + 2] : 0
    const b3 = p + 3 < end ? out[p + 3] : 0
    sum = (sum + ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3)) >>> 0
  }
  dv.setUint32(cmapEntry + 4, sum)
  return out
}
