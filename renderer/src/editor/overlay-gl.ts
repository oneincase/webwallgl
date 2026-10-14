// M12 / W5 真 GL overlay pass（EDITOR-COMPLETION-PLAN §2 B2）。
//
// 引擎此前没有任何 gl.LINES 用法，选中框 / 手柄全靠页面 `#ed-overlay` 那层
// 2D canvas 叠在视口上。这个模块在**同一个 GL 上下文**里补一条 overlay 通道：
// 主 render 跑完之后、同一个 rAF 里再画一层线段，几何由
// `renderer/src/editor/overlay.ts` 统一给出（2D 回退路径吃同一份线段）。
//
// 设计约束（合并时别改坏）：
//   1) **只加不改**：pass 是可选路径，创建失败 / 着色器编不过时 ok=false、
//      draw() 返回 0，页面 2D canvas 照旧 —— 用户可见行为不变。
//   2) 自己管好 GL 状态：进来先存 DEPTH_TEST / BLEND / SCISSOR_TEST / CULL_FACE、
//      当前 program / ARRAY_BUFFER 绑定、FRAMEBUFFER_BINDING 与 VIEWPORT，画完
//      **在 finally 里原样放回**（含本次才 enable 的顶点属性——不留 enabled attrib）。
//      overlay 跑在 render 之后，绝不能把主渲染的下一帧状态带歪。
//   3) 不改 gl.viewport 的**设备像素**口径：线段坐标是 CSS 像素，shader 里用
//      uniform 换算到 clip，viewport 用 drawingBuffer 尺寸（DPR 由它承担）。
//   4) 判据离线可跑：scripts/verify-editor.mjs 的 M12 段拿一个记账用的假 gl
//      （只记录调用）就能断言「着色器只编一次 + 空数组不 draw + 线段数正确 +
//      状态被原样还原 + 失败路径建了几个就删了几个」。
//   5) **创建期失败必须就地回收**：WebGL 对象不会被 GC 回收，只能显式 delete；
//      而失败返回的 pass.dispose 是对外语义上的 no-op，调用方救不回来，所以
//      清理只能发生在创建过程自己身上（见下方 dropCreated / failCreated）。

import VERT_RAW from "./shaders/overlay.vert.glsl";
import FRAG_RAW from "./shaders/overlay.frag.glsl";

// GLSL 独立成 .glsl 文件（issue #14）：高亮 / 维护友好，打包时剥注释/空行。
// 注意末尾换行：旧内联模板串没有末尾换行，导入后归一（编译器不敏感，但断言对拍要一致）。
const VERT = VERT_RAW.replace(/\n+$/, "");
const FRAG = FRAG_RAW.replace(/\n+$/, "");

export type OverlayViewport = { width: number; height: number };

export type OverlayPass = {
  /** 建 pass 成功没有；false 时 draw() 恒返回 0（调用方走 2D 回退） */
  readonly ok: boolean;
  /** ok=false 的原因（诊断文案用） */
  readonly reason: string;
  /** 累计 draw 次数（判据：A/B 的两帧各 +1） */
  readonly frames: number;
  /** 画一帧线段。返回这次实际提交的线段数（0 = 没画） */
  draw(segments: Float32Array, viewport: OverlayViewport, color?: readonly [number, number, number, number]): number;
  dispose(): void;
};

type GL = WebGL2RenderingContext;

const DEFAULT_COLOR: readonly [number, number, number, number] = [1, 0.85, 0.1, 1];

