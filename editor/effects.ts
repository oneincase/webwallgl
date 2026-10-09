// 效果库（EDITOR-PLAN §3 W7 基础集 + 扩充集 / §3A 效果库面板）。
//
// 新建壁纸没有 pkg 可蹭官方效果，于是添加效果时把三件套**写进工程**（与 WE 发布时
// 把用到的效果打进包是同一形态），保存产物自包含，现有读链原样加载：
//   effects/wwgl_<id>/effect.json      → passes[0].material
//   materials/effects/wwgl_<id>.json   → passes[0].shader = effects/wwgl_<id>
//   shaders/effects/wwgl_<id>.frag|vert
// shader 全部本仓实现（不搬官方源）；`wwgl_` 前缀避免与官方同名效果混淆。
// uniform 注释里的 `"material"` 名是契约：scene.json 的 constantshadervalues 按它
// （大小写不敏感）落到 uniform 上，缺省时用注释里的 default。

//
// 插件化（PLUGIN-ARCHITECTURE §3.1）：效果定义进 effectCatalog 注册表，内置 14 个由
// builtin-effects 插件登记；EFFECTS 同时作为注册表的 fallback（只兜解码，不进菜单），
// 所以本模块脱离内核也能单独用（verify-editor 直接 import）。插件效果可带多 pass + FBO，
// 产物仍是 WE 的 effect.json 两段式（effect → material → shader），scene.json 的
// constantshadervalues 按参数的 pass 序号落到对应 pass 上。

import type { EditorDoc, SceneObject } from "./doc";
import { createRegistry } from "./core";
import { expandShader } from "./shader-lib";

export type EffectParamType = "float" | "int" | "bool" | "color" | "vec2" | "vec3" | "vec4";

export type EffectParam = {
  key: string;
  type: EffectParamType;
  default: number | boolean | readonly number[];
  min?: number;
  max?: number;
  step?: number;
  /** 落在第几个 pass 的 constantshadervalues（缺省 0） */
  pass?: number;
  /** 界面文案（插件效果用；内置效果走 i18n 的 fxp.<key>） */
  label?: string | Record<string, string>;
  /** 外来效果解析出来的 uniform 名（只读展示用） */
  uniform?: string;
};

/** 多 pass 效果的一个 pass；target = 写进哪个 FBO（缺省 = 效果输出），bind = 读哪些 FBO */
export type EffectPass = {
  frag: string;
  vert?: string;
  target?: string;
  bind?: Array<{ name: string; index: number }>;
  blending?: string;
};

export type EffectFbo = { name: string; scale?: number; format?: string };

export type EffectDef = {
  id: string;
  params: readonly EffectParam[];
  frag: string;
  vert?: string;
  /** 目录前缀（缺省 wwgl_）；外部插件按插件 id 再分一层，避免同名 */
  prefix?: string;
  title?: string | Record<string, string>;
  category?: string;
  /** 原作者署名（改写 / 移植自他人作品的效果必填）；检视器显示「作者：<author>」 */
  author?: string | Record<string, string>;
  /** 作者与出处说明（版权声明）；面板里跟在署名行后面整段显示 */
  note?: string | Record<string, string>;
  /** 多 pass：给出时按它生成全部 pass（passes[0].frag 应与 frag 相同） */
  passes?: readonly EffectPass[];
  fbos?: readonly EffectFbo[];
};

export const EFFECT_PREFIX = "wwgl_";

const VERT = `// WebWallGL 编辑器内置效果：通用全层顶点着色器
uniform mat4 g_ModelViewProjectionMatrix;

attribute vec3 a_Position;
attribute vec2 a_TexCoord;

varying vec2 v_TexCoord;

void main() {
	gl_Position = mul(vec4(a_Position, 1.0), g_ModelViewProjectionMatrix);
	v_TexCoord = a_TexCoord;
}
`;

const HEAD = `varying vec2 v_TexCoord;
uniform sampler2D g_Texture0; // {"hidden":true}
`;

const fmt = (v: number) => String(Math.round(v * 1e4) / 1e4);
const defaultLiteral = (p: EffectParam) =>
  typeof p.default === "number" ? fmt(p.default) : typeof p.default === "boolean" ? (p.default ? "1" : "0") : `"${p.default.map(fmt).join(" ")}"`;

const GLSL_TYPE: Record<EffectParamType, string> = { float: "float", int: "float", bool: "float", color: "vec3", vec2: "vec2", vec3: "vec3", vec4: "vec4" };

/** 由参数表生成 uniform 声明（注释带 material 名 / default / range），shader 与面板同源 */
export function uniforms(params: readonly EffectParam[]): string {
  return params
    .map((p) => {
      const range = p.min !== undefined && p.max !== undefined ? `,"range":[${fmt(p.min)},${fmt(p.max)}]` : "";
      const type = p.type === "color" ? `,"type":"color"` : "";
      return `uniform ${GLSL_TYPE[p.type]} ${uniformName(p.key)}; // {"material":"${p.key}"${type},"default":${defaultLiteral(p)}${range}}`;
    })
    .join("\n");
}

export const uniformName = (key: string) => `g_Fx${key[0].toUpperCase()}${key.slice(1)}`;

function def(id: string, params: EffectParam[], body: string, extra = ""): EffectDef {
  return { id, params, frag: `// WebWallGL 编辑器内置效果：${id}\n${HEAD}${extra}${uniforms(params)}\n\nvoid main() {\n${body}\n}\n` };
}

/** 插件写效果的便捷构造：只给 main 体（body）或整段源码（frag / passes），头部与 uniform 自动生成 */
export type EffectSpec = Omit<EffectDef, "frag" | "passes"> & {
  /** main() 函数体（单 pass 最省事的写法） */
  body?: string;
  /** main() 之前的额外声明（helper 函数 / 额外 uniform） */
  declarations?: string;
  frag?: string;
  passes?: ReadonlyArray<Omit<EffectPass, "frag"> & { frag?: string; body?: string; declarations?: string }>;
};

const passSource = (id: string, params: readonly EffectParam[], pass: number, frag: string | undefined, body: string | undefined, decl = "") =>
  frag ??
  `// WebWallGL 插件效果：${id}${pass ? ` pass ${pass}` : ""}\n${HEAD}${decl}${uniforms(params.filter((p) => (p.pass ?? 0) === pass))}\n\nvoid main() {\n${body ?? "\tgl_FragColor = texSample2D(g_Texture0, v_TexCoord);"}\n}\n`;

export function defineEffect(spec: EffectSpec): EffectDef {
  const { body, declarations, frag, passes, ...rest } = spec;
  if (!passes?.length) return { ...rest, frag: passSource(spec.id, spec.params, 0, frag, body, declarations) };
  const full: EffectPass[] = passes.map((p, i) => {
    const { body: b, declarations: d, frag: f, ...meta } = p;
    return { ...meta, frag: passSource(spec.id, spec.params, i, f, b, d) };
  });
  return { ...rest, frag: full[0].frag, passes: full };
}

