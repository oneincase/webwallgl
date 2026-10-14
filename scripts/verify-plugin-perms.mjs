#!/usr/bin/env node
/**
 * verify-plugin-perms —— D6 × D2 专项判据：逐项权限开关必须**真的拦住数据贡献**，日志查看按插件过滤 / 单插件清空 / 上限语义。
 *
 * 真源：editor/plugins/{external,manager,log}.ts + editor/ui/plugin-panel.ts（esbuild 打成临时 mjs 真跑）。
 *   A. 真内核 + 真 externalPlugin：五类数据贡献（效果 / shader 片段 / 粒子模板 / 粒子组件 / 词条）各有自己的开关；
 *      逐项关掉 → 对应 registry 里真的没有；其它类不受影响；重新打开 → 复原；
 *      「同一开关同时管数据与代码」：关 effects 只掉数据、代码子插件照常 active；再关 ui 子插件才 pending；
 *      关掉 ui 后，代码子插件先前 `ctx.effect(() => ui.add(...))` 贡献进槽位的项必须随之撤回（旧 Scope 被回收），
 *      重开回来、再关仍消失（幂等）、不误伤别的插件；每次重挂全程活跃同名 Scope ≤1（中间态不留重复项）；
 *      向后兼容：清单没申请该权限的纯数据插件（fx-crt 这类）不受未声明开关影响。
 *   B. 真 DOM 桩上跑 mountPluginPanel / renderPluginRows：被关掉的权限标「已拒绝」；贡献摘要如实标注；
 *      点开关真的写 settings 并 reload（联动内核侧贡献）；长日志列表只画最近 LOG_RENDER_MAX 条；清空两只日志。
 *   C. 真跑 createPluginLog：环形上限 / 按插件过滤 / 单插件清空 / onChange 微任务合批 / Disposer 退订。
 *   D. 变异红测（10 条）：拆掉数据判定 / off() 恒 false 放行 / 拆掉 declared 判定 / 权限缺省当拒绝 / 面板不标已拒绝 /
 *      清空只清一只（以上打 external.ts、plugin-panel.ts）+ 回收路径四条（父子 Scope 回收链断开、Context.effect 不回收撤销函数、
 *      registry 撤销不摘条目、manager.unmount 不 dispose 旧 Scope）—— 必须变红。
 *
 * 说明：editor/ui/confirm.ts 在打包时被替换成桩（D6 判据不点「卸载」，不碰确认框），其余模块全部用真源。
 * 用法: node scripts/verify-plugin-perms.mjs
 */
import { build } from "esbuild";
import { glslModule, minifyGlsl, normalizeTail, isPrefixBlock, withHeaderComments } from "./lib/glsl-plugin.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "./lib/verify-kit.mjs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "verify-plugin-perms-"));
process.on("exit", () => fs.rmSync(tmpRoot, { recursive: true, force: true }));
const json = (v) => JSON.stringify(v);
const enc = new TextEncoder();
const tick = () => new Promise((r) => setTimeout(r, 0));
async function until(fn, ms = 3000) {
  const t0 = Date.now();
  for (;;) {
    if (fn()) return true;
    if (Date.now() - t0 > ms) return false;
    await tick();
  }
}

// ── 极简 DOM 桩：面板只用到 createElement / appendChild / append / textContent / dataset / onclick ──
function domNode(tag) {
  return {
    tagName: String(tag).toUpperCase(),
    children: [],
    dataset: {},
    className: "",
    title: "",
    type: "",
    checked: false,
    disabled: false,
    open: false,
    hidden: false,
    onchange: null,
    onclick: null,
    _text: "",
    get textContent() {
      return this._text === "" && this.children.length ? this.children.map((c) => c.textContent).join("") : this._text;
    },
    set textContent(v) {
      this._text = String(v ?? "");
      if (this._text === "") this.children = [];
    },
    appendChild(c) {
      this.children.push(c);
      return c;
    },
    append(...cs) {
      for (const c of cs) this.appendChild(c);
    },
    replaceChildren(...cs) {
      this.children = [];
      for (const c of cs) this.appendChild(c);
    },
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    remove() {},
    showModal() {
      this.open = true;
    },
    close() {
      this.open = false;
    },
    focus() {},
  };
}
// document 桩：element 桩 + createElement（editor/i18n.ts 在模块初始化时会跑一次静态文案刷新，querySelectorAll 必须可用）
const documentStub = domNode("document");
documentStub.createElement = (t) => domNode(t);
documentStub.createElementNS = (_ns, t) => domNode(t);
documentStub.documentElement = domNode("html");
documentStub.documentElement.lang = "zh-CN";
documentStub.body = domNode("body");
documentStub.head = domNode("head");
globalThis.document = documentStub;

