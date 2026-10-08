// 「渲染」面板（右栏标签）：帧率上限、音量、画质三档 —— 对标 WE 客户端的壁纸性能选项。
// 全局一套、localStorage 记住、所有文档共用；挂载时随 MountOptions 带入，已挂载时热更。

import type { AntiAliasingMode, MountOptions, ParticleQuality, PostQuality, SceneInstance } from "../../renderer/src/api/editor";

export type RenderSettingsOptions = {
  fps: HTMLSelectElement;
  volume: HTMLInputElement;
  volumeVal: HTMLElement;
  aa: HTMLSelectElement;
  pq: HTMLSelectElement;
  pp: HTMLSelectElement;
  /** 当前挂载实例（没挂上时 null） */
  instance: () => SceneInstance | null;
};

export type RenderSettings = {
  fpsCap(): number;
  /** 挂载期选项：fps / volume / quality */
  mountOptions(): Pick<MountOptions, "fps" | "volume" | "quality">;
};

const QUALITY_KEY = "webwallgl-quality";
const RENDER_KEY = "webwallgl-render";

function read(key: string): Record<string, unknown> {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "{}");
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 隐私模式 / 配额满：只是不记住 */
  }
}

const hasOption = (sel: HTMLSelectElement, v: unknown) => typeof v === "string" && [...sel.options].some((o) => o.value === v);

export function mountRenderSettings(o: RenderSettingsOptions): RenderSettings {
  const q = read(QUALITY_KEY);
  if (hasOption(o.aa, q.aa)) o.aa.value = q.aa as string;
  if (hasOption(o.pq, q.pq)) o.pq.value = q.pq as string;
  if (hasOption(o.pp, q.pp)) o.pp.value = q.pp as string;
  const r = read(RENDER_KEY);
  if (hasOption(o.fps, String(r.fps ?? ""))) o.fps.value = String(r.fps);
  if (typeof r.volume === "number" && r.volume >= 0 && r.volume <= 1) o.volume.value = String(r.volume);

  const quality = () => ({
    antiAliasing: o.aa.value as AntiAliasingMode,
    particles: o.pq.value as ParticleQuality,
    postProcessing: o.pp.value as PostQuality,
  });
  const saveQuality = () => write(QUALITY_KEY, { aa: o.aa.value, pq: o.pq.value, pp: o.pp.value });
  const saveRender = () => write(RENDER_KEY, { fps: Number(o.fps.value), volume: Number(o.volume.value) });
  const syncVolumeLabel = () => (o.volumeVal.textContent = `${Math.round(Number(o.volume.value) * 100)}%`);

  o.fps.onchange = () => {
    saveRender();
    o.instance()?.setFps(Number(o.fps.value));
  };
  o.volume.oninput = () => {
    syncVolumeLabel();
    o.instance()?.setVolume(Number(o.volume.value));
  };
  o.volume.onchange = saveRender;
  o.aa.onchange = () => {
    saveQuality();
    o.instance()?.setQuality({ antiAliasing: quality().antiAliasing });
  };
  o.pq.onchange = () => {
    saveQuality();
    o.instance()?.setQuality({ particles: quality().particles });
  };
  o.pp.onchange = () => {
    saveQuality();
    o.instance()?.setQuality({ postProcessing: quality().postProcessing });
  };
  syncVolumeLabel();

  return {
    fpsCap: () => Number(o.fps.value),
    mountOptions: () => ({ fps: Number(o.fps.value), volume: Number(o.volume.value), quality: quality() }),
  };
}
