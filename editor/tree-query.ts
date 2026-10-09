// 图层树视图查询（C2）：搜索过滤、隔离，全部是纯数据 + Set 运算，不碰 DOM。
// 树本身由 main.ts 渲染，这里只回答「哪些节点可见 / 哪些命中」。

export type TreeEntry = {
  id: number | string;
  /** 父级 id；顶层为 null */
  parent: number | string | null;
  name: string;
};

/** 搜索串归一：去空白、转小写；空串 = 不过滤 */
export function treePattern(query: string): string {
  return query.trim().toLowerCase();
}

/** 命中判定：层名或 id 包含搜索串（Query 为空则全部不命中） */
export function treeMatches(e: TreeEntry, query: string): boolean {
  const q = treePattern(query);
  if (!q) return false;
  return e.name.toLowerCase().includes(q) || String(e.id).toLowerCase().includes(q);
}

/**
 * 视图过滤：给定目标的 id（搜索命中集 / 隔离集），补上它们的全部祖先，
 * 返回 {visible, matched}。matched 是目标里真实存在于树的那些（高亮用）。
 */
export function treeVisible(entries: ReadonlyArray<TreeEntry>, target: ReadonlySet<string>): { visible: Set<string>; matched: Set<string> } {
  const byId = new Map<string, TreeEntry>();
  for (const e of entries) byId.set(String(e.id), e);
  const visible = new Set<string>();
  const matched = new Set<string>();
  for (const e of entries) {
    const key = String(e.id);
    if (!target.has(key)) continue;
    matched.add(key);
    for (let cur: TreeEntry | undefined = e, n = 0; cur && n < 1024; n++) {
      const k = String(cur.id);
      if (visible.has(k)) break;
      visible.add(k);
      cur = cur.parent === null ? undefined : byId.get(String(cur.parent));
    }
  }
  return { visible, matched };
}

/** 搜索命中集：树里所有满足 treeMatches 的层 */
export function treeSearchHits(entries: ReadonlyArray<TreeEntry>, query: string): Set<string> {
  const out = new Set<string>();
  if (!treePattern(query)) return out;
  for (const e of entries) if (treeMatches(e, query)) out.add(String(e.id));
  return out;
}

/** 展开某个 id 的全部祖先（隔离 / 定位时用）；返回新的折叠集合 */
export function treeExpanded(collapsed: ReadonlySet<number | string>, entries: ReadonlyArray<TreeEntry>, id: number | string): Set<number | string> {
  const out = new Set<number | string>(collapsed);
  const byId = new Map<string, TreeEntry>();
  for (const e of entries) byId.set(String(e.id), e);
  let cur = byId.get(String(id));
  for (let n = 0; cur && n < 1024; n++) {
    out.delete(cur.id);
    cur = cur.parent === null ? undefined : byId.get(String(cur.parent));
  }
  return out;
}

/** 这些 id 的整棵子树（含自身），按 parent 闭包求 */
export function treeSubtree(entries: ReadonlyArray<TreeEntry>, ids: ReadonlyArray<number | string>): Set<string> {
  const want = new Set(ids.map(String));
  for (let grew = true; grew; ) {
    grew = false;
    for (const e of entries) {
      if (want.has(String(e.id)) || e.parent === null) continue;
      if (want.has(String(e.parent))) {
        want.add(String(e.id));
        grew = true;
      }
    }
  }
  return want;
}

/** 隔离视图：只显示这些层及其整棵子树，再加它们的祖先（祖先本身不算命中态） */
export function treeIsolateView(entries: ReadonlyArray<TreeEntry>, ids: ReadonlyArray<number | string>): { visible: Set<string>; matched: Set<string> } {
  return treeVisible(entries, treeSubtree(entries, ids));
}
