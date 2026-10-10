// [we-scene patch 2026-10-06] .mdl 编码器（EDITOR-PLAN W17）。纯 Uint8Array，浏览器与 Node 通用。
//
// 两层：
//  · readMdlDoc / writeMdlDoc —— **无损文档**。看得懂的字段结构化（网格头、顶点 / 索引、骨骼、
//    附着点、动画轨道与帧事件），看不懂的按原字节留在 tail / prefix / extra 里；各段的长度与绝对偏移
//    （段头 +9 的 nextOff / endPos、顶点 / 索引字节数、计数）写回时重算。判据：语料逐字节往返
//    （scripts/verify-mdl-write.mjs）。某段结构校验不过就整段退成 raw（仍逐字节往返，只是不可编辑）；
//    网格表都走不通的文件整份 raw。
//  · encodeMDL(spec) —— 从零生成 **MDLV0023 打包族**（语料 72%），给 glTF 导入 / 新建模型用。
//
// 布局（语料实测，与 render/mdl-parse.js 的读侧注释同源）：
//   'MDLV' + 4 位版本 | u8 | u32 mdlFlag | u32 skinCount | u32 meshCount
//   每个子网格：skinCount 条材质 cstr | u32 flagA (+u32 当 flagA==2) | (v>=17) 6×f32 AABB(min xyz, max xyz)
//     | (v>14) u32 meshFlag | u32 顶点字节 + 顶点 | u32 索引字节 + 索引 | (v>=21) 部件表 / 遮罩等变长块
//   之后段链 MDLS → MDAT → MDLA → MDLE（各段 +9 处 u32 = 本段结束的绝对偏移 = 下一段起点），末尾 1 字节 00。
//   MDLS0004 每骨：name cstr | i32 | i32 parent | u32 64 | 16×f32 局部矩阵 | 元数据 JSON cstr；
//     0023 骨记录之后是 14+84N 字节的尾表：[11×00][01][N×(vec3+mat4)][01][N×u32 排列][01][N×i32 绘制序]。
//   MDAT0001：u16 count | 每条 u16 bone + name cstr + 16×f32。
//   MDLA0006：u32 count | 每动画 u32 id | u32 0 | name | mode | f32 fps | u32 frameCount | u32 0 | u32 轨数
//     | 每轨 u32 boneId + u32 字节 + (frameCount+1)×9 f32（tx ty tz rx ry rz sx sy sz，欧拉角弧度）
//     | 前缀（v>=21 为 31 字节，v16–19 为 5 字节，v13/14 无）| u32 事件数 | 每事件 f32 秒 + JSON cstr。
//   MDLE0002：u32 字节 | N×64B 矩阵。

const enc = new TextEncoder()
const decStrict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export const MDL_FLAG_PUPPET = 0x01800009
export const MDL_FLAG_STATIC = 0xf
export const MESH_FLAG_SKINNED = 0x0180000f
export const MESH_FLAG_STATIC = 0xf

const SECTION_TYPES = ['MDLS', 'MDAT', 'MDLA', 'MDLE']
const ANIM_PREFIX_CANDIDATES = [31, 30, 6, 5, 0]

