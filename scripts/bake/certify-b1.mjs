#!/usr/bin/env node
/**
 * certify-b1 —— B1「raw 源贴图预解码缓存」的认证：哪些壁纸真能从这条烘焙里省到钱。
 *
 * 背景（docs/BAKE-PLAN.md §3）：B1 在「强制全尺寸解码」路径上是 -77% 解码耗时，但
 * 真实运行时**不走那条路** —— ① `pickMipLevel` 按图层足迹选级；② DXT/BC/ETC 走
 * **压缩直传**（不解 RGBA）。所以 B1 的真实可省上限 = 「走 JS 解码路径的贴图」的解码
 * 耗时 + LZ4 解压耗时，而不是全部贴图的解码耗时。
 *
 * 本脚本按**运行时同一套规则**离线算这笔账：
 *   · 选级用 resource-scale 的 targetLong / pickMipLevel（档位上限口径，足迹只会更小
 *     → 这是上界，与 B3 的烘焙尺寸口径一致）；
 *   · 路径判定：内嵌 PNG/JPEG（B3 已覆盖）/ 压缩直传（s3tc + ETC，本机实测可用）
 *     / 视频 → B1 只能省 LZ4；其余原始格式 → B1 能省解码 + LZ4；
 *   · 耗时是真跑 decodeMipLevel / parseTex（引擎自己的代码，与浏览器逐位一致）。
 *
 * 结论以「多少张墙的可省时间 ≥ 阈值」的形式给出 —— 这就是「值不值得实现 B1」的判据。
 *
 * ── 认证结论（2026-09-26，48 张样本 + 5 张已知重墙交叉验证）：**B1 不值得做** ──
 *   可省时间中位 **15ms**、最大 551ms、48 张合计 1.7s；**11 张可省为 0**；
 *   ≥200ms 只有 2 张（4%）、≥500ms 1 张、≥1s 0 张。
 *   交叉验证：2955378002 可省 176ms（JS 32 + LZ4 144）、3662790108 123ms（JS 9 + LZ4 114，
 *   与运行时 profile 的 lz4Decompress ≈185ms 同量级）。
 *   最佳个案 2212279721：551ms 换 360MB 缓存 —— 不划算。
 *   为什么这么少：① 多数贴图是 format 0（RGBA8888），"解码"只是一次拷贝、还在被选小的
 *   mip 级上；② DXT/ETC 走压缩直传，B1 只能省 LZ4；③ LZ4 本来就小（多贴图 compression=0）。
 *   （之前 BAKE-PLAN 里那个 −77% 是**强制全尺寸解码路径**的上界，运行时不走那条路。）
 *
 * **计时陷阱（改这个脚本前必读）**：惰性 mip（lazyLz4Mip）之后 `parseTex` 几乎免费 ——
 * LZ4 被推迟到第一次读 `.data`。所以 LZ4 成本必须**按运行时会读哪几级的 `.data` 去触发**
 * 才量得到；按 `parseTex` 计时会全是 0，漏掉直传路径的 LZ4（那正是 B1 唯一能省的部分）。
 *
 * 墙型若换到「raw 源 + 大量 LZ4」占主流，重跑本脚本即可翻案。
 *
 * 用法：node scripts/bake/certify-b1.mjs [--sample 24 | --items 1,2,3] [--tier 0.6]
 */
import fs from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { LIB, ROOT } from "../lib/verify-kit.mjs";

const container = await import(pathToFileURL(join(ROOT, "renderer/vendor/we-scene/pkg/container.js")).href);
const tex = await import(pathToFileURL(join(ROOT, "renderer/vendor/we-scene/pkg/texture.js")).href);
const codecs = await import(pathToFileURL(join(ROOT, "renderer/vendor/we-scene/pkg/tex-codecs.js")).href);

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};
const TIER = Number(arg("--tier", 0.6)); // 自动档在 DPR 1 下就是 0.6（resource-scale）
const SAMPLE = arg("--sample", null) ? Number(arg("--sample", 24)) : null;
const ONLY = arg("--items", null) ? arg("--items", "").split(",").filter(Boolean) : null;

/** 本机实测可用的压缩直传（perf-bench 里 probeRenderer 读过：s3tc ✓ / bptc ✗ / etc ✓ / astc ✓）。
 *  换平台要重算 —— 所以这里把格式原样记进结果，结论可按平台重判。 */
