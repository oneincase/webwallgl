#!/usr/bin/env node
/**
 * verify-mdl-source —— MDL **源码工程族**（官方内置 defaultprojects / WE 编辑器工程）判据。
 *
 * 背景（docs/DEFAULTPROJECTS-PLAN.md §4.2）：源码族 .mdl 与工坊打包族**不是同一套布局**。
 * 打包族是「版本 → 布局表」（见 render/mdl-parse.js 的 LAYOUTS 注释）；源码族是
 * **属性位掩码驱动**：头部 u32@9 的 mdlFlag 给出顶点属性（pos/normal/tangent/uv/…），
 * stride = 各属性尺寸之和，UV 恒在末 8 字节，顶点区长度字段在 material 串后 +4（0004/0014）
 * 或 +32（0017/0023），且 26/26 没有骨架/动画段（静态网格）。
 *
 * 判据：
 *   1. **冻结表**：16 个内置工程的 26 个模型，顶点数 / 索引数 / 内嵌材质路径必须与
 *      EXPECT 逐项相等（打包-装载链的定点回归；数字来自 P1 落地时的实测）；
 *   2. 唯一例外是 `audiophile/models/grid/grid.mdl` —— 全文件没有任何可自洽的顶点区
 *      （176 字节的残缺资产，连 .tex 都没编译），必须**明确失败**而不是崩或静默；把它
 *      当「已知残缺」白名单，并要求它抛的是布局错误而不是 RangeError；
 *   3. 打包语料（本机库存在时）：577 个 .mdl 必须**全部可解析**——打包族走原表，
 *      这条锁的是「源码族分支不得干扰打包族」与「语料里不得再出现解析不了的新形态」。
 *
 * 跳过语义：既没有 defaultprojects 也没有本机库时打印 `-` 不计失败。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LIB, imp, createChecker } from "./lib/verify-kit.mjs";

const { check, fail, errors } = createChecker({ echo: true });
const { parseMDL } = await imp("renderer/vendor/we-scene/render/mdl-parse.js");
const { parsePkg, getEntry } = await imp("renderer/vendor/we-scene/pkg/container.js");

/**
 * 冻结表：[顶点数, 索引数, 内嵌材质路径]；null = 已知残缺资产（必须失败）。
 * 数字以**属性表 vertexLayoutOf(mdlFlag)** 为准（与多子网格路径同一份实现）：
 * 例如 flag=0xf 是 pos+normal+tangent(16B)+uv = 48B/顶点。早先按「tangent 12B」
 * 的口径算出的 44/32 也自洽，但与子网格记录对不上（verify-mdl-sections 逮住），
 * 且与模型自带 AABB 不符，故以此表为准。
 */
const EXPECT = {
  "arsenal/models/pistols/pistols.mdl": [1423, 4041, "materials/pistols/knife_df.json"],
  "audiophile/models/audiophile/bars.mdl": [384, 576, "materials/audiophile/bars.json"],
  "audiophile/models/audiophile/flow.mdl": [163, 600, "materials/audiophile/flow.json"],
  "audiophile/models/audiophile/glow.mdl": [4, 6, "materials/audiophile/glow.json"],
  "audiophile/models/grid/grid.mdl": null,
  "demon_core/models/backgroundsphere/backgroundsphere.mdl": [1087, 5952, "materials/backgroundsphere/background_diamond.json"],
  "demon_core/models/core/core.mdl": [970, 1440, "materials/core/core.json"],
  "dna_fragment/models/bg/bg.mdl": [4, 6, "materials/bg/bg.json"],
  "dna_fragment/models/bg/bgfade.mdl": [4, 6, "materials/bg/bgfade.json"],
  "dna_fragment/models/curve/curve.mdl": [4, 6, "materials/curve/curve.json"],
  "dna_fragment/models/dna/dna.mdl": [2604, 11472, "materials/dna/dna.json"],
  "fantasticcar/models/car/body.mdl": [1782, 4908, "materials/car/body.json"],
  "fantasticcar/models/dome/dome.mdl": [236, 600, "materials/dome/dome.json"],
  "fantasticcar/models/grid/grid.mdl": [4, 6, "materials/grid/grid.json"],
  "fantasticcar/models/util/shadow.mdl": [90, 210, "materials/util/shadow.json"],
  "neon_sunset/models/neongrid/neongrid.mdl": [2601, 15000, "materials/neongrid/neongrid.json"],
  "neon_sunset/models/neonsun/neonsun.mdl": [4, 6, "materials/neonsun/neonsun.json"],
  "retro/models/bgfade/bgfade.mdl": [4, 6, "materials/bgfade/bgfade.json"],
  "ricepod/models/ricepod/jet.mdl": [60, 168, "materials/ricepod/jet.json"],
  "ricepod/models/ricepod/orbitaleffects.mdl": [62, 180, "materials/ricepod/orbital_ring.json"],
  "ricepod/models/ricepod/ricepod.mdl": [682, 1725, "materials/ricepod/separatistship_engine.json"],
  "ricepod/models/ricepod/skybox.mdl": [24, 36, "materials/ricepod/skybox.json"],
  "techno/models/techno/glow.mdl": [4, 6, "materials/techno/glow.json"],
  "techno/models/techno/orbitsmall.mdl": [66, 192, "materials/techno/orbitsmall.json"],
  "techno/models/techno/rays.mdl": [66, 192, "materials/techno/rays.json"],
  "techno/models/techno/sphere.mdl": [417, 2400, "materials/techno/technohex.json"],
};

