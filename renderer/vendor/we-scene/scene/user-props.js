// 用户属性解引用（{user: 属性名, value: 存场景时的快照} → 现值）
//
// [we-scene patch] 从 parse.js 拆出的独立子库（纯函数、零依赖）。
// 语义与坑的完整说明见各函数注释与 docs/CASEBOOK.md「属性解引用」：
// 属性表优先、形状不匹配（撞车）退回快照。
function propEntry(properties, name) {
  if (!properties || typeof name !== 'string') return null
  const p = properties[name]
  return p && typeof p === 'object' ? p : null
}

// user 两种写法：
//   "clock"                              字段值 = 属性现值
//   { name: "game", condition: "3" }     字段值 = (属性现值 == condition)
// 后一种是 combo 切图层：2388299037 的 TV Screen 12 层、全库 44 张 / 930 处。
// 旧实现只认字符串，条件绑定整段被当成普通对象，parseBool 吃快照，切 combo 没反应。
function userBindName(user) {
  if (typeof user === 'string') return user
  if (user && typeof user === 'object' && typeof user.name === 'string') return user.name
  return null
}

function valuesEqual(a, b) {
  if (isIntLike(a) && isIntLike(b)) return Number(a) === Number(b)
  return String(a) === String(b)
}

// [we-scene patch] 快照只是「上次存场景时的值」，不是运行时该用的值。
//
// 上面那条「默认沿用快照」的规则把 2854083091 的 X-Ray 开窗做小了 5 倍：
// 它的 size 绑在 xraysize 上，快照 0.2、属性表默认 1，而 shader 里
// v_PointerScale = 1/g_PointerScale —— 0.2 直接把 halo 缩成 1/5。
// 用户看到的就是「开窗默认值有点小」。
//
// 判据不是猜的。origin/scale/angles 带 script 时，字段自身的 `value` 是 WE
// **跑完脚本后烘焙下来的结果**，脚本形如 `value.x = scriptProperties.x`，
// 于是这个烘焙值直接暴露了 WE 当时把 {user,value} 解成了哪一侧。全库统计：
//   烘焙值 == 属性表 38 处，== 快照 11 处。
// 那 11 处全部来自同一张 3509243656，且都是 baked==snap≠prop —— 即「存完
// 场景之后又调了属性」，烘焙值本就是旧的，区分不了两种假说。反过来 38 处
// baked==prop≠snap 无法用「读快照」解释：若 WE 读快照，烘焙值必然等于快照。
// 所以 WE 运行时读的是属性表。
//
// 本仓另外两条路径其实早就这么做了：engine.userProperties（main.ts）和
// scriptProperties（text.js:919）都无条件读属性表当前值 —— 只有这里还在等
// userOverridden 标记，三者语义不一致。
//
// 仍然不能无条件替换：全库 381 处快照≠属性里有 44 处是**字段名与属性名撞车**
// （3078285611 把 visible 绑到一个 color 属性、3521337568 把 x 绑到 bool、
// 3292361861 把 parallaxDepth(vec2) 绑到 bool…）。替进去会得到类型错乱的值。
// 所以按「形状」把关：数值↔数值（标量与向量按分量广播，WE 自己也这么用，
// 如 scale 绑单个 slider）放行，bool/文本必须严格同形，其余一律退回快照。
// 经此过滤，337 处生效、44 处撞车的保持原样。
//
// userOverridden 仍然优先：宿主明示用户改过时，连撞车检查一起跳过。

/** 值的「形状」，用于判断属性表的值能否安全替换快照 */
function valueShape(v) {
  if (typeof v === 'boolean') return 'bool'
  if (typeof v === 'number') return Number.isFinite(v) ? 'num' : 'other'
  if (typeof v === 'string') {
    const parts = v.trim().split(/\s+/)
    if (parts.length > 0 && parts[0] !== '' && parts.every((x) => Number.isFinite(Number(x)))) return 'num'
    return 'text'
  }
  return 'other'
}

/** 属性表条目的形状按声明类型判定（value 可能是数字也可能是字符串） */
function propShape(p) {
  switch (p.type) {
    case 'bool': return 'bool'
    case 'slider': return 'num'
    case 'color': return 'num'
    case 'textinput': return 'text'
    default: return valueShape(p.value)
  }
}

