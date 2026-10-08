import { definePlugin, type DocService, type EditorDoc, type I18nService, type SceneObject } from "../../../../editor/sdk";

type Vec3 = [number, number, number];

const fmt = (n: number) => (Math.round(n * 1000) / 1000).toFixed(3);
const vec3 = (v: Vec3) => v.map(fmt).join(" ");

/** 字段可能被 { value, user / script / animation } 包装：读写都只碰 value */
const isWrapped = (v: unknown): v is { value: unknown } => !!v && typeof v === "object" && !Array.isArray(v) && "value" in v;

export function readVec3(v: unknown, fallback: Vec3): Vec3 {
  const raw = isWrapped(v) ? v.value : v;
  const parts = typeof raw === "string" ? raw.trim().split(/\s+/).map(Number) : [];
  return parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite) ? [parts[0], parts[1], parts[2]] : fallback;
}

/** 写入并返回是否真的变了 */
export function writeVec3(o: SceneObject, key: string, v: Vec3): boolean {
  const next = vec3(v);
  const cur = o[key];
  if (isWrapped(cur)) {
    if (cur.value === next) return false;
    cur.value = next;
  } else {
    if (cur === next) return false;
    o[key] = next;
  }
  return true;
}

/** 正交场景的画面尺寸；透视相机 / 缺尺寸返回 null */
export function sceneSize(d: EditorDoc | null): [number, number] | null {
  const general = d?.scene?.general as Record<string, unknown> | undefined;
  const ortho = general?.orthogonalprojection as Record<string, unknown> | null | undefined;
  const w = Number(ortho?.width);
  const h = Number(ortho?.height);
  return w > 0 && h > 0 ? [w, h] : null;
}

/** 把对象移到画面中心（WE 场景坐标原点在左下，中心 = 宽高一半），z 不动 */
export function centerObject(o: SceneObject, size: [number, number]): boolean {
  const [, , z] = readVec3(o.origin, [0, 0, 0]);
  return writeVec3(o, "origin", [size[0] / 2, size[1] / 2, z]);
}

export function resetTransform(o: SceneObject): boolean {
  const a = writeVec3(o, "scale", [1, 1, 1]);
  const b = writeVec3(o, "angles", [0, 0, 0]);
  return a || b;
}

function commands(doc: DocService, i18n: I18nService) {
  const t = (k: string, p?: Record<string, string | number>) => i18n.t(`layerAlign.${k}`, p);
  /** 取当前可编辑的选中图层；不行就在控制台说明原因 */
  const target = () => {
    const node = doc.selection();
    if (!node) {
      doc.log(t("noSelection"), "warn");
      return null;
    }
    if (doc.isLocked(node.id)) {
      doc.log(t("locked", { name: node.name }), "warn");
      return null;
    }
    return node;
  };
  return {
    center() {
      const node = target();
      if (!node) return;
      if (node.obj.parent !== undefined && node.obj.parent !== null) {
        doc.log(t("hasParent", { name: node.name }), "warn");
        return;
      }
      const size = sceneSize(doc.current());
      if (!size) {
        doc.log(t("noOrtho"), "warn");
        return;
      }
      if (!doc.editObject(t("centered", { name: node.name }), node.id, (o) => centerObject(o, size))) doc.log(t("unchanged", { name: node.name }));
    },
    reset() {
      const node = target();
      if (!node) return;
      if (!doc.editObject(t("resetDone", { name: node.name }), node.id, (o) => resetTransform(o))) doc.log(t("unchanged", { name: node.name }));
    },
  };
}

export default definePlugin({
  name: "cmd-layer-align",
  inject: ["commands", "ui", "doc", "i18n"],
  apply(ctx) {
    const doc = ctx.get("doc");
    const i18n = ctx.get("i18n");
    const run = commands(doc, i18n);
    const reg = ctx.get("commands").registry;
    const has = () => doc.current() !== null;
    ctx.effect(() => reg.add({ id: "layerAlign.center", title: { "zh-CN": "图层居中", en: "Center layer" }, keys: "Mod+Shift+K", when: has, run: run.center }, ctx.name));
    ctx.effect(() => reg.add({ id: "layerAlign.reset", title: { "zh-CN": "缩放 / 旋转归位", en: "Reset scale / rotation" }, keys: "Mod+Shift+U", when: has, run: run.reset }, ctx.name));

    const ui = ctx.get("ui");
    const button = (id: string, label: string, title: string, cmd: string) =>
      ctx.effect(() =>
        ui.add("toolbar", {
          id,
          order: id === "layer-align-center" ? 10 : 11,
          render() {
            const b = document.createElement("button");
            b.type = "button";
            b.className = "ed-btn";
            b.textContent = i18n.t(label);
            b.title = i18n.t(title);
            b.onclick = () => ctx.get("commands").exec(cmd);
            return b;
          },
        }),
      );
    button("layer-align-center", "layerAlign.center", "layerAlign.centerTitle", "layerAlign.center");
    button("layer-align-reset", "layerAlign.reset", "layerAlign.resetTitle", "layerAlign.reset");
  },
});
