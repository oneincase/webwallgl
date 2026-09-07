#!/usr/bin/env node
/**
 * puppet 附着点挂件的离线校验。
 *
 * 3790987854 头漂在身体右下方：parse 把子 origin 相对父图层中心合并，
 * 而 WE 的 attachment 语义是相对 MDAT 附着点。本脚本锁住：
 *
 *   1. parse.js 留下 attachment 字段（全等匹配，不要前缀）
 *   2. applyAttachmentBindOrigins 把挂件放到「父 origin + 绑定附着点 + local」
 *   3. 找不到附着点时退化成普通父子合并（不乱加）
 *   4. followAttachments 从 base 重写、不累加；接线存在于 scene-mount
 *
 * 对照壁纸：3790987854 头、3436945972 黑头/白发官、3786330502 头发、
 * 3790371777 眼睛/发簪、3791001607 主发（附着点层的子孙也要跟着挪）。
 */
import fs from "node:fs";
import path from "node:path";
import { LIB, ROOT, imp, createChecker, dec } from "./lib/verify-kit.mjs";

const { check, fail, errors } = createChecker({ echo: true });
const { parsePkg, getEntry } = await imp("renderer/vendor/we-scene/pkg/container.js");
const { parseScene } = await imp("renderer/vendor/we-scene/scene/parse.js");
const {
  parseMDL,
  attachmentBind,
  parentMeshToWorldDelta,
  applyAttachmentBindOrigins,
  followAttachments,
  computeSkinMatrices,
  attachmentWorld,
} = await imp("renderer/vendor/we-scene/render/mdl.js");

const hypot = (x, y) => Math.hypot(x, y);

function loadWallpaper(id) {
  const dir = path.join(LIB, String(id));
  const pkgPath = path.join(dir, "scene.pkg");
  const projPath = path.join(dir, "project.json");
  if (!fs.existsSync(pkgPath)) return null;
  const parsed = parsePkg(fs.readFileSync(pkgPath));
  const sceneJson = JSON.parse(dec.decode(getEntry(parsed, "scene.json")));
  const project = fs.existsSync(projPath) ? JSON.parse(fs.readFileSync(projPath, "utf8")) : {};
  const scene = parseScene(sceneJson, project);
  return { id, parsed, scene };
}

function attachPuppets(scene, parsedPkg) {
  let n = 0;
  for (const layer of scene.layers) {
    if (!layer.image) continue;
    const raw = getEntry(parsedPkg, layer.image);
    if (!raw) continue;
    let model;
    try {
      model = JSON.parse(dec.decode(raw));
    } catch {
      continue;
    }
    if (!model.puppet) continue;
    const mdlBuf = getEntry(parsedPkg, model.puppet);
    if (!mdlBuf) continue;
    layer.puppet = parseMDL(mdlBuf);
    n++;
  }
  return n;
}

function findLayer(scene, name, attachment) {
  return scene.layers.find((l) => l.name === name && (!attachment || l.attachment === attachment));
}

function neckOf(parent, attName) {
  const m = attachmentBind(parent.puppet, attName);
  if (!m) return null;
  const d = parentMeshToWorldDelta(parent, m[12], m[13]);
  return [parent.origin[0] + d[0], parent.origin[1] + d[1]];
}

