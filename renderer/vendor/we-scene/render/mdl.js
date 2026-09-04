// [we-scene patch] MDL（Puppet Warp 骨骼网格）解析与渲染
//
// 格式（逆向自本机壁纸库 23 个 MDLV0023 模型，全部校验通过）：
//
//   MDLV0023 头
//     0x00  char[8]   "MDLV0023"
//     0x15  cstr      材质路径（如 "materials/01腿-后.json"）
//     +32   u32       顶点区字节数（= vertexCount × 80）★ 相对材质路径 null 之后
//             顶点 80B：pos vec3 @0 / boneIdx u32×4 @40 / weights f32×4 @56 / uv vec2 @72
//     后接  u32       索引区字节数，随后 u16 索引
//
//   MDLS0004 骨架（魔数 + u8 + u32 nextOff + u32 boneCount，逐骨条目）
//     每骨：u8 flag / u32 id / i32 parent / u32 matSize(=64) / f32[16] 绑定矩阵 / cstr JSON
//     绑定矩阵为**列主序**（平移在 [12],[13],[14]），与 WebGL 一致。
//
//   MDLA0006 动画（魔数 + u8 + u32 endPos + u32 animCount，逐动画条目）
//     每动画：u32 id / u32 unk / cstr 名称 / cstr 模式("loop") / f32 fps
//             u32 frameCount / u32 unk / u32 trackCount
//             每轨：u32 boneId / u32 trackBytes / 关键帧×(trackBytes/36)
//               关键帧 36B：f32[3] 平移 / f32[4] 四元数 xyzw / f32[2] 缩放 xy
//             动画条目末尾固定 35B 填充（据此 endPos 与实际游标精确吻合）
//     关键帧存**绝对局部变换**：frame 0 的平移与绑定矩阵平移完全相等
//     ⇒ 蒙皮矩阵 = World(anim) · World(bind)⁻¹，frame 0 为单位变换。
//
// 网格坐标 = 图层局部像素、**Y 轴朝上**；UV 与之精确对应：
//     u = (x + W/2) / W ,  v = (H/2 - y) / H   （W/H = 图层 size，实测误差 0）
// 因此渲染时把 y 取反即回到 y-down 的场景世界空间（与 renderer.js 的层空间一致）。
//
// 历史 bug（导致「人物不动 + 贴图错乱」）：
//   1) 顶点区偏移硬编码 0x47，实际为「材质路径长度 + 32」，材质路径长短不同即错位
//      → 顶点/UV 全部读到错误字节 = 贴图错乱；
//   2) 骨骼矩阵按行主序解读（实为列主序），且要求 MDLE 块存在，
//      多数模型没有 MDLE 便直接返回未蒙皮顶点；
//   3) MDLA 动画块完全未解析 = 人物不动。

// [we-scene patch] 模块结构（本仓库拆分，见 docs/ARCHITECTURE.md）：
//   mdl-math.js  列主序 4x4 工具 + 二进制读取原语
//   mdl-parse.js MDLV/MDLS/MDLA/MDLE 二进制解析
//   mdl-skin.js  关键帧采样 + 蒙皮矩阵求值
//   mdl.js       本文件：GPU 预算 + shader 源 + createMDLRenderer + 公共出口
// 以下 re-export 维持既有 import 方（main.ts / verify-*.mjs）的路径不变。
import { parseMDL } from './mdl-parse.js'
import { computeSkinMatrices, bindWorldOf, mat4MulOut, attachmentWorld, attachmentBind, parentMeshToWorldDelta, applyAttachmentBindOrigins, followAttachments } from './mdl-skin.js'
import { IDENTITY } from './mdl-math.js'

// ---------- 渲染 ----------

// 蒙皮上限。此前设为 24 并注明「实测最多 16 骨」，实际本机库里 WLOP DOME GIRL 有 64 骨、
// Lucy 有 61 骨：超限骨骼在顶点着色器里被 `bi >= u_boneCount` 跳过，权重丢失，
// 顶点落到错误位置 —— 表现为人物五官/头发/躯体撕裂错位。
//
// WebGL2 只保证 MAX_VERTEX_UNIFORM_VECTORS ≥ 256 个 vec4（mat4 占 4 个 → 64 骨），
// 但实测本机 ANGLE/Metal 上报 1024。故不写死上限：createMDLRenderer 按 GPU 实际
// 上报值算出可用骨数（留 32 个 vec4 给 u_mvp 等），链接失败时逐级减半回退。
const MAX_BONES_HARD_CAP = 128
const MAX_BONES_FLOOR = 24

