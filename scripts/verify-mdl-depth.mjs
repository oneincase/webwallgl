#!/usr/bin/env node
/**
 * verify-mdl-depth —— 真 3D 模型之间的**层间深度**契约（F49）。
 *
 * 为什么需要（2026-10-04 的真实回归，用户报「3477054430 没有显示 cat」）：
 *   `mdl.js` 的 keepZ 分支此前每画一个模型就 `clear(DEPTH_BUFFER_BIT)` —— 等于把先画的
 *   模型从深度缓冲里抹掉，深度测试无从比较 ⇒ **后画的模型无条件盖住先画的**。猫的两个
 *   模型（层序 0/1）被后画的城市（层序 5）整片涂掉，只有探出楼顶轮廓的那圈耳机带可见，
 *   看起来就是「猫没了」。同一根因在材质路径上已于 F40 修掉（fantasticcar 地板盖住车身），
 *   这是另一条绘制路径（通用网格程序 / generic4 那族模型）。
 *
 * 判据为什么不写成正则锁实现：这条缺陷的载体是 **GL 调用序列**（清深度夹在两次模型
 * 绘制之间），光看源码文本既可能漏（换个写法就绕过）、也可能误伤（注释里提到旧写法）。
 * 所以本 verifier 用一个**记录型假 GL** 驱动**真的** `createMDLRenderer`（不是复制的
 * 判定逻辑），直接对调用序列下断言：
 *   1. 两个 keepZ 模型连续绘制之间**不得出现 clear(DEPTH_BUFFER_BIT)**（核心）；
 *   2. keepZ 绘制仍要 enable(DEPTH_TEST) + depthFunc(LEQUAL)（别把清深度和开测试一起删）；
 *   3. keepZ 模型在画之前把深度写掩码打开、画完复位（否则它自己不写深度 ⇒ 挡不住后面的）；
 *   4. 天空盒（opts.skybox）**只测不写**：壳包着相机，写进深度会把后面所有模型拒掉；
 *   5. 2D puppet（keepZ:false）不碰深度状态（层间按 z 序 + 混合合成，别被深度裁掉）；
 *   6. 接线：宿主把 `layer.isSkybox` 传进绘制 opts（少了它第 4 条形同虚设）；
 *   7. 帧首仍有统一的 `clear(COLOR|DEPTH)` 且**先开写掩码再清**（共享深度缓冲的干净起点）。
 *   8. **2D 场景里的真 3D 网格**（F51）：材质显式写 `depthtest:"enabled"` 的层（编辑器导入的
 *      OBJ/模型，宿主标 `layer.depthMesh`）在非透视场景也保留 z 并开深度 —— 否则 z 被压平、
 *      深度不参与，自遮挡退化成三角形顺序（用户报的「导入后和原型有差距」）。
 *
 * 改坏的形态与转红项：把 clear 加回 keepZ 分支 → ① 红；删掉 enable(DEPTH_TEST) → ② 红；
 * `depthMask(!opts.skybox)` 改成 `depthMask(true)` → ④ 红；去掉宿主的 skybox 接线 → ⑥ 红；
 * 去掉 keepZ / useDepth 的 depthMesh 分支、或把宿主的「显式 enabled」判据放宽成 F40 口径 → ⑧ 红。
 */
import fs from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, createChecker } from "./lib/verify-kit.mjs";

const { check, errors } = createChecker({ echo: true });

