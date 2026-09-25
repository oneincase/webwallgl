#!/usr/bin/env node
/**
 * verify-bake —— 贴图烘焙（B3）的离线判据：键的稳定性、判定逻辑、关键不变量。
 *
 * 烘焙会在**用户背后**改加载路径，判据盯的是三条安全前提：
 *   ① 命中路径必须**不做预乘解码** —— 漏了 `premultiplyAlpha:"none"` 会把半透明
 *      像素乘一次，1~2px 细线变深色刻线（3264246690 实测踩过，见 tex-decode.ts 头注）；
 *   ② 缓存键必须随「壁纸 / 贴图内容 / 资源档位」变，随窗口尺寸**不变**（否则缩放窗口
 *      就全量重烘）；版本号在路径里，升版本要能自然失效旧键；
 *   ③ 烘焙队列必须在**首帧之后**才开跑 —— 编码 PNG 的开销不许拖慢本次加载
 *      （那笔钱服务的是下一次加载）。
 *
 * 像素等价本身在真浏览器侧校验（scripts/bake/run.mjs 的 FBO 读回比对），
 * 这里只管纯逻辑与不变量 —— 两者合起来才是「烘焙不改画面」的完整证据。
 */
import fs from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, createChecker } from "./lib/verify-kit.mjs";

const { check, errors } = createChecker({ echo: true });

// bake-cache.ts 是 TS：用 esbuild 现编一份（与 verify-quality-auto 同套路）
const { build } = await import("esbuild");
const out = await build({
  entryPoints: [join(ROOT, "renderer/src/bake-cache.ts")],
  bundle: true,
  write: false,
  format: "esm",
  platform: "neutral",
  target: "es2022",
});
const tmp = join(ROOT, "scripts", `.tmp-bake-${process.pid}.mjs`);
fs.writeFileSync(tmp, out.outputFiles[0].text);
let B;
try {
  B = await import(pathToFileURL(tmp).href);
} finally {
  fs.unlinkSync(tmp);
}

// ---- ① 判定逻辑：只在「确实能省」时烘
{
  check(B.shouldBakeEmbedded({ enabled: true, scale: 0.5, nativeLong: 2048, srcBytes: 1 << 20 }).bake, "常规情况（大图 + 目标更小）应烘");
  check(!B.shouldBakeEmbedded({ enabled: false, scale: 0.5, nativeLong: 2048, srcBytes: 1 << 20 }).bake, "bake:false 必须整段不烘");
  check(!B.shouldBakeEmbedded({ enabled: true, scale: 1, nativeLong: 2048, srcBytes: 1 << 20 }).bake, "目标尺寸未变小 → 不烘（预缩放不省解码）");
  check(!B.shouldBakeEmbedded({ enabled: true, scale: 0.5, nativeLong: 256, srcBytes: 1 << 20 }).bake, "原图太小 → 不烘（解码本来就便宜）");
  check(!B.shouldBakeEmbedded({ enabled: true, scale: 0.5, nativeLong: 2048, srcBytes: 1024 }).bake, "原字节太少 → 不烘");
  check(B.shouldBakeEmbedded({ enabled: true, scale: 0.99, nativeLong: 2048, srcBytes: 1 << 20 }).bake, "缩一点点也该烘（0.99 < 0.999）");
  for (const d of [B.shouldBakeEmbedded({ enabled: false, scale: 0.5, nativeLong: 2048, srcBytes: 1 << 20 })]) {
    check(typeof d.reason === "string" && d.reason.length > 0, "不烘的理由必须可读（宿主排查用）");
  }
}

