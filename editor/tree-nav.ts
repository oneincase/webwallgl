// 图层树的键盘导航语义（C5 / M9）：纯函数，不碰 DOM、不碰文档。
// editor/main.ts 把当前渲染出来的行摊成 TreeNavRow[]（id / aria-level / aria-expanded）后调用它，
// 拿到动作用 DOM 落实 —— 语义集中在这里，离线判据可以直接喂 fixture 断言。
//
// 行的顺序 = 先序遍历（renderTree 的 walk 顺序），所以「展开的父行的下一行」就是它的第一个子行。

/** 一行在无障碍层面的可见信息（与 treeitem 上的 aria-* 同源） */
export type TreeNavRow = {
  id: string;
  /** aria-level：从 1 起（根 = 1） */
  level: number;
  hasChildren: boolean;
  /** 当前是否展开（没有子层的行恒为 false，但仍可聚焦） */
  expanded: boolean;
};

export type TreeNavAction =
  | { kind: "focus"; index: number }
  /** 只改展开态：折叠集合由调用方落定，随后重绘 */
  | { kind: "expand"; index: number }
  | { kind: "collapse"; index: number };

/**
 * ↑↓ 移动焦点（同步选择）、Home/End 首尾、Enter/空格确认、
 * → 展开或进入第一个子行、← 折叠或回到父行。
 * 不认的键或无处可去时返回 null（调用方不要 preventDefault）。
 */
export function treeNav(rows: readonly TreeNavRow[], index: number, key: string): TreeNavAction | null {
  if (index < 0 || index >= rows.length) return null;
  const row = rows[index];
  const focus = (i: number): TreeNavAction | null => (i >= 0 && i < rows.length && i !== index ? { kind: "focus", index: i } : null);
  switch (key) {
    case "ArrowDown":
      return focus(index + 1);
    case "ArrowUp":
      return focus(index - 1);
    case "Home":
      return focus(0);
    case "End":
      return focus(rows.length - 1);
    case "Enter":
    case " ":
      // 确认当前行（主选 + 重新渲染；与点选同一口径）
      return { kind: "focus", index };
    case "ArrowRight": {
      if (!row.hasChildren) return null;
      if (!row.expanded) return { kind: "expand", index };
      const kid = rows[index + 1];
      return kid && kid.level === row.level + 1 ? { kind: "focus", index: index + 1 } : null;
    }
    case "ArrowLeft": {
      if (row.hasChildren && row.expanded) return { kind: "collapse", index };
      for (let j = index - 1; j >= 0; j--) if (rows[j].level === row.level - 1) return { kind: "focus", index: j };
      return null;
    }
    default:
      return null;
  }
}

/** 行不在视图里时 roving tabindex 退回的那一行（空树给 null） */
export function firstFocusable(rows: readonly TreeNavRow[], current: string | null): string | null {
  if (!rows.length) return null;
  return current && rows.some((r) => r.id === current) ? current : rows[0].id;
}
