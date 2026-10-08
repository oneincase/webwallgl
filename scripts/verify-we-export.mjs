#!/usr/bin/env node
/**
 * verify-we-export —— 导出管线与 WE 兼容性回读（PLUGIN-ARCHITECTURE §4）。
 *
 * 真源：editor/export-pipeline.ts + renderer/src/editor/compat.ts（esbuild 打成临时 mjs 真跑）。覆盖：
 *   A. 编辑器真实产物（图片层 + 单 / 多 pass 效果 + 粒子 + shader 片段）散装与 scene.pkg 两种形态回读零 error；
 *   B. 坏产物逐类报错：缺文件 / 大小写不符 / 坏 JSON / 缺 shader / uniform 注释坏 / project.json 不合法；
 *   C. 管线：钩子顺序、规则分阶段、error 拦在 sink 前、force 放行、钩子抛错隔离、project.json 记插件；
 *   D. 粒子组件白名单与 render/particles.js 的解析分支逐项一致（引擎加了组件这里会红）；
 *   E. 变异红测：把校验器 / 管线改坏，确认对应判据变红。
 */
import { build } from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { pathToFileURL } from "node:url";
import { LIB, ROOT } from "./lib/verify-kit.mjs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "verify-we-export-"));
process.on("exit", () => fs.rmSync(tmpRoot, { recursive: true, force: true }));
const json = (v) => JSON.stringify(v);
const enc = new TextEncoder();
const dec = new TextDecoder();

const ENTRY = `
export * as pipeline from "./editor/export-pipeline.ts";
export * as create from "./editor/create.ts";
export * as fx from "./editor/effects.ts";
export * as pt from "./editor/particles.ts";
export * as save from "./editor/save.ts";
export * as assets from "./editor/assets.ts";
export * as shaderLib from "./editor/shader-lib.ts";
export { checkWeCompat } from "./renderer/src/editor/compat.ts";
`;

async function load(overrides = {}) {
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

function png(w, h) {
  const stride = w * 3 + 1;
  const raw = Buffer.alloc(stride * h, 0x80);
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
  ihdr[9] = 2;
  return new Uint8Array(
    Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]),
  );
}

/** 编辑器真实链路造一份工程：图片层 + 单 pass / 多 pass（含 #include）效果 + 粒子层 */
async function makeProject(M) {
  const { create, fx, pt, save, assets } = M;
  const doc = create.newDocument("导出判据", 1280, 720, [0, 0, 0]);
  const empty = { entry: "scene.json", read: async () => null, list: () => [] };
  const ov = assets.overlayAssets("scene.json", empty, () => new Set([...create.referencedModels(doc), ...fx.referencedEffects(doc), ...pt.referencedParticles(doc)]));
  const img = { name: "bg.png", bytes: png(32, 18), ext: "png", width: 32, height: 18 };
  for (const x of create.imageLayerFiles("bg", img)) ov.put(x.name, x.data, create.modelPathOf("bg"));
  const id = create.addImageLayer(doc, "bg", img, "cover");
  const obj = doc.scene.objects.find((o) => o.id === id);
  const multi = fx.defineEffect({
    id: "glowtest",
    title: "Glow",
    params: [{ key: "amount", type: "float", default: 0.5, min: 0, max: 1 }],
    passes: [
      {
        declarations: '#include "wwgl/noise"\n',
        body: "\tvec4 c = texSample2D(g_Texture0, v_TexCoord);\n\tgl_FragColor = vec4(c.rgb * (1.0 + g_FxAmount * wwglNoise(v_TexCoord * 8.0)), c.a);",
        target: "_rt_HalfCompoBuffer1",
      },
      { bind: [{ name: "_rt_HalfCompoBuffer1", index: 0 }] },
    ],
    fbos: [{ name: "_rt_HalfCompoBuffer1", scale: 2, format: "rgba8888" }],
  });
  const off = fx.effectCatalog.add(multi, "test");
  for (const def of [fx.effectById("tint"), multi]) for (const x of fx.effectFiles(def)) ov.put(x.name, x.data, fx.effectFileOf(def.id));
  fx.addEffect(obj, "tint");
  fx.addEffect(obj, "glowtest");
  for (const x of pt.particleLayerFiles(doc, "snow", "snow")) ov.put(x.name, x.data, pt.particlePathOf("snow"));
  pt.addParticleLayer(doc, "snow", "雪", "snow");
  const loose = await save.collectProject(doc, ov, new Blob([new Uint8Array([0xff, 0xd8, 0xff])]));
  off();
  return { doc, loose };
}

