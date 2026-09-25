#!/usr/bin/env node
/**
 * verify-lz4 —— LZ4 解压路径的离线对账（含「惰性 mip」契约）。
 *
 * 背景（两次实测结论都固化在这里，别再走回头路）：
 *   1. **逐字节循环已经是最快的**。同一份真实语料（232MB 压缩输入 / 776MB 产物 /
 *      5900 万个 token，平均匹配 21.6 字节）实测：逐字节 682ms，`set(subarray)` 1396ms
 *      —— 同 buffer 的 set 会走 clone 路径，慢一倍；`copyWithin` 1002ms；
 *      `copyWithin + 短匹配逐字节` 655ms（对逐字节只有 4% 量级，不值得换实现）。
 *      这份数据是 **token 密集**而不是字节密集，优化方向不在这里。
 *   2. 该省的是**「解了不用的层级」**：mip 链每级各自 LZ4，消费端只取够用的最小一级
 *      （pickMipLevel）或从 baseLevel 起截链，所以 parseTex 改成惰性（`lazyLz4Mip`）。
 *      本脚本顺带把这个契约钉住。
 *
 * 判据（不做自证）：
 *   · 输入取自真实语料：parseTex 出来的 `compression === 1` 的 mip 自带 `raw` 与
 *     `uncompressedSize`（惰性契约的一部分）；
 *   · 期望输出由本文件里的参考解码器独立算出 —— 按 LZ4 块格式逐条转写的朴素实现，
 *     与生产实现零共享代码；
 *   · 逐位比对「生产 lz4Decompress」与「mip.data 惰性取值」两条路径，并验证重复读取
 *     命中缓存（两次拿到同一个对象）。
 */
import fs from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { LIB, ROOT, itemDir, createChecker } from "./lib/verify-kit.mjs";

const { check, errors } = createChecker({ echo: true });

/** 覆盖：多级大图 / 8K / 小图集 / 视频纹理 / 木偶骨骼 */
const ITEMS = process.env.WE_LZ4_ITEMS
  ? process.env.WE_LZ4_ITEMS.split(",")
  : ["3662790108", "2955378002", "1039919954", "3570676582", "3470764447", "2887099508"];

/**
 * 参考解码器：按 LZ4 块格式逐条转写，**故意保持朴素**（逐字节前向复制）。
 * 它要当基准，不能和被测实现共享任何技巧。重叠匹配的语义天然正确：
 * 逐字节写且写入位置递增，读到的就是刚写进去的字节。
 */
function lz4Reference(src, outSize) {
  const out = new Uint8Array(outSize);
  let ip = 0;
  let op = 0;
  while (ip < src.length) {
    const token = src[ip++];
    let litLen = token >> 4;
    if (litLen === 15) {
      let b;
      do {
        b = src[ip++];
        litLen += b;
      } while (b === 255);
    }
    for (let i = 0; i < litLen; i++) out[op++] = src[ip++] ?? 0;
    if (ip >= src.length) break;
    const offset = src[ip] | (src[ip + 1] << 8);
    ip += 2;
    let matchLen = 4 + (token & 15);
    if ((token & 15) === 15) {
      let b;
      do {
        b = src[ip++];
        matchLen += b;
      } while (b === 255);
    }
    const start = op - offset;
    for (let i = 0; i < matchLen; i++) out[op++] = out[start + i];
  }
  return out;
}

const tex = await import(pathToFileURL(join(ROOT, "renderer/vendor/we-scene/pkg/texture.js")).href);
const container = await import(pathToFileURL(join(ROOT, "renderer/vendor/we-scene/pkg/container.js")).href);

/** 逐位比对；不一致就登记一条判据失败，并把首个差异位置报出来 */
const agrees = (a, b, what, where) => {
  if (a.length !== b.length) {
    check(false, `${where}: ${what} 长度不一致（${a.length} vs ${b.length}）`);
    return;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      check(false, `${where}: ${what} 第 ${i} 字节不一致（期望 ${a[i]}，实际 ${b[i]}）`);
      return;
    }
  }
};

let used = 0;
let vectors = 0;
let compressedBytes = 0;
let outBytes = 0;
let refMs = 0;
let prodMs = 0;
let lazyMips = 0;
let eagerMips = 0;

for (const id of ITEMS) {
  const pkgPath = join(itemDir(id), "scene.pkg");
  if (!fs.existsSync(pkgPath)) continue;
  used++;
  const pkg = container.parsePkg(new Uint8Array(fs.readFileSync(pkgPath)));
  const names = pkg.entries.filter((e) => e.name.endsWith(".tex")).map((e) => e.name);
  let itemVec = 0;
  for (const name of names) {
    let parsed;
    try {
      parsed = tex.parseTex(container.getEntry(pkg, name));
    } catch {
      continue;
    }
    for (const m of parsed.images?.[0] ?? []) {
      if (Number(m.compression) !== 1) {
        eagerMips++;
        continue;
      }
      lazyMips++;
      if (!m.raw || !(m.uncompressedSize > 0)) {
        check(false, `${name}: compression=1 的 mip 必须暴露 raw/uncompressedSize（惰性契约）`);
        continue;
      }
      const src = m.raw;
      const outSize = m.uncompressedSize;
      itemVec++;
      vectors++;
      compressedBytes += src.length;
      outBytes += outSize;

      let t = performance.now();
      const ref = lz4Reference(src, outSize);
      refMs += performance.now() - t;
      t = performance.now();
      const prod = tex.lz4Decompress(src, outSize);
      prodMs += performance.now() - t;

      agrees(ref, prod, "lz4Decompress", `${id}/${name}`);

      // 惰性取值路径 + 缓存：两次读必须是同一个对象，内容等于参考结果
      const d1 = m.data;
      const d2 = m.data;
      agrees(ref, d1, "mip.data（首次）", `${id}/${name}`);
      check(d1 === d2, `${id}/${name}: mip.data 重复读取必须命中缓存（同一个对象）`);
      check(d1.length === outSize, `${id}/${name}: mip.data 长度 ${d1.length} ≠ ${outSize}`);
    }
  }
  console.log(
    `  ${id}: ${names.length} 张贴图，LZ4 级 ${itemVec} 段` + (itemVec ? "  ✓ 逐位一致" : "（无 LZ4 级）"),
  );
}

if (used === 0) {
  console.log(`\nverify-lz4: 跳过（本机壁纸库里没有样本：${LIB}）`);
  process.exit(0);
}

check(vectors > 0, `语料里必须真的出现 LZ4 压缩块（拿到 ${vectors} 段，夹具失效或 corpus 变更）`);
check(lazyMips > 0 && eagerMips > 0, `两种 mip 都要覆盖到（压缩 ${lazyMips} / 未压缩 ${eagerMips}）`);

console.log(
  `\n参考实现 ${refMs.toFixed(0)}ms / 生产实现 ${prodMs.toFixed(0)}ms` +
    `（${vectors} 段，压缩输入 ${(compressedBytes / 1e6).toFixed(1)}MB → 产物 ${(outBytes / 1e6).toFixed(1)}MB）`,
);
console.log(`mip 覆盖：压缩 ${lazyMips} 级 / 未压缩 ${eagerMips} 级`);
console.log(errors.length === 0 ? "verify-lz4: 全部通过 ✓" : `verify-lz4: ${errors.length} 项失败 ✗`);
process.exit(errors.length === 0 ? 0 : 1);
