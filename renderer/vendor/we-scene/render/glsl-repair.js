// 编译报错驱动的 GLSL 修复：hlsl2glsl 是文本级转译，HLSL 的隐式规则（int→float、
// 向量按窄侧截断、标量当 bool、vec→float 取 .x、全局 const 用 uniform 初始化…）
// 只能逐例补正则，长尾永远补不完。这里在**编译失败之后**按报错行就地生成候选修正，
// 每个候选都真编译一遍，只有「该行错误数下降且总错误数不增」才采纳 —— 所以候选
// 可以宽松，验证兜底；能编译的 shader 永远不会进到这里。
// compileFn(src) → 错误数组 [{ line, msg }]（空数组 = 成功）；浏览器侧用 WebGL
// info log，离线用 glslangValidator，两边报错措辞都源自 glslang，按宽松正则解析。

const MAX_ROUNDS = 24
const MAX_TRIALS = 400

/** 解析 glslang / ANGLE 风格的 info log。 */
export function parseInfoLog(log) {
  const out = []
  for (const raw of String(log || '').split('\n')) {
    const m = /ERROR:\s*\d+:(\d+):\s*(.*)$/.exec(raw)
    if (m && !/compilation terminated/.test(m[2])) out.push({ line: Number(m[1]), msg: m[2].trim() })
  }
  return out
}

function parseType(s) {
  if (!s) return null
  const v = /(\d)-component vector of (float|int|uint|bool)/.exec(s)
  if (v) return { base: v[2], n: Number(v[1]) }
  if (/matrix/.test(s)) return { base: 'float', n: 0, mat: true }
  const sc = /\b(float|int|uint|bool)\b/.exec(s)
  return sc ? { base: sc[1], n: 1 } : null
}

const TYPE_KW = /^(?:void|bool|int|uint|float|[biu]?vec[234]|mat[234](?:x[234])?|sampler\w*)$/
const QUAL_KW = /^(?:const|in|out|inout|uniform|highp|mediump|lowp|flat|smooth|centroid|invariant|precision)$/
const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '<<=', '>>=', '&=', '^=', '|='])
const BIN_PREC = {
  '||': 1, '^^': 2, '&&': 3, '|': 4, '^': 5, '&': 6, '==': 7, '!=': 7,
  '<': 8, '>': 8, '<=': 8, '>=': 8, '<<': 9, '>>': 9, '+': 10, '-': 10, '*': 11, '/': 11, '%': 11,
}

function tokenize(text) {
  const toks = []
  const re = /\s+|([A-Za-z_]\w*)|(\d+\.\d*(?:[eE][+-]?\d+)?[fF]?|\.\d+(?:[eE][+-]?\d+)?[fF]?|\d+(?:[eE][+-]?\d+)?[uUfF]?)|(<<=|>>=|\+\+|--|<<|>>|<=|>=|==|!=|&&|\|\||\^\^|[+\-*/%&|^]=|.)/gy
  let m
  while (re.lastIndex < text.length && (m = re.exec(text))) {
    if (m[1]) toks.push({ t: 'id', v: m[1], s: m.index, e: re.lastIndex })
    else if (m[2]) toks.push({ t: 'num', v: m[2], s: m.index, e: re.lastIndex })
    else if (m[3]) toks.push({ t: 'op', v: m[3], s: m.index, e: re.lastIndex })
  }
  return toks
}

