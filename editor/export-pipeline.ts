// 导出管线（PLUGIN-ARCHITECTURE §4）：collect → transform → validate → pack → validate(packed) → sink。
//
// 三个贡献点，全部是注册表：
//   exporters   —— 一种导出目标（WE scene.pkg / 散装文件夹 / zip / 视频…），菜单按钮 id = export-<id>；
//   exportHooks —— transform 阶段改清单（project.json 生成、剥编辑器私有文件、加水印…），按 order 串行；
//   exportRules —— validate 阶段查清单，出诊断；stage = "loose" 查打包前，"packed" 查最终产物。
// 有 error 级诊断时默认不进 sink（调用方可以 force）。插件只能产出 WE 原生数据，
// 最后一道闸是 we-compat 规则：用引擎自己的解析器把产物再读一遍（renderer/src/editor/compat.ts）。

import { checkWeCompat, type WeCompatIssue } from "../renderer/src/api/editor";
import { createRegistry, type Registry } from "./core/registry";
import type { EditorDoc } from "./doc";
import { downloadZip, packProject, pickDirectory, slugName, writeToDirectory, type SaveFile } from "./save";

export type ExportLevel = "error" | "warn" | "info";

export type ExportDiag = {
  level: ExportLevel;
  code: string;
  message: string;
  path?: string;
  /** 出这条诊断的规则 / 钩子 id */
  source: string;
};

export type ExportContext = {
  exporter: string;
  doc: EditorDoc;
  files: SaveFile[];
  /** 管线内共享的杂项（packed 统计、插件清单…） */
  meta: Record<string, unknown>;
  diag(level: ExportLevel, code: string, message: string, path?: string): void;
  signal?: AbortSignal;
};

export interface Exporter {
  id: string;
  title?: string;
  order?: number;
  /** 适用的工程；缺省 any */
  accepts?: "scene" | "video" | "any";
  /** 额外的可用条件（如录视频要有活引擎） */
  enabled?: () => boolean;
  /** 不走文件清单的导出（如录视频：打开录制面板）—— 有 action 时管线只调它 */
  action?: (doc: EditorDoc) => void | Promise<void>;
  /** 散装清单 → 最终清单（WE 原生形态打 scene.pkg 就在这一步） */
  pack?: (ctx: ExportContext) => SaveFile[] | Promise<SaveFile[]>;
  /** 落地；返回一句给控制台的话 */
  sink?: (files: SaveFile[], ctx: ExportContext) => Promise<string | void>;
}

export interface ExportHook {
  id: string;
  order?: number;
  /** 只对这些导出目标生效；缺省全部 */
  exporters?: readonly string[];
  run(ctx: ExportContext): void | Promise<void>;
}

export interface ExportRule {
  id: string;
  order?: number;
  stage: "loose" | "packed";
  exporters?: readonly string[];
  check(ctx: ExportContext): void | Promise<void>;
}

const byOrder = (x: { order?: number }) => x.order ?? 100;

export const exporters: Registry<Exporter> = createRegistry<Exporter>("exporters", {
  orderOf: byOrder,
  validate: (e) => {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(e.id)) throw new Error(`导出目标 id「${e.id}」只能是小写字母、数字、连字符`);
    if (!e.action && !e.sink) throw new Error(`导出目标 ${e.id} 既没有 action 也没有 sink`);
  },
});
export const exportHooks: Registry<ExportHook> = createRegistry<ExportHook>("export.hooks", { orderOf: byOrder });
export const exportRules: Registry<ExportRule> = createRegistry<ExportRule>("export.rules", { orderOf: byOrder });

const applies = (x: { exporters?: readonly string[] }, id: string) => !x.exporters || x.exporters.includes(id);

export function exporterAccepts(e: Exporter, doc: EditorDoc | null): boolean {
  if (!doc) return false;
  const want = e.accepts ?? "any";
  if (want === "scene") return !!doc.scene;
  if (want === "video") return !!doc.video;
  return !!doc.scene || !!doc.video;
}

export type ExportResult = {
  ok: boolean;
  /** 因 error 级诊断停在 sink 前 */
  blocked: boolean;
  files: SaveFile[];
  diags: ExportDiag[];
  message?: string;
  meta: Record<string, unknown>;
};

