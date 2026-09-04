#!/usr/bin/env node
/**
 * 文字对象（组件挂件）渲染的离线校验：不依赖浏览器、不依赖 Canvas。
 *
 * 校验两块可以纯数值验证的逻辑：
 *   1. 布局：wrap / 限行省略号 / 对齐 / padding 的盒内坐标（measure 注入等宽近似）；
 *   2. 脚本：本机壁纸库全部 text.script 跑沙箱求值 —— 解析失败必须为 0，
 *      时钟/日期类脚本的结果与真实时间对得上。
 *
 * 用法：
 *   node scripts/verify-text.mjs            两项都跑
 *   node scripts/verify-text.mjs layout     只跑布局
 *   node scripts/verify-text.mjs script     只跑脚本
 *   WE_LIBRARY=/path/to/wallpapers node scripts/verify-text.mjs
 *
 * 退出码非 0 表示发现问题，可直接用于 CI。
 */
import fs from "node:fs";
import { join } from "node:path";

import { LIB, ROOT, imp } from "./lib/verify-kit.mjs";
const wtext = await imp("renderer/vendor/we-scene/render/text.js");
const engTimers = await imp("renderer/vendor/we-scene/render/engine-timers.js");
const parseMod = await imp("renderer/vendor/we-scene/scene/parse.js");
const userPropsMod = await imp("renderer/vendor/we-scene/scene/user-props.js");
const fontSanMod = await imp("renderer/vendor/we-scene/render/font-sanitize.js");
const pkgMod = await imp("renderer/vendor/we-scene/pkg/container.js");

// ---------- scene.pkg 读取（container.js 的最小子集，避免拖入浏览器依赖） ----------

function parsePkg(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const magicLen = dv.getUint32(0, true);
  let magic = "";
  for (let i = 4; i < 4 + magicLen; i++) magic += String.fromCharCode(buf[i]);
  if (!magic.startsWith("PKGV")) throw new Error("不是 scene.pkg: " + magic);
  const count = dv.getUint32(4 + magicLen, true);
  let p = 4 + magicLen + 4;
  const entries = [];
  for (let i = 0; i < count; i++) {
    const nameLen = dv.getUint32(p, true);
    p += 4;
    const name = new TextDecoder("utf-8").decode(buf.subarray(p, p + nameLen));
    p += nameLen;
    const offset = dv.getUint32(p, true);
    p += 4;
    const size = dv.getUint32(p, true);
    p += 4;
    entries.push({ name, offset, size });
  }
  return { entries, dataStart: p, buf };
}
function getEntry(pkg, name) {
  const e = pkg.entries.find((x) => x.name === name);
  if (!e) return null;
  return pkg.buf.subarray(pkg.dataStart + e.offset, pkg.dataStart + e.offset + e.size);
}
const readText = (b) => new TextDecoder().decode(b);

// ---------- 布局校验（等宽 measure：1 字符 = 10px） ----------

function runLayout() {
  const errors = [];
  const CHAR_W = 10;
  const measure = (s) => s.length * CHAR_W;
  const eq = (a, b, msg) => {
    if (Math.abs(a - b) > 0.51) errors.push(`${msg}: 期望 ${b} 实得 ${a}`);
  };

  // 1) 单行居中：盒子 200×100，文本 5 字符（50px）→ x=(200-50)/2=75, y=(100-31.25)/2
  {
    const l = wtext.layoutText("hello", { boxW: 200, boxH: 100, pointsize: 25, lineHeight: 31.25, halign: "center", valign: "center" }, measure);
    eq(l.lines[0].x, 75, "单行居中 x");
    eq(l.lines[0].y, (100 - 31.25) / 2, "单行居中 y");
    if (l.lines.length !== 1) errors.push("单行应只有 1 行");
  }
  // 2) 左/顶对齐贴盒子中线（= 层 origin），不是贴盒边（WE 语义，见 text-layout 注释）
  {
    const l = wtext.layoutText("hi", { boxW: 200, boxH: 100, pointsize: 20, lineHeight: 25, padding: 12, halign: "left", valign: "top" }, measure);
    eq(l.lines[0].x, 100, "左对齐贴 origin（盒中线）x");
    eq(l.lines[0].y, 50, "顶对齐贴 origin（盒中线）y");
  }
  // 3) 右对齐：行右缘贴盒中线
  {
    const l = wtext.layoutText("abcd", { boxW: 200, boxH: 100, pointsize: 20, lineHeight: 25, padding: 10, halign: "right" }, measure);
    eq(l.lines[0].x, 100 - 40, "右对齐 x");
  }
  // 4) 限宽换行：40 字符 400px，盒内宽 150 → 每行 ≤15 字符，且空格处断行
  {
    const text = "aaa bbb ccc ddd eee fff ggg hhh iii jjj kkk lll mmm"; // 51 字符
    const l = wtext.layoutText(text, { boxW: 170, boxH: 500, pointsize: 20, lineHeight: 25, limitwidth: true, maxwidth: 150, halign: "left" }, measure);
    if (l.lines.length < 3) errors.push(`换行后应 ≥3 行，实得 ${l.lines.length}`);
    for (const ln of l.lines) {
      if (ln.width > 150 + 0.51) errors.push(`行宽超限: ${ln.width} (${ln.text})`);
    }
    // 空格断行：除最后一行外，行尾不应是空格、下一行行首不应是空格
    for (let i = 0; i < l.lines.length - 1; i++) {
      if (l.lines[i].text.endsWith(" ")) errors.push("断行点吃进了行尾空格");
      if (l.lines[i + 1].text.startsWith(" ")) errors.push("断行点吃进了行首空格");
    }
    // 拼回（去空格差异）应与原文等长 —— 无字符丢失
    const joined = l.lines.map((x) => x.text).join("").replace(/ /g, "");
    if (joined !== text.replace(/ /g, "")) errors.push("换行丢失字符");
  }
  // 5) 限行 + 省略号：6 行内容限 2 行 → 2 行且带 …，且 … 后宽度不超限
  {
    const text = "aaaa\nbbbb\ncccc\ndddd\neeee\nffff";
    const l = wtext.layoutText(text, { boxW: 300, boxH: 300, pointsize: 20, lineHeight: 25, limitrows: true, maxrows: 2, limituseellipsis: true }, measure);
    if (l.lines.length !== 2) errors.push(`限 2 行实得 ${l.lines.length}`);
    if (!l.truncated) errors.push("应标记 truncated");
    if (!l.lines[1].text.endsWith("…")) errors.push("截断行应以省略号结尾");
    if (l.lines[1].width > 300 + 0.51) errors.push("省略号行超宽");
    if (!l.lines[0].text.startsWith("aaaa")) errors.push("截断保留首行内容");
  }
  // 6) 多行垂直居中：3 行 × 行高 25 = 75，盒高 100 → y0 = 12.5
  {
    const l = wtext.layoutText("a\nb\nc", { boxW: 100, boxH: 100, pointsize: 20, lineHeight: 25, valign: "center" }, measure);
    eq(l.lines[0].y, 12.5, "多行垂直居中 y0");
    eq(l.lines[2].y, 12.5 + 50, "第三行 y");
  }
  // 7) CJK 无空格硬断
  {
    const text = "一二三四五六七八九十"; // 10 字 100px，限 40px
    const l = wtext.layoutText(text, { boxW: 60, boxH: 300, pointsize: 20, lineHeight: 25, limitwidth: true, maxwidth: 40, halign: "left" }, measure);
    if (l.lines.length !== 3) errors.push(`CJK 硬断应 3 行实得 ${l.lines.length}`);
    const joined = l.lines.map((x) => x.text).join("");
    if (joined !== text) errors.push("CJK 硬断丢字");
  }
  // 8) \n 显式换行与空行保留
  {
    const l = wtext.layoutText("a\n\nb", { boxW: 100, boxH: 300, pointsize: 20, lineHeight: 25 }, measure);
    if (l.lines.length !== 3) errors.push(`显式换行应 3 行（含空行）实得 ${l.lines.length}`);
  }
  // 9) 编辑器默认 padding=32 装不进小盒子时当 0（3122339805 日历格 36×42、标题 51×23）
  {
    if (typeof wtext.effectiveTextPadding !== "function") {
      errors.push("text.js 未导出 effectiveTextPadding");
    } else {
      eq(wtext.effectiveTextPadding(36, 42, 32), 0, "日历格 padding=32 应夹成 0");
      eq(wtext.effectiveTextPadding(51, 23, 32), 0, "标题条 padding=32 应夹成 0");
      eq(wtext.effectiveTextPadding(302, 226, 82), 82, "时钟 padding=82 装得下应保留");
      eq(wtext.effectiveTextPadding(592, 214, 32), 32, "世界时钟 592 盒 padding=32 应保留");
    }
    const cell = wtext.layoutText("01", { boxW: 36, boxH: 42, pointsize: 9, lineHeight: 12, padding: 32, halign: "center", valign: "center" }, measure);
    eq(cell.lines[0].x, (36 - 20) / 2, "小盒默认 padding 夹 0 后居中 x");
    const hdr = wtext.layoutText("CITY", { boxW: 51, boxH: 23, pointsize: 9, lineHeight: 12, padding: 32, halign: "left", valign: "center" }, measure);
    eq(hdr.lines[0].x, 51 / 2, "标题条左对齐贴盒中线（origin）");
  }
  return errors;
}

// ---------- 脚本校验（全库 + 已知语义样例） ----------

