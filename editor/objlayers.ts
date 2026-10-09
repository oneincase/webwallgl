// light / camera 图层入口（M4 A6）。
//
// 这两个种类在编辑器里此前**完全无法新建**：`editor/layer-kinds.ts` 的九项内建
// 都只声明了 `canHaveEffects` / `canAnimate`，`create` 字段从来没人写、也没人读。
// 本文件提供构造器与字段读写，`layer-kinds.ts` 把它接成 `LayerKindDef.create`，
// 再由 `createLayerOfKind()` 供工具条按钮调用 —— 于是「字段被生产代码消费」是可断言的事实。
//
// 引擎面（renderer/vendor/we-scene/scene/parse.js）：
//   light：`isLight`（`o.light` 非空字符串）、`lightType`、`lightLane`、`lightRadius`、
//     `intensity`、`exponent`。**原始灯类型串必须留着**：`^l` 前缀的四种
//     （lpoint/lspot/ltube/ldirectional）走 V1 通道并按 `lightconfig` 限槽，
//     无前缀的 `point`（及未知串）走 4 槽老通道，两条衰减公式不同；
//     归一化成 `point` 会把 lpoint 的老通道身份丢掉。
//   camera：`isCamera`、`cameraFov`、`zoom`。语料里相机对象写 `"camera":"default"`。
//     顶层 `scene.camera` 只是编辑器视口快照（parse.js 注释明确运行时不用），
//     所以「新建相机图层」写的是**对象**，不是顶层快照。
//
// 字段可能被 `{user|script|animation, value}` 包装（intensity/exponent 在脚本白名单里），
// 写入时只改 `.value`，包装原样保留。

import { nextObjectId, rebuildTree, type EditorDoc, type SceneObject } from "./doc";
import { fieldKeyOf, isObjWrapper } from "./objprops";

/** 灯类型串（保持原样写回 scene.json，不做归一化） */
export const LIGHT_TYPES = ["lpoint", "lspot", "ltube", "ldirectional", "point"] as const;
export type LightType = (typeof LIGHT_TYPES)[number];

/** 引擎的灯光通道：`^l` 前缀 = V1 通道，其余 = 4 槽老通道（衰减公式不同） */
export type LightLane = "v1" | "legacy";

export const isLightObject = (o: SceneObject): boolean => typeof o.light === "string" && o.light !== "";
export const isCameraObject = (o: SceneObject): boolean => typeof o.camera === "string" && o.camera !== "";

export const lightLaneOf = (v: unknown): LightLane =>
  typeof v === "string" && /^l/.test(v) ? "v1" : "legacy";

/** parse.js 的 lightType：只有 spot / directional 保留，其余（含 ltube）都归 'point' */
export function lightTypeOf(v: unknown): "spot" | "directional" | "point" {
  const t = String(v ?? "").replace(/^l/, "");
  return t === "spot" || t === "directional" ? t : "point";
}

const num = (v: number) => Math.round(v * 1e5) / 1e5;
const vecStr = (v: readonly number[]) => v.map((x) => String(num(x))).join(" ");
const isWrappedObj = isObjWrapper;

/** 大小写不敏感命中原名写回；包装只改 `.value`（与 sound.ts 的 writeField 同一条口径） */
function writeField(obj: SceneObject, key: string, v: unknown): boolean {
  const real = fieldKeyOf(obj, key);
  if (real === null) {
    obj[key] = v;
    return true;
  }
  const cur = obj[real];
  if (isWrappedObj(cur)) {
    if (cur.value === v) return false;
    cur.value = v;
    return true;
  }
  if (cur === v) return false;
  obj[real] = v;
  return true;
}

function readNum(obj: SceneObject, key: string, dflt: number): number {
  const real = fieldKeyOf(obj, key);
  if (real === null) return dflt;
  const cur = obj[real];
  const raw = isWrappedObj(cur) ? cur.value : cur;
  const n = Number(raw);
  return Number.isFinite(n) ? n : dflt;
}

function readColor(obj: SceneObject, key: string): [number, number, number] {
  const real = fieldKeyOf(obj, key);
  if (real === null) return [1, 1, 1];
  const cur = obj[real];
  const raw = isWrappedObj(cur) ? cur.value : cur;
  if (Array.isArray(raw)) {
    const a = raw.map(Number);
    return [a[0] || 0, a[1] || 0, a[2] || 0];
  }
  const p = String(raw ?? "").trim().split(/\s+/).map(Number);
  return [p[0] || 0, p[1] || 0, p[2] || (p.length ? 0 : 1)];
}

// ---------------- light ----------------

