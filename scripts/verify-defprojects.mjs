#!/usr/bin/env node
/**
 * verify-defprojects —— 官方内置**源码工程**的离线装载判据（DEFAULTPROJECTS-PLAN P0）。
 *
 * 背景：WE 安装目录 `projects/defaultprojects/**` 的官方壁纸是**散装目录**（没有
 * scene.pkg）。本仓历史只吃 pkg，于是「装载」这一层此前完全没有判据 —— 出问题时
 * 表现与渲染缺陷一样（黑屏/不挂载），排查极易走错方向。本脚本把三条判据固化：
 *
 *   1. **场景条目可命中**（F1）：`project.json.file` 指向的 json 必须能从包里取到
 *      （官方 4 个工程用 audiophile.json / fantasticcar.json / ricepod.json / techno.json，
 *      只按四条固定候选找会整场挂载失败）；
 *   2. **引用完整性**（F7）：scene.json 里每个 image/model/particle/sprite/effects/sound
 *      引用、材质链上的 shader 与贴图，都要能在包里解析到；缺的只允许是**内置命名空间**
 *      （materials/{particle,util,gradient,pattern,lut,cookie,models,fonts}/*、
 *      models/util/*、内置 albedo shader）——这些走 local-assets/程序化复刻通路；
 *   3. **零假诊断**（F6）：层材质（非内置 shader）合成的效果条目不得触发
 *      「效果文件不在包内」——它 file 恒为空串、passes 早已填好，此前每层刷一条。
 *
 * 跳过语义：本机没装 WE / 没有 defaultprojects 时打印 `-` 并**不计失败**
 * （与 verify-effects 对空语料的处理同语义）；目录位置可用 WE_DEFAULTPROJECTS 指定，
 * 或 WE_INSTALL 指向 WE 安装根（其 projects/defaultprojects）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT, imp, createChecker, dec } from "./lib/verify-kit.mjs";
import { packSourceProject } from "./dev-pack-pkg.mjs";

const { check, fail, errors } = createChecker({ echo: true });

const { parsePkg, getEntry } = await imp("renderer/vendor/we-scene/pkg/container.js");
const { isPerspectiveScene } = await imp("renderer/vendor/we-scene/render/math.js");
const scn = await imp("renderer/vendor/we-scene/scene/parse.js");
const eff = await imp("renderer/vendor/we-scene/scene/effects-parse.js");

const readText = (bytes) => dec.decode(bytes).replace(/^\uFEFF/, "");

/** 内置素材命名空间（local-assets/materials/<前缀>/*）——缺它不算引用断裂 */
const BUILTIN_TEX_PREFIX = /^(cookie|editor|fonts|gradient|lut|models|particle|pattern|util)\//;
/** models/util/* 是引擎内置模型命名空间（工程自带的 models/util/shadow.mdl 会真存在） */
const BUILTIN_MODEL_PREFIX = /^models\/util\//;

/**
 * WE 安装自带素材树（`<安装根>/assets`）。用于区分「引用真的断了」和
 * 「这是 WE 内置素材、不在工程里」：后者不判失败，但**列出来**——
 * 本仓对内置 shader 只原生实现了 albedo 一族（generic*），其余（如 `flag`）
 * 目前会退回通用材质，属已知缺口而非装载错误（见 DEFAULTPROJECTS-PLAN §5.3）。
 */
let weAssets = null;
function weAssetExists(rel) {
  if (!weAssets) return false;
  try {
    return fs.existsSync(path.join(weAssets, rel));
  } catch {
    return false;
  }
}

function parseJsonLoose(text) {
  try {
    return JSON.parse(text);
  } catch {
    return JSON.parse(text.replace(/,(\s*[}\]])/g, "$1"));
  }
}

/** WE 安装目录候选（含外置 Steam 库的常见形态） */
function locateDefaultProjects() {
  const fromEnv = [process.env.WE_DEFAULTPROJECTS, process.env.WE_INSTALL && path.join(process.env.WE_INSTALL, "projects", "defaultprojects")].filter(Boolean);
  const home = os.homedir();
  const candidates = [...fromEnv];
  const tails = ["steamapps/common/wallpaper_engine/projects/defaultprojects"];
  for (const h of ["Library/Application Support/Steam", ".steam/steam", ".local/share/Steam"]) {
    for (const t of tails) candidates.push(path.join(home, h, t));
  }
  candidates.push("C:/Program Files (x86)/Steam/steamapps/common/wallpaper_engine/projects/defaultprojects");
  // macOS 外置库：/Volumes/*/SteamLibrary/...（本机实测路径就在这类挂载点）
  if (process.platform === "darwin" && fs.existsSync("/Volumes")) {
    let vols = [];
    try {
      vols = fs.readdirSync("/Volumes");
    } catch {
      vols = [];
    }
    for (const v of vols) {
      for (const t of tails) candidates.push(path.join("/Volumes", v, "SteamLibrary", t));
    }
  }
  for (const c of candidates) {
    try {
      if (c && fs.statSync(c).isDirectory()) return c;
    } catch {
      /* 继续找 */
    }
  }
  return null;
}

