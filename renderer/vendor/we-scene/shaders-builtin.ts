/**
 * WE **引擎内置 shader** 的本仓实现（官方 `assets/shaders/<名>.frag|.vert`）。
 *
 * 为什么需要它：WE 的着色器分两层 —— 作者写的跟着壁纸进 pkg（`shaders/<名>.*`），
 * 引擎自带的（`generic*` / `sprite` / `flat` / `flag` …）留在 WE 安装目录里，
 * **不进 pkg**。官方内置工程 eagleflag 就是后者的样本：`materials/eagle.json`
 * 的 pass 只写 `"shader": "flag"`，包里没有 `shaders/flag.*`。
 *
 * 本仓对内置族的既有处理是**分族**的：
 *   - `generic*` / `sprite` / `flat` 一族在通用网格/图层程序里原生实现（不编译源）；
 *   - 其余内置 shader 走本表（本文件）—— 与 `headers.ts` 重建官方公共头、
 *     `renderer-glsl.js` 转写 `downsample_quarter_bloom` 同一条思路：
 *     **公式按官方语义在仓内实现**，不依赖用户机器上装没装 WE。
 *
 * 词法约定（与 pkg 内 shader 完全一致，才能过同一条 hlsl2glsl 转译链）：
 * `mul(vec4, mat4)` / `texSample2D` / `varying` / `attribute` / `gl_FragColor`，
 * `#include "common_*.h"` 由重建头（`headers.ts`）+ local-assets 回退解析。
 *
 * ⚠️ **uniform 名与 `// {"material": …}` 注释是契约**，不能改名：材质侧的
 * `constantshadervalues`（Speed/Strength）与 `usershadervalues`（color1/color2/color3
 * ← 用户颜色属性）都靠 material 名经 matMeta 落到这些 uniform 上（见 renderer.js
 * 的 parseMaterialMeta / bindConstants）。
 */

const FLAG_VERT = `// WE 引擎内置 shaders/flag.vert（本仓实现，语义对齐官方 assets 源）
//
// 波动的「几何感」全部在 frag 里做（法线扰动 + 采样偏移），这里只把 uv 传给
// 片元并派生两组**滚动法线坐标**：xy 慢速大浪、zw 快速细浪。
#include "common_vertex.h"

uniform mat4 g_ModelViewProjectionMatrix;
uniform float g_Time;

attribute vec3 a_Position;
attribute vec2 a_TexCoord;

varying vec2 v_TexCoord;
varying vec4 v_NormalCoord;

uniform float g_WaveSpeed; // {"material":"Speed","default":0.4}

void main() {
	gl_Position = mul(vec4(a_Position, 1.0), g_ModelViewProjectionMatrix);
	v_TexCoord.xy = a_TexCoord;

	v_NormalCoord.xy = a_TexCoord * vec2(1, 0.3) * 0.7;
	v_NormalCoord.x -= g_Time * g_WaveSpeed;

	v_NormalCoord.zw = a_TexCoord * vec2(1, 0.7) * 0.3;
	v_NormalCoord.z -= g_Time * g_WaveSpeed * 0.5;
}
`;

