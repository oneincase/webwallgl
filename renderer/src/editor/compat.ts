// WE 兼容性回读校验（PLUGIN-ARCHITECTURE §4）：导出前把产物交给**引擎自己的解析器**再读一遍。
//
// 编辑器插件只能产出 WE 原生数据，这里是最后一道闸：project.json → 入口 scene.json →
// parseScene（与播放同一条解析）→ 每个对象引用的 model / 材质 / 贴图 / 粒子 / 声音 / mdl 是否在工程里 →
// 每条效果走 resolveEffectChain（与装配期同一函数，诊断原样收集）→ shader 文件在不在、
// uniform 注释是不是合法 JSON（WE 按它把 constantshadervalues 落到 uniform 上）。
// 不依赖 DOM / GPU，Node 里可跑（verify-we-export）。
import type { ScenePkgFile, WeCompatIssue, WeCompatReport } from "../api/types";
import { parsePkg, getEntry } from "../../vendor/we-scene/pkg/container.js";
import { parseScene } from "../../vendor/we-scene/scene/parse.js";
import { resolveEffectChain, BUILTIN_MODELS } from "../../vendor/we-scene/scene/effects-parse.js";

const dec = new TextDecoder();
const text = (b: Uint8Array) => dec.decode(b).replace(/^\uFEFF/, "");