// ── 磁流体（cuiliuti）─────────────────────────────────────────────────────
// 原作作者：Hope麻匪（HopeMafei）—— Wallpaper Engine 社区创作者，分享的 WE 自定义
// shader「磁流体」（0ran 收录）。版权与出处见本效果的 author / note 字段（面板署名行
// 与写进工程的 effect.json 描述同源）。
// 本仓重写：raymarching 一团 smin 软融合的
// 小球成黑色铁磁流体，菲涅尔边缘光 + 双高光 + 左右渐变。helper 函数（map/March/AO…）
// 要引用 uniform，而 def() 的 extra 段排在 uniform 声明之前放不下，所以这条不走
// def()：uniform 声明仍由 uniforms() 从参数表生成（shader 与面板同源），函数体
// 手工组装。未上面板的旋钮（镜头 / 高光组 / 抗锯齿 / 渐变角…）按原作缺省写成常量；
// 原作死代码（InsideMarch 厚度、fresnel/spec 中间量、0 角度相机旋转）已删。
// 原作球数上限 80 而滑杆标到 120 —— 上限对齐到 120（numBlobs 只封顶循环，不多画）。
const CUILIUTI_PARAMS: EffectParam[] = [
  { key: "liquid", type: "color", default: [0, 0, 0] },
  { key: "alpha", type: "float", default: 1, min: 0, max: 1, step: 0.01 },
  { key: "blobs", type: "float", default: 80, min: 20, max: 120, step: 1 },
  { key: "speed", type: "float", default: 1, min: 0.1, max: 3, step: 0.05 },
  { key: "scale", type: "float", default: 1, min: 0.5, max: 2, step: 0.05 },
  { key: "motion", type: "float", default: 1, min: 0, max: 3, step: 0.05 },
  { key: "fusion", type: "float", default: 1, min: 0.1, max: 2, step: 0.05 },
  { key: "edge1", type: "color", default: [0.2, 0.5, 0.9] },
  { key: "edge2", type: "color", default: [0.871, 0.435, 0.086] },
  { key: "edgeglow", type: "float", default: 1, min: 0, max: 2, step: 0.05 },
];

const CUILIUTI_SRC = `#define PI 3.1415927
#define STEPS 100
#define AO_STEPS 8
#define SMOOTHING_VAL 0.06
#define numBlobs 120

const float GRADIENT_ROTATION = 0.0;
const float CAMERA_DISTANCE = 4.5;
const float EDGE_SMOOTHNESS = 0.05;
const float EDGE_WIDTH = 1.0;
const float MIN_BLOB_SIZE = 0.02;
const float CENTER_CONCENTRATION = 1.0;
const float FL = 2.0;
const vec3 LOOK_AT = vec3(0.0, 0.0, 0.0);
const vec3 HIGHLIGHT1_COLOR = vec3(1.0, 1.0, 1.0);
const float HIGHLIGHT1_INTENSITY = 0.5;
const float HIGHLIGHT1_CONCENTRATION = 16.0;
const float HIGHLIGHT1_H = 136.0;
const float HIGHLIGHT1_V = 180.0;
const vec3 HIGHLIGHT2_COLOR = vec3(0.8, 0.8, 1.0);
const float HIGHLIGHT2_INTENSITY = 0.3;
const float HIGHLIGHT2_CONCENTRATION = 16.0;
const float HIGHLIGHT2_H = 60.0;
const float HIGHLIGHT2_V = 20.0;

vec4 hash41(float src) {
	vec4 p4 = fract(vec4(src, src, src, src) * vec4(0.1031, 0.1136, 0.1375, 0.1543));
	p4 += dot(p4, p4.wzxy + 33.33);
	return fract((p4.xxyz + p4.yzzw) * p4.zywx);
}

float smin(float a, float b, float k) {
	k *= 6.0;
	float h = max(k - abs(a - b), 0.0) / k;
	return min(a, b) - h * h * h * k * (1.0 / 6.0);
}

vec4 getBlob(int i, float time) {
	vec4 rand1 = hash41(float(i));
	vec4 rand2 = hash41(float(i) * 1.3145);
	vec3 freq = mix(vec3(0.4, 0.4, 0.4), vec3(2.8, 2.8, 2.8), rand1.xyz);
	vec3 phase = mix(vec3(0.0, 0.0, 0.0), vec3(2.0 * PI, 2.0 * PI, 2.0 * PI), rand2.xyz);
	float moveRad = mix(0.2, 1.0, rand2.w);
	float rad = max(mix(0.15, 0.5, rand1.w * rand1.w) * exp(-moveRad * 1.75), MIN_BLOB_SIZE);
	freq *= g_FxSpeed;
	rad *= g_FxScale;
	moveRad *= g_FxMotion;
	vec3 bp = vec3(sin(time * freq.x + phase.x), cos(time * freq.y + phase.y), sin(time * freq.z + phase.z)) * vec3(moveRad, moveRad, moveRad);
	return vec4(bp, rad);
}

float map(vec3 p) {
	float d = 100000.0;
	int blobCount = int(g_FxBlobs);
	for (int i = 0; i < blobCount; i++) {
		if (i >= numBlobs) break;
		vec4 blob = getBlob(i, g_Time);
		d = smin(d, length(p - blob.xyz) - blob.w, SMOOTHING_VAL * g_FxFusion);
	}
	return d;
}

float March(vec3 ro, vec3 rd, out float endD) {
	float t = 0.0;
	for (int i = 0; i < STEPS; i++) {
		vec3 p = ro + t * rd;
		float d = map(p);
		endD = d;
		if (d < 0.001) return t;
		t += d;
		if (t > 20.0) return t;
	}
	return t;
}

vec3 Normal(vec3 p) {
	const float h = 0.001;
	const vec2 k = vec2(1.0, -1.0);
	return normalize(k.xyy * map(p + k.xyy * h) +
	                 k.yyx * map(p + k.yyx * h) +
	                 k.yxy * map(p + k.yxy * h) +
	                 k.xxx * map(p + k.xxx * h));
}

float AO(vec3 pos, vec3 nor) {
	float occ = 0.0;
	float sca = 1.0;
	for (int i = 0; i < AO_STEPS; i++) {
		float t = 0.01 + 0.08 * float(i);
		float d = map(pos + t * nor);
		occ += (t - d) * sca;
		sca *= 0.85;
	}
	return clamp(1.0 - occ / 3.14, 0.0, 1.0);
}

vec3 Render(vec3 ro, vec3 rd, float d) {
	vec3 p = ro + d * rd;
	vec3 nor = Normal(p);
	vec3 lightDir = normalize(vec3(-1.0, 2.0, 0.0));
	float ssFake = clamp(dot(nor, lightDir) * 0.5 + 0.5, 0.0, 1.0);
	float ao = AO(p, nor);
	float ambientStrength = 0.2 + 0.6 * clamp((CENTER_CONCENTRATION - 0.1) / 2.9, 0.0, 1.0);
	vec3 lighting = mix(vec3(ambientStrength, ambientStrength, ambientStrength), vec3(1.0, 1.0, 1.0), ssFake);
	vec3 liquidCol = g_FxLiquid * lighting * (ao * 0.5 + 0.5);
	vec3 highlight1Dir = normalize(vec3(
		cos(HIGHLIGHT1_H * PI / 180.0) * sin(HIGHLIGHT1_V * PI / 180.0),
		cos(HIGHLIGHT1_V * PI / 180.0),
		sin(HIGHLIGHT1_H * PI / 180.0) * sin(HIGHLIGHT1_V * PI / 180.0)
	));
	vec3 highlight2Dir = normalize(vec3(
		cos(HIGHLIGHT2_H * PI / 180.0) * sin(HIGHLIGHT2_V * PI / 180.0),
		cos(HIGHLIGHT2_V * PI / 180.0),
		sin(HIGHLIGHT2_H * PI / 180.0) * sin(HIGHLIGHT2_V * PI / 180.0)
	));
	vec3 refDir = reflect(rd, nor);
	float highlight1 = pow(clamp(dot(refDir, highlight1Dir), 0.0, 1.0), HIGHLIGHT1_CONCENTRATION);
	float highlight2 = pow(clamp(dot(refDir, highlight2Dir), 0.0, 1.0), HIGHLIGHT2_CONCENTRATION);
	liquidCol += HIGHLIGHT1_COLOR * highlight1 * HIGHLIGHT1_INTENSITY;
	liquidCol += HIGHLIGHT2_COLOR * highlight2 * HIGHLIGHT2_INTENSITY;
	float gradientAngle = GRADIENT_ROTATION * PI / 180.0;
	float gradientFactor = clamp(dot(p.xy, vec2(cos(gradientAngle), sin(gradientAngle))) * 0.5 + 0.5, 0.0, 1.0);
	float rimIntensity = pow(1.0 - abs(dot(rd, nor)), 4.0 / max(0.1, EDGE_WIDTH)) * g_FxEdgeglow;
	liquidCol += mix(g_FxEdge1, g_FxEdge2, gradientFactor) * rimIntensity;
	return clamp(liquidCol, vec3(0.0, 0.0, 0.0), vec3(1.0, 1.0, 1.0));
}

void main() {
	vec2 uv = v_TexCoord * 2.0 - 1.0;
	uv.x *= g_TexelSize.y / g_TexelSize.x;
	vec3 ro = vec3(0.0, 0.0, CAMERA_DISTANCE);
	vec3 cf = normalize(LOOK_AT - ro);
	vec3 cr = normalize(cross(cf, vec3(0.0, 1.0, 0.0)));
	vec3 cu = normalize(cross(cr, cf));
	vec3 rd = normalize(uv.x * cr + uv.y * cu + FL * cf);
	float endD;
	float d = March(ro, rd, endD);
	float edgeAlpha = 1.0 - smoothstep(0.001, 0.001 + EDGE_SMOOTHNESS, endD);
	vec3 col = vec3(0.0, 0.0, 0.0);
	if (edgeAlpha > 0.0) col = Render(ro, rd, d);
	col = pow(col, vec3(1.0 / 2.2, 1.0 / 2.2, 1.0 / 2.2));
	gl_FragColor = vec4(col, g_FxAlpha * edgeAlpha);
}`;

