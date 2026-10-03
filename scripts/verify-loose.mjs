#!/usr/bin/env node
/**
 * verify-loose —— 「松散目录形态的场景壁纸」装载判据（源码工程 / 官方内置 defaultprojects）。
 *
 * 背景（判定表见 docs/LIBRARY-PLAN.md §4）：
 *   包形态：`scene.pkg` 字节 → parsePkg → 全程按名 getEntry（零拷贝视图）；
 *   松散形态：`project.json` 的 `file` 以 `.json` 结尾 → 按相对路径逐文件 HTTP 取
 *             （WE 编辑器工程在盘上就是散装目录：scene.json / materials/ / models/ …）。
 *
 * 形态判定的**真源是 renderer/src/api/source.ts**（sceneFormOf / declaredSceneFile /
 * declaredPkgPath）。本脚本用 esbuild 把它 bundle 出来**真跑**，不抄第二份判定逻辑 ——
 * 抄一份的判据会与实现一起漂（本仓的旧教训：verify-camera 的数值判据就是脚本内副本）。
 *
 * 三层：
 *   A. 判定表 + 回退语义（真跑，含本地 HTTP 服务器）：
 *      · `*.pkg` → 包、`*.json` → 松散、缺失/其它 → 包、preview.json 不当入口；
 *      · `file: "scene.json"` 但盘上只有 scene.pkg ⇒ sceneDir() 必须返回 null、
 *        scenePkg() 必须成功（全库 350+ 个只有包的条目靠这条回退活着）；
 *      · 声明了自定义包名（`file: "weird.pkg"`）⇒ scenePkg() 必须命中它；
 *      · 读取器：命中缓存、404 负缓存、`../` 穿越**不发请求**、
 *        abort 不写缓存（中断过的路径之后还能正常取到）。
 *   B. 本地库松散条目审计：入口 json 在盘上 + 引用闭包（scene.json → models/
 *      materials/effects/particles/scripts → shader/贴图/mdl）每个路径都能被运行时
 *      读到（内置命名空间与源图回退按既有口径豁免）。深链（多子网格、材质嵌套）由
 *      verify-defprojects 在同一批工程上按打包形态覆盖。
 *   C. 接线文本断言：装配期不得再有绕过 readAsset 的 `pkg.getEntry(parsedPkg, …)`；
 *      `?form=` 开关与 `..` 拒绝必须在位。
 *   D. 变异红测：把判定函数在内存里改坏（`.json` 当包），确认 A 的判据会变红 ——
 *      防「断言只看形状不看语义」的假绿。
 *
 * 用法：
 *   node scripts/verify-loose.mjs              # 离线（A–D），稳定集
 *   node scripts/verify-loose.mjs --headless   # 追加真 GPU A/B（需要 dev server + Chrome）
 *
 * --headless 会自己起一个 vite dev server（端口顺着 1431 往后找），对同一条目分别
 * 用 `?form=loose` / `?form=pkg` 各挂一次，比较图层数、贴图数、首帧像素与耗时。
 */
import { build } from "esbuild";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ROOT, LIB, itemDir, imp } from "./lib/verify-kit.mjs";

const effMod = await imp("renderer/vendor/we-scene/scene/effects-parse.js");
const mdlMod = await imp("renderer/vendor/we-scene/render/mdl.js");
const { WE_BUILTIN_SHADERS } = await imp("renderer/vendor/we-scene/shaders-builtin.ts");

let failed = 0;
let passed = 0;
function check(ok, msg) {
  if (ok) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "verify-loose-"));
const cleanups = [];
process.on("exit", () => {
  for (const fn of cleanups.reverse()) {
    try {
      fn();
    } catch {
      /* 清理失败不影响判据 */
    }
  }
});

/**
 * 用 esbuild 把 renderer/src/api/source.ts 打成 Node 可导入的临时 mjs。
 * `srcText` 可给（变异红测用）——那就不读盘，直接用内存里改坏的源码。
 */
