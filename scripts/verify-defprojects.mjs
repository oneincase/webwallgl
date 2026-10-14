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
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { ROOT, LIB, imp, createChecker, dec } from "./lib/verify-kit.mjs";
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
        // 判据 8（F46）非空转闸门：混合 pass（translucent/additive）是「材质路径的
        // 深度写必须排除它们」这条源码护栏的可观测面。样本要能追到具体模型
        // （neon_sunset 的 neonsun/neongrid 就是用户实测的回归样本）。
        const bl = typeof mp.blending === "string" ? mp.blending : "";
        if (bl && bl !== "normal") blendedPassAll.push(`${why}:${mp.shader}:${bl}:depthwrite=${mp.depthwrite ?? "缺省→enabled"}`);
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
    // 判据 9（F47）的采集点：模型材质里引用引擎内置 `generic` 的条数。它与多子网格
    // 无关（arsenal 的枪械是 6 网格、桌面是单网格），所以放在 `meshes.length < 2`
    // 的早退**之前**。语料里没有它 → 源码护栏（verify-shaders 的语义钉）就空转。
    for (const m of meshes) {
      const me9 = m.materialPath ? getEntry(pkg, m.materialPath) : null;
      if (!me9) continue;
      const p9 = (eff.parseJsonTolerant(readText(me9)).passes ?? [])[0];
      if (p9 && String(p9.shader ?? "").toLowerCase() === "generic") {
        genericModelMatAll++;
        if (genericModelMatSamples.length < 6) genericModelMatSamples.push(`${dirName}/${o.name ?? o.id}（${m.materialPath}）`);
      }
    }
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
/** 判据 8（F46）：混合（translucent/additive）材质 pass 的全语料清单，见 auditProject */
const blendedPassAll = [];
/** 判据 9（F47）：模型材质引用引擎内置 `generic` 的条数与样本（非空转门） */
let genericModelMatAll = 0;
const genericModelMatSamples = [];
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

// 判据 8 的非空转闸门（F46）：材质路径「混合 pass 不写深度」这条规则的可观测面是
// 语料里那些 blending 非 normal 的模型材质 —— 首当其冲就是 neon_sunset 的 neonsun/
// neongrid（显式 depthwrite=enabled + translucent，用户实测的「太阳外围黑方块」）。
// 语料换了形态、或 blending 的读取链走丢，这里必须响：源码护栏还绿着，但它已经空转。
if (blendedPassAll.length) {
  const modelBlended = blendedPassAll.filter((s) => /模型|mdl/i.test(s));
  console.log(`  - 混合材质 pass（F46）：${blendedPassAll.length} 处（其中模型材质 ${modelBlended.length} 处）：${blendedPassAll.slice(0, 6).join("、")}${blendedPassAll.length > 6 ? "…" : ""}`);
}
check(blendedPassAll.length >= 30,
  `审计到的混合材质 pass 只有 ${blendedPassAll.length} 处（基线 40+，含 neon_sunset 的 neonsun/neongrid）—— F46 判据可能空转`);
check(blendedPassAll.some((s) => s.includes(":neonsun:translucent")),
  "语料里应能认到 neon_sunset 的 neonsun:translucent（F46 的实测样本），实际一条未命中");

// 判据 9 的非空转闸门（F47）：引擎内置模型着色器 `generic` 的仓内实现（shaders-builtin.ts）
// 只有在内置语料真的引用它时才有意义 —— arsenal 的 6 个模型材质就是它的全部消费面
// （工坊 366 包里另有 1 个）。数字跳水说明语料换了形态、或 .mdl→材质链走丢。
if (genericModelMatAll) {
  console.log(`  - 模型材质引用内置 generic（F47）：${genericModelMatAll} 处，如 ${genericModelMatSamples.join("、")}`);
}
check(genericModelMatAll >= 5,
  `模型材质引用内置 generic 的只有 ${genericModelMatAll} 处（基线 6，全在 arsenal）—— F47 判据可能空转`);
check(
  typeof WE_BUILTIN_SHADERS["generic.frag"] === "string" && WE_BUILTIN_SHADERS["generic.frag"].trim() &&
    typeof WE_BUILTIN_SHADERS["generic.vert"] === "string" && WE_BUILTIN_SHADERS["generic.vert"].trim(),
  "generic 的仓内实现缺失：无原版素材的机器上 arsenal 会整体回落素模（F47）",
);