function json(b: Uint8Array | null): Record<string, unknown> | null {
  if (!b) return null;
  try {
    const v = JSON.parse(text(b));
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const str = (v: unknown): string | null => {
  const u = v && typeof v === "object" && !Array.isArray(v) && "value" in (v as object) ? (v as { value: unknown }).value : v;
  return typeof u === "string" && u ? u : null;
};

/** WE 安装目录自带、不随壁纸走的命名空间 */
const isWeBuiltin = (p: string) => /^(models|materials)\/util\//.test(p) || p in BUILTIN_MODELS;

const UNIFORM_NOTE = /^[ \t]*uniform[ \t]+\w+[ \t]+(\w+)[ \t]*;[ \t]*\/\/[ \t]*(\{.*)$/gm;

export async function checkWeCompat(files: readonly ScenePkgFile[]): Promise<WeCompatReport> {
  const issues: WeCompatIssue[] = [];
  const seen = new Set<string>();
  const add = (level: WeCompatIssue["level"], code: string, message: string, path?: string) => {
    const key = `${level}|${code}|${path ?? ""}|${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    issues.push(path ? { level, code, message, path } : { level, code, message });
  };

  const loose = new Map(files.map((f) => [f.path, f.data]));
  const pkgFile = files.find((f) => /(^|\/)scene\.pkg$/i.test(f.path));
  let pkg: ReturnType<typeof parsePkg> | null = null;
  if (pkgFile) {
    try {
      pkg = parsePkg(pkgFile.data);
    } catch (e) {
      add("error", "bad-pkg", `scene.pkg 无法解析：${(e as Error).message}`, pkgFile.path);
    }
  }
  const read = (name: string): Uint8Array | null => {
    if (!name) return null;
    const hit = loose.get(name);
    if (hit) return hit;
    if (pkg) {
      const e = getEntry(pkg, name);
      if (e) return e;
    }
    return null;
  };
  const exists = (name: string) => read(name) !== null;
  const lowerIndex = new Map<string, string>();
  for (const f of files) lowerIndex.set(f.path.toLowerCase(), f.path);
  for (const e of (pkg as { entries?: Array<{ name: string }> } | null)?.entries ?? []) lowerIndex.set(e.name.toLowerCase(), e.name);
  const need = (name: string, what: string, level: WeCompatIssue["level"] = "error") => {
    if (isWeBuiltin(name) || exists(name)) return true;
    const ci = lowerIndex.get(name.toLowerCase());
    add(level, "missing-file", ci ? `${what} ${name} 只有大小写不同的 ${ci}（WE 按原样大小写查找）` : `${what} ${name} 不在工程里`, name);
    return false;
  };

  const project = json(loose.get("project.json") ?? null);
  const type = typeof project?.type === "string" ? project.type.toLowerCase() : "";
  let entry: string | null = typeof project?.file === "string" ? project.file : null;
  if (!project) add("error", "project-json", loose.has("project.json") ? "project.json 不是合法 JSON" : "缺 project.json（WE 靠它识别壁纸）", "project.json");
  else {
    if (!["scene", "video", "web", "application"].includes(type)) add("error", "project-type", `project.json 的 type「${String(project.type)}」WE 不认识`, "project.json");
    if (typeof project.title !== "string" || !project.title.trim()) add("warn", "project-title", "project.json 缺 title（创意工坊上传必填）", "project.json");
    if (typeof project.preview === "string" && !exists(project.preview)) add("warn", "missing-file", `封面 ${project.preview} 不在工程里`, project.preview);
    if (!entry) add("error", "project-file", "project.json 缺 file（入口文件）", "project.json");
  }

  let layers = 0;
  let effects = 0;
  const report = (): WeCompatReport => ({
    ok: !issues.some((i) => i.level === "error"),
    form: pkg ? "pkg" : "loose",
    type,
    entry,
    issues,
    layers,
    effects,
  });

  if (type === "video") {
    if (entry) need(entry, "视频文件");
    return report();
  }
  if (type !== "scene" || !entry) return report();

  const sceneBytes = read(entry);
  if (!sceneBytes) {
    add("error", "missing-entry", `入口 ${entry} 不在工程里（散装与 scene.pkg 都没有）`, entry);
    return report();
  }
  const scene = json(sceneBytes);
  if (!scene) {
    add("error", "bad-json", `入口 ${entry} 不是合法 JSON`, entry);
    return report();
  }
  const objects = Array.isArray(scene.objects) ? (scene.objects as Array<Record<string, unknown>>) : [];
  if (!Array.isArray(scene.objects)) add("error", "scene-objects", "scene.json 缺 objects 数组", entry);
  try {
    layers = (parseScene(structuredClone(scene), project) as { layers?: unknown[] })?.layers?.length ?? objects.length;
  } catch (e) {
    add("error", "parse-scene", `引擎解析 scene.json 失败：${(e as Error).message}`, entry);
  }

  const checkedMaterials = new Set<string>();
  const checkShader = (shader: string, where: string) => {
    for (const ext of ["frag", "vert"]) {
      const p = `shaders/${shader}.${ext}`;
      const b = read(p);
      if (!b) {
        // 不在工程里 = 依赖 WE 安装目录自带的同名 shader（官方效果 / generic* 是这样）
        if (/^effects\/wwgl_/.test(shader) || /\/editor\//.test(shader)) add("error", "missing-file", `${where}：shader ${p} 不在工程里`, p);
        continue;
      }
      for (const m of text(b).matchAll(UNIFORM_NOTE)) {
        try {
          JSON.parse(m[2].trim());
        } catch {
          add("warn", "uniform-note", `${p}：uniform ${m[1]} 的注释不是合法 JSON，WE 不会把 constantshadervalues 落到它上面`, p);
        }
      }
    }
  };
  const checkMaterial = (path: string, where: string) => {
    if (checkedMaterials.has(path) || !need(path, `${where} 的材质`)) return;
    checkedMaterials.add(path);
    if (isWeBuiltin(path)) return;
    const mj = json(read(path));
    if (!mj) {
      add("error", "bad-json", `材质 ${path} 不是合法 JSON`, path);
      return;
    }
    const pass = (mj.passes as Array<Record<string, unknown>> | undefined)?.[0];
    if (!pass || typeof pass.shader !== "string") {
      add("error", "material-shader", `材质 ${path} 缺 passes[0].shader`, path);
      return;
    }
    checkShader(pass.shader, `材质 ${path}`);
    for (const t of Array.isArray(pass.textures) ? pass.textures : []) {
      if (typeof t !== "string" || !t || t.startsWith("_rt_")) continue;
      const cands = [`materials/${t}.tex`, `materials/${t}.png`, `materials/${t}.jpg`, `materials/${t}.mp4`];
      if (cands.some(exists)) {
        if (pkg && !exists(cands[0])) add("warn", "tex-source", `贴图 ${t} 只有源图没有 .tex（官方 WE 只认 .tex）`, cands[0]);
        continue;
      }
      // 不在工程里：WE 内置贴图（particle/halo、util/white …）合法；编辑器生成路径下缺失则是真缺
      if (/editor\//.test(t)) add("error", "missing-file", `材质 ${path} 引用的贴图 ${t} 不在工程里`, cands[0]);
      else add("info", "builtin-texture", `贴图 ${t} 按 WE 内置贴图处理`, cands[0]);
    }
  };

  for (const o of objects) {
    if (!o || typeof o !== "object") continue;
    const label = `对象 ${String(o.name ?? o.id ?? "?")}`;
    const image = str(o.image);
    if (image && need(image, `${label} 的模型`) && !isWeBuiltin(image)) {
      const mj = json(read(image));
      if (!mj) add("error", "bad-json", `${image} 不是合法 JSON`, image);
      else {
        if (typeof mj.material === "string") checkMaterial(mj.material, label);
        // WE 安装目录自带 models/1x1_puppet.mdl 一类骨骼底座（真壁纸 2955378002 引用但包里没有）；编辑器生成的才必须在
        if (typeof mj.puppet === "string") need(mj.puppet, `${label} 的 puppet`, /(^|\/)editor\//.test(mj.puppet) ? "error" : "warn");
      }
    }
    const model = str(o.model);
    if (model) need(model, `${label} 的模型`);
    const particle = str(o.particle);
    if (particle && need(particle, `${label} 的粒子`)) {
      const pj = json(read(particle));
      if (!pj) add("error", "bad-json", `粒子 ${particle} 不是合法 JSON`, particle);
      else if (typeof pj.material === "string") checkMaterial(pj.material, `粒子 ${particle}`);
    }
    if (Array.isArray(o.sound)) for (const s of o.sound) if (typeof s === "string") need(s, `${label} 的声音`);
    const font = str(o.font);
    if (font && !/^systemfont_/i.test(font)) need(font, `${label} 的字体`, "warn");

    for (const e of Array.isArray(o.effects) ? (o.effects as Array<Record<string, unknown>>) : []) {
      if (typeof e?.file !== "string") continue;
      effects++;
      const file = e.file;
      const before = issues.length;
      if (!need(file, `${label} 的效果`)) continue;
      const ej = json(read(file));
      if (!ej) {
        add("error", "bad-json", `效果 ${file} 不是合法 JSON`, file);
        continue;
      }
      const passes = Array.isArray(ej.passes) ? (ej.passes as Array<Record<string, unknown>>) : [];
      if (!passes.length) add("error", "effect-passes", `效果 ${file} 没有 passes`, file);
      passes.forEach((p, i) => {
        if (typeof p.material === "string") checkMaterial(p.material, `效果 ${file} pass ${i}`);
        else if (p.command !== "copy" && p.command !== "swap") add("error", "effect-pass", `效果 ${file} pass ${i} 既没有 material 也不是 copy/swap 命令`, file);
      });
      // 引擎同一条解析再走一遍；它的诊断全局只报一次，只当补充（自己的判据已逐项覆盖）
      if (issues.length === before) {
        const eff: Record<string, unknown> = { file, passes: e.passes };
        await resolveEffectChain(
          async (name: string) => read(name),
          eff,
          (b: Uint8Array) => text(b),
          undefined,
          (msg: string) => add("error", "effect-chain", msg, file),
          "工程内",
        );
      }
    }
  }
  return report();
}
