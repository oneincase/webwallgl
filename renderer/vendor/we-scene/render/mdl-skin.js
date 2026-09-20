// MDL 蒙皮求值（从 mdl.js 拆出）：关键帧采样、TRS 合成、逐骨世界矩阵、蒙皮矩阵
// 纯数学、DOM/GPU-free；GPU 侧在 mdl.js（createMDLRenderer）。
// computeSkinMatrices 是 verify-groups I4 区块的直接被测对象。
import { mat4Mul, mat4Invert, composeTRS } from './mdl-math.js'

// 在 time（秒）处求 anim 某轨的 TRS 分量，写入 out9 = [tx,ty,tz, rx,ry,rz, sx,sy,sz]。
// 拆出 TRS（不直接出矩阵）是为了让多条动画层能按 WE 语义在 TRS 空间叠加/加权。
// [we-scene patch] 槽位语义修正：k[3..5] 是**欧拉角**、k[6..8] 是**三轴缩放**。
// 原实现读成 [qx,qy,qz,qw, sx,sy]，从索引 3 起整体错位一格，后果有三层：
//   ① 真正的 rz(k[5]) 被当成 qz，再经四元数公式换算成 2·atan2(z,w) —— 角度被放大约 2 倍；
//   ② 真正的 sx(k[6]) 被当成 qw 参与归一化，缩放彻底丢失；
//   ③ |q| 被算成 hypot(0,0,rz,sx)，rz 大时（腿1 达 2.94rad）归一化把整个旋转压扁。
// 判据（an21/an23）：拿 MDLS 绑定矩阵的真实旋转角当真值，与 frame0 复原值比对，
// 「k[5] 即弧度角」在 **1535/1535 根骨**上都不劣于四元数解，且腿1 骨3(-2.608)、
// Lucy 骨3/5/7/8/14/17/19 等有非零绑定旋转的骨误差从 0.2~1.9rad 降到 **0.000**。
// 逐槽分布（an24，全库所有关键帧）也自洽：k[3]/k[4] 有 99.9%/100% 为 0（2D 的 rx/ry），
// k[6]/k[7]/k[8] 分别有 97.4%/97.5%/98.7% 恰为 1（缩放默认值），
// 而 k[5] 取值域 [-8.338, 6.187] 远超 ±1，本就不可能是单位四元数分量。
function sampleTrackTRS(track, anim, time, out9) {
  const n = track.frameCount
  if (n === 0) {
    out9[0] = 0; out9[1] = 0; out9[2] = 0
    out9[3] = 0; out9[4] = 0; out9[5] = 0
    out9[6] = 1; out9[7] = 1; out9[8] = 1
    return out9
  }
  const frame = time * anim.fps
  let f0
  let f1
  let t
  if (anim.mode === 'loop') {
    // 末帧与首帧重合（frameCount+1 个关键帧），故按 frameCount 环绕可无缝首尾相接
    const span = Math.max(1, n - 1)
    const w = ((frame % span) + span) % span
    f0 = Math.floor(w)
    f1 = (f0 + 1) % n
    t = w - f0
  } else if (anim.mode === 'mirror') {
    // [we-scene patch] mirror：正播到末帧再倒播回首帧，周期 2(n-1)。
    // 此前没有这个分支，会掉进下面的 clamp 把动画**冻结在末帧**
    // （3148125112 五个 puppet 全是 mirror，t>5s 后整体定格在最大幅度姿势）。
    const span = Math.max(1, n - 1)
    const period = span * 2
    let w = ((frame % period) + period) % period
    if (w > span) w = period - w
    f0 = Math.floor(w)
    f1 = Math.min(f0 + 1, n - 1)
    t = w - f0
  } else {
    const c = Math.min(Math.max(frame, 0), n - 1)
    f0 = Math.floor(c)
    f1 = Math.min(f0 + 1, n - 1)
    t = c - f0
  }
  const k = track.keyframes
  const a = f0 * 9
  const b = f1 * 9
  const it = 1 - t
  // 欧拉角逐分量线性插值。原实现在这里做过「四元数取最短弧」的点积翻转，
  // 对欧拉角是错的：翻转会把角度整体取反，产生反向旋转。
  // 角度跨 ±π 边界的绕远路问题改为逐分量按最短方向处理。
  for (let i = 0; i < 9; i++) {
    if (i >= 3 && i <= 5) {
      let d = k[b + i] - k[a + i]
      if (d > Math.PI) d -= 2 * Math.PI
      else if (d < -Math.PI) d += 2 * Math.PI
      out9[i] = k[a + i] + d * t
    } else {
      out9[i] = k[a + i] * it + k[b + i] * t
    }
  }
  return out9
}