// 小型 Pratt 解析器：只为拿到各语法节点在源文本中的范围，解析失败就放弃该语句。
function analyze(text) {
  const toks = tokenize(text)
  const nodes = []
  let i = 0
  const peek = () => toks[i]
  const isOp = (v) => toks[i] && toks[i].t === 'op' && toks[i].v === v
  const fail = () => { throw new Error('parse') }

  function primary() {
    const tk = toks[i]
    if (!tk) fail()
    if (tk.t === 'op' && (tk.v === '-' || tk.v === '+' || tk.v === '!' || tk.v === '~' || tk.v === '++' || tk.v === '--')) {
      i++
      const x = unary()
      if (tk.v === '!') nodes.push({ k: 'cond', s: x.s, e: x.e })
      return { s: tk.s, e: x.e }
    }
    return postfix()
  }
  const unary = primary
  function postfix() {
    const tk = toks[i]
    let node
    if (tk.t === 'op' && tk.v === '(') {
      i++
      expr()
      if (!isOp(')')) fail()
      node = { s: tk.s, e: toks[i].e }
      i++
    } else if (tk.t === 'id' || tk.t === 'num') {
      i++
      node = { s: tk.s, e: tk.e, id: tk.t === 'id' ? tk.v : null }
    } else fail()
    for (;;) {
      if (isOp('(') && node.id) {
        const name = node.id
        i++
        const args = []
        if (!isOp(')')) {
          for (;;) {
            const a = assign()
            args.push({ s: a.s, e: a.e })
            if (isOp(',')) { i++; continue }
            break
          }
        }
        if (!isOp(')')) fail()
        node = { s: node.s, e: toks[i].e }
        i++
        nodes.push({ k: 'call', name, args, s: node.s, e: node.e })
      } else if (isOp('[')) {
        i++
        expr()
        if (!isOp(']')) fail()
        node = { s: node.s, e: toks[i].e }
        i++
      } else if (isOp('.')) {
        i++
        const m = toks[i]
        if (!m || m.t !== 'id') fail()
        i++
        node = { s: node.s, e: m.e }
      } else if (isOp('++') || isOp('--')) {
        node = { s: node.s, e: toks[i].e }
        i++
      } else break
    }
    return node
  }
  function binary(minPrec) {
    let left = unary()
    for (;;) {
      const tk = peek()
      if (!tk || tk.t !== 'op') break
      const p = BIN_PREC[tk.v]
      if (!p || p < minPrec) break
      i++
      const right = binary(p + 1)
      nodes.push({ k: 'bin', op: tk.v, l: left, r: right })
      if (tk.v === '&&' || tk.v === '||' || tk.v === '^^') {
        nodes.push({ k: 'cond', s: left.s, e: left.e }, { k: 'cond', s: right.s, e: right.e })
      }
      left = { s: left.s, e: right.e }
    }
    return left
  }
  function ternary() {
    const c = binary(1)
    if (isOp('?')) {
      nodes.push({ k: 'cond', s: c.s, e: c.e })
      i++
      assign()
      if (!isOp(':')) fail()
      i++
      const b = assign()
      return { s: c.s, e: b.e }
    }
    return c
  }
  function assign() {
    const l = ternary()
    const tk = peek()
    if (tk && tk.t === 'op' && ASSIGN_OPS.has(tk.v)) {
      i++
      const r = assign()
      nodes.push({ k: 'assign', op: tk.v, l, r: { s: r.s, e: r.e } })
      return { s: l.s, e: r.e }
    }
    return l
  }
  function expr() {
    let x = assign()
    while (isOp(',')) { i++; const y = assign(); x = { s: x.s, e: y.e } }
    return x
  }
  function parenGroup() {
    if (!isOp('(')) fail()
    i++
    const x = expr()
    if (!isOp(')')) fail()
    i++
    return x
  }
  function statement() {
    const tk = peek()
    if (!tk) return
    if (tk.t === 'op' && (tk.v === ';' || tk.v === '{' || tk.v === '}')) { i++; return }
    if (tk.t === 'id' && (tk.v === 'if' || tk.v === 'while')) {
      i++
      const c = parenGroup()
      nodes.push({ k: 'cond', s: c.s, e: c.e })
      return
    }
    if (tk.t === 'id' && (tk.v === 'else' || tk.v === 'do')) { i++; return }
    if (tk.t === 'id' && tk.v === 'for') {
      i++
      if (!isOp('(')) fail()
      i++
      for (let part = 0; part < 3; part++) {
        if (part < 2) { statement(); continue }
        if (!isOp(')')) expr()
      }
      if (!isOp(')')) fail()
      i++
      return
    }
    if (tk.t === 'id' && tk.v === 'return') {
      i++
      if (isOp(';')) { i++; return }
      const x = expr()
      nodes.push({ k: 'ret', s: x.s, e: x.e })
      if (isOp(';')) i++
      return
    }
    // 声明：[限定符]* 类型 名字 [数组] [= 初值] (, 名字 [= 初值])* ;
    let j = i
    const declStart = tk.s
    let isConst = false
    while (toks[j] && toks[j].t === 'id' && QUAL_KW.test(toks[j].v)) { if (toks[j].v === 'const') isConst = true; j++ }
    if (toks[j] && toks[j].t === 'id' && TYPE_KW.test(toks[j].v) && toks[j + 1] && toks[j + 1].t === 'id') {
      const type = toks[j].v
      i = j + 1
      for (;;) {
        const nameTk = toks[i]
        if (!nameTk || nameTk.t !== 'id') fail()
        i++
        const decl = { k: 'decl', type, name: nameTk.v, nameEnd: nameTk.e, declStart, isConst, init: null }
        // 声明里多余的成员访问（`varying vec4 v_Size.xy;`）
        if (isOp('.') && toks[i + 1] && toks[i + 1].t === 'id') {
          decl.junk = { s: toks[i].s, e: toks[i + 1].e }
          i += 2
        }
        if (isOp('[')) { i++; if (!isOp(']')) expr(); if (!isOp(']')) fail(); i++ }
        if (isOp('(')) { nodes.push(decl); return } // 函数头
        if (isOp('=')) {
          i++
          const x = assign()
          decl.init = { s: x.s, e: x.e }
        }
        nodes.push(decl)
        if (isOp(',')) { i++; continue }
        break
      }
      if (isOp(';')) i++
      return
    }
    expr()
    if (isOp(';')) i++
  }
  while (i < toks.length) {
    const before = i
    try { statement() } catch {
      // 跳到下一个语句边界继续
      i = Math.max(before + 1, i)
      while (i < toks.length && !(toks[i].t === 'op' && (toks[i].v === ';' || toks[i].v === '{' || toks[i].v === '}'))) i++
    }
    if (i === before) i++
  }
  return nodes
}

