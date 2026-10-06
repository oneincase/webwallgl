/**
 * 底部控制台：测试台自身日志 + 渲染器诊断流（/api/diag-stream）。
 * 支持按级别 / 关键字过滤与自动滚动开关；只保留最近 MAX_LINES 行。
 */

import { $ } from "./store";
import { t } from "./i18n";

export type LogLevel = "info" | "warn" | "error";

const MAX_LINES = 2000;

const bodyEl = $<HTMLPreElement>("#logbody");
const filterEl = $<HTMLInputElement>("#log-filter");
const levelEl = $<HTMLElement>("#log-level");
const autoScrollEl = $<HTMLInputElement>("#log-autoscroll");
const countEl = $<HTMLElement>("#log-count");

let level: "all" | LogLevel = "all";
let errorCount = 0;

function matches(line: HTMLElement): boolean {
  if (level !== "all" && line.dataset.level !== level) return false;
  const kw = filterEl.value.trim().toLowerCase();
  return !kw || (line.textContent ?? "").toLowerCase().includes(kw);
}

function syncCount() {
  countEl.hidden = errorCount === 0;
  countEl.textContent = String(errorCount);
  countEl.classList.toggle("is-err", errorCount > 0);
}

export function log(msg: string, lvl: LogLevel = "info") {
  const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  const line = document.createElement("span");
  line.className = `log-line lv-${lvl}`;
  line.dataset.level = lvl;
  const ts = document.createElement("span");
  ts.className = "log-ts";
  ts.textContent = time;
  line.append(ts, document.createTextNode(`${msg}\n`));
  line.hidden = !matches(line);
  bodyEl.appendChild(line);
  while (bodyEl.childElementCount > MAX_LINES) {
    const first = bodyEl.firstElementChild as HTMLElement | null;
    if (first?.dataset.level === "error") errorCount--;
    first?.remove();
  }
  if (lvl === "error") {
    errorCount++;
    syncCount();
  }
  if (autoScrollEl.checked) bodyEl.scrollTop = bodyEl.scrollHeight;
}

function refilter() {
  for (const line of bodyEl.children as HTMLCollectionOf<HTMLElement>) line.hidden = !matches(line);
  if (autoScrollEl.checked) bodyEl.scrollTop = bodyEl.scrollHeight;
}

filterEl.addEventListener("input", refilter);

levelEl.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".seg-btn");
  if (!btn?.dataset.level) return;
  level = btn.dataset.level as typeof level;
  for (const b of levelEl.querySelectorAll<HTMLButtonElement>(".seg-btn")) b.classList.toggle("active", b === btn);
  refilter();
});

$<HTMLButtonElement>("#clear-logs").onclick = () => {
  bodyEl.textContent = "";
  errorCount = 0;
  syncCount();
};

// 渲染器的 reportDiag 走 <img src="/diag?msg=...&lvl=..."> → 宿主中间件 → SSE 回推到这里。
// 级别由渲染器自己声明并随请求发出（issue #13）：这里只管按它染色，不再对文案
// 做关键字匹配。老渲染器没有这一位时才退回文案判据。
export function connectDiag() {
  const diag = new EventSource("/api/diag-stream");
  diag.onmessage = (ev) => {
    try {
      const { msg, level: lv } = JSON.parse(ev.data) as { msg: string; level?: string };
      log(
        msg,
        lv === "error" || lv === "warn" || lv === "info" ? lv : /fail|error|失败|ERROR/.test(msg) ? "error" : "info",
      );
    } catch {
      /* 忽略心跳等非 JSON 帧 */
    }
  };
  diag.onerror = () => log(t("err.diagStream"), "error");
}
