#!/usr/bin/env node
/**
 * verify-mdl-write —— .mdl 编码器（EDITOR-PLAN W17，`pkg/mdl-write.js`）的判据。
 *
 * A. 语料逐字节往返：壁纸库里每个 .mdl 经 readMdlDoc → writeMdlDoc 必须与原文件逐字节相同，
 *    且四种段全部结构化（退成 raw = 那段不可编辑，算回归）。
 * B. 无损文档与读侧同源：文档里的骨骼 / 动画轨道 / 附着点 / 帧事件与渲染器 parseMDL 读出的逐值一致
 *    （编辑器改文档、引擎读字节，两边必须是同一份语义）。
 * C. 从零编码：语料里的模型按 parseMDL 结果重新 encodeMDL（MDLV0023）后再 parseMDL，顶点 / 索引 / 骨骼 /
 *    动画 / 附着点逐值相等，computeSkinMatrices 在多个时刻一致；合成小模型（3 骨 2 片段 + 事件 + 附着点）
 *    与静态网格同样往返。
 * D. 编辑往返：改一个关键帧与一根骨的绑定矩阵，写回后读侧看到新值、其余不变。
 * E. 非法输入拒绝。
 * F. 变异红测：去掉段偏移回填 / 索引宽度写错 / 事件时刻写错 / 前缀封顶固定长度，对应判据必须变红。
 * G. 真 GPU 出帧对照（--headless）：挑「全部 .mdl 可从零重编码且有动画」的壁纸，原包 / 重打包对照 /
 *    包内 .mdl 全部换成 MDLV0023 重编码产物三臂，各自新页挂载、暂停后在多个时刻 capture，
 *    重编码臂与原包的像素差不得超过对照臂（粒子层隐藏：有状态模拟每次挂载都不同）。
 *    WE_MDL_AB_ITEMS=id,id 指定壁纸；WE_MDL_AB_DUMP=<目录> 存出帧 PNG。
 *
 * 语料缺失（本机没装壁纸库）时 A–D 的语料部分跳过，合成部分照跑。
 * 用法：node scripts/verify-mdl-write.mjs [--headless]
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { LIB, ROOT, imp, createChecker } from "./lib/verify-kit.mjs";

const { check, errors } = createChecker({ echo: true });
const W = await imp("renderer/vendor/we-scene/pkg/mdl-write.js");
const P = await imp("renderer/vendor/we-scene/render/mdl-parse.js");
const S = await imp("renderer/vendor/we-scene/render/mdl-skin.js");
const C = await imp("renderer/vendor/we-scene/pkg/container.js");

const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const sameNums = (a, b, eps = 0) => !!a && !!b && a.length === b.length && Array.prototype.every.call(a, (x, i) => (eps ? Math.abs(x - b[i]) <= eps : Object.is(x, b[i]) || x === b[i]));

function* corpusMdl() {
  if (!fs.existsSync(LIB)) return;
  for (const id of fs.readdirSync(LIB)) {
    const pkgPath = path.join(LIB, id, "scene.pkg");
    if (!fs.existsSync(pkgPath)) continue;
    let pkg;
    try {
      pkg = C.parsePkg(new Uint8Array(fs.readFileSync(pkgPath)));
    } catch {
      continue;
    }
    for (const e of pkg.entries) {
      if (/\.mdl$/i.test(e.name)) yield { id, name: e.name, buf: C.getEntry(pkg, e.name) };
    }
  }
}

// ═══ A + B ════════════════════════════════════════════════════════════════
console.log("A. 语料逐字节往返 / B. 文档与 parseMDL 同源");
const byVer = new Map();
let files = 0;
let rawSections = 0;
let wholeRaw = 0;
let semBad = 0;
let eventsSeen = 0;
let eventTimeBad = 0;
const fresh = [];
/** id → 该壁纸的 .mdl 计数（G 段选「全部可从零重编码、且有动画」的壁纸做出帧对照） */
const byItem = new Map();
for (const { id, name, buf } of corpusMdl()) {
  files++;
  const ver = String.fromCharCode(...buf.subarray(4, 8));
  const tag = `${id}/${name}`;
  let doc;
  try {
    doc = W.readMdlDoc(buf);
  } catch (e) {
    check(false, `${tag}: readMdlDoc 抛错 ${e.message}`);
    continue;
  }
  const out = W.writeMdlDoc(doc);
  const exact = sameBytes(out, buf);
  check(exact, `${tag}: 往返字节不一致（${buf.length} → ${out.length}）`);
  byVer.set(ver, (byVer.get(ver) || 0) + (exact ? 1 : 0));
  if (doc.raw) {
    wholeRaw++;
    continue;
  }
  for (const s of doc.sections) if (s.raw) rawSections++;

  const m = P.parseMDL(buf);
  const mdls = doc.sections.find((s) => s.type === "MDLS" && !s.raw);
  if (mdls) {
    const ok = mdls.bones.length === m.bones.length &&
      mdls.bones.every((b, i) => b.parent === m.bones[i].parent && sameNums(b.matrix, m.bones[i].matrix) && W.mdlText(b.name) === m.bones[i].name);
    if (!ok) semBad++;
    check(ok, `${tag}: 文档骨骼与 parseMDL 不一致`);
    // [P0] head0（MDLS 记录头，旧代码命名成 id）与 meta（矩阵尾 JSON cstr）也必须同源：
    // 这两个字段此前解析侧全丢、写侧原样保留，P0 起并排导出为 parseMDL().boneMeta。
    const bm = m.boneMeta || [];
    const metaOk = bm.length === mdls.bones.length && mdls.bones.every((b, i) =>
      b.head0 === bm[i].head0 && W.mdlText(b.meta ?? "") === (bm[i].meta ?? ""));
    if (!metaOk) semBad++;
    check(metaOk, `${tag}: 骨骼 head0 / meta 文档与 parseMDL 不一致`);
  }
  const mdla = doc.sections.find((s) => s.type === "MDLA" && !s.raw);
  if (mdla) {
    for (const pa of m.animations) {
      const da = mdla.anims.find((a) => a.id === pa.id && W.mdlText(a.name) === pa.name);
      const ok = !!da && da.fps === pa.fps && da.frameCount === pa.frameCount && da.tracks.length === pa.tracks.length &&
        da.tracks.every((t, k) => sameNums(t.data, pa.tracks[k].keyframes)) &&
        da.events.length === pa.events.length && da.events.every((e, k) => JSON.parse(e.json).frame === pa.events[k].frame && JSON.parse(e.json).name === pa.events[k].name);
      if (!ok) semBad++;
      check(ok, `${tag}: 动画「${pa.name}」文档与 parseMDL 不一致`);
    }
    for (const a of mdla.anims) {
      for (const e of a.events) {
        eventsSeen++;
        if (Math.abs(e.time - JSON.parse(e.json).frame / a.fps) > 1e-4) eventTimeBad++;
      }
    }
  }
  const mdat = doc.sections.find((s) => s.type === "MDAT" && !s.raw);
  if (mdat && m.attachments) {
    const ok = m.attachments.every((pa) => mdat.attachments.some((a) => a.bone === pa.bone && W.mdlText(a.name) === pa.name && sameNums(a.matrix, pa.matrix)));
    if (!ok) semBad++;
    check(ok, `${tag}: 附着点文档与 parseMDL 不一致`);
  }

  // C 的语料样本：能被 encodeMDL 表达的（骨序合法、每片段每骨一轨、无静态装配姿势、单材质）
  const parentOk = m.bones.every((b, i) => b.parent >= -1 && b.parent < i);
  const tracksOk = m.animations.every((a) => a.tracks.length === m.bones.length && a.tracks.every((t) => t.frameCount === a.frameCount + 1));
  const fit = parentOk && tracksOk && !m.staticPoseTRS && (!m.meshes || m.meshes.every((x) => x.materials.length === 1));
  if (fit) fresh.push({ tag, m });
  const st = byItem.get(id) || { total: 0, fit: 0, anim: 0 };
  st.total++;
  if (fit) st.fit++;
  if (fit && m.animations.length) st.anim++;
  byItem.set(id, st);
}
if (files === 0) {
  console.log(`  跳过语料部分（本机壁纸库里没有 .mdl：${LIB}）`);
} else {
  console.log(`  ${files} 个 .mdl：` + [...byVer].sort().map(([v, n]) => `${v}×${n}`).join(" ") + " 逐字节一致");
  check(wholeRaw === 0, `整份退成 raw 的文件 ${wholeRaw} 个（网格表没走通）`);
  check(rawSections === 0, `退成 raw 的段 ${rawSections} 个（该段不可编辑）`);
  check(semBad === 0, `文档与 parseMDL 不同源 ${semBad} 处`);
  check(eventsSeen > 0, "语料里必须出现帧事件（夹具失效）");
  check(eventTimeBad === 0, `帧事件的 f32 时刻 ≠ frame / fps 的有 ${eventTimeBad} / ${eventsSeen} 条`);
  console.log(`  帧事件 ${eventsSeen} 条，时刻全部 = frame / fps`);
}

