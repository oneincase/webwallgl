// 木偶生成器「图片 → 摆动木偶」：一张图切成网格，竖向 4 节骨骼链，自带一段循环摆动动画。
// 产物是 ModelIR，走模型导入的后半段（gltfToModel → .mdl → puppet 图集），WE 侧就是普通 puppet：
// 骨骼 / 片段都能在木偶工具里继续调。草、旗、头发、海报一类「下端固定上端晃」的素材直接可用。

import type { ModelIR } from "../../model-ir";
import type { PuppetGenerator } from "../../inspector";

/** PNG IHDR / JPEG SOFn 里的像素尺寸；认不出返回 null */
export function imageSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const width = dv.getUint32(16);
    const height = dv.getUint32(20);
    return width && height ? { width, height } : null;
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let p = 2;
    while (p + 9 < b.length) {
      if (b[p] !== 0xff) {
        p++;
        continue;
      }
      const m = b[p + 1];
      if (m === 0xff) {
        p++;
        continue;
      }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
        p += 2;
        continue;
      }
      const len = (b[p + 2] << 8) | b[p + 3];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        const height = (b[p + 5] << 8) | b[p + 6];
        const width = (b[p + 7] << 8) | b[p + 8];
        return width && height ? { width, height } : null;
      }
      if (len < 2) return null;
      p += 2 + len;
    }
  }
  return null;
}

export type SwayOptions = {
  bones?: number;
  cols?: number;
  rows?: number;
  /** 顶端最大摆角（度），按骨节线性递增 */
  degrees?: number;
  /** 一个往返的秒数 */
  period?: number;
};

const quatZ = (deg: number) => {
  const h = (deg * Math.PI) / 360;
  return [0, 0, Math.sin(h), Math.cos(h)];
};

export function swayPuppet(name: string, bytes: Uint8Array, opts: SwayOptions = {}): ModelIR {
  const size = imageSize(bytes);
  if (!size) throw new Error(`${name}：只支持 PNG / JPEG`);
  const bones = Math.max(2, Math.min(8, opts.bones ?? 4));
  const cols = Math.max(1, opts.cols ?? 8);
  const rows = Math.max(bones, opts.rows ?? 16);
  const degrees = opts.degrees ?? 6;
  const period = opts.period ?? 2;
  // 高 1、宽按长宽比，底边中点为原点（骨骼根），Y 向上
  const H = 1;
  const W = size.width / size.height;
  const seg = H / bones;

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const joints: number[] = [];
  const weights: number[] = [];
  for (let r = 0; r <= rows; r++) {
    const y = (r / rows) * H;
    const f = Math.min(bones - 1, y / seg);
    const j = Math.min(bones - 2, Math.floor(f));
    const t = Math.min(1, Math.max(0, f - j));
    for (let c = 0; c <= cols; c++) {
      const x = (c / cols - 0.5) * W;
      positions.push(x, y, 0);
      normals.push(0, 0, 1);
      uvs.push(c / cols, 1 - r / rows);
      joints.push(j, j + 1, 0, 0);
      weights.push(1 - t, t, 0, 0);
    }
  }
  const indices: number[] = [];
  const at = (r: number, c: number) => r * (cols + 1) + c;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) indices.push(at(r, c), at(r, c + 1), at(r + 1, c + 1), at(r, c), at(r + 1, c + 1), at(r + 1, c));
  }

  const nodes: ModelIR["nodes"] = [];
  for (let k = 0; k < bones; k++) nodes.push({ name: `bone${k}`, parent: k - 1, t: [0, k ? seg : 0, 0] });
  nodes.push({
    name: name.replace(/\.[^.]+$/, ""),
    parent: -1,
    skin: 0,
    mesh: [{ material: 0, positions, normals, uvs, indices, joints, weights }],
  });
  const ibm = Array.from({ length: bones }, (_, k) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -k * seg, 0, 1]);

  const steps = 8;
  const times = Array.from({ length: steps + 1 }, (_, i) => (i / steps) * period);
  const channels = Array.from({ length: bones - 1 }, (_, i) => {
    const k = i + 1;
    const amp = (degrees * k) / (bones - 1) / (bones - 1);
    // 越往上相位越滞后，摆起来像鞭梢
    const values = times.flatMap((t) => quatZ(amp * Math.sin((2 * Math.PI * t) / period - k * 0.35)));
    return { node: k, path: "rotation" as const, times, values };
  });

  const png = bytes[0] === 0x89;
  return {
    nodes,
    skins: [{ joints: Array.from({ length: bones }, (_, k) => k), ibm }],
    materials: [{ name: "sway", image: { name, bytes }, doubleSided: true, blend: png }],
    anims: [{ name: "sway", channels }],
  };
}

export const SWAY_GENERATOR: PuppetGenerator = {
  id: "image-sway",
  title: { "zh-CN": "图片 → 摆动木偶…", en: "Image → Sway Puppet…" },
  accept: "image/png,image/jpeg,.png,.jpg,.jpeg",
  generate: (file) => swayPuppet(file.name, file.bytes),
};
