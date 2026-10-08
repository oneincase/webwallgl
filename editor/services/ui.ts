// UI 槽位：宿主（main.ts）把固定容器挂成命名槽位，插件往槽位里贡献 DOM 工厂。
// 贡献项随插件卸载自动移除；槽位内容在贡献变化时整体重建（合批到微任务）。

import { createRegistry, type Disposer, type Registry } from "../core";
import type { SlotItem, SlotName, UiService } from "./types";

export function createUiService(onError: (slot: string, id: string, e: unknown) => void = () => {}): UiService {
  const slots = new Map<string, Registry<SlotItem>>();
  const slotOf = (name: string) => {
    let r = slots.get(name);
    if (!r) slots.set(name, (r = createRegistry<SlotItem>(`ui.${name}`, { orderOf: (x) => x.order ?? 0 })));
    return r;
  };

  const renderInto = (slot: SlotName, host: HTMLElement) => {
    host.querySelectorAll(":scope > [data-slot-item]").forEach((n) => n.remove());
    for (const item of slotOf(slot).list()) {
      let el: HTMLElement | null = null;
      try {
        el = item.render();
      } catch (e) {
        onError(slot, item.id, e);
      }
      if (!el) continue;
      el.dataset.slotItem = item.id;
      host.appendChild(el);
    }
  };

  return {
    add: (slot, item) => slotOf(slot).add(item),
    items: (slot) => slotOf(slot).list(),
    onChange: (slot, fn) => slotOf(slot).onChange(fn),
    mount(slot, host): Disposer {
      renderInto(slot, host);
      const off = slotOf(slot).onChange(() => renderInto(slot, host));
      return () => {
        off();
        host.querySelectorAll(":scope > [data-slot-item]").forEach((n) => n.remove());
      };
    },
  };
}
