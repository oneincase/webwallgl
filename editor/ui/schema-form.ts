// 参数表 → 表单（PLUGIN-ARCHITECTURE §3.1）：效果 / 插件配置 / 外来效果的 uniform 共用一个生成器。
// DOM 结构与旧版效果面板逐字一致（.ed-fx-params > label + .ed-fx-param > input[data-param]），
// 页面判据和样式不用跟着改：float / int 是滑条 + 读数，color 是取色器，bool 是勾选，vecN 是 N 个数值框。

import type { EffectParam, EffectValue } from "../effects";

export type SchemaFormOptions = {
  params: readonly EffectParam[];
  values: Record<string, EffectValue | undefined>;
  label(p: EffectParam): string;
  commit(key: string, value: EffectValue): void;
  disabled?: boolean;
};

const fmtNum = (v: number) => String(Math.round(v * 1000) / 1000);
export const toHex = (c: readonly number[]) =>
  `#${[0, 1, 2].map((i) => Math.round(Math.max(0, Math.min(1, Number(c[i]) || 0)) * 255).toString(16).padStart(2, "0")).join("")}`;
export const fromHex = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];

const VEC_LEN: Record<string, number> = { vec2: 2, vec3: 3, vec4: 4 };

function fallbackValue(p: EffectParam): EffectValue {
  const d = p.default;
  return Array.isArray(d) ? [...d] : (d as number | boolean);
}

export function schemaForm(o: SchemaFormOptions): HTMLElement {
  const form = document.createElement("div");
  form.className = "ed-fx-params";
  for (const p of o.params) {
    const l = document.createElement("label");
    l.textContent = o.label(p);
    if (p.uniform) l.title = p.uniform;
    const val = o.values[p.key] ?? fallbackValue(p);
    const box = document.createElement("div");
    box.className = "ed-fx-param";
    if (p.type === "color") {
      const inp = document.createElement("input");
      inp.type = "color";
      inp.dataset.param = p.key;
      inp.value = toHex(Array.isArray(val) ? val : [0, 0, 0]);
      inp.disabled = !!o.disabled;
      inp.addEventListener("change", () => o.commit(p.key, fromHex(inp.value)));
      box.appendChild(inp);
    } else if (p.type === "bool") {
      const inp = document.createElement("input");
      inp.type = "checkbox";
      inp.dataset.param = p.key;
      inp.checked = val === true || (typeof val === "number" && val !== 0);
      inp.disabled = !!o.disabled;
      inp.addEventListener("change", () => o.commit(p.key, inp.checked));
      box.appendChild(inp);
    } else if (VEC_LEN[p.type]) {
      const n = VEC_LEN[p.type];
      const cur = Array.isArray(val) ? [...val] : Array.from({ length: n }, () => Number(val) || 0);
      for (let i = 0; i < n; i++) {
        const inp = document.createElement("input");
        inp.type = "number";
        inp.dataset.param = `${p.key}.${i}`;
        inp.step = String(p.step ?? 0.01);
        if (p.min !== undefined) inp.min = String(p.min);
        if (p.max !== undefined) inp.max = String(p.max);
        inp.value = fmtNum(Number(cur[i]) || 0);
        inp.disabled = !!o.disabled;
        inp.addEventListener("change", () => {
          cur[i] = Number(inp.value) || 0;
          o.commit(p.key, [...cur]);
        });
        box.appendChild(inp);
      }
    } else {
      const inp = document.createElement("input");
      inp.type = "range";
      inp.dataset.param = p.key;
      inp.min = String(p.min ?? 0);
      inp.max = String(p.max ?? 1);
      inp.step = String(p.step ?? (p.type === "int" ? 1 : 0.01));
      inp.value = String(val);
      inp.disabled = !!o.disabled;
      const out = document.createElement("span");
      out.className = "ed-val";
      out.textContent = fmtNum(Number(val));
      inp.addEventListener("input", () => (out.textContent = fmtNum(Number(inp.value))));
      inp.addEventListener("change", () => o.commit(p.key, Number(inp.value)));
      box.append(inp, out);
    }
    form.append(l, box);
  }
  return form;
}