// ==========================================================================
// 判据 10（G3/G4，E3 DEFAULTPROJECTS 定案）：材质皮肤变体 + 被显式忽略的对象字段
// ==========================================================================
// G3 `skins` / 对象 `skin: N`
//   官方内置语料里 `skins` 只在 3 个模型 json 出现（audiophile/models/grid/grid.json、
//   techno/models/techno/sphere.json、fantasticcar/models/grid/grid.json），对象 `skin`
//   只有 1 处（audiophile.json 的 grid 层写 skin:1）。键语义由语料定死：techno 的键
//   `techno` 是**材质目录名**（materials/techno/），既不是模型名 sphere 也不是材质基名
//   technohex ⇒ 键 = 材质目录、值 = 材质基名；三例 skins[0] 都是恒等映射。
//   下面每条都是**真解析产物**：packSourceProject → parsePkg → getEntry 取真 .mdl/.json
//   字节 → mdlMod.parseMDL 解出内嵌材质路径 + 真 skins 表 → 走引擎真实的
//   scn.applySkinToMaterialPath / scn.skinIndexOf；没有任何「grep 源码」式判据
//   （源码只用于反向断言：证明引擎**没有**别的读点）。
// G4 被忽略字段（locktransforms / ledsource / blockalign / particlesrc）
//   定案 = 显式忽略 + info 诊断；判据 = 语料普查基线 + 反向断言（引擎不得有直接读点）
//   + 诊断函数的行为单测（真值才提示、每字段一次）+ 挂载点结构断言。
const PARSE_REL = "renderer/vendor/we-scene/scene/parse.js";
const SM_REL = "renderer/src/scene-mount.ts";
const sha256File = (rel) => createHash("sha256").update(fs.readFileSync(path.join(ROOT, rel))).digest("hex");
const dpDir = (name) => path.join(root, name);
const dpPack = (name) => {
  const dir = dpDir(name);
  if (!fs.existsSync(path.join(dir, "project.json"))) return null;
  try {
    return parsePkg(packSourceProject(dir).buffer);
  } catch {
    return null;
  }
};

const SKIN_TABLE = [{ grid: "grid" }, { grid: "grid2" }];
const SKIN_CASES = [
  { proj: "audiophile", scene: "audiophile.json", mdl: "models/grid/grid.mdl", sidecar: "models/grid/grid.json", skin: 1, want: "materials/grid/grid2.json", pick: true },
  { proj: "techno", scene: "techno.json", mdl: "models/techno/sphere.mdl", sidecar: "models/techno/sphere.json", skin: 0, want: "materials/techno/technohex.json", pick: false },
  { proj: "fantasticcar", scene: "fantasticcar.json", mdl: "models/grid/grid.mdl", sidecar: "models/grid/grid.json", skin: 0, want: "materials/grid/grid.json", pick: false },
];

