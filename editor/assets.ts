// 资源表（EDITOR-PLAN §3A.3「文档 + 资源表」）：原始来源（包 / 目录）之上叠一层可写资源，
// 页面新增的素材（拖入的图片等）写在这里。读取先查叠加层，再落到原始来源。

import type { SceneAssets } from "./open";

export type AddedFile = { name: string; data: Uint8Array; group?: string };

export type OverlayAssets = SceneAssets & {
  /** group = 拥有它的模型路径（如 models/editor/x.json）；该模型不再被文档引用时，保存清单里不带它 */
  put(name: string, data: Uint8Array, group?: string): void;
  has(name: string): boolean;
  /** 叠加层里的全部文件（草稿快照用，不按引用过滤） */
  added(): AddedFile[];
};

/**
 * base = 原始来源的读取器（新建的空白工程没有）；referenced() 返回文档当前引用的模型路径集合，
 * 撤销掉「添加图片」后那组文件留在叠加层里（重做还要用），但不进保存清单。
 */
export function overlayAssets(
  entry: string,
  base: SceneAssets | null,
  referenced: () => ReadonlySet<string>,
): OverlayAssets {
  const files = new Map<string, AddedFile>();
  const live = () => {
    const refs = referenced();
    return [...files.values()].filter((f) => !f.group || refs.has(f.group));
  };
  return {
    entry,
    async read(name, signal) {
      const hit = files.get(name);
      if (hit) return hit.data;
      return base ? base.read(name, signal) : null;
    },
    list() {
      const out = new Set(base?.list() ?? []);
      for (const f of live()) out.add(f.name);
      out.delete(entry);
      return [...out];
    },
    put(name, data, group) {
      files.set(name, { name, data, group });
    },
    has: (name) => files.has(name),
    added: () => [...files.values()],
  };
}