// 在 time 处求 anim 的骨骼局部变换矩阵（保留原签名，供单层路径与外部使用）
function sampleTrack(track, anim, time, out) {
  const v = sampleTrack._t || (sampleTrack._t = new Float32Array(9))
  sampleTrackTRS(track, anim, time, v)
  return composeTRS(v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7], v[8], out)
}

// 骨骼绑定姿势的 TRS 基准。
// [we-scene patch] **必须与 invBindWorld 同源**（`mdl.bindTRS`，由 parseMDL 的
// baseLocal 一并产出），不能在这里另用别的姿势重算一套。
// 旧实现取「平移 = 绑定矩阵第 4 列、旋转 = 0、缩放 = 1」，而 invBindWorld 取主动画
// frame0，两套参考系并存。它们在 59/73 个模型上恰好相等，掩盖了问题；不相等的
// 20 个（3148125112 人物2 差 2101px、腿1 差 1230px、3113287126 差 872px、
// 3233141951 龙 差 997px…）就出错。而且非 additive 层在 blend=1 时
// （acc = base·(1-w) + smp·w）把 base 整个替换掉，**t=0 仍然恒等** ——
// 静止画面正常，一动起来 additive 增量与 blend<1 的插值就落在错误参考系里，
// 父子骨被推向相反方向。
// 旧实现还把旋转固定为 0、缩放固定为 1，对绑定姿势自带旋转的骨直接错：
// 腿1 骨 3 的绑定角是 −2.608 rad，骨 13 是 −2.940 rad。
function bindTRS(mdl, i, out9) {
  const b = mdl.bindTRS && mdl.bindTRS[i]
  if (b) {
    out9.set(b)
    return out9
  }
  const m = mdl.bones[i].matrix
  out9[0] = m[12]; out9[1] = m[13]; out9[2] = m[14]
  out9[3] = 0; out9[4] = 0; out9[5] = Math.atan2(m[1], m[0])
  out9[6] = Math.hypot(m[0], m[1]) || 1
  out9[7] = Math.hypot(m[4], m[5]) || 1
  out9[8] = m[10] || 1
  return out9
}

/**
 * [we-scene patch] **MDLS 尾部的静态装配姿势**（`mdl.staticPoseTRS`，见 mdl-parse 的
 * parseStaticPose）。只有无 MDLA 的模型有；本函数是它在蒙皮侧的入口。
 *
 * 为什么必须有它：这类模型的顶点烘焙在图集布局上（「顶点位置 == uv×图集尺寸」残差
 * 恒 0），作者把零件分散画在贴图里、靠骨骼拼装。装配姿势不写在动画轨道里（它们没有
 * 轨道），只写在 MDLS 尾部这张表里。不解析 → 蒙皮恒等 → 画出来是**散开的图集**：
 * 3186328539 单车两轮脱离车架轴位、3226487183 抬头身体下半身整片落到画布外。
 *
 * 是否可用由调用方判定（**必须**同时满足「无动画轨道」与「有该表」）：
 * 有 MDLA 的 77 个模型靠动画轨道给姿势，套这张表会把它们改坏。
 */
function staticPoseTRS(mdl, i, out9) {
  const s = mdl.staticPoseTRS && mdl.staticPoseTRS[i]
  if (!s) return bindTRS(mdl, i, out9)
  out9.set(s)
  return out9
}


