// 插件管理面板：列出外部插件（来源 / 版本 / 状态 / 权限 / 错误），启用开关、重载、卸载、安装文件夹，
// 以及逐项权限开关（D6）与每个插件的最近日志（D6）。
// 只依赖 PluginManager 与文案函数，不碰 main.ts 状态。

import { deniedPermissions, GRANTABLE, packageFromFiles, permKey, type PluginManifest } from "../plugins/external";
import type { PluginEntry, PluginManager } from "../plugins/manager";
import type { PluginLog, PluginLogEntry } from "../plugins/log";
import type { SettingsService } from "../services/types";
import { confirmDialog } from "./confirm";

export type PluginPanelOptions = {
  dialog: HTMLDialogElement;
  list: HTMLElement;
  manager: PluginManager;
  /** 逐项权限开关的读写底座（与 manager 用同一个） */
  settings: SettingsService;
  /** 插件日志（缺省 = 面板不显示日志区） */
  logs?: PluginLog;
  t: (key: string, params?: Record<string, string | number>) => string;
  text: (v: string | Record<string, string> | undefined, fallback: string) => string;
  log: (msg: string, level?: "info" | "warn" | "error") => void;
  /** 安装前确认（列出申请的权限）；false = 取消 */
  confirmInstall?: (m: PluginManifest) => boolean | Promise<boolean>;
};

