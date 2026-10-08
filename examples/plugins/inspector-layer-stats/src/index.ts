import { definePlugin, type I18nService, type InspectorGroup, type InspectorTab, type LayerNode, type SceneObject } from "../../../../editor/sdk";

const FILE_RE = /\.(json|tex|png|jpe?g|gif|webp|mdl|mp3|ogg|wav|flac|mp4|webm|frag|vert)$/i;

export type LayerStats = {
  descendants: number;
  effects: string[];
  bound: number;
  scripted: number;
  animated: number;
  files: string[];
};

/** 字段包装（{ value, user } / { value, script } / { value, animation }）按包装类型计数，字符串里像文件路径的收集起来 */
export function layerStats(obj: SceneObject, children: readonly LayerNode[] = []): LayerStats {
  const s = { bound: 0, scripted: 0, animated: 0, files: new Set<string>() };
  const walk = (v: unknown) => {
    if (typeof v === "string") {
      if (FILE_RE.test(v)) s.files.add(v);
      return;
    }
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    const o = v as Record<string, unknown>;
    if ("value" in o) {
      if (o.user !== undefined && o.user !== null && o.user !== "") s.bound++;
      if (typeof o.script === "string") s.scripted++;
      if (o.animation && typeof o.animation === "object") s.animated++;
    }
    for (const [k, x] of Object.entries(o)) if (k !== "script") walk(x);
  };
  walk(obj);
  const count = (ns: readonly LayerNode[]): number => ns.reduce((n, c) => n + 1 + count(c.children), 0);
  const effects = Array.isArray(obj.effects) ? (obj.effects as Array<Record<string, unknown>>) : [];
  return {
    descendants: count(children),
    effects: effects.map((e) => String(e.name ?? e.file ?? "?")),
    bound: s.bound,
    scripted: s.scripted,
    animated: s.animated,
    files: [...s.files].sort(),
  };
}

const TAB: InspectorTab = { id: "stats", order: 9000, title: { "zh-CN": "统计", en: "Stats" } };

function statsGroup(i18n: I18nService): InspectorGroup {
  return {
    id: "layer-stats",
    order: 100,
    tab: TAB.id,
    when: () => true,
    render(node) {
      const t = (k: string) => i18n.t(`layerStats.${k}`);
      const st = layerStats(node.obj, node.children);
      const group = document.createElement("div");
      group.className = "ed-insp-group";
      const h = document.createElement("div");
      h.className = "ed-insp-title";
      h.textContent = t("title");
      const dl = document.createElement("dl");
      dl.className = "ed-kv";
      const row = (key: string, value: string | string[]) => {
        const dt = document.createElement("dt");
        dt.textContent = t(key);
        const dd = document.createElement("dd");
        const lines = typeof value === "string" ? [value] : value.length ? value : [t("none")];
        for (const line of lines) {
          const div = document.createElement("div");
          div.textContent = line;
          div.title = line;
          dd.appendChild(div);
        }
        dl.append(dt, dd);
      };
      row("kind", node.modelForm ? `${node.kind} · ${node.modelForm}` : node.kind);
      row("descendants", String(st.descendants));
      row("effects", st.effects);
      row("bound", String(st.bound));
      row("scripted", String(st.scripted));
      row("animated", String(st.animated));
      row("files", st.files);
      group.append(h, dl);
      return group;
    },
  };
}

export default definePlugin({
  name: "inspector-layer-stats",
  inject: ["inspector", "inspector.tabs", "i18n"],
  apply(ctx) {
    ctx.contribute("inspector.tabs", TAB);
    ctx.contribute("inspector", statsGroup(ctx.get("i18n")));
  },
});
