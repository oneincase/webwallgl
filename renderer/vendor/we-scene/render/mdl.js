// [we-scene patch] MDL（Puppet Warp 骨骼网格）解析与渲染
// 格式（逆向自本机壁纸库 23 个 MDLV0023 模型，全部校验通过）：
//   MDLV0023 头
//     0x00  char[8]   "MDLV0023"
//     0x15  cstr      材质路径（如 "materials/01腿-后.json"）
//     +32   u32       顶点区字节数（= vertexCount × 80）★ 相对材质路径 null 之后
//             常见顶点 80B：pos vec3 @0 / boneIdx u32×4 @40 / weights f32×4 @56 / uv vec2 @72
//             新版 84B（formatMarker 0x0181000e）：boneIdx@44 / weights@60 / uv@76
//     后接  u32       索引区字节数，随后 u16 索引
//   MDLS0004 骨架（魔数 + u8 + u32 nextOff + u32 boneCount，逐骨条目）
//     每骨：u8 flag / u32 id / i32 parent / u32 matSize(=64) / f32[16] 绑定矩阵 / cstr JSON
//     绑定矩阵为**列主序**（平移在 [12],[13],[14]），与 WebGL 一致。
//   MDLA0006 动画（魔数 + u8 + u32 endPos + u32 animCount，逐动画条目）
//     每动画：u32 id / u32 unk / cstr 名称 / cstr 模式("loop") / f32 fps
//             u32 frameCount / u32 unk / u32 trackCount
//             每轨：u32 boneId / u32 trackBytes / 关键帧×(trackBytes/36)
//               关键帧 36B：f32[3] 平移 / f32[4] 四元数 xyzw / f32[2] 缩放 xy
//             动画条目末尾固定 35B 填充（据此 endPos 与实际游标精确吻合）
//     关键帧存**绝对局部变换**：frame 0 的平移与绑定矩阵平移完全相等
//     ⇒ 蒙皮矩阵 = World(anim) · World(bind)⁻¹，frame 0 为单位变换。
// 网格坐标 = 图层局部像素、**Y 轴朝上**；UV 与之精确对应：
//     u = (x + W/2) / W ,  v = (H/2 - y) / H   （W/H = 图层 size，实测误差 0）
// 因此渲染时把 y 取反即回到 y-down 的场景世界空间（与 renderer.js 的层空间一致）。
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
import { linkProgram } from './gl-util.js'
import { computeSkinMatrices, bindWorldOf, mat4MulOut, attachmentWorld, attachmentBind, attachmentEffectiveOffset, parentMeshToWorldDelta, applyAttachmentBindOrigins, followAttachments, skinnedMeshes } from './mdl-skin.js'
import { IDENTITY } from './mdl-math.js'


// 蒙皮上限。此前设为 24 并注明「实测最多 16 骨」，实际本机库里 WLOP DOME GIRL 有 64 骨、
// Lucy 有 61 骨：超限骨骼在顶点着色器里被 `bi >= u_boneCount` 跳过，权重丢失，
// 顶点落到错误位置 —— 表现为人物五官/头发/躯体撕裂错位。
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
// u_mvp 由宿主构造（含 y 方向、图层旋转缩放、场景投影）。
// u_keepZ：顶点 z 是否参与投影。**默认 0 = 压平到 z=0**，这是 2D puppet 的正确行为
// —— 那类网格坐标是图层局部像素，z 只是建模残留（本机库 3737267090 的
// 人物网格 z∈[111,435]，是「贴图平面」之外的建模偏移，放过去会让它按深度被
// 其它层挡住）。透视场景（3509243656 三体）里的真 3D 网格必须保留 z，否则
// 球体被压成过相机的一张薄片：天空盒（半径 8 的球心就在相机上）只剩一条边、
// 星空铺不满，星芒球变成边缘朝上的小点 —— 整个画面近乎全黑。
// UV 恒等直传：朝向差异一律由 u_mvp 的几何翻转表达，翻 UV 会把贴图镜像到未翻转的网格上。
const mdlVertSrc = (maxBones) => `#version 300 es
in vec3 a_pos;
in vec2 a_uv;
in vec4 a_bone;
in vec4 a_weight;
in vec3 a_normal;
uniform mat4 u_mvp;
uniform mat3 u_normalMat;
uniform mat4 u_skin[${maxBones}];
uniform int u_boneCount;
uniform float u_keepZ;
uniform vec2 u_partScale;
uniform vec2 u_partPivot;
uniform mat4 u_model;
out vec2 v_uv;
out vec3 v_wnormal;
out highp vec3 v_wpos;
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
  // [we-scene patch 2026-09-28] 每零件竖直缩放（「被收拢的零件盖住」时同步压扁，见 collapsedPartSquash）
  local.xy = u_partPivot + (local.xy - u_partPivot) * u_partScale;
  vec4 lp = vec4(local.xy, local.z * u_keepZ, 1.0);
  gl_Position = u_mvp * lp;
  // 世界坐标只给场景雾用（官方 generic4.vert 的 v_ViewDir = g_EyePosition - worldPos）
  v_wpos = (u_model * lp).xyz;
  v_uv = a_uv;
  // [we-scene patch 2026-09-28] 3D 网格的光照法线（世界向）。u_normalMat 由宿主按
  // 图层世界矩阵的旋转部分给（见 draw 的 opts.normalMat）。2D puppet 没有法线属性，
  // 属性槽喂的是常量 (0,0,1)，且 u_lightOn=0 时片元里整段光照被短路，逐位不影响。
  v_wnormal = u_normalMat * a_normal;
}`