const STATUS_CLASS: Record<string, string> = {
  active: "is-ok",
  loading: "is-busy",
  pending: "is-warn",
  failed: "is-err",
  invalid: "is-err",
  disabled: "is-off",
  disposed: "is-off",
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function permissionSummary(m: PluginManifest): { low: string[]; high: string[] } {
  const low: string[] = [];
  const high: string[] = [];
  for (const p of m.permissions ?? []) (GRANTABLE[p] === "high" ? high : low).push(p);
  return { low, high };
}

/** 一个插件行的日志：既认清单 id（代码子插件报错把清单 id 记在 meta 上），也认外层 ext:<id> Scope 名 */
function logEntriesOf(o: PluginPanelOptions, id: string): PluginLogEntry[] {
  const all = [...(o.logs?.list(id) ?? []), ...(o.logs?.list(`ext:${id}`) ?? [])];
  return all.sort((a, b) => a.at - b.at);
}

/** 逐项权限开关：关掉的项写进 settings，再 reload 让代码子插件用新白名单重挂 */
function renderPermissions(o: PluginPanelOptions, row: HTMLElement, entry: PluginEntry, rerender?: () => void) {
  const perms = (entry.manifest?.permissions ?? []).filter((p) => p in GRANTABLE);
  if (!perms.length) return;
  const denied = deniedPermissions(o.settings, entry.id);
  const box = el("div", "ed-plugin-perms");
  box.appendChild(el("span", "ed-plugin-perms-title", o.t("pl.permsTitle")));
  for (const p of perms) {
    const high = GRANTABLE[p] === "high";
    const label = el("label", "ed-plugin-perm");
    label.title = high ? o.t("pl.permHigh") : p;
    const cb = el("input");
    cb.type = "checkbox";
    cb.dataset.perm = p;
    cb.checked = !denied.has(p);
    cb.onchange = () => {
      o.settings.set(permKey(entry.id, p), cb.checked);
      o.logs?.push(entry.id, "info", `${p}: ${cb.checked ? "on" : "off"}`);
      o.log(`${entry.id}: ${p} → ${cb.checked ? "on" : "off"}`);
      // 白名单在挂载时结算，改完必须重挂才生效
      void o.manager.reload(entry.id).then(() => rerender?.());
    };
    label.appendChild(cb);
    label.appendChild(el("span", high ? "ed-plugin-perm-name is-high" : "ed-plugin-perm-name", high ? `${p} ⚠` : p));
    box.appendChild(label);
  }
  row.appendChild(box);
}

/** 日志区：最近 N 条（倒序显示）+ 清空 */
function renderLogs(o: PluginPanelOptions, row: HTMLElement, entry: PluginEntry, rerender?: () => void) {
  if (!o.logs) return;
  const entries = logEntriesOf(o, entry.id);
  const det = el("details", "ed-plugin-logs");
  det.open = entries.some((x) => x.level === "error");
  det.appendChild(el("summary", undefined, `${o.t("pl.logs")} (${entries.length})`));
  if (!entries.length) det.appendChild(el("div", "ed-plugin-log is-empty", o.t("pl.logsEmpty")));
  else {
    // 倒序：最新的在最上面
    for (const x of [...entries].reverse()) {
      const line = el("div", `ed-plugin-log is-${x.level}`, `${new Date(x.at).toTimeString().slice(0, 8)} ${x.text}`);
      det.appendChild(line);
    }
  }
  const clr = el("button", "ed-btn ed-btn-sm", o.t("pl.logsClear"));
  clr.type = "button";
  clr.dataset.act = "logs-clear";
  clr.disabled = !entries.length;
  clr.onclick = () => {
    o.logs!.clear(entry.id);
    rerender?.();
  };
  det.appendChild(clr);
  row.appendChild(det);
}

export function renderPluginRows(o: PluginPanelOptions, entries: PluginEntry[], rerender?: () => void) {
  const { list, manager, t, text } = o;
  list.textContent = "";
  if (!entries.length) {
    list.appendChild(el("div", "ed-plugins-empty", t("pl.empty")));
    return;
  }
  for (const e of entries) {
    const row = el("div", "ed-plugin");
    row.dataset.plugin = e.id;
    row.dataset.status = e.status;
    const head = el("div", "ed-plugin-head");
    const toggle = el("input");
    toggle.type = "checkbox";
    toggle.checked = e.enabled;
    toggle.disabled = !e.manifest;
    toggle.title = t(e.enabled ? "pl.disable" : "pl.enable");
    toggle.onchange = () => void manager.setEnabled(e.id, toggle.checked);
    const name = el("span", "ed-plugin-name", e.manifest ? text(e.manifest.name, e.id) : e.key);
    const ver = el("span", "ed-plugin-ver", e.manifest ? `v${e.manifest.version}` : "");
    const src = el("span", "ed-plugin-src", t(`pl.src.${e.source}`));
    const badge = el("span", `ed-plugin-status ${STATUS_CLASS[e.status] ?? ""}`, t(`pl.status.${e.status}`));
    head.append(toggle, name, ver, src, badge);
    const acts = el("span", "ed-plugin-acts");
    const reload = el("button", "ed-btn ed-btn-sm", t("pl.reload"));
    reload.type = "button";
    reload.dataset.act = "reload";
    reload.onclick = () => void manager.reload(e.id);
    acts.appendChild(reload);
    if (e.removable) {
      const rm = el("button", "ed-btn ed-btn-sm", t("pl.uninstall"));
      rm.type = "button";
      rm.dataset.act = "uninstall";
      rm.onclick = () => {
        void (async () => {
          const name = e.manifest ? text(e.manifest.name, e.id) : e.id;
          const yes = await confirmDialog({
            title: t("dlg.uninstallTitle"),
            body: t("dlg.uninstallBody", { name }),
            ok: t("dlg.uninstallOk"),
            danger: true,
          });
          if (yes) void manager.uninstall(e.id);
        })();
      };
      acts.appendChild(rm);
    }
    head.appendChild(acts);
    row.appendChild(head);
    if (e.manifest?.description) row.appendChild(el("div", "ed-plugin-desc", text(e.manifest.description, "")));
    if (e.manifest) {
      const bits: string[] = [];
      const c = e.manifest.contributes ?? {};
      if (c.effects?.length) bits.push(t("pl.c.effects", { n: c.effects.length }));
      if (c.particles?.length) bits.push(t("pl.c.particles", { n: c.particles.length }));
      if (c["particles.components"]?.length) bits.push(t("pl.c.components", { n: c["particles.components"].length }));
      if (c.shaders?.length) bits.push(t("pl.c.shaders", { n: c.shaders.length }));
      if (c.i18n) bits.push(t("pl.c.i18n"));
      if (e.manifest.main) bits.push(t("pl.c.code"));
      const { low, high } = permissionSummary(e.manifest);
      if (low.length || high.length) bits.push(t("pl.perms", { list: [...high.map((p) => `${p}⚠`), ...low].join(", ") }));
      if (bits.length) row.appendChild(el("div", "ed-plugin-meta", bits.join(" · ")));
    }
    if (e.missing.length) row.appendChild(el("div", "ed-plugin-err", t("pl.missing", { list: e.missing.join(", ") })));
    if (e.error) row.appendChild(el("div", "ed-plugin-err", e.error));
    if (e.manifest) {
      renderPermissions(o, row, e, rerender);
      renderLogs(o, row, e, rerender);
    }
    list.appendChild(row);
  }
}

/** 挂面板：返回「打开」函数；manager / 日志变化时自动重绘 */
export function mountPluginPanel(o: PluginPanelOptions): { open(): void; render(): void; installFiles(files: File[]): Promise<void> } {
  const render = () => renderPluginRows(o, o.manager.list(), render);
  o.manager.onChange(() => {
    if (o.dialog.open) render();
  });
  o.logs?.onChange(() => {
    if (o.dialog.open) render();
  });
  return {
    open() {
      render();
      if (!o.dialog.open) o.dialog.showModal();
      void o.manager.refresh().then(render);
    },
    render,
    async installFiles(files) {
      const entries = await Promise.all(
        files.map(async (f) => ({ path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name, data: new Uint8Array(await f.arrayBuffer()) })),
      );
      try {
        const pkg = packageFromFiles(entries);
        if (o.confirmInstall && !(await o.confirmInstall(pkg.manifest))) return;
        const m = await o.manager.install(entries);
        o.log(o.t("log.pluginInstalled", { name: o.text(m.name, m.id), version: m.version }));
        o.logs?.push(m.id, "info", o.t("log.pluginInstalled", { name: o.text(m.name, m.id), version: m.version }));
      } catch (e) {
        const msg = (e as Error)?.message ?? String(e);
        o.log(o.t("log.pluginInstallFailed", { msg }), "error");
        o.logs?.push(pkgIdOf(entries), "error", o.t("log.pluginInstallFailed", { msg }));
      }
      render();
    },
  };
}

/** 安装失败时还没有清单可用，用选中的文件夹名当记账 id */
function pkgIdOf(entries: Array<{ path: string }>): string {
  const first = entries[0]?.path ?? "";
  const seg = first.split("/").filter(Boolean);
  return seg.length > 1 ? seg[0] : first || "?";
}