// ---------- 源码接线 ----------
{
  const psrc = fs.readFileSync(path.join(ROOT, "renderer/vendor/we-scene/scene/parse.js"), "utf8");
  check(/attachment:\s*typeof o\.attachment === 'string'/.test(psrc),
    "parse.js 未把 scene.json 的 attachment 字段留到图层上");
  check(!/attachmentBind/.test(psrc),
    "parse.js 不应在没 MDL 时自己加附着点偏移");

  const ssrc = fs.readFileSync(path.join(ROOT, "renderer/vendor/we-scene/render/mdl-skin.js"), "utf8");
  check(/if \(at\.name !== name\) continue/.test(ssrc),
    "附着点名字必须全等匹配（左头发1 / 左头发2 只差末位数字）");
  check(/function applyAttachmentBindOrigins/.test(ssrc), "applyAttachmentBindOrigins 缺失");
  check(/function followAttachments/.test(ssrc), "followAttachments 缺失");
  check(/collectDesc/.test(ssrc) && /c\.origin\[0\] \+= d\[0\]/.test(ssrc),
    "applyAttachmentBindOrigins 必须把附着点位移传给子孙（空组头发/黍头下的眼睛）");
  check(/f\.subtree/.test(ssrc) && /s\.layer\.origin\[0\] = b\[0\]/.test(ssrc) && /attachBase/.test(ssrc),
    "followAttachments 必须从子孙绑定快照重写（attachBase 优先、退回挂载期 s.x/s.y），" +
    "不能只写 f.layer、也不能拿 layer.origin 当基准累加");

  const mount = fs.readFileSync(path.join(ROOT, "renderer/src/scene-mount.ts"), "utf8");
  check(/applyAttachmentBindOrigins\s*\(/.test(mount),
    "scene-mount 未调用 applyAttachmentBindOrigins（静态定位不会生效）");
  check(/followAttachments\s*\(/.test(mount),
    "scene-mount 未调用 followAttachments（挂件不会随骨摆）");
}

// ---------- 3790987854 头：父合并偏 2181px，加上附着点后应对准脖子 + local ----------
{
  const wp = loadWallpaper(3790987854);
  if (!wp) {
    fail("壁纸库缺少 3790987854");
  } else {
    const head = findLayer(wp.scene, "头", "头");
    check(!!head, "3790987854 解析后应有 attachment='头' 的「头」层");
    check(head && head.attachment === "头", "头层 attachment 必须是字符串「头」");
    const before = head ? [head.origin[0], head.origin[1]] : [0, 0];
    attachPuppets(wp.scene, wp.parsed);
    const parent = wp.scene.layers.find((l) => l.id === head.parentId);
    check(!!(parent && parent.puppet), "身体部件应装上 puppet");
    const neck = parent ? neckOf(parent, "头") : null;
    const follows = applyAttachmentBindOrigins(wp.scene.layers);
    const after = [head.origin[0], head.origin[1]];
    const dBefore = hypot(before[0] - neck[0], before[1] - neck[1]);
    const dAfter = hypot(after[0] - neck[0], after[1] - neck[1]);
    check(dBefore > 2000, `未加附着点时头应远离脖子（实测 ${dBefore.toFixed(0)}px），否则用例没有鉴别力`);
    check(Math.abs(dAfter - hypot(1297.48083, 221.27478)) < 1,
      `加上附着点后头中心相对脖子应等于 local (1297,221)，实测 Δ=${dAfter.toFixed(1)} origin=${after.map((n) => n.toFixed(0))}`);
    check(Math.abs(after[0] - 2105.4) < 1 && Math.abs(after[1] - 1745.9) < 1,
      `3790987854 头 origin 期望约 (2105,1746)，实得 (${after[0].toFixed(1)},${after[1].toFixed(1)})`);
    check(follows.some((f) => f.layer === head), "头层应进入 follow 表");

    const base = [head.origin[0], head.origin[1]];
    followAttachments(follows, 0, () => null);
    const t0 = [head.origin[0], head.origin[1]];
    check(Number.isFinite(t0[0]) && Number.isFinite(t0[1]), "follow t=0 origin 含 NaN");
    check(hypot(t0[0] - base[0], t0[1] - base[1]) < 50,
      `3790987854 附着点动画摆幅应是个位数像素，t=0 相对 base ${hypot(t0[0] - base[0], t0[1] - base[1]).toFixed(1)}px`);
    followAttachments(follows, 0, () => null);
    check(hypot(head.origin[0] - t0[0], head.origin[1] - t0[1]) < 1e-6,
      "followAttachments 调用两次必须得到同一 origin（从 base 重写，不是累加）");

    // 反向：名字对不上时不得移动
    const saved = [head.origin[0], head.origin[1]];
    head.attachment = "不存在的附着点";
    // 已经加过一次，再 apply 会用错误名字跳过 —— 另取一份干净场景
    const wp2 = loadWallpaper(3790987854);
    attachPuppets(wp2.scene, wp2.parsed);
    const head2 = findLayer(wp2.scene, "头", "头");
    head2.attachment = "不存在的附着点";
    const before2 = [head2.origin[0], head2.origin[1]];
    applyAttachmentBindOrigins(wp2.scene.layers);
    check(hypot(head2.origin[0] - before2[0], head2.origin[1] - before2[1]) < 1e-6,
      "找不到附着点时应保持普通父子合并，不得乱加偏移");
    void saved;
  }
}

// ---------- 3436945972 黑头 / 白发官：小图必须盖在脖子上 ----------
{
  const wp = loadWallpaper(3436945972);
  if (!wp) {
    fail("壁纸库缺少 3436945972");
  } else {
    attachPuppets(wp.scene, wp.parsed);
    applyAttachmentBindOrigins(wp.scene.layers);
    const cases = [
      { name: "黑头", att: "黑头", local: [1.93864, 79.26746] },
      { name: "白发官", att: "白头", local: [9.3, 70.9] },
    ];
    for (const c of cases) {
      const layer = wp.scene.layers.find((l) => l.name === c.name && l.attachment === c.att);
      check(!!layer, `3436945972 应有 ${c.name} (attachment=${c.att})`);
      if (!layer) continue;
      const parent = wp.scene.layers.find((l) => l.id === layer.parentId);
      const neck = neckOf(parent, c.att);
      const d = [layer.origin[0] - neck[0], layer.origin[1] - neck[1]];
      const want = parentMeshToWorldDelta(parent, c.local[0], c.local[1]);
      check(hypot(d[0] - want[0], d[1] - want[1]) < 1.5,
        `${c.name} 相对脖子应等于 scale/rotate(local)=(${want[0].toFixed(1)},${want[1].toFixed(1)})，实测 (${d[0].toFixed(1)},${d[1].toFixed(1)})`);
      const half = Math.hypot(layer.size[0] * (parent.scale?.[0] || 1), layer.size[1] * (parent.scale?.[1] || 1)) / 2;
      check(hypot(d[0], d[1]) < half,
        `${c.name} 中心离脖子 ${hypot(d[0], d[1]).toFixed(0)}px，半对角 ${half.toFixed(0)}px —— 父合并方案会盖不住脖子`);
    }
  }
}

// ---------- 3786330502 头发：大 local 的挂件同样是附着点相对 ----------
{
  const wp = loadWallpaper(3786330502);
  if (!wp) {
    fail("壁纸库缺少 3786330502");
  } else {
    const hair = wp.scene.layers.find((l) => l.name === "头发" && l.attachment === "头发");
    check(!!hair, "3786330502 应有 attachment='头发' 的「头发」层");
    if (hair) {
      attachPuppets(wp.scene, wp.parsed);
      const parent = wp.scene.layers.find((l) => l.id === hair.parentId);
      applyAttachmentBindOrigins(wp.scene.layers);
      const neck = neckOf(parent, "头发");
      const d = [hair.origin[0] - neck[0], hair.origin[1] - neck[1]];
      const want = parentMeshToWorldDelta(parent, 1281.70789, -384.96970);
      check(hypot(d[0] - want[0], d[1] - want[1]) < 1,
        `3786330502 头发相对脖子应等于 scale/rotate(local)=(${want[0].toFixed(1)},${want[1].toFixed(1)})，实测 (${d[0].toFixed(1)},${d[1].toFixed(1)})`);
    }
  }
}

// ---------- attachmentWorld 与 attachmentBind 在绑定姿势下应重合 ----------
{
  const wp = loadWallpaper(3790987854);
  if (wp) {
    attachPuppets(wp.scene, wp.parsed);
    const body = wp.scene.layers.find((l) => l.name === "身体部件" && l.puppet);
    if (body) {
      const bindM = attachmentBind(body.puppet, "头");
      // 不播动画：把所有层标成不可见，computeSkinMatrices 会退到第一条动画而不是绑定姿势。
      // 直接比 attachmentBind 与「零位移时 attachmentWorld 需要 _world」。
      // 这里改用：computeSkinMatrices 之后 attachmentWorld 必须能取到同名点。
      computeSkinMatrices(body.puppet, 0, body.animationLayers, null);
      const cur = attachmentWorld(body.puppet, "头");
      check(!!bindM && !!cur, "头附着点 bind/current 都应能取到");
      if (bindM && cur) {
        check(hypot(cur[12] - bindM[12], cur[13] - bindM[13]) < 50,
          `t=0 附着点相对绑定姿势应是小位移，实测 (${(cur[12] - bindM[12]).toFixed(1)},${(cur[13] - bindM[13]).toFixed(1)})`);
      }
      check(attachmentBind(body.puppet, "左头发1") === null, "不存在的附着点名必须返回 null（防前缀误匹配）");
    }
  }
}

// ---------- 3790371777 眼睛偏左 / 发簪悬空：黍头、长发加了附着点，子孙没跟 ----------
{
  const wp = loadWallpaper(3790371777);
  if (!wp) {
    fail("壁纸库缺少 3790371777");
  } else {
    attachPuppets(wp.scene, wp.parsed);
    const head = wp.scene.layers.find((l) => l.name === "黍头" && l.attachment === "黍头");
    const eye = wp.scene.layers.find((l) => l.name === "眼睛" && l.id === 40);
    const pin = wp.scene.layers.find((l) => l.name === "发簪");
    const hair = wp.scene.layers.find((l) => l.name === "长发" && l.attachment === "长发");
    check(!!(head && eye && pin && hair), "3790371777 应有 黍头/眼睛/发簪/长发");
    const eyeBefore = eye ? [eye.origin[0], eye.origin[1]] : [0, 0];
    const pinBefore = pin ? [pin.origin[0], pin.origin[1]] : [0, 0];
    const headBefore = head ? [head.origin[0], head.origin[1]] : [0, 0];
    const hairBefore = hair ? [hair.origin[0], hair.origin[1]] : [0, 0];
    applyAttachmentBindOrigins(wp.scene.layers);
    const dHead = [head.origin[0] - headBefore[0], head.origin[1] - headBefore[1]];
    const dEye = [eye.origin[0] - eyeBefore[0], eye.origin[1] - eyeBefore[1]];
    const dHair = [hair.origin[0] - hairBefore[0], hair.origin[1] - hairBefore[1]];
    const dPin = [pin.origin[0] - pinBefore[0], pin.origin[1] - pinBefore[1]];
    check(hypot(dHead[0], dHead[1]) > 100, `黍头附着点位移应明显（实测 ${hypot(dHead[0], dHead[1]).toFixed(0)}px）`);
    check(hypot(dEye[0] - dHead[0], dEye[1] - dHead[1]) < 1,
      `眼睛应跟上黍头位移 (${dHead[0].toFixed(1)},${dHead[1].toFixed(1)})，实测 (${dEye[0].toFixed(1)},${dEye[1].toFixed(1)})`);
    check(hypot(dPin[0] - dHair[0], dPin[1] - dHair[1]) < 1,
      `发簪应跟上长发位移 (${dHair[0].toFixed(1)},${dHair[1].toFixed(1)})，实测 (${dPin[0].toFixed(1)},${dPin[1].toFixed(1)})`);
  }
}

// ---------- 3791001607 头发掉在胸口：空组「头发」加了附着点，「主发」没跟 ----------
{
  const wp = loadWallpaper(3791001607);
  if (!wp) {
    fail("壁纸库缺少 3791001607");
  } else {
    attachPuppets(wp.scene, wp.parsed);
    const hair = wp.scene.layers.find((l) => l.name === "头发" && l.id === 2754);
    const main = wp.scene.layers.find((l) => l.name === "主发" && l.parentId === 2754);
    check(!!(hair && main), "3791001607 应有空组头发 2754 及其子层主发");
    const hairBefore = hair ? [hair.origin[0], hair.origin[1]] : [0, 0];
    const mainBefore = main ? [main.origin[0], main.origin[1]] : [0, 0];
    applyAttachmentBindOrigins(wp.scene.layers);
    const dHair = [hair.origin[0] - hairBefore[0], hair.origin[1] - hairBefore[1]];
    const dMain = [main.origin[0] - mainBefore[0], main.origin[1] - mainBefore[1]];
    check(hypot(dHair[0], dHair[1]) > 500, `头发空组应上移约 850px，实测 ${hypot(dHair[0], dHair[1]).toFixed(0)}px`);
    check(hypot(dMain[0] - dHair[0], dMain[1] - dHair[1]) < 1,
      `主发应跟上头发空组 (${dHair[0].toFixed(1)},${dHair[1].toFixed(1)})，实测 (${dMain[0].toFixed(1)},${dMain[1].toFixed(1)})`);
    const parent = wp.scene.layers.find((l) => l.id === hair.parentId);
    const neck = neckOf(parent, "头发");
    const d = [main.origin[0] - neck[0], main.origin[1] - neck[1]];
    const want = parentMeshToWorldDelta(parent, -1.12158 + 89.88184, -220.94214 + -31.72168);
    check(hypot(d[0] - want[0], d[1] - want[1]) < 2,
      `主发相对头发附着点应等于 头发local+主发local，期望 (${want[0].toFixed(1)},${want[1].toFixed(1)}) 实测 (${d[0].toFixed(1)},${d[1].toFixed(1)})`);
  }
}

// ---------- 3786330502：祖先带脚本变换时，挂件必须跟着整组走 ----------
// 人物组 550「主题1」的 origin 绑了脚本（点绿箭头后整组滑 700px）。它下面
// 隔一层挂着 7 个 attachment 层（眼睛 / 眼泪×4 / 头发 / 眼眉）。
//
// followAttachments 原先每帧把挂件 origin 拍回**挂载期**快照 f.baseX/baseY，
// 等于把祖先的位移整个撤销 —— 人物滑走、五官留在原地，人一分为二。
// 修法是 recomposeWorld 每帧重写 layer.attachBase（绑定姿势世界位），
// follow 从它重写再叠骨骼增量。
//
// 这条判据必须是**数值**的：只查 attachBase 出现在源码里抓不到「发布了但没接上」。
{
  const wp = loadWallpaper(3786330502);
  if (!wp) {
    fail("壁纸库缺少 3786330502");
  } else {
    const { recomposeWorld, collectTransformDirty } = await imp("renderer/vendor/we-scene/scene/parse.js");
    attachPuppets(wp.scene, wp.parsed);
    const follows = applyAttachmentBindOrigins(wp.scene.layers);
    const dirty = collectTransformDirty(wp.scene.layers, follows.map((f) => f.layer));
    // 人物组 550 的整棵子树里，挂件层应当被收进脏集合
    const eyes = wp.scene.layers.find((l) => l.id === 626 && l.attachment === "眼睛");
    check(!!eyes, "3786330502 应有 attachment='眼睛' 的眼睛层 (id=626)");
    if (eyes) {
      check(dirty.has(eyes.id), "眼睛（挂件）应进入 transform 脏集合，否则祖先动了它不会重算");
      followAttachments(follows, 0, () => null);
      const eyeBefore = [eyes.origin[0], eyes.origin[1]];
      // 人物组 550 滑 700px（作者脚本 ck=2 时 origin.x 1920→1220）
      const g550 = wp.scene.layers.find((l) => l.id === 550);
      check(!!g550 && !!g550.localOrigin, "550 主题1 应有 localOrigin");
      g550.localOrigin[0] -= 700;
      recomposeWorld(wp.scene.layers, dirty);
      followAttachments(follows, 0, () => null);
      const dEye = eyes.origin[0] - eyeBefore[0];
      check(Math.abs(dEye + 700) < 1,
        `人物组滑 -700px 后眼睛应同量位移，实测 ${dEye.toFixed(1)}px` +
        "（followAttachments 把 origin 拍回了挂载期快照，撤销了祖先位移 → 人物一分为二）");
      // 幂等：连调两次仍是同一位置
      const twice = [eyes.origin[0], eyes.origin[1]];
      followAttachments(follows, 0, () => null);
      check(hypot(eyes.origin[0] - twice[0], eyes.origin[1] - twice[1]) < 1e-6,
        "祖先移动后 followAttachments 仍须幂等（连调两次同一 origin）");
    }
  }
}

if (errors.length) {
  console.error(`\nverify-attachments：${errors.length} 项失败`);
  process.exit(1);
}
console.log("\nverify-attachments：全部通过");
