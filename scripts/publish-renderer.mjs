#!/usr/bin/env node
/**
 * publish-renderer —— 把本仓库的 renderer/ 作为**唯一上游**发布给消费方
 * （主项目 WallpaperEM）。取代旧的 scripts/sync.mjs 双向 rsync。
 *
 * 与旧机制的本质区别：
 *   - 只有 publish（上游 → 下游）一个写方向。pull 已废除：把下游改动静默覆盖
 *     上游，是「逐字节副本」时代的产物；本仓库与主项目早已实质分叉
 *     （renderer.js 2269 vs 984 行），双向同步只会互相摧毁。
 *   - 每次发布在下游写 renderer/.upstream.json（来源仓库、git sha、时间戳、
 *     全部文件 sha256），下游从此能自证「我这份 renderer 来自哪个提交」。
 *   - 发布前校验两件事：
 *       a) 源工作区必须干净（--allow-dirty 可越过，但 sha 标记为 dirty）——
 *          否则 manifest 里的 git sha 指向一个不存在的干净状态；
 *       b) 下游 renderer 与上次发布的 manifest 有出入 = 有人在下游直接改了代码，
 *          拒绝发布（--force 可越过并打印差异）——上游单向发布的前提是下游只读。
 *
 * 用法：
 *   node scripts/publish-renderer.mjs diff                 只读对账（默认）
 *   node scripts/publish-renderer.mjs publish --yes        发布（必须显式确认）
 *   选项：--allow-dirty   源工作区脏时仍发布（manifest 标记 dirty:true）
 *         --force         下游有本地改动时仍发布（先打印差异）
 *
 * 下游路径默认取同级 ../WallpaperEM，可用 WALLPAPEREM 环境变量覆盖。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SELF = resolve(here, "..");
const MAIN = resolve(process.env.WALLPAPEREM ?? join(SELF, "..", "WallpaperEM"));
const SRC = join(SELF, "renderer");
const DST = join(MAIN, "renderer");
const MANIFEST = ".upstream.json";

const argv = process.argv.slice(2);
const action = argv.find((a) => !a.startsWith("-")) ?? "diff";
const opt = (name) => argv.includes(name);

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function currentGitState() {
  const sha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: SELF, encoding: "utf8" }).stdout.trim();
  const branch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: SELF, encoding: "utf8" }).stdout.trim();
  const dirty = spawnSync("git", ["status", "--porcelain"], { cwd: SELF, encoding: "utf8" }).stdout.trim().length > 0;
  return { sha, branch, dirty };
}

/** 下游相对上次 manifest 的漂移：返回被改动过的相对路径列表 */
function downstreamDrift() {
  const mf = join(DST, MANIFEST);
  if (!existsSync(mf)) return null; // 从未发布过
  let prev;
  try {
    prev = JSON.parse(readFileSync(mf, "utf8"));
  } catch {
    return ["<manifest 损坏>"];
  }
  const changed = [];
  const cur = new Map(walk(DST).map((p) => [relative(DST, p), p]));
  for (const [rel, hash] of Object.entries(prev.files ?? {})) {
    const p = join(DST, rel);
    if (!cur.has(rel)) changed.push(`${rel}（本地已删）`);
    else if (sha256(readFileSync(p)) !== hash) changed.push(`${rel}（本地已改）`);
  }
  for (const rel of cur.keys()) {
    if (!(rel in (prev.files ?? {})) && rel !== MANIFEST) changed.push(`${rel}（本地新增）`);
  }
  return changed;
}

if (!existsSync(join(MAIN, "src-tauri"))) {
  console.error(`✗ 找不到下游主项目（缺 src-tauri）：${MAIN}`);
  console.error("  用 WALLPAPEREM=/path/to/WallpaperEM 指定。");
  process.exit(1);
}

// ---------- diff ----------
if (action === "diff") {
  const drift = downstreamDrift();
  if (drift === null) {
    console.log("· 下游尚无 .upstream.json（从未发布过，或仍是旧 sync 时代的副本）");
  } else if (drift.length) {
    console.log(`✗ 下游相对上次发布有 ${drift.length} 处本地改动（上游不知情）：`);
    for (const d of drift.slice(0, 20)) console.log("   - " + d);
  } else {
    console.log("✓ 下游与上次发布的 manifest 一致（无人直接改过下游）");
  }
  const r = spawnSync("diff", ["-rq", SRC, DST], { encoding: "utf8" });
  if (r.stdout || r.stderr) {
    console.log(`\n── 内容差异（左=本仓库上游  右=下游）──`);
    process.stdout.write((r.stdout || "") + (r.stderr || ""));
    process.exit(1);
  }
  console.log("✓ 内容无差异");
  process.exit(0);
}

// ---------- publish ----------
if (action === "publish") {
  if (!opt("--yes")) {
    console.error("✗ 发布会整目录覆盖下游 renderer/（rsync --delete）。");
    console.error("  确认请加 --yes；先 diff 看清差异。");
    process.exit(1);
  }
  const git = currentGitState();
  if (git.dirty && !opt("--allow-dirty")) {
    console.error("✗ 本仓库工作区不干净，git sha 无法对应到干净状态。");
    console.error("  先提交，或用 --allow-dirty 强制（manifest 会标记 dirty:true）。");
    process.exit(1);
  }
  const drift = downstreamDrift();
  if (drift && drift.length && !opt("--force")) {
    console.error(`✗ 下游有 ${drift.length} 处上次发布之后的本地改动，直接覆盖会丢工作：`);
    for (const d of drift.slice(0, 20)) console.error("   - " + d);
    console.error("  确认放弃这些改动请加 --force（建议先 diff 记录）。");
    process.exit(1);
  }
  console.log(`发布：${SRC} → ${DST}`);
  spawnSync("rsync", ["-a", "--delete", "--exclude", MANIFEST, `${SRC}/`, `${DST}/`], {
    stdio: "inherit",
  });
  const files = {};
  for (const p of walk(DST)) {
    const rel = relative(DST, p);
    if (rel === MANIFEST) continue;
    files[rel] = sha256(readFileSync(p));
  }
  const manifest = {
    source: "we-scene-renderer",
    upstream: SELF,
    gitSha: git.sha,
    gitBranch: git.branch,
    dirty: git.dirty,
    publishedAt: new Date().toISOString(),
    fileCount: Object.keys(files).length,
    files,
  };
  writeFileSync(join(DST, MANIFEST), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`✓ 已发布 ${manifest.fileCount} 个文件（${git.branch}@${git.sha.slice(0, 10)}${git.dirty ? " + 本地改动" : ""}）`);
  console.log("提醒：请到主项目跑 pnpm typecheck，并实机验证壁纸窗口。");
  process.exit(0);
}

console.error(`未知动作：${action}（可用：diff / publish）`);
process.exit(1);
