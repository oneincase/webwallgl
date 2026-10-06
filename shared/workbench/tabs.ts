/**
 * 面板标签页：`[data-tab="id"]` 按钮切换同一面板内的 `[data-pane="id"]` 内容，
 * 当前选中写 localStorage。只认属于本面板的标签与内容（嵌套面板互不干扰）。
 */

import { load, save } from "./storage";

export type TabsOptions = {
  storageKey?: string;
  /** 没有持久化值时的初始标签（缺省为第一个） */
  initial?: string;
  onChange?: (id: string) => void;
};

export type Tabs = {
  select(id: string): void;
  current(): string;
};

export function initTabs(panel: HTMLElement, opts: TabsOptions = {}): Tabs {
  const own = <T extends HTMLElement>(sel: string) =>
    [...panel.querySelectorAll<T>(sel)].filter((el) => el.closest(".wb-panel") === panel);
  const tabs = own<HTMLElement>("[data-tab]");
  const panes = own<HTMLElement>("[data-pane]");
  const ids = tabs.map((t) => t.dataset.tab!);
  let current = "";

  for (const tab of tabs) {
    tab.setAttribute("role", "tab");
    tab.addEventListener("click", () => select(tab.dataset.tab!));
  }

  function select(id: string) {
    if (!ids.includes(id)) return;
    const changed = id !== current;
    current = id;
    for (const tab of tabs) {
      const on = tab.dataset.tab === id;
      tab.classList.toggle("active", on);
      tab.setAttribute("aria-selected", on ? "true" : "false");
    }
    for (const pane of panes) pane.hidden = pane.dataset.pane !== id;
    if (opts.storageKey) save(opts.storageKey, id);
    if (changed) opts.onChange?.(id);
  }

  const saved = opts.storageKey ? load(opts.storageKey) : null;
  select(saved && ids.includes(saved) ? saved : opts.initial && ids.includes(opts.initial) ? opts.initial : ids[0]);

  return { select, current: () => current };
}