/** 音频频谱条的参数与着色器：柱子从中线向上下长（不依赖 v_TexCoord 的上下方向） */
const AUDIOBARS_PARAMS: EffectParam[] = [
  { key: "color", type: "color", default: [0.36, 0.78, 1] },
  { key: "amount", type: "float", default: 1, min: 0, max: 1, step: 0.01 },
  { key: "scale", type: "float", default: 1.4, min: 0, max: 4, step: 0.05 },
  { key: "width", type: "float", default: 0.72, min: 0.05, max: 1, step: 0.01 },
  { key: "softness", type: "float", default: 0.3, min: 0, max: 1, step: 0.01 },
  { key: "mirror", type: "float", default: 1, min: 0, max: 1, step: 1 },
];

// WE 内置 uniform 名（renderer 按名绑定；官方 pulse / shake / Simple Audio Bars 用的同一组）。
// 只声明 32 段一组：柱子按 32 段画，粒子 / 文字脚本另有自己的入口。
const AUDIOBARS_DECL = `uniform float g_AudioSpectrum32Left[32];
uniform float g_AudioSpectrum32Right[32];
`;

const AUDIOBARS_BODY = `	vec4 base = texSample2D(g_Texture0, v_TexCoord);
	vec3 c = base.rgb;
	float cell = 1.0 / 32.0;
	float x = g_FxMirror > 0.5 ? abs(v_TexCoord.x * 2.0 - 1.0) : v_TexCoord.x;
	float d = abs(v_TexCoord.y - 0.5) * 2.0;
	float w = max(g_FxWidth * cell * 0.5, 0.001);
	for (int i = 0; i < 32; ++i) {
		float band = clamp((g_AudioSpectrum32Left[i] + g_AudioSpectrum32Right[i]) * 0.5 * g_FxScale, 0.0, 1.0);
		if (band > 0.0) {
			float bx = abs(x - (float(i) + 0.5) * cell);
			float barH = band * 0.5;
			float barX = 1.0 - smoothstep(w - g_FxSoftness * w, w, bx);
			float barY = 1.0 - smoothstep(barH - g_FxSoftness * 0.5, barH, d);
			c = mix(c, g_FxColor, clamp(barX * barY * g_FxAmount, 0.0, 1.0));
		}
	}
	gl_FragColor = vec4(c, base.a);
`;

