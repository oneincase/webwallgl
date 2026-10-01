// GPU 资源登记表 —— 「谁创建、谁释放」的单一出口
//
// 为什么需要（docs/ENGINE-REVIEW-2026-10.md §3.1）：renderer.js 里长期零
// `deleteProgram`/`deleteShader`，`dispose()` 只调 `WEBGL_lose_context.loseContext()` ——
// 也就是说「释放」完全押在扩展可用这一条路上；扩展缺失时固定 program、内置纹理、
// VAO/buffer 全部只能等 GC。同时 `msaaTarget = null`（HDR 分支）这类「丢引用不删对象」
// 的写法在**活着的上下文里**是真泄漏（实测存在的分支）。
//
// 设计取舍：只做「登记 + 全量释放 + 计数」，不做自动包装 gl 对象。
// 不包装的原因：把 gl 换成 Proxy 会给每帧数千次 GL 调用加一层属性查找，
// 而本仓库正在做的恰好是减法；登记点只有二十来处且都是静态的，逐个登记更便宜也更好读。
// 代价是「新增创建点必须记得登记」—— 这条由 verify-shaders 的源码断言守（见该文件 [N] 节）。
//
// 释放规则：正常路径（换尺寸 / 池回收 / 缓存清理）继续用各自的 delete，
// **同时**调 release() 销账；destroyAll() 只兜「还挂在表上的」——即真正的泄漏。
export function createGlRegistry(gl) {
  const KINDS = ['program', 'shader', 'texture', 'framebuffer', 'renderbuffer', 'buffer', 'vertexArray']
  const live = new Map() // obj → kind
  const counts = {}
  for (const k of KINDS) counts[k] = 0

  const track = (kind, obj) => {
    if (obj) {
      live.set(obj, kind)
      counts[kind]++
    }
    return obj
  }
  const drop = (obj) => {
    if (!obj) return
    const kind = live.get(obj)
    if (kind !== undefined) {
      live.delete(obj)
      counts[kind]--
    }
  }

  return {
    // 创建点登记（都返回原对象，便于写成 `const tex = glReg.texture(gl.createTexture())`）
    program: (o) => track('program', o),
    shader: (o) => track('shader', o),
    texture: (o) => track('texture', o),
    framebuffer: (o) => track('framebuffer', o),
    renderbuffer: (o) => track('renderbuffer', o),
    buffer: (o) => track('buffer', o),
    vertexArray: (o) => track('vertexArray', o),
    /** 显式删除后销账（与各处的 gl.deleteX 成对调用） */
    release: drop,
    /** 当前在册数量（诊断出口；宿主可用它判断「卸载后是否归零」） */
    stats: () => ({ ...counts, total: live.size }),
    /**
     * 全量释放 —— 卸载路径的兜底，必须在 loseContext() **之前**调：
     * 上下文一旦丢失，后续 delete 全是 no-op，等于没释放。
     */
    destroyAll: () => {
      for (const [obj, kind] of live) {
        try {
          if (kind === 'program') gl.deleteProgram(obj)
          else if (kind === 'shader') gl.deleteShader(obj)
          else if (kind === 'texture') gl.deleteTexture(obj)
          else if (kind === 'framebuffer') gl.deleteFramebuffer(obj)
          else if (kind === 'renderbuffer') gl.deleteRenderbuffer(obj)
          else if (kind === 'buffer') gl.deleteBuffer(obj)
          else if (kind === 'vertexArray') gl.deleteVertexArray(obj)
        } catch {
          /* 单个删除失败不打断其余（上下文已异常时的兜底语义） */
        }
      }
      live.clear()
      for (const k of KINDS) counts[k] = 0
    },
  }
}