function runScripts() {
  const errors = [];
  const stats = { total: 0, sandboxed: 0, noUpdate: 0, parseFail: 0, updateFail: 0, staticText: 0 };
  const updateFails = [];

  const userPropertiesFor = (project) => userPropsMod.flattenUserProperties(project?.general?.properties || {});
  // 求值期（update/init）脚本抛错：WE 本身也容忍（保留旧文本），不计失败，仅统计
  const runtimeErrs = [];

  for (const item of fs.readdirSync(LIB)) {
    const dir = join(LIB, item);
    if (!fs.statSync(dir).isDirectory()) continue;
    let pkgPath = join(dir, "scenes/scene.pkg");
    if (!fs.existsSync(pkgPath)) pkgPath = join(dir, "scene.pkg");
    if (!fs.existsSync(pkgPath)) continue;
    let pkg;
    try {
      pkg = parsePkg(fs.readFileSync(pkgPath));
    } catch {
      continue;
    }
    const sj = getEntry(pkg, "scene.json");
    if (!sj) continue;
    const pj = getEntry(pkg, "project.json");
    let project = null;
    try {
      project = pj ? JSON.parse(readText(pj)) : null;
    } catch {
      /* 无属性表 */
    }
    const userProps = userPropertiesFor(project);
    let scene;
    try {
      scene = JSON.parse(readText(sj).replace(/^\uFEFF/, ""));
    } catch {
      continue;
    }
    const sceneShared = {}; // WE shared 全局：同场景文字脚本共享
    for (const o of scene.objects || []) {
      if (o.text === undefined || o.text === null) continue;
      stats.total++;
      const script = typeof o.text === "object" && o.text ? o.text.script || null : null;
      const staticText = typeof o.text === "object" && o.text ? String(o.text.value ?? "") : String(o.text);
      if (!script) {
        stats.staticText++;
        continue;
      }
      // 与渲染器同路径：先过 parseScene 的字段归一化（{user,value} 解引用等）
      const layer = parseMod.parseScene({ objects: [o] }, project).layers[0];
      const layerTextStore = new Map();
      const sandbox = wtext.evalTextScript(layer.textScript, layer.textScriptProps, {
        text: layer.text ?? "",
        font: layer.textFont || "",
        pointsize: layer.textPointsize,
        color: layer.textColor,
        angles: layer.angles,
        origin: layer.origin,
        scale: layer.scale,
        visible: layer.visible,
        canvasSize: { width: 1920, height: 1080 },
        userProperties: userProps,
        shared: sceneShared,
        getLayerText: (name) => layerTextStore.get(name),
        onError: (e, phase) => {
          if (phase === "parse") {
            stats.parseFail++;
            errors.push(`脚本解析失败 [${item} ${o.name}]: ${e.message?.slice(0, 120)}`);
          } else {
            stats.updateFail++;
            runtimeErrs.push(`运行期错误 ${phase} [${item} ${o.name}]: ${e.message?.slice(0, 100)}`);
          }
        },
      });
      if (!sandbox) {
        // 无 update/mediaPropertiesChanged（混淆脚本等）→ 渲染路径回退静态文本
        stats.noUpdate++;
        continue;
      }
      stats.sandboxed++;
      sandbox.init();
      sandbox.applyUserProperties(userProps);
      layerTextStore.set(o.name || "", String(layer.text ?? ""));
      try {
        const r = sandbox.callUpdate(String(layer.text ?? ""));
        if (r === null) {
          // undefined 返回且未写 thisLayer.text → 保留原文本，合法
          if (sandbox.thisLayer.text !== String(layer.text ?? "") && sandbox.thisLayer.text === "") {
            updateFails.push({ item, name: o.name });
          }
        }
      } catch (e) {
        stats.updateFail++;
        updateFails.push({ item, name: o.name, err: e.message });
      }
    }
  }
  if (updateFails.length > 0) {
    for (const f of updateFails.slice(0, 10)) {
      errors.push(`update() 抛错 [${f.item} ${f.name}]: ${String(f.err).slice(0, 120)}`);
    }
  }

  // ---- 已知语义样例：时钟脚本（2134765860）----
  // scriptproperties: 24h 制 + 显示秒 + ":" 分隔 → "HH:MM:SS" 且等于当前时刻
  {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const sb = wtext.evalTextScript(
      "export var scriptProperties = createScriptProperties().addCheckbox({ name: 'use24hFormat', value: true }).finish();\n" +
        "export function update(value) {\n" +
        "  let t = new Date();\n" +
        "  let h = t.getHours();\n" +
        "  if (!scriptProperties.use24hFormat) { h %= 12; if (h === 0) h = 12; }\n" +
        "  return pad(h) + scriptProperties.delimiter + pad(t.getMinutes()) + scriptProperties.delimiter + pad(t.getSeconds());\n" +
        "}\n" +
        "function pad(n) { return ('00' + n).slice(-2); }\n",
      { use24hFormat: true, delimiter: ":", showSeconds: { user: "x", value: true } }, // {user,value} 包装容错
      { text: "12:34" },
    );
    if (!sb || !sb.hasUpdate) errors.push("时钟样例沙箱构建失败");
    else {
      const r = sb.callUpdate("");
      const expect = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
      // 秒进位竞态：与两个相邻秒之一相符即可
      const d = new Date(now.getTime() + 1000);
      const expect2 = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      if (r !== expect && r !== expect2) errors.push(`时钟求值不符: 期望 ${expect} 实得 ${r}`);
    }
  }
  // ---- 声明默认值回落：scene 未提供属性时用 createScriptProperties 的声明值 ----
  {
    const sb = wtext.evalTextScript(
      "export var scriptProperties = createScriptProperties().addText({ name: 'delimiter', value: ';' }).finish();\n" +
        "export function update(v) { return 'a' + scriptProperties.delimiter + 'b'; }\n",
      {},
      { text: "" },
    );
    const r = sb.callUpdate("");
    if (r !== "a;b") errors.push(`声明默认值回落不符: ${r}`);
  }
  // ---- scene 值优先于声明默认值 ----
  {
    const sb = wtext.evalTextScript(
      "export var scriptProperties = createScriptProperties().addText({ name: 'delimiter', value: ';' }).finish();\n" +
        "export function update(v) { return 'a' + scriptProperties.delimiter + 'b'; }\n",
      { delimiter: "!" },
      { text: "" },
    );
    const r = sb.callUpdate("");
    if (r !== "a!b") errors.push(`scene 值优先不符: ${r}`);
  }
  // ---- 跨层读取（World Time 类：thisScene.getLayer('Time Difference 1').text）----
  {
    const store = new Map([["Time Difference 1", "-5"]]);
    const sb = wtext.evalTextScript(
      "export function update(v) {\n" +
        "  let diff = parseFloat(thisScene.getLayer('Time Difference 1').text);\n" +
        "  let t = new Date(Date.now() + diff * 3600000);\n" +
        "  return ('00' + t.getHours()).slice(-2) + ':' + ('00' + t.getMinutes()).slice(-2);\n" +
        "}\n",
      {},
      { text: "", getLayerText: (n) => store.get(n) },
    );
    const r = sb.callUpdate("");
    if (!/^\d{2}:\d{2}$/.test(r || "")) errors.push(`跨层读取求值异常: ${r}`);
  }
  // ---- update 不返回值但写 thisLayer.text → 采读写回 ----
  {
    const sb = wtext.evalTextScript(
      "export function update(v) { thisLayer.text = 'written'; }\n",
      {},
      { text: "static" },
    );
    const r = sb.callUpdate("");
    if (r !== "written") errors.push(`thisLayer.text 写回不符: ${r}`);
  }
  // ---- 连续出错熔断：第 3 次后 disabled，不再抛 ----
  {
    const sb = wtext.evalTextScript(
      "export function update(v) { throw new Error('boom'); }\n",
      {},
      { text: "x" },
    );
    for (let i = 0; i < 3; i++) sb.callUpdate("");
    if (!sb.disabled) errors.push("连续 3 次出错后应熔断");
  }
  // ---- WEMath 垫片 ----
  {
    const sb = wtext.evalTextScript(
      "import * as WEMath from 'WEMath';\nexport function update(v) { return String(WEMath.mix(0, 10, 0.25)); }\n",
      {},
      { text: "" },
    );
    const r = sb.callUpdate("");
    if (r !== "2.5") errors.push(`WEMath.mix 不符: ${r}`);
  }
  // ---- 混淆器压成 import*as _0x from'WEMath'（无空格、别名≠模块名）----
  {
    const sb = wtext.evalTextScript(
      "import*as _0xab from'WEMath';export function update(v) { return String(_0xab.mix(0, 10, 0.25)); }\n",
      {},
      { text: "" },
    );
    if (!sb) errors.push("minified import*as WEMath 沙箱构建失败（会报 Cannot use import statement outside a module）");
    else {
      const r = sb.callUpdate("");
      if (r !== "2.5") errors.push(`minified import*as 别名未绑到 WEMath：${r}`);
    }
    const src = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/text.js"), "utf8");
    if (!src.includes("import\\s*\\*\\s*as")) {
      errors.push("scriptToFunctionBody 必须匹配 import*as（无空格），否则混淆脚本 SyntaxError");
    }
  }

  // ---- Vec3.mix / 单标量广播 / init(value) 升成 Vec3 ----
  // 3790527023 按钮：`currentScale = new Vec3(ORIGINAL_SCALE); currentScale.mix(target, t)`
  // 3791163858 悬停：`initScale = value; new Vec3(initScale.multiply(hoScale))`
  {
    const src = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/text.js"), "utf8");
    if (!/^\s+mix\(v, t\) \{/m.test(src)) {
      errors.push("Vec3 缺少 mix(v, t)（3790527023 按钮 currentScale.mix 会熔断）");
    }
    if (!/function asScriptVec3/.test(src) || !/fns\.init\(asScriptVec3\(value\)\)/.test(src)) {
      errors.push("evalObjectScript.init 未把 {x,y,z} 升成 Vec3（3791163858 initScale.multiply 会熔断）");
    }
    const btn = wtext.evalObjectScript(
      "let currentScale, targetScale;\n" +
        "export function init() {\n" +
        "  currentScale = new Vec3(0.2);\n" +
        "  targetScale = new Vec3(0.25);\n" +
        "}\n" +
        "export function update(value) {\n" +
        "  currentScale = currentScale.mix(targetScale, 0.5);\n" +
        "  return currentScale;\n" +
        "}\n",
      {},
      { layer: { name: "btn", scale: [0.2, 0.2, 0.2] } },
    );
    if (!btn) errors.push("按钮缩放样例沙箱构建失败");
    else {
      btn.init();
      const ret = btn.callUpdate({ x: 0.2, y: 0.2, z: 0.2 });
      const x = ret && typeof ret === "object" ? Number(ret.x) : NaN;
      const y = ret && typeof ret === "object" ? Number(ret.y) : NaN;
      if (!(Math.abs(x - 0.225) < 1e-9) || !(Math.abs(y - 0.225) < 1e-9)) {
        errors.push(`Vec3.mix + 单标量广播：期望 (0.225,0.225)，实得 (${x},${y})`);
      }
    }
    const hover = wtext.evalObjectScript(
      "let initScale, newScale;\n" +
        "export function init(value) { initScale = value; }\n" +
        "export function applyUserProperties() {\n" +
        "  newScale = new Vec3(initScale.multiply(1.5));\n" +
        "}\n" +
        "export function update(value) { return newScale; }\n",
      {},
      { layer: { name: "hover", scale: [0.4, 0.4, 0.4] } },
    );
    if (!hover) errors.push("悬停缩放样例沙箱构建失败");
    else {
      hover.init({ x: 0.4, y: 0.4, z: 0.4 });
      hover.applyUserProperties({});
      const ret = hover.callUpdate({ x: 0.4, y: 0.4, z: 0.4 });
      const x = ret && typeof ret === "object" ? Number(ret.x) : NaN;
      if (!(Math.abs(x - 0.6) < 1e-9)) {
        errors.push(`init(value) 升 Vec3 后 multiply：期望 0.6，实得 ${x}`);
      }
    }
  }

  // ---- Vec2 + 效果常量读指针（3791967416 聚光灯 delayedPointer）----
  // juguangdeng 基于 xray，位置却不走 g_PointerPosition，而是常量脚本
  // `return new Vec2(cursorScreenPosition / screenResolution)` 再 lerp。
  // 沙箱没有 Vec2 → ReferenceError 熔断；常量沙箱不传 inputView → 灯钉在 (0,0)。
  {
    const src = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/text.js"), "utf8");
    if (!/const Vec2 = Vec3/.test(src) || !/'Vec2'/.test(src)) {
      errors.push("沙箱未注入 Vec2（3791967416 new Vec2(...) 会 ReferenceError 熔断）");
    }
    const iv = wtext.createInputView();
    iv.update({
      wx: 0, wy: 0, screenX: 384, screenY: 216,
      u: 0.2, v: 0.2, lastU: 0.2, lastV: 0.2, leftDown: false,
    });
    const sb = wtext.evalObjectScript(
      "'use strict';\n" +
        "export function update() {\n" +
        "  return new Vec2(\n" +
        "    input.cursorScreenPosition.x / engine.screenResolution.x,\n" +
        "    input.cursorScreenPosition.y / engine.screenResolution.y\n" +
        "  );\n" +
        "}\n",
      {},
      { inputView: iv, screenResolution: { x: 1920, y: 1080 } },
    );
    if (!sb) errors.push("Vec2 聚光灯样例沙箱构建失败");
    else {
      const ret = sb.callUpdate({ x: 0.5, y: 0.5, z: 0 });
      const x = ret && typeof ret === "object" ? Number(ret.x) : NaN;
      const y = ret && typeof ret === "object" ? Number(ret.y) : NaN;
      if (!(Math.abs(x - 0.2) < 1e-9) || !(Math.abs(y - 0.2) < 1e-9)) {
        errors.push(`Vec2 归一化光标：期望 (0.2,0.2)，实得 (${x},${y})`);
      }
    }

    const pkgPath = join(LIB, "3791967416", "scene.pkg");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = parsePkg(new Uint8Array(fs.readFileSync(pkgPath)));
        const raw = getEntry(pkg, "scene.json");
        const scene = JSON.parse(new TextDecoder().decode(raw));
        let script = null;
        for (const o of scene.objects || []) {
          if (o.name !== "后期处理层") continue;
          for (const e of o.effects || []) {
            if (e.name !== "蓝") continue;
            const v = e.passes && e.passes[0] && e.passes[0].constantshadervalues
              && e.passes[0].constantshadervalues.delayedPointer;
            if (v && typeof v.script === "string") script = v.script;
          }
        }
        if (!script) errors.push("3791967416 后期处理层/蓝 没有 delayedPointer 脚本（用例失效）");
        else {
          const iv2 = wtext.createInputView();
          iv2.update({
            wx: 0, wy: 0, screenX: 384, screenY: 216,
            u: 0.2, v: 0.2, lastU: 0.2, lastV: 0.2, leftDown: false,
          });
          const errs = [];
          const real = wtext.evalObjectScript(script, { delaySeconds: 0.3 }, {
            inputView: iv2,
            screenResolution: { x: 1920, y: 1080 },
            onError: (e, phase) => errs.push(`${phase}: ${(e && e.message) || e}`),
          });
          if (!real) errors.push("3791967416 delayedPointer 沙箱构建失败（Vec2 未注入）");
          else {
            real.engine.frametime = 1 / 60;
            real.init({ x: 0.5, y: 0.5, z: 0 });
            const first = real.callUpdate({ x: 0.5, y: 0.5, z: 0 });
            const fx = first && typeof first === "object" ? Number(first.x) : NaN;
            if (!Number.isFinite(fx)) {
              errors.push(`3791967416 delayedPointer 未返回 Vec2：${JSON.stringify(first)} ${errs.join(";")}`);
            } else {
              iv2.update({
                wx: 0, wy: 0, screenX: 1920, screenY: 0,
                u: 1, v: 0, lastU: 0.2, lastV: 0.2, leftDown: false,
              });
              let last = first;
              for (let i = 0; i < 12; i++) last = real.callUpdate(last);
              const lx = last && typeof last === "object" ? Number(last.x) : NaN;
              if (!(lx > fx + 0.05)) {
                errors.push(`3791967416 delayedPointer 应跟鼠标右移，x ${fx} → ${lx}`);
              }
            }
          }
        }
      } catch (e) {
        errors.push(`3791967416 delayedPointer 语料失败: ${(e && e.message) || e}`);
      }
    }
  }

  // ---- combo 整数字符串 ===（3791967416 聚光灯被切成「蓝固定」）----
  // flatten 把 combo "1" 收成 number 1（3396722575 case 21 需要）；作者按 JSON
  // 字面量写 `=== '1'`。挂载时 applyUserProperties 全量传入 → led=false →
  // 每帧打开钉在 0.5 0.5 的固定层。沙箱把对整数字符串的 === 降成 ==。
  {
    if (typeof wtext.rewriteComboStringEq !== "function") {
      errors.push("未导出 rewriteComboStringEq（1 === '1' 会把聚光灯切成固定层）");
    } else {
      const eq = wtext.rewriteComboStringEq("shared.led = (v === '1');");
      if (!/v == '1'/.test(eq) || /v === '1'/.test(eq)) {
        errors.push(`rewriteComboStringEq 未把 === '1' 降成 ==：${JSON.stringify(eq)}`);
      }
      const keep = wtext.rewriteComboStringEq("typeof x === 'number'");
      if (keep !== "typeof x === 'number'") {
        errors.push(`rewriteComboStringEq 不该动 === 'number'：${JSON.stringify(keep)}`);
      }
      const ne = wtext.rewriteComboStringEq("if (v !== '2') {}");
      if (!/v != '2'/.test(ne)) {
        errors.push(`rewriteComboStringEq 未把 !== '2' 降成 !=：${JSON.stringify(ne)}`);
      }
    }
    const src = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/text.js"), "utf8");
    if (!/rewriteComboStringEq\(\s*script\s*\)/.test(src)) {
      errors.push("scriptToFunctionBody 未调用 rewriteComboStringEq（导出了函数但没接线）");
    }

    {
      const shared = {};
      const sb = wtext.evalObjectScript(
        "'use strict';\n" +
          "export function applyUserProperties(changed) {\n" +
          "  shared.led = (changed.newproperty16 === '1');\n" +
          "}\n" +
          "export function update(value) { return value; }\n",
        {},
        { shared },
      );
      if (!sb) errors.push("combo === '1' 样例沙箱构建失败");
      else {
        sb.applyUserProperties({ newproperty16: 1 });
        if (shared.led !== true) {
          errors.push(`combo 数字 1 === '1' 应为 true（跟鼠标层），实得 ${shared.led}`);
        }
        sb.applyUserProperties({ newproperty16: 2 });
        if (shared.led !== false) {
          errors.push(`combo 数字 2 === '1' 应为 false（固定层），实得 ${shared.led}`);
        }
      }
    }

    const pkgPath = join(LIB, "3791967416", "scene.pkg");
    const projPath = join(LIB, "3791967416", "project.json");
    if (fs.existsSync(pkgPath) && fs.existsSync(projPath)) {
      try {
        const pkg = parsePkg(new Uint8Array(fs.readFileSync(pkgPath)));
        const scene = JSON.parse(new TextDecoder().decode(getEntry(pkg, "scene.json")));
        const project = JSON.parse(fs.readFileSync(projPath, "utf8"));
        const parsed = parseMod.parseScene(scene, project);
        const post = parsed.layers.find((l) => l.name === "后期处理层");
        const btn = scene.objects.find((o) => o.name === "交互按钮");
        const vis = btn && btn.visible && btn.visible.script;
        if (!post || !vis) errors.push("3791967416 缺少 后期处理层 / 交互按钮.visible.script");
        else {
          const visOf = (n) => {
            const e = post.effects.find((x) => x.name === n);
            return e ? !!e.visible : null;
          };
          const shared = {};
          const flat = userPropsMod.flattenUserProperties(project.general.properties || {});
          if (flat.newproperty16 !== 1) {
            errors.push(`3791967416 flatten newproperty16 应为 1，实得 ${JSON.stringify(flat.newproperty16)}`);
          }
          const sb = wtext.evalObjectScript(vis, {}, {
            shared,
            userProperties: flat,
            getSceneLayer: (name) => parsed.layers.find((l) => l.name === name),
          });
          if (!sb) errors.push("3791967416 交互按钮 沙箱构建失败");
          else {
            sb.init(true);
            sb.applyUserProperties(flat);
            sb.callUpdate(true);
            if (shared.led !== true || visOf("蓝") !== true || visOf("蓝固定") !== false) {
              errors.push(
                `3791967416 默认开灯应走跟鼠标的蓝/黑，led=${shared.led} 蓝=${visOf("蓝")} 蓝固定=${visOf("蓝固定")}`,
              );
            }
            sb.applyUserProperties({ newproperty16: 2 });
            sb.callUpdate(true);
            if (shared.led !== false || visOf("蓝") !== false || visOf("蓝固定") !== true) {
              errors.push(
                `3791967416 combo=关 应切到蓝固定，led=${shared.led} 蓝=${visOf("蓝")} 蓝固定=${visOf("蓝固定")}`,
              );
            }
          }
        }
      } catch (e) {
        errors.push(`3791967416 交互按钮 语料失败: ${(e && e.message) || e}`);
      }
    }
  }

  console.log(
    `\n【脚本】文字对象 ${stats.total}：静态 ${stats.staticText}，带脚本 ${stats.sandboxed + stats.noUpdate}` +
      `（沙箱求值 ${stats.sandboxed}，无 update 回退静态 ${stats.noUpdate}），` +
      `解析失败 ${stats.parseFail}，运行期容错 ${stats.updateFail}（WE 同款：保留旧文本，不算失败）`,
  );
  if (stats.parseFail === 0 && runtimeErrs.length > 0) {
    console.log(`  （运行期容错样例: ${runtimeErrs.slice(0, 3).join(" | ")}）`);
  }
  return errors;
}

