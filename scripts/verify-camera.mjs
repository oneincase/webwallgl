/**
 * verify-camera.mjs —— 相机级动画的离线校验
 *
 * 覆盖三个 WE 相机特性（本仓库新实现，见 render/math.js / renderer.js）：
 *   1. camerafade  开场幕布。scene.json 只有 `camerafade` 开关、**无时长参数**。
 *      官方语义是「相机切换路径时的淡入」**不是挂载开场淡入** —— 幕布默认不播，
 *      仅宿主显式 fade:true 才接线（时长取 1.0s，可由 opts.fadeDuration 覆盖）。
 *   2. camerashake 相机抖动。三个参数齐全（amplitude / roughness / speed），
 *      无需猜测；但「amp → 像素」的比例（±2% 视宽）是观感近似、无数据出处。
 *   3. 透视相机。有 fov、无 orthogonalprojection 才走 lookAt + perspective
 *      （全库目前仅 3509243656）。2D 场景即使写了 fov 也必须仍走像素正交。
 *      天空盒必须包住相机（锁到 eye），作者盒在原点时相机常在盒外。
 *
 * 判据都不看渲染结果，只验**纯函数行为**与**库内数据分布**：
 *   - 淡入曲线必须单调、首帧全遮、到时归零（否则会出现「开场闪一下」或永久蒙层）；
 *   - 抖动必须逐帧连续（用 Math.random() 会抽帧，这是实现时最容易踩的坑）；
 *   - 库里 camerafade / camerashake 的开启数与参数范围没有跑偏。
 *
 * 退出码非 0 表示发现问题。
 */
import fs from "node:fs";
import { join } from "node:path";

import { LIB, ROOT, imp, createChecker, dec } from "./lib/verify-kit.mjs";
const { parsePkg, getEntry } = await imp("renderer/vendor/we-scene/pkg/container.js");
const { buildCamera } = await imp("renderer/vendor/we-scene/render/math.js");

const { check, errors } = createChecker();
const num = (v, d) => {
  const r = v !== null && typeof v === "object" ? v.value : v;
  if (r === true) return 1;
  if (r === false) return 0;
  return typeof r === "number" && Number.isFinite(r) ? r : d;
};

// ---------- 1. 淡入曲线（与 renderer.js 的实现逐字一致） ----------
{
  const dur = 1.0;
  const cover = (t) => {
    const k = Math.max(0, Math.min(1, t / dur));
    return 1 - k * k * (3 - 2 * k);
  };
  check(Math.abs(cover(0) - 1) < 1e-9, `淡入首帧必须全遮，实测 cover(0)=${cover(0)}`);
  check(Math.abs(cover(dur)) < 1e-9, `淡入到时必须归零，实测 cover(${dur})=${cover(dur)}`);
  check(Math.abs(cover(dur * 2)) < 1e-9, "超过时长后 cover 必须仍为 0（不能出现负值/回弹）");
  // 单调不增：任何回弹都会表现为「开场闪一下」
  let prev = Infinity;
  let mono = true;
  for (let i = 0; i <= 100; i++) {
    const c = cover((i / 100) * dur);
    if (c > prev + 1e-9) mono = false;
    prev = c;
  }
  check(mono, "淡入 cover 必须单调不增（否则开场会闪一下）");
  // 中点应接近 0.5：偏太多说明曲线被写错（例如漏了 smoothstep 或写成线性平方）
  check(Math.abs(cover(dur / 2) - 0.5) < 1e-6, `淡入中点应为 0.5，实测 ${cover(dur / 2)}`);
}

