	vec4 c = texSample2D(g_Texture0, v_TexCoord);
	float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
	float k = smoothstep(g_FxThreshold, g_FxThreshold + 0.2, l) * c.a;
	gl_FragColor = vec4(c.rgb * k, k);