const root = locateDefaultProjects();
if (!root) {
  console.log("  - 跳过：未找到 WE defaultprojects（可用 WE_DEFAULTPROJECTS / WE_INSTALL 指定）");
  console.log("");
  console.log("✓ 全部通过");
  process.exit(0);
}
console.log(`语料：${root}`);
// projects/defaultprojects → 安装根 → assets（内置素材树；目录不存在时整条判定退化为「按命名空间放行」）
{
  const candidate = path.join(path.dirname(path.dirname(root)), "assets");
  if (fs.existsSync(candidate)) weAssets = candidate;
}

/** 收集一个工程的全部引用（scene.json → 材质链 → shader/贴图） */
function auditProject(dirName) {
  const dir = path.join(root, dirName);
  const projectRaw = fs.readFileSync(path.join(dir, "project.json"), "utf8");
  const project = parseJsonLoose(projectRaw);
  const type = String(project.type ?? "").toLowerCase();
  // 跳过判据：显式 web/application；或没有 type 且 file 不是 .json（sheep.exe 这类
  // 无 type 的应用壁纸 —— 按内容推断的完整规则在 host/we-library-scan.mjs，这里只
  // 需要「是不是源码场景工程」这一刀）
  const fileDecl = typeof project.file === "string" ? project.file.trim() : "";
  if (type === "web" || type === "application") return { skip: type };
  if (type !== "scene" && !/\.json$/i.test(fileDecl)) return { skip: type || "non-json" };

  const { buffer, files } = packSourceProject(dir);
  const pkg = parsePkg(buffer);
  const has = (rel) => !!getEntry(pkg, rel);
  const missing = [];
  const pendingBuiltin = [];
  const require1 = (rel, why) => {
    if (!rel || typeof rel !== "string") return false;
    if (has(rel)) return true;
    missing.push(`${rel}（${why}）`);
    return false;
  };
  /**
   * shader 引用：包内没有时，先看 WE 安装的 assets/shaders —— 存在 = WE 内置素材
   * （记入 pendingBuiltin，说明本仓未原生实现，该层会退回通用材质），
   * 不存在才算引用断裂。
   */
  const requireShader = (name, why) => {
    if (has(`shaders/${name}.frag`) && has(`shaders/${name}.vert`)) return true;
    if (weAssetExists(`shaders/${name}.frag`) && weAssetExists(`shaders/${name}.vert`)) {
      pendingBuiltin.push(`${name}（${why}）`);
      return true;
    }
    missing.push(`shaders/${name}.frag + .vert（${why}）`);
    return false;
  };
  /**
   * 贴图引用：`materials/<名>.tex`。三种合法缺席 ——
   *   · WE 内置命名空间（particle/util/gradient/…）：走 local-assets/程序化复刻；
   *   · WE 安装素材树里有同名 .tex：同样是内置素材；
   *   · 只有**源图**（materials/<名>.png|jpg）：源码工程里 .tex 可能从未编译
   *     （audiophile 的 grid.png 就是），运行时已实现源图回退（scene-mount loadTex）。
   */
  const sourceImages = [];
  const requireTexture = (t, why) => {
    if (BUILTIN_TEX_PREFIX.test(t)) return true;
    if (has(`materials/${t}.tex`)) return true;
    if (weAssetExists(`materials/${t}.tex`)) return true;
    for (const ext of ["png", "jpg", "jpeg"]) {
      if (has(`materials/${t}.${ext}`)) {
        sourceImages.push(`${t}.${ext}（${why}）`);
        return true;
      }
    }
    missing.push(`materials/${t}.tex（${why}）`);
    return false;
  };

  // ---- 判据 1：场景条目 ----
  const declared = typeof project.file === "string" ? project.file.trim().replace(/^\.?\//, "") : "";
  const cands = scn.sceneEntryCandidates(project);
  const hit = cands.find((n) => has(n)) ?? null;
  check(!!hit, `${dirName}: 场景条目未命中，候选 ${cands.join(" / ")}`);
  if (declared && /\.json$/i.test(declared)) {
    check(hit === declared, `${dirName}: 场景条目应优先命中 project.file=${declared}，实际 ${hit}`);
  }

  const sceneRel = hit;
  if (!sceneRel) return { pkg, missing, scene: null };
  const scene = parseJsonLoose(readText(getEntry(pkg, sceneRel)));

  // ---- 判据 2：引用完整性 ----
  const seenTex = new Set();
  const seenShader = new Set();
  const layerMaterialEffects = [];
  const resolveMaterial = (rel, why) => {
    if (!require1(rel, why)) return;
    const doc = parseJsonLoose(readText(getEntry(pkg, rel)));
    for (const mp of doc.passes ?? []) {
      if (mp.material) {
        if (!rel.startsWith("materials/util/")) resolveMaterial(mp.material, `${why}→材质嵌套`);
        continue;
      }
      if (typeof mp.shader === "string" && mp.shader) {
        const builtin = eff.isBuiltinAlbedoShader(mp.shader);
        seenShader.add(mp.shader);
        if (!builtin) {
          requireShader(mp.shader, `${why}→shader`);
          layerMaterialEffects.push(mp.shader);
        }
      }
      for (const t of mp.textures ?? []) {
        if (typeof t !== "string" || !t || t.startsWith("_rt_")) continue;
        seenTex.add(t);
        requireTexture(t, `${why}→贴图`);
      }
    }
  };

  const resolveModelSidecar = (mdlRel, why) => {
    const jsonRel = mdlRel.replace(/\.mdl$/i, ".json");
    if (has(jsonRel)) {
      const doc = parseJsonLoose(readText(getEntry(pkg, jsonRel)));
      // 模型 sidecar 的材质链：skins 里的变体名、或模型内嵌 material（后者在 .mdl 里，
      // 离线不解析，交由 verify-mdl 系列覆盖）；这里只保证 sidecar 自身可解析。
      void doc;
    }
  };

  for (const o of scene.objects ?? []) {
    const who = `对象 ${o.id ?? "?"}${o.name ? `(${o.name})` : ""}`;
    if (typeof o.image === "string") {
      // models/util/* 是引擎内置模型命名空间（fullscreenlayer / projectlayer /
      // composelayer / solidlayer）——不在工程里是预期状态
      if (!BUILTIN_MODEL_PREFIX.test(o.image) || has(o.image)) {
        const rel = require1(o.image, `${who}→模型 json`) ? o.image : "";
        if (rel) {
          const mj = parseJsonLoose(readText(getEntry(pkg, rel)));
          if (typeof mj.material === "string") resolveMaterial(mj.material, who);
        }
      }
    }
    if (typeof o.model === "string") {
      if (require1(o.model, `${who}→模型`)) {
        resolveModelSidecar(o.model, who);
        // .mdl 内嵌材质路径（0x15 起 cstring，相对工程根）：源码族模型只有这一条
        // 材质来源（没有 sidecar 时），所以要连它的 passes 一起审计
        const bytes = getEntry(pkg, o.model);
        let end = 0x15;
        while (end < bytes.length && bytes[end] !== 0) end++;
        const matRel = dec.decode(bytes.slice(0x15, end));
        if (matRel && /\.json$/i.test(matRel)) resolveMaterial(matRel, `${who}→模型内嵌材质`);
      }
    }
    if (typeof o.particle === "string") {
      if (require1(o.particle, `${who}→粒子配置`)) {
        const pj = parseJsonLoose(readText(getEntry(pkg, o.particle)));
        if (typeof pj.material === "string" && pj.material) require1(pj.material, `${who}→粒子材质`);
      }
    }
    if (typeof o.sprite === "string") {
      if (require1(o.sprite, `${who}→sprite 配置`)) {
        const sj = parseJsonLoose(readText(getEntry(pkg, o.sprite)));
        for (const mp of sj.passes ?? []) {
          if (typeof mp.shader === "string" && !eff.isBuiltinAlbedoShader(mp.shader)) {
            requireShader(mp.shader, `${who}→sprite`);
          }
          for (const t of mp.textures ?? []) {
            if (typeof t !== "string" || !t || t.startsWith("_rt_")) continue;
            requireTexture(t, `${who}→sprite 贴图`);
          }
        }
      }
    }
    for (const e of o.effects ?? []) {
      if (typeof e.file === "string" && e.file) {
        if (require1(e.file, `${who}→效果`)) {
          const ej = parseJsonLoose(readText(getEntry(pkg, e.file)));
          for (const p of ej.passes ?? []) if (p.material) resolveMaterial(p.material, `${who}→${e.file}`);
        }
      }
    }
    for (const s of o.sound ?? []) require1(s, `${who}→声音`);
    // font 不查：官方字体在 WE 安装 assets/fonts（工程外），本仓回退系统字体
  }

  // ---- 判据 3：2D/3D 判据（isPerspectiveScene）与场景内容一致 ----
  // 官方内置里 8 个 3D 工程（含 model 对象、general 无 orthogonalprojection 也不写 fov）
  // 必须被判成透视场景 —— 旧判据要求 fov>0，把它们当 2D 像素正交，模型层 MVP 退化成
  // 像素空间（实测缩放 0.002），整屏黑。工坊语料对照：「无正交且无 fov」0 个，
  // 「有 fov 无正交」5 个，其余 344 个带正交，所以这条只会影响这一类场景。
  {
    // 唯一不变式：**声明了正交投影 ⇔ 非透视**（与场景里有没有 model 无关 ——
    // retro 就是正交 2D 场景里放了一个 bgfade 网格）。官方 8 个 3D 工程不写 fov，
    // 旧判据把它们的模型画进像素空间（MVP 缩放 0.002）→ 整屏黑。
    const persp = isPerspectiveScene(scene);
    const o = (scene.general ?? {}).orthogonalprojection;
    const orthoDeclared = (o && typeof o === "object" && Object.keys(o).length > 0) || (!!o && typeof o !== "object");
    check(
      persp === !orthoDeclared,
      `${dirName}: 2D/3D 判据与 general 声明不符（判为透视=${persp} 声明正交=${!!orthoDeclared}）`,
    );
  }

  // ---- 判据 4：合成层材质条目零诊断 ----
  const diags = [];
  for (const shader of layerMaterialEffects) {
    const layer = { effects: [] };
    eff.attachLayerMaterialEffect(layer, { shader, textures: [], combos: {}, constantshadervalues: {} });
    for (const e of layer.effects) {
      eff.resolveEffectChain(pkg, e, readText, () => {}, (m) => diags.push(`${shader}: ${m}`));
    }
  }
  check(
    diags.length === 0,
    `${dirName}: 层材质合成条目出现 ${diags.length} 条诊断（应为 0）—— ${diags[0] ?? ""}`,
  );

  return { pkg, missing, pendingBuiltin, sourceImages, scene, files: files.length, shaders: seenShader.size, tex: seenTex.size };
}

let scenes = 0;
let skips = 0;
const pendingBuiltinAll = new Map();
const sourceImageAll = new Map();
for (const d of fs.readdirSync(root).filter((n) => fs.statSync(path.join(root, n)).isDirectory()).sort()) {
  if (!fs.existsSync(path.join(root, d, "project.json"))) continue;
  const r = auditProject(d);
  if (r.skip) {
    skips++;
    console.log(`  - ${d}: 跳过（type=${r.skip}）`);
    continue;
  }
  scenes++;
  for (const p of r.pendingBuiltin ?? []) pendingBuiltinAll.set(p.split("（")[0], d);
  for (const s of r.sourceImages ?? []) sourceImageAll.set(s.split("（")[0], d);
  if (r.missing.length) {
    fail(`${d}: ${r.missing.length} 处引用在包内解析不到`);
    for (const m of r.missing.slice(0, 8)) console.log(`      · ${m}`);
    if (r.missing.length > 8) console.log(`      · … 另 ${r.missing.length - 8} 处`);
  } else {
    console.log(
      `  ✓ ${d}: 场景条目命中，${r.files} 个文件入包，` +
        `shader ${r.shaders} 个 / 贴图 ${r.tex} 个引用齐全`,
    );
  }
}

console.log("");
if (sourceImageAll.size) {
  // 源码工程特有形态：引用有效、.tex 从未编译，运行时按源图回退（loadTex 已实现）
  console.log(
    `  - 源图回退（包内无 .tex，用 materials/<名>.png|jpg 解码）：` +
      [...sourceImageAll.entries()].map(([s, d]) => `${s}（${d}）`).join("、"),
  );
}
if (pendingBuiltinAll.size) {
  // 已知缺口，不是装载错误：WE 内置图像 shader 本仓只原生实现了 albedo（generic*）一族，
  // 其余（本语料里是 flag）会退回通用材质 —— 该层的自定义顶点/像素效果丢失。
  console.log(
    `  - 待补内置 shader（本仓未原生实现，该层退回通用材质）：` +
      [...pendingBuiltinAll.entries()].map(([s, d]) => `${s}（${d}）`).join("、"),
  );
}

console.log("");
if (scenes === 0) console.log("  - 跳过：语料中没有 scene 工程");
else console.log(`共审计 ${scenes} 个 scene 工程（跳过 ${skips} 个非场景）`);

console.log("");
if (errors.length > 0) {
  console.log(`✗ 共 ${errors.length} 处问题`);
  process.exit(1);
} else {
  console.log("✓ 全部通过");
}
