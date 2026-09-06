// WE shader（HLSL 方言）→ GLSL ES 3.0 转译器
// 覆盖 WE 效果 shader 的实际语法面：预处理（#include/#define/#if combo）+ 方言转换。
// 依据：linux-wallpaperengine 的 GLSLContext 思路 + 本仓库提取的全部效果 shader 实测语法。
// mul 语义：HLSL 行向量约定 → GLSL 列向量约定（transpose 处理）；效果 pass 的 MVP=单位矩阵时二者等价。

// [we-scene patch] 模块结构（本仓库拆分，见 docs/ARCHITECTURE.md）：
//   hlsl-preprocessor.js  C 预处理器（#include/#define/函数宏/#if）
//   hlsl2glsl.js          本文件：HLSL→GLSL ES 3.0 方言语法转换 + 转译主入口
// `preprocess` 仍从本文件 re-export，既有 import 方（main.ts / verify-*.mjs）不变。
import { preprocess, stripComments, expandMacrosIn, replaceWord, splitArgs } from './hlsl-preprocessor.js'
// ---------- 方言语法转换 ----------

// 平衡括号内内容（返回右括号位置）
function matchGroup(text, openIdx, openCh, closeCh) {
  let depth = 0
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === openCh) depth++
    else if (text[i] === closeCh) {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}
function matchParen(text, openIdx) {
  return matchGroup(text, openIdx, '(', ')')
}

// 替换 callName(args) 形式（嵌套安全；callName 前必须是词边界，避免误匹配 Desaturate→saturate 之类）
// [we-scene patch] 跳过**函数声明/定义**：公共头（headers.ts）里就有
//   `float saturate(float x) { return clamp(x, 0.0, 1.0); }`
// 这类定义，若把声明处的形参表也当调用改写，会生成
//   `float clamp(float x, 0.0, 1.0) { ... }`
// 这种非法 GLSL，导致整个 shader 编译失败、效果被整体跳过
// （表现：shake/waterwaves/foliagesway 全部失效，如人物不眨眼）。
const GLSL_TYPES = new Set([
  'void', 'bool', 'int', 'uint', 'float', 'double',
  'vec2', 'vec3', 'vec4', 'bvec2', 'bvec3', 'bvec4',
  'ivec2', 'ivec3', 'ivec4', 'uvec2', 'uvec3', 'uvec4',
  'mat2', 'mat3', 'mat4', 'mat2x2', 'mat2x3', 'mat2x4',
  'mat3x2', 'mat3x3', 'mat3x4', 'mat4x2', 'mat4x3', 'mat4x4',
])

// name 紧前面是否为「类型名 + 空白」→ 说明这是函数声明而非调用
function isDeclaration(text, idx) {
  let p = idx - 1
  while (p >= 0 && /[ \t]/.test(text[p])) p--
  if (p < 0 || p === idx - 1) return false // 必须有空白分隔
  let e = p + 1
  while (p >= 0 && /[A-Za-z0-9_]/.test(text[p])) p--
  const word = text.slice(p + 1, e)
  return GLSL_TYPES.has(word)
}

/**
 * [we-scene patch] 收集本文件里可确证为 int 的标识符名。
 * 10b-2 / 10b-3 两段共用 —— 各写一份必然漂移（一处认得某种声明形态、另一处不认，
 * 就会出现「声明改对了、运算没改」的半修状态，仍旧整 pass 编译失败）。
 *
 * 尾随 `[=;)]` 同时覆盖三种形态：`int n = 4;`、`int n;`、`for (int i = 0; …)`
 * —— 循环变量走的是 `=` 那一支，不需要单独的 for 正则。
 *
 * 必须在 10b（`int x = step(...)` → `float x = ...`）**之后**调用，否则会把
 * 已被改成 float 的变量当成 int（2134765860 的 bar 会被多包一层 float()）。
 */
function collectIntNames(code) {
  const names = new Set()
  let m
  const declRe = /\b(?:const\s+)?int\s+([A-Za-z_]\w*)\s*[=;)]/g
  while ((m = declRe.exec(code)) !== null) names.add(m[1])
  return names
}

function rewriteCall(text, callName, fn) {
  let out = ''
  let i = 0
  while (i < text.length) {
    const idx = text.indexOf(callName, i)
    if (idx === -1) {
      out += text.slice(i)
      break
    }
    // 词边界：前一个字符不能是标识符字符
    if (idx > 0 && /[A-Za-z0-9_]/.test(text[idx - 1])) {
      out += text.slice(i, idx + 1)
      i = idx + 1
      continue
    }
    // 后一个字符也不能是标识符字符（避免 saturateFoo 被当作 saturate）
    const after = idx + callName.length
    if (after < text.length && /[A-Za-z0-9_]/.test(text[after])) {
      out += text.slice(i, after)
      i = after
      continue
    }
    // 函数声明/定义：原样保留，不改写形参表
    if (isDeclaration(text, idx)) {
      out += text.slice(i, after)
      i = after
      continue
    }
    out += text.slice(i, idx)
    let q = idx + callName.length
    while (q < text.length && /\s/.test(text[q])) q++
    if (text[q] !== '(') {
      out += text.slice(idx, q)
      i = q
      continue
    }
    const end = matchParen(text, q)
    if (end === -1) {
      out += text.slice(idx)
      break
    }
    const inner = text.slice(q + 1, end)
    out += fn(inner, idx)
    i = end + 1
  }
  return out
}

export { preprocess }

