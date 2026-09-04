/**
 * verify-sprites.mjs —— 序列帧动画（sprite sheet）的离线校验
 *
 * 覆盖 WE 的「动画贴图组」：material 打 `combos: { spritesheet: 1 }`，贴图在 .tex
 * 尾部的 TEXS 段带一张帧表，图层的 size 是**单帧**尺寸。
 *
 * 本脚本盯的是实现时踩过的四个坑，每条都有具体壁纸做样本：
 *
 *   1. combo 键名大小写。`SPRITESHEET` 与 `spritesheet` 两种写法库里都有，
 *      只认大写会漏掉 3292361861 / 3790527023 / 1444077782 的 12 层。
 *   2. TEXS0002 **没有** frameWidth/frameHeight 字段（TEXS0003 才有）。
 *      按有字段解析会让 stride 除不尽 → 整表被判非法丢弃。
 *   3. 帧矩形的归一化分母必须是**图集真实像素尺寸**（mip0），不是 .tex 头部的
 *      textureWidth/Height —— 1444077782 头部声明的 316x214 是单帧尺寸，
 *      真实图集 2048x1024，用错分母 22/23 帧被判越界。
 *   4. 每帧 32 字节是一组**仿射 UV 基** [imgId, dur, oX, oY, uX, uY, vX, vY]，
 *      不是 (x, y, w, h)。2623473016/Raiden Friends 末 3 帧是旋转 90° 打包的
 *      （uDir=(0,-600)、vDir=(338,0)），当成宽高会读出 w=h=0。
 *
 * 另外验帧选择逻辑：37/52 层由脚本 `setFrame()` 钉帧（AM/PM 按小时选 0/1、
 * 开关按钮按状态选格），只有 15 层按 duration 自动播。把钉帧层按时间播会让
 * 3299228616 的 AM/PM 每秒闪一次。
 *
 * 退出码非 0 表示发现问题。
 */
import fs from "node:fs";
import { join } from "node:path";

import { LIB, ROOT, imp, createChecker, dec } from "./lib/verify-kit.mjs";
const { parsePkg, getEntry } = await imp("renderer/vendor/we-scene/pkg/container.js");
const texMod = await imp("renderer/vendor/we-scene/pkg/texture.js");

const { check, errors } = createChecker();
const readJson = (pkg, name) => {
  const b = getEntry(pkg, name);
  if (!b) return null;
  try { return JSON.parse(dec.decode(b)); } catch { return null; }
};

// ---------- 1. 全库 TEXS 帧表必须解析出来且 UV 落在 [0,1] ----------
const texsFiles = [];
if (fs.existsSync(LIB)) {
  for (const id of fs.readdirSync(LIB)) {
    const p = join(LIB, id, "scene.pkg");
    if (!fs.existsSync(p)) continue;
    let pkg;
    try { pkg = parsePkg(new Uint8Array(fs.readFileSync(p))); } catch { continue; }
    for (const e of pkg.entries) {
      if (!e.name.endsWith(".tex")) continue;
      const raw = getEntry(pkg, e.name);
      // 只关心尾部真的有 TEXS 段的贴图（从后往前找，避免图像数据里的巧合匹配）
      let at = -1;
      for (let i = raw.length - 13; i >= 0; i--) {
        if (raw[i] === 84 && raw[i + 1] === 69 && raw[i + 2] === 88 && raw[i + 3] === 83 && raw[i + 8] === 0) { at = i; break; }
      }
      if (at < 0) continue;
      const magic = Array.from(raw.subarray(at, at + 8)).map((b) => String.fromCharCode(b)).join("");
      let parsed;
      try { parsed = texMod.parseTex(raw); } catch (err) {
        errors.push(`${id}/${e.name} 解析抛错: ${err.message}`);
        continue;
      }
      texsFiles.push({ id, name: e.name, magic, frames: parsed.frames });
    }
  }
}

