/**
 * 编辑器面板布局：左图层、右检视器、底控制台的分隔条，
 * 尺寸记在 localStorage。视口尺寸变化由 main.ts 的 ResizeObserver 接手重排舞台。
 */

import { makeSplitter } from "../shared/workbench/splitter";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

const workbenchEl = $("#ed-workbench");
const leftColEl = $("#ed-left");
const centerColEl = $("#ed-center").parentElement!;

const CENTER_MIN_W = 360;
const CENTER_MIN_H = 220;

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
  // 控制台默认收起：引擎日志是诊断信息，不该占用默认工作高度（点分隔条或「控制台」标签展开）
  collapsed: true,
  max: () => centerColEl.clientHeight - CENTER_MIN_H,
  storageKey: "we-editor-layout-bottom",
});

export const editorPanels = { left, right, bottom };

/**
 * 窄窗自适应：编辑器最小可用宽度是三栏并排（280 + 舞台 + 320）。
 * 窗口不够宽时依次收起右栏（<1280）与左栏（<1100），把宽度全部让给画面；
 * 变宽后自动展开回来。这属于「临时收起」，不写 localStorage，不覆盖用户自己的布局。
 */
const LEFT_AUTO_BELOW = 1100;
const RIGHT_AUTO_BELOW = 1280;
let autoLeft = false;
let autoRight = false;

function responsiveLayout() {
  const w = workbenchEl.clientWidth;
  const wantRight = w > 0 && w < RIGHT_AUTO_BELOW;
  const wantLeft = w > 0 && w < LEFT_AUTO_BELOW;
  if (wantRight && !autoRight && !right.isCollapsed()) {
    autoRight = true;
    right.setCollapsed(true, false);
  } else if (!wantRight && autoRight) {
    autoRight = false;
    right.setCollapsed(false, false);
  }
  if (wantLeft && !autoLeft && !left.isCollapsed()) {
    autoLeft = true;
    left.setCollapsed(true, false);
  } else if (!wantLeft && autoLeft) {
    autoLeft = false;
    left.setCollapsed(false, false);
  }
}

responsiveLayout();
new ResizeObserver(responsiveLayout).observe(workbenchEl);

export function resetEditorLayout() {
  left.reset();
  right.reset();
  bottom.reset();
}
