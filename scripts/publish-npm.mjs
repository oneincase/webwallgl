#!/usr/bin/env node
/**
 * npm 发布：发布物就是 build:lib 产出的 dist/lib/（三包产物：播放包 ES+UMD ×4、
 * 公共包/编辑器包各 ESM ×2，全部带 sourcemap；+ 类型 + README 使用说明 + LICENSE
 * + 收款码图。三包形态见 docs/EDITOR-PLAN.md §0.5）。
 *
 *   npm run publish:npm                 # 构建 + 预检 + 发布
 *   npm run publish:npm -- --dry-run    # 只看会发什么，不真发
 *   npm run publish:npm -- --latest     # 预发布版本也打 latest tag（默认打 beta）
 *
 * CI（GitHub Actions 打标签触发）：node scripts/publish-npm.mjs --ci
 *   走 npm 可信发布（Trusted Publishing / OIDC）：不查登录、不落长期 token，
 *   发布时由 npm 用 GitHub OIDC 现场换取短期凭证；npmjs 上登记的工作流
 *   文件名必须与触发本命令的 workflow 一致，且 npm >= 11.5.1。
 *
 * 前置（本机一次性）：npm login --registry https://registry.npmjs.org 完成浏览器授权。
 * 注意：本机 ~/.npmrc 默认走 npmmirror 镜像（装包用），镜像站不能发布，
 * 本脚本所有 registry 调用都显式指定官方源，不影响日常装包。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const libDir = join(root, "dist", "lib");
const REGISTRY = "https://registry.npmjs.org/";
const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const forceLatest = argv.includes("--latest");
const ci = argv.includes("--ci");

// ---- 预检 1：发布物完整（缺任何一件都不发）----
const pkg = JSON.parse(readFileSync(join(libDir, "package.json"), "utf8"));
const NEED = [
  "webwallgl.mjs",
  "webwallgl.min.mjs",
  "webwallgl.global.js",
  "webwallgl.global.min.js",
  "webwallgl-core.mjs",
  "webwallgl-core.min.mjs",
  "webwallgl-editor.mjs",
  "webwallgl-editor.min.mjs",
  "webwallgl.d.ts",
  "core.d.ts",
  "editor.d.ts",
  "types.d.ts",
  "README.md",
  "README.en.md",
  "LICENSE",
  "imgs/wechat.png",
  "imgs/alipay.png",
];
const missing = NEED.filter((f) => !existsSync(join(libDir, f)));
if (missing.length) throw new Error(`dist/lib 缺文件（先跑 npm run build:lib）：\n  ${missing.join("\n  ")}`);

// ---- 预检 2：registry 上没有同名版本（npm 会拒，这里提前给可读报错）----
let published = false;
try {
  execFileSync("npm", ["view", `${pkg.name}@${pkg.version}`, "version", "--registry", REGISTRY], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  published = true;
} catch {
  /* 404 = 未占用，正常 */
}
if (published) {
  throw new Error(`webwallgl@${pkg.version} 已发布过 —— npm 不允许同版本覆盖，先升版本再发布`);
}

if (dryRun) {
  console.log(`--dry-run：跳过登录检查，只看打包清单（webwallgl@${pkg.version}）`);
} else if (ci) {
  // 可信发布：凭证在 publish 时用 GitHub OIDC 现场换取，whoami 无从验证；
  // 发布者身份由 npmjs 的 Trusted Publisher 登记（仓库 + 工作流文件名）保证。
  console.log("CI 可信发布：跳过登录预检（OIDC 在 publish 时换取短期凭证）");
} else {
  // ---- 预检 3：已登录 npm（官方源）----
  try {
    const who = execFileSync("npm", ["whoami", "--registry", REGISTRY], { encoding: "utf8" }).trim();
    console.log(`npm 账号：${who}（registry.npmjs.org）`);
  } catch {
    throw new Error("未登录 npm 官方源 —— 先执行：npm login --registry https://registry.npmjs.org");
  }
}

// ---- dist-tag：预发布版本（1.0.0-beta1 这类）默认打 beta，避免 npm i webwallgl 拉到测试版 ----
const pre = pkg.version.includes("-");
const tag = pre && !forceLatest ? "beta" : "latest";
if (pre) {
  console.log(
    forceLatest
      ? `预发布版本 ${pkg.version}，按 --latest 要求打 latest tag`
      : `预发布版本 ${pkg.version} → dist-tag beta（用户装 npm i webwallgl@beta；正式 latest 待 1.0.0）`,
  );
}

const args = ["publish", libDir, "--access", "public", "--tag", tag, "--registry", REGISTRY];
if (dryRun) args.push("--dry-run");
console.log(`> npm ${args.map((a) => (/[\s/]/.test(a) ? JSON.stringify(a) : a)).join(" ")}\n`);
execFileSync("npm", args, { stdio: "inherit" });
if (!dryRun) {
  console.log(`\n已发布 webwallgl@${pkg.version}（tag: ${tag}）`);
  console.log(`  npm: https://www.npmjs.com/package/webwallgl`);
  console.log(`  jsDelivr CDN: https://cdn.jsdelivr.net/npm/webwallgl@${pkg.version}/webwallgl.global.min.js`);
}