const nodes = (n) => [n, ...n.children.flatMap(nodes)];
const byClass = (root, cls) => nodes(root).filter((n) => String(n.className).split(/\s+/).includes(cls));
const byAttrs = (root, key, val) => nodes(root).filter((n) => n.dataset && n.dataset[key] === val);
const textAll = (n) => nodes(n).map((x) => x._text).filter(Boolean).join("\n");
const rowOf = (list, id) => byAttrs(list, "plugin", id)[0];

// ── 打包 ──
const ENTRY = `
export * as app from "./editor/app.ts";
export * as ext from "./editor/plugins/external.ts";
export * as mgr from "./editor/plugins/manager.ts";
export * as settings from "./editor/services/settings.ts";
export * as fx from "./editor/effects.ts";
export * as pt from "./editor/particles.ts";
export * as shaderLib from "./editor/shader-lib.ts";
export * as i18n from "./editor/i18n.ts";
export * as log from "./editor/plugins/log.ts";
export * as panel from "./editor/ui/plugin-panel.ts";
`;
const STUB_CONFIRM = "export const confirmDialog = async () => true;\n";

const glslLoader = {
  name: "glsl-text",
  setup(b) {
    b.onLoad({ filter: /\.glsl$/ }, (a) => ({
      contents: (() => {
        const raw = fs.readFileSync(a.path, "utf8");
        let code = minifyGlsl(raw);
        if (isPrefixBlock(a.path) && a.path.endsWith(".head.glsl")) code = withHeaderComments(code, raw);
        return glslModule(normalizeTail(code, isPrefixBlock(a.path)));
      })(),
      loader: "js",
    }));
  },
};

