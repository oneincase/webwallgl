#!/usr/bin/env node
/**
 * 把 media-bridge 预编译产物下载到 vendor/media-bridge/<os>-<arch>/，供 electron-builder 的 extraResources
 * 按目标平台 / 架构塞进安装包（Resources/media-bridge/）。版本与校验和见 host/media-bridge-release.mjs。
 *
 *   node scripts/fetch-media-bridge.mjs                    # 当前平台
 *   node scripts/fetch-media-bridge.mjs --platform linux   # mac | win | linux（CI 按矩阵传）
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MEDIA_BRIDGE_VERSION, downloadMediaBridge, mediaBridgeAsset, mediaBridgeSha256 } from "../host/media-bridge-release.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const OS_OF = { darwin: "mac", win32: "win", linux: "linux" };
const PLATFORM_OF = { mac: "darwin", win: "win32", linux: "linux" };

const i = process.argv.indexOf("--platform");
const os = i > 0 ? process.argv[i + 1] : OS_OF[process.platform];
const platform = PLATFORM_OF[os];
if (!platform) throw new Error(`--platform 只能是 mac / win / linux，收到：${os}`);

// 与 electron-builder.yml 里各平台打的架构一致
for (const arch of ["x64", "arm64"]) {
  const asset = mediaBridgeAsset(platform, arch, false);
  if (!asset) continue;
  const dest = join(root, "vendor", "media-bridge", `${os}-${arch}`, platform === "win32" ? "media-bridge.exe" : "media-bridge");
  const fresh = existsSync(dest) && createHash("sha256").update(readFileSync(dest)).digest("hex") === mediaBridgeSha256(asset);
  if (!fresh) await downloadMediaBridge(asset, dest);
  console.log(`${fresh ? "✓" : "↓"} ${os}-${arch}：media-bridge ${MEDIA_BRIDGE_VERSION}（${asset}）`);
}