const has = (r, code, pathRe) => r.issues.some((i) => i.level === "error" && i.code === code && (!pathRe || pathRe.test(i.path ?? "")));
const errs = (r) => r.issues.filter((i) => i.level === "error");
const replaceFile = (files, p, data) => files.map((f) => (f.path === p ? { path: p, data: typeof data === "string" ? enc.encode(data) : data } : f));
const without = (files, p) => files.filter((f) => f.path !== p);
const readJson = (files, p) => JSON.parse(dec.decode(files.find((f) => f.path === p).data));

async function suite(M) {
  const res = [];
  const check = (ok, msg) => res.push({ ok: !!ok, msg });
  const { pipeline, save, checkWeCompat, pt } = M;
  const { doc, loose } = await makeProject(M);

  // ── A. 真实产物回读 ──
  {
    const r = await checkWeCompat(loose);
    check(r.ok && r.form === "loose" && r.type === "scene" && r.entry === "scene.json", `散装产物回读零 error（${json(errs(r).map((i) => i.message))}）`);
    check(r.layers === 2 && r.effects === 2, `引擎解析出 2 层、效果链 2 条（实得 ${r.layers} / ${r.effects}）`);
    const glowFrag = loose.find((f) => /shaders\/effects\/wwgl_glowtest\.frag$/.test(f.path));
    check(glowFrag && !dec.decode(glowFrag.data).includes("#include") && dec.decode(glowFrag.data).includes("float wwglNoise("), "#include \"wwgl/…\" 已内联，产物里没有编辑器私有指令");
    check(loose.some((f) => /wwgl_glowtest_p1\.frag$/.test(f.path)), "多 pass 效果第二个 pass 有独立 shader 文件");
    const packed = save.packProject(loose).files;
    const rp = await checkWeCompat(packed);
    check(rp.ok && rp.form === "pkg" && rp.layers === 2, `scene.pkg 形态回读零 error（${json(errs(rp).map((i) => i.message))}）`);
    check(!rp.issues.some((i) => i.code === "tex-source"), "pkg 形态：图片层源图都已转 .tex");
  }

  // ── B. 坏产物逐类报错 ──
  {
    check(has(await checkWeCompat(without(loose, "project.json")), "project-json"), "缺 project.json → error");
    check(has(await checkWeCompat(replaceFile(loose, "project.json", "{bad")), "project-json"), "project.json 坏 JSON → error");
    const pj = readJson(loose, "project.json");
    check(has(await checkWeCompat(replaceFile(loose, "project.json", json({ ...pj, type: "slideshow" }))), "project-type"), "project.json type 不认识 → error");
    check(has(await checkWeCompat(replaceFile(loose, "project.json", json({ ...pj, file: "nope.json" }))), "missing-entry"), "入口不存在 → error");
    check(has(await checkWeCompat(replaceFile(loose, "scene.json", "{")), "bad-json"), "scene.json 坏 JSON → error");
    const model = loose.find((f) => /^models\/editor\/bg\.json$/.test(f.path)).path;
    check(has(await checkWeCompat(without(loose, model)), "missing-file", /models\/editor\/bg\.json/), "图片层模型缺失 → missing-file");
    const renamed = loose.map((f) => (f.path === model ? { path: model.replace("bg.json", "BG.json"), data: f.data } : f));
    const rc = await checkWeCompat(renamed);
    check(rc.issues.some((i) => i.code === "missing-file" && /大小写/.test(i.message)), "只差大小写 → 点明大小写");
    const shader = loose.find((f) => /shaders\/effects\/wwgl_tint\.frag$/.test(f.path)).path;
    check(has(await checkWeCompat(without(loose, shader)), "missing-file", /wwgl_tint\.frag/), "编辑器效果 shader 缺失 → error");
    const fxMat = loose.find((f) => /materials\/effects\/wwgl_tint\.json$/.test(f.path)).path;
    check(has(await checkWeCompat(without(loose, fxMat)), "missing-file", /wwgl_tint\.json/), "效果材质缺失 → error");
    const fxFile = loose.find((f) => /effects\/wwgl_tint\/effect\.json$/.test(f.path)).path;
    check(has(await checkWeCompat(replaceFile(loose, fxFile, json({ passes: [{ shader: "x" }] }))), "effect-pass"), "效果 pass 直写 shader（两段式写错）→ error");
    const src = dec.decode(loose.find((f) => f.path === shader).data).replace(/(uniform\s+\w+\s+\w+;\s*\/\/\s*)\{/, "$1{oops");
    const ru = await checkWeCompat(replaceFile(loose, shader, src));
    check(ru.issues.some((i) => i.code === "uniform-note" && i.level === "warn"), "uniform 注释不是合法 JSON → warn");
    const ptFile = pt.particlePathOf("snow");
    check(has(await checkWeCompat(without(loose, ptFile)), "missing-file", /particles\/editor\/snow\.json/), "粒子系统文件缺失 → error");
    const pr = await checkWeCompat(loose);
    check(pr.issues.some((i) => i.level === "info" && i.code === "builtin-texture"), "粒子贴图 particle/halo 按 WE 内置贴图处理（info，不算错）");
    const video = [
      { path: "clip.mp4", data: new Uint8Array([0, 0, 0, 0x18]) },
      { path: "project.json", data: enc.encode(json({ title: "v", type: "video", file: "clip.mp4" })) },
    ];
    check((await checkWeCompat(video)).ok && has(await checkWeCompat(without(video, "clip.mp4")), "missing-file"), "视频壁纸：文件在 → ok，不在 → error");
  }

  // ── C. 管线 ──
  {
    const offs = [
      ...pipeline.BUILTIN_EXPORTERS.map((e) => pipeline.exporters.add(e, "builtin")),
      ...pipeline.BUILTIN_EXPORT_HOOKS.map((h) => pipeline.exportHooks.add(h, "builtin")),
      ...pipeline.BUILTIN_EXPORT_RULES.map((r) => pipeline.exportRules.add(r, "builtin")),
    ];
    const order = [];
    offs.push(pipeline.exportHooks.add({ id: "late", order: 90, run: () => order.push("late") }, "t"));
    offs.push(pipeline.exportHooks.add({ id: "early", order: 1, run: () => order.push("early") }, "t"));
    offs.push(pipeline.exportRules.add({ id: "r-loose", stage: "loose", check: (c) => order.push(`loose:${c.files.some((f) => f.path === "scene.pkg")}`) }, "t"));
    offs.push(pipeline.exportRules.add({ id: "r-packed", stage: "packed", order: 1, check: (c) => order.push(`packed:${c.files.some((f) => f.path === "scene.pkg")}`) }, "t"));
    let sunk = null;
    offs.push(pipeline.exporters.add({ id: "mem", accepts: "scene", pack: (c) => save.packProject(c.files).files, sink: async (files) => ((sunk = files), "ok") }, "t"));
    const r = await pipeline.runExportPipeline("mem", doc, async () => loose.map((f) => ({ ...f })));
    check(r.ok && !r.blocked && sunk && r.message === "ok", `正常产物走完到 sink（${json(r.diags.filter((d) => d.level === "error"))}）`);
    check(json(order) === json(["early", "late", "loose:false", "packed:true"]), `阶段顺序：钩子按 order → loose 规则 → pack → packed 规则（实得 ${json(order)}）`);
    check(json(pipeline.exporters.list().map((e) => e.id).slice(0, 3)) === json(["pkg", "zip", "folder"]), "内置导出目标按 order 排：pkg / zip / folder（菜单 id = export-<id>）");

    sunk = null;
    const broken = (await pipeline.runExportPipeline("mem", doc, async () => without(loose, loose.find((f) => /wwgl_tint\.frag$/.test(f.path)).path)));
    check(!broken.ok && broken.blocked && sunk === null && broken.diags.some((d) => d.source === "we-compat" && d.level === "error"), "we-compat 报 error → 拦在 sink 前");
    const forced = await pipeline.runExportPipeline("mem", doc, async () => without(loose, loose.find((f) => /wwgl_tint\.frag$/.test(f.path)).path), { force: true });
    check(forced.blocked === false && sunk !== null, "force：有 error 也照样落地");

    const pluginErrors = [];
    offs.push(pipeline.exportHooks.add({ id: "boom", run: () => { throw new Error("炸了"); } }, "t"));
    const rb = await pipeline.runExportPipeline("mem", doc, async () => loose.map((f) => ({ ...f })), { dryRun: true, onPluginError: (id) => pluginErrors.push(id) });
    check(rb.diags.some((d) => d.source === "boom" && d.code === "plugin-error") && json(pluginErrors) === json(["boom"]) && order.includes("packed:true"), "钩子抛错：记成诊断并上报内核，不打断后续阶段");

    offs.push(
      pipeline.exportHooks.add({ id: "plugins-meta", order: 0, run: (c) => (c.meta.plugins = [{ id: "fx-crt", version: "1.0.0" }]) }, "t"),
    );
    const rm = await pipeline.runExportPipeline("zip", doc, async () => loose.map((f) => ({ ...f })), { dryRun: true });
    const pj = readJson(rm.files, "project.json");
    check(json(pj.editor?.plugins) === json([{ id: "fx-crt", version: "1.0.0" }]) && pj.type === "scene" && pj.file === "scene.json", "project-json 钩子：记下用到的插件，WE 字段不动");
    check(rm.files.length === loose.length && !rm.files.some((f) => f.path === "scene.pkg"), "zip 目标不打包（散装原样）");
    let threw = false;
    try {
      pipeline.exporters.add({ id: "Bad Id", sink: async () => {} });
    } catch {
      threw = true;
    }
    check(threw, "导出目标 id 不合法被拒（菜单 id 要能拼进 export-<id>）");
    for (const off of offs.reverse()) off();
    check(pipeline.exporters.list().length === 0 && pipeline.exporters.get("pkg"), "全部撤下后 list 为空，get 仍有内置兜底");
  }

  // ── D. 粒子组件白名单 ↔ 引擎解析分支 ──
  {
    const src = fs.readFileSync(path.join(ROOT, "renderer/vendor/we-scene/render/particles.js"), "utf8");
    const cases = (from, to) => {
      const a = src.indexOf(from);
      const b = src.indexOf(to, a + from.length);
      return [...src.slice(a, b).matchAll(/case '([a-z]+)'/g)].map((m) => m[1]).sort();
    };
    const listed = (kind) => pt.BUILTIN_PARTICLE_COMPONENTS.filter((c) => c.kind === kind).map((c) => c.id).sort();
    const init = cases("switch (z.name)", "switch (o.name)");
    const ops = cases("switch (o.name)", "// 渲染器");
    check(init.length > 5 && json(listed("initializer")) === json(init), `initializer 白名单 = 引擎分支（引擎 ${json(init)}）`);
    check(ops.length > 10 && json(listed("operator")) === json(ops), `operator 白名单 = 引擎分支（引擎 ${json(ops)}）`);
    check(/e\.name === 'boxrandom' \? 'box' : 'sphere'/.test(src) && json(listed("emitter")) === json(["boxrandom", "sphererandom"]), "emitter 白名单 = boxrandom / sphererandom");
    check(["spritetrail", "ropetrail", "'rope'"].every((k) => src.includes(k)) && json(listed("renderer")) === json(["rope", "ropetrail", "sprite", "spritetrail"]), "renderer 白名单 = sprite / spritetrail / rope / ropetrail");
    let rejected = false;
    try {
      pt.particleComponents.add({ id: "magicdust", kind: "operator" });
    } catch {
      rejected = true;
    }
    check(rejected, "引擎不认识的组件注册被拒（插件只能产出 WE 原生数据）");
  }
  return res;
}

const results = await suite(await load());
let failed = 0;
for (const r of results) {
  console.log(`  ${r.ok ? "✓" : "✗"} ${r.msg}`);
  if (!r.ok) failed++;
}

console.log("\nF. 真壁纸库零误报（WE 官方产出的 scene.pkg 回读不该有 error）");
{
  const M = await load();
  const items = fs.existsSync(LIB) ? fs.readdirSync(LIB) : [];
  let n = 0;
  const bad = [];
  for (const id of items) {
    const dir = path.join(LIB, id);
    const pj = path.join(dir, "project.json");
    const pkg = path.join(dir, "scene.pkg");
    if (!fs.existsSync(pj) || !fs.existsSync(pkg)) continue;
    let type = "";
    try {
      type = String(JSON.parse(fs.readFileSync(pj, "utf8")).type).toLowerCase();
    } catch {
      continue;
    }
    if (type !== "scene") continue;
    n++;
    const r = await M.checkWeCompat([
      { path: "project.json", data: fs.readFileSync(pj) },
      { path: "scene.pkg", data: fs.readFileSync(pkg) },
    ]);
    const e = r.issues.find((i) => i.level === "error");
    if (e) bad.push(`${id}: ${e.message}`);
  }
  if (!n) console.log("  - 跳过：本机没有壁纸库（WE_LIBRARY）");
  else {
    const ok = bad.length === 0;
    console.log(`  ${ok ? "✓" : "✗"} ${n} 张 scene 壁纸回读零 error${ok ? "" : `（${bad.length} 张误报，例：${bad.slice(0, 3).join("；")}）`}`);
    if (!ok) failed++;
  }
}

console.log("\nE. 变异红测");
const compatAbs = path.join(ROOT, "renderer/src/editor/compat.ts");
const pipeAbs = path.join(ROOT, "editor/export-pipeline.ts");
const compatSrc = fs.readFileSync(compatAbs, "utf8");
const pipeSrc = fs.readFileSync(pipeAbs, "utf8");
const mutants = [
  { file: compatAbs, src: compatSrc, from: "if (isWeBuiltin(name) || exists(name)) return true;", to: "return true;", expect: "图片层模型缺失 → missing-file" },
  { file: compatAbs, src: compatSrc, from: `if (/^effects\\/wwgl_/.test(shader)`, to: "if (false", expect: "编辑器效果 shader 缺失 → error" },
  { file: compatAbs, src: compatSrc, from: `JSON.parse(m[2].trim());`, to: "void m;", expect: "uniform 注释不是合法 JSON → warn" },
  { file: compatAbs, src: compatSrc, from: `add("error", "project-type"`, to: `add("info", "project-type"`, expect: "project.json type 不认识 → error" },
  { file: pipeAbs, src: pipeSrc, from: "if (hasError && !opts.force) return", to: "if (false) return", expect: "we-compat 报 error → 拦在 sink 前" },
  { file: pipeAbs, src: pipeSrc, from: "opts.onPluginError?.(id, e);", to: "", expect: "钩子抛错：记成诊断并上报内核，不打断后续阶段" },
];
for (const m of mutants) {
  const mutated = m.src.replace(m.from, m.to);
  const injected = mutated !== m.src;
  console.log(`  ${injected ? "✓" : "✗"} 注入点存在（${m.expect}）`);
  if (!injected) {
    failed++;
    continue;
  }
  const r = (await suite(await load({ [m.file]: mutated }))).find((x) => x.msg.startsWith(m.expect));
  const red = r && !r.ok;
  console.log(`  ${red ? "✓" : "✗"} 改坏后「${m.expect}」变红`);
  if (!red) failed++;
}

if (failed) {
  console.log(`\n✗ ${failed} 项失败`);
  process.exit(1);
}
console.log(`\n✓ 全部通过（${results.length} 项 + ${mutants.length} 个变异）`);
