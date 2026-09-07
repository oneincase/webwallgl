// 场景对象模型：scene.json + project.json → 归一化图层列表
//
// [we-scene patch] 用户属性解引用（resolveUserValue）
//
// scene.json 里受壁纸自定义属性控制的字段形如 `{"user": "bgcolor", "value": "0.1 0.2 0.3"}`：
// `user` 是 project.json `general.properties` 里的属性名，`value` 是场景保存时的快照。
// 也可以是 `{"user":{"name":"game","condition":"3"},"value":true}`：字段值 = (属性 == condition)。
//
// 快照与 project.json 默认值并非总是相等 —— 本机 78 个场景的 3117 处引用里有 381 处不等
// （作者改过属性默认值却没重存场景，或字段名与属性名撞车，如某场景的 visible 绑到一个
// color 属性上）。
//
// 规则：优先属性表（这是 WE 的运行时语义，判据见 resolveUserValue 上方的烘焙值统计），
// 但类型撞车（形状不符）时退回场景快照，避免把 color 塞进 visible 这种错乱。
// [we-scene patch] 用户属性解引用已拆至 ./user-props.js（本仓库拆分，见 docs/ARCHITECTURE.md）
import { resolveUserProps } from './user-props.js'
export function parseVec3(s) {
  if (typeof s === 'object' && s !== null) s = s.value
  const p = String(s ?? '').trim().split(/\s+/).map(Number)
  // WE 标量→向量广播：scale/angles 绑单个 slider 时属性值解为标量，需广播到全分量
  // （见 user-props.js「标量与向量按分量广播」注释）。实测 3264246690 父级 scale
  // 绑 newproperty6(slider=1.43)，不广播则 Y/Z 为 0 → 人物被压扁到不可见。
  if (p.length === 1) return [p[0] || 0, p[0] || 0, p[0] || 0]
  return [p[0] || 0, p[1] || 0, p[2] || 0]
}

export function parseVec2(s) {
  if (typeof s === 'object' && s !== null) s = s.value
  const p = String(s ?? '').trim().split(/\s+/).map(Number)
  if (p.length === 1) return [p[0] || 0, p[0] || 0]
  return [p[0] || 0, p[1] || 0]
}

export function parseColor(c) {
  if (c === undefined || c === null) return [1, 1, 1]
  if (typeof c === 'string') return parseVec3(c)
  if (typeof c === 'object' && c !== null) return parseVec3(c.value)
  return [1, 1, 1]
}

export function parseBool(v, dflt = false) {
  if (v === undefined || v === null) return dflt
  if (typeof v === 'boolean') return v
  // slider 当开关时会漏进 0/1：userOverridden 路径直接返回属性表数字，
  // 走默认值会把 0 解成 true（animationlayers.visible 的 dflt 就是 true）。
  if (typeof v === 'number') return v !== 0
  if (typeof v === 'object' && v !== null) {
    const inner = v.value
    if (typeof inner === 'number') return inner !== 0
    return !!inner
  }
  return dflt
}

// [we-scene patch] 数值字段：同样要拆 {user, value} 包装。
// 原版对 alpha / brightness / volume / pointsize / animationlayers.rate 一律用
// `typeof o.x === 'number'` 判定，包装对象直接落到默认值 —— 本机 78 个场景里
// alpha 有 188 处绑属性，其中 62 处快照值不是 1（含 2 处 alpha=0），被强制成 1 后
// 这些半透明层（水汽、光晕、暗角）画成了完全不透明，甚至该隐藏的层照样显示。
export function parseNum(v, dflt) {
  if (typeof v === 'number') return v
  if (v !== null && typeof v === 'object') {
    const n = Number(v.value)
    return Number.isFinite(n) ? n : dflt
  }
  return dflt
}

/**
 * 「渲染惰性纯容器」判据：无 image / model / particle / text 且无 size。
 * WE 只把这种「排版夹具」节点当分组用，**不把它的 scale 传给子层**
 * （3791354118 / 3264246690 的无名组 id 373，详见 composeChildTransform 内注释）。
 */
export function isRenderInert(o) {
  if (!o) return false
  return !o.image && !o.model && !o.particle && o.text == null && !o.size
}

/**
 * 父子变换合成：`(父 world, 子 local) → 子 world`。
 *
 * [we-scene patch] **这段数学是 parse 阶段的静态合并与运行时 recomposeWorld
 * 的唯一实现**。两边各写一份必然发散（改了一处忘另一处，画面错位且无报错），
 * 所以抽成纯函数由双方共用。改这里等于同时改两条路径，verify-transform
 * 的「静态场景上 recompose 必须与 parse 逐位相等」就是锁这一点的。
 *
 * 约定：WE 2D 层只用 z 旋转，角度制；Y 轴向下（与 parse 的世界系一致）。
 *
 * @param {{origin:number[],scale:number[],angles:number[]}} parentWorld 父层世界变换
 * @param {{origin:number[],scale:number[],angles:number[]}} childLocal 子层局部变换
 * @param {boolean} parentScalePropagates 父 scale 是否传给子层（渲染惰性纯容器为 false）
 */
