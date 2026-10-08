// 内置插件目录（PLUGIN-ARCHITECTURE §2）：编辑器自带的能力也全部是插件，与外部插件同一套装配。
//
// registries 插件把各贡献点注册表挂成服务；其余 builtin-* 只做一件事：把内置项 contribute 进去。
// profile 里禁用某个 builtin-*，对应菜单就空了（内置项仍是注册表 fallback，旧工程照常解码）；
// 再挂一个外部插件往同一注册表贡献同 id 的项，即可覆盖内置实现，卸载即还原。

import type { Catalog, Context, PluginObject, Profile } from "../../core";
import { EFFECTS, effectCatalog } from "../../effects";
import { BUILTIN_SNIPPETS, shaderSnippets } from "../../shader-lib";
import { BUILTIN_PARTICLE_COMPONENTS, BUILTIN_PARTICLE_TEMPLATES, particleComponents, particleTemplates } from "../../particles";
import { BUILTIN_IMPORTERS, modelImporters } from "../../model-import";
import { BUILTIN_LAYER_KINDS, layerKinds } from "../../layer-kinds";
import { inspectorGroups, inspectorTabs, puppetGenerators, puppetTools } from "../../inspector";
import { BUILTIN_EXPORTERS, BUILTIN_EXPORT_HOOKS, BUILTIN_EXPORT_RULES, exportHooks, exportRules, exporters } from "../../export-pipeline";
import { SWAY_GENERATOR } from "./puppet-sway";
import type { Registry } from "../../core";

/** 服务名 → 注册表（模块级单例：纯函数模块直接读同一份） */
export const REGISTRIES = {
  effects: effectCatalog,
  shaders: shaderSnippets,
  "particles.templates": particleTemplates,
  "particles.components": particleComponents,
  importers: modelImporters,
  layerKinds,
  inspector: inspectorGroups,
  "inspector.tabs": inspectorTabs,
  "puppet.tools": puppetTools,
  "puppet.generators": puppetGenerators,
  exporters,
  "export.hooks": exportHooks,
  "export.rules": exportRules,
} as const satisfies Record<string, Registry<any>>;

export type RegistryName = keyof typeof REGISTRIES;

export const registriesPlugin: PluginObject = {
  name: "registries",
  provides: Object.keys(REGISTRIES),
  apply(ctx: Context) {
    for (const [name, reg] of Object.entries(REGISTRIES)) ctx.provide(name, reg);
  },
};

const contributeAll = (name: string, service: RegistryName, items: readonly unknown[]): PluginObject => ({
  name,
  inject: [service],
  apply(ctx) {
    for (const it of items) ctx.contribute(service, it);
  },
});

export const builtinEffects = contributeAll("builtin-effects", "effects", EFFECTS);
export const builtinShaders = contributeAll("builtin-shaders", "shaders", BUILTIN_SNIPPETS);
export const builtinImporters = contributeAll("builtin-importers", "importers", BUILTIN_IMPORTERS);
export const builtinLayerKinds = contributeAll("builtin-layer-kinds", "layerKinds", BUILTIN_LAYER_KINDS);
export const puppetSway = contributeAll("puppet-sway", "puppet.generators", [SWAY_GENERATOR]);

export const builtinParticles: PluginObject = {
  name: "builtin-particles",
  inject: ["particles.components", "particles.templates"],
  apply(ctx) {
    // 组件先登记：模板校验依赖它（unknownComponents）
    for (const c of BUILTIN_PARTICLE_COMPONENTS) ctx.contribute("particles.components", c);
    for (const t of BUILTIN_PARTICLE_TEMPLATES) ctx.contribute("particles.templates", t);
  },
};

export const builtinExport: PluginObject = {
  name: "builtin-export",
  inject: ["exporters", "export.hooks", "export.rules"],
  apply(ctx) {
    for (const e of BUILTIN_EXPORTERS) ctx.contribute("exporters", e);
    for (const h of BUILTIN_EXPORT_HOOKS) ctx.contribute("export.hooks", h);
    for (const r of BUILTIN_EXPORT_RULES) ctx.contribute("export.rules", r);
  },
};

export const BUILTIN_CATALOG: Catalog = {
  registries: registriesPlugin,
  "builtin-effects": builtinEffects,
  "builtin-shaders": builtinShaders,
  "builtin-particles": builtinParticles,
  "builtin-importers": builtinImporters,
  "builtin-layer-kinds": builtinLayerKinds,
  "builtin-export": builtinExport,
  "puppet-sway": puppetSway,
};

export const BUILTIN_PROFILE: Profile = {
  plugins: Object.keys(BUILTIN_CATALOG).map((name) => ({ name })),
};
