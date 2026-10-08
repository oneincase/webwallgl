// 模型文件 → 内存 glTF 的统一入口：glb / gltf 直读，其余格式解析成 ModelIR 再装成 glTF，之后都走 gltfToModel。
//
// 插件化（PLUGIN-ARCHITECTURE §3.4）：每种格式是 modelImporters 注册表里的一项（内置 7 种由
// builtin-importers 插件登记，同时作 fallback）。插件导入器只要产出 ModelIR 或 glTF，后半段
// （gltfToModel → .mdl 编码 → puppet 图集）原样复用，产物仍是 WE 原生 .mdl。

import { parseFbx } from "./fmt-fbx";
import { parse3ds } from "./fmt-3ds";
import { parseDae } from "./fmt-dae";
import { parseObj } from "./fmt-obj";
import { parsePly, parseStl } from "./fmt-stl";
import { GltfError, parseGltf, type Gltf, type GltfWarning } from "./gltf";
import { irToGltf, type ModelIR } from "./model-ir";
import { createRegistry } from "./core/registry";

export type ModelImporter = {
  id: string;
  /** 主文件扩展名（小写，不带点） */
  exts: readonly string[];
  /** 可选的内容嗅探：同扩展名多个导入器时，先嗅探命中的优先 */
  sniff?: (bytes: Uint8Array) => boolean;
  /** 旁路文件扩展名（缓冲 / 材质库 / 贴图） */
  sideExts?: readonly string[];
  title?: string | Record<string, string>;
  load(bytes: Uint8Array, resolve: Gltf["resolve"]): ModelIR | Gltf | Promise<ModelIR | Gltf>;
};

const isGltf = (x: ModelIR | Gltf): x is Gltf => "json" in x && "resolve" in x;

export const BUILTIN_IMPORTERS: ModelImporter[] = [
  { id: "gltf", exts: ["glb", "gltf"], sideExts: ["bin", "png", "jpg", "jpeg"], load: (b, r) => parseGltf(b, r) },
  { id: "fbx", exts: ["fbx"], sideExts: ["png", "jpg", "jpeg", "tga", "bmp"], load: (b, r) => parseFbx(b, r) },
  { id: "obj", exts: ["obj"], sideExts: ["mtl", "png", "jpg", "jpeg", "tga", "bmp"], load: (b, r) => parseObj(b, r) },
  { id: "dae", exts: ["dae"], sideExts: ["png", "jpg", "jpeg", "tga", "bmp"], load: (b, r) => parseDae(b, r) },
  { id: "stl", exts: ["stl"], load: (b) => parseStl(b) },
  { id: "ply", exts: ["ply"], sideExts: ["png", "jpg", "jpeg"], load: (b, r) => parsePly(b, r) },
  { id: "3ds", exts: ["3ds"], sideExts: ["png", "jpg", "jpeg", "tga", "bmp"], load: (b, r) => parse3ds(b, r) },
];

export const modelImporters = createRegistry<ModelImporter>("importers", {
  validate: (m) => {
    if (!m.exts.length || m.exts.some((e) => !/^[a-z0-9]+$/.test(e))) throw new Error(`导入器 ${m.id} 的扩展名非法`);
  },
});
modelImporters.setFallback(BUILTIN_IMPORTERS);

/** 当前可用的导入器：登记的优先；一个都没登记（内核未起）时用内置表 */
const active = () => {
  const l = modelImporters.list();
  return l.length ? l : BUILTIN_IMPORTERS;
};

export const MODEL_EXTS = ["glb", "gltf", "fbx", "obj", "dae", "stl", "ply", "3ds"] as const;
/** 模型主文件之外可能被引用的旁路文件（缓冲 / 材质库 / 贴图） */
export const MODEL_SIDE_EXTS = ["bin", "mtl", "png", "jpg", "jpeg", "tga", "bmp"] as const;

export const modelExts = (): string[] => [...new Set(active().flatMap((m) => m.exts))];
export const modelSideExts = (): string[] => [...new Set([...MODEL_SIDE_EXTS, ...active().flatMap((m) => m.sideExts ?? [])])];

export const modelExt = (name: string): string => /\.([^./\\]+)$/.exec(name)?.[1]?.toLowerCase() ?? "";
export const isModelMain = (name: string): boolean => modelExts().includes(modelExt(name));

export type LoadedModel = { gltf: Gltf; warnings: GltfWarning[] };

/** 后登记的导入器优先（插件覆盖内置）；同扩展名里嗅探命中的再优先 */
export function importerFor(name: string, bytes?: Uint8Array): ModelImporter | null {
  const ext = modelExt(name);
  const cands = active()
    .filter((m) => m.exts.includes(ext))
    .reverse();
  if (bytes) {
    const hit = cands.find((m) => {
      try {
        return m.sniff?.(bytes) === true;
      } catch {
        return false;
      }
    });
    if (hit) return hit;
  }
  return cands.find((m) => !m.sniff) ?? cands[0] ?? null;
}

export async function loadModelFile(name: string, bytes: Uint8Array, resolve: Gltf["resolve"] = () => null): Promise<LoadedModel> {
  const imp = importerFor(name, bytes);
  if (!imp) throw new GltfError("format", modelExt(name) || name);
  const out = await imp.load(bytes, resolve);
  if (isGltf(out)) return { gltf: out, warnings: [] };
  return { gltf: irToGltf(out, resolve), warnings: out.warnings ?? [] };
}
