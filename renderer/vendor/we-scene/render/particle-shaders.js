// 粒子渲染 GPU 装配（从 particles.js 拆出）：实例精灵 shader 源 + 程序/VAO 构建
//
// [we-scene patch] _buildProgram 的方法体只吃 gl 参数、不读实例状态，
// 抽成自由函数后 Simulation 与 GPU 装配解耦（ParticleSystem.render 里的
// this._prog 消费方不变）。
export function buildParticleProgram(gl) {
    const vs = `#version 300 es
// 单位 quad（TRIANGLE_STRIP 4 顶点），按实例的 size/rot 展开为朝屏幕的精灵
layout(location=0) in vec2 a_corner;      // -0.5..0.5
layout(location=1) in vec3 a_pos;         // 实例中心（投影空间世界坐标）
layout(location=2) in vec2 a_sizeRot;     // x=size(像素) y=rot(弧度)
layout(location=3) in vec4 a_color;       // rgb + alpha
layout(location=4) in vec3 a_stretchFrame; // xy=非等比拉伸 z=帧序号
layout(location=5) in vec2 a_vrange;      // 段两端沿贴图 v 的取值（rope 连线用；普通精灵 0..1）
uniform mat4 u_mvp;
// 序列帧 uv 变换表（TEXS 帧矩形归一化后的 offset/scale），最多 128 帧
// （matrix spritesheet 72 有 71 帧，旧上限 64 会丢末尾字符）
uniform int u_frameCount;
uniform vec4 u_frames[128];               // xy=offset zw=scale
out vec2 v_uv;
out vec4 v_color;
void main(){
  float size = a_sizeRot.x;
  float rot = a_sizeRot.y;
  float c = cos(rot), s = sin(rot);
  // 先按 size 与非等比拉伸展开，再旋转（顺序反了会把拉伸方向也转走）
  vec2 corner = a_corner * size * a_stretchFrame.xy;
  vec2 rotated = vec2(corner.x * c - corner.y * s, corner.x * s + corner.y * c);
  gl_Position = u_mvp * vec4(a_pos.xy + rotated, a_pos.z, 1.0);
  // quad 角 → 贴图 uv。世界 y 已翻转到投影空间（y 向下），故 quad 的 +y 角
  // 对应屏幕上方，应采样纹理顶行 v=1（与 renderer.js 的 layerQuadVerts 同约定）。
  // a_vrange 让 rope 段两端各取自己的 v（沿绳连续渐变）；普通精灵是 (0,1) 恒等。
  vec2 uv = vec2(a_corner.x + 0.5, mix(a_vrange.x, a_vrange.y, a_corner.y + 0.5));
  if (u_frameCount > 0) {
    // 帧矩形以左上为原点（TEXS 是 top-down 像素坐标），故先把 v 翻成 top-down
    int fi = int(a_stretchFrame.z);
    fi = clamp(fi, 0, u_frameCount - 1);
    vec4 fr = u_frames[fi];
    vec2 cell = vec2(uv.x, 1.0 - uv.y) * fr.zw + fr.xy;
    uv = vec2(cell.x, 1.0 - cell.y);
  }
  v_uv = uv;
  v_color = a_color;
}`
    const fs = `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
uniform sampler2D u_normal;
uniform sampler2D u_scene;
uniform int u_refract;
uniform int u_sampleScene;
uniform vec2 u_resolution;
uniform float u_refractScale;
in vec2 v_uv;
in vec4 v_color;
out vec4 fragColor;
void main(){
  vec4 t = texture(u_tex, v_uv);
  vec4 col = vec4(t.rgb * v_color.rgb, t.a * v_color.a);
  if (u_refract == 1) {
    // genericparticle REFRACT：槽 0 经常是空白白图（Rain2 的
    // "particles 256x1280 blank"、firework 的 util/white），水珠形状在法线里。
    // 按普通精灵画会把整块 quad 涂成白方块。这里用法线 AG（DXT5nm 打包）
    // 扭曲已绘制的画面，空白 albedo 改用法线偏离当 alpha。
    vec4 ntex = texture(u_normal, v_uv);
    // 工坊 DXT5nm：R=255 B=0，XY 在 AG（2464842912 Rain2）。
    // 官方 DecompressNormal（common_fragment.h）与程序化法线：XY 在 RG。
    vec2 nxy = (ntex.r > 0.85 && ntex.b < 0.15) ? (ntex.ag * 2.0 - 1.0) : (ntex.rg * 2.0 - 1.0);
    // 平坦处 AG≈128，量化噪声会让 length*2.2 仍有 ~0.04，整块 quad 剩淡方块。
    float drop = smoothstep(0.06, 0.28, length(nxy));
    float blank = step(0.95, min(min(t.r, t.g), min(t.b, t.a)));
    float alpha = mix(t.a, drop, blank) * v_color.a;
    vec3 rgb = t.rgb * v_color.rgb;
    if (u_sampleScene == 1) {
      vec2 screenUV = gl_FragCoord.xy / max(u_resolution, vec2(1.0));
      vec3 scene = texture(u_scene, clamp(screenUV + nxy * u_refractScale, 0.0, 1.0)).rgb;
      rgb = scene * v_color.rgb;
    }
    col = vec4(rgb, alpha);
    if (col.a < 0.004) discard;
  }
  fragColor = col;
}`
    const compile = (type, src) => {
      const s = gl.createShader(type)
      gl.shaderSource(s, src)
      gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('粒子 shader: ' + gl.getShaderInfoLog(s))
      return s
    }
    const prog = gl.createProgram()
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, vs))
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fs))
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('粒子 shader 链接失败: ' + gl.getProgramInfoLog(prog))

    // 静态 quad 角点
    const quadBuf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]), gl.STATIC_DRAW)

    const vbuf = gl.createBuffer()
    const vao = gl.createVertexArray()
    gl.bindVertexArray(vao)
    // location 0：quad 角（每顶点）
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0)
    gl.vertexAttribDivisor(0, 0)
    // location 1..4：实例数据（stride 56 = 14 float，含 rope 的 a_vrange）
    gl.bindBuffer(gl.ARRAY_BUFFER, vbuf)
    const S = 56
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, S, 0)
    gl.vertexAttribDivisor(1, 1)
    gl.enableVertexAttribArray(2)
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, S, 12)
    gl.vertexAttribDivisor(2, 1)
    gl.enableVertexAttribArray(3)
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, S, 20)
    gl.vertexAttribDivisor(3, 1)
    gl.enableVertexAttribArray(4)
    gl.vertexAttribPointer(4, 3, gl.FLOAT, false, S, 36)
    gl.vertexAttribDivisor(4, 1)
    gl.enableVertexAttribArray(5)
    gl.vertexAttribPointer(5, 2, gl.FLOAT, false, S, 48)
    gl.vertexAttribDivisor(5, 1)
    gl.bindVertexArray(null)

    return {
      prog: {
        prog,
        uniTex: gl.getUniformLocation(prog, 'u_tex'),
        uniNormal: gl.getUniformLocation(prog, 'u_normal'),
        uniScene: gl.getUniformLocation(prog, 'u_scene'),
        uniRefract: gl.getUniformLocation(prog, 'u_refract'),
        uniSampleScene: gl.getUniformLocation(prog, 'u_sampleScene'),
        uniResolution: gl.getUniformLocation(prog, 'u_resolution'),
        uniRefractScale: gl.getUniformLocation(prog, 'u_refractScale'),
        uniMvp: gl.getUniformLocation(prog, 'u_mvp'),
        uniFrameCount: gl.getUniformLocation(prog, 'u_frameCount'),
        uniFrames: gl.getUniformLocation(prog, 'u_frames'),
      },
      quadBuf,
      vbuf,
      vao,
    }
  }