let rotTotal = 0;
for (const f of texsFiles) {
  const tag = `${f.id}/${f.name.split("/").pop()}`;
  // 尾部有 TEXS 段就必须解析成功 —— 丢表的后果是整张 sheet 铺满 quad
  if (!f.frames) {
    errors.push(`${tag} (${f.magic}) 有 TEXS 段却没解析出帧表`);
    continue;
  }
  const { atlasWidth: aw, atlasHeight: ah, list } = f.frames;
  check(aw > 0 && ah > 0, `${tag} 帧表缺 atlasWidth/Height（渲染端会拿错分母）`);
  if (!(aw > 0 && ah > 0)) continue;
  let bad = 0;
  for (const fr of list) {
    if (fr.rotated) rotTotal++;
    check(Array.isArray(fr.uDir) && Array.isArray(fr.vDir), `${tag} 帧缺仿射基 uDir/vDir`);
    if (!Array.isArray(fr.uDir)) break;
    // 宽高取基向量长度：旋转帧里 uDir 沿 y，取 uDir[0] 当宽会得到 0
    if (!(fr.width > 0 && fr.height > 0)) { bad++; continue; }
    // 四个角都得落在图集内（含 1px 容差，WE 自身打包有取整）
    const us = [fr.x, fr.x + fr.uDir[0], fr.x + fr.vDir[0], fr.x + fr.uDir[0] + fr.vDir[0]].map((v) => v / aw);
    const vs = [fr.y, fr.y + fr.uDir[1], fr.y + fr.vDir[1], fr.y + fr.uDir[1] + fr.vDir[1]].map((v) => v / ah);
    if (Math.min(...us) < -0.002 || Math.max(...us) > 1.002 || Math.min(...vs) < -0.002 || Math.max(...vs) > 1.002) bad++;
  }
  check(bad === 0, `${tag} 有 ${bad}/${list.length} 帧的 UV 越界或宽高非正`);
}
console.log(`【TEXS 帧表】${texsFiles.length} 张带帧表的贴图，旋转打包帧 ${rotTotal} 个`);
if (fs.existsSync(LIB)) {
  check(texsFiles.length >= 30, `带 TEXS 段的贴图数异常偏低: ${texsFiles.length}（预期 ≥30）`);
  // 旋转帧是本实现存在的理由之一；归零说明解析退化回了矩形
  check(rotTotal >= 3, `旋转打包帧数异常: ${rotTotal}（预期 ≥3，样本 Raiden Friends）`);
}

// ---------- 2. 三个已知样本的精确断言 ----------
if (fs.existsSync(LIB)) {
  const sample = (id, texPath, expect) => {
    const p = join(LIB, id, "scene.pkg");
    if (!fs.existsSync(p)) { console.log(`   （跳过 ${id}：不在库中）`); return null; }
    const pkg = parsePkg(new Uint8Array(fs.readFileSync(p)));
    const raw = getEntry(pkg, texPath);
    if (!raw) { errors.push(`${id} 缺贴图条目 ${texPath}`); return null; }
    const fr = texMod.parseTex(raw).frames;
    if (!fr) { errors.push(`${id}/${texPath} 帧表未解析出来`); return null; }
    check(fr.list.length === expect.count, `${id} 帧数应为 ${expect.count}，实测 ${fr.list.length}`);
    check(fr.atlasWidth === expect.aw && fr.atlasHeight === expect.ah,
      `${id} atlas 应为 ${expect.aw}x${expect.ah}，实测 ${fr.atlasWidth}x${fr.atlasHeight}`);
    console.log(`   ${id} ${fr.magic.slice(0, 8)} ${fr.list.length}帧 atlas=${fr.atlasWidth}x${fr.atlasHeight} 单帧=${fr.list[0].width}x${fr.list[0].height}`);
    return fr;
  };
  console.log("【样本】");
  // 猫：TEXS0003、42 帧 6x7 网格、自动播
  const cat = sample("3250755486", "materials/cat-eating.tex", { count: 42, aw: 1320, ah: 1540 });
  // Raiden：TEXS0003、81 帧、末 3 帧旋转打包
  const raiden = sample("2623473016", "materials/Raiden Friends.tex", { count: 81, aw: 8192, ah: 2048 });
  // TEXS0002 唯一样本：头部 textureWidth(316x214) 是单帧尺寸，图集实为 2048x1024
  sample("1444077782", "materials/20180720153036.tex", { count: 23, aw: 2048, ah: 1024 });

  if (raiden) {
    const rot = raiden.list.filter((f) => f.rotated);
    check(rot.length === 3, `Raiden 旋转帧应为 3，实测 ${rot.length}`);
    // 旋转帧的宽高必须来自基向量长度而不是分量
    for (const f of rot) {
      check(Math.abs(f.width - 600) < 1 && Math.abs(f.height - 338) < 1,
        `Raiden 旋转帧宽高应为 600x338，实测 ${f.width}x${f.height}`);
    }
  }

  // 帧选择：与 renderer.js 的 spriteFrameBasis 累加逻辑逐字一致
  if (cat) {
    const pick = (list, time) => {
      let total = 0;
      for (const f of list) total += f.duration > 0 ? f.duration : 1 / 30;
      let t = time % total;
      if (t < 0) t += total;
      let idx = 0;
      for (let i = 0; i < list.length; i++) {
        const d = list[i].duration > 0 ? list[i].duration : 1 / 30;
        if (t < d) { idx = i; break; }
        t -= d;
        idx = i;
      }
      return idx;
    };
    // duration 是 float32（0.1 存成 0.10000000149），累加边界不能按十进制 0.1 推算，
    // 必须用实际前缀和 —— 早期我按 t=2.0→帧20 断言，实测是帧 19，是期望值算错。
    const list = cat.list;
    const total = list.reduce((s, f) => s + (f.duration > 0 ? f.duration : 1 / 30), 0);
    let acc = 0;
    for (let i = 0; i < list.length; i++) {
      const d = list[i].duration > 0 ? list[i].duration : 1 / 30;
      // 每帧区间正中间必须选中该帧
      const mid = acc + d / 2;
      const got = pick(list, mid);
      check(got === i, `帧选择错位：t=${mid.toFixed(4)} 应选帧 ${i}，实测 ${got}`);
      acc += d;
    }
    check(pick(list, 0) === 0, "t=0 必须是第 0 帧");
    // 循环回绕：整周期末尾 + 半帧应回到帧 0
    const wrap = pick(list, total + 0.001);
    check(wrap === 0, `循环回绕失败：t=总时长+0.001 应回到帧 0，实测 ${wrap}`);
    // 负时间不得算出负索引
    check(pick(list, -0.05) >= 0, "负时间不得算出负帧索引");
    console.log(`   帧选择：${list.length} 帧逐帧中点全部命中，周期 ${total.toFixed(3)}s，回绕正常`);
  }
}

