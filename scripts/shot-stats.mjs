#!/usr/bin/env node
/**
 * shot-stats —— 出帧对照的**统一口径**（把「我们 vs 官方」从肉眼变成可复现的数字）。
 *
 * 为什么需要：官方内置工程每个目录都有 `preview.jpg`（少数是 `preview.gif`），
 * 它们是「同一张贴纸的另一个渲染器出的图」。没有统一口径时，每轮排查都要临时写一段
 * 「取缩略图 → 分位统计」的脚本，结论无法复现、也无法跨轮比较（DEFAULTPROJECTS-PLAN
 * 续十五就是这么做的，事后补了这张工具）。
 *
 * **口径（不可随意改，改了要在判据里同步）**：
 *   · 统一缩到 256×144（cover 裁剪）再统计 —— 消掉分辨率差异；
 *   · 输出：均值 / p50 / p99 / 前 1% 均值 / ≥250 占比（过曝）；官方图**过曝应接近 0**
 *     （引擎是 LDR 直出，正常场景不该有整片 255）；
 *   · `--ratio` 只对**峰值**可信（均值受取景影响：官方 preview 多是编辑器/整景出图，
 *     我们的相机路径可能贴得很近）。这条写在输出里，避免下次又拿均值当结论。
 *
 * 用法：
 *   node scripts/shot-stats.mjs <图A> [图B]                 # 单图或两图对比
 *   node scripts/shot-stats.mjs --pair <我们的目录> <官方目录>  # 同名配对（<工程>.jpg vs preview.*）
 *   node scripts/shot-stats.mjs --pair ... --out report.json
 *
 * 依赖：JPEG/PNG 走 Node 内置解码（无第三方依赖）；GIF 只取第一帧（本机 preview.gif 少见）。
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** 纯 JS 的 JPEG 解码（无依赖）：用 Chrome 的 ImageDecoder 不可用时回落 —— 这里直接用
 *  系统 `sips` 是 macOS 专有，故改为**要求 PNG/PPM**：调用方先用 ffmpeg/sips 转好。
 *  为了「零依赖 + 跨机可跑」，本工具只解析 PNG（Node 内置 zlib 足以解压）。 */
function decodePng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  let off = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) return null;
  const zlib = require("node:zlib");
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const ch = colorType === 6 ? 4 : 3;
  const stride = width * ch;
  const out = Buffer.alloc(width * height * 3);
  const prev = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const line = Buffer.from(raw.subarray(p, p + stride));
    p += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? line[x - ch] : 0;
      const b = prev[x];
      const c = x >= ch ? prev[x - ch] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[x] = v & 0xff;
    }
    line.copy(prev);
    for (let x = 0; x < width; x++) {
      out[(y * width + x) * 3] = line[x * ch];
      out[(y * width + x) * 3 + 1] = line[x * ch + 1] ?? line[x * ch];
      out[(y * width + x) * 3 + 2] = line[x * ch + 2] ?? line[x * ch];
    }
  }
  return { width, height, rgb: out };
}

/** cover 裁剪到 256×144 后的分位统计 */
export function stats(rgbImg) {
  const { width: W, height: H, rgb } = rgbImg;
  const TW = 256, TH = 144;
  const scale = Math.max(TW / W, TH / H);
  const cw = Math.round(W * scale), chh = Math.round(H * scale);
  const ox = Math.round((cw - TW) / 2), oy = Math.round((chh - TH) / 2);
  const vals = [];
  let sum = 0, blown = 0;
  for (let y = 0; y < TH; y++) {
    for (let x = 0; x < TW; x++) {
      const sx = Math.min(W - 1, Math.max(0, Math.round((x + ox) / scale)));
      const sy = Math.min(H - 1, Math.max(0, Math.round((y + oy) / scale)));
      const i = (sy * W + sx) * 3;
      const v = (rgb[i] + rgb[i + 1] + rgb[i + 2]) / 3;
      vals.push(v);
      sum += v;
      if (v >= 250) blown++;
    }
  }
  vals.sort((a, b) => b - a);
  const n = vals.length;
  const top1 = vals.slice(0, Math.max(1, Math.floor(n * 0.01)));
  return {
    mean: +(sum / n).toFixed(1),
    p50: +vals[Math.floor(n * 0.5)].toFixed(1),
    p99: +vals[Math.floor(n * 0.01)].toFixed(1),
    top1Mean: +(top1.reduce((a, b) => a + b, 0) / top1.length).toFixed(1),
    blownPct: +((100 * blown) / n).toFixed(2),
    min: +vals[n - 1].toFixed(1),
  };
}