function boneBudget(gl) {
  const vecs = gl.getParameter(gl.MAX_VERTEX_UNIFORM_VECTORS) || 256
  const usable = Math.floor((vecs - 32) / 4)
  return Math.max(MAX_BONES_FLOOR, Math.min(MAX_BONES_HARD_CAP, usable))
}

// 顶点着色器在 GPU 上做蒙皮。网格坐标为「图层局部像素、y 轴朝上」，
// u_mvp 由宿主构造（含 y 方向、图层旋转缩放、场景投影），故这里直传 xy 即可。
// UV 恒等直传：朝向差异一律由 u_mvp 的几何翻转表达，翻 UV 会把贴图镜像到未翻转的网格上。
const mdlVertSrc = (maxBones) => `#version 300 es
in vec3 a_pos;
in vec2 a_uv;
in vec4 a_bone;
in vec4 a_weight;
uniform mat4 u_mvp;
uniform mat4 u_skin[${maxBones}];
uniform int u_boneCount;
out vec2 v_uv;
void main() {
  vec4 p = vec4(a_pos, 1.0);
  vec4 skinned = vec4(0.0);
  float total = 0.0;
  if (u_boneCount > 0) {
    for (int i = 0; i < 4; i++) {
      float w = a_weight[i];
      if (w <= 0.0) continue;
      int bi = int(a_bone[i]);
      if (bi < 0 || bi >= u_boneCount) continue;
      skinned += (u_skin[bi] * p) * w;
      total += w;
    }
  }
  vec4 local = total > 0.0 ? skinned / total : p;
  gl_Position = u_mvp * vec4(local.xy, 0.0, 1.0);
  v_uv = a_uv;
}`

