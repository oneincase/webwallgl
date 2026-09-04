// 渲染器的 GL 数据常量（从 renderer.js 拆出）：对齐表、混合模式映射、内联 GLSL、
// quad 顶点布局、GL 枚举 → 名称表。
//
// [we-scene patch] 全部是**纯数据/纯函数**，零闭包依赖；ALIGN 必须与 hittest.js
// 的几何约定保持单一真源（verify-pointer 读此表做命中回归）。
export const ALIGN = {
  center: [0.5, 0.5],
  // SceneScript 音频条模板常用英式拼写 centre（2652493753 Simple Visualizer）
  centre: [0.5, 0.5],
  left: [0, 0.5],
  right: [1, 0.5],
  top: [0.5, 0],
  bottom: [0.5, 1],
  topleft: [0, 0],
  topright: [1, 0],
  bottomleft: [0, 1],
  bottomright: [1, 1],
}

// 图层的 colorBlendMode（scene.json 的 colorBlendMode，语义同 common_blending.h 的
// blend mode 编号）→ 合成到画布时的 GL 混合模式。
// 只映射能用固定管线表达的几种；其余（Overlay/SoftLight 等需要读回目标色）
// 退回 translucent，与此前行为一致。
//
// 这一步不做的后果：像 3299228616 的 ripple1440p 水面层，贴图是一张几乎全黑、
// 靠 Add 混合只贡献亮部高光的图（colorBlendMode=9），若按 translucent 合成，
// 黑色像素会被当成不透明色直接糊住背景，看起来就是"一层黑色蒙版盖住了壁纸"。
const COLOR_BLEND_GL = {
  2: 'multiply', // Multiply
  6: 'additive', // Lighten（近似）
  7: 'screen', // Screen
  9: 'additive', // Add
  31: 'additive', // Add(带 opacity 权重)
}
// Screen/Multiply 的源色预处理档位，见 colorBlendPlan 的推导
const BLEND_PREP = { screen: 1, multiply: 2 }


// ---------- 内联着色器（拷贝 / 合成 / 背景直通）与 quad 顶点 ----------
const COPY_VERT = `#version 300 es
in vec3 a_Position;
in vec2 a_TexCoord;
uniform mat4 u_MVP;
out vec2 v_UV;
void main() {
  gl_Position = u_MVP * vec4(a_Position, 1.0);
  v_UV = a_TexCoord;
}`

// [we-scene patch] 序列帧的 UV 仿射基：u_FrameOrigin=帧原点，u_FrameU/V=两个基向量
// （都已归一化到图集尺寸）。采样点 = origin + u·uDir + v·vDir。
// 序列帧图层（material 的 combos 里 spritesheet=1，注意大小写两种写法都有）把整张
// sprite sheet 当贴图，但每帧只该采样其中一格。
// 默认 origin=(0,0)、uDir=(1,0)、vDir=(0,1) 即整图直通，不影响普通图层。
//
// 为什么是仿射基而不是「子矩形 xy/zw」：TEXS 帧表本身存的就是一组基向量，
// 2623473016/Raiden Friends 末 3 帧是**旋转 90° 打包**的（uDir=(0,-600)、
// vDir=(338,0)），用矩形无法表达 —— 会取到错帧或糊成一片。
//
// 不做这一步的后果：整张 sheet 被铺满整个 quad —— 3250755486 的猫在碎玻璃后
// 显示成 6x7 的贴图网格而不是逐帧动画。
// [we-scene patch] u_BlendPrep：Screen/Multiply 合成前的**源色预处理**（见 BLEND_PREP）。
// 固定管线的 dst 因子只能取 ONE_MINUS_SRC_COLOR 这种「原样的 src」，没法在因子里
// 再乘一次不透明度，所以 op 必须在 shader 里先合进 src.rgb，否则整条链就丢了 alpha。
const COPY_FRAG = `#version 300 es
precision mediump float;
in vec2 v_UV;
uniform sampler2D u_Tex;
uniform vec4 u_Color4;
uniform vec2 u_FrameOrigin;
uniform vec2 u_FrameU;
uniform vec2 u_FrameV;
uniform int u_BlendPrep;
out vec4 fragColor;
void main() {
  vec2 uv = u_FrameOrigin + v_UV.x * u_FrameU + v_UV.y * u_FrameV;
  vec4 c = texture(u_Tex, uv) * u_Color4;
  if (u_BlendPrep == 1) c.rgb *= c.a;
  else if (u_BlendPrep == 2) c.rgb = mix(vec3(1.0), c.rgb, c.a);
  fragColor = c;
}`

