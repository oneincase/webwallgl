// 渲染器的 GL 数据常量（从 renderer.js 拆出）：对齐表、混合模式映射、内联 GLSL、
// quad 顶点布局、GL 枚举 → 名称表。
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
}
// [we-scene patch 3351179520] combo 替换会把 int 型 combo 值写成浮点字面量
// （BLENDMODE → 0.0），GLSL ES 没有 float→int 隐式转换，circular_text 等
// workshop shader 按 \`ApplyBlending(0.0, …)\` 调用会「no matching overloaded
// function found」整条 pass 报废。加一个 float 重载转回 int：已有调用点
// （int 字面量/uniform）仍精确命中原重载，不受影响。
vec3 ApplyBlending(float mode, vec3 A, vec3 B, float opacity) {
    return ApplyBlending(int(mode + 0.5), A, B, opacity);
}`

// [we-scene patch] 图层 colorBlendMode 走 shader 侧混合：把背景当纹理读进来，
// 用 ApplyBlending 算出结果再直接写（GL 混合关掉）。
// 为什么必须回读背景：固定管线的 blendFunc 只能表达 dst 因子为
// ONE_MINUS_SRC_COLOR / SRC_COLOR / DST_COLOR 这种「原样的 src/dst」的线性组合，
// 而 ColorBurn/Overlay/SoftLight/HSL 系全是 dst 的非线性函数，无论怎么配因子都算不出来。
// 此前这 16 个模式一律回退 translucent —— 3287715210 的 7200x4800 渐变层
// （colorBlendMode=3 ColorBurn、JPEG 无 alpha 故恒为不透明）就这样把人物整张盖住，
// 用户看到的是「壁纸不显示人物」。
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

// WE 场景设置「Bloom」在引擎里的真身是这条 util 材质链（linux-wallpaperengine
// 复刻同源：`downsample_quarter_bloom`(_rt_FullFrameBuffer→1/4) →
// `downsample_eighth_blur_v`(1/4→1/8) → `blur_h_bloom`(1/8→_rt_Bloom) →
// `combine`(scene+bloom)；原版 shader 全文见 assets/shaders/，逐行转写如下）：
//   亮部提取：4 抽头平均（无 gamma）→ `albedo *= saturate(max(r,g,b) - threshold)`
//   （软拐点，只保留超出 threshold 的能量）→ 饱和度 ×2（-gray + albedo*2）
//   → ×strength×tint **只乘一次**；模糊是能量守恒高斯，**不乘 strength**。
// ⚠ 2026-09-11 前误把 localeffects/Bloom(2822917890) 的 light_map 当真身：
// 「pow(2.2) + r+g+b 求和硬判定」让亮场景 90%+ 像素全值通过，叠加 blur 双程
// strength（strength²）→ 3791670523 / 3793592591 / 820654165 整屏冲白。
// HDR 家族（hdr=true + bloomhdr*）的真身是 fp16 金字塔 + combine_hdr，本次不动，
// metric=1 分支保持既有软窗口校准（对 4 张 HDR 壁纸实测对齐，见 CASEBOOK）。

const BLOOM_LIGHTMAP_VERT = `#version 300 es
in vec3 a_Position;
in vec2 a_TexCoord;
uniform vec2 u_Texel; // 1/场景纹理尺寸
uniform float u_Damp; // Feather（材质原字段 "Damp brightness"，默认 0.5）
out vec2 v_TexCoord[4];
out float v_Damp;
void main() {
  v_Damp = 1.0 + u_Damp * 0.1;
  gl_Position = vec4(a_Position, 1.0);
  vec2 offsets = u_Texel;
  v_TexCoord[0] = a_TexCoord - offsets;
  v_TexCoord[1] = a_TexCoord + vec2(offsets.x, -offsets.y);
  v_TexCoord[2] = a_TexCoord + vec2(-offsets.x, offsets.y);
  v_TexCoord[3] = a_TexCoord + offsets;
}`

const BLOOM_LIGHTMAP_FRAG = `#version 300 es
precision mediump float;
in vec2 v_TexCoord[4];
in float v_Damp;
uniform sampler2D u_Tex;
uniform float u_Alpha;
uniform float u_Strength;
uniform float u_Threshold;
// 0 = 经典家族（WE 引擎 downsample_quarter_bloom 逐行转写）
// 1 = HDR 家族（bloomhdr*）的 SDR 等效判定，见 renderer.js bloomPostParams 注释
uniform int u_Metric;
out vec4 fragColor;
void main() {
  vec3 lightMap = vec3(0.0);
  if (u_Strength > 0.001 && u_Alpha > 0.001) {
    if (u_Metric == 0) {
      // 引擎原文：4 抽头平均 → saturate(max 通道 - threshold) 软拐点
      // → 饱和度 ×2（-grayscale*sat + albedo*(1+sat)，sat=1）→ ×strength（一次）。
      // saturate 在 GLSL 不存在，clamp(x,0,1) 等价。
      vec3 albedo = texture(u_Tex, v_TexCoord[0]).rgb +
                    texture(u_Tex, v_TexCoord[1]).rgb +
                    texture(u_Tex, v_TexCoord[2]).rgb +
                    texture(u_Tex, v_TexCoord[3]).rgb;
      albedo *= 0.25;
      float scale = max(max(albedo.x, albedo.y), albedo.z);
      albedo *= clamp(scale - u_Threshold, 0.0, 1.0);
      float grayscale = dot(vec3(0.2989, 0.5870, 0.1140), albedo);
      albedo = -grayscale + albedo * 2.0;
      lightMap = max(vec3(0.0), albedo * u_Strength);
    } else {
      // HDR 家族既有校准（2646504847）：raw sRGB 亮度 + 软窗口。
      // strength 在此乘两次，补偿 blur 不再乘（与旧行为逐位一致）。
      float weight = 0.0;
      vec3 samplec;
      for (int i = 0; i < 4; ++i) {
        samplec = texture(u_Tex, v_TexCoord[i]).rgb;
        float w = smoothstep(u_Threshold - 0.2, u_Threshold + 0.4, dot(samplec, vec3(0.2126, 0.7152, 0.0722)));
        lightMap += samplec * w;
        weight += w;
      }
      lightMap = lightMap * max(0.001, mix(weight, 1.0, v_Damp)) / 4.0 * u_Strength * u_Strength;
    }
  }
  fragColor = vec4(lightMap, 1.0);
}`

const BLOOM_BLUR_VERT = `#version 300 es
in vec3 a_Position;
in vec2 a_TexCoord;
uniform vec2 u_Texel; // 1/源纹理尺寸
uniform vec2 u_Res;   // 源纹理尺寸
uniform float u_Radius; // Scatter
out vec2 v_TexCoord;
out vec2 v_SizeMultiplier;
void main() {
  vec2 ratio = u_Res * u_Texel;
  v_SizeMultiplier = u_Texel * vec2(1.0, ratio.x / ratio.y) * u_Radius;
  gl_Position = vec4(a_Position, 1.0);
  v_TexCoord = a_TexCoord;
}`

const BLOOM_BLUR_FRAG = `#version 300 es
precision mediump float;
in vec2 v_TexCoord;
in vec2 v_SizeMultiplier;
uniform sampler2D u_Tex;
uniform float u_Alpha;
uniform float u_Strength;
uniform float u_Iterations;
uniform vec2 u_Dir; // (1,0)=横向 / (0,1)=纵向
out vec4 fragColor;
void main() {
  vec4 albedo = vec4(0.0);
  if (u_Strength > 0.001 && u_Alpha > 0.001) {
    float divisor = 0.0, weight, n;
    float iterations = u_Iterations;
    for (int i = -15; i <= 15; i++) {
      if (abs(float(i)) > iterations) continue;
      n = float(i);
      vec2 offset = u_Dir * (n * v_SizeMultiplier);
      weight = exp(-abs(n) * 0.1);
      divisor += weight;
      albedo += texture(u_Tex, v_TexCoord + offset) * weight;
    }
    // 模糊只做能量守恒归一：strength 已在亮部提取段乘过（引擎原版
    // downsample_eighth_blur_v / blur_h_bloom 同样不乘 strength）。
    // 2026-09-11 前这里横/纵两趟各乘一次 → strength² 叠满全屏。
    albedo = albedo / divisor;
  }
  fragColor = albedo;
}`

const BLOOM_APPLY_FRAG = `#version 300 es
precision mediump float;
in vec2 v_UV;
uniform sampler2D u_Tex; // 模糊后的 bloom
uniform float u_Alpha;
uniform float u_Strength;
uniform vec3 u_Tint;
out vec4 fragColor;
void main() {
  vec3 bloom = texture(u_Tex, v_UV).rgb * u_Tint * u_Alpha;
  if (u_Strength <= 0.001) bloom = vec3(0.0);
  // Add（ApplyBlending 31）：rgb = base + bloom；GL 侧 blendFunc(ONE, ONE)，
  // dst 就是画布里的 base。alpha +0 = 保持场景 alpha（画布本就无 alpha 通道）。
  fragColor = vec4(bloom, 0.0);
}`


// [we-scene patch] HDR combine/tonemap（general.hdr=true）：把 fp16 场景目标
// （加法效果/粒子可 >1.0）映射回 SDR 画布。[0,1] 区间**恒等**——HDR 壁纸的
// 基础反照率与 SDR 像素一致，只有超过白点的能量做色相保持的高光 rolloff
// （max 通道映射到 1，其余按比例），避免直接硬裁切丢色/冲白。alpha 直通。
const TONEMAP_FRAG = `#version 300 es
precision highp float;
in vec2 v_UV;
uniform sampler2D u_Tex;
out vec4 fragColor;
void main() {
  vec4 src = texture(u_Tex, v_UV);
  vec3 c = src.rgb;
  float m = max(c.r, max(c.g, c.b));
  if (m > 1.0) {
    c /= 1.0 + (m - 1.0);
  }
  fragColor = vec4(c, src.a);
}`


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
// 为什么是仿射基而不是「子矩形 xy/zw」：TEXS 帧表本身存的就是一组基向量，
// 2623473016/Raiden Friends 末 3 帧是**旋转 90° 打包**的（uDir=(0,-600)、
// vDir=(338,0)），用矩形无法表达 —— 会取到错帧或糊成一片。
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

// [we-scene patch] 材质 LIGHTING combo 的**直射光**变体（官方 genericimage2/3/4 的
// `#if LIGHTING` 段逐行转写）。为什么必须新开一条纹理→画布/画布 FBO 的着色路径，
// 而不是像环境光那样在 JS 侧乘进 u_Color4：
//   PBR 的 L 向量是**逐像素**的（`L = 灯位置 - worldPos`，worldPos 随片元变化），
//   而灯是点光源、权重在几千像素的层上能差几倍 —— 整层乘同一个数会把「靠近灯的
//   一侧被照亮」压成均匀染色（2890473419 的人物卡 1504×3000，三盏灯的 d 从
//   ~700 到 ~1700）。
// 口径（官方 shader 明文 + Waple 逆向互证，不要再自创公式）：
//   - **两代灯走两条通道、两套衰减**（详见 renderer.js 的灯光通道注释与
//     `lightModelForShader`）：`l*` 前缀的 V1 灯供 generic4/genericimage4，
//     衰减 = `saturate(1−d/radius)^exponent`；不带前缀的 `point` 供
//     genericimage2，CPU 预乘 `color×intensity×radius²` 后 `radiance = 色/d²`。
//     `u_LightModel` 在两者间选路（0 = V1、1 = d²）。
//   - 公共尾巴 `(diffuse·albedo/π + specular·specularTint) × radiance × max(dot(N,L),0)`
//     照官方 common_pbr_2.h::ComputePBRLightShadow（镜面 GGX/Smith/Schlick 与
//     common_pbr.h 逐字相同；roughness=0 时 NDF 恒 0，只剩漫反射，2890473419
//     正是这个退化情形）。
//   - 合成：CombineLighting(light, ambient)，HDR 场景多一段 >2 的过曝项。
const COPY_LIT_VERT = `#version 300 es
in vec3 a_Position;
in vec2 a_TexCoord;
uniform mat4 u_MVP;
out vec2 v_UV;
out vec3 v_Local;
void main() {
  gl_Position = u_MVP * vec4(a_Position, 1.0);
  v_UV = a_TexCoord;
  v_Local = a_Position;
}`

