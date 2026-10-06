/**
 * 运行环境探测：平台（macOS 与否）与宿主（浏览器 / Electron）。
 * 结果写成 <body> 的 class，样式据此给 Electron 的原生红绿灯让位等。
 */

const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";

export const isMac = /mac|iphone|ipad/i.test(
  (typeof navigator !== "undefined" && (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform) ||
    (typeof navigator !== "undefined" && navigator.platform) ||
    ua,
);

/**
 * 是否跑在自家桌面壳里。不能按 UA 里的 "Electron/" 判断 —— 很多 IDE 内置浏览器
 * 本身就是 Electron，会误给标题栏留出红绿灯位置。桌面壳的 preload 负责注入
 * `window.webwallglDesktop`（或 UA 追加 "WebWallGL-Desktop/"）。
 */
export const isElectron =
  (typeof window !== "undefined" && !!(window as Window & { webwallglDesktop?: unknown }).webwallglDesktop) ||
  /\bWebWallGL-Desktop\//.test(ua);

export function applyPlatformClasses(target: HTMLElement = document.body) {
  target.classList.toggle("platform-mac", isMac);
  target.classList.toggle("platform-other", !isMac);
  target.classList.toggle("is-electron", isElectron);
}

/** "mod+shift+o" → macOS「⇧⌘O」/ 其他「Ctrl+Shift+O」 */
export function formatShortcut(keys: string): string {
  const parts = keys.toLowerCase().split("+");
  const key = parts.pop() ?? "";
  const label = key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1);
  if (isMac) {
    const sym: Record<string, string> = { mod: "⌘", shift: "⇧", alt: "⌥", ctrl: "⌃" };
    const order = ["ctrl", "alt", "shift", "mod"];
    return order.filter((m) => parts.includes(m)).map((m) => sym[m]).join("") + label;
  }
  const name: Record<string, string> = { mod: "Ctrl", shift: "Shift", alt: "Alt", ctrl: "Ctrl" };
  return [...parts.map((m) => name[m] ?? m), label].join("+");
}

export function matchShortcut(ev: KeyboardEvent, keys: string): boolean {
  const parts = keys.toLowerCase().split("+");
  const key = parts.pop() ?? "";
  const mod = isMac ? ev.metaKey : ev.ctrlKey;
  if (parts.includes("mod") !== mod) return false;
  if (parts.includes("shift") !== ev.shiftKey) return false;
  if (parts.includes("alt") !== ev.altKey) return false;
  return ev.key.toLowerCase() === key;
}
