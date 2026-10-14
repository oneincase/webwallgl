// 声音层：导入音频成层与检视器字段读写。对象与 WE 编辑器新建的声音对象同形
// （语料 444 个声音对象都写全 sound / playbackmode / volume / startsilent / mintime /
// maxtime / muteineditor）。音频原字节写进 sounds/<slug>.<ext>，按引用进出保存清单。
// volume 常被 `{ user, value }` 包装（音量滑条，语料约一半），写入时只改 value。
//
// 播放参数（A13）：maxtime / mintime / spatialization / muteineditor 的读点是
// renderer/vendor/we-scene/scene/parse.js:486-489（soundprops.maxtime / mintime = parseNum 缺省 0、
// spatialization / muteineditor = parseBool 缺省 false）。这四个字段本机引擎只解析、渲染侧还没接
// （音频路径 scene-mount.ts:3849-3850 / 3906 目前只消费 playbackmode / volume / startsilent），
// 所以它们在编辑器里的作用 = 读写保真、不丢作者数据，不改播放行为。
export const MAX_SOUND_TIME = 3600;

import { nextObjectId, rebuildTree, unwrap, type EditorDoc, type SceneObject } from "./doc";

export const AUDIO_FILE_RE = /\.(mp3|ogg|wav|flac)$/i;

/** 引擎按扩展名取 mime，只认这四种 */
export function isAudioFile(f: { name: string }): boolean {
  return AUDIO_FILE_RE.test(f.name);
}

/** 导入音频的工程内路径 sounds/<slug>.<ext>；taken 判重后加 -2、-3… */
export function soundPathOf(fileName: string, taken: (path: string) => boolean): string | null {
  const m = AUDIO_FILE_RE.exec(fileName);
  if (!m) return null;
  const ext = m[1].toLowerCase();
  const base =
    (fileName.replace(/\\/g, "/").split("/").pop() ?? "")
      .replace(AUDIO_FILE_RE, "")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "sound";
  const at = (s: string) => `sounds/${s}.${ext}`;
  if (!taken(at(base))) return at(base);
  for (let i = 2; ; i++) if (!taken(at(`${base}-${i}`))) return at(`${base}-${i}`);
}

export const isSoundObject = (o: SceneObject) => Array.isArray(o.sound) && o.sound.length > 0;

/** 新声音层追加到对象数组末尾（声音层不画，位置无关）。返回新 id */
export function addSoundLayer(doc: EditorDoc, name: string, path: string): number | null {
  const scene = doc.scene;
  if (!scene || !AUDIO_FILE_RE.test(path)) return null;
  if (!Array.isArray(scene.objects)) scene.objects = [];
  const objs = scene.objects as SceneObject[];
  const id = nextObjectId(objs);
  objs.push({
    id,
    maxtime: 5,
    mintime: 1,
    muteineditor: false,
    name,
    playbackmode: "loop",
    sound: [path],
    startsilent: false,
    volume: 1,
  });
  rebuildTree(doc);
  return id;
}

/** 文档对象当前引用的音频文件（资源表据此决定导入的音频是否进保存清单） */
export function referencedSounds(doc: EditorDoc | null): Set<string> {
  const out = new Set<string>();
  const objs = doc?.scene?.objects;
  if (!Array.isArray(objs)) return out;
  for (const o of objs as SceneObject[]) {
    if (!o || !Array.isArray(o.sound)) continue;
    for (const s of o.sound) if (typeof s === "string" && s) out.add(s);
  }
  return out;
}

/**
 * loop = 循环；single = 播一次；random = 在列表里随机挑、间隔 mintime..maxtime 秒再播
 * （引擎目前按「只播第一首、不循环」处理 random）。
 */
export const PLAYBACK_MODES = ["loop", "single", "random"] as const;
export type PlaybackMode = (typeof PLAYBACK_MODES)[number];

export type SoundFields = {
  files: string[];
  playbackmode: PlaybackMode;
  volume: number;
  startsilent: boolean;
  /** random 模式两次播放的最长间隔（秒）；引擎缺省 0 */
  maxtime: number;
  /** random 模式两次播放的最短间隔（秒）；引擎缺省 0 */
  mintime: number;
  spatialization: boolean;
  muteineditor: boolean;
};

