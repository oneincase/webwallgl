// 导出 WE 原生 scene.pkg（EDITOR-PLAN W6-full）：保存清单 → PKGV0012 容器。
// 本仓读端在 .tex 缺席时回退同名 png/jpg/mp4，官方 WE 只认 materials/**/X.tex ——
// 所以 materials 下没有同名 .tex 的源图 / 源视频在这里原字节包成 .tex（零重编码），
// 源文件不进包；已有同名 .tex 的源文件同样丢弃（与 scripts/dev-pack-pkg.mjs 同口径）。
// materials 以外的图片（用户属性 files/*.png 等按路径直取）原样保留。
import type { ScenePkgFile, ScenePkgResult } from "../api/types";
import { writePkg } from "../../vendor/we-scene/pkg/container.js";
import { encodeTexImage, encodeTexVideo, imageSize, mp4Size } from "../../vendor/we-scene/pkg/tex-write.js";

const MATERIAL_SOURCE = /^materials\/.+\.(png|jpe?g|mp4)$/i;

export function buildScenePkg(files: readonly ScenePkgFile[]): ScenePkgResult {
  const byLower = new Map(files.map((f) => [f.path.toLowerCase(), f]));
  const out = new Map<string, Uint8Array>();
  const converted: string[] = [];
  const dropped: string[] = [];
  for (const f of files) {
    if (/\.pkg$/i.test(f.path)) {
      dropped.push(f.path);
      continue;
    }
    if (!MATERIAL_SOURCE.test(f.path)) {
      out.set(f.path, f.data);
      continue;
    }
    const texPath = f.path.replace(/\.[^.]+$/, ".tex");
    if (byLower.has(texPath.toLowerCase()) || out.has(texPath)) {
      dropped.push(f.path);
      continue;
    }
    const video = /\.mp4$/i.test(f.path);
    const size = video ? mp4Size(f.data) : imageSize(f.data);
    if (!size) {
      out.set(f.path, f.data);
      continue;
    }
    const opts = { bytes: f.data, width: size.width, height: size.height };
    out.set(texPath, video ? encodeTexVideo(opts) : encodeTexImage(opts));
    converted.push(texPath);
    dropped.push(f.path);
  }
  const pkg = writePkg([...out].map(([name, data]) => ({ name, data })));
  return { pkg, entries: [...out.keys()].sort(), converted, dropped };
}
