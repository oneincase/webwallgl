/**
 * 网页壁纸 HTML 改写：在作者脚本之前插入 WE shim + <base>。
 * 纯字符串操作，Node 可测（verify-web）。
 */

const SHIM_MARK = 'data-we-shim="1"';
const SHIM_ATTR = "data-we-shim-src";

/** 从入口 URL 推出目录（含末尾 /），供 <base href> */
export function entryDirUrl(entryUrl: string): string {
  try {
    const u = new URL(entryUrl);
    const path = u.pathname;
    const i = path.lastIndexOf("/");
    u.pathname = i < 0 ? "/" : path.slice(0, i + 1);
    u.hash = "";
    u.search = "";
    return u.href;
  } catch {
    const s = entryUrl.replace(/[#?].*$/, "");
    const i = s.lastIndexOf("/");
    return i < 0 ? s : s.slice(0, i + 1);
  }
}

/**
 * 是否已含会挡住 inline shim 的 CSP（script-src 无 unsafe-inline）。
 * 工坊网页壁纸几乎没有 CSP；命中则调用方应走诊断并退回裸 src。
 */
export function hasBlockingCsp(html: string): boolean {
  const re = /<meta[^>]+http-equiv\s*=\s*["']?Content-Security-Policy["']?[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const content =
      /content\s*=\s*"([^"]*)"/i.exec(tag)?.[1] ??
      /content\s*=\s*'([^']*)'/i.exec(tag)?.[1] ??
      "";
    if (!/script-src/i.test(content)) continue;
    if (/script-src[^;]*'unsafe-inline'/i.test(content)) continue;
    if (/script-src[^;]*\*/i.test(content)) continue;
    return true;
  }
  return false;
}

function escapeScriptClose(js: string): string {
  // 防止 shim 源码里的 </script> 提前结束宿主 script 标签
  return js.replace(/<\/script/gi, "<\\/script");
}

/**
 * 把 shim 源码与可选 <base> / 种子脚本插入 HTML。
 * 已注入（含 data-we-shim）则原样返回。
 *
 * `seedScript`：紧跟 shim 的 classic script 正文（如 `__weSeedProps(...)`），
 * 在作者脚本之前执行，解决「父页 load 后再灌属性已晚」的时序。
 */
export function rewriteHtml(
  html: string,
  shimSource: string,
  opts: { baseHref?: string; seedScript?: string },
): string {
  if (!html) html = "";
  if (html.includes(SHIM_MARK) || html.includes(SHIM_ATTR)) return html;

  const base =
    opts.baseHref && !/<base\b/i.test(html)
      ? `<base href="${opts.baseHref.replace(/"/g, "&quot;")}">`
      : "";
  const script =
    `<script ${SHIM_ATTR}="1">\n${escapeScriptClose(shimSource)}\n</script>`;
  const seed =
    opts.seedScript && opts.seedScript.trim()
      ? `<script>\n${escapeScriptClose(opts.seedScript)}\n</script>`
      : "";
  const inject = `${base}${script}${seed}`;

  // 优先插进 <head> 最前（任何作者 script 之前）
  const headOpen = /<head(\s[^>]*)?>/i.exec(html);
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length;
    return html.slice(0, at) + inject + html.slice(at);
  }

  // 无 head：在 <html> 后造一个 head
  const htmlOpen = /<html(\s[^>]*)?>/i.exec(html);
  if (htmlOpen) {
    const at = htmlOpen.index + htmlOpen[0].length;
    return html.slice(0, at) + `<head>${inject}</head>` + html.slice(at);
  }

  // 残缺 HTML：整段前缀
  return `<!DOCTYPE html><html><head>${inject}</head><body>${html}</body></html>`;
}
