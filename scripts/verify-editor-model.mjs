#!/usr/bin/env node
/**
 * verify-editor-model —— 编辑器模型面（EDITOR-PLAN §3B）的语料参照与真浏览器判据。
 *
 * modelTruth(lib, id)：Node 侧直接 parsePkg + parseMDL 出「这张壁纸的模型层应当长什么样」，
 *   离线段（verify-editor.mjs 的 MA）与本文件的真浏览器段共用这一份参照。
 * runModelHeadless：自起 vite（WE_LIBRARY 指向临时库）+ 真 GPU Chrome，挂夹具壁纸，
 *   引擎 getLayers 的模型层 / getModelInfo 逐项对照 modelTruth（W12 判据）。
 *
 * 用法：
 *   node scripts/verify-editor-model.mjs            # 默认 = 离线段（RESID，纯 Node，**不启动 Chrome**）
 *   node scripts/verify-editor-model.mjs --headless # 追加真浏览器段（自起 vite + 真 GPU Chrome）
 *   VEM_ONLY=resid node scripts/verify-editor-model.mjs   # 只跑离线段（CI 友好）
 *   VEM_ONLY=md2 node scripts/verify-editor-model.mjs     # 老用法：只跑真机子段（仍需 Chrome）
 * 稳定集（scripts/verify-all.mjs）用无参 spawn 执行本文件 ⇒ 覆盖的是离线判据；真机轮归 Lead。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

/* ── 运行模式（task-11）────────────────────────────────────────────────────────
 * 默认调用（无 env、无 --headless）= **离线**：只跑 RESID 段（纯 Node；不起 vite、不启动 Chrome）。
 * 真浏览器段必须显式触发：`--headless`、`VEM_ONLY=browser`，或沿用历史用法 VEM_ONLY=md2/me2/…
 * （老用法零回归）。`verify-editor --headless` 是 **import runModelHeadless 直接调用**，不走本文件
 * 的 CLI 分支，所以它照旧拿得到真机段。
 * RESID-0 系列判据咬住这条契约（含零成本子进程探针 VEM_MODE_PROBE）。
 */
const BROWSER_MODE =
  process.argv.includes("--headless") || process.env.VEM_ONLY === "browser" || (!!process.env.VEM_ONLY && process.env.VEM_ONLY !== "resid");
const RUN_MODE = BROWSER_MODE ? "browser" : "offline";
/** 真机段是否被启动过：离线路径必须恒为 false（RESID-0 咬这一条） */
let BROWSER_STARTED = false;

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
  BROWSER_STARTED = true;
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
    if (only === "mh2") {
      await runImportHeadless({ check, section, session, origin, fixtures });
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
    await runImportHeadless({ check, section, session, origin, fixtures });
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

/**
 * MH2（W19）：glTF 导入的真引擎判据。程序化夹具 glb 在页面里走 editor/gltf.ts 全流程（parseGltf → gltfToModel →
 * gltfImportFiles → addModelLayer），产物文件 + 改过的 scene.json 以松散形态挂载：
 *   ① 引擎认成模型层（puppet / mesh）、getModelInfo 骨 / 片段与导入结果一致
 *   ② ★ puppet：getLayerOutline 的蒙皮凸包包围盒 ≡ glTF 参考求值的顶点经图层原点 + cover 映射（≤ 1 px），两个时刻
 *   ③ 画面：只留导入层时有像素、片段在动、贴图上半红下半蓝 → 红在上（UV 原点左上、Y 向上同 WE）
 *   ④ 存库闭环：buildScenePkg → 从包重挂，同一时刻画面 ≡ 松散形态
 *   ⑤ 透视场景导入成网格：有像素、片段在动
 */
async function runImportHeadless({ check, section, session, origin, fixtures }) {
  section("MH2. glTF 导入（真浏览器）：引擎认层、★ 蒙皮凸包 ≡ glTF 参考、贴图朝向、打包重挂一致、透视场景成网格");
  const F = await imp("scripts/lib/gltf-fixture.mjs");
  const fx = F.skinnedFixture();
  const glb64 = Buffer.from(fx.glb).toString("base64");
  const jobs = [fixtures.find((id) => PUPPET_FIXTURES.includes(id)), ...fixtures.filter((id) => MESH_FIXTURES.includes(id))].filter(Boolean);
  let puppetOk = 0;
  let meshDrawn = 0;
  for (const id of jobs) {
    await session.pageCdp.send("Page.navigate", { url: `${origin}/renderer/index.html?type=canvas` });
    await session.waitFor("!!window.__wp", { timeoutMs: 60000 });
    let r;
    try {
      r = await session.evaluate(`(async () => {
        window.__wp.pause();
        const api = await import('/renderer/src/api/editor.ts');
        const C = await import('/renderer/vendor/we-scene/pkg/container.js');
        const G = await import('/editor/gltf.ts');
        const D = await import('/editor/doc.ts');
        const base = api.httpSource('${origin}/media/dev/${id}');
        const pkg = C.parsePkg(new Uint8Array(await base.scenePkg()));
        const sceneText = new TextDecoder().decode(C.getEntry(pkg, 'scene.json')).replace(/^\\uFEFF/, '');
        const doc = D.makeDoc('t', null, JSON.parse(sceneText), 'loose');
        const glb = Uint8Array.from(atob('${glb64}'), (c) => c.charCodeAt(0));
        const target = G.defaultTarget(doc);
        const m = G.gltfToModel(G.parseGltf(glb), { target, slug: 'fx', fps: 30, scale: target === 'puppet' ? G.fitPuppetScale(doc) : G.fitMeshScale(doc) });
        const files = G.gltfImportFiles(m, 'fx');
        const newId = G.addModelLayer(doc, m, files.path, 'Fixture');
        const obj = doc.scene.objects.at(-1);
        const extra = new Map(files.files.map((f) => [f.name, f.data]));
        const sceneBytes = new TextEncoder().encode(JSON.stringify(doc.scene));
        const read = async (n) => (n === 'scene.json' ? sceneBytes : extra.get(n) ?? C.getEntry(pkg, n) ?? null);
        const host = document.createElement('div');
        host.style.cssText = 'position:fixed;left:0;top:0;width:960px;height:540px;z-index:9';
        document.body.appendChild(host);
        let inst = null, ed = null;
        const mountWith = async (source) => {
          if (inst) inst.destroy();
          host.textContent = '';
          inst = await api.mount(host, { source, fit: 'cover', renderDpr: 1, volume: 0, autoplay: false, onDiagnostic: (m) => diags.push(String(m)) });
          ed = api.editorOf(inst);
          inst.pause();
          const gen = window.__scene?.general;
          if (gen) gen.bloom = false;
        };
        const diags = [];
        const loose = { scenePkg: () => base.scenePkg(), sceneDir: async () => ({ entry: 'scene.json', read }), project: base.project ? (s) => base.project(s) : undefined };
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
        const isolate = async (show) => {
          for (const l of ed.getLayers()) await ed.setLayerProps(l.id, { visible: show && l.id === newId });
          for (const l of window.__scene.layers) for (const e of l.effects || []) e.visible = false;
        };
        await mountWith(loose);
        await mountWith(loose);
        const layer = ed.getLayers().find((l) => l.id === newId);
        const info = ed.getModelInfo(newId);
        await isolate(false);
        const empty = await at(0.4);
        await isolate(true);
        const B = await at(0.8);
        const hullB = ed.getLayerOutline(newId)?.hull ?? null;
        const A = await at(0.4);
        const hullA = ed.getLayerOutline(newId)?.hull ?? null;
        // 红 / 蓝像素的屏幕质心（只看与空画面不同的像素）
        let ry = 0, rn = 0, by = 0, bn = 0, drawn = 0;
        for (let k = 0; k < A.w * A.h; k++) {
          const i = k * 4;
          if (df(A, empty, i) <= 24) continue;
          drawn++;
          const y = Math.floor(k / A.w);
          if (A.d[i] > 150 && A.d[i + 2] < 100) { ry += y; rn++; }
          if (A.d[i + 2] > 150 && A.d[i] < 100) { by += y; bn++; }
        }
        const ortho = doc.scene.general?.orthogonalprojection;
        const out = { id: '${id}', target, newId, kind: layer?.kind, form: layer?.modelForm, bones: info?.bones.map((b) => b.name), clips: info?.animations.map((a) => [a.id, a.name, a.frameCount]),
          layers: obj.animationlayers, scale: m.scale, origin: obj.origin, W: ortho?.width, H: ortho?.height, cw: A.w, ch: A.h,
          drawn, moving: diffN(A, B), redY: rn ? ry / rn : null, blueY: bn ? by / bn : null, hullA, hullB,
          outline: ed.getLayerOutline(newId), diags: diags.filter((m) => /fx|Fixture/.test(m)).slice(0, 5) };
        // 存库闭环
        const pfiles = [];
        for (const e of pkg.entries ?? []) if (e.name !== 'scene.json') pfiles.push({ path: e.name, data: C.getEntry(pkg, e.name) });
        pfiles.push({ path: 'scene.json', data: sceneBytes });
        for (const [n, d] of extra) pfiles.push({ path: n, data: d });
        const built = api.buildScenePkg(pfiles);
        out.texInPkg = built.converted ?? null;
        await mountWith(api.bytesSource(built.pkg, base.project ? await base.project() : undefined));
        await isolate(true);
        out.pkgInfo = ed.getModelInfo(newId)?.animations.length;
        out.pkgDiff = diffN(A, await at(0.4));
        inst.destroy();
        return out;
      })()`, { awaitPromise: true, timeoutMs: 600000 });
    } catch (e) {
      check(false, `${id}: glTF 导入判据执行失败 ${String(e.message).slice(0, 200)}`);
      continue;
    }
    if (process.env.VEM_DEBUG) console.log(JSON.stringify({ ...r, hullA: r.hullA?.length, hullB: r.hullB?.length, outline: JSON.stringify(r.outline)?.slice(0, 300) }));
    const want = r.target === "puppet" ? "puppet" : "mesh";
    check(r.kind === "model" && r.form === want && JSON.stringify(r.bones) === JSON.stringify(["root", "b1", "b2"]) && JSON.stringify(r.clips) === JSON.stringify([[1, "wave", 30], [2, "twist", 60]]) && r.layers?.[0]?.animation === 1,
      `${id}（${r.target === "puppet" ? "正交" : "透视"}场景）：导入层被引擎认成 ${r.form} 模型层，骨 ${JSON.stringify(r.bones)}、片段 ${JSON.stringify(r.clips)}，动画层指向首个片段`);
    check(r.pkgInfo === 2 && r.pkgDiff <= 30, `${id}：打包（png → .tex）从包重挂，片段数 ${r.pkgInfo}、同一时刻画面差 ${r.pkgDiff} px`);
    if (r.target !== "puppet") {
      // 网格按相机实体 / scene.camera 摆在视线中心；相机路径 / 脚本相机的场景，活相机不一定看着那里
      if (r.drawn > 50 && r.moving > 50) meshDrawn++;
      console.log(`  · ${id}（网格）：只留导入层画出 ${r.drawn} px、0.4s → 0.8s 变 ${r.moving} px、轮廓锚点 ${JSON.stringify(r.outline?.anchor ?? null)}`);
      continue;
    }
    check(r.drawn > 200 && r.moving > 50, `${id}：只留导入层时画出 ${r.drawn} px，片段 0.4s → 0.8s 画面变 ${r.moving} px`);
    check(r.redY !== null && r.blueY !== null && r.redY < r.blueY, `${id}：贴图上半红下半蓝 → 屏幕上红在上（红质心 y ${r.redY?.toFixed(1)} < 蓝 ${r.blueY?.toFixed(1)}）：UV 原点左上、Y 向上与 WE puppet 同口径`);
    const [ox, oy] = r.origin.split(" ").map(Number);
    const s = Math.max(r.cw / r.W, r.ch / r.H);
    const offX = (r.cw - r.W * s) / 2;
    const offY = (r.ch - r.H * s) / 2;
    const box = (pts) => pts.reduce((b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)], [Infinity, Infinity, -Infinity, -Infinity]);
    const refBox = (t) => {
      const v = F.refVertices(fx.src, fx.src.anims[0], t, r.scale);
      const pts = [];
      for (let i = 0; i < v.length; i += 3) pts.push([offX + (ox + v[i]) * s, offY + (r.H - (oy + v[i + 1])) * s]);
      return box(pts);
    };
    const errs = [[r.hullA, 0.4], [r.hullB, 0.8]].map(([h, t]) => (h ? Math.max(...box(h).map((v, k) => Math.abs(v - refBox(t)[k]))) : Infinity));
    check(errs.every((e) => e <= 1), `★ ${id}：引擎蒙皮凸包包围盒 vs glTF 参考求值（图层原点 + cover 映射）0.4s 差 ${errs[0].toFixed(3)} px、0.8s 差 ${errs[1].toFixed(3)} px（≤ 1）`);
    if (errs.every((e) => e <= 1)) puppetOk++;
  }
  check(puppetOk >= 1 && meshDrawn >= 1, `正交场景 ★ 判据过 ${puppetOk} 张、透视场景导入网格画得出且在动 ${meshDrawn} 张（${jobs.join(", ")}）`);
}