// ═══ C ════════════════════════════════════════════════════════════════════
console.log("C. 从零编码（MDLV0023）");

function specFromParsed(m) {
  const meshes = (m.meshes && m.meshes.length ? m.meshes : [m]).map((x) => ({
    material: x.materialPath || "materials/x.json",
    positions: x.positions,
    uvs: x.uvs,
    normals: x.normals || undefined,
    tangents: x.tangents || undefined,
    boneIdx: m.bones.length ? x.boneIdx : undefined,
    weights: m.bones.length ? x.weights : undefined,
    indices: x.indices,
    parts: x.parts || undefined,
  }));
  return {
    meshes,
    bones: m.bones.map((b) => ({ name: b.name, parent: b.parent, matrix: b.matrix })),
    animations: m.animations.map((a) => ({ id: a.id, name: a.name, mode: a.mode, fps: a.fps, frameCount: a.frameCount, tracks: a.tracks.map((t) => t.keyframes), events: a.events })),
    attachments: (m.attachments || []).map((a) => ({ name: a.name, bone: a.bone, matrix: a.matrix })),
  };
}

function compareModels(tag, a, b) {
  const am = a.meshes && a.meshes.length ? a.meshes : [a];
  const bm = b.meshes && b.meshes.length ? b.meshes : [b];
  let ok = am.length === bm.length;
  for (let i = 0; ok && i < am.length; i++) {
    const x = am[i];
    const y = bm[i];
    ok = sameNums(x.positions, y.positions) && sameNums(x.uvs, y.uvs) && sameNums(Array.from(x.indices), Array.from(y.indices));
    if (ok && a.bones.length) ok = sameNums(x.boneIdx, y.boneIdx) && sameNums(x.weights, y.weights);
  }
  check(ok, `${tag}: 重编码后顶点 / 索引 / 权重不一致`);
  const partKey = (m) => JSON.stringify((m.meshes && m.meshes.length ? m.meshes : [m]).map((x) => x.parts || null));
  const partsOk = partKey(a) === partKey(b) && JSON.stringify((a.parts || []).map((p) => [p.bone, p.x0, p.y1])) === JSON.stringify((b.parts || []).map((p) => [p.bone, p.x0, p.y1]));
  check(partsOk, `${tag}: 重编码后部件表不一致`);
  ok = ok && partsOk;
  const bonesOk = a.bones.length === b.bones.length && a.bones.every((x, i) => x.parent === b.bones[i].parent && sameNums(x.matrix, b.bones[i].matrix) && x.name === b.bones[i].name);
  check(bonesOk, `${tag}: 重编码后骨骼不一致`);
  const animOk = a.animations.length === b.animations.length && a.animations.every((x, i) => {
    const y = b.animations[i];
    return x.id === y.id && x.name === y.name && x.mode === y.mode && x.fps === y.fps && x.frameCount === y.frameCount &&
      x.tracks.every((t, k) => sameNums(t.keyframes, y.tracks[k].keyframes)) &&
      x.events.length === y.events.length && x.events.every((e, k) => e.frame === y.events[k].frame && e.name === y.events[k].name);
  });
  check(animOk, `${tag}: 重编码后动画不一致`);
  const attOk = (a.attachments || []).length === (b.attachments || []).length &&
    (a.attachments || []).every((x, i) => x.bone === b.attachments[i].bone && x.name === b.attachments[i].name && sameNums(x.matrix, b.attachments[i].matrix));
  check(attOk, `${tag}: 重编码后附着点不一致`);
  if (a.bones.length) {
    for (const t of [0, 0.37, 1.5, 7.25]) {
      // null = 恒等蒙皮（无动画、无覆写），两边必须同为 null 或逐值相等
      const ra = S.computeSkinMatrices(a, t, undefined, undefined);
      const sa = ra && Float32Array.from(ra);
      const rb = S.computeSkinMatrices(b, t, undefined, undefined);
      const sb = rb && Float32Array.from(rb);
      check(sa === null ? sb === null : sameNums(sa, sb, 1e-3), `${tag}: t=${t} 蒙皮矩阵不一致`);
    }
  }
  return ok && bonesOk && animOk && attOk;
}

