/**
 * 一次性实测探针 · 噪声路径 A/B（性能，非门禁）。
 *
 * 测什么：粒子噪声的**单元格角点缓存**（particle-util.js 的 cellSlot/ncVal）在重粒子场景上的收益。
 * 为什么这么测（docs/ENGINE-REVIEW-2026-10.md §6.1 的口径）：
 *   · 本机常驻壁纸应用会让绝对值漂 ⇒ **同一浏览器会话内交替** off/on/off/on 四轮，
 *     比同一配置跨会话的绝对值。
 *   · 开关靠页面注入（每次 navigate 都是一份新文档，开关在首次调用时解析一次），
 *     即「一份构建跑两种行为」。
 *   · 只信两个量：`__wpStats.frame()` 的 fps（重粒子场景是 CPU 受限，fps 很敏感）
 *     与进程树 CPU%（按 type 拆）。
 *
 * 用法：node scripts/_probe-review-noise-ab.mjs [itemId] [rounds]
 * 依赖：本机 dev server 在跑（默认 1430）且挂了本地壁纸库。
 */
import { launchHeadless, instrument } from "./headless-gpu.mjs";

const ITEM = process.argv[2] || "3262691944";
const ROUNDS = Number(process.argv[3] || 6);
const ORIGIN = "http://localhost:1430";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const url = () =>
  `${ORIGIN}/renderer/index.html?type=scene&src=${ITEM}` +
  `&mediaBase=${encodeURIComponent(ORIGIN + "/media/dev")}` +
  `&fit=cover&renderDpr=1&sceneFps=60&aa=off&pq=high&pp=high&muted=true&loop=true`;

/**
 * 稳态采样：先用 settleMs 让装载尖峰过去，再在 windowMs 内取样。
 * 指标：
 *   fps          —— `__wpStats.frame()` 的中位数（丢掉窗口最前面两个样本，防装载尾巴）
 *   rendererCpu% —— **窗口差分**：processInfo 给的是累计 cpuTime，
 *                   必须 (ΔcpuTime / Δwall) × 100 才是「占单核百分比」
 */
async function sample(session, settleMs, windowMs) {
  await sleep(settleMs);
  const cpu0 = await session.processInfo();
  const t0 = Date.now();
  const fps = [];
  let cpu1 = cpu0;
  while (Date.now() - t0 < windowMs) {
    fps.push(Number(await session.evaluate("(window.__wpStats && __wpStats.frame && __wpStats.frame().fps) || 0")));
    await sleep(500);
    cpu1 = await session.processInfo();
  }
  const wall = (Date.now() - t0) / 1000;
  const used = fps.length > 3 ? fps.slice(2) : fps;
  const sorted = [...used].sort((x, y) => x - y);
  const dcpu = (cpu1.byType.renderer || 0) - (cpu0.byType.renderer || 0);
  return {
    fps: +sorted[Math.floor(sorted.length / 2)].toFixed(1),
    fpsMin: +sorted[0].toFixed(1),
    fpsMax: +sorted[sorted.length - 1].toFixed(1),
    rendererCpu: +((dcpu / wall) * 100).toFixed(1),
    wall: +wall.toFixed(1),
  };
}

async function main() {
  const session = await launchHeadless({ url: "about:blank", task: "noise-ab", width: 1280, height: 720 });
  const rounds = [];
  try {
    instrument(session);
    await session.assertGpu();
    // 交替顺序：先跑「关」（原路径）——会话第 1 轮自带冷启动惩罚，不能让它永远压在某一档后面
    const plan = [];
    for (let i = 0; i < ROUNDS; i++) plan.push(i % 2 === 0 ? "off" : "on");
    plan.unshift("off"); // 预热轮（不记账）：把 JIT/缓存冷启动留给它
    for (let r = 0; r < plan.length; r++) {
      const mode = plan[r];
      await session.pageCdp.send("Page.addScriptToEvaluateOnNewDocument", {
        source:
          (mode === "off" ? "window.__noiseCellOff = true;" : "window.__noiseCellOff = false;") +
          // 计数（默认关）：读出 hash3 与单元格缓存各自的命中率 —— 「还有没有复用空间」的判据
          (process.env.NOISE_COUNT === "1" ? "window.__noiseMemoCount = true;" : ""),
      });
      await session.pageCdp.send("Page.navigate", { url: url() });
      const rec = await sample(session, 9000, 8000);
      // 命中率必须在**采样之后**读：navigate 刚回来时模块还没加载（第一版就是这里读到 null）
      let memo = null;
      if (process.env.NOISE_COUNT === "1") {
        const raw = await session.evaluate("JSON.stringify(window.__noiseMemoStats ? __noiseMemoStats() : null)");
        memo = raw ? JSON.parse(raw) : null;
      }
      const entry = { mode, ...rec, memo };
      // 预热判定按**轮次序号**（会话第 1 轮自带冷启动惩罚）。按 mode 判定是错的：
      // plan 里同一个 mode 出现多次时会把所有该 mode 的轮次都当成预热丢掉（踩过）。
      if (r > 0) rounds.push(entry);
      console.log(JSON.stringify(entry));
    }
  } finally {
    try {
      await session.close();
    } catch {
      /* 忽略 */
    }
  }
  const pick = (m) => rounds.filter((r) => r.mode === m);
  const avg = (a) => (a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : null);
  console.log(
    "\n汇总：" +
      `原路径 fps=${avg(pick("off").map((r) => r.fps))} cpu=${avg(pick("off").map((r) => r.rendererCpu))}% ` +
      `| 单元格缓存 fps=${avg(pick("on").map((r) => r.fps))} cpu=${avg(pick("on").map((r) => r.rendererCpu))}%`,
  );
}

await main();
