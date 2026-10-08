#!/usr/bin/env node
/**
 * verify-plugins —— 外部插件与插件生态（PLUGIN-ARCHITECTURE §5–§6）。
 *
 * 真源：editor/app.ts + editor/plugins/{external,manager}.ts + host/plugin-dirs.ts（esbuild 打成临时 mjs 真跑）。覆盖：
 *   A. 清单：engine 范围、字段校验、不可授予权限、包内路径越界、清单在顶层目录里；
 *   B. 数据插件：效果（文件化 frag + 插件 shader 片段 include）/ 粒子模板 / 词条登记，停用全撤、启用复原；
 *      坏粒子模板（WE 不认的组件）整包失败且之前登记的效果一并撤回；
 *   C. 代码插件：授权内服务可用；inject 未授权服务 → pending 并报 missing；ctx.get 未授权服务 → failed；
 *      apply 抛错 → failed 带错误文本；私有设置 / 存储按插件 id 隔离；
 *   D. 来源：目录 > 已安装 > 内置示例的优先级与回落；内置示例缺省启用、可停用不可卸载；版本戳变化热重载（watch 轮询）；卸载；
 *   E. dev 宿主插件目录：清单列举、版本戳、越界 / 点文件拒绝；
 *   F. 示例插件（examples/plugins/*）全部能装上且 active；木偶生成器产物经 irToGltf → gltfToModel 往返；
 *   G. 变异红测：把权限门控 / 启用判断 / 整包原子性改坏，确认对应判据变红。
 */
import { build } from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { pathToFileURL } from "node:url";
import { ROOT } from "./lib/verify-kit.mjs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "verify-plugins-"));
process.on("exit", () => fs.rmSync(tmpRoot, { recursive: true, force: true }));
const json = (v) => JSON.stringify(v);
const enc = new TextEncoder();
const dec = new TextDecoder();

const ENTRY = `
export * as app from "./editor/app.ts";
export * as ext from "./editor/plugins/external.ts";
export * as mgr from "./editor/plugins/manager.ts";
export * as settings from "./editor/services/settings.ts";
export * as fx from "./editor/effects.ts";
export * as pt from "./editor/particles.ts";
export * as shaderLib from "./editor/shader-lib.ts";
export * as inspector from "./editor/inspector.ts";
export * as i18n from "./editor/i18n.ts";
export * as sway from "./editor/plugins/builtin/puppet-sway.ts";
export * as modelIr from "./editor/model-ir.ts";
export * as gltf from "./editor/gltf.ts";
export * as modelImport from "./editor/model-import.ts";
export * as pipeline from "./editor/export-pipeline.ts";
export * as core from "./editor/core/index.ts";
`;

async function bundle(entry, platform, overrides = {}) {
  const plugins = [
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
    ...(typeof entry === "string" ? { entryPoints: [entry] } : { stdin: { contents: entry.contents, resolveDir: ROOT, loader: "ts" } }),
    bundle: true,
    write: false,
    format: "esm",
    platform,
    target: "es2022",
    plugins,
    logLevel: "silent",
  });
  const tmp = path.join(tmpRoot, `m-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(tmp, out.outputFiles[0].text);
  return import(pathToFileURL(tmp).href);
}

const load = (overrides) => bundle({ contents: ENTRY }, "neutral", overrides);

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

async function bootWith(M, sources, host = {}) {
  const kv = new Map();
  const settings = M.settings.createSettings("t.", { getItem: (k) => kv.get(k) ?? null, setItem: (k, v) => kv.set(k, v), removeItem: (k) => kv.delete(k) });
  const storage = M.settings.memoryStorage();
  const errors = [];
  const a = await M.app.bootEditor({ ...stubHost(), ...host, settings, storage }, { onError: (s, e, w) => errors.push(`${s.name}/${w}: ${e?.message ?? e}`) });
  const srcs = sources.map((s) => ({ ...s, load: (k) => s.load(k, M) }));
  const m = M.mgr.createPluginManager({ root: a.root, sources: srcs, settings, deps: { importModule: dataImporter, settings, storage } });
  return { a, m, settings, storage, errors, kv };
}

const DATA_PLUGIN = {
  "wwgl-plugin.json": manifest({
    id: "fx-test",
    contributes: { effects: ["fx/glow.json"], shaders: ["glsl/wave.glsl"], particles: ["pt/dust.json"], i18n: { "zh-CN": "i18n/zh.json", en: "i18n/en.json" } },
  }),
  "fx/glow.json": json({
    id: "plug_glow",
    title: { "zh-CN": "插件辉光", en: "Plugin glow" },
    category: "light",
    params: [{ key: "amount", type: "float", default: 0.5, min: 0, max: 1 }],
    frag: "fx/glow.frag",
  }),
  "fx/glow.frag": `#include "wwgl/fx-test/wave"\nuniform float g_Amount; // {"material":"amount","default":0.5}\nvoid main() { gl_FragColor = vec4(wave(v_TexCoord) * g_Amount); }\n`,
  "glsl/wave.glsl": "float wave(vec2 uv) { return sin(uv.x * 10.0); }\n",
  "pt/dust.json": json({
    id: "plug-dust",
    title: { "zh-CN": "尘埃", en: "Dust" },
    blending: "additive",
    maxcount: 100,
    starttime: 0,
    emitter: { name: "boxrandom", origin: "0 0 0", distancemax: "500 300 0", rate: 10 },
    initializer: [{ name: "lifetimerandom", min: 2, max: 4 }],
    operator: [{ name: "movement" }],
    renderer: { name: "sprite" },
  }),
  "i18n/zh.json": json({ "plug.hello": "你好插件" }),
  "i18n/en.json": json({ "plug.hello": "Hello plugin" }),
};

