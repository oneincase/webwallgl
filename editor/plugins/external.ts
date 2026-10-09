// 外部插件（PLUGIN-ARCHITECTURE §5）：清单 → 数据贡献 + 代码插件，挂到内核上。
//
// 一个插件包 = 一个目录（或等价的文件表），根上有 wwgl-plugin.json：
//   { id, name, version, engine, main?, contributes?: { effects, particles, "particles.components", shaders, i18n }, permissions? }
// · 数据贡献（不跑任何代码）：效果描述 JSON（frag / vert 指向包内文件）、粒子模板 JSON、
//   粒子组件 JSON（WE 组件名 + 参数描述，校验走 particles.components 注册表）、shader 片段、词条；
//   全部经注册表的 validate（粒子组件白名单、效果 id / 多 pass 约束……），不合法整包拒绝。
// · 代码插件（main）：单文件 ESM，默认导出一个 Plugin；以 Blob URL import()，挂成外层的子插件，
//   allow = 清单 permissions ∩ GRANTABLE —— 没授权的服务 ctx.get 拿不到、inject 也永远等不到（pending）。
// 本模块不碰 DOM：import 方式由调用方注入（浏览器 Blob URL / Node data: URL），Node 里可直接测。

import type { Context, PluginObject } from "../core";
import { defineEffect, type EffectDef, type EffectFbo, type EffectParam, type EffectPass } from "../effects";
import type { ParticleComponent, ParticleTemplate } from "../particles";
import type { ShaderSnippet } from "../shader-lib";
import type { SettingsService, StorageService } from "../services/types";

export const MANIFEST_NAME = "wwgl-plugin.json";
/** 插件 API 版本（清单 engine 字段对它求值；破坏性改动时升主版本） */
export const PLUGIN_API_VERSION = "1.0.0";

export type LocalText = string | Record<string, string>;

export type PluginManifest = {
  id: string;
  name: LocalText;
  version: string;
  /** 适配的插件 API 版本范围：「*」「1」「^1.0」「>=1.0」「1.x」 */
  engine: string;
  description?: LocalText;
  author?: string;
  /** 代码入口（包内路径，单文件 ESM） */
  main?: string;
  contributes?: {
    /** 效果描述 JSON 的包内路径 */
    effects?: string[];
    /** 粒子模板 JSON 的包内路径 */
    particles?: string[];
    /** 粒子组件（WE 组件名 + 参数描述）JSON 的包内路径；与 particles（模板）是两个注册表 */
    "particles.components"?: string[];
    /** shader 片段文件；include 名 = wwgl/<插件 id>/<文件名去扩展名> */
    shaders?: string[];
    /** 语言 → 词条 JSON 的包内路径 */
    i18n?: Record<string, string>;
  };
  /** 代码插件要用的服务（只有 GRANTABLE 里的会被授予） */
  permissions?: string[];
};

/** 可以授予外部代码插件的服务，及其风险等级（high = 能改文档 / 读写工程文件，安装时醒目提示） */
export const GRANTABLE: Record<string, "low" | "high"> = {
  effects: "low",
  shaders: "low",
  "particles.templates": "low",
  "particles.components": "low",
  importers: "low",
  layerKinds: "low",
  inspector: "low",
  "inspector.tabs": "low",
  "puppet.tools": "low",
  "puppet.generators": "low",
  exporters: "high",
  "export.hooks": "high",
  "export.rules": "low",
  i18n: "low",
  commands: "low",
  ui: "low",
  settings: "low",
  storage: "low",
  doc: "high",
  history: "high",
  assets: "high",
  engine: "high",
};

export type PluginPackage = {
  manifest: PluginManifest;
  files: Map<string, Uint8Array>;
  /** 来源：store = 浏览器里安装（IndexedDB）；dir = 插件目录（dev 宿主 / 桌面壳）；bundled = 随应用自带的示例；memory = 测试 / 临时 */
  source: "store" | "dir" | "bundled" | "memory";
  /** 来源侧的版本戳（目录 mtime 等），变了就热重载 */
  stamp?: string;
  /** 目录来源的目录名 */
  dir?: string;
};

const ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;
const dec = new TextDecoder();

function parseVer(v: string): [number, number, number] {
  const [a, b, c] = v.split(/[.-]/).map((x) => Number.parseInt(x, 10));
  return [a || 0, b || 0, c || 0];
}

const cmpVer = (x: [number, number, number], y: [number, number, number]) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2];

/** 清单 engine 范围是否接受 api 版本（只认常用几种写法；看不懂的一律不接受） */
export function engineSatisfies(range: string, api = PLUGIN_API_VERSION): boolean {
  const r = range.trim();
  const v = parseVer(api);
  if (r === "*" || r === "") return true;
  let m = /^(\d+)(?:\.x)?$/.exec(r);
  if (m) return v[0] === Number(m[1]);
  m = /^\^(\d+(?:\.\d+){0,2})$/.exec(r);
  if (m) {
    const lo = parseVer(m[1]);
    return v[0] === lo[0] && cmpVer(v, lo) >= 0;
  }
  m = /^>=\s*(\d+(?:\.\d+){0,2})$/.exec(r);
  if (m) return cmpVer(v, parseVer(m[1])) >= 0;
  return false;
}

const isText = (v: unknown): v is LocalText =>
  typeof v === "string" ? v.trim().length > 0 : !!v && typeof v === "object" && Object.values(v).every((x) => typeof x === "string");

const isPathList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string" && x.length > 0);

/** 规范包内路径：去掉 ./、反斜杠转正斜杠；拒绝 .. 与绝对路径 */
export function normPath(p: string): string | null {
  const s = p.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!s || s.startsWith("/") || s.split("/").some((x) => x === ".." || x === "")) return null;
  return s;
}

/** 解析并校验清单；返回错误列表（空 = 合法） */
export function parseManifest(raw: unknown): { manifest: PluginManifest | null; errors: string[] } {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { manifest: null, errors: ["清单必须是 JSON 对象"] };
  const m = raw as Record<string, unknown>;
  if (typeof m.id !== "string" || !ID_RE.test(m.id)) errors.push(`id 必须是 2–64 位小写字母数字和 -：${String(m.id)}`);
  if (!isText(m.name)) errors.push("缺少 name");
  if (typeof m.version !== "string" || !SEMVER_RE.test(m.version)) errors.push(`version 必须是 x.y.z：${String(m.version)}`);
  if (typeof m.engine !== "string") errors.push("缺少 engine（插件 API 版本范围，如 ^1.0）");
  else if (!engineSatisfies(m.engine)) errors.push(`engine ${m.engine} 不接受当前插件 API ${PLUGIN_API_VERSION}`);
  if (m.description !== undefined && !isText(m.description)) errors.push("description 必须是字符串或 { 语言: 文本 }");
  if (m.main !== undefined && (typeof m.main !== "string" || !normPath(m.main) || !/\.m?js$/.test(m.main))) errors.push(`main 必须是包内 .js / .mjs 路径：${String(m.main)}`);
  const c = m.contributes;
  if (c !== undefined) {
    if (!c || typeof c !== "object" || Array.isArray(c)) errors.push("contributes 必须是对象");
    else {
      const cc = c as Record<string, unknown>;
      for (const k of ["effects", "particles", "particles.components", "shaders"] as const) {
        if (cc[k] !== undefined && !isPathList(cc[k])) errors.push(`contributes.${k} 必须是路径数组`);
      }
      if (cc.i18n !== undefined && (!cc.i18n || typeof cc.i18n !== "object" || !Object.values(cc.i18n).every((x) => typeof x === "string"))) {
        errors.push("contributes.i18n 必须是 { 语言: 路径 }");
      }
      const known = new Set(["effects", "particles", "particles.components", "shaders", "i18n"]);
      for (const k of Object.keys(cc)) if (!known.has(k)) errors.push(`未知的 contributes.${k}`);
    }
  }
  if (m.permissions !== undefined) {
    if (!Array.isArray(m.permissions) || !m.permissions.every((x) => typeof x === "string")) errors.push("permissions 必须是字符串数组");
    else for (const p of m.permissions) if (!(p in GRANTABLE)) errors.push(`不可授予的权限：${p}`);
  }
  return { manifest: errors.length ? null : (m as unknown as PluginManifest), errors };
}

