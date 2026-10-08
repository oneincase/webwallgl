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

/** 改片段头；改帧数时轨道重采样、事件帧号钳进新范围，改 fps 时事件时刻重算 */
export declare function setMdlClipMeta(bytes: Uint8Array, id: number, meta: Partial<MdlClipInit>): Uint8Array | null;

/** 整表替换帧事件（按帧号排序；与原表 frame + name 相同的沿用原 JSON 串） */
export declare function setMdlClipEvents(
  bytes: Uint8Array,
  id: number,
  events: ReadonlyArray<{ frame: number; name: string }>,
): Uint8Array | null;

/**
 * WE 内置字体名（scene.json 里的 font: "systemfont_*"）→ 本机 CSS font-family 栈。
 * 不在表里的 font 值是工程内字体文件路径（fonts/*.ttf|otf）。
 */
export declare const SYSTEM_FONT_FAMILIES: Readonly<Record<string, string>>;

/** 文字对象 pointsize → 场景像素的放大系数：em = pointsize × TEXT_EM_SCALE。 */
export declare const TEXT_EM_SCALE: number;
