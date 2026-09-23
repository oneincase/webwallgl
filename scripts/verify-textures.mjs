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
    /import \{ decodeTexImageBitmap(, resampleRgba)? \} from "\.\/tex-decode"/.test(src),
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

console.log("\n[4] 系统内置 util 贴图（materials/util/* 程序化复刻，官方统计锚点见 system-textures.js 头注）");
{
  // 效果链引用的 WE 公共 util 贴图不在 pkg 里。此前只硬编码 5 个名字且多为
  // 1×1 占位：flatnormal（法线参考）缺失 → 法线类效果落白板、法线被解释成
  // (1,1,1)；noflow 的 B 通道误写 127（官方 0=无流动）；noise 是 8px 平滑值
  // 噪声（官方逐像素白噪声）；perlin_256/uniform_256/fur 缺失落白板。
  const sys = await import(
    pathToFileURL(join(ROOT, "renderer/vendor/we-scene/render/system-textures.js")).href
  );
  const NAMES = [
    "util/white", "util/black", "util/noflow", "util/flatnormal", "util/noise",
    "util/perlin_256", "util/uniform_256", "util/fur", "util/clouds_256",
  ];
  check(
    JSON.stringify(sys.SYSTEM_UTIL_TEXTURES) === JSON.stringify(NAMES),
    "SYSTEM_UTIL_TEXTURES 名单与官方 materials/util 集合一致",
  );
  for (const n of NAMES) {
    check(!!sys.buildSystemUtilTexture(n), `${n} 必须有产出（缺失时效果槽落白板）`);
  }
  check(sys.buildSystemUtilTexture("util/不存在") === null, "名单外名字返回 null（不吞掉 pkg/其它来源）");

  // 常量贴图逐字节断言（官方解码形态实测值）
  const px = (t, x, y) => {
    const o = (y * t.width + x) * 4;
    return [t.rgba[o], t.rgba[o + 1], t.rgba[o + 2], t.rgba[o + 3]];
  };
  const isSolid = (t, v) => {
    for (let i = 0; i < t.width * t.height; i++) {
      if (t.rgba[i * 4] !== v[0] || t.rgba[i * 4 + 1] !== v[1] || t.rgba[i * 4 + 2] !== v[2] || t.rgba[i * 4 + 3] !== v[3]) return false;
    }
    return true;
  };
  const white = sys.buildSystemUtilTexture("util/white");
  check(white.width === 32 && white.height === 32 && isSolid(white, [255, 255, 255, 255]), "util/white = 32×32 纯白");
  const black = sys.buildSystemUtilTexture("util/black");
  check(black.width === 32 && black.height === 32 && isSolid(black, [0, 0, 0, 255]), "util/black = 32×32 纯黑");
  const noflow = sys.buildSystemUtilTexture("util/noflow");
  // B=0 是本次修复的关键（曾误写 127 = 半强度流动）
  check(noflow.width === 32 && isSolid(noflow, [127, 127, 0, 255]), "util/noflow = 32×32 (127,127,0,255)：零向量 + B=0 无流动");
  const flat = sys.buildSystemUtilTexture("util/flatnormal");
  // 法线参考（官方 DXT5N 解码形态）：x 存 alpha=127、y 存 green=127 → shader
  // 按 (a,g) 重建得 (0,0,+1) 平面法线
  check(flat.width === 16 && flat.height === 16 && isSolid(flat, [255, 127, 0, 127]), "util/flatnormal = 16×16 (255,127,0,127)（DXT5N 解码形态，法线参考）");
  check(px(flat, 0, 0)[3] === 127 && px(flat, 0, 0)[1] === 127, "flatnormal (a,g)=(127,127)：重建法线 = +Z");
  check(sys.isNomipSystemTexture("util/noise") && sys.isNomipSystemTexture("util/fur") && sys.isNomipSystemTexture("util/noflow") && sys.isNomipSystemTexture("util/flatnormal"), "nomip 名单 = noise/fur/noflow/flatnormal（官方 nomip:true）");
  check(!sys.isNomipSystemTexture("util/clouds_256") && !sys.isNomipSystemTexture("util/perlin_256"), "clouds/perlin 官方带 mip 链");

  // 统计判据（官方实测锚点，允许 ±容差）
  const chanStats = (t, c) => {
    let s = 0, s2 = 0, z = 0;
    const n = t.width * t.height;
    for (let i = 0; i < n; i++) {
      const v = t.rgba[i * 4 + c];
      s += v;
      s2 += v * v;
      if (v === 0) z++;
    }
    const m = s / n;
    return { mean: m, sd: Math.sqrt(Math.max(0, s2 / n - m * m)), zero: z / n, n };
  };
  const seamRatio = (t) => {
    const W = t.width, H = t.height, rgba = t.rgba;
    const colDiff = (a, b) => {
      let s = 0;
      for (let y = 0; y < H; y++) s += Math.abs(rgba[(y * W + a) * 4] - rgba[(y * W + b) * 4]);
      return s / H;
    };
    let interior = 0, cnt = 0;
    for (let x = 0; x < W - 1; x += 7) {
      interior += colDiff(x, x + 1);
      cnt++;
    }
    return { seam: colDiff(W - 1, 0), interior: interior / cnt };
  };

  // noise：四通道独立白噪声（官方 mean≈127.5 sd≈73.8；此前是 8px 平滑值噪声）
  const noiseT = sys.buildSystemUtilTexture("util/noise");
  check(noiseT.width === 256 && noiseT.height === 256, "util/noise = 256×256");
  {
    let ok = true;
    for (let c = 0; c < 4; c++) {
      const st = chanStats(noiseT, c);
      if (Math.abs(st.mean - 127.5) > 12 || Math.abs(st.sd - 73.6) > 8) ok = false;
      // 白噪声无零值聚集（uniform_256 才有一半零）
      if (st.zero > 0.02) ok = false;
    }
    check(ok, "util/noise 四通道均为均匀白噪声（mean≈127.5 sd≈73.8，无零值聚集）");
    // 通道间独立：同像素 R 与 G 的相关系数应接近 0
    let sxy = 0, sx = 0, sy = 0;
    const n = noiseT.width * noiseT.height;
    for (let i = 0; i < n; i++) {
      const x = noiseT.rgba[i * 4], y = noiseT.rgba[i * 4 + 1];
      sxy += x * y; sx += x; sy += y;
    }
    const cov = sxy / n - (sx / n) * (sy / n);
    check(Math.abs(cov) < 90, `util/noise R/G 通道独立（协方差 ${cov.toFixed(1)} 应 ≈0，±90 即 |ρ|<0.017）`);
  }

  // perlin_256：四个平滑可平铺场，通道 (mean,sd) 有序（官方 94.8/108.4/145.2/112.0）
  const perlin = sys.buildSystemUtilTexture("util/perlin_256");
  check(perlin.width === 256, "util/perlin_256 = 256×256");
  {
    const means = [];
    let ok = true;
    for (let c = 0; c < 4; c++) {
      const st = chanStats(perlin, c);
      means.push(st.mean);
      const target = [94.8, 108.4, 145.2, 112.0][c];
      const targetSd = [21.5, 26.2, 23.6, 32.0][c];
      if (Math.abs(st.mean - target) > 15 || Math.abs(st.sd - targetSd) > 8) ok = false;
      if (st.zero > 0.01) ok = false;
    }
    check(ok, "util/perlin_256 四通道 (mean,sd) 对齐官方实测（±15/±8）");
    check(means[2] > means[1] && means[1] > means[0], `util/perlin_256 通道均值有序 ch0<ch1<ch2（${means.map((m) => m.toFixed(0)).join("<")}）`);
    // 平滑：相邻像素差远小于白噪声（官方 smoothness≈0.8，白噪声≈85）
    let d = 0;
    for (let y = 0; y < 256; y++) for (let x = 0; x < 255; x++) d += Math.abs(perlin.rgba[(y * 256 + x) * 4] - perlin.rgba[(y * 256 + x + 1) * 4]);
    const smooth = d / (255 * 256);
    check(smooth < 4, `util/perlin_256 是平滑场（相邻差 ${smooth.toFixed(2)} < 4，白噪声≈85）`);
    const sr = seamRatio(perlin);
    check(sr.seam < Math.max(2, sr.interior * 1.6), `util/perlin_256 可平铺（接缝 ${sr.seam.toFixed(2)} vs 内部 ${sr.interior.toFixed(2)}）`);
  }

  // uniform_256：恰 ~50% 零 + 其余均匀（官方 zero=49.8%、非零均值 128.7）
  const uni = sys.buildSystemUtilTexture("util/uniform_256");
  {
    let ok = true;
    for (let c = 0; c < 4; c++) {
      const st = chanStats(uni, c);
      if (Math.abs(st.zero - 0.5) > 0.03) ok = false;
      const nzMean = st.mean / Math.max(1e-9, 1 - st.zero);
      if (Math.abs(nzMean - 128) > 15) ok = false;
    }
    check(ok, "util/uniform_256 每通道 50% 零值 + 非零均匀 [0,255]");
  }

  // fur：~41% 零 + 非零偏亮（官方 zero=41.3%、非零均值≈155）
  const fur = sys.buildSystemUtilTexture("util/fur");
  check(fur.width === 128 && fur.height === 128, "util/fur = 128×128");
  {
    const st = chanStats(fur, 0);
    check(Math.abs(st.zero - 0.413) < 0.05, `util/fur 零值占比 ≈41%（实得 ${(st.zero * 100).toFixed(1)}%）`);
    const nzMean = st.mean / (1 - st.zero);
    check(nzMean > 130 && nzMean < 185, `util/fur 非零均值偏亮 ≈155（实得 ${nzMean.toFixed(0)}）`);
    check(fur.rgba[3] === 255 && chanStats(fur, 3).sd === 0, "util/fur alpha 恒 255（R8 解码为灰度）");
  }

  // clouds_256：灰度 FBM（官方 mean=126 sd=52.7 钟形薄尾），可平铺非平坦
  const clouds = sys.buildSystemUtilTexture("util/clouds_256");
  check(!!clouds && clouds.width === 256 && clouds.height === 256, "util/clouds_256 应为 256×256");
  if (clouds) {
    const W = clouds.width;
    const rgba = clouds.rgba;
    let sum = 0;
    let sum2 = 0;
    let above = 0;
    let mono = true;
    for (let i = 0; i < W * W; i++) {
      const v = rgba[i * 4] / 255;
      sum += v;
      sum2 += v * v;
      if (v > 0.15) above++; // 云 shader 的 smoothstep 阈值下界
      if (rgba[i * 4] !== rgba[i * 4 + 1] || rgba[i * 4 + 1] !== rgba[i * 4 + 2]) mono = false;
    }
    const n = W * W;
    const mean = sum / n;
    const std = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
    check(mono, "util/clouds_256 是灰度图（官方 r=g=b，彩色会让云蒙版偏色）");
    check(std > 0.08, `云密度图不能是平坦色（std=${std.toFixed(3)}，白板回归）`);
    check(Math.abs(mean * 255 - 126) < 20 && Math.abs(std * 255 - 52.7) < 15, `util/clouds_256 分布对齐官方（mean=126 sd=52.7，实得 ${(mean * 255).toFixed(0)}/${(std * 255).toFixed(0)}）`);
    const coverage = above / n;
    // 官方 clouds_256 实测覆盖率 ≈98.1%（此前程序化版本误把大部分压到阈值下，
    // 旧判据 10%~90% 正是按那个错误分布校的）。这里只防退化：全 0=看不见、
    // 全 1=白板。
    check(
      coverage > 0.6 && coverage < 0.995,
      `阈值 0.15 以上的覆盖率应落在官方量级 ~98%（实得 ${(coverage * 100).toFixed(1)}%）`,
    );
    // 可平铺性：环绕接缝的列差不应远大于内部相邻列差（云 uv 随 g_Time 无界增长，
    // 不平铺会在接缝处出现硬线；CLAMP 环绕则整片被拉成边缘一行）
    const sr = seamRatio(clouds);
    check(
      sr.seam < Math.max(2, sr.interior * 1.6),
      `环绕接缝应不比内部列差更陡（接缝 ${sr.seam.toFixed(2)} vs 内部均值 ${sr.interior.toFixed(2)}）`,
    );
    // 反证：平坦白板必须被上面两条判据抓住（断言不是恒真）
    const flatT = new Uint8Array(W * W * 4).fill(255);
    let fsum = 0;
    let fsum2 = 0;
    for (let i = 0; i < W * W; i++) {
      const v = flatT[i * 4] / 255;
      fsum += v;
      fsum2 += v * v;
    }
    const fstd = Math.sqrt(Math.max(0, fsum2 / n - (fsum / n) ** 2));
    check(fstd < 0.08, "自检：平坦贴图必须被 std 判据判为失败");
  }

  // 接线：scene-mount 遍历系统贴图名单注册、全部 REPEAT 环绕
  const src = fs.readFileSync(join(ROOT, "renderer/src/scene-mount.ts"), "utf8");
  check(/SYSTEM_UTIL_TEXTURES/.test(src) && /buildSystemUtilTexture/.test(src), "scene-mount 应遍历注册系统内置 util 贴图");
  check(
    /const opts = \{ wrap: "repeat" \}/.test(src),
    "系统 util 贴图必须以 REPEAT 环绕注册（CLAMP 下 uv 漂移被拉成边缘行）",
  );
  const glSrc = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/gl-util.js"), "utf8");
  check(/opts && opts\.wrap === 'repeat' \? gl\.REPEAT/.test(glSrc), "makeTexture 应支持 wrap:'repeat'");
  check(/export function makeTextureMip\(gl, levels, rg88 = false, opts = null\)/.test(glSrc), "makeTextureMip 应支持 wrap:'repeat'（带 mip 的系统贴图同样被无界 uv 采样）");
}