export type LightFields = {
  /** 原始类型串（lpoint / lspot / ltube / ldirectional / point / 未知串） */
  light: string;
  /** 引擎衰减类型（parse.js 的 lightType） */
  type: "spot" | "directional" | "point";
  /** 引擎通道（parse.js 的 lightLane） */
  lane: LightLane;
  intensity: number;
  radius: number;
  /** 只有 V1 通道吃这个字段（老通道不吃） */
  exponent: number;
  color: [number, number, number];
};

export function getLightFields(obj: SceneObject): LightFields | null {
  if (!isLightObject(obj)) return null;
  const light = String(obj.light);
  return {
    light,
    type: lightTypeOf(light),
    lane: lightLaneOf(light),
    intensity: readNum(obj, "intensity", 1),
    radius: readNum(obj, "radius", 1000),
    exponent: readNum(obj, "exponent", 2),
    color: readColor(obj, "color"),
  };
}

export type LightField = "light" | "intensity" | "radius" | "exponent" | "color";

/** 检视器写值：不是灯 / 校验不过 / 没变化都返回 false */
export function setLightField(obj: SceneObject, field: LightField, value: unknown): boolean {
  if (!isLightObject(obj)) return false;
  if (field === "light") {
    // 未知串也允许写回（引擎按「未知串 = 老通道」处理），只要非空
    return typeof value === "string" && value !== "" && writeField(obj, "light", value);
  }
  if (field === "color") {
    if (!Array.isArray(value) || value.length !== 3) return false;
    const v = value.map(Number);
    if (v.some((x) => !Number.isFinite(x))) return false;
    return writeField(obj, "color", vecStr(v));
  }
  const n = Number(value);
  if (!Number.isFinite(n)) return false;
  if (field === "intensity" || field === "exponent") return writeField(obj, field, num(n));
  if (field === "radius") {
    if (n < 0) return false;
    return writeField(obj, "radius", num(n));
  }
  return false;
}

/** 新灯光层追加到对象数组末尾。返回新 id */
export function addLightLayer(doc: EditorDoc, lightType: LightType = "lpoint", name = "Light"): number | null {
  const scene = doc.scene;
  if (!scene) return null;
  if (!(LIGHT_TYPES as readonly string[]).includes(lightType)) return null;
  if (!Array.isArray(scene.objects)) scene.objects = [];
  const objs = scene.objects as SceneObject[];
  const id = nextObjectId(objs);
  objs.push({
    alpha: 1,
    angles: "0 0 0",
    color: "1 1 1",
    // 引擎缺省：radius 1000 / intensity 1 / exponent 2.0（parse.js 的 parseNum 兜底值）
    exponent: 2,
    id,
    intensity: 1,
    light: lightType,
    name,
    origin: "0 0 0",
    radius: 1000,
    scale: "1 1 1",
    visible: true,
  });
  rebuildTree(doc);
  return id;
}

// ---------------- camera ----------------

export type CameraFields = {
  /** 语料里是 "default"；引擎只要求非空字符串 */
  camera: string;
  /** 0 / 缺失 = 引擎按 50 兜底（math.js 的 buildCamera：`rc.fov > 0 ? rc.fov : numField(general.fov, 50)`） */
  fov: number;
  zoom: number;
};

export function getCameraFields(obj: SceneObject): CameraFields | null {
  if (!isCameraObject(obj)) return null;
  return {
    camera: String(obj.camera),
    fov: readNum(obj, "fov", 0),
    zoom: readNum(obj, "zoom", 1),
  };
}

export type CameraField = "camera" | "fov" | "zoom";

export function setCameraField(obj: SceneObject, field: CameraField, value: unknown): boolean {
  if (!isCameraObject(obj)) return false;
  if (field === "camera") return typeof value === "string" && value !== "" && writeField(obj, "camera", value);
  const n = Number(value);
  if (!Number.isFinite(n)) return false;
  if (field === "fov") {
    // fov ≤ 0 = 引擎缺省 50：允许写 0（语义是「交回引擎」），负值拒绝
    if (n < 0 || n >= 180) return false;
    return writeField(obj, "fov", num(n));
  }
  if (field === "zoom") {
    if (n <= 0) return false;
    return writeField(obj, "zoom", num(n));
  }
  return false;
}

/** 新相机层追加到对象数组末尾。返回新 id */
export function addCameraLayer(doc: EditorDoc, name = "Camera"): number | null {
  const scene = doc.scene;
  if (!scene) return null;
  if (!Array.isArray(scene.objects)) scene.objects = [];
  const objs = scene.objects as SceneObject[];
  const id = nextObjectId(objs);
  objs.push({
    alpha: 1,
    angles: "0 0 0",
    camera: "default",
    fov: 50,
    id,
    name,
    origin: "0 0 0",
    scale: "1 1 1",
    visible: true,
    zoom: 1,
  });
  rebuildTree(doc);
  return id;
}
