import { getEntry } from '../pkg/container.js'
// 解析效果的 material 链：effects/<name>/effect.json → materials/effects/*.json 的 passes
// 产出 layer.effects[i] 的 { materialPasses, fbos, binds }，供通用 pass 管线使用。

/**
 * [we-scene patch] WE 的数据文件普遍带**尾逗号**（其引擎的 JSON 解析器容忍），
 * 严格 JSON.parse 会抛错。效果文件、材质文档（materials/*.json）、粒子配置都会遇到
 * ——fantasticcar 的 `materials/car/glass.json` 就是尾逗号，严格解析下整个 Car 模型
 * 图层被丢弃（「model 'Car' 失败: Expected double-quoted property name…」）。
 *
 * 只在严格解析失败时尝试「去尾逗号」，合法文件原样返回；正则只匹配紧贴 }/] 的逗号，
 * WE 数据里不会出现在字符串值中。**唯一实现**：效果链、材质文档、粒子都要用它，
 * 各写一份迟早会漂。
 */
export function parseJsonTolerant(text) {
  try {
    return JSON.parse(text)
  } catch {
    /* 继续放宽 */
  }
  const noTrailingComma = text.replace(/,(\s*[}\]])/g, '$1')
  try {
    return JSON.parse(noTrailingComma)
  } catch {
    /* 继续放宽 */
  }
  // 再放宽一档：**JS 风格注释**。WE 编辑器保存的数据里确实有 ——
  // fantasticcar/materials/car/glass.json 第 6 行是 `//"cullmode": "nocull",`
  // （作者注释掉一整行），严格解析与「只去尾逗号」都过不了。
  try {
    return JSON.parse(stripJsonComments(text))
  } catch {
    return JSON.parse(stripJsonComments(noTrailingComma))
  }
}

/**
 * 剥掉 JSON 文本里的 `//` 行注释与 `/* *​/` 块注释，**字符串内原样保留**。
 * 只在严格解析失败后作为兜底使用（见 parseJsonTolerant）。
 */
function stripJsonComments(src) {
  let out = ''
  let inStr = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (inStr) {
      out += ch
      if (ch === '\\') {
        out += src[i + 1] ?? ''
        i++
      } else if (ch === '"') {
        inStr = false
      }
      continue
    }
    if (ch === '"') {
      inStr = true
      out += ch
      continue
    }
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++
      out += '\n'
      continue
    }
    if (ch === '/' && src[i + 1] === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++
      i++
      continue
    }
    out += ch
  }
  return out
}

// 兼容旧名（本文件内部的调用点）
const parseEffectJson = parseJsonTolerant

/**
 * [we-scene patch issue #11] 效果链解析的诊断闸门。
 *
 * 本文件此前**每一处失败都是静默 return / 空 pass**：效果文件不在包内、JSON 解析
 * 失败、`passes[]` 直写 `shader`（漏了 material 那一层）、material 指向的文件不在
 * 包内 —— 四种写法都表现为「图层退回内置材质的纯色块」，作者看不出是字段层数写错
 * 还是 shader/贴图名写错，只能逐项试。
 *
 * 闸门语义：
 *   - 同一个 (effect 文件, pass 序号, 类别) 只报一次 —— 本函数在装配期与热更期各跑
 *     一遍，同一张壁纸也会挂在多个图层上，不去重就是同一条刷屏；
 *   - 诊断文案必须**指到具体文件与字段层数**，而不是「效果没生效」。
 */
const _reportedEffectDiag = new Set()
const REPORT_CAP = 400
function diagOnce(onDiag, key, msg) {
  if (typeof onDiag !== 'function') return
  if (_reportedEffectDiag.has(key)) return
  if (_reportedEffectDiag.size < REPORT_CAP) _reportedEffectDiag.add(key)
  onDiag(msg)
}

/**
 * [we-scene patch issue #11] `materials/util/*` 是 WE **引擎内置**材质的命名空间
 * （与 `models/util/*` 同一约定，见本文件 BUILTIN_MATERIALS）：它们随引擎发行、
 * 不随壁纸 pkg 走，本仓也刻意不把官方材质 JSON 喂进运行时（见 renderer/src/local-assets.ts
 * 的「消费面」说明）。所以「不在包内」在这一族里是**预期状态**，不是作者写错了 ——
 * 报出来只会在用到它们的真壁纸上刷无关噪声（实测 3281559867 / 3505674701 各一处，
 * 都被 verify-effects 的「全库零误报」判据逮到）。
 * 其它路径缺失才是真的写错（或 pkg 不完整），照报。
 */
