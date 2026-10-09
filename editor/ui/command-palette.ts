// 命令面板 + 动态快捷键总览（M9 / C4）。
//
// 两条硬规则：
//  1) 面板里的命令**只从注册表枚举**（commands.registry.list()），这里没有第二份手写命令表；
//  2) 快捷键总览同样由 CommandDef 生成，不再是人工维护的静态清单。
// 展示信息同样由注册表本身给出：CommandDef.title / category 可显式覆盖（字符串 = 词条名，对象 = 中英双语），
// 缺省按 id 约定推出 `cmd.<id>`（标题）与 `cmd.cat.<id 首段>`（分类），词条补在 editor/i18n.ts；
// 漏了词条由 orphanCommands 的判据抓（面板会退化成裸 id /「其它」）。
// 面板只依赖传入的 DOM 与文案函数，不碰 main.ts 状态（同 editor/ui/plugin-panel.ts 的约定）。

import type { CommandDef, CommandService } from "../services/types";

/** 「其它」分类词条：命令没声明 category 时归到这里 */
export const OTHER_CATEGORY_KEY = "cmd.cat.other";

export type CommandTextDeps = {
  /** i18n 取值：词条缺失时函数原样返回 key */
  t(key: string, params?: Record<string, string | number>): string;
  /** 词条是否存在（用来区分「词条名」和「字面量标题」） */
  has(key: string): boolean;
  /** 双语对象取值 */
  text(v: string | Record<string, string> | undefined, fallback: string): string;
};

/**
 * 展示词条名的约定（M9/C4）：面板只从命令注册表枚举，展示信息**不另存一张表**——
 *  - 标题：`CommandDef.title` 显式给（字符串 = 词条名，对象 = 中英双语）；缺省由 id 推出 `cmd.<id>`
 *  - 分类：`CommandDef.category` 显式给；缺省由 id 的首段推出 `cmd.cat.<首段>`（edit.undo → cmd.cat.edit）
 * 取不到词条时退到「其它」/裸 id，所以内置 7 条只需在 editor/i18n.ts 里补齐词条。
 */
export function titleKeyOf(def: Pick<CommandDef, "id" | "title">): string {
  if (typeof def.title === "string") return def.title;
  return `cmd.${def.id}`;
}

export function categoryKeyOf(def: Pick<CommandDef, "id" | "category">): string {
  if (typeof def.category === "string") return def.category;
  const ns = def.id.split(".")[0];
  return ns ? `cmd.cat.${ns}` : OTHER_CATEGORY_KEY;
}

/** 一条命令的展示标题：双语对象 → text()；字符串 → 先当词条再当字面量；未给 → `cmd.<id>` 词条、再退 id */
export function commandTitle(def: Pick<CommandDef, "id" | "title">, deps: CommandTextDeps): string {
  if (def.title !== undefined && typeof def.title === "object") return deps.text(def.title, def.id);
  const key = titleKeyOf(def);
  if (deps.has(key)) return deps.t(key);
  return typeof def.title === "string" ? def.title : def.id;
}

/** 一条命令的分类：显式/推导的词条都查不到就归到「其它」 */
export function commandCategory(def: Pick<CommandDef, "id" | "category">, deps: CommandTextDeps): string {
  if (def.category !== undefined && typeof def.category === "object") return deps.text(def.category, deps.t(OTHER_CATEGORY_KEY));
  const key = categoryKeyOf(def);
  if (key !== OTHER_CATEGORY_KEY && deps.has(key)) return deps.t(key);
  return deps.t(OTHER_CATEGORY_KEY);
}

/** keys 统一成数组 */
export function commandKeys(def: Pick<CommandDef, "keys">): string[] {
  const k = def.keys;
  if (k === undefined) return [];
  return typeof k === "string" ? [k] : [...k];
}

/** 修饰键的固定排列顺序 ⇧⌃⌥⌘（mod 符号由调用方决定：macOS ⌘ / 其它 Ctrl） */
const MOD_ORDER = ["shift", "ctrl", "alt", "mod"] as const;

