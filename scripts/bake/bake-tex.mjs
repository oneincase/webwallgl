// 贴图烘焙原型（Node 侧）：用引擎自己的解析/解码/选级代码，把 scene.pkg 里的
// 每张贴图按「运行时会真正上传的那一级与尺寸」解出来，写成 PNG 缓存。
//
// 目的：量出三件事，它们是「贴图预解码缓存」这条方案可行性的全部依据 ——
//   ① 烘焙产物体积 vs 原始 pkg（磁盘代价）
//   ② 一次性烘焙耗时（每张壁纸）
//   ③ 烘焙时解出来的像素 = 运行时解出来的像素（同代码同参数，见 --verify）
import fs from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import zlib from "node:zlib";
import { LIB, ROOT } from "../lib/verify-kit.mjs";

const container = await import(pathToFileURL(join(ROOT, "renderer/vendor/we-scene/pkg/container.js")).href);
const tex = await import(pathToFileURL(join(ROOT, "renderer/vendor/we-scene/pkg/texture.js")).href);
const rs = await import(pathToFileURL(join(ROOT, "renderer/src/resource-scale.ts")).href).catch(() => null);
const codecs = await import(pathToFileURL(join(ROOT, "renderer/vendor/we-scene/pkg/tex-codecs.js")).href);

const ids = process.argv.slice(2);
const R = Number(process.env.RES_SCALE || 0.6); // 自动档在 DPR 1 下就是 0.6（见 resource-scale）
const OUT = process.env.BAKE_OUT || "/tmp/bake-out";

/** 极简 PNG 编码（filter 0 逐行，RGB8/RGBA8）——只为验证流程，不为压缩率 */
function encodePng(w, h, rgba, alpha) {
  const ch = alpha ? 4 : 3;
  const raw = Buffer.alloc((w * ch + 1) * h);
  let p = 0;
  for (let y = 0; y < h; y++) {
    raw[p++] = 0;
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      raw[p++] = rgba[o];
      raw[p++] = rgba[o + 1];
      raw[p++] = rgba[o + 2];
      if (alpha) raw[p++] = rgba[o + 3];
    }
  }
  const crcTable = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();
  const crc = (buf) => {
    let c = ~0;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return ~c >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const t = Buffer.from(type, "ascii");
    const cr = Buffer.alloc(4);
    cr.writeUInt32BE(crc(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, cr]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = alpha ? 6 : 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const now = () => Number(process.hrtime.bigint()) / 1e6;
const table = [];
for (const id of ids) {
  const pkgPath = join(LIB, id, "scene.pkg");
  if (!fs.existsSync(pkgPath)) continue;
  const t0 = now();
  const pkg = container.parsePkg(new Uint8Array(fs.readFileSync(pkgPath)));
  const dir = join(OUT, id);
  fs.mkdirSync(dir, { recursive: true });

  const names = pkg.entries.filter((e) => e.name.endsWith(".tex")).map((e) => e.name);
  const manifest = [];
  fs.mkdirSync(join(dir, "src"), { recursive: true });
  let bakedBytes = 0;
  let srcBytes = 0;
  let cpuPixels = 0;
  let count = 0;
  let skip = { png: 0, video: 0, err: 0 };
  for (const name of names) {
    const raw = container.getEntry(pkg, name);
    srcBytes += raw.length;
    // 抽出原始 .tex 字节（A/B 里「现状路径」要用它：运行时拿到的正是这份）
    const srcName = name.replace(/^materials\//, "").replace(/[\\/]/g, "__") + ".tex";
    fs.writeFileSync(join(dir, "src", srcName), raw);
    let parsed;
    try {
      parsed = tex.parseTex(raw);
    } catch {
      skip.err++;
      continue;
    }

    if (parsed.isVideo) {
      manifest.push({ name: name.replace(/^materials\//, ""), file: null, src: "src/" + srcName, kind: "video" });
      skip.video++;
      continue;
    }
    if (parsed.freeImageFormat !== tex.FIF.UNKNOWN) {
      // 内嵌 PNG/JPEG：运行时交给浏览器原生解码（这里只入清单，不烘焙）
      manifest.push({ name: name.replace(/^materials\//, ""), file: null, src: "src/" + srcName, kind: "embedded" });
      skip.png++;
      continue;
    }
    // 选级：与运行时同规则（只按资源档位，图层足迹只会更小 → 这是上界）
    const im0 = parsed.images?.[0]?.[0];
    const long = Math.max(Number(im0?.width || 0), Number(im0?.height || 0));
    const target = Math.max(32, Math.round(long * R));
    let level = 0;
    const mips = parsed.images?.[0] || [];
    for (let k = 0; k < mips.length; k++) {
      const l = Math.max(mips[k].width, mips[k].height);
      if (l >= target) level = k;
      else break;
    }
    let out;
    try {
      out = tex.decodeMipLevel(parsed, level);
    } catch {
      skip.err++;
      continue;
    }
    if (!out?.rgba) {
      skip.err++;
      continue;
    }
    cpuPixels += out.width * out.height;
    const png = encodePng(out.width, out.height, out.rgba, true);
    const fname = name.replace(/^materials\//, "").replace(/[\\/]/g, "__") + `.L${level}.png`;

    fs.writeFileSync(join(dir, fname), png);
    manifest.push({ name: name.replace(/^materials\//, ""), file: fname, src: "src/" + srcName, kind: "raw", w: out.width, h: out.height });
    bakedBytes += png.length;
    count++;
  }
  fs.writeFileSync(join(dir, "list.json"), JSON.stringify(manifest));
  const ms = now() - t0;
  table.push({ id, count, srcMB: srcBytes / 1e6, bakedMB: bakedBytes / 1e6, ms, mpx: cpuPixels / 1e6, skip });
  console.log(
    `${id}: 烘焙 ${count} 张 / 源 ${(srcBytes / 1e6).toFixed(1)}MB → 产物 ${(bakedBytes / 1e6).toFixed(1)}MB` +
      `（×${(bakedBytes / Math.max(1, srcBytes)).toFixed(1)}）  一次 ${ms.toFixed(0)}ms  解出 ${(cpuPixels / 1e6).toFixed(0)} Mpx` +
      `  跳过 ${JSON.stringify(skip)}`,
  );
}
if (table.length) {
  const s = table.reduce((a, b) => ({ srcMB: a.srcMB + b.srcMB, bakedMB: a.bakedMB + b.bakedMB, ms: a.ms + b.ms }), { srcMB: 0, bakedMB: 0, ms: 0 });
  console.log(
    `\n合计：源 ${s.srcMB.toFixed(0)}MB → 烘焙产物 ${s.bakedMB.toFixed(0)}MB（体积 ×${(s.bakedMB / s.srcMB).toFixed(1)}），一次烘焙 ${s.ms.toFixed(0)}ms`,
  );
}
fs.writeFileSync("/tmp/perf-bench/bake-tex.json", JSON.stringify(table, null, 1));
