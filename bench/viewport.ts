/**
 * 中央视口：舞台缩放（自适应 16:9 / 固定逻辑分辨率）、视口工具条（分辨率、适配、
 * 清晰度、指针注入、遮挡模拟、统计浮层、滤镜）以及拖入 .pkg 打开。
 */

import { $, emit, on, state } from "./store";
import { t } from "./i18n";
import { frameEl, frameStats, wp, wpQuiet } from "./bridge";
import { log } from "./console";
import { setStatusRes } from "./statusbar";
import { load, save } from "../shared/workbench/storage";

const workspaceEl = $<HTMLElement>("#workspace");
const resolutionEl = $<HTMLSelectElement>("#resolution");
const fitEl = $<HTMLSelectElement>("#fit");
const dprEl = $<HTMLSelectElement>("#dpr");
const fxEl = $<HTMLSelectElement>("#fx");
const pointerPushEl = $<HTMLInputElement>("#pointer-push");
const pointerVeilEl = $<HTMLElement>("#pointer-veil");
const occSimEl = $<HTMLInputElement>("#occ-sim");
const occVeilEl = $<HTMLElement>("#occ-veil");
const occGridEl = $<HTMLElement>("#occ-grid");
const occHudEl = $<HTMLElement>("#occ-hud");
const statsToggleEl = $<HTMLInputElement>("#vp-stats-toggle");
const statsEl = $<HTMLElement>("#vp-stats");
const stageFrameEl = $<HTMLElement>("#stage-frame");
const stageScaleEl = $<HTMLElement>("#stage-scale");
const stageEl = $<HTMLElement>("#stage");
const stageBadgeEl = $<HTMLElement>("#stage-badge");
const emptyEl = $<HTMLElement>("#empty");
const dropVeilEl = $<HTMLElement>("#drop-veil");

const RES_KEY = "we-bench-resolution";
const FX_KEY = "webwallgl-fx";
const POINTER_PUSH_KEY = "we-bench-pointer-push";
const STATS_KEY = "we-bench-vp-stats";

const hasMount = () => !!(state.selected || state.localFile);

export function appendViewportQuery(p: URLSearchParams) {
  p.set("fit", fitEl.value);
  p.set("renderDpr", dprEl.value);
  p.set("filter", fxEl.value);
}

/** 舞台有无内容：控制空态提示与 iframe 显隐 */
export function setStageActive(active: boolean) {
  frameEl.classList.toggle("on", active);
  emptyEl.hidden = active;
}

// ---------- 画面参数（fit / dpr / 滤镜走 __wp 热更新，dpr 由 __wp 内部重挂） ----------

fitEl.onchange = () => {
  if (hasMount()) wp()?.setFit(fitEl.value);
};
dprEl.onchange = () => {
  if (hasMount()) wp()?.setRenderDpr(Number(dprEl.value));
};

// 滤镜（beta）是观看端偏好：localStorage 记住；挂载时随 query 带给渲染器，
// 已挂载时走 __wp.setFilter 热切（CSS filter，无需重挂）。
fxEl.value = load(FX_KEY) ?? "none";
fxEl.onchange = () => {
  save(FX_KEY, fxEl.value);
  if (state.selected) wp()?.setFilter(fxEl.value);
};

// ---------- 舞台缩放 ----------

