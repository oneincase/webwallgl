// 相机路径（M12 / B7）的编辑器侧读写面：clip 队列 + `queuemode`。
//
// 定位：**只读校验 + 队列读写**，不复制引擎的时钟语义。所有 tick / 曲线求值都转发给
// `renderer/vendor/we-scene/render/camera-path.js`（那份已按 open-wallpaper-engine 的
// `SceneCameraPath::TickQueue` 逐条对齐），这样「编辑器面板里看到的运镜」与「运行时
// 播出来的运镜」是同一条代码路径，不存在第二套时钟。本模块自己只做三件事：
//
//   1. **形态判定**：对象级（`{paths:[{options, eye:{c0…}}]}`）与场景级
//      （`{paths:[{duration, transforms:[{eye,timestamp}]}]}`）是两种文件格式。
//      喂错解析器不抛错、只静默拿到 0 段（相机一动不动）——这是最容易漏的一类回归，
//      所以要给出**明确结论**而不是靠 `paths.length` 猜；
//   2. **体检报告**：零时长段 / 没有 eye或center / fov 与 zoom 都缺，逐段列成 issues，
//      供编辑器在检视器里直接提示「这条路径放不出运镜」；
//   3. **队列读写**：`queuemode` 的读改写（写回默认值时就删键，别在 scene.json 里留冗余）
//      与 clip 的重排 / 删除（都作用在文档上，不碰引擎）。
//
// 采样口径：`sampleCameraPath` 是**顺序驱动**的（队列按时钟推进），`times` 必须递增；
// 场景级路径是纯函数式求值（只依赖 t），递增只是为了两种形态共用同一个入口。
//
// 无 DOM、无副作用；除引擎那份 vendor 模块外不依赖任何东西（离线判据可直接驱动）。
import type {
  CameraFovZoom,
  CameraPathClipInfo,
  CameraPathKind,
  CameraPathPose,
  CameraPathReport,
  CameraQueueMode,
} from "../api/types";
import { createCameraPath, createSceneCameraPath } from "../../vendor/we-scene/render/camera-path.js";

/** 队列模式：只认这两个字面量，其余（含 undefined）落到默认值 */
export function normalizeQueueMode(v: unknown, dflt: CameraQueueMode = "sequential"): CameraQueueMode {
  if (v === "random" || v === "sequential") return v;
  return dflt;
}

/** 取路径文档里的段数组（文档可能是数组本身，也可能是 `{paths:[…]}`）；形态不对返回 null */
function pathListOf(doc: unknown): unknown[] | null {
  if (Array.isArray(doc)) return doc;
  const paths = doc && typeof doc === "object" ? (doc as { paths?: unknown }).paths : undefined;
  return Array.isArray(paths) ? paths : null;
}

/**
 * 判定路径文档的形态。**空文档返回 `"unknown"`**：`{"paths":[]}` 两种格式都解释得通，
 * 给一个假结论会让调用方按错的分支去提示。
 */
export function kindOfCameraPathDoc(doc: unknown): CameraPathKind {
  const list = pathListOf(doc);
  if (!list || list.length === 0) return "unknown";
  for (const p of list) {
    if (!p || typeof p !== "object") continue;
    const e = p as Record<string, unknown>;
    // 场景级独有：duration 与 transforms（对象级的关键帧写在 eye/center/up 的 c0..c2 里）
    if (Array.isArray(e.transforms) || typeof e.duration !== "undefined") return "scene";
    if (e.options !== undefined || "eye" in e || "center" in e || "up" in e || "fov" in e || "zoom" in e) {
      return "object";
    }
  }
  return "unknown";
}

// ---- 引擎那份模块只给 JSDoc，这里用最小结构面接住（不写 as any） ----
type QueuePose = {
  clipId: unknown;
  clipName: string;
  frame: number;
  eye: unknown;
  center: unknown;
  up: unknown;
  fov: number;
  zoom: number;
};
type QueueLike = {
  clips: Array<Record<string, unknown>>;
  index: number;
  reset(): void;
  tick(runtime?: number, basePose?: unknown): QueuePose | null;
};

const vec3 = (v: unknown, dflt: [number, number, number]): [number, number, number] => {
  const a = Array.isArray(v) ? v : null;
  if (a && a.length >= 3) {
    const out: [number, number, number] = [Number(a[0]) || 0, Number(a[1]) || 0, Number(a[2]) || 0];
    return out;
  }
  return [...dflt];
};
const num = (v: unknown, dflt: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
};

const CHANNELS = ["eye", "center", "up", "fov", "zoom"] as const;