let freshOk = 0;
for (const { tag, m } of fresh) {
  let re;
  try {
    const bytes = W.encodeMDL(specFromParsed(m));
    check(String.fromCharCode(...bytes.subarray(0, 8)) === "MDLV0023", `${tag}: 从零编码须为 MDLV0023`);
    re = P.parseMDL(bytes);
    for (const me of re.meshes || []) {
      let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < me.positions.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], me.positions[i + k]); mx[k] = Math.max(mx[k], me.positions[i + k]); }
      check(sameNums(me.aabb, [...mn, ...mx], 1e-3), `${tag}: AABB 须为 (min xyz, max xyz)`);
    }
  } catch (e) {
    check(false, `${tag}: 从零编码抛错 ${e.message}`);
    continue;
  }
  if (compareModels(tag, m, re)) freshOk++;
}
if (fresh.length) {
  console.log(`  语料 ${freshOk} / ${fresh.length} 个模型从零重编码后与原模型同语义（含 4 个时刻的蒙皮矩阵）`);
  check(fresh.length >= 100, `可表达的语料样本过少（${fresh.length}），夹具失效`);
}

// 合成：3 骨链（根 → 臂 → 手）、2 片段、事件、附着点；单位四边形两三角
const T = (x, y) => Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, 0, 1);
const trs = (frames, f) => {
  const out = new Float32Array(frames * 9);
  for (let i = 0; i < frames; i++) out.set(f(i), i * 9);
  return out;
};
const synthSpec = () => ({
  meshes: [{
    material: "materials/editor/synth.json",
    positions: Float32Array.of(-50, -50, 0, 50, -50, 0, 50, 50, 0, -50, 50, 0),
    uvs: Float32Array.of(0, 1, 1, 1, 1, 0, 0, 0),
    boneIdx: [0, 0, 0, 0, 1, 0, 0, 0, 2, 1, 0, 0, 1, 0, 0, 0],
    weights: Float32Array.of(1, 0, 0, 0, 1, 0, 0, 0, 0.5, 0.5, 0, 0, 1, 0, 0, 0),
    indices: [0, 1, 2, 0, 2, 3],
  }],
  bones: [
    { name: "root", parent: -1, matrix: T(0, 0) },
    { name: "arm", parent: 0, matrix: T(30, 0) },
    { name: "手", parent: 1, matrix: T(20, 10) },
  ],
  animations: [
    { id: 501, name: "wave", mode: "loop", fps: 30, frameCount: 4, events: [{ frame: 2, name: "peak" }],
      tracks: [
        trs(5, () => [0, 0, 0, 0, 0, 0, 1, 1, 1]),
        trs(5, (i) => [30, 0, 0, 0, 0, i * 0.1, 1, 1, 1]),
        trs(5, () => [20, 10, 0, 0, 0, 0, 1, 1, 1]),
      ] },
    { id: 502, name: "idle", mode: "mirror", fps: 24, frameCount: 2,
      tracks: [0, 1, 2].map((b) => trs(3, () => [b === 0 ? 0 : b === 1 ? 30 : 20, b === 2 ? 10 : 0, 0, 0, 0, 0, 1, 1, 1])) },
  ],
  attachments: [{ name: "握点", bone: 2, matrix: T(5, 5) }],
});
{
  const bytes = W.encodeMDL(synthSpec());
  const m = P.parseMDL(bytes);
  check(m.vertexCount === 4 && m.indexCount === 6 && m.indexType === "u16", "合成：4 顶点 / 6 索引 / u16");
  check(m.bones.map((b) => `${b.name}:${b.parent}`).join(",") === "root:-1,arm:0,手:1", "合成：骨名（含中文）与父链读回");
  check(m.animations.length === 2 && m.animations[0].id === 501 && m.animations[1].mode === "mirror" && m.animations[1].fps === 24, "合成：两个片段的 id / mode / fps 读回");
  check(m.animations[0].tracks[1].keyframes[4 * 9 + 5] === Math.fround(0.4), "合成：关键帧逐值读回（arm 第 4 帧 rz = 0.4）");
  check(m.animations[0].events.length === 1 && m.animations[0].events[0].frame === 2 && m.animations[0].events[0].name === "peak", "合成：帧事件读回");
  check(m.attachments?.length === 1 && m.attachments[0].name === "握点" && m.attachments[0].bone === 2, "合成：附着点读回");
  const skin0 = S.computeSkinMatrices(m, 0, [{ animation: 501, visible: true, blend: 1, rate: 1, additive: false }]);
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  check([0, 1, 2].every((b) => sameNums(Array.from(skin0.subarray(b * 16, b * 16 + 16)), I, 1e-5)), "合成：第 0 帧 = 绑定姿势 → 蒙皮矩阵为单位阵");
  const skin1 = Float32Array.from(S.computeSkinMatrices(m, 3 / 30, [{ animation: 501, visible: true, blend: 1, rate: 1, additive: false }]));
  check(Math.abs(Math.atan2(skin1[16 + 1], skin1[16]) - 0.3) < 1e-4, "合成：第 3 帧 arm 转 0.3 rad 进蒙皮矩阵");
  const doc = W.readMdlDoc(bytes);
  check(sameBytes(W.writeMdlDoc(doc), bytes), "合成：encodeMDL 产物同样逐字节往返");
  const sp = synthSpec();
  sp.meshes[0].parts = [{ id: 7, offset: -100, start: 0, size: 3 }, { id: 9, offset: 200, start: 3, size: 3 }];
  const mp = P.parseMDL(W.encodeMDL(sp));
  check(JSON.stringify(mp.meshes[0].parts) === JSON.stringify(sp.meshes[0].parts), "合成：部件表（id / 绘制序偏移 / 索引区间）读回");
  check(mp.parts?.length === 2 && mp.parts[1].bone >= 0, "合成：部件表进入渲染侧的零件元数据");
}
{
  const stat = W.encodeMDL({ meshes: [{ material: "materials/editor/box.json", positions: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0), normals: Float32Array.of(0, 0, 1, 0, 0, 1, 0, 0, 1), uvs: Float32Array.of(0, 0, 1, 0, 0, 1), indices: [0, 1, 2] }] });
  const m = P.parseMDL(stat);
  check(m.bones.length === 0 && m.vertexCount === 3 && m.meshes?.[0]?.meshFlag === 0xf, "静态网格：无骨、stride 48（meshFlag 0xf）");
  check(sameNums(m.meshes[0].normals, [0, 0, 1, 0, 0, 1, 0, 0, 1]), "静态网格：法线读回");
  const n = 70000;
  const big = W.encodeMDL({ meshes: [{ material: "m.json", positions: new Float32Array(n * 3).map((_, i) => i % 97), indices: [0, 69999, 35000] }] });
  const mb = P.parseMDL(big);
  check(mb.indexType === "u32" && Array.from(mb.indices).join(",") === "0,69999,35000", "顶点 > 65535 时写 u32 索引");
}