export function composeChildTransform(parentWorld, childLocal, parentScalePropagates) {
  const pscale = parentScalePropagates ? parentWorld.scale : [1, 1, 1]
  const ca = ((parentWorld.angles[2] || 0) * Math.PI) / 180
  const cos = Math.cos(ca)
  const sin = Math.sin(ca)
  const ox = childLocal.origin[0] * pscale[0]
  const oy = childLocal.origin[1] * pscale[1]
  return {
    origin: [
      parentWorld.origin[0] + ox * cos - oy * sin,
      parentWorld.origin[1] + ox * sin + oy * cos,
      parentWorld.origin[2] + (childLocal.origin[2] || 0),
    ],
    scale: [
      pscale[0] * childLocal.scale[0],
      pscale[1] * childLocal.scale[1],
      pscale[2] * childLocal.scale[2],
    ],
    angles: [childLocal.angles[0], childLocal.angles[1], (parentWorld.angles[2] || 0) + childLocal.angles[2]],
  }
}

export function parseScene(sceneJson, project) {
  const properties = (project && project.general && project.general.properties) || {}
  const objects = sceneJson.objects || []
  // [we-scene patch] 先把所有 {user, value} 包装解成生效值（详见文件头注释），
  // 之后的字段读取一律拿到已解引用的值。
  resolveUserProps(objects, properties, 0)
  resolveUserProps(sceneJson.general || {}, properties, 0)

  // ---- 父子层级：子对象坐标是相对父级的局部坐标，需合并到世界坐标 ----
  // WE 语义：子 origin 相对父原点；父旋转/缩放作用于子。父级无动画时静态合并等价。
  // 带 `attachment` 的挂件还要再加上父 puppet 绑定姿势的附着点（MDL 装好后
  // 由 applyAttachmentBindOrigins 补，并传给该层子孙；这里仍然只做父 origin + local）。
  const byId = new Map()
  for (const o of objects) {
    if (o.id !== undefined) byId.set(o.id, o)
  }
  const local = objects.map((o) => ({
    id: o.id,
    parent: o.parent,
    origin: parseVec3(o.origin || '0 0 0'),
    scale: parseVec3(o.scale || '1 1 1'),
    angles: parseVec3(o.angles || '0 0 0'),
  }))
  // [we-scene patch] 局部变换必须原样留一份。脚本 / 关键帧动画绑在 origin/scale/angles
  // 上时，作者写的是**父级相对坐标**（3786330502 的 12 个气泡 scriptProperties.A
  // 就是 local y，气泡1 的 −433 作为世界 Y 根本不成立）。合并后只剩 world，
  // 逐帧把 world 喂进 update(value) 再把返回的 local 写回，图层会当场跳位；
  // 父组自己动时子层也无从跟随。运行时由 recomposeWorld 拿这份 local 重新合成。
  const localSnapshot = local.map((c) => ({
    origin: c.origin.slice(),
    scale: c.scale.slice(),
    angles: c.angles.slice(),
  }))
  // 自底向上迭代合并（层级深时循环至收敛）
  for (let pass = 0; pass < 8; pass++) {
    let changed = false
    for (const c of local) {
      if (c.parent === undefined || c.parent === null) continue
      const p = byId.get(c.parent)
      if (!p) continue
      const pIdx = local.findIndex((x) => x.id === c.parent)
      if (pIdx < 0) continue
      const pc = local[pIdx]
      if (pc.parent !== undefined && pc.parent !== null) continue // 父级还未合并完成，下一轮
      // [we-scene patch] 「渲染惰性纯容器」的 scale 不参与父子合并。
      // 3791354118 / 3264246690 的无名组（id 373）：无 image、无 size、solid:true，
      // scale 绑用户属性 newproperty6（快照 1.43）。乘进子层后人物总缩放 0.7848，
      // 头顶越出设计上沿；WE 实机缩略图里人物总缩放就是子层自身的 0.54881
      // （头顶距设计顶 ≈4%）。即 WE 对这种「只当排版夹具」的节点不把 scale
      // 传给子层。带 image/size 的真图层（3789007480 Clock 0.2、3396722575
      // 耳坠 0.5、3791967416 交互按钮 0.32 等）照旧传播；静态字面量（3151551777
      // Snow storm -1 镜像、3113287126 Albuim Art 48.4）也不受影响。
      const pr = objects[pIdx]
      const prs = pr.scale
      const runtimeBound =
        prs !== null && typeof prs === 'object' && (typeof prs.script === 'string' || prs.user !== undefined)
      const propagateScale = !(runtimeBound && isRenderInert(pr))
      const w = composeChildTransform(pc, c, propagateScale)
      c.origin = w.origin
      c.scale = w.scale
      c.angles = w.angles
      c.parent = null // 标记已合并
      changed = true
    }
    if (!changed) break
  }

  // [we-scene patch] 可见性沿父链继承：父级隐藏时其所有后代都不渲染。
  // WE 里 visible 常绑用户属性（如 language / clocklocation）来切换整组图层，
  // 只看自身 visible 会把 5 套隐藏的语言变体一起画出来——其中的半透明水面层
  // （ripple1440p）被反复叠加上百次，把画面糊成一片灰，看起来就像蒙了层蒙版。
  const visibleSelf = objects.map((o) => parseBool(o.visible, true))
  const idxById = new Map()
  objects.forEach((o, i) => {
    if (o.id !== undefined) idxById.set(o.id, i)
  })
  // 容器层的子层数（渲染器据此决定是否把「空容器 + 图层效果」当画布渲染：
  // WE 音频可视化的标准做法就是空 composelayer 挂示波器/音频条效果）
  const childCounts = new Map()
  const childIdsById = new Map()
  for (const o of objects) {
    if (o.parent !== undefined && o.parent !== null) {
      childCounts.set(o.parent, (childCounts.get(o.parent) || 0) + 1)
      const id = o.id !== undefined ? o.id : null
      if (id !== null) {
        const list = childIdsById.get(o.parent)
        if (list) list.push(id)
        else childIdsById.set(o.parent, [id])
      }
    }
  }
  const effVisible = objects.map(() => true)
  for (let i = 0; i < objects.length; i++) {
    let vis = visibleSelf[i]
    let p = objects[i].parent
    // 沿父链上溯，任一祖先隐藏则本层隐藏；深度设上限以防数据里存在环
    for (let guard = 0; vis && p !== undefined && p !== null && guard < 64; guard++) {
      const pi = idxById.get(p)
      if (pi === undefined) break
      if (!visibleSelf[pi]) vis = false
      p = objects[pi].parent
    }
    effVisible[i] = vis
  }

  const layers = objects.map((o, i) => {
    const world = local[i]
    // projectlayer / fullscreenlayer 覆盖整个正交投影。作者常留编辑器预览框
    // （973101892：1248×702 @ origin 0）或 size 缺省 [0,0]；按作者矩形画
    // 只动左上角一小块，看起来还是「整张星云不会动」。
    const isPost =
      typeof o.image === 'string' &&
      (o.image.indexOf('models/util/projectlayer') === 0 || o.image.indexOf('models/util/fullscreenlayer') === 0)
    let layerSize = parseVec2(o.size || '0 0')
    let layerOrigin = world.origin
    if (isPost) {
      const ortho = (sceneJson.general || {}).orthogonalprojection
      const gw = ortho && Number(ortho.width)
      const gh = ortho && Number(ortho.height)
      if (gw > 0 && gh > 0) {
        layerSize = [gw, gh]
        layerOrigin = [gw / 2, gh / 2, world.origin[2] || 0]
      }
    }
    return {
      id: o.id !== undefined ? o.id : i,
      name: o.name || '',
      visible: effVisible[i],
      // 自身可见性（未沿父链折叠）。热更用户属性时据此重算继承，避免把脚本改过的
      // 子层 visible 和「父组开关」揉成一份后无法局部刷新。
      visibleSelf: visibleSelf[i],
      // 指向 scene.json 原对象（resolveUserProps 就地解 {user,value}）。
      // 自定义配置热更时只重解这棵树并回写绑定字段，不必整包重挂。
      srcObject: o,
      image: typeof o.image === 'string' ? o.image : null,
      // [we-scene patch] 真 3D 对象直接挂 `.mdl`（不经 models/*.json 的 puppet 字段）。
      // 全库目前只有 3509243656 的恒星/天空盒/地球。丢掉的话装配循环看不到模型。
      model: typeof o.model === 'string' ? o.model : null,
      isSkybox: typeof o.name === 'string' && o.name.indexOf('天空盒') >= 0,
      particle: typeof o.particle === 'string' ? o.particle : null,
      // [we-scene patch] 粒子参数覆盖 + 声音 + 文字 + 组件
      instanceoverride: o.instanceoverride || null,
      sound: Array.isArray(o.sound) ? o.sound.filter((s) => typeof s === 'string') : [],
      soundprops: {
        volume: parseNum(o.volume, 1),
        playbackmode: o.playbackmode || 'single',
        startsilent: parseBool(o.startsilent, false),
        maxtime: parseNum(o.maxtime, 0),
        mintime: parseNum(o.mintime, 0),
        spatialization: parseBool(o.spatialization, false),
        muteineditor: parseBool(o.muteineditor, false),
      },
      text: typeof o.text === 'string' ? o.text : (o.text && typeof o.text === 'object' ? o.text.value : null),
      textScript: o.text && typeof o.text === 'object' ? (o.text.script || null) : null,
      textScriptProps: o.text && typeof o.text === 'object' ? (o.text.scriptproperties || null) : null,
      component: typeof o.component === 'string' ? o.component : null,
      isText: !!(o.text !== undefined && o.text !== null),
      // 文字布局属性（WE 文字对象 = size 尺寸的盒子，文字在盒内按对齐/内边距排版）
      textFont: typeof o.font === 'string' ? o.font : null,
      textPointsize: parseNum(o.pointsize, 24) || 24,
      textColor: parseColor(o.color),
      // anchor 是盒子相对 origin 的锚点（同 image alignment 枚举，外加 "none"）。
      // 本机 563 个文字层：none 237 / 缺省 301 / center 20 —— none 与缺省都按 center 处理
      // （WE 对象缺省对齐就是 center；显式 center 的挂件与时钟层行为一致）。
      // 2780710296 实验过默认改 top：竖直阶梯对了，但会平移其它壁纸文字相对图元的位置，已回滚。
      textAnchor: typeof o.anchor === 'string' && o.anchor !== 'none' ? o.anchor : 'center',
      textMaxwidth: parseNum(o.maxwidth, 0),
      textMaxrows: parseNum(o.maxrows, 0),
      textLimitwidth: parseBool(o.limitwidth, false),
      textLimitrows: parseBool(o.limitrows, false),
      textLimituseellipsis: parseBool(o.limituseellipsis, false),
      textHAlign: o.horizontalalign || 'center',
      textVAlign: o.verticalalign || 'center',
      textSpacing: o.spacing ? parseVec2(o.spacing) : [0, 0],
      // padding 两种实测形态：标量 32（256 处）与 "32 32" 两分量字符串（307 处，
      // 分量在全部样本中相等，按 uniform 处理）。parseNum 对字符串会落 0，需先取分量。
      // 32 是编辑器默认，常写在比 64px 还小的盒子上；装不下时 layout 侧夹成 0，
      // 这里仍保留原值（2134765860 的 82 是作者按时钟盒算的真 inset）。
      textPadding: (() => {
        const p = o.padding
        if (typeof p === 'number') return p
        const n = String(p ?? '').trim().split(/\s+/).map(Number).filter((x) => Number.isFinite(x))
        return n.length ? n.reduce((a, b) => a + b, 0) / n.length : 0
      })(),
      textOpaquebackground: parseBool(o.opaquebackground, false),
      textBackgroundcolor: parseColor(o.backgroundcolor),
      textBackgroundbrightness: parseNum(o.backgroundbrightness, 1),
      textCastshadow: parseBool(o.castshadow, false),
      isSound: !!(o.sound && o.sound.length),
      isComponent: !!o.component,
      // [we-scene patch] 对象脚本：scale/origin/color/alpha/brightness/angles/visible 字段可绑
      // WE 脚本（音频条 scale 读 registerAudioBuffers 逐帧改写是经典用法，本场景 31 处）。
      // 解析保留脚本原文与静态快照，宿主逐帧求值后写回图层字段（见 main.ts）。
      //
      // **visible 必须在列**：全库 180 个 visible 脚本（跨 40 个壁纸）承载了绝大多数
      // 指针交互 —— 266 个 cursor* 回调里有 115 个（43%）挂在这个字段上，包括全部
      // 3 个骨骼拖拽壁纸（2998757800 / 3790261114 / 3790389413）。
      // 白名单漏掉它时这些脚本**根本不会被 evalObjectScript 加载**，
      // 于是回调实现得再全也一处都不会派发。
      // 语义：value 快照全库 180/180 为 boolean；109 个含 update（逐帧决定显隐）、
      // 71 个纯 cursor 交互（无 update，靠回调改写别的图层）。
      objectScripts: (() => {
        const out = {}
        for (const f of ['scale', 'origin', 'color', 'alpha', 'brightness', 'angles', 'visible']) {
          const v = o[f]
          if (v && typeof v === 'object' && typeof v.script === 'string' && v.script) {
            out[f] = { script: v.script, scriptproperties: v.scriptproperties || null, value: v.value }
          }
        }
        return Object.keys(out).length ? out : null
      })(),
      // [we-scene patch] 字段关键帧动画（`animation: {c0:[...], options:{...}}`）。
      // 与 objectScripts 同理：不在这里留下来，渲染侧就只能读那份静态 `value` 快照。
      // 全库 126 处 / 25 张壁纸，三大挂载点是 effect 常量 `multiply`(32)、
      // 对象 `alpha`(32)、对象 `origin`(27)。求值见 render/animation.js。
      // 这里连 `value` 一起存：`relative:true`（34 处，仅 origin/angles/scale）
      // 的动画值是**相对基准的增量**，求值时要叠加回去。
      objectAnimations: (() => {
        const out = {}
        for (const f of ['scale', 'origin', 'color', 'alpha', 'brightness', 'angles', 'visible', 'volume', 'maxwidth', 'zoom']) {
          const v = o[f]
          if (v && typeof v === 'object' && v.animation && typeof v.animation === 'object' && v.animation.options) {
            out[f] = { animation: v.animation, value: v.value }
          }
        }
        return Object.keys(out).length ? out : null
      })(),
      animationLayers: (o.animationlayers || [])
        .filter((a) => a && typeof a.animation === 'number')
        .map((a) => ({
          animation: a.animation,
          visible: parseBool(a.visible, true),
          additive: parseBool(a.additive, false),
          blend: parseNum(a.blend, 1),
          rate: parseNum(a.rate, 1),
        })),
      // WE 的 solid 层：无 image/particle，或 image 指向内置 models/util/*（纯色层，无纹理）
      //
      // [we-scene patch] **composelayer 必须排除在外。** 它不是纯色层而是一块
      // 「效果画布」—— 层内容本该是**空白（全 0）**，让效果链自己往上画。
      // 而 solid 在渲染器里意味着「层内容 = whiteTex」（不透明纯白）。
      // 编辑器给 17 个 composelayer 也写了 `solid: true`（作者从 solidlayer 改过来
      // 时留下的残留），其中 12 个是「空容器 + 效果」，全部会被喂进一张纯白底：
      //   2872267921「音频」的 test_shader 写 ApplyBlending(31, albedo.rgb, color, 1.0)
      //   = albedo + color，albedo 是纯白 ⇒ 输出恒为 1，整块 2000×2000 quad 全白，
      //   且 alpha 直通 albedo.a = 1 ⇒ 不透明地盖住整个画面。
      //
      // [we-scene patch] **solidlayer 不看 `solid` 旗标。** 编辑器给 image=
      // `models/util/solidlayer.json` 时经常不写 `solid: true`（全库约 300 层 /
      // 仅约 40 层带旗标）。渲染器无贴图且 solid=false 会喂 transparentTex，
      // 2983846453 的「底部」白天蓝底 alpha=1 也变成全黑。旗标缺失 ≠ 不是纯色层。
      solid: (() => {
        if (typeof o.particle === 'string') return false
        const img = typeof o.image === 'string' ? o.image : ''
        if (img.indexOf('models/util/composelayer') === 0) return false
        if (img.indexOf('models/util/solidlayer') === 0) return true
        if (!o.solid) return false
        return !img || img.indexOf('models/util/') === 0
      })(),
      // composelayer 是分组容器（子层已合并为世界坐标），容器自身不渲染。
      // hasChildren 供渲染器区分「真分组」与「空容器 + 效果画布」（后者要渲染，
      // 见 renderScene）。带子层的容器若挂了效果，渲染器会把子层先画进组 FBO
      // 再对整组跑效果链（组渲染目标，见 renderContainerGroup）。
      isContainer: typeof o.image === 'string' && o.image.indexOf('models/util/composelayer') === 0,
      hasChildren: (childCounts.get(o.id !== undefined ? o.id : i) || 0) > 0,
      // [we-scene patch] 直接子层 id 列表。组渲染目标需要按容器把子层聚起来：
      // 3264246690 的三条 DANGER 胶带是「容器挂 scroll + 子层出图」的结构，
      // 只看 hasChildren 跳过容器，scroll/tint 就整组失效（胶带静止不动）。
      childIds: (childIdsById.get(o.id !== undefined ? o.id : i) || null),
      parentId: o.parent !== undefined && o.parent !== null ? o.parent : null,
      // [we-scene patch] puppet 附着点名。WE 语义：`attachment: "头"` + `parent: <puppet id>`
      // = 该层 origin 相对 MDAT 附着点，并跟随那根骨（见 mdl-skin.js applyAttachmentBindOrigins）。
      // 名字必须原样留下：全库有 "左头发1"/"左头发2" 这种只差末位数字的，前缀匹配会挂错骨。
      // 解析阶段还没有 MDL，这里只保留字段；绑定姿势偏移在 puppet 装好之后再加。
      attachment: typeof o.attachment === 'string' && o.attachment !== '' ? o.attachment : null,
      // [we-scene patch] `config.passthrough` —— WE 声明「本层的效果链输入 = 它**背后
      // 已渲染的画面**」，而不是一块空白画布。全库 120 处，**全部**是容器，
      // 其中 119 个是「空容器 + 效果」。
      //
      // 不实现时空容器基底是 scene=(0,0,0,0)，而工坊音频可视化普遍写
      //   finalColor = ApplyBlending(MODE, lerp(barColor, scene.rgb, scene.a), barColor, bar*op)
      // scene.a=0 让那个 lerp 原样返回 barColor，两个混合参数相同 ⇒ **rgb 与 bar 无关**，
      // 形状只能落在 alpha 上。TRANSPARENCY=REPLACE 的还有 alpha 兜底，
      // 而 PRESERVE（alpha = scene.a = 0）连 alpha 都没有 —— 整块 quad 变成恒定纯色。
      // 3789131791 的「Green」就是这样糊出一块 1920×1080 的青色矩形（Bar Color
      // 恰是 0.31/0.94/0.94）。给它真实背景后 scene.a=1，bar=0 处输出精确等于原背景。
      passthrough: !!(o.config && o.config.passthrough === true),
      // [we-scene patch] projectlayer / fullscreenlayer 是 WE 的**全屏后期处理层**：
      // 层内容 = 当前已渲染的画面（copybackground），套效果后再合成回画布。
      // 回读已由 drawBackdropToFBO 实现；再整层跳过会让 973101892 的
      // waterripple/pulse/godrays 完全不跑，星云是静图。空画布 + compositecolor
      // 铺白（3113287126）是「当普通空层画」的后果，不是该继续跳过的理由。
      isPostProcess: isPost,
      origin: layerOrigin,
      scale: world.scale,
      angles: world.angles,
      // [we-scene patch] 父级相对变换（WE 场景图的真实语义）。origin/scale/angles
      // 上的脚本与关键帧动画一律在这层空间收发，再由 recomposeWorld 合成回上面的
      // world 三件套。渲染 / hittest / getTransformMatrix 仍只读 world，不受影响。
      // isPostProcess 层的 world 被强制成整幅画布，local 对它无意义（recompose 跳过）。
      localOrigin: localSnapshot[i].origin,
      localScale: localSnapshot[i].scale,
      localAngles: localSnapshot[i].angles,
      // 「渲染惰性纯容器」：父 scale 是否传给子层由父级这个标志决定，
      // 判据与 parse 合并阶段逐字相同（见 isRenderInert）。
      renderInert: isRenderInert(o),
      // 父 scale 绑了脚本/用户属性（运行时可变）。与 renderInert 一起决定传播闸门。
      scaleRuntimeBound: !!(
        o.scale !== null &&
        typeof o.scale === 'object' &&
        (typeof o.scale.script === 'string' || o.scale.user !== undefined)
      ),
      size: layerSize,
      alignment: o.alignment || 'center',
      color: parseColor(o.color),
      alpha: parseNum(o.alpha, 1),
      brightness: parseNum(o.brightness, 1),
      copybackground: !!o.copybackground,
      colorBlendMode: o.colorBlendMode || 0,
      // 视差深度（vec2：x/y 方向分量；近景正值位移大、远景负值反向）
      parallaxDepth: o.parallaxDepth !== undefined ? parseVec2(o.parallaxDepth) : null,
      effects: (o.effects || []).map((e) => ({
        file: e.file || '',
        // [we-scene patch] 效果名要留着：对象脚本按名字取效果开关外观
        // （thisScene.getLayer('腿1').getEffect('白丝').visible = false，
        //  见 text.js 的 makeEffectHandle）。丢掉 name 就只能按索引取，
        //  而语料里 9 处调用有 8 处按名字。
        name: typeof e.name === 'string' ? e.name : '',
        visible: parseBool(e.visible, true),
        // [we-scene patch] 效果开关上的脚本要留原文。`parseBool` 只取 `.value`
        // 快照，`script` 字段被丢掉 —— 全库 46 处 `effect.visible` 脚本（媒体回调
        // 的第二大挂载点）因此**根本不会被加载**，回调实现得再全也一处不派发。
        // 这与 objectScripts 白名单曾漏掉 `visible` 是同一类错误（见上方注释）。
        visibleScript: e.visible && typeof e.visible === 'object' && typeof e.visible.script === 'string' && e.visible.script
          ? { script: e.visible.script, scriptproperties: e.visible.scriptproperties || null, value: !!e.visible.value }
          : null,
        passes: (e.passes || []).map((p) => ({
          combos: p.combos || {},
          constantshadervalues: p.constantshadervalues || {},
          textures: p.textures || [],
        })),
      })),
    }
  })
  const general = sceneJson.general || {}
  // general 字段上的脚本（全库 3 处）：zoom / bloomstrength / cameraparallax。
  // 不在这里留下来，宿主就加载不到 —— 3151551777 的火车震动、3790527023
  // 的场景切换、2134765860 的 bloom 跟音频都绑在这上面，不是图层字段。
  const generalScripts = (() => {
    const out = {}
    for (const [k, v] of Object.entries(general)) {
      if (v && typeof v === 'object' && typeof v.script === 'string' && v.script) {
        out[k] = { script: v.script, scriptproperties: v.scriptproperties || null, value: v.value }
      }
    }
    return Object.keys(out).length ? out : null
  })()
  // general 字段上的关键帧（全库 2 处）：2887099508 zoom 3→1 开场拉远、
  // 3793152178 bloomstrength 循环。只抽 script 的话 zoom 永远停在快照 3，
  // 6080×3420 场景只看见中间 1/3，看起来像「只显示左上角一块」。
  const generalAnimations = (() => {
    const out = {}
    for (const [k, v] of Object.entries(general)) {
      if (v && typeof v === 'object' && v.animation && typeof v.animation === 'object' && v.animation.options) {
        out[k] = { animation: v.animation, value: v.value }
      }
    }
    return Object.keys(out).length ? out : null
  })()

  // 空组（无 image/particle/model）上的 parallaxDepth 不会自己画出来。
  // 子层没写视差时要继承，否则分组节点的深度等于没写：3233141951 的 576
  // 只挂了 origin + parallax 1.4，面具01（肩饰）/挂饰自己没有 parallaxDepth，
  // 人物头 1.3、发饰 1.4 会动，肩饰钉在世界坐标上，看起来像没绑在身上。
  // 作者 origin 就在胸口，不要拿 cropoffset 去「对齐头」。
  {
    const byId = new Map()
    for (const L of layers) if (L.id !== undefined) byId.set(L.id, L)
    for (let pass = 0; pass < 8; pass++) {
      let changed = false
      for (const L of layers) {
        if (L.parallaxDepth || L.parentId == null) continue
        const p = byId.get(L.parentId)
        if (!p || !p.parallaxDepth) continue
        if (p.image || p.particle || p.model) continue
        L.parallaxDepth = p.parallaxDepth.slice()
        changed = true
      }
      if (!changed) break
    }
  }

  return {
    camera: sceneJson.camera || null,
    general,
    generalScripts,
    generalAnimations,
    layers,
    properties,
  }
}

