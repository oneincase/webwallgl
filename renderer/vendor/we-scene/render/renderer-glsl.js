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

// [we-scene patch] WE 的 32 个混合模式 GLSL 实现（编号同 common_blending.h）。
//
// **放在引擎 .js 层而不是 headers.ts**，因为两处都要用同一份：
//   - 效果 shader 的 `#include "common_blending.h"`（headers.ts 供源）
//   - 图层 colorBlendMode 的画布合成（本文件的 COMPOSITE_BLEND_FRAG）
// headers.ts 是 TS，引擎 .js 不能 import 它（verify-arch 要求引擎模块 Node 直载），
// 反过来 headers.ts import 本文件是允许的方向。复制成两份必然发散 —— 32 个模式
// 的代数细节（哪些模式不套 opacity 二次加权）改一处漏一处，画面错了还查不出来。
const WE_BLENDING_GLSL = `// WE common_blending.h（重建子集）
vec3 weBlendOverlay(vec3 a, vec3 b) {
    return vec3(
        a.r < 0.5 ? 2.0 * a.r * b.r : 1.0 - 2.0 * (1.0 - a.r) * (1.0 - b.r),
        a.g < 0.5 ? 2.0 * a.g * b.g : 1.0 - 2.0 * (1.0 - a.g) * (1.0 - b.g),
        a.b < 0.5 ? 2.0 * a.b * b.b : 1.0 - 2.0 * (1.0 - a.b) * (1.0 - b.b));
}
vec3 weBlendSoftLight(vec3 a, vec3 b) {
    return vec3(
        b.r < 0.5 ? 2.0 * a.r * b.r + a.r * a.r * (1.0 - 2.0 * b.r) : sqrt(a.r) * (2.0 * b.r - 1.0) + 2.0 * a.r * (1.0 - b.r),
        b.g < 0.5 ? 2.0 * a.g * b.g + a.g * a.g * (1.0 - 2.0 * b.g) : sqrt(a.g) * (2.0 * b.g - 1.0) + 2.0 * a.g * (1.0 - b.g),
        b.b < 0.5 ? 2.0 * a.b * b.b + a.b * a.b * (1.0 - 2.0 * b.b) : sqrt(a.b) * (2.0 * b.b - 1.0) + 2.0 * a.b * (1.0 - b.b));
}
float weBlendVivid(float a, float b) {
    if (b < 0.5) {
        float bb = 2.0 * b;
        return bb == 0.0 ? 0.0 : max(1.0 - (1.0 - a) / bb, 0.0);
    }
    float bb = 2.0 * (b - 0.5);
    return bb == 1.0 ? 1.0 : min(a / (1.0 - bb), 1.0);
}
// Reflect 单独成函数：Glow = Reflect(B,A)。GLSL 禁止递归，不能在 ApplyBlending
// 内部调 ApplyBlending(21, …)（整个函数会编译失败，效果被静默跳过）。
vec3 weBlendReflect(vec3 A, vec3 B) {
    return vec3(
        A.r == 1.0 ? 1.0 : min(B.r * B.r / (1.0 - A.r), 1.0),
        A.g == 1.0 ? 1.0 : min(B.g * B.g / (1.0 - A.g), 1.0),
        A.b == 1.0 ? 1.0 : min(B.b * B.b / (1.0 - A.b), 1.0));
}
vec3 RGBToHSL(vec3 c) {
    float fmin = min(c.r, min(c.g, c.b));
    float fmax = max(c.r, max(c.g, c.b));
    float delta = fmax - fmin;
    vec3 h = vec3(0.0);
    h.z = (fmax + fmin) / 2.0;
    if (delta == 0.0) {
        h.x = 0.0;
        h.y = 0.0;
    } else {
        h.y = h.z < 0.5 ? delta / (fmax + fmin) : delta / (2.0 - fmax - fmin);
        float deltaR = ((fmax - c.r) / 6.0 + delta / 2.0) / delta;
        float deltaG = ((fmax - c.g) / 6.0 + delta / 2.0) / delta;
        float deltaB = ((fmax - c.b) / 6.0 + delta / 2.0) / delta;
        if (c.r == fmax) h.x = deltaB - deltaG;
        else if (c.g == fmax) h.x = 1.0 / 3.0 + deltaR - deltaB;
        else if (c.b == fmax) h.x = 2.0 / 3.0 + deltaG - deltaB;
        if (h.x < 0.0) h.x += 1.0;
        else if (h.x > 1.0) h.x -= 1.0;
    }
    return h;
}
float weHueToRgb(float f1, float f2, float hue) {
    if (hue < 0.0) hue += 1.0;
    else if (hue > 1.0) hue -= 1.0;
    if (6.0 * hue < 1.0) return f1 + (f2 - f1) * 6.0 * hue;
    if (2.0 * hue < 1.0) return f2;
    if (3.0 * hue < 2.0) return f1 + (f2 - f1) * ((2.0 / 3.0 - hue) * 6.0);
    return f1;
}
vec3 HSLToRGB(vec3 h) {
    if (h.y == 0.0) return vec3(h.z);
    float f2 = h.z < 0.5 ? h.z * (1.0 + h.y) : h.z + h.y - h.y * h.z;
    float f1 = 2.0 * h.z - f2;
    return vec3(
        weHueToRgb(f1, f2, h.x + 1.0 / 3.0),
        weHueToRgb(f1, f2, h.x),
        weHueToRgb(f1, f2, h.x - 1.0 / 3.0));
}
// mode 编号同 WE common_blending.h（0=Normal … 32=LighterColor 的实现子集）
vec3 ApplyBlending(int mode, vec3 A, vec3 B, float opacity) {
    vec3 r;
    if (mode == 1) { r = min(B, A); }                       // Darken
    else if (mode == 2) { r = A * B; }                      // Multiply
    else if (mode == 3) {                                   // ColorBurn
        r = vec3(
            B.r == 0.0 ? 0.0 : max(1.0 - (1.0 - A.r) / B.r, 0.0),
            B.g == 0.0 ? 0.0 : max(1.0 - (1.0 - A.g) / B.g, 0.0),
            B.b == 0.0 ? 0.0 : max(1.0 - (1.0 - A.b) / B.b, 0.0));
    }
    else if (mode == 4 || mode == 20) { r = max(A + B - 1.0, vec3(0.0)); } // Substract
    else if (mode == 5) { r = min(A, B); }                  // LinearBurn
    else if (mode == 6) { r = max(B, A); }                  // Lighten
    else if (mode == 7) { r = 1.0 - (1.0 - A) * (1.0 - B); } // Screen
    else if (mode == 8) {                                   // ColorDodge
        r = vec3(
            B.r == 1.0 ? 1.0 : min(A.r / (1.0 - B.r), 1.0),
            B.g == 1.0 ? 1.0 : min(A.g / (1.0 - B.g), 1.0),
            B.b == 1.0 ? 1.0 : min(A.b / (1.0 - B.b), 1.0));
    }
    else if (mode == 9) { r = min(A + B, vec3(1.0)); }      // Add
    else if (mode == 10) { r = max(A, B); }                 // Lighter
    else if (mode == 11) { r = weBlendOverlay(A, B); }      // Overlay
    else if (mode == 12) { r = weBlendSoftLight(A, B); }    // SoftLight
    else if (mode == 13) { r = weBlendOverlay(B, A); }      // HardLight
    else if (mode == 14) {                                  // VividLight
        r = vec3(weBlendVivid(A.r, B.r), weBlendVivid(A.g, B.g), weBlendVivid(A.b, B.b));
    }
    else if (mode == 15) {                                  // LinearLight
        r = vec3(
            B.r < 0.5 ? max(A.r + 2.0 * B.r - 1.0, 0.0) : min(A.r + 2.0 * (B.r - 0.5), 1.0),
            B.g < 0.5 ? max(A.g + 2.0 * B.g - 1.0, 0.0) : min(A.g + 2.0 * (B.g - 0.5), 1.0),
            B.b < 0.5 ? max(A.b + 2.0 * B.b - 1.0, 0.0) : min(A.b + 2.0 * (B.b - 0.5), 1.0));
    }
    else if (mode == 16) {                                  // PinLight
        r = vec3(
            B.r < 0.5 ? min(A.r, 2.0 * B.r) : max(A.r, 2.0 * (B.r - 0.5)),
            B.g < 0.5 ? min(A.g, 2.0 * B.g) : max(A.g, 2.0 * (B.g - 0.5)),
            B.b < 0.5 ? min(A.b, 2.0 * B.b) : max(A.b, 2.0 * (B.b - 0.5)));
    }
    else if (mode == 17) {                                  // HardMix
        r = vec3(
            weBlendVivid(A.r, B.r) < 0.5 ? 0.0 : 1.0,
            weBlendVivid(A.g, B.g) < 0.5 ? 0.0 : 1.0,
            weBlendVivid(A.b, B.b) < 0.5 ? 0.0 : 1.0);
    }
    else if (mode == 18) { r = abs(A - B); }                // Difference
    else if (mode == 19) { r = A + B - 2.0 * A * B; }       // Exclusion
    else if (mode == 21) { r = weBlendReflect(A, B); }      // Reflect
    else if (mode == 22) { r = weBlendReflect(B, A); }      // Glow = Reflect(B,A)
    else if (mode == 23) { r = min(A, B) - max(A, B) + 1.0; }  // Phoenix
    else if (mode == 24) { r = (A + B) / 2.0; }             // Average
    else if (mode == 25) { r = 1.0 - abs(1.0 - A - B); }    // Negation
    else if (mode == 26) { r = HSLToRGB(vec3(RGBToHSL(B).x, RGBToHSL(A).y, RGBToHSL(A).z)); } // Hue
    else if (mode == 27) { r = HSLToRGB(vec3(RGBToHSL(A).x, RGBToHSL(B).y, RGBToHSL(A).z)); } // Saturation
    else if (mode == 28) { r = HSLToRGB(vec3(RGBToHSL(B).x, RGBToHSL(B).y, RGBToHSL(A).z)); } // Color
    else if (mode == 29) { r = HSLToRGB(vec3(RGBToHSL(A).x, RGBToHSL(A).y, RGBToHSL(B).z)); } // Luminosity
    else if (mode == 30) { r = mix(A, max(max(A.r, max(A.g, A.b)), 0.0) * B, opacity); } // Tint
    else if (mode == 31) { r = A + B * opacity; }           // Add(带 opacity 权重)
    else if (mode == 32) { r = mix(A, A + A * B, opacity); } // LinearDodge 变体
    else { r = mix(A, B, opacity); }                        // Normal(含 0)
    // CPU 参考（effects.js applyBlending）：5/10/30/31/32 直接返回不经 opacity 权重，
    // 其余统一 mix(A, r, opacity) 回归原色。
    //
    // [we-scene patch] **mode 0 也必须排除**：它的分支已经是 mix(A, B, opacity)，
    // 再套一层等于按 opacity² 加权。effects.js 的 default 分支是 switch 内直接
    // return mix3(A, B, opacity)、不走 per() 的二次加权，这里漏排了 0。
    // 症状极隐蔽：xray 的两张图是同一构图的不同版本（A≈B），平方后差异被压到
    // 肉眼与 readPixels 都读不出（实测 6 个 xray 壁纸像素差恰好为 0，
    // 而把最终输出换成中间量的探针显示 blend=187、sprite=187、mask.a=255 全都正常）。
    // 注意本文件是 TS 模板字符串，注释里不能出现反引号。
    if (mode != 0 && mode != 5 && mode != 10 && mode != 30 && mode != 31 && mode != 32) {
        r = mix(A, r, opacity);
    }
    return r;
}`

