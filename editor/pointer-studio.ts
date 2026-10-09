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
 * 轨迹是**编辑器本机资产**：命名后存在内存里，localStorage（键 POINTER_TRACKS_KEY）只作兜底，
 * 不进工程文件、不进保存清单。序列化形状 {v,name,duration,points:[{t,x,y}]} 是自洽的，
 * 反序列化严格校验（坏数据当没有），可以整条搬走 / 手工塞回去。
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

/** 宽容取数：缺值、null、空串（数值框清空 / JSON 里写 null）都算「没有」，别让 Number() 把它们变成 0 */
const num = (v: unknown): number => (v == null || v === "" ? NaN : Number(v));

/** 5 位小数（和关键帧同口径），-0 归零：序列化往返才稳定 */
export function r5(v: number): number {
  const r = Math.round(v * 1e5) / 1e5;
  return r === 0 ? 0 : r;
}

/**
 * 边界钳制：指针坐标是归一化的 [0,1]，非有限值一律当没有（`NaN` 进了 uniform 会毁掉整帧）。
 * 拖到视口外面（letterbox 区域）会得到 <0 或 >1，钳到边上而不是丢弃。
 * 空字符串 / null（数值框清空、JSON 里写成 null）也当没有：`Number("")` 是 0，那是假坐标。
 */
export function clampPoint(x: unknown, y: unknown): { x: number; y: number } | null {
  const nx = num(x);
  const ny = num(y);
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) return null;
  return { x: r5(nx < 0 ? 0 : nx > 1 ? 1 : nx), y: r5(ny < 0 ? 0 : ny > 1 ? 1 : ny) };
}

/**
 * 把任意来源的点序列洗成可回放的形状：丢非有限值、钳制、t 取整、按 t 升序、
 * 同一毫秒只留最后一个（一帧里可能来好几个事件）、再把 t 归零到首个采样点。
 */
export function normalizePoints(points: ReadonlyArray<unknown>): PointerPoint[] {
  const out: PointerPoint[] = [];
  for (const raw of points) {
    if (!isObj(raw)) continue;
    const c = clampPoint(raw.x, raw.y);
    const t = num(raw.t);
    if (!c || !Number.isFinite(t)) continue;
    out.push({ t: Math.max(0, Math.round(t)), x: c.x, y: c.y });
  }
  out.sort((a, b) => a.t - b.t);
  const dedup: PointerPoint[] = [];
  for (const p of out) {
    const last = dedup[dedup.length - 1];
    if (last && last.t === p.t) dedup[dedup.length - 1] = p;
    else dedup.push(p);
  }
  const t0 = dedup.length ? dedup[0].t : 0;
  return dedup.map((p) => ({ t: p.t - t0, x: p.x, y: p.y }));
}

/** 轨迹时长 = 末点时间（毫秒）；空轨迹 0 */
export const trackDuration = (points: ReadonlyArray<PointerPoint>): number =>
  points.length ? points[points.length - 1].t : 0;

/**
 * 按时间轴取样：二分找到 t 落在哪两点之间再线性插值。
 * 回放要的是「任意时刻都能问出指针在哪」，所以早于首点钉首点、晚于末点钉末点（不外推），空轨迹 null。
 */
export function sampleTrack(points: ReadonlyArray<PointerPoint>, tMs: unknown): PointerPoint | null {
  const t = num(tMs);
  if (!points.length || !Number.isFinite(t)) return null;
  const first = points[0];
  const last = points[points.length - 1];
  if (t <= first.t) return { ...first };
  if (t >= last.t) return { ...last };
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = points[lo];
  const b = points[hi];
  const span = b.t - a.t;
  const k = span > 0 ? (t - a.t) / span : 0;
  return { t: r5(t), x: r5(a.x + (b.x - a.x) * k), y: r5(a.y + (b.y - a.y) * k) };
}

/** 点数超上限时等距抽稀（首尾必留）：localStorage 兜底不能塞爆 */
function decimate(points: PointerPoint[], max: number): PointerPoint[] {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  const out: PointerPoint[] = [];
  for (let i = 0; i < max; i++) out.push(points[Math.min(points.length - 1, Math.round(i * step))]);
  return out;
}

/** 攒一条轨迹：空点集 → null；duration 由点集重算，不信调用方传进来的 */
export function makeTrack(name: unknown, points: ReadonlyArray<unknown>): PointerTrack | null {
  const pts = decimate(normalizePoints(points), MAX_TRACK_POINTS);
  if (!pts.length) return null;
  const label = typeof name === "string" && name.trim() ? name.trim() : "pointer";
  return { v: POINTER_STUDIO_VERSION, name: label, duration: trackDuration(pts), points: pts };
}

export function serializeTrack(track: PointerTrack): string {
  return JSON.stringify({ v: POINTER_STUDIO_VERSION, name: track.name, duration: track.duration, points: track.points });
}

