// [we-scene patch] WE 内置渐变（materials/gradient/*）的程序化复刻。
//
// 为什么需要：shimmer / lightshafts / procedural_noise / blur / blendgradient 等
// 效果的 gradient map 槽走 sampler 声明或实例 textures 里的 `gradient/...` 名，
// 这些**不在壁纸 pkg 里** —— 是 Wallpaper Engine 安装目录自带的公共资源。缺它时
// 渲染端落 whiteTex（1×1 白），两类退化：
//   1. shimmer：`albedo.rgb = mix(albedo.rgb, effectAlbedo, mask * shimmerColor)`，
//      shimmerColor 恒 (1,1,1) → 权重恒 1 → 「从左向右扫过的亮暗带」退化成整层
//      恒定加性染色（3737267090；全库 sampler default 扫描 2026-09-21）；
//   2. blur 的径向蒙版 / blendgradient 的渐变掩码：蒙版 .r 恒 1 → 「中心清晰、
//      边缘模糊」变成整屏全模糊（3047405322）、封面渐显变二值（2134765860 /
//      2370927443 的媒体组件）。
// 全库引用面（2026-09-21 全量扫描，效果 shader sampler default + 全部材质
// textures + scene.json 全文）：gradient_*/13 张 + blend_gradient(_reverse)/3 张，
// 除这两族外没有其它无供给的引擎贴图引用。
//
// 合规（docs/COMPLIANCE.md「零内嵌第三方素材」）：本表是**测量的参数**——
//   - gradient_*（64×2 1D 色带）：每 4px 取锚点、误差峰自适应补点，线性插值
//     逐点误差 ≤16/255；
//   - blend_gradient(_reverse)（256² 径向坡）：径向对称，剖面每 8px 取锚
//     （24 锚），插值误差 ≤1/255；reverse 实测恰为反相（偏差 0）。
// 都是参数表不是官方字节拷贝。本机有原版 .tex 时 scene-mount 的 ensureLocalAsset
// 先行命中（local-assets.ts provider），这里的程序化产物只是没有素材时的兜底
// （与 particle-textures.js 同一约定）。
//
// 实现约定（对齐 particle-textures.js）：
//   - 零 import、确定性（无随机）：Node 离线校验与浏览器渲染逐像素一致；
//   - 返回 { width, height, rgba: Uint8Array }，直接喂 makeTextureMip；
//   - R8 官方源（blend_* / toon）按 pkg/tex-codecs.js fromR8 的展开约定出灰度
//     RGB（r=g=b=灰度, a=255），与 .tex 解码路径产物同构。

const RAMP_W = 64
const RAMP_H = 2
const RADIAL_SIZE = 256
const RADIAL_MAX_R = 181 // 中心到角像素的距离（√2 × 127.5），剖面在此封顶