/** 引擎 parseBool 的读法（布尔 / "true" / 1 都算真） */
const asBool = (v: unknown) => v === true || v === "true" || v === 1;

/** 大小写不敏感找已存在的真实键名（与 editor/objprops.ts 铁律 1 同口径） */
function realKey(obj: SceneObject, key: string): string {
  const want = key.toLowerCase();
  for (const k of Object.keys(obj)) if (k.toLowerCase() === want) return k;
  return key;
}

/** 按铁律 1 读一个字段（包装解出 .value） */
const readField = (obj: SceneObject, key: string) => unwrap(obj[realKey(obj, key)]);

export function getSoundFields(obj: SceneObject): SoundFields {
  const mode = readField(obj, "playbackmode");
  const vol = Number(readField(obj, "volume"));
  const ss = readField(obj, "startsilent");
  const maxT = Number(readField(obj, "maxtime"));
  const minT = Number(readField(obj, "mintime"));
  return {
    files: Array.isArray(obj.sound) ? (obj.sound as unknown[]).filter((s): s is string => typeof s === "string") : [],
    playbackmode: (PLAYBACK_MODES as readonly unknown[]).includes(mode) ? (mode as PlaybackMode) : "single",
    volume: Number.isFinite(vol) ? vol : 1,
    startsilent: asBool(ss),
    // 播放参数缺省 = 引擎缺省（parse.js:486-489）：0 / 0 / false / false
    maxtime: Number.isFinite(maxT) && maxT >= 0 ? maxT : 0,
    mintime: Number.isFinite(minT) && minT >= 0 ? minT : 0,
    spatialization: asBool(readField(obj, "spatialization")),
    muteineditor: asBool(readField(obj, "muteineditor")),
  };
}

type Wrapped = Record<string, unknown> & { value?: unknown };
const isWrapped = (v: unknown): v is Wrapped => !!v && typeof v === "object" && !Array.isArray(v);

function writeField(obj: SceneObject, key: string, v: unknown): boolean {
  const k = realKey(obj, key);
  const cur = obj[k];
  if (isWrapped(cur) && ("value" in cur || "user" in cur || "script" in cur)) {
    if (cur.value === v) return false;
    cur.value = v;
    return true;
  }
  if (cur === v) return false;
  obj[k] = v;
  return true;
}

export type SoundField = "playbackmode" | "volume" | "startsilent" | "maxtime" | "mintime" | "spatialization" | "muteineditor";

/** 检视器写值：不是声音层 / 校验不过 / 没变返回 false */
export function setSoundField<K extends SoundField>(obj: SceneObject, field: K, value: SoundFields[K]): boolean {
  if (!isSoundObject(obj)) return false;
  switch (field) {
    case "playbackmode":
      return (PLAYBACK_MODES as readonly unknown[]).includes(value) && writeField(obj, field, value);
    case "volume": {
      const n = Number(value);
      if (typeof value !== "number" || !Number.isFinite(n) || n < 0 || n > 1) return false;
      return writeField(obj, field, Math.round(n * 1000) / 1000);
    }
    case "startsilent":
      return typeof value === "boolean" && writeField(obj, field, value);
    case "maxtime": {
      const n = Number(value);
      return Number.isFinite(n) && n >= 0 && n <= MAX_SOUND_TIME && writeField(obj, "maxtime", Math.round(n * 1000) / 1000);
    }
    case "mintime": {
      const n = Number(value);
      return Number.isFinite(n) && n >= 0 && n <= MAX_SOUND_TIME && writeField(obj, "mintime", Math.round(n * 1000) / 1000);
    }
    case "spatialization":
      return typeof value === "boolean" && writeField(obj, "spatialization", value);
    case "muteineditor":
      return typeof value === "boolean" && writeField(obj, "muteineditor", value);
  }
  return false;
}

/** 换第一首音频（引擎每层只播第一首）；其余列表项保留 */
export function replaceSoundFile(obj: SceneObject, path: string): boolean {
  if (!isSoundObject(obj) || !AUDIO_FILE_RE.test(path)) return false;
  const list = obj.sound as unknown[];
  if (list[0] === path) return false;
  list[0] = path;
  return true;
}

export function soundLabel(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() ?? path;
}
