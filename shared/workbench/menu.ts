/**
 * 标题栏菜单与弹出菜单（右键菜单共用同一套渲染）。
 *
 * 菜单项是数据：label / checked / disabled 都是函数，每次展开时求值，所以语言、
 * 运行态变化不用手动同步。将来套 Electron 时可以把同一份数据转成原生 Menu 模板。
 */

import { formatShortcut, matchShortcut } from "./platform";

export type MenuAction = {
  label: () => string;
  action: () => void;
  /** 快捷键，形如 "mod+o"、"mod+shift+r"（mod = macOS ⌘ / 其他 Ctrl） */
  keys?: string;
  checked?: () => boolean;
  disabled?: () => boolean;
  danger?: boolean;
  icon?: () => SVGElement;
};

export type MenuItem = MenuAction | "sep";

export type MenuDef = {
  label: () => string;
  items: MenuItem[];
};

let openPop: { el: HTMLElement; close: () => void } | null = null;

function closeOpen() {
  openPop?.close();
}

window.addEventListener(
  "pointerdown",
  (e) => {
    if (openPop && !openPop.el.contains(e.target as Node) && !(e.target as HTMLElement).closest?.(".wb-menu-btn")) {
      closeOpen();
    }
  },
  true,
);
window.addEventListener("blur", closeOpen);
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeOpen();
});

/** 在 (x, y) 弹出菜单；返回关闭函数 */
export function openMenu(items: MenuItem[], x: number, y: number, onClose?: () => void): () => void {
  closeOpen();
  const el = document.createElement("div");
  el.className = "wb-menu-pop";
  el.setAttribute("role", "menu");
  for (const it of items) {
    if (it === "sep") {
      const sep = document.createElement("div");
      sep.className = "wb-menu-sep";
      el.appendChild(sep);
      continue;
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `wb-menu-item${it.danger ? " danger" : ""}`;
    btn.setAttribute("role", it.checked ? "menuitemcheckbox" : "menuitem");
    btn.disabled = it.disabled?.() ?? false;
    const check = document.createElement("span");
    check.className = "wb-menu-check";
    if (it.icon) check.appendChild(it.icon());
    else if (it.checked?.()) check.textContent = "✓";
    const label = document.createElement("span");
    label.textContent = it.label();
    const kbd = document.createElement("span");
    kbd.className = "wb-kbd";
    kbd.textContent = it.keys ? formatShortcut(it.keys) : "";
    btn.append(check, label, kbd);
    btn.onclick = () => {
      close();
      it.action();
    };
    el.appendChild(btn);
  }
  document.body.appendChild(el);
  const r = el.getBoundingClientRect();
  el.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`;
  el.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 4))}px`;

  function close() {
    if (openPop?.el !== el) return;
    openPop = null;
    el.remove();
    onClose?.();
  }
  openPop = { el, close };
  return close;
}

/** 渲染标题栏菜单条；返回 refresh（语言切换后重刷顶层标签） */
export function createMenubar(host: HTMLElement, menus: MenuDef[]) {
  host.textContent = "";
  host.setAttribute("role", "menubar");
  const buttons: HTMLButtonElement[] = [];
  let active = -1;

  const show = (i: number) => {
    const btn = buttons[i];
    const r = btn.getBoundingClientRect();
    active = i;
    for (const b of buttons) b.classList.toggle("is-open", b === btn);
    openMenu(menus[i].items, r.left, r.bottom + 4, () => {
      if (active === i) {
        active = -1;
        btn.classList.remove("is-open");
      }
    });
  };

  menus.forEach((m, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "wb-menu-btn";
    btn.setAttribute("aria-haspopup", "menu");
    btn.textContent = m.label();
    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      if (active === i) closeOpen();
      else show(i);
    });
    // 菜单展开时滑到相邻顶层项直接切换（原生菜单栏手感）
    btn.addEventListener("pointerenter", () => {
      if (active !== -1 && active !== i) show(i);
    });
    buttons.push(btn);
    host.appendChild(btn);
  });

  window.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    const target = e.target as HTMLElement | null;
    if (target && (target.isContentEditable || /^(INPUT|TEXTAREA)$/.test(target.tagName)) && !e.shiftKey) return;
    for (const m of menus) {
      for (const it of m.items) {
        if (it === "sep" || !it.keys || !matchShortcut(e, it.keys)) continue;
        if (it.disabled?.()) return;
        e.preventDefault();
        closeOpen();
        it.action();
        return;
      }
    }
  });

  return {
    refresh() {
      menus.forEach((m, i) => (buttons[i].textContent = m.label()));
    },
  };
}
