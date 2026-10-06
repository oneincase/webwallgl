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
 *   L. 编辑器页端到端：打开、点选、检视器热改、复制 / 重排 / 删除、撤销重做、锁定、
 *      另存到壁纸库并重新打开
 *   Q. 新建端到端：模板新建 → 选图 / 拖入加层 → 撤销重做 → 存库 → 编辑器与测试台渲染页播放
 *   R. 草稿：编辑后刷新 → 横幅 → 恢复（新建 / 库来源）、丢弃、保存后清除
 *   T / U / V. 效果、脚本、用户属性面板端到端（像素判据 + 存库后测试台出帧一致）
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
    b.onResolve({ filter: /renderer\/src\/api\/editor$/ }, () => ({
      path: path.join(ROOT, "renderer/src/api/source.ts"),
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
  check(vid.doc.type === "video" && !vid.assets, "视频壁纸：只预览，无场景资源（保存 / 结构编辑不可用）");
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
  check(json(f.EFFECTS.map((e) => e.id)) === json(["tint", "adjust", "vignette", "blur", "wave", "scroll", "pulse"]), "基础集 7 个：颜色叠加 / 色彩调整 / 暗角 / 模糊 / 波浪 / 滚动 / 呼吸");
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
  check(/await replayLiveEdits\(\)/.test(main) && /editor\.seek\(resumeAt\)/.test(main), "重挂后重放热改、回到原时间点");
  for (const key of ['"z"', '"y"', '"s"', '"d"', '"Delete"', '"Backspace"']) {
    check(main.includes(key), `快捷键 ${key} 已绑定`);
  }
  check(/collectProject\(doc, current\.assets, preview\)/.test(main) && /saveToLibrary\(itemId, files, progress\)/.test(main), "保存走 collectProject → 目标写出");
  check(/from "\.\/create"/.test(main) && /from "\.\/assets"/.test(main) && /from "\.\/draft"/.test(main), "页面从 create.ts / assets.ts / draft.ts 取模板、资源表与草稿");
  check(/overlayAssets\(opened\.assets\.entry, opened\.assets, \(\) => referencedGroups\(doc\)\)/.test(main), "打开即套资源表叠加层，保存清单按文档引用过滤");
  check(/const referencedGroups = [^\n]*referencedModels\(d\)[^\n]*referencedEffects\(d\)/.test(main), "引用集合 = 图片层模型 ∪ 效果文件（写进来的效果随引用进出保存清单）");
  check(/from "\.\/effects"/.test(main) && /function objEdit\([^\n]*\) \{\s*structEdit\(/.test(main), "效果面板从 effects.ts 取定义，修改走结构编辑（可撤销、整场景重挂）");
  check(/overlay\.put\(f\.name, f\.data, effectFileOf\(fxId\)\)/.test(main), "添加效果时把四件写进叠加层，分组 = effect.json 路径");
  check(/inp\.addEventListener\("change", \(\) => commit\(/.test(main), "参数在 change 时提交（拖动中只更新读数，不反复重挂）");
  check(/checkSceneScript,\s*\n\s*editorOf,/.test(main) && /from "\.\/scripts"/.test(main), "脚本面板：预检取库出口 checkSceneScript，挂点读写取 editor/scripts.ts");
  check(/apply\.disabled = !editable \|\| !ok \|\| ta\.value === s\.script/.test(main), "语法不过 / 未改动时「应用」不可点");
  check(/objEdit\([^\n]*setScript\(o, s\.target, ta\.value\)\)/.test(main), "应用脚本走结构编辑（可撤销、整场景重挂，新脚本当帧生效）");
  check(/editor\?\.getScriptIssues\(\)/.test(main) && /refreshScriptIssues\(\);\s*\}, 500\)/.test(main), "运行期错误从控制面 getScriptIssues 取，定时刷新到对应挂点");
  check(/scriptDrafts\.clear\(\)/.test(main) && /scriptDrafts\.get\(draftKey\) \?\? s\.script/.test(main), "未应用的脚本改动在检视器重绘时保留，换文档清空");
  check(/from "\.\/userprops"/.test(main) && !/general\.properties\s*=/.test(main), "用户属性面板从 userprops.ts 读写声明 / 绑定（页面不直接改属性表）");
  check(/sourceFromDoc\(current\.source, current\.assets, JSON\.stringify\(doc\.scene\), doc\.project\)/.test(main), "文档挂载连 project 一起以文档为准（声明随重挂进引擎）");
  check(/restoreObjects\(cmd\.after, cmd\.selAfter, cmd\.propsAfter\)/.test(main) && /dir === "undo" \? cmd\.propsBefore : cmd\.propsAfter/.test(main), "结构编辑 / 撤销 / 重做把属性表快照一并换回");
  check(/if \(hot && editor && cmd\.after === cmd\.before\)/.test(main) && /editor\?\.declareUserProperties\(\{ \[name\]: p \}\)/.test(main), "只改属性表时走热更（declareUserProperties），不重挂");
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
  check(missingFx.length === 0, `效果名 / 参数名中英文都有（缺 ${json([...new Set(missingFx)])}）`);
  check(/structEdit\([^\n]*placeImages\(d, imgs, false\)\)/.test(main), "添加图片层走结构编辑（可撤销、整场景重挂）");
  check(/files\.every\(\(f\) => isImageFile\(f\.file\)\)\) void dropImages/.test(main), "拖入全是图片时走图片成层 / 新建");
  check(/dirty = false;\s*discardDraft\(\);/.test(main), "保存成功后清掉草稿");
  check(/function markDirty\(\) \{\s*scheduleDraft\(\);/.test(main), "每次编辑都排一次草稿快照");
  const html = fs.readFileSync(path.join(ROOT, "editor/index.html"), "utf8");
  check(/id="tb-new"(?![^>]*disabled)/.test(html) && /id="ly-add"/.test(html) && /id="in-image" accept="image\/\*"/.test(html) && /id="ed-draft"/.test(html), "页面：新建可用，有添加图片 / 图片选择框 / 草稿横幅");
  check(/const EDITOR_MARK = "\.webwallgl-editor"/.test(HOST_TS) && /exists && !marked/.test(HOST_TS), "宿主：无标记目录拒绝覆盖");
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
  const mutAs = asSrc.replace(".filter((f) => !f.group || refs.has(f.group))", ".filter(() => true)");
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
}

// ───────────────────────────────────────────────────────────────────────────
// K / L. 真浏览器（--headless）
// ───────────────────────────────────────────────────────────────────────────
if (process.argv.includes("--headless")) {
  const { runEditorHeadless } = await imp("scripts/verify-editor-headless.mjs");
  await host.close();
  await runEditorHeadless({ check, section, tmpRoot, cleanups, LIB });
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
