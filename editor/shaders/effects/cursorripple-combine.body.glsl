	vec2 uv = v_TexCoord;
	vec4 f = texSample2D(g_Texture0, uv);
	// 平方压掉低位残余，只让成形的波前产生明显折射
	f *= f;
	vec2 dir = vec2(f.x - f.z, f.y - f.w);

	vec4 c = texSample2D(g_Texture1, uv - dir * 0.1 * g_FxRipplestrength);

	vec2 n = dir / max(1.0, length(dir));
	float a = g_FxRippleshadingdir;
	float lit = dot(vec2(sin(a), -cos(a)), n);
	vec3 shade = c.rgb * mix(g_FxRippleshadow, vec3(1.0, 1.0, 1.0) + g_FxRipplehighlight, lit * 0.5 + 0.5);
	c.rgb = mix(c.rgb, shade, clamp(abs(lit * g_FxRippleshading), 0.0, 1.0));
	gl_FragColor = c;