/** 「Mod+Shift+Z」→「⇧⌘Z」；认不出的键原样（F2 / Delete / Backspace） */
export function keyChordLabel(chord: string, mod = "⌘"): string {
  const marks = new Map<string, string>();
  const rest: string[] = [];
  for (const raw of chord.split("+")) {
    const p = raw.trim();
    if (!p) continue;
    const low = p.toLowerCase();
    if (low === "mod" || low === "meta" || low === "cmd" || low === "command") marks.set("mod", mod);
    else if (low === "shift") marks.set("shift", "⇧");
    else if (low === "ctrl" || low === "control") marks.set("ctrl", "⌃");
    else if (low === "alt" || low === "option") marks.set("alt", "⌥");
    else rest.push(p.length === 1 ? p.toUpperCase() : p);
  }
  return MOD_ORDER.map((k) => marks.get(k) ?? "").join("") + rest.join("+");
}

/** 多个等价键 → 「⇧⌘Z / ⌘Y」 */
export function keysLabel(keys: readonly string[], mod = "⌘"): string {
  return keys.map((k) => keyChordLabel(k, mod)).join(" / ");
}

export type PaletteItem = {
  id: string;
  title: string;
  category: string;
  keys: string[];
  keyLabel: string;
  /** when() 为假 = 当前上下文不可用 */
  enabled: boolean;
  /** 需要参数：面板里列出但不可直接执行 */
  needsArg: boolean;
};

export type PaletteDeps = CommandTextDeps & { mod?: string };

/** 一条命令 → 面板条目（when() 抛错按不可用处理，面板不该被插件拖崩） */
export function paletteItem(def: CommandDef, deps: PaletteDeps): PaletteItem {
  const keys = commandKeys(def);
  let enabled = true;
  if (def.when) {
    try {
      enabled = Boolean(def.when());
    } catch {
      enabled = false;
    }
  }
  return {
    id: def.id,
    title: commandTitle(def, deps),
    category: commandCategory(def, deps),
    keys,
    keyLabel: keysLabel(keys, deps.mod),
    enabled,
    needsArg: def.needsArg === true,
  };
}

/** 注册表列表 → 面板条目（保持注册顺序） */
export function paletteItems(list: readonly CommandDef[], deps: PaletteDeps): PaletteItem[] {
  return list.map((d) => paletteItem(d, deps));
}