function isBuiltinAssetPath(p) {
  return typeof p === 'string' && (p.startsWith('materials/util/') || p.startsWith('models/util/'))
}

// pkg: parsePkg 结果；effect: scene.json 的效果条目（file/passes/visible）
// onMaterialDoc: 可选回调。效果链里的材质是**独立文档**（materials/*.json），其中的
//   `{"user":"名"}` 绑定不在 layer.srcObject 树里，resolveUserProps 够不到；宿主用它
//   把文档登记下来，装配期与热更期各解析一次（见 scene-mount 的 materialDocs）。
// onDiag: 可选回调（issue #11）。解析失败/字段不认识时上报一条可执行的诊断。
export function resolveEffectChain(pkg, effect, readText, onMaterialDoc, onDiag) {
  // [we-scene patch] **合成条目不是文件**：attachLayerMaterialEffect 为「非内置 shader
  // 的层材质」造的条目（file 恒为空串、layerMaterial:true），materialPasses/fbos 在造
  // 的时候就已经填好，没有任何文件可按。此前它照样走下面「文件不在包内」分支，于是
  // **每一层自定义图像 shader 都刷一条假诊断**（「effect (未命名): 效果文件不在包内」），
  // 与真缺失混在一起，会污染 verify-effects「全库零误报」这条判据（官方内置 defaultprojects
  // 的 2D 工程每层都会刷）。
  if (effect && effect.layerMaterial === true) return
  const file = (effect && effect.file) || '(未命名)'
  const entry = getEntry(pkg, effect.file)
  if (entry === null) {
    diagOnce(onDiag, `${file}|missing-effect`, `effect ${file}: 效果文件不在包内，整条效果链已跳过（检查 scene.json 里 effects[].file 与 pkg 内的实际路径大小写）`)
    return
  }
  let ej
  try {
    ej = parseEffectJson(readText(entry))
  } catch (e) {
    diagOnce(onDiag, `${file}|bad-json`, `effect ${file}: JSON 解析失败（${(e && e.message) || e}），整条效果链已跳过`)
    return
  }
  effect.fbos = ej.fbos || []
  effect.materialPasses = (ej.passes || []).map((p, pi) => {
    if (!p.material) {
      // [we-scene patch issue #11] 既没有 `material` 也没有 `command` —— 最典型的
      // 是把材质里的写法（`passes[].shader`）直接搬到了效果文件里。WE 的效果文件是
      // **两段式**：效果文件写 `material`，真正的 `shader` 写在 material 指向的材质
      // JSON 里（官方形态见 local-assets/effects/cursorripple/effect.json）。
      // 旧代码把这一支一律当命令 pass（copy），于是 `{shader:...}` 变成 target=null
      // 的 copy → 整条链什么都不画，且无任何输出。
      if (p.command !== 'copy' && p.command !== 'swap') {
        const hint = p.shader
          ? `检测到直写 shader="${p.shader}" —— 效果文件不支持直接写 shader，` +
            `要写在 material 指向的材质里（形如 {"passes":[{"material":"materials/effects/x.json"}]}，` +
            `材质文件内才是 {"passes":[{"shader":"effects/x"}]}）`
          : '该 pass 既没有 material 也不是 copy/swap 命令 pass'
        diagOnce(
          onDiag,
          `${file}|pass${pi}|unrecognized`,
          `effect ${file}: pass ${pi} 未识别（${hint}），已按空 pass 处理`,
        )
      }
      // 无 material 的命令 pass：copy（source→target 整块拷）或 swap（交换两个 FBO）。
      // [we-scene patch] copy 命令 pass：`{"command":"copy","target":X,"source":Y}`。
      // [we-scene patch] 必须带上 source —— 此前只存 target，渲染器又完全没实现 copy，
      // 于是 motionblur 这类**帧累积**效果拿不到「上一帧」：
      // accumulation pass 读的 _rt_FullCompoBuffer1 永远没被写过，
      // `mix(pastAlbedo, albedo, rate)` 自我反馈直到饱和 ——
      // 表现为画面竖向拉丝并冲成全白（1444077782 实测 74% 像素过曝、只剩 14% 彩色）。
      // copy 画完后还必须 TRIANGLES 6：PASS_QUAD 是三角形列表，STRIP 4 会只拷半块对角。
      // [we-scene patch] swap（fluidsimulation 末尾乒乓）：`{"command":"swap",
      // "source":A,"target":B}` 语义是交换两个 FBO 名指向的缓冲，不拷像素。
      if (p.command === 'swap') {
        return {
          shader: null,
          copyCommand: false,
          swapCommand: true,
          target: p.target || null,
          source: p.source || null,
          binds: p.bind || [],
          blending: 'normal',
          textures: [],
          combos: {},
          constants: {},
        }
      }
      return {
        shader: null,
        copyCommand: true,
        swapCommand: false,
        target: p.target || null,
        source: p.source || null,
        binds: p.bind || [],
        blending: 'normal',
        textures: [],
        combos: {},
        constants: {},
      }
    }
    const me = getEntry(pkg, p.material)
    if (me === null) {
      // [we-scene patch issue #11] material 指向的文件不在包内 → 旧代码返回一个
      // `shader: null` 的空 pass（什么都不画），且一声不吭。内置命名空间除外
      // （见 isBuiltinAssetPath：那是预期状态，报出来是噪声）。
      if (!isBuiltinAssetPath(p.material)) {
        diagOnce(
          onDiag,
          `${file}|pass${pi}|missing-material`,
          `effect ${file}: pass ${pi} 的材质 ${p.material} 不在包内，该 pass 已跳过（整条链可能因此什么都不画）`,
        )
      }
      return { shader: null, copyCommand: false, target: p.target || null, binds: p.bind || [], blending: 'normal', textures: [], combos: {}, constants: {} }
    }
    let mj
    try {
      mj = parseEffectJson(readText(me))
    } catch (e) {
      // 材质 JSON 坏掉此前同样静默。
      diagOnce(onDiag, `${file}|pass${pi}|bad-material-json`, `effect ${file}: pass ${pi} 的材质 ${p.material} JSON 解析失败（${(e && e.message) || e}），该 pass 已跳过`)
      return { shader: null, copyCommand: false, target: p.target || null, binds: p.bind || [], blending: 'normal', textures: [], combos: {}, constants: {} }
    }
    // 材质文档交给宿主登记 + 解析其 {user} 绑定（见函数头注释）
    if (typeof onMaterialDoc === 'function') onMaterialDoc(mj)
    const mp = (mj.passes && mj.passes[0]) || {}
    if (!mp.shader) {
      // 材质存在但里面没有 shader：旧代码给出 `shader: null` 的空 pass，
      // 图层退回内置材质 —— 作者只会看到「效果没生效」。
      diagOnce(
        onDiag,
        `${file}|pass${pi}|material-no-shader`,
        `effect ${file}: pass ${pi} 的材质 ${p.material} 里没有 passes[0].shader，该 pass 已跳过`,
      )
    }
    return {
      shader: mp.shader || null,
      copyCommand: false,
      target: p.target || null,
      binds: p.bind || [],
      blending: mp.blending || 'normal',
      textures: mp.textures || [],
      combos: mp.combos || {},
      constants: mp.constantshadervalues || {},
    }
  })
}

