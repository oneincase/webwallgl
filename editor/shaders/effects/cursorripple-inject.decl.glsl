uniform float g_Frametime;
uniform vec2 g_PointerPosition;
uniform vec2 g_PointerPositionLast;
uniform vec4 g_PointerState;
uniform mat4 g_EffectTextureProjectionMatrixInverse;
uniform vec4 g_Texture0Resolution;

// g_PointerPosition 是屏幕归一化、Y 朝下；反投影到本层 UV（同样 Y 朝下）
vec2 rippleLayerUV(vec2 p) {
	p.y = 1.0 - p.y;
	vec3 q = mul(vec4(p * 2.0 - 1.0, 0.0, 1.0), g_EffectTextureProjectionMatrixInverse).xyw;
	vec2 uv = q.xy * 0.5 / q.z + 0.5;
	uv.y = 1.0 - uv.y;
	return uv;
}
