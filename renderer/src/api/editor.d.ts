// WebWallGL 编辑器包类型入口（随 dist 发布为 dist/lib/editor.d.ts）。
//
// 编辑器包是播放包的超集（docs/EDITOR-PLAN.md §0.5）：先全量 re-export 播放包
// 公共类型，再追加编辑器专属声明。导出清单与 api/editor.ts 保持同步（verify-arch
// 机器比对）；类型本体只能来自 ./types。
import type {
  SceneInstance,
  EditorControls,
  EditorLayer,
  EditorLayerKind,
  EditorLayerAddSpec,
  EditorHotAddCheck,
  EditorOverlayMode,
  EditorOverlayStats,
  CameraQueueMode,
  CameraPathKind,
  CameraPathClipInfo,
  CameraPathReport,
  CameraPathPose,
  CameraFovZoom,
  EditorCaptureOptions,
  EditorFrameOptions,
  EditorHitTestOptions,
  EditorLayerProps,
  EditorLayerOutline,
  EditorModelInfo,
  EditorAttachmentPoint,
  EditorBonePose,
  EditorBonePoint,
  MdlBoneDelta,
  MdlClip,
  MdlClipInit,
  MdlPart,
  MdlSpec,
  EditorScriptIssue,
  EditorUserPropertyDecl,
  SceneScriptCheck,
  ScenePkgFile,
  ScenePkgResult,
  WeCompatIssue,
  WeCompatReport,
} from "./types";

export * from "./webwallgl";
export type {
  ScenePkgFile,
  ScenePkgResult,
  WeCompatIssue,
  WeCompatReport,
  EditorScriptIssue,
  EditorUserPropertyDecl,
  SceneScriptCheck,
  EditorControls,
  EditorLayer,
  EditorLayerKind,
  EditorLayerAddSpec,
  EditorHotAddCheck,
  EditorOverlayMode,
  EditorOverlayStats,
  CameraQueueMode,
  CameraPathKind,
  CameraPathClipInfo,
  CameraPathReport,
  CameraPathPose,
  CameraFovZoom,
  EditorCaptureOptions,
  EditorFrameOptions,
  EditorHitTestOptions,
  EditorLayerProps,
  EditorLayerOutline,
  EditorModelInfo,
  EditorAttachmentPoint,
  EditorBonePose,
  EditorBonePoint,
  MdlBoneDelta,
  MdlClip,
  MdlClipInit,
  MdlPart,
  MdlSpec,
};

/**
 * 取实例的编辑器控制面（时钟 / 出图 / 拾取 / 活层 / 热改）。只有场景壁纸有；
 * 网页、视频壁纸，或场景尚未装配完成时返回 null。
 */
export declare function editorOf(instance: SceneInstance): EditorControls | null;

/**
 * SceneScript 语法预检：与引擎沙箱同一 transform、同为严格模式，只编译不执行。
 * 给出出错行与可派发入口；noEntry 表示引擎会丢弃这段脚本。
 */
export declare function checkSceneScript(script: string): SceneScriptCheck;

/**
 * 保存清单打成 WE 原生 scene.pkg（PKGV0012）。materials 下没有同名 .tex 的
 * png/jpg 原字节包成 .tex（官方 WE 只认 .tex），源图不进包；其余文件原样入包。
 * project.json / 封面应留在包外，由调用方剔除。
 */
export declare function buildScenePkg(files: readonly ScenePkgFile[]): ScenePkgResult;

/**
 * WE 兼容性回读：用引擎自己的解析器（parsePkg / parseScene / resolveEffectChain）把导出产物
 * 再读一遍，逐项检查 project.json、入口场景、各对象引用的文件、效果链与 shader 的 uniform 注释。
 * files 可以是散装清单，也可以含 scene.pkg（包内条目一并可查）。
 */
export declare function checkWeCompat(files: readonly ScenePkgFile[]): Promise<WeCompatReport>;

/** 从零编码 MDLV0023（W19 glTF 导入）；spec 不合法时抛错（消息说明哪一项） */
export declare function encodeMdl(spec: MdlSpec): Uint8Array;

/**
 * .mdl 各子网格的槽 0 材质 json 路径（非 UTF-8 的串为 null）。
 * 网格表无法结构化读出（极旧 / 损坏文件）时返回 null。
 */