class Writer {
  constructor(size) {
    this.buf = new Uint8Array(Math.max(64, size))
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
  ascii(s) {
    this.bytes(enc.encode(s))
  }
  u8(v) {
    this.grow(1)
    this.buf[this.p++] = v & 255
  }
  u16(v) {
    this.grow(2)
    this.dv.setUint16(this.p, v, true)
    this.p += 2
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
  f32(v) {
    this.grow(4)
    this.dv.setFloat32(this.p, v, true)
    this.p += 4
  }
  /** 浮点数组按位拷贝（不经 number 往返，NaN 载荷也不变） */
  f32s(arr) {
    const a = arr instanceof Float32Array ? arr : Float32Array.from(arr)
    this.bytes(new Uint8Array(a.buffer, a.byteOffset, a.byteLength))
  }
  str(v) {
    this.bytes(typeof v === 'string' ? enc.encode(v) : v.raw)
    this.u8(0)
  }
  bytes(b) {
    this.grow(b.length)
    this.buf.set(b, this.p)
    this.p += b.length
  }
  patchU32(at, v) {
    this.dv.setUint32(at, v >>> 0, true)
  }
  done() {
    return this.buf.slice(0, this.p)
  }
}

class Reader {
  constructor(buf) {
    // Node Buffer 的 slice() 是「视图」语义（subarray），不是拷贝：`.buffer` 会是整块池/文件
    // ArrayBuffer（长度常非 4 的倍数）⇒ f32s/raw 直接抛 RangeError。
    // 统一收敛成真正的 Uint8Array 视图，让后续 slice() 恢复拷贝语义。
    this.buf = buf.constructor === Uint8Array ? buf : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
    this.dv = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength)
  }
  need(p, n) {
    if (p < 0 || p + n > this.buf.length) throw new RangeError('越界')
  }
  u8(p) {
    this.need(p, 1)
    return this.buf[p]
  }
  u16(p) {
    this.need(p, 2)
    return this.dv.getUint16(p, true)
  }
  u32(p) {
    this.need(p, 4)
    return this.dv.getUint32(p, true)
  }
  i32(p) {
    this.need(p, 4)
    return this.dv.getInt32(p, true)
  }
  f32(p) {
    this.need(p, 4)
    return this.dv.getFloat32(p, true)
  }
  /** 按位拷出 n 个 float32；显式走 subarray→set，对齐与来源类型（Buffer/Uint8Array/子视图）无关 */
  f32s(p, n) {
    this.need(p, n * 4)
    const out = new Float32Array(n)
    new Uint8Array(out.buffer, out.byteOffset, n * 4).set(this.buf.subarray(p, p + n * 4))
    return out
  }
  slice(p, end) {
    this.need(p, end - p)
    return this.buf.slice(p, end)
  }
  /** null 结尾串：合法 UTF-8 给 string，否则 { raw } 原字节（往返不改字节） */
  str(p) {
    let e = p
    while (e < this.buf.length && this.buf[e] !== 0) e++
    if (e >= this.buf.length) throw new RangeError('cstr 未结束')
    const raw = this.buf.subarray(p, e)
    let value
    try {
      value = decStrict.decode(raw)
    } catch {
      value = { raw: raw.slice() }
    }
    return { value, next: e + 1 }
  }
  ascii(p, n) {
    this.need(p, n)
    return String.fromCharCode(...this.buf.subarray(p, p + n))
  }
}

/** 文档里的串字段转可读文本（raw 串按 latin1 显示，仅供 UI） */
export function mdlText(v) {
  return typeof v === 'string' ? v : String.fromCharCode(...v.raw)
}

// ─── 读：无损文档 ───────────────────────────────────────────────────────────

function readMeshes(r, ver, skinCount, meshCount) {
  if (!(skinCount > 0 && skinCount <= 8 && meshCount > 0 && meshCount <= 512)) return null
  const meshes = []
  let p = 0x15
  for (let m = 0; m < meshCount; m++) {
    const materials = []
    for (let i = 0; i < skinCount; i++) {
      const s = r.str(p)
      materials.push(s.value)
      p = s.next
    }
    const flagA = r.u32(p)
    p += 4
    let flagAExtra = null
    if (flagA === 2) {
      flagAExtra = r.u32(p)
      p += 4
    }
    let aabb = null
    if (ver >= 17) {
      aabb = r.f32s(p, 6)
      p += 24
    }
    let meshFlag = null
    if (ver > 14) {
      meshFlag = r.u32(p)
      p += 4
    }
    const vb = r.u32(p)
    const vertexData = r.slice(p + 4, p + 4 + vb)
    p += 4 + vb
    const ib = r.u32(p)
    const indexData = r.slice(p + 4, p + 4 + ib)
    p += 4 + ib
    const extraStart = p
    if (ver >= 21) {
      const unkA = r.u8(p++)
      if (unkA === 1) {
        if (r.u8(p++)) {
          p += 3
          p += 4 + r.u32(p)
        }
      } else if (unkA !== 0) return null
      if (r.u8(p++)) p += 4 + r.u32(p)
      if (ver > 21) {
        const masks = r.u32(p)
        p += 4
        for (let k = 0; k < masks; k++) {
          p += 8
          p = r.str(p).next + 4
          p += 4 + r.u32(p) * 4
          p += 4 + r.u32(p) * 4
        }
      }
    }
    const extra = r.slice(extraStart, p)
    meshes.push({ materials, flagA, flagAExtra, aabb, meshFlag, vertexData, indexData, extra })
  }
  return { meshes, end: p }
}

function sectionAt(r, p) {
  if (p + 13 > r.buf.length) return null
  const type = r.ascii(p, 4)
  if (!SECTION_TYPES.includes(type)) return null
  const end = r.u32(p + 9)
  if (!(end >= p + 13 && end <= r.buf.length)) return null
  return { type, end }
}

function readMDLS(r, p, end) {
  const count = r.u32(p + 13)
  const bones = []
  let j = p + 17
  for (let b = 0; b < count; b++) {
    const name = r.str(j)
    const h = name.next
    const head0 = r.i32(h)
    const parent = r.i32(h + 4)
    if (r.u32(h + 8) !== 64) return null
    const matrix = r.f32s(h + 12, 16)
    const meta = r.str(h + 76)
    j = meta.next
    if (j > end) return null
    bones.push({ name: name.value, head0, parent, matrix, meta: meta.value })
  }
  return { bones, tail: r.slice(j, end) }
}

function readMDAT(r, p, end) {
  const count = r.u16(p + 13)
  const attachments = []
  let j = p + 15
  for (let k = 0; k < count; k++) {
    const bone = r.u16(j)
    const name = r.str(j + 2)
    const matrix = r.f32s(name.next, 16)
    j = name.next + 64
    if (j > end) return null
    attachments.push({ bone, name: name.value, matrix })
  }
  return { attachments, tail: r.slice(j, end) }
}

/** 动画头像不像（与 mdl-parse 的 findNextAnimHeader 同五重校验） */
function looksLikeAnimHeader(r, p, limit) {
  try {
    if (p + 24 > limit || r.u32(p + 4) !== 0) return false
    const name = r.str(p + 8)
    if (typeof name.value !== 'string' || !name.value || name.value.length > 64) return false
    const mode = r.str(name.next)
    if (typeof mode.value !== 'string' || !mode.value || mode.value.length > 16) return false
    const fps = r.f32(mode.next)
    if (!(fps > 0 && fps <= 240)) return false
    const fc = r.u32(mode.next + 4)
    const tc = r.u32(mode.next + 12)
    return fc > 0 && fc <= 100000 && tc > 0 && tc <= 1024
  } catch {
    return false
  }
}

/** 从 at 起读 [u32 n][n × (f32 秒 + JSON cstr)]，恰好落在 boundary 才算数 */
function readEventsExact(r, at, boundary) {
  try {
    const n = r.u32(at)
    if (n > 4096) return null
    let q = at + 4
    const events = []
    for (let k = 0; k < n; k++) {
      const time = r.f32(q)
      const json = r.str(q + 4)
      if (typeof json.value !== 'string' || !Number.isFinite(time)) return null
      const ev = JSON.parse(json.value)
      if (!ev || typeof ev !== 'object' || !Number.isFinite(Number(ev.frame))) return null
      events.push({ time, json: json.value })
      q = json.next
      if (q > boundary) return null
    }
    return q === boundary ? events : null
  } catch {
    return null
  }
}

/**
 * 轨道之后到下一条动画头（末条到段尾）之间 = [前缀][事件表]。前缀长度随版本变（31 / 30 / 6 / 5 / 0），
 * 部分模型还在里面夹一块自带长度的附加数据（3078285611、2955378002 的 mirror 片段）——一律按原字节留在 prefix。
 */
function readAnimTrailer(r, o, end, last) {
  let boundary = end
  if (!last) {
    boundary = -1
    for (let q = o; q + 24 <= end; q++) {
      if (looksLikeAnimHeader(r, q, end)) {
        boundary = q
        break
      }
    }
    if (boundary < 0) return null
  }
  const room = boundary - o - 4
  if (room < 0) return null
  const tried = new Set()
  for (const pl of [...ANIM_PREFIX_CANDIDATES, room]) {
    if (pl > room || tried.has(pl)) continue
    tried.add(pl)
    const events = readEventsExact(r, o + pl, boundary)
    if (events) return { prefix: r.slice(o, o + pl), events, next: boundary }
  }
  for (let pl = 0; pl <= room; pl++) {
    if (tried.has(pl)) continue
    const events = readEventsExact(r, o + pl, boundary)
    if (events) return { prefix: r.slice(o, o + pl), events, next: boundary }
  }
  return null
}

function readMDLA(r, p, end) {
  const count = r.u32(p + 13)
  if (count > 256) return null
  const anims = []
  let o = p + 17
  for (let ai = 0; ai < count; ai++) {
    const id = r.u32(o)
    const unk0 = r.u32(o + 4)
    const name = r.str(o + 8)
    const mode = r.str(name.next)
    o = mode.next
    const fps = r.f32(o)
    if (!(fps > 0 && fps <= 240)) return null
    const frameCount = r.u32(o + 4)
    const unk1 = r.u32(o + 8)
    const trackCount = r.u32(o + 12)
    if (trackCount > 1024) return null
    o += 16
    const tracks = []
    for (let t = 0; t < trackCount; t++) {
      const boneId = r.u32(o)
      const bytes = r.u32(o + 4)
      if (bytes % 4 !== 0 || o + 8 + bytes > end) return null
      tracks.push({ boneId, data: r.f32s(o + 8, bytes / 4) })
      o += 8 + bytes
    }
    const tr = readAnimTrailer(r, o, end, ai === count - 1)
    if (!tr) return null
    anims.push({ id, unk0, name: name.value, mode: mode.value, fps, frameCount, unk1, tracks, prefix: tr.prefix, events: tr.events })
    o = tr.next
  }
  return o === end ? { anims } : null
}

function readMDLE(r, p, end) {
  const size = r.u32(p + 13)
  if (p + 17 + size > end) return null
  return { data: r.slice(p + 17, p + 17 + size), tail: r.slice(p + 17 + size, end) }
}

const SECTION_READERS = { MDLS: readMDLS, MDAT: readMDAT, MDLA: readMDLA, MDLE: readMDLE }

function readSections(r, start) {
  let first = sectionAt(r, start) ? start : -1
  if (first < 0) {
    // 网格之后不紧跟段：找第一个能接上段链的签名（旧版本可能有间隙）
    for (let q = start; q + 13 <= r.buf.length; q++) {
      if (r.buf[q] !== 0x4d || !sectionAt(r, q)) continue
      first = q
      break
    }
  }
  if (first < 0) return { gap: new Uint8Array(0), sections: [], trailing: r.slice(start, r.buf.length) }
  const sections = []
  let p = first
  for (let s = sectionAt(r, p); s; s = sectionAt(r, p)) {
    const base = { type: s.type, version: r.ascii(p + 4, 4), b8: r.u8(p + 8) }
    let body = null
    try {
      body = SECTION_READERS[s.type](r, p, s.end)
    } catch {
      body = null
    }
    sections.push(body ? { ...base, ...body } : { ...base, raw: r.slice(p + 13, s.end) })
    p = s.end
  }
  return { gap: r.slice(start, first), sections, trailing: r.slice(p, r.buf.length) }
}

/**
 * 读成无损文档。结构：
 * `{ version, b8, mdlFlag, skinCount, meshes[], gap, sections[], trailing }`；
 * 网格表走不通时 `{ raw }`（整份原字节，只能原样写回）。
 */
export function readMdlDoc(buf) {
  const r = new Reader(buf)
  const magic = r.ascii(0, 8)
  if (!magic.startsWith('MDLV')) throw new Error('不是 MDL: ' + magic)
  const version = parseInt(magic.slice(4), 10)
  const head = { version, b8: r.u8(8), mdlFlag: r.u32(9), skinCount: r.u32(13) }
  const meshCount = r.u32(17)
  let walked = null
  try {
    walked = readMeshes(r, version, head.skinCount, meshCount)
  } catch {
    walked = null
  }
  if (!walked) return { ...head, raw: r.slice(0, r.buf.length) }
  return { ...head, meshes: walked.meshes, ...readSections(r, walked.end) }
}

// ─── 写 ────────────────────────────────────────────────────────────────────

function writeSectionBody(w, s) {
  if (s.raw) {
    w.bytes(s.raw)
    return
  }
  if (s.type === 'MDLS') {
    w.u32(s.bones.length)
    for (const b of s.bones) {
      w.str(b.name ?? '')
      w.i32(b.head0 ?? 1)
      w.i32(b.parent)
      w.u32(64)
      w.f32s(b.matrix)
      w.str(b.meta ?? '')
    }
    w.bytes(s.tail ?? new Uint8Array(0))
  } else if (s.type === 'MDAT') {
    w.u16(s.attachments.length)
    for (const a of s.attachments) {
      w.u16(a.bone)
      w.str(a.name)
      w.f32s(a.matrix)
    }
    w.bytes(s.tail ?? new Uint8Array(0))
  } else if (s.type === 'MDLA') {
    w.u32(s.anims.length)
    for (const a of s.anims) {
      w.u32(a.id)
      w.u32(a.unk0 ?? 0)
      w.str(a.name)
      w.str(a.mode)
      w.f32(a.fps)
      w.u32(a.frameCount)
      w.u32(a.unk1 ?? 0)
      w.u32(a.tracks.length)
      for (const t of a.tracks) {
        const data = t.data instanceof Float32Array ? t.data : Float32Array.from(t.data)
        w.u32(t.boneId ?? 0)
        w.u32(data.byteLength)
        w.f32s(data)
      }
      w.bytes(a.prefix ?? new Uint8Array(31))
      const events = a.events ?? []
      w.u32(events.length)
      for (const e of events) {
        w.f32(e.time)
        w.str(e.json)
      }
    }
  } else if (s.type === 'MDLE') {
    w.u32(s.data.length)
    w.bytes(s.data)
    w.bytes(s.tail ?? new Uint8Array(0))
  } else {
    throw new Error('未知段: ' + s.type)
  }
}

/** 无损文档写回字节；长度、计数与段偏移全部按内容重算 */
export function writeMdlDoc(doc) {
  if (doc.raw) return doc.raw.slice()
  const w = new Writer(1 << 16)
  const ver = doc.version
  w.ascii('MDLV' + String(ver).padStart(4, '0'))
  w.u8(doc.b8 ?? 0)
  w.u32(doc.mdlFlag)
  w.u32(doc.skinCount)
  w.u32(doc.meshes.length)
  for (const m of doc.meshes) {
    if (m.materials.length !== doc.skinCount) throw new Error(`子网格材质数 ${m.materials.length} ≠ skinCount ${doc.skinCount}`)
    for (const s of m.materials) w.str(s)
    w.u32(m.flagA)
    if (m.flagA === 2) w.u32(m.flagAExtra ?? 0)
    if (ver >= 17) w.f32s(m.aabb ?? new Float32Array(6))
    if (ver > 14) w.u32(m.meshFlag)
    w.u32(m.vertexData.length)
    w.bytes(m.vertexData)
    w.u32(m.indexData.length)
    w.bytes(m.indexData)
    w.bytes(m.extra ?? new Uint8Array(0))
  }
  w.bytes(doc.gap ?? new Uint8Array(0))
  for (const s of doc.sections ?? []) {
    w.ascii(s.type + s.version)
    w.u8(s.b8 ?? 0)
    const at = w.p
    w.u32(0)
    writeSectionBody(w, s)
    w.patchU32(at, w.p)
  }
  w.bytes(doc.trailing ?? new Uint8Array(0))
  return w.done()
}

// ─── 顶点布局（与 mdl-parse 的 vertexLayoutOf 同一套位） ─────────────────────

/** meshFlag → 顶点内字段偏移；-1 = 无该字段 */
export function meshVertexLayout(flag) {
  let off = 12
  const o = { stride: 0, normal: -1, tangent: -1, bone: -1, weight: -1, uv: -1, uv2: -1 }
  if (flag & 0x2) { o.normal = off; off += 12 }
  if (flag & 0x4) { o.tangent = off; off += 16 }
  if (flag & 0x10000) off += 4
  if (flag & 0x800000) { o.bone = off; off += 16 }
  if (flag & 0x1000000) { o.weight = off; off += 16 }
  if (flag & (0x8 | 0x20)) { o.uv = off; off += 8 }
  if (flag & 0x20) { o.uv2 = off; off += 8 }
  o.stride = off
  return o
}

// ─── 从零生成 MDLV0023 ──────────────────────────────────────────────────────

function packVertices(mesh, skinned, boneCount) {
  const flag = skinned ? MESH_FLAG_SKINNED : MESH_FLAG_STATIC
  const L = meshVertexLayout(flag)
  const pos = mesh.positions
  const n = pos.length / 3
  if (!Number.isInteger(n) || n <= 0) throw new Error('positions 长度须为 3 的正整数倍')
  const uv = mesh.uvs
  if (uv && uv.length !== n * 2) throw new Error('uvs 长度与顶点数不符')
  const nrm = mesh.normals
  const tan = mesh.tangents
  const bi = mesh.boneIdx
  const bw = mesh.weights
  if (skinned && (!bi || !bw || bi.length !== n * 4 || bw.length !== n * 4)) throw new Error('蒙皮网格须给 boneIdx / weights（每顶点 4 个）')
  const out = new Uint8Array(n * L.stride)
  const dv = new DataView(out.buffer)
  for (let i = 0; i < n; i++) {
    const b = i * L.stride
    for (let k = 0; k < 3; k++) dv.setFloat32(b + k * 4, pos[i * 3 + k], true)
    for (let k = 0; k < 3; k++) dv.setFloat32(b + L.normal + k * 4, nrm ? nrm[i * 3 + k] : k === 2 ? 1 : 0, true)
    for (let k = 0; k < 4; k++) dv.setFloat32(b + L.tangent + k * 4, tan ? tan[i * 4 + k] : k === 0 || k === 3 ? 1 : 0, true)
    if (skinned) {
      for (let k = 0; k < 4; k++) {
        const idx = bi[i * 4 + k]
        if (!(Number.isInteger(idx) && idx >= 0 && idx < boneCount)) throw new Error(`顶点 ${i} 骨号 ${idx} 越界`)
        dv.setUint32(b + L.bone + k * 4, idx, true)
        dv.setFloat32(b + L.weight + k * 4, bw[i * 4 + k], true)
      }
    }
    dv.setFloat32(b + L.uv, uv ? uv[i * 2] : 0, true)
    dv.setFloat32(b + L.uv + 4, uv ? uv[i * 2 + 1] : 0, true)
  }
  return { flag, data: out, count: n }
}

function packIndices(indices, vertexCount) {
  if (!indices || indices.length % 3 !== 0) throw new Error('indices 须为三角形列表')
  const wide = vertexCount > 65535
  const out = new Uint8Array(indices.length * (wide ? 4 : 2))
  const dv = new DataView(out.buffer)
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i]
    if (!(Number.isInteger(v) && v >= 0 && v < vertexCount)) throw new Error(`索引 ${i} = ${v} 越界`)
    if (wide) dv.setUint32(i * 4, v, true)
    else dv.setUint16(i * 2, v, true)
  }
  return out
}

