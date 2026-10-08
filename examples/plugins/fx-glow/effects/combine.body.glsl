	vec4 base = texSample2D(g_Texture0, v_TexCoord);
	vec4 glow = texSample2D(g_Texture1, v_TexCoord);
	base.rgb += glow.rgb * g_FxTint * g_FxIntensity;
	base.a = max(base.a, clamp(glow.a * g_FxIntensity, 0.0, 1.0));
	gl_FragColor = base;
