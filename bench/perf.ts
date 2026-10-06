/**
 * 实测帧率：状态栏读数、视口统计浮层、底部「性能」标签的帧率曲线。
 *
 * 数字来自渲染器自己的打点（同源 iframe 的 __wpStats.frame）：只有真正提交的帧
 * 才计数，所以能看出重场景掉到 fps 上限以下。测试台这边只轮询显示，
 * 不自己数 iframe 的 rAF —— 那样量到的是显示器刷新率，不是壁纸帧率。
 */

import { $, on, state } from "./store";
import { t } from "./i18n";
import { frameStats, type FrameStats } from "./bridge";
import { fpsCap } from "./render-settings";
import { liveFpsEl } from "./statusbar";
import { tabs } from "./layout";

const POLL_MS = 500;
/** 2 分钟历史 */
const HISTORY = 240;

const statsEl = $<HTMLElement>("#vp-stats");
const summaryEl = $<HTMLElement>("#perf-summary");
const canvasEl = $<HTMLCanvasElement>("#perf-canvas");

/** null = 该采样点没在出帧（暂停 / 未挂载 / 静止待命） */
const history: (number | null)[] = [];

type Reading = { text: string; cls: "idle" | "low" | ""; fps: number | null };

function read(stats: FrameStats | undefined): Reading {
  // 静止待命：循环活着、画面完好，只是这一帧的输出与上一帧逐像素相同因而没提交
  // （静态媒体壁纸的按需渲染，见 media.ts 文件头）。它与「没在出帧（暂停/没挂上）」
  // 必须分开显示 —— 没有这一支，健康的静止壁纸会被显示成待机态，看起来像出错。
  if (stats?.running && stats.idle) return { text: t("status.idle"), cls: "idle", fps: null };
  if (!stats?.running || !(stats.fps > 0)) return { text: "— FPS", cls: "idle", fps: null };
  const fps = Math.round(stats.fps);
  // 掉到上限的 85% 以下标黄：这类壁纸就是要盯的性能样本
  return { text: `${fps} FPS`, cls: fps < fpsCap() * 0.85 ? "low" : "", fps };
}

function applyReading(el: HTMLElement, r: Reading) {
  el.textContent = r.text;
  el.classList.toggle("idle", r.cls === "idle");
  el.classList.toggle("low", r.cls === "low");
}

/** 回到「没在出帧」的待机态：切壁纸/清空选择时立即生效，不等下一次轮询 */
function reset() {
  applyReading(liveFpsEl, { text: "— FPS", cls: "idle", fps: null });
  history.length = 0;
  renderStatsOverlay(undefined);
  renderPerf();
}

function renderStatsOverlay(stats: FrameStats | undefined) {
  if (statsEl.hidden) return;
  const r = read(stats);
  const flags = [stats?.occluded ? "occluded" : "", stats?.throttled ? "throttled" : ""].filter(Boolean).join(" · ");
  statsEl.innerHTML = "";
  const big = document.createElement("div");
  big.className = `vp-stats-fps ${r.cls}`;
  big.textContent = r.fps === null ? r.text : String(r.fps);
  const sub = document.createElement("div");
  sub.className = "vp-stats-sub";
  sub.textContent = `${r.fps === null ? "" : "FPS · "}${t("perf.cap")} ${fpsCap()}${flags ? ` · ${flags}` : ""}`;
  statsEl.append(big, sub);
}

function summaryCell(label: string, value: string, cls = "") {
  const cell = document.createElement("div");
  cell.className = `perf-cell ${cls}`;
  const v = document.createElement("strong");
  v.textContent = value;
  const l = document.createElement("span");
  l.textContent = label;
  cell.append(v, l);
  return cell;
}

function renderPerf() {
  if (tabs.bottom.current() !== "perf") return;
  const samples = history.filter((v): v is number => v !== null);
  const last = history.length ? history[history.length - 1] : null;
  const fmt = (n: number | null | undefined) => (n === null || n === undefined || !Number.isFinite(n) ? "—" : String(Math.round(n)));
  summaryEl.textContent = "";
  summaryEl.append(
    summaryCell(t("perf.current"), last === null ? "—" : fmt(last), last !== null && last < fpsCap() * 0.85 ? "low" : ""),
    summaryCell(t("perf.avg"), samples.length ? fmt(samples.reduce((a, b) => a + b, 0) / samples.length) : "—"),
    summaryCell(t("perf.min"), samples.length ? fmt(Math.min(...samples)) : "—"),
    summaryCell(t("perf.max"), samples.length ? fmt(Math.max(...samples)) : "—"),
    summaryCell(t("perf.cap"), String(fpsCap())),
  );
  const hint = document.createElement("span");
  hint.className = "perf-hint";
  hint.textContent = state.selected || state.localFile ? t("perf.hint") : t("perf.idle");
  summaryEl.appendChild(hint);
  drawChart();
}