/**
 * 逐段体检。`queueMode` 只影响报告里回显的模式，不影响段解析（引擎的选段是 tick 时才发生的）。
 * `issues` 非空说明这条路径**放不出运镜**或会静默跳过某些段。
 */
export function describeCameraPath(doc: unknown, queueMode?: unknown): CameraPathReport {
  const mode = normalizeQueueMode(queueMode, "sequential");
  const kind = kindOfCameraPathDoc(doc);
  const list = pathListOf(doc);
  const issues: string[] = [];
  const clips: CameraPathClipInfo[] = [];

  if (!list) {
    issues.push("不是相机路径文档：既不是数组，也没有 paths 数组");
    return { kind, clipCount: 0, totalDuration: 0, queueMode: mode, clips, issues };
  }
  if (list.length === 0) {
    issues.push("路径文档是空的（paths: []）—— 相机保持静态位姿");
    return { kind, clipCount: 0, totalDuration: 0, queueMode: mode, clips, issues };
  }

  if (kind === "scene") {
    const sp = createSceneCameraPath(doc as object) as unknown as {
      clips: Array<{ name: string; duration: number; keys: unknown[] }>;
      duration: number;
    };
    for (let i = 0; i < sp.clips.length; i++) {
      const c = sp.clips[i];
      clips.push({
        index: i,
        id: undefined,
        name: c.name,
        fps: 0,
        // 场景级没有 fps/length：段长就是秒，关键帧个数单独给出来（面板要显示「N 个关键帧」）
        length: c.keys.length,
        duration: c.duration,
        mode: "",
        cameramode: "",
        channels: ["eye", "center", "up"],
      });
    }
    if (clips.length === 0) {
      issues.push("场景级路径没有可用段：每段都要 duration>0，且至少一个 eye/center 齐备的关键帧");
    }
    return { kind, clipCount: clips.length, totalDuration: sp.duration, queueMode: mode, clips, issues };
  }

  if (kind === "object") {
    const q = createCameraPath(doc as object, mode) as unknown as QueueLike;
    let total = 0;
    for (let i = 0; i < q.clips.length; i++) {
      const c = q.clips[i];
      const fps = num(c.fps, 30);
      const length = num(c.length, 0);
      const duration = fps > 0 && length > 0 ? length / fps : 0;
      total += duration;
      const channels = CHANNELS.filter((k) => !!c[k]);
      clips.push({
        index: i,
        id: c.id,
        name: typeof c.name === "string" ? c.name : "",
        fps,
        length,
        duration,
        mode: typeof c.mode === "string" ? c.mode : "",
        cameramode: typeof c.cameramode === "string" ? c.cameramode : "",
        channels,
      });
      if (duration === 0) issues.push(`第 ${i} 段时长为 0（fps=${fps} length=${length}）—— 队列会立刻跳过它`);
      if (!channels.some((k) => k === "eye" || k === "center" || k === "up")) {
        issues.push(`第 ${i} 段没有 eye / center / up 任何一条通道 —— 位姿不会变`);
      }
      if (!channels.includes("fov") && !channels.includes("zoom")) {
        issues.push(`第 ${i} 段既没有 fov 也没有 zoom —— 透视与正交都拿不到相机参数`);
      }
    }
    if (clips.length === 0) {
      issues.push("对象级路径一段都没解析出来：options 缺失或通道不是 c0..c2 / 扁平关键帧数组");
    }
    return { kind, clipCount: clips.length, totalDuration: total, queueMode: mode, clips, issues };
  }

  issues.push("认不出路径文档形态：段里既没有 transforms/duration，也没有 eye/center/up/fov/zoom");
  return { kind, clipCount: 0, totalDuration: 0, queueMode: mode, clips, issues };
}

/** 场景级路径上「t 落在第几段」——引擎的 tick 只回位姿，不带下标，编辑器要显示段号 */
function sceneClipIndexAt(list: Array<{ duration: number }>, total: number, t: number): number {
  let rest = total > 0 ? ((t % total) + total) % total : 0;
  let i = 0;
  while (i < list.length - 1 && rest >= list[i].duration) {
    rest -= list[i].duration;
    i++;
  }
  return i;
}

/**
 * 顺序驱动队列并采样若干时刻的位姿（`times` 必须递增）。
 * 对象级走引擎的状态机 tick（所以第一个采样点就会「首次选段」）；
 * 场景级走纯函数 tick（同一 t 的位姿唯一）。没有可用段时返回的数组为空。
 */