// 计算 time 处的蒙皮矩阵数组（World(anim) · invBindWorld），写入 mdl._skinCache
// [we-scene patch] boneOverrides：脚本层的骨骼平移覆写（`Map<boneIndex, [x,y,z]>`，
// **骨骼局部空间**，由宿主从世界像素换算而来，见 render/text.js 的 makeBoneApi）。
// WE 的 thisLayer.setBoneTransform() 语义按全库 4 处调用点实测为**绝对覆盖**而非累加
// （脚本每帧从 dragStart 重算绝对位置再写入；累加会让骨骼瞬间飞走）。
// 覆写写在 composeTRS **之前**，这样子骨会经下面的父链传播自动跟随。
export function computeSkinMatrices(mdl, time, animLayers, boneOverrides) {
  const bones = mdl.bones
  const count = bones.length
  if (count === 0) return null
  const hasOverride = !!(boneOverrides && boneOverrides.size > 0)
  if (!mdl._skin || mdl._skin.length !== count * 16) {
    mdl._skin = new Float32Array(count * 16)
    mdl._local = []
    mdl._world = []
    mdl._tmp = new Float32Array(16)
    mdl._tmp2 = new Float32Array(16)
    for (let i = 0; i < count; i++) {
      mdl._local.push(new Float32Array(16))
      mdl._world.push(new Float32Array(16))
    }
  }
  // ---- 逐动画层求局部姿势 ----
  // scene.json 的 animationlayers 是一个**列表**，每条含 animation(id) / additive /
  // blend / rate / visible，需要全部叠加。此前只取第一条可见层，于是像 lainpw 那样
  // 用 kopf/arm/body 三条动画分别驱动头(骨8)、手臂(骨4,5,6)、身体(骨1) 的模型，
  // 只播 kopf 会让其余骨骼被这条动画的轨道按绑定姿势覆写 —— 表现就是五官、头发、
  // 躯体各自错位僵死。
  // 叠加规则（TRS 空间）：
  //   base 取绑定姿势（frame0 实测等于绑定矩阵），
  //   每层贡献 = (该层采样 - base) × blend，additive 层累加，
  //   非 additive 层按 blend 覆盖式混合（mix(base, sample, blend)）。
  //   rate 逐层生效（各层动画速度不同，如 lainpw 的 0.4 / 0.5 / 0.5）。
  // [we-scene patch] 列表非空但全部 visible:false → **绑定姿势**，不要退回
  // animations[0]。官方 IAnimationLayer.visible = 这一层当前是否被应用；
  // 3233141951 刀的 newproperty38「武士刀动画 开/关」关掉后若仍播 clip，开关无效。
  // 只有调用方没给层信息（undefined / 空数组）时才退回第一条，兼容没写
  // animationlayers 的旧场景。
  const hadExplicitLayers = Array.isArray(animLayers) && animLayers.length > 0
  const layers = []
  if (hadExplicitLayers) {
    for (const l of animLayers) {
      if (l.visible === false || l.visible === 0) continue
      // [we-scene patch] 脚本 play()/stop() 运行态：stop 后该层不参与蒙皮
      //（3396722575 错帧机制：init 停掉错位层、帧事件到达再 play）。
      if (l.playing === false) continue
      const a = mdl.animations.find((x) => x.id === l.animation)
      if (a) layers.push({ anim: a, additive: !!l.additive, blend: typeof l.blend === 'number' ? l.blend : 1, rate: typeof l.rate === 'number' ? l.rate : 1 })
    }
  }
  // [we-scene patch] 标记「零动画且无覆写」：draw 仍按 identitySkin 走（绑定姿势蒙皮
  // 恒等于单位变换），但**不能再提前 return** —— 早退会让 _world 停在未填充的零矩阵，
  // attachmentWorld 读到附着点 (0,0)，followAttachments 算出 delta = 0 − 绑定偏移，
  // 把挂在这种「无动画中间 puppet」上的挂件整组反向拽飞。3463520581 的亚丝娜头发链
  // （ASUNA PUPPET→HAIR BACK BIG→main hair back c2→c2 部件）中间两层正是无动画
  // puppet，整束后发被拉到头顶右上方形成第二个头/身体。仍要跑完下面的骨骼循环，
  // 把 _local/_world 填成绑定姿势，供 attachmentWorld / followAttachments 使用。
  // [we-scene patch] **无动画模型用 MDLS 尾部的静态装配姿势**（见 staticPoseTRS 头注）。
  // 判据必须三条同时成立：① 这个模型一条动画轨道都没有（mdl.animations 空）；
  // ② 场景也没给它 animationlayers；③ 解析到了那张表。有动画的 77 个模型照旧走
  // 动画（frame0 == MDLS 链），一行都不受影响。
  // 3186328539 单车：套上它两个轮心才落到车架轴位（Δy 359→4、轮距 991→1289）；
  // 3226487183 抬头身体背景：骨0 平移 −1023.6 → −460.0（下半身从画布外收回）。
  // 判据只看**这个模型自己有没有动画轨道**：没有轨道时场景里的 animationlayers 一定
  // 解析不到任何 clip（layers 为空），静态姿势就是唯一的姿势来源。
  const useStaticPose = !(mdl.animations && mdl.animations.length) &&
    !!(mdl.staticPoseTRS && mdl.staticPoseTRS.length === count)

  let identityEarlyOut = false
  if (layers.length === 0 && !hadExplicitLayers) {
    const a = mdl.animations[0]
    // [we-scene patch] 无动画但有脚本覆写时**不能早退**：全库 3 个骨骼拖拽壁纸
    // （2998757800 / 3790261114 / 3790389413）的主 puppet 动画数都是 0，
    // 早退会让 draw() 走 identitySkin，覆写永远不生效。
    // 此时 layers 保持为空，下面每根骨 touched=false → 取绑定姿势，再叠覆写。
    if (!a) {
      // 有静态装配姿势时**不能**早退：蒙皮矩阵 = 静态姿势世界链 · invBindWorld ≠ 单位，
      // 早退会让 draw 用 identitySkin 把散件原样画出来（就是本函数要修的病）。
      identityEarlyOut = !hasOverride && !useStaticPose
    } else {
      layers.push({ anim: a, additive: false, blend: 1, rate: 1 })
    }
  }

  const base = mdl._trsBase || (mdl._trsBase = new Float32Array(9))
  const acc = mdl._trsAcc || (mdl._trsAcc = new Float32Array(9))
  const smp = mdl._trsSmp || (mdl._trsSmp = new Float32Array(9))

  for (let i = 0; i < count; i++) {
    if (useStaticPose) staticPoseTRS(mdl, i, base)
    else bindTRS(mdl, i, base)
    acc.set(base)
    let touched = false
    let addW = 0
    // 该骨是否已有非加算层给过基准姿势；首条加算 clip 是否已提供基准。
    let seenNonAdd = false
    let addBaseSet = false
    // additive 增量单独累加（见循环内注释），最后统一叠加与归一。
    const addDelta = mdl._addDelta || (mdl._addDelta = new Float32Array(9))
    addDelta.fill(0)
    for (const L of layers) {
      const track = L.anim.tracks[i]
      // 空轨道（0 关键帧）：sampleTrackTRS 会返回恒等 TRS(0,0,0,0,0,0,1,1,1)，
      // 那不是任何参考姿势 —— 非 additive 会把骨混向原点、additive 会叠出
      // (恒等−参考) 的垃圾增量。跳过 = 该骨保持此前的 acc（绑定/其它层）。
      if (!track || !track.keyframes.length) continue
      sampleTrackTRS(track, L.anim, time * L.rate, smp)
      const w = L.blend
      if (L.additive) {
        // 增量参考 = **本轨道自己的首关键帧**（clip 的参考姿势），不是绑定姿势。
        // 工坊导出的加算 clip 把非目标骨烘成作者录制姿势的**绝对局部值**，该值
        // ≠ 绑定姿势（3148125112 人物2「眼睛」39 条轨相对绑定平移偏移最大
        // 2101px，kkkk/katanabody 3130~3554px，全库 162 条加算层 47 条如此），
        // 按绑定取增量 = 给全身叠一个恒定偏移，人物上半身整体飞出（爆开）。
        // 相对首帧取增量后：常量轨道（人物2 46/85 条）增量恒 0，动画轨道只
        // 贡献相对录制起点的真实运动（人物2 最大 29px）；t=0 时加算层精确
        // 无贡献（3797270925 的「绑定姿势 t=0 应恒等」断言依赖这一点）。
        // keyframes 扁平存储 n*9，首关键帧的第 k 分量恰是 keyframes[k]。
        const rest = track.keyframes
        // **全加算层栈的基准**：这条骨没有非加算层、加算增量还没基准时，第一条
        // 加算 clip 的首帧就是基准姿势——把 acc 从绑定（= 图集散开位）换成装配位。
        // katanabody(3238423642) 10 条加算、无替换层，骨 6/16/22 绑定平移
        // 1479/2841/3075px 是图集散开位，所有 clip 的值 = 装配位 ± 小幅运动：
        // 不换基准人物缺头少臂（头骨钉在图集位）；Lucy 那类 kf0==绑定的全加算
        // 栈此步是无操作，行为与旧公式一致。
        if (!seenNonAdd && !addBaseSet) {
          for (let k = 0; k < 9; k++) acc[k] = rest[k]
          addBaseSet = true
        }
        for (let k = 0; k < 9; k++) {
          let d = smp[k] - rest[k]
          if (k >= 3 && k <= 5) {
            if (d > Math.PI) d -= 2 * Math.PI
            else if (d < -Math.PI) d += 2 * Math.PI
          } else if (k >= 6) {
            // 加算缩放：rest≈0 时 (sampled−0) 会把替换层已是 1 的眼睛再加一次 → 2× 拉长
            //（3226487183「眨眼」骨 37/40/41 kf0 sy=0，眨眼瞬间 sy→1）。
            // 采样值爆炸（同 clip 骨 56 sx=-7）是录制穿越 0 的符号翻转，不能当增量。
            // 跳过这两类，合法的闭眼缩放（rest=1、sampled→0.03，骨 43）仍生效。
            if (!(Math.abs(rest[k]) > 1e-3)) continue
            if (Math.abs(smp[k]) > 3 && Math.abs(rest[k]) < 1.5) continue
          }
          addDelta[k] += d * w
        }
        addW += w
      } else {
        seenNonAdd = true
        for (let k = 0; k < 9; k++) acc[k] = acc[k] * (1 - w) + smp[k] * w
      }
      touched = true
    }
    // additive 权重总和 >1 时按总权重归一：Lucy 那样 5 条 additive 层（blend 均为 1）
    // 若直接累加，同一根骨的增量会被叠 5 次，人物幅度被放大到形体明显走形。
    // WE 的 additive 混合是加权平均而非无界累加，故超过 1 时整体收缩回 1。
    // [we-scene patch] 归一化只能作用于**加算增量之和**，绝不能动 acc 本体：
    // acc 里还有非加算层的替换结果（blend=1 时 = 该层采样 = 装配姿势，与 base
    // 无关）。旧写法 `acc = base + (acc − base)/addW` 会把替换姿势也往绑定姿势
    // 拉回 1/addW —— kkkk(3223543799) 734 替换 + 1320/357 两条加算（addW=2）
    // 时全部部件被拉回图集散开位的一半（骨31 局部T −32 → −1775 = 绑定/2），
    // 人物整体撕成碎块；rigid 平移不产生法向翻转，I4 翻转指标对此完全失明。
    if (addW > 1) {
      for (let k = 0; k < 9; k++) addDelta[k] /= addW
    }
    if (addW > 0) {
      for (let k = 0; k < 9; k++) acc[k] += addDelta[k]
    }
    // [we-scene patch] 脚本覆写：绝对写入平移分量（旋转/缩放不动 —— 全库 19 处
    // Transform 调用只用 translation()，rotation/scale 零调用）。
    // 放在 composeTRS 之前，子骨经父链传播自动跟随。
    const ov = hasOverride ? boneOverrides.get(i) : undefined
    if (ov) {
      acc[0] = ov[0]; acc[1] = ov[1]; acc[2] = ov[2]
      touched = true
    }
    if (touched) {
      composeTRS(acc[0], acc[1], acc[2], acc[3], acc[4], acc[5], acc[6], acc[7], acc[8], mdl._local[i])
    } else {
      // 所有层都没有这根骨的轨道：保持绑定姿势。
      // [we-scene patch] 用 base（= mdl.bindTRS，与 invBindWorld 同源）而非
      // bones[i].matrix —— 二者在 20 个 puppet 上不等，混用会让「有轨道的骨」
      // 与「无轨道的骨」落在两套参考系里，接缝处撕裂。
      composeTRS(base[0], base[1], base[2], base[3], base[4], base[5], base[6], base[7], base[8], mdl._local[i])
    }
  }

  for (let i = 0; i < count; i++) {
    const p = bones[i].parent
    if (p >= 0 && p < i) mat4Mul(mdl._world[p], mdl._local[i], mdl._world[i])
    else mdl._world[i].set(mdl._local[i])
  }
  for (let i = 0; i < count; i++) {
    // 蒙皮矩阵 = World(anim) · World(绑定姿势)⁻¹，静止时为单位变换。
    // 不要再乘 MDLE 校正（restCorrection）。MDLE 存的是**贴图空间的静止姿势**：
    // 作者把眼睛/头发/手臂等部件在贴图里分散摆放，MDLE 描述的正是「网格姿态 →
    // 贴图里那些分散位置」的搬运。渲染要的恰好相反 —— 顶点保持网格姿态（人物
    // 完整），UV 直接去贴图对应区域取样即可，不需要任何搬运。
    // 实测 3787341007（lainpw）：乘上 restCorrection 会把眼睛（骨14/15）推到左边
    // 426px/360px、头发（骨12）推到右边 345px、头部（骨9/11）上移，躯干（骨0）不动
    // —— 正是「双眼在人物左边很远处独立存在、头发在右上方、头与脖子断开」的现象。
    // 不乘时顶点偏离原网格为 0px。取逆同样是 426px（方向不同、幅度一样），也不对。
    // 佐证：本机唯一一直正常的 puppet 模型（3791428510 各层）都没有 MDLE 块。
    mat4Mul(mdl._world[i], mdl.invBindWorld[i], mdl._tmp)
    mdl._skin.set(mdl._tmp, i * 16)
  }
  // 见 identityEarlyOut 注释：无动画无覆写时 draw 走 identitySkin（与此处算出的
  // 绑定姿势蒙皮逐位等价），返回 null 保持旧契约；_world 已是绑定姿势。
  return identityEarlyOut ? null : mdl._skin
}