/**
 * v>=21 网格尾的变长块：u8 unkA(0) | u8 hasParts | [u32 字节 + N×(u32 id, i32 绘制序偏移, u32 start, u32 size)]
 * | u32 遮罩数(0)。部件按索引区间首尾相接、恰好铺满索引表（语料全部如此，允许空部件 size=0）。
 */
function meshExtra(parts, indexCount) {
  if (!parts || parts.length === 0) return new Uint8Array(6)
  let end = 0
  parts.forEach((pt, i) => {
    if (!(Number.isInteger(pt.id) && pt.id >= 0)) throw new Error(`部件 ${i} id 须为非负整数`)
    if (!Number.isInteger(pt.offset)) throw new Error(`部件 ${i} offset 须为整数`)
    if (pt.start !== end || !(Number.isInteger(pt.size) && pt.size >= 0)) throw new Error(`部件 ${i} 索引区间须紧接上一个（start=${end}）`)
    end += pt.size
  })
  if (end !== indexCount) throw new Error(`部件区间须恰好铺满索引表（${end} ≠ ${indexCount}）`)
  const out = new Uint8Array(2 + 4 + parts.length * 16 + 4)
  const dv = new DataView(out.buffer)
  out[1] = 1
  dv.setUint32(2, parts.length * 16, true)
  parts.forEach((pt, i) => {
    const b = 6 + i * 16
    dv.setUint32(b, pt.id, true)
    dv.setInt32(b + 4, pt.offset, true)
    dv.setUint32(b + 8, pt.start, true)
    dv.setUint32(b + 12, pt.size, true)
  })
  return out
}

