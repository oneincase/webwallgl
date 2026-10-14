	vec2 uv = v_TexCoord;
	vec2 texel = 1.0 / max(g_Texture0Resolution.xy, vec2(1.0, 1.0));
	float dt = min(g_Frametime, 1.0 / 30.0);
	vec2 outer = texel * 100.0 * g_FxRipplespeed * dt;
	vec2 inner = outer * 1.61;

	vec4 up = rippleSide(uv, vec2(0.0, -1.0), inner, outer);
	vec4 down = rippleSide(uv, vec2(0.0, 1.0), inner, outer);
	vec4 left = rippleSide(uv, vec2(-1.0, 0.0), inner, outer);
	vec4 right = rippleSide(uv, vec2(1.0, 0.0), inner, outer);

	// 每个方向通道：正对的上游一侧直传 + 两个垂直侧向外扩散
	vec4 f = vec4(
		left.x + up.x + down.x,
		up.y + left.y + right.y,
		right.z + up.z + down.z,
		down.w + left.w + right.w
	) / 3.0;

	// 碰到层边界的能量折返：朝外的通道交给反方向通道
	float on = step(0.5, g_FxRipplereflect);
	f.x = mix(f.x, f.z, on * step(uv.x, texel.x));
	f.z = mix(f.z, f.x, on * step(1.0 - texel.x, uv.x));
	f.y = mix(f.y, f.w, on * step(uv.y, texel.y));
	f.w = mix(f.w, f.y, on * step(1.0 - texel.y, uv.y));

	// 衰减至少一个 8 位量化级，否则残余能量永远消不掉
	float drop = max(1.001 / 255.0, 1.5 / 255.0 * (g_Frametime / 0.02) * g_FxRippledecay);
	gl_FragColor = clamp(f - drop, 0.0, 1.0);
