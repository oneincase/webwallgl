// 「性能」面板（底栏标签）：渲染器实测帧率曲线 + 摘要。
// 数字来自 SceneInstance.stats（只有真正提交的帧才计数），所以能看出重场景掉到上限以下。

import type { FrameStats } from "../../renderer/src/api/editor";

const POLL_MS = 500;
/** 2 分钟历史 */
const HISTORY = 240;

export type PerfPanelOptions = {
  summary: HTMLElement;
  canvas: HTMLCanvasElement;
  t: (key: string, params?: Record<string, string | number>) => string;
  stats: () => FrameStats | null;
  fpsCap: () => number;
  visible: () => boolean;
};

export type PerfPanel = {
  /** 换文档 / 重挂时清空历史 */
  reset(): void;
  render(): void;
};

export function mountPerfPanel(o: PerfPanelOptions): PerfPanel {
  /** null = 该采样点没在出帧（暂停 / 未挂载） */
  const history: (number | null)[] = [];

  const cell = (label: string, value: string, cls = "") => {
    const el = document.createElement("div");
    el.className = `perf-cell ${cls}`;
    const v = document.createElement("strong");
    v.textContent = value;
    const l = document.createElement("span");
    l.textContent = label;
    el.append(v, l);
    return el;
  };

  function render() {
    if (!o.visible()) return;
    const cap = o.fpsCap();
    const samples = history.filter((v): v is number => v !== null);
    const last = history.length ? history[history.length - 1] : null;
    const fmt = (n: number) => (Number.isFinite(n) ? String(Math.round(n)) : "—");
    o.summary.textContent = "";
    o.summary.append(
      cell(o.t("perf.current"), last === null ? "—" : fmt(last), last !== null && last < cap * 0.85 ? "low" : ""),
      cell(o.t("perf.avg"), samples.length ? fmt(samples.reduce((a, b) => a + b, 0) / samples.length) : "—"),
      cell(o.t("perf.min"), samples.length ? fmt(Math.min(...samples)) : "—"),
      cell(o.t("perf.max"), samples.length ? fmt(Math.max(...samples)) : "—"),
      cell(o.t("perf.cap"), String(cap)),
    );
    const hint = document.createElement("span");
    hint.className = "perf-hint";
    hint.textContent = o.stats() ? o.t("perf.hint") : o.t("perf.idle");
    o.summary.appendChild(hint);
    draw();
  }

  function draw() {
    const box = o.canvas.parentElement!;
    const dpr = window.devicePixelRatio || 1;
    const w = box.clientWidth;
    const h = box.clientHeight;
    if (w <= 0 || h <= 0) return;
    if (o.canvas.width !== Math.round(w * dpr) || o.canvas.height !== Math.round(h * dpr)) {
      o.canvas.width = Math.round(w * dpr);
      o.canvas.height = Math.round(h * dpr);
    }
    const ctx = o.canvas.getContext("2d");
    if (!ctx) return;
    const css = getComputedStyle(document.documentElement);
    const accent = css.getPropertyValue("--wb-accent").trim() || "#3d8bfd";
    const line = css.getPropertyValue("--wb-line").trim() || "#333";
    const mute = css.getPropertyValue("--wb-fg-mute").trim() || "#777";
    const warn = css.getPropertyValue("--wb-warn").trim() || "#e5b454";

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const cap = o.fpsCap();
    const top = Math.max(cap * 1.15, ...history.map((v) => v ?? 0));
    const padL = 30;
    const padR = 8;
    const padT = 8;
    const padB = 8;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;
    const y = (v: number) => padT + plotH * (1 - v / top);

    ctx.font = `10px ${css.getPropertyValue("--mono") || "monospace"}`;
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

  window.setInterval(() => {
    const s = o.stats();
    if (!s) return render();
    history.push(s.running && s.fps > 0 ? s.fps : null);
    if (history.length > HISTORY) history.shift();
    render();
  }, POLL_MS);
  new ResizeObserver(() => draw()).observe(o.canvas.parentElement!);

  return {
    reset() {
      history.length = 0;
      render();
    },
    render,
  };
}
