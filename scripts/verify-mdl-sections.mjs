#!/usr/bin/env node
/**
 * verify-mdl-sections —— MDL 段定位改「单趟扫描」后的离线对账。
 *
 * 为什么需要：`parseMDL` 原来对四个段签名各做一次扫描（MDAT/MDLS/MDLA/MDLE），
 * 改成 `findMdlSections` 一趟扫完之后，**判据只剩「偏移找对了没有」** —— 找错的后果
 * 不是报错而是静默降级：MDAT 漏掉 → 挂件不再跟随骨骼（3790987854 的头偏出脖子）、
 * MDLS 漏掉 → 整个 puppet 不渲染、MDLE 漏掉 → 静止姿势校正变单位阵。
 *
 * 判据（不做自证）：期望值由本文件里的参考扫描独立算出 —— 每个签名各自一趟朴素
 * 逐字节比较，与生产实现的「扫 'M' + 四分支分派」零共享代码。
 * 特别注意 MDAT 是 **`MDA`** 前缀（不是 MDL）：按 MDL 筛选会整块漏掉附着点表，
 * 所以判据里对 MDAT 单独留了一条语料级断言。
 *
 * 语料缺失（本机没装壁纸库）时跳过而非失败：与其它 verifier 同策略。
 */
import fs from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { LIB, ROOT, itemDir, createChecker } from "./lib/verify-kit.mjs";

const { check, errors } = createChecker({ echo: true });

/** 含 puppet / 真 3D 网格的壁纸（MDL 解析的覆盖面：蒙皮、附着点、静止姿势、真网格） */
const ITEMS = process.env.WE_MDL_ITEMS
  ? process.env.WE_MDL_ITEMS.split(",")
  : [
      "3662790108", // 247 个 mesh（本机最大的一批模型）
      "2955378002",
      "2998757800", // 骨骼拖拽（MDLV0016）
      "2477602742", // 三节火车（MDLV0013）
      "3735447194", // Puppet Warp
      "3233141951",
      "2566558804",
      "3226487183",
      "3186328539",
      "3797270925", // 新版 Puppet Warp 导出
      "3509243656", // 真 3D 网格
    ];

/** 参考实现：单个签名一趟朴素逐字节比较（最显然正确的形式，不共享被测代码） */
function refFind(buf, sig) {
  const bad = buf.length - sig.length;
  outer: for (let p = 0; p <= bad; p++) {
    for (let k = 0; k < sig.length; k++) {
      if (buf[p + k] !== sig.charCodeAt(k)) continue outer;
    }
    return p;
  }
  return -1;
}

const mdlMath = await import(pathToFileURL(join(ROOT, "renderer/vendor/we-scene/render/mdl-math.js")).href);
const mdlParse = await import(pathToFileURL(join(ROOT, "renderer/vendor/we-scene/render/mdl-parse.js")).href);
const container = await import(pathToFileURL(join(ROOT, "renderer/vendor/we-scene/pkg/container.js")).href);

const SIGS = ["MDAT", "MDLS", "MDLA", "MDLE"];
let used = 0;
let files = 0;
let bytes = 0;
let withMdat = 0;
let withMdla = 0;
let withMdls = 0;
let parsedAtt = 0;
let refMs = 0;
let prodMs = 0;

for (const id of ITEMS) {
  const pkgPath = join(itemDir(id), "scene.pkg");
  if (!fs.existsSync(pkgPath)) continue;
  used++;
  const pkg = container.parsePkg(new Uint8Array(fs.readFileSync(pkgPath)));
  const names = pkg.entries.filter((e) => /\.mdl$/i.test(e.name)).map((e) => e.name);
  let itemFiles = 0;
  for (const name of names) {
    const buf = container.getEntry(pkg, name);
    files++;
    itemFiles++;
    bytes += buf.length;

    let t = performance.now();
    const ref = {};
    for (const s of SIGS) ref[s] = refFind(buf, s);
    refMs += performance.now() - t;
    t = performance.now();
    const got = mdlMath.findMdlSections(buf);
    prodMs += performance.now() - t;

    for (const s of SIGS) {
      if (got[s] !== ref[s]) check(false, `${id}/${name}: ${s} 偏移 ${got[s]} ≠ 参考 ${ref[s]}`);
    }
    if (ref.MDAT >= 0) {
      withMdat++;
      // 「解析出附着点」只在语料层面断言：4 字节 "MDAT" 完全可能是顶点数据里的偶然
      // 命中（lucy.mdl 就是 —— count 字段读出 49008，被 parseAttachments 的合法性
      // 上限挡掉，返回空表；这是**改动前就有的**行为，偏移也对得上）。逐文件断言
      // 会产出假失败，所以这里只累计。
      if ((mdlParse.parseMDL(buf).attachments ?? []).length > 0) parsedAtt++;
    }
    if (ref.MDLA >= 0) withMdla++;
    if (ref.MDLS >= 0) withMdls++;
    // 无 MDLS 是合法的：真 3D 网格（3509243656 的天空盒/球体/圆柱）是非蒙皮模型，
    // 只有 MDLV 顶点区。所以这里不做「每个 mdl 都要有骨架」的断言（曾经这么写过，
    // 结果是 77 条假失败），只在语料层面要求两种形态都出现过。
  }
  if (itemFiles) console.log(`  ${id}: ${itemFiles} 个 .mdl  ✓ 段偏移与参考扫描逐位一致`);
}

if (used === 0) {
  console.log(`\nverify-mdl-sections: 跳过（本机壁纸库里没有样本：${LIB}）`);
  process.exit(0);
}

check(files > 0, `语料里必须真的出现 .mdl（拿到 ${files} 个）`);
// MDAT 是 `MDA` 不是 `MDL`：语料里必须真的有它，否则「按 MDL 筛前缀」这类回归检测不到
check(withMdat > 0, `语料必须覆盖到 MDAT（附着点表）—— 本轮 0 个，夹具失效`);
// 真判据：语料里必须至少有一个模型的附着点表**能解析出来**（MDAT 定位错了就全空）
check(parsedAtt > 0, `没有任何模型解析出附着点表（MDAT 定位或解析回归）`);
check(withMdla > 0, `语料必须覆盖到 MDLA（动画轨道）—— 本轮 0 个，夹具失效`);
check(withMdls > 0, `语料必须覆盖到 MDLS（骨架）—— 本轮 0 个，夹具失效`);

console.log(
  `\n参考扫描 ${refMs.toFixed(1)}ms / 生产单趟 ${prodMs.toFixed(1)}ms（${files} 个 .mdl / ${(bytes / 1e6).toFixed(1)}MB，` +
    `含 MDAT ${withMdat} / MDLS ${withMdls} / MDLA ${withMdla} 个，解析出附着点 ${parsedAtt} 个）`,
);
console.log(errors.length === 0 ? "verify-mdl-sections: 全部通过 ✓" : `verify-mdl-sections: ${errors.length} 项失败 ✗`);
process.exit(errors.length === 0 ? 0 : 1);