export const EFFECTS: readonly EffectDef[] = [
  def(
    "tint",
    [
      { key: "color", type: "color", default: [1, 0.45, 0.2] },
      { key: "amount", type: "float", default: 0.5, min: 0, max: 1, step: 0.01 },
    ],
    `	vec4 c = texSample2D(g_Texture0, v_TexCoord);
	c.rgb = mix(c.rgb, g_FxColor, g_FxAmount);
	gl_FragColor = c;`,
  ),
  def(
    "adjust",
    [
      { key: "brightness", type: "float", default: 0, min: -1, max: 1, step: 0.01 },
      { key: "contrast", type: "float", default: 1, min: 0, max: 3, step: 0.01 },
      { key: "saturation", type: "float", default: 1, min: 0, max: 3, step: 0.01 },
    ],
    `	vec4 c = texSample2D(g_Texture0, v_TexCoord);
	vec3 rgb = c.rgb + vec3(g_FxBrightness, g_FxBrightness, g_FxBrightness);
	rgb = (rgb - vec3(0.5, 0.5, 0.5)) * g_FxContrast + vec3(0.5, 0.5, 0.5);
	float l = dot(rgb, vec3(0.299, 0.587, 0.114));
	rgb = mix(vec3(l, l, l), rgb, g_FxSaturation);
	gl_FragColor = vec4(clamp(rgb, 0.0, 1.0), c.a);`,
  ),
  def(
    "vignette",
    [
      { key: "strength", type: "float", default: 0.8, min: 0, max: 1, step: 0.01 },
      { key: "radius", type: "float", default: 0.65, min: 0, max: 1.5, step: 0.01 },
      { key: "softness", type: "float", default: 0.45, min: 0.01, max: 1, step: 0.01 },
    ],
    `	vec4 c = texSample2D(g_Texture0, v_TexCoord);
	float d = length(v_TexCoord - vec2(0.5, 0.5)) * 1.41421356;
	float v = 1.0 - smoothstep(g_FxRadius - g_FxSoftness, g_FxRadius, d);
	c.rgb *= mix(1.0, v, g_FxStrength);
	gl_FragColor = c;`,
  ),
  def(
    "blur",
    [{ key: "radius", type: "float", default: 2, min: 0, max: 8, step: 0.1 }],
    `	vec2 px = g_FxRadius / max(g_Texture0Resolution.xy, vec2(1.0, 1.0));
	vec4 sum = vec4(0.0, 0.0, 0.0, 0.0);
	float wsum = 0.0;
	for (int i = -3; i <= 3; i++) {
		for (int j = -3; j <= 3; j++) {
			float w = exp(-float(i * i + j * j) / 8.0);
			sum += texSample2D(g_Texture0, v_TexCoord + vec2(float(i), float(j)) * px) * w;
			wsum += w;
		}
	}
	gl_FragColor = sum / wsum;`,
    "uniform vec4 g_Texture0Resolution;\n",
  ),
  def(
    "wave",
    [
      { key: "amplitude", type: "float", default: 0.02, min: 0, max: 0.2, step: 0.001 },
      { key: "frequency", type: "float", default: 4, min: 0, max: 40, step: 0.1 },
      { key: "speed", type: "float", default: 1, min: 0, max: 10, step: 0.05 },
    ],
    `	vec2 uv = v_TexCoord;
	uv.x += sin((uv.y * g_FxFrequency + g_Time * g_FxSpeed) * 6.2831853) * g_FxAmplitude;
	vec4 c = texSample2D(g_Texture0, uv);
	c *= step(0.0, uv.x) * step(uv.x, 1.0);
	gl_FragColor = c;`,
    "uniform float g_Time;\n",
  ),
  def(
    "scroll",
    [
      { key: "speedx", type: "float", default: 0.1, min: -2, max: 2, step: 0.01 },
      { key: "speedy", type: "float", default: 0, min: -2, max: 2, step: 0.01 },
    ],
    `	vec2 uv = fract(v_TexCoord + vec2(g_FxSpeedx, g_FxSpeedy) * g_Time);
	gl_FragColor = texSample2D(g_Texture0, uv);`,
    "uniform float g_Time;\n",
  ),
  def(
    "pulse",
    [
      { key: "speed", type: "float", default: 0.5, min: 0, max: 5, step: 0.01 },
      { key: "amount", type: "float", default: 0.5, min: 0, max: 1, step: 0.01 },
    ],
    `	vec4 c = texSample2D(g_Texture0, v_TexCoord);
	c.a *= 1.0 - g_FxAmount * (0.5 + 0.5 * sin(g_Time * g_FxSpeed * 6.2831853));
	gl_FragColor = c;`,
    "uniform float g_Time;\n",
  ),
  def(
    "outline",
    [
      { key: "color", type: "color", default: [0, 0, 0] },
      { key: "width", type: "float", default: 3, min: 0, max: 16, step: 0.5 },
    ],
    `	vec2 px = g_FxWidth / max(g_Texture0Resolution.xy, vec2(1.0, 1.0));
	vec4 c = texSample2D(g_Texture0, v_TexCoord);
	float a = 0.0;
	for (int i = 0; i < 16; i++) {
		float t = float(i) * 0.39269908;
		a = max(a, texSample2D(g_Texture0, v_TexCoord + vec2(cos(t), sin(t)) * px).a);
	}
	gl_FragColor = vec4(mix(g_FxColor, c.rgb, c.a), max(c.a, a));`,
    "uniform vec4 g_Texture0Resolution;\n",
  ),
  def(
    "glow",
    [
      { key: "color", type: "color", default: [1, 0.85, 0.4] },
      { key: "radius", type: "float", default: 4, min: 0, max: 16, step: 0.1 },
      { key: "strength", type: "float", default: 1.5, min: 0, max: 4, step: 0.05 },
    ],
    `	vec2 px = g_FxRadius / max(g_Texture0Resolution.xy, vec2(1.0, 1.0));
	vec4 c = texSample2D(g_Texture0, v_TexCoord);
	float a = 0.0;
	float wsum = 0.0;
	for (int i = -3; i <= 3; i++) {
		for (int j = -3; j <= 3; j++) {
			float w = exp(-float(i * i + j * j) / 8.0);
			a += texSample2D(g_Texture0, v_TexCoord + vec2(float(i), float(j)) * px).a * w;
			wsum += w;
		}
	}
	a = clamp(a / wsum * g_FxStrength, 0.0, 1.0);
	gl_FragColor = vec4(mix(g_FxColor, c.rgb, c.a), max(c.a, a));`,
    "uniform vec4 g_Texture0Resolution;\n",
  ),
  def(
    "chroma",
    [
      { key: "amount", type: "float", default: 0.006, min: 0, max: 0.05, step: 0.0005 },
      { key: "angle", type: "float", default: 0, min: 0, max: 6.2832, step: 0.01 },
    ],
    `	vec2 d = vec2(cos(g_FxAngle), sin(g_FxAngle)) * g_FxAmount;
	vec4 r = texSample2D(g_Texture0, v_TexCoord + d);
	vec4 c = texSample2D(g_Texture0, v_TexCoord);
	vec4 b = texSample2D(g_Texture0, v_TexCoord - d);
	gl_FragColor = vec4(r.r, c.g, b.b, max(max(r.a, c.a), b.a));`,
  ),
  def(
    "pixelate",
    [{ key: "size", type: "float", default: 8, min: 1, max: 64, step: 1 }],
    `	vec2 cell = max(g_FxSize, 1.0) / max(g_Texture0Resolution.xy, vec2(1.0, 1.0));
	vec2 uv = (floor(v_TexCoord / cell) + vec2(0.5, 0.5)) * cell;
	gl_FragColor = texSample2D(g_Texture0, uv);`,
    "uniform vec4 g_Texture0Resolution;\n",
  ),
  def(
    "shine",
    [
      { key: "color", type: "color", default: [1, 1, 1] },
      { key: "width", type: "float", default: 0.12, min: 0.01, max: 0.5, step: 0.01 },
      { key: "speed", type: "float", default: 0.4, min: 0, max: 4, step: 0.01 },
      { key: "angle", type: "float", default: 0.6, min: 0, max: 6.2832, step: 0.01 },
      { key: "strength", type: "float", default: 0.8, min: 0, max: 2, step: 0.01 },
    ],
    `	vec4 c = texSample2D(g_Texture0, v_TexCoord);
	float p = dot(v_TexCoord - vec2(0.5, 0.5), vec2(cos(g_FxAngle), sin(g_FxAngle))) + 0.5;
	float pos = fract(g_Time * g_FxSpeed) * (1.0 + 4.0 * g_FxWidth) - 2.0 * g_FxWidth;
	float band = 1.0 - smoothstep(0.0, g_FxWidth, abs(p - pos));
	c.rgb = clamp(c.rgb + g_FxColor * band * g_FxStrength, 0.0, 1.0);
	gl_FragColor = c;`,
    "uniform float g_Time;\n",
  ),
  def(
    "fade",
    [
      { key: "angle", type: "float", default: 0, min: 0, max: 6.2832, step: 0.01 },
      { key: "start", type: "float", default: 0.2, min: -0.5, max: 1.5, step: 0.01 },
      { key: "end", type: "float", default: 0.8, min: -0.5, max: 1.5, step: 0.01 },
    ],
    `	vec4 c = texSample2D(g_Texture0, v_TexCoord);
	float p = dot(v_TexCoord - vec2(0.5, 0.5), vec2(cos(g_FxAngle), sin(g_FxAngle))) + 0.5;
	float lo = min(g_FxStart, g_FxEnd);
	float hi = max(g_FxStart, g_FxEnd) + 0.0001;
	float m = smoothstep(lo, hi, p);
	c.a *= g_FxStart <= g_FxEnd ? m : 1.0 - m;
	gl_FragColor = c;`,
  ),
  {
    id: "cuiliuti",
    author: "Hope麻匪（HopeMafei）",
    // 署名说明：写进面板（检视器）与工程里的 effect.json description，两处同源
    note: {
      zh: "原作者：Hope麻匪（HopeMafei）。Wallpaper Engine 社区创作者，公开分享的「磁流体」自定义 shader（0ran 收录）。本仓按原 shader 重写为 WebWallGL 效果并补齐滑杆 + 中英文文案：相同参数下观感与原作一致。",
      en: "Original author: Hope麻匪 (HopeMafei), a Wallpaper Engine community creator who publicly shared the \"Ferrofluid\" custom shader (collected by 0ran). Reimplemented here as a WebWallGL effect with sliders and zh / en labels: it looks the same as the original for the same settings.",
    },
    params: CUILIUTI_PARAMS,
    frag: `// WebWallGL 编辑器内置效果：cuiliuti（磁流体）
// 原作作者：Hope麻匪（HopeMafei）—— WE 社区创作者，公开分享的「磁流体」自定义 shader
// 版权与出处：见 effect.json 的备注 / 本仓 README「效果署名与致谢」
${HEAD}uniform float g_Time;
uniform vec2 g_TexelSize;
${uniforms(CUILIUTI_PARAMS)}

${CUILIUTI_SRC}
`,
  },
  // ── 音频频谱条（audiobars）───────────────────────────────────────────────
  // 音频反应图层的现成做法：引擎每帧把系统音频 / BGM 的频谱喂给 g_AudioSpectrum* uniform
  // （renderer 按名绑定，WE 官方 pulse / shake 用的是同一组名字），这里把它画成 32 根
  // 从中线向上下长的柱子。挂在铺满画面的图层上就是一条完整频谱条；编辑器里想看到它动，
  // 渲染面板把音量拉起来、或开「系统音频」/点「试听」（editor/audio-live.ts 两条源）。
  // 追加在 EFFECTS 末尾：verify-editor 断言前 13 个 id 的顺序（基础集 / 扩充集）。
  // 名字与参数文案走 i18n 的 fx.audiobars / fxp.*（内置效果一律如此，不写 title）。
  {
    ...def("audiobars", AUDIOBARS_PARAMS, AUDIOBARS_BODY, AUDIOBARS_DECL),
    category: "audio",
  },
];

