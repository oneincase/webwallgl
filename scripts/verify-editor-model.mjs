#!/usr/bin/env node
/**
 * verify-editor-model —— 编辑器模型面（EDITOR-PLAN §3B）的语料参照与真浏览器判据。
 *
 * modelTruth(lib, id)：Node 侧直接 parsePkg + parseMDL 出「这张壁纸的模型层应当长什么样」，
 *   离线段（verify-editor.mjs 的 MA）与本文件的真浏览器段共用这一份参照。
 * runModelHeadless：自起 vite（WE_LIBRARY 指向临时库）+ 真 GPU Chrome，挂夹具壁纸，
 *   引擎 getLayers 的模型层 / getModelInfo 逐项对照 modelTruth（W12 判据）。
 *
 * 用法：node scripts/verify-editor-model.mjs        # 只跑真浏览器段（也会被 verify-editor --headless 调用）
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, LIB as DEFAULT_LIB, imp } from "./lib/verify-kit.mjs";

/** puppet：有动画 / 有附着点 / 16 个模型 14 个附着点 / 含 MDLV0019 / MDLV0016 */
export const PUPPET_FIXTURES = ["3444535389", "3465215190", "3463520581", "3238423642", "2952574984"];
/** 真 3D：天空盒 + 恒星（单网格 LIGHTING）、多子网格 */
export const MESH_FIXTURES = ["3509243656", "3477054430"];
/**
 * 引擎合理跳过、仍留作普通图层的模型对象（壁纸 → 对象 id）。不在表里的跳过一律算缺陷：
 * 3465215190 #2480 曾因材质槽 0 是 $mediaThumbnail、封面未到就不写占位贴图而被误跳过。
 */
const KNOWN_SKIPS = {
  // 贴图是 `_rt_imageLayerComposite_*`（别的图层的实时合成结果），引擎尚不支持作模型贴图
  "3509243656": [331, 436],
};

const P = await imp("renderer/vendor/we-scene/render/mdl-parse.js");
const S = await imp("renderer/vendor/we-scene/render/mdl-skin.js");
const C = await imp("renderer/vendor/we-scene/pkg/container.js");
const dec = new TextDecoder();
const readJson = (bytes) => JSON.parse(dec.decode(bytes).replace(/^\uFEFF/, ""));

/** null = 夹具缺失（本机没有这张壁纸） */
export function modelTruth(lib, id) {
  const pkgPath = path.join(lib, id, "scene.pkg");
  if (!fs.existsSync(pkgPath)) return null;
  const pkg = C.parsePkg(new Uint8Array(fs.readFileSync(pkgPath)));
  const read = (name) => C.getEntry(pkg, name);
  const scene = readJson(read("scene.json"));
  const objects = [];
  const puppets = new Map();
  for (const o of scene.objects || []) {
    let form = null;
    let mdlPath = null;
    let jsonPath = null;
    if (typeof o.model === "string") {
      form = "mesh";
      mdlPath = o.model;
    } else if (typeof o.image === "string" && /\.json$/i.test(o.image) && read(o.image)) {
      try {
        const mj = readJson(read(o.image));
        if (typeof mj.puppet === "string" && mj.puppet) {
          form = "puppet";
          mdlPath = mj.puppet;
          jsonPath = o.image;
          puppets.set(o.image, mj.puppet);
        }
      } catch {
        /* 非 json 模型 */
      }
    }
    if (!form || !read(mdlPath)) continue;
    const m = P.parseMDL(read(mdlPath));
    const meshes = m.meshes && m.meshes.length ? m.meshes : [m];
    objects.push({
      id: o.id,
      name: o.name ?? "",
      info: {
        form,
        mdlPath,
        modelJsonPath: jsonPath,
        version: m.magic,
        vertexCount: m.vertexCount,
        bones: m.bones.map((b) => ({ name: b.name, parent: b.parent })),
        animations: m.animations.map((a) => ({
          id: a.id,
          name: a.name,
          mode: a.mode,
          fps: a.fps,
          frameCount: a.frameCount,
          duration: a.fps > 0 ? a.frameCount / a.fps : 0,
          events: a.events.map((e) => ({ frame: e.frame, name: e.name })),
        })),
        attachments: (m.attachments || []).map((at) => {
          const bm = S.attachmentBind(m, at.name);
          return { name: at.name, bone: at.bone, bindOrigin: bm ? [bm[12], bm[13], bm[14]] : [0, 0, 0] };
        }),
        meshes: meshes.map((me) => ({ materialPath: me.materialPath ?? null, vertexCount: me.vertexCount })),
      },
    });
  }
  return { scene, objects, puppets, read };
}

const near = (a, b) => Math.abs(a - b) <= 1e-3 * Math.max(1, Math.abs(b));

/** 引擎给的 EditorModelInfo 与参照逐项比（texture 是引擎加载结果，不在参照里） */
export function sameModelInfo(got, want) {
  if (!got) return "getModelInfo 为 null";
  for (const k of ["form", "mdlPath", "modelJsonPath", "version", "vertexCount"]) {
    if (got[k] !== want[k]) return `${k}: ${JSON.stringify(got[k])} ≠ ${JSON.stringify(want[k])}`;
  }
  if (JSON.stringify(got.bones) !== JSON.stringify(want.bones)) return "骨骼名 / 父链不一致";
  if (got.animations.length !== want.animations.length) return `动画数 ${got.animations.length} ≠ ${want.animations.length}`;
  for (let i = 0; i < want.animations.length; i++) {
    const g = got.animations[i];
    const w = want.animations[i];
    if (g.id !== w.id || g.name !== w.name || g.mode !== w.mode || !near(g.fps, w.fps) || g.frameCount !== w.frameCount || !near(g.duration, w.duration)) {
      return `动画 #${i} 不一致：${JSON.stringify(g)} vs ${JSON.stringify(w)}`;
    }
    if (JSON.stringify(g.events) !== JSON.stringify(w.events)) return `动画 #${i} 帧事件不一致`;
  }
  if (got.attachments.length !== want.attachments.length) return `附着点数 ${got.attachments.length} ≠ ${want.attachments.length}`;
  for (let i = 0; i < want.attachments.length; i++) {
    const g = got.attachments[i];
    const w = want.attachments[i];
    if (g.name !== w.name || g.bone !== w.bone || !g.bindOrigin.every((v, k) => near(v, w.bindOrigin[k]))) {
      return `附着点 ${w.name} 不一致：${JSON.stringify(g)} vs ${JSON.stringify(w)}`;
    }
  }
  if (got.meshes.length !== want.meshes.length) return `子网格数 ${got.meshes.length} ≠ ${want.meshes.length}`;
  for (let i = 0; i < want.meshes.length; i++) {
    if (got.meshes[i].materialPath !== want.meshes[i].materialPath || got.meshes[i].vertexCount !== want.meshes[i].vertexCount) {
      return `子网格 ${i} 不一致`;
    }
  }
  return "";
}