/** G3 全套判据；`api` = parse.js 模块（可换成变异版），`tag` = 变异红测前缀 */
function g3Checks(api, tag) {
  const t = tag ? `${tag} ` : "";
  for (const c of SKIN_CASES) {
    const pkg = dpPack(c.proj);
    if (!pkg) continue;
    const mdlBytes = getEntry(pkg, c.mdl);
    const sideBytes = getEntry(pkg, c.sidecar);
    if (!mdlBytes || !sideBytes) continue;
    const mdl = mdlMod.parseMDL(new Uint8Array(mdlBytes));
    const side = parseJsonLoose(readText(sideBytes));
    const skins = Array.isArray(side.skins) ? side.skins : null;
    check(!!mdl.materialPath, `${t}G3 ${c.proj}: ${c.mdl} 应解出内嵌材质路径`);
    check(!!skins, `${t}G3 ${c.proj}: ${c.sidecar} 应有 skins 数组`);
    const got = api.applySkinToMaterialPath(mdl.materialPath, skins, c.skin);
    check(got === c.want, `${t}G3 ${c.proj}: skin=${c.skin} 应得 ${c.want}，实际 ${got}`);
    if (c.skin > 0) check(got !== mdl.materialPath, `${t}G3 ${c.proj}: skin=${c.skin} 必须与模型内嵌材质不同（判据不能空转）`);
    if (Array.isArray(mdl.meshes) && mdl.meshes.length && mdl.meshes[0].materialPath) {
      const mm = api.applySkinToMaterialPath(mdl.meshes[0].materialPath, skins, c.skin);
      check(mm === c.want, `${t}G3 ${c.proj}: 子网格材质也应换到 ${c.want}，实际 ${mm}`);
    }
    const entry0 = skins && skins[c.skin] && typeof skins[c.skin] === "object" ? Object.entries(skins[c.skin])[0] : null;
    if (entry0 && String(entry0[0]).length) {
      check(c.want === `materials/${entry0[0]}/${entry0[1]}.json`,
        `${t}G3 ${c.proj}: 皮肤表应直接给出 ${c.want}，实际键 ${entry0[0]} 值 ${entry0[1]}（键=材质目录、值=基名）`);
    }
    if (c.pick) {
      const sceneBytes = getEntry(pkg, c.scene);
      const scene = sceneBytes ? parseJsonLoose(readText(sceneBytes)) : null;
      const hits = ((scene && scene.objects) || []).filter((o) => Object.prototype.hasOwnProperty.call(o, "skin"));
      check(hits.length === 1, `${t}G3 ${c.proj}: 应恰好 1 个对象写 skin，实际 ${hits.length}`);
      if (hits.length === 1) {
        check(api.skinIndexOf(hits[0]) === c.skin, `${t}G3 ${c.proj}: 对象闸门应得 skin=${c.skin}，实际 ${api.skinIndexOf(hits[0])}`);
      }
      check(!!getEntry(pkg, c.want), `${t}G3 ${c.proj}: 变体材质 ${c.want} 必须在包内`);
    }
  }
  const p0 = "materials/grid/grid.json";
  check(api.applySkinToMaterialPath(p0, SKIN_TABLE, null) === p0, `${t}G3 skin=null 必须恒等（无 skin 字段 = 现状，逐位不变）`);
  check(api.applySkinToMaterialPath(p0, SKIN_TABLE, 0) === p0, `${t}G3 skin=0 应落到第 0 套（此例恒等）`);
  check(api.applySkinToMaterialPath(p0, SKIN_TABLE, 1) === "materials/grid/grid2.json", `${t}G3 skin=1 应取第 2 套`);
  check(api.applySkinToMaterialPath(p0, SKIN_TABLE, 2) === p0, `${t}G3 skin 越界必须回落第 0 套`);
  check(api.applySkinToMaterialPath(p0, SKIN_TABLE, -1) === p0, `${t}G3 skin 负数必须回落第 0 套`);
  check(api.applySkinToMaterialPath(p0, SKIN_TABLE, 1.5) === p0, `${t}G3 非整数 skin 必须回落第 0 套`);
  check(api.applySkinToMaterialPath(p0, SKIN_TABLE, "1") === p0, `${t}G3 字符串索引必须回落第 0 套（闸门已归一）`);
  check(api.applySkinToMaterialPath(p0, null, 1) === p0, `${t}G3 无 skins 表必须恒等`);
  check(api.applySkinToMaterialPath(p0, {}, 1) === p0, `${t}G3 skins 非数组必须恒等`);
  check(api.applySkinToMaterialPath(p0, [{ grid: "grid2" }, { grid: "grid" }], 1) === p0, `${t}G3 皮肤表键不命中必须恒等`);
  check(api.applySkinToMaterialPath(p0, [{ grid: "../evil" }], 0) === p0, `${t}G3 值含 ../ 必须拒绝（皮肤值只能是基名）`);
  check(api.applySkinToMaterialPath(p0, [{ grid: "sub/grid2" }], 0) === p0, `${t}G3 值含 / 必须拒绝`);
  check(api.applySkinToMaterialPath("materials/x/y.png", SKIN_TABLE, 1) === "materials/x/y.png", `${t}G3 非 .json 材质必须恒等`);
  check(api.applySkinToMaterialPath("", SKIN_TABLE, 1) === "", `${t}G3 空路径必须恒等`);
  check(api.applySkinToMaterialPath("materials/grid/old.json", [{ grid: "grid" }], 0) === "materials/grid/grid.json",
    `${t}G3 skin=0 也必须按皮肤表落位（材质表是权威，不是「0 号恒等」的捷径）`);
  check(api.skinIndexOf({ id: 1 }) === null, `${t}G3 无 skin 字段必须 null（闸门：不开闸就零回归）`);
  check(api.skinIndexOf({ id: 1, skin: 1 }) === 1, `${t}G3 skin:1 → 1`);
  check(api.skinIndexOf({ id: 1, skin: 0 }) === 0, `${t}G3 skin:0 是显式皮肤（≠ null）`);
  check(api.skinIndexOf({ id: 1, skin: "2" }) === 2, `${t}G3 纯数字字符串 skin:"2" → 2（WE 的 json 两栖）`);
  check(api.skinIndexOf({ id: 1, skin: 1.5 }) === 1, `${t}G3 小数 skin 取整（与闸门归一一致）`);
  check(api.skinIndexOf({ id: 1, skin: true }) === null, `${t}G3 布尔 skin 必须 null（不误判）`);
  check(api.skinIndexOf({ id: 1, skin: "abc" }) === null, `${t}G3 非数字字符串 skin 必须 null`);
}