// ---------- 2. 抖动连续性（逐帧不得跳变） ----------
{
  const shake = (amp, rough, speed, time) => {
    const t = time * speed;
    const lowX = Math.sin(t * 2.1) * Math.cos(t * 0.7);
    const lowY = Math.cos(t * 1.7) * Math.sin(t * 0.9);
    // issue#3：高频分量频率减半（原 11.3/7.1、9.7/13.1 整屏 ~2.5Hz 属剧烈晃动）。
    // 和频约束 ≤9.2（乘积项主频 =(f1+f2)/2π ≤1.46Hz）
    const hiX = Math.sin(t * 5.65) * Math.cos(t * 3.55);
    const hiY = Math.cos(t * 4.2) * Math.sin(t * 5.0);
    return {
      x: (lowX * (1 - rough) + hiX * rough) * amp,
      y: (lowY * (1 - rough) + hiY * rough) * amp,
    };
  };
  // 覆盖库里实际出现的三组参数（含 roughness 两端）
  for (const [amp, rough, speed] of [[0.35, 0, 1], [0.5, 1, 0.81], [0.2, 0, 0.9]]) {
    let px = null, py = null, maxJump = 0, maxAbs = 0;
    for (let i = 0; i <= 600; i++) {
      const s = shake(amp, rough, speed, i / 60);
      if (px !== null) maxJump = Math.max(maxJump, Math.abs(s.x - px), Math.abs(s.y - py));
      px = s.x; py = s.y;
      maxAbs = Math.max(maxAbs, Math.abs(s.x), Math.abs(s.y));
    }
    const tag = `amp=${amp} rough=${rough} speed=${speed}`;
    // 60fps 下相邻帧跳变超过振幅的 1/4 就是可见的抽帧感
    check(maxJump < amp * 0.25, `抖动不连续（${tag}）：相邻帧最大跳变 ${maxJump.toFixed(4)} ≥ amp/4`);
    // 幅度不得超过 amp（合成波权重和为 1，且各分量 |sin·cos| ≤ 1）
    check(maxAbs <= amp + 1e-9, `抖动幅度越界（${tag}）：${maxAbs.toFixed(4)} > amp`);
    // 必须真的在动
    check(maxAbs > amp * 0.2, `抖动幅度过小（${tag}）：${maxAbs.toFixed(4)}，可能被写死成 0`);
  }
  // amp=0 必须完全静止（renderer.js 里提前 return null）
  const z = shake(0, 0, 1, 3.7);
  check(z.x === 0 && z.y === 0, "amp=0 时抖动必须恒为 0");

  // ---------- 2a-2. issue#3 标定收敛：整屏抖动必须落在「轻微缓慢」区间 ----------
  // 旧标定 amp=1 → ±2% 视宽在 amp=0.5 时整屏 ±38px@4K、~2.5Hz，实测 62% 像素
  // 逐帧变化（CASEBOOK 实机数据），观感是剧烈晃动。收敛后 amp=1 → ±0.5% 视宽。
  {
    const screenPx = (amp, viewW, viewH) => {
      const s = shake(amp, 1, 0.81, 0); // rough=1 = 幅度上限路径
      return Math.max(Math.abs(s.x) * viewW * 0.005, Math.abs(s.y) * viewH * 0.005);
    };
    // 语料最猛的一组（3789602510）在 4K 下不得超过 12px、1080p 不得超过 6px
    const p4k = screenPx(0.5, 3840, 2160);
    const p1080 = screenPx(0.5, 1920, 1080);
    check(p4k <= 12, `camerashake 4K 幅度超标：amp=0.5 → ±${p4k.toFixed(2)}px（应 ≤12，即轻微可感）`);
    check(p1080 <= 6, `camerashake 1080p 幅度超标：amp=0.5 → ±${p1080.toFixed(2)}px（应 ≤6）`);
    // 高频路径必须真的慢下来：rough=1 speed≤1 时主频率不超过 ~1.5Hz
    // （过零率估计：10s 采样、60fps，两轴各 ≤15 个方向翻转）
    for (const [axis, key] of [["x", "x"], ["y", "y"]]) {
      let prev = null, zc = 0;
      for (let i = 0; i <= 600; i++) {
        const v = shake(1, 1, 1, i / 60)[key];
        if (prev !== null && Math.sign(v) !== Math.sign(prev)) zc++;
        prev = v;
      }
      // 主频 ≈ 过零数 / 2 / 10s；hiX=5.65±3.55 → ≤ (5.65+3.55)/2π ≈ 1.46Hz → 10s ≤ 29 次翻转
      check(zc <= 30, `rough=1 高频分量过快：${axis} 轴 10s 过零 ${zc} 次（>30 即 ≥1.5Hz，不满足「缓慢」）`);
    }
    // 源码守卫：应用点的比例必须是 0.005，且 camerashake 区间内不得残留 0.02 旧标定
    const src = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/renderer.js"), "utf8");
    const appBlock = src.slice(src.indexOf("camerashake：相机整体抖动"));
    check(/cam\.viewW \* 0\.005/.test(appBlock), "抖动幅度必须是 ±0.5% 视宽（cam.viewW * 0.005）");
    check(!/cam\.viewW \* 0\.02/.test(appBlock), "不得退回 ±2% 视宽旧标定（整屏 ±38px@4K = 剧烈晃动）");
    const fnSrc = src.slice(src.indexOf("function cameraShakeOffset"), src.indexOf("function cameraShakeOffset") + 900);
    check(/Math\.sin\(t \* 5\.65\)/.test(fnSrc), "高频 x 分量频率应为 5.65（issue#3 减半后）");
  }
}