// ---------- parseScene 集成：新文字字段就位 ----------

function runParseIntegration() {
  const errors = [];
  const item = "2134765860";
  const dir = join(LIB, item);
  const pkgPath = fs.existsSync(join(dir, "scenes/scene.pkg"))
    ? join(dir, "scenes/scene.pkg")
    : join(dir, "scene.pkg");
  if (!fs.existsSync(pkgPath)) {
    errors.push(`校验样例壁纸缺失: ${item}`);
    return errors;
  }
  const pkg = parsePkg(fs.readFileSync(pkgPath));
  const sj = getEntry(pkg, "scene.json");
  const pj = getEntry(pkg, "project.json");
  const scene = JSON.parse(readText(sj).replace(/^\uFEFF/, ""));
  const project = pj ? JSON.parse(readText(pj)) : null;
  const parsed = parseMod.parseScene(scene, project);
  const clock = parsed.layers.find((l) => l.name === "Clock");
  if (!clock) {
    errors.push("样例场景中未找到 Clock 层");
    return errors;
  }
  const expect = {
    isText: true,
    textAnchor: "center",
    textPadding: 82,
    textLimitwidth: false,
    textCastshadow: false,
    textOpaquebackground: false,
  };
  for (const [k, v] of Object.entries(expect)) {
    if (clock[k] !== v) errors.push(`Clock.${k}: 期望 ${JSON.stringify(v)} 实得 ${JSON.stringify(clock[k])}`);
  }
  // scriptproperties 的 {user,value} 包装由 parseScene 解引用（改写包装的 .value，
  // 不拆包装）；渲染路径经 evalTextScript 的 propValue 再拆一层 → 生效值 true
  if (clock.textScriptProps?.showSeconds?.value !== true) {
    errors.push(`Clock.textScriptProps.showSeconds.value 应为 true，实得 ${JSON.stringify(clock.textScriptProps?.showSeconds)}`);
  }
  if (!clock.textScript || clock.textScript.indexOf("update") < 0) errors.push("Clock.textScript 未解析");
  if (!clock.textFont) errors.push("Clock.textFont 未解析");
  if (!parsed.generalScripts || !parsed.generalScripts.bloomstrength) {
    errors.push("2134765860 general.bloomstrength.script 应进 generalScripts（音频 bloom 否则不跑）");
  }
  if (clock.size[0] !== 302 || clock.size[1] !== 226) {
    errors.push(`Clock.size 应为 302×226，实得 ${clock.size}`);
  }
  return errors;
}

// ---------- 3396722575 圆环文字：边距 / combo / shared / 脚本角度 ----------
//
// 官方截图里绕颈胸的白字不是贝塞尔路径，是 4708×420 文字层 + geometric_transform。
// 下列判据锁住让它看起来像「一条不弯的细线 / 转出画面 / 字体切不换」的几个接线。