// UV 对层 FBO 同样是恒等的，不要在这里翻 v。层 FBO 虽然「视觉上倒置」
// （NDC 顶存的是图像底行，见 renderer.js 的 layerQuadVerts），但写入时用的
// 就是源贴图的 v：NDC 顶那一行由 v=1 的顶点写入。于是采样恒有
// FBO(v) == 源贴图(v)，效果链是就地变换、不改变 UV 语义。
// 实测翻了会让腿采样到空白区域直接消失、人物2 碎成一片。
const MDL_FRAG = `#version 300 es
precision mediump float;
in vec2 v_uv;
in vec3 v_wnormal;
uniform sampler2D u_tex;
uniform vec4 u_color;
// [we-scene patch 2026-09-28] 场景光照（**只对带法线的真 3D 网格生效**）：
//   base = 场景 ambientcolor（作者素材实测：背光面 = 反照率 × ambientcolor，3281559867
//          舞台墙面 0.58×、贴图均值 233 → 135）
//   add  = 平行光 color × intensity × K（K 见 scene-mount 的 SCENE_LIGHT_K）
//   结果 = clamp(base + add × max(0, N·L), 0, 1)
// u_lightOn = 0 时逐位等价于改动前（t * u_color）。
uniform vec3 u_lightDir;
uniform vec3 u_lightBase;
uniform vec3 u_lightAdd;
uniform float u_lightOn;
// [we-scene patch 2026-10-05] 场景雾（官方 common_fog.h 逐条对齐，generic4 默认 FOG=1）。
// Params = (start, end-start, startDensity, endDensity-startDensity)：
//   t = saturate((d - start) / (end - start))，混合系数 = startDensity + Δdensity·t²
// d = 到眼点的距离（距离雾）/ 世界 y（高度雾）。u_fogOn = 0 时整段短路，逐位等价旧行为。
in highp vec3 v_wpos;
uniform float u_fogOn;
uniform float u_fogAdditive;
uniform highp vec3 u_eye;
uniform highp vec4 u_fogDist;
uniform vec3 u_fogDistColor;
uniform highp vec4 u_fogHeight;
uniform vec3 u_fogHeightColor;
out vec4 fragColor;
vec4 applySceneFog(vec4 c) {
  float fd = 0.0;
  float fh = 0.0;
  if (u_fogHeight.y != 0.0) {
    float t = clamp((v_wpos.y - u_fogHeight.x) / u_fogHeight.y, 0.0, 1.0);
    fh = u_fogHeight.z + u_fogHeight.w * t * t;
    c.rgb = mix(c.rgb, u_fogHeightColor, fh);
  }
  if (u_fogDist.y != 0.0) {
    float t = clamp((length(u_eye - v_wpos) - u_fogDist.x) / u_fogDist.y, 0.0, 1.0);
    fd = u_fogDist.z + u_fogDist.w * t * t;
    c.rgb = mix(c.rgb, u_fogDistColor, fd);
  }
  if (u_fogAdditive > 0.5) {
    float f = clamp(max(fd, fh), 0.0, 1.0);
    c.a *= 1.0 - f * f;
  }
  return c;
}
void main() {
  vec4 t = texture(u_tex, v_uv);
  // [we-scene patch 2026-10-04] **全透明的像素不是遮挡物**（F50）。
  //
  // 3477054430（Cat with headphones on the roof）的树是「卡片网格」：贴图 65% 的像素
  // alpha=0（树冠四周的画布留白），而树卡片在层序上排在楼房网格**之前**。alpha=0 的像素
  // 颜色贡献本来就是 0（SRC_ALPHA 混合下），但它们照写深度 ⇒ 后画的楼房整片被 LEQUAL
  // 拒掉，画面上就是「每棵树四周一个黑方块」（用户报「树图层黑色方块」）。实测定界：
  // 把该网格贴图换成纯透明洋红 1×1，区域里洋红 0%、黑洞反而更大 —— 证明颜色走的是
  // 混合、深度照写。
  //
  // 只在**完全**透明（含图层 alpha）时 discard：实心/半透明边缘照旧写深度，所以
  // 猫与城市之间的层间遮挡（F49）不受影响，作者画的柔边也保留。官方 generic4.frag
  // 的 ALPHATOCOVERAGE 分支做的是同一件事（阈值 0.5 + fwidth 抗锯齿），我们取更保守的
  // 阈值以免把柔边整圈削成硬边（官方那条留给 ALPHATOCOVERAGE combo 真正接上时再用）。
  if (t.a * u_color.a < 0.004) discard;
  vec3 mul = vec3(1.0);
  if (u_lightOn > 0.5) {
    vec3 n = normalize(v_wnormal);
    float ndl = max(dot(n, normalize(u_lightDir)), 0.0);
    // 只钳下界，**不钳上界**：作者素材里受光面就是过 1 的（棋盘/草地实测 1.2×），
    // 钳到 1 会正好把它压成「不亮的白」。非 HDR 目标写帧缓冲时由 GL 自然截断，
    // 与钳上界等价；HDR 场景则进 RGBA16F 交给 bloom/tonemap，与 WE 同一条路。
    mul = max(u_lightBase + u_lightAdd * ndl, 0.0);
  }
  fragColor = t * u_color * vec4(mul, 1.0);
  if (u_fogOn > 0.5) fragColor = applySceneFog(fragColor);
}`

// [we-scene patch 2026-10-07] 不再按壁纸 ID 开门。2026-09-28 的白名单只有两张，
// 新眼组闭眼时眼球仍露在外面。全库 201 个带部件的 puppet 按「每根骨骼缩放幅度最低的一帧」
// 重采样后，分水岭是网格静止长边：眼组图层最大 767（13眼组），全身/头发最小 1017（花火）。
// 900 落在这道空隙里。全身网格只留下静止长边 ≤110 且同帧不超过 3 个的命中
// （Lucy 62、蕾塞 79 是眼球；151px 的躯干块和花火脸上那一串都进不来）。
/** 是否跑「被收拢的零件盖住 → 同步压扁」。收口在 collapsedPartSquash 里，不看壁纸 ID。 */
export function shouldSyncCoveredParts(_workshopId) {
  return true
}


/**
 * [we-scene patch 2026-09-28] 该网格是否出现**真正的零件塌陷**（高度压到静止的 80% 以下）。
 *
 * 为什么用它代替白名单：全库配对表（`docs/CASEBOOK.md`「配对表」小节）显示，
 * 「塌陷件↔刚性件」这种几何配对在身体/头发/披风里同样成立（15+ 张误伤），
 * 但**它们的覆盖件只是抖到 0.94~0.98**；而真正闭眼的眼睑是压到 **0.47~0.65**。
 * 也就是说「有没有零件被压扁」这件事本身就是分水岭——比任何尺寸/比例阈值都干净，
 * 而且不依赖壁纸 ID。判据只在能算出「深压」的网格上生效，其余模型零影响。
 * 结果按网格缓存（`mdl._deepCollapse`），只在首帧算一次（16 个采样点）。
 */
function hasDeepPartCollapse(mdl, animLayers) {
  if (mdl._deepCollapse !== undefined) return mdl._deepCollapse
  mdl._deepCollapse = false
  const parts = mdl.parts
  if (!parts || parts.length < 2 || !mdl.animations.length) return false
  const pos = mdl.positions
  const idx = mdl.boneIdx
  const wts = mdl.weights
  // **不要**只用「当前可见的动画层」判定：脚本会在装配后改可见性/播放态，
  // 首帧拿到的是空的层列表就会把 _deepCollapse 永久记成 false（实测 3655429099
  // 因此「又没压扁」）。改为「配置层 + 每条 clip 单独」都扫一遍，结果取或。
  const candidates = []
  if (animLayers && animLayers.length) candidates.push(animLayers)
  for (const a of mdl.animations) candidates.push([{ animation: a.id, visible: true, additive: false, blend: 1, rate: 1 }])
  // 扫的时候**不能**动 mdl._skin：draw() 刚拿到的 skin 就是它的同一个引用，
  // 覆盖了下游就会用错误姿势上传 uniform。临时换成独立缓冲，扫完还原。
  const savedSkin = mdl._skin
  mdl._skin = mdl._deepSkin || (mdl._deepSkin = new Float32Array(mdl.bones.length * 16))
  try {
    for (const layers of candidates) {
      const maxDur = Math.max(1e-3, ...layers.map((L) => {
        const a = mdl.animations.find((x) => x.id === L.animation)
        return a ? a.duration : 0
      }))
      // 均匀 16 点会漏掉短眨眼：3808922316 的闭眼只有第 82–88 帧（0.2 秒），
      // 10 秒片段上 16 个点全部落在窗外，深压被记成 false，之后整段动画都不再补偿。
      // 每根骨骼再补它自己 |sx|/|sy| 最低的那一帧（眼睑经常压的是本地 X）。
      const times = new Set()
      for (let si = 0; si < 16; si++) times.add((maxDur * si) / 16)
      for (const L of layers) {
        const a = mdl.animations.find((x) => x.id === L.animation)
        if (!a || !a.tracks) continue
        const fps = a.fps > 0 ? a.fps : 30
        for (const tr of a.tracks) {
          const kf = tr.keyframes
          if (!kf) continue
          const n = tr.frameCount || kf.length / 9
          let best = 1
          let bestF = 0
          for (let f = 0; f < n; f++) {
            const mag = Math.min(Math.abs(kf[f * 9 + 7]), Math.abs(kf[f * 9 + 8]))
            if (mag < best) { best = mag; bestF = f }
          }
          if (best < 0.85) times.add(bestF / fps)
        }
      }
      for (const t of times) {
        if (mdl._deepCollapse) break
        computeSkinMatrices(mdl, t, layers)
        const skin = mdl._skin
        for (const part of parts) {
          const restH = part.y1 - part.y0
          if (!(restH > 1e-3)) continue
          let y0 = Infinity
          let y1 = -Infinity
          for (let vi = 0; vi < part.verts.length; vi++) {
            const v = part.verts[vi]
            let y = 0
            for (let k = 0; k < 4; k++) {
              const w = wts[v * 4 + k]
              if (!w) continue
              const off = idx[v * 4 + k] * 16
              y += w * (skin[off + 1] * pos[v * 3] + skin[off + 5] * pos[v * 3 + 1] + skin[off + 13])
            }
            if (y < y0) y0 = y
            if (y > y1) y1 = y
          }
          if ((y1 - y0) / restH < 0.8) {
            mdl._deepCollapse = true
            break
          }
        }
      }
      if (mdl._deepCollapse) break
    }
  } catch {
    mdl._deepCollapse = false
  } finally {
    mdl._skin = savedSkin
  }
  return mdl._deepCollapse
}