// —— G4：语料普查（对象字段现值基线）——
const G4_FIELDS = ["reflected", "locktransforms", "ledsource", "blockalign", "particlesrc", "sprite", "skin"];
function dpCensus() {
  const present = Object.fromEntries(G4_FIELDS.map((f) => [f, 0]));
  const on = Object.fromEntries(G4_FIELDS.map((f) => [f, 0]));
  let objects = 0, modelMat = 0, changed = 0;
  const changes = [];
  for (const d of fs.readdirSync(root).filter((n) => fs.statSync(path.join(root, n)).isDirectory()).sort()) {
    if (!fs.existsSync(path.join(root, d, "project.json"))) continue;
    const pkg = dpPack(d);
    if (!pkg) continue;
    const projBytes = getEntry(pkg, "project.json");
    if (!projBytes) continue;
    const rel = scn.sceneEntryCandidates(parseJsonLoose(readText(projBytes))).find((n) => !!getEntry(pkg, n));
    if (!rel) continue;
    const sceneBytes = getEntry(pkg, rel);
    const scene = sceneBytes ? parseJsonLoose(readText(sceneBytes)) : null;
    for (const [i, o] of ((scene && scene.objects) || []).entries()) {
      objects++;
      for (const f of G4_FIELDS) {
        if (!Object.prototype.hasOwnProperty.call(o, f)) continue;
        present[f]++;
        const v = o[f];
        if (v !== null && v !== false && v !== undefined && v !== 0 && v !== "") on[f]++;
      }
      let mdlRel = typeof o.model === "string" ? o.model : null;
      let side = null;
      if (mdlRel) {
        const sb = getEntry(pkg, mdlRel.replace(/\.mdl$/i, ".json"));
        side = sb ? parseJsonLoose(readText(sb)) : null;
      } else if (typeof o.image === "string" && /\.json$/i.test(o.image)) {
        const mb = getEntry(pkg, o.image);
        const mj = mb ? parseJsonLoose(readText(mb)) : null;
        if (mj && typeof mj.puppet === "string") { mdlRel = mj.puppet; side = mj; }
      }
      if (!mdlRel) continue;
      const bytes = getEntry(pkg, mdlRel);
      if (!bytes) continue;
      let mdl;
      try { mdl = mdlMod.parseMDL(new Uint8Array(bytes)); } catch { continue; }
      if (!mdl.materialPath) continue;
      modelMat++;
      const skins = side && Array.isArray(side.skins) ? side.skins : null;
      const got = scn.applySkinToMaterialPath(mdl.materialPath, skins, scn.skinIndexOf(o));
      if (got !== mdl.materialPath) { changed++; changes.push(`${d}/${rel}#${o.id ?? i} ${mdl.materialPath} → ${got}`); }
    }
  }
  return { objects, modelMat, present, on, changed, changes };
}