/** 文件表（任意来源）→ 插件包；清单可以在根上，也可以在唯一的顶层目录里（拖进一个文件夹的常见形态） */
export function packageFromFiles(entries: Iterable<{ path: string; data: Uint8Array }>, source: PluginPackage["source"] = "memory"): PluginPackage {
  const files = new Map<string, Uint8Array>();
  for (const e of entries) {
    const p = normPath(e.path);
    if (p) files.set(p, e.data);
  }
  let root = "";
  if (!files.has(MANIFEST_NAME)) {
    const hits = [...files.keys()].filter((p) => p.endsWith(`/${MANIFEST_NAME}`)).sort((a, b) => a.length - b.length);
    if (!hits.length) throw new Error(`包里没有 ${MANIFEST_NAME}`);
    root = hits[0].slice(0, -MANIFEST_NAME.length);
  }
  const strip = new Map<string, Uint8Array>();
  for (const [p, d] of files) if (p.startsWith(root)) strip.set(p.slice(root.length), d);
  let raw: unknown;
  try {
    raw = JSON.parse(dec.decode(strip.get(MANIFEST_NAME)!));
  } catch (e) {
    throw new Error(`${MANIFEST_NAME} 不是合法 JSON：${(e as Error).message}`);
  }
  const { manifest, errors } = parseManifest(raw);
  if (!manifest) throw new Error(`${MANIFEST_NAME} 不合法：${errors.join("；")}`);
  return { manifest, files: strip, source };
}

export type DataContributions = {
  effects: EffectDef[];
  particles: ParticleTemplate[];
  components: ParticleComponent[];
  shaders: ShaderSnippet[];
  i18n: Record<string, Record<string, string>>;
};

/** 外部插件效果的目录前缀：wwgl_<插件 id>_（与内置 wwgl_ 同族，兼容校验对它同样严格） */
export const effectPrefixOf = (pluginId: string) => `wwgl_${pluginId.replace(/-/g, "_")}_`;

/** 外部插件 shader 片段的 include 名前缀 */
export const snippetPrefixOf = (pluginId: string) => `wwgl/${pluginId}/`;