/**
 * [we-scene patch] 取某根骨在**绑定姿势**下的世界矩阵（= invBindWorld 的逆）。
 * 用途：算附着点在网格空间的静止位置（配合 MDAT 的局部矩阵）。
 */
export function bindWorldOf(mdl, boneIndex) {
  if (!mdl || !mdl.invBindWorld) return null
  if (!(boneIndex >= 0 && boneIndex < mdl.invBindWorld.length)) return null
  return mat4Invert(mdl.invBindWorld[boneIndex])
}

/** [we-scene patch] 4x4 乘法（列主序），供宿主组合附着点变换 */
export function mat4MulOut(a, b) {
  return mat4Mul(a, b)
}

/**
 * [we-scene patch] 取附着点在**当前动画姿势**下的世界变换（4x4，列主序）。
 *
 *   World(附着点) = World(骨骼, 当前动画) · attachment.matrix
 * 其中 attachment.matrix 是附着点相对该骨的固定局部偏移（MDAT 块里存的）。
 *
 * 动画跟随取「当前姿势」与「绑定姿势」之差（见 followAttachments）。
 * 静态定位用 attachmentBind，不要拿当前姿势去做第一次 origin 合并。
 *
 * **必须先调用 computeSkinMatrices**（同一 time/animLayers），本函数复用它算好的
 * `mdl._world`；否则拿到的是上一帧甚至未初始化的姿势。返回 null 表示该模型没有
 * 附着点表、或名字对不上（调用方应退回不加位移，即改动前的行为）。
 *
 * 名字匹配用**全等**：全库 35 个唯一附着点名里有 "左头发1"/"左头发2" 这类只差
 * 末位数字的，前缀匹配会挂错骨。
 */