// [we-scene patch] 图层 colorBlendMode 走 shader 侧混合：把背景当纹理读进来，
// 用 ApplyBlending 算出结果再直接写（GL 混合关掉）。
//
// 为什么必须回读背景：固定管线的 blendFunc 只能表达 dst 因子为
// ONE_MINUS_SRC_COLOR / SRC_COLOR / DST_COLOR 这种「原样的 src/dst」的线性组合，
// 而 ColorBurn/Overlay/SoftLight/HSL 系全是 dst 的非线性函数，无论怎么配因子都算不出来。
// 此前这 16 个模式一律回退 translucent —— 3287715210 的 7200x4800 渐变层
// （colorBlendMode=3 ColorBurn、JPEG 无 alpha 故恒为不透明）就这样把人物整张盖住，
// 用户看到的是「壁纸不显示人物」。
//
// u_Backdrop 是画布回读（captureBackdrop），u_BlendMode 是层的 colorBlendMode。
// A = 背景（dst），B = 本层颜色（src），opacity = 层 alpha × 效果链 alpha，
// 与 ApplyBlending(mode, A, B, opacity) 的参数序完全一致。
const COMPOSITE_BLEND_FRAG = `#version 300 es
precision mediump float;
in vec2 v_UV;
uniform sampler2D u_Tex;
uniform sampler2D u_Backdrop;
uniform int u_BlendMode;
uniform vec2 u_CanvasSize;
uniform float u_Opacity;
out vec4 fragColor;
${WE_BLENDING_GLSL}
void main() {
  vec4 src = texture(u_Tex, v_UV);
  // 背景按**片元的屏幕位置**采样：gl_FragCoord 原点在左下，与 copyTexImage2D
  // 得到的纹理坐标系一致，直接除画布尺寸即可（不要复用 v_UV —— 那是层 UV）。
  vec3 dst = texture(u_Backdrop, gl_FragCoord.xy / u_CanvasSize).rgb;
  vec3 r = ApplyBlending(u_BlendMode, dst, src.rgb, src.a * u_Opacity);
  // GL 混合已关闭：这里写出的就是最终像素，alpha 恒 1（画布无 alpha 通道）。
  fragColor = vec4(r, 1.0);
}`



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

export { COLOR_BLEND_GL, BLEND_PREP, WE_BLENDING_GLSL, COMPOSITE_BLEND_FRAG, COPY_VERT, COPY_FRAG, COMPOSITE_FRAG, BACKDROP_FRAG, layerQuadVerts, passQuadVerts, localQuadVerts, GL_TYPES }