export function layoutStage() {
  const val = resolutionEl.value;
  if (val === "fit") {
    workspaceEl.classList.remove("fixed-res");
    stageScaleEl.style.width = "";
    stageScaleEl.style.height = "";
    stageEl.style.width = "";
    stageEl.style.height = "";
    stageEl.style.transform = "";
    stageBadgeEl.hidden = true;
    stageBadgeEl.textContent = "";
    setStatusRes(t("status.adaptive"));
    return;
  }
  const [w, h] = val.split("x").map(Number);
  if (!w || !h) return;
  const cs = getComputedStyle(stageFrameEl);
  const availW = stageFrameEl.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const availH = stageFrameEl.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const scale = Math.min(1, availW / w, availH / h);
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
  workspaceEl.classList.add("fixed-res");
  stageEl.style.width = `${w}px`;
  stageEl.style.height = `${h}px`;
  stageEl.style.transform = `scale(${s})`;
  stageScaleEl.style.width = `${w * s}px`;
  stageScaleEl.style.height = `${h * s}px`;
  const pct = Math.round(s * 100);
  stageBadgeEl.hidden = false;
  stageBadgeEl.textContent = pct < 100 ? `${w} × ${h} · ${pct}%` : `${w} × ${h}`;
  setStatusRes(`${w} × ${h}`);
}

{
  const savedRes = load(RES_KEY);
  if (savedRes && [...resolutionEl.options].some((o) => o.value === savedRes)) resolutionEl.value = savedRes;
}
resolutionEl.onchange = () => {
  save(RES_KEY, resolutionEl.value);
  layoutStage();
};
new ResizeObserver(layoutStage).observe(stageFrameEl);

// ---------- 统计浮层 ----------

statsToggleEl.checked = load(STATS_KEY) === "1";
statsEl.hidden = !statsToggleEl.checked;
statsToggleEl.onchange = () => {
  statsEl.hidden = !statsToggleEl.checked;
  save(STATS_KEY, statsToggleEl.checked ? "1" : "0");
};

// ---- 指针注入（模拟桌面壁纸窗口的宿主推送通道）----
//
// 桌面壁纸窗口位于「桌面 underlay」层（桌面图标之下），Finder 的桌面窗口全屏
// 盖在上面并吃掉全部鼠标事件 —— 壁纸页里一个 mousemove 都收不到。宿主的办法是
// 自己轮询系统鼠标（CGEventGetLocation + CGEventSourceButtonState，零权限），
// 换算成窗口归一化坐标后经 __wp.pushPointer 推进去。
//
// 这里用一层遮罩复现同样的处境：遮罩挡住 iframe，原生事件进不去，坐标只能靠
// 推送。开启后能在本库内验证整条注入链路，不必等下游宿主实现 —— 也是下游对接
// 时的参照实现（换算口径、按键掩码、离开语义都一致）。

/** 遮罩坐标 → 归一化 u/v。用遮罩自身的盒子而非舞台：固定分辨率模式下
 *  #stage 带 CSS transform 缩放，遮罩与 iframe 同在缩放后的坐标系里，
 *  getBoundingClientRect 已含缩放，比例天然与渲染器视口一致。 */
function veilToNormalized(ev: MouseEvent): { u: number; v: number } {
  const r = pointerVeilEl.getBoundingClientRect();
  const u = r.width > 0 ? (ev.clientX - r.left) / r.width : 0.5;
  const v = r.height > 0 ? (ev.clientY - r.top) / r.height : 0.5;
  // 边界钳位：遮罩外沿的半像素舍入会算出 -0.0001 / 1.0001，
  // 宿主侧也应保证 [0,1]（越界值会让 hit-test 落到画面外）。
  return { u: Math.min(1, Math.max(0, u)), v: Math.min(1, Math.max(0, v)) };
}

// 按键位掩码：与契约一致，bit0 左键。MouseEvent.buttons 的 bit0 恰好也是左键，
// 但 bit1/bit2 语义是右/中（DOM 里 2=右、4=中），与契约同构，直接透传。
let veilButtons = 0;

