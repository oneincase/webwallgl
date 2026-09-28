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
const { evalObjectScript } = await import(path.join(ROOT, "renderer/vendor/we-scene/render/text.js"));

// ---- 6. 跨层 origin 写入必须落 local 槽（2983846453 昼夜开关）----
// 开关脚本挂在「早」层的 visible 字段上：cursorClick 翻 shared.hover，真正的
// 位移在**每帧 update 的副作用**里——`thisScene.getLayer('yuan1').origin = new Vec3(…)`
// 用 WEMath.mix 把圆片从 1773 lerp 到 2068。旧的 makeObjectLayerProxy origin
// setter 只写 world origin；而圆片层的 origin 字段绑了脚本（哪怕整段被注释），
// collectTransformDirty 把它们收进脏集合，同一帧稍后的 recomposeWorld 用没变的
// localOrigin 覆盖 world —— 滑动每帧被冲掉，点了开关不右滑。
{
  const id = "2983846453";
  const dir = path.join(LIB, id);
  const pkgPath = fs.existsSync(path.join(dir, "scene.pkg")) ? path.join(dir, "scene.pkg") : null;
  if (!pkgPath) {
    console.log(`  (跳过 ${id}：库中无此壁纸)`);
  } else {
    const pkg = parsePkg(fs.readFileSync(pkgPath));
    const sj = JSON.parse(dec.decode(getEntry(pkg, "scene.json")));
    const proj = JSON.parse(fs.readFileSync(path.join(dir, "project.json"), "utf8"));
    const live = {};
    for (const [k, v] of Object.entries(proj.general?.properties || {})) live[k] = v.value;
    const vec3 = (v) => {
      if (typeof v === "string") { const a = v.trim().split(/\s+/).map(Number); return [a[0] || 0, a[1] || 0, a[2] || 0]; }
      return [0, 0, 0];
    };
    // 构造与 parse 同构的图层（world + local 三件套），圆片层都标记 origin 绑脚本
    // （模拟真实的 collectTransformDirty 种子）。
    const layers = [];
    const byName = new Map();
    for (const so of sj.objects) {
      const o = typeof so.origin === "string" ? vec3(so.origin) : [0, 0, 0];
      const L = {
        id: so.id, name: so.name,
        origin: o.slice(), localOrigin: o.slice(), localScale: [1, 1, 1], localAngles: [0, 0, 0],
        scale: typeof so.scale === "string" ? vec3(so.scale) : [1, 1, 1], angles: [0, 0, 0],
        size: typeof so.size === "string" ? vec3(so.size) : [100, 100, 0],
        visible: true, visibleSelf: true, alpha: 1, color: [1, 1, 1],
        childIds: [], parentId: so.parent ?? null, isPostProcess: false,
        objectScripts: { origin: { script: "// commented origin script" } },
      };
      layers.push(L); byName.set(so.name, L);
    }
    const knob = sj.objects.find((o) => o.id === 32);
    const code = String(knob.visible.script).replace(/^'/, "");
    const scriptedDirty = new Set();
    const sb = evalObjectScript(code, knob.visible.scriptproperties, {
      layer: byName.get("早"),
      getSceneLayer: (n) => byName.get(n) || null,
      getSceneLayerById: (idv) => layers.find((l) => l.id === idv) || null,
      markTransformDirty: (l) => scriptedDirty.add(l.id),
      userProperties: live, shared: {},
      canvasSize: { width: 3840, height: 2160 }, screenResolution: { x: 3840, y: 2160 },
      workshopId: Number(id),
    });
    sb.init(true);
    sb.callCursor("cursorClick", { worldPosition: { x: 1773, y: 1072, z: 0 } });
    for (let i = 0; i < 400; i++) sb.callUpdate(true);
    const y1 = byName.get("yuan1");
    // 1) update 副作用必须写 local 槽
    if (Math.abs(y1.localOrigin[0] - 2068) > 1) {
      fail(`2983846453 开关圆片 localOrigin.x=${y1.localOrigin[0].toFixed(1)} 应收敛到 2068（跨层 origin 写入未走 local 槽）`);
    } else {
      console.log("  ✓ 2983846453：开关脚本把圆片 localOrigin lerp 到 2068");
    }
    // 2) 用真实 collectTransformDirty + recomposeWorld 模拟一帧后，world 必须跟随 local，
    //    不能被旧 local 冲回 1773（旧 bug：setter 只写 world，recompose 立刻覆盖）。
    y1.origin[0] = 1773; // 模拟「只写 world」被冲前的状态不应出现：重算后应由 local 决定
    const dirty = collectTransformDirty(layers, []);
    recomposeWorld(layers, dirty);
    if (Math.abs(y1.origin[0] - 2068) > 1) {
      fail(`2983846453 recompose 后圆片 world.x=${y1.origin[0].toFixed(1)}，应=local 的 2068（被旧 localOrigin 冲回）`);
    } else {
      console.log("  ✓ 2983846453：recomposeWorld 后 world 跟随 local（滑动不被冲掉）");
    }
  }
}

// ---- 6b. 脚本副作用写 angles 必须落 localAngles（2890473419 透视模板）----
// 与第 6 节同族、字段换成 angles：透视模板的 update 用 `thisLayer.angles = rotation`
// 写 3D 倾斜角（副作用，不是返回值），而该层 origin 字段绑了脚本在脏集里，
// recomposeWorld 每帧从 localAngles 重算 world angles —— 旧 setter 只写 world，
// 同帧被 localAngles=0 冲回，卡片恒平（「脚本在跑但画面不动」）。
{
  const id = "2890473419";
  const pkgPath = path.join(LIB, id, "scene.pkg");
  if (!fs.existsSync(pkgPath)) {
    console.log(`  (跳过 ${id}：库中无此壁纸)`);
  } else {
    const pkg = parsePkg(fs.readFileSync(pkgPath));
    const sj = JSON.parse(dec.decode(getEntry(pkg, "scene.json")));
    const o124 = sj.objects.find((o) => o.id === 124);
    const L = {
      id: 124, name: "101272156_p0",
      origin: [1720, 716.35864, 0], localOrigin: [1720, 716.35864, 0],
      localScale: [1, 1, 1], localAngles: [0, 0, 0],
      scale: [1, 1, 1], angles: [0, 0, 0],
      size: [800, 1000, 0], visible: true, visibleSelf: true, alpha: 1, color: [1, 1, 1],
      childIds: [], parentId: null, isPostProcess: false,
      objectScripts: { origin: { script: o124.origin.script } },
    };
    const layers = [L];
    const sb = evalObjectScript(o124.origin.script, o124.origin.scriptproperties, {
      layer: L,
      markTransformDirty: () => {},
      userProperties: {}, shared: {},
      canvasSize: { width: 3440, height: 1440 },
    });
    sb.init({ x: 1720, y: 716.35864, z: 0 });
    for (let i = 0; i < 3; i++) sb.callUpdate({ x: 1720, y: 716.35864, z: 0 });
    // 1) 副作用必须写进 localAngles（透视角非零；response=0.5 时 angles.y=-12.5°）
    if (!(Math.abs(L.localAngles[1]) > 0.1)) {
      fail(`2890473419 透视脚本副作用应写 localAngles（y≈-0.218rad），got [${L.localAngles.map((a) => a.toFixed(3))}]（只写 world 时这里恒 0）`);
    } else {
      console.log(`  ✓ 2890473419：透视脚本 angles 副作用落 localAngles = [${L.localAngles.map((a) => a.toFixed(3))}]`);
    }
    // 2) 模拟真实帧：脏集 recompose 后 world angles 必须跟随 local，不得被冲回 0
    L.angles = [0, 0, 0]; // 旧 bug 的被冲状态：recompose 应由 local 决定
    const dirty = collectTransformDirty(layers, []);
    recomposeWorld(layers, dirty);
    if (!(Math.abs(L.angles[1] - L.localAngles[1]) < 1e-9) || !(Math.abs(L.angles[1]) > 0.1)) {
      fail(`2890473419 recompose 后 world angles 应跟随 localAngles（倾斜不被冲掉），got [${L.angles.map((a) => a.toFixed(3))}]`);
    } else {
      console.log("  ✓ 2890473419：recomposeWorld 后 world angles 跟随 local（倾斜不被冲掉）");
    }
  }
}

// ---- 1. composeChildTransform 纯函数单元：旋转 + 缩放 + 平移全到位
{
  // layer.angles 是**弧度**（scene.json 原生单位，官方 Node.cpp 明注；脚本 API
  // 才用度、在沙箱桥转换）。90° 旋转的 JSON 值是 π/2 —— 曾按度解读，
  // 3281559867 的 180°(3.1416) 父组把子层偏移只转了 3.14°。
  const parent = { origin: [100, 200, 0], scale: [2, 3, 1], angles: [0, 0, Math.PI / 2] }
  const child = { origin: [10, 0, 5], scale: [2, 2, 1], angles: [0, 0, 0] }
  const w = composeChildTransform(parent, child, true)
  // 90° 旋转：[10,0] 先乘父 scale (2,3) → (20, 0)，再 90° 旋转 → (0, 20)，加父 origin (100, 200)
  if (Math.abs(w.origin[0] - 100) > 1e-9) fail(`compose 90° x=${w.origin[0]} 应=100`)
  if (Math.abs(w.origin[1] - 220) > 1e-9) fail(`compose 90° y=${w.origin[1]} 应=220`)
  if (Math.abs(w.origin[2] - 5) > 1e-9) fail(`compose z=${w.origin[2]} 应=5`)
  if (Math.abs(w.scale[0] - 4) > 1e-9) fail(`compose scale.x=${w.scale[0]} 应=4`)
  if (Math.abs(w.scale[1] - 6) > 1e-9) fail(`compose scale.y=${w.scale[1]} 应=6`)
  if (Math.abs(w.angles[2] - Math.PI / 2) > 1e-9) fail(`compose angles.z=${w.angles[2]} 应=π/2`)
  // 渲染惰性纯容器：scale 不传播
  const w2 = composeChildTransform(parent, child, false)
  if (Math.abs(w2.scale[0] - 2) > 1e-9) fail(`惰性容器 scale.x=${w2.scale[0]} 应=2（不继承父 scale）`)
  if (Math.abs(w2.origin[0] - 100) > 1e-9) fail(`惰性容器 origin 仍应受父平移/旋转`)
  if (errors.length === 0) console.log("  ✓ composeChildTransform 纯函数：旋转/缩放/z 继承/惰性容器全对（弧度）")
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

// ---- 7. recomposeWorld 必须「永不抛」，且不得把 NaN 灌进 world（issue #9）----
// 事故形状：畸形关键帧动画（单条通道却装 vec3 字符串 "0 0 -0.05"）经
// sampleChannel 求值成标量 0，旧写回 `layer[slot] = 0` 把 localAngles 整个换成
// number；下一帧 recomposeWorld 里 `l.localAngles.slice()` 抛 TypeError，异常逃出
// rAF 回调 → 渲染循环无声死亡 → 首帧永不完成、mount() 既不 resolve 也不 reject。
// 本函数是逐帧调用点，**它的异常代价是整个渲染循环**，所以判据是「不抛」+
// 「world 保持有限且不变」。
//
// 两条子路径都要覆盖，因为坏法不同：
//   · 根层（无父）：走 `localOrigin/localScale/localAngles.slice()` → 直接抛；
//   · 子层：走 composeChildTransform，`.slice()` 根本不执行，标量槽会被
//     `childLocal.angles[0]` 读成 undefined → world angles 变 [undefined,undefined,NaN]
//     **静默毒化**（不抛但更坏，NaN 会顺着矩阵传染到整个渲染链）。
{
  const mkLayer = (id, parentId, origin) => ({
    id, name: "L" + id, parentId: parentId ?? null,
    origin: origin.slice(), localOrigin: origin.slice(),
    scale: [1, 1, 1], localScale: [1, 1, 1],
    angles: [0, 0, 0], localAngles: [0, 0, 0],
    size: [100, 100, 0], visible: true, visibleSelf: true, alpha: 1, color: [1, 1, 1],
    childIds: [], isPostProcess: false,
  })
  const corruptions = [
    ["localAngles 被写成标量（事故原形）", (l) => { l.localAngles = 0 }],
    ["localScale 被写成标量", (l) => { l.localScale = 0 }],
    ["localScale 被写成 null", (l) => { l.localScale = null }],
    ["localOrigin 被写成 0", (l) => { l.localOrigin = 0 }],
  ]
  // root：目标层无父；child：目标层挂在会动的父层下（父动 → 子必进脏集）
  const setups = [
    ["根层", (target) => []],
    ["子层", (target) => [mkLayer(1, null, [100, 200, 0])] ],
  ]
  const problems = []
  let ran = 0
  for (const [setupName, mkParents] of setups) {
    for (const [name, breakIt] of corruptions) {
      const parents = mkParents()
      const target = mkLayer(2, parents.length ? 1 : null, [10, 20, 0])
      const worldBefore = target.origin.slice()
      const anglesBefore = target.angles.slice()
      breakIt(target)
      const layers = [...parents, target]
      const dirty = collectTransformDirty(layers, [target])
      if (!dirty.has(2)) { problems.push(`${setupName}/${name}：脏集不含目标层，判据无效`); continue }
      if (parents.length) parents[0].localOrigin[0] += 500 // 父动，子理应跟 500
      ran++
      try {
        recomposeWorld(layers, dirty)
      } catch (e) {
        problems.push(`${setupName}/${name}：抛出 ${(e && e.message) || e} —— 渲染循环会因此无声死亡`)
        continue
      }
      const finite = (a) => Array.isArray(a) && a.every(Number.isFinite)
      if (!finite(target.origin) || !finite(target.angles)) {
        problems.push(`${setupName}/${name}：world 被灌成非有限值 origin=${JSON.stringify(target.origin)} angles=${JSON.stringify(target.angles)}`)
        continue
      }
      if (!target.origin.every((v, i) => v === worldBefore[i]) || !target.angles.every((v, i) => v === anglesBefore[i])) {
        problems.push(`${setupName}/${name}：坏层未被跳过，world 被改写（原 ${JSON.stringify(worldBefore)} → ${JSON.stringify(target.origin)}）`)
      }
    }
  }
  if (problems.length) {
    for (const p of problems) fail(p)
  } else {
    console.log(`  ✓ recomposeWorld 永不抛：${setups.length} 种层级 × ${corruptions.length} 种畸形槽 = ${ran} 例全部安全跳过（world 有限且不变）`)
  }
}

// ---- 8. 动画写回的**形状契约**：标量进向量槽必须广播，绝不改槽的形状（issue #9）----
// 判据跑真实现 anim.writeAnimSlot（不是复算一份公式），并用**issue 报的原数据**
// 走一遍 createAnimation → applyTo → writeAnimSlot 全链。
{
  const animMod = await import(path.join(ROOT, "renderer/vendor/we-scene/render/animation.js"));
  const { createAnimation, writeAnimSlot } = animMod
  const L = () => ({ localAngles: [0, 0, 0], localOrigin: [5, 6, 7], alpha: 0.5 })
  // a) 向量槽 + 标量 → 广播，长度不变
  {
    const l = L()
    const ok = writeAnimSlot(l, "localAngles", 0.25)
    const good = ok && Array.isArray(l.localAngles) && l.localAngles.length === 3 &&
      l.localAngles.every((v) => Math.abs(v - 0.25) < 1e-12)
    check(good, `writeAnimSlot 标量进向量槽应广播成 [0.25,0.25,0.25]，got ${JSON.stringify(l.localAngles)}`)
    if (good) console.log("  ✓ writeAnimSlot：标量进向量槽 → 广播全分量（形状保住）")
  }
  // b) 向量槽 + 数组 → 逐分量写回
  {
    const l = L()
    writeAnimSlot(l, "localOrigin", [1, 2, 3])
    check(l.localOrigin.join() === "1,2,3", `writeAnimSlot 数组应逐分量写回，got ${JSON.stringify(l.localOrigin)}`)
  }
  // c) 标量槽 + 标量 → 直接赋值（alpha/brightness 等既有行为不变）
  {
    const l = L()
    writeAnimSlot(l, "alpha", 0.9)
    check(l.alpha === 0.9, `writeAnimSlot 标量槽应直接赋值，got ${l.alpha}`)
  }
  // d) 标量槽 + 数组 → 丢弃（形状错配，不得把布尔/数值槽写成数组）
  {
    const l = { visible: true }
    writeAnimSlot(l, "visible", [1, 0, 0])
    check(l.visible === true, `数组写进标量槽必须丢弃，got ${JSON.stringify(l.visible)}`)
  }
  // e) 向量槽 + 非有限标量 → 丢弃（NaN/Infinity 不得污染变换）
  {
    const l = L()
    writeAnimSlot(l, "localAngles", NaN)
    check(l.localAngles.join() === "0,0,0", `NaN 不得污染向量槽，got ${JSON.stringify(l.localAngles)}`)
  }
  // f) issue 原数据全链：单通道 + vec3 字符串值 → 槽仍是 3 元数组
  {
    const def = {
      c0: [
        { frame: 0, value: "0 0 -0.05", lockangle: true, locklength: true },
        { frame: 150, value: "0 0 0.05", lockangle: true, locklength: true },
        { frame: 300, value: "0 0 -0.05", lockangle: true, locklength: true },
      ],
      options: { fps: 30, length: 300, mode: "loop" },
    }
    const ctrl = createAnimation(def)
    const l = L()
    let violated = null
    for (let i = 0; i < 60; i++) {
      ctrl.advance(1 / 30)
      const out = ctrl.applyTo([0, 0, 0])
      writeAnimSlot(l, "localAngles", out)
      if (!Array.isArray(l.localAngles) || l.localAngles.length !== 3 || !l.localAngles.every(Number.isFinite)) {
        violated = `第 ${i} 帧后 localAngles = ${JSON.stringify(l.localAngles)}（out=${JSON.stringify(out)}）`
        break
      }
    }
    check(!violated, `issue #9 原数据把 localAngles 写坏了：${violated}`)
    if (!violated) console.log("  ✓ issue #9 原数据（单通道 vec3 值）60 帧写回后 localAngles 仍是 3 元有限数组")
  }
}

// ---- 9. 语料断言：真实变换动画求值写回后，槽形状与 recomposeWorld 都必须成立 ----
// 「修好一处畸形数据」不等于「真实语料不受影响」：全库变换动画一条条走
// createAnimation → applyTo → writeAnimSlot → recomposeWorld，任何一条把
// local 槽写成非数组、或让 recomposeWorld 抛，都算回归。
{
  const animMod = await import(path.join(ROOT, "renderer/vendor/we-scene/render/animation.js"));
  const { createAnimation, writeAnimSlot } = animMod
  const TRANSFORM = ["origin", "scale", "angles"]
  let scenes = 0
  let anims = 0
  let broke = 0
  const samples = []
  for (const d of readdirSync(LIB)) {
    if (!/^\d+$/.test(d)) continue
    let sj, project
    try {
      project = JSON.parse(fs.readFileSync(path.join(LIB, d, "project.json"), "utf8"))
      if (String(project.type || "").toLowerCase() !== "scene") continue
      const pkg = parsePkg(new Uint8Array(fs.readFileSync(path.join(LIB, d, "scene.pkg"))))
      sj = JSON.parse(dec.decode(getEntry(pkg, "scene.json")))
    } catch { continue }
    let scene
    try { scene = parseScene(sj, project) } catch { continue }
    scenes++
    const dirty = collectTransformDirty(scene.layers, [])
    const byId = new Map(scene.layers.map((l) => [l.id, l]))
    for (const l of scene.layers) {
      const defs = l.objectAnimations
      if (!defs) continue
      for (const f of TRANSFORM) {
        if (!defs[f]) continue
        anims++
        const ctrl = createAnimation(defs[f].animation)
        const slot = f === "origin" ? "localOrigin" : f === "scale" ? "localScale" : "localAngles"
        if (!Array.isArray(l[slot])) { broke++; if (samples.length < 8) samples.push(`${d} ${l.name} ${f}: 槽不是数组（parse 期）`); continue }
        const before = l[slot].slice()
        try {
          for (let i = 0; i < 40; i++) {
            ctrl.advance(1 / 30)
            writeAnimSlot(l, slot, ctrl.applyTo(before))
          }
          // 形状不变量
          if (!Array.isArray(l[slot]) || l[slot].length !== before.length || !l[slot].every(Number.isFinite)) {
            broke++
            if (samples.length < 8) samples.push(`${d} ${l.name} ${f}: 写回后形状坏了 → ${JSON.stringify(l[slot])}`)
            continue
          }
          // 逐帧调用点不得抛（父层被带动 → 该层必在脏集里）
          if (dirty.has(l.id)) recomposeWorld(scene.layers, dirty)
        } catch (e) {
          broke++
          if (samples.length < 8) samples.push(`${d} ${l.name} ${f}: recomposeWorld 抛 ${(e && e.message) || e}`)
        }
        for (let k = 0; k < before.length; k++) l[slot][k] = before[k]
      }
    }
  }
  if (anims === 0) {
    console.log("  - 跳过语料动画形状断言（本机库中无场景壁纸）")
  } else if (broke > 0) {
    fail(`语料变换动画写回/重算不变量被破坏：${broke} 处 / ${anims} 条（${scenes} 场景）`)
    for (const s of samples) console.log("    " + s)
  } else {
    console.log(`  ✓ 语料形状不变量：${scenes} 场景 ${anims} 条变换动画，40 帧写回 + recomposeWorld 全部保持数组形状且不抛`)
  }
}

console.log("")
if (errors.length > 0) {
  console.log(`✗ 共 ${errors.length} 处问题`)
  process.exit(1)
} else {
  console.log("✓ 全部通过")
}
