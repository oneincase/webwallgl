// 壁纸库面板（左栏「壁纸库」标签）：读宿主 /api/library，按类型 / 关键字过滤，
// 点条目直接在编辑器里打开；右键：在文件夹中显示 / 新窗口播放 / 删除。
// 宿主没起（纯静态部署）时给出空态与重试，不影响编辑器其余功能。

import { openMenu } from "../../shared/workbench/menu";
import { load, save } from "../../shared/workbench/storage";
import type { LibraryItem } from "../open";
import { confirmDialog } from "./confirm";

export type LibraryKind = "scene" | "web" | "video";

export function libraryKindOf(it: LibraryItem): LibraryKind | null {
  if (it.hasScene || it.hasLooseScene) return "scene";
  const t = it.type.toLowerCase();
  if (t === "web") return "web";
  if (t === "video" || t === "gif") return "video";
  return null;
}

export type LibraryPanelOptions = {
  list: HTMLUListElement;
  filter: HTMLInputElement;
  typeFilter: HTMLElement;
  path: HTMLElement;
  count: HTMLElement;
  refresh: HTMLButtonElement;
  pickDir: HTMLButtonElement;
  mediaBase: string;
  t: (key: string, params?: Record<string, string | number>) => string;
  log: (msg: string, level?: "info" | "warn" | "error") => void;
  open: (it: LibraryItem) => void;
  /** 在新窗口全屏播放（渲染器页） */
  play: (it: LibraryItem) => void;
};

export type LibraryPanel = {
  load(): Promise<void>;
  render(): void;
  /** 高亮当前打开的条目（null = 当前文档不是库条目） */
  setActive(itemId: string | null): void;
  find(itemId: string): LibraryItem | undefined;
  readonly backendUp: boolean;
};

const TYPE_KEY = "webwallgl-library-type";
const DIR_KEY = "webwallgl-library-dir";

