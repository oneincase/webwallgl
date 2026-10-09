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

/** 容器层 image 前缀（与 parse.js 的 isContainer 同一字面量） */
export const CONTAINER_IMAGE = "models/util/composelayer";
/** 全屏后期层 image 前缀（与 parse.js 的 isPost 同一字面量） */
export const FULLSCREEN_POST_IMAGES = ["models/util/projectlayer", "models/util/fullscreenlayer"];

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
  /** 引擎侧实心：该层参与拾取 / 遮挡 */
  solid?: boolean;
  /** 直通：效果只作用在画布背板，不吞掉已经画好的画面 */
  passthrough?: boolean;
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
  o.id = id;
  o.image = post ? FULLSCREEN_POST_IMAGES[0] : CONTAINER_IMAGE;
  o.name = opts.name ?? CONTAINER_IMAGE;
  o.origin = opts.origin ?? "0 0 0";
  o.scale = opts.scale ?? "1 1 1";
  o.visible = true;
  if (opts.solid) o.solid = true;
  // config 在字母序里排在 id 之前（与 text.ts 的 addTextLayer 同一口径）；键序固定才好逐字节比对
  if (opts.passthrough) setPassthrough(o, true);
  objs.push(o);
  rebuildTree(doc);
  return id;
}