export type RunOptions = {
  /** 有 error 也照样落地 */
  force?: boolean;
  /** 只跑到 validate，不调 sink（判据 / 预检用） */
  dryRun?: boolean;
  signal?: AbortSignal;
  /** 管线 meta 的初值（如 plugins：工程用到的外部插件，project-json 钩子写进 editor.plugins） */
  meta?: Record<string, unknown>;
  /** 某个钩子 / 规则自身抛错时回调（插件内核据此记错误预算） */
  onPluginError?: (id: string, error: unknown) => void;
};

/**
 * 跑一次导出。collect 由调用方给（编辑器里是 collectCurrent(preview)），管线不碰页面状态；
 * 钩子 / 规则抛错不打断导出，记成一条 error 诊断（source = 它的 id）。
 */
export async function runExportPipeline(
  exporterId: string,
  doc: EditorDoc,
  collect: () => Promise<SaveFile[] | null>,
  opts: RunOptions = {},
): Promise<ExportResult> {
  const exporter = exporters.get(exporterId);
  if (!exporter) throw new Error(`没有导出目标 ${exporterId}`);
  const diags: ExportDiag[] = [];
  const meta: Record<string, unknown> = { ...opts.meta };
  const result = (files: SaveFile[], extra: Partial<ExportResult> = {}): ExportResult => ({
    ok: !diags.some((d) => d.level === "error"),
    blocked: false,
    files,
    diags,
    meta,
    ...extra,
  });
  if (exporter.action) {
    await exporter.action(doc);
    return result([]);
  }
  const collected = await collect();
  if (!collected) return result([], { ok: false, message: "没有可导出的内容" });

  let source = exporterId;
  const ctx: ExportContext = {
    exporter: exporterId,
    doc,
    files: collected,
    meta,
    signal: opts.signal,
    diag: (level, code, message, path) => diags.push(path ? { level, code, message, path, source } : { level, code, message, source }),
  };
  const guarded = async (id: string, fn: () => void | Promise<void>) => {
    source = id;
    try {
      await fn();
    } catch (e) {
      diags.push({ level: "error", code: "plugin-error", message: `${id}：${(e as Error)?.message ?? String(e)}`, source: id });
      opts.onPluginError?.(id, e);
    } finally {
      source = exporterId;
    }
  };

  for (const h of exportHooks.list()) if (applies(h, exporterId)) await guarded(h.id, () => h.run(ctx));
  for (const r of exportRules.list()) if (r.stage === "loose" && applies(r, exporterId)) await guarded(r.id, () => r.check(ctx));
  if (exporter.pack) {
    const pack = exporter.pack;
    await guarded(exporterId, async () => {
      ctx.files = await pack(ctx);
    });
  }
  for (const r of exportRules.list()) if (r.stage === "packed" && applies(r, exporterId)) await guarded(r.id, () => r.check(ctx));
  opts.signal?.throwIfAborted?.();

  const hasError = diags.some((d) => d.level === "error");
  if (opts.dryRun) return result(ctx.files);
  if (hasError && !opts.force) return result(ctx.files, { ok: false, blocked: true });
  let message: string | undefined;
  if (exporter.sink) message = (await exporter.sink(ctx.files, ctx)) ?? undefined;
  return result(ctx.files, { message });
}

// ─── 内置：导出目标 ─────────────────────────────────────────────────────────

const zipName = (doc: EditorDoc, suffix = "") => `${slugName(doc.title)}${suffix}`;
const mb = (n: number) => (n / 1e6).toFixed(1);