export function attachmentWorld(mdl, name) {
  if (!mdl || !mdl.attachments || typeof name !== 'string' || name === '') return null
  if (!mdl._world) return null
  for (const at of mdl.attachments) {
    if (at.name !== name) continue
    if (at.bone < 0 || at.bone >= mdl._world.length) return null
    return mat4Mul(mdl._world[at.bone], at.matrix)
  }
  return null
}

/**
 * 绑定姿势下附着点的网格空间变换（Y-up 像素，相对父层 origin）。
 * 与 attachmentWorld 同一套矩阵链，但不依赖 computeSkinMatrices。
 */
export function attachmentBind(mdl, name) {
  if (!mdl || !mdl.attachments || typeof name !== 'string' || name === '') return null
  for (const at of mdl.attachments) {
    if (at.name !== name) continue
    const bw = bindWorldOf(mdl, at.bone)
    if (!bw) return null
    return mat4Mul(bw, at.matrix)
  }
  return null
}

/**
 * 网格 UV 是否与层矩形坐标 1:1（MDLV0019 puppet-warp：顶点画在贴图图集布局上）。
 * 无动画时绑定姿势 = 图集散开，MDAT 附着点也是图集坐标，不能当世界偏移。
 */
function puppetUvMatchesLayout(mdl, size) {
  if (!mdl || !mdl.uvs || !mdl.positions || !size) return false
  const W = size[0]
  const H = size[1]
  if (!(W > 0 && H > 0) || mdl.vertexCount < 3) return false
  const n = Math.min(mdl.vertexCount, 48)
  const step = Math.max(1, (mdl.vertexCount / n) | 0)
  let err = 0
  let count = 0
  for (let i = 0; i < mdl.vertexCount; i += step) {
    const x = mdl.positions[i * 3]
    const y = mdl.positions[i * 3 + 1]
    const eu = Math.abs(mdl.uvs[i * 2] - (x + W / 2) / W)
    const ev = Math.abs(mdl.uvs[i * 2 + 1] - (H / 2 - y) / H)
    err += Math.max(eu, ev)
    count++
  }
  return count > 0 && err / count < 1e-3
}