/** G4 全套判据；`api` = parse.js 模块（可换成变异版），`tag` = 变异红测前缀 */
function g4Checks(api, tag) {
  const t = tag ? `${tag} ` : "";
  if (tag) {
    // 变异红测用的最小行为断言（真值字段必须被认出；表被清空/逻辑改坏就变红）
    check(api.noteUnsupportedObjectFields({ id: 7, ledsource: true }) === "ledsource", `${t}G4 诊断应认出 ledsource=true`);
    return;
  }
  const info = console.info;
  let calls = 0;
  const seen = [];
  console.info = (...a) => { calls++; seen.push(a.join(" ")); };
  let hitLed = null, hitLock = null, miss1 = null, miss2 = null;
  try {
    hitLed = api.noteUnsupportedObjectFields({ id: 11, ledsource: true });
    api.noteUnsupportedObjectFields({ id: 12, ledsource: true }); // 去重：不应再提示
    miss1 = api.noteUnsupportedObjectFields({ id: 13, ledsource: false });
    miss2 = api.noteUnsupportedObjectFields({ id: 14, locktransforms: null });
    hitLock = api.noteUnsupportedObjectFields({ id: 15, locktransforms: true });
    miss1 = miss1 ?? api.noteUnsupportedObjectFields({ id: 16, blockalign: 0 });
  } finally {
    console.info = info;
  }
  check(hitLed === "ledsource" && hitLock === "locktransforms", `G4 诊断：真值字段应被认出（ledsource / locktransforms），实际 ${hitLed} / ${hitLock}`);
  check(miss1 === null && miss2 === null, `G4 诊断：false / null / 0 不算命中，实际 ${miss1} / ${miss2}`);
  check(calls === 2, `G4 诊断：每个字段全进程只提示一次（期望 2 次，实际 ${calls}）`);
  check(seen[0] && seen[0].includes("ledsource") && seen[0].includes("显式忽略"), `G4 诊断文案应含字段名与「显式忽略」，实际 ${JSON.stringify(seen[0])}`);
}

// —— 真语料：G3 三条样本 + G4 普查（只跑一次，用未变异的 scn）——
console.log("  - G3 皮肤变体（真解析产物：packSourceProject → parsePkg → parseMDL → 真 skins 表）：");
g3Checks(scn, "");
console.log("  - G4 被忽略字段：诊断行为 + 语料普查基线");
g4Checks(scn, "");
const census = dpCensus();
console.log(`  - defaultprojects 对象字段普查：${census.objects} 个对象 / ${census.modelMat} 个能解出 MDL 材质；` +
  G4_FIELDS.map((f) => `${f} ${census.present[f]}/${census.on[f]}(在/真)`).join("、"));
check(census.objects === 109, `语料对象总数变化：${census.objects}（基线 109）—— 普查基线需按新语料更新`);
check(census.modelMat >= 27, `能解出 MDL 材质的对象只有 ${census.modelMat} 个（基线 29）—— G3 语料面可能空转`);
const G4_BASE = {
  reflected: [3, 3], locktransforms: [31, 1], ledsource: [22, 2],
  blockalign: [2, 0], particlesrc: [1, 0], sprite: [3, 1], skin: [1, 1],
};
for (const f of G4_FIELDS) {
  const [p, o] = G4_BASE[f];
  check(census.present[f] === p, `字段 ${f} 出现次数变化：${census.present[f]}（基线 ${p}）`);
  check(census.on[f] === o, `字段 ${f} 真值次数变化：${census.on[f]}（基线 ${o}）`);
}
check(census.changed === 1 && /^audiophile\//.test(census.changes[0] || ""),
  `G3 语料不变性：整份 defaultprojects 只能有 audiophile 那 1 处材质路径变化，实际 ${census.changed} 处：${census.changes.join("、")}`);
if (census.changes.length) console.log(`  - G3 语料唯一变化点：${census.changes.join("、")}`);