/**
 * 效果注册表：菜单列 list()（插件登记的），解码查 get()（登记的优先，回落内置表）。
 * 内置表作 fallback：builtin-effects 插件被禁用时，已有工程里的 wwgl_ 效果仍可识别、调参。
 */
export const effectCatalog = createRegistry<EffectDef>("effects", {
  validate: (d) => {
    if (!/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(d.id)) throw new Error(`效果 id 只能是小写字母数字（可用 _ 分段）：${d.id}`);
    if (d.prefix !== undefined && !/^[a-z0-9_]*$/.test(d.prefix)) throw new Error(`效果前缀非法：${d.prefix}`);
    if (d.passes && d.passes.length > 1 && d.passes.slice(0, -1).some((p) => !p.target)) {
      throw new Error(`多 pass 效果 ${d.id}：除最后一个外每个 pass 都要写 target（FBO 名）`);
    }
  },
});
effectCatalog.setFallback(EFFECTS);

export const effectById = (id: string) => effectCatalog.get(id) ?? null;

/** 效果在工程里的目录名（effects/<dir>/effect.json） */
export const effectDirOf = (d: Pick<EffectDef, "id" | "prefix">) => `${d.prefix ?? EFFECT_PREFIX}${d.id}`;

export const effectFileOf = (id: string) => `effects/${effectDirOf(effectById(id) ?? { id })}/effect.json`;

/** scene.json 里的效果文件路径 → 已登记效果 id（不是本库 / 插件的效果返回 null） */
export function effectIdOf(file: unknown): string | null {
  if (typeof file !== "string") return null;
  const m = /^effects\/([a-z0-9_]+)\/effect\.json$/.exec(file);
  if (!m) return null;
  const dir = m[1];
  if (dir.startsWith(EFFECT_PREFIX)) {
    const d = effectById(dir.slice(EFFECT_PREFIX.length));
    if (d && effectDirOf(d) === dir) return d.id;
  }
  for (const d of [...effectCatalog.list(), ...EFFECTS]) if (effectDirOf(d) === dir) return d.id;
  return null;
}

/** 写进工程前的 shader 源码加工：编辑器片段 include 内联展开（WE 自己的 include 不动） */
const shaderTransform = (src: string) => expandShader(src);

/** 署名说明取当前语言：单字符串直用，双语表按主语言挑（缺了回落 en / zh / 第一项） */
export function effectNote(nd: EffectDef, lang = "zh"): string {
  const v = nd.note;
  if (!v) return "";
  if (typeof v === "string") return v;
  const base = (l: string) => l.split(/[-_]/)[0].toLowerCase();
  const pick = (l: string) => {
    if (v[l] !== undefined) return v[l];
    const k = Object.keys(v).find((x) => base(x) === base(l));
    return k === undefined ? undefined : v[k];
  };
  return pick(lang) ?? pick("en") ?? pick("zh") ?? Object.values(v)[0] ?? "";
}

