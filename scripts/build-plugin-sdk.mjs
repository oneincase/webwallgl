#!/usr/bin/env node
/**
 * build-plugin-sdk —— 插件 SDK 与示例插件的构建（PLUGIN-ARCHITECTURE §6）。
 *
 *   node scripts/build-plugin-sdk.mjs             构建 examples/plugins/<x>/src/index.ts → index.js，并出 dist/plugin-sdk
 *   node scripts/build-plugin-sdk.mjs --examples  只构建示例插件
 *   node scripts/build-plugin-sdk.mjs --check     示例的 index.js 与源码重建结果不一致就失败（verify 用）
 *   node scripts/build-plugin-sdk.mjs --plugin <dir>  构建任意一个插件目录（第三方插件作者用）
 *
 * 插件入口必须打成**单文件 ESM**（编辑器以 Blob URL import，没有相对路径可解析）。
 * 只允许从 editor/sdk 取东西（类型全部擦除，运行时只有 definePlugin 这类恒等函数）；
 * 任何指向编辑器 / 渲染器真源的运行时 import 直接报错 —— 那样会把第二份注册表打进插件，绕过权限门控。
 */
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SDK_ENTRY = path.join(ROOT, "editor/sdk/index.ts");
const EXAMPLES = path.join(ROOT, "examples/plugins");
const BANNER = "// 由 scripts/build-plugin-sdk.mjs 从 src/index.ts 生成，勿手改。\n";

const guard = {
  name: "wwgl-plugin-guard",
  setup(b) {
    b.onResolve({ filter: /.*/ }, (a) => {
      if (a.kind === "entry-point") return undefined;
      if (!a.path.startsWith(".") && !a.path.startsWith("/")) {
        return { errors: [{ text: `插件只能打成单文件：不允许运行时依赖 ${a.path}（第三方库请内联进源码或先打包）` }] };
      }
      const full = path.resolve(a.resolveDir, a.path);
      const rel = path.relative(ROOT, full).split(path.sep).join("/");
      const inRepo = !rel.startsWith("..");
      if (inRepo && /^(editor|renderer|bench|shared|host)\//.test(rel) && !/^editor\/sdk(\/index(\.ts)?)?$/.test(rel)) {
        return { errors: [{ text: `插件不得在运行时 import 编辑器真源 ${rel}（只从 editor/sdk 取类型，能力经 ctx.get）` }] };
      }
      return undefined;
    });
  },
};

/** 构建一个插件目录的 src/index.ts，返回单文件 ESM 源码 */
export async function buildPluginCode(dir) {
  const entry = ["src/index.ts", "src/index.js"].map((p) => path.join(dir, p)).find((p) => fs.existsSync(p));
  if (!entry) throw new Error(`${dir}：没有 src/index.ts`);
  const out = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    charset: "utf8",
    legalComments: "none",
    plugins: [guard],
    logLevel: "silent",
  });
  return BANNER + out.outputFiles[0].text;
}

/** 示例插件里有代码入口的目录 */
export function codeExamples() {
  if (!fs.existsSync(EXAMPLES)) return [];
  return fs
    .readdirSync(EXAMPLES)
    .map((d) => path.join(EXAMPLES, d))
    .filter((d) => {
      const mf = path.join(d, "wwgl-plugin.json");
      return fs.existsSync(mf) && !!JSON.parse(fs.readFileSync(mf, "utf8")).main;
    });
}

async function buildExamples(check) {
  let bad = 0;
  for (const dir of codeExamples()) {
    const main = JSON.parse(fs.readFileSync(path.join(dir, "wwgl-plugin.json"), "utf8")).main;
    const target = path.join(dir, main);
    const code = await buildPluginCode(dir);
    const rel = path.relative(ROOT, target);
    if (check) {
      const cur = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
      if (cur !== code) {
        bad++;
        console.log(`  ✗ ${rel} 与 src 重建结果不一致（跑 node scripts/build-plugin-sdk.mjs --examples）`);
      } else console.log(`  ✓ ${rel}`);
    } else {
      fs.writeFileSync(target, code);
      console.log(`  → ${rel}`);
    }
  }
  return bad;
}

function buildSdk() {
  const out = path.join(ROOT, "dist/plugin-sdk");
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const tsconfig = path.join(out, "tsconfig.sdk.json");
  fs.writeFileSync(
    tsconfig,
    JSON.stringify({
      extends: path.join(ROOT, "tsconfig.json"),
      compilerOptions: { noEmit: false, declaration: true, emitDeclarationOnly: true, outDir: path.join(out, "types"), rootDir: ROOT, skipLibCheck: true },
      files: [SDK_ENTRY],
      include: [],
    }),
  );
  execFileSync(process.execPath, [path.join(ROOT, "node_modules/typescript/bin/tsc"), "-p", tsconfig], { stdio: "inherit" });
  fs.rmSync(tsconfig);
  fs.writeFileSync(path.join(out, "index.d.ts"), `export * from "./types/editor/sdk/index";\n`);
  fs.writeFileSync(path.join(out, "index.js"), "export function definePlugin(p) {\n  return p;\n}\n");
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  fs.writeFileSync(
    path.join(out, "package.json"),
    JSON.stringify({ name: "@webwallgl/plugin-sdk", version: pkg.version ?? "0.0.0", type: "module", main: "index.js", types: "index.d.ts", sideEffects: false }, null, 2) + "\n",
  );
  console.log(`  → ${path.relative(ROOT, out)}`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const args = process.argv.slice(2);
  const pi = args.indexOf("--plugin");
  if (pi >= 0) {
    const dir = path.resolve(args[pi + 1] ?? ".");
    const main = JSON.parse(fs.readFileSync(path.join(dir, "wwgl-plugin.json"), "utf8")).main ?? "index.js";
    fs.writeFileSync(path.join(dir, main), await buildPluginCode(dir));
    console.log(`  → ${path.join(dir, main)}`);
  } else if (args.includes("--check")) {
    const bad = await buildExamples(true);
    process.exit(bad ? 1 : 0);
  } else {
    await buildExamples(false);
    if (!args.includes("--examples")) buildSdk();
  }
}