const svg = (d: string) => () => {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  el.setAttribute("viewBox", "0 0 16 16");
  el.setAttribute("class", "i i-sm");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", d);
  el.appendChild(path);
  return el;
};
const ICONS = {
  open: svg("M10.5 2.5l3 3L6 13H3v-3z M9 4l3 3"),
  play: svg("M9.5 2.5h4v4 M13.5 2.5L8 8 M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3"),
  folder: svg("M2 4.5a1 1 0 0 1 1-1h3.2l1.5 1.5H13a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"),
  trash: svg("M3 4h10M6.5 4V3h3v1M4.5 4.5V13a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1V4.5M6.8 7v4.5M9.2 7v4.5"),
};

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export function mountLibraryPanel(o: LibraryPanelOptions): LibraryPanel {
  let items: LibraryItem[] = [];
  let backend: "unknown" | "ok" | "down" = "unknown";
  let active: string | null = null;
  const saved = load(TYPE_KEY);
  let kind: LibraryKind = saved === "web" || saved === "video" ? saved : "scene";

  function syncTypeButtons() {
    for (const b of o.typeFilter.querySelectorAll<HTMLButtonElement>(".seg-btn")) {
      const on = b.dataset.type === kind;
      b.classList.toggle("active", on);
      b.setAttribute("aria-checked", String(on));
    }
  }

  o.typeFilter.onclick = (e) => {
    const k = (e.target as HTMLElement).closest<HTMLButtonElement>(".seg-btn")?.dataset.type as LibraryKind | undefined;
    if (!k || k === kind) return;
    kind = k;
    save(TYPE_KEY, k);
    syncTypeButtons();
    render(true);
  };
  o.filter.oninput = () => render(true);
  o.refresh.onclick = () => void loadLibrary();
  o.pickDir.onclick = () => void pickDir();

  async function loadLibrary() {
    try {
      const res = await fetch("/api/library", { headers: { accept: "application/json" } });
      if (!res.ok || !(res.headers.get("content-type") ?? "").includes("application/json")) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { dir: string; items: LibraryItem[]; error?: string };
      backend = "ok";
      o.path.textContent = data.dir;
      o.path.title = data.dir;
      if (data.error) o.log(data.error, "error");
      items = data.items ?? [];
      const n = (k: LibraryKind) => items.filter((i) => libraryKindOf(i) === k).length;
      o.log(o.t("log.libLoaded", { n: items.length, s: n("scene"), w: n("web"), v: n("video") }));
    } catch (e) {
      items = [];
      backend = "down";
      o.log(o.t("err.backend", { msg: (e as Error).message }), "warn");
    }
    o.pickDir.disabled = backend === "down";
    render(true);
  }

  async function pickDir() {
    o.pickDir.disabled = true;
    try {
      const data = await postJson<{ dir?: string; cancelled?: boolean; unsupported?: boolean }>("/api/library-dir", { pick: true });
      if (data.cancelled) {
        if (!data.unsupported) return;
        const typed = window.prompt(o.t("prompt.libDir"), o.path.textContent || "");
        if (!typed) return;
        const r = await postJson<{ dir?: string }>("/api/library-dir", { dir: typed.trim() });
        save(DIR_KEY, r.dir ?? typed.trim());
      } else if (data.dir) {
        save(DIR_KEY, data.dir);
      }
      await loadLibrary();
    } catch (e) {
      o.log(o.t("err.pickLib", { msg: (e as Error).message }), "error");
    } finally {
      o.pickDir.disabled = backend === "down";
    }
  }

  async function reveal(it: LibraryItem) {
    try {
      await postJson("/api/reveal", { itemId: it.itemId });
      o.log(o.t("ok.reveal", { id: it.itemId }));
    } catch (e) {
      o.log(o.t("err.reveal", { msg: (e as Error).message }), "error");
    }
  }

  async function remove(it: LibraryItem) {
    const yes = await confirmDialog({
      title: o.t("dlg.deleteTitle"),
      body: o.t("confirm.delete", { title: it.title, id: it.itemId }),
      ok: o.t("dlg.deleteOk"),
      danger: true,
    });
    if (!yes) return;
    try {
      await postJson("/api/delete", { itemId: it.itemId });
      o.log(o.t("ok.delete", { id: it.itemId }));
      await loadLibrary();
    } catch (e) {
      o.log(o.t("err.delete", { msg: (e as Error).message }), "error");
    }
  }

  // 列表虚拟化：363 条全量建 DOM 会有 2000+ 节点、滚动掉帧。这里只渲染视窗内的行，
  // 上下各用一个等高占位 <li> 撑住滚动条（行高固定：缩略图 32 + 上下 padding 4+4）。
  const ROW_H = 40;
  const OVERSCAN = 6;
  let renderQueued = false;

  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      render();
    });
  }

  o.list.addEventListener("scroll", scheduleRender);

  function render(resetScroll = false) {
    // 滚动位置必须在清空 DOM **之前**读出来：清空会让滚动高度归零，
    // 浏览器顺手把 scrollTop 钳到 0，之后再读就永远是 0（列表会一直跳回顶部）。
    const top = resetScroll ? 0 : o.list.scrollTop;
    const kw = o.filter.value.trim().toLowerCase();
    o.list.textContent = "";
    if (backend === "down") {
      const li = document.createElement("li");
      li.className = "lib-empty wb-empty";
      const msg = document.createElement("span");
      msg.textContent = o.t("backend.down");
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "wb-btn is-filled";
      retry.textContent = o.t("backend.retry");
      retry.onclick = () => void loadLibrary();
      li.append(msg, retry);
      o.list.appendChild(li);
      o.count.hidden = true;
      return;
    }
    const match = items.filter((it) => {
      if (libraryKindOf(it) !== kind) return false;
      if (kw && !`${it.title} ${it.itemId}`.toLowerCase().includes(kw)) return false;
      return true;
    });
    o.count.hidden = match.length === 0;
    o.count.textContent = String(match.length);
    const viewH = o.list.clientHeight || 400;
    const start = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
    const end = Math.min(match.length, Math.ceil((top + viewH) / ROW_H) + OVERSCAN);
    const pad = (h: number) => {
      const li = document.createElement("li");
      li.className = "lib-pad";
      li.setAttribute("aria-hidden", "true");
      li.style.height = `${h}px`;
      return li;
    };
    if (start > 0) o.list.appendChild(pad(start * ROW_H));
    for (const it of match.slice(start, end)) {
      const li = document.createElement("li");
      li.dataset.id = it.itemId;
      li.tabIndex = 0;
      li.setAttribute("role", "option");
      li.classList.toggle("active", it.itemId === active);
      const thumb = document.createElement("div");
      thumb.className = "thumb";
      if (it.preview) {
        const img = document.createElement("img");
        img.loading = "lazy";
        img.src = `${o.mediaBase}/${it.itemId}/${it.preview}`;
        img.alt = "";
        thumb.appendChild(img);
      }
      const meta = document.createElement("div");
      meta.className = "meta";
      const title = document.createElement("span");
      title.className = "title";
      title.textContent = it.title;
      const sub = document.createElement("span");
      sub.className = "sub";
      const props = it.properties ? Object.keys(it.properties).length : 0;
      sub.textContent = [it.type, props ? o.t("lib.props", { n: props }) : "", it.itemId].filter(Boolean).join(" · ");
      meta.append(title, sub);
      li.append(thumb, meta);
      li.onclick = () => {
        if (it.itemId !== active) o.open(it);
      };
      li.onkeydown = (e) => {
        if (e.key === "Enter" && it.itemId !== active) o.open(it);
      };
      li.oncontextmenu = (e) => {
        e.preventDefault();
        openMenu(
          [
            { label: () => o.t("lib.open"), icon: ICONS.open, action: () => o.open(it) },
            { label: () => o.t("lib.play"), icon: ICONS.play, action: () => o.play(it) },
            { label: () => o.t("reveal.open"), icon: ICONS.folder, action: () => void reveal(it) },
            "sep",
            { label: () => o.t("ctx.delete"), icon: ICONS.trash, danger: true, action: () => void remove(it) },
          ],
          e.clientX,
          e.clientY,
        );
      };
      o.list.appendChild(li);
    }
    if (end < match.length) o.list.appendChild(pad((match.length - end) * ROW_H));
    // 重建后把位置放回去：上下占位行已经撑出原来的高度，赋值不会被打回。
    if (o.list.scrollTop !== top) o.list.scrollTop = top;
  }

  syncTypeButtons();
  return {
    async load() {
      const dir = load(DIR_KEY);
      if (dir) await postJson("/api/library-dir", { dir }).catch(() => {});
      await loadLibrary();
    },
    render,
    setActive(id) {
      active = id;
      for (const li of o.list.querySelectorAll<HTMLElement>("li[data-id]")) li.classList.toggle("active", li.dataset.id === id);
    },
    find: (id) => items.find((it) => it.itemId === id),
    get backendUp() {
      return backend === "ok";
    },
  };
}