console.log("\n[5] 精灵硬边封印：软形状贴图外圈 alpha 必须严格 0（2241938645 / 2250845956）");
{
  // 「能看出透明的方块」：烟/雾/火/光斑/气泡这类按精灵画的软形状贴图，边缘只要还留
  // 1~130/255 的 alpha，放大成几百~几千像素的 quad 后每个方块的直边就肉眼可见。
  const ptex = await import(
    pathToFileURL(join(ROOT, "renderer/vendor/we-scene/render/particle-textures.js")).href
  );
  const src = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/particle-textures.js"), "utf8");
  check(/RIM_SEALED/.test(src) && /function sealRim/.test(src), "生成器应有 RIM_SEALED + sealRim 封边");
  const border = (t) => {
    const W = t.width, H = t.height, rgba = t.rgba;
    const A = (x, y) => rgba[(y * W + x) * 4 + 3];
    let b = 0;
    for (let x = 0; x < W; x++) b = Math.max(b, A(x, 0), A(x, H - 1));
    for (let y = 0; y < H; y++) b = Math.max(b, A(0, y), A(W - 1, y));
    return b;
  };
  // 精灵类抽样（烟/雾/火/光柱/气泡/星芒/泪滴/风环）
  const sprites = [
    "particle/smoke/smoke2", "particle/smoke/smoke1", "particle/fog/fog1",
    "particle/fire/fire1", "particle/light/light_shafts_6", "particle/light/flare_2",
    "particle/bubbles/bubble1", "particle/misc/star_0", "particle/drop",
    "particle/shape/circle_wind", "particle/beam/beam_2_fade",
  ];
  let bad = 0;
  for (const n of sprites) {
    const t = ptex.buildBuiltinParticleTexture(n);
    const b = border(t);
    if (b > 2) { bad++; check(false, `${n} 外圈 alpha=${b}（应 0，放大后露方块边）`); }
  }
  check(bad === 0, `精灵类抽样 ${sprites.length} 张全部外圈 alpha ≤2`);
  // 法线豁免：alpha 是 REFRACT 蒙版
  const nrm = ptex.buildBuiltinParticleTexture("particle/drop_normal");
  check(nrm.rgba[3] > 0, "particle/drop_normal 必须豁免封边（法线 alpha 是折射蒙版）");
  // 雾图集：官方 fog1 是「黑洞 + 湍流环」的 8×8/64 帧图集（见 fogAtlas 注释）。
  // 它**不是**紧凑窗单帧贴图：环在 d≈0.4 才到峰值，靠**每帧四边 alpha→0** 防方块边。
  {
    const OFFICIAL_RADIAL = [0.02, 0.05, 0.09, 0.12, 0.14, 0.12, 0.09, 0.07, 0.03, 0.01, 0];
    const t = ptex.buildBuiltinParticleTexture("particle/fog/fog1");
    const frames = t.frames && t.frames.length ? t.frames : ptex.builtinParticleFrames("particle/fog/fog1");
    check(Array.isArray(frames) && frames.length === 64, `fog1 必须自带 64 帧帧表（实得 ${frames && frames.length}）`);
    const fallback = ptex.builtinParticleFrames("particle/fog/fog1");
    check(
      Array.isArray(fallback) && fallback.length === 64 && fallback[9].x === 128 && fallback[9].y === 128,
      `builtinParticleFrames 必须给出 fog1 的 8×8/64 帧兜底表（实得 ${fallback && fallback.length}）`,
    );
    check(t.width === 1024 && frames[0].width === 128, `fog1 图集应为 1024²/128² 帧（实得 ${t.width}/${frames[0].width}）`);
    const FW = frames[0].width;
    const A = (fi, x, y) => t.rgba[((frames[fi].y + y) * t.width + frames[fi].x + x) * 4 + 3] / 255;
    let frameBorder = 0;
    for (const f of frames) {
      for (let i = 0; i < FW; i++) {
        const pts = [[f.x + i, f.y], [f.x + i, f.y + FW - 1], [f.x, f.y + i], [f.x + FW - 1, f.y + i]];
        for (const [x, y] of pts) frameBorder = Math.max(frameBorder, t.rgba[(y * t.width + x) * 4 + 3]);
      }
    }
    check(frameBorder <= 2, `fog1 每帧四边 alpha 必须 ≤2（防 quad 直边，实得 ${frameBorder}）`);
    const frac = { a80: 0, a50: 0, a20: 0, a08: 0 };
    let sum = 0, n = 0;
    for (let f = 0; f < frames.length; f++) {
      for (let y = 0; y < FW; y++) for (let x = 0; x < FW; x++) {
        const a = A(f, x, y); sum += a; n++;
        if (a > 0.8) frac.a80++;
        if (a > 0.5) frac.a50++;
        if (a > 0.2) frac.a20++;
        if (a > 0.03) frac.a08++;
      }
    }
    const pct = (k) => (100 * frac[k]) / n;
    check(pct("a20") > 4 && pct("a20") < 10, `fog1 a>0.2 覆盖率应≈7.1%（实得 ${pct("a20").toFixed(2)}）`);
    check(pct("a08") > 24 && pct("a08") < 42, `fog1 a>0.03 覆盖率应≈31.7%（实得 ${pct("a08").toFixed(2)}）`);
    check(Math.abs(sum / n - 0.05) < 0.015, `fog1 平均 alpha 应≈5.0%（实得 ${((100 * sum) / n).toFixed(2)}%）`);
    const bins = new Array(11).fill(0), cnt = new Array(11).fill(0);
    for (let f = 0; f < frames.length; f++) {
      let cx = 0, cy = 0, cw = 0;
      for (let y = 0; y < FW; y++) for (let x = 0; x < FW; x++) if (A(f, x, y) > 0.03) { cx += x; cy += y; cw++; }
      cx /= cw; cy /= cw;
      for (let y = 0; y < FW; y++) for (let x = 0; x < FW; x++) {
        const d = Math.hypot((x - cx) / (FW / 2), (y - cy) / (FW / 2));
        const k = Math.min(10, Math.round(d * 10));
        bins[k] += A(f, x, y); cnt[k]++;
      }
    }
    const radial = bins.map((v, i) => v / cnt[i]);
    const worst = Math.max(...radial.map((v, i) => Math.abs(v - OFFICIAL_RADIAL[i])));
    check(worst < 0.04, `fog1 径向剖面须贴合官方（最大偏差 ${worst.toFixed(3)}）`);
    // 黑心 + 环：中心必须明显低于环带峰值
    check(radial[0] < radial[4] * 0.6, `fog1 必须是「黑心 + 环」（中心 ${radial[0].toFixed(3)} vs d=0.4 ${radial[4].toFixed(3)}）`);
    // 时间：快速翻滚且**精确循环**（末帧→首帧与相邻帧同量级）
    const madj = (a, b) => {
      let s = 0;
      for (let y = 0; y < FW; y++) for (let x = 0; x < FW; x++) s += Math.abs(A(a, x, y) - A(b, x, y));
      return (255 * s) / (FW * FW);
    };
    const dAdj = madj(0, 1), dSeam = madj(frames.length - 1, 0);
    check(dAdj > 0.3 && dAdj < 6, `fog1 相邻帧 |Δ| 应≈1.8/255（实得 ${dAdj.toFixed(1)}）`);
    check(dSeam < dAdj * 2.5, `fog1 末帧→首帧必须与相邻帧同量级（接缝 ${dSeam.toFixed(1)} vs 相邻 ${dAdj.toFixed(1)}）`);
    // 同一个 lag 在多基准帧上的平均相关必须单调下降（0.98/0.84/0.68/0.46/0.32）
    const corr = (b1, b2) => {
      let m = 0, s1 = 0, s2 = 0, s11 = 0, s22 = 0, s12 = 0;
      for (let y = 0; y < FW; y++) for (let x = 0; x < FW; x++) {
        const u = A(b1, x, y), v = A(b2, x, y);
        s1 += u; s2 += v; s11 += u * u; s22 += v * v; s12 += u * v; m++;
      }
      const m1 = s1 / m, m2 = s2 / m;
      return (s12 / m - m1 * m2) / (Math.sqrt(s11 / m - m1 * m1) * Math.sqrt(s22 / m - m2 * m2));
    };
    const lagAvg = (l) => {
      let cs = 0, k = 0;
      for (let i = 0; i + l < frames.length; i += 8) { cs += corr(i, i + l); k++; }
      return cs / k;
    };
    check(lagAvg(8) > 0.4 && lagAvg(8) < 0.85, `fog1 lag8 相关应≈0.68（实得 ${lagAvg(8).toFixed(3)}）`);
    check(lagAvg(32) < lagAvg(8) - 0.1, `fog1 必须真的在翻滚（lag32 ${lagAvg(32).toFixed(3)} 应明显低于 lag8 ${lagAvg(8).toFixed(3)}）`);
    check(t.rgba[0] === 255 && t.rgba[1] === 255 && t.rgba[2] === 255, "fog1 是 R8 语义：RGB 必须恒白（形状在 alpha）");
  }

  // ---------- 法线：WE 打包布局判定 + 与反照率同布局 ----------
  // 官方 DecompressNormalWithMask 对非 RG88 法线做 `normal.xw = normal.wx`：x ← 原 A、蒙版 ← 原 R。
  // 官方素材实测（本机原版，2026-09-20）：rain_drops_sheet_normal(RGBA8888) R=35/255 是水滴剪影、
  // G=190、A=190；splash_1_normal(DXT5nm) R=11.8 是水花剪影、G=128、A=128 —— 都是「A 不是 255」。
  // 我们自己的生成器与 RG88 转换结果是 (x,y,z,255)：A 恒 255。据此在贴图层判一次。
  {
    const px = (w, h, fn) => {
      const rgba = new Uint8Array(w * h * 4)
      for (let i = 0; i < w * h; i++) fn(rgba, i * 4)
      return { width: w, height: h, rgba }
    };
    const packed = px(8, 8, (o, i) => { o[i] = 40; o[i + 1] = 190; o[i + 2] = 0; o[i + 3] = 190 });
    check(ptex.isPackedNormalTexture(packed) === true, "A 非常量的法线必须判为 WE 打包布局（x 在 A、蒙版在 R）");
    const ours = px(8, 8, (o, i) => { o[i] = 128; o[i + 1] = 127; o[i + 2] = 250; o[i + 3] = 255 });
    check(ptex.isPackedNormalTexture(ours) === false, "我们生成的 (x,y,z,255) 法线不得判成 WE 打包");
    check(ptex.isPackedNormalTexture(null) === false, "空贴图必须安全返回 false");
    // 反照率与法线必须**同布局**：错位时一颗粒子会拿别的帧的法线去折射（3801012392）
    const albedo = ptex.buildBuiltinParticleTexture("particle/water/rain_drops_sheet");
    const nrm = ptex.buildBuiltinParticleTexture("particle/water/rain_drops_sheet_normal");
    check(
      nrm.width === albedo.width && nrm.height === albedo.height,
      `rain_drops_sheet_normal 必须与反照率同画布（反照率 ${albedo.width}×${albedo.height}，法线 ${nrm.width}×${nrm.height}）`,
    );
    check(ptex.isPackedNormalTexture(nrm) === false, "程序化 rain_drops_sheet_normal 是我们自己的 (x,y,z,255) 布局");
    const sp = ptex.buildBuiltinParticleTexture("particle/water/splash_1_normal");
    const spl = ptex.buildBuiltinParticleTexture("particle/water/splash_1");
    check(sp.width === spl.width && sp.height === spl.height, `splash_1_normal 必须与反照率同画布（法线 ${sp.width}×${sp.height}）`);
  }

  // ---------- 「中心点 + 环」图集与水滴图集：splash_1 / ripple_single / fog2 / fog3 / rain_drops_sheet ----------
  // 五张都是原版图集（帧尺寸/排布见下），程序化复刻按**每帧实测径向剖面** [A,R,W,C] 重建
  // （拟合残差见 particle-textures.js 各表注释），再乘均值保持的稀疏遮罩、最后按半径档把
  // 平均值拉回实测剖面。判据锁的是「帧表 + 布局 + 形态统计」，不是像素相等。
  {
    const CASES = [
      // name, 画布, 每帧, 帧数, [a80,a50,a20,a08] 容差, 均值, 均值容差
      ["particle/water/rain_drops_sheet", 256, 64, 16, "binary", true],
      ["particle/water/ripple_single", 224, 32, 14, "ring", true],
      ["particle/water/splash_1", 1024, 128, 64, "ring", false],
      ["particle/fog/fog2", 1024, 128, 64, "ring", true],
      ["particle/fog/fog3", 1024, 128, 64, "ring", true],
    ];
    for (const [name, canvas, cell, count, kind, loops] of CASES) {
      const t = ptex.buildBuiltinParticleTexture(name);
      const frames = t.frames && t.frames.length ? t.frames : ptex.builtinParticleFrames(name);
      check(Array.isArray(frames) && frames.length === count, `${name} 必须有 ${count} 帧帧表（实得 ${frames && frames.length}）`);
      const canvasH = name === "particle/water/ripple_single" ? 64 : canvas;
      check(t.width === canvas && t.height === canvasH, `${name} 图集应为 ${canvas}×${canvasH}（实得 ${t.width}×${t.height}）`);
      check(frames[0].width === cell && frames[0].height === cell, `${name} 每帧应为 ${cell}²（实得 ${frames[0].width}²）`);
      const fb = ptex.builtinParticleFrames(name);
      check(Array.isArray(fb) && fb.length === count, `builtinParticleFrames 必须给出 ${name} 的兜底帧表`);
      const FW = cell;
      const A = (fi, x, y) => t.rgba[((frames[fi].y + y) * t.width + frames[fi].x + x) * 4 + 3] / 255;
      // 每帧四边不得有实心内容（原版这几张的边框带都接近 0）
      let bMax = 0;
      for (const f of frames) {
        for (let i = 0; i < FW; i++) {
          const pts = [[f.x + i, f.y], [f.x + i, f.y + FW - 1], [f.x, f.y + i], [f.x + FW - 1, f.y + i]];
          for (const [x, y] of pts) bMax = Math.max(bMax, t.rgba[(y * t.width + x) * 4 + 3]);
        }
      }
      check(bMax <= 8, `${name} 每帧四边 alpha 必须接近 0（实得 ${bMax}）`);
      const frac = { a80: 0, a50: 0, a20: 0, a08: 0 };
      let sum = 0, n = 0;
      for (let f = 0; f < frames.length; f++) {
        for (let y = 0; y < FW; y++) for (let x = 0; x < FW; x++) {
          const a = A(f, x, y); sum += a; n++;
          if (a > 0.8) frac.a80++;
          if (a > 0.5) frac.a50++;
          if (a > 0.2) frac.a20++;
          if (a > 0.03) frac.a08++;
        }
      }
      const pct = (k) => (100 * frac[k]) / n;
      const mean = (100 * sum) / n;
      if (kind === "binary") {
        // 水滴是**二值** alpha（原版 13.81% 的像素正好是 1，其余 0）
        check(Math.abs(pct("a80") - 13.81) < 2 && Math.abs(pct("a08") - 13.81) < 2, `${name} 覆盖率应≈13.81%（实得 ${pct("a08").toFixed(2)}）`);
        check(Math.abs(pct("a80") - pct("a08")) < 0.6, `${name} alpha 必须是二值（a>0.8 ${pct("a80").toFixed(2)} vs a>0.03 ${pct("a08").toFixed(2)}）`);
        check(Math.abs(mean - 13.81) < 2, `${name} 均值应≈13.81%（实得 ${mean.toFixed(2)}）`);
      } else {
        const OFF = {
          "particle/water/ripple_single": [1.42, 6.8, 12.51, 18.22, 7.23],
          "particle/water/splash_1": [3.22, 4.5, 5.98, 7.31, 4.63],
          "particle/fog/fog2": [10.09, 18.02, 23.33, 27.69, 16.85],
          "particle/fog/fog3": [0, 0, 1.58, 10.91, 1.37],
        }[name];
        check(Math.abs(pct("a20") - OFF[2]) < Math.max(2.5, OFF[2] * 0.35), `${name} a>0.2 覆盖率应≈${OFF[2]}%（实得 ${pct("a20").toFixed(2)}）`);
        check(Math.abs(pct("a08") - OFF[3]) < Math.max(3.5, OFF[3] * 0.35), `${name} a>0.03 覆盖率应≈${OFF[3]}%（实得 ${pct("a08").toFixed(2)}）`);
        check(Math.abs(mean - OFF[4]) / OFF[4] < 0.15, `${name} 均值应≈${OFF[4]}%（实得 ${mean.toFixed(2)}）`);
      }
      // 逐帧推进必须真的存在（这些原版都是 SEQUENCE）：相邻帧差不得为 0
      const madj = (a, b) => {
        let d = 0;
        for (let y = 0; y < FW; y++) for (let x = 0; x < FW; x++) d += Math.abs(A(a, x, y) - A(b, x, y));
        return (255 * d) / (FW * FW);
      };
      check(madj(0, 1) > 0.02, `${name} 相邻帧必须有变化（实得 ${madj(0, 1).toFixed(3)}，静止=没帧表）`);
      if (kind !== "binary") {
        if (loops) check(madj(frames.length - 1, 0) < Math.max(3, madj(0, 1) * 2.5), `${name} 末帧→首帧不得比相邻帧剧烈（接缝 ${madj(frames.length - 1, 0).toFixed(2)} vs 相邻 ${madj(0, 1).toFixed(2)}）`);
        // splash_1 原版就是**不循环**的（接缝 16.26 vs 相邻 0.80）：每颗水花从中心炸开一次
        else check(madj(frames.length - 1, 0) > 3, `${name} 原版是不循环的水花：末帧→首帧必须剧烈（实得 ${madj(frames.length - 1, 0).toFixed(2)}）`);
      }
    }
  }

  // ---------- 烟图集：官方 smoke2 的统计不变量（2031502939「烟雾和原版素材差距很大」） ----------
  // 烟**不是**紧凑窗单帧贴图：官方是 1024² / 8×8 / 64 帧 128² 的「圆瓣团絮」图集，
  // 团絮铺满整帧（r>0.75 仍有内容），靠**每帧四边 alpha→0** 保证 quad 直边不可见。
  // 判据锁官方实测统计（不是像素相等）：覆盖率 a>0.8/0.5/0.2/0.03 = 34.4/47.9/59.3/67.5%、
  // 均值 45.8/255、质心径向剖面 0.96 0.96 0.96 0.95 0.93 0.89 0.78 0.59 0.39 0.22 0.07、
  // 相邻帧 |Δ|=2.9/255、帧 63→帧 0 接缝与相邻帧同量级（精确循环）、RGB 近常量白烟。
  {
    const OFFICIAL_RADIAL = [0.96, 0.96, 0.96, 0.95, 0.93, 0.89, 0.78, 0.59, 0.39, 0.22, 0.07];
    const t = ptex.buildBuiltinParticleTexture("particle/smoke/smoke2");
    const frames = t.frames && t.frames.length ? t.frames : ptex.builtinParticleFrames("particle/smoke/smoke2");
    check(Array.isArray(frames) && frames.length === 64, `smoke2 必须自带 64 帧帧表（实得 ${frames && frames.length}）`);
    // 兜底路径也要有：贴图对象不带帧表时（别的调用方直接问名字）必须仍给 8×8/64 帧
    const fallback = ptex.builtinParticleFrames("particle/smoke/smoke2");
    check(
      Array.isArray(fallback) && fallback.length === 64 && fallback[0].width === 128 && fallback[9].x === 128 && fallback[9].y === 128,
      `builtinParticleFrames 必须给出 smoke2 的 8×8/64 帧兜底表（实得 ${fallback && fallback.length}）`,
    );
    check(t.width === 1024 && t.height === 1024, `smoke2 图集应为 1024²（实得 ${t.width}×${t.height}）`);
    const FW = frames[0].width;
    check(FW === 128 && frames[0].height === 128, `smoke2 每帧应为 128²（实得 ${FW}×${frames[0].height}）`);
    const A = (fi, x, y) => t.rgba[((frames[fi].y + y) * t.width + frames[fi].x + x) * 4 + 3] / 255;
    // 每帧四边 alpha 必须 ≤2（r>0.75 外**允许**有内容：官方就是这样，靠帧边归零防方块边）
    let frameBorder = 0;
    for (const f of frames) {
      for (let i = 0; i < FW; i++) {
        const pts = [[f.x + i, f.y], [f.x + i, f.y + FW - 1], [f.x, f.y + i], [f.x + FW - 1, f.y + i]];
        for (const [x, y] of pts) frameBorder = Math.max(frameBorder, t.rgba[(y * t.width + x) * 4 + 3]);
      }
    }
    check(frameBorder <= 2, `smoke2 每帧四边 alpha 必须 ≤2（防 quad 直边，实得 ${frameBorder}）`);
    const frac = { a80: 0, a50: 0, a20: 0, a08: 0 };
    let sum = 0, n = 0;
    for (let f = 0; f < frames.length; f++) {
      for (let y = 0; y < FW; y++) for (let x = 0; x < FW; x++) {
        const a = A(f, x, y); sum += a; n++;
        if (a > 0.8) frac.a80++;
        if (a > 0.5) frac.a50++;
        if (a > 0.2) frac.a20++;
        if (a > 0.03) frac.a08++;
      }
    }
    const pct = (k) => (100 * frac[k]) / n;
    check(Math.abs(pct("a80") - 34.4) < 6, `smoke2 a>0.8 覆盖率应≈34.4%（实得 ${pct("a80").toFixed(1)}）`);
    check(Math.abs(pct("a50") - 47.9) < 6, `smoke2 a>0.5 覆盖率应≈47.9%（实得 ${pct("a50").toFixed(1)}）`);
    check(Math.abs(pct("a20") - 59.3) < 8, `smoke2 a>0.2 覆盖率应≈59.3%（实得 ${pct("a20").toFixed(1)}）`);
    check(Math.abs(pct("a08") - 67.5) < 8, `smoke2 a>0.03 覆盖率应≈67.5%（实得 ${pct("a08").toFixed(1)}）`);
    check(Math.abs(sum / n - 0.458) < 0.06, `smoke2 平均 alpha 应≈45.8%（实得 ${((100 * sum) / n).toFixed(1)}%）`);
    const bins = new Array(11).fill(0), cnt = new Array(11).fill(0);
    for (let f = 0; f < frames.length; f++) {
      let cx = 0, cy = 0, cw = 0;
      for (let y = 0; y < FW; y++) for (let x = 0; x < FW; x++) if (A(f, x, y) > 0.03) { cx += x; cy += y; cw++; }
      cx /= cw; cy /= cw;
      for (let y = 0; y < FW; y++) for (let x = 0; x < FW; x++) {
        const d = Math.hypot((x - cx) / (FW / 2), (y - cy) / (FW / 2));
        const k = Math.min(10, Math.round(d * 10));
        bins[k] += A(f, x, y); cnt[k]++;
      }
    }
    const radial = bins.map((v, i) => v / cnt[i]);
    const worst = Math.max(...radial.map((v, i) => Math.abs(v - OFFICIAL_RADIAL[i])));
    check(worst < 0.25, `smoke2 径向剖面须贴合官方（最大偏差 ${worst.toFixed(2)}）`);
    check(radial[0] > 0.8 && radial[10] < 0.2, `smoke2 须「中心实心 + 外圈软晕」（中心 ${radial[0].toFixed(2)} / 边 ${radial[10].toFixed(2)}）`);
    const madj = (a, b) => {
      let s = 0;
      for (let y = 0; y < FW; y++) for (let x = 0; x < FW; x++) s += Math.abs(A(a, x, y) - A(b, x, y));
      return (255 * s) / (FW * FW);
    };
    const dAdj = madj(0, 1), dSeam = madj(frames.length - 1, 0);
    check(dAdj > 0.5 && dAdj < 8, `smoke2 相邻帧 |Δ| 应≈2.9/255（实得 ${dAdj.toFixed(1)}）`);
    check(dSeam < dAdj * 2.5, `smoke2 末帧→首帧必须与相邻帧同量级（接缝 ${dSeam.toFixed(1)} vs 相邻 ${dAdj.toFixed(1)}）`);
    let cMin = 255, cMax = 0, cSum = 0, cN = 0;
    for (let i = 0; i < t.width * t.height; i++) { const v = t.rgba[i * 4]; if (v < cMin) cMin = v; if (v > cMax) cMax = v; cSum += v; cN++; }
    check(cMin > 180 && cSum / cN > 0.85 * 255, `smoke2 RGB 应近常量白烟（min ${cMin} 均值 ${(cSum / cN).toFixed(1)}）`);
    const lt = ptex.buildBuiltinParticleTexture("particle/smoke/smoke2light");
    let ls = 0;
    for (let i = 0; i < lt.width * lt.height; i++) ls += lt.rgba[i * 4];
    const lMean = ls / (lt.width * lt.height) / 255;
    check(lMean > 0.2 && lMean < 0.5, `smoke2light RGB 均值应≈0.34（实得 ${lMean.toFixed(3)}）`);
  }
}

