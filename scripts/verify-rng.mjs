#!/usr/bin/env node
/**
 * verify-rng —— 内置贴图的**像素金样**，锁住 PRNG 收敛（B1）没有改变任何一张贴图。
 *
 * 为什么需要它：三份逐字相同的 `mulberry32` 副本收敛到 `render/rng.js` 时，只要有一处的
 * 常数、位移或取模被顺手改掉，受影响的那类内置贴图就会**整张变样**（它们是按种子确定性
 * 程序化生成的）—— 而这类变化在画面上往往只是「噪点分布不太一样」，肉眼对不出来。
 * 所以判据取「82 张内置贴图 + 种子表的像素哈希」（改前采集，改后必须逐条相同）。
 *
 * 覆盖面：system-textures 的 util 贴图、particle-textures 的全部内置粒子贴图、
 * pattern-textures 的纹样贴图，以及 patternSeeds()（32 个种子是 mulberry32 + best-candidate 抽出来的）。
 * 采集口径：width|height|像素字节 的 sha256 前 16 位。**改采集口径等于把金样作废**，
 * 改的话要连带重新生成下面的 GOLDEN。
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = join(fileURLToPath(import.meta.url), "..");
const ROOT = join(here, "..");
const R = join(ROOT, "renderer/vendor/we-scene/render/");

const GOLDEN = {
  "sys/util/white": "13cb2cf798919724",
  "sys/util/black": "02a8ab46d7c1d31c",
  "sys/util/noflow": "71642811d225b030",
  "sys/util/flatnormal": "3ad3e4c55d0d7493",
  "sys/util/noise": "9885795dcd812bf7",
  "sys/util/perlin_256": "abbb5529fd5618ca",
  "sys/util/uniform_256": "c5612154ed5d6c32",
  "sys/util/fur": "6b5b0a4c85dc7c7b",
  "sys/util/clouds_256": "b99449446efb0653",
  "ptex/particle/halo_6": "981098539d5df8ea",
  "ptex/particle/normal_splash": "2e061750f12e7afd",
  "ptex/particle/drop_normal": "87f641fb75bf7c7b",
  "ptex/particle/normal_ring_smooth": "e7236ef7762cd1f8",
  "ptex/particle/normal_pinch_rotate": "a27e5b0ca538efc2",
  "ptex/particle/water/rain_drops_sheet_normal": "c30e59e5f111aa85",
  "ptex/particle/bubbles/bubble1normal": "71dce6d26eba6cf0",
  "ptex/particle/bubbles/bubble2_normal": "4bc944d28fbc0f3f",
  "ptex/particle/sharp_halo_normal": "5f687323bf3cfdff",
  "ptex/particle/beam/beam_0": "7a6166207c4e599d",
  "ptex/particle/beam/beam_1": "9cca2ee01b95b3ff",
  "ptex/particle/beam/beam_2": "87bf94feee2a6e85",
  "ptex/particle/beam/beam_2_fade": "3a51dfff4c8833e2",
  "ptex/particle/light/light_shafts_0": "3bcd5ca9dd49afe1",
  "ptex/particle/light/light_shafts_1": "ab416e64ef3d1580",
  "ptex/particle/light/light_shafts_2": "a4ea5be5410a3c61",
  "ptex/particle/light/light_shafts_3": "3f6bac40b5d88a47",
  "ptex/particle/light/light_shafts_4": "1eb1871c651720e4",
  "ptex/particle/light/light_shafts_5": "1d97569edbbab908",
  "ptex/particle/light/light_shafts_6": "5ea4179adbaf4d3c",
  "ptex/particle/nature/rosepetals": "09262bd95dc3f97c",
  "ptex/particle/nature/leaves": "8a31ec4b36472d3e",
  "ptex/particle/nature/leaves1": "8e18341444e95c75",
  "ptex/particle/nature/leaves2": "e59440dbfb82bd3f",
  "ptex/particle/nature/leaves3": "915c5e84ae609ffa",
  "ptex/particle/nature/leaves5": "82992fc4cd8c7ef0",
  "ptex/particle/nature/leaves6": "126a31d0585a9cb7",
  "ptex/particle/nature/leaves7": "32f1dd0ba1f60544",
  "ptex/particle/nature/leaves8": "918d4987c1c6c12e",
  "ptex/particle/nature/snow": "734eb7679f2b3ad3",
  "ptex/particle/halo": "43b624e10ed1b9ec",
  "ptex/particle/halo_1": "3fe0a1c7c9b52d69",
  "ptex/particle/halo_2": "85e38b8b026b3a41",
  "ptex/particle/halo_3": "8e332f4aa9337aa5",
  "ptex/particle/halo_4": "c236eaac382f7f94",
  "ptex/particle/halo_5": "0df1d4773d89eb0a",
  "ptex/particle/sharp_halo": "1ea861e58b615e04",
  "ptex/particle/chromaticdot": "04dc4918d6966287",
  "ptex/particle/light/flare_0": "69d4efef20867d3a",
  "ptex/particle/light/flare_1": "10a3ce835e02296d",
  "ptex/particle/light/flare_2": "a4d0d94e868f6bee",
  "ptex/particle/drop": "fcaa1002b4641e63",
  "ptex/particle/nature/rain1": "f2b3b10a0632feaa",
  "ptex/particle/nature/rain2": "ac778fd49d94e6fc",
  "ptex/particle/water/rain_drops_sheet": "6e13dd61b2b45aa2",
  "ptex/particle/water/splash_1": "3a7d5ca7ecb7915a",
  "ptex/particle/water/ripple_single": "f0de5e9cb99885ad",
  "ptex/particle/fog/fog1": "8bde2a9ea289fb4e",
  "ptex/particle/fog/fog2": "644122f53c21bf81",
  "ptex/particle/fog/fog3": "0094a4a61db555b1",
  "ptex/particle/smoke/smoke2": "51320c549e57ff12",
  "ptex/particle/smoke/smoke2light": "643b62a27bb9d6f9",
  "ptex/particle/smoke/smoke1": "0a646914cfa086d6",
  "ptex/particle/misc/wave": "80e35cfb1cabf53b",
  "ptex/particle/misc/star_0": "34965e6e9f4111b8",
  "ptex/particle/bubbles/bubble1": "d9ffc4f11aca3f3e",
  "ptex/particle/bubbles/bubble2": "8f875e4050a7ba87",
  "ptex/particle/bubbles/bubble3": "48cf5acb4c997dda",
  "ptex/particle/debris/debris1": "d03d600b6f0883ac",
  "ptex/particle/lightning/lightning1": "8c9d561f23246ec7",
  "ptex/particle/lightning/lightning2": "68372f9d26734952",
  "ptex/particle/lightning/lightning3": "afc1b4781f8f17f2",
  "ptex/particle/fire/fire1": "7d6467a11b168714",
  "ptex/particle/fire/fire2": "ece7da1b263659a7",
  "ptex/particle/star": "b06c8dfe5c338007",
  "ptex/particle/shape/circle_wind": "902e00d84d31e823",
  "ptex/particle/sickle": "3b7179b18de96a37",
  "ptex/particle/magic/glyph_4": "2cb6f5c807c7cbc1",
  "ptex/@sparkle": "9b17d9ba1d1531b7",
  "ptex/@star": "34965e6e9f4111b8",
  "ptex/@trail": "830cfd673d16e4c1",
  "pat/pattern/voronoi": "597317ba8e28515d",
  "pat/pattern/voronoi_local": "f644bbb76a24aab0",
  "__seeds": "f905851dcfb1e49b"
};

let failed = 0;
function check(ok, msg) {
  if (ok) console.log(`  ✓ ${msg}`);
  else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

const digest = (obj) => {
  const parts = [];
  if (obj) {
    if (obj.width) parts.push(String(obj.width));
    if (obj.height) parts.push(String(obj.height));
    const px = obj.rgba || obj.data || obj.pixels;
    if (px && px.length !== undefined) {
      parts.push(Buffer.from(px.buffer || px, px.byteOffset || 0, px.byteLength || px.length).toString("hex"));
    }
  }
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
};

const sys = await import(pathToFileURL(join(R, "system-textures.js")).href);
const ptex = await import(pathToFileURL(join(R, "particle-textures.js")).href);
const pat = await import(pathToFileURL(join(R, "pattern-textures.js")).href);

const actual = {};
for (const n of (sys.SYSTEM_UTIL_TEXTURES || []).map((t) => (typeof t === "string" ? t : t.name))) {
  actual["sys/" + n] = digest(sys.buildSystemUtilTexture(n));
}
for (const n of ptex.listBuiltinParticleTextureNames()) actual["ptex/" + n] = digest(ptex.buildBuiltinParticleTexture(n));
for (const n of pat.listBuiltinPatternTextureNames()) actual["pat/" + n] = digest(pat.buildBuiltinPatternTexture(n));
actual["__seeds"] = createHash("sha256").update(JSON.stringify(pat.patternSeeds())).digest("hex").slice(0, 16);

console.log("\n[1] 内置贴图像素金样（mulberry32 收敛不得改变任何一张）");
const names = Object.keys(GOLDEN);
const missing = names.filter((n) => !(n in actual));
const extra = Object.keys(actual).filter((n) => !(n in GOLDEN));
const drifted = names.filter((n) => n in actual && actual[n] !== GOLDEN[n]);
check(missing.length === 0, `金样里的 ${names.length} 项都还在（缺 ${missing.length}${missing.length ? "：" + missing.slice(0, 4).join(",") : ""}）`);
check(extra.length === 0, `没有新增未入金样的贴图（多 ${extra.length}${extra.length ? "：" + extra.slice(0, 4).join(",") : ""}）`);
check(drifted.length === 0, `像素哈希逐条一致（漂移 ${drifted.length}${drifted.length ? "：" + drifted.slice(0, 4).map((n) => n + " " + GOLDEN[n] + "→" + actual[n]).join(" / ") : ""}）`);

console.log("\n[2] PRNG 只应有一份实现");
{
  const fs = await import("node:fs");
  const files = ["system-textures.js", "particle-textures.js", "pattern-textures.js", "noise.js"];
  const copies = files.filter((f) => /function mulberry32\(seed\)/.test(fs.readFileSync(join(R, f), "utf8")));
  check(copies.length === 0, `四个模块里不得再各自实现 mulberry32（实得 ${copies.length} 处：${copies.join(",")}）`);
  check(/export function mulberry32\(seed\)/.test(fs.readFileSync(join(R, "rng.js"), "utf8")), "render/rng.js 必须导出 mulberry32");
}

console.log(failed === 0 ? "\nverify-rng: 全部通过 ✓" : `\nverify-rng: ${failed} 项失败 ✗`);
process.exit(failed === 0 ? 0 : 1);
