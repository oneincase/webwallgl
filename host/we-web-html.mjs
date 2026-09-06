/**
 * 网页壁纸 HTML 注入（host 侧）：读 renderer/src/web-shim.js，插入到 <head> 最前。
 * 不得 import renderer/src（verify-arch）；只按路径读文件。
 *
 * 与 renderer/src/web-rewrite.ts 的插入规则保持同构：优先 <head>，否则 <html> 后造 head。
 * 同源 /web/ 必须走原始 URL（不能 blob）：Spine/WebGL 贴图在 origin null 下会跨域脏画布。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SHIM_PATH = join(here, "..", "renderer", "src", "web-shim.js");
const SHIM_ATTR = "data-we-shim-src";
const SHIM_MARK = 'data-we-shim="1"';

let cachedShim = null;

export function loadWebShimSource() {
  // 每次读盘：shim 热改后 /web/ HTML 立刻生效（缓存曾导致 2905017768 黑屏修了仍黑）
  cachedShim = readFileSync(SHIM_PATH, "utf8");
  return cachedShim;
}

function escapeScriptClose(js) {
  return js.replace(/<\/script/gi, "<\\/script");
}

/**
 * @param {string} html
 * @param {{ shimSource?: string }} [opts]
 */
export function injectWebShim(html, opts = {}) {
  if (!html) html = "";
  if (html.includes(SHIM_MARK) || html.includes(SHIM_ATTR)) return html;
  const shimSource = opts.shimSource ?? loadWebShimSource();
  const script = `<script ${SHIM_ATTR}="1">\n${escapeScriptClose(shimSource)}\n</script>`;

  const headOpen = /<head(\s[^>]*)?>/i.exec(html);
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length;
    return html.slice(0, at) + script + html.slice(at);
  }
  const htmlOpen = /<html(\s[^>]*)?>/i.exec(html);
  if (htmlOpen) {
    const at = htmlOpen.index + htmlOpen[0].length;
    return html.slice(0, at) + `<head>${script}</head>` + html.slice(at);
  }
  return `<!DOCTYPE html><html><head>${script}</head><body>${html}</body></html>`;
}

export function isHtmlPath(filePath) {
  return /\.html?$/i.test(filePath);
}
