/**
 * 主题三态：跟随系统 → 深色 → 浅色。测试台与编辑器共用同一个 localStorage 键，
 * 在一边切换后另一边打开即生效。
 */

import { load, save } from "./storage";

export type ThemeMode = "auto" | "dark" | "light";

const THEME_KEY = "webwallgl-theme";
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

let mode: ThemeMode = "auto";
const listeners = new Set<(mode: ThemeMode) => void>();

function resolved(m: ThemeMode): "dark" | "light" {
  return m === "auto" ? (darkQuery.matches ? "dark" : "light") : m;
}

function apply() {
  document.documentElement.dataset.theme = resolved(mode);
  for (const f of listeners) f(mode);
}

export function getThemeMode(): ThemeMode {
  return mode;
}

export function setThemeMode(next: ThemeMode) {
  mode = next;
  save(THEME_KEY, next);
  apply();
}

export function cycleTheme() {
  setThemeMode(mode === "auto" ? "dark" : mode === "dark" ? "light" : "auto");
}

export function onThemeChange(f: (mode: ThemeMode) => void) {
  listeners.add(f);
  return () => listeners.delete(f);
}

/**
 * 主题按钮：内含 .ic-auto / .ic-dark / .ic-light 三个图标，显示**当前模式**；
 * title 由调用方的文案函数给出（随语言切换要重调 refresh）。
 */
export function bindThemeButton(btn: HTMLElement, title: (mode: ThemeMode) => string) {
  const refresh = () => {
    btn.dataset.mode = mode;
    btn.title = title(mode);
    for (const ic of btn.querySelectorAll<SVGElement>(".ic")) {
      if (ic.classList.contains(`ic-${mode}`)) ic.removeAttribute("hidden");
      else ic.setAttribute("hidden", "");
    }
  };
  btn.addEventListener("click", cycleTheme);
  onThemeChange(refresh);
  refresh();
  return { refresh };
}

{
  const saved = load(THEME_KEY);
  if (saved === "dark" || saved === "light" || saved === "auto") mode = saved;
  apply();
  darkQuery.addEventListener("change", () => {
    if (mode === "auto") apply();
  });
}
