// 效果「结构编辑」（M1 A1 扩展）：加 / 删 / 上下移 pass、换 material、改 bind / target。
//
// 为什么这件事必须**成对**改两处文件
// ─────────────────────────────────────────────────────────────────────────────
// WE 的效果链是「两段式 + 按位置覆盖」：
//   · effect.json 的 passes[] 决定**执行序与 pass 身份**（material / target / bind）；
//   · scene.json 的 obj.effects[i].passes[j] 只是**按位置**给第 j 个 pass 覆盖常量 /
//     combos，不携带任何身份信息。
// 引擎侧的铁证（本文件每条写点都对着这些行）：
//   · renderer/vendor/we-scene/scene/effects-parse.js:163-164 ——
//     `effect.materialPasses = await Promise.all((ej.passes || []).map(async (p, pi) => {` /
//     `if (!p.material) {`：effect.json 的 passes 顺序原样成为 materialPasses 顺序。
//   · 同文件 :220 `const me = await readAssetName(readOrPkg, p.material)` —— 每个 pass 按
//     `p.material` **各自**取名读材质；两个 pass 共用一条材质路径是合法形态。
//   · 同文件 :243-252 —— 材质里 `passes[0].shader` 缺失时该 pass 被跳过（只发一条诊断），
//     所以换 material 必须换到「工程里真有、且带 shader」的那份，否则图层静默退回内置材质。
//   · 同文件 :257 `target: p.target || null`、:258 `binds: p.bind || []`、:260
//     `textures: mp.textures || []`、:262 `constants: mp.constantshadervalues || {}`。
//   · renderer/vendor/we-scene/render/renderer.js:4994-5008 —— 先按 `eff.fbos`（:4995-5003）
//     建 FBO，再 `flatPasses.push({ eff, mp: passes[pi], ov: eff.passes && eff.passes[pi] })`
//     （:5007）**用同一个 pi 取材质与 scene.json 覆盖**。⇒ pass 数 / 顺序一变，覆盖必须
//     同步增删重排，否则第 j 个覆盖会落到另一个 pass 上（参数静默错位）。
//   · renderer.js:5144-5154 —— `if (mp.target) { … outFBO = effectFBOs.get(mp.target) || curInput }`
//     （:5149）：target 指向**没在 eff.fbos 里声明**的名字时静默回落 curInput（等于没写），
//     所以改 target 必须顺手补 fbos 声明。
//   · renderer.js:5196-5203 —— `for (const b of mp.binds || []) if (b.index === ti) name = b.name`
//     （:5201-5203）：bind 按**纹理槽下标**（数字，严格相等）覆盖该 pass 的取样源。
//
// 合规边界（docs/COMPLIANCE.md：素材库不入库、不分发）
// ─────────────────────────────────────────────────────────────────────────────
// 只允许结构编辑**编辑器自己写进工程**的效果（`effects/wwgl_*/effect.json`，
// 见 editor/effects.ts 的 EFFECT_PREFIX / effectDirNameOf / effectFiles）：这类文件在工程资源表
//（叠加层或工程目录）里，改它 = 改自己的工程，保存后自包含。
// 库引用效果（M6 addEffectRef 只往 scene.json 写引用，库文件不在工程里）**一律禁用结构控件**
// 并给出原因：改库文件 = 把素材库改坏；把库文件复制进工程再改 = COMPLIANCE 明令禁止。
// 判据见 scripts/verify-editor.mjs 的 FX-STRUCT 段（含「库引用效果的控件必须禁用」）。
//
// 一次动作 = 一步撤销，只动 effect.json 一个文件
// ─────────────────────────────────────────────────────────────────────────────
// 加 pass **复用源 pass 已有的 material 路径**（上面 :220 的证据）：引擎按 pass 各自读同一份
// 材质，所以加 pass 不需要新增 / 删除任何材质或 shader 文件。带来的直接好处是撤销只需要把
// effect.json 的字节换回去 —— 工程叠加层没有「删除文件」的 API（editor/assets.ts 只有
// put/share/has/added），一旦要新增文件，撤销后就会在工程里留下孤儿文件。
// 因此本模块的每条 plan 都只产出**一个新文本**（外加 doc 侧的位置同步），由调用方
//（editor/main.ts 的 structEdit + fxFileJournal）记成同一条结构命令。

