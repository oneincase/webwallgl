/**
 * 可拖拽分隔条：调整相邻停靠面板的宽 / 高，双击收起 / 展开，尺寸写 localStorage。
 *
 * 约定：面板是 flex 容器里的 `.wb-panel.is-dock`，尺寸写成 flex-basis；
 * 拖到最小值一半以下吸附为收起（VS Code 侧栏同款手感）。
 */

import { loadJson, save } from "./storage";

export type SplitterOptions = {
  axis: "x" | "y";
  /** 被调整的面板 */
  panel: HTMLElement;
  /** 面板位于分隔条哪一侧：before = 左 / 上，after = 右 / 下 */
  side: "before" | "after";
  size: number;
  min: number;
  /** 上限；函数形式按容器实时尺寸算（给中央区留够空间） */
  max: number | (() => number);
  storageKey?: string;
  onChange?: () => void;
};

export type Splitter = {
  isCollapsed(): boolean;
  setCollapsed(collapsed: boolean): void;
  toggle(): void;
  reset(): void;
};

type Persisted = { size: number; collapsed: boolean };

export function makeSplitter(handle: HTMLElement, opts: SplitterOptions): Splitter {
  const { axis, panel, side, min } = opts;
  handle.dataset.axis = axis;
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", axis === "x" ? "vertical" : "horizontal");

  const persisted = opts.storageKey ? loadJson<Persisted>(opts.storageKey) : null;
  let size = typeof persisted?.size === "number" ? persisted.size : opts.size;
  let collapsed = persisted?.collapsed === true;

  const maxSize = () => Math.max(min, typeof opts.max === "function" ? opts.max() : opts.max);
  const clamp = (v: number) => Math.min(maxSize(), Math.max(min, v));

  function persist() {
    if (opts.storageKey) save(opts.storageKey, JSON.stringify({ size, collapsed } satisfies Persisted));
  }

  function apply() {
    panel.style.flexBasis = `${Math.round(clamp(size))}px`;
    panel.classList.toggle("is-collapsed", collapsed);
    handle.classList.toggle("is-collapsed", collapsed);
    handle.title = collapsed ? "↔" : "";
    opts.onChange?.();
  }

  function setCollapsed(next: boolean) {
    if (collapsed === next) return;
    collapsed = next;
    apply();
    persist();
  }

  let drag: { start: number; startSize: number; moved: boolean; wasCollapsed: boolean } | null = null;

  handle.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    handle.setPointerCapture(ev.pointerId);
    drag = {
      start: axis === "x" ? ev.clientX : ev.clientY,
      startSize: collapsed ? 0 : panel.getBoundingClientRect()[axis === "x" ? "width" : "height"],
      moved: false,
      wasCollapsed: collapsed,
    };
    handle.classList.add("is-dragging");
    document.body.classList.add("wb-resizing", `wb-resizing-${axis}`);
  });

  handle.addEventListener("pointermove", (ev) => {
    if (!drag) return;
    const pos = axis === "x" ? ev.clientX : ev.clientY;
    const delta = (pos - drag.start) * (side === "before" ? 1 : -1);
    if (!drag.moved && Math.abs(delta) < 3) return;
    drag.moved = true;
    const want = drag.startSize + delta;
    if (want < min * 0.5) {
      if (!collapsed) {
        collapsed = true;
        apply();
      }
      return;
    }
    collapsed = false;
    size = clamp(want);
    apply();
  });

  const end = () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    handle.classList.remove("is-dragging");
    document.body.classList.remove("wb-resizing", "wb-resizing-x", "wb-resizing-y");
    // 收起态下单击把手 = 展开
    if (!d.moved && d.wasCollapsed) {
      collapsed = false;
      apply();
    }
    persist();
  };
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
  handle.addEventListener("dblclick", () => setCollapsed(!collapsed));

  // 窗口变窄时把超出上限的面板压回来
  window.addEventListener("resize", () => {
    if (!collapsed && size > maxSize()) apply();
  });

  apply();

  return {
    isCollapsed: () => collapsed,
    setCollapsed,
    toggle: () => setCollapsed(!collapsed),
    reset() {
      size = opts.size;
      collapsed = false;
      apply();
      persist();
    },
  };
}
