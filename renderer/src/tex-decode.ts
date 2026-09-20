// .tex 内嵌图片（freeImage JPEG/PNG）的解码辅助。
// [we-scene patch] WE 桌面端用 FreeImage 解 .tex 内嵌 JPEG，**不执行 EXIF 方向**，
// 场景里层的 size / angles 都是作者按「存储像素」设计的。浏览器的
// `createImageBitmap` 默认 `imageOrientation: "from-image"`，会把带 EXIF 方向的
// JPEG 预先转正 —— 1920911984（orientation=8 的 1080×5760 长图）被转成
// 5760×1080，与层 size 1080×5760 和 90° 层旋转彻底错轴，整屏撕成横向条带
// （实测画布行/列梯度比 ~20:1；剥掉 EXIF 后同一比特流 0.90）。
// 修法：请求 `imageOrientation: "none"`；引擎不支持该选项（或未按声明尺寸返回、
// 宽高互换）时，按 EXIF 方向手工反转回存储像素。只处理 90° 族（6/8，互换尺寸可
// 检测）：180°/镜像不换尺寸、无法与「未应用 EXIF」区分，且 FreeImage 本就不转，
// 保持原样。5/7（转置族）按 6/8 同轴回滚，至少把轴向摆正（语料 0 例，尽力而为）。

export type TexOrientationPlan = "keep" | "rot-cw" | "rot-ccw";

/**
 * 给定 EXIF orientation 与「解码位图尺寸 vs .tex 声明尺寸」，决定回滚动作。
 * 纯函数，离线判据直接跑这个，不要在测试里再抄分支。
 */
export function texOrientationPlan(
  orientation: number,
  bmpW: number,
  bmpH: number,
  wantW: number,
  wantH: number,
): TexOrientationPlan {
  if (bmpW === wantW && bmpH === wantH) return "keep";
  // 宽高互换 = 引擎把 90° 族方向应用进了位图（FreeImage 语义下不可能出现）。
  if (bmpW === wantH && bmpH === wantW && wantW > 0 && wantH > 0) {
    // EXIF 6「显示需顺时针 90°」→ 已顺转，回滚逆时针；EXIF 8 反之。
    if (orientation === 6 || orientation === 5) return "rot-ccw";
    if (orientation === 8 || orientation === 7) return "rot-cw";
  }
  return "keep";
}

/** 读 JPEG 的 EXIF Orientation（tag 274）。无 APP1/TIFF/该 tag 时返回 1。 */
export function jpegExifOrientation(b: Uint8Array): number {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return 1;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 2;
  while (p + 4 <= b.length) {
    if (b[p] !== 0xff) {
      p++;
      continue;
    }
    const marker = b[p + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      p += 2;
      continue;
    }
    if (marker === 0xda) break; // SOS 之后是熵编码数据，头部扫描结束
    const len = dv.getUint16(p + 2);
    if (
      marker === 0xe1 &&
      p + 10 <= b.length &&
      b[p + 4] === 0x45 /* E */ &&
      b[p + 5] === 0x78 /* x */ &&
      b[p + 6] === 0x69 /* i */ &&
      b[p + 7] === 0x66 /* f */ &&
      b[p + 8] === 0 &&
      b[p + 9] === 0
    ) {
      const t = p + 10;
      const be = b[t] === 0x4d && b[t + 1] === 0x4d; // "MM"
      const le = b[t] === 0x49 && b[t + 1] === 0x49; // "II"
      if (be || le) {
        const u16 = (o: number) => dv.getUint16(o, le);
        const u32 = (o: number) => dv.getUint32(o, le);
        const ifd = t + u32(t + 4);
        if (ifd >= 0 && ifd + 2 <= dv.byteLength) {
          const n = u16(ifd);
          for (let k = 0; k < n; k++) {
            const e = ifd + 2 + k * 12;
            if (e + 12 > dv.byteLength) break;
            if (u16(e) === 0x0112) {
              // Orientation，SHORT count=1 时值内联在条目 8..9
              if (u16(e + 2) === 3 && u32(e + 4) === 1) return u16(e + 8);
              return 1;
            }
          }
        }
      }
    }
    p += 2 + len;
  }
  return 1;
}

/**
 * .tex 内嵌图片 → ImageBitmap，像素布局与 WE/FreeImage 一致（存储像素原样）。
 * `bytes` 是同一份 JPEG 原始字节（m.image），用于读 EXIF；PNG 传 null
 * （PNG 的 eXIf 浏览器解码端不执行，无需处理）。
 */
