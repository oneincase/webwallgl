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
// [we-scene patch 3351179520] HLSL 允许把 vec4 隐式截断成 float2 传参，GLSL 不允许 ——
// multistage_wave.vert（GLOBAL_ROTATION=1 时 v_DirectionN 是 vec4）写
// \`v_DirectionN.zw = rotateVec2(v_DirectionN, g_DirectionOffset)\`，没有这个重载
// 整条 pass 编译失败、效果被静默跳过（飘带/头发的多层波动全消失）。
// 语义 = 取 xy 分量旋转，与 WE 原生截断一致。
vec2 rotateVec2(vec4 v, float a) {
    return rotateVec2(v.xy, a);
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
vec3 rgb2hsv(vec3 RGB) {
    // 逐字对齐官方 common.h：三元组选 g/b 序，常数布局不能用 step+mix 替代
    // （旧重建版的 swizzle 对橙红区段返回错误色相，combine 把火色调成白色）。
    vec4 P = (RGB.g < RGB.b) ? vec4(RGB.bg, -1.0, 2.0/3.0) : vec4(RGB.gb, 0.0, -1.0/3.0);
    vec4 Q = (RGB.r < P.x) ? vec4(P.xyw, RGB.r) : vec4(RGB.r, P.yzx);
    float C = Q.x - min(Q.w, Q.y);
    float H = abs((Q.w - Q.y) / (6.0 * C + 1e-10) + Q.z);
    vec3 HCV = vec3(H, C, Q.x);
    float S = HCV.y / (HCV.z + 1e-10);
    return vec3(HCV.x, S, HCV.z);
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
  // squareToQuad 把**单位正方形映射到四边形**，全库 98 个文件只有一种调用形式：
  //   mat3 xform = inverse(squareToQuad(g_Point0, g_Point1, g_Point2, g_Point3));
  //   v_TexCoord = mul(vec3(a_TexCoord.xy, 1.0), xform);
  // 片元侧再做透视除法 \`v_TexCoord.xy / v_TexCoord.z\`，并用 \`step(0.0, v_TexCoord.z)\`
  // 当有效性掩码 —— 所以正面样本的 z 必须为**正**，末行不能带负号缩放。
  // 四个点的默认值是 g_Point0..3 = (0,0) (1,0) (1,1) (0,1)，即单位正方形，
  // 此时必须退化为单位矩阵（否则所有没调透视的图层都会被莫名扭曲）。
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
  // 两个关键约定：
  //  1. **隐式采样 g_Texture0**，不传 sampler —— 调用形式恒为 blurNa(uv, step)，
  //     而包含本头的文件都声明了 uniform sampler2D g_Texture0；
  //  2. step 由**顶点着色器**算好：VERTICAL 时 (0, g_Scale.y / g_Texture0Resolution.w)，
  //     否则 (g_Scale.x / g_Texture0Resolution.z, 0) —— 即已经除过分辨率的单texel步长，
  //     未使用的轴为 0。所以这里直接按 ±1..±6 倍 step 取样即可。
  // 注意 precise 版的 3 抽样权重是 0.27901/0.44198/0.27901（真高斯，和为 1），
  // 与 blur_gaussian.frag 的 0.25/0.5/0.25 **不同**，不要统一。
  // g_Texture0Resolution 四个分量都是像素尺寸：.xy 是补齐后的纹理尺寸（POT），
  // .zw 是图像实际尺寸；都是被除数，不是倒数。
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
  // WE common_pbr_2.h（重建子集）：提供 PBR 基元与 CombineLighting，并把
  // PerformLighting_V1 的**直射项置 0** —— 本仓不解析场景灯光对象
  // （点光/聚光/平行光/阴影图集，官方 LightingV1 全帧平均贡献实测 ~2%，
  // 见 renderer.js layerColorAmbient 注释），故 LIGHTING=1 走 ambient-only，
  // 与 genericimage* 既有的 ambient 近似一致。这样 fluidsimulation combine
  // 的 LIGHTING=1 分支（法线扰动染色）可编译运行；fur/foliage/chroma 等同头
  // shader 也能过编译（真实直射光照留待引入灯光管线时补 PerformLighting_V1）。
  'common_pbr_2.h': `// WE common_pbr_2.h（重建：PBR 基元 + ambient-only 灯光）
#include "common.h"
#ifndef M_PI
#define M_PI 3.14159265359
#endif

vec3 FresnelSchlick(float lightTheta, vec3 baseReflectance) {
  return baseReflectance + (vec3(1.0) - baseReflectance) * pow(max(1.0 - lightTheta, 0.001), 5.0);
}

float Distribution_GGX(vec3 N, vec3 H, float roughness) {
  float r = roughness * roughness;
  float r2 = r * r;
  float NH = max(dot(N, H), 0.0);
  float denom = (NH * NH * (r2 - 1.0) + 1.0);
  return r2 / (M_PI * denom * denom);
}

float Schlick_GGX(float NV, float roughness) {
  float k = (roughness + 1.0);
  k = (k * k) / 8.0;
  return NV / (NV * (1.0 - k) + k);
}

float GeoSmith(vec3 N, vec3 V, vec3 L, float roughness) {
  return Schlick_GGX(max(dot(N, V), 0.001), roughness) * Schlick_GGX(max(dot(N, L), 0.001), roughness);
}

// 无 GRADIENT_SAMPLER / RIMLIGHTING / 阴影宏时的标准直接光 BRDF 项。
// shadowFactor 由调用方给（本仓恒 1，无阴影）。
vec3 ComputePBRLightShadow(vec3 N, vec3 L, vec3 V, vec3 albedo, vec3 lightColor,
  float radius, float exponent, vec3 specularTint, vec3 baseReflectance,
  float roughness, float metallic, float shadowFactor) {
  float dist = length(L);
  L = L / max(dist, 1e-4);
  vec3 H = normalize(V + L);
  float falloff = clamp(1.0 - dist / max(radius, 1e-4), 0.0, 1.0);
  float fltMin = 6.103515625e-5;
  vec3 radiance = lightColor * mix(0.0, pow(falloff + fltMin, exponent), step(fltMin, falloff));
  float NDF = shadowFactor * Distribution_GGX(N, H, roughness);
  float G = GeoSmith(N, V, L, roughness);
  vec3 F = FresnelSchlick(max(dot(H, V), 0.0), baseReflectance);
  vec3 numerator = NDF * G * F;
  vec3 diffuse = (1.0 - metallic) * (vec3(1.0) - F);
  float NL = max(dot(N, L) * shadowFactor, 0.0);
  float denominator = 4.0 * max(dot(N, V), 0.0) * NL;
  vec3 specular = numerator / max(denominator, 0.001);
  return (diffuse * albedo / M_PI + specular * specularTint) * radiance * NL;
}

vec3 ComputePBRLightShadowInfinite(vec3 N, vec3 L, vec3 V, vec3 albedo, vec3 lightColor,
  vec3 specularTint, vec3 baseReflectance, float roughness, float metallic, float shadowFactor) {
  vec3 H = normalize(V + L);
  float NDF = shadowFactor * Distribution_GGX(N, H, roughness);
  float G = GeoSmith(N, V, L, roughness);
  vec3 F = FresnelSchlick(max(dot(H, V), 0.0), baseReflectance);
  vec3 numerator = NDF * G * F;
  float NL = max(dot(N, L) * shadowFactor, 0.0);
  float denominator = 4.0 * max(dot(N, V), 0.0) * NL;
  vec3 specular = numerator / max(denominator, 0.001);
  vec3 diffuse = (1.0 - metallic) * (vec3(1.0) - F);
  return (diffuse * albedo / M_PI + specular * specularTint) * lightColor * NL;
}

// 场景灯光驱动的总直射：**效果 pass 这条路上仍是 0**（灯 uniform 只喂给图片层
// 的基色着色路径 COPY_LIT_FRAG，没喂给效果 pass —— 全库 4 个 LIGHTING pass 里
// 只有 fluidsimulation 的 combine 属于此类，且它的场景都没有灯光对象）。
// 图片层（2890473419 等 13 张）的直射光不走这里，别按这个函数判断整库行为。
vec3 PerformLighting_V1(vec3 worldPos, vec3 albedo, vec3 normal, vec3 viewVector,
  vec3 specularTint, vec3 f0, float roughness, float metallic) {
  return vec3(0.0);
}

vec3 CombineLighting(vec3 light, vec3 ambient) {
  return ambient + light;
}
vec3 CombineLighting(vec3 light, vec3 baseAmbient, vec3 ambient) {
  return max(baseAmbient, ambient + light);
}
`,
  'common_fragment.h': `// WE common_fragment.h（重建；逐条对齐官方 assets/shaders/common_fragment.h）
//
// [we-scene patch 2026-10-03] **格式宏与 DecompressNormal 的通道语义必须照抄**（F26）。
// 此前版本把「与格式相关的分支」按「本仓贴图一律解码成 RGBA」折叠掉了 —— 折叠的
// 前提是错的：分支选的是**通道语义**，不是解码格式。官方默认分支读的是
// \`normal.wy\`（x 在 **alpha**、y 在 **green**，即经典 DXT5nm 排布），只有
// FORMAT_RG88 才读 \`rg\`；WE 给法线贴图标的就是 TEX1FORMAT=4（FORMAT_DXT5）⇒ 官方
// 走的是 \`normal.yx = normal.yw * 2 - vec2(0.965, 1)\`。折叠成 \`rg\` 之后，
// 法线整体错位（x 取到反照率的红通道），材质的光照方向全错 —— 实测 fantasticcar
// 车漆「上表面红、朝向镜头的一面全黑」，就是这条。我们的贴图解码保留原始通道值
// （DXT5 → RGBA 逐通道等价），所以按 TEX1FORMAT 分支是正确的，也是唯一正确的做法。
//
// 与官方的唯一差异：\`HLSL_SM30\` 保持**未定义**（本仓转译目标是 GLSL ES 3.0，
// 见 hlsl2glsl 的平台宏注入注释），于是 ConvertSample* 走 \`#else\` 的 GLSL 分支。
#define FORMAT_RGBA8888 0
#define FORMAT_RGB888 1
#define FORMAT_RGB565 2

#define FORMAT_ETC1_RGB8 3
#define FORMAT_DXT5 4
#define FORMAT_ETC2_RGBA8 5
#define FORMAT_DXT3 6
#define FORMAT_DXT1 7

#define FORMAT_RG88 8
#define FORMAT_R8 9
#define FORMAT_RG1616F 10
#define FORMAT_R16F 11

#define FORMAT_BC7 12

vec3 DecompressNormal(vec4 normal)
{
#if TEX1FORMAT >= FORMAT_ETC1_RGB8 && TEX1FORMAT <= FORMAT_DXT1 || TEX1FORMAT == FORMAT_BC7
    normal.yx = normal.yw * 2.0 - vec2(0.965, 1.0);
#else
#if TEX1FORMAT == FORMAT_RG88
    normal.xy = normal.rg * 2.0 - 1.0;
#else
    normal.xy = normal.wy * 2.0 - 1.0;
#endif
#endif
    normal.z = sqrt(clamp(1.0 - normal.x * normal.x - normal.y * normal.y, 0.0, 1.0));
    return normal.xyz;
}

vec4 DecompressNormalWithMask(vec4 normal)
{
#if TEX1FORMAT >= FORMAT_ETC1_RGB8 && TEX1FORMAT <= FORMAT_DXT1 || TEX1FORMAT == FORMAT_BC7
    normal.xw = normal.wx;
    normal.xy = normal.xy * 2.0 - vec2(0.965, 1.0);
#else
#if TEX1FORMAT == FORMAT_RG88
    normal.xy = normal.gr * 2.0 - 1.0;
#else
    normal.xw = normal.wx;
    normal.xy = normal.xy * 2.0 - 1.0;
#endif
#endif
    normal.z = sqrt(clamp(1.0 - normal.x * normal.x - normal.y * normal.y, 0.0, 1.0));
    return normal;
}
// [we-scene patch 2026-10-03] PBR 函数族按官方语义补齐（F18）：作者的 PBR 类材质
// shader（fantasticcar car、demon_core core/backgroundsphere…）直接调用它们；
// 缺了就在 GL 编译期报 no matching overload，整条材质静默回落。
float ComputeMaterialSpecularPower(float roughness, float metallic) {
    return (1.01 - roughness) * mix(400.0, 250.0, metallic);
}
float ComputeMaterialSpecularStrength(float roughness, float metallic) {
    return (0.5 + metallic * 0.5) * (1.0 - roughness * 0.9);
}
vec3 ComputeLight(vec3 normal, vec3 lightDelta, vec3 color, float radius) {
    float lightDistance = length(lightDelta);
    float lightAttn = clamp((radius - lightDistance) / radius, 0.0, 1.0);
    return color * clamp(dot(lightDelta / lightDistance, normal), 0.0, 1.0) * lightAttn * lightAttn;
}
vec3 ComputeLightSpecular(vec3 normal, vec3 lightDelta, vec3 color, float radius, vec3 viewDir,
                          float specularPower, float specularStrength, float halfLambert,
                          float metallicTerm, inout vec3 specularResult) {
    float lightDistance = length(lightDelta);
    float lightAttn = clamp((radius - lightDistance) / radius, 0.0, 1.0);
    vec3 lightDir = lightDelta / lightDistance;
    float specular = max(0.0, dot(normalize(viewDir + lightDir), normal));
    specularResult += pow(specular, specularPower) * specularStrength * lightAttn * color;
    float lightDot = dot(lightDir, normal);
    float halfLambertLight = lightDot * 0.5 + 0.5;
    lightDot = mix(lightDot, halfLambertLight, halfLambert);
    float rim = metallicTerm * 2.0;
    rim = pow((1.0 - clamp(dot(normal, viewDir), 0.0, 1.0)) * pow(halfLambertLight, 0.25), 6.0 - rim) * rim;
    return color * (clamp(lightDot, 0.0, 1.0) + rim) * lightAttn * lightAttn;
}
float ConvertSampleR8(vec4 _sample) {
#if HLSL_SM30
    return _sample.a;
#else
    return _sample.r;
#endif
}
vec4 ConvertTexture0Format(vec4 _sample) {
#if TEX0FORMAT == FORMAT_RG88 || TEX0FORMAT == FORMAT_RG1616F
    return _sample.rrrg;
#endif
#if TEX0FORMAT == FORMAT_R8 || TEX0FORMAT == FORMAT_R16F
    return vec4(1.0, 1.0, 1.0, _sample.r);
#endif
    return _sample;
}
vec4 ConvertTextureFormat(int format, vec4 _sample) {
    if (format == FORMAT_RG88 || format == FORMAT_RG1616F) {
        return _sample.rrrg;
    }
    if (format == FORMAT_R8 || format == FORMAT_R16F) {
        return vec4(1.0, 1.0, 1.0, _sample.r);
    }
    return _sample;
}
`,
  // WE common_vertex.h（重建）。**不是空占位** —— 此前按工坊语料判断「只被 include、
  // 不提供任何符号」（全库仅 flowimage/cutout_vignette 两个 vert 包含它，且都自声明了
  // 一切），但**官方内置 defaultprojects 的源码 shader 不受工坊语料覆盖**：
  // fantasticcar `car.vert` 的 NORMALMAP 分支调用 `BuildTangentSpace(CAST3X3(g_ModelMatrix),
  // a_Normal, a_Tangent4)`，函数缺定义 → GL 编译期 `no matching overload` → 整车材质
  // 静默回落通用网格程序（观感是「带贴图的素模」，车漆/高光/条纹全丢）。
  // 三个重载逐字按官方 `assets/shaders/common_vertex.h`（23 行）复刻；`mul` 由
  // hlsl2glsl 的调用改写处理（include 在 preprocess 阶段先内联、改写在其后）。
  'common_vertex.h': `// WE common_vertex.h（重建）
//
// [we-scene patch 2026-10-03] **mat3 构造子的行列语义**（F37）：HLSL 的
// \`mat3(a, b, c)\` 填的是**行**（HLSL 是行向量/行主序），GLSL 的 \`mat3(a, b, c)\`
// 填的是**列**；hlsl2glsl 对构造子原样透传。官方这份头写成
// \`return mat3(tangent, bitangent, normal);\` —— 意思是「三行分别是 t/b/n」，
// 调用点再 \`mul(tangentSpace, v)\`（= M·v）得到 (dot(t,v), dot(b,v), dot(n,v))
// —— 这才是切线坐标。原样照抄进 GLSL 后，M 的三列才是 t/b/n，
// \`M·v\` 得到的是 (v.x, v.z, −v.y) 这种**置换/反号**结果：切线空间的「法线轴」
// 落到别的分量上（实测 arsenal 桌面 \`v_Light0DirectionL3X.z ≈ -1\` 而世界方向
// y ≈ +0.9），法线贴图的光照因此整片取反 —— 桌面、枪身都不吃动态光。
// 修法：在重建头里显式 \`transpose(...)\` 还原 HLSL 的「行」语义，不改转译器
// （构造子语义是全库级改动，风险面太大，见 docs/DEFAULTPROJECTS-PLAN.md 续十四）。
mat3 BuildTangentSpace(const vec3 normal, const vec4 signedTangent)
{
    vec3 tangent = signedTangent.xyz;
    vec3 bitangent = cross(normal, tangent) * signedTangent.w;
    return transpose(mat3(tangent, bitangent, normal));
}

mat3 BuildTangentSpace(const mat3 modelTransform, const vec3 normal, const vec4 signedTangent)
{
    vec3 tangent = signedTangent.xyz;
    vec3 bitangent = cross(normal, tangent) * signedTangent.w;
    return transpose(mat3(mul(tangent, modelTransform),
        mul(bitangent, modelTransform),
        mul(normal, modelTransform)));
}

void BuildTangentSpace(const mat3 modelTransform, const vec3 normal, const vec4 signedTangent, out vec3 worldTangent, out vec3 worldBitangent)
{
    vec3 tangent = signedTangent.xyz;
    vec3 bitangent = cross(normal, tangent) * signedTangent.w;
    worldTangent = mul(tangent, modelTransform);
    worldBitangent = mul(bitangent, modelTransform);
}
`,
  // WE common_particles.h（重建子集）：**粒子材质 shader**（作者自己写的
  // `shaders/particle.*`，如官方内置 shimmering_particles）要用的四个函数与 uniform。
  // 引擎族 genericparticle 不走它（那份由 render/particle-shaders.js 原生实现）。
  'common_particles.h': `// WE common_particles.h（重建子集：粒子材质 shader 用到的函数与声明）
uniform mat4 g_ModelViewProjectionMatrix;
uniform mat4 g_ModelMatrixInverse;

uniform vec3 g_OrientationUp;
uniform vec3 g_OrientationRight;
uniform vec3 g_OrientationForward;

uniform vec3 g_ViewUp;
uniform vec3 g_ViewRight;
uniform vec3 g_EyePosition;

uniform vec4 g_RenderVar0;
uniform vec4 g_RenderVar1;
uniform vec4 g_Texture0Resolution;

#if REFRACT
uniform float g_RefractAmount; // {"material":"ui_editor_properties_refract_amount","default":0.05,"range":[-1,1]}
#endif

// 官方用 mat3(...) + mul(mul(Rz,Rx),Ry) 行向量合成；本仓转译器**只改写
// mul(vec, mat)**，mul(mat,mat) 会原样漏进 GLSL（实测转译产物里留下裸 mul( → 编译失败），
// 而 mat3(a,b,c) 构造子在 HLSL 填行、进 GLSL 填列（F37）。故这里按同一套旋转基
// **显式展开成分量式**：right/up 取的就是内置精灵 shader（particle-shaders.js）里
// 已按官方出图标定过的右/上轴，再补上 z 分量。改任何一项都要与那份实现同步。
void ComputeParticleTangents(in vec3 rotation, out vec3 right, out vec3 up)
{
    float cz = cos(rotation.z), sz = sin(rotation.z);
    float cx = cos(rotation.x), sx = sin(rotation.x);
    float cy = cos(rotation.y), sy = sin(rotation.y);
    right = vec3(cz * cy - sz * sx * sy, sz * cy + cz * sx * sy, -cx * sy);
    up    = vec3(-sz * cx, cz * cx, sx);
}

void ComputeParticleTrailTangents(vec3 localPosition, vec3 localVelocity, out vec3 right, out vec3 up)
{
    vec3 eyeDirection = localPosition - mul(vec4(g_EyePosition, 1.0), g_ModelMatrixInverse).xyz;
    right = cross(eyeDirection, localVelocity);
    right = normalize(right);
    float trailLength = length(localVelocity);
    localVelocity /= trailLength;
    up = localVelocity * max(g_RenderVar0.z, min(trailLength * g_RenderVar0.x, g_RenderVar0.y));
}

vec3 ComputeParticlePosition(vec2 uvs, float textureRatio, vec4 positionAndSize, vec3 right, vec3 up)
{
    return positionAndSize.xyz +
        (positionAndSize.w * right * (uvs.x - 0.5) -
        positionAndSize.w * up * (uvs.y - 0.5) * textureRatio);
}

void ComputeSpriteFrame(float lifetime, out vec4 uvs, out vec2 uvFrameSize, out float frameBlend)
{
    float numFrames = g_RenderVar1.z;
    float frameWidth = g_RenderVar1.x;
    float frameHeight = g_RenderVar1.y;

    float currentFrame = floor(lifetime * numFrames);
    float nextFrame = min(numFrames - 1.0, currentFrame + 1.0);
    uvs.y = floor(currentFrame * frameWidth) * frameHeight;
    uvs.x = frac(currentFrame * frameWidth);
    uvs.w = floor(nextFrame * frameWidth) * frameHeight;
    uvs.z = frac(nextFrame * frameWidth);
    frameBlend = frac(lifetime * numFrames);
    uvFrameSize = vec2(frameWidth, frameHeight);
}

void ComputeScreenRefractionTangents(in vec3 projectedPositionXYW, in vec3 right, in vec3 up, out vec3 v_ScreenCoord, out vec4 v_ScreenTangents)
{
    v_ScreenCoord = projectedPositionXYW;
    right = normalize(right);
    up = normalize(up);
    v_ScreenTangents.xy = vec2(dot(right, g_ViewRight), dot(up, g_ViewRight));
    v_ScreenTangents.zw = vec2(dot(right, g_ViewUp), dot(up, g_ViewUp));
#if REFRACT
    v_ScreenTangents *= g_RefractAmount;
#endif
}
`,
};
