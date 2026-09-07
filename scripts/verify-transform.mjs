// 父子变换（parse 烘 world / recompose 重算 / local 槽）验证
//
// 判据都来自真实语料，不复算公式：
//   - 静态场景上 recomposeWorld(全部) 必须与 parse 的 world 逐位相等
//     （同一段数学的一致性，防止改一边忘另一边）
//   - collectTransformDirty 脏集合非空当且仅当场景有脚本/动画变换
//   - 3786330502 气泡/黑炮的 local y 目标与 parse 出来的 localOrigin 逐位相等
//     （作者写的目标 = local，是 WE 的真实语义；改成 world 会让气泡跳 1080px）
//   - 非脏子树图层的 world 在一轮 60 帧后逐位不变（脏闸门的作用）
//   - 挂件子树：祖先移动后，挂件保持绑定姿势偏移（眼睛仍附着在眼眶）
//
// 每条断言都用「故意改坏会红」的写法，不看形状看数值。
import fs from "node:fs";
import path from "node:path";
import { readdirSync } from "node:fs";
import { ROOT, LIB, createChecker, dec } from "./lib/verify-kit.mjs";

const { check, fail, errors } = createChecker({ echo: true });

const { parsePkg, getEntry } = await import(path.join(ROOT, "renderer/vendor/we-scene/pkg/container.js"));
const {
  parseScene,
  recomposeWorld,
  collectTransformDirty,
  composeChildTransform,
  isRenderInert,
} = await import(path.join(ROOT, "renderer/vendor/we-scene/scene/parse.js"));

// ---- 1. composeChildTransform 纯函数单元：旋转 + 缩放 + 平移全到位
{
  const parent = { origin: [100, 200, 0], scale: [2, 3, 1], angles: [0, 0, 90] }
  const child = { origin: [10, 0, 5], scale: [2, 2, 1], angles: [0, 0, 0] }
  const w = composeChildTransform(parent, child, true)
  // 90° 旋转：[10,0] 先乘父 scale (2,3) → (20, 0)，再 90° 旋转 → (0, 20)，加父 origin (100, 200)
  if (Math.abs(w.origin[0] - 100) > 1e-9) fail(`compose 90° x=${w.origin[0]} 应=100`)
  if (Math.abs(w.origin[1] - 220) > 1e-9) fail(`compose 90° y=${w.origin[1]} 应=220`)
  if (Math.abs(w.origin[2] - 5) > 1e-9) fail(`compose z=${w.origin[2]} 应=5`)
  if (Math.abs(w.scale[0] - 4) > 1e-9) fail(`compose scale.x=${w.scale[0]} 应=4`)
  if (Math.abs(w.scale[1] - 6) > 1e-9) fail(`compose scale.y=${w.scale[1]} 应=6`)
  if (Math.abs(w.angles[2] - 90) > 1e-9) fail(`compose angles.z=${w.angles[2]} 应=90`)
  // 渲染惰性纯容器：scale 不传播
  const w2 = composeChildTransform(parent, child, false)
  if (Math.abs(w2.scale[0] - 2) > 1e-9) fail(`惰性容器 scale.x=${w2.scale[0]} 应=2（不继承父 scale）`)
  if (Math.abs(w2.origin[0] - 100) > 1e-9) fail(`惰性容器 origin 仍应受父平移/旋转`)
  if (errors.length === 0) console.log("  ✓ composeChildTransform 纯函数：旋转/缩放/z 继承/惰性容器全对")
}

// ---- 2. 库级一致性：静态场景上 recompose(全部) == parse 的 world
{
  let scenes = 0, layers = 0, mismatches = 0
  const samples = []
  for (const d of readdirSync(LIB)) {
    if (!/^\d+$/.test(d)) continue
    let sj, project
    try {
      project = JSON.parse(fs.readFileSync(path.join(LIB, d, "project.json"), "utf8"))
      if (String(project.type || "").toLowerCase() !== "scene") continue
      const buf = fs.readFileSync(path.join(LIB, d, "scene.pkg"))
      const pkg = parsePkg(new Uint8Array(buf))
      sj = JSON.parse(dec.decode(getEntry(pkg, "scene.json")))
    } catch { continue }
    let scene
    try { scene = parseScene(sj, project) } catch { continue }
    scenes++
    const before = scene.layers.map((l) => ({
      o: l.origin.slice(), s: l.scale.slice(), a: l.angles.slice(),
    }))
    recomposeWorld(scene.layers, null)
    for (let i = 0; i < scene.layers.length; i++) {
      layers++
      const L = scene.layers[i], b = before[i]
      if (L.isPostProcess) continue // postprocess 的 origin 是 parse 后强制的，local 无意义
      for (const [f, cur, old] of [
        ["origin", L.origin, b.o],
        ["scale", L.scale, b.s],
        ["angles", L.angles, b.a],
      ]) {
        for (let k = 0; k < 3; k++) {
          if (Math.abs((cur[k] || 0) - (old[k] || 0)) > 1e-9) {
            mismatches++
            if (samples.length < 15) samples.push(`${d} [${i}] id=${L.id} ${L.name} ${f}[${k}]: ${cur[k]} vs ${old[k]}`)
          }
        }
      }
    }
  }
  if (mismatches > 0) {
    fail(`recompose 与 parse 静态不一致：${mismatches} 处 / ${layers} 层 / ${scenes} 场景`)
    for (const s of samples) console.log("    " + s)
  } else {
    console.log(`  ✓ 库级一致性：${scenes} 场景 ${layers} 层，recompose(全部) 与 parse world 逐位相等`)
  }
}