/** 取字段生效值：优先属性表（WE 运行时语义），类型撞车时退回场景快照 */
function resolveUserValue(v, properties) {
  if (v === null || typeof v !== 'object') return v
  // combo 等值绑定：visible 当且仅当属性现值 == user.condition。
  // 快照只是存盘时的结果；缺属性时才退回快照。
  if (v.user && typeof v.user === 'object' && typeof v.user.name === 'string') {
    const p = propEntry(properties, v.user.name)
    if (!p || p.value === undefined || p.value === null) return v.value
    const cur = p.type === 'combo' ? coerceComboValue(p.value, p.options) : p.value
    return valuesEqual(cur, v.user.condition)
  }
  if (typeof v.user !== 'string') return v
  const p = propEntry(properties, v.user)
  if (!p || p.value === undefined || p.value === null) return v.value
  // 宿主明示用户改过：直接采用，不做形状检查
  if (p.userOverridden) return p.value
  // 快照本身还是包装对象（嵌套引用）时无从比较形状，交给外层继续展开
  if (v.value !== null && typeof v.value === 'object') return v.value
  if (v.value === undefined) return p.value
  // slider 绑 bool：WE 用 0/非 0 当开关。形状检查会判撞车退回快照，
  // 3233141951 朱鹤 animationlayers.visible 绑 brwyvernanimationonoff，
  // slider=0 时龙 rate 冻住、朱鹤 clip 仍在播。
  // 只放行声明为 slider 的项。不能对所有 num 放行：3078285611 的 visible
  // 绑的是 color，propShape 也是 num。
  if (valueShape(v.value) === 'bool' && p.type === 'slider') {
    const n = Number(p.value)
    return Number.isFinite(n) ? n !== 0 : v.value
  }
  return valueShape(v.value) === propShape(p) ? p.value : v.value
}

// 递归把对象树里的 {user, value} 包装解成生效值。就地改写 `value` 字段而非拆掉包装，
// 使所有下游读取方（parseVec3 / parseColor / 渲染器的 setConstant 等，都走 `.value`）
// 无需改动。嵌套包装（真实数据里存在 value 本身又是 {user,value} 的情形）一并展开。
function resolveUserProps(node, properties, depth) {
  if (depth > 32 || node === null || typeof node !== 'object') return node
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) node[i] = resolveUserProps(node[i], properties, depth + 1)
    return node
  }
  if (userBindName(node.user)) {
    let v = resolveUserValue(node, properties)
    // 解出的值可能仍是包装对象：继续展开，直到拿到标量/普通对象
    for (let guard = 0; guard < 8 && v !== null && typeof v === 'object' && userBindName(v.user); guard++) {
      v = resolveUserValue(v, properties)
    }
    node.value = resolveUserProps(v, properties, depth + 1)
    return node
  }
  for (const k of Object.keys(node)) node[k] = resolveUserProps(node[k], properties, depth + 1)
  return node
}

// [we-scene patch] parseVec3/parseVec2 支持 {user, value} 用户属性包装对象（与 parseColor 一致）

// WE 运行时：选项全是整数（或整数字符串）的 combo，engine.userProperties 里是 number。
// project.json 却经常把 21 存成 "21"。switch(case 21) / === 21 对字符串全部失配——
// 3396722575 的 21 档字体切换就是这样：applyUserProperties 里 switch(text1) 写的是
// `case 21:`，值停在 "21" 时 thisLayer.font 永远不会被赋路径。
function comboOptionValues(options) {
  if (!options) return []
  if (Array.isArray(options)) {
    return options.map((o) => (o && typeof o === 'object' && 'value' in o ? o.value : o))
  }
  if (typeof options === 'object') return Object.values(options)
  return []
}

function isIntLike(v) {
  if (typeof v === 'number') return Number.isInteger(v)
  return typeof v === 'string' && /^-?\d+$/.test(v.trim())
}

function coerceComboValue(value, options) {
  const opts = comboOptionValues(options)
  const numeric = opts.length > 0 ? opts.every(isIntLike) : isIntLike(value)
  if (!numeric) return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value)
  return value
}

/** 属性表 → 脚本可见的 engine.userProperties（combo 整数字符串收成 number）
 *  @param {Record<string, any>} [properties]
 *  @returns {Record<string, unknown>}
 */
function flattenUserProperties(properties) {
  /** @type {Record<string, unknown>} */
  const out = {}
  if (!properties || typeof properties !== 'object') return out
  for (const [k, v] of Object.entries(properties)) {
    if (!v || typeof v !== 'object' || !('value' in v)) continue
    out[k] = v.type === 'combo' ? coerceComboValue(v.value, v.options) : v.value
  }
  return out
}

function boundUserName(v) {
  return v && typeof v === 'object' ? userBindName(v.user) : null
}

/**
 * 把宿主 wire `{name: {value}}` 就地写进属性表和脚本可见的 live 对象。
 * 返回本次变更的扁平 name→value（combo 已收成 number），供 applyUserProperties(changed)。
 */
function mergeUserPropertyValues(properties, live, wire) {
  /** @type {Record<string, unknown>} */
  const changed = {}
  if (!wire || typeof wire !== 'object') return changed
  const props = properties && typeof properties === 'object' ? properties : {}
  const dst = live && typeof live === 'object' ? live : {}
  for (const [k, entry] of Object.entries(wire)) {
    const raw = entry && typeof entry === 'object' && 'value' in entry ? entry.value : entry
    const p = props[k]
    if (p && typeof p === 'object') {
      p.value = raw
      p.userOverridden = true
      const v = p.type === 'combo' ? coerceComboValue(p.value, p.options) : p.value
      dst[k] = v
      changed[k] = v
    } else {
      dst[k] = raw
      changed[k] = raw
    }
  }
  return changed
}

export {
  resolveUserProps,
  resolveUserValue,
  propShape,
  valueShape,
  coerceComboValue,
  flattenUserProperties,
  mergeUserPropertyValues,
  boundUserName,
}
