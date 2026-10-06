/** 底部状态栏：后端连通 + 库路径、条目数、当前条目、舞台分辨率、DPR / 资源倍率、帧率 */

import { $, on, state } from "./store";
import { t } from "./i18n";

const libEl = $<HTMLElement>("#status-lib");
const dotEl = $<HTMLElement>("#status-backend .wb-status-dot");
const countEl = $<HTMLElement>("#status-count");
const itemEl = $<HTMLElement>("#status-item");
const resEl = $<HTMLElement>("#status-res");
const dprStatusEl = $<HTMLElement>("#status-dpr");
const capEl = $<HTMLElement>("#status-fps");
export const liveFpsEl = $<HTMLElement>("#status-live-fps");

const dprEl = $<HTMLSelectElement>("#dpr");
const resSelEl = $<HTMLSelectElement>("#res");
const resnEl = $<HTMLSelectElement>("#resn");
const fpsEl = $<HTMLSelectElement>("#fps");

export function syncBackend() {
  dotEl.classList.toggle("is-ok", state.backend === "ok");
  dotEl.classList.toggle("is-err", state.backend === "down");
  const text = state.backend === "down" ? t("status.backendDown") : state.libDir;
  libEl.textContent = text;
  libEl.title = text;
}

export function setStatusCount(n: number) {
  countEl.textContent = t("status.items", { n });
}

export function syncStatusItem() {
  itemEl.textContent = state.selected?.itemId ?? state.localFile?.name ?? "";
}

export function setStatusRes(text: string) {
  resEl.textContent = text;
}

/**
 * 由清晰度档推出贴图资源倍率，用于状态栏显示（与 renderer/src/resource-scale.ts 的
 * 档位映射保持一致：高清 ≥1.5 → 1、标准 ≈1 → 0.8、省电 → 0.6、auto 按屏幕密度自适应）。
 * `资源` 下拉有覆盖值时优先显示覆盖值。
 */
function resourceScaleLabel(): string {
  if (resSelEl.value === "native") return "R 1（native）";
  if (resSelEl.value) return `R ${resSelEl.value}（覆盖）`;
  const n = Number(dprEl.value);
  if (!dprEl.value || n === 0 || Number.isNaN(n)) {
    const d = Math.max(0.6, Math.min(1, (window.devicePixelRatio || 1) / 2));
    return `R ${d.toFixed(2)}（auto）`;
  }
  if (n >= 1.5) return "R 1（高清）";
  if (n >= 0.9) return "R 0.8（标准）";
  return "R 0.6（省电）";
}

export function syncStatusChrome() {
  dprStatusEl.textContent = `DPR ${dprEl.value === "0" ? "auto" : dprEl.value} · ${resourceScaleLabel()}${resnEl.value ? ` · 法线 ${resnEl.value}` : ""}`;
  capEl.textContent = t("status.cap", { n: fpsEl.value });
}

for (const el of [dprEl, resSelEl, resnEl, fpsEl]) el.addEventListener("change", syncStatusChrome);
on("backend", syncBackend);
on("selection", syncStatusItem);
