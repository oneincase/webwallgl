// 导出 WE 原生 scene.pkg（EDITOR-PLAN W6-full）：保存清单 → PKGV0012 容器。
// 本仓读端在 .tex 缺席时回退同名 png/jpg，官方 WE 只认 materials/**/X.tex ——
// 所以 materials 下没有同名 .tex 的源图在这里原字节包成 .tex（TEXB0004 内嵌，零重编码），
// 源图不进包；已有同名 .tex 的源图同样丢弃（与 scripts/dev-pack-pkg.mjs 同口径）。
// materials 以外的图片（用户属性 files/*.png 等按路径直取）原样保留。
import type { ScenePkgFile, ScenePkgResult } from "../api/types";
import { writePkg } from "../../vendor/we-scene/pkg/container.js";
import { encodeTexImage, imageSize } from "../../vendor/we-scene/pkg/tex-write.js";

const MATERIAL_IMAGE = /^materials\/.+\.(png|jpe?g)$/i;

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
    if (!MATERIAL_IMAGE.test(f.path)) {
      out.set(f.path, f.data);
      continue;
    }
    const texPath = f.path.replace(/\.[^.]+$/, ".tex");
    if (byLower.has(texPath.toLowerCase()) || out.has(texPath)) {
      dropped.push(f.path);
      continue;
    }
    const size = imageSize(f.data);
    if (!size) {
      out.set(f.path, f.data);
      continue;
    }
    out.set(texPath, encodeTexImage({ bytes: f.data, width: size.width, height: size.height }));
    converted.push(texPath);
    dropped.push(f.path);
  }
  const pkg = writePkg([...out].map(([name, data]) => ({ name, data })));
  return { pkg, entries: [...out.keys()].sort(), converted, dropped };
}
