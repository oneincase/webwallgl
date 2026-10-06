// 模型层（EDITOR-PLAN §3B，W12）：认出 puppet / 真 3D 模型层，给检视器「模型」分组整理只读信息。
// puppet 的判定要读图片对象引用的 model json（带 `puppet` 字段即是），文档本身看不出来，
// 所以打开后由 scanPuppets 异步扫一遍，结果存在 doc.puppets，建树时据此标 modelForm。
// 模型内容（骨骼 / 动画 / 附着点）一律经引擎 getModelInfo 取，页面不解析 .mdl。

import { mdlMeshMaterials, retargetMdlMaterial, type EditorModelInfo } from "../renderer/src/api/editor";
import { modelPathOf, type ImageInput } from "./create";
import { composeXform, localXform, rebuildTree, relativeXform, writeObjProps, type EditorDoc, type SceneObject, type Xform } from "./doc";

const decoder = new TextDecoder();

/** 文档里图片对象引用的 model json 中，带 `puppet` 的那些：json 路径 → .mdl 路径 */
export async function scanPuppets(
  doc: EditorDoc,
  read: (name: string) => Promise<Uint8Array | null>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const objs = Array.isArray(doc.scene?.objects) ? (doc.scene!.objects as SceneObject[]) : [];
  const paths = new Set<string>();
  for (const o of objs) {
    if (o && typeof o.image === "string" && /\.json$/i.test(o.image)) paths.add(o.image);
  }
  await Promise.all(
    [...paths].map(async (p) => {
      try {
        const bytes = await read(p);
        if (!bytes) return;
        const json = JSON.parse(decoder.decode(bytes).replace(/^\uFEFF/, "")) as Record<string, unknown>;
        if (typeof json.puppet === "string" && json.puppet) out.set(p, json.puppet);
      } catch {
        /* 读不到 / 不是 json：按普通图片层处理 */
      }
    }),
  );
  return out;
}

// ---------- 动画层（W13）：scene.json `animationlayers` 的读写，产物与 WE 同形 ----------

export type AnimLayerField = "animation" | "name" | "blend" | "rate" | "visible" | "additive";
/** 字段上的包装形态：{script} 由脚本逐帧决定，{user} 绑用户属性，{animation} 是关键帧曲线 */
export type AnimLayerWrap = "script" | "user" | "animation";
export type AnimLayerView = {
  index: number;
  id: number | null;
  name: string;
  animation: number;
  blend: number;
  rate: number;
  visible: boolean;
  additive: boolean;
  /** 带包装的字段（检视器显示为只读：值由脚本 / 用户属性 / 曲线驱动） */
  wrapped: Partial<Record<"blend" | "rate" | "visible", AnimLayerWrap>>;
};

type RawAnimLayer = Record<string, unknown>;

const listOf = (o: SceneObject): RawAnimLayer[] | null =>
  Array.isArray(o.animationlayers) ? (o.animationlayers as RawAnimLayer[]) : null;

const isWrapper = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function wrapOf(v: unknown): AnimLayerWrap | undefined {
  if (!isWrapper(v)) return undefined;
  if (typeof v.script === "string") return "script";
  if (v.animation && typeof v.animation === "object") return "animation";
  if (v.user !== undefined) return "user";
  return undefined;
}

const plain = (v: unknown): unknown => (isWrapper(v) && "value" in v ? v.value : v);
const numOr = (v: unknown, d: number) => {
  const n = Number(plain(v));
  return Number.isFinite(n) ? n : d;
};
const boolOr = (v: unknown, d: boolean) => {
  const p = plain(v);
  if (p === undefined || p === null) return d;
  return typeof p === "number" ? p !== 0 : !!p;
};

export function getAnimLayers(o: SceneObject): AnimLayerView[] {
  return (listOf(o) ?? []).flatMap((a, index) => {
    if (!a || typeof a.animation !== "number") return [];
    const wrapped: AnimLayerView["wrapped"] = {};
    for (const f of ["blend", "rate", "visible"] as const) {
      const w = wrapOf(a[f]);
      if (w) wrapped[f] = w;
    }
    return [
      {
        index,
        id: typeof a.id === "number" ? a.id : null,
        name: typeof a.name === "string" ? a.name : "",
        animation: a.animation,
        blend: numOr(a.blend, 1),
        rate: numOr(a.rate, 1),
        visible: boolOr(a.visible, true),
        additive: boolOr(a.additive, false),
        wrapped,
      },
    ];
  });
}

/**
 * 能否热替换（EditorControls.setAnimationLayers）而不必整场景重挂：引擎里的动画层脚本、
 * blend 曲线、用户属性写回都是装配期**按下标**挂上的，表里出现任何包装就只能重挂。
 */
