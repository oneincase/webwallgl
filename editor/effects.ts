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

import type { EditorDoc, SceneObject } from "./doc";

export type EffectParam = {
  key: string;
  type: "float" | "color";
  default: number | readonly [number, number, number];
  min?: number;
  max?: number;
  step?: number;
};

export type EffectDef = {
  id: string;
  params: readonly EffectParam[];
  frag: string;
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
  typeof p.default === "number" ? fmt(p.default) : `"${p.default.map(fmt).join(" ")}"`;

/** 由参数表生成 uniform 声明（注释带 material 名 / default / range），shader 与面板同源 */
function uniforms(params: readonly EffectParam[]): string {
  return params
    .map((p) => {
      const range = p.min !== undefined && p.max !== undefined ? `,"range":[${fmt(p.min)},${fmt(p.max)}]` : "";
      const type = p.type === "color" ? `,"type":"color"` : "";
      return `uniform ${p.type === "color" ? "vec3" : "float"} ${uniformName(p.key)}; // {"material":"${p.key}"${type},"default":${defaultLiteral(p)}${range}}`;
    })
    .join("\n");
}

export const uniformName = (key: string) => `g_Fx${key[0].toUpperCase()}${key.slice(1)}`;

function def(id: string, params: EffectParam[], body: string, extra = ""): EffectDef {
  return { id, params, frag: `// WebWallGL 编辑器内置效果：${id}\n${HEAD}${extra}${uniforms(params)}\n\nvoid main() {\n${body}\n}\n` };
}

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
];

export const effectById = (id: string) => EFFECTS.find((e) => e.id === id) ?? null;

export const effectFileOf = (id: string) => `effects/${EFFECT_PREFIX}${id}/effect.json`;

/** scene.json 里的效果文件路径 → 内置效果 id（不是本库的效果返回 null） */
export function effectIdOf(file: unknown): string | null {
  if (typeof file !== "string") return null;
  const m = /^effects\/wwgl_([a-z0-9]+)\/effect\.json$/.exec(file);
  return m && effectById(m[1]) ? m[1] : null;
}

/** 一个效果写进工程的四个文件（effect.json / 材质 / frag / vert） */
export function effectFiles(d: EffectDef): Array<{ name: string; data: Uint8Array }> {
  const enc = new TextEncoder();
  const shader = `effects/${EFFECT_PREFIX}${d.id}`;
  const material = `materials/effects/${EFFECT_PREFIX}${d.id}.json`;
  const effect = {
    version: 1,
    name: `${EFFECT_PREFIX}${d.id}`,
    group: "webwallgl",
    passes: [{ material }],
    dependencies: [material, `shaders/${shader}.frag`, `shaders/${shader}.vert`],
  };
  const mat = {
    passes: [{ shader, blending: "normal", cullmode: "nocull", depthtest: "disabled", depthwrite: "disabled" }],
  };
  return [
    { name: effectFileOf(d.id), data: enc.encode(JSON.stringify(effect, null, 2)) },
    { name: material, data: enc.encode(JSON.stringify(mat, null, 2)) },
    { name: `shaders/${shader}.frag`, data: enc.encode(d.frag) },
    { name: `shaders/${shader}.vert`, data: enc.encode(VERT) },
  ];
}

export type EffectValue = number | [number, number, number];

/** scene.json 的常量写法：标量 = 数字，颜色 = "r g b" 字符串（与 WE 同） */
export function encodeValue(p: EffectParam, v: EffectValue): number | string {
  if (p.type === "color") {
    const c = Array.isArray(v) ? v : [v, v, v];
    return c.map((x) => fmt(Math.max(0, Math.min(1, x)))).join(" ");
  }
  const n = typeof v === "number" ? v : v[0];
  const lo = p.min ?? -Infinity;
  const hi = p.max ?? Infinity;
  return Math.round(Math.max(lo, Math.min(hi, n)) * 1e4) / 1e4;
}

export function decodeValue(p: EffectParam, raw: unknown): EffectValue {
  const v = raw && typeof raw === "object" && !Array.isArray(raw) && "value" in raw ? (raw as { value: unknown }).value : raw;
  if (p.type === "color") {
    const parts = typeof v === "string" ? v.trim().split(/\s+/).map(Number) : [];
    return parts.length >= 3 && parts.every(Number.isFinite)
      ? [parts[0], parts[1], parts[2]]
      : ([...(p.default as readonly number[])] as [number, number, number]);
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
  const constants: Record<string, number | string> = {};
  for (const p of d.params) constants[p.key] = encodeValue(p, p.default as EffectValue);
  list.push({ file: effectFileOf(id), name: id, visible: true, passes: [{ constantshadervalues: constants }] });
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
export function setEffectParam(obj: SceneObject, index: number, key: string, value: EffectValue): boolean {
  const e = effectsOf(obj)?.[index];
  const id = effectIdOf(e?.file);
  const p = id ? effectById(id)!.params.find((x) => x.key === key) : undefined;
  if (!e || !p) return false;
  if (!Array.isArray(e.passes) || !e.passes.length) e.passes = [{}];
  const pass = e.passes[0];
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
  /** 本库内置效果才有参数表（可编辑）；其余效果只读展示 */
  def: EffectDef | null;
  values: Record<string, EffectValue>;
};

export function effectViews(obj: SceneObject): EffectView[] {
  return (effectsOf(obj) ?? []).map((e, index) => {
    const id = effectIdOf(e.file);
    const d = id ? effectById(id) : null;
    const consts = e.passes?.[0]?.constantshadervalues ?? {};
    const lower = new Map(Object.entries(consts).map(([k, v]) => [k.toLowerCase(), v]));
    const values: Record<string, EffectValue> = {};
    for (const p of d?.params ?? []) values[p.key] = decodeValue(p, lower.get(p.key.toLowerCase()));
    return {
      index,
      file: e.file,
      name: typeof e.name === "string" && e.name ? e.name : (e.file.split("/").slice(-2, -1)[0] ?? e.file),
      visible: isEffectVisible(e),
      def: d,
      values,
    };
  });
}

/** 文档当前引用的效果文件（资源表据此决定写进来的效果三件套是否进保存清单） */
export function referencedEffects(doc: EditorDoc | null): Set<string> {
  const out = new Set<string>();
  const objs = doc?.scene?.objects;
  if (!Array.isArray(objs)) return out;
  for (const o of objs as SceneObject[]) for (const e of effectsOf(o) ?? []) if (typeof e?.file === "string") out.add(e.file);
  return out;
}