const PASSTHROUGH_FMT = new Set([7, 6, 4, 3, 5, 13]); // DXT1/3/5、ETC1/2、ASTC
const now = () => Number(process.hrtime.bigint()) / 1e6;

/** 与 resource-scale.targetLong 同规则（档位上限） */
const targetLong = (nativeLong, R) => (!nativeLong || R >= 1 ? nativeLong : Math.max(32, Math.round(nativeLong * R)));
/** 与 resource-scale.pickMipLevel 同规则（needFloor=0：无足迹信息，取上限内最省的一级） */
function pickMipLevel(sizes, target) {
  if (!sizes || sizes.length <= 1 || !target) return 0;
  for (let i = 0; i < sizes.length; i++) if (sizes[i] <= target) return i;
  return sizes.length - 1;
}

// 选样：按 pkg 体积分层（小/中/大/超大各取），或显式 --items
const all = fs
  .readdirSync(LIB)
  .filter((d) => !d.startsWith("."))
  .map((d) => {
    const p = join(LIB, d, "scene.pkg");
    let size = 0;
    try {
      size = fs.statSync(p).size;
    } catch {}
    return { id: d, size };
  })
  .filter((x) => x.size > 0)
  .sort((a, b) => a.size - b.size);
let picked;
if (ONLY) {
  picked = ONLY.map((id) => all.find((x) => x.id === id)).filter(Boolean);
} else {
  const n = SAMPLE ?? 24;
  const step = Math.max(1, Math.floor(all.length / n));
  picked = all.filter((_, i) => i % step === 0).slice(0, n);
}

const rows = [];
for (const { id, size } of picked) {
  const t0 = now();
  let pkg;
  try {
    pkg = container.parsePkg(new Uint8Array(fs.readFileSync(join(LIB, id, "scene.pkg"))));
  } catch {
    continue;
  }
  let lz4Ms = 0;
  let jsDecodeMs = 0;
  let jsTex = 0;
  let passTex = 0;
  let passBytes = 0;
  let embedTex = 0;
  let videoTex = 0;
  let jsBytesIn = 0;
  let jsPx = 0;
  let jsBytesOut = 0;
  const fmtHist = {};
  for (const e of pkg.entries.filter((x) => x.name.endsWith(".tex"))) {
    const raw = container.getEntry(pkg, e.name);
    let t = now();
    let parsed;
    try {
      parsed = tex.parseTex(raw);
    } catch {
      continue;
    }
    // parseTex 现在是**惰性**的（lazyLz4Mip：LZ4 被推迟到第一次读 .data），
    // 所以这里只测到容器解析，LZ4 的真实成本要按「运行时会读哪几级的 .data」去触发。
    void t;
    const fmt = Number(parsed.format);
    fmtHist[fmt] = (fmtHist[fmt] || 0) + 1;
    if (parsed.isVideo) {
      videoTex++;
      continue;
    }
    if (parsed.freeImageFormat !== tex.FIF.UNKNOWN) {
      embedTex++;
      continue;
    }
    // 选级（档位上限口径）
    const mips = parsed.images?.[0] || [];
    const sizes = mips.map((m) => Math.max(m.width, m.height));
    const nativeLong = Math.max(Number(parsed.width || 0), Number(parsed.height || 0), sizes[0] || 0);
    const level = pickMipLevel(sizes, targetLong(nativeLong, TIER));
    const m = mips[level];
    if (!m) continue;
    if (PASSTHROUGH_FMT.has(fmt)) {
      // 压缩直传：运行时把**从 level 起的整条链**的块交给 GPU（makeCompressedTextureMip
      // 逐级读 .data）→ 这几级的 LZ4 就是 B1 唯一能省的
      passTex++;
      for (let k = level; k < mips.length; k++) {
        const lt = now();
        passBytes += mips[k].data?.length ?? 0;
        lz4Ms += now() - lt;
      }
      continue;
    }
    // JS 解码路径：B1 能省「这一级的 LZ4 + 像素解码」。先触发 .data（LZ4），
    // 再单独计 decodeMipLevel —— 两级分开才能归因
    jsTex++;
    jsBytesIn += raw.length;
    let lt = now();
    void m.data;
    lz4Ms += now() - lt;
    t = now();
    let out = null;
    try {
      out = tex.decodeMipLevel(parsed, level);
    } catch {
      /* 坏贴图跳过 */
    }
    jsDecodeMs += now() - t;
    if (out?.rgba) {
      jsPx += out.width * out.height;
      jsBytesOut += out.rgba.byteLength;
    }
  }
  rows.push({
    id,
    pkgMB: size / 1e6,
    lz4Ms: +lz4Ms.toFixed(0),
    jsDecodeMs: +jsDecodeMs.toFixed(0),
    jsTex,
    passTex,
    embedTex,
    videoTex,
    passMB: +(passBytes / 1e6).toFixed(1),
    jsInMB: +(jsBytesIn / 1e6).toFixed(1),
    jsOutMB: +(jsBytesOut / 1e6).toFixed(1),
    jsMPx: +(jsPx / 1e6).toFixed(1),
    fmtHist,
    totalMs: +(now() - t0).toFixed(0),
    // B1 的可省上限 = JS 解码 + LZ4（两者都是运行时的纯 JS 成本）
    saveableMs: +(jsDecodeMs + lz4Ms).toFixed(0),
  });
}