function runRibbonEffects() {
  const errors = [];
  const { coerceComboValue, flattenUserProperties } = userPropsMod;

  // 1) 边距按字号封顶 256，4708 宽的丝带不能被扩成近乎方形
  {
    if (typeof wtext.textCanvasMargin !== "function") {
      errors.push("text.js 未导出 textCanvasMargin");
    } else {
      const em = 4 * 32;
      const m = wtext.textCanvasMargin(em, 0);
      if (m > 256) errors.push(`textCanvasMargin 应 ≤256，实得 ${m}`);
      const h = 420 + m * 2;
      if (h >= 2468) errors.push(`丝带扩边后高度 ${h} 仍是旧公式（max(w,h)+1024）`);
      if ((m * 2) / 4708 > 0.2) errors.push(`丝带水平边距过大，会明显压扁圆环 UV: margin=${m}`);
      const clock = wtext.textCanvasMargin(4 * 24, 82);
      if (clock < 100) errors.push(`时钟边距过小会裁 "20:47:41": ${clock}`);
      const withPad = wtext.textCanvasMargin(128, 32);
      const noPad = wtext.textCanvasMargin(128, 0);
      if (withPad !== noPad) errors.push(`padding 不应撑大溢出边距: pad32=${withPad} pad0=${noPad}`);
    }
  }

  // 1b) 3122339805：tint 蒙版层边距必须压到原盒附近；小盒默认 padding 夹 0
  {
    if (typeof wtext.textLayerHasTintMask !== "function") {
      errors.push("text.js 未导出 textLayerHasTintMask");
    } else {
      const tinted = { effects: [{ file: "effects/tint/effect.json", visible: true, passes: [{ textures: [null, "masks/tint_mask_b88c8c27"] }] }] };
      if (!wtext.textLayerHasTintMask(tinted)) errors.push("挂 tint+mask 的层应判定 textLayerHasTintMask");
      if (wtext.textLayerHasTintMask({ effects: [] })) errors.push("无效果层不应判定 tint mask");
    }
    const dash = "3122339805";
    const dashDir = join(LIB, dash);
    const dashPkg = fs.existsSync(join(dashDir, "scene.pkg")) ? join(dashDir, "scene.pkg") : null;
    if (dashPkg) {
      const pkg = parsePkg(fs.readFileSync(dashPkg));
      const sj = getEntry(pkg, "scene.json");
      const pj = fs.readFileSync(join(dashDir, "project.json"));
      const parsed = parseMod.parseScene(JSON.parse(readText(sj)), JSON.parse(readText(pj)));
      const cell = parsed.layers.find((l) => l.name === "C1");
      const hdr = parsed.layers.find((l) => l.name === "GIF Window 2 Header");
      const time = parsed.layers.find((l) => l.name === "World Time 1 Time");
      const hours = parsed.layers.find((l) => l.name === "HOURS");
      if (!cell || !hdr || !time || !hours) {
        errors.push("3122339805 缺少 C1 / CITY Header / World Time 1 Time / HOURS");
      } else {
        if (wtext.effectiveTextPadding(cell.size[0], cell.size[1], cell.textPadding) !== 0) {
          errors.push(`C1 ${cell.size} pad=${cell.textPadding} 应夹成 0`);
        }
        if (wtext.effectiveTextPadding(hdr.size[0], hdr.size[1], hdr.textPadding) !== 0) {
          errors.push(`CITY Header ${hdr.size} pad=${hdr.textPadding} 应夹成 0`);
        }
        if (wtext.effectiveTextPadding(time.size[0], time.size[1], time.textPadding) !== 32) {
          errors.push(`World Time 1 Time 592 盒 pad=32 应保留，实得 size=${time.size} pad=${time.textPadding}`);
        }
        if (!wtext.textLayerHasTintMask(time) || !wtext.textLayerHasTintMask(hours)) {
          errors.push("World Time 1 Time / HOURS 应带 tint 蒙版");
        }
        const emTime = 4 * (time.textPointsize || 32);
        const cap = wtext.textLayerHasTintMask(time) ? 8 : 256;
        const m = Math.min(cap, wtext.textCanvasMargin(emTime, 0));
        if (m > 8) errors.push(`tint 层溢出边距应 ≤8（蒙版对齐），实得 ${m}`);
        const expandedW = time.size[0] + m * 2;
        if (expandedW > time.size[0] * 1.1) {
          errors.push(`World Time 扩边后 ${expandedW} 仍会把 296 宽蒙版拉变形`);
        }
      }
    }
  }

  // 2) combo "21" → 21（选项全是整数字符串时）
  {
    const opts = Array.from({ length: 21 }, (_, i) => ({ label: String(i + 1), value: String(i + 1) }));
    const n = coerceComboValue("21", opts);
    if (n !== 21) errors.push(`coerceComboValue("21") 应为 21，实得 ${JSON.stringify(n)}`);
    const lang = coerceComboValue("en-us", [
      { label: "English", value: "en-us" },
      { label: "中文", value: "zh-chs" },
    ]);
    if (lang !== "en-us") errors.push(`非数字 combo 不应被强制转 number: ${JSON.stringify(lang)}`);
    const flat = flattenUserProperties({
      text1: { type: "combo", value: "21", options: opts },
      title: { type: "textinput", value: "hello" },
    });
    if (flat.text1 !== 21) errors.push(`flattenUserProperties.text1 应为 21，实得 ${JSON.stringify(flat.text1)}`);
    if (flat.title !== "hello") errors.push("flattenUserProperties 不该动 textinput");
  }

  // 3) 本机有这张壁纸时：applyUserProperties(21) 必须写出 font 路径
  {
    const item = "3396722575";
    const dir = join(LIB, item);
    const pkgPath = fs.existsSync(join(dir, "scene.pkg"))
      ? join(dir, "scene.pkg")
      : join(dir, "scenes/scene.pkg");
    if (!fs.existsSync(pkgPath)) {
      console.log("  （跳过 3396722575 语料：本机无此壁纸）");
    } else {
      const pkg = parsePkg(fs.readFileSync(pkgPath));
      const scene = JSON.parse(readText(getEntry(pkg, "scene.json")).replace(/^\uFEFF/, ""));
      const project = JSON.parse(fs.readFileSync(join(dir, "project.json"), "utf8"));
      const o = scene.objects.find((x) => x.id === 843);
      const userProps = flattenUserProperties(project.general.properties || {});
      if (userProps.text1 !== 21) {
        errors.push(`3396722575 text1 默认应变为 21，实得 ${JSON.stringify(userProps.text1)}`);
      }
      const sb = wtext.evalTextScript(o.text.script, o.text.scriptproperties, {
        text: o.text.value,
        font: o.font,
        pointsize: 32,
        userProperties: userProps,
        shared: {},
        canvasSize: { width: 5120, height: 1440 },
      });
      if (!sb) errors.push("3396722575 旋转文字1 沙箱构建失败");
      else {
        sb.applyUserProperties(userProps);
        if (!sb.thisLayer.font || !String(sb.thisLayer.font).includes("SourceHanSans")) {
          errors.push(
            `applyUserProperties(text1=21) 应设置 SourceHanSans，实得 ${JSON.stringify(sb.thisLayer.font)}`,
          );
        }
      }
      const L = parseMod.parseScene(scene, project).layers.find((l) => l.name === "旋转文字1");
      if (!L) errors.push("parseScene 未找到 旋转文字1");
      else {
        if (L.size[0] !== 4708 || L.size[1] !== 420) {
          errors.push(`旋转文字1 解析尺寸应为 4708×420，实得 ${L.size}`);
        }
        const geo = (L.effects || []).find((e) => (e.file || "").includes("geometric_transform"));
        const csv = geo && geo.passes && geo.passes[0] && geo.passes[0].constantshadervalues;
        const str = csv && csv.Strength;
        if (!str || typeof str.script !== "string" || str.script.indexOf("shared.textz1") < 0) {
          errors.push("旋转文字1 的 Strength 脚本应读 shared.textz1（用例失效则场景被作者改过）");
        }
      }
    }
  }

  // 4) 效果常量脚本必须能读到对象脚本写入的 shared
  {
    const shared = {};
    const sbWrite = wtext.evalObjectScript(
      "export function update(){ shared.textz1 = 0.42; return false; }\n",
      {},
      { shared, layer: { visible: false, angles: [0, 0, 0] } },
    );
    sbWrite.callUpdate(false);
    const sbRead = wtext.evalObjectScript(
      "export function update(value){ value = shared.textz1; return value; }\n",
      {},
      { shared },
    );
    const ret = sbRead.callUpdate(0.5);
    if (ret !== 0.42) errors.push(`shared 跨沙箱应读到 0.42，实得 ${ret}`);
  }

  // 5) SceneScript 写 angles.z = -5 表示 -5°，不是 -5rad
  {
    if (typeof wtext.scriptAnglesToRad !== "function" || typeof wtext.radToScriptAngles !== "function") {
      errors.push("text.js 未导出 scriptAnglesToRad / radToScriptAngles");
    } else {
      const target = { name: "旋转文字1", angles: [0, 0, -0.20944] };
      const sb = wtext.evalObjectScript(
        "export function update(){ thisScene.getLayer('旋转文字1').angles.z = -5; }\n",
        {},
        { layer: { angles: [0, 0, 0] }, getSceneLayer: (n) => (n === "旋转文字1" ? target : null) },
      );
      sb.callUpdate();
      const expect = (-5 * Math.PI) / 180;
      if (Math.abs(target.angles[2] - expect) > 1e-6) {
        errors.push(`getLayer().angles.z = -5 应写成 ${expect} rad，实得 ${target.angles[2]}`);
      }
      const fan = { angles: [0, 0, 0] };
      const fanSb = wtext.evalObjectScript(
        "export function update(value){ value.z = 180; return value; }\n",
        {},
        { layer: fan },
      );
      const v = wtext.radToScriptAngles(fan.angles);
      const ret = fanSb.callUpdate(v);
      const out = wtext.scriptAnglesToRad(ret);
      if (Math.abs(out[2] - Math.PI) > 1e-6) {
        errors.push(`angles 脚本写 180° 应回成 π rad，实得 ${out[2]}`);
      }
    }
  }

  // 6) 源码守卫：装配路径真的用了这些出口，而不是只导出了函数
  {
    const mount = fs.readFileSync(join(ROOT, "renderer/src/scene-mount.ts"), "utf8");
    if (!/textCanvasMargin\(/.test(mount)) errors.push("scene-mount.ts 未调用 textCanvasMargin（边距公式在也不接线）");
    if (/Math\.max\(layer\.size\[0\], layer\.size\[1\]\)/.test(mount)) {
      errors.push("scene-mount.ts 仍按层长边扩文字边距");
    }
    if (!/shared:\s*textShared/.test(mount)) errors.push("scene-mount.ts 未把 textShared 注入 setConstantScriptRuntime");
    if (!/inputView/.test(mount.slice(mount.indexOf("setConstantScriptRuntime"), mount.indexOf("setConstantScriptRuntime") + 500))) {
      errors.push("scene-mount.ts 未把 inputView 注入 setConstantScriptRuntime（聚光灯 delayedPointer 读不到光标）");
    }
    if (!/flattenUserProperties\(/.test(mount)) {
      errors.push("scene-mount.ts 未用 flattenUserProperties 构建 userProperties");
    }
    if (!/generalScripts/.test(mount)) {
      errors.push("scene-mount.ts 未加载 general.*.script（火车震动 / 场景切换 / bloom 会丢）");
    }
    if (!/createSimulatedWindowTitle/.test(mount)) {
      errors.push("scene-mount.ts 未接入窗口标题模拟源");
    }
    if (!/mediaControl/.test(mount)) {
      errors.push("scene-mount.ts 未把媒体控制面注入沙箱");
    }
    if (!/scriptAnglesToRad\(/.test(mount)) errors.push("scene-mount.ts 对象脚本 angles 写回未走 scriptAnglesToRad");
    if (!/sanitizeFontForBrowser/.test(mount)) {
      errors.push("scene-mount.ts 未调用 sanitizeFontForBrowser（Tourner cmap 会被 OTS 拒载）");
    }
    const fontSan = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/font-sanitize.js"), "utf8");
    if (!/rangeShift/.test(fontSan) || !/cmap/.test(fontSan)) {
      errors.push("font-sanitize.js 必须修正 cmap format 4 的 rangeShift");
    }
    // 本机语料：2780710296 的 Tourner (588) 修前 rangeShift 错、修后应对。
    const wp278 = join(LIB, "2780710296", "scene.pkg");
    if (fs.existsSync(wp278)) {
      const pkg = pkgMod.parsePkg(fs.readFileSync(wp278));
      const raw = pkgMod.getEntry(pkg, "fonts/Tourner (588).TTF");
      if (!raw) {
        errors.push("2780710296 应含 fonts/Tourner (588).TTF");
      } else {
        const u8 = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
        const fixed = fontSanMod.sanitizeFontForBrowser(u8);
        const dv = new DataView(fixed.buffer, fixed.byteOffset, fixed.byteLength);
        const numTables = dv.getUint16(4);
        let cmapOff = 0;
        for (let i = 0; i < numTables; i++) {
          const e = 12 + i * 16;
          const tag = String.fromCharCode(fixed[e], fixed[e + 1], fixed[e + 2], fixed[e + 3]);
          if (tag === "cmap") {
            cmapOff = dv.getUint32(e + 8);
            break;
          }
        }
        const nEnc = dv.getUint16(cmapOff + 2);
        let ok = false;
        for (let i = 0; i < nEnc; i++) {
          const soff = dv.getUint32(cmapOff + 4 + i * 8 + 4);
          const abs = cmapOff + soff;
          if (dv.getUint16(abs) !== 4) continue;
          const segCountX2 = dv.getUint16(abs + 6);
          const segCount = segCountX2 >> 1;
          const expShift = segCountX2 - 2 * Math.pow(2, Math.floor(Math.log2(segCount)));
          ok = dv.getUint16(abs + 12) === expShift;
        }
        if (!ok) errors.push("2780710296 Tourner (588) sanitize 后 cmap rangeShift 仍不对");
        // 故意改坏：原件 rangeShift 必须是错的，否则本用例失去意义
        const dv0 = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
        let cmap0 = 0;
        for (let i = 0; i < dv0.getUint16(4); i++) {
          const e = 12 + i * 16;
          const tag = String.fromCharCode(u8[e], u8[e + 1], u8[e + 2], u8[e + 3]);
          if (tag === "cmap") {
            cmap0 = dv0.getUint32(e + 8);
            break;
          }
        }
        let rawBad = false;
        for (let i = 0; i < dv0.getUint16(cmap0 + 2); i++) {
          const soff = dv0.getUint32(cmap0 + 4 + i * 8 + 4);
          const abs = cmap0 + soff;
          if (dv0.getUint16(abs) !== 4) continue;
          const segCountX2 = dv0.getUint16(abs + 6);
          const segCount = segCountX2 >> 1;
          const expShift = segCountX2 - 2 * Math.pow(2, Math.floor(Math.log2(segCount)));
          if (dv0.getUint16(abs + 12) !== expShift) rawBad = true;
        }
        if (!rawBad) errors.push("2780710296 Tourner (588) 原件 rangeShift 应变坏（用例失效）");
      }
    }
    const rsrc = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/renderer.js"), "utf8");
    if (!/shared:\s*scriptShared/.test(rsrc)) errors.push("renderer.js scriptedConstants 未把 shared 传进沙箱");
    if (!/inputView:\s*scriptInputView/.test(rsrc)) {
      errors.push("renderer.js scriptedConstants 未把 inputView 传进常量沙箱（3791967416 聚光灯钉死）");
    }
  }

  return errors;
}

// ---------- thisScene.destroyLayer（开场盖屏层）----------
//
// 3786330502 关掉「开场 Logo」后应立刻拆掉全屏盖层，露出主体。
// 空 stub 时 applyUserProperties 走进 destroyLayer 分支什么都不做，
// 开场层 visible 快照仍是 true，画面永远停在开场第一帧。
function runDestroyLayer() {
  const errors = [];
  const src = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/text.js"), "utf8");
  if (/destroyLayer:\s*\(\)\s*=>\s*\{\s*\}/.test(src)) {
    errors.push("text.js 的 thisScene.destroyLayer 仍是空 stub（关掉开场动画会停在第一帧）");
  }
  const mount = fs.readFileSync(join(ROOT, "renderer/src/scene-mount.ts"), "utf8");
  if (!/!l\.destroyed/.test(mount)) {
    errors.push("scene-mount getSceneLayer 未跳过已 destroy 的层（墓碑会被 getLayer 再次拿到）");
  }
  const rsrc = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/renderer.js"), "utf8");
  if (!/layer\.destroyed/.test(rsrc)) {
    errors.push("renderer.js 未跳过 destroyed 层（visible 字段 return value 会把盖屏层救活）");
  }
  const hsrc = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/hittest.js"), "utf8");
  if (!/layer\.destroyed/.test(hsrc)) {
    errors.push("hittest.js 未跳过 destroyed 层（拆掉的盖屏层仍会吃掉点击）");
  }

  const intro = { name: "开场Logo", id: 1780, visible: true, alpha: 1, destroyed: false };
  const byName = new Map([[intro.name, intro]]);
  const opts = {
    layer: intro,
    getSceneLayer: (n) => {
      const l = byName.get(String(n));
      return l && !l.destroyed ? l : null;
    },
    shared: {},
    onError: (e) => errors.push(`destroyLayer 沙箱异常: ${e && e.message}`),
  };

  // 1) 按名字拆：visible=false、墓碑、之后 getLayer 写入打到哑代理
  {
    intro.visible = true;
    intro.destroyed = false;
    const sb = wtext.evalObjectScript(
      "export function applyUserProperties(){ thisScene.destroyLayer('开场Logo'); }\n" +
        "export function update(value){ thisScene.getLayer('开场Logo').visible = true; return value; }\n",
      {},
      opts,
    );
    if (!sb) errors.push("destroyLayer 名字用例沙箱构建失败");
    else {
      sb.applyUserProperties({});
      if (intro.visible !== false) errors.push("destroyLayer(name) 后 visible 应为 false");
      if (!intro.destroyed) errors.push("destroyLayer(name) 后应打 destroyed 墓碑");
      const ret = sb.callUpdate(true);
      if (typeof ret === "boolean") intro.visible = ret;
      if (!intro.destroyed) errors.push("update 不得清掉 destroyed 墓碑");
      // 宿主按 return value 写回 true 也必须仍是墓碑，渲染侧靠 destroyed 跳过
      if (!intro.destroyed) errors.push("return value 写回后墓碑丢失");
    }
  }

  // 2) 按图层代理拆（3791967416：destroyLayer(thisScene.getLayer(name))）
  {
    intro.visible = true;
    intro.destroyed = false;
    const sb = wtext.evalObjectScript(
      "export function applyUserProperties(){ var l = thisScene.getLayer('开场Logo'); thisScene.destroyLayer(l); }\n",
      {},
      opts,
    );
    sb.applyUserProperties({});
    if (intro.visible !== false || !intro.destroyed) {
      errors.push("destroyLayer(getLayer(name)) 应按代理拆掉真实层");
    }
  }

  // 3) 3786330502 真实脚本：logo1=false 时 applyUserProperties 必须拆掉开场层
  {
    const id = "3786330502";
    const dir = join(LIB, id);
    const pkgPath = fs.existsSync(join(dir, "scene.pkg")) ? join(dir, "scene.pkg") : "";
    if (!pkgPath) {
      console.log("  （跳过 3786330502 语料：本机无此壁纸）");
    } else {
      const pkg = parsePkg(fs.readFileSync(pkgPath));
      const sj = JSON.parse(readText(getEntry(pkg, "scene.json")).replace(/^\uFEFF/, ""));
      const pjPath = join(dir, "project.json");
      const project = fs.existsSync(pjPath) ? JSON.parse(fs.readFileSync(pjPath, "utf8")) : null;
      const parsed = parseMod.parseScene(sj, project);
      const layer = parsed.layers.find((l) => l.name === "开场Logo");
      const def = layer && layer.objectScripts && layer.objectScripts.visible;
      if (!layer || !def || typeof def.script !== "string") {
        errors.push("3786330502 未找到「开场Logo」visible.script（用例过期）");
      } else if (!/destroyLayer\s*\(\s*['\"]开场Logo['\"]\s*\)/.test(def.script)) {
        errors.push("3786330502 开场脚本不再调用 destroyLayer('开场Logo')（用例过期）");
      } else {
        const live = parsed.layers.filter((l) => !l.destroyed);
        const sb = wtext.evalObjectScript(def.script, def.scriptproperties || {}, {
          layer,
          shared: {},
          userProperties: { logo1: false },
          getSceneLayer: (n) => live.find((l) => l.name === n && !l.destroyed) || null,
          onError: (e) => errors.push(`3786330502 脚本异常: ${e && e.message}`),
        });
        if (!sb) errors.push("3786330502 开场脚本沙箱构建失败");
        else {
          sb.init(true);
          sb.applyUserProperties({ logo1: false });
          const ret = sb.callUpdate(!!layer.visible);
          if (typeof ret === "boolean") layer.visible = ret;
          if (layer.visible !== false) {
            errors.push("3786330502 logo1=false 后「开场Logo」visible 应为 false（否则盖住主体）");
          }
          if (!layer.destroyed) {
            errors.push("3786330502 logo1=false 后「开场Logo」应被 destroyLayer 打墓碑");
          }
        }
      }
    }
  }

  return errors;
}

function runMinifiedImports() {
  const errors = [];
  const id = "2887099508";
  const dir = join(LIB, id);
  const pkgPath = fs.existsSync(join(dir, "scene.pkg")) ? join(dir, "scene.pkg") : "";
  if (!pkgPath) {
    console.log("  （跳过 2887099508 语料：本机无此壁纸）");
    return errors;
  }
  const pkg = parsePkg(fs.readFileSync(pkgPath));
  const sj = JSON.parse(readText(getEntry(pkg, "scene.json")).replace(/^\uFEFF/, ""));
  let hits = 0;
  let compiled = 0;
  const failNames = [];
  for (const o of sj.objects || []) {
    for (const f of ["scale", "origin", "color", "alpha", "brightness", "angles", "visible"]) {
      const v = o[f];
      if (!(v && typeof v === "object" && typeof v.script === "string")) continue;
      if (!/import\*as /.test(v.script) && !/import\s*\*\s*as /.test(v.script)) continue;
      hits++;
      const errs = [];
      const sb = wtext.evalObjectScript(v.script, v.scriptproperties || {}, {
        layer: { name: o.name, visible: true, origin: [0, 0, 0], scale: [1, 1, 1], alpha: 1 },
        shared: {},
        userProperties: {},
        getSceneLayer: () => null,
        setTimeout: () => () => {},
        onError: (e) => errs.push(String(e && e.message)),
      });
      if (!sb || errs.some((m) => /import statement/i.test(m))) {
        failNames.push(`${o.name}.${f}`);
        continue;
      }
      compiled++;
    }
  }
  if (hits < 10) errors.push(`2887099508 应有大量 import*as WEMath 脚本，实得 ${hits}（用例过期）`);
  if (failNames.length) {
    errors.push(`2887099508 minified import 仍失败 ${failNames.length}/${hits}：${failNames.slice(0, 8).join(", ")}`);
  }
  if (compiled < hits) {
    errors.push(`2887099508 minified import 可求值 ${compiled}/${hits}`);
  }
  return errors;
}

function runSceneApiGaps() {
  const errors = [];
  const src = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/text.js"), "utf8");
  if (/enumerateLayers:\s*\(\)\s*=>\s*\[\s*\]/.test(src)) {
    errors.push("text.js 的 enumerateLayers 仍返回 []（3790527023 切场景 / 2847470774 收集 player 会空转）");
  }
  if (/getParent:\s*\(\)\s*=>\s*null/.test(src)) {
    errors.push("text.js 的 getParent 仍恒 null（mi 模板 parent.visible 会 TypeError）");
  }
  if (/getChildren:\s*\(\)\s*=>\s*\[\s*\]/.test(src)) {
    errors.push("text.js 的 getChildren 仍返回 []（3790527023 本地播放列表为零）");
  }
  if (/getTransformMatrix:\s*\(\)\s*=>\s*null/.test(src)) {
    errors.push("text.js 的 getTransformMatrix 仍返回 null（m[12]/m[13] 半屏判断会熔断）");
  }
  if (/getAnimation:\s*\(\)\s*=>\s*null/.test(src)) {
    errors.push("text.js thisScene.getAnimation 仍恒 null（3444535389 .play TypeError）");
  }

  const parent = { id: 1, name: "box", origin: [100, 200, 0], visible: true, childIds: [2], parentId: null };
  const child = { id: 2, name: "knob", origin: [140, 200, 0], visible: true, childIds: null, parentId: 1 };
  const bar = {
    id: 3, name: "playerbarsexception", origin: [10, 20, 0], scale: [1, 1, 1],
    size: [8, 40], color: [1, 1, 1], visible: true, alpha: 1, image: "x",
  };
  const layers = [parent, child, bar];
  const cameraTransforms = { zoom: 1 };
  const opts = {
    layer: parent,
    getSceneLayer: (n) => layers.find((l) => l.name === n && !l.destroyed) || null,
    getSceneLayerById: (id) => layers.find((l) => l.id === id && !l.destroyed) || null,
    enumerateSceneLayers: () => layers.filter((l) => !l.destroyed),
    cameraTransforms,
    getInitialLayerConfig: (arg) => {
      const name = arg && arg.name ? arg.name : String(arg);
      return layers.find((l) => l.name === name) || null;
    },
    createSceneLayer: (cfg) => {
      let src = cfg && typeof cfg === "object" ? cfg : null;
      if (typeof cfg === "string") {
        src = layers.find((l) => l.image === cfg) || null;
        if (!src) return null;
      }
      if (!src) src = {};
      const clone = {
        ...src,
        id: layers.length + 10,
        origin: Array.isArray(src.origin) ? src.origin.slice() : [0, 0, 0],
        scale: Array.isArray(src.scale) ? src.scale.slice() : [1, 1, 1],
        color: Array.isArray(src.color) ? src.color.slice() : [1, 1, 1],
        visible: true,
        objectScripts: null,
      };
      layers.push(clone);
      return clone;
    },
    onError: (e) => errors.push(`scene API 沙箱异常: ${e && e.message}`),
  };

  {
    const sh = { n: 0, names: "" };
    const sb = wtext.evalObjectScript(
      "export function init(){ shared.n = thisScene.enumerateLayers().length; shared.names = thisScene.enumerateLayers().map(l=>l.name).join(','); }\n" +
        "export function update(v){ return v; }\n",
      {},
      { ...opts, shared: sh },
    );
    if (!sb) errors.push("enumerateLayers 沙箱构建失败");
    else {
      sb.init();
      if (sh.n !== 3) errors.push(`enumerateLayers 应返回 3 层，实得 ${sh.n}`);
      if (!String(sh.names).includes("playerbarsexception")) {
        errors.push(`enumerateLayers 应含 playerbarsexception，实得 ${sh.names}`);
      }
    }
  }

  {
    const sh = {};
    const sb = wtext.evalObjectScript(
      "export function init(){\n" +
        "  var p = thisLayer.getParent();\n" +
        "  shared.hasParent = !!p;\n" +
        "  var kids = thisLayer.getChildren();\n" +
        "  shared.kidN = kids.length;\n" +
        "  shared.kidName = kids[0] && kids[0].name;\n" +
        "  var m = thisLayer.getTransformMatrix();\n" +
        "  shared.tx = m.m[12]; shared.ty = m.m[13];\n" +
        "}\nexport function update(v){ return v; }\n",
      {},
      { ...opts, layer: parent, shared: sh },
    );
    if (!sb) errors.push("getParent/getChildren 沙箱构建失败");
    else {
      sb.init();
      if (sh.hasParent) errors.push("根层 getParent 应为 null");
      if (sh.kidN !== 1) errors.push(`getChildren 应返回 1 个，实得 ${sh.kidN}`);
      if (sh.kidName !== "knob") errors.push(`getChildren[0].name 应为 knob，实得 ${sh.kidName}`);
      if (sh.tx !== 100) errors.push(`getTransformMatrix.m[12] 应为 100，实得 ${sh.tx}`);
      if (sh.ty !== 200) errors.push(`getTransformMatrix.m[13] 应为 200，实得 ${sh.ty}`);
    }
    const sh2 = {};
    const sb2 = wtext.evalObjectScript(
      "export function init(){ var p = thisLayer.getParent(); shared.ok = p && p.name === 'box' && p.visible; }\n" +
        "export function cursorClick(){ if (thisLayer.getParent().visible) shared.clicked = 1; }\n" +
        "export function update(v){ return v; }\n",
      {},
      { ...opts, layer: child, shared: sh2 },
    );
    sb2.init();
    sb2.callCursor("cursorClick", wtext.makeCursorEventVec(0, 0, 0));
    if (!sh2.ok) errors.push("子层 getParent 应返回可见的 box");
    if (sh2.clicked !== 1) errors.push("parent.visible 为 true 时 cursorClick 应能走进分支");
  }

  {
    cameraTransforms.zoom = 1;
    const sb = wtext.evalObjectScript(
      "export function applyUserProperties(c){ if (c.trainshake != undefined){ var t = thisScene.getCameraTransforms(); t.zoom = c.trainshake ? 1.01 : 1.0; thisScene.setCameraTransforms(t); } }\n" +
        "export function update(v){ return v; }\n",
      {},
      opts,
    );
    if (!sb) errors.push("getCameraTransforms 沙箱构建失败");
    else {
      sb.applyUserProperties({ trainshake: true });
      if (Math.abs(cameraTransforms.zoom - 1.01) > 1e-9) {
        errors.push(`setCameraTransforms zoom 应为 1.01，实得 ${cameraTransforms.zoom}`);
      }
      sb.applyUserProperties({ trainshake: false });
      if (Math.abs(cameraTransforms.zoom - 1) > 1e-9) {
        errors.push(`trainshake=false 后 zoom 应为 1，实得 ${cameraTransforms.zoom}`);
      }
    }
  }

  {
    const before = layers.length;
    const sh = {};
    const sb = wtext.evalObjectScript(
      "export function init(){\n" +
        "  var orig = thisScene.getLayer('playerbarsexception');\n" +
        "  var bar = thisScene.createLayer(thisScene.getInitialLayerConfig(orig));\n" +
        "  bar.origin = new Vec3(orig.origin.x+12, orig.origin.y, orig.origin.z);\n" +
        "  bar.alpha = 0.5;\n" +
        "  shared.n = thisScene.enumerateLayers().length;\n" +
        "  shared.x = bar.origin.x;\n" +
        "  shared.a = bar.alpha;\n" +
        "}\nexport function update(v){ return v; }\n",
      {},
      { ...opts, shared: sh },
    );
    if (!sb) errors.push("createLayer 沙箱构建失败");
    else {
      sb.init();
      if (layers.length !== before + 1) errors.push(`createLayer 应新增 1 层，层数 ${before} → ${layers.length}`);
      if (sh.n !== before + 1) errors.push(`enumerateLayers 在 createLayer 后应为 ${before + 1}，实得 ${sh.n}`);
      if (Math.abs(sh.x - 22) > 1e-6) errors.push(`克隆条 origin.x 应为 22，实得 ${sh.x}`);
      if (Math.abs(sh.a - 0.5) > 1e-6) errors.push(`克隆条 alpha 应为 0.5，实得 ${sh.a}`);
      const clone = layers[layers.length - 1];
      if (bar.origin[0] !== 10) errors.push("createLayer 不得改写模板层 origin");
      if (clone.origin === bar.origin) errors.push("克隆层 origin 应是新数组");
    }
  }

  {
    // 3789604238：createLayer('models/bar.json') + __workshopId → 克隆同模型层
    const viz = {
      id: 196,
      name: "Simple Visualizer",
      image: "models/workshop/2652493753/bar.json",
      textureName: "workshop/2652493753/bar",
      origin: [14, 526, 0],
      scale: [1.2, 0.4, 0.4],
      size: [4, 4],
      color: [0, 0, 0],
      visible: true,
      alpha: 1,
      alignment: "center",
      objectScripts: { visible: { script: "x" } },
      effects: [{ layerMaterial: true, name: "_layerMaterial", visible: true }],
    };
    layers.push(viz);
    const before = layers.length;
    const sh = {};
    const sb = wtext.evalObjectScript(
      "export let __workshopId = '2652493753';\n" +
        "export function init(){\n" +
        "  var bar = thisScene.createLayer('models/bar.json');\n" +
        "  bar.alignment = 'bottom';\n" +
        "  bar.scale = new Vec3(5, 20, 0);\n" +
        "  shared.img = bar && !!thisScene.getLayer('Simple Visualizer');\n" +
        "  shared.n = thisScene.enumerateLayers().length;\n" +
        "  shared.ok = !!bar && bar.alignment === 'bottom';\n" +
        "}\nexport function update(){}\n",
      {},
      { ...opts, layer: viz, shared: sh },
    );
    if (!sb) errors.push("createLayer(路径) 沙箱构建失败");
    else {
      sb.init();
      if (layers.length !== before + 1) {
        errors.push(`createLayer('models/bar.json') 应新增 1 层，层数 ${before} → ${layers.length}`);
      }
      const clone = layers[layers.length - 1];
      if (!clone || clone.image !== "models/workshop/2652493753/bar.json") {
        errors.push(`字符串路径应解析到 workshop 模型，实得 ${clone && clone.image}`);
      }
      if (clone && clone.objectScripts) {
        errors.push("路径克隆层不得带上模板 objectScripts（会递归造条）");
      }
      if (clone && clone.textureName !== "workshop/2652493753/bar") {
        errors.push("路径克隆层应继承 textureName");
      }
      if (sh.ok !== true) errors.push(`alignment 写回应为 bottom，shared.ok=${sh.ok}`);
      if (Math.abs((clone && clone.scale && clone.scale[1]) - 20) > 1e-6) {
        errors.push(`克隆条 scale.y 应为 20，实得 ${clone && clone.scale && clone.scale[1]}`);
      }
    }
    if (typeof wtext.resolveWorkshopAssetPath === "function") {
      const p = wtext.resolveWorkshopAssetPath("models/bar.json", "2652493753");
      if (p !== "models/workshop/2652493753/bar.json") {
        errors.push(`resolveWorkshopAssetPath 应为 models/workshop/…/bar.json，实得 ${p}`);
      }
    } else {
      errors.push("text.js 必须导出 resolveWorkshopAssetPath");
    }
    // thisLayer.origin.copy：Simple Visualizer 每帧 baseOrigin.copy()，没有就静默不动
    {
      const sh = {};
      const layer = {
        id: 7, name: "copyprobe", origin: [14, 526, 0], scale: [1, 1, 1],
        size: [4, 4], color: [1, 1, 1], visible: true, alpha: 1,
      };
      const sb = wtext.evalObjectScript(
        "export function init(){\n" +
          "  try {\n" +
          "    var c = thisLayer.origin.copy();\n" +
          "    c.x += 10;\n" +
          "    thisLayer.origin = c;\n" +
          "    shared.ok = true; shared.x = thisLayer.origin.x;\n" +
          "  } catch (e) { shared.err = e.message; }\n" +
          "}\nexport function update(v){ return v; }\n",
        {},
        { ...opts, layer, shared: sh },
      );
      sb.init();
      if (sh.ok !== true) errors.push(`thisLayer.origin.copy 必须可用，err=${sh.err}`);
      if (Math.abs(sh.x - 24) > 1e-6) errors.push(`origin.copy 写回后 x 应为 24，实得 ${sh.x}`);
      if (Math.abs(layer.origin[0] - 24) > 1e-6) errors.push(`图层 origin[0] 应为 24，实得 ${layer.origin[0]}`);
    }
  }

  {
    const sh = {};
    const snap = { title: "夜航星", artist: "相位迁移" };
    let skipped = 0;
    const sb = wtext.evalObjectScript(
      "export function init(){\n" +
        "  shared.ss = engine.isScreensaver;\n" +
        "  shared.title = engine.windowTitle;\n" +
        "  engine.media.skipNext();\n" +
        "}\nexport function update(v){ return v; }\n",
      {},
      {
        ...opts,
        shared: sh,
        isScreensaver: false,
        windowTitle: { title: "YouTube", app: "Chrome" },
        mediaControl: { skipNext: () => { skipped++; return snap; }, snapshot: snap },
      },
    );
    sb.init();
    if (sh.ss !== false) errors.push(`isScreensaver 应为 false，实得 ${sh.ss}`);
    if (sh.title !== "YouTube") errors.push(`engine.windowTitle 应为 YouTube，实得 ${sh.title}`);
    if (skipped !== 1) errors.push(`engine.media.skipNext 应调用 1 次，实得 ${skipped}`);
  }

  {
    const id = "3151551777";
    const pkgPath = join(LIB, id, "scene.pkg");
    if (fs.existsSync(pkgPath)) {
      const pkg = parsePkg(fs.readFileSync(pkgPath));
      const raw = JSON.parse(readText(getEntry(pkg, "scene.json")).replace(/^\uFEFF/, ""));
      const def = raw.general && raw.general.zoom;
      if (!def || typeof def.script !== "string") {
        errors.push("3151551777 general.zoom.script 用例过期");
      } else {
        const cam = { zoom: 1 };
        const sb = wtext.evalObjectScript(def.script, def.scriptproperties || {}, {
          cameraTransforms: cam,
          onError: (e) => errors.push(`3151551777 zoom 脚本: ${e && e.message}`),
        });
        if (!sb) errors.push("3151551777 zoom 脚本沙箱构建失败");
        else {
          sb.applyUserProperties({ trainshake: true });
          if (Math.abs(cam.zoom - 1.01) > 1e-9) {
            errors.push(`3151551777 trainshake 开后 zoom 应为 1.01，实得 ${cam.zoom}`);
          }
        }
      }
    }
  }

  {
    const id = "2983846453";
    const pkgPath = join(LIB, id, "scene.pkg");
    if (fs.existsSync(pkgPath)) {
      const pkg = parsePkg(fs.readFileSync(pkgPath));
      const raw = JSON.parse(readText(getEntry(pkg, "scene.json")).replace(/^\uFEFF/, ""));
      const project = JSON.parse(fs.readFileSync(join(LIB, id, "project.json"), "utf8"));
      const o = (raw.objects || []).find((x) => x.name === "早");
      const vis = o && o.visible;
      if (!vis || typeof vis.script !== "string") {
        errors.push("2983846453「早」visible.script 用例过期");
      } else {
        const userProperties = userPropsMod.flattenUserProperties(project.general.properties || {});
        if (userProperties.newproperty5 !== 1) {
          errors.push(`2983846453 newproperty5 默认应为 1（白天），实得 ${JSON.stringify(userProperties.newproperty5)}`);
        }
        const shared = {};
        const sb = wtext.evalObjectScript(vis.script, vis.scriptproperties || {}, {
          userProperties,
          shared,
          canvasSize: { width: 3840, height: 2160 },
          onError: (e) => errors.push(`2983846453 早.visible: ${e && e.message}`),
        });
        if (!sb) errors.push("2983846453 早.visible 沙箱构建失败");
        else {
          sb.init(true);
          sb.applyUserProperties(userProperties);
          if (shared.hover !== true) {
            errors.push(`2983846453 默认白天 shared.hover 应为 true，实得 ${shared.hover}`);
          }
          sb.callCursor("cursorClick", { worldPosition: { x: 1773, y: 1072, z: 0 } });
          if (shared.hover !== false) {
            errors.push(`2983846453 点击后应变黑夜 hover=false，实得 ${shared.hover}`);
          }
          sb.callCursor("cursorClick", { worldPosition: { x: 1773, y: 1072, z: 0 } });
          if (shared.hover !== true) {
            errors.push(`2983846453 再点应回到白天 hover=true，实得 ${shared.hover}`);
          }
          const night = {};
          const sb2 = wtext.evalObjectScript(vis.script, vis.scriptproperties || {}, {
            userProperties: { ...userProperties, newproperty5: 2 },
            shared: night,
            canvasSize: { width: 3840, height: 2160 },
          });
          if (sb2) {
            sb2.init(true);
            sb2.applyUserProperties({ newproperty5: 2 });
            if (night.hover !== false) {
              errors.push(`2983846453 newproperty5=2 应为黑夜 hover=false，实得 ${night.hover}`);
            }
          }
        }
      }
    }
  }

  return errors;
}

// ---------- engine.setTimeout/setInterval 统一真定时器（SCENESCRIPT-PLAN P1-1）----------
//
// WE 语义：句柄是「可调用的取消函数」（3790189808 的 `lastHideEvent()` 直接调用
// 取消），混淆脚本又把句柄当数字做算术。此前只有对象字段 eval 点有真定时器，
// 效果开关(37 处)/效果常量(8 处)/general(1 处) 共 46 处 / 17 张拿 no-op stub，
// 延时显隐/回弹/轮换静默失效。
// 三组判据：句柄语义（fake 时钟）、五挂点接线（源码结构断言）、全库语料驱动。

function makeFakeClock() {
  let now = 0;
  let seq = 1;
  let firedCount = 0;
  const jobs = new Map(); // id -> { fn, at, every(毫秒|null) }
  return {
    setTimeout(fn, ms) {
      const id = seq++;
      jobs.set(id, { fn, at: now + (Number(ms) || 0), every: null });
      return id;
    },
    clearTimeout(id) {
      jobs.delete(id);
    },
    setInterval(fn, ms) {
      const id = seq++;
      jobs.set(id, { fn, at: now + (Number(ms) || 0), every: Number(ms) || 0 });
      return id;
    },
    clearInterval(id) {
      jobs.delete(id);
    },
    size: () => jobs.size,
    fired: () => firedCount,
    now: () => now,
    /** 推进 now 到 now+dt；期间到点的定时器按到点先后同步执行 */
    advance(dt) {
      const end = now + dt;
      for (;;) {
        let pick = null;
        for (const [id, j] of jobs) {
          if (j.at <= end && (pick === null || j.at < jobs.get(pick).at)) pick = id;
        }
        if (pick === null) break;
        const j = jobs.get(pick);
        now = Math.max(now, j.at);
        if (j.every !== null) j.at = now + j.every;
        else jobs.delete(pick);
        firedCount++;
        j.fn();
      }
      now = end;
    },
  };
}

function runEngineTimers() {
  const errors = [];

  // ---- 1) 句柄语义（fake 时钟） ----
  {
    const clock = makeFakeClock();
    const t = engTimers.createEngineTimers(clock);
    let hits = 0;
    const h = t.setTimeout(() => {
      hits++;
    }, 500);
    if (typeof h !== "function")
      errors.push("engine.setTimeout 应返回可调用的取消句柄（语料 lastHideEvent() 直接调用取消，3790189808）");
    if (h.valueOf() !== 1) errors.push("取消句柄 valueOf 应回数字 handle（混淆脚本把句柄当数字用）");
    clock.advance(499);
    if (hits !== 0) errors.push("setTimeout 延迟未到不应触发");
    clock.advance(1);
    if (hits !== 1) errors.push("setTimeout 到点应恰好触发一次");
    clock.advance(60000);
    if (hits !== 1) errors.push("setTimeout 不得重复触发");
    if (t.pendingCount() !== 0) errors.push("已触发的 setTimeout 应移出 pending");

    let hits2 = 0;
    t.setTimeout(
      () => {
        hits2++;
      },
      100,
    )();
    clock.advance(1000);
    if (hits2 !== 0) errors.push("句柄直接调用（取消）后的 setTimeout 不应触发");

    let hits3 = 0;
    const h3 = t.setTimeout(() => {
      hits3++;
    }, 100);
    t.clearTimeout(h3);
    clock.advance(1000);
    if (hits3 !== 0) errors.push("engine.clearRectTimeout(句柄) 应能取消未触发的定时器");

    let hits4 = 0;
    t.setTimeout(() => {
      hits4++;
    });
    t.setTimeout(() => {
      hits4++;
    }, -5);
    t.setTimeout(() => {
      hits4++;
    }, Number.NaN);
    clock.advance(0);
    if (hits4 !== 3) errors.push(`缺省/负数/NaN 延迟应归一为立即触发（期望 3 次全触发，实得 ${hits4}）`);

    let ticks = 0;
    const iv = t.setInterval(() => {
      ticks++;
    }, 100);
    // window.setInterval 语义：首拍在 100ms（不是 0）。350ms 内 100/200/300 共 3 拍
    clock.advance(350);
    if (ticks !== 3) errors.push(`setInterval 应按节拍触发（100/200/300ms 共 3 拍，实得 ${ticks}）`);
    t.clearInterval(iv);
    clock.advance(1000);
    if (ticks !== 3) errors.push("clearInterval 后不得继续触发");

    // 回调抛错：隔离上报、interval 不停表（window.setTimeout 同款语义）
    const cbErrs = [];
    const t2 = engTimers.createEngineTimers(clock, {
      onError: (e, kind) => {
        if (kind === "timer") cbErrs.push(String((e && e.message) || e));
      },
    });
    let ticks2 = 0;
    t2.setInterval(() => {
      ticks2++;
      if (ticks2 === 2) throw new Error("boom");
    }, 100);
    clock.advance(450);
    if (ticks2 !== 4) errors.push(`interval 回调抛错不得停表（100/200/300/400ms 共 4 拍，实得 ${ticks2}）`);
    if (cbErrs.length !== 1 || cbErrs[0] !== "boom")
      errors.push(`interval 回调抛错应经 onError(kind='timer') 上报一次（实得 ${JSON.stringify(cbErrs)}）`);

    // dispose：场景卸载撤销全部未触发回调（防延迟写穿死层）
    const t3 = engTimers.createEngineTimers(clock);
    let fired3 = 0;
    t3.setTimeout(() => {
      fired3++;
    }, 10);
    t3.setTimeout(() => {
      fired3++;
    }, 20);
    t3.dispose();
    if (t3.pendingCount() !== 0) errors.push("dispose 后 pending 应清空");
    clock.advance(1000);
    if (fired3 !== 0) errors.push("dispose 应撤销全部未触发回调");

    // ---- 1b) 正向控制：走真实沙箱链路（evalObjectScript opts → engine.setTimeout → 触发）----
    // WE 官方模板风格的合成脚本（update 里排定时器、回调改 shared）。
    // 全库 76 段定时器语料的调用点都藏在离线驱动到不了的分支里（cursor/media 回调、
    // 混淆 decoy、用户属性条件，实测驱动 0 排程），语料段只能做存在性 + 冒烟，
    // 「注入真的生效」由这条确定性用例守住。
    const TIMER_PROBE =
      "export function update(value) {" +
      " if (!shared.started) { shared.started = true; engine.setTimeout(function(){ shared.done = true; }, 500); }" +
      " return value; }";
    {
      const clock = makeFakeClock();
      const t = engTimers.createEngineTimers(clock);
      const shared = {};
      const sb = wtext.evalObjectScript(TIMER_PROBE, {}, {
        shared,
        setTimeout: t.setTimeout,
        clearTimeout: t.clearTimeout,
        setInterval: t.setInterval,
        clearInterval: t.clearInterval,
      });
      if (!sb) errors.push("定时器正向控制：沙箱构建失败");
      else {
        for (let i = 0; i < 5; i++) {
          clock.advance(16);
          sb.callUpdate(undefined);
        }
        clock.advance(1000);
        if (shared.done !== true)
          errors.push("正向控制失败：engine.setTimeout 的回调未触发（evalObjectScript → engineTimers 注入链路断了）");
      }
    }
    {
      // 反向：不注入宿主实现时，engine.setTimeout 保持 no-op stub（离线确定性不变）
      const shared2 = {};
      const sb2 = wtext.evalObjectScript(TIMER_PROBE, {}, { shared: shared2 });
      if (sb2) {
        for (let i = 0; i < 5; i++) sb2.callUpdate(undefined);
        if (shared2.done === true)
          errors.push("未注入宿主实现时 engine.setTimeout 应保持 no-op（不许偷用全局定时器）");
      }
    }
  }

  // ---- 2) 引擎默认保持 no-op + 零 DOM（ARCHITECTURE §三） ----
  {
    let fired = false;
    const t0 = engTimers.createEngineTimers({});
    t0.setTimeout(() => {
      fired = true;
    }, 1);
    if (fired) errors.push("无宿主注入时引擎默认定时器必须 no-op（不许偷用全局 setTimeout，保离线确定性）");
    const tsrc = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/engine-timers.js"), "utf8");
    if (/\bwindow\b|\bdocument\b/.test(tsrc))
      errors.push("engine-timers.js 不得直接引用 window/document（定时器实现由宿主注入）");
  }

  // ---- 3) 五挂点接线（源码结构断言） ----
  {
    const msrc = fs.readFileSync(join(ROOT, "renderer/src/scene-mount.ts"), "utf8");
    if (!msrc.includes("wtimers.createEngineTimers(")) errors.push("scene-mount 未创建 engineTimers（P1-1 接线被拆）");
    const spreadCount = (msrc.match(/\.\.\.timerOpts/g) || []).length;
    if (spreadCount !== 4)
      errors.push(`scene-mount 四个直连 eval 点（文字/效果开关/对象字段/general）应各有一处 ...timerOpts，实得 ${spreadCount}`);
    if (!/timers:\s*engineTimers/.test(msrc))
      errors.push("setConstantScriptRuntime 未传 timers: engineTimers（效果常量定时器缺口，renderer 只提取白名单字段）");
    if (!/engineTimers\.dispose\(\)/.test(msrc)) errors.push("场景卸载未 engineTimers.dispose()（未触发回调会写穿死层）");
    if (/const h = window\.setTimeout\(fn, ms\)/.test(msrc))
      errors.push("对象 eval 点残留内联定时器包装（应统一走 engineTimers，否则卸载不 dispose）");
    const rsrc = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/renderer.js"), "utf8");
    if (!/setTimeout:\s*scriptTimers \? scriptTimers\.setTimeout/.test(rsrc))
      errors.push("renderer.js 常量沙箱未把 scriptTimers 四件套传给 evalObjectScript");
  }

  // ---- 4) 全库语料：所有含 engine.setTimeout/setInterval 的字段脚本带真定时器驱动 ----
  //
  // 实测（2026-09-03）：76 段语料的定时器调用全部位于离线驱动不可达的分支
  // （cursor/media 回调、混淆 decoy、用户属性条件；喂音频也 0 排程）。
  // 所以本段只断言**存在性下限**与**冒烟不炸**；「注入生效」由 1b 正向控制守住。
  {
    const clock = makeFakeClock();
    const timerErrs = [];
    const timers = engTimers.createEngineTimers(clock, {
      onError: (e) => timerErrs.push(String((e && e.message) || e)),
    });
    let scanned = 0;
    const wpIds = new Set();
    for (const item of fs.readdirSync(LIB)) {
      const dir = join(LIB, item);
      if (!fs.statSync(dir).isDirectory()) continue;
      let pkgPath = join(dir, "scenes/scene.pkg");
      if (!fs.existsSync(pkgPath)) pkgPath = join(dir, "scene.pkg");
      if (!fs.existsSync(pkgPath)) continue;
      let pkg;
      try {
        pkg = parsePkg(fs.readFileSync(pkgPath));
      } catch {
        continue;
      }
      const sj = getEntry(pkg, "scene.json");
      if (!sj) continue;
      let scene;
      try {
        scene = JSON.parse(readText(sj).replace(/^\uFEFF/, ""));
      } catch {
        continue;
      }
      const visit = (node) => {
        if (node === null || typeof node !== "object") return;
        if (Array.isArray(node)) {
          node.forEach(visit);
          return;
        }
        if (typeof node.script === "string" && /engine\s*\.\s*(setTimeout|setInterval)/.test(node.script)) {
          scanned++;
          wpIds.add(item);
          let sb = null;
          try {
            sb = wtext.evalObjectScript(node.script, node.scriptproperties || null, {
              userProperties: {},
              shared: {},
              setTimeout: timers.setTimeout,
              clearTimeout: timers.clearTimeout,
              setInterval: timers.setInterval,
              clearInterval: timers.clearInterval,
            });
          } catch {
            /* 语料解析失败由 runScripts 的统计口径负责，这里只关心定时器 */
          }
          if (sb) {
            sb.init(undefined);
            sb.applyUserProperties({});
            for (let i = 0; i < 20; i++) {
              clock.advance(16);
              sb.callUpdate(undefined);
            }
          }
          // 推进 10 分钟：万一脚本在 init/update 可达分支排了定时器，回调照常被驱动
          for (let i = 0; i < 1200; i++) clock.advance(500);
        }
        for (const v of Object.values(node)) visit(v);
      };
      visit(scene);
    }
    if (scanned < 60)
      errors.push(`全库 engine.setTimeout/setInterval 语料应 ≥60 段（2026-09-03 实测 76），实得 ${scanned} —— 扫描正则或库路径回归`);
    if (wpIds.size < 20) errors.push(`含定时器脚本的壁纸应 ≥20 张（实测 26），实得 ${wpIds.size}`);
    if (timerErrs.length > 0) console.log(`  ℹ 定时器回调抛错（已隔离上报，脚本质量问题不计失败）：${timerErrs.length} 次`);
    console.log(`  ℹ 语料定时器脚本 ${scanned} 段 / ${wpIds.size} 张（调用点在离线不可达分支，冒烟通过）`);
  }

  return errors;
}

/**
 * 3122339805 Eyes/Numbers：visible 绑 hide*=false 时 parse 成隐藏；
 * applyUserProperties 翻成显示必须写 visibleSelf 并重算子层，否则只剩粉条标题栏。
 * 同时文字 update 不得把 boolean false 写成字面量 "false"。
 */
function runHideWindowVisibility() {
  const errors = [];
  const recompute = parseMod.recomputeLayerVisibility;
  if (typeof recompute !== "function") {
    errors.push("parse.js 未导出 recomputeLayerVisibility");
    return errors;
  }
  // 布尔不得写进文字
  {
    const sb = wtext.evalTextScript(
      "export function update() { return false; }\n",
      {},
      { text: "ok" },
    );
    if (!sb) errors.push("boolean-return 文字沙箱构建失败");
    else {
      const r = sb.callUpdate("ok");
      if (r !== null) errors.push(`update() return false 应保留原文，实得 ${JSON.stringify(r)}`);
      if (sb.thisLayer && String(sb.thisLayer.text) === "false") {
        errors.push('update() return false 不得写成字面量 "false"');
      }
    }
  }
  // 代理 set text(false) 也应忽略
  {
    const layer = { text: "keep", name: "t2", visible: true, visibleSelf: true, origin: [0, 0, 0], scale: [1, 1, 1], size: [1, 1], color: [1, 1, 1], angles: [0, 0, 0] };
    const sb = wtext.evalObjectScript(
      "export function update() { thisLayer.text = false; return thisLayer.text; }\n",
      {},
      { layer },
    );
    if (sb) {
      sb.callUpdate("keep");
      if (String(layer.text) === "false") errors.push('thisLayer.text = false 不得写成 "false"');
    }
  }

  const dash = "3122339805";
  const dashDir = join(LIB, dash);
  const dashPkg = fs.existsSync(join(dashDir, "scene.pkg")) ? join(dashDir, "scene.pkg") : null;
  if (!dashPkg) {
    console.log("  （跳过 3122339805 Eyes/Numbers 可见性：本机无此壁纸）");
    return errors;
  }
  const pkg = parsePkg(fs.readFileSync(dashPkg));
  const sceneJson = JSON.parse(readText(getEntry(pkg, "scene.json")).replace(/^\uFEFF/, ""));
  const project = JSON.parse(fs.readFileSync(join(dashDir, "project.json"), "utf8"));
  const parsed = parseMod.parseScene(JSON.parse(JSON.stringify(sceneJson)), project);
  const props = userPropsMod.flattenUserProperties(project.general.properties || {});
  if (props.hideeyeswindow !== false || props.hidenumberswindow !== false) {
    errors.push(`默认 hideeyes/hidenumbers 应为 false，实得 ${props.hideeyeswindow}/${props.hidenumberswindow}`);
  }

  const eyes = parsed.layers.find((l) => l.name === "Eyes Window");
  const eyesGif = parsed.layers.find((l) => l.name === "Eyes");
  const nums = parsed.layers.find((l) => l.name === "Numbers Window");
  const n1 = parsed.layers.find((l) => l.name === "Numbers 1");
  if (!eyes || !eyesGif || !nums || !n1) {
    errors.push("3122339805 缺少 Eyes Window / Eyes / Numbers Window / Numbers 1");
    return errors;
  }
  if (eyes.visible !== false || eyes.visibleSelf !== false) {
    errors.push(`parse 后 Eyes Window 应因 hideeyeswindow=false 绑成隐藏，实得 v=${eyes.visible} vs=${eyes.visibleSelf}`);
  }
  if (eyesGif.visibleSelf !== true || eyesGif.visible !== false) {
    errors.push(`Eyes 子层应 visibleSelf=true 且继承隐藏，实得 v=${eyesGif.visible} vs=${eyesGif.visibleSelf}`);
  }

  const recomputeVisibility = () => recompute(parsed.layers);
  const eyesRaw = sceneJson.objects.find((o) => o.name === "Eyes Window");
  const numsRaw = sceneJson.objects.find((o) => o.name === "Numbers Window");

  // 旧 bug：只写 layer.visible、不写 visibleSelf、不重算 → 子层仍隐藏
  {
    const broken = parseMod.parseScene(JSON.parse(JSON.stringify(sceneJson)), project);
    const bEyes = broken.layers.find((l) => l.name === "Eyes Window");
    const bGif = broken.layers.find((l) => l.name === "Eyes");
    bEyes.visible = true; // 只改有效可见性，模拟旧 proxy
    if (bGif.visible !== false) errors.push("对照组：未重算时 Eyes 子层不应自己变可见");
  }

  for (const [layer, rawO, propKey] of [
    [eyes, eyesRaw, "hideeyeswindow"],
    [nums, numsRaw, "hidenumberswindow"],
  ]) {
    const sb = wtext.evalObjectScript(rawO.visible.script, {}, {
      layer,
      userProperties: props,
      canvasSize: { width: 1920, height: 1080 },
      recomputeVisibility,
    });
    if (!sb) {
      errors.push(`${layer.name} visible 脚本沙箱构建失败`);
      continue;
    }
    sb.init(false);
    sb.applyUserProperties(props);
    if (props[propKey] !== false) continue;
  }

  if (!eyes.visible || !eyes.visibleSelf) {
    errors.push(`applyUserProperties 后 Eyes Window 应显示，实得 v=${eyes.visible} vs=${eyes.visibleSelf}`);
  }
  if (!eyesGif.visible || !eyesGif.visibleSelf) {
    errors.push(`applyUserProperties 后 Eyes 子层应显示，实得 v=${eyesGif.visible} vs=${eyesGif.visibleSelf}`);
  }
  if (!nums.visible || !n1.visible) {
    errors.push(`applyUserProperties 后 Numbers 窗与 Numbers 1 应显示，实得 nums=${nums.visible} n1=${n1.visible}`);
  }

  // 再隐藏
  {
    const sb = wtext.evalObjectScript(eyesRaw.visible.script, {}, {
      layer: eyes, userProperties: props, canvasSize: { width: 1920, height: 1080 }, recomputeVisibility,
    });
    sb.applyUserProperties({ hideeyeswindow: true });
    if (eyes.visible !== false || eyesGif.visible !== false) {
      errors.push(`hideeyeswindow=true 后 Eyes 窗与子层应隐藏，实得 eyes=${eyes.visible} gif=${eyesGif.visible}`);
    }
  }

  // 源码闸门：proxy 必须写 visibleSelf
  {
    const src = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/text.js"), "utf8");
    if (!/layer\.visibleSelf = !!v/.test(src)) {
      errors.push("makeObjectLayerProxy.set visible 必须写 visibleSelf");
    }
    if (!/typeof ret === 'boolean'\) return null/.test(src) && !/typeof ret === \"boolean\"\) return null/.test(src)) {
      // also accept without escape
      if (!/typeof ret === .boolean.\) return null/.test(src)) {
        errors.push("callUpdate 必须忽略 boolean 返回值，防止 String(false)==='false'");
      }
    }
  }

  return errors;
}

// ---------- 入口 ----------

const action = process.argv[2] ?? "all";
let failed = 0;

if (action === "all" || action === "layout") {
  const errors = runLayout();
  console.log(`\n【布局】9 组用例 → 问题 ${errors.length}`);
  errors.forEach((e) => console.log("  ! " + e));
  failed += errors.length;
}
if (action === "all" || action === "script") {
  const errors = runScripts();
  errors.forEach((e) => console.log("  ! " + e));
  failed += errors.length;
}
if (action === "all" || action === "parse") {
  const errors = runParseIntegration();
  console.log(`\n【解析】parseScene 文字字段集成 → 问题 ${errors.length}`);
  errors.forEach((e) => console.log("  ! " + e));
  failed += errors.length;
}
if (action === "all" || action === "ribbon") {
  const errors = runRibbonEffects();
  console.log(`\n【圆环文字】3396722575 接线 → 问题 ${errors.length}`);
  errors.forEach((e) => console.log("  ! " + e));
  failed += errors.length;
}
if (action === "all" || action === "script" || action === "destroy") {
  const errors = runDestroyLayer();
  console.log(`\n【destroyLayer】开场盖屏层拆除 → 问题 ${errors.length}`);
  errors.forEach((e) => console.log("  ! " + e));
  failed += errors.length;
}
if (action === "all" || action === "script" || action === "import") {
  const errors = runMinifiedImports();
  console.log(`\n【minified import】import*as from'WEMath' → 问题 ${errors.length}`);
  errors.forEach((e) => console.log("  ! " + e));
  failed += errors.length;
}
if (action === "all" || action === "script" || action === "sceneapi") {
  const errors = runSceneApiGaps();
  console.log(`\n【场景 API】enumerateLayers/父子/建层/相机 → 问题 ${errors.length}`);
  errors.forEach((e) => console.log("  ! " + e));
  failed += errors.length;
}
if (action === "all" || action === "script" || action === "timers") {
  const errors = runEngineTimers();
  console.log(`\n【engine 定时器】setTimeout/setInterval 五挂点统一注入 → 问题 ${errors.length}`);
  errors.forEach((e) => console.log("  ! " + e));
  failed += errors.length;
}
if (action === "all" || action === "script" || action === "hidevis") {
  const errors = runHideWindowVisibility();
  console.log(`\n【hide* 窗口可见性】3122339805 Eyes/Numbers 子层继承 → 问题 ${errors.length}`);
  errors.forEach((e) => console.log("  ! " + e));
  failed += errors.length;
}

console.log(failed === 0 ? "\n✓ 全部通过" : `\n✗ 共 ${failed} 处问题`);
process.exit(failed === 0 ? 0 : 1);