const FLAG_FRAG = `// WE 引擎内置 shaders/flag.frag（本仓实现，语义对齐官方 assets 源）
//
// 三张图分工：g_Texture0 = 通道图（r → color1/color2 混合权重、g → color3 权重、
// b → 亮度），g_Texture1 = 法线（两组滚动 UV 相乘，DXT5nm 排布，走
// DecompressNormal），g_Texture2 = 布料噪声（r 通道，*4 平铺）。
// 颜色来自用户属性（材质 usershadervalues：schemecolor→color1、flagcolor1→color2、
// flagcolor2→color3），缺省时才落到注释里的 default。
#include "common_fragment.h"

uniform sampler2D g_Texture0;
uniform sampler2D g_Texture1;
uniform sampler2D g_Texture2;

#if TINT
uniform vec3 g_Color1; // {"material":"color1","default":"0 0 0"}
uniform vec3 g_Color2; // {"material":"color2","default":"0 0 0"}
uniform vec3 g_Color3; // {"material":"color3","default":"1 1 1"}
#endif

uniform float g_WaveStrength; // {"material":"Strength","default":0.5}

varying vec2 v_TexCoord;
varying vec4 v_NormalCoord;

void main() {
	vec2 normalCoords1 = v_NormalCoord.xy;
	vec2 normalCoords2 = v_NormalCoord.zw;

	normalCoords1.x -= ((0.5 - v_TexCoord.x) * (1 - v_TexCoord.y)) * 3;
	normalCoords1.x += 2 * pow(v_TexCoord.y - 0.1, 3) * pow(v_TexCoord.x, 2);
	normalCoords2.x -= ((1.0 - v_TexCoord.x) * (1 - v_TexCoord.y)) * 2;

	vec3 normal = DecompressNormal(texSample2D(g_Texture1, normalCoords1));
	normal *= DecompressNormal(texSample2D(g_Texture1, normalCoords2));

	normal = mix(vec3(0, 0, 1), normal, g_WaveStrength);
	normal = normalize(normal);

	vec2 baseCoords = v_TexCoord.xy + normal.xy * 0.02;

	vec3 albedo = texSample2D(g_Texture0, baseCoords.xy).rgb;
	float cloth = texSample2D(g_Texture2, baseCoords.xy * 4).r;

#if TINT
	vec3 color = mix(g_Color1, g_Color2, albedo.r);
	color = mix(color, g_Color3, albedo.g);
	color *= albedo.b * cloth;
	color += cloth * 0.1;
#else
	vec3 color = albedo;
#endif

	float light = 0.2 + dot(vec3(0.707, 0.707, 0), normal) * 0.5 + 0.5;
	light += pow(light, 5) * 0.5;
	color *= light + light * saturate(cloth * 2 - 1);

	gl_FragColor.rgb = color;
	gl_FragColor.a = 1;
}
`;

