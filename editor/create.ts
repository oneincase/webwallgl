// 从零新建（EDITOR-PLAN §3A.4 新建模板）与「图片成层」。产物全是松散工程的标准形态：
//   models/editor/<slug>.json    { material, width, height }
//   materials/editor/<slug>.json { passes: [{ shader: "genericimage2", textures: ["editor/<slug>"] }] }
//   materials/editor/<slug>.png  贴图源图（引擎缺 .tex 时按 png / jpg 回退读取）
// 内置 albedo shader，不依赖 W7 效果库；保存后测试台与 WE 都按同一口径加载。

import { makeDoc, nextObjectId, rebuildTree, type EditorDoc, type SceneObject } from "./doc";

export type Resolution = { id: string; w: number; h: number };

export const RESOLUTIONS: readonly Resolution[] = [
  { id: "1080p", w: 1920, h: 1080 },
  { id: "1440p", w: 2560, h: 1440 },
  { id: "4k", w: 3840, h: 2160 },
  { id: "portrait", w: 1080, h: 1920 },
];

export type Rgb = readonly [number, number, number];

const f3 = (v: number) => (Math.round(v * 1000) / 1000).toFixed(3);
const vec3 = (a: number, b: number, c: number) => `${f3(a)} ${f3(b)} ${f3(c)}`;

/** #rrggbb → 0..1 三元组；不合法时给中灰 */
export function hexToRgb(hex: string): Rgb {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0.5, 0.5, 0.5];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** 空白场景：正交 2D 相机，objects 为空。general 字段与 WE 编辑器新建的 2D 场景同形 */
export function blankScene(w: number, h: number, clear: Rgb): Record<string, unknown> {
  return {
    camera: { center: "0.000 0.000 -1.000", eye: "0.000 0.000 0.000", up: "0.000 1.000 0.000" },
    general: {
      ambientcolor: "0.300 0.300 0.300",
      bloom: false,
      clearcolor: vec3(clear[0], clear[1], clear[2]),
      norecompile: true,
      orthogonalprojection: { width: w, height: h },
      skylightcolor: "0.300 0.300 0.300",
    },
    objects: [],
  };
}

export function newProject(title: string): Record<string, unknown> {
  return { type: "scene", title, file: "scene.json" };
}

export function newDocument(title: string, w: number, h: number, clear: Rgb): EditorDoc {
  return makeDoc(title, newProject(title), blankScene(w, h, clear), "loose");
}

export type ImageInput = {
  /** 原文件名（取图层名与 slug） */
  name: string;
  bytes: Uint8Array;
  ext: "png" | "jpg";
  width: number;
  height: number;
};

/** 文件名 → 图层名（去扩展名） */
export function layerNameOf(fileName: string): string {
  const base = fileName.replace(/\\/g, "/").split("/").pop() ?? "";
  return base.replace(/\.[^.]+$/, "").trim() || "image";
}

/**
 * 资源名用的 slug：只留 ASCII 字母数字与 - _（WE 工程从 Windows 来，路径里的中文 /
 * 空格在部分工具链上出问题）；全是非 ASCII 时退成 image。taken 判重后加 -2、-3…
 */
export function imageSlug(fileName: string, taken: (slug: string) => boolean): string {
  const base =
    layerNameOf(fileName)
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "image";
  if (!taken(base)) return base;
  for (let i = 2; ; i++) if (!taken(`${base}-${i}`)) return `${base}-${i}`;
}

export const modelPathOf = (slug: string) => `models/editor/${slug}.json`;

/** 一张图片成层需要的三个文件（模型 / 材质 / 贴图源图） */
export function imageLayerFiles(slug: string, img: ImageInput): Array<{ name: string; data: Uint8Array }> {
  const enc = new TextEncoder();
  const material = `materials/editor/${slug}.json`;
  return [
    {
      name: modelPathOf(slug),
      data: enc.encode(JSON.stringify({ material, width: img.width, height: img.height }, null, 2)),
    },
    {
      name: material,
      data: enc.encode(
        JSON.stringify(
          {
            passes: [
              {
                blending: "translucent",
                cullmode: "nocull",
                depthtest: "disabled",
                depthwrite: "disabled",
                shader: "genericimage2",
                textures: [`editor/${slug}`],
              },
            ],
          },
          null,
          2,
        ),
      ),
    },
    { name: `materials/editor/${slug}.${img.ext}`, data: img.bytes },
  ];
}

/**
 * 场景对象数组末尾追加一个图片层（绘制在最上），放在场景中心。
 * fit = 整图落在场景 80% 内（不放大）；cover = 铺满场景（背景模板用）。返回新 id
 */
export function addImageLayer(
  doc: EditorDoc,
  slug: string,
  img: Pick<ImageInput, "name" | "width" | "height">,
  mode: "fit" | "cover",
): number | null {
  const scene = doc.scene;
  if (!scene) return null;
  if (!Array.isArray(scene.objects)) scene.objects = [];
  const objs = scene.objects as SceneObject[];
  const ortho = (scene.general as Record<string, unknown> | undefined)?.orthogonalprojection as
    | Record<string, unknown>
    | undefined;
  const W = Number(ortho?.width) || 1920;
  const H = Number(ortho?.height) || 1080;
  const iw = Math.max(1, img.width);
  const ih = Math.max(1, img.height);
  const s = mode === "cover" ? Math.max(W / iw, H / ih) : Math.min(1, (0.8 * W) / iw, (0.8 * H) / ih);
  const id = nextObjectId(objs);
  objs.push({
    angles: "0.000 0.000 0.000",
    id,
    image: modelPathOf(slug),
    name: layerNameOf(img.name),
    origin: vec3(W / 2, H / 2, 0),
    scale: vec3(s, s, 1),
  });
  rebuildTree(doc);
  return id;
}

/** 文档对象当前引用的模型路径（资源表据此决定新增文件是否进保存清单） */
export function referencedModels(doc: EditorDoc | null): Set<string> {
  const out = new Set<string>();
  const objs = doc?.scene?.objects;
  if (!Array.isArray(objs)) return out;
  for (const o of objs as SceneObject[]) {
    if (typeof o?.image === "string") out.add(o.image);
    if (typeof o?.model === "string") out.add(o.model);
  }
  return out;
}

export const IMAGE_FILE_RE = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;

export function isImageFile(f: { name: string; type?: string }): boolean {
  return (f.type ?? "").startsWith("image/") || IMAGE_FILE_RE.test(f.name);
}

/**
 * 浏览器内读图：png / jpeg 原样保留字节；其余格式（webp / gif / bmp / avif）
 * 转成 png —— 引擎的源图回退只认 png / jpg。
 */
export async function readImageFile(file: File): Promise<ImageInput> {
  const bmp = await createImageBitmap(file);
  try {
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    const isPng = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
    const isJpg = head[0] === 0xff && head[1] === 0xd8;
    if (isPng || isJpg) {
      return {
        name: file.name,
        bytes: new Uint8Array(await file.arrayBuffer()),
        ext: isPng ? "png" : "jpg",
        width: bmp.width,
        height: bmp.height,
      };
    }
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    c.getContext("2d")!.drawImage(bmp, 0, 0);
    const blob = await c.convertToBlob({ type: "image/png" });
    return {
      name: file.name,
      bytes: new Uint8Array(await blob.arrayBuffer()),
      ext: "png",
      width: bmp.width,
      height: bmp.height,
    };
  } finally {
    bmp.close();
  }
}
