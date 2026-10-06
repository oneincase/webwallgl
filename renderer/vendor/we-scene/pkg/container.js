// scene.pkg 容器解析器
// 格式（实测 PKGV0012 ~ PKGV0023）：
//   [0]    uint32 LE  魔数字符串长度（实测恒为 8）
//   [4]    n 字节     魔数 "PKGVxxxx"（版本号）
//   [4+n]  uint32 LE  入口数量
//   随后 count 个入口：{ uint32 nameLen, name 字节, uint32 offset, uint32 size }
//   dataStart = 入口表结束位置；入口数据 = dataStart + offset，长度 size。
//   offset 为相对 dataStart 的偏移（首个入口 offset 恒为 0）。
export function parsePkg(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  if (buf.length < 16) throw new Error('文件太小，不是 scene.pkg')
  const magicLen = dv.getUint32(0, true)
  if (magicLen < 4 || magicLen > 16) throw new Error('魔数长度异常: ' + magicLen)
  const magic = ascii(buf, 4, magicLen)
  if (!magic.startsWith('PKGV')) throw new Error('不是 scene.pkg，魔数: ' + magic)
  const count = dv.getUint32(4 + magicLen, true)
  let p = 4 + magicLen + 4
  const entries = []
  for (let i = 0; i < count; i++) {
    if (p + 8 > buf.length) throw new Error('入口表越界 @' + i)
    const nameLen = dv.getUint32(p, true)
    p += 4
    if (p + nameLen + 8 > buf.length) throw new Error('入口 ' + i + ' 越界')
    const name = decodeName(buf, p, nameLen)
    p += nameLen
    const offset = dv.getUint32(p, true)
    p += 4
    const size = dv.getUint32(p, true)
    p += 4
    entries.push({ name, offset, size })
  }
  const dataStart = p
  return {
    magic,
    version: magic.slice(4),
    count,
    entries,
    dataStart,
    fileSize: buf.length,
    buf,
  }
}

// 取指定路径的入口数据。返回指向 pkg.buf 的视图，不复制。
// 入口互不重叠、解析器只读；大 scene.pkg（100MB+）若每张贴图再 .slice() 会把峰值内存翻倍、
// 首载卡在拷贝上。需要独立副本的调用方自己 .slice()。
export function getEntry(pkg, name) {
  const e = pkg.entries.find((x) => x.name === name)
  if (e === undefined) return null
  const start = pkg.dataStart + e.offset
  const end = start + e.size
  if (start < 0 || end > pkg.fileSize) throw new Error('入口 ' + name + ' 越界')
  return pkg.buf.subarray(start, end)
}

// [we-scene patch] parsePkg 的对偶：把 { name, data } 列表写成 PKGV0012 容器（纯 Uint8Array，
// 浏览器与 Node 通用；scripts/dev-pack-pkg.mjs 与编辑器导出共用）。入口按名字字节序排序，
// 同输入产出逐字节相同；重名抛错（WE 与本仓解析器都只认第一个，静默会丢数据）。
export const PKG_WRITE_MAGIC = 'PKGV0012'
export function writePkg(files) {
  const enc = new TextEncoder()
  const list = files
    .map((f) => ({ name: f.name, nameBytes: enc.encode(f.name), data: f.data }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (let i = 1; i < list.length; i++) {
    if (list[i].name === list[i - 1].name) throw new Error('writePkg: 入口重名 ' + list[i].name)
  }
  let headLen = 4 + PKG_WRITE_MAGIC.length + 4
  let dataLen = 0
  for (const f of list) {
    headLen += 4 + f.nameBytes.length + 8
    dataLen += f.data.length
  }
  const out = new Uint8Array(headLen + dataLen)
  const dv = new DataView(out.buffer)
  let p = 0
  dv.setUint32(p, PKG_WRITE_MAGIC.length, true)
  p += 4
  for (let i = 0; i < PKG_WRITE_MAGIC.length; i++) out[p++] = PKG_WRITE_MAGIC.charCodeAt(i)
  dv.setUint32(p, list.length, true)
  p += 4
  let offset = 0
  for (const f of list) {
    dv.setUint32(p, f.nameBytes.length, true)
    p += 4
    out.set(f.nameBytes, p)
    p += f.nameBytes.length
    dv.setUint32(p, offset, true)
    dv.setUint32(p + 4, f.data.length, true)
    p += 8
    offset += f.data.length
  }
  for (const f of list) {
    out.set(f.data, p)
    p += f.data.length
  }
  return out
}

// 入口数据末尾应恰好贴住文件末尾（结构自检）
export function verifyLayout(pkg) {
  let end = 0
  for (const e of pkg.entries) end = Math.max(end, e.offset + e.size)
  return { dataEnd: pkg.dataStart + end, fileSize: pkg.fileSize, ok: pkg.dataStart + end <= pkg.fileSize }
}

function ascii(buf, start, len) {
  let s = ''
  for (let i = start; i < start + len; i++) s += String.fromCharCode(buf[i])
  return s
}

// 入口名：WE 以 UTF-8 存储（中文名场景实测）；非法 UTF-8 时回退 Latin-1 逐字节
function decodeName(buf, start, len) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(start, start + len))
  } catch (e) {
    return ascii(buf, start, len)
  }
}