function locateDefaultProjects() {
  const fromEnv = [
    process.env.WE_DEFAULTPROJECTS,
    process.env.WE_INSTALL && path.join(process.env.WE_INSTALL, "projects", "defaultprojects"),
  ].filter(Boolean);
  const home = os.homedir();
  const tails = ["steamapps/common/wallpaper_engine/projects/defaultprojects"];
  const cands = [...fromEnv];
  for (const h of ["Library/Application Support/Steam", ".steam/steam", ".local/share/Steam"]) {
    for (const t of tails) cands.push(path.join(home, h, t));
  }
  cands.push("C:/Program Files (x86)/Steam/steamapps/common/wallpaper_engine/projects/defaultprojects");
  if (process.platform === "darwin" && fs.existsSync("/Volumes")) {
    let vols = [];
    try { vols = fs.readdirSync("/Volumes"); } catch { vols = []; }
    for (const v of vols) for (const t of tails) cands.push(path.join("/Volumes", v, "SteamLibrary", t));
  }
  for (const c of cands) {
    try { if (c && fs.statSync(c).isDirectory()) return c; } catch { /* continue */ }
  }
  return null;
}

let audited = 0;
const dp = locateDefaultProjects();
if (!dp) {
  console.log("  - 跳过源码族冻结表（未找到 WE defaultprojects，可用 WE_DEFAULTPROJECTS 指定）");
} else {
  for (const [rel, want] of Object.entries(EXPECT)) {
    const file = path.join(dp, rel);
    if (!fs.existsSync(file)) continue;
    audited++;
    if (want === null) {
      let msg = null;
      try { parseMDL(fs.readFileSync(file)); } catch (e) { msg = e.message; }
      check(msg !== null, `${rel}: 残缺资产应当解析失败（现在却成功了）`);
      if (msg !== null) check(/顶点区长度异常/.test(msg), `${rel}: 失败原因应指到布局（实际：${msg.slice(0, 80)}）`);
      continue;
    }
    let m = null;
    try { m = parseMDL(fs.readFileSync(file)); } catch (e) { fail(`${rel}: 解析失败（${e.message.slice(0, 80)}）`); continue; }
    const got = [m.positions.length / 3, m.indices.length, m.materialPath || null];
    check(
      got[0] === want[0] && got[1] === want[1] && got[2] === want[2],
      `${rel}: 期望 [${want.join(", ")}]，实际 [${got.join(", ")}]`,
    );
  }
  console.log(`  ✓ 源码族冻结表：${audited} 个模型逐项核对`);
}

// 打包语料：全部可解析（不比对具体数值——那由冻结表与 verify-* 的既有判据覆盖）
let pkgs = 0;
let mdls = 0;
const broken = [];
if (fs.existsSync(LIB)) {
  for (const item of fs.readdirSync(LIB)) {
    const p = path.join(LIB, item, "scene.pkg");
    if (!fs.existsSync(p)) continue;
    let pkg;
    try { pkg = parsePkg(fs.readFileSync(p)); } catch { continue; }
    pkgs++;
    for (const e of pkg.entries.filter((x) => x.name.endsWith(".mdl"))) {
      mdls++;
      try { parseMDL(getEntry(pkg, e.name)); } catch (err) { broken.push(`${item}/${e.name}: ${err.message.slice(0, 60)}`); }
    }
  }
}
if (mdls === 0) {
  console.log("  - 跳过打包语料（本机库不可用或没有 scene.pkg）");
} else {
  console.log(`  ${broken.length ? "✗" : "✓"} 打包语料：${pkgs} 个包 / ${mdls} 个 .mdl，失败 ${broken.length}`);
  for (const b of broken.slice(0, 8)) console.log("      · " + b);
  check(broken.length === 0, `打包语料出现 ${broken.length} 个解析失败的 .mdl`);
}

console.log("");
if (errors.length > 0) {
  console.log(`✗ 共 ${errors.length} 处问题`);
  process.exit(1);
} else {
  console.log("✓ 全部通过");
}
