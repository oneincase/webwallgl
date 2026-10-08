#!/usr/bin/env node
/**
 * npm 发布桌面应用包 webwallgl-app（发布物是 `node scripts/build-app.mjs --npm` 组装的 app/）。
 *
 *   npm run publish:app                 # 构建 + 预检 + 发布
 *   npm run publish:app -- --dry-run    # 只看会发什么
 *   node scripts/publish-app.mjs --ci   # GitHub Actions 可信发布（OIDC），跳过登录检查
 *
 * 规则与 publish-npm.mjs 一致：显式走官方源、同版本不重发、预发布版本默认打 beta tag。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const appDir = join(root, "app");
const REGISTRY = "https://registry.npmjs.org/";
const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const ci = argv.includes("--ci");
const forceLatest = argv.includes("--latest");

const NEED = ["package.json", "cli.mjs", "main.mjs", "preload.cjs", "server.mjs", "web-shim.js", "site/editor/index.html", "README.md", "LICENSE"];
const missing = NEED.filter((f) => !existsSync(join(appDir, f)));
if (missing.length) throw new Error(`app/ 缺文件（先跑 node scripts/build-app.mjs --npm）：\n  ${missing.join("\n  ")}`);

const pkg = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8"));
if (!pkg.optionalDependencies?.electron) {
  throw new Error("app/package.json 不是 npm 形态（缺 optionalDependencies.electron）—— 用 --npm 重新组装");
}

let published = false;
try {
  execFileSync("npm", ["view", `${pkg.name}@${pkg.version}`, "version", "--registry", REGISTRY], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  published = true;
} catch {
  /* 404 = 未占用 */
}
if (published) throw new Error(`${pkg.name}@${pkg.version} 已发布过 —— 先升版本再发布`);

if (!dryRun && !ci) {
  try {
    const who = execFileSync("npm", ["whoami", "--registry", REGISTRY], { encoding: "utf8" }).trim();
    console.log(`npm 账号：${who}（registry.npmjs.org）`);
  } catch {
    throw new Error("未登录 npm 官方源 —— 先执行：npm login --registry https://registry.npmjs.org");
  }
}

const tag = pkg.version.includes("-") && !forceLatest ? "beta" : "latest";
const args = ["publish", appDir, "--access", "public", "--tag", tag, "--registry", REGISTRY];
if (dryRun) args.push("--dry-run");
console.log(`> npm ${args.join(" ")}\n`);
execFileSync("npm", args, { stdio: "inherit" });
if (!dryRun) console.log(`\n已发布 ${pkg.name}@${pkg.version}（tag: ${tag}）—— npx ${pkg.name}`);