// ---------- .tex 容器变体：`flags & 0x40` 的 LUT 导出器（头部 + 每条 mip 各多一个 u32） ----------
// WE 自带颜色分级 LUT（materials/lut/*.tex，28/28）用另一种前缀：TEXI 头之后多一个
// = 像素数的 u32，且**每条 mip 记录前也多一个 u32**。按标准布局读会把 TEXB magic
// 读成像素数据（「未知 TEXB 容器」整张作废）、或在 mip 上把 lz4 标志读成 32、载荷
// 长度读成 0（空图）。本机接入原版素材时 28 张 LUT 全灭就是这个。
// 判据：同一份像素分别按两种布局打包，parseTex 必须给出相同的 width/height/格式/载荷。
async function containerVariant() {
  const { parseTex } = await import(pathToFileURL(join(ROOT, "renderer/vendor/we-scene/pkg/texture.js")).href);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);
  const build = (variant) => {
    const chunks = [];
    const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); chunks.push(b); };
    const stamp = (str) => chunks.push(Buffer.from(str.padEnd(9, "\0"), "latin1"));
    stamp("TEXV0005");
    stamp("TEXI0001");
    u32(0);                       // format ARGB8888
    u32(variant ? 66 : 0);        // flags（0x42 = LUT 导出器）
    u32(32); u32(32);             // width/height（POT）
    if (variant) u32(1024);       // 变体：多一个 = 像素数 的 u32
    u32(32); u32(32);             // mapWidth/mapHeight
    u32(0);                       // reserved_a
    stamp("TEXB0004");
    u32(1);                       // imageCount
    u32(13);                      // freeImageFormat = PNG
    u32(0);                       // hasMipExtension = 0 → V3 布局
    u32(1);                       // mipCount
    u32(32); u32(32);             // mip 宽高
    if (variant) u32(32);         // 变体：mip 记录前多一个 u32
    u32(0); u32(0);               // lz4 标志 / 解压尺寸
    u32(png.length);              // src_size
    chunks.push(png);
    return new Uint8Array(Buffer.concat(chunks));
  };
  const safeParse = (buf) => {
    try {
      return parseTex(buf);
    } catch (e) {
      return { width: -1, height: -1, textureWidth: -1, textureHeight: -1, images: [[{ data: new Uint8Array(0) }]], error: String(e && e.message) };
    }
  };
  const normal = safeParse(build(false));
  const lut = safeParse(build(true));
  check(normal.width === 32 && normal.height === 32, `标准布局 .tex 解析 32×32（实得 ${normal.width}×${normal.height}）`);
  check(
    lut.width === 32 && lut.height === 32,
    `LUT 变体 .tex 解析 32×32（实得 ${lut.width}×${lut.height}${lut.error ? "，抛错：" + lut.error : ""}）`,
  );
  check(lut.textureWidth === 32 && lut.textureHeight === 32, "LUT 变体保留 TEXI 声明的单帧尺寸");
  const n0 = normal.images[0] && normal.images[0][0];
  const l0 = lut.images[0] && lut.images[0][0];
  check(!!n0 && !!l0 && n0.data.length === png.length, "标准布局载荷长度 = 容器声明（不能为空）");
  check(!!l0 && l0.data.length === png.length, `LUT 变体载荷长度 = 容器声明（实得 ${l0 ? l0.data.length : -1}，0 = 变体布局没认出来）`);
  check(
    !!l0 && Buffer.from(l0.data).equals(png),
    "LUT 变体载荷逐字节等于嵌入的 PNG",
  );
  // 反例：把 flags 的 0x40 去掉但保留多出来的 u32 —— 必须**不**按变体解析（不能见谁都偏移）
  const noFlag = build(true);
  noFlag[22] = 0;
  const wrong = safeParse(noFlag);
  check(
    wrong.images[0][0].data.length === 0,
    "无 0x40 标记时不得套用变体布局（载荷应为空 —— 说明判据挂在 flags 上）",
  );
  // 真实语料（本机装了原版素材时）：28 个 LUT 全部解析出 PNG 载荷
  const LUT_DIR = process.env.WE_LOCAL_ASSETS
    ? join(process.env.WE_LOCAL_ASSETS, "materials", "lut")
    : join(process.env.HOME || "", "Documents", "workspace", "MirageWallpaper", "assets", "materials", "lut");
  if (!fs.existsSync(LUT_DIR)) {
    console.log("  （跳过本机 LUT 语料：没有 " + LUT_DIR + "）");
  } else {
    let ok = 0;
    let bad = 0;
    for (const f of fs.readdirSync(LUT_DIR)) {
      if (!f.endsWith(".tex")) continue;
      try {
        const t = parseTex(new Uint8Array(fs.readFileSync(join(LUT_DIR, f))));
        const m = t.images[0] && t.images[0][0];
        if (m && m.data.length > 64 && m.data[0] === 0x89 && m.data[1] === 0x50) ok++;
        else bad++;
      } catch (e) {
        bad++;
      }
    }
    check(bad === 0 && ok >= 28, `本机 LUT 语料 ${ok} 张解析出 PNG 载荷、失败 ${bad}`);
  }
}

