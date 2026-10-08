// 由 scripts/build-plugin-sdk.mjs 从 src/index.ts 生成，勿手改。
// editor/sdk/index.ts
function definePlugin(p) {
  return p;
}

// examples/plugins/cmd-layer-align/src/index.ts
var fmt = (n) => (Math.round(n * 1e3) / 1e3).toFixed(3);
var vec3 = (v) => v.map(fmt).join(" ");
var isWrapped = (v) => !!v && typeof v === "object" && !Array.isArray(v) && "value" in v;
function readVec3(v, fallback) {
  const raw = isWrapped(v) ? v.value : v;
  const parts = typeof raw === "string" ? raw.trim().split(/\s+/).map(Number) : [];
  return parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite) ? [parts[0], parts[1], parts[2]] : fallback;
}
function writeVec3(o, key, v) {
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
function sceneSize(d) {
  const general = d?.scene?.general;
  const ortho = general?.orthogonalprojection;
  const w = Number(ortho?.width);
  const h = Number(ortho?.height);
  return w > 0 && h > 0 ? [w, h] : null;
}
function centerObject(o, size) {
  const [, , z] = readVec3(o.origin, [0, 0, 0]);
  return writeVec3(o, "origin", [size[0] / 2, size[1] / 2, z]);
}
function resetTransform(o) {
  const a = writeVec3(o, "scale", [1, 1, 1]);
  const b = writeVec3(o, "angles", [0, 0, 0]);
  return a || b;
}
function commands(doc, i18n) {
  const t = (k, p) => i18n.t(`layerAlign.${k}`, p);
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
      if (node.obj.parent !== void 0 && node.obj.parent !== null) {
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
    }
  };
}
var index_default = definePlugin({
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
    const button = (id, label, title, cmd) => ctx.effect(
      () => ui.add("toolbar", {
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
        }
      })
    );
    button("layer-align-center", "layerAlign.center", "layerAlign.centerTitle", "layerAlign.center");
    button("layer-align-reset", "layerAlign.reset", "layerAlign.resetTitle", "layerAlign.reset");
  }
});
export {
  centerObject,
  index_default as default,
  readVec3,
  resetTransform,
  sceneSize,
  writeVec3
};
