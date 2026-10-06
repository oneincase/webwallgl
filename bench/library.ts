/**
 * 左侧壁纸库：从宿主后端（/api/library）读本机库，按类型 / 关键字过滤，
 * 右键菜单提供在编辑器中打开、在文件夹中显示、删除。
 *
 * 测试台默认总有宿主后端（pnpm dev 或桌面版）；连不上时列表给出明确的空态与重试。
 */

import { $, emit, kindOf, on, state, type LibraryItem, type WallpaperKind } from "./store";
import { t } from "./i18n";
import { MEDIA_BASE } from "./bridge";
import { log } from "./console";
import { clearSelection, openInEditor, select } from "./session";
import { setStatusCount, syncBackend } from "./statusbar";
import { openMenu } from "../shared/workbench/menu";
import { load, save } from "../shared/workbench/storage";

const listEl = $<HTMLUListElement>("#list");
const filterEl = $<HTMLInputElement>("#filter");
const typeFilterEl = $<HTMLElement>("#type-filter");
const libPathEl = $<HTMLParagraphElement>("#libpath");
const libCountEl = $<HTMLElement>("#lib-count");
const pickLibEl = $<HTMLButtonElement>("#pick-lib");
const refreshEl = $<HTMLButtonElement>("#lib-refresh");

const TYPE_KEY = "we-bench-type-filter";
const LIB_DIR_KEY = "we-bench-library-dir";

let typeFilter: WallpaperKind = "scene";

function setBackend(next: typeof state.backend) {
  if (state.backend === next) return;
  state.backend = next;
  pickLibEl.disabled = next === "down";
  emit("backend", next);
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ---------- 类型筛选（scene / web / video 三选一） ----------

function setTypeFilter(kind: WallpaperKind) {
  typeFilter = kind;
  for (const btn of typeFilterEl.querySelectorAll<HTMLButtonElement>(".seg-btn")) {
    const active = btn.dataset.type === kind;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-checked", active ? "true" : "false");
  }
  save(TYPE_KEY, kind);
  renderList();
}

typeFilterEl.onclick = (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".seg-btn");
  const kind = btn?.dataset.type as WallpaperKind | undefined;
  if (kind && kind !== typeFilter) setTypeFilter(kind);
};

filterEl.oninput = () => renderList();

// ---------- 载入 ----------

async function setLibraryDir(dir: string) {
  const data = await postJson<{ dir?: string }>("/api/library-dir", { dir });
  save(LIB_DIR_KEY, data.dir ?? dir);
}

export async function loadLibrary() {
  try {
    const res = await fetch("/api/library", { headers: { accept: "application/json" } });
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("application/json")) {
      throw new Error(`HTTP ${res.status}`);
    }
    const data = (await res.json()) as { dir: string; items: LibraryItem[]; error?: string };
    state.libDir = data.dir;
    libPathEl.textContent = data.dir;
    libPathEl.title = data.dir;
    setBackend("ok");
    syncBackend();
    if (data.error) {
      log(data.error, "error");
      return;
    }
    state.items = data.items;
    const n = (k: WallpaperKind) => state.items.filter((i) => kindOf(i) === k).length;
    log(t("log.libLoaded", { n: state.items.length, s: n("scene"), w: n("web"), v: n("video") }));
  } catch (e) {
    state.items = [];
    setBackend("down");
    log(t("err.backend", { msg: (e as Error).message }), "error");
  }
  renderList();
  emit("library");
}

pickLibEl.onclick = async () => {
  pickLibEl.disabled = true;
  try {
    const data = await postJson<{ dir?: string; cancelled?: boolean; unsupported?: boolean }>("/api/library-dir", {
      pick: true,
    });
    if (data.cancelled) {
      if (!data.unsupported) return;
      const typed = window.prompt(t("prompt.libDir"), libPathEl.textContent || "");
      if (!typed) return;
      await setLibraryDir(typed.trim());
    } else if (data.dir) {
      save(LIB_DIR_KEY, data.dir);
    }
    clearSelection();
    await loadLibrary();
  } catch (e) {
    log(t("err.pickLib", { msg: (e as Error).message }), "error");
  } finally {
    pickLibEl.disabled = state.backend === "down";
  }
};

export function pickLibrary() {
  pickLibEl.click();
}

refreshEl.onclick = () => void loadLibrary();

// ---------- 列表 ----------

function backendDownEl(): HTMLElement {
  const li = document.createElement("li");
  li.className = "lib-empty wb-empty";
  const msg = document.createElement("span");
  msg.textContent = t("backend.down");
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "wb-btn is-filled";
  retry.textContent = t("backend.retry");
  retry.onclick = () => void loadLibrary();
  li.append(msg, retry);
  return li;
}