/**
 * 按 visibleSelf + 父链重算每层的有效 visible。
 *
 * 脚本写 `thisLayer.visible = true` 时必须先改 visibleSelf，再调本函数：
 * 否则子层仍停在 parse 期「父隐藏 → 子孙 visible=false」的快照上。
 * 3122339805 的 Eyes/Numbers 窗口绑 hide*=false，脚本翻成显示后若只改父层
 * `.visible`，画面上只剩 30px 粉条标题栏，内容/边框全无。
 */
export function recomputeLayerVisibility(layers) {
  if (!Array.isArray(layers)) return
  const byId = new Map()
  for (const l of layers) {
    if (l && l.id !== undefined && l.id !== null) byId.set(l.id, l)
  }
  for (const l of layers) {
    if (!l) continue
    if (l.destroyed) {
      l.visible = false
      continue
    }
    let vis = l.visibleSelf !== false
    let p = l.parentId
    for (let g = 0; vis && p != null && g < 64; g++) {
      const parent = byId.get(p)
      if (!parent) break
      if (parent.visibleSelf === false || parent.destroyed) vis = false
      p = parent.parentId
    }
    l.visible = vis
  }
}

// [we-scene patch] 编辑器「实例化」的纯色层：模型 JSON 自带 `solidlayer: true`，
// 但 image 是 `models/solid_instance_model_<hash>.json`，场景对象也不写 `solid` 旗标。
// parseScene 只看 image=util/solidlayer / o.solid，这类层会 solid=false。
// 材质路径还是 `materials/util/solidlayer_instance*.json`，pkg 里没有（全库 78 层
// 全缺），装配循环 `if (!matEntry) continue` 连效果都不解析。
// 渲染器无贴图且 solid=false → transparentTex → 全透明，clearcolor 露出来。
// 3444535389 默认 bgcolor=黑，clearcolor=0.7 灰，全屏「纯色占位符」就是这么丢的。
export function applySolidFromModel(layer, modelJson) {
  if (!layer || !modelJson || typeof modelJson !== 'object') return
  if (layer.isContainer) return
  if (modelJson.solidlayer === true) layer.solid = true
}