// ═══ D ════════════════════════════════════════════════════════════════════
console.log("D. 编辑往返");
{
  const src = fresh.find((f) => f.m.animations.length > 0 && f.m.bones.length > 2);
  const base = src ? null : W.encodeMDL(synthSpec());
  let bytes = base;
  if (src) {
    for (const x of corpusMdl()) {
      if (`${x.id}/${x.name}` === src.tag) {
        bytes = x.buf;
        break;
      }
    }
  }
  const doc = W.readMdlDoc(bytes);
  const before = P.parseMDL(bytes);
  const mdla = doc.sections.find((s) => s.type === "MDLA");
  const mdls = doc.sections.find((s) => s.type === "MDLS");
  mdla.anims[0].tracks[1].data[0] += 10;
  mdls.bones[1].matrix[12] += 5;
  const after = P.parseMDL(W.writeMdlDoc(doc));
  check(after.animations[0].tracks[1].keyframes[0] === Math.fround(before.animations[0].tracks[1].keyframes[0] + 10), "改关键帧：读侧看到 +10");
  check(after.bones[1].matrix[12] === Math.fround(before.bones[1].matrix[12] + 5), "改绑定矩阵：读侧看到 +5");
  check(sameNums(after.positions, before.positions) && after.animations[0].tracks[0].keyframes.every((v, i) => v === before.animations[0].tracks[0].keyframes[i]), "未改动的顶点与轨道逐值不变");
  console.log(`  样本：${src ? src.tag : "合成模型"}`);
}

