#!/usr/bin/env node
/**
 * verify-editor —— 编辑器页（docs/EDITOR-PLAN.md §3A）各功能的单测与闭环判据。
 *
 * 真源是 editor/*.ts 本身：用 esbuild 打成临时 mjs **真跑**，不在脚本里抄第二份逻辑
 * （verify-loose 同一做法）。渲染层出口 `renderer/src/api/editor` 换成 `api/source.ts`
 * —— 编辑器模块只从它取 Source 工厂，整颗渲染器进 Node 没有意义。
 *
 * 离线部分（稳定集）：
 *   A. 文档模型 doc.ts：图层树、热改写回、结构编辑（删除 / 复制 / 重排）、路径查找
 *   B. 编辑记账 history.ts：撤销栈、属性命令、结构命令快照、热改合并
 *   C. 手柄几何 gizmo.ts：旋转柄 / 角点命中、旋转与缩放数学、点选叠层轮换
 *   D. zip.ts：CRC32 对拍 zlib、结构逐字段回读、系统 unzip 校验、上限报错
 *   E. save.ts：工程收集与 project.json 改写、命名、写目录、写壁纸库请求序列
 *   F. open.ts：本地松散目录 / pkg / 媒体 / 网页分流，文档来源（sourceFromDoc）
 *   G. 宿主保存端点 /api/editor/save-*（真插件 + 本地 HTTP）：校验、标记、覆盖保护
 *   H. 闭环：打开 pkg → 结构编辑 + 热改 → 收集 → 写进库 → 库列出 → 重新打开 → 逐字段一致
 *   M. create.ts：新建模板（分辨率 / 背景色）、图片成层（slug / 三件套 / fit·cover 摆放）
 *   N. assets.ts：资源表叠加层（读优先级、保存清单按文档引用过滤）
 *   O. draft.ts：草稿快照深拷贝、结构化克隆往返、不可信输入校验、套用
 *   P. 新建闭环：空白模板 → 图片层 → 删一张 → 存进库 → 重新打开 → 逐字段 / 逐字节一致
 *   S / U / V. 效果库、脚本预检与挂点、用户属性声明 / 绑定（含引擎接住新声明、属性表撤销快照）
 *   POINTER-STUDIO（B5 / M11）指针工作室 pointer-studio.ts：时间轴插值 / 边界钳制、轨迹序列化往返
 *      与 localStorage 兜底、录制打点、回放取样随播放头前进、停帧摆位不改文档、
 *      导出产物里没有指针字段（scene.json 无指针字段，计划 §6 决策 3）+ 接线 / i18n 键各一次
 *   I. 接线文本断言：页面只经抽出的模块做这些事（不允许再长回内联副本）
 *   J. 变异红测：把实现改坏，确认对应判据会变红（防假绿）
 *
 * 真浏览器部分（--headless，需 Chrome；会自起 vite）：
 *   K. 引擎编辑器控制面：seek / step / 倍速 / capture / hitTestAt / getLayers /
 *      getLayerProps / setLayerProps / getLayerOutline / screenDeltaToLocal
 *   L. 编辑器页端到端：打开项目文件夹、点选、检视器热改、复制 / 重排 / 删除、撤销重做、锁定、
 *      自动保存到项目文件夹并重新打开
 *   Q. 新建端到端：模板新建（先选文件夹）→ 选图 / 拖入加层 → 撤销重做 → 自动保存 → 编辑器与预览渲染页播放
 *   R. 自动保存：刷新没有草稿横幅；再打开同一项目文件夹，图层还在
 *   T / U / V. 效果、脚本、用户属性面板端到端（像素判据 + 保存后预览出帧一致）
 *
 * 用法：
 *   node scripts/verify-editor.mjs              # 离线（A–J、M–V）
 *   node scripts/verify-editor.mjs --headless   # 追加 K、L、Q、R、T、U、V
 */
import { build } from "esbuild";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { ROOT, LIB, imp } from "./lib/verify-kit.mjs";

let failed = 0;
let passed = 0;
function check(ok, msg) {
  if (ok) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}
const section = (t) => console.log(`\n${t}`);
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "verify-editor-"));
const cleanups = [() => fs.rmSync(tmpRoot, { recursive: true, force: true })];
process.on("exit", () => {
  for (const fn of cleanups.reverse()) {
    try {
      fn();
    } catch {
      /* 清理失败不影响判据 */
    }
  }
});
const enc = new TextEncoder();
const dec = new TextDecoder();
const json = (v) => JSON.stringify(v);
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ───────────────────────────────────────────────────────────────────────────
// 模块装载：editor/*.ts 真跑
// ───────────────────────────────────────────────────────────────────────────
const sourceAlias = {
  name: "editor-source-alias",
  setup(b) {
    b.onResolve({ filter: /renderer\/src\/api\/editor$/ }, () => ({ path: "editor-api", namespace: "editor-api" }));
    b.onLoad({ filter: /.*/, namespace: "editor-api" }, () => ({
      contents: [
        `export * from ${json(path.join(ROOT, "renderer/src/api/source.ts"))};`,
        `export { buildScenePkg } from ${json(path.join(ROOT, "renderer/src/editor/pkg-export.ts"))};`,
        `export { checkWeCompat } from ${json(path.join(ROOT, "renderer/src/editor/compat.ts"))};`,
        `export { encodeMdl, mdlMeshMaterials, retargetMdlMaterial, mdlClips, applyBoneDelta, boneDeltaWeights, CLIP_MODES, resampleTrack, addMdlClip, removeMdlClip, setMdlClipMeta, setMdlClipEvents } from ${json(path.join(ROOT, "renderer/src/editor/mdl-edit.ts"))};`,
        `export { SYSTEM_FONT_FAMILIES, TEXT_EM_SCALE } from ${json(path.join(ROOT, "renderer/src/types.ts"))};`,
      ].join("\n"),
      loader: "ts",
      resolveDir: ROOT,
    }));
  },
};

/** 把 editor/<name>.ts 打成可导入模块；overrides = { 绝对路径: 改过的源码 }（变异红测用） */
async function loadEditorModule(name, overrides = {}) {
  const plugins = [sourceAlias];
  if (Object.keys(overrides).length) {
    plugins.push({
      name: "mutate",
      setup(b) {
        b.onLoad({ filter: /\.ts$/ }, (args) =>
          overrides[args.path] !== undefined ? { contents: overrides[args.path], loader: "ts" } : undefined,
        );
      },
    });
  }
  const out = await build({
    entryPoints: [path.join(ROOT, "editor", `${name}.ts`)],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    plugins,
    logLevel: "silent",
  });
  const tmp = path.join(tmpRoot, `${name}-${Math.random().toString(36).slice(2)}.mjs`);
  // 带子目录的模块名（如 plugins/log）要先有目录，否则 writeFileSync 直接 ENOENT
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  fs.writeFileSync(tmp, out.outputFiles[0].text);
  return import(pathToFileURL(tmp).href);
}

/** 宿主插件：system-live 换成空实现（不拉起 media-bridge 子进程） */
async function loadHostModule(srcText) {
  const hostPath = path.join(ROOT, "host/wallpaper-host.ts");
  const out = await build({
    entryPoints: [hostPath],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "node20",
    packages: "external",
    logLevel: "silent",
    plugins: [
      {
        name: "host-stubs",
        setup(b) {
          b.onResolve({ filter: /\/system-live$/ }, () => ({ path: "system-live-stub", namespace: "stub" }));
          b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
            contents: `
              export const onAudioFrame = () => () => {};
              export const startLiveSystemService = async () => ({ backend: "none" });
              export const getAudioStatus = () => "off";
              export const getCachedArtwork = () => null;
              export const getCachedMedia = () => ({});
              export const getCachedWindow = () => ({});
              export const getLiveBackend = () => "none";
              export const readNowPlaying = async () => ({});
              export const readFrontWindow = async () => ({});
              export const controlNowPlaying = async () => ({});
            `,
            loader: "js",
          }));
          if (srcText) b.onLoad({ filter: /wallpaper-host\.ts$/ }, () => ({ contents: srcText, loader: "ts" }));
        },
      },
    ],
  });
  const tmp = path.join(tmpRoot, `host-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(tmp, out.outputFiles[0].text);
  return import(pathToFileURL(tmp).href);
}

const docMod = await loadEditorModule("doc");
const historyMod = await loadEditorModule("history");
const gizmoMod = await loadEditorModule("gizmo");
const zipMod = await loadEditorModule("zip");
const saveMod = await loadEditorModule("save");
const openMod = await loadEditorModule("open");

// ───────────────────────────────────────────────────────────────────────────
// 夹具：一份带父子层级、包装字段、各类图层的 scene.json
// ───────────────────────────────────────────────────────────────────────────
function fixtureScene() {
  return {
    general: { orthogonalprojection: { width: 1920, height: 1080 } },
    objects: [
      { id: 1, name: "bg", image: "models/bg.json", origin: "960 540 0", scale: "1 1 1", angles: "0 0 0" },
      { id: 2, name: "group", origin: "0 0 0" },
      { id: 3, name: "child-a", image: "models/a.json", parent: 2, origin: { user: "pos", value: "10 20 0" } },
      { id: 4, name: "child-b", image: "models/a.json", parent: 2, visible: { user: "show", value: false } },
      { id: 5, name: "grandchild", image: "models/a.json", parent: 3, visible: "0" },
      { id: 6, name: "fx", particle: "particles/p.json" },
      { id: 7, name: "label", text: { value: "hi" } },
      { id: 8, name: "orphan", image: "models/a.json", parent: 99 },
      { id: 9, name: "snd", sound: ["sounds/x.mp3"] },
      { id: 10, name: "lamp", light: "point" },
      { id: 12, name: "self", image: "models/a.json", parent: 12 },
      { name: "noid", model: "models/m.mdl" },
    ],
  };
}
const freshDoc = () => docMod.makeDoc("Fixture", { type: "Scene", title: "Fixture" }, fixtureScene(), "loose");
const ids = (doc) => doc.scene.objects.map((o) => o.id ?? "∅");

// ───────────────────────────────────────────────────────────────────────────
// A. 文档模型
// ───────────────────────────────────────────────────────────────────────────
section("A. 文档模型 doc.ts");
{
  const doc = freshDoc();
  check(doc.type === "scene", `makeDoc：project.type 小写化（实得 ${doc.type}）`);
  check(docMod.makeDoc("x", null, null, null).type === "scene", "makeDoc：缺 project 时类型按 scene");
  check(doc.objectCount === 12, `图层树计数含缺 id 对象（实得 ${doc.objectCount}）`);
  const rootIds = doc.roots.map((n) => n.id);
  check(json(rootIds) === json([1, 2, 6, 7, 8, 9, 10, 12, 11]), `根节点：父不存在 / 自指向父的层按根处理（实得 ${json(rootIds)}）`);
  const kinds = Object.fromEntries(docMod.buildLayerTree(fixtureScene()).roots.map((n) => [n.name, n.kind]));
  check(
    kinds.bg === "image" && kinds.group === "group" && kinds.fx === "particle" && kinds.label === "text" &&
      kinds.snd === "sound" && kinds.lamp === "light" && kinds.noid === "model",
    `图层类型判定（${json(kinds)}）`,
  );
  check(docMod.kindOf({ camera: "main" }) === "camera" && docMod.kindOf({}) === "other", "kindOf：camera / other");
  const noid = doc.roots.find((n) => n.name === "noid");
  check(noid?.id === 11, `缺 id 的对象用数组下标兜底（实得 ${noid?.id}）`);
  const group = doc.roots.find((n) => n.id === 2);
  check(json(group.children.map((n) => n.id)) === json([3, 4]), "父子挂接：group 下是 3、4");
  check(json(group.children[0].children.map((n) => n.id)) === json([5]), "孙层挂在 child-a 下");
  check(group.children[1].visible === false, "visible 包装 {user,value:false} 解析为隐藏");
  check(group.children[0].children[0].visible === false, 'visible 字符串 "0" 解析为隐藏');
  check(doc.roots[0].visible === true, "visible 缺省为可见");
  check(docMod.unwrap({ user: "u", value: 3 }) === 3 && docMod.unwrap(5) === 5 && json(docMod.unwrap([1])) === "[1]", "unwrap：只解 {value} 包装");

  // 路径查找
  const p = docMod.findPath(doc.roots, "5");
  check(json(p?.map((n) => n.id)) === json([2, 3, 5]), "findPath：按字符串比 id，返回根到目标的路径");
  check(docMod.findPath(doc.roots, 404) === null, "findPath：不存在返回 null");
  check(docMod.findNode(doc.roots, 4)?.name === "child-b", "findNode：嵌套命中");

  check(json(docMod.sceneResolution(doc.scene)) === json({ w: 1920, h: 1080 }), "sceneResolution：取 orthogonalprojection");
  check(docMod.sceneResolution({ general: {} }) === null && docMod.sceneResolution(null) === null, "sceneResolution：缺失 / 非正数返回 null");
}
{
  // 热改写回
  const obj = { origin: "0 0 0", scale: { user: "s", value: "1 1 1" }, alpha: 1 };
  docMod.writeObjProps(obj, {
    origin: [1.234567, -0.0000001, 3],
    scale: [2, 2.5, 1],
    angles: [0, 0, Math.PI / 2],
    alpha: 0.1234567,
    visible: false,
    color: [1, 0.5, 0],
  });
  check(obj.origin === "1.23457 0 3", `写回向量：5 位小数、-0 归零、去尾零（实得 "${obj.origin}"）`);
  check(obj.scale.user === "s" && obj.scale.value === "2 2.5 1", "包装字段只改 .value，用户属性绑定保留");
  check(obj.angles === "0 0 1.5708", `新字段直接写入（angles = "${obj.angles}"）`);
  check(obj.alpha === 0.12346 && obj.visible === false && obj.color === "1 0.5 0", "alpha 取 5 位、visible / color 写回");
  const untouched = { origin: "1 2 3" };
  docMod.writeObjProps(untouched, { alpha: 0.5 });
  check(untouched.origin === "1 2 3", "patch 没给的字段不动");
  // 引擎不要求包装里有 value（parse.js:532-546 只要非空 script、:583-598 只要 animation.options）：
  // 这种「无 value 的绑定」也得只补 .value，不能整块换成裸值把脚本删掉（审计 L2）
  const scriptOnly = { id: 9, angles: { script: "return 1;" } };
  docMod.writeObjProps(scriptOnly, { angles: [1, 2, 3] });
  check(scriptOnly.angles.script === "return 1;" && scriptOnly.angles.value === "1 2 3",
    "无 value 的 {script} 绑定：只补 .value，脚本原样保留");
  const animOnly = { id: 10, origin: { animation: { options: { loop: 1 } }, value: "0 0 0" } };
  docMod.writeObjProps(animOnly, { origin: [4, 5, 6] });
  check(animOnly.origin.animation.options.loop === 1 && animOnly.origin.value === "4 5 6", "动画包装同样只改 .value");
  const bare = { id: 11, origin: "0 0 0", alpha: 1 };
  docMod.writeObjProps(bare, { origin: [7, 8, 9] });
  check(bare.origin === "7 8 9", "裸值字段照旧直接覆盖（包装判据放宽不影响它）");
}
{
  // 删除
  const doc = freshDoc();
  check(docMod.removeLayer(doc, 2) === true, "removeLayer：成功返回 true");
  check(json(ids(doc)) === json([1, 6, 7, 8, 9, 10, 12, "∅"]), `removeLayer：连同整棵子树删除（实得 ${json(ids(doc))}）`);
  check(doc.objectCount === 8 && !docMod.findNode(doc.roots, 3), "removeLayer：图层树随之重建");
  check(docMod.removeLayer(doc, 404) === false && doc.objectCount === 8, "removeLayer：不存在的 id 不改文档");
}
{
  // 复制
  const doc = freshDoc();
  const newId = docMod.duplicateLayer(doc, 2, " copy");
  check(newId === 13, `duplicateLayer：新 id = 现有最大数值 id + 1（实得 ${newId}）`);
  check(
    json(ids(doc)) === json([1, 2, 3, 4, 5, 13, 14, 15, 16, 6, 7, 8, 9, 10, 12, "∅"]),
    `duplicateLayer：副本整块插在原子树之后（实得 ${json(ids(doc))}）`,
  );
  const byId = (id) => doc.scene.objects.find((o) => o.id === id);
  check(byId(14).parent === 13 && byId(15).parent === 13 && byId(16).parent === 14, "duplicateLayer：子树内部父指向重映射到副本");
  check(byId(13).name === "group copy" && byId(14).name === "child-a", "duplicateLayer：只有副本根加后缀");
  byId(14).origin.value = "999 0 0";
  check(byId(3).origin.value === "10 20 0", "duplicateLayer：深拷贝（改副本不影响原层）");
  const leaf = docMod.duplicateLayer(doc, 8, "+");
  check(doc.scene.objects.find((o) => o.id === leaf)?.parent === 99, "duplicateLayer：子树外的父指向保持原值");
  check(docMod.duplicateLayer(doc, 404, "x") === null, "duplicateLayer：不存在返回 null");
  check(doc.objectCount === doc.scene.objects.length, "duplicateLayer：图层树计数同步");
}
{
  // 重排
  const doc = freshDoc();
  check(docMod.moveLayer(doc, 6, -1) === true, "moveLayer：前移成功");
  check(json(ids(doc).slice(0, 6)) === json([1, 6, 2, 3, 4, 5]), `moveLayer：前移越过整棵兄弟子树（实得 ${json(ids(doc).slice(0, 6))}）`);
  const d2 = freshDoc();
  docMod.moveLayer(d2, 2, 1);
  check(json(ids(d2).slice(0, 6)) === json([1, 6, 2, 3, 4, 5]), "moveLayer：后移时自身子树整块搬动、块内顺序不变");
  const d3 = freshDoc();
  docMod.moveLayer(d3, 3, 1);
  check(json(ids(d3).slice(1, 5)) === json([2, 4, 3, 5]), `moveLayer：子层只在同父兄弟间移动（实得 ${json(ids(d3).slice(1, 5))}）`);
  const d4 = freshDoc();
  check(docMod.moveLayer(d4, 1, -1) === false && docMod.moveLayer(d4, 4, 1) === false, "moveLayer：已在首 / 末位返回 false");
  check(docMod.moveLayer(d4, 404, 1) === false, "moveLayer：不存在返回 false");
  check(json(ids(d4)) === json(ids(freshDoc())), "moveLayer：失败时文档不变");
  const d5 = freshDoc();
  docMod.moveLayer(d5, 8, -1);
  check(json(ids(d5).slice(6, 8)) === json([8, 7]), "moveLayer：父不存在的层按根层参与重排");
}

// ───────────────────────────────────────────────────────────────────────────
// B. 编辑记账
// ───────────────────────────────────────────────────────────────────────────
section("B. 编辑记账 history.ts");
{
  const h = new historyMod.EditHistory(3);
  check(!h.canUndo && !h.canRedo, "初始无可撤销 / 重做");
  for (let i = 0; i < 5; i++) h.push({ id: i, name: `#${i}`, before: {}, after: { alpha: i } });
  check(h.undoStack.length === 3 && h.undoStack[0].id === 2, "超出上限丢最早的记录");
  const u = h.take("undo");
  check(u?.id === 4 && h.canRedo && h.redoStack[0].id === 4, "撤销：取栈顶并挪进重做栈");
  const r = h.take("redo");
  check(r?.id === 4 && !h.canRedo && h.undoStack.at(-1).id === 4, "重做：挪回撤销栈");
  h.take("undo");
  h.push({ id: 9, name: "#9", before: {}, after: {} });
  check(!h.canRedo, "新编辑入栈后重做栈作废");
  h.clear();
  check(!h.canUndo && !h.canRedo && h.take("undo") === undefined, "clear 后两栈皆空、take 返回 undefined");
  check(new historyMod.EditHistory().limit === 200, "默认上限 200");

  const props = { origin: [1, 2, 3], scale: [1, 1, 1], angles: [0, 0, 0], visible: true, alpha: 1, color: [1, 1, 1] };
  const picked = historyMod.pickProps(props, ["origin", "alpha"]);
  check(json(Object.keys(picked)) === json(["origin", "alpha"]), "pickProps：只取指定字段");
  props.origin[0] = 99;
  check(picked.origin[0] === 1, "pickProps：深拷贝（引擎侧数组后续变化不污染记录）");
  check(historyMod.isNoopEdit({ id: 1, name: "", before: { alpha: 1 }, after: { alpha: 1 } }), "isNoopEdit：前后一致视为无效编辑");
  check(!historyMod.isNoopEdit({ id: 1, name: "", before: { alpha: 1 }, after: { alpha: 0.5 } }), "isNoopEdit：有变化不算");

  const live = new Map();
  const patch = { origin: [1, 2, 3] };
  historyMod.mergeLiveEdit(live, 7, patch);
  historyMod.mergeLiveEdit(live, "7", { alpha: 0.5 });
  historyMod.mergeLiveEdit(live, 7, { origin: [4, 5, 6] });
  patch.origin[0] = -1;
  check(live.size === 1 && json(live.get("7")) === json({ origin: [4, 5, 6], alpha: 0.5 }), "mergeLiveEdit：按层合并（数值 / 字符串 id 同键），后写覆盖");
  check(historyMod.isStruct({ kind: "struct" }) && !historyMod.isStruct({ id: 1 }), "isStruct：区分结构命令与属性命令");
}
{
  const doc = freshDoc();
  const original = json(doc.scene.objects);
  const cmd = historyMod.structCommand(doc, "删除 group", 2, (d) => (docMod.removeLayer(d, 2) ? null : undefined));
  check(cmd?.kind === "struct" && cmd.before === original && cmd.after === json(doc.scene.objects), "structCommand：记录改前改后整份快照");
  check(cmd.selBefore === 2 && cmd.selAfter === null, "structCommand：记录前后选中");
  historyMod.restoreObjects(doc, cmd.before);
  check(json(doc.scene.objects) === original && doc.objectCount === 12 && docMod.findNode(doc.roots, 5), "restoreObjects：撤销换回快照并重建图层树");
  historyMod.restoreObjects(doc, cmd.after);
  check(doc.objectCount === 8, "restoreObjects：重做再换成改后快照");
  check(historyMod.structCommand(doc, "x", null, () => undefined) === null, "structCommand：mutate 返回 undefined 不出命令");
  check(historyMod.structCommand(doc, "x", null, () => 1) === null, "structCommand：对象数组没变不出命令");
  check(historyMod.structCommand({ ...doc, scene: null }, "x", null, () => 1) === null, "structCommand：无场景文档不出命令");
}

// ───────────────────────────────────────────────────────────────────────────
// C. 手柄几何
// ───────────────────────────────────────────────────────────────────────────
section("C. 手柄几何 gizmo.ts");
{
  const { gizmoOf, handleAt, layerAxes, rotateZ, scaleXY, cyclePick, HANDLE, ROTATE_OFFSET, MIN_SCALE } = gizmoMod;
  const rect = [
    [100, 100],
    [300, 100],
    [300, 200],
    [100, 200],
  ];
  const g = gizmoOf([200, 150], rect);
  check(json(g.rotate) === json([200, 100 - ROTATE_OFFSET]), `旋转柄挂在上边中点外侧 ${ROTATE_OFFSET}px（实得 ${json(g.rotate)}）`);
  check(json(g.anchor) === json([200, 150]) && g.corners.length === 4, "锚点与四角原样保留");
  // 旋转 90°（局部上边落到屏幕右侧）：旋转柄跟着转到右边外侧
  const rot = gizmoOf([200, 150], [
    [250, 50],
    [250, 250],
    [150, 250],
    [150, 50],
  ]);
  check(near(rot.rotate[0], 250 + ROTATE_OFFSET) && near(rot.rotate[1], 150), `旋转后旋转柄随层转到局部上边外侧（实得 ${json(rot.rotate)}）`);
  const none = gizmoOf([5, 6], null);
  check(none.corners.length === 0 && none.rotate === null, "无轮廓（如音效层）时只有锚点");
  check(gizmoOf([0, 0], [[1, 1]]).rotate === null, "角点数不是 4 时不出手柄（不越界）");

  check(handleAt(g, 200, 100 - ROTATE_OFFSET)?.kind === "rotate", "命中旋转柄");
  const c2 = handleAt(g, 300, 200);
  check(c2?.kind === "scale" && c2.corner === 2, "命中右下角点（corner=2）");
  check(handleAt(g, 100 + HANDLE, 100)?.kind === "scale", `命中半径含边界（${HANDLE}px）`);
  check(handleAt(g, 100 + HANDLE + 1, 100) === null, "超出命中半径不命中");
  check(handleAt(null, 0, 0) === null, "无手柄时不命中");
  const overlap = { anchor: [0, 0], corners: [[0, 0], [1, 0], [1, 1], [0, 1]], rotate: [0, 0] };
  check(handleAt(overlap, 0, 0)?.kind === "rotate", "旋转柄与角点重叠时旋转柄优先");

  const axes = layerAxes(rect);
  check(json(axes) === json({ ax: [1, 0], ay: [0, 1] }), "未旋转层的局部轴 = 屏幕轴");
  const raxes = layerAxes(rot.corners);
  check(near(raxes.ax[0], 0) && near(raxes.ax[1], 1) && near(raxes.ay[0], -1), "旋转层的局部轴跟着转");
  check(json(layerAxes([])) === json({ ax: [1, 0], ay: [0, 1] }), "无角点退回屏幕轴");

  const z = rotateZ(0.3, [0, 0], [10, 0], [0, 10]);
  check(near(z, 0.3 - Math.PI / 2), `屏幕顺时针拖 90° → 角度减 π/2（实得 ${z.toFixed(4)}）`);
  check(near(rotateZ(0, [0, 0], [10, 0], [10, -10]), Math.PI / 4), "屏幕逆时针 45° → 角度加 π/4");
  const snapped = rotateZ((20 * Math.PI) / 180, [0, 0], [1, 0], [1, 0], 15);
  check(near(snapped, (15 * Math.PI) / 180), `Shift 吸附 15°（20° → ${((snapped * 180) / Math.PI).toFixed(1)}°）`);

  const s0 = [0.5, 0.8, 1];
  const s = scaleXY(s0, [0, 0], [100, 50], [200, 100], axes);
  check(near(s[0], 1) && near(s[1], 1.6) && s[2] === 1, `角点外拖一倍 → 两轴各 ×2、z 不动（实得 ${json(s)}）`);
  const onAxis = scaleXY(s0, [0, 0], [100, 2], [200, 50], axes);
  check(near(onAxis[0], 1) && onAxis[1] === 0.8, "锚点恰在该轴上时该轴不缩放（避免除以近零）");
  const uni = scaleXY([1, 2, 1], [0, 0], [30, 40], [60, 80], axes, true);
  check(near(uni[0], 2) && near(uni[1], 4), "Shift 等比：按到锚点距离之比同乘两轴");
  const flip = scaleXY([1, 1, 1], [0, 0], [100, 100], [-100, -100], axes);
  check(flip[0] === MIN_SCALE && flip[1] === MIN_SCALE, `拖过锚点不翻转，钳到最小 ${MIN_SCALE}`);
  const rs = scaleXY([1, 1, 1], [200, 150], [250, 250], [300, 250], raxes);
  check(near(rs[0], 1) && near(rs[1], 2), `旋转层沿自身轴缩放（屏幕横拖 = 局部 y 轴，实得 ${json(rs)}）`);

  check(cyclePick([], null, false) === null, "点空处：无命中");
  const p1 = cyclePick([3, 1], null, false);
  check(p1.idx === 0, "普通点击选最上层");
  const p2 = cyclePick([3, 1], p1, true);
  const p3 = cyclePick([3, 1], p2, true);
  check(p2.idx === 1 && p3.idx === 0, "Alt+点击同一叠层逐层向下、到底回卷");
  check(cyclePick([3, 1], p2, false).idx === 0, "不按 Alt 回到最上层");
  check(cyclePick([5, 1], p2, true).idx === 0, "换了叠层从最上层开始");
}

// ───────────────────────────────────────────────────────────────────────────
// D. zip
// ───────────────────────────────────────────────────────────────────────────
section("D. zip.ts");
/** 按规范回读 store-only zip：中央目录 → 本地头 → 数据 */
function readZip(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const eocd = buf.length - 22;
  if (dv.getUint32(eocd, true) !== 0x06054b50) throw new Error("EOCD 签名不对");
  const count = dv.getUint16(eocd + 10, true);
  const cdSize = dv.getUint32(eocd + 12, true);
  const cdOff = dv.getUint32(eocd + 16, true);
  if (cdOff + cdSize !== eocd) throw new Error("中央目录位置 / 大小与 EOCD 不符");
  const out = [];
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error(`中央目录项 ${i} 签名不对`);
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    const size = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
    if (dv.getUint32(local, true) !== 0x04034b50) throw new Error(`本地头 ${name} 签名不对`);
    const lNameLen = dv.getUint16(local + 26, true);
    const lCrc = dv.getUint32(local + 14, true);
    const start = local + 30 + lNameLen + dv.getUint16(local + 28, true);
    out.push({ name, flags, method, crc, lCrc, size, usize, data: buf.subarray(start, start + size) });
    p += 46 + nameLen;
  }
  return out;
}
{
  const { crc32, buildZip } = zipMod;
  const samples = [new Uint8Array(0), enc.encode("hello"), crypto.getRandomValues(new Uint8Array(65536))];
  check(samples.every((s) => crc32(s) === zlib.crc32(s)), "crc32 与 zlib.crc32 逐样本一致（空 / 文本 / 64KB 随机）");
  const entries = [
    { path: "scene.json", data: enc.encode('{"objects":[]}') },
    { path: "materials/中文 贴图.tex", data: crypto.getRandomValues(new Uint8Array(4096)) },
    { path: "empty.bin", data: new Uint8Array(0) },
  ];
  const blob = buildZip(entries, new Date(2026, 9, 6, 14, 30, 10));
  const buf = new Uint8Array(await blob.arrayBuffer());
  check(blob.type === "application/zip", "Blob 类型 application/zip");
  let parsed = [];
  try {
    parsed = readZip(buf);
  } catch (e) {
    check(false, `zip 结构回读失败：${e.message}`);
  }
  check(parsed.length === 3 && parsed.every((e, i) => e.name === entries[i].path), "条目数与 UTF-8 文件名逐个回读一致（含中文与空格）");
  check(parsed.every((e) => e.flags === 0x0800 && e.method === 0), "通用标志 bit11（UTF-8 文件名）+ store 方法");
  check(parsed.every((e, i) => e.size === entries[i].data.length && e.usize === e.size), "压缩 / 原始大小 = 数据长度");
  check(parsed.every((e, i) => e.crc === e.lCrc && e.crc === zlib.crc32(entries[i].data)), "中央目录与本地头的 CRC 一致且正确");
  check(parsed.every((e, i) => Buffer.compare(Buffer.from(e.data), Buffer.from(entries[i].data)) === 0), "数据逐字节一致");
  const dv = new DataView(buf.buffer);
  const time = dv.getUint16(10, true);
  const date = dv.getUint16(12, true);
  check(time === ((14 << 11) | (30 << 5) | 5) && date === (((2026 - 1980) << 9) | (10 << 5) | 6), "DOS 时间戳按本地时间编码");

  const zipPath = path.join(tmpRoot, "t.zip");
  fs.writeFileSync(zipPath, buf);
  const unzip = spawnSync("unzip", ["-t", zipPath], { encoding: "utf8" });
  if (unzip.error) console.log("      · 无 unzip，跳过系统解压校验");
  else check(unzip.status === 0 && /No errors detected/.test(unzip.stdout), "系统 unzip -t 校验通过");

  const empty = new Uint8Array(await buildZip([]).arrayBuffer());
  check(empty.length === 22 && readZip(empty).length === 0, "空 zip 只有 EOCD，可回读");
  let threw = "";
  try {
    buildZip(Array.from({ length: 65536 }, () => ({ path: "a", data: new Uint8Array(0) })));
  } catch (e) {
    threw = e.message;
  }
  check(/65535/.test(threw), "超过 65535 个条目明确报错（未实现 ZIP64）");
  threw = "";
  try {
    buildZip([{ path: "huge", data: { length: 2 ** 32 } }]);
  } catch (e) {
    threw = e.message;
  }
  check(/4 GiB/.test(threw), "单文件 ≥ 4 GiB 明确报错（在算 CRC 之前就拦下）");
}

// ───────────────────────────────────────────────────────────────────────────
// E. 保存
// ───────────────────────────────────────────────────────────────────────────
section("E. 保存 save.ts");
function memAssets(entry, files) {
  const reads = [];
  return {
    reads,
    entry,
    async read(name) {
      reads.push(name);
      return files[name] ?? null;
    },
    list: () => Object.keys(files).filter((n) => n !== entry),
  };
}
{
  const doc = freshDoc();
  doc.project = { type: "scene", title: "  ", file: "scene.pkg", preview: "old.gif", workshopid: "123", workshopurl: "u", general: { properties: { a: 1 } } };
  const assets = memAssets("scene.json", {
    "scene.json": enc.encode("{}"),
    "materials/a.tex": new Uint8Array([1, 2, 3]),
    "PROJECT.JSON": enc.encode("stale"),
    "Preview.JPG": new Uint8Array([9]),
    "models/gone.json": null,
  });
  const progress = [];
  const preview = new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: "image/jpeg" });
  const files = await saveMod.collectProject(doc, assets, preview, (d, t) => progress.push(`${d}/${t}`));
  const byPath = Object.fromEntries(files.map((f) => [f.path, f.data]));
  check(json(Object.keys(byPath)) === json(["materials/a.tex", "scene.json", "preview.jpg", "project.json"]), `收集清单：资源 + 入口 + 封面 + project.json（实得 ${json(Object.keys(byPath))}）`);
  check(!assets.reads.includes("scene.json"), "入口 json 不读原件（用文档序列化）");
  check(json(JSON.parse(dec.decode(byPath["scene.json"]))) === json(doc.scene), "入口 json = 当前文档（含全部编辑）");
  check(dec.decode(byPath["scene.json"]).includes('\n  "general"'), "入口 json 带缩进（便于 diff / 手改）");
  check(json(progress) === json(["1/2", "2/2"]), `进度回调按资源逐个报（实得 ${json(progress)}）`);
  // 审计 M2：本轮读不到字节、但仍挂在资源表里的名字要回报给调用方 ——
  // 页面拿它当「别删这个已写出文件」的免删名单，否则源暂时取不到时用户文件夹里的资源会无声消失
  const unreadable = new Set();
  const files2 = await saveMod.collectProject(doc, assets, preview, undefined, unreadable);
  check(json([...unreadable]) === json(["models/gone.json"]), `collectProject 回报读不到的资源名（实得 ${json([...unreadable])}）`);
  check(json(files2.map((f) => f.path)) === json(Object.keys(byPath)) && !unreadable.has("materials/a.tex"), "回报读不到的名字不改变清单本身");
  check(!files.some((f) => /^project\.json$/i.test(f.path) && f.data.length === 5), "旧 project.json / 封面（大小写不敏感）不从资源里带出");
  const pj = JSON.parse(dec.decode(byPath["project.json"]));
  check(pj.type === "scene" && pj.file === "scene.json" && pj.preview === "preview.jpg", "project.json：类型 scene、入口指向文档、封面换成编辑器出图");
  check(pj.title === "Fixture", "project.json：空白标题退回文档标题");
  check(pj.workshopid === undefined && pj.workshopurl === undefined, "project.json：去掉创意工坊标识（另存是新工程）");
  check(pj.general?.properties?.a === 1, "project.json：其余字段（用户属性）原样保留");
  check(doc.project.file === "scene.pkg", "收集不改动原文档的 project");
  const noPrev = await saveMod.collectProject(doc, memAssets("scene.json", {}), null);
  const pj2 = JSON.parse(dec.decode(noPrev.find((f) => f.path === "project.json").data));
  check(pj2.preview === undefined && !noPrev.some((f) => f.path === "preview.jpg"), "没出封面就不留悬空 preview 引用");
  let threw = false;
  try {
    await saveMod.collectProject({ ...doc, scene: null }, assets, null);
  } catch {
    threw = true;
  }
  check(threw, "无场景文档时拒绝保存");
  check(saveMod.totalBytes(files) === files.reduce((s, f) => s + f.data.length, 0), "totalBytes 求和");
}
{
  check(saveMod.slugName('  a/b:c*d?"e<f>g|h  ') === "abcdefgh", "slugName：去掉文件名非法字符与首尾空白");
  check(saveMod.slugName("海滩  日落") === "海滩 日落", "slugName：保留中文、合并空白");
  check(saveMod.slugName("///") === "wallpaper" && saveMod.slugName("x".repeat(100)).length === 60, "slugName：空了用 wallpaper，长度上限 60");
  const id1 = saveMod.newLibraryItemId("My Beach! 2");
  check(/^editor-my-beach-2-[0-9a-z]+$/.test(id1), `newLibraryItemId：ascii slug + 时间戳（${id1}）`);
  check(/^editor-wallpaper-[0-9a-z]+$/.test(saveMod.newLibraryItemId("海滩")), "newLibraryItemId：非 ASCII 标题退回 wallpaper");
  check(/^[A-Za-z0-9_-]{1,80}$/.test(saveMod.newLibraryItemId("x".repeat(200))), "newLibraryItemId：总能通过宿主的 itemId 白名单");
}
{
  // 写本机文件夹（File System Access 句柄的内存实现）
  const created = [];
  const written = new Map();
  const mkDir = (p) => ({
    name: p || "root",
    async getDirectoryHandle(name, opts) {
      if (!opts?.create) throw new Error("must create");
      const child = p ? `${p}/${name}` : name;
      created.push(child);
      return mkDir(child);
    },
    async getFileHandle(name) {
      const full = p ? `${p}/${name}` : name;
      return {
        async createWritable() {
          const chunks = [];
          return {
            async write(d) {
              chunks.push(Buffer.from(d));
            },
            async close() {
              written.set(full, Buffer.concat(chunks));
            },
          };
        },
      };
    },
  });
  const files = [
    { path: "materials/a/x.tex", data: new Uint8Array([1]) },
    { path: "materials/a/y.tex", data: new Uint8Array([2, 2]) },
    { path: "scene.json", data: enc.encode("{}") },
  ];
  const progress = [];
  await saveMod.writeToDirectory(mkDir(""), files, (d, t) => progress.push(d === t));
  check(json(created) === json(["materials", "materials/a"]), `writeToDirectory：子目录逐级创建且只建一次（实得 ${json(created)}）`);
  check(written.get("materials/a/y.tex")?.length === 2 && written.get("scene.json")?.toString() === "{}", "writeToDirectory：文件按相对路径写入");
  check(json(progress) === json([false, false, true]), "writeToDirectory：逐文件报进度");
}
{
  // 写壁纸库：请求序列与错误透传
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, method: init?.method, len: init?.body?.length ?? 0 });
    if (String(url).includes("path=bad")) return new Response(JSON.stringify({ error: "坏路径" }), { status: 400 });
    return new Response("{}", { status: 200 });
  };
  try {
    const progress = [];
    await saveMod.saveToLibrary("editor-x-1", [
      { path: "materials/中 文.tex", data: new Uint8Array(3) },
      { path: "project.json", data: new Uint8Array(1) },
    ], (d) => progress.push(d));
    check(calls[0].url === "/api/editor/save-begin?item=editor-x-1" && calls[0].method === "POST", "saveToLibrary：先 save-begin");
    check(calls[1].url === `/api/editor/save-file?item=editor-x-1&path=${encodeURIComponent("materials/中 文.tex")}` && calls[1].len === 3, "saveToLibrary：逐文件 save-file，路径 URL 编码、body 为原始字节");
    check(calls.length === 3 && json(progress) === json([1, 2]), "saveToLibrary：每个文件一次请求、逐个报进度");
    let msg = "";
    try {
      await saveMod.saveToLibrary("editor-x-1", [{ path: "bad", data: new Uint8Array(1) }]);
    } catch (e) {
      msg = e.message;
    }
    check(msg === "坏路径", `saveToLibrary：宿主错误信息透传给页面（实得 "${msg}"）`);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// F. 打开
// ───────────────────────────────────────────────────────────────────────────
section("F. 打开 open.ts");
const { packSourceProject } = await imp("scripts/dev-pack-pkg.mjs");
const fixtureFiles = {
  "scene.json": enc.encode(json(fixtureScene())),
  "models/a.json": enc.encode(json({ material: "materials/a.json" })),
  "models/bg.json": enc.encode(json({ material: "materials/a.json" })),
  "materials/a.json": enc.encode(json({ passes: [{ textures: ["a"] }] })),
  "materials/a.tex": crypto.getRandomValues(new Uint8Array(2048)),
};
const fixtureProject = { type: "scene", title: "Fixture Pkg", file: "scene.pkg", preview: "preview.gif", workshopid: "42" };
const pkgSrc = path.join(tmpRoot, "pkg-src");
for (const [rel, data] of Object.entries(fixtureFiles)) {
  fs.mkdirSync(path.dirname(path.join(pkgSrc, rel)), { recursive: true });
  fs.writeFileSync(path.join(pkgSrc, rel), data);
}
const pkgBytes = packSourceProject(pkgSrc).buffer;
const localFile = (p, data) => ({ path: p, file: new File([data], p.split("/").pop()) });
{
  const opened = await openMod.openLocalFiles([
    localFile("Fixture Pkg/project.json", enc.encode(json(fixtureProject))),
    localFile("Fixture Pkg/scene.pkg", pkgBytes),
  ]);
  check(opened.doc.form === "pkg" && opened.doc.title === "Fixture Pkg", "本地 pkg：按包形态打开，标题取 project.title");
  check(opened.doc.objectCount === 12, "本地 pkg：从包内入口 json 建出图层树");
  check(opened.assets?.entry === "scene.json", "本地 pkg：资源读取器入口 = 包内 scene.json");
  const listed = opened.assets.list().sort();
  check(json(listed) === json(["materials/a.json", "materials/a.tex", "models/a.json", "models/bg.json"]), `本地 pkg：保存清单 = 包内全部条目去掉入口（${json(listed)}）`);
  const tex = await opened.assets.read("materials/a.tex");
  check(tex && Buffer.compare(Buffer.from(tex), Buffer.from(fixtureFiles["materials/a.tex"])) === 0, "本地 pkg：按名读到原字节");
  check((await opened.assets.read("nope")) == null, "本地 pkg：缺文件返回空");
  check(typeof opened.source.scenePkg === "function" && !!opened.source.key, "本地 pkg：交给引擎的是带缓存键的字节来源");
}
{
  const files = Object.entries(fixtureFiles).map(([rel, data]) => localFile(`proj/${rel === "scene.json" ? "Scene.JSON" : rel}`, data));
  files.push(localFile("proj/project.json", enc.encode(json({ type: "scene", title: "Loose Proj", file: "scene.json" }))));
  const opened = await openMod.openLocalFiles(files);
  check(opened.doc.form === "loose" && opened.doc.objectCount === 12, "本地目录：有散装入口 json 时按松散工程打开");
  check(opened.assets.entry === "scene.json", "本地目录：入口取 project.file 声明的名字");
  check((await opened.assets.read("scene.json"))?.length === fixtureFiles["scene.json"].length, "本地目录：大小写不一致的引用也能读到（Windows 工程常见）");
  check(!opened.assets.list().includes("proj/project.json") && opened.assets.list().includes("materials/a.tex"), "本地目录：去掉公共根目录前缀");
  const dir = await opened.source.sceneDir();
  check(dir === opened.assets, "本地目录：引擎与保存共用同一读取器");
}
{
  const vid = await openMod.openLocalFiles([
    localFile("v/project.json", enc.encode(json({ type: "video", file: "a.mp4" }))),
    localFile("v/a.mp4", new Uint8Array(8)),
  ]);
  check(vid.doc.type === "video" && !vid.assets, "视频壁纸：无场景资源（没有图层可编）");
  check(vid.doc.video?.path === "a.mp4" && vid.doc.video.bytes.length === 8, "视频壁纸：视频本体进文档（doc.video），可裁剪 / 替换 / 保存");
  let msg = "";
  const webLocal = await openMod.openLocalFiles([
    localFile("w/project.json", enc.encode(json({ type: "web", title: "Web Proj", file: "index.html" }))),
    localFile("w/index.html", enc.encode('<html><body><script src="js/app.js"></script></body></html>')),
    localFile("w/js/app.js", enc.encode("console.log(1)")),
  ]);
  check(webLocal.doc.type === "web" && webLocal.doc.scene == null, "本地网页壁纸目录：打开不改型（type 仍 web，无场景文档）");
  check(
    webLocal.assets.entry === "index.html" && json(webLocal.assets.list()) === json(["project.json", "js/app.js"]),
    `本地网页壁纸目录：文件清单原样保留（${json(webLocal.assets.list())}）`,
  );
  check((await webLocal.assets.read("js/app.js"))?.length === 14, "本地网页壁纸目录：资源按名读到原字节");
  try {
    await webLocal.source.webEntry();
  } catch (e) {
    msg = e.message;
  }
  check(/相对资源无法解析/.test(msg), `本地网页壁纸目录：预览时明确报相对资源无法解析（${msg}）`);
  msg = "";
  try {
    await openMod.openLocalFiles([localFile("w2/project.json", enc.encode(json({ type: "web", file: "index.html" })))]);
  } catch (e) {
    msg = e.message;
  }
  check(/找不到入口 html/.test(msg), `本地网页壁纸目录：没有入口 html 时明确报错（${msg}）`);
  msg = "";
  try {
    await openMod.openLocalFiles([localFile("x/readme.txt", enc.encode("hi"))]);
  } catch (e) {
    msg = e.message;
  }
  check(msg === "no-wallpaper", "无壁纸内容报 no-wallpaper");
}
{
  // 文档来源：入口换成文档，其余透传
  const reads = [];
  const assets = { entry: "scene.json", read: async (n) => (reads.push(n), n === "materials/a.tex" ? new Uint8Array([7]) : null), list: () => [] };
  const base = { key: "k", project: async () => ({ title: "P" }), scenePkg: async () => new ArrayBuffer(0) };
  const src = openMod.sourceFromDoc(base, assets, '{"objects":[{"id":1}]}');
  check(src.key === undefined, "sourceFromDoc：不带缓存键（每版文档都不同）");
  const dir = await src.sceneDir();
  check(dir.entry === "scene.json" && dec.decode(await dir.read("scene.json")) === '{"objects":[{"id":1}]}', "sourceFromDoc：入口读到的是文档字节");
  check(!reads.includes("scene.json"), "sourceFromDoc：入口不落到原始读取器");
  check((await dir.read("materials/a.tex"))?.[0] === 7, "sourceFromDoc：其余资源按名透传");
  check((await src.project()).title === "P", "sourceFromDoc：project 委托原来源");
  let threw = false;
  try {
    await src.scenePkg();
  } catch {
    threw = true;
  }
  check(threw, "sourceFromDoc：只有松散形态（scenePkg 明确抛错）");
  const proj = { title: "Doc", general: { properties: { op: { type: "slider", value: 0.3 } } } };
  const src2 = openMod.sourceFromDoc(base, assets, "{}", proj);
  proj.general.properties.op.value = 0.9;
  const got = await src2.project();
  check(got.title === "Doc" && got.general.properties.op.value === 0.3, "sourceFromDoc：给了文档 project 时以它为准，且是挂载那一刻的快照（之后改文档不串）");
  got.title = "x";
  check((await src2.project()).title === "Doc", "sourceFromDoc：每次取都是新副本（引擎就地改不污染）");
  check(openMod.libraryKind({ type: "Video", hasScene: false }) === "video" && openMod.libraryKind({ type: "web", hasScene: false, hasLooseScene: true }) === "scene", "libraryKind：场景包 / 松散场景优先，其余按类型");
}

// ───────────────────────────────────────────────────────────────────────────
// G. 宿主保存端点（真插件 + 本地 HTTP）
// ───────────────────────────────────────────────────────────────────────────
section("G. 宿主保存端点 /api/editor/save-*");
const HOST_TS = fs.readFileSync(path.join(ROOT, "host/wallpaper-host.ts"), "utf8");

/** 起一个只挂宿主中间件的 HTTP 服务器；返回 base 与 close */
async function startHost(libDir, srcText) {
  const prev = process.env.WE_LIBRARY;
  const prevShim = process.env.WWGL_WEB_SHIM;
  process.env.WE_LIBRARY = libDir;
  // /web/*.html 会注入 WE shim，注入器按**自己模块所在目录**找 renderer/src/web-shim.js；
  // 这里跑的是 esbuild 打到系统临时目录的 bundle，按相对路径必然找不到 → 取 HTML 资源 500。
  // 打包后的应用也是用这个环境变量指回 shim（scripts/build-app.mjs），测试台照做。
  process.env.WWGL_WEB_SHIM = path.join(ROOT, "renderer", "src", "web-shim.js");
  const mod = await loadHostModule(srcText);
  const plugin = mod.wallpaperHost();
  // configureServer 里才建中间件，而中间件在创建时把壁纸库目录定死（let lib = libraryDir()）：
  // WE_LIBRARY 必须留到 configureServer 之后才能还原，否则这套测试会把 fixture
  // （author-item / fresh）写进用户真正的壁纸库目录
  const handlers = [];
  plugin.configureServer({ config: { logger: { info() {}, warn() {}, error() {} } }, middlewares: { use: (fn) => handlers.push(fn) } });
  if (prev === undefined) delete process.env.WE_LIBRARY;
  else process.env.WE_LIBRARY = prev;
  const server = http.createServer((req, res) => {
    let i = 0;
    const next = () => {
      const h = handlers[i++];
      if (!h) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      Promise.resolve(h(req, res, next)).catch((e) => {
        res.statusCode = 500;
        res.end(String(e));
      });
    };
    next();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => {
      if (prevShim === undefined) delete process.env.WWGL_WEB_SHIM;
      else process.env.WWGL_WEB_SHIM = prevShim;
      return new Promise((r) => server.close(r));
    },
  };
}

const hostLib = path.join(tmpRoot, "lib");
fs.mkdirSync(path.join(hostLib, "author-item"), { recursive: true });
fs.writeFileSync(path.join(hostLib, "author-item/project.json"), json({ type: "scene", file: "scene.json" }));
fs.writeFileSync(path.join(hostLib, "author-item/scene.json"), json(fixtureScene()));
const host = await startHost(hostLib);
cleanups.push(() => host.close());
const post = (p, body) => fetch(`${host.base}${p}`, { method: "POST", body });
{
  check((await fetch(`${host.base}/api/editor/save-begin?item=a`)).status === 405, "GET 被拒（405，只收 POST）");
  check((await post("/api/editor/save-begin?item=../evil")).status === 400, "非法 itemId（含 ../）被拒（400）");
  check((await post("/api/editor/save-begin?item=")).status === 400, "空 itemId 被拒（400）");
  check((await post("/api/editor/save-begin?item=author-item")).status === 409, "作者原始条目（无编辑器标记）拒绝覆盖（409）");
  check(fs.existsSync(path.join(hostLib, "author-item/scene.json")), "被拒后原始条目文件完好");
  check((await post("/api/editor/save-file?item=fresh&path=a.txt", "x")).status === 409, "未 begin 就写文件被拒（409）");

  const r = await post("/api/editor/save-begin?item=fresh");
  check(r.status === 200 && fs.existsSync(path.join(hostLib, "fresh/.webwallgl-editor")), "save-begin：新建目录并写入编辑器标记");
  const w = await post(`/api/editor/save-file?item=fresh&path=${encodeURIComponent("materials/深/x.tex")}`, new Uint8Array([1, 2, 3]));
  const wj = await w.json();
  check(w.status === 200 && wj.bytes === 3, "save-file：写入嵌套路径（自动建父目录、中文路径）");
  check(fs.readFileSync(path.join(hostLib, "fresh/materials/深/x.tex")).length === 3, "save-file：盘上字节一致");
  check((await post(`/api/editor/save-file?item=fresh&path=${encodeURIComponent("../../escape.txt")}`, "x")).status === 200 && !fs.existsSync(path.join(tmpRoot, "escape.txt")), "save-file：`..` 被规范化回条目目录内（不会写到库外）");
  check((await post("/api/editor/save-file?item=fresh&path=.webwallgl-editor", "x")).status === 400, "save-file：不许覆写编辑器标记");
  check((await post("/api/editor/save-file?item=fresh&path=", "x")).status === 400, "save-file：空路径被拒");
  await post("/api/editor/save-begin?item=fresh");
  check(!fs.existsSync(path.join(hostLib, "fresh/materials")) && fs.existsSync(path.join(hostLib, "fresh/.webwallgl-editor")), "再次 save-begin：清空上次产物（删掉的资源不残留），标记重建");
}

// ───────────────────────────────────────────────────────────────────────────
// H. 闭环：打开 → 编辑 → 保存进库 → 库列出 → 重新打开
// ───────────────────────────────────────────────────────────────────────────
section("H. 保存闭环");
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => realFetch(String(url).startsWith("/") ? `${host.base}${url}` : url, init);
  try {
    const opened = await openMod.openLocalFiles([
      localFile("Fixture Pkg/project.json", enc.encode(json(fixtureProject))),
      localFile("Fixture Pkg/scene.pkg", pkgBytes),
    ]);
    const doc = opened.doc;
    const newId = docMod.duplicateLayer(doc, 1, " copy");
    docMod.writeObjProps(docMod.findNode(doc.roots, newId).obj, { origin: [900, 500, 0], scale: [0.6, 0.6, 1], angles: [0, 0, 0.2] });
    docMod.moveLayer(doc, 6, -1);
    docMod.removeLayer(doc, 9);
    const preview = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])]);
    const files = await saveMod.collectProject(doc, opened.assets, preview);
    const itemId = saveMod.newLibraryItemId(doc.title);
    await saveMod.saveToLibrary(itemId, files);
    const disk = fs.readdirSync(path.join(hostLib, itemId), { recursive: true }).filter((n) => !fs.statSync(path.join(hostLib, itemId, n)).isDirectory());
    check(disk.length === files.length + 1, `盘上文件 = 保存清单 + 编辑器标记（${disk.length} 个）`);

    const lib = await openMod.fetchLibrary();
    const it = lib?.items.find((i) => i.itemId === itemId);
    check(!!it && openMod.libraryKind(it) === "scene" && it.hasLooseScene && !it.hasScene, "/api/library 把保存产物列为松散场景");
    check(it?.preview === "preview.jpg" && it.title === "Fixture Pkg", "库条目封面 = 编辑器出图，标题保留");

    const reopened = await openMod.openLibraryItem(it, `${host.base}/media/dev`, `${host.base}/web/dev`);
    check(reopened.doc.form === "loose", "重新打开：走松散形态");
    check(json(reopened.doc.scene) === json(doc.scene), "重新打开：scene.json 与保存前文档逐字段一致（复制 / 热改 / 重排 / 删除都在）");
    const copy = reopened.doc.scene.objects.find((o) => o.id === newId);
    check(copy?.origin === "900 500 0" && copy.scale === "0.6 0.6 1" && copy.name === "bg copy", "重新打开：副本层的变换与命名保留");
    const tex = await reopened.assets.read("materials/a.tex");
    check(tex && Buffer.compare(Buffer.from(tex), Buffer.from(fixtureFiles["materials/a.tex"])) === 0, "重新打开：资源字节与原包一致");
    await reopened.assets.read("models/a.json");
    await reopened.assets.read("models/none.json");
    const tracked = reopened.assets.list().sort();
    check(json(tracked) === json(["materials/a.tex", "models/a.json"]), `库内松散工程：保存清单 = 实际读到过的资源（不含入口、不含缺失，实得 ${json(tracked)}）`);
    const engineDir = await reopened.source.sceneDir();
    check(engineDir === reopened.assets && reopened.source.key === undefined, "库内松散工程：引擎经同一读取器取资源，且不吃库内缓存（否则记不到读取）");

    // 二次保存覆盖同一条目
    docMod.removeLayer(reopened.doc, newId);
    await saveMod.saveToLibrary(itemId, await saveMod.collectProject(reopened.doc, reopened.assets, null));
    const after = JSON.parse(fs.readFileSync(path.join(hostLib, itemId, "scene.json"), "utf8"));
    check(!after.objects.some((o) => o.id === newId) && !fs.existsSync(path.join(hostLib, itemId, "preview.jpg")), "同一条目再存即覆盖（旧封面等残留被清掉）");
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// WEB-PROJ. 网页壁纸工程（type:"web"）：打开与保存不改型 + 相对资源解析
// ───────────────────────────────────────────────────────────────────────────
section('WEB-PROJ. 网页壁纸工程（type:"web"）打开与保存不改型');
{
  // 夹具：一个真实的网页工程 —— 入口 html + 子目录资源 + 带空格/中文的路径。
  // 另外埋两个点开头的文件（.DS_Store 与编辑器标记）：它们不是工程资源，不能进清单。
  const webItemSrc = path.join(hostLib, "web-item");
  const webEntryHtml =
    '<!doctype html>\n<html><head><link rel="stylesheet" href="css/深 色/style.css"></head>\n<body><script src="js/app.js"></script></body></html>\n';
  const webAppJs = "window.__webFixture = 1;\n";
  const webCss = "body { background: #123; }\n";
  fs.mkdirSync(path.join(webItemSrc, "js"), { recursive: true });
  fs.mkdirSync(path.join(webItemSrc, "css/深 色"), { recursive: true });
  fs.writeFileSync(
    path.join(webItemSrc, "project.json"),
    json({ type: "Web", title: "Web Fixture", file: "index.html", preview: "preview.gif", general: { properties: { speed: 1 } } }),
  );
  fs.writeFileSync(path.join(webItemSrc, "index.html"), webEntryHtml);
  fs.writeFileSync(path.join(webItemSrc, "js/app.js"), webAppJs);
  fs.writeFileSync(path.join(webItemSrc, "css/深 色/style.css"), webCss);
  fs.writeFileSync(path.join(webItemSrc, "preview.gif"), new Uint8Array([0x47, 0x49, 0x46]));
  fs.writeFileSync(path.join(webItemSrc, ".DS_Store"), new Uint8Array([0]));

  const getJson = async (p) => {
    const r = await fetch(`${host.base}${p}`);
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  // 1) 宿主清单端点：入口 + 全部资源
  const mf = await getJson("/api/editor/web-manifest?item=web-item");
  check(mf.status === 200 && mf.body?.ok === true, "web-manifest：网页工程返回 200");
  check(mf.body.entry === "index.html", `web-manifest：入口取声明的 file（${mf.body?.entry}）`);
  check(
    json(mf.body.files) === json(["css/深 色/style.css", "index.html", "js/app.js", "preview.gif", "project.json"]),
    `web-manifest：清单 = 工程内全部文件（含中文/空格路径，实得 ${json(mf.body.files)}）`,
  );
  check(mf.body.count === mf.body.files.length, "web-manifest：count 与清单长度一致");
  check(!mf.body.files.some((f) => f.split("/").some((seg) => seg.startsWith("."))), "web-manifest：点开头的文件（.DS_Store / 编辑器标记）不进清单");

  // 2) 相对资源解析端点：相对路径 → 可取的 /web/... URL
  const rs = await getJson(`/api/editor/web-resolve?item=web-item&path=${encodeURIComponent("css/深 色/style.css")}`);
  check(
    rs.status === 200 && rs.body?.url === "/web/dev/web-item/css/%E6%B7%B1%20%E8%89%B2/style.css",
    `web-resolve：中文 / 空格逐段编码（${rs.body?.url}）`,
  );
  const got = await fetch(`${host.base}${rs.body.url}`);
  check(got.status === 200 && (await got.text()) === webCss, "web-resolve：解析出的 URL 真能取到该资源（字节与盘上一致）");
  const rsEntry = await getJson("/api/editor/web-resolve?item=web-item&path=index.html");
  check(rsEntry.body?.url === "/web/dev/web-item/index.html", `web-resolve：入口 html 也能解析（${rsEntry.body?.url}）`);
  // raw=1 与默认形态的差别：默认是**渲染形态**（注入 WE shim / 合并属性覆盖值），
  // raw 是**作者原字节**。编辑器另存必须读 raw，否则每存一次就把注入结果写回工程文件。
  const rsRaw = await getJson("/api/editor/web-resolve?item=web-item&path=index.html&raw=1");
  check(rsRaw.body?.url === "/web/dev/web-item/index.html?we-raw=1", `web-resolve：raw=1 返回元字节 URL（${rsRaw.body?.url}）`);
  const previewHtml = await (await fetch(`${host.base}${rsEntry.body.url}`)).text();
  const rawHtml = await (await fetch(`${host.base}${rsRaw.body.url}`)).text();
  check(
    previewHtml.includes("data-we-shim") && previewHtml.length > rawHtml.length,
    "web-resolve：默认 URL 是渲染形态（注入 WE shim —— 网页壁纸靠同源 shim 才跑得起来）",
  );
  check(rawHtml === webEntryHtml, "web-resolve：raw URL 是作者写的原字节（未被 shim 注入）");
  const rawProject = await (await fetch(`${host.base}/web/dev/web-item/project.json?we-raw=1`)).text();
  check(!rawProject.includes("userOverridden"), "web-resolve：raw 读 project.json 不合并用户属性覆盖值（不把覆盖值烤回作者文件）");

  // 3) 错误路径：一律明确的 JSON 文案，不静默失败
  const miss = await getJson("/api/editor/web-resolve?item=web-item&path=nope.js");
  check(miss.status === 404 && /相对资源不存在/.test(miss.body?.error ?? ""), `web-resolve：不存在的相对路径 404 + 明确文案（${miss.body?.error}）`);
  const escape = await getJson(`/api/editor/web-resolve?item=web-item&path=${encodeURIComponent("../project.json")}`);
  check(escape.status === 400 && /非法相对路径/.test(escape.body?.error ?? ""), `web-resolve：\`..\` 越界被拒（${escape.body?.error}）`);
  const dir = await getJson("/api/editor/web-resolve?item=web-item&path=js");
  check(dir.status === 400 && /相对资源是目录/.test(dir.body?.error ?? ""), `web-resolve：指向目录被拒（${dir.body?.error}）`);
  const notWeb = await getJson("/api/editor/web-manifest?item=author-item");
  check(notWeb.status === 409 && /目标不是网页壁纸工程/.test(notWeb.body?.error ?? ""), `web-manifest：非网页条目 409 + 明确文案（${notWeb.body?.error}）`);
  check((await getJson("/api/editor/web-manifest?item=../evil")).status === 400, "web-manifest：非法 itemId 被拒（400）");
  check((await getJson("/api/editor/web-manifest?item=web-missing")).status === 404, "web-manifest：条目不存在 404");
  check((await fetch(`${host.base}/api/editor/web-manifest?item=web-item`, { method: "POST" })).status === 405, "web-manifest：只收 GET（405）");

  // 4) 编辑器侧：打开不改型 → 保存不改型 → 重开逐字段一致
  const realFetchWeb = globalThis.fetch;
  globalThis.fetch = (url, init) => realFetchWeb(String(url).startsWith("/") ? `${host.base}${url}` : url, init);
  try {
    const lib = await openMod.fetchLibrary();
    const it = lib.items.find((i) => i.itemId === "web-item");
    check(!!it && openMod.libraryKind(it) === "web" && it.type === "web", `库把网页工程列为 web（type=${it?.type}）`);
    check(it?.file === "index.html" && it?.preview === "preview.gif", "库条目保留声明的入口与作者自带封面");

    const opened = await openMod.openLibraryItem(it, `${host.base}/media/dev`, `${host.base}/web/dev`);
    check(opened.doc.type === "web" && opened.doc.scene === null, "打开网页工程：文档 type = web（不改型），无场景文档");
    check(opened.doc.project?.type === "Web", "打开网页工程：project 原样保留作者的 type 写法（Web）");
    check(opened.assets.entry === "index.html", "打开网页工程：资源读取器入口 = 清单入口");
    check(
      json(opened.assets.list()) === json(["css/深 色/style.css", "js/app.js", "preview.gif", "project.json"]),
      `打开网页工程：文件清单一个不丢（${json(opened.assets.list())}）`,
    );
    check(dec.decode(await opened.assets.read("js/app.js")) === webAppJs, "打开网页工程：相对路径取到原字节");
    check(dec.decode(await opened.assets.read("css/深 色/style.css")) === webCss, "打开网页工程：中文 / 空格路径的资源也能取到");
    check(dec.decode(await opened.assets.read("index.html")) === webEntryHtml, "打开网页工程：入口 html 读到作者原字节（raw，未被 shim 注入）");
    const entryUrl = (await opened.source.webEntry())?.url;
    check(entryUrl === "/web/dev/web-item/index.html", `打开网页工程：入口 URL 走宿主解析（${entryUrl}）`);
    check(!String(entryUrl).includes("we-raw"), "打开网页工程：预览入口 URL 是注入形态（raw 只给另存读字节用）");
    let msg = "";
    try {
      await opened.assets.read("nope.js");
    } catch (e) {
      msg = e.message;
    }
    check(/相对资源不存在/.test(msg), `打开网页工程：读不到的相对资源明确报错，不静默返回空（${msg}）`);

    const files = await saveMod.collectWebProject(opened.doc, opened.assets, null);
    const byPath = new Map(files.map((f) => [f.path, f]));
    check(files.length === 5 && byPath.has("project.json"), `保存网页工程：清单 = 全部资源 + project.json（${files.length} 个）`);
    check(dec.decode(byPath.get("index.html")?.data) === webEntryHtml, "保存网页工程：入口 html 原样写回字节");
    check(byPath.get("index.html").data[0] === 0x3c, "保存网页工程：入口首字节是 `<`（html），不是被 JSON 序列化的 `{`");
    const pj = JSON.parse(dec.decode(byPath.get("project.json").data));
    check(pj.type === "Web", `保存网页工程：project.json 的 type 仍是作者写的 Web（不强制 scene，实得 ${pj.type}）`);
    check(pj.file === "index.html" && pj.title === "Web Fixture", "保存网页工程：入口声明与标题保留");
    check(pj.preview === "preview.gif", "保存网页工程：作者自带封面引用保留（编辑器不为 web 出图，也不删）");
    check(pj.general?.properties?.speed === 1, "保存网页工程：project.json 的其余字段原样保留");

    // 存进壁纸库再列一次：库仍把它认成 web（保存不改型的宿主侧证据）
    const itemId = saveMod.newLibraryItemId("Web Fixture");
    await saveMod.saveToLibrary(itemId, files);
    const disk = fs
      .readdirSync(path.join(hostLib, itemId), { recursive: true })
      .filter((n) => !fs.statSync(path.join(hostLib, itemId, n)).isDirectory());
    check(disk.length === files.length + 1, `落盘：保存清单 + 编辑器标记（${disk.length} 个）`);
    check(fs.readFileSync(path.join(hostLib, itemId, "index.html"), "utf8") === webEntryHtml, "落盘：入口 html 逐字节一致");

    const lib2 = await openMod.fetchLibrary();
    const it2 = lib2.items.find((i) => i.itemId === itemId);
    check(!!it2 && openMod.libraryKind(it2) === "web", `库把保存产物仍列为 web（type=${it2?.type}）`);
    const reopened = await openMod.openLibraryItem(it2, `${host.base}/media/dev`, `${host.base}/web/dev`);
    check(reopened.doc.type === "web" && reopened.doc.type === opened.doc.type, "重开：type 不变（web）");
    check(json(reopened.doc.project) === json(opened.doc.project), "重开：project.json 逐字段一致");
    check(json(reopened.assets.list()) === json(opened.assets.list()), "重开：文件清单一致");
    check(dec.decode(await reopened.assets.read("index.html")) === webEntryHtml, "重开：入口 html 字节一致");
    check(dec.decode(await reopened.assets.read("css/深 色/style.css")) === webCss, "重开：中文 / 空格路径资源字节一致");
    check((await reopened.source.webEntry())?.url === `/web/dev/${itemId}/index.html`, "重开：入口 URL 指向新条目");
  } finally {
    globalThis.fetch = realFetchWeb;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// M. 新建模板 / 图片成层
// ───────────────────────────────────────────────────────────────────────────
section("M. 新建模板 / 图片成层 create.ts");
const createMod = await loadEditorModule("create");
const assetsMod = await loadEditorModule("assets");
const draftMod = await loadEditorModule("draft");
const vec = (s) => String(s).trim().split(/\s+/).map(Number);
{
  const c = createMod;
  check(json(c.RESOLUTIONS.map((r) => `${r.w}x${r.h}`)) === json(["1920x1080", "2560x1440", "3840x2160", "1080x1920"]), "分辨率预设：1080p / 1440p / 4K / 竖屏");
  const rgb = c.hexToRgb("#ff8000");
  check(rgb[0] === 1 && near(rgb[1], 128 / 255) && rgb[2] === 0 && json(c.hexToRgb("nope")) === json([0.5, 0.5, 0.5]), "hexToRgb：#rrggbb → 0..1，非法值回中灰");
  const s = c.blankScene(2560, 1440, [0.1, 0.2, 0.3]);
  check(s.general.orthogonalprojection.width === 2560 && s.general.orthogonalprojection.height === 1440, "空白场景：正交投影 = 所选分辨率");
  check(s.general.clearcolor === "0.100 0.200 0.300" && Array.isArray(s.objects) && s.objects.length === 0, "空白场景：背景色写进 clearcolor，objects 为空");
  check(s.camera?.eye === "0.000 0.000 0.000" && s.camera.center === "0.000 0.000 -1.000" && s.general.bloom === false, "空白场景：2D 相机与 general 同 WE 新建场景形状");
  const d = c.newDocument("新的", 1920, 1080, [0, 0, 0]);
  check(d.type === "scene" && d.form === "loose" && d.objectCount === 0 && d.project.file === "scene.json" && d.project.title === "新的", "newDocument：场景 / 松散形态 / 0 个对象 / project 指向 scene.json");

  check(c.layerNameOf("dir/My Photo.final.PNG") === "My Photo.final" && c.layerNameOf(".png") === "image", "图层名 = 文件名去扩展名");
  const none = () => false;
  check(c.imageSlug("My Photo!.png", none) === "my-photo", "slug：只留 ASCII 字母数字与 - _");
  check(c.imageSlug("海边 照片.jpg", none) === "image", "slug：全非 ASCII 退成 image");
  const taken = new Set(["my-photo", "my-photo-2"]);
  check(c.imageSlug("my photo.png", (x) => taken.has(x)) === "my-photo-3", "slug：重名依次加 -2 / -3");

  const img = { name: "Red.png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2]), ext: "png", width: 3840, height: 2160 };
  const files = c.imageLayerFiles("red", img);
  check(json(files.map((f) => f.name)) === json(["models/editor/red.json", "materials/editor/red.json", "materials/editor/red.png"]), "图片成层：模型 / 材质 / 源图三个文件");
  const model = JSON.parse(dec.decode(files[0].data));
  const mat = JSON.parse(dec.decode(files[1].data));
  check(model.material === "materials/editor/red.json" && model.width === 3840 && model.height === 2160, "模型 json：指向材质并带图片尺寸");
  const pass = mat.passes?.[0];
  check(pass?.shader === "genericimage2" && json(pass.textures) === json(["editor/red"]) && pass.blending === "translucent" && pass.depthtest === "disabled", "材质 json：内置 genericimage2、贴图名 = editor/<slug>（引擎回退读 materials/editor/<slug>.png）");
  check(files[2].data === img.bytes, "源图字节原样保留");

  const id1 = c.addImageLayer(d, "red", img, "fit");
  const o1 = d.scene.objects[0];
  check(id1 === 1 && o1.image === "models/editor/red.json" && o1.name === "Red", "addImageLayer：新 id、引用模型、图层名");
  check(json(vec(o1.origin)) === json([960, 540, 0]) && near(vec(o1.scale)[0], 0.4, 1e-3), `fit：放在场景中心，整图缩进 80%（scale ${o1.scale}）`);
  c.addImageLayer(d, "small", { name: "s.png", width: 100, height: 50 }, "fit");
  check(vec(d.scene.objects[1].scale)[0] === 1, "fit：小图不放大");
  const id3 = c.addImageLayer(d, "sq", { name: "sq.png", width: 1000, height: 1000 }, "cover");
  check(id3 === 3 && near(vec(d.scene.objects[2].scale)[0], 1.92, 1e-3), "cover：铺满场景（取较大比例）");
  check(d.objectCount === 3 && d.roots.map((n) => n.kind).join() === "image,image,image" && d.roots[2].id === 3, "追加在对象数组末尾（绘制在最上），图层树随之重建");
  const fx = freshDoc();
  check(c.addImageLayer(fx, "x", img, "fit") === 13, "已有场景：新 id = 最大数值 id + 1（与复制图层同一规则）");
  check(c.addImageLayer(docMod.makeDoc("n", null, null, null), "x", img, "fit") === null, "没有场景文档时拒绝");
  const refs = c.referencedModels(freshDoc());
  check(refs.has("models/bg.json") && refs.has("models/a.json") && refs.has("models/m.mdl") && !refs.has("particles/p.json"), "referencedModels：收集 image / model 引用");
  check(c.isImageFile({ name: "a.webp" }) && c.isImageFile({ name: "x", type: "image/png" }) && !c.isImageFile({ name: "scene.pkg" }), "isImageFile：按 MIME 或扩展名");
}

// ───────────────────────────────────────────────────────────────────────────
// N. 资源表叠加层
// ───────────────────────────────────────────────────────────────────────────
section("N. 资源表叠加层 assets.ts");
{
  const base = memAssets("scene.json", { "scene.json": enc.encode("{}"), "models/a.json": enc.encode("base"), "materials/a.tex": new Uint8Array([1]) });
  const refs = new Set(["models/editor/k.json"]);
  const ov = assetsMod.overlayAssets("scene.json", base, () => refs);
  ov.put("models/a.json", enc.encode("over"));
  ov.put("models/editor/k.json", enc.encode("k"), "models/editor/k.json");
  ov.put("materials/editor/k.png", new Uint8Array([7]), "models/editor/k.json");
  ov.put("models/editor/gone.json", enc.encode("g"), "models/editor/gone.json");
  check(dec.decode(await ov.read("models/a.json")) === "over" && (await ov.read("materials/a.tex"))[0] === 1, "读取：叠加层优先，未命中落到原始来源");
  check(await ov.read("nope") === null && ov.entry === "scene.json", "都没有时返回 null；入口名沿用");
  const l = ov.list().sort();
  check(json(l) === json(["materials/a.tex", "materials/editor/k.png", "models/a.json", "models/editor/k.json"]), `保存清单：原始 ∪ 叠加层（被引用的组），不含入口、不含已无引用的组（实得 ${json(l)}）`);
  refs.delete("models/editor/k.json");
  check(!ov.list().some((n) => n.includes("editor/k")), "撤销 / 删除图片层后，那组文件不再进保存清单");
  refs.add("models/editor/k.json");
  check(ov.list().includes("materials/editor/k.png"), "重做后又回到保存清单（文件一直留在叠加层）");
  check(ov.added().length === 4 && ov.has("models/editor/gone.json"), "added()：叠加层全部文件（草稿快照用，不按引用过滤）");
  const bare = assetsMod.overlayAssets("scene.json", null, () => new Set());
  bare.put("a.txt", enc.encode("a"));
  check(json(bare.list()) === json(["a.txt"]) && (await bare.read("b")) === null, "没有原始来源（新建工程）：只有叠加层");
}

// ───────────────────────────────────────────────────────────────────────────
// O. 草稿
// ───────────────────────────────────────────────────────────────────────────
section("O. 草稿 draft.ts");
{
  const doc = freshDoc();
  const files = [{ name: "materials/editor/k.png", group: "models/editor/k.json", data: new Uint8Array([1, 2, 3]) }];
  const dr = draftMod.makeDraft(doc, { kind: "library", itemId: "beach" }, "scene.json", files, 1234);
  check(dr.v === 1 && dr.savedAt === 1234 && dr.title === "Fixture" && dr.origin.itemId === "beach" && dr.entry === "scene.json", "makeDraft：版本 / 时间 / 标题 / 来源 / 入口");
  doc.scene.objects[0].name = "changed";
  files[0].data[0] = 99;
  check(dr.scene.objects[0].name === "bg" && dr.files[0].data[0] === 1, "makeDraft：深拷贝（之后改文档 / 文件不影响快照）");
  check(draftMod.makeDraft(docMod.makeDoc("n", null, null, null), { kind: "new" }, "scene.json", []) === null, "没有场景文档不做草稿");
  const viaIdb = structuredClone(dr);
  check(draftMod.parseDraft(viaIdb) !== null && viaIdb.files[0].data instanceof Uint8Array, "结构化克隆（IndexedDB 存取同口径）后仍可解析，字节保持 Uint8Array");
  const bad = [
    { ...dr, v: 2 },
    { ...dr, origin: { kind: "library" } },
    { ...dr, origin: { kind: "local" } },
    { ...dr, scene: null },
    { ...dr, files: [{ name: "x", data: [1, 2] }] },
    { ...dr, files: [{ name: "x", data: new Uint8Array(1), group: 3 }] },
    null,
    "draft",
  ];
  check(bad.every((b) => draftMod.parseDraft(b) === null), "parseDraft：版本不对 / 来源缺 itemId / 未知来源 / 无场景 / 字节不是 Uint8Array / group 非字符串一律拒");
  const target = docMod.makeDoc("old", null, { objects: [] }, "loose");
  draftMod.applyDraft(target, dr);
  check(target.title === "Fixture" && target.objectCount === dr.scene.objects.length && target.roots.length > 0, "applyDraft：标题 / 场景写回并重建图层树");
  target.scene.objects[0].name = "mut";
  check(dr.scene.objects[0].name === "bg", "applyDraft：文档拿到的是副本（编辑不回写草稿）");
}

// ───────────────────────────────────────────────────────────────────────────
// P. 新建闭环：空白模板 → 加图片层 → 撤销一张 → 存进库 → 重新打开
// ───────────────────────────────────────────────────────────────────────────
section("P. 新建闭环（模板 → 图片层 → 保存 → 重新打开）");
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => realFetch(String(url).startsWith("/") ? `${host.base}${url}` : url, init);
  try {
    const doc = createMod.newDocument("新建测试", 1920, 1080, [0.2, 0.3, 0.4]);
    const empty = { entry: "scene.json", read: async () => null, list: () => [] };
    const ov = assetsMod.overlayAssets("scene.json", empty, () => createMod.referencedModels(doc));
    const place = (slug, img, mode) => {
      for (const f of createMod.imageLayerFiles(slug, img)) ov.put(f.name, f.data, createMod.modelPathOf(slug));
      return createMod.addImageLayer(doc, slug, img, mode);
    };
    const bgBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 5, 6, 7]);
    const fgBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9]);
    place("bg", { name: "bg.jpg", bytes: bgBytes, ext: "jpg", width: 1920, height: 1080 }, "cover");
    const fg = place("logo", { name: "logo.png", bytes: fgBytes, ext: "png", width: 400, height: 200 }, "fit");
    place("oops", { name: "oops.png", bytes: new Uint8Array([1]), ext: "png", width: 10, height: 10 }, "fit");
    docMod.removeLayer(doc, 3);
    const files = await saveMod.collectProject(doc, ov, null);
    const names = files.map((f) => f.path).sort();
    check(json(names) === json(["materials/editor/bg.jpg", "materials/editor/bg.json", "materials/editor/logo.json", "materials/editor/logo.png", "models/editor/bg.json", "models/editor/logo.json", "project.json", "scene.json"]), `保存清单：两张图各三件 + 入口 + 工程，删掉的那张不带（实得 ${names.length} 个）`);
    const itemId = saveMod.newLibraryItemId(doc.title);
    await saveMod.saveToLibrary(itemId, files);
    const lib = await openMod.fetchLibrary();
    const it = lib?.items.find((i) => i.itemId === itemId);
    check(!!it && it.hasLooseScene && it.title === "新建测试" && openMod.libraryKind(it) === "scene", "库列出新建产物（松散场景、标题保留）");
    const reopened = await openMod.openLibraryItem(it, `${host.base}/media/dev`, `${host.base}/web/dev`);
    check(json(reopened.doc.scene) === json(doc.scene), "重新打开：scene.json 与新建文档逐字段一致");
    check(reopened.doc.scene.general.clearcolor === "0.200 0.300 0.400" && reopened.doc.objectCount === 2, "重新打开：背景色与两个图片层都在");
    const png = await reopened.assets.read("materials/editor/logo.png");
    const jpg = await reopened.assets.read("materials/editor/bg.jpg");
    check(Buffer.compare(Buffer.from(png), Buffer.from(fgBytes)) === 0 && Buffer.compare(Buffer.from(jpg), Buffer.from(bgBytes)) === 0, "重新打开：源图字节一致");
    const m = JSON.parse(dec.decode(await reopened.assets.read("models/editor/logo.json")));
    check(m.material === "materials/editor/logo.json" && m.width === 400, "重新打开：模型 json 可解析并指向材质");
    const proj = JSON.parse(fs.readFileSync(path.join(hostLib, itemId, "project.json"), "utf8"));
    check(proj.type === "scene" && proj.file === "scene.json" && proj.title === "新建测试", "project.json：场景类型、入口、标题");
    check(fg === 2, "图片层 id 连续分配");
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// S. 效果库基础集 effects.ts
// ───────────────────────────────────────────────────────────────────────────
section("S. 效果库 effects.ts");
const fxMod = await loadEditorModule("effects");
const uniformNotes = (frag) => {
  const out = new Map();
  for (const m of frag.matchAll(/^uniform\s+(float|vec3)\s+(\w+);\s*\/\/\s*(\{.*\})\s*$/gm)) out.set(m[2], { type: m[1], note: JSON.parse(m[3]) });
  return out;
};
{
  const f = fxMod;
  check(json(f.EFFECTS.map((e) => e.id).slice(0, 7)) === json(["tint", "adjust", "vignette", "blur", "wave", "scroll", "pulse"]), "基础集 7 个：颜色叠加 / 色彩调整 / 暗角 / 模糊 / 波浪 / 滚动 / 呼吸");
  check(json(f.EFFECTS.map((e) => e.id).slice(7, 13)) === json(["outline", "glow", "chroma", "pixelate", "shine", "fade"]), "扩充集 6 个：描边 / 外发光 / 色差 / 像素化 / 扫光 / 渐隐遮罩");
  {
    const cl = f.effectById("cuiliuti").frag;
    check(!!f.effectById("cuiliuti") && /smin\(|numBlobs 120|int\(g_FxBlobs\)/.test(cl), "追加：磁流体（cuiliuti）—— smin 软融合、球数滑杆上限 120 与循环封顶一致");
    check(/g_TexelSize\.y \/ g_TexelSize\.x/.test(cl), "磁流体按渲染目标宽高比修正 uv.x（方形层满幅、宽层流体不变形）");
  }
  {
    const cu = f.effectById("cuiliuti");
    check(cu.author === "Hope麻匪（HopeMafei）", "磁流体的原作者署名写在 EffectDef.author 上（检出：Hope麻匪 / HopeMafei）");
    check(/Hope麻匪/.test(f.effectNote(cu, "zh")) && /HopeMafei/.test(f.effectNote(cu, "en")) && /0ran/.test(f.effectNote(cu, "en")), "署名说明中英双语：原作者 Hope麻匪 / HopeMafei 与出处（0ran 收录）都在文案里");
    check(f.effectNote(cu, "zh-CN") === f.effectNote(cu, "zh") && f.effectNote(cu, "en-US") === f.effectNote(cu, "en"), "effectNote 按主语言取名（zh-CN / en-US 与 zh / en 同文案）");
    const fxFiles = f.effectFiles(cu, "zh");
    const ej = JSON.parse(dec.decode(fxFiles.find((x) => x.name.endsWith("effect.json")).data));
    check(/Hope麻匪/.test(ej.description ?? "") && /HopeMafei/.test(ej.description ?? ""), "写进工程的 effect.json 带着署名说明（作者与出处随工程自包含）");
    const en = JSON.parse(dec.decode(f.effectFiles(cu, "en").find((x) => x.name.endsWith("effect.json")).data));
    check(/Original author/.test(en.description ?? "") && /HopeMafei/.test(en.description ?? ""), "英文界面下 effect.json 写英文署名；author 与 note 同源");
    const plain = { id: "noteplain", params: [], frag: "void main(){}", author: "A", note: "N" };
    check(
      JSON.parse(dec.decode(f.effectFiles(plain, "zh").find((x) => x.name.endsWith("effect.json")).data)).description === "N\n作者 / Author：A",
      "单字符串 note 直用；description 末尾补 Author 行（无 note 的效果不写 description——verify 下面 tint 那条守着）",
    );
  }
  check(f.EFFECTS.filter((e) => /g_Texture0Resolution\b/.test(e.frag)).every((e) => /uniform vec4 g_Texture0Resolution;/.test(e.frag)) && ["outline", "glow", "pixelate"].every((id) => /g_Texture0Resolution\.xy/.test(f.effectById(id).frag)), "按像素取样的效果（描边 / 发光 / 像素化 / 模糊）都声明并使用源贴图尺寸");
  {
    const ol = f.effectById("outline").frag;
    const gl = f.effectById("glow").frag;
    const fd = f.effectById("fade").frag;
    check(/mix\(g_FxColor, c\.rgb, c\.a\), max\(c\.a, a\)\)/.test(ol) && /mix\(g_FxColor, c\.rgb, c\.a\), max\(c\.a, a\)\)/.test(gl), "描边 / 发光画在原图后面：rgb 按原 alpha 混色，alpha 取 max（不盖住原图）");
    check(/i < 16/.test(ol) && /i <= 3/.test(gl) && /exp\(/.test(gl), "描边 16 方向取最大 alpha；发光 7×7 高斯");
    check(/floor\(v_TexCoord \/ cell\) \+ vec2\(0\.5, 0\.5\)/.test(f.effectById("pixelate").frag), "像素化取格子中心（不是左上角，避免整体偏移半格）");
    check(/r\.r, c\.g, b\.b/.test(f.effectById("chroma").frag), "色差：R 正偏、G 居中、B 反偏");
    check(/g_FxStart <= g_FxEnd \? m : 1\.0 - m/.test(fd) && /min\(g_FxStart, g_FxEnd\)/.test(fd), "渐隐遮罩起点 > 终点时反向（smoothstep 不吃倒序区间）");
    check(/fract\(g_Time \* g_FxSpeed\)/.test(f.effectById("shine").frag), "扫光按 g_Time 循环");
  }
  check(new Set(f.EFFECTS.map((e) => e.id)).size === f.EFFECTS.length && f.EFFECTS.every((e) => /^[a-z0-9]+$/.test(e.id)), "id 唯一且只含小写字母数字（effectIdOf 的正则能认回）");
  let annotOk = true;
  const annotBad = [];
  for (const e of f.EFFECTS) {
    const notes = uniformNotes(e.frag);
    for (const p of e.params) {
      const u = notes.get(f.uniformName(p.key));
      const want = p.type === "color" ? "vec3" : "float";
      const def = typeof p.default === "number" ? p.default : p.default.join(" ");
      const got = u?.note.default;
      const defOk = typeof p.default === "number" ? near(got, p.default, 1e-4) : json(String(got).split(" ").map(Number)) === json([...p.default]);
      if (!u || u.type !== want || u.note.material !== p.key || !defOk || (p.type === "color" && u.note.type !== "color")) {
        annotOk = false;
        annotBad.push(`${e.id}.${p.key}(${def})`);
      }
      if (p.type === "float" && !(p.min <= p.default && p.default <= p.max && p.step > 0)) {
        annotOk = false;
        annotBad.push(`${e.id}.${p.key} 范围`);
      }
    }
    if (notes.size !== e.params.length) {
      annotOk = false;
      annotBad.push(`${e.id} 多出 uniform 注释`);
    }
    if (!/gl_FragColor\s*=/.test(e.frag) || !/g_Texture0;\s*\/\/ \{"hidden":true\}/.test(e.frag)) {
      annotOk = false;
      annotBad.push(`${e.id} 缺输出 / 源贴图`);
    }
  }
  check(annotOk, `每个参数都有同名 uniform：类型对、material = 参数名、default 与面板一致、颜色标 type（${annotBad.join(", ") || "ok"}）`);
  check(f.EFFECTS.filter((e) => /g_Time\b/.test(e.frag)).every((e) => /uniform float g_Time;/.test(e.frag)) && /uniform vec4 g_Texture0Resolution;/.test(f.effectById("blur").frag), "用到 g_Time / g_Texture0Resolution 的都声明了（引擎按名绑定）");

  const tint = f.effectById("tint");
  const files = f.effectFiles(tint);
  check(json(files.map((x) => x.name)) === json(["effects/wwgl_tint/effect.json", "materials/effects/wwgl_tint.json", "shaders/effects/wwgl_tint.frag", "shaders/effects/wwgl_tint.vert"]), "写进工程的四件：effect.json / 材质 / frag / vert（wwgl_ 前缀）");
  const ej = JSON.parse(dec.decode(files[0].data));
  const mj = JSON.parse(dec.decode(files[1].data));
  check(ej.passes?.[0]?.material === files[1].name && json(ej.dependencies) === json(files.slice(1).map((x) => x.name)), "effect.json：pass 指向材质，dependencies 列全另外三件");
  check(mj.passes?.[0]?.shader === "effects/wwgl_tint" && mj.passes[0].depthtest === "disabled", "材质：shader = effects/wwgl_tint（引擎补 shaders/ 与 .frag/.vert）");
  check(dec.decode(files[2].data) === tint.frag && /g_ModelViewProjectionMatrix/.test(dec.decode(files[3].data)), "frag 即定义里的源码；vert 是通用全层顶点着色器");
  check(f.effectFileOf("blur") === "effects/wwgl_blur/effect.json" && f.effectIdOf("effects/wwgl_blur/effect.json") === "blur", "effectFileOf / effectIdOf 互逆");
  // M6 改契约：库内 / WE 官方目录名一律还原成目录名本身（不再是 null），
  // 未登记的 `wwgl_` 前缀（插件被禁用 / 效果已删）与非法路径仍然 null。
  check(
    f.effectIdOf("effects/waterripple/effect.json") === "waterripple" &&
      f.effectIdOf("effects/godrays/effect.json") === "godrays" &&
      f.effectIdOf("effects/wwgl_nope/effect.json") === null &&
      f.effectIdOf("effects/Tint/effect.json") === null &&
      f.effectIdOf("effects/tint/effect.js") === null &&
      f.effectIdOf(3) === null,
    "库内 / 官方目录名 → 目录名本身（M6）；未登记 wwgl_ 前缀 / 非法路径 / 非字符串 → null",
  );

  const amount = tint.params[1];
  const color = tint.params[0];
  check(f.encodeValue(amount, 2) === 1 && f.encodeValue(amount, -1) === 0 && f.encodeValue(amount, 0.123456) === 0.1235, "标量：按范围夹住、保留 4 位");
  check(f.encodeValue(color, [1, 0.5, 2]) === "1 0.5 1" && f.encodeValue(color, 0.25) === "0.25 0.25 0.25", "颜色：写成 \"r g b\" 字符串（与 WE 同），分量夹到 0..1");
  check(json(f.decodeValue(color, "0.1 0.2 0.3")) === json([0.1, 0.2, 0.3]) && json(f.decodeValue(color, { user: "c", value: "1 0 0" })) === json([1, 0, 0]) && json(f.decodeValue(color, "bad")) === json([1, 0.45, 0.2]), "颜色解码：字符串 / {user,value} 包装 / 非法回缺省");
  check(f.decodeValue(amount, "0.7") === 0.7 && f.decodeValue(amount, { script: "x", value: 0.3 }) === 0.3 && f.decodeValue(amount, undefined) === 0.5, "标量解码：数字串 / {script,value} 包装 / 缺失回缺省");

  const o = { id: 1, image: "models/x.json" };
  check(f.addEffect(o, "nope") === null && o.effects === undefined, "未知效果拒绝，不留空数组");
  check(f.addEffect(o, "tint") === 0 && f.addEffect(o, "vignette") === 1, "addEffect：追加到效果链末尾，返回序号");
  check(json(o.effects[0]) === json({ file: "effects/wwgl_tint/effect.json", name: "tint", visible: true, passes: [{ constantshadervalues: { color: "1 0.45 0.2", amount: 0.5 } }] }), "新效果条目：file / name / visible / 缺省常量（scene.json 形状）");
  check(f.setEffectParam(o, 0, "amount", 0.9) && o.effects[0].passes[0].constantshadervalues.amount === 0.9, "setEffectParam：直接值");
  o.effects[0].passes[0].constantshadervalues.color = { user: "fxcolor", value: "1 1 1" };
  check(f.setEffectParam(o, 0, "color", [0, 1, 0]) && json(o.effects[0].passes[0].constantshadervalues.color) === json({ user: "fxcolor", value: "0 1 0" }), "setEffectParam：{user,value} 包装只改 value，绑定保留");
  check(!f.setEffectParam(o, 0, "nope", 1) && !f.setEffectParam(o, 9, "amount", 1), "未知参数 / 越界序号拒绝");
  o.effects.push({ file: "effects/waterripple/effect.json", visible: { user: "rip", value: false }, passes: [{ constantshadervalues: { speed: 2 } }] });
  check(!f.setEffectParam(o, 2, "speed", 1), "非本库效果不改参数");
  const v = f.effectViews(o);
  check(v.length === 3 && v[0].def?.id === "tint" && json(v[0].values.color) === json([0, 1, 0]) && v[0].values.amount === 0.9, "effectViews：本库效果解出参数值（含包装）");
  check(v[2].def === null && v[2].name === "waterripple" && v[2].visible === false && json(v[2].values) === "{}", "effectViews：外部效果只给名字 / 开关，名字取目录名");
  check(f.setEffectVisible(o, 2, true) && json(o.effects[2].visible) === json({ user: "rip", value: true }), "setEffectVisible：包装只改 value");
  check(f.setEffectVisible(o, 0, false) && o.effects[0].visible === false && !f.isEffectVisible(o.effects[0]) && f.isEffectVisible({}) && !f.isEffectVisible({ visible: "0" }), "开关：直接值 / 缺省为开 / \"0\" 为关");
  check(f.moveEffect(o, 0, 1) && o.effects[1].name === "tint" && !f.moveEffect(o, 0, -1) && !f.moveEffect(o, 2, 1), "moveEffect：与相邻交换，首尾越界拒绝");
  check(f.removeEffect(o, 2) && f.removeEffect(o, 0) && o.effects.length === 1 && f.removeEffect(o, 0) && !("effects" in o) && !f.removeEffect(o, 0), "removeEffect：删空后去掉 effects 字段（与没加过一致）");

  const d = freshDoc();
  f.addEffect(d.scene.objects[0], "blur");
  f.addEffect(d.scene.objects[1], "tint");
  d.scene.objects[1].effects.push({ file: "effects/shake/effect.json" });
  check(json([...f.referencedEffects(d)].sort()) === json(["effects/shake/effect.json", "effects/wwgl_blur/effect.json", "effects/wwgl_tint/effect.json"]) && f.referencedEffects(null).size === 0, "referencedEffects：收集全部图层的效果文件");
}

section("S2. 效果 shader 真编译（hlsl2glsl → glslang，无需修复）");
if (spawnSync("glslangValidator", ["--version"]).status !== 0) {
  console.log("  （跳过：未找到 glslangValidator）");
} else {
  const { hlsl2glsl } = await imp("renderer/vendor/we-scene/render/hlsl2glsl.js");
  const { WE_SHADER_HEADERS } = await imp("renderer/vendor/we-scene/headers.ts");
  const { parseInfoLog } = await imp("renderer/vendor/we-scene/render/glsl-repair.js");
  const GL_HEAD = "#version 300 es\nprecision highp float;\nprecision highp int;\n";
  const glDir = fs.mkdtempSync(path.join(tmpRoot, "glsl-"));
  const glc = (stage, src) => {
    const file = path.join(glDir, `s.${stage}`);
    fs.writeFileSync(file, src);
    const r = spawnSync("glslangValidator", [file], { encoding: "utf8" });
    return r.status === 0 ? [] : parseInfoLog(String(r.stdout));
  };
  const resolver = (rel) => WE_SHADER_HEADERS[rel.replace(/^shaders\//, "")] ?? null;
  const transpile = (stage, src, sib) => {
    const out = hlsl2glsl(src, stage, {}, resolver, sib);
    return /^\s*#version/.test(out) ? out : GL_HEAD + out;
  };
  for (const e of fxMod.EFFECTS) {
    const [, , fragF, vertF] = fxMod.effectFiles(e);
    const frag = dec.decode(fragF.data);
    const vert = dec.decode(vertF.data);
    const fe = glc("frag", transpile("frag", frag, vert));
    const ve = glc("vert", transpile("vert", vert, frag));
    check(fe.length === 0 && ve.length === 0, `${e.id}：frag / vert 转译后直接编过${fe.length || ve.length ? ` —— ${[...fe, ...ve].map((x) => x.msg).join(" | ")}` : ""}`);
  }
  const broken = glc("frag", transpile("frag", fxMod.effectById("tint").frag.replace("g_FxAmount);", "g_FxAmount;"), ""));
  check(broken.length > 0, "反例：故意写坏的 frag 确实编不过（编译判据是真的）");
}

section("S3. 效果闭环（新建 → 图片层 + 2 个内置效果 → 保存 → 重新打开）");
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => realFetch(String(url).startsWith("/") ? `${host.base}${url}` : url, init);
  try {
    const doc = createMod.newDocument("效果测试", 1920, 1080, [0, 0, 0]);
    const empty = { entry: "scene.json", read: async () => null, list: () => [] };
    const refs = () => new Set([...createMod.referencedModels(doc), ...fxMod.referencedEffects(doc)]);
    const ov = assetsMod.overlayAssets("scene.json", empty, refs);
    const img = { name: "bg.png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1]), ext: "png", width: 1920, height: 1080 };
    for (const x of createMod.imageLayerFiles("bg", img)) ov.put(x.name, x.data, createMod.modelPathOf("bg"));
    const id = createMod.addImageLayer(doc, "bg", img, "cover");
    const obj = doc.scene.objects.find((o) => o.id === id);
    const addFx = (fxId) => {
      for (const x of fxMod.effectFiles(fxMod.effectById(fxId))) ov.put(x.name, x.data, fxMod.effectFileOf(fxId));
      return fxMod.addEffect(obj, fxId);
    };
    addFx("tint");
    addFx("vignette");
    addFx("wave");
    fxMod.removeEffect(obj, 2);
    fxMod.setEffectParam(obj, 0, "color", [0, 1, 0]);
    fxMod.setEffectParam(obj, 0, "amount", 1);
    const files = await saveMod.collectProject(doc, ov, null);
    const names = files.map((x) => x.path);
    const fxNames = names.filter((n) => /wwgl_/.test(n)).sort();
    check(fxNames.length === 8 && fxNames.every((n) => /wwgl_(tint|vignette)/.test(n)), `保存清单：两个效果各四件，删掉的 wave 不带（实得 ${json(fxNames)}）`);
    const itemId = saveMod.newLibraryItemId(doc.title);
    await saveMod.saveToLibrary(itemId, files);
    const lib = await openMod.fetchLibrary();
    const it = lib?.items.find((i) => i.itemId === itemId);
    const reopened = await openMod.openLibraryItem(it, `${host.base}/media/dev`, `${host.base}/web/dev`);
    check(json(reopened.doc.scene) === json(doc.scene), "重新打开：scene.json（含效果链与参数）逐字段一致");
    const v = fxMod.effectViews(reopened.doc.scene.objects[0]);
    check(v.length === 2 && v[0].def?.id === "tint" && json(v[0].values.color) === json([0, 1, 0]) && v[0].values.amount === 1 && v[1].def?.id === "vignette", "重新打开：面板认回两个内置效果与改过的参数");
    const frag = await reopened.assets.read("shaders/effects/wwgl_tint.frag");
    const mat = JSON.parse(dec.decode(await reopened.assets.read("materials/effects/wwgl_vignette.json")));
    check(frag && dec.decode(frag) === fxMod.effectById("tint").frag && mat.passes[0].shader === "effects/wwgl_vignette", "重新打开：shader / 材质原样可读（自包含，不依赖编辑器）");
    for (const x of fxMod.effectFiles(fxMod.effectById("tint"))) await reopened.assets.read(x.name);
    const ov2 = assetsMod.overlayAssets("scene.json", reopened.assets, () => new Set([...createMod.referencedModels(reopened.doc), ...fxMod.referencedEffects(reopened.doc)]));
    const l2 = ov2.list();
    check(fxMod.effectFiles(fxMod.effectById("tint")).every((x) => l2.includes(x.name)), "再次打开（引擎读过效果四件后）文件来自原始来源，照样进保存清单");
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// U. 脚本编辑（W8）：checkSceneScript / scriptErrorLine / editor/scripts.ts
// ───────────────────────────────────────────────────────────────────────────
section("U. 脚本预检 checkSceneScript（库出口）");
const wtextMod = await imp("renderer/vendor/we-scene/render/text.js");
const { checkSceneScript } = await imp("renderer/src/editor/scripts.ts");
const scMod = await loadEditorModule("scripts");
{
  const tpl = "'use strict';\n\nexport function update(value) {\n\treturn value;\n}\n";
  let r = checkSceneScript(tpl);
  check(r.ok && json(r.entries) === json(["update"]) && !r.noEntry && r.line === null, "合法脚本：ok，入口 update");
  r = checkSceneScript("import * as WEMath from 'WEMath';\nexport let scriptProperties = createScriptProperties().addSlider({ name: 's', value: 1 }).finish();\nexport function update(v) { return WEMath.mix(v, 0, scriptProperties.s); }");
  check(r.ok, `官方模板写法（import WEMath / export let scriptProperties 撞形参名）同沙箱 transform 能编过${r.ok ? "" : `：${r.message}`}`);
  r = checkSceneScript("export function update(value) {\n\tlet a = 1;\n\n\treturn a +;\n}\n");
  check(!r.ok && r.line === 4 && /Unexpected token/.test(r.message), `语法错误：定位到第 4 行（实得 ${r.line}：${r.message}）`);
  r = checkSceneScript("let x = 1;\nlet y = 2;\nlet x = 3;\nexport function update(v) { return v; }");
  check(!r.ok && r.line === 3 && /already been declared/.test(r.message), `重复声明：定位到第 3 行（实得 ${r.line}）`);
  r = checkSceneScript("export function update(value) {\n\treturn value;\n");
  check(!r.ok && r.line !== null && r.line >= 1 && r.line <= 2, `缺右括号：报错并给出行（实得 ${r.line}：${r.message}）`);
  r = checkSceneScript("export function update(v) {\n\twith (v) { return x; }\n}");
  check(!r.ok && r.line === 2, "严格模式规则与沙箱一致（with 语句报错，第 2 行）");
  globalThis.__wwglRan = 0;
  r = checkSceneScript("globalThis.__wwglRan = 1;\nthrow new Error('top');\nexport function update(v) { return v; }");
  check(r.ok && globalThis.__wwglRan === 0, "只编译不执行：顶层抛错 / 副作用都不发生");
  delete globalThis.__wwglRan;
  check(json(checkSceneScript("export function cursorClick(e) { thisLayer.visible = false; }").entries) === json(["cursorClick"]), "纯指针回调：入口 cursorClick");
  check(checkSceneScript("let a = 1;").noEntry && !checkSceneScript("let t = engine.runtime;").noEntry, "无入口 → noEntry；读 engine.runtime 的引擎层脚本不算无入口（同闸门）");
  check(json(checkSceneScript("export const init = (v) => v;\nexport async function mediaPlaybackChanged(e) {}").entries) === json(["init", "mediaPlaybackChanged"]), "箭头函数常量 / async 函数也认作入口");
  check(checkSceneScript(42).ok === false, "非字符串拒绝");

  const errs = [];
  const sb = wtextMod.evalObjectScript("let k = 2;\nexport function update(value) {\n\tconst o = null;\n\treturn o.x + k;\n}\n", null, { onError: (e, phase) => errs.push({ line: wtextMod.scriptErrorLine(e), phase }) });
  sb.callUpdate(1);
  check(errs.length === 1 && errs[0].line === 4 && errs[0].phase === "update", `运行期错误行号映射回源码第 4 行（实得 ${json(errs)}）`);
  check(wtextMod.scriptErrorLine(new Error("x")) === null && wtextMod.scriptErrorLine(null) === null, "非沙箱错误 → null");
}

section("U2. 脚本挂点 editor/scripts.ts");
{
  const s = scMod;
  const obj = {
    id: 1,
    origin: { script: "export function update(v){return v;}", value: "1 2 3" },
    alpha: { user: "op", value: 0.5 },
    visible: true,
    effects: [{ file: "effects/x/effect.json", visible: { script: "export function update(v){return v;}", scriptproperties: { a: 1 }, value: true } }],
  };
  const slots = s.scriptSlots(obj);
  check(json(slots.map((x) => x.target)) === json(["origin", "effects[0].visible"]) && slots[0].value === "1 2 3" && slots[1].hasProps, "scriptSlots：对象字段与效果开关，带快照值 / 是否有 scriptproperties");
  check(s.getScript(obj, "origin")?.includes("update") && s.getScript(obj, "alpha") === null && s.getScript(obj, "nope") === null, "getScript：有脚本才返回源码，未知挂点 null");
  check(s.setScript(obj, "visible", "export function update(v){return !v;}") && json(obj.visible) === json({ script: "export function update(v){return !v;}", value: true }), "setScript：裸值就地包装，原值成为快照");
  check(s.setScript(obj, "alpha", "export function update(v){return v;}") && obj.alpha.user === "op" && obj.alpha.value === 0.5 && typeof obj.alpha.script === "string", "setScript：与用户属性绑定共存，绑定与快照保留");
  check(!s.setScript(obj, "origin", obj.origin.script) && !s.setScript(obj, "origin", "  ") && !s.setScript(obj, "bogus", "x"), "相同源码 / 空白源码 / 非法挂点：不算修改");
  check(s.setScript(obj, "effects[0].visible", "export function update(v){return false;}") && obj.effects[0].visible.scriptproperties.a === 1, "效果开关：改源码保留 scriptproperties");
  check(s.removeScript(obj, "origin") && obj.origin === "1 2 3", "removeScript：只剩快照时解包回裸值");
  check(s.removeScript(obj, "alpha") && json(obj.alpha) === json({ user: "op", value: 0.5 }), "removeScript：有用户属性绑定时保留包装");
  check(s.removeScript(obj, "effects[0].visible") && obj.effects[0].visible === true && !s.removeScript(obj, "origin"), "效果开关去脚本解包；没有脚本时返回 false");
  const bare = { id: 2 };
  check(s.setScript(bare, "scale", "export function update(v){return v;}") && bare.scale.value === "1.00000 1.00000 1.00000", "字段缺省时快照取该字段的 WE 缺省值");
  check(s.removeScript(bare, "scale") && bare.scale === "1.00000 1.00000 1.00000", "去脚本后回到缺省快照");
  check(s.addableTargets("text")[0] === "text" && s.addableTargets("image").includes("brightness") && json(s.addableTargets("sound")) === json(["volume"]), "可加脚本的挂点按图层种类给出");
  const bad = [];
  for (const t of ["text", ...s.OBJECT_SCRIPT_FIELDS]) {
    const r = checkSceneScript(s.scriptTemplate(t));
    if (!r.ok || json(r.entries) !== json(["update"])) bad.push(t);
  }
  check(bad.length === 0, `每个挂点的新脚本模板都能编过、入口为 update（失败 ${json(bad)}）`);
}

// ───────────────────────────────────────────────────────────────────────────
// V. 用户属性（W9）：声明 / 值 / 绑定（editor/userprops.ts）+ 引擎接住新声明 + 撤销快照
// ───────────────────────────────────────────────────────────────────────────
section("V. 用户属性 editor/userprops.ts");
const upMod = await loadEditorModule("userprops");
const upEngine = await imp("renderer/vendor/we-scene/scene/user-props.js");
{
  const u = upMod;
  const doc = docMod.makeDoc("x", { type: "scene", title: "x" }, { objects: [{ id: 1, image: "models/a.json", alpha: 0.8 }, { id: 2, text: { value: "hi" } }] }, "loose");
  check(u.listProps(doc).length === 0 && u.propOf(doc, "a") === null, "空文档：无声明");
  check(!u.isValidPropName(doc, "1abc") && !u.isValidPropName(doc, "a-b") && !u.isValidPropName(doc, "") && u.isValidPropName(doc, "_op1"), "属性名必须是标识符（脚本里 engine.userProperties.<名字>）");
  const d1 = u.declareProp(doc, "op", "slider", "透明度");
  check(d1 && json(doc.project.general.properties.op) === json({ type: "slider", text: "透明度", value: 0.5, min: 0, max: 1, step: 0.01, order: 1 }), "declareProp：写进 project.general.properties，slider 默认 0.5 / [0,1] / 0.01");
  check(u.declareProp(doc, "op", "bool") === null && !u.isValidPropName(doc, "op"), "重名拒绝");
  u.declareProp(doc, "mode", "combo");
  u.declareProp(doc, "tint", "color");
  u.declareProp(doc, "show", "bool");
  u.declareProp(doc, "label", "textinput");
  check(json(u.listProps(doc).map((p) => p.name)) === json(["op", "mode", "tint", "show", "label"]), "listProps：按声明顺序（order 递增）");
  const noProj = docMod.makeDoc("y", null, { objects: [] }, "loose");
  check(u.declareProp(noProj, "a", "bool") && noProj.project.general.properties.a.type === "bool", "没有 project.json 的文档也能声明（按需建 general.properties）");

  check(u.setPropValue(doc, "op", 3) && u.propOf(doc, "op").value === 1, "slider 值夹到范围内");
  check(!u.setPropValue(doc, "op", 1) && !u.setPropValue(doc, "op", "abc"), "值没变 / 非数字：不算修改");
  check(u.setPropValue(doc, "tint", [1, 0.5, 2]) && u.propOf(doc, "tint").value === "1 0.5 1", "color 写成 \"r g b\"，分量夹到 [0,1]");
  check(!u.setPropValue(doc, "mode", "7") && u.setPropValue(doc, "mode", 1) && u.propOf(doc, "mode").value === "1", "combo 只接受选项里的值");
  check(u.setPropValue(doc, "show", "false") && u.propOf(doc, "show").value === false && !u.setPropValue(doc, "label", 5), "bool 规整；textinput 只收字符串");
  check(u.setSliderRange(doc, "op", 0, 0.5, 0.1) && u.propOf(doc, "op").value === 0.5, "改范围：当前值随之夹回");
  check(!u.setSliderRange(doc, "op", 1, 0, 0.1) && !u.setSliderRange(doc, "op", 0, 1, 0) && !u.setSliderRange(doc, "mode", 0, 1, 0.1), "非法范围 / 步长 / 非 slider 拒绝");
  const opts = u.parseComboOptions("a=甲\n b = 乙 \n\nc");
  check(json(opts) === json([{ value: "a", label: "甲" }, { value: "b", label: "乙" }, { value: "c", label: "c" }]) && u.formatComboOptions(opts) === "a=甲\nb=乙\nc", "combo 选项文本：每行 值=标签，往返一致");
  check(u.setComboOptions(doc, "mode", opts) && u.propOf(doc, "mode").value === "a", "改选项：当前值不在新选项里时取第一项");
  check(!u.setComboOptions(doc, "mode", [{ value: "a", label: "" }, { value: "a", label: "" }]) && !u.setComboOptions(doc, "mode", []), "重复值 / 空选项拒绝");
  check(u.setPropText(doc, "op", "不透明度") && !u.setPropText(doc, "op", "不透明度"), "改显示名");

  const img = doc.scene.objects[0];
  const txt = doc.scene.objects[1];
  check(json(u.bindableFor("image").map((f) => f.field)) === json(["visible", "alpha", "brightness", "scale", "color"]) && u.bindableFor("text").some((f) => f.field === "text") && !u.bindableFor("group").some((f) => f.field === "color"), "可绑字段按图层种类给出");
  check(u.bindProp(doc, img, "alpha", "op") && json(img.alpha) === json({ user: "op", value: 0.8 }), "bindProp：裸值包成 {user, value}，原值成快照");
  check(!u.bindProp(doc, img, "alpha", "tint") && !u.bindProp(doc, img, "alpha", "nope"), "类型不兼容 / 未声明拒绝");
  check(!u.bindProp(doc, img, "visible", "mode") && !u.bindProp(doc, img, "visible", "mode", "zz") && u.bindProp(doc, img, "visible", "mode", "b"), "combo 只能带合法 condition 绑 visible");
  check(json(img.visible) === json({ user: { name: "mode", condition: "b" }, value: true }), "combo 绑定写成 {user:{name,condition}}，快照缺省 true");
  check(json(u.bindingOf(img, "visible")) === json({ name: "mode", condition: "b" }) && u.bindingOf(img, "alpha").name === "op" && u.bindingOf(img, "scale") === null, "bindingOf 读出两种写法");
  img.brightness = { script: "export function update(v){return v;}", value: 1.2 };
  check(u.bindProp(doc, img, "brightness", "op") && img.brightness.script && img.brightness.value === 1.2 && img.brightness.user === "op", "字段上有脚本时绑定与脚本共存");
  check(u.bindProp(doc, txt, "text", "label") && txt.text.user === "label" && txt.text.value === "hi", "文本层：已有 {value} 包装直接挂 user");
  check(u.bindProp(doc, img, "scale", "op") && img.scale.value === "1.00000 1.00000 1.00000", "字段缺省时快照取 WE 缺省值");
  check(u.unbindProp(img, "scale") && img.scale === "1.00000 1.00000 1.00000" && !u.unbindProp(img, "scale"), "unbindProp：只剩快照时解包；没绑定返回 false");
  const n = u.removeProp(doc, "op");
  check(n === 2 && img.alpha === 0.8 && json(img.brightness) === json({ script: "export function update(v){return v;}", value: 1.2 }) && !u.propOf(doc, "op"), `removeProp：删声明并解开所有绑定（解开 ${n} 处），脚本保留`);
  check(u.removeProp(doc, "op") === -1, "删不存在的属性返回 -1");

  // 引擎：新声明随热更进属性表，绑定链看得见
  const scene = { objects: [{ id: 1, alpha: { user: "fresh", value: 1 } }, { id: 2, visible: { user: { name: "m", condition: "1" }, value: true } }] };
  const props = {};
  const live = {};
  const changed = upEngine.mergeUserPropertyValues(props, live, { fresh: { type: "slider", value: 0.25, min: 0, max: 1 }, m: { type: "combo", value: "1", options: [{ label: "A", value: "0" }, { label: "B", value: "1" }] }, misc: { value: 3 } });
  check(props.fresh?.type === "slider" && props.fresh.value === 0.25 && props.fresh.max === 1 && live.fresh === 0.25 && changed.fresh === 0.25, "引擎：未声明 + 带合法 type 的 wire 条目补进属性表");
  check(!("misc" in props) && live.misc === 3, "引擎：不带 type 的未知名字维持旧语义（只给脚本）");
  upEngine.resolveUserProps(scene.objects, props, 0);
  check(scene.objects[0].alpha.value === 0.25 && scene.objects[1].visible.value === true, "引擎：新声明的 slider / combo 驱动绑定（resolveUserProps）");
  upEngine.mergeUserPropertyValues(props, live, { m: { type: "combo", value: "0", options: [{ label: "A", value: "0" }, { label: "B", value: "1" }] } });
  upEngine.resolveUserProps(scene.objects, props, 0);
  check(scene.objects[1].visible.value === false && live.m === 0, "引擎：combo 热改 → 条件绑定的显隐跟着变（整数选项收成 number）");
  const ref = props.fresh;
  upEngine.mergeUserPropertyValues(props, live, { fresh: { type: "slider", value: 2, min: 0, max: 4 } });
  check(props.fresh === ref && ref.max === 4 && ref.value === 2, "引擎：已声明条目就地刷新元数据（引用不换）");
  upEngine.mergeUserPropertyValues(props, live, { fresh: { value: 0.5 } });
  check(ref.type === "slider" && ref.max === 4 && ref.value === 0.5, "引擎：只带 value 的普通热更不动声明");

  // 撤销快照：只改属性表的结构命令也要出命令并能换回
  const hd = docMod.makeDoc("h", { type: "scene" }, { objects: [{ id: 1, image: "models/a.json" }] }, "loose");
  const c1 = historyMod.structCommand(hd, "声明", null, (d) => (u.declareProp(d, "k", "slider") ? null : undefined));
  check(c1 && c1.before === c1.after && c1.propsBefore === "null" && JSON.parse(c1.propsAfter).k.type === "slider", "structCommand：只改属性表也出命令，带前后属性快照");
  const c2 = historyMod.structCommand(hd, "绑定", null, (d) => (u.bindProp(d, d.scene.objects[0], "alpha", "k") ? null : undefined));
  check(c2 && c2.before !== c2.after && c2.propsBefore === undefined, "只改对象数组时不带属性快照");
  historyMod.restoreObjects(hd, c1.before, c1.propsBefore);
  check(!u.propOf(hd, "k") && hd.scene.objects[0].alpha === undefined, "撤销：属性表与对象一并换回");
  historyMod.restoreObjects(hd, c2.after, c1.propsAfter);
  check(u.propOf(hd, "k")?.value === 0.5 && hd.scene.objects[0].alpha.user === "k", "重做：属性表与对象一并换回");
  check(historyMod.propsSnapshot(hd) === json(hd.project.general.properties), "propsSnapshot = general.properties 的 JSON");
}

// ───────────────────────────────────────────────────────────────────────────
// W. 外来脚本策略（W10 过渡）：editor/trust.ts + 引擎 scripts 开关
// ───────────────────────────────────────────────────────────────────────────
section("W. 外来脚本策略 editor/trust.ts");
const trustMod = await loadEditorModule("trust");
{
  const { scriptsAllowedByDefault: allow, scriptsOverrideFrom: ov } = trustMod;
  check(allow("library", true, null) && allow("local", true, null), "dev 宿主在：库条目 / 本地文件照常执行（与测试台一致）");
  check(!allow("library", false, null) && !allow("local", false, null), "在线版（无宿主）：外来内容默认不执行");
  check(allow("new", false, null) && allow("new", true, "off"), "编辑器里新建的工程（含其草稿）永远执行——用户自己的内容");
  check(!allow("local", true, "off") && allow("local", false, "on"), "?scripts=off / on 覆盖宿主判断");
  check(ov("?scripts=off&item=1") === "off" && ov("?scripts=on") === "on" && ov("?scripts=1") === null && ov("") === null, "scriptsOverrideFrom：只认 on / off");
  const sm = fs.readFileSync(path.join(ROOT, "renderer/src/scene-mount.ts"), "utf8");
  check(!/wtext\.eval(Object|Text)Script\(/.test(sm) && !/setConstantScriptRuntime\?\.\(wtext\./.test(sm), "引擎所有脚本求值点（对象字段 / 文字 / 效果开关 / general / 材质常量）都走开关后的求值函数");
  check(/const scriptsOff = cfg\.scripts === false;/.test(sm) && /evalObjectScript: typeof wtext\.evalObjectScript = scriptsOff \? skipScript/.test(sm), "scripts: false 时求值函数换成「计数并返回 null」");
  const mountSrc = fs.readFileSync(path.join(ROOT, "renderer/src/api/mount.ts"), "utf8");
  check(/scripts: o\.scripts !== false,/.test(mountSrc), "MountOptions.scripts 透传到装配配置，缺省执行");
  const main = fs.readFileSync(path.join(ROOT, "editor/main.ts"), "utf8");
  check(/scripts: scriptsAllowed,/.test(main) && /scriptsAllowedByDefault\(origin\?\.kind \?\? "local", hostUp, SCRIPTS_OVERRIDE\)/.test(main), "编辑器按来源 + 宿主决定每份文档的脚本开关");
  check(/await hostProbe;/.test(main) && /hostUp = !!\(await fetchLibrary\(\)\)/.test(main), "打开前等宿主探测结束（宿主在不在要读库才知道）");
  check(/#scripts-allow"\)\.onclick = \(\) => \{\s*scriptsAllowed = true;[\s\S]{0,120}mountCurrent\(true\)/.test(main), "「仍然执行」只放行本文档并原地重挂");
}

// ───────────────────────────────────────────────────────────────────────────
// X. 导出 WE 原生 scene.pkg（W6-full）：.tex 编码 / 容器写 / buildScenePkg / 闭环
// ───────────────────────────────────────────────────────────────────────────
section("X. 导出 scene.pkg（tex-write / writePkg / buildScenePkg）");
const texW = await imp("renderer/vendor/we-scene/pkg/tex-write.js");
const texR = await imp("renderer/vendor/we-scene/pkg/texture.js");
const pkgC = await imp("renderer/vendor/we-scene/pkg/container.js");
const { stripePng } = await imp("scripts/verify-editor-headless.mjs");
const { buildScenePkg } = await imp("renderer/src/editor/pkg-export.ts");
const same = (a, b) => !!a && !!b && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
/** 最小 JPEG 头：SOI + APP0 + SOF0（只供读尺寸） */
const jpegHead = (w, h) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0, 0xff, 0xd9]);
{
  const sizes = [0, 1, 4, 5, 12, 13, 64, 4096, 70000];
  const bad = [];
  for (const n of sizes) {
    const s = new Uint8Array(n);
    for (let i = 0; i < n; i++) s[i] = (i % 7) * (i % 3) + ((i >> 9) & 1 ? i & 255 : 0);
    if (!same(texR.lz4Decompress(texW.lz4CompressBlock(s), n), s)) bad.push(n);
  }
  const rnd = crypto.getRandomValues(new Uint8Array(60000));
  if (!same(texR.lz4Decompress(texW.lz4CompressBlock(rnd), rnd.length), rnd)) bad.push("random");
  check(bad.length === 0, `LZ4 块压缩 → 引擎 lz4Decompress 往返一致（空 / 短于尾部约束 / 长匹配 / 不可压随机；失败 ${json(bad)}）`);
  const zeros = new Uint8Array(1 << 20);
  check(texW.lz4CompressBlock(zeros).length < zeros.length / 200, "LZ4 对纯色像素真压缩（1MB 零 → < 5KB）");

  const W = 37;
  const H = 21;
  const px = new Uint8Array(W * H * 4).map((_, i) => (i * 13) & 255);
  const t = texR.parseTex(texW.encodeTexRgba({ rgba: px, width: W, height: H }));
  const m0 = texR.decodeMip0(t);
  check(t.format === 0 && t.flags === 2 && t.freeImageFormat === -1 && t.containerMagic === "TEXB0003\0" && same(m0.rgba, px) && m0.width === W, "encodeTexRgba：ARGB8888 + LZ4，parseTex / decodeMip0 读回原像素（非 POT 不补边）");
  check(json(t.images[0].map((m) => `${m.width}x${m.height}`)) === json(["37x21", "18x10", "9x5", "4x2", "2x1", "1x1"]), "encodeTexRgba：mip 链逐级减半到 1×1");
  const mips = texR.decodeMips(t);
  check(mips.length === 6 && mips[5].rgba.length === 4 && mips[1].rgba[0] === ((px[0] + px[4] + px[W * 4] + px[W * 4 + 4] + 2) >> 2), "下级 mip = 2×2 box 平均（引擎 decodeMips 可逐级取）");
  const raw = texR.parseTex(texW.encodeTexRgba({ rgba: px, width: W, height: H, mips: false, lz4: false }));
  check(raw.images[0].length === 1 && raw.images[0][0].compression === 0 && same(texR.decodeMip0(raw).rgba, px), "encodeTexRgba：可关 mip / 关压缩");

  const png = stripePng(300, 120, [200, 10, 10], [10, 10, 200]);
  check(json(texW.imageSize(png)) === json({ width: 300, height: 120 }) && json(texW.imageSize(jpegHead(640, 360))) === json({ width: 640, height: 360 }) && texW.imageSize(new Uint8Array([1, 2, 3])) === null, "imageSize：PNG IHDR / JPEG SOF 读宽高，认不出返回 null");
  const tp = texR.parseTex(texW.encodeTexImage({ bytes: png, width: 300, height: 120 }));
  check(tp.containerMagic === "TEXB0004\0" && tp.freeImageFormat === 13 && tp.flags === 2 && tp.textureWidth === 300 && tp.width === 300 && same(texR.decodeMip0(tp).png, png), "encodeTexImage：TEXB0004 内嵌 PNG 原字节、不补 POT、flags=2（官方导出器形态）");
  const jh = jpegHead(64, 32);
  const tj = texR.parseTex(texW.encodeTexImage({ bytes: jh, width: 64, height: 32 }));
  const dj = texR.decodeMip0(tj);
  check(tj.freeImageFormat === 2 && dj.fif === 2 && same(dj.image, jh), "encodeTexImage：内嵌 JPEG（fif=2）");
  let threw = false;
  try {
    texW.encodeTexImage({ bytes: new Uint8Array([1, 2, 3, 4]), width: 1, height: 1 });
  } catch {
    threw = true;
  }
  check(threw, "encodeTexImage：非 PNG / JPEG 字节拒绝");

  const entries = [
    { name: "scene.json", data: enc.encode("{}") },
    { name: "materials/中文.tex", data: png },
    { name: "a.txt", data: new Uint8Array(0) },
  ];
  const pk = pkgC.parsePkg(pkgC.writePkg(entries));
  check(pk.magic === "PKGV0012" && json(pk.entries.map((e) => e.name)) === json(["a.txt", "materials/中文.tex", "scene.json"]) && same(pkgC.getEntry(pk, "materials/中文.tex"), png) && pkgC.getEntry(pk, "a.txt").length === 0 && pkgC.verifyLayout(pk).ok, "writePkg → parsePkg / getEntry 往返（排序、UTF-8 名、空文件、布局自检）");
  check(same(pkgC.writePkg(entries), pkgC.writePkg([...entries].reverse())), "writePkg：输入顺序无关，产物逐字节确定");
  threw = false;
  try {
    pkgC.writePkg([entries[0], { name: "scene.json", data: new Uint8Array(1) }]);
  } catch {
    threw = true;
  }
  check(threw, "writePkg：入口重名拒绝（读端只认第一个，静默会丢数据）");
  const packDir = path.join(tmpRoot, "pack-same");
  for (const e of entries) {
    fs.mkdirSync(path.dirname(path.join(packDir, e.name)), { recursive: true });
    fs.writeFileSync(path.join(packDir, e.name), e.data);
  }
  check(same(packSourceProject(packDir).buffer, pkgC.writePkg(entries)), "dev-pack-pkg 与编辑器导出共用 writePkg（同输入同字节）");

  const r = buildScenePkg([
    { path: "scene.json", data: enc.encode("{}") },
    { path: "materials/editor/bg.png", data: png },
    { path: "materials/editor/ph.jpg", data: jh },
    { path: "materials/editor/bg.json", data: enc.encode("{}") },
    { path: "materials/old.png", data: png },
    { path: "materials/old.tex", data: new Uint8Array([7]) },
    { path: "materials/broken.png", data: new Uint8Array([1, 2]) },
    { path: "files/user.png", data: png },
    { path: "nested/scene.pkg", data: new Uint8Array(4) },
  ]);
  check(json(r.converted.sort()) === json(["materials/editor/bg.tex", "materials/editor/ph.tex"]), `buildScenePkg：materials 下没有 .tex 的 png/jpg 转成 .tex（${json(r.converted)}）`);
  check(json(r.entries) === json(["files/user.png", "materials/broken.png", "materials/editor/bg.json", "materials/editor/bg.tex", "materials/editor/ph.tex", "materials/old.tex", "scene.json"]), `buildScenePkg：源图不进包、已有 .tex 的源图丢弃、materials 外图片与认不出的图原样保留、嵌套 pkg 丢弃（${json(r.entries)}）`);
  const rp = pkgC.parsePkg(r.pkg);
  check(same(texR.decodeMip0(texR.parseTex(pkgC.getEntry(rp, "materials/editor/bg.tex"))).png, png) && pkgC.getEntry(rp, "materials/old.tex")[0] === 7, "buildScenePkg：包内 .tex 解出源图原字节；已有 .tex 原样");

  const pp = saveMod.packProject([
    { path: "scene.json", data: enc.encode("{}") },
    { path: "materials/editor/bg.png", data: png },
    { path: "project.json", data: enc.encode("{}") },
    { path: "preview.jpg", data: jh },
  ]);
  check(json(pp.files.map((f) => f.path)) === json(["project.json", "preview.jpg", "scene.pkg"]) && json(pp.packed.entries) === json(["materials/editor/bg.tex", "scene.json"]), "packProject：project.json / 封面留在包外，其余进 scene.pkg");
}

section("X3. 视频：WE 视频 .tex / pkg 导出 mp4 / 视频层 / 视频壁纸工程保存");
/** 最小 mp4：ftyp + moov/trak/tkhd(v0)，只供读尺寸与判型 */
function fakeMp4(w, h, tail = 0) {
  const box = (type, body) => {
    const b = new Uint8Array(8 + body.length);
    new DataView(b.buffer).setUint32(0, b.length);
    b.set(enc.encode(type), 4);
    b.set(body, 8);
    return b;
  };
  const cat = (...a) => {
    const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0));
    let p = 0;
    for (const x of a) o.set(x, p), (p += x.length);
    return o;
  };
  const tkhd = new Uint8Array(84);
  const dv = new DataView(tkhd.buffer);
  dv.setUint32(76, w << 16);
  dv.setUint32(80, h << 16);
  const ftyp = box("ftyp", cat(enc.encode("isom"), new Uint8Array(4), enc.encode("isomavc1")));
  const moov = box("moov", box("trak", box("tkhd", tkhd)));
  return cat(ftyp, moov, box("mdat", new Uint8Array(tail).map((_, i) => (i * 31) & 255)));
}
{
  const mp4 = fakeMp4(640, 360, 1000);
  check(texW.isMp4Bytes(mp4) && !texW.isMp4Bytes(new Uint8Array(16)), "isMp4Bytes：认 ftyp 头");
  check(json(texW.mp4Size(mp4)) === json({ width: 640, height: 360 }) && texW.mp4Size(new Uint8Array(4)) === null, "mp4Size：moov/trak/tkhd 读显示宽高（16.16 定点）");
  const tex = texW.encodeTexVideo({ bytes: mp4, width: 640, height: 360 });
  const tv = texR.parseTex(tex);
  check(tv.isVideo && tv.flags === 34 && tv.format === 0 && tv.containerMagic === "TEXB0003\0" && tv.freeImageFormat === -1 && tv.textureWidth === 640 && tv.height === 360, `encodeTexVideo：flags=32|2、TEXB0003、fif=-1、tex 尺寸 = 视频尺寸（官方视频 tex 形态；flags=${tv.flags}）`);
  check(tex.length === mp4.length + 87 && same(texR.decodeMip0(tv).video, mp4), "encodeTexVideo：87 字节头 + mp4 原字节，引擎 decodeMip0 取回原视频");
  let threw = false;
  try {
    texW.encodeTexVideo({ bytes: new Uint8Array(32), width: 1, height: 1 });
  } catch {
    threw = true;
  }
  check(threw, "encodeTexVideo：非 mp4 字节拒绝");

  const wpRoot = path.join(os.homedir(), "Library/Application Support/io.github.oneincase.wallpaperem/wallpapers");
  let realChecked = 0;
  for (const id of ["2958411739", "2955378002", "2903412088"]) {
    const pkgPath = path.join(wpRoot, id, "scene.pkg");
    if (!fs.existsSync(pkgPath)) continue;
    const pk = pkgC.parsePkg(new Uint8Array(fs.readFileSync(pkgPath)));
    for (const e of pk.entries) {
      if (!e.name.endsWith(".tex")) continue;
      const orig = pkgC.getEntry(pk, e.name);
      const t = texR.parseTex(orig);
      if (!t.isVideo) continue;
      const v = texR.decodeMip0(t).video;
      const re = texW.encodeTexVideo({ bytes: v, width: t.width, height: t.height });
      check(same(re, orig), `真实视频 tex 逐字节复现：${id}/${e.name}`);
      realChecked++;
    }
  }
  if (!realChecked) console.log("  · 本机无真实视频壁纸语料，跳过逐字节复现");

  const r = buildScenePkg([
    { path: "scene.json", data: enc.encode("{}") },
    { path: "materials/editor/video-clip.mp4", data: mp4 },
    { path: "materials/editor/video-bad.mp4", data: new Uint8Array(12) },
  ]);
  check(json(r.converted) === json(["materials/editor/video-clip.tex"]) && !r.entries.includes("materials/editor/video-clip.mp4"), `buildScenePkg：materials 下 mp4 编成视频 .tex，源 mp4 不进包（${json(r.entries)}）`);
  const vt = texR.parseTex(pkgC.getEntry(pkgC.parsePkg(r.pkg), "materials/editor/video-clip.tex"));
  check(vt.isVideo && same(texR.decodeMip0(vt).video, mp4), "buildScenePkg：包内视频 .tex 取回原 mp4");

  const vidMod = await imp("editor/video.ts");
  check(vidMod.isEditorVideoModel("models/editor/video-a.json") && !vidMod.isEditorVideoModel("models/editor/a.json") && !vidMod.isEditorVideoModel(3), "isEditorVideoModel：只认 models/editor/video-*.json");
  check(vidMod.isVideoFile({ name: "a.MOV" }) && vidMod.isVideoFile({ name: "x", type: "video/webm" }) && !vidMod.isVideoFile({ name: "a.png", type: "image/png" }), "isVideoFile：按扩展名 / MIME 分流");
  const files = vidMod.videoLayerFiles("video-clip", { width: 640, height: 360, bytes: mp4 });
  const mat = JSON.parse(dec.decode(files.find((f) => f.name === "materials/editor/video-clip.json").data));
  check(json(files.map((f) => f.name)) === json(["models/editor/video-clip.json", "materials/editor/video-clip.json", "materials/editor/video-clip.mp4"]) && mat.passes[0].textures[0] === "editor/video-clip" && mat.passes[0].shader === "genericimage2", "videoLayerFiles：模型 / genericimage2 材质（贴图 editor/slug）/ 源 mp4 三件套");

  const vpMod = await imp("editor/video-project.ts");
  const vdoc = { title: "Clip", project: { ...vpMod.videoProjectJson("Clip", "clip.mp4"), workshopid: "1" }, video: { path: "clip.mp4", bytes: mp4 } };
  const out = await saveMod.collectVideoProject(vdoc, new Blob([new Uint8Array([0xff, 0xd8])]));
  const pj = JSON.parse(dec.decode(out.find((f) => f.path === "project.json").data));
  check(json(out.map((f) => f.path)) === json(["clip.mp4", "preview.jpg", "project.json"]) && same(out[0].data, mp4), "collectVideoProject：视频原字节 + 封面 + project.json");
  check(pj.type === "video" && pj.file === "clip.mp4" && pj.preview === "preview.jpg" && pj.title === "Clip" && !("workshopid" in pj), "collectVideoProject：type=video、file 指视频、去掉创意工坊 id");
}

section("X2. 导出闭环（新建 → 图片层 + 效果 → 打成 scene.pkg 存库 → 重新打开）");
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => realFetch(String(url).startsWith("/") ? `${host.base}${url}` : url, init);
  try {
    const doc = createMod.newDocument("导出测试", 1280, 720, [0, 0, 0]);
    const empty = { entry: "scene.json", read: async () => null, list: () => [] };
    const ov = assetsMod.overlayAssets("scene.json", empty, () => new Set([...createMod.referencedModels(doc), ...fxMod.referencedEffects(doc)]));
    const bgPng = stripePng(320, 180, [250, 0, 0], [0, 0, 250]);
    const img = { name: "bg.png", bytes: bgPng, ext: "png", width: 320, height: 180 };
    for (const x of createMod.imageLayerFiles("bg", img)) ov.put(x.name, x.data, createMod.modelPathOf("bg"));
    const id = createMod.addImageLayer(doc, "bg", img, "cover");
    const obj = doc.scene.objects.find((o) => o.id === id);
    for (const x of fxMod.effectFiles(fxMod.effectById("tint"))) ov.put(x.name, x.data, fxMod.effectFileOf("tint"));
    fxMod.addEffect(obj, "tint");
    const loose = await saveMod.collectProject(doc, ov, new Blob([jpegHead(64, 36)]));
    const { files, packed } = saveMod.packProject(loose);
    check(packed.converted.length === 1 && packed.converted[0] === "materials/editor/bg.tex" && !packed.entries.some((n) => /\.png$/.test(n)), "导出：图片层源图转 .tex，包里不留 png");
    const itemId = saveMod.newLibraryItemId(doc.title);
    await saveMod.saveToLibrary(itemId, files);
    const onDisk = fs.readdirSync(path.join(hostLib, itemId)).filter((n) => !n.startsWith(".")).sort();
    check(json(onDisk) === json(["preview.jpg", "project.json", "scene.pkg"]), `库目录 = project.json + scene.pkg + 封面（${json(onDisk)}）`);
    const proj = JSON.parse(fs.readFileSync(path.join(hostLib, itemId, "project.json"), "utf8"));
    check(proj.type === "scene" && proj.file === "scene.json" && proj.preview === "preview.jpg", "project.json：file 指包内入口 scene.json（与创意工坊条目同形）");
    const lib = await openMod.fetchLibrary();
    const it = lib?.items.find((i) => i.itemId === itemId);
    check(!!it && it.hasScene && !it.hasLooseScene && openMod.libraryKind(it) === "scene", "库识别为场景包条目（hasScene，非松散）");
    const reopened = await openMod.openLibraryItem(it, `${host.base}/media/dev`, `${host.base}/web/dev`);
    check(reopened.doc.form === "pkg" && json(reopened.doc.scene) === json(doc.scene), "重新打开：按包形态，scene.json（含效果链）逐字段一致");
    const tex = await reopened.assets.read("materials/editor/bg.tex");
    check(same(texR.decodeMip0(texR.parseTex(tex)).png, bgPng), "重新打开：包内 .tex 解出原 PNG 字节");
    const frag = await reopened.assets.read("shaders/effects/wwgl_tint.frag");
    check(frag && dec.decode(frag) === fxMod.effectById("tint").frag, "重新打开：效果 shader 随包自包含");
    const local = await openMod.openLocalFiles([
      localFile("exp/project.json", fs.readFileSync(path.join(hostLib, itemId, "project.json"))),
      localFile("exp/scene.pkg", fs.readFileSync(path.join(hostLib, itemId, "scene.pkg"))),
    ]);
    check(local.doc.form === "pkg" && json(local.doc.scene) === json(doc.scene), "导出的 project.json + scene.pkg 当本地文件打开同样成立（file: scene.json 回退到包）");
    const again = saveMod.packProject(await saveMod.collectProject(reopened.doc, reopened.assets, null));
    check(again.packed.converted.length === 0 && same(again.files.find((f) => f.path === "scene.pkg").data, packed.pkg), "再导出：已是 .tex 不重复转换，包字节与首次导出一致（幂等）");
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Y. 文字层（W11）：editor/text.ts 模板 / 字段读写 / 量盒 / 字体
// ───────────────────────────────────────────────────────────────────────────
section("Y. 文字层 editor/text.ts");
const textMod = await loadEditorModule("text");
const parseMod = await imp("renderer/vendor/we-scene/scene/parse.js");
/** 假量具：每字 0.5 em —— 盒尺寸可手算 */
const fakeMeasure = (t, _font, px) => [...t].length * px * 0.5;
/** 固定「现在」跑模板脚本：沙箱里的 new Date() 解析到 globalThis.Date */
function atTime(iso, fn) {
  const Real = globalThis.Date;
  const fixed = new Real(iso).getTime();
  globalThis.Date = class extends Real {
    constructor(...a) {
      super(...(a.length ? a : [fixed]));
    }
    static now() {
      return fixed;
    }
  };
  try {
    return fn();
  } finally {
    globalThis.Date = Real;
  }
}
const runTpl = (obj, iso, props) =>
  atTime(iso, () => wtextMod.evalTextScript(obj.text.script, props ?? obj.text.scriptproperties, { text: obj.text.value }).callUpdate(""));
{
  const doc = createMod.newDocument("t", 1920, 1080, [0, 0, 0]);
  const id = textMod.addTextLayer(doc, "plain", "文字", "Hello", fakeMeasure);
  const o = doc.scene.objects.find((x) => x.id === id);
  check(doc.roots.some((n) => n.id === id && n.kind === "text"), "新文字层进图层树，种类 text");
  check(
    o.anchor === "none" && o.font === "systemfont_arial" && o.pointsize === 32 && o.horizontalalign === "center" && o.verticalalign === "center" && o.padding === 32 && o.opaquebackground === false && o.maxrows === 1 && o.maxwidth === 500,
    "新文字层与 WE 编辑器新建的文字对象同形（anchor none / arial 32 / 居中 / padding 32）",
  );
  check(o.origin === "960.000 540.000 0.000" && o.text === "Hello", "放在场景中心，内容是裸字符串");
  check(o.size === "320.000 153.600", `盒 = 最宽行 × 1.2 em（em = 4 × 32；${o.size}）`);
  const L = parseMod.parseScene(structuredClone(doc.scene), { type: "scene" }).layers.find((l) => l.id === id);
  check(!!L && L.isText && L.textFont === "systemfont_arial" && L.textPointsize === 32 && L.textAnchor === "none" && L.textPadding === 32 && json(L.size) === json([320, 153.6]), "引擎 parseScene 认得新文字层的字体 / 字号 / 锚点 / 内边距 / 盒");

  check(textMod.setTextValue(o, "Hi\r\nthere!") && o.text === "Hi\nthere!", "改内容：换行规整成 \\n");
  check(textMod.refitTextBox(o, fakeMeasure) && o.size === "384.000 307.200", `多行重量盒：最宽行 6 字 × 64，2 行 × 153.6（${o.size}）`);
  check(!textMod.refitTextBox(o, fakeMeasure), "内容没变时重量盒是空操作");
  check(!textMod.setTextValue(o, "Hi\nthere!"), "同值不算改动");

  const clockId = textMod.addTextLayer(doc, "clock", "时钟", "", fakeMeasure);
  const clock = doc.scene.objects.find((x) => x.id === clockId);
  const cs = checkSceneScript(clock.text.script);
  check(cs.ok && json(cs.entries) === json(["update"]), "时钟模板过预检（入口 update）");
  check(json(clock.text.scriptproperties) === json({ use24h: true, showSeconds: false }) && typeof clock.text.value === "string", "时钟：{ script, scriptproperties, value } 包装，开关落 scriptproperties");
  check(runTpl(clock, "2026-10-06T09:05:07") === "09:05", "时钟 24h：09:05");
  check(runTpl(clock, "2026-10-06T09:05:07", { use24h: false, showSeconds: true }) === "9:05:07 AM", "时钟 12h + 秒：9:05:07 AM");
  check(runTpl(clock, "2026-10-06T00:30:00", { use24h: false, showSeconds: false }) === "12:30 AM" && runTpl(clock, "2026-10-06T13:00:00", { use24h: false }) === "1:00 PM", "时钟 12h：0 点记 12 AM、13 点记 1 PM");
  check(runTpl(clock, "2026-10-06T13:04:59", { use24h: { value: true }, showSeconds: { user: "secs", value: true } }) === "13:04:59", "scriptproperties 的 {value} / {user,value} 包装同样生效");
  check(clock.size === "704.000 153.600", `时钟盒按最宽样例「00:00:00 PM」量（脚本层引擎不扩画布；${clock.size}）`);

  const dateId = textMod.addTextLayer(doc, "date", "日期", "", fakeMeasure);
  const date = doc.scene.objects.find((x) => x.id === dateId);
  check(checkSceneScript(date.text.script).ok, "日期模板过预检");
  check(runTpl(date, "2026-10-06T12:00:00") === "2026-10-06 Tue" && runTpl(date, "2026-01-09T12:00:00", { showWeekday: false }) === "2026-01-09", "日期：YYYY-MM-DD + 周几（可关）");

  check(textMod.presetOf(o) === "plain" && textMod.presetOf(clock) === "clock" && textMod.presetOf(date) === "date", "presetOf 认出普通 / 时钟 / 日期");
  const foreign = { text: { script: "export function update(v) { return v + '!'; }", value: "x" }, size: "100 50", pointsize: 10 };
  check(textMod.presetOf(foreign) === null && !textMod.refitTextBox(foreign, fakeMeasure) && foreign.size === "100 50", "外来脚本文字：不知道会输出什么，盒不动");
  check(textMod.setTextField(foreign, "pointsize", 20) && foreign.size === "200.000 100.000", "外来脚本文字改字号：盒按比例缩放");
  check(textMod.isScriptedText(clock) && !textMod.isScriptedText(o) && textMod.textValue(clock) === clock.text.value, "isScriptedText / textValue 读包装");
  check(textMod.setTextValue(clock, "00:00") && clock.text.script === textMod.CLOCK_SCRIPT && clock.text.value === "00:00", "脚本文字改快照：脚本与 scriptproperties 保留");

  const bound = { text: { user: "title", value: "a" } };
  check(textMod.setTextValue(bound, "b") && json(bound.text) === json({ user: "title", value: "b" }) && textMod.isBoundText(bound), "绑定了用户属性的内容：只改 value，绑定保留");

  const f0 = textMod.getTextFields({ text: "x", padding: "16 16" });
  check(f0.font === "systemfont_arial" && f0.pointsize === 24 && f0.horizontalalign === "center" && f0.verticalalign === "center" && f0.padding === 16 && f0.opaquebackground === false && json(f0.backgroundcolor) === json([0, 0, 0]), "缺省按引擎口径补齐（字号 24、居中），\"16 16\" 形态 padding 读成 16");
  const t = { text: "x", pointsize: { user: "ps", value: 30 }, size: "10 10" };
  check(textMod.setTextField(t, "pointsize", 40) && json(t.pointsize) === json({ user: "ps", value: 40 }), "字号绑定了用户属性：只改 value");
  check([0, -1, NaN, 2000, "x"].every((v) => !textMod.setTextField(t, "pointsize", v)), "字号非法（0 / 负 / NaN / >1000 / 非数）拒绝");
  check(textMod.setTextField(t, "horizontalalign", "right") && t.horizontalalign === "right" && !textMod.setTextField(t, "horizontalalign", "middle") && !textMod.setTextField(t, "verticalalign", "left"), "对齐只收 left/center/right、top/center/bottom");
  check(textMod.setTextField(t, "padding", 8) && t.padding === 8 && !textMod.setTextField(t, "padding", -1), "padding 写数值，负数拒绝");
  check(textMod.setTextField(t, "opaquebackground", true) && t.opaquebackground === true && !textMod.setTextField(t, "opaquebackground", "yes"), "背景开关只收布尔");
  check(textMod.setTextField(t, "backgroundcolor", [2, 0.5, -1]) && t.backgroundcolor === "1.000 0.500 0.000" && !textMod.setTextField(t, "backgroundcolor", [1, 2]), "背景色夹到 0..1 写成 \"r g b\"");
  check(textMod.setTextField(t, "font", "fonts/a.ttf") && t.font === "fonts/a.ttf" && !textMod.setTextField(t, "font", "  ") && !textMod.setTextField(t, "font", "fonts/a.ttf"), "字体：空值拒绝、同值不算改动");
  check(!textMod.setTextField({ image: "m.json" }, "font", "x"), "非文字对象一律拒绝");

  const fd = docMod.makeDoc("f", { type: "scene" }, {
    objects: [
      { id: 1, text: "a", font: "systemfont_consolas" },
      { id: 2, text: "b", font: "fonts/my.ttf" },
      { id: 3, text: "c", font: { user: "f", value: "fonts/other.otf" } },
      { id: 4, image: "m.json", font: "fonts/ignored.ttf" },
    ],
  }, "loose");
  check(json([...textMod.referencedFonts(fd)].sort()) === json(["fonts/my.ttf", "fonts/other.otf"]), "referencedFonts：只收文字层的工程字体（systemfont_* 与非文字对象不算）");
  check(textMod.fontPathOf("My Font.TTF", () => false) === "fonts/my-font.ttf" && textMod.fontPathOf("思源.otf", () => false) === "fonts/font.otf" && textMod.fontPathOf("a.woff", () => false) === null, "fontPathOf：ASCII slug、全非 ASCII 退 font、只收 ttf / otf");
  check(textMod.fontPathOf("a.ttf", (p) => p === "fonts/a.ttf") === "fonts/a-2.ttf", "fontPathOf 判重加 -2");
  check(textMod.SYSTEM_FONTS.includes("systemfont_arial") && textMod.SYSTEM_FONTS.length === 17 && textMod.fontLabel("systemfont_timesnewroman") === "Times New Roman" && textMod.fontLabel("fonts/x.ttf") === "x.ttf", "系统字体表取自引擎（17 个），下拉显示族名 / 文件名");
}

section("Y2. 文字层闭环（新建 → 文字层 + 导入字体 → 存库 → 重新打开）");
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => realFetch(String(url).startsWith("/") ? `${host.base}${url}` : url, init);
  try {
    const doc = createMod.newDocument("文字测试", 1280, 720, [0, 0, 0]);
    const empty = { entry: "scene.json", read: async () => null, list: () => [] };
    const ov = assetsMod.overlayAssets("scene.json", empty, () => new Set([...createMod.referencedModels(doc), ...fxMod.referencedEffects(doc), ...textMod.referencedFonts(doc)]));
    const fontBytes = new Uint8Array([0, 1, 0, 0, 9, 9, 9]);
    ov.put("fonts/used.ttf", fontBytes, "fonts/used.ttf");
    ov.put("fonts/unused.ttf", new Uint8Array([1]), "fonts/unused.ttf");
    const id = textMod.addTextLayer(doc, "plain", "文字", "Hello", fakeMeasure);
    const o = doc.scene.objects.find((x) => x.id === id);
    textMod.setTextField(o, "font", "fonts/used.ttf");
    textMod.addTextLayer(doc, "clock", "时钟", "", fakeMeasure);
    const files = await saveMod.collectProject(doc, ov, null);
    const names = files.map((f) => f.path).sort();
    check(names.includes("fonts/used.ttf") && !names.includes("fonts/unused.ttf"), `保存清单带上被引用的字体、不带没人用的（${json(names)}）`);
    const itemId = saveMod.newLibraryItemId(doc.title);
    await saveMod.saveToLibrary(itemId, files);
    const lib = await openMod.fetchLibrary();
    const it = lib?.items.find((i) => i.itemId === itemId);
    const reopened = await openMod.openLibraryItem(it, `${host.base}/media/dev`, `${host.base}/web/dev`);
    check(json(reopened.doc.scene) === json(doc.scene), "重新打开：文字层（含时钟脚本包装）逐字段一致");
    check(same(await reopened.assets.read("fonts/used.ttf"), fontBytes), "重新打开：字体文件原字节可读（松散形态，引擎按 scene.json 引用预载）");
    const { packed } = saveMod.packProject(files);
    check(packed.entries.includes("fonts/used.ttf"), "打成 scene.pkg 时字体原样入包");
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Z. 粒子层（P4）：editor/particles.ts 模板 / instanceoverride 读写
// ───────────────────────────────────────────────────────────────────────────
section("Z. 粒子层 editor/particles.ts");
const ptMod = await loadEditorModule("particles");
const psMod = await imp("renderer/vendor/we-scene/render/particles.js");
const ptexMod = await imp("renderer/vendor/we-scene/render/particle-textures.js");
/** 引擎 ParticleSystem 不带 GL 真仿真（预热 + secs 秒），返回存活粒子（局部坐标，y 朝上） */
function simulate(def, override, secs = 1) {
  const ps = new psMod.ParticleSystem(null, def, override, { origin: [0, 0, 0], scale: [1, 1, 1], angles: [0, 0, 0], visible: true });
  for (let t = 0; t < secs; t += 1 / 30) ps.advance(1 / 30);
  return { ps, alive: ps.pool.filter((p) => p.alive) };
}
const inRect = (alive, W, H) => alive.filter((p) => Math.abs(p.x) <= W / 2 && Math.abs(p.y) <= H / 2).length / Math.max(1, alive.length);
{
  const doc = createMod.newDocument("p", 1920, 1080, [0, 0, 0]);
  const ov = assetsMod.overlayAssets("scene.json", { entry: "scene.json", read: async () => null, list: () => [] }, () => ptMod.referencedParticles(doc));
  const slug = ptMod.particleSlug("snow", (p) => ov.has(p));
  check(slug === "snow" && ptMod.particleSlug("snow", (p) => p === "particles/editor/snow.json") === "snow-2", "particleSlug：模板名，判重加 -2");
  const files = ptMod.particleLayerFiles(doc, "snow", slug);
  check(json(files.map((f) => f.name)) === json(["particles/editor/snow.json", "materials/editor/particles/snow.json"]), "一个粒子层两件：粒子系统 + 材质");
  const sys = JSON.parse(dec.decode(files[0].data));
  const mat = JSON.parse(dec.decode(files[1].data));
  check(sys.material === "materials/editor/particles/snow.json" && sys.maxcount === 500 && sys.starttime === 20 && sys.emitter[0].name === "boxrandom", "粒子系统引用自己的材质，maxcount / starttime 写全");
  const pass = mat.passes[0];
  check(pass.shader === "genericparticle" && json(pass.textures) === json(["particle/halo"]) && pass.blending === "translucent", "材质：genericparticle + 内置名 particle/halo（不拷素材）");
  check(ptexMod.isBuiltinParticleTextureName("particle/halo") && !!ptexMod.buildBuiltinParticleTexture("particle/halo"), "particle/halo 是引擎认得的内置名，没有文件也能程序化生成");
  const ids1 = [...sys.emitter, ...sys.initializer, ...sys.operator, ...sys.renderer].map((x) => x.id);
  check(new Set(ids1).size === ids1.length && ids1.every((x) => Number.isInteger(x) && x > 0), "各组件带唯一正整数 id（WE 编辑器的形态）");

  const id = ptMod.addParticleLayer(doc, "snow", "雪", slug);
  const o = doc.scene.objects.find((x) => x.id === id);
  check(doc.roots.some((n) => n.id === id && n.kind === "particle"), "新粒子层进图层树，种类 particle");
  check(o.particle === "particles/editor/snow.json" && o.origin === "960.000 540.000 0.000" && o.visible === true && json(o.instanceoverride) === json({ alpha: 1, count: 1, lifetime: 1, rate: 1, size: 1, speed: 1 }), "放在场景中心，instanceoverride 六个倍率初始 1");
  check(!ptMod.addParticleLayer(doc, "fog", "x", "fog"), "未知模板拒绝");
  const L = parseMod.parseScene(structuredClone(doc.scene), { type: "scene" }).layers.find((l) => l.id === id);
  check(!!L && L.particle === "particles/editor/snow.json" && json(L.origin) === json([960, 540, 0]) && L.instanceoverride?.count === 1, "引擎 parseScene 认得新粒子层（路径 / 位置 / instanceoverride）");
  check(json([...ptMod.referencedParticles(doc)]) === json(["particles/editor/snow.json"]), "referencedParticles 收粒子层路径");

  for (const [W, H] of [[1920, 1080], [1080, 1920]]) {
    for (const preset of ptMod.PARTICLE_PRESETS) {
      const def = ptMod.particleSystemDef(preset, preset, W, H);
      const { alive } = simulate(def, null, 1);
      const frac = inRect(alive, W, H);
      check(alive.length >= 20 && frac >= 0.6, `${preset} @${W}×${H}：引擎仿真预热后有粒子（${alive.length} 颗），${(frac * 100).toFixed(0)}% 落在画面内`);
    }
  }
  const vy = (preset) => {
    const { alive } = simulate(ptMod.particleSystemDef(preset, preset, 1920, 1080), null, 1);
    return alive.reduce((s, p) => s + p.vy, 0) / alive.length;
  };
  check(vy("snow") < -30 && vy("rain") < -1000 && vy("embers") > 30, "运动方向：雪慢落、雨快落、火花上飘（y 朝上）");
  const rainDef = ptMod.particleSystemDef("rain", "rain", 1920, 1080);
  check(rainDef.renderer[0].name === "spritetrail" && psMod.spriteTrailLengthFactor(1700, rainDef.renderer[0].length, 0, rainDef.renderer[0].maxlength) > 10, "雨用 spritetrail：典型速度下拖尾 > 10 倍宽（是雨丝不是圆点）");
  check(ptMod.particleMaterialDef("embers").passes[0].blending === "additive" && ptMod.particleMaterialDef("bokeh").passes[0].blending === "additive", "火花 / 光点叠加混合");

  const p0 = ptMod.getParticleParams({ particle: "x.json" });
  check(ptMod.PARTICLE_PARAMS.every((k) => p0[k] === 1) && p0.color === null, "无 instanceoverride：倍率都读成 1、无颜色覆盖");
  check(ptMod.setParticleParam(o, "count", 0.5) && o.instanceoverride.count === 0.5 && !ptMod.setParticleParam(o, "count", 0.5), "改数量写 instanceoverride.count，同值不算改动");
  check(ptMod.setParticleParam(o, "count", 0) && ptMod.setParticleParam(o, "rate", 0) && ptMod.setParticleParam(o, "alpha", 0), "count / rate / alpha 可以写 0（不发射 / 定格 / 隐形）");
  check(["size", "speed", "lifetime"].every((k) => !ptMod.setParticleParam(o, k, 0)), "size / speed / lifetime 不收 0（引擎按 `|| 1` 读，0 会变回 1）");
  check(!ptMod.setParticleParam(o, "alpha", 1.5) && !ptMod.setParticleParam(o, "count", 6) && !ptMod.setParticleParam(o, "size", NaN) && !ptMod.setParticleParam(o, "brightness", 1), "越界 / NaN / 不认识的键拒绝");
  check(ptMod.setParticleParam(o, "speed", 1.23456) && o.instanceoverride.speed === 1.235, "写入取 3 位小数");
  check(!ptMod.setParticleParam({ image: "m.json" }, "count", 1) && !ptMod.setParticleColor({ image: "m.json" }, [1, 0, 0]), "非粒子层一律拒绝");
  const bare = { particle: "x.json" };
  check(ptMod.setParticleParam(bare, "size", 2) && json(bare.instanceoverride) === json({ size: 2 }), "没有 instanceoverride 的外来粒子层：按需建一张");
  const bound = { particle: "x.json", instanceoverride: { size: { user: "sz", value: 1 }, colorn: { user: "c", value: "1 1 1" } } };
  check(ptMod.setParticleParam(bound, "size", 3) && json(bound.instanceoverride.size) === json({ user: "sz", value: 3 }) && ptMod.getParticleParams(bound).size === 3, "绑定了用户属性的倍率：只改 value，绑定保留");
  check(ptMod.setParticleColor(bound, [1, 0, 0]) && json(bound.instanceoverride.colorn) === json({ user: "c", value: "1.000 0.000 0.000" }), "绑定了用户属性的颜色：只改 value");
  check(!ptMod.setParticleColor(bound, null) && !!bound.instanceoverride.colorn, "绑定了用户属性的颜色不能去掉覆盖");

  check(ptMod.setParticleColor(o, [2, 0.5, -1]) && o.instanceoverride.colorn === "1.000 0.500 0.000" && json(ptMod.getParticleParams(o).color) === json([1, 0.5, 0]), "颜色覆盖写 colorn（夹到 0..1）");
  check(ptMod.setParticleColor(o, null) && !("colorn" in o.instanceoverride) && ptMod.getParticleParams(o).color === null && !ptMod.setParticleColor(o, null), "去掉颜色覆盖：删 colorn，再去一次是空操作");
  const legacy = { particle: "x.json", instanceoverride: { color: "255 0 0" } };
  check(json(ptMod.getParticleParams(legacy).color) === json([1, 0, 0]), "旧式 color（0..255）读成 0..1");
  check(ptMod.setParticleColor(legacy, [0, 1, 0]) && !("color" in legacy.instanceoverride) && legacy.instanceoverride.colorn === "0.000 1.000 0.000", "写 colorn 时去掉裸 color（两者都在时引擎按键序后写的生效）");

  const eng = { particle: "x.json", instanceoverride: {} };
  for (const [k, v] of [["count", 0.5], ["speed", 2], ["size", 1.5], ["rate", 0.5], ["lifetime", 2], ["alpha", 0.25]]) ptMod.setParticleParam(eng, k, v);
  ptMod.setParticleColor(eng, [1, 0, 0]);
  const { ps } = simulate(ptMod.particleSystemDef("snow", "snow", 1920, 1080), eng.instanceoverride, 0);
  check(ps.maxCount === 250 && ps._ov.speed === 2 && ps._ov.size === 1.5 && ps.timeScale === 0.5 && ps.lifetimeMul === 2 && ps.opacityMul === 0.25 && json(ps._ov.color) === json([1, 0, 0]), "写出的 instanceoverride 引擎按倍率吃进去（池 500 × 0.5、速度 / 大小 / 播放速率 / 寿命 / 不透明度 / 颜色）");
  const few = simulate(ptMod.particleSystemDef("snow", "snow", 1920, 1080), { count: 0.25 }, 1).alive.length;
  const many = simulate(ptMod.particleSystemDef("snow", "snow", 1920, 1080), { count: 1 }, 1).alive.length;
  check(few < many * 0.5, `数量 0.25 时稳态粒子明显变少（${few} vs ${many}）`);
}

section("Z2. 粒子层闭环（新建 → 雪 + 光点，撤掉一层 → 存库 → 重新打开）");
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => realFetch(String(url).startsWith("/") ? `${host.base}${url}` : url, init);
  try {
    const doc = createMod.newDocument("粒子测试", 1280, 720, [0, 0, 0]);
    const empty = { entry: "scene.json", read: async () => null, list: () => [] };
    const ov = assetsMod.overlayAssets("scene.json", empty, () => new Set([...createMod.referencedModels(doc), ...fxMod.referencedEffects(doc), ...textMod.referencedFonts(doc), ...ptMod.referencedParticles(doc)]));
    const add = (preset) => {
      const slug = ptMod.particleSlug(preset, (p) => ov.has(p));
      for (const f of ptMod.particleLayerFiles(doc, preset, slug)) ov.put(f.name, f.data, ptMod.particlePathOf(slug));
      return ptMod.addParticleLayer(doc, preset, preset, slug);
    };
    const snowId = add("snow");
    const snow2Id = add("snow");
    add("bokeh");
    check(doc.scene.objects.find((x) => x.id === snow2Id).particle === "particles/editor/snow-2.json", "同模板第二层 slug 判重（snow-2）");
    docMod.removeLayer(doc, snow2Id);
    const o = doc.scene.objects.find((x) => x.id === snowId);
    ptMod.setParticleParam(o, "count", 2);
    ptMod.setParticleColor(o, [0.5, 0.8, 1]);
    const files = await saveMod.collectProject(doc, ov, null);
    const names = files.map((f) => f.path).sort();
    const want = ["particles/editor/snow.json", "materials/editor/particles/snow.json", "particles/editor/bokeh.json", "materials/editor/particles/bokeh.json"];
    check(want.every((n) => names.includes(n)) && !names.some((n) => n.includes("snow-2")), `保存清单带上被引用的粒子两件套、不带删掉那层的（${json(names)}）`);
    const itemId = saveMod.newLibraryItemId(doc.title);
    await saveMod.saveToLibrary(itemId, files);
    const lib = await openMod.fetchLibrary();
    const it = lib?.items.find((i) => i.itemId === itemId);
    const reopened = await openMod.openLibraryItem(it, `${host.base}/media/dev`, `${host.base}/web/dev`);
    check(json(reopened.doc.scene) === json(doc.scene), "重新打开：粒子层（含 instanceoverride 调参）逐字段一致");
    const sysBack = JSON.parse(dec.decode(await reopened.assets.read("particles/editor/snow.json")));
    check(json(sysBack) === json(ptMod.particleSystemDef("snow", "snow", 1280, 720)), "重新打开：粒子系统文件可读，发射区按 1280×720 生成");
    check(!!(await reopened.assets.read("materials/editor/particles/bokeh.json")), "重新打开：材质文件可读");
    const { packed } = saveMod.packProject(files);
    check(want.every((n) => packed.entries.includes(n)), "打成 scene.pkg 时粒子文件原样入包");
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// AA. 声音层：editor/sound.ts 导入成层 / 字段读写 / 音量可绑用户属性
// ───────────────────────────────────────────────────────────────────────────
section("AA. 声音层 editor/sound.ts");
const sndMod = await loadEditorModule("sound");
const upMod2 = await loadEditorModule("userprops");
/** 16-bit 单声道 PCM WAV（正弦），测试用音频 */
function wavBytes(sec = 0.5, freq = 440, rate = 8000) {
  const n = Math.round(sec * rate);
  const buf = new DataView(new ArrayBuffer(44 + n * 2));
  const str = (o, s) => [...s].forEach((c, i) => buf.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  buf.setUint32(4, 36 + n * 2, true);
  str(8, "WAVEfmt ");
  buf.setUint32(16, 16, true);
  buf.setUint16(20, 1, true);
  buf.setUint16(22, 1, true);
  buf.setUint32(24, rate, true);
  buf.setUint32(28, rate * 2, true);
  buf.setUint16(32, 2, true);
  buf.setUint16(34, 16, true);
  str(36, "data");
  buf.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) buf.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 12000), true);
  return new Uint8Array(buf.buffer);
}
{
  check(["a.mp3", "b.OGG", "c.wav", "d.flac"].every((n) => sndMod.isAudioFile({ name: n })) && !sndMod.isAudioFile({ name: "e.m4a" }) && !sndMod.isAudioFile({ name: "f.png" }), "isAudioFile：只收引擎认得的 mp3 / ogg / wav / flac");
  check(sndMod.soundPathOf("My Song.MP3", () => false) === "sounds/my-song.mp3" && sndMod.soundPathOf("雨声.ogg", () => false) === "sounds/sound.ogg" && sndMod.soundPathOf("x.m4a", () => false) === null, "soundPathOf：sounds/<ASCII slug>.<小写扩展名>，全非 ASCII 退 sound");
  check(sndMod.soundPathOf("a.wav", (p) => p === "sounds/a.wav") === "sounds/a-2.wav", "soundPathOf 判重加 -2");

  const doc = createMod.newDocument("s", 1920, 1080, [0, 0, 0]);
  const id = sndMod.addSoundLayer(doc, "bgm", "sounds/bgm.mp3");
  const o = doc.scene.objects.find((x) => x.id === id);
  check(doc.roots.some((n) => n.id === id && n.kind === "sound"), "新声音层进图层树，种类 sound");
  check(json(o) === json({ id, maxtime: 5, mintime: 1, muteineditor: false, name: "bgm", playbackmode: "loop", sound: ["sounds/bgm.mp3"], startsilent: false, volume: 1 }), "与 WE 编辑器新建的声音对象同形（mintime 1 / maxtime 5 是语料 430/444 的缺省），默认循环、满音量");
  check(sndMod.addSoundLayer(doc, "x", "sounds/x.m4a") === null, "不认得的扩展名拒绝");
  const L = parseMod.parseScene(structuredClone(doc.scene), { type: "scene" }).layers.find((l) => l.id === id);
  check(!!L && L.isSound && json(L.sound) === json(["sounds/bgm.mp3"]) && L.soundprops.playbackmode === "loop" && L.soundprops.volume === 1 && L.soundprops.startsilent === false, "引擎 parseScene 认得新声音层（路径 / 模式 / 音量 / 开始静音）");

  const f0 = sndMod.getSoundFields({ sound: ["a.wav"] });
  check(f0.playbackmode === "single" && f0.volume === 1 && f0.startsilent === false && json(f0.files) === json(["a.wav"]), "缺省按引擎口径补齐（single / 1 / false）");
  check(sndMod.setSoundField(o, "volume", 0.5) && o.volume === 0.5 && !sndMod.setSoundField(o, "volume", 0.5), "改音量，同值不算改动");
  check([-0.1, 1.5, NaN, "0.5"].every((v) => !sndMod.setSoundField(o, "volume", v)), "音量越界 / NaN / 非数拒绝");
  check(sndMod.setSoundField(o, "volume", 0.33333) && o.volume === 0.333, "音量取 3 位小数");
  check(sndMod.setSoundField(o, "playbackmode", "single") && o.playbackmode === "single" && !sndMod.setSoundField(o, "playbackmode", "shuffle"), "播放模式只收 loop / single / random");
  check(sndMod.setSoundField(o, "startsilent", true) && o.startsilent === true && !sndMod.setSoundField(o, "startsilent", "yes"), "开始静音只收布尔");
  check(!sndMod.setSoundField({ image: "m.json" }, "volume", 0.5) && !sndMod.replaceSoundFile({ image: "m.json" }, "sounds/a.mp3"), "非声音层一律拒绝");
  const bound = { sound: ["a.mp3"], volume: { user: "musicvolume", value: 0.7 } };
  check(sndMod.setSoundField(bound, "volume", 0.4) && json(bound.volume) === json({ user: "musicvolume", value: 0.4 }) && sndMod.getSoundFields(bound).volume === 0.4, "音量绑了用户属性（语料约一半）：只改 value，绑定保留");
  const multi = { sound: ["a.mp3", "b.mp3"], playbackmode: "random" };
  check(sndMod.replaceSoundFile(multi, "sounds/c.ogg") && json(multi.sound) === json(["sounds/c.ogg", "b.mp3"]) && !sndMod.replaceSoundFile(multi, "sounds/c.ogg") && !sndMod.replaceSoundFile(multi, "sounds/c.txt"), "替换音频：只换第一首（引擎只播它），列表其余保留；同值 / 非音频拒绝");
  const sd = docMod.makeDoc("s", { type: "scene" }, { objects: [{ id: 1, sound: ["sounds/a.mp3", "sounds/b.ogg"] }, { id: 2, sound: ["sounds/c.wav"] }, { id: 3, image: "m.json" }] }, "loose");
  check(json([...sndMod.referencedSounds(sd)].sort()) === json(["sounds/a.mp3", "sounds/b.ogg", "sounds/c.wav"]), "referencedSounds：所有声音层列表里的每一首都算引用");

  check(upMod2.bindableFor("sound").some((f) => f.field === "volume") && !upMod2.bindableFor("image").some((f) => f.field === "volume"), "用户属性绑定：声音层可绑 volume，图片层不出现");
  const bd = createMod.newDocument("b", 1920, 1080, [0, 0, 0]);
  upMod2.declareProp(bd, "musicvolume", "slider");
  const bid = sndMod.addSoundLayer(bd, "bgm", "sounds/bgm.mp3");
  const bo = bd.scene.objects.find((x) => x.id === bid);
  sndMod.setSoundField(bo, "volume", 0.6);
  check(upMod2.bindProp(bd, bo, "volume", "musicvolume") && json(bo.volume) === json({ user: "musicvolume", value: 0.6 }), "音量绑滑条：{ user, value } 包装、保留当前值（与语料同形）");
  check(!upMod2.bindProp(bd, bo, "volume", "nope"), "绑不存在的属性拒绝");
  check(upMod2.unbindProp(bo, "volume") && bo.volume === 0.6, "解绑：回到裸值");
}

section("AA2. 声音层闭环（新建 → 导入两段音频、撤掉一层 → 存库 → 重新打开）");
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => realFetch(String(url).startsWith("/") ? `${host.base}${url}` : url, init);
  try {
    const doc = createMod.newDocument("声音测试", 1280, 720, [0, 0, 0]);
    const empty = { entry: "scene.json", read: async () => null, list: () => [] };
    const ov = assetsMod.overlayAssets("scene.json", empty, () => new Set([...createMod.referencedModels(doc), ...fxMod.referencedEffects(doc), ...textMod.referencedFonts(doc), ...ptMod.referencedParticles(doc), ...sndMod.referencedSounds(doc)]));
    const rain = wavBytes(0.5, 300);
    const bird = wavBytes(0.3, 900);
    const imp = (name, bytes) => {
      const p = sndMod.soundPathOf(name, (x) => ov.has(x));
      ov.put(p, bytes, p);
      return sndMod.addSoundLayer(doc, name.replace(/\.[^.]+$/, ""), p);
    };
    const rainId = imp("rain.wav", rain);
    const birdId = imp("bird.wav", bird);
    docMod.removeLayer(doc, birdId);
    const o = doc.scene.objects.find((x) => x.id === rainId);
    sndMod.setSoundField(o, "volume", 0.5);
    sndMod.setSoundField(o, "startsilent", true);
    const files = await saveMod.collectProject(doc, ov, null);
    const names = files.map((f) => f.path).sort();
    check(names.includes("sounds/rain.wav") && !names.includes("sounds/bird.wav"), `保存清单带上被引用的音频、不带撤掉那层的（${json(names)}）`);
    const itemId = saveMod.newLibraryItemId(doc.title);
    await saveMod.saveToLibrary(itemId, files);
    const lib = await openMod.fetchLibrary();
    const it = lib?.items.find((i) => i.itemId === itemId);
    const reopened = await openMod.openLibraryItem(it, `${host.base}/media/dev`, `${host.base}/web/dev`);
    check(json(reopened.doc.scene) === json(doc.scene), "重新打开：声音层（音量 / 开始静音）逐字段一致");
    check(same(await reopened.assets.read("sounds/rain.wav"), rain), "重新打开：音频原字节可读");
    const { packed } = saveMod.packProject(files);
    check(packed.entries.includes("sounds/rain.wav") && same(pkgC.getEntry(pkgC.parsePkg(packed.pkg), "sounds/rain.wav"), rain), "打成 scene.pkg 时音频原字节入包");
  } finally {
    globalThis.fetch = realFetch;
  }
}

section("AA3. 编辑器音频源 editor/audio-live.ts（系统音频 / 试听 → 引擎频谱）");
{
  const al = await loadEditorModule("audio-live");
  const frame = new Array(64).fill(0);
  frame[0] = 255;
  frame[1] = 128;
  frame[63] = 51;
  const fb = al.bandsFromFrame(frame);
  check(
    fb.left.length === 64 && fb.right.length === 64 && fb.left[0] === 1 && near(fb.left[1], 128 / 255, 1e-6) && near(fb.left[63], 0.2, 1e-6) && json([...fb.left]) === json([...fb.right]),
    "系统音频帧（64 段 0-255）→ 引擎要的 0..1 快照，左右同值",
  );
  check(al.bandsFromFrame(null) === null && al.bandsFromFrame([]) === null, "连不上 media-bridge（没有频段）时不产快照，交回引擎内置源");
  const bad = al.bandsFromFrame([Number.NaN, -5, 999, "x"]);
  check([...bad.left].every((v) => v >= 0 && v <= 1) && [...bad.right].every((v) => v >= 0 && v <= 1), "越界 / NaN / 非数字的频段被夹到 0..1");
  const sil = al.silentBands();
  check(
    sil.left.length === 64 && sil.right.length === 64 && sil.left.every((v) => v === 0) && sil.right.every((v) => v === 0),
    "静默快照显式喂全零（GL uniform 数组不清会留上一帧）",
  );
  const sys = al.createSystemAudioSource();
  check(
    sys.status() === "off" && sys.live() === false && sys.snapshot().left.every((v) => v === 0) && sys.snapshot().right.every((v) => v === 0),
    "系统音频源没开听时状态 off、快照全零（不抛错，宿主没装 media-bridge 也照常挂载）",
  );
  sys.start();
  sys.start(); // 幂等：重复开会话不叠加连接
  sys.stop();
  check(sys.status() === "off" && sys.live() === false, "开 / 关系统音频幂等，关掉后状态回到 off");
  const freq = new Uint8Array(1024);
  freq[5] = 255;
  const bf = al.bandsFromFreq(freq);
  check(
    bf.left.length === 64 && [...bf.left].filter((v) => v > 0).length === 1 && Math.max(...bf.left) === 1,
    "FFT 幅度谱按对数分桶（与 bgm-analyser 同公式），单个峰只落一段",
  );
  const lv = al.meterLevels(bf, 16);
  check(lv.length === 16 && lv.filter((v) => v > 0).length === 1 && Math.max(...lv) === 1, "面板电平条 16 段，每 4 段取最大");
  check(typeof al.mountAudioMeter === "function" && typeof al.createElementAudioSource === "function", "导出电平条与试听分析源");
  const alSrc = fs.readFileSync(path.join(ROOT, "editor/audio-live.ts"), "utf8");
  check(
    /node\.connect\(analyser\)[\s\S]{0,200}analyser\.connect\(ctx\.destination\)/.test(alSrc) && !/ctx\.state === "running"/.test(alSrc),
    "试听分析源：采集后接回输出（不会把试听掐哑），且不等 AudioContext 跑起来才建图",
  );
  const mainSrc = fs.readFileSync(path.join(ROOT, "editor/main.ts"), "utf8");
  const htmlSrc = fs.readFileSync(path.join(ROOT, "editor/index.html"), "utf8");
  const rsSrc = fs.readFileSync(path.join(ROOT, "editor/ui/render-settings.ts"), "utf8");
  check(
    /createElementAudioSource\(au\)/.test(mainSrc) && /setPreviewAudio\(previewAudio\)/.test(mainSrc) && /previewAudio\?\.dispose\(\);\s*previewAudio = null;\s*renderSettings\.setPreviewAudio\(null\)/.test(mainSrc),
    "试听元素接成引擎音频源（试听时频谱条跟着动），停止 / 播完时清掉",
  );
  check(
    /sysAudio: \$\("#audio-sys"\)/.test(mainSrc) && /audioMeter: \$\("#audio-meter"\)/.test(mainSrc) && /audioStatus: \$\("#audio-state"\)/.test(mainSrc),
    "渲染面板的开关 / 状态 / 电平条接进 renderSettings",
  );
  check(
    /id="audio-sys"/.test(htmlSrc) && /id="audio-state"/.test(htmlSrc) && /id="audio-meter"/.test(htmlSrc) && /id="volume" type="range"/.test(htmlSrc),
    "页面：音量（出声）之外另给「系统音频」开关 + 状态 + 电平条",
  );
  check(
    /if \(src\) opts\.audio = src;/.test(rsSrc) && /o\.instance\(\)\?\.setAudio\(src\)/.test(rsSrc) && /activeSrc\(\)/.test(rsSrc),
    "只在真开着音频源时才带 audio 键（键存在 = 接管整条音频模拟），换源走 setAudio 热更",
  );
  const fxSrc = fs.readFileSync(path.join(ROOT, "editor/effects.ts"), "utf8");
  check(
    /id: "audiobars"|def\("audiobars"/.test(fxSrc) && /g_AudioSpectrum32Left\[32\]/.test(fxSrc) && /g_AudioSpectrum32Right\[32\]/.test(fxSrc),
    "内置效果 audiobars（音频频谱条）：声明 WE 的 g_AudioSpectrum32* 直接吃引擎频谱",
  );
}


section("AA4. 内置浏览器虚拟工程 editor/vdir.ts（DirHandle 兼容 + 刷新找回）");
{
  const vd = await loadEditorModule("vdir");
  const be = vd.memoryVdirBackend();
  const dir = await vd.createVirtualProject("Wall 1", be, 1000);
  check(vd.virtualIdOf(dir) === dir.vdirId && dir.name === "Wall 1" && dir.kind === "directory", "新建虚拟工程：拿到一个 DirHandle（name / kind / vdirId 齐全）");
  check(vd.virtualIdOf({ name: "real", getDirectoryHandle() {} }) === null, "真目录（没有 vdirId）不被当虚拟工程");
  check((await vd.openVirtualProject("vdir-不存在", be)) === null, "打开不存在的虚拟工程返回 null，不抛错");
  const td = new TextEncoder();
  await saveMod.writeToDirectory(dir, [
    { path: "scene.json", data: td.encode('{"objects":[]}') },
    { path: "project.json", data: td.encode('{"title":"Wall 1"}') },
    { path: "assets/a.png", data: new Uint8Array([1, 2, 3]) },
  ]);
  const files = await saveMod.filesFromDirectory(dir);
  const bytesOf = async (f) => new Uint8Array(await f.file.arrayBuffer());
  check(
    files.length === 3 && json(files.map((f) => f.path).sort()) === json(["assets/a.png", "project.json", "scene.json"]) && same(await bytesOf(files.find((f) => f.path === "assets/a.png")), new Uint8Array([1, 2, 3])),
    "save.ts 那条写盘链路（writeToDirectory / filesFromDirectory）原样跑在虚拟目录上，二进制逐字节一致",
  );
  await saveMod.probeWritable(dir);
  check(!(await saveMod.filesFromDirectory(dir)).some((f) => f.path === ".webwallgl-write-test"), "可写探测（写一个再删掉）在虚拟目录上也干净收尾");
  let nonEmpty = null;
  try {
    await dir.removeEntry("assets");
  } catch (e) {
    nonEmpty = e;
  }
  check(nonEmpty?.name === "InvalidModificationError", "目录非空时不带 recursive 删不掉（与 File System Access 同语义）");
  await saveMod.removeProjectFile(dir, "assets/a.png");
  check(!(await saveMod.filesFromDirectory(dir)).some((f) => f.path === "assets/a.png"), "removeProjectFile 删得掉（自动保存清理不再引用的资源）");
  let notFound = null;
  try {
    await dir.getFileHandle("nope.txt");
  } catch (e) {
    notFound = e;
  }
  check(notFound?.name === "NotFoundError" && (await dir.getFileHandle("nope.txt", { create: true }))?.name === "nope.txt", "getFileHandle 默认不建文件（NotFoundError），带 create 才建");
  const recs = await vd.listVirtualProjects(be);
  check(recs.length === 1 && recs[0].id === dir.vdirId && recs[0].name === "Wall 1" && typeof recs[0].updatedAt === "number", "工程列表：一条记录（名字 / 更新时间），供对话框与恢复横幅用");
  await vd.renameVirtualDir(dir, "Wall 2", be);
  const recs2 = await vd.listVirtualProjects(be);
  check(dir.name === "Wall 2" && recs2[0].name === "Wall 2", "工程改名：句柄名与浏览器存储里的记录一起对齐");
  const again = await vd.openVirtualProject(dir.vdirId, be);
  check(
    json((await saveMod.filesFromDirectory(again)).map((f) => f.path).sort()) === json(["nope.txt", "project.json", "scene.json"]),
    "刷新 / 重开：按 id 重新拿到句柄，文件都还在（恢复横幅点一下就能接着编辑）",
  );
  vd.setLastVirtualProjectId(dir.vdirId);
  check(vd.lastVirtualProjectId() === null, "没有 localStorage 的环境（Node）里记「上次工程」不抛错，只是记不住");
  await vd.deleteVirtualProject(dir.vdirId, be);
  check((await vd.listVirtualProjects(be)).length === 0 && (await vd.openVirtualProject(dir.vdirId, be)) === null, "删除虚拟工程：列表清空、按 id 再也打不开");
  const mainSrc2 = fs.readFileSync(path.join(ROOT, "editor/main.ts"), "utf8");
  check(
    /async function requireProjectDir\(purpose: DirPurpose = "new"\): Promise<DirHandle \| null> \{\s*return virtualProjectDir\(purpose\);/.test(mainSrc2) &&
      /async function requireLocalDir\(\): Promise<DirHandle \| null>/.test(mainSrc2) &&
      /await probeWritable\(dir\)/.test(mainSrc2) &&
      /requireProjectDir\("open"\)/.test(mainSrc2),
    "新建默认落浏览器存储（requireProjectDir 只转发 virtualProjectDir）；真实目录只由 requireLocalDir 这条显式选择提供",
  );
  check(
    /void checkVirtualResume\(\);/.test(mainSrc2) &&
      /async function checkVirtualResume\(\) \{\s*if \(new URL\(location\.href\)\.searchParams\.get\("item"\)\) return;/.test(mainSrc2) &&
      /async function resumeVirtualProject\(rec: VdirRecord\)/.test(mainSrc2) &&
      !/async function checkVirtualResume\(\) \{\s*if \(canPickDirectory\(\)\) return;/.test(mainSrc2),
    "启动时按上次工程提示恢复：新建已默认虚拟，所以任何浏览器都跑（?item= 打开库条目时不打扰）",
  );
  const histSrc = fs.readFileSync(path.join(ROOT, "editor/history.ts"), "utf8");
  check(/isTitleCmd/.test(histSrc) && /kind: "title"/.test(histSrc) && /TitleSnap/.test(histSrc), "工程名改动进撤销栈（结构命令的快照只装 objects，装不下 title）");
  check(
    /function renameProject\(raw: string\)/.test(mainSrc2) && /function beginRenameProject\(\)/.test(mainSrc2) && /docTitleEl\.addEventListener\("dblclick"/.test(mainSrc2) && /renameBtn\.id = "proj-rename"/.test(mainSrc2),
    "改工程名：标题栏双击就地改 / 检视器工程卡按钮，两条入口同一个函数",
  );
  const htmlSrc2 = fs.readFileSync(path.join(ROOT, "editor/index.html"), "utf8");
  check(
    /id="vdir-dlg"/.test(htmlSrc2) && /id="vdir-list"/.test(htmlSrc2) && /id="vdir-new"/.test(htmlSrc2) && /id="vdir-cancel"/.test(htmlSrc2) && /id="vdir-local"/.test(htmlSrc2) && /id="vdir-pkg"/.test(htmlSrc2) && !/id="tb-open-pkg"/.test(htmlSrc2) && /id="ed-doc-title"/.test(htmlSrc2),
    "页面：工程列表对话框（含「打开本地文件夹…」和「打开 .pkg」）+ 可改的标题栏；工具条不再单放 .pkg 按钮",
  );
  check(
    /const vdirPkgEl = \$<HTMLButtonElement>\("#vdir-pkg"\);/.test(mainSrc2) &&
      /vdirPkgEl\.onclick = \(\) => \{\s*vdirDlgEl\.close\(\);\s*inPkgEl\.click\(\);\s*\};/.test(mainSrc2) &&
      !/tb-open-pkg/.test(mainSrc2),
    "「打开 .pkg」并进「打开」对话框：按钮只负责叫起文件选择器，导入流程仍自带新建（工具条旧按钮与旧接线已删）",
  );
  check(
    /vdirLocalEl\.hidden = !canPickDirectory\(\)/.test(mainSrc2) &&
      /vdirLocalEl\.onclick = \(\) => \{\s*void \(async \(\) => \{\s*const dir = await requireLocalDir\(\);/.test(mainSrc2) &&
      /async function saveProjectToLocalDir\(\)/.test(mainSrc2) &&
      /localBtn\.id = "proj-save-local"/.test(mainSrc2) &&
      /virtualIdOf\(projectDir\) && canPickDirectory\(\)/.test(mainSrc2) &&
      /addEventListener\("click", \(\) => void saveProjectToLocalDir\(\)\)/.test(mainSrc2) &&
      /stSaveEl\.classList\.toggle\("is-clickable", toLocal\)/.test(mainSrc2),
    "真实目录三个显式入口：对话框「打开本地文件夹…」（无文件夹权限时隐藏）、工程卡与状态栏的「存到本机文件夹…」（虚拟工程整份落盘）",
  );
  const i18nSrc = fs.readFileSync(path.join(ROOT, "editor/i18n.ts"), "utf8");
  const twice = (k) => (i18nSrc.match(new RegExp(`"${k.replace(/\./g, "\\.")}"`, "g")) ?? []).length === 2;
  check(
    ["vdir.title", "vdir.local", "vdir.found", "vdir.delConfirm", "vdir.saveHint", "proj.rename", "proj.renameHint", "proj.saveLocal", "st.saveLocalTip", "log.vdirNew", "log.vdirResumed", "log.savedToDir", "log.renamedProject", "log.renameProjectLib", "audio.sys", "audio.live", "audio.previewing", "fx.audiobars", "fxp.mirror"].every(twice),
    "新增文案中英文都齐（每个键在 i18n.ts 里恰好各出现一次 zh / en）",
  );
  check(
    /"tb\.openDir": "打开"/.test(i18nSrc) && /"tb\.openDir": "Open"/.test(i18nSrc) && twice("tb.openPkg"),
    "工具条按钮文案：「打开项目」→「打开」（中英文），.pkg 文案留给对话框按钮",
  );
  // Node / 无 IndexedDB 环境：默认后端必须退化而不是抛错（否则内置浏览器里「新建项目」整条断掉）
  vd.setVdirBackend(null);
  const defRecs = await vd.listVirtualProjects();
  const defDir = await vd.createVirtualProject("临时", undefined, 2000);
  check(
    Array.isArray(defRecs) && defRecs.length === 0 && !!defDir && defDir.kind === "directory" && vd.virtualIdOf(defDir) !== null,
    `无 IndexedDB 时默认后端退化为会话内内存后端：列表不抛错、仍能新建（typeof indexedDB = ${typeof globalThis.indexedDB}）`,
  );
  vd.setVdirBackend(null);
}

section("AB. 关键帧动画 editor/keyframes.ts + 引擎 seekTime");
const kfMod = await loadEditorModule("keyframes");
const snapMod = await loadEditorModule("snap");
const near3 = (a, b, eps = 1e-3) => a.every((v, i) => Math.abs(v - b[i]) < eps);
const animMod = await imp("renderer/vendor/we-scene/render/animation.js");
{
  const near = (a, b, eps = 1e-3) => (Array.isArray(a) ? a.every((v, i) => Math.abs(v - b[i]) < eps) : Math.abs(a - b) < eps);
  check(json(kfMod.baseValue({ origin: "10 20" }, "origin")) === json([10, 20, 0]) && json(kfMod.baseValue({}, "scale")) === json([1, 1, 1]) && json(kfMod.baseValue({ alpha: { user: "a", value: 0.4 } }, "alpha")) === json([0.4]), "baseValue：\"x y z\" 串 / 缺省 / 包装都读成定长数组");

  const o = { id: 1, origin: "10 20 0", alpha: { user: "fade", value: 0.5 } };
  check(kfMod.enableAnim(o, "origin", [10, 20, 0]), "开动画");
  const key0 = (v) => ({ back: { enabled: true, x: -1, y: 0 }, frame: 0, front: { enabled: true, x: 1, y: 0 }, lockangle: true, locklength: true, value: v });
  check(json(o.origin) === json({ animation: { options: { fps: 30, length: 90, mode: "loop", wraploop: false }, relative: false, c0: [key0(10)], c1: [key0(20)], c2: [key0(0)] }, value: "10 20 0" }), "形态与语料最常见写法一致：options {fps 30, length, mode, wraploop}、relative:false、每通道一条、关键帧 6 字段平滑手柄、静态值保留");
  check(!kfMod.enableAnim(o, "origin", [1, 2, 3]) && !kfMod.enableAnim({}, "origin", [1, 2]) && !kfMod.enableAnim({}, "alpha", [NaN]), "已开 / 维度不对 / 非有限值拒绝");
  check(kfMod.enableAnim(o, "alpha", [0.5]) && o.alpha.user === "fade" && o.alpha.value === 0.5 && Array.isArray(o.alpha.animation.c0), "绑了用户属性的字段：包装保留、动画并存");
  check(json(kfMod.animatedFields(o)) === json(["origin", "alpha"]), "animatedFields");
  const L = parseMod.parseScene({ general: {}, objects: [{ ...structuredClone(o), image: "models/x.json" }] }, { type: "scene" }).layers[0];
  check(!!L.objectAnimations?.origin && !!L.objectAnimations?.alpha, "引擎 parseScene 认得编辑器写的字段动画");

  check(kfMod.setKey(o, "origin", 45, [110, 20, 0]) && kfMod.setKey(o, "origin", 20, [50, 20, 0]), "打关键帧");
  check(json(o.origin.animation.c0.map((k) => k.frame)) === json([0, 20, 45]) && o.origin.animation.c0[1].value === 50, "关键帧按帧号有序插入（引擎二分要求单调）");
  check(kfMod.setKey(o, "origin", 20, [60, 20, 0]) && o.origin.animation.c0.length === 3 && o.origin.animation.c0[1].value === 60 && !kfMod.setKey(o, "origin", 20, [60, 20, 0]), "同帧再打 = 改值；同值不算改动");
  check([91, -1, 1.5].every((f) => !kfMod.setKey(o, "origin", f, [0, 0, 0])) && !kfMod.setKey(o, "origin", 10, [1, 2]) && !kfMod.setKey({ origin: "0 0 0" }, "origin", 0, [1, 1, 1]), "越过时长 / 负数 / 非整数帧、维度不对、未开动画拒绝");
  const v = kfMod.getAnim(o, "origin");
  check(v.fps === 30 && v.length === 90 && v.mode === "loop" && !v.relative && v.smooth && json(v.keys.map((k) => k.frame)) === json([0, 20, 45]) && json(v.keys[2].value) === json([110, 20, 0]), "getAnim 视图");

  kfMod.removeKey(o, "origin", 20);
  const ctrl = animMod.createAnimation(o.origin.animation);
  check(near(ctrl.seekTime(1.5).value(), [110, 20, 0]) && near(ctrl.seekTime(0).value(), [10, 20, 0]), "★ 引擎求值：第 45 帧（1.5s）= 打下的值，第 0 帧 = 起始值");
  check(near(ctrl.seekTime(0.75).value()[0], 60), "平滑插值关于段中点对称：22.5 帧正好过中值 60");
  const easeQ = ctrl.seekTime(0.375).value()[0];
  check(easeQ < 35 - 5, `平滑 = 缓入：1/4 处（${easeQ.toFixed(2)}）明显落后于线性的 35`);
  kfMod.setSmooth(o, "origin", false);
  check(!kfMod.getAnim(o, "origin").smooth && near(animMod.createAnimation(o.origin.animation).seekTime(0.375).value()[0], 35), "改线性后 1/4 处正好 35");
  kfMod.setSmooth(o, "origin", true);
  check(near(ctrl.seekTime(3 + 1.5).value(), [110, 20, 0]) && ctrl.playing, "loop：seekTime 越过一个周期折回（3s + 1.5s ≡ 1.5s），仍在播");
  check(near(ctrl.seekTime(1.5).frame, 45) && ctrl.seekTime(1.5)._prevFrame === 45, "seekTime 同 setFrame：上一帧同步到落点（不补发帧事件）");
  const single = animMod.createAnimation({ c0: [key0(0), { ...key0(1), frame: 30 }], options: { fps: 30, length: 30, mode: "single" } });
  single.seekTime(5);
  check(single.frame === 30 && !single.playing && single.ended, "single：越过时长停在末帧、不再播");
  single.seekTime(0.5);
  check(single.frame === 15 && single.playing && !single.ended, "single：往回拖到时长内又能播（编辑器来回拖时间轴）");
  const paused = animMod.createAnimation({ c0: [key0(0)], options: { fps: 30, length: 30, mode: "loop", startpaused: true } });
  paused.seekTime(0.5);
  check(paused.frame === 0 && !paused.playing, "startpaused（等脚本 play）的动画不受 seek 影响");
  const leader = animMod.createAnimation({ c0: [key0(0)], options: { fps: 30, length: 60, mode: "loop" } });
  const child = animMod.createAnimation({ c0: [key0(0)], options: { fps: 30, length: 60, mode: "loop", parent: { key: "alpha" } } });
  child.parent = leader;
  leader.seekTime(1);
  child.seekTime(0.2);
  check(leader.frame === 30 && child.getFrame() === 30, "联动 child 不自己定位，播放头跟 leader");
  check(typeof animMod.createNeutralAnimation().seekTime === "function", "中性控制器也有 seekTime（统一调用不炸）");

  check(kfMod.frameAt({ fps: 30, length: 90, mode: "loop" }, 4) === 30 && kfMod.frameAt({ fps: 30, length: 90, mode: "mirror" }, 4) === 60 && kfMod.frameAt({ fps: 30, length: 90, mode: "single" }, 4) === 90 && kfMod.frameAt({ fps: 30, length: 90, mode: "loop" }, 0.51) === 15, "frameAt：与引擎 wrapFrame 同口径（loop 取模 / mirror 折返 / single 钳住），取整");

  check(!kfMod.removeKey(o, "origin", 7) && kfMod.removeKey(o, "origin", 45) && o.origin.animation.c0.length === 1 && !kfMod.removeKey(o, "origin", 0), "删关键帧；不存在的帧 / 最后一个拒绝（那该是关闭动画）");
  kfMod.setKey(o, "origin", 60, [0, 0, 0]);
  check(!kfMod.setAnimOption(o, "origin", "length", 50) && kfMod.setAnimOption(o, "origin", "length", 120) && o.origin.animation.options.length === 120, "时长不能短于最后一个关键帧");
  check([0, 1.5, 1e9, "120"].every((n) => !kfMod.setAnimOption(o, "origin", "length", n)), "时长只收 1..上限的整数帧");
  check(kfMod.setAnimOption(o, "origin", "mode", "mirror") && !kfMod.setAnimOption(o, "origin", "mode", "pingpong") && kfMod.getAnim(o, "origin").mode === "mirror", "模式只收 loop / mirror / single");

  const rel = { origin: { value: "100 0 0", animation: { relative: true, c0: [key0(0)], c1: [key0(0)], c2: [key0(0)], options: { fps: 30, length: 60, mode: "loop" } } } };
  kfMod.setKey(rel, "origin", 30, [130, 5, 0]);
  check(json(rel.origin.animation.c0.map((k) => k.value)) === json([0, 30]) && rel.origin.animation.c1[1].value === 5, "外来 relative 动画：关键帧写「值 − 基准」");
  const relCtl = animMod.createAnimation(rel.origin.animation);
  check(near(relCtl.seekTime(1).applyTo("100 0 0"), [130, 5, 0]), "★ 引擎按基准叠加后正好是画面上要的值");
  const lin = { alpha: { value: 1, animation: { c0: [{ ...key0(1), front: { enabled: false, x: 1, y: 0 }, back: { enabled: false, x: -1, y: 0 } }], options: { fps: 30, length: 30, mode: "loop" } } } };
  kfMod.setKey(lin, "alpha", 15, [0]);
  check(lin.alpha.animation.c0[1].front.enabled === false, "新关键帧沿用现有插值风格（线性动画里打的还是线性）");
  const mism = { origin: { value: "0 0 0", animation: { c0: [key0(1), { ...key0(2), frame: 10 }], c1: [key0(3)], c2: [key0(4)], options: { fps: 30, length: 30, mode: "loop" } } } };
  const mv = kfMod.getAnim(mism, "origin");
  check(json(mv.keys.map((k) => k.frame)) === json([0, 10]) && Number.isNaN(mv.keys[1].value[1]), "各通道关键帧数不同（语料 4 处）：帧号取并集，缺的通道记 NaN");

  const d1 = { origin: "1 2 3" };
  kfMod.enableAnim(d1, "origin", [1, 2, 3]);
  check(kfMod.disableAnim(d1, "origin", [5, 6, 7]) && d1.origin === "5 6 7", "关动画：去掉 animation，只剩值时解包，值取画面上的当前值");
  check(kfMod.disableAnim(o, "alpha", [0.25]) && json(o.alpha) === json({ user: "fade", value: 0.25 }) && !kfMod.disableAnim(o, "alpha"), "关动画：用户属性绑定保留；没开过的拒绝");

  const sp = kfMod.splitAnimated(o, { origin: [1, 2, 3], alpha: 0.3, visible: true });
  check(json(sp.plain) === json({ alpha: 0.3, visible: true }) && json(sp.keyed) === json({ origin: [1, 2, 3] }), "splitAnimated：落在已开动画字段的改动另拎出来做关键帧");
  kfMod.enableAnim(o, "alpha", [0.25]);
  check(json(kfMod.splitAnimated(o, { alpha: 0.6 }).keyed) === json({ alpha: [0.6] }), "alpha 标量转单元素数组");
  check(json(kfMod.keyTimes(o)) === json([0, 2]), "keyTimes：全部动画字段关键帧的时刻（秒）去重排序");
}

section("AC. 关键帧补完：颜色动画 / 拖动关键帧改时刻");
{
  const key = (frame, v) => ({ back: { enabled: true, x: -1, y: 0 }, frame, front: { enabled: true, x: 1, y: 0 }, lockangle: true, locklength: true, value: v });
  check(json(kfMod.baseValue({}, "color")) === json([1, 1, 1]) && json(kfMod.baseValue({ color: "0.5 0.25 1" }, "color")) === json([0.5, 0.25, 1]), "颜色基准：缺省白、\"r g b\" 串");
  const c = { color: "1 1 1" };
  check(kfMod.enableAnim(c, "color", [1, 1, 1]) && kfMod.setKey(c, "color", 30, [1, 0, 0]) && kfMod.getAnim(c, "color").channels === 3 && c.color.value === "1 1 1", "颜色开动画：3 通道、静态值保留");
  const Lc = parseMod.parseScene({ general: {}, objects: [{ id: 1, text: "x", ...structuredClone(c) }] }, { type: "scene" }).layers[0];
  check(!!Lc.objectAnimations?.color, "引擎 parseScene 认得颜色动画");
  check(near3(animMod.createAnimation(c.color.animation).seekTime(1).value(), [1, 0, 0]), "★ 引擎求值：1s = 红");
  check(json(kfMod.splitAnimated(c, { color: [0, 1, 0], alpha: 0.5 }).keyed) === json({ color: [0, 1, 0] }), "颜色改动也拎出来落关键帧");
  check(kfMod.enableAnim({}, "color", [1, 1, 1]) && !kfMod.enableAnim({}, "color", [1, 1]), "无 color 字段的层开颜色动画补缺省；维度不对拒绝");

  const mk = () => ({
    origin: { value: "0 0 0", animation: { c0: [key(0, 0), key(30, 1), key(60, 2)], c1: [key(0, 0), key(30, 0), key(60, 0)], c2: [key(0, 0), key(30, 0), key(60, 0)], options: { fps: 30, length: 90, mode: "loop" } } },
    alpha: { value: 1, animation: { c0: [key(0, 1), key(30, 0)], options: { fps: 30, length: 90, mode: "loop" } } },
  });
  const m = mk();
  check(kfMod.moveKeyTime(m, 1, 1.5) && json(m.origin.animation.c0.map((k) => k.frame)) === json([0, 45, 60]) && json(m.alpha.animation.c0.map((k) => k.frame)) === json([0, 45]) && m.origin.animation.c1[1].frame === 45, "拖动 1s → 1.5s：该时刻所有字段、所有通道的关键帧一起挪（值不变）");
  const snap = json(m);
  check(!kfMod.moveKeyTime(m, 1.5, 2) && json(m) === snap, "目标帧已有关键帧（位置在 2s 有一枚）：整体拒绝、一处不改（alpha 在 2s 没有也不挪）");
  check(kfMod.moveKeyTime(m, 1.5, 0.5) && json(m.origin.animation.c0.map((k) => [k.frame, k.value])) === json([[0, 0], [15, 1], [60, 2]]), "越过别的关键帧也行：重排后仍按帧号有序、值跟着走");
  const m2 = mk();
  check(kfMod.moveKeyTime(m2, 2, 99) && m2.origin.animation.c0.at(-1).frame === 90, "挪出时长：钳到最后一帧");
  check(!kfMod.moveKeyTime(mk(), 0.7, 1.2) && !kfMod.moveKeyTime(mk(), 1, 1) && !kfMod.moveKeyTime(mk(), NaN, 1), "该时刻没有关键帧 / 原地 / 非法时刻：不算改动");
  const m3 = { origin: { value: "0 0 0", animation: { c0: [key(0, 0), key(12, 1)], c1: [key(0, 0)], c2: [key(0, 0)], options: { fps: 12, length: 24, mode: "loop" } } } };
  check(kfMod.moveKeyTime(m3, 1, 1.5) && m3.origin.animation.c0[1].frame === 18, "按各条动画自己的 fps 换帧（外来 12fps 动画：1.5s = 第 18 帧）");
}

section("AD. 图层树拖拽改父级 / 成组 / 锁定写入文档");
{
  const W = (objs) => new Map(parseMod.parseScene({ general: {}, objects: structuredClone(objs) }, { type: "scene" }).layers.map((l) => [String(l.id), l]));
  const close = (a, b, eps = 1e-3) => a.every((v, i) => Math.abs(v - b[i]) < eps);
  const sameWorld = (a, b, ids) => ids.every((id) => close(a.get(id).origin, b.get(id).origin) && close(a.get(id).scale, b.get(id).scale) && close(a.get(id).angles, b.get(id).angles));
  let ok = true;
  for (let i = 0; i < 40; i++) {
    const r = (k) => (Math.sin(i * 12.9898 + k * 78.233) * 43758.5453) % 1;
    const P = { origin: [r(1) * 900, r(2) * 900, r(3) * 9], scale: [0.2 + Math.abs(r(4)) * 2, 0.2 + Math.abs(r(5)) * 2, 1], angles: [0, 0, r(6) * 6] };
    const C = { origin: [r(7) * 300, r(8) * 300, r(9)], scale: [0.5 + Math.abs(r(10)), 0.5 + Math.abs(r(11)), 1], angles: [0, 0, r(12) * 3] };
    const a = docMod.composeXform(P, C);
    const b = parseMod.composeChildTransform(P, C, true);
    const back = docMod.relativeXform(P, a);
    if (!close(a.origin, b.origin) || !close(a.scale, b.scale) || !close(a.angles, b.angles) || !close(back.origin, C.origin) || !close(back.scale, C.scale) || !close(back.angles, C.angles)) ok = false;
  }
  check(ok, "composeXform 与引擎 composeChildTransform 逐值一致（40 组随机）；relativeXform 是它的精确逆");
  check(docMod.relativeXform({ origin: [0, 0, 0], scale: [0, 1, 1], angles: [0, 0, 0] }, { origin: [1, 1, 0], scale: [1, 1, 1], angles: [0, 0, 0] }) === null, "父 scale 有 0：无解返回 null");

  const base = () => [
    { id: 1, name: "A", text: "a", origin: "100 100 0", scale: "2 2 1", angles: "0 0 0.5" },
    { id: 2, name: "B", text: "b", parent: 1, origin: { user: "pos", value: "10 20 0" }, angles: "0 0 0.25" },
    { id: 3, name: "C", text: "c", origin: "500 300 0", scale: "0.5 0.5 1", angles: "0 0 -0.3" },
    { id: 4, name: "D", text: "d", parent: 3, origin: "40 -10 0" },
    { id: 5, name: "E", text: "e", origin: "960 540 0" },
  ];
  const mk = (objs = base()) => docMod.makeDoc("t", null, { general: {}, objects: objs }, "loose");
  const ids = (d) => d.scene.objects.map((o) => o.id);
  const all = ["1", "2", "3", "4", "5"];

  let d = mk();
  let w0 = W(d.scene.objects);
  check(docMod.placeLayer(d, 2, 3, "inside") === "ok" && d.scene.objects.find((o) => o.id === 2).parent === 3 && json(ids(d)) === json([1, 3, 4, 2, 5]), `拖进 C：B 成为 C 的最后一个子层（数组顺序 ${json(ids(d))}）`);
  check(sameWorld(w0, W(d.scene.objects), all), "★ 引擎 parseScene 对照：换父前后所有层世界变换不变（位置 / 缩放 / 旋转）");
  const b2 = d.scene.objects.find((o) => o.id === 2);
  check(b2.origin.user === "pos" && typeof b2.origin.value === "string", "用户属性包装保留，只改 value");
  check(d.roots.find((n) => n.id === 3).children.map((n) => n.id).join() === "4,2", "图层树同步重建");
  check(docMod.placeLayer(d, 2, 5, "after") === "ok" && !("parent" in d.scene.objects.find((o) => o.id === 2)) && json(ids(d)) === json([1, 3, 4, 5, 2]) && sameWorld(w0, W(d.scene.objects), all), "拖到根层 E 之后：去掉 parent 字段，世界变换仍不变");

  d = mk();
  const snap = json(d.scene.objects);
  check(docMod.placeLayer(d, 3, 4, "inside") === "cycle" && docMod.placeLayer(d, 3, 3, "before") === "cycle" && docMod.placeLayer(d, 1, 2, "after") === "cycle" && json(d.scene.objects) === snap, "放进自己 / 自己的子层：拒绝，文档原样");
  check(docMod.placeLayer(d, 1, 3, "before") === "noop" && docMod.placeLayer(d, 404, 3, "before") === "missing" && json(d.scene.objects) === snap, "原地（A 本来就在 C 之前）不算改动；不存在的层返回 missing");
  check(docMod.placeLayer(d, 5, 1, "before") === "ok" && json(ids(d)) === json([5, 1, 2, 3, 4]) && d.scene.objects[0].origin === "960 540 0", "同级重排：只换顺序，变换字段一字不动");
  check(docMod.placeLayer(d, 3, 5, "before") === "ok" && json(ids(d)) === json([3, 4, 5, 1, 2]) && d.scene.objects[1].parent === 3, "整棵子树作为一块搬动，子层 parent 不变");

  const an = base();
  an[1].origin = { value: "10 20 0", animation: { c0: [], options: { fps: 30, length: 90, mode: "loop" } } };
  d = mk(an);
  const snapA = json(d.scene.objects);
  check(docMod.placeLayer(d, 2, 5, "after") === "animated" && json(d.scene.objects) === snapA, "位置有动画的层换父级：拒绝（关键帧在旧父空间），文档原样");
  const an2 = base();
  an2[1].parent = undefined;
  an2[1].alpha = { value: 1, animation: { c0: [], options: { fps: 30, length: 90, mode: "loop" } } };
  an2[0].origin = { value: "100 100 0", animation: { c0: [], options: { fps: 30, length: 90, mode: "loop" } } };
  delete an2[1].parent;
  d = mk(an2);
  check(docMod.placeLayer(d, 1, 5, "after") === "ok" && docMod.placeLayer(d, 2, 3, "inside") === "ok", "动画层同级重排可以；只有不透明度动画的层可以换父级");

  const dz = base();
  dz[2].scale = "0 1 1";
  d = mk(dz);
  check(docMod.placeLayer(d, 5, 3, "inside") === "degenerate" && json(ids(d)) === json([1, 2, 3, 4, 5]), "目标父层 scale 有 0：拒绝且不挪");
  const ds = base().map((o) => ({ ...o, id: String(o.id), parent: o.parent === undefined ? undefined : String(o.parent) }));
  d = mk(ds);
  w0 = W(d.scene.objects);
  check(docMod.placeLayer(d, "5", "1", "inside") === "ok" && d.scene.objects.find((o) => o.id === "5").parent === "1" && sameWorld(w0, W(d.scene.objects), all), "字符串 id 的工程：parent 写成同类型 id，世界不变");

  d = mk();
  w0 = W(d.scene.objects);
  const gid = docMod.groupLayer(d, 4, "组");
  const g = d.scene.objects.find((o) => o.id === gid);
  check(gid === 6 && g.parent === 3 && d.scene.objects.find((o) => o.id === 4).parent === 6 && json(ids(d)) === json([1, 2, 3, 6, 4, 5]), `成组：新组 #${gid} 插在原位、继承原父级，D 进组`);
  const w1 = W(d.scene.objects);
  check(sameWorld(w0, w1, all) && d.roots.find((n) => n.id === 3).children[0].kind === "group", "★ 引擎对照：成组后画面不变；树里显示为「组」");
  check(docMod.groupLayer(d, 404, "x") === null, "成组：不存在的层返回 null");

  const lo = { id: 9 };
  check(!docMod.isLockedObj(lo) && docMod.isLockedObj({ locktransforms: true }) && docMod.isLockedObj({ locktransforms: { user: "l", value: true } }) && !docMod.isLockedObj({ locktransforms: false }), "锁定读 WE 原生 locktransforms（含包装）");
  docMod.setLocked(lo, true);
  check(lo.locktransforms === true && docMod.isLockedObj(lo) && (docMod.setLocked(lo, false), lo.locktransforms === false), "setLocked 写布尔（与语料 \"locktransforms\": false 同形）");

  d = mk();
  const cmd = historyMod.structCommand(d, "放进", 2, (dd) => (docMod.placeLayer(dd, 2, 3, "inside") === "ok" ? 2 : undefined));
  check(!!cmd && JSON.parse(cmd.before).find((o) => o.id === 2).parent === 1 && JSON.parse(cmd.after).find((o) => o.id === 2).parent === 3, "走结构命令：前后快照可撤销");
  check(historyMod.structCommand(mk(), "x", 2, (dd) => (docMod.placeLayer(dd, 2, 2, "inside") === "ok" ? 2 : undefined)) === null, "拒绝时不产生撤销记录");
}

section("AE. 视口拖拽吸附 snap.ts");
{
  const S = snapMod;
  check(json(S.boxOf([[10, 20], [50, 5], [40, 60], [0, 30]])) === json({ x0: 0, y0: 5, x1: 50, y1: 60 }) && S.boxOf([]) === null, "boxOf：旋转层取四角的轴对齐包围盒");
  const fcv = S.sceneFrame("cover", 800, 600, 1920, 1080);
  check(Math.abs(fcv.x0 + 133.333) < 1e-3 && Math.abs(fcv.x1 - 933.333) < 1e-3 && fcv.y0 === 0 && fcv.y1 === 600, "sceneFrame cover：取大比例、两侧裁出画布");
  const fc = S.sceneFrame("contain", 800, 600, 1920, 1080);
  const fs2 = S.sceneFrame("stretch", 800, 600, 1920, 1080);
  check(Math.abs(fc.y0 - 75) < 1e-6 && fc.x0 === 0 && fc.x1 === 800 && json(fs2) === json({ x0: 0, y0: 0, x1: 800, y1: 600 }), "sceneFrame contain 上下留黑边居中；stretch 铺满");
  const frame = { x0: 0, y0: 0, x1: 1000, y1: 500 };
  const T = S.snapTargets(frame, [{ x0: 700, y0: 100, x1: 800, y1: 200 }]);
  check(json(T.xs) === json([0, 500, 1000, 700, 750, 800]) && json(T.ys) === json([0, 250, 500, 100, 150, 200]), "候选线：画面左 / 中 / 右、上 / 中 / 下 + 其他层的边缘与中心");
  const box = { x0: 100, y0: 300, x1: 200, y1: 340 };
  let r = S.snapMove(box, 346, 0, T);
  check(r.dx === 350 && json(r.gx) === json([500]), `中心贴画面竖中线：位移 346 → ${r.dx}，参考线 x=500`);
  r = S.snapMove(box, 496, -103, T);
  check(r.dx === 500 && r.dy === -100 && json(r.gx) === json([700]) && json(r.gy) === json([200]), `左缘贴另一层左缘 700、下缘……上缘贴另一层下缘 200（${r.dx}, ${r.dy}）`);
  r = S.snapMove(box, 320, 20, T);
  check(r.dx === 320 && r.dy === 20 && !r.gx.length && !r.gy.length, "离所有线都超过 6px：不吸、无参考线");
  r = S.snapMove(box, 343.9, 0, T);
  check(r.dx === 343.9 && !r.gx.length, "刚好超出阈值（6.1px）不吸");
  r = S.snapMove(box, 344, 0, T);
  check(r.dx === 350, "阈值内（6px）吸上");
  r = S.snapMove({ x0: 0, y0: 0, x1: 100, y1: 10 }, 448, 0, S.snapTargets(frame, [{ x0: 400, y0: 0, x1: 450, y1: 10 }]));
  check(r.dx === 450 && json(r.gx.sort((a, b) => a - b)) === json([450, 500]), "同时对齐两条线（左缘贴 450、中心贴 500）时两条参考线都画");
  r = S.snapMove({ x0: 0, y0: 0, x1: 100, y1: 10 }, 497, 0, S.snapTargets(frame, []), 2);
  check(r.dx === 497, "阈值可调（2px 时 3px 外不吸）");
  r = S.snapMove({ x0: 0, y0: 0, x1: 100, y1: 10 }, 452, 0, S.snapTargets(frame, [{ x0: 551, y0: 0, x1: 560, y1: 10 }]));
  check(r.dx === 451, "多个候选取最近的那条（右缘 552 → 551，而不是中心 502 → 500）");
}

section("AF. 多选：对齐 / 等距分布 / 批量命令 / 多层成组");
{
  const S = snapMod;
  const B = [{ x0: 10, y0: 0, x1: 30, y1: 10 }, { x0: 100, y0: 50, x1: 160, y1: 70 }, { x0: 40, y0: 20, x1: 50, y1: 100 }];
  const D = (m) => json(S.alignDeltas(B, m));
  check(D("left") === json([[0, 0], [-90, 0], [-30, 0]]) && D("right") === json([[130, 0], [0, 0], [110, 0]]) && D("hcenter") === json([[65, 0], [-45, 0], [40, 0]]), "左 / 右 / 水平居中：以总包围盒为基准，只动 x");
  check(D("top") === json([[0, 0], [0, -50], [0, -20]]) && D("bottom") === json([[0, 90], [0, 30], [0, 0]]) && D("vmiddle") === json([[0, 45], [0, -10], [0, -10]]), "顶 / 底 / 垂直居中：只动 y");
  const hd = S.alignDeltas(B, "hdist");
  const moved = B.map((b, i) => ({ x0: b.x0 + hd[i][0], x1: b.x1 + hd[i][0] })).sort((a, b) => a.x0 - b.x0);
  check(json(hd[0]) === json([0, 0]) && json(hd[1]) === json([0, 0]) && Math.abs(moved[1].x0 - moved[0].x1 - (moved[2].x0 - moved[1].x1)) < 1e-9 && hd[2][1] === 0, `水平等距：按中心排序首尾不动，中间那个移到两侧间隙相等（${json(hd)}）`);
  const vd = S.alignDeltas(B, "vdist");
  check(vd.every((d) => d[0] === 0) && json(vd[0]) === json([0, 0]), "垂直等距：只动 y，最上面那个不动");
  check(json(S.alignDeltas(B.slice(0, 2), "hdist")) === json([[0, 0], [0, 0]]) && json(S.alignDeltas(B.slice(0, 1), "left")) === json([[0, 0]]), "分布少于 3 个、对齐少于 2 个：不动");
  check(json(S.unionBox(B)) === json({ x0: 10, y0: 0, x1: 160, y1: 100 }) && S.unionBox([]) === null, "unionBox");

  const c1 = { id: 1, name: "a", before: { origin: [0, 0, 0] }, after: { origin: [5, 0, 0] } };
  const c2 = { id: 2, name: "b", before: { origin: [1, 1, 0] }, after: { origin: [6, 1, 0] } };
  const c0 = { id: 3, name: "c", before: { origin: [1, 1, 0] }, after: { origin: [1, 1, 0] } };
  const bc = historyMod.batchCommand("移动", [c1, c2, c0]);
  check(bc.kind === "batch" && bc.cmds.length === 2 && historyMod.isBatch(bc) && !historyMod.isStruct(bc), "批量命令：去掉没变的条目，作为一步撤销");
  check(historyMod.batchCommand("x", [c1, c0]) === c1 && historyMod.batchCommand("x", [c0]) === null, "只剩一条退回普通属性命令；全没变不入栈");

  const objs = () => [
    { id: 1, text: "a", origin: "100 100 0" },
    { id: 2, text: "b", origin: "300 200 0", scale: "2 2 1", angles: "0 0 0.4" },
    { id: 3, text: "c", parent: 2, origin: "20 10 0" },
    { id: 4, text: "d", origin: "700 500 0" },
    { id: 5, text: "e", parent: 4, origin: "-30 40 0", angles: "0 0 -0.2" },
  ];
  const mk = (o = objs()) => docMod.makeDoc("t", null, { general: {}, objects: o }, "loose");
  const W = (o) => new Map(parseMod.parseScene({ general: {}, objects: structuredClone(o) }, { type: "scene" }).layers.map((l) => [l.id, l.origin]));
  check(json(docMod.topLevelIds(mk(), [3, 2, 5, 1])) === json([1, 2, 5]) && json(docMod.topLevelIds(mk(), [404])) === json([]), "topLevelIds：祖先也被选中的层去掉（子树跟祖先走），按数组顺序");
  let d = mk();
  const w0 = W(d.scene.objects);
  const g = docMod.groupLayers(d, [5, 2, 3], "组");
  const by = (id) => d.scene.objects.find((o) => o.id === id);
  check(g.ok && g.id === 6 && by(2).parent === 6 && by(5).parent === 6 && by(3).parent === 2 && json(d.scene.objects.map((o) => o.id)) === json([1, 6, 2, 3, 5, 4]), `多层成组：组在最靠前那层位置，跨父级的层也放进来，子层随父（${json(d.scene.objects.map((o) => o.id))}）`);
  const w1 = W(d.scene.objects);
  check([1, 2, 3, 4, 5].every((id) => Math.hypot(w0.get(id)[0] - w1.get(id)[0], w0.get(id)[1] - w1.get(id)[1]) < 1e-3), "★ 引擎 parseScene 对照：成组前后所有层世界位置不变");
  const an = objs();
  an[4].origin = { value: "-30 40 0", animation: { c0: [], options: { fps: 30, length: 90, mode: "loop" } } };
  d = mk(an);
  const snap = json(d.scene.objects);
  const bad = docMod.groupLayers(d, [1, 5], "组");
  check(!bad.ok && bad.reason === "animated" && bad.at === 5 && json(d.scene.objects) === snap, "有一层被拒（位置动画需换父）：整体不做，文档原样（不留半个组）");
  check(!docMod.groupLayers(mk(), [404], "组").ok, "全不存在：拒绝");
}

section("AG. 时间轴按层动画条 / 关键帧复制粘贴 keyframes.ts");
{
  const key = (frame, v) => ({ back: { enabled: true, x: -1, y: 0 }, frame, front: { enabled: true, x: 1, y: 0 }, lockangle: true, locklength: true, value: v });
  const a3 = (frames, vals, opts) => ({ c0: frames.map((f, i) => key(f, vals[i])), c1: frames.map((f) => key(f, 0)), c2: frames.map((f) => key(f, 0)), options: { fps: 30, wraploop: false, ...opts } });
  check(kfMod.animSummary({ origin: "1 2 3" }) === null, "animSummary：没有动画 → null（不出动画条）");
  const s = {
    origin: { value: "0 0 0", animation: a3([0, 30], [0, 100], { length: 60, mode: "loop" }) },
    alpha: { value: 1, animation: { c0: [key(0, 1), key(45, 0)], options: { fps: 30, length: 120, mode: "single" } } },
  };
  check(json(kfMod.animSummary(s)) === json({ length: 4, mode: "single", keys: [0, 1, 1.5] }), "animSummary：取最长那条的时长与模式，关键帧取全部字段并集");
  const s12 = { scale: { value: "1 1 1", animation: { ...a3([0, 12], [1, 2], { length: 36, mode: "mirror" }), options: { fps: 12, length: 36, mode: "mirror" } } } };
  check(json(kfMod.animSummary(s12)) === json({ length: 3, mode: "mirror", keys: [0, 1] }), "按各自 fps 换秒（外来 12fps）");

  check(json(kfMod.copyKeysAt(s, 1)) === json({ origin: [100, 0, 0] }) && json(kfMod.copyKeysAt(s, 1.5)) === json({ alpha: [0] }), "copyKeysAt：只拿该时刻有关键帧的字段");
  check(json(kfMod.copyKeysAt(s, 0)) === json({ origin: [0, 0, 0], alpha: [1] }), "0s 两个字段都有");
  check(json(kfMod.copyKeysAt(s, 3)) === json({ origin: [100, 0, 0] }), "按模式折回：loop 2s 一周期，3s ≡ 1s");
  check(kfMod.copyKeysAt(s, 0.5) === null && kfMod.copyKeysAt({ origin: "0 0 0" }, 0) === null && kfMod.copyKeysAt(s, NaN) === null, "该时刻没有关键帧 / 没动画 / 非法时刻 → null");
  const rel = { origin: { value: "100 50 0", animation: { ...a3([0, 30], [0, 20]), relative: true, options: { fps: 30, length: 60, mode: "loop" } } } };
  check(json(kfMod.copyKeysAt(rel, 1)) === json({ origin: [120, 50, 0] }), "relative 动画复制出的是画面绝对值（加回基准）");

  const dst = { origin: { value: "0 0 0", animation: a3([0], [5], { length: 90, mode: "loop" }) } };
  check(kfMod.pasteKeysAt(dst, { origin: [7, 8, 9] }, 2) && json(kfMod.getAnim(dst, "origin").keys.map((k) => [k.frame, ...k.value])) === json([[0, 5, 0, 0], [60, 7, 8, 9]]), "粘到已开动画的字段：在该帧打关键帧");
  check(near3(animMod.createAnimation(dst.origin.animation).seekTime(2).value(), [7, 8, 9]), "★ 引擎求值：2s 正好是粘贴的值");
  const plain = { origin: "1 2 3", alpha: 0.5 };
  check(kfMod.pasteKeysAt(plain, { origin: [10, 20, 30], alpha: [0] }, 1) && kfMod.isAnimated(plain, "origin") && kfMod.isAnimated(plain, "alpha"), "没开动画的字段：粘贴时自动开");
  check(json(kfMod.getAnim(plain, "origin").keys.map((k) => [k.frame, ...k.value])) === json([[0, 1, 2, 3], [30, 10, 20, 30]]) && plain.origin.value === "1 2 3" && json(kfMod.getAnim(plain, "alpha").keys.map((k) => [k.frame, ...k.value])) === json([[0, 0.5], [30, 0]]), "自动开的动画：第 0 帧 = 原静态值，粘贴时刻 = 剪贴板值");
  const late = { origin: "0 0 0" };
  check(kfMod.pasteKeysAt(late, { origin: [1, 1, 1] }, 5) && kfMod.getAnim(late, "origin").length === 150, "粘贴时刻超过缺省时长：动画时长放长到能容下（5s = 150 帧）");
  const relDst = { origin: { value: "100 0 0", animation: { ...a3([0], [0]), relative: true, options: { fps: 30, length: 60, mode: "loop" } } } };
  kfMod.pasteKeysAt(relDst, { origin: [130, 5, 0] }, 1);
  check(near3(animMod.createAnimation(relDst.origin.animation).seekTime(1).applyTo("100 0 0"), [130, 5, 0]), "★ 粘到 relative 动画：引擎叠加基准后 = 剪贴板绝对值");
  const keep = { origin: "0 0 0", alpha: 1 };
  const before = json(keep);
  check(!kfMod.pasteKeysAt(keep, { origin: [1, 1, 1], alpha: [1, 2] }, 1) && json(keep) === before, "剪贴板里有一项维度不对：整体拒绝、一处不改");
  check(!kfMod.pasteKeysAt(keep, { origin: [1, 1, 1] }, 1e6) && json(keep) === before, "超出时长上限：拒绝、不改");
  check(!kfMod.pasteKeysAt(keep, {}, 1) && !kfMod.pasteKeysAt(keep, { origin: [1, 1, 1] }, -1) && !kfMod.pasteKeysAt(keep, { visible: [1] }, 1), "空剪贴板 / 负时刻 / 非动画字段：拒绝");
  const same = { origin: { value: "0 0 0", animation: a3([0, 30], [0, 4], { length: 60, mode: "loop" }) } };
  check(!kfMod.pasteKeysAt(same, { origin: [4, 0, 0] }, 1), "同帧同值：不算改动（不进撤销栈）");
  const roundTrip = { origin: "0 0 0" };
  kfMod.pasteKeysAt(roundTrip, kfMod.copyKeysAt(s, 1), 1);
  check(json(kfMod.copyKeysAt(roundTrip, 1)) === json({ origin: [100, 0, 0] }), "复制 → 粘到另一层 → 再复制：值一致");
}

section("AH. WebGL 上下文丢失自愈 editor/recover.ts（R7 过渡方案）");
{
  const rc = await loadEditorModule("recover");
  const st = [];
  check(rc.allowRecover(st, 0) && rc.allowRecover(st, 1000) && rc.allowRecover(st, 2000) && !rc.allowRecover(st, 3000) && st.length === 3, "一分钟内最多自动重挂 3 次，第 4 次拒绝（拒绝不记账）");
  check(rc.allowRecover(st, 60_000) && json(st) === json([1000, 2000, 60_000]), "最早一次滑出 60s 窗口后又允许（过期项原地修剪）");
  check(!rc.allowRecover([], NaN) && rc.allowRecover([], 5, 1, 10) && !rc.allowRecover([5], 9, 1, 10), "非法时刻拒绝；max / window 可调");
  const e = new Error("x");
  e.name = "ContextLostError";
  check(rc.isContextLost(e) && !rc.isContextLost(new Error("WebGL 上下文丢失")) && !rc.isContextLost({ name: "ContextLostError" }), "只认 name = ContextLostError 的 Error（不靠文案匹配）");
  const smSrc = fs.readFileSync(path.join(ROOT, "renderer/src/scene-mount.ts"), "utf8");
  check(/const err = new Error\("WebGL 上下文丢失[^"]*"\);\s*err\.name = "ContextLostError";/.test(smSrc), "引擎上下文丢失的 onError 带 name = ContextLostError");
  const mainSrc = fs.readFileSync(path.join(ROOT, "editor/main.ts"), "utf8");
  check(/onError: \(err\) => \{\s*if \(isContextLost\(err\)\) onContextLost\(gen\);/.test(mainSrc) && /function onContextLost\(gen: number\) \{\s*if \(gen !== openGen\) return;\s*if \(!allowRecover\(recoverStamps, Date\.now\(\)\)\)/.test(mainSrc) && /log\(et\("log\.ctxLostRecover"\), "warn"\);\s*void mountCurrent\(true\);/.test(mainSrc), "编辑器：本代实例丢上下文 → 限频后按当前文档保持时刻重挂；旧一代的错误不理");
}

section("AB2. 关键帧闭环（新建 → 文字层位置 + 不透明度动画 → 存库 → 重新打开 → 引擎求值）");
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => realFetch(String(url).startsWith("/") ? `${host.base}${url}` : url, init);
  try {
    const doc = createMod.newDocument("动画测试", 1280, 720, [0, 0, 0]);
    const id = textMod.addTextLayer(doc, "plain", "标题", "Hi", fakeMeasure);
    const o = doc.scene.objects.find((x) => x.id === id);
    const base = kfMod.baseValue(o, "origin");
    kfMod.enableAnim(o, "origin", base, { length: 60, mode: "mirror" });
    kfMod.setKey(o, "origin", 60, [base[0] + 300, base[1], base[2]]);
    kfMod.enableAnim(o, "alpha", [0], { length: 30, mode: "single" });
    kfMod.setKey(o, "alpha", 30, [1]);
    const empty = { entry: "scene.json", read: async () => null, list: () => [] };
    const ov = assetsMod.overlayAssets("scene.json", empty, () => new Set());
    const files = await saveMod.collectProject(doc, ov, null);
    const itemId = saveMod.newLibraryItemId(doc.title);
    await saveMod.saveToLibrary(itemId, files);
    const lib = await openMod.fetchLibrary();
    const it = lib?.items.find((i) => i.itemId === itemId);
    const reopened = await openMod.openLibraryItem(it, `${host.base}/media/dev`, `${host.base}/web/dev`);
    check(json(reopened.doc.scene) === json(doc.scene), "重新打开：两条动画逐字段一致");
    const L = parseMod.parseScene(structuredClone(reopened.doc.scene), { type: "scene" }).layers.find((l) => l.id === id);
    const pos = animMod.createAnimation(L.objectAnimations.origin.animation);
    const al = animMod.createAnimation(L.objectAnimations.alpha.animation);
    check(Math.abs(pos.seekTime(2).value()[0] - (base[0] + 300)) < 1e-3 && Math.abs(pos.seekTime(4).value()[0] - base[0]) < 1e-3, "★ 位置 mirror：2s 到最右、4s 折返回起点");
    check(al.seekTime(0).value() === 0 && al.seekTime(5).value() === 1 && !al.playing, "★ 不透明度 single：0 → 1 淡入后停住");
    const { packed } = saveMod.packProject(files);
    const inPkg = JSON.parse(new TextDecoder().decode(pkgC.getEntry(pkgC.parsePkg(packed.pkg), "scene.json")));
    check(json(inPkg.objects.find((x) => x.id === id).origin) === json(o.origin), "打成 scene.pkg 后动画原样在包里");
  } finally {
    globalThis.fetch = realFetch;
  }
}

section("MA. 模型层识别 editor/model.ts + doc.modelFormOf（W12）");
{
  const modelMod = await loadEditorModule("model");
  const { modelTruth, PUPPET_FIXTURES, MESH_FIXTURES } = await imp("scripts/verify-editor-model.mjs");
  const scene = {
    general: {},
    objects: [
      { id: 1, name: "人物", image: "models/a.json", origin: "0 0 0" },
      { id: 2, name: "背景", image: "models/bg.json", origin: "0 0 0" },
      { id: 3, name: "球", model: "models/ball.mdl", origin: "0 0 0" },
      { id: 4, name: "手", image: "models/a.json", parent: 1, origin: "0 0 0" },
      { id: 5, name: "文字", text: { value: "x" }, origin: "0 0 0" },
    ],
  };
  const puppets = new Map([["models/a.json", "models/a_puppet.mdl"]]);
  check(
    docMod.modelFormOf(scene.objects[0], puppets) === "puppet" && docMod.modelFormOf(scene.objects[2]) === "mesh" &&
      docMod.modelFormOf(scene.objects[1], puppets) === undefined && docMod.modelFormOf(scene.objects[0]) === undefined && docMod.modelFormOf(scene.objects[4], puppets) === undefined,
    "modelFormOf：model 字段 → mesh；图片的 model json 在 puppet 表里 → puppet；其余（含没扫过）不是模型",
  );
  const flat = (roots) => roots.flatMap((n) => [n, ...flat(n.children)]);
  const nodes = flat(docMod.buildLayerTree(scene, puppets).roots);
  const byId = (id) => nodes.find((n) => String(n.id) === String(id));
  check(
    byId(1).kind === "image" && byId(1).modelForm === "puppet" && byId(4).modelForm === "puppet" && byId(3).modelForm === "mesh" && byId(2).modelForm === undefined && byId(5).modelForm === undefined,
    "建树：puppet 层仍是 kind image（效果 / 脚本 / 用户属性面板照常），只多一个 modelForm；子层同 json 也认",
  );
  const d = docMod.makeDoc("m", null, structuredClone(scene), "loose");
  check(flat(d.roots).every((n) => n.modelForm !== "puppet") && byId(3).kind === "model", "没扫 puppet 时树里没有 puppet 层（扫描是打开后异步补的）；model 字段直接是模型层");
  d.puppets = puppets;
  docMod.rebuildTree(d);
  check(flat(d.roots).filter((n) => n.modelForm === "puppet").length === 2, "doc.puppets 写入后 rebuildTree 标上 modelForm（结构编辑重建树不丢）");

  const files = new Map([
    ["models/a.json", new TextEncoder().encode('\uFEFF{"material":"m.json","puppet":"models/a_puppet.mdl"}')],
    ["models/bg.json", new TextEncoder().encode('{"material":"m.json"}')],
    ["models/bad.json", new TextEncoder().encode("{oops")],
    ["models/empty.json", new TextEncoder().encode('{"puppet":""}')],
  ]);
  const reads = [];
  const read = async (n) => {
    reads.push(n);
    if (n === "models/throw.json") throw new Error("boom");
    return files.get(n) ?? null;
  };
  const sd = docMod.makeDoc("s", null, {
    objects: [
      ...scene.objects,
      { id: 6, image: "models/bad.json" },
      { id: 7, image: "models/empty.json" },
      { id: 8, image: "models/missing.json" },
      { id: 9, image: "models/throw.json" },
      { id: 10, image: "textures/x.png" },
    ],
  }, "loose");
  const found = await modelMod.scanPuppets(sd, read);
  check(json([...found]) === json([["models/a.json", "models/a_puppet.mdl"]]), "scanPuppets：带 BOM 的 json 照读；非 puppet / 坏 json / 空 puppet / 缺文件 / 读取抛错都不算、也不抛");
  check(reads.filter((n) => n === "models/a.json").length === 1 && !reads.includes("textures/x.png") && !reads.includes("models/ball.mdl"), "同一 json 只读一次；非 .json 图片与 model 字段不读");
  check((await modelMod.scanPuppets({ scene: null }, read)).size === 0, "空文档给空表");

  let corpusOk = 0;
  const corpusBad = [];
  for (const id of [...PUPPET_FIXTURES, ...MESH_FIXTURES]) {
    const t = modelTruth(LIB, id);
    if (!t) continue;
    const cd = docMod.makeDoc(id, null, structuredClone(t.scene), "loose");
    const got = await modelMod.scanPuppets(cd, async (n) => t.read(n) ?? null);
    cd.puppets = got;
    docMod.rebuildTree(cd);
    const formed = new Map(flat(cd.roots).filter((n) => n.modelForm).map((n) => [Number(n.id), n.modelForm]));
    const want = new Map(t.objects.map((o) => [o.id, o.info.form]));
    if (json([...got].sort()) === json([...t.puppets].sort()) && json([...formed].sort()) === json([...want].sort())) corpusOk++;
    else corpusBad.push(id);
  }
  check(corpusOk >= 5 && corpusBad.length === 0, `语料：${corpusOk} 张夹具壁纸的 puppet 表 / 树上模型层与 parseMDL 参照一致（不符 ${json(corpusBad)}）`);

  const info = {
    form: "puppet",
    mdlPath: "models/a_puppet.mdl",
    modelJsonPath: "models/a.json",
    version: "MDLV0023",
    vertexCount: 120,
    bones: [{ name: "root", parent: -1 }, { name: "arm", parent: 0 }],
    animations: [{ id: 7, name: "wave", mode: "loop", fps: 30, frameCount: 45, duration: 1.5, events: [] }, { id: 8, name: "", mode: "single", fps: 24, frameCount: 10, duration: 10 / 24, events: [] }],
    attachments: [{ name: "hand", bone: 1, bindOrigin: [1.23456, -2, 0] }, { name: "tip", bone: 9, bindOrigin: [0, 0, 0] }],
    meshes: [{ materialPath: "materials/a.json", vertexCount: 120, texture: "a" }, { materialPath: null, vertexCount: 3, texture: null }],
  };
  const rows = modelMod.modelInfoRows(info);
  const row = (k) => rows.find((r) => r[0] === k)?.[1];
  check(
    json(rows.map((r) => r[0])) === json(["model.form", "model.mdl", "model.json", "model.version", "model.vertices", "model.bones", "model.animations", "model.attachments", "model.meshes"]),
    "modelInfoRows：分组行序固定（形态 / mdl / json / 版本 / 顶点 / 骨骼 / 动画 / 附着点 / 子网格）",
  );
  check(row("model.animations") === "#7 wave · loop · 1.5s (45f @ 30)\n#8 — · single · 0.417s (10f @ 24)", "动画行：id、名（空名 —）、模式、时长（三位小数）、帧数 @ fps，一条一行");
  check(row("model.attachments") === "hand → arm (1.235, -2)\ntip → #9 (0, 0)", "附着点行：挂到的骨名（越界给 #序号）+ 绑定原点");
  check(row("model.meshes") === "0: materials/a.json · 120v · a\n1: — · 3v", "子网格行：材质、顶点数、实际贴图");
  const meshRows = modelMod.modelInfoRows({ ...info, form: "mesh", modelJsonPath: null, animations: [], attachments: [] });
  check(!meshRows.some((r) => r[0] === "model.json") && meshRows.find((r) => r[0] === "model.animations")[1] === "—" && meshRows.find((r) => r[0] === "model.attachments")[1] === "—", "真 3D：没有 model json 行；无动画 / 附着点给 —");

  const mainSrc = fs.readFileSync(path.join(ROOT, "editor/main.ts"), "utf8");
  check(/opts\.after\?\.\(\);\s*void detectPuppets\(\);/.test(mainSrc) && /const found = await scanPuppets\(d, \(name\) => assets\.read\(name\)\);\s*if \(d !== doc \|\| !found\.size\) return;\s*d\.puppets = found;\s*rebuildTree\(d\);/.test(mainSrc), "页面：打开后异步扫 puppet，换了文档作废，扫完写 doc.puppets 并重建树");
  check(/const info = editor && Number\.isFinite\(id\) \? editor\.getModelInfo\(id\) : null;/.test(mainSrc) && /\{ id: "model", order: 700, when: \(\) => true, render: modelGroup(?:, tab: "model")? \}/.test(mainSrc) && /modelInfoRows\(info\)/.test(mainSrc), "检视器「模型」分组：信息只经 getModelInfo，行由 modelInfoRows 排");
  const pageSrc = fs.readdirSync(path.join(ROOT, "editor")).filter((f) => f.endsWith(".ts") && f !== "i18n.ts").map((f) => fs.readFileSync(path.join(ROOT, "editor", f), "utf8")).join("\n");
  check(!/\.puppet\b(?!s)/.test(pageSrc.replace(/\b(json|modelJson)\.puppet/g, "")) && !/parseMDL|mdl-parse/.test(pageSrc), "页面不读 layer.puppet、不自己解析 .mdl（只有 scanPuppets 读 model json 的 puppet 字段）");
  const i18nSrc = fs.readFileSync(path.join(ROOT, "editor/i18n.ts"), "utf8");
  const mKeys = ["insp.model", "kind.model", "model.notLoaded", "model.form.puppet", "model.form.mesh", ...rows.map((r) => r[0])];
  const mMissing = mKeys.filter((k) => (i18nSrc.match(new RegExp(`"${k.replace(/\./g, "\\.")}":`, "g")) ?? []).length !== 2);
  check(mMissing.length === 0, `模型分组文案中英文都有（缺 ${json(mMissing)}）`);
  const sm = fs.readFileSync(path.join(ROOT, "renderer/src/scene-mount.ts"), "utf8");
  check(/if \(l\.puppet && l\.modelSrc\) return "model";/.test(sm) && /getModelInfo\(id: number\): EditorModelInfo \| null \{/.test(sm), "引擎：只有模型真装上（puppet + modelSrc）才报 kind model；getModelInfo 在控制面上");
}

section("MC. 附着点绑定 editor/model.ts（W14）");
{
  const mm = await loadEditorModule("model");
  const near = (a, b, eps = 1e-3) => a.every((v, i) => Math.abs(v - b[i]) <= eps);
  const offs = { "10|head": [30, 40], "10|hand": [-12, 5], "20|tip": [3, -7] };
  const offOf = (mid, name) => offs[`${mid}|${name}`] ?? null;
  const mk = () =>
    docMod.makeDoc("att", null, {
      objects: [
        { id: 10, name: "人", image: "models/a.json", origin: "100 200 0", scale: "2 0.5 1", angles: "0 0 0.5" },
        { id: 1, name: "帽子", origin: "400 300 0", scale: "1 1 1", angles: "0 0 0.2" },
        { id: 2, name: "帽檐", parent: 1, origin: "10 0 0" },
        { id: 20, name: "剑", image: "models/b.json", parent: 10, attachment: "hand", origin: "1 2 0", scale: "1 1 1", angles: "0 0 0" },
        { id: 3, name: "眼睛", parent: 10, origin: "5 6 0", scale: "1 1 1", angles: "0 0 0" },
        { id: 4, name: "动", origin: { value: "0 0 0", animation: { c0: [], options: { fps: 30, length: 10, mode: "loop" } } } },
        { id: 30, name: "扁", image: "models/c.json", scale: "0 1 1" },
      ],
    }, "loose");
  const W = (d, id) => mm.attachedWorld(d.scene.objects, d.scene.objects.find((o) => o.id === id), offOf);
  {
    const d = mk();
    const w20 = W(d, 20);
    const m = W(d, 10);
    const c = Math.cos(0.5), s = Math.sin(0.5);
    const lx = (1 - 12) * 2, ly = (2 + 5) * 0.5;
    check(near(w20.origin, [100 + lx * c - ly * s, 200 + lx * s + ly * c, 0]) && near(m.origin, [100, 200, 0]), "attachedWorld：挂件局部 origin 先加附着点偏移，再乘父缩放 / 旋转（引擎 parentMeshToWorldDelta 同式）");
  }
  {
    const d = mk();
    const order = json(d.scene.objects.map((o) => o.id));
    const w1 = W(d, 1), w2 = W(d, 2);
    check(mm.attachToModel(d, 1, 10, "head", offOf) === "ok", "attachToModel：普通根层挂到模型附着点");
    const o1 = d.scene.objects.find((o) => o.id === 1);
    check(o1.parent === 10 && o1.attachment === "head" && near(W(d, 1).origin, w1.origin) && near(W(d, 1).scale, w1.scale) && near(W(d, 1).angles, w1.angles) && near(W(d, 2).origin, w2.origin),
      "★ 绑定前后世界变换不变（含子层）");
    check(json(d.scene.objects.map((o) => o.id)) === order, "对象数组顺序不动（绘制层叠不变）");
    const fl = (r) => r.flatMap((n) => [n, ...fl(n.children)]);
    check(d.roots.every((n) => n.id !== 1) && fl(d.roots).find((n) => n.id === 10).children.some((c) => c.id === 1), "树重建：帽子成为模型层的子层");
    check(mm.attachToModel(d, 1, 10, "head", offOf) === "noop", "同模型同附着点再绑 = noop");
    const before3 = d.scene.objects.find((o) => o.id === 3).scale;
    const w3 = W(d, 3);
    check(mm.attachToModel(d, 3, 10, "head", offOf) === "ok" && near(W(d, 3).origin, w3.origin) && d.scene.objects.find((o) => o.id === 3).scale === before3, "已是模型子层：只改 origin，缩放 / 旋转字段原样");
    const wSword = W(d, 20);
    check(mm.attachToModel(d, 20, 10, "head", offOf) === "ok" && near(W(d, 20).origin, wSword.origin), "换附着点（hand → head）世界位置不变");
    const wd = W(d, 1);
    check(mm.detachFromModel(d, 1, offOf) === "ok" && d.scene.objects.find((o) => o.id === 1).attachment === undefined && d.scene.objects.find((o) => o.id === 1).parent === 10 && near(W(d, 1).origin, wd.origin),
      "★ 解绑：去掉 attachment、父级仍是模型层，世界位置不变");
    check(mm.detachFromModel(d, 1, offOf) === "noop", "没挂的层解绑 = noop");
  }
  {
    const d = mk();
    const snap = json(d.scene.objects);
    check(mm.attachToModel(d, 10, 20, "tip", offOf) === "cycle" && mm.attachToModel(d, 10, 10, "head", offOf) === "cycle", "挂到自己 / 自己的子孙上 = cycle");
    check(mm.attachToModel(d, 4, 10, "head", offOf) === "animated", "位置有关键帧 = animated");
    check(mm.attachToModel(d, 1, 10, "nope", offOf) === "noAttachment" && mm.attachToModel(d, 99, 10, "head", offOf) === "missing", "附着点不存在 / 图层不存在");
    offs["30|p"] = [1, 1];
    check(mm.attachToModel(d, 1, 30, "p", offOf) === "degenerate", "模型层缩放有 0 分量 = degenerate");
    check(json(d.scene.objects) === snap, "全部拒绝路径文档原样");
  }
  {
    const d = mk();
    const w1 = W(d, 1);
    check(mm.attachToModel(d, 1, 20, "tip", offOf) === "ok" && near(W(d, 1).origin, w1.origin), "嵌套：挂到「自己也是挂件」的模型上，祖先的附着点偏移一并计入");
  }

  const { parseScene } = await imp("renderer/vendor/we-scene/scene/parse.js");
  const MDL = await imp("renderer/vendor/we-scene/render/mdl.js");
  const { modelTruth, PUPPET_FIXTURES } = await imp("scripts/verify-editor-model.mjs");
  let compared = 0, attachedN = 0, roundTrip = 0;
  const bad = [];
  for (const id of [...PUPPET_FIXTURES, "3791001607", "3790371777", "3226487183"]) {
    const t = modelTruth(LIB, id);
    if (!t) continue;
    const projPath = path.join(LIB, id, "project.json");
    const project = fs.existsSync(projPath) ? JSON.parse(fs.readFileSync(projPath, "utf8")) : {};
    const scene = parseScene(structuredClone(t.scene), project);
    for (const l of scene.layers) {
      if (!l.image) continue;
      let mj = null;
      try { mj = JSON.parse(new TextDecoder().decode(t.read(l.image)).replace(/^\uFEFF/, "")); } catch {}
      const buf = mj?.puppet && t.read(mj.puppet);
      if (buf) l.puppet = MDL.parseMDL(buf);
    }
    MDL.applyAttachmentBindOrigins(scene.layers);
    const layerOf = new Map(scene.layers.map((l) => [String(l.id), l]));
    const eOff = (mid, name) => {
      const l = layerOf.get(String(mid));
      return l ? MDL.attachmentEffectiveOffset(l, name) : null;
    };
    const objs = t.scene.objects;
    const byId = new Map(objs.map((o) => [String(o.id), o]));
    const isPlain = (o) => ["origin", "scale", "angles"].every((f) => o[f] === undefined || typeof o[f] === "string");
    const chainPlain = (o) => {
      for (let c = o, n = 0; c && n < 64; c = byId.get(String(c.parent)), n++) if (!isPlain(c)) return false;
      return true;
    };
    for (const o of objs) {
      const l = layerOf.get(String(o.id));
      if (!l || l.isPostProcess || !chainPlain(o)) continue;
      const w = mm.attachedWorld(objs, o, eOff);
      compared++;
      if (!near(w.origin.slice(0, 2), l.origin.slice(0, 2), 0.05)) bad.push(`${id}#${o.id} 世界 ${w.origin.slice(0, 2).map((v) => v.toFixed(2))} ≠ 引擎 ${l.origin.slice(0, 2).map((v) => v.toFixed(2))}`);
    }
    for (const o of objs) {
      if (!mm.attachmentOf(o) || !chainPlain(o) || !eOff(o.parent, o.attachment)) continue;
      attachedN++;
      const dd = docMod.makeDoc(id, null, structuredClone(t.scene), "loose");
      const me = dd.scene.objects.find((x) => x.id === o.id);
      const w0 = mm.attachedWorld(dd.scene.objects, me, eOff);
      const r1 = mm.detachFromModel(dd, o.id, eOff);
      const w1 = mm.attachedWorld(dd.scene.objects, me, eOff);
      const r2 = mm.attachToModel(dd, o.id, o.parent, o.attachment, eOff);
      const back = docMod.localXform(me).origin;
      if (r1 === "ok" && r2 === "ok" && near(w0.origin, w1.origin, 0.01) && near(back, docMod.localXform(o).origin, 0.01)) roundTrip++;
      else bad.push(`${id}#${o.id} 往返 ${r1}/${r2}`);
    }
  }
  check(compared > 200 && attachedN >= 20 && bad.length === 0,
    `语料：${compared} 个图层的 attachedWorld ≡ 引擎 parseScene + applyAttachmentBindOrigins（绑定姿势）；${attachedN} 个挂件「解绑 → 世界不变 → 重绑 → 局部 origin 复原」往返 ${roundTrip} 个（不符 ${json(bad.slice(0, 4))}）`);

  const mainSrc = fs.readFileSync(path.join(ROOT, "editor/main.ts"), "utf8");
  check(/const attachOffsetOf: AttachOffsetOf = \(mid, name\) =>\s*editor\?\.getAttachmentPoints\(Number\(mid\)\)/.test(mainSrc) && /attachToModel\(d, node\.id, p\.model, p\.name, attachOffsetOf\)/.test(mainSrc) && /detachFromModel\(d, node\.id, attachOffsetOf\)/.test(mainSrc),
    "页面：绑定 / 解绑的偏移只经引擎 getAttachmentPoints（不自己算蒙皮），走 structEdit");
  check(/\{ id: "attach", order: 1200, when: \(\) => true, render: attachGroup(?:, tab: "props")? \}/.test(mainSrc) && /drawAttachMarkers\(\);\s*(drawBoneMarkers\(\);\s*)?\}/.test(mainSrc), "检视器「挂到模型」分组 + 视口附着点十字标记");
  const sm = fs.readFileSync(path.join(ROOT, "renderer/src/scene-mount.ts"), "utf8");
  check(/getAttachmentPoints\(id: number\): EditorAttachmentPoint\[\] \| null \{/.test(sm) && /mdl\.computeSkinMatrices\(m, currentTime\(\), l\.animationLayers, getBoneOverrides\(l\)\);/.test(sm) && /mdl\.attachmentEffectiveOffset\(l, name\)/.test(sm),
    "引擎：getAttachmentPoints 以当前时刻 / 动画层 / 骨骼覆盖求姿势，偏移与挂件定位同一函数");
  const skin = fs.readFileSync(path.join(ROOT, "renderer/vendor/we-scene/render/mdl-skin.js"), "utf8");
  check(/const d = attachmentAtlasBind\(parent\) \? \[0, 0\] : parentMeshToWorldDelta\(parent, bx, by\)/.test(skin), "挂件定位与 getAttachmentPoints 共用 attachmentAtlasBind 判定");
  const i18nSrc = fs.readFileSync(path.join(ROOT, "editor/i18n.ts"), "utf8");
  const keys = [...new Set([...mainSrc.matchAll(/et\("((?:att|insp\.attach|log\.attached|log\.detached)[\w.]*)"/g)].map((m) => m[1]).concat(["att.fail.missing", "att.fail.cycle", "att.fail.animated", "att.fail.degenerate", "att.fail.noAttachment"]))];
  const missing = keys.filter((k) => (i18nSrc.match(new RegExp(`"${k.replace(/\./g, "\\.")}":`, "g")) ?? []).length !== 2);
  check(keys.length >= 9 && missing.length === 0, `挂到模型文案中英文都有（${keys.length} 个键，缺 ${json(missing)}）`);
}

section("MB. 动画层编辑 editor/model.ts（W13）");
{
  const mm = await loadEditorModule("model");
  const { parseAnimationLayers } = await imp("renderer/vendor/we-scene/scene/parse.js");
  const { modelTruth, PUPPET_FIXTURES, MESH_FIXTURES } = await imp("scripts/verify-editor-model.mjs");
  const mkDoc = () => {
    const scene = {
      objects: [
        { id: 3, name: "人", image: "models/a.json", animationlayers: [{ additive: false, animation: 7, blend: 1, blendin: false, blendout: false, blendtime: 0.5, id: 12, name: "走", rate: 1, visible: true }] },
        { id: 9, name: "球", model: "models/b.mdl" },
      ],
    };
    return docMod.makeDoc("al", null, scene, "loose");
  };
  const d = mkDoc();
  const o = d.scene.objects[0];
  const at = mm.addAnimLayer(d, o, 8, "动画 2");
  check(at === 1 && json(Object.keys(o.animationlayers[1])) === json(Object.keys(o.animationlayers[0])) && o.animationlayers[1].id === 13 && o.animationlayers[1].animation === 8 && o.animationlayers[1].blend === 1 && o.animationlayers[1].rate === 1 && o.animationlayers[1].visible === true && o.animationlayers[1].additive === false && o.animationlayers[1].blendtime === 0.5,
    "addAnimLayer：字段与键序同 WE 存盘；id = 对象与动画层共用编号空间的最大值 + 1");
  const ball = d.scene.objects[1];
  check(mm.addAnimLayer(d, ball, 0, "x") === 0 && ball.animationlayers[0].id === 14 && mm.addAnimLayer(d, ball, 1.5, "y") === null && ball.animationlayers.length === 1, "没有表的层新建表；片段 id 非整数拒绝");
  const v = mm.getAnimLayers(o);
  check(v.length === 2 && v[0].name === "走" && v[1].animation === 8 && v[0].id === 12 && json(v[0].wrapped) === "{}", "getAnimLayers：按表序读出，带下标与 id");
  check(mm.moveAnimLayer(o, 0, 1) && o.animationlayers[0].name === "动画 2" && !mm.moveAnimLayer(o, 1, 1) && !mm.moveAnimLayer(o, 0, -1), "moveAnimLayer：相邻交换；越界不动");
  check(mm.setAnimLayerField(o, 0, "blend", 0.25) && o.animationlayers[0].blend === 0.25 && !mm.setAnimLayerField(o, 0, "blend", 1.5) && !mm.setAnimLayerField(o, 0, "blend", NaN) && !mm.setAnimLayerField(o, 0, "rate", -1) && mm.setAnimLayerField(o, 0, "rate", 2) && o.animationlayers[0].rate === 2,
    "setAnimLayerField：blend ∈ [0,1]、rate ≥ 0，越界 / NaN 拒绝");
  check(!mm.setAnimLayerField(o, 0, "visible", 1) && mm.setAnimLayerField(o, 0, "visible", false) && o.animationlayers[0].visible === false && !mm.setAnimLayerField(o, 0, "animation", "7") && mm.setAnimLayerField(o, 0, "animation", 7) && !mm.setAnimLayerField(o, 5, "name", "x"),
    "布尔字段只收布尔、片段只收整数、下标越界拒绝");
  check(mm.animLayersHot(o), "无包装的表可热替换");
  const solo = mm.soloAnimLayers(o, 0);
  check(solo[0].visible === true && solo[0].blend === 0.25 && solo[1].blend === 0 && o.animationlayers[0].visible === false && o.animationlayers[1].blend === 1, "soloAnimLayers：目标层强制可见、其余 blend 0，返回副本、文档不动");
  check(mm.removeAnimLayer(o, 1) && o.animationlayers.length === 1 && mm.removeAnimLayer(o, 0) && o.animationlayers === undefined && !mm.removeAnimLayer(o, 0), "removeAnimLayer：删空后去掉 animationlayers 键（同没有动画层的存盘）");

  const wrapped = {
    animationlayers: [
      { animation: 1, name: "a", blend: { script: "export function update(v){return v;}", scriptproperties: { k: 1 }, value: 0.5 }, rate: { user: "speed", value: 1 }, visible: { script: "x", value: true }, additive: false },
      { animation: 2, name: "b", blend: { animation: { c0: [], options: { fps: 30, length: 10, mode: "loop" } }, value: 1 }, rate: 1, visible: true, additive: false },
    ],
  };
  const wv = mm.getAnimLayers(wrapped);
  check(json(wv[0].wrapped) === json({ blend: "script", rate: "user", visible: "script" }) && json(wv[1].wrapped) === json({ blend: "animation" }) && wv[0].blend === 0.5 && wv[0].rate === 1, "包装形态识别（script / user / animation），值取 value");
  check(!mm.animLayersHot(wrapped), "表里有任何包装就不热替换（引擎按下标挂脚本 / 曲线 / 绑定）");
  const keep = json(wrapped.animationlayers[0].blend.scriptproperties);
  mm.setAnimLayerField(wrapped, 0, "blend", 0.75);
  mm.setAnimLayerField(wrapped, 0, "rate", 3);
  mm.setAnimLayerField(wrapped, 1, "blend", 0.1);
  check(wrapped.animationlayers[0].blend.value === 0.75 && typeof wrapped.animationlayers[0].blend.script === "string" && json(wrapped.animationlayers[0].blend.scriptproperties) === keep && wrapped.animationlayers[0].rate.user === "speed" && wrapped.animationlayers[0].rate.value === 3 && wrapped.animationlayers[1].blend.value === 0.1 && wrapped.animationlayers[1].blend.animation.options.fps === 30,
    "包装字段只改 value：脚本 / scriptproperties / 用户属性绑定 / 曲线原样保留");

  let corpusLayers = 0;
  const corpusBad = [];
  for (const id of [...PUPPET_FIXTURES, ...MESH_FIXTURES]) {
    const t = modelTruth(LIB, id);
    if (!t) continue;
    for (const obj of t.scene.objects ?? []) {
      if (!Array.isArray(obj.animationlayers)) continue;
      const got = mm.getAnimLayers(obj);
      const ref = parseAnimationLayers(obj.animationlayers);
      corpusLayers += got.length;
      const same = got.length === ref.length && got.every((g, i) => {
        const r = ref[i];
        return g.animation === r.animation && g.name === r.name && g.additive === r.additive && (g.wrapped.blend || g.blend === r.blend) && (g.wrapped.rate || g.rate === r.rate) && (g.wrapped.visible || g.visible === r.visible);
      });
      if (!same) corpusBad.push(`${id}#${obj.id}`);
      const before = json(obj.animationlayers);
      const back = structuredClone(obj);
      got.forEach((g) => {
        for (const f of ["animation", "name", "blend", "rate", "visible", "additive"]) mm.setAnimLayerField(back, g.index, f, g[f]);
      });
      if (json(back.animationlayers) !== before) corpusBad.push(`${id}#${obj.id} 回写`);
    }
  }
  check(corpusLayers >= 5 && corpusBad.length === 0, `语料：${corpusLayers} 条动画层 getAnimLayers ≡ 引擎 parseAnimationLayers，原值回写逐字节不变（不符 ${json(corpusBad)}）`);

  const mainSrc = fs.readFileSync(path.join(ROOT, "editor/main.ts"), "utf8");
  check(/if \(hot && editor && \(hotAlways \|\| cmd\.after === cmd\.before\)\)/.test(mainSrc) && /const hot = !!editor && Number\.isFinite\(id\) && !!editor\.getModelInfo\(id\) && animLayersHot\(node\.obj\);/.test(mainSrc),
    "页面：动画层提交在无包装且模型已装上时走整表热替换，否则重挂");
  check(/\{ id: "anim-layers", order: 800, when: \(\) => true, render: animLayersGroup(?:, tab: "anim")? \}/.test(mainSrc) && /editor\s*\.setAnimationLayers\(/.test(mainSrc) && /animSolo = null;\s*const gen = \+\+openGen;/.test(mainSrc) && /if \(animSolo && animSolo\.id !== selectedId\) endAnimSolo\(\);/.test(mainSrc),
    "检视器「动画层」分组接在模型层上；单独预览在重挂 / 换选中时结束");
  const sm = fs.readFileSync(path.join(ROOT, "renderer/src/scene-mount.ts"), "utf8");
  check(/const next: any\[\] = scn\.parseAnimationLayers\(/.test(sm) && /setAnimationLayers: setAnimationLayersImpl/.test(sm) && /animationLayers: parseAnimationLayers\(o\.animationlayers\),/.test(fs.readFileSync(path.join(ROOT, "renderer/vendor/we-scene/scene/parse.js"), "utf8")),
    "引擎：setAnimationLayers 与装配共用 parseAnimationLayers（同一份解析）");
  const i18nSrc = fs.readFileSync(path.join(ROOT, "editor/i18n.ts"), "utf8");
  const keys = [...mainSrc.matchAll(/et\("((?:al|log\.animLayer|insp\.animLayers)[\w.]*)"/g)].map((m) => m[1]);
  const alKeys = [...new Set([...keys, "al.wrap.script", "al.wrap.user", "al.wrap.animation", "al.visible", "al.additive"])];
  const alMissing = alKeys.filter((k) => (i18nSrc.match(new RegExp(`"${k.replace(/\./g, "\\.")}":`, "g")) ?? []).length !== 2);
  check(alKeys.length >= 15 && alMissing.length === 0, `动画层文案中英文都有（${alKeys.length} 个键，缺 ${json(alMissing)}）`);
}

section("MD. 蒙皮网格拾取 / 轮廓 hittest.js + mdl-skin.skinnedMeshes（W15）");
{
  const HT = await imp("renderer/vendor/we-scene/render/hittest.js");
  const SK = await imp("renderer/vendor/we-scene/render/mdl-skin.js");
  const T = (x, y, z = 0) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
  const mdl1 = {
    bones: [{}, {}, {}],
    vertexCount: 3,
    positions: new Float32Array([1, 2, 7, 5, 5, 5, 0, 0, 3]),
    boneIdx: new Float32Array([0, 1, 0, 0, 2, 9, 0, 0, 0, 0, 0, 0]),
    weights: new Float32Array([0.25, 0.75, 0, 0, 0.5, 0.5, 0, 0, 0, 0, 0, 0]),
    indices: new Uint16Array([0, 1, 2]),
    indexCount: 3,
  };
  const skin = new Float32Array([...T(10, 0), ...T(0, 20), ...T(-4, 4)]);
  const [s1] = SK.skinnedMeshes(mdl1, skin, false);
  check(json([...s1.pos]) === json([1 + 2.5, 2 + 15, 0, 1, 9, 0, 0, 0, 0]),
    "skinnedMeshes：Σw·(skin·p)/Σw（同顶点着色器）；越界骨跳过且不计权；无有效权重留原位；2D 压平 z");
  const [s1z] = SK.skinnedMeshes(mdl1, skin, true);
  check(s1z.pos[2] === 7 && s1z.pos[5] === 5 && s1z.pos[8] === 3, "keepZ（透视场景）保留 z");
  const [s0] = SK.skinnedMeshes(mdl1, null, true);
  check(json([...s0.pos]) === json([...mdl1.positions]), "skin = null（绑定姿势早退）→ 原始位置");
  const multi = { bones: [], meshes: [{ ...mdl1 }, { ...mdl1, positions: new Float32Array(9) }], vertexCount: 6 };
  check(SK.skinnedMeshes(multi, null, false).length === 2 && SK.skinnedMeshes({ ...mdl1, meshes: [mdl1] }, null, false).length === 1,
    "多子网格逐个出；单子网格走顶层字段（同 mdl.js meshListOf 规则）");

  // 正交：网格 (x,y) → NDC (x/100, y/100) → CSS 200×100
  const ortho = [0.01, 0, 0, 0, 0, 0.01, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const quad = { pos: new Float32Array([-50, -50, 0, 50, -50, 0, 50, 50, 0, -50, 50, 0, 0, 0, 0]), indices: [0, 1, 2], vertexCount: 5, indexCount: 3 };
  const [pq] = HT.projectMeshesToScreen([quad], ortho, 200, 100);
  check(near(pq.xy[0], 50) && near(pq.xy[1], 75) && near(pq.xy[4], 150) && near(pq.xy[5], 25), "projectMeshesToScreen：NDC → CSS（y 翻向下）");
  const hull = HT.screenMeshesHull([pq]);
  check(hull.length === 3, `凸包只收被三角形引用的顶点（未引用的 #3/#4 不进，得 ${hull.length} 点）`);
  check(HT.screenMeshesContain([pq], 140, 40) && !HT.screenMeshesContain([pq], 60, 30) && HT.screenMeshesContain([pq], 150, 25), "三角形内命中、对角那半不命中、顶点上算命中");
  const square = { pos: new Float32Array([-50, -50, 0, 50, -50, 0, 50, 50, 0, -50, 50, 0, 0, 0, 0]), indices: [0, 1, 2, 0, 2, 3, 4, 4, 4], vertexCount: 5, indexCount: 9 };
  const [ps] = HT.projectMeshesToScreen([square], ortho, 200, 100);
  check(HT.screenMeshesHull([ps]).length === 4 && !HT.screenMeshesContain([{ ...ps, indices: [4, 4, 4], indexCount: 3 }], 100, 50),
    "方形凸包 4 点（内点不进）；零面积三角形不命中任何点");
  const ring = { pos: new Float32Array([-50, -50, 0, 50, -50, 0, 50, 50, 0, -50, 50, 0, -10, -10, 0, 10, -10, 0, 10, 10, 0]), indices: [0, 1, 4, 1, 5, 4, 1, 2, 5, 2, 6, 5], vertexCount: 7, indexCount: 12 };
  const [pr] = HT.projectMeshesToScreen([ring], ortho, 200, 100);
  const prHull = HT.screenMeshesHull([pr]);
  const inHull = (x, y) => prHull.every((a, i) => { const b = prHull[(i + 1) % prHull.length]; return (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]) <= 0; }) ||
    prHull.every((a, i) => { const b = prHull[(i + 1) % prHull.length]; return (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]) >= 0; });
  check(HT.screenMeshesContain([pr], 140, 50) && inHull(95, 54) && !HT.screenMeshesContain([pr], 95, 54), "凸包内、三角形外（凹处 / 镂空）不命中 —— 逐三角形精判");

  // 透视：相机在原点看 −z，near 1。一个三角形一角在相机身后
  const f = 1 / Math.tan(Math.PI / 4);
  const n0 = 1, f0 = 100;
  const persp = [f, 0, 0, 0, 0, f, 0, 0, 0, 0, (f0 + n0) / (n0 - f0), -1, 0, 0, (2 * f0 * n0) / (n0 - f0), 0];
  const ground = { pos: new Float32Array([-10, -1, -20, 10, -1, -20, 0, -1, 5]), indices: [0, 1, 2], vertexCount: 3, indexCount: 3 };
  const [pg] = HT.projectMeshesToScreen([ground], persp, 400, 400);
  check(pg.ok[0] === 1 && pg.ok[1] === 1 && pg.ok[2] === 0, "相机身后的顶点不进可见集");
  const gh = HT.screenMeshesHull([pg]);
  // 近处地面（z ≈ −1.5，屏幕下半部靠中间）：GPU 会画出裁剪后的那部分
  check(HT.screenMeshesContain([pg], 200, 340) && gh && gh.length >= 3 && Math.max(...gh.map((p) => p[1])) > 340,
    "跨近裁剪面的三角形按 GPU 裁剪后参与命中与凸包（铺到相机身后的地面近处点得中）");
  check(!HT.screenMeshesContain([pg], 200, 100), "地平线以上不命中");

  // 大网格（导入的高模）：命中走屏幕网格索引、凸包先八边形剔点；判定须与逐个扫描 / 全量凸包完全相同
  {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const T = 20000;
    const pos = new Float32Array(T * 9);
    for (let t = 0; t < T; t++) {
      const cx = (rnd() - 0.5) * 30, cy = (rnd() - 0.5) * 30, cz = -2 - rnd() * 40;
      for (let k = 0; k < 3; k++) {
        pos[t * 9 + k * 3] = cx + (rnd() - 0.5) * 3;
        pos[t * 9 + k * 3 + 1] = cy + (rnd() - 0.5) * 3;
        pos[t * 9 + k * 3 + 2] = t % 97 === 0 ? (k === 0 ? 3 : cz) : cz + (rnd() - 0.5) * 3;
      }
    }
    const big = { pos, indices: Uint32Array.from({ length: T * 3 }, (_, i) => i), vertexCount: T * 3, indexCount: T * 3 };
    const [pb] = HT.projectMeshesToScreen([big], persp, 400, 400);
    const chunks = [];
    for (let s = 0; s < T * 3; s += 9000) chunks.push({ ...pb, indices: pb.indices.subarray(s, s + 9000), indexCount: Math.min(9000, T * 3 - s) });
    const bh = HT.screenMeshesHull([pb]);
    let diff = 0, hits = 0;
    for (let i = 0; i < 3000; i++) {
      const x = rnd() * 440 - 20, y = rnd() * 440 - 20;
      const a = HT.screenMeshesContain([pb], x, y, bh);
      const b = HT.screenMeshesContain(chunks, x, y, bh);
      if (a !== b) diff++;
      if (a) hits++;
    }
    const naive = (() => {
      const pts = [];
      for (let i = 0; i < pb.ok.length; i++) if (pb.ok[i]) pts.push([pb.xy[i * 2], pb.xy[i * 2 + 1]]);
      for (let t = 0; t < T; t++) {
        const [i0, i1, i2] = [t * 3, t * 3 + 1, t * 3 + 2];
        if (pb.ok[i0] && pb.ok[i1] && pb.ok[i2]) continue;
        const d = [i0, i1, i2].map((i) => pb.clip[i * 4 + 2] + pb.clip[i * 4 + 3] >= 0);
        if (!d.some(Boolean)) continue;
        const C = pb.clip;
        const vs = [i0, i1, i2];
        for (let k = 0; k < 3; k++) {
          const a = vs[k], b = vs[(k + 1) % 3];
          const da = C[a * 4 + 2] + C[a * 4 + 3], db = C[b * 4 + 2] + C[b * 4 + 3];
          if ((da >= 0) !== (db >= 0)) {
            const s = da / (da - db);
            const X = C[a * 4] + s * (C[b * 4] - C[a * 4]), Y = C[a * 4 + 1] + s * (C[b * 4 + 1] - C[a * 4 + 1]), W = C[a * 4 + 3] + s * (C[b * 4 + 3] - C[a * 4 + 3]);
            if (W > 1e-9) pts.push([((X / W + 1) / 2) * 400, ((1 - Y / W) / 2) * 400]);
          }
        }
      }
      pts.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
      const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
      const lo = [], up = [];
      for (const p of pts) { while (lo.length >= 2 && cr(lo.at(-2), lo.at(-1), p) <= 0) lo.pop(); lo.push(p); }
      for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cr(up.at(-2), up.at(-1), p) <= 0) up.pop(); up.push(p); }
      return lo.slice(0, -1).concat(up.slice(0, -1));
    })();
    const key = (h) => json(h.map((p) => p.map((v) => v.toFixed(6))).sort());
    check(diff === 0 && hits > 100 && hits < 2900 && pb.ok.some((v) => !v) && key(bh) === key(naive),
      `大网格（${T} 个三角形，含跨近裁剪面）：网格索引命中 ≡ 逐个扫描（3000 点不一致 ${diff}，命中 ${hits}）、八边形剔点后的凸包 ≡ 全量凸包（${bh.length} / ${naive.length} 点）`);
  }

  const L = (id, x) => ({ id, origin: [x, 100, 0], size: [100, 100], scale: [1, 1, 1], angles: [0, 0, 0], visible: true });
  const layers = [L(1, 100), L(2, 150), L(3, 500)];
  const all = (opts) => HT.hitTestLayersAll(layers, 140, 100, 200, opts).map((l) => l.id).join(",");
  check(all({}) === "2,1", "不传 meshHit：OBB 结果不变（播放路径）");
  check(all({ meshHit: (l) => (l.id === 2 ? false : undefined) }) === "1" && all({ meshHit: (l) => (l.id === 3 ? true : undefined) }) === "3,2,1",
    "meshHit：false 否决 OBB、true 直接命中（网格可伸出图层矩形）、undefined 落回 OBB");

  const sm = fs.readFileSync(path.join(ROOT, "renderer/src/scene-mount.ts"), "utf8");
  const rj = fs.readFileSync(path.join(ROOT, "renderer/vendor/we-scene/render/renderer.js"), "utf8");
  check((sm.match(/meshHit:/g) ?? []).length === 1 && /hitTestAt\(x: number, y: number, opts = \{\}\) \{[\s\S]{0,900}meshHit: \(l: any\) => \{/.test(sm),
    "引擎：meshHit 只接在编辑器 hitTestAt（脚本光标 / 点击派发的 hit-test 不变）");
  check(/lastFrameMats = \{ cam, viewProj, viewProjPersp \}/.test(rj) && /getModelMvp: function \(layer\) \{[\s\S]{0,300}mat4Multiply\(vp, puppetModelMatrix\(layer, f\.cam\)\)/.test(rj),
    "渲染器：getModelMvp = 上一帧 viewProj（perspective 层换透视 VP）· puppetModelMatrix，与 drawPuppetDirect 同一套");
  check(/mdl\.skinnedMeshes\(m, skin, ev\.perspective\)/.test(sm) && /hull = g\?\.hull && g\.hull\.length >= 3/.test(sm), "getLayerOutline / hitTestAt 共用 modelScreenMesh（同一份投影）");
  const mainSrc = fs.readFileSync(path.join(ROOT, "editor/main.ts"), "utf8");
  check(/if \(outline\.hull\) strokePoly\(outline\.hull/.test(mainSrc) && /const c = o\?\.hull \?\? o\?\.corners;/.test(mainSrc), "页面：选中 / 多选轮廓优先画网格凸包");
}

section("ME. 子网格贴图替换 editor/model.ts + api retargetMdlMaterial（W16）");
{
  const mm = await loadEditorModule("model");
  const P = await imp("renderer/vendor/we-scene/render/mdl-parse.js");
  const { modelTruth, PUPPET_FIXTURES, MESH_FIXTURES } = await imp("scripts/verify-editor-model.mjs");
  const img = { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2]), ext: "png" };
  const mat = { passes: [{ shader: "genericimage4", blending: "translucent", combos: { LIGHTING: 1 }, constantshadervalues: { alpha: 0.5 }, textures: ["chars/a", "masks/m", null] }], extra: 1 };
  const matSnap = json(mat);
  const rm = mm.retexturedMaterial(mat, "k");
  check(json(rm) === json({ ...mat, passes: [{ ...mat.passes[0], textures: ["editor/k", "masks/m", null] }] }) && json(mat) === matSnap,
    "retexturedMaterial：只换槽 0 为 editor/<slug>，shader / combos / 常量 / 其余槽原样；原材质对象不动");
  check(json(mm.retexturedMaterial({ passes: [{ shader: "x" }] }, "k").passes[0].textures) === json(["editor/k"]) && mm.retexturedMaterial({ passes: [] }, "k") === null && mm.retexturedMaterial({}, "k") === null,
    "没有 textures 补一个；没有 pass 拒绝（null）");
  check(json(mm.parseJsonBytes(enc.encode('\uFEFF{"a":1}'))) === json({ a: 1 }) && mm.parseJsonBytes(enc.encode("[1]")) === null && mm.parseJsonBytes(enc.encode("{x")) === null && mm.parseJsonBytes(null) === null,
    "parseJsonBytes：容 BOM；数组 / 坏 json / 缺文件都给 null");

  const modelJson = { material: "materials/chars/a.json", puppet: "models/a_puppet.mdl", autosize: true, cropoffset: "1 2", width: 640 };
  const pr = mm.puppetRetexture(modelJson, mat, "k", img);
  const prFiles = new Map(pr.files.map((f) => [f.name, f.data]));
  check(pr.path === "models/editor/k.json" && json([...prFiles.keys()]) === json(["models/editor/k.json", "materials/editor/k.json", "materials/editor/k.png"]),
    "puppet：三件落在 */editor/<slug>.*，对象改指向新 model json");
  const prModel = JSON.parse(dec.decode(prFiles.get("models/editor/k.json")));
  check(json(prModel) === json({ ...modelJson, material: "materials/editor/k.json" }), "model json 副本：puppet / autosize / cropoffset 等原样，只有 material 改指向材质副本");
  check(JSON.parse(dec.decode(prFiles.get("materials/editor/k.json"))).passes[0].textures[0] === "editor/k" && prFiles.get("materials/editor/k.png") === img.bytes,
    "材质副本槽 0 = editor/<slug>（引擎缺 .tex 回退同名 png，pkg 导出再转 .tex）；源图原字节");
  check(mm.puppetRetexture({ material: "m.json" }, mat, "k", img) === null && mm.puppetRetexture(modelJson, { passes: [] }, "k", img) === null, "不是 puppet 的 model json / 材质无 pass 拒绝");

  const slotInfo = { form: "mesh", meshes: [{ materialPath: "materials/a.json", vertexCount: 3, texture: "a" }, { materialPath: "materials/b.json", vertexCount: 3, texture: null }] };
  check(json(mm.modelTextureSlots(slotInfo)) === json([{ index: 0, materialPath: "materials/a.json", texture: "a" }, { index: 1, materialPath: "materials/b.json", texture: null }]) &&
    json(mm.modelTextureSlots({ ...slotInfo, form: "puppet" })) === json([{ index: 0, materialPath: null, texture: "a" }]),
    "modelTextureSlots：mesh 每个子网格一行；puppet 整层一张（材质以 model json 为准，不取 .mdl 头）");

  // 语料：每个模型 .mdl 的每个子网格改指向，parseMDL 读回只有该子网格材质变、几何 / 骨骼 / 动画逐项不变
  const seen = new Set();
  let meshesOk = 0;
  let multiOk = 0;
  const bad = [];
  const geo = (m) => (m.meshes && m.meshes.length ? m.meshes : [m]).map((x) => [x.vertexCount, x.indexCount, Buffer.from(x.positions.buffer, x.positions.byteOffset, x.positions.byteLength).toString("base64"), Buffer.from(x.indices.buffer, x.indices.byteOffset, x.indices.byteLength).toString("base64")]);
  const rig = (m) => json([m.bones.map((b) => [b.name, b.parent]), m.animations.map((a) => [a.id, a.name, a.frameCount]), (m.attachments || []).map((a) => a.name)]);
  const mats = (m) => (m.meshes && m.meshes.length ? m.meshes : [m]).map((x) => x.materialPath ?? null);
  for (const id of [...PUPPET_FIXTURES, ...MESH_FIXTURES]) {
    const t = modelTruth(LIB, id);
    if (!t) continue;
    for (const o of t.objects) {
      const key = `${id}:${o.info.mdlPath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const bytes = t.read(o.info.mdlPath);
      const before = P.parseMDL(bytes);
      const listed = mm.meshMaterialPath(bytes, 0);
      if (listed !== mats(before)[0]) bad.push(`${key} 读 #0 ${listed}`);
      const n = mats(before).length;
      for (let i = 0; i < n; i++) {
        const r = mm.meshRetexture(bytes, i, mat, "t", img);
        if (!r) {
          bad.push(`${key}#${i} null`);
          continue;
        }
        const after = P.parseMDL(r.files[0].data);
        const want = mats(before).map((p, k) => (k === i ? "materials/editor/t.json" : p));
        if (r.path !== "models/editor/t.mdl" || json(mats(after)) !== json(want) || json(geo(after)) !== json(geo(before)) || rig(after) !== rig(before)) bad.push(`${key}#${i}`);
        else meshesOk++;
      }
      if (n > 1) multiOk++;
      if (mm.meshRetexture(bytes, n, mat, "t", img) !== null) bad.push(`${key} 越界未拒`);
    }
  }
  check(meshesOk >= 10 && multiOk >= 1 && bad.length === 0, `语料：${seen.size} 个 .mdl、${meshesOk} 个子网格逐个改指向，parseMDL 读回只有该子网格材质变（多子网格 ${multiOk} 个；越界拒绝；不符 ${json(bad.slice(0, 5))}）`);
  check(mm.meshRetexture(new Uint8Array([0x4d, 0x44, 0x4c, 0x56, 0x30, 0x30, 0x32, 0x33, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), 0, mat, "t", img) === null && mm.meshMaterialPath(enc.encode("nope"), 0) === null,
    "网格表读不通 / 不是 MDL：拒绝，不抛");

  // 资源表多拥有者：第二次换图时旧副本带来的材质 / 源图也要随新副本进保存清单
  const refs = new Set();
  const ov = assetsMod.overlayAssets("scene.json", null, () => refs);
  ov.put("materials/editor/a.json", enc.encode("a"), "models/editor/a.mdl");
  ov.put("models/editor/a.mdl", enc.encode("m"), "models/editor/a.mdl");
  ov.share("models/editor/a.mdl", "models/editor/b.mdl");
  ov.share("models/editor/a.mdl", "models/editor/b.mdl");
  refs.add("models/editor/b.mdl");
  check(ov.list().includes("materials/editor/a.json") && json(ov.added().find((f) => f.name === "materials/editor/a.json").group) === json(["models/editor/a.mdl", "models/editor/b.mdl"]),
    "share：新副本成为旧副本名下文件的共同拥有者（重复 share 不重复记）");
  refs.clear();
  check(!ov.list().length, "两个拥有者都不被引用时都不进保存清单（撤销后不残留）");
  const dd = draftMod.makeDraft(docMod.makeDoc("d", null, { objects: [] }, "loose"), { kind: "new" }, "scene.json", ov.added());
  check(draftMod.parseDraft(structuredClone(dd)) !== null && draftMod.parseDraft({ ...dd, files: [{ name: "x", data: new Uint8Array(1), group: ["a", 3] }] }) === null,
    "草稿收多拥有者 group（字符串数组），数组里混非字符串仍拒");

  const mainSrc = fs.readFileSync(path.join(ROOT, "editor/main.ts"), "utf8");
  check(/for \(const f of res\.files\) assets\.put\(f\.name, f\.data, res\.path\);\s*assets\.share\(from, res\.path\);/.test(mainSrc),
    "页面：新文件分组 = 新副本路径，并继承旧副本名下文件");
  check(/if \(puppet\) d\.puppets = new Map\(\[\.\.\.\(d\.puppets \?\? \[\]\), \[res\.path, puppet\]\]\);\s*structEdit\(/.test(mainSrc) && /if \(puppet\) n\.obj\.image = res\.path;\s*else n\.obj\.model = res\.path;/.test(mainSrc),
    "页面：改指向走结构编辑（可撤销、重挂）；puppet 副本先登记进 doc.puppets，重建树仍认得是模型层");
  check(/\{ id: "model-tex", order: 1000, when: \(\) => true, render: modelTexGroup(?:, tab: "model")? \}/.test(mainSrc) && /function modelTexGroup\(node: LayerNode\)[\s\S]{0,200}editor\.getModelInfo\(id\)[\s\S]{0,900}modelTextureSlots\(info\)/.test(mainSrc), "检视器：模型层有「子网格贴图」分组，行来自 getModelInfo");
  const i18nSrc = fs.readFileSync(path.join(ROOT, "editor/i18n.ts"), "utf8");
  const keys = ["insp.modelTex", "mt.note", "mt.replace", "mt.noTexture", "mt.fail.read", "mt.fail.material", "mt.fail.mdl", "log.modelTexReplaced"];
  const missing = keys.filter((k) => (i18nSrc.match(new RegExp(`"${k.replace(/\./g, "\\.")}":`, "g")) ?? []).length !== 2);
  check(missing.length === 0, `子网格贴图文案中英文都有（缺 ${json(missing)}）`);
  check(/id="in-model-tex" accept="image\/\*"/.test(fs.readFileSync(path.join(ROOT, "editor/index.html"), "utf8")), "页面有隐藏的图片选择框");
}

/** renderer 侧 ts 模块直接打包（mdl-edit 这类纯函数，不经页面别名） */
async function loadRendererTs(rel, overrides = {}) {
  const out = await build({
    entryPoints: [path.join(ROOT, rel)],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    logLevel: "silent",
    plugins: Object.keys(overrides).length
      ? [{ name: "mutate", setup: (b) => b.onLoad({ filter: /\.ts$/ }, (a) => (overrides[a.path] !== undefined ? { contents: overrides[a.path], loader: "ts" } : undefined)) }]
      : [],
  });
  const tmp = path.join(tmpRoot, `r-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(tmp, out.outputFiles[0].text);
  return import(pathToFileURL(tmp).href);
}

/** MF 语料判据（J 段变异复用）：每个带动画的 .mdl 在首个片段某骨某帧叠增量，parseMDL 读回逐帧对账 */
async function boneEditCorpus(me, P, modelTruth, ids) {
  const seen = new Set();
  let ok = 0;
  let loops = 0;
  const bad = [];
  const f32 = (v) => Math.fround(v);
  const rig = (m) => json([m.bones.map((b) => [b.name, b.parent]), (m.meshes && m.meshes.length ? m.meshes : [m]).map((x) => [x.vertexCount, x.indexCount])]);
  for (const id of ids) {
    const t = modelTruth(LIB, id);
    if (!t) continue;
    for (const o of t.objects) {
      const key = `${id}:${o.info.mdlPath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const bytes = t.read(o.info.mdlPath);
      const before = P.parseMDL(bytes);
      const a = before.animations.find((x) => x.tracks.some((tr) => tr.frameCount > 2));
      if (!a) continue;
      const clips = me.mdlClips(bytes);
      const c = clips?.find((x) => x.id === a.id);
      const frames = Math.max(...a.tracks.map((tr) => tr.frameCount));
      if (!c || c.frames !== frames || c.name !== a.name || c.mode !== a.mode || clips.length !== before.animations.length) {
        bad.push(`${key} clips`);
        continue;
      }
      const bone = a.tracks.findLastIndex((tr) => tr.frameCount === frames);
      const frame = Math.floor(frames / 2);
      const delta = { t: [3, -2, 0], r: [0, 0, 0.5], s: [1.25, 0.8, 1] };
      const out = me.applyBoneDelta(bytes, a.id, bone, frame, delta, 3);
      if (!out) {
        bad.push(`${key} null`);
        continue;
      }
      const after = P.parseMDL(out);
      const aa = after.animations.find((x) => x.id === a.id);
      const loop = a.mode === "loop";
      const w = me.boneDeltaWeights(frames, frame, 3, loop);
      const k0 = a.tracks[bone].keyframes;
      const k1 = aa.tracks[bone].keyframes;
      const closed = loop && [0, 1, 2, 3, 4, 5, 6, 7, 8].every((q) => k0[q] === k0[(frames - 1) * 9 + q]);
      let trackOk = k1.length === k0.length;
      for (let f = 0; f < frames && trackOk; f++) {
        for (let q = 0; q < 9; q++) {
          const v0 = k0[f * 9 + q];
          const want = q < 3 ? f32(v0 + w[f] * delta.t[q]) : q < 6 ? f32(v0 + w[f] * delta.r[q - 3]) : f32(v0 * (1 + w[f] * (delta.s[q - 6] - 1)));
          const got = closed && f === frames - 1 ? k1[q] : k1[f * 9 + q];
          if (!(Math.abs(got - (closed && f === frames - 1 ? k1[q] : want)) <= 1e-5 * Math.max(1, Math.abs(want)))) trackOk = false;
        }
      }
      if (closed && [0, 1, 2, 3, 4, 5, 6, 7, 8].some((q) => k1[q] !== k1[(frames - 1) * 9 + q])) trackOk = false;
      const othersSame = a.tracks.every((tr, i) => i === bone || Buffer.compare(Buffer.from(tr.keyframes.buffer, tr.keyframes.byteOffset, tr.keyframes.byteLength), Buffer.from(aa.tracks[i].keyframes.buffer, aa.tracks[i].keyframes.byteOffset, aa.tracks[i].keyframes.byteLength)) === 0);
      const clipsSame = before.animations.every((x) => {
        if (x.id === a.id) return true;
        const y = after.animations.find((z) => z.id === x.id);
        return y && x.tracks.every((tr, i) => json([...tr.keyframes]) === json([...y.tracks[i].keyframes]));
      });
      const far = w.findIndex((v) => v === 0);
      const untouched = far < 0 || json([...k0.subarray(far * 9, far * 9 + 9)]) === json([...k1.subarray(far * 9, far * 9 + 9)]);
      if (!trackOk || !othersSame || !clipsSame || !untouched || rig(after) !== rig(before)) bad.push(`${key} ${json({ trackOk, othersSame, clipsSame, untouched })}`);
      else {
        ok++;
        if (closed) loops++;
      }
      if (me.applyBoneDelta(bytes, a.id, a.tracks.length, 0, delta, 0) !== null || me.applyBoneDelta(bytes, a.id, bone, frames, delta, 0) !== null || me.applyBoneDelta(bytes, -12345, bone, 0, delta, 0) !== null || me.applyBoneDelta(bytes, a.id, bone, 1.5, delta, 0) !== null)
        bad.push(`${key} 越界未拒`);
    }
  }
  return { ok, loops, bad, seen: seen.size };
}

section("MF. 骨骼姿势 / 片段关键帧 editor/model.ts + api applyBoneDelta（W18a）");
{
  const mm = await loadEditorModule("model");
  const me = await loadRendererTs("renderer/src/editor/mdl-edit.ts");
  const P = await imp("renderer/vendor/we-scene/render/mdl-parse.js");
  const { modelTruth, PUPPET_FIXTURES, MESH_FIXTURES } = await imp("scripts/verify-editor-model.mjs");
  const W = (...a) => [...me.boneDeltaWeights(...a)].map((v) => Math.round(v * 1e6) / 1e6);
  check(json(W(6, 2, 0, false)) === json([0, 0, 1, 0, 0, 0]) && json(W(4, 1, -1, false)) === json([1, 1, 1, 1]), "权重：半径 0 只有该帧；−1 整段 1");
  const w3 = W(11, 5, 3, false);
  check(w3[5] === 1 && w3[4] === w3[6] && w3[3] === w3[7] && w3[2] === w3[8] && w3[4] > w3[3] && w3[3] > w3[2] && w3[2] > 0 && w3[1] === 0 && w3[9] === 0,
    `权重：余弦衰减左右对称、单调、距离 > 半径为 0（${json(w3)}）`);
  const wl = W(11, 0, 2, true);
  check(wl[0] === 1 && wl[10] === 1 && wl[9] === wl[1] && wl[8] === wl[2] && wl[3] === 0 && wl[7] === 0,
    `loop 权重按周期 frames−1 环绕：首帧 = 末帧，跨首尾对称（${json(wl)}）`);
  const wm = W(11, 0, 2, false);
  check(wm[10] === 0 && wm[9] === 0, "非 loop 不环绕");

  const L = { mode: "loop", fps: 10, frames: 11 };
  check(mm.clipFrameAt(L, 0) === 0 && mm.clipFrameAt(L, 0.31) === 3 && mm.clipFrameAt(L, 1.0) === 0 && mm.clipFrameAt(L, 1.32) === 3 && mm.clipFrameAt(L, 0.98) === 0 && mm.clipFrameAt(L, -0.1) === 9,
    "clipFrameAt loop：周期 frames−1 环绕，四舍五入到末帧时回到 0，负时刻反向环绕");
  const M = { mode: "mirror", fps: 10, frames: 11 };
  check(mm.clipFrameAt(M, 0.4) === 4 && mm.clipFrameAt(M, 1.0) === 10 && mm.clipFrameAt(M, 1.3) === 7 && mm.clipFrameAt(M, 2.0) === 0, "clipFrameAt mirror：正放到末帧再倒放，周期 2(frames−1)");
  const S = { mode: "single", fps: 10, frames: 11 };
  check(mm.clipFrameAt(S, -1) === 0 && mm.clipFrameAt(S, 0.44) === 4 && mm.clipFrameAt(S, 5) === 10 && mm.clipFrameAt({ ...S, frames: 1 }, 3) === 0, "clipFrameAt single：钳在 0..frames−1");
  check(json(mm.boneDepths([{ parent: -1 }, { parent: 0 }, { parent: 1 }, { parent: 0 }, { parent: 9 }, { parent: 5 }])) === json([0, 1, 2, 1, 0, 0]), "boneDepths：父链深度；父号越界 / 指向自己按根");
  const layers = [{ animation: 7, visible: false }, { animation: 3, visible: true }, { animation: 99, visible: true }];
  check(mm.defaultClipId([{ id: 1 }, { id: 3 }, { id: 7 }], layers) === 3 && mm.defaultClipId([{ id: 1 }], layers) === 1 && mm.defaultClipId([], []) === null, "默认片段：第一条可见且存在的动画层；没有就第一个片段");
  check(mm.isZeroDelta({}) && mm.isZeroDelta({ t: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] }) && !mm.isZeroDelta({ r: [0, 0, 0.1] }) && !mm.isZeroDelta({ s: [1, 1, 2] }), "isZeroDelta：缺省 / 全零平移旋转 / 全 1 缩放 = 没改");

  const ids = [...PUPPET_FIXTURES, ...MESH_FIXTURES];
  const res = await boneEditCorpus(me, P, modelTruth, ids);
  check(res.ok >= 5 && res.loops >= 1 && res.bad.length === 0,
    `语料：${res.seen} 个 .mdl、${res.ok} 个片段叠增量，目标轨道逐帧 = 原值 + 权重 × 增量（缩放相乘），其余轨道 / 片段 / 远帧 / 网格骨骼逐字节不变，loop 首末重合保持（${res.loops} 个）；越界拒绝（不符 ${json(res.bad.slice(0, 4))}）`);

  const t0 = modelTruth(LIB, PUPPET_FIXTURES[0]);
  const pupObj = t0?.objects.find((o) => o.info.form === "puppet" && P.parseMDL(t0.read(o.info.mdlPath)).animations.length);
  const pupBytes = pupObj && t0.read(pupObj.info.mdlPath);
  const a0 = pupBytes && P.parseMDL(pupBytes).animations[0];
  const edit = a0 && { animId: a0.id, bone: 0, frame: 0, delta: { r: [0, 0, 0.3] }, radius: -1 };
  const mj = { material: "materials/a.json", puppet: "models/a_puppet.mdl", autosize: true };
  const pf = edit && mm.boneEditFiles(mj, pupBytes, "p", edit);
  check(!!pf && pf.path === "models/editor/p.json" && json(pf.files.map((f) => f.name)) === json(["models/editor/p.json", "models/editor/p.mdl"]) &&
    json(JSON.parse(dec.decode(pf.files[0].data))) === json({ ...mj, puppet: "models/editor/p.mdl" }),
    "puppet 副本：model json（只改 puppet 指向）+ .mdl 落在 models/editor/<slug>.*，对象改指向新 json");
  const mf = edit && mm.boneEditFiles(null, pupBytes, "m", edit);
  check(!!mf && mf.path === "models/editor/m.mdl" && mf.files.length === 1 && P.parseMDL(mf.files[0].data).animations[0].tracks[0].keyframes[5] !== a0.tracks[0].keyframes[5],
    "mesh 副本：只有 .mdl，轨道已改");
  check(edit && mm.boneEditFiles({ material: "m.json" }, pupBytes, "x", edit) === null && mm.boneEditFiles(null, pupBytes, "x", { ...edit, animId: -9 }) === null && me.mdlClips(enc.encode("nope")) === null,
    "不是 puppet 的 model json / 片段不存在 / 不是 MDL：拒绝，不抛");

  const mainSrc = fs.readFileSync(path.join(ROOT, "editor/main.ts"), "utf8");
  check(/\{ id: "bones", order: 1100, when: \(\) => true, render: boneGroup(?:, tab: "model")? \}/.test(mainSrc) && /function boneGroup\(node: LayerNode\)[\s\S]{0,300}editor\.getModelInfo\(id\)/.test(mainSrc), "检视器：模型层有「骨骼」分组，骨骼 / 片段来自 getModelInfo");
  check(/\.setBonePose\(id, pick\.bone, dirty\(\) \? boneDeltaOf\(pick\) : null\)/.test(mainSrc) && /inp\.addEventListener\("input", \(\) => \{[\s\S]{0,160}preview\(\);/.test(mainSrc),
    "输入即推引擎预览（setBonePose，文档不动）");
  check(/const r = out && mdlCopyFiles\(modelJson, out, slug\);[\s\S]{0,200}for \(const f of r\.files\) assets\.put\(f\.name, f\.data, r\.path\);\s*assets\.share\(from, r\.path\);/.test(mainSrc) &&
    /if \(puppetMdl\) d\.puppets = new Map\(\[\.\.\.\(d\.puppets \?\? \[\]\), \[r\.path, puppetMdl\]\]\);/.test(mainSrc) && /if \(puppetMdl\) n\.obj\.image = r\.path;\s*else n\.obj\.model = r\.path;\s*mutate\?\.\(n\.obj\);/.test(mainSrc) &&
    /function applyBoneEdit\([\s\S]{0,400}commitMdlEdit\([\s\S]{0,200}applyBoneDelta\(bytes, e\.animId, e\.bone, e\.frame, e\.delta, e\.radius\)/.test(mainSrc),
    "应用：commitMdlEdit 写时复制 + 继承旧副本文件 + puppet 登记 + 结构编辑改指向（可撤销、重挂）");
  check(/function drawBoneMarkers\(\)[\s\S]{0,300}editor\.getBonePoints\(/.test(mainSrc) && /drawAttachMarkers\(\);\s*drawBoneMarkers\(\);/.test(mainSrc), "视口：骨骼关节 / 父子连线来自 getBonePoints");
  check(/if \(g\.id === "bones"\) bonesShown = true;\s*\}\s*if \(!bonesShown\) dropBonePick\(\);/.test(mainSrc) && /if \(!node\) \{\s*dropBonePick\(\);/.test(mainSrc), "离开模型层撤掉骨骼预览");
  const i18nSrc = fs.readFileSync(path.join(ROOT, "editor/i18n.ts"), "utf8");
  const keys = ["insp.bones", "bn.note", "bn.noClips", "bn.clip", "bn.bone", "bn.frame", "bn.frameNow", "bn.t", "bn.r", "bn.s", "bn.radius", "bn.radius.one", "bn.radius.n", "bn.radius.all", "bn.apply", "bn.reset", "bn.fail.read", "bn.fail.mdl", "log.boneEdited"];
  const missing = keys.filter((k) => (i18nSrc.match(new RegExp(`"${k.replace(/\./g, "\\.")}":`, "g")) ?? []).length !== 2);
  check(missing.length === 0, `骨骼文案中英文都有（缺 ${json(missing)}）`);
  const skin = fs.readFileSync(path.join(ROOT, "renderer/vendor/we-scene/render/mdl-skin.js"), "utf8");
  check(/identityEarlyOut = !hasOverride && !useStaticPose && !editPose/.test(skin) && /const ed = editPose \? editPose\.get\(i\) : undefined/.test(skin), "引擎：预览增量在动画混合之后、脚本覆写之前叠加；有预览时不走恒等早退");
}

/** MG 语料判据（J 段变异复用）：每个带可编辑动画段的 .mdl 做加 / 复制 / 删 / 改头 / 改事件，parseMDL 读回逐项对账 */
async function clipEditCorpus(me, P, modelTruth, ids) {
  const seen = new Set();
  const bad = [];
  let ok = 0;
  let removed = 0;
  let noMdla = 0;
  const kf = (tr) => Buffer.from(tr.keyframes.buffer, tr.keyframes.byteOffset, tr.keyframes.byteLength).toString("base64");
  const clipSig = (a) => json([a.id, a.name, a.mode, a.fps, a.frameCount, a.tracks.map(kf), a.events]);
  const rig = (m) => json([m.bones.map((b) => [b.name, b.parent]), (m.meshes && m.meshes.length ? m.meshes : [m]).map((x) => [x.vertexCount, x.indexCount]), (m.attachments || []).map((a) => a.name)]);
  for (const id of ids) {
    const t = modelTruth(LIB, id);
    if (!t) continue;
    for (const o of t.objects) {
      const key = `${id}:${o.info.mdlPath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const bytes = t.read(o.info.mdlPath);
      const before = P.parseMDL(bytes);
      const clips = me.mdlClips(bytes);
      if (!before.animations.length) {
        if (clips && me.addMdlClip(bytes, { name: "x", mode: "loop", fps: 30, frameCount: 10 }) !== null) bad.push(`${key} 无 MDLA 未拒`);
        else noMdla++;
        continue;
      }
      const errs = [];
      const src = before.animations[0];
      // 新建（静止姿势）
      const init = { name: "新片段", mode: "mirror", fps: 24, frameCount: 12 };
      const add = me.addMdlClip(bytes, init, "rest");
      const A = add && P.parseMDL(add.bytes);
      const na = A?.animations.at(-1);
      if (!na || A.animations.length !== before.animations.length + 1 || na.id !== Math.max(...before.animations.map((a) => a.id)) + 1 || add.id !== na.id) errs.push("add 结构");
      else {
        if (na.name !== init.name || na.mode !== init.mode || Math.abs(na.fps - 24) > 1e-6 || na.frameCount !== 12 || na.tracks.length !== src.tracks.length) errs.push("add 头");
        if (!na.tracks.every((tr, i) => tr.frameCount === 13 && [...Array(13).keys()].every((f) => [...Array(9).keys()].every((c) => tr.keyframes[f * 9 + c] === src.tracks[i].keyframes[c])))) errs.push("add 静止姿势");
        if (!before.animations.every((a, i) => clipSig(a) === clipSig(A.animations[i]))) errs.push("add 改了旧片段");
        if (rig(A) !== rig(before)) errs.push("add 改了网格骨骼");
        const mc = me.mdlClips(add.bytes);
        if (!mc || mc.at(-1).id !== na.id || mc.at(-1).frames !== 13) errs.push("add mdlClips");
      }
      // 复制（帧数翻倍重采样）
      const fc2 = src.frameCount * 2;
      const dup = me.addMdlClip(bytes, { name: "dup", mode: src.mode, fps: src.fps, frameCount: fc2 }, "copy", src.id);
      const D = dup && P.parseMDL(dup.bytes).animations.at(-1);
      if (!D || !D.tracks.every((tr, i) => {
        const s = src.tracks[i];
        const n = s.frameCount;
        if (!n) return tr.frameCount === 0 || true;
        const m = tr.frameCount;
        return m === fc2 + 1 && [...Array(9).keys()].every((c) => tr.keyframes[c] === s.keyframes[c] && Math.abs(tr.keyframes[(m - 1) * 9 + c] - s.keyframes[(n - 1) * 9 + c]) <= 1e-5 * Math.max(1, Math.abs(s.keyframes[(n - 1) * 9 + c])));
      })) errs.push("copy 重采样首末帧");
      const same = me.addMdlClip(bytes, { name: "same", mode: src.mode, fps: src.fps, frameCount: src.frameCount }, "copy", src.id);
      const S2 = same && P.parseMDL(same.bytes).animations.at(-1);
      if (!S2 || !S2.tracks.every((tr, i) => src.tracks[i].frameCount !== src.frameCount + 1 || kf(tr) === kf(src.tracks[i]))) errs.push("copy 同帧数应逐字节相同");
      // 删
      if (me.removeMdlClip(bytes, src.id) !== null) errs.push("删首个未拒");
      if (before.animations.length > 1) {
        const victim = before.animations.at(-1);
        const R = me.removeMdlClip(bytes, victim.id);
        const RA = R && P.parseMDL(R).animations;
        if (!RA || RA.length !== before.animations.length - 1 || RA.some((a) => a.id === victim.id) || !RA.every((a, i) => clipSig(a) === clipSig(before.animations[i]))) errs.push("删");
        else removed++;
      }
      // 改头
      const M1 = me.setMdlClipMeta(bytes, src.id, { name: "改名", mode: "single", fps: 12 });
      const MA = M1 && P.parseMDL(M1).animations[0];
      if (!MA || MA.name !== "改名" || MA.mode !== "single" || Math.abs(MA.fps - 12) > 1e-6 || !MA.tracks.every((tr, i) => kf(tr) === kf(src.tracks[i]))) errs.push("改头");
      const fc3 = Math.max(1, Math.round(src.frameCount / 2));
      const M2 = me.setMdlClipMeta(bytes, src.id, { frameCount: fc3 });
      const MB = M2 && P.parseMDL(M2).animations[0];
      if (!MB || MB.frameCount !== fc3 || !MB.tracks.every((tr, i) => !src.tracks[i].frameCount || tr.frameCount === fc3 + (src.tracks[i].frameCount - src.frameCount))) errs.push("改帧数重采样");
      // 事件
      const evs = [{ frame: 9, name: "b" }, { frame: 2, name: "a" }, { frame: 999999, name: "末" }];
      const E1 = me.setMdlClipEvents(bytes, src.id, evs);
      const EA = E1 && P.parseMDL(E1).animations[0];
      const want = [{ frame: 2, name: "a" }, { frame: Math.min(9, src.frameCount), name: "b" }, { frame: src.frameCount, name: "末" }].sort((x, y) => x.frame - y.frame);
      if (!EA || json(EA.events) !== json(want) || json(me.mdlClips(E1)[0].events) !== json(want) || !EA.tracks.every((tr, i) => kf(tr) === kf(src.tracks[i]))) errs.push(`事件 ${json(EA?.events)}`);
      else {
        const E2 = me.setMdlClipEvents(E1, src.id, []);
        if (!E2 || P.parseMDL(E2).animations[0].events.length !== 0 || !P.parseMDL(E2).animations.every((a, i) => i === 0 || clipSig(a) === clipSig(before.animations[i]))) errs.push("清空事件");
      }
      // 非法
      for (const badInit of [{ name: "" }, { name: "x".repeat(65) }, { mode: "foo" }, { fps: 0 }, { fps: 300 }, { frameCount: 0 }, { frameCount: 1.5 }]) {
        if (me.setMdlClipMeta(bytes, src.id, badInit) !== null || me.addMdlClip(bytes, { ...init, ...badInit }) !== null) errs.push(`非法 ${json(badInit)} 未拒`);
      }
      if (me.setMdlClipMeta(bytes, -77, { name: "x" }) !== null || me.setMdlClipEvents(bytes, src.id, [{ frame: 1, name: "" }]) !== null || me.addMdlClip(bytes, init, "copy", -77) !== null) errs.push("不存在 / 空事件名未拒");
      if (errs.length) bad.push(`${key} ${errs.join(",")}`);
      else ok++;
    }
  }
  return { ok, removed, noMdla, bad, seen: seen.size };
}

section("MG. 动画片段增删 / 元数据 / 帧事件 api addMdlClip…（W18b）");
{
  const mm = await loadEditorModule("model");
  const me = await loadRendererTs("renderer/src/editor/mdl-edit.ts");
  const P = await imp("renderer/vendor/we-scene/render/mdl-parse.js");
  const { modelTruth, PUPPET_FIXTURES, MESH_FIXTURES } = await imp("scripts/verify-editor-model.mjs");
  const tr = Float32Array.from([0, 0, 0, 0, 0, 3.0, 1, 1, 1, 10, 0, 0, 0, 0, -3.0, 2, 1, 1]);
  const r3 = me.resampleTrack(tr, 3);
  check(r3.length === 27 && r3[0] === 0 && r3[18] === 10 && near(r3[9], 5, 1e-6) && near(r3[15], 1.5, 1e-6) && Math.abs(Math.abs(r3[14]) - Math.PI) < 0.01 && json([...me.resampleTrack(tr, 2)]) === json([...tr]),
    `resampleTrack：首末帧不变、线性插值、欧拉角跨 ±π 走最短方向（中点 ${r3[14].toFixed(3)} 而非 0）、同帧数原样`);
  check(json(me.CLIP_MODES) === json(["loop", "mirror", "single"]), "片段模式 loop / mirror / single");
  const res = await clipEditCorpus(me, P, modelTruth, [...PUPPET_FIXTURES, ...MESH_FIXTURES]);
  check(res.ok >= 5 && res.removed >= 1 && res.bad.length === 0,
    `语料：${res.seen} 个 .mdl 中 ${res.ok} 个带动画段的逐项过：新建静止姿势（每帧 = 首片段第 0 帧）/ 复制重采样首末帧不变 / 删（${res.removed} 个；首个拒绝）/ 改名·模式·fps 轨道不变 / 改帧数重采样 / 事件排序钳位读回，旧片段与网格骨骼逐字节不变；非法头拒绝；无动画段的 ${res.noMdla} 个拒绝加段（不符 ${json(res.bad.slice(0, 4))}）`);

  check(json(mm.parseEventsText("12 footstep\n\n 3: 起跳 \n0：落地")) === json([{ frame: 12, name: "footstep" }, { frame: 3, name: "起跳" }, { frame: 0, name: "落地" }]) && mm.parseEventsText("abc") === null && json(mm.parseEventsText("  ")) === json([]),
    "parseEventsText：一行「帧号 名字」（空白 / 冒号 / 全角冒号分隔）；读不懂整份 null；空 = 清空");
  check(mm.formatEventsText([{ frame: 3, name: "a b" }, { frame: 7, name: "c" }]) === "3 a b\n7 c" && json(mm.parseEventsText(mm.formatEventsText([{ frame: 3, name: "a b" }]))) === json([{ frame: 3, name: "a b" }]), "formatEventsText 与 parse 往返");
  check(mm.nextClipName([{ name: "片段" }, { name: "片段 2" }], "片段") === "片段 3" && mm.nextClipName([], "x") === "x", "nextClipName：跳过已占用");
  const obj = { animationlayers: [{ animation: 5, name: "a" }, { animation: 7 }, { animation: { value: 5 } }, { animation: 9 }] };
  check(mm.dropAnimLayersOfClip(obj, 5) === 2 && json(obj.animationlayers) === json([{ animation: 7 }, { animation: 9 }]) && mm.dropAnimLayersOfClip(obj, 42) === 0 && mm.dropAnimLayersOfClip({}, 1) === 0,
    "dropAnimLayersOfClip：删掉指向该片段的动画层（含 {value} 包装），没有就不动");
  const mj = { material: "m.json", puppet: "models/a_puppet.mdl" };
  const cf = mm.mdlCopyFiles(mj, new Uint8Array([1, 2]), "c");
  check(cf.path === "models/editor/c.json" && JSON.parse(dec.decode(cf.files[0].data)).puppet === "models/editor/c.mdl" && cf.files[1].data.length === 2 && mm.mdlCopyFiles(null, new Uint8Array(1), "c").path === "models/editor/c.mdl" && mm.mdlCopyFiles({ material: "m" }, new Uint8Array(1), "c") === null,
    "mdlCopyFiles：puppet 连 model json 副本（puppet 改指向），mesh 只有 .mdl；不是 puppet 的 json 拒绝");

  const mainSrc = fs.readFileSync(path.join(ROOT, "editor/main.ts"), "utf8");
  check(/\{ id: "clips", order: 900, when: \(\) => true, render: clipsGroup(?:, tab: "anim")? \}/.test(mainSrc) && /function clipsGroup\(node: LayerNode\)[\s\S]{0,300}editor\.getModelInfo\(id\)/.test(mainSrc), "检视器：模型层有「动画片段」分组，片段来自 getModelInfo");
  check(/removeMdlClip\(b, c\.id\), \(o\) => \{\s*dropAnimLayersOfClip\(o, c\.id\);/.test(mainSrc), "删片段与删指向它的动画层是同一步结构编辑（撤销一起回来）");
  check(/addMdlClip\(b, init, "copy", c\.id\)/.test(mainSrc) && /addMdlClip\(b, init, "rest", c0\.id\)/.test(mainSrc) && /setMdlClipMeta\(b, c\.id, meta\)/.test(mainSrc) && /setMdlClipEvents\(b, c\.id, list\)/.test(mainSrc),
    "复制 = copy、新建 = 首片段静止姿势、改头 / 事件都走 commitMdlEdit");
  check(/ci === 0 \? et\("cl\.delFirst"\) : et\("fx\.del"\)[\s\S]{0,400}\}, ci === 0\)/.test(mainSrc), "首个片段的删除按钮禁用");
  const i18nSrc = fs.readFileSync(path.join(ROOT, "editor/i18n.ts"), "utf8");
  const keys = ["insp.clips", "cl.note", "cl.name", "cl.mode", "cl.mode.loop", "cl.mode.mirror", "cl.mode.single", "cl.fps", "cl.frames", "cl.events", "cl.eventsHint", "cl.dup", "cl.delFirst", "cl.add", "cl.defaultName", "cl.fail.read", "cl.fail.mdl", "cl.fail.events", "log.clipEdited", "log.clipAdded", "log.clipRemoved"];
  const missing = keys.filter((k) => (i18nSrc.match(new RegExp(`"${k.replace(/\./g, "\\.")}":`, "g")) ?? []).length !== 2);
  check(missing.length === 0, `片段文案中英文都有（缺 ${json(missing)}）`);
}

/**
 * MH ★ 判据（J 段变异复用）：夹具 glb → parseGltf → gltfToModel → encodeMdl → 引擎 parseMDL + computeSkinMatrices，
 * 每个片段每一帧（loop 末帧与首帧重合，取 0..frameCount−1）的蒙皮顶点 vs 独立参考求值。
 * 返回最大误差（像素，scale 倍）、帧间中点误差、欧拉角相邻帧最大跳变
 */
async function gltfSkinCheck(G, scale = 100) {
  const P = await imp("renderer/vendor/we-scene/render/mdl-parse.js");
  const S = await imp("renderer/vendor/we-scene/render/mdl-skin.js");
  const F = await imp("scripts/lib/gltf-fixture.mjs");
  const out = { worst: 0, mid: 0, jump: 0, frames: 0, models: [] };
  for (const [name, fx] of [["skinned", F.skinnedFixture()], ["rigid", F.rigidFixture()]]) {
    for (const target of ["puppet", "mesh"]) {
      const m = G.gltfToModel(G.parseGltf(fx.glb), { target, slug: "t", fps: 30, scale });
      const files = G.gltfImportFiles(m, "t");
      const mdl = P.parseMDL(files.files.find((f) => f.name.endsWith(".mdl")).data);
      out.models.push({ name, target, m, mdl, files });
      fx.src.anims.forEach((a, ai) => {
        const clip = m.clips[ai];
        const layer = [{ animation: clip.id, blend: 1, rate: 1, visible: true, additive: false }];
        const at = (t) => S.skinnedMeshes(mdl, S.computeSkinMatrices(mdl, t, layer), true).flatMap((x) => [...x.pos]);
        const err = (t) => {
          const got = at(t);
          const want = F.refVertices(fx.src, a, t, scale);
          return want.reduce((mx, v, i) => Math.max(mx, Math.abs(got[i] - v)), 0);
        };
        const step = a.channels.some((c) => c.interp === "STEP");
        for (let f = 0; f < clip.frameCount; f++) {
          out.worst = Math.max(out.worst, err(f / clip.fps));
          // STEP 的跳变在稠密采样后变成一帧内的线性过渡，帧间中点本就不该相等
          if (!step) out.mid = Math.max(out.mid, err((f + 0.5) / clip.fps));
          out.frames++;
        }
        for (const tr of m.spec.animations[ai].tracks) {
          for (let f = 1; f <= clip.frameCount; f++) for (let k = 3; k < 6; k++) out.jump = Math.max(out.jump, Math.abs(tr[f * 9 + k] - tr[(f - 1) * 9 + k]));
        }
      });
    }
  }
  return out;
}

section("MH. glTF 导入 editor/gltf.ts → parseGltf / gltfToModel / encodeMdl（W19）");
{
  const G = await loadEditorModule("gltf");
  const F = await imp("scripts/lib/gltf-fixture.mjs");
  const P = await imp("renderer/vendor/we-scene/render/mdl-parse.js");
  const MM = await imp("renderer/vendor/we-scene/render/mdl-math.js");
  const zlib = await import("node:zlib");
  const sk = await gltfSkinCheck(G);
  check(sk.frames === 2 * (30 + 60) + 2 * 30 && sk.worst < 1e-3,
    `★ 夹具（3 骨蒙皮 + 2 片段 / 刚体层级 × puppet / 网格，scale 100）：${sk.frames} 帧蒙皮顶点 vs glTF 参考求值最大误差 ${sk.worst.toExponential(2)} px < 1e-3（绑定 = IBM⁻¹、网格节点变换被忽略、STEP / LINEAR / CUBICSPLINE、经过 ry = 90° 万向节）`);
  check(sk.mid > 0 && sk.mid < 0.5, `帧间中点（引擎欧拉角线性插值 vs glTF 球面 / 样条插值，不含 STEP 片段）最大误差 ${sk.mid.toFixed(3)} px < 0.5（30 fps 稠密采样）`);
  check(sk.jump < 0.6, `欧拉角相邻帧最大跳变 ${sk.jump.toFixed(3)} rad（连续解，不在 ±π / 万向节处翻转）`);
  const ms = sk.models.find((x) => x.name === "skinned" && x.target === "puppet");
  check(ms.mdl.magic === "MDLV0023" && json(ms.mdl.bones.map((b) => [b.name, b.parent])) === json([["root", -1], ["b1", 0], ["b2", 1]]) &&
    json(ms.m.clips.map((c) => [c.id, c.name, c.frameCount])) === json([[1, "wave", 30], [2, "twist", 60]]) && ms.mdl.animations.length === 2 && ms.mdl.animations.every((a) => a.mode === "loop" && a.fps === 30 && a.tracks.length === 3),
    "产物：MDLV0023、骨 = 关节（先序、父在前，名字取节点名）、每个 glTF 动画一个片段（30 fps 稠密、每骨一轨、loop）");
  const mr = sk.models.find((x) => x.name === "rigid" && x.target === "mesh");
  check(mr.m.bones === 2 && mr.mdl.meshes?.length === 2 && mr.files.path === "models/editor/t.mdl",
    "无蒙皮的刚体层级：挂网格的节点（含 matrix 静止姿势）各成一骨、顶点按节点绑定世界矩阵烘焙；网格目标每图元一个子网格");
  let qWorst = 0;
  const qs = [F.axisQuat([0, 1, 0], Math.PI / 2), F.axisQuat([0, 1, 0], -Math.PI / 2), F.axisQuat([1, 1, 0], Math.PI), F.axisQuat([0, 0, 1], Math.PI)];
  for (let i = 0; i < 200; i++) qs.push(F.axisQuat([Math.sin(i * 1.7), Math.cos(i * 2.3), Math.sin(i * 0.9 + 1)], (i * 0.37) % (2 * Math.PI)));
  qs.forEach((q, qi) => {
    const e = G.quatToEuler(q, qi % 2 ? [0.3, -0.2, 2.9] : undefined);
    const a = MM.composeTRS(0, 0, 0, e[0], e[1], e[2], 1, 1, 1);
    const b = F.trs([0, 0, 0], q);
    qWorst = Math.max(qWorst, ...b.map((v, k) => Math.abs(v - a[k])));
  });
  check(qWorst < 1e-6, `quatToEuler：${qs.length} 个四元数（含 ±90° 万向节、180°）经引擎 composeTRS 复原旋转矩阵最大误差 ${qWorst.toExponential(2)}`);
  const near2 = G.quatToEuler(F.axisQuat([0, 0, 1], Math.PI - 0.01), [0, 0, 3.2]);
  check(Math.abs(near2[2] - (Math.PI - 0.01)) < 1e-6 && Math.abs(G.quatToEuler(F.axisQuat([0, 0, 1], -Math.PI + 0.01), [0, 0, Math.PI - 0.01])[2] - (Math.PI + 0.01)) < 1e-6,
    "quatToEuler 给上一帧时就近 2π 展开（跨 ±π 不跳 2π）");

  // Z 向上导出（3ds Max / FBX 转 glTF 常见）：网格节点绕 X 转 −90° + 缩放，XY 子块奇异
  {
    const S = await imp("renderer/vendor/we-scene/render/mdl-skin.js");
    const tri = new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 2]);
    const zj = {
      asset: { version: "2.0" },
      buffers: [{ byteLength: tri.byteLength, uri: `data:;base64,${Buffer.from(tri.buffer).toString("base64")}` }],
      bufferViews: [{ buffer: 0, byteLength: tri.byteLength }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      nodes: [{ name: "Pivot", translation: [0, 0.5, 0.25], children: [1] }, { name: "Mesh", rotation: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2], scale: [2.54, 2.54, 2.54], mesh: 0 }],
      scenes: [{ nodes: [0] }],
      animations: [{ name: "Take 001", samplers: [], channels: [] }],
    };
    const want = [0, 0.5, 0.25, 2.54, 0.5, 0.25, 0, 0.5 + 2 * 2.54, 0.25].map((v) => v * 10);
    const res = ["puppet", "mesh"].map((target) => {
      const zm = G.gltfToModel(G.parseGltf(enc.encode(JSON.stringify(zj))), { target, slug: "z", scale: 10 });
      const zmdl = P.parseMDL(G.gltfImportFiles(zm, "z").files.find((f) => f.name.endsWith(".mdl")).data);
      const got = S.skinnedMeshes(zmdl, S.computeSkinMatrices(zmdl, 0.5, [{ animation: zm.clips[0].id, visible: true }]), true).flatMap((x) => [...x.pos]);
      return { bones: json(zmdl.bones.map((b) => [b.name, b.parent])), err: want.reduce((mx, v, i) => Math.max(mx, Math.abs((got[i] ?? NaN) - v)), 0), warn: zm.warnings.map((w) => w.code) };
    });
    check(res.every((r) => r.bones === json([["Pivot", -1], ["Mesh", 0]]) && r.err < 1e-3 && r.warn.includes("emptyAnim")),
      `Z 向上模型（节点绕 X 转 −90°、缩放 2.54）：引擎读回骨架 ${res[0].bones}，静止蒙皮顶点 vs glTF 世界坐标 puppet ${res[0].err.toExponential(2)} / 网格 ${res[1].err.toExponential(2)}（空动画告警）`);
  }

  // .gltf：外部 .bin / data URI 与 glb 等价
  const fx = F.skinnedFixture();
  const glbMdl = G.gltfImportFiles(G.gltfToModel(G.parseGltf(fx.glb), { target: "puppet", slug: "t", scale: 10 }), "t").files.find((f) => f.name.endsWith(".mdl")).data;
  const ext = structuredClone(fx.json);
  ext.buffers[0].uri = "sub%20dir/fx.bin";
  const viaExt = G.parseGltf(enc.encode(JSON.stringify(ext)), (u) => (u === "sub dir/fx.bin" ? fx.bin : null));
  const uri = structuredClone(fx.json);
  uri.buffers[0].uri = `data:application/octet-stream;base64,${Buffer.from(fx.bin).toString("base64")}`;
  const viaUri = G.parseGltf(enc.encode(JSON.stringify(uri)));
  const mdlOf = (g) => G.gltfImportFiles(G.gltfToModel(g, { target: "puppet", slug: "t", scale: 10 }), "t").files.find((f) => f.name.endsWith(".mdl")).data;
  check(Buffer.from(mdlOf(viaExt)).equals(Buffer.from(glbMdl)) && Buffer.from(mdlOf(viaUri)).equals(Buffer.from(glbMdl)), ".gltf + 外部 .bin（URI 百分号解码）/ data URI 与 .glb 产出逐字节相同的 .mdl");
  const errCode = (fn) => {
    try {
      fn();
      return null;
    } catch (e) {
      return e instanceof G.GltfError ? e.code : `?${e.message}`;
    }
  };
  const withJson = (patch) => {
    const j = structuredClone(fx.json);
    patch(j);
    return () => G.parseGltf(enc.encode(JSON.stringify(j)), (u) => (u === "fx.bin" ? fx.bin : null));
  };
  check(errCode(() => G.parseGltf(enc.encode(JSON.stringify(ext)))) === "buffer", "外部 .bin 找不到 → buffer");
  check(errCode(() => G.parseGltf(new Uint8Array([1, 2, 3]))) === "format" && errCode(withJson((j) => (j.asset.version = "1.0"))) === "version", "不是 glTF → format；1.0 → version");
  check(errCode(withJson((j) => ((j.extensionsRequired = ["KHR_draco_mesh_compression"]), (j.buffers[0].uri = "fx.bin")))) === "extension" && errCode(withJson((j) => ((j.extensionsRequired = ["KHR_mesh_quantization"]), (j.buffers[0].uri = "fx.bin")))) === null,
    "必需扩展 Draco → extension；KHR_mesh_quantization（只是整数顶点）放行");
  check(errCode(() => G.gltfToModel(G.parseGltf(enc.encode(JSON.stringify({ asset: { version: "2.0" }, nodes: [{}] }))), { target: "mesh", slug: "t" })) === "noMesh", "没有网格 → noMesh");
  const oob = structuredClone(fx.json);
  oob.buffers[0].uri = "fx.bin";
  oob.accessors[oob.meshes[0].primitives[0].attributes.POSITION].count = 99999;
  check(errCode(() => G.gltfToModel(G.parseGltf(enc.encode(JSON.stringify(oob)), () => fx.bin), { target: "mesh", slug: "t" })) === "accessor", "访问器越界 → accessor（不读出界内存）");

  // 访问器：normalized / 稀疏 / 跨距
  const raw = new Uint8Array(64);
  const dvr = new DataView(raw.buffer);
  [0, 128, 255, 64].forEach((v, k) => (raw[k] = v));
  dvr.setFloat32(8, 1, true), dvr.setFloat32(12, 2, true), dvr.setFloat32(16, 3, true), dvr.setFloat32(20, 4, true);
  dvr.setUint16(24, 2, true);
  dvr.setFloat32(28, 9, true);
  const ag = G.parseGltf(enc.encode(JSON.stringify({
    asset: { version: "2.0" },
    buffers: [{ byteLength: 64, uri: `data:;base64,${Buffer.from(raw).toString("base64")}` }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 4 }, { buffer: 0, byteOffset: 8, byteLength: 16, byteStride: 8 }, { buffer: 0, byteOffset: 24, byteLength: 2 }, { buffer: 0, byteOffset: 28, byteLength: 4 }],
    accessors: [
      { bufferView: 0, componentType: 5121, normalized: true, count: 4, type: "SCALAR" },
      { bufferView: 1, componentType: 5126, count: 2, type: "SCALAR" },
      { componentType: 5126, count: 3, type: "SCALAR", sparse: { count: 1, indices: { bufferView: 2, componentType: 5123 }, values: { bufferView: 3 } } },
    ],
  })));
  check(json([...G.readAccessor(ag, 0).data].map((v) => +v.toFixed(4))) === json([0, 0.502, 1, 0.251]) && json([...G.readAccessor(ag, 1).data]) === json([1, 3]) && json([...G.readAccessor(ag, 2).data]) === json([0, 0, 9]),
    "readAccessor：u8 normalized 归一、byteStride 跨距、无 bufferView 的稀疏访问器（全零 + 覆盖）");
  check(json(G.topInfluences([0, 1, 2, 3, 4, 5], [0.1, 0.3, 0.05, 0.25, 0.2, 0.1], 0)) === json({ j: [1, 3, 4, 0], w: [0.3 / 0.85, 0.25 / 0.85, 0.2 / 0.85, 0.1 / 0.85] }) &&
    json(G.topInfluences([2, 3], [0, 0], 7)) === json({ j: [7, 7, 7, 7], w: [1, 0, 0, 0] }) && json(G.topInfluences([4, 5], [0.5, 0.5], 0).j) === json([4, 5, 4, 4]),
    "每顶点影响：按权重取前 4 个归一（同权保持原序）、全零挂到兜底骨、不足 4 个补零权重");

  // 告警
  const wj = structuredClone(fx.json);
  wj.buffers[0].uri = "fx.bin";
  wj.meshes[0].primitives.push({ attributes: { POSITION: wj.meshes[0].primitives[0].attributes.POSITION }, mode: 1 });
  wj.meshes[0].primitives[0].targets = [{ POSITION: wj.meshes[0].primitives[0].attributes.POSITION }];
  const wm = G.gltfToModel(G.parseGltf(enc.encode(JSON.stringify(wj)), () => fx.bin), { target: "mesh", slug: "t", boneBudget: 2 });
  const codes = wm.warnings.map((w) => w.code);
  check(["mode", "morph", "boneBudget"].every((c) => codes.includes(c)) && wm.spec.meshes.length === 1, `告警：非三角形图元跳过、形变目标忽略、骨数超预算（${json(codes)}）`);

  // 材质 / 贴图 / 产物文件
  const pf = ms.files;
  const mjson = JSON.parse(dec.decode(pf.files.find((f) => f.name === "models/editor/t.json").data));
  const pmat = JSON.parse(dec.decode(pf.files.find((f) => f.name === "materials/editor/t.json").data));
  check(pf.path === "models/editor/t.json" && json(mjson) === json({ autosize: true, material: "materials/editor/t.json", puppet: "models/editor/t.mdl" }) &&
    pmat.passes[0].shader === "genericimage4" && json(pmat.passes[0].textures) === json(["editor/t"]) && Buffer.from(pf.files.find((f) => f.name === "materials/editor/t.png").data).equals(Buffer.from(fx.png)) &&
    ms.mdl.materialPath === "materials/editor/t.json",
    "puppet 产物：model json（autosize / material / puppet）+ genericimage4 材质 + 内嵌 png 原字节；.mdl 子网格材质同路径");
  check(pmat.passes[0].depthtest === "enabled" && pmat.passes[0].depthwrite === "enabled" && pmat.passes[0].blending === "translucent" && pmat.passes[0].cullmode === "nocull",
    "puppet 材质声明 depthtest/depthwrite enabled：真 3D 网格在 2D 场景里也参与深度（宿主按这个字段标 layer.depthMesh），仍是 alpha 混合 + nocull");
  const mm2 = sk.models.find((x) => x.name === "skinned" && x.target === "mesh").files;
  const mmat = JSON.parse(dec.decode(mm2.files.find((f) => f.name === "materials/editor/t_0.json").data));
  check(mm2.path === "models/editor/t.mdl" && !mm2.files.some((f) => f.name.endsWith(".json") && f.name.startsWith("models/")) && mmat.passes[0].shader === "generic4" && mmat.passes[0].cullmode === "nocull",
    "网格产物：只有 .mdl（对象 model 直接指它）+ 每个 glTF 材质一份 generic4 材质（doubleSided → nocull）");
  // [we-scene patch 2026-10-09] 默认主光（F52）：无灯 2D 场景里导入的网格靠它才有 N·L 明暗——
  // 鼻子/嘴/衣褶这类「只有形体、没有独立反照率」的特征在纯反照率下完全不显形（用户报
  // 「人物的鼻子和嘴巴没渲染出来」）。puppet / mesh 两形态的材质都要声明 defaultlight。
  check(pmat.passes[0].defaultlight === true && mmat.passes[0].defaultlight === true,
    "导入产物（puppet / mesh 两形态）的材质没有声明 defaultlight：无灯 2D 壁纸里的模型只能是平涂贴纸");
  {
    const hostSrc = fs.readFileSync(path.join(ROOT, "renderer/src/scene-mount.ts"), "utf8");
    const mdlSrc = fs.readFileSync(path.join(ROOT, "renderer/vendor/we-scene/render/mdl.js"), "utf8");
    check(/const DEFAULT_MESH_LIGHT/.test(hostSrc) && /function isEditorAssetPath/.test(hostSrc),
      "scene-mount 缺默认主光常量 / 编辑器命名空间判定（无灯 2D 壁纸里的导入模型不会补光）");
    const flagHits = [...hostSrc.matchAll(/\(layer as any\)\.defaultMeshLight = true;/g)];
    check(flagHits.length === 2, `宿主标 layer.defaultMeshLight 的装配分支不是 2 处（实测 ${flagHits.length}：puppet / model 各一处）`);
    check(/sceneLight:\s*layerLight && layersHaveNormals\(layer\) \? layerLight : null/.test(hostSrc),
      "setPuppetRenderer 回调没转发 layerLight：默认主光在实机上不生效（渲染侧收到 undefined）");
    check(/const layerLight = sceneLight \?\? defaultLight;/.test(hostSrc),
      "layerLight 没表达「场景灯优先、默认主光回落」（有灯的壁纸会被默认主光盖掉）");
    check(/normals:\s*mdl\.normals \|\| singleSub\?\.normals \|\| null/.test(mdlSrc) &&
      /const singleSub = mdl\.meshes && mdl\.meshes\.length === 1/.test(mdlSrc),
      "mdl.js 的 legacyMeshOf 没认单子网格记录里的法线：导入的单网格模型在真机上 u_lightOn 恒为 0");
    check(mdlSrc.replace(" || singleSub?.normals || null", " || null") !== mdlSrc &&
      hostSrc.replace(flagHits[0] ? flagHits[0][0] : "", "") !== hostSrc,
      "注入点存在（单子网格法线回落 + 宿主默认主光标记）");
  }
  const png = G.solidPng([1, 0, 0, 0.5]);
  const idat = (() => {
    let p = 8;
    const parts = [];
    while (p < png.length) {
      const len = Buffer.from(png.subarray(p, p + 4)).readUInt32BE();
      if (dec.decode(png.subarray(p + 4, p + 8)) === "IDAT") parts.push(png.subarray(p + 8, p + 8 + len));
      p += 12 + len;
    }
    return zlib.inflateSync(Buffer.concat(parts));
  })();
  check(idat.length === 4 * 17 && json([...idat.subarray(1, 5)]) === json([255, 0, 0, 128]) && idat[0] === 0, "solidPng：合法 zlib / png（node 能解）、底色系数线性 → sRGB 8 位、alpha 原样");
  const mr2 = sk.models.find((x) => x.name === "rigid" && x.target === "puppet").files;
  check(mr2.files.some((f) => f.name === "materials/editor/t.png" && f.data.length > 0), "没有底色贴图时用 solidPng 兜底");

  // 加层
  const mk = await loadEditorModule("doc");
  const orthoDoc = mk.makeDoc("t", null, { general: { orthogonalprojection: { width: 1920, height: 1080 } }, objects: [{ id: 5, image: "a.json", animationlayers: [{ id: 9, animation: 1 }] }] }, "loose");
  check(G.defaultTarget(orthoDoc) === "puppet" && G.defaultTarget(mk.makeDoc("t", null, { general: {}, camera: { center: "1 2 3", eye: "1 2 13" }, objects: [] }, "loose")) === "mesh", "正交场景缺省 puppet、透视场景缺省网格");
  check(near(G.fitPuppetScale(orthoDoc)(Float64Array.of(-1, 0, 0, 1, 3, 0)), Math.min(0.6 * 1920 / 2, 0.6 * 1080 / 3)), "puppet 缺省缩放：包围盒落在画面 60% 内");
  const id = G.addModelLayer(orthoDoc, ms.m, "models/editor/t.json", "Fox");
  const o = orthoDoc.scene.objects.at(-1);
  const b = ms.m.bounds;
  check(id === 10 && o.image === "models/editor/t.json" && o.name === "Fox" && json(o.origin.split(" ").map(Number)) === json([960 - (b[0] + b[3]) / 2, 540 - (b[1] + b[4]) / 2, 0].map((v) => +v.toFixed(5))) &&
    o.animationlayers?.length === 1 && o.animationlayers[0].animation === 1 && o.animationlayers[0].name === "wave" && o.animationlayers[0].id === 11,
    "addModelLayer（puppet）：图片层 id 不撞对象 / 动画层编号、包围盒中心落画面中心、挂一条动画层指向首个片段");
  // 网格层包围盒中心的世界坐标（层变换 = T·Ry，与渲染器 layerModelMatrix 同口径）
  const meshCenter = (obj, bb) => {
    const [ox, oy, oz] = obj.origin.split(" ").map(Number);
    const yaw = Number(obj.angles.split(" ")[1]);
    const cx = (bb[0] + bb[3]) / 2, cy = (bb[1] + bb[4]) / 2, cz = (bb[2] + bb[5]) / 2;
    return [ox + Math.cos(yaw) * cx + Math.sin(yaw) * cz, oy + cy, oz - Math.sin(yaw) * cx + Math.cos(yaw) * cz];
  };
  const near3 = (a, e) => a.every((v, i) => Math.abs(v - e[i]) < 1e-3);
  const pDoc = mk.makeDoc("t", null, { general: {}, camera: { center: "1 2 3", eye: "1 2 13" }, objects: [] }, "loose");
  const pScale = G.fitMeshScale(pDoc)(Float64Array.of(-1, -1, -1, 1, 1, 1));
  G.addModelLayer(pDoc, mr.m, "models/editor/t.mdl", "Arm");
  check(pDoc.scene.objects[0].model === "models/editor/t.mdl" && near3(meshCenter(pDoc.scene.objects[0], mr.m.bounds), [1, 2, 3]) && pDoc.scene.objects[0].angles === "0.00000 0.00000 0.00000" && !("image" in pDoc.scene.objects[0]) &&
    near(pScale, (0.6 * 10 * Math.tan((25 * Math.PI) / 180)) / Math.sqrt(3)),
    "addModelLayer（网格，无相机实体）：model 指 .mdl、包围盒中心落在 scene.camera 注视点；缺省缩放 = 包围球直径占画面高 60%");
  const camDoc = mk.makeDoc("t", null, {
    general: { fov: 50 },
    camera: { center: "100 0 0", eye: "100 0 10" },
    objects: [
      { id: 1, camera: "c", origin: "0 0 5", angles: "0 90 0", fov: { user: "f", value: 40 } },
      { id: 2, camera: "c", origin: "50 50 50", visible: false },
      { id: 3, model: "models/a.mdl", origin: "-10 0 5" },
      { id: 4, model: "models/b.mdl", origin: "10 0 5" },
    ],
  }, "loose");
  const cv = G.meshView(camDoc);
  const cScale = G.fitMeshScale(camDoc)(Float64Array.of(-1, -1, -1, 1, 1, 1));
  G.addModelLayer(camDoc, mr.m, "models/editor/t.mdl", "Arm");
  const co = camDoc.scene.objects.at(-1);
  check(near3(cv.eye, [0, 0, 5]) && near3(cv.fwd, [-1, 0, 0]) && cv.fov === 40 && near(cv.dist, 8) &&
    near3(meshCenter(co, mr.m.bounds), [-8, 0, 5]) && near(Number(co.angles.split(" ")[1]), Math.PI / 2, 1e-5) &&
    near(cScale, (0.6 * 8 * Math.tan((20 * Math.PI) / 180)) / Math.sqrt(3)),
    "addModelLayer（网格，有相机实体）：取最后一个可见相机实体的眼 / 朝向 / fov，摆在视线前方最近模型再往前 20%，包围盒中心对准视线、正面朝相机");
  // 2D 正交场景里的 3D 网格：几何必须按像素量、摆画面中心 —— 此前一律按相机世界单位摆
  // （几十像素级），用户在 2D 壁纸里选「3D 网格」导入后画面毫无变化。
  const oMeshDoc = mk.makeDoc("t", null, { general: { orthogonalprojection: { width: 1920, height: 1080 } }, objects: [] }, "loose");
  G.addModelLayer(oMeshDoc, mr.m, "models/editor/t.mdl", "Arm");
  const om = oMeshDoc.scene.objects.at(-1);
  const oWant = [960 - (mr.m.bounds[0] + mr.m.bounds[3]) / 2, 540 - (mr.m.bounds[1] + mr.m.bounds[4]) / 2, 0];
  check(om.model === "models/editor/t.mdl" && om.angles === "0.00000 0.00000 0.00000" && json(om.scale.split(" ").map(Number)) === json([1, 1, 1]) &&
    json(om.origin.split(" ").map(Number)) === json(oWant.map((v) => +v.toFixed(5))),
    "addModelLayer（网格 + 2D 正交场景）：model 指 .mdl、包围盒中心摆画面中心、不绕 Y 转、scale 保持 1（与 WE 官方 2D 场景里的 model 层同口径）");
  check(G.isOrthoDoc(orthoDoc) === true && G.isOrthoDoc(pDoc) === false, "isOrthoDoc：有 orthogonalprojection 才是 2D 正交场景（导入形态与摆放口径的唯一判据）");

  // puppet 形态必须把法线带进网格：渲染端只在网格有法线时才把场景平行光接到这一层
  // （scene-mount 的 layersHaveNormals → sceneLight，mdl.js 的 u_lightOn）。以前 puppet
  // 分支丢法线 ⇒ 2D 场景里导入的 3D 模型永远是无光照的平涂色块（与原型差距明显）。
  const njOf = () => {
    const nb = new ArrayBuffer(78);
    new Float32Array(nb, 0, 18).set([0, 0, 0, 1, 0, 0, 0, 0, 2, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
    new Uint16Array(nb, 72, 3).set([0, 1, 2]);
    return {
      asset: { version: "2.0" },
      buffers: [{ byteLength: nb.byteLength, uri: `data:;base64,${Buffer.from(nb).toString("base64")}` }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 36 }, { buffer: 0, byteOffset: 72, byteLength: 6 }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" }, { bufferView: 1, componentType: 5126, count: 3, type: "VEC3" }, { bufferView: 2, componentType: 5123, count: 3, type: "SCALAR" }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2 }] }],
      nodes: [{ name: "m", mesh: 0 }],
      scenes: [{ nodes: [0] }],
    };
  };
  {
    const nj = njOf();
    const withN = G.gltfToModel(G.parseGltf(enc.encode(JSON.stringify(nj))), { target: "puppet", slug: "n", scale: 10 });
    const bare = structuredClone(nj);
    bare.meshes[0].primitives[0].attributes = { POSITION: 0 };
    const noN = G.gltfToModel(G.parseGltf(enc.encode(JSON.stringify(bare))), { target: "puppet", slug: "n", scale: 10 });
    const nn = withN.spec.meshes[0].normals;
    check(nn instanceof Float32Array && nn.length === withN.spec.meshes[0].positions.length && json([...nn.slice(0, 3)]) === json([0, 0, 1]) &&
      json([...withN.spec.meshes[0].positions.slice(0, 3)]) === json([0, 0, 0]) && noN.spec.meshes[0].normals === undefined && noN.spec.meshes[0].positions.length === 9,
      "puppet 网格随位置一起搬法线（渲染端据此接通场景平行光）；任一图元没法线就整体不写，不留半有半无的属性");
  }

  // 变异：把新判据逐个改坏，对应的判据必须变红
  {
    const gp = path.join(ROOT, "editor/gltf.ts");
    const gs = fs.readFileSync(gp, "utf8");
    const mutDepth = gs.replace('depthtest: "enabled", depthwrite: "enabled", shader: "genericimage4"', 'depthtest: "disabled", depthwrite: "disabled", shader: "genericimage4"');
    check(mutDepth !== gs, "注入点存在（puppet 材质的 depthtest/depthwrite 声明）");
    const MG = await loadEditorModule("gltf", { [gp]: mutDepth });
    const gm = JSON.parse(dec.decode(MG.gltfToModel(G.parseGltf(fx.glb), { target: "puppet", slug: "t", scale: 10 }).files.find((f) => f.name === "materials/editor/t.json").data));
    check(gm.passes[0].depthtest === "disabled", "puppet 材质不声明 depthtest 时「2D 场景里的 3D 网格也参与深度」判据变红");
    const mutNrm = gs.replace("const hasNormals = prims.every((p) => !!p.normals);", "const hasNormals = false;");
    check(mutNrm !== gs, "注入点存在（puppet 分支的 hasNormals 判据）");
    const MN = await loadEditorModule("gltf", { [gp]: mutNrm });
    const nm = MN.gltfToModel(G.parseGltf(enc.encode(JSON.stringify(njOf()))), { target: "puppet", slug: "n", scale: 10 }).spec.meshes[0];
    check(nm.normals === undefined && nm.positions.length === 9, "puppet 分支不看法线时「法线随位置一起搬」判据变红");
    const mutOrtho = gs.replace("} else if (isOrthoDoc(doc)) {", "} else if (false && isOrthoDoc(doc)) {");
    check(mutOrtho !== gs, "注入点存在（addModelLayer 的 2D 正交摆放分支）");
    const MO = await loadEditorModule("gltf", { [gp]: mutOrtho });
    const moDoc = mk.makeDoc("t", null, { general: { orthogonalprojection: { width: 1920, height: 1080 } }, objects: [] }, "loose");
    MO.addModelLayer(moDoc, mr.m, "models/editor/t.mdl", "Arm");
    check(json(moDoc.scene.objects.at(-1).origin.split(" ").map(Number)) !== json(oWant.map((v) => +v.toFixed(5))),
      "网格 + 2D 正交场景走相机世界单位摆放时「包围盒中心摆画面中心」判据变红");
  }
  const tree = mk.buildLayerTree(orthoDoc.scene, new Map([["models/editor/t.json", "models/editor/t.mdl"]]));
  check(tree.roots.at(-1).modelForm === "puppet" && mk.buildLayerTree(pDoc.scene, new Map()).roots[0].modelForm === "mesh", "导入层在图层树里认作模型层（puppet / mesh），模型面板全部可用");

  const mainSrc = fs.readFileSync(path.join(ROOT, "editor/main.ts"), "utf8");
  check(/files\.some\(\(f\) => isModelFile\(f\.file\)\) && doc\?\.scene\) \{\s*void importModelFiles\(files\.map\(\(f\) => f\.file\)\);/.test(mainSrc) &&
    /presetMenu\(lyAddModelEl, modelMenuEl, \(p\) => \{\s*modelFormPick = p === "puppet" \|\| p === "mesh" \? p : null;\s*inModelEl\.click\(\);/.test(mainSrc) &&
    /void importModelFiles\(files, modelFormPick\)/.test(mainSrc) && /const form = forceForm \?\? defaultTarget\(target\);/.test(mainSrc) && /lyAddModelEl\.disabled = lyAddEl\.disabled;/.test(mainSrc),
    "页面：图层栏「导入模型」下拉（自动 / puppet / 3D 网格，选完再开文件框）+ 拖入模型文件（自动形态）");
  check(/for \(const x of r\.files\) assets\.put\(x\.name, x\.data, r\.path\);[\s\S]{0,200}target\.puppets = new Map[\s\S]{0,400}structEdit\([\s\S]{0,300}addModelLayer\(d, m, r\.path/.test(mainSrc),
    "导入：产物进资源表（分组 = 对象引用路径）、puppet 登记到 doc.puppets，加层是一步结构编辑（可撤销）");
  check(/const pixelUnits = form === "puppet" \|\| isOrthoDoc\(target\);/.test(mainSrc) && /scale: pixelUnits \? fitPuppetScale\(target\) : fitMeshScale\(target\)/.test(mainSrc),
    "导入：2D 正交场景里两种形态都按像素量几何（fitMeshScale 给的是相机世界单位，mesh 形态会小到看不见）");
  const smSrc = fs.readFileSync(path.join(ROOT, "renderer/src/scene-mount.ts"), "utf8");
  const dmHits = [...smSrc.matchAll(/String\((?:pass0|ppass0)\?\.depthtest \?\? ""\)\.toLowerCase\(\) === "enabled"\) \(layer as any\)\.depthMesh = true;/g)];
  check(dmHits.length === 2, `宿主只有 ${dmHits.length} 处把「材质显式声明 depthtest」翻成 layer.depthMesh（puppet / model 两条装配分支各要一处；判据必须是显式 enabled，不是 F40 的 !== "disabled"）`);
  const htmlSrc = fs.readFileSync(path.join(ROOT, "editor/index.html"), "utf8");
  check(/id="in-model" accept="\.glb,\.gltf,\.fbx,\.obj,\.dae,\.stl,\.ply,\.3ds,\.bin,\.mtl,\.png,\.jpg,\.jpeg,\.tga,\.bmp" multiple hidden/.test(htmlSrc) && /id="ly-add-model"[^>]*aria-haspopup="menu"/.test(htmlSrc) &&
    json([...(htmlSrc.match(/<div id="model-menu"[\s\S]*?<\/div>/)?.[0] ?? "").matchAll(/data-preset="(\w+)" data-et="(md\.\w+)"/g)].map((m) => [m[1], m[2]])) === json([["auto", "md.auto"], ["puppet", "md.puppet"], ["mesh", "md.mesh"]]),
    "页面有导入按钮（带下拉菜单：自动 / puppet / 3D 网格）与多选文件框（各模型格式 + .bin / .mtl / 贴图）");
  const i18nSrc = fs.readFileSync(path.join(ROOT, "editor/i18n.ts"), "utf8");
  const glSrc = ["gltf", "model-ir", "model-import", "fmt-obj", "fmt-stl", "fmt-3ds", "fmt-dae", "fmt-fbx"].map((n) => fs.readFileSync(path.join(ROOT, `editor/${n}.ts`), "utf8")).join("\n");
  const warnCodes = [...new Set([...glSrc.matchAll(/(?:warn\(\{ code: |warnings\.push\(\{ code: |warn\()"(\w+)"/g)].map((m) => m[1]))];
  const failCodes = [...glSrc.matchAll(/new GltfError\("(\w+)"/g)].map((m) => m[1]);
  const keys = ["ly.addModel", "md.auto", "md.puppet", "md.mesh", "gl.form.puppet", "gl.form.mesh", "log.modelImported", "gl.fail.noModel", ...new Set(failCodes.map((c) => `gl.fail.${c}`)), ...warnCodes.map((c) => `gl.warn.${c}`)];
  const missing = keys.filter((k) => (i18nSrc.match(new RegExp(`"${k.replace(/\./g, "\\.")}":`, "g")) ?? []).length !== 2);
  check(warnCodes.length >= 20 && missing.length === 0, `导入文案中英文都有，glTF 与各格式解析器的每个告警 / 失败码都有文案（${warnCodes.length} 个告警码，缺 ${json(missing)}）`);
}

section("MI. 多格式模型导入 editor/model-import.ts（FBX / OBJ / DAE / STL / PLY / 3DS → 内存 glTF → gltfToModel）");
{
  const MI = await loadEditorModule("model-import");
  const G = await loadEditorModule("gltf");
  const P = await imp("renderer/vendor/we-scene/render/mdl-parse.js");
  const S = await imp("renderer/vendor/we-scene/render/mdl-skin.js");
  // 夹具：scripts/fixtures/gen-models.sh（Blender 5.2 + assimp）由同一个场景导出——Z 向上 3 骨蒙皮圆柱 + 30 帧动画 + 上红下蓝贴图
  const FX = path.join(ROOT, "scripts/fixtures/models");
  const sideOf = (n) => {
    const p = path.join(FX, String(n).replace(/\\/g, "/").split("/").pop());
    return fs.existsSync(p) ? new Uint8Array(fs.readFileSync(p)) : null;
  };
  /** 文件 → 引擎（parseMDL + computeSkinMatrices）求值的各时刻顶点、(位置, uv) 五元组 */
  const run = async (file, target, times) => {
    const { gltf, warnings } = await MI.loadModelFile(file, new Uint8Array(fs.readFileSync(path.join(FX, file))), sideOf);
    const m = G.gltfToModel(gltf, { target, slug: "t", fps: 30, scale: 1 });
    const files = G.gltfImportFiles(m, "t");
    const mdl = P.parseMDL(files.files.find((f) => f.name.endsWith(".mdl")).data);
    const layer = [{ animation: m.clips[0].id, blend: 1, rate: 1, visible: true, additive: false }];
    const at = times.map((t) => S.skinnedMeshes(mdl, S.computeSkinMatrices(mdl, t, layer), true).flatMap((x) => [...x.pos]));
    const uv = (mdl.meshes ?? [mdl]).flatMap((x) => [...(x.uvs ?? [])]);
    const puv = [];
    for (let i = 0; i < at[0].length / 3; i++) puv.push(at[0][i * 3], at[0][i * 3 + 1], at[0][i * 3 + 2], uv[i * 2], uv[i * 2 + 1]);
    const png = files.files.find((f) => /\.png$/.test(f.name))?.data ?? null;
    return { m, at, puv, png, warnings: [...warnings, ...m.warnings].map((w) => w.code) };
  };
  // 顶点切分方式各格式不同，按点集比较（双向最近点最大距离）
  const haus = (a, b) => {
    let worst = 0;
    for (const [x, y] of [[a, b], [b, a]]) {
      for (let i = 0; i < x.length; i += 3) {
        let best = Infinity;
        for (let j = 0; j < y.length; j += 3) best = Math.min(best, Math.hypot(x[i] - y[j], x[i + 1] - y[j + 1], x[i + 2] - y[j + 2]));
        worst = Math.max(worst, best);
      }
    }
    return worst;
  };
  const uvErr = (a, b) => {
    let worst = 0;
    for (let i = 0; i < a.length; i += 5) {
      let best = Infinity;
      for (let j = 0; j < b.length; j += 5) {
        if (Math.hypot(a[i] - b[j], a[i + 1] - b[j + 1], a[i + 2] - b[j + 2]) < 1e-4) best = Math.min(best, Math.hypot(a[i + 3] - b[j + 3], a[i + 4] - b[j + 4]));
      }
      worst = Math.max(worst, best);
    }
    return worst;
  };
  const times = [0, 0.2, 0.5, 0.8];
  const ref = await run("rig.glb", "mesh", times);
  check(ref.m.clips.length === 1 && ref.m.clips[0].frameCount === 30 && ref.m.bones === 4, `参考 glb：4 骨、1 个 30 帧片段（${json(ref.m.clips.map((c) => [c.name, c.frameCount]))}）`);
  const rows = [];
  let bad = [];
  // [文件, 有动画, 有 UV, 有贴图]：PLY 有 UV 但格式里没有材质，STL 两者都没有
  for (const [file, animated, hasUv, hasTex] of [["rig.fbx", true, true, true], ["rig-ascii.fbx", true, true, true], ["rig.dae", false, true, true], ["rig.obj", false, true, true], ["rig.3ds", false, true, true], ["rig.ply", false, true, false], ["rig-ascii.ply", false, true, false], ["rig.stl", false, false, false], ["rig-ascii.stl", false, false, false]]) {
    for (const target of ["mesh", "puppet"]) {
      const r = await run(file, target, animated ? times : [0]);
      const pos = Math.max(...r.at.map((v, i) => haus(v, ref.at[i])));
      const uv = hasUv ? uvErr(r.puv, ref.puv) : 0;
      const bnd = Math.max(...[...r.m.bounds].map((v, k) => Math.abs(v - ref.m.bounds[k])));
      const tex = hasTex ? r.png && Buffer.from(r.png).equals(Buffer.from(ref.png)) : true;
      rows.push(`${file}/${target} ${pos.toExponential(1)}`);
      if (!(pos < 1e-5 && uv < 1e-5 && bnd < 1e-5 && tex && r.warnings.length === 0)) bad.push({ file, target, pos, uv, bnd, tex, warn: r.warnings });
      if (animated && target === "mesh" && !(r.m.clips.length === 1 && r.m.clips[0].frameCount === 30)) bad.push({ file, clips: r.m.clips });
    }
  }
  check(bad.length === 0,
    `★ 9 个夹具 × puppet / 网格：引擎求值顶点 vs glb 参考（FBX 二进制 / ASCII 在 t = ${times.join(" / ")} s 含动画，其余静止）点集误差 < 1e-5、(位置, uv) 配对 < 1e-5（UV 朝向）、绑定包围盒一致、贴图字节一致、无告警（${rows.length} 组；不符 ${json(bad.slice(0, 3))}）`);

  // DAE：Z 向上 + 单位 + polylist 四边形 + 节点 rotate 动画（LINEAR / BEZIER）+ instance_node
  const dae = (interp, tangents = "") => `<?xml version="1.0"?>
<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
  <asset><unit name="centimeter" meter="0.01"/><up_axis>Z_UP</up_axis></asset>
  <library_geometries><geometry id="g"><mesh>
    <source id="p"><float_array id="pa" count="12">0 0 0 100 0 0 100 100 0 0 100 0</float_array><technique_common><accessor source="#pa" count="4" stride="3"/></technique_common></source>
    <vertices id="v"><input semantic="POSITION" source="#p"/></vertices>
    <polylist count="1"><input semantic="VERTEX" source="#v" offset="0"/><vcount>4</vcount><p>0 1 2 3</p></polylist>
  </mesh></geometry></library_geometries>
  <library_nodes><node id="lib"><translate>0 0 100</translate><instance_geometry url="#g"/></node></library_nodes>
  <library_visual_scenes><visual_scene id="s">
    <node id="Arm" name="Arm"><translate sid="t">100 0 0</translate><rotate sid="rz">0 0 1 0</rotate><instance_geometry url="#g"/><instance_node url="#lib"/></node>
  </visual_scene></library_visual_scenes>
  <library_animations><animation id="a">
    <source id="in"><float_array id="ina" count="2">0 1</float_array><technique_common><accessor source="#ina" count="2"/></technique_common></source>
    <source id="out"><float_array id="outa" count="2">0 90</float_array><technique_common><accessor source="#outa" count="2"/></technique_common></source>
    <source id="ip"><Name_array id="ipa" count="2">${interp} ${interp}</Name_array><technique_common><accessor source="#ipa" count="2"/></technique_common></source>
    ${tangents}
    <sampler id="sm"><input semantic="INPUT" source="#in"/><input semantic="OUTPUT" source="#out"/><input semantic="INTERPOLATION" source="#ip"/>${tangents ? '<input semantic="IN_TANGENT" source="#it"/><input semantic="OUT_TANGENT" source="#ot"/>' : ""}</sampler>
    <channel source="#sm" target="Arm/rz.ANGLE"/>
  </animation></library_animations>
  <scene><instance_visual_scene url="#s"/></scene>
</COLLADA>`;
  // 期望：Z 向上世界里 Arm = T(1,0,0)·Rz(θ)，lib 子节点再 +Z 1；转 Y 向上 (x, y, z) → (x, z, −y)
  const want = (deg) => {
    const c = Math.cos((deg * Math.PI) / 180), s = Math.sin((deg * Math.PI) / 180);
    const out = [];
    for (const dz of [0, 1]) for (const [x, y] of [[0, 0], [1, 0], [1, 1], [0, 1]]) out.push(1 + c * x - s * y, dz, -(s * x + c * y));
    return out;
  };
  const daeAt = async (src, ts) => {
    const { gltf, warnings } = await MI.loadModelFile("a.dae", enc.encode(src));
    const m = G.gltfToModel(gltf, { target: "mesh", slug: "d", fps: 30, scale: 1 });
    const mdl = P.parseMDL(G.gltfImportFiles(m, "d").files.find((f) => f.name.endsWith(".mdl")).data);
    const layer = [{ animation: m.clips[0].id, blend: 1, rate: 1, visible: true, additive: false }];
    return { m, warnings, at: ts.map((t) => S.skinnedMeshes(mdl, S.computeSkinMatrices(mdl, t, layer), true).flatMap((x) => [...x.pos])) };
  };
  const lin = await daeAt(dae("LINEAR"), [0, 0.5, 29 / 30]);
  const linErr = Math.max(haus(lin.at[0], want(0)), haus(lin.at[1], want(45)), haus(lin.at[2], want(87)));
  check(lin.m.clips[0].frameCount === 30 && linErr < 1e-4 && lin.warnings.length === 0,
    `DAE：Z_UP + 厘米单位 + polylist 四边形扇形三角化 + instance_node + rotate.ANGLE 线性动画：t = 0 / 0.5 / 0.967 s 顶点 vs 手算误差 ${linErr.toExponential(2)}`);
  // 贝塞尔：控制点在 1/3、2/3 处 = 线性；水平切线 = 缓入缓出（t = 0.25 时角度 = 90·(3s²−2s³)，s 由时间方程解出 = 0.25）
  const tan = (a, b) => `<source id="it"><float_array id="ita" count="4">${a}</float_array><technique_common><accessor source="#ita" count="2" stride="2"/></technique_common></source><source id="ot"><float_array id="ota" count="4">${b}</float_array><technique_common><accessor source="#ota" count="2" stride="2"/></technique_common></source>`;
  const bl = await daeAt(dae("BEZIER", tan("0 0 0.6666667 60", "0.3333333 30 1 90")), [0.25]);
  const be = await daeAt(dae("BEZIER", tan("0 0 0.6666667 90", "0.3333333 0 1 90")), [0.25]);
  const easeDeg = 90 * (3 * 0.25 ** 2 - 2 * 0.25 ** 3);
  // 引擎在 30 fps 帧间线性插值，曲线段中点有 ~1e-3 的弦差
  check(haus(bl.at[0], want(22.5)) < 1e-4 && haus(be.at[0], want(easeDeg)) < 3e-3 && haus(be.at[0], want(22.5)) > 0.05,
    `DAE BEZIER：线性切线 t = 0.25 → 22.5°、水平切线缓入缓出 → ${easeDeg.toFixed(2)}°（误差 ${haus(be.at[0], want(easeDeg)).toExponential(1)}）`);

  // OBJ：负下标、四边形、缺 mtl / 贴图告警而不失败
  const obj = await MI.loadModelFile("q.obj", enc.encode("mtllib nope.mtl\nv 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nvt 0 0\nvt 1 1\nusemtl M\nf -4/1 -3/1 -2/2 -1/2\nl 1 2\n"));
  const om = G.gltfToModel(obj.gltf, { target: "mesh", slug: "o", scale: 1 });
  check(om.vertices === 4 && obj.warnings.map((w) => w.code).sort().join() === "lines,missingFile", `OBJ：负下标 + 四边形 → 4 顶点；缺 .mtl 只告警（${json(obj.warnings)}）`);

  // puppet 多材质：拼成图集，纯色材质的 UV 落各自格中心，不再只留一个材质
  const twoMtl = enc.encode("newmtl R\nKd 1 0 0\nnewmtl B\nKd 0 0 1\n");
  const two = await MI.loadModelFile("two.obj", enc.encode("mtllib two.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nv 2 0 0\nv 3 0 0\nv 2 1 0\nusemtl R\nf 1 2 3\nusemtl B\nf 4 5 6\n"), (u) => (u === "two.mtl" ? twoMtl : null));
  const tm = G.gltfToModel(two.gltf, { target: "puppet", slug: "two", scale: 1 });
  const tuv = [...tm.spec.meshes[0].uvs];
  const tex = tm.files.find((f) => f.name === "materials/editor/two.png")?.data;
  const pngWH = tex && [Buffer.from(tex.subarray(16, 20)).readUInt32BE(), Buffer.from(tex.subarray(20, 24)).readUInt32BE()];
  check(tm.spec.meshes.length === 1 && tm.atlas?.cols === 2 && tm.atlas.rows === 1 && tm.atlas.cells.length === 2 &&
    json(tuv.slice(0, 6)) === json([0.25, 0.5, 0.25, 0.5, 0.25, 0.5]) && json(tuv.slice(6)) === json([0.75, 0.5, 0.75, 0.5, 0.75, 0.5]) &&
    json(pngWH) === json([16, 8]) && !tm.warnings.length,
    `puppet 多材质 → 2×1 图集（${json(pngWH)} px）、两个三角形 UV 各落自己格中心（${json(tuv)}）`);

  // FBX 6 及更早：明确报版本
  let ferr = null;
  try {
    await MI.loadModelFile("old.fbx", enc.encode("; FBX 6.1.0 project file\nFBXHeaderExtension:  {\n\tFBXVersion: 6100\n}\n"));
  } catch (e) {
    ferr = e;
  }
  check(ferr?.code === "version" && /FBX 6\.1/.test(ferr.detail), `FBX 6.x 报 version（${ferr?.code} ${ferr?.detail}）`);
  let uerr = null;
  try {
    await MI.loadModelFile("x.abc", new Uint8Array(4));
  } catch (e) {
    uerr = e;
  }
  check(uerr?.code === "format" && G.isModelFile({ name: "A.FBX" }) && G.isModelFile({ name: "b.3ds" }) && !G.isModelFile({ name: "c.mtl" }) && !G.isModelFile({ name: "d.bin" }),
    "未知扩展名报 format；主文件识别不分大小写，.mtl / .bin 算旁路文件");

  // TGA / BMP 贴图 → PNG
  const IR = await loadEditorModule("model-ir");
  const tga = new Uint8Array(18 + 2 * 2 * 3);
  tga.set([0, 0, 2], 0);
  tga.set([2, 0, 2, 0, 24, 0], 12);
  tga.set([0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 0, 0], 18);
  const pngOut = IR.normalizeImage(tga);
  const dv = new DataView(pngOut.buffer, pngOut.byteOffset);
  const idat = pngOut.subarray(41, 41 + dv.getUint32(33));
  const raw = zlib.inflateSync(Buffer.from(idat));
  // 左下原点 → 首行是文件里的第二行（蓝），每行前一个滤波字节
  check(pngOut[1] === 0x50 && dv.getUint32(16) === 2 && dv.getUint32(20) === 2 && json([...raw.subarray(1, 5)]) === json([0, 0, 255, 255]) && json([...raw.subarray(10, 14)]) === json([255, 0, 0, 255]),
    "TGA（24 位、左下原点）→ PNG：尺寸对、行序翻正、BGR → RGBA");
}

// ───────────────────────────────────────────────────────────────────────────
// POINTER-STUDIO. 指针工作室 editor/pointer-studio.ts（§2 B5 / §3 M11）
// ───────────────────────────────────────────────────────────────────────────
section("POINTER-STUDIO. 指针工作室 editor/pointer-studio.ts（B5 / M11）");
{
  const ptrMod = await loadEditorModule("pointer-studio");
  const ptrSrc = fs.readFileSync(path.join(ROOT, "editor/pointer-studio.ts"), "utf8");

  // 边界钳制：归一化 [0,1]，非有限值一律当没有
  const c1 = ptrMod.clampPoint(-1, 2);
  const c2 = ptrMod.clampPoint(0.25, 0.75);
  check(c1 && c1.x === 0 && c1.y === 1 && c2 && c2.x === 0.25 && c2.y === 0.75,
    `clampPoint：越界钳到边上、界内原样（实得 ${json([c1, c2])}）`);
  check(ptrMod.clampPoint(NaN, 0.5) === null && ptrMod.clampPoint(0.5, Infinity) === null && ptrMod.clampPoint(undefined, null) === null,
    "clampPoint：非有限 / 缺值坐标一律拒绝（NaN 进 uniform 会毁整帧）");
  check(ptrMod.clampPoint(null, 0.5) === null && ptrMod.clampPoint("", 0.5) === null && ptrMod.clampPoint("abc", 0.5) === null,
    'clampPoint：数值框清空 / 空串 / 非数字串也算「没有」（Number("") 是 0，那是假坐标）');

  // 停帧摆位：只驱动 uniform，不碰文档
  const doc = freshDoc();
  const before = json(doc);
  const pushes = [];
  let paused = true;
  const studio = ptrMod.createPointerStudio({
    push: (u, v, buttons) => pushes.push([u, v, buttons ?? 0]),
    leave: () => pushes.push(["leave"]),
    isPaused: () => paused,
    clock: () => 0,
    now: () => 0,
  });
  const parkedA = studio.place(0.2, 0.3);
  check(json(pushes) === json([[0.2, 0.3, 0]]) && parkedA && parkedA.x === 0.2 && parkedA.y === 0.3,
    `place：停帧摆位把归一化坐标交给 pushPointer（实得 ${json([pushes, parkedA])}）`);
  const parkedB = studio.place(-1, 5);
  check(parkedB && parkedB.x === 0 && parkedB.y === 1 && json(pushes.at(-1)) === json([0, 1, 0]),
    `place：视口外的坐标钳到边上再驱动（实得 ${json(parkedB)}）`);
  paused = false;
  const nPush = pushes.length;
  check(studio.place(0.4, 0.4) === null && pushes.length === nPush,
    "place：播放中拒绝摆位（每帧都会被场景采样覆盖），且不驱动 uniform");
  check(studio.place(0.4, 0.4, { force: true }) !== null && pushes.length === nPush + 1,
    "place：force 例外（回放前的定位）可以绕过停帧检查");
  paused = true;
  studio.place(0.6, 0.25);
  const resynced = studio.resync();
  check(resynced && json(resynced) === json({ x: 0.6, y: 0.25 }) && json(pushes.at(-1)) === json([0.6, 0.25, 0]),
    "resync：场景重挂后把停帧摆位补推一次（新实例 uniform 归零）");
  studio.release();
  check(json(pushes.at(-1)) === json(["leave"]) && studio.parkedPoint() === null,
    "release：放开指针走 pointerLeave，摆位状态清空");
  // 轨迹片段：洗点 / 序列化往返 / 存储兜底
  const dirty = ptrMod.normalizePoints([
    { t: 120, x: 0.4, y: 0.4 },
    { t: 0, x: -1, y: 0.5 },
    { t: 60, x: NaN, y: 0.2 },
    { t: 60, x: 0.2, y: 0.2 },
    { t: "not-a-time", x: 0.1, y: 0.1 },
    { t: 60, x: 0.3, y: 0.3 },
    { t: null, x: 0.9, y: 0.9 },
    null,
  ]);
  check(json(dirty) === json([{ t: 0, x: 0, y: 0.5 }, { t: 60, x: 0.3, y: 0.3 }, { t: 120, x: 0.4, y: 0.4 }]),
    `normalizePoints：丢非有限 / 钳制 / 同毫秒留最后 / 升序 / t 归零（实得 ${json(dirty)}）`);
  check(json(ptrMod.normalizePoints([])) === "[]" && ptrMod.trackDuration([]) === 0,
    "normalizePoints：空输入 → 空轨迹（没采到点不算错）");

  const made = ptrMod.makeTrack("  描边  ", [{ t: 0, x: 0.1, y: 0.1 }, { t: 500, x: 1.5, y: -0.5 }]);
  check(made && made.v === 1 && made.name === "描边" && made.duration === 500
    && json(made.points) === json([{ t: 0, x: 0.1, y: 0.1 }, { t: 500, x: 1, y: 0 }]),
  `makeTrack：名字 trim、duration = 末点、点洗过（实得 ${json(made)}）`);
  const single = ptrMod.makeTrack("单点", [{ t: 0, x: 0.5, y: 0.5 }]);
  check(single && single.duration === 0 && single.points.length === 1,
    "makeTrack：单点轨迹合法（停帧摆一下也能存成一条）");
  check(ptrMod.makeTrack("空", []) === null && ptrMod.makeTrack("空", [{ t: 0, x: NaN, y: 0 }]) === null,
    "makeTrack：空点集 / 全非有限点 → null，不落库");

  const many = Array.from({ length: ptrMod.MAX_TRACK_POINTS + 5 }, (_, i) => ({ t: i, x: 0.5, y: 0.5 }));
  const thinned = ptrMod.makeTrack("长", many);
  check(thinned.points.length === ptrMod.MAX_TRACK_POINTS
    && thinned.points[0].t === 0
    && thinned.points.at(-1).t === ptrMod.MAX_TRACK_POINTS + 4,
  `makeTrack：超上限按需抽稀到 ${ptrMod.MAX_TRACK_POINTS} 点且首尾保留（实得 ${thinned.points.length} 点，末点 t=${thinned.points.at(-1).t}）`);

  check(json(ptrMod.parseTrack(ptrMod.serializeTrack(made))) === json(made),
    "parseTrack(serializeTrack(track))：深等价，轨迹能原样搬走再读回");
  check(JSON.parse(ptrMod.serializeTrack(made)).v === ptrMod.POINTER_STUDIO_VERSION
    && JSON.parse(ptrMod.serializeTrack(made)).name === "描边",
  "serializeTrack：带上版本号与名字（存下来的东西要能自己说清是什么）");
  const wrong = ptrMod.parseTrack(JSON.stringify({ v: 1, name: "x", duration: 999999, points: [{ t: 100, x: 0.2, y: 0.2 }, { t: 900, x: 0.6, y: 0.6 }] }));
  check(wrong && wrong.duration === 800 && wrong.points[0].t === 0,
    `parseTrack：duration 由点集重算、t 归零（不信外部字段，实得 ${json(wrong)}）`);
  const badRaws = [
    "{", "null", "123",
    JSON.stringify({ v: 2, name: "x", points: [{ t: 0, x: 0, y: 0 }] }),
    JSON.stringify({ v: 1, name: "", points: [{ t: 0, x: 0, y: 0 }] }),
    JSON.stringify({ v: 1, name: "x", points: [] }),
    JSON.stringify({ v: 1, name: "x", points: [{ t: 0, x: null, y: 0 }] }),
    JSON.stringify({ v: 1, name: "x", points: "no" }),
  ];
  check(badRaws.every((raw) => ptrMod.parseTrack(raw) === null),
    `parseTrack：坏 JSON / 版本不符 / 空名 / 空点集 / 点非有限 / points 非数组 一律当没有（${badRaws.length} 例）`);

  const mem = () => {
    const map = new Map();
    return {
      map,
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => void map.set(k, String(v)),
      removeItem: (k) => void map.delete(k),
    };
  };
  const mem2 = mem();
  check(ptrMod.storeTracks(mem2, [made, single]) === true && json(ptrMod.loadTracks(mem2)) === json([made, single]),
    `storeTracks / loadTracks：localStorage 兜底往返一致（键 ${ptrMod.POINTER_TRACKS_KEY}）`);
  check(ptrMod.storeTracks(null, [made]) === false && ptrMod.loadTracks(null).length === 0,
    "storeTracks / loadTracks：没有 storage 时读写都退化成空，不炸页面");
  const boom = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("quota"); }, removeItem: () => {} };
  check(ptrMod.loadTracks(boom).length === 0 && ptrMod.storeTracks(boom, [made]) === false,
    "storage 抛异常（隐私模式 / 配额满）：读空写 false，不抛给调用方");
  check(ptrMod.parseTracks(`{"v":1,"tracks":[null,"x",${ptrMod.serializeTrack(made)}]}`).length === 1
    && ptrMod.parseTracks("").length === 0 && ptrMod.parseTracks("[]").length === 0,
  "parseTracks：坏的一条丢掉、其它照读（手改过 localStorage 也要能起来）");

  // 录制：时间戳来自录制时钟，采完成一条命名轨迹
  const logs = [];
  const recPushes = [];
  let clockMs = 0;
  const recStudio = ptrMod.createPointerStudio({
    push: (u, v, buttons) => recPushes.push([u, v, buttons ?? 0]),
    leave: () => {},
    isPaused: () => false,
    clock: () => clockMs,
    now: () => clockMs,
    log: (msg) => logs.push(msg),
    t: (key, params) => (params ? `${key} ${json(params)}` : key),
    storage: mem2,
  });
  check(recStudio.recording() === false && recStudio.recordingPoints() === 0 && recStudio.list().length === 2,
    "createPointerStudio：一上来不在录制态，轨迹从存储兜底里恢复");
  check(recStudio.startRecord(" 疾走 ") === true && recStudio.recording() === true && recStudio.startRecord("再来") === false,
    "startRecord：进入录制态（重复调用返回 false，不重开一段）");
  clockMs = 40;
  recStudio.record(0.1, 0.2);
  clockMs = 120;
  recStudio.record(1.4, -0.2);
  clockMs = 260;
  recStudio.record(NaN, 0.5);
  check(recStudio.recordingPoints() === 2,
    `record：只收有限坐标（实得 ${recStudio.recordingPoints()} 点；NaN 那个被丢）`);
  const recTrack = recStudio.stopRecord();
  check(recTrack && recTrack.name === "疾走"
    && json(recTrack.points) === json([{ t: 0, x: 0.1, y: 0.2 }, { t: 80, x: 1, y: 0 }])
    && recTrack.duration === 80,
  `record / stopRecord：时间戳相对录制起点、坐标钳制（实得 ${json(recTrack)}）`);
  check(recStudio.list().length === 3 && recStudio.activeName() === "疾走" && json(recStudio.activeTrack()) === json(recTrack),
    "stopRecord：新轨迹进列表并自动选中");
  check(ptrMod.loadTracks(mem2).length === 3,
    "stopRecord：同时写进 localStorage 兜底（内存是真源，存储只是兜底）");
  check(logs.some((m) => m.startsWith("log.ptrRecorded")),
    `stopRecord：记录一条可读日志（实得 ${json(logs.at(-1))}）`);

  recStudio.startRecord("疾走");
  clockMs = 300;
  recStudio.record(0.5, 0.5);
  clockMs = 340;
  recStudio.record(0.6, 0.6);
  const recTrack2 = recStudio.stopRecord();
  check(recTrack2 && recTrack2.name === "疾走 2",
    `重名轨迹自动加序号（名称是选择器的键，重名会指不清；实得 ${recTrack2 && recTrack2.name}）`);
  recStudio.startRecord();
  clockMs = 400;
  recStudio.record(0.5, 0.5);
  const nTracks = recStudio.list().length;
  const autoTrack = recStudio.stopRecord();
  check(autoTrack && autoTrack.name.startsWith("ptr.defaultName") && recStudio.list().length === nTracks + 1,
    `stopRecord：没填名字就用默认名（走 i18n 的 ptr.defaultName；实得 ${autoTrack && autoTrack.name}）`);
  recStudio.startRecord("空的");
  const beforeEmpty = recStudio.list().length;
  check(recStudio.stopRecord() === null && recStudio.list().length === beforeEmpty
    && logs.some((m) => m.startsWith("log.ptrNoPoints")),
  "stopRecord：一个点都没采到 → 不落库并提示（log.ptrNoPoints）");
  recStudio.startRecord("丢掉");
  recStudio.record(0.5, 0.5);
  recStudio.cancelRecord();
  check(recStudio.recording() === false && recStudio.list().length === beforeEmpty
    && !recStudio.list().some((t) => t.name === "丢掉"),
  "cancelRecord：直接丢掉这段录制，不落库（半截轨迹不该污染列表）");
  const delName = recStudio.activeName();
  check(recStudio.remove(delName) === true && recStudio.list().length === beforeEmpty - 1 && recStudio.activeName() !== delName
    && ptrMod.loadTracks(mem2).length === beforeEmpty - 1,
  "remove：删轨迹同时更新存储并换选中项");
  check(recStudio.remove("没这条") === false && recStudio.list().length === beforeEmpty - 1,
    "remove：删不存在的名字返回 false，不动列表");

  // 时间轴插值：回放的取样口径
  const line = [{ t: 0, x: 0, y: 0 }, { t: 1000, x: 1, y: 0.5 }];
  check(json(ptrMod.sampleTrack(line, -50)) === json({ t: 0, x: 0, y: 0 })
    && json(ptrMod.sampleTrack(line, 5000)) === json({ t: 1000, x: 1, y: 0.5 }),
  "sampleTrack：早于首点钉首点、晚于末点钉末点（不外推）");
  const mid = ptrMod.sampleTrack(line, 250);
  check(mid && mid.x === 0.25 && mid.y === 0.125 && mid.t === 250,
    `sampleTrack：两点之间线性插值（实得 ${json(mid)}）`);
  check(ptrMod.sampleTrack([], 100) === null && ptrMod.sampleTrack(line, NaN) === null,
    "sampleTrack：空轨迹 / 非有限时刻 → null");
  check(json(ptrMod.sampleTrack([{ t: 500, x: 0.4, y: 0.6 }], 0)) === json({ t: 500, x: 0.4, y: 0.6 }),
    "sampleTrack：单点轨迹任何时刻都钉在那一点");

  // 回放：跟着时间轴播放头走，超长折回
  let clockMs2 = 0;
  const repPushes = [];
  const repLogs = [];
  const repStudio = ptrMod.createPointerStudio({
    push: (u, v, buttons) => repPushes.push([u, v, buttons ?? 0]),
    leave: () => {},
    isPaused: () => true,
    clock: () => clockMs2,
    now: () => clockMs2,
    log: (msg) => repLogs.push(msg),
    t: (key) => key,
    storage: null,
  });
  check(repStudio.replaying() === false && repStudio.tick() === null && repStudio.startReplay() === false,
    "回放：一条轨迹都没有时启动失败，tick 不驱动 uniform");
  repStudio.startRecord("圈");
  clockMs2 = 0;
  repStudio.record(0, 0);
  clockMs2 = 1000;
  repStudio.record(1, 0.5);
  repStudio.stopRecord();
  clockMs2 = 0;
  check(repStudio.startReplay("圈") === true && repStudio.replaying() === true
    && json(repPushes.at(-1)) === json([0, 0, 0]),
  "startReplay：开局先按当前播放头摆一次");
  clockMs2 = 250;
  repStudio.tick();
  check(json(repPushes.at(-1)) === json([0.25, 0.125, 0]),
    `tick：按播放头在轨迹上取样驱动 uniform（实得 ${json(repPushes.at(-1))}）`);
  clockMs2 = 1250;
  repStudio.tick();
  check(json(repPushes.at(-1)) === json([0.25, 0.125, 0]),
    "tick：播放头超过轨迹长度就折回（场景在循环，轨迹跟着循环）");
  clockMs2 = 0;
  repStudio.tick();
  check(json(repStudio.replayAt()) === json({ t: 0, x: 0, y: 0 }) && repStudio.replayName() === "圈",
    "replayAt / replayName：回放光标停在取样点上，供菜单显示");
  check(repLogs.includes("log.ptrReplay"), "startReplay：记录一条可读日志（log.ptrReplay）");
  check(repStudio.stopReplay() === true && repStudio.replaying() === false
    && repStudio.tick() === null && repStudio.stopReplay() === false,
  "stopReplay：停下来后 tick 不再驱动 uniform（重复调用返回 false）");
  repStudio.startReplay("圈");
  clockMs2 = 500;
  repStudio.tick();
  const resyncRep = repStudio.resync();
  check(repStudio.replaying() === true && resyncRep && resyncRep.x === 0.5 && resyncRep.y === 0.25,
    `resync：回放中重挂按回放取样补推（优先于停帧摆位，实得 ${json(resyncRep)}）`);
  clockMs2 = 0;
  repStudio.tick();
  check(repStudio.startRecord("截") === true && repStudio.replaying() === false,
    "startRecord：录制与回放抢同一根指针，开录先停回放");
  repStudio.cancelRecord();
  check(repStudio.startRecord("截") === true, "startRecord：取消后可重开一段");
  clockMs2 = 0;
  repStudio.record(0.2, 0.2);
  clockMs2 = 500;
  repStudio.record(0.8, 0.8);
  repStudio.stopRecord();
  repStudio.startReplay("截");
  check(repStudio.place(0.3, 0.3) !== null && repStudio.replaying() === false,
    "place：手动摆位优先于回放（摆了就停回放，否则下一帧又被轨迹盖掉）");
  repStudio.startReplay("截");
  check(repStudio.remove("截") === true && repStudio.replaying() === false
    && repLogs.includes("log.ptrReplayStop"),
  "remove：删掉正在回放的那条轨迹会先停回放");
  check(repLogs.filter((m) => m === "log.ptrReplayStop").length >= 2,
    "stopReplay：每次停下都记一条日志（log.ptrReplayStop）");

  check(json(doc) === before,
    "停帧摆位不改文档：反复摆位后文档快照逐字节一致（指针对场景是纯运行时状态）");
  check(!/from "\.\/(save|export-pipeline|doc|history)"/.test(ptrSrc),
    "指针工作室不 import 保存 / 导出 / 文档 / 撤销栈：它只驱动 uniform，不参与文档记账");

  // 导出边界：scene.json 没有指针字段（计划 §6 决策 3）→ 离线导出产物里不含任何指针数据
  check(ptrMod.findPointerFields({ a: 1, cursor: { x: 1 } }).length === 0
    && json(ptrMod.findPointerFields({ a: { PointerPosition: 1 }, b: [{ pointerButtons: 2 }] })) === json(["a.PointerPosition", "b[0].pointerButtons"]),
  "findPointerFields：扫出键名沾 pointer 的字段路径（含嵌套 / 数组），干净的产物返回空");
  const expDoc = freshDoc();
  const expFiles = await saveMod.collectProject(expDoc, memAssets("scene.json", {}), null);
  const expTexts = expFiles.map((f) => [f.path, dec.decode(f.data)]);
  const expJsonEntries = expTexts.filter(([p]) => /\.json$/i.test(p));
  const expHits = expJsonEntries.flatMap(([p, text]) => {
    try {
      return ptrMod.findPointerFields(JSON.parse(text)).map((field) => `${p}:${field}`);
    } catch {
      return [`${p}:<不是 JSON>`];
    }
  });
  check(expHits.length === 0 && expJsonEntries.length >= 2,
    `导出产物里没有指针字段：扫了 ${expJsonEntries.length} 个 json（scene.json / project.json），命中 ${json(expHits)}`);
  check(expTexts.every(([, text]) => !text.includes(ptrMod.POINTER_TRACKS_KEY) && !/pointer/i.test(text)),
    "导出产物文本里既没有轨迹存储键、也没有 pointer 字样（指针只在内存 / localStorage 兜底里）");
  check(!expFiles.some((f) => /pointer/i.test(f.path)),
    "导出清单里没有指针相关条目（轨迹不进 zip、不进保存清单）");
  const saveSrc = fs.readFileSync(path.join(ROOT, "editor/save.ts"), "utf8");
  const pipeSrc = fs.readFileSync(path.join(ROOT, "editor/export-pipeline.ts"), "utf8");
  check(!/pointer/i.test(saveSrc) && !/pointer/i.test(pipeSrc),
    "导出器不改行为：save.ts / export-pipeline.ts 里一个字都没动（指针工作室没接进去）");

  // i18n：新键必须 zh + en 各一次（verify 的「键恰好出现 2 次」断言）
  const mainSrc = fs.readFileSync(path.join(ROOT, "editor/main.ts"), "utf8");
  const pageSrc = fs.readFileSync(path.join(ROOT, "editor/index.html"), "utf8");
  const cssSrc = fs.readFileSync(path.join(ROOT, "editor/editor.css"), "utf8");
  const i18nSrc = fs.readFileSync(path.join(ROOT, "editor/i18n.ts"), "utf8");
  const keySrc = `${ptrSrc}\n${mainSrc}\n${pageSrc}`;
  const ptrKeys = [...new Set([...keySrc.matchAll(/"((?:ptr\.|log\.ptr)[A-Za-z.]+)"/g)].map((m) => m[1]))];
  const keyHits = ptrKeys.filter((k) => (i18nSrc.match(new RegExp(`"${k.replace(/\./g, "\\.")}":`, "g")) ?? []).length !== 2);
  check(ptrKeys.length >= 24 && keyHits.length === 0,
    `指针工作室的 ${ptrKeys.length} 个文案键在 editor/i18n.ts 里 zh / en 各恰好一次（不齐的：${json(keyHits)}）`);
  check(ptrKeys.includes("ptr.exportNote") && /data-et="ptr\.exportNote"/.test(pageSrc),
    "导出边界提示有对应文案键 ptr.exportNote（菜单里那行说明走 i18n，不是硬编码）");

  // 接线：main.ts / index.html / editor.css
  check(/from "\.\/pointer-studio"/.test(mainSrc) && mainSrc.includes("createPointerStudio({")
    && mainSrc.includes("instance?.pushPointer(") && mainSrc.includes("instance?.pointerLeave("),
  "main.ts：指针工作室接到引擎的 pushPointer / pointerLeave 上（没有新造通道）");
  check(mainSrc.includes("pointerStudio.resync()") && mainSrc.includes("pointerStudio.tick()")
    && mainSrc.includes("pointerStudio.startReplay(") && mainSrc.includes("pointerStudio.stopRecord()"),
  "main.ts：重挂后 resync、时间轴 tick、菜单的回放 / 录制都接上了");
  check(pageSrc.includes('id="tb-pointer"') && pageSrc.includes('id="pointer-menu"')
    && pageSrc.includes('id="ptr-tracks"') && pageSrc.includes('id="ptr-play"') && pageSrc.includes('id="ptr-del"')
    && pageSrc.includes('data-et="ptr.exportNote"'),
  "index.html：视口工具条按钮 + 菜单（摆位 / 录制 / 回放 / 删除 + 导出边界提示）都在");
  check(cssSrc.includes(".ed-pointer-menu") && cssSrc.includes(".ed-pointer-row") && cssSrc.includes(".ed-pointer-note"),
    "editor.css：指针工作室菜单的样式都在（沿用 .ed-menu 的 fixed 定位）");
}

// ───────────────────────────────────────────────────────────────────────────
// I. 接线文本断言
// ───────────────────────────────────────────────────────────────────────────
section("I. 接线");
{
  const main = fs.readFileSync(path.join(ROOT, "editor/main.ts"), "utf8");
  check(/from "\.\/gizmo"/.test(main) && /from "\.\/history"/.test(main), "页面从 gizmo.ts / history.ts 取手柄几何与记账（单测覆盖的就是页面在用的）");
  check(!/function gizmoOf|function handleAt|Math\.atan2|undoStack\s*[:=]|function findPath/.test(main), "页面里没有长回手柄 / 旋转 / 撤销栈 / 树查找的内联副本");
  check(/hitTestAt\([^)]*\)\.filter\(\(h\) => !isLocked\(h\.id\)\)/.test(main), "画面点选过滤锁定层");
  check(/dir = await pickDirectoryWithGesture\(\);/.test(main) && !/await pickDirectory\(\);\s*\}\s*catch \(e\) \{\s*log\(et\("log\.pickFailed"/.test(main) &&
    /name !== "SecurityError"\) throw e;[\s\S]{0,300}#pick-dir-ok"\)\.onclick = \(\) => \{[\s\S]{0,60}const p = pickDirectory\(\);/.test(main) && /id="pick-dir-dlg"/.test(fs.readFileSync(path.join(ROOT, "editor/index.html"), "utf8")),
    "选文件夹没有用户手势（文件框 change / 拖放之后）被拒时，弹确认框在那次点击里同步重新调用选择器");
  check(/isLocked\(selectedId\)[^\n]*return;/.test(main), "锁定层不能拖拽");
  check(/form\.disabled = isLocked\(id\)/.test(main), "锁定层检视器只读");
  check(/docDriven && current\.assets && doc\?\.scene\s*\?\s*sourceFromDoc/.test(main), "结构编辑后改从文档挂载");
  check(/await replayLiveEdits\(\)/.test(main) && /editor\.seek\(resumeAt > 0 \? resumeAt : editor\.time\)/.test(main), "重挂后重放热改、回到原时间点（停着时也补画一帧，文字层首帧没贴图）");
  for (const key of ['"z"', '"y"', '"s"', '"d"', '"Delete"', '"Backspace"']) {
    check(main.includes(key), `快捷键 ${key} 已绑定`);
  }
  check(/collectProject\(doc, current\.assets, preview, undefined, unreadable\)/.test(main) && /writeToDirectory\(dir, changed\)/.test(main) && !/saveToLibrary\(/.test(main), "自动保存走 collectProject 写进项目文件夹，页面不再写壁纸库");
  // 审计 M2：读不到的资源留在磁盘上
  check(main.includes("const unreadable = new Set<string>();") && main.includes("if (unreadable.has(p)) continue;"),
    "这一轮读不到字节、但仍被引用的资源不删已写出文件（审计 M2）");
  // 审计 M1：写盘失败不能清草稿（两份调用点都要先看返回值）
  check((main.match(/if \(await flushAutosave\(\)\) clearOwnDraftSlot\(prevSlot\);/g) || []).length === 2,
    "另存为 / 存到本机文件夹：只有真的写出去了才清草稿（审计 M1）");
  check(main.includes("async function flushAutosave(): Promise<boolean>"),
    "flushAutosave 回报成败（调用方不再无从区分）");
  // 审计 H1：没有目录 / 库条目的会话文档，草稿槽带每文档标识，两个未命名文档不共用槽
  check(main.includes("const sessionSlotKeys = new WeakMap<EditorDoc, string>();")
    && main.includes("sessionKey: !vdirId && !localName && !libraryItemId && doc ? sessionSlotKey(doc) : null"),
    "会话文档的草稿槽带每文档标识（审计 H1：不再互相覆盖 / 误清快照）");
  check(/from "\.\/create"/.test(main) && /from "\.\/assets"/.test(main), "页面从 create.ts / assets.ts 取模板与资源表");
  check(/overlayAssets\(opened\.assets\.entry, opened\.assets, \(\) => referencedGroups\(doc\)\)/.test(main), "打开即套资源表叠加层，保存清单按文档引用过滤");
  check(/const referencedGroups = [^;]*referencedModels\(d\)[^;]*referencedEffects\(d\)[^;]*referencedFonts\(d\)[^;]*referencedParticles\(d\)[^;]*referencedSounds\(d\)/.test(main), "引用集合 = 图片层模型 ∪ 效果文件 ∪ 工程字体 ∪ 粒子文件 ∪ 音频（写进来的文件随引用进出保存清单）");
  check(/from "\.\/effects"/.test(main) && /function objEdit\([^\n]*\) \{\s*structEdit\(/.test(main), "效果面板从 effects.ts 取定义，修改走结构编辑（可撤销、整场景重挂）");
  check(/overlay\.put\(f\.name, f\.data, effectFileOf\(fxId\)\)/.test(main), "添加效果时把四件写进叠加层，分组 = effect.json 路径");
  check(/inp\.addEventListener\("change", \(\) => commit\(/.test(main), "参数在 change 时提交（拖动中只更新读数，不反复重挂）");
  check(/checkSceneScript,\s*\n\s*editorOf,/.test(main) && /from "\.\/scripts"/.test(main), "脚本面板：预检取库出口 checkSceneScript，挂点读写取 editor/scripts.ts");
  check(/apply\.disabled = !editable \|\| !ok \|\| ta\.value === s\.script/.test(main), "语法不过 / 未改动时「应用」不可点");
  check(/objEdit\([^\n]*setScript\(o, s\.target, ta\.value\)\)/.test(main), "应用脚本走结构编辑（可撤销、整场景重挂，新脚本当帧生效）");
  check(/editor\?\.getScriptIssues\(\)/.test(main) && /refreshScriptIssues\(\);\s*(syncScriptsBanner\(\);\s*)?\}, 500\)/.test(main), "运行期错误从控制面 getScriptIssues 取，定时刷新到对应挂点");
  check(/scriptDrafts\.clear\(\)/.test(main) && /scriptDrafts\.get\(draftKey\) \?\? s\.script/.test(main), "未应用的脚本改动在检视器重绘时保留，换文档清空");
  check(/from "\.\/userprops"/.test(main) && !/general\.properties\s*=/.test(main), "用户属性面板从 userprops.ts 读写声明 / 绑定（页面不直接改属性表）");
  check(/sourceFromDoc\(current\.source, current\.assets, JSON\.stringify\(doc\.scene\), doc\.project\)/.test(main), "文档挂载连 project 一起以文档为准（声明随重挂进引擎）");
  check(/restoreObjects\(cmd\.after, cmd\.selAfter, cmd\.propsAfter\)/.test(main) && /dir === "undo" \? cmd\.propsBefore : cmd\.propsAfter/.test(main), "结构编辑 / 撤销 / 重做把属性表快照一并换回");
  check(/if \(hot && editor && \(hotAlways \|\| cmd\.after === cmd\.before\)\)/.test(main) && /editor\?\.declareUserProperties\(\{ \[name\]: p \}\)/.test(main), "只改属性表时走热更（declareUserProperties），不重挂");
  check(/inp\.addEventListener\("input", \(\) => \{[^}]*previewProp\(p, inp\.value\)/.test(main), "拖滑条中只推引擎预览，change 才入栈");
  check(/objEdit\([^\n]*\n?[^\n]*\n?[^\n]*node\.id,\s*\n\s*\(o\) => \(v \? !!doc && bindProp\(doc, o, f\.field, name, cond\) : unbindProp\(o, f\.field\)\)/.test(main), "绑定 / 解绑走结构编辑（可撤销、整场景重挂）");
  const sm = fs.readFileSync(path.join(ROOT, "renderer/src/scene-mount.ts"), "utf8");
  check(/declareUserProperties\(decls[^)]*\) \{[^}]*applyLiveProps\(/.test(sm) && /\(\(scene as any\)\.properties \|\|= \{\}\)/.test(sm), "控制面 declareUserProperties 走属性热更链（无属性表的场景也挂一张）");
  check(/const uS = boundUserName\(src\.scale\);[^\n]*\n[^\n]*setLayerPropsImpl\(layer\.id, \{ scale: scn\.parseVec3\(src\.scale\) \}\)/.test(sm), "scale 绑 slider 热更：写 local 槽并重合成子树");
  check((sm.match(/noteScriptIssue\((layer|null), /g) ?? []).length === 4, "引擎登记四类挂点的脚本错误：对象字段 / 文字 / 效果开关 / general");
  check(/getScriptIssues\(\) \{\s*return \[\.\.\.scriptIssues\.values\(\)\]/.test(sm) && /const scriptIssues = new Map/.test(sm), "控制面 getScriptIssues 读本次装配的登记表（每次装配重建）");
  const i18n = fs.readFileSync(path.join(ROOT, "editor/i18n.ts"), "utf8");
  const missingFx = [];
  for (const e of fxMod.EFFECTS) {
    for (const k of [`fx.${e.id}`, ...e.params.map((p) => `fxp.${p.key}`)]) {
      if ((i18n.match(new RegExp(`"${k.replace(".", "\\.")}":`, "g")) ?? []).length !== 2) missingFx.push(k);
    }
  }
  check(/function renderKeyMarks\(\) \{\s*tlKeysEl\.textContent = "";\s*renderLanes\(\);/.test(main) && /const sum = canAnimate\(n\) \? animSummary\(n\.obj\) : null;/.test(main) && /row\.addEventListener\("click", \(\) => selectLayer\(node\.id\)\)/.test(main), "按层动画条随关键帧标记一起重画（每次文档 / 选中变化），点行选中该层");
  check(/objEditOk\(et\("log\.keyPasted"[^\n]*\(o\) => pasteKeysAt\(o, clip, at\)\)/.test(main) && /keyClip = copyKeysAt\(node\.obj, nowTime\(\)\)/.test(main), "粘贴关键帧走结构编辑（可撤销），复制取当前时刻");
  check(/<div id="tl-lanes" hidden><\/div>/.test(fs.readFileSync(path.join(ROOT, "editor/index.html"), "utf8")) && ["anim.copy", "anim.paste", "anim.copyNone", "anim.pasteNone", "log.keyCopied", "log.keyPasted", "log.keyPasteBad"].every((k) => (i18n.match(new RegExp(`"${k.replace(".", "\\.")}":`, "g")) ?? []).length === 2), "页面有动画条容器；复制 / 粘贴文案中英文都有");
  check(missingFx.length === 0, `效果名 / 参数名中英文都有（缺 ${json([...new Set(missingFx)])}）`);
  check(/structEdit\([^\n]*placeImages\(d, imgs, false\)\)/.test(main), "添加图片层走结构编辑（可撤销、整场景重挂）");
  check(/structEdit\([^\n]*placeVideos\(d, vids, false\)\)/.test(main) && /from "\.\/video"/.test(main), "添加视频层走结构编辑（可撤销、整场景重挂），转码 / 判型取 video.ts");
  check(/files\.every\(\(f\) => isVideoFile\(f\.file\)\)\)/.test(main), "拖入全是视频时走视频成层 / 新建");
  check(/if \(doc\?\.video\) \{\s*const vs = await mountVideoStage\(stageEl, doc\.video\.bytes/.test(main), "视频壁纸工程挂编辑器自有 <video> 预览（时间轴 / 播放 / 逐帧复用同一套控制面）");
  check(/edits\.push\(\{ kind: "video", label, before: \{ \.\.\.doc\.video \}, after \}\)/.test(main) && /if \(isVideoCmd\(cmd\)\) \{\n[^\n]*\n\s*setProjectVideo\(dir === "undo" \? cmd\.before : cmd\.after\)/.test(main), "裁剪 / 替换视频入撤销栈，撤销重做整段换回视频字节");
  check(/readVideos\(\[src\], true, \{ start, end \}\)/.test(main), "应用裁剪按入出点重新编码（保留音轨）");
  check(/await createNew\(\[\], dir, \[file\], title, res\)/.test(main), "视频壁纸转场景：另选文件夹新建，视频铺底、分辨率取视频本身");
  check(/if \(doc\?\.video\) return collectVideoProject\(doc, preview\)/.test(main) && /const canSave = \(\) => !!doc\?\.video \|\|/.test(main), "视频壁纸工程也自动保存 / 导出（视频 + 封面 + project.json）");
  check(/frameAt: \(t\) => ed\.captureFrame\(\{ time: t, width: w, height: h, keepSize: true \}\)/.test(main) && /await seekLogged\(ed\.seek\(t0\)\)/.test(main), "录制视频：逐帧 captureFrame（不编码、保持尺寸），录完回到原时刻");
  check(/if \(opts\.time !== undefined\) await seekImpl\(opts\.time, false\)/.test(sm) && /captureFrame: \(opts = \{\}\) => captureFrameImpl\(opts\)/.test(sm), "引擎 captureFrame：定位不额外画帧，出图直接给 canvas");
  check(/return Promise\.all\(pairs\.map\(\(p\) => p\.seek\(t\)\)\)|const ready = Promise\.all\(pairs\.map\(\(p\) => p\.seek\(t\)\)\)/.test(sm) && /for \(const p of rt\.videoPairs \?\? \[\]\) p\.setRate\(clockScale\)/.test(sm), "引擎 seek / 倍速同步视频贴图（等 seeked 再画）");
  check(/materials\/\$\{name\}\.mp4/.test(sm) && /encodeTexVideo\(/.test(sm), "松散工程 materials/X.mp4 在内存里包成视频 .tex 走同一条路径");
  const vkeys = ["ly.addVideo", "new.video", "new.videoWallpaper", "kind.video", "vp.title", "vp.applyTrim", "vp.replace", "vp.toScene", "export.video", "rec.title", "rec.start", "log.recorded", "log.trimmed", "log.videoReady"];
  check(vkeys.every((k) => (i18n.match(new RegExp(`"${k.replace(".", "\\.")}":`, "g")) ?? []).length === 2), "视频相关文案中英文都有");
  const edHtml = fs.readFileSync(path.join(ROOT, "editor/index.html"), "utf8");
  check(["ly-add-video", "new-video", "new-video-wp", "export-video", "in-video", "rec-menu", "rec-start", "rec-cancel"].every((id) => edHtml.includes(`id="${id}"`)), "页面有视频入口：加视频层 / 新建两种 / 录制面板 / 文件框");
  check(/files\.every\(\(f\) => isImageFile\(f\.file\)\)\) \{\s*void dropImages\(files\.map\(\(f\) => f\.file\), dir\)/.test(main), "拖入全是图片时走图片成层 / 新建");
  check(/dirty = false;\s*syncDocTitle\(\);/.test(main) && /function scheduleAutosave\(\)/.test(main), "自动保存成功后清掉脏标记");
  check(/function markDirty\(\) \{\s*scheduleAutosave\(\);/.test(main), "每次编辑都排一次自动保存");
  const html = fs.readFileSync(path.join(ROOT, "editor/index.html"), "utf8");
  check(/id="tb-new"(?![^>]*disabled)/.test(html) && /id="ly-add"/.test(html) && /id="in-image" accept="image\/\*"/.test(html) && /id="ed-draft"/.test(html), "页面：新建可用，有添加图片 / 图片选择框 / 草稿横幅");
  check(/const EDITOR_MARK = "\.webwallgl-editor"/.test(HOST_TS) && /exists && !marked/.test(HOST_TS), "宿主：无标记目录拒绝覆盖");
  {
    const pipe = fs.readFileSync(path.join(ROOT, "editor/export-pipeline.ts"), "utf8");
    check(/runExportPipeline\(id, target, /.test(main) && !/packProject/.test(main) && /id: "pkg",[\s\S]{0,400}pack: \(ctx\) => \{\s*if \(!ctx\.doc\.scene\) return ctx\.files;\s*const \{ files, packed \} = packProject\(ctx\.files\);/.test(pipe), "导出 scene.pkg 走导出管线：pkg 导出器的 pack 段过 packProject，不写进项目文件夹");
  }
  check(/id="export-pkg"/.test(html) && /id="export-zip"/.test(html) && !/id="save-lib"/.test(html), "导出菜单是 scene.pkg / zip，没有另存到库");
  {
    // 播放与编辑同页：没有模式切换，预览能力都是面板标签
    const tabsOf = (id) => {
      const at = html.indexOf(`id="${id}"`);
      const head = at < 0 ? "" : html.slice(at, html.indexOf("data-pane=", at));
      return [...head.matchAll(/data-tab="(\w+)"/g)].map((m) => m[1]);
    };
    check(!/wb-modes|id="act-bench"|href="\.\.\/"/.test(html) && /<button type="button" class="wb-icon-btn" id="ed-help"/.test(html), "工作台没有「预览 / 编辑器」模式切换，帮助按钮在页内打开使用说明");
    check(json(tabsOf("ed-layers")) === json(["layers", "library"]) && json(tabsOf("ed-center")) === json(["viewport", "docs"]) &&
      json(tabsOf("ed-console")) === json(["console", "perf"]) && json(tabsOf("ed-right")) === json(["inspector", "config"]),
      `面板标签：左 图层|壁纸库，中 视口|使用说明，底 控制台|性能，右 检视器|壁纸配置（${json([tabsOf("ed-layers"), tabsOf("ed-center"), tabsOf("ed-console"), tabsOf("ed-right")])}）`);
    check(["lib-list", "lib-filter", "type-filter", "lib-refresh", "lib-pick", "docs-body", "sponsor-card", "perf-canvas", "props-body", "props-reset", "fps", "volume", "aa", "pq", "pp"].every((id) => html.includes(`id="${id}"`)) &&
      /href="\/editor\/preview\.css"/.test(html), "页面装上了壁纸库 / 使用说明 / 性能 / 壁纸配置 / 渲染设置的控件与样式");
    // 渲染选项从右侧标签搬进视口工具条的弹出菜单：控件 id 一个不少，标签和面板都不再存在
    const edCss = fs.readFileSync(path.join(ROOT, "editor/editor.css"), "utf8");
    check(/id="tb-render-opts"/.test(html) && /id="render-menu"/.test(html) && /id="tb-dpr"/.test(html) &&
      html.indexOf('id="tb-dpr"') < html.indexOf('id="tb-render-opts"') &&
      !/data-tab="render"/.test(html) && !/data-pane="render"/.test(html) &&
      /\.ed-render-menu/.test(edCss) &&
      /const renderOptsEl = \$<HTMLButtonElement>\("#tb-render-opts"\)/.test(main) && /const renderMenuEl = \$<HTMLElement>\("#render-menu"\)/.test(main) &&
      /function closeRenderMenu\(\)/.test(main) && /renderOptsEl\.onclick = \(e\) => \{\s*e\.stopPropagation\(\);/.test(main) &&
      /renderMenuEl\.hidden = false;/.test(main),
      "「渲染选项」菜单挂在视口工具条渲染 DPR 之后：控件 id 不变（fps/volume/aa/pq/pp），右侧不再有「渲染」标签与面板，弹出按导出菜单那套定位");
    check(/"render\.opts": "渲染选项"/.test(i18n) && /"render\.opts": "Render options"/.test(i18n), "「渲染选项」按钮中英文文案齐");
    check(/initTabs\(\$\("#ed-layers"\)/.test(main) && /initTabs\(\$\("#ed-center"\)/.test(main) && /initTabs\(\$\("#ed-console"\)/.test(main) && /initTabs\(\$\("#ed-right"\)/.test(main),
      "四个面板都按标签切换");
    check(/openWith\(it\.title, \(\) => openLibraryItem\(it, MEDIA_BASE, WEB_BASE\), \{ origin: \{ kind: "library" \}, library: it, play: true \}\)/.test(main) &&
      /if \(opts\.library\) releaseProject\(\);/.test(main) && /libItem = opts\.library \?\? null;/.test(main),
      "壁纸库条目直接在编辑器里打开并播放；先解绑上一个项目文件夹（不会把它自动保存进别的工程）");
    check(/cmd\(\{ id: "file\.save", keys: "Mod\+S", run: \(\) => void saveDocument\(\) \}\)/.test(main) &&
      /async function saveDocument\(\) \{\s*if \(projectDir\) \{\s*await flushAutosave\(\);\s*return;\s*\}[\s\S]{0,300}const dir = await requireProjectDir\(\);[\s\S]{0,80}adoptProject\(dir\);/.test(main),
      "⌘S：有项目文件夹就写回，库条目先选文件夹另存为项目");
    check(/\.\.\.renderSettings\.mountOptions\(\),/.test(main) && /properties: libItem \? \(wallpaperConfig\.overrides\(\)/.test(main),
      "挂载带上渲染设置（帧率 / 音量 / 画质）与库条目的属性覆盖值");
    check(/instance\.setProperties\(values as Record<string, PropertyValue>\)/.test(main) && /reload: \(\) => void mountCurrent\(true\)/.test(main),
      "壁纸配置：场景就地热更，网页 / 视频保存后重挂");
    check(/const item = new URL\(location\.href\)\.searchParams\.get\("item"\);[\s\S]{0,300}await openLibrary\(it\);/.test(main) && /#docs\(\?:=\(\\w\+\)\)\?\$/.test(main),
      "?item= 直接打开库条目，#docs=editor|library 直达使用说明");
    const root = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
    check(/location\.replace\("\.\/editor\/" \+ location\.search \+ location\.hash\)/.test(root) && !/bench\/main\.ts/.test(root), "根入口转到工作台（带上 query / hash）");
    const gone = ["main", "session", "bridge", "library", "viewport", "perf", "props-panel", "render-settings", "info-panel", "statusbar", "store", "console", "layout"].filter((n) => fs.existsSync(path.join(ROOT, `bench/${n}.ts`)));
    check(gone.length === 0 && !fs.existsSync(path.join(ROOT, "bench/bench.css")), `旧预览页模块已删除（残留 ${json(gone)}）`);
    const keys = ["sec.render", "render.hint", "lib.props", "lib.open", "lib.play", "lib.discardConfirm", "log.libUnsupported", "log.libItemMissing", "log.cannotSaveKind", "log.savedAsProject", "st.library", "st.libDirty", "st.saveAsTitle", "props.noLibraryItem"];
    const miss = keys.filter((k) => (i18n.match(new RegExp(`"${k.replace(/\./g, "\\.")}":`, "g")) ?? []).length !== 2);
    check(miss.length === 0, `工作台新增文案中英文都有（缺 ${json(miss)}）`);
    const docsTs = fs.readFileSync(path.join(ROOT, "bench/docs.ts"), "utf8");
    const plDocs = fs.readFileSync(path.join(ROOT, "bench/docs-plugins.ts"), "utf8");
    const plIds = [...plDocs.matchAll(/id: "(pl-\w+)"/g)].map((m) => m[1]);
    check(/DOC_KINDS: DocKind\[\] = \["library", "editor", "plugins"\]/.test(docsTs) && /plugins: PLUGINS_DOC/.test(docsTs) &&
      /data-doc="plugins"[^>]*data-i18n="docs\.pluginsShort"/.test(html) && json(plIds) === json(["pl-intro", "pl-manage", "pl-perms", "pl-examples", "pl-data", "pl-code"]),
      `使用说明有独立的「插件」一份：是什么 / 安装管理 / 权限 / 示例 / 写数据插件 / 写代码插件（${json(plIds)}）`);
    check(/id="plugins-docs" data-et="pl\.docs"/.test(html) && /\$\("#plugins-docs"\)\.onclick = \(\) => \{[\s\S]{0,120}showDocs\("plugins"\);/.test(main) &&
      (i18n.match(/"pl\.docs":/g) ?? []).length === 2, "插件管理弹窗的「插件说明」直达插件使用说明");
    check(/<div class="wb-tb-group" id="ed-plugin-tools" hidden><\/div>/.test(html) && /ui\.mount\("toolbar", pluginToolsEl\)/.test(main) && /pluginToolsEl\.hidden = !ui\.items\("toolbar"\)\.length/.test(main),
      "插件的 toolbar 槽位挂在主工具条上（没有贡献时隐藏，切语言重建）");
    const exDirs = fs.readdirSync(path.join(ROOT, "examples/plugins")).filter((d) => !d.startsWith("."));
    check(exDirs.every((d) => plDocs.includes(`same("${d}")`)), `插件说明列出了 examples/plugins 下的全部示例（${json(exDirs)}）`);
  }
  check(["save.pkg", "save.pkgTitle", "log.packedPkg"].every((k) => (i18n.match(new RegExp(`"${k.replace(".", "\\.")}":`, "g")) ?? []).length === 2), "导出 pkg 的文案中英文都有");
  // 插件宿主（PLUGIN-ARCHITECTURE §2 / §5）：页面只按注册表渲染，内置能力也登记成插件
  check(/void bootPlugins\(\)\.catch\(/.test(main) && /app = await bootEditor\(/.test(main) && /catalog: \{ "builtin-ui": builtinUiPlugin \}/.test(main) && /profile: \{ plugins: \[\{ name: "builtin-ui" \}\] \}/.test(main),
    "启动时起插件内核，内置检视器分组 / 命令 / 录视频导出目标经 builtin-ui 插件登记（与其它内置插件同一条 catalog + profile 装配路径，profile 里可按名字停用）");
  check(/for \(const g of groupsFor\(node\)\)/.test(main) && !/inspectorEl\.appendChild\(\w+Group\(node\)\)/.test(main), "检视器分组全部来自注册表（不再硬编码 appendChild）");
  {
    const inspTs = fs.readFileSync(path.join(ROOT, "editor/inspector.ts"), "utf8");
    const tabOfGroup = (id) => main.match(new RegExp(`\\{ id: "${id}", order: \\d+, [^\\n]*?, tab: "([\\w-]+)" \\}`))?.[1];
    const want = { multi: "props", edit: "props", text: "props", particle: "props", sound: "props", attach: "props", video: "props", anim: "anim", "anim-layers": "anim", clips: "anim", model: "model", "model-tex": "model", bones: "model", effects: "fx", bindings: "logic", scripts: "logic" };
    const wrong = Object.entries(want).filter(([g, tab]) => tabOfGroup(g) !== tab).map(([g]) => g);
    check(wrong.length === 0, `检视器按功能分标签：属性 / 动画 / 模型 / 效果 / 逻辑（归错 ${json(wrong)}）`);
    check(/panelOf\(tabOf\(g\)\)\.appendChild\(el\)/.test(main) && /const info = panelOf\(INFO_INSPECTOR_TAB\);/.test(main) && /info\.appendChild\(rawGroup\(o\)\)/.test(main) && /mountInspectorTabs\(panels\);/.test(main), "分组按 tab 进各自面板；字段一览 + 原始 JSON 归「信息」页");
    check(/const tabs = \[\.\.\.panels\.keys\(\)\]/.test(main) && /const active = panels\.has\(inspTab\) \? inspTab : tabs\[0\]\.id;/.test(main) && /uiPrefs\.set\("inspectorTab", t\.id\)/.test(main), "只显示有分组的标签；记住上次的标签，当前图层没有那一页时落到第一页");
    check(/setAttribute\("role", "tablist"\)/.test(main) && /setAttribute\("role", "tab"\)/.test(main) && /setAttribute\("role", "tabpanel"\)/.test(main) && /e\.key === "ArrowRight"/.test(main), "标签条有 tablist / tab / tabpanel 语义，方向键切页");
    check(/return g\.tab && inspectorTabs\.get\(g\.tab\) \? g\.tab : DEFAULT_INSPECTOR_TAB;/.test(inspTs) && /inspectorTabs\.setFallback\(BUILTIN_INSPECTOR_TABS\)/.test(inspTs) && /"inspector\.tabs": inspectorTabs/.test(fs.readFileSync(path.join(ROOT, "editor/plugins/builtin/index.ts"), "utf8")), "标签也是贡献点（inspector.tabs）；未登记的标签退回「属性」页");
    const tabKeys = ["props", "anim", "model", "fx", "logic", "info"].map((t) => `insp.tab.${t}`);
    check(tabKeys.every((k) => (i18n.match(new RegExp(`"${k.replace(/\./g, "\\.")}":`, "g")) ?? []).length === 2), "检视器标签文案中英文都有");
  }
  check(/if \(app\?\.commands\.handleKey\(e\)\) \{\s*e\.preventDefault\(\);\s*return;/.test(main), "快捷键先过命令服务（插件可登记 / 覆盖），内核未起时走内置链");
  check(/meta: \{ plugins: usedPlugins\(\) \}/.test(main) && /onPluginError: \(who, e\) => reportPluginError\(who, e, "export"\)/.test(main), "导出把用到的外部插件写进 project.json，钩子 / 规则出错按插件上报");
  check(/exporters\.onChange\(renderExportMenu\)/.test(main) && /particleTemplates\.onChange\(renderParticleMenu\)/.test(main) && /puppetGenerators\.onChange\(renderGeneratorMenu\)/.test(main) && /modelImporters\.onChange\(syncModelAccept\)/.test(main), "注册表变化即重绘导出菜单 / 粒子菜单 / 生成器菜单 / 模型文件框 accept");
  check(/storeSource\(a\.storage\), \.\.\.\(hostUp \? \[dirSource\(\)\] : \[\]\)/.test(main) && /if \(hostUp\) m\.watch\(\);/.test(main), "外部插件：已安装（IndexedDB）+ dev 宿主插件目录，目录来源热重载");
  check(/id="tb-plugins"/.test(html) && /id="plugins-dlg"/.test(html) && /id="in-plugin" webkitdirectory/.test(html), "页面：插件按钮 + 管理面板 + 安装文件夹选择框");
  const plKeys = [...new Set([...fs.readFileSync(path.join(ROOT, "editor/ui/plugin-panel.ts"), "utf8").matchAll(/t\(\s*"((?:pl|log)\.[\w.]+)"/g)].map((m) => m[1]).concat(["pl.title", "pl.body", "pl.openDir", "pl.refresh", "pl.install", "pl.close", "pl.installConfirm", "pl.installNoPerms", "pl.installPerms", "pl.installHigh", "log.pluginError"], ["store", "dir", "memory"].map((s) => `pl.src.${s}`), ["active", "loading", "pending", "failed", "invalid", "disabled", "disposed"].map((s) => `pl.status.${s}`)))];
  const missingPl = plKeys.filter((k) => (i18n.match(new RegExp(`"${k.replace(/\./g, "\\.")}":`, "g")) ?? []).length !== 2);
  check(missingPl.length === 0, `插件面板文案中英文都有（缺 ${json(missingPl)}）`);
  const saveTs = fs.readFileSync(path.join(ROOT, "editor/save.ts"), "utf8");
  check(/import \{ buildScenePkg, type ScenePkgResult \} from "\.\.\/renderer\/src\/api\/editor";/.test(saveTs) && !/writePkg|encodeTex/.test(saveTs), "页面只经库出口 buildScenePkg 打包（不直连 vendor 编码器）");
  const devPack = fs.readFileSync(path.join(ROOT, "scripts/dev-pack-pkg.mjs"), "utf8");
  check(/import \{ writePkg \} from "\.\.\/renderer\/vendor\/we-scene\/pkg\/container\.js";/.test(devPack) && !/writeUInt32LE|Buffer\.concat/.test(devPack), "dev-pack-pkg 不再有第二份容器写实现");
  check(/from "\.\/text"/.test(main) && /structEdit\(et\("log\.textAdded", \{ name \}\), \(d\) => addTextLayer\(d, preset, name, et\("text\.defaultValue"\), measureText\)/.test(main), "添加文字层取 text.ts 模板、走结构编辑（可撤销、整场景重挂）");
  check(/objEdit\(et\("log\.textEdited"[^\n]*\n\s*if \(!mutate\(o\)\) return false;\s*refitTextBox\(o, measureText\);/.test(main), "文字字段编辑走结构编辑，改完按页面实测宽度回填盒子");
  check(/await Promise\.all\(fonts\.map\(ensurePageFont\)\);/.test(main) && /SYSTEM_FONT_FAMILIES\[font\.toLowerCase\(\)\]/.test(main), "量字前先把工程字体装进页面；系统字体按引擎同一张映射表量");
  check(/overlay\.put\(path, new Uint8Array\(await file\.arrayBuffer\(\)\), path\);/.test(main), "导入字体写进叠加层，分组 = 字体路径（没被引用就不进保存清单）");
  check(/\{ id: "text", order: 400, when: \(n\) => n\.kind === "text", render: textGroup(?:, tab: "props")? \}/.test(main) && /content\.readOnly = scripted;/.test(main), "文字层检视器有「文字」分组；脚本生成的内容只读");
  check(/id="ly-add-text"/.test(html) && /id="text-menu"/.test(html) && ["plain", "clock", "date"].every((p) => html.includes(`data-preset="${p}"`)) && /id="in-font" accept="\.ttf,\.otf/.test(html), "页面：添加文字层按钮 + 文字 / 时钟 / 日期菜单 + 字体选择框");
  const txKeys = [...main.matchAll(/et\(\s*"((?:tx|text)\.[\w.]+)"/g)].map((m) => m[1]).concat(["ly.addText", "text.plain", "text.clock", "text.date", "tx.align.left", "tx.align.center", "tx.align.right", "tx.align.top", "tx.align.bottom", "log.textAdded", "log.textEdited", "log.fontImported", "log.fontFailed", "insp.text"]);
  const missingTx = [...new Set(txKeys)].filter((k) => (i18n.match(new RegExp(`"${k.replace(/\./g, "\\.")}":`, "g")) ?? []).length !== 2);
  check(missingTx.length === 0, `文字层文案中英文都有（缺 ${json(missingTx)}）`);
  check(/from "\.\/particles"/.test(main) && /structEdit\(et\("log\.particleAdded", \{ name \}\), \(d\) => \{[^}]*overlay!\.put\(f\.name, f\.data, particlePathOf\(slug\)\);\s*return addParticleLayer\(d, preset, name, slug\)/.test(main), "添加粒子层取 particles.ts 模板、两件套写进叠加层（分组 = 粒子文件路径）、走结构编辑");
  check(/\{ id: "particle", order: 500, when: \(n\) => n\.kind === "particle", render: particleGroup(?:, tab: "props")? \}/.test(main) && /setParticleParam\(o, k as ParticleParam, Number\(inp\.value\)\)/.test(main) && /objEdit\(et\("log\.particleEdited"/.test(main), "粒子层检视器有「粒子」分组，滑条 change 时经 objEdit 写 instanceoverride（可撤销）");
  check(/id="ly-add-particle"/.test(html) && /id="particle-menu"/.test(html) && ptMod.PARTICLE_PRESETS.every((p) => html.includes(`data-preset="${p}"`)) && /lyAddParticleEl\.disabled = lyAddEl\.disabled;/.test(main), "页面：添加粒子层按钮 + 雪 / 雨 / 火花 / 光点菜单，可用性跟随添加图片");
  const ptKeys = [...main.matchAll(/et\(\s*"((?:pt)\.[\w.]+)"/g)].map((m) => m[1]).concat(["ly.addParticle", "log.particleAdded", "log.particleEdited", "insp.particle"], ptMod.PARTICLE_PRESETS.map((p) => `pt.${p}`), ptMod.PARTICLE_PARAMS.map((p) => `pt.${p}`));
  const missingPt = [...new Set(ptKeys)].filter((k) => (i18n.match(new RegExp(`"${k.replace(/\./g, "\\.")}":`, "g")) ?? []).length !== 2);
  check(missingPt.length === 0, `粒子层文案中英文都有（缺 ${json(missingPt)}）`);
  check(/from "\.\/sound"/.test(main) && /overlay\.put\(path, new Uint8Array\(await file\.arrayBuffer\(\)\), path\);\s*return path;/.test(main) && /structEdit\(et\("log\.soundAdded"[^\n]*\n[^\n]*\n\s*for \(const it of items\) last = addSoundLayer\(d, it\.name, it\.path\)/.test(main), "添加声音层取 sound.ts、音频原字节写进叠加层（分组 = 自身路径）、走结构编辑");
  check(/files\.every\(\(f\) => isAudioFile\(f\.file\)\)\) \{\s*void addSoundFiles\(files\.map\(\(f\) => f\.file\)\)/.test(main), "拖入全是音频时加声音层");
  check(/\{ id: "sound", order: 600, when: \(n\) => n\.kind === "sound", render: soundGroup(?:, tab: "props")? \}/.test(main) && /objEdit\(et\("log\.soundEdited"[^\n]*setSoundField\(o, field, v\)\)/.test(main) && /replaceSoundFile\(o, path\)/.test(main), "声音层检视器有「声音」分组，模式 / 音量 / 开始静音 / 替换音频经 objEdit（可撤销）");
  check(/const au = new Audio\(url\);/.test(main) && /stopPreview\(\);\s*overlay =/.test(main) && /\.\.\.renderSettings\.mountOptions\(\),/.test(main) && /value="0" \/>\s*<span id="volume-val"/.test(html), "试听用页面自己的 audio 元素，换文档即停；引擎音量跟「渲染」面板（默认 0 静音）");
  check(/id="ly-add-sound"/.test(html) && /id="in-sound" accept="\.mp3,\.ogg,\.wav,\.flac/.test(html) && /lyAddSoundEl\.disabled = lyAddEl\.disabled;/.test(main), "页面：添加声音层按钮 + 音频选择框，可用性跟随添加图片");
  const sndKeys = [...main.matchAll(/et\(\s*"((?:snd)\.[\w.]+)"/g)].map((m) => m[1]).concat(["ly.addSound", "log.soundAdded", "log.soundEdited", "log.soundMissing", "log.soundFailed", "insp.sound"], sndMod.PLAYBACK_MODES.map((m) => `snd.mode.${m}`));
  const missingSnd = [...new Set(sndKeys)].filter((k) => (i18n.match(new RegExp(`"${k.replace(/\./g, "\\.")}":`, "g")) ?? []).length !== 2);
  check(missingSnd.length === 0, `声音层文案中英文都有（缺 ${json(missingSnd)}）`);
  check(/from "\.\/keyframes"/.test(main) && /const split = splitAnimated\(node\.obj, patch\);[\s\S]{0,200}pendingKeys\.set\([\s\S]{0,80}writeObjProps\(node\.obj, plain\);[\s\S]{0,120}mergeLiveEdit\(liveEdits, id, plain\);/.test(main), "热改：落在动画字段上的改动不写静态值、不进重放账，记为待落关键帧");
  check(/function commit\(cmd: PropsCmd\) \{\s*const keyed = pendingKeys\.get\(String\(cmd\.id\)\);[\s\S]{0,200}keyEdit\(node, keyed\);/.test(main) && /setKey\(o, f, frameAt\(v, t\), keyed\[f\]!\)/.test(main), "提交（检视器 change / 拖拽松手）时，动画字段的改动变成当前帧的关键帧（objEdit，可撤销）");
  check(/\{ id: "anim", order: 300, when: canAnimate, render: animGroup(?:, tab: "anim")? \}/.test(main) && /enableAnim\(o, f, liveValue\(node, f\)\) : disableAnim\(o, f, liveValue\(node, f\)\)/.test(main) && /removeKey\(o, f, k\.frame\)/.test(main) && /setAnimOption\(o, f, "mode"/.test(main) && /setSmooth\(o, f, smooth\.checked\)/.test(main), "检视器「动画」分组：开关 / 打关键帧 / 删关键帧 / 模式 / 时长 / 插值，全走 objEdit");
  check(/tlRangeEl\.addEventListener\("change", \(\) => \{\s*scrubbing = false;\s*if \(editor\) afterSeek\(/.test(main) && /afterSeek\(editor\.step\(1, 60\)\)/.test(main) && /function renderInspector\(\) \{\s*(?:if \(animSolo[^\n]*\n\s*)?inspectorEl\.textContent = "";\s*renderKeyMarks\(\);/.test(main), "拖完时间轴 / 逐帧后刷新动画层检视器；选中变化时重画时间轴关键帧标记");
  check(/for \(const run of animRuns\) \{\s*if \(run\.layer === l && \(p as Record<string, unknown>\)\[run\.field\] !== undefined\) run\.held = true;/.test(sm) && /else run\.ctrl\.advance\(clockDt\);\s*if \(run\.held\) continue;/.test(sm) && /animSeekPending = true;\s*for \(const run of animRuns\) run\.held = false;/.test(sm), "引擎：热改动画字段后曲线写回暂停到下一次 seek（拖拽 / 输入跟手）");
  check(/if \(field === "color" && run\.layer\.isText\) run\.layer\.textColor = run\.layer\.color;/.test(sm) && /field === "color" && run\.layer\.matTint && run\.layer\.tintBase\) \{[\s\S]{0,200}?anim\.writeAnimSlot\(run\.layer\.tintBase, "color", out\);\s*applyBuiltinMatTint\(run\.layer\);/.test(sm), "引擎：颜色曲线写到文字层真正绘制的 textColor / 材质烘色层的 tintBase");
  check(/m\.addEventListener\("pointerdown", \(e\) => startKeyDrag\(e, m, n, t\)\)/.test(main) && /\(o\) => moveKeyTime\(o, from, to\)/.test(main) && /log\(et\("log\.keyMoveBad"/.test(main), "时间轴关键帧标记可拖动改时刻（objEdit，冲突时提示并复原）");
  check(/row\.addEventListener\("pointerdown", \(e\) => startTreeDrag\(e, n, row\)\)/.test(main) && /\(res = placeLayer\(d, n\.id, target\.id, where\)\) === "ok"/.test(main) && /if \(treeDragged\) return;/.test(main), "图层树行可拖：放下走 placeLayer 结构编辑，拖完不误触点选");
  check(/isLockedObj\(o\) === on/.test(main) && /setLocked\(o, on\);/.test(main) && /setLockedEdit\(n, !isLocked\(n\.id\)\);/.test(main) && !/const locked = new Set/.test(main) && !/setLocked\(n\.obj, !isLocked\(n\.id\)\);\s*markDirty\(\);/.test(main), "锁定状态以文档 locktransforms 为准（页面不再另存一份），且切换走 objEdit 进撤销栈（A9）");
  check(/id="ly-group"/.test(fs.readFileSync(path.join(ROOT, "editor/index.html"), "utf8")) && /groupLayer\(d, n\.id, et\("layer\.groupName"\)\)/.test(main), "图层工具条「成组」");
  check(/if \(drag\.box && drag\.snap && !\(e\.metaKey \|\| e\.ctrlKey\)\) \{\s*const r = snapMove\(drag\.box, dx, dy, drag\.snap\);/.test(main) && /screenDeltaToLocal\(Number\(drag\.id\), mx, my\)/.test(main) && /snapTargets\(sceneFrame\(fitEl\.value, r\.width, r\.height, res\.w, res\.h\), others\)/.test(main), "视口移动走吸附（⌘ / Ctrl 关），候选 = 画面框（按当前 fit）+ 其他层");
  check(/if \(!l\.visible \|\| insideSelf\(l\)\) continue;/.test(main) && /handle \? \{ box: null, snap: null \}/.test(main) && /drag = null;\s*snapGuides = null;/.test(main), "吸附只对移动生效；自己与子层、隐藏层不当候选；松手清参考线");
  check(/if \(e\.shiftKey \|\| e\.metaKey \|\| e\.ctrlKey\) return toggleSelect\(n\.id\);/.test(main) && /if \(e\.shiftKey && hits\.length\) \{\s*toggleSelect\(hits\[0\]\.id\);/.test(main) && /\.some\(\(h\) => isSelected\(h\.id\)\)/.test(main), "多选：树 ⇧/⌘ 点、画面 ⇧ 点加减选；拖任一选中层都能起拖");
  check(/for \(const o of drag\.others\) \{\s*const od = editor\.screenDeltaToLocal\(Number\(o\.id\), mx, my\);/.test(main) && /commitMany\(et\("log\.multiMoved"/.test(main) && /if \(isBatch\(cmd\)\) \{\s*for \(const c of cmd\.cmds\) void applyPatch/.test(main), "多选移动：其余层按同一屏幕位移跟随，一步撤销（批量命令）");
  check(/groupLayers\(d, ids, et\("layer\.groupName"\)\)/.test(main) && /ids\.every\(\(id\) => removeLayer\(d, id\)\)/.test(main) && /alignDeltas\(items\.map\(\(i\) => i\.box\), mode\)/.test(main), "多选删除 / 复制 / 成组 / 对齐分布接线");
  check(/let userPlaying = false;/.test(main) && /if \(!userPlaying\) inst\.pause\(\);/.test(main) && /origin = opts\.origin \?\? null;\s*userPlaying = !!opts\.play;/.test(main) && (main.match(/play: true/g) ?? []).length === 1, "默认不自动播放：打开文档与重挂都停在当前帧，只有点播放才走时钟（唯一例外：壁纸库条目即点即播）");
  check(/userPlaying = instance\.paused;\s*if \(userPlaying\) instance\.resume\(\);/.test(main) && /function pauseForStepping\(\) \{\s*userPlaying = false;/.test(main), "播放按钮记住用户意图；逐帧 / 拖时间轴会把它清掉");
  check(/<div id="tl-track">\s*<input id="tl-range"[^>]*\/>\s*<div id="tl-keys" aria-hidden="true"><\/div>/.test(html), "时间轴关键帧标记层叠在滑条上");
  check(/rebaseClock\(t, performance\.now\(\)\);\s*animSeekPending = true;/.test(sm) && /for \(const run of animRuns\) \{\s*if \(seekAnims\) run\.ctrl\.seekTime\(t\);\s*else run\.ctrl\.advance\(clockDt\);/.test(sm) && /for \(const run of overrideAnimRuns\) \{\s*if \(seekAnims\) run\.ctrl\.seekTime\(t\);/.test(sm), "引擎 seek：下一帧字段 / 粒子 override 关键帧按绝对时间定位");
  const animKeys = [...main.matchAll(/et\(\s*"((?:anim|insp\.anim|log\.anim|log\.key)[\w.]*)"/g)].map((m) => m[1]).concat(kfMod.ANIM_MODES.map((m) => `anim.mode.${m}`));
  const missingAnim = [...new Set(animKeys)].filter((k) => (i18n.match(new RegExp(`"${k.replace(/\./g, "\\.")}":`, "g")) ?? []).length !== 2);
  check(animKeys.length > 15 && missingAnim.length === 0, `关键帧文案中英文都有（缺 ${json(missingAnim)}）`);
  const ptSrc = fs.readFileSync(path.join(ROOT, "editor/particles.ts"), "utf8");
  check(!/local-assets|\.tex"/.test(ptSrc) && /export const PARTICLE_TEXTURE = "particle\/halo";/.test(ptSrc), "粒子模板只引用内置贴图名，不碰 local-assets / 官方素材文件");
  const typesTs = fs.readFileSync(path.join(ROOT, "renderer/src/types.ts"), "utf8");
  check(/export const SYSTEM_FONT_FAMILIES/.test(typesTs) && !/export const SYSTEM_FONT_FAMILIES/.test(sm) && /SYSTEM_FONT_FAMILIES, TEXT_EM_SCALE \} from "\.\/types"/.test(sm), "系统字体映射表只有一份（types.ts），引擎与编辑器共用");
  const pkgJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  check(pkgJson.scripts?.["verify:editor"] === "node scripts/verify-editor.mjs", "package.json 有 verify:editor");
  const all = fs.readFileSync(path.join(ROOT, "scripts/verify-all.mjs"), "utf8");
  check(/"verify-editor"/.test(all), "verify-editor 在 verify-all 稳定集里");
}

// ───────────────────────────────────────────────────────────────────────────
// CONTAINER. 容器层 / 全屏后期层 / passthrough（M5 A12）
//
// 语料命中（358 个可解析 scene.json / 14888 个对象）：容器 836 对象 / 150 张壁纸、
// 全屏后期 229 / 104、`config.passthrough` 287 / 43 —— 编辑器此前 0 个入口。
//
// 离线判据：容器对象生成形状、子层世界坐标合并（纯函数 composeXform，与引擎
// parse.js 的 composeChildTransform 同式）、passthrough 往返、未知子层 / 未知 config 键
// 逐字节保留、页面接线（按钮 + 中英文案各恰好一条）、`editor/` 下没有偷看引擎运行态的探针。
//
// headless 用例（需真浏览器，本沙箱 Chrome 起不来 —— 见文末「失败点」）：
// 建容器 → 挂效果 → 出帧像素变；容器自身变换作用于子层（画面整体位移）。
// ───────────────────────────────────────────────────────────────────────────
section("CONTAINER. 容器层 / 全屏后期层 / passthrough（M5 A12）");
{
  const ctr = await loadEditorModule("container");
  const docMod = await loadEditorModule("doc");
  const kinds = await loadEditorModule("layer-kinds");
  const ctrSrc = fs.readFileSync(path.join(ROOT, "editor/container.ts"), "utf8");
  const mainSrc = fs.readFileSync(path.join(ROOT, "editor/main.ts"), "utf8");
  const ctrHtml = fs.readFileSync(path.join(ROOT, "editor/index.html"), "utf8");
  const ctrI18n = fs.readFileSync(path.join(ROOT, "editor/i18n.ts"), "utf8");

  // —— 判定口径与引擎同字面量 ——
  const parseSrc = fs.readFileSync(path.join(ROOT, "renderer/vendor/we-scene/scene/parse.js"), "utf8");
  check(parseSrc.includes("isContainer: typeof o.image") && parseSrc.includes("'models/util/composelayer'"), "引擎侧容器判定仍在 parse.js 的 isContainer（前缀 composelayer）");
  check(ctr.CONTAINER_IMAGE === "models/util/composelayer", "编辑器容器前缀与引擎同一字面量 models/util/composelayer");
  check(json(ctr.FULLSCREEN_POST_IMAGES) === json(["models/util/projectlayer", "models/util/fullscreenlayer"]), "全屏后期前缀 = projectlayer / fullscreenlayer（与 parse.js isPost 两个前缀一致）");
  check(ctr.isContainerObject({ image: "models/util/composelayer.pkg" }) === true && ctr.isContainerObject({ image: "images/bg.jpg" }) === false, "容器判定只认 composelayer 前缀（普通图片不算）");
  check(ctr.isFullscreenPostObject({ image: "models/util/fullscreenlayer" }) === true && ctr.isFullscreenPostObject({ image: "models/util/composelayer" }) === false, "全屏后期判定只认 projectlayer / fullscreenlayer");
  check(ctr.hasPassthrough({ config: { passthrough: true } }) === true && ctr.hasPassthrough({ passthrough: true }) === false, "passthrough 只从 config 里读（顶层同名字段不算）");

  // solid 判定与 parse.js 的 IIFE 同式：solidlayer 前缀不看旗标、composelayer 一律 false
  check(ctr.solidRenders({ image: "models/util/solidlayer" }) === true && ctr.solidRenders({ image: "models/util/solidlayer", solid: false }) === true, "solidlayer 前缀即实心（没有 solid 旗标也算）");
  check(ctr.solidRenders({ image: "models/util/composelayer", solid: true }) === false, "容器即使残留 solid: true 也不是实心层（17 个语料对象的坑）");
  check(ctr.solidRenders({ particle: "particles/snow" }) === false && ctr.solidRenders({ image: "images/x.jpg" }) === false && ctr.solidRenders({ image: "images/x.jpg", solid: true }) === false, "粒子 / 松散图片不是实心层");
  check(ctr.solidRenders({ solid: true }) === true && ctr.solidRenders({ solid: true, image: "models/util/imagelayer" }) === true, "没有 image / 内置 util 前缀 + solid 旗标 = 实心");

  // —— 容器对象生成形状 ——
  const mkScene = (objs) => ({ general: { orthogonalprojection: { width: 1920, height: 1080 } }, objects: objs });
  const ctrDoc = { type: "scene", scene: mkScene([]), roots: [], project: null };
  const ctrId = ctr.addContainerLayer(ctrDoc, { name: "容器", origin: "960 540 0", scale: "1920 1080 1", passthrough: true });
  const ctrObj = ctrDoc.scene.objects[0];
  check(ctrId !== null && ctrObj.id === ctrId, "addContainerLayer 返回的 id 就是新对象的 id");
  check(ctrObj.image === "models/util/composelayer", "新容器写出 image = models/util/composelayer（引擎认得的对象）");
  check(ctrObj.config && ctrObj.config.passthrough === true && ctrObj.passthrough === undefined, "passthrough 写在 config.passthrough，顶层不留同名字段");
  check(json(Object.keys(ctrObj).sort()) === json(["angles", "config", "id", "image", "name", "origin", "scale", "visible"]), `新容器的键集固定（${json(Object.keys(ctrObj).sort())}）`);
  check(JSON.stringify(ctrObj) === json({ angles: "0 0 0", config: { passthrough: true }, id: ctrId, image: "models/util/composelayer", name: "容器", origin: "960 540 0", scale: "1920 1080 1", visible: true }), `新容器的 JSON 逐字节等于期望（键序与工程口径一致：${json(ctrObj)}）`);
  check(docMod.kindOf(ctrObj) === "container", "kindOf 把容器识别成 container（不是 image），检视器才给得出容器分组");
  check(kinds.layerKindInfo("container")?.canHaveEffects === true, "容器类型登记 canHaveEffects（效果作用在整棵子树上）");
  check(docMod.kindOf({ image: "models/util/projectlayer" }) === "fullscreen-post" && kinds.layerKindInfo("fullscreen-post")?.canHaveEffects === true, "全屏后期层单独一种类型且能挂效果");
  check(docMod.kindOf({ image: "models/util/solidlayer" }) === "image" && docMod.kindOf({ image: "images/bg.jpg" }) === "image", "solidlayer / 普通图片仍是 image（判定没被容器分支吃掉）");

  const postDoc = { type: "scene", scene: mkScene([]), roots: [], project: null };
  ctr.addContainerLayer(postDoc, { kind: "post", name: "后期" });
  check(postDoc.scene.objects[0].image === "models/util/projectlayer", "kind: \"post\" 写 projectlayer（全屏后期，引擎按画布覆盖尺寸）");
  check(postDoc.scene.objects[0].config === undefined, "后期层默认不写 config（只写真正要的键）");

  const solidDoc = { type: "scene", scene: mkScene([]), roots: [], project: null };
  ctr.addContainerLayer(solidDoc, { solid: true });
  check(solidDoc.scene.objects[0].config === undefined && solidDoc.scene.objects[0].solid === true, "solid 旗标是顶层字段，不会被塞进 config");

  // —— 子层世界坐标合并（纯函数；与引擎 parse.js composeChildTransform 同式）——
  const composeId = docMod.composeXform({ origin: [100, 200, 0], scale: [2, 3, 1], angles: [0, 0, Math.PI / 2] }, { origin: [10, 0, 0], scale: [1, 1, 1], angles: [0, 0, 0] });
  check(near(composeId.origin[0], 100) && near(composeId.origin[1], 220) && near(composeId.origin[2], 0), `容器旋转后子层世界原点按父角度转（${json(composeId.origin)}，Y 轴朝下 → 10 局部单位落在 +y）`);
  check(near(composeId.scale[0], 2) && near(composeId.scale[1], 3) && near(composeId.scale[2], 1), "父层 scale 传给子层（composeXform 与引擎一样恒传播）");
  check(near(composeId.angles[2], Math.PI / 2) && near(composeId.angles[0], 0) && near(composeId.angles[1], 0), "2D 只累加 z 角度，x / y 角度取子层自己的");
  const nestedId = docMod.composeXform({ origin: [0, 0, 0], scale: [1, 1, 1], angles: [0, 0, Math.PI] }, composeId);
  check(near(nestedId.origin[0], -100) && near(nestedId.origin[1], -220) && near(nestedId.angles[2], (3 * Math.PI) / 2), `二层容器逐级合并（旋转 180° 后子层落在父的另一侧：${json(nestedId.origin)}，角度 ${nestedId.angles[2].toFixed(4)}）`);
  const identityId = docMod.composeXform({ origin: [0, 0, 0], scale: [1, 1, 1], angles: [0, 0, 0] }, { origin: [7, 8, 9], scale: [1, 2, 3], angles: [0, 0, 0] });
  check(json(identityId.origin) === json([7, 8, 9]) && json(identityId.scale) === json([1, 2, 3]), "单位父层不改子层（世界 = 局部）");

  // 文档层：容器 → 子层，worldXform 与 composeXform 同结果
  const treeDoc = { type: "scene", scene: mkScene([]), roots: [], project: null };
  const treeCtr = ctr.addContainerLayer(treeDoc, { name: "容器", origin: "960 540 0", scale: "2 2 1" });
  ctr.addContainerLayer(treeDoc, { name: "子层" });
  const childObj = treeDoc.scene.objects.find((o) => o.id !== treeCtr);
  childObj.parent = treeCtr;
  childObj.origin = "10 0 0";
  childObj.scale = "1 1 1";
  childObj.angles = "0 0 0";
  docMod.rebuildTree(treeDoc);
  const childNode = docMod.findNode(treeDoc.roots, childObj.id);
  const worldOf = docMod.worldXform(treeDoc.scene.objects, childNode.obj);
  check(childNode.children.length === 0 && treeDoc.roots.some((n) => n.id === treeCtr && n.children.some((c) => c.id === childObj.id)), "容器 → 子层的父子关系进了图层树");
  check(worldOf && worldOf.origin[0] === 980 && worldOf.origin[1] === 540 && worldOf.scale[0] === 2, `容器自身变换作用在子层上（子层世界原点 ${json(worldOf?.origin)}，scale ${json(worldOf?.scale)}）`);
  const viaCompose = docMod.composeXform(docMod.worldXform(treeDoc.scene.objects, docMod.findNode(treeDoc.roots, treeCtr).obj), docMod.localXform(childObj));
  check(near(viaCompose.origin[0], worldOf.origin[0]) && near(viaCompose.origin[1], worldOf.origin[1]) && near(viaCompose.scale[0], worldOf.scale[0]), "worldXform 走链的结果与 composeXform 逐级合成一致（两处不得分叉）");

  // —— 旗标往返：写回 → 再 parse → 逐字节一致 ——
  const rtDoc = { type: "scene", scene: mkScene([]), roots: [], project: null };
  const rtId = ctr.addContainerLayer(rtDoc, { name: "容器" });
  docMod.findNode(rtDoc.roots, rtId);
  const rtObj = rtDoc.scene.objects.find((o) => o.id === rtId);
  ctr.setPassthrough(rtObj, true);
  check(rtObj.config.passthrough === true, "setPassthrough(true) 写 config.passthrough");
  const saved = JSON.stringify(rtDoc.scene);
  const reparsed = JSON.parse(saved);
  const rtObj2 = reparsed.objects.find((o) => o.id === rtId);
  check(ctr.hasPassthrough(rtObj2) === true, "存盘再 parse 后 passthrough 仍在（引擎解析得到同一个旗标）");
  check(JSON.stringify(reparsed) === saved, "写回后 JSON.parse + stringify 与期望逐字节一致");
  ctr.setPassthrough(rtObj2, false);
  check(rtObj2.config && !("passthrough" in rtObj2.config), "setPassthrough(false) 删键（不留 false 残渣）");
  check(ctr.hasPassthrough(rtObj2) === false, "关掉后 hasPassthrough 为 false");

  // —— 未知字段 / 未知 config 键逐字节保留 ——
  const keep = { id: 42, image: "models/util/composelayer", name: "旧容器", origin: "1 2 3", scale: "1 1 1", angles: "0 0 0", visible: true, solid: false, config: { passthrough: true, alpha: 0.5, "we.unknown": { deep: [1, 2, 3] } }, weCustom: { nested: true }, unknownTop: "保我" };
  const keepJson = JSON.stringify(keep);
  const keepDoc = { type: "scene", scene: mkScene([JSON.parse(keepJson)]), roots: [], project: null };
  docMod.rebuildTree(keepDoc);
  const keepObj = keepDoc.scene.objects[0];
  ctr.setPassthrough(keepObj, false);
  check(keepObj.config.alpha === 0.5 && json(keepObj.config["we.unknown"]) === json({ deep: [1, 2, 3] }), "改 passthrough 不动 config 里我们不认识的键");
  check(keepObj.weCustom.nested === true && keepObj.unknownTop === "保我" && keepObj.solid === false, "对象上的未知字段逐字节保留（含 solid: false 这种显式假值）");
  check(JSON.stringify(keepObj.config) === json({ alpha: 0.5, "we.unknown": { deep: [1, 2, 3] } }), `删键后 config 的 JSON 只剩认识之外的键（${json(keepObj.config)}）`);

  const unkChild = { id: 7, parent: 42, image: "models/util/composelayer", name: "未知子层", keepMe: [1, 2], config: { mystery: "x" } };
  const unkDoc = { type: "scene", scene: mkScene([JSON.parse(keepJson), unkChild]), roots: [], project: null };
  docMod.rebuildTree(unkDoc);
  const unkJson = JSON.stringify(unkDoc.scene.objects[1]);
  const unkNode = docMod.findNode(unkDoc.roots, 42);
  check(unkNode.children.length === 1 && unkNode.children[0].id === 7, "容器下的未知子层挂进了树");
  check(unkNode.children[0].kind === "container" || docMod.kindOf(unkChild) === "container", "未知子层自身也是容器时照样识别");
  const unkParentWorld = docMod.worldXform(unkDoc.scene.objects, docMod.findNode(unkDoc.roots, 42).obj);
  docMod.composeXform(unkParentWorld, docMod.localXform(unkChild));
  check(JSON.stringify(unkDoc.scene.objects[1]) === unkJson, "只读合成不改对象（未知子层逐字节不变）");
  const rewriteObj = JSON.parse(unkJson);
  ctr.setPassthrough(rewriteObj, true);
  check(rewriteObj.keepMe[1] === 2 && rewriteObj.config.mystery === "x" && rewriteObj.config.passthrough === true, "写旗标后未知子层仍保留 keepMe / config.mystery");
  const expectObj = JSON.parse(unkJson);
  expectObj.config.passthrough = true;
  check(JSON.stringify(rewriteObj) === JSON.stringify(expectObj), "只多出 passthrough 一个键，其余逐字节不动（含 config 里原本的键序）");

  // —— 页面接线（按钮 / 文案 / 结构编辑）——
  check(ctrHtml.includes('id="ly-add-container"') && ctrHtml.includes('id="ly-add-post"'), "图层工具条有「加容器层」「加全屏后期层」两个按钮");
  check(/lyAddContainerEl\.disabled = lyAddEl\.disabled;/.test(mainSrc) && /lyAddPostEl\.disabled = lyAddEl\.disabled;/.test(mainSrc), "两个新按钮的可用性跟随添加图片层");
  check(/from "\.\/container"/.test(mainSrc) && /structEdit\(et\("log\.containerAdded", \{ name \}\)/.test(mainSrc) && /addContainerLayer\(d, \{/.test(mainSrc), "加层走 structEdit + container.ts 的对象生成（可撤销、整场景重挂）");
  const ctrGroup = mainSrc.match(/id: "container",[\s\S]{0,200}?render: containerGroup,[\s\S]{0,40}?tab: "props"/);
  check(!!ctrGroup && ctrGroup[0].includes('order: 1250,') && ctrGroup[0].includes('n.kind === "container" || n.kind === "fullscreen-post" || !!n.obj.solid'), "检视器「容器」分组：容器 / 全屏后期 / 实心层都出旗标");
  check(/setPassthrough\(ob, on\)/.test(mainSrc) && /objEdit\(et\(on \? "log\.passthroughOn"/.test(mainSrc) && /delete ob\.solid;/.test(mainSrc), "旗标改动走 objEdit（可撤销）");
  const ctrKeys = ["ly.addContainer", "ly.addPost", "ctr.container", "ctr.post", "insp.container", "ctr.passthrough", "ctr.solid", "ctr.fullscreen", "ctr.solidYes", "ctr.solidNo", "ctr.postNote", "log.containerAdded", "log.passthroughOn", "log.passthroughOff", "log.solidOn", "log.solidOff"];
  const duplicate = ctrKeys.filter((k) => (ctrI18n.match(new RegExp(`"${k.replace(/\./g, "\\.")}":`, "g")) ?? []).length !== 2);
  check(duplicate.length === 0, `容器相关文案中英文各恰好一条（${json(ctrKeys.length)} 条，缺 / 多 ${json(duplicate)}）`);
  check(/et\(on \? "log\.solidOn" : "log\.solidOff"/.test(mainSrc) || /"log\.solidOn"/.test(mainSrc), "实心旗标的两种文案都在页面上用到");

  // —— 探针 / 分层 ——
  const editorFiles = fs.readdirSync(path.join(ROOT, "editor")).filter((f) => f.endsWith(".ts"));
  const probes = editorFiles.filter((f) => /__wp|__sceneLayers/.test(fs.readFileSync(path.join(ROOT, "editor", f), "utf8")));
  check(probes.length === 0, `editor/ 下没有偷看引擎运行态的 __wp / __sceneLayers 探针（${json(probes)}）`);
  check(/from "\.\.\/renderer\/src\/api\/editor"/.test(fs.readFileSync(path.join(ROOT, "editor/doc.ts"), "utf8")) && !/from "\.\.\/renderer\/src\/scene-mount"/.test(mainSrc) && !/from "\.\.\/renderer\/vendor/.test(ctrSrc), "只从 api/editor 出口取引擎能力，不直连 scene-mount / vendor");

  // 与引擎同一份前缀表：解析器改了前缀而编辑器没跟，这条要红
  const engineCtr = /'models\/util\/composelayer'/.test(parseSrc);
  check(engineCtr && ctr.CONTAINER_IMAGE === "models/util/composelayer", "引擎与编辑器的容器前缀是同一条字面量（改一边这条即红）");
}

// ───────────────────────────────────────────────────────────────────────────
section("J. 变异红测");
{
  {
    const rcPath = path.join(ROOT, "editor/recover.ts");
    const rcSrc = fs.readFileSync(rcPath, "utf8");
    const mutRc = rcSrc.replace("  if (stamps.length >= max) return false;\n", "");
    check(mutRc !== rcSrc, "注入点存在（allowRecover 上限）");
    const mr = await loadEditorModule("recover", { [rcPath]: mutRc });
    const st = [];
    check([0, 1, 2, 3].every((t) => mr.allowRecover(st, t)), "去掉上限后「第 4 次拒绝」判据变红（会无限重挂）");
  }
  {
    const kfPath = path.join(ROOT, "editor/keyframes.ts");
    const kfSrc = fs.readFileSync(kfPath, "utf8");
    const mutPaste = kfSrc.replace("    if (!Array.isArray(vals) || vals.length !== CHANNELS[f] || !vals.every(Number.isFinite)) return false;\n", "");
    check(mutPaste !== kfSrc, "注入点存在（pasteKeysAt 先验后改）");
    const mp = await loadEditorModule("keyframes", { [kfPath]: mutPaste });
    const kp = { origin: "0 0 0", alpha: 1 };
    const kpBefore = json(kp);
    try { mp.pasteKeysAt(kp, { origin: [1, 1, 1], alpha: [1, 2] }, 1); } catch {}
    check(json(kp) !== kpBefore || mp.pasteKeysAt({ alpha: 1 }, { alpha: [1, 2] }, 1), "pasteKeysAt 不先验维度时「整体拒绝」判据变红");
    const mutRel = kfSrc.replace("clip[f] = k.value.map((x, i) => r5(x + (base ? base[i] ?? 0 : 0)));", "clip[f] = k.value.map((x) => r5(x));");
    check(mutRel !== kfSrc, "注入点存在（copyKeysAt 加回基准）");
    const mr = await loadEditorModule("keyframes", { [kfPath]: mutRel });
    const relM = { origin: { value: "100 50 0", animation: { relative: true, c0: [{ back: { enabled: true, x: -1, y: 0 }, frame: 0, front: { enabled: true, x: 1, y: 0 }, lockangle: true, locklength: true, value: 0 }], c1: [{ back: { enabled: true, x: -1, y: 0 }, frame: 0, front: { enabled: true, x: 1, y: 0 }, lockangle: true, locklength: true, value: 0 }], c2: [{ back: { enabled: true, x: -1, y: 0 }, frame: 0, front: { enabled: true, x: 1, y: 0 }, lockangle: true, locklength: true, value: 0 }], options: { fps: 30, length: 60, mode: "loop" } } } };
    check(json(mr.copyKeysAt(relM, 0)) !== json({ origin: [100, 50, 0] }), "copyKeysAt 不加回基准时 relative 判据变红");
  }
  {
    const fxPath = path.join(ROOT, "editor/effects.ts");
    const fxSrc = fs.readFileSync(fxPath, "utf8");
    const mutFx = fxSrc.replace("g_FxStart <= g_FxEnd ? m : 1.0 - m", "m").replace("(floor(v_TexCoord / cell) + vec2(0.5, 0.5)) * cell", "floor(v_TexCoord / cell) * cell");
    check(mutFx !== fxSrc && (mutFx.match(/g_FxStart <= g_FxEnd/g) ?? []).length === 0, "注入点存在（渐隐方向 / 像素化格心）");
    const mf = await loadEditorModule("effects", { [fxPath]: mutFx });
    const fd = mf.effectById("fade").frag;
    const px = mf.effectById("pixelate").frag;
    check(!/g_FxStart <= g_FxEnd \? m : 1\.0 - m/.test(fd) && !/floor\(v_TexCoord \/ cell\) \+ vec2\(0\.5, 0\.5\)/.test(px), "渐隐不处理倒序 / 像素化取格角时判据变红");
  }
  {
    const dp = path.join(ROOT, "editor/doc.ts");
    const ds = fs.readFileSync(dp, "utf8");
    const mutForm = ds.replace('  if (typeof o.image === "string" && puppets?.has(o.image)) return "puppet";\n', "");
    check(mutForm !== ds, "注入点存在（modelFormOf 的 puppet 分支）");
    const mm = await loadEditorModule("doc", { [dp]: mutForm });
    const sc = { objects: [{ id: 1, image: "models/a.json" }] };
    check(mm.buildLayerTree(sc, new Map([["models/a.json", "a.mdl"]])).roots[0].modelForm !== "puppet", "modelFormOf 不认 puppet 表时「建树标 puppet」判据变红");
    const mp = path.join(ROOT, "editor/model.ts");
    const ms = fs.readFileSync(mp, "utf8");
    const mutEmpty = ms.replace('if (typeof json.puppet === "string" && json.puppet) out.set', 'if (typeof json.puppet === "string") out.set');
    check(mutEmpty !== ms, "注入点存在（scanPuppets 空 puppet 不算）");
    const me = await loadEditorModule("model", { [mp]: mutEmpty });
    const r = await me.scanPuppets({ scene: { objects: [{ id: 1, image: "a.json" }] } }, async () => new TextEncoder().encode('{"puppet":""}'));
    check(r.size === 1, "scanPuppets 把空 puppet 也算上时「空 puppet 不算」判据变红");
    const mutWrap = ms.replace('if (isWrapper(cur) && field !== "animation" && field !== "name") cur.value = v;\n  else a[field] = v;', "a[field] = v;");
    const mutHot = ms.replace('.every((a) => !a || !["blend", "rate", "visible", "additive", "name", "animation"].some((f) => isWrapper(a[f])))', ".every(() => true)");
    check(mutWrap !== ms && mutHot !== ms, "注入点存在（setAnimLayerField 包装只改 value / animLayersHot 看包装）");
    const mw = await loadEditorModule("model", { [mp]: mutWrap });
    const wo = { animationlayers: [{ animation: 1, blend: { script: "s", value: 1 } }] };
    mw.setAnimLayerField(wo, 0, "blend", 0.5);
    check(typeof wo.animationlayers[0].blend !== "object", "setAnimLayerField 覆盖包装时「脚本原样保留」判据变红");
    const mh = await loadEditorModule("model", { [mp]: mutHot });
    check(mh.animLayersHot({ animationlayers: [{ animation: 1, rate: { user: "u", value: 1 } }] }), "animLayersHot 不看包装时「有包装就重挂」判据变红");
    const mutSub = ms.replace("  local.origin[0] -= off[0];\n  local.origin[1] -= off[1];\n", "");
    const mutWorld = ms.replace("const off = name && i > 0 ? offOf(", "const off = false && name && i > 0 ? offOf(");
    check(mutSub !== ms && mutWorld !== ms, "注入点存在（attachToModel 减偏移 / attachedWorld 计挂件偏移）");
    const aDoc = () => docMod.makeDoc("a", null, { objects: [{ id: 10, image: "m.json", origin: "0 0 0" }, { id: 1, origin: "50 60 0" }] }, "loose");
    const aOff = (mid, name) => (mid === 10 && name === "h" ? [20, 30] : null);
    const ms1 = await loadEditorModule("model", { [mp]: mutSub });
    const d1 = aDoc();
    ms1.attachToModel(d1, 1, 10, "h", aOff);
    check(json(ms1.attachedWorld(d1.scene.objects, d1.scene.objects[1], aOff).origin) !== json([50, 60, 0]), "attachToModel 不减附着点偏移时「绑定前后世界不变」判据变红");
    const ms2 = await loadEditorModule("model", { [mp]: mutWorld });
    const d2 = docMod.makeDoc("a", null, { objects: [{ id: 10, image: "m.json", origin: "0 0 0" }, { id: 1, parent: 10, attachment: "h", origin: "0 0 0" }] }, "loose");
    check(json(ms2.attachedWorld(d2.scene.objects, d2.scene.objects[1], aOff).origin) === json([0, 0, 0]), "attachedWorld 忽略挂件偏移时「≡ 引擎挂件定位」判据变红");
  }
  const docPath = path.join(ROOT, "editor/doc.ts");
  const docSrc = fs.readFileSync(docPath, "utf8");
  const mutated = docSrc.replace("const insertAt = dir < 0 ? otherIdx[0] : otherIdx[otherIdx.length - 1] + 1;", "const insertAt = otherIdx[0];");
  check(mutated !== docSrc, "注入点存在（moveLayer 的插入位置）");
  const m = await loadEditorModule("doc", { [docPath]: mutated });
  const d = m.makeDoc("x", null, fixtureScene(), "loose");
  m.moveLayer(d, 2, 1);
  check(json(ids(d).slice(0, 6)) !== json([1, 6, 2, 3, 4, 5]), "moveLayer 改坏后「后移越过兄弟子树」判据变红");

  const mutDup = docSrc.replace("if (c.parent !== undefined && c.parent !== null && remap.has(String(c.parent))) c.parent = remap.get(String(c.parent))!;", "");
  check(mutDup !== docSrc, "注入点存在（duplicateLayer 的父指向重映射）");
  const m2 = await loadEditorModule("doc", { [docPath]: mutDup });
  const d2 = m2.makeDoc("x", null, fixtureScene(), "loose");
  m2.duplicateLayer(d2, 2, " copy");
  check(d2.scene.objects.find((o) => o.id === 14)?.parent !== 13, "duplicateLayer 不重映射父指向时判据变红");

  const placeFix = () => [
    { id: 1, text: "a", origin: "100 100 0", scale: "2 2 1", angles: "0 0 0.5" },
    { id: 2, text: "b", parent: 1, origin: "10 20 0" },
    { id: 3, text: "c", origin: "500 300 0", angles: "0 0 -0.3" },
    { id: 4, text: "d", parent: 3, origin: "40 -10 0" },
  ];
  const worldOf = (objs, id) => parseMod.parseScene({ general: {}, objects: structuredClone(objs) }, { type: "scene" }).layers.find((l) => l.id === id).origin;
  const mutCyc = docSrc.replace('  if (block.some((i) => objs[i] === target)) return "cycle";\n', "");
  check(mutCyc !== docSrc, "注入点存在（placeLayer 的成环检查）");
  const m3 = await loadEditorModule("doc", { [docPath]: mutCyc });
  check(m3.placeLayer(m3.makeDoc("x", null, { general: {}, objects: placeFix() }, "loose"), 3, 4, "inside") !== "cycle", "不查成环时「放进自己的子层被拒」判据变红");
  const mutRot = docSrc.replace("const cos = Math.cos(-p.angles[2]);\n  const sin = Math.sin(-p.angles[2]);", "const cos = 1;\n  const sin = 0;");
  check(mutRot !== docSrc, "注入点存在（relativeXform 的反旋转）");
  const m4 = await loadEditorModule("doc", { [docPath]: mutRot });
  const d4 = m4.makeDoc("x", null, { general: {}, objects: placeFix() }, "loose");
  const before4 = worldOf(d4.scene.objects, 2);
  m4.placeLayer(d4, 2, 3, "inside");
  const after4 = worldOf(d4.scene.objects, 2);
  check(Math.hypot(after4[0] - before4[0], after4[1] - before4[1]) > 1, `换父不反旋转时「世界变换不变」判据变红（偏了 ${Math.hypot(after4[0] - before4[0], after4[1] - before4[1]).toFixed(1)}px）`);
  const mutAn = docSrc.replace('    if (TRANSFORM_FIELDS.some((f) => hasAnimation(self[f]))) return "animated";\n', "");
  check(mutAn !== docSrc, "注入点存在（placeLayer 的动画拒绝）");
  const m5 = await loadEditorModule("doc", { [docPath]: mutAn });
  const fa = placeFix();
  fa[1].origin = { value: "10 20 0", animation: { c0: [], options: { fps: 30, length: 90, mode: "loop" } } };
  check(m5.placeLayer(m5.makeDoc("x", null, { general: {}, objects: fa }, "loose"), 2, 3, "inside") !== "animated", "不拒动画层时「换父级被拒」判据变红");

  const snapPath = path.join(ROOT, "editor/snap.ts");
  const snapSrc = fs.readFileSync(snapPath, "utf8");
  const mutSnap = snapSrc.replace("if (!(Math.abs(best) <= thr)) return { d, guides: [] };", "if (!(Math.abs(best) <= thr * 10)) return { d, guides: [] };");
  check(mutSnap !== snapSrc, "注入点存在（吸附阈值）");
  const snm1 = await loadEditorModule("snap", { [snapPath]: mutSnap });
  check(snm1.snapMove({ x0: 100, y0: 300, x1: 200, y1: 340 }, 320, 20, snm1.snapTargets({ x0: 0, y0: 0, x1: 1000, y1: 500 }, [])).dx !== 320, "阈值失守时「远处不吸」判据变红");
  const mutSnap2 = snapSrc.replace("if (Math.abs(gap) < Math.abs(best)) {", "if (Math.abs(gap) > 0 && best === Infinity) {");
  check(mutSnap2 !== snapSrc, "注入点存在（取最近候选）");
  const snm2 = await loadEditorModule("snap", { [snapPath]: mutSnap2 });
  check(snm2.snapMove({ x0: 0, y0: 0, x1: 100, y1: 10 }, 452, 0, snm2.snapTargets({ x0: 0, y0: 0, x1: 1000, y1: 500 }, [{ x0: 551, y0: 0, x1: 560, y1: 10 }])).dx !== 451, "不取最近时「多个候选取最近」判据变红");

  const mutGrp = docSrc.replace("scene: { ...doc.scene, objects: structuredClone(objs) } };", "scene: doc.scene! } as EditorDoc;");
  check(mutGrp !== docSrc, "注入点存在（groupLayers 先在副本上做）");
  const m6 = await loadEditorModule("doc", { [docPath]: mutGrp });
  const fg = [{ id: 1, text: "a", origin: "1 1 0" }, { id: 2, text: "b", origin: { value: "5 5 0", animation: { c0: [], options: { fps: 30, length: 90, mode: "loop" } } } }];
  const dg = m6.makeDoc("x", null, { general: {}, objects: structuredClone(fg) }, "loose");
  m6.groupLayers(dg, [1, 2], "g");
  check(dg.scene.objects.length !== 2, "直接改文档时「被拒则不留半个组」判据变红");
  const mutDist = snapSrc.replace("      out[order[0]] = [0, 0];\n", "      out[order[0]] = [1, 0];\n");
  check(mutDist !== snapSrc, "注入点存在（分布首个不动）");
  const snm3 = await loadEditorModule("snap", { [snapPath]: mutDist });
  check(json(snm3.alignDeltas([{ x0: 10, y0: 0, x1: 30, y1: 10 }, { x0: 100, y0: 50, x1: 160, y1: 70 }, { x0: 40, y0: 20, x1: 50, y1: 100 }], "hdist")[0]) !== json([0, 0]), "首个也挪时「首尾不动」判据变红");

  const gizPath = path.join(ROOT, "editor/gizmo.ts");
  const gizSrc = fs.readFileSync(gizPath, "utf8");
  const mutGiz = gizSrc.replace("let z = z0 - (a1 - a0);", "let z = z0 + (a1 - a0);");
  check(mutGiz !== gizSrc, "注入点存在（rotateZ 的方向）");
  const g = await loadEditorModule("gizmo", { [gizPath]: mutGiz });
  check(!near(g.rotateZ(0.3, [0, 0], [10, 0], [0, 10]), 0.3 - Math.PI / 2), "旋转方向反了时判据变红");

  const mutHost = HOST_TS.replace("if (exists && !marked) {", "if (false) {");
  check(mutHost !== HOST_TS, "注入点存在（宿主的编辑器标记检查）");
  const lib2 = path.join(tmpRoot, "lib-mut");
  fs.cpSync(path.join(hostLib, "author-item"), path.join(lib2, "author-item"), { recursive: true });
  const h2 = await startHost(lib2, mutHost);
  const st = (await fetch(`${h2.base}/api/editor/save-begin?item=author-item`, { method: "POST" })).status;
  await h2.close();
  check(st !== 409, "去掉标记检查后「作者条目拒绝覆盖」判据变红");

  const crPath = path.join(ROOT, "editor/create.ts");
  const crSrc = fs.readFileSync(crPath, "utf8");
  const mutCr = crSrc.replace("Math.min(1, (0.8 * W) / iw, (0.8 * H) / ih)", "Math.min((0.8 * W) / iw, (0.8 * H) / ih)");
  check(mutCr !== crSrc, "注入点存在（fit 不放大小图）");
  const cm = await loadEditorModule("create", { [crPath]: mutCr });
  const cd = cm.newDocument("x", 1920, 1080, [0, 0, 0]);
  cm.addImageLayer(cd, "s", { name: "s.png", width: 100, height: 50 }, "fit");
  check(vec(cd.scene.objects[0].scale)[0] !== 1, "fit 放大小图时「小图不放大」判据变红");

  const asPath = path.join(ROOT, "editor/assets.ts");
  const asSrc = fs.readFileSync(asPath, "utf8");
  const mutAs = asSrc.replace("return !owners.length || owners.some((g) => refs.has(g));", "return true;");
  check(mutAs !== asSrc, "注入点存在（保存清单按引用过滤）");
  const am = await loadEditorModule("assets", { [asPath]: mutAs });
  const ao = am.overlayAssets("scene.json", null, () => new Set());
  ao.put("models/editor/k.json", enc.encode("k"), "models/editor/k.json");
  check(ao.list().length !== 0, "不按引用过滤时「撤销掉的图片不进保存清单」判据变红");

  const fxPath = path.join(ROOT, "editor/effects.ts");
  const fxSrc = fs.readFileSync(fxPath, "utf8");
  const mutFx = fxSrc.replace("(cur as { value: unknown }).value = enc;", "pass.constantshadervalues[key] = enc;");
  check(mutFx !== fxSrc, "注入点存在（setEffectParam 保留 {user,value} 包装）");
  const fm = await loadEditorModule("effects", { [fxPath]: mutFx });
  const fo = { id: 1 };
  fm.addEffect(fo, "tint");
  fo.effects[0].passes[0].constantshadervalues.amount = { user: "a", value: 0.5 };
  fm.setEffectParam(fo, 0, "amount", 0.2);
  check(json(fo.effects[0].passes[0].constantshadervalues.amount) !== json({ user: "a", value: 0.2 }), "覆盖掉包装时「绑定保留」判据变红");

  const mutFx2 = fxSrc.replace('"material":"${p.key}"', '"material":"${p.key}_"');
  check(mutFx2 !== fxSrc, "注入点存在（uniform 注释的 material 名）");
  const fm2 = await loadEditorModule("effects", { [fxPath]: mutFx2 });
  const tintNotes = uniformNotes(fm2.effectById("tint").frag);
  check(tintNotes.get("g_FxAmount")?.note.material !== "amount", "material 名与参数名对不上时「scene.json 常量落到 uniform」判据变红");

  const txtPath = path.join(ROOT, "renderer/vendor/we-scene/render/text.js");
  const txtSrc = fs.readFileSync(txtPath, "utf8");
  const mutTxt = txtSrc.replace("if (same(mid)) hi = mid", "if (!same(mid)) hi = mid");
  check(mutTxt !== txtSrc, "注入点存在（语法错误行的二分方向）");
  const mutFile = path.join(path.dirname(txtPath), `.verify-mut-text-${process.pid}.js`);
  fs.writeFileSync(mutFile, mutTxt);
  cleanups.push(() => fs.rmSync(mutFile, { force: true }));
  const tm = await import(pathToFileURL(mutFile).href);
  check(tm.checkSceneScript("export function update(value) {\n\tlet a = 1;\n\n\treturn a +;\n}\n").line !== 4, "二分方向反了时「定位到第 4 行」判据变红");
  fs.rmSync(mutFile, { force: true });

  const scPath = path.join(ROOT, "editor/scripts.ts");
  const scSrc = fs.readFileSync(scPath, "utf8");
  const mutSc = scSrc.replace("at.host[at.key] = rest.length ? cur : cur.value;", "at.host[at.key] = cur.value;");
  check(mutSc !== scSrc, "注入点存在（去脚本时保留用户属性绑定）");
  const smut = await loadEditorModule("scripts", { [scPath]: mutSc });
  const so = { alpha: { user: "op", script: "x", value: 0.5 } };
  smut.removeScript(so, "alpha");
  check(json(so.alpha) !== json({ user: "op", value: 0.5 }), "去脚本时一并丢掉绑定，「绑定保留」判据变红");

  const upPath = path.join(ROOT, "renderer/vendor/we-scene/scene/user-props.js");
  const upSrc = fs.readFileSync(upPath, "utf8");
  const mutUp = upSrc.replace("const p = declareFromWire(props, k, entry) || (props[k] && typeof props[k] === 'object' ? props[k] : null)", "const p = props[k] && typeof props[k] === 'object' ? props[k] : null");
  check(mutUp !== upSrc, "注入点存在（引擎接住 wire 上的新声明）");
  const upMut = path.join(path.dirname(upPath), `.verify-mut-up-${process.pid}.js`);
  fs.writeFileSync(upMut, mutUp);
  cleanups.push(() => fs.rmSync(upMut, { force: true }));
  const um = await import(pathToFileURL(upMut).href);
  const mp = {};
  um.mergeUserPropertyValues(mp, {}, { fresh: { type: "slider", value: 0.25 } });
  const mo = [{ alpha: { user: "fresh", value: 1 } }];
  um.resolveUserProps(mo, mp, 0);
  check(mo[0].alpha.value !== 0.25, "不补声明时「新声明的 slider 驱动绑定」判据变红");
  fs.rmSync(upMut, { force: true });

  const hiPath = path.join(ROOT, "editor/history.ts");
  const hiSrc = fs.readFileSync(hiPath, "utf8");
  const mutHi = hiSrc.replace("if (after === before && propsAfter === propsBefore) return null;", "if (after === before) return null;");
  check(mutHi !== hiSrc, "注入点存在（只改属性表的结构命令）");
  const hm = await loadEditorModule("history", { [hiPath]: mutHi });
  const hd2 = docMod.makeDoc("h", { type: "scene" }, { objects: [] }, "loose");
  check(hm.structCommand(hd2, "x", null, (d) => (upMod.declareProp(d, "k", "bool") ? null : undefined)) === null, "只比对象数组时「声明属性可撤销」判据变红");

  const uPath = path.join(ROOT, "editor/userprops.ts");
  const uSrc = fs.readFileSync(uPath, "utf8");
  const mutU = uSrc.replace("(obj as Obj)[field] = rest.length ? cur : cur.value;", "(obj as Obj)[field] = cur.value;");
  check(mutU !== uSrc, "注入点存在（解绑时保留脚本包装）");
  const umod = await loadEditorModule("userprops", { [uPath]: mutU });
  const uo = { brightness: { user: "op", script: "x", value: 1 } };
  umod.unbindProp(uo, "brightness");
  check(json(uo.brightness) !== json({ script: "x", value: 1 }), "解绑时连脚本一起丢掉，「脚本保留」判据变红");

  const trPath = path.join(ROOT, "editor/trust.ts");
  const trSrc = fs.readFileSync(trPath, "utf8");
  const mutTr = trSrc.replace('if (kind === "new") return true;\n', "");
  check(mutTr !== trSrc, "注入点存在（新建工程永远执行）");
  const tm2 = await loadEditorModule("trust", { [trPath]: mutTr });
  check(!tm2.scriptsAllowedByDefault("new", false, null), "新建工程也按宿主判时「用户自己的内容永远执行」判据变红");
  const mutTr2 = trSrc.replace("return hostAvailable;", "return true;");
  check(mutTr2 !== trSrc, "注入点存在（无宿主默认不执行）");
  const tm3 = await loadEditorModule("trust", { [trPath]: mutTr2 });
  check(tm3.scriptsAllowedByDefault("local", false, null), "无宿主也执行时「在线版外来内容默认不执行」判据变红");

  const peAbs = path.join(ROOT, "renderer/src/editor/pkg-export.ts");
  const peSrc = fs.readFileSync(peAbs, "utf8");
  const mutPe = peSrc.replace("if (byLower.has(texPath.toLowerCase()) || out.has(texPath)) {", "if (false) {");
  check(mutPe !== peSrc, "注入点存在（已有同名 .tex 的源图不再转换）");
  const smod = await loadEditorModule("save", { [peAbs]: mutPe });
  const mp2 = smod.packProject([
    { path: "materials/old.tex", data: new Uint8Array([7]) },
    { path: "materials/old.png", data: stripePng(4, 4, [0, 0, 0], [0, 0, 0]) },
  ]);
  check(pkgC.getEntry(pkgC.parsePkg(mp2.packed.pkg), "materials/old.tex")?.[0] !== 7, "源图覆盖已有 .tex 时「已有 .tex 原样」判据变红");

  const txPath = path.join(ROOT, "editor/text.ts");
  const txSrc = fs.readFileSync(txPath, "utf8");
  const mutTx = txSrc.replace('if (isWrapped(cur) && ("value" in cur || "user" in cur || "script" in cur)) {', "if (false) {");
  check(mutTx !== txSrc, "注入点存在（文字字段写入保留包装）");
  const txm = await loadEditorModule("text", { [txPath]: mutTx });
  const tb = { text: { user: "title", value: "a" } };
  txm.setTextValue(tb, "b");
  check(json(tb.text) !== json({ user: "title", value: "b" }), "写穿包装时「绑定保留」判据变红");
  const mutTx2 = txSrc.replace("preset === \"plain\" ? [0] : measureTextBox(TEMPLATES[preset].samples", "preset === \"plain\" || true ? [0] : measureTextBox(TEMPLATES[preset].samples");
  check(mutTx2 !== txSrc, "注入点存在（模板脚本按最宽样例量盒）");
  const txm2 = await loadEditorModule("text", { [txPath]: mutTx2 });
  const td = createMod.newDocument("x", 1920, 1080, [0, 0, 0]);
  const tcid = txm2.addTextLayer(td, "clock", "c", "", fakeMeasure);
  check(td.scene.objects.find((x) => x.id === tcid).size !== "704.000 153.600", "时钟只按快照量盒时「按最宽样例」判据变红");
  const mutTx3 = txSrc.replace("return [Math.max(w, em * 0.5), Math.max(1, lines.length) * em * LINE_FACTOR];", "return [Math.max(w, em * 0.5), em * LINE_FACTOR];");
  check(mutTx3 !== txSrc, "注入点存在（盒高随行数）");
  const txm3 = await loadEditorModule("text", { [txPath]: mutTx3 });
  const tm4 = { text: "a\nb", pointsize: 32 };
  txm3.refitTextBox(tm4, fakeMeasure);
  check(tm4.size !== "64.000 307.200", "盒高不乘行数时「多行盒高」判据变红");

  const ptPath = path.join(ROOT, "editor/particles.ts");
  const ptSrc = fs.readFileSync(ptPath, "utf8");
  const ptMut = async (from, to, tag) => {
    const mut = ptSrc.replace(from, to);
    check(mut !== ptSrc, `注入点存在（${tag}）`);
    return loadEditorModule("particles", { [ptPath]: mut });
  };
  const pm1 = await ptMut('if (isWrapped(cur) && ("value" in cur || isBinding(cur))) {', "if (false) {", "倍率写入保留包装");
  const pb = { particle: "x.json", instanceoverride: { size: { user: "sz", value: 1 } } };
  pm1.setParticleParam(pb, "size", 3);
  check(json(pb.instanceoverride.size) !== json({ user: "sz", value: 3 }), "写穿包装时「绑定保留」判据变红");
  const pm2 = await ptMut("if (!Number.isFinite(n) || n < r.min || n > r.max) return false;", "if (!Number.isFinite(n)) return false;", "倍率范围校验");
  check(pm2.setParticleParam({ particle: "x.json" }, "size", 0), "不校验范围时「size 不收 0」判据变红");
  const pm3 = await ptMut("origin: vec3(0, H / 2 + 40, 0)", "origin: vec3(0, H * 2, 0)", "雪的发射线在画面顶边");
  const mAlive = simulate(pm3.particleSystemDef("snow", "snow", 1920, 1080), null, 1).alive;
  check(!(mAlive.length >= 20 && inRect(mAlive, 1920, 1080) >= 0.6), "发射线放到画面外时「粒子落在画面内」判据变红");
  const pm4 = await ptMut("if (hadColor) delete ov!.color;", "", "写 colorn 时去掉裸 color");
  const pl = { particle: "x.json", instanceoverride: { color: "255 0 0" } };
  pm4.setParticleColor(pl, [0, 1, 0]);
  check("color" in pl.instanceoverride, "不去裸 color 时「两者都在后写的生效」判据变红");

  const sndPath = path.join(ROOT, "editor/sound.ts");
  const sndSrc = fs.readFileSync(sndPath, "utf8");
  const sndMut = async (from, to, tag) => {
    const mut = sndSrc.replace(from, to);
    check(mut !== sndSrc, `注入点存在（${tag}）`);
    return loadEditorModule("sound", { [sndPath]: mut });
  };
  const sm1 = await sndMut('if (isWrapped(cur) && ("value" in cur || "user" in cur || "script" in cur)) {', "if (false) {", "音量写入保留包装");
  const sb = { sound: ["a.mp3"], volume: { user: "musicvolume", value: 0.7 } };
  sm1.setSoundField(sb, "volume", 0.4);
  check(json(sb.volume) !== json({ user: "musicvolume", value: 0.4 }), "写穿包装时「音量绑定保留」判据变红");
  const sm2 = await sndMut("n < 0 || n > 1", "false", "音量范围校验");
  check(sm2.setSoundField({ sound: ["a.mp3"] }, "volume", 1.5), "不校验范围时「音量越界拒绝」判据变红");
  const sm3 = await sndMut('for (const s of o.sound) if (typeof s === "string" && s) out.add(s);', 'if (typeof o.sound[0] === "string") out.add(o.sound[0]);', "列表里每一首都算引用");
  const sd3 = docMod.makeDoc("s", { type: "scene" }, { objects: [{ id: 1, sound: ["sounds/a.mp3", "sounds/b.ogg"] }] }, "loose");
  check(sm3.referencedSounds(sd3).size !== 2, "只认第一首时「每一首都算引用」判据变红（多首列表的其余音频会从保存清单丢掉）");

  const kfPath = path.join(ROOT, "editor/keyframes.ts");
  const kfSrc = fs.readFileSync(kfPath, "utf8");
  const kfMut = async (from, to, tag) => {
    const mut = kfSrc.replace(from, to);
    check(mut !== kfSrc, `注入点存在（${tag}）`);
    return loadEditorModule("keyframes", { [kfPath]: mut });
  };
  const km1 = await kfMut("c.splice(ins < 0 ? c.length : ins, 0, makeKey(frame, v, smooth));", "c.push(makeKey(frame, v, smooth));", "关键帧有序插入");
  const ko1 = { origin: "0 0 0" };
  km1.enableAnim(ko1, "origin", [0, 0, 0]);
  km1.setKey(ko1, "origin", 40, [1, 0, 0]);
  km1.setKey(ko1, "origin", 20, [2, 0, 0]);
  check(json(ko1.origin.animation.c0.map((k) => k.frame)) !== json([0, 20, 40]), "追加到末尾时「关键帧按帧号有序」判据变红（引擎二分会采错段）");
  const km2 = await kfMut("    delete plain[f];\n", "", "动画字段从静态改动里拎出");
  const ko2 = { origin: "0 0 0" };
  km2.enableAnim(ko2, "origin", [0, 0, 0]);
  check("origin" in km2.splitAnimated(ko2, { origin: [1, 2, 3] }).plain, "不拎出时「动画字段改动不写静态值」判据变红");
  const km4 = await kfMut("    if (v.keys.some((k) => k.frame === to)) return false;\n", "", "挪关键帧的占位检查");
  const k4 = { origin: { value: "0 0 0", animation: { c0: [{ frame: 0, value: 0 }, { frame: 30, value: 1 }, { frame: 60, value: 2 }], options: { fps: 30, length: 90, mode: "loop" } } } };
  km4.moveKeyTime(k4, 1, 2);
  check(new Set(k4.origin.animation.c0.map((k) => k.frame)).size < 3, "不查占位时「目标帧被占整体拒绝」判据变红（同帧两枚关键帧）");
  const km5 = await kfMut("      c.sort((x, y) => Number(x.frame) - Number(y.frame));\n", "", "挪关键帧后重排");
  const k5 = { origin: { value: "0 0 0", animation: { c0: [{ frame: 0, value: 0 }, { frame: 30, value: 1 }, { frame: 60, value: 2 }], options: { fps: 30, length: 90, mode: "loop" } } } };
  km5.moveKeyTime(k5, 2, 0.5);
  check(json(k5.origin.animation.c0.map((k) => k.frame)) !== json([0, 15, 30]), "不重排时「挪后仍按帧号有序」判据变红");
  const km3 = await kfMut("const v = r5(abs[i] - (base ? base[i] ?? 0 : 0));", "const v = r5(abs[i]);", "relative 减基准");
  const ko3 = { origin: { value: "100 0 0", animation: { relative: true, c0: [{ frame: 0, value: 0 }], c1: [{ frame: 0, value: 0 }], c2: [{ frame: 0, value: 0 }], options: { fps: 30, length: 60, mode: "loop" } } } };
  km3.setKey(ko3, "origin", 30, [130, 0, 0]);
  check(ko3.origin.animation.c0[1].value !== 30, "不减基准时「relative 写值 − 基准」判据变红（画面会多偏一个基准）");

  let mutSeq = 0;
  const vendorMut = async (rel, from, to, tag) => {
    const abs = path.join(ROOT, rel);
    const src = fs.readFileSync(abs, "utf8");
    const mut = src.replace(from, to);
    check(mut !== src, `注入点存在（${tag}）`);
    const file = path.join(path.dirname(abs), `.verify-mut-${path.basename(abs, ".js")}-${process.pid}-${++mutSeq}.js`);
    fs.writeFileSync(file, mut);
    cleanups.push(() => fs.rmSync(file, { force: true }));
    try {
      return await import(pathToFileURL(file).href);
    } finally {
      fs.rmSync(file, { force: true });
    }
  };
  const am1 = await vendorMut("renderer/vendor/we-scene/render/animation.js", "if (anim.parent || !autoPlay) return anim", "if (anim.parent) return anim", "seekTime 跳过 startpaused");
  const amc = am1.createAnimation({ c0: [{ frame: 0, value: 0 }], options: { fps: 30, length: 30, mode: "loop", startpaused: true } });
  amc.seekTime(0.5);
  check(amc.frame !== 0, "seek 也定位 startpaused 动画时「等脚本 play 的不动」判据变红");
  const am2 = await vendorMut("renderer/vendor/we-scene/render/animation.js", "anim._playing = !done", "if (done) anim._playing = false", "single 往回拖恢复播放");
  const ams = am2.createAnimation({ c0: [{ frame: 0, value: 0 }], options: { fps: 30, length: 30, mode: "single" } });
  ams.seekTime(5);
  ams.seekTime(0.5);
  check(!(ams.frame === 15 && ams.playing), "不恢复 playing 时「single 往回拖又能播」判据变红");
  const twm = await vendorMut("renderer/vendor/we-scene/pkg/tex-write.js", "out[op++] = off & 255\n    out[op++] = off >> 8", "out[op++] = (off + 1) & 255\n    out[op++] = (off + 1) >> 8", "LZ4 匹配偏移");
  const lz = new Uint8Array(4096).map((_, i) => i % 50);
  check(!same(texR.lz4Decompress(twm.lz4CompressBlock(lz), lz.length), lz), "匹配偏移写错时「LZ4 往返一致」判据变红");
  const twm2 = await vendorMut("renderer/vendor/we-scene/pkg/tex-write.js", "w.i32(fif)\n", "w.i32(FIF.UNKNOWN)\n", "TEXB0004 的 freeImageFormat");
  let ok2 = false;
  try {
    const p2 = stripePng(8, 8, [1, 2, 3], [4, 5, 6]);
    ok2 = same(texR.decodeMip0(texR.parseTex(twm2.encodeTexImage({ bytes: p2, width: 8, height: 8 }))).png, p2);
  } catch {
    ok2 = false;
  }
  check(!ok2, "freeImageFormat 写成 -1（读端当裸像素）时「内嵌 PNG 原字节」判据变红");
  const cm2 = await vendorMut("renderer/vendor/we-scene/pkg/container.js", ".sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))\n  for", "\n  for", "writePkg 排序");
  const e2 = [{ name: "b", data: new Uint8Array([1]) }, { name: "a", data: new Uint8Array([2]) }];
  check(!same(cm2.writePkg(e2), cm2.writePkg([...e2].reverse())), "不排序时「产物逐字节确定」判据变红");

  const HTP = "renderer/vendor/we-scene/render/hittest.js";
  const f0 = 1 / Math.tan(Math.PI / 4);
  const persp0 = [f0, 0, 0, 0, 0, f0, 0, 0, 0, 0, -101 / 99, -1, 0, 0, -200 / 99, 0];
  const ground0 = { pos: new Float32Array([-10, -1, -20, 10, -1, -20, 0, -1, 5]), indices: [0, 1, 2], vertexCount: 3, indexCount: 3 };
  const hm1 = await vendorMut(HTP, "  if (out.length < 3) return null\n  const poly = []", "  if (out.length < 3 || true) return null\n  const poly = []", "跨近裁剪面三角形的裁剪");
  check(!hm1.screenMeshesContain(hm1.projectMeshesToScreen([ground0], persp0, 400, 400), 200, 340), "整个丢掉跨面三角形时「相机身后的地面近处点得中」判据变红");
  const hm2 = await vendorMut(HTP, "  if ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax) === 0) return false\n", "", "零面积三角形跳过");
  const deg = { pos: new Float32Array([0, 0, 0, 50, 0, 0, 0, 50, 0, 0, 0, 0]), indices: [0, 1, 2, 3, 3, 3], vertexCount: 4, indexCount: 6 };
  check(hm2.screenMeshesContain(hm2.projectMeshesToScreen([deg], [0.01, 0, 0, 0, 0, 0.01, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 200, 100), 120, 40),
    "不跳过零面积三角形时「退化三角形不命中」判据变红（任意点都会被它判中）");
  const hm3 = await vendorMut(HTP, "    if (opts.meshHit) {\n      const r = opts.meshHit(layer)\n      if (r === true) { out.push(layer); continue }\n      if (r === false) continue\n    }\n", "", "meshHit 结论优先于 OBB");
  const ml = [{ id: 3, origin: [500, 100, 0], size: [100, 100], scale: [1, 1, 1], angles: [0, 0, 0], visible: true }];
  check(hm3.hitTestLayersAll(ml, 140, 100, 200, { meshHit: () => true }).length === 0, "忽略 meshHit 时「网格伸出矩形也命中」判据变红");
  const skm = await vendorMut("renderer/vendor/we-scene/render/mdl-skin.js", "        pos[i * 3] = x / total\n        pos[i * 3 + 1] = y / total", "        pos[i * 3] = x\n        pos[i * 3 + 1] = y", "蒙皮按总权重归一");
  const one = { bones: [{}], vertexCount: 1, positions: new Float32Array([2, 2, 0]), boneIdx: new Float32Array([0, 0, 0, 0]), weights: new Float32Array([0.5, 0, 0, 0]), indices: [0, 0, 0], indexCount: 3 };
  check(skm.skinnedMeshes(one, new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), false)[0].pos[0] !== 2, "不除 Σw 时「权重和 ≠ 1 也同顶点着色器」判据变红");

  const mdPath = path.join(ROOT, "editor/model.ts");
  const mdSrc = fs.readFileSync(mdPath, "utf8");
  const rtMat = { passes: [{ shader: "s", textures: ["a"] }] };
  const rtImg = { bytes: new Uint8Array([1]), ext: "png" };
  const mdMut = async (from, to, tag, file = mdPath) => {
    const src = file === mdPath ? mdSrc : fs.readFileSync(file, "utf8");
    const mut = src.replace(from, to);
    check(mut !== src, `注入点存在（${tag}）`);
    return loadEditorModule("model", { [file]: mut });
  };
  const rt1 = await mdMut("{ ...structuredClone(modelJson), material: editorMaterialOf(slug) }", "structuredClone(modelJson)", "model json 副本改指向材质副本");
  const rf1 = rt1.puppetRetexture({ material: "m.json", puppet: "p.mdl" }, rtMat, "k", rtImg).files[0].data;
  check(JSON.parse(dec.decode(rf1)).material === "m.json", "不改 material 时「model json 副本指向材质副本」判据变红（换了图画面不变）");
  const rt2 = await mdMut("  tex[0] = `editor/${slug}`;\n", "", "材质副本换槽 0");
  check(rt2.retexturedMaterial(rtMat, "k").passes[0].textures[0] === "a", "不换槽 0 时「材质副本槽 0 = editor/<slug>」判据变红");
  const mePath = path.join(ROOT, "renderer/src/editor/mdl-edit.ts");
  const rt3 = await mdMut("  m.materials[0] = materialPath;", "  for (const x of d!.meshes!) x.materials[0] = materialPath;", "只改指定子网格", mePath);
  const P3 = await imp("renderer/vendor/we-scene/render/mdl-parse.js");
  const t3 = (await imp("scripts/verify-editor-model.mjs")).modelTruth(LIB, "3477054430");
  const multi3 = t3?.objects.map((o) => t3.read(o.info.mdlPath)).find((b) => (P3.parseMDL(b).meshes?.length ?? 0) > 1);
  const after3 = multi3 && P3.parseMDL(rt3.meshRetexture(multi3, 1, rtMat, "t", rtImg).files[0].data);
  check(!!after3 && after3.meshes[0].materialPath === "materials/editor/t.json", "改全部子网格时「只有该子网格材质变」判据变红");
  const ovPath = path.join(ROOT, "editor/assets.ts");
  const ovSrc = fs.readFileSync(ovPath, "utf8");
  const asMutSrc = ovSrc.replace("if (owners.includes(from) && !owners.includes(to)) f.group = [...owners, to];", "");
  check(asMutSrc !== ovSrc, "注入点存在（share 记共同拥有者）");
  const as1 = await loadEditorModule("assets", { [ovPath]: asMutSrc });
  const ov1 = as1.overlayAssets("scene.json", null, () => new Set(["b"]));
  ov1.put("x", new Uint8Array(1), "a");
  ov1.share("a", "b");
  check(!ov1.list().includes("x"), "share 不生效时「第二次换图后第一次的材质仍进保存清单」判据变红");

  // W18a 骨骼编辑
  const meSrc = fs.readFileSync(mePath, "utf8");
  const { modelTruth: mt4, PUPPET_FIXTURES: pf4, MESH_FIXTURES: mf4 } = await imp("scripts/verify-editor-model.mjs");
  const boneMut = async (from, to, tag) => {
    const mut = meSrc.replace(from, to);
    check(mut !== meSrc, `注入点存在（${tag}）`);
    return loadRendererTs("renderer/src/editor/mdl-edit.ts", { [mePath]: mut });
  };
  const bm1 = await boneMut("k[b + 6 + c] *= 1 + wf * (s[c] - 1);", "k[b + 6 + c] *= s[c];", "缩放按权重淡出");
  check((await boneEditCorpus(bm1, P3, mt4, [...pf4, ...mf4])).bad.length > 0, "缩放不按权重淡出时「目标轨道逐帧对账」判据变红");
  const bm2 = await boneMut("const tr = a?.tracks[bone];", "const tr = a?.tracks[0];", "按骨号取轨道");
  check((await boneEditCorpus(bm2, P3, mt4, [...pf4, ...mf4])).bad.length > 0, "轨道取错时「其余轨道逐字节不变」判据变红");
  const bm3 = await boneMut("    if (loop) {\n      d %= span;\n      d = Math.min(d, span - d);\n    }\n", "", "loop 环绕距离");
  check(bm3.boneDeltaWeights(11, 0, 2, true)[10] === 0, "不环绕时「loop 首帧 = 末帧权重」判据变红");
  const bm4 = await boneMut("if (!(Number.isInteger(frame) && frame >= 0 && frame < frames)) return null;", "", "帧号校验");
  check((await boneEditCorpus(bm4, P3, mt4, pf4.slice(0, 2))).bad.some((b) => b.includes("越界未拒")), "不校验帧号时「越界拒绝」判据变红");
  const bm5 = await mdMut("{ ...structuredClone(modelJson), puppet: mdlPath }", "structuredClone(modelJson)", "model json 副本改指向 .mdl 副本");
  const pb5 = mt4(LIB, pf4[0]);
  const pobj5 = pb5?.objects.find((o) => o.info.form === "puppet" && P3.parseMDL(pb5.read(o.info.mdlPath)).animations.length);
  const pbytes5 = pobj5 && pb5.read(pobj5.info.mdlPath);
  const r5 = pbytes5 && bm5.boneEditFiles({ puppet: "a.mdl" }, pbytes5, "k", { animId: P3.parseMDL(pbytes5).animations[0].id, bone: 0, frame: 0, delta: { r: [0, 0, 1] }, radius: 0 });
  check(!!r5 && JSON.parse(dec.decode(r5.files[0].data)).puppet === "a.mdl", "不改 puppet 指向时「puppet 副本指向 .mdl 副本」判据变红（应用了画面不变）");

  // W18b 片段编辑
  const allFx = [...pf4, ...mf4];
  const clm1 = await boneMut("t.data.length >= 9 ? t.data.subarray(0, 9)", "t.data.length >= 18 ? t.data.subarray(9, 18)", "新建片段取首帧");
  check((await clipEditCorpus(clm1, P3, mt4, allFx)).bad.some((b) => b.includes("add 静止姿势")), "新建片段不取第 0 帧时「静止姿势」判据变红");
  const clm2 = await boneMut("if (!d || !anims || i <= 0) return null;", "if (!d || !anims || i < 0) return null;", "首个片段不许删");
  check((await clipEditCorpus(clm2, P3, mt4, allFx)).bad.some((b) => b.includes("删首个未拒")), "放开删首个片段时判据变红");
  const clm3 = await boneMut("    .sort((x, y) => x.frame - y.frame)\n", "", "事件按帧排序");
  check((await clipEditCorpus(clm3, P3, mt4, allFx)).bad.some((b) => b.includes("事件")), "事件不排序时「事件读回」判据变红");
  const clm4 = await boneMut("        if (d > Math.PI) d -= 2 * Math.PI;\n        else if (d < -Math.PI) d += 2 * Math.PI;\n", "", "重采样欧拉角最短方向");
  const r4 = clm4.resampleTrack(Float32Array.from([0, 0, 0, 0, 0, 3.0, 1, 1, 1, 10, 0, 0, 0, 0, -3.0, 2, 1, 1]), 3);
  check(Math.abs(Math.abs(r4[14]) - Math.PI) >= 0.01, "欧拉角不走最短方向时「中点 ≈ ±π」判据变红");
  const clm5 = await boneMut("const id = Math.max(...anims.map((a) => a.id)) + 1;", "const id = anims[0].id;", "新片段 id 不撞");
  check((await clipEditCorpus(clm5, P3, mt4, allFx)).bad.some((b) => b.includes("add 结构")), "新片段 id 撞旧片段时「add 结构」判据变红");

  // W19 glTF 导入
  const glPath = path.join(ROOT, "editor/gltf.ts");
  const glSrc = fs.readFileSync(glPath, "utf8");
  const glMut = async (from, to, tag) => {
    const mut = glSrc.replace(from, to);
    check(mut !== glSrc, `注入点存在（${tag}）`);
    return loadEditorModule("gltf", { [glPath]: mut });
  };
  const gm1 = await glMut("const bindOf = (n: number) => bindWorld.get(n) ?? worldOf(n);", "const bindOf = (n: number) => worldOf(n);", "绑定 = IBM⁻¹");
  check((await gltfSkinCheck(gm1)).worst > 1e-2, "绑定姿势改取节点静止姿势时 ★ 蒙皮误差判据变红");
  const gm2 = await glMut("const e = quatToEuler(q, prev);", "const e = quatToEuler(q);", "欧拉角连续");
  check((await gltfSkinCheck(gm2)).jump >= 0.6, "欧拉角不按上一帧取最近解时「相邻帧跳变」判据变红");
  const gm3 = await glMut("data.set([tr[0] * scale, tr[1] * scale, tr[2] * scale,", "data.set([tr[0], tr[1], tr[2],", "轨道平移乘 scale");
  check((await gltfSkinCheck(gm3)).worst > 1e-2, "轨道平移不乘 scale 时 ★ 判据变红");
  const gm4 = await glMut('  if (s.interp === "STEP") return val(k);\n', "", "STEP 插值");
  check((await gltfSkinCheck(gm4)).worst > 1e-2, "STEP 当 LINEAR 求值时 ★ 判据变红");
  const gm5 = await glMut("const w = top.map((p) => p[1] / sum);", "const w = top.map((p) => p[1]);", "截断后归一");
  check(Math.abs(gm5.topInfluences([0, 1, 2, 3, 4, 5], [0.1, 0.3, 0.05, 0.25, 0.2, 0.1], 0).w.reduce((s, v) => s + v, 0) - 1) > 1e-3, "截断后不归一时「前 4 个归一」判据变红");
}

// ───────────────────────────────────────────────────────────────────────────
// FX-INLINE. 作品自带（内联）效果参数：发现 → 写回逐字节 → 未知键保留（M1 A1/A2）
//
// 纯函数部分（下面全部）：无浏览器可跑 —— 夹具是内存里的 effect.json / 材质 / shader 三件套。
//
// headless 用例（需真浏览器，加 --headless 才跑；本机 13 个工程里没有 `Bar Count` 的现成夹具，
// 所以真浏览器那股只注明、不在本文件跑）：打开夹具工程 → 检视器「作品自带效果」展开 →
// 改 `Bar Count` → `scene.json` 里那一处常量值变、其余逐字节不变，且**出帧像素随之变**
// （引擎每帧现读同一份 `constantshadervalues`，见 scene-mount 与 renderer.js 的常量绑定段，
// 下面两条判据正是这个前提的守卫）。
// ───────────────────────────────────────────────────────────────────────────
section("FX-INLINE. 作品自带效果参数 editor/effects.ts（M1 A1/A2）");
{
  const fxi = await loadEditorModule("effects");
  const fxPath = path.join(ROOT, "editor/effects.ts");
  const fxSrc = fs.readFileSync(fxPath, "utf8");

  // 两段式夹具，与 WE 工程同形（本机实测）：effect.json 的 passes[i].material
  // → 材质 JSON 的 passes[0].shader → shaders/<shader>.frag|.vert 的 uniform 注释
  const FXF = "effects/other/bars/effect.json";
  const fxFiles = {
    [FXF]: json({
      version: 1,
      name: "bars",
      passes: [{ material: "materials/effects/bars.json" }, { material: "materials/effects/bars2.json" }],
    }),
    "materials/effects/bars.json": json({ passes: [{ shader: "effects/bars" }] }),
    "materials/effects/bars2.json": json({ passes: [{ shader: "effects/bars2" }] }),
    "shaders/effects/bars.frag": [
      'uniform float g_BarCount; // {"material":"Bar Count","label":"ui_editor_properties_bar_count","default":16,"range":[1,64]}',
      'uniform float g_Strength; // {"material":"Strength","default":0.3,"range":[0,1]}',
      'uniform vec3 g_BarColor; // {"material":"Bar Color","default":"1 0 0","type":"color"}',
      "void main() {}",
    ].join("\n"),
    "shaders/effects/bars.vert": 'uniform vec2 g_Scale; // {"material":"scale","default":"1 1","range":[0.01,10]}',
    "shaders/effects/bars2.frag": 'uniform float g_Opacity; // {"material":"ui_editor_properties_opacity","default":1,"range":[0,1]}',
  };
  const fxRead = async (name) => fxFiles[name] ?? null;

  // 夹具对象：常量键的大小写与 shader 声明**故意不同**（引擎匹配是大小写不敏感的），
  // 且混入未知键、`{user,value}` 包装、pass 上的未知字段、textures —— 它们都必须原样留着。
  // `bar count` 的值 20 与注释缺省 16 故意不等，这样「大小写不敏感取值」判据才咬得住。
  const fxObj = () => ({
    id: 7,
    image: "models/x.json",
    effects: [
      {
        file: FXF,
        id: 67,
        name: "bars",
        visible: true,
        passes: [
          {
            id: 68,
            constantshadervalues: { "bar count": 20, Strength: { user: "fxstrength", value: 0.3 }, mystery: 0.5, "Bar Color": "1 0 0" },
            textures: ["$mediaThumbnail", "custom/tex.png"],
          },
          { id: 69, constantshadervalues: { ui_editor_properties_opacity: 0.8 } },
        ],
      },
    ],
  });

  /**
   * FX-INLINE 判据体：返回失败清单（空 = 全绿）。变异红测复用它 ——
   * 「判据把错实现咬红」才是判据成立的证明。
   */
  const fxInlineCorpus = async (f) => {
    const bad = [];
    const is = (cond, msg) => {
      if (!cond) bad.push(msg);
    };

    // ---- 1. 参数发现：注释 → 表单模型（default / range / 类型 / 中文名 / pass 归属）----
    const passes = await f.inspectEffectPasses(FXF, fxRead);
    is(passes.length === 2, "pass 条数（每个 material pass 一条，含无可调参数的）");
    const p0 = passes[0]?.params ?? [];
    const keys = p0.map((p) => p.key);
    is(json(keys) === json(["Bar Count", "Strength", "Bar Color", "scale"]), "参数键：先 frag 后 vert，material 即键名");
    const bc = p0.find((p) => p.key === "Bar Count");
    is(bc?.type === "float" && bc?.default === 16 && bc?.min === 1 && bc?.max === 64, "range → min/max/step，default 取注释");
    is(bc?.label === "Bar Count", "label 以 ui_ 开头时回落成键名（WE 的本地化占位）");
    const col = p0.find((p) => p.key === "Bar Color");
    is(col?.type === "color" && json(col?.default) === json([1, 0, 0]), "vec3 + type:color → color，缺省 \"1 0 0\" → 三分量");
    const sc = p0.find((p) => p.key === "scale");
    is(sc?.type === "vec2" && json(sc?.default) === json([1, 1]) && sc?.min === 0.01 && sc?.max === 10, "vec2 字符串缺省 → 分量数组；.vert 里的 uniform 一样收");
    is(p0.every((p) => p.pass === 0) && passes[1]?.params?.every((p) => p.pass === 1), "每个参数带自己的 pass 下标（写回要落回同一个下标）");
    is(passes[1]?.params?.[0]?.key === "ui_editor_properties_opacity" && passes[1].params[0].pass === 1, "第二个 pass 的参数单独成表");

    // ---- 2. 视图：按 effect / pass 折叠，取值大小写不敏感，未知键只读列出 ----
    const decls = new Map([[FXF, p0]]);
    const o = fxObj();
    const views = f.inlinePassViews(o, decls);
    is(views.length === 2 && views[0].effect === 0 && views[0].pass === 0 && views[1].pass === 1, "视图按 effect / pass 展开");
    is(views[0].values["Bar Count"] === 20, "取值大小写不敏感（文档写 bar count、声明写 Bar Count）");
    is(views[0].values.Strength === 0.3 && json(views[0].values["Bar Color"]) === json([1, 0, 0]), "{user,value} 包装与颜色都能解码出当前值");
    is(json(views[0].keys) === json(["bar count", "Strength", "mystery", "Bar Color"]), "keys 列出该 pass 全部常量键（含认不出的）");
    is(views[0].values.mystery === undefined, "认不出的常量不进表单模型（没有声明就没有控件）");
    is(json(views[0].textures) === json(["$mediaThumbnail", "custom/tex.png"]), "textures 原样带出（本编辑器不改纹理槽）");

    // ---- 3. 写回逐字节：改一个值只动那一处 ----
    const before = json(o);
    is(f.setInlineParam(o, 0, 0, "Bar Count", 32, p0) === true, "写回命中已有键 → true");
    const csv0 = o.effects[0].passes[0].constantshadervalues;
    is(csv0["bar count"] === 32, "值写到**作者原本的键名**上（大小写不敏感命中，不改名）");
    is(json(Object.keys(csv0)) === json(["bar count", "Strength", "mystery", "Bar Color"]), "不新增键（认不出的键也没被挤掉）");
    const restored = JSON.parse(json(o));
    restored.effects[0].passes[0].constantshadervalues["bar count"] = 20;
    is(json(restored) === before, "逐字节：把那一处改回原值后整串完全相同（只有它变了）");
    is(o.effects[0].passes[0].id === 68 && json(o.effects[0].passes[1]) === json({ id: 69, constantshadervalues: { ui_editor_properties_opacity: 0.8 } }), "pass 上的未知字段与原样字段、另一个 pass 都没动");
    is(json(o.effects[0].passes[0].textures) === json(["$mediaThumbnail", "custom/tex.png"]), "写回后 textures 逐字节不动");
    is(csv0.mystery === 0.5, "认不出的常量（mystery）逐字节不动");

    // ---- 4. A2 前提：必须**就地**改那份对象，不能换成新对象 ----
    //     引擎按引用持有 scene.json 的 constantshadervalues（下面 parseScene 那条与这里配对）
    const csvRef = o.effects[0].passes[0].constantshadervalues;
    f.setInlineParam(o, 0, 0, "Bar Count", 24, p0);
    is(o.effects[0].passes[0].constantshadervalues === csvRef, "就地改同一份 constantshadervalues（换对象就热更不到引擎手上那份）");

    // ---- 5. {user|script|animation, value} 包装只改 .value ----
    is(
      f.setInlineParam(o, 0, 0, "Strength", 0.9, p0) === true && json(o.effects[0].passes[0].constantshadervalues.Strength) === json({ user: "fxstrength", value: 0.9 }),
      "{user,value} 包装只改 value，绑定原样保留",
    );

    // ---- 6. 值编码与 WE 同形（颜色 = "r g b" 字符串）----
    is(
      f.setInlineParam(o, 0, 0, "Bar Color", [0, 1, 0], p0) === true && o.effects[0].passes[0].constantshadervalues["Bar Color"] === "0 1 0",
      "颜色按 \"r g b\" 编码（与引擎解码一致）",
    );

    // ---- 7. 写回落到声明的那个 pass 上 ----
    is(
      f.setInlineParam(o, 0, 1, "ui_editor_properties_opacity", 0.5, passes[1].params) === true && o.effects[0].passes[1].constantshadervalues.ui_editor_properties_opacity === 0.5,
      "pass 下标落到声明的同一个 pass（不串到 pass 0）",
    );

    // ---- 8. 拒绝路径：认不出的键 / 越界 / 畸形结构，统统不动文档 ----
    is(f.setInlineParam(o, 0, 0, "nope", 1, p0) === false, "effect.json 里没声明的键拒绝（不新建）");
    is(f.setInlineParam(o, 0, 9, "Bar Count", 1, p0) === false, "pass 下标越界拒绝");
    is(f.setInlineParam(o, 9, 0, "Bar Count", 1, p0) === false, "effect 下标越界拒绝");
    is(f.inlinePassViews({ effects: [{ file: "effects/x/effect.json" }] }, decls).length === 0, "没有 passes 的效果条目不出视图（也不报错）");
    const weird = { effects: [{ file: "effects/x/effect.json", passes: [null, 3, "x"] }] };
    const weirdBefore = json(weird);
    is(f.setInlineParam(weird, 0, 0, "Bar Count", 1, p0) === false && json(weird) === weirdBefore, "非对象 pass 拒绝写回且逐字节不动");
    const fresh = { effects: [{ file: FXF, passes: [{}] }] };
    is(
      f.setInlineParam(fresh, 0, 0, "Bar Count", 32, p0) === true && json(fresh.effects[0].passes[0].constantshadervalues) === json({ "Bar Count": 32 }),
      "pass 没有 constantshadervalues 时新建，键用注释里的 material 名（引擎大小写不敏感能认）",
    );

    return bad;
  };

  const fxBad = await fxInlineCorpus(fxi);
  check(fxBad.length === 0, `作品自带效果：参数发现 / 写回逐字节 / 未知键保留全部成立（${fxBad.join(" / ") || "ok"}）`);

  // ---- 引擎侧：A2 的两条前提 ----
  {
    const raw = {
      camera: { center: "960 540", eye: "960 540 1000", up: "0 1 0", fov: 50 },
      general: { orthographic: true, zoom: 1, clearcolor: "0 0 0" },
      objects: [
        {
          id: 7,
          image: "models/x.json",
          origin: "960 540 0",
          size: "400 300",
          scale: "1 1 1",
          angles: "0 0 0",
          alpha: 1,
          effects: [
            {
              file: FXF,
              id: 67,
              name: "bars",
              visible: true,
              passes: [{ id: 68, constantshadervalues: { "bar count": 20 }, textures: ["$mediaThumbnail"] }],
            },
          ],
        },
      ],
    };
    const L = parseMod.parseScene(raw, { type: "scene" }).layers?.[0];
    check(
      !!L?.effects?.[0]?.passes?.[0] && L.effects[0].passes[0].constantshadervalues === raw.objects[0].effects[0].passes[0].constantshadervalues,
      "引擎按**引用**持有 scene.json 的 constantshadervalues（A2 就地改值即当帧生效的前提）",
    );
    const rndSrc = fs.readFileSync(path.join(ROOT, "renderer/vendor/we-scene/render/renderer.js"), "utf8");
    check(
      /const constMerged = \{ \.\.\.\(mp\.constants \|\| \{\}\), \.\.\.\(\(ov && ov\.constantshadervalues\) \|\| \{\}\) \}/.test(rndSrc),
      "渲染器每帧现读 ov.constantshadervalues（同一份对象 → 下一帧出帧就变）",
    );
    const smSrc = fs.readFileSync(path.join(ROOT, "renderer/src/scene-mount.ts"), "utf8");
    check(
      /const setEffectConstantsImpl = \(\s*id: number,\s*effect: number,\s*pass: number,/.test(smSrc) &&
        /const found = Object\.keys\(csv\)\.find\(\(k\) => k\.toLowerCase\(\) === key\.toLowerCase\(\)\);\s*if \(found === undefined\) continue;/.test(smSrc) &&
        /const entry = all\.filter\(\(e\) => !e\?\.layerMaterial\)\[effect\];/.test(smSrc) &&
        /return renderOnce\(\);/.test(smSrc.slice(smSrc.indexOf("const setEffectConstantsImpl"))),
      "引擎热更实现：查层 → 按文档下标跳过合成条目 → 大小写不敏感命中（不新增键）→ 补画一帧",
    );
    check(/setEffectConstants: setEffectConstantsImpl,/.test(smSrc) && /setEffectConstants\(id, effect, pass, values\)/.test(fs.readFileSync(path.join(ROOT, "renderer/src/editor/controls.ts"), "utf8")), "热更 API 挂进 editorImpl 并经 editorOf 转发（页面只走公共出口）");
    const typesSrc = fs.readFileSync(path.join(ROOT, "renderer/src/api/types.ts"), "utf8");
    check(/setEffectConstants\(\s*id: number,\s*effect: number,\s*pass: number,/.test(typesSrc), "EditorControls 声明了 setEffectConstants（分层契约）");
  }

  // ---- 页面接线：内联参数提交走热更通道（hotAlways），并调引擎 setEffectConstants ----
  {
    const mainSrc = fs.readFileSync(path.join(ROOT, "editor/main.ts"), "utf8");
    check(
      /function commitInlineParam\([\s\S]{0,1400}?void editor\?\.setEffectConstants\(Number\(layerId\), view\.effect, view\.pass, \{ \[param\.key\]: raw \}\)\.catch\(\(\) => \{\}\);\s*\},\s*true,\s*\);/.test(mainSrc),
      "面板接线：内联参数提交 = structEdit(..., hot, true)（对象数组变了也走热路径）+ 引擎 setEffectConstants",
    );
    check(
      /group\.appendChild\(inlineFxSection\(node, editable\)\);/.test(mainSrc) &&
        /const params = v\.def \? v\.def\.params : externalParamsOf\(v\.file\)/.test(mainSrc) &&
        /function inlineFxSection\(node: LayerNode, editable: boolean\): HTMLElement/.test(mainSrc),
      "fx 分组末尾接上「作品自带效果」分区，内置效果那条路径没被改掉（旧判据仍在）",
    );
    const i18nSrc = fs.readFileSync(path.join(ROOT, "editor/i18n.ts"), "utf8");
    const fxInlineKeys = ["fx.inlineTitle", "fx.inlineHint", "fx.inlinePass", "fx.inlineLoading", "fx.inlineNoParams", "fx.inlineUnknown", "fx.inlineTextures"];
    const missingFxInline = fxInlineKeys.filter((k) => (i18nSrc.match(new RegExp(`"${k.replace(/\./g, "\\.")}":`, "g")) ?? []).length !== 2);
    check(missingFxInline.length === 0, `作品自带效果文案中英文都有（缺 ${json(missingFxInline)}）`);
    const cssSrc = fs.readFileSync(path.join(ROOT, "editor/editor.css"), "utf8");
    check(/\.ed-inline-pass\b/.test(cssSrc) && /\.ed-inline-unknown\b/.test(cssSrc) && /\.ed-inline-textures\b/.test(cssSrc), "折叠面板样式在 editor.css");
  }

  // ---- 变异红测：判据咬得住吗 ----
  {
    const fxMut = async (from, to, tag) => {
      const mut = fxSrc.replace(from, to);
      check(mut !== fxSrc, `注入点存在（${tag}）`);
      return loadEditorModule("effects", { [fxPath]: mut });
    };
    // 写回不认原名、直接按声明键写：多出一个键，逐字节判据与「不新增键」一起红
    const fm1 = await fxMut("const real = constantKeyOf(target, p.key) ?? p.key;", "const real = p.key;", "写回用原名");
    const fm1bad = (await fxInlineCorpus(fm1)).join(" / ");
    check(/新增键|逐字节/.test(fm1bad), "不按原名写回时「不新增键 / 逐字节」判据变红");
    // 大小写敏感匹配：取值与写回都落空
    const fm2 = await fxMut("for (const k of Object.keys(csv)) if (k.toLowerCase() === want) return k;", "for (const k of Object.keys(csv)) if (k === key) return k;", "常量键大小写不敏感");
    const fm2bad = (await fxInlineCorpus(fm2)).join(" / ");
    check(/大小写不敏感/.test(fm2bad), "常量键改成大小写敏感时「取值大小写不敏感」判据变红");
    // 无视 {user,value} 包装：绑定被抹掉
    const fm3 = await fxMut(
      '  if (cur && typeof cur === "object" && !Array.isArray(cur) && "value" in cur) (cur as { value: unknown }).value = enc;\n  else csv[real] = enc;',
      "  csv[real] = enc;",
      "包装只改 value",
    );
    const fm3bad = (await fxInlineCorpus(fm3)).join(" / ");
    check(/包装只改 value/.test(fm3bad), "无视 {user,value} 包装时「只改 value」判据变红");
    // pass 下标丢失：参数表全部记成 pass 0
    const fm4 = await fxMut("for (const p of parseShaderParams(src, i))", "for (const p of parseShaderParams(src, 0))", "参数带 pass 下标");
    const fm4bad = (await fxInlineCorpus(fm4)).join(" / ");
    check(/pass 下标/.test(fm4bad), "丢掉 pass 下标时「每个参数带自己的 pass 下标」判据变红");
    // 写回时重建常量对象（浅拷贝也行）：内容一样，但引擎手上那份就断了
    const fm5 = await fxMut(
      "  const csv = (target.constantshadervalues ??= {});",
      "  const csv = (target.constantshadervalues = { ...(target.constantshadervalues ?? {}) });",
      "写回就地改",
    );
    const fm5bad = (await fxInlineCorpus(fm5)).join(" / ");
    check(/就地改同一份/.test(fm5bad), "写回时重建常量对象（非就地）时「就地改同一份」判据变红");
    // 引擎侧：parseScene 改成深拷贝 constantshadervalues → A2 前提判据红
    const parsePath = path.join(ROOT, "renderer/vendor/we-scene/scene/parse.js");
    const parseSrc = fs.readFileSync(parsePath, "utf8");
    const parseMut = parseSrc.replace("constantshadervalues: p.constantshadervalues || {},", "constantshadervalues: { ...(p.constantshadervalues || {}) },");
    check(parseMut !== parseSrc, "注入点存在（parse.js 常量对象按引用）");
    const rawRef = {
      camera: { center: "960 540", eye: "960 540 1000", up: "0 1 0", fov: 50 },
      general: { orthographic: true, zoom: 1, clearcolor: "0 0 0" },
      objects: [{ id: 7, image: "models/x.json", origin: "960 540 0", size: "400 300", scale: "1 1 1", angles: "0 0 0", alpha: 1, effects: [{ file: FXF, passes: [{ constantshadervalues: { "bar count": 20 } }] }] }],
    };
    // 用 esbuild 打包（相对 import 照原目录解析），只把 parse.js 换成变异源码
    const parseBundled = await build({
      entryPoints: [parsePath],
      bundle: true,
      write: false,
      format: "esm",
      platform: "neutral",
      target: "es2022",
      logLevel: "silent",
      plugins: [{ name: "fxinline-mut", setup: (b) => b.onLoad({ filter: /scene[\\/]parse\.js$/ }, () => ({ contents: parseMut, loader: "js" })) }],
    });
    const tmpParse = path.join(tmpRoot, `parse-mut-${Math.random().toString(36).slice(2)}.mjs`);
    fs.writeFileSync(tmpParse, parseBundled.outputFiles[0].text);
    const parseMutMod = await import(pathToFileURL(tmpParse).href);
    const rawCopy = structuredClone(rawRef);
    const Lm = parseMutMod.parseScene(rawCopy, { type: "scene" }).layers?.[0];
    check(
      Lm?.effects?.[0]?.passes?.[0]?.constantshadervalues !== rawCopy.objects[0].effects[0].passes[0].constantshadervalues,
      "parseScene 深拷贝 constantshadervalues 时「按引用持有」判据变红",
    );
  }

  console.log("  （headless：打开夹具 → 改 Bar Count → scene.json 值与出帧都变；见本段头注）");
}

// ───────────────────────────────────────────────────────────────────────────
// M10. 插件面补完（D1 空槽位 / D2 particles.components / D3 命令注册 API /
//      D4 catalog 装配 / D5 core barrel / D6 逐项权限开关 + 插件日志）
// ───────────────────────────────────────────────────────────────────────────
section("M10. 插件面补完（D1–D6）");
{
  const readEd = (p) => fs.readFileSync(path.join(ROOT, "editor", p), "utf8");
  const main = readEd("main.ts");
  const html10 = readEd("index.html");
  const css10 = readEd("editor.css");
  const i18n10 = readEd("i18n.ts");
  const ext10 = readEd("plugins/external.ts");
  const panel10 = readEd("ui/plugin-panel.ts");
  const cmds10 = readEd("services/commands.ts");
  const types10 = readEd("services/types.ts");
  const log10 = readEd("plugins/log.ts");
  const core10 = readEd("core/index.ts");

  // ── D3：命令注册只有 register 一条路（内置与插件同 API，键盘派发与 list() 枚举同一份 registry）──
  check(/register\(def: CommandDef, owner\?: string\): Disposer;/.test(types10) && /const register = \(def: CommandDef, owner\?: string\): Disposer =>/.test(cmds10) && /return registry\.add\(def, owner\);/.test(cmds10),
    "D3：命令服务暴露 register(def, owner)，返回撤销函数、owner 记归属（registry 只剩只读枚举）");
  check(/命令必须有非空 id/.test(cmds10) && /缺少 run/.test(cmds10), "D3：register 当场校验空 id / 缺 run（插件写坏命令不会被静默登记）");
  check(/const cmd = \(c: Parameters<typeof cmds\.register>\[0\]\) => ctx\.effect\(\(\) => cmds\.register\(c, ctx\.name\)\);/.test(main) && (main.match(/cmd\(\{/g) ?? []).length === 7 && !/cmds\.add\(/.test(main),
    `D3：内置 7 条命令改走同一 register（实得 ${(main.match(/cmd\(\{/g) ?? []).length} 条，页面不再直接 registry.add）`);
  const builtinCmdIds = ["edit.undo", "edit.redo", "file.save", "layer.duplicate", "layer.rename", "layer.delete", "export.run"];
  const missCmd = builtinCmdIds.filter((id) => !main.includes(`id: "${id}"`));
  check(missCmd.length === 0, `D3：内置命令 id 逐位未变（缺 ${json(missCmd)}）`);

  // ── D1：七个槽位都有宿主元素、语义位置正确、且真的被 mount 消费 ──
  const slotHosts = [
    ["menu.export", "ed-plugin-export", 'id="export-menu"'],
    ["menu.add", "ed-plugin-add", 'class="wb-subbar ed-layer-tools"'],
    ["panel.right", "ed-plugin-right", 'id="ed-right"'],
    ["inspector.project", "ed-plugin-project", 'id="ed-right"'],
    ["statusbar", "ed-plugin-status", 'id="statusbar"'],
    ["viewport.overlay", "ed-plugin-overlay", 'id="ed-viewport"'],
  ];
  // 容器内部片段（按标签配对扫描），用来断言宿主确实在语义位置里而不是页面随便一处
  const innerOf = (sel) => {
    const at = html10.indexOf(sel);
    if (at < 0) return "";
    const open = html10.lastIndexOf("<", at);
    const tag = /^<([a-zA-Z]+)/.exec(html10.slice(open))?.[1] ?? "div";
    const re = new RegExp(`<${tag}\\b|</${tag}>`, "g");
    let i = html10.indexOf(">", at) + 1;
    let depth = 1;
    re.lastIndex = i;
    let m;
    while ((m = re.exec(html10))) {
      if (m[0].startsWith("</")) {
        depth--;
        if (!depth) return html10.slice(i, m.index);
      } else depth++;
    }
    return "";
  };
  const badHosts = slotHosts.filter(([slot, id, region]) => {
    const tag = new RegExp(`<div[^>]*id="${id}"[^>]*>`).exec(html10)?.[0] ?? "";
    return !tag.includes("ed-plugin-group") ||
      !new RegExp(`\\["${slot.replace(/\./g, "\\.")}", "#${id}"\\]`).test(main) ||
      !innerOf(region).includes(`id="${id}"`);
  });
  check(badHosts.length === 0, `D1：六个空槽位各有宿主元素 + 挂载表项 + 位置正确（缺 ${json(badHosts.map((x) => x[0]))}）`);
  check(/const unmountPluginSlots: Array<\(\) => void> = \[\];/.test(main) && /unmountPluginSlots\.push\(ui\.mount\(slot, host\), ui\.onChange\(slot, sync\)\)/.test(main) && /const sync = \(\) => \(host\.hidden = !ui\.items\(slot\)\.length\)/.test(main) && /for \(const off of unmountPluginSlots\.splice\(0\)\) off\(\);\n    mountPluginSlots\(\);/.test(main),
    "D1：六个槽位逐个 mount 到宿主（没有贡献时隐藏），切语言先撤旧 mount 再重挂");
  check(/<div class="wb-tb-group" id="ed-plugin-tools" hidden><\/div>/.test(html10) && /ui\.mount\("toolbar", pluginToolsEl\)/.test(main) && /pluginToolsEl\.hidden = !ui\.items\("toolbar"\)\.length/.test(main),
    "D1：toolbar 槽位接线保持原样（范例贡献者仍走它）");
  check(/\.ed-plugin-group \{/.test(css10) && /\.ed-plugin-group\[hidden\] \{/.test(css10) && /#ed-plugin-overlay > \* \{/.test(css10),
    "D1：槽位容器样式横排、hidden 优先、叠层不吃鼠标事件（容器本身 pointer-events: none）");

  // ── D2：particles.components 外部数据入口 ──
  check(/"particles\.components"\?: string\[\];/.test(ext10) && /for \(const k of \["effects", "particles", "particles\.components", "shaders"\] as const\)/.test(ext10) && /new Set\(\["effects", "particles", "particles\.components", "shaders", "i18n"\]\)/.test(ext10),
    "D2：清单白名单加 particles.components（路径数组校验与别的数据键同一条路，拼错的键仍会报错）");
  check(/components: \[\]/.test(ext10) && /out\.components\.push\(\{ id: j\.id, kind, params \}\)/.test(ext10) && /parseSchema\(j\.params, `粒子组件 \$\{p\}\.params`\)/.test(ext10) && /ctx\.contribute\("particles\.components", k\)/.test(ext10),
    "D2：组件 JSON → ParticleComponent（kind 四选一 + 参数描述走 parseSchema）→ 注册进 particles.components");
  check(/if \(c\["particles\.components"\]\?\.length\) need\.add\("particles\.components"\);/.test(ext10),
    "D2：声明了组件才 inject particles.components（数据贡献仍由可信外层 ctx 注册、不需要 permissions）");

  // ── D4 / D5：死装配处置与内核入口统一 ──
  const builtinIdx = readEd("plugins/builtin/index.ts");
  const appTs = readEd("app.ts");
  check(/plugins: Object\.keys\(BUILTIN_CATALOG\)\.map\(\(name\) => \(\{ name \}\)\)/.test(builtinIdx) && /mergeProfiles\(BUILTIN_PROFILE, opts\.profile\)/.test(appTs) && /\.\.\.BUILTIN_CATALOG, \.\.\.opts\.catalog/.test(appTs) && !/app\.plugin\(/.test(main),
    "D4：内置 catalog/profile 装配改成真消费（bootEditor 默认带 8 个内置插件；页面不再有第二条 app.plugin 装配路）");
  const regBlock = /export const REGISTRIES = \{([\s\S]*?)\n\} as const satisfies/.exec(builtinIdx)?.[1] ?? "";
  const regKeys = [...regBlock.matchAll(/^\s{2}("[^"]+"|[A-Za-z_$][\w$]*)/gm)].map((m) => m[1].replace(/"/g, ""));
  check(regKeys.length === 13 && /provides: Object\.keys\(REGISTRIES\)/.test(builtinIdx) && regKeys.includes("particles.components"),
    `D4：13 个数据服务名由 registries 插件一并提供（实得 ${regKeys.length} 个：${regKeys.join(" / ")}）`);
  const strayCore = [];
  const walkEd = (dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, "editor", dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name !== "core") walkEd(rel);
      } else if (e.name.endsWith(".ts") && rel !== "services/types.ts" && /from "\.\.?\/core\/(context|registry|schema|loader)"/.test(readEd(rel))) {
        strayCore.push(rel);
      }
    }
  };
  walkEd("");
  check(strayCore.length === 0, `D5：editor/ 内一律从 barrel 引内核（唯一例外 services/types.ts 的模块增强；越界 ${json(strayCore)}）`);
  check(/export \* from "\.\/context"/.test(core10) && /export \* from "\.\/registry"/.test(core10) && /export \* from "\.\/schema"/.test(core10) && /export \* from "\.\/loader"/.test(core10) && /模块增强/.test(types10),
    "D5：core barrel 四个子模块全转出，模块增强处注明必须指向真正的 ../core/context 模块");

  // ── D6：逐项权限开关 + 插件日志（权限语义与 ERROR_BUDGET 不变）──
  check(/export const permKey = \(id: string, permission: string\)/.test(ext10) && /export function deniedPermissions\(/.test(ext10) && /grantedOf = \(m: PluginManifest, denied\?: ReadonlySet<string>\)/.test(ext10) && /grantedOf\(m, denied\)/.test(ext10),
    "D6：逐项权限开关落成设置键 plugins.perm.<id>.<perm>，挂载时结算成白名单（只有显式 false 才算关）");
  check(/const ERROR_BUDGET = 5/.test(readEd("core/context.ts")), "D6：连续 5 错自动停用（ERROR_BUDGET = 5）行为未变");
  check(/createPluginLog/.test(log10) && /queueMicrotask/.test(log10) && /items\.splice\(0, items\.length - limit\)/.test(log10),
    "D6：插件日志是内存环形缓冲 + 微任务合批（不碰 DOM，面板自己订阅）");
  check(/function renderPermissions\(/.test(panel10) && /cb\.dataset\.perm = p;/.test(panel10) && /o\.settings\.set\(permKey\(entry\.id, p\), cb\.checked\)/.test(panel10) && /o\.manager\.reload\(entry\.id\)/.test(panel10),
    "D6：面板每个清单权限一个开关，改完 reload 用新白名单重挂（不就地改已生效的白名单）");
  check(/function renderLogs\(/.test(panel10) && /"logs-clear"/.test(panel10) && /logs\?: PluginLog;/.test(panel10) && /function logEntriesOf\(/.test(panel10),
    "D6：面板能看插件日志（按插件合并 ext:<id> 与清单 id、可清空、有 error 时默认展开）");
  check(/logs: pluginLog,/.test(main) && /settings: a\.settings,/.test(main) && /pluginLog\.onChange\(/.test(main) && /manifestIdOf/.test(main),
    "D6：main.ts 把同一份 settings / 日志底座交给面板，面板开着时日志一变就重绘");
  const plKeys = ["pl.permsTitle", "pl.permHigh", "pl.logs", "pl.logsEmpty", "pl.logsClear", "pl.c.components"];
  const missKeys = plKeys.filter((k) => (i18n10.match(new RegExp(`"${k.replace(/\./g, "\\.")}":`, "g")) ?? []).length !== 2);
  check(missKeys.length === 0, `D6：面板新文案中英文都恰好一条（缺 ${json(missKeys)}）`);

  // D6 行为判据（不只断言源码字符串）：直接驱动纯模块（editor/plugins/log.ts 不碰 DOM）
  {
    const logMod = await loadEditorModule("plugins/log");
    check(typeof logMod.createPluginLog === "function", "D6 行为：插件日志模块可离线加载并建实例");
    const L = logMod.createPluginLog(3);
    L.push("a", "info", "1");
    L.push("a", "warn", "2");
    L.push("b", "error", "3");
    L.push("a", "info", "4");
    const all = L.list();
    check(
      all.length === 3 && all[0].text === "2" && all[2].text === "4",
      `D6 行为：环形缓冲超上限丢最老的（limit=3，实得 ${json(all.map((x) => x.text))}）`,
    );
    const snap = L.list();
    snap.push({ plugin: "x", level: "info", text: "外部改动", at: 0 });
    check(L.list().length === 3, "D6 行为：list() 返回副本，外部改动不回写内部缓冲");
    L.clear("a");
    check(
      L.list("a").length === 0 && L.list("b").length === 1 && L.list().length === 1,
      "D6 行为：clear(plugin) 只清该插件（clear() 才是全清）",
    );
    const defaults = logMod.createPluginLog();
    for (let i = 0; i < 250; i++) defaults.push("p", "info", `m${i}`);
    check(
      defaults.list().length === 200 && defaults.list()[0].text === "m50" && defaults.list()[199].text === "m249",
      "D6 行为：默认上限 200（push 250 条后首条 = 第 51 条，末条 = 最后一条）",
    );
    const L2 = logMod.createPluginLog();
    let calls = 0;
    const off = L2.onChange(() => {
      calls++;
    });
    L2.push("p", "info", "x");
    L2.push("p", "warn", "y");
    L2.push("p", "error", "z");
    check(calls === 0, "D6 行为：回调是微任务合批的（同一次同步循环里还没触发）");
    await new Promise((r) => setTimeout(r, 0));
    check(calls === 1, `D6 行为：一次错误风暴只重绘一次（3 条 push 合成 1 次回调，实得 ${calls}）`);
    off();
    L2.push("p", "info", "after-off");
    await new Promise((r) => setTimeout(r, 0));
    check(calls === 1, "D6 行为：onChange 返回的 Disposer 真的退订");
  }
}

// ───────────────────────────────────────────────────────────────────────────
// M7. 交互补齐：框选 / 全选 / 取消成组（C1）、树搜索·隔离（C2）、锁定入栈（A9）、图层剪贴板（A10）
// ───────────────────────────────────────────────────────────────────────────
const marqueeMod = await loadEditorModule("marquee");
const treeQueryMod = await loadEditorModule("tree-query");
const clipboardMod = await loadEditorModule("clipboard");
const mainSrcText = fs.readFileSync(path.join(ROOT, "editor/main.ts"), "utf8");
const i18nSrc = fs.readFileSync(path.join(ROOT, "editor/i18n.ts"), "utf8");
const htmlSrc = fs.readFileSync(path.join(ROOT, "editor/index.html"), "utf8");
const cssSrc = fs.readFileSync(path.join(ROOT, "editor/editor.css"), "utf8");

section("SELECT-2. 框选命中 / 选择集合合并 / 取消成组（C1）");
{
  const M = marqueeMod;
  const rect = M.rectOf(30, 30, 10, 10);
  check(json(rect) === json({ x0: 10, y0: 10, x1: 30, y1: 30 }), "rectOf 把任意方向的拖拽规范化成 x0<=x1 / y0<=y1");
  check(M.boxHasPoint({ x0: 0, y0: 0, x1: 10, y1: 10 }, 10, 10) && !M.boxHasPoint({ x0: 0, y0: 0, x1: 10, y1: 10 }, 10.5, 0), "boxHasPoint 含边界");
  check(M.boxIntersects(rect, { x0: 30, y0: 30, x1: 50, y1: 50 }) && !M.boxIntersects(rect, { x0: 31, y0: 0, x1: 40, y1: 40 }), "boxIntersects：边贴边算相交，隔开不算");
  const layers = [
    { id: 1, visible: true, box: { x0: 0, y0: 0, x1: 50, y1: 50 } },
    { id: 2, visible: true, box: { x0: 100, y0: 100, x1: 120, y1: 120 } },
    { id: 3, visible: false, box: { x0: 0, y0: 0, x1: 50, y1: 50 } },
    { id: 4, visible: true, box: null },
  ];
  check(json(M.marqueeHits(layers, rect)) === json([1]), "★ 框选命中：只收相交的可见层，隐藏层与量不到包围盒的层跳过");
  check(M.boxFromCorners(null) === null && json(M.boxFromCorners([[3, 4], [-1, 9]])) === json({ x0: -1, y0: 4, x1: 3, y1: 9 }), "boxFromCorners：空轮廓 null，否则取外接矩形");
  check(json(M.marqueeSelect([1, 2], [2, 3], true)) === json([1, 3]), "★ ⇧ 追加框选：命中的已选层被剔除（再框一次取消），其余并入");
  check(json(M.marqueeSelect([1, 2], [3], false)) === json([3]) && json(M.marqueeSelect([1], [], false)) === json([]), "普通框选直接替换选区，框空即清空");

  // 取消成组：子层世界变换不变 + 组位置让给子层
  const mkScene = (objects, type = "scene") =>
    docMod.makeDoc("t", null, { general: {}, objects: typeof objects === "function" ? objects() : objects }, type);
  const ungroupObjs = () => [
    { id: 1, text: "a", origin: "100 100 0" },
    { id: 2, text: "g", origin: "50 20 0", scale: "2 2 1", angles: "0 0 0.3" },
    { id: 3, text: "b", parent: 2, origin: "10 5 0" },
    { id: 4, text: "c", parent: 2, origin: "-20 7 0", angles: "0 0 -0.1" },
    { id: 5, text: "d", origin: "700 500 0" },
  ];
  const worldOf = (o) =>
    new Map(
      parseMod
        .parseScene({ general: {}, objects: structuredClone(o) }, { type: "scene" })
        .layers.map((l) => [l.id, [l.origin[0], l.origin[1]]]),
    );
  let ud = mkScene(ungroupObjs);
  const wu0 = worldOf(ungroupObjs());
  const ur = docMod.ungroup(ud, 2);
  const wu1 = worldOf(ud.scene.objects);
  check(ur === "ok" && !ud.scene.objects.some((o) => o.id === 2), "ungroup 删掉组对象本身");
  check([1, 3, 4, 5].every((id) => Math.hypot(wu0.get(id)[0] - wu1.get(id)[0], wu0.get(id)[1] - wu1.get(id)[1]) < 1e-3), "★ 引擎 parseScene 对照：取消成组前后所有层世界位置不变（子层补偿了组的变换；写回按 6 位有效数字，容差 1e-3）");
  check(json(ud.scene.objects.map((o) => o.id)) === json([1, 3, 4, 5]) && ud.scene.objects.every((o) => o.parent === undefined), "子层按原顺序顶到组的位置（数组顺序即绘制顺序），父级清空");
  const ue = mkScene(ungroupObjs);
  const ueBefore = JSON.stringify(ue.scene.objects);
  check(docMod.ungroup(ue, 1) === "noop" && docMod.ungroup(ue, 404) === "missing" && JSON.stringify(ue.scene.objects) === ueBefore, "没有子层的层 / 不存在的 id：noop / missing，文档原样");
  const uan = ungroupObjs();
  uan[1].origin = { value: "50 20 0", animation: { c0: [], options: { fps: 30, length: 90, mode: "loop" } } };
  const ua = mkScene(uan);
  const uaBefore = JSON.stringify(ua.scene.objects);
  check(docMod.ungroup(ua, 2) === "animated" && JSON.stringify(ua.scene.objects) === uaBefore, "组自身带变换动画时拒绝取消成组（静态化会丢动画），文档原样");
  const ub = mkScene(ungroupObjs);
  const ubBefore = JSON.stringify(ub.scene.objects);
  const ubAll = docMod.ungroupAll(ub, [1, 2]);
  check(
    ubAll.ok === true && json(ubAll.ids) === json([2]) && json(ub.scene.objects.map((o) => o.id)) === json([1, 3, 4, 5]),
    json(ubAll),
  );
  const uanAll = ungroupObjs();
  uanAll[1].origin = { value: "50 20 0", animation: { c0: [], options: { fps: 30, length: 90, mode: "loop" } } };
  const ub2 = mkScene(uanAll);
  const ub2Before = JSON.stringify(ub2.scene.objects);
  const ub2All = docMod.ungroupAll(ub2, [2, 1]);
  check(ub2All.ok === false && ub2All.reason === "animated" && ub2All.at === 2 && JSON.stringify(ub2.scene.objects) === ub2Before, "★ 批量取消成组：任一层拆不了就整批不动（先把非组层 1 过滤掉，再撞上动画组 2）");

  // 接线：命令行 / 工具条 / 树行按钮
  check(/app\?\.commands\.handleKey\(e\)/.test(mainSrcText) && /\(e\.metaKey \|\| e\.ctrlKey\) && e\.key\.toLowerCase\(\) === "a"\) \{\s*e\.preventDefault\(\);\s*selectAllLayers\(\);/.test(mainSrcText) && /function selectAllLayers\(\)/.test(mainSrcText) && /selectMany\(ids\[0\], ids\.slice\(1\)\)/.test(mainSrcText), "⌘/Ctrl+A 全选：走 selectMany（主选 + 追加选区），命令服务没接住才轮到内建链");
  check(/function selectAllLayers\(\)[\s\S]{0,600}?!isLocked\(n\.id\)/.test(mainSrcText), "全选跳过锁定层（锁定层不能拖动 / 变换，进选区只会造成误操作）");
  check(/if \(marquee \|\| !editor \|\| !doc \|\| doc\.type !== "scene" \|\| e\.button !== 0 \|\| e\.altKey\) return;/.test(mainSrcText) && /if \(handleAt\(gizmo, p\.x, p\.y\) \|\| overSelected\(p\.x, p\.y\)\) return;/.test(mainSrcText) && /if \(editor\.hitTestAt\(p\.x, p\.y\)\.some\(/.test(mainSrcText) && /!isLocked\(h\.id\)\)\) return;/.test(mainSrcText), "框选只在空画布起拖：手柄 / 已选层交给拖拽，点在别的层上是点选");
  check(/stageEl\.addEventListener\("pointerdown", \(e\) => \{\s*if \(marquee/.test(mainSrcText) && /const m = marquee;\s*marquee = null;\s*if \(!m\.moved\) return;\s*suppressClick = true;/.test(mainSrcText) && /marqueeHits\(marqueeLayers, r\)/.test(mainSrcText) && /marqueeSelect\(/.test(mainSrcText), "松手才结算：没超过阈值当点击（不吞掉点选），结算走 marqueeHits + marqueeSelect");
  check(/if \(marquee\) drawMarquee\(\);/.test(mainSrcText) && /overlayCtx\.setTransform\(dpr, 0, 0, dpr, \(cr\.left - sr\.left\) \* dpr, \(cr\.top - sr\.top\) \* dpr\);\s*if \(marquee\) drawMarquee\(\);/.test(mainSrcText), "框选矩形画在选中框叠加层上（与手柄同一套坐标变换）");
  check(/id="ly-ungroup"/.test(htmlSrc) && /lyUngroupEl\.onclick = \(\) => ungroupSelected\(\);/.test(mainSrcText) && /lyUngroupEl\.disabled = off \|\| !ungroupable\(\);/.test(mainSrcText) && /function ungroupable\(\)/.test(mainSrcText), "工具条「取消成组」：没有可拆的组时禁用");
  check(/ungroupAll\(d, ids\)/.test(mainSrcText) && /PLACE_BAD\[b\.reason\]/.test(mainSrcText), "取消成组走 ungroupAll，失败按 PlaceResult 提示（与拖放 / 成组同一套文案）");
}

section("TREE-2. 树搜索 / 过滤 / 隔离 / 折叠全部（C2）");
{
  const T = treeQueryMod;
  const entries = [
    { id: 1, parent: null, name: "背景" },
    { id: 2, parent: 1, name: "Cloud A" },
    { id: 3, parent: 2, name: "cloud B" },
    { id: 4, parent: null, name: "前景" },
    { id: 5, parent: 4, name: "叶子" },
  ];
  check(T.treePattern("  CL  ") === "cl" && T.treePattern("   ") === "", "搜索串归一：去空白 + 转小写；空串 = 不过滤");
  check(T.treeMatches(entries[1], "cloud") && !T.treeMatches(entries[0], "cloud") && T.treeMatches(entries[2], "3") && !T.treeMatches(entries[0], ""), "命中判定：层名或 id 包含搜索串（大小写不敏感），空串不命中任何层");
  const hit = T.treeSearchHits(entries, "cloud");
  check(json([...hit].sort()) === json(["2", "3"]), "搜索命中集：名字里带 cloud 的两层");
  const sv = T.treeVisible(entries, hit);
  check(json([...sv.visible].sort()) === json(["1", "2", "3"]) && json([...sv.matched].sort()) === json(["2", "3"]), "★ 过滤视图：命中层 + 其全部祖先可见（否则命中的后代会被折叠的祖先挡掉），祖先不算命中态");
  check(json([...T.treeSubtree(entries, [2]).keys()].sort()) === json(["2", "3"]) && json([...T.treeSubtree(entries, [4, 5]).keys()].sort()) === json(["4", "5"]), "子树闭包：含自身与全部后代");
  const iv = T.treeIsolateView(entries, [2]);
  check(json([...iv.visible].sort()) === json(["1", "2", "3"]) && !iv.visible.has("4") && !iv.visible.has("5"), "★ 隔离视图：只留目标层、它的子树与祖先，兄弟分支整体消失");
  check(json([...T.treeExpanded(new Set([1, 2, 4]), entries, 3)].map(String).sort()) === json(["4"]), "treeExpanded 展开某个 id 的祖先链（隔离时选中层要能看见）");

  check(/id="ed-tree-search"/.test(htmlSrc) && /id="ed-filter"/.test(htmlSrc) && /data-i18n-ph="ph\.treeFilter"/.test(htmlSrc) && /filterEl\.addEventListener\("input", \(\) => setTreeQuery\(filterEl\.value\)\)/.test(mainSrcText) && /function setTreeQuery\(q: string\)/.test(mainSrcText), "树搜索框接线：输入即过滤（不动文档与选中）");
  check(/id="ed-filter-clear"/.test(htmlSrc) && /filterClearEl\.hidden = !q;/.test(mainSrcText) && /filterClearEl\.onclick = \(\) => \{/.test(mainSrcText) && /if \(e\.key !== "Escape"\) return;/.test(mainSrcText), "清空按钮：有搜索串才显示，点 ✕ 或按 Esc 都能清空");
  check(/id="tree-collapse"/.test(htmlSrc) && /id="tree-expand"/.test(htmlSrc) && /data-tools="layers"/.test(htmlSrc) && /treeCollapseEl\.onclick = \(\) => setAllCollapsed\(true\);/.test(mainSrcText) && /treeExpandEl\.onclick = \(\) => setAllCollapsed\(false\);/.test(mainSrcText) && /function setAllCollapsed\(all: boolean\)/.test(mainSrcText), "展开 / 折叠全部：整棵树一次性处理，按钮挂在图层面板自己的工具条上");
  check(/id="tree-isolate"/.test(htmlSrc) && /treeIsolateEl\.onclick = \(\) => toggleIsolate\(\);/.test(mainSrcText) && /function toggleIsolate\(\)/.test(mainSrcText) && /treeIsolateEl\.classList\.toggle\("is-on", isolateIds\.size > 0\)/.test(mainSrcText), "图层 isolate：按钮有开关态，再点一次恢复");
  check(/const isolateIds = new Set<string>\(\);/.test(mainSrcText) && /if \(isolateIds\.size\) \{\s*const v = treeIsolateView\(entries, \[\.\.\.isolateIds\]\);/.test(mainSrcText) && /syncPanelTools\(\$\("#ed-layers"\), panelTabs\.left\.current\(\)\);/.test(mainSrcText), "隔离状态是页面级视图状态（不进文档）；面板工具条补一次初始同步，避免错档显示");
  check(/if \(!view\.visible\.size && view\.filtering\) \{\s*treeEl\.appendChild\(note\(et\("tree\.searchNone"\)\)\);/.test(mainSrcText) && /et\("tree\.count", \{ n: view\.visible\.size, total: doc\.objectCount \}\)/.test(mainSrcText) && /if \(match\) row\.classList\.add\("match"\);/.test(mainSrcText), "计数改成「可见 / 总数」，无匹配时给提示，命中行加 .match 高亮");
  check(/\(view\.filtering \|\| !collapsed\.has\(n\.id\)\)/.test(mainSrcText) && /\.ed-node\.match \.ed-node-name \{/.test(cssSrc), "过滤中忽略折叠状态（否则命中项看不见）；命中高亮有配套样式");
  check(/function renderTree\(\) \{\s*syncLayerTools\(\);/.test(mainSrcText) && /if \(!doc\) \{\s*treeEl\.appendChild\(note\(et\("layers\.none"\)\)\);/.test(mainSrcText), "树渲染原有分支（无文档 / 非场景）保持不动");
}

section("LOCK-2. 锁定切换入撤销栈（A9）");
{
  check(/function setLockedEdit\(node: LayerNode, on: boolean\)/.test(mainSrcText) && /const verb = et\(on \? "log\.locked" : "log\.unlocked", \{ name: nodeName\(node\.id\) \}\);/.test(mainSrcText), "锁定切换先取好文案（锁定 / 解锁），再走编辑原语");
  check(/if \(isLockedObj\(o\) === on\) return false;\s*setLocked\(o, on\);\s*return true;/.test(mainSrcText), "★ mutate 幂等：期望值在点击时固定，撤销 / 重做带着快照重跑也不会翻回去");
  check(/objEdit\(verb, node\.id, \(o\) => \{/.test(mainSrcText) && /setLockedEdit\(n, !isLocked\(n\.id\)\);/.test(mainSrcText), "改用 objEdit：锁定进撤销栈（历史上唯一的直接改文档写操作补齐）");
  check(/isLockedObj\(o\) === on/.test(mainSrcText) && !/setLocked\(n\.obj, !isLocked\(n\.id\)\);\s*markDirty\(\);/.test(mainSrcText), "树行锁定按钮不再绕开 history 直接写文档");
  check(/objEdit\(verb, node\.id/.test(mainSrcText) && /log\.locked/.test(i18nSrc) && /log\.unlocked/.test(i18nSrc), "锁定 / 解锁都有日志文案（zh + en）");
}

section("CLIPBOARD. 图层剪贴板序列化 / 跨文档粘贴（A10）");
{
  const C = clipboardMod;
  const mkScene = (objects, type = "scene") =>
    docMod.makeDoc("t", null, { general: {}, objects: typeof objects === "function" ? objects() : objects }, type);
  const srcObjs = () => [
    { id: 1, text: "a", origin: "0 0 0" },
    { id: 2, text: "g", origin: "50 20 0", scale: "2 2 1" },
    { id: 3, text: "b", parent: 2, origin: "10 5 0" },
    { id: 4, text: "c", parent: 3, origin: "1 1 0" },
    { id: 5, text: "d", origin: "700 500 0" },
  ];
  const clip = C.serializeLayerClip(srcObjs(), [2]);
  check(clip && clip.format === C.LAYER_CLIP_FORMAT && clip.version === C.LAYER_CLIP_VERSION && clip.objs.length === 3, "序列化：选中组 → 含自身与整棵子树（3 条）");
  check(json(clip.objs.map((e) => e.id)) === json(["2", "3", "4"]) && clip.objs[0].parent === null && clip.objs[1].parent === "2" && clip.objs[2].parent === "3", "载荷里父子关系按 id 字符串保留，顶层父级记 null");
  check(C.serializeLayerClip(srcObjs(), []) === null && C.serializeLayerClip(srcObjs(), [999]) === null, "没有可复制对象时返回 null（不产生空载荷）");
  const round = C.parseLayerClip(JSON.parse(C.stringifyLayerClip(clip)));
  check(round && round.objs.length === 3 && C.parseLayerClip("not json") === null && C.parseLayerClip({ format: "other" }) === null && C.parseLayerClip(null) === null, "★ 往返解析：JSON 字符串能还原；脏数据 / 别的格式一律 null（localStorage 里的旧载荷不会写坏文档）");
  check(C.parseLayerClip({ format: C.LAYER_CLIP_FORMAT, version: 99, objs: [] }) === null && C.parseLayerClip({ format: C.LAYER_CLIP_FORMAT, version: 1, objs: [{ id: "x", parent: null }] }) === null, "格式对但版本不对、条目缺字段：一律丢弃");

  // 跨文档粘贴：目标文档 id 与来源相同，粘贴后必须全部重编号且不冲突
  const destObjs = () => [
    { id: 1, text: "x", origin: "0 0 0" },
    { id: 2, text: "y", origin: "10 10 0" },
    { id: 7, text: "z", origin: "20 20 0" },
  ];
  const dest = mkScene(destObjs);
  const added = C.pasteLayerClip(dest, clip, [0, 0]);
  const byId = (o, id) => o.find((x) => String(x.id) === String(id));
  const destAfter = dest.scene.objects;
  check(json(added) === json([8, 9, 10]) && json(destAfter.map((o) => o.id)) === json([1, 2, 7, 8, 9, 10]), "★ 粘贴重新分配 id：从目标文档现有最大 id + 1 起（7 → 8,9,10），不与已有对象冲突");
  check(byId(destAfter, 9).parent === 8 && byId(destAfter, 10).parent === 9 && byId(destAfter, 8).parent === undefined, "★ 父子关系按重编号后的新 id 接上，顶层不写 parent");
  const destW = new Map(
    parseMod
      .parseScene({ general: {}, objects: structuredClone(destAfter) }, { type: "scene" })
      .layers.map((l) => [l.id, [l.origin[0], l.origin[1]]]),
  );
  check(byId(destAfter, 8).scale === "2 2 1" && byId(destAfter, 9).origin === "10 5 0" && byId(destAfter, 10).origin === "1 1 0", "粘贴保留各自的局部变换（相对新父级仍是原值），整棵子树相对关系不变");
  check(destW.has(8) && destW.has(9) && destW.has(10), "★ 引擎 parseScene 能接住粘贴结果（重编号后仍是一棵合法树）");
  const dest3 = mkScene(destObjs);
  const added3 = C.pasteLayerClip(dest3, clip, [16, -16]);
  check(json(added3) === json([8, 9, 10]) && dest3.scene.objects.length === 6, "带偏移粘贴：id 分配与不带偏移一致");
  // 真机回归（AL 段实测发现）：库内工程 origin 是字符串，旧实现只认数组 ⇒ 偏移静默失效，
  // 粘贴出来的一层和源层完全重合。这里把两种形态 + 两种包装都钉成判据。
  const originOfObj = (o, id) => byId(o, id).origin;
  check(
    originOfObj(dest3.scene.objects, 8) === "66 4 0" && originOfObj(dest3.scene.objects, 9) === "26 -11 0" && originOfObj(dest3.scene.objects, 10) === "17 -15 0",
    "★ 偏移真的写进字符串 origin：\"50 20 0\" → \"66 4 0\"（子树各自偏移，第三分量与书写位数原样保留）",
  );
  const arrClip = C.parseLayerClip({ format: C.LAYER_CLIP_FORMAT, version: 1, objs: [{ id: "1", parent: null, obj: { text: "arr", origin: [10, 20, 0] } }] });
  const destArr = mkScene([{ id: 1, text: "base", origin: "0 0 0" }]);
  C.pasteLayerClip(destArr, arrClip, [16, -16]);
  check(json(originOfObj(destArr.scene.objects, 2)) === json([26, 4, 0]), "编辑器自建层的数组 origin 照偏移写回（保持数组形态，不被字符串化）");
  const animObj = { text: "anim", origin: { value: "10 20 0", animation: { "0": "10 20 0", "30": "30 20 0" } } };
  const animClip = C.parseLayerClip({ format: C.LAYER_CLIP_FORMAT, version: 1, objs: [{ id: "1", parent: null, obj: animObj }] });
  const destAnim = mkScene([{ id: 1, text: "base", origin: "0 0 0" }]);
  C.pasteLayerClip(destAnim, animClip, [16, -16]);
  check(json(originOfObj(destAnim.scene.objects, 2)) === json(animObj.origin), "★ 带 animation 的 origin 一律不动（关键帧仍指向旧坐标：宁可重合，也不静默错位或吞掉关键帧）");
  const userClip = C.parseLayerClip({ format: C.LAYER_CLIP_FORMAT, version: 1, objs: [{ id: "1", parent: null, obj: { text: "u", origin: { user: "u_x", value: "5 5 0" } } }] });
  const destUser = mkScene([{ id: 1, text: "base", origin: "0 0 0" }]);
  C.pasteLayerClip(destUser, userClip, [16, -16]);
  check(originOfObj(destUser.scene.objects, 2).user === "u_x" && originOfObj(destUser.scene.objects, 2).value === "21 -11 0", "★ {user, value} 包装：只动 .value，绑定键原样保留");
  const zeroClip = C.parseLayerClip({ format: C.LAYER_CLIP_FORMAT, version: 1, objs: [{ id: "1", parent: null, obj: { text: "z", origin: "0.000 0.000 0.000" } }] });
  const destZero = mkScene([{ id: 1, text: "base", origin: "0 0 0" }]);
  C.pasteLayerClip(destZero, zeroClip, [16, -16]);
  check(originOfObj(destZero.scene.objects, 2) === "16.000 -16.000 0.000", "小数位按原写法重排（\"0.000\" 风格不被压成 \"16 -16 0\"）");
  const dest4 = mkScene(destObjs);
  const before4 = JSON.stringify(dest4.scene.objects);
  const badParent = C.parseLayerClip({ format: C.LAYER_CLIP_FORMAT, version: 1, objs: [{ id: "1", parent: "404", obj: { text: "p" } }] });
  check(json(C.pasteLayerClip(dest4, badParent, [0, 0])) === json([]) && JSON.stringify(dest4.scene.objects) === before4, "★ 父级在目标和载荷里都不存在：整条不粘，文档原样不动");
  const dup = C.parseLayerClip({
    format: C.LAYER_CLIP_FORMAT,
    version: 1,
    objs: [
      { id: "1", parent: null, obj: { text: "p" } },
      { id: "1", parent: null, obj: { text: "q" } },
    ],
  });
  const dest5 = mkScene(destObjs);
  const before5 = JSON.stringify(dest5.scene.objects);
  check(json(C.pasteLayerClip(dest5, dup, [0, 0])) === json([]) && JSON.stringify(dest5.scene.objects) === before5, "载荷内 id 自身重复：拒绝，文档原样");
  const collide = C.parseLayerClip({ format: C.LAYER_CLIP_FORMAT, version: 1, objs: [{ id: "1", parent: null, obj: { text: "p" } }] });
  const dest6 = mkScene(destObjs);
  const added6 = C.pasteLayerClip(dest6, collide, [0, 0]);
  check(json(added6) === json([8]) && dest6.scene.objects.length === 4 && byId(dest6.scene.objects, 1).text === "x", "载荷 id 与目标文档已有 id 同名：不是错误（id 是文档局部的），照常重新编号");
  const empty = C.parseLayerClip({ format: C.LAYER_CLIP_FORMAT, version: 1, objs: [{}] });
  check(empty === null, "条目缺 obj / id 字段：解析就丢掉");
  const noScene = docMod.makeDoc("v", { type: "video" }, null, "video");
  check(noScene.type === "video" && json(C.pasteLayerClip(noScene, clip, [0, 0])) === json([]), "目标不是场景文档：不粘");

  check(/import \{ load, save \} from "\.\.\/shared\/workbench\/storage";/.test(mainSrcText) && /save\(LAYER_CLIP_KEY, stringifyLayerClip\(clip\)\)/.test(mainSrcText) && /const raw = load\(LAYER_CLIP_KEY\);/.test(mainSrcText), "剪贴板：内存优先 + localStorage 兜底（跨标签页 / 刷新后仍能粘贴）");
  check(/function readClipboard\(\): LayerClip \| null \{\s*if \(layerClip\) return layerClip;/.test(mainSrcText) && /layerClip = raw \? parseLayerClip\(raw\) : null;/.test(mainSrcText), "读：先内存，miss 才读 localStorage，且一律过 parseLayerClip 校验");
  check(/\(e\.metaKey \|\| e\.ctrlKey\) && e\.key\.toLowerCase\(\) === "c"\) \{\s*if \(!copySelected\(\)\) return;/.test(mainSrcText) && /\(e\.metaKey \|\| e\.ctrlKey\) && e\.key\.toLowerCase\(\) === "x"\) \{\s*if \(!cutSelected\(\)\) return;/.test(mainSrcText) && /\(e\.metaKey \|\| e\.ctrlKey\) && e\.key\.toLowerCase\(\) === "v"\) \{\s*if \(!pasteClipboard\(\)\) return;/.test(mainSrcText), "⌘/Ctrl+C / X / V 接内建链（命令服务没接住才轮到，与关键帧剪贴板按钮不冲突）");
  check(/function copySelected\(\): boolean \{[\s\S]{0,900}?serializeLayerClip\(/.test(mainSrcText) && /function cutSelected\(\): boolean \{\s*if \(!copySelected\(\)\) return false;\s*const n = selectionNodes\(\)\.length;\s*deleteSelected\(\);/.test(mainSrcText), "复制走序列化；剪切 = 复制 + deleteSelected（删除自己进撤销栈）");
  check(/structEdit\(et\("log\.layerPasted", \{ n: clip\.objs\.length \}\), \(d\) => \{[\s\S]{0,300}?pasteLayerClip\(d, clip, \[PASTE_OFFSET, -PASTE_OFFSET\]\)/.test(mainSrcText) && /selectMany\(added\[0\], added\.slice\(1\)\);/.test(mainSrcText), "粘贴走 structEdit（一步撤销），粘完选中新层（全部进追加选区）");
  check(/const PASTE_OFFSET = 16;/.test(mainSrcText) && /function clipboardSource\(\)/.test(mainSrcText), "粘贴偏移常量 + 复制来源校验（必须是有编辑器的场景文档）");
}

// ───────────────────────────────────────────────────────────────────────────
// SCENE-SET. 场景设置（计划 A4 / M3）：scene.json 的 general 段读写与记账
// 真浏览器侧另有 AK 段「改 camerashake → 出帧变化」，见 scripts/verify-editor-headless.mjs。
// ───────────────────────────────────────────────────────────────────────────
section("SCENE-SET. 场景设置面板（general 读写 / 保留未知键与非默认值 / 撤销记账）");
{
  const scn = await loadEditorModule("scene-settings");
  /**
   * 一份贴近真工程的 general：既有非默认值，也有必须原样留着的未知键
   * （norecompile 这种别的工具写进去的）和脚本 / 动画包装。
   */
  const scnScene = () => ({
    general: {
      ambientcolor: "0.30000 0.30000 0.30000",
      bloom: false,
      bloomhdriterations: 8,
      camerapreview: true,
      camerashake: false,
      clearcolor: "0.70000 0.70000 0.70000",
      norecompile: true,
      orthogonalprojection: { width: 343, height: 193 },
      zoom: { script: "return 3;", scriptproperties: null, value: 1 },
      bloomstrength: { animation: { options: { fps: 30 } }, value: 2 },
    },
    objects: [],
  });
  const scnField = (k) => scn.sceneField(k);
  const scnRow = (scene, k) => scn.sceneRows(scene).find((r) => r.field.key === k);

  // ---- 字段表：计划 §1.3 点名的键都要能编，且不越界碰别的键 ----
  const scnPlan = ["ambientcolor", "clearcolor", "skylightcolor", "clearenabled", "camerafade",
    "cameraparallax", "cameraparallaxamount", "cameraparallaxdelay", "cameraparallaxmouseinfluence",
    "camerashake", "camerashakeamplitude", "camerashakeroughness", "camerashakespeed",
    "zoom", "fov", "nearz", "farz", "perspectiveoverridefov",
    "bloom", "bloomstrength", "bloomthreshold", "bloomtint", "hdr",
    "bloomhdrstrength", "bloomhdrthreshold", "bloomhdriterations", "bloomhdrscatter", "bloomhdrfeather"];
  const scnTable = new Set(scn.SCENE_FIELDS.map((f) => f.key));
  const scnLack = scnPlan.filter((k) => !scnTable.has(k));
  check(scnLack.length === 0, `计划 §1.3 点名的 general 键都在字段表里（缺 ${json(scnLack)}）`);
  check(!scnTable.has("orthogonalprojection") && !scnTable.has("norecompile"), "字段表不含 orthogonalprojection / norecompile：面板不碰分辨率与别的工具写的键");
  check(scn.SCENE_FIELDS.filter((f) => f.group === "parallax").length === 4 && scn.SCENE_GROUPS.length === 5, "鼠标视差单独成组（开关 + 幅度 / 延迟 / 鼠标影响），共 5 组");
  check(scn.SCENE_FIELDS.every((f) => scnField(f.key) === f) && scn.SCENE_FIELDS.every((f) => f.group && "def" in f), "字段表按键可取回，每条都带分组与默认值（面板显示「未设置」用）");

  // ---- 输入解析 / 回显：WE 的 general 写法（颜色是空格分隔的 3 分量小数）----
  check(scn.parseSceneValue(scnField("clearcolor"), "0.1 0.2 0.3") === "0.10000 0.20000 0.30000", "颜色输入 → WE 写法（空格分隔、五位小数）");
  check(scn.parseSceneValue(scnField("clearcolor"), "0.1,0.2,0.3") === "0.10000 0.20000 0.30000", "颜色也认逗号分隔（作者手抄来的写法）");
  check(scn.parseSceneValue(scnField("clearcolor"), "0.1 0.2") === null && scn.parseSceneValue(scnField("clearcolor"), "a b c") === null, "颜色分量数不对 / 非数字 → 不提交");
  check(scn.parseSceneValue(scnField("fov"), "50") === 50 && scn.parseSceneValue(scnField("fov"), "") === null && scn.parseSceneValue(scnField("fov"), "abc") === null, "数值：认数字，空串与非数字不提交");
  check(scn.parseSceneValue(scnField("bloomhdriterations"), "8.4") === 8, "整数族四舍五入（迭代次数不能是小数）");
  check(scn.parseSceneValue(scnField("fov"), "0") === null && scn.parseSceneValue(scnField("camerashakeroughness"), "5") === null, "越界（低于下限 / 高于上限）不提交：不写出引擎夹不回来的值");
  check(scn.formatSceneValue(scnField("clearcolor"), "0.7 0.7 0.7") === "0.70000 0.70000 0.70000", "颜色回显统一成 WE 写法");
  check(scn.formatSceneValue(scnField("camerashake"), true) === "true" && scn.formatSceneValue(scnField("zoom"), 2) === "2", "回显：布尔与数值按作者看得懂的形式打印");

  // ---- 读写模型：只动点名那一个键 ----
  const scnA = scnScene();
  const scnG = docMod.sceneGeneral(scnA);
  const scnKeys0 = Object.keys(scnG).sort();
  docMod.writeGeneralField(scnG, "fov", 60);
  docMod.writeGeneralField(scnG, "clearcolor", scn.parseSceneValue(scnField("clearcolor"), "0.1 0.2 0.3"));
  check(docMod.readGeneralField(scnG, "fov") === 60 && scnG.clearcolor === "0.10000 0.20000 0.30000", "general 写入后读回一致（fov 60 / clearcolor 新值）");
  check(scnG.norecompile === true && scnG.camerapreview === true, "写入只动点名那一个键：未知键 norecompile / camerapreview 原样留着");
  check(scnG.bloom === false && scnG.bloomhdriterations === 8 && scnG.ambientcolor === "0.30000 0.30000 0.30000", "别的既有非默认值不被顺手清掉");
  check(json(Object.keys(scnG).sort()) === json([...scnKeys0, "fov"].sort()), "键集合只多出被写的那一个（没有重建 general）");
  docMod.writeGeneralField(scnG, "zoom", 2);
  check(scnG.zoom.script === "return 3;" && scnG.zoom.scriptproperties === null && scnG.zoom.value === 2, "脚本包装只改 .value：script / scriptproperties 原样留着");
  check(docMod.readGeneralField(scnG, "zoom") === 2, "读包装字段拿到的是作者当初设的值（.value），不是整个盒子");
  docMod.writeGeneralField(scnG, "bloomstrength", 5);
  check(scnG.bloomstrength.animation.options.fps === 30 && scnG.bloomstrength.value === 5, "动画包装同样只改 .value：animation 原样留着");
  check(json(scnG.orthogonalprojection) === json({ width: 343, height: 193 }), "orthogonalprojection 一字不动（分辨率不归这个面板管）");
  const scn3d = { general: { orthogonalprojection: null, fov: 50 }, objects: [] };
  docMod.writeGeneralField(docMod.sceneGeneral(scn3d), "fov", 60);
  check(scn3d.general.orthogonalprojection === null && "orthogonalprojection" in scn3d.general, "3D 透视场景的 orthogonalprojection:null 不被补成空对象（补了会被当正交 → 全黑）");

  // ---- 面板读视图 ----
  check(scnRow(scnA, "zoom").present === true && scnRow(scnA, "zoom").wrapped === true && scnRow(scnA, "zoom").value === 2, "面板看到包装字段：已设 + 标出「脚本 / 动画」");
  check(scnRow(scnA, "skylightcolor").present === false && scnRow(scnA, "skylightcolor").value === undefined, "文档里没有的键不会被面板补出来（present=false）");
  check(scn.sceneRows({ general: {} }).length === scn.SCENE_FIELDS.length, "面板行数 = 字段表条数（缺省文档也有完整面板）");

  // ---- 快照 / 还原：撤销栈里存的是整段 general ----
  const scnSnapA = docMod.generalSnapshot(scnA);
  const scnFresh = { general: { fov: 1 }, objects: [] };
  docMod.restoreGeneral(scnFresh, scnSnapA);
  check(json(scnFresh.general) === json(scnA.general), "generalSnapshot / restoreGeneral 整段往返一致（含未知键与包装）");
  const scnNoGen = { objects: [] };
  check(docMod.generalSnapshot(scnNoGen) === "null" && Object.keys(docMod.sceneGeneral(scnNoGen)).length === 0, "本来就没有 general 的文档：快照记 null、读视图给空对象");
  docMod.restoreGeneral(scnNoGen, "null");
  check(!("general" in scnNoGen), "撤销回「本来就没有 general」时不留下空壳");
  check(Object.keys(docMod.sceneGeneral(null)).length === 0 && docMod.generalSnapshot(null) === "null", "没有文档（null）时读路径不抛错");
  const scnMade = {};
  const scnMadeG = docMod.ensureSceneGeneral(scnMade);
  scnMadeG.fov = 50;
  check(scnMade.general && scnMade.general.fov === 50, "ensureSceneGeneral 在没有 general 时建一个并返回可写对象");

  // ---- 记账：一次编辑一笔 SceneCmd，撤销 / 重做整段换回 ----
  const scnHist = new historyMod.EditHistory();
  const scnBefore = docMod.generalSnapshot(scnA);
  docMod.writeGeneralField(docMod.sceneGeneral(scnA), "camerashake", true);
  docMod.writeGeneralField(docMod.sceneGeneral(scnA), "camerashakeamplitude", 3);
  const scnAfter = docMod.generalSnapshot(scnA);
  scnHist.push({ kind: "scene", label: "场景设置：相机抖动 = true", before: scnBefore, after: scnAfter });
  const scnCmd = scnHist.take("undo");
  check(!!scnCmd && historyMod.isSceneCmd(scnCmd) && !historyMod.isStruct(scnCmd) && !historyMod.isTitleCmd(scnCmd) && !historyMod.isBatch(scnCmd), "场景设置是独立的一种命令（isSceneCmd 真，不会误走结构 / 改名 / 批量分支）");
  docMod.restoreGeneral(scnA, scnCmd.before);
  check(scnA.general.camerashake === false && scnA.general.camerashakeamplitude === undefined, "撤销回到改前的 general（这次新加的键一起收回）");
  docMod.restoreGeneral(scnA, scnCmd.after);
  check(scnA.general.camerashake === true && scnA.general.camerashakeamplitude === 3, "重做把整段 general 换回来");
  check(scnHist.undoStack.length === 0 && scnHist.redoStack.length === 1, "取出的命令进另一侧栈（undo 后还能 redo）");
  check(docMod.generalSnapshot(scnA) === scnAfter, "重做后文档快照与入栈时的 after 逐字节一致");

  // ---- 页面接线：面板本体、菜单、撤销方向、切语言 ----
  const scnMain = fs.readFileSync(path.join(ROOT, "editor/main.ts"), "utf8");
  const scnHtml = fs.readFileSync(path.join(ROOT, "editor/index.html"), "utf8");
  check(/import \{ mountSceneSettings \} from "\.\/scene-settings";/.test(scnMain), "外接面板与单测是同一份代码（页面 import 的就是 scene-settings.ts）");
  check(/id="tb-scene-opts"/.test(scnHtml) && /id="scene-menu-body"/.test(scnHtml), "视口工具条有「场景设置」按钮，弹出层有装面板的容器");
  check(/id="render-menu" class="ed-menu ed-render-menu"/.test(scnHtml) && /id="scene-menu" class="ed-menu ed-render-menu" role="dialog" hidden/.test(scnHtml), "两个菜单并存且样式一致：全局「渲染选项」与「场景设置」分开两份，都默认收起");
  check(/function sceneEdit\(label: string, key: string, value: unknown\): boolean \{[\s\S]{0,600}edits\.push\(\{ kind: "scene", label, before, after \}\)[\s\S]{0,300}docDriven = true;[\s\S]{0,200}markDirty\(\);[\s\S]{0,200}void mountCurrent\(true\);/.test(scnMain), "改一次场景设置：一笔撤销栈 + 置 docDriven 后整场景重挂（引擎才拿到新 general）");
  check(/if \(after === before\) return false;/.test(scnMain), "值没变（点一下没动 / 改回原值）不入栈");
  check(/if \(isSceneCmd\(cmd\)\) \{\s*log\(et\(dir === "undo" \? "log\.undo" : "log\.redo", \{ name: cmd\.label \}\)\);\s*applySceneSnap\(dir === "undo" \? cmd\.before : cmd\.after\);/.test(scnMain), "撤销 / 重做按键方向换回 general 快照");
  check(/edit: sceneEdit,/.test(scnMain) && /onChangeLang\(\(\) => sceneSettings\.refresh\(\)\);/.test(scnMain), "面板接进页面：编辑走 sceneEdit，切语言后重画");
  check(/closeExportMenu\(\);\s*closeRenderMenu\(\);\s*sceneSettings\.refresh\(\);/.test(scnMain), "开场景设置时收起别的菜单，并重画成当前文档的样子");

  // ---- i18n：中英文各一条（bench 切语言后同一份面板）----
  const scnI18n = fs.readFileSync(path.join(ROOT, "editor/i18n.ts"), "utf8");
  const scnKeys = ["scn.title", "scn.opts", "scn.optsTip", "scn.hint", "scn.keep", "scn.noDoc", "scn.def", "scn.set", "scn.wrapped", "log.sceneSet", "log.sceneBad", "log.sceneNoDoc",
    ...scn.SCENE_GROUPS.map((g) => `scn.sec.${g}`), ...scn.SCENE_FIELDS.map((f) => `scn.f.${f.key}`)];
  const scnMiss = scnKeys.filter((k) => (scnI18n.match(new RegExp(`"${k.replace(/\./g, "\\.")}":`, "g")) ?? []).length !== 2);
  check(scnMiss.length === 0, `场景设置文案中英文各一条（缺 / 重 ${json(scnMiss)}）`);
  check(/"scn\.title": "场景设置"/.test(scnI18n) && /"scn\.title": "Scene settings"/.test(scnI18n), "中英文都真翻译了（不是同一串占位）");
  check(/"scn\.hint": "[^"]*scene\.json/.test(scnI18n), "面板自带说明：这些参数写进工程的 scene.json（与全局渲染选项分清）");
  check(/id="scene-menu"[\s\S]{0,700}data-et="scn\.hint"/.test(scnHtml), "说明就在面板里（用户不必去看文档才知道写到哪）");

  // ---- 变异红测：把保键 / 拆包装的底线各破一次，上面的判据必须变红 ----
  const scnDocPath = path.join(ROOT, "editor/doc.ts");
  const scnDocSrc = fs.readFileSync(scnDocPath, "utf8");
  const scnMut = async (from, to, tag) => {
    const mut = scnDocSrc.replace(from, to);
    check(mut !== scnDocSrc, `注入点存在（${tag}）`);
    return loadEditorModule("doc", { [scnDocPath]: mut });
  };
  const scnWriteAnchor = "  const raw = general[key];\n  if (isGeneralWrap(raw)) raw.value = value;\n  else general[key] = value;";
  const scnMutDrop = await scnMut(scnWriteAnchor, "  for (const k of Object.keys(general)) delete general[k];\n  general[key] = value;", "写入时重建 general");
  const scnDropG = scnMutDrop.sceneGeneral(scnScene());
  scnMutDrop.writeGeneralField(scnDropG, "fov", 60);
  check(!("norecompile" in scnDropG) && !("orthogonalprojection" in scnDropG) && !("camerapreview" in scnDropG), "写入时重建 general 的话「未知键 / 正交投影 / camerapreview 原样留着」判据变红");
  const scnMutRead = await scnMut("  return isGeneralWrap(raw) ? raw.value : raw;", "  return raw;", "读时不拆脚本 / 动画包装");
  const scnReadG = scnMutRead.sceneGeneral(scnScene());
  check(typeof scnMutRead.readGeneralField(scnReadG, "zoom") === "object", "读 general 不拆包装的话「面板看到作者设的值」判据变红");
  const scnMutClobber = await scnMut("  if (isGeneralWrap(raw)) raw.value = value;\n  else general[key] = value;", "  general[key] = value;", "写入时不认包装");
  const scnClobberG = scnMutClobber.sceneGeneral(scnScene());
  scnMutClobber.writeGeneralField(scnClobberG, "zoom", 2);
  check(scnClobberG.zoom === 2 && typeof scnClobberG.zoom !== "object", "写入盖掉包装的话「脚本 / 动画包装只改 .value」判据变红");
  const scnHeadSrc = fs.readFileSync(path.join(ROOT, "scripts/verify-editor-headless.mjs"), "utf8");
  check(/section\("AK\. 场景设置端到端（改 camerashake → 出帧变化）"\)/.test(scnHeadSrc), "真浏览器侧有「改 camerashake → 出帧变化」用例（--headless 跑）");
}

// FX-LIB. M6（计划 A11）：宿主只读效果库枚举 + 编辑器只写引用 + pass 级 combos
//
// headless 用例（未跑，只注明）：「在一个从未打开过的工程里加库内效果」——
//   打开空工程 → 效果浏览器列出库内目录 → 展开预览（参数 / 贴图槽 / combos 只读）
//   → 点「添加引用」→ 保存 → 重开工程仍是同一条引用、参数面板可调、combos 往返一致，
//   且工程文件夹里**没有** effects/<库目录>/** 任何文件（库内文件仍在库里）。
// ───────────────────────────────────────────────────────────────────────────
section("FX-LIB. 效果库接入 editor/effects.ts + host/wallpaper-host.ts（M6 A11）");
// headless 待补（本沙箱 Chrome 沙箱起不来）：在一个**从未打开过**的工程里点「加库内效果」→
// 真浏览器里核对 scene.json 多出库内引用、参数 / combos 内联、且工程目录里没有多出任何库内文件。
// 离线部分已覆盖同一条链路的纯逻辑与真宿主（见本段「未复制任何库内效果文件」「库内效果目录一字未动」）。
const fxLibMod = await loadEditorModule("effects");
{
  const { createHash } = await import("node:crypto");
  /** 目录内容指纹：断言「库内文件一字未动」（不写回库、不复制） */
  const dirDigest = (root) => {
    const out = [];
    const walk = (rel) => {
      const abs = rel ? path.join(root, rel) : root;
      for (const e of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(r);
        else out.push(`${r}:${createHash("sha1").update(fs.readFileSync(path.join(root, r))).digest("hex")}`);
      }
    };
    walk("");
    return out.join("\n");
  };

  // ---- (1) 目录名 → 效果 id 还原（M6 契约：库内 / 官方目录名还原成目录名）----
  check(
    fxLibMod.effectIdOf("effects/godrays/effect.json") === "godrays" && fxLibMod.effectIdOf("effects/waterripple/effect.json") === "waterripple",
    "库内 / WE 官方目录名 → 目录名本身（不再是 null）",
  );
  check(
    fxLibMod.effectIdOf("effects/wwgl_tint/effect.json") === "tint" && fxLibMod.effectDirNameOf("effects/wwgl_tint/effect.json") === "wwgl_tint",
    "已登记 wwgl_ 前缀目录仍还原成内置 id，且能取回目录名",
  );
  check(
    fxLibMod.effectIdOf("effects/wwgl_nope/effect.json") === null && fxLibMod.effectIdOf("effects/Tint/effect.json") === null && fxLibMod.effectIdOf("effects/tint/effect.json") === "tint",
    "未登记 wwgl_ 前缀 / 大小写不符 → null；库内 tint 就是目录名 tint",
  );
  // 撞名守门：库内 effects/tint 与内置内置 id `tint`（登记目录 wwgl_tint）**不共参数表**
  const collide = { id: 1, effects: [{ file: "effects/tint/effect.json", passes: [{ constantshadervalues: { amount: 0.5 } }] }] };
  check(fxLibMod.effectViews(collide)[0]?.def === null, "库内 effects/tint 认不出内置参数表（目录名必须等于登记目录 wwgl_tint）");
  check(fxLibMod.setEffectParam(collide, 0, "amount", 0.2) === false, "库内 effects/tint 的参数不走内置参数表（不改动、返回 false）");
  check(fxLibMod.effectViews({ effects: [{ file: "effects/wwgl_tint/effect.json", passes: [{}] }] })[0]?.def?.id === "tint", "内置目录 wwgl_tint 才套参数表（撞名守门反向）");

  // ---- (2) 宿主只读枚举端点：夹具库 ----
  // 两个条目共用一个效果目录名（去重）、一个打包条目（不解包）、一个缺材质的、一个坏 json 的
  const fxLib = path.join(tmpRoot, "fxlib");
  const gdRel = "effects/godrays/effect.json";
  const fxWrite = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(fxLib, rel)), { recursive: true });
    fs.writeFileSync(path.join(fxLib, rel), text);
  };
  fxWrite("lib-item-a/project.json", json({ type: "scene", file: "scene.json" }));
  fxWrite("lib-item-a/scene.json", json(fixtureScene()));
  fxWrite(
    "lib-item-a/" + gdRel,
    json({
      version: 1,
      name: "godrays",
      group: "enhance",
      description: "光轴",
      preview: "preview/project.json",
      replacementkey: "godrays",
      fbos: [{ name: "godrays_half" }],
      dependencies: [
        "materials/effects/godrays_downsample.json",
        "materials/effects/godrays_combine.json",
        "shaders/effects/godrays_downsample.frag",
        "shaders/effects/godrays_combine.frag",
      ],
      passes: [
        { material: "materials/effects/godrays_downsample.json", target: "godrays_half" },
        { material: "materials/effects/godrays_combine.json", bind: [{ name: "godrays_half", index: 0 }] },
      ],
    }),
  );
  fxWrite("lib-item-a/materials/effects/godrays_downsample.json", json({ passes: [{ shader: "effects/godrays_downsample", blending: "additive", combos: { PRE: 1 } }] }));
  fxWrite(
    "lib-item-a/materials/effects/godrays_combine.json",
    json({ passes: [{ shader: "effects/godrays_combine", combos: { VERTICAL: 0 }, textures: ["$mediaThumbnail"] }] }),
  );
  fxWrite("lib-item-a/shaders/effects/godrays_downsample.frag", 'uniform float g_FxThreshold; // {"material":"threshold","default":0.5,"range":[0,1]}\n');
  fxWrite("lib-item-a/shaders/effects/godrays_combine.frag", 'uniform float g_FxAmount; // {"material":"amount","default":1,"range":[0,2]}\n');
  // 与内置 id 撞名的库内目录（真机上 razer_vortex / razer_bedroom 就有 effects/tint）
  fxWrite("lib-item-a/effects/tint/effect.json", json({ version: 1, name: "tint", group: "colorize", passes: [{ material: "materials/effects/lib_tint.json" }] }));
  fxWrite("lib-item-a/materials/effects/lib_tint.json", json({ passes: [{ shader: "effects/lib_tint" }] }));
  fxWrite("lib-item-a/shaders/effects/lib_tint.frag", 'uniform float g_FxMix; // {"material":"mix","default":1,"range":[0,1]}\n');
  // 依赖缺失：照旧列出该效果，missing 里点名
  fxWrite("lib-item-a/effects/broken/effect.json", json({ version: 1, passes: [{ material: "materials/effects/nope.json" }] }));
  // 坏 json：不列进效果，只在 errors 里报错
  fxWrite("lib-item-a/effects/junk/effect.json", "{oops");
  // 同名目录的第二个条目（内容不同，去重时只保留第一个）
  fxWrite("lib-item-b/effects/godrays/effect.json", json({ version: 1, name: "godrays-b", passes: [{ material: "materials/effects/godrays_combine.json" }] }));
  // 打包条目：效果在 scene.pkg 里 → 只计数、不解包
  fxWrite("packed-only/project.json", json({ type: "scene", file: "scene.pkg" }));
  fxWrite("packed-only/scene.pkg", "PK\u0003\u0004dummy");

  const fxHost = await startHost(fxLib);
  cleanups.push(() => fxHost.close());
  const fxBeforeA = dirDigest(path.join(fxLib, "lib-item-a"));
  const fxBeforeP = dirDigest(path.join(fxLib, "packed-only"));
  const libRes = await fetch(`${fxHost.base}/api/fx-library`);
  const lib = await libRes.json();
  check(libRes.status === 200 && lib.readOnly === true && lib.copy === false && /只读枚举/.test(lib.note ?? ""), `端点声明只读（readOnly/copy/note 都在，实得 ${json({ readOnly: lib.readOnly, copy: lib.copy })}）`);
  check(json(lib.effects.map((e) => e.dir)) === json(["broken", "godrays", "tint"]), `目录去重枚举（坏 json 不列入，实得 ${json(lib.effects.map((e) => e.dir))}）`);
  const gd = lib.effects.find((e) => e.dir === "godrays");
  check(json(gd.items) === json(["lib-item-a", "lib-item-b"]) && gd.itemId === "lib-item-a", `同名目录跨条目去重、来源条目都记下（实得 ${json(gd.items)}）`);
  check(gd.meta.name === "godrays" && gd.meta.group === "enhance" && gd.meta.replacementkey === "godrays" && gd.meta.description === "光轴" && json(gd.meta.fbos) === json(["godrays_half"]), "effect.json 元数据随枚举返回");
  check(
    gd.passes.length === 2 && gd.passes[0].material === "materials/effects/godrays_downsample.json" && gd.passes[0].target === "godrays_half" && json(gd.passes[1].bind) === json([{ name: "godrays_half", index: 0 }]),
    "pass 清单：material / target / bind 原样带出",
  );
  check(
    gd.passes[0].shader === "effects/godrays_downsample" && gd.passes[0].combos?.PRE === 1 && gd.passes[1].combos?.VERTICAL === 0 && json(gd.passes[1].textures) === json(["$mediaThumbnail"]),
    "材质声明的 shader / combos / 贴图槽一并返回（贴图槽只读展示）",
  );
  check(
    gd.files[gdRel].includes("godrays_half") && gd.files["materials/effects/godrays_combine.json"].includes("VERTICAL") && gd.files["shaders/effects/godrays_combine.frag"].includes("g_FxAmount"),
    "枚举带上依赖文件文本（面板只读预览不用再伸手进库）",
  );
  check(Object.keys(gd.files).length === 5 && gd.missing.length === 0 && gd.notes.length === 0, `依赖齐全：files 5 个 / missing 空 / notes 空（实得 ${json({ files: Object.keys(gd.files), missing: gd.missing, notes: gd.notes })}）`);
  const brokenFx = lib.effects.find((e) => e.dir === "broken");
  check(json(brokenFx.missing) === json(["materials/effects/nope.json"]) && brokenFx.notes.some((n) => /材质缺失/.test(n)), `依赖缺失点名到 missing 并留 note（实得 ${json(brokenFx.missing)}）`);
  check(lib.errors.length === 1 && /effect\.json 解析失败/.test(lib.errors[0]), `坏 json 明确报错（实得 ${json(lib.errors)}）`);
  check(lib.stats.items === 3 && lib.stats.effectDirs === 3 && lib.stats.packagedSkipped === 1 && lib.stats.files === 9, `stats：${json(lib.stats)}`);
  const writeRes = await fetch(`${fxHost.base}/api/fx-library`, { method: "POST", body: "{}" });
  check(writeRes.status === 405 && (await writeRes.json()).error === "只读端点，需要 GET", "端点只读：POST 被拒 405（不提供任何写入 / 复制语义）");
  // 库目录不存在 → 明确报错（不是静默空列表）
  const fxHost2 = await startHost(path.join(tmpRoot, "no-such-fxlib"));
  cleanups.push(() => fxHost2.close());
  const missLib = await (await fetch(`${fxHost2.base}/api/fx-library`)).json();
  check(missLib.errors.length === 1 && /壁纸库目录不存在/.test(missLib.errors[0]) && missLib.effects.length === 0 && missLib.stats.files === 0, `库目录不存在 → errors 明确报错（实得 ${json(missLib.errors)}）`);

  // ---- (3) 往工程写引用（只写引用、不复制文件）+ combos 往返 ----
  const libDecls = await fxLibMod.inspectEffectPasses(gd.file, async (name) => gd.files[name] ?? null);
  check(
    libDecls.length === 2 && libDecls[0].params.map((p) => p.key).includes("threshold") && libDecls[0].combos.PRE === 1 && libDecls[1].combos.VERTICAL === 0,
    `用枚举带回的文本就能读出库内效果的参数表与 combos（实得 ${json(libDecls.map((p) => [p.params.map((q) => q.key), p.combos]))}）`,
  );
  const seeds = libDecls.map((ps, i) => ({
    constantshadervalues: Object.fromEntries(ps.params.map((p) => [p.key, fxLibMod.encodeValue(p, p.default)])),
    combos: { ...(gd.passes[i]?.combos ?? {}), ...(i === 1 ? { VERTICAL: 1 } : {}) },
  }));
  const doc = freshDoc();
  const fxObj = doc.scene.objects.find((o) => o.id === 1);
  const fxIndex = fxLibMod.addEffectRef(fxObj, gd.file, gd.dir, seeds);
  check(fxIndex === 0, `加效果：写进对象的 effects[] 并返回下标（实得 ${fxIndex}）`);
  check(
    json(fxObj.effects[0]) ===
      json({
        file: gdRel,
        name: "godrays",
        visible: true,
        passes: [
          { constantshadervalues: { threshold: 0.5 }, combos: { PRE: 1 } },
          { constantshadervalues: { amount: 1 }, combos: { VERTICAL: 1 } },
        ],
      }),
    `scene.json 结构正确：file / name / visible / passes[].constantshadervalues + combos（实得 ${json(fxObj.effects[0])}）`,
  );
  const declaredMap = new Map([[gd.file, libDecls.map((p) => p.combos)]]);
  const paramMap = new Map([[gd.file, libDecls.flatMap((p) => p.params)]]);
  const views = fxLibMod.inlinePassViews(fxObj, paramMap, declaredMap);
  const view1 = views.find((v) => v.pass === 1);
  check(
    view1 && json(view1.combosDeclared) === json({ VERTICAL: 0 }) && json(view1.combos) === json({ VERTICAL: 1 }) && view1.params.some((p) => p.key === "amount"),
    `面板同时看到「材质声明档」与「工程覆盖档」，参数表可用（实得 ${json({ declared: view1?.combosDeclared, override: view1?.combos })}）`,
  );
  check(
    json(fxLibMod.mergedCombos(view1.combosDeclared, view1.combos)) === json({ VERTICAL: 1 }) &&
      json(fxLibMod.mergedCombos(fxLibMod.combosOfMaterialJson(JSON.parse(gd.files["materials/effects/godrays_combine.json"])), { VERTICAL: 0 })) === json({ VERTICAL: 0 }),
    "mergedCombos：工程覆盖盖过材质声明（与引擎 `{...mp.combos, ...ov.combos}` 同序）",
  );
  check(fxLibMod.setPassCombo(fxObj, 0, 1, "VERTICAL", 0) === true && json(fxLibMod.passCombos(fxObj, 0, 1)) === json({ VERTICAL: 0 }), "combos 写：命中已有键就地改值（不新增键）");
  check(fxLibMod.clearPassCombo(fxObj, 0, 1, "VERTICAL") === true && json(fxLibMod.passCombos(fxObj, 0, 1)) === json({}), "combos 清：删掉工程覆盖即回到库内默认（材质声明不动）");
  check(fxLibMod.setPassCombo(fxObj, 0, 1, "VERTICAL", 1) === true && fxLibMod.setPassCombo(fxObj, 0, 1, "BLUR", 2) === true, "combos 写：库内没声明过的键也能写（引擎按程序缓存键编译新变体）");
  fxLibMod.clearPassCombo(fxObj, 0, 1, "BLUR");
  check(json(fxObj.effects[0].passes[1].combos) === json({ VERTICAL: 1 }), `回到待保存状态：combos = {VERTICAL:1}（实得 ${json(fxObj.effects[0].passes[1].combos)}）`);

  // 真保存路径：collectProject（编辑器实际用的收集器）→ 宿主 save-* 写盘 → 重新打开
  const realFetchLib = globalThis.fetch;
  globalThis.fetch = (url, init) => realFetchLib(String(url).startsWith("/") ? `${fxHost.base}${url}` : url, init);
  try {
    const files = await saveMod.collectProject(doc, memAssets("scene.json", { "scene.json": enc.encode("{}") }), null);
    const paths = files.map((f) => f.path);
    check(
      paths.length === 2 && paths.includes("scene.json") && paths.includes("project.json"),
      `保存清单只有工程自己的文件（实得 ${json(paths)}）`,
    );
    check(!paths.some((p) => /^effects\//i.test(p) || /godrays|lib_tint/.test(p)), "**未复制任何库内效果文件**：保存清单里没有 effects/<库目录>/** 也没有 godrays / lib_tint");
    const savedScene = JSON.parse(dec.decode(files.find((f) => f.path === "scene.json").data));
    const savedFx = savedScene.objects.find((o) => o.id === 1).effects[0];
    check(
      savedFx.file === gdRel && !/wwgl_/.test(savedFx.file) && json(savedFx) === json(fxObj.effects[0]),
      "工程 scene.json 里写的是库内相对引用 effects/<目录名>/effect.json：参数与 combos 内联、原样序列化",
    );
    const savedId = saveMod.newLibraryItemId(doc.title);
    await saveMod.saveToLibrary(savedId, files);
    const savedFiles = fs.readdirSync(path.join(fxLib, savedId), { recursive: true }).filter((n) => !fs.statSync(path.join(fxLib, savedId, n)).isDirectory());
    check(!savedFiles.some((n) => /godrays|lib_tint|effect\.json/i.test(n)), `工程条目盘上也没有库内效果文件（实得 ${json(savedFiles)}）`);
    const reopenedObj = JSON.parse(fs.readFileSync(path.join(fxLib, savedId, "scene.json"), "utf8")).objects.find((o) => o.id === 1);
    const reopenedFx = fxLibMod.effectViews(reopenedObj)[0];
    check(json(reopenedObj.effects[0]) === json(fxObj.effects[0]), "重开（真写盘 + 重读）：引用 / 参数 / combos 逐字段一致，往返不丢");
    check(reopenedFx?.file === gdRel && reopenedFx?.name === "godrays" && reopenedFx?.def === null, "重开：仍是库内效果条目（按目录名还原成库内 id，查不到内置参数表）");
    check(json(fxLibMod.passCombos(reopenedObj, 0, 1)) === json({ VERTICAL: 1 }) && json(fxLibMod.passCombos(reopenedObj, 0, 0)) === json({ PRE: 1 }), "重开：pass 级 combos 仍可读（保存 / 重开不丢、结构未改）");
    const againViews = fxLibMod.inlinePassViews(reopenedObj, paramMap, declaredMap);
    check(againViews.find((v) => v.pass === 1)?.params.some((p) => p.key === "amount"), "重开：参数面板仍能按库内 shader 读出参数（不依赖工程里有 effect.json）");
  } finally {
    globalThis.fetch = realFetchLib;
  }

  // ---- (4) 合规 + 陷阱守门（源码级）----
  check(/if \(path === "\/api\/fx-library"\)/.test(HOST_TS) && /只读端点，需要 GET/.test(HOST_TS), "宿主端点 /api/fx-library 只收 GET（写方法一律 405）");
  const scanRegion = HOST_TS.slice(HOST_TS.indexOf("async function scanEffectLibrary"), HOST_TS.indexOf("export type FolderPicker"));
  check(scanRegion.length > 0 && !/writeFile|mkdir|copyFile|unlink|rename|appendFile/.test(scanRegion), "枚举实现只做 readdir / readFile：没有写入 / 建目录 / 复制调用");
  const mainText = fs.readFileSync(path.join(ROOT, "editor/main.ts"), "utf8");
  // 只看效果浏览器那一段（到 addEffectTo 为止）：内置效果的既有实现本来就会 overlay.put 自己的四件文件，不算复制库文件
  const libRegion = mainText.slice(mainText.indexOf("效果库浏览器（M6"), mainText.indexOf("function addEffectTo"));
  check(libRegion.length > 0 && /addEffectRef\(/.test(libRegion), "编辑器效果浏览器区：只调 addEffectRef 往工程写引用");
  check(!/overlay\.put|effectFiles\(/.test(libRegion), "**未复制库内文件**：效果浏览器区没有 overlay.put / effectFiles（不生成、不铺开库内效果文件）");
  check(
    /dataset\.fxLibDir/.test(libRegion) && /dataset\.fxLibAdd/.test(libRegion) && /dataset\.fxSource/.test(libRegion) && /dataset\.fxLibStats/.test(libRegion),
    "效果浏览器带条目 / 添加按钮 / 来源标注钩子（工程内 / 仅库内）",
  );
  check(/fxLibraryFiles/.test(libRegion) && !/localStorage|indexedDB/.test(libRegion), "库内文件文本只缓存在内存（不落盘到工程）");
  check(dirDigest(path.join(fxLib, "lib-item-a")) === fxBeforeA, "库内效果目录一字未动（枚举 / 加效果 / 保存都没写回库）");
  check(dirDigest(path.join(fxLib, "packed-only")) === fxBeforeP, "打包条目也未被动过（不解包、不改写、不复制出效果文件）");

  // ---- (5) layerMaterial 下标坑守门（M1 发现的引擎行为，M6 加效果必须绕开）----
  const fxParse = await imp("renderer/vendor/we-scene/scene/effects-parse.js");
  const layer = { effects: [{ file: gdRel, name: "godrays", passes: [{ constantshadervalues: { threshold: 1 }, combos: { PRE: 1 } }] }] };
  const attached = fxParse.attachLayerMaterialEffect(layer, { shader: "effects/author_starfield", constantshadervalues: { u: 1 }, combos: { STARS: 1 } });
  check(
    attached === true && layer.effects.length === 2 && layer.effects[0].layerMaterial === true && layer.effects[0].file === "" && layer.effects[1].file === gdRel,
    "引擎把图层自身材质合成条目 unshift 到队首（引擎侧下标整体偏一位）",
  );
  check(layer.effects.filter((e) => !e?.layerMaterial)[0].file === gdRel, "按 `filter((e) => !e?.layerMaterial)[i]` 定位才拿到文档下标对应的那条");
  const docEntry = layer.effects.filter((e) => !e?.layerMaterial)[0];
  check(
    json(fxLibMod.passCombos(layer, 0, 0)) === json({ STARS: 1 }) && json(fxLibMod.passCombosOnPass(docEntry.passes[0])) === json({ PRE: 1 }),
    "合成条目自己也在引擎下标 0 上（还带自己的 combos）：按下标直取会读错条目，必须 filter 后再取文档下标",
  );
  const layer2 = { effects: [] };
  check(fxParse.attachLayerMaterialEffect(layer2, { shader: "sprite", constantshadervalues: {} }) === false && layer2.effects.length === 0, "内置 albedo shader（sprite / generic / genericimage*）不合成 layerMaterial 条目（不会偏位）");
  check(!!fxLibMod.effectDirNameOf(gdRel) && fxLibMod.effectIdOf(gdRel) === "godrays", "文档 effects[].file 用同一套目录名还原（写引用 / 读引用同源）");
}

// OBJ-PASSTHRU. 对象属性直通层：十六个对象级字段的往返 / 未知字段原样（M4 A5）
//
// 纯函数部分（下面全部）：无浏览器可跑 —— 夹具是内存里的 scene.json 对象。
//
// headless 用例（需真浏览器，加 --headless 才跑）：选中 light 层 → 检视器「灯光」分组
// 改 intensity → 引擎当帧出帧随之变。本沙箱 Chrome 起不来（沙箱初始化 / Runtime.evaluate
// 超时），这一段只注明，不在本文件跑。
// ───────────────────────────────────────────────────────────────────────────
section("OBJ-PASSTHRU. 对象属性直通层 editor/objprops.ts（M4 A5）");
{
  const op = await loadEditorModule("objprops");
  const opPath = path.join(ROOT, "editor/objprops.ts");
  const opSrc = fs.readFileSync(opPath, "utf8");

  /** 计划 §1.2 的十六项命中表，顺序与规格表一致 */
  const OBJ16 = [
    "castshadow",
    "disablepropagation",
    "parallaxDepth",
    "solid",
    "anchor",
    "colorBlendMode",
    "alignment",
    "perspective",
    "instanceoverride",
    "copybackground",
    "backgroundbrightness",
    "spacing",
    "depthtest",
    "clampuvs",
    "blockalign",
    "ledsource",
  ];

  /**
   * OBJ-PASSTHRU 判据体：返回失败清单（空 = 全绿）。变异红测复用它。
   */
  const objPassthruCorpus = (f) => {
    const bad = [];
    const is = (cond, msg) => {
      if (!cond) bad.push(msg);
    };

    // ---- 1. 规格表：十六项 / 键序 / 引擎档位 ----
    is(json(f.OBJ_FIELD_KEYS) === json(OBJ16), "十六个对象级字段齐、键序与计划 §1.2 命中表一致");
    is(f.OBJ_FIELDS.length === 16, "规格表恰好十六项");
    const read = f.OBJ_FIELDS.filter((s) => s.engine === "read").map((s) => s.key);
    const unread = f.OBJ_FIELDS.filter((s) => s.engine === "unread").map((s) => s.key);
    is(json(read) === json(OBJ16.slice(0, 12)), "引擎本版本真读的十二项成组");
    is(json(unread) === json(["depthtest", "clampuvs", "blockalign", "ledsource"]), "四个零命中字段单独成组（UI 打「引擎不读」角标）");
    is(json(f.ALIGN_VALUES) === json(["center", "centre", "left", "right", "top", "bottom", "topleft", "topright", "bottomleft", "bottomright"]), "ALIGN 枚举与引擎 renderer-glsl.js 同表");
    is(json(f.ANCHOR_VALUES) === json(["none", ...f.ALIGN_VALUES]), "anchor 比 ALIGN 多一个 none（parse.js 的 textAnchor）");
    is(f.objFieldOf("colorblendmode")?.key === "colorBlendMode" && f.objFieldOf("SPACING")?.key === "spacing", "按字段名查规格大小写不敏感");
    is(f.objFieldOf("nope") === undefined, "未列出的字段没有规格（UI 不出控件、写回拒绝）");

    // ---- 2. 文案键派生：每个字段一条 objp.n.<小写键> ----
    const noteKeys = f.OBJ_FIELDS.map((s) => f.objFieldNoteKey(s.key));
    is(new Set(noteKeys).size === 16 && noteKeys.every((k) => k.startsWith("objp.n.")), "每个字段派生一条 objp.n.<小写键> 文案键");
    is(f.objFieldNoteKey("parallaxDepth") === "objp.n.parallaxdepth", "派生键统一转小写");

    // ---- 3. 写回命中原名、不新增键（大小写不敏感）----
    const o = { id: 7, CastShadow: false, mystery: { a: 1 }, effects: [1] };
    is(f.setObjField(o, "castshadow", true) === true, "写回命中已有键 → true");
    is(o.CastShadow === true && !("castshadow" in o), "写到**作者原本的键名**上（大小写不敏感命中，不新增歧义键）");
    is(json(Object.keys(o)) === json(["id", "CastShadow", "mystery", "effects"]), "键集合逐字不变（未知键没被挤掉）");
    is(f.setObjField(o, "castshadow", true) === false, "同值再写返回 false（幂等，不出空撤销）");
    is(
      f.setObjField(o, "CASTSHADOW", false) === true && "CASTSHADOW" in o === false && o.CastShadow === false && json(Object.keys(o)) === json(["id", "CastShadow", "mystery", "effects"]),
      "换个大小写再写仍命中同一个键、仍不新增键",
    );
    is(o.mystery.a === 1 && json(o.effects) === json([1]), "别的字段逐字节不动");

    // ---- 4. 列表内但对象上没有的字段：按规范键新建一次 ----
    const fresh = { id: 11 };
    is(f.setObjField(fresh, "solid", true) === true && json(Object.keys(fresh)) === json(["id", "solid"]), "列表内缺字段时按规范键新建一次");
    is(f.setObjField(fresh, "Solid", false) === true && json(Object.keys(fresh)) === json(["id", "solid"]) && fresh.solid === false, "之后换大小写写回仍命中同一个键，不再新增");

    // ---- 5. 未列出的字段拒绝 ----
    const g = { id: 1 };
    const gBefore = json(g);
    is(f.setObjField(g, "nope", 1) === false && json(g) === gBefore, "未列出的字段拒绝写回且对象逐字节不动");
    is(f.objFieldValue(g, "solid") === undefined && f.fieldKeyOf(g, "solid") === null, "对象上没有该字段时取值为 undefined（UI 显示「未设置」）");

    // ---- 6. {user|script|animation, value} 包装只改 .value ----
    const w = { id: 2, ALIGNMENT: { user: "align", value: "left" } };
    is(f.isObjWrapper(w.ALIGNMENT) === true && f.objFieldRaw(w.ALIGNMENT) === "left", "包装能识别、快照值能取出");
    is(f.setObjField(w, "alignment", "right") === true && json(w.ALIGNMENT) === json({ user: "align", value: "right" }), "包装只改 value，user 绑定原样保留");
    is(f.setObjField(w, "alignment", "right") === false, "包装值没变时返回 false");
    // 引擎侧不要求包装里有 value：`{script}` / `{animation:{options}}` 也算绑定（审计 L2）
    const wScript = { id: 12, ALIGNMENT: { script: "return 'x';" } };
    is(f.isObjWrapper(wScript.ALIGNMENT) === true && f.isObjWrapper({ animation: { options: {} } }) === true
      && f.isObjWrapper({}) === false && f.isObjWrapper({ script: "" }) === false
      && f.isObjWrapper({ animation: {} }) === false && f.isObjWrapper("left") === false && f.isObjWrapper([1]) === false,
      "无 value 的绑定也算包装：非空 script / animation.options 命中，空对象 / 空 script 不命中（审计 L2）");
    is(f.setObjField(wScript, "alignment", "right") === true && json(wScript.ALIGNMENT) === json({ script: "return 'x';", value: "right" }),
      "无 value 的 {script} 绑定：只补 .value，脚本原样保留（不再整块换成裸值）");

    // ---- 7. 取值口径（scene.json 里 bool 也常写成 0/1/"1"）----
    is(f.objFieldValue({ SOLID: "1" }, "solid") === true && f.objFieldValue({ solid: 0 }, "solid") === false, "取值把 \"1\"/1 当真、0 当假");
    is(f.objFieldTruthy("0") === false && f.objFieldTruthy("false") === false && f.objFieldTruthy("") === false, "假值串（\"0\" / \"false\" / 空）判假");
    is(f.objFieldTruthy({ value: 0 }) === false && f.objFieldTruthy({ value: 1 }) === true, "包装里的 0/1 也按数字判");

    // ---- 8. 编码 / 解码：vec2 一律 \"x y\" 字符串 ----
    const v = { id: 3 };
    is(f.setObjField(v, "spacing", [1.5, -2]) === true && v.spacing === "1.5 -2", "vec2 编成 \"x y\" 字符串（parse.js 的 parseVec2 对数组会得 [0,0]）");
    is(json(f.parseObjVec2("3 4")) === json([3, 4]) && json(f.parseObjVec2([5, 6])) === json([5, 6]), "vec2 解码兼容字符串与数组两种语料形态");
    is(json(f.parseObjVec2({ value: "7 8" })) === json([7, 8]), "vec2 解码拆 {value} 包装");
    const v2 = { id: 4 };
    is(f.setObjField(v2, "colorBlendMode", 6.4) === true && v2.colorBlendMode === 6, "int 字段取整");
    is(f.encodeObjField(f.objFieldOf("backgroundbrightness"), 0.333333333) === 0.33333, "number 字段按 5 位小数编码");
    is(f.encodeObjField(f.objFieldOf("anchor"), "none") === "none", "anchor 的 none 原样保留（不在 ALIGN 表里但 parse.js 认）");
    is(f.encodeObjField(f.objFieldOf("perspective"), "false") === true && f.encodeObjField(f.objFieldOf("perspective"), 0) === false, "bool 字段真值口径");
    is(f.decodeObjField(f.objFieldOf("spacing"), "1 -1") instanceof Array, "vec2 字段解码出分量数组（控件是两格输入）");

    // ---- 9. instanceoverride 是**表**：合并不删键 ----
    const io = { id: 5, instanceoverride: { count: { script: "x", value: 2 }, alpha: 1, keepme: 5 } };
    is(f.setObjField(io, "instanceoverride", { count: 8, beta: 3 }) === true, "表字段写回成功");
    is(
      json(io.instanceoverride) === json({ count: { script: "x", value: 8 }, alpha: 1, keepme: 5, beta: 3 }),
      "逐键写同名键、包装只改 value、没提到的键保留（不整表替换）",
    );
    is(f.mergeObjFieldTable(io, "instanceoverride", { gamma: 1 }) === true && io.instanceoverride.gamma === 1, "表合并可重复调用");
    is(f.mergeObjFieldTable(io, "instanceoverride", { count: 8 }) === false, "表内没有变化时返回 false");

    // ---- 10. raw 透传：不猜类型 ----
    const r = { id: 6 };
    is(f.setObjFieldText(r, "blockalign", '"left"') === true && r.blockalign === "left", "raw 字段按 JSON 收（带引号的字符串）");
    is(f.setObjFieldText(r, "clampuvs", "true") === true && r.clampuvs === true, "raw 字段按 JSON 收（布尔）");
    is(f.setObjFieldText(r, "ledsource", "left") === true && r.ledsource === "left", "裸字符串也收下（不包成 \"\\\"left\\\"\"）");
    is(f.objFieldText(f.objFieldOf("ledsource"), "left") === "left" && f.objFieldText(f.objFieldOf("ledsource"), true) === "true", "文本框显示与写入口径对称");
    const rb = json(r);
    is(f.setObjFieldText(r, "instanceoverride", "{oops") === false && json(r) === rb, "json 字段的坏输入拒绝且逐字节不动");
    is(f.setObjFieldText(r, "nope", "1") === false, "未列出的字段拒绝文本框写回");
    is(f.setObjFieldText(r, "ledsource", "   ") === false, "空文本框拒绝（不当成空字符串写进去）");

    // ---- 11. 全等比较，不做模糊匹配 ----
    is(f.fieldKeyOf({ parallaxDepthOwn: "9 9" }, "parallaxDepth") === null, "parallaxDepth 不命中 parallaxDepthOwn（引擎另有此字段、语义不同）");
    const po = { id: 8, parallaxDepthOwn: "9 9" };
    is(f.setObjField(po, "parallaxDepth", [1, 2]) === true && po.parallaxDepthOwn === "9 9" && po.parallaxDepth === "1 2", "写 parallaxDepth 不动 parallaxDepthOwn");
    is(f.presentFieldKeys(po).length === 1 && f.presentFieldKeys(po)[0] === "parallaxDepth", "presentFieldKeys 列出对象上真实存在的本层字段（保留原名）");

    // ---- 12. 十六项都能出状态（检视器由它驱动）----
    const st = f.objFieldStates({ id: 9 });
    is(st.length === 16 && st.every((s) => s.spec && s.value === undefined && s.wrapped === false), "空对象也出十六行状态（值为 undefined = 未设置）");
    const stw = f.objFieldStates({ id: 10, solid: { user: "u", value: true } });
    is(stw.find((s) => s.spec.key === "solid")?.wrapped === true, "带包装的值在状态里被标记（UI 提示只改 value）");
    const stk = f.objFieldStates({ id: 12, PARALLAXDEPTH: "1 2" });
    is(stk.find((s) => s.spec.key === "parallaxDepth")?.key === "PARALLAXDEPTH", "状态里带回作者的原键名（写回要用它）");

    return bad;
  };

  const noteKeys = op.OBJ_FIELDS.map((s) => op.objFieldNoteKey(s.key));

  const opBad = objPassthruCorpus(op);
  check(opBad.length === 0, `对象属性直通层：十六项往返 / 未知字段原样 / 不新增键 / 包装只改 value 全部成立（${opBad.join(" / ") || "ok"}）`);

  // ---- 引擎侧对照：十六项里哪些真的被 parse.js 读（口径来源，别把「透传」说成「生效」）----
  {
    const parseSrc = fs.readFileSync(path.join(ROOT, "renderer/vendor/we-scene/scene/parse.js"), "utf8");
    const engineHits = [
      ["textCastshadow: parseBool(o.castshadow", "castshadow → 文字层投影"],
      ["disablePropagation: o.disablepropagation === true", "disablepropagation → 组级截断视差传播"],
      ["parallaxDepth: o.parallaxDepth !== undefined ? parseVec2(o.parallaxDepth) : null,", "parallaxDepth → parseVec2"],
      ["colorBlendMode: o.colorBlendMode || 0", "colorBlendMode → 整数枚举"],
      ["textBackgroundbrightness: parseNum(o.backgroundbrightness, 1)", "backgroundbrightness → 文字层盒底色"],
      ["textSpacing: o.spacing ? parseVec2(o.spacing) : [0, 0]", "spacing → 文字字距"],
      ["textAnchor: o.anchor === 'none' ? 'none'", "anchor → 文字层盒锚点（含 none）"],
      ["perspective: o.perspective === true ? true : undefined", "perspective → 严格 true"],
      ["copybackground: !!o.copybackground", "copybackground → 取身后画面"],
    ];
    const missHits = engineHits.filter(([lit]) => !parseSrc.includes(lit)).map(([, name]) => name);
    check(missHits.length === 0, `十二项「引擎真读」的字段在 parse.js 里逐条对得上（${missHits.join(" / ") || "ok"}）`);
    const unreadHits = ["depthtest", "clampuvs", "blockalign", "ledsource"].filter((k) => new RegExp(`o\\.${k}\\b`).test(parseSrc));
    check(unreadHits.length === 0, `四个 unread 字段在 parse.js 里确实没有对象级读取（被读到的：${json(unreadHits)}）`);
  }

  // ---- 检视器接线：分组注册 + 由规格表驱动 ----
  {
    const mainSrc = fs.readFileSync(path.join(ROOT, "editor/main.ts"), "utf8");
    check(
      /import \{[^}]*objFieldStates[^}]*\} from "\.\/objprops";/.test(mainSrc) &&
        /function objPropsGroup\(node: LayerNode\): HTMLElement/.test(mainSrc) &&
        /objFieldStates\(node\.obj\)/.test(mainSrc) &&
        /\{ id: "objprops", order: 250, when: \(\) => true, render: objPropsGroup, tab: "props" \}/.test(mainSrc),
      "「对象属性」分组注册进 BUILTIN_INSPECTOR（order 250 / props 页），行由 objFieldStates 驱动",
    );
    check(
      /objEditOk\(et\("objp\.edit", \{ field: spec\.key \}\), id, mutate\)/.test(mainSrc) && /setObjField\(o, spec\.key, /.test(mainSrc),
      "写回走 objEditOk → setObjField（可撤销，且只碰这一个字段）",
    );
    check(/objFieldNoteKey\(key\)/.test(mainSrc) && /const objFieldTip = \(key: string\) => et\(objFieldNoteKey\(key\)\)/.test(mainSrc), "字段语义说明由规格表派生（文案与实现同一处真源）");
    const i18nSrc = fs.readFileSync(path.join(ROOT, "editor/i18n.ts"), "utf8");
    const objpKeys = ["objp.title", "objp.hint", "objp.unset", "objp.edit", "objp.rawBad", "objp.wrapped", "objp.engineUnread", ...noteKeys];
    const missingObjp = objpKeys.filter((k) => (i18nSrc.match(new RegExp(`"${k.replace(/\./g, "\\.")}":`, "g")) ?? []).length !== 2);
    check(missingObjp.length === 0, `对象属性文案中英文都有、每个键恰好出现 2 次（缺 ${json(missingObjp)}）`);
    const cssSrc = fs.readFileSync(path.join(ROOT, "editor/editor.css"), "utf8");
    check(/\.ed-form\.ed-objprops-form\b/.test(cssSrc) && /\.ed-tag-dim\b/.test(cssSrc), "对象属性分组的标签列与「引擎不读」角标样式在 editor.css");
  }

  // ---- 变异红测：判据咬得住吗 ----
  {
    const opMut = async (from, to, tag) => {
      const mut = opSrc.replace(from, to);
      check(mut !== opSrc, `注入点存在（${tag}）`);
      return loadEditorModule("objprops", { [opPath]: mut });
    };
    const badOf = async (m) => (await objPassthruCorpus(m)).join(" / ");

    const om1 = await opMut("for (const k of Object.keys(obj)) if (k.toLowerCase() === want) return k;", "for (const k of Object.keys(obj)) if (k === want) return k;", "字段键大小写不敏感");
    const om1bad = await badOf(om1);
    check(/原本的键名|大小写/.test(om1bad), "字段键改成大小写敏感时「命中原名 / 不新增键」判据变红");

    const om2 = await opMut("for (const k of Object.keys(obj)) if (k.toLowerCase() === want) return k;", "for (const k of Object.keys(obj)) if (k.toLowerCase().startsWith(want)) return k;", "全等比较");
    const om2bad = await badOf(om2);
    check(/parallaxDepthOwn/.test(om2bad), "改成前缀模糊匹配时「parallaxDepth 不咬 parallaxDepthOwn」判据变红");

    const om3 = await opMut(
      "  if (isObjWrapper(cur)) {\n    if (sameValue(cur.value, next)) return false;\n    cur.value = next;\n    return true;\n  }\n",
      "",
      "包装只改 value",
    );
    const om3bad = await badOf(om3);
    check(/包装只改 value/.test(om3bad), "无视 {user,value} 包装时「只改 value」判据变红");

    const om4 = await opMut("      return `${round5(x)} ${round5(y)}`;", "      return [x, y];", "vec2 编成字符串");
    const om4bad = await badOf(om4);
    check(/vec2 编成/.test(om4bad), "vec2 写成数组时「\\\"x y\\\" 字符串」判据变红（parse.js 会读成 [0,0]）");

    const om5 = await opMut("    return mergeObjFieldTable(obj, spec.key, input as Record<string, unknown>);\n", "", "表字段合并");
    const om5bad = await badOf(om5);
    check(/没提到的键保留|不整表替换/.test(om5bad), "表字段改成整表替换时「合并不删键」判据变红");

    const om6 = await opMut(
      "  if (spec.type === \"raw\") {\n    let parsed: unknown = t;\n    try {\n      parsed = JSON.parse(t);\n    } catch {\n      /* 不是 JSON：按裸字符串透传 */\n    }\n    return setObjField(obj, spec.key, parsed);\n  }\n",
      "",
      "raw 宽容解析",
    );
    const om6bad = await badOf(om6);
    check(/裸字符串也收下/.test(om6bad), "raw 改成严格 JSON 时「裸字符串也收下」判据变红");
  }

  console.log("  （headless：选中 light 层 → 检视器「灯光」分组改 intensity → 出帧随之变；见本段头注）");
}

// ───────────────────────────────────────────────────────────────────────────
// LIGHT-CAM. light / camera 图层入口：LayerKindDef.create 被生产消费（M4 A6）
//
// 纯函数部分（下面全部）：无浏览器可跑 —— 夹具是内存里的空 scene 文档。
//
// headless 用例（需真浏览器，加 --headless 才跑）：点工具条「添加灯光层」→ 图层树出现
// light 层 → 检视器改 intensity / radius → 引擎 g_Lights* 当帧更新。本沙箱 Chrome 起不来，
// 这一段只注明。
// ───────────────────────────────────────────────────────────────────────────
section("LIGHT-CAM. light / camera 图层入口 editor/layer-kinds.ts + objlayers.ts（M4 A6）");
{
  const lk = await loadEditorModule("layer-kinds");
  const ol = await loadEditorModule("objlayers");
  const lkPath = path.join(ROOT, "editor/layer-kinds.ts");
  const lkSrc = fs.readFileSync(lkPath, "utf8");
  const olPath = path.join(ROOT, "editor/objlayers.ts");
  const olSrc = fs.readFileSync(olPath, "utf8");

  /** 与 makeDoc 同形的空场景文档（rebuildTree 只需要 scene.objects） */
  const mkDoc = () => ({ type: "scene", title: "t", scene: { camera: {}, general: {}, objects: [] }, roots: [], objectCount: 0 });

  const lightCamCorpus = (f, mod) => {
    const bad = [];
    const is = (cond, msg) => {
      if (!cond) bad.push(msg);
    };
    const objsOf = (d) => d.scene.objects;

    // ---- 1. 能力位：只有登记了 create 的种类能新建 ----
    is(f.canCreateLayerOfKind("light") === true && f.canCreateLayerOfKind("camera") === true, "light / camera 可新建（九项内建此前一个 create 都没有）");
    is(f.canCreateLayerOfKind("image") === false && f.canCreateLayerOfKind("group") === false, "没登记 create 的内建种类仍不可新建（按钮据此置灰）");
    is(f.canCreateLayerOfKind("nope") === false, "未知种类不可新建");

    // ---- 2. 经 create 建 light 层：形状 + 引擎缺省值 ----
    const d1 = mkDoc();
    const id1 = f.createLayerOfKind("light", d1, { name: "灯光" });
    is(id1 === 1 && objsOf(d1).length === 1, "createLayerOfKind(\"light\") 建出唯一一层并返回新 id");
    const L = objsOf(d1)[0];
    is(L.light === "lpoint" && L.name === "灯光" && L.visible === true, "默认灯类型 lpoint、名字用调用方给的（已本地化的）名字");
    is(L.intensity === 1 && L.radius === 1000 && L.exponent === 2, "强度 / 半径 / 衰减指数取 parse.js 的缺省值（1 / 1000 / 2）");
    is(L.color === "1 1 1" && L.origin === "0 0 0" && L.scale === "1 1 1" && L.alpha === 1, "基础字段齐全且与语料同形（颜色是 \\\"r g b\\\" 串）");
    is(d1.roots.length === 1 && d1.roots[0].kind === "light" && d1.objectCount === 1, "rebuildTree 生效：图层树认得出这是 light（doc.kindOf 的 light 分支）");
    is(mod.getLightFields(L)?.type === "point" && mod.getLightFields(L)?.lane === "v1", "引擎口径：lpoint 的衰减类型是 point、通道是 V1");

    // ---- 3. 经 create 建 camera 层 ----
    const d2 = mkDoc();
    const id2 = f.createLayerOfKind("camera", d2, { name: "相机" });
    is(id2 === 1 && objsOf(d2).length === 1, "createLayerOfKind(\"camera\") 建出唯一一层");
    const C = objsOf(d2)[0];
    is(C.camera === "default" && C.fov === 50 && C.zoom === 1, "相机对象写 camera:\\\"default\\\" + fov 50 + zoom 1（语料同形）");
    is(d2.roots[0].kind === "camera", "图层树认得出这是 camera（不是顶层视口快照 scene.camera）");
    is(d2.scene.camera && json(d2.scene.camera) === json({}), "顶层 scene.camera 没被碰（那只是编辑器视口快照，运行时不用）");

    // ---- 4. 没 create 的种类 / 未知种类：返回 null 且不动文档 ----
    const d3 = mkDoc();
    is(f.createLayerOfKind("image", d3) === null && objsOf(d3).length === 0, "没 create 的种类返回 null 且不建层");
    is(f.createLayerOfKind("nope", d3) === null && objsOf(d3).length === 0, "未知种类返回 null 且不建层");

    // ---- 5. 同文档里再建一层：id 递增 ----
    const d4 = mkDoc();
    f.createLayerOfKind("light", d4, { name: "a" });
    const id4 = f.createLayerOfKind("camera", d4, { name: "b" });
    is(id4 === 2 && objsOf(d4).length === 2, "后续新建按现有最大 id 递增（nextObjectId）");

    // ---- 6. 灯字段读写：通道身份保留、衰减公式不被归一化 ----
    is(mod.lightLaneOf("lspot") === "v1" && mod.lightLaneOf("point") === "legacy" && mod.lightLaneOf("weird") === "legacy", "通道判定：^l 前缀走 V1，其余（含未知串）走老通道");
    is(mod.lightTypeOf("lspot") === "spot" && mod.lightTypeOf("ldirectional") === "directional" && mod.lightTypeOf("ltube") === "point", "衰减类型：只有 spot / directional 保留，ltube 归 point");
    const lg = { light: "lpoint", intensity: 1, radius: 1000, exponent: 2, color: "1 1 1" };
    is(mod.setLightField(lg, "light", "lspot") === true && lg.light === "lspot", "改灯类型串写回原文（不归一化）");
    is(mod.getLightFields(lg)?.lane === "v1" && mod.getLightFields(lg)?.type === "spot", "改完类型后通道 / 衰减类型随之更新");
    is(mod.setLightField(lg, "intensity", 3) === true && lg.intensity === 3, "改强度");
    is(mod.setLightField(lg, "radius", -1) === false && lg.radius === 1000, "负半径拒绝");
    is(mod.setLightField(lg, "color", [1, 0.5, 0]) === true && lg.color === "1 0.5 0", "颜色编成 \\\"r g b\\\" 串");
    is(mod.setLightField(lg, "light", "point") === true && mod.getLightFields(lg)?.lane === "legacy", "切回老通道串（两条衰减公式不同，编辑器不替作者决定）");
    is(mod.setLightField({}, "intensity", 1) === false, "非灯对象拒绝写灯字段");

    // ---- 7. 灯字段的包装只改 .value ----
    const lw = { light: "lpoint", intensity: { script: "s", value: 1 } };
    is(mod.setLightField(lw, "intensity", 2) === true && json(lw.intensity) === json({ script: "s", value: 2 }), "强度带 {script,value} 包装时只改 value");
    is(mod.setLightField(lw, "intensity", 2) === false, "包装值没变时返回 false");

    // ---- 8. 相机字段读写：fov 0 = 交回引擎缺省 ----
    const cg = { camera: "default", fov: 50, zoom: 1 };
    is(mod.setCameraField(cg, "fov", 0) === true && cg.fov === 0, "fov 允许写 0（引擎按 general.fov 或 50 兜底）");
    is(mod.setCameraField(cg, "fov", 200) === false && mod.setCameraField(cg, "fov", -1) === false, "fov ≥ 180 或负值拒绝");
    is(mod.setCameraField(cg, "zoom", 0) === false && mod.setCameraField(cg, "zoom", 2) === true && cg.zoom === 2, "zoom 必须 > 0");
    is(mod.setCameraField({ light: "lpoint" }, "fov", 50) === false, "非相机对象拒绝写相机字段");
    is(mod.getCameraFields(cg)?.fov === 0 && mod.getCameraFields(cg)?.zoom === 2, "读回当前相机字段");

    return bad;
  };

  const lcBad = lightCamCorpus(lk, ol);
  check(lcBad.length === 0, `light / camera 图层：建层形状 / 引擎缺省 / 通道身份 / 字段读写全部成立（${lcBad.join(" / ") || "ok"}）`);

  // ---- ★ LayerKindDef.create 是唯一构造路径（去掉 create 就不该再能建层）----
  {
    const mut = lkSrc.replace(
      '{ kind: "light", builtin: true, canAnimate: true, create: (doc, opts) => addLightLayer(doc, "lpoint", opts?.name ?? "Light") },',
      '{ kind: "light", builtin: true, canAnimate: true },',
    );
    check(mut !== lkSrc, "注入点存在（去掉 light 的 create）");
    const mutMod = await loadEditorModule("layer-kinds", { [lkPath]: mut });
    const dm = mkDoc();
    check(
      mutMod.canCreateLayerOfKind("light") === false && mutMod.createLayerOfKind("light", dm, { name: "x" }) === null && dm.scene.objects.length === 0,
      "★ 把 light 的 create 去掉后入口就不再建层（证明消费的是 LayerKindDef.create，不是另写一份构造逻辑）",
    );
    check(lkSrc.includes('create: (doc, opts) => addLightLayer(doc, "lpoint", opts?.name ?? "Light")') && lkSrc.includes("create: (doc, opts) => addCameraLayer(doc, opts?.name ?? \"Camera\")"), "两种 create 都接到 objlayers 的构造器上（不复制一份字段表）");
    check(/return def\.create\(doc, opts\) \?\? null;/.test(lkSrc), "createLayerOfKind 只经注册表的 create 转发");
    const ckBody = lkSrc.slice(lkSrc.indexOf("export function createLayerOfKind"));
    check(
      /def\.create\(/.test(ckBody.slice(0, 400)) && !/addLightLayer|addCameraLayer/.test(ckBody.slice(0, 400)),
      "createLayerOfKind 体内没有旁路构造（不直接调 objlayers 的构造器）",
    );
  }

  // ---- 检视器 / 工具条接线 ----
  {
    const mainSrc = fs.readFileSync(path.join(ROOT, "editor/main.ts"), "utf8");
    const htmlSrc = fs.readFileSync(path.join(ROOT, "editor/index.html"), "utf8");
    check(
      /const lyAddLightEl = \$\<HTMLButtonElement\>\("#ly-add-light"\);\nlyAddLightEl\.onclick = \(\) => addKindLayer\("light"\);/.test(mainSrc) &&
        /const lyAddCameraEl = \$\<HTMLButtonElement\>\("#ly-add-camera"\);\nlyAddCameraEl\.onclick = \(\) => addKindLayer\("camera"\);/.test(mainSrc),
      "工具条按钮接上创建路径（#ly-add-light / #ly-add-camera → addKindLayer）",
    );
    check(
      /function addKindLayer\(kind: "light" \| "camera"\)[\s\S]{0,600}?structEdit\(label, \(d\) => createLayerOfKind\(kind, d, \{ name \}\) \?\? undefined\);/.test(mainSrc),
      "addKindLayer 走 structEdit + createLayerOfKind（可撤销、可存库，与文字 / 粒子层同一条结构编辑链）",
    );
    check(
      /lyAddLightEl\.disabled = lyAddEl\.disabled \|\| !canCreateLayerOfKind\("light"\);/.test(mainSrc) && /lyAddCameraEl\.disabled = lyAddEl\.disabled \|\| !canCreateLayerOfKind\("camera"\);/.test(mainSrc),
      "按钮可用性由注册表的能力位决定（没有 create 就是灰的）",
    );
    check(
      /<button[^>]*id="ly-add-light"[^>]*data-et-title="ly\.addLight"/.test(htmlSrc) && /<button[^>]*id="ly-add-camera"[^>]*data-et-title="ly\.addCamera"/.test(htmlSrc),
      "页面工具条有两个按钮，标题走 i18n 的 data-et-title",
    );
    check(
      /\{ id: "light", order: 450, when: \(n\) => n\.kind === "light", render: lightGroup, tab: "props" \}/.test(mainSrc) &&
        /\{ id: "camera", order: 460, when: \(n\) => n\.kind === "camera", render: cameraGroup, tab: "props" \}/.test(mainSrc),
      "light / camera 检视器分组注册进 BUILTIN_INSPECTOR（order 450 / 460）",
    );
    check(
      /getLightFields\(node\.obj\)/.test(mainSrc) && /setLightField\(o, /.test(mainSrc) && /getCameraFields\(node\.obj\)/.test(mainSrc) && /setCameraField\(o, /.test(mainSrc),
      "两个分组用 objlayers 的字段读写（检视器里没有第二份字段表）",
    );
    check(/light\.lane\.v1/.test(mainSrc) && /light\.lane\.legacy/.test(mainSrc), "通道（V1 / 老通道）在 UI 上如实标注");
    check(/light\.exponentTip/.test(mainSrc) && /camera\.fovTip/.test(mainSrc), "「只有 V1 吃 exponent」「fov 0 = 引擎缺省」这类语义差异写在文案里");
    const i18nSrc = fs.readFileSync(path.join(ROOT, "editor/i18n.ts"), "utf8");
    const lcKeys = [
      "ly.addLight",
      "ly.addCamera",
      "layer.defaultLight",
      "layer.defaultCamera",
      "log.addedLight",
      "log.addedCamera",
      "insp.light",
      "insp.camera",
      "light.type",
      "light.typeTip",
      "light.intensity",
      "light.radius",
      "light.exponent",
      "light.exponentTip",
      "light.color",
      "light.lane.v1",
      "light.lane.legacy",
      "light.bad",
      "camera.fov",
      "camera.fovTip",
      "camera.zoom",
      "camera.zoomTip",
      "camera.hint",
      "camera.bad",
    ];
    const missingLc = lcKeys.filter((k) => (i18nSrc.match(new RegExp(`"${k.replace(/\./g, "\\.")}":`, "g")) ?? []).length !== 2);
    check(missingLc.length === 0, `light / camera 文案中英文都有、每个键恰好出现 2 次（缺 ${json(missingLc)}）`);
    check(/light\.typeTip[\s\S]{0,200}?V1/.test(i18nSrc) && /lightconfig/.test(i18nSrc), "灯类型说明写明「^l 前缀走 V1 通道、按 lightconfig 限槽、两条衰减公式不同」");
    check(/objp\.n\.parallaxdepth": "[^"]*组级/.test(i18nSrc) && /objp\.n\.solid": "[^"]*Solid/.test(i18nSrc), "parallaxDepth 的「只对组/父级生效」与 solid 的「鼠标事件只对 Solid 生效」写在文案里");
  }

  // ---- 引擎侧对照：灯 / 相机的解析分支确实在（口径来源）----
  {
    const parseSrc = fs.readFileSync(path.join(ROOT, "renderer/vendor/we-scene/scene/parse.js"), "utf8");
    const engineHits = [
      ["isLight: typeof o.light === 'string' && o.light !== ''", "isLight"],
      ["String(o.light || '').replace(/^l/, '')", "lightType 去掉 ^l 前缀"],
      ["lightLane: typeof o.light === 'string' && /^l/.test(o.light) ? 'v1' : 'legacy',", "lightLane 通道判定"],
      ["lightRadius: parseNum(", "radius 缺省 1000"],
      ["intensity: parseNum(", "intensity"],
      ["exponent: parseNum(", "exponent"],
      ["isCamera: typeof o.camera === 'string' && o.camera !== ''", "isCamera"],
      ["cameraFov: parseNum(", "cameraFov"],
    ];
    const missHits = engineHits.filter(([lit]) => !parseSrc.includes(lit)).map(([, name]) => name);
    check(missHits.length === 0, `灯 / 相机的引擎解析分支逐条对得上（${missHits.join(" / ") || "ok"}）`);
    const mathSrc = fs.readFileSync(path.join(ROOT, "renderer/vendor/we-scene/render/math.js"), "utf8");
    check(/rc\.fov > 0 \? rc\.fov : numField\(general\.fov, 50\)/.test(mathSrc), "引擎相机缺省：fov ≤ 0 时用 general.fov 或 50（与 camera.fovTip 一致）");
  }

  console.log("  （headless：点「添加灯光层」→ 图层树出现 light → 改 intensity 出帧变；见本段头注）");
}

// M12. 引擎写测：增量装配（B1 / W2b）、GL overlay 通道（B2 / W5）、
//      单脚本沙箱热替换（B3 / W8）—— 全部离线可跑，不需要浏览器。
//
// 这三项的引擎落点都在 renderer/src/scene-mount.ts 那个大 async 闭包里，
// 离线拿不到；所以把可判的语义拆成纯模块（layer-order / overlay / overlay-gl /
// script-slot），这里用真模块真跑 + 接线文本断言两层盖住：
//   - 纯模块：数组手术后数组逐位是什么、线段几何逐位是什么、转发句柄的熔断语义；
//   - 接线：scene-mount 必须真的用它们（不允许长回内联副本）。
// 出帧 A/B 属真浏览器判据，在 verify-editor-headless.mjs 的 M12 段。
// ───────────────────────────────────────────────────────────────────────────
{
  section("M12. 引擎写测：增量装配 / GL overlay 通道 / 单脚本沙箱热替换");

  // ── B1 / W2b：图层数组手术（数组顺序即绘制顺序，末尾在最上层） ──
  const lo = await imp("renderer/src/editor/layer-order.ts");
  const L = (...ids) => ids.map((id) => ({ id, name: `L${id}` }));
  const order = (a) => lo.layerIdOrder(a).join(",");

  {
    const a = L(1, 2, 3);
    check(
      lo.insertLayerAt(a, { id: 9 }, 1) === 1 && order(a) === "1,9,2,3",
      "M12/B1 insertLayerAt 中间插入：返回落点下标，数组序就是绘制序",
    );
    lo.insertLayerAt(a, { id: 8 }, 0);
    check(order(a) === "8,1,9,2,3", "M12/B1 插入位 0 = 最先画（最底）");
    lo.insertLayerAt(a, { id: 7 }, 99);
    check(order(a) === "8,1,9,2,3,7", "M12/B1 越界插入位夹到末尾（最后画 = 最上）");
    check(
      lo.clampInsertIndex(a, -5) === 0 && lo.clampInsertIndex(a, 99) === a.length,
      "M12/B1 clampInsertIndex 一律夹到 [0, length]（不拒绝，页面不用自己算边界）",
    );
  }
  {
    const a = L(1, 2, 3);
    const d = lo.detachLayer(a, 2);
    check(
      !!d && d.index === 1 && d.layer.id === 2 && order(a) === "1,3",
      "M12/B1 detachLayer 摘除并回报原下标（幂等撤销要用它）",
    );
    check(lo.detachLayer(a, 99) === null, "M12/B1 detachLayer 找不到返回 null");
    const tomb = [...L(4, 5), { id: 5, destroyed: true }];
    check(lo.layerIndexOf(tomb, 5) === 1, "M12/B1 id 撞上墓碑层时命中活跃层（destroyed 不算数）");
    check(lo.layerIdOrder(tomb).join(",") === "4,5", "M12/B1 墓碑层不进结构快照");
    check(lo.layerIndexOf(tomb, 6) === -1, "M12/B1 不存在的 id 返回 -1");
  }
  {
    const a = L(1, 2, 3, 4);
    check(lo.moveLayerTo(a, 4, 0) === 0 && order(a) === "4,1,2,3", "M12/B1 moveLayerTo 往下搬：先摘后插");
    check(lo.moveLayerTo(a, 4, 2) === 1 && order(a) === "1,4,2,3", "M12/B1 moveLayerTo 往上搬");
    check(
      lo.moveLayerTo(a, 4, 1) === null && order(a) === "1,4,2,3",
      "M12/B1 目标位与现状等价时空操作返回 null（画面零变化，可跳过出帧）",
    );
    check(lo.moveLayerTo(a, 42, 0) === null, "M12/B1 moveLayerTo 找不到返回 null");
    check(lo.shiftLayer(a, 1, +1) === 1 && order(a) === "4,1,2,3", "M12/B1 shiftLayer +1 = 在数组里往后挪一位（画得更靠上）");
    check(
      lo.shiftLayer(a, 4, -1) === null && lo.shiftLayer(a, 4, +1) === 1,
      "M12/B1 shiftLayer 到底返回 null，到顶仍有位",
    );
  }
  {
    // reorderLayer 对外收的是**目标下标**（同一个数在 moveLayerTo 那个「插入位」口径下差 1，
    // 页面的「上移 / 下移一层」也按下标算，所以这两个口径必须都在判据里钉住）。
    const a = L(1, 2, 3, 4);
    check(lo.moveLayerToIndex(a, 1, 2) === 2 && order(a) === "2,3,1,4", "M12/B1 moveLayerToIndex 往下搬到目标下标（不是插入位）");
    check(lo.moveLayerToIndex(a, 1, 0) === 0 && order(a) === "1,2,3,4", "M12/B1 moveLayerToIndex 往上搬回原位");
    check(lo.moveLayerToIndex(a, 4, 3) === null && order(a) === "1,2,3,4", "M12/B1 目标下标 = 现状时空操作返回 null（不产生无谓出帧）");
    check(
      lo.moveLayerToIndex(a, 1, 4) === 3 && order(a) === "2,3,4,1" && lo.moveLayerToIndex(a, 1, 99) === null,
      "M12/B1 目标下标越界夹到末位（= length 这一档就是「搬到最上」；已经在末位才是空操作）",
    );
    check(lo.moveLayerToIndex(a, 42, 0) === null && lo.moveLayerToIndex(a, 1, NaN) === null, "M12/B1 moveLayerToIndex 找不到 / 非数字下标一律拒绝");
    check(
      JSON.stringify(lo.layerIdOrder(a)) === JSON.stringify(["2", "3", "4", "1"]),
      "M12/B1 目标下标口径下的最终绘制序（末位 = 最后画 = 最上）",
    );
  }
  {
    // 环 + 未知 id：删层收子树绝不能死循环，也不能误伤别的层
    const a = [
      { id: 1, childIds: [2, 3] },
      { id: 2, childIds: [4] },
      { id: 3, childIds: null },
      { id: 4, childIds: [2] },
      { id: 5, childIds: [1] },
    ];
    const sub = lo.collectSubtreeIds(a, 1).map(String);
    check(
      sub[0] === "1" && sub.length === 4 && new Set(sub).size === 4,
      "M12/B1 collectSubtreeIds 收整棵子树 + 去重（childIds 成环不死循环）",
    );
    check(lo.collectSubtreeIds(a, 3).join(",") === "3", "M12/B1 叶子层子树只含自身");
    check(lo.collectSubtreeIds(a, 99).join(",") === "99", "M12/B1 未知 id 的子树只有它自己（不误伤）");
    check(!lo.collectSubtreeIds(a, 1).map(String).includes("5"), "M12/B1 子树只沿 childIds 向下，不扫旁支");
  }

  // ── B2 / W5：overlay 几何（2D 回退与 GL pass 吃同一份线段） ──
  const ov = await imp("renderer/src/editor/overlay.ts");
  {
    check(
      ov.normalizeOverlayMode("off") === "off" &&
        ov.normalizeOverlayMode("2d") === "2d" &&
        ov.normalizeOverlayMode("gl") === "gl",
      "M12/B2 normalizeOverlayMode 认三个后端值",
    );
    check(
      ov.normalizeOverlayMode("webgl") === "2d" && ov.normalizeOverlayMode(undefined) === "2d",
      "M12/B2 非法 / 缺省一律回落 2d（页面现有行为不变）",
    );
    check(ov.normalizeOverlayMode(null, "off") === "off", "M12/B2 缺省值可覆盖（视频工程用 off）");
  }
  {
    const corners = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    const quad = ov.outlineSegments({ corners });
    check(ov.segmentCount(quad) === 4 && quad.length === 16, "M12/B2 四边形闭合折线 → 4 条 GL_LINES");
    check(
      quad[0] === 0 && quad[1] === 0 && quad[2] === 10 && quad[3] === 0,
      "M12/B2 线段顺序 = 折线顺序，坐标原样透传（CSS 像素、y 向下，翻转留给 GLSL）",
    );
    const last = quad.length - 4;
    check(
      quad[last] === 0 && quad[last + 1] === 10 && quad[last + 2] === 0 && quad[last + 3] === 0,
      "M12/B2 末段回到起点（闭合）",
    );
    const hull = [
      [1, 1],
      [9, 1],
      [9, 9],
    ];
    const byHull = ov.outlineSegments({ corners, hull });
    check(ov.segmentCount(byHull) === 3 && byHull[0] === 1 && byHull[1] === 1, "M12/B2 hull 优先于 corners（透视场景口径）");
    check(
      ov.segmentCount(ov.outlineSegments(null)) === 0 && ov.segmentCount(ov.outlineSegments({ corners: null })) === 0,
      "M12/B2 无轮廓 → 空数组（引擎不画，页面照旧）",
    );
    check(
      ov.segmentCount(ov.outlineSegments({ corners, hull: [[Number.NaN, 1]] })) === 4,
      "M12/B2 脏点过滤后仍能用 corners（hull 非法不吞掉轮廓）",
    );
  }
  {
    const g = ov.gizmoSegments([100, 50], 6);
    check(ov.segmentCount(g) === 18, "M12/B2 手柄 = 4 个角柄（各 4 段）+ 中心十字（2 段）");
    const b = ov.segmentsBounds(g);
    check(
      !!b && b.minX <= 100 - 18 && b.maxX >= 100 + 18 && b.minY <= 50 - 18 && b.maxY >= 50 + 18,
      "M12/B2 手柄落在锚点周围（十字臂 3*size、角柄偏 2*size）",
    );
    check(ov.segmentCount(ov.gizmoSegments([1, 2], 0)) === 0, "M12/B2 size<=0 不画手柄");
    check(ov.segmentCount(ov.gizmoSegments(null, 6)) === 0, "M12/B2 无锚点不画手柄");
    check(ov.segmentsBounds(new Float32Array(0)) === null, "M12/B2 空线段没有包围盒");
  }
  {
    const outline = {
      anchor: [5, 6],
      corners: [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ],
    };
    const only = ov.overlaySegments(outline, { gizmo: false });
    const both = ov.overlaySegments(outline, { gizmo: true, gizmoSize: 6 });
    const wantOnly = ov.outlineSegments(outline);
    check(
      only.length === wantOnly.length && only.every((v, i) => v === wantOnly[i]),
      "M12/B2 gizmo:false 时输出与轮廓逐位一致（2D 回退口径）",
    );
    check(
      both.length === only.length + ov.gizmoSegments([5, 6], 6).length,
      "M12/B2 gizmo:true 时是「轮廓 + 手柄」的拼接",
    );
    check(
      only.every((v, i) => both[i] === v),
      "M12/B2 拼接把轮廓放在前缀且逐位不变（A/B 差分只落在手柄那一段）",
    );
    check(
      ov.segmentCount(ov.overlaySegments(null, { gizmo: true })) === 0 &&
        ov.segmentCount(ov.overlaySegments({ anchor: [1, 1] })) === 0,
      "M12/B2 只有锚点没有轮廓时 gizmo:false 不画（与页面 select 高亮口径一致）",
    );
    check(
      ov.segmentCount(ov.overlaySegments({ anchor: [1, 1] }, { gizmo: true })) === 18,
      "M12/B2 轮廓被裁掉但锚点还在时手柄仍画（子层被父级裁掉也要能拖）",
    );
  }

  // ── B2：真 GL pass（记账用的假 GL：只记调用，不真开上下文） ──
  const glmod = await imp("renderer/src/editor/overlay-gl.ts");
  {
    const failPass = glmod.createOverlayPass(null);
    check(!failPass.ok && failPass.reason === "no-gl", "M12/B2 没有 GL 上下文时 pass.ok=false、reason=no-gl");
    check(
      failPass.draw(new Float32Array([0, 0, 1, 1]), { width: 10, height: 10 }) === 0 && failPass.frames === 0,
      "M12/B2 pass 不可用时 draw 恒返回 0（调用方走 2D 回退，不抛错）",
    );
    failPass.dispose();

    const MAINPROG = { kind: "main-program" };
    const MAINBUF = { kind: "main-buffer" };
    const C = {
      VERTEX_SHADER: 1,
      FRAGMENT_SHADER: 2,
      COMPILE_STATUS: 3,
      LINK_STATUS: 4,
      CURRENT_PROGRAM: 10,
      ARRAY_BUFFER_BINDING: 11,
      DEPTH_TEST: 20,
      BLEND: 21,
      SCISSOR_TEST: 22,
      CULL_FACE: 23,
      FRAMEBUFFER: 30,
      ARRAY_BUFFER: 31,
      DYNAMIC_DRAW: 32,
      FLOAT: 33,
      LINES: 34,
    };
    const nameOf = (k) => Object.keys(C).find((n) => C[n] === k);
    const st = {
      compiled: 0,
      linked: 0,
      program: MAINPROG,
      buffer: MAINBUF,
      enabled: new Set(["DEPTH_TEST", "BLEND", "CULL_FACE"]),
      viewports: [],
      bufferDatas: [],
      uniforms: {},
      attribPointer: null,
      draws: [],
      deleted: { shader: 0, buffer: 0, program: 0 },
    };
    const gl = { ...C, drawingBufferWidth: 1280, drawingBufferHeight: 720 };
    gl.createShader = () => ({ kind: "shader" });
    gl.shaderSource = () => {};
    gl.compileShader = () => {
      st.compiled++;
    };
    gl.getShaderParameter = () => true;
    gl.getShaderInfoLog = () => "";
    gl.deleteShader = () => {
      st.deleted.shader++;
    };
    gl.createProgram = () => ({ kind: "program" });
    gl.attachShader = () => {};
    gl.linkProgram = () => {
      st.linked++;
    };
    gl.getProgramParameter = () => true;
    gl.getProgramInfoLog = () => "";
    gl.getAttribLocation = () => 0;
    gl.getUniformLocation = () => ({ kind: "uniform" });
    gl.createBuffer = () => ({ kind: "buffer" });
    gl.deleteBuffer = () => {
      st.deleted.buffer++;
    };
    gl.deleteProgram = () => {
      st.deleted.program++;
    };
    gl.getParameter = (k) => (k === C.CURRENT_PROGRAM ? st.program : st.buffer);
    gl.isEnabled = (k) => st.enabled.has(nameOf(k));
    gl.bindFramebuffer = () => {};
    gl.viewport = (x, y, w, h) => st.viewports.push([x, y, w, h]);
    gl.disable = (k) => st.enabled.delete(nameOf(k));
    gl.enable = (k) => st.enabled.add(nameOf(k));
    gl.useProgram = (p) => {
      st.program = p;
    };
    gl.bindBuffer = (_t, b) => {
      st.buffer = b;
    };
    gl.bufferData = (_t, data) => st.bufferDatas.push(data);
    gl.enableVertexAttribArray = () => {};
    gl.vertexAttribPointer = (...a) => {
      st.attribPointer = a;
    };
    gl.uniform2f = (_l, a, b) => {
      st.uniforms.uViewport = [a, b];
    };
    gl.uniform1f = (_l, a) => {
      st.uniforms.uDepth = a;
    };
    gl.uniform4f = (_l, ...c) => {
      st.uniforms.uColor = c;
    };
    gl.drawArrays = (mode, first, count) => st.draws.push({ mode, first, count });

    const pass = glmod.createOverlayPass(gl);
    check(pass.ok && pass.reason === "" && pass.frames === 0, "M12/B2 假 GL 下 pass 建立成功（着色器编译 + 链接一次）");
    check(st.compiled === 2 && st.linked === 1, "M12/B2 顶点 / 片元着色器各编一次、程序链一次（不每次 draw 重建）");

    check(
      pass.draw(new Float32Array(0), { width: 320, height: 180 }) === 0 &&
        pass.draw(new Float32Array([1, 2]), { width: 320, height: 180 }) === 0 &&
        pass.draw(new Float32Array([0, 0, 1, 1]), { width: 0, height: 0 }) === 0 &&
        st.draws.length === 0 &&
        pass.frames === 0,
      "M12/B2 空线段 / 退化 viewport 一律不 draw（不影响主渲染那一帧）",
    );

    const seg = new Float32Array([0, 0, 10, 0, 10, 0, 10, 10, 10, 10, 0, 10, 0, 10, 0, 0]);
    const n = pass.draw(seg, { width: 320, height: 180 });
    check(n === 4 && pass.frames === 1, "M12/B2 draw 返回实际提交的线段数，frames 自增");
    check(
      st.draws.length === 1 && st.draws[0].mode === C.LINES && st.draws[0].first === 0 && st.draws[0].count === 8,
      "M12/B2 一次 drawArrays(LINES, 0, 顶点数) 交完（顶点数 = 浮点长度/2）",
    );
    check(
      st.viewports.length === 1 && st.viewports[0][2] === 1280 && st.viewports[0][3] === 720,
      "M12/B2 viewport 用 drawingBuffer 的设备像素口径（DPR 仍在它身上）",
    );
    check(
      !!st.uniforms.uViewport && st.uniforms.uViewport[0] === 320 && st.uniforms.uViewport[1] === 180,
      "M12/B2 线段坐标按 CSS 像素交给 shader 换算（几何口径与 2D canvas 一致）",
    );
    check(
      st.uniforms.uDepth === 0 && Array.isArray(st.uniforms.uColor) && st.uniforms.uColor.length === 4,
      "M12/B2 深度与颜色走 uniform（默认 z=0、琥珀色）",
    );
    check(
      st.program === MAINPROG && st.buffer === MAINBUF,
      "M12/B2 画完把主渲染的 program / ARRAY_BUFFER 绑定原样放回",
    );
    check(
      st.enabled.has("DEPTH_TEST") &&
        st.enabled.has("BLEND") &&
        st.enabled.has("CULL_FACE") &&
        !st.enabled.has("SCISSOR_TEST"),
      "M12/B2 画完把 DEPTH_TEST / BLEND / CULL_FACE 还原（overlay 自己关的开关不留到下一帧）",
    );
    check(
      !!st.attribPointer && st.attribPointer[1] === 2 && st.attribPointer[2] === C.FLOAT && st.attribPointer[5] === 0,
      "M12/B2 顶点属性 2 分量 float、stride/offset 为 0",
    );

    pass.draw(seg, { width: 320, height: 180 });
    check(st.compiled === 2 && st.linked === 1 && pass.frames === 2, "M12/B2 第二次 draw 不重新编译着色器（每帧成本只有一次 drawArrays）");

    pass.dispose();
    check(
      st.deleted.shader === 2 && st.deleted.buffer === 1 && st.deleted.program === 1,
      "M12/B2 dispose 释放两个 shader / 一个 buffer / 一个 program",
    );
    const before = st.draws.length;
    check(pass.draw(seg, { width: 320, height: 180 }) === 0 && st.draws.length === before, "M12/B2 dispose 之后 draw 成为空操作（切回 2D 不抛错）");
    pass.dispose();
    check(st.deleted.shader === 2, "M12/B2 重复 dispose 幂等");
  }

  // ── B3 / W8：单脚本沙箱热替换（转发句柄 + 熔断状态跟着新沙箱） ──
  const slotMod = await imp("renderer/src/editor/script-slot.ts");
  const wtextMod = await imp("renderer/vendor/we-scene/render/text.js");
  {
    // 负对照：Object.assign 式的「热替换」为什么不行 —— 沙箱内部对
    // sandbox.disabled 的写入落在**新沙箱自己**身上，宿主读的旧句柄永远是 false。
    const a = wtextMod.evalObjectScript("export function update(v) { throw new Error('boom') }", {}, {});
    const naive = Object.assign({}, a);
    for (let i = 0; i < 3; i++) naive.callUpdate(1);
    check(
      !!a && a.disabled === true && naive.disabled === false,
      "M12/B3 负对照：Object.assign 式热替换让宿主读到的 disabled 恒为 false（5 错熔断失效）—— 所以必须用转发句柄",
    );
  }
  {
    const registered = [];
    const activated = [];
    const cleared = [];
    let skipped = 0;
    const src = (mark) => `export function update(value) { return ${mark}; }`;
    const slot = slotMod.createScriptSlot({
      layer: { id: 7, name: "L7" },
      target: "origin",
      build: (code) => wtextMod.evalObjectScript(code, {}, {}),
      activate: (sb, first) => activated.push({ sb, first }),
      host: {
        register: (sb) => registered.push(sb),
        clearIssues: (id, t) => cleared.push(`${id}|${t}`),
        countSkipped: () => {
          skipped++;
        },
      },
    });
    check(!!slot.sandbox && slot.current === null, "M12/B3 挂点建好就先有稳定句柄（未换源码时指向停用态）");
    check(slot.sandbox.disabled === true, "M12/B3 未求值过的句柄读到停用态（登记表持有它也不会误跑）");

    check(slot.swap(src(1)) === true, "M12/B3 首次换源码成功");
    const held = slot.sandbox; // 装配期登记进各队列的那一份引用
    check(
      registered.length === 1 && registered[0] === held && activated.length === 1 && activated[0].first === true,
      "M12/B3 首次：先登记句柄再激活，且激活拿到的就是那份稳定句柄",
    );
    check(cleared.join(";") === "7|origin", "M12/B3 换源码时按「图层|挂点」撤掉上一代结构化报错");
    check(held.disabled === false && held.hasUpdate === true && held.callUpdate(0) === 1, "M12/B3 换源码后句柄立刻指向新一代求值结果");

    check(slot.swap("export function update(v) { throw new Error('boom') }") === true, "M12/B3 换成每帧抛错的脚本");
    for (let i = 0; i < 3; i++) held.callUpdate(1);
    check(held.disabled === true && held.errCount >= 3, "M12/B3 5 错上限语义：逐帧抛错累计后熔断，且宿主持有的旧引用**当场读到** disabled=true");

    check(slot.swap(src(2)) === true, "M12/B3 熔断后再热替换一次");
    check(
      held.disabled === false && held.errCount === 0,
      "M12/B3 换源码后熔断状态跟着新沙箱重新起算（旧引用读到的也是新状态）",
    );
    check(
      held.callUpdate(0) === 2 && held.hasUpdate === true,
      "M12/B3 旧引用调到的是**新实现**（函数每次调用重新解析，登记表一个都不用改）",
    );
    check(
      registered.length === 1 && activated.length === 3 && activated[2].first === false,
      "M12/B3 只有首次登记（identity 不变），后续替换只走激活且 first=false",
    );
    check(cleared.length === 3, "M12/B3 每次成功替换都清一次该挂点的旧报错");

    const goodRef = held.callUpdate(0);
    check(slot.swap("export function update(v) {") === false, "M12/B3 编不过的源码 swap 返回 false");
    check(slot.current !== null && held.callUpdate(0) === goodRef, "M12/B3 编不过时旧沙箱保持不动（字段仍按上一版求值）");
    check(slot.swap("const x = 1;") === false, "M12/B3 没有可派发 export 的源码同样拒绝");
    check(skipped === 2, "M12/B3 拒绝的挂点按装配期同一口径计入 skippedScripts");
    check(activated.length === 3, "M12/B3 拒绝时不激活、不登记（登记表不变）");
    check(
      slot.swap("") === false && skipped === 2,
      "M12/B3 空串走引擎的 skipped 口径（纯空白由 setLayerScript 归一成「摘挂点」，不到这一层）",
    );

    // 停用：拆层时把 current 置空，已登记的引用必须整体转为 no-op 而不是抛错
    slot.current = null;
    check(
      held.disabled === true &&
        held.callUpdate(1) === undefined &&
        held.callCursor(1, 2) === undefined &&
        held.callMedia("x", {}) === undefined &&
        held.callResize() === undefined,
      "M12/B3 拆层后 same 句柄转停用态：所有回调 no-op、不抛 TypeError",
    );
    let threw = false;
    try {
      held.engine.runtime = 1;
      held.applyUserProperties({});
    } catch {
      threw = true;
    }
    check(!threw, "M12/B3 停用态下宿主每帧的 engine 回填 / 属性套用都不炸");

    // 停用（等价于 setLayerScript 传空串 ⇒ current = null）之后再挂新脚本：
    // `first` 又会是 true，但稳定句柄**不许**第二次进登记表 ——
    // 否则 propSandboxes 里同一沙箱被逐帧回填 / 属性热更跑两遍。
    check(held.disabled === true && slot.swap(src(3)) === true, "M12/B3 停用之后可以重新挂上脚本");
    check(
      registered.length === 1,
      "★ M12/B3 重新挂脚本不再登记第二次（登记按稳定句柄一次性完成；实测 registered=" + registered.length + "）",
    );
    check(held.disabled === false && held.callUpdate(0) === 3, "M12/B3 重新挂上的是新一代实现（旧引用仍指向它）");
  }

  {
    // ── B3 补：热替换登记去重的纯函数（同一挂点只留最新一条） ──
    const list = [{ k: "a", v: 1 }, { k: "b", v: 2 }];
    check(
      slotMod.upsertRun(list, (x) => x.k === "a", { k: "a", v: 3 }) === true,
      "M12/B3 upsertRun：命中旧挂点时替换并返回 true（热替换）",
    );
    check(
      list.length === 2 && list[1].k === "a" && list[1].v === 3 && list[0].k === "b",
      "M12/B3 upsertRun：旧条目摘掉、新条目落在队列末尾，其它条目顺序不变",
    );
    check(
      slotMod.upsertRun(list, (x) => x.k === "zz", { k: "c", v: 4 }) === false && list.length === 3,
      "M12/B3 upsertRun：没有旧挂点时返回 false（首次登记）",
    );
    const dup = [{ k: "a", v: 1 }, { k: "a", v: 2 }, { k: "b", v: 5 }];
    slotMod.upsertRun(dup, (x) => x.k === "a", { k: "a", v: 9 });
    check(
      dup.length === 2 && dup[0].k === "b" && dup[1].v === 9,
      "M12/B3 upsertRun：已经重复的登记也能收敛成一条（倒序摘除不留半份）",
    );
  }

  // ── 接线断言：引擎侧必须真用这些纯模块（不允许长回内联副本） ──
  {
    const smSrc = fs.readFileSync(path.join(ROOT, "renderer/src/scene-mount.ts"), "utf8");
    const slotSrc = fs.readFileSync(path.join(ROOT, "renderer/src/editor/script-slot.ts"), "utf8");
    check(
      smSrc.includes("from \"./editor/layer-order\"") &&
        smSrc.includes("from \"./editor/overlay\"") &&
        smSrc.includes("from \"./editor/overlay-gl\"") &&
        smSrc.includes("from \"./editor/script-slot\""),
      "M12 接线：scene-mount 从四个纯模块取实现（结构手术 / 几何 / GL pass / 脚本挂点）",
    );
    check(
      /const slot = makeScriptSlot\(\s*layer,\s*"text",/.test(smSrc) &&
        /const slot = makeScriptSlot\(\s*layer,\s*`effects\[\$\{ei\}\]\.visible`,/.test(smSrc) &&
        /const slot = makeScriptSlot\(\s*layer,\s*field,/.test(smSrc) &&
        smSrc.includes("setLayerScript(id: number | string, target: string, code: string)"),
      "M12/B3 接线：文字 / effects[i].visible / 对象字段三类挂点都走同一套热替换挂点，并有 setLayerScript 出口",
    );
    check(
      smSrc.includes("const slot = editorScriptSlots.find((s) => s.layer === l && s.target === target)") &&
        smSrc.includes("slot.swap(text)") &&
        smSrc.includes("slot.current = null;"),
      "M12/B3 setLayerScript 按「图层 + 挂点」找槽位并只换这一代求值结果（不重挂场景）",
    );
    check(
      smSrc.includes("createScriptSlot({ layer, target, build, activate, host: scriptsOff ? slotHostNoCount : scriptSlotHost })") &&
        smSrc.includes("register: (sb) => propSandboxes.push(sb)"),
      "M12/B3 接线：宿主只提供登记 / 撤报错 / 计跳过三件事，沙箱仍在引擎侧求值",
    );
    check(
      smSrc.includes("const slotHostNoCount: ScriptSlotHost = { ...scriptSlotHost, countSkipped: () => {} };"),
      "★ 关脚本时槽位不再重复计一次拦截（skipScript 已计；否则同一段脚本提示成「2 段脚本」）",
    );
    check(
      /const makeScriptSlot = \([\s\S]*?editorScriptSlots\.push\(slot\);[\s\S]*?return slot;/.test(smSrc) &&
        smSrc.includes("editorScriptSlots.find((s) => s.layer === l && s.target === target)"),
      "★ M12/B3 接线：槽位在 makeScriptSlot 里统一登记 —— 三个挂点都进 editorScriptSlots，setLayerScript 才找得到（否则整条 API 恒 reject）",
    );
    check(
      /upsertRun\(\s*effectVisibleRuns,/.test(smSrc) &&
        /upsertRun\(\s*objectScriptRuns,/.test(smSrc) &&
        /upsertRun\(\s*list,/.test(smSrc) &&
        smSrc.includes("upsertRun(list, (s: any) => s === sandbox, sandbox)"),
      "★ M12/B3 接线：逐帧效果开关队列 / 对象字段队列 / animationEvent 广播表 / 指针回调表都走 upsertRun 去重（热替换不再让同一脚本跑两遍）",
    );
    check(
      smSrc.includes("const deadSandboxes = new Set<any>();") &&
        /for \(let i = propSandboxes\.length - 1; i >= 0; i--\) if \(deadSandboxes\.has\(propSandboxes\[i\]\)\)/.test(smSrc) &&
        /for \(const k of \[\.\.\.animEventSinks\.keys\(\)\]\) if \(ids\.has\(\(k as any\)\?\.id\)\) animEventSinks\.delete\(k\);/.test(smSrc),
      "★ M12/B3 接线：拆层时把被删层的稳定句柄从 propSandboxes / mediaHooks / resizeHooks 摘掉，并按图层清 animationEvent 广播表",
    );
    check(
      /if \(ids\.has\(lid === "null" \? null : Number\(lid\)\)\) scriptIssues\.delete\(k\);/.test(smSrc),
      "★ M12/B3 接线：非数字 id 的层（键前缀 null|）热删后结构化报错也一起清（以前整类跳过，面板上留幽灵报错）",
    );
    check(
      !/\bnew Function\b|\beval\s*\(/.test(slotSrc),
      "M12/B3 安全边界：script-slot 不自己求值（transform / 形参表 / 严格模式仍由引擎沙箱唯一提供）",
    );
    check(
      smSrc.includes("const textEnv = () => (") &&
        smSrc.includes("const makeEnv = () => (") &&
        smSrc.includes("const activateObjectScript = (sandbox: any) =>") &&
        smSrc.includes("const activateEffectVisible = (sandbox: any) =>"),
      "M12/B3 接线：三处挂点都是「同一份 env 工厂 + 具名激活函数」，与首次装配共用一条路径",
    );
    check(
      smSrc.includes("const sceneJsonRaw = JSON.parse(readText(sceneEntry)) as Record<string, unknown>") &&
        smSrc.includes("scn.parseScene(sceneJsonRaw, project)"),
      "M12/B1 接线：单对象重解析复用装配期读到的 scene.json 原文",
    );
    check(
      smSrc.includes("addLayer(spec: EditorLayerAddSpec): Promise<EditorLayer>") &&
        smSrc.includes("removeLayer(id: number | string): Promise<void>") &&
        smSrc.includes("reorderLayer(id: number | string, toIndex: number): Promise<void>") &&
        smSrc.includes("canHotAddLayer(spec: EditorLayerAddSpec): EditorHotAddCheck") &&
        smSrc.includes("setOverlayMode(mode: EditorOverlayMode): Promise<EditorOverlayMode>") &&
        smSrc.includes("getOverlayStats(): EditorOverlayStats") &&
        smSrc.includes("setOverlayTarget(id: number | string | null)"),
      "M12 接线：EditorControls 面暴露增量装配与 overlay 后端切换",
    );
    const editorSrc = fs.readFileSync(path.join(ROOT, "renderer/src/api/editor.ts"), "utf8");
    check(
      ["EditorLayerAddSpec", "EditorHotAddCheck", "EditorOverlayMode", "EditorOverlayStats"].every((n) =>
        editorSrc.includes(n),
      ),
      "M12 出口：四个新公开类型都从 renderer/src/api/editor 出去（页面不许 import 深层实现）",
    );
  }
}

// ───────────────────────────────────────────────────────────────────────────
// DRAFT-2. 未保存文档找回（计划 §2 C3）+ 自动保存前提（§2 C6）：快照往返、分槽、
//          容量淘汰、坏快照容错、与 vdir 键不冲突、恢复交互接线、中英文各一条
// ───────────────────────────────────────────────────────────────────────────
section("DRAFT-2. 未保存编辑找回（draft.ts 存储 + 恢复横幅 + 自动保存目标）");
{
  const vdirMod = await loadEditorModule("vdir");
  const recMod = await loadEditorModule("recover");
  const drPath = path.join(ROOT, "editor/draft.ts");
  const drSrc = fs.readFileSync(drPath, "utf8");
  const drMain = fs.readFileSync(path.join(ROOT, "editor/main.ts"), "utf8");
  const drHtml = fs.readFileSync(path.join(ROOT, "editor/index.html"), "utf8");
  const drCss = fs.readFileSync(path.join(ROOT, "editor/editor.css"), "utf8");
  const drI18n = fs.readFileSync(path.join(ROOT, "editor/i18n.ts"), "utf8");

  // ---- 快照往返：编码 → 解码，逐字段一致（重开编辑器后 JSON.parse+stringify 一致）----
  const dDoc = freshDoc();
  const dFiles = [
    { name: "materials/editor/k.png", group: "models/editor/k.json", data: new Uint8Array([1, 2, 3, 250]) },
    { name: "scene.json", data: new Uint8Array([0, 127, 255]) },
  ];
  const snap = draftMod.makeDraft(dDoc, { kind: "virtual", id: "vdir-demo-1" }, "scene.json", dFiles, 777);
  const wire = draftMod.encodeDraft(snap);
  const back = draftMod.decodeDraft(wire);
  check(back !== null && json(back) === json(snap), "快照往返：encode → decode 与原件逐字段一致（标题 / 来源 / 场景 / 文件表）");
  check(back.files[0].data instanceof Uint8Array && Buffer.compare(Buffer.from(back.files[0].data), Buffer.from([1, 2, 3, 250])) === 0,
    "文件字节仍是 Uint8Array，且逐字节一致（base64 往返不变形）");
  check(back.files[0].group === "models/editor/k.json" && back.files[1].group === undefined,
    "文件分组（group）也照样带回来，没有的键不会被写成 null");
  const bigBytes = new Uint8Array(70000);
  for (let i = 0; i < bigBytes.length; i++) bigBytes[i] = (i * 31) % 251;
  const bigSnap = draftMod.makeDraft(dDoc, { kind: "local", name: "我的壁纸" }, "scene.json", [{ name: "big.bin", data: bigBytes }], 1);
  const bigBack = draftMod.decodeDraft(draftMod.encodeDraft(bigSnap));
  check(bigBack !== null && Buffer.compare(Buffer.from(bigBack.files[0].data), Buffer.from(bigBytes)) === 0,
    "超过 btoa 分块阈值（0x8000）的字节也完整往返");

  // ---- 存进存储再取回：同一后端上分槽互不覆盖 ----
  const be = vdirMod.memoryVdirBackend();
  const store = draftMod.vdirDraftStore(be);
  check(draftMod.DRAFT_ID === "__draft__" && !/^vdir-/.test(draftMod.DRAFT_ID), "草稿用保留 id（不是 vdir 的工程 id 形状）");
  check(draftMod.draftSlotFor({ vdirId: "vdir-a" }) === "vdir:vdir-a"
    && draftMod.draftSlotFor({ libraryItemId: "beach" }) === "library:beach"
    && draftMod.draftSlotFor({ localName: "My Wall" }) === "local:My Wall"
    && draftMod.draftSlotFor({ vdirId: "vdir-a", libraryItemId: "beach" }) === "vdir:vdir-a"
    && draftMod.draftSlotFor({}) === draftMod.DRAFT_SLOT_SESSION,
    "槽名按工程标识算：虚拟工程 > 库条目 > 本地目录名；都没有就是会话槽（刷新后仍是同一槽）");
  // 审计 H1：会话文档（既没目录也没库条目）的槽必须带**每文档**标识，否则两个未命名文档
  // 共用常量槽 `session`：后一个的自动保存覆盖前一个的快照，另存为成功时还会把前一个的清掉
  check(draftMod.draftSlotFor({ sessionKey: "s1" }) === `${draftMod.DRAFT_SLOT_SESSION}:s1`
    && draftMod.draftSlotFor({ sessionKey: "s1" }) === draftMod.draftSlotFor({ sessionKey: "s1" })
    && draftMod.draftSlotFor({ sessionKey: "s2" }) !== draftMod.draftSlotFor({ sessionKey: "s1" })
    && draftMod.draftSlotFor({ sessionKey: "" }) === draftMod.DRAFT_SLOT_SESSION
    && draftMod.draftSlotFor({ vdirId: "vdir-a", sessionKey: "s1" }) === "vdir:vdir-a"
    && draftMod.draftSlotFor({ libraryItemId: "beach", sessionKey: "s1" }) === "library:beach"
    && draftMod.draftSlotFor({ localName: "My Wall", sessionKey: "s1" }) === "local:My Wall",
    "会话槽带每文档标识：两个未命名文档不共用槽，工程标识仍优先（审计 H1）");
  await store.save(snap, "vdir:vdir-demo-1");
  const loaded = await store.load("vdir:vdir-demo-1");
  check(loaded !== null && json(loaded) === json(snap), "存进存储再取回：与写入时的快照一致（重开编辑器后逐字段还原）");
  const other = draftMod.makeDraft(freshDoc(), { kind: "library", itemId: "beach" }, "scene.json", [], 888);
  await store.save(other, "library:beach");
  check((await store.load("vdir:vdir-demo-1")).origin.id === "vdir-demo-1" && (await store.load("library:beach")).origin.itemId === "beach",
    "分槽隔离：两个工程各读回自己那一份，互不覆盖");
  check(json((await store.list()).map((i) => i.slot)) === json(["library:beach", "vdir:vdir-demo-1"]), "list()：按时间降序，最新的排在前面");
  await store.clear("library:beach");
  check((await store.load("library:beach")) === null && (await store.load("vdir:vdir-demo-1")) !== null, "clear 只清自己那槽");
  // 审计 H1：两个会话文档的快照在同一后端上并存，互不覆盖（旧口径共用 `session` 槽会互相踩）
  const sesA = draftMod.makeDraft(freshDoc(), { kind: "new" }, "scene.json", [], 500);
  const sesB = draftMod.makeDraft(freshDoc(), { kind: "new" }, "scene.json", [], 600);
  const sesKeyA = draftMod.draftSlotFor({ sessionKey: "d-a" });
  const sesKeyB = draftMod.draftSlotFor({ sessionKey: "d-b" });
  await store.save(sesA, sesKeyA);
  await store.save(sesB, sesKeyB);
  check((await store.load(sesKeyA))?.savedAt === 500 && (await store.load(sesKeyB))?.savedAt === 600,
    "两个未命名文档的快照并存：后一个不再覆盖前一个（审计 H1）");
  await store.clear(sesKeyA);
  await store.clear(sesKeyB);

  // ---- 容量上限：槽数 / 总字节，淘汰最旧的，最新一条永远保留 ----
  const slotSnap = (now) => draftMod.makeDraft(freshDoc(), { kind: "new" }, "scene.json", [], now);
  const be2 = vdirMod.memoryVdirBackend();
  const store2 = draftMod.vdirDraftStore(be2, 2, draftMod.DRAFT_MAX_BYTES);
  await store2.save(slotSnap(100), "s1");
  await store2.save(slotSnap(200), "s2");
  await store2.save(slotSnap(300), "s3");
  check(json((await store2.list()).map((i) => i.slot)) === json(["s3", "s2"]),
    `容量上限（槽数 2）：最旧的一槽被淘汰，最新的保留（实得 ${json((await store2.list()).map((i) => i.slot))}）`);
  const be3 = vdirMod.memoryVdirBackend();
  const store3 = draftMod.vdirDraftStore(be3, 8, 8000);
  await store3.save(draftMod.makeDraft(freshDoc(), { kind: "new" }, "scene.json", [{ name: "huge.bin", data: new Uint8Array(12000) }], 1), "huge");
  await store3.save(slotSnap(2), "small");
  const kept3 = (await store3.list()).map((i) => i.slot);
  check(json(kept3) === json(["small"]) && (await store3.load("huge")) === null,
    `容量上限（总字节 8KB）：只有两槽也按字节淘汰最旧的（实得 ${json(kept3)}）`);
  const be4 = vdirMod.memoryVdirBackend();
  const store4 = draftMod.vdirDraftStore(be4, 8, draftMod.DRAFT_MAX_BYTES);
  await store4.save(draftMod.makeDraft(freshDoc(), { kind: "new" }, "scene.json", [{ name: "huge.bin", data: new Uint8Array(12000) }], 1), "huge");
  await store4.save(slotSnap(2), "small");
  check(json((await store4.list()).map((i) => i.slot)) === json(["small", "huge"]), "同一对快照在默认上限下两条都留着（上面那条是字节上限在起作用，不是写法问题）");
  const be5 = vdirMod.memoryVdirBackend();
  const store5 = draftMod.vdirDraftStore(be5, 1, 1);
  await store5.save(slotSnap(5), "only");
  check((await store5.load("only")) !== null, "上限压到最紧（1 槽 / 1 字节）也不会把刚存的那条淘汰掉（否则等于没存）");

  // ---- 坏快照容错：读出 null 且不抛 ----
  await be.write(draftMod.DRAFT_ID, "bad-json", new Blob(["not json"], { type: "application/json" }));
  await be.write(draftMod.DRAFT_ID, "trunc", new Blob([wire.slice(0, 40)], { type: "application/json" }));
  await be.write(draftMod.DRAFT_ID, "bad-b64", new Blob([json({ ...JSON.parse(wire), files: [{ name: "x", data: "@@@" }] })], { type: "application/json" }));
  const badReads = [];
  for (const s of ["bad-json", "trunc", "bad-b64", "nope"]) badReads.push(await store.load(s));
  check(badReads.every((v) => v === null), "坏快照（非 JSON / 截断 / base64 非法 / 根本没这槽）读出 null，不抛");
  const badList = await store.list();
  check(badList.some((i) => i.slot === "bad-json" && i.savedAt === 0) && badList.some((i) => i.slot === "vdir:vdir-demo-1"),
    "list()：坏快照当 savedAt=0 列出，不炸整张表（其余槽照旧可读）");
  check(draftMod.decodeDraft("") === null && draftMod.decodeDraft("{}") === null && draftMod.decodeDraft('{"v":1}') === null
    && draftMod.decodeDraft(json({ ...JSON.parse(wire), files: "x" })) === null
    && draftMod.decodeDraft(json({ ...JSON.parse(wire), scene: null })) === null,
    "decodeDraft：空串 / 形状不对 / files 不是数组 / 没有场景一律 null（库里的东西不可信）");
  check(draftMod.parseDraft({ ...snap, origin: { kind: "virtual" } }) === null && draftMod.parseDraft({ ...snap, origin: { kind: "local" } }) === null
    && draftMod.parseDraft({ ...snap, origin: { kind: "virtual", id: "vdir-x" } }) !== null,
    "parseDraft：新增的两种来源也必须带 id / name，缺了照样拒（旧版本的坏数据进不来）");

  // ---- 与 vdir 键不冲突：同一个后端上，草稿槽与工程文件互相看不见 ----
  const beV = vdirMod.memoryVdirBackend();
  const dirV = await vdirMod.createVirtualProject("演示工程", beV, 1000);
  const vdirId = vdirMod.virtualIdOf(dirV);
  const storeV = draftMod.vdirDraftStore(beV);
  await storeV.save(snap, draftMod.draftSlotFor({ vdirId }));
  check((await beV.listMeta()).length === 1 && (await vdirMod.listVirtualProjects(beV)).length === 1 && (await vdirMod.listVirtualProjects(beV))[0].id === vdirId,
    "草稿不写 vdir 的工程 meta：虚拟工程列表里不会多出一条假工程");
  check(vdirId !== draftMod.DRAFT_ID && json(await beV.keys(draftMod.DRAFT_ID)) === json([`vdir:${vdirId}`]),
    "草稿只落在保留 id 的文件键空间里，和工程 id 的键空间不重叠");
  await beV.write(vdirId, "scene.json", new Blob(["{}"], { type: "application/json" }));
  check((await storeV.load("session")) === null && (await storeV.load(`vdir:${vdirId}`)) !== null
    && json(await beV.keys(vdirId)) === json(["scene.json"]),
    "同一个后端上：草稿读不到工程文件，工程目录里也不会冒出草稿槽");
  const beDefault = vdirMod.memoryVdirBackend();
  vdirMod.setVdirBackend(beDefault);
  const storeDefault = draftMod.vdirDraftStore();
  await storeDefault.save(snap, "session");
  check((await storeDefault.load("session")) !== null, "vdirDraftStore() 默认取的就是 vdir 那一个后端（同一存储域，不是第二套 IndexedDB）");
  vdirMod.setVdirBackend(null);

  // ---- 节流与上限边界 ----
  check(draftMod.DRAFT_THROTTLE_MS === 1500 && draftMod.snapshotDue(0, 1499) === false && draftMod.snapshotDue(0, 1500) === true,
    "快照节流：1500ms 窗口的边界（400ms 编辑防抖之外再压一道，长按拖拽不反复序列化整份）");
  check(draftMod.snapshotDue(NaN, 1500) === true && draftMod.snapshotDue(0, NaN) === false, "时间戳不合法：没存过就写，时间读不出来就不写");
  check(recMod.RECOVER_MAX === 3, "RECOVER_MAX 仍是 3（草稿找回不另起一套上限）");
  check(recMod.allowRecover([], 1000) === true && recMod.allowRecover([1000, 1000], 1000) === true && recMod.allowRecover([1000, 1000, 1000], 1000) === false,
    "RECOVER_MAX 边界：第 3 次之后拒绝");
  const recStamps = [];
  check(recMod.allowRecover(recStamps, 0) === true && recStamps.length === 1, "允许的那次会记账（下一次才算数）");
  check(recMod.allowRecover([0, 0, 0], 61_000) === true, "60s 窗口外的旧记录不算数（卡死重开后又可以恢复）");

  // ---- 自动保存目标（§2 C6）：放宽到「本地文件夹 / 库来源也自动保存」 ----
  check(draftMod.autosaveTargetFor({ savable: true, hasDir: true, draftable: true, slot: null }) === "dir"
    && draftMod.autosaveTargetFor({ savable: true, hasDir: false, draftable: true, slot: "library:beach" }) === "draft"
    && draftMod.autosaveTargetFor({ savable: true, hasDir: false, draftable: true, slot: "session" }) === "draft"
    && draftMod.autosaveTargetFor({ savable: true, hasDir: false, draftable: false, slot: "session" }) === "none"
    && draftMod.autosaveTargetFor({ savable: false, hasDir: true, draftable: true, slot: "session" }) === "none"
    && draftMod.autosaveTargetFor({ savable: true, hasDir: false, draftable: true, slot: null }) === "none",
    "自动保存目标：可写文件夹 → 文件夹；库来源 / 目录不可写 → 草稿槽；快照装不下的文档（视频 / 网页）与真没内容的一律不写（页面必须提示）");

  // ---- 页面接线：一份 draft.ts + 两条横幅 + 分流落盘 ----
  check(/import \{[\s\S]{0,400}\} from "\.\/draft";/.test(drMain) && /const draftStore = vdirDraftStore\(\);/.test(drMain),
    "页面接的就是 draft.ts 那一份（顶层就绑上 vdir 后端）");
  check(!/idbDraftStore/.test(drSrc), "旧单槽 IndexedDB 装配没有留成半死代码（要么接上要么清掉）");
  const drTargetAt = drMain.indexOf("const autosaveTarget = ");
  const drTargetFn = drMain.slice(drTargetAt, drTargetAt + 600);
  check(drTargetAt > 0 && /autosaveTargetFor\(\{/.test(drTargetFn) && /savable: canSave\(\)/.test(drTargetFn)
    && /hasDir: !!projectDir && dirWritable !== false/.test(drTargetFn) && /draftable: !!doc\?\.scene/.test(drTargetFn)
    && /slot: currentDraftSlot\(\)/.test(drTargetFn),
    "自动保存目标按「有没有内容 / 文件夹可不可写 / 快照装不装得下 / 草稿槽」算出来");
  const drSched = drMain.slice(drMain.indexOf("function scheduleAutosave()"), drMain.indexOf("async function flushDraftSnapshot"));
  check(!/if \(!projectDir/.test(drSched) && /const target = autosaveTarget\(\);/.test(drSched) && /if \(target === "none"\) \{/.test(drSched),
    "scheduleAutosave 先算目标、不再因为「没有项目文件夹」直接放弃（C6 的放宽就在这）");
  check(/if \(target === "draft"\) void flushDraftSnapshot\(\);/.test(drMain) && /else void flushAutosave\(\);/.test(drMain),
    "两条路各有各的落点：文件夹走 flushAutosave，草稿走 flushDraftSnapshot");
  check(/async function flushDraftSnapshot\(force = false\)/.test(drMain) && /draftStore\.save\(d, slot\)/.test(drMain)
    && /makeDraft\(snap, draftOriginFor\(\), overlay\?\.entry \?\? "scene\.json", overlay\?\.added\(\) \?\? \[\]/.test(drMain),
    "快照写的就是当前文档（标题 / 工程 / 场景 / 入口 / 叠加层文件）");
  check(/warnNoAutosaveTarget\(\)/.test(drMain) && /if \(!doc \|\| warnedNoSaveFor === doc\) return;/.test(drMain)
    && /log\(et\("log\.cannotSaveKind"/.test(drMain),
    "不写的时候明确提示一次，不静默（同一次打开只提示一次）");
  check(/probeWritable\(dir\)\.then\(/.test(drMain) && /dirWritable = false;/.test(drMain) && /log\.dirNotWritable/.test(drMain),
    "文件夹不可写：探一次（只探一次，不每 400ms 撞墙）→ 退到草稿槽 + 明确报出目录名与原因");
  check(/function flushPendingSave\(\)/.test(drMain) && /visibilitychange[\s\S]{0,160}flushPendingSave\(\)/.test(drMain),
    "页面隐藏前按同一个目标分流落盘（切后台 / 关标签页不丢未保存编辑）");
  check(/function flushDraftSnapshot\(force = false\)/.test(drMain) && /void flushDraftSnapshot\(true\)/.test(drMain),
    "隐藏时不受节流限制，立刻把最后一次编辑写进快照");
  check(/async function restoreDraft\(pending: \{ slot: string; draft: Draft \}\)/.test(drMain) && /applyDraft\(target, d\)/.test(drMain)
    && /rebuildTree|applyDraftSnapshot\(d\)/.test(drMain),
    "恢复：把快照套回文档（标题 / 工程 / 场景写回并重建图层树，判据就是上面那条往返一致）");
  check(/newOpened\(d\.title, d\.project \?\? newProject\(d\.title\), d\.scene\)/.test(drMain) && /docDriven: true/.test(drMain),
    "没有原始来源可重开（会话内 / 本地文件夹句柄失效）时按快照在内存里重建，不静默丢");
  check(/function clearOwnDraftSlot\(slot: string = currentDraftSlot\(\)\) \{\s*\n\s*if \(!slot \|\| lastDraftSlot !== slot\) return;/.test(drMain)
    && /clearOwnDraftSlot\(prevSlot\);/.test(drMain) && /clearOwnDraftSlot\(\);/.test(drMain) && /lastDraftSlot = slot;/.test(drMain),
    "内容落到文件夹后清草稿副本，但只清本次会话自己写过的槽（上一次会话留下的快照不碰，可能只有那一份）");
  check(/const nowSlot = currentDraftSlot\(\);\s*\n\s*if \(nowSlot !== pending\.slot\) \{\s*\n\s*try \{\s*\n\s*await draftStore\.save\(d, nowSlot\);\s*\n\s*draftWrittenAt = Date\.now\(\);\s*\n\s*lastDraftSlot = nowSlot;\s*\n\s*await draftStore\.clear\(pending\.slot\);/.test(drMain),
    "重建后槽会挪（local: → 会话槽）：先落新槽再清旧槽，不留一条每次都冒出来的旧快照");
  check(/if \(from\.kind === "library"\)[\s\S]{0,500}openLibraryItem\(it, MEDIA_BASE, WEB_BASE\)/.test(drMain)
    && /if \(from\.kind === "virtual"\)[\s\S]{0,500}openVirtualProject\(from\.id\)/.test(drMain),
    "库条目 / 虚拟工程各自重开原始资源，再把快照套上去（增量快照，不靠一份全量拷贝）");
  check(/log\(et\("log\.draftMissing", \{ id \}\), "error"\)/.test(drMain) && /log\(et\("log\.vdirMissing", \{ name: d\.title \}\), "warn"\)/.test(drMain),
    "来源已经不在（库条目被删 / 目录没了）明确报错，不静默丢弃");
  check(/overlay\?\.put\(f\.name, f\.data, g\);/.test(drMain) && /overlay\?\.share\(owner, f\.name\)/.test(drMain),
    "快照里的叠加层文件按组还原（第一个 put，同组其余 share）");
  check(/checkDraftRecovery\(\)/.test(drMain) && /await draftStore\.list\(\)/.test(drMain) && /pendingDraft = \{ slot: info\.slot, draft: d \}/.test(drMain),
    "启动时查一遍快照，只提示、不自动打开");
  check(/if \(item && \(d\.origin\.kind !== "library" \|\| d\.origin\.itemId !== item\)\) continue;/.test(drMain),
    "带 ?item=<库条目> 时只认这一条的草稿（不会拿别的工程的快照往它身上套）");
  const drRecoverAt = drMain.indexOf("async function checkDraftRecovery");
  const drRecoverBody = drMain.slice(drRecoverAt, drMain.indexOf("async function restoreDraft"));
  check(drRecoverAt > 0 && !/draftBannerEl/.test(drRecoverBody)
    && /void checkVirtualResume\(\);\s*\n\s*\/\/[^\n]*\n\s*void checkDraftRecovery\(\);/.test(drMain),
    "启动时两条横幅互不顶替：同一个内置工程有未保存编辑也照样提示，不看另一条横幅的时序 / DOM（两条同时在就上下排开）");
  const drVirtualAt = drMain.indexOf('if (from.kind === "virtual")');
  const drVirtualBody = drMain.slice(drVirtualAt, drMain.indexOf("// 会话内"));
  check(drVirtualAt > 0 && /openVirtualProject\(from\.id\)/.test(drVirtualBody) && /filesFromDirectory\(dir\)/.test(drVirtualBody)
    && /adoptProject\(dir\)/.test(drVirtualBody) && /files\.length \? openLocalFiles\(files\)/.test(drVirtualBody)
    && /newOpened\(d\.title, d\.project \?\? newProject\(d\.title\), d\.scene\)/.test(drVirtualBody),
    "虚拟工程草稿：目录还在就按目录重开，目录空了（存储被清过）就按快照重建并 adopt 回该目录（不静默丢）");
  check(/draftRecoverRestoreEl\.onclick/.test(drMain) && /draftRecoverDiscardEl\.onclick/.test(drMain)
    && /draftRestoreEl\.onclick = \(\) => \{[\s\S]{0,200}resumeVirtualProject/.test(drMain),
    "两条横幅各绑各的处理函数：一条重开目录，一条恢复未保存编辑（语义不混）");

  // ---- 横幅 DOM / 样式 / i18n：与既存 #ed-draft 可区分 ----
  check(/id="ed-draft-recover" role="status" hidden/.test(drHtml) && drHtml.indexOf('id="ed-draft-recover"') > drHtml.indexOf('id="ed-draft"'),
    "未保存编辑横幅是独立一条，排在「重开上次目录」横幅之后");
  check(/id="draft-recover-restore"/.test(drHtml) && /id="draft-recover-discard"/.test(drHtml)
    && /id="ed-draft-recover"[\s\S]{0,300}data-et="draft\.restore"[\s\S]{0,200}data-et="draft\.discard"/.test(drHtml),
    "新横幅有自己的按钮 id，文案复用既有的「恢复 / 丢弃」两条");
  check(/#ed-draft-recover,/.test(drCss) && /#ed-draft:not\(\[hidden\]\) \+ #ed-draft-recover \{/.test(drCss),
    "新横幅沿用同一套横幅样式；两条同时在时下沉一行，不叠在一起");
  check(/const draftRecoverTextEl = \$[^(]*\("#ed-draft-recover-text"\)/.test(drMain) && /et\("draft\.unsavedFound", \{/.test(drMain),
    "横幅文案走 i18n，不是硬编码");
  check(/et\("vdir\.found", \{ name: rec\.name/.test(drMain) && /et\("draft\.unsavedFound"/.test(drMain),
    "两条横幅的文案指向不同的事：一条说「发现上次的工程」，一条说「发现未保存的编辑」");
  check((drI18n.match(/"draft\.unsavedFound":/g) ?? []).length === 2, "draft.unsavedFound 中英文各恰好一条");
  check(drI18n.includes('"draft.unsavedFound": "发现未保存的编辑「{title}」（{time}）"')
    && drI18n.includes('"draft.unsavedFound": "Unsaved edits found: \\"{title}\\" ({time})"'),
    "中英文都真翻译了（不是同一串占位）");

  // ---- 变异红测：把上面三条底线各破一次，判据必须变红 ----
  const drMut = async (from, to, tag) => {
    const mut = drSrc.replace(from, to);
    check(mut !== drSrc, `注入点存在（${tag}）`);
    return loadEditorModule("draft", { [drPath]: mut });
  };
  const mutTarget = await drMut('  return state.draftable && state.slot ? "draft" : "none";', '  return "none";', "草稿槽不再兜底");
  check(mutTarget.autosaveTargetFor({ savable: true, hasDir: false, draftable: true, slot: "library:beach" }) === "none",
    "去掉草稿槽兜底的话，「库来源 / 不可写目录也自动保存」的判据变红");
  const mutEvict = await drMut("if (kept > 0 && (kept >= maxSlots || bytes + i.bytes > maxBytes))", "if (kept >= 0 && (kept >= maxSlots || bytes + i.bytes > maxBytes))", "淘汰时不留最新一条");
  const beM = vdirMod.memoryVdirBackend();
  const storeM = mutEvict.vdirDraftStore(beM, 1, 1);
  await storeM.save(slotSnap(9), "only");
  check((await storeM.load("only")) === null, "淘汰时不排除最新一条的话，「刚存的那条不会被自己淘汰」的判据变红");
  const mutLoose = await drMut('  } else if (o.kind === "local") {\n    if (!nonEmpty(o.name)) return null;', '  } else if (o.kind === "local") {\n    // 不校验 name', "本地来源不校验 name");
  check(mutLoose.parseDraft({ ...snap, origin: { kind: "local" } }) !== null,
    "本地来源漏校验 name 的话，「坏快照一律拒」的判据变红");
}

// ───────────────────────────────────────────────────────────────────────────
section("PARTICLE-V2. 粒子系统编辑器 v2：分组参数读写 / 未知组件原样保留 editor/particle-params.ts（M2 A3）");
{
  const ptp = await loadEditorModule("particle-params");
  const ptpPath = path.join(ROOT, "editor/particle-params.ts");
  const ptpSrc = fs.readFileSync(ptpPath, "utf8");
  const psPath = path.join(ROOT, "renderer/vendor/we-scene/render/particles.js");
  const psSrc = fs.readFileSync(psPath, "utf8");
  const psLive = await imp("renderer/vendor/we-scene/render/particles.js");

  // 夹具与语料同形（vecN 是空格分隔字符串、controlpoint 每项带 id/flags/offset/angles），
  // 并**故意**混入未知顶层键 / 未知组件 / 引擎未生效组件 / 引擎不认识名字的组件 ——
  // 它们都必须在面板上被点名、只读列出、逐字节保留。
  const pvFile = () =>
    JSON.parse(
      json({
        maxcount: 500,
        starttime: 20,
        sequencemultiplier: 2,
        material: "materials/editor/particles/x.json",
        flags: 1,
        FutureTop: 7,
        emitter: [
          {
            id: 1,
            name: "boxrandom",
            origin: "0 0 0",
            directions: "1 1 1",
            distancemin: "0 0 0",
            distancemax: "100 100 0",
            rate: 10,
            speedmin: 1,
            speedmax: 2,
            audioprocessingbounds: "0.8 1.0",
            FutureEmitter: 3,
          },
        ],
        initializer: [
          { id: 2, name: "lifetimerandom", min: 1, max: 5, exponent: 1 },
          { id: 3, name: "turbulentvelocityrandom", scale: 0.1, forward: "1 0 0" },
          { id: 4, name: "FutureThing", foo: 1 },
          { id: 5, name: "positionoffsetrandom", distance: 5 },
        ],
        operator: [
          { id: 6, name: "movement", gravity: "0 15 0", drag: 1.5 },
          { id: 7, name: "reducemovementnearcontrolpoint", controlpoint: 0, distanceinner: 10, distanceouter: 20, reductioninner: 500 },
          { id: 8, name: "maintaindistancetocontrolpoint", variablestrength: 1 },
        ],
        renderer: [{ id: 9, name: "spritetrail", length: 0.1, maxlength: 5, minlength: "0.02", orientation: "screen", flags: 2 }],
        controlpoint: [{ id: 0, flags: 0, offset: "1 2 3", angles: "0 0 90", locktopointer: true, parentcontrolpoint: -1 }],
      }),
    );

  const pvLayer = () => ({ origin: [0, 0, 0], scale: [1, 1, 1], angles: [0, 0, 0], visible: true });
  const pvModel = () => ({
    maxcount: 200,
    starttime: 0,
    emitter: [{ name: "boxrandom", origin: "0 0 0", directions: "1 1 1", distancemin: "0 0 0", distancemax: "100 100 0", rate: 30, speedmin: 10, speedmax: 20 }],
    initializer: [{ name: "lifetimerandom", min: 1, max: 2 }],
    operator: [{ name: "movement", gravity: "0 15 0", drag: 1.5 }],
    renderer: [{ name: "sprite" }],
    controlpoint: [],
  });

  /**
   * PARTICLE-V2 判据体：返回失败清单（空 = 全绿）。变异红测复用它 ——
   * 「判据把错实现咬红」才是判据成立的证明。f = particle-params 模块，psMod = 引擎粒子模块。
   */
  const particleV2Corpus = (f, psMod) => {
    const bad = [];
    const is = (cond, msg) => {
      if (!cond) bad.push(msg);
    };

    // ---- 1. 组件识别与状态：ok / 引擎未生效（unsupported）/ 不认识（unknown）----
    const file = pvFile();
    const comps = f.particleComponents(file).map((c) => `${c.group}:${c.name}:${c.status}`);
    is(
      json(comps) ===
        json([
          "emitter:boxrandom:ok",
          "initializer:lifetimerandom:ok",
          "initializer:turbulentvelocityrandom:unsupported",
          "initializer:FutureThing:unknown",
          "initializer:positionoffsetrandom:unknown",
          "operator:movement:ok",
          "operator:reducemovementnearcontrolpoint:ok",
          "operator:maintaindistancetocontrolpoint:unknown",
          "renderer:spritetrail:ok",
          "controlpoint::ok",
        ]),
      "五族组件与状态（emitter/initializer/operator/renderer/controlpoint）",
    );
    const issues = f.particleIssues(file);
    is(
      issues.some((i) => i.kind === "unsupported" && i.name === "turbulentvelocityrandom" && i.group === "initializer"),
      "诊断标注：turbulentvelocityrandom 标为「引擎未生效」（面板据此出提示文案）",
    );
    is(
      json(issues.filter((i) => i.kind === "unknown").map((i) => i.name)) === json(["FutureThing", "positionoffsetrandom", "maintaindistancetocontrolpoint"]),
      "未知组件逐个点名（含带下标定位）",
    );

    // ---- 2. 视图只列文件里真有的字段（缺失字段不出控件 → 天然不新增键）----
    const emitterView = f.particleComponentViews(file).find((c) => c.group === "emitter");
    is(
      json(emitterView.views.map((v) => v.key)) ===
        json([
          "emitter[0].origin",
          "emitter[0].directions",
          "emitter[0].distancemin",
          "emitter[0].distancemax",
          "emitter[0].rate",
          "emitter[0].speedmin",
          "emitter[0].speedmax",
          "emitter[0].audioprocessingbounds",
        ]),
      "只列文件里真有的字段（夹具 emitter 没有 flags / delay → 不出控件）",
    );
    is(json(emitterView.extraKeys) === json(["FutureEmitter"]), "组件里字段表之外的键进 extraKeys（只读列出）");
    is(json(f.particleTopExtraKeys(file)) === json(["FutureTop"]), "顶层未声明键只读列出（emitter 等组名不算）");
    const topKeys = f.particleTopViews(file).map((v) => v.key).sort();
    is(
      json(topKeys) === json(["particle.flags", "particle.material", "particle.maxcount", "particle.sequencemultiplier", "particle.starttime"].sort()),
      "顶层字段视图列出 maxcount / starttime / sequencemultiplier / material / flags",
    );

    // ---- 3. 读写往返：算子 / 初始化器 / 渲染器 ----
    is(f.setParticleField(file, "operator[0].drag", 2.5) === true && file.operator[0].drag === 2.5, "算子标量参数写回（movement.drag）");
    is(f.setParticleField(file, "initializer[0].max", 9) === true && file.initializer[0].max === 9, "初始化器参数写回（lifetimerandom.max）");
    is(f.setParticleField(file, "renderer[0].maxlength", 3.5) === true && file.renderer[0].maxlength === 3.5, "渲染器参数写回（spritetrail.maxlength）");
    is(f.setParticleField(file, "operator[0].drag", 2.5) === false, "值没变返回 false（调用方据此不重写文件、不入撤销栈）");

    // ---- 4. 逐字节：改一个值只动那一处，未知键/未知组件原样 ----
    const snap = json(file);
    is(f.setParticleField(file, "operator[0].drag", 7) === true, "改第二处值");
    const restored = JSON.parse(json(file));
    restored.operator[0].drag = 2.5;
    is(json(restored) === snap, "逐字节：把那一处改回原值后整串完全相同（只有它变了）");
    is(file.emitter[0].FutureEmitter === 3 && file.FutureTop === 7, "未知键（组件内 / 顶层）逐字节不动");
    is(file.initializer[1].scale === 0.1 && file.initializer[1].forward === "1 0 0" && file.initializer[2].foo === 1, "引擎未生效组件与未知组件的字段原样保留");
    is(file.operator[2].variablestrength === 1, "引擎不认识名字的组件原样保留");

    // ---- 5. maxcount / starttime 钳位（与引擎同口径）----
    is(f.setParticleField(file, "particle.maxcount", 99999) === true && file.maxcount === 20000, "maxcount 上钳到 20000");
    is(f.setParticleField(file, "particle.maxcount", -5) === true && file.maxcount === 1, "maxcount 下钳到 1");
    is(f.setParticleField(file, "particle.starttime", 99) === true && file.starttime === 30, "starttime 上钳到 30");
    is(f.setParticleField(file, "particle.starttime", -1) === true && file.starttime === 0, "starttime 下钳到 0");
    is(f.setParticleField(file, "particle.maxcount", "abc") === false, "非数字拒绝（不动文档）");

    // ---- 6. vec 按原件形态回写；键名大小写不敏感命中原名 ----
    is(f.setParticleField(file, "operator[0].gravity", [0, 5, 0]) === true && file.operator[0].gravity === "0 5 0", "vec3 写回保持语料的空格分隔字符串形态");
    is(f.setParticleField(file, "operator[0].gravity", [0, 5, 0]) === false, "vec 数值没变返回 false（不规范化作者的写法）");
    const arrBox = { emitter: [{ id: 1, name: "boxrandom", directions: [1, 1, 1] }] };
    is(
      f.setParticleField(arrBox, "emitter[0].directions", [0, 1, 0]) === true && json(arrBox.emitter[0].directions) === json([0, 1, 0]),
      "原件是数组就写数组（按原件形态回写）",
    );
    const ciBox = { MaxCount: 500, emitter: [{ id: 1, name: "boxrandom", Rate: 10 }] };
    is(
      f.setParticleField(ciBox, "particle.maxcount", 300) === true && ciBox.MaxCount === 300 && !("maxcount" in ciBox),
      "键名大小写不敏感命中原名写回（不新增小写键）",
    );
    is(f.setParticleField(ciBox, "emitter[0].rate", 20) === true && ciBox.emitter[0].Rate === 20, "组件字段同样按作者原名写回");
    const wrapBox = { maxcount: { user: "p", value: 400 }, emitter: [{ id: 1, name: "boxrandom", rate: { script: "s", scriptproperties: "q", value: 10 } }] };
    is(
      f.setParticleField(wrapBox, "particle.maxcount", 250) === true && json(wrapBox.maxcount) === json({ user: "p", value: 250 }),
      "{user,value} 包装只改 value",
    );
    is(
      f.setParticleField(wrapBox, "emitter[0].rate", 3) === true && json(wrapBox.emitter[0].rate) === json({ script: "s", scriptproperties: "q", value: 3 }),
      "绑定字段的包装只改 value（script / scriptproperties 原样）",
    );

    // ---- 7. controlpoint 族 ----
    const cpBox = { controlpoint: [{ id: 0, flags: 0, offset: "1 2 3", angles: "0 0 90", locktopointer: true, parentcontrolpoint: -1 }] };
    is(
      json(f.particleComponentViews(cpBox).find((c) => c.group === "controlpoint").views.map((v) => v.key)) ===
        json(["controlpoint[0].flags", "controlpoint[0].offset", "controlpoint[0].angles", "controlpoint[0].locktopointer", "controlpoint[0].parentcontrolpoint"]),
      "controlpoint 族字段齐全（id 不列，offset/angles 是 vec3）",
    );
    is(f.setParticleField(cpBox, "controlpoint[0].offset", [4, 5, 6]) === true && cpBox.controlpoint[0].offset === "4 5 6", "controlpoint.offset 写回（vec3 字符串）");
    is(f.setParticleField(cpBox, "controlpoint[0].locktopointer", false) === true && cpBox.controlpoint[0].locktopointer === false, "controlpoint.locktopointer 写回（布尔）");
    is(f.setParticleField(cpBox, "controlpoint[0].parentcontrolpoint", 3) === true && cpBox.controlpoint[0].parentcontrolpoint === 3, "controlpoint.parentcontrolpoint 写回（整数）");

    // ---- 8. 拒绝路径：认不出 / 越界 / 引擎未生效 / 未知组件，统统不动文档 ----
    const fresh = pvFile();
    const freshSnap = json(fresh);
    is(f.setParticleField(fresh, "particle.nope", 1) === false, "顶层未声明的键拒绝");
    is(f.setParticleField(fresh, "initializer[1].scale", 9) === false, "引擎未生效的组件拒绝写（只标注不修）");
    is(f.setParticleField(fresh, "initializer[2].foo", 9) === false, "未知组件拒绝写");
    is(f.setParticleField(fresh, "operator[2].variablestrength", 9) === false, "引擎不认识名字的组件拒绝写");
    is(
      f.setParticleField(fresh, "operator[9].drag", 9) === false && f.setParticleField(fresh, "bogus[0].x", 1) === false && f.setParticleField(fresh, "operator[0].nodrag", 1) === false,
      "越界下标 / 非法族名 / 未声明字段一律拒绝",
    );
    is(json(fresh) === freshSnap, "拒绝路径逐字节不动文档");

    // ---- 9. 序列化往返与解析失败 ----
    const text = new TextDecoder().decode(f.serializeParticleFile(fresh));
    is(json(f.parseParticleFile(text)) === json(fresh), "序列化 → 解析往返字段与值不丢不改名");
    is(f.parseParticleFile("{") === null && f.parseParticleFile("[1]") === null, "非法 JSON / 非对象返回 null（面板显示读不出）");

    // ---- 10. 表单描述符：数值走 range，枚举/文本面板自己搓 ----
    const pvViews = f.particleFieldViews(pvFile());
    const lenP = f.particleFormParam(pvViews.find((v) => v.key === "renderer[0].length"));
    is(!!lenP && lenP.type === "float" && lenP.min === 0 && lenP.max === 1 && lenP.step === 0.001, "数值字段转成 schema-form 描述符（带 min/max/step）");
    const oriView = pvViews.find((v) => v.key === "renderer[0].orientation");
    is(f.particleFormParam(oriView) === null && f.particleTextValue(oriView) === "screen", "枚举字段不给 range 控件（面板搓 select），文本取值原样");

    // ---- 11. 引擎热更：applyModel 只重读 model，不动池 ----
    const layer = pvLayer();
    const m0 = pvModel();
    const ps = new psMod.ParticleSystem(null, m0, null, layer);
    is(ps.maxCount === 200 && ps.pool.length === 200, "引擎初始池容量按 maxcount（200）");
    const poolRef = ps.pool;
    const m1 = { ...m0, operator: [{ name: "movement", gravity: "0 5 0", drag: 2 }] };
    ps.applyModel(m1);
    is(ps.model === m1, "applyModel 按引用持有新模型（面板改的就是引擎手上那份）");
    is(ps.pool === poolRef, "maxcount 没变时不重建池（屏上粒子不清零、不闪）");
    is(!!ps.ops.movement && ps.ops.movement.gravity[1] === 5 && ps.ops.movement.drag === 2, "算子参数当帧生效（_compile 只重读 model）");
    const m2 = { ...m1, starttime: 12, flags: 3, sequencemultiplier: 3, animationmode: "sequence", controlpoint: [{ id: 7, offset: "5 6 7", flags: 1 }] };
    ps.applyModel(m2);
    is(
      ps.startTime === 12 && ps.worldSpace === true && ps.frameBlend === false && ps.sequenceMul === 3 && ps.animationMode === "sequence",
      "顶层设置（starttime / flags / sequencemultiplier / animationmode）热更后立即重读",
    );
    is(
      ps.controlPoints.length === 1 && ps.controlPoints[0].id === 7 && ps.controlPoints[0].lockToPointer === true && json(ps.controlPoints[0].offset) === json([5, 6, 7]),
      "controlpoint 族热更后立即重读（id / flags → lockToPointer / offset）",
    );
    const m3 = { ...m2, maxcount: 137 };
    ps.applyModel(m3);
    is(ps.maxCount === 137 && ps.pool.length === 137, "maxcount 变了才重建池（容量跟着变）");

    return bad;
  };

  const pvBad = particleV2Corpus(ptp, psLive);
  check(pvBad.length === 0, `粒子 v2：分组参数读写 / 未知组件原样保留 / 钳位 / controlpoint 族 / 引擎热更全部成立（${pvBad.join(" / ") || "ok"}）`);

  // ---- 引擎侧实现：路径定位 + 只在 maxcount 变时重建池 ----
  check(
    /applyModel\(model\) \{[\s\S]{0,400}?this\._applyModelSettings\(\)[\s\S]{0,400}?if \(nextMax !== prevMax\) this\.reapplyOverride\(\)[\s\S]{0,200}?this\._compile\(\)/.test(psSrc),
    "引擎 applyModel：重读顶层设置 → 只有 maxcount 变才重建池 → 再 _compile",
  );
  check(
    /_applyModelSettings\(\) \{/.test(psSrc) && /this\.startTime = Math\.max\(0, Math\.min\(30, num\(model\.starttime, 0\)\)\)/.test(psSrc),
    "_applyModelSettings 覆盖 starttime 钳位（与构造函数同口径）",
  );
  const smSrc2 = fs.readFileSync(path.join(ROOT, "renderer/src/scene-mount.ts"), "utf8");
  check(
    /\(ps as \{ particlePath\?: string \}\)\.particlePath = particlePath;/.test(smSrc2),
    "引擎侧给每个粒子系统记文件路径（一个文件可挂多层，不能按 layer id 定位）",
  );
  check(
    /const setParticleModelImpl = \(\s*path: string,\s*model: Record<string, unknown>\): Promise<void> =>/.test(smSrc2) &&
      /const hit = particleSystems\.filter\(\(p\) => \(p as \{ particlePath\?: string \}\)\.particlePath === path\);/.test(smSrc2) &&
      /if \(!hit\.length\) return Promise\.reject\(new Error\(`setParticleModel: no particle system for \$\{path\}`\)\);/.test(smSrc2) &&
      /return renderOnce\(\);/.test(smSrc2.slice(smSrc2.indexOf("const setParticleModelImpl"))),
    "setParticleModel：按文件路径命中全部系统 → 没命中 reject → 补画一帧",
  );
  check(/setParticleModel: setParticleModelImpl,/.test(smSrc2), "热更 API 挂进 editorImpl");
  check(/setParticleModel\(path, model\)/.test(fs.readFileSync(path.join(ROOT, "renderer/src/editor/controls.ts"), "utf8")), "经 editorOf 转发（页面只走公共出口）");
  check(/setParticleModel\(path: string, model: Record<string, unknown>\): Promise<void>;/.test(fs.readFileSync(path.join(ROOT, "renderer/src/api/types.ts"), "utf8")), "EditorControls 声明了 setParticleModel（分层契约）");

  // ---- 页面接线：分区、热更、字节级撤销、既有 6 个倍率没被改掉 ----
  const mainSrc2 = fs.readFileSync(path.join(ROOT, "editor/main.ts"), "utf8");
  check(
    /group\.appendChild\(particleFileSection\(node, editable\)\);/.test(mainSrc2) && /function particleFileSection\(node: LayerNode, editable: boolean\): HTMLElement/.test(mainSrc2),
    "检视器粒子分区接上（既有 6 个倍率 + 颜色那条路径没被改掉）",
  );
  check(
    /void editor\?\.setParticleModel\(path, parsed\)\.catch\(\(\) => \{\}\);/.test(mainSrc2) && /overlay\?\.put\(path, bytes, path\);/.test(mainSrc2),
    "面板提交后：落盘（group = 文件自身路径，在 referencedParticles 里）+ 同一份对象交给引擎热更",
  );
  check(
    /const cmd = fileCommand\(et\("pt\.fileEdited", \{ layer: nodeName\(node\.id\), field: ptFieldLabel\(view\) \}\), \{ path, bytes: enc\.encode\(before\) \}, \{ path, bytes \}\);/.test(mainSrc2),
    "粒子文件改动按「文件 + 字节」记一步撤销（文件不在 doc 里，结构快照装不下）",
  );
  check(/if \(isFileCmd\(cmd\)\) \{[\s\S]{0,400}?applyParticleBytes\(snap\.path, snap\.bytes\);/.test(mainSrc2), "撤销 / 重做走同一个 applyParticleBytes（字节回写 + 热更）");
  check(/det\.className = "ed-inline-pass";/.test(mainSrc2) && /\.ed-inline-pass\b/.test(fs.readFileSync(path.join(ROOT, "editor/editor.css"), "utf8")), "粒子分区复用作品自带效果的折叠样式（不新增 CSS / HTML）");

  // ---- i18n：中英各一次（含「引擎未生效」诊断文案）----
  {
    const i18nSrc2 = fs.readFileSync(path.join(ROOT, "editor/i18n.ts"), "utf8");
    const pvKeys = [
      "pt.fileTitle",
      "pt.fileHint",
      "pt.fileLoading",
      "pt.fileMissing",
      "pt.fileEmpty",
      "pt.fileTop",
      "pt.fileUnknownTop",
      "pt.fileUnknownKeys",
      "pt.fileEdited",
      "pt.statusUnsupported",
      "pt.statusUnknown",
      "pt.statusNoPanel",
      "pt.unsupportedHint",
      "ptg.emitter",
      "ptg.initializer",
      "ptg.operator",
      "ptg.renderer",
      "ptg.controlpoint",
      "ptf.maxcount",
      "ptf.starttime",
      "ptp.origin",
      "ptp.drag",
    ];
    const missingPv = pvKeys.filter((k) => (i18nSrc2.match(new RegExp(`"${k.replace(/\./g, "\\.")}":`, "g")) ?? []).length !== 2);
    check(missingPv.length === 0, `粒子 v2 文案中英文都有（缺 ${json(missingPv)}）`);
    check(/引擎未生效/.test(i18nSrc2) && /Not effective in the engine/.test(i18nSrc2), "「引擎未生效」诊断文案中英双写");
    check(/turbulentvelocityrandom/.test(i18nSrc2), "诊断文案点名 turbulentvelocityrandom（面板上看得见是哪个组件）");
  }

  // ---- 变异红测：判据咬得住吗 ----
  {
    const pvMut = async (from, to, tag) => {
      const mut = ptpSrc.replace(from, to);
      check(mut !== ptpSrc, `注入点存在（${tag}）`);
      return loadEditorModule("particle-params", { [ptpPath]: mut });
    };
    const m1 = await pvMut("for (const k of Object.keys(box)) if (k.toLowerCase() === want) return k;", "for (const k of Object.keys(box)) if (k === key) return k;", "键名大小写不敏感");
    check(/大小写不敏感/.test(particleV2Corpus(m1, psLive).join(" / ")), "改成大小写敏感时「命中原名写回」判据变红");
    const m2 = await pvMut("      if (field.clamp) {", "      if (false) {", "maxcount / starttime 钳位");
    check(/钳到/.test(particleV2Corpus(m2, psLive).join(" / ")), "去掉钳位时「maxcount / starttime 钳位」判据变红");
    const m3 = await pvMut('  if (isObj(cur) && ("value" in cur || isBinding(cur))) {', "  if (false) {", "包装只改 value");
    check(/包装只改 value/.test(particleV2Corpus(m3, psLive).join(" / ")), "无视 {user,value} 包装时「只改 value」判据变红");
    const m4 = await pvMut("    if (!realKeyOf(box, field.key)) continue; // 只列文件里真有的字段（不新增键）", "    // 变异：不再只列真有的字段", "只列文件里真有的字段");
    check(/只列文件里真有的字段/.test(particleV2Corpus(m4, psLive).join(" / ")), "视图不再只列真有的字段时「缺失字段不出控件」判据变红");
    const m5 = await pvMut('      return use.map(fmt).join(" ");', "      return use;", "vec 按原件形态回写");
    check(/空格分隔字符串/.test(particleV2Corpus(m5, psLive).join(" / ")), "vec 不再回写成字符串形态时「与语料同形」判据变红");
    const m6 = await pvMut('  if (spec?.engineUnsupported) return "unsupported";', '  if (spec?.engineUnsupported) return "ok";', "引擎未生效的诊断标注");
    check(/诊断标注|五族组件与状态/.test(particleV2Corpus(m6, psLive).join(" / ")), "抹掉「引擎未生效」状态时诊断标注判据变红");
    // 引擎侧：applyModel 每次都重建池 → 「不闪」判据红
    const psMut = psSrc.replace("    if (nextMax !== prevMax) this.reapplyOverride()", "    this.reapplyOverride()");
    check(psMut !== psSrc, "注入点存在（applyModel 只在 maxcount 变时重建池）");
    const psBundled = await build({
      entryPoints: [psPath],
      bundle: true,
      write: false,
      format: "esm",
      platform: "neutral",
      target: "es2022",
      logLevel: "silent",
      plugins: [{ name: "particle-model-mut", setup: (b) => b.onLoad({ filter: /render[\\/]particles\.js$/ }, () => ({ contents: psMut, loader: "js" })) }],
    });
    const tmpPs = path.join(tmpRoot, `particles-mut-${Math.random().toString(36).slice(2)}.mjs`);
    fs.writeFileSync(tmpPs, psBundled.outputFiles[0].text);
    const psMutMod = await import(pathToFileURL(tmpPs).href);
    check(/不清零/.test(particleV2Corpus(ptp, psMutMod).join(" / ")), "applyModel 每次都重建池时「maxcount 没变不重建池」判据变红");
  }

  console.log("  （headless：打开粒子图层 → 改 operator[0].drag → 粒子文件字节变 + 出帧变；见本段头注）");
}

// ───────────────────────────────────────────────────────────────────────────
// M9. 命令面板 + 动态快捷键总览（C4）/ 图层树无障碍（C5）/ 脚本事件模板（B8）
// ───────────────────────────────────────────────────────────────────────────
section("M9. 命令面板与无障碍（PALETTE）");
{
  const palRead = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
  const palMainSrc = palRead("editor/main.ts");
  const palHtmlSrc = palRead("editor/index.html");
  const palCssSrc = palRead("editor/editor.css");
  const palPanelSrc = palRead("editor/ui/command-palette.ts");
  const palNavSrc = palRead("editor/tree-nav.ts");
  const palI18nSrc = palRead("editor/i18n.ts");
  const palHeadSrc = palRead("scripts/verify-editor-headless.mjs");
  const palEngineSrc = palRead("renderer/vendor/we-scene/render/text.js");
  // loadEditorModule 把打包结果写进 tmpRoot/<name>.mjs：带子目录的名字要先建目录
  fs.mkdirSync(path.join(tmpRoot, "ui"), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, "services"), { recursive: true });
  const palPanel = await loadEditorModule("ui/command-palette");
  const palNav = await loadEditorModule("tree-nav");
  const palScripts = await loadEditorModule("scripts");
  const { createCommandService } = await loadEditorModule("services/commands");
  const palCheck = (await imp("renderer/src/editor/scripts.ts")).checkSceneScript;

  // 词典两个语言段的键集合（4 空格缩进的 "key":）
  const palSplit = palI18nSrc.split(/\n  en: \{/, 2);
  const palDict = (text) =>
    new Map([...text.matchAll(/^    "([^"]+)":\s*"((?:[^"\\]|\\.)*)",?$/gm)].map((m) => [m[1], m[2]]));
  const palZh = palDict(palSplit[0]);
  const palEn = palDict(palSplit[1]);
  const palHasBoth = (k) => palZh.has(k) && palEn.has(k);
  const palDeps = { t: (k) => palZh.get(k) ?? k, has: palHasBoth, text: (v, fb) => (v && typeof v === "object" ? v.zh ?? v.en ?? fb : fb) };

  // ── C4：命令面板只枚举注册表（main.ts 的 7 条 cmd({...}) 是唯一那份命令表） ──
  const palIds = ["edit.undo", "edit.redo", "file.save", "layer.duplicate", "layer.rename", "layer.delete", "export.run"];
  const palBodies = [...palMainSrc.matchAll(/cmd\(\{([^\n]*)\}\);/g)].map((m) => m[1]);
  const palIdsFromSrc = palBodies.map((b) => /id: "([^"]+)"/.exec(b)?.[1] ?? "");
  check(json(palIdsFromSrc) === json(palIds), `内置命令仍是 main.ts 里 7 条内联 cmd({...}) 注册（实得 ${json(palIdsFromSrc)}）`);
  const palDefs = palBodies.map((b) => {
    const km = /keys: (\[[^\]]*\]|"[^"]*")/.exec(b);
    return { id: /id: "([^"]+)"/.exec(b)[1], keys: km ? JSON.parse(km[1]) : undefined, needsArg: /needsArg: true/.test(b), run: () => {} };
  });
  const palSvc = createCommandService();
  for (const d of palDefs) palSvc.register(d, "builtin-ui");
  const palList = palSvc.registry.list();
  check(json(palList.map((d) => d.id)) === json(palIds), "注册表枚举顺序 = main.ts 注册顺序（面板唯一的枚举源）");
  const palItems = palPanel.paletteItems(palList, palDeps);
  check(json(palItems.map((i) => i.id)) === json(palList.map((d) => d.id)), "命令面板条目 id 序列 = registry.list() 的 id 序列（没有第二份手写表）");
  check(!/BUILTIN_COMMANDS|"edit\.undo"|"layer\.duplicate"/.test(palPanelSrc), "面板模块源码里没有任何内置命令 id（第二份命令表已删除）");
  check(palPanel.orphanCommands(palList, { has: palHasBoth }).length === 0, "7 条内置命令都有 cmd.<id> 标题词条与 cmd.cat.<首段> 分类词条（注册表 ↔ 词条表一一对应，无孤儿）");
  const palWordKeys = [...new Set([...palI18nSrc.matchAll(/"cmd\.(?!cat\.)([A-Za-z0-9_.]+)":/g)].map((m) => `cmd.${m[1]}`))];
  check(json(palWordKeys.slice().sort()) === json(palIds.map((id) => `cmd.${id}`).sort()), `词典里也没有孤儿命令词条（实得 ${json(palWordKeys)}）`);

  const palBy = Object.fromEntries(palItems.map((i) => [i.id, i]));
  const palBadTitle = palItems.filter((i) => i.title !== palZh.get(`cmd.${i.id}`) || i.title === i.id).map((i) => i.id);
  check(palBadTitle.length === 0, `每条命令的标题都解析到 cmd.<id> 词条（没有退回裸 id）（失败 ${json(palBadTitle)}）`);
  const palBadCat = palItems.filter((i) => i.category !== palZh.get(`cmd.cat.${i.id.split(".")[0]}`)).map((i) => i.id);
  check(palBadCat.length === 0, `分类按 cmd.cat.<id 首段> 推出（${json(palItems.map((i) => [i.id, i.category]))}）`);
  check(palItems.every((i) => i.category !== palZh.get(palPanel.OTHER_CATEGORY_KEY)), "7 条内置命令都落在自己的分类（没有落到「其它」）");
  check(palPanel.commandTitle({ id: "z", title: { zh: "直写中文", en: "Literally" } }, palDeps) === "直写中文" && palPanel.commandTitle({ id: "z", title: "pal.title" }, palDeps) === palZh.get("pal.title"), "title 支持双语对象与词条名两种显式覆盖（缺省才按 id 约定）");

  check(palPanel.keyChordLabel("Mod+Shift+Z") === "⇧⌘Z" && palPanel.keyChordLabel("F2") === "F2" && palPanel.keyChordLabel("Delete") === "Delete" && palPanel.keysLabel(["Mod+Z"], "Ctrl") === "CtrlZ", `快捷键弦渲染成平台写法（Mod+Shift+Z → ${palPanel.keyChordLabel("Mod+Shift+Z")}）`);
  check(palPanel.keysLabel(["Mod+Shift+Z", "Mod+Y"]) === "⇧⌘Z / ⌘Y" && palPanel.keysLabel([]) === "", "多条等价快捷键用 / 连接；无键命令给空串");
  check(palBy["edit.redo"].keyLabel === "⇧⌘Z / ⌘Y" && palBy["layer.duplicate"].keyLabel === "⌘D" && palBy["layer.rename"].keyLabel === "F2" && palBy["layer.delete"].keyLabel === "Delete / Backspace", `面板展示的快捷键来自 CommandDef.keys（${json(palItems.map((i) => [i.id, i.keyLabel]))}）`);
  check(palBy["export.run"].keys.length === 0 && palBy["export.run"].needsArg === true, "export.run 无快捷键且标记 needsArg（面板里列出但不可直接执行）");

  const palFilter = (q) => palPanel.filterItems(palItems, q).map((i) => i.id);
  check(json(palFilter("复制")) === json(["layer.duplicate"]) && json(palFilter("编辑")) === json(["edit.undo", "edit.redo"]), "过滤：中文标题与分类词都能命中");
  check(json(palFilter("mod+d")) === json(["layer.duplicate"]) && json(palFilter("⌘d")) === json(["layer.duplicate"]), "过滤：快捷键（Mod+D / ⌘D）命中");
  check(json(palFilter("layer dup")) === json(["layer.duplicate"]) && palFilter("").length === 7 && palFilter("zzz").length === 0, "过滤：空格分词跨字段匹配、空串给全表、无命中给空");
  check(palPanel.moveSelection(0, 1, 7) === 1 && palPanel.moveSelection(6, 1, 7) === 0 && palPanel.moveSelection(0, -1, 7) === 6, "↑↓ 环绕移动选择");
  check(palPanel.moveSelection(-1, 1, 7) === 0 && palPanel.moveSelection(-1, -1, 7) === 6 && palPanel.moveSelection(0, 1, 0) === -1, "没有选中时向下取首条 / 向上取末条；空表给 -1");

  // 动态快捷键总览：分类分组 + 只列有键的命令，全部由 CommandDef 生成
  const palGroups = palPanel.shortcutGroups(palItems);
  const palGroupRows = palGroups.reduce((n, g) => n + g.rows.length, 0);
  check(palGroups.length === 3 && palGroupRows === 6, `快捷键总览按分类分组、只列有键的命令（${palGroups.length} 组 / ${palGroupRows} 行，export.run 无键被排除）`);
  check(palGroups[0].rows[0].id === "edit.undo" && palGroups[0].rows[0].keys === "⌘Z" && palGroups[0].rows[0].title === palZh.get("cmd.edit.undo"), "总览首行 = ⌘Z 撤销（顺序与注册表一致）");
  check(json(palGroups.map((g) => g.category)) === json(palItems.filter((i) => i.keys.length).map((i) => i.category).filter((c, i, a) => a.indexOf(c) === i)), "分组顺序 = 分类在注册表里首次出现的顺序（同分类归一组，无键命令不建组）");
  check(palPanel.shortcutGroups([]).length === 0 && palPanel.filterItems([], "x").length === 0, "空表边界：总览与过滤都返回空");
  check(!/<kbd>/.test(palHtmlSrc) && /<div id="ed-palette-shortcuts"[^>]*><\/div>/.test(palHtmlSrc) && /shortcutGroups\(/.test(palPanelSrc) && /createElement\("kbd"\)/.test(palPanelSrc), "总览容器在 HTML 里是空的，行由注册表在运行时生成（不是第二份手写清单）");
  check(!/ed-keys/.test(palHtmlSrc), "编辑器 UI 里没有静态快捷键清单（写死那份在 bench 文档页、不在编辑器内，故未动）");

  // 面板的键盘与无障碍契约
  check(/role="combobox"/.test(palHtmlSrc) && /aria-controls="ed-palette-list"/.test(palHtmlSrc) && /id="ed-palette-list" class="ed-palette-list" role="listbox"/.test(palHtmlSrc), "面板输入框是 combobox、列表是 listbox（aria-activedescendant 指向选项）");
  check(/setAttribute\("role", "option"\)/.test(palPanelSrc) && /setAttribute\("aria-selected"/.test(palPanelSrc) && /setAttribute\("aria-activedescendant"/.test(palPanelSrc), "选项带 role=option / aria-selected，输入框的 aria-activedescendant 跟随当前项");
  check(/o\.commands\.exec\(id\);[\s\S]{0,200}?catch/.test(palPanelSrc) && /pal\.runFailed/.test(palPanelSrc), "执行走 registry.exec 且包在 try/catch 里（未知命令只提示不抛）");
  check(/o\.dialog\.showModal\(\)/.test(palPanelSrc) && /e\.key === "Escape"/.test(palPanelSrc) && /moveSelection\(active, e\.key === "ArrowDown" \? 1 : -1/.test(palPanelSrc) && /if \(!keysOpen && cur\) runItem\(cur\);/.test(palPanelSrc), "面板键盘：Esc 关闭 / ↑↓ 选择 / Enter 执行当前项；打开走 showModal");
  check(/id="ed-palette-btn"/.test(palHtmlSrc) && /#ed-palette-btn"\)\.onclick = \(\) => ensurePalette\(\)\?\.open\(\)/.test(palMainSrc), "标题栏按钮点开命令面板");
  check(/\(e\.key\.toLowerCase\(\) === "k"[\s\S]{0,160}?ensurePalette\(\)\?\.toggle\(\)/.test(palMainSrc) && /onChangeLang\(\(\) => commandPalette\?\.refresh\(\)\)/.test(palMainSrc), "⌘K / Ctrl+K 在窗口 keydown 直接开合面板；切语言后重新枚举注册表");
  const palSynth = palPanel.paletteItem({ id: "x.y", when: () => false, run: () => {} }, palDeps);
  const palThrows = palPanel.paletteItem({ id: "x.z", when: () => { throw new Error("boom"); }, run: () => {} }, palDeps);
  check(palSynth.enabled === false && palThrows.enabled === false, "when() 为假或抛错都按「不可用」列出（面板不被插件拖崩）");
  check(palSynth.title === "x.y" && palSynth.category === palZh.get(palPanel.OTHER_CATEGORY_KEY), "没写 title/category 的命令退回裸 id 与「其它」分类（orphanCommands 正是查这个）");

  // ── C5：图层树无障碍（roving tabindex + 方向键导航） ──
  check(/<div id="ed-tree" class="wb-panel-body is-scroll ed-tree" role="tree" aria-multiselectable="true">/.test(palHtmlSrc), "图层树容器 role=tree + aria-multiselectable（多选语义保留）");
  check(/treeEl\.setAttribute\("aria-label", et\("tree\.aria"\)\)/.test(palMainSrc), "树的无障碍名字跟着界面语言走（renderTree 里设 aria-label）");
  check(/row\.setAttribute\("aria-level", String\(depth \+ 1\)\)/.test(palMainSrc) && /row\.setAttribute\("aria-selected", String\(n\.id === selectedId \|\| extraSel\.has\(String\(n\.id\)\)\)\)/.test(palMainSrc), "treeitem 带 aria-level / aria-selected（选择态与多选集合同源）");
  check(/if \(n\.children\.length\) row\.setAttribute\("aria-expanded", String\(expanded\)\)/.test(palMainSrc) && /const expanded = !n\.children\.length \|\| \(view\.filtering \|\| !collapsed\.has\(n\.id\)\)/.test(palMainSrc), "有子层的行才带 aria-expanded；展开态 = 过滤中忽略折叠（既有口径不变）");
  check(/row\.tabIndex = row\.dataset\.id === treeFocusId \? 0 : -1/.test(palMainSrc) && /treeFocusId = firstFocusable\(treeNavRows\(rows\), treeFocusId\)/.test(palMainSrc), "roving tabindex：全树只有焦点行 tabindex=0，焦点行不在视图里时退回第一行");
  check(/const action = treeNav\(treeNavRows\(rows\), rows\.indexOf\(row\), e\.key\)/.test(palMainSrc) && /if \(!action\) return;/.test(palMainSrc) && /if \(action\.kind === "expand"\) return void setTreeExpanded\(target, true\)/.test(palMainSrc) && /if \(action\.kind === "collapse"\) return void setTreeExpanded\(target, false\)/.test(palMainSrc), "树键盘语义交给 tree-nav.ts；无处可去时不 preventDefault；←→ 改折叠集合后重绘");
  check(/e\.shiftKey \|\| e\.metaKey \|\| e\.ctrlKey/.test(palMainSrc) && /startTreeDrag\(/.test(palMainSrc) && !/document\./.test(palNavSrc), "既有交互未被吃掉：⇧/⌘ 多选与拖拽改父级仍在；tree-nav.ts 是不碰 DOM 的纯函数");
  check(/\.ed-tree \.ed-node:focus-visible \{/.test(palCssSrc) && /outline: 2px solid var\(--wb-accent/.test(palCssSrc), "树行有可见焦点样式（键盘导航看得见焦点）");

  // tree-nav.ts 是纯函数：直接喂 fixture 断言键盘语义
  const palNavRows = [
    { id: "a", level: 1, hasChildren: true, expanded: true },
    { id: "a1", level: 2, hasChildren: false, expanded: false },
    { id: "b", level: 1, hasChildren: true, expanded: false },
    { id: "c", level: 1, hasChildren: false, expanded: false },
  ];
  const palDeep = [
    { id: "d", level: 1, hasChildren: true, expanded: true },
    { id: "d1", level: 2, hasChildren: true, expanded: true },
    { id: "d2", level: 3, hasChildren: false, expanded: false },
  ];
  const palNav1 = (i, k) => palNav.treeNav(palNavRows, i, k);
  check(json(palNav1(0, "ArrowDown")) === json({ kind: "focus", index: 1 }) && json(palNav1(3, "ArrowDown")) === json(null), "↓ 移动焦点到下一行，末行不再动");
  check(json(palNav1(3, "ArrowUp")) === json({ kind: "focus", index: 2 }) && json(palNav1(0, "ArrowUp")) === json(null), "↑ 移动焦点到上一行，首行不再动");
  check(json(palNav1(3, "Home")) === json({ kind: "focus", index: 0 }) && json(palNav1(0, "End")) === json({ kind: "focus", index: 3 }) && json(palNav1(0, "Home")) === json(null), "Home / End 到首尾，已在首/尾则不动");
  check(json(palNav1(2, "Enter")) === json({ kind: "focus", index: 2 }) && json(palNav1(1, " ")) === json({ kind: "focus", index: 1 }), "Enter / 空格确认当前行（返回同一行，由调用方同步选择）");
  check(json(palNav1(0, "ArrowRight")) === json({ kind: "focus", index: 1 }) && json(palNav1(2, "ArrowRight")) === json({ kind: "expand", index: 2 }), "→ 已展开的分支进第一个子行；未展开的分支先展开");
  check(json(palNav1(1, "ArrowRight")) === json(null) && json(palNav1(3, "ArrowRight")) === json(null), "→ 在叶子上无处可去（不 preventDefault）");
  check(json(palNav1(0, "ArrowLeft")) === json({ kind: "collapse", index: 0 }) && json(palNav1(1, "ArrowLeft")) === json({ kind: "focus", index: 0 }) && json(palNav1(2, "ArrowLeft")) === json(null), "← 展开的分支折叠；子行回到父行；根行不再往上");
  check(json(palNav.treeNav(palDeep, 2, "ArrowLeft")) === json({ kind: "focus", index: 1 }) && json(palNav.treeNav(palDeep, 1, "ArrowLeft")) === json({ kind: "collapse", index: 1 }), "← 在深层叶子回到最近的父行（跳过中间层）");
  check(json(palNav1(-1, "ArrowDown")) === json(null) && json(palNav1(4, "ArrowDown")) === json(null) && json(palNav1(0, "PageDown")) === json(null) && json(palNav1(0, "a")) === json(null), "越界索引 / 不认的键一律 null");
  check(palNav.firstFocusable(palNavRows, "b") === "b" && palNav.firstFocusable(palNavRows, "zzz") === "a" && palNav.firstFocusable(palNavRows, null) === "a" && palNav.firstFocusable([], "a") === null, "firstFocusable：焦点行还在就用它，否则退回第一行，空树 null");

  // ── B8：脚本事件模板（8 类生命周期，逐个对上引擎事件名） ──
  const palLives = ["update", "init", "applyUserProperties", "cursor", "media", "resizeScreen", "animationEvent", "destroy"];
  check(json([...palScripts.SCRIPT_LIFECYCLES]) === json(palLives), `脚本模板 8 类生命周期齐全且顺序固定（实得 ${json([...palScripts.SCRIPT_LIFECYCLES])}）`);
  const palTpl = (life) => palScripts.scriptTemplate("text", life);
  const palBadCompile = palLives.filter((life) => {
    const r = palCheck(palTpl(life));
    return !r.ok || r.noEntry;
  });
  check(palBadCompile.length === 0, `8 类模板都能编过且都有可派发入口（noEntry = 引擎会整份丢弃脚本）（失败 ${json(palBadCompile)}）`);
  check(palLives.filter((life) => !palTpl(life).startsWith("'use strict';")).length === 0, "模板以 'use strict'; 开头（沙箱约定）");
  check(new Set(palLives.map((life) => palTpl(life))).size === 8, "8 类模板两两不同（不是同一份模板换个注释）");
  const palEntries = (life) => palCheck(palTpl(life)).entries;
  check(json(palEntries("update")) === json(["update"]), "update（缺省）模板只声明 update 一个入口");
  const palBadEntries = palLives.filter((life) => {
    const es = palEntries(life);
    if (!es.includes("update")) return true;
    if (life === "destroy") return es.length !== 1;
    return !es.includes(life === "cursor" ? "cursorClick" : life === "media" ? "mediaLyricsChanged" : life);
  });
  check(palBadEntries.length === 0, `每类模板都带上该类入口 + 字段主回调 update（destroy 只有 update）（失败 ${json(palBadEntries)}）`);
  check(palEntries("cursor").length === 7 && palEntries("media").length === 7, `cursor / media 模板各 6 个回调 + update（实得 ${palEntries("cursor").length} / ${palEntries("media").length}）`);
  check(/export function destroy\(\)/.test(palTpl("destroy")) && !palEntries("destroy").includes("destroy"), "destroy 保留清理位，但引擎名单里没有它（不会被当成派发入口）");

  // 引擎口径：名单直接从 renderer 源码抽，模板里的入口名必须逐个来自它
  const palEngineList = (() => {
    const list = /SCRIPT_ENTRY_NAMES = Object\.freeze\(\[([\s\S]*?)\]\)/.exec(palEngineSrc)?.[1] ?? "";
    const media = /const MEDIA_CALLBACKS = \[([\s\S]*?)\]/.exec(palEngineSrc)?.[1] ?? "";
    const lits = (s) => [...s.matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]);
    return [...lits(list), ...lits(media)];
  })();
  const palEngineSet = new Set(palEngineList);
  check(palEngineList.length === 17 && palEngineList[0] === "update" && palEngineSet.has("resizeScreen") && palEngineSet.has("mediaLyricsChanged"), `引擎名单取自 we-scene/render/text.js 的 SCRIPT_ENTRY_NAMES + MEDIA_CALLBACKS（${palEngineList.length} 个）`);
  const palExported = [...new Set(palLives.flatMap((life) => [...palTpl(life).matchAll(/export function (\w+)\(/g)].map((m) => m[1])))];
  check(palExported.filter((n) => !palEngineSet.has(n) && n !== "destroy").length === 0, `模板里的入口名逐个来自引擎名单（destroy 是显式的非派发清理位）（生造 ${json(palExported.filter((n) => !palEngineSet.has(n) && n !== "destroy"))}）`);
  check(json(palExported.slice().sort()) === json([...palEngineSet, "destroy"].sort()), `模板导出名集合 = 引擎 17 个 + destroy（实得 ${palExported.length} 个）`);
  const palCursorTpl = [...palTpl("cursor").matchAll(/export function (\w+)\(/g)].map((m) => m[1]).filter((n) => n.startsWith("cursor")).sort();
  const palMediaTpl = [...palTpl("media").matchAll(/export function (\w+)\(/g)].map((m) => m[1]).filter((n) => n.startsWith("media")).sort();
  check(json(palCursorTpl) === json(palEngineList.filter((n) => n.startsWith("cursor")).sort()), `cursor 模板逐个对上引擎的 cursor* 事件名（${json(palCursorTpl)}）`);
  check(json(palMediaTpl) === json(palEngineList.filter((n) => n.startsWith("media")).sort()), `media 模板逐个对上引擎的 MEDIA_CALLBACKS（${json(palMediaTpl)}）`);
  const palCommentLeak = palLives.filter((life) => {
    const tpl = palTpl(life);
    return (tpl.match(/\bfunction\s+\w+\s*\(/g) ?? []).length !== (tpl.match(/export function \w+\(/g) ?? []).length;
  });
  check(palCommentLeak.length === 0, `模板注释里没出现 function <入口名>(（否则 checkSceneScript 会误判入口）（失败 ${json(palCommentLeak)}）`);

  const palType = (target) => /@param \{(\w+)\} value/.exec(palScripts.scriptTemplate(target))?.[1];
  check(palType("text") === "String" && palType("visible") === "Boolean" && palType("origin") === "Vec3" && palType("scale") === "Vec3" && palType("angles") === "Vec3" && palType("color") === "Vec3" && palType("opacity") === "Number", `模板 JSDoc 的字段类型按挂点给出（text→${palType("text")} / origin→${palType("origin")} / opacity→${palType("opacity")}）`);
  const palLegacyBad = ["text", ...palScripts.OBJECT_SCRIPT_FIELDS].filter((t) => json(palCheck(palScripts.scriptTemplate(t)).entries) !== json(["update"]));
  check(palLegacyBad.length === 0, `单参数 scriptTemplate(target) 仍只产出 update 入口（向后兼容既有判据）（失败 ${json(palLegacyBad)}）`);
  check(/tpl\.id = "script-template"/.test(palMainSrc) && /for \(const life of SCRIPT_LIFECYCLES\)/.test(palMainSrc) && /o\.textContent = et\(`sc\.tpl\.\$\{life\}`\)/.test(palMainSrc), "脚本面板有生命周期选择入口，选项文案走 sc.tpl.<life> 词条");
  check(/scriptTemplate\(t, tpl\.value as ScriptLifecycle\)/.test(palMainSrc) && /add\.id = "script-add"/.test(palMainSrc), "新建脚本按选中模板生成；既有 #script-add 入口仍在（headless 判据依赖它）");

  const palNeedI18n = [
    "pal.title", "pal.tip", "pal.keys", "pal.keysTip", "pal.close", "pal.ph", "pal.hint", "pal.empty",
    "pal.needArg", "pal.needArgHint", "pal.unavailable", "pal.runFailed",
    "tree.aria", "tree.expand", "tree.collapse", "sc.tpl", "sc.tplTip",
    "cmd.cat.edit", "cmd.cat.file", "cmd.cat.layer", "cmd.cat.export", "cmd.cat.other",
    ...palIds.map((id) => `cmd.${id}`),
    ...palLives.map((life) => `sc.tpl.${life}`),
  ];
  const palMissI18n = palNeedI18n.filter((k) => !palHasBoth(k));
  check(palMissI18n.length === 0, `M9 新增文案 i18n 中英成对（缺 ${json(palMissI18n)}）`);
  check(palZh.size === palEn.size && [...palZh.keys()].every((k) => palEn.has(k)), `词典 zh / en 键集合仍然对齐（zh ${palZh.size} / en ${palEn.size}）`);
  check(palZh.get("pal.hint") !== palEn.get("pal.hint") && palZh.get("tree.aria") !== palEn.get("tree.aria"), "面板提示与树的无障碍名字确实分了中英两版");
  check(/section\("AM\. M9 命令面板 \/ 无障碍 \/ 脚本事件模板"\)/.test(palHeadSrc), "真浏览器侧有「M9 命令面板 / 无障碍 / 脚本事件模板」用例（--headless 跑）");
}

// ───────────────────────────────────────────────────────────────────────────
// K / L. 真浏览器（--headless）
// ───────────────────────────────────────────────────────────────────────────
if (process.argv.includes("--headless")) {
  const { runEditorHeadless } = await imp("scripts/verify-editor-headless.mjs");
  await host.close();
  await runEditorHeadless({ check, section, tmpRoot, cleanups, LIB });
  const { runModelHeadless } = await imp("scripts/verify-editor-model.mjs");
  await runModelHeadless({ check, section, tmpRoot, LIB });
} else {
  console.log("\n（跳过真浏览器部分：加 --headless 跑，需要 Chrome + 会自起 dev server）");
}

console.log("");
if (failed > 0) {
  console.log(`✗ ${failed} 处问题（通过 ${passed}）`);
  process.exit(1);
}
console.log(`✓ 全部通过（${passed} 项）`);
process.exit(0);
