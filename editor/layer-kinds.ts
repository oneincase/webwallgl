// 图层类型注册表（PLUGIN-ARCHITECTURE §3.5）：doc.ts 的 kindOf 先问插件登记的类型，
// 都不认再走内置判定。内置 11 种由 builtin-layer-kinds 插件登记描述（能否挂效果 / 能否做关键帧 /
// 新建入口），判定逻辑仍在 kindOf 里（builtin: true 的项不参与 match，避免两份判定分叉）。
//
// 插件图层类型只是「scene.json 里某种对象形状」的识别 + 编辑入口，对象本身必须是 WE 认识的
// 形状（image / particle / sound / model / light …），WE 不认识的字段 WE 会忽略。

import { createRegistry } from "./core/registry";
import type { EditorDoc, SceneObject } from "./doc";

export type LayerKindDef = {
  kind: string;
  /** 内置类型：判定写在 kindOf 里，这里只登记能力描述 */
  builtin?: boolean;
  /** 识别（插件类型必填）；越小越先判 */
  match?: (o: SceneObject) => boolean;
  order?: number;
  title?: string | Record<string, string>;
  canHaveEffects?: boolean;
  canAnimate?: boolean;
  /** 「添加图层」菜单入口：往文档里加一个该类型对象，返回新 id */
  create?: (doc: EditorDoc) => number | string | null;
};

export const layerKinds = createRegistry<LayerKindDef>("layerKinds", {
  idOf: (k) => k.kind,
  orderOf: (k) => k.order ?? 0,
  validate: (k) => {
    if (!/^[a-z][a-z0-9-]*$/.test(k.kind)) throw new Error(`图层类型名非法：${k.kind}`);
    if (!k.builtin && typeof k.match !== "function") throw new Error(`插件图层类型 ${k.kind} 缺 match`);
  },
});

export const BUILTIN_LAYER_KINDS: LayerKindDef[] = [
  { kind: "image", builtin: true, canHaveEffects: true, canAnimate: true },
  // 容器层（M5 A12）：image = "models/util/composelayer"，效果作用在整棵子树上 ——
  // 引擎侧 renderContainerGroup 把子层画进组 FBO 再跑效果链，空容器读已渲染的背板
  // （layerWantsPreserveBackdrop），所以容器和图片层一样能挂效果。
  { kind: "container", builtin: true, canHaveEffects: true, canAnimate: true },
  // 全屏后期层（M5 A12）：image = "models/util/projectlayer" / "fullscreenlayer"，
  // 引擎按 general.orthogonalprojection 铺满整幅画布，效果跑在整幅画面上。
  { kind: "fullscreen-post", builtin: true, canHaveEffects: true, canAnimate: true },
  { kind: "text", builtin: true, canHaveEffects: true, canAnimate: true },
  { kind: "particle", builtin: true, canAnimate: true },
  { kind: "model", builtin: true, canAnimate: true },
  { kind: "sound", builtin: true },
  { kind: "light", builtin: true, canAnimate: true },
  { kind: "camera", builtin: true },
  { kind: "group", builtin: true, canAnimate: true },
  { kind: "other", builtin: true },
];
layerKinds.setFallback(BUILTIN_LAYER_KINDS);

/** 插件类型的识别（内置类型返回 null，交给 kindOf） */
export function matchLayerKind(o: SceneObject): string | null {
  for (const k of layerKinds.list()) {
    if (k.builtin || !k.match) continue;
    try {
      if (k.match(o)) return k.kind;
    } catch {
      /* 插件识别出错 = 不认，回落内置判定 */
    }
  }
  return null;
}

export const layerKindInfo = (kind: string): LayerKindDef | undefined => layerKinds.get(kind);
