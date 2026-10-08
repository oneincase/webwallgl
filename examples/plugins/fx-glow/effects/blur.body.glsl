	vec2 px = g_FxRadius / max(g_Texture0Resolution.xy, vec2(1.0, 1.0));
	vec4 sum = vec4(0.0, 0.0, 0.0, 0.0);
	float wsum = 0.0;
	for (int i = -4; i <= 4; i++) {
		for (int j = -4; j <= 4; j++) {
			float w = exp(-float(i * i + j * j) / 18.0);
			sum += texSample2D(g_Texture0, v_TexCoord + vec2(float(i), float(j)) * px) * w;
			wsum += w;
		}
	}
	gl_FragColor = sum / wsum;