// ---- ② 键：随内容/档位变，随窗口尺寸不变（键里根本没有窗口尺寸）
{
  const base = { wallKey: "/media/dev/1234", texName: "materials/bg.png", srcBytes: new Uint8Array([1, 2, 3, 4, 5]), tier: 0.6 };
  const k = B.bakeCacheKey(base);
  check(B.bakeCacheKey(base) === k, "同输入必须得到同一键（否则缓存永远不命中）");
  check(k.startsWith(`bake3/v${B.BAKE_VERSION}/`), `键必须带版本前缀（升版本能自然失效）：${k}`);
  check(B.bakeCacheKey({ ...base, tier: 0.8 }) !== k, "资源档位变了必须换键（目标尺寸不同）");
  check(B.bakeCacheKey({ ...base, texName: "materials/other.png" }) !== k, "贴图名变了必须换键");
  check(B.bakeCacheKey({ ...base, wallKey: "/media/dev/9999" }) !== k, "壁纸变了必须换键");
  check(B.bakeCacheKey({ ...base, srcBytes: new Uint8Array([1, 2, 3, 4, 6]) }) !== k, "贴图内容变了必须换键");
  check(!/win|w=|h=|size|dpr/i.test(k), `键里不该出现窗口/尺寸相关字段（否则缩放窗口就重烘）：${k}`);
  // 指纹：首尾与长度参与
  check(B.quickHash(new Uint8Array([1, 2, 3])) !== B.quickHash(new Uint8Array([1, 2, 4])), "末字节不同 → 指纹不同");
  check(B.quickHash(new Uint8Array([1, 2, 3])) !== B.quickHash(new Uint8Array([9, 2, 3])), "首字节不同 → 指纹不同");
  check(B.quickHash(new Uint8Array([1, 2, 3])) !== B.quickHash(new Uint8Array([1, 2, 3, 0])), "长度不同 → 指纹不同");
  const big = new Uint8Array(20000).fill(7);
  const big2 = big.slice();
  big2[19999] = 9;
  check(B.quickHash(big) !== B.quickHash(big2), "尾部 4KB 内的变化要能识别");
  const big3 = big.slice();
  big3[15000] = 9;
  check(B.quickHash(big) === B.quickHash(big3), "（已知取舍）中段变化不参与指纹 —— 由「壁纸+贴图名+长度」共同兜住，缓存仅做加速不做真源");
}

// ---- ③ 不变量：源码守卫（函数搬家时必须跟着更新）
{
  const sm = fs.readFileSync(join(ROOT, "renderer/src/scene-mount.ts"), "utf8");
  check(/premultiplyAlpha: "none"/.test(sm), "命中路径必须带 premultiplyAlpha:'none'（否则半透明像素被预乘，细线变刻线）");
  check(/cfg\.bake !== false/.test(sm), "烘焙开关必须接到 cfg.bake（默认开、可关）");
  // 队列开跑必须在**纹理装配之后**（不许在加载期抢主线程）。用装配完成点比用
  // rAF 更稳：`requestAnimationFrame(renderLoop)` 在源里出现多次（暂停/恢复路径都有）。
  const arm = sm.indexOf("bakeQueue.arm()");
  const assembled = sm.indexOf("await Promise.all(texJobs)");
  check(arm > 0 && assembled > 0 && arm > assembled, "bakeQueue.arm() 必须在纹理装配完成之后（不许在加载期编码）");
  // 未命中必须仍走现状解码路径
  check(/decodeTexImageBitmap\(/.test(sm), "未命中路径必须保留 decodeTexImageBitmap（现状语义）");
  check(/bitmapToPngBlob\(/.test(sm), "未命中路径必须排进后台烘焙");
  // ④ 正式统计字段：__memStats().bake 是宿主唯一的结构化台账，必须齐：
  //    enabled/backend（开关与后端如实报）、hits/misses（命中率）、baked/failed/bytes/ms（后台补烘）
  const memStats = sm.slice(sm.indexOf("__memStats"));
  for (const f of ["enabled", "backend", "hits", "misses", "baked", "failed", "bytesMB", "ms"]) {
    check(new RegExp(`\\b${f}\\b`).test(memStats), `__memStats().bake 必须带 ${f}（宿主排查/统计要用）`);
  }
  // 计数必须真的在命中/未命中路径上累加（不是只在装配期初始化成 0）
  check(/bakeStats\.hits\+\+/.test(sm), "命中路径必须累加 hits");
  check(/bakeStats\.misses\+\+/.test(sm), "未命中路径必须累加 misses");
  check(/bakeStats\.baked\+\+/.test(sm), "补烘成功必须累加 baked");
  // 单一来源：诊断文本与 memStats 都读 bakeStats，不许各记各的
  check(/\$\{bakeStats\.hits\}/.test(sm) && /\$\{bakeStats\.misses\}/.test(sm), "diag 文本必须读 bakeStats（与 memStats 同源）");
}

console.log(errors.length === 0 ? "\nverify-bake: 全部通过 ✓" : `\nverify-bake: ${errors.length} 项失败 ✗`);
process.exit(errors.length === 0 ? 0 : 1);
