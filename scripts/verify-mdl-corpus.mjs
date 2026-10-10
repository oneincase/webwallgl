#!/usr/bin/env node
/**
 * verify-mdl-corpus —— 全库 .mdl 语料回归（PUPPET-WARP-FULL-PLAN P0 的判据）。
 *
 * 为什么单独一份：`verify-mdl-write` 的 A 段只扫 scene.pkg 里的 .mdl 并挑样本做深判；
 * 这里把**壁纸库里每一个 .mdl**（scene.pkg 条目 + 松散 models/*.mdl）都过一遍，验的是
 * P0 修掉的那个 bug 不许回来：
 *
 *   A. 结构解析率 100%：`readMdlDoc` 对每个文件都必须走结构路径 —— 整份退成 raw
 *      （`doc.raw`）或任一段退成 raw（`s.raw`）都算回归。修 bug 前 44% 的真实模型
 *      在这里退成 raw，编辑器对它们的任何编辑都是静默 no-op。
 *   B. 逐字节往返：`writeMdlDoc(readMdlDoc(bytes))` 必须与原字节完全相同（无损编辑的前提）。
 *   C. 段 / 骨骼同源：`parseMDL` 的 `bones` 与 `boneMeta`（head0 + 矩阵尾 JSON meta）与
 *      写侧文档逐值一致、长度相同 —— P0 之前解析侧把这两个字段整个丢掉。
 *   D. 摘要：版本分布、段出现次数、部件表 / 附着点 / 帧事件覆盖、MDLS meta 的填充情况、
 *      文件尾零填充分类（1 MiB 整条目、空尾、全零尾、非零尾 = MDMP 形变目标块等未知段）。
 *
 * 语料缺失（本机没装壁纸库）时跳过并仍算通过；用法：node scripts/verify-mdl-corpus.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { LIB, imp, createChecker, dec } from "./lib/verify-kit.mjs";

const { check, errors } = createChecker({ echo: true });
const W = await imp("renderer/vendor/we-scene/pkg/mdl-write.js");
const P = await imp("renderer/vendor/we-scene/render/mdl-parse.js");
const C = await imp("renderer/vendor/we-scene/pkg/container.js");
const S = await imp("renderer/vendor/we-scene/render/mdl-skin.js");

const sameBytes = (a, b) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);
const sameNums = (a, b) => !!a && !!b && a.length === b.length && Array.prototype.every.call(a, (x, i) => Object.is(x, b[i]) || x === b[i]);
const ascii = (u8, n) => String.fromCharCode.apply(null, Array.from(u8.subarray(0, n)));

/** 语料枚举：scene.pkg 内的 .mdl 条目 + 松散 .mdl */
function* corpus() {
  if (!fs.existsSync(LIB)) return;
  for (const id of fs.readdirSync(LIB)) {
    const dir = path.join(LIB, id);
    let st = null;
    try {
      st = fs.statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const pkgPath = path.join(dir, "scene.pkg");
    if (fs.existsSync(pkgPath)) {
      let pkg = null;
      try {
        pkg = C.parsePkg(new Uint8Array(fs.readFileSync(pkgPath)));
      } catch (e) {
        check(false, `${id}/scene.pkg: parsePkg 抛错 ${e.message}`);
      }
      for (const e of pkg ? pkg.entries : []) {
        if (/\.mdl$/i.test(e.name)) yield { id, name: e.name, where: "pkg", buf: C.getEntry(pkg, e.name) };
      }
    }
    // 松散 models/*.mdl（内建素材 / local-assets 这类）
    const loose = [];
    const walk = (p, depth) => {
      if (depth > 4) return;
      let list = [];
      try {
        list = fs.readdirSync(p, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of list) {
        const q = path.join(p, ent.name);
        if (ent.isDirectory()) walk(q, depth + 1);
        else if (/\.mdl$/i.test(ent.name)) loose.push(q);
      }
    };
    walk(dir, 0);
    for (const q of loose) yield { id, name: path.relative(dir, q), where: "loose", buf: new Uint8Array(fs.readFileSync(q)) };
  }
}

console.log("A. 结构解析率 / B. 逐字节往返 / C. 骨骼 head0 + meta 同源");
const byVer = new Map();
const sectionCount = new Map();
const head0Seen = new Map();
let files = 0;
let pkgFiles = 0;
let looseFiles = 0;
let wholeRaw = 0;
let rawSections = 0;
let roundTripBad = 0;
let parseBad = 0;
let boneMetaBad = 0;
let parseThrew = 0;
let bones = 0;
let metaNonEmpty = 0;
let partsFiles = 0;
let partsTotal = 0;
let attachFiles = 0;
let attachTotal = 0;
let animFiles = 0;
let eventTotal = 0;
let exactMiB = 0;
let tailEmpty = 0;
let tailZero = 0;
const tailNonZero = [];
const bad = [];

for (const { id, name, where, buf } of corpus()) {
  files++;
  if (where === "pkg") pkgFiles++;
  else looseFiles++;
  const tag = `${id}/${name}`;
  const ver = ascii(buf, 8);
  byVer.set(ver, (byVer.get(ver) || 0) + 1);

  let doc = null;
  try {
    doc = W.readMdlDoc(buf);
  } catch (e) {
    bad.push(`${tag} readMdlDoc 抛错 ${e.message}`);
    wholeRaw++;
    continue;
  }
  if (doc.raw) {
    wholeRaw++;
    bad.push(`${tag} 整份退成 raw`);
    continue;
  }
  for (const s of doc.sections) {
    sectionCount.set(s.type, (sectionCount.get(s.type) || 0) + 1);
    if (s.raw) {
      rawSections++;
      bad.push(`${tag} 段 ${s.type} 退成 raw`);
    }
  }
  const out = W.writeMdlDoc(doc);
  if (!sameBytes(out, buf)) {
    roundTripBad++;
    bad.push(`${tag} 往返字节不一致（${buf.length} → ${out.length}）`);
  }

  let m = null;
  try {
    m = P.parseMDL(buf);
  } catch (e) {
    parseThrew++;
    parseBad++;
    bad.push(`${tag} parseMDL 抛错 ${e.message}`);
    continue;
  }
  const mdls = doc.sections.find((s) => s.type === "MDLS" && !s.raw);
  const bm = m.boneMeta || [];
  bones += m.bones.length;
  if (mdls) {
    if (mdls.bones.length !== m.bones.length) {
      boneMetaBad++;
      bad.push(`${tag} 骨数：文档 ${mdls.bones.length} ≠ 解析 ${m.bones.length}`);
    } else if (bm.length !== m.bones.length) {
      boneMetaBad++;
      bad.push(`${tag} boneMeta 长度 ${bm.length} ≠ 骨数 ${m.bones.length}`);
    } else {
      for (let i = 0; i < m.bones.length; i++) {
        const b = mdls.bones[i];
        const text = b.meta === undefined ? "" : W.mdlText(b.meta);
        if (b.head0 !== bm[i].head0 || text !== (bm[i].meta ?? "")) {
          boneMetaBad++;
          bad.push(`${tag} 骨${i} head0 / meta 不同源`);
          break;
        }
        if ((bm[i].meta ?? "") !== "") metaNonEmpty++;
        head0Seen.set(bm[i].head0, (head0Seen.get(bm[i].head0) || 0) + 1);
      }
    }
  } else if (m.bones.length || bm.length) {
    boneMetaBad++;
    bad.push(`${tag} 无 MDLS 段却有骨（${m.bones.length} / ${bm.length}）`);
  }
  // 模型可蒙皮（骨 + 轨道同构）时还要跑一遍蒙皮矩阵：解析出来的骨不许让求解器抛错
  if (m.bones.length && m.animations.length) {
    try {
      S.computeSkinMatrices(m, 0, [{ animation: m.animations[0].id, visible: true, blend: 1, rate: 1, additive: false }]);
    } catch (e) {
      parseBad++;
      bad.push(`${tag} computeSkinMatrices 抛错 ${e.message}`);
    }
  }
  const parts = (m.meshes && m.meshes.length ? m.meshes : [m]).reduce((n, x) => n + ((x.parts && x.parts.length) || 0), 0);
  if (parts) {
    partsFiles++;
    partsTotal += parts;
  }
  if (m.attachments && m.attachments.length) {
    attachFiles++;
    attachTotal += m.attachments.length;
  }
  if (m.animations.length) {
    animFiles++;
    for (const a of m.animations) eventTotal += a.events.length;
  }

  // 文件尾：1 MiB 整条目 / 空尾 / 全零尾 / 非零尾（未知段，如 MDMP 形变目标，逐字节保留）
  const tail = doc.trailing || new Uint8Array(0);
  if (buf.length === 0x100000) exactMiB++;
  if (tail.length === 0) tailEmpty++;
  else if (tail.every((x) => x === 0)) tailZero++;
  else tailNonZero.push({ tag, len: tail.length, head: ascii(tail, 4) });
}

if (files === 0) {
  console.log(`  跳过语料部分（本机壁纸库里没有 .mdl：${LIB}）`);
} else {
  console.log(`  ${files} 个 .mdl（scene.pkg ${pkgFiles} + 松散 ${looseFiles}）：` + [...byVer].sort().map(([v, n]) => `${v}×${n}`).join(" "));
  console.log(`  段出现：` + [...sectionCount].sort().map(([t, n]) => `${t}×${n}`).join(" "));
  console.log(`  骨 ${bones} 根（meta 非空 ${metaNonEmpty}）；部件表 ${partsFiles} 文件 / ${partsTotal} 条；附着点 ${attachFiles} 文件 / ${attachTotal} 个；带动画 ${animFiles} 文件 / 帧事件 ${eventTotal} 条`);
  console.log(`  尾部：1 MiB 整条目 ${exactMiB}、空尾 ${tailEmpty}、全零尾 ${tailZero}、非零尾 ${tailNonZero.length}` +
    (tailNonZero.length ? "（" + tailNonZero.map((t) => `${t.tag} ${t.head} ${t.len}B`).join("；") + "）" : ""));
  console.log(`  head0 取值分布：` + [...head0Seen].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([v, n]) => `${v}×${n}`).join(" "));
  check(wholeRaw === 0, `整份退成 raw 的 .mdl ${wholeRaw} 个（P0 的 f32s bug 复发的标志）`);
  check(rawSections === 0, `退成 raw 的段 ${rawSections} 个`);
  check(roundTripBad === 0, `往返字节不一致 ${roundTripBad} 个`);
  check(parseThrew === 0 && parseBad === 0, `parseMDL / 蒙皮求解失败 ${parseBad} 个`);
  check(boneMetaBad === 0, `骨骼 head0 / meta 文档与解析不同源 ${boneMetaBad} 处`);
  check(tailNonZero.every((t) => /^MD/.test(t.head)), `非零尾必须是 MD* 未知段（逐字节保留）：${tailNonZero.map((t) => `${t.tag}:${t.head}`).join("；")}`);
  check(bones > 0, "语料里必须解析出骨骼（夹具失效）");
}

console.log(`\nverify-mdl-corpus: ${errors.length === 0 ? "全部通过 ✓" : `${errors.length} 处问题`}`);
if (errors.length) {
  console.log("不符明细（前 20 条）：\n" + errors.slice(0, 20).map((e) => "  ✗ " + e).join("\n"));
  process.exit(1);
}
