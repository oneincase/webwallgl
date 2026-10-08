// 贡献点注册表：效果 / 粒子模板 / 导入器 / 导出器 / 检视器分组……都是它的实例。
//
// add 返回撤销函数（ctx.contribute 自动挂到插件 Scope 上）；同 id 按栈管理，后加的生效，
// 撤下后回落到前一个 —— 外部插件可以覆盖内置项，卸载即还原。
// fallback：注册表空着时 get 的兜底（只读解码用，不进 list），让纯函数模块脱离内核也能用。
// changed 事件按微任务合批：一次加载几十项只触发一次界面重建。

import type { Disposer } from "./context";

export type RegistryEntry<T> = { item: T; owner: string; seq: number };

export interface Registry<T> {
  readonly name: string;
  add(item: T, owner?: string): Disposer;
  get(id: string): T | undefined;
  has(id: string): boolean;
  list(): T[];
  entries(): RegistryEntry<T>[];
  ownerOf(id: string): string | undefined;
  onChange(fn: () => void): Disposer;
  /** 兜底表（不进 list）：id → 项 */
  setFallback(items: Iterable<T>): void;
}

export type RegistryOptions<T> = {
  idOf?: (item: T) => string;
  /** 排序键（小的在前），缺省按加入顺序 */
  orderOf?: (item: T) => number;
  validate?: (item: T) => void;
};

export function createRegistry<T>(name: string, opts: RegistryOptions<T> = {}): Registry<T> {
  const idOf = opts.idOf ?? ((x: T) => String((x as { id?: unknown }).id ?? ""));
  const stacks = new Map<string, RegistryEntry<T>[]>();
  const listeners = new Set<() => void>();
  let fallback = new Map<string, T>();
  let seq = 0;
  let queued = false;

  const changed = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      for (const fn of [...listeners]) {
        try {
          fn();
        } catch (e) {
          console.error(`[registry ${name}] change listener:`, e);
        }
      }
    });
  };

  const top = (id: string) => {
    const st = stacks.get(id);
    return st && st.length ? st[st.length - 1] : undefined;
  };

  return {
    name,
    add(item, owner = "anonymous") {
      const id = idOf(item);
      if (!id) throw new Error(`[registry ${name}] 贡献项缺 id`);
      opts.validate?.(item);
      let st = stacks.get(id);
      if (!st) stacks.set(id, (st = []));
      const entry = { item, owner, seq: seq++ };
      st.push(entry);
      changed();
      return () => {
        const list = stacks.get(id);
        const i = list ? list.indexOf(entry) : -1;
        if (i < 0) return;
        list!.splice(i, 1);
        if (!list!.length) stacks.delete(id);
        changed();
      };
    },
    get: (id) => top(id)?.item ?? fallback.get(id),
    has: (id) => stacks.has(id),
    list() {
      return this.entries().map((e) => e.item);
    },
    entries() {
      const out = [...stacks.values()].map((st) => st[st.length - 1]);
      // 同 id 被覆盖时按最早一次加入的位置排序（覆盖不改变菜单顺序）
      const firstSeq = (e: RegistryEntry<T>) => stacks.get(idOf(e.item))![0].seq;
      out.sort((a, b) => {
        const oa = opts.orderOf?.(a.item) ?? 0;
        const ob = opts.orderOf?.(b.item) ?? 0;
        return oa - ob || firstSeq(a) - firstSeq(b);
      });
      return out;
    },
    ownerOf: (id) => top(id)?.owner,
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    setFallback(items) {
      fallback = new Map([...items].map((x) => [idOf(x), x]));
    },
  };
}