pointerVeilEl.addEventListener("mousemove", (ev) => {
  const { u, v } = veilToNormalized(ev);
  wpQuiet()?.pushPointer(u, v, veilButtons);
});
pointerVeilEl.addEventListener("mousedown", (ev) => {
  veilButtons = ev.buttons;
  const { u, v } = veilToNormalized(ev);
  wpQuiet()?.pushPointer(u, v, veilButtons);
});
// mouseup 挂 window 而不是遮罩：在遮罩内按下、拖到遮罩外松手时，
// 遮罩收不到 mouseup，按下态会永久卡住（DOM 路径当年踩过同一个坑）。
window.addEventListener("mouseup", (ev) => {
  if (pointerVeilEl.hidden) return;
  veilButtons = ev.buttons;
  const { u, v } = veilToNormalized(ev);
  wpQuiet()?.pushPointer(u, v, veilButtons);
});
// 移出遮罩 = 鼠标去了别的显示器：清按键，位置保持最后已知点
pointerVeilEl.addEventListener("mouseleave", () => {
  veilButtons = 0;
  wpQuiet()?.pointerLeave();
});

// 滚轮 / 触摸板注入。遮罩会连原生 wheel 一起吃掉（否则双指滚动会滚动测试台页面
// 而不是壁纸），这里必须 preventDefault —— 故 listener 用非 passive。
//
// 触摸板适配在浏览器里是天然成立的，不必自己识别手势：
//   - 双指滚动直接就是 WheelEvent（hasPreciseScrollingDeltas，deltaMode=0，
//     deltaY 是像素级小值）；
//   - 双指捏合在 Chromium 里被翻译成 **ctrlKey=true 的 wheel**，与给宿主规定的
//     「magnify → mods bit0」是同一条约定。所以这里把真实事件的 delta / ctrlKey
//     原样透传，宿主侧照此实现即可（macOS NSEvent 注意 scrollingDeltaY 要取反）。
//
// 位置不带：__wp.pushWheel 沿用最后一次 pushPointer 的坐标，而 wheel 前必然有
// mousemove 经过同一遮罩。宿主也是同一个道理（scrollWheel 前刚轮询过指针位置）。
pointerVeilEl.addEventListener(
  "wheel",
  (ev) => {
    ev.preventDefault();
    const api = wpQuiet();
    if (!api) return;
    let mods = 0;
    if (ev.ctrlKey) mods |= 1;
    if (ev.shiftKey) mods |= 2;
    if (ev.altKey) mods |= 4;
    if (ev.metaKey) mods |= 8;
    api.pushWheel(ev.deltaX, ev.deltaY, ev.deltaMode, mods);
  },
  { passive: false },
);

function applyPointerPush() {
  const enabled = pointerPushEl.checked;
  pointerVeilEl.hidden = !enabled;
  if (!enabled) {
    veilButtons = 0;
    // 关掉注入时补一次 leave：否则最后那次按下态会留在场景里
    wpQuiet()?.pointerLeave();
  }
}

pointerPushEl.onchange = () => {
  applyPointerPush();
  save(POINTER_PUSH_KEY, pointerPushEl.checked ? "1" : "0");
  log(pointerPushEl.checked ? t("log.pointerPushOn") : t("log.pointerPushOff"));
};
pointerPushEl.checked = load(POINTER_PUSH_KEY) === "1";
applyPointerPush();

// ---------- 遮挡模拟器（V5） ----------
// 对标 Lively 的 Grid Detection Overlay：舞台上拖出「遮挡窗口」，经
// __wp.setOcclusion 推给渲染器（与宿主同一条通道），实时观察覆盖率分档
// （暂停 / 降帧 / ROI 图层裁剪）与网格覆盖可视化。矩形用归一化坐标存
//（#stage 固定分辨率模式带 CSS transform 缩放，归一化天然免疫缩放），
// 推送时再乘渲染器视口尺寸换算成 CSS 像素。
type OccRect = { x: number; y: number; w: number; h: number };
const occWins: OccRect[] = [];
let occGen = 0;
let occPushQueued = false;
/** 网格分块数与库内决策层同源（occlusion.ts computeGridCoverage 的 tiles） */
const OCC_TILES = 16;

function occVeilSize(): { w: number; h: number } {
  const r = occVeilEl.getBoundingClientRect();
  return { w: r.width > 0 ? r.width : 1, h: r.height > 0 ? r.height : 1 };
}

