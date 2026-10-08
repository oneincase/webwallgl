// 编辑器装配入口（PLUGIN-ARCHITECTURE §2）：起内核 → 挂宿主服务 → 按 profile 装内置插件。
//
// 宿主（main.ts）只提供四个「活状态」服务：doc / history / assets / engine —— 它们包着 main.ts 的闭包，
// 其余服务（commands / ui / i18n / settings / storage）在这里建。之后的一切能力
// （效果、粒子、导入器、导出目标、检视器分组……）都经插件贡献到注册表，main.ts 只按注册表渲染。

import {
  createKernel,
  loadProfile,
  mergeProfiles,
  type Catalog,
  type Context,
  type LoadResult,
  type Plugin,
  type PluginObject,
  type Profile,
  type Scope,
} from "./core";
import { BUILTIN_CATALOG, BUILTIN_PROFILE } from "./plugins/builtin";
import { createCommandService } from "./services/commands";
import { createI18nService } from "./services/i18n";
import { createSettings, idbStorage } from "./services/settings";
import { createUiService } from "./services/ui";
import type {
  AssetsService,
  CommandService,
  DocService,
  EngineService,
  HistoryService,
  I18nService,
  SettingsService,
  StorageService,
  UiService,
} from "./services/types";

export type HostBindings = {
  doc: DocService;
  history: HistoryService;
  assets: AssetsService;
  engine: EngineService;
  /** 测试 / 非浏览器环境可替换 */
  settings?: SettingsService;
  storage?: StorageService;
  i18n?: I18nService;
};

export type EditorApp = {
  root: Context;
  commands: CommandService;
  ui: UiService;
  settings: SettingsService;
  storage: StorageService;
  load: LoadResult;
  /** 再挂一个插件（宿主自己的内置分组、外部插件加载器…） */
  plugin<C>(p: Plugin<C>, config?: C, meta?: Record<string, unknown>): Scope;
  /** 当前全部插件（不含根） */
  scopes(): Scope[];
};

export type BootOptions = {
  /** 叠在内置 profile 之上（同名覆盖：可 disabled 掉某个内置插件） */
  profile?: Profile;
  catalog?: Catalog;
  onError?: (scope: Scope, error: unknown, where: string) => void;
};

/** 宿主服务插件：把 HostBindings 与新建的公共服务一起 provide */
function hostPlugin(h: Required<Pick<HostBindings, "doc" | "history" | "assets" | "engine">>, s: {
  commands: CommandService;
  ui: UiService;
  i18n: I18nService;
  settings: SettingsService;
  storage: StorageService;
}): PluginObject {
  return {
    name: "editor-host",
    provides: ["doc", "history", "assets", "engine", "commands", "ui", "i18n", "settings", "storage"],
    apply(ctx) {
      ctx.provide("doc", h.doc);
      ctx.provide("history", h.history);
      ctx.provide("assets", h.assets);
      ctx.provide("engine", h.engine);
      ctx.provide("commands", s.commands);
      ctx.provide("ui", s.ui);
      ctx.provide("i18n", s.i18n);
      ctx.provide("settings", s.settings);
      ctx.provide("storage", s.storage);
    },
  };
}

export async function bootEditor(host: HostBindings, opts: BootOptions = {}): Promise<EditorApp> {
  const root = createKernel();
  if (opts.onError) root.kernel.onError = opts.onError;
  const commands = createCommandService();
  const ui = createUiService((slot, id, e) => console.error(`[ui ${slot}/${id}]`, e));
  const settings = host.settings ?? createSettings();
  const storage = host.storage ?? idbStorage();
  const i18n = host.i18n ?? createI18nService();
  root.plugin(hostPlugin(host, { commands, ui, i18n, settings, storage }));
  const load = await loadProfile(root, mergeProfiles(BUILTIN_PROFILE, opts.profile), { ...BUILTIN_CATALOG, ...opts.catalog });
  return {
    root,
    commands,
    ui,
    settings,
    storage,
    load,
    plugin: (p, config, meta) => root.plugin(p, config, meta ? { meta } : {}),
    scopes: () => [...root.kernel.scopes].filter((s) => s !== root.scope),
  };
}