export async function decodeTexImageBitmap(
  blob: Blob,
  bytes: Uint8Array | null,
  wantW: number,
  wantH: number,
  // [we-scene patch 2026-09-20] 资源倍率：<1 时**解码期**就降到目标尺寸
  // （createImageBitmap 的 resize 选项），省掉的正是这类大图最贵的全尺寸解码峰值。
  // 不支持的引擎会抛错 → 退回全尺寸解码（下游照旧按倍率走 canvas 重绘路径）。
  scale = 1,
): Promise<ImageBitmap> {
  const k = Number.isFinite(scale) && scale > 0 ? Math.min(1, scale) : 1;
  const outW = wantW > 0 ? Math.max(1, Math.round(wantW * k)) : 1;
  const outH = wantH > 0 ? Math.max(1, Math.round(wantH * k)) : 1;
  const resize = k < 0.999 && wantW > 0 && wantH > 0
    ? { resizeWidth: outW, resizeHeight: outH, resizeQuality: "high" as const }
    : null;
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(blob, { imageOrientation: "none", premultiplyAlpha: "none", ...(resize || {}) });
  } catch {
    try {
      // 个别引擎不认 imageOrientation 选项：退回默认解码，交给下面的尺寸检测回滚。
      bmp = await createImageBitmap(blob, { premultiplyAlpha: "none", ...(resize || {}) });
    } catch {
      bmp = await createImageBitmap(blob, { premultiplyAlpha: "none" });
    }
  }
  // 旋转判定用**缩放后**的目标尺寸比（宽高关系不随缩放改变，判定逻辑不变）
  const plan = texOrientationPlan(
    bytes ? jpegExifOrientation(bytes) : 1,
    bmp.width,
    bmp.height,
    outW,
    outH,
  );
  if (plan === "keep") return bmp;
  const cv = document.createElement("canvas");
  cv.width = outW;
  cv.height = outH;
  const ctx = cv.getContext("2d");
  if (!ctx) return bmp;
  // 顺时针：translate(wantW,0)+rotate(+90°)；逆时针：translate(0,wantH)+rotate(-90°)。
  if (plan === "rot-cw") {
    ctx.translate(outW, 0);
    ctx.rotate(Math.PI / 2);
  } else {
    ctx.translate(0, outH);
    ctx.rotate(-Math.PI / 2);
  }
  ctx.drawImage(bmp, 0, 0);
  const fixed = await createImageBitmap(cv);
  bmp.close?.();
  return fixed;
}

/**
 * [we-scene patch 2026-09-20] CPU 侧 RGBA 双线性重采样（资源倍率用）。
 *
 * 与 `particle-textures.js::bilinearResize` 的区别：那个只保留 **alpha**（粒子遮罩用，
 * 出图是白 RGB + 形状 alpha）；场景贴图是彩色图像，必须四个通道一起重采样，
 * 否则整张贴图会变成白图。
 */
export function resampleRgba(
  src: { width: number; height: number; rgba: Uint8Array },
  w2: number,
  h2: number,
): { width: number; height: number; rgba: Uint8Array } {
  const { width: w, height: h, rgba } = src;
  const W = Math.max(1, Math.round(w2));
  const H = Math.max(1, Math.round(h2));
  if (W === w && H === h) return src;
  const out = new Uint8Array(W * H * 4);
  const sx = w / W;
  const sy = h / H;
  for (let y = 0; y < H; y++) {
    const fy = Math.min(h - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(h - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < W; x++) {
      const fx = Math.min(w - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(w - 1, x0 + 1);
      const tx = fx - x0;
      const o00 = (y0 * w + x0) * 4;
      const o10 = (y0 * w + x1) * 4;
      const o01 = (y1 * w + x0) * 4;
      const o11 = (y1 * w + x1) * 4;
      const o = (y * W + x) * 4;
      for (let c = 0; c < 4; c++) {
        const a = rgba[o00 + c] * (1 - tx) + rgba[o10 + c] * tx;
        const b = rgba[o01 + c] * (1 - tx) + rgba[o11 + c] * tx;
        out[o + c] = Math.round(a * (1 - ty) + b * ty);
      }
    }
  }
  return { width: W, height: H, rgba: out };
}