// 从对象模型解析材质链：object.image → models/x.json → materials/y.json → passes
export function resolveMaterial(modelJson) {
  if (!modelJson || typeof modelJson.material !== 'string') return null
  return {
    materialPath: modelJson.material,
    autosize: !!modelJson.autosize,
    cropoffset: modelJson.cropoffset ? parseVec2(modelJson.cropoffset) : null,
  }
}

/**
 * [we-scene patch] 运行时父子变换重算（WE 场景图语义）。
 *
 * parse 阶段把父变换烘进子层得到 world，这在**静态**场景上是等价的；一旦
 * origin/scale/angles 绑了脚本或关键帧动画就不成立了：
 *   ① 作者写的目标是 local（3786330502 的 12 个气泡 `scriptProperties.A` 就是
 *      local y，气泡1 的 −433 当 world Y 讲不通；全库 68 个 local≠world 的非根
 *      脚本 origin 层里 30 个匹配 local、**0 个**匹配 world）；
 *   ② 父组自己动时，子层的 world 早已拍平，动了也没人跟。3786330502 的
 *      550/1061/1027 三个无贴图容器共 50 个后代的位移全被丢弃。
 *
 * 做法：脚本/动画在 local 三件套上收发，这里自顶向下把 local 合成回 world，
 * 渲染 / hittest / getTransformMatrix 继续只读 world。
 *
 * **只重算 dirty 集合**（挂载期算出「变换绑了脚本/动画的层」及其整棵子树）。
 * 其余图层保持 parse 时的 world，一个字节都不碰 —— 全库 187 张里 126 张不含
 * 任何脚本化变换，从机制上不可能回归。dirty 为 null 时重算全部（供 verifier
 * 做「静态场景上 recompose 必须与 parse 逐位相等」的一致性断言）。
 *
 * 挂件（attachment）：绑定姿势偏移由 mdl-skin 存成 `attachBindDelta` 留在图层上，
 * 这里合成完 world 之后再加回去。否则重算会把它抹掉，人物一动五官就留在原地。
 *
 * @param {object[]} layers parseScene 产出的图层数组（就地改写 origin/scale/angles）
 * @param {Set<any>|null} dirty 需要重算的 layer.id 集合；null = 全部
 */