// ═══ D2 ═══════════════════════════════════════════════════════════════════
console.log("D2. Reader 缓冲类型 / 对齐（P0：f32s 的 Buffer 别名 bug）");
{
  const raw = W.encodeMDL(synthSpec());
  const plain = Uint8Array.from(raw);
  // 背书缓冲长度**故意不是 4 的倍数**、内容又从非零 byteOffset 开始。
  // 旧实现 `new Float32Array(this.buf.slice(p, p + n * 4).buffer)`：Node Buffer 的 slice 是**视图**
  // 语义，`.buffer` 拿到整块背书 ArrayBuffer（长度非 4 倍数时 new Float32Array 抛 RangeError），
  // 且 byteOffset 被完全忽略 ⇒ readMeshes 的 `aabb = r.f32s(p, 6)` 抛错被 readMdlDoc 吞掉、
  // 整份退成 raw，44% 的真实模型编辑静默 no-op（修后 raw 0 / 617 条全结构化）。
  const pad = raw.length % 4 === 3 ? 6 : 5;
  const ab = new ArrayBuffer(raw.length + pad);
  const asBuffer = Buffer.from(ab, 2, raw.length);
  asBuffer.set(raw);
  const asView = new Uint8Array(ab, 2, raw.length);
  check(ab.byteLength % 4 !== 0, `夹具：背书缓冲长度 ${ab.byteLength} 不是 4 的倍数`);
  let oldThrew = false;
  try { new Float32Array(asBuffer.slice(0, 16).buffer); } catch { oldThrew = true; }
  check(oldThrew, "夹具：旧取值方式确会抛 RangeError（Buffer.slice → 非 4 倍数背书缓冲）");
  const ref = P.parseMDL(plain);
  for (const [label, input] of [["Buffer 视图", asBuffer], ["Uint8Array 子视图", asView]]) {
    let doc = null;
    let err = "";
    try { doc = W.readMdlDoc(input); } catch (e) { err = String((e && e.message) || e); }
    check(!!doc && !doc.raw && doc.sections.length > 0, `${label}：readMdlDoc 走结构路径而非整份 raw${err && "（" + err + "）"}`);
    if (doc && !doc.raw) check(sameBytes(W.writeMdlDoc(doc), plain), `${label}：结构化往返逐字节一致`);
    let m = null;
    try { m = P.parseMDL(input); } catch (e) { err = String((e && e.message) || e); }
    const ok = !!m && m.bones.length === ref.bones.length &&
      m.bones.every((b, i) => b.name === ref.bones[i].name && b.parent === ref.bones[i].parent && sameNums(b.matrix, ref.bones[i].matrix)) &&
      sameNums(m.positions, ref.positions) && sameNums(m.uvs, ref.uvs) &&
      m.animations.length === ref.animations.length &&
      m.animations.every((a, i) => sameNums(a.tracks[0].keyframes, ref.animations[i].tracks[0].keyframes));
    check(ok, `${label}：parseMDL 逐值等于偏移 0 的副本${err && "（" + err + "）"}`);
  }
}