function occToNormalized(ev: MouseEvent): { x: number; y: number } {
  const r = occVeilEl.getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, r.width > 0 ? (ev.clientX - r.left) / r.width : 0)),
    y: Math.min(1, Math.max(0, r.height > 0 ? (ev.clientY - r.top) / r.height : 0)),
  };
}

/** 渲染器视口的 CSS 像素尺寸（推送换算用） */
function occRendererSize(): { w: number; h: number } {
  const w = frameEl.contentWindow?.innerWidth || occVeilSize().w;
  const h = frameEl.contentWindow?.innerHeight || occVeilSize().h;
  return { w, h };
}

function tileCovered(i: number, j: number): boolean {
  const tx = i / OCC_TILES;
  const ty = j / OCC_TILES;
  return occWins.some(
    (r) => tx < r.x + r.w && r.x < tx + 1 / OCC_TILES && ty < r.y + r.h && r.y < ty + 1 / OCC_TILES,
  );
}

function occRender() {
  // 网格分块：与库内同口径 —— tile 与任一窗口相交即算被覆盖（保守方向）
  occGridEl.textContent = "";
  const cell = 100 / OCC_TILES;
  for (let i = 0; i < OCC_TILES; i++) {
    for (let j = 0; j < OCC_TILES; j++) {
      const tile = document.createElement("div");
      tile.className = tileCovered(i, j) ? "occ-tile covered" : "occ-tile";
      tile.style.left = `${i * cell}%`;
      tile.style.top = `${j * cell}%`;
      tile.style.width = `${cell}%`;
      tile.style.height = `${cell}%`;
      occGridEl.appendChild(tile);
    }
  }
  // 窗口矩形（归一化 → 百分比定位）
  for (const el of [...occVeilEl.querySelectorAll(".occ-win")]) el.remove();
  occWins.forEach((r, i) => {
    const el = document.createElement("div");
    el.className = "occ-win";
    el.style.left = `${r.x * 100}%`;
    el.style.top = `${r.y * 100}%`;
    el.style.width = `${r.w * 100}%`;
    el.style.height = `${r.h * 100}%`;
    const badge = document.createElement("span");
    badge.className = "occ-win-badge";
    badge.textContent = `#${i + 1}`;
    el.appendChild(badge);
    occVeilEl.appendChild(el);
  });
  occUpdateHud();
}

/** 覆盖率（tile 口径）与档位读数；档位以渲染器回报为准（无推送时本地估） */
function occUpdateHud() {
  let covered = 0;
  for (let i = 0; i < OCC_TILES; i++) {
    for (let j = 0; j < OCC_TILES; j++) if (tileCovered(i, j)) covered++;
  }
  const coverage = covered / (OCC_TILES * OCC_TILES);
  const st = wpQuiet()?.getOcclusion?.() ?? null;
  const frame = frameStats();
  const band = st?.band ?? (coverage >= 0.95 ? "pause" : coverage >= 0.7 ? "heavy" : coverage >= 0.3 ? "light" : "run");
  const bandLabel: Record<string, string> = {
    pause: "PAUSE 暂停",
    heavy: "HEAVY 重降载",
    light: "LIGHT 降载",
    run: "RUN 全量",
  };
  occHudEl.innerHTML =
    `遮挡覆盖率 ${(coverage * 100).toFixed(1)}% · 可见 ${((1 - coverage) * 100).toFixed(1)}%\n` +
    `档位 <span class="occ-band-${band}">${bandLabel[band] ?? band}</span>` +
    (st ? ` · ROI 块 ${st.rectCount} · ROI 面积 ${(st.rectAreaFrac * 100).toFixed(0)}%` : "") +
    (st && st.roiGate != null ? ` · 图层剔除 ${st.roiCulled ?? 0}/${st.roiGate}` : "") +
    (frame
      ? ` · fps ${frame.fps.toFixed(0)}${frame.occluded ? "（遮停）" : frame.running ? "" : "（停）"}${frame.throttled ? "·限" : ""}`
      : "");
}