// ───────────────────────── 记录型假 GL ─────────────────────────
// 只做三件事：给常量、给「必须返回真值」的少数几个调用、其余全部记录。不做任何 GL 语义
// 模拟（不判深度、不做光栅化）——本 verifier 断言的是**引擎发出的调用序列**。
function makeMockGL() {
  const log = [];
  const K = {
    MAX_VERTEX_UNIFORM_VECTORS: 0x8869,
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    DEPTH_TEST: 0x0b71,
    LEQUAL: 0x0203,
    LESS: 0x0201,
    BLEND: 0x0be2,
    SRC_ALPHA: 0x0302,
    ONE_MINUS_SRC_ALPHA: 0x0303,
    ONE: 1,
    ZERO: 0,
    TEXTURE0: 0x84c0,
    TEXTURE_2D: 0x0de1,
    ARRAY_BUFFER: 0x8892,
    ELEMENT_ARRAY_BUFFER: 0x8893,
    FLOAT: 0x1406,
    STATIC_DRAW: 0x88e4,
    TRIANGLES: 0x0004,
    UNSIGNED_INT: 0x1405,
    UNSIGNED_SHORT: 0x1403,
    DEPTH_BUFFER_BIT: 0x00000100,
    COLOR_BUFFER_BIT: 0x00004000,
  };
  const gl = { ...K };
  // 必须返回真值/对象的少数几个
  gl.getParameter = () => 256;
  gl.createShader = () => ({ kind: "shader" });
  gl.createProgram = () => ({ kind: "program" });
  gl.createVertexArray = () => ({ kind: "vao" });
  gl.createBuffer = () => ({ kind: "buffer" });
  gl.getUniformLocation = (_p, name) => ({ name });
  gl.getShaderParameter = () => true;
  gl.getProgramParameter = () => true;
  gl.getShaderInfoLog = () => "";
  gl.getProgramInfoLog = () => "";
  // 其余：记录型 no-op
  for (const m of [
    "clear", "clearDepth", "clearColor", "depthMask", "depthFunc", "enable", "disable",
    "blendFunc", "blendFuncSeparate", "useProgram", "uniform1f", "uniform1i", "uniform2f",
    "uniform3f", "uniform4f", "uniform3fv", "uniform4fv", "uniformMatrix3fv", "uniformMatrix4fv", "activeTexture",
    "bindTexture", "bindVertexArray", "bindBuffer", "bufferData", "enableVertexAttribArray",
    "disableVertexAttribArray", "vertexAttribPointer", "vertexAttrib3f", "drawElements",
    "drawArrays", "attachShader", "detachShader", "bindAttribLocation", "linkProgram",
    "shaderSource", "compileShader", "deleteShader", "deleteProgram", "generateMipmap",
    "pixelStorei", "texParameteri",
  ]) {
    gl[m] = (...a) => log.push({ name: m, args: a });
  }
  gl.__log = log;
  return gl;
}

const mdlMath = await import(pathToFileURL(join(ROOT, "renderer/vendor/we-scene/render/mdl.js")).href);
const { createMDLRenderer } = mdlMath;

function fakeMesh() {
  return {
    vertexCount: 3,
    indexCount: 3,
    indexType: "u16",
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
    boneIdx: new Float32Array(12),
    weights: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
    normals: null,
    tangents: null,
    uv2: null,
    indices: new Uint16Array([0, 1, 2]),
    materials: [],
    parts: null,
  };
}
/** 单网格 mdl（走 legacyMeshOf 伪网格路径） */
function fakeMDL() {
  const m = fakeMesh();
  return {
    bones: [],
    meshes: null,
    positions: m.positions,
    uvs: m.uvs,
    boneIdx: m.boneIdx,
    weights: m.weights,
    normals: null,
    tangents: null,
    uv2: null,
    vertexCount: m.vertexCount,
    indices: m.indices,
    indexCount: m.indexCount,
    indexType: "u16",
    materialPath: null,
    parts: null,
  };
}

const MVP = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** 在 log 里找「某次 drawElements 之后、下一次 drawElements 之前」的窗口 */
function betweenDraws(log) {
  const idx = [];
  for (let i = 0; i < log.length; i++) if (log[i].name === "drawElements") idx.push(i);
  const windows = [];
  for (let k = 0; k + 1 < idx.length; k++) windows.push(log.slice(idx[k], idx[k + 1]));
  return windows;
}
const hasDepthClear = (calls) =>
  calls.some((c) => c.name === "clear" && (c.args[0] & 0x100) !== 0);
const masks = (calls) => calls.filter((c) => c.name === "depthMask").map((c) => !!c.args[0]);
const names = (calls) => calls.map((c) => c.name);

