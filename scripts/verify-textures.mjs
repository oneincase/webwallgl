#!/usr/bin/env node
/**
 * verify-textures —— .tex 内嵌图片解码对齐 WE/FreeImage 语义（EXIF 方向不执行）。
 *
 * 1920911984 的缺陷：orientation=8 的 1080×5760 JPEG 被 createImageBitmap 默认
 * 转成 5760×1080，纹理轴与层 size/旋转错轴，整屏撕成横向条带（实测画布
 * 行/列梯度比 ~20:1；剥掉 EXIF 后同一比特流 0.90）。修复 =
 * imageOrientation:"none" + 宽高互换时按 EXIF 方向回滚（renderer/src/tex-decode.ts）。
 *
 * 本文件全部离线可跑：tex-decode 的纯函数（texOrientationPlan /
 * jpegExifOrientation）esbuild bundle 后在 Node 直行；回滚动作的旋转方向由
 * 真值表锁定，改坏方向或漏分支都会红。
 */
import { build } from "esbuild";
import fs from "node:fs";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = join(fileURLToPath(import.meta.url), "..");
const ROOT = join(here, "..");

let failed = 0;
function check(ok, msg) {
  if (ok) {
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

async function bundleTexDecode() {
  const out = await build({
    entryPoints: [join(ROOT, "renderer/src/tex-decode.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "es2022",
  });
  const tmp = join(ROOT, "scripts", `.tmp-texdecode-${process.pid}.mjs`);
  fs.writeFileSync(tmp, out.outputFiles[0].text);
  try {
    return await import(pathToFileURL(tmp).href);
  } finally {
    fs.unlinkSync(tmp);
  }
}

// 构造一段最小 JPEG：SOI + APP1(Exif/TIFF) + APP0 + SOS + EOI。
// 解析器只读头部字段，不需要合法熵编码数据。
// JPEG 段长度恒为大端；TIFF/IFD 内部字段按 endian 参数。
function fakeJpeg({ endian = "big", orientation = 1, withExif = true }) {
  const be = endian === "big";
  const j16 = (v) => [v >> 8, v & 0xff]; // JPEG 段长度：恒大端
  const u16 = (v) => (be ? [v >> 8, v & 0xff] : [v & 0xff, v >> 8]);
  const u32 = (v) =>
    be
      ? [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]
      : [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];

  // TIFF：头(8) + IFD(2 + 12*1 + 4)，IFD0 紧跟头部（偏移 8）
  const tiffHeader = [...(be ? [0x4d, 0x4d] : [0x49, 0x49]), ...u16(42), ...u32(8)];
  // Orientation entry：tag 0x0112, type SHORT(3), count 1, 值内联（4 字节值域）
  const valueField = be
    ? [...u16(orientation), 0, 0]
    : [orientation & 0xff, (orientation >> 8) & 0xff, 0, 0];
  const ifd = [
    ...u16(1), // entry 数
    ...u16(0x0112), ...u16(3), ...u32(1), ...valueField,
    ...u32(0), // 下一 IFD = 无
  ];
  const tiff = [...tiffHeader, ...ifd];

  const app1Payload = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]; // "Exif\0\0"
  const segs = [[0xff, 0xd8]]; // SOI
  if (withExif) {
    segs.push([0xff, 0xe1, ...j16(app1Payload.length + 2), ...app1Payload]);
  }
  segs.push([0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46]); // APP0 占位
  segs.push([0xff, 0xda, 0x00, 0x04, 0x00, 0x00]); // SOS（头部扫描到此为止）
  segs.push([0xff, 0xd9]); // EOI
  return new Uint8Array(segs.flat());
}

console.log("\n[1] texOrientationPlan 真值表（1920911984：声明 1080×5760）");
{
  const { texOrientationPlan: plan } = await bundleTexDecode();
  const W = 1080, H = 5760;
  const T = [
    ["尺寸一致 → keep", 8, W, H, "keep"],
    ["orientation=8 宽高互换 → rot-cw（1920911984 的实际形态）", 8, H, W, "rot-cw"],
    ["orientation=6 宽高互换 → rot-ccw", 6, H, W, "rot-ccw"],
    ["orientation=5（转置族）→ rot-ccw", 5, H, W, "rot-ccw"],
    ["orientation=7（转置族）→ rot-cw", 7, H, W, "rot-cw"],
    ["无 EXIF(1) 却互换（异常形态）→ 不盲转", 1, H, W, "keep"],
    ["orientation=3 尺寸不变（不可辨）→ keep", 3, W, H, "keep"],
    ["orientation=8 但声明高为 0（坏头）→ keep", 8, H, 0, "keep"],
  ];
  for (const [desc, o, bw, bh, want] of T) {
    const got = plan(o, bw, bh, W, H);
    check(got === want, `${desc}：期望 ${want}，实得 ${got}`);
  }
}

console.log("\n[2] jpegExifOrientation 合成夹具");
{
  const { jpegExifOrientation } = await bundleTexDecode();
  check(jpegExifOrientation(fakeJpeg({ endian: "big", orientation: 8 })) === 8, "MM 大端 + 内联值 → 8（1920911984 同款）");
  check(jpegExifOrientation(fakeJpeg({ endian: "little", orientation: 6 })) === 6, "II 小端 + 内联值 → 6");
  check(jpegExifOrientation(fakeJpeg({ endian: "little", orientation: 8 })) === 8, "II 小端 + 内联值 → 8");
  check(jpegExifOrientation(fakeJpeg({ withExif: false })) === 1, "无 APP1 → 1");
  check(jpegExifOrientation(new Uint8Array([0, 1, 2, 3])) === 1, "非 JPEG 字节 → 1");
  check(jpegExifOrientation(new Uint8Array(0)) === 1, "空字节 → 1");
  // Orientation 条目 type/count 不符时必须返回 1（不猜值）
  {
    const copy = Uint8Array.from(fakeJpeg({ endian: "big", orientation: 8 }));
    const p = copy.indexOf(0x45); // 'E' of "Exif"
    const ifdEntry = p + 6 + 8 + 2; // Exif 头(6) + TIFF 头(8) + IFD count(2)
    copy[ifdEntry + 4] = 2; // count → 2，内联值语义失效
    check(jpegExifOrientation(copy) === 1, "Orientation 条目 count≠1 → 1（不猜）");
  }
}

console.log("\n[3] 接线：scene-mount 的 .tex 分支必须走 decodeTexImageBitmap");
{
  const src = fs.readFileSync(join(ROOT, "renderer/src/scene-mount.ts"), "utf8");
  check(
    /const bmp = await decodeTexImageBitmap\(/.test(src),
    ".tex JPEG/PNG 分支应调用 decodeTexImageBitmap",
  );
  check(
    /import \{ decodeTexImageBitmap \} from "\.\/tex-decode"/.test(src),
    "scene-mount 应从 ./tex-decode 导入",
  );
  const decode = fs.readFileSync(join(ROOT, "renderer/src/tex-decode.ts"), "utf8");
  check(/imageOrientation: "none"/.test(decode), "解码应请求 imageOrientation:'none'");
  check(/premultiplyAlpha: "none"/.test(decode), "解码保留 premultiplyAlpha:'none'（细框眼镜回归）");
  // 媒体封面两处（直播 artwork / $mediaThumbnail）保持浏览器默认：用户侧图片
  // 理应转正显示，且与 .tex 无关。
  const bare = [...src.matchAll(/createImageBitmap\(blob, \{ premultiplyAlpha: "none" \}\)/g)].length;
  check(bare === 2, `scene-mount 剩余裸 createImageBitmap 应为 2（媒体封面路径），实得 ${bare}`);
}

console.log(failed === 0 ? "\nverify-textures: 全部通过 ✓" : `\nverify-textures: ${failed} 项失败 ✗`);
process.exit(failed === 0 ? 0 : 1);