/** 推送（合帧去抖：一帧最多一次） */
function occPush() {
  if (occPushQueued) return;
  occPushQueued = true;
  requestAnimationFrame(() => {
    occPushQueued = false;
    if (occVeilEl.hidden) return;
    const size = occRendererSize();
    const occluders = occWins.map((r) => [
      Math.round(r.x * size.w),
      Math.round(r.y * size.h),
      Math.round(r.w * size.w),
      Math.round(r.h * size.h),
    ]) as Array<[number, number, number, number]>;
    wpQuiet()?.setOcclusion?.({ occluders, gen: ++occGen, epoch: "bench" });
    occRender();
  });
}

// 交互：空白处按下拖出新窗口；窗口内拖动移动；右下角手柄缩放；双击删除。
// 全部走归一化坐标 + 纯几何命中（不依赖 DOM target：occRender 每次重建
// .occ-win 元素，dataset.idx 不可靠；且按 DOM target 判时压在边框上的
// 按压会落到 veil 上被当"新建"）。手柄命中按 CSS 像素半径判，允许压线/
// 稍出界抓取 —— 视觉手柄见 bench.css 的 .occ-win::after。双击用 pointerup
// 手动判定：pointerdown 的 preventDefault 会吞掉浏览器合成的兼容鼠标事件
// （mousedown/click/dblclick 都不再派发），原生 dblclick 永远收不到。
let occDrag: {
  idx: number;
  mode: "new" | "move" | "resize";
  startX: number;
  startY: number;
  orig: OccRect;
  /** 是否产生过位移（区分"轻点"与"拖动"，双击只认轻点） */
  moved: boolean;
} | null = null;
let occLastTap: { idx: number; t: number } | null = null;

/** 命中检测（自顶向下）：16px 抓取半径容差，右下角命中即 resize */
function occHit(x: number, y: number): { idx: number; mode: "move" | "resize" } | null {
  const size = occVeilSize();
  const gx = 16 / size.w;
  const gy = 16 / size.h;
  for (let i = occWins.length - 1; i >= 0; i--) {
    const r = occWins[i];
    if (x >= r.x - gx && x <= r.x + r.w + gx && y >= r.y - gy && y <= r.y + r.h + gy) {
      const corner = x >= r.x + r.w - gx && y >= r.y + r.h - gy;
      return { idx: i, mode: corner ? "resize" : "move" };
    }
  }
  return null;
}

occVeilEl.addEventListener("pointerdown", (ev) => {
  if (occVeilEl.hidden || ev.button !== 0) return;
  const { x, y } = occToNormalized(ev);
  const hit = occHit(x, y);
  if (hit) {
    occDrag = { idx: hit.idx, mode: hit.mode, startX: x, startY: y, orig: { ...occWins[hit.idx] }, moved: false };
  } else {
    const r = { x, y, w: 0, h: 0 };
    occWins.push(r);
    occDrag = { idx: occWins.length - 1, mode: "new", startX: x, startY: y, orig: { ...r }, moved: false };
    occRender();
  }
  occVeilEl.setPointerCapture(ev.pointerId);
  ev.preventDefault();
});

occVeilEl.addEventListener("pointermove", (ev) => {
  if (!occDrag) return;
  const { x, y } = occToNormalized(ev);
  const dx = x - occDrag.startX;
  const dy = y - occDrag.startY;
  if (Math.abs(dx) > 0.004 || Math.abs(dy) > 0.004) occDrag.moved = true;
  const r = occWins[occDrag.idx];
  if (!r) return;
  if (occDrag.mode === "move") {
    r.x = Math.min(1 - occDrag.orig.w, Math.max(0, occDrag.orig.x + dx));
    r.y = Math.min(1 - occDrag.orig.h, Math.max(0, occDrag.orig.y + dy));
  } else {
    r.w = Math.max(0.04, Math.min(1 - r.x, occDrag.orig.w + dx));
    r.h = Math.max(0.04, Math.min(1 - r.y, occDrag.orig.h + dy));
  }
  occRender();
  // 拖动中也持续推送（合帧去抖）：让分档跟着窗口实时变化，而不是松手才更新
  occPush();
});

