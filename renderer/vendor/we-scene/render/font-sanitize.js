// 修 Chrome OTS 拒载的残缺 TTF。
//
// 缺陷 A：cmap format 4 的 binary-search 三元组写错。
// 症状：FontFace.load() → `OTS parsing error: cmap: unexpected range shift (5 != 6)`，
// 字体回落系统黑体，字宽/字高与作者设计的 Tourner 等完全不同，时钟分秒叠进小时
// （2780710296「最大视差」下的文字布局错乱其实是字体没装上）。
// 全库约 200 个内嵌 ttf 里目前 5 个踩中，全是 Tourner 变体：rangeShift 少算 1。
//
// 缺陷 B：hhea/vhea 的 version 写成 0x00010001。
// 症状：`OTS parsing error: vhea: Unsupported table version: 0x10001` →
// FontFace 抛 "A network error occurred" → 回落系统字体（3448845950 的
// Aa后浪行楷 / Aa攒劲小楷 两个手写体，画面文字整体变形）。
// OpenType 只认 1.0 = 0x00010000（36 字节）与 1.1 = 0x00011000；FreeType 只校验
// `version >> 16 == 1`（所以桌面 WE 照常渲染），OTS 严格比对 → 必须先改对再喂。
// 同族里 千图笔锋手写体 写的就是合法的 0x00011000，可见 0x00010001 是作者工具链
// 的笔误而非新版本。这两个字体自身的 hhea 都是 0x00010000，所以按 1.0 归一。
//
// 桌面 WE 不跑 OTS，照样能开；改完表内容必须重算该表 checksum（目录项）。

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

  // 重算某张表的目录项 checksum（含尾部 0 填充到 4 字节对齐）
  const tableChecksum = (entry, offset, length) => {
    let sum = 0
    const end = offset + length
    for (let p = offset; p < end; p += 4) {
      const b0 = out[p] || 0
      const b1 = p + 1 < end ? out[p + 1] : 0
      const b2 = p + 2 < end ? out[p + 2] : 0
      const b3 = p + 3 < end ? out[p + 3] : 0
      sum = (sum + ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3)) >>> 0
    }
    dv.setUint32(entry + 4, sum)
  }

  let changed = false

  // ---- 缺陷 B：hhea / vhea 的 version ----
  // 只动「两个合法值都不是」的表；0x00010000 / 0x00011000 一律原样保留
  // （千图笔锋手写体的 0x00011000 是合法 1.1，改它反而篡改作者意图）。
  for (let i = 0; i < numTables; i++) {
    const e = 12 + i * 16
    const tag = String.fromCharCode(out[e], out[e + 1], out[e + 2], out[e + 3])
    if (tag !== 'vhea' && tag !== 'hhea') continue
    const off = dv.getUint32(e + 8)
    const len = dv.getUint32(e + 12)
    // 两种版本的表体都是 36 字节；长度异常的单子不碰，交给 OTS 自己报错
    if (len !== 36 || off + len > out.length) continue
    const ver = dv.getUint32(off)
    if (ver === 0x00010000 || ver === 0x00011000) continue
    dv.setUint32(off, 0x00010000)
    tableChecksum(e, off, len)
    changed = true
  }

  // ---- 缺陷 A：cmap format 4 的 binary-search 三元组 ----
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
  if (cmapEntry < 0 || cmapOffset + cmapLength > out.length) return changed ? out : src

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

  tableChecksum(cmapEntry, cmapOffset, cmapLength)
  return out
}