await containerVariant();

// ---------- TEXV0004 旧容器（764162681 Jake 的五张贴图：整张壁纸加载失败的真因） ----------
// TEXV0004 与 TEXV0005 的差别（本机 5 张实测）：
//   · 魔数后**没有 `TEXI0001` 子魔数**，条目也没有 `TEXB` 容器魔数；
//   · 头之后直接是「imageCount + 单条 mip 记录」，mip 记录 = `{w, h, size, 原始像素}`
//     （没有 LZ4 的 compression/uncompressedSize 两个 u32 —— 实测 payload 恰好 = W×H×1）。
// 旧解析器只认 TEXV0005 → 五张全抛「不是 .tex 文件」→ 挂载中断 → 整张墙不加载。
async function texV4() {
  const { parseTex } = await import(pathToFileURL(join(ROOT, "renderer/vendor/we-scene/pkg/texture.js")).href);
  // 合成：4×4 DXT5（format=4）单 mip，载荷 16 字节
  const build = () => {
    const chunks = []
    const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); chunks.push(b) }
    chunks.push(Buffer.from("TEXV0004\0", "latin1"))
    u32(4) // format = DXT5
    u32(2) // flags
    u32(8); u32(8) // textureWidth/Height
    u32(4); u32(4) // width/height
    u32(1) // imageCount
    u32(4); u32(4) // mip0 w/h
    const data = Buffer.alloc(16, 0x7f)
    u32(16) // mip0 size
    chunks.push(data)
    return Buffer.concat(chunks)
  }
  let t = null;
  let parseErr = "";
  try { t = parseTex(new Uint8Array(build())); } catch (e) { parseErr = e.message; }
  check(!!t, `TEXV0004 必须能解析（实得异常：${parseErr}）`);
  check(!!t && t.format === 4 && t.width === 4 && t.height === 4 && t.textureWidth === 8, `TEXV0004 头部字段应解析为 4/4×4（texture 8）：实得 fmt=${t && t.format} ${t && t.width}×${t && t.height} tex=${t && t.textureWidth}`);
  check(!!t && t.images.length === 1 && t.images[0].length === 1 && t.images[0][0].data.length === 16, "TEXV0004 必须解析出 1 图 1 mip 16 字节载荷");
  check(!!t && t.images[0][0].compression === 0 && t.frames === null, "TEXV0004 的 mip 必须按未压缩处理（无 LZ4 头）");
  // 反例：载荷越界必须抛错，而不是静默截断
  const bad = build()
  bad.writeUInt32LE(9999, 45)
  let threw = false
  try { parseTex(new Uint8Array(bad)) } catch { threw = true }
  check(threw, "TEXV0004 载荷越界必须抛错");
  // 真实语料（本机装了这张壁纸时）：五张必须解析出 DXT5 与 2048²/512²
  const pkgPath = join(process.env.HOME || "", "Library/Application Support/io.github.oneincase.wallpaperem/wallpapers/764162681/scene.pkg");
  let found = 0;
  if (fs.existsSync(pkgPath)) {
    const { parsePkg, getEntry } = await import(pathToFileURL(join(ROOT, "renderer/vendor/we-scene/pkg/container.js")).href);
    const { decodeMips } = await import(pathToFileURL(join(ROOT, "renderer/vendor/we-scene/pkg/texture.js")).href);
    const pkg = parsePkg(new Uint8Array(fs.readFileSync(pkgPath)));
    for (const e of pkg.entries) {
      if (!e.name.endsWith(".tex")) continue;
      let ok = false;
      let info = "";
      try {
        const parsed = parseTex(new Uint8Array(getEntry(pkg, e.name)));
        const m0 = decodeMips(parsed)[0];
        ok = parsed.format === 4 && (parsed.width === 2048 || parsed.width === 512) && !!m0.rgba && m0.width === parsed.width;
        info = `fmt=${parsed.format} ${parsed.width}² rgba=${!!m0.rgba}`;
      } catch (e) {
        info = "异常 " + e.message;
      }
      if (!ok) check(false, `764162681 ${e.name} 应解析为 DXT5 2048²/512² 并解出像素（实得 ${info}）`);
      found++;
    }
  }
  console.log(`  · TEXV0004 真实语料命中 ${found} 张（本机 764162681）`);
}