function aabbOf(pos) {
  const a = Float32Array.of(Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity)
  for (let i = 0; i < pos.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (pos[i + k] < a[k]) a[k] = pos[i + k]
      if (pos[i + k] > a[k + 3]) a[k + 3] = pos[i + k]
    }
  }
  return a
}

/**
 * 0023 骨记录之后的尾表（14+84N）。vec3 / mat4 的语义未逆向（引擎不消费），
 * 写「零向量 + 骨局部矩阵」：mdl-parse 的 parseStaticPose 对单骨模型会把它当静态姿势读，
 * 等于绑定姿势 → 蒙皮恒等，不会把新模型拼歪。排列表恒等、绘制序按 100 递增（语料同形）。
 */
// [we-scene patch 2026-10-08] 导出给编辑器（P2 骨架重写要用它重建 N 相关的静态装配姿势尾表）。
// 注意：真实语料里 402 个 MDLS 只有 254 个 tail 长度**恰好** 14+84N，148 个是空 tail，
// 而有静态姿势的那 106 个长度**大于** 14+84N（另有余表）—— 所以改骨数时保留旧 tail 是**错的**
// （末尾 1+4N / 76N / 64N 三张表都按 N 定长），调用方要么重建要么丢弃，见 mdl-edit 的 setMdlSkeleton。
export function mdlsTail(bones) {
  const n = bones.length
  const out = new Uint8Array(14 + 84 * n)
  const dv = new DataView(out.buffer)
  out[11] = 1
  let p = 12
  for (const b of bones) {
    p += 12
    const m = b.matrix
    for (let k = 0; k < 16; k++) dv.setFloat32(p + k * 4, m[k], true)
    p += 64
  }
  out[p++] = 1
  for (let i = 0; i < n; i++, p += 4) dv.setUint32(p, i, true)
  out[p++] = 1
  for (let i = 0; i < n; i++, p += 4) dv.setInt32(p, i * 100, true)
  return out
}