import { EFFECT_PREFIX, effectDirNameOf } from "./effects";

/** effect.json 的一个 pass：我们只固定认识的键（material / target / bind），其余键原样保留 */
export type FxPass = Record<string, unknown>;
/** effect.json 文档 */
export type FxDoc = Record<string, unknown>;
/** 一条 bind 覆盖：槽下标（数字）+ 要绑的名字。引擎按 `b.index === ti` 严格相等匹配 */
export type FxBindEntry = { name: string; index: number };

/** 本模块要用到的外部世界（纯函数：不碰 DOM / 不碰 overlay） */
export type FxIo = {
  /** 工程资源表里按名读文本（overlay 优先、回落工程目录）；读不到 = null */
  read(name: string): string | null;
  /** 工程资源表里的全部文件名（overlay.list()）；**库引用效果不在其中** */
  projectFiles: ReadonlySet<string>;
};

/** doc 侧（scene.json 的 `obj.effects[i].passes[]`）要做的位置同步 —— 与 effect.json 一一对应 */
export type FxDocSync =
  | { kind: "insert"; at: number }
  | { kind: "remove"; at: number }
  | { kind: "move"; from: number; to: number };

/** 一次结构编辑的产物：新 effect.json 文本 + doc 侧位置同步（+ 自动补的 FBO 声明名） */
export type FxPlan = { file: string; text: string; doc: FxDocSync | null; fbo?: string };

export type FxOutcome<T> = { ok: true; value: T } | { ok: false; reason: string };

/** plan 的失败原因键；每个都必须有中英词条（判据逐个查，界面上不许出现裸键） */
export const FX_STRUCT_REASONS = [
  "fx.structBadJson",
  "fx.structBadIndex",
  "fx.structLastPass",
  "fx.structNoChange",
  "fx.structBadMaterial",
  "fx.structBadTarget",
  "fx.structBadBind",
  "fx.structBindDup",
  "fx.structNoFile",
] as const;

const ok = <T>(value: T): FxOutcome<T> => ({ ok: true, value });
const no = (reason: string): FxOutcome<never> => ({ ok: false, reason });

const asObj = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const cloneJson = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const inRange = (ps: readonly unknown[], i: number): boolean => Number.isInteger(i) && i >= 0 && i < ps.length;

/** 落盘文本：与 editor/effects.ts:521 写 effect.json 的口径一致（2 空格缩进）。
 *  这样「只改一处」在**字节**上成立：JSON.parse → stringify 保序，未动的键逐字节不变。 */
export const serializeEffectDoc = (doc: FxDoc): string => JSON.stringify(doc, null, 2);

/** effect.json 原文 → 文档；坏 JSON / 不是对象 → null */
export function parseEffectDoc(text: string | null | undefined): FxDoc | null {
  if (typeof text !== "string" || !text) return null;
  try {
    return asObj(JSON.parse(text));
  } catch {
    return null;
  }
}

/** passes 数组（**原引用**，可就地 splice）；不是数组 → null */
export function passesOf(doc: FxDoc | null): FxPass[] | null {
  const p = doc?.passes;
  return Array.isArray(p) ? (p as FxPass[]) : null;
}

/** 该 pass 声明的贴图槽（材质 json 的 `passes[0].textures` 由引擎读；这里只读 scene.json / 材质原始字段） */
export function materialOfPass(pass: FxPass | undefined): string | null {
  const m = pass?.material;
  return typeof m === "string" && m ? m : null;
}

/**
 * 该 pass 的 bind 表。引擎读点：effects-parse.js:258 `binds: p.bind || []`（未做类型校验）
 * → renderer.js:5202 `if (b.index === ti) name = b.name`（**严格相等**，所以 index 必须是数字）。
 * 归一化：非对象 / 名字不是字符串 / 下标不是非负整数 的条目一律略过（引擎只会让它们静默失效）。
 */
export function bindsOf(pass: FxPass | undefined): FxBindEntry[] {
  const raw = pass?.bind;
  if (!Array.isArray(raw)) return [];
  const out: FxBindEntry[] = [];
  for (const b of raw) {
    const o = asObj(b);
    if (!o || typeof o.name !== "string" || !o.name) continue;
    const idx = typeof o.index === "number" ? o.index : Number(o.index);
    if (!Number.isInteger(idx) || idx < 0) continue;
    out.push({ name: o.name, index: idx });
  }
  return out;
}

