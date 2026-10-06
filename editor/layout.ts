/**
 * 编辑器面板布局：左列（壁纸库 / 图层上下可调）、右检视器、底控制台的分隔条，
 * 尺寸记在 localStorage。视口尺寸变化由 main.ts 的 ResizeObserver 接手重排舞台。
 */

import { makeSplitter } from "../shared/workbench/splitter";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

const workbenchEl = $("#ed-workbench");
const leftColEl = $("#ed-left");
const centerColEl = $("#ed-center").parentElement!;

const CENTER_MIN_W = 360;
const CENTER_MIN_H = 220;
const LAYERS_MIN_H = 140;

function dockWidth(el: HTMLElement) {
  return el.classList.contains("is-collapsed") ? 0 : el.getBoundingClientRect().width;
}

const left = makeSplitter($("#ed-split-left"), {
  axis: "x",
  panel: leftColEl,
  side: "before",
  size: 280,
  min: 200,
  max: () => workbenchEl.clientWidth - CENTER_MIN_W - dockWidth($("#ed-right")),
  storageKey: "we-editor-layout-left",
});

const right = makeSplitter($("#ed-split-right"), {
  axis: "x",
  panel: $("#ed-right"),
  side: "after",
  size: 320,
  min: 240,
  max: () => workbenchEl.clientWidth - CENTER_MIN_W - dockWidth(leftColEl),
  storageKey: "we-editor-layout-right",
});

const bottom = makeSplitter($("#ed-split-bottom"), {
  axis: "y",
  panel: $("#ed-console"),
  side: "after",
  size: 180,
  min: 90,
  max: () => centerColEl.clientHeight - CENTER_MIN_H,
  storageKey: "we-editor-layout-bottom",
});

const library = makeSplitter($("#ed-split-lib"), {
  axis: "y",
  panel: $("#ed-library"),
  side: "before",
  size: 260,
  min: 100,
  max: () => leftColEl.clientHeight - LAYERS_MIN_H,
  storageKey: "we-editor-layout-library",
});

export const editorPanels = { left, right, bottom, library };

export function resetEditorLayout() {
  left.reset();
  right.reset();
  bottom.reset();
  library.reset();
}
