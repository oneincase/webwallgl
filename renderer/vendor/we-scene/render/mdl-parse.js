// MDL 二进制格式解析（从 mdl.js 拆出；格式布局见 mdl.js 头注释）
//
// 覆盖 MDLV0023 顶点/索引、MDLS0004 骨架、MDLA0006 动画轨道、MDLE0002 绑定姿势。
// 全部 DOM/GPU-free，Node 直载（verify-groups / verify-pointer 在离线侧直接调 parseMDL）。
import { IDENTITY, mat4Mul, mat4Invert, composeTRS, readCStr, findAscii } from './mdl-math.js'
export function parseMDL(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const magic = String.fromCharCode.apply(null, Array.from(buf.subarray(0, 8)))
  if (!magic.startsWith('MDLV')) throw new Error('不是 MDL: ' + magic)

  // 材质路径（0x15 起 null 结尾）；顶点区长度在其 null 之后的固定偏移处。
  //
  // [we-scene patch] 版本差异：MDLV0023 是「null 之后 +32、stride 80」，
  // 而 MDLV0016（本机库 21 个模型）是「null 之后 +8、**stride 52**」，字段也更紧凑：
  //   pos vec3 @0 / boneIdx u32×4 @12 / weights f32×4 @28 / uv vec2 @44
  // 改动前按 0023 的布局硬读，0016 在 null+32 处读到 0 → 抛「顶点区长度异常: 0」，
  // 全库 21 个 MDLV0016 + 14 个 MDLV0013 模型全部解析失败。
  // 其中就包括 2998757800（碧蓝航线-利托里奥）的 4 个模型 —— 它是骨骼拖拽壁纸之一。
  //
  // 0016 布局的三条独立校验（本机 4 个模型全部通过）：
  //   1. vertexBytes 能被 52 整除（212004/3640/24960/31044 → 4077/70/480/597 顶点）；
  //   2. 每顶点 4 个权重之和恒为 1.000（异常 0 个），boneIdx 全部 < boneCount；
  //   3. UV 与位置的关系与 0023 完全一致：u=(x+W/2)/W、v=(H/2-y)/H
  //      （max 误差 5.75e-8 / 5.35e-8，W/H 取图层 size）。
  const mat = readCStr(dv, 0x15)
  const ver = parseInt(magic.slice(4), 10)
  // 版本 → [长度字段相对 mat.next 的偏移, 顶点 stride, 各字段在顶点内的偏移]
  // 注意 readCStr 的 next 已跳过 null 终止符，所以这里的偏移是「null 之后」再数。
  //
  // [we-scene patch] **MDLV0013 是「null 之后 +4、stride 52」** —— 顶点布局与 0016
  // 完全一致，只有长度字段的偏移少 4 字节。此前只挂了 0016(+8) 与 0023(+32) 两种，
  // 0013 在 +8 处读到的是顶点数据本身（Train1 读出 3298705146 ≈ -1265.97f 的位模式），
  // 既不能被 52 整除也不能被 80 整除 → 抛「顶点区长度异常」→ **整个 puppet 层不渲染**。
  // 全库 14 个 MDLV0013 全军覆没，2477602742 的三节火车（Train1/2/3）就在其中，
  // 表现是「火车动画没实现」（其实是网格根本没解析出来）。
  //
  // 三条独立自洽校验，14/14 全部通过：
  //   1. vertexBytes 能被 52 整除（20072/19812/13936/… → 386/381/268/… 顶点）；
  //   2. 每顶点 4 个权重之和恒为 1.000；
  //   3. UV 全部落在 [0,1]。
  const LAYOUTS = ver >= 23
    ? [
        { lenOff: 32, stride: 80, uv: 72, bone: 40, weight: 56 },
        // [we-scene patch] 真 3D 网格（3509243656 恒星/天空盒）：MDLV0023 但顶点
        // 48B（pos@0 + nrm/tan + uv@40），没有骨骼权重。必须排在 80B puppet
        // 后面：puppet 的 80 能整除时优先走蒙皮布局。
        { lenOff: 32, stride: 48, uv: 40, bone: -1, weight: -1 },
      ]
    : [{ lenOff: 8, stride: 52, uv: 44, bone: 12, weight: 28 },
       { lenOff: 4, stride: 52, uv: 44, bone: 12, weight: 28 },
       // 兜底：未见过的中间版本按已知布局各试一次，取自洽的那个
       { lenOff: 32, stride: 80, uv: 72, bone: 40, weight: 56 }]
  let L = null
  let vertexBytes = 0
  let vbOff = 0
  for (const cand of LAYOUTS) {
    const off = mat.next + cand.lenOff
    if (off + 4 > buf.byteLength) continue
    const n = dv.getUint32(off, true)
    if (n > 0 && n % cand.stride === 0 && off + 4 + n <= buf.byteLength) {
      L = cand
      vertexBytes = n
      vbOff = off
      break
    }
  }
  if (!L) {
    throw new Error('顶点区长度异常（' + magic + '，已试 stride ' + LAYOUTS.map((c) => c.stride).join('/') + '）')
  }
  const vertStart = vbOff + 4
  const vertexCount = vertexBytes / L.stride

  const positions = new Float32Array(vertexCount * 3)
  const uvs = new Float32Array(vertexCount * 2)
  const boneIdx = new Float32Array(vertexCount * 4) // 顶点属性用 float 传（WebGL2 attribute）
  const weights = new Float32Array(vertexCount * 4)
  for (let i = 0; i < vertexCount; i++) {
    const b = vertStart + i * L.stride
    positions[i * 3] = dv.getFloat32(b, true)
    positions[i * 3 + 1] = dv.getFloat32(b + 4, true)
    positions[i * 3 + 2] = dv.getFloat32(b + 8, true)
    uvs[i * 2] = dv.getFloat32(b + L.uv, true)
    uvs[i * 2 + 1] = dv.getFloat32(b + L.uv + 4, true)
    if (L.bone >= 0 && L.weight >= 0) {
      for (let k = 0; k < 4; k++) {
        boneIdx[i * 4 + k] = dv.getUint32(b + L.bone + k * 4, true)
        weights[i * 4 + k] = dv.getFloat32(b + L.weight + k * 4, true)
      }
    } else {
      boneIdx[i * 4] = 0
      weights[i * 4] = 1
    }
  }

  const idxByteLen = dv.getUint32(vertStart + vertexBytes, true)
  const idxStart = vertStart + vertexBytes + 4
  // 真 3D 网格顶点常超过 65535（3509243656 地球 52 万顶点），索引是 u32。
  const useU32 = vertexCount > 65535 && idxByteLen % 4 === 0
  const indexCount = useU32 ? idxByteLen / 4 : idxByteLen / 2
  const indices = useU32 ? new Uint32Array(indexCount) : new Uint16Array(indexCount)
  if (useU32) {
    for (let i = 0; i < indexCount; i++) indices[i] = dv.getUint32(idxStart + i * 4, true)
  } else {
    for (let i = 0; i < indexCount; i++) indices[i] = dv.getUint16(idxStart + i * 2, true)
  }

  const bones = parseSkeleton(buf, dv)
  const animations = parseAnimations(buf, dv, bones.length)
  // MDLE0002（可选）：贴图空间的静止姿势。
  //   顶点按 MDLS 姿势烘焙，而 UV 对应的是 MDLE 姿势 —— 实测 lainpw 用
  //   World(MDLE) · World(MDLS)⁻¹ 变换顶点，结果与 UV 反推的贴图坐标误差为 0。
  //   动画关键帧 frame 0 恒等于 MDLS 局部矩阵，故动画仍以 MDLS 为基准；
  //   MDLE 只是把烘焙姿势"摆正"到贴图姿势的一次性校正。
  //   绝大多数模型无 MDLE 块，此时校正为单位变换。
  const restLocal = parseBindPose(buf, dv, bones)
  // [we-scene patch] MDAT0001（可选）：**骨骼附着点表**。
  // WE 用它把独立图层挂到 puppet 骨骼上：scene.json 侧的对象写
  // `attachment: "黑头"` + `parent: <puppet 层 id>`，语义是「该层跟随这个附着点
  // 所在的骨骼运动」。官方 Set Parent Attachment 后子层会跳到附着点。
  //
  // 世界 origin = 父 origin + 绑定姿势附着点（网格 Y-up）+ 子 local origin。
  // parse.js 的父子合并只做「父 origin + local」；附着点偏移要等 MDL 装好后
  // 由 applyAttachmentBindOrigins 补上（parse 阶段还没有网格）。
  //
  // 曾把附着点加到**已经合并过的** origin 上却用了错误的 Y 空间，3436945972「黑头」
  // 从 (945,983) 被推到 (1477,251) 飞出画面，当时误判为「不该加附着点」并回退。
  // 正确式子在 Y-up 下给黑头 (1314, 1477)，离脖子正好是它的 local (2, 79)。
  // 不加的话挂件相对父图层中心，3790987854 的头会偏到脖子右侧 ~2181px。
  //
  // 全库 18 个 mdl 有此块、56 个附着点、涉及 10+ 个壁纸。
  const attachments = parseAttachments(buf, dv, bones.length)

  // 蒙皮矩阵 = World(anim) · World(绑定姿势)⁻¹
  //
  // [we-scene patch] 「绑定姿势」取 **MDLS 骨架块的 bones[i].matrix（局部，累乘父链）**，
  // 不是主动画的 frame 0。
  //
  // 旧实现取 frame0，理由是「顶点按动画静止姿势烘焙」，判据是「静止偏移 vs 动画摆幅」。
  // 那个判据是**自证的**：非 additive 层在 blend=1 时把 base 整个替换掉，所以
  // 只要 invBindWorld 与 base 同源，t=0 的顶点位移**恒为 0**，不管选哪个姿势。
  // 全库 107 个 puppet 实测：frame0 方案 t=0 位移 100% 是 0.0px —— 这条判据无信息量。
  //
  // 有信息量的判据有两条，都指向 bones[i].matrix：
  //
  // 1) **烘焙姿势反推（决定性）**：顶点是在绑定姿势下烘焙的，所以每根骨的世界位置
  //    应当落在「它主导的顶点」的质心附近。全库 61 个（≥3 有效骨）实测平均距离：
  //      bone.matrix 局部累乘 = 102px   frame0 局部累乘 = 167px   bone.matrix 直接当世界 = 413px
  //    逐模型最优 51 / 6 / 4。差距最大的正是出问题的那批：
  //      3148125112 人物2  57px vs 1678px、腿1 197px vs 732px、3233141951 龙 120px vs 695px。
  //
  // 2) **三角形法向翻转**：面积比为负 = 真几何撕裂，正常模型恒为 0。
  //    全库翻转总数 frame0 = 3264，bone.matrix = 743。
  //    3113287126 WLOP DOME GIRL 2085 → 1，3148125112 腿1 375 → 0、人物2 43 → 0。
  //    （注意「单边拉伸比」不是有效判据：<30px 的短边在骨混合下天然放大到 10x 以上，
  //      正常模型也测得出，我一度据此误判。）
  //
  // 代价：frame0 ≠ 绑定姿势的那 20 个模型，t=0 不再回到原网格。这是**正确**的——
  // 动画起点本就不必是绑定姿势。
  //
  // 不要把「整段轨道几乎不变、却和 MDLS 差几百像素」的骨改写成 frame0 当 bind。
  // 3233141951「头」骨 4/8/12/14/18 就是这种：顶点按 MDLS 烘焙在图集边上（眼睛、
  // 碎发），frame0 才是拼到脸上的姿势。改 bind 后 t=0 蒙皮变恒等，眼睛停在
  // x≈800 而不是脸上 x≈229，包围盒看起来「没被挤扁」（1068 而不是 528），
  // 其实是图集散件没拼回去。脸部质心不变，头发图层对得齐；「挤扁」不是缺陷。
  const invBindWorld = []
  const restCorrection = []
  // 绑定姿势的 **TRS 九分量**，与 invBindWorld 同源。
  // computeSkinMatrices 的 base 必须取这里，不能另算一套 —— 见 bindTRS 的注释。
  const bindTRS9 = []
  if (bones.length > 0) {
    const baseLocal = bones.map((b, i) => {
      // 绑定矩阵分解回 TRS（2D 场景 rx/ry 恒为 0，rz 由第一列的辐角给出）
      const m = b.matrix
      const sx = Math.hypot(m[0], m[1])
      const sy = Math.hypot(m[4], m[5])
      bindTRS9[i] = Float32Array.from([
        m[12], m[13], m[14],
        0, 0, Math.atan2(m[1], m[0]),
        sx || 1, sy || 1, m[10] || 1,
      ])
      return Float32Array.from(m)
    })
    // 被改写的骨必须用同一套 TRS 重建局部矩阵，否则 invBindWorld 又和 bindTRS 分叉
    for (let i = 0; i < bones.length; i++) {
      const b = bindTRS9[i]
      const m = bones[i].matrix
      if (Math.hypot(b[0] - m[12], b[1] - m[13]) > 1e-3) {
        baseLocal[i] = composeTRS(b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], b[8], new Float32Array(16))
      }
    }
    const bindWorld = []
    for (let i = 0; i < bones.length; i++) {
      const p = bones[i].parent
      bindWorld[i] =
        p >= 0 && p < i ? mat4Mul(bindWorld[p], baseLocal[i]) : Float32Array.from(baseLocal[i])
    }
    for (let i = 0; i < bones.length; i++) invBindWorld[i] = mat4Invert(bindWorld[i])

    if (restLocal) {
      const restWorld = []
      for (let i = 0; i < bones.length; i++) {
        const p = bones[i].parent
        restWorld[i] =
          p >= 0 && p < i ? mat4Mul(restWorld[p], restLocal[i]) : Float32Array.from(restLocal[i])
      }
      // correction = World(MDLE) · World(绑定)⁻¹（仅供 bench 校验页参考，不进蒙皮）
      for (let i = 0; i < bones.length; i++) {
        restCorrection[i] = mat4Mul(restWorld[i], invBindWorld[i])
      }
    }
  }

  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (let i = 0; i < vertexCount; i++) {
    const x = positions[i * 3]
    const y = positions[i * 3 + 1]
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }

  return {
    magic,
    materialPath: mat.value,
    vertexCount,
    positions,
    uvs,
    boneIdx,
    weights,
    indexCount,
    indexType: useU32 ? 'u32' : 'u16',
    indices,
    bones,
    animations,
    // 动画平移极值（见 animDisplacementBound）：供渲染器放宽视锥裁剪余量
    animBound: animDisplacementBound(animations, bones),
    invBindWorld,
    bindTRS: bindTRS9.length > 0 ? bindTRS9 : null,
    attachments: attachments.length > 0 ? attachments : null,
    restCorrection: restCorrection.length > 0 ? restCorrection : null,
    bounds: { minX, maxX, minY, maxY },
  }
}

