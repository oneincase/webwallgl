#!/usr/bin/env node
/**
 * verify-occlusion —— 遮挡感知降载（V5）的离线判据。
 *
 * 三层断言（同 verify-quality 的纪律）：
 *   1. 数值：occlusion.ts 的几何与分档语义（esbuild bundle 后真跑）——
 *      网格覆盖率 vs 精确分解互检、保守扩大红线、滞回/驻留分档、
 *      fail-open 失联判定、fps 收敛（宿主上限优先、20fps 下限）；
 *   2. 接线：shell/scene-mount/renderer/api 各入口真的调了这些函数
 *      （文本断言，防「实现了但没人调」）；
 *   3. 变异红测：把 ROI 裁剪门/守门挂起在内存里改坏，确认断言会变红。
 */
import { build } from "esbuild";
import fs from "node:fs";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = join(fileURLToPath(import.meta.url), "..");
const ROOT = join(here, "..");

let failed = 0;
function check(ok, msg) {
  if (ok) console.log(`  ✓ ${msg}`);
  else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

async function loadOcclusion() {
  const out = await build({
    entryPoints: [join(ROOT, "renderer/src/occlusion.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "es2022",
  });
  // 临时 bundle 放 node_modules/.tmp（git 天然忽略）：进程被 SIGKILL 也不会在
  // 仓库里留下未跟踪残渣（scripts/ 下放 .tmp-* 有过这种事故）。
  const tmpDir = join(ROOT, "node_modules", ".tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmp = join(tmpDir, `.verify-occlusion-${process.pid}.mjs`);
  fs.writeFileSync(tmp, out.outputFiles[0].text);
  try {
    return await import(pathToFileURL(tmp).href);
  } finally {
    fs.unlinkSync(tmp);
  }
}

const oc = await loadOcclusion();
const SCREEN = { w: 1920, h: 1080 };

// ---------- 1) 几何：归一化 / 覆盖率 / 精确分解 ----------

{
  // 归一化：越界钳制、非法/空丢弃、负尺寸丢弃
  const n = oc.normalizeOccluders(SCREEN, [
    [-100, -100, 500, 500],   // 左上越界 → 钳成 [0,0,400,400]
    [1920, 0, 100, 100],      // 完全出屏 → 丢
    [100, 100, 0, 50],        // 零宽 → 丢
    [NaN, 0, 10, 10],         // NaN → 丢
    { x: 1500, y: 900, w: 999, h: 999 }, // 对象形态 + 右下越界 → 钳
  ]);
  check(n.length === 2, `normalizeOccluders 钳制后剩 2 块（实得 ${n.length}）`);
  check(n[0][0] === 0 && n[0][1] === 0 && n[0][2] === 400 && n[0][3] === 400,
    "负偏移矩形钳到画布内");
  check(n[1][2] === SCREEN.w - 1500 && n[1][3] === SCREEN.h - 900, "右下越界钳到画布边");
}

{
  // 精确分解：单个半屏遮挡 → 两块可见矩形，面积精确
  const rects = oc.decomposeVisibleRects(SCREEN, [[0, 0, 1920, 540]]);
  check(rects.length === 1 && rects[0].y === 540 && near(rects[0].h, 540),
    "上半屏遮挡 → 下半屏单矩形");
  check(near(oc.exactVisibleRatio(SCREEN, rects), 0.5), "精确可见比例 = 0.5");
}

{
  // 精确分解：两窗对角遮挡 → 十字形（约 5 块），比例精确
  const occluders = [
    [0, 0, 1700, 500],      // 左上
    [220, 580, 1700, 500],  // 右下
  ];
  const rects = oc.decomposeVisibleRects(SCREEN, occluders);
  const ratio = oc.exactVisibleRatio(SCREEN, rects);
  // 手算：可见 = 右上条 (1920-1700)*500 + 左下条 220*500 + 中缝十字交叉区…
  // 直接用「补集恒等式」校验：遮挡并集面积 + 可见面积 = 全屏（遮挡两块不重叠时）
  const occArea = 1700 * 500 * 2;
  check(near(ratio, 1 - occArea / (SCREEN.w * SCREEN.h), 1e-6),
    `对角双窗可见比例与手算一致（实得 ${ratio.toFixed(4)}）`);
  check(rects.length >= 3 && rects.length <= 8, `十字形分解矩形数在 3~8（实得 ${rects.length}）`);
}

{
  // 网格覆盖率 vs 精确分解互检（决策层与消费层口径一致性）：
  // 单个大遮挡（与 tile 边界对齐）时两种口径应相等
  const occ = [[0, 0, 1920, 540]]; // 1080/16=67.5px/tile，540 恰好 8 行 tile
  const grid = oc.computeGridCoverage(SCREEN, occ, 16);
  check(near(grid, 0.5, 1e-9), `网格覆盖率（tile 对齐）= 0.5（实得 ${grid.toFixed(4)}）`);
  // 未对齐遮挡：网格口径允许 ±1 tile 行误差，且必须**高估**遮挡（保守暂停）
  const gridOff = oc.computeGridCoverage(SCREEN, [[0, 0, 1920, 535]], 16);
  check(gridOff >= 0.5, `网格口径高估遮挡（宁早暂停）（实得 ${gridOff.toFixed(4)}）`);
  // 全屏遮挡 → 1；无遮挡 → 0
  check(near(oc.computeGridCoverage(SCREEN, [[0, 0, 1920, 1080]], 16), 1), "全屏遮挡覆盖率 1");
  check(near(oc.computeGridCoverage(SCREEN, [], 16), 0), "无遮挡覆盖率 0");
}

{
  // 保守扩大红线：碎片合并/量化后的可见区 ⊇ 精确可见区（只许多画不得漏画）
  const cases = [
    [[960, 0, 960, 1080]],                       // 右半遮挡
    [[100, 100, 1720, 880]],                     // 中央大窗 → 边框条
    [[0, 0, 900, 500], [1020, 580, 900, 500]],   // 对角双窗
    [[0, 0, 1920, 540], [0, 540, 960, 540]],     // L 形
  ];
  let conservative = true;
  for (const occluders of cases) {
    const exact = oc.decomposeVisibleRects(SCREEN, occluders);
    const frame = oc.computeOcclusionFrame(SCREEN, oc.normalizeOccluders(SCREEN, occluders));
    // 逐采样点校验：精确可见的点必须在消费层矩形里（漏画检测）
    const inAny = (rects, x, y) => rects.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
    for (let i = 0; i < 64 && conservative; i++) {
      for (let j = 0; j < 36 && conservative; j++) {
        const x = (i + 0.5) * 30, y = (j + 0.5) * 30;
        if (inAny(exact, x, y) && !inAny(frame.rects, x, y)) conservative = false;
      }
    }
  }
  check(conservative, "碎片合并 + 量化后的可见区 ⊇ 精确可见区（不漏画红线）");
}

{
  // 量化防抖：1px 抖动不产生新矩形（量化到 8px 栅格）
  const a = oc.computeOcclusionFrame(SCREEN, [[0, 0, 960, 540]]);
  const b = oc.computeOcclusionFrame(SCREEN, [[0, 0, 961, 541]]);
  const same = a.rects.length === b.rects.length &&
    a.rects.every((r, i) => r.x === b.rects[i].x && r.y === b.rects[i].y && r.w === b.rects[i].w && r.h === b.rects[i].h);
  check(same, "1px 遮挡抖动经量化后矩形不变（防抖）");
}

// ---------- 2) 分档状态机：滞回 / 驻留 / fps 收敛 ----------

const cfg = oc.DEFAULT_OCCLUSION_CONFIG;

{
  check(cfg.pause === 0.05 && cfg.heavy === 0.30 && cfg.light === 0.70, "默认阈值 5%/30%/70%（Lively 95% 覆盖暂停对齐）");
  check(cfg.heavyFps >= 20 && cfg.lightFps >= 20, "默认降帧档 ≥ 20fps（双时钟失步下限）");
  check(oc.bandForRatio(0.02, cfg) === "pause" && oc.bandForRatio(0.2, cfg) === "heavy" &&
    oc.bandForRatio(0.5, cfg) === "light" && oc.bandForRatio(0.9, cfg) === "run", "bandForRatio 直映正确");
}

{
  // 走深立即（可跳级）+ 驻留确认：0.9 → 0.01 需要 dwellMs 才落到 pause
  let st = null;
  ({ state: st } = oc.nextBand(st, 0.9, 0, cfg));
  check(st.band === "run", "初始 0.9 → run");
  let r1 = oc.nextBand(st, 0.01, 100, cfg);
  check(r1.band === "run", "0.01 立即查不落 pause（驻留未到）");
  let r2 = oc.nextBand(r1.state, 0.01, 100 + cfg.dwellMs, cfg);
  check(r2.band === "pause", `持续 ${cfg.dwellMs}ms 后落 pause（走深可跳级）`);
  // 走浅滞回（对称）：退出阈 = 本档入阈 + hysteresis —— pause >0.10 / heavy >0.35
  // / light >0.75。逐级上爬的每一级都要「候选出现 + 驻留确认」。
  let r3 = oc.nextBand(r2.state, 0.09, 1000, cfg);
  check(r3.band === "pause", "0.09 未过退出阈值（0.10）不离开 pause（滞回）");
  let r4a = oc.nextBand(r3.state, 0.11, 1400, cfg);
  check(r4a.band === "pause", "0.11 过阈值但驻留未到，仍留 pause");
  let r4 = oc.nextBand(r4a.state, 0.11, 1400 + cfg.dwellMs, cfg);
  check(r4.band === "heavy", "0.11 持续过阈值 + 驻留 → 逐级上爬到 heavy");
  let r4h = oc.nextBand(r4.state, 0.34, 2000 + cfg.dwellMs, cfg);
  check(r4h.band === "heavy", "0.34 未过 heavy 退出阈（0.35）留在 heavy");
  let r5a = oc.nextBand(r4.state, 0.36, 2000, cfg);
  check(r5a.band === "heavy", "0.36 首 tick 不跳级（heavy → light 也要驻留）");
  let r5 = oc.nextBand(r5a.state, 0.36, 2000 + cfg.dwellMs, cfg);
  check(r5.band === "light", "0.36 + 驻留 → light（逐级，不跳 run）");
  let r6a = oc.nextBand(r5.state, 0.76, 3000, cfg);
  let r6 = oc.nextBand(r6a.state, 0.76, 3000 + cfg.dwellMs, cfg);
  check(r6.band === "run", "再过一次驻留 → run");
}

{
  // 棘轮回归（对称滞回改设计的动机，独立评审双票确认）：
  // 旧公式「退出阈 = 上一档入阈 + 滞回」让退出跨过整个下一档区间 ——
  // ① pause 后 ratio 0.20（heavy 区间）曾冻结 10s 不放；
  // ② heavy 后 ratio 0.50（light 区间）曾永驻 24fps；
  // ③ pause@0.71 释放后曾错配歇在 heavy（直映应为 light）。
  let st = oc.nextBand(null, 0.01, 0, cfg).state;
  st = oc.nextBand(st, 0.01, cfg.dwellMs, cfg).state;
  check(st.band === "pause", "前置：0.01 过驻留 → pause");
  for (let t = 1000; t <= 10000; t += 500) st = oc.nextBand(st, 0.2, t, cfg).state;
  check(st.band === "heavy", "pause 后稳定 0.20 持续 10s → heavy（不再冻结）");
  let h = oc.nextBand(st, 0.5, 11000, cfg).state;
  h = oc.nextBand(h, 0.5, 11000 + cfg.dwellMs, cfg).state;
  check(h.band === "light", "heavy 后 0.50 过驻留 → light（不再永驻 24fps）");
  let p = oc.nextBand(null, 0.01, 0, cfg).state;
  p = oc.nextBand(p, 0.01, cfg.dwellMs, cfg).state;
  p = oc.nextBand(p, 0.71, 2000, cfg).state;
  p = oc.nextBand(p, 0.71, 2000 + cfg.dwellMs, cfg).state; // → heavy
  p = oc.nextBand(p, 0.71, 3000, cfg).state; // 立 light 候选
  p = oc.nextBand(p, 0.71, 3000 + cfg.dwellMs, cfg).state; // → light
  check(p.band === "light", "pause@0.71 逐级释放歇在 light（与直映一致，不错配 heavy）");
}

{
  // 阈值附近往返不抖档：0.29/0.31 在 heavy 边界打转，档位不动
  let st = oc.nextBand(null, 0.5, 0, cfg).state; // light
  st = oc.nextBand(st, 0.29, 100, cfg).state;    // candidate heavy（进阈值 0.30 内）
  let band = oc.nextBand(st, 0.31, 100 + cfg.dwellMs, cfg).band;
  check(band === "light", "阈值附近 ±1pp 往返不换档（驻留 + 滞回双保险）");
}

{
  // fps 收敛：宿主上限优先（min）、不往上抬、20 下限；pause=0
  check(oc.occlusionFpsCap("run", cfg, 60) === 60, "run 档不压 fps");
  check(oc.occlusionFpsCap("light", cfg, 60) === cfg.lightFps, "light 档压到 lightFps");
  check(oc.occlusionFpsCap("heavy", cfg, 60) === cfg.heavyFps, "heavy 档压到 heavyFps");
  check(oc.occlusionFpsCap("light", cfg, 20) === 20, "宿主上限更低时尊重宿主（min）");
  check(oc.occlusionFpsCap("heavy", cfg, 10) === 10 && oc.occlusionFpsCap("light", cfg, 15) === 15 &&
    oc.occlusionFpsCap("run", cfg, 10) === 10,
    "宿主上限低于 20fps 档位下限时也不被抬升（min 单向：遮挡只往下压不往上抬）");
  check(oc.occlusionFpsCap("heavy", cfg, 999) === cfg.heavyFps, "不往上抬");
  check(oc.occlusionFpsCap("pause", cfg, 60) === 0, "pause 档返回 0（调用方按暂停处理）");
  // 配置规范化：阈值排序、非法回退、fps 夹在 [20,60]
  const n = oc.normalizeOcclusionConfig({ pause: 0.8, heavy: 0.1, light: 0.5, heavyFps: 5, lightFps: 999 });
  check(n.pause <= n.heavy && n.heavy <= n.light, `规范化后阈值升序（${n.pause}/${n.heavy}/${n.light}）`);
  check(n.heavyFps === 20 && n.lightFps === 60, "fps 档夹在 [20,60]");
  check(oc.normalizeOcclusionConfig(false).pause === cfg.pause, "false/undefined 回落默认配置");
}

{
  // fail-open：超时判定
  check(oc.isOcclusionStale(0, oc.OCCLUSION_STALE_MS + 1), "超过 3s 无推送判定失联");
  check(!oc.isOcclusionStale(0, oc.OCCLUSION_STALE_MS - 1), "3s 内不算失联");
}

{
  // computeOcclusionFrame：宿主 ratio 优先，缺省精确分解口径（3463520581 回归：
  // 内部大窗触碰全部 tile，网格口径会塌缩成 ratio=0 直跳 pause）
  const f = oc.computeOcclusionFrame(SCREEN, [], 0.42);
  check(near(f.ratio, 0.42), "宿主 ratio 优先");
  const g = oc.computeOcclusionFrame(SCREEN, [[0, 0, 1920, 540]]);
  check(near(g.ratio, g.exactRatio) && near(g.ratio, 0.5), "缺省 ratio = 精确可见比例（分档与消费层同源）");
  const empty = oc.computeOcclusionFrame(SCREEN, []);
  check(empty.rects.length === 1 && near(empty.ratio, 1), "无遮挡 → 全屏单矩形 + ratio 1");
  // 网格塌缩回归：内部大窗（85% 覆盖、四边各留 ~7.5% 条带 < 一个 tile）触碰全部 16×16 tile
  const interior = oc.computeOcclusionFrame(SCREEN, [[75, 42, 1770, 996]]);
  check(near(interior.gridCoverage, 1, 1e-9), "网格 covered-if-touched 对内部大窗塌缩为 100%（口径缺陷留存对照）");
  check(near(interior.ratio, interior.exactRatio) && interior.ratio > 0.1,
    `内部 85% 大窗：精确 ratio=${interior.ratio.toFixed(3)} 不随网格塌缩（>0.1，heavy 而非 pause）`);
  // 吞洞回归：96% 内部大窗的四边细条带不得被合并吞成整幅矩形
  const swallow = oc.computeOcclusionFrame(SCREEN, [[38, 21, 1844, 1038]]);
  const swArea = swallow.rects.reduce((a, r) => a + r.w * r.h, 0) / (SCREEN.w * SCREEN.h);
  const centerCovered = swallow.rects.some((r) => 960 >= r.x && 960 < r.x + r.w && 540 >= r.y && 540 < r.y + r.h);
  check(swArea <= 0.5, `96% 内部大窗：ROI 总面积 ${(swArea * 100).toFixed(1)}% ≤ 50%（不吞洞成整幅）`);
  check(!centerCovered, "遮挡中心不被任何 ROI 矩形覆盖（洞保住了）");
  check(swallow.rects.every((r) => r.x + r.w <= SCREEN.w + 1e-6 && r.y + r.h <= SCREEN.h + 1e-6),
    "合并结果不越出画布（clamp 生效）");
}

{
  // mergeFragments 定向回归：对角相接的条带（并集包围盒翻倍）拒绝合并
  const strips = [
    { x: 0, y: 0, w: 1920, h: 8 },      // 顶部细条（tiny）
    { x: 0, y: 8, w: 12, h: 1064 },     // 左侧细条（tiny），与顶条直角相接
  ];
  const mergedCorner = oc.mergeFragments(strips, SCREEN);
  check(mergedCorner.length === 2, `直角相接的细条带不按包围盒合并（实得 ${mergedCorner.length} 块）`);
  const collinear = [
    { x: 0, y: 0, w: 800, h: 10 },
    { x: 0, y: 10, w: 800, h: 900 },
  ];
  const mergedCol = oc.mergeFragments(collinear, SCREEN);
  check(mergedCol.length === 1 && mergedCol[0].h === 910, "同 x/w 共线堆叠仍然合并（过度绘制 ≈ 0）");
}

// ---------- 3) 接线断言（防「实现了但没人调」） ----------

const shellSrc = fs.readFileSync(join(ROOT, "renderer/src/shell.ts"), "utf8");
const mountSrc = fs.readFileSync(join(ROOT, "renderer/src/scene-mount.ts"), "utf8");
const apiMountSrc = fs.readFileSync(join(ROOT, "renderer/src/api/mount.ts"), "utf8");
const mainSrc = fs.readFileSync(join(ROOT, "renderer/src/main.ts"), "utf8");
const rendererSrc = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/renderer.js"), "utf8");
const webSrc = fs.readFileSync(join(ROOT, "renderer/src/web.ts"), "utf8");
const mediaSrc = fs.readFileSync(join(ROOT, "renderer/src/media.ts"), "utf8");
const typesSrc = fs.readFileSync(join(ROOT, "renderer/src/api/types.ts"), "utf8");
const apiIndexSrc = fs.readFileSync(join(ROOT, "renderer/src/api/index.ts"), "utf8");
const mathSrc = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/math.js"), "utf8");

{
  check(/export function pushOcclusion/.test(shellSrc) && /export function tickOcclusion/.test(shellSrc),
    "shell 有 pushOcclusion / tickOcclusion");
  check(/isOcclusionStale\(occ\.receivedAt, now\)/.test(shellSrc), "tickOcclusion 做 fail-open 失联检测");
  check(/ensureOcclusionTimer/.test(shellSrc) && /clearInterval/.test(shellSrc),
    "fail-open 心跳定时器存在且可停（覆盖无渲染循环的视频/网页路径）");
  check(/gen < prev\.gen/.test(shellSrc) || /epoch !== prev\.epoch/.test(shellSrc),
    "epoch/gen 宿主重启检测存在");
  check(/rt\.occlusion = undefined;/.test(shellSrc) && /stopOcclusionTimer\(rt\);/.test(shellSrc),
    "clear() 清遮挡态 + 停心跳（重挂不残留）");
  check(/setOccluded\?\.\(false\)/.test(shellSrc) && /setOccluded\?\.\(true\)/.test(shellSrc),
    "档位跨界经 sceneCtl.setOccluded 停/启");
  check(/occluded: true/.test(shellSrc) && /throttled/.test(shellSrc),
    "frameStats 带出 occluded/throttled 口径");
}

{
  // renderLoop 三件套：遮挡守卫 / fps 收敛 / 守门挂起
  check(/tickOcclusion\(rt, now\);/.test(mountSrc), "scene 渲染循环逐帧 tick 遮挡维护");
  check(/if \(disposed \|\| rt\.paused \|\| occlPaused\(rt\)\) return;/.test(mountSrc),
    "渲染循环早退含遮挡暂停（occlPaused）");
  check(/occlActive[\s\S]{0,400}adaptive && !occlActive/.test(mountSrc),
    "遮挡期间挂起帧率守门（R1：误降档 + 暂停时长毒化 accum 双防护）");
  check(/occlusionFpsCap\(occlBand, occlusionCfgOf\(rt\), baseFps\)/.test(mountSrc) &&
    /occlusionFpsCap\(occlBand, occlusionCfgOf\(rt\), baseFps\)/.test(mediaSrc) &&
    /occlusionFpsCap\(band, occlusionCfgOf\(rt\), rt\.cfg\.sceneFps \|\| 60\)/.test(webSrc),
    "遮挡降帧多处共用 occlusionFpsCap 单源（宿主 setFps 永远优先 + 20fps 下限不漂移）");
  check(/setOccludedImpl = \(on: boolean\) =>/.test(mountSrc),
    "scene 路径有 setOccludedImpl（与用户 pause 三种交织语义）");
  // ROI 世界矩形：fitWindow 同源 + 相机不动 + 全幅单矩形直通
  check(/fitWindow\(roiFit, projW, projH, cssW, cssH, peek\.x, peek\.y\)/.test(mountSrc),
    "ROI 逆映射用 fitWindow 同源数学（含 peek 对齐）");
  check(/renderer\s*\n?\s*\.render\(scene, textures, c\.width, c\.height, t, normalizeFit\(rt\.cfg\.fit\), peek\.x, peek\.y, roiWorld\)/.test(mountSrc),
    "render 调用透传 roiWorld");
}

{
  check(/function isLayerOutsideRoi/.test(rendererSrc), "renderer 有 isLayerOutsideRoi（ROI 裁剪）");
  check(/function layerCullBounds/.test(rendererSrc), "AABB+余量抽成 layerCullBounds 共享（单一真源）");
  check(/roiRectsLocal && isLayerOutsideRoi\(layer, cam, roiRectsLocal\)/.test(rendererSrc), "主循环真的做 ROI 裁剪");
  check(/roiCullStats: function/.test(rendererSrc), "roiCullStats 可观测出口存在");
  // 两条禁改区：ROI 裁剪不得写 visible；不得进合成源预渲染路径
  const roiFn = rendererSrc.slice(rendererSrc.indexOf("function isLayerOutsideRoi"), rendererSrc.indexOf("function isLayerOutsideRoi") + 1400);
  check(!/visible/.test(roiFn.replace(/visible\/\s*visibleSelf/g, "").replace(/\/\/[^\n]*/g, "")),
    "ROI 裁剪是纯渲染期跳过（不写 visible —— 注释除外）");
  check(rendererSrc.indexOf("roiRectsLocal && isLayerOutsideRoi") < rendererSrc.indexOf("async function renderCompositeSources") + 200,
    "ROI 裁剪位于主循环（renderLayer 之前），不在合成源预渲染路径里生效");
  check(/const roiRectsLocal = roiRects && roiRects\.length \? roiRects : null/.test(rendererSrc) &&
    /roiCullLastFrame = 0\s*\n\s*roiGateLastFrame = 0/.test(rendererSrc) &&
    /if \(roiRectsLocal\) roiCullFrames\+\+/.test(rendererSrc),
    "ROI 矩形为局部变量 + 统计每帧无条件复位（全幅跳过帧不累加）");
  check(!/roiWorldRects/.test(rendererSrc), "ROI 无模块态（帧重叠时上一次调用不再改写下一次的状态）");
}

{
  check(/setOcclusion\(payload: OcclusionPayload \| null\)/.test(apiMountSrc), "SceneInstance.setOcclusion 存在");
  check(/pushOcclusion\(rt, payload\)/.test(apiMountSrc), "setOcclusion 接到 shell 推送管线");
  check(/videoPairs[\s\S]{0,200}p\.pause\(\)/.test(apiMountSrc) && /prevBand === "pause" && !rt\.paused/.test(apiMountSrc),
    "A/B 视频对跨界停启 + 用户暂停期间不误启媒体");
  check(/occlusion\?: OcclusionBands \| false/.test(typesSrc), "MountOptions.occlusion 类型存在");
  check(/occluded\?: boolean/.test(typesSrc) && /throttled\?: boolean/.test(typesSrc), "FrameStats 扩展字段存在");
  check(/OcclusionPayload/.test(apiIndexSrc) && /OcclusionBands/.test(apiIndexSrc), "公共出口导出遮挡类型");
  check(/rt\.occlusionCfg = o\.occlusion === false \? false : normalizeOcclusionConfig\(o\.occlusion\)/.test(apiMountSrc),
    "挂载选项 occlusion 规范化（false=显式关闭）");
  check(/weShimSend\(rt, "setPaused", \{ v: on \}\)/.test(webSrc), "web 路径遮挡暂停走 shim setPaused");
  check(/if \(on \|\| !rt\.paused\) weShimSend\(rt, "setPaused"/.test(webSrc),
    "web 解除遮挡不掀用户暂停（rt.paused 守卫，评审 P0-1）");
  check(/setOccludedImpl = \(on: boolean\) =>/.test(mediaSrc) && /setOccluded: \(on: boolean\) =>/.test(mediaSrc),
    "media 两条路径（GL 合成 + WebCodecs）都有 setOccluded");
}

{
  // P1-1（双票评审）：web 降帧接线 —— setOcclusionBand 钩子 + web 实现 +
  // 重挂/种子播种 + 重放补遮停 + WebCodecs fps 回调 + 宿主 setSceneFps 收敛。
  check(/setOcclusionBand\?\.\(band\)/.test(shellSrc) && /setOcclusionBand\?\.\("run"\)/.test(shellSrc),
    "档位跨界与清态都推 setOcclusionBand（web shim 无循环可逐帧读档位）");
  check(/setOcclusionBand\(band: OcclusionBand\)/.test(webSrc) && /weShimSend\(rt, "setFps", \{ n: cap \}\)/.test(webSrc),
    "web 实现 setOcclusionBand → shim setFps（pause 档跳过，0 不播种）");
  check(/function seedFpsOf/.test(webSrc) && /weShimSend\(rt, "setFps", \{ n: seedFpsOf\(rt\) \}\)/.test(webSrc) &&
    /buildSeedScript\(wire, seedFpsOf\(rt\)/.test(webSrc),
    "web 重放/种子播种按当前遮挡档收敛（重挂不再满帧跑）");
  check(/rt\.paused \|\| occlPaused\(rt\)/.test(webSrc),
    "web 重放补发遮挡暂停（遮停中重挂，新 iframe 不整页跑起来）");
  check(/fps: \(\) => occlusionFpsCap\(/.test(mediaSrc),
    "WebCodecs fps 回调按档收敛（曾有能力降帧但漏接；DOM <video> 才真只能 pause）");
  check(/occlusionFpsCap\(band, occlusionCfgOf\(rt\), fps\)/.test(mainSrc),
    "宿主 setSceneFps 过档位收敛（min 语义：web 推送路径与循环路径一致）");
}

{
  // P1-2（双票评审）：ROI 逆映射接相机 zoom —— 与 buildCamera 单一真源。
  check(/export function applyCameraZoom/.test(mathSrc) && /export function cameraZoomOf/.test(mathSrc),
    "math.js 导出 applyCameraZoom / cameraZoomOf（共享单一真源）");
  check(/applyCameraZoom\(win, cameraZoomOf\(scene\)\)/.test(mathSrc),
    "buildCamera 走共享 zoom 数学（不再内联）");
  check(/applyCameraZoom\(win, cameraZoomOf\(scene\)\)/.test(mountSrc),
    "ROI 逆映射过同一份 zoom（zoom<1 不再误裁可见区边缘）");
  const mathMod = await import(pathToFileURL(join(ROOT, "renderer/vendor/we-scene/render/math.js")).href);
  const wHalf = { offX: 0, offY: 0, viewW: 1920, viewH: 1080 };
  mathMod.applyCameraZoom(wHalf, 0.5);
  check(wHalf.viewW === 3840 && wHalf.offX === -960 && wHalf.viewH === 2160 && wHalf.offY === -540,
    "applyCameraZoom 中心锚定收缩（zoom=0.5：窗口翻倍、中心不动）");
  const wOne = { offX: 10, offY: 5, viewW: 100, viewH: 50 };
  mathMod.applyCameraZoom(wOne, 1);
  check(wOne.viewW === 100 && wOne.offX === 10 && wOne.viewH === 50,
    "zoom=1 无操作（不动 fit 窗口，也不碰 16:9 匹配）");
  const wTwo = { offX: 0, offY: 0, viewW: 100, viewH: 50 };
  mathMod.applyCameraZoom(wTwo, 2);
  check(wTwo.viewW === 50 && wTwo.offX === 25 && wTwo.viewH === 25 && wTwo.offY === 12.5,
    "zoom=2 视口减半（画面放大，3151551777 的 1.01 震动同族）");
}

{
  // 暂停交织矩阵（评审 P0-2/P0-3）：包装层门控 + pauseImpl 重入幂等。
  // scene 壁纸的 rt.videoPairs 是全部场景纹理（含隐藏层/脚本停用层），无差别
  // resume 会把它们全部起播；遮挡暂停 → 用户 pause() 的重入会把捕获清单清空。
  check(/if \(rt\.sceneCtl\?\.setOccluded\) return;/.test(apiMountSrc) &&
    /if \(rt\.sceneCtl\?\.setOccluded\) return;/.test(mainSrc),
    "包装层媒体停启仅限无 sceneCtl 钩子路径（评审 P0-2，mount + __wp 两处）");
  const pauseImplIdx = mountSrc.indexOf("pauseImpl = () => {");
  const pauseImplBody = mountSrc.slice(pauseImplIdx, pauseImplIdx + 700);
  check(pauseImplIdx >= 0 && /if \(pauseStarted\) return;/.test(pauseImplBody) &&
    !/playingVideos\.length = 0;/.test(pauseImplBody.slice(0, pauseImplBody.indexOf("if (pauseStarted) return;"))),
    "scene pauseImpl 重入幂等：守卫在清单清空之前（评审 P0-3）");
  const mediaPauseIdx = mediaSrc.indexOf("pauseImpl = () => {");
  const mediaPauseBody = mediaSrc.slice(mediaPauseIdx, mediaPauseIdx + 500);
  check(mediaPauseIdx >= 0 && /if \(pauseStarted\) return;/.test(mediaPauseBody),
    "media pauseImpl 重入幂等（videoWasPlaying 不被重入覆写，评审 P0-3）");
}

// ---------- 4) 变异红测（改坏接线，确认断言会红） ----------

{
  // 4a) 主循环 ROI 裁剪门被短路：接线断言用的原样式必须从变异体里消失
  const m1 = rendererSrc.replace("if (roiRectsLocal && isLayerOutsideRoi(layer, cam, roiRectsLocal)) {", "if (false && roiRectsLocal && isLayerOutsideRoi(layer, cam, roiRectsLocal)) {");
  check(m1 !== rendererSrc && !/if \(roiRectsLocal && isLayerOutsideRoi\(layer, cam, roiRectsLocal\)\) \{/.test(m1),
    "变异红测样本：ROI 裁剪门被短路后会被主循环断言抓住");
  check(/if \(roiRectsLocal && isLayerOutsideRoi\(layer, cam, roiRectsLocal\)\) \{/.test(rendererSrc),
    "变异红测：主循环 ROI 裁剪门断言有效");
  // 4b) 守门挂起被删（遮挡期间继续喂守门）
  const m2 = mountSrc.replace("if (adaptive && !occlActive) {", "if (adaptive) {");
  check(m2 !== mountSrc, "变异红测样本：守门挂起可被移除");
  check(/if \(adaptive && !occlActive\) \{/.test(mountSrc), "变异红测：守门挂起断言有效");
  // 4c) fps 收敛调用被改成「直接用宿主上限（不看档位）」
  const m3 = mountSrc.replace(
    "occlusionFpsCap(occlBand, occlusionCfgOf(rt), baseFps)",
    "baseFps",
  );
  check(m3 !== mountSrc, "变异红测样本：fps 单源调用可被移除");
  check(/occlusionFpsCap\(occlBand, occlusionCfgOf\(rt\), baseFps\)/.test(mountSrc),
    "变异红测：fps 单源调用断言有效");
  // 4d) web 的 rt.paused 守卫被删（遮挡解除掀开用户暂停）
  const m4 = webSrc.replace("if (on || !rt.paused) weShimSend(rt, \"setPaused\", { v: on });", "weShimSend(rt, \"setPaused\", { v: on });");
  check(m4 !== webSrc && !/if \(on \|\| !rt\.paused\) weShimSend\(rt, "setPaused"/.test(m4),
    "变异红测样本：web 守卫被删后会被断言抓住");
  // 4e) 包装层 sceneCtl 门控被删（scene 隐藏层视频被无差别起播）
  const m5 = apiMountSrc.replace("if (rt.sceneCtl?.setOccluded) return;", "");
  check(m5 !== apiMountSrc && !/if \(rt\.sceneCtl\?\.setOccluded\) return;/.test(m5),
    "变异红测样本：包装层门控被删后会被断言抓住");
  // 4f) pauseImpl 重入守卫被删（重捕获清空清单 → 恢复失忆）
  const m6 = mountSrc.replace("if (pauseStarted) return;", "");
  {
    const i = m6.indexOf("pauseImpl = () => {");
    check(m6 !== mountSrc && i >= 0 && !/if \(pauseStarted\) return;/.test(m6.slice(i, i + 700)),
      "变异红测样本：pauseImpl 重入守卫被删后会被断言抓住");
  }
  // 4g) shell 的 setOcclusionBand 推送被删（web 降帧失效回 pause-only）
  const m7 = shellSrc.replace("rt.sceneCtl?.setOcclusionBand?.(band);", "");
  check(m7 !== shellSrc && !/setOcclusionBand\?\.\(band\)/.test(m7),
    "变异红测样本：setOcclusionBand 推送被删后会被断言抓住");
  // 4h) ROI 映射的 zoom 收缩被删（zoom<1 误裁可见区回归）
  const m8 = mountSrc.replace("applyCameraZoom(win, cameraZoomOf(scene));", "");
  check(m8 !== mountSrc && !/applyCameraZoom\(win, cameraZoomOf\(scene\)\)/.test(m8),
    "变异红测样本：ROI zoom 接线被删后会被断言抓住");
}

// ---------- 5) 运行时管线（esbuild 打包 shell.ts + 桩 window，Node 直行） ----------
// 覆盖 pushOcclusion → 分档 → sceneCtl.setOccluded 停启 → frameStats 口径 →
// fail-open（tickOcclusion 失联清态）→ clear() 清态。同 verify-resolution 的
// 桩注入纪律（window/document 桩必须在 import 前就位）。

let fakeNow = 0;
function loadShell() {
  // 先就位桩再 import（bundle 顶层的 contextmenu IIFE 会碰 window/document）
  globalThis.window ??= {
    devicePixelRatio: 2,
    innerWidth: 1920,
    innerHeight: 1080,
    document: { addEventListener() {}, removeEventListener() {} },
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.document ??= globalThis.window.document;
  if (!globalThis.performance || !globalThis.performance.__fake) {
    globalThis.performance = { __fake: true, now: () => fakeNow };
  }
  return build({
    entryPoints: [join(ROOT, "renderer/src/shell.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "es2022",
  }).then(async (out) => {
    const tmp = join(ROOT, "scripts", `.tmp-occl-shell-${process.pid}.mjs`);
    fs.writeFileSync(tmp, out.outputFiles[0].text);
    try {
      return await import(pathToFileURL(tmp).href);
    } finally {
      fs.unlinkSync(tmp);
    }
  });
}

{
  const shell = await loadShell();
  const mkRt = () => {
    const rt = shell.createRuntime();
    rt.cfg = { ...rt.cfg, canvas: { clientWidth: 1920, clientHeight: 1080 } };
    const calls = [];
    rt.sceneCtl = { setOccluded: (on) => calls.push(on) };
    return { rt, calls };
  };
  const advance = (ms) => { fakeNow += ms; };

  // 5a) 全屏遮挡 → 暂停档（首次推送按 ratio 直映立档 —— 设计行为：宿主开始推送
  //     时若已全遮挡，宁早勿晚；后续的抖动由驻留 + 滞回挡住）→ frameStats occluded
  {
    const { rt, calls } = mkRt();
    const full = [[0, 0, 1920, 1080]];
    shell.pushOcclusion(rt, { occluders: full, gen: 1 });
    check(rt.occlusion.band === "pause", "首次推送全遮挡直映 pause（首帧不折腾）");
    advance(500);
    shell.pushOcclusion(rt, { occluders: full, gen: 2 });
    check(rt.occlusion.band === "pause", "持续全遮挡过驻留 → pause");
    check(calls.length === 1 && calls[0] === true, "跨界到 pause 时调 sceneCtl.setOccluded(true)");
    const st = shell.frameStats(rt);
    check(st.occluded === true && st.running === false, "frameStats 报 occluded=true / running=false");
    // ROI：全屏遮挡下可见矩形为空（图层全裁）
    check(rt.occlusion.rects.length === 0, "全屏遮挡 → 可见矩形为空");
  }

  // 5b) 部分遮挡 → 降帧档（throttled）→ 解除 → run + setOccluded(false)
  {
    const { rt, calls } = mkRt();
    const half = [[0, 0, 960, 1080]];
    shell.pushOcclusion(rt, { occluders: half, gen: 1 });
    advance(500);
    shell.pushOcclusion(rt, { occluders: half, gen: 2 });
    check(rt.occlusion.band === "light", "半屏遮挡（可见 50%）→ light 档");
    check(shell.frameStats(rt).throttled === true, "降帧档 frameStats 报 throttled");
    check(rt.occlusion.rects.length === 1 && Math.abs(rt.occlusion.rects[0].w - 960) < 16,
      "半屏遮挡可见矩形 ≈ 右半屏（保守量化后）");
    advance(500);
    shell.pushOcclusion(rt, { occluders: [], gen: 3 });
    check(rt.occlusion.band === "light", "撤遮挡首推只立候选（驻留防抖）");
    advance(500);
    shell.pushOcclusion(rt, { occluders: [], gen: 4 });
    check(rt.occlusion.band === "run", "撤遮挡持续过驻留 → run");
    check(calls.length === 0, "全程未 pause，无媒体停启调用");
    // null 推送 → 清态
    shell.pushOcclusion(rt, null);
    check(rt.occlusion === undefined && rt.occlusionTick === undefined, "null 推送清态并停心跳");
  }

  // 5c) fail-open：推送失联 → tickOcclusion 清态并解除暂停
  {
    const { rt, calls } = mkRt();
    const full = [[0, 0, 1920, 1080]];
    shell.pushOcclusion(rt, { occluders: full, gen: 1 });
    advance(500);
    shell.pushOcclusion(rt, { occluders: full, gen: 2 });
    check(rt.occlusion.band === "pause", "失联前处于 pause");
    advance(4000); // 超过 OCCLUSION_STALE_MS（3s）
    shell.tickOcclusion(rt, fakeNow);
    check(rt.occlusion === undefined, "失联后 tickOcclusion 清空遮挡态（fail-open）");
    check(calls.includes(false) && calls[calls.length - 1] === false, "fail-open 解除暂停（setOccluded(false)）");
  }

  // 5d) gen 回退 = 宿主重启：档位状态机重置
  {
    const { rt } = mkRt();
    const full = [[0, 0, 1920, 1080]];
    shell.pushOcclusion(rt, { occluders: full, gen: 100 });
    advance(500);
    shell.pushOcclusion(rt, { occluders: full, gen: 101 });
    check(rt.occlusion.band === "pause", "重启前已 pause");
    advance(500);
    // 新会话 gen 从 1 重新计（比上一会话小）
    shell.pushOcclusion(rt, { occluders: [], gen: 1, epoch: 2 });
    check(rt.occlusion.band === "run" && rt.occlusion.gen === 1, "gen 回退视为宿主重启，状态机重置");
  }

  // 5e) 显式关闭（occlusionCfg=false）：推送静默无效
  {
    const { rt, calls } = mkRt();
    rt.occlusionCfg = false;
    shell.pushOcclusion(rt, { occluders: [[0, 0, 1920, 1080]], gen: 1 });
    check(rt.occlusion === undefined && calls.length === 0, "occlusion: false 时推送静默无效");
  }

  // 5f) clear() 清态（重挂不残留）
  {
    const { rt } = mkRt();
    shell.pushOcclusion(rt, { occluders: [[0, 0, 960, 1080]], gen: 1 });
    check(rt.occlusion !== undefined, "推送后遮挡态存在");
    shell.clear(rt);
    check(rt.occlusion === undefined, "clear() 清掉遮挡态（重挂后宿主重推）");
  }
}

if (failed) {
  console.error(`\nverify-occlusion: ${failed} 处失败`);
  process.exit(1);
}
console.log("\nverify-occlusion: all checks passed");