export declare function mdlMeshMaterials(bytes: Uint8Array): Array<string | null> | null;

/**
 * 把第 meshIndex 个子网格的槽 0 材质改指向 materialPath，返回新 .mdl 字节；
 * 其余字节（顶点 / 索引 / 骨骼 / 动画）不变。越界或无法结构化读出时返回 null。
 */
export declare function retargetMdlMaterial(bytes: Uint8Array, meshIndex: number, materialPath: string): Uint8Array | null;

/** .mdl 的动画片段表（无动画段给 []）；网格表无法结构化读出时返回 null */
export declare function mdlClips(bytes: Uint8Array): MdlClip[] | null;

/**
 * 关键帧影响权重（逐帧）：radius < 0 整段 1；0 只有该帧；否则余弦衰减、距离 > radius 为 0。
 * loop 片段按周期 frames − 1 计距离（末帧与首帧重合）
 */
export declare function boneDeltaWeights(frames: number, frame: number, radius: number, loop: boolean): Float64Array;

/**
 * 片段 animId 中骨 bone 的轨道在 frame 处叠局部 TRS 增量（平移 / 欧拉角相加、缩放相乘），按 radius 向两侧衰减，
 * 返回新 .mdl 字节（其余轨道 / 网格逐字节不变；loop 首末帧重合关系保持）。片段 / 轨道 / 帧不存在时返回 null
 */
export declare function applyBoneDelta(
  bytes: Uint8Array,
  animId: number,
  bone: number,
  frame: number,
  delta: MdlBoneDelta,
  radius: number,
): Uint8Array | null;

/** 片段播放模式（W18b） */
export declare const CLIP_MODES: readonly ["loop", "mirror", "single"];

/** 轨道（每帧 9 个 f32）按归一化时间线性重采样到 m 帧，欧拉角走最短方向 */
export declare function resampleTrack(data: Float32Array, m: number): Float32Array;

/**
 * 追加片段（W18b）：pose = "copy" 复制参照片段 source（缺省首个）的轨道并按帧数重采样；"rest" 每帧填参照片段第 0 帧。
 * 新 id = 现有最大 id + 1。没有可编辑动画段（无 MDLA 的模型不加段）/ 参照不存在 / 头不合法时 null
 */
export declare function addMdlClip(
  bytes: Uint8Array,
  init: MdlClipInit,
  pose?: "copy" | "rest",
  source?: number,
): { bytes: Uint8Array; id: number } | null;

/** 删片段；首个片段是引擎绑定参考，不许删。不存在 / 首个 / 不可编辑时 null */
export declare function removeMdlClip(bytes: Uint8Array, id: number): Uint8Array | null;

/** 清空全部片段（骨表一换，旧轨道的骨号整批失效）；没有片段时 null */
export declare function clearMdlClips(bytes: Uint8Array): Uint8Array | null;

/** 改片段头；改帧数时轨道重采样、事件帧号钳进新范围，改 fps 时事件时刻重算 */
export declare function setMdlClipMeta(bytes: Uint8Array, id: number, meta: Partial<MdlClipInit>): Uint8Array | null;

/** 整表替换帧事件（按帧号排序；与原表 frame + name 相同的沿用原 JSON 串） */
export declare function setMdlClipEvents(
  bytes: Uint8Array,
  id: number,
  events: ReadonlyArray<{ frame: number; name: string }>,
): Uint8Array | null;

/** MDLS 段的骨数（无 MDLS 段 / 网格表不可结构化读出时 null）—— P0 */
export declare function mdlBoneCount(bytes: Uint8Array): number | null;

/**
 * 第 boneIndex 根骨的记录头 `head0`（旧代码把它命名成 id）与矩阵尾的 JSON meta（骨骼约束 / 混规则
 * 在 .mdl 里的疑似落点，语义未定）。越界 / 不可编辑时 null；无 meta 的骨 `meta` 为 null —— P0
 */
export declare function mdlBoneMeta(
  bytes: Uint8Array,
  boneIndex: number,
): { head0: number | null; parent: number; meta: string | null } | null;

/**
 * 改第 boneIndex 根骨的 `head0` / `meta`（meta 必须是合法 JSON 串，`""` 表示清空），
 * 返回新 .mdl 字节；同值时逐字节不变，其余字节不动。越界 / 非整数 head0 / 非法 JSON 时 null —— P0
 */
