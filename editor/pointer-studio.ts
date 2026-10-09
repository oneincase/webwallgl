/**
 * 指针工作室（EDITOR-COMPLETION-PLAN §2 B5 / §3 M11）：把引擎的指针通道接进编辑器。
 *
 * 引擎侧本来就有这条路：`renderer/vendor/we-scene/render/pointer.js` 的 `createPointerSource`
 * 是 `g_PointerPosition` 的唯一写入路径，`renderer/src/api/mount.ts` 把它暴露成
 * `SceneInstance.pushPointer` / `pointerLeave`。编辑器视口里移动鼠标也已经能驱动它，
 * 缺的是编辑器**主动驱动**：停帧摆位、录制轨迹、回放。这个模块补这一块。
 *
 * 一切驱动都经 deps.push（生产代码里就是 `instance.pushPointer`）：纯预览态，
 * 不写文档、不进撤销栈。播放中（时钟在走）的摆位会被场景每帧采样覆盖，所以 place 默认拒绝。
 *
 * 【导出边界】`scene.json` 没有指针字段（计划 §6 决策 3）：指针位置只活在引擎运行时 uniform
 * 与这里的内存 / localStorage 轨迹里。离线导出（scene.pkg / zip / 视频）**明确不带指针数据**，
 * 导出器不因为这个模块改行为。判据段 POINTER-STUDIO 断言导出产物里没有指针字段。
 */

/** localStorage 兜底键：轨迹是编辑器本机资产，不进工程文件 */
export const POINTER_TRACKS_KEY = "we-editor-pointer-tracks";

/** 轨迹 schema 版本，写进序列化产物，读的时候对不上就当没有 */
export const POINTER_STUDIO_VERSION = 1;

/** 单条轨迹点数上限：60Hz 录 30 分钟有 10 万点，localStorage 塞不下，超了按需抽稀 */
export const MAX_TRACK_POINTS = 20000;

/** 一个采样点：t = 相对录制起点的毫秒数，x / y 是归一化 [0,1]（原点左上、Y 朝下） */
export type PointerPoint = { t: number; x: number; y: number };

/** 一条命名轨迹；duration = 末点时间（毫秒），由 points 重算，不信外部传入 */
export type PointerTrack = { v: 1; name: string; duration: number; points: PointerPoint[] };

/** 只用到这三个方法，测试里塞假 storage 就不用整个 Storage */
export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** 5 位小数（和关键帧同口径），-0 归零：序列化往返才稳定 */
export function r5(v: number): number {
  const r = Math.round(v * 1e5) / 1e5;
  return r === 0 ? 0 : r;
}

/**
 * 边界钳制：指针坐标是归一化的 [0,1]，非有限值一律当没有（`NaN` 进了 uniform 会毁掉整帧）。
 * 拖到视口外面（letterbox 区域）会得到 <0 或 >1，钳到边上而不是丢弃。
 */
export function clampPoint(x: unknown, y: unknown): { x: number; y: number } | null {
  const nx = Number(x);
  const ny = Number(y);
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) return null;
  return { x: r5(nx < 0 ? 0 : nx > 1 ? 1 : nx), y: r5(ny < 0 ? 0 : ny > 1 ? 1 : ny) };
}

export type PointerStudioDeps = {
  /** 驱动引擎指针 uniform，生产代码 = `SceneInstance.pushPointer` */
  push(u: number, v: number, buttons?: number): void;
  /** 指针离开视口，生产代码 = `SceneInstance.pointerLeave` */
  leave(): void;
  /** 时间轴是否停着：摆位的「停帧」语义靠它把关 */
  isPaused(): boolean;
  /** 回放时钟（毫秒）：生产代码 = 时间轴播放头 */
  clock(): number;
  /** 录制打点用的单调时钟（毫秒）：生产代码 = `performance.now()` */
  now(): number;
  log?(msg: string, level: "info" | "warn" | "error"): void;
  t?(key: string, params?: Record<string, string | number>): string;
  storage?: StorageLike | null;
};

export function createPointerStudio(deps: PointerStudioDeps) {
  const say = (key: string, params?: Record<string, string | number>, level: "info" | "warn" = "info") => {
    deps.log?.(deps.t ? deps.t(key, params) : key, level);
  };

  /** 停帧摆位的落点；null = 没摆过 */
  let parked: { x: number; y: number } | null = null;
  /** 最近一次驱动出去的坐标：重挂后补推用 */
  let lastPos: { x: number; y: number } | null = null;

  function pushAt(p: { x: number; y: number }, buttons = 0) {
    lastPos = { ...p };
    deps.push(p.x, p.y, buttons);
    return { ...p };
  }

  /**
   * 摆位：把指针放到指定归一化坐标并驱动引擎。
   * 未暂停时拒绝（force 例外）——播放中场景每帧都会把 uniform 采样走，摆了也看不见。
   */
  function place(x: unknown, y: unknown, opts: { force?: boolean; buttons?: number } = {}) {
    if (!opts.force && !deps.isPaused()) {
      say("log.ptrNeedPause", undefined, "warn");
      return null;
    }
    const p = clampPoint(x, y);
    if (!p) return null;
    parked = p;
    return pushAt(p, opts.buttons ?? 0);
  }

  /** 放开指针：交回引擎自己的鼠标通道（= 离开视口） */
  function release() {
    parked = null;
    lastPos = null;
    deps.leave();
  }

  /** 场景重挂（改 DPR / 结构编辑 / 换分辨率）后补推一次：新实例的 uniform 是 0 */
  function resync() {
    const p = parked ?? lastPos;
    if (!p) return null;
    return pushAt(p);
  }

  return {
    place,
    release,
    resync,
    parkedPoint: () => (parked ? { ...parked } : null),
    lastSample: () => (lastPos ? { ...lastPos } : null),
  };
}

export type PointerStudio = ReturnType<typeof createPointerStudio>;