/** 读出清单里的全部数据贡献（只解析，不登记）；任何一项出错整包拒绝 */
export function dataContributions(pkg: PluginPackage): DataContributions {
  const { manifest: m, files } = pkg;
  const errs: string[] = [];
  const text = (p: string, what: string): string | null => {
    const n = normPath(p);
    const d = n ? files.get(n) : undefined;
    if (!d) {
      errs.push(`${what} 引用的文件不在包里：${p}`);
      return null;
    }
    return dec.decode(d);
  };
  const json = (p: string, what: string): Record<string, unknown> | null => {
    const t = text(p, what);
    if (t === null) return null;
    try {
      const v = JSON.parse(t);
      if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("不是对象");
      return v;
    } catch (e) {
      errs.push(`${what} ${p} 不是合法 JSON 对象：${(e as Error).message}`);
      return null;
    }
  };
  const out: DataContributions = { effects: [], particles: [], components: [], shaders: [], i18n: {} };
  const c = m.contributes ?? {};

  for (const p of c.effects ?? []) {
    const j = json(p, "效果");
    if (!j) continue;
    // 着色器字段可以是包内路径（.frag / .vert / .glsl）或内联源码
    const src = (v: unknown, what: string): string | undefined => {
      if (typeof v !== "string") return undefined;
      return /\.(frag|vert|glsl)$/.test(v) && !v.includes("\n") ? (text(v, what) ?? undefined) : v;
    };
    const id = String(j.id);
    // 每个 pass 给整段 frag，或只给 body（+ declarations）—— 后者由 defineEffect 补头部与参数 uniform
    const passes = Array.isArray(j.passes)
      ? (j.passes as Array<Record<string, unknown>>).map((q, i) => ({
          frag: src(q.frag, `效果 ${id} pass ${i} frag`),
          body: src(q.body, `效果 ${id} pass ${i} body`),
          declarations: src(q.declarations, `效果 ${id} pass ${i} declarations`),
          vert: src(q.vert, `效果 ${id} pass ${i} vert`),
          target: typeof q.target === "string" ? q.target : undefined,
          bind: Array.isArray(q.bind) ? (q.bind as EffectPass["bind"]) : undefined,
          blending: typeof q.blending === "string" ? q.blending : undefined,
        }))
      : undefined;
    const frag = src(j.frag, `效果 ${id} frag`);
    const body = src(j.body, `效果 ${id} body`);
    if (typeof j.id !== "string" || (!frag && !body && !passes?.some((q) => q.frag || q.body))) {
      errs.push(`效果 ${p}：缺 id，或 frag / body / passes 都没有`);
      continue;
    }
    out.effects.push(
      defineEffect({
        id: j.id,
        title: isText(j.title) ? j.title : undefined,
        category: typeof j.category === "string" ? j.category : "plugin",
        params: Array.isArray(j.params) ? (j.params as EffectParam[]) : [],
        frag,
        body,
        declarations: src(j.declarations, `效果 ${id} declarations`),
        vert: src(j.vert, `效果 ${id} vert`),
        passes,
        fbos: Array.isArray(j.fbos) ? (j.fbos as EffectFbo[]) : undefined,
        prefix: effectPrefixOf(m.id),
      }),
    );
  }

  for (const p of c.particles ?? []) {
    const j = json(p, "粒子模板");
    if (!j) continue;
    const files0 = Array.isArray(j.files) ? (j.files as Array<{ name?: unknown; src?: unknown }>) : [];
    const tFiles: Array<{ name: string; data: Uint8Array }> = [];
    for (const f of files0) {
      const n = typeof f.src === "string" ? normPath(f.src) : null;
      const d = n ? files.get(n) : undefined;
      if (typeof f.name !== "string" || !d) errs.push(`粒子模板 ${p}：files 项缺 name 或 src 不在包里`);
      else tFiles.push({ name: f.name, data: d });
    }
    const { files: _f, ...rest } = j;
    out.particles.push({ ...(rest as unknown as ParticleTemplate), ...(tFiles.length ? { files: tFiles } : {}) });
  }

  for (const p of c["particles.components"] ?? []) {
    const j = json(p, "粒子组件");
    if (!j) continue;
    const kind = j.kind;
    if (typeof j.id !== "string" || !j.id) errs.push(`粒子组件 ${p}：缺 id`);
    else if (kind !== "emitter" && kind !== "initializer" && kind !== "operator" && kind !== "renderer") {
      errs.push(`粒子组件 ${p}：kind 必须是 emitter / initializer / operator / renderer`);
    } else out.components.push({ id: j.id, kind, params: Array.isArray(j.params) ? (j.params as ParticleComponent["params"]) : undefined });
  }

  for (const p of c.shaders ?? []) {
    const code = text(p, "shader 片段");
    if (code === null) continue;
    const stem = p.split("/").pop()!.replace(/\.[^.]+$/, "");
    out.shaders.push({ id: `${snippetPrefixOf(m.id)}${stem}`, code });
  }

  for (const [lang, p] of Object.entries(c.i18n ?? {})) {
    const j = json(p, `词条（${lang}）`);
    if (!j) continue;
    if (!Object.values(j).every((v) => typeof v === "string")) errs.push(`词条 ${p}：值必须都是字符串`);
    else out.i18n[lang] = j as Record<string, string>;
  }

  if (errs.length) throw new Error(errs.join("；"));
  return out;
}

/** 代码插件的 import 方式（浏览器：Blob URL；Node 测试：data: URL） */
export type ModuleImporter = (code: string, name: string) => Promise<Record<string, unknown>>;