rows.sort((a, b) => b.saveableMs - a.saveableMs);
const med = (a) => {
  const s = a.slice().sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};
console.log(`认证样本 ${rows.length} 张（档位 R=${TIER}；选级按档位上限 = 可省上限）`);
console.log(`\n可省时间（JS 解码 + LZ4）排名前 12：`);
console.log("  id           pkg MB  可省ms  JS解码ms  LZ4ms  JS贴图  直传  内嵌  JS产物MB");
for (const r of rows.slice(0, 12)) {
  console.log(
    `  ${r.id.padEnd(12)} ${r.pkgMB.toFixed(0).padStart(6)}  ${String(r.saveableMs).padStart(6)}  ${String(r.jsDecodeMs).padStart(8)}  ${String(r.lz4Ms).padStart(6)}  ${String(r.jsTex).padStart(5)}  ${String(r.passTex).padStart(4)}  ${String(r.embedTex).padStart(4)}  ${r.jsOutMB.toFixed(0).padStart(7)}`,
  );
}
const sum = (k) => rows.reduce((n, r) => n + (r[k] || 0), 0);
console.log(`\n汇总（${rows.length} 张）：`);
console.log(`  可省时间 中位 ${med(rows.map((r) => r.saveableMs))}ms / 最大 ${Math.max(...rows.map((r) => r.saveableMs))}ms / 合计 ${(sum("saveableMs") / 1000).toFixed(1)}s`);
console.log(`  其中 JS 解码 中位 ${med(rows.map((r) => r.jsDecodeMs))}ms，LZ4 中位 ${med(rows.map((r) => r.lz4Ms))}ms`);
console.log(`  贴图路径分布：JS 解码 ${sum("jsTex")} 张 / 压缩直传 ${sum("passTex")} 张 / 内嵌 ${sum("embedTex")} 张 / 视频 ${sum("videoTex")} 张`);
console.log(`  产物体积（RGBA 下界）：JS 解码路径合计 ${sum("jsOutMB").toFixed(0)}MB；压缩直传块合计 ${sum("passMB").toFixed(0)}MB`);
console.log(`\n分档（B1 值不值得做的判据）：`);
for (const th of [200, 500, 1000, 2000]) {
  const hit = rows.filter((r) => r.saveableMs >= th);
  console.log(`  可省 ≥ ${String(th).padStart(4)}ms：${String(hit.length).padStart(3)} 张 / ${rows.length}（${((hit.length / rows.length) * 100).toFixed(0)}%）`);
}
console.log(`\n格式直方图（换平台要重判直传集合）：`);
const fmtAll = {};
for (const r of rows) for (const [k, v] of Object.entries(r.fmtHist)) fmtAll[k] = (fmtAll[k] || 0) + v;
for (const [k, v] of Object.entries(fmtAll).sort((a, b) => b[1] - a[1])) {
  console.log(`  format ${k.padEnd(3)} ${String(v).padStart(5)} 张  ${PASSTHROUGH_FMT.has(Number(k)) ? "→ 直传（B1 只省 LZ4）" : "→ JS 解码（B1 省解码+LZ4）"}`);
}
fs.writeFileSync("/tmp/perf-bench/certify-b1.json", JSON.stringify(rows, null, 1));
console.log(`\n明细：/tmp/perf-bench/certify-b1.json`);