export declare function setMdlBoneMeta(
  bytes: Uint8Array,
  boneIndex: number,
  patch: { head0?: number; meta?: string },
): Uint8Array | null;

/** 子网格数（网格表不可结构化读出时 null）—— P1 */
export declare function mdlMeshCount(bytes: Uint8Array): number | null;

/** 子网格摘要：顶点 / 索引规模、顶点字段 stride、蒙版数、部件表 —— P1 */
export declare function mdlMeshInfo(
  bytes: Uint8Array,
  meshIndex: number,
): { vertexCount: number; stride: number; indexCount: number; indexWide: boolean; maskCount: number; parts: MdlPart[] | null } | null;

/** 子网格顶点位置（每顶点 xyz，模型空间）；越界 / 不可编辑时 null —— P1 */
export declare function mdlMeshPositions(bytes: Uint8Array, meshIndex: number): Float32Array | null;

/** 子网格索引表（u32 展开，宽度按顶点数判定）；越界 / 不可编辑时 null —— P1 */
export declare function mdlMeshIndices(bytes: Uint8Array, meshIndex: number): Uint32Array | null;

/**
 * 写部件表（limb 表）：区间须首尾相接铺满索引表，`null` / `[]` = 去掉部件表。
 * 带蒙版的网格默认拒绝（显式 opts.allowMasked 才按原字节保留蒙版）；v<21 / 越界 / 区间不合法时 null —— P1
 */
export declare function setMdlParts(
  bytes: Uint8Array,
  meshIndex: number,
  parts: MdlPart[] | null,
  opts?: { allowMasked?: boolean },
): Uint8Array | null;

/** 写顶点位置（每顶点 xyz，长度 = 顶点数 ×3）；ver>=17 时同步重算 AABB —— P1 */
export declare function setMdlPositions(bytes: Uint8Array, meshIndex: number, positions: ArrayLike<number>): Uint8Array | null;

/** 只写顶点 z（透视挤出的深度），其余分量 / 索引 / 部件不动；ver>=17 时同步重算 AABB —— P1 */
export declare function setMdlVertexZ(bytes: Uint8Array, meshIndex: number, z: ArrayLike<number>): Uint8Array | null;

/**
 * 写拓扑（索引表 = 三角形列表）。`parts` 缺省时老部件表能铺满新索引表就沿用，否则拒绝；
 * `parts = null` 显式去掉部件表；带蒙版的网格拒绝 —— P1
 */
export declare function setMdlTopology(
  bytes: Uint8Array,
  meshIndex: number,
  indices: ArrayLike<number>,
  parts?: MdlPart[] | null,
): Uint8Array | null;

/** MDLS 一条骨记录（命名 / head0 / 父级 / 16 分量局部矩阵 / meta JSON 文本）—— P2 */
export type MdlBoneInfo = { name: string; head0: number; parent: number; matrix: Float32Array; meta: string };

/** 要写进 MDLS 的骨：matrix 省缺 = 单位矩阵 —— P2 */
export type MdlBoneSpec = {
  name?: string;
  parent: number;
  matrix?: ArrayLike<number>;
  head0?: number;
  meta?: string;
};

/** 读骨骼表（顺序 = 引擎骨号）；无 MDLS 或整份退成 raw 时 null —— P2 */
export declare function mdlBones(bytes: Uint8Array): MdlBoneInfo[] | null;

/** 只改骨名（数量须一致）：父级 / 矩阵 / head0 / meta / 尾表原样保留 —— P2 */
export declare function setMdlBoneNames(bytes: Uint8Array, names: ReadonlyArray<string>): Uint8Array | null;

/**
 * 重写整张骨骼表（骨数可变；parent 须 -1 或更靠前的骨，矩阵 16 分量且有限）。
 * 尾表 = 按骨数定长的静态装配姿势：骨数不变默认原样保留，骨数变了默认丢弃（tail 可强制）—— P2
 */
export declare function setMdlSkeleton(
  bytes: Uint8Array,
  bones: ReadonlyArray<MdlBoneSpec>,
  opts?: { tail?: "auto" | "keep" | "drop" },
): Uint8Array | null;

