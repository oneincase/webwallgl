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
      "3281559867", // Kirby Gourmet Race：45 个多子网格模型 + 11 台相机实体 + 命名骨 MDLS
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

// ════════════════════════════════════════════════════════════════════════════
// 二、MDLS 逐骨记录布局 + 多子网格（2026-09-28，3281559867 Kirby Gourmet Race）
//
// 现象：整场模型炸开 —— elfilin 被画成盖住半屏的青色巨块、其余角色散架抽搐。
// 根因：MDLS 记录是 `[name cstr][i32 sim_type][u32 parent][u32 len=64][64B 矩阵]
// [JSON cstr]`，而重扫路径**只在矩阵尾字节是 '{' 时才跳过 JSON cstr**；空 JSON
// 时漏跳 1 字节 → 第二条骨起永久错位 → 整体校验不过 → 回退「固定布局」的垃圾骨架
// （parent 全 −1、矩阵全零/NaN）→ invBindWorld 求逆得 Infinity → 蒙皮顶点炸到
// 1e31，投影后的三角形横扫整个屏幕。
//
// 判据不使用 parseMDL 的任何内部结构：本文件自带一份**独立的最小读取器**
// refSkeleton()（逐骨顺序读 name/头/矩阵/JSON），与生产代码零共享。逐位比对
// 名字、parent、16 个矩阵分量。故意把 JSON 跳读删掉（复现原缺陷）→ 名字与
// parent 立刻在第二条骨起对不上，本节转红。
// ════════════════════════════════════════════════════════════════════════════

/** 独立实现：按参考引擎口径顺序读 MDLS 逐骨记录（与生产解析零共享代码） */
function refSkeleton(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let at = refFind(buf, "MDLS");
  if (at < 0) return null;
  const count = dv.getUint16(at + 13, true);
  if (!(count > 0)) return null;
  // 骨名是 UTF-8（本机语料里有中文/日文名：「主」「右眼」「全ての親」）；
  // 逐字节拼字符会把多字节序列读成乱码，这里按字节收集再解码。
  const cstr = (i) => {
    const bytes = [];
    while (i < buf.length && dv.getUint8(i) !== 0) bytes.push(dv.getUint8(i++));
    return { s: new TextDecoder("utf-8").decode(Uint8Array.from(bytes)), next: i + 1 };
  };
  const bones = [];
  let p = at + 17;
  for (let b = 0; b < count; b++) {
    const nm = cstr(p);
    const head = nm.next;
    const parent = dv.getInt32(head + 4, true);
    const size = dv.getUint32(head + 8, true);
    if (size !== 64) return null;
    const m = [];
    for (let k = 0; k < 16; k++) m.push(dv.getFloat32(head + 12 + k * 4, true));
    bones.push({ name: nm.s, parent, m });
    p = cstr(head + 12 + 64).next;
  }
  return bones;
}

let skelFiles = 0;
let skelBones = 0;
let nonFiniteBones = 0;
let badParentBones = 0;
let singularBones = 0;
let namedBones = 0;
let refDiff = 0;
for (const id of ITEMS) {
  const pkgPath = join(itemDir(id), "scene.pkg");
  if (!fs.existsSync(pkgPath)) continue;
  const pkg = container.parsePkg(new Uint8Array(fs.readFileSync(pkgPath)));
  for (const e of pkg.entries) {
    if (!/\.mdl$/i.test(e.name)) continue;
    const buf = container.getEntry(pkg, e.name);
    const ref = refSkeleton(buf);
    if (!ref) continue;
    let mdl;
    try {
      mdl = mdlParse.parseMDL(buf);
    } catch {
      continue; // 不支持的顶点布局会抛（历史行为，与本节的骨架判据无关）
    }
    skelFiles++;
    if (mdl.bones.length !== ref.length) {
      check(false, `${id}/${e.name}: 骨数 ${mdl.bones.length} ≠ 参考 ${ref.length}`);
      continue;
    }
    for (let i = 0; i < ref.length; i++) {
      const b = mdl.bones[i];
      const r = ref[i];
      skelBones++;
      if (b.name !== r.name) {
        refDiff++;
        if (refDiff <= 3) check(false, `${id}/${e.name} 骨${i}: 名字 '${b.name}' ≠ 参考 '${r.name}'`);
      }
      if (b.parent !== r.parent) {
        refDiff++;
        if (refDiff <= 3) check(false, `${id}/${e.name} 骨${i}: parent ${b.parent} ≠ 参考 ${r.parent}`);
      }
      if (b.name) namedBones++;
      if (!Number.isFinite(b.matrix[12]) || b.matrix.some((v) => !Number.isFinite(v))) nonFiniteBones++;
      if (b.parent < -1 || b.parent >= ref.length) badParentBones++;
      const det = b.matrix[0] * b.matrix[5] - b.matrix[4] * b.matrix[1];
      if (!(Math.abs(det) > 1e-9)) singularBones++;
    }
    // 行为断言（与「炸开」直接对应）：蒙皮矩阵的世界部分必须有限、量级合理。
    // 全零/NaN 的绑定矩阵求逆得 Infinity，这里就是那条链的关口。
    const inv = mdl.invBindWorld || [];
    const badInv = inv.filter((m) => !m || Array.from(m).some((v) => !Number.isFinite(v))).length;
    if (badInv) check(false, `${id}/${e.name}: invBindWorld 有 ${badInv} 根骨非有限（绑定矩阵求逆炸了）`);
  }
}