async function loadSourceModule(srcText) {
  const out = await build({
    stdin: srcText
      ? { contents: srcText, resolveDir: path.join(ROOT, "renderer/src/api"), loader: "ts" }
      : undefined,
    entryPoints: srcText ? undefined : [path.join(ROOT, "renderer/src/api/source.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "es2022",
  });
  const tmp = path.join(tmpRoot, `source-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(tmp, out.outputFiles[0].text);
  return import(pathToFileURL(tmp).href);
}

// ───────────────────────────────────────────────────────────────────────────
// A. 判定表（真跑）
// ───────────────────────────────────────────────────────────────────────────
const SOURCE_TS = fs.readFileSync(path.join(ROOT, "renderer/src/api/source.ts"), "utf8");

const FORM_ROWS = [
  [{ file: "scene.json" }, "loose"],
  [{ file: "gifscene.json" }, "loose"],
  [{ file: "audiophile.json" }, "loose"],
  [{ file: "scenes/scene.json" }, "loose"],
  [{ file: "scene.pkg" }, "pkg"],
  [{ file: "gifscene.pkg" }, "pkg"],
  [{ file: "packs/My.PKG" }, "pkg"],
  [{ file: "index.html" }, "pkg"],
  [{ file: "scene.mp4" }, "pkg"],
  [{ file: "preview.json" }, "pkg"],
  [{}, "pkg"],
  [null, "pkg"],
  ["scene.json", "pkg"],
  [{ file: 42 }, "pkg"],
];
const PKG_ROWS = [
  [{ file: "packs/My.PKG" }, "packs/My.PKG"],
  [{ file: "scene.pkg" }, "scene.pkg"],
  [{ file: "scene.json" }, ""],
  [{ file: "index.html" }, ""],
  [{}, ""],
];
/** 判定表违规清单（不打印）。变异红测复用它确认「改坏了会红」。 */
function truthTableViolations(mod) {
  const out = [];
  for (const [input, want] of FORM_ROWS) {
    const got = mod.sceneFormOf(input);
    if (got !== want) out.push(`sceneFormOf(${JSON.stringify(input)}) = ${got}，应为 ${want}`);
  }
  for (const [input, want] of PKG_ROWS) {
    const got = mod.declaredPkgPath(input);
    if (got !== want) out.push(`declaredPkgPath(${JSON.stringify(input)}) = ${JSON.stringify(got)}，应为 ${JSON.stringify(want)}`);
  }
  const sf = mod.declaredSceneFile({ file: "  /scenes/scene.json  " });
  if (sf !== "scenes/scene.json") out.push(`declaredSceneFile 未去空白/前导斜杠：${JSON.stringify(sf)}`);
  return out;
}

const srcMod = await loadSourceModule();
{
  const violations = truthTableViolations(srcMod);
  check(violations.length === 0, `判定表 ${FORM_ROWS.length + PKG_ROWS.length + 1} 项全过（.pkg→包 / .json→松散 / 其它→包 / preview.json 不算入口）`);
  for (const v of violations) console.error(`      ${v}`);
}

// ───────────────────────────────────────────────────────────────────────────
// A2. 回退与读取器语义（本地 HTTP 服务器上真跑）
// ───────────────────────────────────────────────────────────────────────────
{
  // 语料：三个条目 —— 松散、只有包、自定义包名
  const write = (rel, data) => {
    const p = path.join(tmpRoot, "lib", rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, data);
  };
  write("loose/project.json", JSON.stringify({ type: "scene", file: "scene.json", title: "Loose" }));
  write("loose/scene.json", JSON.stringify({ general: { orthogonalprojection: { width: 8, height: 8 } }, objects: [] }));
  write("loose/materials/x.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  write("loose/materials/y.png", Buffer.from([0x89, 0x50, 0x4e, 0x48]));
  write("packed/project.json", JSON.stringify({ type: "scene", file: "scene.json", title: "Packed" }));
  write("packed/scene.pkg", Buffer.concat([Buffer.from([8, 0, 0, 0]), Buffer.from("PKGV0012")]));
  write("custom-pkg/project.json", JSON.stringify({ type: "scene", file: "weird.pkg" }));
  write("custom-pkg/weird.pkg", Buffer.concat([Buffer.from([8, 0, 0, 0]), Buffer.from("PKGV0012")]));

  const hits = [];
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url || "").split("?")[0]);
    hits.push(url);
    const rel = url.replace(/^\/media\/dev\//, "");
    const p = path.join(tmpRoot, "lib", rel);
    if (!p.startsWith(path.join(tmpRoot, "lib")) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) {
      res.writeHead(404).end("no");
      return;
    }
    res.writeHead(200).end(fs.readFileSync(p));
  });
  cleanups.push(() => server.close());
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/media/dev`;

  // 松散条目：sceneDir() 命中、入口与资源可读、缺文件 null
  {
    const s = srcMod.httpSource(`${base}/loose`);
    const dir = await s.sceneDir();
    check(!!dir, "松散条目：sceneDir() 命中（file=scene.json 且入口取得到）");
    check(dir?.entry === "scene.json", `松散条目：entry 用 file 声明的入口（实得 ${dir?.entry}）`);
    const entryBytes = await dir.read("scene.json");
    check(!!entryBytes && JSON.parse(new TextDecoder().decode(entryBytes)).objects !== undefined, "松散条目：入口 json 能按名取到且可解析");
    check((await dir.read("materials/x.png"))?.length === 4, "松散条目：materials/x.png 按相对路径取到");
    check((await dir.read("materials/nope.tex")) === null, "松散条目：缺文件返回 null（不是抛错）");
    check((await dir.read("materials/nope.tex")) === null, "缺文件二次读取仍为 null（负缓存命中，不再发请求）");
    check(
      hits.filter((u) => u.endsWith("/materials/nope.tex")).length === 1,
      "负缓存确实省掉了重复请求（同一路径只发一次）",
    );
    const before = hits.length;
    check((await dir.read("../../../etc/passwd")) === null, "`..` 穿越被拒（返回 null）");
    check(hits.length === before, "`..` 穿越**不发请求**（在客户端就拦掉）");
    // abort 不写缓存：**未缓存过的**路径被中断后仍要能正常取到（缓存毒化会让整张贴图
    // 在重挂后静默消失）。用 y.png 而不是 x.png —— x 上面已经读过、走的是缓存分支，
    // 根本不会碰网络，断言会变成空转（第一版就是这么写错的，被这条判据自己逮住）。
    const ac = new AbortController();
    ac.abort();
    let threw = false;
    try {
      await dir.read("materials/y.png", ac.signal);
    } catch {
      threw = true;
    }
    check(threw, "已中断的读取如实抛出（不静默当成「文件不存在」）");
    check((await dir.read("materials/y.png"))?.length === 4, "中断过的路径之后仍能正常取到（缓存没被毒化）");
  }

  // 只有包的条目：file 声明 scene.json 但盘上没有入口 json ⇒ 必须回退 pkg
  {
    const s = srcMod.httpSource(`${base}/packed`);
    check((await s.sceneDir()) === null, "只有包的条目：sceneDir() 返回 null（入口 404 → 回退信号）");
    const bytes = new Uint8Array(await s.scenePkg());
    check(bytes.length === 12 && new TextDecoder().decode(bytes.slice(4, 12)) === "PKGV0012", "只有包的条目：scenePkg() 照旧成功（350+ 个条目的回退保护）");
  }

  // 自定义包名：file 声明 *.pkg ⇒ 先试它自己的名字
  {
    const s = srcMod.httpSource(`${base}/custom-pkg`);
    check((await s.sceneDir()) === null, "自定义包名条目：不判为松散");
    const bytes = new Uint8Array(await s.scenePkg());
    check(bytes.length === 12, "自定义包名条目：scenePkg() 命中 file 声明的 weird.pkg");
    check(hits.includes("/media/dev/custom-pkg/weird.pkg"), "自定义包名条目：请求确实打在声明的包名上");
  }

  // project.json 只取一次（形态判定 / 属性表 / 入口解析共用）
  {
    const before = hits.filter((u) => u === "/media/dev/loose/project.json").length;
    const s = srcMod.httpSource(`${base}/loose`);
    await s.sceneDir();
    await s.project();
    const after = hits.filter((u) => u === "/media/dev/loose/project.json").length;
    check(after - before === 1, `project.json 每次来源只取一次（实测 ${after - before} 次）`);
  }
  // 显式关掉监听套接字：留着会让进程在事件循环里挂住（成功分支不调 process.exit，
  // 第一版就是这么挂住的 —— 挂住会被 verify-all 当成超时/新失败）
  await new Promise((r) => server.close(r));
}

// ───────────────────────────────────────────────────────────────────────────
// B. 本地库松散条目审计
// ───────────────────────────────────────────────────────────────────────────
const BUILTIN_TEX = /^(particle|util|gradient|pattern|lut|cookie)\//;
const BUILTIN_MODEL = /^models\/util\//;
const RT_TEX = /^_rt_/;

/**
 * WE 安装自带素材树（`<安装根>/assets`）：用来把「引擎内置 shader 不在工程里」
 * 与「引用真的断了」分开（与 verify-defprojects 同一口径）。找不到时整条退化为
 * 「按 WE_BUILTIN_SHADERS 放行」，不会把内置 shader 误判成缺文件。
 */
let weAssets = null;
for (const cand of [
  process.env.WE_ASSETS,
  process.env.WE_INSTALL && path.join(process.env.WE_INSTALL, "assets"),
  "/Applications/wallpaper_engine/assets",
  path.join(os.homedir(), "Library/Application Support/Steam/steamapps/common/wallpaper_engine/assets"),
]) {
  if (cand && fs.existsSync(cand)) {
    weAssets = cand;
    break;
  }
}
function weAssetExists(rel) {
  if (!weAssets) return false;
  try {
    return fs.existsSync(path.join(weAssets, rel));
  } catch {
    return false;
  }
}

function walk(dir, rel = "", out = new Map()) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walk(path.join(dir, e.name), r, out);
    else out.set(r, path.join(dir, e.name));
  }
  return out;
}

/** 本地库里所有「松散形态候选」条目（file 以 .json 结尾，排除预览封面） */
function looseCandidates() {
  const out = [];
  let names = [];
  try {
    names = fs.readdirSync(LIB);
  } catch {
    return out;
  }
  for (const id of names) {
    const pj = path.join(LIB, id, "project.json");
    if (!fs.existsSync(pj)) continue;
    let project = null;
    try {
      project = JSON.parse(fs.readFileSync(pj, "utf8"));
    } catch {
      continue;
    }
    const file = typeof project?.file === "string" ? project.file.trim().replace(/^\/+/, "") : "";
    if (!/\.json$/i.test(file) || /^preview\./i.test(file)) continue;
    const entryPath = path.join(LIB, id, file);
    if (!fs.existsSync(entryPath)) continue; // 只有包的条目：渲染器会回退 pkg（A2 已覆盖）
    out.push({ id, project, file, dir: path.join(LIB, id) });
  }
  return out;
}

{
  const items = looseCandidates();
  console.log(`\n松散形态条目：${items.length} 个（${items.map((i) => i.id).join("、") || "无"}）`);
  check(items.length > 0, "本地库必须有松散形态条目可审（语料空 = 判据空转）");

  for (const it of items) {
    const files = walk(it.dir);
    const has = (rel) => files.has(rel);
    const readJson = (rel) => {
      try {
        return JSON.parse(fs.readFileSync(files.get(rel), "utf8"));
      } catch {
        return null;
      }
    };
    const missing = [];
    const info = [];
    const seen = new Set();
    const require1 = (rel, why) => {
      if (typeof rel !== "string" || !rel) return false;
      if (seen.has(rel)) return has(rel);
      seen.add(rel);
      if (has(rel)) return true;
      missing.push(`${rel}（${why}）`);
      return false;
    };
    const requireShader = (name, why) => {
      if (has(`shaders/${name}.frag`) && has(`shaders/${name}.vert`)) return true;
      // 本仓已实现的引擎内置 shader（WE_BUILTIN_SHADERS，如 flag）：引用成立
      if (WE_BUILTIN_SHADERS[`${name}.frag`] && WE_BUILTIN_SHADERS[`${name}.vert`]) return true;
      // WE 安装素材树里有（assets/shaders/**）：引擎内置、本仓未实现 → 该层退回通用材质，
      // 属已知缺口而非装载错误（与 verify-defprojects 的两档次口径一致）
      if (weAssetExists(`shaders/${name}.frag`) && weAssetExists(`shaders/${name}.vert`)) {
        info.push(`${name} 是 WE 内置 shader（本仓未实现，退回通用材质）`);
        return true;
      }
      missing.push(`shaders/${name}.frag + .vert（${why}）`);
      return false;
    };
    const requireTexture = (t, why) => {
      if (typeof t !== "string" || !t || RT_TEX.test(t) || BUILTIN_TEX.test(t)) return true;
      if (has(`materials/${t}.tex`)) return true;
      for (const ext of ["png", "jpg", "jpeg"]) {
        if (has(`materials/${t}.${ext}`)) {
          info.push(`${t}.${ext} 只有源图（无 .tex，运行时走源图回退）`);
          return true;
        }
      }
      for (const ext of ["tga", "dds"]) {
        if (has(`materials/${t}.${ext}`)) {
          // 浏览器解不了 tga/dds：这条在 pkg 形态下同样缺席（打包产物里也只有该扩展名），
          // 属于语料自身的缺口，不是装载路径的问题 —— 记 info，不作为失败
          info.push(`${t}.${ext} 运行时解不了（pkg 形态同样缺席）`);
          return true;
        }
      }
      missing.push(`materials/${t}.tex（${why}）`);
      return false;
    };
    const resolveMaterial = (rel, why) => {
      if (BUILTIN_TEX.test(rel)) return;
      if (!require1(rel, why)) return;
      const doc = readJson(rel);
      for (const mp of doc?.passes ?? []) {
        if (mp.material) {
          resolveMaterial(mp.material, `${why}→材质嵌套`);
          continue;
        }
        if (typeof mp.shader === "string" && mp.shader && !effMod.isBuiltinAlbedoShader(mp.shader)) {
          requireShader(mp.shader, `${why}→shader`);
        }
        for (const t of mp.textures ?? []) requireTexture(t, `${why}→贴图`);
      }
    };
    const resolveMdl = (rel, why) => {
      if (!require1(rel, why)) return;
      try {
        const mdl = mdlMod.parseMDL(new Uint8Array(fs.readFileSync(files.get(rel))));
        if (mdl.materialPath) resolveMaterial(mdl.materialPath, `${why}→内置材质`);
        for (const m of mdl.meshes ?? []) {
          if (m.materialPath) resolveMaterial(m.materialPath, `${why}→子网格材质`);
        }
      } catch {
        info.push(`${rel} 解析失败（MDL 缺陷由 verify-mdl-* 覆盖）`);
      }
    };

    // 入口
    require1(it.file, "场景入口（project.json 的 file）");
    const scene = readJson(it.file);
    check(!!scene, `${it.id}: 入口 ${it.file} 可解析`);
    for (const o of scene?.objects ?? []) {
      const who = `对象 ${o.id ?? "?"}`;
      if (typeof o.image === "string") {
        if (!BUILTIN_MODEL.test(o.image) || has(o.image)) {
          if (require1(o.image, `${who}→模型 json`)) {
            const mj = readJson(o.image);
            if (typeof mj?.material === "string") resolveMaterial(mj.material, `${who}→材质`);
            if (typeof mj?.puppet === "string") resolveMdl(mj.puppet, `${who}→puppet`);
          }
        }
      }
      if (typeof o.model === "string") resolveMdl(o.model, `${who}→模型`);
      if (typeof o.particle === "string") {
        if (require1(o.particle, `${who}→粒子配置`)) {
          const pj = readJson(o.particle);
          if (typeof pj?.material === "string" && pj.material) {
            if (require1(pj.material, `${who}→粒子材质`)) {
              const pm = readJson(pj.material);
              for (const mp of pm?.passes ?? []) {
                // 粒子材质自带的 shader 只有走「材质网格路径」时才被运行时读取
                // （canUseMaterialMeshPath 排除 genericparticle 等引擎族 —— 它们由
                // render/particle-shaders.js 原生实现，工程里没有也不需要这两个文件）
                if (typeof mp.shader === "string" && mp.shader && effMod.canUseMaterialMeshPath(mp.shader)) {
                  requireShader(mp.shader, `${who}→粒子 shader`);
                }
                for (const t of mp.textures ?? []) requireTexture(t, `${who}→粒子贴图`);
              }
            }
          }
        }
      }
      for (const e of o.effects ?? []) {
        if (typeof e.file === "string" && e.file) {
          if (require1(e.file, `${who}→效果`)) {
            const ej = readJson(e.file);
            for (const p of ej?.passes ?? []) if (p.material) resolveMaterial(p.material, `${who}→${e.file}`);
          }
        }
      }
      for (const s of o.sound ?? []) require1(s, `${who}→声音`);
      const p = o.path;
      if (typeof p === "string" && p) require1(p, `${who}→相机路径`);
      const font = o.textfont || o.textFont;
      if (typeof font === "string" && /^fonts\//i.test(font)) require1(font, `${who}→字体`);
    }
    for (const rel of scene?.camera?.paths ?? []) {
      if (typeof rel === "string" && rel) require1(rel, "场景相机路径");
    }

    check(missing.length === 0, `${it.id}: 引用闭包无缺文件（${seen.size} 个路径）${missing.length ? ` —— ${missing.slice(0, 4).join(" / ")}` : ""}`);
    if (info.length) console.log(`      · ${it.id} 非阻断提示：${[...new Set(info)].slice(0, 3).join(" / ")}`);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// C. 接线文本断言
// ───────────────────────────────────────────────────────────────────────────
{
  const mount = fs.readFileSync(path.join(ROOT, "renderer/src/scene-mount.ts"), "utf8");
  const getEntryHits = [...mount.matchAll(/pkg\.getEntry\(parsedPkg/g)].length;
  check(getEntryHits <= 2, `装配期只剩 readAsset/assetExists 两处直接 getEntry（实得 ${getEntryHits} 处）`);
  check(
    /sceneDir \? await sceneDir\.read\(name, pkgAbort\.signal\) : pkg\.getEntry\(parsedPkg, name\)/.test(mount),
    "readAsset 是两种形态的唯一取资源入口（包=零拷贝视图、松散=按名 HTTP）",
  );
  check(/sceneEntry = await sceneDir\.read\(sceneDir\.entry/.test(mount), "松散形态直接用 file 声明的入口（不再走候选表）");
  check(/scene form: loose（入口 /.test(mount) && /scene form: pkg（body /.test(mount), "挂载期上报形态（诊断可取证）");
  check(!/resolveEffectChain\(parsedPkg/.test(mount), "效果链解析已改走 readAsset（不再直接吃 pkg）");
  check(/sceneCache/.test(mount) && /cachedSourceBytes/.test(mount), "缓存按形态统一（包/松散共用一份 LRU）");
  check(/sceneDir \? "场景目录内" : "包内"/.test(mount), "效果链诊断文案按形态分流");
  check(/type CachedSceneSource/.test(mount) && /mode: "pkg" \| "dir"/.test(mount), "来源描述符带 mode（pkg/dir）");

  check(/export function sceneFormOf/.test(SOURCE_TS) && /export function declaredPkgPath/.test(SOURCE_TS), "source.ts 导出 sceneFormOf / declaredPkgPath（判据真跑它们）");
  check(/sceneFormOf\(project\) !== "loose"\) return null/.test(SOURCE_TS), "source.ts：松散入口取不到必须返回 null（回退 pkg 的唯一开关）");
  check(/function normalizeRelPath/.test(SOURCE_TS) && /seg === "\.\."/.test(SOURCE_TS), "source.ts：相对路径必须拒绝 `..`");
  const types = fs.readFileSync(path.join(ROOT, "renderer/src/api/types.ts"), "utf8");
  check(/sceneDir\?\(signal\?: AbortSignal\)/.test(types) && /export type SceneDirAssets/.test(types), "Source 契约暴露可选 sceneDir（不破坏既有宿主）");
  const main = fs.readFileSync(path.join(ROOT, "renderer/src/main.ts"), "utf8");
  check(/params\.get\("form"\)/.test(main), "?form=pkg|loose 调试开关在位（A/B 取证用）");
}

// ───────────────────────────────────────────────────────────────────────────
// D. 变异红测：判定函数改坏必须让 A 变红
// ───────────────────────────────────────────────────────────────────────────
{
  const mutated = SOURCE_TS.replace('/\\.json$/i.test(file) ? "loose" : "pkg"', '"pkg"');
  check(mutated !== SOURCE_TS, "变异注入点存在（sceneFormOf 的 .json 分支）");
  const mod = await loadSourceModule(mutated);
  const violations = truthTableViolations(mod);
  const looseRows = FORM_ROWS.filter(([, want]) => want === "loose").length;
  check(
    violations.length === looseRows,
    `变异后判定表必须报错（实得 ${violations.length} 条，应等于松散行数 ${looseRows}）`,
  );
}

// ───────────────────────────────────────────────────────────────────────────
// E. 真 GPU A/B（--headless 才跑）
// ───────────────────────────────────────────────────────────────────────────
if (process.argv.includes("--headless")) {
  await runHeadlessAb();
} else {
  console.log("\n（跳过真 GPU A/B：加 --headless 跑，需要 Chrome + 会自起 dev server）");
}

async function runHeadlessAb() {
  const { launchHeadless, instrument } = await imp("scripts/headless-gpu.mjs");
  const { createServer } = await import("vite");
  const net = await import("node:net");
  const item = process.env.WE_LOOSE_ITEM || "arsenal";
  const srcDir = itemDir(item);
  const hasPkg = fs.existsSync(path.join(srcDir, "scene.pkg"));
  console.log(`\n[A/B] 条目 ${item}（松散 + ${hasPkg ? "包" : "无包"}）`);

  // 临时库：<item> = 完整条目（两形态齐全，做 A/B）；<item>-looseonly = 去掉 *.pkg 的副本
  // （**纯松散条目**：没有任何包，只能靠自动判定走松散 —— 这正是「无需打包」那条路）
  const tmpLib = path.join(tmpRoot, "lib-headless");
  fs.mkdirSync(tmpLib, { recursive: true });
  fs.cpSync(srcDir, path.join(tmpLib, item), { recursive: true });
  fs.cpSync(srcDir, path.join(tmpLib, `${item}-looseonly`), {
    recursive: true,
    filter: (s) => !s.toLowerCase().endsWith(".pkg"),
  });
  const prevLib = process.env.WE_LIBRARY;
  process.env.WE_LIBRARY = tmpLib; // host 中间件在插件创建时读它，必须在起 vite 之前设
  cleanups.push(() => {
    if (prevLib === undefined) delete process.env.WE_LIBRARY;
    else process.env.WE_LIBRARY = prevLib;
  });

  const port = await new Promise((res) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => res(p));
    });
  });
  const server = await createServer({
    root: ROOT,
    configFile: path.join(ROOT, "vite.config.ts"),
    server: { port, host: "127.0.0.1", strictPort: true, open: false },
    logLevel: "error",
  });
  await server.listen();
  cleanups.push(() => server.close());
  const origin = `http://127.0.0.1:${port}`;

  const session = await launchHeadless({ url: "about:blank", task: "verify-loose-ab", width: 1280, height: 720 });
  cleanups.push(() => session.close());
  instrument(session, { width: 1280, height: 720 });

  const mountOnce = async (arm, { src = item, form = "" } = {}) => {
    const url =
      `${origin}/renderer/index.html?type=scene&src=${src}&mediaBase=${origin}/media/dev` +
      `${form ? `&form=${form}` : ""}&fit=cover&renderDpr=1&sceneFps=60&muted=true&loop=true&autoq=0&bake=0`;
    await session.pageCdp.send("Page.navigate", { url });
    await session.waitFor("window.__wp && window.__sceneLayers", { timeoutMs: 60000 });
    await new Promise((r) => setTimeout(r, 2500)); // 让装配与动画稳定
    const report = JSON.parse(
      await session.evaluate(
        `JSON.stringify({
           layers: (window.__sceneLayers || []).map((l) => [
             l.name || "", l.image || "", l.model || "", l.particle || "",
             l.isText ? "text" : "", (l.effects || []).length, l.textureName || "",
           ]),
           texCount: (window.__memStats && window.__memStats().texCount) || 0,
           pkgBytes: (window.__memStats && window.__memStats().pkgBytes) || 0,
           fps: (window.__wpStats && window.__wpStats.frame().fps) || 0,
           reqs: performance.getEntriesByType("resource").map((e) => new URL(e.name).pathname),
         })`,
      ),
    );
    const shot = await session.screenshot({ format: "png" });
    return { arm, report, shot };
  };

  const loose = await mountOnce("loose (form=loose)", { form: "loose" });
  const packed = await mountOnce("pkg (form=pkg)", { form: "pkg" });
  const pure = await mountOnce("纯松散（无包，自动判定）", { src: `${item}-looseonly` });
  for (const r of [loose, packed, pure]) {
    console.log(`  ${r.arm}: layers=${r.report.layers.length} tex=${r.report.texCount} pkgBytes=${r.report.pkgBytes} fps=${r.report.fps.toFixed(1)}`);
  }

  const hasReq = (r, name) => r.reqs.some((p) => p.endsWith(name));
  const fingerprint = (r) => JSON.stringify(r.report.layers);
  const looseVerbs = loose.report.reqs.some((p) => p.endsWith(".json") && !p.endsWith("/project.json"));

  check(loose.report.layers.length > 0, `松散形态挂出图层（${loose.report.layers.length}）`);
  check(looseVerbs, "松散臂确实按散装文件取入口（请求里出现入口 json，且不是 project.json）");
  check(!hasReq(loose.report, "/scene.pkg"), "松散臂没有请求 scene.pkg（形态真的生效，不是静默回退）");
  check(hasReq(packed.report, "/scene.pkg"), "包臂确实请求了 scene.pkg");
  check(loose.report.layers.length === packed.report.layers.length, `两形态图层数一致（${loose.report.layers.length} vs ${packed.report.layers.length}）`);
  check(fingerprint(loose) === fingerprint(packed), "两形态图层指纹一致（name/image/model/particle/effects/贴图 逐层相同）");
  check(Math.abs(loose.report.texCount - packed.report.texCount) <= 2, `两形态贴图数接近（${loose.report.texCount} vs ${packed.report.texCount}）`);
  // 纯松散条目：不传 form，靠 project.json 的 file 后缀自动判定；目录里根本没有 scene.pkg
  check(pure.report.layers.length > 0, `纯松散条目（目录里没有 scene.pkg）自动判定后挂出图层（${pure.report.layers.length}）`);
  check(!hasReq(pure.report, "/scene.pkg"), "纯松散条目没有包可请求（拿不到也不影响装载）");
  check(fingerprint(pure) === fingerprint(loose), "纯松散条目与「完整条目强制松散」指纹一致（自动判定 = 强制松散）");

  const outDir = path.join(ROOT, "scripts", ".tmp-loose-ab");
  fs.mkdirSync(outDir, { recursive: true });
  for (const r of [loose, packed, pure]) {
    const tag = r.arm.startsWith("loose") ? "loose" : r.arm.startsWith("pkg") ? "pkg" : "looseonly";
    fs.writeFileSync(path.join(outDir, `${item}-${tag}.png`), Buffer.from(r.shot, "base64"));
  }
  console.log(`  截图：${outDir}/${item}-{loose,pkg,looseonly}.png（动画相位不同，像素差只作参考；结构性判据看上面的指纹）`);

  // 显式收尾：Chrome 与 vite 都会把事件循环钉住（成功分支不调 process.exit）
  await session.close();
  await server.close();
}

// ───────────────────────────────────────────────────────────────────────────
// 汇总
// ───────────────────────────────────────────────────────────────────────────
console.log("");
if (failed > 0) {
  console.log(`✗ ${failed} 处问题（通过 ${passed}）`);
  process.exit(1);
}
console.log(`✓ 全部通过（${passed} 项）`);
// 成功分支也显式退出：任何遗留 handle（服务器/浏览器）都不该让校验挂住
process.exit(0);