// 内置模型（pkg 内没有 models/util/*）：返回内置 material 路径或 null
export const BUILTIN_MODELS = {
  'models/util/solidlayer.json': { material: 'materials/util/solidlayer.json' },
  // composelayer 本身无内容，但作者会给它挂图层效果（音频可视化 = 空容器 +
  // 示波器/音频条效果是工坊标准做法，全库 186 处）。注册后 main.ts 的图层循环
  // 才会走到效果链解析，渲染器按「透明画布」跑该容器自己的效果。
  'models/util/composelayer.json': { material: 'materials/util/solidlayer.json' },
  // pkg 里没有 models/util/fullscreenlayer.json。不注册则装配循环
  // `if (!modelEntry) continue`，挂在上面的 waterripple/pulse 永远不解析
  // （973101892「dark blue galexy」整张不会动）。
  'models/util/fullscreenlayer.json': { material: 'materials/util/solidlayer.json' },
  'models/util/projectlayer.json': { material: 'materials/util/solidlayer.json' },
}

// genericimage* / sprite / flat 是 WE 内置反照率直通，本仓库用 copy pass 画
// textures[0] 即可。作者写在 pkg 里的图层材质 shader（flowimage、工坊 tint）
// 必须挂进效果链，否则只剩一张静图 —— 833227004「会动的星云」完全不动。
export function isBuiltinAlbedoShader(name) {
  if (!name || typeof name !== 'string') return true
  const n = name.toLowerCase()
  return n === 'generic' || n === 'sprite' || n === 'flat' || n.startsWith('genericimage')
}