function checkBones(bones) {
  bones.forEach((b, i) => {
    if (!(Number.isInteger(b.parent) && b.parent >= -1 && b.parent < i)) {
      throw new Error(`骨 ${i} 的 parent ${b.parent} 须为 -1 或更靠前的骨（引擎按序累乘父链）`)
    }
    if (!b.matrix || b.matrix.length !== 16) throw new Error(`骨 ${i} 缺 16 分量局部矩阵`)
  })
}

function buildAnim(a, i, boneCount) {
  const fc = a.frameCount
  if (!(Number.isInteger(fc) && fc > 0)) throw new Error(`动画 ${i} frameCount 须为正整数`)
  if (!(a.fps > 0 && a.fps <= 240)) throw new Error(`动画 ${i} fps 须在 (0, 240]`)
  if (!Array.isArray(a.tracks) || a.tracks.length !== boneCount) throw new Error(`动画 ${i} 须每骨一轨（${boneCount}）`)
  const tracks = a.tracks.map((t, bi) => {
    const data = t instanceof Float32Array ? t : Float32Array.from(t)
    if (data.length !== 9 * (fc + 1)) throw new Error(`动画 ${i} 骨 ${bi} 轨须 ${fc + 1} 帧 × 9 分量`)
    return { boneId: 0, data }
  })
  const events = (a.events ?? []).map((e) => ({
    time: e.frame / a.fps,
    json: JSON.stringify({ frame: e.frame, name: e.name }),
  }))
  return {
    id: a.id ?? i + 1,
    unk0: 0,
    name: a.name ?? `Animation ${i + 1}`,
    mode: a.mode ?? 'loop',
    fps: a.fps,
    frameCount: fc,
    unk1: 0,
    tracks,
    prefix: new Uint8Array(31),
    events,
  }
}

