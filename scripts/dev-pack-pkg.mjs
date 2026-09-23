#!/usr/bin/env node
// 把本地散装目录打包成 WE scene.pkg 容器（PKGV0012），供 headless 实测用。
// 格式见 renderer/vendor/we-scene/pkg/container.js parsePkg：
//   u32 magicLen(8) + "PKGV0012" + u32 count + entries{u32 nameLen, name, u32 offset, u32 size} + data
// 用法：node scripts/dev-pack-pkg.mjs <srcDir> <outPkg>
import fs from "node:fs";
import path from "node:path";

const [srcDir, outFile] = process.argv.slice(2);
if (!srcDir || !outFile) {
  console.error("用法: node scripts/dev-pack-pkg.mjs <srcDir> <outPkg>");
  process.exit(1);
}

const files = [];
(function walk(dir, rel) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const r = rel ? `${rel}/${name}` : name;
    if (fs.statSync(p).isDirectory()) walk(p, r);
    else if (!name.endsWith(".pkg")) files.push({ rel: r, abs: p });
  }
})(srcDir, "");

files.sort((a, b) => a.rel.localeCompare(b.rel));
const nameBuf = (f) => Buffer.from(f.rel, "utf8");
const headerSize =
  4 + 8 + 4 + files.reduce((n, f) => n + 4 + nameBuf(f).length + 8, 0);

const chunks = [];
let offset = 0;
const entries = [];
for (const f of files) {
  const data = fs.readFileSync(f.abs);
  entries.push({ nameLen: nameBuf(f).length, name: nameBuf(f), offset, size: data.length });
  chunks.push(data);
  offset += data.length;
}

const parts = [];
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v, 0); return b; };
parts.push(u32(8), Buffer.from("PKGV0012", "ascii"), u32(files.length));
for (const e of entries) parts.push(u32(e.nameLen), e.name, u32(e.offset), u32(e.size));
parts.push(...chunks);
fs.writeFileSync(outFile, Buffer.concat(parts));
console.log(`packed ${files.length} files, ${offset} bytes data -> ${outFile}`);
