// 检视器分组 / 检视器标签 / 木偶工具 / 木偶生成器四个贡献点（PLUGIN-ARCHITECTURE §3.6）。
//
// 检视器 = 按 order 排好的一串分组，每组 when(node) 决定是否出现、render(node) 出 DOM；
// 分组按 tab 归到标签页（属性 / 动画 / 模型 / 效果 / 逻辑 / 信息），没有分组的标签不显示。
// main.ts 的内置分组（变换 / 动画 / 文字 / 粒子 / 声音 / 效果 / 绑定 / 脚本 …）也登记在这里，
// 插件分组与它们平级排序；插件卸载，分组跟着消失。
// 木偶工具 = 模型层专属的分组（骨骼 / 片段 / 附着点 / 换贴图……）；
// 木偶生成器 = 「从别的东西造一个 puppet」（如一张图 → 带骨骼的摆动网格），产物走模型导入的后半段。

import { createRegistry } from "./core/registry";
import type { LayerNode } from "./doc";
import type { Gltf } from "./gltf";
import type { ModelIR } from "./model-ir";

export type InspectorGroup = {
  id: string;
  /** 越小越靠上；内置分组占 100 的整数倍，插件可插在中间 */
  order: number;
  /** 归入哪个标签页（inspector.tabs 里的 id）；缺省 / 未登记的标签都落到「属性」 */
  tab?: string;
  when(node: LayerNode): boolean;
  render(node: LayerNode): HTMLElement | null;
};

export const inspectorGroups = createRegistry<InspectorGroup>("inspector", { orderOf: (g) => g.order });

export type InspectorTab = {
  id: string;
  order: number;
  /** i18n 键，或 { zh, en } */
  title: string | Record<string, string>;
};

export const DEFAULT_INSPECTOR_TAB = "props";
/** 只读信息（字段一览 + 原始 JSON）固定放这一页，排最后 */
export const INFO_INSPECTOR_TAB = "info";

export const BUILTIN_INSPECTOR_TABS: InspectorTab[] = [
  { id: DEFAULT_INSPECTOR_TAB, order: 100, title: "insp.tab.props" },
  { id: "anim", order: 200, title: "insp.tab.anim" },
  { id: "model", order: 300, title: "insp.tab.model" },
  { id: "fx", order: 400, title: "insp.tab.fx" },
  { id: "logic", order: 500, title: "insp.tab.logic" },
  { id: INFO_INSPECTOR_TAB, order: 10000, title: "insp.tab.info" },
];

export const inspectorTabs = createRegistry<InspectorTab>("inspector.tabs", {
  orderOf: (t) => t.order,
  validate: (t) => {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(t.id)) throw new Error(`检视器标签 id 非法：${t.id}`);
  },
});
inspectorTabs.setFallback(BUILTIN_INSPECTOR_TABS);

/** 分组实际落在哪个标签（未登记的标签 id 退回默认页，插件卸了标签不至于让分组消失） */
export function tabOf(g: InspectorGroup): string {
  return g.tab && inspectorTabs.get(g.tab) ? g.tab : DEFAULT_INSPECTOR_TAB;
}

export type PuppetTool = InspectorGroup & {
  /** 只对哪种模型形态出现（缺省两种都出现） */
  forms?: ReadonlyArray<"puppet" | "mesh">;
};

export const puppetTools = createRegistry<PuppetTool>("puppet.tools", { orderOf: (g) => g.order });

export type PuppetGenerator = {
  id: string;
  title?: string | Record<string, string>;
  /** 文件选择框的 accept */
  accept: string;
  generate(file: { name: string; bytes: Uint8Array }): Promise<ModelIR | Gltf> | ModelIR | Gltf;
};

export const puppetGenerators = createRegistry<PuppetGenerator>("puppet.generators", {
  validate: (g) => {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(g.id)) throw new Error(`木偶生成器 id 非法：${g.id}`);
  },
});

/** 某个图层要显示的分组（检视器 + 适用的木偶工具，按 order 合并） */
export function groupsFor(node: LayerNode): InspectorGroup[] {
  const tools = node.modelForm ? puppetTools.list().filter((t) => !t.forms || t.forms.includes(node.modelForm!)) : [];
  return [...inspectorGroups.list(), ...tools]
    .filter((g) => {
      try {
        return g.when(node);
      } catch {
        return false;
      }
    })
    .sort((a, b) => a.order - b.order);
}