await texV4();

// ---------- 官方素材的纹理格式语义 + TEXS 帧表接线（本机接入原版素材时暴露） ----------
// WE `common_fragment.h::ConvertTexture0Format`（GLSL 分支）：R8 → vec4(1,1,1,r)、
// RG88 → vec4(r,r,r,g)。粒子 shader 用 `.a` 当形状，而我们解码出来的 R8 是 (r,r,r,255)
// （实心方块）、RG88 是 (G,G,G,R)（取错通道）。stock 粒子图集大量是这两种格式：
// rain1 / fog1 / splash_1(R8)、rain_drops_sheet / light_shafts_0(RG88)。
// 同时 stock 图集带 TEXS 帧表（rain_drops_sheet 16、fog1/splash_1 64、ripple_single 14），
// 粒子取贴图必须优先用真帧表，否则退化成「整张图集当一帧」= 一坨糊（3801012392 实测）。
async function stockTexFormats() {
  const ptex = await import(pathToFileURL(join(ROOT, "renderer/vendor/we-scene/render/particle-textures.js")).href);
  const px = (w, h, fn) => {
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) fn(rgba, i * 4);
    return { width: w, height: h, rgba };
  };
  const r8 = ptex.convertParticleTexFormat(px(2, 2, (o, i) => { o[i] = 200; o[i + 1] = 200; o[i + 2] = 200; o[i + 3] = 255 }), 9);
  check(
    r8.rgba[0] === 255 && r8.rgba[1] === 255 && r8.rgba[2] === 255 && r8.rgba[3] === 200,
    `R8 取样语义应为 (255,255,255,200)（形状进 alpha），实得 ${[...r8.rgba.slice(0, 4)]}`,
  );
  // 但输入必须是**解码器真正给出的通道布局**：tex-codecs 的 fromRG88 按 RePKG/ImageSharp
  // 解码成 (fileG,fileG,fileG,fileR)（灰度在第 2 字节、alpha 在第 1 字节），而 WE 的
  // `vec4(_sample.r,…, _sample.g)` 取的是 GL_RG 的 (fileR,fileG) —— 即 WE 的 rgb 来自
  // 解码器的 **alpha**、WE 的 alpha 来自解码器的 **rgb**。上一版把两路都写成 src[0..1]
  // （同一个 fileG），RGB 因此变成形状灰度：官方 smoke2 的 R 通道实测 234.8/255 近常量，
  // 拿形状当 rgb 会让 `rgb×alpha` 从 shape¹ 掉成 shape²，外圈软晕整体暗掉。
  const rgReal = ptex.convertParticleTexFormat(
    px(2, 2, (o, i) => { o[i] = 220; o[i + 1] = 220; o[i + 2] = 220; o[i + 3] = 30 }), // 解码后布局：fileG 铺 rgb、fileR 在 alpha
    8,
  );
  check(
    rgReal.rgba[0] === 30 && rgReal.rgba[1] === 30 && rgReal.rgba[2] === 30 && rgReal.rgba[3] === 220,
    `RG88 必须把解码器的 alpha 当 rgb、rgb 当 alpha（WE 的 _sample.rrrg），实得 ${[...rgReal.rgba.slice(0, 4)]}`,
  );
  const plain = px(2, 2, (o, i) => { o[i] = 10; o[i + 1] = 20; o[i + 2] = 30; o[i + 3] = 40 });
  check(ptex.convertParticleTexFormat(plain, 0) === plain, "ARGB8888 不得被转换（原样返回同一对象）");
  const nrm = ptex.convertParticleNormalFormat(px(2, 2, (o, i) => { o[i] = 30; o[i + 1] = 220; o[i + 2] = 7; o[i + 3] = 9 }), 8);
  check(
    nrm.rgba[0] === 220 && nrm.rgba[1] === 30 && nrm.rgba[2] === 0 && nrm.rgba[3] === 255,
    `RG88 法线应换成 (G,R,0,255)（WE: normal.xy = normal.gr*2-1），实得 ${[...nrm.rgba.slice(0, 4)]}`,
  );
  check(ptex.convertParticleNormalFormat(plain, 0) === plain, "非 RG88 法线不得被转换");

  // 接线：粒子取贴图路径（scene-mount）必须按用途转换格式、优先真帧表、按需拉本机素材、
  // 且只在 pkg 真有该贴图时才走 pkg 分支（否则 loadTexInner 会把内置贴图提前程序化建出，
  // 转换与真帧表永远轮不到 —— 这正是接入原版素材后仍然「效果太差」的第二个坑）。
  const sm = fs.readFileSync(join(ROOT, "renderer/src/scene-mount.ts"), "utf8");
  const wiring = [
    [/ptex\.convertParticleTexFormat\(gen, gen\.format\)/, "反照率必须过 convertParticleTexFormat"],
    [/ptex\.convertParticleNormalFormat\(gen, gen\.format\)/, "法线槽必须过 convertParticleNormalFormat"],
    [/frames: gen\.frames && gen\.frames\.length \? gen\.frames : ptex\.builtinParticleFrames\(name\)/, "帧表必须「原版 TEXS 优先、内置猜测兜底」"],
    [/await ensureLocalAsset\(name\)/, "本机素材必须按需拉取（provider 否则拿不到像素）"],
    [/loadParticleTex\(nrmName, "normal"\)/, "法线槽调用必须带 purpose=normal"],
    [/pkg\.getEntry\(parsedPkg, `materials\/\$\{name\}\.tex`\) \? await loadTex\(name\) : null/, "必须只在 pkg 命中时走 pkg 分支"],
  ];
  for (const [re, msg] of wiring) check(re.test(sm), `接线：${msg}`);
  // 本机素材装载端也要带上格式与帧表（否则上面两条无从谈起）
  const la = fs.readFileSync(join(ROOT, "renderer/src/local-assets.ts"), "utf8");
  check(/px\.format = parsed\.format/.test(la), "local-assets 必须把 .tex 格式带给消费方");
  check(/atlasWidth = px\.width/.test(la), "local-assets 必须把 TEXS 帧表连图集尺寸一起带上");

  // 真实语料（本机装了原版素材时）：转换后的 alpha 必须真的携带形状
  const MAT = process.env.WE_LOCAL_ASSETS
    ? join(process.env.WE_LOCAL_ASSETS, "materials")
    : join(process.env.HOME || "", "Documents", "workspace", "MirageWallpaper", "assets", "materials");
  if (!fs.existsSync(MAT)) {
    console.log(`  （跳过本机原版素材语料：没有 ${MAT}）`);
    return;
  }
  const tex = await import(pathToFileURL(join(ROOT, "renderer/vendor/we-scene/pkg/texture.js")).href);
  const cases = [
    ["particle/nature/rain1", 9],
    ["particle/fog/fog1", 9],
    ["particle/water/rain_drops_sheet", 8],
    ["particle/light/light_shafts_0", 8],
    ["particle/smoke/smoke2", 8],
  ];
  let seen = 0;
  for (const [name, fmt] of cases) {
    const f = join(MAT, `${name}.tex`);
    if (!fs.existsSync(f)) continue;
    seen++;
    const parsed = tex.parseTex(new Uint8Array(fs.readFileSync(f)));
    const m0 = tex.decodeMips(parsed)[0];
    const conv = ptex.convertParticleTexFormat({ width: m0.width, height: m0.height, rgba: m0.rgba }, parsed.format);
    let mean = 0;
    let m2 = 0;
    let amax = 0;
    const n = conv.width * conv.height;
    for (let i = 0; i < n; i++) {
      const a = conv.rgba[i * 4 + 3];
      mean += a;
      m2 += a * a;
      if (a > amax) amax = a;
    }
    mean /= n;
    const sd = Math.sqrt(Math.max(0, m2 / n - mean * mean));
    // RGB 必须比 alpha「平」：官方 RG88 的字节 0（= 解码器的 alpha 通道）是亮度/近常量，
    // 字节 1（= 解码器的 rgb 通道）才是形状。取错通道时两者会反过来（rgb 抖、alpha 平）。
    let cMean = 0;
    let cM2 = 0;
    for (let i = 0; i < n; i++) {
      const c = conv.rgba[i * 4];
      cMean += c;
      cM2 += c * c;
    }
    cMean /= n;
    const cSd = Math.sqrt(Math.max(0, cM2 / n - cMean * cMean));
    check(parsed.format === fmt, `${name} 语料格式应为 ${fmt}，实得 ${parsed.format}`);
    check(amax > 32 && sd > 4, `${name} 转换后 alpha 必须携带形状（max=${amax} sd=${sd.toFixed(1)}）`);
    check(cSd < sd, `${name} 转换后 rgb 必须比 alpha 平（形状在 alpha：rgb sd=${cSd.toFixed(1)} alpha sd=${sd.toFixed(1)}）`);
    if (parsed.frames?.list?.length) {
      console.log(`  · ${name} 带 TEXS ${parsed.frames.list.length} 帧（${parsed.frames.list[0].width}×${parsed.frames.list[0].height}）`);
    }
  }
  check(seen > 0, `本机原版素材语料命中 ${seen} 张`);
}