export const blobImporter: ModuleImporter = async (code) => {
  const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
  try {
    return await import(/* @vite-ignore */ url);
  } finally {
    URL.revokeObjectURL(url);
  }
};

/** 代码插件 apply 时拿到的 config：自己的清单 + 包内文件读取 + 按插件 id 隔离的设置 / 存储 */
export type ExternalPluginHost = {
  manifest: PluginManifest;
  file(path: string): Uint8Array | null;
  text(path: string): string | null;
  settings: SettingsService | null;
  storage: StorageService | null;
};

export const grantedOf = (m: PluginManifest) => (m.permissions ?? []).filter((p) => p in GRANTABLE);

function scopedStorage(s: StorageService, ns: string): StorageService {
  return {
    get: (k) => s.get(ns + k),
    set: (k, v) => s.set(ns + k, v),
    delete: (k) => s.delete(ns + k),
    keys: async (p = "") => (await s.keys(ns + p)).map((k) => k.slice(ns.length)),
  };
}

export type ExternalDeps = {
  importModule: ModuleImporter;
  /** 插件私有设置 / 存储的底座（按 plugin.<id>. 分命名空间） */
  settings?: SettingsService;
  storage?: StorageService;
};

/** 插件包 → 内核插件（外层可信包装：登记数据贡献、再把代码挂成受限子插件） */
export function externalPlugin(pkg: PluginPackage, deps: ExternalDeps): PluginObject {
  const m = pkg.manifest;
  const c = m.contributes ?? {};
  const need = new Set<string>();
  if (c.effects?.length) need.add("effects");
  if (c.particles?.length) need.add("particles.templates");
  if (c["particles.components"]?.length) need.add("particles.components");
  if (c.shaders?.length) need.add("shaders");
  if (c.i18n && Object.keys(c.i18n).length) need.add("i18n");
  return {
    name: `ext:${m.id}`,
    inject: [...need],
    async apply(ctx: Context) {
      const data = dataContributions(pkg);
      // 片段先于效果（效果写盘时要展开 include）
      for (const s of data.shaders) ctx.contribute("shaders", s);
      for (const e of data.effects) ctx.contribute("effects", e);
      // 组件先于模板（模板里的算子要能对上已登记的组件）
      for (const k of data.components) ctx.contribute("particles.components", k);
      for (const t of data.particles) ctx.contribute("particles.templates", t);
      for (const [lang, dict] of Object.entries(data.i18n)) {
        const i18n = ctx.get("i18n");
        ctx.effect(() => i18n.extend(lang, dict));
      }
      if (!m.main) return;
      const code = pkg.files.get(normPath(m.main)!);
      if (!code) throw new Error(`入口 ${m.main} 不在包里`);
      const mod = await deps.importModule(dec.decode(code), `${m.id}/${m.main}`);
      const entry = (mod.default ?? mod.plugin ?? mod.apply) as unknown;
      if (!entry || (typeof entry !== "function" && typeof (entry as PluginObject).apply !== "function")) {
        throw new Error(`入口 ${m.main} 没有默认导出插件（export default { name, apply } 或函数）`);
      }
      const host: ExternalPluginHost = {
        manifest: m,
        file: (p) => {
          const n = normPath(p);
          return n ? (pkg.files.get(n) ?? null) : null;
        },
        text: (p) => {
          const n = normPath(p);
          const d = n ? pkg.files.get(n) : undefined;
          return d ? dec.decode(d) : null;
        },
        settings: deps.settings?.scope(`plugin.${m.id}`) ?? null,
        storage: deps.storage ? scopedStorage(deps.storage, `plugin.${m.id}.`) : null,
      };
      // 白名单只放清单声明且可授予的服务；子插件 inject 了未授权服务 → 永远 pending（管理面板显示缺权限）
      ctx.plugin(entry as PluginObject, host, { allow: grantedOf(m), meta: { manifest: m, code: true } });
    },
  };
}
