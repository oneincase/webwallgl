/**
 * 检视器「渲染设置」：帧率上限、音量、资源倍率、画质三档、数据源开关。
 *
 * 能热更的走 __wp（fps / 音量 / 画质），挂载期才生效的（资源倍率、系统实况、
 * 原版素材）发 remount 让会话模块重挂。全部随挂载 query 带给渲染器。
 */

import { $, emit, state } from "./store";
import { t } from "./i18n";
import { wp } from "./bridge";
import { log } from "./console";
import { load, save } from "../shared/workbench/storage";

const fpsEl = $<HTMLSelectElement>("#fps");
const volumeEl = $<HTMLInputElement>("#volume");
const volumeValEl = $<HTMLElement>("#volume-val");
const resEl = $<HTMLSelectElement>("#res");
const resnEl = $<HTMLSelectElement>("#resn");
const aaEl = $<HTMLSelectElement>("#aa");
const pqEl = $<HTMLSelectElement>("#pq");
const ppEl = $<HTMLSelectElement>("#pp");
const liveSystemEl = $<HTMLInputElement>("#live-system");
const localAssetsEl = $<HTMLInputElement>("#local-assets");

const hasMount = () => !!(state.selected || state.localFile);

export function fpsCap(): number {
  return Number(fpsEl.value);
}

export function appendRenderQuery(p: URLSearchParams) {
  // 资源分辨率倍率覆盖（贴图缩放）：空=跟随清晰度档，见 renderer/src/resource-scale.ts
  if (resEl.value) p.set("resources", resEl.value);
  if (resnEl.value) p.set("resourcesNormal", resnEl.value);
  p.set("sceneFps", fpsEl.value);
  // 性能设置三档（抗锯齿/粒子/后处理）：渲染器页 main.ts 按同名键解析
  p.set("aa", aaEl.value);
  p.set("pq", pqEl.value);
  p.set("pp", ppEl.value);
  p.set("muted", String(Number(volumeEl.value) <= 0));
  if (liveSystemEl.checked) p.set("liveSystem", "1");
  // 本机引擎内置素材（贴图/法线）开关：渲染器页 local-assets.ts 按同名键解析
  if (!localAssetsEl.checked) p.set("localAssets", "0");
}

fpsEl.onchange = () => {
  if (hasMount()) wp()?.setSceneFps(fpsCap());
};

const syncVolumeLabel = () => (volumeValEl.textContent = `${Math.round(Number(volumeEl.value) * 100)}%`);
volumeEl.oninput = () => {
  syncVolumeLabel();
  if (hasMount()) wp()?.setVolume(Number(volumeEl.value));
};
syncVolumeLabel();

// 资源倍率在**挂载期**解码/上传，改完必须重挂
resEl.onchange = () => emit("remount");
resnEl.onchange = () => emit("remount");

// ---------- 画质（抗锯齿 / 粒子 / 后处理）----------
// 对标 WE 客户端的壁纸性能选项：全局一套、localStorage 记住、所有壁纸共用。
// 已挂载时走 __wp.setQuality 热更（不重挂载），挂载时随 query 带给渲染器。
const QUALITY_KEY = "webwallgl-quality";
{
  try {
    const q = JSON.parse(load(QUALITY_KEY) ?? "{}") as Record<string, string>;
    if (typeof q.aa === "string") aaEl.value = q.aa;
    if (typeof q.pq === "string") pqEl.value = q.pq;
    if (typeof q.pp === "string") ppEl.value = q.pp;
  } catch {
    /* 损坏的持久化值按默认处理 */
  }
}
const saveQuality = () => save(QUALITY_KEY, JSON.stringify({ aa: aaEl.value, pq: pqEl.value, pp: ppEl.value }));
aaEl.onchange = () => {
  saveQuality();
  if (hasMount()) wp()?.setQuality({ antiAliasing: aaEl.value });
};
pqEl.onchange = () => {
  saveQuality();
  if (hasMount()) wp()?.setQuality({ particles: pqEl.value });
};
ppEl.onchange = () => {
  saveQuality();
  if (hasMount()) wp()?.setQuality({ postProcessing: ppEl.value });
};

// 素材开关与系统实况都在挂载期生效（挂载前装载 / provider 注入），所以要重挂一次
localAssetsEl.onchange = () => {
  emit("remount");
  log(localAssetsEl.checked ? t("log.localAssetsOn") : t("log.localAssetsOff"));
};
liveSystemEl.onchange = () => {
  emit("remount");
  log(liveSystemEl.checked ? t("log.liveOn") : t("log.liveOff"));
};
