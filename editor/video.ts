// 编辑器的视频处理：识别 / 探测 / 统一成 H.264 mp4 / 裁剪 / 视频层文件 / 场景录制。
// 官方 WE 的视频贴图（.tex flags 32）与视频壁纸只认 mp4 + H.264，所以进工程的视频一律先归一；
// 已是 mp4 + avc 且不裁剪时原字节保留（零损失）。浏览器内编解码全部走 mediabunny（WebCodecs）。
import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  CanvasSource,
  Conversion,
  ConversionCanceledError,
  Input,
  MP4,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  WebMOutputFormat,
  canEncodeVideo,
} from "mediabunny";

export const VIDEO_FILE_RE = /\.(mp4|m4v|mov|webm|mkv|ogv)$/i;

export function isVideoFile(f: { name: string; type?: string }): boolean {
  return (f.type ?? "").startsWith("video/") || VIDEO_FILE_RE.test(f.name);
}

export type VideoProbe = {
  width: number;
  height: number;
  duration: number;
  codec: string | null;
  mp4: boolean;
  hasAudio: boolean;
};

export async function probeVideo(blob: Blob): Promise<VideoProbe> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error("no video track");
    const format = await input.getFormat();
    return {
      width: track.displayWidth,
      height: track.displayHeight,
      duration: await input.computeDuration(),
      codec: track.codec,
      mp4: format === MP4,
      hasAudio: !!(await input.getPrimaryAudioTrack()),
    };
  } finally {
    input.dispose();
  }
}

export type VideoInput = {
  name: string;
  bytes: Uint8Array;
  width: number;
  height: number;
  duration: number;
  /** 是否经过重新封装 / 转码（原字节保留时为 false） */
  converted: boolean;
};

export type NormalizeOptions = {
  /** 视频层贴图不出声，丢掉音轨；视频壁纸保留（转成 AAC） */
  keepAudio?: boolean;
  trim?: { start: number; end: number };
  onProgress?: (p: number) => void;
  signal?: AbortSignal;
};

/** 统一成 WE 认的 mp4 + H.264；能直接拷贝的轨道不重编码 */
export async function normalizeVideo(file: Blob, name: string, opts: NormalizeOptions = {}): Promise<VideoInput> {
  const probe = await probeVideo(file);
  const audioOk = opts.keepAudio || !probe.hasAudio;
  if (probe.mp4 && probe.codec === "avc" && audioOk && !opts.trim) {
    return {
      name,
      bytes: new Uint8Array(await file.arrayBuffer()),
      width: probe.width,
      height: probe.height,
      duration: probe.duration,
      converted: false,
    };
  }
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target });
  try {
    const conversion = await Conversion.init({
      input,
      output,
      tracks: "primary",
      video: { codec: "avc", quality: QUALITY_HIGH, forceTranscode: probe.codec !== "avc" },
      audio: opts.keepAudio ? { codec: "aac" } : { discard: true },
      trim: opts.trim,
      showWarnings: false,
    });
    if (!conversion.isValid) {
      const why = conversion.discardedTracks.map((t) => t.reason).join(", ");
      throw new Error(`cannot convert to mp4/H.264 (${why || "unsupported"})`);
    }
    if (opts.onProgress) conversion.onProgress = (p) => opts.onProgress!(p);
    const abort = () => void conversion.cancel();
    opts.signal?.addEventListener("abort", abort, { once: true });
    try {
      await conversion.execute();
    } finally {
      opts.signal?.removeEventListener("abort", abort);
    }
    const bytes = new Uint8Array(target.buffer!);
    const out = await probeVideo(new Blob([bytes], { type: "video/mp4" }));
    return { name, bytes, width: out.width, height: out.height, duration: out.duration, converted: true };
  } finally {
    input.dispose();
  }
}

export const isCanceled = (e: unknown) => e instanceof ConversionCanceledError;

export const VIDEO_SLUG_PREFIX = "video-";
export const isEditorVideoModel = (path: unknown) =>
  typeof path === "string" && /^models\/editor\/video-[^/]+\.json$/.test(path);
export const videoMaterialPathOf = (slug: string) => `materials/editor/${slug}.mp4`;

/** 视频层的三个文件：模型 / 材质（genericimage2，贴图名 editor/slug）/ 源视频（导出 pkg 时编成 .tex） */
export function videoLayerFiles(slug: string, v: Pick<VideoInput, "width" | "height" | "bytes">) {
  const enc = new TextEncoder();
  const material = `materials/editor/${slug}.json`;
  return [
    {
      name: `models/editor/${slug}.json`,
      data: enc.encode(JSON.stringify({ material, width: v.width, height: v.height }, null, 2)),
    },
    {
      name: material,
      data: enc.encode(
        JSON.stringify(
          {
            passes: [
              {
                blending: "translucent",
                cullmode: "nocull",
                depthtest: "disabled",
                depthwrite: "disabled",
                shader: "genericimage2",
                textures: [`editor/${slug}`],
              },
            ],
          },
          null,
          2,
        ),
      ),
    },
    { name: videoMaterialPathOf(slug), data: v.bytes },
  ];
}

export type RecordOptions = {
  width: number;
  height: number;
  fps: number;
  duration: number;
  /** 把场景画到 t 秒，并返回可绘制的画面（画布或位图） */
  frameAt: (t: number) => Promise<CanvasImageSource>;
  onProgress?: (p: number) => void;
  signal?: AbortSignal;
};

export type RecordResult = { blob: Blob; ext: "mp4" | "webm"; frames: number };

/** 逐帧录制：H.264 mp4 优先，浏览器不支持 H.264 编码时回退 VP9 webm */
export async function recordVideo(o: RecordOptions): Promise<RecordResult> {
  const width = Math.max(2, Math.round(o.width / 2) * 2);
  const height = Math.max(2, Math.round(o.height / 2) * 2);
  const mp4 = await canEncodeVideo("avc", { width, height });
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d")!;
  const target = new BufferTarget();
  const output = new Output({
    format: mp4 ? new Mp4OutputFormat({ fastStart: "in-memory" }) : new WebMOutputFormat(),
    target,
  });
  const source = new CanvasSource(canvas, { codec: mp4 ? "avc" : "vp9", bitrate: QUALITY_HIGH });
  output.addVideoTrack(source, { frameRate: o.fps });
  await output.start();
  const frames = Math.max(1, Math.round(o.duration * o.fps));
  const dt = 1 / o.fps;
  try {
    for (let i = 0; i < frames; i++) {
      if (o.signal?.aborted) throw new ConversionCanceledError();
      const img = await o.frameAt(i * dt);
      ctx.drawImage(img, 0, 0, width, height);
      if (typeof ImageBitmap !== "undefined" && img instanceof ImageBitmap) img.close();
      await source.add(i * dt, dt);
      o.onProgress?.((i + 1) / frames);
    }
    await output.finalize();
  } catch (e) {
    await output.cancel().catch(() => {});
    throw e;
  }
  return {
    blob: new Blob([target.buffer!], { type: mp4 ? "video/mp4" : "video/webm" }),
    ext: mp4 ? "mp4" : "webm",
    frames,
  };
}
