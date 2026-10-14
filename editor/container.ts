// 容器层 / 全屏后期层 / passthrough（M5 A12）。
//
// 三种对象形状都由既有 image 字段表达，WE 认得，编辑器只是补上识别与编辑入口：
//   · 容器      image: "models/util/composelayer…"  —— 子层画进组 FBO，效果作用在整棵子树
//   · 全屏后期  image: "models/util/projectlayer…" / "models/util/fullscreenlayer…"
//                                                 —— 引擎按 general.orthogonalprojection 铺满整幅画布
//   · 直通      config.passthrough === true        —— 只对容器有意义（引擎也从 o.config 读）
//
// 本文件只做**判定**与**对象生成**，不碰引擎、不引渲染器：形状判定必须与
// renderer/vendor/we-scene/scene/parse.js 的 isContainer / isPost 逐字一致
// （前缀比较用 indexOf(...) === 0，不是 startsWith 之外的第二套口径）。
//
// 判定为什么放这里而不是 vendor：编辑器的 kindOf 要认得容器才能给对检视器，
// 而 vendor 是引擎的私有实现，编辑器不许直连（scripts/verify-editor.mjs 的 CONTAINER 段
// 断言两者前缀字面量一致）。

import type { EditorDoc, SceneObject } from "./doc";
import { nextObjectId, rebuildTree } from "./doc";
import { fieldKeyOf, isObjWrapper, objFieldRaw } from "./objprops";

/** 容器层 image 前缀（与 parse.js 的 isContainer 同一字面量；判定用，不带 .json 才能同时认新旧两种写法） */
export const CONTAINER_IMAGE = "models/util/composelayer";
/** 全屏后期层 image 前缀（与 parse.js 的 isPost 同一字面量） */
export const FULLSCREEN_POST_IMAGES = ["models/util/projectlayer", "models/util/fullscreenlayer"];

/**
 * **新对象写出的 image：带 `.json`**（判定用前缀，写盘用这两个）。
 *
 * 引擎的内置模型表是整串查表（scene-mount.ts 的 `eff.BUILTIN_MODELS[layer.image]`），
 * 表里只有 `models/util/{solidlayer,composelayer,fullscreenlayer,projectlayer}.json`
 * 四个键 —— 少一个后缀就是查表落空 + `readAsset` 也找不到（工程里没有 models/util/*）
 * ⇒ 装配循环 `continue`，这层没有材质、挂上去的效果链**根本不解析**。
 * 本机 364 个语料包里 838 个 composelayer 对象全部带 `.json`；
 * verify-groups.mjs 的 K 段对 fullscreenlayer 记过同一条坑。
 */
export const CONTAINER_MODEL = `${CONTAINER_IMAGE}.json`;
/** 全屏后期层写盘用的 image（BUILTIN_MODELS 的键，见上） */
export const POST_MODEL = `${FULLSCREEN_POST_IMAGES[0]}.json`;

const hasPrefix = (v: unknown, prefix: string) => typeof v === "string" && v.indexOf(prefix) === 0;

/** 引擎 isContainer 同口径：image 以 models/util/composelayer 开头 */
export const isContainerObject = (o: SceneObject | null | undefined): boolean =>
  !!o && hasPrefix(o.image, CONTAINER_IMAGE);

/** 引擎 isPost 同口径：image 以 projectlayer / fullscreenlayer 开头 */
export const isFullscreenPostObject = (o: SceneObject | null | undefined): boolean =>
  !!o && FULLSCREEN_POST_IMAGES.some((p) => hasPrefix(o.image, p));

/** 对象上有没有直通旗标（旗标本体在 config 里，不是顶层字段） */
export const hasPassthrough = (o: SceneObject | null | undefined): boolean => {
  const cfg = o?.config;
  return !!cfg && typeof cfg === "object" && (cfg as Record<string, unknown>).passthrough === true;
};

/** config 是不是一个能安全写键的普通对象（字符串 / 数组不算） */
const isValidConfig = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/**
 * 写 config 里的一个旗标。没有 config 就现建一个（键序稳定：新键追加在最后，
 * 已有键原地改值，所以没有该键时 JSON 只在尾部多一段）。mutate 直接改对象、不返回新对象。
 */
export function setConfigFlag(o: SceneObject, key: string, on: boolean) {
  let cfg: Record<string, unknown>;
  if (isValidConfig(o.config)) cfg = o.config;
  else {
    cfg = {};
    o.config = cfg;
  }
  if (on) cfg[key] = true;
  else delete cfg[key];
}

