/**
 * 测试台的共享状态与事件总线。各面板模块之间不互相 import 回调，
 * 跨模块通知统一走 bus，避免循环依赖。
 */

export type LibraryItem = {
  itemId: string;
  title: string;
  type: string;
  file?: string;
  preview?: string;
  hasScene: boolean;
  /** 松散工程形态（源码目录，无 scene.pkg）：入口是 project.json 的 file 指向的 json */
  hasLooseScene?: boolean;
  properties: Record<string, unknown> | null;
};

export type WallpaperKind = "scene" | "web" | "video";

export type BackendState = "unknown" | "ok" | "down";

export const state = {
  items: [] as LibraryItem[],
  /** 当前挂载的库条目；本地 .pkg 预览时为 null、localFile 有值 */
  selected: null as LibraryItem | null,
  localFile: null as File | null,
  backend: "unknown" as BackendState,
  libDir: "",
};

type Events = {
  /** 选中条目 / 本地文件变化（含清空） */
  selection: void;
  /** 库列表重新载入 */
  library: void;
  /** 挂载期才生效的设置变了，需要重挂当前壁纸 */
  remount: void;
  /** 打开本地 .pkg（工具条、菜单、拖放共用） */
  "open-file": File;
  /** 渲染器页重新加载（新 iframe 从运行态起步） */
  mounted: void;
  /** 后端连通性变化 */
  backend: BackendState;
  /** 面板标签切换 */
  tab: { panel: TabPanel; id: string };
};

export type TabPanel = "left" | "center" | "bottom" | "right";

const handlers = new Map<keyof Events, Set<(payload: never) => void>>();

export function on<K extends keyof Events>(type: K, fn: (payload: Events[K]) => void) {
  let set = handlers.get(type);
  if (!set) handlers.set(type, (set = new Set()));
  set.add(fn as (payload: never) => void);
}

export function emit<K extends keyof Events>(type: K, ...payload: Events[K] extends void ? [] : [Events[K]]) {
  for (const fn of handlers.get(type) ?? []) (fn as (p: unknown) => void)(payload[0]);
}

/**
 * 条目归到哪一类。`type` 已由 host 侧按原生规则规范/推断过
 * （`host/we-library-scan.mjs`），这里只做小写比较，防上游漏改。
 * scene 以 hasScene / hasLooseScene 为准而不是看 type —— 真正决定能否走场景渲染的是
 * 「有没有场景来源」（scene.pkg 或散装工程目录，buildQuery 也是这么判的）。
 * `hasScene` 含 gifscene.pkg 布局：843532366 是 WE 的 GIF 导入模板场景
 * （包名 gifscene.pkg、入口 gifscene.json），渲染器能挂
 * （`renderer/src/api/source.ts` 的 PKG_PATHS 与 `scene-mount` 都认），实测 60fps 出画。
 * `hasLooseScene` 是官方内置工程那一族（arsenal/audiophile/… 无 scene.pkg）。
 */
export function kindOf(it: LibraryItem): WallpaperKind | null {
  if (it.hasScene || it.hasLooseScene) return "scene";
  const t = it.type.toLowerCase();
  if (t === "web") return "web";
  if (t === "video" || t === "gif") return "video";
  return null;
}

export const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