/** 读一张图（PNG 直读；其它格式交给调用方先转 —— 见文件头「零依赖」说明） */
export function readImage(file) {
  const buf = fs.readFileSync(file);
  const png = decodePng(buf);
  if (png) return png;
  if (buf.length > 1 && buf[0] === 0xff && buf[1] === 0xd8) {
    throw new Error(`${path.basename(file)}: 本工具只解 PNG（零依赖）。请先转：sips -s format png in.jpg --out out.png`);
  }
  throw new Error(`${path.basename(file)}: 不支持的图片格式`);
}

function fmt(name, s) {
  return `${name.padEnd(26)} mean=${String(s.mean).padStart(5)} p50=${String(s.p50).padStart(5)} p99=${String(s.p99).padStart(6)} 前1%=${String(s.top1Mean).padStart(6)} ≥250=${String(s.blownPct).padStart(5)}% min=${String(s.min).padStart(5)}`;
}

const argv = process.argv.slice(2);
if (argv.length === 0) {
  console.log(`用法：
  node scripts/shot-stats.mjs <图A.png> [图B.png]
  node scripts/shot-stats.mjs --pair <我们的目录> <官方目录> [--out report.json]

口径：cover 裁剪到 256×144 后统计（均值/p50/p99/前 1%/≥250 占比）。
⚠️ 跨渲染器比**峰值与前 1%**才有意义；均值受取景影响（官方 preview 多为整景出图）。`);
  process.exit(0);
}

if (argv[0] === "--pair") {
  const mine = argv[1], theirs = argv[2];
  const outIdx = argv.indexOf("--out");
  const toPng = (src, dst) => {
    // 本工具零依赖：JPEG/GIF 交给系统 sips 转 PNG（macOS）。失败则跳过该条。
    const { execFileSync } = require("node:child_process");
    try {
      execFileSync("/usr/bin/sips", ["-s", "format", "png", src, "--out", dst], { stdio: "ignore" });
      return fs.existsSync(dst);
    } catch {
      return false;
    }
  };
  const tmp = (p) => path.join(require("node:os").tmpdir(), "shot-stats-" + path.basename(p).replace(/[^\w.]/g, "_") + ".png");
  const rows = [];
  for (const f of fs.readdirSync(mine).filter((f) => /\.(jpg|jpeg|png)$/i.test(f)).sort()) {
    const id = f.replace(/\.[^.]+$/, "");
    const cand = ["preview.jpg", "preview.png", "preview.gif", "preview.webp"].map((n) => path.join(theirs, n)).find((p) => fs.existsSync(p));
    if (!cand) continue;
    const a = path.join(mine, f);
    const aPng = /\.png$/i.test(a) ? a : tmp(a);
    const bPng = /\.png$/i.test(cand) ? cand : tmp(cand);
    if (!/\.png$/i.test(a) && !toPng(a, aPng)) continue;
    if (!/\.png$/i.test(cand) && !toPng(cand, bPng)) continue;
    const sa = stats(readImage(aPng));
    const sb = stats(readImage(bPng));
    rows.push({ id, mine: sa, official: sb, peakRatio: +(sa.top1Mean / Math.max(1, sb.top1Mean)).toFixed(2) });
  }
  rows.sort((x, y) => y.peakRatio - x.peakRatio);
  console.log("工程".padEnd(24) + "我们 前1%".padStart(10) + "官方 前1%".padStart(10) + "比值".padStart(7) + "   我们均值 / 官方均值  (过曝% / 官方过曝%)");
  for (const r of rows) {
    console.log(
      r.id.padEnd(24) +
        String(r.mine.top1Mean).padStart(10) +
        String(r.official.top1Mean).padStart(10) +
        String(r.peakRatio).padStart(7) +
        `   ${String(r.mine.mean).padStart(5)} / ${String(r.official.mean).padStart(5)}   (${r.mine.blownPct}% / ${r.official.blownPct}%)`,
    );
  }
  console.log("\n⚠️ 峰值比 >1 才是「我们更亮」；均值只作参考（取景不同）。");
  if (outIdx >= 0) {
    fs.writeFileSync(argv[outIdx + 1], JSON.stringify(rows, null, 1));
    console.log(`报告已写：${argv[outIdx + 1]}`);
  }
} else {
  for (const f of argv) {
    const png = /\.png$/i.test(f) ? f : null;
    if (!png) {
      const { execFileSync } = require("node:child_process");
      const dst = path.join(require("node:os").tmpdir(), "shot-stats-" + path.basename(f).replace(/[^\w.]/g, "_") + ".png");
      execFileSync("/usr/bin/sips", ["-s", "format", "png", f, "--out", dst], { stdio: "ignore" });
      console.log(fmt(path.basename(f), stats(readImage(dst))));
      continue;
    }
    console.log(fmt(path.basename(f), stats(readImage(png))));
  }
}
