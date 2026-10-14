uniform float g_Frametime;
uniform vec4 g_Texture0Resolution;

// 某一侧的三个上游样本（正对 + 两个斜角）取最大：波前向外扩成环而不是被平均抹平
vec4 rippleSide(vec2 uv, vec2 n, vec2 inner, vec2 outer) {
	vec2 tg = vec2(n.y, n.x);
	vec4 a = texSample2D(g_Texture0, uv + n * inner);
	vec4 b = texSample2D(g_Texture0, uv + (n + tg) * outer);
	vec4 c = texSample2D(g_Texture0, uv + (n - tg) * outer);
	return max(a, max(b, c));
}