// ---- 1D 色带（gradient/gradient_<variant>，官方 64×2，两行相同）----
// variant → { r8, stops: [[x, r, g, b], …] }。锚点表见文件头「合规」说明。
const GRADIENTS = {
  ferro_fluid: { r8: false, stops: [[0,0,0,0],[4,0,0,1],[8,0,0,0],[12,0,0,0],[16,0,0,0],[20,0,0,0],[24,0,0,0],[28,0,0,0],[32,0,0,5],[36,0,0,12],[40,9,3,23],[41,234,233,235],[42,243,242,243],[44,159,156,165],[46,74,69,85],[48,14,8,28],[52,0,0,9],[56,0,0,0],[60,0,0,0],[63,0,0,1]] },
  fire: { r8: false, stops: [[0,130,14,14],[4,142,11,12],[8,160,5,10],[12,180,0,7],[16,202,0,4],[20,223,0,1],[24,241,0,0],[28,254,0,0],[32,255,23,3],[36,255,63,10],[40,255,105,17],[44,255,126,20],[48,255,146,24],[52,254,164,27],[56,252,180,30],[60,251,194,32],[63,250,202,34]] },
  fire_2: { r8: false, stops: [[0,255,255,255],[2,255,255,255],[3,0,0,0],[4,0,0,0],[8,0,0,0],[12,0,0,0],[16,0,0,0],[20,0,0,0],[21,0,0,0],[22,52,33,16],[24,233,149,71],[26,248,152,72],[28,194,108,50],[30,142,66,28],[32,135,60,24],[36,135,60,22],[40,144,60,22],[44,155,62,22],[48,166,66,23],[52,166,66,23],[56,166,66,22],[60,118,47,15],[62,79,31,10],[63,32,12,4]] },
  fire_3: { r8: false, stops: [[0,18,10,10],[4,21,8,8],[8,26,6,6],[12,42,5,5],[16,102,10,10],[20,134,17,17],[24,130,23,23],[26,145,20,21],[28,182,5,13],[32,253,0,0],[36,255,39,2],[40,255,103,8],[44,254,167,19],[47,250,202,32],[48,248,219,56],[50,243,225,145],[51,241,225,169],[52,244,215,108],[53,250,204,34],[56,252,212,64],[60,254,231,147],[63,255,243,200]] },
  ghost_flame: { r8: false, stops: [[0,0,0,0],[4,0,0,0],[8,0,0,0],[12,2,0,1],[16,209,28,126],[17,183,24,110],[18,191,25,115],[20,74,10,44],[22,0,0,0],[24,0,0,0],[28,0,0,0],[32,0,0,0],[36,0,0,0],[40,19,2,20],[43,201,26,207],[44,231,60,235],[47,255,216,253],[48,223,226,252],[49,216,255,255],[52,25,244,255],[53,0,220,247],[56,0,103,117],[60,0,42,47],[63,0,8,9]] },
  ice: { r8: false, stops: [[0,114,190,255],[4,117,191,255],[8,121,193,255],[12,126,196,255],[16,132,199,255],[20,138,202,255],[24,145,205,255],[28,152,208,255],[32,158,211,255],[36,164,214,255],[40,170,216,255],[44,175,218,255],[48,178,220,255],[52,181,220,255],[56,182,220,255],[58,181,219,255],[60,146,194,255],[63,107,168,255]] },
  iridescent: { r8: false, stops: [[0,254,164,142],[4,254,164,139],[8,239,174,149],[12,210,187,172],[16,177,196,198],[20,134,189,226],[24,90,183,254],[28,75,175,254],[32,70,170,255],[36,80,159,255],[40,104,142,255],[44,139,126,255],[48,179,126,255],[52,164,130,253],[56,119,135,255],[60,102,162,255],[63,93,175,255]] },
  neon: { r8: false, stops: [[0,0,186,255],[4,0,186,255],[8,10,178,255],[12,40,153,255],[16,79,120,255],[20,122,83,255],[24,165,49,255],[28,205,21,255],[32,238,3,255],[36,255,1,248],[40,255,17,221],[44,255,47,184],[48,255,86,142],[52,255,129,99],[56,255,170,58],[60,255,205,24],[63,255,224,5]] },
  rainbow: { r8: false, stops: [[0,255,0,0],[4,255,0,94],[8,255,0,213],[10,255,0,253],[12,224,0,255],[16,117,0,255],[20,16,0,255],[22,0,13,255],[24,0,57,255],[28,0,170,255],[32,0,255,255],[36,0,255,165],[40,0,255,49],[42,0,255,7],[44,26,255,0],[48,144,255,0],[52,248,255,0],[54,255,232,0],[56,255,187,0],[60,255,80,0],[63,255,14,0]] },
  swamp: { r8: false, stops: [[0,60,36,50],[4,60,36,50],[8,60,36,50],[12,60,36,50],[16,58,46,61],[20,54,65,82],[24,50,87,108],[28,45,112,135],[32,42,135,159],[36,40,154,176],[40,41,167,182],[44,45,175,180],[48,51,179,171],[52,59,181,157],[56,66,181,141],[60,73,181,128],[63,76,182,121]] },
  swipe_dual: { r8: false, stops: [[0,0,0,0],[2,0,0,0],[4,76,76,76],[7,224,224,224],[8,255,255,255],[9,255,255,255],[10,0,0,0],[11,0,0,0],[12,245,245,245],[16,218,218,218],[20,183,183,183],[24,143,143,143],[28,102,102,102],[32,63,63,63],[36,29,29,30],[40,4,4,5],[44,0,0,0],[48,0,0,0],[52,0,0,0],[56,0,0,0],[60,0,0,0],[63,0,0,0]] },
  swipe_wide: { r8: false, stops: [[0,0,0,0],[2,0,0,0],[3,255,255,255],[4,255,255,255],[8,233,233,233],[12,201,201,201],[16,163,163,163],[20,122,122,122],[24,82,82,82],[28,45,45,45],[32,16,16,16],[36,0,0,0],[40,0,0,0],[44,0,0,0],[48,0,0,0],[52,0,0,0],[56,0,0,0],[60,0,0,0],[63,0,0,0]] },
  toon: { r8: true, stops: [[0,0,0,0],[4,0,0,0],[8,0,0,0],[12,0,0,0],[16,0,0,0],[20,0,0,0],[24,0,0,0],[28,0,0,0],[32,0,0,0],[36,0,0,0],[39,0,0,0],[40,255,255,255],[44,255,255,255],[48,255,255,255],[52,255,255,255],[56,255,255,255],[60,255,255,255],[63,255,255,255]] },
  toon_smooth: { r8: true, stops: [[0,0,0,0],[4,0,0,0],[8,0,0,0],[12,0,0,0],[16,1,1,1],[20,3,3,3],[24,6,6,6],[28,11,11,11],[32,17,17,17],[36,28,28,28],[38,34,34,34],[39,77,77,77],[40,165,165,165],[41,184,184,184],[44,197,197,197],[48,213,213,213],[52,227,227,227],[56,238,238,238],[60,248,248,248],[63,253,253,253]] },
}