/** passthrough 旗标的写入（写 config.passthrough；关掉 = 删键，不留 false 残渣） */
export const setPassthrough = (o: SceneObject, on: boolean) => setConfigFlag(o, "passthrough", on);

/**
 * 与引擎 solid 判定同式（parse.js 的 IIFE）：
 *   composelayer → false（容器自己不出图）；solidlayer → true（常常没有 solid 旗标也照样实心）；
 *   particle → false；没 solid 旗标 → false；其余只认 util 内置与空 image。
 * 检视器用它标出「对象现在的渲染口径」，与旗标是否被勾选是两件事。
 */
export function solidRenders(o: SceneObject | null | undefined): boolean {
  if (!o) return false;
  if (typeof o.particle === "string") return false;
  const img = typeof o.image === "string" ? o.image : "";
  if (img.indexOf(CONTAINER_IMAGE) === 0) return false;
  if (img.indexOf("models/util/solidlayer") === 0) return true;
  if (!o.solid) return false;
  return !img || img.indexOf("models/util/") === 0;
}

export type ContainerCreateOpts = {
  kind?: "container" | "post";
  name?: string;
  /** 容器 / 后期层自身变换；不传就是 0 0 0 / 1 1 1 / 0 0 0 */
  origin?: string;
  scale?: string;
  angles?: string;
  /**
   * 图层尺寸 `"W H"`（像素）。容器 / 透明层的**效果画布**就是这个尺寸
   * （renderer.js 的 contentW/H：没有自己的贴图时取 layer.size），
   * 不写就是引擎的 `0 0` —— 那是一个零尺寸 quad，效果 FBO 也随之退化成空。
   */
  size?: string;
  /** 引擎侧实心：该层参与拾取 / 遮挡 */
  solid?: boolean;
  /** 直通：效果只作用在画布背板，不吞掉已经画好的画面 */
  passthrough?: boolean;
  /**
   * 只允许显式 `false`：写 `copybackground: false` = 「**不要**取身后的画面」。
   * 引擎认的是「键在不在」（parse.js 的 copybackgroundExplicit + renderer.js 的
   * layerWantsComposeBackdrop）：空容器默认会把背板拷进层 FBO，**只有显式 false**
   * 才是一块透明画布。true 不写（与本文件其它旗标「关掉就删键」的口径一致）。
   */
  copybackground?: boolean;
};

/**
 * 往文档里加一个容器（或全屏后期）对象并返回新 id —— 与 text.ts 的 addTextLayer、
 * particles.ts 的 addParticleLayer 同一形态：只改文档，撤销由调用方的 structEdit 记账。
 *
 * 键按字母序写（工程里 scene.json 的既有口径），可选键不满足就不落，
 * 免得给引擎塞一份带 undefined 的对象。
 */
export function addContainerLayer(doc: EditorDoc, opts: ContainerCreateOpts = {}): number | string | null {
  if (!doc.scene) return null;
  if (!Array.isArray(doc.scene.objects)) doc.scene.objects = [];
  const objs = doc.scene.objects as SceneObject[];
  const id = nextObjectId(objs);
  const post = opts.kind === "post";
  const o: SceneObject = { angles: opts.angles ?? "0 0 0" };
  if (opts.passthrough) o.config = {};
  if (opts.copybackground === false) o.copybackground = false;
  o.id = id;
  o.image = post ? POST_MODEL : CONTAINER_MODEL;
  o.name = opts.name ?? CONTAINER_IMAGE;
  o.origin = opts.origin ?? "0 0 0";
  o.scale = opts.scale ?? "1 1 1";
  if (opts.size) o.size = opts.size;
  o.visible = true;
  if (opts.solid) o.solid = true;
  // config 在字母序里排在 id 之前（与 text.ts 的 addTextLayer 同一口径）；键序固定才好逐字节比对
  if (opts.passthrough) setPassthrough(o, true);
  objs.push(o);
  rebuildTree(doc);
  return id;
}

export type TransparentLayerCreateOpts = {
  /** 图层名（树里显示；调用方给本地化名字） */
  name?: string;
  /** 画布宽（像素；取整、夹到 1..TRANSPARENT_LAYER_MAX） */
  width: number;
  /** 画布高（像素；取整、夹到 1..TRANSPARENT_LAYER_MAX） */
  height: number;
  /** 层自身变换；不传就是 0 0 0 / 0 0 0 */
  origin?: string;
  angles?: string;
};