/** 一个效果写进工程的文件：effect.json + 每个 pass 的材质 / frag / vert */
export function effectFiles(d: EffectDef, lang = "zh"): Array<{ name: string; data: Uint8Array }> {
  const enc = new TextEncoder();
  const dir = effectDirOf(d);
  const passes: EffectPass[] = d.passes?.length ? [...d.passes] : [{ frag: d.frag, vert: d.vert }];
  const names = passes.map((_, i) => (i ? `${dir}_p${i}` : dir));
  const materials = names.map((n) => `materials/effects/${n}.json`);
  const effect: Record<string, unknown> = {
    version: 1,
    name: dir,
    group: "webwallgl",
    passes: passes.map((p, i) => {
      const e: Record<string, unknown> = { material: materials[i] };
      if (p.target) e.target = p.target;
      if (p.bind?.length) e.bind = p.bind;
      return e;
    }),
  };
  if (d.fbos?.length) effect.fbos = d.fbos.map((f) => ({ name: f.name, scale: f.scale ?? 1, format: f.format ?? "rgba8888" }));
  // 有署名说明的效果（改写 / 移植自他人作品的）把说明写进 description：工程自包含地带着版权与出处
  const note = effectNote(d, lang);
  if (note) {
    const author = typeof d.author === "string" ? d.author : "";
    effect.description = author ? `${note}\n作者 / Author：${author}` : note;
  }
  effect.dependencies = names.flatMap((n, i) => [materials[i], `shaders/effects/${n}.frag`, `shaders/effects/${n}.vert`]);
  const out = [{ name: `effects/${dir}/effect.json`, data: enc.encode(JSON.stringify(effect, null, 2)) }];
  passes.forEach((p, i) => {
    const shader = `effects/${names[i]}`;
    const mat = {
      passes: [{ shader, blending: p.blending ?? "normal", cullmode: "nocull", depthtest: "disabled", depthwrite: "disabled" }],
    };
    out.push({ name: materials[i], data: enc.encode(JSON.stringify(mat, null, 2)) });
    out.push({ name: `shaders/${shader}.frag`, data: enc.encode(shaderTransform(p.frag)) });
    out.push({ name: `shaders/${shader}.vert`, data: enc.encode(shaderTransform(p.vert ?? VERT)) });
  });
  return out;
}

export type EffectValue = number | boolean | number[];

const vecLen = (t: EffectParamType) => (t === "vec2" ? 2 : t === "vec4" ? 4 : t === "color" || t === "vec3" ? 3 : 0);

/** scene.json 的常量写法：标量 = 数字，颜色 / 向量 = "a b c" 字符串（与 WE 同） */
export function encodeValue(p: EffectParam, v: EffectValue): number | string {
  if (p.type === "color") {
    const c = Array.isArray(v) ? v : [Number(v), Number(v), Number(v)];
    return c.map((x) => fmt(Math.max(0, Math.min(1, x)))).join(" ");
  }
  const n0 = vecLen(p.type);
  if (n0) {
    const c = Array.isArray(v) ? v : new Array(n0).fill(Number(v));
    return Array.from({ length: n0 }, (_, i) => fmt(Number(c[i] ?? 0))).join(" ");
  }
  if (p.type === "bool") return v === true || (typeof v === "number" && v !== 0) ? 1 : 0;
  const n = typeof v === "number" ? v : Array.isArray(v) ? v[0] : Number(v);
  const lo = p.min ?? -Infinity;
  const hi = p.max ?? Infinity;
  const r = Math.round(Math.max(lo, Math.min(hi, n)) * 1e4) / 1e4;
  return p.type === "int" ? Math.round(r) : r;
}

export function decodeValue(p: EffectParam, raw: unknown): EffectValue {
  const v = raw && typeof raw === "object" && !Array.isArray(raw) && "value" in raw ? (raw as { value: unknown }).value : raw;
  if (p.type === "color") {
    const parts = typeof v === "string" ? v.trim().split(/\s+/).map(Number) : [];
    return parts.length >= 3 && parts.every(Number.isFinite)
      ? [parts[0], parts[1], parts[2]]
      : ([...(p.default as readonly number[])] as [number, number, number]);
  }
  const n0 = vecLen(p.type);
  if (n0) {
    const parts = typeof v === "string" ? v.trim().split(/\s+/).map(Number) : Array.isArray(v) ? v.map(Number) : typeof v === "number" ? [v] : [];
    const dflt = Array.isArray(p.default) ? [...p.default] : new Array(n0).fill(Number(p.default) || 0);
    return parts.length && parts.every(Number.isFinite) ? Array.from({ length: n0 }, (_, i) => parts[i] ?? parts[parts.length - 1]) : dflt;
  }
  if (p.type === "bool") {
    const b = v === true || v === "true" || (typeof v === "number" ? v !== 0 : typeof v === "string" ? Number(v) !== 0 && v !== "" : false);
    return v === undefined || v === null ? !!p.default : b;
  }
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : (p.default as number);
}

type EffectEntry = {
  file: string;
  name?: string;
  visible?: unknown;
  passes?: Array<{ constantshadervalues?: Record<string, unknown> }>;
};

const effectsOf = (obj: SceneObject): EffectEntry[] | null => (Array.isArray(obj.effects) ? (obj.effects as EffectEntry[]) : null);

/** 给图层追加一个内置效果（参数取缺省值），返回它在 effects[] 里的序号 */
export function addEffect(obj: SceneObject, id: string): number | null {
  const d = effectById(id);
  if (!d) return null;
  if (!Array.isArray(obj.effects)) obj.effects = [];
  const list = obj.effects as EffectEntry[];
  const passCount = Math.max(1, d.passes?.length ?? 1);
  const perPass: Array<Record<string, number | string>> = Array.from({ length: passCount }, () => ({}));
  for (const p of d.params) perPass[Math.min(p.pass ?? 0, passCount - 1)][p.key] = encodeValue(p, p.default as EffectValue);
  list.push({ file: effectFileOf(id), name: id, visible: true, passes: perPass.map((constants) => ({ constantshadervalues: constants })) });
  return list.length - 1;
}

export function removeEffect(obj: SceneObject, index: number): boolean {
  const list = effectsOf(obj);
  if (!list || index < 0 || index >= list.length) return false;
  list.splice(index, 1);
  if (!list.length) delete obj.effects;
  return true;
}

/** 与相邻效果交换（效果链按数组顺序串联，前面的先作用） */
export function moveEffect(obj: SceneObject, index: number, dir: -1 | 1): boolean {
  const list = effectsOf(obj);
  const j = index + dir;
  if (!list || index < 0 || index >= list.length || j < 0 || j >= list.length) return false;
  [list[index], list[j]] = [list[j], list[index]];
  return true;
}