// [we-scene patch] MDAT0001：骨骼附着点表。实测布局（全库 18 个 mdl 全部自洽）：
//   magic(8) "MDAT0001" | u8 flag | u32 nextOff | u16 count
//   每条：u16 boneIndex | UTF-8 名字（null 结尾）| 16 个 float32 局部矩阵
// 校验：18/18 个含 MDAT 的 mdl 按此布局都能读出与 count 完全一致的条数，
// 且 56 个附着点的骨号**无一越界**；名字与 scene.json 的 `attachment` 字段对得上
// （"黑头" / "头" / "Sparkle" / "音频封面1" …）。
function parseAttachments(buf, dv, boneCount) {
  const a = findAscii(buf, 'MDAT')
  if (a < 0) return []
  const count = dv.getUint16(a + 13, true)
  if (count <= 0 || count > 256) return []
  const out = []
  let j = a + 15
  for (let k = 0; k < count; k++) {
    if (j + 2 > buf.length) break
    const bone = dv.getUint16(j, true)
    const nm = readCStr(dv, j + 2)
    if (nm.next + 64 > buf.length) break
    const matrix = new Float32Array(16)
    for (let t = 0; t < 16; t++) matrix[t] = dv.getFloat32(nm.next + t * 4, true)
    // 骨号越界的条目丢掉而不是整表放弃：宁可少挂一个挂件，也不要整组附着失效
    if (bone < boneCount) out.push({ bone, name: nm.value, matrix })
    j = nm.next + 64
  }
  return out
}