export function recomposeWorld(layers, dirty) {
  if (!layers || layers.length === 0) return
  const byId = new Map()
  for (const l of layers) {
    if (l && l.id !== undefined && l.id !== null) byId.set(l.id, l)
  }
  // 自顶向下：父必须先于子算完。按父链深度排序即可（层级最深 3～4 层）。
  const depthOf = (l) => {
    let d = 0
    let p = l.parentId
    for (let guard = 0; p !== undefined && p !== null && guard < 64; guard++) {
      const parent = byId.get(p)
      if (!parent) break
      d++
      p = parent.parentId
    }
    return d
  }
  const targets = []
  for (const l of layers) {
    if (!l || !l.localOrigin) continue
    // isPostProcess 的 world 被强制成整幅画布（见上方 isPost 分支），local 对它无意义。
    if (l.isPostProcess) continue
    if (dirty && !dirty.has(l.id)) continue
    targets.push(l)
  }
  targets.sort((a, b) => depthOf(a) - depthOf(b))
  for (const l of targets) {
    const parent = l.parentId !== undefined && l.parentId !== null ? byId.get(l.parentId) : null
    let w
    if (!parent) {
      w = { origin: l.localOrigin.slice(), scale: l.localScale.slice(), angles: l.localAngles.slice() }
    } else {
      // 传播闸门与 parse 合并阶段逐字相同：父是「渲染惰性纯容器」且其 scale
      // 绑了脚本/用户属性时，scale 不传给子层。
      const propagateScale = !(parent.scaleRuntimeBound && parent.renderInert)
      w = composeChildTransform(
        { origin: parent.origin, scale: parent.scale, angles: parent.angles },
        { origin: l.localOrigin, scale: l.localScale, angles: l.localAngles },
        propagateScale,
      )
    }
    // 挂件绑定姿势偏移：world 合成之后再叠，逐帧的骨骼增量由 followAttachments 叠。
    const d = l.attachBindDelta
    if (d) {
      w.origin[0] += d[0]
      w.origin[1] += d[1]
    }
    l.origin[0] = w.origin[0]
    l.origin[1] = w.origin[1]
    l.origin[2] = w.origin[2]
    l.scale[0] = w.scale[0]
    l.scale[1] = w.scale[1]
    l.scale[2] = w.scale[2]
    l.angles[0] = w.angles[0]
    l.angles[1] = w.angles[1]
    l.angles[2] = w.angles[2]
    // 挂件子树的**绑定姿势基准**：followAttachments 每帧从它重写再叠骨骼增量。
    // 必须由本函数发布（follow 自己读 layer.origin 当基准会把上一帧的增量
    // 累加进来，连调两次结果就不同了）。只有进入过 follow 子树的层才有这个标记。
    if (l.attachBase) {
      l.attachBase[0] = w.origin[0]
      l.attachBase[1] = w.origin[1]
    }
  }
}

