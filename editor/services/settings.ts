// 设置（同步，localStorage）与存储（异步，IndexedDB）服务，都按命名空间隔离。
// 没有 localStorage / indexedDB 的环境（Node 判据）退化成内存表。

import type { SettingsService, StorageService } from "./types";

type KV = { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };

function memoryKV(): KV {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
}

export function createSettings(prefix = "webwallgl-editor.", kv?: KV): SettingsService {
  const store: KV = kv ?? (typeof localStorage !== "undefined" ? localStorage : memoryKV());
  const make = (ns: string): SettingsService => ({
    get<T>(key: string, fallback: T): T {
      try {
        const raw = store.getItem(ns + key);
        return raw === null ? fallback : (JSON.parse(raw) as T);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        store.setItem(ns + key, JSON.stringify(value));
      } catch {
        /* 配额满 / 隐私模式：设置不落盘不影响编辑 */
      }
    },
    remove: (key) => store.removeItem(ns + key),
    scope: (sub) => make(`${ns}${sub}.`),
  });
  return make(prefix);
}

export function memoryStorage(): StorageService {
  const m = new Map<string, unknown>();
  return {
    get: async (k) => structuredClone(m.get(k)),
    set: async (k, v) => void m.set(k, structuredClone(v)),
    delete: async (k) => void m.delete(k),
    keys: async (p = "") => [...m.keys()].filter((k) => k.startsWith(p)),
  };
}

export function idbStorage(dbName = "webwallgl-editor-plugins", storeName = "kv"): StorageService {
  if (typeof indexedDB === "undefined") return memoryStorage();
  let dbp: Promise<IDBDatabase> | null = null;
  const db = () =>
    (dbp ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(storeName);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  const tx = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const d = await db();
    return new Promise((resolve, reject) => {
      const req = fn(d.transaction(storeName, mode).objectStore(storeName));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  };
  return {
    get: (k) => tx("readonly", (s) => s.get(k)),
    set: async (k, v) => void (await tx("readwrite", (s) => s.put(v, k))),
    delete: async (k) => void (await tx("readwrite", (s) => s.delete(k))),
    keys: async (p = "") => ((await tx("readonly", (s) => s.getAllKeys())) as IDBValidKey[]).map(String).filter((k) => k.startsWith(p)),
  };
}
