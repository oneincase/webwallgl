// WebWallGL 公共包类型入口（随 dist 发布为 dist/lib/core.d.ts）。
//
// 维护约束与 entry.d.ts 相同：函数签名是**手写的契约面**，类型本体只能来自
// ./types（tsconfig.lib-types.json 只编译 types.ts，别处的类型在发布包里解析
// 失败）。导出清单必须与 api/core.ts 一致 —— verify-arch 做机器比对，漏声明
// 的后果是消费方 import 直接 TS2305。
import type {
  Pkg,
  PkgEntry,
  PkgLayout,
  Tex,
  TexMip,
  TexFrame,
  TexFrames,
  DecodedMip,
  Fit,
  FitWindowResult,
} from "./types";

export type {
  Pkg,
  PkgEntry,
  PkgLayout,
  Tex,
  TexMip,
  TexFrame,
  TexFrames,
  DecodedMip,
  Fit,
  FitWindowResult,
};

/** 解析 scene.pkg（PKGV0012~0023）。入参必须是 Uint8Array（内部按 byteOffset 建视图） */
export declare function parsePkg(buf: Uint8Array): Pkg;

/** 取入口数据 —— 返回指向 pkg.buf 的零拷贝视图，不复制；需要独立副本自己 .slice() */
export declare function getEntry(pkg: Pkg, name: string): Uint8Array | null;

/** 结构自检：入口数据末尾应恰好贴住文件末尾 */
export declare function verifyLayout(pkg: Pkg): PkgLayout;

/** 解析 .tex（TEXV0005 主路径 + 旧 TEXV0004）。opts.name 仅供越界报错定位用 */
export declare function parseTex(buf: Uint8Array, opts?: { name?: string }): Tex;

export declare const TEXTURE_FORMATS: Record<number, string>;
export declare const FIF: {
  readonly UNKNOWN: number;
  readonly JPEG: number;
  readonly PNG: number;
  readonly GIF: number;
  readonly WEBP: number;
  readonly MP4: number;
};

/** mip0 解码 → 按载荷类型四选一（rgba / png / image+fif / video） */
export declare function decodeMip0(tex: Tex): DecodedMip;

/** 指定 mip 级独立解码（语义同 decodeMip0；POT 裁剪只在 level 0 生效） */
export declare function decodeMipLevel(tex: Tex, level: number): DecodedMip;

/** 全部 mip 级（freeImage 载荷按 image 透出、只有一级） */
export declare function decodeMips(tex: Tex): DecodedMip[];

/** 像素格式解码：format 取 TEXTURE_FORMATS 的键，返回 RGBA8；BC7（12）暂未实现 */
export declare function decodePixels(format: number, data: Uint8Array, w: number, h: number): Uint8Array;

/** 把设计尺寸（projW×projH）映射到屏幕（width×height）的可见窗口；
 *  alignX/alignY∈[0,1] 仅 cover 有溢出可滑，缺省 0.5 居中 */
export declare function fitWindow(
  fit: Fit,
  projW: number,
  projH: number,
  width: number,
  height: number,
  alignX?: number,
  alignY?: number,
): FitWindowResult;
