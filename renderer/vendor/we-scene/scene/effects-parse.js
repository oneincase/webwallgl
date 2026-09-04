import { getEntry } from '../pkg/container.js'
// 解析效果的 material 链：effects/<name>/effect.json → materials/effects/*.json 的 passes
// 产出 layer.effects[i] 的 { materialPasses, fbos, binds }，供通用 pass 管线使用。

// pkg: parsePkg 结果；effect: scene.json 的效果条目（file/passes/visible）
export function resolveEffectChain(pkg, effect, readText) {
  const entry = getEntry(pkg, effect.file)
  if (entry === null) return
  let ej
  try {
    ej = JSON.parse(readText(entry))
  } catch (e) {
    return
  }
  effect.fbos = ej.fbos || []
  effect.materialPasses = (ej.passes || []).map((p) => {
    if (!p.material) {
      // 无 material 的 copy 命令 pass：`{"command":"copy","target":X,"source":Y}`。
      // [we-scene patch] 必须带上 source —— 此前只存 target，渲染器又完全没实现 copy，
      // 于是 motionblur 这类**帧累积**效果拿不到「上一帧」：
      // accumulation pass 读的 _rt_FullCompoBuffer1 永远没被写过，
      // `mix(pastAlbedo, albedo, rate)` 自我反馈直到饱和 ——
      // 表现为画面竖向拉丝并冲成全白（1444077782 实测 74% 像素过曝、只剩 14% 彩色）。
      // copy 画完后还必须 TRIANGLES 6：PASS_QUAD 是三角形列表，STRIP 4 会只拷半块对角。
      return {
        shader: null,
        copyCommand: true,
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
      return { shader: null, copyCommand: false, target: p.target || null, binds: p.bind || [], blending: 'normal', textures: [], combos: {}, constants: {} }
    }
    const mj = JSON.parse(readText(me))
    const mp = (mj.passes && mj.passes[0]) || {}
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