export function sampleCameraPath(
  doc: unknown,
  queueMode: unknown,
  times: readonly number[],
  basePose?: { eye?: unknown; center?: unknown; up?: unknown; fov?: unknown; zoom?: unknown },
): CameraPathPose[] {
  const mode = normalizeQueueMode(queueMode, "sequential");
  const kind = kindOfCameraPathDoc(doc);
  const out: CameraPathPose[] = [];
  if (kind === "object") {
    const q = createCameraPath(doc as object, mode) as unknown as QueueLike;
    const base = {
      eye: vec3(basePose?.eye, [0, 0, 0]),
      center: vec3(basePose?.center, [0, 0, -1]),
      up: vec3(basePose?.up, [0, 1, 0]),
      fov: num(basePose?.fov, 50),
      zoom: num(basePose?.zoom, 1),
    };
    for (const t of times) {
      const p = q.tick(t, base);
      if (!p) continue;
      out.push({
        clipIndex: q.index,
        clipId: p.clipId,
        clipName: p.clipName,
        frame: p.frame,
        eye: vec3(p.eye, base.eye),
        center: vec3(p.center, base.center),
        up: vec3(p.up, base.up),
        fov: num(p.fov, base.fov),
        zoom: num(p.zoom, base.zoom),
      });
    }
    return out;
  }
  if (kind === "scene") {
    const sp = createSceneCameraPath(doc as object) as unknown as {
      clips: Array<{ name: string; duration: number }>;
      duration: number;
      tick(t: number): { eye: unknown; center: unknown; up: unknown; fov: number | null; zoom: number | null } | null;
    };
    for (const t of times) {
      const p = sp.tick(t);
      if (!p) continue;
      out.push({
        clipIndex: sceneClipIndexAt(sp.clips, sp.duration, t),
        clipId: undefined,
        clipName: sp.clips[sceneClipIndexAt(sp.clips, sp.duration, t)]?.name ?? "",
        frame: 0,
        eye: vec3(p.eye, [0, 0, 0]),
        center: vec3(p.center, [0, 0, -1]),
        up: vec3(p.up, [0, 1, 0]),
        fov: num(p.fov, 50),
        zoom: num(p.zoom, 1),
      });
    }
    return out;
  }
  return out;
}

/**
 * 透视用 `fov`、正交用 `zoom`（引擎把两者都求出来正是为了这个分支）。
 * 值缺失时回落引擎自己的缺省（fov 50 / zoom 1），与 `camera-path.js` 的 base 一致。
 */
export function resolveCameraFovZoom(
  pose: { fov?: unknown; zoom?: unknown } | null | undefined,
  perspective: boolean,
): CameraFovZoom {
  const fov = num(pose?.fov, 50);
  const zoom = num(pose?.zoom, 1);
  return perspective ? { use: "fov", value: fov, other: zoom } : { use: "zoom", value: zoom, other: fov };
}

/** 读场景对象上的 `queuemode`；字段缺失或非法一律回落 `"sequential"`（= 引擎的缺省行为） */
export function readQueueMode(obj: Record<string, unknown> | null | undefined): CameraQueueMode {
  return normalizeQueueMode(obj ? obj.queuemode : undefined, "sequential");
}

/**
 * 写场景对象上的 `queuemode`。写回 `baseline`（缺省 `"sequential"`，即引擎缺省值）时
 * **删键**而不是写一个冗余的 `"sequential"` —— 编辑器保存的 scene.json 不该为了「点过
 * 一次顺序」多出一个键。返回是否真的改动了文档。
 */
export function writeQueueMode(
  obj: Record<string, unknown> | null | undefined,
  mode: CameraQueueMode,
  baseline: CameraQueueMode = "sequential",
): boolean {
  if (!obj || (mode !== "random" && mode !== "sequential")) return false;
  const want = mode === baseline ? undefined : mode;
  const has = typeof obj.queuemode !== "undefined";
  if (!has && want === undefined) return false;
  if (has && obj.queuemode === want) return false;
  if (want === undefined) delete obj.queuemode;
  else obj.queuemode = want;
  return true;
}

/** 队列重排（`doc.paths` 内就地 splice）；下标非法或原地不动返回 false */
export function moveCameraPathClip(doc: unknown, from: number, to: number): boolean {
  const list = pathListOf(doc);
  if (!list) return false;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from >= list.length) return false;
  const at = Math.max(0, Math.min(to, list.length - 1));
  if (at === from) return false;
  const [clip] = list.splice(from, 1);
  list.splice(at, 0, clip);
  return true;
}

/** 队列里删一段（`doc.paths` 内就地 splice）；下标非法返回 false。删空后文档退化成空路径 */
export function removeCameraPathClip(doc: unknown, index: number): boolean {
  const list = pathListOf(doc);
  if (!list) return false;
  if (!Number.isInteger(index) || index < 0 || index >= list.length) return false;
  list.splice(index, 1);
  return true;
}