// ---------------------------------------------------------------------------
// generic（F47）：官方内置工程 arsenal 的**模型**着色器
//
// 为什么需要它：`local-assets/shaders/**` 是**开发机可选通路**（本机装了 WE 才有；
// dev server 的 `/api/local-assets` 提供，产品形态没有这一档）。arsenal 的 6 个材质
// 全是 `"shader": "generic"`（引擎内置、不进 pkg），于是「没有原版素材」的机器上
// 这条解析链整段落空 → 模型退回通用网格程序（只有贴图 × 常量光照），与官方观感
// 差别巨大：光池/法线细节/高光/地板倒影全丢。按 F42（flag）的同一惯例，这里给出
// 仓内实现，**语义逐句对齐**官方 `assets/shaders/generic.vert|frag`。
//
// 组合（材质 combos，小写写在 json 里，本仓预处理器按大小写不敏感匹配）：
//   LIGHTMAP      槽 1/2 是光照图（有 NORMALMAP 时是 g_Texture2，否则 g_Texture1），
//                 且 a_TexCoordVec4 = [uv, 光照图 uv] 一条 vec4
//   NORMALMAP     槽 1 是法线图（DXT5nm，走 DecompressNormal）；光照方向改到**切线空间**
//   REFLECTION    g_Texture3 = `_rt_Reflection`（屏幕 UV 采样，见 renderer 的反射通道）
//   DIFFUSETINT   反照率乘 Color/Alpha 两个物性（官方材质面板的 tint）
//   DETAILINALPHA 反照率再乘「自身 uv×3 的 alpha × 2」（arsenal 的枪身/桌面用它加细节）
//
// 光路是**四盏场景点光 + 环境项**：前三盏的「方向 + 半径内第 3 盏的分量」打进
// varying 的 xyz/w（官方为了省 varying 把第 4 盏拆成 3 个 w），第 4 盏在片元里重组；
// 每盏走 ComputeLightSpecular（漫反射 + 半兰伯特混合 + 金属 rim + 高光累加）。
//
// uniform 名与 `// {"material": …}` 注释是契约：arsenal 的
// `constantshadervalues`（Metal/Rough/Light）靠 material 名经 matMeta 落到这些
// uniform 上（见 renderer.js 的 parseMaterialMeta / bindConstants）。
const GENERIC_VERT = `// WE 引擎内置 shaders/generic.vert（本仓实现，语义对齐官方 assets 源）
#include "common_vertex.h"

uniform mat4 g_ModelMatrix;
uniform mat4 g_ViewProjectionMatrix;
uniform vec3 g_EyePosition;
uniform vec3 g_LightsPosition[4];
uniform vec3 g_LightAmbientColor;
uniform vec3 g_LightSkylightColor;

attribute vec3 a_Position;
attribute vec3 a_Normal;
#if LIGHTMAP
attribute vec4 a_TexCoordVec4;
#else
attribute vec2 a_TexCoord;
#endif

#if NORMALMAP
attribute vec4 a_Tangent4;
#else
varying vec3 v_Normal;
#endif

varying vec3 v_ViewDir;
#if LIGHTMAP
varying vec4 v_TexCoord;
#else
varying vec2 v_TexCoord;
#endif
varying vec4 v_Light0DirectionL3X;
varying vec4 v_Light1DirectionL3Y;
varying vec4 v_Light2DirectionL3Z;

#if REFLECTION
varying vec3 v_ScreenPos;
#endif

varying vec3 v_LightAmbientColor;

void main() {
	vec4 worldPos = mul(vec4(a_Position, 1.0), g_ModelMatrix);
	gl_Position = mul(worldPos, g_ViewProjectionMatrix);
	vec3 normal = normalize(mul(a_Normal, CAST3X3(g_ModelMatrix)));
#if LIGHTMAP
	v_TexCoord = a_TexCoordVec4;
#else
	v_TexCoord = a_TexCoord;
#endif

#if REFLECTION
	v_ScreenPos = gl_Position.xyw;
#endif

	v_ViewDir = g_EyePosition - worldPos.xyz;

	v_Light0DirectionL3X.xyz = g_LightsPosition[0] - worldPos.xyz;
	v_Light1DirectionL3Y.xyz = g_LightsPosition[1] - worldPos.xyz;
	v_Light2DirectionL3Z.xyz = g_LightsPosition[2] - worldPos.xyz;

	vec3 l3 = g_LightsPosition[3] - worldPos.xyz;

#if NORMALMAP
	// 有法线图时，**光照方向与视线方向都换到切线空间**（片元里法线也是切线空间的），
	// 于是片元不必再传 TBN 矩阵。tangentSpace 的构造见 headers.ts 的 BuildTangentSpace。
	mat3 tangentSpace = BuildTangentSpace(CAST3X3(g_ModelMatrix), a_Normal, a_Tangent4);
	v_Light0DirectionL3X.xyz = mul(tangentSpace, v_Light0DirectionL3X.xyz);
	v_Light1DirectionL3Y.xyz = mul(tangentSpace, v_Light1DirectionL3Y.xyz);
	v_Light2DirectionL3Z.xyz = mul(tangentSpace, v_Light2DirectionL3Z.xyz);
	l3 = mul(tangentSpace, l3);
	v_ViewDir = mul(tangentSpace, v_ViewDir);
#else
	v_Normal = normal;
#endif

	v_Light0DirectionL3X.w = l3.x;
	v_Light1DirectionL3Y.w = l3.y;
	v_Light2DirectionL3Z.w = l3.z;
	// 环境项按法线的「朝天程度」在天空色与地面环境色之间插值（朝上偏 skylight）
	v_LightAmbientColor = mix(g_LightSkylightColor, g_LightAmbientColor, dot(normal, vec3(0, 1, 0)) * 0.5 + 0.5);
}
`;