// ───────────────── ① 核心：两个模型之间不出现「清深度」 ─────────────────
{
  const gl = makeMockGL();
  const r = createMDLRenderer(gl);
  const a = fakeMDL(), b = fakeMDL();
  gl.__log.length = 0;
  r.draw(MVP, a, { keepZ: true }, null);   // 近处模型（猫）
  const firstPass = betweenDraws(gl.__log);
  r.draw(MVP, b, { keepZ: true }, null);   // 远处模型（城市，层序在后）
  check(gl.__log.length > 0, "画两次 keepZ 模型有 GL 调用（前置：假 GL 接上了真渲染器）");
  check(!hasDepthClear(gl.__log),
    "keepZ 路径又在画模型前清深度了：先画的模型被抹出深度缓冲 ⇒ 后画的模型无条件盖住它（3477054430 城市盖住猫，F49）");
  const inner = betweenDraws(gl.__log);
  const cross = inner.filter((w) => hasDepthClear(w.slice(1))).length;
  check(cross === 0, "两次模型绘制之间没有 clear(DEPTH_BUFFER_BIT)（层间遮挡交给深度测试）");
  // 两次绘制各自都要开测试
  const enableCount = gl.__log.filter((c) => c.name === "enable" && c.args[0] === gl.DEPTH_TEST).length;
  const funcCount = gl.__log.filter((c) => c.name === "depthFunc" && c.args[0] === gl.LEQUAL).length;
  check(enableCount >= 2, `每个 keepZ 模型都 enable(DEPTH_TEST)（实测 ${enableCount} 次）`);
  check(funcCount >= 2, `每个 keepZ 模型都 depthFunc(LEQUAL)（实测 ${funcCount} 次）`);
  void firstPass;
}

// ───────────────── ② keepZ 模型自己必须写深度 ─────────────────
{
  const gl = makeMockGL();
  const r = createMDLRenderer(gl);
  gl.__log.length = 0;
  r.draw(MVP, fakeMDL(), { keepZ: true }, null);
  const order = names(gl.__log);
  const maskIdx = order.indexOf("depthMask");
  const drawIdx = order.indexOf("drawElements");
  const maskTrue = gl.__log.some((c) => c.name === "depthMask" && c.args[0] === true);
  const maskFalseAfter = gl.__log.some((c, i) => c.name === "depthMask" && c.args[0] === false && i > drawIdx);
  check(maskTrue, "keepZ 模型画之前打开了深度写掩码（depthMask(true)）");
  check(maskIdx >= 0 && maskIdx < drawIdx, "深度写掩码在 drawElements 之前打开");
  check(maskFalseAfter, "画完复位 depthMask(false)（否则框缓冲别的绘制路径会被写深度）");
  check(order.includes("disable"), "画完关掉 DEPTH_TEST（2D 图层不能被残留深度状态裁掉）");
}

// ───────────────── ③ 天空盒：只测不写 ─────────────────
{
  const gl = makeMockGL();
  const r = createMDLRenderer(gl);
  gl.__log.length = 0;
  r.draw(MVP, fakeMDL(), { keepZ: true, skybox: true }, null);
  const ms = masks(gl.__log);
  check(ms.length > 0, "天空盒绘制确实走了 keepZ 深度分支（前置）");
  check(ms.every((m) => m === false),
    "天空盒写深度了：它的壳包着相机，会把后面所有模型整片拒掉（F49；与 F40 的天空盒规则一致）");
  const enableCount = gl.__log.filter((c) => c.name === "enable" && c.args[0] === gl.DEPTH_TEST).length;
  check(enableCount >= 1, "天空盒仍参与深度**测试**（只是不写）");
}

// ───────────────── ④ 2D puppet 不碰深度状态 ─────────────────
{
  const gl = makeMockGL();
  const r = createMDLRenderer(gl);
  const order = [];
  gl.__log.length = 0;
  r.draw(MVP, fakeMDL(), {}, null); // keepZ 缺省 false = 2D puppet
  const enableDepth = gl.__log.some((c) => c.name === "enable" && c.args[0] === gl.DEPTH_TEST);
  check(!enableDepth,
    "2D puppet（keepZ:false）开了深度测试：网格 z 是建模残留，会被其它层按深度裁掉（3737267090 人物）");
  check(masks(gl.__log).length === 0, "2D puppet 不该动深度写掩码");
  check(!hasDepthClear(gl.__log), "2D puppet 不该清深度缓冲");
  void order;
}

