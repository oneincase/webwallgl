// MDL 共享底座：列主序 4x4 工具 + 二进制读取原语（从 mdl.js 拆出）
//
// [we-scene patch] 解析（mdl-parse.js）、蒙皮（mdl-skin.js）、渲染（mdl.js）
// 三段都要用这批纯函数，单独成模块以消除曾经的 mat4Mul/mat4Invert 双实现
// （与 render/math.js 的重复见 docs/ARCHITECTURE.md「未来拆分路线」）。
const IDENTITY = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])

// ---------- 列主序 4x4 工具（与 WebGL uniformMatrix4fv 的内存布局一致） ----------

function mat4Mul(a, b, out) {
  const o = out || new Float32Array(16)
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] =
        a[r] * b[c * 4] +
        a[4 + r] * b[c * 4 + 1] +
        a[8 + r] * b[c * 4 + 2] +
        a[12 + r] * b[c * 4 + 3]
    }
  }
  return o
}

// 高斯消元求逆（骨骼绑定矩阵含平移/旋转/缩放，不保证正交，故用通用求逆）
function mat4Invert(m) {
  const a = []
  for (let r = 0; r < 4; r++) {
    a.push([m[r], m[4 + r], m[8 + r], m[12 + r], 0, 0, 0, 0])
    a[r][4 + r] = 1
  }
  for (let col = 0; col < 4; col++) {
    let piv = col
    for (let r = col + 1; r < 4; r++) {
      if (Math.abs(a[r][col]) > Math.abs(a[piv][col])) piv = r
    }
    const t = a[col]
    a[col] = a[piv]
    a[piv] = t
    const pv = a[col][col]
    if (Math.abs(pv) < 1e-12) return Float32Array.from(IDENTITY)
    for (let j = 0; j < 8; j++) a[col][j] /= pv
    for (let r = 0; r < 4; r++) {
      if (r === col) continue
      const f = a[r][col]
      if (f === 0) continue
      for (let j = 0; j < 8; j++) a[r][j] -= f * a[col][j]
    }
  }
  const out = new Float32Array(16)
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) out[c * 4 + r] = a[r][4 + c]
  return out
}

// 平移 + 四元数旋转 + xy 缩放 → 列主序矩阵
// MDLA 关键帧的 9 个 float 是 **[tx,ty,tz, rx,ry,rz, sx,sy,sz]**（欧拉角 + 三轴缩放），
// 不是「四元数 + 二维缩放」。此前按 [T, qx,qy,qz,qw, sx,sy] 读，索引 3 之后**整体错位一格**：
// 真正的 rz 被当成 qz、sx 被当成 qw、sy/sz 被当成 sx/sy —— 详见 sampleTrackTRS 的判据。
//
// 旋转按 Rz·Ry·Rx 合成，列 0/1/2 分别乘 sx/sy/sz（列主序，o[col*4+row]）。
// 2D 场景里 rx/ry 实测恒为 0（全库 99.9% / 100% 的关键帧），此时退化为纯绕 z 旋转，
// 但仍按完整欧拉角实现，免得 3233141951（朱鹤 rx 最大 1.605）这类模型再踩坑。
function composeTRS(tx, ty, tz, rx, ry, rz, scx, scy, scz, out) {
  const o = out || new Float32Array(16)
  const cx = Math.cos(rx)
  const sx = Math.sin(rx)
  const cy = Math.cos(ry)
  const sy = Math.sin(ry)
  const cz = Math.cos(rz)
  const sz = Math.sin(rz)
  o[0] = (cz * cy) * scx
  o[1] = (sz * cy) * scx
  o[2] = (-sy) * scx
  o[3] = 0
  o[4] = (cz * sy * sx - sz * cx) * scy
  o[5] = (sz * sy * sx + cz * cx) * scy
  o[6] = (cy * sx) * scy
  o[7] = 0
  o[8] = (cz * sy * cx + sz * sx) * scz
  o[9] = (sz * sy * cx - cz * sx) * scz
  o[10] = (cy * cx) * scz
  o[11] = 0
  o[12] = tx
  o[13] = ty
  o[14] = tz
  o[15] = 1
  return o
}

// ---------- 解析 ----------

function readCStr(dv, off) {
  const bytes = []
  while (off < dv.byteLength) {
    const c = dv.getUint8(off++)
    if (c === 0) break
    bytes.push(c)
  }
  let s = ''
  try {
    s = new TextDecoder('utf-8').decode(new Uint8Array(bytes))
  } catch (e) {
    s = String.fromCharCode.apply(null, bytes)
  }
  return { value: s, next: off }
}

function findAscii(buf, str, from = 0) {
  const pat = []
  for (let i = 0; i < str.length; i++) pat.push(str.charCodeAt(i))
  outer: for (let p = from; p <= buf.length - pat.length; p++) {
    for (let k = 0; k < pat.length; k++) {
      if (buf[p + k] !== pat[k]) continue outer
    }
    return p
  }
  return -1
}


export { IDENTITY, mat4Mul, mat4Invert, composeTRS, readCStr, findAscii }