/** effect.json 声明的 FBO 名（引擎在 renderer.js:4995 `for (const f of eff.fbos || [])` 逐个建） */
export function fboNamesOf(doc: FxDoc | null): string[] {
  const raw = doc?.fbos;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const f of raw) {
    const o = asObj(f);
    if (o && typeof o.name === "string" && o.name) out.push(o.name);
  }
  return out;
}

/**
 * 能不能对这条效果做结构编辑？
 *   ① 目录名必须带编辑器自造前缀 `wwgl_`（editor/effects.ts 的 EFFECT_PREFIX）；
 *   ② 而且它必须在**工程资源表**里 —— 库引用效果只有 scene.json 的 `file` 字段指向它，
 *      文件本身在壁纸库里（M6 addEffectRef 的产物），改它等于改素材库（COMPLIANCE 禁止）。
 * 两个条件缺一不可：只查前缀会把「库目录恰好叫 wwgl_x」的极端情形放进来，
 * 只查资源表则会允许改工程里任何一份被引用的官方效果。
 */
export function isStructEditable(file: unknown, projectFiles: ReadonlySet<string>): boolean {
  if (typeof file !== "string" || !file) return false;
  const dir = effectDirNameOf(file);
  if (!dir || !dir.startsWith(EFFECT_PREFIX)) return false;
  return projectFiles.has(file);
}

/** 可选的材质候选（工程内 `materials/**.json`）；当前值无论是否合规都保留在表里，切不回去才是 bug */
export function materialCandidates(io: FxIo, current: string | null): string[] {
  const out = [...io.projectFiles].filter((n) => /^materials\/.+\.json$/.test(n));
  if (current && !out.includes(current)) out.push(current);
  return out.sort();
}

// ───────────────────────────────────────────────────────────────────────────
// 六种结构编辑：都只产出 effect.json 新文本 + doc 侧位置同步
// ───────────────────────────────────────────────────────────────────────────

/**
 * 加 pass：在 index 之后插入一份源 pass 的**完整拷贝**。
 * 是「拷贝」而不是「新建空 pass」：命令 pass 的 `command` / `source`（引擎读点
 * effects-parse.js:198-200）与 material pass 的 `defines` / `textures` 等键都必须跟着走，
 * 只挑我们认识的键去构造等于丢掉作者写过的行为。
 * 材质路径共用（不复制文件）的理由见文件头「一次动作 = 一步撤销」段。
 */
export function planPassAdd(file: string, text: string, index: number): FxOutcome<FxPlan> {
  const doc = parseEffectDoc(text);
  if (!doc) return no("fx.structBadJson");
  const ps = passesOf(doc);
  if (!ps || !inRange(ps, index)) return no("fx.structBadIndex");
  ps.splice(index + 1, 0, cloneJson(ps[index]));
  return ok({ file, text: serializeEffectDoc(doc), doc: { kind: "insert", at: index + 1 } });
}

/**
 * 删 pass：只删这一条，其余顺序不变。
 * 拒绝删掉**最后一个** pass：引擎对空 passes 的效果不会报错，但整条链什么都不画
 *（renderer.js:5005-5008 一个 flatPass 都凑不出来），而 scene.json 里那份效果条目还在 ——
 * 表现为「图层还在、就是不出效果」，比直接删效果更难查。要整条去掉请用 removeEffect。
 */
export function planPassRemove(file: string, text: string, index: number): FxOutcome<FxPlan> {
  const doc = parseEffectDoc(text);
  if (!doc) return no("fx.structBadJson");
  const ps = passesOf(doc);
  if (!ps || !inRange(ps, index)) return no("fx.structBadIndex");
  if (ps.length <= 1) return no("fx.structLastPass");
  ps.splice(index, 1);
  return ok({ file, text: serializeEffectDoc(doc), doc: { kind: "remove", at: index } });
}

/**
 * 上下移 pass：与相邻 pass 换位（执行序 = effect.json 顺序：renderer.js:5005-5008）。
 * doc 侧的覆盖必须同步换位，否则原来挂在 pass j 上的常量会套到新的第 j 个 pass 上
 * （renderer.js:5007 用同一个 pi 取 `ov`）。
 */