export function renderList() {
  const kw = filterEl.value.trim().toLowerCase();
  listEl.textContent = "";
  if (state.backend === "down") {
    listEl.appendChild(backendDownEl());
    libCountEl.hidden = true;
    setStatusCount(0);
    return;
  }
  let shown = 0;
  for (const it of state.items) {
    if (kindOf(it) !== typeFilter) continue;
    if (kw && !`${it.title} ${it.itemId}`.toLowerCase().includes(kw)) continue;
    shown++;
    const li = document.createElement("li");
    li.dataset.id = it.itemId;
    if (state.selected?.itemId === it.itemId) li.classList.add("active");
    const thumb = document.createElement("div");
    thumb.className = "thumb";
    if (it.preview) {
      const img = document.createElement("img");
      img.loading = "lazy";
      img.src = `${MEDIA_BASE}/${it.itemId}/${it.preview}`;
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
    const propCount = it.properties ? Object.keys(it.properties).length : 0;
    sub.textContent = `${it.type}${propCount ? ` · ${propCount} 属性` : ""} · ${it.itemId}`;
    meta.append(title, sub);
    li.append(thumb, meta);
    li.onclick = () => {
      if (state.selected?.itemId !== it.itemId) select(it);
    };
    li.oncontextmenu = (e) => {
      e.preventDefault();
      // 右键未选中的条目先选中：菜单动作始终针对高亮条目（资源管理器惯例）
      if (state.selected?.itemId !== it.itemId) select(it);
      openItemMenu(it, e.clientX, e.clientY);
    };
    listEl.appendChild(li);
  }
  libCountEl.hidden = shown === 0;
  libCountEl.textContent = String(shown);
  setStatusCount(shown);
}

function syncActive() {
  for (const li of listEl.querySelectorAll<HTMLElement>("li[data-id]")) {
    li.classList.toggle("active", li.dataset.id === state.selected?.itemId);
  }
}

// ---------- 条目操作 ----------

export async function revealItem(itemId: string) {
  try {
    await postJson("/api/reveal", { itemId });
    log(t("ok.reveal", { id: itemId }));
  } catch (e) {
    log(t("err.reveal", { msg: (e as Error).message }), "error");
  }
}

export async function deleteItem(it: LibraryItem) {
  if (!window.confirm(t("confirm.delete", { title: it.title, id: it.itemId }))) return;
  try {
    await postJson("/api/delete", { itemId: it.itemId });
    log(t("ok.delete", { id: it.itemId }));
    if (state.selected?.itemId === it.itemId) clearSelection(); // 正在预览的壁纸被删：清空舞台
    await loadLibrary();
  } catch (e) {
    log(t("err.delete", { msg: (e as Error).message }), "error");
  }
}

const svg = (d: string) => () => {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  el.setAttribute("viewBox", "0 0 16 16");
  el.setAttribute("class", "i i-sm");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", d);
  el.appendChild(path);
  return el;
};

export const ICONS = {
  editor: svg("M10.5 2.5l3 3L6 13H3v-3z M9 4l3 3"),
  folder: svg("M2 4.5a1 1 0 0 1 1-1h3.2l1.5 1.5H13a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"),
  trash: svg("M3 4h10M6.5 4V3h3v1M4.5 4.5V13a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1V4.5M6.8 7v4.5M9.2 7v4.5"),
  external: svg("M9.5 2.5h4v4 M13.5 2.5L8 8 M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3"),
};

function openItemMenu(it: LibraryItem, x: number, y: number) {
  openMenu(
    [
      { label: () => t("ctx.openEditor"), icon: ICONS.editor, action: () => openInEditor(it.itemId) },
      { label: () => t("reveal.open"), icon: ICONS.folder, action: () => void revealItem(it.itemId) },
      "sep",
      { label: () => t("ctx.delete"), icon: ICONS.trash, danger: true, action: () => void deleteItem(it) },
    ],
    x,
    y,
  );
}

// ---------- 启动 ----------

export async function bootLibrary() {
  const savedType = load(TYPE_KEY);
  if (savedType === "scene" || savedType === "web" || savedType === "video") setTypeFilter(savedType);
  const savedDir = load(LIB_DIR_KEY);
  if (savedDir) {
    try {
      await setLibraryDir(savedDir);
    } catch {
      /* 目录失效或后端没起：交给 loadLibrary 判定 */
    }
  }
  await loadLibrary();
}

on("selection", syncActive);