export function setEffectVisible(obj: SceneObject, index: number, visible: boolean): boolean {
  const e = effectsOf(obj)?.[index];
  if (!e) return false;
  const cur = e.visible;
  if (cur && typeof cur === "object" && "value" in (cur as object)) (cur as { value: unknown }).value = visible;
  else e.visible = visible;
  return true;
}

export function isEffectVisible(entry: { visible?: unknown }): boolean {
  const v = entry.visible && typeof entry.visible === "object" ? (entry.visible as { value?: unknown }).value : entry.visible;
  return v === undefined || v === null ? true : v !== false && v !== 0 && v !== "0" && v !== "false";
}

/** 改一个参数。字段若是 `{user, value}` / `{script, value}` 包装，只改快照值 */
export function setEffectParam(obj: SceneObject, index: number, key: string, value: EffectValue, params?: readonly EffectParam[]): boolean {
  const e = effectsOf(obj)?.[index];
  const id = effectIdOf(e?.file);
  const p = (params ?? (id ? effectById(id)!.params : undefined))?.find((x) => x.key === key);
  if (!e || !p) return false;
  if (!Array.isArray(e.passes) || !e.passes.length) e.passes = [{}];
  while (e.passes.length <= (p.pass ?? 0)) e.passes.push({});
  const pass = e.passes[p.pass ?? 0];
  pass.constantshadervalues ??= {};
  const enc = encodeValue(p, value);
  const cur = pass.constantshadervalues[key];
  if (cur && typeof cur === "object" && !Array.isArray(cur) && "value" in (cur as object)) (cur as { value: unknown }).value = enc;
  else pass.constantshadervalues[key] = enc;
  return true;
}

export type EffectView = {
  index: number;
  file: string;
  name: string;
  visible: boolean;
  /** 已登记（内置 / 插件）的效果才有定义 */
  def: EffectDef | null;
  values: Record<string, EffectValue>;
};

function readValues(e: EffectEntry, params: readonly EffectParam[]): Record<string, EffectValue> {
  const lowers = (e.passes ?? []).map((ps) => new Map(Object.entries(ps?.constantshadervalues ?? {}).map(([k, v]) => [k.toLowerCase(), v])));
  const values: Record<string, EffectValue> = {};
  for (const p of params) values[p.key] = decodeValue(p, lowers[p.pass ?? 0]?.get(p.key.toLowerCase()));
  return values;
}

export function effectViews(obj: SceneObject): EffectView[] {
  return (effectsOf(obj) ?? []).map((e, index) => {
    const id = effectIdOf(e.file);
    const d = id ? effectById(id) : null;
    return {
      index,
      file: e.file,
      name: typeof e.name === "string" && e.name ? e.name : (e.file.split("/").slice(-2, -1)[0] ?? e.file),
      visible: isEffectVisible(e),
      def: d,
      values: readValues(e, d?.params ?? []),
    };
  });
}

/** 外来效果（WE 官方 / 工坊）：按解析出的参数表读当前值 */
export function externalValues(obj: SceneObject, index: number, params: readonly EffectParam[]): Record<string, EffectValue> {
  const e = effectsOf(obj)?.[index];
  return e ? readValues(e, params) : {};
}

// ---------- 外来效果调参：从 shader 的 uniform 注释还原参数表 ----------

const UNIFORM_RE = /^[ \t]*uniform[ \t]+(float|int|bool|vec2|vec3|vec4)[ \t]+(\w+)[ \t]*;[ \t]*\/\/[ \t]*(\{.*\})[ \t]*$/gm;

/**
 * WE 的 shader 契约：`uniform <type> g_X; // {"material":"key","default":…,"range":[a,b]}`，
 * scene.json 的 constantshadervalues 按 material 名（大小写不敏感）落到 uniform 上。
 * 带 material 名的 uniform 就是可调参数；combo / 贴图不在此列。
 */
export function parseShaderParams(src: string, pass = 0): EffectParam[] {
  const out: EffectParam[] = [];
  for (const m of src.matchAll(UNIFORM_RE)) {
    let note: Record<string, unknown>;
    try {
      note = JSON.parse(m[3]);
    } catch {
      continue;
    }
    const key = typeof note.material === "string" ? note.material : "";
    if (!key || out.some((p) => p.key.toLowerCase() === key.toLowerCase())) continue;
    const glsl = m[1];
    const type: EffectParamType =
      glsl === "vec3" && (note.type === "color" || /colou?r/i.test(key) || /colou?r/i.test(m[2])) ? "color" : glsl === "int" ? "int" : glsl === "bool" ? "bool" : (glsl as EffectParamType);
    const range = Array.isArray(note.range) && note.range.length >= 2 ? note.range.map(Number) : null;
    const n = vecLen(type);
    const dv = note.default;
    const dflt =
      n > 0
        ? (typeof dv === "string" ? dv.trim().split(/\s+/).map(Number) : Array.isArray(dv) ? dv.map(Number) : new Array(n).fill(Number(dv) || 0)).slice(0, n)
        : type === "bool"
          ? !!Number(dv)
          : Number.isFinite(Number(dv))
            ? Number(dv)
            : 0;
    const label = typeof note.label === "string" && !/^ui_/.test(note.label) ? note.label : key;
    out.push({
      key,
      type,
      default: dflt as EffectParam["default"],
      ...(range && Number.isFinite(range[0]) && Number.isFinite(range[1]) ? { min: range[0], max: range[1], step: type === "int" ? 1 : Math.max((range[1] - range[0]) / 200, 0.0001) } : {}),
      pass,
      label,
      uniform: m[2],
    });
  }
  return out;
}

type ReadText = (name: string) => Promise<string | null>;

const parseJsonLoose = (s: string | null): Record<string, unknown> | null => {
  if (!s) return null;
  try {
    return JSON.parse(s.replace(/^\uFEFF/, "")) as Record<string, unknown>;
  } catch {
    return null;
  }
};

/**
 * 按 pass 还原外来效果的参数表：`effect.json` 的 passes[i].material → 材质 JSON 的
 * passes[0].shader → `shaders/<shader>.frag/.vert` 的 uniform 注释。
 *
 * 与 `inspectEffectParams` 的差别只有形状：这里**保留 pass 下标**（含没有可调参数的
 * pass），因为面板要按 effect/pass 折叠，而且写回必须落到 scene.json 里**同一个下标**
 * 的 `constantshadervalues` 上（一条效果可以有多个 pass，各自材质不同）。
 */