// MDLS0004：魔数(8) + u8 + u32 nextOff + u32 boneCount，逐骨可变长条目
function parseSkeleton(buf, dv) {
  const s = findAscii(buf, 'MDLS')
  if (s < 0) return []
  const boneCount = dv.getUint32(s + 13, true)
  if (boneCount <= 0 || boneCount > 1024) return []
  const bones = []
  let j = s + 17
  for (let b = 0; b < boneCount; b++) {
    if (j + 77 > dv.byteLength) return bones
    const id = dv.getUint32(j + 1, true)
    const parent = dv.getInt32(j + 5, true)
    const matrix = new Float32Array(16)
    for (let k = 0; k < 16; k++) matrix[k] = dv.getFloat32(j + 13 + k * 4, true)
    const meta = readCStr(dv, j + 13 + 64)
    bones.push({ id, parent: parent >= 0 && parent < boneCount ? parent : -1, matrix })
    j = meta.next
  }
  return bones
}

// MDLA0006：魔数(8) + u8 + u32 endPos + u32 animCount，逐动画（末尾 35B 填充）
function parseAnimations(buf, dv, boneCount) {
  const a = findAscii(buf, 'MDLA')
  if (a < 0) return []
  let o = a + 9
  const endPos = dv.getUint32(o, true)
  o += 4
  const animCount = dv.getUint32(o, true)
  o += 4
  if (animCount <= 0 || animCount > 256) return []
  const anims = []
  for (let ai = 0; ai < animCount; ai++) {
    if (o + 16 > dv.byteLength) break
    const id = dv.getUint32(o, true)
    o += 8 // id + unknown
    const nameR = readCStr(dv, o)
    o = nameR.next
    const modeR = readCStr(dv, o)
    o = modeR.next
    if (o + 16 > dv.byteLength) break
    const fps = dv.getFloat32(o, true)
    o += 4
    const frameCount = dv.getUint32(o, true)
    o += 8 // frameCount + unknown
    const trackCount = dv.getUint32(o, true)
    o += 4
    if (trackCount > 1024) break
    const tracks = []
    for (let t = 0; t < trackCount; t++) {
      if (o + 8 > dv.byteLength) break
      o += 4 // boneId 字段实测恒为 0，轨顺序即骨骼顺序
      const trackBytes = dv.getUint32(o, true)
      o += 4
      const n = Math.floor(trackBytes / 36)
      if (o + trackBytes > dv.byteLength) break
      // 关键帧扁平化为 [tx,ty,tz, qx,qy,qz,qw, sx,sy] × n
      const kf = new Float32Array(n * 9)
      for (let f = 0; f < n; f++) {
        const p = o + f * 36
        for (let k = 0; k < 9; k++) kf[f * 9 + k] = dv.getFloat32(p + k * 4, true)
      }
      o += trackBytes
      tracks.push({ frameCount: n, keyframes: kf })
    }
    o += 35 // 动画条目末尾填充
    if (tracks.length > 0 && frameCount > 0 && fps > 0) {
      anims.push({
        id,
        name: nameR.value,
        mode: modeR.value,
        fps,
        frameCount,
        duration: frameCount / fps,
        tracks,
      })
    }
    if (o >= endPos) break
  }
  void boneCount
  return anims
}