// ───────────────── ⑤ 多子网格模型（mdl.meshes）同样只清一次都不清 ─────────────────
{
  const gl = makeMockGL();
  const r = createMDLRenderer(gl);
  const multi = { ...fakeMDL(), meshes: [fakeMesh(), fakeMesh()] };
  gl.__log.length = 0;
  r.draw(MVP, multi, { keepZ: true }, null);
  r.draw(MVP, fakeMDL(), { keepZ: true }, null);
  check(!hasDepthClear(gl.__log), "多子网格 keepZ 模型仍会清深度（子网格之间同样不该清，F49）");
  const draws = gl.__log.filter((c) => c.name === "drawElements").length;
  check(draws >= 3, `多子网格逐个画（2 网格 + 1 单网格 = ${draws} 次 drawElements）`);
}

// ───────────────── ⑥ 接线：宿主把 isSkybox 传下来 ─────────────────
{
  const rsrc = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/renderer.js"), "utf8");
  check(/skybox:\s*!!layer\.isSkybox/.test(rsrc),
    "宿主未把 layer.isSkybox 传给绘制 opts（天空盒护栏失效，F49）");
  // 帧首统一清：COLOR|DEPTH 一起清，且**先开写掩码再清**（否则清不动，见 pitfalls 掩码陷阱）
  const clearAt = rsrc.indexOf("gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)");
  check(clearAt >= 0, "帧首没有统一清 COLOR|DEPTH（共享深度缓冲没有干净起点，F49）");
  if (clearAt >= 0) {
    const before = rsrc.slice(Math.max(0, clearAt - 400), clearAt);
    check(/gl\.depthMask\(true\)/.test(before), "帧首清深度前没先开写掩码（掩码为 false 时 clear 等于没清）");
  }
}

// ───────────────── ⑦ 子网格顺序：声明不透明的先画（F50） ─────────────────
//
// 3477054430 的树卡片（贴图 65% 像素 alpha=0、材质**没声明** blending）在文件序里排在
// 楼房（声明 `blending: normal`）之前，它的透明像素写进深度 ⇒ 后画的楼房整片被拒
// ⇒ 每棵树四周一个黑方块。修法：真 3D 模型内按「声明了 normal 的先画、其余后画」排。
// 这里用记录型假 GL 直接看**两次 drawElements 的先后**（不是看源码文本）。
{
  const gl = makeMockGL();
  const r = createMDLRenderer(gl);
  const m0 = fakeMesh(); m0.indexCount = 3;
  const m1 = fakeMesh(); m1.indexCount = 6;
  const multi = { ...fakeMDL(), meshes: [m0, m1] };
  // mesh0 = 未声明（树），mesh1 = normal（楼房）⇒ 期望先画 6 后画 3
  gl.__log.length = 0;
  r.draw(MVP, multi, { keepZ: true, meshBlending: [null, "normal"] }, null);
  const seq = gl.__log.filter((c) => c.name === "drawElements").map((c) => c.args[1]);
  check(seq.length === 2, `多子网格画了两次（实测 ${seq.length}）`);
  check(seq[0] === 6 && seq[1] === 3,
    `未按「声明不透明的先画」排序：实测顺序 ${JSON.stringify(seq)}（应为 [6,3] —— 3477054430 的楼房必须先于树卡片）`);

  // 两类同类时不重排（文件序）
  gl.__log.length = 0;
  r.draw(MVP, multi, { keepZ: true, meshBlending: [null, null] }, null);
  const seq2 = gl.__log.filter((c) => c.name === "drawElements").map((c) => c.args[1]);
  check(JSON.stringify(seq2) === JSON.stringify([3, 6]),
    `同类网格不该重排：实测 ${JSON.stringify(seq2)}（应为文件序 [3,6]）`);

  // 2D（keepZ:false）不重排：没有深度测试，绘制顺序就是合成顺序
  gl.__log.length = 0;
  r.draw(MVP, multi, { meshBlending: [null, "normal"] }, null);
  const seq3 = gl.__log.filter((c) => c.name === "drawElements").map((c) => c.args[1]);
  check(JSON.stringify(seq3) === JSON.stringify([3, 6]),
    `2D 场景（keepZ:false）不该重排子网格：实测 ${JSON.stringify(seq3)}（顺序即合成顺序）`);
}

