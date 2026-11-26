// 「渲染」面板（右栏标签）：帧率上限、音量、系统音频、画质三档 —— 对标 WE 客户端的壁纸性能选项。
// 全局一套、localStorage 记住、所有文档共用；挂载时随 MountOptions 带入，已挂载时热更。
//
// 音频一条：音量滑杆 > 0，编辑器预览就真的出声（引擎里的声音层 / 视频音轨开始播）；
// 「系统音频」再开一路宿主 loopback 频谱喂给引擎，音频反应层（g_AudioSpectrum* uniform、
// 「音频频谱条」效果、粒子音频门控、文字脚本 registerAudioBuffers）才会跟着系统声音动。
// 试听元素接进来的频谱源（setPreviewAudio）优先于系统音频：点「试听」时看的是那首歌。

import type { AntiAliasingMode, AudioSource, MediaSource, MountOptions, ParticleQuality, PostQuality, SceneInstance } from "../../renderer/src/api/editor";
import { createSystemAudioSource, mountAudioMeter, type AudioSourceStatus, type BandsSource } from "../audio-live";
import { et } from "../i18n";

/** 带状态查询的音频源（两条源都满足；面板状态文案用） */
export type LiveBandsSource = BandsSource & { status(): AudioSourceStatus };

export type RenderSettingsOptions = {
  fps: HTMLSelectElement;
  volume: HTMLInputElement;
  volumeVal: HTMLElement;
  aa: HTMLSelectElement;
  pq: HTMLSelectElement;
  pp: HTMLSelectElement;
  /** 渲染过程渐显（3.1，默认关；见 renderer/src/fade-in.ts 的时序契约） */
  fadeIn: HTMLInputElement;
  /**
   * 渐显是**挂载期**效果（预览循环活在加载窗口里），没有 setQuality 那样的热更通道；
   * 勾选变化后由调用方重挂预览（keepTime），否则用户看不到任何反馈、开关就成了摆设。
   */
  onFadeChange?: () => void;
  /** 「系统音频」开关 */
  sysAudio: HTMLInputElement;
  /** 音频状态文案（关 / 等待信号 / 已连接 / 试听中） */
  audioStatus: HTMLElement;
  /** 电平条容器 */
  audioMeter: HTMLElement;
  /** 当前挂载实例（没挂上时 null） */
  instance: () => SceneInstance | null;
};

export type RenderSettings = {
  fpsCap(): number;
  /** 挂载期选项：fps / volume / quality / fadeIn，开着系统音频时再带 audio 与媒体源 */
  mountOptions(): Pick<MountOptions, "fps" | "volume" | "quality" | "fadeIn"> & { audio?: AudioSource; media?: MediaSource };
  /** 试听元素的分析源（null = 试听结束，回落到系统音频 / 引擎内置源） */
  setPreviewAudio(src: LiveBandsSource | null): void;
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
  if (r.sysAudio === true) o.sysAudio.checked = true;
  // 渐显默认关：localStorage 只记 true 的显式开启（缺省形态与「从没这个键」同义）
  if (r.fadeIn === true) o.fadeIn.checked = true;

  const quality = () => ({
    antiAliasing: o.aa.value as AntiAliasingMode,
    particles: o.pq.value as ParticleQuality,
    postProcessing: o.pp.value as PostQuality,
  });
  const saveQuality = () => write(QUALITY_KEY, { aa: o.aa.value, pq: o.pq.value, pp: o.pp.value });
  const saveRender = () =>
    write(RENDER_KEY, { fps: Number(o.fps.value), volume: Number(o.volume.value), sysAudio: o.sysAudio.checked, fadeIn: o.fadeIn.checked });
  const syncVolumeLabel = () => (o.volumeVal.textContent = `${Math.round(Number(o.volume.value) * 100)}%`);

  // ── 音频源 ─────────────────────────────────────────────────────────────
  const sys = createSystemAudioSource();
  const meter = mountAudioMeter(o.audioMeter);
  let previewSrc: LiveBandsSource | null = null;
  if (o.sysAudio.checked) sys.start();
  const activeSrc = (): LiveBandsSource | null => previewSrc ?? (o.sysAudio.checked ? sys : null);
  const statusText = (s: AudioSourceStatus) =>
    et(s === "live" ? "audio.live" : s === "preview" ? "audio.previewing" : s === "idle" ? "audio.idle" : "audio.off");
  const syncAudioStatus = () => (o.audioStatus.textContent = statusText(activeSrc()?.status() ?? "off"));
  meter.onFrame(syncAudioStatus);
  /** 开/关/换源都走这里：挂载后热更引擎音频源 + 媒体源 + 电平条 + 状态文案 */
  const applyAudio = () => {
    const src = activeSrc();
    o.instance()?.setAudio(src);
    // 封面走同一条系统实况：频谱和 Now Playing 是宿主同一个 SSE 推下来的，
    // 只装频谱就会出现「音条会动、封面不出来」。关掉时交回引擎内置媒体源。
    o.instance()?.setMedia(o.sysAudio.checked ? sys.media() : null);
    meter.setSource(src);
    syncAudioStatus();
  };

  o.fps.onchange = () => {
    saveRender();
    o.instance()?.setFps(Number(o.fps.value));
  };
  o.volume.oninput = () => {
    syncVolumeLabel();
    o.instance()?.setVolume(Number(o.volume.value));
  };
  o.volume.onchange = saveRender;
  o.sysAudio.onchange = () => {
    if (o.sysAudio.checked) sys.start();
    else sys.stop();
    saveRender();
    applyAudio();
  };
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
  // 渐显没有热更通道（效果活在加载窗口里）：存档 + 重挂预览。重挂走调用方注入的
  // onFadeChange（mountCurrent(keepTime)），面板模块不碰实例生命周期。
  o.fadeIn.onchange = () => {
    saveRender();
    o.onFadeChange?.();
  };
  syncVolumeLabel();
  syncAudioStatus();

  return {
    fpsCap: () => Number(o.fps.value),
    mountOptions: () => {
      const opts: Pick<MountOptions, "fps" | "volume" | "quality" | "fadeIn"> & { audio?: AudioSource; media?: MediaSource } = {
        fps: Number(o.fps.value),
        volume: Number(o.volume.value),
        quality: quality(),
        fadeIn: o.fadeIn.checked,
      };
      // 只在真开着音频源时才带 audio 键：mount.ts 里「键存在」= 显式接管整条音频模拟，
      // 传 null 会连引擎内置的 BGM 分析一起关掉（音频反应层连壁纸自带的歌都不跟）。
      const src = activeSrc();
      if (src) opts.audio = src;
      // 系统媒体源（封面 / 歌名）与系统音频同一个开关：媒体键同理只在开时才带。
      if (o.sysAudio.checked) opts.media = sys.media();
      return opts;
    },
    setPreviewAudio: (src) => {
      previewSrc = src;
      applyAudio();
    },
  };
}