/** 父层网格空间偏移 → 场景 origin 空间（Y-up）。旋转约定与 parse.js 父子合并逐字相同。 */
export function parentMeshToWorldDelta(parent, dx, dy) {
  const ang = parent && parent.angles ? parent.angles[2] || 0 : 0
  const sx = parent && parent.scale ? parent.scale[0] : 1
  const sy = parent && parent.scale ? parent.scale[1] : 1
  const ca = (ang * Math.PI) / 180
  const cos = Math.cos(ca)
  const sin = Math.sin(ca)
  const ox = dx * sx
  const oy = dy * sy
  return [ox * cos - oy * sin, ox * sin + oy * cos]
}

/**
 * parse.js 只合并了「父 origin + 子 local」。有 attachment 且父级已挂上 puppet 时，
 * 再把绑定姿势附着点加进去：
 *
 *   world = parentOrigin + rotate(scale(local + attBind))
 *         = 已合并 origin + rotate(scale(attBind))
 *
 * parse 在还没有 MDL 时就把子孙 origin 烤成世界坐标。只挪带 `attachment` 的那一层，
 * 它的孩子会停在「没加附着点」的旧位置：3791001607 空组「头发」上移 850px，
 * 可见的「主发」仍在胸口；3790371777「黍头」加上附着点后眼睛/发簪还停在左侧。
 * 位移必须传给整棵子孙。嵌套挂件（子层自己也有 attachment）两边的偏移都要加。
 *
 * 找不到附着点或父级不是 puppet → 原样留下（退化成改动前的普通父子合并）。
 * 返回逐帧 follow 用的记录（base 是加完附着点后的静止 origin，含子孙快照）。
 */