export const BUILTIN_EXPORTERS: readonly Exporter[] = [
  {
    id: "pkg",
    title: "export.pkg",
    order: 10,
    accepts: "any",
    pack: (ctx) => {
      if (!ctx.doc.scene) return ctx.files;
      const { files, packed } = packProject(ctx.files);
      ctx.meta.packed = { entries: packed.entries.length, converted: packed.converted.length, bytes: packed.pkg.length };
      return files;
    },
    sink: async (files, ctx) => {
      const size = downloadZip(files, zipName(ctx.doc, ctx.doc.scene ? "-pkg" : ""));
      ctx.meta.size = size;
      return `${files.length} 个文件，${mb(size)} MB`;
    },
  },
  {
    id: "zip",
    title: "export.zip",
    order: 20,
    accepts: "any",
    sink: async (files, ctx) => {
      const size = downloadZip(files, zipName(ctx.doc));
      ctx.meta.size = size;
      return `${files.length} 个文件，${mb(size)} MB`;
    },
  },
  {
    id: "folder",
    title: "export.folder",
    order: 30,
    accepts: "any",
    pack: (ctx) => (ctx.doc.scene ? packProject(ctx.files).files : ctx.files),
    // WE 创意工坊上传器认的形态：一个文件夹里 project.json + 封面 + scene.pkg
    enabled: () => typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function",
    sink: async (files) => {
      const dir = await pickDirectory();
      if (!dir) return "已取消";
      await writeToDirectory(dir, files);
      return `已写入 ${dir.name}（${files.length} 个文件）`;
    },
  },
];

// ─── 内置：钩子与规则 ───────────────────────────────────────────────────────

const enc = new TextEncoder();
const dec = new TextDecoder();

/** 编辑器私有、不该进 WE 产物的文件（撤销快照、编辑器侧缓存…） */
const PRIVATE_FILE = /(^|\/)(\.webwallgl[^/]*|\.DS_Store|Thumbs\.db)$/i;

export const BUILTIN_EXPORT_HOOKS: readonly ExportHook[] = [
  {
    id: "strip-private",
    order: 10,
    run(ctx) {
      const before = ctx.files.length;
      ctx.files = ctx.files.filter((f) => !PRIVATE_FILE.test(f.path));
      if (ctx.files.length !== before) ctx.diag("info", "strip-private", `剥掉 ${before - ctx.files.length} 个编辑器私有文件`);
    },
  },
  {
    // project.json 的最终形态：WE 必需字段兜底 + 记下用到的插件（editor.plugins，WE 忽略未知键）
    id: "project-json",
    order: 50,
    run(ctx) {
      const i = ctx.files.findIndex((f) => f.path === "project.json");
      if (i < 0) return;
      let p: Record<string, unknown>;
      try {
        p = JSON.parse(dec.decode(ctx.files[i].data));
      } catch {
        return;
      }
      if (typeof p.title !== "string" || !p.title.trim()) p.title = ctx.doc.title || "wallpaper";
      if (p.visibility === undefined) p.visibility = "public";
      const plugins = ctx.meta.plugins as ReadonlyArray<{ id: string; version?: string }> | undefined;
      if (plugins?.length) {
        const editor = (p.editor && typeof p.editor === "object" ? p.editor : {}) as Record<string, unknown>;
        editor.plugins = plugins.map((x) => (x.version ? { id: x.id, version: x.version } : { id: x.id }));
        p.editor = editor;
      }
      ctx.files[i] = { path: "project.json", data: enc.encode(JSON.stringify(p, null, 2)) };
    },
  },
];

const compatLevel = (i: WeCompatIssue): ExportLevel => i.level;

export const BUILTIN_EXPORT_RULES: readonly ExportRule[] = [
  {
    id: "we-compat",
    order: 100,
    stage: "packed",
    async check(ctx) {
      const r = await checkWeCompat(ctx.files);
      ctx.meta.compat = { form: r.form, layers: r.layers, effects: r.effects };
      for (const i of r.issues) if (i.level !== "info") ctx.diag(compatLevel(i), i.code, i.message, i.path);
    },
  },
  {
    id: "size-budget",
    order: 110,
    stage: "packed",
    check(ctx) {
      const total = ctx.files.reduce((s, f) => s + f.data.length, 0);
      // 创意工坊单条目软上限；超过时上传器会拒（以 WE 官方文档为准，留余量）
      if (total > 1024 * 1024 * 1024) ctx.diag("warn", "size-budget", `产物 ${mb(total)} MB，超过 1 GB，创意工坊可能拒收`);
    },
  },
];

exporters.setFallback(BUILTIN_EXPORTERS);
