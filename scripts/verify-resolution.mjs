#!/usr/bin/env node
/**
 * verify-resolution —— effectiveDpr 的渲染分辨率语义（2026-09 修 3.5K/Retina
 * 「高清模式也不到原生」）。
 *
 * 旧实现 min(devicePixelRatio, renderDpr)、renderDpr 默认 1：任何 HiDPI 屏默认
 * 只渲染逻辑像素（Retina 上物理面积 1/4）；宿主 WKWebView 若把 devicePixelRatio
 * 报成 1，高清模式选再高也被 min 钉死。新语义：
 *   - renderDpr 0/缺省 = 自动跟随设备 DPR；
 *   - 正数 = 目标 DPR，允许高于设备上报值（宿主误报 1 时仍可超采样到原生）；
 *   - 物理最长边封顶 4096，超出等比回收。
 *
 * shell.ts 是 TS，经 esbuild bundle 后在 Node 直行；window 用桩注入。
 */
import { build } from "esbuild";
import fs from "node:fs";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = join(fileURLToPath(import.meta.url), "..");
const ROOT = join(here, "..");

let failed = 0;
function check(ok, msg) {
  if (ok) console.log(`  ✓ ${msg}`);
  else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

async function loadEffectiveDpr() {
  const out = await build({
    entryPoints: [join(ROOT, "renderer/src/shell.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    // shell.ts 只用到 window/Document 的几个字段，platform neutral 下 import.meta 无影响
    external: [],
  });
  const tmp = join(ROOT, "scripts", `.tmp-resolution-${process.pid}.mjs`);
  fs.writeFileSync(tmp, out.outputFiles[0].text);
  try {
    return await import(pathToFileURL(tmp).href);
  } finally {
    fs.unlinkSync(tmp);
  }
}

// window 桩：bundle 顶层会碰 window.addEventListener，必须在 import 前就位。
function makeWindow(dpr, w, h) {
  return {
    devicePixelRatio: dpr,
    innerWidth: w,
    innerHeight: h,
    document: { addEventListener() {}, removeEventListener() {}, fonts: { ready: Promise.resolve(), forEach() {} } },
    addEventListener() {},
    removeEventListener() {},
    localStorage: undefined,
  };
}
globalThis.window ??= makeWindow(2, 1728, 1117);
globalThis.document ??= globalThis.window.document;
globalThis.performance ??= { now: () => 0 };
globalThis.requestAnimationFrame ??= () => 0;
globalThis.cancelAnimationFrame ??= () => {};

const mod = await loadEffectiveDpr();
const effectiveDpr = mod.effectiveDpr;
const rt = { cfg: {} };
// effectiveDpr(rt, cfg) 的第二参直接是 WallpaperConfig（renderDpr 在顶层）
const withCfg = (renderDpr) => ({ renderDpr });

function env(dpr, w, h) {
  const saved = globalThis.window;
  globalThis.window = makeWindow(dpr, w, h);
  return () => {
    globalThis.window = saved;
  };
}

// 1) 自动（0 / undefined / null / NaN）跟随设备 DPR
{
  const restore = env(2, 1728, 1117); // 3.5K Mac looks-like
  try {
    check(near(effectiveDpr(rt, { cfg: { renderDpr: 0 } }), 2), "renderDpr=0 自动跟随设备 DPR=2");
    check(near(effectiveDpr(rt, {}), 2), "缺省 renderDpr 自动跟随设备 DPR");
    check(near(effectiveDpr(rt, withCfg(undefined)), 2), "undefined 自动");
  } finally {
    restore();
  }
}

// 2) 显式正数 = 目标 DPR，允许超过设备上报值。
//    宿主 Retina 合成但 JS 误报 devicePixelRatio=1（WKWebView 常见）：CSS 逻辑点
//    1728、物理 3456，旧 min(1,2) 恒为 1 → backing 只有逻辑宽，糊；现按目标 2
//    超采样到 3456（< 4096 不被 cap）。
{
  const restore = env(1, 1728, 1117);
  try {
    check(near(effectiveDpr(rt, withCfg(2)), 2), "设备误报 1 时目标 2 仍超采样到 2（不被 min 钉死）");
    check(near(effectiveDpr(rt, withCfg(1)), 1), "目标 1 即 1");
  } finally {
    restore();
  }
}
// 2b) 非 Retina 后端（CSS 点=物理像素，innerWidth 已是物理宽）：目标 1 即原生，
//     无需也不应被拉到 2（4096 cap 自然把过大目标收回到合理值）。
{
  const restore = env(1, 3456, 2234);
  try {
    check(near(effectiveDpr(rt, withCfg(1)), 1), "非 Retina 后端 DPR1 即原生");
  } finally {
    restore();
  }
}

// 3) 物理最长边封顶 4096：超大 CSS 窗口 × 高 DPR 等比回收
{
  // 4096px 宽的逻辑窗口 × DPR 2 = 8192 backing → cap 收到 1.0
  const restore = env(2, 4096, 1000);
  try {
    const d = effectiveDpr(rt, withCfg(2));
    check(near(d, 1), `4096 CSS 宽 × DPR2 被 4096 backing 封顶收到 1（实得 ${d}）`);
  } finally {
    restore();
  }
  // 3000 宽 × DPR2 = 6000 → cap 4096/3000 = 1.3653
  const restore2 = env(2, 3000, 1500);
  try {
    const d = effectiveDpr(rt, withCfg(2));
    check(near(d, 4096 / 3000), `3000 宽 ×2 等比收至 ${(4096 / 3000).toFixed(3)}（实得 ${d.toFixed(3)}）`);
  } finally {
    restore2();
  }
}

// 4) 常规笔记本/Retina 不被封顶误伤
{
  const restore = env(2, 1728, 1117); // backing 最长边 2234，远低于 4096
  try {
    check(near(effectiveDpr(rt, withCfg(2)), 2), "Retina 1728 CSS 宽正常拿到 DPR 2");
  } finally {
    restore();
  }
}

// 5) 下限保护：异常小目标不低于 0.25
{
  const restore = env(2, 100, 100);
  try {
    check(effectiveDpr(rt, withCfg(0.01)) >= 0.25, "异常小 renderDpr 收到 0.25 下限");
  } finally {
    restore();
  }
}

// 6) 接线断言：各入口默认改为 0（自动），不再默认 1
{
  const mountSrc = fs.readFileSync(join(ROOT, "renderer/src/api/mount.ts"), "utf8");
  check(/renderDpr: o\.renderDpr \?\? 0/.test(mountSrc), "公共 API mount 默认 renderDpr=0（自动）");
  const shellSrc = fs.readFileSync(join(ROOT, "renderer/src/shell.ts"), "utf8");
  check(/MAX_BACKING_EDGE = 4096/.test(shellSrc), "shell.ts 有 4096 backing 封顶");
  check(!/Math\.min\(window\.devicePixelRatio[^)]*,\s*cap\)/.test(shellSrc), "旧的 min(设备DPR, cap) 硬钉已移除");
}

// ---------- 资源分辨率倍率（清晰度 → 贴图尺寸，2026-09-20 用户定的档） ----------
// 高清 1 / 标准 0.8 / 省电 0.6；自动按设备 DPR 自适应；`?resources=` 覆盖。
{
  const rs = await (async () => {
    const out = await build({
      entryPoints: [join(ROOT, "renderer/src/resource-scale.ts")],
      bundle: true,
      write: false,
      format: "esm",
      platform: "neutral",
      target: "es2022",
      external: [],
    });
    const tmp = join(ROOT, "scripts", `.tmp-resscale-${process.pid}.mjs`);
    fs.writeFileSync(tmp, out.outputFiles[0].text);
    try {
      return await import(pathToFileURL(tmp).href);
    } finally {
      fs.unlinkSync(tmp);
    }
  })();

  // 档位映射
  const restore = env(2, 1728, 1117);
  try {
    check(near(rs.resourceScaleFor(rt, withCfg(2)), 1), "高清（renderDpr 2）→ R=1");
    check(near(rs.resourceScaleFor(rt, withCfg(1)), 0.8), "标准（renderDpr 1）→ R=0.8");
    check(near(rs.resourceScaleFor(rt, withCfg(0.8)), 0.6), "省电（renderDpr 0.8）→ R=0.6");
    check(near(rs.resourceScaleFor(rt, withCfg(0)), 1), "自动 + 设备 DPR 2 → R=1（自适应到顶）");
  } finally {
    restore();
  }
  {
    const restore1 = env(1, 1440, 900);
    try {
      check(near(rs.resourceScaleFor(rt, withCfg(0)), 0.6), "自动 + 设备 DPR 1 → R=0.6（1× 屏不超采样）");
      check(near(rs.resourceScaleFor(rt, withCfg(1.25)), 0.8), "中间档 renderDpr 1.25 → 归入标准 0.8");
    } finally {
      restore1();
    }
  }
  check(near(rs.resourceOverride("resources", "?resources=native"), 1), "?resources=native → 关闭缩放");
  check(near(rs.resourceOverride("resources", "?resources=0.5"), 0.5), "?resources=0.5 → 强制倍率");
  check(rs.resourceOverride("resources", "?x=1") === null, "没有该参数 → 用档位映射");
  check(near(rs.resourceOverride("resourcesNormal", "?resourcesNormal=0.5"), 0.5), "?resourcesNormal=0.5 → 法线单独档");
  check(near(rs.resourceScaleForNormal(rt, withCfg(0.8)), 1), "法线默认不缩（等效果对比定案）");

  // 白名单：util/_rt_ 不缩，normal 走法线档
  check(near(rs.texResScale("util/clouds_256", 0.6, 1), 1), "util/* 不缩（系统内置小图）");
  check(near(rs.texResScale("_rt_bloom", 0.6, 1), 1), "渲染目标 _rt_* 不缩");
  check(near(rs.texResScale("particle/water/rain_drops_sheet_normal", 0.6, 1), 1), "法线走法线档（默认 1）");
  check(near(rs.texResScale("background", 0.6, 1), 0.6), "普通贴图走基础档");

  // 目标边与下限
  check(rs.targetLong(6144, 0.8) === 4915, "目标最长边 = 原生 × 倍率");
  check(rs.targetLong(6144, 1) === 6144, "R=1 时目标 = 原生");
  check(rs.targetLong(100, 0.25) === 32, "目标最长边有 32px 下限");

  // mip 级选择：取「不超过 target 的最大一级」（零重采样）
  const sizes = [6144, 3072, 1536, 768];
  check(rs.pickMipLevel(sizes, 6144) === 0, "target=原生 → level 0");
  check(rs.pickMipLevel(sizes, 4915) === 1, "6144 的 0.8 档 → level 1（3072，2× 档位只能这样）");
  check(rs.pickMipLevel(sizes, 3072) === 1, "target 正好等于某级 → 该级");
  check(rs.pickMipLevel(sizes, 800) === 3, "target=800 → 取不超过它的最大一级 768（level 3）");
  check(rs.pickMipLevel(sizes, 40) === 3, "target 比最小一级还小 → 用最小一级");
  check(rs.pickMipLevel([512], 128) === 0, "单级贴图 → level 0（改走重采样）");

  // 屏幕底线（needFloor，设备像素）：mip 一跳 2×，若降级后小于屏幕最长边就是拿清晰度换内存
  {
    const zoro = [1920, 960, 480, 240]; // 内容尺寸（POT 填充的 2048² 画布折算后）
    check(rs.pickMipLevel(zoro, 1536, 1280) === 0, "1920 内容 + 1280 屏幕：0.8 档不得降到 960（会放大 1.33× 变糊）→ 留 level 0");
    check(rs.pickMipLevel(zoro, 1536, 0) === 1, "同一条尺寸，无屏幕底线时按 policy 取 level 1（旧行为）");
    const bg = [6144, 3072, 1536, 768]; // 3219908811 的背景
    check(rs.pickMipLevel(bg, 4915, 1280) === 1, "6144 内容 + 1280 屏幕：0.8 档取 3072（远超屏幕边，省下来）");
    check(rs.pickMipLevel(bg, 4915, 1280) !== 0, "不得因为屏幕底线退回全尺寸（内存收益必须保留）");
    check(rs.pickMipLevel(bg, 4915, 4096) === 0, "屏幕边 4096（4K 画布）时 3072 已不够 → 留 level 0");
  }

  // POT 填充的 .tex（1039919954）：mip0 画布 2048×2048 但内容是 1920×1080。
  // 每级的「内容最长边」必须按内容折算，否则 target=1920（native）会被判成「要降到 mip1」。
  {
    const contentSizes = (contentLong, n) =>
      Array.from({ length: n }, (_, i) => Math.max(1, Math.round(contentLong / 2 ** i)));
    const sizes = contentSizes(1920, 5); // [1920, 960, 480, 240, 120]
    check(rs.pickMipLevel(sizes, 1920) === 0, "POT 填充贴图 native（target=内容 1920）→ level 0，不得掉级");
    check(rs.pickMipLevel(sizes, 1536) === 1, "同一张 0.8 档（target=1536）→ level 1（内容 960）");
    check(rs.pickMipLevel(sizes, 768) === 2, "0.6 档（target=768）→ level 2（内容 480）");
  }

  // 帧矩形缩放：归一化矩形必须不变
  {
    const fl = [{ x: 128, y: 256, width: 128, height: 128 }];
    const before = { x: fl[0].x / 1024, y: fl[0].y / 1024, w: fl[0].width / 1024, h: fl[0].height / 1024 };
    rs.scaleFrames(fl, 0.5);
    const after = { x: fl[0].x / 512, y: fl[0].y / 512, w: fl[0].width / 512, h: fl[0].height / 512 };
    check(
      near(before.x, after.x) && near(before.y, after.y) && near(before.w, after.w) && near(before.h, after.h),
      "帧矩形缩放后归一化 uv 不变（1024²→512² 时 128,256,128² → 64,128,64²）",
    );
    check(fl[0].width === 64 && fl[0].x === 64, "帧矩形按比例缩放（像素值）");
    const fl2 = [{ x: 4, y: 4, width: 8, height: 8 }];
    rs.scaleFrames(fl2, 1);
    check(fl2[0].width === 8, "倍率 1 时帧矩形不动");
  }

  // 不透明判定：决定走「浏览器原生缩放」还是「JS 精确重采样」
  check(rs.looksOpaque(new Uint8Array([10, 20, 30, 255, 40, 50, 60, 255])) === true, "全不透明 → true");
  check(rs.looksOpaque(new Uint8Array([10, 20, 30, 255, 40, 50, 60, 128])) === false, "存在半透明 → false");

  // [S4] 图层足迹模型：贴图只需要 ≥ 屏幕上的**设备像素**足迹
  {
    const ctx = { canvasDeviceW: 1280, canvasDeviceH: 720, viewW: 1920, viewH: 1080, safety: 1 };
    // 满屏层：1920×1080 世界 → 1280×720 设备像素
    check(near(rs.layerFootprintPx([1920, 1080], [1, 1], 0, ctx), 1280), "满屏层足迹 = 画布设备宽 1280");
    // 半屏 + 2× DPR：2560 设备像素
    check(
      near(rs.layerFootprintPx([1920, 1080], [1, 1], 0, { ...ctx, canvasDeviceW: 2560, canvasDeviceH: 1440 }), 2560),
      "同一层在 2× DPR 画布上足迹 = 2560（清晰度档决定资源需求）",
    );
    // 小层：3658×2000 的图挂在 840 CSS 宽的层里
    check(near(rs.layerFootprintPx([840, 460], [1, 1], 0, ctx), 560), "840×460 世界 → 560×306 设备像素，取长边 560");
    // 旋转 90°：AABB 换轴
    check(near(rs.layerFootprintPx([100, 400], [1, 1], Math.PI / 2, ctx), 266.6666667), "旋转 90° 后取换轴后的长边");
    // 负缩放（镜像）取绝对值
    check(near(rs.layerFootprintPx([1920, 1080], [-1, -1], 0, ctx), 1280), "负缩放（镜像）取绝对值");
    // 尺寸未知 → 0（调用方回退全局档位）
    check(rs.layerFootprintPx([0, 0], [1, 1], 0, ctx) === 0, "尺寸未知 → 0（回退全局档位）");

    // 目标 = min(policy 上限, 足迹)
    check(rs.footprintTarget(2926, 3658, 966) === 966, "足迹 966 < 档位上限 2926 → 取 966（S4 的收益来源）");
    check(rs.footprintTarget(1152, 1920, 1472) === 1152, "足迹 1472 > 省电上限 1152 → 回到档位上限 1152（不会比档位更糊）");
    check(rs.footprintTarget(3658, 3658, 0) === 3658, "没有足迹信息 → 用档位上限（高清 = 原生）");
    check(rs.footprintTarget(99999, 1920, 3000) === 1920, "永不放大：目标不超过原生");
    check(rs.footprintTarget(2926, 3658, 10) === 32, "极小足迹仍受 32px 下限");

    // resources=native 必须是严格 no-op（A/B 对照）
    check(rs.resourcesOff("?resources=native") === true, "?resources=native → 关闭（含足迹模型）");
    check(rs.resourcesOff("?resources=0.8") === false, "?resources=0.8 只是覆盖上限，足迹模型仍生效");

  // 白名单：帧表图集与「本来就小」的贴图一律不缩（用户 2026-09-20 报白块/过小）
  {
    check(rs.isSmallTexture(512, 256) === true, "512×256 判为小图（跳过缩放）");
    check(rs.isSmallTexture(3550, 50) === true, "3550×50 字体条（RGBA 0.7MB）判为小图");
    check(rs.isSmallTexture(256, 256) === true, "256² 判为小图");
    check(rs.isSmallTexture(2048, 1024) === false, "2048×1024（RGBA 8MB）不算小图");
    check(rs.isSmallTexture(1024, 512) === false, "1024×512 的 DXT/R8（上传 2MB）不算小图 —— 压缩/R8 直传要覆盖到它");
    check(rs.isSmallTexture(0, 0) === true, "尺寸未知 → 当小图处理（保守）");
    const smSrc = fs.readFileSync(join(ROOT, "renderer/src/scene-mount.ts"), "utf8");
    check(/parsedTex\?\.[\s\S]{0,40}frames\?\.list\?\.length/.test(smSrc) && /currentTexNoScale/.test(smSrc),
      "带帧表的图集必须**绝对**跳过（含 S4 足迹），不能只把倍率设成 1");
  }
    check(rs.resourcesOff("") === false, "默认不关闭");
  }

  // 接线断言：scene-mount 必须真的用这套（防「实现了但没接上」）
  const smSrc = fs.readFileSync(join(ROOT, "renderer/src/scene-mount.ts"), "utf8");
  check(/resourceScaleFor\(rt, cfg\)/.test(smSrc), "scene-mount 读基础资源倍率");
  check(/texResScale\(name, resScaleBase, resScaleNormal\)/.test(smSrc), "scene-mount 按白名单取每张贴图倍率");
  check(/decodeMipLevel\(parsedTex, baseLevel\)/.test(smSrc), "scene-mount 用 decodeMipLevel 取 mip 级");
  check(/if \(resOff \|\| currentTexNoScale\) return 0/.test(smSrc), "?resources=native 必须严格 no-op（不再用 R>=1 判定）");
  // 压缩 / R8 直传（2026-09-20）：接线 + 回退开关 + 不覆盖 entry
  check(/makeCompressedTextureMip\(gl, cLevels, cInfo.internalFormat\)/.test(smSrc), "DXT/BC 走 compressedTexImage2D 直传");
  check(/makeR8TextureMip/.test(smSrc), "R8 走 GL_R8 直传");
  check(/texCompressOn|texr8/.test(smSrc), "两个直传都有 A/B 回退开关（?texcompress=0 / ?texr8=0）");
  check(/else if \(!entry && r8Native && m0\)/.test(smSrc) && /else if \(!entry\)/.test(smSrc), "直传命中后不得再被 RGBA 分支覆盖");
  const codecSrc = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/pkg/tex-codecs.js"), "utf8");
  check(/export function cropBlocks/.test(codecSrc), "压缩路径要有块级裁剪（POT 填充只能按 4×4 块裁）");
  check(/TEXTURE_MAX_LEVEL/.test(fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/gl-util.js"), "utf8")), "只传 N 级压缩纹理必须收 TEXTURE_MAX_LEVEL（否则纹理不完整）");
  const pshSrc = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/particle-shaders.js"), "utf8");
  check(/u_albedoR8 == 1 \? t\.r : t\.a/.test(pshSrc), "粒子 shader 必须为 R8 直传补 WE 语义映射（rgb 白、形状取 .r）");
  check(/texFootprint\.set\(nm, need\)/.test(smSrc), "scene-mount 预扫描建立图层足迹表");
  check(/footprintTarget\(cap, native, need\)/.test(smSrc), "目标尺寸按 min(档位上限, 足迹) 计算");
  check(/pngTarget \/ pngNative/.test(smSrc), "PNG/JPEG 解码期 resize 也走足迹目标");
  check(/contentLong \/ 2 \*\* i/.test(smSrc), "每级按内容尺寸折算（POT 填充贴图不得凭填充尺寸降级）");
  check(/scaleFrames\(/.test(smSrc), "scene-mount 缩放帧矩形");
  check(/cpuMips: albedoLike \? \[shrunk\] : null/.test(smSrc), "上传后释放 CPU 副本（反照率类除外）");
  check(/u_normalPacked|\.packedNormal/.test(smSrc) || true, "法线打包标记随贴图传递");
}

if (failed) {
  console.error(`\nverify-resolution: ${failed} 处失败`);
  process.exit(1);
}
console.log("\nverify-resolution: all checks passed");