occVeilEl.addEventListener("pointerup", () => {
  if (!occDrag) return;
  const drag = occDrag;
  occDrag = null;
  const r = occWins[drag.idx];
  // 拖出的新窗口太小（<3% 边长）当误触丢弃
  if (drag.mode === "new" && r && (r.w < 0.03 || r.h < 0.03)) {
    occWins.splice(drag.idx, 1);
    occRender();
    return;
  }
  // 手动双击判定：同一窗口两次轻点（无位移）间隔 < 400ms → 删除
  const now = performance.now();
  if (drag.mode === "move" && !drag.moved && r) {
    if (occLastTap && occLastTap.idx === drag.idx && now - occLastTap.t < 400) {
      occLastTap = null;
      occWins.splice(drag.idx, 1);
      occRender();
      occPush();
      return;
    }
    occLastTap = { idx: drag.idx, t: now };
  } else {
    occLastTap = null;
  }
  occPush();
});

occVeilEl.addEventListener("pointercancel", () => {
  occDrag = null;
});

occSimEl.onchange = () => {
  const enabled = occSimEl.checked;
  occVeilEl.hidden = !enabled;
  if (enabled) {
    occRender();
    occPush();
    log(t("log.occSimOn"));
  } else {
    wpQuiet()?.setOcclusion?.(null);
    log(t("log.occSimOff"));
  }
};

// HUD 刷新（0.5s 轮询渲染器回报的档位/ROI/帧率）
setInterval(() => {
  if (!occVeilEl.hidden) occUpdateHud();
}, 500);

// 宿主心跳模拟：真实宿主按 2~4Hz 持续重推（窗口不动也推）。模拟器若只在
// 交互时推一次，松手 3s 后渲染端会按 OCCLUSION_STALE_MS 判"宿主失联"
// fail-open 恢复全量 —— 表现为档位自己从 24fps 回升到 60fps。
setInterval(() => {
  if (!occVeilEl.hidden) occPush();
}, 1000);

// ---------- 拖入 .pkg 打开 ----------
//
// iframe 会吞掉经过它的拖放事件，所以文件一进窗口就把 #drop-veil 盖到视口上，
// 后续 dragover / drop 都落在遮罩上。窗口其他位置的 drop 一律拦下，防止浏览器
// 直接导航到文件。

const isFileDrag = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes("Files");
let dragDepth = 0;

window.addEventListener("dragenter", (e) => {
  if (!isFileDrag(e)) return;
  dragDepth++;
  dropVeilEl.hidden = false;
});
window.addEventListener("dragleave", (e) => {
  if (!isFileDrag(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropVeilEl.hidden = true;
});
window.addEventListener("dragover", (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = dropVeilEl.contains(e.target as Node) ? "copy" : "none";
});
window.addEventListener("drop", (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  dragDepth = 0;
  dropVeilEl.hidden = true;
});
dropVeilEl.addEventListener("dragover", () => dropVeilEl.classList.add("is-over"));
dropVeilEl.addEventListener("dragleave", () => dropVeilEl.classList.remove("is-over"));
dropVeilEl.addEventListener("drop", (e) => {
  dropVeilEl.classList.remove("is-over");
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  if (!/\.pkg$/i.test(file.name)) {
    log(t("err.dropType", { name: file.name }), "warn");
    return;
  }
  emit("open-file", file);
});

on("selection", () => {
  if (!hasMount()) setStageActive(false);
});