async function suite(M) {
  const res = [];
  const check = (ok, msg) => res.push({ ok: !!ok, msg });
  const { ext } = M;

  // ── A. 清单 ──
  check(ext.engineSatisfies("^1.0") && ext.engineSatisfies("1") && ext.engineSatisfies(">=0.9") && ext.engineSatisfies("*") && !ext.engineSatisfies("^2.0") && !ext.engineSatisfies("~1.0"), "engine 范围：^1.0 / 1 / >=0.9 / * 接受，^2.0 / 看不懂的写法拒绝");
  const ok = ext.parseManifest({ id: "a-b", name: "x", version: "1.2.3", engine: "^1.0", permissions: ["inspector"] });
  check(ok.manifest && !ok.errors.length, "合法清单通过");
  const bad = ext.parseManifest({ id: "A_B", name: "", version: "1.0", engine: "^9", main: "../x.js", contributes: { effects: "x", foo: [] }, permissions: ["fs"] });
  check(bad.manifest === null && bad.errors.length >= 7, `坏清单逐项报错（${bad.errors.length} 项）`);
  const unk = ext.parseManifest({ id: "a-b", name: "x", version: "1.2.3", engine: "^1.0", contributes: { themes: [] } });
  check(unk.manifest === null && /contributes\.themes/.test(unk.errors.join()), "坏清单：未知 contributes 键拒绝（拼错的贡献点不能静默忽略）");
  check(ext.normPath("../a") === null && ext.normPath("/a") === null && ext.normPath("a//b") === null && ext.normPath("./a\\b") === "a/b", "包内路径：拒绝 .. / 绝对路径 / 空段，反斜杠转正斜杠");
  {
    const pkg = ext.packageFromFiles(files({ "my-plugin/wwgl-plugin.json": manifest({ id: "nested" }), "my-plugin/a.txt": "x", "../evil": "y" }));
    check(pkg.manifest.id === "nested" && pkg.files.has("a.txt") && ![...pkg.files.keys()].some((k) => k.includes("..")), "清单在唯一顶层目录里也能认出，越界路径丢弃");
    let threw = "";
    try {
      ext.packageFromFiles(files({ "a.txt": "x" }));
    } catch (e) {
      threw = e.message;
    }
    check(/wwgl-plugin\.json/.test(threw), "没有清单的包拒绝");
  }

  // ── B. 数据插件 ──
  {
    const store = new Map([["fx-test", { stamp: "1", files: DATA_PLUGIN }]]);
    const { a, m } = await bootWith(M, [memSource("store", store)]);
    await m.refresh();
    const e = m.list().find((x) => x.id === "fx-test");
    check(e?.status === "active", `数据插件 active（${e?.status} ${e?.error ?? ""}）`);
    const def = M.fx.effectCatalog.get("plug_glow");
    check(def && def.prefix === "wwgl_fx_test_" && M.fx.effectDirOf(def) === "wwgl_fx_test_plug_glow", "效果登记，目录前缀按插件 id 分层");
    check(M.fx.effectIdOf("effects/wwgl_fx_test_plug_glow/effect.json") === "plug_glow", "效果文件路径能认回插件效果 id");
    const fxFiles = def ? M.fx.effectFiles(def) : [];
    const frag = fxFiles.find((f) => f.name.endsWith(".frag"));
    const fragText = frag ? new TextDecoder().decode(frag.data) : "";
    check(/sin\(uv\.x \* 10\.0\)/.test(fragText) && !/#include "wwgl\//.test(fragText), "写盘时插件 shader 片段 include 已内联展开");
    check(M.shaderLib.shaderSnippets.get("wwgl/fx-test/wave"), "shader 片段 include 名 = wwgl/<插件 id>/<文件名>");
    check(M.pt.particleTemplates.get("plug-dust")?.maxcount === 100, "粒子模板登记");
    check(M.i18n.hasText("plug.hello"), "插件词条登记");
    check(a.scopes().some((s) => s.meta?.manifest?.id === "fx-test" && s.status === "active"), "Scope 元数据带清单（导出时写进 project.json 的 editor.plugins）");

    await m.setEnabled("fx-test", false);
    check(!M.fx.effectCatalog.get("plug_glow") && !M.pt.particleTemplates.get("plug-dust") && !M.shaderLib.shaderSnippets.get("wwgl/fx-test/wave") && !M.i18n.hasText("plug.hello"), "停用：效果 / 粒子 / 片段 / 词条全部撤回");
    check(m.list().find((x) => x.id === "fx-test")?.status === "disabled", "停用状态可见");
    await m.setEnabled("fx-test", true);
    check(M.fx.effectCatalog.get("plug_glow") && M.pt.particleTemplates.get("plug-dust"), "重新启用：贡献复原");
    await m.uninstall("fx-test");
    check(!store.has("fx-test") && !M.fx.effectCatalog.get("plug_glow") && !m.list().length, "卸载：来源删除、贡献撤回");
    m.dispose();
  }
  {
    const badPt = { ...DATA_PLUGIN, "pt/dust.json": json({ ...JSON.parse(DATA_PLUGIN["pt/dust.json"]), operator: [{ name: "teleport" }] }) };
    const store = new Map([["fx-test", { stamp: "1", files: badPt }]]);
    const { m } = await bootWith(M, [memSource("store", store)]);
    await m.refresh();
    const e = m.list()[0];
    check(e?.status === "failed" && /teleport/.test(e.error ?? ""), `坏粒子模板（WE 不认的组件）整包失败并报出组件名（${e?.status}）`);
    check(!M.fx.effectCatalog.get("plug_glow") && !M.shaderLib.shaderSnippets.get("wwgl/fx-test/wave"), "整包原子：失败前已登记的效果 / 片段一并撤回");
    m.dispose();
  }
  {
    const missingFile = { ...DATA_PLUGIN };
    delete missingFile["fx/glow.frag"];
    const { m } = await bootWith(M, [memSource("store", new Map([["fx-test", { stamp: "1", files: missingFile }]]))]);
    await m.refresh();
    check(m.list()[0]?.status === "failed" && /fx\/glow\.frag/.test(m.list()[0].error ?? ""), "引用的文件不在包里 → 失败并指出文件");
    m.dispose();
  }

  // ── C. 代码插件 ──
  {
    const code = (body, extra = {}) => ({
      "wwgl-plugin.json": manifest({ main: "index.js", ...extra }),
      "index.js": body,
    });
    const store = new Map([
      ["good", { stamp: "1", files: code(`export default { name: "good", inject: ["inspector"], apply(ctx, host) { host.settings.set("k", 1); ctx.contribute("inspector", { id: "plug-grp", order: 150, when: () => true, render: () => null }); } };`, { id: "good", permissions: ["inspector", "settings"] }) }],
      ["nodoc", { stamp: "1", files: code(`export default { name: "nodoc", inject: ["doc"], apply() {} };`, { id: "nodoc", permissions: ["inspector"] }) }],
      ["sneaky", { stamp: "1", files: code(`export default { name: "sneaky", apply(ctx) { ctx.get("assets"); } };`, { id: "sneaky" }) }],
      ["boom", { stamp: "1", files: code(`export default function boom() { throw new Error("kaboom"); }`, { id: "boom" }) }],
      ["noexport", { stamp: "1", files: code(`export const x = 1;`, { id: "noexport" }) }],
    ]);
    const { m, kv } = await bootWith(M, [memSource("store", store)]);
    await m.refresh();
    const by = Object.fromEntries(m.list().map((e) => [e.id, e]));
    check(by.good?.status === "active" && M.inspector.inspectorGroups.get("plug-grp"), `授权内服务可用：代码插件登记检视器分组（${by.good?.status} ${by.good?.error ?? ""}）`);
    check(kv.get("t.plugin.good.k") === "1", "插件私有设置按 plugin.<id>. 隔离");
    check(by.nodoc?.status === "pending" && json(by.nodoc.missing) === json(["doc"]), `inject 未授权服务 → pending，missing = [doc]（${by.nodoc?.status} ${json(by.nodoc?.missing)}）`);
    check(by.sneaky?.status === "failed" && /无权访问服务 assets/.test(by.sneaky.error ?? ""), `ctx.get 未授权服务 → failed（${by.sneaky?.error}）`);
    check(by.boom?.status === "failed" && /kaboom/.test(by.boom.error ?? ""), "apply 抛错 → failed 带错误文本");
    check(by.noexport?.status === "failed" && /默认导出/.test(by.noexport.error ?? ""), "入口没有默认导出 → failed 并说明");
    await m.setEnabled("good", false);
    check(!M.inspector.inspectorGroups.get("plug-grp"), "停用代码插件：它登记的分组撤回");
    m.dispose();
  }

  // ── D. 来源优先级 / 热重载 ──
  {
    const store = new Map([["dup", { stamp: "1", files: { "wwgl-plugin.json": manifest({ id: "dup", version: "1.0.0", contributes: { i18n: { en: "en.json" } } }), "en.json": json({ "dup.v": "store" }) } }]]);
    const dir = new Map([["dup-dev", { stamp: "a", files: { "wwgl-plugin.json": manifest({ id: "dup", version: "1.1.0", contributes: { i18n: { en: "en.json" } } }), "en.json": json({ "dup.v": "dir-a" }) } }]]);
    const { m } = await bootWith(M, [memSource("store", store), memSource("dir", dir)]);
    await m.refresh();
    const live = m.list().filter((e) => e.id === "dup");
    check(live.length === 2 && live.find((e) => e.source === "dir")?.status === "active" && live.find((e) => e.source === "store")?.status === "disabled", "同 id：目录版生效，已安装版标为未生效");
    const t = () => M.i18n.et("dup.v");
    check(t() === "dir-a", `目录版词条生效（${t()}）`);
    dir.set("dup-dev", { stamp: "b", files: { ...dir.get("dup-dev").files, "en.json": json({ "dup.v": "dir-b" }) } });
    const stop = m.watch(10);
    for (let i = 0; i < 200 && t() !== "dir-b"; i++) await new Promise((r) => setTimeout(r, 10));
    stop();
    check(t() === "dir-b" && m.list().find((e) => e.source === "dir")?.status === "active", `目录版本戳变化 → watch 热重载新内容（${t()}）`);
    dir.delete("dup-dev");
    await m.refresh();
    check(m.list().find((e) => e.id === "dup")?.status === "active" && m.list().length === 1 && t() === "store", `目录版移走：回落到已安装版（${t()}）`);
    m.dispose();
  }
  {
    const files = (v) => ({
      "../ex/dup/wwgl-plugin.json": async () => manifest({ id: "dup", contributes: { i18n: { en: "en.json" } } }),
      "../ex/dup/en.json": async () => json({ "dup.v": v }),
      "../ex/solo/wwgl-plugin.json": async () => manifest({ id: "solo" }),
      "../other/x/wwgl-plugin.json": async () => manifest({ id: "stray" }),
    });
    const store = new Map([["dup", { stamp: "1", files: { "wwgl-plugin.json": manifest({ id: "dup", contributes: { i18n: { en: "en.json" } } }), "en.json": json({ "dup.v": "store" }) } }]]);
    const { m, settings } = await bootWith(M, [M.mgr.bundledSource(files("bundled"), "../ex"), memSource("store", store)]);
    await m.refresh();
    const t = () => M.i18n.et("dup.v");
    const solo = m.list().find((e) => e.id === "solo");
    check(solo?.source === "bundled" && solo.status === "active" && solo.enabled && !solo.removable && !m.list().some((e) => e.id === "stray"),
      `内置示例：缺省启用、不可卸载，只收 root 下的目录（${solo?.status}）`);
    check(t() === "store" && m.list().find((e) => e.id === "dup" && e.source === "bundled")?.status === "disabled", `同 id：已安装版盖过内置示例（${t()}）`);
    await m.uninstall("dup");
    check(t() === "bundled" && m.list().find((e) => e.id === "dup")?.source === "bundled", `卸载已安装版：回落到内置示例（${t()}）`);
    await m.setEnabled("solo", false);
    check(m.list().find((e) => e.id === "solo")?.status === "disabled" && settings.get("plugins.enabled.solo", true) === false, "内置示例可停用");
    m.dispose();
  }
  return res;
}

/** dev 宿主插件目录（Node 平台单独打包） */
async function hostSuite() {
  const res = [];
  const check = (ok, msg) => res.push({ ok: !!ok, msg });
  const H = await bundle(path.join(ROOT, "host/plugin-dirs.ts"), "node");
  const root = path.join(tmpRoot, "plugins-root");
  fs.mkdirSync(path.join(root, "p1", "fx"), { recursive: true });
  fs.writeFileSync(path.join(root, "p1", "wwgl-plugin.json"), manifest({ id: "p1" }));
  fs.writeFileSync(path.join(root, "p1", "fx", "a.frag"), "void main(){}");
  fs.writeFileSync(path.join(root, "p1", ".secret"), "no");
  fs.mkdirSync(path.join(root, "not-a-plugin"));
  fs.writeFileSync(path.join(tmpRoot, "outside.txt"), "outside");
  const l1 = await H.listPluginDirs([root]);
  check(l1.plugins.length === 1 && l1.plugins[0].dir === "p1" && json(l1.plugins[0].files) === json(["fx/a.frag", "wwgl-plugin.json"]), `列出含清单的子目录，跳过点文件（${json(l1.plugins.map((p) => p.files))}）`);
  check((await H.readPluginFile("p1", "fx/a.frag", [root]))?.toString() === "void main(){}", "读插件文件");
  const denied = await Promise.all([
    H.readPluginFile("p1", "../../outside.txt", [root]),
    H.readPluginFile("p1", ".secret", [root]),
    H.readPluginFile("../p1", "wwgl-plugin.json", [root]),
    H.readPluginFile("not-a-plugin", "x", [root]),
  ]);
  check(denied.every((x) => x === null), "越界路径 / 点文件 / 非插件目录一律拒绝");
  await new Promise((r) => setTimeout(r, 20));
  fs.writeFileSync(path.join(root, "p1", "fx", "b.frag"), "void main(){}");
  const l2 = await H.listPluginDirs([root]);
  check(l2.plugins[0].stamp !== l1.plugins[0].stamp, "加文件后版本戳变化（热重载依据）");
  return res;
}

/** 示例插件与木偶生成器 */
async function examplesSuite(M) {
  const res = [];
  const check = (ok, msg) => res.push({ ok: !!ok, msg });
  const exRoot = path.join(ROOT, "examples/plugins");
  const dirs = fs.existsSync(exRoot) ? fs.readdirSync(exRoot).filter((d) => fs.existsSync(path.join(exRoot, d, "wwgl-plugin.json"))) : [];
  check(dirs.length >= 4, `examples/plugins 至少 4 个示例（${dirs.join(", ")}）`);
  const walk = (d, base = d) =>
    fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name), base) : [{ path: path.relative(base, path.join(d, e.name)).split(path.sep).join("/"), data: new Uint8Array(fs.readFileSync(path.join(d, e.name))) }]));
  // 与 editor/main.ts 的 import.meta.glob 同形：键 = "../examples/plugins/<目录>/<路径>"，排除 src/
  const globbed = {};
  for (const d of dirs) {
    for (const f of walk(path.join(exRoot, d))) {
      if (f.path.startsWith("src/")) continue;
      globbed[`../examples/plugins/${d}/${f.path}`] = async () => dec.decode(f.data);
    }
  }
  const src = M.mgr.bundledSource(globbed, "../examples/plugins");
  // cmd-layer-align 要真改文档：给一个最小的 doc 服务（1920×1080 正交场景 + 一个选中的图层）
  const layerObj = { id: 7, name: "logo", origin: { value: "100.000 200.000 3.000", user: "pos" }, scale: "2.000 2.000 1.000", angles: "0.000 0.000 45.000" };
  const sceneDoc = { title: "t", type: "scene", scene: { general: { orthogonalprojection: { width: 1920, height: 1080 } }, objects: [layerObj] }, roots: [] };
  const edits = [];
  const logs = [];
  const docHost = {
    ...stubHost().doc,
    current: () => sceneDoc,
    selection: () => ({ id: 7, name: "logo", kind: "image", visible: true, obj: layerObj, children: [] }),
    editObject: (label, id, mutate) => {
      const ok = mutate(layerObj);
      if (ok) edits.push(label);
      return ok;
    },
    log: (msg, level = "info") => logs.push(`${level}:${msg}`),
  };
  const { a, m } = await bootWith(M, [src], { doc: docHost });
  await m.refresh();
  for (const e of m.list()) check(e.status === "active", `示例 ${e.key}：active（${e.status}${e.error ? ` ${e.error}` : ""}${e.missing.length ? ` 缺 ${e.missing}` : ""}）`);
  check(dirs.length >= 7 && ["fx-glow", "inspector-layer-stats", "cmd-layer-align"].every((d) => dirs.includes(d)), `新增示例都在（${dirs.join(", ")}）`);
  check(M.core.textOf({ "zh-CN": "中文", en: "English" }, "zh", "x") === "中文" && M.core.textOf({ "zh-CN": "中文", en: "English" }, "en", "x") === "English",
    "清单里的 zh-CN 文案在中文界面按主语言匹配（不再回退成英文）");

  // fx-glow：三个 pass、两个 FBO，参数按 pass 分到各自的 uniform 与常量里
  const glow = M.fx.effectCatalog.get("softglow");
  const gFiles = glow ? M.fx.effectFiles(glow) : [];
  const gText = (re) => new TextDecoder().decode(gFiles.find((f) => re.test(f.name))?.data ?? new Uint8Array());
  const gEffect = JSON.parse(gText(/effect\.json$/) || "{}");
  check(gEffect.passes?.length === 3 && json(gEffect.fbos?.map((f) => f.name)) === json(["glow_bright", "glow_blur"]) &&
    gEffect.passes[0].target === "glow_bright" && gEffect.passes[1].target === "glow_blur" && !gEffect.passes[2].target &&
    json(gEffect.passes[1].bind) === json([{ name: "glow_bright", index: 0 }]) && json(gEffect.passes[2].bind) === json([{ name: "glow_blur", index: 1 }]),
    `fx-glow：effect.json 有 3 个 pass、2 个 FBO，target / bind 串成「提亮 → 模糊 → 叠加」（${json(gEffect.passes)}）`);
  const p0 = gText(/wwgl_fx_glow_softglow\.frag$/);
  const p2 = gText(/wwgl_fx_glow_softglow_p2\.frag$/);
  check(/g_FxThreshold/.test(p0) && !/g_FxIntensity/.test(p0) && /uniform sampler2D g_Texture1;/.test(p2) && /uniform float g_FxIntensity;/.test(p2) && /uniform vec3 g_FxTint;/.test(p2),
    "fx-glow：阈值只进第 1 个 pass，强度 / 光色只进最后一个 pass，叠加 pass 声明了第二张输入");
  const glowObj = {};
  M.fx.addEffect(glowObj, "softglow");
  const consts = glowObj.effects?.[0]?.passes?.map((p) => Object.keys(p.constantshadervalues));
  check(json(consts) === json([["threshold"], ["radius"], ["intensity", "tint"]]), `fx-glow：加到图层后每个 pass 的常量各归各位（${json(consts)}）`);
  check(M.i18n.hasText("fxcat.light"), "fx-glow：插件词条提供了效果分类名 fxcat.light");

  // inspector-layer-stats：新标签 + 分组；统计函数数得对
  const statsGroup = M.inspector.inspectorGroups.get("layer-stats");
  check(!!M.inspector.inspectorTabs.get("stats") && statsGroup?.tab === "stats" && M.inspector.tabOf(statsGroup) === "stats", "inspector-layer-stats：登记「统计」标签，分组落在这个标签里");
  const LS = await import(pathToFileURL(path.join(exRoot, "inspector-layer-stats/index.js")).href);
  const st = LS.layerStats(
    {
      image: "models/logo.json",
      alpha: { value: 1, user: "opacity" },
      origin: { value: "0 0 0", script: "export function update(v) { return v; }" },
      scale: { value: "1 1 1", animation: { c0: [] } },
      effects: [{ name: "blur", file: "effects/wwgl_blur/effect.json", passes: [{ constantshadervalues: { radius: { value: 2, user: "r" } } }] }],
    },
    [{ children: [{ children: [] }] }],
  );
  check(st.descendants === 2 && st.bound === 2 && st.scripted === 1 && st.animated === 1 && json(st.effects) === json(["blur"]) &&
    json(st.files) === json(["effects/wwgl_blur/effect.json", "models/logo.json"]),
    `inspector-layer-stats：子图层 / 绑定 / 脚本 / 关键帧 / 效果 / 引用文件计数正确（${json(st)}）`);

  // cmd-layer-align：两条带快捷键的命令 + 两个工具条按钮；执行后经 doc.editObject 改文档（包装字段只改 value）
  const center = a.commands.registry.get("layerAlign.center");
  check(center?.keys === "Mod+Shift+K" && a.commands.registry.get("layerAlign.reset")?.keys === "Mod+Shift+U" &&
    json(a.ui.items("toolbar").map((x) => x.id)) === json(["layer-align-center", "layer-align-reset"]),
    "cmd-layer-align：登记 ⇧⌘K / ⇧⌘U 两条命令和两个工具条按钮");
  check(a.commands.handleKey({ key: "K", metaKey: true, shiftKey: true, ctrlKey: false, altKey: false }) &&
    layerObj.origin.value === "960.000 540.000 3.000" && layerObj.origin.user === "pos",
    `cmd-layer-align：⇧⌘K 把图层移到画面中心，z 不动、属性绑定保留（${json(layerObj.origin)}）`);
  a.commands.exec("layerAlign.reset");
  check(layerObj.scale === "1.000 1.000 1.000" && layerObj.angles === "0.000 0.000 0.000" && edits.length === 2, `cmd-layer-align：归位命令重置缩放 / 旋转，每条命令一次可撤销编辑（${json(edits)}）`);
  a.commands.exec("layerAlign.center");
  check(edits.length === 2 && logs.some((l) => /^info:/.test(l)), `cmd-layer-align：已经居中时不产生空编辑，只在控制台说明（${json(logs)}）`);

  // fx-crt：body + declarations 由 defineEffect 补头部与参数 uniform，插件片段内联
  const crt = M.fx.effectCatalog.get("crt");
  const crtFrag = crt ? new TextDecoder().decode(M.fx.effectFiles(crt).find((f) => f.name.endsWith(".frag")).data) : "";
  check(/uniform float g_FxCurvature; \/\/ \{"material":"curvature"/.test(crtFrag) && /vec2 crtWarp\(/.test(crtFrag) && !/#include/.test(crtFrag) && /gl_FragColor = c;/.test(crtFrag), "fx-crt：参数 uniform 自动生成、片段内联、body 进 main");
  // particle-fireflies：模板可直接生成粒子系统
  const ff = M.pt.particleTemplates.get("fireflies") ? M.pt.particleSystemDef("fireflies", "fireflies", 1920, 1080) : null;
  check(ff?.maxcount === 80 && ff.operator.length === 3, "particle-fireflies：模板登记并能生成粒子系统");
  // import-ply-pointcloud：无面 PLY 走插件导入器，有面 PLY 仍走内置
  const cloud = enc.encode(["ply", "format ascii 1.0", "element vertex 3", "property float x", "property float y", "property float z", "property uchar red", "property uchar green", "property uchar blue", "end_header", "0 0 0 255 0 0", "1 0 0 255 0 0", "0 1 0 255 0 0", ""].join("\n"));
  const meshPly = new Uint8Array(fs.readFileSync(path.join(ROOT, "scripts/fixtures/models/rig-ascii.ply")));
  check(M.modelImport.importerFor("c.ply", cloud)?.id === "ply-pointcloud" && M.modelImport.importerFor("m.ply", meshPly)?.id === "ply", "import-ply-pointcloud：嗅探只接无面 PLY，有面的仍归内置导入器");
  const lm = await M.modelImport.loadModelFile("c.ply", cloud);
  const cm = M.gltf.gltfToModel(lm.gltf, { target: "mesh", slug: "c" });
  check(cm.vertices === 12, `import-ply-pointcloud：3 个点 → 3 个方片 12 顶点（${cm.vertices}）`);
  // export-lint-strict：规则对不安全文件名报 error、缺封面报 warn
  const rule = M.pipeline.exportRules.get("lint-strict");
  const diags = [];
  await rule?.check({ exporter: "zip", doc: { scene: {} }, files: [{ path: "materials/图 a.png", data: new Uint8Array(1) }, { path: "scene.json", data: new Uint8Array(1) }], meta: {}, diag: (level, code, message, p) => diags.push({ level, code, p }) });
  check(json(diags.map((d) => `${d.level}:${d.code}`)) === json(["error:unsafe-name", "warn:no-preview"]), `export-lint-strict：不安全文件名 error、缺封面 warn（${json(diags)}）`);
  m.dispose();
  check(!M.pipeline.exportRules.get("lint-strict") && !M.fx.effectCatalog.get("crt") && M.modelImport.importerFor("c.ply", cloud)?.id === "ply", "示例全部卸载后贡献撤回（点云 PLY 回落到内置导入器）");
  const left = Object.entries({
    effect: !!M.fx.effectCatalog.get("softglow"),
    tab: !!M.inspector.inspectorTabs.get("stats"),
    group: !!M.inspector.inspectorGroups.get("layer-stats"),
    command: !!a.commands.registry.get("layerAlign.center"),
    toolbar: a.ui.items("toolbar").length > 0,
    i18n: M.i18n.hasText("fxcat.light"),
  }).filter(([, v]) => v).map(([k]) => k);
  check(!left.length, `新示例卸载后效果 / 标签 / 分组 / 命令 / 工具条按钮 / 词条全部撤回（残留 ${json(left)}）`);

  // 构建：示例 index.js 与 src 重建一致；运行时 import 编辑器真源被拒
  const B = await import(pathToFileURL(path.join(ROOT, "scripts/build-plugin-sdk.mjs")).href);
  for (const d of B.codeExamples()) {
    const mf = JSON.parse(fs.readFileSync(path.join(d, "wwgl-plugin.json"), "utf8"));
    check(fs.readFileSync(path.join(d, mf.main), "utf8") === (await B.buildPluginCode(d)), `${path.basename(d)}/${mf.main} 与 src 重建结果一致`);
  }
  const evil = path.join(tmpRoot, "evil-plugin");
  fs.mkdirSync(path.join(evil, "src"), { recursive: true });
  fs.writeFileSync(path.join(evil, "src/index.ts"), `import { effectCatalog } from ${json(path.join(ROOT, "editor/effects.ts"))};\nexport default { name: "evil", apply() { effectCatalog.list(); } };\n`);
  let evilErr = "";
  try {
    await B.buildPluginCode(evil);
  } catch (e) {
    evilErr = e.message;
  }
  check(/不得在运行时 import 编辑器真源 editor\/effects\.ts/.test(evilErr), "构建守卫：插件运行时 import 编辑器真源被拒");

  // 木偶生成器：一张 PNG → 4 骨摆动网格 → glTF → 编辑器模型
  const png = (() => {
    const w = 40;
    const h = 80;
    const stride = w * 4 + 1;
    const raw = Buffer.alloc(stride * h, 0xff);
    for (let y = 0; y < h; y++) raw[y * stride] = 0;
    const chunk = (type, data) => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length);
      const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(zlib.crc32(td));
      return Buffer.concat([len, td, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
  })();
  const ir = M.sway.swayPuppet("flag.png", png);
  const g = M.modelIr.irToGltf(ir);
  const model = M.gltf.gltfToModel(g, { target: "puppet", slug: "flag" });
  check(model.bones === 4 && model.clips.length === 1 && model.clips[0].frameCount > 1, `木偶生成器：PNG → 4 骨 1 片段，经 irToGltf → gltfToModel 往返（骨 ${model.bones} 片段 ${model.clips.length}）`);
  check(model.files.some((f) => /\.png$/.test(f.name)), "木偶生成器：源图作为贴图进了模型文件");
  return res;
}

function report(title, res) {
  console.log(`\n${title}`);
  for (const r of res) console.log(`  ${r.ok ? "✓" : "✗"} ${r.msg}`);
  return res.filter((r) => !r.ok).length;
}

const M = await load();
let fails = report("A–D 外部插件", await suite(M));
fails += report("E dev 宿主插件目录", await hostSuite());
fails += report("F 示例插件 / 木偶生成器", await examplesSuite(M));

// ── G. 变异红测 ──
const src = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const EXT = path.join(ROOT, "editor/plugins/external.ts");
const MGR = path.join(ROOT, "editor/plugins/manager.ts");
const mutants = [
  { name: "去掉代码插件白名单", file: EXT, from: "{ allow: grantedOf(m), meta", to: "{ allow: null, meta", expect: /未授权服务/ },
  { name: "启用开关失效", file: MGR, from: "o.settings.get<boolean>(enabledKey(id), true) !== false", to: "true", expect: /停用/ },
  { name: "未知 contributes 不报错", file: EXT, from: "if (!known.has(k)) errors.push", to: "if (false) errors.push", expect: /坏清单/ },
  { name: "目录来源不再优先", file: MGR, from: "RANK[k.source.kind] > RANK[cur.source.kind]", to: "false", expect: /目录版/ },
  { name: "内置示例盖过已安装版", file: MGR, from: "dir: 3, store: 2, memory: 1, bundled: 0", to: "dir: 3, store: 2, memory: 1, bundled: 9", expect: /内置/ },
];
let killed = 0;
console.log("\nG 变异红测");
for (const mu of mutants) {
  const orig = src(path.relative(ROOT, mu.file));
  if (!orig.includes(mu.from)) {
    console.log(`  ✗ ${mu.name}：源码里找不到变异点`);
    fails++;
    continue;
  }
  const MM = await load({ [mu.file]: orig.replace(mu.from, mu.to) });
  const r = await suite(MM);
  const red = r.filter((x) => !x.ok && mu.expect.test(x.msg));
  if (red.length) killed++;
  else fails++;
  console.log(`  ${red.length ? "✓" : "✗"} ${mu.name} → ${red.length ? `变红：${red[0].msg}` : "没有判据变红"}`);
}

console.log(fails ? `\n✗ ${fails} 处问题` : `\n✓ 全部通过（变异 ${killed}/${mutants.length} 被杀）`);
process.exit(fails ? 1 : 0);