export function applyAttachmentBindOrigins(layers) {
  const byId = new Map()
  const childrenOf = new Map()
  for (const layer of layers) {
    if (!layer || layer.id === undefined || layer.id === null) continue
    byId.set(layer.id, layer)
    if (layer.parentId === undefined || layer.parentId === null) continue
    const list = childrenOf.get(layer.parentId)
    if (list) list.push(layer)
    else childrenOf.set(layer.parentId, [layer])
  }
  const collectDesc = (layer, out) => {
    const kids = childrenOf.get(layer.id)
    if (!kids) return
    for (const c of kids) {
      out.push(c)
      collectDesc(c, out)
    }
  }
  const follows = []
  for (const layer of layers) {
    const name = layer && layer.attachment
    if (typeof name !== 'string' || name === '') continue
    const parent = byId.get(layer.parentId)
    if (!parent || !parent.puppet) continue
    const bindM = attachmentBind(parent.puppet, name)
    if (!bindM) continue
    const bx = bindM[12]
    const by = bindM[13]
    // 无动画的图集布局 puppet：绑定附着点是贴图散开位（3226487183 抬头身体
    // Attachment 在 (289,-656)），加上去会把已装配的脸拽到画外。有动画时
    // follow 会用「当前−绑定」把挂件收到装配姿势，必须保留这份偏移。
    // [we-scene patch 3186328539] **还必须有「没有静态装配姿势」这一条**。
    // 这个 0 位移是与「follow 的增量也恒为 0」配对使用的（旧实现里无动画 puppet
    // 蒙皮恒等 = 渲染的就是图集散开位，两者同时成立才自洽）。无 MDLA 的模型现在
    // 渲染的是 MDLS 尾部的静态装配姿势（姿态变了、且与绑定姿势差一个装配位移），
    // 于是 follow 的增量不再为 0 —— 此时再把它压成 0，就只剩这半边的错：
    // 3226487183 jiaose=3 的「抬头拆分」净位移从应有的 (4.8,−218)px 变成
    // (−569,1126)px（脸被推离身体 1262px，用户实机报「只有脸部不正确」）。
    // 有静态姿势的模型与**有动画的模型同款处理**（同一具身体模型、同一个姿势：
    // 静态姿势 == 动画 frame0，实测两者附着点都在 (2.4,−108.8)），
    // 净位移自然同为 (4.8,−218)px —— 那条路是 CASEBOOK 实机确认「脸在头上」的。
    // [we-scene patch 3463520581] **图集散开位必须按模型格式（MDLV0019 puppet-warp）
    // 判定，不能拿「UV≈网格布局」当代理。** 整图 sprite 的 MDLV0023 模型同样满足那个
    // UV 启发式（顶点与 UV 本来就是 1:1 的整块矩形），于是被误判成图集模型：
    // 3463520581 的 HAIR BACK (BIG) / main hair back c2 都是 MDLV0023、0 动画、无静态
    // 姿势、uvErr≈2e-8 → atlasBind 成立 → **26 个挂件层（c3 + c2 部件）的附着点位移
    // 全被压成 0**，整片后发停在装配前的位置、缩在身体后面，Mirage 里那片宽发帘整个
    // 消失（用户报「头发错位」）。全库 132 行附着点实测：这条判定只影响本壁纸 26 行，
    // 另有 1 行 bind=[0,0]（压不压等价）；MDLV0019 的 4 个父模型（全在 3226487183）
    // 本来就被「有动画 / 有静态姿势」两条排除，一行未动。
    const atlasBind = !(parent.puppet.animations && parent.puppet.animations.length) &&
      !parent.puppet.staticPoseTRS &&
      parent.puppet.magic === 'MDLV0019' &&
      puppetUvMatchesLayout(parent.puppet, parent.size)
    const d = atlasBind ? [0, 0] : parentMeshToWorldDelta(parent, bx, by)
    const desc = []
    collectDesc(layer, desc)
    layer.origin[0] += d[0]
    layer.origin[1] += d[1]
    for (const c of desc) {
      c.origin[0] += d[0]
      c.origin[1] += d[1]
    }
    // 挂件整棵子树的视差深度必须与附着目标（puppet 层）一致：挂件的一切屏幕
    // 行为跟着骨骼走，视差深度也属于骨骼所在的层。parse 的视差继承只覆盖
    // 「父是空组」，而挂件的父是 puppet（有 image）——继承不到组深度：
    // 3232289987 精细模式下躯干继承组 -1.06，前发/右臂/发饰 parallax=null、
    // 右眼球显式 "0 0"，视差一拉头走了五官钉在原地，像没绑在头上。
    // （作者给挂件随手写 parallax 0 是常态，覆盖为骨骼深度才是 WE 语义。）
    layer.parallaxDepth = parent.parallaxDepth ? parent.parallaxDepth.slice() : null
    for (const c of desc) {
      c.parallaxDepth = layer.parallaxDepth ? layer.parallaxDepth.slice() : null
    }
    // [we-scene patch] 绑定姿势偏移要留在图层上。逐帧 recomposeWorld 会从
    // `父 world + local` 重算这一层的 world，只把偏移加进 origin 的话，
    // 祖先一动重算就把它抹掉，挂件（眼睛/头发/眼泪）会掉回未附着的位置。
    // 只标在挂件层自己身上：子孙由 recompose 通过父链自然继承，标了会重复计入。
    layer.attachBindDelta = [d[0], d[1]]
    follows.push({
      layer,
      parent,
      name,
      bindX: bx,
      bindY: by,
      desc,
    })
  }
  // 全部附着点加完再快照：嵌套挂件的子孙 origin 已经含祖先偏移。
  for (const f of follows) {
    f.baseX = f.layer.origin[0]
    f.baseY = f.layer.origin[1]
    f.subtree = [{ layer: f.layer, x: f.layer.origin[0], y: f.layer.origin[1] }]
    for (const c of f.desc) f.subtree.push({ layer: c, x: c.origin[0], y: c.origin[1] })
    // [we-scene patch] 给整棵子树挂上「本帧绑定姿势基准」槽。
    // 静态场景里它恒等于挂载期快照；祖先带脚本/动画变换时由 recomposeWorld
    // 每帧重写（见 scene/parse.js）。followAttachments 只读不写，保证幂等。
    for (const s of f.subtree) {
      if (!s.layer.attachBase) s.layer.attachBase = [s.x, s.y]
    }
  }
  return follows
}

