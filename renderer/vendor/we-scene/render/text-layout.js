// 文字排版与光栅化（从 text.js 拆出，切口 = 脚本沙箱 vs 纯排版）
//
// [we-scene patch] 这一半**没有任何沙箱/引擎依赖**：
//   - layoutText 是纯函数，measure(text) → 宽度由宿主注入，Node 可直接校验
//     （scripts/verify-text.mjs 不加载沙箱一半也能跑排版判据）；
//   - drawTextLayer 只碰 Canvas2D ctx。
// WE 脚本沙箱（evalTextScript / evalObjectScript 等）仍在 text.js，
// 该文件对两个函数做 re-export，既有 import 方（main.ts / verify-text.mjs）不受影响。

/**
 * 编辑器默认 padding=32 会出现在 14×23 标题、36×42 日历格这种比 64px 还窄的盒子上。
 * 按像素 inset 会把左对齐起点推到盒外、内宽夹成 1，字跑到标题条下面。装不下就当 0。
 * 2134765860 时钟 302 盒 + padding 82 装得下，照常 inset。
 */
export function effectiveTextPadding(boxW, boxH, padding) {
  const pad = Math.max(0, Number(padding) || 0)
  const w = Math.max(1, Number(boxW) || 1)
  const h = Math.max(1, Number(boxH) || 1)
  if (pad * 2 >= Math.min(w, h)) return 0
  return pad
}

/**
 * 纯排版：把内容排进盒子，返回每行的文本/宽度/位置。measure(text) → 宽度由宿主注入
 * （浏览器 = Canvas2D measureText，离线校验 = 等宽近似），故本函数可在 node 里验证。
 * opts: { boxW, boxH, pointsize, lineHeight, spacing:[x,y], padding,
 *         maxwidth, limitwidth, maxrows, limitrows, limituseellipsis,
 *         halign, valign }
 */
export function layoutText(content, opts, measure) {
  const boxW = Math.max(1, opts.boxW)
  const boxH = Math.max(1, opts.boxH)
  const spacing = opts.spacing || [0, 0]
  const lineHeight = Math.max(1, opts.lineHeight || (opts.pointsize || 24) * 1.25 + spacing[1])
  // WE 只有 limitwidth（+maxwidth）开启才换行；关闭时整行溢出盒子继续画
  // （宿主画布已预留溢出边距）。实测反例：2134765860 时钟 302 盒 + padding 82 不开
  // limitwidth，按内宽换行会把 "20:47:41" 竖着摞成三行。
  // [we-scene patch] 换行宽度只认 maxwidth，不能再 min(innerW)：媒体文字层的盒子是
  // 占位尺寸（歌名/歌手层常是 2×2，WE 运行时按内容重排），钳到 innerW=2 会让每个
  // 字都换行，再被 maxrows=1+ellipsis 收成单独一个「…」（3785267658 牛来的歌名/
  // 歌手因此整层空白）。作者设 maxwidth 就是要的换行约束，与盒子占位宽无关。
  const wrapW = opts.limitwidth && opts.maxwidth > 0 ? opts.maxwidth : Infinity

  // 限宽换行：优先在空白断；CJK 无空格则硬断。逐字 measure 对挂件级文本量足够。
  function wrapOne(text) {
    if (measure(text) <= wrapW) return [text]
    const lines = []
    let cur = ''
    let lastBreak = -1
    for (const ch of text) {
      cur += ch
      if (ch === ' ' || ch === '\t') lastBreak = cur.length
      if (measure(cur) > wrapW && cur.length > 1) {
        if (lastBreak > 0) {
          lines.push(cur.slice(0, lastBreak - 1))
          cur = cur.slice(lastBreak)
        } else {
          lines.push(cur.slice(0, -1))
          cur = ch
        }
        lastBreak = -1
        while (measure(cur) > wrapW && cur.length > 1) {
          lines.push(cur.slice(0, -1))
          cur = cur.slice(-1)
        }
      }
    }
    if (cur !== '') lines.push(cur)
    return lines.length ? lines : ['']
  }

  let lines = []
  const raw = String(content ?? '').split('\n')
  for (const r of raw) lines.push(...wrapOne(r))

  // 限行截断 + 省略号
  let truncated = false
  if (opts.limitrows && opts.maxrows > 0 && lines.length > opts.maxrows) {
    lines = lines.slice(0, opts.maxrows)
    truncated = true
    if (opts.limituseellipsis) {
      let last = lines[opts.maxrows - 1]
      while (last.length > 0 && measure(last + '…') > wrapW) last = last.slice(0, -1)
      lines[opts.maxrows - 1] = last + '…'
    }
  }

  // 盒内定位（y 向下，与 Canvas 一致）。
  // WE 官方：horizontalalign/verticalalign 是相对**图层 origin** 的贴齐边，不是 CSS
  // 那样在盒子里左/右排（开发者原话：「left-alignment aligns the text along the
  // horizontal (X) position of the text element」）。我们的层 quad 以 origin 为中心，
  // 故 left/right/top/bottom 应对准盒子中线（= origin），center 仍居中整段文字。
  // 2974757317 歌名 ha=left：origin 在头像右侧，旧实现贴盒左缘 → 字叠进圆标。
  const widths = lines.map((t) => measure(t))
  const totalH = lines.length * lineHeight
  const halign = opts.halign || 'center'
  const valign = opts.valign || 'center'
  const midX = boxW / 2
  const midY = boxH / 2
  const y0 =
    valign === 'top' ? midY
      : valign === 'bottom' ? midY - totalH
        : (boxH - totalH) / 2
  const out = lines.map((text, i) => {
    const w = widths[i]
    const x =
      halign === 'left' ? midX
        : halign === 'right' ? midX - w
          : (boxW - w) / 2
    return { text, width: w, x, y: y0 + i * lineHeight }
  })
  return { lines: out, lineHeight, totalH, truncated, boxW, boxH }
}

