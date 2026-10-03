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
 *
 * 改坏的形态与转红项：把 clear 加回 keepZ 分支 → ① 红；删掉 enable(DEPTH_TEST) → ② 红；
 * `depthMask(!opts.skybox)` 改成 `depthMask(true)` → ④ 红；去掉宿主的 skybox 接线 → ⑥ 红。
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
    "uniform3f", "uniform4f", "uniformMatrix3fv", "uniformMatrix4fv", "activeTexture",
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

console.log(
  errors.length === 0
    ? "verify-mdl-depth: 全部通过 ✓"
    : `verify-mdl-depth: ${errors.length} 项失败 ✗`,
);
process.exit(errors.length === 0 ? 0 : 1);