// —— 工坊打包语料不变性（闸门不开时逐位不变）——
{
  let pkgs = 0, scenes2 = 0, objects2 = 0, skinObjs = 0, skinModels = 0;
  for (const d of fs.readdirSync(LIB).filter((x) => /^\d+$/.test(x))) {
    const p = path.join(LIB, d, "scene.pkg");
    if (!fs.existsSync(p)) continue;
    let pkg;
    try { pkg = parsePkg(fs.readFileSync(p)); } catch { continue; }
    pkgs++;
    const e = pkg.entries.find((x) => /^scene\.json$/i.test(x.name));
    if (e) {
      const b = getEntry(pkg, e.name);
      let sj = null;
      try { sj = b ? parseJsonLoose(readText(b)) : null; } catch { /* 坏 json 跳过 */ }
      if (sj && Array.isArray(sj.objects)) {
        scenes2++;
        for (const o of sj.objects) {
          objects2++;
          if (Object.prototype.hasOwnProperty.call(o, "skin")) skinObjs++;
        }
      }
    }
    for (const e2 of pkg.entries) {
      if (!/^models\/.*\.json$/i.test(e2.name)) continue;
      const b = getEntry(pkg, e2.name);
      if (!b) continue;
      let t2 = null;
      try { t2 = parseJsonLoose(readText(b)); } catch { continue; }
      if (Array.isArray(t2.skins)) skinModels++;
    }
  }
  check(pkgs >= 300, `工坊打包语料数量异常：${pkgs} 张 pkg（基线 348）—— 闸门判据可能空转`);
  check(scenes2 >= 300, `工坊语料里能解出 scene.json 的只有 ${scenes2} 张（基线 348）`);
  check(objects2 >= 10000, `工坊语料对象只有 ${objects2} 个（基线 14904）—— 不变性判据可能空转`);
  check(skinObjs === 0, `工坊语料出现对象 skin 字段 ${skinObjs} 处（闸门假设「一个都没有」已失效，必须重跑不变性）`);
  check(skinModels === 0, `工坊语料出现模型 json skins 表 ${skinModels} 处（同上）`);
  console.log(`  - 工坊打包语料不变性：${pkgs} 张 pkg / ${scenes2} 个 scene.json / ${objects2} 个对象；skin 字段 ${skinObjs} 处、模型 skins 表 ${skinModels} 处 ⇒ 闸门不开，行为逐位不变`);
}

// —— 反向断言 + 读点结构（G3 接线 / G4 无直接读点）——
const parseSrc = fs.readFileSync(path.join(ROOT, PARSE_REL), "utf8");
const smSrc = fs.readFileSync(path.join(ROOT, SM_REL), "utf8");
const srcHasG4Call = (src) => /const world = local\[i\][\s\S]{0,200}?noteUnsupportedObjectFields\(o\)/.test(src);
/** G4 的源码结构断言（未变异源码 + 变异源码走同一条，保证变异红测不会与判据漂移） */
const structuralG4 = (src) => check(srcHasG4Call(src), "G4：诊断必须挂在 parseScene 的逐对象循环里（唯一对象遍历点）");
check(/export function resolveMaterial\(modelJson, skinIndex = null\)/.test(parseSrc),
  "G3：resolveMaterial 必须带默认 null 的 skinIndex 第二参（省略时与历史逐位一致）");
structuralG4(parseSrc);
check(/const skinIdx = scn\.skinIndexOf\(\(layer as any\)\.srcObject\)/.test(smSrc),
  "G3：.mdl 分支必须用对象闸门取 skin 索引");