/** 透明层尺寸上限（像素）。与 index.html 里两个数字框的 max 属性同一口径。 */
export const TRANSPARENT_LAYER_MAX = 16384;

/** 尺寸落到 scene.json 前的取整与夹取（NaN / 负数 / 0 一律兜到 1，别把 NaN 写进工程） */
const layerPx = (v: number): number =>
  Number.isFinite(v) ? Math.min(TRANSPARENT_LAYER_MAX, Math.max(1, Math.round(v))) : 1;

/**
 * 「透明层」= 自定义尺寸的**空效果画布**（M5 补 A12b）。
 *
 * 为什么是这一组字段（每一格都有引擎侧的读点，不是编辑器编的新词）：
 *   · `image: models/util/composelayer.json` —— 引擎唯一的「层内容画布」对象（parse.js 的
 *     isContainer）。它有自己的一块 FBO，挂在这层上的效果链就画在这块 FBO 上
 *     （后缀 `.json` 不能省：BUILTIN_MODELS 是整串查表，见 CONTAINER_MODEL 的注释）；
 *   · `size: "W H"` —— 这块 FBO 的尺寸（renderer.js 的 contentW/H：没有自己的贴图时
 *     取 `layer.size`）。不写就是 `0 0`，即一块零尺寸 quad，效果无处落笔；
 *   · `copybackground: false` —— **显式**声明不拷背板。空容器默认
 *     （layerWantsComposeBackdrop）会把身后的画面拷进层 FBO 再套效果；显式 false 之后
 *     源图是 1×1 全透明（renderer.js 的 transparentTex），于是「什么都没有、但效果能画」；
 *   · 不带 `config.passthrough` —— 直通会把画面本身当源图，那是另一种语义（见 addContainerLayer）。
 *
 * 于是「透明层 + 效果」= 一块用户指定尺寸的透明背板 + 落在它上面的效果链，
 * 与 WE 工程里 3351179520 的 393 / 103 号对象同形，导出给 WE 也是同一份 scene.json。
 */
export function addTransparentLayer(doc: EditorDoc, opts: TransparentLayerCreateOpts): number | string | null {
  const width = layerPx(opts.width);
  const height = layerPx(opts.height);
  return addContainerLayer(doc, {
    name: opts.name,
    origin: opts.origin,
    angles: opts.angles,
    size: `${width} ${height}`,
    copybackground: false,
  });
}

/**
 * 读图层尺寸 `"W H"`（像素）。没有 size、或值不是两个正数时返回 null ——
 * 引擎的口径是 `parseVec2(o.size || '0 0')`：**不写就是 0 0**，一块零尺寸 quad。
 * 包装（{user|script|animation, value}）读快照值，与 objprops 的读取口径同一份。
 */
export function layerSizeOf(o: SceneObject | null | undefined): [number, number] | null {
  const k = fieldKeyOf(o, "size");
  if (!o || !k) return null;
  const raw = objFieldRaw(o[k]);
  if (typeof raw !== "string") return null;
  const parts = raw.trim().split(/\s+/);
  const w = Number(parts[0]);
  const h = Number(parts[1]);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  return [Math.round(w), Math.round(h)];
}

/**
 * 写图层尺寸（`size` 不在 objprops.OBJ_FIELDS 里 —— 它不是 WE 的通用对象字段，
 * 而是「层内容画布」这一族对象才有意义的尺寸，所以写入口跟生成口放在一起）。
 *
 * 三条铁律与 objprops.writeField 同一份，别在这里发明第二套口径：
 *   · 大小写不敏感地回到**原来的键名**（`Size` 保持 `Size`，不新增第二个键）；
 *   · 对象上本来没有这个键时按引擎认的规范名 `size` 新增；
 *   · 包装只改 `.value`，不动 user / script / animation 绑定本身。
 * 返回是否真的改了（false = 值没变，调用方据此不记一次撤销）。
 */
export function setLayerSize(o: SceneObject, width: number, height: number): boolean {
  const next = `${layerPx(width)} ${layerPx(height)}`;
  const k = fieldKeyOf(o, "size");
  if (!k) {
    o.size = next;
    return true;
  }
  const cur = o[k];
  if (isObjWrapper(cur)) {
    if (objFieldRaw(cur) === next) return false;
    cur.value = next;
    return true;
  }
  if (cur === next) return false;
  o[k] = next;
  return true;
}
