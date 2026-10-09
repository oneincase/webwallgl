// 编辑器服务契约：插件经 ctx.get(<名>) 拿到的全部服务。
// 每个名字在这里用声明合并挂进 Services，ctx.get 就能推断出类型；
// 外部插件 SDK（editor/sdk）原样转出这些类型。

import type { EditorDoc, LayerNode, SceneObject } from "../doc";
import type { OverlayAssets } from "../assets";
import type { EditHistory } from "../history";
import type { EditorControls } from "../../renderer/src/api/editor";
import type { Disposer, Registry } from "../core";
import type { EffectDef } from "../effects";
import type { ShaderSnippet } from "../shader-lib";
import type { ParticleComponent, ParticleTemplate } from "../particles";
import type { ModelImporter } from "../model-import";
import type { LayerKindDef } from "../layer-kinds";
import type { InspectorGroup, InspectorTab, PuppetGenerator, PuppetTool } from "../inspector";
import type { Exporter, ExportHook, ExportRule } from "../export-pipeline";

export type LayerId = number | string;
export type LogLevel = "info" | "warn" | "error";

/** 文档：只经它改 scene.json（全部可撤销），不直接碰 main.ts 的状态 */
export interface DocService {
  current(): EditorDoc | null;
  selectedId(): LayerId | null;
  selection(): LayerNode | null;
  find(id: LayerId): LayerNode | null;
  select(id: LayerId | null): void;
  isLocked(id: LayerId): boolean;
  /** 一次可撤销的对象编辑（结构编辑 + 重挂）；mutate 返回 false = 没改，不入栈 */
  editObject(label: string, id: LayerId, mutate: (o: SceneObject) => boolean): boolean;
  /** 一次可撤销的文档结构编辑；mutate 返回编辑后要选中的图层 id */
  editStructure(label: string, mutate: (d: EditorDoc) => LayerId | undefined | null): void;
  /** 重建图层树 / 检视器（插件自己的状态变了时调用） */
  refresh(): void;
  log(msg: string, level?: LogLevel): void;
}

export interface HistoryService {
  stack(): EditHistory;
  undo(): void;
  redo(): void;
}

export interface AssetsService {
  overlay(): OverlayAssets | null;
  /** 写一个工程文件；group = 拥有者路径（不再被引用时不进保存清单）。无工程时返回 false */
  put(name: string, data: Uint8Array, group?: string): boolean;
  read(name: string): Promise<Uint8Array | null>;
  has(name: string): boolean;
  list(): string[];
  /** 在 path 上加 -2、-3… 直到不与现有文件 / 引用冲突 */
  unique(path: string): string;
  /** 引用扫描：返回文档当前引用的「拥有者路径」（插件自建的文件组靠它留在保存清单里） */
  addReferenceScanner(fn: (doc: EditorDoc) => Iterable<string>): Disposer;
  referenced(doc: EditorDoc | null): Set<string>;
}

export interface EngineService {
  controls(): EditorControls | null;
  /** 从当前文档重挂引擎（结构编辑之外插件自己改了资源时用） */
  remount(): void;
}

export type CommandDef = {
  id: string;
  /** 命令面板里的标题：i18n 词条名，或 { zh, en } 双语；缺省按 `cmd.<id>` 找词条、再退回 id 字面量 */
  title?: string | Record<string, string>;
  /** 命令面板里的分类：同上；缺省归到「其它」 */
  category?: string | Record<string, string>;
  /** 快捷键：「Mod+Shift+K」形式，Mod = ⌘ / Ctrl；数组 = 多个等价键 */
  keys?: string | readonly string[];
  /** 面板里列出但不可直接执行：这条命令需要参数（例如导出目标 id），只能由别的入口调用 */
  needsArg?: boolean;
  when?: () => boolean;
  run: (...args: unknown[]) => unknown;
};

export interface CommandService {
  readonly registry: Registry<CommandDef>;
  /** 注册一条命令（内置与插件走同一条路）；返回撤销函数，owner 用于查归属与随插件卸载撤回 */
  register(def: CommandDef, owner?: string): Disposer;
  exec(id: string, ...args: unknown[]): unknown;
  /** 键盘事件 → 命中的命令执行（返回是否已处理） */
  handleKey(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">): boolean;
}

export type SlotName =
  | "toolbar"
  | "menu.export"
  | "menu.add"
  | "panel.right"
  | "inspector.project"
  | "statusbar"
  | "viewport.overlay"
  | (string & {});

export type SlotItem = {
  id: string;
  order?: number;
  render(): HTMLElement | null;
};

export interface UiService {
  add(slot: SlotName, item: SlotItem): Disposer;
  items(slot: SlotName): SlotItem[];
  /** 宿主把槽位挂到一个容器上；贡献项变化时自动重建。返回卸载函数 */
  mount(slot: SlotName, host: HTMLElement): Disposer;
  onChange(slot: SlotName, fn: () => void): Disposer;
}

export interface I18nService {
  lang(): string;
  t(key: string, params?: Record<string, string | number>): string;
  /** 追加词条（卸载自动撤回）；同键后加优先，但不覆盖内置词典 */
  extend(lang: string, dict: Record<string, string>): Disposer;
  text(v: string | Record<string, string> | undefined, fallback: string): string;
}

export interface SettingsService {
  get<T = unknown>(key: string, fallback: T): T;
  set(key: string, value: unknown): void;
  remove(key: string): void;
  /** 按插件名分出的命名空间 */
  scope(ns: string): SettingsService;
}

export interface StorageService {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys(prefix?: string): Promise<string[]>;
}

// 模块增强必须指向真正声明 Services 的模块（不能用 "../core" barrel，增强对 barrel 不生效）
declare module "../core/context" {
  interface Services {
    doc: DocService;
    history: HistoryService;
    assets: AssetsService;
    engine: EngineService;
    commands: CommandService;
    ui: UiService;
    i18n: I18nService;
    settings: SettingsService;
    storage: StorageService;
    effects: Registry<EffectDef>;
    shaders: Registry<ShaderSnippet>;
    "particles.templates": Registry<ParticleTemplate>;
    "particles.components": Registry<ParticleComponent>;
    importers: Registry<ModelImporter>;
    layerKinds: Registry<LayerKindDef>;
    inspector: Registry<InspectorGroup>;
    "inspector.tabs": Registry<InspectorTab>;
    "puppet.tools": Registry<PuppetTool>;
    "puppet.generators": Registry<PuppetGenerator>;
    exporters: Registry<Exporter>;
    "export.hooks": Registry<ExportHook>;
    "export.rules": Registry<ExportRule>;
  }
}