// ═══ E ════════════════════════════════════════════════════════════════════
console.log("E. 非法输入拒绝");
const throws = (fn, msg) => {
  let t = false;
  try {
    fn();
  } catch {
    t = true;
  }
  check(t, msg);
};
throws(() => { const s = synthSpec(); s.bones[1].parent = 2; W.encodeMDL(s); }, "父骨在后（前向引用）须拒绝");
throws(() => { const s = synthSpec(); s.meshes[0].boneIdx[0] = 3; W.encodeMDL(s); }, "顶点骨号越界须拒绝");
throws(() => { const s = synthSpec(); s.animations[0].tracks[0] = new Float32Array(9 * 4); W.encodeMDL(s); }, "轨道帧数 ≠ frameCount + 1 须拒绝");
throws(() => { const s = synthSpec(); s.animations[0].tracks.pop(); W.encodeMDL(s); }, "片段轨数 ≠ 骨数须拒绝");
throws(() => { const s = synthSpec(); s.animations[1].id = 501; W.encodeMDL(s); }, "动画 id 重复须拒绝");
throws(() => { const s = synthSpec(); s.meshes[0].indices = [0, 1, 4]; W.encodeMDL(s); }, "索引越界须拒绝");
throws(() => W.encodeMDL({ meshes: [{ material: "m.json", positions: [0, 0, 0], indices: [0, 0, 0] }], animations: [{ fps: 30, frameCount: 1, tracks: [] }] }), "无骨模型带动画须拒绝");
throws(() => { const s = synthSpec(); s.meshes[0].parts = [{ id: 1, offset: 0, start: 0, size: 3 }]; W.encodeMDL(s); }, "部件区间没铺满索引表须拒绝");
throws(() => { const s = synthSpec(); s.meshes[0].parts = [{ id: 1, offset: 0, start: 0, size: 3 }, { id: 2, offset: 0, start: 2, size: 4 }]; W.encodeMDL(s); }, "部件区间重叠须拒绝");

// ═══ F ════════════════════════════════════════════════════════════════════
console.log("F. 变异红测");
let mutSeq = 0;
const mutate = async (from, to, tag) => {
  const abs = path.join(ROOT, "renderer/vendor/we-scene/pkg/mdl-write.js");
  const src = fs.readFileSync(abs, "utf8");
  const mut = src.replace(from, to);
  check(mut !== src, `注入点存在（${tag}）`);
  const file = path.join(path.dirname(abs), `.verify-mut-mdl-write-${process.pid}-${++mutSeq}.js`);
  fs.writeFileSync(file, mut);
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    fs.rmSync(file, { force: true });
  }
};
const firstWithSections = (() => {
  for (const x of corpusMdl()) {
    const d = W.readMdlDoc(x.buf);
    if (!d.raw && d.sections.some((s) => s.type === "MDLA") && d.sections.some((s) => s.type === "MDLS")) return x.buf;
  }
  return W.encodeMDL(synthSpec());
})();
{
  const M = await mutate("    w.patchU32(at, w.p)\n", "\n", "段偏移回填");
  check(!sameBytes(M.writeMdlDoc(M.readMdlDoc(firstWithSections)), firstWithSections), "不回填段偏移时「逐字节往返」判据变红");
}
{
  const M = await mutate("const wide = vertexCount > 65535", "const wide = vertexCount >= 0", "索引宽度");
  let red = false;
  try {
    const m = P.parseMDL(M.encodeMDL(synthSpec()));
    red = Array.from(m.indices).join(",") !== "0,1,2,0,2,3";
  } catch {
    red = true;
  }
  check(red, "小模型写 u32 索引时「索引读回」判据变红");
}
{
  const M = await mutate("time: e.frame / a.fps,", "time: e.frame,", "事件时刻");
  const d = M.createMdlDoc(synthSpec());
  const ev = d.sections.find((s) => s.type === "MDLA").anims[0].events[0];
  check(Math.abs(ev.time - 2 / 30) > 1e-4, "事件时刻写成帧号时「时刻 = frame / fps」判据变红");
}
if (files > 0) {
  const M = await mutate("const room = boundary - o - 4", "const room = Math.min(31, boundary - o - 4)", "动画前缀定位");
  let raws = 0;
  for (const x of corpusMdl()) {
    const d = M.readMdlDoc(x.buf);
    if (!d.raw) raws += d.sections.filter((s) => s.raw).length;
    if (raws) break;
  }
  check(raws > 0, "前缀封顶 31 字节（附加数据块进不去）时「全部段结构化」判据变红");
}

