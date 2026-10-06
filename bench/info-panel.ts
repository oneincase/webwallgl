/** 检视器「信息」：当前壁纸的预览图、元数据与常用操作 */

import { $, kindOf, on, state } from "./store";
import { t } from "./i18n";
import { MEDIA_BASE } from "./bridge";
import { ICONS, deleteItem, revealItem } from "./library";
import { openInNewWindow } from "./session";

const bodyEl = $<HTMLElement>("#info-body");

function row(dl: HTMLElement, key: string, value: string, mono = false) {
  const dt = document.createElement("dt");
  dt.textContent = t(key);
  const dd = document.createElement("dd");
  dd.textContent = value;
  if (mono) dd.classList.add("wb-mono");
  dl.append(dt, dd);
}

function action(label: string, icon: () => SVGElement, fn: () => void, danger = false): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `wb-btn is-filled${danger ? " is-danger" : ""}`;
  btn.append(icon(), document.createTextNode(label));
  btn.onclick = fn;
  return btn;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

export function renderInfo() {
  bodyEl.textContent = "";
  const it = state.selected;
  const file = state.localFile;
  if (!it && !file) {
    const empty = document.createElement("div");
    empty.className = "wb-empty";
    empty.textContent = t("info.empty");
    bodyEl.appendChild(empty);
    return;
  }

  const card = document.createElement("div");
  card.className = "info-card";

  const preview = document.createElement("div");
  preview.className = "info-preview";
  if (it?.preview) {
    const img = document.createElement("img");
    img.src = `${MEDIA_BASE}/${it.itemId}/${it.preview}`;
    img.alt = "";
    preview.appendChild(img);
  }
  card.appendChild(preview);

  const head = document.createElement("div");
  head.className = "info-head";
  const title = document.createElement("h3");
  title.textContent = it?.title ?? file!.name;
  const kind = document.createElement("span");
  kind.className = "wb-badge";
  kind.textContent = it ? (kindOf(it) ?? it.type) : t("info.local");
  head.append(title, kind);
  card.appendChild(head);

  const dl = document.createElement("dl");
  dl.className = "info-kv";
  if (it) {
    row(dl, "info.id", it.itemId, true);
    row(dl, "info.type", it.type);
    if (it.file) row(dl, "info.entry", it.file, true);
    if (it.hasScene || it.hasLooseScene) row(dl, "info.source", t(it.hasScene ? "info.srcPkg" : "info.srcLoose"));
    row(dl, "info.props", String(it.properties ? Object.keys(it.properties).length : 0));
  } else if (file) {
    row(dl, "info.title", file.name, true);
    row(dl, "info.size", formatBytes(file.size));
  }
  card.appendChild(dl);

  if (it) {
    const actions = document.createElement("div");
    actions.className = "info-actions";
    actions.append(
      action(t("menu.reveal"), ICONS.folder, () => void revealItem(it.itemId)),
      action(t("menu.newWindow"), ICONS.external, openInNewWindow),
      action(t("ctx.delete"), ICONS.trash, () => void deleteItem(it), true),
    );
    card.appendChild(actions);
  }
  bodyEl.appendChild(card);
}

on("selection", renderInfo);
renderInfo();