function drawChart() {
  const box = canvasEl.parentElement!;
  const dpr = window.devicePixelRatio || 1;
  const w = box.clientWidth;
  const h = box.clientHeight;
  if (w <= 0 || h <= 0) return;
  if (canvasEl.width !== Math.round(w * dpr) || canvasEl.height !== Math.round(h * dpr)) {
    canvasEl.width = Math.round(w * dpr);
    canvasEl.height = Math.round(h * dpr);
  }
  const ctx = canvasEl.getContext("2d");
  if (!ctx) return;
  const css = getComputedStyle(document.documentElement);
  const accent = css.getPropertyValue("--wb-accent").trim() || "#3d8bfd";
  const line = css.getPropertyValue("--wb-line").trim() || "#333";
  const mute = css.getPropertyValue("--wb-fg-mute").trim() || "#777";
  const warn = css.getPropertyValue("--wb-warn").trim() || "#e5b454";

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const cap = fpsCap();
  const top = Math.max(cap * 1.15, ...history.map((v) => v ?? 0));
  const padL = 30;
  const padR = 8;
  const padT = 8;
  const padB = 8;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const y = (v: number) => padT + plotH * (1 - v / top);

  ctx.font = `10px ${css.getPropertyValue("--mono")}`;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (const v of [0, Math.round(top / 2), Math.round(top)]) {
    ctx.strokeStyle = line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, Math.round(y(v)) + 0.5);
    ctx.lineTo(w - padR, Math.round(y(v)) + 0.5);
    ctx.stroke();
    ctx.fillStyle = mute;
    ctx.fillText(String(v), padL - 6, y(v));
  }

  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = warn;
  ctx.beginPath();
  ctx.moveTo(padL, y(cap));
  ctx.lineTo(w - padR, y(cap));
  ctx.stroke();
  ctx.setLineDash([]);

  if (history.length < 2) return;
  const step = plotW / (HISTORY - 1);
  const x0 = padL + plotW - step * (history.length - 1);
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = "round";
  let drawing = false;
  ctx.beginPath();
  history.forEach((v, i) => {
    const x = x0 + i * step;
    if (v === null) {
      drawing = false;
      return;
    }
    if (drawing) ctx.lineTo(x, y(v));
    else ctx.moveTo(x, y(v));
    drawing = true;
  });
  ctx.stroke();

  const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
  grad.addColorStop(0, `${accent}40`);
  grad.addColorStop(1, `${accent}00`);
  ctx.fillStyle = grad;
  let start = -1;
  const fillRun = (from: number, to: number) => {
    ctx.beginPath();
    ctx.moveTo(x0 + from * step, padT + plotH);
    for (let i = from; i <= to; i++) ctx.lineTo(x0 + i * step, y(history[i] as number));
    ctx.lineTo(x0 + to * step, padT + plotH);
    ctx.closePath();
    ctx.fill();
  };
  history.forEach((v, i) => {
    if (v !== null && start < 0) start = i;
    if ((v === null || i === history.length - 1) && start >= 0) {
      fillRun(start, v === null ? i - 1 : i);
      start = -1;
    }
  });
}

function poll() {
  const stats = frameStats();
  const r = read(stats);
  applyReading(liveFpsEl, r);
  if (state.selected || state.localFile) {
    history.push(r.fps);
    if (history.length > HISTORY) history.shift();
  }
  renderStatsOverlay(stats);
  renderPerf();
}

window.setInterval(poll, POLL_MS);
new ResizeObserver(() => drawChart()).observe(canvasEl.parentElement!);
on("mounted", reset);
on("tab", ({ panel, id }) => {
  if (panel === "bottom" && id === "perf") requestAnimationFrame(renderPerf);
});
$<HTMLInputElement>("#vp-stats-toggle").addEventListener("change", () => renderStatsOverlay(frameStats()));