const COPY_LIT_FRAG = `#version 300 es
precision highp float;
in vec2 v_UV;
in vec3 v_Local;
uniform sampler2D u_Tex;
uniform vec4 u_Color4;
uniform vec2 u_FrameOrigin;
uniform vec2 u_FrameU;
uniform vec2 u_FrameV;
uniform int u_BlendPrep;
uniform mat4 u_Model;          // 本趟局部空间 → 世界（与 u_LightPos 同空间）
uniform int u_LightCount;
uniform vec3 u_LightPos[4];
uniform vec3 u_LightColor[4];  // 官方 V1 打包：color × intensity（不预乘 radius²）
uniform float u_LightRadius[4];   // 官方 g_LPoint_Color[i].w
uniform float u_LightExponent[4]; // 官方 g_LPoint_Origin[i].w（只有 V1 模型读它）
uniform int u_LightModel;      // 0 = V1 falloff^exponent；1 = radius²/d²（见 lightRadiance）
uniform vec3 u_LightAmbient;   // g_LightAmbientColor（ambientcolor×π 封顶 1）
uniform float u_LightRoughness;
uniform float u_LightMetallic;
uniform int u_LightHdr;
out vec4 fragColor;

const float PI = 3.141592653589793;

vec3 fresnelSchlick(float cosTheta, vec3 f0) {
  return f0 + (1.0 - f0) * pow(max(1.0 - cosTheta, 0.001), 5.0);
}
float distributionGGX(vec3 N, vec3 H, float roughness) {
  float rSqr = roughness * roughness;
  float rSqr2 = rSqr * rSqr;
  float NH = max(dot(N, H), 0.0);
  float denom = NH * NH * (rSqr2 - 1.0) + 1.0;
  return rSqr2 / (PI * denom * denom);
}
float schlickGGX(float NV, float roughness) {
  float base = roughness + 1.0;
  float scaled = (base * base) / 8.0;
  return NV / (NV * (1.0 - scaled) + scaled);
}
float geoSmith(vec3 N, vec3 V, vec3 L, float roughness) {
  return schlickGGX(max(dot(N, V), 0.001), roughness) * schlickGGX(max(dot(N, L), 0.001), roughness);
}
// 官方两代灯的辐照度（均为「已含 intensity、未除 d²」的口径，详见 renderer.js 的灯光通道注释）：
//   模型 0 —— common_pbr_2.h::ComputePBRLightShadow（引擎生成的 PerformLighting_V1
//     调它，供 generic4/genericimage4）：radiance = 色 × saturate(1−d/radius)^exponent。
//     GLSL 分支的写法照抄官方（含 flt_min 与 step 门）：falloff 落到 0 时整项归零，
//     否则 pow(falloff + 6.103515625e-5, exponent)。
//   模型 1 —— common_pbr.h::ComputePBRLight 的 radiance = 色/d²，配 CPU 侧预乘
//     color×intensity×radius²（genericimage2 的 g_LightsColorPremultiplied、
//     genericimage3 的 g_LPoint_Color.rgb × .w × .w）。这里半径由着色器现乘，
//     与官方 CPU 预乘是同一个数。
vec3 lightRadiance(vec3 lightColor, float radius, float exponent, float distance, int model) {
  if (model == 0) {
    float falloff = clamp(1.0 - distance / max(radius, 0.0001), 0.0, 1.0);
    float fltMin = 6.103515625e-5;
    return lightColor * mix(0.0, pow(falloff + fltMin, exponent), step(0.0, falloff - fltMin));
  }
  return lightColor * (radius * radius) / max(distance * distance, 0.0001);
}
// 官方 common_pbr.h ComputePBRLight / common_pbr_2.h ComputePBRLightShadow 的公共尾巴：
// (diffuse·albedo/π + specular·specularTint) × radiance × max(dot(N,L),0)。
// specularTint 取 1：generic4 的调用点写死 CAST3(1.0)，genericimage4 传材质的
// speculartint，而全库 LIGHTING 材质没有一个设过它（声明默认 1 1 1）。
vec3 shadePBRLight(vec3 N, vec3 L, vec3 V, vec3 albedo, vec3 radiance, vec3 f0, float roughness, float metallic) {
  float distance = length(L);
  vec3 l = L / max(distance, 0.0001);
  vec3 H = normalize(V + l);
  float NDF = distributionGGX(N, H, roughness);
  float G = geoSmith(N, V, l, roughness);
  vec3 F = fresnelSchlick(max(dot(H, V), 0.0), f0);
  vec3 numerator = NDF * G * F;
  float NL = max(dot(N, l), 0.0);
  vec3 specular = numerator / max(4.0 * max(dot(N, V), 0.0) * NL, 0.001);
  vec3 diffuse = (1.0 - metallic) * (vec3(1.0) - F);
  return (diffuse * albedo / PI + specular) * radiance * NL;
}
// 官方 CombineLighting：HDR 场景对 >2 的过曝部分额外加权
vec3 combineLighting(vec3 light, vec3 ambient) {
  if (u_LightHdr == 0) return ambient + light;
  float len = length(light);
  float overbright = (clamp(len - 2.0, 0.0, 1.0) * 0.5) / max(0.01, len);
  return clamp(ambient + light, 0.0, 1.0) + light * overbright;
}

void main() {
  vec2 uv = u_FrameOrigin + v_UV.x * u_FrameU + v_UV.y * u_FrameV;
  // 官方顺序：albedo 先乘 g_Color4（版本 2 材质 = 层色×亮度），光照作用在它上面
  vec4 c = texture(u_Tex, uv) * u_Color4;
  vec3 albedo = c.rgb;
  // NORMALMAP=0 分支：法线 = 局部 +Z 经模型矩阵变换（全库 4 个 LIGHTING pass 的
  // NORMALMAP 都是 0，法线贴图分支不在本仓覆盖面内）
  vec3 worldPos = (u_Model * vec4(v_Local, 1.0)).xyz;
  vec3 N = normalize(mat3(u_Model) * vec3(0.0, 0.0, 1.0));
  vec3 V = vec3(0.0, 0.0, 1.0); // 正交场景：官方注释「用真实视向量在正交下很难看」
  float metallic = u_LightMetallic;
  float roughness = u_LightRoughness;
  vec3 f0 = mix(vec3(0.04), albedo, metallic);
  vec3 light = vec3(0.0);
  for (int i = 0; i < 4; i++) {
    if (i >= u_LightCount) break;
    vec3 lv = u_LightPos[i] - worldPos;
    vec3 radiance = lightRadiance(u_LightColor[i], u_LightRadius[i], u_LightExponent[i], length(lv), u_LightModel);
    light += shadePBRLight(N, lv, V, albedo, radiance, f0, roughness, metallic);
  }
  vec3 ambient = max(vec3(0.001), u_LightAmbient) * albedo;
  c.rgb = combineLighting(light, ambient);
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

// [we-scene patch] FXAA 抗锯齿（性能设置面板的 aa=fxaa 档）。
// 经典 reduced 版（9 抽头，Lottes FXAA 3.11 的精简形态）：luma 边缘方向估计 →
// 沿边缘方向模糊。选它而不是 12 抽头 quality 全量版的理由：壁纸内容绝大部分是
// 半透明纹理 quad（不是硬几何边），reduced 版的边缘搜索已足够，且帧末只多一趟
// 全屏 pass，代价恒定、无状态。MSAA 档走多重采样 FBO（renderer.js），不经这里。
// 输入是 captureBackdrop 的画布回读纹理（RGB8，无 alpha），输出直接覆盖画布，
// 所以 alpha 恒 1（画布上下文 alpha:false，写出 alpha 无意义）。
// 用 highp：4K 超采样下 UV 偏移量小，mediump（部分驱动 16bit）会在边缘方向
// 估计上出可见带状误差。
const FXAA_FRAG = `#version 300 es
precision highp float;
in vec2 v_UV;
uniform sampler2D u_Tex;
uniform vec2 u_Texel; // 1/width, 1/height
out vec4 fragColor;
void main() {
  const float SPAN_MAX = 8.0;
  const float REDUCE_MUL = 1.0 / 8.0;
  const float REDUCE_MIN = 1.0 / 128.0;
  const vec3 LUMA = vec3(0.299, 0.587, 0.114);
  vec3 rgbNW = texture(u_Tex, v_UV + vec2(-1.0, -1.0) * u_Texel).rgb;
  vec3 rgbNE = texture(u_Tex, v_UV + vec2( 1.0, -1.0) * u_Texel).rgb;
  vec3 rgbSW = texture(u_Tex, v_UV + vec2(-1.0,  1.0) * u_Texel).rgb;
  vec3 rgbSE = texture(u_Tex, v_UV + vec2( 1.0,  1.0) * u_Texel).rgb;
  vec3 rgbM  = texture(u_Tex, v_UV).rgb;
  float lumaNW = dot(rgbNW, LUMA);
  float lumaNE = dot(rgbNE, LUMA);
  float lumaSW = dot(rgbSW, LUMA);
  float lumaSE = dot(rgbSE, LUMA);
  float lumaM  = dot(rgbM,  LUMA);
  float lumaMin = min(lumaM, min(min(lumaNW, lumaNE), min(lumaSW, lumaSE)));
  float lumaMax = max(lumaM, max(max(lumaNW, lumaNE), max(lumaSW, lumaSE)));
  vec2 dir = vec2(
    -((lumaNW + lumaNE) - (lumaSW + lumaSE)),
     ((lumaNW + lumaSW) - (lumaNE + lumaSE)));
  float dirReduce = max((lumaNW + lumaNE + lumaSW + lumaSE) * (0.25 * REDUCE_MUL), REDUCE_MIN);
  float rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
  dir = min(vec2(SPAN_MAX), max(vec2(-SPAN_MAX), dir * rcpDirMin)) * u_Texel;
  vec3 rgbA = 0.5 * (
    texture(u_Tex, v_UV + dir * (1.0 / 3.0 - 0.5)).rgb +
    texture(u_Tex, v_UV + dir * (2.0 / 3.0 - 0.5)).rgb);
  vec3 rgbB = rgbA * 0.5 + 0.25 * (
    texture(u_Tex, v_UV + dir * -0.5).rgb +
    texture(u_Tex, v_UV + dir *  0.5).rgb);
  float lumaB = dot(rgbB, LUMA);
  fragColor = vec4((lumaB < lumaMin || lumaB > lumaMax) ? rgbA : rgbB, 1.0);
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

export { COLOR_BLEND_GL, BLEND_PREP, WE_BLENDING_GLSL, COMPOSITE_BLEND_FRAG, BACKDROP_FRAG, FXAA_FRAG, BLOOM_LIGHTMAP_VERT, BLOOM_LIGHTMAP_FRAG, BLOOM_BLUR_VERT, BLOOM_BLUR_FRAG, BLOOM_APPLY_FRAG, TONEMAP_FRAG, COPY_VERT, COPY_FRAG, COPY_LIT_VERT, COPY_LIT_FRAG, COMPOSITE_FRAG, layerQuadVerts, passQuadVerts, localQuadVerts, GL_TYPES }