const SW = ['', 'x', 'xy', 'xyz', 'xyzw']
const vecT = (base, n) => (n === 1 ? base : (base === 'float' ? '' : base[0]) + 'vec' + n)

/** 在 [s,e) 范围外包一层：pre + text + post。 */
const wrap = (text, s, e, pre, post) => text.slice(0, s) + pre + text.slice(s, e) + post + text.slice(e)

function lineRange(src, line) {
  let s = 0
  for (let k = 1; k < line; k++) {
    const n = src.indexOf('\n', s)
    if (n < 0) return null
    s = n + 1
  }
  let e = src.indexOf('\n', s)
  if (e < 0) e = src.length
  return [s, e]
}

// 出错行所在的语句区域：向前扩到上一个 ; { } 之后，向后扩到下一个 ; { 为止 ——
// 跨行语句的报错行常落在末行，必须把整条语句交给解析器。
function regionAround(src, line) {
  const lr = lineRange(src, line)
  if (!lr) return null
  let [s, e] = lr
  // 本行前缀若没有语句边界，向前找
  const head = src.slice(s, e)
  if (!/[;{}]/.test(head.trimStart().slice(0, 1)) && !/^\s*(?:#|$)/.test(head)) {
    let k = s - 1
    let depth = 0
    for (; k >= 0; k--) {
      const ch = src[k]
      if (ch === ')') depth++
      else if (ch === '(') { if (depth === 0) continue; depth-- }
      else if (depth === 0 && (ch === ';' || ch === '{' || ch === '}')) break
    }
    s = k + 1
  }
  // 末尾不完整（括号未闭合）时向后扩
  let bal = 0
  for (let k = s; k < e; k++) { if (src[k] === '(') bal++; else if (src[k] === ')') bal-- }
  while (bal > 0 && e < src.length) {
    const ch = src[e]
    if (ch === '(') bal++
    else if (ch === ')') bal--
    e++
  }
  return [s, e]
}

function funcReturnTypeAt(src, pos) {
  const re = /(?:^|\n)\s*(?:(?:highp|mediump|lowp)\s+)?([A-Za-z_]\w*)\s+[A-Za-z_]\w*\s*\([^;{}]*\)\s*\{/g
  let m
  let ty = null
  while ((m = re.exec(src)) && m.index < pos) ty = m[1]
  return ty && TYPE_KW.test(ty) ? ty : null
}

// 针对一条报错生成候选（完整源文本）。优先级：报错可解析出的定向修正在前，宽泛兜底在后。
function candidates(src, err) {
  const reg = regionAround(src, err.line)
  if (!reg) return []
  const [rs, re] = reg
  const text = src.slice(rs, re)
  let nodes
  try { nodes = analyze(text) } catch { return [] }
  const out = []
  const push = (s, e, pre, post) => out.push(src.slice(0, rs) + wrap(text, s, e, pre, post) + src.slice(re))
  const replace = (s, e, str) => out.push(src.slice(0, rs) + text.slice(0, s) + str + text.slice(e) + src.slice(re))
  const msg = err.msg
  const opm = /no operation '([^']+)' exists that takes a left-hand operand of type '([^']+)' and a right operand of type '([^']+)'/.exec(msg)
  const callm = /'([A-Za-z_]\w*)'\s*:\s*no matching overloaded function/.exec(msg)
  const convm = /cannot convert from '([^']+)' to '([^']+)'/.exec(msg)

  const fixOperand = (nd, L, R) => {
    const fix = (side) => {
      const T = side === 'l' ? L : R
      const O = side === 'l' ? R : L
      const span = nd[side]
      if (!T || !O) return
      if (T.base !== 'float' && O.base === 'float' && !T.mat) push(span.s, span.e, vecT('float', T.n) + '(', ')')
      if (T.base === 'float' && O.base === 'float' && T.n > 1 && O.n > 1 && T.n > O.n) push(span.s, span.e, '(', ').' + SW[O.n])
    }
    fix('l')
    fix('r')
  }

  if (opm) {
    const [, op, ls, rsT] = opm
    const L = parseType(ls)
    const R = parseType(rsT)
    for (const nd of nodes) {
      if (nd.k === 'bin' && nd.op === op) {
        if (op === '%') {
          const lt = text.slice(nd.l.s, nd.l.e)
          const rt = text.slice(nd.r.s, nd.r.e)
          if (L && L.base === 'int') replace(nd.l.s, nd.r.e, `${lt} % int(${rt})`)
          replace(nd.l.s, nd.r.e, `mod(float(${lt}), float(${rt}))`)
          replace(nd.l.s, nd.r.e, `mod(${lt}, ${rt})`)
        } else fixOperand(nd, L, R)
      } else if (nd.k === 'assign' && nd.op === op) {
        fixOperand({ l: nd.l, r: nd.r }, L, R)
      }
    }
  }
  if (callm) {
    const name = callm[1]
    // 作者自定义函数：按各重载签名逐参构造转换（float(vec3) 取首分量，正是 HLSL 的截断语义）
    const sigs = []
    const sigRe = new RegExp('(?:^|\\n)\\s*[A-Za-z_]\\w*\\s+' + name + '\\s*\\(([^)]*)\\)\\s*\\{', 'g')
    let sm
    while ((sm = sigRe.exec(src))) {
      const ps = sm[1].split(',').map((p) => p.trim().split(/\s+/).filter((w) => !QUAL_KW.test(w))[0]).filter(Boolean)
      if (ps.every((t) => TYPE_KW.test(t) && !/^sampler/.test(t))) sigs.push(ps)
    }
    // 驱动常每行只报一次：同一行多处调用要一次全改（区间倒序替换；有嵌套重叠则放弃，偏移会失效）
    for (const ps of sigs) {
      const calls = nodes.filter((nd) => nd.k === 'call' && nd.name === name && nd.args.length === ps.length)
      if (calls.length < 2) continue
      const spans = []
      for (const nd of calls) nd.args.forEach((a, k) => spans.push({ s: a.s, e: a.e, ty: ps[k] }))
      spans.sort((a, b) => b.s - a.s || a.e - b.e)
      if (spans.some((sp, k) => k > 0 && sp.e > spans[k - 1].s)) continue
      let t = text
      for (const sp of spans) t = wrap(t, sp.s, sp.e, sp.ty + '(', ')')
      out.push(src.slice(0, rs) + t + src.slice(re))
    }
    for (const nd of nodes) {
      if (nd.k !== 'call' || nd.name !== name) continue
      for (const ps of sigs) {
        if (ps.length !== nd.args.length) continue
        let t = text
        for (let a = nd.args.length - 1; a >= 0; a--) t = wrap(t, nd.args[a].s, nd.args[a].e, ps[a] + '(', ')')
        out.push(src.slice(0, rs) + t + src.slice(re))
      }
    }
    for (const nd of nodes) {
      if (nd.k !== 'call' || nd.name !== name) continue
      // 多个实参同时出错时逐个修不会让错误数下降，先试「全部转 float / 全部转 int」
      const allWrap = (fn) => {
        let t = text
        for (const a of [...nd.args].reverse()) t = wrap(t, a.s, a.e, fn + '(', ')')
        out.push(src.slice(0, rs) + t + src.slice(re))
      }
      // 截断 swizzle 排在 float() 前：实参是向量时 HLSL 取前 N 分量（mix(vec3, vec3, vec4) → .xyz），
      // float() 只取首分量；实参是标量时 swizzle 候选会编译失败、自然落到 float()
      for (const a of nd.args) {
        const lit = /^[\s\d.+-]*$/.test(text.slice(a.s, a.e))
        if (!lit) for (const n of [3, 2]) push(a.s, a.e, '(', ').' + SW[n])
        push(a.s, a.e, 'float(', ')')
        push(a.s, a.e, 'int(', ')')
        if (!lit) push(a.s, a.e, '(', ').x')
        for (const n of [2, 3, 4]) push(a.s, a.e, 'vec' + n + '(', ')')
      }
      if (nd.args.length > 1) { allWrap('float'); allWrap('int') }
    }
  }
  if (convm) {
    const A = parseType(convm[1])
    const B = parseType(convm[2])
    const spans = []
    for (const nd of nodes) {
      if (nd.k === 'decl' && nd.init) spans.push(nd.init)
      if (nd.k === 'assign') spans.push(nd.r)
    }
    // 同一声明语句里的多个初值（`vec2 a = 0.0, b = 0.0;`）一起包
    const decls = nodes.filter((nd) => nd.k === 'decl' && nd.init)
    if (B && !B.mat && decls.length > 1) {
      let t = text
      for (const d of [...decls].reverse()) t = wrap(t, d.init.s, d.init.e, vecT(B.base, B.n) + '(', ')')
      out.push(src.slice(0, rs) + t + src.slice(re))
    }
    for (const sp of spans) {
      if (A && B && !A.mat && !B.mat) {
        if (A.n > 1 && B.n >= 1 && B.n < A.n && A.base === B.base) push(sp.s, sp.e, '(', ').' + SW[B.n])
        if (A.n > 1 && B.n >= 1 && B.n < A.n && A.base !== B.base) push(sp.s, sp.e, vecT(B.base, B.n) + '((', ').' + SW[B.n] + ')')
        push(sp.s, sp.e, vecT(B.base, B.n) + '(', ')')
      }
    }
  }
  if (/boolean expression expected/.test(msg) || /bool/.test(msg)) {
    for (const nd of nodes) if (nd.k === 'cond') push(nd.s, nd.e, 'bool(', ')')
  }
  if (/return/.test(msg)) {
    for (const nd of nodes) {
      if (nd.k !== 'ret') continue
      const ty = funcReturnTypeAt(src, rs + nd.s)
      if (ty) push(nd.s, nd.e, ty + '(', ')')
    }
  }
  if (/constant|const/.test(msg)) {
    // HLSL 的全局 static const 可以用 uniform 初始化；GLSL ES 3.0 的全局初值必须是常量表达式。
    // 改成无初值的全局变量，赋值挪到 main() 开头（同一行插入，不改变行号）。
    const mainM = /\bvoid\s+main\s*\(\s*(?:void)?\s*\)\s*\{/.exec(src)
    for (const nd of nodes) {
      if (nd.k !== 'decl' || !nd.isConst || !nd.init || !mainM || rs + nd.declStart > mainM.index) continue
      const seg = text.slice(nd.declStart, nd.nameEnd)
      const k = seg.search(/\bconst\b/)
      if (k < 0) continue
      const init = text.slice(nd.init.s, nd.init.e)
      let t = text.slice(0, nd.nameEnd) + text.slice(nd.init.e)
      t = t.slice(0, nd.declStart + k) + t.slice(nd.declStart + k + 5)
      const pre = src.slice(0, rs) + t + src.slice(re)
      const delta = pre.length - src.length
      const at = mainM.index + mainM[0].length + delta
      out.push(pre.slice(0, at) + ` ${nd.name} = ${init};` + pre.slice(at))
    }
  }
  if (/syntax error/.test(msg)) {
    for (const nd of nodes) if (nd.k === 'decl' && nd.junk) replace(nd.junk.s, nd.junk.e, '')
  }
  // 兜底：报错措辞无法识别（各家驱动不同）时，对本行所有节点试通用修正
  if (!opm && !callm && !convm && out.length === 0) {
    for (const nd of nodes) {
      if (nd.k === 'bin') { push(nd.l.s, nd.l.e, 'float(', ')'); push(nd.r.s, nd.r.e, 'float(', ')') }
      if (nd.k === 'cond') push(nd.s, nd.e, 'bool(', ')')
    }
  }
  return [...new Set(out)]
}

const errsAt = (errs, line) => errs.filter((x) => x.line === line).length
const msgKey = (x) => x.line + '|' + x.msg.replace(/\s+/g, ' ')
// 候选自己造出的错误：说明改坏了，而不是推进了
const BROKEN = /syntax error|not supported|undeclared|redefinition|swizzle|l-value|constructor|not enough data|too many|out of range|field selection|dot operator/
// 允许「换成新错误也算推进」的错误族：都是隐式转换链上的下一环
const CHAIN = /wrong operand types|cannot convert|no matching overloaded|boolean expression|dimension mismatch|return/

function accepts(errs, e2, line, seen) {
  if (e2.length === 0) return true
  const atLine = e2.filter((x) => x.line === line)
  if (atLine.some((x) => BROKEN.test(x.msg))) return false
  // 语法错误会让编译器停在该处、掩盖其后的错误，修好后总数上升是正常的
  if (errs.some((x) => x.line === line && /syntax error/.test(x.msg))) return atLine.length === 0
  if (e2.length > errs.length) return false
  if (atLine.length < errsAt(errs, line)) return true
  // 同一行换成了**从未出现过**的新错误：链式隐式转换（int+vec2 修好后暴露 vec2→float）
  return atLine.length > 0 && atLine.every((x) => CHAIN.test(x.msg) && !seen.has(msgKey(x)))
}

/**
 * 反复修复报错直到编译通过或无可用候选。
 * 返回 { src, ok, errors, fixes }：ok=false 时 src 为尽力修复后的版本（可能仍失败）。
 */
export function repairGlsl(src, compileFn) {
  let errs = compileFn(src)
  let trials = 0
  let fixes = 0
  const seen = new Set(errs.map(msgKey))
  for (let round = 0; round < MAX_ROUNDS && errs.length > 0; round++) {
    let progressed = false
    // 依次尝试各报错行（首个修不动时，后面的仍可能可修）
    const lines = [...new Set(errs.map((x) => x.line))]
    outer: for (const line of lines) {
      const err = errs.find((x) => x.line === line)
      for (const cand of candidates(src, err)) {
        if (++trials > MAX_TRIALS) break outer
        const e2 = compileFn(cand)
        if (accepts(errs, e2, line, seen)) {
          for (const x of e2) seen.add(msgKey(x))
          src = cand
          errs = e2
          fixes++
          progressed = true
          break outer
        }
      }
    }
    if (!progressed) break
  }
  return { src, ok: errs.length === 0, errors: errs, fixes }
}