export function planPassMove(file: string, text: string, index: number, dir: -1 | 1): FxOutcome<FxPlan> {
  const doc = parseEffectDoc(text);
  if (!doc) return no("fx.structBadJson");
  const ps = passesOf(doc);
  if (!ps || !inRange(ps, index)) return no("fx.structBadIndex");
  const to = index + dir;
  if (!inRange(ps, to)) return no("fx.structNoChange");
  const [moved] = ps.splice(index, 1);
  ps.splice(to, 0, moved);
  return ok({ file, text: serializeEffectDoc(doc), doc: { kind: "move", from: index, to } });
}

/** 工程内材质路径：`materials/**.json`，不许 `..`（写进 effect.json 的路径要能被引擎按名取到） */
const PROJECT_MATERIAL_RE = /^materials\/[A-Za-z0-9_][A-Za-z0-9_./-]*\.json$/;

/**
 * 换 pass 的 material。写入点 = effect.json `passes[i].material`（引擎读点 effects-parse.js:220）。
 * 三重校验，每条都对着引擎行为：
 *   ① 路径必须在**工程资源表**里（同 isStructEditable 的合规理由：不改素材库、不把库文件拖进工程）；
 *   ② 内容必须是能解析的 JSON，且 `passes[0].shader` 是非空字符串 —— 缺 shader 时引擎跳过该 pass
 *      并只发一条诊断（:243-252），用户看到的是「效果忽然没了」；
 *   ③ 值没变 → 拒绝（调用方据此不进撤销栈，避免空动作）。
 */
export function planMaterial(file: string, text: string, index: number, material: string, io: FxIo): FxOutcome<FxPlan> {
  const doc = parseEffectDoc(text);
  if (!doc) return no("fx.structBadJson");
  const ps = passesOf(doc);
  if (!ps || !inRange(ps, index)) return no("fx.structBadIndex");
  if (!PROJECT_MATERIAL_RE.test(material) || material.includes("..")) return no("fx.structBadMaterial");
  if (!io.projectFiles.has(material)) return no("fx.structBadMaterial");
  const mdoc = parseEffectDoc(io.read(material));
  const mps = passesOf(mdoc);
  const shader = mps && typeof mps[0]?.shader === "string" ? (mps[0]!.shader as string) : "";
  if (!shader) return no("fx.structBadMaterial");
  if (ps[index].material === material) return no("fx.structNoChange");
  ps[index].material = material;
  return ok({ file, text: serializeEffectDoc(doc), doc: null });
}

/** FBO 名：WE 语料里是 `_rt_XXX` / 英文标识符；绑定与 target 都靠它按名查表 */
const FBO_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_]*$/;

/**
 * 改 pass 的 target（画进哪个 FBO）。写入点 = effect.json `passes[i].target`
 * （引擎读点 effects-parse.js:257 → renderer.js:5144-5149）。
 * 目标名**没在 `fbos` 里声明**时自动补一条声明：`eff.fbos` 是建 FBO 的唯一来源
 *（renderer.js:4995-5003），查不到就回落 curInput（:5149）—— 等于 target 白写、且毫无提示。
 * 空串 = 清掉 target（回落到「画进当前主 FBO」，:5313-5316 的乒乓分支就靠这个区分）。
 */
export function planTarget(file: string, text: string, index: number, target: string | null): FxOutcome<FxPlan> {
  const doc = parseEffectDoc(text);
  if (!doc) return no("fx.structBadJson");
  const ps = passesOf(doc);
  if (!ps || !inRange(ps, index)) return no("fx.structBadIndex");
  const name = (target ?? "").trim();
  if (!name) {
    if (!("target" in ps[index])) return no("fx.structNoChange");
    delete ps[index].target;
    return ok({ file, text: serializeEffectDoc(doc), doc: null });
  }
  if (!FBO_NAME_RE.test(name)) return no("fx.structBadTarget");
  if (ps[index].target === name) return no("fx.structNoChange");
  ps[index].target = name;
  let declared: string | undefined;
  if (!fboNamesOf(doc).includes(name)) {
    const arr = Array.isArray(doc.fbos) ? (doc.fbos as unknown[]) : (doc.fbos = []);
    // 声明形态照 WE 语料：有名字 + 缩放 + 像素格式（缺省 rgba8888，浮点场要显式写 format）
    arr.push({ name, scale: 1, format: "rgba8888" });
    declared = name;
  }
  return ok({ file, text: serializeEffectDoc(doc), doc: null, fbo: declared });
}

