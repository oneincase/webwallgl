// 命令服务：插件注册命令 + 快捷键；内置的撤销 / 重做 / 导出也登记成命令，插件可以 exec 或覆盖。

import { createRegistry } from "../core";
import type { CommandDef, CommandService } from "./types";

const norm = (k: string) =>
  k
    .split("+")
    .map((p) => p.trim().toLowerCase())
    .map((p) => (p === "cmd" || p === "ctrl" || p === "meta" ? "mod" : p))
    .sort()
    .join("+");

export function keyOf(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">): string {
  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push("mod");
  if (e.shiftKey) parts.push("shift");
  if (e.altKey) parts.push("alt");
  parts.push(e.key.toLowerCase());
  return parts.sort().join("+");
}

export function createCommandService(): CommandService {
  const registry = createRegistry<CommandDef>("commands");
  return {
    registry,
    exec(id, ...args) {
      const c = registry.get(id);
      if (!c) throw new Error(`未知命令：${id}`);
      if (c.when && !c.when()) return undefined;
      return c.run(...args);
    },
    handleKey(e) {
      const k = keyOf(e);
      // 后注册的同键命令优先（插件覆盖内置）
      for (const c of registry.list().reverse()) {
        if (!c.keys) continue;
        const keys: readonly string[] = typeof c.keys === "string" ? [c.keys] : c.keys;
        if (!keys.some((x) => norm(x) === k)) continue;
        if (c.when && !c.when()) continue;
        c.run();
        return true;
      }
      return false;
    },
  };
}