export function animLayersHot(o: SceneObject): boolean {
  return (listOf(o) ?? []).every((a) => !a || !["blend", "rate", "visible", "additive", "name", "animation"].some((f) => isWrapper(a[f])));
}

/** 文档内已用的最大 id（对象与动画层共用一个编号空间，语料 1798 条无一与对象撞号） */
function maxUsedId(doc: EditorDoc): number {
  let max = 0;
  const objs = Array.isArray(doc.scene?.objects) ? (doc.scene!.objects as SceneObject[]) : [];
  for (const o of objs) {
    if (typeof o?.id === "number") max = Math.max(max, o.id);
    for (const a of listOf(o) ?? []) if (typeof a?.id === "number") max = Math.max(max, a.id);
  }
  return max;
}

/** 新增一条动画层（字段与语料同形、键序同 WE 存盘）；返回新条目下标 */
export function addAnimLayer(doc: EditorDoc, o: SceneObject, animation: number, name: string): number | null {
  if (!Number.isInteger(animation)) return null;
  const list = listOf(o) ?? (o.animationlayers = []) as RawAnimLayer[];
  list.push({
    additive: false,
    animation,
    blend: 1,
    blendin: false,
    blendout: false,
    blendtime: 0.5,
    id: maxUsedId(doc) + 1,
    name,
    rate: 1,
    visible: true,
  });
  return list.length - 1;
}

export function removeAnimLayer(o: SceneObject, index: number): boolean {
  const list = listOf(o);
  if (!list || index < 0 || index >= list.length) return false;
  list.splice(index, 1);
  if (!list.length) delete o.animationlayers;
  return true;
}

export function moveAnimLayer(o: SceneObject, index: number, dir: -1 | 1): boolean {
  const list = listOf(o);
  const to = index + dir;
  if (!list || index < 0 || index >= list.length || to < 0 || to >= list.length) return false;
  [list[index], list[to]] = [list[to], list[index]];
  return true;
}

/** 改一个字段；包装字段只改 `value`（脚本 / 绑定 / 曲线原样保留，同 keyframes.ts 纪律）。值不合法返回 false */
export function setAnimLayerField(o: SceneObject, index: number, field: AnimLayerField, value: unknown): boolean {
  const a = listOf(o)?.[index];
  if (!a) return false;
  let v: unknown;
  if (field === "animation") {
    if (!Number.isInteger(value)) return false;
    v = value;
  } else if (field === "name") {
    if (typeof value !== "string") return false;
    v = value;
  } else if (field === "blend") {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) return false;
    v = value;
  } else if (field === "rate") {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return false;
    v = value;
  } else {
    if (typeof value !== "boolean") return false;
    v = value;
  }
  const cur = a[field];
  if (isWrapper(cur) && field !== "animation" && field !== "name") cur.value = v;
  else a[field] = v;
  return true;
}

/** 「单独预览」：只推引擎、不进文档 —— 其余层 blend 置 0，目标层强制可见 */
export function soloAnimLayers(o: SceneObject, index: number): RawAnimLayer[] {
  return (listOf(o) ?? []).map((a, i) => {
    const c = structuredClone(a);
    if (i === index) c.visible = true;
    else c.blend = 0;
    return c;
  });
}

// ---------- 附着点绑定（W14）：`parent` + `attachment`，绑定 / 解绑前后世界位置不变 ----------

/**
 * 模型层某附着点此刻被引擎加进挂件局部 origin 的偏移（网格空间、未乘模型缩放 / 旋转），
 * 由页面经 EditorControls.getAttachmentPoints 提供；模型没装上 / 没有这个附着点给 null（引擎此时也不加）。
 */
export type AttachOffsetOf = (modelId: number | string, name: string) => [number, number] | null;
export type AttachResult = "ok" | "noop" | "missing" | "cycle" | "animated" | "degenerate" | "noAttachment";

const same = (a: unknown, b: unknown) => a !== undefined && a !== null && String(a) === String(b);
const objsOf = (doc: EditorDoc) => (Array.isArray(doc.scene?.objects) ? (doc.scene!.objects as SceneObject[]) : null);
const parentObj = (objs: SceneObject[], o: SceneObject) =>
  o.parent === undefined || o.parent === null ? null : objs.find((x) => same(x.id, o.parent)) ?? null;
export const attachmentOf = (o: SceneObject): string | null =>
  typeof o.attachment === "string" && o.attachment !== "" ? o.attachment : null;
const animatedField = (o: SceneObject, f: string) => {
  const v = o[f];
  return !!v && typeof v === "object" && !Array.isArray(v) && "animation" in (v as object);
};