export async function runModelHeadless({ check, section, tmpRoot, LIB = DEFAULT_LIB }) {
  section("MA2. 模型层识别（真浏览器）：getLayers 的模型层 / getModelInfo ≡ parseMDL 直读");
  const pick = (process.env.VEM_FIXTURES || "").split(",").filter(Boolean);
  const fixtures = [...PUPPET_FIXTURES, ...MESH_FIXTURES]
    .filter((id) => !pick.length || pick.includes(id))
    .filter((id) => fs.existsSync(path.join(LIB, id, "scene.pkg")));
  check(fixtures.filter((id) => PUPPET_FIXTURES.includes(id)).length >= 3, `puppet 夹具至少 3 张在本机（${fixtures.join(", ")}）`);
  if (!fixtures.length) return;
  const lib = fs.mkdtempSync(path.join(tmpRoot, "lib-model-"));
  for (const id of fixtures) {
    fs.mkdirSync(path.join(lib, id), { recursive: true });
    for (const f of ["project.json", "scene.pkg"]) fs.copyFileSync(path.join(LIB, id, f), path.join(lib, id, f));
  }
  const prevLib = process.env.WE_LIBRARY;
  process.env.WE_LIBRARY = lib;
  const port = await new Promise((res) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
  const { createServer } = await import("vite");
  const server = await createServer({
    root: ROOT,
    configFile: path.join(ROOT, "vite.config.ts"),
    server: { port, host: "127.0.0.1", strictPort: true, open: false },
    logLevel: "error",
  });
  await server.listen();
  const origin = `http://127.0.0.1:${port}`;
  const { launchHeadless, instrument } = await imp("scripts/headless-gpu.mjs");
  const session = await launchHeadless({ url: "about:blank", task: "verify-editor-model", width: 1280, height: 720 });
  instrument(session, { width: 1280, height: 720 });
  try {
    const only = process.env.VEM_ONLY || "";
    if (only === "md2") {
      await runPickHeadless({ check, section, session, origin, fixtures });
      return;
    }
    if (only === "me2") {
      await runRetexHeadless({ check, section, session, origin, fixtures });
      return;
    }
    if (only === "mf2") {
      await runBoneHeadless({ check, section, session, origin, fixtures, LIB });
      return;
    }
    if (only === "mg2") {
      await runClipHeadless({ check, section, session, origin, fixtures, LIB });
      return;
    }
    for (const id of fixtures) {
      const truth = modelTruth(LIB, id);
      await session.pageCdp.send("Page.navigate", { url: `${origin}/renderer/index.html?type=canvas` });
      await session.waitFor("!!window.__wp", { timeoutMs: 60000 });
      let got;
      try {
        got = await session.evaluate(`(async () => {
          window.__wp.pause();
          const api = await import('/renderer/src/api/editor.ts');
          const host = document.createElement('div');
          host.style.cssText = 'position:fixed;left:0;top:0;width:960px;height:540px;z-index:9';
          document.body.appendChild(host);
          const diags = [];
          const inst = await api.mount(host, { source: api.httpSource('${origin}/media/dev/${id}'), fit: 'cover', renderDpr: 1, volume: 0, autoplay: false, onDiagnostic: (m) => diags.push(String(m)) });
          const ed = api.editorOf(inst);
          const layers = ed.getLayers();
          const models = layers.filter((l) => l.kind === 'model').map((l) => ({ id: l.id, form: l.modelForm, info: ed.getModelInfo(l.id) }));
          const other = layers.find((l) => l.kind !== 'model');
          const kinds = Object.fromEntries(layers.map((l) => [l.id, l.kind]));
          const skips = diags.filter((m) => /跳过/.test(m));
          const out = { models, kinds, skips, otherNull: other ? ed.getModelInfo(other.id) === null : true, missingNull: ed.getModelInfo(987654) === null };
          inst.destroy();
          return out;
        })()`, { awaitPromise: true, timeoutMs: 180000 });
      } catch (e) {
        check(false, `${id}: 挂载失败 ${String(e.message).slice(0, 160)}`);
        continue;
      }
      const byId = new Map(got.models.map((m) => [m.id, m]));
      const bad = [];
      const skipped = [];
      let matched = 0;
      for (const t of truth.objects) {
        const g = byId.get(t.id);
        if (!g) {
          // 引擎明说跳过（贴图缺失 / 不支持的贴图来源）的层不装模型，留作普通图层是对的
          const why = got.skips.find((m) => m.includes(`'${t.name}'`));
          if (why && got.kinds[t.id] === "image" && (KNOWN_SKIPS[id] || []).includes(t.id)) skipped.push(`#${t.id}「${why.slice(0, 60)}」`);
          else bad.push(`#${t.id} ${t.name}: 引擎没认成模型层（kind=${got.kinds[t.id] ?? "缺层"}）${why ? `：${why.slice(0, 60)}（不在已知跳过表）` : "且无跳过诊断"}`);
          continue;
        }
        const why = g.form !== t.info.form ? `modelForm ${g.form} ≠ ${t.info.form}` : sameModelInfo(g.info, t.info);
        if (why) bad.push(`#${t.id} ${t.name}: ${why}`);
        else matched++;
      }
      const extra = got.models.filter((m) => !truth.objects.some((t) => t.id === m.id));
      const nBones = truth.objects.reduce((s, t) => s + t.info.bones.length, 0);
      const nAnim = truth.objects.reduce((s, t) => s + t.info.animations.length, 0);
      const nAtt = truth.objects.reduce((s, t) => s + t.info.attachments.length, 0);
      check(
        bad.length === 0 && extra.length === 0 && matched > 0,
        `${id}: ${matched}/${truth.objects.length} 个模型层（骨 ${nBones} / 动画 ${nAnim} / 附着点 ${nAtt}）与 parseMDL 逐项一致` +
          (skipped.length ? `，${skipped.join(",")} 引擎报跳过` : "") +
          (bad.length ? ` —— ${bad.slice(0, 3).join("；")}` : "") +
          (extra.length ? ` —— 多认了 ${extra.map((m) => m.id).join(",")}` : ""),
      );
      check(got.otherNull && got.missingNull, `${id}: 非模型层 / 不存在的 id 给 null`);
    }
    await runAnimLayersHeadless({ check, section, session, origin, fixtures, LIB });
    await runAttachHeadless({ check, section, session, origin, fixtures, LIB });
    await runPickHeadless({ check, section, session, origin, fixtures });
    await runRetexHeadless({ check, section, session, origin, fixtures });
    await runBoneHeadless({ check, section, session, origin, fixtures, LIB });
    await runClipHeadless({ check, section, session, origin, fixtures, LIB });
  } finally {
    await session.close();
    await server.close();
    if (prevLib === undefined) delete process.env.WE_LIBRARY;
    else process.env.WE_LIBRARY = prevLib;
  }
}

/** 可热替换的 puppet 动画层：表非空、片段字段之外没有任何包装 */
function hotAnimTargets(scene) {
  const objs = scene?.objects ?? [];
  const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
  const hotList = (o) => Array.isArray(o.animationlayers) && o.animationlayers.every((a) => a && typeof a.animation === "number" && !Object.values(a).some(isObj));
  // 除动画层外随场景时间变化的东西（关键帧曲线 / 脚本）会让「rate×2@t ≡ 原速@2t」不成立
  const timeDriven = (o) => {
    const { animationlayers, ...rest } = o;
    return /"script"\s*:|"animation"\s*:\s*\{/.test(JSON.stringify(rest));
  };
  return objs
    .filter((o) => o.animationlayers?.length && hotList(o))
    .flatMap((o) => {
      const chain = [];
      for (let cur = o; cur && !chain.includes(cur.id); cur = objs.find((x) => x.id === cur.parent)) chain.push(cur.id);
      const chainObjs = chain.map((cid) => objs.find((x) => x.id === cid));
      if (chainObjs.some((c) => !hotList(c) || timeDriven(c))) return [];
      const lists = Object.fromEntries(chainObjs.filter((c) => c.animationlayers?.length).map((c) => [c.id, c.animationlayers]));
      return [{ id: o.id, name: o.name ?? "", layers: o.animationlayers, chain, lists }];
    });
}

/**
 * MB2（W13）：setAnimationLayers 的整表热替换在真 GPU 上的效果。隔离出帧（只留目标层与父链、关掉它的效果）：
 *   rate×2 在 t ≡ 原速在 2t；推回原表在 2t ≡ 首帧；全层 blend 0 ≠ 原样（回到绑定姿势）；对照 t ≠ 2t（动画真在动）。
 */
async function runAnimLayersHeadless({ check, section, session, origin, fixtures, LIB }) {
  section("MB2. 动画层热替换（真浏览器）：rate×2 @ t ≡ 原速 @ 2t，推回原表复原，blend 0 回绑定姿势");
  let tested = 0;
  const jobs = fixtures.filter((x) => PUPPET_FIXTURES.includes(x)).flatMap((id) => hotAnimTargets(modelTruth(LIB, id)?.scene).slice(0, 3).map((target) => ({ id, target })));
  const done = new Set();
  for (const { id, target } of jobs) {
    if (done.has(id)) continue;
    await session.pageCdp.send("Page.navigate", { url: `${origin}/renderer/index.html?type=canvas` });
    await session.waitFor("!!window.__wp", { timeoutMs: 60000 });
    let r;
    try {
      r = await session.evaluate(`(async () => {
        window.__wp.pause();
        const api = await import('/renderer/src/api/editor.ts');
        const host = document.createElement('div');
        host.style.cssText = 'position:fixed;left:0;top:0;width:960px;height:540px;z-index:9';
        document.body.appendChild(host);
        const inst = await api.mount(host, { source: api.httpSource('${origin}/media/dev/${id}'), fit: 'cover', renderDpr: 1, volume: 0, autoplay: false });
        const ed = api.editorOf(inst);
        inst.pause();
        const keep = ${JSON.stringify(target.chain)};
        const tid = keep[0];
        for (const l of ed.getLayers()) if (!keep.includes(l.id)) await ed.setLayerProps(l.id, { visible: false });
        for (const e of window.__scene.layers.find((l) => l.id === tid)?.effects || []) e.visible = false;
        const orig = ${JSON.stringify(target.layers)};
        const px = async (time) => {
          const cv = await ed.captureFrame({ time, width: 480, height: 270 });
          const t = document.createElement('canvas');
          t.width = cv.width; t.height = cv.height;
          const g = t.getContext('2d', { willReadFrequently: true });
          g.drawImage(cv, 0, 0);
          return g.getImageData(0, 0, t.width, t.height).data;
        };
        const diff = (a, b) => {
          let n = 0;
          for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) + Math.abs(a[i + 3] - b[i + 3]) > 24) n++;
          return n;
        };
        const T = 0.9;
        const A = await px(2 * T);
        const C = await px(T);
        const lists = ${JSON.stringify(target.lists)};
        for (const [lid, list] of Object.entries(lists)) await ed.setAnimationLayers(Number(lid), list.map((a) => ({ ...a, rate: a.rate * 2 })));
        const B = await px(T);
        for (const [lid, list] of Object.entries(lists)) await ed.setAnimationLayers(Number(lid), list);
        const A2 = await px(2 * T);
        await ed.setAnimationLayers(tid, orig.map((a) => ({ ...a, blend: 0 })));
        const Z = await px(2 * T);
        const Zt = await px(T);
        let rejected = '';
        await ed.setAnimationLayers(987654, orig).catch((e) => (rejected = String(e.message)));
        await ed.setLayerProps(tid, { visible: false });
        const H = await px(2 * T);
        const clocks = (window.__scene.layers.find((l) => l.id === tid)?.animationLayers || []).map((a) => (a.clock == null ? 'abs' : 'own'));
        const out = { onScreen: diff(A, H), clocks, still: diff(Z, Zt), ab: diff(A, B), ac: diff(A, C), aa: diff(A, A2), az: diff(A, Z), rejected, isModel: !!ed.getModelInfo(tid) };
        inst.destroy();
        return out;
      })()`, { awaitPromise: true, timeoutMs: 180000 });
    } catch (e) {
      check(false, `${id}: 挂载 / 出帧失败 ${String(e.message).slice(0, 160)}`);
      continue;
    }
    // 对照 t / 2t 画面相同（层的播放被脚本接管走自身时钟、或目标在画外）时判据无意义，跳过并打出来
    if (!r.isModel || r.ac < 200) {
      console.log(`  · ${id} #${target.id}: 模型${r.isModel ? "已" : "未"}装上，t / 2t 画面几乎相同（ac=${r.ac}，目标层可见像素 ${r.onScreen}，层时钟 ${r.clocks.join("/")}），跳过`);
      continue;
    }
    if (r.still > 30 && r.az > 200) {
      console.log(`  · ${id} #${target.id}: 全层 blend 0 时 t / 2t 仍差 ${r.still} px（效果 / 着色器等另有时间源），跳过`);
      continue;
    }
    done.add(id);
    tested++;
    check(
      r.ab <= 30 && r.aa <= 30 && r.az > 200,
      `${id} #${target.id}「${target.name}」${target.layers.length} 层：rate×2@t vs 原速@2t 差 ${r.ab} px；推回原表差 ${r.aa} px；blend 0 差 ${r.az} px；对照 t vs 2t 差 ${r.ac} px`,
    );
    check(/not found/.test(r.rejected), `${id}: 不存在的层 setAnimationLayers 被拒（${r.rejected.slice(0, 60)}）`);
  }
  check(tested >= 1, `至少 1 张夹具做了动画层热替换像素判据（${tested} 张）`);
}

const plainXform = (o) => ["origin", "scale", "angles"].every((f) => o[f] === undefined || typeof o[f] === "string");

/** W14 夹具：有动画 + 附着点、父链变换全是静态字面量的 puppet；根级、静态、可见的普通图片层当挂件 */
function attachCandidates(t) {
  const objs = t.scene?.objects ?? [];
  const byId = new Map(objs.map((o) => [String(o.id), o]));
  const chainPlain = (o) => {
    for (let c = o, n = 0; c && n < 64; c = byId.get(String(c.parent)), n++) if (!plainXform(c)) return false;
    return true;
  };
  const models = t.objects
    .filter((m) => m.info.form === "puppet" && m.info.attachments.length && m.info.animations.length && chainPlain(byId.get(String(m.id))))
    .map((m) => m.id);
  const layers = objs
    .filter((o) => (o.parent === undefined || o.parent === null) && typeof o.image === "string" && !t.puppets.has(o.image) && !o.attachment && o.visible !== false && plainXform(o))
    .filter((o) => !/"script"\s*:|"animation"\s*:\s*\{|"user"\s*:/.test(JSON.stringify({ ...o, effects: undefined })))
    .map((o) => o.id);
  return { models, layers };
}

/**
 * MC2（W14）：真引擎上走「页面纯函数改文档 → 散装来源重挂」，看挂件层的轮廓（getLayerOutline）：
 *   非绑定姿势的 T1 绑定 → 重挂后 T1 轮廓不变；T2 时层位移 ≡ 附着点屏幕位移（跟骨）；
 *   T2 解绑 → 重挂后 T2 轮廓不变，且之后不再随时间动。
 */
async function runAttachHeadless({ check, section, session, origin, fixtures, LIB }) {
  section("MC2. 附着点绑定（真浏览器）：绑定 / 解绑前后轮廓不变，绑定后跟骨");
  let tested = 0;
  for (const id of fixtures.filter((x) => PUPPET_FIXTURES.includes(x))) {
    const t = modelTruth(LIB, id);
    const cand = t && attachCandidates(t);
    if (!cand?.models.length || !cand.layers.length) continue;
    await session.pageCdp.send("Page.navigate", { url: `${origin}/renderer/index.html?type=canvas` });
    await session.waitFor("!!window.__wp", { timeoutMs: 60000 });
    let r;
    try {
      r = await session.evaluate(`(async () => {
        window.__wp.pause();
        const api = await import('/renderer/src/api/editor.ts');
        const C = await import('/renderer/vendor/we-scene/pkg/container.js');
        const D = await import('/editor/doc.ts');
        const M = await import('/editor/model.ts');
        const base = api.httpSource('${origin}/media/dev/${id}');
        const pkg = C.parsePkg(new Uint8Array(await base.scenePkg()));
        const sceneText = new TextDecoder().decode(C.getEntry(pkg, 'scene.json')).replace(/^\\uFEFF/, '');
        const host = document.createElement('div');
        host.style.cssText = 'position:fixed;left:0;top:0;width:960px;height:540px;z-index:9';
        document.body.appendChild(host);
        let inst = null, ed = null;
        const mountWith = async (json) => {
          if (inst) inst.destroy();
          host.textContent = '';
          const bytes = new TextEncoder().encode(json);
          const source = {
            scenePkg: () => base.scenePkg(),
            sceneDir: async () => ({ entry: 'scene.json', read: async (n) => (n === 'scene.json' ? bytes : C.getEntry(pkg, n) ?? null) }),
            project: base.project ? (s) => base.project(s) : undefined,
          };
          inst = await api.mount(host, { source, fit: 'cover', renderDpr: 1, volume: 0, autoplay: false });
          ed = api.editorOf(inst);
          inst.pause();
        };
        const T1 = 1.3;
        await mountWith(sceneText);
        const ptsAt = async (mid, tm) => { await ed.seek(tm); return ed.getAttachmentPoints(mid) || []; };
        let best = null;
        for (const mid of ${JSON.stringify(cand.models)}) {
          const a = await ptsAt(mid, T1);
          for (const t2 of [1.7, 2.1, 2.9, 3.7, 4.6]) {
            const b = await ptsAt(mid, t2);
            for (const p of a) {
              const q = b.find((x) => x.name === p.name);
              if (!p.screen || !q || !q.screen) continue;
              const mv = Math.hypot(q.screen[0] - p.screen[0], q.screen[1] - p.screen[1]);
              if (!best || mv > best.mv) best = { mid, name: p.name, mv, t2 };
            }
          }
        }
        const T2 = best ? best.t2 : 2.1;
        let lid = null;
        for (const c of ${JSON.stringify(cand.layers)}) {
          await ed.seek(T1);
          if (ed.getLayerOutline(c)?.corners) { lid = c; break; }
        }
        if (!best || lid === null) { inst.destroy(); return { skip: !best ? 'no moving attachment' : 'no layer outline' }; }
        const outline = async (tm) => { await ed.seek(tm); return ed.getLayerOutline(lid); };
        const dist = (a, b) => Math.max(...a.corners.map((c, i) => Math.hypot(c[0] - b.corners[i][0], c[1] - b.corners[i][1])), Math.hypot(a.anchor[0] - b.anchor[0], a.anchor[1] - b.anchor[1]));
        const o0 = await outline(T1);
        const o0b = await outline(T2);
        await ed.seek(T1);
        const offOf = (mid, name) => ed.getAttachmentPoints(Number(mid))?.find((p) => p.name === name)?.offset ?? null;
        const doc = D.makeDoc('x', null, JSON.parse(sceneText), 'loose');
        const r1 = M.attachToModel(doc, lid, best.mid, best.name, offOf);
        await mountWith(JSON.stringify(doc.scene));
        const o1 = await outline(T1);
        const p1 = (await ptsAt(best.mid, T1)).find((p) => p.name === best.name);
        const o2 = await outline(T2);
        const p2 = (await ptsAt(best.mid, T2)).find((p) => p.name === best.name);
        await ed.seek(T2);
        const r2 = M.detachFromModel(doc, lid, offOf);
        const attachedAfter = doc.scene.objects.find((o) => o.id === lid)?.attachment ?? null;
        await mountWith(JSON.stringify(doc.scene));
        const o3 = await outline(T2);
        const o4 = await outline(T1);
        inst.destroy();
        const lay = [o2.anchor[0] - o1.anchor[0], o2.anchor[1] - o1.anchor[1]];
        const att = [p2.screen[0] - p1.screen[0], p2.screen[1] - p1.screen[1]];
        return {
          lid, mid: best.mid, name: best.name, mv: best.mv, r1, r2, attachedAfter,
          staticBefore: dist(o0, o0b), bindJump: dist(o0, o1), follow: Math.hypot(lay[0] - att[0], lay[1] - att[1]), layMv: Math.hypot(lay[0], lay[1]),
          detachJump: dist(o2, o3), staticAfter: dist(o3, o4),
        };
      })()`, { awaitPromise: true, timeoutMs: 240000 });
    } catch (e) {
      check(false, `${id}: 绑定判据执行失败 ${String(e.message).slice(0, 200)}`);
      continue;
    }
    if (r.skip || r.mv < 3) {
      console.log(`  · ${id}: ${r.skip ?? `附着点 T1→T2 只动了 ${r.mv?.toFixed(2)} px`}，跳过`);
      continue;
    }
    tested++;
    const f = (v) => v.toFixed(2);
    check(
      r.r1 === "ok" && r.r2 === "ok" && r.attachedAfter === null && r.staticBefore <= 0.5 && r.bindJump <= 0.5 && r.follow <= 0.5 && r.layMv >= 3 && r.detachJump <= 0.5 && r.staticAfter <= 0.5,
      `${id}: #${r.lid} 挂到 #${r.mid}「${r.name}」（附着点 T1→T2 屏幕移动 ${f(r.mv)} px）：绑定前静止 ${f(r.staticBefore)}；★ 绑定跳变 ${f(r.bindJump)}；跟骨误差 ${f(r.follow)}（层移动 ${f(r.layMv)}）；★ 解绑跳变 ${f(r.detachJump)}；解绑后静止 ${f(r.staticAfter)} px（${r.r1}/${r.r2}）`,
    );
  }
  check(tested >= 2, `至少 2 张夹具做了附着点绑定真引擎判据（${tested} 张）`);
}

/**
 * MD2（W15）：蒙皮网格拾取 / 轮廓的 GPU 像素真值。只留模型层（与其祖先）可见，出两帧
 * （模型显示 / 隐藏）做差 = 该模型实际画出的像素。判据：
 *   ① 像素 ⊆ 凸包（容差 1.5 px）；真 3D 网格的凸包外接框 vs 像素外接框 ≤ 3 px（含透视场景）
 *   ② 画出来的像素点 hitTestAt 命中该层；图层矩形内、凸包外 3 px 的点不命中
 *   ③ 两个时刻姿势不同（凸包变了），①② 在两个时刻都成立
 */
async function runPickHeadless({ check, section, session, origin, fixtures }) {
  section("MD2. 蒙皮网格拾取 / 轮廓（真浏览器）：GPU 像素 ⊆ 凸包，像素点命中，矩形内凸包外不命中");
  let tested = 0;
  let totalMoved = 0;
  for (const id of fixtures) {
    await session.pageCdp.send("Page.navigate", { url: `${origin}/renderer/index.html?type=canvas` });
    await session.waitFor("!!window.__wp", { timeoutMs: 60000 });
    let r;
    try {
      r = await session.evaluate(`(async () => {
        window.__wp.pause();
        const api = await import('/renderer/src/api/editor.ts');
        const host = document.createElement('div');
        host.style.cssText = 'position:fixed;left:0;top:0;width:960px;height:540px;z-index:9';
        document.body.appendChild(host);
        const inst = await api.mount(host, { source: api.httpSource('${origin}/media/dev/${id}'), fit: 'cover', renderDpr: 1, volume: 0, autoplay: false });
        const ed = api.editorOf(inst);
        inst.pause();
        // 整屏 bloom 会把像素晕出几何几十 px（3477054430 strength 10）—— 真值只要几何本身
        const gen = window.__scene?.general || {};
        const bloom = gen.bloom === true || gen.bloom?.value === true;
        gen.bloom = false;
        const layers = ed.getLayers();
        const byId = new Map(layers.map((l) => [l.id, l]));
        const own0 = new Map(layers.map((l) => [l.id, ed.getLayerProps(l.id)?.visible ?? true]));
        const grab = async () => {
          const bm = await createImageBitmap(await ed.capture());
          const cv = new OffscreenCanvas(bm.width, bm.height);
          const g = cv.getContext('2d');
          g.drawImage(bm, 0, 0);
          return { w: bm.width, h: bm.height, d: g.getImageData(0, 0, bm.width, bm.height).data };
        };
        const inside = (P, x, y) => {
          let s = 0;
          for (let i = 0; i < P.length; i++) {
            const a = P[i], b = P[(i + 1) % P.length];
            const c = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
            if (c === 0) continue;
            const t = c > 0 ? 1 : -1;
            if (!s) s = t; else if (t !== s) return false;
          }
          return true;
        };
        const segDist = (a, b, x, y) => {
          const dx = b[0] - a[0], dy = b[1] - a[1];
          const L = dx * dx + dy * dy;
          const t = L ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L)) : 0;
          return Math.hypot(a[0] + t * dx - x, a[1] + t * dy - y);
        };
        // 有符号：凸包外为正
        const outDist = (P, x, y) => {
          let m = Infinity;
          for (let i = 0; i < P.length; i++) m = Math.min(m, segDist(P[i], P[(i + 1) % P.length], x, y));
          return inside(P, x, y) ? -m : m;
        };
        const ancestors = (lid) => { const s = new Set(); for (let p = byId.get(lid)?.parentId; p !== null && p !== undefined && !s.has(p); p = byId.get(p)?.parentId) s.add(p); return s; };
        const models = layers.filter((l) => l.kind === 'model' && l.visible);
        const out = [];
        for (const m of models.slice(0, 8)) {
          // 只留自己与祖先；子孙也显式隐藏（否则隐藏自己时子孙一起消失，像素差会把它们算进来）
          const keep = ancestors(m.id); keep.add(m.id);
          for (const l of layers) if (!keep.has(l.id) && own0.get(l.id)) await ed.setLayerProps(l.id, { visible: false });
          const per = [];
          for (const T of [1.3, 3.1]) {
            await ed.seek(T);
            const A = await grab();
            const o = ed.getLayerOutline(m.id);
            await ed.setLayerProps(m.id, { visible: false });
            const B = await grab();
            await ed.setLayerProps(m.id, { visible: true });
            await ed.seek(T);
            if (!o || !o.hull) {
              let n = 0, bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
              for (let y = 0; y < A.h; y++) for (let x = 0; x < A.w; x++) {
                const i = (y * A.w + x) * 4;
                if (Math.abs(A.d[i] - B.d[i]) + Math.abs(A.d[i + 1] - B.d[i + 1]) + Math.abs(A.d[i + 2] - B.d[i + 2]) <= 24) continue;
                n++; bx0 = Math.min(bx0, x); by0 = Math.min(by0, y); bx1 = Math.max(bx1, x + 1); by1 = Math.max(by1, y + 1);
              }
              per.push({ T, noHull: true, corners: !!o?.corners, n, pb: n ? [bx0, by0, bx1, by1] : null });
              continue;
            }
            const H = o.hull;
            const px = [];
            let outside = 0, maxOut = 0;
            let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
            for (let y = 0; y < A.h; y++) for (let x = 0; x < A.w; x++) {
              const i = (y * A.w + x) * 4;
              const diff = Math.abs(A.d[i] - B.d[i]) + Math.abs(A.d[i + 1] - B.d[i + 1]) + Math.abs(A.d[i + 2] - B.d[i + 2]);
              if (diff <= 24) continue;
              const d = outDist(H, x + 0.5, y + 0.5);
              if (d > 1.5) { outside++; maxOut = Math.max(maxOut, d); }
              px.push(x, y);
              bx0 = Math.min(bx0, x); by0 = Math.min(by0, y); bx1 = Math.max(bx1, x + 1); by1 = Math.max(by1, y + 1);
            }
            const n = px.length / 2;
            const hb = [Math.min(...H.map((p) => p[0])), Math.min(...H.map((p) => p[1])), Math.max(...H.map((p) => p[0])), Math.max(...H.map((p) => p[1]))];
            const vis = (x, y) => x >= 0 && y >= 0 && x <= A.w && y <= A.h;
            // 外接框只比落在画布内的边（凸包伸出画布的那侧没有像素可比）
            const bbox = n ? [hb[0] > 0 ? Math.abs(hb[0] - bx0) : 0, hb[1] > 0 ? Math.abs(hb[1] - by0) : 0, hb[2] < A.w ? Math.abs(hb[2] - bx1) : 0, hb[3] < A.h ? Math.abs(hb[3] - by1) : 0] : null;
            const hitOf = (x, y) => ed.hitTestAt(x, y, { includeHidden: true }).some((h) => h.id === m.id);
            let posN = 0, posHit = 0;
            const step = Math.max(1, Math.floor(n / 150));
            for (let k = 0; k < n; k += step) {
              const x = px[k * 2] + 0.5, y = px[k * 2 + 1] + 0.5;
              if (outDist(H, x, y) > -1) continue;
              posN++; if (hitOf(x, y)) posHit++;
            }
            let negN = 0, negHit = 0;
            const C = o.corners;
            const box = C ? [Math.min(...C.map((p) => p[0])), Math.min(...C.map((p) => p[1])), Math.max(...C.map((p) => p[0])), Math.max(...C.map((p) => p[1]))] : [hb[0] - 30, hb[1] - 30, hb[2] + 30, hb[3] + 30];
            for (let gy = 0; gy < 24; gy++) for (let gx = 0; gx < 24; gx++) {
              const x = box[0] + ((gx + 0.5) / 24) * (box[2] - box[0]);
              const y = box[1] + ((gy + 0.5) / 24) * (box[3] - box[1]);
              if (!vis(x, y) || (C && !inside(C, x, y)) || outDist(H, x, y) < 3) continue;
              negN++; if (hitOf(x, y)) negHit++;
            }
            per.push({ T, n, outside, maxOut, bbox, posN, posHit, negN, negHit, hull: H.length, hb });
          }
          for (const l of layers) if (!keep.has(l.id) && own0.get(l.id)) await ed.setLayerProps(l.id, { visible: true });
          out.push({ id: m.id, name: m.name, form: m.modelForm, per });
        }
        inst.destroy();
        return { models: out, bloom };
      })()`, { awaitPromise: true, timeoutMs: 600000 });
    } catch (e) {
      check(false, `${id}: 拾取判据执行失败 ${String(e.message).slice(0, 200)}`);
      continue;
    }
    const f = (v) => v.toFixed(2);
    let drawn = 0;
    let moved = 0;
    for (const m of r.models) {
      const lines = [];
      const bad = [];
      for (const p of m.per) {
        // 当前时刻一个像素都没画（透明根 puppet / 跑到相机身后的星体）：没有像素真值，跳过
        if (!p.n) continue;
        drawn++;
        if (p.noHull) { bad.push(`T=${p.T} 画了 ${p.n} px 却没有凸包`); continue; }
        const bboxMax = Math.max(...p.bbox);
        if (p.outside > p.n * 0.001) bad.push(`T=${p.T} ${p.outside}/${p.n} px 在凸包外（最远 ${f(p.maxOut)}）`);
        if (p.posHit !== p.posN) bad.push(`T=${p.T} 像素点命中 ${p.posHit}/${p.posN}`);
        if (p.negHit) bad.push(`T=${p.T} 凸包外命中 ${p.negHit}/${p.negN}`);
        // 真 3D 贴图不透明，外接框应贴合像素；puppet 的图集在网格边缘常是透明的，只要求包住
        if (m.form === "mesh" && bboxMax > 3) bad.push(`T=${p.T} 外接框差 ${f(bboxMax)} px`);
        lines.push(`T=${p.T} ${p.n}px 外${p.outside} 框${f(bboxMax)} 中${p.posHit}/${p.posN} 外点${p.negHit}/${p.negN}`);
      }
      const [a, b] = m.per;
      if (a?.hb && b?.hb && a.n && b.n && Math.max(...a.hb.map((v, i) => Math.abs(v - b.hb[i]))) >= 3) moved++;
      if (!lines.length && !bad.length) continue;
      check(!bad.length, `${id} #${m.id} ${m.name}（${m.form}）：${bad.length ? bad.join("；") : lines.join(" | ")}`);
    }
    if (drawn) tested++;
    if (moved) console.log(`  · ${id}: ${moved} 个模型层 T1→T2 凸包移动 ≥ 3 px（姿势在变，两个时刻判据都成立）`);
    totalMoved += moved;
  }
  check(tested >= 5, `至少 5 张夹具有可比的模型像素（${tested} 张，bloom 已关）`);
  check(totalMoved >= 3, `至少 3 个模型层两个时刻的凸包不同 —— 动画中拾取仍对（${totalMoved} 个）`);
}

/**
 * ME2（W16）：子网格贴图替换的真引擎判据。只留目标模型（与祖先）可见、bloom 关，换成纯色图后重挂：
 *   ① 几何不变：模型画出的像素外接框前后差 ≤ 3 px，像素变化全落在前后画出区域内
 *   ② 贴图真换上：getModelInfo 该子网格贴图 = editor/<slug>、其余子网格不变；画出区域内大面积变色
 *   ③ 存库闭环：叠加层文件 + 原包 → buildScenePkg（png 转 .tex）→ 从包重挂，画面与松散形态一致
 */
async function runRetexHeadless({ check, section, session, origin, fixtures }) {
  section("ME2. 子网格贴图替换（真浏览器）：几何不变、贴图换上、打包重挂一致");
  let tested = 0;
  let multi = 0;
  for (const id of fixtures) {
    await session.pageCdp.send("Page.navigate", { url: `${origin}/renderer/index.html?type=canvas` });
    await session.waitFor("!!window.__wp", { timeoutMs: 60000 });
    let r;
    try {
      r = await session.evaluate(`(async () => {
        window.__wp.pause();
        const api = await import('/renderer/src/api/editor.ts');
        const C = await import('/renderer/vendor/we-scene/pkg/container.js');
        const TX = await import('/renderer/vendor/we-scene/pkg/texture.js');
        const M = await import('/editor/model.ts');
        const base = api.httpSource('${origin}/media/dev/${id}');
        const pkg = C.parsePkg(new Uint8Array(await base.scenePkg()));
        const sceneText = new TextDecoder().decode(C.getEntry(pkg, 'scene.json')).replace(/^\\uFEFF/, '');
        const extra = new Map();
        let sceneBytes = new TextEncoder().encode(sceneText);
        const read = async (n) => (n === 'scene.json' ? sceneBytes : extra.get(n) ?? C.getEntry(pkg, n) ?? null);
        const host = document.createElement('div');
        host.style.cssText = 'position:fixed;left:0;top:0;width:960px;height:540px;z-index:9';
        document.body.appendChild(host);
        let inst = null, ed = null;
        const mountWith = async (source) => {
          if (inst) inst.destroy();
          host.textContent = '';
          inst = await api.mount(host, { source, fit: 'cover', renderDpr: 1, volume: 0, autoplay: false });
          ed = api.editorOf(inst);
          inst.pause();
          const gen = window.__scene?.general;
          if (gen) gen.bloom = false;
        };
        const loose = () => ({ scenePkg: () => base.scenePkg(), sceneDir: async () => ({ entry: 'scene.json', read }), project: base.project ? (s) => base.project(s) : undefined });
        const grab = async () => {
          const bm = await createImageBitmap(await ed.capture());
          const cv = new OffscreenCanvas(bm.width, bm.height);
          const g = cv.getContext('2d');
          g.drawImage(bm, 0, 0);
          return { w: bm.width, h: bm.height, d: g.getImageData(0, 0, bm.width, bm.height).data };
        };
        const T = 1.3;
        // 只留 mid 与祖先，出「显示 / 隐藏 mid」两帧
        const shots = async (mid) => {
          const layers = ed.getLayers();
          const byId = new Map(layers.map((l) => [l.id, l]));
          const keep = new Set([mid]);
          for (let p = byId.get(mid)?.parentId; p !== null && p !== undefined && !keep.has(p); p = byId.get(p)?.parentId) keep.add(p);
          const hidden = [];
          for (const l of layers) if (!keep.has(l.id) && (ed.getLayerProps(l.id)?.visible ?? true)) { hidden.push(l.id); await ed.setLayerProps(l.id, { visible: false }); }
          await ed.seek(T);
          const A = await grab();
          const hull = ed.getLayerOutline(mid)?.hull ?? null;
          await ed.setLayerProps(mid, { visible: false });
          const B = await grab();
          await ed.setLayerProps(mid, { visible: true });
          for (const lid of hidden) await ed.setLayerProps(lid, { visible: true });
          return { A, B, hull };
        };
        const inHull = (P, x, y, tol) => {
          let s = 0, minD = Infinity;
          for (let i = 0; i < P.length; i++) {
            const a = P[i], b = P[(i + 1) % P.length];
            const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
            const c = (dx * (y - a[1]) - dy * (x - a[0])) / L;
            if (!s && c) s = Math.sign(c);
            minD = Math.min(minD, c * (s || 1));
          }
          return minD >= -tol;
        };
        const df = (P, Q, i) => Math.abs(P.d[i] - Q.d[i]) + Math.abs(P.d[i + 1] - Q.d[i + 1]) + Math.abs(P.d[i + 2] - Q.d[i + 2]);
        const mask = (s) => { const m = new Uint8Array(s.A.w * s.A.h); let n = 0; for (let k = 0; k < m.length; k++) if (df(s.A, s.B, k * 4) > 24) { m[k] = 1; n++; } return { m, n }; };
        const solidPng = async (w, h) => { const cv = new OffscreenCanvas(w, h); const g = cv.getContext('2d'); g.fillStyle = '#ff00ff'; g.fillRect(0, 0, w, h); return new Uint8Array(await (await cv.convertToBlob({ type: 'image/png' })).arrayBuffer()); };

        await mountWith(loose());
        const scene = JSON.parse(sceneText);
        // 多子网格模型优先（要测「只换非首个子网格」）
        const cands = ed.getLayers().filter((l) => l.kind === 'model' && l.visible)
          .map((l) => ({ l, n: ed.getModelInfo(l.id)?.meshes.length ?? 0 }))
          .sort((a, b) => b.n - a.n).map((x) => x.l).slice(0, 6);
        for (const m of cands) {
          const s0 = await shots(m.id);
          const k0 = mask(s0);
          if (k0.n < 200) continue;
          const info = ed.getModelInfo(m.id);
          let mesh = 0;
          if (info.form === 'mesh' && info.meshes.length > 1) {
            let best = -1;
            info.meshes.forEach((me, i) => { if (i > 0 && me.texture && (best < 0 || me.vertexCount > info.meshes[best].vertexCount)) best = i; });
            if (best > 0) mesh = best;
          }
          let w = 256, h = 256;
          const tn = info.meshes[mesh]?.texture;
          const texBytes = tn ? C.getEntry(pkg, 'materials/' + tn + '.tex') : null;
          if (texBytes) { try { const p = TX.parseTex(texBytes); if (p.width > 0 && p.height > 0) { w = p.width; h = p.height; } } catch {} }
          const img = { name: 'mt.png', bytes: await solidPng(w, h), ext: 'png', width: w, height: h };
          const obj = scene.objects.find((o) => o.id === m.id);
          let res = null;
          if (info.form === 'puppet') {
            const mj = M.parseJsonBytes(await read(obj.image));
            const mat = mj && M.parseJsonBytes(await read(String(mj.material)));
            res = mj && mat && M.puppetRetexture(mj, mat, 'mt', img);
            if (res) obj.image = res.path;
          } else {
            const bytes = await read(obj.model);
            const mp = bytes && M.meshMaterialPath(bytes, mesh);
            const mat = mp && M.parseJsonBytes(await read(mp));
            res = mat && M.meshRetexture(bytes, mesh, mat, 'mt', img);
            if (res) obj.model = res.path;
          }
          if (!res) { inst.destroy(); return { fail: 'retexture null', mid: m.id, form: info.form }; }
          for (const f of res.files) extra.set(f.name, f.data);
          sceneBytes = new TextEncoder().encode(JSON.stringify(scene));
          await mountWith(loose());
          const info2 = ed.getModelInfo(m.id);
          const s1 = await shots(m.id);
          const k1 = mask(s1);
          const W = s0.A.w;
          let changedIn = 0, changedOut = 0;
          for (let k = 0; k < k0.m.length; k++) {
            if (df(s0.A, s1.A, k * 4) <= 24) continue;
            if (k0.m[k] || k1.m[k]) changedIn++; else changedOut++;
          }
          let recolored = 0;
          for (let k = 0; k < k0.m.length; k++) if (k0.m[k] && df(s0.A, s1.A, k * 4) > 24) recolored++;
          // 新图不透明处可能比原图集多画（原图边缘透明）—— 几何不变看凸包：前后凸包一致，新像素全在凸包内
          const hullDiff = s0.hull && s1.hull && s0.hull.length === s1.hull.length ? Math.max(...s0.hull.map((p, i) => Math.hypot(p[0] - s1.hull[i][0], p[1] - s1.hull[i][1]))) : Infinity;
          let outHull = 0;
          if (s1.hull) for (let k = 0; k < k1.m.length; k++) if (k1.m[k] && !inHull(s1.hull, (k % W) + 0.5, ((k / W) | 0) + 0.5, 1.5)) outHull++;
          // 存库闭环：原包条目（scene.json 换新）∪ 叠加层 → scene.pkg → 从包重挂
          const files = [];
          for (const e of pkg.entries ?? []) if (e.name !== 'scene.json' && !extra.has(e.name)) files.push({ path: e.name, data: C.getEntry(pkg, e.name) });
          files.push({ path: 'scene.json', data: sceneBytes });
          for (const [n, d] of extra) files.push({ path: n, data: d });
          const built = api.buildScenePkg(files);
          await mountWith(api.bytesSource(built.pkg, base.project ? await base.project() : undefined));
          const info3 = ed.getModelInfo(m.id);
          const s2 = await shots(m.id);
          // 只比模型画出的区域（祖先层 / 场景其余部分的逐次挂载差异与换贴图无关）
          const k2 = mask(s2);
          let pkgDiff = 0;
          for (let k = 0; k < k0.m.length; k++) if ((k1.m[k] || k2.m[k]) && df(s1.A, s2.A, k * 4) > 24) pkgDiff++;
          inst.destroy();
          return {
            mid: m.id, name: m.name, form: info.form, mesh, meshes: info.meshes.length, w, h,
            n0: k0.n, n1: k1.n, changedIn, changedOut, recolored,
            hullDiff, outHull,
            tex: info2?.meshes.map((x) => x.texture) ?? null, tex0: info.meshes.map((x) => x.texture),
            tex3: info3?.meshes.map((x) => x.texture) ?? null,
            converted: built.converted, pkgDiff,
          };
        }
        inst.destroy();
        return { skip: 'no drawn model' };
      })()`, { awaitPromise: true, timeoutMs: 600000 });
    } catch (e) {
      check(false, `${id}: 换贴图判据执行失败 ${String(e.message).slice(0, 200)}`);
      continue;
    }
    if (r.skip) {
      console.log(`  · ${id}: ${r.skip}，跳过`);
      continue;
    }
    if (r.fail) {
      check(false, `${id} #${r.mid}（${r.form}）：${r.fail}`);
      continue;
    }
    tested++;
    if (r.meshes > 1 && r.mesh > 0) multi++;
    const texOk = r.tex && r.tex.every((t, i) => (i === r.mesh ? t === "editor/mt" : t === r.tex0[i])) && JSON.stringify(r.tex3) === JSON.stringify(r.tex);
    const minRecolor = r.mesh > 0 ? 50 : r.n0 * 0.5;
    // 换非首个子网格：其余子网格画出的像素必须原样（有一部分不变色）
    check(
      texOk && (r.mesh === 0 || r.recolored < r.n0) && r.hullDiff <= 0.5 && r.outHull <= r.n1 * 0.001 && r.changedOut <= r.n0 * 0.001 && r.recolored >= minRecolor && r.converted.includes("materials/editor/mt.tex") && r.pkgDiff <= r.n1 * 0.002,
      `${id} #${r.mid} ${r.name}（${r.form}，子网格 ${r.mesh}/${r.meshes}，图 ${r.w}×${r.h}）：贴图 ${texOk ? "已换上、其余不变" : JSON.stringify(r.tex)}；凸包差 ${r.hullDiff === Infinity ? "∞" : r.hullDiff.toFixed(2)} px、新像素出凸包 ${r.outHull}/${r.n1}；` +
        `变色 ${r.recolored}/${r.n0} px，区域外变化 ${r.changedOut}；打包重挂差 ${r.pkgDiff} px（${r.converted.join(",") || "未转 .tex"}）`,
    );
  }
  check(tested >= 4 && multi >= 1, `至少 4 张夹具做了换贴图真引擎判据，含 1 个多子网格模型换非首个子网格（${tested} 张 / 多子网格 ${multi}）`);
}

/**
 * MF2（W18a）：骨骼姿势编辑的真引擎判据。目标 = 动画层无包装、父链不随时间变的模型层，只留它与祖先可见：
 *   ① 预览：setBonePose 绕骨 z 转 30° → 画面变；该骨自身与子树外的骨屏幕位置不动，子树里有骨移动；撤掉预览逐像素复原
 *   ② 应用：applyBoneDelta（半径 0）写回 .mdl 重挂 → 在该帧 ≡ 预览画面（单层 blend 1 时）、远帧 ≡ 原画面
 *   ③ 存库闭环：buildScenePkg → 从包重挂，该帧画面与松散形态一致
 */
async function runBoneHeadless({ check, section, session, origin, fixtures, LIB }) {
  section("MF2. 骨骼姿势编辑（真浏览器）：预览只动子树、撤销复原、写回 .mdl ≡ 预览、远帧不变、打包一致");
  let tested = 0;
  let exactN = 0;
  for (const id of fixtures) {
    const targets = hotAnimTargets(modelTruth(LIB, id)?.scene).slice(0, 4);
    if (!targets.length) continue;
    await session.pageCdp.send("Page.navigate", { url: `${origin}/renderer/index.html?type=canvas` });
    await session.waitFor("!!window.__wp", { timeoutMs: 60000 });
    let r;
    try {
      r = await session.evaluate(`(async () => {
        window.__wp.pause();
        const api = await import('/renderer/src/api/editor.ts');
        const C = await import('/renderer/vendor/we-scene/pkg/container.js');
        const M = await import('/editor/model.ts');
        const base = api.httpSource('${origin}/media/dev/${id}');
        const pkg = C.parsePkg(new Uint8Array(await base.scenePkg()));
        const sceneText = new TextDecoder().decode(C.getEntry(pkg, 'scene.json')).replace(/^\\uFEFF/, '');
        const extra = new Map();
        let sceneBytes = new TextEncoder().encode(sceneText);
        const read = async (n) => (n === 'scene.json' ? sceneBytes : extra.get(n) ?? C.getEntry(pkg, n) ?? null);
        const host = document.createElement('div');
        host.style.cssText = 'position:fixed;left:0;top:0;width:960px;height:540px;z-index:9';
        document.body.appendChild(host);
        let inst = null, ed = null;
        const mountWith = async (source) => {
          if (inst) inst.destroy();
          host.textContent = '';
          inst = await api.mount(host, { source, fit: 'cover', renderDpr: 1, volume: 0, autoplay: false });
          ed = api.editorOf(inst);
          inst.pause();
          const gen = window.__scene?.general;
          if (gen) gen.bloom = false;
        };
        const loose = () => ({ scenePkg: () => base.scenePkg(), sceneDir: async () => ({ entry: 'scene.json', read }), project: base.project ? (s) => base.project(s) : undefined });
        const grab = async () => {
          const bm = await createImageBitmap(await ed.capture());
          const cv = new OffscreenCanvas(bm.width, bm.height);
          const g = cv.getContext('2d');
          g.drawImage(bm, 0, 0);
          return { w: bm.width, h: bm.height, d: g.getImageData(0, 0, bm.width, bm.height).data };
        };
        const df = (P, Q, i) => Math.abs(P.d[i] - Q.d[i]) + Math.abs(P.d[i + 1] - Q.d[i + 1]) + Math.abs(P.d[i + 2] - Q.d[i + 2]);
        const diffN = (P, Q, region) => { let n = 0; for (let k = 0; k < P.w * P.h; k++) if ((!region || region[k]) && df(P, Q, k * 4) > 24) n++; return n; };
        const isolate = async (keep) => {
          for (const l of ed.getLayers()) if (!keep.includes(l.id)) await ed.setLayerProps(l.id, { visible: false });
        };
        const drawnMask = async (mid, t) => {
          await ed.seek(t);
          const A = await grab();
          await ed.setLayerProps(mid, { visible: false });
          const B = await grab();
          await ed.setLayerProps(mid, { visible: true });
          const m = new Uint8Array(A.w * A.h); let n = 0;
          for (let k = 0; k < m.length; k++) if (df(A, B, k * 4) > 24) { m[k] = 1; n++; }
          return { A, m, n };
        };
        const at = async (t) => { await ed.seek(t); return grab(); };
        const targets = ${JSON.stringify(targets)};
        await mountWith(loose());
        const scene = JSON.parse(sceneText);
        for (const tg of targets) {
          const mid = tg.id;
          const info = ed.getModelInfo(mid);
          if (!info || !info.bones.length) continue;
          const vis = tg.layers.filter((a) => a.visible !== false);
          const lay = vis[0];
          const clip = lay && info.animations.find((c) => c.id === lay.animation && c.frames > 4);
          if (!clip) continue;
          const rate = typeof lay.rate === 'number' && lay.rate > 0 ? lay.rate : 1;
          // 单层 blend 1：非 additive 直接取轨道，additive 取相对参考帧（loop 首帧）的增量 —— 编辑中间帧时两者都 ≡ 预览
          const exact = vis.length === 1 && (lay.blend ?? 1) === 1;
          const frame = Math.floor(clip.frames / 2);
          const far = frame - Math.max(2, Math.floor(clip.frames / 4));
          const Tf = (frame + 1e-4) / (clip.fps * rate);
          const Tfar = (far + 1e-4) / (clip.fps * rate);
          await mountWith(loose());
          await isolate(tg.chain);
          const s0 = await drawnMask(mid, Tf);
          if (s0.n < 200) continue;
          const far0 = await at(Tfar);
          await ed.seek(Tf);
          await ed.seek(Tf * 0.37);
          const farNoise = diffN(far0, await at(Tfar));
          await ed.seek(Tf);
          const pts0 = ed.getBonePoints(mid);
          const depth = M.boneDepths(info.bones);
          const kids = (b) => { const s = new Set([b]); let grew = true; while (grew) { grew = false; info.bones.forEach((x, i) => { if (!s.has(i) && s.has(x.parent)) { s.add(i); grew = true; } }); } return s; };
          const order = info.bones.map((_, i) => i).filter((i) => pts0?.[i]?.screen).sort((a, b) => (depth[a] >= 1 ? 0 : 1) - (depth[b] >= 1 ? 0 : 1) || kids(b).size - kids(a).size);
          const delta = { r: [0, 0, Math.PI / 6] };
          for (const bone of order.slice(0, 6)) {
            const obj = scene.objects.find((o) => o.id === mid);
            let res = null;
            const edit = { animId: clip.id, bone, frame, delta, radius: 0 };
            if (info.form === 'puppet') {
              const mj = M.parseJsonBytes(await read(obj.image));
              res = mj && M.boneEditFiles(mj, await read(String(mj.puppet)), 'bp', edit);
            } else res = M.boneEditFiles(null, await read(obj.model), 'bp', edit);
            if (!res) continue;
            await ed.setBonePose(mid, bone, delta);
            const P1 = await at(Tf);
            const pts1 = ed.getBonePoints(mid);
            const changed = diffN(s0.A, P1);
            if (changed < 50) { await ed.setBonePose(mid, bone, null); continue; }
            const sub = kids(bone);
            let outMoved = 0, inMoved = 0, selfMove = 0;
            pts0.forEach((p, i) => {
              const q = pts1[i];
              if (!p.screen || !q?.screen) return;
              const d = Math.hypot(p.screen[0] - q.screen[0], p.screen[1] - q.screen[1]);
              if (i === bone) selfMove = d;
              else if (sub.has(i)) { if (d > 1) inMoved++; }
              else if (d > 0.5) outMoved++;
            });
            await ed.setBonePose(mid, bone, null);
            const R = await at(Tf);
            const restored = diffN(s0.A, R);
            let rejected = 0;
            await ed.setBonePose(mid, info.bones.length, delta).catch(() => rejected++);
            await ed.setBonePose(987654, 0, delta).catch(() => rejected++);
            // 同一工程原样重挂一次：跨挂载本身的差异（有状态的模拟等）作为远帧判据的底噪
            await mountWith(loose());
            await isolate(tg.chain);
            await ed.seek(Tf);
            const remountNoise = diffN(far0, await at(Tfar));
            // 写回 .mdl 重挂
            const prevImage = obj.image, prevModel = obj.model;
            if (info.form === 'puppet') obj.image = res.path; else obj.model = res.path;
            for (const f of res.files) extra.set(f.name, f.data);
            sceneBytes = new TextEncoder().encode(JSON.stringify(scene));
            await mountWith(loose());
            await isolate(tg.chain);
            const E1 = await at(Tf);
            const Efar = await at(Tfar);
            const files = [];
            for (const e of pkg.entries ?? []) if (e.name !== 'scene.json' && !extra.has(e.name)) files.push({ path: e.name, data: C.getEntry(pkg, e.name) });
            files.push({ path: 'scene.json', data: sceneBytes });
            for (const [n, d] of extra) files.push({ path: n, data: d });
            const built = api.buildScenePkg(files);
            await mountWith(api.bytesSource(built.pkg, base.project ? await base.project() : undefined));
            await isolate(tg.chain);
            const K1 = await at(Tf);
            inst.destroy();
            obj.image = prevImage; obj.model = prevModel;
            return {
              layers: tg.layers,
              mid, name: tg.name, form: info.form, bone, boneName: info.bones[bone].name, clip: clip.name, mode: clip.mode, frame, far, exact, subtree: sub.size,
              n0: s0.n, changed, outMoved, inMoved, selfMove, restored, rejected,
              commitVsPreview: diffN(P1, E1), commitVsOrig: diffN(s0.A, E1), farDiff: diffN(far0, Efar), farNoise, remountNoise, pkgDiff: diffN(E1, K1),
            };
          }
        }
        if (inst) inst.destroy();
        return { skip: 'no posable model' };
      })()`, { awaitPromise: true, timeoutMs: 600000 });
    } catch (e) {
      check(false, `${id}: 骨骼编辑判据执行失败 ${String(e.message).slice(0, 200)}`);
      continue;
    }
    if (r.skip) {
      console.log(`  · ${id}: ${r.skip}，跳过`);
      continue;
    }
    tested++;
    if (r.exact) exactN++;
    if (process.env.VEM_DEBUG) console.log(JSON.stringify(r));
    const tol = Math.max(30, r.n0 * 0.002);
    const subtreeOk = r.subtree > 1 ? r.inMoved >= 1 : true;
    check(
      r.changed >= 50 && r.outMoved === 0 && r.selfMove <= 0.5 && subtreeOk && r.restored <= tol && r.rejected === 2,
      `${id} #${r.mid} ${r.name}（${r.form}）骨「${r.boneName}」#${r.bone}（子树 ${r.subtree}）z 转 30°：画面变 ${r.changed} px；子树外骨移动 ${r.outMoved}、自身 ${r.selfMove.toFixed(2)} px、子树内移动 ${r.inMoved}；撤掉预览差 ${r.restored} px；越界拒绝 ${r.rejected}/2`,
    );
    check(
      (r.exact ? r.commitVsPreview <= tol : r.commitVsOrig >= 50) && r.farDiff <= r.remountNoise + tol && r.pkgDiff <= tol,
      `${id} 写回片段「${r.clip}」（${r.mode}）第 ${r.frame} 帧：${r.exact ? `重挂 vs 预览差 ${r.commitVsPreview} px` : `多层混合，重挂 vs 原画面差 ${r.commitVsOrig} px`}；远帧 ${r.far} 差 ${r.farDiff} px（原样重挂底噪 ${r.remountNoise}）；打包重挂差 ${r.pkgDiff} px`,
    );
  }
  check(tested >= 2 && exactN >= 1, `至少 2 张夹具做了骨骼编辑真引擎判据，含 1 个单层 blend 1（写回 ≡ 预览）（${tested} 张 / 单层 ${exactN}）`);
}

/**
 * MG2（W18b）：片段编辑的真引擎判据。目标同 MF2（动画层无包装），只留它与祖先可见：
 *   ① 复制正在播的片段（同帧数）并把动画层指过去 → 任意时刻 ≡ 原画面
 *   ② 正在播的片段 fps ×2（单层时）→ t 时刻 ≡ 原画面 2t
 *   ③ 新建静止姿势片段并把动画层指过去（单层非 additive、播的是首片段时）→ 任意时刻 ≡ 原画面 0 时刻
 *   ④ 删掉末个片段后 getModelInfo 片段数 −1；写帧事件后 getModelInfo 读回；全部改动打包重挂 ≡ 松散形态
 */
async function runClipHeadless({ check, section, session, origin, fixtures, LIB }) {
  section("MG2. 动画片段编辑（真浏览器）：复制 ≡ 原片段、fps×2@t ≡ 原@2t、静止片段 ≡ 0 时刻、删 / 事件读回、打包一致");
  let tested = 0;
  let single = 0;
  let fpsLive = 0;
  let restLive = 0;
  for (const id of fixtures) {
    const targets = hotAnimTargets(modelTruth(LIB, id)?.scene).slice(0, 4);
    if (!targets.length) continue;
    await session.pageCdp.send("Page.navigate", { url: `${origin}/renderer/index.html?type=canvas` });
    await session.waitFor("!!window.__wp", { timeoutMs: 60000 });
    let r;
    try {
      r = await session.evaluate(`(async () => {
        window.__wp.pause();
        const api = await import('/renderer/src/api/editor.ts');
        const C = await import('/renderer/vendor/we-scene/pkg/container.js');
        const M = await import('/editor/model.ts');
        const base = api.httpSource('${origin}/media/dev/${id}');
        const pkg = C.parsePkg(new Uint8Array(await base.scenePkg()));
        const sceneText = new TextDecoder().decode(C.getEntry(pkg, 'scene.json')).replace(/^\\uFEFF/, '');
        const extra = new Map();
        let sceneBytes = new TextEncoder().encode(sceneText);
        const read = async (n) => (n === 'scene.json' ? sceneBytes : extra.get(n) ?? C.getEntry(pkg, n) ?? null);
        const host = document.createElement('div');
        host.style.cssText = 'position:fixed;left:0;top:0;width:960px;height:540px;z-index:9';
        document.body.appendChild(host);
        let inst = null, ed = null;
        const mountWith = async (source) => {
          if (inst) inst.destroy();
          host.textContent = '';
          inst = await api.mount(host, { source, fit: 'cover', renderDpr: 1, volume: 0, autoplay: false });
          ed = api.editorOf(inst);
          inst.pause();
          const gen = window.__scene?.general;
          if (gen) gen.bloom = false;
        };
        const loose = () => ({ scenePkg: () => base.scenePkg(), sceneDir: async () => ({ entry: 'scene.json', read }), project: base.project ? (s) => base.project(s) : undefined });
        const grab = async () => {
          const bm = await createImageBitmap(await ed.capture());
          const cv = new OffscreenCanvas(bm.width, bm.height);
          const g = cv.getContext('2d');
          g.drawImage(bm, 0, 0);
          return { w: bm.width, h: bm.height, d: g.getImageData(0, 0, bm.width, bm.height).data };
        };
        const df = (P, Q, i) => Math.abs(P.d[i] - Q.d[i]) + Math.abs(P.d[i + 1] - Q.d[i + 1]) + Math.abs(P.d[i + 2] - Q.d[i + 2]);
        const diffN = (P, Q) => { let n = 0; for (let k = 0; k < P.w * P.h; k++) if (df(P, Q, k * 4) > 24) n++; return n; };
        const at = async (t) => { await ed.seek(t); return grab(); };
        const targets = ${JSON.stringify(targets)};
        const scene = JSON.parse(sceneText);
        // 每次都从原 .mdl / 原场景出发改一步，挂上后按目标链隔离出帧
        const setup = async (tg, mutateMdl, mutateLayers) => {
          const obj = scene.objects.find((o) => o.id === tg.id);
          const keep = { image: obj.image, model: obj.model, layers: structuredClone(obj.animationlayers) };
          extra.clear();
          let files = null;
          if (mutateMdl) {
            const puppet = !!obj.image && !obj.model;
            const mj = puppet ? M.parseJsonBytes(await read(obj.image)) : null;
            const bytes = await read(puppet ? String(mj.puppet) : obj.model);
            const out = mutateMdl(bytes);
            files = out && M.mdlCopyFiles(mj, out, 'cl');
            if (!files) return null;
            for (const f of files.files) extra.set(f.name, f.data);
            if (puppet) obj.image = files.path; else obj.model = files.path;
          }
          if (mutateLayers) mutateLayers(obj.animationlayers);
          sceneBytes = new TextEncoder().encode(JSON.stringify(scene));
          obj.image = keep.image; obj.model = keep.model; obj.animationlayers = keep.layers;
          await mountWith(loose());
          for (const l of ed.getLayers()) if (!tg.chain.includes(l.id)) await ed.setLayerProps(l.id, { visible: false });
          for (const l of window.__scene.layers) if (tg.chain.includes(l.id)) for (const e of l.effects || []) e.visible = false;
          return true;
        };
        for (const tg of targets) {
          if (!(await setup(tg))) continue;
          const info = ed.getModelInfo(tg.id);
          if (!info || !info.animations.length) continue;
          // 页面里第一次挂载与之后的挂载出帧有差（首挂的资源 / 时钟状态），参照帧从第二次挂载起取
          await at(0.9);
          await setup(tg);
          const still = 0;
          const vis = tg.layers.map((a, i) => ({ a, i })).filter((x) => x.a.visible !== false);
          const L = vis[0];
          const clip = L && info.animations.find((c) => c.id === L.a.animation);
          if (!clip) continue;
          const singleLayer = vis.length === 1 && (L.a.blend ?? 1) === 1;
          const T = 0.9;
          const O = await at(T), O2 = await at(2 * T), O0 = await at(0);
          const T2 = await at(T * 1.7);
          if (diffN(O, T2) < 200) continue;
          // 同一工程原样重挂的底噪（有自身时钟的动画层 seek 不是绝对的，跨挂载可能差一点）
          await setup(tg);
          const noise = diffN(O, await at(T)) + diffN(O2, await at(2 * T));
          const out = { mid: tg.id, name: tg.name, form: info.form, clip: clip.name, clipId: clip.id, isFirst: clip.id === info.animations[0].id, additive: !!L.a.additive, singleLayer, nClips: info.animations.length, moving: diffN(O, T2), still, noise };
          // ① 复制并指过去
          let newId = null;
          if (!(await setup(tg, (b) => { const r = api.addMdlClip(b, { name: 'copy', mode: clip.mode, fps: clip.fps, frameCount: clip.frameCount }, 'copy', clip.id); newId = r?.id ?? null; return r?.bytes ?? null; }, (ls) => { ls[L.i].animation = newId; }))) return { fail: 'copy null', ...out };
          out.copyN = ed.getModelInfo(tg.id)?.animations.length;
          out.copyDiff = diffN(O, await at(T)) + diffN(O2, await at(2 * T));
          // ② fps ×2 ≡ 原工程该层 rate ×2（同一时刻比，其余时间源一致）
          await setup(tg);
          await ed.setAnimationLayers(tg.id, tg.layers.map((a, i) => (i === L.i ? { ...a, rate: (typeof a.rate === 'number' ? a.rate : 1) * 2 } : a)));
          const R2 = await at(T);
          await setup(tg, (b) => api.setMdlClipMeta(b, clip.id, { fps: clip.fps * 2 }));
          out.fpsInfo = ed.getModelInfo(tg.id)?.animations.find((c) => c.id === clip.id)?.fps;
          out.fpsWant = clip.fps * 2;
          out.fpsDiff = diffN(R2, await at(T));
          out.fpsMoved = diffN(O, R2);
          // ③ 静止姿势片段（每帧 = 首片段第 0 帧 = 引擎绑定参考）≡ 原工程该层 blend 0
          if (out.isFirst) {
            await setup(tg);
            await ed.setAnimationLayers(tg.id, tg.layers.map((a, i) => (i === L.i ? { ...a, blend: 0 } : a)));
            const B0 = await at(T);
            await setup(tg, (b) => { const r = api.addMdlClip(b, { name: 'rest', mode: 'loop', fps: clip.fps, frameCount: 10 }, 'rest'); newId = r?.id ?? null; return r?.bytes ?? null; }, (ls) => { ls[L.i].animation = newId; });
            out.restDiff = diffN(B0, await at(T));
            out.restMoved = diffN(O, B0);
          }
          // ④ 删末个片段 / 写事件 / 打包
          const last = info.animations.at(-1);
          if (info.animations.length > 1) {
            await setup(tg, (b) => api.removeMdlClip(b, last.id), (ls) => { for (let i = ls.length - 1; i >= 0; i--) if (ls[i].animation === last.id) ls.splice(i, 1); });
            out.removedN = ed.getModelInfo(tg.id)?.animations.length;
          }
          await setup(tg, (b) => api.setMdlClipEvents(b, clip.id, [{ frame: 1, name: 'hit' }, { frame: 0, name: 'start' }]));
          out.events = ed.getModelInfo(tg.id)?.animations.find((c) => c.id === clip.id)?.events;
          out.eventsDiff = diffN(O, await at(T));
          const E = await at(T);
          const files = [];
          for (const e of pkg.entries ?? []) if (e.name !== 'scene.json' && !extra.has(e.name)) files.push({ path: e.name, data: C.getEntry(pkg, e.name) });
          files.push({ path: 'scene.json', data: sceneBytes });
          for (const [n, d] of extra) files.push({ path: n, data: d });
          await mountWith(api.bytesSource(api.buildScenePkg(files).pkg, base.project ? await base.project() : undefined));
          for (const l of ed.getLayers()) if (!tg.chain.includes(l.id)) await ed.setLayerProps(l.id, { visible: false });
          for (const l of window.__scene.layers) if (tg.chain.includes(l.id)) for (const e of l.effects || []) e.visible = false;
          out.pkgDiff = diffN(E, await at(T));
          out.pkgEvents = ed.getModelInfo(tg.id)?.animations.find((c) => c.id === clip.id)?.events;
          inst.destroy();
          return out;
        }
        if (inst) inst.destroy();
        return { skip: 'no animated target' };
      })()`, { awaitPromise: true, timeoutMs: 600000 });
    } catch (e) {
      check(false, `${id}: 片段编辑判据执行失败 ${String(e.message).slice(0, 200)}`);
      continue;
    }
    if (r.skip) {
      console.log(`  · ${id}: ${r.skip}，跳过`);
      continue;
    }
    if (r.fail) {
      check(false, `${id} #${r.mid}：${r.fail}`);
      continue;
    }
    if (process.env.VEM_DEBUG) console.log(JSON.stringify(r));
    tested++;
    if (r.singleLayer) single++;
    if (r.fpsMoved > 30) fpsLive++;
    if (r.restMoved > 30) restLive++;
    const evWant = JSON.stringify([{ frame: 0, name: "start" }, { frame: 1, name: "hit" }]);
    const tol = 30 + r.noise;
    check(
      r.copyN === r.nClips + 1 && r.copyDiff <= tol && Math.abs(r.fpsInfo - r.fpsWant) < 1e-3 && r.fpsDiff <= tol && (r.restDiff === undefined || r.restDiff <= tol),
      `${id} #${r.mid} ${r.name}（${r.form}，片段「${r.clip}」${r.singleLayer ? "单层" : "多层"}${r.additive ? " additive" : ""}）：复制并改指向 ≡ 原画面（差 ${r.copyDiff} px，片段 ${r.nClips}→${r.copyN}）` +
        `；fps×2（引擎读到 ${r.fpsInfo}）≡ 该层 rate×2（差 ${r.fpsDiff} px，对原画面变 ${r.fpsMoved}）` +
        (r.restDiff !== undefined ? `；静止片段 ≡ 该层 blend 0（差 ${r.restDiff} px，对原画面变 ${r.restMoved}）` : "") +
        `（原样重挂底噪 ${r.noise}）`,
    );
    check(
      (r.removedN === undefined || r.removedN === r.nClips - 1) && JSON.stringify(r.events) === evWant && JSON.stringify(r.pkgEvents) === evWant && r.eventsDiff <= 30 + r.noise && r.pkgDiff <= 30,
      `${id}: 删末个片段后片段数 ${r.removedN ?? "（只有 1 个，未测）"}；帧事件读回 ${JSON.stringify(r.events)}、画面不变（差 ${r.eventsDiff}）；打包重挂差 ${r.pkgDiff} px、事件 ${JSON.stringify(r.pkgEvents) === evWant ? "一致" : JSON.stringify(r.pkgEvents)}`,
    );
  }
  check(tested >= 2 && fpsLive >= 1 && restLive >= 1,
    `至少 2 张夹具做了片段编辑真引擎判据，且 fps×2 / 静止片段至少各有 1 张画面确实变了（判据不空转）（${tested} 张 / 单层 ${single} / fps 有效 ${fpsLive} / 静止有效 ${restLive}）`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  let failed = 0;
  const check = (ok, msg) => {
    if (!ok) failed++;
    (ok ? console.log : console.error)(`  ${ok ? "✓" : "✗"} ${msg}`);
  };
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "verify-editor-model-"));
  try {
    await runModelHeadless({ check, section: (t) => console.log(`\n${t}`), tmpRoot });
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
  console.log(failed ? `\n✗ ${failed} 处问题` : "\n✓ 全部通过");
  process.exit(failed ? 1 : 0);
}