/** 严格解析：不可信输入一律当没有（草案 / localStorage 都可能被手改） */
export function parseTrack(raw: unknown): PointerTrack | null {
  let obj: unknown = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isObj(obj) || obj.v !== POINTER_STUDIO_VERSION) return null;
  if (typeof obj.name !== "string" || !obj.name.trim() || !Array.isArray(obj.points)) return null;
  const pts = decimate(normalizePoints(obj.points), MAX_TRACK_POINTS);
  if (!pts.length) return null;
  return { v: POINTER_STUDIO_VERSION, name: obj.name, duration: trackDuration(pts), points: pts };
}

export function serializeTracks(tracks: ReadonlyArray<PointerTrack>): string {
  return JSON.stringify({ v: POINTER_STUDIO_VERSION, tracks });
}

/** 逐条解析，坏的丢一条不影响其它（用户手改过 localStorage 也要能起来） */
export function parseTracks(raw: unknown): PointerTrack[] {
  let obj: unknown = raw;
  if (typeof raw === "string") {
    if (!raw.trim()) return [];
    try {
      obj = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!isObj(obj) || obj.v !== POINTER_STUDIO_VERSION || !Array.isArray(obj.tracks)) return [];
  const out: PointerTrack[] = [];
  for (const one of obj.tracks) {
    const track = parseTrack(one);
    if (track) out.push(track);
  }
  return out;
}

export function loadTracks(storage?: StorageLike | null): PointerTrack[] {
  if (!storage) return [];
  try {
    return parseTracks(storage.getItem(POINTER_TRACKS_KEY));
  } catch {
    return [];
  }
}

/** 写回兜底存储；配额满 / 隐私模式都只返回 false，不掉链子 */
export function storeTracks(storage: StorageLike | null | undefined, tracks: ReadonlyArray<PointerTrack>): boolean {
  if (!storage) return false;
  try {
    storage.setItem(POINTER_TRACKS_KEY, serializeTracks(tracks));
    return true;
  } catch {
    return false;
  }
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
  /** 已命名轨迹（内存真源；storage 只是兜底） */
  let tracks: PointerTrack[] = loadTracks(deps.storage);
  /** 选择器选中的轨迹名 */
  let activeName: string | null = tracks.length ? tracks[0].name : null;
  /** 录制会话：起点时钟 + 已采点 */
  let rec: { startedAt: number; points: PointerPoint[] } | null = null;
  /** 录制前在名字框里填的名字（空则用默认名） */
  let recName = "";

  function pushAt(p: { x: number; y: number }, buttons = 0) {
    lastPos = { ...p };
    deps.push(p.x, p.y, buttons);
    return { ...p };
  }

  /**
   * 摆位：把指针放到指定归一化坐标并驱动引擎。
   * 未暂停时拒绝（force 例外）——播放中场景每帧都会把 uniform 采样走，摆了也看不见。
   * 手动摆位优先于回放：摆了就停回放，否则下一帧又会被轨迹覆盖。
   */
  function place(x: unknown, y: unknown, opts: { force?: boolean; buttons?: number } = {}) {
    if (!opts.force && !deps.isPaused()) {
      say("log.ptrNeedPause", undefined, "warn");
      return null;
    }
    const p = clampPoint(x, y);
    if (!p) return null;
    if (replay) stopReplay();
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
    const p = replay ? replaySample() : parked ?? lastPos;
    if (!p) return null;
    return pushAt(p);
  }

  // ---------- 轨迹录制 ----------

  function persist() {
    storeTracks(deps.storage, tracks);
  }

  /** 名字是选择器的键（按名选中 / 按名删除），重名会指不清，所以撞了就加序号 */
  function uniqueName(name: string): string {
    if (!tracks.some((t) => t.name === name)) return name;
    let n = 2;
    while (tracks.some((t) => t.name === `${name} ${n}`)) n++;
    return `${name} ${n}`;
  }

  function defaultName(): string {
    let n = tracks.length + 1;
    const make = (i: number) => deps.t?.("ptr.defaultName", { n: i }) ?? `pointer ${i}`;
    while (tracks.some((t) => t.name === make(n))) n++;
    return make(n);
  }

  /** 开始录：时间戳从 deps.now() 起算，采到的点是相对起点的毫秒数 */
  function startRecord(name = ""): boolean {
    if (rec) return false;
    // 一根指针不能同时被回放和录制驱动
    if (replay) stopReplay();
    rec = { startedAt: deps.now(), points: [] };
    recName = typeof name === "string" ? name.trim() : "";
    return true;
  }

  /** 采一个点（录制中才收）；返回落库的那一点 */
  function record(x: unknown, y: unknown): PointerPoint | null {
    if (!rec) return null;
    const c = clampPoint(x, y);
    if (!c) return null;
    if (rec.points.length >= MAX_TRACK_POINTS) return null;
    const p: PointerPoint = { t: Math.max(0, Math.round(deps.now() - rec.startedAt)), x: c.x, y: c.y };
    rec.points.push(p);
    return { ...p };
  }

  /** 收工：成一条命名轨迹并落到内存 + localStorage 兜底；没采到点就什么也不做 */
  function stopRecord(): PointerTrack | null {
    const r = rec;
    const wanted = recName;
    rec = null;
    recName = "";
    if (!r) return null;
    const track = makeTrack(uniqueName(wanted || defaultName()), r.points);
    if (!track) {
      say("log.ptrNoPoints", undefined, "warn");
      return null;
    }
    tracks = [...tracks, track];
    activeName = track.name;
    persist();
    say("log.ptrRecorded", { name: track.name, n: track.points.length, dur: (track.duration / 1000).toFixed(2) });
    return track;
  }

  function cancelRecord() {
    rec = null;
    recName = "";
  }

  // ---------- 轨迹回放 ----------

  /** 正在回放的轨迹名；null = 没在回放 */
  let replay: { name: string } | null = null;
  /** 最近一次回放取到的采样点（UI 显示播放到哪儿） */
  let replayPos: PointerPoint | null = null;

  /**
   * 回放时间 = 播放头折回轨迹长度。场景在循环，轨迹也跟着循环：
   * 播放头拖到哪儿，指针就在轨迹的对应位置，停帧下拖时间轴也一样成立。
   */
  function replayTime(track: PointerTrack): number {
    const dur = track.duration;
    if (!(dur > 0)) return 0;
    const t = deps.clock() % dur;
    return t < 0 ? t + dur : t;
  }

  function replaySample(): PointerPoint | null {
    const track = tracks.find((t) => t.name === replay?.name);
    return track ? sampleTrack(track.points, replayTime(track)) : null;
  }

  /** 开始回放：立刻按当前播放头摆一次，之后交给 tick() */
  function startReplay(name?: unknown): boolean {
    if (typeof name === "string" && name) select(name);
    const track = tracks.find((t) => t.name === activeName);
    if (!track) return false;
    // 录制与回放抢同一根指针，正在录就先收工（已采的点照常存成一条轨迹）
    if (rec) stopRecord();
    replay = { name: track.name };
    const p = replaySample();
    if (p) pushAt(p);
    say("log.ptrReplay", { name: track.name, dur: (track.duration / 1000).toFixed(2) });
    return true;
  }

  function stopReplay(): boolean {
    if (!replay) return false;
    const name = replay.name;
    replay = null;
    replayPos = null;
    say("log.ptrReplayStop", { name });
    return true;
  }

  /** 每帧调用（时间轴 tick）：回放中按播放头取样并驱动 uniform */
  function tick(): PointerPoint | null {
    if (!replay) return null;
    const p = replaySample();
    replayPos = p;
    if (p) pushAt(p);
    return p;
  }

  function select(name: unknown): string | null {
    const n = String(name ?? "");
    if (tracks.some((t) => t.name === n)) activeName = n;
    else if (!tracks.some((t) => t.name === activeName)) activeName = tracks.length ? tracks[0].name : null;
    // 回放跟着选中项走：换一条轨迹接着放，不用先停再开
    if (replay && activeName) replay.name = activeName;
    return activeName;
  }

  function activeTrack(): PointerTrack | null {
    return tracks.find((t) => t.name === activeName) ?? null;
  }

  function remove(name?: unknown): boolean {
    const target = typeof name === "string" && name ? name : activeName;
    const gone = tracks.find((t) => t.name === target);
    if (!gone) return false;
    // 删的正是回放中那条：先停回放，别继续驱动一根没有轨迹的指针
    if (replay && replay.name === gone.name) stopReplay();
    tracks = tracks.filter((t) => t !== gone);
    activeName = tracks.length ? tracks[0].name : null;
    persist();
    say("log.ptrRemoved", { name: gone.name });
    return true;
  }

  const cloneTrack = (t: PointerTrack): PointerTrack => structuredClone(t);

  return {
    place,
    release,
    resync,
    parkedPoint: () => (parked ? { ...parked } : null),
    lastSample: () => (lastPos ? { ...lastPos } : null),
    // 轨迹录制
    startRecord,
    record,
    stopRecord,
    cancelRecord,
    recording: () => !!rec,
    recordingPoints: () => (rec ? rec.points.length : 0),
    list: () => tracks.map(cloneTrack),
    select,
    activeName: () => activeName,
    activeTrack: () => {
      const t = activeTrack();
      return t ? cloneTrack(t) : null;
    },
    remove,
    // 轨迹回放
    startReplay,
    stopReplay,
    replaying: () => !!replay,
    replayName: () => (replay ? replay.name : null),
    replayAt: () => (replayPos ? { ...replayPos } : null),
    tick,
  };
}

export type PointerStudio = ReturnType<typeof createPointerStudio>;
