#!/usr/bin/env node
/**
 * PWA 图标生成（一次性资产，改设计后重跑 `pnpm gen:icons`）。
 *
 * 纯 Node 实现：手写 PNG 编码（zlib deflate + CRC32），零额外依赖。
 * 画面 = 壁纸隐喻的极简风景：夜空渐变 + 暖日 + 两层山。
 * 产物：public/icons/pwa-192.png / pwa-512.png / pwa-maskable-512.png
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "public", "icons");

// ---- PNG 编码（RGBA8，scanline 无滤波）----
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(w, h, rgba) {
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    rgba.copy(raw, y * (1 + w * 4) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- 画面 ----
const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => [
  lerp(c1[0], c2[0], t),
  lerp(c1[1], c2[1], t),
  lerp(c1[2], c2[2], t),
];
function art(u, v) {
  // u, v ∈ [0,1]，v 向下
  const sky = mix([13, 17, 26], [30, 42, 66], v);
  const dx = u - 0.66;
  const dy = (v - 0.4) * 1.0;
  if (dx * dx + dy * dy < 0.012) return [245, 158, 11]; // 暖日
  const ridge1 = 0.6 + 0.1 * Math.sin(u * 5.1 + 1.2) + 0.05 * Math.sin(u * 11.7);
  if (v > ridge1) return mix([35, 48, 71], [15, 23, 42], Math.min(1, (v - ridge1) * 2.4));
  const ridge2 = 0.79 + 0.07 * Math.sin(u * 7.3 + 4) + 0.04 * Math.sin(u * 13.1 + 2);
  if (v > ridge2) return mix([56, 71, 94], [22, 30, 46], Math.min(1, (v - ridge2) * 3));
  return sky;
}

function render(size, { maskable = false } = {}) {
  const buf = Buffer.alloc(size * size * 4);
  const SS = 2; // 每像素 2×2 超采样，边缘平滑
  const step = 1 / (size * SS);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          let u = (x * SS + sx + 0.5) * step;
          let v = (y * SS + sy + 0.5) * step;
          let c;
          if (maskable) {
            // maskable 安全区：内容缩进中央 76%，四周满铺底色
            const su = 0.5 + (u - 0.5) / 0.76;
            const sv = 0.5 + (v - 0.5) / 0.76;
            c =
              su < 0 || su > 1 || sv < 0 || sv > 1
                ? [11, 14, 20]
                : art(su, sv);
          } else {
            c = art(u, v);
          }
          r += c[0];
          g += c[1];
          b += c[2];
        }
      }
      const i = (y * size + x) * 4;
      buf[i] = Math.round(r / (SS * SS));
      buf[i + 1] = Math.round(g / (SS * SS));
      buf[i + 2] = Math.round(b / (SS * SS));
      buf[i + 3] = 255;
    }
  }
  return buf;
}

mkdirSync(outDir, { recursive: true });
for (const [name, size, opts] of [
  ["pwa-192.png", 192, {}],
  ["pwa-512.png", 512, {}],
  ["pwa-maskable-512.png", 512, { maskable: true }],
]) {
  writeFileSync(join(outDir, name), encodePng(size, size, render(size, opts)));
  console.log(`生成 ${name}（${size}×${size}）`);
}
