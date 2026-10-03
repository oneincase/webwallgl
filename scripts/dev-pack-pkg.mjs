#!/usr/bin/env node
/**
 * pack-source-project —— 把 WE **源码工程目录**打成 scene.pkg（PKGV0012）。
 *
 * 为什么存在：官方内置壁纸（WE 安装目录 `projects/defaultprojects/**`）与用户自己的
 * 编辑器工程都是**散装目录**形态（scene.json + materials/*.tex + models/*.mdl +
 * shaders/*.frag + particles/*.json），没有 scene.pkg；而本仓运行时的 Source 契约是
 * 「scene.pkg 字节 + project.json」（见 renderer/src/api/source.ts 的文件头注释）。
 * 打成一个容器后整条既有管线（贴图/模型/材质/效果/脚本/粒子）原样复用，运行时零新增面
 * —— 这是 DEFAULTPROJECTS-PLAN §5.1 的路线 A。
 *
 * 格式（与 renderer/vendor/we-scene/pkg/container.js parsePkg 对齐）：
 *   u32 magicLen(8) + "PKGV0012" + u32 count + entries{u32 nameLen, name, u32 offset, u32 size} + data
 *
 * 排除规则（`--all` 关闭）：只丢**运行时不会读**的文件，宁可多带不可少带 ——
 *   - `shaders/blobsSM40/**`、`shaders/blobsGES3/**`、`*.dxs`/`*.gxs`：WE 的编译缓存
 *     （按 GPU/驱动生成；本仓从 .frag/.vert 源现场转译，读它没有意义）；
 *   - `*.obj`/`*.mtl`：网格源文件，运行时资产是 .mdl；
 *   - `*.tex-json`：.tex 的编辑器 sidecar；
 *   - 与同名 `.tex` 并存的 `X.png/X.jpg/X.jpeg`：贴图源图（运行时读 `materials/X.tex`）；
 *     没有同名 .tex 的图片**保留**（预设壁纸的 `files/*.png` 是用户图通路）；
 *   - `.DS_Store` 等系统垃圾。
 *
 * 用法：
 *   node scripts/dev-pack-pkg.mjs <srcDir> <outPkg> [--all] [--quiet]
 * 也可当模块用（verify-defprojects 与宿主按需打包共用同一实现）：
 *   import { packSourceProject } from "./dev-pack-pkg.mjs";
 *   const { buffer, files, dropped } = packSourceProject(srcDir);
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** 与 parsePkg 对齐的容器魔数；WE 实测 PKGV0012 ~ PKGV0023，本仓解析器都吃 */
const PKG_MAGIC = "PKGV0012";

/** 运行时不会读的文件（判据见文件头）。返回 true = 丢弃。 */
export function defaultSkip(absPath, relPath) {
  const name = path.basename(relPath);
  const dir = relPath.split("/").slice(0, -1).join("/");
  if (name === ".DS_Store" || name === "Thumbs.db" || name.startsWith("._")) return true;
  if (/\.(dxs|gxs)$/i.test(name)) return true;
  if (/\.(obj|mtl)$/i.test(name)) return true;
  if (/\.tex-json$/i.test(name)) return true;
  if (/^shaders\/blobs/i.test(dir)) return true;
  // 贴图源图：仅当同目录有同名 .tex 时才丢（预设壁纸的 files/*.png 无同名 .tex，保留）
  if (/\.(png|jpe?g)$/i.test(name)) {
    const base = name.replace(/\.[^.]+$/, "");
    if (fs.existsSync(path.join(path.dirname(absPath), base + ".tex"))) return true;
  }
  return false;
}

/**
 * 打包一个源码工程目录。
 * @param {string} srcDir 工程根（含 project.json / scene.json / materials/ …）
 * @param {{ all?: boolean, skip?: (abs: string, rel: string) => boolean }} [opts]
 *        all=true 关闭默认排除；skip 可自定义补充（返回 true 丢弃）
 * @returns {{ buffer: Buffer, files: string[], dropped: string[], bytes: number }}
 */
export function packSourceProject(srcDir, opts = {}) {
  const keep = [];
  const dropped = [];
  (function walk(dir, rel) {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      if (fs.statSync(p).isDirectory()) walk(p, r);
      else {
        const skip = (!opts.all && defaultSkip(p, r)) || (opts.skip ? opts.skip(p, r) : false);
        // 不把已存在的 scene.pkg 再塞进包里（自引用会让包随每次打包变大）
        if (skip || /\.pkg$/i.test(name)) dropped.push(r);
        else keep.push({ rel: r, abs: p });
      }
    }
  })(srcDir, "");

  keep.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const nameBuf = (f) => Buffer.from(f.rel, "utf8");

  const entries = [];
  const chunks = [];
  let offset = 0;
  for (const f of keep) {
    const data = fs.readFileSync(f.abs);
    entries.push({ nameBuf: nameBuf(f), offset, size: data.length });
    chunks.push(data);
    offset += data.length;
  }

  const u32 = (v) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v >>> 0, 0);
    return b;
  };
  const parts = [u32(PKG_MAGIC.length), Buffer.from(PKG_MAGIC, "ascii"), u32(keep.length)];
  for (const e of entries) parts.push(u32(e.nameBuf.length), e.nameBuf, u32(e.offset), u32(e.size));
  parts.push(...chunks);
  return {
    buffer: Buffer.concat(parts),
    files: keep.map((f) => f.rel),
    dropped,
    bytes: offset,
  };
}

function main(argv) {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const [srcDir, outFile] = positional;
  if (!srcDir || !outFile) {
    console.error("用法: node scripts/dev-pack-pkg.mjs <srcDir> <outPkg> [--all] [--quiet]");
    return 1;
  }
  if (!fs.existsSync(path.join(srcDir, "project.json"))) {
    // 不是硬错误（有些目录没有 project.json），但源码工程该有 —— 提示一句
    console.error(`[pack] 提示：${srcDir} 下没有 project.json（仍会打包，但运行时可能判不出类型）`);
  }
  const { buffer, files, dropped, bytes } = packSourceProject(srcDir, { all: flags.has("--all") });
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  fs.writeFileSync(outFile, buffer);
  if (!flags.has("--quiet")) {
    console.log(
      `packed ${files.length} files, ${bytes} bytes data -> ${outFile}` +
        (dropped.length ? `（排除 ${dropped.length} 个：编译缓存/网格源/贴图源图）` : ""),
    );
  }
  return 0;
}

const invokedDirectly = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) process.exit(main(process.argv.slice(2)));
