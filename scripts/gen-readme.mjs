#!/usr/bin/env node
/**
 * README 生成器：README = 控制台「使用说明」标签页。
 *
 * 唯一真源是 bench/docs.ts 的 DOC（结构化双语）与 bench/i18n.ts 的赞赏文案；
 * 本脚本把它们原样转成 Markdown，写出 README.md（中文）与 README.en.md（English）。
 * 改文档只改 bench/docs.ts，然后 `pnpm gen:readme`（export:github 导出前也会自动重跑）。
 *
 * 赞赏二维码在下方 SPONSOR 维护（控制台卡片在 index.html #sponsor-card，两处同步改）；
 * 图片放 public/imgs/，文件名用纯 ASCII。海外收款码后期在 SPONSOR 与 index.html
 * 各加一项即可。
 */
import esbuild from "esbuild";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// 必须用 fileURLToPath：`.pathname` 在 Windows 上会给出 "/D:/a/..." 这种带前导
// 斜杠的路径，再经 path.join 变成 "\D:\a\..."，esbuild 会报
// `Could not resolve "\\D:\...\bench\docs.ts"`（CI 的 Windows 构建就是这样挂的）。
const root = fileURLToPath(new URL("..", import.meta.url));

// bench/docs.ts 与 bench/i18n.ts 是带类型的浏览器模块（i18n 顶层碰 document，
// 已加环境守卫），用 esbuild 打包成 Node 可导入的临时 mjs，读完即删。
async function bundleMod(entry) {
  const outfile = join(root, "scripts", "_gen-readme", entry.replace(/\.ts$/, ".mjs"));
  await esbuild.build({
    entryPoints: [join(root, "bench", entry)],
    outfile,
    bundle: true,
    format: "esm",
    platform: "browser",
    logLevel: "silent",
  });
  return import(pathToFileURL(outfile).href);
}

let docs, i18n;
try {
  docs = await bundleMod("docs.ts");
  i18n = await bundleMod("i18n.ts");
} finally {
  rmSync(join(root, "scripts", "_gen-readme"), { recursive: true, force: true });
}

// 赞赏收款码清单（与 index.html #sponsor-card 保持一致；key 取 bench/i18n.ts 文案）。
// README 必须用绝对 URL：npm 渲染 README 时不带仓库文件上下文，相对路径图片会裂；
// raw.githubusercontent.com 在 GitHub 与 npm 上都能正常显示。
const SPONSOR_REPO_RAW = "https://raw.githubusercontent.com/oneincase/webwallgl/main";
const SPONSOR = [
  { key: "sponsor.wechat", img: `${SPONSOR_REPO_RAW}/public/imgs/wechat.png`, alt: { zh: "微信支付赞赏码", en: "WeChat Pay QR code" } },
  { key: "sponsor.alipay", img: `${SPONSOR_REPO_RAW}/public/imgs/alipay.png`, alt: { zh: "支付宝赞赏码", en: "Alipay QR code" } },
];

// 正文（非代码块）里的裸 HTML 标签（<script>、<input type=file> 等）会被
// GitHub 的 sanitizer 直接吞掉，转成实体保住字面文本
const esc = (s) => s.replace(/</g, "&lt;");

function renderMd(lang) {
  const zh = lang === "zh";
  const lines = [];
  lines.push(
    zh ? "# WebWallGL —— 浏览器端 WE 场景壁纸渲染库" : "# WebWallGL — Wallpaper Engine scene renderer for the browser",
    "",
    zh ? "**[简体中文](README.md) ｜ [English](README.en.md)**" : "**[简体中文](README.md) | [English](README.en.md)**",
    "",
  );
  for (const sec of docs.DOC) {
    lines.push(`## ${sec.title[lang]}`, "");
    for (const b of sec.blocks) {
      if (b.k === "p") {
        lines.push(esc(b.v[lang]), "");
      } else if (b.k === "code") {
        lines.push("```", b.v[lang], "```", "");
      } else if (b.k === "ul") {
        for (const it of b.items) lines.push(`- ${esc(it[lang])}`);
        lines.push("");
      } else if (b.k === "links") {
        for (const it of b.items) lines.push(`- [${esc(it.label[lang])}](${it.href})`);
        lines.push("");
      } else {
        lines.push(`| ${b.head.map((h) => esc(h[lang])).join(" | ")} |`);
        lines.push(`| ${b.head.map(() => "---").join(" | ")} |`);
        for (const row of b.rows) {
          lines.push(
            `| ${row
              .map((c, ci) => (b.codeCols?.includes(ci) ? `\`${c[lang]}\`` : esc(c[lang])))
              .join(" | ")} |`,
          );
        }
        lines.push("");
      }
    }
  }
  // 赞赏：与控制台文档页底部的赞赏卡片同一段文案（bench/i18n.ts）
  lines.push(`## ${i18n.DICT[lang]["sponsor.title"]}`, "");
  lines.push(i18n.DICT[lang]["sponsor.text"], "");
  lines.push(`| ${SPONSOR.map((s) => i18n.DICT[lang][s.key]).join(" | ")} |`);
  lines.push(`| ${SPONSOR.map(() => "---").join(" | ")} |`);
  lines.push(`| ${SPONSOR.map((s) => `![${s.alt[lang]}](${s.img})`).join(" | ")} |`);
  lines.push("");
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

writeFileSync(join(root, "README.md"), renderMd("zh"));
writeFileSync(join(root, "README.en.md"), renderMd("en"));
console.log("README.md / README.en.md 已从 bench/docs.ts 重新生成");
