// 外部插件管理（PLUGIN-ARCHITECTURE §5.3）：来源扫描 → 启用 / 停用 / 重载 / 卸载 → 状态与错误。
//
// 来源：
//   store —— 浏览器里「安装」的插件，整包存 IndexedDB（StorageService，键 pkg:<id>）；
//   dir   —— 插件目录（~/.webwallgl/plugins 等），经 dev 宿主 /api/plugins 读；桌面壳页面同样由它供给。
// 同 id 两处都有时目录版优先（开发中的插件盖过已安装的旧版）。
// 目录来源带版本戳（目录内最新 mtime），watch() 轮询到戳变化就整包热重载。
// 启用状态记在设置里（plugins.enabled.<id>，缺省启用）；停用 = 卸载 Scope，贡献随之全部撤回。

import type { Context, Disposer, PluginObject, Scope, ScopeStatus } from "../core";
import type { SettingsService, StorageService } from "../services/types";
import { externalPlugin, grantedOf, packageFromFiles, type ExternalDeps, type PluginManifest, type PluginPackage } from "./external";

export type PluginSource = {
  kind: PluginPackage["source"];
  /** 列出来源里的包：key = 来源内标识（store = 插件 id，dir = 目录名），stamp = 版本戳 */
  scan(): Promise<Array<{ key: string; stamp: string }>>;
  load(key: string): Promise<PluginPackage>;
  install?(pkg: PluginPackage): Promise<void>;
  remove?(key: string): Promise<void>;
};

export type PluginEntry = {
  id: string;
  manifest: PluginManifest | null;
  source: PluginPackage["source"];
  key: string;
  enabled: boolean;
  status: ScopeStatus | "disabled" | "invalid";
  error: string | null;
  /** 代码插件等不到的服务（多半是清单没申请权限） */
  missing: string[];
  granted: string[];
  removable: boolean;
};

export type PluginManager = {
  list(): PluginEntry[];
  /** 重新扫描全部来源；戳变了的包重载 */
  refresh(): Promise<void>;
  setEnabled(id: string, on: boolean): Promise<void>;
  reload(id: string): Promise<void>;
  /** 装一个包进 store 来源（文件表：拖入的文件夹等） */
  install(entries: Iterable<{ path: string; data: Uint8Array }>): Promise<PluginManifest>;
  uninstall(id: string): Promise<void>;
  /** 轮询目录来源做热重载 */
  watch(ms?: number): Disposer;
  onChange(fn: () => void): Disposer;
  dispose(): void;
};

type Known = {
  source: PluginSource;
  key: string;
  stamp: string;
  pkg: PluginPackage | null;
  error: string | null;
};

export type ManagerOptions = {
  root: Context;
  sources: PluginSource[];
  settings: SettingsService;
  deps: ExternalDeps;
};