// [we-scene patch] 动画能把网格推出多远（相对绑定姿势的平移极值，单边最大外扩量）。
//
// 用途只有一个：视锥裁剪。`isLayerOffscreen` 只看图层**静态** origin，可 puppet 的
// 网格是被骨骼动画推着走的 —— 2477602742 的三节火车 origin 分别在 x=5613 / 11478 /
// 17315，而场景只有 2560 宽，静态判定下**永远**在屏外、每帧被 continue 掉；但它们的
// 动画会在 360 帧循环里把根骨从 +102 拉到 -17944，正是这段位移让火车从右侧驶入、
// 穿过道口、再从左侧离场（第 28~33 秒，与 trainsound 的 "vrom" 音量曲线在
// 26/28/30/32 帧的起落完全对齐）。
// 症状就是「火车动画没实现」：道口灯会闪、栏杆会落、汽笛会响，唯独没有车。
//
// 只算一次并挂在 mdl 上（动画数据是静态的），由渲染器加进裁剪余量。
function animDisplacementBound(anims, bones) {
  let x = 0
  let y = 0
  for (const a of anims) {
    for (let bi = 0; bi < a.tracks.length; bi++) {
      const tr = a.tracks[bi]
      if (!tr) continue
      const bone = bones[bi]
      const bx = bone ? bone.matrix[12] : 0
      const by = bone ? bone.matrix[13] : 0
      const k = tr.keyframes
      for (let f = 0; f < tr.frameCount; f++) {
        const dx = Math.abs(k[f * 9] - bx)
        const dy = Math.abs(k[f * 9 + 1] - by)
        if (dx > x) x = dx
        if (dy > y) y = dy
      }
    }
  }
  return { x, y }
}

// MDLE0002：魔数(8) + u8 + u32 endPos + u32 byteSize + 每骨 64B 绑定姿势局部矩阵
// 顶点数据按这套姿势的世界变换烘焙，故它才是蒙皮的绑定基准；缺失时用 MDLS。
function parseBindPose(buf, dv, bones) {
  if (bones.length === 0) return null
  const e = findAscii(buf, 'MDLE')
  if (e < 0) return null
  const bj = e + 8 + 1 + 4 + 4
  if (bj + bones.length * 64 > dv.byteLength) return null
  const out = []
  for (let b = 0; b < bones.length; b++) {
    const m = new Float32Array(16)
    for (let k = 0; k < 16; k++) m[k] = dv.getFloat32(bj + b * 64 + k * 4, true)
    out.push(m)
  }
  return out
}
