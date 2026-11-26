// 渲染过程渐显（3.1 特性）的进度纯函数。**全局开关默认关**（`fadeIn === true` 才生效）。
//
// 语义（用户拍板 2026-11-27）：
//   · 起点 = 挂载开始（贴图 job 全部登记后、`await Promise.all` 之前）；
//   · 加载期起一个**预览循环**直接 renderer.render —— 未加载的贴图 `textures.get`
//     落空、粒子/puppet/脚本 provider 未注入，渲染器对这三类都是既有的安全跳过
//     （transparentTex / provider 判空），于是「贴图就绪一帧、该层显形一帧」=
//     边加载边画已就绪图层；
//   · 画布 opacity 按「已完成 job / 总 job」线性推进（本文件的纯函数）；
//   · 终点 = 资源全部就绪（首帧时刻）：进度到 1，预览循环停摆，真循环 kickLoop
//     的首帧（onFirstFrame / mount() 契约）时序与关渐显时逐拍一致。
//
// 为什么是 job 计数而不是字节数/贴图数：texJobs 是 `await Promise.all` 的**恰好
// 集合**——每个 job 完成即 done++，done/total 与「还要等多久」线性相关；loadedTex
// 只在部分装载点自增（属性纹理/preloadSamplerDefaults 不计数），拿它当分子会虚高。
//
// 失败出口（mountScene 外层 catch → onError/降级页）必须还原画布内联样式：
// 渐显是锦上添花，绝不允许把壁纸或降级页吞成空白。

/**
 * 渐显进度 → 画布 opacity。
 * 边界：`total <= 0`（无贴图壁纸，没有空档期可补）与非有限输入一律返回 1 =
 * 立即完全可见；其余夹到 [0,1] 线性。
 */
export function fadeOpacityOf(done: number, total: number): number {
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return 1;
  const p = done / total;
  return p < 0 ? 0 : p > 1 ? 1 : p;
}

/**
 * 给 texJobs 包一层完成计数（仅渐显开启时使用；关闭时原样返回，零行为变化）。
 * 两个 handler 都计数：loadTex 已内部 catch（一张坏贴图不拖垮整挂），但
 * preloadSamplerDefaults 等其它 job 形态不保证——计数与 settle 语义都不能依赖
 * 「job 永不 reject」，漏计会让 opacity 永远到不了 1。
 */
export function countJobSettle<T>(
  jobs: Promise<T>[],
  onDone: () => void,
): Promise<T>[] {
  return jobs.map((p) =>
    p.then(
      (v) => {
        onDone();
        return v;
      },
      (e) => {
        onDone();
        throw e;
      },
    ),
  );
}
