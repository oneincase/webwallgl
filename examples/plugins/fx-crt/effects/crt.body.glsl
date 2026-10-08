	vec2 uv = crtWarp(v_TexCoord, g_FxCurvature);
	if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
		gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
		return;
	}
	vec4 c = texSample2D(g_Texture0, uv);
	c.rgb *= mix(1.0, crtScanline(uv, g_FxLines), g_FxScanlines);
	c.rgb *= crtVignette(uv, g_FxVignette);
	gl_FragColor = c;