// UV 对层 FBO 同样是恒等的，不要在这里翻 v。层 FBO 虽然「视觉上倒置」
// （NDC 顶存的是图像底行，见 renderer.js 的 layerQuadVerts），但写入时用的
// 就是源贴图的 v：NDC 顶那一行由 v=1 的顶点写入。于是采样恒有
// FBO(v) == 源贴图(v)，效果链是就地变换、不改变 UV 语义。
// 实测翻了会让腿采样到空白区域直接消失、人物2 碎成一片。
const MDL_FRAG = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec4 u_color;
out vec4 fragColor;
void main() {
  vec4 t = texture(u_tex, v_uv);
  fragColor = t * u_color;
}`

export function createMDLRenderer(gl) {
  const compile = (type, src) => {
    const s = gl.createShader(type)
    gl.shaderSource(s, src)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error('MDL 着色器编译失败: ' + gl.getShaderInfoLog(s))
    }
    return s
  }
  // 按 GPU 上报的 uniform 预算编译；链接失败（驱动实际容量更小）时逐级减半重试
  let maxBones = boneBudget(gl)
  let prog = null
  for (;;) {
    const p = gl.createProgram()
    let linked = false
    try {
      gl.attachShader(p, compile(gl.VERTEX_SHADER, mdlVertSrc(maxBones)))
      gl.attachShader(p, compile(gl.FRAGMENT_SHADER, MDL_FRAG))
      gl.bindAttribLocation(p, 0, 'a_pos')
      gl.bindAttribLocation(p, 1, 'a_uv')
      gl.bindAttribLocation(p, 2, 'a_bone')
      gl.bindAttribLocation(p, 3, 'a_weight')
      gl.linkProgram(p)
      linked = !!gl.getProgramParameter(p, gl.LINK_STATUS)
    } catch (e) {
      linked = false
    }
    if (linked) { prog = p; break }
    gl.deleteProgram(p)
    if (maxBones <= MAX_BONES_FLOOR) {
      throw new Error('MDL 着色器链接失败（骨数已降到 ' + MAX_BONES_FLOOR + '）')
    }
    maxBones = Math.max(MAX_BONES_FLOOR, maxBones >> 1)
  }
  const MAX_BONES = maxBones

  const uni = {
    mvp: gl.getUniformLocation(prog, 'u_mvp'),
    tex: gl.getUniformLocation(prog, 'u_tex'),
    skin: gl.getUniformLocation(prog, 'u_skin'),
    boneCount: gl.getUniformLocation(prog, 'u_boneCount'),
    color: gl.getUniformLocation(prog, 'u_color'),
  }
  const identitySkin = new Float32Array(MAX_BONES * 16)
  for (let i = 0; i < MAX_BONES; i++) identitySkin.set(IDENTITY, i * 16)

  // 每个网格一套 VAO/VBO（顶点数据静态，蒙皮在 GPU 完成）
  const meshes = new WeakMap()
  function ensureMesh(mdl) {
    let m = meshes.get(mdl)
    if (m) return m
    const vao = gl.createVertexArray()
    gl.bindVertexArray(vao)
    const n = mdl.vertexCount
    // 交错：pos(3) uv(2) bone(4) weight(4) = 13 float / 52B
    const data = new Float32Array(n * 13)
    for (let i = 0; i < n; i++) {
      const o = i * 13
      data[o] = mdl.positions[i * 3]
      data[o + 1] = mdl.positions[i * 3 + 1]
      data[o + 2] = mdl.positions[i * 3 + 2]
      data[o + 3] = mdl.uvs[i * 2]
      data[o + 4] = mdl.uvs[i * 2 + 1]
      for (let k = 0; k < 4; k++) {
        data[o + 5 + k] = mdl.boneIdx[i * 4 + k]
        data[o + 9 + k] = mdl.weights[i * 4 + k]
      }
    }
    const vbuf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, vbuf)
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW)
    const S = 52
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, S, 0)
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, S, 12)
    gl.enableVertexAttribArray(2)
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, S, 20)
    gl.enableVertexAttribArray(3)
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, S, 36)
    const ibuf = gl.createBuffer()
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibuf)
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mdl.indices, gl.STATIC_DRAW)
    gl.bindVertexArray(null)
    m = { vao, vbuf, ibuf }
    meshes.set(mdl, m)
    return m
  }

  return {
    gl,
    prog,
    maxBones: MAX_BONES,
    upload(mdl) {
      ensureMesh(mdl)
    },
    // opts: { color:[r,g,b,a], time, animLayers, blending, overrideTex }
    // overrideTex：puppet 层跑过效果链时采样源是链尾 FBO 的纹理，而不是原始贴图
    // （效果在贴图空间合成，见 renderer.js 中部那段长注释）。传裸 WebGLTexture。
    draw(mvp, mdl, opts, texture) {
      const m = ensureMesh(mdl)
      gl.useProgram(prog)
      gl.bindVertexArray(m.vao)
      gl.activeTexture(gl.TEXTURE0)
      const src = opts.overrideTex || (texture && texture.glTex ? texture.glTex : texture)
      gl.bindTexture(gl.TEXTURE_2D, src)
      gl.uniform1i(uni.tex, 0)
      gl.uniformMatrix4fv(uni.mvp, false, mvp)
      const col = opts.color || [1, 1, 1, 1]
      gl.uniform4f(uni.color, col[0], col[1], col[2], col[3])
      const skin = computeSkinMatrices(mdl, opts.time || 0, opts.animLayers, opts.boneOverrides)
      const count = Math.min(mdl.bones.length, MAX_BONES)
      if (skin && count > 0) {
        gl.uniformMatrix4fv(uni.skin, false, skin.subarray(0, count * 16))
        gl.uniform1i(uni.boneCount, count)
      } else {
        gl.uniformMatrix4fv(uni.skin, false, identitySkin)
        gl.uniform1i(uni.boneCount, 0)
      }
      if (opts.blending === 'additive') {
        gl.enable(gl.BLEND)
        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.ONE, gl.ONE)
      } else if (opts.blending === 'normal') {
        gl.disable(gl.BLEND)
      } else {
        gl.enable(gl.BLEND)
        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
      }
      const idxType = mdl.indexType === 'u32' ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT
      gl.drawElements(gl.TRIANGLES, mdl.indexCount, idxType, 0)
      gl.bindVertexArray(null)
    },
  }
}

export { parseMDL, computeSkinMatrices, bindWorldOf, mat4MulOut, attachmentWorld, attachmentBind, parentMeshToWorldDelta, applyAttachmentBindOrigins, followAttachments }
