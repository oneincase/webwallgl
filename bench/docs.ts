// 使用说明的数据模型与渲染器（工作台中栏「使用说明」标签页）。
// 内容分两份：docs-library.ts（播放库）与 docs-editor.ts（编辑器），改文案只动对应文件。

import type { Lang } from "./i18n";
import { LIBRARY_DOC } from "./docs-library";
import { EDITOR_DOC } from "./docs-editor";

export type Bi = { zh: string; en: string };
export type DocBlock =
  | { k: "p"; v: Bi }
  | { k: "code"; v: Bi }
  | { k: "ul"; items: Bi[] }
  | { k: "links"; items: { label: Bi; href: string }[] }
  | { k: "table"; head: Bi[]; rows: Bi[][]; codeCols?: number[] };

export type DocSection = { id: string; title: Bi; blocks: DocBlock[] };

export type DocKind = "library" | "editor";
export const DOC_KINDS: DocKind[] = ["library", "editor"];

const DOCS: Record<DocKind, DocSection[]> = { library: LIBRARY_DOC, editor: EDITOR_DOC };

/** 把文档渲染进容器；语言切换时重新渲染 */
export function renderDocs(body: HTMLElement, kind: DocKind, lang: Lang) {
  body.textContent = "";
  for (const sec of DOCS[kind]) {
    const h2 = document.createElement("h2");
    h2.id = `doc-${sec.id}`;
    h2.textContent = sec.title[lang];
    body.appendChild(h2);
    for (const b of sec.blocks) {
      if (b.k === "p") {
        const p = document.createElement("p");
        p.textContent = b.v[lang];
        body.appendChild(p);
      } else if (b.k === "code") {
        const pre = document.createElement("pre");
        pre.className = "doc-code";
        pre.textContent = b.v[lang];
        body.appendChild(pre);
      } else if (b.k === "ul") {
        const ul = document.createElement("ul");
        for (const it of b.items) {
          const li = document.createElement("li");
          li.textContent = it[lang];
          ul.appendChild(li);
        }
        body.appendChild(ul);
      } else if (b.k === "links") {
        const p = document.createElement("p");
        p.className = "doc-links";
        b.items.forEach((it, i) => {
          if (i > 0) p.appendChild(document.createTextNode(" · "));
          const a = document.createElement("a");
          a.href = it.href;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          a.textContent = it.label[lang];
          p.appendChild(a);
        });
        body.appendChild(p);
      } else {
        const table = document.createElement("table");
        table.className = "doc-table";
        const thead = document.createElement("thead");
        const trh = document.createElement("tr");
        for (const h of b.head) {
          const th = document.createElement("th");
          th.textContent = h[lang];
          trh.appendChild(th);
        }
        thead.appendChild(trh);
        table.appendChild(thead);
        const tbody = document.createElement("tbody");
        for (const row of b.rows) {
          const tr = document.createElement("tr");
          row.forEach((cell, ci) => {
            const td = document.createElement("td");
            if (b.codeCols?.includes(ci)) {
              const code = document.createElement("code");
              code.textContent = cell[lang];
              td.appendChild(code);
            } else {
              td.textContent = cell[lang];
            }
            tr.appendChild(td);
          });
          tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        body.appendChild(table);
      }
    }
  }
}
