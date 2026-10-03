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

/** 引擎内置 shader 源（键 = `shaders/` 下的文件名，调用方按需加前缀） */
export const WE_BUILTIN_SHADERS: Record<string, string> = {
  'flag.vert': FLAG_VERT,
  'flag.frag': FLAG_FRAG,
};
