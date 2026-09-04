#!/usr/bin/env node
/**
 * 粒子系统的离线校验：拿本机壁纸库里**真实的** scene.pkg 跑全量粒子系统，
 * 不依赖浏览器，也不依赖 WebGL。
 *
 * 为什么需要它：页面转入后台时浏览器会节流 requestAnimationFrame、画布停止更新，
 * 截图会读成一片空白（实测整屏亮度为 0），靠肉眼看渲染结果不可靠。而粒子的正确性
 * 集中在两处纯数值逻辑上，都可以在 Node 里复算：
 *   1. 模拟：发射器/初始化器/算子的数值行为（scripts/particle-raster.mjs 不参与这部分）；
 *   2. 光栅化：实例数据 → quad 展开 + 混合叠加（由 particle-raster.mjs 按 shader 公式复算）。
 *
 * 用法：
 *   node scripts/verify-particles.mjs            两项都跑
 *   node scripts/verify-particles.mjs sim        只跑模拟
 *   node scripts/verify-particles.mjs raster     只跑光栅器
 *   WE_LIBRARY=/path/to/wallpapers node scripts/verify-particles.mjs
 *
 * 退出码非 0 表示发现问题，可直接用于 CI。
 */
import fs from "node:fs";
import { join } from "node:path";
import zlib from "node:zlib";

import { LIB, ROOT, imp } from "./lib/verify-kit.mjs";
const {
  ParticleSystem,
  particlePassRefract,
  rgbaIsBlankWhite,
  spriteTrailLengthFactor,
  spriteTrailRotation,
  particleInstanceSegs,
} = await imp("renderer/vendor/we-scene/render/particles.js");
const ptex = await imp("renderer/vendor/we-scene/render/particle-textures.js");
const { createTarget, rasterizeSystem, analyzeTarget } = await imp(
  "scripts/particle-raster.mjs",
);
const texMod = await imp("renderer/vendor/we-scene/pkg/texture.js");

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
const parseVec = (s, dflt) => {
  if (s === undefined || s === null) return dflt ? dflt.slice() : [0, 0, 0];
  if (typeof s === "object") return parseVec(s.value, dflt);
  const p = String(s).trim().split(/\s+/).map(Number);
  return [p[0] || 0, p[1] || 0, p[2] || 0];
};
// fitWindow('cover') 的复刻（见 render/math.js）
function fitCover(projW, projH, W, H) {
  const s = Math.max(W / projW, H / projH);
  const viewW = W / s;
  const viewH = H / s;
  return { offX: (projW - viewW) / 2, offY: (projH - viewH) / 2, viewW, viewH, projH };
}

// 遍历壁纸库，产出 { id, projW, projH, systems: [{name, model, layer, override, texName}] }
function* eachScene() {
  if (!fs.existsSync(LIB)) {
    console.error(`✗ 找不到壁纸库：${LIB}`);
    console.error("  用 WE_LIBRARY=/path/to/wallpapers 指定。");
    process.exit(1);
  }
  for (const dir of fs.readdirSync(LIB).sort()) {
    const pkgPath = join(LIB, dir, "scene.pkg");
    if (!fs.existsSync(pkgPath)) continue;
    let pkg;
    try {
      pkg = parsePkg(fs.readFileSync(pkgPath));
    } catch {
      continue;
    }
    const sceneEntry = getEntry(pkg, "scene.json");
    if (!sceneEntry) continue;
    let scene;
    try {
      scene = JSON.parse(readText(sceneEntry));
    } catch {
      continue;
    }
    const objs = (scene.objects || []).filter((o) => typeof o.particle === "string");
    if (!objs.length) continue;
    const ortho = scene.general?.orthogonalprojection;
    const out = [];
    for (const o of objs) {
      const me = getEntry(pkg, o.particle);
      if (!me) continue;
      let model;
      try {
        model = JSON.parse(readText(me));
      } catch {
        continue;
      }
      let texName = null;
      let material = null;
      if (model.material) {
        const mt = getEntry(pkg, model.material);
        if (mt) {
          try {
            material = JSON.parse(readText(mt));
            texName = material?.passes?.[0]?.textures?.[0] || null;
          } catch {
            /* 材质损坏：走贴图兜底 */
          }
        }
      }
      out.push({
        path: o.particle,
        name: o.name || "",
        pkg,
        model,
        material,
        texName,
        override: o.instanceoverride || null,
        layer: {
          origin: parseVec(o.origin),
          scale: parseVec(o.scale, [1, 1, 1]),
          angles: parseVec(o.angles),
        },
      });
    }
    if (out.length) {
      yield { id: dir, projW: ortho?.width || 1920, projH: ortho?.height || 1080, systems: out };
    }
  }
}

function build(sysDesc) {
  const ps = new ParticleSystem(null, sysDesc.model, sysDesc.override, sysDesc.layer);
  if (sysDesc.material) ps.setMaterial(sysDesc.material);
  // 与 main.ts 的 loadParticleTex 同策略：先找 pkg 内真实 .tex（可带 TEXS 序列帧表
  // 与真实宽高比），缺失时才程序化生成内置素材。
  let pixels = null;
  let frames = null;
  if (sysDesc.texName) {
    const raw = getEntry(sysDesc.pkg, `materials/${sysDesc.texName}.tex`);
    if (raw) {
      try {
        const parsed = texMod.parseTex(raw);
        if (parsed.frames?.list?.length) frames = parsed.frames.list;
        const m0 = texMod.decodeMip0(parsed);
        // 只有解出真实像素时才用它；PNG/JPEG/视频载荷在 Node 里不解码，退回程序化素材
        if (m0.rgba) pixels = { width: m0.width, height: m0.height, rgba: m0.rgba };
        else pixels = { width: parsed.width, height: parsed.height, rgba: null };
      } catch {
        /* 贴图损坏：退回程序化素材 */
      }
    }
  }
  if (!pixels || !pixels.rgba) {
    const gen = ptex.buildBuiltinParticleTexture(sysDesc.texName || "particle/halo");
    // 保留真实尺寸带来的宽高比（若已知），但像素用程序化的
    pixels = { width: pixels?.width || gen.width, height: pixels?.height || gen.height, rgba: gen.rgba };
    if (pixels.width !== gen.width || pixels.height !== gen.height) {
      pixels = { width: gen.width, height: gen.height, rgba: gen.rgba };
    }
  }
  ps.setTexture({
    glTex: null,
    width: pixels.width,
    height: pixels.height,
    pixels,
    frames,
  });
  ps.setVisible(true);
  return ps;
}

// ---------- 校验一：全库模拟 ----------
// 跑 20 秒（长于多数 lifetime），确认生成/回收进入稳态且数值不发散。