/**
 * 墨水量界 → 画布边距（scene-mount updateTexts 用，纯函数、可离线校验）。
 * 返回 [marginLeft, marginTop, marginRight, marginBottom]：盒外四个方向各需要
 * 多少额外边距才能完整装下排版结果（不含字形超出行盒的少量抗锯齿墨晕，
 * 那部分由基础边距 cover）。
 */
export function inkOverflow(layout, boxW, boxH) {
  let inkL = Infinity, inkR = -Infinity, inkT = Infinity, inkB = -Infinity
  for (const ln of layout.lines || []) {
    inkL = Math.min(inkL, ln.x)
    inkR = Math.max(inkR, ln.x + ln.width)
    inkT = Math.min(inkT, ln.y)
    inkB = Math.max(inkB, ln.y + (layout.lineHeight || 0))
  }
  if (!layout.lines || !layout.lines.length) return [0, 0, 0, 0]
  return [
    Math.max(0, -inkL),
    Math.max(0, -inkT),
    Math.max(0, inkR - boxW),
    Math.max(0, inkB - boxH),
  ]
}

/**
 * 对称扩边后的统一边距：盒中心 = 画布中心 = 层 origin 不动（墨水在屏幕上的
 * 位置不随扩边移动），只长透明边距。媒体文字层的盒子是占位尺寸（歌名/歌手
 * 层常是 2×2，WE 运行时按内容重排），不扩边长标题会被画布边缘截没
 * （3785267658 整层空白）。
 */
export function textCanvasMarginGrow(layout, boxW, boxH, baseMargin) {
  const [l, t, r, b] = inkOverflow(layout, boxW, boxH)
  return Math.max(baseMargin, l, t, r, b)
}

/**
 * 媒体组件的歌名/歌手文字层是否需要按内容对称扩边（scene-mount updateTexts 用，
 * 纯函数、可离线校验）。两个条件缺一不可——曾因只看「盒子小」误伤一批普通层：
 *   - boxW/H ≤ 4：媒体组件文字层的盒子是 WE 占位尺寸（2×2，WE 运行时按内容重排）；
 *     正常大盒自有几何，扩边改 quad 会把好字挪出可见区（2938612768 标题被裁）。
 *   - hasMediaHook：沙箱挂了 media* 回调。三体 3509243656 的 time/State/Tx 等
 *     2×2 是脚本驱动的普通文本，内容动态，扩边会让 size 每帧跟着内容跳变。
 *
 * 返回 true 不代表一定会改 size：调用方仍要用 textCanvasMarginGrow 算边距——
 * 墨水在「盒 + 基础边距」内装得下时它会退回基础边距，layer.size 与原来一致
 * （短词 Paused/Playing 因此保持作者原布局，不依赖这里做字宽预判）。
 */
export function shouldGrowMediaPlaceholder(boxW, boxH, hasMediaHook) {
  return boxW <= 4 && boxH <= 4 && !!hasMediaHook
}

/**
 * Canvas2D 绘制（浏览器路径）。opts:
 * { font, color:[r,g,b], alpha, brightness, lineHeight,
 *   opaquebackground, backgroundcolor, backgroundbrightness,
 *   castshadow, pointsize, spacing }
 * ctx 须已按质量系数 scale 过（绘制一律用盒子坐标）。
 */
export function drawTextLayer(ctx, layout, opts) {
  const boxW = layout.boxW
  const boxH = layout.boxH
  const color = opts.color || [1, 1, 1]
  const alpha = opts.alpha !== undefined ? opts.alpha : 1
  const br = opts.brightness !== undefined ? opts.brightness : 1
  ctx.font = opts.font
  try { ctx.letterSpacing = (opts.spacing && opts.spacing[0] ? opts.spacing[0] : 0) + 'px' } catch { /* 老内核无此属性 */ }
  ctx.textBaseline = 'middle'
  if (opts.opaquebackground) {
    const bg = opts.backgroundcolor || [0, 0, 0]
    const bgb = opts.backgroundbrightness !== undefined ? opts.backgroundbrightness : 1
    ctx.fillStyle = `rgba(${Math.round(bg[0] * 255 * bgb)},${Math.round(bg[1] * 255 * bgb)},${Math.round(bg[2] * 255 * bgb)},${alpha})`
    ctx.fillRect(0, 0, boxW, boxH)
  }
  const fill = (dx, dy, style) => {
    ctx.fillStyle = style
    for (const line of layout.lines) ctx.fillText(line.text, line.x + dx, line.y + layout.lineHeight / 2 + dy)
  }
  if (opts.castshadow) {
    const off = Math.max(1, (opts.pointsize || 24) / 10)
    fill(off, off, `rgba(0,0,0,${alpha * 0.75})`)
  }
  fill(0, 0, `rgba(${Math.round(color[0] * 255 * br)},${Math.round(color[1] * 255 * br)},${Math.round(color[2] * 255 * br)},${alpha})`)
}