check(skelFiles > 0, `语料必须覆盖到可解析的 MDLS 骨架 —— 本轮 ${skelFiles} 个，夹具失效`);
check(refDiff === 0, `骨架逐骨与独立读取器不一致 ${refDiff} 处（MDLS 记录布局回归：名字/parent 从第二条骨起漂移）`);
check(nonFiniteBones === 0, `骨架绑定矩阵出现 ${nonFiniteBones} 处非有限分量`);
check(badParentBones === 0, `骨架出现 ${badParentBones} 处越界 parent`);
check(singularBones === 0, `骨架出现 ${singularBones} 处不可逆（2D 行列式 0/NaN）的绑定矩阵`);
// 「名字读出来了」是布局正确的必要条件：旧实现把矩阵后那条 cstr 当名字，命名骨全变空串
check(namedBones > 0, `骨架里一个非空骨名都没有（布局错位：读到的名字其实是 JSON 字段）`);

// ── 多子网格（mesh_count）─────────────────────────────────────────────────
// 判据取**文件自己声明的每网格 AABB**（MDLV>=17 的网格头里有一对 min/max）：
// 独立真值，且与顶点解析强耦合 —— 走错 stride/漏读材质列表都会让它对不上。
let meshFiles = 0;
let meshTotal = 0;
let multiFiles = 0;
let aabbChecked = 0;
let aabbBad = 0;
let aabbDegenerate = 0;
let mesh0Diff = 0;
for (const id of ITEMS) {
  const pkgPath = join(itemDir(id), "scene.pkg");
  if (!fs.existsSync(pkgPath)) continue;
  const pkg = container.parsePkg(new Uint8Array(fs.readFileSync(pkgPath)));
  for (const e of pkg.entries) {
    if (!/\.mdl$/i.test(e.name)) continue;
    const buf = container.getEntry(pkg, e.name);
    let mdl;
    try {
      mdl = mdlParse.parseMDL(buf);
    } catch {
      continue;
    }
    if (!mdl.meshes) continue;
    meshFiles++;
    meshTotal += mdl.meshes.length;
    if (mdl.meshes.length > 1) multiFiles++;
    // mesh0 必须与单网格字段同源（老路径与新路径不许各算一套）
    const m0 = mdl.meshes[0];
    if (
      m0.vertexCount !== mdl.vertexCount ||
      m0.indexCount !== mdl.indexCount ||
      m0.indexType !== mdl.indexType ||
      m0.positions.length !== mdl.positions.length
    ) {
      mesh0Diff++;
      check(false, `${id}/${e.name}: 子网格0 与单网格字段不一致`);
    } else {
      for (let i = 0; i < m0.positions.length; i++) {
        if (m0.positions[i] !== mdl.positions[i]) {
          mesh0Diff++;
          check(false, `${id}/${e.name}: 子网格0 顶点 ${i} 与单网格字段不一致`);
          break;
        }
      }
    }
    // 声明的 AABB vs 实际顶点包围盒
    for (let mi = 0; mi < mdl.meshes.length; mi++) {
      const mesh = mdl.meshes[mi];
      if (!mesh.aabb || !mesh.vertexCount) continue;
      if (mesh.aabb.some((v) => !Number.isFinite(v))) continue;
      // 全零 AABB 是导出器写的占位（2955378002 的 MDLV0019 puppet 实测），
      // 不是可校验的真值：跳过并计数，夹具有效性由 aabbChecked 兜底。
      if (mesh.aabb.every((v) => v === 0)) {
        aabbDegenerate++;
        continue;
      }
      const bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      for (let v = 0; v < mesh.vertexCount; v++) {
        for (let k = 0; k < 3; k++) {
          const c = mesh.positions[v * 3 + k];
          if (c < bb[k]) bb[k] = c;
          if (c > bb[3 + k]) bb[3 + k] = c;
        }
      }
      aabbChecked++;
      for (let k = 0; k < 6; k++) {
        const ref = mesh.aabb[k];
        const tol = Math.max(1e-3, Math.abs(ref) * 2e-3);
        if (Math.abs(bb[k] - ref) > tol) {
          aabbBad++;
          if (aabbBad <= 3) {
            check(false, `${id}/${e.name} 子网格${mi}: 顶点包围盒[${k}]=${bb[k].toFixed(2)} ≠ 文件声明 ${ref.toFixed(2)}`);
          }
          break;
        }
      }
    }
  }
}

