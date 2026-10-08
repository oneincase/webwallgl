// 极简 XML 解析（DAE 用；编辑器模块要能在 Node 里跑回归，不能依赖 DOMParser）。
// 只保留元素 / 属性 / 文本；注释、PI、DOCTYPE 跳过，CDATA 并入文本；标签名去掉命名空间前缀。

export type XEl = { tag: string; attrs: Record<string, string>; kids: XEl[]; text: string; parent: XEl | null };

const ENT: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
const unescape = (s: string) =>
  s.indexOf("&") < 0
    ? s
    : s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
        if (e[0] === "#") {
          const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
          return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
        }
        return ENT[e] ?? m;
      });

const local = (n: string) => {
  const i = n.indexOf(":");
  return i >= 0 ? n.slice(i + 1) : n;
};

export function parseXml(src: string): XEl {
  const root: XEl = { tag: "#root", attrs: {}, kids: [], text: "", parent: null };
  let cur = root;
  const textParts = new Map<XEl, string[]>();
  const addText = (s: string) => {
    if (!s) return;
    let a = textParts.get(cur);
    if (!a) textParts.set(cur, (a = []));
    a.push(s);
  };
  const attrRe = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let i = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf("<", i);
    if (lt < 0) {
      addText(unescape(src.slice(i)));
      break;
    }
    if (lt > i) addText(unescape(src.slice(i, lt)));
    if (src.startsWith("<!--", lt)) {
      const e = src.indexOf("-->", lt + 4);
      i = e < 0 ? n : e + 3;
    } else if (src.startsWith("<![CDATA[", lt)) {
      const e = src.indexOf("]]>", lt + 9);
      addText(src.slice(lt + 9, e < 0 ? n : e));
      i = e < 0 ? n : e + 3;
    } else if (src[lt + 1] === "?") {
      const e = src.indexOf("?>", lt + 2);
      i = e < 0 ? n : e + 2;
    } else if (src[lt + 1] === "!") {
      // DOCTYPE（可能带 [内部子集]）
      let depth = 0;
      let j = lt + 2;
      for (; j < n; j++) {
        if (src[j] === "[") depth++;
        else if (src[j] === "]") depth--;
        else if (src[j] === ">" && depth <= 0) break;
      }
      i = j + 1;
    } else if (src[lt + 1] === "/") {
      const e = src.indexOf(">", lt + 2);
      const name = local(src.slice(lt + 2, e < 0 ? n : e).trim());
      // 容错：向上找到同名元素再闭合
      let p: XEl | null = cur;
      while (p && p !== root && p.tag !== name) p = p.parent;
      if (p && p !== root) cur = p.parent!;
      i = e < 0 ? n : e + 1;
    } else {
      // 开始标签：属性值里可能有 '>'，按引号扫描
      let j = lt + 1;
      let q = "";
      for (; j < n; j++) {
        const c = src[j];
        if (q) {
          if (c === q) q = "";
        } else if (c === '"' || c === "'") q = c;
        else if (c === ">") break;
      }
      const body = src.slice(lt + 1, j);
      const selfClose = body.endsWith("/");
      const inner = selfClose ? body.slice(0, -1) : body;
      const sp = inner.search(/[\s/]/);
      const tag = local(sp < 0 ? inner : inner.slice(0, sp));
      const el: XEl = { tag, attrs: {}, kids: [], text: "", parent: cur };
      if (sp >= 0) {
        attrRe.lastIndex = 0;
        const rest = inner.slice(sp);
        for (let m = attrRe.exec(rest); m; m = attrRe.exec(rest)) el.attrs[local(m[1])] = unescape(m[3] ?? m[4] ?? "");
      }
      cur.kids.push(el);
      if (!selfClose) cur = el;
      i = j + 1;
    }
  }
  for (const [el, parts] of textParts) el.text = parts.join("");
  return root;
}

export const child = (e: XEl | null | undefined, tag: string): XEl | null => e?.kids.find((k) => k.tag === tag) ?? null;
export const children = (e: XEl | null | undefined, tag: string): XEl[] => e?.kids.filter((k) => k.tag === tag) ?? [];

export function* walk(e: XEl): Generator<XEl> {
  const stack = [e];
  while (stack.length) {
    const x = stack.pop()!;
    yield x;
    for (let k = x.kids.length - 1; k >= 0; k--) stack.push(x.kids[k]);
  }
}

export const numbers = (s: string): number[] => {
  const t = s.trim();
  return t ? t.split(/\s+/).map(Number) : [];
};