/** 过滤：空格分词，每个词都要命中 id / 标题 / 分类 / 快捷键（大小写不敏感） */
export function filterItems(items: readonly PaletteItem[], query: string): PaletteItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...items];
  return items.filter((it) => {
    const hay = `${it.id} ${it.title} ${it.category} ${it.keys.join(" ")} ${it.keyLabel}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** ↑↓ 环绕移动；没有条目返回 -1 */
export function moveSelection(index: number, delta: number, count: number): number {
  if (count <= 0) return -1;
  const from = index < 0 ? (delta > 0 ? -1 : 0) : index;
  return (((from + delta) % count) + count) % count;
}

export type ShortcutRow = { id: string; keys: string; title: string };
export type ShortcutGroup = { category: string; rows: ShortcutRow[] };

/** 快捷键总览：只列有键的命令，按分类分组（分类顺序 = 首次出现顺序） */
export function shortcutGroups(items: readonly PaletteItem[]): ShortcutGroup[] {
  const groups = new Map<string, ShortcutRow[]>();
  for (const it of items) {
    if (!it.keys.length) continue;
    const rows = groups.get(it.category);
    const row = { id: it.id, keys: it.keyLabel, title: it.title };
    if (rows) rows.push(row);
    else groups.set(it.category, [row]);
  }
  return [...groups].map(([category, rows]) => ({ category, rows }));
}

/**
 * 无孤儿文案：标题词条或分类词条在词典里查不到的命令 id
 * （面板会退化成裸 id / 「其它」，说明注册命令时漏了 editor/i18n.ts 的双语词条）。
 * 判据把 main.ts 里 7 条 cmd({...}) 注册进真实注册表后断言它是空的。
 */
export function orphanCommands(registered: readonly CommandDef[], deps: { has(key: string): boolean }): string[] {
  return registered
    .filter((d) => !deps.has(titleKeyOf(d)) || (categoryKeyOf(d) !== OTHER_CATEGORY_KEY && !deps.has(categoryKeyOf(d))))
    .map((d) => d.id);
}

export type CommandPaletteOptions = {
  dialog: HTMLDialogElement;
  input: HTMLInputElement;
  list: HTMLElement;
  /** 「快捷键总览」容器：由本模块填充，宿主不需要自己写行 */
  shortcuts: HTMLElement;
  /** 切换「命令 / 快捷键总览」的按钮 */
  keysButton: HTMLButtonElement;
  /** 关闭按钮（可选） */
  closeButton?: HTMLButtonElement;
  commands: Pick<CommandService, "registry" | "exec">;
  t(key: string, params?: Record<string, string | number>): string;
  has(key: string): boolean;
  text(v: string | Record<string, string> | undefined, fallback: string): string;
  /** Mod 的显示符号（macOS ⌘ / 其它 Ctrl） */
  mod?: string;
  log?(msg: string): void;
};

export type CommandPalette = {
  open(query?: string): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  /** 语言切换 / 注册表变化后重建（面板开着时立即重绘） */
  refresh(): void;
  /** 面板内的键盘（↑↓ / Enter / Esc）；返回是否已处理 */
  onKeyDown(e: KeyboardEvent): boolean;
  /** 当前枚举出的条目（判据与调试用） */
  items(): PaletteItem[];
  dispose(): void;
};

const optId = (id: string) => `ed-palette-opt-${id.replace(/[^A-Za-z0-9_-]/g, "-")}`;

/** 把面板挂到宿主给的 DOM 上；命令枚举只走 o.commands.registry */
export function createCommandPalette(o: CommandPaletteOptions): CommandPalette {
  const deps: PaletteDeps = { t: o.t, has: o.has, text: o.text, mod: o.mod };
  let items: PaletteItem[] = [];
  let shown: PaletteItem[] = [];
  let active = -1;
  let keysOpen = false;
  let hintTimer: ReturnType<typeof setTimeout> | null = null;

  const hint = (msg: string) => {
    const foot = o.dialog.querySelector<HTMLElement>(".ed-palette-foot");
    if (!foot) return;
    if (hintTimer) clearTimeout(hintTimer);
    foot.textContent = msg;
    hintTimer = setTimeout(() => {
      foot.textContent = o.t("pal.hint");
      hintTimer = null;
    }, 2400);
  };

  const scrollActive = () => {
    const row = o.list.querySelector<HTMLElement>(".ed-palette-row.on");
    row?.scrollIntoView({ block: "nearest" });
  };

  const renderList = () => {
    shown = filterItems(items, o.input.value);
    if (!shown.length) active = -1;
    else if (active < 0 || active >= shown.length) active = 0;
    o.list.textContent = "";
    if (!shown.length) {
      const empty = document.createElement("div");
      empty.className = "ed-palette-empty";
      empty.textContent = o.t("pal.empty");
      o.list.appendChild(empty);
      o.input.removeAttribute("aria-activedescendant");
      return;
    }
    shown.forEach((it, i) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "ed-palette-row";
      row.id = optId(it.id);
      row.dataset.command = it.id;
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(i === active));
      const off = it.needsArg || !it.enabled;
      if (off) {
        row.classList.add("is-off");
        row.setAttribute("aria-disabled", "true");
      }
      if (i === active) row.classList.add("on");
      const name = document.createElement("span");
      name.className = "ed-palette-name";
      name.textContent = it.title;
      const id = document.createElement("span");
      id.className = "ed-palette-id";
      id.textContent = it.id;
      const cat = document.createElement("span");
      cat.className = "ed-palette-cat";
      cat.textContent = it.category;
      const kbd = document.createElement("kbd");
      kbd.className = "ed-palette-kbd";
      kbd.textContent = it.keyLabel || (it.needsArg ? o.t("pal.needArg") : "");
      row.append(name, id, cat, kbd);
      row.addEventListener("click", () => runItem(it));
      o.list.appendChild(row);
    });
    const cur = shown[active];
    if (cur) o.input.setAttribute("aria-activedescendant", optId(cur.id));
    else o.input.removeAttribute("aria-activedescendant");
    scrollActive();
  };

  const renderShortcuts = () => {
    o.shortcuts.textContent = "";
    const groups = shortcutGroups(items);
    if (!groups.length) {
      const empty = document.createElement("div");
      empty.className = "ed-palette-empty";
      empty.textContent = o.t("pal.empty");
      o.shortcuts.appendChild(empty);
      return;
    }
    for (const g of groups) {
      const title = document.createElement("div");
      title.className = "ed-palette-group";
      title.textContent = g.category;
      const box = document.createElement("div");
      box.className = "ed-palette-keys-table";
      for (const r of g.rows) {
        const row = document.createElement("div");
        row.className = "ed-palette-key-row";
        row.dataset.command = r.id;
        const kbd = document.createElement("kbd");
        kbd.textContent = r.keys;
        const name = document.createElement("span");
        name.textContent = r.title;
        row.append(kbd, name);
        box.appendChild(row);
      }
      o.shortcuts.append(title, box);
    }
  };

  const showKeys = (on: boolean) => {
    keysOpen = on;
    o.list.hidden = on;
    o.shortcuts.hidden = !on;
    o.keysButton.setAttribute("aria-pressed", String(on));
    // 只读而不是 disabled：焦点不离开输入框，Esc / ⌘K 才不会丢
    o.input.readOnly = on;
  };

  const refresh = () => {
    items = paletteItems(o.commands.registry.list(), deps);
    renderShortcuts();
    if (isOpen() && !keysOpen) renderList();
  };

  const runItem = (it: PaletteItem) => {
    if (it.needsArg) {
      hint(o.t("pal.needArgHint", { id: it.id }));
      return;
    }
    if (!it.enabled) {
      hint(o.t("pal.unavailable", { id: it.id }));
      return;
    }
    close();
    exec(it.id);
  };

  /** 执行：命令可能在渲染后被插件卸载，未知命令只记日志不抛 */
  const exec = (id: string) => {
    try {
      o.commands.exec(id);
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      o.log?.(`${o.t("pal.runFailed", { id })}: ${msg}`);
    }
  };

  const isOpen = () => o.dialog.open;

  const open = (query = "") => {
    refresh();
    showKeys(false);
    o.input.value = query;
    active = items.length ? 0 : -1;
    renderList();
    if (!o.dialog.open) {
      try {
        o.dialog.showModal();
      } catch {
        o.dialog.setAttribute("open", "");
      }
    }
    o.input.focus();
    o.input.select();
  };

  const close = () => {
    if (o.dialog.open) o.dialog.close();
    else o.dialog.removeAttribute("open");
    o.input.value = "";
    showKeys(false);
  };

  const onKeyDown = (e: KeyboardEvent): boolean => {
    if (!isOpen()) return false;
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
      e.preventDefault();
      close();
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return true;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (keysOpen || !shown.length) return true;
      active = moveSelection(active, e.key === "ArrowDown" ? 1 : -1, shown.length);
      renderList();
      return true;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const cur = shown[active];
      if (!keysOpen && cur) runItem(cur);
      return true;
    }
    return false;
  };

  // 原生 Esc / 点遮罩关闭时也要把状态收干净
  o.dialog.addEventListener("close", () => {
    o.input.value = "";
    showKeys(false);
  });
  o.dialog.addEventListener("click", (e) => {
    if (e.target === o.dialog) close();
  });
  o.input.addEventListener("input", () => {
    // 在「快捷键总览」里打字 = 回到命令列表接着过滤
    if (keysOpen && o.input.value) showKeys(false);
    active = 0;
    renderList();
  });
  o.dialog.addEventListener("keydown", (e) => void onKeyDown(e));
  o.keysButton.addEventListener("click", () => showKeys(!keysOpen));
  o.closeButton?.addEventListener("click", () => close());
  const offRegistry = o.commands.registry.onChange(refresh);
  refresh();

  return {
    open,
    close,
    toggle: () => (isOpen() ? close() : open()),
    isOpen,
    refresh,
    onKeyDown,
    items: () => items,
    dispose: () => {
      if (hintTimer) clearTimeout(hintTimer);
      offRegistry();
    },
  };
}
