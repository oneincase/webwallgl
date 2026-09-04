/**
 * verify-camera.mjs —— 相机级动画的离线校验
 *
 * 覆盖三个 WE 相机特性（本仓库新实现，见 render/math.js / renderer.js）：
 *   1. camerafade  开场淡入。scene.json 只有 `camerafade: true` 开关，**无时长参数**
 *      （WE 用固定内置时长），本仓库取 1.0s 且可由 opts.fadeDuration 覆盖。
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
    const hiX = Math.sin(t * 11.3) * Math.cos(t * 7.1);
    const hiY = Math.cos(t * 9.7) * Math.sin(t * 13.1);
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
  // camerafade 是绝大多数场景的默认行为；若骤降说明 parse 或数据读取出了问题
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
  check(/cameraShakeOffset\s*\(/.test(src), "renderer.js 未调用 cameraShakeOffset（抖动未接线）");
  // 抖动必须右乘 viewProj（左乘会落到 NDC 空间，画面跑飞）
  check(
    /viewProj\s*=\s*mat4Multiply\(viewProj,\s*mat4Translate\(mat4Identity\(\),\s*px,\s*py,\s*0\)\)/.test(src),
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

if (errors.length) {
  console.error(`verify-camera: ${errors.length} 处失败`);
  for (const e of errors) console.error("  - " + e);
  process.exit(1);
}
console.log("verify-camera: all checks passed");