// ---------- 3. 库内 spritesheet 图层分布（含 combo 大小写） ----------
if (fs.existsSync(LIB)) {
  let nLayer = 0;
  let nWp = 0;
  let nScripted = 0;
  let lowerCaseCombo = 0;
  let upperCaseCombo = 0;
  for (const id of fs.readdirSync(LIB)) {
    const p = join(LIB, id, "scene.pkg");
    if (!fs.existsSync(p)) continue;
    let pkg;
    try { pkg = parsePkg(new Uint8Array(fs.readFileSync(p))); } catch { continue; }
    const scene = readJson(pkg, "scene.json");
    if (!scene) continue;
    let hit = 0;
    for (const o of scene.objects || []) {
      if (!o.image) continue;
      const mdl = readJson(pkg, o.image);
      if (!mdl || !mdl.material) continue;
      const mat = readJson(pkg, mdl.material);
      if (!mat) continue;
      let sheet = false;
      for (const ps of mat.passes || []) {
        for (const k of Object.keys(ps.combos || {})) {
          if (k.toLowerCase() !== "spritesheet" || Number(ps.combos[k]) !== 1) continue;
          sheet = true;
          if (k === "spritesheet") lowerCaseCombo++;
          else upperCaseCombo++;
        }
      }
      if (!sheet) continue;
      hit++;
      nLayer++;
      // 脚本钉帧的层：属性值形如 {script: "...getTextureAnimation()..."}
      if (Object.values(o).some((v) => v && typeof v === "object" && typeof v.script === "string" && /getTextureAnimation/.test(v.script))) nScripted++;
    }
    if (hit) nWp++;
  }
  console.log(`【图层分布】${nLayer} 层 / ${nWp} 壁纸；脚本钉帧 ${nScripted}，自动播 ${nLayer - nScripted}`);
  console.log(`   combo 键名：小写 spritesheet ${lowerCaseCombo}，大写 SPRITESHEET ${upperCaseCombo}`);
  check(nLayer >= 45, `spritesheet 图层数异常偏低: ${nLayer}（预期 ≥45）`);
  // 两种大小写都必须有样本 —— 若某一侧归零，说明扫描逻辑又只认一种写法了
  check(lowerCaseCombo > 0, "库内应有小写 `spritesheet` combo 样本");
  check(upperCaseCombo > 0, "库内应有大写 `SPRITESHEET` combo 样本");
  // 脚本钉帧是多数派；若骤降说明 scene.json 的脚本字段没被识别
  check(nScripted >= 30, `脚本钉帧层数异常偏低: ${nScripted}（预期 ≥30）`);
}