// ---------- 2b. 脚本 zoom 叠在 fit 窗口上（3151551777 火车震动 1.01）----------
{
  const scene = {
    general: { orthogonalprojection: { width: 1920, height: 1080 }, zoom: 1 },
    camera: { eye: "0 0 0", center: "0 0 -1", up: "0 1 0" },
    cameraTransforms: { zoom: 1 },
  };
  const a = buildCamera(scene, 1920, 1080, "cover");
  scene.cameraTransforms.zoom = 1.01;
  const b = buildCamera(scene, 1920, 1080, "cover");
  check(Math.abs(a.viewW - 1920) < 1e-6, `zoom=1 时 viewW 应为 1920，实得 ${a.viewW}`);
  check(b.viewW < a.viewW, `zoom=1.01 应缩小视口，${b.viewW} ≮ ${a.viewW}`);
  check(Math.abs(b.viewW - 1920 / 1.01) < 1e-4, `zoom=1.01 的 viewW 应为 ${1920 / 1.01}，实得 ${b.viewW}`);
  scene.cameraTransforms.zoom = 1;
  const c = buildCamera(scene, 1920, 1080, "cover");
  check(Math.abs(c.viewW - a.viewW) < 1e-9, "zoom 回到 1 后视口应复原（不得改 cover 本身）");
}