/**
 * [we-scene patch 2026-10-03] **引擎内置网格 shader**（WE 在渲染器内部实现的网格着色）：
 * `generic` / `genericimage*` / `generic4` / `genericparticle` / `foliage4` /
 * `puppettexturechannels` / `flat` / `sprite`。
 *
 * 本仓对**模型层**的这几个 shader 是在通用网格程序里原生实现的（`u_tex × u_light*`，
 * 其中 3D 网格的环境光折 K=0.4 是按官方出帧标定过的）。F13 的「模型走材质 shader」
 * 路径必须把它们排除在外 —— 工坊语料里模型材质用 `generic4` 的有 **252 处**，
 * 误接等于把整批壁纸的观感换掉。
 */
export function isEngineMeshShader(name) {
  if (!name || typeof name !== 'string') return true
  const n = name.toLowerCase()
  return (
    n.indexOf('generic') === 0 ||
    n === 'foliage4' ||
    n === 'puppettexturechannels' ||
    n === 'sprite' ||
    n === 'flat'
  )
}

/**
 * [we-scene patch 2026-10-03] **模型材质是否交给「材质自己的 shader 画网格」这条路径**（F34）。
 *
 * F13 的原始判据是 `!isEngineMeshShader(name)` —— 引擎内置族一律走本仓的通用网格程序。
 * 这条对 `generic4`（工坊 276 处模型材质）是硬要求（误接会换掉整批壁纸的观感），
 * 但对 **`generic`** 恰恰相反：它是官方那套「带 lightmap / normalmap / 反射槽 + 场景点光」
 * 的**模型**着色器，全库用得极少 —— 官方内置里只有 arsenal 的 6 个材质，工坊 366 包里只有 1 个。
 * 不接就等于把这些材质的第二套 UV、光照图、金属度粗糙度、点光与反射**整条丢掉**：
 * 实测 arsenal「手枪一片白、桌面没有明暗」（用户报的「贴图/材质/光照都没出来」）。
 *
 * 注意 `genericimage*` / `generic4` / `foliage4` / `puppettexturechannels` / `sprite` / `flat`
 * 仍然排除（前四个是 2D 图层族，后两个是引擎内建直通）。
 */
export function canUseMaterialMeshPath(name) {
  if (!name || typeof name !== 'string') return false
  if (name.toLowerCase() === 'generic') return true
  return !isEngineMeshShader(name)
}

// 把图层 material pass 变成效果链的第一趟。渲染器已有 GPU pass 管线
// （g_Time / 多槽贴图 / constantshadervalues → material 名），不必另开一条。
export function attachLayerMaterialEffect(layer, pass) {
  if (!layer || !pass || !pass.shader || isBuiltinAlbedoShader(pass.shader)) return false
  layer.effects = layer.effects || []
  if (layer.effects.some((e) => e.layerMaterial)) return false
  layer.effects.unshift({
    file: '',
    name: '_layerMaterial',
    visible: true,
    layerMaterial: true,
    passes: [{
      combos: pass.combos || {},
      constantshadervalues: pass.constantshadervalues || {},
      textures: pass.textures || [],
    }],
    materialPasses: [{
      shader: pass.shader,
      copyCommand: false,
      target: null,
      binds: [],
      blending: pass.blending || 'normal',
      textures: pass.textures || [],
      combos: pass.combos || {},
      constants: pass.constantshadervalues || {},
    }],
    fbos: [],
  })
  return true
}

// 内置 material（pkg 内没有 materials/util/*）：返回 passes 定义或 null
export const BUILTIN_MATERIALS = {
  'materials/util/solidlayer.json': {
    passes: [{ shader: 'flat', blending: 'translucent', cullmode: 'nocull', depthtest: 'disabled', depthwrite: 'disabled', textures: [], combos: {} }],
  },
}