function runSim() {
  let checked = 0;
  const errors = [];
  for (const scene of eachScene()) {
    for (const d of scene.systems) {
      let ps;
      try {
        ps = build(d);
      } catch (e) {
        errors.push(`${scene.id} ${d.path}: 构造抛错 ${e.message}`);
        continue;
      }
      let peak = 0;
      try {
        for (let i = 0; i < 1200; i++) {
          ps.advance(1 / 60);
          if (i % 60 === 0) {
            let l = 0;
            for (const p of ps.pool) if (p.alive) l++;
            if (l > peak) peak = l;
          }
        }
      } catch (e) {
        errors.push(`${scene.id} ${d.path}: advance 抛错 ${e.message}`);
        continue;
      }
      checked++;

      let live = 0;
      let nan = 0;
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const p of ps.pool) {
        if (!p.alive) continue;
        live++;
        const wx = ps.originX + p.x * ps.scaleX;
        const wy = ps.originY + p.y * ps.scaleY;
        if (![wx, wy, p.size, p.alpha, p.rot].every(Number.isFinite)) nan++;
        if (wx < minX) minX = wx;
        if (wx > maxX) maxX = wx;
        if (wy < minY) minY = wy;
        if (wy > maxY) maxY = wy;
      }
      // 有效发射率需含 rate 与 count 两个倍率（与 _step 的算法一致），
      // 否则会把「用户属性把数量关到最小」误判成缺陷（如 magic_pulse 的 explosionrate）。
      // audioDriven 发射器（audioprocessingmode）的发射量随音频响度门控，无音频输入时
      // 恒 0（与 WE 静音行为一致）——它的响度路径由 scripts/verify-audio.mjs 覆盖。
      const rateMul = ps._ov.rateMul !== undefined ? ps._ov.rateMul : 1;
      const countMul = ps._ov.countMul !== undefined ? ps._ov.countMul : 1;
      const rate = ps.emitters.reduce(
        (s, e) => s + (e.fill ? Infinity : e.rate * rateMul * countMul * (e.audioDriven ? 0 : 1)),
        0,
      );

      if (nan) errors.push(`${scene.id} ${d.path}: ${nan} 个粒子出现 NaN/Inf`);
      // 20 秒内理应至少生成 1 颗（rate*20 >= 1 才要求；低速流星不在此列）
      if (peak === 0 && rate * 20 >= 1)
        errors.push(`${scene.id} ${d.path}: 发射率 ${rate}/s 但 20s 内 0 颗粒子`);
      if (
        live > 0 &&
        (minX > scene.projW * 4 ||
          maxX < -scene.projW * 3 ||
          minY > scene.projH * 4 ||
          maxY < -scene.projH * 3)
      )
        errors.push(
          `${scene.id} ${d.path}: 全部粒子远离画面 bbox=[${minX | 0},${minY | 0},${maxX | 0},${maxY | 0}] proj=${scene.projW}x${scene.projH}`,
        );
    }
  }
  return { checked, errors };
}

// ---------- 校验二：CPU 参考光栅器 ----------
// 把每个场景的全部粒子合成到一张 1280×720 缓冲（基底中性灰，代表场景美术），
// 检查 additive 过曝、粒子是否堆成一团。

const BASE = [0.25, 0.25, 0.28];
const W = 1280;
const H = 720;

function runRaster(verbose) {
  const rows = [];
  const errors = [];
  for (const scene of eachScene()) {
    const cam = fitCover(scene.projW, scene.projH, W, H);
    const target = createTarget(W, H, BASE);
    let live = 0;
    let drawn = 0;
    let worstLayerOver = 0;
    let worstLayerName = "";
    for (const d of scene.systems) {
      let ps;
      try {
        ps = build(d);
      } catch {
        continue;
      }
      for (let i = 0; i < 300; i++) ps.advance(1 / 60, { level: 0.9 }); // 5 秒达稳态；音频驱动发射器按「音乐播放」响度参与光栅
      for (const p of ps.pool) if (p.alive) live++;
      drawn += rasterizeSystem(target, ps, cam).drawn || 0;
      // 单层独立测一次，用于区分"单层参数错"与"多层叠加变亮"
      const solo = createTarget(W, H, BASE);
      rasterizeSystem(solo, ps, cam);
      const sa = analyzeTarget(solo, BASE);
      if (sa.overExposedPct > worstLayerOver) {
        worstLayerOver = sa.overExposedPct;
        worstLayerName = d.name || d.path;
      }
    }
    const a = analyzeTarget(target, BASE);
    rows.push({ id: scene.id, sys: scene.systems.length, live, drawn, ...a, worstLayer: worstLayerOver });
    // 过曝判据分两层：
    //   1. 单个粒子系统过曝 >8% = 该系统本身参数/贴图有问题（真缺陷）；
    //   2. 全场景累加过曝 >35% = 即便逐层正常，叠起来也糊了。
    // 之所以不用单一的"全场景 >8%"：作者会故意把同一个雨/雾模型放好几份来加大密度
    // （1444077782 把 Rain downpour 放了 4 层），逐层 1.4~3.9% 是健康的，
    // 累加到 19% 属于"大雨"的正常观感，不该判为缺陷。
    if (worstLayerOver > 8)
      errors.push(`${scene.id}: 单层 additive 过曝 ${worstLayerOver.toFixed(1)}%（${worstLayerName}）`);
    if (a.overExposedPct > 35)
      errors.push(`${scene.id}: 全场景 additive 过曝 ${a.overExposedPct}%`);
    // 粒子只落在极少数网格且高度集中 = 堆成一团
    if (a.touchedPct > 1 && a.gridCellsTouched < 6 && a.worstCellSharePct > 70)
      errors.push(
        `${scene.id}: 粒子堆成一团（触及 ${a.gridCellsTouched}/64 格，最密一格占 ${a.worstCellSharePct}%）`,
      );
  }
  if (verbose) {
    console.log(
      "scene".padEnd(12) +
        "sys".padStart(4) +
        "live".padStart(7) +
        "drawn".padStart(7) +
        "avgLum".padStart(8) +
        "over%".padStart(7) +
        "touch%".padStart(8) +
        "cells".padStart(6) +
        "worst%".padStart(7),
    );
    for (const r of rows)
      console.log(
        r.id.padEnd(12) +
          String(r.sys).padStart(4) +
          String(r.live).padStart(7) +
          String(r.drawn).padStart(7) +
          String(r.avgLum).padStart(8) +
          String(r.overExposedPct).padStart(7) +
          String(r.touchedPct).padStart(8) +
          String(r.gridCellsTouched).padStart(6) +
          String(r.worstCellSharePct).padStart(7),
      );
    const baseL = (BASE[0] * 0.299 + BASE[1] * 0.587 + BASE[2] * 0.114).toFixed(4);
    console.log(`\n基底 avgLum=${baseL}（粒子只应在其上叠加，不应把画面冲到接近 1.0）`);
  }
  return { scenes: rows.length, errors };
}

// ---------- 校验三：贴图边缘与能量 ----------
// 边缘 alpha 不收敛 → 精灵露出方块边；平均 alpha 过高 → additive 叠加冲白。