// ═══ G（--headless）══════════════════════════════════════════════════════
if (process.argv.includes("--headless")) {
  await runHeadlessAb();
} else {
  console.log("\n（跳过 G 真 GPU 出帧对照：加 --headless 跑，需要 Chrome + 会自起 dev server）");
}

async function runHeadlessAb() {
  console.log("G. 真 GPU 出帧对照（原包 / 重打包对照 / .mdl 全部从零重编码）");
  const os = await import("node:os");
  const net = await import("node:net");
  const TIMES = [0, 0.37, 1.5, 4.2];
  const CW = 480;
  const CH = 270;
  // 排查用：WE_MDL_AB_DUMP=<目录> 把每臂每个时刻的出帧存成 PNG
  const dump = process.env.WE_MDL_AB_DUMP || "";
  if (dump) fs.mkdirSync(dump, { recursive: true });
  const envItems = (process.env.WE_MDL_AB_ITEMS || "").split(",").filter(Boolean);
  const items = envItems.length
    ? envItems
    : [...byItem]
      .filter(([id, s]) => s.total === s.fit && s.anim > 0 && fs.existsSync(path.join(LIB, id, "project.json")))
      .map(([id]) => ({ id, size: fs.statSync(path.join(LIB, id, "scene.pkg")).size }))
      .sort((a, b) => a.size - b.size)
      .slice(0, 8)
      .map((x) => x.id);
  check(items.length > 0, "找到可做出帧对照的壁纸（全部 .mdl 可从零重编码且有动画）");
  if (!items.length) return;

  // 每个壁纸三臂：orig = 原包字节；ctl = 原入口经 writePkg 重打包（容器改写 + 两次挂载的噪声底）；
  // enc = 同样重打包，但包内每个 .mdl 换成 encodeMDL(parseMDL(原文件)) 的 MDLV0023 产物
  const tmpLib = fs.mkdtempSync(path.join(os.tmpdir(), "verify-mdl-ab-"));
  for (const id of items) {
    const src = path.join(LIB, id);
    const pkg = C.parsePkg(new Uint8Array(fs.readFileSync(path.join(src, "scene.pkg"))));
    const entries = pkg.entries.map((e) => ({ name: e.name, data: C.getEntry(pkg, e.name) }));
    const arms = {
      orig: pkg.buf,
      ctl: C.writePkg(entries),
      enc: C.writePkg(entries.map((e) => (/\.mdl$/i.test(e.name) ? { name: e.name, data: W.encodeMDL(specFromParsed(P.parseMDL(e.data))) } : e))),
    };
    for (const [arm, bytes] of Object.entries(arms)) {
      const dir = path.join(tmpLib, `${id}-${arm}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(path.join(src, "project.json"), path.join(dir, "project.json"));
      fs.writeFileSync(path.join(dir, "scene.pkg"), bytes);
    }
  }

  const prevLib = process.env.WE_LIBRARY;
  process.env.WE_LIBRARY = tmpLib; // host 中间件在插件创建时读它，必须在起 vite 之前设
  const port = await new Promise((res) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
  const { createServer } = await import("vite");
  const server = await createServer({
    root: ROOT,
    configFile: path.join(ROOT, "vite.config.ts"),
    server: { port, host: "127.0.0.1", strictPort: true, open: false },
    logLevel: "error",
  });
  await server.listen();
  const origin = `http://127.0.0.1:${port}`;
  const { launchHeadless, instrument } = await imp("scripts/headless-gpu.mjs");
  const session = await launchHeadless({ url: "about:blank", task: "verify-mdl-write-ab", width: 1280, height: 720 });
  instrument(session, { width: 1280, height: 720 });
  // 粒子 / 脚本的随机数固定种子：三臂的差异只能来自 .mdl 字节
  await session.pageCdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: "(() => { let s = 0x9e3779b9; Math.random = () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })();",
  });

  const shoot = async (dir) => {
    await session.pageCdp.send("Page.navigate", { url: `${origin}/renderer/index.html?type=canvas` });
    await session.waitFor("!!window.__wp", { timeoutMs: 60000 });
    const r = await session.evaluate(`(async () => {
      window.__wp.pause();
      const api = await import('/renderer/src/api/editor.ts');
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;left:0;top:0;width:960px;height:540px;z-index:9';
      document.body.appendChild(host);
      const inst = await api.mount(host, { source: api.httpSource('${origin}/media/dev/${dir}'), fit: 'cover', renderDpr: 1, volume: 0, autoplay: false });
      const ed = api.editorOf(inst);
      // 粒子是有状态模拟（每次挂载的步进历史不同），会盖过模型差异；对照只看模型
      for (const l of ed.getLayers()) if (l.kind === 'particle') await ed.setLayerProps(l.id, { visible: false });
      const frames = [];
      const pngs = [];
      for (const t of ${JSON.stringify(TIMES)}) {
        const blob = await ed.capture({ time: t, width: ${CW}, height: ${CH} });
        if (${dump ? "true" : "false"}) {
          const u = new Uint8Array(await blob.arrayBuffer());
          let s = '';
          for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
          pngs.push(btoa(s));
        }
        const bmp = await createImageBitmap(blob);
        const g = new OffscreenCanvas(${CW}, ${CH}).getContext('2d');
        g.drawImage(bmp, 0, 0);
        const d = g.getImageData(0, 0, ${CW}, ${CH}).data;
        let s = '';
        for (let i = 0; i < d.length; i += 0x8000) s += String.fromCharCode.apply(null, d.subarray(i, i + 0x8000));
        frames.push(btoa(s));
      }
      inst.destroy?.();
      return { frames, pngs };
    })()`, { awaitPromise: true, timeoutMs: 180000 });
    if (dump) r.pngs.forEach((b, i) => fs.writeFileSync(path.join(dump, `${dir}-t${TIMES[i]}.png`), Buffer.from(b, "base64")));
    return r.frames;
  };
  /** 平均每通道绝对差（0–255）与差异像素占比 */
  const diff = (a, b) => {
    const x = Buffer.from(a, "base64");
    const y = Buffer.from(b, "base64");
    let sum = 0;
    let px = 0;
    for (let i = 0; i < x.length; i += 4) {
      const d = Math.abs(x[i] - y[i]) + Math.abs(x[i + 1] - y[i + 1]) + Math.abs(x[i + 2] - y[i + 2]);
      sum += d;
      if (d > 6) px++;
    }
    return { mean: sum / ((x.length / 4) * 3), frac: px / (x.length / 4) };
  };
  const blank = (a) => {
    const x = Buffer.from(a, "base64");
    for (let i = 4; i < x.length; i += 4) if (x[i] !== x[0] || x[i + 1] !== x[1] || x[i + 2] !== x[2]) return false;
    return true;
  };

  try {
    for (const id of items) {
      let shots;
      try {
        shots = { orig: await shoot(`${id}-orig`), ctl: await shoot(`${id}-ctl`), enc: await shoot(`${id}-enc`) };
      } catch (e) {
        check(false, `${id}: 出帧失败 ${String(e.message).slice(0, 200)}`);
        continue;
      }
      const rows = TIMES.map((t, i) => ({ t, ctl: diff(shots.orig[i], shots.ctl[i]), enc: diff(shots.orig[i], shots.enc[i]) }));
      console.log(`  ${id}: ` + rows.map((r) => `t=${r.t} 对照 ${r.ctl.mean.toFixed(3)} / 重编码 ${r.enc.mean.toFixed(3)}`).join("，"));
      check(!shots.orig.every(blank), `${id}: 原包出帧不是纯色（夹具有效）`);
      for (const r of rows) {
        check(
          r.enc.mean <= r.ctl.mean + 0.05 && r.enc.frac <= r.ctl.frac + 0.0005,
          `${id}: t=${r.t} 重编码 .mdl 与原包出帧一致（均差 ${r.enc.mean.toFixed(3)}，差异像素 ${(r.enc.frac * 100).toFixed(2)}%；噪声底 ${r.ctl.mean.toFixed(3)} / ${(r.ctl.frac * 100).toFixed(2)}%）`,
        );
      }
    }
  } finally {
    await session.close();
    await server.close();
    if (prevLib === undefined) delete process.env.WE_LIBRARY;
    else process.env.WE_LIBRARY = prevLib;
    fs.rmSync(tmpLib, { recursive: true, force: true });
  }
}

if (errors.length) {
  console.log(`\nverify-mdl-write: ${errors.length} 项失败`);
  process.exit(1);
}
console.log("\nverify-mdl-write: 全部通过");
// G 段的 Chrome / vite 可能留下句柄钉住事件循环，成功分支也显式退出
process.exit(0);