export function hlsl2glsl(src, stage, combos, includeResolver, siblingSrc) {
  // [we-scene patch] 先去注释再做任何事：被注释掉的 #define 会被 collectMacros
  // 当成真宏收走（见 stripComments 注释里的 HASHSCALE1 案例）。
  // 注意 [COMBO] 声明本身写在注释里，所以 combo 默认值必须在**去注释前**从原始源码提取。
  const rawSrc = src
  src = stripComments(src)
  // combo 默认值：WE 语义 = 未显式提供时用声明里的 default（无声明 → 0）
  // （依据 linux-wallpaperengine ShaderUnit.cpp:442-477 parseComboConfiguration）
  //
  // [we-scene patch] **必须把 vert 与 frag 的 combo 声明并起来看**。
  // WE 常只在一个 stage 里声明 [COMBO]，另一个 stage 直接 #if 它：
  // 例如 godrays_gaussian / shine_gaussian 的 KERNEL 只声明在 .vert
  //（default 1），.frag 只有 `#if KERNEL == 0/1/2`。
  // 各自独立取默认值时，.frag 找不到声明 → 落 0 → 声明 varying vec2 v_TexCoord[13]，
  // 而 .vert 按 default 1 声明 [7]，链接直接报
  // `Array sizes of varying 'v_TexCoord' differ between VERTEX and FRAGMENT shaders`
  //（实测 godrays_gaussian 24 个 pass / shine_gaussian 12 个 pass 全灭）。
  // siblingSrc 由调用方传入配对 stage 的原始源码。
  const defaults = {}
  const comboRe = /\[COMBO\][^\n]*?"combo"\s*:\s*"([^"]+)"[^\n]*?"default"\s*:\s*(-?\d+)/g
  let cm
  if (typeof siblingSrc === 'string' && siblingSrc) {
    const sibRe = new RegExp(comboRe.source, 'g')
    let sm
    while ((sm = sibRe.exec(siblingSrc)) !== null) defaults[sm[1]] = Number(sm[2])
  }
  while ((cm = comboRe.exec(rawSrc)) !== null) defaults[cm[1]] = Number(cm[2])
  // [we-scene patch] 平台标识宏。WE 按目标后端注入，我们的目标就是 GLSL。
  // 不注入的后果：evalIfExpr 把未知标识符解析成 '0'，于是 `#if GLSL` 恒假 ——
  // tone_mapping.frag 把 `float log10(float)` 的定义放在 `#if GLSL` 里，
  // 定义被整段剥掉，调用点却留着，log10 变成未定义符号（4 个壁纸的效果被跳过）。
  // 反过来 HLSL_SM30 必须保持未定义（恒假）：blur_combine.frag 用它守一个
  // 仅 D3D9 需要的半像素偏移，在 GLSL 下加上会让模糊整体偏移半个纹素。
  const effective = { GLSL: 1, ...defaults, ...(combos || {}) }
  let code = preprocess(src, effective, includeResolver, 0)  // 展开本文件保留的宏（#define 行仍在，GLSL 预处理器会展开；但函数宏在 GLSL ES 也支持，
  // 为稳妥起见用 JS 预展开，然后移除 #define 行）
  code = expandMacrosIn(code, 20)
  code = code.replace(/^[ \t]*#define[^\n]*\n?/gm, '')

  // 代码中作为标识符使用的 combo（如 ApplyBlending(BLENDMODE, ...)）替换为数值；未定义 combo 用声明 default，无声明 = 0
  // 从 [COMBO] 注释提取全部 combo 名（含未提供的）。
  // 必须扫 **rawSrc**：[COMBO] 声明写在 `// [COMBO] {...}` 注释里，
  // 而 code 已经去过注释了；扫 code 会一个都找不到，
  // 导致 BLENDMODE 等 combo 名残留成未定义标识符（整个 shader 编译失败）。
  // 同时把 include 进来的头里声明的 combo 也算上（头可能自带 [COMBO]）。
  {
    const comboNames = new Set()
    const comboRe2 = /\[COMBO\][^\n]*"combo"\s*:\s*"([^"]+)"/g
    let c2
    while ((c2 = comboRe2.exec(rawSrc)) !== null) comboNames.add(c2[1])
    // effective 里已有的键（material/scene 显式给的 combos）同样需要按标识符替换
    for (const k of Object.keys(effective)) comboNames.add(k)
    comboNames.delete('GLSL') // 平台宏由 #if 消费，不参与标识符替换
    for (const name of comboNames) {
      const v = effective[name] !== undefined ? effective[name] : 0
      code = replaceWord(code, name, String(v))
    }
  }

  // GLSL ES 3.0 保留字（WE 变量名与之冲突）
  code = replaceWord(code, 'sample', 'smp')

  // 数值后缀 f/h
  code = code.replace(/(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)[fh]\b/g, '$1')

  // 类型名
  code = code.replace(/\bfloat4x4\b/g, 'mat4')
    .replace(/\bfloat3x3\b/g, 'mat3')
    .replace(/\bfloat2x2\b/g, 'mat2')
    .replace(/\bfloat4\b/g, 'vec4')
    .replace(/\bfloat3\b/g, 'vec3')
    .replace(/\bfloat2\b/g, 'vec2')
    .replace(/\bhalf4\b/g, 'vec4')
    .replace(/\bhalf3\b/g, 'vec3')
    .replace(/\bhalf2\b/g, 'vec2')
    .replace(/\bhalf\b/g, 'float')

  // 纹理采样与饱和
  code = code.replace(/\btexSample2DLod\b/g, 'textureLod').replace(/\btexSample2D\b/g, 'texture')
  code = rewriteCall(code, 'saturate', (inner) => 'clamp(' + inner + ', 0.0, 1.0)')
  code = rewriteCall(code, 'CAST4', (inner) => 'vec4(' + inner + ')')
  code = rewriteCall(code, 'CAST3', (inner) => 'vec3(' + inner + ')')
  code = rewriteCall(code, 'CAST2', (inner) => 'vec2(' + inner + ')')

  // HLSL 标量广播：max(0, x.rgb) → max(vec3(0), x.rgb)（同样 min）
  code = code.replace(/\b(max|min)\(\s*(-?\d+(?:\.\d+)?)\s*,\s*([A-Za-z_]\w*\.(rgb|xyz|rg|xy|r|x))\s*\)/g, (all, fn, num, expr, sw) => {
    const dim = sw.length
    return fn + '(vec' + dim + '(' + num + '), ' + expr + ')'
  })

  // HLSL 隐式 int→float 转换：乘除两侧的整数字面量补 .0（WE 效果 shader 中此类仅出现在 float 上下文）
  // 左侧字面量需排除标识符尾部数字（如 diffx1 * diffy2 不得改写成 diffx1.0）
  code = code.replace(/(^|[^\w.])(\d+)\s*([*/])\s*([A-Za-z_][A-Za-z0-9_]*)/g, '$1$2.0 $3 $4')
  code = code.replace(/\b([A-Za-z_][A-Za-z0-9_]*)\s*([*/])\s*(\d+)(?![\d.])/g, '$1 $2 $3.0')
  // 字面量 × 字面量（如 3.14159 * 2）
  code = code.replace(/(\d+\.\d+)\s*([*/])\s*(\d+)(?![\d.])/g, '$1 $2 $3.0')
  code = code.replace(/(^|[^\w.])(\d+)\s*([*/])\s*(\d+\.\d+)/g, '$1$2.0 $3 $4')

  // + / - 的隐式 int→float（GLSL 无此隐式转换，WE HLSL 有）：
  // 仅当可证明浮点上下文时转换——左侧为浮点字面量（2.0 - 1）或 swizzle 表达式（x.xyz - 1），
  // 以及左侧整数字面量、右侧为浮点字面量或 swizzle 表达式（1 + 2.0 / 1 + x.xyz）。
  code = code.replace(/(\.\d+)\s*([+-])\s*(\d+)(?![\d.])/g, '$1 $2 $3.0')
  code = code.replace(/([A-Za-z_]\w*\.(?:xyzw|xyz|xy|zw|rgba|rgb|rg|x|y|z|w|r|g|b|a))\s*([+-])\s*(\d+)(?![\d.])/g, '$1 $2 $3.0')
  code = code.replace(/(^|[^\w.])(\d+)\s*([+-])\s*(\d+\.\d+)/g, '$1$2.0 $3 $4')
  code = code.replace(/(^|[^\w.])(\d+)\s*([+-])\s*([A-Za-z_]\w*\.(?:xyzw|xyz|xy|zw|rgba|rgb|rg|x|y|z|w|r|g|b|a))/g, '$1$2.0 $3 $4')
  // 整数字面量 ± 浮点类型变量（如 1 - g_Rough、1 + time）：
  // 收集声明为 float/vec/mat 的 uniform 与局部变量名，仅对这些名字补 .0（int 变量不受影响）
  {
    const floatNames = new Set()
    const declRe = /\b(?:uniform\s+)?(?:highp|mediump|lowp\s+)?(?:float|vec2|vec3|vec4|mat2|mat3|mat4)\s+([A-Za-z_][A-Za-z0-9_]*)/g
    let dm
    while ((dm = declRe.exec(code)) !== null) floatNames.add(dm[1])
    if (floatNames.size > 0) {
      const alt = Array.from(floatNames).sort((a, b) => b.length - a.length).join('|')
      code = code.replace(new RegExp('(^|[^\\w.])(\\d+)\\s*([+-])\\s*(' + alt + ')(?![A-Za-z0-9_])', 'g'), '$1$2.0 $3 $4')
    }
  }

  // GLSL 内置 float 函数的实参中不允许裸 int（无隐式转换）。
  // [we-scene patch] 从只处理 smoothstep 扩展到**全部纯 float 内建**：
  // 实测 `mix(blurred.a, 1, step(blurred.a, 0))`（blur_combine，12 壁纸）、
  // `max(x, 0)`、`pow(x, 2)` 等大量存在，报 `'step' : no matching overloaded
  // function found` / `'pow' : no matching overloaded function found`。
  // 用平衡括号取整个调用（含嵌套），再把其中的裸整数字面量补 .0。
  // 只列**实参必为浮点**的内建，故意排除：
  //   - texelFetch / textureLod 等含整型实参的纹理函数；
  //   - 数组下标场景（下标是 int，不能补 .0）—— 这里按调用名匹配，不会碰到下标。
  {
    const FLOAT_BUILTINS = [
      'smoothstep', 'step', 'mix', 'clamp', 'max', 'min', 'pow', 'mod',
      'atan', 'sqrt', 'inversesqrt', 'exp', 'log', 'exp2', 'log2',
      'abs', 'sign', 'floor', 'ceil', 'fract', 'length', 'distance', 'dot',
      'reflect', 'refract', 'faceforward', 'normalize', 'cross',
    ]
    // 已知第 1 参是**整型**（不能补 .0）的自定义函数：公共头里的混合模式分派。
    // 这些名字若出现在待改写实参里，其首参必须原样保留。
    const INT_FIRST_ARG = /\b(ApplyBlending|ApplyComposite|BlendTransparency)\s*\(/
    for (const fn of FLOAT_BUILTINS) {
      code = rewriteCall(code, fn, (inner) => {
        // 必须**逐个顶层实参**处理，不能对整个 inner 串做正则 —— inner 含嵌套调用时
        // 里面别人的整型实参也会被补 .0。实测踩到的是
        //   mix(base, vec4(ApplyBlending(BLENDMODE, ...), a), t)
        // 里的 `ApplyBlending(0, ...)` 被改成 `ApplyBlending(0.0, ...)`，
        // 而它首参是 **int**（混合模式编号）→ `no matching overloaded function found`。
        //
        // 但也不能「凡含括号就整段跳过」：`pow(x, 2)` 之类的兄弟实参会一起漏掉，
        // 且 `arr[i]`/`ivec2(1,2)` 里的整数本就不该动。
        // 折中：仅跳过**确实含整型首参函数**的实参，以及方括号下标；其余照常补 .0。
        const parts = splitArgs(inner)
        const fixed = parts.map((p) => {
          if (INT_FIRST_ARG.test(p)) return p
          // 保护数组下标 [i] / [2] 与整型构造 ivec*/int(...) 内的整数
          const holes = []
          let masked = p
            .replace(/\[[^\]]*\]/g, (m) => { holes.push(m); return '\u0000' + (holes.length - 1) + '\u0000' })
            .replace(/\b(?:ivec[234]|uvec[234]|int|uint)\s*\([^()]*\)/g, (m) => { holes.push(m); return '\u0000' + (holes.length - 1) + '\u0000' })
          masked = masked.replace(/(?<![A-Za-z0-9_.\u0000])(\d+)(?![.\d])(?![A-Za-z_])/g, '$1.0')
          return masked.replace(/\u0000(\d+)\u0000/g, (m, i) => holes[Number(i)])
        })
        return fn + '(' + fixed.join(',') + ')'
      })
    }

    // [we-scene patch] `pow(vec3, scalar)` → `pow(vec3, vec3(scalar))`。
    // HLSL 的 pow 对标量指数做广播，GLSL ES 要求两参同宽，报
    // `'pow' : no matching overloaded function found`（color_grading 等 7 个壁纸，
    // 典型写法 `albedo.rgb = pow(albedo.rgb, 2.2 / endGamma)`）。
    // 只处理能从 swizzle 直接读出宽度的基数（.rgb/.xyz/.rg/.xy 等），
    // 且指数不含 vec 构造/swizzle 时才广播 —— 宽度推不出来就不动。
    code = rewriteCall(code, 'pow', (inner) => {
      const args = splitArgs(inner)
      if (args.length !== 2) return 'pow(' + inner + ')'
      const base = args[0].trim()
      const exp = args[1].trim()
      const sw = /\.(xyzw|rgba|xyz|rgb|xy|rg|zw)\s*$/.exec(base)
      const W = { xyzw: 4, rgba: 4, xyz: 3, rgb: 3, xy: 2, rg: 2, zw: 2 }
      const w = sw ? W[sw[1]] : 0
      // 指数已是向量（含 vecN( 构造或 swizzle）时无需广播
      const expIsVec = /\bvec[234]\s*\(/.test(exp) || /\.(xyzw|rgba|xyz|rgb|xy|rg|zw)\b/.test(exp)
      if (w >= 2 && !expIsVec) return 'pow(' + base + ', vec' + w + '(' + exp + '))'
      return 'pow(' + base + ', ' + exp + ')'
    })
  }

  // [we-scene patch] 工坊音频效果语料的补充整数字面量场景（Simple_Audio_Bars v3210 变体、
  // audio_ring 实测）：
  // 1) `) * 2` / `] * 2`：括号闭合后的乘除（float 语境假设与既有规则一致）
  //    `) - 1` / `) + 1` 同理（audio_ring 的 `(uv / 1.0) - 1` 实测）；`]` 只限乘除，
  //    数组下标后的加减更可能是 int 语境（a[i] - 1）。
  code = code.replace(/([)\]])\s*([*/])\s*(\d+)(?![\d.])/g, '$1 $2 $3.0')
  code = code.replace(/\)\s*([+-])\s*(\d+)(?![\d.])/g, ') $1 $2.0')
  // 2) `1 - step(...)`：字面量 ± 浮点内建函数调用（floatNames 只收集变量，收不到函数名）
  //    注意必须把**函数名与左括号一起捕获并原样写回**。此前替换串是 '$1$2.0 $3 '，
  //    没有捕获函数名，等于把 `1 - step(` 改写成 `1.0 - ` —— 函数名和左括号被删掉，
  //    于是 `max(1 - step(0.01, x), y)` 变成 `max(1.0 - 0.01, x), y)`：
  //    括号右多一个、语义也全错。表现为 Simple_Audio_Bars / auto_sway /
  //    multistage_wave 等整类效果编译失败被静默跳过（全库 19 处）。
  code = code.replace(
    /(^|[^\w.])(\d+)(?![.\d])\s*([+-])\s*((?:step|smoothstep|mix|mod|fract|abs|sin|cos|tan|atan|sqrt|pow|inversesqrt|floor|ceil|sign|length|normalize|distance|dot|cross|exp|log|exp2|log2|clamp|min|max)\s*\()/g,
    '$1$2.0 $3 $4',
  )
  // 3) vecN 变量 ± 整数字面量（如 uv - 1）：HLSL 合法，GLSL 需要补 .0
  {
    const vecNames = new Set()
    const vecRe = /\b(?:vec[234])\s+([A-Za-z_][A-Za-z0-9_]*)/g
    let vm
    while ((vm = vecRe.exec(code)) !== null) vecNames.add(vm[1])
    if (vecNames.size > 0) {
      const valt = Array.from(vecNames).sort((a, b) => b.length - a.length).join('|')
      code = code.replace(new RegExp('\\b(' + valt + ')\\s*([+-])\\s*(\\d+)(?![\\d.])', 'g'), '$1 $2 $3.0')
    }
  }
  // 4) `%` 取模与 uint：HLSL 的 float % int 合法，GLSL 的 % 只作用于整数。
  //    float 语境（左根不在 int/uint 名单）→ mod(x, n.0)；int 语境保留 %。
  //    `uint x = ...` 在语料里只作数组下标（Simple_Audio_Bars 的 barFreq），统一转 int。
  {
    const intNames = new Set()
    const intRe = /\b(?:int|uint)\s+([A-Za-z_][A-Za-z0-9_]*)/g
    let im
    while ((im = intRe.exec(code)) !== null) intNames.add(im[1])
    code = code.replace(/\buint\b/g, 'int')
    code = code.replace(
      /\b([A-Za-z_][A-Za-z0-9_]*)\s*%\s*(\d+)(?![\d.])/g,
      (all, lhs, n) => (intNames.has(lhs) ? all : 'mod(' + lhs + ', ' + n + '.0)'),
    )
    // float 取模结果赋给 int 变量 → 显式 int() 构造（GLSL 无 float→int 隐式转换）
    code = code.replace(/\bint\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*mod\(([^;]*)\);/g, 'int $1 = int(mod($2));')
  }
  // 5) HLSL 标量 → vecN 隐式广播（声明初始化）：vec3 horBeam = beamWidth; → vec3(beamWidth)。
  //    仅改写「右值不含括号/逗号」的声明（函数调用与多分量构造不受影响），
  //    vecN(vecN) 构造本身合法，已为 vec 的右值被包裹后语义不变。
  code = code.replace(/\b(vec[234])\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^;()\n,]+);/g, (all, ty, name, rhs) => {
    const r = rhs.trim()
    if (/^(vec[234]|mat[234]|int\b|float\b)/.test(r)) return all
    return ty + ' ' + name + ' = ' + ty + '(' + r + ');'
  })

  // 6) 浮点内建实参中的裸 int（mix(0, 1, x) / clamp(0, 1, x) 等，ANTIALIAS=1 分支实测）。
  //    rewriteCall 平衡括号取参，嵌套调用安全；已有的浮点字面量被 (?![.\d]) 守卫跳过。
  //    注意回调必须把 `fn(...)` 原样包回（返回裸 inner 会把整个调用剥掉）。
  for (const fn of ['mix', 'clamp', 'step', 'smoothstep', 'min', 'max', 'mod', 'pow']) {
    code = rewriteCall(code, fn, (inner) =>
      fn + '(' + inner.replace(/(?<![A-Za-z0-9_.])(\d+)(?![.\d])/g, '$1.0') + ')')
  }
  // 6b) [we-scene patch] `clamp(0, 1, x)` 实参顺序。GLSL/HLSL 都是 clamp(x, min, max)，
  //    工坊音频环却常写成 Shadertoy 风格的 clamp(min, max, x)。编译能过，但 min>max
  //    时 GLSL 结果未定义，频谱高度整段塌掉（3784370784 的 video.frag volumNum）。
  //    只改写前两参是字面量 0 和 1 的三参调用，其余不动。
  code = rewriteCall(code, 'clamp', (inner) => {
    const args = splitArgs(inner)
    if (args.length !== 3) return 'clamp(' + inner + ')'
    const a0 = args[0].trim()
    const a1 = args[1].trim()
    const numLit = (s) => /^-?\d+\.?\d*$/.test(s)
    if (numLit(a0) && numLit(a1) && Number(a0) === 0 && Number(a1) === 1) {
      return 'clamp(' + args[2].trim() + ', ' + a0 + ', ' + a1 + ')'
    }
    return 'clamp(' + inner + ')'
  })
  // 7) 复跑一轮字面量补 .0：规则 1-3 会产生新的浮点字面量左值（`) * 2.0 - 1`），
  //    而本文件顶部的 ± 规则跑在它们之前、看不到这些新形态。
  code = code.replace(/(\.\d+)\s*([+-])\s*(\d+)(?![\d.])/g, '$1 $2 $3.0')
  code = code.replace(/([)\]])\s*([+-])\s*(\d+)(?![\d.])/g, '$1 $2 $3.0')
  // 8) [we-scene patch] smoothstep 反向边距：`smoothstep(A, 0.0, x)`（A>0）在 HLSL 合法
  //    （= 1 - smoothstep(0.0, A, x)），GLSL 规定 edge0 ≥ edge1 时**结果未定义**，
  //    ANGLE/Metal 实测恒返回 0 —— 示波器的波形线 `smoothstep(thickness*0.02, 0.0, dist)`
  //    因此整段消失（层 FBO 纯净色、无波形）。仅改写 edge1 为字面量 0.0 的调用；
  //    edge0/edge1 都是变量的情形无法静态判定，保持原样。
  code = rewriteCall(code, 'smoothstep', (inner) => {
    const args = splitArgs(inner)
    if (args.length === 3 && args[1].trim() === '0.0' && args[0].trim() !== '0.0') {
      return '(1.0 - smoothstep(0.0, ' + args[0].trim() + ', ' + args[2].trim() + '))'
    }
    return 'smoothstep(' + inner + ')'
  })

  // [we-scene patch] 9) **HLSL 的向量隐式截断**：`vec2 a; vec4 b; a = b;` 在 HLSL 里
  //    合法（取前 2 个分量），GLSL ES 直接报 `'=' : dimension mismatch`。
  //    实测 15 例，全部来自壁纸自身源码而非我们的改写，典型如
  //    cloudmotion.vert 的 `varying vec2 v_NoiseCoord; ... v_NoiseCoord = v_TexCoord;`
  //    （v_TexCoord 是 vec4）。
  //    做法：收集所有已声明的向量宽度（含 uniform/varying/in/out/局部），
  //    对「裸变量 = 裸变量」形式按左宽补 swizzle。
  //    只处理两侧都是**不带 swizzle 的单一标识符**的赋值 —— 带 swizzle 的一侧宽度
  //    由 swizzle 决定，作者通常已经写对；含运算的右值宽度无法在文本层可靠推断，
  //    误改的风险大于收益，交给真实编译校验兜住。
  {
    const width = new Map()
    const wre = /\b(?:uniform|varying|attribute|in|out)?\s*\b(vec([234]))\s+([A-Za-z_]\w*)/g
    let wm
    while ((wm = wre.exec(code)) !== null) width.set(wm[3], Number(wm[2]))
    if (width.size > 0) {
      const SW = { 2: 'xy', 3: 'xyz', 4: 'xyzw' }
      code = code.replace(/(^|[;{}\n]\s*)([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)\s*;/g, (all, pre, lhs, rhs) => {
        const lw = width.get(lhs)
        const rw = width.get(rhs)
        if (!lw || !rw || lw >= rw) return all
        return pre + lhs + ' = ' + rhs + '.' + SW[lw] + ';'
      })
    }
    // 9b) **标量 → 向量广播**：HLSL `vec2 a; a = pow(...);` 把 float 复制到每个分量，
    //    GLSL ES 报 dimension mismatch。3789816832 的 sine_wave 就是
    //    `waveCoord = pow(saturate(...), …)` —— 整段波浪效果编不过被跳过。
    //    只包「明显标量」右值：浮点字面量、float 标识符、或**整段 RHS 就是一个**
    //    标量内置调用（括号必须在串尾闭合）。已是 `vecN(...)` 构造或右侧本身
    //    是向量标识符的不动。
    //
    //    ⚠️ 不能只看「以 func( 开头」：scroll.vert 的
    //    `scroll = sign(scroll) * pow(vec2(...), …)` 以 sign( 开头但整式是 vec2，
    //    旧逻辑会包成 vec2(...) 并标成 scalarFilled，再把 `scroll * g_Time` 改成
    //    `scroll.x * g_Time` → float 赋给 varying vec2，pass 编不过，
    //    3264246690 三条 DANGER 胶带静止。
    //
    //    广播后该变量常再当**标量**用（`ApplyBlending(..., u_WaveOpacity * waveCoord)`）：
    //    HLSL 里 float*float2→float2，但 ApplyBlending 的 opacity 是 float，WE 侧会
    //    取分量；GLSL 直接类型不匹配。对「被标量填充过」的向量，float↔它 的乘除
    //    改为 `.x`（各分量相同，取哪个都一样）。
    if (width.size > 0) {
      const floatNames = new Set()
      const fre = /\b(?:uniform|varying|attribute|in|out)?\s*\bfloat\s+([A-Za-z_]\w*)/g
      let fm
      while ((fm = fre.exec(code)) !== null) floatNames.add(fm[1])
      const SCALAR_CALL =
        'pow|saturate|clamp|smoothstep|step|abs|floor|ceil|fract|frac|sin|cos|tan|' +
        'asin|acos|atan|sqrt|length|distance|dot|exp|log|sign|fmod|mod|min|max|mix|lerp'
      // 整段 RHS 必须是「一个」调用：首 '(' 匹配的 ')' 落在串尾。分量函数若实参
      // 已含向量（标识符 / vecN() / .xy…），结果仍是向量，不得当标量广播。
      const ALWAYS_FLOAT = /^(?:length|distance|dot)$/
      const isScalarCall = (r) => {
        const m = r.match(new RegExp('^(?:' + SCALAR_CALL + ')\\s*\\('))
        if (!m) return false
        let depth = 0
        const open = m[0].length - 1
        let close = -1
        for (let i = open; i < r.length; i++) {
          if (r[i] === '(') depth++
          else if (r[i] === ')') {
            depth--
            if (depth === 0) {
              close = i
              break
            }
          }
        }
        if (close !== r.length - 1) return false
        const fn = m[0].replace(/\s*\($/, '')
        if (ALWAYS_FLOAT.test(fn)) return true
        const args = r.slice(open + 1, close)
        if (/\bvec[234]\s*\(/.test(args)) return false
        if (/\.[xyzwrgba]{2,4}\b/.test(args)) return false
        for (const name of width.keys()) {
          // `v_TexCoord.x` 是标量分量；`sign(scroll)` / `v_TexCoord.xy` 才是向量。
          // 负向前瞻只放过「单字母」swizzle。另：`(?<!\.)` 避免公共头里的
          // 短向量名 `x`/`a`/`b`（common_blending.h）误匹配 swizzle 字母本身 ——
          // 否则 sine_wave 的 pow(… v_TexCoord.x …) 整段不被广播，音谱回归。
          const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          if (new RegExp('(?<!\\.)\\b' + esc + '\\b(?!\\s*\\.[xyzwrgba]\\b)').test(args)) {
            return false
          }
        }
        return true
      }
      const scalarFilled = new Set()
      code = code.replace(/(^|[;{}\n]\s*)([A-Za-z_]\w*)\s*=\s*([^;]+);/g, (all, pre, lhs, rhs) => {
        const lw = width.get(lhs)
        if (!lw) return all
        const r = rhs.trim()
        if (new RegExp('^vec' + lw + '\\s*\\(').test(r)) return all
        if (width.has(r)) return all
        const isLit = /^-?\d+(?:\.\d+)?(?:e[-+]?\d+)?$/i.test(r)
        const isFloatId = floatNames.has(r)
        if (!isLit && !isFloatId && !isScalarCall(r)) return all
        scalarFilled.add(lhs)
        return pre + lhs + ' = vec' + lw + '(' + r + ');'
      })
      if (scalarFilled.size > 0) {
        const alt = [...scalarFilled].sort((a, b) => b.length - a.length).join('|')
        // float * vec / vec * float / float / vec / vec / float → 用 .x
        code = code.replace(
          new RegExp(`\\b([A-Za-z_]\\w*)\\s*([*/])\\s*(${alt})\\b`, 'g'),
          (all, lhs, op, rhs) => (width.has(lhs) ? all : `${lhs} ${op} ${rhs}.x`),
        )
        code = code.replace(
          new RegExp(`\\b(${alt})\\s*([*/])\\s*([A-Za-z_]\\w*)\\b`, 'g'),
          (all, lhs, op, rhs) => (width.has(rhs) ? all : `${lhs}.x ${op} ${rhs}`),
        )
      }
    }
  }

  // 10) [we-scene patch] **裸整数赋给 float**：
  //    HLSL 允许 `v_TexCoord.w = 0;`、`float x = 1;`，GLSL ES 没有 int→float 隐式转换，
  //    报 `'=' : cannot convert from 'const int' to 'highp float'`。
  //    这是实测占比最高的一类编译失败（真实 GL 编译里 29 例），
  //    典型来源就是 blur/godrays/shine 系列 .vert 里的 `v_TexCoord.z = 0;`。
  //    只改写「右值是纯整数字面量」的赋值，不碰 int 变量的赋值：
  //    左侧是 swizzle（.x/.w/.rgb…）时必为 float 分量，安全；
  //    左侧是 `float`/`vecN` 声明时同样安全。其余（如 `int i = 0;`）不动。
  code = code.replace(/(\.[xyzwrgba]{1,4}\s*=\s*)(-?\d+)\s*;/g, '$1$2.0;')
  code = code.replace(/\b(float|vec2|vec3|vec4)\s+([A-Za-z_]\w*)\s*=\s*(-?\d+)\s*;/g, (all, ty, name, n) => {
    return ty === 'float' ? `${ty} ${name} = ${n}.0;` : `${ty} ${name} = ${ty}(${n}.0);`
  })
  // 10a) **已声明的 float 标识符**被赋裸整数：`out float i_DCorrectingFactor; … = 1;`
  //    上面两条只覆盖「同句声明」和 swizzle。workshop/3577773857 Simple_Audio_Bars
  //    的 .vert 在 BAR_STYLE==1 时写 `i_DCorrectingFactor = 1;`，ANGLE 报
  //    `cannot convert from 'const int' to 'out highp float'`，整段音谱 pass 被跳过
  //    （3789816832 Sound 层诊断「alpha 无信息 → 加法」、画面上音谱消失）。
  {
    const floatNames = new Set()
    const fre = /\b(?:uniform|varying|attribute|in|out)?\s*\bfloat\s+([A-Za-z_]\w*)/g
    let fm
    while ((fm = fre.exec(code)) !== null) floatNames.add(fm[1])
    if (floatNames.size > 0) {
      const alt = [...floatNames].sort((a, b) => b.length - a.length).join('|')
      code = code.replace(new RegExp(`\\b(${alt})\\s*=\\s*(-?\\d+)\\s*;`, 'g'), '$1 = $2.0;')
      code = code.replace(new RegExp(`\\b(${alt})\\s*([-+*/]=)\\s*(-?\\d+)\\s*;`, 'g'), '$1 $2 $3.0;')
    }
  }
  // 复合赋值同理：`x *= 2;` / `v.w += 1;`
  code = code.replace(/(\.[xyzwrgba]{1,4}\s*[-+*/]=\s*)(-?\d+)\s*;/g, '$1$2.0;')
  // return 裸整数（函数返回 float 时）：`return 0;` —— 只在返回类型为 float 的函数体内安全，
  // 无法在纯文本层判定，故仅处理 `return 0.0` 之外的 0/1 常见写法且左界是 float 函数声明的情况，
  // 风险高于收益，暂不做（若出现由真实编译校验兜住）。

  // 10b) [we-scene patch] **float 结果赋给 int 声明**：与上一条正好相反的方向。
  //    HLSL 里 `int bar = step(a, b);` 合法（隐式截断），GLSL ES 没有 float→int 隐式
  //    转换，报 `cannot convert from 'float' to 'int'`，**整个 pass 编译失败**。
  //    而 renderLayer 对编译失败只 console.warn 后跳过该 pass —— 表现为图层
  //    「渲染成白屏/纯色」而非报错，极难定位（2134765860 的音频条即此症）。
  //
  //    只改写右值是**已知返回 float 的内置函数**的声明，把类型改成 float：
  //    不用 `int(...)` 包裹，因为后续 `bar *= step(...)` 等复合运算仍是浮点，
  //    截断成 int 会把抗锯齿/间距的小数权重直接压成 0/1（间距一栏会整条消失）。
  //    全库实测命中 15 个 shader 文件 / 10+ 个壁纸（Simple_Audio_Bars 系列为主）。
  const FLOAT_FNS = 'step|smoothstep|saturate|clamp|mix|lerp|frac|fract|abs|floor|ceil|min|max|pow|sqrt|length|dot|distance'
  code = code.replace(
    new RegExp(`\\bint\\s+([A-Za-z_]\\w*)\\s*=\\s*((?:${FLOAT_FNS})\\s*\\()`, 'g'),
    'float $1 = $2',
  )

  // 10b-2) [we-scene patch] **float 声明 = 纯整型表达式**（不只是字面量）。
  //    10) 那条只覆盖右值是**裸整数字面量**的情况（`float x = 1;`）。WE 官方
  //    godrays_cast / shine_cast 模板写的是**含 int 变量的表达式**：
  //
  //        const int sampleCount = 30;
  //        const float sampleDrop = sampleCount - 1;   // int-int → int，GLSL ES 拒绝
  //
  //    ANGLE 报 `'=' : cannot convert from 'const mediump int' to 'const highp float'`，
  //    整个 godrays_cast / shine_cast pass 被跳过 —— 画面上体积光/光晕整条效果消失
  //    （1315534440 首现）。全库 46 处 / 38 张壁纸，语句形态只有一种，
  //    来源是官方效果模板 + 5 个 workshop 派生副本
  //    （shaders/effects/{godrays,shine}_cast.frag 与 workshop/{3424038533,
  //    2920750574,2865559209,3689929683,3735484626}/effects/*.frag）。
  //
  //    **必须放在 10b 之后**：10b 会把 `int bar = step(...)` 改成 `float bar = ...`，
  //    在它之前收集 int 名字会把这类已转 float 的变量当成 int，给后面 10b-3 的
  //    混合运算改写喂进错误类型（2134765860 Simple_Audio_Bars 的 bar 就是此例，
  //    会被多包一层 float(bar)：无害但掩盖真实类型）。
  //
  //    判定「纯整型表达式」的三个条件缺一不可，否则会误伤合法写法：
  //      - 右值不含小数点：`float a = n * 0.5;` 已经是 float 表达式；
  //      - 右值不含函数调用：`float bar = max(barLeft, barRight);` 返回 float，本来合法；
  //      - 右值里出现的**每一个**标识符都是本文件已声明的 int。
  //    三条同时满足才说明整条表达式的类型确实是 int。
  {
    const intNames = collectIntNames(code)
    if (intNames.size > 0) {
      code = code.replace(
        /\b(const\s+)?float\s+([A-Za-z_]\w*)\s*=\s*([^;{}]+);/g,
        (all, cst, name, rhs) => {
          const body = rhs.trim()
          if (/\./.test(body)) return all               // 已含小数点 → 已是 float 表达式
          if (/[A-Za-z_]\w*\s*\(/.test(body)) return all // 函数调用 → 返回类型未知，不碰
          const ids = body.match(/[A-Za-z_]\w*/g)
          if (!ids || !ids.length) return all           // 纯字面量已由 10) 处理
          if (!ids.every((x) => intNames.has(x))) return all
          return `${cst || ''}float ${name} = float(${body});`
        },
      )
    }
  }

  // 10b-3) [we-scene patch] **int 与 float 的混合二元运算**。
  //    与上一条是同一批文件的配对症状：sampleDrop 修成 float 之后，循环体里
  //
  //        for (int i = 0; i < sampleCount; ++i)
  //            albedo += smp * (i / sampleDrop);   // int / float，GLSL ES 无此运算
  //
  //    仍然报 `'/' : wrong operand types - no operation '/' exists that takes a
  //    left-hand operand of type 'mediump int' and a right operand of type ...`。
  //    HLSL 会把 i 提升成 float；GLSL ES **没有任何**混合类型的二元运算符重载。
  //    全库 46 处 / 38 张壁纸，形态只有 `i / sampleDrop` 一种（与上一条完全重合，
  //    印证两者是同一条模板语句的上下游）。
  //
  //    只改写两侧都能在本文件确证类型的标识符，不做通用类型推导（那需要完整 AST，
  //    风险远大于收益）。同名既是 int 又是 float（不同 #if 分支重名）时两边都放弃。
  {
    const intNames = collectIntNames(code)
    const floatNames = new Set()
    let fm
    const fDeclRe = /\b(?:const\s+|uniform\s+|varying\s+|in\s+|out\s+)*float\s+([A-Za-z_]\w*)/g
    while ((fm = fDeclRe.exec(code)) !== null) floatNames.add(fm[1])
    for (const n of [...intNames]) {
      if (floatNames.has(n)) { intNames.delete(n); floatNames.delete(n) }
    }
    if (intNames.size > 0 && floatNames.size > 0) {
      const iAlt = [...intNames].sort((a, b) => b.length - a.length).join('|')
      const fAlt = [...floatNames].sort((a, b) => b.length - a.length).join('|')
      // int OP float → float(int) OP float
      code = code.replace(
        new RegExp(`\\b(${iAlt})\\s*([*/+-])\\s*(${fAlt})\\b`, 'g'),
        (all, a, op, b) => `float(${a}) ${op} ${b}`,
      )
      // float OP int → float OP float(int)（对称情形，语料里暂无但同样非法）
      code = code.replace(
        new RegExp(`\\b(${fAlt})\\s*([*/+-])\\s*(${iAlt})\\b`, 'g'),
        (all, a, op, b) => `${a} ${op} float(${b})`,
      )
    }
  }

  // 10c) [we-scene patch] **bool 参与算术**：`barLeft *= isLeftChannel;`
  //    HLSL 把 bool 当 0/1 隐式提升，GLSL ES 报
  //    `cannot convert from 'bool' to 'highp float'`。与 10b 同源同症：
  //    Simple_Audio_Bars 的 CENTER_H/CENTER_V 分支就靠这行裁剪左右声道，
  //    编译失败后整个音频条 pass 被跳过 → 白屏。
  //
  //    收集本文件里声明为 bool 的局部变量名，只把「复合赋值右侧整个是该变量」
  //    的写法包成 float(x)。不做通用 bool 算术改写：`a && b`、`!flag`
  //    这类正常布尔运算必须原样保留。
  {
    const boolNames = new Set()
    const boolRe = /\bbool\s+([A-Za-z_]\w*)\s*=/g
    let bm
    while ((bm = boolRe.exec(code)) !== null) boolNames.add(bm[1])
    if (boolNames.size > 0) {
      const alt = [...boolNames].join('|')
      // `x *= isLeftChannel;` / `x *= isLeftChannel * 2.0;` 的首项
      code = code.replace(
        new RegExp(`([-+*/]=\\s*)(${alt})\\b`, 'g'),
        (all, op, name) => `${op}float(${name})`,
      )
    }
  }

  // 10d) [we-scene patch] **float 一维数组的二维下标**。
  //    WE 引擎把 `g_AudioSpectrum64Left` 以 `float4[16]` 注入，作者声明成
  //    `uniform float arr[64]` 再用 `arr[i/4][i%4]` 取 packed 分量。HLSL 侧合法
  //    （真正的类型是 float4），GLSL 的 `float[64]` 上 `[i][j]` 直接编译失败。
  //    renderLayer 对编译失败只 console.warn 后跳过整个 pass —— solid 白底按
  //    Add（colorBlendMode 31）合成，就是整块不透明白矩形
  //    （3784370784 的 workshop/3605510527/video 音频环）。
  //    `float arr[N]; arr[a][b]` → `arr[int(a)*4 + int(b)]`，与 packed float4
  //    分量下标等价。不改 vec4/mat 的 `[i][j]`（那些本来合法）。
  {
    const names = new Set()
    for (const fm of code.matchAll(/\b(?:uniform\s+)?(?:highp|mediump|lowp\s+)?float\s+([A-Za-z_]\w*)\s*\[/g)) {
      names.add(fm[1])
    }
    if (names.size) {
      const alt = [...names].sort((a, b) => b.length - a.length).join('|')
      const re = new RegExp('\\b(' + alt + ')\\s*\\[', 'g')
      let out = ''
      let last = 0
      let fm
      while ((fm = re.exec(code))) {
        const open1 = fm.index + fm[0].length - 1
        const close1 = matchGroup(code, open1, '[', ']')
        if (close1 < 0) break
        let p = close1 + 1
        while (p < code.length && /[ \t]/.test(code[p])) p++
        if (code[p] !== '[') {
          re.lastIndex = close1 + 1
          continue
        }
        const close2 = matchGroup(code, p, '[', ']')
        if (close2 < 0) break
        const e1 = code.slice(open1 + 1, close1)
        const e2 = code.slice(p + 1, close2)
        out += code.slice(last, fm.index)
        out += fm[1] + '[int((' + e1 + ')) * 4 + int((' + e2 + '))]'
        last = close2 + 1
        re.lastIndex = last
      }
      code = out + code.slice(last)
    }
  }

  // 10e) [we-scene patch] **mix 隐式截断**：`mix(vec3, vec4, t)` 在 HLSL lerp 里按
  //    共同宽度取分量，GLSL ES 无此重载，整个 pass 编译失败。同一条工坊音频环
  //    的 `mix(u_userNewColor, col, step(...))`（vec3 × vec4）就踩这个。
  //    只处理能从「调用点之前最近一次声明」或 swizzle/构造推出宽度的两侧，
  //    推不出就不动。
  code = rewriteCall(code, 'mix', (inner, idx) => {
    const args = splitArgs(inner)
    if (args.length !== 3) return 'mix(' + inner + ')'
    const widthBefore = (expr) => {
      const t = expr.trim()
      const sw = /\.([xyzwrgba]{1,4})\s*$/.exec(t)
      if (sw) return sw[1].length
      const ctor = /^vec([234])\s*\(/.exec(t)
      if (ctor) return Number(ctor[1])
      if (!/^[A-Za-z_]\w*$/.test(t)) return 0
      const dre = new RegExp('\\b(vec([234])|float)\\s+' + t + '\\b', 'g')
      let lastW = 0
      let dm
      while ((dm = dre.exec(code)) !== null && dm.index < idx) {
        lastW = dm[1].startsWith('vec') ? Number(dm[2]) : 1
      }
      return lastW
    }
    const a = args[0].trim()
    const b = args[1].trim()
    const wa = widthBefore(a)
    const wb = widthBefore(b)
    if (wa >= 2 && wb >= 2 && wa !== wb) {
      const w = Math.min(wa, wb)
      const sw = w === 2 ? '.xy' : w === 3 ? '.xyz' : ''
      if (!sw) return 'mix(' + inner + ')'
      return 'mix(' + (wa > w ? a + sw : a) + ', ' + (wb > w ? b + sw : b) + ', ' + args[2].trim() + ')'
    }
    return 'mix(' + inner + ')'
  })

  // 10f) [we-scene patch] **return 隐式截断**：`vec3 f() { vec4 col; return col; }`
  //    HLSL 取前 N 分量，GLSL ES 报 dimension mismatch。同上工坊 shader 的
  //    `vec3 drawSence` 返回 `vec4 col`。只改写函数体内「return 裸标识符」。
  {
    const re = /\b(vec([234]))\s+([A-Za-z_]\w*)\s*\(/g
    let out = ''
    let last = 0
    let fm
    while ((fm = re.exec(code))) {
      const closeParen = matchParen(code, fm.index + fm[0].length - 1)
      if (closeParen < 0) break
      let p = closeParen + 1
      while (p < code.length && /\s/.test(code[p])) p++
      if (code[p] !== '{') continue
      const closeBrace = matchGroup(code, p, '{', '}')
      if (closeBrace < 0) break
      const lw = Number(fm[2])
      if (lw >= 4) {
        re.lastIndex = closeBrace
        continue
      }
      let body = code.slice(p + 1, closeBrace)
      const localW = new Map()
      for (const um of code.slice(0, fm.index).matchAll(/\buniform\s+(?:highp|mediump|lowp\s+)?(vec([234]))\s+([A-Za-z_]\w*)/g)) {
        localW.set(um[3], Number(um[2]))
      }
      for (const dm of body.matchAll(/\b(vec([234]))\s+([A-Za-z_]\w*)/g)) {
        localW.set(dm[3], Number(dm[2]))
      }
      const sw = lw === 2 ? 'xy' : 'xyz'
      body = body.replace(/\breturn\s+([A-Za-z_]\w*)\s*;/g, (all, name) => {
        const rw = localW.get(name)
        if (rw && rw > lw) return 'return ' + name + '.' + sw + ';'
        return all
      })
      out += code.slice(last, p + 1) + body
      last = closeBrace
      re.lastIndex = closeBrace
    }
    code = out + code.slice(last)
  }

  // mul(a, b)：HLSL 行向量语义
  // 收集矩阵类型 uniform/局部变量名
  const matNames = new Set()
  const matRe = /\b(?:uniform\s+)?(?:mat4|mat3|mat2|float4x4)\s+([A-Za-z_][A-Za-z0-9_]*)/g
  let mm
  while ((mm = matRe.exec(code)) !== null) matNames.add(mm[1])
  code = rewriteCall(code, 'mul', (inner) => {
    const args = splitArgs(inner)
    if (args.length !== 2) return 'mul(' + inner + ')'
    const a = args[0].trim()
    const b = args[1].trim()
    const isMat = (s) => matNames.has(s.split(/[\[.\s]/)[0]) || /^mat[234]\(/.test(s)
    // [we-scene patch] 结果**必须整体加括号**。mul(...) 常紧跟 swizzle，
    // 如 `mul(vec4(p, 0.0, 1.0), g_MVPInverse).xyw`：不加括号会展开成
    // `transpose(M) * vec4(...).xyw` —— swizzle 绑到了右侧向量而不是乘积，
    // 于是变成 mat4 × vec3，报
    // `wrong operand types ... 'highp 4X4 matrix of float' and ... 'highp 3-component vector'`
    // （chromatic_aberration / cursorripple_apply_force / depthparallax 实测）。
    if (isMat(a) && isMat(b)) return '(transpose(' + b + ') * transpose(' + a + '))'
    if (isMat(b)) return '(transpose(' + b + ') * ' + a + ')'
    return '(' + a + ' * ' + b + ')'
  })

  // lerp → mix；frac → fract（HLSL 名）
  code = code.replace(/\blerp\b/g, 'mix').replace(/\bfrac\b/g, 'fract')

  // [we-scene patch] 其余 HLSL 内建：必须在**转译器**里解决而非公共头里定义。
  // 判据：本机库有 shader 用了这些名字却 **不 include 任何头**
  //（atan2 3 文件、CAST3X3 3 文件），只靠 common.h 补定义对它们无效。
  //
  // atan2(y, x) → atan(y, x)：HLSL 与 GLSL 的两参 atan 实参顺序相同，直接改名。
  // 注意 common.h 也定义了 `float atan2(...)`，二者不冲突 ——
  // rewriteCall 的 isDeclaration 会跳过声明形式，故头里的定义不会被改写成
  // 非法的 `float atan(float y, float x)`；改写只作用于调用点，
  // 头里那份定义随之变成无人调用的死代码（GLSL 允许）。
  code = rewriteCall(code, 'atan2', (inner) => 'atan(' + inner + ')')
  // fmod(x, y)：HLSL 向零截断，GLSL mod 向下取整；两者仅在被除数为负时不同。
  // 全库 6 处实参皆为正（fmod(g_Time, ...)），但仍按语义严格实现，
  // 避免以后遇到负值时出现静默偏差。
  code = rewriteCall(code, 'fmod', (inner) => {
    const args = splitArgs(inner)
    if (args.length !== 2) return 'mod(' + inner + ')'
    const a = args[0].trim()
    const b = args[1].trim()
    return '((' + a + ') - (' + b + ') * trunc((' + a + ') / (' + b + ')))'
  })
  // ddx/ddy → dFdx/dFdy（对 float 与 vec2 都成立，无需按类型分支）
  code = rewriteCall(code, 'ddx', (inner) => 'dFdx(' + inner + ')')
  code = rewriteCall(code, 'ddy', (inner) => 'dFdy(' + inner + ')')
  // CAST3X3(m)：mat4 → mat3 左上角。与 CAST2/3/4 同族的引擎内建宏，
  // 使用它的 3 个文件同样零 include。
  code = rewriteCall(code, 'CAST3X3', (inner) => 'mat3(' + inner + ')')

  // varying/attribute → in/out
  if (stage === 'vert') {
    code = code.replace(/\battribute\b/g, 'in').replace(/\bvarying\b/g, 'out')
  } else {
    code = code.replace(/\bvarying\b/g, 'in').replace(/\battribute\b/g, 'in')

    // [we-scene patch] **varying 类型跨 stage 不一致**：作者在 .vert 声明
    // `varying vec4 v_TexCoord`、在 .frag 声明 `varying vec2 v_TexCoord`
    // （color_grading 7 个壁纸、topographic 1 个）。WE 的 D3D 编译器按寄存器对齐容忍，
    // GLSL ES 链接期直接报 `Types of varying 'v_TexCoord' differ`。
    // 以**顶点侧为准**加宽片元侧声明：多出来的分量片元不读，语义不变；
    // 反过来收窄顶点侧会丢掉它确实写入的分量。
    if (typeof siblingSrc === 'string' && siblingSrc) {
      const vertTypes = new Map()
      const vre = /^\s*(?:varying|out)\s+(?:highp|mediump|lowp\s+)?(vec[234]|float)\s+([A-Za-z_]\w*)\s*;/gm
      let vm
      while ((vm = vre.exec(siblingSrc)) !== null) vertTypes.set(vm[2], vm[1])
      const RANK = { float: 1, vec2: 2, vec3: 3, vec4: 4 }
      const widened = new Map()
      code = code.replace(/^(\s*in\s+(?:highp|mediump|lowp\s+)?)(vec[234]|float)(\s+)([A-Za-z_]\w*)(\s*;)/gm,
        (all, pre, ty, sp, name, tail) => {
          const vt = vertTypes.get(name)
          if (!vt || RANK[vt] <= RANK[ty]) return all
          widened.set(name, RANK[ty]) // 记住片元原本当它是几维用的
          return pre + vt + sp + name + tail
        })
      // 加宽后，原先「整体当 vec2 使用」的地方要补回 swizzle，否则
      // `texture(g_Texture0, v_TexCoord)` 变成 sampler2D + vec4 → `'texture' : no matching
      // overloaded function found`。只补**裸标识符**出现处（已带 swizzle 的不动）。
      if (widened.size > 0) {
        const SW = { 1: 'x', 2: 'xy', 3: 'xyz' }
        for (const [name, origRank] of widened) {
          const sw = SW[origRank]
          if (!sw) continue
          // 声明行不动；其余裸引用补 swizzle
          code = code.split('\n').map((line) => {
            if (/^\s*in\s/.test(line)) return line
            return line.replace(new RegExp('\\b' + name + '\\b(?!\\s*[.\\w])', 'g'), name + '.' + sw)
          }).join('\n')
        }
      }
    }

    // [we-scene patch] **vec4/vec3 当 UV 用**：WE/HLSL 的 `texSample2D(s, float4)`
    // 隐式取 .xy；GLSL `texture` 只要 vec2。作者常把 `v_TexCoord` 声明成 vec4
    //（vert 只写 `.xy` 或 `.xyxy`），两侧同为 vec4 时上面的「加宽」路径不触发，
    // 整颗喂给采样 + 与 vec2 做算术 → 编不过 → 效果被跳过。
    // 2902406982「窗口 Box」：clipping_mask 跳过后白三角 albedo 直出成白块
    //（空 composelayer 回读已经对了，但遮罩效果本身没跑起来）。
    // 全库同构：clipping_mask / chromatic_aberration 等约十余处。
    //
    // ⚠️ 局部 vec3/vec4 只用于 texture() 实参（中间 UV 变量）；**不能**拿去改
    // `vec2 x = …` 赋值行——公共头 `ApplyBlending` 里有 `vec3 r;`，会把音条
    // shader 的 `float r = …; vec2 delta = … + r` 改成 `r.xy`，ANGLE 报
    // field selection on non-vector，Simple_Audio_Bars 整 pass 跳过（3789816832）。
    {
      const inVecN = new Map()
      const declRe = /^\s*in\s+(?:highp|mediump|lowp\s+)?(vec[34])\s+([A-Za-z_]\w*)\s*;/gm
      let dm
      while ((dm = declRe.exec(code)) !== null) inVecN.set(dm[2], Number(dm[1].slice(3)))
      const localVecN = new Map(inVecN)
      const locRe = /\b(vec[34])\s+([A-Za-z_]\w*)\s*[=;]/g
      while ((dm = locRe.exec(code)) !== null) {
        if (!localVecN.has(dm[2])) localVecN.set(dm[2], Number(dm[1].slice(3)))
      }
      if (localVecN.size > 0) {
        const swizzleUvArg = (arg) => {
          const t = arg.trim()
          if (!t) return arg
          const bare = /^([A-Za-z_]\w*)$/.exec(t)
          if (bare && localVecN.has(bare[1])) return bare[1] + '.xy'
          // `v_TexCoord + offset`（左侧是 vecN、尚未 swizzle）
          const bin = /^([A-Za-z_]\w*)(\s*[+\-].+)$/.exec(t)
          if (bin && localVecN.has(bin[1])) return '(' + bin[1] + '.xy' + bin[2] + ')'
          return arg
        }
        // textureLod 先于 texture，避免前缀误伤（rewriteCall 虽有词边界，顺序更稳）
        for (const fn of ['textureLod', 'texture']) {
          code = rewriteCall(code, fn, (inner) => {
            const args = splitArgs(inner)
            if (args.length >= 2) args[1] = swizzleUvArg(args[1])
            return fn + '(' + args.join(', ') + ')'
          })
        }
      }
      // `vec2 uv = v_TexCoord * … - vec2`：只改 **in 插值量**（真 UV varying）。
      if (inVecN.size > 0) {
        code = code.split('\n').map((line) => {
          if (!/\bvec2\s+[A-Za-z_]\w*\s*=/.test(line)) return line
          let out = line
          for (const name of inVecN.keys()) {
            out = out.replace(new RegExp('\\b' + name + '\\b(?!\\s*[.\\w])', 'g'), name + '.xy')
          }
          return out
        }).join('\n')
      }
    }

    // [we-scene patch] 片元阶段**写入 varying**：GLSL ES 3.0 的 `in` 是只读的，
    // 报 `'assign' : l-value required (can't modify an input "v_TexCoord")`；
    // 而 HLSL / GLSL 1.x 允许把插值量当可写局部量用，作者据此就地改 UV
    // （geometric_transform.frag 直接 `v_TexCoord.y += ...` 做几何变形，
    //  sine_wave.frag 同理）。
    // 做法：把被写入的那个 varying 重命名为 `<name>_rw` 的局部副本，
    // 在 main 开头以原插值量初始化，函数体内所有引用改指副本。
    // 这样既保留只读的 `in` 声明，又还原了作者要的可写语义。
    const written = new Set()
    const inNames = new Set()
    {
      const dre = /^\s*in\s+(?:highp|mediump|lowp\s+)?(vec[234]|float)\s+([A-Za-z_]\w*)\s*;/gm
      let dm
      while ((dm = dre.exec(code)) !== null) inNames.add(dm[2])
    }
    for (const name of inNames) {
      // 赋值/复合赋值/自增：`name = `、`name.xy +=`、`name++`
      const wre = new RegExp('\\b' + name + '\\b\\s*(?:\\.[xyzwrgba]{1,4})?\\s*(?:[-+*/]?=(?!=)|\\+\\+|--)')
      if (wre.test(code)) written.add(name)
    }
    if (written.size > 0) {
      const bodyStart = code.search(/\bvoid\s+main\s*\([^)]*\)\s*\{/)
      if (bodyStart !== -1) {
        const braceIdx = code.indexOf('{', bodyStart)
        const head = code.slice(0, braceIdx + 1)
        let body = code.slice(braceIdx + 1)
        const decls = []
        for (const name of written) {
          const tm = new RegExp('^\\s*in\\s+(?:highp|mediump|lowp\\s+)?(vec[234]|float)\\s+' + name + '\\s*;', 'm').exec(code)
          const ty = tm ? tm[1] : 'vec4'
          decls.push('    ' + ty + ' ' + name + '_rw = ' + name + ';')
          body = replaceWord(body, name, name + '_rw')
          // 初始化行自身被上面的整词替换改成了 `x_rw = x_rw`，这里单独写回
        }
        body = '\n' + decls.map((d) => d.replace(/= (\w+)_rw;/, '= $1;')).join('\n') + '\n' + body
        code = head + body
      }
    }
  }

  // HLSL 属性/修饰符
  code = code.replace(/\[(?:unroll|loop|branch|flatten)\]\s*/g, '')
  code = code.replace(/\bstatic\s+/g, '')

  // [we-scene patch] `for (int i = <float>; i < <float>; ...)` 的整型循环边界。
  // HLSL 允许 float→int 隐式收窄，GLSL ES 3.00 **不允许**，于是整个 pass 编译失败、
  // 被「效果 pass 编译失败时跳过」的兜底整趟丢掉 —— 表现是效果**完全不出现**
  // 而控制台又没有报错（2872267921 人物头部的音乐发光圆环就这样整个不见）。
  //
  // 只包裹**裸标识符**：写成 `int(g_AudioFrequencyMin)` 的已经合法（全库 339 处
  // 都是这个写法），字面量 `0`/`-1` 也合法。全库 1898 个 shader 里真正踩到的只有
  // 4 处 / 4 个壁纸：2872267921 与 3790276621 的 test_shader（u_MinFreqRange /
  // u_MaxFreqRange）、3784370784 的 water_caustics（u_Iterations）、
  // 3789811524 的 blur_gaussian（iterations，含 `-iterations` 的取负形态）。
  //
  // 判据必须是「该标识符在本文件里声明成 float」，不能见名就包：把本来就是 int 的
  // 变量套上 int() 虽无害，但循环变量同名的局部 int 会被误伤可读性。
  {
    const floatNames = new Set()
    for (const m of code.matchAll(/\b(?:uniform[ \t]+)?(?:highp|mediump|lowp)?[ \t]*float[ \t]+([A-Za-z_]\w*)[ \t]*[;=]/g)) {
      floatNames.add(m[1])
    }
    if (floatNames.size) {
      // for ( int|uint <v> = <init> ; <v> <op> <bound> ;
      // init 与 bound 各自独立判定：3784370784 的 water_caustics 是
      // `for (int n = 0; n < u_Iterations; n++)` —— 初值是字面量、只有边界要包。
      const wrap = (e) => {
        const neg = e.trim().startsWith('-')
        const name = e.replace(/^-\s*/, '').trim()
        if (!floatNames.has(name)) return e
        return (neg ? '-' : '') + 'int(' + name + ')'
      }
      code = code.replace(
        /(for\s*\(\s*(?:int|uint)\s+(\w+)\s*=\s*)(-?\s*[A-Za-z_]\w*|-?\s*\d+)(\s*;\s*\2\s*[<>]=?\s*)(-?\s*[A-Za-z_]\w*|-?\s*\d+)(\s*;)/g,
        (all, head, v, init, mid, bound, tail) => head + wrap(init) + mid + wrap(bound) + tail)
    }
  }

  // [we-scene patch] uniform 去重。公共头（如 common_blur.h 的 blur*a 隐式采样
  // g_Texture0）必须自己声明所用的 uniform —— include 展开在文件顶部，
  // 而原文件的 `uniform sampler2D g_Texture0` 在其后若干行，GLSL 要求先声明后使用。
  // 但 GLSL ES 3.0 里**重复声明同名 uniform 是错误**，所以展开后必须去重：
  // 保留第一次出现，后续同名声明整行删掉（含尾部的 material 元数据注释——
  // 那些注释是 renderer.js 在**原始源码**上单独解析的，删掉不影响常量绑定）。
  {
    const seen = new Set()
    code = code.split('\n').map((line) => {
      const m = /^[ \t]*uniform[ \t]+(?:highp|mediump|lowp[ \t]+)?[A-Za-z0-9_]+[ \t]+([A-Za-z_][A-Za-z0-9_]*)/.exec(line)
      if (!m) return line
      const name = m[1]
      if (seen.has(name)) return ''
      seen.add(name)
      return line
    }).join('\n')
  }

  // 输出：float 精度统一 highp（顶点默认即 highp；片元若用 mediump 会与顶点共享 uniform 精度不一致导致链接失败）
  let prologue = '#version 300 es\n'
  if (stage === 'vert') {
    prologue += 'precision highp float;\n'
  }
  if (stage === 'frag') {
    prologue += 'precision highp float;\n'
    if (/\bgl_FragColor\b/.test(code)) {
      prologue += 'out vec4 fragColor;\n'
      code = code.replace(/\bgl_FragColor\b/g, 'fragColor')
    }
  }
  return prologue + code
}