const COMPOSITE_FRAG = `#version 300 es
precision mediump float;
in vec2 v_UV;
uniform sampler2D u_Tex;
uniform int u_BlendPrep;
out vec4 fragColor;
void main() {
  vec4 c = texture(u_Tex, v_UV);
  if (u_BlendPrep == 1) c.rgb *= c.a;
  else if (u_BlendPrep == 2) c.rgb = mix(vec3(1.0), c.rgb, c.a);
  fragColor = c;
}`

// [we-scene patch] passthrough 层抓取背景用（见 drawBackdropToFBO）。
// **必须强制 alpha = 1**，不能复用 COPY_FRAG。
// 画布上下文是 `alpha: false`（见 main.ts 的 getContext），默认帧缓冲根本没有
// alpha 通道，拷出来的 alpha 实测恒为 **0**。而背景按定义是
// 不透明的，喂 scene.a=0 给效果链会让工坊 shader 全部走错分支：
//   audio_ring: lerp(glow, scene.rgb, 0) 返回 glow ⇒ 输出 glow*1.85 而非
//               backdrop+glow，且 alpha=scene.a=0 ⇒ 按 SRC_ALPHA 合成后整层消失
//               （实测 2134765860 音箱上的蓝色光环不见了）。
const BACKDROP_FRAG = `#version 300 es
precision mediump float;
in vec2 v_UV;
uniform sampler2D u_Tex;
out vec4 fragColor;
void main() {
  fragColor = vec4(texture(u_Tex, v_UV).rgb, 1.0);
}`

// quad 顶点（每顶点 5 float：x,y,z,u,v）
// WE 同款空间：层 FBO 内容倒置（FBO 顶=纹理底行），pass quad 顶 v=1（顶采顶直通），合成时再正过来。
function layerQuadVerts(w, h) {
  return new Float32Array([
    0, h, 0, 0, 1, // 层空间顶（y=h）采样 v=1（纹理底行）→ FBO 顶=纹理底（倒置，与 WE 一致）
    0, 0, 0, 0, 0,
    w, h, 0, 1, 1,
    w, h, 0, 1, 1,
    0, 0, 0, 0, 0,
    w, 0, 0, 1, 0,
  ])
}
function passQuadVerts() {
  return new Float32Array([
    -1, 1, 0, 0, 1, // NDC 顶 v=1（FBO 纹理 v=1=顶行，顶采顶直通）
    -1, -1, 0, 0, 0,
    1, 1, 0, 1, 1,
    1, 1, 0, 1, 1,
    -1, -1, 0, 0, 0,
    1, -1, 0, 1, 0,
  ])
}
function localQuadVerts() {
  return new Float32Array([
    -0.5, 0.5, 0, 0, 1, // local +y = 屏幕下方（y-down 世界）：屏幕底采样 v=1（FBO 顶=纹理底）→ 屏幕底=纹理底
    -0.5, -0.5, 0, 0, 0, // local -y = 屏幕上方：屏幕顶采样 v=0（FBO 底=纹理顶）→ 屏幕顶=纹理顶（正立）
    0.5, 0.5, 0, 1, 1,
    0.5, 0.5, 0, 1, 1,
    -0.5, -0.5, 0, 0, 0,
    0.5, -0.5, 0, 1, 0,
  ])
}

const GL_TYPES = {
  0x1406: 'float', // FLOAT
  0x8b50: 'vec2', // FLOAT_VEC2
  0x8b51: 'vec3', // FLOAT_VEC3
  0x8b52: 'vec4', // FLOAT_VEC4
  0x1404: 'int', // INT
  0x8b53: 'ivec2',
  0x8b54: 'ivec3',
  0x8b55: 'ivec4',
  0x8b56: 'bool',
  0x8b5c: 'mat4', // FLOAT_MAT4
  0x8b5b: 'mat3', // FLOAT_MAT3
}

export { COLOR_BLEND_GL, BLEND_PREP, COPY_VERT, COPY_FRAG, COMPOSITE_FRAG, BACKDROP_FRAG, layerQuadVerts, passQuadVerts, localQuadVerts, GL_TYPES }
