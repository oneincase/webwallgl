// .mdl 子网格材质改指向（EDITOR-PLAN W16）：经 W17 的无损文档读写，只动网格头里的材质串，
// 顶点 / 索引 / 骨骼 / 动画逐字节不变（各段偏移由 writeMdlDoc 重算）。
import { readMdlDoc, writeMdlDoc } from "../../vendor/we-scene/pkg/mdl-write.js";

type MdlDoc = { raw?: Uint8Array; meshes?: Array<{ materials: Array<string | { raw: Uint8Array }> }> };

function docOf(bytes: Uint8Array): MdlDoc | null {
  try {
    const d = readMdlDoc(bytes) as MdlDoc;
    return d.raw || !d.meshes ? null : d;
  } catch {
    return null;
  }
}

export function mdlMeshMaterials(bytes: Uint8Array): Array<string | null> | null {
  const d = docOf(bytes);
  return d ? d.meshes!.map((m) => (typeof m.materials[0] === "string" ? m.materials[0] : null)) : null;
}

export function retargetMdlMaterial(bytes: Uint8Array, meshIndex: number, materialPath: string): Uint8Array | null {
  const d = docOf(bytes);
  const m = d?.meshes?.[meshIndex];
  if (!m || !materialPath || !m.materials.length) return null;
  m.materials[0] = materialPath;
  return writeMdlDoc(d) as Uint8Array;
}