/**
 * 从零构造 MDLV0023 文档（可再经 writeMdlDoc 写出，或先编辑）。
 * spec：
 *   meshes[{ material, positions, uvs?, normals?, tangents?, boneIdx?, weights?, indices,
 *            parts?[{ id, offset(绘制序偏移), start, size }]（索引区间，首尾相接铺满 indices） }]
 *   bones?[{ name?, parent, matrix(16, 局部) }]（parent 须指向更靠前的骨）
 *   animations?[{ id?, name?, mode?, fps, frameCount, tracks: 每骨 (frameCount+1)×9, events?[{frame, name}] }]
 *   attachments?[{ name, bone, matrix(16) }]
 * 有骨 = 蒙皮 puppet（stride 80，meshFlag 0x0180000f）；无骨 = 静态网格（stride 48，meshFlag 0xf）。
 */
export function createMdlDoc(spec) {
  const bones = spec.bones ?? []
  checkBones(bones)
  const skinned = bones.length > 0
  if (!Array.isArray(spec.meshes) || spec.meshes.length === 0) throw new Error('至少一个子网格')
  const meshes = spec.meshes.map((m) => {
    if (typeof m.material !== 'string' || !m.material) throw new Error('子网格缺 material 路径')
    const v = packVertices(m, skinned, bones.length)
    return {
      materials: [m.material],
      flagA: 0,
      flagAExtra: null,
      aabb: aabbOf(m.positions),
      meshFlag: v.flag,
      vertexData: v.data,
      indexData: packIndices(m.indices, v.count),
      extra: meshExtra(m.parts, m.indices.length),
    }
  })
  const sections = []
  if (skinned) {
    sections.push({
      type: 'MDLS',
      version: '0004',
      b8: 0,
      // [we-scene patch 2026-10-08] P2：head0 / meta 透传（meta 承载 pw 骨架仿真参数，
      // 原来恒写 1 / ''，任何「从 spec 重建」的路径都会把骨 meta 悄悄丢掉）。
      bones: bones.map((b) => ({ name: b.name ?? '', head0: b.head0 ?? 1, parent: b.parent, matrix: Float32Array.from(b.matrix), meta: b.meta ?? '' })),
      tail: mdlsTail(bones),
    })
  }
  const att = spec.attachments ?? []
  if (att.length) {
    if (!skinned) throw new Error('附着点要求模型有骨骼')
    sections.push({
      type: 'MDAT',
      version: '0001',
      b8: 0,
      attachments: att.map((a) => {
        if (!(Number.isInteger(a.bone) && a.bone >= 0 && a.bone < bones.length)) throw new Error(`附着点 ${a.name} 骨号越界`)
        return { bone: a.bone, name: a.name, matrix: Float32Array.from(a.matrix) }
      }),
      tail: new Uint8Array(0),
    })
  }
  const anims = spec.animations ?? []
  if (anims.length) {
    if (!skinned) throw new Error('动画要求模型有骨骼')
    const built = anims.map((a, i) => buildAnim(a, i, bones.length))
    if (new Set(built.map((a) => a.id)).size !== built.length) throw new Error('动画 id 重复')
    sections.push({ type: 'MDLA', version: '0006', b8: 0, anims: built })
  }
  return {
    version: 23,
    b8: 0,
    mdlFlag: skinned ? MDL_FLAG_PUPPET : MDL_FLAG_STATIC,
    skinCount: 1,
    meshes,
    gap: new Uint8Array(0),
    sections,
    trailing: new Uint8Array([0]),
  }
}

/** 从零编码 MDLV0023 字节（spec 见 createMdlDoc） */
export function encodeMDL(spec) {
  return writeMdlDoc(createMdlDoc(spec))
}