// ---- 径向坡（gradient/blend_gradient[_reverse]，官方 256² R8 → 灰度）----
// 官方实测：径向对称、剖面在半径 181（=角像素距离）封顶 255；reverse 恰为反相。
// 锚点为 [半径px, 灰度]，插值误差 ≤1/255。
const RADIALS = {
  blend_gradient: { invert: false, stops: [[0,0],[8,6],[16,14],[24,23],[32,33],[40,44],[48,56],[56,68],[64,81],[72,95],[80,109],[88,123],[96,137],[104,151],[112,165],[120,178],[128,191],[136,203],[144,215],[152,226],[160,235],[168,244],[176,251],[181,254]] },
  blend_gradient_reverse: { invert: true, stops: [[0,0],[8,6],[16,14],[24,23],[32,33],[40,44],[48,56],[56,68],[64,81],[72,95],[80,109],[88,123],[96,137],[104,151],[112,165],[120,178],[128,191],[136,203],[144,215],[152,226],[160,235],[168,244],[176,251],[181,254]] },
}

const cache = new Map()
// 本机有原版素材时的覆盖接口（local-assets.ts 注入，与 sysTex / ptex 同构）：
// 命中即直接返回官方像素，程序化产物只是没有素材时的兜底。
let overrideProvider = null

/** 兜底接管：返回 {width,height,rgba} 或 null（null 则继续走内置锚点表）。 */
export function setGradientTextureProvider(provider) {
  overrideProvider = typeof provider === 'function' ? provider : null
}

/** 登记表全部键名（校验枚举用）。 */
export function listBuiltinGradientTextureNames() {
  return [
    ...Object.keys(GRADIENTS).map((v) => 'gradient/gradient_' + v),
    ...Object.keys(RADIALS).map((v) => 'gradient/' + v),
  ]
}

