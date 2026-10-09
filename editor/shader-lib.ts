// shader 片段库（PLUGIN-ARCHITECTURE §3.2）：插件登记可复用的 GLSL 片段（噪声 / 色彩空间…），
// 效果源码里写 `#include "wwgl/<名>"`，生成工程文件时**内联展开** —— 产物里不留编辑器私有
// include，WE 不需要任何额外文件。WE 自己的 include（common.h 等）原样保留，交给引擎。
// 片段之间可以互相 include（按依赖先后展开，同一片段只展开一次，环依赖报错）。

import { createRegistry } from "./core";

export type ShaderSnippet = {
  /** include 名，形如 wwgl/noise（不带引号） */
  id: string;
  code: string;
  description?: string;
};

export const SNIPPET_NAMESPACE = "wwgl/";

export const shaderSnippets = createRegistry<ShaderSnippet>("shaders", {
  validate: (s) => {
    if (!s.id.startsWith(SNIPPET_NAMESPACE)) throw new Error(`shader 片段名必须以 ${SNIPPET_NAMESPACE} 开头：${s.id}`);
  },
});

const INCLUDE_RE = /^[ \t]*#include[ \t]+"(wwgl\/[^"]+)"[ \t]*$/gm;

/** 展开源码里的编辑器片段 include；未登记的片段报错（不能把坏 include 写进 WE 工程） */
export function expandShader(src: string, lookup: (id: string) => ShaderSnippet | undefined = (id) => shaderSnippets.get(id)): string {
  if (!src.includes(`"${SNIPPET_NAMESPACE}`)) return src;
  const done = new Set<string>();
  const visit = (code: string, stack: string[]): string =>
    code.replace(INCLUDE_RE, (_line, id: string) => {
      if (stack.includes(id)) throw new Error(`shader 片段循环 include：${[...stack, id].join(" → ")}`);
      if (done.has(id)) return `// ${id}（已展开）`;
      const s = lookup(id);
      if (!s) throw new Error(`未登记的 shader 片段：${id}`);
      done.add(id);
      return `// ---- ${id} ----\n${visit(s.code, [...stack, id])}\n// ---- end ${id} ----`;
    });
  return visit(src, []);
}

/** 内置片段：插件效果常用的几样 */
export const BUILTIN_SNIPPETS: ShaderSnippet[] = [
  {
    id: "wwgl/hash",
    description: "hash12 / hash22：确定性伪随机",
    code: `float wwglHash12(vec2 p) {
	vec3 p3 = fract(vec3(p.x, p.y, p.x) * 0.1031);
	p3 += dot(p3, p3.yzx + 33.33);
	return fract((p3.x + p3.y) * p3.z);
}
vec2 wwglHash22(vec2 p) {
	vec3 p3 = fract(vec3(p.x, p.y, p.x) * vec3(0.1031, 0.1030, 0.0973));
	p3 += dot(p3, p3.yzx + 33.33);
	return fract((p3.xx + p3.yz) * p3.zy);
}`,
  },
  {
    id: "wwgl/noise",
    description: "wwglNoise(vec2)：值噪声；wwglFbm(vec2)：4 层分形",
    code: `#include "wwgl/hash"
float wwglNoise(vec2 p) {
	vec2 i = floor(p);
	vec2 f = fract(p);
	vec2 u = f * f * (3.0 - 2.0 * f);
	return mix(mix(wwglHash12(i), wwglHash12(i + vec2(1.0, 0.0)), u.x),
	           mix(wwglHash12(i + vec2(0.0, 1.0)), wwglHash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
float wwglFbm(vec2 p) {
	float v = 0.0;
	float a = 0.5;
	for (int i = 0; i < 4; i++) {
		v += a * wwglNoise(p);
		p *= 2.0;
		a *= 0.5;
	}
	return v;
}`,
  },
  {
    id: "wwgl/color",
    description: "rgb2hsv / hsv2rgb / 亮度",
    code: `vec3 wwglRgb2Hsv(vec3 c) {
	vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
	vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
	vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
	float d = q.x - min(q.w, q.y);
	float e = 1.0e-10;
	return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
vec3 wwglHsv2Rgb(vec3 c) {
	vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
	vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
	return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}
float wwglLuma(vec3 c) {
	return dot(c, vec3(0.299, 0.587, 0.114));
}`,
  },
];

shaderSnippets.setFallback(BUILTIN_SNIPPETS);
