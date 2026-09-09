/**
 * WE（Wallpaper Engine）官方公共 shader 头的重建子集。
 * 场景 pkg 内嵌 shader 缺失 `#include "common.h"` 等公共头时由 ScenePreview 提供。
 * 仅包含 GLSL 内置函数之外的 WE 辅助函数（避免与 GLSL 内建冲突）。
 *
 * [we-scene patch] 这里**不要**定义 hlsl2glsl 已经按名改写的辅助函数：
 *   - `saturate(x)` 会被 rewriteCall 改写成 `clamp(x, 0.0, 1.0)`；
 *   - `lerp` 会被整词替换成 `mix`。
 * 若在此定义它们，声明本身会被一起改写 —— 例如
 *   `float saturate(float x)` → `float clamp(float x, 0.0, 1.0)`（语法错误）、
 *   `float lerp(...) { return mix(...); }` → `float mix(...) { return mix(...); }`（非法递归），
 * 整个 shader 编译失败后效果被静默跳过（表现：人物不眨眼、水波/摇曳全失效）。
 */
import { WE_BLENDING_GLSL } from "./render/renderer-glsl.js";

export const WE_SHADER_HEADERS: Record<string, string> = {
  'common.h': `// WE common.h（重建子集，供 we-scene 浏览器渲染）
#define M_PI 3.14159265359
// M_PI_2 是「PI × 2」而不是「PI ÷ 2」—— 名字极易读反，此前误写成 1.5708，
// 影响全库 142 个文件（64 个壁纸）。三条独立证据：
//   1. shake.frag: sin(frac(t / M_PI_2) * M_PI_2) —— frac(t/K)*K 即 mod(t,K)，
//      sin(mod(t,K)) == sin(t) 仅当 K 是正弦周期 2π；写成 π/2 则每 1/4 周期
//      出现一次断点（表现为 shake 效果规律性抖动），且与紧邻的 cos(time) 相位不一致；
//   2. circular_text.frag: (atan2(y,x) + M_PI) / M_PI_2 —— 分子域为 [0,2π]，
//      下一行按 mod(x, 1.0) 取小数且起始角来自 deg × (1/360)，即单位是「圈」，
//      故必须除以 2π 才落在 [0,1]；除以 π/2 会让文字沿环重复 4 次；
//   3. shine_cast.vert: EDGES==3 用 M_PI_2 * 0.3333 / 0.6666 排三条光边，
//      只有整圈的 1/3、2/3 才等分；同文件 EDGES==4 反而不用这个常量
//      （90° 直接写 vec2(-y, x)）—— 作者清楚它是整圈。
// 反向证据为 0：全库没有任何文件按 π/2 才成立。
// 另有壁纸 3436945972 的作者在同一文件里自定义 \`#define M_PI_D2 1.5707963...  // PI / 2\`，
// 正说明 common.h 的 M_PI_2 不是 π/2，否则无需另起一个名字。
#define M_PI_2 6.28318530718
// 真正的 π/2 在 WE 里叫 M_PI_HALF（本机库暂无引用，补全以对齐真实头的符号面）
#define M_PI_HALF 1.57079632679
vec2 rotateVec2(vec2 v, float a) {
    float c = cos(a);
    float s = sin(a);
    return vec2(v.x * c - v.y * s, v.x * s + v.y * c);
}
float rand(vec2 n) { return fract(sin(dot(n, vec2(12.9898, 78.233))) * 43758.5453); }
float rand(vec2 n, float m) { return 0.5 + 0.5 * rand(n * m); }
float smoothstep01(float x) { return smoothstep(0.0, 1.0, x); }
vec2 smoothstep01(vec2 x) { return smoothstep(vec2(0.0), vec2(1.0), x); }
vec3 smoothstep01(vec3 x) { return smoothstep(vec3(0.0), vec3(1.0), x); }
vec4 smoothstep01(vec4 x) { return smoothstep(vec4(0.0), vec4(1.0), x); }
// WE shader 里大量使用的 atan2（GLSL 内置是 atan(y, x)，无 atan2 名）
float atan2(float y, float x) { return atan(y, x); }
// HSV ↔ RGB。色相范围是 0..1 而不是 0..360 —— 依据 gradient_color.frag 的
// \`hsv.x = frac(hsv.x + g_Time * u_Speed)\`（按 1 环绕）与 test_shader.frag 的
// \`hsv2rgb(vec3(x * 0.23 + g_Time * 0.12, 1.0, 1.0))\`（喂入无界小数）。
vec3 rgb2hsv(vec3 c) {
    vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
    vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
    vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
    float d = q.x - min(q.w, q.y);
    float e = 1.0e-10;
    return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
vec3 hsv2rgb(vec3 c) {
    vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}
`,
  // WE common_blending.h（重建子集）。此前缺失导致 pulse / Simple_Audio_Bars /
  // 绝大多数 workshop 图像效果因 ApplyBlending 未定义而编译失败、效果被整体跳过
  // （README「HLSL→GLSL 转译」一节的已知待办）。逐字翻译自本仓库
  // render/effects.js 的 applyBlending CPU 参考实现（编号 = common_blending.h）。
  // 内部辅助函数一律加 weBlend 前缀：不得与 GLSL 内置撞名（如 reflect）。
  // [we-scene patch] 32 个混合模式的 GLSL 从引擎层 render/renderer-glsl.js 取，
  // 不在这里再抄一份：同一份实现同时供效果 shader 的 #include 与图层
  // colorBlendMode 的画布合成（COMPOSITE_BLEND_FRAG）使用。两份必然发散 ——
  // 「哪些模式不套 opacity 二次加权」这类代数细节改一处漏一处，画面错了还查不出来。
  'common_blending.h': `${WE_BLENDING_GLSL}
// greyscale 必须返回 **float** 而不是 vec3 —— 调用点几乎全是
// \`noise = CAST3(greyscale(noise))\`（filmgrain/vhs），CAST3 只能作用于标量；
// 若声明成 vec3 版本，这些点会变成非法的 vec3(vec3)。
// 唯一的 \`albedo.rgb = greyscale(albedo.rgb)\`（color_grading）在 HLSL 里靠标量
// 自动广播成立，转译到 GLSL 后由赋值端的 vec3 = float 广播承接。
//
// 权重是 **vec3(0.11, 0.59, 0.3)**，即 Rec.601 (0.30,0.59,0.11) 的**逆序**——
// WE 第一方 shader 里的历史遗留（BGR 时代）。依据是 4 个第一方文件把它内联写死：
// localcontrast_combine.frag（正是 blur_combine 的免头文件版，#if GREYSCALE 下
// 做的就是 greyscale 的事）、shine_downsample2.frag 等，跨 6 个壁纸字节一致。
// 注意工坊 shader 大多用 Rec.709 (0.2126,0.7152,0.0722)，但它们都是**本地自定义**
// 的宏，不经过这个头；color_grading.frag 甚至同文件内两种并存 ——
// 它自己 #define LUMINANCE_FACTOR 为 709，同时又调用本头的 greyscale，
// 正说明 greyscale 不是 709 那套。
#define LUMINANCE_FACTOR vec3(0.11, 0.59, 0.3)
float greyscale(vec3 color) { return dot(vec3(0.11, 0.59, 0.3), color); }
// BlendLinearDodge 必须按名存在：它被当作**实参**传给 BlendOpacity，
// 自身从不带括号调用（故按调用扫描的校验器看不到它，但缺了会展开失败）。
vec3 BlendLinearDodge(vec3 base, vec3 blend) { return min(base + blend, vec3(1.0)); }
// BlendSoftLight 按名导出（splitTone 直接调用，2 参、无 opacity，0.5 为恒等）
vec3 BlendSoftLight(vec3 a, vec3 b) { return weBlendSoftLight(a, b); }
// BlendOpacity 只能是**函数式宏**，不能是函数 —— 第 3 个实参是裸函数名
// （\`BlendOpacity(albedo.rgb, smoothstep(...), BlendLinearDodge, blend)\`），
// 而 GLSL ES 没有函数指针。hlsl2glsl 的 expandFunctionMacro 会在 JS 侧预展开。
#define BlendOpacity(base, blend, F, O) mix((base), F((base), (blend)), (O))
// ContrastSaturationBrightness 的实参顺序与函数名相反：
// 实测唯一调用点为 (albedo.rgb, 1.0 + c_brightness, 1.0 + c_saturation, 1.0 + c_contrast)，
// 三个 uniform 的 range 均为 [-1,1]，故三个参数都是 [0,2] 的倍率、1.0 为恒等。
vec3 ContrastSaturationBrightness(vec3 color, float brt, float sat, float con) {
    vec3 brtColor = color * brt;
    vec3 satColor = mix(vec3(dot(brtColor, LUMINANCE_FACTOR)), brtColor, sat);
    return mix(vec3(0.5), satColor, con);
}
`,
  // WE common_perspective.h（重建）。缺失时 waterwaves（全库 344 处引用 / 44 壁纸）、
  // waterripple、perspective、reflection 等整体被跳过 —— 是影响面最大的一个头。
  //
  // squareToQuad 把**单位正方形映射到四边形**，全库 98 个文件只有一种调用形式：
  //   mat3 xform = inverse(squareToQuad(g_Point0, g_Point1, g_Point2, g_Point3));
  //   v_TexCoord = mul(vec3(a_TexCoord.xy, 1.0), xform);
  // 片元侧再做透视除法 \`v_TexCoord.xy / v_TexCoord.z\`，并用 \`step(0.0, v_TexCoord.z)\`
  // 当有效性掩码 —— 所以正面样本的 z 必须为**正**，末行不能带负号缩放。
  //
  // 四个点的默认值是 g_Point0..3 = (0,0) (1,0) (1,1) (0,1)，即单位正方形，
  // 此时必须退化为单位矩阵（否则所有没调透视的图层都会被莫名扭曲）。
  //
  // 采用标准的「单位正方形 → 任意四边形」投影解法（Heckbert）：
  //   dx1 = p1-p2, dy1 = p3-p2, dx2 = p0-p1+p2-p3（对边不平行时的偏差量）
  //   若 dx2 为 0 则是仿射情形，g=h=0。
  // 结果按**行向量约定**装配：调用点用的是 mul(rowVec, M)，而 hlsl2glsl 会把
  // mul(v, M) 改写成 transpose(M) * v，故这里按「行向量右乘」的排布填矩阵。
  'common_perspective.h': `// WE common_perspective.h（重建）
mat3 squareToQuad(vec2 p0, vec2 p1, vec2 p2, vec2 p3) {
    float dx1 = p1.x - p2.x;
    float dy1 = p1.y - p2.y;
    float dx2 = p3.x - p2.x;
    float dy2 = p3.y - p2.y;
    float sx = p0.x - p1.x + p2.x - p3.x;
    float sy = p0.y - p1.y + p2.y - p3.y;
    float den = dx1 * dy2 - dx2 * dy1;
    float g = 0.0;
    float h = 0.0;
    if (abs(den) > 1e-9) {
        g = (sx * dy2 - dx2 * sy) / den;
        h = (dx1 * sy - sx * dy1) / den;
    }
    float a = p1.x - p0.x + g * p1.x;
    float b = p3.x - p0.x + h * p3.x;
    float c = p0.x;
    float d = p1.y - p0.y + g * p1.y;
    float e = p3.y - p0.y + h * p3.y;
    float f = p0.y;
    // 调用点一律是 mul(vec3(uv,1), inverse(本函数结果))，hlsl2glsl 把它转写成
    // transpose(xform) * vec3(uv,1)。要让屏幕点 s 得到 texCoord = S⁻¹·s（S 为
    // Heckbert 正向矩阵 [[a,b,c],[d,e,f],[g,h,1]]，单位方→四边形），必须
    // xform = inverse(本函数结果) 满足 transpose(xform)·s = S⁻¹·s，
    // 即本函数返回 S 的**转置**：mat3 列主序构造为 (a,d,g)(b,e,h)(c,f,1) 的转置
    // = (a,b,c)(d,e,f)(g,h,1)。排布差一个转置，perspective/水波等全部错位——
    // 3174556087 的音谱柱被贴到窗户侧边竖排（应为贴下窗沿横排）实测确认。
    // 2026-09-05 数值模拟：旧排布 transpose(S⁻¹)·corner 与正确 S⁻¹·corner 逐项不同，
    // 可见区塌缩成一条斜带；新排布后中心 (0.5,0.5) → (0.478,0.511) ∈ [0,1]²。
    return mat3(a, b, c,
                d, e, f,
                g, h, 1.0);
}
`,
  // WE common_blur.h（重建）。blurNa 的权重不是估算的 —— 壁纸 1444077782 里存着
  // **加公共头之前的旧版** blur_precise_gaussian.frag，把 13/7/3 抽样的系数
  // 逐项内联写死，这里逐字照抄（已核对原文）。
  //
  // 两个关键约定：
  //  1. **隐式采样 g_Texture0**，不传 sampler —— 调用形式恒为 blurNa(uv, step)，
  //     而包含本头的文件都声明了 uniform sampler2D g_Texture0；
  //  2. step 由**顶点着色器**算好：VERTICAL 时 (0, g_Scale.y / g_Texture0Resolution.w)，
  //     否则 (g_Scale.x / g_Texture0Resolution.z, 0) —— 即已经除过分辨率的单texel步长，
  //     未使用的轴为 0。所以这里直接按 ±1..±6 倍 step 取样即可。
  //
  // 注意 precise 版的 3 抽样权重是 0.27901/0.44198/0.27901（真高斯，和为 1），
  // 与 blur_gaussian.frag 的 0.25/0.5/0.25 **不同**，不要统一。
  // g_Texture0Resolution 四个分量都是像素尺寸：.xy 是补齐后的纹理尺寸（POT），
  // .zw 是图像实际尺寸；都是被除数，不是倒数。
  //
  // **本头必须自己声明 g_Texture0**：`#include "common_blur.h"` 在文件第 4 行，
  // 而 `uniform sampler2D g_Texture0` 在第 8 行 —— GLSL 要求先声明后使用，
  // 若头里只引用不声明，实测报 `'g_Texture0' : undeclared identifier`。
  // 重复声明同一个 uniform 在 GLSL ES 3.0 里是**错误**，所以不能直接再写一遍；
  // 解决办法是把 include 展开后出现的重复声明交给 hlsl2glsl 去重
  //（见 dedupeUniforms）。这里照常声明，由去重保证只留一份。
  'common_blur.h': `// WE common_blur.h（重建）
uniform sampler2D g_Texture0;
vec4 blur13a(vec2 uv, vec2 stp) {
    return texture(g_Texture0, uv - stp * 6.0) * 0.006299
         + texture(g_Texture0, uv - stp * 5.0) * 0.017298
         + texture(g_Texture0, uv - stp * 4.0) * 0.039533
         + texture(g_Texture0, uv - stp * 3.0) * 0.075189
         + texture(g_Texture0, uv - stp * 2.0) * 0.119007
         + texture(g_Texture0, uv - stp) * 0.156756
         + texture(g_Texture0, uv) * 0.171834
         + texture(g_Texture0, uv + stp) * 0.156756
         + texture(g_Texture0, uv + stp * 2.0) * 0.119007
         + texture(g_Texture0, uv + stp * 3.0) * 0.075189
         + texture(g_Texture0, uv + stp * 4.0) * 0.039533
         + texture(g_Texture0, uv + stp * 5.0) * 0.017298
         + texture(g_Texture0, uv + stp * 6.0) * 0.006299;
}
vec4 blur7a(vec2 uv, vec2 stp) {
    return texture(g_Texture0, uv - stp * 3.0) * 0.071303
         + texture(g_Texture0, uv - stp * 2.0) * 0.131514
         + texture(g_Texture0, uv - stp) * 0.189879
         + texture(g_Texture0, uv) * 0.214607
         + texture(g_Texture0, uv + stp) * 0.189879
         + texture(g_Texture0, uv + stp * 2.0) * 0.131514
         + texture(g_Texture0, uv + stp * 3.0) * 0.071303;
}
vec4 blur3a(vec2 uv, vec2 stp) {
    return texture(g_Texture0, uv - stp) * 0.27901
         + texture(g_Texture0, uv) * 0.44198
         + texture(g_Texture0, uv + stp) * 0.27901;
}
// 径向模糊：blurRadialNa(uv, center, scale)。它的 .vert 不传分辨率也不传步长，
// 故步长只能由 (uv - center) 自行导出 —— 按「沿指向中心的方向按比例取样」实现，
// 系数取 1/64 使 scale=1 时的最大位移约为半径的 1/10（与 u_Scale 的 [0.01,2] 量程匹配）。
vec4 blurRadial13a(vec2 uv, vec2 center, float scale) {
    return blur13a(uv, (uv - center) * scale * 0.015625);
}
vec4 blurRadial7a(vec2 uv, vec2 center, float scale) {
    return blur7a(uv, (uv - center) * scale * 0.015625);
}
vec4 blurRadial3a(vec2 uv, vec2 center, float scale) {
    return blur3a(uv, (uv - center) * scale * 0.015625);
}
`,
  // WE common_composite.h（重建）。仅被 blur_combine.frag 使用（全库 4 个调用点）。
  //   vec4 blurred = texSample2D(g_Texture0, ApplyCompositeOffset(uv, g_Texture0Resolution.xy));
  //   blurred = ApplyComposite(albedoOld, vec4(blurred.rgb / div, blurred.a));
  // 第 1 参是**原始画面**（g_Texture2 显式标注 "material":"previous"），第 2 参是新的模糊结果。
  // COMPOSITE 取值 0 normal / 1 blend / 2 under / 3 cutout；本机库只出现 0 与 1
  // （3 处 scene.json 覆盖成 1），2/3 无实例，按语义实现备用。
  // COMPOSITEMONO 全库从未被覆盖，恒为 0。
  // ApplyCompositeOffset 在 normal 下必须是恒等 —— 否则所有未改 COMPOSITE 的
  // blur 效果都会整体偏移。
  //
  // 两条**必须自洽**的约束（踩过）：
  //  1. **不能调用 ApplyBlending** —— blur_combine.frag 只 include 本头，
  //     不 include common_blending.h。真实 WE 的 common_composite.h 必须自给自足，
  //     否则这 2 个文件（3 个壁纸）会因 ApplyBlending 未定义而整体编译失败。
  //     故这里内联所需的少量混合，不外借 common_blending.h 的符号；
  //  2. **不能用 #elif** —— 本仓库的预处理器明确不支持（见 hlsl2glsl.js 的
  //     「不支持 #elif」注释），遇到会当作条件终止，导致后续分支全部漏掉。
  //     一律写成独立的 #if / #endif。
  'common_composite.h': `// WE common_composite.h（重建）
vec2 ApplyCompositeOffset(vec2 uv, vec2 res) {
    return uv;
}
vec4 ApplyComposite(vec4 backdrop, vec4 source) {
    vec4 result = source;
#if COMPOSITE == 1
    result = vec4(mix(backdrop.rgb, source.rgb, source.a), max(backdrop.a, source.a));
#endif
#if COMPOSITE == 2
    result = vec4(mix(source.rgb, backdrop.rgb, backdrop.a), max(backdrop.a, source.a));
#endif
#if COMPOSITE == 3
    result = vec4(backdrop.rgb, backdrop.a * (1.0 - source.a));
#endif
#if COMPOSITEMONO == 1
    result.rgb = vec3(dot(vec3(0.11, 0.59, 0.3), result.rgb));
#endif
    return result;
}
`,
  // WE common_fragment.h（重建）。当前只需 DecompressNormal 与两个格式宏。
  // DecompressNormal 收**整个 vec4** 纹素（调用点无 swizzle），但内容是两通道的：
  // 实测 3 张 refractnormal.tex 有 2 张是 RG88（format=8）。WE 用 "format":"normalmap"
  // 标注这类贴图并重建 z。返回值的 .z 在现有 3 个调用点里从未被使用
  // （只用 normal.xy 做 UV 位移），故真正吃重的只有 *2-1 这步。
  // FORMAT_R8 / FORMAT_RG88 取 pkg/texture.js 的 .tex 格式枚举：RG88=8、R8=9。
  'common_fragment.h': `// WE common_fragment.h（重建）
#define FORMAT_RG88 8
#define FORMAT_R8 9
vec3 DecompressNormal(vec4 tex) {
    vec2 xy = tex.xy * 2.0 - 1.0;
    return vec3(xy, sqrt(clamp(1.0 - dot(xy, xy), 0.0, 1.0)));
}
`,
  // WE common_vertex.h：**只被 include，不提供任何符号**。
  // 全库仅 2 个文件包含它（flowimage.vert / cutout_vignette.vert），
  // 两者用到的 uniform / attribute / varying 全部自行声明，
  // 其余标识符都是 GLSL 内建或由 hlsl2glsl 处理的 HLSL 方言（mul / CAST2）。
  // 真实 WE 里它是声明宏与平台 #define 的样板头，这里给空实现即可。
  'common_vertex.h': `// WE common_vertex.h（重建：空占位，见 headers.ts 注释）
`,
};