/** 引擎口径的世界变换：doc 的静态合成（worldXform）再在每个挂件处加上附着点偏移 */
export function attachedWorld(objs: SceneObject[], o: SceneObject | null, offOf: AttachOffsetOf): Xform {
  const chain: SceneObject[] = [];
  for (let cur = o; cur && chain.length < 64 && !chain.includes(cur); cur = parentObj(objs, cur)) chain.unshift(cur);
  let w: Xform = { origin: [0, 0, 0], scale: [1, 1, 1], angles: [0, 0, 0] };
  chain.forEach((c, i) => {
    const local = localXform(c);
    const name = attachmentOf(c);
    const off = name && i > 0 ? offOf(chain[i - 1].id as number | string, name) : null;
    if (off) {
      local.origin[0] += off[0];
      local.origin[1] += off[1];
    }
    w = composeXform(w, local);
  });
  return w;
}

/**
 * 把图层挂到模型层的附着点上：父级改成模型层、写 `attachment`，局部 origin 减去附着点此刻的偏移，
 * 使当前时刻画面不变。对象数组顺序不动（绘制顺序即画面层叠，不随层级变）。
 * 换父级时位置 / 缩放 / 旋转任一有关键帧就拒绝（关键帧是旧父空间的值）；只换附着点时只看位置。
 */
export function attachToModel(doc: EditorDoc, id: number | string, modelId: number | string, name: string, offOf: AttachOffsetOf): AttachResult {
  const objs = objsOf(doc);
  const self = objs?.find((o) => same(o.id, id));
  const model = objs?.find((o) => same(o.id, modelId));
  if (!objs || !self || !model) return "missing";
  for (let p: SceneObject | null = model, n = 0; p && n < 64; p = parentObj(objs, p), n++) if (p === self) return "cycle";
  const off = offOf(model.id as number | string, name);
  if (!off) return "noAttachment";
  const sameParent = same(self.parent, model.id) && parentObj(objs, self) === model;
  if (sameParent && attachmentOf(self) === name) return "noop";
  if ((sameParent ? ["origin"] : ["origin", "scale", "angles"]).some((f) => animatedField(self, f))) return "animated";
  const local = relativeXform(attachedWorld(objs, model, offOf), attachedWorld(objs, self, offOf));
  if (!local) return "degenerate";
  local.origin[0] -= off[0];
  local.origin[1] -= off[1];
  writeObjProps(self, sameParent ? { origin: local.origin } : local);
  self.parent = model.id;
  self.attachment = name;
  rebuildTree(doc);
  return "ok";
}

/** 解除附着点（父级仍是模型层，只是不再跟骨骼）：局部 origin 加回此刻的偏移，世界位置不变 */
export function detachFromModel(doc: EditorDoc, id: number | string, offOf: AttachOffsetOf): AttachResult {
  const objs = objsOf(doc);
  const self = objs?.find((o) => same(o.id, id));
  if (!objs || !self) return "missing";
  if (!attachmentOf(self)) return "noop";
  if (animatedField(self, "origin")) return "animated";
  const world = attachedWorld(objs, self, offOf);
  const local = relativeXform(attachedWorld(objs, parentObj(objs, self), offOf), world);
  if (!local) return "degenerate";
  delete self.attachment;
  writeObjProps(self, { origin: local.origin });
  rebuildTree(doc);
  return "ok";
}

const fmt = (v: number) => String(Math.round(v * 1000) / 1000);

