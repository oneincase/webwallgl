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
  // 烟/雾紧凑窗：半径 0.75 外零 alpha，且不是稀到看不见
  for (const n of ["particle/smoke/smoke2", "particle/fog/fog1"]) {
    const t = ptex.buildBuiltinParticleTexture(n);
    const W = t.width, rgba = t.rgba;
    let outer = 0, mean = 0;
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
      const a = rgba[(y * W + x) * 4 + 3];
      mean += a;
      const d = Math.hypot(x + 0.5 - W / 2, y + 0.5 - W / 2) / (W / 2);
      if (d > 0.75 && a > outer) outer = a;
    }
    mean /= W * W;
    check(outer === 0, `${n} 半径 0.75 外 alpha 必须为 0（方块裙边）`);
    check(mean > 0.3 && mean < 12, `${n} 平均 alpha=${mean.toFixed(2)} 应在 0.3~12（过稀/过浓）`);
  }
}

console.log(failed === 0 ? "\nverify-textures: 全部通过 ✓" : `\nverify-textures: ${failed} 项失败 ✗`);
process.exit(failed === 0 ? 0 : 1);
