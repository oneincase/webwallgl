/**
 * media-bridge 预编译产物（github.com/oneincase/media-bridge 的 Release）：版本、校验和、平台映射、下载安装。
 * 运行时自动安装（host/app-entry.ts，装到 ~/.webwallgl/bin）与 CI 打包内置（scripts/fetch-media-bridge.mjs）共用这一份。
 *
 * 升级：改 MEDIA_BRIDGE_VERSION，并按新 Release 的 SHA256SUMS 更新 SHA256。
 * 校验和钉死在这里而不是现取 SHA256SUMS：和二进制同源下载的校验文件挡不住源被篡改。
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const MEDIA_BRIDGE_VERSION = "0.1.5";

const SHA256 = {
  "media-bridge-darwin-universal": "3b73d368ba49e803dd58587759c6253e2acdf87a34ff046a63ca90303bb0cb1a",
  "media-bridge-linux-arm64": "40368c1c94dc094fd98b1c7cc8ea08c03181112b8e084d7ec6da6368de430b4a",
  "media-bridge-linux-x64": "c88a52d5c45f479be25a00995228d538bfc1ca5d7c7bc144273841e99a079ced",
  "media-bridge-linux-x64-musl": "d97d02ad66f674cca170c9a69148e145baea87dbcceddbf75a3299b54835ebce",
  "media-bridge-win32-x64.exe": "61a7f6dd5d9b012aceebc4180d9b429b17cd519764c92ea217acf3e63407ee0c",
};

export const mediaBridgeSha256 = (asset) => SHA256[asset] ?? null;

/** 当前 Node 是否跑在 musl 上（Alpine 等）：没有 glibc 运行时版本即视为 musl */
function isMusl() {
  try {
    return !process.report?.getReport()?.header?.glibcVersionRuntime;
  } catch {
    return false;
  }
}

/**
 * 平台 → Release 产物名；没有对应产物返回 null。
 * Windows arm64 用 x64 版（系统自带 x64 仿真）；macOS 是 arm64 + x64 通用二进制。
 */
export function mediaBridgeAsset(platform = process.platform, arch = process.arch, musl = platform === "linux" && isMusl()) {
  if (platform === "darwin") return "media-bridge-darwin-universal";
  if (platform === "win32" && (arch === "x64" || arch === "arm64")) return "media-bridge-win32-x64.exe";
  if (platform === "linux" && arch === "x64") return musl ? "media-bridge-linux-x64-musl" : "media-bridge-linux-x64";
  if (platform === "linux" && arch === "arm64") return "media-bridge-linux-arm64";
  return null;
}

/** 下载地址；WWGL_MEDIA_BRIDGE_MIRROR 可指向镜像（目录下按产物名平铺） */
export function mediaBridgeUrl(asset) {
  const base =
    process.env.WWGL_MEDIA_BRIDGE_MIRROR?.replace(/\/+$/, "") ||
    `https://github.com/oneincase/media-bridge/releases/download/v${MEDIA_BRIDGE_VERSION}`;
  return `${base}/${asset}`;
}

/** 运行时自动安装的位置（文件名带版本：升级后旧版不会被误用） */
export function installedMediaBridgePath(platform = process.platform) {
  return join(homedir(), ".webwallgl", "bin", `media-bridge-${MEDIA_BRIDGE_VERSION}${platform === "win32" ? ".exe" : ""}`);
}

/** 下载 asset 到 dest：校验 SHA256、加可执行位；先写临时文件再改名，并发安装不会读到半个文件 */
export async function downloadMediaBridge(asset, dest) {
  const want = SHA256[asset];
  if (!want) throw new Error(`未知产物：${asset}`);
  const url = mediaBridgeUrl(asset);
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(180_000) });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}：${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = createHash("sha256").update(buf).digest("hex");
  if (got !== want) throw new Error(`校验和不符（${asset}）：期望 ${want}，实际 ${got}`);
  await mkdir(dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, buf);
    await chmod(tmp, 0o755);
    await rename(tmp, dest);
  } finally {
    await rm(tmp, { force: true });
  }
  return dest;
}

/** 已装就直接返回路径，否则下载安装；不支持的平台返回 null，下载失败抛错 */
export async function ensureMediaBridge() {
  const dest = installedMediaBridgePath();
  if (existsSync(dest)) return dest;
  const asset = mediaBridgeAsset();
  if (!asset) return null;
  return downloadMediaBridge(asset, dest);
}