/** 蒙皮槽：每顶点 4 个骨号 + 4 个权重（非蒙皮 / 不可编辑时 null）—— P2 */
export declare function mdlSkin(
  bytes: Uint8Array,
  meshIndex: number,
): { joints: Uint32Array; weights: Float32Array; boneCount: number | null } | null;

/** 写 4 槽权重（长度 = 顶点数 ×4，有限非负、每顶点 Σ>0）；骨号不动 —— P2 */
export declare function setMdlWeights(bytes: Uint8Array, meshIndex: number, weights: ArrayLike<number>): Uint8Array | null;

/** 写 4 槽骨号（长度 = 顶点数 ×4，整数且落在 [0, 骨数) 内）—— P2 */
export declare function setMdlBoneIdx(bytes: Uint8Array, meshIndex: number, joints: ArrayLike<number>): Uint8Array | null;

/**
 * WE 内置字体名（scene.json 里的 font: "systemfont_*"）→ 本机 CSS font-family 栈。
 * 不在表里的 font 值是工程内字体文件路径（fonts/*.ttf|otf）。
 */
export declare const SYSTEM_FONT_FAMILIES: Readonly<Record<string, string>>;

/** 文字对象 pointsize → 场景像素的放大系数：em = pointsize × TEXT_EM_SCALE。 */
export declare const TEXT_EM_SCALE: number;

/**
 * 相机路径（M12 / B7）—— 队列模式：只认这两个字面量，其余（含 undefined）落到默认值。
 * 引擎把 `queuemode !== "random"` 一律当顺序，所以归一化不改变运行时行为。
 */
export declare function normalizeQueueMode(v: unknown, dflt?: CameraQueueMode): CameraQueueMode;

/**
 * 判定路径文档形态：`"object"` 对象级（`{paths:[{options, eye:{c0…}}]}`，挂相机对象的 `path`）、
 * `"scene"` 场景级（`{paths:[{duration, transforms:[{eye,timestamp}]}]}`，挂 `scene.camera.paths`）。
 * 空文档返回 `"unknown"`（两种格式都解释得通，不给假结论）。
 */
export declare function kindOfCameraPathDoc(doc: unknown): CameraPathKind;

/**
 * 逐段体检：形态 / 段数 / 总时长 / 队列模式 / 每段通道，外加 `issues`
 * （空路径、零时长段、没有 eye或center、fov 与 zoom 都缺、一段都没解析出来）。
 * 段解析与 tick 都转发引擎 `render/camera-path.js`，不另起一套时钟。
 */
export declare function describeCameraPath(doc: unknown, queueMode?: unknown): CameraPathReport;

/**
 * 顺序驱动队列（`times` 必须递增）并在这些时刻采样位姿。对象级走引擎状态机 tick、
 * 场景级走纯函数 tick；没有可用段时返回空数组。
 */
export declare function sampleCameraPath(
  doc: unknown,
  queueMode: unknown,
  times: readonly number[],
  basePose?: { eye?: unknown; center?: unknown; up?: unknown; fov?: unknown; zoom?: unknown },
): CameraPathPose[];

/** 透视用 `fov`、正交用 `zoom`；缺失回落 fov 50 / zoom 1（与引擎 base 一致） */
export declare function resolveCameraFovZoom(
  pose: { fov?: unknown; zoom?: unknown } | null | undefined,
  perspective: boolean,
): CameraFovZoom;

/** 读场景对象上的 `queuemode`，缺失或非法回落 `"sequential"`（= 引擎缺省） */
export declare function readQueueMode(obj: Record<string, unknown> | null | undefined): CameraQueueMode;

/**
 * 写场景对象上的 `queuemode`；写回 `baseline`（缺省 `"sequential"`）时删键而不是写冗余值。
 * 返回是否真的改动了文档。
 */
export declare function writeQueueMode(
  obj: Record<string, unknown> | null | undefined,
  mode: CameraQueueMode,
  baseline?: CameraQueueMode,
): boolean;

/** 队列重排（`doc.paths` 内就地 splice）；下标非法或原地不动返回 false */
export declare function moveCameraPathClip(doc: unknown, from: number, to: number): boolean;

/** 队列删段（`doc.paths` 内就地 splice）；下标非法返回 false */
export declare function removeCameraPathClip(doc: unknown, index: number): boolean;