// ---------- 2c. 透视相机（3509243656 三体：fov 有、orthogonalprojection 无）----------
{
  const { mat4Multiply, mat4TransformPoint, isPerspectiveScene } = await imp("renderer/vendor/we-scene/render/math.js");
  const threeBody = {
    general: { fov: 50, nearz: 0.01, farz: 10000, orthogonalprojection: null, zoom: 1 },
    camera: {
      center: "-1.83970 0.51670 9.15603",
      eye: "-2.05772 0.85240 10.07242",
      up: "0.00000 1.00000 0.00000",
    },
  };
  check(isPerspectiveScene(threeBody), "fov=50 且无正交投影应判定为透视场景");
  const persp = buildCamera(threeBody, 1920, 1080, "cover");
  check(persp.perspective === true, "透视场景 cam.perspective 必须为 true");
  check(persp.projection[11] === -1, "透视投影必须是 mat4Perspective（m[11]=-1），不能再走像素正交");
  // 脚本把三星写到质心相对坐标 + zOffset=-9。走透视后必须落在 NDC 内；
  // 旧实现 lookAt × 像素正交会把它们钉在 NDC x≈-1（画布左缘外）。
  const vp = mat4Multiply(persp.projection, persp.view);
  const stars = [[0, 1, -9], [-0.866, -0.5, -9], [0.866, -0.5, -9]];
  let allIn = true;
  let worst = "";
  for (const p of stars) {
    const ndc = mat4TransformPoint(vp, p[0], p[1], p[2]);
    if (ndc.some((n) => !Number.isFinite(n)) || Math.abs(ndc[0]) > 0.95 || Math.abs(ndc[1]) > 0.95) {
      allIn = false;
      worst = `${p} → [${ndc.map((n) => n.toFixed(3)).join(", ")}]`;
    }
  }
  check(allIn, `三体默认三星经透视相机后必须落在画面内${worst ? "（" + worst + "）" : ""}`);
  const clock = mat4TransformPoint(vp, 0, 0.4, 4);
  check(Math.abs(clock[0]) < 0.95 && Math.abs(clock[1]) < 0.95, `时钟 (0,0.4,4) 应在画面内，NDC=[${clock.map((n) => n.toFixed(3)).join(", ")}]`);

  const twoD = {
    general: { orthogonalprojection: { width: 1920, height: 1080 }, zoom: 1, fov: 50 },
    camera: { eye: "0 0 0", center: "0 0 -1", up: "0 1 0" },
  };
  check(!isPerspectiveScene(twoD), "带 orthogonalprojection 的 2D 场景即使写了 fov 也不得走透视");
  const ortho = buildCamera(twoD, 1920, 1080, "cover");
  check(ortho.perspective === false, "2D 场景 cam.perspective 必须为 false");
  check(Math.abs(ortho.viewW - 1920) < 1e-6, `2D cover 视口不得被透视分支改掉，viewW=${ortho.viewW}`);

  // 2c-2. 「没有正交投影」必须含**空对象**这一种。
  // 三体 scene.json 写的是 `"orthogonalprojection": null`，装配期只要有人
  // `general.orthogonalprojection ??= {}`（GIF 模板 auto ortho 那段的旧写法），
  // 空对象就是真值 → 三体退回像素正交 → 世界单位 ≈1 的星星被当 1 像素画到角落，
  // 整屏全黑（实测 mean 0.00 / max 17）。空对象必须按「无投影」处理。
  check(
    isPerspectiveScene({ general: { fov: 50, orthogonalprojection: {} }, camera: {} }),
    "orthogonalprojection 是空对象时必须仍判定为透视（装配期补空对象不准改判）",
  );
  check(
    isPerspectiveScene({ general: { fov: 50, orthogonalprojection: undefined }, camera: {} }),
    "orthogonalprojection 缺失时必须判定为透视",
  );
  // 反例：真写过键的正交投影（含 GIF 模板的 auto 标记）必须仍是 2D
  check(
    !isPerspectiveScene({ general: { fov: 50, orthogonalprojection: { auto: true } }, camera: {} }),
    "带 auto 标记的正交投影（GIF 导入模板）必须走正交，不能被 fov 抢走",
  );
  check(
    !isPerspectiveScene({ general: { fov: 50, orthogonalprojection: { width: 0, height: 0, auto: true } }, camera: {} }),
    "auto 模板即使宽高没算出来也必须留在正交路径",
  );
  // 真实语料：scene.json 原文就是 null，装配期不得把它变成对象
  {
    const sceneJsonPath = join(LIB, "3509243656", "scene.pkg");
    if (fs.existsSync(sceneJsonPath)) {
      const buf = fs.readFileSync(sceneJsonPath);
      const pkg = parsePkg(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
      const g = JSON.parse(dec.decode(getEntry(pkg, "scene.json"))).general;
      check(g.orthogonalprojection === null, `三体 scene.json 的 orthogonalprojection 应为 null，实得 ${JSON.stringify(g.orthogonalprojection)}`);
      const mountSrc = fs.readFileSync(join(ROOT, "renderer/src/scene-mount.ts"), "utf8");
      check(
        !/general\.orthogonalprojection\s*=(?!=)/.test(mountSrc) && !/\?\?\s*\(\s*general\.orthogonalprojection\s*=/.test(mountSrc),
        "装配期不得往 general.orthogonalprojection 写值（写空对象会让透视场景退回正交 = 全黑）",
      );
      check(
        /const ortho = \(general\.orthogonalprojection \?\? null\)/.test(mountSrc),
        "auto ortho 那段必须只读不建：`const ortho = (general.orthogonalprojection ?? null)`",
      );
    }
  }
}

// ---------- 2c-3. 真 3D 网格的顶点 z 必须保留（否则球体被压平在相机平面上）----------
// 顶点着色器曾是 `u_mvp * vec4(local.xy, 0.0, 1.0)`：z 恒 0 是 2D puppet 的正确行为
// （网格坐标是图层局部像素，z 只是建模残留），但透视场景里的真 3D 网格会被压成
// 过相机的一张薄片 —— 天空盒（球心就在相机上）只剩一条边、星空铺不满、星芒球变成
// 小点，整屏近黑（实测 mean 0.44 / 无天空盒）。修法：加 u_keepZ，透视才传 1。
{
  const mdlSrc = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/mdl.js"), "utf8");
  const rndSrc = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/renderer.js"), "utf8");
  const mountSrc = fs.readFileSync(join(ROOT, "renderer/src/scene-mount.ts"), "utf8");
  check(/uniform float u_keepZ;/.test(mdlSrc), "mdl 顶点着色器必须有 u_keepZ");
  check(
    /gl_Position = u_mvp \* vec4\(local\.xy, local\.z \* u_keepZ, 1\.0\)/.test(mdlSrc),
    "mdl 顶点着色器必须写成 local.z * u_keepZ（直接写 local.z 会把 2D puppet 的建模 z 放进深度）",
  );
  check(/gl\.uniform1f\(uni\.keepZ, opts\.keepZ \? 1 : 0\)/.test(mdlSrc), "mdl.draw 必须按 opts.keepZ 设置 u_keepZ（缺省 = 压平）");
  check(/keepZ: gl\.getUniformLocation\(prog, 'u_keepZ'\)/.test(mdlSrc), "u_keepZ 的 uniform 位置必须缓存");
  check(
    /keepZ: !!\(cam && cam\.perspective\)/.test(rndSrc),
    "renderer 给 puppet 回调的 keepZ 必须由 cam.perspective 决定（透视场景才保留 z）",
  );
  check(/keepZ: !!o\.keepZ/.test(mountSrc), "宿主必须把 o.keepZ 透传给 mdlRenderer.draw");

  // 语料事实：2D 场景里确实存在 z 很深的 puppet 网格，所以「一律保留 z」是错的
  const deepZ = [];
  if (fs.existsSync(join(LIB, "3737267090", "scene.pkg"))) {
    const { parseMDL } = await imp("renderer/vendor/we-scene/render/mdl-parse.js");
    const buf = fs.readFileSync(join(LIB, "3737267090", "scene.pkg"));
    const pkg = parsePkg(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
    const e = getEntry(pkg, "models/556_puppet.mdl");
    if (e) {
      const m = parseMDL(e);
      let zmax = 0;
      for (let i = 2; i < m.positions.length; i += 3) zmax = Math.max(zmax, Math.abs(m.positions[i]));
      deepZ.push({ id: "3737267090", zmax });
    }
  }
  check(deepZ.length > 0 && deepZ[0].zmax > 10, `2D 人物网格必须仍有深 z（否则 keepZ 的闸门没有意义）实得 ${JSON.stringify(deepZ)}`);
}

// ---------- 2d. 3509243656 真 3D mdl（直接挂 model，不经 puppet json）----------
if (fs.existsSync(join(LIB, "3509243656", "scene.pkg"))) {
  const { parseMDL } = await imp("renderer/vendor/we-scene/render/mdl-parse.js");
  const { parseScene } = await imp("renderer/vendor/we-scene/scene/parse.js");
  const buf = fs.readFileSync(join(LIB, "3509243656", "scene.pkg"));
  const pkg = parsePkg(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  const raw = JSON.parse(dec.decode(getEntry(pkg, "scene.json")));
  const parsed = parseScene(raw, {});
  const modeled = parsed.layers.filter((l) => l.model);
  check(modeled.length >= 7, `parse 必须留下 model 字段，实得 ${modeled.length}`);
  check(modeled.some((l) => l.isSkybox), "天空盒层必须标 isSkybox（透视时要先画）");
  let parsedOk = 0;
  for (const l of modeled) {
    const entry = getEntry(pkg, l.model);
    if (!entry) continue;
    let m;
    try { m = parseMDL(entry); } catch { continue; }
    if (m.vertexCount > 0 && m.indexCount > 0 && m.materialPath) parsedOk++;
    if (l.name.includes("天空盒")) {
      check(m.vertexCount > 1000, `天空盒顶点数异常: ${m.vertexCount}`);
    }
    if (l.name.startsWith("Star")) {
      check(m.vertexCount === 2143, `恒星网格应为 2143 顶点，实得 ${m.vertexCount}`);
    }
  }
  check(parsedOk >= 7, `3509243656 至少 7 个 mdl 必须能解析，实得 ${parsedOk}`);

  // 2e. 天空盒必须包住相机。作者盒在原点、半边长 8，相机 z≈10 在盒外；
  // 从外面看 +Z 外壁就是「左边一块暗球面、星空画在圆里」。锁到 eye 后才铺满。
  const { layerWorldOrigin } = await imp("renderer/vendor/we-scene/render/math.js");
  const cam3d = buildCamera(raw, 1920, 1080, "cover");
  const sky = modeled.find((l) => l.isSkybox);
  check(!!sky, "必须能找到天空盒层");
  const half = [Math.abs(sky.scale[0]), Math.abs(sky.scale[1]), Math.abs(sky.scale[2])];
  const eye = cam3d.eye;
  const inside = (origin) =>
    Math.abs(eye[0] - origin[0]) < half[0] &&
    Math.abs(eye[1] - origin[1]) < half[1] &&
    Math.abs(eye[2] - origin[2]) < half[2];
  check(!inside(sky.origin), `未锚定时相机应在盒外（eye z=${eye[2].toFixed(2)} vs 半边长 ${half[2]}）`);
  const locked = layerWorldOrigin(sky, cam3d);
  check(inside(locked), `天空盒锁到 eye 后相机必须在盒内，origin=[${locked.join(", ")}]`);
  check(locked === cam3d.eye, "透视天空盒的世界原点必须就是 cam.eye");
  const dummy = { origin: [0, 0, 0], isSkybox: false };
  check(layerWorldOrigin(dummy, cam3d) === dummy.origin, "非天空盒不得改 origin（恒星/地球仍走作者坐标）");
  check(layerWorldOrigin(sky, { perspective: false, eye: [9, 9, 9] }) === sky.origin, "2D 相机不得把天空盒锁到 eye");
  // FOV 50、16:9：从盒心看出去，半边长必须盖住视锥（否则锁了相机仍铺不满）。
  const tanHalf = Math.tan((50 * Math.PI) / 180 / 2);
  const nearWall = Math.min(half[0], half[2]);
  const needY = nearWall * tanHalf;
  const needX = needY * (1920 / 1080);
  check(half[1] > needY, `天空盒 Y 半边长 ${half[1]} 必须盖住垂直半视角（需 > ${needY.toFixed(2)}）`);
  check(nearWall > needX, `天空盒 XZ 半边长 ${nearWall} 必须盖住水平半视角（需 > ${needX.toFixed(2)}）`);
}

// ---------- 3. 库内数据分布（防止实现假设与真实数据脱节） ----------
if (fs.existsSync(LIB)) {
  const ids = fs.readdirSync(LIB).filter((d) => fs.existsSync(join(LIB, d, "scene.pkg")));
  let fadeOn = 0, fadeMissing = 0, shakeOn = 0, total = 0;
  const shakeParams = [];
  const perspIds = [];
  for (const id of ids) {
    let pkg, raw;
    try {
      const buf = fs.readFileSync(join(LIB, id, "scene.pkg"));
      pkg = parsePkg(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
      raw = JSON.parse(dec.decode(getEntry(pkg, "scene.json")));
    } catch { continue; }
    total++;
    const g = raw.general || {};
    if (g.camerafade === undefined) fadeMissing++;
    else if (num(g.camerafade, 0) === 1) fadeOn++;
    if (g.fov && !g.orthogonalprojection) perspIds.push(id);
    if (num(g.camerashake, 0) === 1) {
      shakeOn++;
      shakeParams.push({
        id,
        amp: num(g.camerashakeamplitude, 0),
        rough: num(g.camerashakeroughness, 0),
        speed: num(g.camerashakespeed, 1),
      });
    }
  }
  console.log(`扫描 ${total} 个场景：camerafade 开启 ${fadeOn}，缺字段 ${fadeMissing}，camerashake 开启 ${shakeOn}，透视 ${perspIds.length}（${perspIds.join(",") || "无"}）`);
  check(perspIds.includes("3509243656"), `库内应有 3509243656 透视场景，实得 [${perspIds.join(", ")}]`);
  check(perspIds.length <= 3, `透视场景异常增多：${perspIds.length}（判定正交投影的条件可能被写反）`);
  // camerafade 字段本身绝大多数场景为 true（WE 编辑器默认值）；若骤降说明 parse
  // 或数据读取出了问题。字段分布与是否播放无关 —— 幕布默认不播（见第 4 组守卫）。
  check(fadeOn > total * 0.8, `camerafade 开启数异常偏低：${fadeOn}/${total}（预期 >80%）`);
  // 缺字段的场景**不该**淡入（默认关），这是 renderer.js 里 boolProp(...,false) 的依据
  check(fadeMissing <= 2, `camerafade 缺字段的场景数异常：${fadeMissing}（预期 ≤2）`);
  check(shakeOn > 0, "库内应至少有 1 个 camerashake 场景（否则抖动实现无样本可依）");
  for (const p of shakeParams) {
    check(p.amp > 0 && p.amp <= 2, `${p.id} camerashakeamplitude 越界: ${p.amp}`);
    check(p.rough >= 0 && p.rough <= 1, `${p.id} camerashakeroughness 越界: ${p.rough}`);
    check(p.speed > 0 && p.speed <= 20, `${p.id} camerashakespeed 越界: ${p.speed}`);
    console.log(`   ${p.id}  amp=${p.amp} rough=${p.rough} speed=${p.speed}`);
  }
} else {
  console.log("（跳过库内分布检查：壁纸库目录不存在）");
}

// ---------- 4. renderer.js 必须真的接了这两个特性 ----------
{
  const src = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/renderer.js"), "utf8");
  check(/camerafade/.test(src), "renderer.js 未引用 camerafade");
  check(/camerashake/.test(src), "renderer.js 未引用 camerashake");
  check(/fadeEnabled\s*\(/.test(src), "renderer.js 未调用 fadeEnabled（淡入未接线）");
  // 幕布必须**默认不播**：官方语义 camerafade = 相机切换路径时的淡入，不是挂载
  // 开场淡入 —— 旧闸门（opts.fade !== false && 场景 true 就放行）曾让 127/128 个
  // 壁纸加载完成后先黑 1s，观感 = 加载变慢。必须保持「宿主显式 fade:true 才接线」。
  check(
    /fadeEnabled = \(general\) => opts\.fade === true && boolProp\(general\.camerafade, false\)/.test(src),
    "camerafade 幕布必须默认不播（opts.fade === true 显式接线），不得退回「场景写了 true 就淡入」",
  );
  check(/cameraShakeOffset\s*\(/.test(src), "renderer.js 未调用 cameraShakeOffset（抖动未接线）");
  // 抖动必须右乘 viewProj（左乘会落到 NDC 空间，画面跑飞）
  check(
    /viewProj\s*=\s*mat4Multiply\(viewProj,\s*(mat4Translate\(mat4Identity\(\),\s*px,\s*py,\s*0\)|shakeM)\)/.test(src),
    "抖动必须写成 mat4Multiply(viewProj, translate)（右乘=世界空间）",
  );
  // 抖动不得用随机数（会抽帧）
  const shakeFn = src.slice(src.indexOf("function cameraShakeOffset"), src.indexOf("function cameraShakeOffset") + 900);
  check(!/Math\.random/.test(shakeFn), "cameraShakeOffset 不得使用 Math.random（逐帧跳变=抽帧感）");
  check(/cam\.perspective/.test(src), "renderer.js 未引用 cam.perspective（透视层变换/裁剪未接线）");
  check(/if\s*\(\s*cam\s*&&\s*cam\.perspective\s*\)\s*return false/.test(src) ||
    /if\s*\(cam\s*&&\s*cam\.perspective\)\s*return false/.test(src),
    "isLayerOffscreen 对透视场景必须停用像素 AABB 裁剪");
  check(/layerWorldOrigin/.test(src), "renderer.js 未调用 layerWorldOrigin（天空盒未锁到相机）");
}

// ---------- 5. perspective 图层（2890473419 3D 卡片倾斜）----------
// 2D 场景里脚本 thisLayer.perspective=true 的层换独立透视 VP（WE 编辑器
// Perspective 模板，全库 4 张 / 16 层）。语义照 open-wallpaper-engine 的
// global_perspective 相机：相机架在可见窗口中心正前方，z=0 与正交逐像素重合；
// distance = H/(2·tan(fovY/2))，fovY 取 perspectiveoverridefov（>0），缺省 dist=1000 反推。
{
  const { buildLayerPerspectiveVP } = await imp("renderer/vendor/we-scene/render/math.js");
  const { mat4Multiply, mat4TransformPoint } = await imp("renderer/vendor/we-scene/render/math.js");

  const scene = {
    general: {
      orthogonalprojection: { width: 3440, height: 1440 },
      fov: 50, perspectiveoverridefov: 95, zoom: 1,
    },
    camera: null,
  };
  const cam = buildCamera(scene, 2560, 1440, "cover", 0.5, 0.5);
  const lp = buildLayerPerspectiveVP(cam, scene.general);

  // 5a) 基本几何：相机在窗口中心正前方，距离 = (H/2)/tan(fovY/2)
  const distExp = cam.viewH / 2 / Math.tan(((95 * Math.PI) / 180) / 2);
  check(lp && Math.abs(lp.dist - distExp) < 1e-6, `透视层相机距离应为 (H/2)/tan(fovY/2)=${distExp.toFixed(3)}，got ${lp && lp.dist}`);
  check(lp && Math.abs(lp.eye[0] - (cam.offX + cam.viewW / 2)) < 1e-9 && Math.abs(lp.eye[1] - (cam.offY + cam.viewH / 2)) < 1e-9,
    "透视层相机必须架在可见窗口中心（否则 z=0 对不齐正交）");
  check(lp && lp.eye[2] > 0, "透视层相机必须在 z>0（屏幕外朝里看）");

  // 5b) z=0 平面上与正交**逐像素重合**（未旋转的透视层与普通层无缝对齐）
  {
    const orthoVP = mat4Multiply(cam.projection, cam.view);
    let maxErr = 0;
    const pts = [
      [cam.offX, cam.offY], [cam.offX + cam.viewW, cam.offY],
      [cam.offX, cam.offY + cam.viewH], [cam.offX + cam.viewW, cam.offY + cam.viewH],
      [1720, 720], [853, 1282],
    ];
    for (const [x, y] of pts) {
      const a = mat4TransformPoint(orthoVP, x, y, 0);
      const b = mat4TransformPoint(lp.viewProj, x, y, 0);
      maxErr = Math.max(maxErr, Math.hypot(a[0] - b[0], a[1] - b[1]));
    }
    check(maxErr < 1e-5, `z=0 平面透视 VP 与正交 VP 必须逐像素重合（maxErr=${maxErr.toExponential(2)}；x 镜像/未对齐会到 2.0 量级）`);
  }

  // 5c) 深度：z 越大（越朝相机）放大越多（3D 近大远小）
  {
    const cx = cam.offX + cam.viewW / 2, cy = cam.offY + cam.viewH / 2;
    const a = mat4TransformPoint(lp.viewProj, cx + 100, cy, 0);
    const b = mat4TransformPoint(lp.viewProj, cx + 100, cy, 500);
    check(b[0] > a[0] && b[0] / a[0] > 1.5, `z=500 的点应明显放大（近大远小），放大率=${(b[0] / a[0]).toFixed(2)}`);
    // 世界方向：+x 必须投到 NDC +x（修过的镜像坑：lookAt up 向量会镜像 x）
    check(a[0] > 0, `世界 +x 必须投到 NDC +x（lookAt 镜像会让它翻负），got ${a[0]}`);
  }

  // 5d) 无 override 时 distance=1000、fov 反推
  {
    const lp2 = buildLayerPerspectiveVP(cam, { ...scene.general, perspectiveoverridefov: 0 });
    check(lp2 && lp2.dist === 1000, `无 perspectiveoverridefov 时距离应为 1000，got ${lp2 && lp2.dist}`);
    const fovExp = (2 * Math.atan(cam.viewH / 2 / 1000) * 180) / Math.PI;
    check(lp2 && Math.abs(lp2.fovY - fovExp) < 1e-6, `无 override 时 fovY 应由 distance=1000 反推=${fovExp.toFixed(3)}，got ${lp2 && lp2.fovY}`);
  }

  // 5e) hit-test 射线-平面求交（render/hittest.js 真实现）：
  // 旋转层的边中点，经「眼点→边上点」射线在 z=0 的落点喂回 worldToLayerLocal，
  // 必须还原出 lx=-0.5。旋转/顺序错一个，lx 就偏。
  {
    const { worldToLayerLocal } = await imp("renderer/vendor/we-scene/render/hittest.js");
    const ALIGN = { center: [0.5, 0.5] };
    const ry = (30 * Math.PI) / 180;
    const layer = {
      origin: [1720, 716.4, 0], size: [800, 1000], scale: [1, 1, 1],
      angles: [0, ry, 0], alignment: "center", perspective: true,
    };
    const eye = lp.eye;
    const projH = 1440;
    // 层局部 (-0.5w, 0, 0) 经实现侧 R = Rz(-z)·Ry(-y)·Rx(x) 旋到世界
    // （T·R，无 z 旋/无视差/居中锚）：Ry(-30°) 作用于 (-400,0,0) → (c·x, 0, s·x)
    const c = Math.cos(ry), s = Math.sin(ry);
    const localEdge = [-400, 0, 0];
    const wx0 = 1720 + c * localEdge[0];
    const wy0 = projH - 716.4;
    const wz0 = s * localEdge[0];
    // 眼点→边点 的射线与 z=0 交点 = 该点在屏幕上对应的指针世界坐标
    const t = eye[2] / (eye[2] - wz0);
    const px = eye[0] + (wx0 - eye[0]) * t;
    const py = eye[1] + (wy0 - eye[1]) * t;
    const hit = worldToLayerLocal(layer, px, py, projH, 0, 0, ALIGN, eye);
    check(hit && Math.abs(hit.lx + 0.5) < 1e-3 && Math.abs(hit.ly) < 1e-3,
      `旋转 30° 的透视层左边中点命中应还原 lx=-0.5,ly=0，got ${hit && `lx=${hit.lx.toFixed(3)},ly=${hit.ly.toFixed(3)}`}`);
    // 锚点正对的指针必须命中中心（任意旋转角都成立）
    const hitC = worldToLayerLocal(layer, 1720, wy0, projH, 0, 0, ALIGN, eye);
    check(hitC && Math.abs(hitC.lx) < 1e-6 && Math.abs(hitC.ly) < 1e-6,
      `透视层锚点正对的指针应命中中心，got ${hitC && `lx=${hitC.lx.toFixed(4)},ly=${hitC.ly.toFixed(4)}`}`);
    // 未开 perspective 的层走原 2D 路径（回归面不受新分支影响）
    const flat = worldToLayerLocal({ ...layer, perspective: false, angles: [0, 0, 0] }, 1720 - 400, wy0, projH, 0, 0, ALIGN, eye);
    check(flat && Math.abs(flat.lx + 0.5) < 1e-9, "非透视层的 2D 命中路径必须保持原样");
  }

  // 5f) 接线断言（renderer.js / hittest.js / text.js / scene-mount.ts）
  {
    const src2 = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/renderer.js"), "utf8");
    check(/buildLayerPerspectiveVP/.test(src2), "renderer.js 未引用 buildLayerPerspectiveVP（透视 VP 未接线）");
    check(/layer\.perspective\s*&&\s*viewProjPersp/.test(src2), "renderer.js 主循环必须按层选透视 VP（layerVP）");
    // 旋转顺序必须与 WE 重实现一致：Rz 之后接 Ry 再接 Rx（M = T·Rz·Ry·Rx）。
    // 锚到 angles[1]/angles[0] 的具体语句，别搜 "if (layer.perspective)"
    // （isLayerOffscreen 里也有同样的前缀，会切错位置）。
    check(/if \(layer\.angles\[1\]\) m = mat4RotateY\(m, -layer\.angles\[1\]\)[\s\S]{0,120}if \(layer\.angles\[0\]\) m = mat4RotateX\(m, layer\.angles\[0\]\)/.test(src2),
      "layerModelMatrix 透视分支必须是 Rz → Ry(-y) → Rx(+x)（顺序/符号错=倾斜轴向错：+y 会让卡片背向指针左右反转）");
    check(/if \(layer\.perspective\) return false/.test(src2), "isLayerOffscreen 必须跳过 perspective 层");
    const hit = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/hittest.js"), "utf8");
    check(/perspLayerLocal/.test(hit) && /layer\.perspective && perspEye/.test(hit),
      "hittest.js 必须接 perspective 射线-平面求交分支");
    const txt = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/text.js"), "utf8");
    check(/set perspective\(v\) \{ if \(layer\) layer\.perspective = !!v \}/.test(txt),
      "对象层代理必须有 perspective setter（脚本 thisLayer.perspective=true 才能落到图层）");
    const mnt = fs.readFileSync(join(ROOT, "renderer/src/scene-mount.ts"), "utf8");
    check(/getPerspectiveEye/.test(mnt), "scene-mount.ts 必须把 perspEye 传给 hitTestLayers");
  }
}

if (errors.length) {
  console.error(`verify-camera: ${errors.length} 处失败`);
  for (const e of errors) console.error("  - " + e);
  process.exit(1);
}
console.log("verify-camera: all checks passed");
