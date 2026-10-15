/**
 * §8.2 L6：`editor/draft.ts` 的 `info()` 读放大（task-30 泳道 3 / A）
 *
 * 用法：`node scripts/verify-draft.mjs`（纯 Node，不需要 vite/Chrome）
 *
 * 被判定的事实：`info()`（= `DraftStore.list()`）只需要每个槽的 `savedAt` / `bytes`，
 * 旧实现为此把**整份草稿**读出来再 `decodeDraft`；而 `save()` 末尾的 `evict(await info())`
 * 让这条路径每次自动保存都跑一遍（8 槽 × 单槽上限 32MB ⇒ 最坏 256MB/次）。
 * 本判据证明三件事：
 *   1. meta 齐全时 `list()` 只读 meta（读字节 < 草稿全量的 1/10，且**不是 0 次**）；
 *   2. meta 缺失（老草稿 / 别的写入者 / 坏 meta）时**回落**到整份读 + decode，
 *      槽不会从列表里消失（DRAFT-2 断言的槽序与 savedAt 语义不变）；
 *   3. clear / 淘汰时 meta 与草稿同批删，不留孤儿键。
 *
 * 打包口径与 `scripts/verify-editor.mjs` 的 `loadEditorModule` 一致：editor 侧的公共出口
 * `renderer/src/api/editor` 替成实现模块（只换解析路径，不换被测代码）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { ROOT } from "./lib/verify-kit.mjs";

const J = (v) => JSON.stringify(v);
let passed = 0;
let failed = 0;
const check = (ok, msg) => {
  if (ok) passed++;
  else failed++;
  (ok ? console.log : console.error)(`  ${ok ? "✓" : "✗"} ${msg}`);
};
const section = (t) => console.log(`\n${t}`);
const sha256 = (p) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");

const DRAFT_REL = "editor/draft.ts";
const VDIR_REL = "editor/vdir.ts";
const DRAFT_PATH = path.join(ROOT, DRAFT_REL);

// ───────────────────────────────────────────────────────────────────────────
// 模块装载：editor/*.ts 真跑（esbuild 就地打包，mutate = [[源串, 替换串, 期望命中数?], …]）
// ───────────────────────────────────────────────────────────────────────────
const aliasContents = [
  `export * from ${J(path.join(ROOT, "renderer/src/api/source.ts"))};`,
  `export { createMediaSource, mediaColor } from ${J(path.join(ROOT, "renderer/src/api/media-source.ts"))};`,
  `export { buildScenePkg } from ${J(path.join(ROOT, "renderer/src/editor/pkg-export.ts"))};`,
  `export { checkWeCompat } from ${J(path.join(ROOT, "renderer/src/editor/compat.ts"))};`,
  `export { encodeMdl, mdlMeshMaterials, retargetMdlMaterial, mdlClips, applyBoneDelta, boneDeltaWeights, CLIP_MODES, resampleTrack, addMdlClip, removeMdlClip, setMdlClipMeta, setMdlClipEvents } from ${J(path.join(ROOT, "renderer/src/editor/mdl-edit.ts"))};`,
  `export { SYSTEM_FONT_FAMILIES, TEXT_EM_SCALE } from ${J(path.join(ROOT, "renderer/src/types.ts"))};`,
].join("\n");

const plugins = [
  {
    // overlay-gl.ts 的 .glsl 模块：判据不碰 GL，给空模块即可
    name: "glsl-stub",
    setup(b) {
      b.onLoad({ filter: /\.glsl$/ }, () => ({ contents: 'export default "";', loader: "js" }));
    },
  },
  {
    name: "editor-source-alias",
    setup(b) {
      b.onResolve({ filter: /renderer\/src\/api\/editor$/ }, () => ({ path: "editor-api", namespace: "editor-api" }));
      b.onLoad({ filter: /.*/, namespace: "editor-api" }, () => ({ contents: aliasContents, loader: "js", resolveDir: ROOT }));
    },
  },
];

