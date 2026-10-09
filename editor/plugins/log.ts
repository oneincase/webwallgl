// 插件日志（D6）：管理面板里「每个插件最近发生了什么」的来源。
// 环形缓冲，只留最近 limit 条；notify 用微任务合批，避免一次错误风暴里重复重绘。
// 纯数据 + 回调，不碰 DOM（Node 里可直接测）。

import type { Disposer } from "../core";

export type PluginLogLevel = "info" | "warn" | "error";

export type PluginLogEntry = {
  /** 记账用的插件 id（清单 id；拿不到清单时退回 Scope 名，如 ext:fx-test） */
  plugin: string;
  level: PluginLogLevel;
  text: string;
  /** 时间戳（毫秒） */
  at: number;
};

export type PluginLog = {
  push(plugin: string, level: PluginLogLevel, text: string): void;
  /** 不给 plugin = 全部；给了 = 该插件的（按时间正序） */
  list(plugin?: string): PluginLogEntry[];
  clear(plugin?: string): void;
  onChange(fn: () => void): Disposer;
};

export function createPluginLog(limit = 200): PluginLog {
  const items: PluginLogEntry[] = [];
  const subs = new Set<() => void>();
  let queued = false;
  const notify = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      for (const fn of [...subs]) fn();
    });
  };
  return {
    push(plugin, level, text) {
      items.push({ plugin, level, text, at: Date.now() });
      if (items.length > limit) items.splice(0, items.length - limit);
      notify();
    },
    list(plugin) {
      return plugin === undefined ? items.slice() : items.filter((x) => x.plugin === plugin);
    },
    clear(plugin) {
      if (plugin === undefined) items.length = 0;
      else for (let i = items.length - 1; i >= 0; i--) if (items[i].plugin === plugin) items.splice(i, 1);
      notify();
    },
    onChange(fn) {
      subs.add(fn);
      return () => void subs.delete(fn);
    },
  };
}