export function createPluginManager(o: ManagerOptions): PluginManager {
  const known = new Map<string, Known>();
  const scopes = new Map<string, Scope>();
  const listeners = new Set<() => void>();
  const enabledKey = (id: string) => `plugins.enabled.${id}`;
  const isEnabled = (id: string) => o.settings.get<boolean>(enabledKey(id), true) !== false;
  let notifyQueued = false;
  const notify = () => {
    if (notifyQueued) return;
    notifyQueued = true;
    queueMicrotask(() => {
      notifyQueued = false;
      for (const fn of [...listeners]) {
        try {
          fn();
        } catch (e) {
          console.error("[plugins] onChange", e);
        }
      }
    });
  };
  // 状态 / 错误变化只看自己挂的 Scope（含代码子插件）
  const offStatus = o.root.on("internal/status", (s: Scope) => {
    for (let x: Scope | null = s; x; x = x.parent) if ([...scopes.values()].includes(x)) return notify();
  });
  const offError = o.root.on("internal/error", (s: Scope) => {
    for (let x: Scope | null = s; x; x = x.parent) if ([...scopes.values()].includes(x)) return notify();
  });

  const tag = (s: PluginSource, key: string) => `${s.kind}:${key}`;

  /** 每个 id 的生效包：目录来源优先 */
  function winners(): Map<string, Known> {
    const out = new Map<string, Known>();
    for (const k of known.values()) {
      if (!k.pkg) continue;
      const id = k.pkg.manifest.id;
      const cur = out.get(id);
      if (!cur || (cur.source.kind !== "dir" && k.source.kind === "dir")) out.set(id, k);
    }
    return out;
  }

  function unmount(id: string) {
    scopes.get(id)?.dispose();
    scopes.delete(id);
  }

  function mount(k: Known) {
    const pkg = k.pkg!;
    const id = pkg.manifest.id;
    unmount(id);
    if (!isEnabled(id)) return;
    const p: PluginObject = externalPlugin(pkg, o.deps);
    scopes.set(id, o.root.plugin(p, undefined, { meta: { manifest: pkg.manifest, source: pkg.source, stamp: k.stamp } }));
  }

  /** 让挂着的 Scope 与当前 winners 一致 */
  function reconcile(changed: Set<string>) {
    const w = winners();
    for (const id of [...scopes.keys()]) if (!w.has(id)) unmount(id);
    for (const [id, k] of w) {
      const s = scopes.get(id);
      const want = isEnabled(id);
      if (!want) {
        if (s) unmount(id);
        continue;
      }
      if (!s || changed.has(id) || s.meta.stamp !== k.stamp || s.meta.source !== k.source.kind) mount(k);
    }
    notify();
  }

  async function scanSource(s: PluginSource, changed: Set<string>) {
    let list: Array<{ key: string; stamp: string }>;
    try {
      list = await s.scan();
    } catch (e) {
      console.warn(`[plugins] 来源 ${s.kind} 扫描失败`, e);
      return;
    }
    const seen = new Set<string>();
    for (const { key, stamp } of list) {
      const t = tag(s, key);
      seen.add(t);
      const prev = known.get(t);
      if (prev && prev.stamp === stamp) continue;
      let pkg: PluginPackage | null = null;
      let error: string | null = null;
      try {
        pkg = await s.load(key);
        pkg.stamp = stamp;
      } catch (e) {
        error = (e as Error)?.message ?? String(e);
      }
      known.set(t, { source: s, key, stamp, pkg, error });
      if (pkg) changed.add(pkg.manifest.id);
    }
    for (const t of [...known.keys()]) if (t.startsWith(`${s.kind}:`) && !seen.has(t)) known.delete(t);
  }

  async function refresh() {
    const changed = new Set<string>();
    for (const s of o.sources) await scanSource(s, changed);
    reconcile(changed);
    await o.root.kernel.settle();
  }

  function entryOf(k: Known): PluginEntry {
    const m = k.pkg?.manifest ?? null;
    const id = m?.id ?? k.key;
    const s = m ? scopes.get(id) : undefined;
    const w = m ? winners().get(id) === k : false;
    const enabled = m ? isEnabled(id) : false;
    // 代码子插件的状态比外层更能说明问题（外层 active 但代码 pending / failed）
    const child = s ? [...s.children][0] : undefined;
    const worst = child && (child.status === "failed" || child.status === "pending") ? child : s;
    const err = worst?.error ?? s?.error;
    return {
      id,
      manifest: m,
      source: k.source.kind,
      key: k.key,
      enabled,
      status: !m ? "invalid" : !w ? "disabled" : !enabled || !s ? "disabled" : (worst?.status ?? "pending"),
      error: k.error ?? (err ? ((err as Error)?.message ?? String(err)) : null),
      missing: worst?.status === "pending" ? worst.missing : [],
      granted: m ? grantedOf(m) : [],
      removable: !!k.source.remove,
    };
  }

  const storeOf = () => o.sources.find((s) => s.kind === "store" && s.install);

  return {
    list: () => [...known.values()].map(entryOf).sort((a, b) => a.id.localeCompare(b.id) || a.source.localeCompare(b.source)),
    refresh,
    async setEnabled(id, on) {
      o.settings.set(enabledKey(id), on);
      reconcile(new Set());
      await o.root.kernel.settle();
    },
    async reload(id) {
      for (const k of known.values()) if (k.pkg?.manifest.id === id || k.key === id) k.stamp = "";
      await refresh();
      const k = winners().get(id);
      if (k && isEnabled(id) && !scopes.has(id)) mount(k);
      await o.root.kernel.settle();
      notify();
    },
    async install(entries) {
      const st = storeOf();
      if (!st?.install) throw new Error("没有可安装的插件来源");
      const pkg = packageFromFiles(entries, "store");
      await st.install(pkg);
      o.settings.set(enabledKey(pkg.manifest.id), true);
      await refresh();
      return pkg.manifest;
    },
    async uninstall(id) {
      for (const k of [...known.values()]) {
        if ((k.pkg?.manifest.id === id || k.key === id) && k.source.remove) {
          await k.source.remove(k.key);
          known.delete(tag(k.source, k.key));
        }
      }
      reconcile(new Set());
      await o.root.kernel.settle();
    },
    watch(ms = 1500) {
      let busy = false;
      const h = setInterval(() => {
        if (busy) return;
        busy = true;
        const changed = new Set<string>();
        void Promise.all(o.sources.filter((s) => s.kind === "dir").map((s) => scanSource(s, changed)))
          .then(() => {
            if (changed.size) reconcile(changed);
          })
          .finally(() => (busy = false));
      }, ms);
      return () => clearInterval(h);
    },
    onChange(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    dispose() {
      offStatus();
      offError();
      for (const id of [...scopes.keys()]) unmount(id);
      listeners.clear();
    },
  };
}

// ---------- 来源实现 ----------

type StoredPkg = { files: Record<string, Uint8Array>; stamp: string };

/** 浏览器内安装：整包进 StorageService（IndexedDB） */
export function storeSource(storage: StorageService): PluginSource {
  const KEY = "pkg:";
  return {
    kind: "store",
    async scan() {
      const out: Array<{ key: string; stamp: string }> = [];
      for (const k of await storage.keys(KEY)) {
        const v = (await storage.get(k)) as StoredPkg | undefined;
        if (v) out.push({ key: k.slice(KEY.length), stamp: v.stamp });
      }
      return out;
    },
    async load(key) {
      const v = (await storage.get(KEY + key)) as StoredPkg | undefined;
      if (!v) throw new Error(`已安装插件 ${key} 不见了`);
      return packageFromFiles(
        Object.entries(v.files).map(([path, data]) => ({ path, data })),
        "store",
      );
    },
    async install(pkg) {
      const files: Record<string, Uint8Array> = {};
      for (const [p, d] of pkg.files) files[p] = d;
      await storage.set(KEY + pkg.manifest.id, { files, stamp: `${pkg.manifest.version}@${Date.now()}` } satisfies StoredPkg);
    },
    async remove(key) {
      await storage.delete(KEY + key);
    },
  };
}

export type DirListing = { plugins: Array<{ dir: string; stamp: string; files: string[] }>; root?: string };

/** 插件目录（dev 宿主 /api/plugins）：清单 + 逐个文件取 */
export function dirSource(base = "/api/plugins", fetchFn: typeof fetch = (...a) => fetch(...a)): PluginSource {
  let last: DirListing | null = null;
  return {
    kind: "dir",
    async scan() {
      const r = await fetchFn(base, { cache: "no-store" });
      if (!r.ok) throw new Error(`${base} ${r.status}`);
      last = (await r.json()) as DirListing;
      return last.plugins.map((p) => ({ key: p.dir, stamp: p.stamp }));
    },
    async load(key) {
      const item = last?.plugins.find((p) => p.dir === key);
      if (!item) throw new Error(`插件目录 ${key} 不见了`);
      const entries = await Promise.all(
        item.files.map(async (path) => {
          const r = await fetchFn(`${base}/file?dir=${encodeURIComponent(key)}&path=${encodeURIComponent(path)}`, { cache: "no-store" });
          if (!r.ok) throw new Error(`读插件文件失败：${key}/${path}（${r.status}）`);
          return { path, data: new Uint8Array(await r.arrayBuffer()) };
        }),
      );
      const pkg = packageFromFiles(entries, "dir");
      pkg.dir = key;
      return pkg;
    },
  };
}
