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
 *
 * 用法：
 *   node scripts/verify-editor.mjs              # 离线（A–J、M–P）
 *   node scripts/verify-editor.mjs --headless   # 追加 K、L、Q、R
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
  check(/overlayAssets\(opened\.assets\.entry, opened\.assets, \(\) => referencedModels\(doc\)\)/.test(main), "打开即套资源表叠加层，保存清单按文档引用过滤");
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