const GENERIC_FRAG = `// WE 引擎内置 shaders/generic.frag（本仓实现，语义对齐官方 assets 源）
#include "common_fragment.h"

uniform vec4 g_LightsColorRadius[4];

uniform float g_Metallic; // {"material":"Metal","default":0,"range":[0,1]}
uniform float g_Roughness; // {"material":"Rough","default":0,"range":[0,1]}
uniform float g_Light; // {"material":"Light","default":0,"range":[0,1]}

#if DIFFUSETINT
uniform vec3 g_TintColor; // {"material":"Color", "type": "color", "default":"1 1 1"}
uniform float g_TintAlpha; // {"material":"Alpha","default":0,"range":[0,1]}
#endif

uniform sampler2D g_Texture0;

#if NORMALMAP
uniform sampler2D g_Texture1;
#define g_NormalMapSampler g_Texture1

#if LIGHTMAP
uniform sampler2D g_Texture2;
#define g_LightmapMapSampler g_Texture2
#endif

#else

#if LIGHTMAP
uniform sampler2D g_Texture1;
#define g_LightmapMapSampler g_Texture1
#endif

varying vec3 v_Normal;

#endif

#if REFLECTION
uniform sampler2D g_Texture3;
#define g_ReflectionSampler g_Texture3
varying vec3 v_ScreenPos;
#endif

#if LIGHTMAP
varying vec4 v_TexCoord;
#else
varying vec2 v_TexCoord;
#endif

varying vec3 v_ViewDir;
varying vec4 v_Light0DirectionL3X;
varying vec4 v_Light1DirectionL3Y;
varying vec4 v_Light2DirectionL3Z;
varying vec3 v_LightAmbientColor;

void main() {
	vec4 albedo = texSample2D(g_Texture0, v_TexCoord.xy);
	vec3 specularResult = vec3(0, 0, 0);

#if DIFFUSETINT
	albedo.rgb *= g_TintColor;
	albedo.a *= g_TintAlpha;
#endif

#if DETAILINALPHA
	// 自身 uv×3 处的 alpha 当细节层（官方原样 ×2，arsenal 的枪身刻线/桌面木纹靠它）
	albedo.rgb *= texSample2D(g_Texture0, v_TexCoord.xy * 3).a * 2.0;
#endif

	vec3 viewDir = normalize(v_ViewDir);
	float specularPower = ComputeMaterialSpecularPower(g_Roughness, g_Metallic);
	float specularStrength = ComputeMaterialSpecularStrength(g_Roughness, g_Metallic);

#if NORMALMAP
	vec3 normal = DecompressNormal(texSample2D(g_NormalMapSampler, v_TexCoord.xy));
#else
	vec3 normal = normalize(v_Normal);
#endif

	// 四盏点光：0/1/2 用 varyings，第 3 盏由三个 w 分量重组（见 vert）
	vec3 light = ComputeLightSpecular(normal, v_Light0DirectionL3X.xyz, g_LightsColorRadius[0].rgb, g_LightsColorRadius[0].w, viewDir, specularPower, specularStrength, g_Light, g_Metallic, specularResult);

#if LIGHTMAP
	vec3 lightmap = texSample2D(g_LightmapMapSampler, v_TexCoord.zw).rgb;
	light *= lightmap;
	specularResult *= lightmap;
#endif

	light += ComputeLightSpecular(normal, v_Light1DirectionL3Y.xyz, g_LightsColorRadius[1].rgb, g_LightsColorRadius[1].w, viewDir, specularPower, specularStrength, g_Light, g_Metallic, specularResult);
	light += ComputeLightSpecular(normal, v_Light2DirectionL3Z.xyz, g_LightsColorRadius[2].rgb, g_LightsColorRadius[2].w, viewDir, specularPower, specularStrength, g_Light, g_Metallic, specularResult);
	light += ComputeLightSpecular(normal, vec3(v_Light0DirectionL3X.w, v_Light1DirectionL3Y.w, v_Light2DirectionL3Z.w), g_LightsColorRadius[3].rgb, g_LightsColorRadius[3].w, viewDir, specularPower, specularStrength, g_Light, g_Metallic, specularResult);

	light += v_LightAmbientColor;
	albedo.rgb = albedo.rgb * light + specularResult;

#if REFLECTION
	// 屏幕 UV 采样本帧的镜像目标（renderer 的 renderReflectionPass），法线 xy 做少量偏移。
	// 官方的 HLSL_SM30 半像素补偿对 GL 路径不适用（那条只在 HLSL 目标下编译）。
	vec2 screenUV = (v_ScreenPos.xy / v_ScreenPos.z) * 0.5 + 0.5;
	albedo.rgb += texSample2D(g_ReflectionSampler, screenUV + normal.xy * 0.01).rgb * 0.35;
#endif

	gl_FragColor = albedo;
}
`;

/** 引擎内置 shader 源（键 = `shaders/` 下的文件名，调用方按需加前缀） */
export const WE_BUILTIN_SHADERS: Record<string, string> = {
  'flag.vert': FLAG_VERT,
  'flag.frag': FLAG_FRAG,
  'generic.vert': GENERIC_VERT,
  'generic.frag': GENERIC_FRAG,
};
