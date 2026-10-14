	vec2 uv = v_TexCoord;
	vec4 field = texSample2D(g_Texture0, uv);

	vec2 cur = rippleLayerUV(g_PointerPosition);
	vec2 last = rippleLayerUV(g_PointerPositionLast);

	// 本帧光标扫过的线段（上一帧 → 本帧）上离当前像素最近的点：快速划过也是一条连续的笔触
	vec2 seg = cur - last;
	float segLen2 = dot(seg, seg);
	float t = segLen2 > 1e-6 ? clamp(dot(uv - last, seg) / segLen2, 0.0, 1.0) : 1.0;

	// 半径按层宽归一，纵向乘宽高比 ⇒ 笔刷在像素上是正圆
	float radius = max(g_FxRipplescale, 0.0001) / 60.0;
	vec2 aspect = vec2(1.0, g_Texture0Resolution.y / max(g_Texture0Resolution.x, 1.0));
	vec2 d = (uv - (last + seg * t)) * aspect / radius;
	float brush = clamp(1.0 - length(d), 0.0, 1.0);

	// 冲量 ∝ 光标速度；按住左键持续注入。dt 以 50fps 为 1，限帧不会让波变弱
	float dt = min(g_Frametime, 1.0 / 30.0) / 0.02;
	float move = length(g_PointerPosition - g_PointerPositionLast) * 100.0;
	float energy = brush * dt * (move + g_PointerState.z * 5.0 * g_FxRippleclick);

	// 四个通道分别存往 +x / +y / -x / -y 方向传播的能量（8 位缓冲存不了负数）
	vec2 dir = clamp(d, -1.0, 1.0);
	gl_FragColor = field + vec4(max(dir, 0.0), max(-dir, 0.0)) * energy;