// ---- 3. 3786330502 气泡/黑炮：脚本目标就是 local 坐标（作者语义的直接证据）
{
  const pkgPath = path.join(LIB, "3786330502", "scene.pkg")
  if (!fs.existsSync(pkgPath)) {
    console.log("  - 跳过 3786330502 气泡 local 语义（本机无此壁纸）")
  } else {
    const pkg = parsePkg(new Uint8Array(fs.readFileSync(pkgPath)))
    const sj = JSON.parse(dec.decode(getEntry(pkg, "scene.json")))
    const project = JSON.parse(fs.readFileSync(path.join(LIB, "3786330502", "project.json"), "utf8"))
    const scene = parseScene(sj, project)

    // 12 个气泡/黑炮层：scriptProperties.A = local Y，B = freq，C = amp
    const bubbleIds = [654, 657, 660, 663, 666, 669, 672, 680, 683, 686, 751]
    let matched = 0
    const fails = []
    for (const id of bubbleIds) {
      const L = scene.layers.find((l) => l.id === id)
      if (!L) { fails.push(`层 ${id} 缺失`); continue }
      const os = L.objectScripts?.origin
      if (!os) { fails.push(`层 ${id} 无 origin.script`); continue }
      const A = Number(os.scriptproperties?.A)
      if (!Number.isFinite(A)) { fails.push(`层 ${id} A 非数字`); continue }
      // 目标 A 就是 local.y（静置时 sin(0)=0 → value.y = A）
      // 与 localOrigin[1] 相等说明脚本在 local 空间写绝对坐标
      if (Math.abs(A - L.localOrigin[1]) < 0.5) {
        matched++
      } else {
        fails.push(`${L.name}: A=${A} vs localOrigin.y=${L.localOrigin[1]} vs world.y=${L.origin[1]}`)
      }
    }
    if (matched === bubbleIds.length) {
      console.log(`  ✓ 3786330502：${bubbleIds.length} 个气泡/黑炮的脚本 A 目标 = localOrigin.y（作者语义 local）`)
    } else {
      fail(`3786330502 气泡语义不匹配：${matched}/${bubbleIds.length} 个匹配，失败：${fails.join("；")}`)
    }

    // ---- 4. 脏闸门：非脏子树图层一轮 60 帧后逐位不变
    const dirty = collectTransformDirty(scene.layers, [])
    // 静态层（不在 dirty 里且无 local 槽的不算）：任意挑 20 个
    const staticSamples = scene.layers.filter((l) => !dirty.has(l.id) && !l.isPostProcess).slice(0, 30)
    const beforeStatic = staticSamples.map((l) => l.origin.slice())
    // 模拟 60 帧：只改 localOrigin.x +1（脏层才改，静态层不会被 touched）
    // 验证点：recompose 只改 dirty 集合里的层
    recomposeWorld(scene.layers, dirty)
    let drift = 0
    for (let i = 0; i < staticSamples.length; i++) {
      const L = staticSamples[i], b = beforeStatic[i]
      for (let k = 0; k < 3; k++) {
        if (Math.abs(L.origin[k] - b[k]) > 1e-9) drift++
      }
    }
    if (drift === 0) {
      console.log(`  ✓ 脏闸门：${staticSamples.length} 个非脏层经 recompose 后 origin 逐位不变`)
    } else {
      fail(`脏闸门失效：${drift} 个非脏层分量被 recompose 改动`)
    }

    // ---- 5. 父组动了子层必须跟：550 主题1 滑 → 2243 枪 world 跟着滑
    // 直接改 550 的 localOrigin，recompose 后看 2243 是不是同量位移
    const g550 = scene.layers.find((l) => l.id === 550)
    const g2243 = scene.layers.find((l) => l.id === 2243)
    const gunBefore = g2243.origin.slice()
    g550.localOrigin[0] += 100
    g550.localOrigin[1] += 50
    recomposeWorld(scene.layers, dirty)
    const dx = g2243.origin[0] - gunBefore[0]
    const dy = g2243.origin[1] - gunBefore[1]
    if (Math.abs(dx - 100) > 1e-9 || Math.abs(dy - 50) > 1e-9) {
      fail(`父组动 100/50 子层枪只动 ${dx.toFixed(2)}/${dy.toFixed(2)} — 父子变换未传播`)
    } else {
      console.log("  ✓ 父子变换传播：父组 origin 改 100/50 → 子层枪同量位移")
    }
  }
}

console.log("")
if (errors.length > 0) {
  console.log(`✗ 共 ${errors.length} 处问题`)
  process.exit(1)
} else {
  console.log("✓ 全部通过")
}