await stockTexFormats();

// ---------- 内置渐变（gradient/gradient_*）：程序化复刻 + 三处接线 ----------
// shimmer / lightshafts / procedural_noise 的 gradient map 槽走 sampler default
// （`gradient/gradient_ferro_fluid` 等），不在壁纸 pkg 里。缺它落 whiteTex →
// shimmer 的混合权重 `mask * shimmerColor` 恒 1，「从左向右扫过的亮暗带」退化成
// 整层恒定染色（3737267090 用户报缺失动画；全库 3 个渐变名 / 13 张壁纸受影响，
// 2026-09-21 sampler default 全库扫描）。修复 = gradient-textures.js 锚点表复刻
// + scene-mount 的 loadTexInner 兜底 + local-assets provider 官方像素覆盖。
async function builtinGradients() {
  const gtex = await import(
    pathToFileURL(join(ROOT, "renderer/vendor/we-scene/render/gradient-textures.js")).href
  );
  // 登记表：本库在用的 3 个名字必须齐（ferro_fluid=shimmer、iridescent=lightshafts、
  // fire=procedural_noise），形近名字不得误命中。
  const names = gtex.listBuiltinGradientTextureNames();
  for (const must of ["gradient/gradient_ferro_fluid", "gradient/gradient_fire", "gradient/gradient_iridescent"]) {
    check(names.includes(must), `内置渐变登记表必须含 ${must}`);
  }
  check(
    !gtex.isBuiltinGradientTextureName("gradient/gradient_nope") &&
      !gtex.isBuiltinGradientTextureName("util/white") &&
      !gtex.isBuiltinGradientTextureName(null),
    "isBuiltinGradientTextureName 必须拒绝未登记名 / 非渐变名 / null",
  );
  // 径向坡（blend_gradient[_reverse]）：blur 的径向模糊蒙版（3047405322）与媒体
  // 组件渐变掩码（2134765860/2370927443）用。落白 = 蒙版 .r 恒 1 → 整屏全模糊。
  check(
    gtex.isBuiltinGradientTextureName("gradient/blend_gradient") &&
      gtex.isBuiltinGradientTextureName("gradient/blend_gradient_reverse"),
    "登记表必须含径向坡 blend_gradient / blend_gradient_reverse",
  );
  const rad = gtex.buildBuiltinGradientTexture("gradient/blend_gradient");
  check(rad && rad.width === 256 && rad.height === 256, `blend_gradient 尺寸应为 256²，实得 ${rad && `${rad.width}×${rad.height}`}`);
  const radPx = (x, y) => rad.rgba[(y * 256 + x) * 4];
  check(
    radPx(128, 128) <= 2 && radPx(255, 255) >= 250 && radPx(255, 0) >= 250,
    `blend_gradient 必须中心黑(≤2) 角白(≥250)，实得 中心=${radPx(128, 128)} 角=${radPx(255, 255)}`,
  );
  const radR = gtex.buildBuiltinGradientTexture("gradient/blend_gradient_reverse");
  const revPx = (x, y) => radR.rgba[(y * 256 + x) * 4];
  check(
    revPx(128, 128) >= 253 && revPx(255, 255) <= 5,
    `blend_gradient_reverse 必须为反相（中心 ≥253 / 角 ≤5），实得 中心=${revPx(128, 128)} 角=${revPx(255, 255)}`,
  );
  check(
    revPx(128, 64) === 255 - radPx(128, 64),
    `reverse 必须逐点反相（官方实测偏差 0），实得 ${revPx(128, 64)} vs ${255 - radPx(128, 64)}`,
  );
  // 径向对称抽检（官方实测对称；坐标须对 127.5 中心等距）
  check(
    radPx(128, 16) === radPx(16, 128) && radPx(128, 240) === radPx(240, 128),
    "blend_gradient 必须径向对称",
  );
  // 输出契约：64×2、两行相同（官方原图即此形态）；重复构建返回同一缓存对象。
  const g = gtex.buildBuiltinGradientTexture("gradient/gradient_ferro_fluid");
  check(g && g.width === 64 && g.height === 2, `ferro_fluid 尺寸应为 64×2，实得 ${g && `${g.width}×${g.height}`}`);
  check(gtex.buildBuiltinGradientTexture("gradient/gradient_ferro_fluid") === g, "同名字必须命中缓存（确定性）");
  let rowsEqual = true;
  for (let x = 0; x < 64; x++) {
    for (let c = 0; c < 4; c++) {
      if (g.rgba[x * 4 + c] !== g.rgba[(64 + x) * 4 + c]) rowsEqual = false;
    }
  }
  check(rowsEqual, "渐变两行必须逐位相同（1D 色带）");
  check(gtex.buildBuiltinGradientTexture("gradient/gradient_nope") === null, "未登记名必须返回 null（调用方继续走其它来源）");
  // 形状不变量（判据锁形态，不锁字节）：ferro_fluid = 近黑底 + 一条窄银带
  // （官方峰值在 x≈41-42，x∈[35,48]），全行均值必须低 —— 亮带丢了或铺满全行都红。
  const cols = [];
  for (let x = 0; x < 64; x++) {
    cols.push((g.rgba[x * 4] + g.rgba[x * 4 + 1] + g.rgba[x * 4 + 2]) / 3);
  }
  const mean = cols.reduce((a, b) => a + b, 0) / 64;
  let peak = 0;
  for (let x = 0; x < 64; x++) if (cols[x] > cols[peak]) peak = x;
  check(mean < 40, `ferro_fluid 全行均值必须 <40（近黑底），实得 ${mean.toFixed(1)}`);
  check(peak >= 35 && peak <= 48, `ferro_fluid 亮带峰值列必须在 [35,48]，实得 x=${peak}`);
  // fire：暗红起步（g 低）、尾部偏黄（g 高）—— g 单调上升被破坏即红。
  const fire = gtex.buildBuiltinGradientTexture("gradient/gradient_fire");
  const gMean = (x0, x1) => {
    let s = 0;
    for (let x = x0; x < x1; x++) s += fire.rgba[x * 4 + 1];
    return s / (x1 - x0);
  };
  check(gMean(0, 8) < 20 && gMean(56, 64) > 150, `fire 的 G 通道必须「暗红→黄」上升（首 8 列均值 ${gMean(0, 8).toFixed(0)}、末 8 列均值 ${gMean(56, 64).toFixed(0)}）`);
  // 锚点表自检：x 单调且首尾钉住 0/63 —— 表被改乱（乱序/越界）时插值会静默出错。
  const src = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/gradient-textures.js"), "utf8");
  const entries = [...src.matchAll(/^  ([a-z0-9_]+): \{ r8: (?:true|false), stops: (\[\[.*?\]\]) \},?$/gm)];
  check(entries.length >= 14, `渐变锚点表必须 ≥14 条，实得 ${entries.length}`);
  for (const [, variant, stopsSrc] of entries) {
    const xs = [...stopsSrc.matchAll(/\[(\d+),/g)].map((m) => Number(m[1]));
    const monotonic = xs.length >= 2 && xs.every((v, i) => i === 0 || v > xs[i - 1]);
    check(monotonic && xs[0] === 0 && xs[xs.length - 1] === 63, `渐变 ${variant} 锚点 x 必须严格递增且钉住 0/63`);
  }
  // 径向锚点表：半径严格递增、钉住 0/181（表被改乱时径向插值静默出错）
  const radialEntries = [...src.matchAll(/^  (blend_gradient(?:_reverse)?): \{ invert: (?:true|false), stops: (\[\[.*?\]\]) \},?$/gm)];
  check(radialEntries.length === 2, `径向锚点表必须 2 条，实得 ${radialEntries.length}`);
  for (const [, variant, stopsSrc] of radialEntries) {
    const xs = [...stopsSrc.matchAll(/\[(\d+),/g)].map((m) => Number(m[1]));
    const monotonic = xs.length >= 8 && xs.every((v, i) => i === 0 || v > xs[i - 1]);
    check(monotonic && xs[0] === 0 && xs[xs.length - 1] === 181, `径向 ${variant} 锚点半径必须严格递增且钉住 0/181`);
  }
  // 接线两处：loadTexInner 的 pkg 缺项分支（ensureLocalAsset 之后）、vendor 出口、
  // local-assets provider。少一处：官方像素或程序化兜底整条断链、静默落白。
  const sm = fs.readFileSync(join(ROOT, "renderer/src/scene-mount.ts"), "utf8");
  const smWiring = [
    [/gtex\.isBuiltinGradientTextureName\(name\)/, "loadTexInner 必须在 pkg 缺项时问内置渐变登记表"],
    [/gtex\.buildBuiltinGradientTexture\(name\)/, "命中登记表必须调 buildBuiltinGradientTexture 生成兜底像素"],
  ];
  for (const [re, msg] of smWiring) check(re.test(sm), `接线：${msg}`);
  check(
    /isBuiltinGradientTextureName[\s\S]{0,400}buildBuiltinGradientTexture[\s\S]{0,700}return null;/.test(sm),
    "渐变兜底必须位于 loadTexInner 缺项分支的 return null 之前",
  );
  const vendor = fs.readFileSync(join(ROOT, "renderer/src/vendor.ts"), "utf8");
  check(/gradient-textures\.js/.test(vendor), "vendor 出口必须引 gradient-textures.js");
  const la = fs.readFileSync(join(ROOT, "renderer/src/local-assets.ts"), "utf8");
  check(/gtex\.setGradientTextureProvider/.test(la), "local-assets 必须给渐变装 provider（本机官方像素覆盖）");
}

await builtinGradients();

// ---------- WE 内置纹样（pattern/voronoi[_local]）：程序化复刻 + 三处接线 ----------
// 官方 `materials/pattern/` 下两张 256² 灰度 Voronoi 图（**不在壁纸 pkg 里**），全库唯一
// 消费方是 watercaustics：`shaders/effects/caustics.frag` 槽 2 默认 `pattern/voronoi_local`
// （主焦散纹样，.r 采 3 次做色散）、槽 5 默认 `pattern/voronoi`（辉光）。缺它两槽落
// whiteTex → 整层焦散退化成纯色（docs/ASSET-AUDIT.md §2 pattern 行 + §6 缺口第 1 条）。
// 复刻规格：docs/replication/pattern-voronoi.spec.md（判据锁「统计锚点 + 周期性 +
// 两图共享几何」，不锁官方像素；合规要求种子按锚点**重新随机**，不照抄官方坐标）。
async function builtinPatterns() {
  const pat = await import(
    pathToFileURL(join(ROOT, "renderer/vendor/we-scene/render/pattern-textures.js")).href
  );
  const SIZE = 256;
  const N = SIZE * SIZE;
  const EXPECTED = ["pattern/voronoi", "pattern/voronoi_local"];

  // ---- 登记表 / 产出契约 ----
  check(
    JSON.stringify(pat.listBuiltinPatternTextureNames()) === JSON.stringify(EXPECTED),
    "内置纹样登记表 = pattern/voronoi + pattern/voronoi_local（官方 materials/pattern 的全部内容）",
  );
  check(
    !pat.isBuiltinPatternTextureName("pattern/nope") &&
      !pat.isBuiltinPatternTextureName("gradient/gradient_fire") &&
      !pat.isBuiltinPatternTextureName("util/white") &&
      !pat.isBuiltinPatternTextureName(null) &&
      !pat.isBuiltinPatternTextureName(undefined),
    "isBuiltinPatternTextureName 必须拒绝未登记名 / 别族名 / null",
  );
  const vor = pat.buildBuiltinPatternTexture("pattern/voronoi");
  const loc = pat.buildBuiltinPatternTexture("pattern/voronoi_local");
  check(!!vor && !!loc, "两张纹样都必须有产出（缺失时 watercaustics 槽 2/5 落白板）");
  check(pat.buildBuiltinPatternTexture("pattern/nope") === null, "未登记名必须返回 null（不吞掉 pkg/其它来源）");
  check(pat.buildBuiltinPatternTexture("pattern/voronoi") === vor, "同名字必须命中缓存（确定性，像素 diff 才可对账）");

  const grayOf = (t) => {
    const g = new Uint8Array(N);
    for (let i = 0; i < N; i++) g[i] = t.rgba[i * 4];
    return g;
  };
  const gv = grayOf(vor);
  const gl = grayOf(loc);
  check(vor.width === SIZE && vor.height === SIZE && loc.width === SIZE && loc.height === SIZE, "两张纹样都必须是 256×256（官方容器实测）");
  {
    let mono = true;
    let alpha = true;
    for (let i = 0; i < N; i++) {
      const o = i * 4;
      if (vor.rgba[o] !== vor.rgba[o + 1] || vor.rgba[o + 1] !== vor.rgba[o + 2]) mono = false;
      if (vor.rgba[o + 3] !== 255) alpha = false;
      const o2 = i * 4;
      if (loc.rgba[o2] !== loc.rgba[o2 + 1] || loc.rgba[o2 + 1] !== loc.rgba[o2 + 2] || loc.rgba[o2 + 3] !== 255) mono = false;
    }
    check(mono && alpha, "两张纹样都必须是纯灰度（R=G=B）+ alpha 全 255（官方实测）");
  }
  // 黄金哈希：生成器常量（种子/公式）一改就红 —— 有意改动时同步更新这两个常量。
  const fnv1a = (u8) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < u8.length; i++) {
      h ^= u8[i];
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  };
  check(fnv1a(gv) === 0x82c5d047, `pattern/voronoi 灰度黄金哈希（实得 0x${fnv1a(gv).toString(16)}，期望 0x82c5d047）`);
  // local 哈希：连续 Lc 模型（2026-09-24 替换离散 L，修 gradMax 132→45）。
  check(fnv1a(gl) === 0x4cef797e, `pattern/voronoi_local 灰度黄金哈希（实得 0x${fnv1a(gl).toString(16)}，期望 0x4cef797e）`);

  // ---- 周期性（规格 §2 的定性特征，验收必查）----
  // 官方两图是**周期化**的 Voronoi 场：把 32 个种子按 256 周期平铺后，环绕 F1 逐像素
  // 解释整张图（官方 corr 0.9994 / 边缘带零违例）；同一组种子算非环绕 F1 只有 0.8679。
  // 复刻必须同语义 —— 否则 REPEAT 平铺会出现接缝（消费方 uv 随 g_Time 无界漂移）。
  const seeds = pat.patternSeeds();
  check(
    Array.isArray(seeds) && seeds.length === 32 && seeds.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)),
    "必须是 32 个有限坐标的种子（官方实测 32 点 Voronoi）",
  );
  const corrOf = (a, b) => {
    let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
    for (let i = 0; i < N; i++) {
      const x = a[i], y = b[i];
      sa += x; sb += y; saa += x * x; sbb += y * y; sab += x * y;
    }
    const ma = sa / N, mb = sb / N;
    return (sab / N - ma * mb) / (Math.sqrt(saa / N - ma * ma) * Math.sqrt(sbb / N - mb * mb));
  };
  const f1Map = (toroidal) => {
    const out = new Float32Array(N);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        let best = Infinity;
        for (const [sx, sy] of seeds) {
          let dx = x - sx;
          let dy = y - sy;
          if (toroidal) {
            dx -= SIZE * Math.round(dx / SIZE);
            dy -= SIZE * Math.round(dy / SIZE);
          }
          const d = dx * dx + dy * dy;
          if (d < best) best = d;
        }
        out[y * SIZE + x] = Math.sqrt(best);
      }
    }
    return out;
  };
  const f1t = f1Map(true);
  const f1n = f1Map(false);
  const modelT = new Float32Array(N);
  const modelN = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    modelT[i] = Math.round(3.0 * f1t[i]);
    modelN[i] = Math.round(3.0 * f1n[i]);
  }
  // 独立重算（本文件自己的环绕实现）必须逐像素命中：既锁公式 v = round(3·F1)，也锁环绕语义。
  let mismatch = 0;
  for (let i = 0; i < N; i++) if (gv[i] !== modelT[i]) mismatch++;
  check(mismatch === 0, `voronoi 必须等于 round(3.0 × 环绕 F1)（独立重算，实得 ${mismatch} 个像素不符）`);
  check(
    corrOf(gv, modelT) - corrOf(gv, modelN) > 0.05,
    `环绕语义必须显著优于非环绕（corr ${corrOf(gv, modelT).toFixed(4)} vs ${corrOf(gv, modelN).toFixed(4)}）`,
  );
  {
    // 边缘带（四周 ±8px）按环绕模型零违例；非环绕模型必须在这里露馅（反例非空 = 判据不恒真）
    const viol = (model) => {
      let bad = 0;
      for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
          if (x >= 8 && x < SIZE - 8 && y >= 8 && y < SIZE - 8) continue;
          if (Math.abs(gv[y * SIZE + x] - model[y * SIZE + x]) > 5) bad++;
        }
      }
      return bad;
    };
    check(viol(modelT) === 0, `边缘带按环绕模型必须零违例（实得 ${viol(modelT)}）`);
    check(viol(modelN) > 50, `反证：非环绕模型必须在边缘带露馅（实得 ${viol(modelN)} 个违例，判据不得恒真）`);
  }

  const statsOf = (g) => {
    let s = 0, s2 = 0, max = 0;
    for (const v of g) { s += v; s2 += v * v; if (v > max) max = v; }
    const m = s / N;
    return { mean: m, sd: Math.sqrt(s2 / N - m * m), max };
  };
  const covAbove = (g, t) => { let c = 0; for (const v of g) if (v > t) c++; return (100 * c) / N; };
  const covBelow = (g, t) => { let c = 0; for (const v of g) if (v <= t) c++; return (100 * c) / N; };

  // ---- pattern/voronoi 锚点（规格 §2.1/§5.3）----
  const sv = statsOf(gv);
  check(sv.max >= 140 && sv.max <= 200, `voronoi 最大值应对齐官方 161（实得 ${sv.max}）`);
  check(Math.abs(sv.mean - 61.84) < 5, `voronoi 均值应对齐官方 61.84（实得 ${sv.mean.toFixed(2)}）`);
  check(Math.abs(sv.sd - 29.45) < 5, `voronoi 标准差应对齐官方 29.45（实得 ${sv.sd.toFixed(2)}）`);
  {
    // 径向剖面（全图像素按环绕 F1 分桶 1.5px 求均值）必须线性、斜率 3.0 灰阶/px
    const nb = 26;
    const sum = new Float64Array(nb), cnt = new Float64Array(nb);
    for (let i = 0; i < N; i++) {
      const k = Math.floor(f1t[i] / 1.5);
      if (k < nb) { sum[k] += gv[i]; cnt[k]++; }
    }
    let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
    for (let k = 0; k < nb; k++) {
      if (cnt[k] < 50) continue;
      const r = k * 1.5, m = sum[k] / cnt[k];
      n++; sx += r; sy += m; sxx += r * r; sxy += r * m; syy += m * m;
    }
    const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    const r2 = ((n * sxy - sx * sy) ** 2) / ((n * sxx - sx * sx) * (n * syy - sy * sy));
    check(slope > 2.8 && slope < 3.2, `voronoi 径向剖面斜率应为 3.0 灰阶/px（实得 ${slope.toFixed(3)}）`);
    check(r2 > 0.995, `voronoi 径向剖面必须严格线性（R²=${r2.toFixed(5)}）`);
  }
  {
    let gmax = 0;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE - 1; x++) {
        const d = Math.abs(gv[y * SIZE + x] - gv[y * SIZE + x + 1]);
        if (d > gmax) gmax = d;
      }
    }
    check(gmax <= 6, `voronoi 是极平滑距离场（水平梯度 max 应 ≈3，实得 ${gmax}）`);
  }

  // ---- pattern/voronoi_local 锚点（规格 §2.2/§5.4）----
  const sl = statsOf(gl);
  // 连续 Lc 平滑后最亮结点零星到 ~249（离散模型 255；仅个别像素、视觉不可分辨）。
  // 用 ≥245 而非精确 255：若连续化导致整体压暗，max 会明显跌出，仍能被抓住。
  check(sl.max >= 245, `local 最亮结点应≈255（实得 ${sl.max}）`);
  check(Math.abs(sl.mean - 35.52) < 4, `local 均值应对齐官方 35.52（实得 ${sl.mean.toFixed(2)}）`);
  check(Math.abs(sl.sd - 52.49) < 6, `local 标准差应对齐官方 52.49（实得 ${sl.sd.toFixed(2)}）`);
  const dark = covBelow(gl, 9);
  check(Math.abs(dark - 56.5) < 4, `local 胞内深黑（≤9）应≈56.5%（实得 ${dark.toFixed(1)}%）`);
  const c64 = covAbove(gl, 64), c128 = covAbove(gl, 128), c200 = covAbove(gl, 200);
  check(Math.abs(c64 - 24.1) < 3, `local >64 覆盖率应≈24.1%（实得 ${c64.toFixed(1)}%）`);
  check(Math.abs(c128 - 9.1) < 2, `local >128 覆盖率应≈9.1%（实得 ${c128.toFixed(1)}%）`);
  check(Math.abs(c200 - 0.62) < 0.25, `local >200 覆盖率应≈0.62%（实得 ${c200.toFixed(2)}%）`);
  {
    // 脊线宽度（水平 run >128 中位 4px、p90 10px）
    const runs = [];
    for (let y = 0; y < SIZE; y++) {
      let run = 0;
      for (let x = 0; x < SIZE; x++) {
        if (gl[y * SIZE + x] > 128) run++;
        else { if (run) runs.push(run); run = 0; }
      }
      if (run) runs.push(run);
    }
    runs.sort((a, b) => a - b);
    const q = (p) => runs[Math.min(runs.length - 1, Math.floor(p * runs.length))];
    check(q(0.5) >= 2 && q(0.5) <= 7, `local 脊线 run>128 中位应≈4px（实得 ${q(0.5)}）`);
    check(q(0.9) >= 5 && q(0.9) <= 16, `local 脊线 run>128 p90 应≈10px（实得 ${q(0.9)}）`);
  }
  // 热点（>200）必须聚成小簇、且全部落在三胞结点上（官方 405 像素 / 37 簇 / 最大 34px²）
  {
    const mask = new Uint8Array(N);
    let hot = 0;
    for (let i = 0; i < N; i++) if (gl[i] > 200) { mask[i] = 1; hot++; }
    const seen = new Uint8Array(N);
    const sizes = [];
    for (let i = 0; i < N; i++) {
      if (!mask[i] || seen[i]) continue;
      const st = [i];
      seen[i] = 1;
      let n = 0;
      while (st.length) {
        const k = st.pop();
        n++;
        const x = k % SIZE, y = (k - x) / SIZE;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const xx = ((x + dx) % SIZE + SIZE) % SIZE;
          const yy = ((y + dy) % SIZE + SIZE) % SIZE;
          const kk = yy * SIZE + xx;
          if (mask[kk] && !seen[kk]) { seen[kk] = 1; st.push(kk); }
        }
      }
      sizes.push(n);
    }
    check(hot >= 200 && hot <= 700, `local >200 热点像素数应≈405（实得 ${hot}）`);
    check(sizes.length >= 20 && sizes.length <= 120, `local 热点必须是小簇（官方 37 簇，实得 ${sizes.length}）`);
    check(Math.max(...sizes) <= 60, `local 最大热点簇应≈34px²（实得 ${Math.max(...sizes)}）`);
  }
  {
    // local 水平梯度守卫（修 gradMax 回归）：离散 L 会在第二近种子切换点产生硬跳变
    // （实测得 gradMax 132，官方仅 43），脊线被打成硬边。连续 Lc 后 gradMax≈45。
    let gmax = 0;
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE - 1; x++) {
      const d = Math.abs(gl[y * SIZE + x] - gl[y * SIZE + x + 1]);
      if (d > gmax) gmax = d;
    }
    check(gmax <= 55, `local 水平梯度 max 应≈官方 43（连续 Lc；实得 ${gmax}）`);
  }

  // ---- 两图共享几何（规格 §2.3 四条证据，全部环绕度量）----
  {
    const bright = [];
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) if (gl[y * SIZE + x] > 128) bright.push([x, y]);
    // ① 种子（voronoi 的 v≈0 黑点）到最近亮脊的距离 ≈ 胞心到边界的量级
    let dmin = Infinity, dmax = 0;
    const ds = [];
    for (const [sx, sy] of seeds) {
      let best = Infinity;
      for (const [bx, by] of bright) {
        let dx = sx - bx, dy = sy - by;
        dx -= SIZE * Math.round(dx / SIZE);
        dy -= SIZE * Math.round(dy / SIZE);
        const d = dx * dx + dy * dy;
        if (d < best) best = d;
      }
      ds.push(Math.sqrt(best));
    }
    ds.sort((a, b) => a - b);
    dmin = ds[0];
    dmax = ds[ds.length - 1];
    check(dmin >= 8 && dmax <= 40, `种子到最近亮脊的距离应≈胞心到边界（官方 12.0..26.9px，实得 ${dmin.toFixed(1)}..${dmax.toFixed(1)}）`);
    // ② voronoi ≈ blur(local)（两趟盒式、半径 16；官方 corr 0.7053）
    const blur = new Float32Array(N);
    {
      const tmp = new Float32Array(N);
      for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
        let s = 0, c = 0;
        for (let d = -16; d <= 16; d++) { const xx = x + d; if (xx < 0 || xx >= SIZE) continue; s += gl[y * SIZE + xx]; c++; }
        tmp[y * SIZE + x] = s / c;
      }
      for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
        let s = 0, c = 0;
        for (let d = -16; d <= 16; d++) { const yy = y + d; if (yy < 0 || yy >= SIZE) continue; s += tmp[yy * SIZE + x]; c++; }
        blur[y * SIZE + x] = s / c;
      }
    }
    const corrBlur = corrOf(Float32Array.from(gv), blur);
    check(corrBlur > 0.4, `两图必须共享几何：corr(voronoi, blur16(local)) 应≈0.7（实得 ${corrBlur.toFixed(4)}）`);
    // ③ 亮/暗像素按环绕 F2−F1 干净分离（官方：>128 的 d2 ≤ 6.48 中位 1.45；<10 的 d2 中位 14.65）
    const f2t = new Float32Array(N);
    const f3t = new Float32Array(N);
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
      let a = Infinity, b = Infinity, c = Infinity;
      for (const [sx, sy] of seeds) {
        let dx = x - sx, dy = y - sy;
        dx -= SIZE * Math.round(dx / SIZE);
        dy -= SIZE * Math.round(dy / SIZE);
        const d = dx * dx + dy * dy;
        if (d < a) { c = b; b = a; a = d; }
        else if (d < b) { c = b; b = d; }
        else if (d < c) c = d;
      }
      f2t[y * SIZE + x] = Math.sqrt(b) - Math.sqrt(a);
      f3t[y * SIZE + x] = Math.sqrt(c) - Math.sqrt(a);
    }
    let bmax = 0, bin = 0;
    let dmed = [];
    let hotMax = 0;
    for (let i = 0; i < N; i++) {
      if (gl[i] > 128) { if (f2t[i] > bmax) bmax = f2t[i]; bin++; }
      if (gl[i] < 10) dmed.push(f2t[i]);
      if (gl[i] > 200) { if (f3t[i] > hotMax) hotMax = f3t[i]; }
    }
    check(bin > 2000 && bmax <= 12, `>128 亮脊必须紧贴胞边界（官方 d2 max 6.48，实得 ${bmax.toFixed(2)}）`);
    dmed.sort((a, b) => a - b);
    check(dmed[Math.floor(dmed.length / 2)] >= 10, `<10 胞内黑应远离边界（官方 d2 中位 14.65，实得 ${dmed[Math.floor(dmed.length / 2)].toFixed(2)}）`);
    // ④ 全部 >200 热点落在三胞结点（官方 F3−F1 max 4.81 < 10）
    check(hotMax < 10, `>200 热点必须全部落在三胞结点（官方 F3−F1 max 4.81，实得 ${hotMax.toFixed(2)}）`);
  }

  // ---- mip 行为（官方 7 级链；本地策略 = mip0 + generateMipmap 的盒式降采样）----
  {
    const chain = (g) => {
      const out = [];
      let cur = Float32Array.from(g);
      let size = SIZE;
      out.push({ mean: cur.reduce((a, b) => a + b, 0) / cur.length, max: Math.max(...cur) });
      while (size > 4) {
        const h = size / 2;
        const next = new Float32Array(h * h);
        for (let y = 0; y < h; y++) for (let x = 0; x < h; x++) {
          next[y * h + x] = (cur[2 * y * size + 2 * x] + cur[2 * y * size + 2 * x + 1] + cur[(2 * y + 1) * size + 2 * x] + cur[(2 * y + 1) * size + 2 * x + 1]) / 4;
        }
        cur = next;
        size = h;
        out.push({ mean: cur.reduce((a, b) => a + b, 0) / cur.length, max: Math.max(...cur) });
      }
      return out;
    };
    const cv = chain(gv), cl = chain(gl);
    check(cv.length === 7 && cl.length === 7, `两条 mip 链都应是 7 级（256→4，官方实测；实得 ${cv.length}/${cl.length}）`);
    const drift = Math.max(...cv.map((m) => Math.abs(m.mean - cv[0].mean)), ...cl.map((m) => Math.abs(m.mean - cl[0].mean)));
    check(drift < 3, `盒式降采样的 mip 链均值必须稳定（官方 61.8→59.8 / 35.5→33.7 同量级，实得最大漂移 ${drift.toFixed(2)}）`);
    check(cl[6].max > 20 && cl[6].max < 120 && cv[6].max < cv[0].max, `最粗一级 mip 不得退化（local 4×4 级 max 应≈42、voronoi≈97，实得 ${cl[6].max.toFixed(0)}/${cv[6].max.toFixed(0)}）`);
  }

  // ---- 合规：种子按锚点重新随机，不照抄官方坐标 ----
  // 官方 32 个种子坐标的实测表留在规格 §2.3（docs/replication/pattern-voronoi.spec.md），
  // 复刻不得逐坐标搬运 —— 这里直接读规格里的表做最小间距断言。
  {
    const specPath = join(ROOT, "docs/replication/pattern-voronoi.spec.md");
    if (!fs.existsSync(specPath)) {
      console.log("  （跳过官方种子间距检查：没有 " + specPath + "）");
    } else {
      const table = [...fs.readFileSync(specPath, "utf8").matchAll(/\((\d+),(\d+),\d+\)/g)].map((m) => [Number(m[1]), Number(m[2])]);
      check(table.length === 32, `规格 §2.3 的官方种子表应能解出 32 个坐标（实得 ${table.length}）`);
      let minDist = Infinity;
      for (const [mx, my] of seeds) {
        for (const [ox, oy] of table) {
          let dx = Math.abs(mx - ox), dy = Math.abs(my - oy);
          if (dx > SIZE / 2) dx = SIZE - dx;
          if (dy > SIZE / 2) dy = SIZE - dy;
          const d = Math.hypot(dx, dy);
          if (d < minDist) minDist = d;
        }
      }
      check(minDist >= 3, `复刻种子必须重新随机（与官方种子表最小间距 ≥3px，实得 ${minDist.toFixed(2)}px）`);
    }
  }

  // ---- 接线三处：loadTexInner 兜底（pkg 缺项分支的 return null 之前）、vendor 出口、
  //      local-assets provider。少一处：官方像素或程序化兜底整条断链、静默落白。----
  const sm = fs.readFileSync(join(ROOT, "renderer/src/scene-mount.ts"), "utf8");
  check(/patTex\.isBuiltinPatternTextureName\(name\)/.test(sm), "接线：loadTexInner 必须在 pkg 缺项时问内置纹样登记表");
  check(/patTex\.buildBuiltinPatternTexture\(name\)/.test(sm), "接线：命中登记表必须调 buildBuiltinPatternTexture 生成兜底像素");
  check(
    (() => {
      // 「缺项分支」= ensureLocalAsset 起、到该分支第一个 return null 止的那段兜底链
      // （ptex → patTex → gtex）。按结构切片而不是量字符宽度：块变长不该误报。
      const start = sm.indexOf("await ensureLocalAsset(name)");
      const end = sm.indexOf("return null;", start);
      if (start < 0 || end < 0) return false;
      const chain = sm.slice(start, end);
      return /patTex\.isBuiltinPatternTextureName\(name\)/.test(chain) && /patTex\.buildBuiltinPatternTexture\(name\)/.test(chain);
    })(),
    "纹样兜底必须位于 loadTexInner 缺项分支的 return null 之前（与 ptex/gtex 同一条兜底链）",
  );
  check(
    /buildBuiltinPatternTexture[\s\S]{0,600}wrap: "repeat"/.test(sm),
    "纹样注册必须 REPEAT 环绕（官方 flags bit1=0 / clampuvs:false；CLAMP 下 uv 漂移被拉成边缘行）",
  );
  check(/clampUvs: false/.test(sm), "纹样 entry 必须带 clampUvs:false（效果链槽位据此选 REPEAT）");
  const vendor = fs.readFileSync(join(ROOT, "renderer/src/vendor.ts"), "utf8");
  check(/pattern-textures\.js/.test(vendor) && /patTex/.test(vendor), "vendor 出口必须引 pattern-textures.js 并导出 patTex");
  const la = fs.readFileSync(join(ROOT, "renderer/src/local-assets.ts"), "utf8");
  check(/patTex\.setPatternTextureProvider/.test(la), "local-assets 必须给纹样装 provider（本机官方像素覆盖）");
}

await builtinPatterns();

console.log(failed === 0 ? "\nverify-textures: 全部通过 ✓" : `\nverify-textures: ${failed} 项失败 ✗`);
process.exit(failed === 0 ? 0 : 1);
