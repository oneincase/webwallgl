#!/usr/bin/env node
/** `pnpm desktop`：确认 Electron 二进制已下载（pnpm 可能跳过了它的 postinstall），再启动桌面壳。 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const pkgDir = dirname(require.resolve("electron/package.json"));

const binary = () => {
  const p = join(pkgDir, "path.txt");
  if (!existsSync(p)) return null;
  const bin = join(pkgDir, "dist", readFileSync(p, "utf8").trim());
  return existsSync(bin) ? bin : null;
};

if (!binary()) {
  console.log("[desktop] Electron 二进制缺失，正在下载…");
  const r = spawnSync(process.execPath, [join(pkgDir, "install.js")], { stdio: "inherit", cwd: pkgDir });
  if (r.status !== 0 || !binary()) {
    console.error("[desktop] Electron 下载失败，请检查网络后重试");
    process.exit(1);
  }
}

const child = spawn(binary(), [join(ROOT, "desktop/main.mjs"), ...process.argv.slice(2)], { stdio: "inherit", cwd: ROOT });
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
