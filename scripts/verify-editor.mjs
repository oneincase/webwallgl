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
  try {
    await openMod.openLocalFiles([localFile("w/project.json", enc.encode(json({ type: "web", file: "index.html" })))]);
  } catch (e) {
    msg = e.message;
  }
  check(/网页壁纸/.test(msg), "本地网页壁纸目录明确报不支持");
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
  process.env.WE_LIBRARY = libDir;
  const mod = await loadHostModule(srcText);
  const plugin = mod.wallpaperHost();
  if (prev === undefined) delete process.env.WE_LIBRARY;
  else process.env.WE_LIBRARY = prev;
  const handlers = [];
  plugin.configureServer({ config: { logger: { info() {}, warn() {}, error() {} } }, middlewares: { use: (fn) => handlers.push(fn) } });
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
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
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
  check(json(f.EFFECTS.map((e) => e.id).slice(7)) === json(["outline", "glow", "chroma", "pixelate", "shine", "fade"]), "扩充集 6 个：描边 / 外发光 / 色差 / 像素化 / 扫光 / 渐隐遮罩");
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
  check(f.effectIdOf("effects/waterripple/effect.json") === null && f.effectIdOf("effects/wwgl_nope/effect.json") === null && f.effectIdOf(3) === null, "官方效果 / 未知 id / 非字符串 → null（面板只读展示）");

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
  check(/const info = editor && Number\.isFinite\(id\) \? editor\.getModelInfo\(id\) : null;/.test(mainSrc) && /if \(node\.modelForm\) inspectorEl\.appendChild\(modelGroup\(node\)\);/.test(mainSrc) && /modelInfoRows\(info\)/.test(mainSrc), "检视器「模型」分组：信息只经 getModelInfo，行由 modelInfoRows 排");
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
  check(/const att = attachGroup\(node\);/.test(mainSrc) && /drawAttachMarkers\(\);\s*(drawBoneMarkers\(\);\s*)?\}/.test(mainSrc), "检视器「挂到模型」分组 + 视口附着点十字标记");
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
  check(/if \(node\.modelForm\) inspectorEl\.appendChild\(animLayersGroup\(node\)\);/.test(mainSrc) && /editor\s*\.setAnimationLayers\(/.test(mainSrc) && /animSolo = null;\s*const gen = \+\+openGen;/.test(mainSrc) && /if \(animSolo && animSolo\.id !== selectedId\) endAnimSolo\(\);/.test(mainSrc),
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
  check(/const mt = node\.modelForm \? modelTexGroup\(node\) : null;/.test(mainSrc) && /function modelTexGroup\(node: LayerNode\)[\s\S]{0,200}editor\.getModelInfo\(id\)[\s\S]{0,900}modelTextureSlots\(info\)/.test(mainSrc), "检视器：模型层有「子网格贴图」分组，行来自 getModelInfo");
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
  check(/const bn = node\.modelForm \? boneGroup\(node\) : null;/.test(mainSrc) && /function boneGroup\(node: LayerNode\)[\s\S]{0,300}editor\.getModelInfo\(id\)/.test(mainSrc), "检视器：模型层有「骨骼」分组，骨骼 / 片段来自 getModelInfo");
  check(/\.setBonePose\(id, pick\.bone, dirty\(\) \? boneDeltaOf\(pick\) : null\)/.test(mainSrc) && /inp\.addEventListener\("input", \(\) => \{[\s\S]{0,160}preview\(\);/.test(mainSrc),
    "输入即推引擎预览（setBonePose，文档不动）");
  check(/const r = out && mdlCopyFiles\(modelJson, out, slug\);[\s\S]{0,200}for \(const f of r\.files\) assets\.put\(f\.name, f\.data, r\.path\);\s*assets\.share\(from, r\.path\);/.test(mainSrc) &&
    /if \(puppetMdl\) d\.puppets = new Map\(\[\.\.\.\(d\.puppets \?\? \[\]\), \[r\.path, puppetMdl\]\]\);/.test(mainSrc) && /if \(puppetMdl\) n\.obj\.image = r\.path;\s*else n\.obj\.model = r\.path;\s*mutate\?\.\(n\.obj\);/.test(mainSrc) &&
    /function applyBoneEdit\([\s\S]{0,400}commitMdlEdit\([\s\S]{0,200}applyBoneDelta\(bytes, e\.animId, e\.bone, e\.frame, e\.delta, e\.radius\)/.test(mainSrc),
    "应用：commitMdlEdit 写时复制 + 继承旧副本文件 + puppet 登记 + 结构编辑改指向（可撤销、重挂）");
  check(/function drawBoneMarkers\(\)[\s\S]{0,300}editor\.getBonePoints\(/.test(mainSrc) && /drawAttachMarkers\(\);\s*drawBoneMarkers\(\);/.test(mainSrc), "视口：骨骼关节 / 父子连线来自 getBonePoints");
  check(/if \(bn\) inspectorEl\.appendChild\(bn\);\s*else dropBonePick\(\);/.test(mainSrc) && /if \(!node\) \{\s*dropBonePick\(\);/.test(mainSrc), "离开模型层撤掉骨骼预览");
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
  check(/const cl = node\.modelForm \? clipsGroup\(node\) : null;/.test(mainSrc) && /function clipsGroup\(node: LayerNode\)[\s\S]{0,300}editor\.getModelInfo\(id\)/.test(mainSrc), "检视器：模型层有「动画片段」分组，片段来自 getModelInfo");
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
  const mm2 = sk.models.find((x) => x.name === "skinned" && x.target === "mesh").files;
  const mmat = JSON.parse(dec.decode(mm2.files.find((f) => f.name === "materials/editor/t_0.json").data));
  check(mm2.path === "models/editor/t.mdl" && !mm2.files.some((f) => f.name.endsWith(".json") && f.name.startsWith("models/")) && mmat.passes[0].shader === "generic4" && mmat.passes[0].cullmode === "nocull",
    "网格产物：只有 .mdl（对象 model 直接指它）+ 每个 glTF 材质一份 generic4 材质（doubleSided → nocull）");
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
  const pDoc = mk.makeDoc("t", null, { general: {}, camera: { center: "1 2 3", eye: "1 2 13" }, objects: [] }, "loose");
  G.addModelLayer(pDoc, mr.m, "models/editor/t.mdl", "Arm");
  check(pDoc.scene.objects[0].model === "models/editor/t.mdl" && pDoc.scene.objects[0].origin === "1.00000 2.00000 3.00000" && !("image" in pDoc.scene.objects[0]) && near(G.fitMeshScale(pDoc)(Float64Array.of(-1, -1, -1, 1, 1, 1)), 10 / 3 / Math.sqrt(3)),
    "addModelLayer（网格）：model 指 .mdl、放在相机注视点；缺省缩放 = 相机距离 / 3 / 包围球半径");
  const tree = mk.buildLayerTree(orthoDoc.scene, new Map([["models/editor/t.json", "models/editor/t.mdl"]]));
  check(tree.roots.at(-1).modelForm === "puppet" && mk.buildLayerTree(pDoc.scene, new Map()).roots[0].modelForm === "mesh", "导入层在图层树里认作模型层（puppet / mesh），模型面板全部可用");

  const mainSrc = fs.readFileSync(path.join(ROOT, "editor/main.ts"), "utf8");
  check(/files\.some\(\(f\) => isModelFile\(f\.file\)\) && doc\?\.scene\) \{\s*void importModelFiles/.test(mainSrc) && /lyAddModelEl\.onclick = \(\) => inModelEl\.click\(\);/.test(mainSrc) && /lyAddModelEl\.disabled = lyAddEl\.disabled;/.test(mainSrc),
    "页面：图层栏「导入模型」按钮 + 拖入 .glb / .gltf（连同 .bin / 贴图）");
  check(/for \(const x of r\.files\) assets\.put\(x\.name, x\.data, r\.path\);[\s\S]{0,200}target\.puppets = new Map[\s\S]{0,400}structEdit\([\s\S]{0,300}addModelLayer\(d, m, r\.path/.test(mainSrc),
    "导入：产物进资源表（分组 = 对象引用路径）、puppet 登记到 doc.puppets，加层是一步结构编辑（可撤销）");
  check(/id="in-model" accept="\.glb,\.gltf,\.bin,\.png,\.jpg,\.jpeg" multiple hidden/.test(fs.readFileSync(path.join(ROOT, "editor/index.html"), "utf8")) && /id="ly-add-model"/.test(fs.readFileSync(path.join(ROOT, "editor/index.html"), "utf8")), "页面有导入按钮与多选文件框");
  const i18nSrc = fs.readFileSync(path.join(ROOT, "editor/i18n.ts"), "utf8");
  const glSrc = fs.readFileSync(path.join(ROOT, "editor/gltf.ts"), "utf8");
  const warnCodes = [...new Set([...glSrc.matchAll(/warn\(\{ code: "(\w+)"/g)].map((m) => m[1]))];
  const failCodes = [...glSrc.matchAll(/new GltfError\("(\w+)"/g)].map((m) => m[1]);
  const keys = ["ly.addModel", "gl.form.puppet", "gl.form.mesh", "log.modelImported", "gl.fail.noModel", ...new Set(failCodes.map((c) => `gl.fail.${c}`)), ...warnCodes.map((c) => `gl.warn.${c}`)];
  const missing = keys.filter((k) => (i18nSrc.match(new RegExp(`"${k.replace(/\./g, "\\.")}":`, "g")) ?? []).length !== 2);
  check(warnCodes.length >= 10 && missing.length === 0, `导入文案中英文都有，每个告警 / 失败码都有文案（${warnCodes.length} 个告警码，缺 ${json(missing)}）`);
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
  check(/isLocked\(selectedId\)[^\n]*return;/.test(main), "锁定层不能拖拽");
  check(/form\.disabled = isLocked\(id\)/.test(main), "锁定层检视器只读");
  check(/docDriven && current\.assets && doc\?\.scene\s*\?\s*sourceFromDoc/.test(main), "结构编辑后改从文档挂载");
  check(/await replayLiveEdits\(\)/.test(main) && /editor\.seek\(resumeAt > 0 \? resumeAt : editor\.time\)/.test(main), "重挂后重放热改、回到原时间点（停着时也补画一帧，文字层首帧没贴图）");
  for (const key of ['"z"', '"y"', '"s"', '"d"', '"Delete"', '"Backspace"']) {
    check(main.includes(key), `快捷键 ${key} 已绑定`);
  }
  check(/collectProject\(doc, current\.assets, preview\)/.test(main) && /writeToDirectory\(dir, changed\)/.test(main) && !/saveToLibrary\(/.test(main), "自动保存走 collectProject 写进项目文件夹，页面不再写壁纸库");
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
  check(/if \(kind === "pkg" && doc\.scene\) \{\s*const \{ files: pkgFiles, packed \} = packProject\(files\);\s*files = pkgFiles;/.test(main), "导出 scene.pkg 时清单先过 packProject，不写进项目文件夹");
  check(/id="export-pkg"/.test(html) && /id="export-zip"/.test(html) && !/id="save-lib"/.test(html) && !/id="ed-library"/.test(html), "导出菜单是 scene.pkg / zip，没有壁纸库面板和另存到库");
  check(["save.pkg", "save.pkgTitle", "log.packedPkg"].every((k) => (i18n.match(new RegExp(`"${k.replace(".", "\\.")}":`, "g")) ?? []).length === 2), "导出 pkg 的文案中英文都有");
  const saveTs = fs.readFileSync(path.join(ROOT, "editor/save.ts"), "utf8");
  check(/import \{ buildScenePkg, type ScenePkgResult \} from "\.\.\/renderer\/src\/api\/editor";/.test(saveTs) && !/writePkg|encodeTex/.test(saveTs), "页面只经库出口 buildScenePkg 打包（不直连 vendor 编码器）");
  const devPack = fs.readFileSync(path.join(ROOT, "scripts/dev-pack-pkg.mjs"), "utf8");
  check(/import \{ writePkg \} from "\.\.\/renderer\/vendor\/we-scene\/pkg\/container\.js";/.test(devPack) && !/writeUInt32LE|Buffer\.concat/.test(devPack), "dev-pack-pkg 不再有第二份容器写实现");
  check(/from "\.\/text"/.test(main) && /structEdit\(et\("log\.textAdded", \{ name \}\), \(d\) => addTextLayer\(d, preset, name, et\("text\.defaultValue"\), measureText\)/.test(main), "添加文字层取 text.ts 模板、走结构编辑（可撤销、整场景重挂）");
  check(/objEdit\(et\("log\.textEdited"[^\n]*\n\s*if \(!mutate\(o\)\) return false;\s*refitTextBox\(o, measureText\);/.test(main), "文字字段编辑走结构编辑，改完按页面实测宽度回填盒子");
  check(/await Promise\.all\(fonts\.map\(ensurePageFont\)\);/.test(main) && /SYSTEM_FONT_FAMILIES\[font\.toLowerCase\(\)\]/.test(main), "量字前先把工程字体装进页面；系统字体按引擎同一张映射表量");
  check(/overlay\.put\(path, new Uint8Array\(await file\.arrayBuffer\(\)\), path\);/.test(main), "导入字体写进叠加层，分组 = 字体路径（没被引用就不进保存清单）");
  check(/if \(node\.kind === "text"\) inspectorEl\.appendChild\(textGroup\(node\)\);/.test(main) && /content\.readOnly = scripted;/.test(main), "文字层检视器有「文字」分组；脚本生成的内容只读");
  check(/id="ly-add-text"/.test(html) && /id="text-menu"/.test(html) && ["plain", "clock", "date"].every((p) => html.includes(`data-preset="${p}"`)) && /id="in-font" accept="\.ttf,\.otf/.test(html), "页面：添加文字层按钮 + 文字 / 时钟 / 日期菜单 + 字体选择框");
  const txKeys = [...main.matchAll(/et\(\s*"((?:tx|text)\.[\w.]+)"/g)].map((m) => m[1]).concat(["ly.addText", "text.plain", "text.clock", "text.date", "tx.align.left", "tx.align.center", "tx.align.right", "tx.align.top", "tx.align.bottom", "log.textAdded", "log.textEdited", "log.fontImported", "log.fontFailed", "insp.text"]);
  const missingTx = [...new Set(txKeys)].filter((k) => (i18n.match(new RegExp(`"${k.replace(/\./g, "\\.")}":`, "g")) ?? []).length !== 2);
  check(missingTx.length === 0, `文字层文案中英文都有（缺 ${json(missingTx)}）`);
  check(/from "\.\/particles"/.test(main) && /structEdit\(et\("log\.particleAdded", \{ name \}\), \(d\) => \{[^}]*overlay!\.put\(f\.name, f\.data, particlePathOf\(slug\)\);\s*return addParticleLayer\(d, preset, name, slug\)/.test(main), "添加粒子层取 particles.ts 模板、两件套写进叠加层（分组 = 粒子文件路径）、走结构编辑");
  check(/if \(node\.kind === "particle"\) inspectorEl\.appendChild\(particleGroup\(node\)\);/.test(main) && /setParticleParam\(o, k as ParticleParam, Number\(inp\.value\)\)/.test(main) && /objEdit\(et\("log\.particleEdited"/.test(main), "粒子层检视器有「粒子」分组，滑条 change 时经 objEdit 写 instanceoverride（可撤销）");
  check(/id="ly-add-particle"/.test(html) && /id="particle-menu"/.test(html) && ptMod.PARTICLE_PRESETS.every((p) => html.includes(`data-preset="${p}"`)) && /lyAddParticleEl\.disabled = lyAddEl\.disabled;/.test(main), "页面：添加粒子层按钮 + 雪 / 雨 / 火花 / 光点菜单，可用性跟随添加图片");
  const ptKeys = [...main.matchAll(/et\(\s*"((?:pt)\.[\w.]+)"/g)].map((m) => m[1]).concat(["ly.addParticle", "log.particleAdded", "log.particleEdited", "insp.particle"], ptMod.PARTICLE_PRESETS.map((p) => `pt.${p}`), ptMod.PARTICLE_PARAMS.map((p) => `pt.${p}`));
  const missingPt = [...new Set(ptKeys)].filter((k) => (i18n.match(new RegExp(`"${k.replace(/\./g, "\\.")}":`, "g")) ?? []).length !== 2);
  check(missingPt.length === 0, `粒子层文案中英文都有（缺 ${json(missingPt)}）`);
  check(/from "\.\/sound"/.test(main) && /overlay\.put\(path, new Uint8Array\(await file\.arrayBuffer\(\)\), path\);\s*return path;/.test(main) && /structEdit\(et\("log\.soundAdded"[^\n]*\n[^\n]*\n\s*for \(const it of items\) last = addSoundLayer\(d, it\.name, it\.path\)/.test(main), "添加声音层取 sound.ts、音频原字节写进叠加层（分组 = 自身路径）、走结构编辑");
  check(/files\.every\(\(f\) => isAudioFile\(f\.file\)\)\) \{\s*void addSoundFiles\(files\.map\(\(f\) => f\.file\)\)/.test(main), "拖入全是音频时加声音层");
  check(/if \(node\.kind === "sound"\) inspectorEl\.appendChild\(soundGroup\(node\)\);/.test(main) && /objEdit\(et\("log\.soundEdited"[^\n]*setSoundField\(o, field, v\)\)/.test(main) && /replaceSoundFile\(o, path\)/.test(main), "声音层检视器有「声音」分组，模式 / 音量 / 开始静音 / 替换音频经 objEdit（可撤销）");
  check(/const au = new Audio\(url\);/.test(main) && /stopPreview\(\);\s*overlay =/.test(main) && /volume: 0,/.test(main), "试听用页面自己的 audio 元素（引擎恒静音挂载），换文档即停");
  check(/id="ly-add-sound"/.test(html) && /id="in-sound" accept="\.mp3,\.ogg,\.wav,\.flac/.test(html) && /lyAddSoundEl\.disabled = lyAddEl\.disabled;/.test(main), "页面：添加声音层按钮 + 音频选择框，可用性跟随添加图片");
  const sndKeys = [...main.matchAll(/et\(\s*"((?:snd)\.[\w.]+)"/g)].map((m) => m[1]).concat(["ly.addSound", "log.soundAdded", "log.soundEdited", "log.soundMissing", "log.soundFailed", "insp.sound"], sndMod.PLAYBACK_MODES.map((m) => `snd.mode.${m}`));
  const missingSnd = [...new Set(sndKeys)].filter((k) => (i18n.match(new RegExp(`"${k.replace(/\./g, "\\.")}":`, "g")) ?? []).length !== 2);
  check(missingSnd.length === 0, `声音层文案中英文都有（缺 ${json(missingSnd)}）`);
  check(/from "\.\/keyframes"/.test(main) && /const split = splitAnimated\(node\.obj, patch\);[\s\S]{0,200}pendingKeys\.set\([\s\S]{0,80}writeObjProps\(node\.obj, plain\);[\s\S]{0,120}mergeLiveEdit\(liveEdits, id, plain\);/.test(main), "热改：落在动画字段上的改动不写静态值、不进重放账，记为待落关键帧");
  check(/function commit\(cmd: PropsCmd\) \{\s*const keyed = pendingKeys\.get\(String\(cmd\.id\)\);[\s\S]{0,200}keyEdit\(node, keyed\);/.test(main) && /setKey\(o, f, frameAt\(v, t\), keyed\[f\]!\)/.test(main), "提交（检视器 change / 拖拽松手）时，动画字段的改动变成当前帧的关键帧（objEdit，可撤销）");
  check(/if \(canAnimate\(node\)\) inspectorEl\.appendChild\(animGroup\(node\)\);/.test(main) && /enableAnim\(o, f, liveValue\(node, f\)\) : disableAnim\(o, f, liveValue\(node, f\)\)/.test(main) && /removeKey\(o, f, k\.frame\)/.test(main) && /setAnimOption\(o, f, "mode"/.test(main) && /setSmooth\(o, f, smooth\.checked\)/.test(main), "检视器「动画」分组：开关 / 打关键帧 / 删关键帧 / 模式 / 时长 / 插值，全走 objEdit");
  check(/tlRangeEl\.addEventListener\("change", \(\) => \{\s*scrubbing = false;\s*if \(editor\) afterSeek\(/.test(main) && /afterSeek\(editor\.step\(1, 60\)\)/.test(main) && /function renderInspector\(\) \{\s*(?:if \(animSolo[^\n]*\n\s*)?inspectorEl\.textContent = "";\s*renderKeyMarks\(\);/.test(main), "拖完时间轴 / 逐帧后刷新动画层检视器；选中变化时重画时间轴关键帧标记");
  check(/for \(const run of animRuns\) \{\s*if \(run\.layer === l && \(p as Record<string, unknown>\)\[run\.field\] !== undefined\) run\.held = true;/.test(sm) && /else run\.ctrl\.advance\(clockDt\);\s*if \(run\.held\) continue;/.test(sm) && /animSeekPending = true;\s*for \(const run of animRuns\) run\.held = false;/.test(sm), "引擎：热改动画字段后曲线写回暂停到下一次 seek（拖拽 / 输入跟手）");
  check(/if \(field === "color" && run\.layer\.isText\) run\.layer\.textColor = run\.layer\.color;/.test(sm) && /field === "color" && run\.layer\.matTint && run\.layer\.tintBase\) \{[\s\S]{0,200}?anim\.writeAnimSlot\(run\.layer\.tintBase, "color", out\);\s*applyBuiltinMatTint\(run\.layer\);/.test(sm), "引擎：颜色曲线写到文字层真正绘制的 textColor / 材质烘色层的 tintBase");
  check(/m\.addEventListener\("pointerdown", \(e\) => startKeyDrag\(e, m, n, t\)\)/.test(main) && /\(o\) => moveKeyTime\(o, from, to\)/.test(main) && /log\(et\("log\.keyMoveBad"/.test(main), "时间轴关键帧标记可拖动改时刻（objEdit，冲突时提示并复原）");
  check(/row\.addEventListener\("pointerdown", \(e\) => startTreeDrag\(e, n, row\)\)/.test(main) && /\(res = placeLayer\(d, n\.id, target\.id, where\)\) === "ok"/.test(main) && /if \(treeDragged\) return;/.test(main), "图层树行可拖：放下走 placeLayer 结构编辑，拖完不误触点选");
  check(/isLockedObj\(n\.obj\)/.test(main) && /setLocked\(n\.obj, !isLocked\(n\.id\)\);\s*markDirty\(\);/.test(main) && !/const locked = new Set/.test(main), "锁定状态以文档 locktransforms 为准（页面不再另存一份）");
  check(/id="ly-group"/.test(fs.readFileSync(path.join(ROOT, "editor/index.html"), "utf8")) && /groupLayer\(d, n\.id, et\("layer\.groupName"\)\)/.test(main), "图层工具条「成组」");
  check(/if \(drag\.box && drag\.snap && !\(e\.metaKey \|\| e\.ctrlKey\)\) \{\s*const r = snapMove\(drag\.box, dx, dy, drag\.snap\);/.test(main) && /screenDeltaToLocal\(Number\(drag\.id\), mx, my\)/.test(main) && /snapTargets\(sceneFrame\(fitEl\.value, r\.width, r\.height, res\.w, res\.h\), others\)/.test(main), "视口移动走吸附（⌘ / Ctrl 关），候选 = 画面框（按当前 fit）+ 其他层");
  check(/if \(!l\.visible \|\| insideSelf\(l\)\) continue;/.test(main) && /handle \? \{ box: null, snap: null \}/.test(main) && /drag = null;\s*snapGuides = null;/.test(main), "吸附只对移动生效；自己与子层、隐藏层不当候选；松手清参考线");
  check(/if \(e\.shiftKey \|\| e\.metaKey \|\| e\.ctrlKey\) return toggleSelect\(n\.id\);/.test(main) && /if \(e\.shiftKey && hits\.length\) \{\s*toggleSelect\(hits\[0\]\.id\);/.test(main) && /\.some\(\(h\) => isSelected\(h\.id\)\)/.test(main), "多选：树 ⇧/⌘ 点、画面 ⇧ 点加减选；拖任一选中层都能起拖");
  check(/for \(const o of drag\.others\) \{\s*const od = editor\.screenDeltaToLocal\(Number\(o\.id\), mx, my\);/.test(main) && /commitMany\(et\("log\.multiMoved"/.test(main) && /if \(isBatch\(cmd\)\) \{\s*for \(const c of cmd\.cmds\) void applyPatch/.test(main), "多选移动：其余层按同一屏幕位移跟随，一步撤销（批量命令）");
  check(/groupLayers\(d, ids, et\("layer\.groupName"\)\)/.test(main) && /ids\.every\(\(id\) => removeLayer\(d, id\)\)/.test(main) && /alignDeltas\(items\.map\(\(i\) => i\.box\), mode\)/.test(main), "多选删除 / 复制 / 成组 / 对齐分布接线");
  check(/let userPlaying = false;/.test(main) && /if \(!userPlaying\) inst\.pause\(\);/.test(main) && /origin = opts\.origin \?\? null;\s*userPlaying = false;/.test(main), "默认不自动播放：打开文档与重挂都停在当前帧，只有点播放才走时钟");
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
// J. 变异红测
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
  const hm2 = await vendorMut(HTP, "      if ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax) === 0) continue\n", "", "零面积三角形跳过");
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
