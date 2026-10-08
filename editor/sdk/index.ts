// WebWallGL 编辑器插件 SDK（PLUGIN-ARCHITECTURE §6）。
//
// 外部插件只经这里拿类型：全部是 `export type` 转出编辑器真源里的契约，SDK 与编辑器不会各写一份而漂移。
// 运行时只有 definePlugin 等恒等函数（给类型推断用），插件打包时被内联，**不会**把编辑器代码打进插件 ——
// 插件拿到的一切能力都经 ctx.get(<服务>)，受清单 permissions 门控。
// scripts/build-plugin-sdk.mjs 把本文件出成 dist/plugin-sdk（.d.ts + 恒等函数），并构建 examples/plugins。

import type { PluginObject } from "../core";
import type { ExternalPluginHost } from "../plugins/external";

export type {
  Context,
  Disposer,
  InjectSpec,
  Plugin,
  PluginApply,
  PluginObject,
  Registry,
  Schema,
  Scope,
  ScopeStatus,
  Services,
} from "../core";
export type {
  AssetsService,
  CommandDef,
  CommandService,
  DocService,
  EngineService,
  HistoryService,
  I18nService,
  LayerId,
  LogLevel,
  SettingsService,
  SlotItem,
  SlotName,
  StorageService,
  UiService,
} from "../services/types";
export type { EffectDef, EffectFbo, EffectParam, EffectPass } from "../effects";
export type { ShaderSnippet } from "../shader-lib";
export type { ParticleComponent, ParticleComponentKind, ParticleOp, ParticleTemplate } from "../particles";
export type { ModelImporter } from "../model-import";
export type { IRAnim, IRChannel, IRImage, IRMaterial, IRNode, IRPrim, IRSkin, IRWarning, ModelIR } from "../model-ir";
export type { LayerKindDef } from "../layer-kinds";
export type { InspectorGroup, InspectorTab, PuppetGenerator, PuppetTool } from "../inspector";
export type { ExportContext, ExportDiag, Exporter, ExportHook, ExportRule } from "../export-pipeline";
export type { EditorDoc, LayerNode, SceneObject } from "../doc";
export type { ExternalPluginHost, PluginManifest } from "../plugins/external";

/** 插件入口的默认导出：config = 宿主给的 ExternalPluginHost（清单、包内文件、私有设置 / 存储） */
export function definePlugin(p: PluginObject<ExternalPluginHost>): PluginObject<ExternalPluginHost> {
  return p;
}