// 零件「收拢 / 刚性 / 被盖住」的阈值，见 collapsedPartSquash 头注
// PART_SQUASH_ENTER：判定「被盖住」关系的入场阈值（只要有压缩就判，压缩比越小压得越狠）
const PART_SQUASH_ENTER = 0.98
const PART_RIGID_RATIO = 0.9
const PART_ENCLOSE_Y = 0.9
const PART_ENCLOSE_X = 0.6
const PART_AREA_CAP = 6
// 见文件上方 2026-10-07 注释。改这两个数之前先跑 verify-blink：
// 眼组必须收到 k=0，花火/头发/躯干块必须一个零件都不压。
const PART_SQUASH_MESH = 900
const PART_SQUASH_BODY = 110
// 全身网格上「大件也跟着收」的唯一破例：收拢件自己被压到这个比例以下（真闭眼）。
// 3078285611/3264246690 的躯干/头板假阳性都是 cr=0.96~0.98（几乎没收）配上的，靠这条挡住；
// 3671936032 的眼白 cr=0.075（艾玛 f24）、0.26→0.011（希罗 f60）才能放行虹膜跟着收。
const PART_SQUASH_BODY_DEEP = 0.2

function meshSpan(mdl) {
  if (mdl._meshSpan) return mdl._meshSpan
  let x0 = Infinity
  let x1 = -Infinity
  let y0 = Infinity
  let y1 = -Infinity
  for (const p of mdl.parts) {
    if (p.x0 < x0) x0 = p.x0
    if (p.x1 > x1) x1 = p.x1
    if (p.y0 < y0) y0 = p.y0
    if (p.y1 > y1) y1 = p.y1
  }
  mdl._meshSpan = { long: Math.max(x1 - x0, y1 - y0) }
  return mdl._meshSpan
}

/**
 * [we-scene patch 2026-09-28] 「被收拢的零件盖住」的零件，本帧竖直压扁多少（对齐 mdl.parts，
 * 1 = 不压；返回 null 表示本帧不用改）。
 *
 * 为什么需要：3629379075（若叶睦 眨眼）的闭眼是把眼睑/睫毛零件**压扁成一条线**
 * （眼睑 60→25、上睫毛 43→…），而眼球零件 100% 绑在一根在四条 clip 里都恒定不动的骨上
 * （scale 恒 1.000、平移只动 8~11 单位）——文件里没有任何数据能让它消失或变形：
 * 无绘制顺序曲线、无 masks、无脚本驱动，MDLE 只是同一套绑定姿势换轴序（实测），
 * 每骨 skin pivot / 4×4 矩阵也都会推歪身体。但作者随包的 preview.gif 与工坊宣传图里
 * 闭眼时看不到眼球（同尺度实测闭/睁虹膜像素：作者 30%、我们 93%）。
 * 用户拍板的做法：**别藏，跟着同步压扁**——眼睑开始压缩时眼球就按同一进度变扁，
 * 压到一半时收完，全程连续、不跳变（藏掉会「漏眼睛」且眨眼不顺滑）。
 *
 * 判据（纯几何，静止帧零影响）：
 *   1. 某零件本帧压扁（高度比 < PART_SQUASH_ENTER）→ 它是「收拢件」；
 *   2. 另一个**刚性件**（本帧高度仍 > 静止的 90%）满足三条才判为被盖住：
 *      ① 收拢件的**中心**落在它的当前盒内（不用「90%/60% 包含」：左右眼原画形状可以不同，
 *         包含关系只对一只眼成立，实测 3655429099 只收一只眼）；
 *      ② 它的静止**宽度**小于收拢件（「眼睑宽 → 眼球窄」；这条同时排掉睫毛带，
 *         见下面命中循环里的长注）；
 *      ③ 它的当前面积不超过收拢件的 6 倍（挡掉「脸包住嘴」这类大容器）；
 *   3. 压扁系数 k = clamp(5r − 4, 0, 1)（r = 收拢件的高度比）：r≥1 不压、r=0.9 压到一半、
 *      r≤0.8 收完。阈值取 0.8 是因为**同一台里两只眼的眼睑压缩幅度可以不同**
 *      （3655429099 实测 0.66 / 0.74），阈值落在两者之间就只收一只眼。
 *   4. k < 0.25 直接**不画**（用户实测：完全闭眼时压扁的残留仍会露出来，要求压到一定程度就隐藏；
 *      回弹时 k 升过 0.25 又会自动出现，同一条判据双向适用）。
 * 恒等帧（静止、纯位移/旋转）在骨头缩放预筛处直接返回，零额外成本。
 * 不按壁纸 ID 开关：眼组网格（静止长边 ≤ PART_SQUASH_MESH）全部刚性命中都跟着压；
 * 更大的网格只压静止长边 ≤ PART_SQUASH_BODY 且同帧不超过 3 个的命中。

 */