// ---------- 4. 实现必须真的接线 ----------
{
  const rsrc = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/renderer.js"), "utf8");
  // COPY_FRAG 的 GLSL 本体已拆至 renderer-glsl.js（engineering/modularization），
  // 接线检查仍看 renderer.js
  const gsrc = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/renderer-glsl.js"), "utf8");
  check(/spriteFrameBasis\s*\(/.test(rsrc), "renderer.js 未定义/调用 spriteFrameBasis");
  check(/u_FrameOrigin/.test(gsrc) && /u_FrameU/.test(gsrc) && /u_FrameV/.test(gsrc),
    "COPY_FRAG 缺仿射基 uniform（u_FrameOrigin/U/V）");
  // 采样必须是仿射组合；退回 `origin + uv * scale` 的矩形写法会丢旋转帧
  check(/u_FrameOrigin\s*\+\s*v_UV\.x\s*\*\s*u_FrameU\s*\+\s*v_UV\.y\s*\*\s*u_FrameV/.test(gsrc),
    "COPY_FRAG 必须按 origin + u·uDir + v·vDir 做仿射采样");
  // 无效果链的图层也要传帧基（猫层就走这条路径）
  check(/compositeLayer\([\s\S]{0,200}spriteFrameBasis\(/.test(rsrc),
    "无效果链路径未把帧基传给 compositeLayer（序列帧层会整图铺满）");
  // 脚本钉帧优先于时间自动播
  check(/layer\.textureAnimation/.test(rsrc), "renderer.js 未读取 layer.textureAnimation（脚本钉帧不生效）");
  // 分母不得回退到头部 textureWidth
  const fnStart = rsrc.indexOf("function spriteFrameBasis");
  const fn = rsrc.slice(fnStart, fnStart + 2600);
  // 只看代码，注释里提到 textureWidth 是在解释「不能用它」，不算违规
  const fnCode = fn.replace(/\/\/[^\n]*/g, "");
  check(!/textureWidth/.test(fnCode), "spriteFrameBasis 不得用 .tex 头部的 textureWidth 当分母");
  check(/atlasWidth/.test(fnCode), "spriteFrameBasis 应优先用帧表的 atlasWidth 当分母");

  const tsrc = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/text.js"), "utf8");
  check(/makeTextureAnimation/.test(tsrc), "text.js 未实现 makeTextureAnimation");
  check(/getTextureAnimation:\s*\(\)\s*=>\s*makeTextureAnimation\(layer\)/.test(tsrc),
    "thisLayer.getTextureAnimation 仍返回中性对象（37 层脚本钉帧失效）");
  // 同一图层多次取必须拿到同一份状态（init 存变量、update 每帧重取两种写法都有）
  check(/layer\.textureAnimation\s*\)\s*return\s+layer\.textureAnimation\.api/.test(tsrc),
    "makeTextureAnimation 必须对同一图层复用同一状态");

  // spritesheet combo 识别与 atlasWidth 透传在 scene-mount.ts（engineering/modularization 拆分）
  const msrc = fs.readFileSync(join(ROOT, "renderer/src/scene-mount.ts"), "utf8");
  check(/toLowerCase\(\)\s*===\s*"spritesheet"/.test(msrc),
    "main.ts 必须大小写无关地识别 spritesheet combo");
  check(/atlasWidth/.test(msrc), "main.ts 未把 atlasWidth/Height 透给渲染端");

  const psrc = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/particles.js"), "utf8");
  check(/atlasWidth/.test(psrc), "particles.js 未使用帧表的 atlasWidth 当分母");
}

if (errors.length) {
  console.error(`verify-sprites: ${errors.length} 处失败`);
  for (const e of errors) console.error("  - " + e);
  process.exit(1);
}
console.log("verify-sprites: all checks passed");
