// include 名：wwgl/fx-crt/crt（插件 id + 文件名）；写进工程时内联展开，WE 端不需要这个文件。
vec2 crtWarp(vec2 uv, float k) {
	vec2 c = uv * 2.0 - 1.0;
	c *= 1.0 + k * dot(c.yx, c.yx);
	return c * 0.5 + 0.5;
}

float crtScanline(vec2 uv, float lines) {
	return 0.5 + 0.5 * cos(uv.y * lines * 3.14159265);
}

float crtVignette(vec2 uv, float amount) {
	vec2 d = uv - 0.5;
	return clamp(1.0 - amount * dot(d, d) * 3.0, 0.0, 1.0);
}