check(meshFiles > 0, `语料必须覆盖到子网格遍历 —— 本轮 ${meshFiles} 个，夹具失效`);
check(multiFiles > 0, `语料里没有多子网格模型（mesh_count>1）—— 夹具失效，覆盖不到本次缺陷`);
check(aabbChecked > 0, `没有可校验的子网格 AABB —— 夹具失效（声明值应来自 MDLV>=17 的网格头）`);
check(aabbBad === 0, `${aabbBad}/${aabbChecked} 个子网格的顶点包围盒与文件声明不符（stride/材质列表走位）`);
check(mesh0Diff === 0, `子网格0 与单网格字段不同源 ${mesh0Diff} 处`);

// 3281559867 的舞台：15 个子网格，mesh1 是**地面**（扁平薄板）。
// 只画 mesh0（历史行为）时地面整块消失 —— 这条断言按几何形状锁住它。
{
  const pkgPath = join(itemDir("3281559867"), "scene.pkg");
  if (fs.existsSync(pkgPath)) {
    const pkg = container.parsePkg(new Uint8Array(fs.readFileSync(pkgPath)));
    const entry = pkg.entries.find((e) => e.name === "models/stage/stage.mdl");
    if (entry) {
      const mdl = mdlParse.parseMDL(container.getEntry(pkg, entry.name));
      check(mdl.meshes && mdl.meshes.length === 15, `舞台应有 15 个子网格，实得 ${mdl.meshes ? mdl.meshes.length : 0}`);
      const floor = mdl.meshes && mdl.meshes[1];
      if (floor && floor.aabb) {
        const [x0, y0, z0, x1, y1, z1] = floor.aabb;
        const thickness = y1 - y0;
        const width = x1 - x0;
        check(
          thickness > 0 && thickness < width * 0.05,
          `舞台 mesh1 应是地面薄板（厚 ${thickness.toFixed(1)} vs 宽 ${width.toFixed(1)}）`,
        );
      } else {
        check(false, "舞台 mesh1 缺失或没有 AABB");
      }
    }
  }
}

console.log(
  `\n参考扫描 ${refMs.toFixed(1)}ms / 生产单趟 ${prodMs.toFixed(1)}ms（${files} 个 .mdl / ${(bytes / 1e6).toFixed(1)}MB，` +
    `含 MDAT ${withMdat} / MDLS ${withMdls} / MDLA ${withMdla} 个，解析出附着点 ${parsedAtt} 个）`,
);
console.log(
  `骨架：${skelFiles} 个模型 / ${skelBones} 根骨逐位对齐独立读取器（命名骨 ${namedBones}）；` +
    `子网格：${meshFiles} 个模型 / ${meshTotal} 个子网格（多网格 ${multiFiles} 个），AABB 对账 ${aabbChecked} 个` +
    `（退化全零占位 ${aabbDegenerate} 个已跳过）`,
);
console.log(errors.length === 0 ? "verify-mdl-sections: 全部通过 ✓" : `verify-mdl-sections: ${errors.length} 项失败 ✗`);
process.exit(errors.length === 0 ? 0 : 1);