async function bundle(overrides = {}) {
  const plugins = [
    glslLoader,
    {
      name: "editor-api",
      setup(b) {
        b.onResolve({ filter: /renderer\/src\/api\/editor$/ }, () => ({ path: "editor-api", namespace: "editor-api" }));
        b.onLoad({ filter: /.*/, namespace: "editor-api" }, () => ({
          contents: [
            `export * from ${json(path.join(ROOT, "renderer/src/api/source.ts"))};`,
            `export { buildScenePkg } from ${json(path.join(ROOT, "renderer/src/editor/pkg-export.ts"))};`,
            `export { checkWeCompat } from ${json(path.join(ROOT, "renderer/src/editor/compat.ts"))};`,
            `export * from ${json(path.join(ROOT, "renderer/src/editor/mdl-edit.ts"))};`,
            `export { SYSTEM_FONT_FAMILIES, TEXT_EM_SCALE } from ${json(path.join(ROOT, "renderer/src/types.ts"))};`,
          ].join("\n"),
          loader: "ts",
          resolveDir: ROOT,
        }));
      },
    },
    {
      name: "stub-confirm",
      setup(b) {
        b.onLoad({ filter: /editor[\\/]ui[\\/]confirm\.ts$/ }, () => ({ contents: STUB_CONFIRM, loader: "ts" }));
      },
    },
  ];
  if (Object.keys(overrides).length) {
    plugins.push({
      name: "mutate",
      setup(b) {
        b.onLoad({ filter: /\.ts$/ }, (a) => (overrides[a.path] !== undefined ? { contents: overrides[a.path], loader: "ts" } : undefined));
      },
    });
  }
  const out = await build({
    stdin: { contents: ENTRY, resolveDir: ROOT, loader: "ts" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    plugins,
    logLevel: "silent",
  });
  const tmp = path.join(tmpRoot, `m-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(tmp, out.outputFiles[0].text);
  return import(pathToFileURL(tmp).href);
}

const dataImporter = async (code) => import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
const files = (o) => Object.entries(o).map(([p, v]) => ({ path: p, data: typeof v === "string" ? enc.encode(v) : v }));
const manifest = (m) => json({ name: m.id, version: "1.0.0", engine: "^1.0", ...m });

/** 内存来源：直接改 map 就能模拟「目录里文件变了」 */
function memSource(kind, map) {
  return {
    kind,
    async scan() {
      return [...map.entries()].map(([key, v]) => ({ key, stamp: v.stamp }));
    },
    async load(key, M) {
      const v = map.get(key);
      return M.ext.packageFromFiles(files(v.files), kind);
    },
    async remove(key) {
      map.delete(key);
    },
  };
}

const stubHost = () => ({
  doc: { current: () => null, selectedId: () => null, selection: () => null, find: () => null, select() {}, isLocked: () => false, editObject: () => false, editStructure() {}, refresh() {}, log() {} },
  history: { stack: () => null, undo() {}, redo() {} },
  assets: { overlay: () => null, put: () => false, read: async () => null, has: () => false, list: () => [], unique: (p) => p, addReferenceScanner: () => () => {}, referenced: () => new Set() },
  engine: { controls: () => null, remount() {} },
});

async function bootWith(M, sources) {
  const kv = new Map();
  const settings = M.settings.createSettings("t.", { getItem: (k) => kv.get(k) ?? null, setItem: (k, v) => kv.set(k, v), removeItem: (k) => kv.delete(k) });
  const storage = M.settings.memoryStorage();
  const errors = [];
  const a = await M.app.bootEditor({ ...stubHost(), settings, storage }, { onError: (s, e, w) => errors.push(`${s.name}/${w}: ${e?.message ?? e}`) });
  const srcs = sources.map((s) => ({ ...s, load: (k) => s.load(k, M) }));
  const m = M.mgr.createPluginManager({ root: a.root, sources: srcs, settings, deps: { importModule: dataImporter, settings, storage } });
  return { a, m, settings, storage, errors, kv };
}

// ── 测试插件：每类数据贡献一只，各带自己的权限 ──
const FRAG = "uniform float g_Amount;\nvoid main() { gl_FragColor = vec4(g_Amount); }\n";
const SNIPPET = "float permwave(vec2 uv) { return sin(uv.x); }\n";
const effect = (eid, frag) =>
  json({ id: eid, title: { "zh-CN": "权限测试效果", en: "Perm effect" }, category: "light", params: [], frag });
const dust = (tid) =>
  json({
    id: tid,
    title: { "zh-CN": "权限尘埃", en: "Perm dust" },
    blending: "additive",
    maxcount: 50,
    starttime: 0,
    emitter: { name: "boxrandom", origin: "0 0 0", distancemax: "500 300 0", rate: 10 },
    initializer: [{ name: "lifetimerandom", min: 2, max: 4 }],
    operator: [{ name: "movement" }],
    renderer: { name: "sprite" },
  });
const COMPONENT = json({
  id: "lifetimerandom",
  kind: "initializer",
  params: [
    { key: "min", type: "float", default: 1, min: 0 },
    { key: "max", type: "float", default: 2, min: 0 },
  ],
});
const BOTH_CODE = `export default { name: "perm-both", inject: ["ui"], apply(ctx) { ctx.effect(() => ctx.get("ui").add("toolbar", { id: "perm-both-btn", order: 1, render: () => null })); } };`;
// 另一只纯代码插件：只申请 ui，用来证明「关 A 插件的权限不误伤 B 插件的槽位项」
const OTHER_CODE = `export default { name: "perm-other", inject: ["ui"], apply(ctx) { ctx.effect(() => ctx.get("ui").add("toolbar", { id: "perm-other-btn", order: 2, render: () => null })); } };`;

const PLUGINS = [
  { id: "perm-fx", mf: { permissions: ["effects"], contributes: { effects: ["fx/e.json"] } }, files: { "fx/e.json": effect("permfx", "fx/e.frag"), "fx/e.frag": FRAG } },
  { id: "perm-shaders", mf: { permissions: ["shaders"], contributes: { shaders: ["glsl/wave.glsl"] } }, files: { "glsl/wave.glsl": SNIPPET } },
  { id: "perm-particles", mf: { permissions: ["particles.templates"], contributes: { particles: ["pt/dust.json"] } }, files: { "pt/dust.json": dust("perm-dust") } },
  { id: "perm-components", mf: { permissions: ["particles.components"], contributes: { "particles.components": ["pt/component.json"] } }, files: { "pt/component.json": COMPONENT } },
  {
    id: "perm-i18n",
    mf: { permissions: ["i18n"], contributes: { i18n: { "zh-CN": "i18n/zh.json", en: "i18n/en.json" } } },
    files: { "i18n/zh.json": json({ "plug.perm.hello": "你好权限" }), "i18n/en.json": json({ "plug.perm.hello": "Perm hello" }) },
  },
  {
    id: "perm-both",
    mf: { permissions: ["effects", "ui"], main: "index.js", contributes: { effects: ["fx/both.json"] } },
    files: { "index.js": BOTH_CODE, "fx/both.json": effect("permboth", "fx/both.frag"), "fx/both.frag": FRAG },
  },
  { id: "perm-other", mf: { permissions: ["ui"], main: "index.js" }, files: { "index.js": OTHER_CODE } },
  { id: "perm-undeclared", mf: { contributes: { effects: ["fx/u.json"] } }, files: { "fx/u.json": effect("permu", "fx/u.frag"), "fx/u.frag": FRAG } },
];
const pack = (p) => ({ "wwgl-plugin.json": manifest({ id: p.id, ...p.mf }), ...p.files });

/** 五类数据贡献各自的「开关名 → registry 探针」 */
const KINDS = [
  { id: "perm-fx", perm: "effects", label: "效果", get: (M) => M.fx.effectCatalog.get("permfx") },
  { id: "perm-shaders", perm: "shaders", label: "shader 片段", get: (M) => M.shaderLib.shaderSnippets.get("wwgl/perm-shaders/wave") },
  { id: "perm-particles", perm: "particles.templates", label: "粒子模板", get: (M) => M.pt.particleTemplates.get("perm-dust") },
  { id: "perm-components", perm: "particles.components", label: "粒子组件", get: (M) => M.pt.particleComponents.ownerOf("initializer:lifetimerandom") === "ext:perm-components" },
  { id: "perm-i18n", perm: "i18n", label: "词条", get: (M) => M.i18n.hasText("plug.perm.hello") },
];

async function permSuite(M) {
  const res = [];
  const check = (ok, msg) => res.push({ ok: !!ok, msg });
  const map = new Map(PLUGINS.map((p) => [p.id, { stamp: "1", files: pack(p) }]));
  const { a, m, settings, errors } = await bootWith(M, [memSource("store", map)]);
  await m.refresh();
  const statuses = m.list().map((e) => `${e.id}=${e.status}`).join(" ");
  check(errors.length === 0, `挂载过程没有宿主级报错（${errors.join(" | ") || "0 条"}）`);
  check(m.list().length === PLUGINS.length && m.list().every((e) => e.status === "active"), `全部 ${PLUGINS.length} 只测试插件 active（${statuses}）`);
  check(KINDS.every((k) => k.get(M)), "五类数据贡献在没有关任何开关时都真的登记进 registry（缺省全开）");

  // 逐项关掉 → 对应 registry 真的空，还没关的其它类不受影响
  const closed = new Set();
  for (const k of KINDS) {
    closed.add(k.id);
    settings.set(M.ext.permKey(k.id, k.perm), false);
    await m.reload(k.id);
    const others = KINDS.filter((o) => !closed.has(o.id));
    check(!k.get(M) && others.every((o) => o.get(M)), `关闭 ${k.perm} 后，${k.label}贡献被撤，其它还没关的类不受影响`);
  }
  check(KINDS.every((k) => !k.get(M)), "五类权限各自关掉后，五类 registry 一类都不剩（逐项隔离）");
  for (const k of KINDS) {
    settings.set(M.ext.permKey(k.id, k.perm), true);
    await m.reload(k.id);
  }
  check(KINDS.every((k) => k.get(M)), "逐项重新打开后，五类贡献全部复原");

  // 同一开关同时管数据与代码（perm-both：effects 走外层数据贡献、ui 走代码子插件）
  const toolbarIds = () => a.ui.items("toolbar").map((x) => x.id);
  const toolbarHas = (id) => toolbarIds().includes(id);
  // 活跃的「代码子插件」Scope 数：>1 = 旧 Scope 没被回收（重复登记）；0 = 重挂过程中的空窗（瞬时，不算错）
  const liveScopes = (name) => [...a.root.kernel.scopes].filter((s) => s.name === name && s.status !== "disposed").length;
  check(a.ui.items("toolbar").some((x) => x.id === "perm-other-btn"), "另一只纯代码插件的 ui 项就位（后面用来验隔离）");
  const both0 = m.list().find((e) => e.id === "perm-both");
  check(both0?.status === "active" && !!M.fx.effectCatalog.get("permboth") && toolbarHas("perm-both-btn"),
    `组合插件：数据贡献与代码子插件都挂上（status=${both0?.status} toolbar=[${toolbarIds().join(", ")}]）`);

  // 诊断「reload 没 dispose 旧 Scope」这一假设：留一份旧外层 Scope 的快照，切一次开关后看它的状态迁移
  const OUTER = "ext:perm-both";
  const oldOuter = [...a.root.kernel.scopes].filter((s) => s.name === OUTER);
  const outerLive = () => [...a.root.kernel.scopes].filter((s) => s.name === OUTER).length;

  // 中间态观测：ui 开关不动、只切 effects（该插件整体重挂）——记录每次 toolbar 变化时的「该项个数 / 活跃子 Scope 数」
  const trace = [];
  const offTrace = a.ui.onChange("toolbar", () => trace.push(`${toolbarIds().filter((x) => x === "perm-both-btn").length}/${liveScopes("perm-both")}`));
  settings.set(M.ext.permKey("perm-both", "effects"), false);
  await m.reload("perm-both");
  offTrace();
  const both1 = m.list().find((e) => e.id === "perm-both");
  check(both1?.status === "active" && !M.fx.effectCatalog.get("permboth") && toolbarHas("perm-both-btn"),
    `同一开关同时管数据与代码：关闭 effects 只掉效果，代码子插件照常 active（status=${both1?.status}）`);
  check(oldOuter.length === 1 && oldOuter[0].status === "disposed" && outerLive() === 1,
    `reload 是「先撤旧、再挂新」：旧外层 Scope ${oldOuter.map((s) => s.status)}，当前同名活跃 ${outerLive()} 个`);
  check(trace.every((t) => Number(t.split("/")[1]) <= 1) && liveScopes("perm-both") === 1,
    `重挂不产生重复项：旧 Scope 已回收，全程活跃同名 Scope ≤1（toolbar 变化轨迹 ${json(trace)}）`);

  settings.set(M.ext.permKey("perm-both", "ui"), false);
  await m.reload("perm-both");
  const both2 = m.list().find((e) => e.id === "perm-both");
  check(both2?.status === "pending" && json(both2?.missing) === json(["ui"]) && !M.fx.effectCatalog.get("permboth") && !toolbarHas("perm-both-btn") && toolbarHas("perm-other-btn"),
    `关闭 ui：子插件 pending 缺 ui，已登记的 ui 项随之撤回且不误伤别的插件（status=${both2?.status} toolbar=[${toolbarIds().join(", ")}]）`);
  check(liveScopes("perm-both") === 1, `关权限后没有残留的 perm-both 子 Scope（活跃 ${liveScopes("perm-both")} 个）`);

  settings.set(M.ext.permKey("perm-both", "ui"), true);
  await m.reload("perm-both");
  check(toolbarHas("perm-both-btn") && liveScopes("perm-both") === 1, `重新打开 ui：项回来且只有一个 perm-both 子 Scope（活跃 ${liveScopes("perm-both")} 个）`);

  settings.set(M.ext.permKey("perm-both", "ui"), false);
  await m.reload("perm-both");
  check(!toolbarHas("perm-both-btn") && liveScopes("perm-both") === 1, "再关一次 ui：项再消失且干净（幂等）");
  check(toolbarHas("perm-other-btn"), "另一只插件的 ui 项全程不受影响（权限开关按插件隔离）");

  settings.set(M.ext.permKey("perm-both", "effects"), true);
  settings.set(M.ext.permKey("perm-both", "ui"), true);
  await m.reload("perm-both");
  check(toolbarHas("perm-both-btn") && !!M.fx.effectCatalog.get("permboth"), "两个开关都打开：数据与代码一起复原");

  // 向后兼容：清单没申请该权限的纯数据插件（fx-crt / fx-glow / particle-fireflies 这类）
  settings.set(M.ext.permKey("perm-undeclared", "effects"), false);
  await m.reload("perm-undeclared");
  check(!!M.fx.effectCatalog.get("permu"), "清单没申请该权限的纯数据插件：未声明的开关不拦（未声明无开关 / 向后兼容）");
  settings.set(M.ext.permKey("perm-undeclared", "effects"), true);
  await m.reload("perm-undeclared");

  return { res, m, a, settings };
}

// ── B. 面板 ──
const T = (key, params) => {
  const table = {
    "pl.permDenied": "已拒绝",
    "pl.logsMore": `另有 ${params?.n ?? 0} 条更早的日志未显示`,
    "pl.logs": "插件日志",
    "pl.logsClear": "清空",
    "pl.logsEmpty": "暂无日志",
    "pl.permsTitle": "逐项权限：",
    "pl.permHigh": "高风险权限：可读写文档 / 工程文件",
    "pl.empty": "还没有插件",
    "pl.missing": `缺服务：${params?.list ?? ""}`,
    "pl.perms": `权限：${params?.list ?? ""}`,
  };
  return table[key] ?? key;
};
const pickText = (v, f) => (typeof v === "string" ? v : f);

async function panelSuite(M, ctx) {
  const res = [];
  const check = (ok, msg) => res.push({ ok: !!ok, msg });
  const { m, settings } = ctx;
  const panel = M.panel;
  const logs = M.log.createPluginLog();
  for (let i = 0; i < 120; i++) logs.push("perm-fx", "info", `perm-fx 第 ${i} 条`);
  logs.push("ext:perm-fx", "error", "外层包装报错");
  logs.push("ext:perm-fx", "warn", "外层包装警告 2");
  logs.push("ext:perm-fx", "info", "外层包装信息 3");
  logs.push("perm-both", "info", "别人的日志");

  // 先把 perm-fx 的 effects 关掉，面板上应当如实标注
  settings.set(M.ext.permKey("perm-fx", "effects"), false);
  await m.reload("perm-fx");

  const list = domNode("div");
  const dialog = domNode("dialog");
  dialog.open = true;
  const mounted = panel.mountPluginPanel({ dialog, list, manager: m, settings, logs, t: T, text: pickText, log: () => {}, confirmInstall: async () => false });
  mounted.render();
  await tick();

  check(byAttrs(list, "plugin", "perm-fx").length >= 1 && byClass(list, "ed-plugin").length === PLUGINS.length,
    `面板为每个插件画一行（${byClass(list, "ed-plugin").length} 行）`);

  const fxRow = rowOf(list, "perm-fx");
  const cb = nodes(fxRow).find((n) => n.dataset && n.dataset.perm === "effects");
  const permLabel = byClass(fxRow, "ed-plugin-perm")[0];
  check(!!cb && cb.checked === false && !!permLabel && permLabel.className.includes("is-denied") && textAll(permLabel).includes("已拒绝"),
    `面板把被关掉的权限标成「已拒绝」并保持未勾选（label="${textAll(permLabel).replace(/\n/g, " ")}"）`);
  const meta = (byClass(fxRow, "ed-plugin-meta")[0] && textAll(byClass(fxRow, "ed-plugin-meta")[0])) || "";
  check(meta.includes("已拒绝"), `贡献摘要如实标出被关掉的那类数据贡献（meta="${meta.replace(/\n/g, " ")}"）`);

  const det = byClass(fxRow, "ed-plugin-logs")[0];
  const lines = byClass(det, "ed-plugin-log").filter((n) => !n.className.includes("is-empty") && !n.className.includes("is-more"));
  const more = byClass(det, "is-more")[0];
  check(lines.length === panel.LOG_RENDER_MAX && !!more && textAll(more).includes("73"),
    `日志长列表只画最近 ${panel.LOG_RENDER_MAX} 条，更早的 73 条只报数目（实际画了 ${lines.length} 条；more="${textAll(more)}"）`);
  check(lines[0] && String(lines[0].textContent).includes("外层包装信息 3"),
    `清单 id 与 ext:<id> 两只日志合并、按时间排序（最新在最上："${lines[0]?.textContent}"）`);

  const emptyRow = rowOf(list, "perm-i18n");
  const emptyDet = byClass(emptyRow, "ed-plugin-logs")[0];
  const emptyClr = nodes(emptyDet).find((n) => n.dataset && n.dataset.act === "logs-clear");
  check(byClass(emptyDet, "is-empty").length === 1 && emptyClr?.disabled === true, "没有日志的插件：显示「暂无日志」且清空按钮禁用");

  // 日志变化 → 对话框开着时自动重绘（微任务合批后）
  const beforeLines = byClass(byClass(rowOf(list, "perm-both"), "ed-plugin-logs")[0], "ed-plugin-log").filter((n) => n.className.includes("is-info")).length;
  logs.push("perm-both", "info", "新来的日志");
  await tick();
  const afterLines = byClass(byClass(rowOf(list, "perm-both"), "ed-plugin-logs")[0], "ed-plugin-log").filter((n) => n.className.includes("is-info")).length;
  check(afterLines === beforeLines + 1, `日志变化后面板自动重绘（perm-both 的 info 行 ${beforeLines} → ${afterLines}）`);

  // 清空：清单 id 与 ext:<id> 两只都要清，别人的不动
  const clr = nodes(byClass(rowOf(list, "perm-fx"), "ed-plugin-logs")[0]).find((n) => n.dataset && n.dataset.act === "logs-clear");
  clr.onclick();
  await tick();
  check(logs.list("perm-fx").length === 0 && logs.list("ext:perm-fx").length === 0 && logs.list("perm-both").length === 2,
    `清空只清这个插件的两只日志（清单 id 与 ext:<id>），别人的不动（perm-fx=${logs.list("perm-fx").length} ext:perm-fx=${logs.list("ext:perm-fx").length} perm-both=${logs.list("perm-both").length}）`);

  // 点开关 → 写 settings + reload → 内核侧贡献真的回来
  const fxRow2 = rowOf(list, "perm-fx");
  const cb2 = nodes(fxRow2).find((n) => n.dataset && n.dataset.perm === "effects");
  cb2.checked = true;
  cb2.onchange();
  const back = await until(() => !!M.fx.effectCatalog.get("permfx"));
  check(back, "面板开关点开 → 写 settings + manager.reload → 内核侧效果贡献立刻复原（真跑联动）");
  return res;
}

// ── C. log.ts 语义 ──
async function logSuite(M) {
  const res = [];
  const check = (ok, msg) => res.push({ ok: !!ok, msg });
  const l = M.log.createPluginLog(3);
  l.push("a", "info", "1");
  l.push("a", "info", "2");
  l.push("b", "info", "x");
  l.push("a", "info", "3");
  l.push("a", "info", "4");
  check(l.list().length === 3, `log.ts：环形上限截断（上限 3，推 5 条只剩 ${l.list().length} 条）`);
  check(l.list("a").length === 2 && l.list("b").length === 1, `log.ts：list(plugin) 按插件过滤（a=${l.list("a").length} b=${l.list("b").length}）`);
  l.clear("a");
  check(l.list("a").length === 0 && l.list("b").length === 1, "log.ts：clear(plugin) 只清该插件");
  const d = M.log.createPluginLog();
  for (let i = 0; i < 250; i++) d.push("p", "info", `x${i}`);
  check(d.list().length === 200, `log.ts：默认上限 200（推 250 条只剩 ${d.list().length} 条）`);
  let n = 0;
  const off = d.onChange(() => n++);
  d.push("p", "info", "k1");
  d.push("p", "info", "k2");
  check(n === 0, `log.ts：onChange 合批到微任务（同步推 2 条时回调 ${n} 次）`);
  await tick();
  check(n === 1, `log.ts：两次推送合并成一次回调（实际 ${n} 次）`);
  off();
  d.push("p", "info", "k3");
  await tick();
  check(n === 1, "log.ts：Disposer 退订后不再回调");
  return res;
}

function report(title, res) {
  console.log(`\n${title}`);
  for (const r of res) console.log(`  ${r.ok ? "✓" : "✗"} ${r.msg}`);
  return res.filter((r) => !r.ok).length;
}

const SRC = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const EXT = path.join(ROOT, "editor/plugins/external.ts");
const PANEL = path.join(ROOT, "editor/ui/plugin-panel.ts");
const CORE = path.join(ROOT, "editor/core/context.ts");
const REG = path.join(ROOT, "editor/core/registry.ts");
const MGR = path.join(ROOT, "editor/plugins/manager.ts");
// 清空两只日志的原文（用数组拼，避免模板字面量嵌套）
const CLEAR_BOTH = ["o.logs!.clear(entry.id);", "    o.logs!.clear(`ext:${entry.id}`);"].join("\n");

const mutants = [
  { name: "数据贡献不再看权限开关（拆掉 effects 判定）", file: EXT, from: `if (!off("effects")) for (const e of data.effects) ctx.contribute("effects", e);`, to: `for (const e of data.effects) ctx.contribute("effects", e);`, expect: /关闭 effects/ },
  { name: "off() 恒 false（判定放行）", file: EXT, from: `const off = (p: string) => declared.has(p) && denied.has(p);`, to: `const off = (p: string) => false;`, expect: /关闭 / },
  { name: "off() 不再看 declared（未声明也拦）", file: EXT, from: `const off = (p: string) => declared.has(p) && denied.has(p);`, to: `const off = (p: string) => denied.has(p);`, expect: /未声明无开关/ },
  { name: "deniedPermissions 缺省当拒绝", file: EXT, from: `if (settings.get<boolean>(permKey(id, p), true) === false) out.add(p);`, to: `if (settings.get<boolean>(permKey(id, p), false) === false) out.add(p);`, expect: /缺省全开/ },
  { name: "面板不标「已拒绝」", file: PANEL, from: `el("label", off ? "ed-plugin-perm is-denied" : "ed-plugin-perm")`, to: `el("label", "ed-plugin-perm")`, expect: /「已拒绝」/ },
  { name: "清空只清清单 id 一只", file: PANEL, from: CLEAR_BOTH, to: "o.logs!.clear(entry.id);", expect: /ext:<id>/ },
  // —— 回收路径（旧 Scope 的 ui/服务贡献必须随重挂消失）——
  {
    // 父 Scope 回收子 Scope 有两条互为冗余的路：reset() 里遍历 children、以及 Context.plugin 里 collect 的撤销函数。
    // 单改任一条都不可观测（另一条兜住了），所以这里一次断开两条，模拟「旧子插件真的没被回收」。
    name: "父子 Scope 回收链整体断开（旧子插件不撤）",
    file: CORE,
    mutate: (s) =>
      s
        .replace("for (const c of [...this.children]) c.dispose();", "for (const c of [...this.children]) void c;")
        .replace("this.scope.collect(() => s.dispose());", "void s;"),
    expect: /ui 项随之撤回|重挂不产生重复项/,
  },
  { name: "Context.effect 不回收撤销函数", file: CORE, from: ["    const d = fn();", "    return this.scope.collect(typeof d === \"function\" ? d : () => {});"].join("\n"), to: ["    fn();", "    return () => {};"].join("\n"), expect: /ui 项随之撤回|效果贡献被撤/ },
  { name: "registry 撤销不摘条目", file: REG, from: ["        if (i < 0) return;", "        list!.splice(i, 1);"].join("\n"), to: ["        if (i < 0) return;", "        void list;"].join("\n"), expect: /ui 项随之撤回|效果贡献被撤/ },
  { name: "manager.unmount 不 dispose 旧 Scope", file: MGR, from: ["    scopes.get(id)?.dispose();", "    scopes.delete(id);"].join("\n"), to: "    scopes.delete(id);", expect: /ui 项随之撤回|重挂不产生重复项/ },
];

const M = await bundle();
let fails = 0;
let ctx = null;
try {
  ctx = await permSuite(M);
  fails += report("A 逐项权限开关真的拦住数据贡献", ctx.res);
  fails += report("B 面板：已拒绝标注 / 日志过滤 / 上限 / 清空", await panelSuite(M, ctx));
  fails += report("C log.ts 上限 / 过滤 / 清空 / 合批", await logSuite(M));
} catch (e) {
  console.log(`\n✗ 基线跑挂：${e?.stack ?? e}`);
  fails++;
} finally {
  try {
    ctx?.m?.dispose?.();
  } catch {}
}

// ── D. 变异红测 ──
console.log("\nD 变异红测");
console.log(`  判据里共 ${mutants.length} 条变异（要求 ≥3 条被杀）`);
let killed = 0;
for (const mu of mutants) {
  const orig = SRC(path.relative(ROOT, mu.file));
  // 常规变异按 from→to 替换；mutate 用于一次要断开同一不变量上「互为冗余」的两处（单改一处不可观测）
  const src = mu.mutate ? mu.mutate(orig) : orig.replace(mu.from, mu.to);
  if ((!mu.mutate && !orig.includes(mu.from)) || src === orig) {
    console.log(`  ✗ ${mu.name}：源码里找不到变异点`);
    fails++;
    continue;
  }
  const MM = await bundle({ [mu.file]: src });
  let r = [];
  try {
    const c = await permSuite(MM);
    r = r.concat(c.res);
    r = r.concat(await panelSuite(MM, c));
    r = r.concat(await logSuite(MM));
    c.m.dispose();
  } catch (e) {
    r = [{ ok: false, msg: `变异后抛异常：${e?.message ?? e}` }];
  }
  const red = r.filter((x) => !x.ok && mu.expect.test(x.msg));
  if (red.length) killed++;
  else fails++;
  console.log(`  ${red.length ? "✓" : "✗"} ${mu.name} → ${red.length ? `变红 ${red.length} 条：${red[0].msg}` : "没有判据变红"}`);
}

console.log(fails ? `\n✗ ${fails} 处问题` : `\n✓ 全部通过（变异 ${killed}/${mutants.length} 被杀）`);
process.exit(fails ? 1 : 0);