// ───────────────── ⑧ 全透明像素不是遮挡物：着色器里必须真的 discard（F50） ─────────────────
{
  // 去注释再断言：把 discard 注释掉（本仓排查时的常见手法）必须照样转红
  const msrc = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/mdl.js"), "utf8").replace(/\/\/[^\n]*/g, "");
  check(/if \(t\.a \* u_color\.a < 0\.004\) discard;/.test(msrc),
    "模型片元着色器没有丢弃全透明像素：alpha=0 的卡片留白仍会写深度，把身后几何拒成黑块（F50）");
  check(/function meshDrawOrder/.test(msrc), "缺少 meshDrawOrder（F50 排序实现）");
  check(/opts\.keepZ \? meshDrawOrder\(list, opts\.meshBlending\) : null/.test(msrc),
    "排序没有按 keepZ 门控（2D 场景会被重排，绘制顺序即合成顺序）");
}

// ───────────────── ⑨ 接线：宿主必须把两个字段**转发进真渲染调用**（F49/F50 的断点） ─────────────────
//
// 踩过的坑：renderer 侧把 `skybox`/`meshBlending` 塞进 puppetDrawFn 的 opts，但真正调
// `mdlRenderer.draw` 的是 scene-mount 的 setPuppetRenderer 回调，它按字段挑着转发 ——
// 漏一行 = 规则在实机上从未生效（F49 的天空盒护栏就这么被吞掉的，而只断言两侧源码文本的
// 判据全绿）。所以这里把断言**钉在回调体内**（setPuppetRenderer 到 "puppet: ${mdlItems.length}"）。
{
  const hostSrc = fs.readFileSync(join(ROOT, "renderer/src/scene-mount.ts"), "utf8");
  const cbAt = hostSrc.indexOf("renderer.setPuppetRenderer(");
  const cbEnd = hostSrc.indexOf("puppet: ${mdlItems.length}", cbAt);
  const cb = cbAt >= 0 && cbEnd > cbAt ? hostSrc.slice(cbAt, cbEnd) : "";
  check(cb.length > 0, "找得到 setPuppetRenderer 回调体（F49/F50 接线断言的范围）");
  check(/meshBlending:\s*\(layer as any\)\.meshBlending \|\| null/.test(cb),
    "setPuppetRenderer 回调没有转发 meshBlending：F50 排序在实机上不生效（渲染侧收到 undefined）");
  check(/skybox:\s*!!layer\.isSkybox/.test(cb),
    "setPuppetRenderer 回调没有转发 skybox：F49 天空盒护栏在实机上不生效（曾被漏掉一轮）");
  check(/\(layer as any\)\.meshBlending = meshBlend/.test(hostSrc),
    "宿主没有把逐网格 blending 挂到图层上（meshBlending 表缺来源）");
  const rsrc = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/renderer.js"), "utf8");
  check(/meshBlending:\s*layer\.meshBlending \|\| null/.test(rsrc),
    "renderer 没把 layer.meshBlending 传进 puppetDrawFn opts（F50 断点之一）");
}

// ───────────────── ⑩ 场景雾：只对真 3D 生效、宿主两跳接线不断 ─────────────────
// 3477054430 的距离雾（远处楼房隐入夜色）。官方 generic4 默认 FOG=1；我们的通用网格程序
// 用 u_fogOn 开关，关着时片元整段短路（与改动前逐位一致）。
{
  const fogOn = (log) => log.filter((c) => c.name === "uniform1f" && c.args[0]?.name === "u_fogOn").map((c) => c.args[1]);
  const FOG = { eye: [0, 0, 0], dist: [6.53, 493.47, 0, 0.98], distColor: [0, 0, 0], height: null, heightColor: null };
  const MODEL = new Float32Array(MVP);
  const gl = makeMockGL();
  const r = createMDLRenderer(gl);
  gl.__log.length = 0;
  r.draw(MVP, fakeMDL(), { keepZ: true, fog: FOG, model: MODEL }, null);
  check(fogOn(gl.__log).at(-1) === 1, "透视场景 + 宿主给了雾与模型矩阵 → u_fogOn=1");
  check(gl.__log.some((c) => c.name === "uniform4fv" && c.args[0]?.name === "u_fogDist"), "开雾时上传了 u_fogDist");
  gl.__log.length = 0;
  r.draw(MVP, fakeMDL(), { fog: FOG, model: MODEL }, null);
  check(fogOn(gl.__log).at(-1) === 0, "2D 场景（无 keepZ）即使给了雾也不加（2D puppet 没有世界距离）");
  gl.__log.length = 0;
  r.draw(MVP, fakeMDL(), { keepZ: true }, null);
  check(fogOn(gl.__log).at(-1) === 0, "没给雾 → u_fogOn=0（每帧显式复位，不吃上一个模型的残留）");

  const msrc = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/mdl.js"), "utf8");
  check(/if \(u_fogOn > 0\.5\) fragColor = applySceneFog\(fragColor\);/.test(msrc), "片元着色器在最终颜色上应用场景雾");
  const hostSrc = fs.readFileSync(join(ROOT, "renderer/src/scene-mount.ts"), "utf8");
  const cbAt = hostSrc.indexOf("renderer.setPuppetRenderer(");
  const cb = cbAt >= 0 ? hostSrc.slice(cbAt, hostSrc.indexOf("puppet: ${mdlItems.length}", cbAt)) : "";
  check(/model:\s*o\.model/.test(cb), "setPuppetRenderer 回调没有转发 model：雾拿不到世界坐标");
  check(/\{\s*\.\.\.sceneFog,\s*eye:\s*o\.eye\s*\}/.test(cb), "setPuppetRenderer 回调没有转发 fog（含眼点）：场景雾在实机上不生效");
  check(/\[s,\s*e - s \|\| 1e-4,\s*ds,\s*de - ds\]/.test(hostSrc), "雾参数换算应为 (start, end-start, startDensity, endDensity-startDensity)");
  const rsrc = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/renderer.js"), "utf8");
  check(/eye:\s*cam && cam\.perspective && cam\.eye \? cam\.eye : null/.test(rsrc), "renderer 没把透视相机眼点传进 puppetDrawFn opts");
}