/**
 * 每帧把挂件 origin 写成 base + (当前附着点 − 绑定附着点)。
 * 必须从 base 重写，不能在 layer.origin 上累加。getBoneOverrides(parent)
 * 与 puppet draw 喂给 computeSkinMatrices 的是同一张表。
 *
 * 嵌套挂件：先全体回到绑定快照，再把每条 follow 的增量加到它的整棵子孙。
 * 只写 f.layer 会让「主发 / 眼睛」停在绑定姿势、不随父骨摆。
 *
 * [we-scene patch] base 不能再用挂载期快照：祖先若带脚本/动画变换，
 * recomposeWorld 每帧都会重算这些层的 world（挂件的绑定偏移由
 * `attachBindDelta` 在重算里叠好）。此时把 origin 拍回挂载期的
 * `f.baseX/baseY` 等于把祖先的位移整个撤销 —— 3786330502 的人物组一滑动，
 * 7 个挂件（眼睛/眼泪×4/头发/眼眉）就会留在原地，人物一分为二。
 * 改为**每帧调用前读一次当前 origin 当 base**（recompose 刚写好的值），
 * 骨骼增量叠在它上面。没有 recompose 参与的场景里，当前 origin 恒等于
 * 挂载期快照，行为与改动前逐位相同。
 */
export function followAttachments(follows, time, getBoneOverrides) {
  if (!follows || follows.length === 0) return
  const computed = new Set()
  const deltas = []
  for (const f of follows) {
    const puppet = f.parent && f.parent.puppet
    if (!puppet) {
      deltas.push(null)
      continue
    }
    if (!computed.has(puppet)) {
      computed.add(puppet)
      const overrides = typeof getBoneOverrides === 'function' ? getBoneOverrides(f.parent) : null
      computeSkinMatrices(puppet, time, f.parent.animationLayers, overrides)
    }
    const cur = attachmentWorld(puppet, f.name)
    if (!cur) {
      deltas.push(null)
      continue
    }
    deltas.push(parentMeshToWorldDelta(f.parent, cur[12] - f.bindX, cur[13] - f.bindY))
  }
  // 本帧基准：优先用 recomposeWorld 刚写下的 `attachBase`（父子变换重算后的
  // 绑定姿势世界位），否则退回挂载期快照 s.x/s.y（静态场景走这条，与改动前逐位相同）。
  // **绝不能拿 `layer.origin` 当基准** —— 那是上一次 follow 的输出，连调两次就把
  // 骨骼增量累加两遍（verify-attachments 的「调用两次必须得到同一 origin」正是锁这个）。
  // attachBase 只由 recompose 写、follow 只读，因此本函数幂等。
  const baseOf = (s) => {
    const ab = s.layer.attachBase
    if (ab) return ab
    return [s.x, s.y]
  }
  const seen = new Set()
  for (const f of follows) {
    const tree = f.subtree || [{ layer: f.layer, x: f.baseX, y: f.baseY }]
    for (const s of tree) {
      if (seen.has(s.layer)) continue
      seen.add(s.layer)
      const b = baseOf(s)
      s.layer.origin[0] = b[0]
      s.layer.origin[1] = b[1]
    }
  }
  for (let i = 0; i < follows.length; i++) {
    const f = follows[i]
    const d = deltas[i]
    const tree = f.subtree || [{ layer: f.layer, x: f.baseX, y: f.baseY }]
    if (!d) continue
    for (const s of tree) {
      s.layer.origin[0] += d[0]
      s.layer.origin[1] += d[1]
    }
  }
}
