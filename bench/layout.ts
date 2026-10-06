/**
 * 测试台面板布局：三个停靠面板（左壁纸库 / 右检视器 / 底控制台）的分隔条，
 * 以及中央、底部、右侧三组标签页。尺寸与选中标签都记在 localStorage。
 */

import { $, emit, type TabPanel } from "./store";
import { makeSplitter } from "../shared/workbench/splitter";
import { initTabs, type Tabs } from "../shared/workbench/tabs";

const workbenchEl = $<HTMLElement>("#workbench");
const centerColEl = $<HTMLElement>("#pane-center").parentElement!;

/** 中央区至少留这么宽 / 高，停靠面板的上限据此实时推算 */
const CENTER_MIN_W = 360;
const CENTER_MIN_H = 220;

const left = makeSplitter($("#split-left"), {
  axis: "x",
  panel: $("#pane-left"),
  side: "before",
  size: 280,
  min: 200,
  max: () => workbenchEl.clientWidth - CENTER_MIN_W - rightWidth(),
  storageKey: "we-bench-layout-left",
});

const right = makeSplitter($("#split-right"), {
  axis: "x",
  panel: $("#pane-right"),
  side: "after",
  size: 340,
  min: 260,
  max: () => workbenchEl.clientWidth - CENTER_MIN_W - leftWidth(),
  storageKey: "we-bench-layout-right",
});

const bottom = makeSplitter($("#split-bottom"), {
  axis: "y",
  panel: $("#pane-bottom"),
  side: "after",
  size: 220,
  min: 120,
  max: () => centerColEl.clientHeight - CENTER_MIN_H,
  storageKey: "we-bench-layout-bottom",
});

function dockWidth(sel: string) {
  const el = $<HTMLElement>(sel);
  return el.classList.contains("is-collapsed") ? 0 : el.getBoundingClientRect().width;
}

function leftWidth() {
  return dockWidth("#pane-left");
}

function rightWidth() {
  return dockWidth("#pane-right");
}

export const panels = { left, right, bottom };

const tabChanged = (panel: TabPanel) => (id: string) => emit("tab", { panel, id });

export const tabs: Record<TabPanel, Tabs> = {
  left: initTabs($("#pane-left")),
  // 首次进入默认落在「使用说明」，之后记住上次的标签
  center: initTabs($("#pane-center"), {
    storageKey: "we-bench-tab-center",
    initial: "docs",
    onChange: tabChanged("center"),
  }),
  bottom: initTabs($("#pane-bottom"), { storageKey: "we-bench-tab-bottom", onChange: tabChanged("bottom") }),
  right: initTabs($("#pane-right"), { storageKey: "we-bench-tab-right", onChange: tabChanged("right") }),
};

export function resetLayout() {
  left.reset();
  right.reset();
  bottom.reset();
}
