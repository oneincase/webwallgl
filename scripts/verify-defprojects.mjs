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
const camPath = await imp("renderer/vendor/we-scene/render/camera-path.js");
const { WE_BUILTIN_SHADERS } = await imp("renderer/vendor/we-scene/shaders-builtin.ts");
const mdlMod = await imp("renderer/vendor/we-scene/render/mdl.js");

const readText = (bytes) => dec.decode(bytes).replace(/^\uFEFF/, "");

/** 内置素材命名空间（local-assets/materials/<前缀>/*）——缺它不算引用断裂 */
const BUILTIN_TEX_PREFIX = /^(cookie|editor|fonts|gradient|lut|models|particle|pattern|util)\//;
/** models/util/* 是引擎内置模型命名空间（工程自带的 models/util/shadow.mdl 会真存在） */
const BUILTIN_MODEL_PREFIX = /^models\/util\//;

/**
 * WE 安装自带素材树（`<安装根>/assets`）。用于区分「引用真的断了」和
 * 「这是 WE 内置素材、不在工程里」：后者不判失败，但**列出来**——
 * 本仓对内置 shader 分三档：albedo 一族（generic*）在通用网格/图层程序里原生实现；
 * `WE_BUILTIN_SHADERS`（`renderer/vendor/we-scene/shaders-builtin.ts`，当前含官方
 * eagleflag 用的 `flag`）走本仓内置源；两者之外的 WE 内置 shader 仍会退回通用材质，
 * 属已知缺口而非装载错误（见 DEFAULTPROJECTS-PLAN §5.3 与附录 D 续十九）。
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
async function auditProject(dirName) {
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
  const builtinImplemented = [];
  const require1 = (rel, why) => {
    if (!rel || typeof rel !== "string") return false;
    if (has(rel)) return true;
    missing.push(`${rel}（${why}）`);
    return false;
  };
  /**
   * shader 引用：包内没有时按两级判 ——
   *   · 本仓**已实现**的引擎内置 shader（`WE_BUILTIN_SHADERS`，如 `flag`）：引用成立，
   *     记入 builtinImplemented（该层正常出图，见 DEFAULTPROJECTS-PLAN 续十九 / F42）；
   *   · WE 安装 assets/shaders 里存在、本仓未实现：记入 pendingBuiltin，说明该层会
   *     退回通用材质（已知缺口，不是装载错误）；
   * 两档都不成立才算引用断裂。
   */
  const requireShader = (name, why) => {
    if (has(`shaders/${name}.frag`) && has(`shaders/${name}.vert`)) return true;
    if (WE_BUILTIN_SHADERS[`${name}.frag`] && WE_BUILTIN_SHADERS[`${name}.vert`]) {
      builtinImplemented.push(`${name}（${why}）`);
      return true;
    }
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
    auditUserShaderValues(rel, doc); // 判据 6（函数声明提升，见下方定义）
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
        if (typeof pj.material === "string" && pj.material) {
          require1(pj.material, `${who}→粒子材质`);
          // 判据 6 也挂在粒子材质上（它不走 resolveMaterial，是被 require1 直接引用的）
          const pmEntry = getEntry(pkg, pj.material);
          if (pmEntry) {
            try {
              auditUserShaderValues(pj.material, parseJsonLoose(readText(pmEntry)));
            } catch {
              /* JSON 坏掉由上面的 require1/解析路径负责 */
            }
          }
        }
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

  // ---- 判据 7：多子网格模型的「每网格槽 0 贴图」必须**因网格而异**（F43 非空转闸门）----
  //
  // 背景：材质路径里槽 0（基色）的来源是 `layer.meshTextures[i] || mm.texture`，而宿主
  // 一度只给**没有材质规格**的网格填过 meshTextures ⇒ 有材质的子网格全落到 mesh 0 的
  // 基色（fantasticcar 六个子网格都在采样车漆那张通道图 → 前唇/后视镜/轮辋整片蓝青）。
  // 修完之后，这条判据要回答的是「语料里还有没有可观测的差异」：如果哪天语料里所有
  // 多子网格模型的槽 0 都一样，源码护栏就退化成空转，这里必须响。
  const multiMesh = { models: 0, distinct: 0, samples: [] };
  for (const o of scene.objects ?? []) {
    let mdlRel = typeof o.model === "string" ? o.model : null;
    if (!mdlRel && typeof o.image === "string") {
      if (/\.mdl$/i.test(o.image)) mdlRel = o.image;
      else if (/\.json$/i.test(o.image)) {
        const e = getEntry(pkg, o.image);
        const mj = e ? parseJsonLoose(readText(e)) : null;
        if (mj && typeof mj.puppet === "string") mdlRel = mj.puppet;
      }
    }
    if (!mdlRel) continue;
    const bytes = getEntry(pkg, mdlRel);
    if (!bytes) continue;
    let mdl;
    try {
      mdl = mdlMod.parseMDL(new Uint8Array(bytes));
    } catch {
      continue; // 残缺资产（audiophile grid）由 verify-mdl-source 负责报，这里只数材料
    }
    const meshes = mdl.meshes ?? [];
    if (meshes.length < 2) continue;
    multiMesh.models++;
    const slots = new Set();
    for (const m of meshes) {
      const me = m.materialPath ? getEntry(pkg, m.materialPath) : null;
      // 材质文档要**容忍 `//` 行注释**（fantasticcar 的 glass.json 就带一条被注释掉的
      // `"cullmode"`）：运行时走 eff.parseJsonTolerant，判据必须同一条链，否则这里
      // 会抛 JSON 语法错、把整个语料审计带崩。
      const p0 = me ? (eff.parseJsonTolerant(readText(me)).passes ?? [])[0] : null;
      const t0 = p0 && (p0.textures ?? [])[0];
      if (typeof t0 === "string" && t0) slots.add(t0);
    }
    if (slots.size >= 3) {
      multiMesh.distinct++;
      multiMesh.samples.push(`${dirName}/${o.name ?? o.id}（${meshes.length} 网格 / ${slots.size} 种槽 0）`);
    }
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

  // ---- 判据 5：场景级相机路径（`scene.json` 的 `camera.paths[]`）可解析且真的换机位 ----
  //
  // 官方 6 个 3D 工程（arsenal/demon_core/dna_fragment/fantasticcar/neon_sunset/ricepod）
  // 都是「没有相机实体 + 录了一条编辑器相机路径」：不解析就只能回落 `scene.camera`
  // 的编辑器视口快照，取景与官方出图整个不同（fantasticcar 实测：快照在车尾、
  // 路径首帧在车头右前方）。这里锁三件事：文件在包内、能建出 clip、首帧与
  // **静态快照**明显不同（否则判据没有区分力）。语义判据在 verify-camera §7。
  {
    const declPaths = scene.camera && scene.camera.paths;
    if (Array.isArray(declPaths) && declPaths.length) {
      const clips = [];
      for (const rel of declPaths) {
        if (!require1(rel, "scene.camera.paths")) continue;
        try {
          const doc = parseJsonLoose(readText(getEntry(pkg, rel)));
          for (const c of (Array.isArray(doc) ? doc : doc.paths) || []) clips.push(c);
        } catch (err) {
          errors.push(`${dirName}: 相机路径 ${rel} 解析失败（${(err && err.message) || err}）`);
        }
      }
      const built = camPath.createSceneCameraPath(clips);
      check(built.clips.length > 0, `${dirName}: scene.camera.paths 声明了路径但没建出 clip`);
      const first = built.tick(0);
      check(!!first, `${dirName}: 相机路径首帧求值失败`);
      const staticEye = String((scene.camera && scene.camera.eye) || "").trim().split(/\s+/).map(Number);
      if (first && staticEye.length >= 3 && staticEye.every(Number.isFinite)) {
        const d = Math.hypot(first.eye[0] - staticEye[0], first.eye[1] - staticEye[1], first.eye[2] - staticEye[2]);
        // 「路径首帧 ≠ 静态快照」只在 fantasticcar 成立：另外 5 个工程保存场景时相机
        // 正好停在路径首帧（距离 0.00），在那里这条判据没有区分力 —— 也正是这个「重合」
        // 让整条缺口（不解析路径）长期看不出来。故只对 fantasticcar 硬判，其余只报数。
        if (dirName === "fantasticcar") {
          check(d > 1, `${dirName}: 相机路径首帧与静态快照几乎重合（距离 ${d.toFixed(2)}）——判据失去区分力`);
        } else if (d > 1) {
          console.log(`  - ${dirName}: 相机路径首帧与静态快照相差 ${d.toFixed(2)}`);
        }
      }
    }
  }

  // ---- 判据 6：`usershadervalues` 的映射方向（挂在 resolveMaterial 上，见下） ----
  //
  // 语义（极易读反，故立判据）：**键 = project.json general.properties 的属性名，
  // 值 = shader 里 `// {"material":"名"}` 声明的物性名**。官方内置 9 个工程 51 条绑定
  // 全部符合（键 51/51 是属性、值 49/51 命中同名 shader 的物性名，余 2 条指向官方
  // genericparticle 的 tint，由内置实现消费）；工坊语料 0 条。方向反了会让
  // 「作者调的背景色/车漆色」整片不生效（fantasticcar 实测整场近黑）。
  //
  // 审计点选在 resolveMaterial：它对每条材质引用（对象/模型 sidecar/效果链/粒子）
  // 都已解析过文档，挂在这里天然覆盖全 —— 自己再走一遍对象列表会漏掉
  // 「效果链里的材质」「粒子材质」这些支路（实测漏 14/51）。
  function auditUserShaderValues(rel, doc) {
    if (usvAudited.has(rel)) return;
    usvAudited.add(rel);
    const props = Object.keys((project.general && project.general.properties) || {});
    const preset = project.preset && typeof project.preset === "object" ? Object.keys(project.preset) : [];
    const matNamesOf = (shader) => {
      const out = new Set();
      for (const ext of [".frag", ".vert"]) {
        let src = null;
        const inPkg = getEntry(pkg, `shaders/${shader}${ext}`);
        if (inPkg) src = readText(inPkg);
        else if (weAssets) {
          try {
            src = fs.readFileSync(path.join(weAssets, `shaders/${shader}${ext}`), "utf8");
          } catch {
            src = null;
          }
        }
        if (!src) continue;
        for (const m of src.matchAll(/"material"\s*:\s*"([^"]+)"/g)) out.add(m[1]);
      }
      return out;
    };
    for (const mp of doc.passes ?? []) {
      const usv = mp.usershadervalues;
      if (!usv || typeof usv !== "object") continue;
      const mats = mp.shader ? matNamesOf(mp.shader) : new Set();
      for (const [k, v] of Object.entries(usv)) {
        usvBindings++;
        check(
          props.includes(k) || preset.includes(k),
          `${dirName}: usershadervalues 的键 '${k}'（${rel}）不是 project.json 属性名 —— 绑定方向反了？`,
        );
        // 值只报数、不硬判：官方语料里就有 2 条指向 shader 里不存在的物性名
        // （demon_core / dna_fragment 的粒子材质 `schemecolor → tint`，而官方
        // `genericparticle.frag` 根本没有 tint 这个物性 —— WE 自己也只会静默忽略）。
        // 硬判它们等于要求语料比官方引擎更严格。方向由**键**锁住就够。
        if (mats.size > 0 && !mats.has(String(v))) {
          usvUnknownValue.push(`${dirName} ${rel}: '${k}' → '${v}'（shader ${mp.shader} 未声明该物性名）`);
        }
      }
    }
  }

  // ---- 判据 4：合成层材质条目零诊断 ----
  const diags = [];
  for (const shader of layerMaterialEffects) {
    const layer = { effects: [] };
    eff.attachLayerMaterialEffect(layer, { shader, textures: [], combos: {}, constantshadervalues: {} });
    for (const e of layer.effects) {
      await eff.resolveEffectChain(pkg, e, readText, () => {}, (m) => diags.push(`${shader}: ${m}`));
    }
  }
  check(
    diags.length === 0,
    `${dirName}: 层材质合成条目出现 ${diags.length} 条诊断（应为 0）—— ${diags[0] ?? ""}`,
  );

  return { pkg, missing, pendingBuiltin, builtinImplemented, sourceImages, scene, files: files.length, shaders: seenShader.size, tex: seenTex.size, multiMesh };
}

let scenes = 0;
let skips = 0;
/** 判据 6 审计到的 usershadervalues 绑定总数（非空转判据，见文件末尾） */
let usvBindings = 0;
/** 判据 6 已审计过的材质路径（同一份文档可能被多条引用链到达，只算一次） */
const usvAudited = new Set();
/** 判据 6 里「值指向 shader 未声明的物性名」的样本（只报数，不是失败） */
const usvUnknownValue = [];
const pendingBuiltinAll = new Map();
const builtinImplementedAll = new Map();
/** 判据 7：多子网格模型（判据见 auditProject）——{ models, distinct, samples } 全语料汇总 */
const multiMeshAll = { models: 0, distinct: 0, samples: [] };
const sourceImageAll = new Map();
for (const d of fs.readdirSync(root).filter((n) => fs.statSync(path.join(root, n)).isDirectory()).sort()) {
  if (!fs.existsSync(path.join(root, d, "project.json"))) continue;
  const r = await auditProject(d);
  if (r.skip) {
    skips++;
    console.log(`  - ${d}: 跳过（type=${r.skip}）`);
    continue;
  }
  scenes++;
  for (const p of r.pendingBuiltin ?? []) pendingBuiltinAll.set(p.split("（")[0], d);
  for (const p of r.builtinImplemented ?? []) builtinImplementedAll.set(p.split("（")[0], d);
  for (const s of r.sourceImages ?? []) sourceImageAll.set(s.split("（")[0], d);
  if (r.multiMesh) {
    multiMeshAll.models += r.multiMesh.models;
    multiMeshAll.distinct += r.multiMesh.distinct;
    multiMeshAll.samples.push(...r.multiMesh.samples);
  }
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

if (usvUnknownValue.length) {
  console.log(
    `  - usershadervalues 指向 shader 未声明的物性名（官方语料也有，WE 侧静默忽略）：` +
      usvUnknownValue.join("；"),
  );
}

console.log("");
if (sourceImageAll.size) {
  // 源码工程特有形态：引用有效、.tex 从未编译，运行时按源图回退（loadTex 已实现）
  console.log(
    `  - 源图回退（包内无 .tex，用 materials/<名>.png|jpg 解码）：` +
      [...sourceImageAll.entries()].map(([s, d]) => `${s}（${d}）`).join("、"),
  );
}
if (builtinImplementedAll.size) {
  // 正面信息：这些 shader 引用不在包内（WE 引擎自带），但由本仓 `WE_BUILTIN_SHADERS`
  // 实现 —— 与「待补」相对，说明该层能正常出图。
  console.log(
    `  - 引擎内置 shader（本仓已实现，正常出图）：` +
      [...builtinImplementedAll.entries()].map(([s, d]) => `${s}（${d}）`).join("、"),
  );
}
if (pendingBuiltinAll.size) {
  // 已知缺口，不是装载错误：本仓只原生实现了 albedo（generic*）一族与
  // WE_BUILTIN_SHADERS 表（当前含 flag）；两者之外的 WE 内置 shader 会退回通用材质。
  console.log(
    `  - 待补内置 shader（本仓未原生实现，该层退回通用材质）：` +
      [...pendingBuiltinAll.entries()].map(([s, d]) => `${s}（${d}）`).join("、"),
  );
}

console.log("");
if (scenes === 0) console.log("  - 跳过：语料中没有 scene 工程");
else console.log(`共审计 ${scenes} 个 scene 工程（跳过 ${skips} 个非场景）`);

// 判据 6 的非空转闸门：语料 9 个工程共 51 条绑定，离线审计覆盖 42 条。未覆盖的 9 条
// 挂在**多子网格模型的非首网格材质**上（fantasticcar 的 car/interior|matte|taillights|
// wheel、techno 的 orbit*）与 dna_fragment 的粒子材质上 —— 前者只从 .mdl 内的逐网格
// 材质记录引用，离线这里只读第一个内嵌材质路径（那一层由 verify-mdl 系列 + 运行时的
// 多子网格链覆盖）。审计路径写错（材质链走不到、shader 源读不到）会让这个数字跳水，
// 那时「方向正确」就不再是判据，只是没查。
// 引擎内置 shader 判据的非空转闸门：语料里唯一一条（eagleflag 的 `flag`）认不到就说明
// 「包内没有 → 看内置表」这条链断了（判据会静默变成永不触发的空转）。
if (weAssets) {
  check(
    [...builtinImplementedAll.keys()].includes("flag"),
    "引擎内置 shader 判据空转：语料里应有 flag（eagleflag），实际一条未认到",
  );
}
// 判据 7 的非空转闸门（F43）：内置语料里必须有**若干**多子网格模型、其槽 0 贴图因网格而异
// —— 这正是「材质路径的槽 0 必须按网格取」这条源码护栏的可观测面。实测：arsenal/pistols 6/6、
// fantasticcar/Car 6/5、ricepod 两个模型 3/3。数字跳水说明语料换了形态或解析链走丢。
if (multiMeshAll.samples.length) {
  console.log(`  - 多子网格模型槽 0 因网格而异（F43）：${multiMeshAll.samples.join("、")}`);
}
check(multiMeshAll.distinct >= 3,
  `多子网格 + 槽 0 各不相同的模型只有 ${multiMeshAll.distinct} 个（基线 4：arsenal/fantasticcar/ricepod×2）—— F43 判据可能空转`);
console.log(`  - usershadervalues 审计：${usvBindings} 条绑定（离线覆盖 42 / 语料全部 51）`);
check(usvBindings >= 38, `usershadervalues 审计到的绑定数异常：${usvBindings}（基线 42）—— 判据可能空转`);

console.log("");
if (errors.length > 0) {
  console.log(`✗ 共 ${errors.length} 处问题`);
  process.exit(1);
} else {
  console.log("✓ 全部通过");
}