export function createOverlayPass(gl: GL, opts: { depth?: number } = {}): OverlayPass {
  const depth = typeof opts.depth === "number" ? opts.depth : 0;
  const fail = (reason: string): OverlayPass => ({
    ok: false,
    reason,
    frames: 0,
    draw: () => 0,
    dispose: () => undefined,
  });
  if (!gl || typeof gl.createShader !== "function") return fail("no-gl");

  const compile = (type: number, src: string) => {
    const sh = gl.createShader(type);
    if (!sh) return null;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = String(gl.getShaderInfoLog(sh) || "");
      gl.deleteShader(sh);
      throw new Error(log.slice(0, 200) || "shader compile failed");
    }
    return sh;
  };

  let vs: WebGLShader | null = null;
  let fs: WebGLShader | null = null;
  let prog: WebGLProgram | null = null;
  let buf: WebGLBuffer | null = null;
  let locPos: number | null = null;
  let locViewport: WebGLUniformLocation | null = null;
  let locColor: WebGLUniformLocation | null = null;
  let locDepth: WebGLUniformLocation | null = null;

  // 创建期失败的就地回收（§5）：按 prog → vs → fs → buf 顺序 delete 并置 null。
  // 编译自己失败的那个 shader 由 compile() 删，这里只管「已经建好、还没交出去」的。
  const dropCreated = () => {
    if (prog) gl.deleteProgram(prog);
    if (vs) gl.deleteShader(vs);
    if (fs) gl.deleteShader(fs);
    if (buf) gl.deleteBuffer(buf);
    prog = null;
    vs = null;
    fs = null;
    buf = null;
  };
  const failCreated = (reason: string): OverlayPass => {
    dropCreated();
    return fail(reason);
  };

  try {
    vs = compile(gl.VERTEX_SHADER, VERT);
    fs = compile(gl.FRAGMENT_SHADER, FRAG);
    prog = gl.createProgram();
    if (!vs || !fs || !prog) return failCreated("program-create-failed");
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = String(gl.getProgramInfoLog(prog) || "");
      return failCreated(`link-failed: ${log.slice(0, 160)}`);
    }
    locPos = gl.getAttribLocation(prog, "aPos");
    locViewport = gl.getUniformLocation(prog, "uViewport");
    locColor = gl.getUniformLocation(prog, "uColor");
    locDepth = gl.getUniformLocation(prog, "uDepth");
    buf = gl.createBuffer();
    if (locPos < 0 || !buf) return failCreated("attrib-or-buffer-missing");
  } catch (e) {
    return failCreated(String((e as Error)?.message || e).slice(0, 200));
  }

  let disposed = false;
  let frames = 0;
  const pass: OverlayPass = {
    ok: true,
    reason: "",
    get frames() {
      return frames;
    },
    draw(segments, viewport, color) {
      if (disposed || !prog) return 0;
      const verts = segments && segments.length >= 4 ? segments.length >> 1 : 0;
      if (verts < 2) return 0;
      const w = Number(viewport?.width) || 0;
      const h = Number(viewport?.height) || 0;
      if (!(w > 0) || !(h > 0)) return 0;

      // 存旧状态（render 刚跑完，这些值都是主渲染留下的）
      const prevProg = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null;
      const prevBuf = gl.getParameter(gl.ARRAY_BUFFER_BINDING) as WebGLBuffer | null;
      const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
      const prevViewport = gl.getParameter(gl.VIEWPORT) as Int32Array | null;
      const prevDepthTest = gl.isEnabled(gl.DEPTH_TEST);
      const prevBlend = gl.isEnabled(gl.BLEND);
      const prevScissor = gl.isEnabled(gl.SCISSOR_TEST);
      const prevCull = gl.isEnabled(gl.CULL_FACE);

      // 只有本次真 enable 过的属性才 disable（早退路径一个状态调用都不发）
      let attribEnabled = false;
      try {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        const dw = Number(gl.drawingBufferWidth) || w;
        const dh = Number(gl.drawingBufferHeight) || h;
        gl.viewport(0, 0, dw, dh);
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.BLEND);
        gl.disable(gl.SCISSOR_TEST);
        gl.disable(gl.CULL_FACE);

        gl.useProgram(prog);
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, segments, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(locPos as number);
        attribEnabled = true;
        gl.vertexAttribPointer(locPos as number, 2, gl.FLOAT, false, 0, 0);
        gl.uniform2f(locViewport, w, h);
        gl.uniform1f(locDepth, depth);
        const c = color && color.length === 4 ? color : DEFAULT_COLOR;
        gl.uniform4f(locColor, c[0], c[1], c[2], c[3]);
        gl.drawArrays(gl.LINES, 0, verts);
        frames++;
      } finally {
        // 原样放回（finally：drawArrays 抛错时也必须还原，异常照旧向上抛）
        if (attribEnabled) gl.disableVertexAttribArray(locPos as number);
        if (prevCull) gl.enable(gl.CULL_FACE);
        if (prevScissor) gl.enable(gl.SCISSOR_TEST);
        if (prevBlend) gl.enable(gl.BLEND);
        if (prevDepthTest) gl.enable(gl.DEPTH_TEST);
        gl.bindBuffer(gl.ARRAY_BUFFER, prevBuf);
        gl.useProgram(prevProg);
        gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);
        if (prevViewport && prevViewport.length >= 4) {
          gl.viewport(prevViewport[0], prevViewport[1], prevViewport[2], prevViewport[3]);
        }
      }
      return verts >> 1;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (buf) gl.deleteBuffer(buf);
      if (prog) gl.deleteProgram(prog);
      if (vs) gl.deleteShader(vs);
      if (fs) gl.deleteShader(fs);
      buf = null;
      prog = null;
      vs = null;
      fs = null;
    },
  };
  return pass;
}