/**
 * [we-scene patch] 算出需要逐帧重算的图层集合（dirty 子树）。
 *
 * 种子 = 变换字段（origin/scale/angles）上绑了脚本或关键帧动画的层，
 * 外加调用方补充的种子（如 mdl 挂件层：骨骼一动整棵子树都要跟）。
 * 然后沿 childIds 把整棵子树收进来 —— 父动子必须跟，这正是缺陷 B。
 */
export function collectTransformDirty(layers, extraSeeds) {
  const dirty = new Set()
  if (!layers || layers.length === 0) return dirty
  const childrenOf = new Map()
  for (const l of layers) {
    if (!l || l.parentId === undefined || l.parentId === null) continue
    const list = childrenOf.get(l.parentId)
    if (list) list.push(l)
    else childrenOf.set(l.parentId, [l])
  }
  const TRANSFORM_FIELDS = ['origin', 'scale', 'angles']
  const seeds = []
  for (const l of layers) {
    if (!l || l.id === undefined || l.id === null) continue
    const scripts = l.objectScripts || null
    const anims = l.objectAnimations || null
    const bound = TRANSFORM_FIELDS.some((f) => (scripts && scripts[f]) || (anims && anims[f]))
    if (bound) seeds.push(l)
  }
  if (extraSeeds) {
    for (const l of extraSeeds) if (l && l.id !== undefined && l.id !== null) seeds.push(l)
  }
  const stack = seeds.slice()
  for (let guard = 0; stack.length > 0 && guard < 100000; guard++) {
    const l = stack.pop()
    if (!l || l.id === undefined || l.id === null) continue
    if (dirty.has(l.id)) continue
    dirty.add(l.id)
    const kids = childrenOf.get(l.id)
    if (kids) for (const c of kids) stack.push(c)
  }
  return dirty
}