export async function inspectEffectPasses(file: string, read: ReadText): Promise<InlinePassParams[]> {
  const ej = parseJsonLoose(await read(file));
  const passes = Array.isArray(ej?.passes) ? (ej!.passes as Array<Record<string, unknown>>) : [];
  const out: InlinePassParams[] = [];
  for (let i = 0; i < passes.length; i++) {
    const mat = typeof passes[i]?.material === "string" ? parseJsonLoose(await read(passes[i].material as string)) : null;
    const shader = (mat?.passes as Array<Record<string, unknown>> | undefined)?.[0]?.shader;
    const params: EffectParam[] = [];
    if (typeof shader === "string") {
      for (const ext of ["frag", "vert"]) {
        const src = await read(`shaders/${shader}.${ext}`);
        if (!src) continue;
        // 同一 pass 内大小写去重（引擎按大小写不敏感匹配常量名，见 issue#3）
        for (const p of parseShaderParams(src, i)) if (!params.some((q) => q.key.toLowerCase() === p.key.toLowerCase())) params.push(p);
      }
    }
    out.push({ pass: i, shader: typeof shader === "string" ? shader : null, params });
  }
  return out;
}

/** 外来效果的参数表（跨 pass 拉平）：effect.json → 每个 pass 的材质 → shader 的 uniform 注释 */
export async function inspectEffectParams(file: string, read: ReadText): Promise<EffectParam[]> {
  const out: EffectParam[] = [];
  for (const ps of await inspectEffectPasses(file, read)) {
    for (const p of ps.params) if (!out.some((q) => q.key.toLowerCase() === p.key.toLowerCase() && (q.pass ?? 0) === ps.pass)) out.push(p);
  }
  return out;
}

// ---------- 作品自带（内联）效果：按 effect / pass 发现参数 + 写回 ----------

/** 一个 effect.json pass 解析出的参数（没有可调参数时 params 为空，仍然保留条目） */
export type InlinePassParams = {
  /** 在 effect.json `passes[]` 里的下标，写回时的 pass 下标就是它 */
  pass: number;
  /** 材质里声明的 shader（诊断用） */
  shader: string | null;
  params: EffectParam[];
};

/** 内联效果的一个 pass 在某个对象上呈现出来的样子（面板按它折叠） */
export type InlinePassView = {
  /** 在对象的 `effects[]` 里的下标 */
  effect: number;
  /** 在 `effects[].passes[]` 里的下标（= effect.json 的 pass 下标） */
  pass: number;
  file: string;
  effectName: string;
  shader: string | null;
  params: readonly EffectParam[];
  /** 按参数名取到的当前值（大小写不敏感），未知常量不在此表 */
  values: Record<string, EffectValue>;
  /** `constantshadervalues` 的全部键（含本库认不出的），用于只读展示未知键 */
  keys: string[];
  /** 该 pass 声明的贴图槽（本编辑器不改，原样保留） */
  textures: readonly string[];
};

type InlinePassEntry = {
  constantshadervalues?: Record<string, unknown>;
  textures?: unknown;
};

const passesOf = (e: EffectEntry | undefined): InlinePassEntry[] | null => (Array.isArray(e?.passes) ? (e!.passes as InlinePassEntry[]) : null);

const effectFileOfEntry = (e: EffectEntry) => (typeof e.file === "string" ? e.file : "");

/** 按大小写不敏感取常量键在 pass 上的原名（引擎的物性名匹配就是大小写不敏感的） */
export function constantKeyOf(pass: InlinePassEntry | undefined, key: string): string | null {
  const csv = pass?.constantshadervalues;
  if (!csv || typeof csv !== "object") return null;
  const want = key.toLowerCase();
  for (const k of Object.keys(csv)) if (k.toLowerCase() === want) return k;
  return null;
}

/** 认出的参数名 → 当前值；认不出的常量既不报错也不丢（键保留在 constantshadervalues 里） */
export function inlineParamValues(pass: InlinePassEntry | undefined, params: readonly EffectParam[]): Record<string, EffectValue> {
  const csv = pass?.constantshadervalues;
  const values: Record<string, EffectValue> = {};
  for (const p of params) {
    const k = constantKeyOf(pass, p.key);
    values[p.key] = decodeValue(p, k && csv ? csv[k] : undefined);
  }
  return values;
}

/**
 * 作品自带效果的 pass 视图：`obj.effects[i].passes[j]` × `effect.json` 的参数表。
 * `params` 按 `effectFiles` 的键（effect.json 路径）取；缺失时该 pass 仍会列出，
 * 但 `params` 为空 —— 面板这时只读展示已有常量键，绝不新建 / 删除任何东西。
 */
export function inlinePassViews(obj: SceneObject, params: ReadonlyMap<string, readonly EffectParam[]>): InlinePassView[] {
  const out: InlinePassView[] = [];
  const list = effectsOf(obj) ?? [];
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    const file = effectFileOfEntry(e);
    if (!file) continue;
    const ps = passesOf(e) ?? [];
    for (let j = 0; j < ps.length; j++) {
      const pass = ps[j];
      const decl = (params.get(file) ?? []).filter((p) => (p.pass ?? 0) === j);
      const csv = pass?.constantshadervalues;
      out.push({
        effect: i,
        pass: j,
        file,
        effectName: typeof e.name === "string" && e.name ? e.name : (file.split("/").slice(-2, -1)[0] ?? file),
        shader: null,
        params: decl,
        values: inlineParamValues(pass, decl),
        keys: csv && typeof csv === "object" ? Object.keys(csv) : [],
        textures: Array.isArray(pass?.textures) ? (pass!.textures as string[]) : [],
      });
    }
  }
  return out;
}

/**
 * 改一个作品自带效果的参数值，返回是否改成。
 *
 * 三条硬规矩（M1 判据守着）：
 *   1. **只改值**：键按大小写不敏感命中已有键后用它的原名写回，不新增、不改名；
 *   2. `{user|script|animation, value}` 包装只改 `.value`，绑定与脚本原样保留；
 *   3. 其余键（含本库认不出的）与同 pass 的 `textures` 逐字节不动。
 */
export function setInlineParam(obj: SceneObject, effect: number, pass: number, key: string, value: EffectValue, params?: readonly EffectParam[]): boolean {
  const e = effectsOf(obj)?.[effect];
  const ps = passesOf(e);
  if (!e || !ps || pass < 0 || pass >= ps.length) return false;
  const p = params?.find((x) => x.key.toLowerCase() === key.toLowerCase());
  if (!p) return false;
  const target = ps[pass];
  if (!target || typeof target !== "object") return false;
  const csv = (target.constantshadervalues ??= {});
  const real = constantKeyOf(target, p.key) ?? p.key;
  const enc = encodeValue(p, value);
  const cur = csv[real];
  if (cur && typeof cur === "object" && !Array.isArray(cur) && "value" in cur) (cur as { value: unknown }).value = enc;
  else csv[real] = enc;
  return true;
}

/** 文档当前引用的效果文件（资源表据此决定写进来的效果三件套是否进保存清单） */
export function referencedEffects(doc: EditorDoc | null): Set<string> {
  const out = new Set<string>();
  const objs = doc?.scene?.objects;
  if (!Array.isArray(objs)) return out;
  for (const o of objs as SceneObject[]) for (const e of effectsOf(o) ?? []) if (typeof e?.file === "string") out.add(e.file);
  return out;
}