export function collapsedPartSquash(mdl, skin, animLayers) {
  const parts = mdl.parts
  if (!parts || parts.length < 2 || !skin) return null
  if (!hasDeepPartCollapse(mdl, arguments[2])) return null // 行为命中：只有真出现「深压」的网格才参与
  // 快速预筛：本帧有骨头缩放明显偏离 1 才值得逐零件算包围盒。
  let scaled = false
  for (let i = 0; i < mdl.bones.length; i++) {
    const m = skin.subarray(i * 16, i * 16 + 16)
    if (Math.abs(Math.hypot(m[0], m[1]) - 1) > 0.02 || Math.abs(Math.hypot(m[4], m[5]) - 1) > 0.02) {
      scaled = true
      break
    }
  }
  if (!scaled) return null

  const pos = mdl.positions
  const idx = mdl.boneIdx
  const wts = mdl.weights
  const box = mdl._partBox && mdl._partBox.length === parts.length
    ? mdl._partBox
    : (mdl._partBox = parts.map(() => new Float32Array(5))) // x0,x1,y0,y1,ratio
  for (let p = 0; p < parts.length; p++) {
    const part = parts[p]
    const b = box[p]
    let x0 = Infinity
    let x1 = -Infinity
    let y0 = Infinity
    let y1 = -Infinity
    for (let vi = 0; vi < part.verts.length; vi++) {
      const v = part.verts[vi]
      let x = 0
      let y = 0
      for (let k = 0; k < 4; k++) {
        const w = wts[v * 4 + k]
        if (!w) continue
        const off = idx[v * 4 + k] * 16
        x += w * (skin[off] * pos[v * 3] + skin[off + 4] * pos[v * 3 + 1] + skin[off + 12])
        y += w * (skin[off + 1] * pos[v * 3] + skin[off + 5] * pos[v * 3 + 1] + skin[off + 13])
      }
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
    const restH = part.y1 - part.y0
    b[0] = Number.isFinite(x0) ? x0 : 0
    b[1] = Number.isFinite(x1) ? x1 : 0
    b[2] = Number.isFinite(y0) ? y0 : 0
    b[3] = Number.isFinite(y1) ? y1 : 0
    b[4] = restH > 1e-3 ? (b[3] - b[2]) / restH : 1
  }

  // 网格尺度提前取：大网格（long > PART_SQUASH_MESH，即整个人物）里的「大件」走下面
  // 眼睛专属的硬条件；小网格（眼组，≤900px）里的零件沿用老的中心/相交判据。
  const span = meshSpan(mdl)
  const bigMesh = span.long > PART_SQUASH_MESH
  const hits = []
  for (let r = 0; r < parts.length; r++) {
    const rb = box[r]
    if (rb[4] < PART_RIGID_RATIO) continue
    const rArea = Math.max(1e-6, (rb[1] - rb[0]) * (rb[3] - rb[2]))
    const rp = parts[r]
    const rLong = Math.max(rp.x1 - rp.x0, rp.y1 - rp.y0)
    let k = 1
    let px = 0
    let py = 0
    for (let c = 0; c < parts.length; c++) {
      if (c === r) continue
      const cb = box[c]
      if (!(cb[4] < PART_SQUASH_ENTER)) continue
      const h = cb[3] - cb[2]
      const w = cb[1] - cb[0]
      if (!(h > 1e-6) || !(w > 1e-6)) continue
      // 面积上限的分母用**展开后**的面积：深压时收拢件的当前盒只剩一条线（3671936032 的
      // 眼白 168×13），拿它当分母会把「本来就盖在上面的大件」（同一张的虹膜 444×217）全判掉。
      const eh = h / Math.max(cb[4], 1e-3)
      if (rArea > PART_AREA_CAP * Math.max(1e-6, w * eh)) continue
      // 收口分两类。**大件** = 静止长边 > PART_SQUASH_BODY(110) 的零件（眼球/虹膜/躯干），
      // 只有在整张人物网格（long > PART_SQUASH_MESH）里才另走硬条件；眼组小网格沿用老判据。
      if (bigMesh && rLong > PART_SQUASH_BODY) {
        // 眼睛这一处是**反过来的**：闭眼时收掉的是眼白（168×171 的小件），要跟着收的却是
        // 横跨双眼的虹膜 444×217 与高光 432×166（3671936032，用户实测「眼球一直是最大状态、
        // 睫毛往下运动时也没有被遮罩」）。虹膜比眼白宽、静止时与眼白不在同一块 UV 岛、当前盒
        // 也错开，老判据一条都过不了。改用四条硬条件（缺一个就会把身体块当眼球，实测
        // 3078285611 的 232×761 / 323×389 / 156×150 会分别被第三/第四/第二+第四条挡住）：
        //   ① 两个零件**同属一颗骨**（bone.parent 相同）：艾玛的眼白/眼球/高光都是 bone 31 的
        //      子骨、希罗的是 bone 61 的子骨 —— 这才是「同一只眼的零件」；
        //   ② 收拢件**真的收完了**（cb[4] < PART_SQUASH_BODY_DEEP = 0.2；绘制侧 k<0.25 本来
        //      就不画了）：身体块的假阳性 cr 都在 0.26~0.98；
        //   ③ 两者**尺度相近**（静止两轴尺寸比 ≤ 4）：虹膜对眼白 2.6/1.3，而 232×761 对
        //      186×179 在高度上是 4.3 倍；
        //   ④ 被盖的大件比收拢件**本身大**（静止面积 ≥ 2 倍）：虹膜对眼白 3.4 倍，而
        //      3078285611 里尺寸几乎一样的一对（156×150 对 151×137，1.1 倍）不是「盖住」。
        if (!(cb[4] < PART_SQUASH_BODY_DEEP)) continue
        const ownBone = mdl.bones[rp.bone]
        const colBone = mdl.bones[parts[c].bone]
        if (!(ownBone && colBone && ownBone.parent === colBone.parent)) continue
        const rw0 = Math.max(1e-3, rp.x1 - rp.x0)
        const rh0 = Math.max(1e-3, rp.y1 - rp.y0)
        const cw0 = Math.max(1e-3, parts[c].x1 - parts[c].x0)
        const ch0 = Math.max(1e-3, parts[c].y1 - parts[c].y0)
        if (!(Math.max(rw0 / cw0, cw0 / rw0) <= 4 && Math.max(rh0 / ch0, ch0 / rh0) <= 4)) continue
        if (!(rArea > 2 * cw0 * ch0)) continue
      } else {
        // 老判据（2026-10-07）：收拢件**当前中心**落在刚性件盒内 + 被盖件更窄 +（2026-10-09）
        // 静止姿势下两盒**相交**。
        // 不用「竖直 90%/横向 60% 包含」的原因：同一台壁纸的左右眼**原画形状可以不同**
        // （3655429099 是 wink 角色，两眼素材不对称），包含判据只对一只眼成立 →
        // 实测「一只眼收、另一只不收」。
        // 相交那条是 2026-10-09 补的：中心判据对「被压成一条线的零件」是退化的 —— 13px 高的
        // 细条照样包含任何跨越它的中心点，于是眼白塌成一条线时就"盖住"了静止姿势下毫无重叠的
        // 睫毛（3671936032 艾玛 f24 / 希罗 f60），把闭眼时必须留下的深色睑线整块删掉
        //（绘制侧 k<0.25 不画）→ 用户看到的「眨眼只有睫毛动、眼睛不闭」。
        // 语料侧这条判据不动任何原有命中：静止重叠 3655429099 87~100%、3629379075 15~65%、
        // 3808922316 54~95%、3521337568 37~83%、3791967416 9~64%、3264246690 53~60%。
        const cx = (cb[0] + cb[1]) / 2
        const cy = (cb[2] + cb[3]) / 2
        if (cx < rb[0] || cx > rb[1] || cy < rb[2] || cy > rb[3]) continue
        // **能盖住**：被盖件的当前宽度必须小于收拢件的**静止**宽度 —— 「眼睑/皮肤（宽）盖住
        // 眼球（窄）」。这条是相对判据（两个零件互相比较），绝对判据全试过并且都失败：
        //   静止更高：3655429099 眼球(70/67) 比眼睑(80) 矮 → 两颗眼都不命中（旧版的 bug）
        //   静止面积更小：3629379075 眼睑 139×67 比眼球 91×107 还小 → 只剩一只眼
        //   静止盒被包含：3655429099 右眼当前盒比眼睑高 33%，包含关系不成立 → 只剩左眼
        // 而宽度关系两台都成立：眼球 82/54 < 眼睑 140/84；3629379075 眼球 91/90 < 眼睑 139。
        const cRestW = parts[c].x1 - parts[c].x0
        if (!((rb[1] - rb[0]) < cRestW)) continue
        const cp = parts[c]
        if (!(Math.min(cp.x1, rp.x1) > Math.max(cp.x0, rp.x0) &&
              Math.min(cp.y1, rp.y1) > Math.max(cp.y0, rp.y0))) continue
      }
      // 同步压扁：k = clamp(5r − 4, 0, 1)，即眼睑压到 80% 起跟随、压到 80% 以下就收完。
      // 为什么阈值取 0.8 而不是更小：同一台壁纸**两只眼的眼睑压缩程度并不相同**——
      // 3655429099 实测 r=0.66 与 r=0.74（两声道的录制幅度不同），任何落在两者之间的阈值
      // 都会只收一只眼（用户实测「只有左眼匹配上」）。取 0.8 让「眼睑明显压了」= 眼球收完。
      // 3629379075（r 最低 0.40）在这条映射下同样收干净。
      const kk = Math.max(0, Math.min(1, 5 * cb[4] - 4))
      if (kk < k) {
        k = kk
        // 枢轴取**收拢件的当前中心**：被盖件往眼睑带里塌，而不是原地压缩成条纹
        //（原地压缩时它的原画被压成一道道横纹，就是用户看到的「残影」）
        px = (cb[0] + cb[1]) / 2
        py = (cb[2] + cb[3]) / 2
      }
    }
    if (k < 1) hits.push({ r, k, px, py })
  }
  // 高度 ≥ 最高命中件 60%：剔掉睫毛/高光这类小件（3629379075 里 h31/h37 丢掉，
  // 只剩两颗眼球 h107/h104）。「同帧不超过 3 个」只用于全身网格，眼组不能用它收口。
  if (!hits.length) return null
  // 候选循环已经按网格尺度分好类（全身网格的大件走眼睛专属硬条件），这里只做高度收口。
  // 先收口再取「高度 ≥ 最高命中 60%」的顺序不能反：全身网格上若先拿最高的躯干件当 100%，
  // 79px 的眼球会被 60% 滤掉。
  const tallest = Math.max(...hits.map((h) => parts[h.r].y1 - parts[h.r].y0))
  const kept = hits.filter((h) => parts[h.r].y1 - parts[h.r].y0 >= 0.6 * tallest)
  if (!kept.length) return null
  // 个数看滤完高度之后的：Lucy 一帧能配上四五件，60% 之后剩 3 颗眼球。
  // 花火滤完仍是 4~11 件、头发 11 件以上，整帧放弃，不要挑最高的三件（那不是眼球）。
  if (span.long > PART_SQUASH_MESH && kept.length > 3) return null
  const out = new Float32Array(parts.length * 3)
  for (let i = 0; i < parts.length; i++) out[i * 3] = 1
  for (const h of kept) {
    out[h.r * 3] = h.k
    out[h.r * 3 + 1] = h.px
    out[h.r * 3 + 2] = h.py
  }
  return out
}

export function createMDLRenderer(gl) {
  // 按 GPU 上报的 uniform 预算编译；链接失败（驱动实际容量更小）时逐级减半重试。
  // 链接本身走 gl-util 的共享实现（B3 收敛）：原来这里有一份本地 compile + 内联链接，
  // 失败路径还会漏 shader（编译出的两个 shader 没有任何引用可删）。
  // 重试语义**必须原样保留** —— 它是骨预算的判据（verify-mdl-uniforms 覆盖）。
  let maxBones = boneBudget(gl)
  let prog = null
  const ATTRIBS = [
    [0, 'a_pos'],
    [1, 'a_uv'],
    [2, 'a_bone'],
    [3, 'a_weight'],
    [4, 'a_normal'],
  ]
  for (;;) {
    let p = null
    try {
      p = linkProgram(gl, mdlVertSrc(maxBones), MDL_FRAG, { attribs: ATTRIBS })
    } catch (e) {
      p = null
    }
    if (p) {
      prog = p
      break
    }
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
    keepZ: gl.getUniformLocation(prog, 'u_keepZ'),
    partScale: gl.getUniformLocation(prog, 'u_partScale'),
    partPivot: gl.getUniformLocation(prog, 'u_partPivot'),
    normalMat: gl.getUniformLocation(prog, 'u_normalMat'),
    lightDir: gl.getUniformLocation(prog, 'u_lightDir'),
    lightBase: gl.getUniformLocation(prog, 'u_lightBase'),
    lightAdd: gl.getUniformLocation(prog, 'u_lightAdd'),
    lightOn: gl.getUniformLocation(prog, 'u_lightOn'),
    model: gl.getUniformLocation(prog, 'u_model'),
    fogOn: gl.getUniformLocation(prog, 'u_fogOn'),
    fogAdditive: gl.getUniformLocation(prog, 'u_fogAdditive'),
    eye: gl.getUniformLocation(prog, 'u_eye'),
    fogDist: gl.getUniformLocation(prog, 'u_fogDist'),
    fogDistColor: gl.getUniformLocation(prog, 'u_fogDistColor'),
    fogHeight: gl.getUniformLocation(prog, 'u_fogHeight'),
    fogHeightColor: gl.getUniformLocation(prog, 'u_fogHeightColor'),
  }
  const IDENTITY3 = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1])
  const ZERO3 = new Float32Array(3)
  const ZERO4 = new Float32Array(4)
  const identitySkin = new Float32Array(MAX_BONES * 16)
  for (let i = 0; i < MAX_BONES; i++) identitySkin.set(IDENTITY, i * 16)

  // 每个网格一套 VAO/VBO（顶点数据静态，蒙皮在 GPU 完成）。
  // [we-scene patch 2026-09-28] 键从 mdl 换成**子网格记录**：一个 MDL 可以有多个
  // 子网格（stage.mdl 15 个、TDRS 64 个），各自独立的顶点/索引缓冲。mdl 只有 1 个
  // 子网格时键仍是「伪网格对象」（见 draw 里 legacyMesh），与改动前逐位等价。
  const meshes = new WeakMap()
  // 可枚举的存活表：WeakMap 是**查询**用的（按键缓存），GC 到了也枚举不出来，
  // 里面的 VAO/VBO 就没人删。释放需要一份强引用清单（见下面的 dispose）。
  const liveMeshes = new Set()
  function ensureMesh(mesh) {
    let m = meshes.get(mesh)
    if (m) return m
    const vao = gl.createVertexArray()
    gl.bindVertexArray(vao)
    const n = mesh.vertexCount
    // 交错：pos(3) uv(2) [uv2(2)] bone(4) weight(4) [normal(3)] [tangent(4)]
    // 有法线的（真 3D 网格 / 无骨骼模型）多交错 3 个 float 供片元光照用；
    // 2D puppet 的 flag 里没有 NORMAL → 布局与改动前逐位一致。
    // [we-scene patch 2026-10-03] **切线**（F22）：官方 3D 材质 shader 的 NORMALMAP 分支要
    // `a_Tangent4`（xyz + handedness，fantasticcar `car.vert`），没有它整条材质路径 b 掉。
    // [we-scene patch 2026-10-03] **第二套 UV**（F34）：官方 `generic.vert` 在 LIGHTMAP 组合下
    // 声明 `attribute vec4 a_TexCoordVec4`（xy = 反照率 UV、zw = 光照图 UV）。vec4 属性要求
    // 四个分量**连续**，所以 uv2 紧跟 uv 之后（而不是像 normal/tangent 那样挂在尾部）——
    // 这样材质路径才能用一条 `vertexAttribPointer(loc, 4, …, 12)` 直接把它交给 shader。
    // 其余属性（bone/weight/normal/tangent）的偏移随之整体后移，改成按表算而不是写死。
    const hasN = !!mesh.normals
    const hasT = !!mesh.tangents
    const hasUv2 = !!mesh.uv2
    // 偏移表（单位 float）：uv2 紧跟 uv 之后，其余属性顺延；无 uv2 时与改动前逐位一致
    let cursor = 5 // pos(3) + uv(2)
    const uv2Off = hasUv2 ? cursor : -1
    if (hasUv2) cursor += 2
    const boneOff = cursor
    cursor += 4
    const weightOff = cursor
    cursor += 4
    const normalOff = hasN ? cursor : -1
    if (hasN) cursor += 3
    const tangentOff = hasT ? cursor : -1
    if (hasT) cursor += 4
    const F = cursor
    const data = new Float32Array(n * F)
    for (let i = 0; i < n; i++) {
      const o = i * F
      data[o] = mesh.positions[i * 3]
      data[o + 1] = mesh.positions[i * 3 + 1]
      data[o + 2] = mesh.positions[i * 3 + 2]
      data[o + 3] = mesh.uvs[i * 2]
      data[o + 4] = mesh.uvs[i * 2 + 1]
      if (hasUv2) {
        data[o + uv2Off] = mesh.uv2[i * 2]
        data[o + uv2Off + 1] = mesh.uv2[i * 2 + 1]
      }
      for (let k = 0; k < 4; k++) {
        data[o + boneOff + k] = mesh.boneIdx[i * 4 + k]
        data[o + weightOff + k] = mesh.weights[i * 4 + k]
      }
      if (hasN) {
        data[o + normalOff] = mesh.normals[i * 3]
        data[o + normalOff + 1] = mesh.normals[i * 3 + 1]
        data[o + normalOff + 2] = mesh.normals[i * 3 + 2]
      }
      if (hasT) {
        for (let k = 0; k < 4; k++) data[o + tangentOff + k] = mesh.tangents[i * 4 + k]
      }
    }
    const vbuf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, vbuf)
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW)
    const S = F * 4
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, S, 0)
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, S, 12)
    gl.enableVertexAttribArray(2)
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, S, boneOff * 4)
    gl.enableVertexAttribArray(3)
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, S, weightOff * 4)
    if (hasN) {
      gl.enableVertexAttribArray(4)
      gl.vertexAttribPointer(4, 3, gl.FLOAT, false, S, normalOff * 4)
    } else {
      gl.disableVertexAttribArray(4)
      gl.vertexAttrib3f(4, 0, 0, 1)
    }
    const ibuf = gl.createBuffer()
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibuf)
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW)
    gl.bindVertexArray(null)
    m = {
      vao,
      vbuf,
      ibuf,
      hasNormals: hasN,
      // [we-scene patch 2026-10-03] 供**材质 shader 路径**（F13）复用的几何信息：
      // 交错布局 pos(3f)@0 / uv(2f)@12 / bone(4f)@20 / weight(4f)@36 / normal(3f)@52
      // / tangent(4f)@64（后两段按数据存在与否），stride = floatStride*4。
      // 材质程序自己声明 attribute 名字与数量，这里暴露「顶点数 / 交错宽度 /
      // 各属性字节偏移 / 索引类型」，具体绑定由渲染侧按程序的位置做。
      vertexCount: n,
      floatStride: F,
      // 属性字节偏移（-1 = 该网格没有这条数据，声明了它的程序必须回落通用网格程序）
      normalOffset: normalOff >= 0 ? normalOff * 4 : -1,
      tangentOffset: tangentOff >= 0 ? tangentOff * 4 : -1,
      // uv2（光照图 UV）：材质路径的 `a_TexCoordVec4` 就是 [uv, uv2] 这一条连续 vec4
      uv2Offset: uv2Off >= 0 ? uv2Off * 4 : -1,
      hasTangents: hasT,
      hasUv2: hasUv2,
      indexCount: mesh.indexCount,
      indexU32: mesh.indices instanceof Uint32Array,
    }
    meshes.set(mesh, m)
    liveMeshes.add(m)
    return m
  }
  // 材质 shader 路径取几何信息（先建后取，语义与 ensureMesh 一致）
  const resolveMesh = (mesh) => (mesh ? ensureMesh(mesh) : null)
  /** [we-scene patch 2026-10-03] 材质 shader 路径用：返回 mdl 的子网格列表（单网格给伪网格） */
  const resolveMeshes = (mdl) => {
    const list = meshListOf(mdl)
    return list && list.length ? list : [legacyMeshOf(mdl)]
  }

  // 单网格模型（绝大多数 2D puppet）把顶层字段包成一条「伪子网格」，让 draw/upload
  // 只有一条代码路径；多网格模型直接走 mdl.meshes。
  // [we-scene patch 2026-10-03] **单网格模型的伪网格必须按 mdl 记忆化**：
  // ensureMesh（VBO/VAO 缓存）与材质路径的 VAO 缓存都以「网格对象」为键，
  // 每次新建对象 = **每帧新建一整套 VBO/VAO**。neon_sunset 的两个模型都是单网格，
  // 实测这条每帧泄漏把整帧拖成零像素（fps 仍 60、无报错、连 2D 层也不出图）。
  const legacyCache = new WeakMap()
  const legacyMeshOf = (mdl) => {
    let m = legacyCache.get(mdl)
    if (m) return m
    // meshes.length === 1 时 meshListOf 返回 null（走这条伪网格）—— 这时文档级数组
    // 与唯一那条网格记录是同一份几何，字段可能只写了其中一边。
    const singleSub = mdl.meshes && mdl.meshes.length === 1 ? mdl.meshes[0] : null
    m = {
      positions: mdl.positions,
      uvs: mdl.uvs,
      boneIdx: mdl.boneIdx,
      weights: mdl.weights,
      // [we-scene patch 2026-10-03] 法线/切线也要透传（F22）：单网格 3D 模型
      // （retro/ricepod… 的网格层）走这条伪网格，材质 shader 的 a_Normal/a_Tangent4
      // 只能从这里拿；缺字段时与改动前一致（两处都是 null → 布局不变）。
      // [we-scene patch 2026-10-09] **只有一个子网格时也认网格记录里的数组**：
      // 编辑器导入的单网格模型（`models/editor/*.mdl`）文档级 `normals` 是 null，
      // 法线只在 `meshes[0]` 上 —— 于是导入的单网格模型**在真机上从来没有法线**：
      // 逐网格 `u_lightOn` 恒为 0（手办的鼻子/嘴、卡通角色的腮与衣褶这类"只有形体、
      // 没有独立反照率"的特征完全不显形），材质路径的 a_Normal/a_Tangent4 也拿不到。
      // 判据见 verify-mdl-depth 的 F52 节（含变异注入）。
      normals: mdl.normals || singleSub?.normals || null,
      tangents: mdl.tangents || singleSub?.tangents || null,
      uv2: mdl.uv2 || singleSub?.uv2 || null,
      vertexCount: mdl.vertexCount,
      indices: mdl.indices,
      indexCount: mdl.indexCount,
      indexType: mdl.indexType,
    }
    legacyCache.set(mdl, m)
    return m
  }
  const meshListOf = (mdl) => (mdl.meshes && mdl.meshes.length > 1 ? mdl.meshes : null)

  // [we-scene patch 2026-10-04] **子网格绘制顺序：显式不透明的先画**（F50）。
  //
  // `blendings[i]` 是宿主按第 i 个子网格的材质读出的 `passes[0].blending`（字符串或 null）。
  // 只有显式 `normal` 才算「声明了不透明」；`translucent`/`additive`/`alphatocoverage` 与
  // **未声明**都排到后面（未声明 = 未知，按可能透明保守处理）。同类内保持文件序。
  // 返回 null 表示「无需重排」（单网格、缺排序表、或两类都空/只有一类）——
  // 调用方这时走原下标，逐位等价。
  // 判据：`verify-mdl-depth` 的 F50 节（顺序 + 接线 + 未给表时不重排）。
  function meshDrawOrder(list, blendings) {
    if (!list || list.length < 2 || !blendings || !blendings.length) return null
    const isDeclaredOpaque = (i) => {
      const b = blendings[i]
      return typeof b === 'string' && b.toLowerCase() === 'normal'
    }
    const head = []
    const tail = []
    for (let i = 0; i < list.length; i++) (isDeclaredOpaque(i) ? head : tail).push(i)
    if (head.length === 0 || tail.length === 0) return null // 全同类：保持文件序
    const order = head.concat(tail)
    // 顺序与文件序一致时不返回（避免无谓的分支差异）
    for (let i = 0; i < order.length; i++) if (order[i] !== i) return order
    return null
  }

  return {
    gl,
    prog,
    maxBones: MAX_BONES,
    /** [we-scene patch 2026-10-03] 材质 shader 路径用：取某子网格的几何信息（含 VBO/IBO） */
    resolveMesh,
    /** [we-scene patch 2026-10-03] 材质 shader 路径用：mdl 的子网格列表（多网格或单网格伪网格） */
    resolveMeshes,
    /**
     * 释放本渲染器创建的 GL 对象：program + 每套网格的 VAO/VBO。
     *
     * 为什么必须显式释放：网格缓存是 WeakMap（按网格记录缓存），GC 到了也**无法枚举**，
     * 里面的 VAO/VBO 只能等上下文回收 —— 与 renderer 侧 gl-registry 的
     * 「自己回收 + 扩展兜底」原则不一致（docs/ENGINE-REVIEW-2026-10.md §3.1）。
     * 原先 mdl.js 里除「链接失败删 program」外没有任何 delete。
     * 调用方：装配层在场景卸载时（scene-mount 的 sceneCleanup）。
     */
    dispose() {
      for (const m of liveMeshes) {
        try {
          gl.deleteVertexArray(m.vao)
          gl.deleteBuffer(m.vbuf)
          gl.deleteBuffer(m.ibuf)
        } catch (e) {
          /* 上下文可能已丢失 */
        }
      }
      liveMeshes.clear()
      if (prog) {
        try {
          gl.deleteProgram(prog)
        } catch (e) {
          /* 同上 */
        }
        prog = null
      }
    },
    upload(mdl) {
      const list = meshListOf(mdl)
      if (list) {
        for (const mesh of list) if (mesh.vertexCount) ensureMesh(mesh)
      } else {
        ensureMesh(legacyMeshOf(mdl))
      }
    },
    // opts: { color:[r,g,b,a], time, animLayers, blending, overrideTex, keepZ, meshTextures }
    // overrideTex：puppet 层跑过效果链时采样源是链尾 FBO 的纹理，而不是原始贴图
    // （效果在贴图空间合成，见 renderer.js 中部那段长注释）。传裸 WebGLTexture。
    // keepZ：顶点 z 是否参与投影（透视场景的真 3D 网格 = true，2D puppet = 缺省 false）。
    // meshTextures：**逐子网格贴图**（宿主按每个子网格的材质 json 解析，见
    // scene-mount 的 model 分支）。缺省/缺项回落到 texture —— 单网格模型行为不变。
    draw(mvp, mdl, opts, texture) {
      gl.useProgram(prog)
      gl.uniformMatrix4fv(uni.mvp, false, mvp)
      gl.uniform1f(uni.keepZ, opts.keepZ ? 1 : 0)
      const col = opts.color || [1, 1, 1, 1]
      gl.uniform4f(uni.color, col[0], col[1], col[2], col[3])
      // 每零件缩放先复位成恒等——**必须每帧设**，不能只在下面的白名单分支里设：
      // GL 的 uniform 默认值是 (0,0)，而顶点着色器里 `local.xy = u_partPivot + (local.xy
      // − u_partPivot) * u_partScale` 在 (0,0) 下会把整张网格乘成 0 → 所有非白名单的
      // puppet 全部塌到原点（实测 3798926489/3791967416/3737267090/3707219547 等整批
      // 人物消失只剩零碎头发片）。恒等值下这一行是逐位恒等（×1 再加 0）。
      gl.uniform2f(uni.partScale, 1, 1)
      gl.uniform2f(uni.partPivot, 0, 0)
      // 蒙皮与混合对**整个模型**只算一次（骨架只有一套），逐子网格只换 VAO/贴图/索引。
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
      gl.activeTexture(gl.TEXTURE0)
      gl.uniform1i(uni.tex, 0)
      // [we-scene patch 2026-09-28] 场景光照：宿主给 {dir:[x,y,z], base:[r,g,b], add:[r,g,b]}
      //（base = 场景 ambientcolor，add = 平行光 color×intensity×K）。只对**带法线的网格**生效，
      // 逐网格在下面的循环里开关 u_lightOn；关着时片元里 `mul ≡ 1`，与改动前逐位一致。
      const SL = opts.sceneLight
      gl.uniformMatrix3fv(uni.normalMat, false, (opts.normalMat && opts.normalMat.length === 9) ? opts.normalMat : IDENTITY3)
      if (SL) {
        gl.uniform3f(uni.lightDir, SL.dir[0], SL.dir[1], SL.dir[2])
        gl.uniform3f(uni.lightBase, SL.base[0], SL.base[1], SL.base[2])
        gl.uniform3f(uni.lightAdd, SL.add[0], SL.add[1], SL.add[2])
      } else {
        gl.uniform3f(uni.lightBase, 1, 1, 1)
        gl.uniform3f(uni.lightAdd, 0, 0, 0)
        gl.uniform3f(uni.lightDir, 0, 1, 0)
      }
      // [we-scene patch 2026-10-05] 场景雾：宿主给 { eye, dist:[4], distColor:[3], height:[4], heightColor:[3] }，
      // 只对真 3D（keepZ）且带模型矩阵时生效；某一项未开时其 Params.y 为 0，片元里跳过该项。
      const FOG = opts.keepZ && opts.fog && opts.model && opts.model.length === 16 ? opts.fog : null
      gl.uniformMatrix4fv(uni.model, false, FOG ? opts.model : IDENTITY)
      gl.uniform1f(uni.fogOn, FOG ? 1 : 0)
      if (FOG) {
        gl.uniform3fv(uni.eye, FOG.eye)
        gl.uniform4fv(uni.fogDist, FOG.dist || ZERO4)
        gl.uniform3fv(uni.fogDistColor, FOG.distColor || ZERO3)
        gl.uniform4fv(uni.fogHeight, FOG.height || ZERO4)
        gl.uniform3fv(uni.fogHeightColor, FOG.heightColor || ZERO3)
      }
      const identity = opts.overrideTex || (texture && texture.glTex ? texture.glTex : texture) || null
      // 多子网格：mdl.meshes 是 parseMeshes 的产物（1 个网格时与上面这份伪网格等价）。
      // 零件表（parts）只挂在第一个子网格上：那是 2D puppet 的「收拢零件」规则用的
      // 元数据，而那批模型都是单网格；多网格的 3D 模型不做零件剔除（画满索引区）。
      const list = meshListOf(mdl)
      const legacyMesh = list ? null : legacyMeshOf(mdl)
      const n = list ? list.length : 1
      // [we-scene patch 2026-10-04] **子网格绘制顺序：显式不透明的先画**（F50）。
      //
      // 3477054430 的城模型：mesh0 = 树（贴图 65% 像素 alpha=0 的卡片网格，材质**没声明**
      // blending），mesh1 = 楼房（材质声明 `blending: normal`）。文件序把树排在前面，树的
      // 透明像素写进深度 ⇒ 随后画的楼房整片被 LEQUAL 拒掉 ⇒ 每棵树四周一个黑方块
      // （用户报「树图层黑色方块」）。官方引擎的规则是先不透明、后透明（透明网格必须能
      // 混合到它身后的背景上），所以这里按材质声明排序：`normal` = 不透明先画，
      // 其余（translucent/additive/alphatocoverage/**未声明**）后画；同类内保持文件序（稳定）。
      // 未声明按「可能透明」排后面是保守选择：排序只影响先后，遮挡仍由深度测试裁决（F49）。
      // 只在**真 3D（keepZ）**重排：2D 场景（含 2D 场景里的 model 层）没有深度测试，
      // 绘制顺序就是合成顺序（后画的盖先画的），重排会改观感。深度测试只在透视场景开
      // （见下一条），所以「透明网格排在身后几何之后」这条规则也只在那里成立。
      const order = opts.keepZ ? meshDrawOrder(list, opts.meshBlending) : null
      // [we-scene patch 2026-09-28] **真 3D 网格之间要开深度测试**。
      //
      // 为什么：一个 .mdl 的多个子网格是**同一个物体的不同部件**，它们相互遮挡靠的是
      // 深度，不是绘制顺序。关掉深度测试时后画的网格会整片盖住先画的：3281559867 的
      // 舞台 15 个网格里，场地地砖在前（mesh0/3/7…），四周草地/远景在后（mesh4/12），
      // 于是「棋盘地砖被草地整片涂绿」—— 作者 preview 里那块清清楚楚的棋盘完全看不见。
      // （实验：把绘制顺序反过来地砖立刻出现，证明是顺序遮挡而非贴图/UV 问题。）
      //
      // 只在透视场景（keepZ，即真 3D）开：2D puppet 的网格 z 是建模残留、本来就该
      // 按图层 z 序压平绘制（见 drawPuppetDirect 的 keepZ 注释），开深度测试会把它们
      // 按 z 互相裁剪。
      //
      // [we-scene patch 2026-10-04] **深度缓冲帧内共享，逐模型不再清**（F49）。
      //
      // 此前这里每画一个模型就 `clear(DEPTH_BUFFER_BIT)`：等于把先画的模型从深度缓冲里
      // 抹掉，深度测试无从比较 ⇒ **后画的模型无条件盖住先画的**。3477054430 的猫
      // （层序 0/1）被后画的城市（层序 5）整片涂掉，只剩探出楼顶轮廓的那圈耳机带可见
      // （用户报「没有显示 cat」）。同一根因在材质路径上已于 F40 修掉（fantasticcar
      // 地板盖住车身），这是另一条绘制路径（通用网格程序）。
      //
      // 帧首 renderScene 已统一 `clear(COLOR|DEPTH)`（HDR/MSAA 目标都带深度附件），
      // 模型之间就该按真实深度比较。宿主给的 FBO 没有深度附件时（效果链 FBO）深度
      // 测试退化为恒通过，与改动前一致。
      //
      // 天空盒是唯一例外：它的壳把相机包在里面，近侧壳比场内任何东西都近，写进深度
      // 会把后面所有模型拒掉。它本来就是背景（drawLayers 已把它排在最前），按
      // 「只测不写」画 —— 与 F40 对天空盒的处理同一条规则。
      const useDepth = !!opts.keepZ
      if (useDepth) {
        gl.enable(gl.DEPTH_TEST)
        gl.depthFunc(gl.LEQUAL)
        gl.depthMask(!opts.skybox)
      }
      for (let k = 0; k < n; k++) {
        // 绘制顺序由 meshDrawOrder 决定（F50）；单网格/未给排序表时 gi === k（逐位不变）。
        const gi = order ? order[k] : k
        const mesh = list ? list[gi] : legacyMesh
        if (!mesh || !mesh.vertexCount || !mesh.indexCount) continue
        const m = ensureMesh(mesh)
        gl.bindVertexArray(m.vao)
        // 带法线且场景有光 → 走上光路径（片元里 N·L）；否则常量 1（逐位等价旧行为）
        gl.uniform1f(uni.lightOn, SL && m.hasNormals ? 1 : 0)
        // 官方只在 ADDITIVE 下让雾吃掉 alpha（ApplyFogAlpha）：加算网格靠 alpha 而非颜色淡出
        if (FOG) {
          const mb = opts.meshBlending && opts.meshBlending[gi]
          const b = String(typeof mb === 'string' ? mb : opts.blending || '').toLowerCase()
          gl.uniform1f(uni.fogAdditive, b === 'additive' ? 1 : 0)
        }
        // 每网格贴图：overrideTex（效果链输出）优先，其次该网格自己的材质贴图，
        // 最后回落整层贴图（单网格模型走的就是这一条）。索引必须用**原始** gi ——
        // meshTextures 是按子网格下标填的，用重排后的 k 会把贴图错配给另一个网格。
        const per = opts.meshTextures && opts.meshTextures[gi]
        const src = opts.overrideTex || (per && per.glTex ? per.glTex : per) || identity
        gl.bindTexture(gl.TEXTURE_2D, src)
        const idxType = mesh.indexType === 'u32' ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT
        const parts = gi === 0 ? mdl.parts : null
        const squash = parts && opts.syncCoveredParts ? collapsedPartSquash(mdl, skin, opts.animLayers) : null
        // 只有这一帧真要压扁才拆成按零件画。squash 为 null 时整网格一次画完，
        // 和改门控之前的非白名单路径一样——不能因为「允许检测」就每帧拆 draw。
        if (squash) {
          const bytes = idxType === gl.UNSIGNED_INT ? 4 : 2
          for (let i = 0; i < parts.length; i++) {
            const k = squash ? squash[i * 3] : 1
            if (k < 0.25) continue // 压到 1/4 以下视同收完：不画（回弹时同一条判据自动恢复）
            const part = parts[i]
            const pivotX = squash && k < 1 ? squash[i * 3 + 1] : (part.x0 + part.x1) / 2
            const pivotY = squash && k < 1 ? squash[i * 3 + 2] : (part.y0 + part.y1) / 2
            gl.uniform2f(uni.partScale, 1, k)
            gl.uniform2f(uni.partPivot, pivotX, pivotY)
            gl.drawElements(gl.TRIANGLES, part.size, idxType, part.start * bytes)
          }
        } else {
          gl.drawElements(gl.TRIANGLES, mesh.indexCount, idxType, 0)
        }
      }
      if (useDepth) {
        gl.depthMask(false)
        gl.disable(gl.DEPTH_TEST)
      }
      gl.bindVertexArray(null)
    },
  }
}

export { parseMDL, computeSkinMatrices, bindWorldOf, mat4MulOut, attachmentWorld, attachmentBind, attachmentEffectiveOffset, parentMeshToWorldDelta, applyAttachmentBindOrigins, followAttachments, skinnedMeshes }