/** bind 名：可以是 FBO 名、`previous`、保留名 `$mediaThumbnail` 之类 */
const BIND_NAME_RE = /^[A-Za-z0-9_$][A-Za-z0-9_$.]*$/;
/** 纹理槽上限：渲染器按 `max(texNames.length, 8)` 个槽循环（renderer.js:5190），给足余量 */
export const FX_BIND_MAX_SLOT = 31;

/**
 * 改 / 加 / 删一条 bind。写入点 = effect.json `passes[i].bind`
 * （引擎读点 effects-parse.js:258 → renderer.js:5201-5203）。
 * `at < 0 || at >= 现有条数` = 追加；`next === null` = 删掉下标 at 那条。
 * 同一 pass 内**槽下标不许重复**：引擎是「后写覆盖先写」（:5201 循环里直接赋值 name），
 * 重复项的结果取决于数组顺序、界面上看不出来，属于必须拒绝的歧义输入。
 */
export function planBind(
  file: string,
  text: string,
  index: number,
  at: number,
  next: FxBindEntry | null,
): FxOutcome<FxPlan> {
  const doc = parseEffectDoc(text);
  if (!doc) return no("fx.structBadJson");
  const ps = passesOf(doc);
  if (!ps || !inRange(ps, index)) return no("fx.structBadIndex");
  const pass = ps[index];
  const list = bindsOf(pass);
  if (next === null) {
    if (at < 0 || at >= list.length) return no("fx.structNoChange");
    list.splice(at, 1);
  } else {
    if (!BIND_NAME_RE.test(next.name)) return no("fx.structBadBind");
    if (!Number.isInteger(next.index) || next.index < 0 || next.index > FX_BIND_MAX_SLOT) return no("fx.structBadBind");
    const dup = list.some((b, i) => b.index === next.index && i !== at);
    if (dup) return no("fx.structBindDup");
    if (at >= 0 && at < list.length) {
      if (list[at].name === next.name && list[at].index === next.index) return no("fx.structNoChange");
      list[at] = { name: next.name, index: next.index };
    } else {
      list.push({ name: next.name, index: next.index });
    }
  }
  if (list.length) pass.bind = list;
  else delete pass.bind;
  return ok({ file, text: serializeEffectDoc(doc), doc: null });
}

// ───────────────────────────────────────────────────────────────────────────
// doc 侧：scene.json 的 `obj.effects[i].passes[]` 位置同步
// ───────────────────────────────────────────────────────────────────────────

/**
 * 把一条 effect.json 的结构变化同步到**一个对象**的 `effects[].passes[]` 覆盖上。
 * 覆盖数组**只按位置**被引擎取用（renderer.js:5007），所以：
 *   · insert → 在 at 处插入一份与源 pass 覆盖同形的拷贝（位置对齐是唯一要求）；
 *   · remove → 删掉第 at 项；
 *   · move   → 第 from 项移到 to。
 * 对象上没有 `passes` 数组时**不动**：引擎对缺项取 `undefined`（:5007 的 `eff.passes && …`），
 * 不会错位到别人身上，凭空造一个数组反而会写进作者没写过的字段。
 * 返回实际改掉的对象个数（0 = 文档没变，调用方据此不入撤销栈）。
 */
export function applyDocSync(obj: Record<string, unknown>, file: string, sync: FxDocSync): number {
  const raw = obj.effects;
  if (!Array.isArray(raw)) return 0;
  let done = 0;
  for (const e of raw) {
    const entry = asObj(e);
    if (!entry || entry.file !== file) continue;
    const ov = entry.passes;
    if (!Array.isArray(ov)) continue;
    if (sync.kind === "insert") {
      const at = Math.max(0, Math.min(sync.at, ov.length));
      const src = ov[Math.min(at - 1, ov.length - 1)];
      ov.splice(at, 0, src === undefined ? {} : cloneJson(src));
      done++;
    } else if (sync.kind === "remove") {
      if (sync.at >= 0 && sync.at < ov.length) {
        ov.splice(sync.at, 1);
        done++;
      }
    } else if (sync.from >= 0 && sync.from < ov.length && sync.to >= 0 && sync.to < ov.length) {
      const [moved] = ov.splice(sync.from, 1);
      ov.splice(sync.to, 0, moved);
      done++;
    }
  }
  return done;
}