/** 检视器「模型」分组的行（i18n 键 → 文本），纯函数便于单测 */
export function modelInfoRows(info: EditorModelInfo): Array<[string, string]> {
  const rows: Array<[string, string]> = [
    ["model.form", info.form],
    ["model.mdl", info.mdlPath],
  ];
  if (info.modelJsonPath) rows.push(["model.json", info.modelJsonPath]);
  rows.push(
    ["model.version", info.version],
    ["model.vertices", String(info.vertexCount)],
    ["model.bones", String(info.bones.length)],
  );
  rows.push([
    "model.animations",
    info.animations.length
      ? info.animations.map((a) => `#${a.id} ${a.name || "—"} · ${a.mode} · ${fmt(a.duration)}s (${a.frameCount}f @ ${fmt(a.fps)})`).join("\n")
      : "—",
  ]);
  rows.push([
    "model.attachments",
    info.attachments.length
      ? info.attachments
          .map((at) => `${at.name} → ${info.bones[at.bone]?.name || `#${at.bone}`} (${fmt(at.bindOrigin[0])}, ${fmt(at.bindOrigin[1])})`)
          .join("\n")
      : "—",
  ]);
  rows.push([
    "model.meshes",
    info.meshes.map((m, i) => `${i}: ${m.materialPath ?? "—"} · ${m.vertexCount}v${m.texture ? ` · ${m.texture}` : ""}`).join("\n"),
  ]);
  return rows;
}

// ---------- 子网格贴图替换（W16）：写时复制，原模型 / 材质 / .mdl 不动 ----------
// puppet 整层一张贴图，换的是 model json 的 material；mesh 每个子网格各自的材质写在 .mdl 网格头里，
// 换哪个就把 .mdl 复制一份、只改那个子网格的材质串。新文件全落在 */editor/<slug>.*，
// 对象的 image / model 改指向副本，共用原模型的其他图层不受影响。

export type TextureSlot = { index: number; materialPath: string | null; texture: string | null };

export const editorMaterialOf = (slug: string) => `materials/editor/${slug}.json`;
export const editorMdlOf = (slug: string) => `models/editor/${slug}.mdl`;

/** 检视器「子网格贴图」的行：puppet 只有一张（槽 0），mesh 每个子网格一行 */
export function modelTextureSlots(info: EditorModelInfo): TextureSlot[] {
  const list = info.form === "puppet" ? info.meshes.slice(0, 1) : info.meshes;
  return list.map((m, index) => ({
    index,
    materialPath: info.form === "puppet" ? null : m.materialPath,
    texture: m.texture,
  }));
}

export function parseJsonBytes(bytes: Uint8Array | null): Record<string, unknown> | null {
  if (!bytes) return null;
  try {
    const v = JSON.parse(decoder.decode(bytes).replace(/^\uFEFF/, ""));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 材质副本：passes[0].textures[0] 换成 editor/<slug>，其余字段（shader / combos / 常量 / 其他槽）原样；没有 pass 返回 null */
export function retexturedMaterial(material: Record<string, unknown>, slug: string): Record<string, unknown> | null {
  const m = structuredClone(material) as Record<string, unknown>;
  const passes = m.passes;
  if (!Array.isArray(passes) || !passes[0] || typeof passes[0] !== "object") return null;
  const p0 = passes[0] as Record<string, unknown>;
  const tex = Array.isArray(p0.textures) ? [...(p0.textures as unknown[])] : [];
  tex[0] = `editor/${slug}`;
  for (let i = 0; i < tex.length; i++) if (tex[i] === undefined) tex[i] = null;
  p0.textures = tex;
  return m;
}

export type RetextureResult = {
  /** 对象该改指向的新路径（puppet → image 的 model json，mesh → model 的 .mdl） */
  path: string;
  files: Array<{ name: string; data: Uint8Array }>;
};

const encoder = new TextEncoder();
const jsonBytes = (v: unknown) => encoder.encode(JSON.stringify(v, null, 2));
const texFile = (slug: string, img: Pick<ImageInput, "bytes" | "ext">) => ({ name: `materials/editor/${slug}.${img.ext}`, data: img.bytes });

/** puppet：model json 副本（material 改指向）+ 材质副本 + 源图；model json 不是 puppet / 材质无 pass 时 null */
export function puppetRetexture(
  modelJson: Record<string, unknown>,
  material: Record<string, unknown>,
  slug: string,
  img: Pick<ImageInput, "bytes" | "ext">,
): RetextureResult | null {
  if (typeof modelJson.puppet !== "string" || !modelJson.puppet) return null;
  const mat = retexturedMaterial(material, slug);
  if (!mat) return null;
  const path = modelPathOf(slug);
  return {
    path,
    files: [
      { name: path, data: jsonBytes({ ...structuredClone(modelJson), material: editorMaterialOf(slug) }) },
      { name: editorMaterialOf(slug), data: jsonBytes(mat) },
      texFile(slug, img),
    ],
  };
}

/** mesh：.mdl 副本（第 meshIndex 个子网格的材质改指向）+ 材质副本 + 源图；.mdl 读不成结构 / 越界 / 材质无 pass 时 null */
export function meshRetexture(
  mdlBytes: Uint8Array,
  meshIndex: number,
  material: Record<string, unknown>,
  slug: string,
  img: Pick<ImageInput, "bytes" | "ext">,
): RetextureResult | null {
  const mat = retexturedMaterial(material, slug);
  if (!mat) return null;
  const mdl = retargetMdlMaterial(mdlBytes, meshIndex, editorMaterialOf(slug));
  if (!mdl) return null;
  const path = editorMdlOf(slug);
  return {
    path,
    files: [{ name: path, data: mdl }, { name: editorMaterialOf(slug), data: jsonBytes(mat) }, texFile(slug, img)],
  };
}

/** mesh 第 meshIndex 个子网格当前的材质路径（以 .mdl 本身为准，不信引擎缓存） */
export function meshMaterialPath(mdlBytes: Uint8Array, meshIndex: number): string | null {
  return mdlMeshMaterials(mdlBytes)?.[meshIndex] ?? null;
}