// ───────────────── ⑪ 2D 场景里的真 3D 网格：材质显式声明 depthtest 才放行深度（F51） ─────────────────
//
// 用户报「导入 OBJ 渲染出来和原型有差距」：2D 正交壁纸里导入的模型走 puppet 形态，而 2D 场景
// 一律 keepZ=false / useDepth=false —— z 被压平、深度测试整个不参与，自遮挡退化成「按三角形
// 顺序画」：头套盖住脸和头发、手臂 / 黑上衣 / 鞋被自己朝后的那半边糊掉（实测截图对比原型差得
// 很远）。修法是**按材质声明**：材质里显式写 depthtest:"enabled" 的层（编辑器导入的模型就是
// 这么写的，puppet / mesh 两形态都写）在 2D 场景也开深度；WE 自家 2D 精灵的 puppet 材质写的是
// disabled 或不写（实测本机 357 张壁纸、385 个 puppet 材质无一声明 enabled），既有壁纸不变。
// 判据必须是「显式 enabled」，不是 F40 的 `!== "disabled"`：2D 场景里不声明深度的层很多，
// 放宽会让它们按无意义的建模残留 z 重排层间遮挡。
{
  const rsrc = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/renderer.js"), "utf8");
  // 去注释再断言（把新分支注释掉是本仓排查时的常见手法），并检查原文（注释里也有同样的表达式）
  const rc = rsrc.replace(/\/\/[^\n]*/g, "");
  check(/keepZ:\s*!!\(cam && cam\.perspective\) \|\| \(!!layer\.depthMesh && !layer\.isSkybox\)/.test(rc),
    "drawPuppetDirect 的 keepZ 没带上 depthMesh：2D 场景里声明了 depthtest 的 3D 网格又被压平 ⇒ 自遮挡按三角形顺序（F51）");
  check(/const useDepth = !!\(cam && cam\.perspective\) \|\| \(!!layer\.depthMesh && !isSkybox\)/.test(rc),
    "材质路径的 useDepth 没带上 depthMesh：2D 场景里声明了 depthtest 的自定义着色器 3D 网格没有深度（F51）");
  check(/layer\.depthMesh && !layer\.isSkybox/.test(rc) && /!!layer\.depthMesh && !isSkybox/.test(rc),
    "天空盒兜底没跟上新分支：天空盒包着相机，放它写深度会把全场拒掉（F49 的老问题）");

  const hostSrc = fs.readFileSync(join(ROOT, "renderer/src/scene-mount.ts"), "utf8");
  const rule = /String\((?:pass0|ppass0)\?\.depthtest \?\? ""\)\.toLowerCase\(\) === "enabled"\) \(layer as any\)\.depthMesh = true;/g;
  const hits = [...hostSrc.matchAll(rule)];
  check(hits.length === 2, `宿主标 layer.depthMesh 的装配分支不是 2 处（实测 ${hits.length}：puppet / model 各要一处）`);
  check(/const pmatEntry = await readAsset\(mdlObj\.materialPath\);/.test(hostSrc) && /const pass0 = material\?\.passes\?\.\[0\]/.test(hostSrc),
    "puppet 分支没读材质 json（puppet 层此前完全不看材质 ⇒ 拿不到 depthtest 声明）");
  check(!/depthtest !== "disabled"[\s\S]{0,80}depthMesh/.test(hostSrc) && !/depthMesh[\s\S]{0,80}depthtest !== "disabled"/.test(hostSrc),
    "宿主给 depthMesh 用了 F40 的 `!== \"disabled\"` 口径：2D 场景里未声明深度的层会被一起放行（按建模残留 z 重排遮挡）");

  // 变异：去掉 renderer 侧的分支、把宿主判据放宽 —— 对应的判据必须变红（新判据不是空断言）
  check(rc.replace(" || (!!layer.depthMesh && !layer.isSkybox)", "") !== rc, "注入点存在（keepZ 的 depthMesh 分支）");
  check(hostSrc.replace(rule, "(layer as any).depthMesh = true;") !== hostSrc, "注入点存在（宿主 depthMesh 的显式 enabled 判据）");
}