export function isBuiltinGradientTextureName(name) {
  return resolveName(name) !== null
}

// 名字解析：gradient/gradient_<variant>（1D 色带）或 gradient/blend_gradient[_reverse]
// （径向坡）。未登记返回 null。
function resolveName(name) {
  if (typeof name !== 'string') return null
  let m = /^gradient\/gradient_([a-z0-9_]+)$/.exec(name)
  if (m && GRADIENTS[m[1]]) return { kind: 'ramp', spec: GRADIENTS[m[1]] }
  m = /^gradient\/(blend_gradient(?:_reverse)?)$/.exec(name)
  if (m && RADIALS[m[1]]) return { kind: 'radial', spec: RADIALS[m[1]] }
  return null
}

function clampByte(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v
}

function rampAt(stops, x) {
  if (x <= stops[0][0]) return [stops[0][1], stops[0][2], stops[0][3]]
  const last = stops[stops.length - 1]
  if (x >= last[0]) return [last[1], last[2], last[3]]
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i]
    const b = stops[i + 1]
    if (x >= a[0] && x <= b[0]) {
      const t = b[0] === a[0] ? 0 : (x - a[0]) / (b[0] - a[0])
      return [
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
        a[3] + (b[3] - a[3]) * t,
      ]
    }
  }
  return [last[1], last[2], last[3]]
}

function scalarAt(stops, d) {
  if (d <= stops[0][0]) return stops[0][1]
  const last = stops[stops.length - 1]
  if (d >= last[0]) return last[1]
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i]
    const b = stops[i + 1]
    if (d >= a[0] && d <= b[0]) {
      const t = b[0] === a[0] ? 0 : (d - a[0]) / (b[0] - a[0])
      return a[1] + (b[1] - a[1]) * t
    }
  }
  return last[1]
}

function buildRamp(spec) {
  const rgba = new Uint8Array(RAMP_W * RAMP_H * 4)
  for (let y = 0; y < RAMP_H; y++) {
    const row = y * RAMP_W
    for (let x = 0; x < RAMP_W; x++) {
      const [r, g, b] = rampAt(spec.stops, x)
      const i = (row + x) * 4
      rgba[i] = clampByte(Math.round(r))
      rgba[i + 1] = clampByte(Math.round(g))
      rgba[i + 2] = clampByte(Math.round(b))
      rgba[i + 3] = 255
    }
  }
  return { width: RAMP_W, height: RAMP_H, rgba }
}

function buildRadial(spec) {
  const n = RADIAL_SIZE
  const rgba = new Uint8Array(n * n * 4)
  const c = (n - 1) / 2 // 127.5：与官方像素距离口径一致
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const d = Math.sqrt((x - c) * (x - c) + (y - c) * (y - c))
      let v = scalarAt(spec.stops, d)
      if (spec.invert) v = 255 - v
      const i = (y * n + x) * 4
      // R8 源：按 fromR8 展开约定出灰度 RGB、alpha 不透明
      rgba[i] = rgba[i + 1] = rgba[i + 2] = clampByte(Math.round(v))
      rgba[i + 3] = 255
    }
  }
  return { width: n, height: n, rgba }
}

/**
 * 程序化生成一条内置渐变。返回 { width, height, rgba }；未登记的名字返回 null
 * （调用方继续走其它来源）。
 */
export function buildBuiltinGradientTexture(name) {
  const resolved = resolveName(name)
  if (!resolved) return null
  const cached = cache.get(name)
  if (cached) return cached
  if (overrideProvider) {
    try {
      const t = overrideProvider(name)
      if (t && t.rgba) {
        cache.set(name, t)
        return t
      }
    } catch {
      /* 覆盖失败不阻断：继续走下面的锚点表复刻 */
    }
  }
  const t = resolved.kind === 'radial' ? buildRadial(resolved.spec) : buildRamp(resolved.spec)
  cache.set(name, t)
  return t
}