function runTextures() {
  const errors = [];
  // 全库真实引用的贴图名 + 每类 fallback 关键词
  const names = new Set();
  for (const scene of eachScene()) for (const d of scene.systems) if (d.texName) names.add(d.texName);
  for (const kw of [
    "x/normalmap", "x/rosepetal", "x/leaf", "x/fog", "x/smoke", "x/beam", "x/bubble",
    "x/ring", "x/sparkle", "x/rain", "x/debris", "x/note", "x/trail", "x/unknown-name",
    "x/fire", "x/snow", "x/sickle", "x/flare", "x/glyph", "x/流星",
  ])
    names.add(kw);

  for (const n of names) {
    const t = ptex.buildBuiltinParticleTexture(n);
    if (!t) {
      errors.push(`${n}: 生成失败`);
      continue;
    }
    const { width: w, height: h, rgba } = t;
    const A = (x, y) => rgba[(y * w + x) * 4 + 3];
    let edge = 0;
    for (let x = 0; x < w; x++) edge = Math.max(edge, A(x, 0), A(x, h - 1));
    for (let y = 0; y < h; y++) edge = Math.max(edge, A(0, y), A(w - 1, y));
    let sum = 0;
    for (let i = 0; i < w * h; i++) sum += rgba[i * 4 + 3];
    const avgA = sum / (w * h) / 255;
    // 法线贴图是例外：alpha 不承载形状，不参与混合裁形
    const isNormal = /normal/.test(n);
    if (!isNormal && edge / 255 > 0.06)
      errors.push(`${n}: 边缘 alpha=${(edge / 255).toFixed(3)} 未收敛 → 会露出方块边`);
    if (!isNormal && avgA > 0.35)
      errors.push(`${n}: 平均 alpha=${avgA.toFixed(3)} 过高 → additive 叠加易冲白`);
    // 全零贴图（生成器静默产出空内容）比缺失更隐蔽：粒子在但永远看不见
    if (!isNormal && avgA === 0)
      errors.push(`${n}: 贴图全空（avg alpha=0）→ 粒子不可见`);
  }

  // ---- 内置贴图全程序化（2026-09-02 移除 CC0 素材层后的守卫） ----
  // 1) 素材文件与残留引用不得回归：重新引入内嵌像素数据等于绕开合规边界
  //    （docs/COMPLIANCE.md「零内嵌第三方素材」）。
  const assetFile = join(ROOT, "renderer/vendor/we-scene/render/particle-assets.js");
  if (fs.existsSync(assetFile)) errors.push("particle-assets.js 不应存在（CC0 素材层已移除）");
  for (const f of ["renderer/vendor/we-scene/render/particle-textures.js", "renderer/src/scene-mount.ts"]) {
    const src = fs.readFileSync(join(ROOT, f), "utf8");
    if (/particle-assets/.test(src)) errors.push(`${f} 仍引用 particle-assets`);
  }

  // 2) 登记表全部键逐一程序生成，除既有边缘/能量不变量外还要求非空
  //    （此前 fogNoise 首版曾整张输出 0 —— max 断言就是为它加的）。
  //    生成器必须纯算术：canvas 路径会让 Node 校验与浏览器像素分叉。
  {
    const src = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/particle-textures.js"), "utf8");
    if (/document\.createElement|getContext\(\s*['"]2d['"]\s*\)/.test(src))
      errors.push("particle-textures.js 不得走 canvas（Node 与浏览器必须逐像素一致）");
  }
  const listed = typeof ptex.listBuiltinParticleTextureNames === "function"
    ? ptex.listBuiltinParticleTextureNames()
    : [];
  if (!listed.length) errors.push("listBuiltinParticleTextureNames 未导出或为空");
  const checksum = (t) => {
    let s = 0;
    for (let i = 0; i < t.width * t.height; i++) s = (s * 31 + t.rgba[i * 4 + 3]) | 0;
    return `${t.width}x${t.height}:${s}`;
  };
  const ck = (n) => checksum(ptex.buildBuiltinParticleTexture(n));
  for (const n of listed) {
    const t = ptex.buildBuiltinParticleTexture(n);
    if (!t || !t.width || !t.height) {
      errors.push(`${n}: 程序化生成失败`);
      continue;
    }
    let maxA = 0;
    for (let i = 0; i < t.width * t.height; i++) maxA = Math.max(maxA, t.rgba[i * 4 + 3]);
    if (maxA === 0 && !/normal/.test(n)) errors.push(`${n}: 程序化贴图为全空`);
  }
  // 本机库引用过、曾落到通用光晕的名字，现在必须是独立形状
  const haloCk = ck("particle/halo");
  for (const n of ["particle/fire/fire1", "particle/sickle", "particle/nature/snow", "particle/light/flare_2", "particle/magic/glyph_4"]) {
    if (ck(n) === haloCk) errors.push(`${n}: 形状仍等于 halo（关键词/登记表未生效）`);
  }
  if (ck("particle/流星") === ck("@star") || ck("particle/流星") === haloCk)
    errors.push("particle/流星: 被当成星/光晕，应为彗尾");
  const distinct = (label, keys) => {
    const seen = new Map();
    for (const n of keys) {
      const c = ck(n);
      const hit = [...seen.entries()].find(([, v]) => v === c);
      if (hit) errors.push(`${label}: ${n} 与 ${hit[0]} 像素相同`);
      else seen.set(n, c);
    }
  };
  distinct("气泡变体", ["particle/bubbles/bubble1", "particle/bubbles/bubble2", "particle/bubbles/bubble3"]);
  // 3441873795：bubbles 预设 sequencemultiplier=2，贴图必须是 2×2 图集。
  // 整圆画满一张图时每帧只采到一角 → 四分之一气泡。四格各自都要有实质 alpha。
  {
    const t = ptex.buildBuiltinParticleTexture("particle/bubbles/bubble1");
    if (!t || t.width < 4 || t.height < 4) {
      errors.push("bubble1 图集生成失败");
    } else {
      const n = 2;
      const cw = t.width / n;
      const ch = t.height / n;
      const cellSum = [];
      for (let row = 0; row < n; row++) {
        for (let col = 0; col < n; col++) {
          let sum = 0;
          for (let y = 0; y < ch; y += 2) {
            for (let x = 0; x < cw; x += 2) {
              sum += t.rgba[((row * ch + y) * t.width + (col * cw + x)) * 4 + 3];
            }
          }
          cellSum.push(sum);
        }
      }
      const minC = Math.min(...cellSum);
      const maxC = Math.max(...cellSum);
      if (minC < 500) {
        errors.push(`bubble1 2×2 图集有空格（sums=${cellSum.join(",")}），会裁成四分之一气泡`);
      }
      if (maxC > 0 && minC / maxC < 0.25) {
        errors.push(`bubble1 四格能量差过大（${minC}/${maxC}），疑似整圆未分格`);
      }
    }
    if (!/bubbleSheet|2×2|sequencemultiplier\s*=\s*2/.test(
      fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/particle-textures.js"), "utf8"),
    )) {
      errors.push("particle-textures.js 必须用 bubbleSheet 覆盖 sequencemultiplier=2 的气泡图集");
    }
  }
  distinct("闪电变体", ["particle/lightning/lightning1", "particle/lightning/lightning2", "particle/lightning/lightning3"]);
  distinct("叶片变体", ["particle/nature/leaves", "particle/nature/leaves1", "particle/nature/leaves3", "particle/nature/leaves7"]);
  distinct("叶片补全", ["particle/nature/leaves2", "particle/nature/leaves5", "particle/nature/leaves6", "particle/nature/leaves8"]);
  for (const n of [
    "particle/sharp_halo",
    "particle/star",
    "particle/shape/circle_wind",
    "particle/fire/fire2",
    "particle/beam/beam_0",
    "particle/light/flare_0",
    "particle/light/light_shafts_5",
  ]) {
    if (ck(n) === haloCk) errors.push(`${n}: 形状仍等于 halo（登记表未补全）`);
  }

  // 官方 Refract 法线不得再是平坦 (0.5,0.5,1)
  const normalSlope = (t) => {
    const { width: w, height: h, rgba } = t;
    let minR = 255, maxR = 0, minG = 255, maxG = 0;
    const sx = Math.max(1, (w / 32) | 0);
    const sy = Math.max(1, (h / 16) | 0);
    for (let y = 0; y < h; y += sy) {
      for (let x = 0; x < w; x += sx) {
        const o = (y * w + x) * 4;
        if (rgba[o] < minR) minR = rgba[o];
        if (rgba[o] > maxR) maxR = rgba[o];
        if (rgba[o + 1] < minG) minG = rgba[o + 1];
        if (rgba[o + 1] > maxG) maxG = rgba[o + 1];
      }
    }
    return maxR - minR > 20 || maxG - minG > 20;
  };
  const officialNormals = [
    "particle/drop_normal",
    "particle/normal_splash",
    "particle/normal_ring_smooth",
    "particle/normal_pinch_rotate",
    "particle/water/rain_drops_sheet_normal",
    "particle/bubbles/bubble1normal",
    "particle/sharp_halo_normal",
  ];
  for (const n of officialNormals) {
    const t = ptex.buildBuiltinParticleTexture(n);
    if (!t || !normalSlope(t)) errors.push(`${n}: 法线仍是平坦中性图（官方 Refract 无扰动）`);
  }
  if (typeof ptex.particleNormalNameForAlbedo !== "function" || ptex.particleNormalNameForAlbedo("particle/drop") !== "particle/drop_normal") {
    errors.push("particleNormalNameForAlbedo 未按官方槽位推断 drop_normal");
  }
  if (typeof ptex.prepareParticleNormalTexture === "function") {
    const alb = ptex.buildBuiltinParticleTexture("particle/drop");
    const bumped = ptex.prepareParticleNormalTexture(alb);
    if (!bumped || !normalSlope(bumped)) errors.push("prepareParticleNormalTexture 未把反照率 alpha 转成法线");
  } else {
    errors.push("prepareParticleNormalTexture 未导出（槽 1 填反照率时无法转 bump）");
  }

  // 3) 宿主覆盖接口往返：按名覆盖 → build 返回宿主内容（像素校验和对比，
  //    不能比对象引用——reset 后重建的内容相同但引用不同）；兜底 provider 接管
  //    未知名；reset 后恢复内置生成。改动求值顺序（覆盖 → provider → 登记 → 兜底）
  //    时这里必须仍然全绿。
  m_reset: {
    ptex.resetParticleTextureFactories();
    const def = ptex.buildBuiltinParticleTexture("particle/halo");
    ptex.setParticleTextureFactory("particle/halo", () => ({ width: 4, height: 4, rgba: new Uint8Array(64).fill(200) }));
    const ov = ptex.buildBuiltinParticleTexture("particle/halo");
    if (checksum(ov) !== "4x4:" + (() => { let s = 0; for (let i = 0; i < 16; i++) s = (s * 31 + 200) | 0; return s; })())
      errors.push("覆盖接口：setParticleTextureFactory 未生效（build 未返回宿主内容）");
    ptex.resetParticleTextureFactories();
    const rst = ptex.buildBuiltinParticleTexture("particle/halo");
    if (checksum(rst) !== checksum(def))
      errors.push("覆盖接口：reset 后未恢复内置生成");
    ptex.setParticleTextureProvider((n) => (n === "particle/probe-unknown" ? { width: 2, height: 2, rgba: new Uint8Array(16).fill(50) } : null));
    const pv = ptex.buildBuiltinParticleTexture("particle/probe-unknown");
    if (!pv || pv.width !== 2)
      errors.push("覆盖接口：setParticleTextureProvider 未接管未知名");
    ptex.resetParticleTextureFactories();
  }

  return { checked: names.size, errors };
}

// ---------- 嵌套子发射器 origin：Matrix 列距不能等父粒子出现才加上 ----------
//
// 3396722575 的「代码」层下 4 个 spawner，每个 33 列 matrix_code，列距写在
// children[].origin（0 / 50 / 100 … 1600），trail 是 eventfollow。
// 若 followMode 把子 origin 留在父 origin、等 _syncFollow 再加 offset，
// 父列 maxcount=1 尚未生成时 trail 全停在 spawner 原点 —— 列间距消失。
function runNestedOrigins() {
  const errors = [];
  const item = "3396722575";
  const dir = join(LIB, item);
  const pkgPath = join(dir, "scene.pkg");
  if (!fs.existsSync(pkgPath)) {
    console.log("  （跳过 3396722575 语料：本机无此壁纸）");
    return { checked: 0, errors };
  }
  const pkg = parsePkg(fs.readFileSync(pkgPath));
  const scene = JSON.parse(readText(getEntry(pkg, "scene.json")).replace(/^\uFEFF/, ""));
  const spawners = (scene.objects || []).filter((o) => typeof o.particle === "string" && /Matrix/i.test(o.name || ""));
  if (spawners.length < 1) {
    errors.push("3396722575 未找到 Matrix spawner 层");
    return { checked: 0, errors };
  }
  const parentPath = spawners[0].particle;
  const parentModel = JSON.parse(readText(getEntry(pkg, parentPath)));
  const children = parentModel.children || [];
  if (children.length < 20) {
    errors.push(`3396722575 Matrix 子列数异常: ${children.length}（预期 33）`);
    return { checked: children.length, errors };
  }
  const origins = children.map((ch) => {
    const p = String(ch.origin ?? "0 0 0").trim().split(/\s+/).map(Number);
    return p[0] || 0;
  });
  const uniq = [...new Set(origins.map((x) => Math.round(x)))].sort((a, b) => a - b);
  if (uniq.length < 20) {
    errors.push(`3396722575 子列 origin.x 去重后只有 ${uniq.length} 个（列距数据本身坏了）`);
  }
  const diffs = [];
  for (let i = 1; i < uniq.length; i++) diffs.push(uniq[i] - uniq[i - 1]);
  const step50 = diffs.filter((d) => d === 50).length;
  if (step50 < 20) {
    errors.push(`3396722575 列距 50px 的相邻对只有 ${step50}（预期 ≥20）`);
  }

  // 装配语义：子系统构造 origin 必须带上 children.origin，attachFollow 之后、
  // 父粒子尚未生成时，trail 仍停在列位置而不是 spawner 原点。
  // children.origin 是父系统局部坐标，世界位置 = parent.localToWorld(offset)
  // （含图层 scale）。2974757317 层 scale=1.5 时 60px 列距必须变成 90px。
  const layer = {
    origin: parseVec(spawners[0].origin),
    scale: parseVec(spawners[0].scale, [1, 1, 1]),
    angles: parseVec(spawners[0].angles),
  };
  const parentPs = new ParticleSystem(null, parentModel, spawners[0].instanceoverride, layer);
  const colOrigins = [];
  const trailOrigins = [];
  for (const ch of children) {
    const cOrigin = String(ch.origin ?? "0 0 0").trim().split(/\s+/).map(Number);
    const wOrigin = parentPs.localToWorld(cOrigin[0] || 0, cOrigin[1] || 0);
    const childLayer = {
      ...layer,
      origin: [wOrigin[0], wOrigin[1], (layer.origin[2] || 0) + (cOrigin[2] || 0)],
    };
    const colModel = JSON.parse(readText(getEntry(pkg, ch.name)));
    const colPs = new ParticleSystem(null, colModel, ch.instanceoverride || spawners[0].instanceoverride, childLayer);
    const followMode = !ch.type || ch.type === "static" ? "origin" : ch.type === "eventfollow" ? "particle" : null;
    if (followMode) colPs.attachFollow(parentPs, followMode, [cOrigin[0] || 0, cOrigin[1] || 0, cOrigin[2] || 0]);
    colOrigins.push(Math.round(colPs.originX));
    const trailCh = (colModel.children || []).find((c) => c && c.type === "eventfollow");
    if (trailCh) {
      const tOrigin = String(trailCh.origin ?? "0 0 0").trim().split(/\s+/).map(Number);
      const tw = colPs.localToWorld(tOrigin[0] || 0, tOrigin[1] || 0);
      const trailLayer = {
        ...childLayer,
        origin: [tw[0], tw[1], childLayer.origin[2] + (tOrigin[2] || 0)],
      };
      const trailModel = JSON.parse(readText(getEntry(pkg, trailCh.name)));
      const trailPs = new ParticleSystem(null, trailModel, trailCh.instanceoverride || spawners[0].instanceoverride, trailLayer);
      trailPs.attachFollow(colPs, "particle", [tOrigin[0] || 0, tOrigin[1] || 0, tOrigin[2] || 0]);
      // 父列还没有粒子：eventfollow 不得把 trail 拽回 spawner 原点
      trailOrigins.push(Math.round(trailPs.originX));
    }
  }
  const colUniq = new Set(colOrigins);
  if (colUniq.size < 20) {
    errors.push(`装配后 Matrix 列 origin.x 去重 ${colUniq.size}（预期 ≥20，列被叠在一起）`);
  }
  const trailUniq = new Set(trailOrigins);
  if (trailOrigins.length && trailUniq.size < 20) {
    errors.push(
      `父粒子未生成时 trail origin.x 去重 ${trailUniq.size}（预期 ≥20：eventfollow 无 host 时仍须停在列位置）`,
    );
  }
  // 列距是局部 50px × 图层 scale（3396722575 scale≈0.93 → 世界约 46.5）
  const worldStep = 50 * Math.abs(layer.scale[0] || 1);
  const sorted = [...colUniq].sort((a, b) => a - b);
  let spaced = 0;
  for (let i = 1; i < sorted.length; i++) {
    if (Math.abs(sorted[i] - sorted[i - 1] - worldStep) <= 1) spaced++;
  }
  if (spaced < 20) {
    errors.push(`装配后相邻列距 ${worldStep.toFixed(1)}px 的只有 ${spaced} 对`);
  }

  // 源码护栏：followMode 不得把 child origin 清回父 origin
  const mountSrc = fs.readFileSync(join(ROOT, "renderer/src/scene-mount.ts"), "utf8");
  if (/origin:\s*followMode\s*\?/.test(mountSrc)) {
    errors.push("scene-mount.ts 又把 followMode 子级 origin 留在父 origin（Matrix 列会再叠回去）");
  }
  const psrc = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/particles.js"), "utf8");
  if (!/this\._syncFollow\(\)/.test(psrc) || !/attachFollow[\s\S]*_syncFollow/.test(psrc)) {
    errors.push("particles.js attachFollow 应立即 _syncFollow，否则首帧列距为 0");
  }
  if (!/localToWorld\(off\[0\], off\[1\]\)/.test(psrc) || /originX = parent\.originX \+ off/.test(psrc)) {
    errors.push("children.origin 必须走 parent.localToWorld（乘图层 scale），不能直接加到世界 origin");
  }
  if (!/localToWorld\(cOrigin\[0\]/.test(mountSrc)) {
    errors.push("scene-mount 子级初始 origin 必须用 parent.localToWorld，否则 eventfollow 无 host 时列距不乘 scale");
  }

  // 2974757317：单层 43 列 × 60px × scale 1.5 必须铺满 3840 宽，不能只铺 2520
  const cover = runMatrixLayerCover();
  errors.push(...cover.errors);

  return { checked: children.length, errors };
}

function runMatrixLayerCover() {
  const errors = [];
  const id = "2974757317";
  const pkgPath = join(LIB, id, "scene.pkg");
  if (!fs.existsSync(pkgPath)) return { errors };
  let pkg;
  try { pkg = parsePkg(fs.readFileSync(pkgPath)); } catch { return { errors }; }
  const scene = JSON.parse(readText(getEntry(pkg, "scene.json")).replace(/^\uFEFF/, ""));
  const layerObj = (scene.objects || []).find((o) => o.name === "黑客");
  if (!layerObj) {
    errors.push("2974757317 未找到「黑客」粒子层");
    return { errors };
  }
  const layer = {
    origin: parseVec(layerObj.origin),
    scale: parseVec(layerObj.scale, [1, 1, 1]),
    angles: parseVec(layerObj.angles),
  };
  if (Math.abs((layer.scale[0] || 1) - 1.5) > 0.05) {
    errors.push(`2974757317 黑客层 scale 应为 1.5，实际 ${layer.scale}`);
  }
  const parentModel = JSON.parse(readText(getEntry(pkg, layerObj.particle)));
  const parentPs = new ParticleSystem(null, parentModel, layerObj.instanceoverride, layer);
  const xs = [];
  for (const ch of parentModel.children || []) {
    const cOrigin = String(ch.origin ?? "0 0 0").trim().split(/\s+/).map(Number);
    const colPs = new ParticleSystem(null, { maxcount: 1, renderer: [] }, null, {
      origin: [0, 0, 0],
      scale: layer.scale,
      angles: layer.angles,
    });
    colPs.attachFollow(parentPs, "origin", [cOrigin[0] || 0, cOrigin[1] || 0, cOrigin[2] || 0]);
    xs.push(colPs.originX);
  }
  if (xs.length < 40) {
    errors.push(`2974757317 子列数 ${xs.length}（预期 43）`);
    return { errors };
  }
  const span = Math.max(...xs) - Math.min(...xs);
  // 2520 局部 × 1.5 = 3780。未乘 scale 时只有 2520，铺不满 3840。
  if (span < 3600) {
    errors.push(`2974757317 列跨度 ${span.toFixed(0)}px（乘 scale 后应 ≥3600，铺满 3840 宽）`);
  }
  return { errors };
}

// ---------- Matrix 字符图集 UV：分母必须等于实际上传尺寸 ----------
// 2974757317 掉落代码糊成一条白带：mip0 512×512（POT 填充），TEXI 声明 450×400，
// 71 帧 50×50 写在 mip0 空间。decodeMip0 若裁成 450 而 UV 仍 /512，会采到邻帧碎字。
function runMatrixSheetUv() {
  const errors = [];
  const codecSrc = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/pkg/tex-codecs.js"), "utf8");
  if (!/frames\?\.list\?\.length/.test(codecSrc)) {
    errors.push("decodeMip0 有 TEXS 时必须跳过 POT 裁剪（否则 matrix 图集 UV 错位）");
  }
  const psrc = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/particles.js"), "utf8");
  if (!/tex && tex\.width/.test(psrc) || /denW = \(list && \(\(raw && raw\.atlasWidth\)/.test(psrc)) {
    errors.push("setTexture UV 分母必须优先用实际上传的 tex.width（不能只用 atlasWidth）");
  }
  const mountSrc = fs.readFileSync(join(ROOT, "renderer/src/scene-mount.ts"), "utf8");
  if (!/atlasWidth = entry\.width/.test(mountSrc)) {
    errors.push("scene-mount 帧表 atlasWidth 必须挂实际上传尺寸 entry.width");
  }

  const ids = ["2974757317", "3396722575", "1444077782"];
  let checked = 0;
  for (const id of ids) {
    const pkgPath = join(LIB, id, "scene.pkg");
    if (!fs.existsSync(pkgPath)) continue;
    let pkg;
    try { pkg = parsePkg(fs.readFileSync(pkgPath)); } catch { continue; }
    const texEntries = pkg.entries.filter((e) => e.name.endsWith(".tex"));
    for (const e of texEntries) {
      let parsed;
      try { parsed = texMod.parseTex(getEntry(pkg, e.name)); } catch { continue; }
      if (!parsed.frames?.list?.length) continue;
      checked++;
      const mip0 = parsed.images?.[0]?.[0];
      const m0 = texMod.decodeMip0(parsed);
      if (mip0 && m0.width !== mip0.width) {
        errors.push(
          `${id} ${e.name}: 有 TEXS 时 decodeMip0 应保持 mip0 ${mip0.width}x${mip0.height}，实际 ${m0.width}x${m0.height}`,
        );
      }
      const list = parsed.frames.list;
      const ps = new ParticleSystem(null, { maxcount: 1, sequencemultiplier: 2 }, null, {
        origin: [0, 0, 0],
        scale: [1, 1, 1],
        angles: [0, 0, 0],
      });
      ps.setTexture({ glTex: null, width: m0.width, height: m0.height, frames: list });
      if (!ps.texFrames || ps.texFrames.length !== list.length) {
        errors.push(`${id} ${e.name}: setTexture 未吃下 ${list.length} 帧（退回了 sequencemultiplier 方格）`);
        continue;
      }
      const f0 = list[0];
      const uv0 = ps.texFrames[0];
      if (Math.abs(uv0.ou * m0.width - f0.x) > 1 || Math.abs(uv0.ov * m0.height - f0.y) > 1) {
        errors.push(
          `${id} ${e.name}: 帧0 UV 映射 ${uv0.ou * m0.width},${uv0.ov * m0.height} ≠ 像素 ${f0.x},${f0.y}（分母=${m0.width}x${m0.height}）`,
        );
      }
      const fLast = list[list.length - 1];
      const uvL = ps.texFrames[ps.texFrames.length - 1];
      if (Math.abs(uvL.ov * m0.height - fLast.y) > 1) {
        errors.push(
          `${id} ${e.name}: 末帧 y 映射 ${uvL.ov * m0.height} ≠ ${fLast.y}`,
        );
      }
      if (/matrix spritesheet 72/.test(e.name)) {
        if (m0.width !== 512 || m0.height !== 512) {
          errors.push(`${id} matrix 72 上传尺寸应为 512x512（POT mip0），实际 ${m0.width}x${m0.height}`);
        }
        if (Math.abs(fLast.y - 350) > 1) {
          errors.push(`${id} matrix 72 末帧 y 应为 350，实际 ${fLast.y}`);
        }
      }
    }
  }
  return { checked, errors };
}

// ---------- REFRACT 空白白图（2464842912 Raindrops Splatter Small）----------
// 槽 0 是整张不透明白 PNG，形状在法线槽。按普通精灵画 = 满屏白方块。

function u32be(buf, o) {
  return (buf[o] << 24) | (buf[o + 1] << 16) | (buf[o + 2] << 8) | buf[o + 3];
}

function decodePngRgba8(png) {
  const buf = Buffer.isBuffer(png) ? png : Buffer.from(png);
  let p = 8;
  let w = 0;
  let h = 0;
  let ctype = -1;
  const idats = [];
  while (p + 12 <= buf.length) {
    const len = u32be(buf, p) >>> 0;
    const type = buf.toString("ascii", p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") {
      w = u32be(data, 0) >>> 0;
      h = u32be(data, 4) >>> 0;
      ctype = data[9];
    }
    if (type === "IDAT") idats.push(data);
    if (type === "IEND") break;
    p += 12 + len;
  }
  if (ctype !== 6) return null;
  const raw = zlib.inflateSync(Buffer.concat(idats));
  const bpp = 4;
  const stride = w * bpp;
  const rgba = new Uint8Array(w * h * 4);
  const rows = [];
  let src = 0;
  const paeth = (a, b, c) => {
    const v = a + b - c;
    const pa = Math.abs(v - a);
    const pb = Math.abs(v - b);
    const pc = Math.abs(v - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < h; y++) {
    const f = raw[src++];
    const row = Buffer.alloc(stride);
    raw.copy(row, 0, src, src + stride);
    src += stride;
    const up = rows[y - 1] || Buffer.alloc(stride);
    if (f === 1) {
      for (let i = bpp; i < stride; i++) row[i] = (row[i] + row[i - bpp]) & 255;
    } else if (f === 2) {
      for (let i = 0; i < stride; i++) row[i] = (row[i] + up[i]) & 255;
    } else if (f === 3) {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? row[i - bpp] : 0;
        row[i] = (row[i] + ((a + up[i]) >> 1)) & 255;
      }
    } else if (f === 4) {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? row[i - bpp] : 0;
        const c = i >= bpp ? up[i - bpp] : 0;
        row[i] = (row[i] + paeth(a, up[i], c)) & 255;
      }
    }
    rows.push(row);
    rgba.set(row, y * stride);
  }
  return { width: w, height: h, rgba };
}

function runRefractBlank() {
  const errors = [];
  const white = new Uint8Array(8 * 8 * 4).fill(255);
  if (!rgbaIsBlankWhite(white)) errors.push("rgbaIsBlankWhite 未认出纯白不透明图");
  const ghost = white.slice();
  ghost[3] = 0;
  if (rgbaIsBlankWhite(ghost)) errors.push("rgbaIsBlankWhite 把带透明的图当成空白白图");

  const shader = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/particle-shaders.js"), "utf8");
  if (!/u_scene/.test(shader) || !/ntex\.ag/.test(shader) || !/ntex\.rg/.test(shader) || !/smoothstep/.test(shader)) {
    errors.push("粒子 shader 未实现 REFRACT（空白白图会画成满屏白方块；需同时认 DXT5nm AG 与官方 RG）");
  }
  const pj = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/particles.js"), "utf8");
  if (!/copyTexImage2D/.test(pj) || !/RGB8/.test(pj)) {
    errors.push("粒子 REFRACT 未用 RGB8 copyTexImage2D 抓画面");
  }
  if (!/TEXTURE2/.test(pj)) {
    errors.push("粒子 REFRACT 的 scene 拷贝未绑到 TEXTURE2（会盖掉法线槽）");
  }
  if (!/ui_editor_properties_refract_amount/.test(pj)) {
    errors.push("未读取官方 Refract Amount（ui_editor_properties_refract_amount）");
  }
  const mountSrc = fs.readFileSync(join(ROOT, "renderer/src/scene-mount.ts"), "utf8");
  if (!/setNormalTexture/.test(mountSrc) || !/particleNormalNameForAlbedo/.test(mountSrc)) {
    errors.push("scene-mount 未加载粒子法线槽（REFRACT 缺法线仍会画白方块）");
  }

  const pkgPath = join(LIB, "2464842912", "scene.pkg");
  if (fs.existsSync(pkgPath)) {
    const pkg = parsePkg(fs.readFileSync(pkgPath));
    const matBuf = getEntry(pkg, "materials/workshop/2446129945/particle/halo_50_1.json");
    const mat = JSON.parse(readText(matBuf));
    if (!particlePassRefract(mat)) errors.push("2464842912 Rain2 材质未识别为 REFRACT");
    const raw = getEntry(pkg, "materials/workshop/2446129945/particle/particles 256x1280 blank.tex");
    const parsed = texMod.parseTex(raw);
    const m0 = texMod.decodeMip0(parsed);
    if (!m0.png) errors.push("2464842912 blank.tex 不是 PNG 占位");
    else {
      const dec = decodePngRgba8(m0.png);
      if (!dec || !rgbaIsBlankWhite(dec.rgba)) {
        errors.push("2464842912 blank.tex 不是整张不透明白（Raindrops Splatter Small 的 REFRACT 占位）");
      }
    }
    const nraw = getEntry(pkg, "materials/workshop/2446129945/particle/particles 256x1280N.tex");
    if (!nraw) errors.push("2464842912 缺少法线槽 particles 256x1280N.tex");
    else {
      const n0 = texMod.decodeMip0(texMod.parseTex(nraw));
      const nr = n0.rgba;
      if (!nr || nr.length < 16) errors.push("2464842912 法线槽无法解码为 RGBA");
      else {
        // DXT5nm 布局：R=255 B=0，形状在 G/A。shader 必须采 ntex.ag，采 .xy 会满屏方块。
        const nw = n0.width || 1280;
        const nh = n0.height || (nr.length / 4 / nw);
        let minG = 255, maxG = 0, minA = 255, maxA = 0, r255 = 0, b0 = 0, seen = 0;
        const stepX = Math.max(1, (nw / 32) | 0);
        const stepY = Math.max(1, (nh / 16) | 0);
        for (let y = 0; y < nh; y += stepY) {
          for (let x = 0; x < nw; x += stepX) {
            const o = (y * nw + x) * 4;
            if (nr[o] === 255) r255++;
            if (nr[o + 2] === 0) b0++;
            if (nr[o + 1] < minG) minG = nr[o + 1];
            if (nr[o + 1] > maxG) maxG = nr[o + 1];
            if (nr[o + 3] < minA) minA = nr[o + 3];
            if (nr[o + 3] > maxA) maxA = nr[o + 3];
            seen++;
          }
        }
        if (r255 < seen * 0.9 || b0 < seen * 0.9 || maxG - minG < 40 || maxA - minA < 40) {
          errors.push("2464842912 法线不是 DXT5nm（R=255/B=0、形状在 G/A）");
        }
      }
    }
    // 光栅：空白白图 + refract 不得留下方块硬边
    const ps = new ParticleSystem(
      null,
      {
        maxcount: 16,
        emitter: [{ name: "boxrandom", rate: 400, distancemax: "80 80 0" }],
        renderer: [{ name: "sprite" }],
        initializer: [{ name: "sizerandom", min: 24, max: 24 }],
      },
      null,
      { origin: [640, 360, 0], scale: [1, 1, 1], angles: [0, 0, 0] },
    );
    ps.refract = true;
    ps.setTexture({
      glTex: null,
      width: 16,
      height: 16,
      pixels: { width: 16, height: 16, rgba: new Uint8Array(16 * 16 * 4).fill(255) },
    });
    for (let i = 0; i < 30; i++) ps.advance(1 / 60);
    if (ps.liveCount() < 1) errors.push("REFRACT 光栅样本没有存活粒子");
    const cam = fitCover(1280, 720, W, H);
    const target = createTarget(W, H, BASE);
    rasterizeSystem(target, ps, cam);
    const a = analyzeTarget(target, BASE);
    if (a.hardEdgePixels > 20 || a.touchedPct > 2) {
      errors.push(
        `REFRACT 空白白图仍被光栅成方块（hardEdge=${a.hardEdgePixels} touch=${a.touchedPct}%）`,
      );
    }
  }
  return { errors };
}

// ---------- Sprite Trail：一条精灵，不是 maxlength 份广告牌 ----------
// 2468489223 Painting the Sharks 的小鱼是 spritetrail（length=0.02, maxlength=5）。
// 旧实现把 maxlength 当历史段数，500 条鱼 × 5 段 = 2500 个正对屏幕的整鱼精灵。

function runSpriteTrail() {
  const errors = [];
  const src = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/particles.js"), "utf8");
  if (/if \(this\.trailCfg\) \{/.test(src) && /this\.trailCfg\.maxLength \|\| 6/.test(src)) {
    errors.push("spritetrail 仍与 ropetrail 共用 maxlength 当历史段数（会把一条鱼画成多份广告牌）");
  }
  if (/const trail = this\.trailCfg\s*\n\s*const segs = trail \? this\.trailSegments/.test(src)) {
    errors.push("render() 仍对所有 trailCfg（含 spritetrail）做 live × segs");
  }
  if (!/particleInstanceSegs\(this\.trailCfg/.test(src)) {
    errors.push("render() 未走 particleInstanceSegs（spritetrail 必须 1 份/粒子）");
  }
  if (!/spriteTrailLengthFactor/.test(src) || !/spriteTrailRotation/.test(src)) {
    errors.push("spritetrail 未按速度拉伸/转向");
  }

  const f4 = spriteTrailLengthFactor(200, 0.02, 0, 5);
  if (Math.abs(f4 - 4) > 1e-9) errors.push(`v=200,length=0.02,max=5 应得 4，实际 ${f4}`);
  const f1 = spriteTrailLengthFactor(999, 1, 1, 1);
  if (Math.abs(f1 - 1) > 1e-9) errors.push(`Length=Min=Max=1 应得 1（只转向），实际 ${f1}`);
  const f0 = spriteTrailLengthFactor(0, 0.02, 0, 5);
  if (f0 !== 0) errors.push(`速度 0 且无 min 应得 0，实际 ${f0}`);
  const rain = spriteTrailLengthFactor(400, 0.005, 0, 100);
  if (Math.abs(rain - 2) > 1e-9) errors.push(`rainperspective v=400,length=0.005 应得 2，实际 ${rain}`);
  if (Math.abs(spriteTrailRotation(1, 0) + Math.PI / 2) > 1e-9) {
    errors.push("spriteTrailRotation(+X) 应对齐贴图朝上到 +X");
  }

  if (particleInstanceSegs({ kind: "spritetrail" }, 5) !== 1) {
    errors.push("particleInstanceSegs(spritetrail, 5) 必须是 1");
  }
  if (particleInstanceSegs({ kind: "ropetrail" }, 6) !== 6) {
    errors.push("particleInstanceSegs(ropetrail) 仍应按段数实例化");
  }
  const cap = spriteTrailLengthFactor(400, 0.02, 0, 5);
  if (Math.abs(cap - 5) > 1e-9) errors.push(`v=400 应夹到 maxlength=5，实际 ${cap}`);

  const omitLen = new ParticleSystem(
    null,
    { maxcount: 1, renderer: [{ name: "spritetrail", maxlength: 6 }] },
    null,
    { origin: [0, 0, 0], scale: [1, 1, 1], angles: [0, 0, 0] },
  );
  if (Math.abs(omitLen.trailCfg.length - 0.1) > 1e-9) {
    errors.push(`spritetrail 省略 length 应得 0.1，实际 ${omitLen.trailCfg?.length}`);
  }

  const bareFade = new ParticleSystem(
    null,
    { maxcount: 1, renderer: [{ name: "sprite" }], operator: [{ name: "alphafade" }] },
    null,
    { origin: [0, 0, 0], scale: [1, 1, 1], angles: [0, 0, 0] },
  );
  if (Math.abs(bareFade.ops.alphaFade.fadeIn - 0.1) > 1e-9 || Math.abs(bareFade.ops.alphaFade.fadeOut - 0.9) > 1e-9) {
    errors.push(
      `alphafade 省略字段应得 0.1/0.9，实际 ${bareFade.ops.alphaFade.fadeIn}/${bareFade.ops.alphaFade.fadeOut}`,
    );
  }
  const explicitFade = new ParticleSystem(
    null,
    { maxcount: 1, renderer: [{ name: "sprite" }], operator: [{ name: "alphafade", fadeintime: 0, fadeouttime: 1 }] },
    null,
    { origin: [0, 0, 0], scale: [1, 1, 1], angles: [0, 0, 0] },
  );
  if (explicitFade.ops.alphaFade.fadeIn !== 0 || explicitFade.ops.alphaFade.fadeOut !== 1) {
    errors.push(
      `alphafade 显式 0/1 应保留，实际 ${explicitFade.ops.alphaFade.fadeIn}/${explicitFade.ops.alphaFade.fadeOut}`,
    );
  }
  if (!/fadeintime, 0\.1/.test(src) || !/fadeouttime, 0\.9/.test(src)) {
    errors.push("alphafade 省略字段未用编辑器默认 0.1/0.9（0/1 会让 2468489223 小鱼全程不透明）");
  }

  let sawSpriteTrail = 0;
  let sawRain = 0;
  let sawSharks = false;
  for (const scene of eachScene()) {
    for (const d of scene.systems) {
      let ps;
      try {
        ps = build(d);
      } catch {
        continue;
      }
      const tr = ps.trailCfg;
      if (!tr || tr.kind !== "spritetrail") continue;
      sawSpriteTrail++;
      if (ps.trailSegments !== 1) {
        errors.push(`${scene.id} ${d.path}: spritetrail.trailSegments=${ps.trailSegments}（必须是 1）`);
      }
      if (particleInstanceSegs(ps.trailCfg, ps.trailSegments) !== 1) {
        errors.push(`${scene.id} ${d.path}: spritetrail 实例段数不是 1`);
      }
      if (ps.pool.some((p) => p.trail)) {
        errors.push(`${scene.id} ${d.path}: spritetrail 不应分配历史轨迹数组`);
      }
      if (scene.id === "2468489223") {
        sawSharks = true;
        if (tr.length !== 0.02 || tr.maxLength !== 5) {
          errors.push(
            `2468489223 ${d.path}: spritetrail length/maxlength=${tr.length}/${tr.maxLength}（预期 0.02/5）`,
          );
        }
        if (!ps.texFrames || ps.texFrames.length !== 2) {
          errors.push(`2468489223 ${d.path}: pezanimado 应为 TEXS 两帧，实际 ${ps.texFrames?.length}`);
        }
        if (Math.abs((ps.texAspectX || 0) - 50 / 70) > 0.02) {
          errors.push(`2468489223 ${d.path}: 单帧宽高比应为 50/70，实际 ${ps.texAspectX}/${ps.texAspectY}`);
        }
        if (Math.abs(ps.ops.alphaFade?.fadeIn - 0.1) > 1e-9 || Math.abs(ps.ops.alphaFade?.fadeOut - 0.9) > 1e-9) {
          errors.push(
            `2468489223 alphafade 省略字段应得 0.1/0.9，实际 ${ps.ops.alphaFade?.fadeIn}/${ps.ops.alphaFade?.fadeOut}`,
          );
        }
        for (let i = 0; i < 180; i++) ps.advance(1 / 60);
        if (ps.liveCount() > ps.maxCount) {
          errors.push(`2468489223 存活 ${ps.liveCount()} > maxcount ${ps.maxCount}`);
        }
        const alphas = ps.pool.filter((p) => p.alive).map((p) => p.alpha);
        const faded = alphas.filter((a) => a < 0.99).length;
        if (alphas.length && faded < alphas.length * 0.05) {
          errors.push(`2468489223 小鱼几乎全程不透明（${faded}/${alphas.length} 条 alpha<0.99，alphafade 没生效）`);
        }
      }
      if (tr.length === 0.005 && tr.maxLength === 100) sawRain++;
    }
  }
  if (fs.existsSync(join(LIB, "2468489223", "scene.pkg")) && !sawSharks) {
    errors.push("2468489223 在库里但没找到 spritetrail 小鱼系统");
  }
  if (sawSpriteTrail && !sawRain) {
    // rainperspective 是全库同类：length=0.005 maxlength=100，同样必须 1 quad
  }

  return { errors, sawSpriteTrail };
}

// ---------- 入口 ----------

const action = process.argv[2] ?? "all";
let failed = 0;

if (action === "all" || action === "tex") {
  const r = runTextures();
  console.log(`\n【贴图】检查 ${r.checked} 个名字 → 问题 ${r.errors.length}`);
  r.errors.forEach((e) => console.log("  ! " + e));
  failed += r.errors.length;
  const rb = runRefractBlank();
  console.log(`\n【REFRACT 空白白图】问题 ${rb.errors.length}`);
  rb.errors.forEach((e) => console.log("  ! " + e));
  failed += rb.errors.length;
}
if (action === "all" || action === "sim") {
  const r = runSim();
  console.log(`\n【模拟】跑完 ${r.checked} 个粒子系统 → 问题 ${r.errors.length}`);
  r.errors.forEach((e) => console.log("  ! " + e));
  failed += r.errors.length;
}
if (action === "all" || action === "raster") {
  const r = runRaster(action === "raster");
  console.log(`\n【光栅】合成 ${r.scenes} 个场景 → 问题 ${r.errors.length}`);
  r.errors.forEach((e) => console.log("  ! " + e));
  failed += r.errors.length;
}
if (action === "all" || action === "nested" || action === "sim") {
  const r = runNestedOrigins();
  console.log(`\n【嵌套 origin】Matrix 列距 ${r.checked} 列 → 问题 ${r.errors.length}`);
  r.errors.forEach((e) => console.log("  ! " + e));
  failed += r.errors.length;
  const uv = runMatrixSheetUv();
  console.log(`\n【图集 UV】TEXS ${uv.checked} 张 → 问题 ${uv.errors.length}`);
  uv.errors.forEach((e) => console.log("  ! " + e));
  failed += uv.errors.length;
}
if (action === "all" || action === "sim" || action === "trail") {
  const r = runSpriteTrail();
  console.log(`\n【Sprite Trail】系统 ${r.sawSpriteTrail} → 问题 ${r.errors.length}`);
  r.errors.forEach((e) => console.log("  ! " + e));
  failed += r.errors.length;
}

console.log(failed === 0 ? "\n✓ 全部通过" : `\n✗ 共 ${failed} 处问题`);
process.exit(failed === 0 ? 0 : 1);