// ───────────────── ⑫ 单子网格模型的法线：也要认 meshes[0]（F52） ─────────────────
//
// 编辑器导入的 puppet 形态把全部图元并成一个网格（`models/editor/*.mdl`）——它的文档级
// `normals` 是 null，法线只写在唯一那条网格记录上。而 meshListOf 只在 meshes.length > 1 时
// 才走子网格列表，于是模型落到 legacyMeshOf 的伪网格上，**两条路都拿不到法线**：逐网格
// u_lightOn 恒为 0 ⇒ 只有形体、没有独立反照率的特征（手办的鼻子/嘴、卡通角色的腮与衣褶）
// 完全不显形（用户报「人物的鼻子和嘴巴没渲染出来」），材质路径的 a_Normal/a_Tangent4 也拿不到。
// 判据是**行为**：同一份几何，法线放在 meshes[0] 与放在文档级都必须点亮 u_lightOn。
{
  const lightOn = (log) =>
    log.filter((c) => c.name === "uniform1f" && c.args[0]?.name === "u_lightOn").map((c) => c.args[1]);
  const LIGHT = { dir: [0, 1, 0], base: [0.5, 0.5, 0.5], add: [0.5, 0.5, 0.5] };
  const NRM = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const drawWith = (doc) => {
    const gl = makeMockGL();
    const r = createMDLRenderer(gl);
    gl.__log.length = 0;
    r.draw(MVP, doc, { keepZ: true, sceneLight: LIGHT }, null);
    return lightOn(gl.__log).at(-1);
  };
  const subOnly = fakeMDL();
  subOnly.meshes = [{ ...fakeMesh(), normals: NRM }];
  check(drawWith(subOnly) === 1,
    "单子网格模型的法线只在 meshes[0] 上时没被认（u_lightOn=0）：只有形体的特征完全不显形（F52）");
  const docLevel = fakeMDL();
  docLevel.normals = NRM;
  check(drawWith(docLevel) === 1, "文档级法线（WE 自家单网格素材）没点亮 u_lightOn（F52 回归）");
  check(drawWith(fakeMDL()) === 0, "没有任何法线时不该点亮 u_lightOn（会拿常量 (0,0,1) 当法线做光照）");

  const mjs = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/mdl.js"), "utf8");
  check(/const singleSub = mdl\.meshes && mdl\.meshes\.length === 1/.test(mjs) &&
    /normals:\s*mdl\.normals \|\| singleSub\?\.normals \|\| null/.test(mjs),
    "缺少 meshes[0] 法线回落（F52 实现）");
  check(mjs.replace(" || singleSub?.normals || null", " || null") !== mjs, "注入点存在（单子网格法线回落）");
}

console.log(
  errors.length === 0
    ? "verify-mdl-depth: 全部通过 ✓"
    : `verify-mdl-depth: ${errors.length} 项失败 ✗`,
);
process.exit(errors.length === 0 ? 0 : 1);
