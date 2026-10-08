// 插件管理面板：列出外部插件（来源 / 版本 / 状态 / 权限 / 错误），启用开关、重载、卸载、安装文件夹。
// 只依赖 PluginManager 与文案函数，不碰 main.ts 状态。

import { GRANTABLE, packageFromFiles, type PluginManifest } from "../plugins/external";
import type { PluginEntry, PluginManager } from "../plugins/manager";

export type PluginPanelOptions = {
  dialog: HTMLDialogElement;
  list: HTMLElement;
  manager: PluginManager;
  t: (key: string, params?: Record<string, string | number>) => string;
  text: (v: string | Record<string, string> | undefined, fallback: string) => string;
  log: (msg: string, level?: "info" | "warn" | "error") => void;
  /** 安装前确认（列出申请的权限）；false = 取消 */
  confirmInstall?: (m: PluginManifest) => boolean;
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

export function renderPluginRows(o: PluginPanelOptions, entries: PluginEntry[]) {
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
        if (confirm(t("pl.uninstallConfirm", { name: e.manifest ? text(e.manifest.name, e.id) : e.id }))) void manager.uninstall(e.id);
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
      if (c.shaders?.length) bits.push(t("pl.c.shaders", { n: c.shaders.length }));
      if (c.i18n) bits.push(t("pl.c.i18n"));
      if (e.manifest.main) bits.push(t("pl.c.code"));
      const { low, high } = permissionSummary(e.manifest);
      if (low.length || high.length) bits.push(t("pl.perms", { list: [...high.map((p) => `${p}⚠`), ...low].join(", ") }));
      if (bits.length) row.appendChild(el("div", "ed-plugin-meta", bits.join(" · ")));
    }
    if (e.missing.length) row.appendChild(el("div", "ed-plugin-err", t("pl.missing", { list: e.missing.join(", ") })));
    if (e.error) row.appendChild(el("div", "ed-plugin-err", e.error));
    list.appendChild(row);
  }
}

/** 挂面板：返回「打开」函数；manager 变化时自动重绘 */
export function mountPluginPanel(o: PluginPanelOptions): { open(): void; render(): void; installFiles(files: File[]): Promise<void> } {
  const render = () => renderPluginRows(o, o.manager.list());
  o.manager.onChange(() => {
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
        if (o.confirmInstall && !o.confirmInstall(pkg.manifest)) return;
        const m = await o.manager.install(entries);
        o.log(o.t("log.pluginInstalled", { name: o.text(m.name, m.id), version: m.version }));
      } catch (e) {
        o.log(o.t("log.pluginInstallFailed", { msg: (e as Error)?.message ?? String(e) }), "error");
      }
      render();
    },
  };
}
