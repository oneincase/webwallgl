// 粒子渲染 GPU 装配（从 particles.js 拆出）：实例精灵 shader 源 + 程序/VAO 构建
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
layout(location=6) in vec4 a_frameBlend;  // xy=下一帧序号/帧间混合权重 zw=rotation.x/rotation.y
uniform mat4 u_mvp;
// 官方 g_RefractAmount（common_particles.h 的 uniform 声明：默认 0.05、range [-1,1]）
uniform float u_refractScale;
// 序列帧 uv 变换表（TEXS 帧矩形归一化后的 offset/scale），最多 128 帧
// （matrix spritesheet 72 有 71 帧，旧上限 64 会丢末尾字符）
uniform int u_frameCount;
uniform vec4 u_frames[128];               // xy=offset zw=scale
out vec4 v_refract;    // 官方 v_ScreenTangents：xy=精灵 x 轴、zw=精灵 y 轴（已乘 Refract Amount）
out vec2 v_uv;
out vec2 v_uv2;        // 下一帧的 uv（同一 quad 位置、换帧矩形）
out float v_frameMix;  // 帧间混合权重（0 = 不混合，硬切）
out vec4 v_color;
void main(){
  float size = a_sizeRot.x;
  float rz = a_sizeRot.y;
  float rx = a_frameBlend.z;
  float ry = a_frameBlend.w;
  // 官方 ComputeParticleTangents：right/up = 旋转基（Rz·Rx·Ry）的两个轴。正交投影下
  // 精灵的屏幕形状 = 这两个轴在屏幕平面的投影（x/y 侧倾 ⇒ 对应轴按 cos 压缩）。
  // z 的符号沿用既有标定（652 个纯 z 模型的朝向逐位不能变）：right=(cos rz, sin rz)、
  // up=(-sin rz, cos rz)；x/y 的交叉项按官方 Rz·Rx·Ry 的顺序展开。
  float cz = cos(rz), sz = sin(rz);
  float cx = cos(rx), sx = sin(rx);
  float cy = cos(ry), sy = sin(ry);
  // R = Rz * Rx * Ry（列向量约定，与官方 mul(mul(Rz,Rx),Ry) 同序）
  vec2 rightXY = vec2(cz * cy - sz * sx * sy, sz * cy + cz * sx * sy);
  vec2 upXY    = vec2(-sz * cx, cz * cx);
  // 先按 size 与非等比拉伸展开，再旋转（顺序反了会把拉伸方向也转走）
  vec2 corner = a_corner * size * a_stretchFrame.xy;
  vec2 rotated = vec2(corner.x * rightXY.x + corner.y * upXY.x,
                      corner.x * rightXY.y + corner.y * upXY.y);
  gl_Position = u_mvp * vec4(a_pos.xy + rotated, a_pos.z, 1.0);
  // quad 角 → 贴图 uv。世界 y 已翻转到投影空间（y 向下），故 quad 的 +y 角
  // 对应屏幕上方，应采样纹理顶行 v=1（与 renderer.js 的 layerQuadVerts 同约定）。
  // a_vrange 让 rope 段两端各取自己的 v（沿绳连续渐变）；普通精灵是 (0,1) 恒等。
  vec2 uv = vec2(a_corner.x + 0.5, mix(a_vrange.x, a_vrange.y, a_corner.y + 0.5));
  // 官方 ComputeScreenRefractionTangents：把精灵的 x/y 轴（归一化旋转基）投影到屏幕右/上
  // 方向后乘 g_RefractAmount。2D 正交场景里视图右=(1,0)、视图上=(0,1)（屏幕 y 向下），
  // 于是切线就是旋转后的两个轴本身 —— 精灵一转，折射偏移方向跟着转（旧实现恒按屏幕轴）。
  v_refract = vec4(rightXY, upXY) * u_refractScale;
  v_uv2 = uv;
  v_frameMix = 0.0;
  if (u_frameCount > 0) {
    // 帧矩形以左上为原点（TEXS 是 top-down 像素坐标），故先把 v 翻成 top-down
    vec2 uv2 = uv;
    int fi = int(a_stretchFrame.z);
    fi = clamp(fi, 0, u_frameCount - 1);
    vec4 fr = u_frames[fi];
    vec2 cell = vec2(uv.x, 1.0 - uv.y) * fr.zw + fr.xy;
    uv = vec2(cell.x, 1.0 - cell.y);
    // 官方 ComputeSpriteFrame：nextFrame = min(n-1, cur+1)、frameBlend = frac(lifetime*n)；
    // frag 用 mix(当前帧, 下一帧, blend) 做交叉淡入（硬切会跳帧）。
    int fj = clamp(int(a_frameBlend.x), 0, u_frameCount - 1);
    vec4 fr2 = u_frames[fj];
    vec2 cell2 = vec2(uv2.x, 1.0 - uv2.y) * fr2.zw + fr2.xy;
    uv2 = vec2(cell2.x, 1.0 - cell2.y);
    v_uv2 = uv2;
    v_frameMix = clamp(a_frameBlend.y, 0.0, 1.0);
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
in vec4 v_refract;
in vec2 v_uv;
in vec2 v_uv2;
in float v_frameMix;
in vec4 v_color;
out vec4 fragColor;
void main(){
  vec4 t = texture(u_tex, v_uv);
  // 帧间交叉淡入（官方 SPRITESHEETBLEND：mix(frame, nextFrame, frac(lifetime*n))）。
  // 法线槽仍只采当前帧 —— 官方 frag 也是只对 albedo 做 mix。
  if (v_frameMix > 0.0) t = mix(t, texture(u_tex, v_uv2), v_frameMix);
  vec4 col = vec4(t.rgb * v_color.rgb, t.a * v_color.a);
  if (u_refract == 1) {
    // genericparticle REFRACT：槽 0 经常是空白白图（Rain2 的
    // "particles 256x1280 blank"、firework 的 util/white），水珠形状在法线里。
    // 官方做法：albedo **照常**参与（空白白图 = alpha 1 的白 quad），画面色是
    // 「color.rgb *= scene(uv+offset)」**乘进去**的 —— 法线平坦处 offset=0，采到的就是
    // 原画面，天然「隐形」；只有法线偏离处才出现扭曲，所以空白 albedo 不会画成白块。
    vec4 ntex = texture(u_normal, v_uv);
    // 工坊 DXT5nm：R=255 B=0，XY 在 AG（2464842912 Rain2）。
    // 官方 DecompressNormal（common_fragment.h）与程序化法线：XY 在 RG。
    // 官方 DecompressNormalWithMask 的蒙版是 normal.a：先做 normal.xw = normal.wx 交换，
    // 于是蒙版取的是**原始 R 通道**（DXT5nm 的 R=255 → 蒙版 1；RG88 路径不交换、蒙版=alpha）。
    bool dxt5nm = ntex.r > 0.85 && ntex.b < 0.15;
    vec2 nxy = dxt5nm ? (ntex.ag * 2.0 - 1.0) : (ntex.rg * 2.0 - 1.0);
    float nMask = min(dxt5nm ? ntex.r : ntex.a, 1.0);
    // 官方 alpha 就是 albedo.a × 顶点 alpha（不再拿法线偏离顶替 —— 那是为了绕开
    // 「没采到画面时会把白 quad 画出来」的旧实现，现在 rgb 恒为 albedo×顶点色×画面）。
    float alpha = t.a * v_color.a;
    vec3 rgb = t.rgb * v_color.rgb;
    if (u_sampleScene == 1) {
      vec2 screenUV = gl_FragCoord.xy / max(u_resolution, vec2(1.0));
      // 官方 frag：offset = v_ScreenTangents.xy*normal.x + v_ScreenTangents.zw*normal.y，
      // 再乘 normal.a（蒙版）× v_Color.a（粒子 alpha）。y 的符号在官方里为适配 GLSL 取负；
      // 我们的切线本来就在屏幕 y 向下空间，故不翻。
      vec2 offset = vec2(
        v_refract.x * nxy.x + v_refract.z * nxy.y,
        v_refract.y * nxy.x + v_refract.w * nxy.y
      ) * (nMask * v_color.a);
      vec3 scene = texture(u_scene, clamp(screenUV + offset, 0.0, 1.0)).rgb;
      // 官方是「color.rgb *= scene」（albedo × 顶点色 × 画面），不是用画面替换 albedo
      rgb = t.rgb * v_color.rgb * scene;
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
    // location 1..6：实例数据（stride 72 = 18 float，含 rope 的 a_vrange、帧间混合、三轴旋转）
    gl.bindBuffer(gl.ARRAY_BUFFER, vbuf)
    const S = 72
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
    gl.enableVertexAttribArray(6)
    gl.vertexAttribPointer(6, 4, gl.FLOAT, false, S, 56)
    gl.vertexAttribDivisor(6, 1)
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