check(/if \(skinIdx !== null\) \{/.test(smSrc) && /readModelSkinTable\(layer\.model\)/.test(smSrc),
  "G3：只有对象写了 skin 才去读 sidecar（普通模型零额外 I/O）");
check(/scn\.resolveMaterial\(model, scn\.skinIndexOf\(/.test(smSrc),
  "G3：image→model json 路径必须把 skin 索引喂给 resolveMaterial");
const idxCalls = (smSrc.match(/scn\.skinIndexOf\(/g) || []).length;
check(idxCalls >= 4, `G3：皮肤闸门应覆盖 .mdl 分支 / 模型 json 分支 / 普通 image 路径 / 克隆路径，实际 ${idxCalls} 处`);
check(/skinIdxPuppet !== null && Array\.isArray\(\(model as any\)\.skins\)/.test(smSrc),
  "G3：puppet 分支用对象模型 json 自带的 skins（不第二次 I/O）");

const engineFiles = [];
for (const base of ["renderer/src", "renderer/vendor/we-scene"]) {
  for (const f of fs.readdirSync(path.join(ROOT, base), { recursive: true })) {
    const rel = path.join(base, String(f));
    if (!/\.(ts|js|mjs)$/.test(rel) || /\.d\.ts$/.test(rel)) continue;
    engineFiles.push(rel);
  }
}
const directReads = (field) => {
  let n = 0;
  const where = new Set();
  for (const rel of engineFiles) {
    const s = fs.readFileSync(path.join(ROOT, rel), "utf8");
    const m = s.match(new RegExp(`(?:\\bo|srcObject|l|layer|clone)\\??\\.${field}\\b`, "g"));
    if (m) { n += m.length; where.add(rel); }
  }
  return { n, where: [...where] };
};
for (const f of ["locktransforms", "ledsource", "blockalign", "particlesrc"]) {
  const r = directReads(f);
  check(r.n === 0, `G4 反向断言：引擎不得有「读对象 ${f}」的直接读点（定案=显式忽略；实际 ${r.n} 处：${r.where.join("、")}）`);
}
check(directReads("reflected").n >= 1,
  "G4 反向断言自查：reflected 是已实现字段，应至少有 1 处读点（否则上面 4 条 0 断言可能因正则写错而空转）");
check(directReads("skin").n >= 1,
  "G4 反向断言自查：skin 是本轮新实现字段，应至少有 1 处读点（同上）");
check(parseSrc.includes("G4_IGNORED_FIELDS") && parseSrc.includes("noteUnsupportedObjectFields"),
  "G4：parse.js 里应有被忽略字段表与诊断函数（判据 10 的源码面）");

// —— sprite：判定「本轮不实现」（普通材质链画不了）——
{
  const rp = dpPack("ricepod");
  if (rp) {
    const sceneBytes = getEntry(rp, "ricepod.json");
    const scene = sceneBytes ? parseJsonLoose(readText(sceneBytes)) : null;
    const sp = ((scene && scene.objects) || []).filter((o) => typeof o.sprite === "string");
    check(sp.length === 1, `sprite：ricepod 应恰好 1 个对象写 sprite（字符串），实际 ${sp.length}`);
    if (sp.length === 1) {
      const o = sp[0];
      check(!o.image && !o.model && !o.size && !o.particle,
        "sprite 对象没有 image/model/size/particle ⇒ 引擎现有入口（image→models/x.json→material）不成立");
      const docBytes = getEntry(rp, o.sprite);
      check(!!docBytes, `sprite 指向的文档必须在包内：${o.sprite}`);
      if (docBytes) {
        const doc = parseJsonLoose(readText(docBytes));
        check(Array.isArray(doc.passes) && doc.passes.length > 0,
          "sprite 文档是材质文档（内联 passes），不是模型 json —— 与 G3 那条链不同族");
        check(!doc.material, "sprite 文档没有 material 字段（模型 json 才有）");
      }
      check(!!getEntry(rp, "shaders/sprite.frag") && !!getEntry(rp, "shaders/sprite.vert"),
        "sprite 的着色器由工程自带（shaders/sprite.frag|vert 在包内）⇒ 需要独立的 vert/frag 绑定链");
      console.log(`  - sprite 定案=本轮不实现：ricepod#${o.id ?? "?"} 只写 sprite（无 image/model/size），` +
        `目标是自带 shaders/sprite.frag|vert 的材质 pass；引擎要新增「sprite 对象 → 材质文档直挂 + 全屏四边形」这条独立链，` +
        `工作量与风险见报告，交官方 A/B 定案`);
    }
    const r = directReads("sprite");
    check(r.n === 0, `G4 反向断言：引擎不得有「读对象 sprite」的直接读点（本轮未实现；实际 ${r.n} 处：${r.where.join("、")}）`);
  }
}

// —— 判据 10 变异红测：改坏引擎 → 判据必须变红 → 复原后 sha256 一致 ——
console.log("  - 判据 10 变异红测（改坏 → 变红 → 复原 → sha256 一致）：");
async function bundlePatched(rel, from, to, name) {
  let src = fs.readFileSync(path.join(ROOT, rel), "utf8");
  const hits = src.split(from).length - 1;
  if (hits !== 1) throw new Error(`变异锤未唯一命中 ${rel}（${hits} 次）：${name}`);
  src = src.replace(from, to);
  const out = await build({
    stdin: { contents: src, resolveDir: path.dirname(path.join(ROOT, rel)), loader: "js" },
    bundle: true, format: "esm", platform: "node", target: "node20", write: false, logLevel: "silent",
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "defproj-mut-"));
  const file = path.join(dir, "mod.mjs");
  fs.writeFileSync(file, out.outputFiles[0].text);
  try { return await import(pathToFileURL(file).href); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const G3_MUTATIONS = [
  { name: "M1 对象闸门失效（skinIndexOf 永远 null）", from: "  const raw = srcObject.skin\n", to: "  const raw = null // MUT\n" },
  { name: "M2 忽略 skin 索引（永远第 0 套）", from: "  const n = Number.isInteger(skinIndex) && skinIndex >= 0 && skinIndex < skins.length ? skinIndex : 0\n", to: "  const n = 0 // MUT\n" },
  { name: "M3 皮肤值允许路径分隔符", from: "  if (/[\\\\/]/.test(next) || next === '.' || next === '..') return materialPath\n", to: "  if (false) return materialPath // MUT\n" },
  { name: "M4 被忽略字段表清空", from: "const G4_IGNORED_FIELDS = ['locktransforms', 'ledsource', 'blockalign', 'particlesrc']\n", to: "const G4_IGNORED_FIELDS = [] // MUT\n" },
  { name: "M6 0 号皮肤走恒等捷径", from: "  const set = skins[n]\n", to: "  if (n === 0) return materialPath // MUT\n  const set = skins[n]\n" },
  { name: "M7 皮肤索引不收纯数字字符串", from: "  if (typeof raw === 'string' && /^\\s*-?\\d+\\s*$/.test(raw)) return parseInt(raw, 10)\n", to: "" },
];
const shaBefore = sha256File(PARSE_REL);
const shaBeforeSm = sha256File(SM_REL);
for (const m of G3_MUTATIONS) {
  const mark = errors.length;
  let added = 0, note = "";
  try {
    const mod = await bundlePatched(PARSE_REL, m.from, m.to, m.name);
    const info = console.info;
    const log = console.log;
    console.info = () => {};
    console.log = () => {}; // 变异红测期间的 ✗ 是**预期证据**，不刷屏（汇总只报计数）
    try {
      g3Checks(mod, "[坏]");
      g4Checks(mod, "[坏]");
    } finally { console.info = info; console.log = log; }
    added = errors.length - mark;
  } catch (e) {
    note = `（变异装载失败：${e.message}）`;
  }
  errors.length = mark;
  check(added >= 1 && added <= 8, `${m.name}：判据未按预期变红（新增失败 ${added} 处）${note}`);
  console.log(`    · ${m.name} → 新增失败 ${added} 处`);
}
// 结构类变异（不装载模块，直接对源码跑同一条结构断言）
{
  const mark = errors.length;
  const callSite = "    // [we-scene patch] G4：本轮显式忽略的对象字段在此处提示一次（见 noteUnsupportedObjectFields）\n    noteUnsupportedObjectFields(o)\n";
  const hits = parseSrc.split(callSite).length - 1;
  check(hits === 1, `M5 锤子应唯一命中 parse.js 的 G4 调用点（实际 ${hits} 次）`);
  if (hits === 1) {
    const log = console.log;
    console.log = () => {}; // 同上：变异期间的结构 ✗ 是预期证据
    try { structuralG4(parseSrc.replace(callSite, "")); } finally { console.log = log; }
  }
  const added = errors.length - mark;
  errors.length = mark;
  check(added >= 1 && added <= 3, `M5 逐对象诊断调用被删：判据未按预期变红（新增失败 ${added} 处）`);
  console.log(`    · M5 删掉逐对象诊断调用 → 新增失败 ${added} 处`);
}
check(sha256File(PARSE_REL) === shaBefore, "变异红测后 parse.js 必须逐字节复原（sha256 与变异前一致）");
check(sha256File(SM_REL) === shaBeforeSm, "变异红测后 scene-mount.ts 必须逐字节复原（sha256 与变异前一致）");

console.log("");
if (errors.length > 0) {
  console.log(`✗ 共 ${errors.length} 处问题`);
  process.exit(1);
} else {
  console.log("✓ 全部通过");
}