async function loadEditorModule(rel, mutate) {
  let src = fs.readFileSync(path.join(ROOT, rel), "utf8");
  for (const [from, to, want] of mutate || []) {
    const hits = src.split(from).length - 1;
    // 锤子必须唯一命中：锚点重复时 String.replace 只打第一处，变异会静默打错地方（task-8 的教训）
    if (hits !== (want ?? 1)) throw new Error(`变异锚点命中 ${hits} 处（期望 ${want ?? 1}）：${from.slice(0, 80)}`);
    src = src.replace(from, to);
  }
  const out = await build({
    stdin: { contents: src, resolveDir: path.dirname(path.join(ROOT, rel)), sourcefile: path.join(ROOT, rel), loader: "ts" },
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    external: ["node:*"],
    write: false,
    logLevel: "silent",
    plugins,
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-draft-"));
  const file = path.join(dir, "mod.mjs");
  fs.writeFileSync(file, out.outputFiles[0].text);
  return import(pathToFileURL(file).href);
}

/** 记账 backend：包一层真 memoryVdirBackend，统计 read 次数与字节（判据 ④ 的读数来源） */
function accountingBackend(vdirMod) {
  const inner = vdirMod.memoryVdirBackend();
  const stats = { reads: 0, readBytes: 0, writes: 0, removes: 0 };
  const be = {
    ...inner,
    read: async (id, rel) => {
      const b = await inner.read(id, rel);
      stats.reads += 1;
      stats.readBytes += b ? b.size : 0;
      return b;
    },
    write: async (id, rel, blob) => {
      stats.writes += 1;
      return inner.write(id, rel, blob);
    },
    remove: async (id, rel) => {
      stats.removes += 1;
      return inner.remove(id, rel);
    },
  };
  return { be, stats, reset: () => ((stats.reads = 0), (stats.readBytes = 0), (stats.writes = 0), (stats.removes = 0)) };
}

/** 判据主体：吃 draftMod / vdirMod，报告交给 c（变异时传静默计数器） */
async function draftBattery(D, V, c) {
  const doc = { title: "t", project: null, scene: { objects: [] } };
  const big = new Uint8Array(300_000);
  for (let i = 0; i < big.length; i++) big[i] = (i * 37) % 251;
  const mk = (now, bytes) => D.makeDraft(doc, { kind: "virtual", id: "vdir-a" }, "scene.json", bytes ? [{ name: "big.bin", data: bytes }] : [], now);
  const slot = "vdir:vdir-a";

  // ① save() 后 list() 的 savedAt / bytes 与草稿内一致
  const a = accountingBackend(V);
  const store = D.vdirDraftStore(a.be);
  const snap = mk(4242, big);
  await store.save(snap, slot);
  const fullBytes = Buffer.byteLength(D.encodeDraft(snap), "utf8");
  const list1 = await store.list();
  c(
    list1.length === 1 && list1[0].slot === slot && list1[0].savedAt === 4242 && list1[0].bytes === fullBytes,
    `① save 后 list() 的 savedAt/bytes 与草稿一致（savedAt=${list1[0]?.savedAt}；bytes=${list1[0]?.bytes} = encodeDraft 的 ${fullBytes} 字节）`,
  );

  // ④ 读放大：meta 齐全时只读 meta
  a.reset();
  const listMeta = await store.list();
  const metaReads = a.stats.reads;
  const metaReadBytes = a.stats.readBytes;
  c(
    listMeta.length === 1 && listMeta[0].savedAt === 4242 && metaReads > 0 && metaReadBytes * 10 < fullBytes,
    `④ meta 快路径只读 meta：${metaReads} 次 read / ${metaReadBytes} 字节（>0 且 < 草稿全量 ${fullBytes} 的 1/10）`,
  );

  // ② meta 缺失（老草稿 / 别的写入者）⇒ 回落整份读 + decode，槽不能消失
  await a.be.remove(D.DRAFT_ID, D.DRAFT_META_PREFIX + slot);
  a.reset();
  const listOld = await store.list();
  const fbReads = a.stats.reads;
  const fbReadBytes = a.stats.readBytes;
  c(
    listOld.length === 1 && listOld[0].slot === slot && listOld[0].savedAt === 4242 && listOld[0].bytes === fullBytes,
    `② meta 缺失时回落路径仍给出正确 savedAt/bytes（槽没从列表里消失）`,
  );
  c(
    fbReadBytes >= fullBytes && metaReadBytes * 10 < fbReadBytes,
    `④b 两条路径的读数对比：回落 ${fbReads} 次 read / ${fbReadBytes} 字节 vs meta ${metaReads} 次 / ${metaReadBytes} 字节（${(fbReadBytes / Math.max(1, metaReadBytes)).toFixed(1)}× 放大被消掉）`,
  );

  // ③ clear：槽从列表消失且 meta 同批删
  // 必须用**独立槽位**：上面的 slot 在第 ② 步已被手动删掉 meta，拿它验 clear 会让"clear 不删 meta"的变异漏网
  const g = accountingBackend(V);
  const storeClear = D.vdirDraftStore(g.be);
  await storeClear.save(mk(777), "s-clear");
  await storeClear.save(mk(778), "s-keep");
  await storeClear.clear("s-clear");
  const keysAfterClear = await g.be.keys(D.DRAFT_ID);
  c(
    (await storeClear.list()).map((i) => i.slot).join(",") === "s-keep" &&
      keysAfterClear.length === 2 &&
      keysAfterClear.every((k) => k === "s-keep" || k === D.DRAFT_META_PREFIX + "s-keep"),
    `③ clear 后槽从列表消失且 meta 同批删，别的槽不受牵连（DRAFT_ID 下剩 ${J(keysAfterClear)}）`,
  );

  // ②b 老草稿（无 meta）与新草稿混排：槽序与 savedAt 与加 meta 之前同口径
  const b = accountingBackend(V);
  const store2 = D.vdirDraftStore(b.be);
  await store2.save(mk(1000), "s-old");
  await b.be.remove(D.DRAFT_ID, D.DRAFT_META_PREFIX + "s-old"); // 模拟改动之前写入的老草稿
  await store2.save(mk(2000), "s-new");
  const mixed = await store2.list();
  c(
    J(mixed.map((i) => i.slot)) === J(["s-new", "s-old"]) &&
      mixed[1].savedAt === 1000 &&
      mixed[1].bytes === Buffer.byteLength(D.encodeDraft(mk(1000)), "utf8"),
    `②b 老草稿 + 新草稿混排：槽序降序、老槽以回落路径给出正确 savedAt/bytes（${J(mixed.map((i) => i.slot))}）`,
  );

  // 坏 meta（手改 / 截断）：同样回落，而不是把槽丢掉
  const f = accountingBackend(V);
  const store3 = D.vdirDraftStore(f.be);
  await store3.save(mk(55), "bad");
  await f.be.write(D.DRAFT_ID, D.DRAFT_META_PREFIX + "bad", new Blob(["not json"], { type: "application/json" }));
  const badList = await store3.list();
  c(badList.length === 1 && badList[0].savedAt === 55, "②c 坏 meta 走回落：槽仍在，savedAt 从草稿本体解出来（不静默丢槽）");

  // 淘汰：被淘汰槽的本体与 meta 一起删，不留孤儿键
  const e = accountingBackend(V);
  const store4 = D.vdirDraftStore(e.be, 1, D.DRAFT_MAX_BYTES);
  await store4.save(mk(1), "k1");
  await store4.save(mk(2), "k2");
  const keys4 = await e.be.keys(D.DRAFT_ID);
  c(
    J((await store4.list()).map((i) => i.slot)) === J(["k2"]) &&
      keys4.length === 2 &&
      keys4.every((k) => k === "k2" || k === D.DRAFT_META_PREFIX + "k2"),
    `淘汰（槽数上限 1）：本体与 meta 成对删，不留孤儿键（剩 ${J(keys4)}）`,
  );

  // meta 形状闸门（坏内容一律当没有 ⇒ 走回落）
  const okMeta = D.parseDraftMeta('{"savedAt":7,"bytes":9}');
  c(
    okMeta !== null && okMeta.savedAt === 7 && okMeta.bytes === 9 &&
      D.parseDraftMeta("{") === null &&
      D.parseDraftMeta("null") === null &&
      D.parseDraftMeta('{"savedAt":"x","bytes":1}') === null &&
      D.parseDraftMeta('{"savedAt":1}') === null &&
      D.parseDraftMeta('{"savedAt":1,"bytes":-2}') === null &&
      D.parseDraftMeta('{"savedAt":1e999,"bytes":2}') === null,
    "meta 形状闸门：坏 JSON / 非对象 / 缺字段 / 负数 / 非有限 savedAt 一律当没有（回落路径接手）",
  );

  // 公开契约面没被动过（槽上限、保留 id、后端接口仍是 VdirBackend）
  c(
    D.DRAFT_MAX_SLOTS === 8 && D.DRAFT_MAX_BYTES === 32 * 1024 * 1024 && D.DRAFT_ID === "__draft__" && typeof V.memoryVdirBackend === "function",
    "公开契约未变：DRAFT_MAX_SLOTS=8 / DRAFT_MAX_BYTES=32MB / DRAFT_ID=__draft__ / 存储仍走 VdirBackend（未改 vdir.ts 接口）",
  );
}

// ───────────────────────────────────────────────────────────────────────────
// 变异红测：把 meta 快路径 / 回落 / 清理任一支改坏，判据必须变红
// （只在内存里改源码；磁盘文件 sha256 前后必须逐字一致）
// ───────────────────────────────────────────────────────────────────────────
const MUTATIONS = [
  {
    name: "M1 不写 meta（退回每次 info() 整份读）",
    from: '      await be.write(DRAFT_ID, draftMetaKey(slot), new Blob([encodeDraftMeta(d.savedAt, blob.size)], { type: "application/json" }));\n',
    to: "",
  },
  {
    name: "M2 删掉回落分支（meta 缺失的槽直接从列表消失）",
    from: "      const meta = metas.get(slot);\n      if (meta) {\n        out.push(meta);\n        continue;\n      }\n",
    to: "      const meta = metas.get(slot);\n      if (meta) out.push(meta);\n      continue;\n",
  },
  {
    name: "M3 clear 不删 meta",
    from: "      await be.remove(DRAFT_ID, draftMetaKey(slot));\n    },\n  };",
    to: "      /* 变异：不删 meta */\n    },\n  };",
  },
  {
    name: "M4 淘汰不删 meta（留孤儿键）",
    from: "        await be.remove(DRAFT_ID, draftMetaKey(i.slot));\n",
    to: "",
  },
];

const draftDiskSha = sha256(DRAFT_PATH);

const vdirMod = await loadEditorModule(VDIR_REL);
const draftMod = await loadEditorModule(DRAFT_REL);

section("§8.2 L6：draft.ts info() 读放大（meta 快路径 + 老草稿回落）");
await draftBattery(draftMod, vdirMod, check);

section(`变异红测（${MUTATIONS.length} 条：判据把实现改坏必须抓住）`);
let red = 0;
for (const mut of MUTATIONS) {
  let hits = 0;
  try {
    const mutMod = await loadEditorModule(DRAFT_REL, [[mut.from, mut.to]]);
    await draftBattery(mutMod, vdirMod, (ok) => {
      if (!ok) hits++;
    });
  } catch (e) {
    hits = hits || 1; // 改坏后直接抛（例如语法/锚点问题）也算抓住
    void e;
  }
  if (hits > 0) red++;
  check(hits > 0, `${mut.name} → 判据变红（${hits} 条）`);
}
check(sha256(DRAFT_PATH) === draftDiskSha, `变异只在内存里发生：editor/draft.ts sha256 前后一致（${draftDiskSha.slice(0, 12)}…）`);

console.log(`\n  判据 ${passed} ✓ / ${failed} ✗；变异 ${red}/${MUTATIONS.length} 条被抓住`);
console.log(failed ? `\n✗ 共 ${failed} 处问题` : "\n✓ 全部通过");
process.exit(failed ? 1 : 0);