/* ══════════════════════════════════════════════════════════════════════════════
 * B6 残余（task-8）离线段：尾表姿势（W18a）/ 片段排序（W18b）/ 换图尺寸（W16）
 *
 * 用法：`VEM_ONLY=resid node scripts/verify-editor-model.mjs`
 * 纯 Node，不需要 vite/Chrome。这里用 esbuild 就地打包 mdl-edit.ts（相对导入按源文件目录
 * 解析）而不是原生 import，是为了拿到变异能力：把每条判据对应的实现分支改坏，判据必须变红。
 *
 * 判据口径全部读自引擎源码（引擎一改，下面 RESID-4c/4d 会先红）：
 *   useStaticPose    renderer/vendor/we-scene/render/mdl-skin.js:310-311
 *   恒等早退          renderer/vendor/we-scene/render/mdl-skin.js:326
 *                    （无动画 + 尾表解析不出姿势 ⇒ 蒙皮 ≡ 单位矩阵 ⇒ 直接改 MDLS 局部矩阵看不见）
 *   层表按 id 找片段  renderer/vendor/we-scene/render/mdl-skin.js:174
 *   0 号位回退        renderer/vendor/we-scene/render/mdl-skin.js:315-326 与 :225
 *   autosize 定尺寸   renderer/src/scene-mount.ts:3258-3277
 * ══════════════════════════════════════════════════════════════════════════════ */
const RESID_ME = "renderer/src/editor/mdl-edit.ts";
const POSE_BYTES = 64;

/** esbuild 就地打包（相对导入按源文件目录解析 → 自包含），mutate = [[源串, 替换串], …] */
async function loadEditorModule(rel, mutate) {
  let src = fs.readFileSync(path.join(ROOT, rel), "utf8");
  for (const [from, to, want] of mutate || []) {
    const hits = src.split(from).length - 1;
    if (hits !== (want ?? 1)) throw new Error(`变异锚点命中 ${hits} 处（期望 ${want ?? 1}）：${from}`);
    src = src.replace(from, to);
  }
  const { build } = await import("esbuild");
  const out = await build({
    stdin: {
      contents: src,
      resolveDir: path.dirname(path.join(ROOT, rel)),
      sourcefile: path.join(ROOT, rel),
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    write: false,
    logLevel: "silent",
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vem-resid-"));
  const file = path.join(dir, "mod.mjs");
  fs.writeFileSync(file, out.outputFiles[0].text);
  return import(pathToFileURL(file).href);
}

const RESID_MODEL = "editor/model.ts";

/**
 * 打包 editor/model.ts（W18b① 的数据层就在这儿）。它 import 的是 renderer 的**出口**
 * `../renderer/src/api/editor`，整条出口会拉进 web.ts / overlay-gl.ts 等浏览器模块
 * （实测 Node 侧 import 会 `window is not defined`），所以把这条出口替成真正的实现模块
 * `renderer/src/editor/mdl-edit.ts`（同一批函数，Node 可加载）—— 只换解析、不换被测代码。
 */
async function loadModelModule(mutate) {
  let src = fs.readFileSync(path.join(ROOT, RESID_MODEL), "utf8");
  for (const [from, to, want] of mutate || []) {
    const hits = src.split(from).length - 1;
    if (hits !== (want ?? 1)) throw new Error(`变异锚点命中 ${hits} 处（期望 ${want ?? 1}）：${from}`);
    src = src.replace(from, to);
  }
  const { build } = await import("esbuild");
  const MDL_EDIT = path.join(ROOT, RESID_ME);
  const stubApi = {
    name: "stub-api-editor",
    setup(b) {
      b.onResolve({ filter: /(?:^|\/)renderer\/src\/api\/editor$/ }, () => ({ path: "api-editor", namespace: "stub" }));
      b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
        contents: `export * from ${JSON.stringify(MDL_EDIT)};`,
        loader: "js",
        resolveDir: ROOT,
      }));
    },
  };
  const out = await build({
    stdin: {
      contents: src,
      resolveDir: path.dirname(path.join(ROOT, RESID_MODEL)),
      sourcefile: path.join(ROOT, RESID_MODEL),
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    external: ["node:*"],
    write: false,
    logLevel: "silent",
    plugins: [stubApi],
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vem-resid-model-"));
  const file = path.join(dir, "mod.mjs");
  fs.writeFileSync(file, out.outputFiles[0].text);
  return import(pathToFileURL(file).href);
}

const SY_MOUNT = "renderer/src/scene-mount.ts";

/**
 * 打包 renderer/src/scene-mount.ts（§8.2 [中-5] 的热增判定就在这儿）。
 * 它的依赖链是浏览器模块：`.glsl` 要 loader、`?raw` 要插件，模块体在 import 期就碰
 * `window`/`document`（真 `mountScene` 要 WebGL，Node 起不来 —— 但**纯函数判据不需要挂载**：
 * `hasObjectFieldScript` / `hotAddRejectForObject` 就是热增 obj 分支逐字调的那两个函数）。
 * 所以：①esbuild 就地打包；②import 前装最小 DOM 垫片；③import 后把垫片原样卸载。
 */
async function loadSceneMountModule(mutate) {
  let src = fs.readFileSync(path.join(ROOT, SY_MOUNT), "utf8");
  for (const [from, to, want] of mutate || []) {
    const hits = src.split(from).length - 1;
    if (hits !== (want ?? 1)) throw new Error(`变异锚点命中 ${hits} 处（期望 ${want ?? 1}）：${from}`);
    src = src.replace(from, to);
  }
  const { build } = await import("esbuild");
  const plugins = [
    { name: "glsl-stub", setup: (b) => b.onLoad({ filter: /\.glsl$/ }, () => ({ contents: 'export default "";', loader: "js" })) },
    {
      name: "raw-stub",
      setup: (b) => {
        b.onResolve({ filter: /\?raw$/ }, (a) => ({ path: a.path, namespace: "rawq" }));
        b.onLoad({ filter: /.*/, namespace: "rawq" }, () => ({ contents: 'export default "";', loader: "js" }));
      },
    },
  ];
  const out = await build({
    stdin: {
      contents: src,
      resolveDir: path.dirname(path.join(ROOT, SY_MOUNT)),
      sourcefile: path.join(ROOT, SY_MOUNT),
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    external: ["node:*"],
    write: false,
    logLevel: "silent",
    plugins,
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vem-resid-mount-"));
  const file = path.join(dir, "mod.mjs");
  fs.writeFileSync(file, out.outputFiles[0].text);
  const shim = {
    window: globalThis,
    self: globalThis,
    document: {
      createElement: () => ({ style: {}, getContext: () => null, addEventListener() {}, remove() {} }),
      createElementNS: () => ({ style: {}, getContext: () => null }),
      addEventListener() {},
      removeEventListener() {},
      documentElement: { style: {} },
      body: { style: {}, appendChild() {} },
      head: { appendChild() {} },
    },
    requestAnimationFrame: (cb) => setTimeout(() => cb(0), 0),
    cancelAnimationFrame: (h) => clearTimeout(h),
    addEventListener: () => {},
    OffscreenCanvas: class { getContext() { return null; } },
    HTMLCanvasElement: class {},
  };
  const saved = new Map();
  for (const [k, v] of Object.entries(shim)) {
    saved.set(k, Object.getOwnPropertyDescriptor(globalThis, k));
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(globalThis, k, d);
      else delete globalThis[k];
    }
  }
}

/** 引擎级姿势指纹：算完立刻摘出来（computeSkinMatrices 复用 mdl._skin 缓存，不能留引用） */
function skinHash(mdl, time, layers) {
  const m = S.computeSkinMatrices(mdl, time, layers, null);
  if (!m) return "null";
  return hashBytes(new Uint8Array(m.buffer, m.byteOffset, m.byteLength));
}

const W = await imp("renderer/vendor/we-scene/pkg/mdl-write.js");

function hashBytes(b) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < b.length; i++) {
    h ^= b[i];
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}
const trackHash = (t) =>
  `${t.frameCount}#${hashBytes(new Uint8Array(t.keyframes.buffer, t.keyframes.byteOffset, t.keyframes.byteLength))}`;
/** 每片段的 id/帧数/逐轨关键帧摘要 —— 用来证明「搬记录时片段数据没被改写」 */
const sigById = (m) =>
  new Map(
    (m.animations || []).map((a) => [a.id, `${a.frameCount}:${(a.tracks || []).map(trackHash).join(",")}`]),
  );
const sameArr = (a, b) => {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};
const bytesEqual = (a, b) => {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

let residCache = null;
/** 语料扫描（只扫一次，变异跑复用） */
function residScan(LIB, hasFieldScript = null) {
  if (residCache) return residCache;
  const s = {
    scannedPkgs: 0,
    fieldScriptObjs: 0, // §8.2 [中-5]：原始 scene 对象上的**字段级脚本**形态（angles:{script:…}）
    objectScriptsObjs: 0, // 原始 scene.json 里的 objectScripts 键（解析产物，正常为 0）
    poseNoAnim: [], // 无动画 + 引擎能解析出尾表姿势 → 改尾表看得见（唯一可见杠杆）
    animatedWithPose: [], // 有动画 + 尾表能解析 → 引擎不读尾表
    noAnimNoPose: [], // 无动画 + 尾表解析不出 → 引擎恒等早退，改局部矩阵是空操作
    noMesh: [], // 非蒙皮网格
    multiClip: [], // ≥3 片段（片段排序判据的夹具）
    puppetTotal: 0,
    puppetAuto: 0,
    puppetDeclaredWH: 0,
    idIsPos1: 0,
    dupIds: 0,
    animatedObjects: 0,
    fallbackObjs: 0,
    noLayerObjs: 0,
    allOffObjs: 0,
    layerSample: null, // 有动画 + 有可见层表 → W18b① 的正常路径夹具（真 scene 对象 + 真 .mdl 字节）
    noLayerSample: null, // 有动画 + 没层表 → W18b① 必须拒绝挂层的夹具
  };
  for (const id of fs.readdirSync(LIB).sort()) {
    const pkgPath = path.join(LIB, id, "scene.pkg");
    if (!fs.existsSync(pkgPath)) continue;
    let pkg;
    try {
      pkg = C.parsePkg(new Uint8Array(fs.readFileSync(pkgPath)));
    } catch {
      continue;
    }
    const entries = pkg.entries || [];
    const entryBytes = (name) => {
      try {
        return C.getEntry(pkg, name);
      } catch {
        return null;
      }
    };
    const jsonOf = (name) => {
      const b = name && entryBytes(name);
      if (!b) return null;
      try {
        return readJson(b);
      } catch {
        return null;
      }
    };
    const mdlByPath = new Map();
    for (const e of entries) {
      if (!/\.json$/i.test(e.name)) continue;
      const j = jsonOf(e.name);
      if (!j) continue;
      if (typeof j.puppet === "string") {
        s.puppetTotal++;
        if (j.autosize === true) s.puppetAuto++;
        if (j.width || j.height) s.puppetDeclaredWH++;
      }
    }
    for (const e of entries) {
      if (!/\.mdl$/i.test(e.name)) continue;
      const bytes = entryBytes(e.name);
      if (!bytes) continue;
      let m;
      try {
        m = P.parseMDL(bytes);
      } catch {
        continue;
      }
      mdlByPath.set(e.name, m);
      if (!(m.bones || []).length) {
        if (s.noMesh.length < 2) s.noMesh.push({ id, name: e.name, bytes });
        continue;
      }
      const bones = m.bones.length;
      const animated = (m.animations || []).length > 0;
      const hasPose = !!(m.staticPoseLocal && m.staticPoseLocal.length === bones);
      if (!animated) {
        const rec = { id, name: e.name, bytes, m, bones, tailLen: 0 };
        if (hasPose) {
          const doc = W.readMdlDoc(bytes);
          const sec = doc && doc.sections.find((x) => x.type === "MDLS");
          rec.tailLen = sec && sec.tail ? sec.tail.length : 0;
          s.poseNoAnim.push(rec);
        } else s.noAnimNoPose.push(rec);
      } else {
        if (hasPose && s.animatedWithPose.length < 4) s.animatedWithPose.push({ id, name: e.name, bytes, m, bones });
        const ids = (m.animations || []).map((a) => a.id);
        if (ids.some((v, k) => v === k + 1)) s.idIsPos1++;
        if (new Set(ids).size !== ids.length) s.dupIds++;
        if (ids.length >= 3) s.multiClip.push({ id, name: e.name, bytes, m, bones, ids });
      }
    }
    const scene = jsonOf("scene.json");
    if (!scene) continue;
    s.scannedPkgs += 1;
    // §8.2 [中-5] 的语料对照：老判据只看 `o.objectScripts`（解析产物），字段级脚本形态要按
    // 引擎同一张白名单再判一次。这里用**被测实现自己的函数**数一遍（不是另写一份口径）。
    for (const o of scene.objects || []) {
      if (!o || typeof o !== "object") continue;
      if (hasFieldScript && hasFieldScript(o)) s.fieldScriptObjs += 1;
      if (o.objectScripts) s.objectScriptsObjs += 1;
    }
    for (const o of scene.objects || []) {
      const p = o.model || o.image;
      if (typeof p !== "string" || !p) continue;
      const mj = jsonOf(p);
      if (!mj || typeof mj.puppet !== "string") continue;
      const mdl = mdlByPath.get(mj.puppet);
      if (!mdl || !(mdl.animations || []).length) continue;
      s.animatedObjects++;
      const layers = Array.isArray(o.animationlayers) ? o.animationlayers : null;
      if (!layers || !layers.length) {
        s.noLayerObjs++;
        s.fallbackObjs++;
        if (!s.noLayerSample) {
          const bytes = entryBytes(mj.puppet);
          if (bytes) {
            s.noLayerSample = {
              id,
              mdlPath: mj.puppet,
              bytes,
              sceneObjects: JSON.parse(JSON.stringify(scene.objects)),
              oIndex: scene.objects.indexOf(o),
            };
          }
        }
        continue;
      }
      const on = layers.filter((l) => !(l.visible === false || l.visible === 0));
      if (!on.length) {
        s.allOffObjs++;
        s.fallbackObjs++;
      } else if (!s.layerSample) {
        const bytes = entryBytes(mj.puppet);
        if (bytes) {
          s.layerSample = {
            id,
            mdlPath: mj.puppet,
            bytes,
            layers: JSON.parse(JSON.stringify(layers)),
            layerCount: layers.length,
            sceneObjects: JSON.parse(JSON.stringify(scene.objects)),
            oIndex: scene.objects.indexOf(o),
          };
        }
      }
    }
  }
  residCache = s;
  return s;
}

async function residBattery(ME, MODEL, LIB, check, SM = null) {
  const s = residScan(LIB, SM ? SM.hasObjectFieldScript : null);

  /* ── RESID-0 运行模式（task-11）：默认路径必须离线、不启动 Chrome ────────────
   * 判据要点：把 CLI 契约做成可证伪的 —— 子进程探针 VEM_MODE_PROBE=1 只打印 mode 立即退出，
   * 于是「谁把默认改成真机段」会立刻让 RESID-0b 变红（默认必须 mode=offline），
   * 而 --headless / VEM_ONLY=md2 这些真机入口照旧 mode=browser。
   */
  const modeProbe = (env = {}, args = []) => {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...args], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, VEM_MODE_PROBE: "1", ...env },
    });
    return (r.stdout || "").trim().split("\n").pop() || `exit=${r.status}`;
  };
  check(
    RUN_MODE === "offline" && !BROWSER_STARTED,
    `RESID-0a 运行模式 mode=${RUN_MODE}，真机段未启动（BROWSER_STARTED=${BROWSER_STARTED}，argv 无 --headless）`,
  );
  check(modeProbe() === "mode=offline", "RESID-0b CLI 契约：无 env / 无 --headless ⇒ mode=offline（verify-all 用无参 spawn）");
  check(modeProbe({}, ["--headless"]) === "mode=browser", "RESID-0c CLI 契约：--headless ⇒ mode=browser（真机轮，Lead 用）");
  check(modeProbe({ VEM_ONLY: "resid" }) === "mode=offline", "RESID-0d CLI 契约：VEM_ONLY=resid ⇒ mode=offline（可单独跑）");
  check(modeProbe({ VEM_ONLY: "md2" }) === "mode=browser", "RESID-0e CLI 契约：既有 VEM_ONLY=md2 ⇒ mode=browser（老用法零回归）");
  /* ── RESID-1 定位口径：与引擎 parseStaticPose 逐条一致 ───────────────────── */
  check(s.poseNoAnim.length >= 5, `RESID-1a 语料：无动画 + 引擎能解析出尾表姿势的模型 ${s.poseNoAnim.length} 个（≥5）`);
  let poseOk = 0;
  let longTail = 0;
  let firstBad = "";
  for (const rec of s.poseNoAnim) {
    if (rec.tailLen > 14 + 84 * rec.bones) longTail++;
    let all = true;
    for (let i = 0; i < rec.bones; i++) {
      if (!sameArr(ME.mdlRestPose(rec.bytes, i), rec.m.staticPoseLocal[i])) {
        all = false;
        firstBad = firstBad || `${rec.id}/${rec.name}#${i}`;
        break;
      }
    }
    if (all) poseOk++;
  }
  check(
    poseOk === s.poseNoAnim.length,
    `RESID-1b mdlRestPose 与引擎 staticPoseLocal 逐分量一致：${poseOk}/${s.poseNoAnim.length}${firstBad ? `（首个不符 ${firstBad}）` : ""}`,
  );
  check(longTail >= 1, `RESID-1c 其中尾表长于 14+84N 的 ${longTail} 个 ⇒ 必须用引擎同款定位，硬算 14+84N 会错`);
  check(
    s.animatedWithPose.every((r) => ME.mdlRestPose(r.bytes, 0) === null),
    `RESID-1d 有动画轨道的模型（引擎不读尾表姿势）mdlRestPose 一律 null：${s.animatedWithPose.length} 个`,
  );
  check(
    s.noAnimNoPose.every((r) => ME.mdlRestPose(r.bytes, 0) === null),
    `RESID-1e 无动画但尾表解析不出姿势的模型 mdlRestPose 一律 null：${s.noAnimNoPose.length} 个`,
  );

  /* ── RESID-2 写侧：64 字节、回读、逆写回、拒绝零副作用 ─────────────────── */
  const fx =
    s.poseNoAnim.find((r) => r.bones >= 2 && r.tailLen > 14 + 84 * r.bones) ||
    s.poseNoAnim.find((r) => r.bones >= 2) ||
    s.poseNoAnim[0];
  if (!fx) {
    check(false, "RESID-2 没有可用的「无动画姿势」夹具");
    return;
  }
  const before = fx.bytes;
  const p0 = ME.mdlRestPose(before, 0);
  const p1 = ME.mdlRestPose(before, 1);
  const next = Float32Array.from(p1);
  next[12] += 123.5;
  next[13] -= 7.25;
  const diffSpan = (a, b) => {
    let n = 0;
    let min = -1;
    let max = -1;
    for (let i = 0; i < a.length; i++) {
      if (a[i] === b[i]) continue;
      n++;
      if (min < 0) min = i;
      max = i;
    }
    return { n, min, max };
  };
  const out = ME.setMdlRestPose(before, 1, next);
  check(!!out && out.length === before.length, `RESID-2a setMdlRestPose 成功且长度不变（${before.length} 字节，${fx.id}/${fx.name}）`);
  if (out) {
    const sp = diffSpan(before, out);
    // 只有被写入的分量会变（改平移 → 8 字节），但它们必须全部落在同一张 64 字节矩阵窗口内
    check(
      sp.n > 0 && sp.n <= POSE_BYTES && sp.max - sp.min < POSE_BYTES,
      `RESID-2b 差异全部落在同一张 ${POSE_BYTES} 字节矩阵窗口内（${sp.n} 字节，跨度 ${sp.max - sp.min + 1}）`,
    );
    check(
      sameArr(ME.mdlRestPose(out, 1), next) && sameArr(ME.mdlRestPose(out, 0), p0),
      "RESID-2c 回读：目标骨 = 写入值、邻骨逐分量原样",
    );
    const back = ME.setMdlRestPose(out, 1, p1);
    check(bytesEqual(back, before), "RESID-2d 逆写回旧矩阵 → 逐字节等于原文件");
    const bonesSame = JSON.stringify(ME.mdlBones(before)) === JSON.stringify(ME.mdlBones(out));
    const clipsSame = JSON.stringify([...sigById(P.parseMDL(before))]) === JSON.stringify([...sigById(P.parseMDL(out))]);
    check(bonesSame && clipsSame, "RESID-2e 骨表（名称/父级）与全部片段（id/帧数/逐轨关键帧）逐项不变");
    // 骨号 → 窗口一一对应：写 0 号骨与写 1 号骨的差异窗口互不重叠、且 0 在前
    const z = Float32Array.from(p0);
    z[12] += 5;
    const out0 = ME.setMdlRestPose(before, 0, z);
    const sp0 = out0 ? diffSpan(before, out0) : null;
    check(
      !!sp0 && sp0.n > 0 && sp0.max < sp.min,
      `RESID-2g 写 0 号骨的窗口在写 1 号骨之前、互不重叠（0 号跨度 ${sp0 ? `${sp0.max - sp0.min + 1}` : "?"} 字节）`,
    );
  }
  const rej = (label, fn, bytes) => {
    const snap = bytes.slice();
    let r = null;
    let threw = false;
    try {
      r = fn();
    } catch {
      threw = true;
    }
    check(!threw && r === null && bytesEqual(snap, bytes), `RESID-2f ${label} → null 且零副作用（${bytes.length} 字节逐字节未变）`);
  };
  if (s.animatedWithPose.length) {
    const r = s.animatedWithPose[0];
    rej("有动画模型", () => ME.setMdlRestPose(r.bytes, 0, p0), r.bytes);
  }
  if (s.noAnimNoPose.length) {
    const r = s.noAnimNoPose[0];
    rej("尾表无姿势", () => ME.setMdlRestPose(r.bytes, 0, p0), r.bytes);
  }
  rej("骨号越界", () => ME.setMdlRestPose(before, fx.bones, p0), before);
  rej("骨号非整数", () => ME.setMdlRestPose(before, 0.5, p0), before);
  rej("矩阵长度 15", () => ME.setMdlRestPose(before, 0, p0.slice(0, 15)), before);
  const nanM = Float32Array.from(p0);
  nanM.fill(NaN);
  rej("矩阵含 NaN", () => ME.setMdlRestPose(before, 0, nanM), before);
  const infM = Float32Array.from(p0);
  infM[3] = Infinity;
  rej("矩阵含 Infinity", () => ME.setMdlRestPose(before, 0, infM), before);
  if (s.noMesh.length) rej("非蒙皮网格", () => ME.setMdlRestPose(s.noMesh[0].bytes, 0, p0), s.noMesh[0].bytes);

  /* ── RESID-3 片段排序：id 绑定不动、顺序可预期、跨 0 号位拒绝 ───────────── */
  check(s.multiClip.length >= 20, `RESID-3a 语料：≥3 片段的模型 ${s.multiClip.length} 个（≥20）`);
  check(
    s.idIsPos1 === 0 && s.dupIds === 0,
    `RESID-3b 片段 id 与「位置+1」无关（命中 ${s.idIsPos1} 个）、无重复 id（${s.dupIds} 个）⇒ 场景层按 id 绑定不随记录顺序变`,
  );
  let moveOk = 0;
  let moveBad = "";
  for (const rec of s.multiClip) {
    const want = rec.ids.slice();
    const [mv] = want.splice(1, 1);
    want.splice(2, 0, mv);
    let om = null;
    const o2 = ME.moveMdlClip(rec.bytes, 1, 2);
    try {
      om = o2 && P.parseMDL(o2);
    } catch {
      om = null;
    }
    if (!om) {
      moveBad = moveBad || `${rec.id}/${rec.name} 返回 null 或重读失败`;
      continue;
    }
    const got = (om.animations || []).map((a) => a.id);
    const inSig = sigById(rec.m);
    const outSig = sigById(om);
    const dataSame =
      inSig.size === outSig.size && [...inSig].every(([k, v]) => outSig.get(k) === v);
    if (got.join(",") !== want.join(",") || !dataSame) {
      moveBad = moveBad || `${rec.id}/${rec.name} 顺序[${got}]≠[${want}] 数据同=${dataSame}`;
      continue;
    }
    moveOk++;
  }
  check(
    moveOk === s.multiClip.length,
    `RESID-3c 1→2 换位：顺序按预期且每个片段逐轨数据不变 ${moveOk}/${s.multiClip.length}${moveBad ? `（首个不符 ${moveBad}）` : ""}`,
  );
  const any = s.multiClip[0];
  const rej2 = (label, fn) => {
    const snap = any.bytes.slice();
    let r = null;
    let threw = false;
    try {
      r = fn();
    } catch {
      threw = true;
    }
    check(!threw && r === null && bytesEqual(snap, any.bytes), `RESID-3d ${label} → null 且零副作用`);
  };
  rej2("跨 0 号位（0→1）", () => ME.moveMdlClip(any.bytes, 0, 1));
  rej2("跨 0 号位（1→0）", () => ME.moveMdlClip(any.bytes, 1, 0));
  rej2("to 越界", () => ME.moveMdlClip(any.bytes, 1, 99));
  rej2("from === to", () => ME.moveMdlClip(any.bytes, 1, 1));
  rej2("非整数", () => ME.moveMdlClip(any.bytes, 1, 1.5));
  if (s.poseNoAnim.length) rej2("无片段模型", () => ME.moveMdlClip(s.poseNoAnim[0].bytes, 0, 1));

  /* ── RESID-4 换图尺寸（W16）与 0 号位回退的语料事实 + 引擎读点 ───────────── */
  check(
    s.puppetTotal > 100 && s.puppetAuto === s.puppetTotal,
    `RESID-4a 语料：puppet model json ${s.puppetTotal} 个里 ${s.puppetAuto} 个 autosize:true`,
  );
  check(
    s.puppetDeclaredWH === 0,
    `RESID-4b 其中声明 width/height 的 ${s.puppetDeclaredWH} 个 ⇒ 换图后图层世界尺寸只可能来自新贴图的单帧尺寸（src/scene-mount.ts:3258-3277）`,
  );
  const smSrc = fs.readFileSync(path.join(ROOT, "renderer/src/scene-mount.ts"), "utf8");
  check(
    smSrc.includes("(model as any)?.autosize &&") && smSrc.includes("layer.size = [w, h];"),
    "RESID-4c 引擎读点仍在：autosize 闸门（层尺寸含 0 时 layer.size = 贴图单帧尺寸）",
  );
  const skinSrc = fs.readFileSync(path.join(ROOT, "renderer/vendor/we-scene/render/mdl-skin.js"), "utf8");
  check(
    skinSrc.includes("find((x) => x.id === l.animation)") && skinSrc.includes("useStaticPose"),
    "RESID-4d 引擎读点仍在：层表按 id 找片段 + useStaticPose 以「无动画 + 尾表可解析」为条件",
  );
  check(
    s.fallbackObjs >= 1,
    `RESID-4e 语料：${s.animatedObjects} 个有动画的模型对象里 ${s.fallbackObjs} 个吃 animations[0] 回退（无层表 ${s.noLayerObjs} + 层全关 ${s.allOffObjs}）⇒ 0 号位片段不许被移走`,
  );

  /* ── RESID-5 W18b①：加片段 + 挂首个动画层（数据层 + 引擎级零变化） ───────── */
  const L = s.layerSample;
  if (!L) {
    check(false, "RESID-5 语料里找不到「有动画 + 有可见层表」的对象夹具");
  } else {
    const clipsBefore = ME.mdlClips(L.bytes);
    const doc = { scene: { objects: L.sceneObjects } };
    const o = doc.scene.objects[L.oIndex];
    const res = MODEL.addClipWithLayer(doc, o, L.bytes, { name: "editor-new", frameCount: 2, fps: 30, mode: "loop" }, "rest");
    check(!!res && !!clipsBefore, `RESID-5a addClipWithLayer 跑通（${L.id} ${L.mdlPath}，原有 ${clipsBefore ? clipsBefore.length : "?"} 片段 / ${L.layerCount} 层）`);
    if (res) {
      const maxId = Math.max(...clipsBefore.map((c) => c.id));
      const after = ME.mdlClips(res.bytes);
      check(
        after.length === clipsBefore.length + 1 && after[after.length - 1].id === res.id && res.id === maxId + 1,
        `RESID-5b 新片段追加在末位、id = 原最大 id + 1（${maxId} → ${res.id}）`,
      );
      const layers = o.animationlayers;
      const added = layers[layers.length - 1];
      check(
        layers.length === L.layerCount + 1 &&
          res.layerIndex === layers.length - 1 &&
          added.animation === res.id &&
          added.id === res.layerId &&
          added.visible === false &&
          added.blend === 1,
        `RESID-5c 新层挂在末位且 visible:false / blend 1 / animation 指向新片段 ${res.id}`,
      );
      check(
        JSON.stringify(layers.slice(0, L.layerCount)) === JSON.stringify(L.layers),
        "RESID-5d 原有动画层逐字段未被改动",
      );
      /* 引擎级：新层看不见 ⇒ 姿势与改动前逐分量一致（这是「新片段自动挂层不改变画面」的硬证据） */
      const mb = P.parseMDL(L.bytes);
      const ma = P.parseMDL(res.bytes);
      const anim0 = (mb.animations || [])[0];
      const times = [0, 1, Math.max(1, Math.floor((anim0 ? anim0.frameCount : 8) / 2)), Math.max(1, (anim0 ? anim0.frameCount : 8) - 1)];
      const sameTimes = times.filter((t) => skinHash(mb, t, L.layers) === skinHash(ma, t, layers));
      check(
        sameTimes.length === times.length,
        `RESID-5e 引擎：原层表生效的时刻上，新层 visible:false ⇒ 蒙皮矩阵与改动前逐字节一致（${sameTimes.length}/${times.length} 个时刻）`,
      );
      /* 反面：把新层点亮必须真的改变姿势（否则说明层没接上片段 / 片段没轨道 = 死代码） */
      const shown = layers.map((l, i) => (i === layers.length - 1 ? { ...l, visible: true } : l));
      const changed = times.filter((t) => skinHash(ma, t, shown) !== skinHash(ma, t, layers));
      check(
        changed.length > 0,
        `RESID-5f 把新层改成 visible:true ⇒ 姿势确实变（${changed.length}/${times.length} 个时刻）⇒ 新层真接在新片段上`,
      );
      check(
        !(clipsBefore.some((c) => c.id === res.id)) && ME.mdlClips(res.bytes)[clipsBefore.length - 1].id === clipsBefore[clipsBefore.length - 1].id,
        "RESID-5g 新 id 不与原有片段撞号、原片段顺序未动",
      );
    }
  }
  const N = s.noLayerSample;
  if (!N) {
    check(false, "RESID-5 语料里找不到「有动画 + 无层表」的对象夹具");
  } else {
    const doc2 = { scene: { objects: N.sceneObjects } };
    const o2 = doc2.scene.objects[N.oIndex];
    const r2 = MODEL.addClipWithLayer(doc2, o2, N.bytes, { name: "editor-new", frameCount: 2, fps: 30, mode: "loop" }, "rest");
    check(
      !!r2 && r2.layerSkip === "no-layer-table" && r2.layerIndex === null && r2.layerId === null,
      `RESID-5h 没有层表的对象（${N.id} ${N.mdlPath}）不挂层：只加片段 + 回告原因`,
    );
    check(
      !Object.prototype.hasOwnProperty.call(o2, "animationlayers") || !o2.animationlayers.length,
      "RESID-5i 拒绝路径零副作用：对象没有多出 animationlayers（挂上就会砍掉引擎的 animations[0] 回退）",
    );
  }

  /* ── RESID-6 §8.2 [中-5]：热增 obj 分支漏判「字段级脚本」形态（task-30 B） ──────
     原始 scene.json 对象上没有 `objectScripts`（那是 parse.js 的解析产物），热增判定读的
     正是原始对象 ⇒ 只判 `o.objectScripts` 会漏掉 `angles: {script: …}` 这类对象。 */
  if (SM) {
    const FIELDS = Array.from(SM.OBJECT_SCRIPT_FIELDS || []);
    const eq = (x, y) => JSON.stringify(x) === JSON.stringify(y);

    // 6a 白名单同源：scene-mount.ts 的常量 vs 引擎 parse.js:552-568 的内联表（顺序敏感）
    const parseSrc = fs.readFileSync(path.join(ROOT, "renderer/vendor/we-scene/scene/parse.js"), "utf8");
    const block = parseSrc.slice(parseSrc.indexOf("objectScripts: (() => {"));
    const m = block.match(/for \(const f of \[([\s\S]*?)\]\) \{/);
    const engineFields = m ? Array.from(m[1].matchAll(/'([A-Za-z0-9_]+)'/g)).map((x) => x[1]) : null;
    check(
      !!engineFields && engineFields.length === 12 && eq(engineFields, FIELDS),
      `RESID-6a 白名单同源：引擎 parse.js 内联表 ${JSON.stringify(engineFields)} 与 scene-mount 常量逐字相等（顺序敏感 ⇒ 改一处必须同批改另一处）`,
    );

    // 6b 字段级脚本判定表：12 个字段的 {script} 形态全收，非脚本形态一个不收
    const allTrue = FIELDS.every((f) => SM.hasObjectFieldScript({ [f]: { script: "cb", value: 1 } }) === true);
    const negatives = [
      [{ angles: { script: "" } }, "script 是空串"],
      [{ angles: { script: 5 } }, "script 非字符串"],
      [{ angles: [1, 2, 3] }, "angles 是纯数组"],
      [{ angles: { value: 1 } }, "有字段对象但没有 script"],
      [{ objectScripts: { angles: {} } }, "只有解析产物键 objectScripts"],
      [{}, "空对象"],
      [null, "null"],
      [42, "数字"],
    ].filter(([o]) => SM.hasObjectFieldScript(o) === false);
    check(
      FIELDS.length === 12 && allTrue && negatives.length === 8,
      `RESID-6b 字段级脚本判定：${FIELDS.length} 个白名单字段的 {script} 形态全部命中；${negatives.length}/8 条反例全部不命中（${negatives.map((x) => x[1]).join(" / ")}）`,
    );

    // 6c/6d 真行为（= 热增 obj 分支逐字调的那个函数）
    const resident = () => "tex-1";
    const notResident = () => null;
    const R = (o, t = notResident) => SM.hotAddRejectForObject(o, t);
    const scriptReason = R({ name: "sun", angles: { script: "rotate" } });
    check(
      typeof scriptReason === "string" &&
        scriptReason.includes("两阶段 init") &&
        R({ name: "sun", angles: [1, 2, 3] }) === null &&
        typeof R({ alpha: { script: "fade" } }) === "string" &&
        typeof R({ objectScripts: { angles: {} } }) === "string" &&
        typeof R({ angles: { script: "rotate" } }, resident) === "string",
      `RESID-6c 热增判定：{angles:{script}} ⇒ ok=false 且理由含「两阶段 init」（"${String(scriptReason).slice(0, 24)}…"）；纯数组 {angles:[1,2,3]} ⇒ ok=true（null）；解析产物键 objectScripts 与「有贴图驻留」两种叠加都不能放行`,
    );
    check(
      typeof R(null) === "string" &&
        typeof R({ parent: 3 }) === "string" &&
        R({ parent: 3 }).includes("父级") &&
        typeof R({ particle: "p.json" }) === "string" &&
        typeof R({ model: "m.mdl" }) === "string" &&
        typeof R({ text: "hi" }) === "string" &&
        typeof R({ image: "i.png" }) === "string" &&
        R({ image: "i.png" }).includes("贴图未驻留") &&
        R({ image: "i.png" }, resident) === null,
      "RESID-6d obj 分支其余闸门未被这次改动打乱（缺 obj / parent / particle / model / text / 贴图未驻留 / 贴图已驻留放行）",
    );

    // 6e 语料对照：工坊库里字段级脚本对象远多于 0，而 objectScripts 键在原始 scene.json 里 0 个
    // ⇒ 老判据（只看 o.objectScripts）在真实语料上完全落空，这次补的正是这一条。
    check(
      s.scannedPkgs > 300 && s.objectScriptsObjs === 0 && s.fieldScriptObjs > 1000,
      `RESID-6e 语料对照：${s.scannedPkgs} 个 scene.pkg 里字段级脚本对象 ${s.fieldScriptObjs} 个，而原始场景带 objectScripts 键的 ${s.objectScriptsObjs} 个 ⇒ 老判据在真实语料上 0 命中（漏判是实打实的）`,
    );

    // 6f/6g 接线与零回归：obj 分支真走这个纯函数；duplicateOf 分支保持原样
    const mountSrc = fs.readFileSync(path.join(ROOT, SY_MOUNT), "utf8");
    const fnBody = mountSrc.slice(mountSrc.indexOf("export function hotAddRejectForObject"));
    const bodyEnd = fnBody.indexOf("\n}");
    const callsite = mountSrc.slice(mountSrc.indexOf("const hotAddReject = (spec: any)"));
    const callsiteHead = callsite.slice(0, callsite.indexOf("const obj: any = spec.obj;"));
    check(
      bodyEnd > 0 &&
        fnBody.slice(0, bodyEnd).includes("if (hasObjectFieldScript(o)) return") &&
        callsite.includes("hotAddRejectForObject(obj, residentTextureFor)"),
      "RESID-6f 接线：canHotAddLayer → hotAddReject 的 obj 分支逐字调 hotAddRejectForObject(obj, residentTextureFor)，而该函数体里就有 hasObjectFieldScript(o) 这一条（离线判据跑的就是这段真代码）",
    );
    check(
      callsiteHead.includes("src.objectScripts") && !callsiteHead.includes("hasObjectFieldScript(src)"),
      "RESID-6g duplicateOf 分支零回归：仍按**解析产物** src.objectScripts 判，没有把「原始对象字段级形态」那套判定套到 src 上（headless 用法只走这条分支）",
    );
  }
}

/** 变异红测：每条判据对应的实现分支改坏 → 至少一条 RESID 判据必须变红 */
const RESID_MUTATIONS = [
  { name: "定位：去掉退化扫描（只信 14+84N 布局）", pairs: [["const scanEnd = Math.min(32, tail.length - pose);", "const scanEnd = 0;"]] },
  {
    name: "写侧：忽略骨号、永远写第一根骨",
    pairs: [
      [
        "  hit.sec.tail = Uint8Array.from(hit.sec.tail!);\n  const dv = dvOf(hit.sec.tail);\n  const at = hit.start + boneIndex * POSE_MATRIX_BYTES;",
        "  hit.sec.tail = Uint8Array.from(hit.sec.tail!);\n  const dv = dvOf(hit.sec.tail);\n  const at = hit.start;",
      ],
    ],
  },
  { name: "闸门：有动画也当姿势可见", pairs: [["if (anims && (anims.raw || (anims.anims?.length ?? 0) > 0)) return null;", "if (false && anims) return null;"]] },
  { name: "闸门：不校验矩阵（NaN/长度 15 也写）", pairs: [["  if (!Number.isInteger(boneIndex) || boneIndex < 0 || boneIndex >= hit.count) return null;\n  if (!boneMatrixOk(matrix)) return null;", "  if (!Number.isInteger(boneIndex) || boneIndex < 0 || boneIndex >= hit.count) return null;\n  if (!Array.isArray(matrix) && !(matrix instanceof Float32Array)) return null;"]] },
  { name: "闸门：允许搬走 0 号位片段", pairs: [["if (from === 0 || to === 0) return null;", "if (false) return null;"]] },
  { name: "排序：落位偏一位", pairs: [["anims.splice(to, 0, moved);", "anims.splice(Math.max(0, to - 1), 0, moved);"]] },
  {
    file: RESID_MODEL,
    name: "W18b①：新层默认可见（挂上就改画面）",
    pairs: [['setAnimLayerField(o, index, "visible", false);', 'setAnimLayerField(o, index, "visible", true);']],
  },
  {
    file: RESID_MODEL,
    name: "W18b①：没有层表也硬挂（砍掉引擎 animations[0] 回退）",
    pairs: [
      [
        '  if (!list || !list.length)\n    return { bytes: added.bytes, id: added.id, layerIndex: null, layerId: null, layerSkip: "no-layer-table" };',
        "  if (false)\n    return { bytes: added.bytes, id: added.id, layerIndex: null, layerId: null, layerSkip: \"no-layer-table\" };",
      ],
    ],
  },
  {
    file: RESID_MODEL,
    name: "W18b①：新层指向隔壁片段（id 接错）",
    pairs: [["addAnimLayer(doc, o, added.id, layerName || init.name)", "addAnimLayer(doc, o, added.id - 1, layerName || init.name)"]],
  },
  {
    file: SY_MOUNT,
    name: "§8.2 [中-5]：热增漏判字段级脚本（撤掉 hasObjectFieldScript 这一条）",
    pairs: [['  if (hasObjectFieldScript(o)) return "带对象脚本的图层需要两阶段 init，热增暂不支持（走整场景重挂）";\n', ""]],
  },
  {
    file: SY_MOUNT,
    name: "§8.2 [中-5]：白名单漂移（scene-mount 侧少一个 angles）",
    pairs: [['  "angles",\n', ""]],
  },
  {
    file: SY_MOUNT,
    name: "§8.2 [中-5]：脚本形态判定放宽（有字段对象就算脚本）",
    pairs: [
      [
        '    const v = o[field];\n    if (v && typeof v === "object" && typeof (v as { script?: unknown }).script === "string" && (v as { script: string }).script) return true;',
        "    const v = o[field];\n    if (v) return true;",
      ],
    ],
  },
];

// ══════════════════════════════════════════════════════════════════════════════
// W18a 片段叠增量逐帧对账（task-34）：编辑器数据层 ≡ 引擎真实求值
//
// 这条判据**不是自证**：编辑器侧 `mdlClipFrameTrs` 的九分量经引擎自己的 `composeTRS` 合成
// 16 分量矩阵，与引擎 `computeSkinMatrices`（真实播放路径）写出的 `_local[i]` 逐元素比，
// 两侧都吃真语料 / 合成字节。覆盖三种 mode 的采样索引、r 分量最短弧、无轨道骨回落 bindTRS、
// 编辑预览增量（t/r 相加、s 相乘）、轨序号映射、越界与非法输入。
// ══════════════════════════════════════════════════════════════════════════════
const FRAME_ME = "renderer/src/editor/mdl-edit.ts";
const FRAME_EPS = 1e-5;

/** 每条变异 = 把逐帧合成改坏的一种方式；对账判据必须变红（否则说明没覆盖该分支） */
const FRAME_MUTATIONS = [
  {
    name: "有轨道的骨却回落绑定姿势（rest 当输出）",
    pairs: [
      [
        "    sampleClipTrs(track.data, text(anim.mode), anim.fps, time, out);",
        "    { const b0 = mdlBindTRS(bytes, bone); if (b0) out.set(b0); }",
      ],
    ],
  },
  {
    name: "插值权重反了（t 与 1−t 互换）",
    pairs: [["      out[i] = data[a + i] * it + data[b + i] * t;", "      out[i] = data[a + i] * t + data[b + i] * it;"]],
  },
  {
    name: "预览增量的缩放口径错（相乘改成相加）",
    pairs: [
      ["    for (let k = 0; k < 3; k++) out[6 + k] *= s[k] ?? 1;", "    for (let k = 0; k < 3; k++) out[6 + k] += (s[k] ?? 1) - 1;"],
    ],
  },
  {
    name: "r 分量去掉最短弧（跨 ±π 直接线性插值）",
    pairs: [
      [
        "      let d = data[b + i] - data[a + i];\n      if (d > Math.PI) d -= 2 * Math.PI;\n      else if (d < -Math.PI) d += 2 * Math.PI;\n      out[i] = data[a + i] + d * t;",
        "      out[i] = data[a + i] * it + data[b + i] * t;",
      ],
    ],
  },
  {
    name: "无轨道骨回落成单位 TRS（不是绑定姿势）",
    pairs: [
      [
        "    out.set(base);",
        "    out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 0; out[4] = 0; out[5] = 0; out[6] = 1; out[7] = 1; out[8] = 1;",
      ],
    ],
  },
  {
    name: "轨道按 boneId 字段找（文件里该字段恒为 0 ⇒ 每根骨都命中首轨）",
    pairs: [
      [
        "  if (boneCount > 0 && anim.tracks.length === boneCount && anim.tracks[bone]) return anim.tracks[bone];\n  return anim.tracks.find((t) => t.boneId === bone) ?? null;",
        "  return anim.tracks.find((t) => t.boneId === bone) ?? null;",
      ],
    ],
  },
];

const frameMatDiff = (a, b) => {
  let w = 0;
  for (let i = 0; i < 16; i++) w = Math.max(w, Math.abs(a[i] - b[i]));
  return w;
};

/** 引擎侧：解析 + 真实求值（单条替换层 blend=1，boneOverrides=null），返回 mdl（读 _local） */
function frameEngineLocals(P, S, bytes, animId, time, editPose) {
  const mdl = P.parseMDL(bytes);
  if (editPose) mdl._editPose = new Map([[editPose.bone, Float32Array.from(editPose.v)]]);
  S.computeSkinMatrices(mdl, time, [{ animation: animId, visible: true, additive: false, blend: 1, rate: 1 }], null);
  return mdl;
}

/** 编辑器侧：九分量 → 引擎自己的 composeTRS 合成（比的是 TRS 语义，不是各写一套矩阵） */
function frameEditorMat(ME, M, bytes, animId, bone, time, pose) {
  const trs = ME.mdlClipFrameTrs(bytes, animId, bone, time, pose);
  if (!trs) return null;
  return M.composeTRS(trs[0], trs[1], trs[2], trs[3], trs[4], trs[5], trs[6], trs[7], trs[8], new Float32Array(16));
}

/** light = 变异轮：只裁语料规模（合成用例与空轨道回落必须留着，否则变异咬不住） */
async function frameBattery(ME, P, S, M, W, LIB, check, light) {
  const fixtures = (light ? PUPPET_FIXTURES : [...PUPPET_FIXTURES, ...MESH_FIXTURES]).filter((id) =>
    fs.existsSync(path.join(LIB, id, "scene.pkg")),
  );
  const objsPerFixture = light ? 1 : 2;
  const animsPerObj = light ? 1 : 2;
  const timeCount = light ? 2 : 3;
  let models = 0;
  let pairs = 0;
  let tracked = 0;
  let noTrack = 0;
  let worst = 0;
  let worstAt = "";
  let miss = "";
  const cands = [];
  for (const id of fixtures) {
    const t = modelTruth(LIB, id);
    if (!t) continue;
    let used = 0;
    for (const o of t.objects) {
      if (used >= objsPerFixture) break;
      const bytes = t.read(o.info.mdlPath);
      let mdl = null;
      try {
        mdl = P.parseMDL(bytes);
      } catch {
        continue;
      }
      if (!mdl || !mdl.bones || !mdl.bones.length || !mdl.animations || !mdl.animations.length) continue;
      const anims = mdl.animations.filter((a) => a.frameCount > 0).slice(0, animsPerObj);
      if (!anims.length) continue;
      used++;
      models++;
      for (const a of anims) {
        const span = a.frameCount / (a.fps || 1);
        const times = [0, 0.5 * span, 0.999 * span].slice(0, timeCount);
        for (const time of times) {
          const eng = frameEngineLocals(P, S, bytes, a.id, time, null)._local;
          for (let i = 0; i < mdl.bones.length; i++) {
            const gm = frameEditorMat(ME, M, bytes, a.id, i, time, null);
            if (!gm) {
              miss = miss || `${id}#${o.id} anim${a.id} bone${i}`;
              continue;
            }
            const trk = a.tracks[i];
            if (trk && trk.keyframes.length) tracked++;
            else noTrack++;
            pairs++;
            const d = frameMatDiff(gm, eng[i]);
            if (d > worst) {
              worst = d;
              worstAt = `${id}#${o.id} anim${a.id} bone${i} t=${time.toFixed(3)}`;
            }
            if (!cands.length && trk && trk.keyframes.length) cands.push({ bytes, animId: a.id, bone: i });
          }
        }
      }
    }
  }
  check(models >= 3, `对账语料：含骨骼与动画轨道的模型 ${models} 个（≥3）`);
  check(pairs >= 150, `逐骨逐时刻对账样本 ${pairs} 组（有轨道 ${tracked} / 无轨道回落 ${noTrack}）`);
  check(!miss, `每根骨都有读数（缺 ${miss || "0"} 处）`);
  check(worst <= FRAME_EPS, `编辑器数据层 ≡ 引擎 computeSkinMatrices：最坏差值 ${worst.toExponential(2)} ≤ ${FRAME_EPS} @ ${worstAt || "—"}`);
  if (!cands.length) {
    check(false, "没取到有轨道的骨样本（后面的合成用例没法造）");
    return;
  }
  const s0 = cands[0];

  // ── 合成片段：真语料里 mode 只有 loop/single、相邻帧也未必跨 ±π，所以自己造 ──
  const syn = [];
  for (const mode of ["loop", "mirror", "single"]) {
    const added = ME.addMdlClip(s0.bytes, { name: `t34-${mode}`, mode, fps: 10, frameCount: 8 }, "rest", s0.animId);
    let b = added ? ME.applyBoneDelta(added.bytes, added.id, s0.bone, 0, { t: [30, -20, 5], r: [0, 0, 3.1] }, 0) : null;
    b = b && ME.applyBoneDelta(b, added.id, s0.bone, 1, { t: [-30, 20, -5], r: [0, 0, -3.1] }, 0);
    b = b && ME.applyBoneDelta(b, added.id, s0.bone, 4, { t: [40, -25, 0], r: [0, 0, 0.7], s: [1.5, 0.5, 1] }, -1);
    syn.push(b ? { mode, bytes: b, id: added.id } : null);
  }
  check(syn.every(Boolean), "合成三种 mode 的片段（loop/mirror/single，含逐帧差异与跨 ±π 的 r）");
  let synPairs = 0;
  let synBad = "";
  for (const s of syn) {
    if (!s) continue;
    for (const time of [0, 0.05, 0.35, 0.95, 1.6, 3.2]) {
      const eng = frameEngineLocals(P, S, s.bytes, s.id, time, null)._local;
      for (let i = 0; i < eng.length; i++) {
        const gm = frameEditorMat(ME, M, s.bytes, s.id, i, time, null);
        if (!gm) {
          synBad = synBad || `${s.mode} t=${time} bone${i} null`;
          continue;
        }
        const d = frameMatDiff(gm, eng[i]);
        synPairs++;
        if (d > FRAME_EPS) synBad = synBad || `${s.mode} t=${time} bone${i} 差 ${d.toExponential(2)}`;
        if (d > worst) {
          worst = d;
          worstAt = `synth/${s.mode} bone${i} t=${time}`;
        }
      }
    }
  }
  check(synPairs >= 30 && !synBad, `合成片段三种 mode 逐骨逐时刻一致：${synPairs} 组${synBad ? `，不符：${synBad}` : ""}`);

  // ── 编辑预览增量：t/r 相加、s 相乘（对 mdl-skin.js:429-434 的 _editPose 分支）──
  const pose = { t: [12, -7, 3], r: [0, 0, 0.25], s: [1.5, 0.5, 2] };
  const pose9 = [12, -7, 3, 0, 0, 0.25, 1.5, 0.5, 2];
  let posePairs = 0;
  let poseBad = "";
  let poseWorst = 0;
  for (const s of syn) {
    if (!s) continue;
    for (const time of [0, 0.05, 0.35]) {
      const eng = frameEngineLocals(P, S, s.bytes, s.id, time, { bone: s0.bone, v: pose9 })._local;
      const gm = frameEditorMat(ME, M, s.bytes, s.id, s0.bone, time, pose);
      if (!gm) {
        poseBad = poseBad || `${s.mode} t=${time} null`;
        continue;
      }
      const d = frameMatDiff(gm, eng[s0.bone]);
      posePairs++;
      poseWorst = Math.max(poseWorst, d);
      if (d > FRAME_EPS) poseBad = poseBad || `${s.mode} t=${time} 差 ${d.toExponential(2)}`;
    }
  }
  check(
    posePairs >= 9 && !poseBad,
    `编辑预览增量（t/r 相加、s 相乘）≡ 引擎 _editPose 分支：${posePairs} 组，最坏 ${poseWorst.toExponential(2)}${poseBad ? `，不符：${poseBad}` : ""}`,
  );

  // ── 无轨道骨回落：真语料每根骨都有轨道，手工造「轨道存在但空」的文档 ──
  let fbPairs = 0;
  let fbBad = "";
  try {
    const doc = W.readMdlDoc(s0.bytes);
    const mdla = (doc.sections || []).find((x) => x.type === "MDLA");
    const bone = s0.bone === 0 ? 1 : 0;
    const anim0 = mdla && mdla.anims && mdla.anims[0];
    if (anim0 && anim0.tracks[bone]) {
      anim0.tracks[bone].data = new Float32Array(0);
      const bytes = W.writeMdlDoc(doc);
      const animId = anim0.id;
      for (const time of [0, 0.5, 1.25]) {
        const mdl = P.parseMDL(bytes);
        const et = mdl.animations[0] && mdl.animations[0].tracks[bone];
        if (!et || et.keyframes.length !== 0) {
          fbBad = fbBad || "空轨道没写进文档";
          continue;
        }
        S.computeSkinMatrices(mdl, time, [{ animation: animId, visible: true, additive: false, blend: 1, rate: 1 }], null);
        const gm = frameEditorMat(ME, M, bytes, animId, bone, time, null);
        if (!gm) {
          fbBad = fbBad || `t=${time} null`;
          continue;
        }
        const d = frameMatDiff(gm, mdl._local[bone]);
        fbPairs++;
        if (d > FRAME_EPS) fbBad = fbBad || `t=${time} 差 ${d.toExponential(2)}`;
        if (d > worst) {
          worst = d;
          worstAt = `fallback bone${bone} t=${time}`;
        }
      }
    } else {
      fbBad = "造不出空轨道（文档里没有 MDLA 轨道）";
    }
  } catch (e) {
    fbBad = `造空轨道失败：${e.message}`;
  }
  check(fbPairs >= 3 && !fbBad, `无轨道骨回落绑定姿势（引擎 skip 空轨道）≡ 编辑器：${fbPairs} 组 3 个时刻${fbBad ? `，不符：${fbBad}` : ""}`);

  // ── API 形状与非法输入 ──
  const engMdl = P.parseMDL(s0.bytes);
  const engTrk = engMdl.animations.find((a) => a.id === s0.animId).tracks[s0.bone];
  const trk = ME.mdlClipTrack(s0.bytes, s0.animId, s0.bone);
  let bits = !!trk && trk.frameCount === engTrk.frameCount && trk.data.length === engTrk.keyframes.length;
  if (bits) for (let i = 0; i < engTrk.keyframes.length; i++) if (trk.data[i] !== engTrk.keyframes[i]) bits = false;
  check(bits, `mdlClipTrack 与引擎轨道逐位一致（骨 ${s0.bone}，${trk ? trk.frameCount : "?"} 帧）`);
  const base9 = ME.mdlBindTRS(s0.bytes, s0.bone);
  const engBase = engMdl.bindTRS[s0.bone];
  check(
    !!base9 && base9.length === 9 && [0, 1, 2, 3, 4, 5, 6, 7, 8].every((k) => base9[k] === engBase[k]),
    "mdlBindTRS 与引擎 bindTRS 逐位一致",
  );
  if (engMdl.bones.length > 1 && engMdl.animations[0].tracks[1] && engMdl.animations[0].tracks[1].keyframes.length) {
    const t0 = ME.mdlClipTrack(s0.bytes, s0.animId, 0);
    const t1 = ME.mdlClipTrack(s0.bytes, s0.animId, 1);
    check(!!t0 && !!t1 && t0.data[0] !== t1.data[0], "骨 0 / 骨 1 取到不同轨道（按轨序号索引，不是全命中 boneId=0 的首轨）");
  }
  check(
    ME.mdlClipTrack(s0.bytes, s0.animId, 99999) === null &&
      ME.mdlClipTrack(s0.bytes, -7, s0.bone) === null &&
      ME.mdlClipTrack(s0.bytes, s0.animId, s0.bone + 0.5) === null &&
      ME.mdlBindTRS(s0.bytes, 99999) === null &&
      ME.mdlClipFrameTrs(s0.bytes, s0.animId, s0.bone, Number.NaN) === null &&
      ME.mdlClipFrameTrs(s0.bytes, 999999, s0.bone, 0) === null,
    "越界骨号 / 不存在片段 / time 非有限 → null（不抛错）",
  );
}

export async function runFrameReconcileOffline({ check, section, LIB = DEFAULT_LIB }) {
  section("W18a 片段叠增量逐帧对账（task-34）：编辑器数据层 ≡ 引擎 computeSkinMatrices");
  let failed = 0;
  const c = (ok, msg) => {
    if (!ok) failed++;
    check(ok, msg);
  };
  const P = await imp("renderer/vendor/we-scene/render/mdl-parse.js");
  const S = await imp("renderer/vendor/we-scene/render/mdl-skin.js");
  const M = await imp("renderer/vendor/we-scene/render/mdl-math.js");
  const W = await imp("renderer/vendor/we-scene/pkg/mdl-write.js");
  const ME = await loadEditorModule(FRAME_ME);
  await frameBattery(ME, P, S, M, W, LIB, c, false);

  section(`变异红测（${FRAME_MUTATIONS.length} 条：把逐帧合成改坏必须被抓住）`);
  let red = 0;
  for (let i = 0; i < FRAME_MUTATIONS.length; i++) {
    const mut = FRAME_MUTATIONS[i];
    let hits = 0;
    try {
      const MM = await loadEditorModule(FRAME_ME, mut.pairs);
      await frameBattery(MM, P, S, M, W, LIB, (ok) => {
        if (!ok) hits++;
      }, true);
    } catch (e) {
      hits = hits || 1; // 改坏后直接抛异常也算判据抓住
      void e;
    }
    if (hits > 0) {
      red++;
      c(true, `M${i + 1} ${mut.name} → 判据变红（${hits} 条）`);
    } else {
      c(false, `M${i + 1} ${mut.name} → 判据全绿（这条判据没有覆盖该分支）`);
    }
  }
  return failed;
}

export async function runResidOffline({ check, section, LIB = DEFAULT_LIB }) {
  section("B6 残余（task-8）离线段：尾表姿势 / 片段排序 / 换图尺寸");
  let failed = 0;
  const c = (ok, msg) => {
    if (!ok) failed++;
    check(ok, msg);
  };
  const ME = await loadEditorModule(RESID_ME);
  const MODEL = await loadModelModule();
  const SM = await loadSceneMountModule();
  await residBattery(ME, MODEL, LIB, c, SM);
  await runFrameReconcileOffline({ check: c, section, LIB });

  section(`变异红测（${RESID_MUTATIONS.length} 条：判据把实现改坏必须抓住）`);
  let red = 0;
  const green = [];
  for (const mut of RESID_MUTATIONS) {
    let hits = 0;
    try {
      const onModel = mut.file === RESID_MODEL;
      const onMount = mut.file === SY_MOUNT;
      const MM = onModel || onMount ? ME : await loadEditorModule(RESID_ME, mut.pairs);
      const MUT = onModel ? await loadModelModule(mut.pairs) : MODEL;
      const SMUT = onMount ? await loadSceneMountModule(mut.pairs) : SM;
      await residBattery(MM, MUT, LIB, (ok) => {
        if (!ok) hits++;
      }, SMUT);
    } catch (e) {
      hits = hits || 1; // 改坏后直接抛异常也算判据抓住
      void e;
    }
    if (hits > 0) {
      red++;
      c(true, `M${red} ${mut.name} → 判据变红（${hits} 条）`);
    } else {
      green.push(mut.name);
      c(false, `M? ${mut.name} → 判据全绿（这条判据没有覆盖该分支）`);
    }
  }
  return failed;
}

// process.argv[1] 可能不存在（`node -e` / 纯 import 当库用）⇒ 先判空，避免 pathToFileURL(undefined) 抛错。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // 模式探针：给 RESID-0b..0e 一条零成本、可证伪的 CLI 契约检查（不跑判据、不碰 Chrome）
  if (process.env.VEM_MODE_PROBE) {
    console.log(`mode=${RUN_MODE}`);
    process.exit(0);
  }
  let failed = 0;
  const check = (ok, msg) => {
    if (!ok) failed++;
    (ok ? console.log : console.error)(`  ${ok ? "✓" : "✗"} ${msg}`);
  };
  if (RUN_MODE === "offline") {
    console.log("  mode=offline：离线段（RESID，纯 Node）");
    console.log("  真浏览器段由 --headless / verify-editor --headless 触发；本默认路径不启动 Chrome。");
  } else {
    console.log("  mode=browser：真浏览器段（自起 vite + 真 GPU Chrome）");
  }
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "verify-editor-model-"));
  try {
    if (RUN_MODE === "offline") {
      failed += await runResidOffline({ check, section: (t) => console.log(`\n${t}`), LIB: DEFAULT_LIB });
    } else {
      await runModelHeadless({ check, section: (t) => console.log(`\n${t}`), tmpRoot });
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
  console.log(failed ? `\n✗ ${failed} 处问题` : "\n✓ 全部通过");
  process.exit(failed ? 1 : 0);
}
